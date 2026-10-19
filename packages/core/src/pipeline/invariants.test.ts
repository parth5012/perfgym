import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_INVARIANT_TIMEOUT_MS,
  MAX_CAPTURE_BYTES,
  MAX_INVARIANT_TIMEOUT_MS,
  resolveInvariantTimeoutMs,
  runInvariantGate,
} from "./invariants.js";
import { InvariantFailureError } from "../errors.js";

/**
 * Run the invariant gate and unwrap either the success result or the
 * typed InvariantFailureError, mirroring the Effect.catchTag style used
 * in tests/core-effect.test.ts.
 */
async function runGate(
  options: Parameters<typeof runInvariantGate>[0]
): Promise<
  | { ok: true; passed: boolean; output: string; durationMs: number; retriesUsed?: number }
  | { ok: false; error: InvariantFailureError }
> {
  const result = await Effect.runPromise(
    runInvariantGate(options).pipe(
      Effect.map((value) => ({ ok: true as const, ...value })),
      Effect.catchTag("InvariantFailureError", (err) =>
        Effect.succeed({ ok: false as const, error: err })
      )
    )
  );
  return result;
}

describe("resolveInvariantTimeoutMs (ADR-020 timeout policy)", () => {
  it("defaults to 10,000ms when unconfigured", () => {
    expect(resolveInvariantTimeoutMs(undefined)).toBe(DEFAULT_INVARIANT_TIMEOUT_MS);
  });

  it("defaults to 10,000ms for non-positive or NaN values", () => {
    expect(resolveInvariantTimeoutMs(-1)).toBe(DEFAULT_INVARIANT_TIMEOUT_MS);
    expect(resolveInvariantTimeoutMs(-100)).toBe(DEFAULT_INVARIANT_TIMEOUT_MS);
    expect(resolveInvariantTimeoutMs(0)).toBe(DEFAULT_INVARIANT_TIMEOUT_MS);
    expect(resolveInvariantTimeoutMs(NaN)).toBe(DEFAULT_INVARIANT_TIMEOUT_MS);
  });

  it("passes through values below the hard cap unchanged", () => {
    expect(resolveInvariantTimeoutMs(500)).toBe(500);
    expect(resolveInvariantTimeoutMs(MAX_INVARIANT_TIMEOUT_MS)).toBe(MAX_INVARIANT_TIMEOUT_MS);
  });

  it("clamps values above the 30,000ms hard cap and Infinity", () => {
    expect(resolveInvariantTimeoutMs(60_000)).toBe(MAX_INVARIANT_TIMEOUT_MS);
    expect(resolveInvariantTimeoutMs(999_999)).toBe(MAX_INVARIANT_TIMEOUT_MS);
    expect(resolveInvariantTimeoutMs(Infinity)).toBe(MAX_INVARIANT_TIMEOUT_MS);
  });
});

describe("runInvariantGate", () => {
  it("succeeds with passed=true, captured output and duration for a passing command", async () => {
    const result = await runGate({
      command: "echo invariant-ok",
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.passed).toBe(true);
    expect(result.output).toContain("invariant-ok");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.retriesUsed).toBe(0);
  });

  it("fails with InvariantFailureError when cwd does not exist or is not a directory", async () => {
    const nonExistentPath = join(tmpdir(), `perfgym-nonexistent-${Date.now()}`);
    const result = await runGate({
      command: "echo test",
      cwd: nonExistentPath,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("InvariantFailureError");
    expect(result.error.exitCode).toBe(-1);
    expect(result.error.stderr).toBe(`Invalid working directory: ${nonExistentPath}`);
    expect(result.error.retriesUsed).toBe(0);
    expect(result.error.message).toContain("does not exist or is not a directory");
  });

  it("fails with InvariantFailureError and captured stdout on nonzero exit", async () => {
    const result = await runGate({
      command: 'echo "AssertionError: expected 4 to equal 5" && exit 1',
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("InvariantFailureError");
    expect(result.error.exitCode).toBe(1);
    expect(result.error.stdout).toContain("AssertionError: expected 4 to equal 5");
    expect(result.error.message).toContain("AssertionError");
    // ADR-020: zero tolerance — no retries ever, retriesUsed stays 0.
    expect(result.error.retriesUsed).toBe(0);
  });

  it("fails with InvariantFailureError and captured stderr on nonzero exit", async () => {
    const result = await runGate({
      command: 'echo "boom: invariant crashed" >&2 && exit 2',
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.exitCode).toBe(2);
    expect(result.error.stderr).toContain("boom: invariant crashed");
  });

  it("fails fast on timeout with an actionable error (no waiting near the cap)", async () => {
    const startedAt = Date.now();
    const result = await runGate({
      command: "node -e \"setInterval(() => {}, 1000)\"", // spins forever
      timeoutMs: 300,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("InvariantFailureError");
    expect(result.error.exitCode).toBe(124); // GNU timeout convention for kill-on-timeout
    expect(result.error.message).toContain("timed out");
    expect(result.error.message).toContain("300");
    expect(result.error.retriesUsed).toBe(0);
    // Must terminate close to the 300ms deadline, not the default/hard cap.
    expect(elapsed).toBeLessThan(3_000);
  });

  it("kills the whole detached process group on timeout (no orphaned children)", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "perfgym-groupkill-"));
    const pidFile = join(tempDir, "child.pid");

    try {
      const result = await runGate({
        command: `sh -c '(sleep 25 & echo $! > "${pidFile}"; wait)'`,
        timeoutMs: 300,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.exitCode).toBe(124);

      // Verify the pidFile was written
      expect(existsSync(pidFile)).toBe(true);
      const rawPid = readFileSync(pidFile, "utf8").trim();
      const pid = Number.parseInt(rawPid, 10);
      expect(Number.isFinite(pid) && pid > 0).toBe(true);

      // Poll process.kill(pid, 0) up to ~1s asserting the background child is NOT alive.
      let stillAlive = true;
      for (let i = 0; i < 20; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch {
          stillAlive = false;
          break;
        }
      }
      expect(stillAlive).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("never retries a failing command (ADR-020 zero tolerance)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perfgym-invariants-"));
    try {
      const counter = join(dir, "counter");
      const result = await runGate({
        command: `node -e "require('node:fs').appendFileSync('${counter}', 'x')" && exit 1`,
        timeoutMs: 5_000,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.retriesUsed).toBe(0);
      // Exactly one execution attempt happened.
      expect(readFileSync(counter, "utf8")).toBe("x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("caps captured stdout at MAX_CAPTURE_BYTES and marks truncation", async () => {
    const result = await runGate({
      command: `node -e "process.stdout.write('A'.repeat(${MAX_CAPTURE_BYTES + 1024}))" && exit 1`,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.stdout.endsWith("\n[truncated]")).toBe(true);
    // Captured stdout without the marker string must not exceed MAX_CAPTURE_BYTES
    const content = result.error.stdout.slice(0, -"\n[truncated]".length);
    expect(Buffer.byteLength(content, "utf8")).toBe(MAX_CAPTURE_BYTES);
  });
});
