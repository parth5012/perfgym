import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import type { CommandCapabilities, CommandExecutor, ExecResult } from "../executor/index.js";
import { resolveCommandExecutor } from "../executor/resolve.js";
import { stripAnsi } from "../formatter/shared.js";

/**
 * ============================================================================
 * E2E Certification Pre-Flight Pass (ADR-020, map #74)
 * ============================================================================
 *
 * Runs the repository's E2E suite (e.g. Playwright) ONCE before the
 * optimization loop and — optionally — once more before the winning mutation
 * is promoted. Never per-step: ADR-020 keeps network/browser noise out of the
 * deterministic per-step signal, so this gate is a separate, run-level check.
 *
 * Protocol: the same plain command + exit-code contract the invariant gate
 * uses — exit 0 = pass, nonzero = fail, timeout-kill = fail. No new seam is
 * required, which is what lets the Android/Desktop adapters supply their own
 * certification command later without touching the core.
 *
 * Execution: through the CommandExecutor, so the pass inherits the sandbox
 * policy and its `blocked` semantics. A policy-denied certification is
 * reported as `blocked` — NOT as a test failure.
 *
 * Never a fitness term: the result is recorded separately and can only BLOCK.
 * It must not enter `Score` (which stays Δ% − Σpenalties per ADR-010).
 */

/** Default per-pass timeout. A certification runs once per run, so unlike the
 * per-step invariant gate (10s/30s cap, ADR-020) it may take longer. */
export const DEFAULT_CERTIFICATION_TIMEOUT_MS = 120_000;

/**
 * Resolve the effective timeout for one certification pass. Unconfigured,
 * non-positive, NaN or non-finite (including Infinity — an unbounded E2E run
 * would hang the whole optimization run) values fall back to the default;
 * configured finite values pass through unchanged. There is no hard cap: the
 * pass runs once per run, not per step.
 */
export function resolveCertificationTimeoutMs(configured: number | undefined): number {
  if (configured === undefined || !Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_CERTIFICATION_TIMEOUT_MS;
  }
  return configured;
}

/**
 * The outcome of one certification pass. `passed` is the gate verdict; the
 * `blocked` flag distinguishes a sandbox policy denial (an infrastructure
 * condition, map #74) from a genuine test failure, and `timedOut` a kill on
 * the deadline. Every field is plain data so reports can render the pass
 * without re-running anything.
 */
export interface CertificationResult {
  readonly command: string;
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly output: string;
  readonly timedOut: boolean;
  /** Policy-denied by the sandbox backend (map #74) — NOT a test failure. */
  readonly blocked: boolean;
}

export interface CertificationOptions {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly executor?: CommandExecutor;
  readonly capabilities?: CommandCapabilities;
}

/**
 * An E2E suite legitimately spawns browsers/workers and talks to servers
 * (that noise is exactly why ADR-020 keeps it out of the per-step path), so
 * unlike the invariant gate this pass declares network access. The sandbox
 * backend's policy still decides — a denial surfaces as `blocked`, never as a
 * fabricated test failure.
 */
const DEFAULT_CAPABILITIES = (cwd: string): CommandCapabilities => ({
  readPaths: [cwd, tmpdir()],
  writePaths: [cwd, tmpdir()],
  needsNetwork: true,
  needsChildProcess: true,
});

const blockedResult = (command: string, result: ExecResult): CertificationResult => ({
  command,
  passed: false,
  exitCode: null,
  durationMs: result.durationMs,
  // E2E runners colourise by default — escapes must never reach the durable
  // state file (learnings #11/#34).
  output: stripAnsi((result.stdout + result.stderr).trim()),
  timedOut: false,
  blocked: true,
});

const failedResult = (
  command: string,
  exitCode: number | null,
  durationMs: number,
  output: string,
  timedOut: boolean,
): CertificationResult => ({
  command,
  passed: false,
  exitCode,
  durationMs,
  output,
  timedOut,
  blocked: false,
});

/**
 * The run-level E2E certification gate. Never fails its Effect channel:
 * every outcome — pass, exit-code failure, timeout, sandbox block, spawn
 * error, invalid cwd — resolves to a `CertificationResult`, so the caller
 * owns the abort/block policy (required / before_promotion) and the result
 * can always be recorded and reported.
 */
export const runCertification = (
  options: CertificationOptions
): Effect.Effect<CertificationResult, never> => {
  const timeoutMs = resolveCertificationTimeoutMs(options.timeoutMs);

  let resolvedCwd: string | undefined;
  if (options.cwd !== undefined) {
    resolvedCwd = resolve(options.cwd);
    let isDir = false;
    try {
      isDir = statSync(resolvedCwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return Effect.succeed(
        failedResult(
          options.command,
          null,
          0,
          `Invalid working directory: ${options.cwd} — the certification command was not run.`,
          false
        )
      );
    }
  }

  const executor = options.executor ?? resolveCommandExecutor();
  const cwd = resolvedCwd ?? process.cwd();
  const capabilities: CommandCapabilities = {
    ...DEFAULT_CAPABILITIES(cwd),
    ...options.capabilities,
  };

  // The async body never rejects (spawn failures are folded in-band), so
  // Effect.promise is exact: Effect<CertificationResult, never>.
  return Effect.promise(async (): Promise<CertificationResult> => {
    let result: ExecResult;
    try {
      result = await executor.exec(options.command, {
        cwd: resolvedCwd,
        timeoutMs,
        env: options.env,
        capabilities,
      });
    } catch (cause: unknown) {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      return failedResult(
        options.command,
        null,
        0,
        `Certification command could not be spawned: ${err.message}`,
        false
      );
    }

    if (result.blocked) {
      return blockedResult(options.command, result);
    }

    const output = stripAnsi((result.stdout + result.stderr).trim());

    if (result.timedOut) {
      return failedResult(
        options.command,
        result.code ?? null,
        result.durationMs,
        output,
        true
      );
    }

    if (result.code === 0) {
      return {
        command: options.command,
        passed: true,
        exitCode: 0,
        durationMs: result.durationMs,
        output,
        timedOut: false,
        blocked: false,
      };
    }

    return failedResult(options.command, result.code ?? null, result.durationMs, output, false);
  });
};
