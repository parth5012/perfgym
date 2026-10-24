/**
 * Shared fixtures for the formatter test suites.
 *
 * Not a test file: `.test.ts` is the convention, and vitest only collects
 * `*.test.ts` (see vite.config.ts).
 */

import type {
  BenchmarkDistribution,
  InvariantResult,
  LintViolation,
  MetricResult,
  PerfGymConfig,
  StepEvaluation,
} from "../index.js";
import type { PerfGymSessionState } from "../store/index.js";

export const distribution = (
  overrides: Partial<BenchmarkDistribution> = {},
): BenchmarkDistribution => ({
  samples: [42.1, 43.0, 48.0, 51.2, 58.0],
  p50: 42.1,
  p90: 48.0,
  p95: 51.2,
  p99: 58.0,
  min: 40.2,
  max: 62.1,
  stddev: 3.4,
  mad: 1.2,
  iqr: 2.1,
  sampleCount: 5,
  unit: "ms",
  ...overrides,
});

export const currentDistribution = distribution({
  samples: [43.1, 49.2, 53.0, 61.2, 65.4],
  p50: 43.1,
  p90: 49.2,
  p95: 53.0,
  p99: 61.2,
  min: 41.0,
  max: 65.4,
  stddev: 4.1,
  mad: 1.5,
  iqr: 2.6,
});

export const invariantPass: InvariantResult = {
  passed: true,
  output: "5 tests passed",
  durationMs: 85,
  retriesUsed: 0,
};

export const invariantFail: InvariantResult = {
  passed: false,
  output: "1 test failed: expected 2, received 3",
  durationMs: 120,
  retriesUsed: 0,
};

export const metric: MetricResult = {
  name: "latency_p50",
  value: 43.1,
  unit: "ms",
  improved: false,
  deltaPercent: -2.4,
};

export const violation: LintViolation = {
  ruleId: "no-await-in-loop",
  message: "Avoid serial awaits inside loops; use Promise.all or chunking.",
  file: "src/checkout/process.ts",
  line: 42,
  severity: "warning",
  penalty: 10,
  action: "penalize",
};

export const typecheckViolation: LintViolation = {
  ruleId: "perfgym:typecheck",
  message: "Types broken: src/checkout/process.ts(12,5): error TS2322",
  file: "src/checkout/process.ts",
  line: 12,
  severity: "error",
  penalty: 0,
  action: "disqualify",
};

export const rejectedStep: StepEvaluation = {
  iteration: 3,
  fitnessScore: -Infinity,
  accepted: false,
  isSignificant: false,
  deltaPercent: -2.4,
  invariants: invariantPass,
  violations: [violation],
  metrics: [metric],
  baselineDistribution: distribution(),
  currentDistribution: currentDistribution,
  revertReason: "Tail guard regression: p99 exceeded baseline p50 + 3 * MAD",
  executionTimeMs: 340,
};

export const acceptedStep: StepEvaluation = {
  iteration: 4,
  fitnessScore: 12.4,
  accepted: true,
  isSignificant: true,
  deltaPercent: 2.4,
  invariants: invariantPass,
  violations: [],
  metrics: [{ ...metric, improved: true, deltaPercent: 2.4 }],
  baselineDistribution: distribution(),
  currentDistribution: currentDistribution,
  executionTimeMs: 210,
};

export const shortCircuitStep: StepEvaluation = {
  iteration: 1,
  fitnessScore: -Infinity,
  accepted: false,
  isSignificant: false,
  deltaPercent: 0,
  invariants: invariantFail,
  violations: [typecheckViolation],
  metrics: [],
  revertReason: "Invariant tests failed",
  executionTimeMs: 95,
};

export const sessionState: PerfGymSessionState = {
  runId: "run-42",
  baseRef: "main",
  status: "accepted",
  currentStep: 4,
  baseline: distribution(),
  bestScore: 12.4,
  bestStep: 4,
  history: [acceptedStep],
  lock: null,
  lastError: null,
  lastUpdatedAt: 1717171717,
};

/** Minimal config used to exercise config-derived fields (goal, command, target). */
export const minimizeConfig: PerfGymConfig = {
  version: "1.0",
  target: { name: "checkout", language: "typescript", files: ["src/**/*.ts"] },
  invariants: { command: "pnpm test:invariants" },
  metrics: [{ name: "latency_p50", command: "pnpm bench", goal: "minimize", weight: 1, unit: "ms" }],
};

export const maximizeConfig: PerfGymConfig = {
  ...minimizeConfig,
  metrics: [
    { name: "throughput", command: "pnpm bench", goal: "maximize", weight: 1, unit: "count" },
  ],
};

/** `severity: "error"` with no explicit action — the pipeline penalizes it. */
export const errorSeverityViolation: LintViolation = {
  ruleId: "no-console-log",
  message: "Avoid console logging in hot paths.",
  file: "src/hot.ts",
  line: 7,
  severity: "error",
  penalty: 1,
};

/** Any ANSI escape sequence — must never appear in formatter output. */
export const ANSI_PATTERN = /\u001b\[[0-9;]*m/;
