import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Effect } from "effect";
import { InvariantFailureError } from "../errors.js";
import type { InvariantResult } from "../index.js";
import type { CommandCapabilities, CommandExecutor } from "../executor/index.js";
import { resolveCommandExecutor } from "../executor/resolve.js";

/**
 * ============================================================================
 * Invariant Gate (pipeline stage 1)
 * ============================================================================
 *
 * Executes the repository's unit-test suite before any performance metrics
 * are collected. Correctness precedes speed: every step must pass the gate
 * or it is instantly rejected.
 *
 * Policy (ADR-020, grilling #25):
 * - Zero tolerance. No retries. Any failure, fault, or timeout fails on the
 *   first occurrence (fitness score semantics: -inf). `InvariantFailureError`
 *   keeps its `retriesUsed` field, but it is always 0 here.
 * - Timeout failure is a correctness failure: an infinite loop or a hung
 *   worker is a bug, and is rejected exactly like a failing test.
 * - The command runs in a dedicated, detached process group; on timeout the
 *   entire group receives SIGKILL so no orphaned workers linger.
 * - Scope: fast unit suites only. Full E2E certification passes are
 *   explicitly out of scope for this module.
 */

export const DEFAULT_INVARIANT_TIMEOUT_MS = 10_000;
export const MAX_INVARIANT_TIMEOUT_MS = 30_000;
export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * Resolve the effective timeout: `.perfgym.yaml` `invariants.timeout_ms` may
 * lower the 10s default and may raise it, but never above the 30s hard cap —
 * anything above is clamped down to the cap.
 * Non-positive or NaN values default to DEFAULT_INVARIANT_TIMEOUT_MS (10s).
 * Infinity or values > 30,000 are clamped to MAX_INVARIANT_TIMEOUT_MS (30s).
 */
export function resolveInvariantTimeoutMs(configured: number | undefined): number {
  if (configured === undefined || Number.isNaN(configured) || configured <= 0) {
    return DEFAULT_INVARIANT_TIMEOUT_MS;
  }
  if (!Number.isFinite(configured) || configured > MAX_INVARIANT_TIMEOUT_MS) {
    return MAX_INVARIANT_TIMEOUT_MS;
  }
  return configured;
}

export interface InvariantGateOptions {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly executor?: CommandExecutor;
  readonly capabilities?: CommandCapabilities;
}

const TIMEOUT_EXIT_CODE = 124; // GNU timeout convention: killed after the deadline.
const FORCE_SETTLE_TIMEOUT_MS = 500;
const TRUNCATION_MARKER = "\n[truncated]";

/**
 * The non-negotiable correctness barrier of the evaluation pipeline.
 *
 * Exit-code protocol: 0 = pass, nonzero = fail, timeout kill = fail, sandbox blocked = fail.
 * Raw stdout/stderr are captured verbatim and surfaced on failure.
 */
export const runInvariantGate = (
  options: InvariantGateOptions
): Effect.Effect<InvariantResult, InvariantFailureError> => {
  const timeoutMs = resolveInvariantTimeoutMs(options.timeoutMs);

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
      return Effect.fail(
        new InvariantFailureError({
          command: options.command,
          exitCode: -1,
          stdout: "",
          stderr: `Invalid working directory: ${options.cwd}`,
          retriesUsed: 0,
          message: `Invariant gate failed: working directory "${options.cwd}" does not exist or is not a directory`,
        })
      );
    }
  }

  const executor = options.executor ?? resolveCommandExecutor();
  const cwd = resolvedCwd ?? process.cwd();
  const capabilities: CommandCapabilities = {
    readPaths: [cwd, tmpdir()],
    writePaths: [cwd, tmpdir()],
    needsNetwork: false,
    needsChildProcess: true,
    ...options.capabilities,
  };

  return Effect.tryPromise({
    try: () =>
      executor.exec(options.command, {
        cwd: resolvedCwd,
        timeoutMs,
        env: options.env,
        capabilities,
      }),
    catch: (cause: unknown) => {
      const err = cause instanceof Error ? cause : new Error(String(cause));
      return new InvariantFailureError({
        command: options.command,
        exitCode: -1,
        stdout: "",
        stderr: err.message,
        retriesUsed: 0,
        message: `Invariant gate could not spawn the command "${options.command}": ${err.message}`,
      });
    },
  }).pipe(
    Effect.flatMap((result) => {
      if (result.blocked) {
        return Effect.fail(
          new InvariantFailureError({
            command: options.command,
            exitCode: result.code ?? -1,
            stdout: result.stdout,
            stderr: result.stderr,
            retriesUsed: 0,
            blocked: true,
            backend: result.backend,
            deniedCapability: result.stderr,
            message: `Invariant gate blocked by sandbox backend '${result.backend}': ${result.stderr}`,
          })
        );
      }

      if (result.timedOut) {
        return Effect.fail(
          new InvariantFailureError({
            command: options.command,
            exitCode: TIMEOUT_EXIT_CODE,
            stdout: result.stdout,
            stderr: result.stderr,
            retriesUsed: 0,
            backend: result.backend,
            message:
              `Invariant gate timed out after ${timeoutMs}ms (exit ${TIMEOUT_EXIT_CODE}). ` +
              `The command "${options.command}" was killed with SIGKILL along with its whole process group. ` +
              "A hung test suite is a correctness bug — fix the hang, or raise `" +
              "invariants.timeout_ms` in .perfgym.yaml (hard cap: 30000ms).",
          })
        );
      }

      const rawOutput = (result.stdout + result.stderr).trim();
      if (result.code === 0) {
        return Effect.succeed({
          passed: true,
          output: rawOutput,
          durationMs: result.durationMs,
          retriesUsed: 0,
          blocked: false,
          backend: result.backend,
        });
      }

      const reason = `exit ${result.code ?? -1}`;
      return Effect.fail(
        new InvariantFailureError({
          command: options.command,
          exitCode: result.code ?? -1,
          stdout: result.stdout,
          stderr: result.stderr,
          retriesUsed: 0,
          backend: result.backend,
          message: `Invariant gate failed (${reason}): ${rawOutput.slice(0, 2000)}`,
        })
      );
    })
  );
};
