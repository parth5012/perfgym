import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { InvariantFailureError } from "../errors.js";
import type { InvariantResult } from "../index.js";

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
}

const TIMEOUT_EXIT_CODE = 124; // GNU timeout convention: killed after the deadline.
const FORCE_SETTLE_TIMEOUT_MS = 500;
const TRUNCATION_MARKER = "\n[truncated]";

/**
 * SIGKILL the entire process group the child was spawned into so that
 * worker-pool children (e.g. vitest forks) cannot survive their parent.
 */
function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  if (process.platform === "win32") {
    // taskkill /T /F reliably kills Windows trees (process-group negative pid is unsupported there).
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Group kill failed (e.g. Windows without negative pid support, or ESRCH).
    // Attempt single-pid kill fallback.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already gone (ESRCH) or unsupported — swallow error.
    }
  }
}

/**
 * The non-negotiable correctness barrier of the evaluation pipeline.
 *
 * Exit-code protocol: 0 = pass, nonzero = fail, timeout kill = fail.
 * Raw stdout/stderr are captured verbatim and surfaced on failure.
 *
 * The process spawn, capture, timeout and process-group kill are all hidden
 * behind this single small surface.
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

  return Effect.callback<InvariantResult, InvariantFailureError>((resume) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let forceSettleTimer: NodeJS.Timeout | undefined;

    const child = spawn(options.command, {
      shell: true,
      detached: true, // /bin/sh -c becomes its own process-group leader.
      cwd: resolvedCwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      const remaining = MAX_CAPTURE_BYTES - stdoutBytes;
      if (chunk.length <= remaining) {
        stdout += chunk.toString();
        stdoutBytes += chunk.length;
      } else {
        stdout += chunk.subarray(0, remaining).toString() + TRUNCATION_MARKER;
        stdoutBytes = MAX_CAPTURE_BYTES;
        stdoutTruncated = true;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrTruncated) return;
      const remaining = MAX_CAPTURE_BYTES - stderrBytes;
      if (chunk.length <= remaining) {
        stderr += chunk.toString();
        stderrBytes += chunk.length;
      } else {
        stderr += chunk.subarray(0, remaining).toString() + TRUNCATION_MARKER;
        stderrBytes = MAX_CAPTURE_BYTES;
        stderrTruncated = true;
      }
    });

    const settle = (result: Effect.Effect<InvariantResult, InvariantFailureError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forceSettleTimer !== undefined) {
        clearTimeout(forceSettleTimer);
      }
      resume(result);
    };

    const deadline = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid);

      child.stdout?.destroy();
      child.stderr?.destroy();

      forceSettleTimer = setTimeout(() => {
        settle(
          Effect.fail(
            new InvariantFailureError({
              command: options.command,
              exitCode: TIMEOUT_EXIT_CODE,
              stdout,
              stderr,
              retriesUsed: 0,
              message:
                `Invariant gate timed out after ${timeoutMs}ms (exit ${TIMEOUT_EXIT_CODE}). ` +
                `Process did not exit after SIGKILL; force-settled after ${FORCE_SETTLE_TIMEOUT_MS}ms fallback. ` +
                `The command "${options.command}" was killed with SIGKILL along with its whole process group. ` +
                "A hung test suite is a correctness bug — fix the hang, or raise `" +
                "invariants.timeout_ms` in .perfgym.yaml (hard cap: 30000ms).",
            })
          )
        );
      }, FORCE_SETTLE_TIMEOUT_MS);
      forceSettleTimer.unref();
    }, timeoutMs);

    child.on("error", (cause: Error) => {
      if (timedOut) return;
      settle(
        Effect.fail(
          new InvariantFailureError({
            command: options.command,
            exitCode: -1,
            stdout,
            stderr,
            retriesUsed: 0,
            message: `Invariant gate could not spawn the command "${options.command}": ${cause.message}`,
          })
        )
      );
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const rawOutput = (stdout + stderr).trim();
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        settle(
          Effect.fail(
            new InvariantFailureError({
              command: options.command,
              exitCode: TIMEOUT_EXIT_CODE,
              stdout,
              stderr,
              retriesUsed: 0,
              message:
                `Invariant gate timed out after ${timeoutMs}ms (exit ${TIMEOUT_EXIT_CODE}). ` +
                `The command "${options.command}" was killed with SIGKILL along with its whole process group. ` +
                "A hung test suite is a correctness bug — fix the hang, or raise `" +
                "invariants.timeout_ms` in .perfgym.yaml (hard cap: 30000ms).",
            })
          )
        );
        return;
      }

      if (code === 0) {
        settle(
          Effect.succeed({
            passed: true,
            output: rawOutput,
            durationMs,
            retriesUsed: 0,
          })
        );
        return;
      }

      const reason = signal !== null && code === null ? `killed by ${signal}` : `exit ${code ?? -1}`;
      settle(
        Effect.fail(
          new InvariantFailureError({
            command: options.command,
            exitCode: code ?? -1,
            stdout,
            stderr,
            retriesUsed: 0,
            message: `Invariant gate failed (${reason}): ${rawOutput.slice(0, 2000)}`,
          })
        )
      );
    });

    // If the fiber is interrupted (test harness, pipeline shutdown, ...),
    // make sure no process group is left behind either.
    return Effect.sync(() => {
      clearTimeout(deadline);
      if (forceSettleTimer !== undefined) {
        clearTimeout(forceSettleTimer);
      }
      killProcessGroup(child.pid);
    });
  });
};
