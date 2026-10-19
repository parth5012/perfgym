import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BENCHMARK_SAMPLES,
  DEFAULT_HARNESS_DIR,
  MAX_BENCHMARK_SAMPLES,
  MAX_BENCHMARK_TIMEOUT_MS,
  computeBenchmarkDistribution,
  computeIqr,
  computeMad,
  computeMetricResult,
  computeStddev,
  parseBenchmarkValue,
  resolveBenchmarkTimeoutMs,
  resolveSampleCount,
  runBenchmark,
} from "./benchmark.js";
import { BenchmarkExecutionError } from "../errors.js";
import type { BenchmarkDistribution } from "../index.js";

/**
 * Unwrap either the distribution or the typed BenchmarkExecutionError,
 * mirroring the catchTag style used in invariants.test.ts.
 */
async function runBenchmarkSafe(
  options: Parameters<typeof runBenchmark>[0]
): Promise<
  | { ok: true; distribution: BenchmarkDistribution }
  | { ok: false; error: BenchmarkExecutionError }
> {
  const result = await Effect.runPromise(
    runBenchmark(options).pipe(
      Effect.map((distribution) => ({ ok: true as const, distribution })),
      Effect.catchTag("BenchmarkExecutionError", (error) =>
        Effect.succeed({ ok: false as const, error })
      )
    )
  );
  return result;
}

describe("computeBenchmarkDistribution (hand-computed fixtures)", () => {
  // Even-sized, unsorted input: sorted is [10, 20, 30, 40].
  // Linear-interpolation percentiles: p50=25, p90=37, p95=38.5, p99=39.7.
  // MAD = median(|x-25| over [15,5,5,15]) = median([5,5,15,15]) = 10.
  // IQR = p75-p25 = 32.5 - 17.5 = 15. Population stddev = sqrt(500/4) = sqrt(125).
  it("computes robust metrics for an even-sized unsorted sample", () => {
    const dist = computeBenchmarkDistribution([20, 10, 40, 30], "ms");

    expect(dist.samples).toEqual([20, 10, 40, 30]); // original capture order preserved
    expect(dist.sampleCount).toBe(4);
    expect(dist.unit).toBe("ms");
    expect(dist.min).toBe(10);
    expect(dist.max).toBe(40);
    expect(dist.p50).toBeCloseTo(25, 12);
    expect(dist.p90).toBeCloseTo(37, 12);
    expect(dist.p95).toBeCloseTo(38.5, 12);
    expect(dist.p99).toBeCloseTo(39.7, 12);
    expect(dist.mad).toBeCloseTo(10, 12);
    expect(dist.iqr).toBeCloseTo(15, 12);
    expect(dist.stddev).toBeCloseTo(Math.sqrt(125), 12);
  });

  // Odd-sized input: sorted is [1,2,3,4,5]. p50=3, p90=4.6, p95=4.8, p99=4.96.
  // MAD = median([2,1,0,1,2] sorted [0,1,1,2,2]) = 1. IQR = 4-2 = 2. stddev = sqrt(10/5) = sqrt(2).
  it("computes robust metrics for an odd-sized sample", () => {
    const dist = computeBenchmarkDistribution([5, 3, 1, 4, 2]);

    expect(dist.p50).toBe(3);
    expect(dist.p90).toBeCloseTo(4.6, 12);
    expect(dist.p95).toBeCloseTo(4.8, 12);
    expect(dist.p99).toBeCloseTo(4.96, 12);
    expect(dist.mad).toBe(1);
    expect(dist.iqr).toBe(2);
    expect(dist.stddev).toBeCloseTo(Math.sqrt(2), 12);
    expect(dist.unit).toBe("count"); // default unit
  });

  it("MAD/IQR stay robust against a heavy outlier (unlike stddev)", () => {
    // Base: sorted [90,95,100,105,110], median 100, devs [10,5,0,5,10] → MAD = 5.
    const stable = computeMad([90, 95, 100, 105, 110]);
    // Same samples with one catastrophic outlier: median stays 100 → MAD unchanged.
    const withOutlier = computeMad([90, 95, 100, 105, 100000]);
    expect(stable).toBe(5);
    expect(withOutlier).toBe(stable);
    expect(computeIqr([90, 95, 100, 105, 100000])).toBe(computeIqr([90, 95, 100, 105, 110]));
    // stddev, by contrast, explodes by orders of magnitude.
    const stddevRatio = computeStddev([90, 95, 100, 105, 100000]) / computeStddev([90, 95, 100, 105, 110]);
    expect(stddevRatio).toBeGreaterThan(100);
  });

  it("throws for an empty sample array", () => {
    expect(() => computeBenchmarkDistribution([])).toThrow();
  });
});

describe("computeMad / computeIqr / computeStddev", () => {
  it("MAD = median(|x_i - median(X)|)", () => {
    expect(computeMad([7, 7, 7, 7])).toBe(0);
    expect(computeMad([1, 2, 3, 4, 100])).toBe(1);
  });

  it("IQR = p75 - p25 with interpolation", () => {
    // sorted [0,10,20,30,40,50,60,70,80,90]: p25=22.5, p75=67.5 → IQR=45
    expect(computeIqr([90, 0, 80, 10, 70, 20, 60, 30, 50, 40])).toBeCloseTo(45, 12);
  });

  it("population stddev", () => {
    expect(computeStddev([4, 4, 4, 4])).toBe(0);
    expect(computeStddev([1, 2, 3, 4, 5])).toBeCloseTo(Math.sqrt(2), 12);
  });
});

describe("resolveSampleCount / resolveBenchmarkTimeoutMs", () => {
  it("defaults to 5 samples and clamps 1..20", () => {
    expect(resolveSampleCount(undefined)).toBe(DEFAULT_BENCHMARK_SAMPLES);
    expect(resolveSampleCount(0)).toBe(1);
    expect(resolveSampleCount(-3)).toBe(1);
    expect(resolveSampleCount(25)).toBe(MAX_BENCHMARK_SAMPLES);
    expect(resolveSampleCount(Infinity)).toBe(MAX_BENCHMARK_SAMPLES);
    expect(resolveSampleCount(7)).toBe(7);
  });

  it("resolves benchmark timeout with a hard cap", () => {
    expect(resolveBenchmarkTimeoutMs(undefined)).toBeGreaterThan(0);
    expect(resolveBenchmarkTimeoutMs(300)).toBe(300);
    expect(resolveBenchmarkTimeoutMs(-1)).toBe(resolveBenchmarkTimeoutMs(undefined));
    expect(resolveBenchmarkTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_BENCHMARK_TIMEOUT_MS);
    expect(resolveBenchmarkTimeoutMs(Infinity)).toBe(MAX_BENCHMARK_TIMEOUT_MS);
  });
});

describe("parseBenchmarkValue (deterministic seam)", () => {
  it("parses whole-stdout JSON with the standard metric keys", () => {
    expect(parseBenchmarkValue('{"value":1234567}\n')).toEqual({
      value: 1234567,
      source: "json",
    });
    expect(parseBenchmarkValue('{"cycles":987654}')).toMatchObject({ value: 987654 });
    expect(parseBenchmarkValue('{"ops_per_sec":1234.5}')).toMatchObject({ value: 1234.5 });
    expect(parseBenchmarkValue('{"result":42}')).toMatchObject({ value: 42 });
    // liberal: numeric strings are accepted
    expect(parseBenchmarkValue('{"value":"42"}')).toMatchObject({ value: 42 });
  });

  it("uses key priority (value before cycles before ops_per_sec before result)", () => {
    expect(parseBenchmarkValue('{"result":1,"ops_per_sec":2,"cycles":3,"value":4}')).toMatchObject({
      value: 4,
    });
  });

  it("finds a JSON metric line embedded in noisy output", () => {
    const stdout = "warming up...\n{\"ops_per_sec\": 987.5}\ndone\n";
    expect(parseBenchmarkValue(stdout)).toEqual({ value: 987.5, source: "json" });
  });

  it("falls back to the last numeric token in stdout", () => {
    expect(parseBenchmarkValue("Benchmark took 1234567 ns\n")).toEqual({
      value: 1234567,
      source: "stdout",
    });
    expect(parseBenchmarkValue("3.14")).toEqual({ value: 3.14, source: "stdout" });
    expect(parseBenchmarkValue("iterations=100 score=555\n")).toEqual({
      value: 555,
      source: "stdout",
    });
  });

  it("returns null for non-numeric output", () => {
    expect(parseBenchmarkValue("no numbers here")).toBeNull();
    expect(parseBenchmarkValue("")).toBeNull();
  });

  it("ignores JSON without any metric keys unless a trailing number exists", () => {
    expect(parseBenchmarkValue('{"foo":"bar"} 123')).toMatchObject({ value: 123 });
    expect(parseBenchmarkValue('{"foo":"bar"}')).toBeNull();
  });

  it("handles ANSI escape sequences, thousands separators, non-finite values, and noisy multi-line JSON", () => {
    // ANSI-wrapped value Score: \x1b[32m42\x1b[0m -> 42
    expect(parseBenchmarkValue("Score: \x1b[32m42\x1b[0m")).toEqual({
      value: 42,
      source: "stdout",
    });

    // 1,000,000 ops/sec -> 1000000
    expect(parseBenchmarkValue("1,000,000 ops/sec")).toEqual({
      value: 1000000,
      source: "stdout",
    });

    // 1e999 -> null/error
    expect(parseBenchmarkValue("1e999")).toBeNull();

    // pretty-printed JSON with noise lines around it -> parsed
    const noisyJson = `
Starting benchmark run...
DEBUG: environment initialized
{
  "ops_per_sec": 4500.5,
  "status": "ok"
}
Cleaning up temp files...
Benchmark complete!
`;
    expect(parseBenchmarkValue(noisyJson)).toEqual({
      value: 4500.5,
      source: "json",
    });
  });
});

describe("computeMetricResult (minimize vs maximize semantics)", () => {
  it("minimize: lower is better, positive delta means improvement", () => {
    expect(computeMetricResult("latency", 100, 90, "ms", "minimize")).toEqual({
      name: "latency",
      value: 90,
      unit: "ms",
      improved: true,
      deltaPercent: 10,
    });
    const regression = computeMetricResult("latency", 100, 110, "ms", "minimize");
    expect(regression.improved).toBe(false);
    expect(regression.deltaPercent).toBeCloseTo(-10, 12);
    expect(computeMetricResult("latency", 100, 100, "ms", "minimize").improved).toBe(false);
  });

  it("maximize: higher is better, positive delta means improvement", () => {
    expect(computeMetricResult("throughput", 100, 120, "count", "maximize")).toEqual({
      name: "throughput",
      value: 120,
      unit: "count",
      improved: true,
      deltaPercent: 20,
    });
    const regression = computeMetricResult("throughput", 100, 80, "count", "maximize");
    expect(regression.improved).toBe(false);
    expect(regression.deltaPercent).toBeCloseTo(-20, 12);
  });

  it("baseline=0 guard: deltaPercent pinned to 0, improved by direct comparison", () => {
    const minimize = computeMetricResult("latency", 0, 5, "ms", "minimize");
    expect(minimize.deltaPercent).toBe(0);
    expect(minimize.improved).toBe(false);
    const maximize = computeMetricResult("throughput", 0, 5, "count", "maximize");
    expect(maximize.deltaPercent).toBe(0);
    expect(maximize.improved).toBe(true);
    // Equal values are never an improvement.
    expect(computeMetricResult("t", 0, 0, "count", "maximize").improved).toBe(false);
  });

  it("negative baseline delta: uses Math.abs(baselineValue) as denominator", () => {
    // maximize: baseline -50 -> current -10 -> deltaPercent +80 (improved true)
    const maxResult = computeMetricResult("profit", -50, -10, "count", "maximize");
    expect(maxResult.improved).toBe(true);
    expect(maxResult.deltaPercent).toBeCloseTo(80, 12);

    // minimize: baseline -50 -> current -60 -> deltaPercent +20 (improved true)
    const minResult = computeMetricResult("debt", -50, -60, "count", "minimize");
    expect(minResult.improved).toBe(true);
    expect(minResult.deltaPercent).toBeCloseTo(20, 12);
  });
});

describe("runBenchmark", () => {
  it("runs 1 discarded warmup plus N samples recording captured values in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "perfgym-benchmark-"));
    try {
      const counter = join(dir, "counter");
      const result = await runBenchmarkSafe({
        command: `node -e "require('node:fs').appendFileSync('${counter}', 'x\\n'); console.log('42')"`,
        cwd: dir,
        samples: 2,
        timeoutMs: 5_000,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // 1 warmup + 2 samples = exactly 3 invocations
      expect(readFileSync(counter, "utf8")).toBe("x\nx\nx\n");
      const { distribution } = result;
      expect(distribution.sampleCount).toBe(2);
      expect(distribution.samples).toEqual([42, 42]);
      expect(distribution.p50).toBe(42);
      expect(distribution.unit).toBe("count");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors a custom unit for a maximization metric command", async () => {
    const result = await runBenchmarkSafe({
      command: "echo '{\"ops_per_sec\": 99.5}'",
      samples: 1,
      unit: "ms",
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.distribution.samples).toEqual([99.5]);
    expect(result.distribution.unit).toBe("ms");
  });

  it("fails with BenchmarkExecutionError on non-numeric output", async () => {
    const result = await runBenchmarkSafe({
      command: "echo 'optimization complete'",
      samples: 1,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error._tag).toBe("BenchmarkExecutionError");
    expect(result.error.message).toContain("parseable");
  });

  it("fails with BenchmarkExecutionError on nonzero exit", async () => {
    const result = await runBenchmarkSafe({
      command: 'echo "segmentation" >&2 && exit 3',
      samples: 1,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("exit 3");
  });

  it("fails with BenchmarkExecutionError on an invalid working directory", async () => {
    const result = await runBenchmarkSafe({
      command: "echo 1",
      cwd: join(tmpdir(), `perfgym-missing-${Date.now()}`),
      samples: 1,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("does not exist");
  });

  it("kills a runaway metric command on timeout (fast)", async () => {
    const startedAt = Date.now();
    const result = await runBenchmarkSafe({
      command: "node -e \"setInterval(() => {}, 1000)\"",
      samples: 1,
      timeoutMs: 300,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("timed out");
    expect(result.error.message).toContain("SIGKILL");
    expect(elapsed).toBeLessThan(3_000);
  });

  it("caps captured stdout at 2MB and marks truncation", async () => {
    const twoMb = 2 * 1024 * 1024;
    const result = await runBenchmarkSafe({
      command: `node -e "process.stdout.write('A'.repeat(${twoMb + 1024}))"`,
      samples: 1,
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const rawOutput = result.error.rawOutput ?? "";
    expect(rawOutput.endsWith("\n[truncated]")).toBe(true);
    expect(Buffer.byteLength(rawOutput.slice(0, -"\n[truncated]".length), "utf8")).toBe(
      twoMb
    );
  });

  describe("frozen harness tamper protection (only when harnessDir is provided)", () => {
    it("is NOT enforced when harnessDir is omitted (plain API)", async () => {
      const result = await runBenchmarkSafe({
        command: "echo 7",
        samples: 1,
        timeoutMs: 5_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.distribution.samples).toEqual([7]);
    });

    it("accepts a read-only harness directory", async () => {
      const dir = mkdtempSync(join(tmpdir(), "perfgym-harness-ok-"));
      try {
        const harnessFile = join(dir, "harness.py");
        writeFileSync(harnessFile, "print('frozen')\n");
        chmodSync(harnessFile, 0o444);
        chmodSync(dir, 0o555);

        const result = await runBenchmarkSafe({
          command: "echo 123",
          samples: 1,
          harnessDir: dir,
          timeoutMs: 5_000,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.distribution.samples).toEqual([123]);
      } finally {
        chmodSync(dir, 0o755);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails when the harness directory is missing", async () => {
      const result = await runBenchmarkSafe({
        command: "echo 1",
        samples: 1,
        harnessDir: join(tmpdir(), `perfgym-harness-missing-${Date.now()}`),
        timeoutMs: 5_000,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("does not exist");
      expect(result.error.message).toContain(DEFAULT_HARNESS_DIR);
    });

    it("fails when a harness file is writable", async () => {
      const dir = mkdtempSync(join(tmpdir(), "perfgym-harness-writable-"));
      try {
        writeFileSync(join(dir, "harness.py"), "print('tamperable')\n");
        chmodSync(join(dir, "harness.py"), 0o644);
        chmodSync(dir, 0o555);

        const result = await runBenchmarkSafe({
          command: "echo 1",
          samples: 1,
          harnessDir: dir,
          timeoutMs: 5_000,
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.message).toContain("writable");
        expect(result.error.message).toContain("harness.py");
      } finally {
        chmodSync(dir, 0o755);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails when the harness directory is empty", async () => {
      const dir = mkdtempSync(join(tmpdir(), "perfgym-harness-empty-"));
      try {
        chmodSync(dir, 0o555);

        const result = await runBenchmarkSafe({
          command: "echo 1",
          samples: 1,
          harnessDir: dir,
          timeoutMs: 5_000,
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.message).toContain("no files");
      } finally {
        chmodSync(dir, 0o755);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("resolves relative harnessDir against options.cwd", async () => {
      const workspace = mkdtempSync(join(tmpdir(), "perfgym-ws-"));
      const relHarness = "custom-harness";
      const harnessDir = join(workspace, relHarness);
      try {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(harnessDir, { recursive: true });
        const hFile = join(harnessDir, "metric.js");
        writeFileSync(hFile, "console.log(123);\n");
        chmodSync(hFile, 0o444);
        chmodSync(harnessDir, 0o555);

        const result = await runBenchmarkSafe({
          command: "echo 99",
          samples: 1,
          cwd: workspace,
          harnessDir: relHarness,
          timeoutMs: 5_000,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.distribution.samples).toEqual([99]);
      } finally {
        try { chmodSync(harnessDir, 0o755); } catch {}
        chmodSync(workspace, 0o755);
        rmSync(workspace, { recursive: true, force: true });
      }
    });

    it("fails when the harness directory itself is writable", async () => {
      const dir = mkdtempSync(join(tmpdir(), "perfgym-harness-dir-writable-"));
      try {
        const harnessFile = join(dir, "harness.py");
        writeFileSync(harnessFile, "print('frozen')\n");
        chmodSync(harnessFile, 0o444);
        // dir is 0o755 by default, so it's writable!

        const result = await runBenchmarkSafe({
          command: "echo 1",
          samples: 1,
          harnessDir: dir,
          timeoutMs: 5_000,
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.message).toContain("directory");
        expect(result.error.message).toContain("writable");
      } finally {
        chmodSync(dir, 0o755);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails when a file in a subdirectory is writable", async () => {
      const dir = mkdtempSync(join(tmpdir(), "perfgym-harness-subdir-"));
      const sub = join(dir, "sub");
      try {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(sub);
        const file = join(sub, "nested.sh");
        writeFileSync(file, "echo nested\n");
        chmodSync(file, 0o644); // writable nested file
        chmodSync(sub, 0o555);
        chmodSync(dir, 0o555);

        const result = await runBenchmarkSafe({
          command: "echo 1",
          samples: 1,
          harnessDir: dir,
          timeoutMs: 5_000,
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.message).toContain("writable");
        expect(result.error.message).toContain("nested.sh");
      } finally {
        try { chmodSync(sub, 0o755); } catch {}
        chmodSync(dir, 0o755);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails when a symlink targets outside the harness directory", async () => {
      const dir = mkdtempSync(join(tmpdir(), "perfgym-harness-symlink-"));
      const outsideDir = mkdtempSync(join(tmpdir(), "perfgym-outside-"));
      try {
        const { symlinkSync } = await import("node:fs");
        const outsideFile = join(outsideDir, "escape.py");
        writeFileSync(outsideFile, "print('escaped')\n");
        chmodSync(outsideFile, 0o444);

        const linkPath = join(dir, "link.py");
        symlinkSync(outsideFile, linkPath);
        chmodSync(dir, 0o555);

        const result = await runBenchmarkSafe({
          command: "echo 1",
          samples: 1,
          harnessDir: dir,
          timeoutMs: 5_000,
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.message).toContain("symlink");
      } finally {
        chmodSync(dir, 0o755);
        rmSync(dir, { recursive: true, force: true });
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });
  });
});
