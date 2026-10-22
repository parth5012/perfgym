/**
 * @perfgym/core
 * Universal Gym Engine & Hill-Climbing Coordinator
 */

export * from "./errors.js";
export * from "./store/index.js";
export * from "./store/table.js";
export * from "./sandbox/driver.js";
export * from "./sandbox/in-memory-driver.js";
export * from "./sandbox/git-worktree-driver.js";
export * from "./sandbox/coordinator.js";
export * from "./pipeline/invariants.js";
export * from "./pipeline/benchmark.js";
export * from "./pipeline/fitness.js";
export * from "./pipeline/pipeline.js";
export * from "./feedback/synthesizer.js";
export * from "./memory/index.js";
export * from "./formatter/index.js";

export interface MetricResult {
  name: string;
  value: number;
  unit: "instructions" | "bytes" | "ms" | "count";
  improved: boolean;
  deltaPercent: number;
}

export interface InvariantResult {
  passed: boolean;
  output: string;
  durationMs: number;
  retriesUsed?: number;
}

export interface LintViolation {
  ruleId: string;
  message: string;
  file: string;
  line: number;
  severity: "error" | "warning";
  penalty: number;
  action?: "disqualify" | "penalize";
}

export interface BenchmarkDistribution {
  readonly samples: readonly number[];
  readonly p50: number;
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly stddev: number;
  readonly mad: number;
  readonly iqr: number;
  readonly sampleCount: number;
  readonly unit: string;
}

/**
 * Result of evaluating a candidate mutation step across all pipeline stages.
 *
 * NOTE: When rejected (e.g. invariant failure, anti-cheat disqualification,
 * or tail regression), `fitnessScore` is `-Infinity`. Because JSON does not
 * represent `Infinity` or `-Infinity`, `JSON.stringify` serializes `-Infinity`
 * to `null`. Consumers parsing serialized evaluations must treat
 * `accepted === false || fitnessScore === null` as rejected.
 */
export interface StepEvaluation {
  readonly iteration: number;
  readonly fitnessScore: number;
  readonly accepted: boolean;
  readonly isSignificant: boolean;
  readonly deltaPercent: number;
  readonly invariants: InvariantResult;
  readonly violations: readonly LintViolation[];
  readonly metrics: readonly MetricResult[];
  readonly baselineDistribution?: BenchmarkDistribution;
  readonly currentDistribution?: BenchmarkDistribution;
  readonly revertReason?: string;
  readonly executionTimeMs: number;
}

export interface PerfGymConfig {
  version: string;
  target: {
    name: string;
    language: "typescript" | "javascript" | "python" | "go" | "kotlin" | "rust";
    files: string[];
  };
  invariants: {
    command: string;
    timeoutMs?: number;
    retries?: 0 | 1 | 2;
  };
  rules?: Array<{
    id: string;
    message: string;
    severity: "error" | "warning";
    penalty: number;
    action?: "disqualify" | "penalize";
    pattern: string;
  }>;
  metrics: Array<{
    name: string;
    command: string;
    goal: "minimize" | "maximize";
    weight: number;
    /** Measured unit of the metric command's output (defaults to "count"). */
    unit?: "instructions" | "bytes" | "ms" | "count";
    /** Per-metric execution timeout in milliseconds. */
    timeoutMs?: number;
    /**
     * Immutable benchmark-runner scripts to snapshot into the frozen
     * `.perfgym/.harness` grader directory at initializeHarness (#15).
     */
    harnessScripts?: string[];
  }>;
}

