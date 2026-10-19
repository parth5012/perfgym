import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PerfGymConfig, WorkspaceContext } from "../index.js";
import { computeBenchmarkDistribution, verifyFrozenHarness } from "./benchmark.js";
import { EvaluationPipeline } from "./pipeline.js";
import { AstLinterEngine } from "../../../linter/src/engine.js";
import { TypecheckGate } from "../../../linter/src/typecheck.js";
import { InMemorySandboxDriver } from "../sandbox/in-memory-driver.js";

// ============================================================================
// Test helpers — real on-disk sandboxes (subprocess stages need a real cwd)
// ============================================================================

const BENCHMARK_MARKER_DIR = "stages/run-benchmark.txt";
const BENCHMARK_MARKER_DIR_OFFSET = "stages/run-benchmark.txt";
const BENCHMARK_MARKER_COMMAND =
  `node -e "const fs = require('fs'); fs.mkdirSync('stages', { recursive: true }); fs.writeFileSync('stages/run-benchmark.txt', 'stage-3-ran'); console.log(JSON.stringify({ value: 50 }))"`;

let sandboxSeq = 0;

interface SandboxOptions {
  readonly invariantCommand?: string;
  readonly metricCommand?: string;
  readonly metricTimeoutCommand?: string;
  readonly files?: Record<string, string>;
  readonly invariantTimeoutMs?: number;
  readonly withTsconfig?: boolean;
  readonly withFrozenSources?: boolean;
}

interface Sandbox {
  readonly sandboxDir: string;
  readonly config: PerfGymConfig;
}

function makeSandbox(options: SandboxOptions = {}): Sandbox {
  const sandboxDir = join(tmpdir(), `perfgym-pipeline-${Date.now()}-${++sandboxSeq}`);
  rmSync(sandboxDir, { recursive: true, force: true });
  mkdirSync(join(sandboxDir, "src"), { recursive: true });
  mkdirSync(join(sandboxDir, "stages"), { recursive: true });
  writeFileSync(
    join(sandboxDir, "src", "hot.ts"),
    "export function hot(nums: number[]): number {\n  return nums.reduce((a, b) => a + b, 0);\n}\n",
    "utf8"
  );
  for (const [rel, content] of Object.entries(options.files ?? {})) {
    const full = join(sandboxDir, rel);
    writeFileSync(full, content, "utf8");
  }
  if (options.withTsconfig === true) {
    writeFileSync(
      join(sandboxDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*"] }),
      "utf8"
    );
  }
  if (options.withFrozenSources === true) {
    mkdirSync(join(sandboxDir, "tests"), { recursive: true });
    mkdirSync(join(sandboxDir, "bench"), { recursive: true });
    writeFileSync(
      join(sandboxDir, "tests", "unit.test.ts"),
      "import { expect } from 'vitest';\nexpect(hot([1, 2])).toBe(3);\n",
      "utf8"
    );
    writeFileSync(
      join(sandboxDir, "bench", "run.ts"),
      "console.log('bench runner');\n",
      "utf8"
    );
  }

  const config: PerfGymConfig = {
    version: "0.1",
    target: { name: "hot-path", language: "typescript", files: ["src/**/*"] },
    invariants: {
      command:
        options.invariantCommand ??
        `node -e "console.log('invariants ok')"`,
      ...(options.invariantTimeoutMs !== undefined
        ? { timeoutMs: options.invariantTimeoutMs }
        : {}),
    },
    metrics: [
      {
        name: "ops",
        command:
          options.metricCommand ??
          `node -e "console.log(JSON.stringify({ value: 90 }))"
        `.trim(),
        goal: "minimize",
        weight: 1,
        unit: "count",
        // Frozen benchmark runner script sources for the harness freezer.
        ...(options.withFrozenSources === true ? { harnessScripts: ["bench/run.ts"] } : {}),
      },
    ],
  };
  return { sandboxDir, config };
}

function contextFor(sandboxDir: string): WorkspaceContext {
  return {
    runId: "run-test",
    workingDir: sandboxDir,
    branchName: "perfgym/eval-run-test",
    baseRef: "main",
  };
}

const BASELINE = { ops: 100 };
const SAMPLES = 3;

// ============================================================================
// Happy path: full 4-stage cascade accepts a significant improvement
// ============================================================================

describe("EvaluationPipeline — happy path", () => {
  it("runs all four stages and accepts a significant improvement", async () => {
    const { sandboxDir, config } = makeSandbox();
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      iteration: 7,
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(true);
    expect(step.isSignificant).toBe(true);
    expect(step.fitnessScore).toBeGreaterThan(0);
    expect(step.deltaPercent).toBeGreaterThan(5);
    // minimize: current 90 vs baseline 100 => +10%
    expect(step.deltaPercent).toBeCloseTo(10, 0);
    expect(step.iteration).toBe(7);
    expect(step.invariants.passed).toBe(true);
    expect(step.violations).toHaveLength(0);
    expect(step.metrics[0]?.name).toBe("ops");
    expect(step.metrics[0]?.improved).toBe(true);
    expect(step.executionTimeMs).toBeGreaterThan(0);
    expect(step.revertReason).toBeUndefined();
    expect(step.currentDistribution?.sampleCount).toBe(SAMPLES);
    expect(step.baselineDistribution).toBeUndefined();
    // frozen harness was never initialized — no enforcement opt-in
    expect(pipeline.harnessDir).toBeNull();
  });

  it("attaches baseline + current distributions and passes the tail guard", async () => {
    const { sandboxDir, config } = makeSandbox();
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    const baselineDistribution = computeBenchmarkDistribution([100, 100, 100, 100], "count");
    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      baseline: baselineDistribution,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(true);
    expect(step.baselineDistribution).toBeDefined();
    expect(step.currentDistribution).toBeDefined();
    expect(step.currentDistribution?.p50).toBe(90);
    // ceiling = 100 + 3*0 = 100; current p99 = 90 — no tail breach.
    expect(step.fitnessScore).toBeGreaterThan(0);
  });

  it("respects configured metric weights when scoring", async () => {
    const { sandboxDir, config } = makeSandbox({
      files: {},
    });
    // Second metric emitting 180 (10% down from 200).
    const cfg: PerfGymConfig = {
      ...config,
      metrics: [
        ...config.metrics,
        {
          name: "mem",
          command: `node -e "console.log(JSON.stringify({ value: 180 }))"`,
          goal: "minimize",
          weight: 1,
          unit: "count",
        },
      ],
    };
    // weights 0.6/0.4 sum to 1; both deltas are 10% => score 10.
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline({ ...cfg }, engine);
    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: { ops: 100, mem: 200 },
      samples: SAMPLES,
    });
    expect(step.accepted).toBe(true);
    expect(step.deltaPercent).toBeCloseTo(10, 0); // primary = metrics[0]
    expect(step.fitnessScore).toBeCloseTo(10, 5);
  });
});

// ============================================================================
// Stage 1 short-circuit: invariant failures abort instantly
// ============================================================================

describe("EvaluationPipeline — stage 1 short-circuit (invariants)", () => {
  it("rejects with -Infinity on invariant failure and never reaches stage 3", async () => {
    const { sandboxDir, config } = makeSandbox({
      invariantCommand: `node -e "process.exit(1)"`,
      metricCommand: BENCHMARK_MARKER_COMMAND,
    });
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(step.isSignificant).toBe(false);
    expect(step.revertReason).toContain("invariants failed");
    expect(step.invariants.passed).toBe(false);
    expect(step.metrics).toHaveLength(0);
    expect(existsSync(join(sandboxDir, BENCHMARK_MARKER_DIR))).toBe(false);
  });

  it("rejects hung invariants quickly when the config timeout is clamped", async () => {
    const { sandboxDir, config } = makeSandbox({
      invariantCommand: `sleep 5`,
      invariantTimeoutMs: 500,
      metricCommand: `node -e "console.log(JSON.stringify({ value: 50 }))"`,
    });
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    const startedAt = Date.now();
    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    const elapsed = Date.now() - startedAt;
    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(step.invariants.passed).toBe(false);
    expect(step.revertReason).toContain("invariants failed");
    // 500ms deadline + settle fallback; must be far under the raw sleep.
    expect(elapsed).toBeLessThan(4000);
  });
});

// ============================================================================
// Stage 2 short-circuit: anti-cheat disqualification + typecheck tampering
// ============================================================================

describe("EvaluationPipeline — stage 2 short-circuit (anti-cheat)", () => {
  it("rejects @ts-ignore tampering without running benchmarks", async () => {
    const { sandboxDir, config } = makeSandbox({
      metricCommand: BENCHMARK_MARKER_COMMAND,
    });
    writeFileSync(
      join(sandboxDir, "src", "hot.ts"),
      "// @ts-ignore\nexport const cheat: number = (input as any);\n",
      "utf8"
    );
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(step.revertReason).toContain("isqualif"); // "Disqualified by rule"
    expect(
      step.violations.some((v) => v.action === "disqualify")
    ).toBe(true);
    expect(existsSync(join(sandboxDir, BENCHMARK_MARKER_DIR_OFFSET))).toBe(false);
  });

  it("rejects tsconfig tampering (config integrity) as types-broken", async () => {
    const { sandboxDir, config } = makeSandbox({
      withTsconfig: true,
      metricCommand: BENCHMARK_MARKER_COMMAND,
    });
    const engine = new AstLinterEngine([], sandboxDir); // hashes tsconfig at construction
    const pipeline = new EvaluationPipeline(config, engine);

    // Mutate the protected tsconfig AFTER baseline.
    writeFileSync(
      join(sandboxDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: false }, include: ["src/**/*"] }),
      "utf8"
    );

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(step.revertReason).toContain("typecheck");
    expect(existsSync(join(sandboxDir, BENCHMARK_MARKER_DIR))).toBe(false);
  });

  it("detects @ts-ignore disqualification via tier-1 scan when linter has no projectRoot and no typechecker is provided (M5)", async () => {
    const { sandboxDir, config } = makeSandbox({
      metricCommand: BENCHMARK_MARKER_COMMAND,
    });
    writeFileSync(
      join(sandboxDir, "src", "hot.ts"),
      "// @ts-ignore\nexport const cheat: number = (input as any);\n",
      "utf8"
    );
    // Linter constructed WITHOUT projectRoot, and NO explicit TypecheckGate passed to pipeline
    const engine = new AstLinterEngine([]);
    const pipeline = new EvaluationPipeline(config, engine);

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(
      step.violations.some((v) => v.action === "disqualify")
    ).toBe(true);
    expect(existsSync(join(sandboxDir, BENCHMARK_MARKER_DIR))).toBe(false);
  });

  it("inspects context.workingDir when explicit typechecker checks config integrity (M5)", async () => {
    const { sandboxDir, config } = makeSandbox({
      withTsconfig: true,
      metricCommand: BENCHMARK_MARKER_COMMAND,
    });
    const gate = new TypecheckGate(sandboxDir);
    const engine = new AstLinterEngine([]); // no projectRoot on engine
    const pipeline = new EvaluationPipeline(config, engine, gate);

    // Mutate tsconfig in workingDir
    writeFileSync(
      join(sandboxDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: false }, include: ["src/**/*"] }),
      "utf8"
    );

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(step.violations.some((v) => v.message.includes("Config integrity violated"))).toBe(true);
    expect(existsSync(join(sandboxDir, BENCHMARK_MARKER_DIR))).toBe(false);
  });

  it("rejects step when modifiedFiles contains a path escaping the workspace (N7)", async () => {
    const { sandboxDir, config } = makeSandbox();
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["../outside.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(step.revertReason).toContain("Modified file outside workspace");
  });
});

// ============================================================================
// Stage 3 failures: benchmark portability/runtime errors
// ============================================================================

describe("EvaluationPipeline — stage 3 benchmark failures", () => {
  it("rejects with -Infinity when the benchmark command crashes", async () => {
    const { sandboxDir, config } = makeSandbox({
      metricCommand: `node -e "process.exit(3)"`,
    });
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(step.revertReason).toContain("benchmark failed");
    expect(step.metrics).toHaveLength(0);
  });

  it("rejects when the benchmark emits no parseable numeric metric", async () => {
    const { sandboxDir, config } = makeSandbox({
      metricCommand: `node -e "console.log('no numbers here')"`,
    });
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(step.revertReason).toContain("benchmark failed");
  });

  it("forwards per-metric timeoutMs to runBenchmark in stage 3", async () => {
    const { sandboxDir, config } = makeSandbox({
      metricCommand: `node -e "setTimeout(() => {}, 2000)"`,
    });
    config.metrics[0].timeoutMs = 300;
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(step.revertReason).toContain("timed out after 300ms");
  });
});

// ============================================================================
// Stage 4 verdict: insignificant noise + tail-guard regression
// ============================================================================

describe("EvaluationPipeline — stage 4 verdict", () => {
  it("rejects insignificant noise with score 0 (accepted false, not -Infinity)", async () => {
    const { sandboxDir, config } = makeSandbox({
      metricCommand: `node -e "console.log(JSON.stringify({ value: 99 }))"`, // 1% delta
    });
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.isSignificant).toBe(false);
    expect(step.fitnessScore).toBe(0); // finite: noise, not cheating
    expect(step.revertReason).toContain("significance threshold");
  });

  it("rejects tail-guard regression even with a huge positive delta", async () => {
    const { sandboxDir, config } = makeSandbox({
      metricCommand: `node -e "console.log(JSON.stringify({ value: 200 }))"`, // 100% gain
    });
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    const baseline = computeBenchmarkDistribution([100, 100, 100, 100], "count"); // p50 100, MAD 0

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      baseline,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(step.revertReason).toContain("Tail degraded");
  });

  it("rejects when no baseline metric value was supplied (no relative signal)", async () => {
    const { sandboxDir, config } = makeSandbox();
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.isSignificant).toBe(false);
    expect(step.metrics[0]?.deltaPercent).toBe(0);
    expect(step.revertReason).toContain("significance threshold");
  });
});

// ============================================================================
// Frozen harness: freezing, read-only bits, tamper verification wiring
// ============================================================================

describe("EvaluationPipeline — frozen harness", () => {
  it("freezes declared test + runner files read-only at initializeHarness", async () => {
    const { sandboxDir, config } = makeSandbox({
      withFrozenSources: true,
      // Invariant command that references its test path (the freezer's declared-source seam).
      invariantCommand: `node -e "console.log('invariants ok', process.argv)" tests/unit.test.ts`,
    });
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    await pipeline.initializeHarness(sandboxDir);

    const harnessDir = pipeline.harnessDir;
    expect(harnessDir).not.toBeNull();
    expect(harnessDir).toContain(join(".perfgym", ".harness"));

    const frozenTest = join(harnessDir!, "tests", "unit.test.ts");
    const frozenRunner = join(harnessDir!, "bench", "run.ts");
    expect(existsSync(frozenTest)).toBe(true);
    expect(existsSync(frozenRunner)).toBe(true);

    const fileMode = statSync(frozenTest).mode & 0o777;
    expect(fileMode & 0o222).toBe(0); // no write bits
    const dirMode = statSync(harnessDir!).mode & 0o777;
    expect(dirMode & 0o222).toBe(0); // dir read-only
  });

  it("fails stage 3 with -Infinity when a harness file becomes writable mid-flight", async () => {
    const { sandboxDir, config } = makeSandbox({
      withFrozenSources: true,
      invariantCommand: `node -e "console.log('invariants ok', process.argv)" tests/unit.test.ts`,
    });
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);
    await pipeline.initializeHarness(sandboxDir);

    // Agent tampers with the frozen grading harness...
    const frozenTest = join(pipeline.harnessDir!, "tests", "unit.test.ts");
    chmodSync(frozenTest, 0o644);

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(step.revertReason).toContain("harness");
  });

  it("copies harness content only when config declares freezable paths (empty harness never blocks benchmarking)", async () => {
    const { sandboxDir, config } = makeSandbox();
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);
    await pipeline.initializeHarness(sandboxDir);

    expect(pipeline.harnessDir).toBeNull(); // nothing frozen — enforcement skipped

    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });
    expect(step.accepted).toBe(true); // benchmark stage unblocked without harness
  });

  it("throws clear containment error when initializeHarness receives path traversal or absolute path outside repoDir (B1)", async () => {
    const { sandboxDir, config } = makeSandbox({ withFrozenSources: true });
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    // Outside path traversal target with a canary file that must not be deleted
    const outsideDir = join(tmpdir(), `perfgym-outside-canary-${Date.now()}`);
    mkdirSync(outsideDir, { recursive: true });
    const canaryFile = join(outsideDir, "canary.txt");
    writeFileSync(canaryFile, "do-not-delete", "utf8");

    try {
      await expect(
        pipeline.initializeHarness(sandboxDir, { harnessDir: "../outside" })
      ).rejects.toThrow(/repoDir/i);

      await expect(
        pipeline.initializeHarness(sandboxDir, { harnessDir: outsideDir })
      ).rejects.toThrow(/repoDir/i);

      // Verify nothing outside repoDir was deleted or modified
      expect(existsSync(canaryFile)).toBe(true);
      expect(readFileSync(canaryFile, "utf8")).toBe("do-not-delete");
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("skips symlinked sources resolving outside repoDir to prevent exfiltration (B2)", async () => {
    const { sandboxDir, config } = makeSandbox({
      withFrozenSources: true,
      invariantCommand: `node -e "console.log('invariants ok')" tests/unit.test.ts`,
    });
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);

    // Create an external secret file outside repoDir
    const outsideSecret = join(tmpdir(), `perfgym-outside-secret-${Date.now()}.ts`);
    writeFileSync(outsideSecret, "export const SECRET = 42;\n", "utf8");

    try {
      // Replace tests/unit.test.ts with a symlink resolving outside repoDir
      const symlinkPath = join(sandboxDir, "tests", "unit.test.ts");
      rmSync(symlinkPath, { force: true });
      symlinkSync(outsideSecret, symlinkPath);

      await pipeline.initializeHarness(sandboxDir);

      // The symlinked file outside repoDir must NOT be copied into the frozen harness
      if (pipeline.harnessDir !== null) {
        const frozenInHarness = join(pipeline.harnessDir, "tests", "unit.test.ts");
        expect(existsSync(frozenInHarness)).toBe(false);
      }
    } finally {
      rmSync(outsideSecret, { force: true });
    }
  });

  it("re-initializing harness from a new pipeline instance restores write bits and does not throw (M3)", async () => {
    const { sandboxDir, config } = makeSandbox({
      withFrozenSources: true,
      invariantCommand: `node -e "console.log('invariants ok')" tests/unit.test.ts`,
    });
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline1 = new EvaluationPipeline(config, engine);
    await pipeline1.initializeHarness(sandboxDir);

    // New pipeline instance starts with #frozenHarnessDir = null
    const pipeline2 = new EvaluationPipeline(config, engine);
    await expect(pipeline2.initializeHarness(sandboxDir)).resolves.not.toThrow();
  });

  it("makes nested subdirectories and files recursively read-only and passes verifyFrozenHarness (M4)", async () => {
    const { sandboxDir, config } = makeSandbox({
      withFrozenSources: true,
      invariantCommand: `node -e "console.log('invariants ok')" tests/unit.test.ts`,
    });
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(config, engine);
    await pipeline.initializeHarness(sandboxDir);

    const harnessDir = pipeline.harnessDir!;
    expect(harnessDir).not.toBeNull();

    const nestedDir = join(harnessDir, "tests");
    const nestedFile = join(harnessDir, "tests", "unit.test.ts");

    // Both nested dir and nested file must have no write bits (dirs 0555, files 0444)
    expect(statSync(nestedDir).mode & 0o222).toBe(0);
    expect(statSync(nestedFile).mode & 0o222).toBe(0);

    // Benchmark-stage frozen harness verification must pass without throwing
    expect(() => verifyFrozenHarness(harnessDir, sandboxDir)).not.toThrow();
  });
});

// ============================================================================
// Integration with the sandbox layer (WorkspaceContext via InMemorySandboxDriver)
// ============================================================================

describe("EvaluationPipeline — sandbox integration", () => {
  it("evaluates mutations produced through an InMemorySandboxDriver workspace", async () => {
    const content =
      "export function hot(nums: number[]): number {\n  return nums.reduce((a, b) => a + b, 0);\n}\n";
    const driver = new InMemorySandboxDriver({
      allowedGlobs: ["src/**/*"],
      initialFiles: { "src/hot.ts": content },
    });
    const stored = await driver.initialize("run-int", "main");
    await driver.writeFile("src/hot.ts", content); // boundary-checked mutation

    // Materialize the workspace on disk: subprocess stages need a real cwd.
    const onDisk = makeSandbox();
    const workingDir = onDisk.sandboxDir;
    const context: WorkspaceContext = { ...stored, workingDir };

    const pipeline = new EvaluationPipeline(
      onDisk.config,
      new AstLinterEngine([], workingDir)
    );
    const step = await pipeline.evaluateStep(context, ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });

    expect(step.accepted).toBe(true);
    expect(step.fitnessScore).toBeGreaterThan(0);
    expect(driver.getWorkingDir()).toBe("/virtual/worktrees/run-int");
  });
});

// ============================================================================
// Construction misuse throws (the only throwing surface)
// ============================================================================

describe("EvaluationPipeline — construction validation", () => {
  it("throws on an invalid config instead of rejecting steps", () => {
    const { sandboxDir, config } = makeSandbox();
    const engine = new AstLinterEngine([], sandboxDir);
    expect(() => new EvaluationPipeline(undefined as unknown as PerfGymConfig, engine)).toThrow();
    expect(
      () =>
        new EvaluationPipeline(
          { ...config, invariants: { command: "" } } as PerfGymConfig,
          engine
        )
    ).toThrow();
  });

  it("throws when config has an empty metrics array (N9)", () => {
    const { sandboxDir, config } = makeSandbox();
    const engine = new AstLinterEngine([], sandboxDir);
    expect(
      () =>
        new EvaluationPipeline(
          { ...config, metrics: [] },
          engine
        )
    ).toThrow(/non-empty metrics array/i);
  });

  it("ignores legacy invariants.retries (ADR-020 zero retries)", async () => {
    const { sandboxDir, config } = makeSandbox({
      invariantCommand: `node -e "process.exit(1)"`,
    });
    const cfg: PerfGymConfig = {
      ...config,
      invariants: { ...config.invariants, retries: 2 },
    };
    const engine = new AstLinterEngine([], sandboxDir);
    const pipeline = new EvaluationPipeline(cfg, engine);
    const step = await pipeline.evaluateStep(contextFor(sandboxDir), ["src/hot.ts"], {
      baselineMetrics: BASELINE,
      samples: SAMPLES,
    });
    // A single failing run rejects; legacy retries must never re-run the gate.
    expect(step.accepted).toBe(false);
    expect(step.fitnessScore).toBe(-Infinity);
    expect(step.invariants.retriesUsed ?? 0).toBe(0);
  });
});
