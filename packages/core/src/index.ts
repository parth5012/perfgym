/**
 * @perfgym/core
 * Universal Gym Engine & Hill-Climbing Coordinator
 */

import { Effect } from "effect";
import {
  DisqualificationError,
  InsignificantDeltaError,
  InvariantFailureError,
  TailGuardRegressionError,
} from "./errors.js";

export * from "./errors.js";
export * from "./store/index.js";
export * from "./store/table.js";
export * from "./sandbox/driver.js";

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
  }>;
}

/**
 * Pure mathematical calculation of fitness score:
 * Score = sum(weight * delta_pct) - sum(linter_penalties)
 */
export function calculateFitnessScore(
  metrics: readonly MetricResult[],
  violations: readonly LintViolation[],
  weights: Record<string, number> = {}
): number {
  let perfScore = 0;
  for (const m of metrics) {
    const w = weights[m.name] ?? 1.0;
    perfScore += m.deltaPercent * w;
  }

  const penaltyScore = violations.reduce((acc, v) => acc + v.penalty, 0);
  return perfScore - penaltyScore;
}

/**
 * Effect 4.0 Typesafe Fitness Evaluation
 *
 * Checks invariants, disqualification rules, tail guard regressions, and minimum significance.
 * Returns Effect.fail with tagged errors if rejected, or Effect.succeed with the positive fitness score.
 */
export function evaluateFitnessEffect(params: {
  readonly invariants: InvariantResult;
  readonly violations: readonly LintViolation[];
  readonly metrics: readonly MetricResult[];
  readonly baseline?: BenchmarkDistribution;
  readonly current?: BenchmarkDistribution;
  readonly minSignificanceDelta?: number;
  readonly weights?: Record<string, number>;
}): Effect.Effect<
  number,
  | InvariantFailureError
  | DisqualificationError
  | TailGuardRegressionError
  | InsignificantDeltaError
> {
  return Effect.gen(function* () {
    // 1. Invariant gate
    if (!params.invariants.passed) {
      return yield* Effect.fail(
        new InvariantFailureError({
          command: "invariants",
          exitCode: 1,
          stdout: params.invariants.output,
          stderr: "",
          retriesUsed: params.invariants.retriesUsed ?? 0,
          message: `Invariants failed: ${params.invariants.output}`,
        })
      );
    }

    // 2. Anti-cheating disqualification check
    const disqualifier = params.violations.find((v) => v.action === "disqualify");
    if (disqualifier) {
      return yield* Effect.fail(
        new DisqualificationError({
          ruleId: disqualifier.ruleId,
          file: disqualifier.file,
          line: disqualifier.line,
          message: disqualifier.message,
        })
      );
    }

    // 3. Tail Guard check (p99 ceiling using 3 * MAD)
    if (params.baseline && params.current) {
      const madCeiling = params.baseline.p50 + 3 * params.baseline.mad;
      if (params.current.p99 > madCeiling) {
        return yield* Effect.fail(
          new TailGuardRegressionError({
            metric: params.baseline.unit,
            currentP99: params.current.p99,
            maxAllowedCeiling: madCeiling,
            baselineMad: params.baseline.mad,
            message: `Tail degraded: current p99 (${params.current.p99}) exceeded ceiling (${madCeiling.toFixed(
              2
            )})`,
          })
        );
      }
    }

    // 4. Minimum significance threshold check
    const primaryMetric = params.metrics[0];
    const minThreshold = params.minSignificanceDelta ?? 2.5;
    if (primaryMetric && primaryMetric.deltaPercent < minThreshold) {
      return yield* Effect.fail(
        new InsignificantDeltaError({
          deltaPercent: primaryMetric.deltaPercent,
          minSignificanceThreshold: minThreshold,
          message: `Delta ${primaryMetric.deltaPercent.toFixed(
            2
          )}% is below minimum significance threshold (${minThreshold}%)`,
        })
      );
    }

    // 5. Score calculation
    return calculateFitnessScore(params.metrics, params.violations, params.weights);
  });
}
