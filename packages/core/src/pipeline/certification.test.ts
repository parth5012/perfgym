import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_CERTIFICATION_TIMEOUT_MS,
  resolveCertificationTimeoutMs,
  runCertification,
  type CertificationResult,
} from "./certification.js";
import type { CommandExecutor, ExecResult } from "../executor/index.js";
import { computeFitnessVerdict, type FitnessParams } from "./fitness.js";
import type { InvariantResult, MetricResult } from "../index.js";

/**
 * Run the certification pass and unwrap the always-in-band result. The gate
 * never fails its Effect channel: every outcome (pass, exit-code failure,
 * timeout, sandbox block, spawn error) IS a CertificationResult.
 */
async function runPass(
  options: Parameters<typeof runCertification>[0]
): Promise<CertificationResult> {
  return Effect.runPromise(runCertification(options));
}

/** Recording stub executor returning a canned ExecResult for every call. */
const stubExecutor = (
  backend: string,
  exec: (command: string) => ExecResult | Promise<ExecResult>,
): CommandExecutor & { calls: Array<{ command: string; options: unknown }> } => {
  const calls: Array<{ command: string; options: unknown }> = [];
  return {
    backend,
    calls,
    async exec(command: string, options?: Parameters<CommandExecutor["exec"]>[1]) {
      calls.push({ command, options });
      return exec(command);
    },
  } as CommandExecutor & { calls: Array<{ command: string; options: unknown }> };
};

describe("resolveCertificationTimeoutMs (ADR-020 pre-flight pass)", () => {
  it("defaults when unconfigured", () => {
    expect(resolveCertificationTimeoutMs(undefined)).toBe(DEFAULT_CERTIFICATION_TIMEOUT_MS);
  });

  it("defaults for non-positive, NaN and non-finite values (no infinite hang)", () => {
    expect(resolveCertificationTimeoutMs(0)).toBe(DEFAULT_CERTIFICATION_TIMEOUT_MS);
    expect(resolveCertificationTimeoutMs(-1)).toBe(DEFAULT_CERTIFICATION_TIMEOUT_MS);
    expect(resolveCertificationTimeoutMs(NaN)).toBe(DEFAULT_CERTIFICATION_TIMEOUT_MS);
    expect(resolveCertificationTimeoutMs(Infinity)).toBe(DEFAULT_CERTIFICATION_TIMEOUT_MS);
  });

  it("passes configured finite values through unchanged", () => {
    expect(resolveCertificationTimeoutMs(500)).toBe(500);
    expect(resolveCertificationTimeoutMs(300_000)).toBe(300_000);
  });
});

describe("runCertification", () => {
  it("reports passed=true with captured output, exit code 0 and duration for a passing suite", async () => {
    const result = await runPass({
      command: "echo certification-ok",
      timeoutMs: 5_000,
    });

    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("certification-ok");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.timedOut).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it("reports a non-zero exit as failed with the captured output", async () => {
    const result = await runPass({
      command: 'echo "E2E: checkout flow broken" && exit 1',
      timeoutMs: 5_000,
    });

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("E2E: checkout flow broken");
    expect(result.timedOut).toBe(false);
    expect(result.blocked).toBe(false);
  });

  it("reports a timeout as failed with timedOut=true and no exit code", async () => {
    const startedAt = Date.now();
    const result = await runPass({
      command: "node -e \"setInterval(() => {}, 1000)\"",
      timeoutMs: 300,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.passed).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(null);
    expect(result.blocked).toBe(false);
    // Terminates near the deadline — once per run, but never an unbounded hang.
    expect(elapsed).toBeLessThan(3_000);
  });

  it("reports a sandbox policy denial as blocked — NOT as a test failure", async () => {
    const executor = stubExecutor("strict-sandbox", () => ({
      code: null,
      stdout: "",
      stderr: "Backend 'strict-sandbox' policy denies network access (needsNetwork not granted)",
      durationMs: 0,
      timedOut: false,
      blocked: true,
      backend: "strict-sandbox",
    }));

    const result = await runPass({
      command: "npx playwright test",
      executor,
    });

    expect(result.blocked).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("denies network access");
    // The distinguishing contract: a blocked run is not an exit-code failure.
    expect(result.exitCode).toBe(null);
    expect(result.timedOut).toBe(false);
  });

  it("reports an executor-level spawn failure as failed with a null exit code", async () => {
    const executor = stubExecutor("stub-broken", () => {
      throw new Error("spawn ENOENT");
    });

    const result = await runPass({
      command: "npx playwright test",
      executor,
    });

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(null);
    expect(result.timedOut).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.output).toContain("spawn ENOENT");
  });

  it("reports a result when the working directory is invalid instead of throwing", async () => {
    const nonExistentPath = join(tmpdir(), `perfgym-cert-nonexistent-${Date.now()}`);
    const result = await runPass({
      command: "echo hello",
      cwd: nonExistentPath,
      timeoutMs: 5_000,
    });

    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(null);
    expect(result.output).toContain("Invalid working directory");
  });

  it("runs through the CommandExecutor declaring E2E capabilities (network + child processes)", async () => {
    const executor = stubExecutor("stub-cert", () => ({
      code: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
      timedOut: false,
      blocked: false,
      backend: "stub-cert",
    }));

    await runPass({ command: "npx playwright test", executor });

    expect(executor.calls).toHaveLength(1);
    const options = executor.calls[0].options as {
      capabilities?: { needsNetwork?: boolean; needsChildProcess?: boolean };
    };
    expect(options.capabilities?.needsNetwork).toBe(true);
    expect(options.capabilities?.needsChildProcess).toBe(true);
  });

  it("echoes the configured command on every result", async () => {
    const passing = await runPass({ command: "echo ok", timeoutMs: 5_000 });
    expect(passing.command).toBe("echo ok");

    const failing = await runPass({
      command: "exit 3",
      timeoutMs: 5_000,
    });
    expect(failing.command).toBe("exit 3");
  });
});

describe("certification is never a fitness term (ADR-020 / map #74)", () => {
  it("the fitness verdict is identical with a failing certification recorded beside it", () => {
    const greenInvariants: InvariantResult = {
      passed: true,
      output: "",
      durationMs: 5,
      retriesUsed: 0,
    };
    const improved: MetricResult = {
      name: "latency",
      value: 90,
      unit: "ms",
      improved: true,
      deltaPercent: 10,
    };
    const brokenCertification: CertificationResult = {
      command: "npx playwright test",
      passed: false,
      exitCode: 1,
      durationMs: 4_000,
      output: "E2E suite failed",
      timedOut: false,
      blocked: false,
    };

    const without = computeFitnessVerdict({
      invariants: greenInvariants,
      violations: [],
      metrics: [improved],
    });
    // The verdict input carries no certification field: injecting one (as an
    // unknown key) must change nothing. Score stays Δ% − Σpenalties — the
    // certification gate can only BLOCK (map #74, ADR-020), so if a future
    // change turns a failing certification into a fitness penalty this
    // assertion goes red.
    const injected = computeFitnessVerdict({
      invariants: greenInvariants,
      violations: [],
      metrics: [improved],
      certification: brokenCertification,
    } as unknown as FitnessParams);

    expect(injected.score).toBe(without.score);
    expect(injected.accepted).toBe(without.accepted);
    expect(injected.accepted).toBe(true);
  });
});
