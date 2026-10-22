/**
 * @perfgym/core
 * JsonFormatter — the machine-parseable adapter of the OutputFormatter seam.
 *
 * Pure and synchronous: it takes domain objects and returns JSON text. It
 * never touches I/O, never consults memory, and never emits ANSI. The schema
 * is LLD §6.1, field for field — absent data is `null`, never a fabricated
 * zero, and a rejected step's `-Infinity` fitness score serialises to `null`.
 */

import type {
  BenchmarkDistribution,
  InvariantResult,
  LintViolation,
  MetricGoal,
  PerfGymConfig,
  StepEvaluation,
} from "../index.js";
import type { PerfGymSessionState, SessionLockState } from "../store/index.js";
import type { NegativeMemoryEntry } from "../memory/index.js";
import {
  type DistributionJson,
  type LintMatchJson,
  type TailGuardJson,
  astViolationsOf,
  describeError,
  resolveLintAction,
  stripAnsi,
  tailGuardOf,
  toDistributionJson,
  toLintMatchJson,
  totalPenaltyOf,
  typecheckFailuresOf,
} from "./shared.js";

export interface StepEvaluationJson {
  status: "ACCEPTED" | "REVERTED";
  accepted: boolean;
  score: number | null;
  deltaPercent: number;
  isSignificant: boolean;
  executionTimeMs: number;
  invariants: {
    passed: boolean;
    retriesUsed: number | null;
    command: string | null;
    durationMs: number;
  };
  typecheck: {
    passed: boolean;
    tier: string | null;
    disqualified: boolean;
  };
  linter: {
    passed: boolean;
    disqualified: boolean;
    totalPenalty: number;
    matches: LintMatchJson[];
  };
  metrics: {
    target: string | null;
    unit: string | null;
    goal: MetricGoal | null;
    baseline: DistributionJson | null;
    current: DistributionJson | null;
    tailGuard: TailGuardJson;
  };
  stepReceipt: null;
  negativeMemoryGuidance: null;
}

/**
 * Project a step evaluation onto LLD §6.1.
 *
 * `config` is optional so the mandated `formatStep(evaluation)` call still
 * works; when supplied it fills the fields the evaluation alone cannot carry
 * (invariant command, metric target/goal) and lets the tail guard report the
 * verdict the pipeline actually reached.
 */
export const toStepEvaluationJson = (
  evaluation: StepEvaluation,
  config?: PerfGymConfig,
): StepEvaluationJson => {
  const typecheckFailures = typecheckFailuresOf(evaluation);
  const astViolations = astViolationsOf(evaluation.violations);
  const configuredMetric = config?.metrics?.[0];
  const goal: MetricGoal | null = configuredMetric?.goal ?? null;
  const distribution = evaluation.currentDistribution ?? evaluation.baselineDistribution;

  return {
    status: evaluation.accepted ? "ACCEPTED" : "REVERTED",
    accepted: evaluation.accepted,
    // -Infinity is not representable in JSON; LLD §6.1 requires null.
    score: Number.isFinite(evaluation.fitnessScore) ? evaluation.fitnessScore : null,
    deltaPercent: evaluation.deltaPercent,
    isSignificant: evaluation.isSignificant,
    executionTimeMs: evaluation.executionTimeMs,
    invariants: {
      passed: evaluation.invariants.passed,
      // Absent stays absent: no fabricated zero.
      retriesUsed: evaluation.invariants.retriesUsed ?? null,
      command: config?.invariants?.command ?? null,
      durationMs: evaluation.invariants.durationMs,
    },
    typecheck: {
      passed: typecheckFailures.length === 0,
      // The per-step gate runs tier-1 only; the tier label is not on the result.
      tier: null,
      disqualified: typecheckFailures.length > 0,
    },
    linter: {
      passed: astViolations.length === 0,
      disqualified: astViolations.some(
        (violation) => resolveLintAction(violation) === "disqualify",
      ),
      totalPenalty: totalPenaltyOf(astViolations),
      matches: astViolations.map(toLintMatchJson),
    },
    metrics: {
      target: configuredMetric?.name ?? evaluation.metrics[0]?.name ?? null,
      unit: distribution?.unit ?? evaluation.metrics[0]?.unit ?? null,
      goal,
      baseline:
        evaluation.baselineDistribution === undefined
          ? null
          : toDistributionJson(evaluation.baselineDistribution),
      current:
        evaluation.currentDistribution === undefined
          ? null
          : toDistributionJson(evaluation.currentDistribution),
      tailGuard: tailGuardOf(
        evaluation.baselineDistribution,
        evaluation.currentDistribution,
        goal,
      ),
    },
    stepReceipt: null,
    negativeMemoryGuidance: null,
  };
};

export class JsonFormatter {
  readonly format = "json" as const;

  formatStep(evaluation: StepEvaluation, config?: PerfGymConfig): string {
    return JSON.stringify(toStepEvaluationJson(evaluation, config), null, 2);
  }

  formatBaseline(distribution: BenchmarkDistribution, config?: PerfGymConfig): string {
    return JSON.stringify(
      {
        status: "BASELINE",
        target: config?.target?.name ?? null,
        unit: distribution.unit,
        goal: config?.metrics?.[0]?.goal ?? null,
        sampleCount: distribution.sampleCount,
        distribution: toDistributionJson(distribution),
      },
      null,
      2,
    );
  }

  formatStatus(state: PerfGymSessionState, lock?: SessionLockState | null): string {
    return JSON.stringify(
      {
        runId: state.runId,
        baseRef: state.baseRef,
        status: state.status,
        currentStep: state.currentStep,
        baseline: state.baseline === null ? null : toDistributionJson(state.baseline),
        bestScore: Number.isFinite(state.bestScore) ? state.bestScore : null,
        bestStep: state.bestStep,
        historyLength: state.history.length,
        lock: lock ?? state.lock ?? null,
        lastError: state.lastError === null ? null : stripAnsi(state.lastError),
      },
      null,
      2,
    );
  }

  formatTest(result: InvariantResult): string {
    return JSON.stringify(
      {
        passed: result.passed,
        durationMs: result.durationMs,
        retriesUsed: result.retriesUsed ?? null,
        // Test-runner output is often colourized; consumers must never see ANSI.
        output: stripAnsi(result.output),
      },
      null,
      2,
    );
  }

  formatLint(violations: readonly LintViolation[]): string {
    const astViolations = astViolationsOf(violations);

    return JSON.stringify(
      {
        passed: astViolations.length === 0,
        totalPenalty: totalPenaltyOf(astViolations),
        matches: astViolations.map(toLintMatchJson),
      },
      null,
      2,
    );
  }

  formatBenchmark(
    distribution: BenchmarkDistribution,
    baseline?: BenchmarkDistribution,
  ): string {
    const deltaPercent =
      baseline === undefined || baseline.p50 === 0
        ? null
        : ((distribution.p50 - baseline.p50) / baseline.p50) * 100;

    return JSON.stringify(
      {
        unit: distribution.unit,
        sampleCount: distribution.sampleCount,
        distribution: toDistributionJson(distribution),
        baseline: baseline === undefined ? null : toDistributionJson(baseline),
        deltaPercent: deltaPercent === null ? null : Math.round(deltaPercent * 100) / 100,
      },
      null,
      2,
    );
  }

  formatError(error: unknown): string {
    return JSON.stringify({ error: describeError(error) }, null, 2);
  }

  formatNegativeMemory(
    entries: readonly NegativeMemoryEntry[],
    options?: { target?: string | null },
  ): string {
    // Pure: the entry type is imported type-only, so the JSON adapter never
    // pulls the cache (and its node:fs / node:crypto) into its runtime graph.
    const target = options?.target;
    return JSON.stringify(
      {
        // Absent, null and "" all mean "no target" — the same rule the
        // markdown adapter applies to its target line.
        target: typeof target === "string" && target.length > 0 ? target : null,
        count: entries.length,
        entries: entries.map((entry) => ({
          id: entry.id,
          strategy: stripAnsi(entry.strategy),
          deltaPercent: entry.deltaPercent,
          reason: stripAnsi(entry.reason),
          step: entry.step,
          timestamp: entry.timestamp,
        })),
      },
      null,
      2,
    );
  }
}
