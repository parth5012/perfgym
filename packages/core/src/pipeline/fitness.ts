import { Effect } from "effect";
import {
  DisqualificationError,
  InsignificantDeltaError,
  InvariantFailureError,
  TailGuardRegressionError,
} from "../errors.js";
import type { BenchmarkDistribution, InvariantResult, LintViolation, MetricResult } from "../index.js";

/**
 * ============================================================================
 * Fitness Calculator (pipeline stage 3)
 * ============================================================================
 *
 * The single canonical mathematical objective the hill-climbing coordinator
 * scores every candidate step with:
 *
 * ```
 * Score =
 *   -infinity  if invariants fail OR a rule disqualifies
 *   -infinity  if the tail guard is violated (current p99 > baseline p50 + 3 × effective MAD,
 *              where effective MAD = max(baseline MAD, floorCoefficient × baseline p50))
 *   0          if Δ% < Δ_min (2.5% minimum significance — insignificant noise)
 *   Σ_i w_i · Δ%_i − Σ_j P_j                                   [otherwise]
 * ```
 *
 * Pure function vs Effect channel (documented asymmetry):
 * - `computeFitnessVerdict` is a PURE, TOTAL function: it never throws and
 *   represents hard rejects with a `-Infinity` score sentinel plus a
 *   structured `rejected` reason. #15's EvaluationPipeline consumes it to
 *   build rich `StepEvaluation` objects.
 * - `evaluateFitness` is the Effect wrapper: it maps every non-acceptance to
 *   the corresponding tagged error (InvariantFailureError,
 *   DisqualificationError, TailGuardRegressionError, InsignificantDeltaError)
 *   so callers can `Effect.catchTag` on a typed channel. A significant,
 *   tail-safe step whose score is ≤ 0 also fails here
 *   (InsignificantDeltaError, score-channel semantics) because from the
 *   Effect caller's perspective any unaccepted step is a rejection.
 *
 * Policy decisions (hardening, ticket #14):
 * - Significance: `metrics[0]` is the primary metric; a step is significant
 *   iff its finite Δ% ≥ Δ_min. Negative Δ% (a regression) is below Δ_min and
 *   is therefore insignificant. Multi-metric significance aggregation is
 *   deferred to #15.
 * - Penalties: only `"penalize"` violations (and undefined action — the
 *   default action is penalize) contribute penalties; any `"disqualify"`
 *   violation rejects with -Infinity immediately, regardless of its penalty
 *   value (0 or undefined). Non-finite or negative penalties sanitize to 0
 *   with a recorded note.
 * - Weight normalization: raw `.perfgym.yaml` weights are normalized to sum
 *   1 inside this module so scores stay comparable across configs (see
 *   `normalizeWeights`). When `weights={}` (or no keys match a metric), the
 *   documented fallback is default weight 1 per metric. Partial weights mean
 *   unlisted metrics carry weight 0.
 * - Measurement hygiene: a non-finite `deltaPercent` is a measurement error —
 *   score 0, significant false, accepted false (reason `invalid-metric`); the
 *   Effect wrapper surfaces it as InsignificantDeltaError (score-0 channel).
 * - Tail guard edge cases: missing baseline or current distribution ⇒ the
 *   guard is not applicable and `tailGuardPassed` is true. A MAD = 0 baseline
 *   is constant, so the ceiling would collapse onto p50; a non-zero floor
 *   (#52) keeps the ceiling at p50 + 3 × (1% of p50) by default, so only a
 *   p99 beyond that floored ceiling is a tail regression. `tailGuardPassed`
 *   is false only when the guard itself breached the ceiling — rejections
 *   earlier in the pipeline leave it true.
 */

export const DEFAULT_MIN_SIGNIFICANCE_DELTA = 2.5;

/**
 * Resolve the effective MAD of the tail guard (#52): `max(MAD, floorCoefficient × |p50|)`,
 * so a constant (MAD = 0) baseline keeps a tolerance band instead of collapsing
 * the ceiling onto p50. Shared by `computeFitnessVerdict` (the enforcement) and
 * the formatter's `tailGuardOf` (the report) so both always agree; the floor
 * touches the ceiling only — never the significance threshold or the score.
 */
export function effectiveTailMad(
  baseline: Pick<BenchmarkDistribution, "mad" | "p50">,
  floorCoefficient?: number
): number {
  const coefficient =
    floorCoefficient === undefined || !Number.isFinite(floorCoefficient)
      ? DEFAULT_TAIL_MAD_FLOOR_COEFFICIENT
      : Math.max(0, floorCoefficient);
  // |p50| keeps the floor a positive relative tolerance band: a negative
  // median would make `coefficient × p50` negative and collapse effectiveMAD
  // straight back onto MAD, defeating the floor.
  return Math.max(baseline.mad, coefficient * Math.abs(baseline.p50));
}

/**
 * Relative MAD floor of the tail guard (#52): with N≈5 samples of an integer
 * CPU loop, MAD is frequently 0, which collapses the ceiling onto p50 and
 * makes one jittery p99 outlier reject every legitimate step.
 * `effectiveMAD = max(MAD, floorCoefficient × p50)` keeps a 1%-of-p50
 * tolerance band. The floor applies ONLY to the tail-guard ceiling — never
 * to the significance threshold or the fitness score — so it cannot mask a
 * real regression.
 */
export const DEFAULT_TAIL_MAD_FLOOR_COEFFICIENT = 0.01;

export type FitnessRejectionReason =
  | "invariants"
  | "disqualification"
  | "tail-guard"
  | "insignificant-delta"
  | "invalid-metric";

export interface FitnessRejection {
  readonly reason: FitnessRejectionReason;
  readonly message: string;
}

/** Pure, total verdict of the canonical fitness calculus (never throws). */
export interface FitnessVerdict {
  /**
   * -Infinity sentinel for hard rejects (invariants, disqualification,
   * tail guard), 0 for insignificant/measurement-error deltas, otherwise
   * Σ w·Δ% − Σ P. Always finite on the "otherwise" branch (non-finite
   * results collapse to the `invalid-metric` branch).
   */
  readonly score: number;
  readonly accepted: boolean;
  readonly isSignificant: boolean;
  /** False only when the tail guard itself breached its ceiling. */
  readonly tailGuardPassed: boolean;
  readonly rejected?: FitnessRejection;
  /** Human-readable notes: sanitization decisions and rejection causes. */
  readonly reasons: readonly string[];
  readonly minSignificanceDelta: number;
  readonly primaryDeltaPercent?: number;
  /**
   * For goal="minimize", the high-tail ceiling: baseline p50 + 3 × effective MAD.
   * For goal="maximize", the low-tail floor: baseline p50 - 3 × effective MAD.
   * effective MAD = max(baseline MAD, floorCoefficient × baseline p50) (#52).
   */
  readonly tailGuardCeiling?: number;
  /**
   * For goal="minimize", current.p99.
   * For goal="maximize", current.min (the worst low-tail sample; distribution has min, no p1).
   */
  readonly currentP99?: number;
  readonly baselineMad?: number;
  readonly normalizedWeights: Readonly<Record<string, number>>;
  readonly totalPenalty: number;
}

export interface FitnessParams {
  readonly invariants: InvariantResult;
  readonly violations: readonly LintViolation[];
  readonly metrics: readonly MetricResult[];
  readonly baseline?: BenchmarkDistribution;
  readonly current?: BenchmarkDistribution;
  readonly minSignificanceDelta?: number;
  readonly weights?: Record<string, number>;
  /**
   * Optimization goal for the primary metric ("minimize" | "maximize").
   * Default: "minimize".
   * - "minimize": rejects when current.p99 > baseline.p50 + 3 × effective MAD
   * - "maximize": rejects when current.min < baseline.p50 - 3 × effective MAD
   * (effective MAD = max(baseline MAD, floorCoefficient × baseline p50))
   */
  readonly primaryGoal?: "minimize" | "maximize";
  /**
   * Relative MAD floor for the tail-guard ceiling (default 0.01 = 1% of
   * baseline p50): effectiveMAD = max(MAD, floorCoefficient × p50), so a
   * constant (MAD = 0) baseline keeps a tolerance band instead of
   * collapsing the ceiling onto p50. Applies ONLY to the ceiling — the
   * significance threshold and the fitness score are untouched.
   */
  readonly floorCoefficient?: number;
}

// ============================================================================
// Weight normalization
// ============================================================================

export interface WeightResolution {
  readonly normalized: Readonly<Record<string, number>>;
  readonly notes: readonly string[];
}

/**
 * Resolve and normalize configured weights against the measured metric names.
 *
 * - No entry for any metric (counts `weights={}` and mistyped keys) ⇒ the
 *   documented default-1-per-metric fallback, un-normalized.
 * - Entries present: every metric WITHOUT an entry gets weight 0 (partial
 *   weights are total weights); entries are sanitized (non-finite/negative →
 *   0 with a note) and then normalized so the finite, in-use weights sum to 1.
 * - If every entry sanitizes to 0, fall back to the default-1-per-metric
 *   fallback with a note instead of scoring everything 0.
 */
export function normalizeWeights(
  metricNames: readonly string[],
  weights?: Record<string, number>
): WeightResolution {
  const notes: string[] = [];
  const explicit: Record<string, number> = {};
  let hasMatchedEntry = false;

  for (const name of metricNames) {
    const raw = weights?.[name];
    if (raw === undefined) continue;
    hasMatchedEntry = true;
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      notes.push(`Weight for metric "${name}" is not a finite number; sanitized to 0`);
      explicit[name] = 0;
    } else if (raw < 0) {
      notes.push(`Weight for metric "${name}" is negative (${raw}); sanitized to 0`);
      explicit[name] = 0;
    } else {
      explicit[name] = raw;
    }
  }

  if (!hasMatchedEntry) {
    // Documented fallback: current default-1-per-metric behavior, un-normalized.
    const fallback: Record<string, number> = {};
    for (const name of metricNames) fallback[name] = 1;
    return { normalized: fallback, notes };
  }

  let sum = 0;
  for (const name of metricNames) {
    const value = explicit[name] ?? 0;
    if (explicit[name] === undefined) {
      notes.push(`Metric "${name}" has no configured weight; weight 0 assigned`);
    }
    sum += value;
  }

  const normalized: Record<string, number> = {};
  if (!Number.isFinite(sum) || sum <= 0) {
    notes.push(
      "All configured weights sanitized to zero; falling back to the default weight 1 per metric"
    );
    for (const name of metricNames) normalized[name] = 1;
    return { normalized, notes };
  }

  for (const name of metricNames) {
    normalized[name] = (explicit[name] ?? 0) / sum;
  }
  return { normalized, notes };
}

// ============================================================================
// Penalty aggregation
// ============================================================================

interface PenaltyResolution {
  readonly total: number;
  readonly notes: readonly string[];
}

/**
 * Σ P over all penalize contributions. Disqualify violations contribute
 * nothing here (they are handled by the disqualification gate, which fires
 * regardless of penalty value). Undefined action defaults to penalize.
 * Non-finite or negative penalties sanitize to 0 with a note.
 */
function sumPenalties(violations: readonly LintViolation[]): PenaltyResolution {
  const notes: string[] = [];
  let total = 0;
  for (const v of violations) {
    const action = v.action ?? "penalize";
    if (action === "disqualify") continue;
    const penalty = typeof v.penalty === "number" && Number.isFinite(v.penalty) ? v.penalty : 0;
    if (penalty !== v.penalty) {
      notes.push(`Penalty for rule "${v.ruleId}" is not a finite number; sanitized to 0`);
      continue;
    }
    if (penalty < 0) {
      notes.push(`Penalty for rule "${v.ruleId}" is negative (${penalty}); sanitized to 0`);
      continue;
    }
    total += penalty;
  }
  return { total, notes };
}

// ============================================================================
// Pure total verdict
// ============================================================================

interface VerdictBase
  extends Omit<FitnessVerdict, "minSignificanceDelta" | "normalizedWeights"> {}

/**
 * The pure mathematical fitness verdict. Branch order is fixed:
 * 1. invariant gate (-Infinity) → 2. disqualification gate (-Infinity) →
 * 3. tail guard (-Infinity) → 4. measurement hygiene (score 0) →
 * 5. significance gate (score 0) → 6. weighted-delta-minus-penalty math.
 * Never throws.
 */
export function computeFitnessVerdict(params: FitnessParams): FitnessVerdict {
  const thresholdConfigured = params.minSignificanceDelta;
  const minThreshold =
    thresholdConfigured === undefined || !Number.isFinite(thresholdConfigured)
      ? DEFAULT_MIN_SIGNIFICANCE_DELTA
      : Math.max(0, thresholdConfigured);

  const weightResolution = normalizeWeights(
    params.metrics.map((m) => m.name),
    params.weights
  );

  const finish = (base: Omit<VerdictBase, "minSignificanceDelta" | "normalizedWeights">): FitnessVerdict => ({
    ...base,
    minSignificanceDelta: minThreshold,
    normalizedWeights: weightResolution.normalized,
  });

  // 1. Invariant gate — correctness precedes speed.
  if (!params.invariants.passed) {
    return finish({
      score: -Infinity,
      accepted: false,
      isSignificant: false,
      tailGuardPassed: true, // never reached; the guard itself did not breach
      rejected: {
        reason: "invariants",
        message: `Invariants failed: ${params.invariants.output}`,
      },
      reasons: weightResolution.notes,
      totalPenalty: 0,
    });
  }

  // 2. Anti-cheat disqualification gate — wins over any delta or penalty.
  const disqualifier = params.violations.find((v) => v.action === "disqualify");
  if (disqualifier !== undefined) {
    return finish({
      score: -Infinity,
      accepted: false,
      isSignificant: false,
      tailGuardPassed: true,
      rejected: {
        reason: "disqualification",
        message: `Disqualified by rule "${disqualifier.ruleId}" (${disqualifier.file}:${disqualifier.line}): ${disqualifier.message}`,
      },
      reasons: weightResolution.notes,
      totalPenalty: 0,
    });
  }

  // 3. Tail guard — depends on primaryGoal:
  // - "minimize" (latency/size): rejects when current p99 > baseline p50 + 3 × effective MAD.
  // - "maximize" (throughput/ops): rejects when current min < baseline p50 - 3 × effective MAD.
  // effective MAD = max(baseline MAD, floorCoefficient × baseline p50) (#52): a
  // MAD = 0 baseline would otherwise collapse the ceiling onto p50 and reject
  // every jittery-but-legitimate step. The floor touches the ceiling only.
  // Note on maximize: benchmark distribution exposes min (not p1); min is used as the worst
  // low-tail sample.
  const baseline = params.baseline;
  const current = params.current;
  const primaryGoal = params.primaryGoal ?? "minimize";
  let tailGuardPassed = true;
  let ceiling: number | undefined;
  let currentP99: number | undefined;
  if (baseline !== undefined && current !== undefined) {
    // |p50| keeps the floor positive for a negative median (see helper).
    const effectiveMAD = effectiveTailMad(baseline, params.floorCoefficient);
    if (primaryGoal === "maximize") {
      ceiling = baseline.p50 - 3 * effectiveMAD;
      currentP99 = current.min;
      // Non-finite distribution statistics (ceiling/floor or min): the check cannot
      // be applied, so it does not fail (tailGuardPassed stays true).
      if (
        Number.isFinite(ceiling) &&
        Number.isFinite(currentP99) &&
        currentP99 < ceiling
      ) {
        tailGuardPassed = false;
        return finish({
          score: -Infinity,
          accepted: false,
          isSignificant: false,
          tailGuardPassed,
          rejected: {
            reason: "tail-guard",
            message: `Tail degraded: current min (${currentP99}) fell below floor (${ceiling.toFixed(
              2
            )}) = baseline p50 (${baseline.p50}) - 3 × effective MAD (${effectiveMAD})`,
          },
          reasons: weightResolution.notes,
          totalPenalty: 0,
          tailGuardCeiling: ceiling,
          currentP99,
          baselineMad: baseline.mad,
        });
      }
    } else {
      ceiling = baseline.p50 + 3 * effectiveMAD;
      currentP99 = current.p99;
      // Non-finite distribution statistics (ceiling or p99): the check cannot
      // be applied, so it does not fail (tailGuardPassed stays true).
      if (
        Number.isFinite(ceiling) &&
        Number.isFinite(currentP99) &&
        currentP99 > ceiling
      ) {
        tailGuardPassed = false;
        return finish({
          score: -Infinity,
          accepted: false,
          isSignificant: false,
          tailGuardPassed,
          rejected: {
            reason: "tail-guard",
            message: `Tail degraded: current p99 (${currentP99}) exceeded ceiling (${ceiling.toFixed(
              2
            )}) = baseline p50 (${baseline.p50}) + 3 × effective MAD (${effectiveMAD})`,
          },
          reasons: weightResolution.notes,
          totalPenalty: 0,
          tailGuardCeiling: ceiling,
          currentP99,
          baselineMad: baseline.mad,
        });
      }
    }
  }
  const penaltyResolution = sumPenalties(params.violations);
  const reasons = [...weightResolution.notes, ...penaltyResolution.notes];

  // 4. Measurement hygiene — non-finite Δ% is a measurement error.
  const invalidMetric = params.metrics.find(
    (m) => typeof m.deltaPercent !== "number" || !Number.isFinite(m.deltaPercent)
  );
  if (invalidMetric !== undefined) {
    return finish({
      score: 0,
      accepted: false,
      isSignificant: false,
      tailGuardPassed,
      rejected: {
        reason: "invalid-metric",
        message: `Metric "${invalidMetric.name}" produced a non-finite deltaPercent (${String(
          invalidMetric.deltaPercent
        )}) — measurement error, step rejected`,
      },
      reasons,
      totalPenalty: penaltyResolution.total,
    });
  }

  // 5. Significance gate — Δ% below Δ_min is measurement noise.
  //    The primary metric is metrics[0]; multi-metric aggregation is deferred
  //    to the EvaluationPipeline (ticket #15).
  const primaryMetric: MetricResult | undefined = params.metrics[0];
  if (primaryMetric === undefined) {
    return finish({
      score: 0,
      accepted: false,
      isSignificant: false,
      tailGuardPassed,
      rejected: {
        reason: "invalid-metric",
        message: "No metric results produced — nothing was measured",
      },
      reasons,
      totalPenalty: penaltyResolution.total,
    });
  }

  const primaryDelta = primaryMetric.deltaPercent;
  const isSignificant = primaryDelta >= minThreshold;
  if (!isSignificant) {
    return finish({
      score: 0,
      accepted: false,
      isSignificant,
      tailGuardPassed,
      rejected: {
        reason: "insignificant-delta",
        message: `Delta ${primaryDelta.toFixed(
          2
        )}% is below the minimum significance threshold (${minThreshold}%) — treated as measurement noise`,
      },
      reasons,
      totalPenalty: penaltyResolution.total,
      primaryDeltaPercent: primaryDelta,
      tailGuardCeiling: ceiling,
      currentP99,
      baselineMad: baseline?.mad,
    });
  }

  // 6. Score mathematics: Σ w·Δ% − Σ P. A non-finite aggregate is a
  //    measurement error, not a score.
  let perfScore = 0;
  for (const m of params.metrics) {
    perfScore += (weightResolution.normalized[m.name] ?? 1) * m.deltaPercent;
  }
  const score = perfScore - penaltyResolution.total;

  if (!Number.isFinite(score)) {
    return finish({
      score: 0,
      accepted: false,
      isSignificant,
      tailGuardPassed,
      rejected: {
        reason: "invalid-metric",
        message: "Non-finite fitness score — measurement error",
      },
      reasons: [...reasons, "Non-finite fitness score; treated as a measurement error"],
      totalPenalty: penaltyResolution.total,
      primaryDeltaPercent: primaryDelta,
      tailGuardCeiling: ceiling,
      currentP99,
      baselineMad: baseline?.mad,
    });
  }

  const accepted = score > 0 && isSignificant && tailGuardPassed;
  if (!accepted && score <= 0) {
    reasons.push(`Unprofitable step: fitness score ${score.toFixed(2)} is not > 0`);
  }

  return finish({
    score,
    accepted,
    isSignificant,
    tailGuardPassed,
    reasons,
    totalPenalty: penaltyResolution.total,
    primaryDeltaPercent: primaryDelta,
    tailGuardCeiling: ceiling,
    currentP99,
    baselineMad: baseline?.mad,
  });
}

// ============================================================================
// Canonical pure score (public API, moved here from index.ts)
// ============================================================================

/**
 * Pure mathematical calculation of the fitness score:
 * `Score = Σ weight · Δ% − Σ linter penalties`.
 *
 * Weights are normalized (see `normalizeWeights`) so raw `.perfgym.yaml`
 * weights sum to 1; when `weights={}` the documented default-1-per-metric
 * fallback applies. Only penalize violations (or undefined action) are
 * deducted; non-finite metrics/penalties are sanitized. Hard rejects are NOT
 * modelled here — use `computeFitnessVerdict`/`evaluateFitness` for the full
 * branch calculus.
 */
export function calculateFitnessScore(
  metrics: readonly MetricResult[],
  violations: readonly LintViolation[],
  weights: Record<string, number> = {}
): number {
  const weightResolution = normalizeWeights(
    metrics.map((m) => m.name),
    weights
  );
  let perfScore = 0;
  for (const m of metrics) {
    if (typeof m.deltaPercent !== "number" || !Number.isFinite(m.deltaPercent)) continue;
    perfScore += (weightResolution.normalized[m.name] ?? 1) * m.deltaPercent;
  }
  return perfScore - sumPenalties(violations).total;
}

// ============================================================================
// Effect wrapper: sentinels → typed channel
// ============================================================================

/**
 * Effect 4 fitness evaluation: runs the same canonical calculus as
 * `computeFitnessVerdict` but fails with the corresponding tagged error
 * instead of -Infinity/0 sentinels, so callers can `Effect.catchTag`:
 *
 * - InvariantFailureError        (invariants branch)
 * - DisqualificationError        (disqualification branch)
 * - TailGuardRegressionError     (tail-guard branch)
 * - InsignificantDeltaError      (insignificance AND measurement-error
 *                                branches — the shared score-0 channel)
 *
 * A significant, tail-safe step whose score is ≤ 0 also fails with
 * InsignificantDeltaError: from the Effect caller's perspective an
 * unaccepted step is a rejection.
 */
export const evaluateFitness = (params: FitnessParams): Effect.Effect<
  number,
  | InvariantFailureError
  | DisqualificationError
  | TailGuardRegressionError
  | InsignificantDeltaError
> =>
  Effect.gen(function* () {
    const verdict = computeFitnessVerdict(params);
    if (verdict.accepted) return verdict.score;

    const reason = verdict.rejected?.reason;
    switch (reason) {
      case "invariants": {
        return yield* Effect.fail(
          new InvariantFailureError({
            command: "invariants",
            exitCode: 1,
            stdout: params.invariants.output,
            stderr: "",
            retriesUsed: params.invariants.retriesUsed ?? 0,
            message: verdict.rejected?.message ?? "Invariants failed",
          })
        );
      }
      case "disqualification": {
        const disqualifier = params.violations.find((v) => v.action === "disqualify");
        return yield* Effect.fail(
          new DisqualificationError({
            ruleId: disqualifier?.ruleId ?? "unknown",
            file: disqualifier?.file ?? "",
            line: disqualifier?.line ?? -1,
            message: verdict.rejected?.message ?? "Disqualified by anti-cheating rules",
          })
        );
      }
      case "tail-guard": {
        return yield* Effect.fail(
          new TailGuardRegressionError({
            metric: params.metrics[0]?.name ?? params.baseline?.unit ?? "unknown",
            currentP99: verdict.currentP99 ?? Number.NaN,
            maxAllowedCeiling: verdict.tailGuardCeiling ?? Number.NaN,
            baselineMad: verdict.baselineMad ?? Number.NaN,
            message: verdict.rejected?.message ?? "Tail guard regression",
          })
        );
      }
      case "invalid-metric": {
        return yield* Effect.fail(
          new InsignificantDeltaError({
            deltaPercent: Number.NaN,
            minSignificanceThreshold: verdict.minSignificanceDelta,
            message: verdict.rejected?.message ?? "Fitness measurement error",
          })
        );
      }
      default: {
        // insignificant-delta, or accepted=false because score ≤ 0: both are
        // unaccepted due to the primary metric's Δ%/score — the shared
        // InsignificantDeltaError channel.
        const delta = verdict.primaryDeltaPercent ?? params.metrics[0]?.deltaPercent ?? 0;
        return yield* Effect.fail(
          new InsignificantDeltaError({
            deltaPercent: Number.isFinite(delta) ? delta : Number.NaN,
            minSignificanceThreshold: verdict.minSignificanceDelta,
            message:
              verdict.rejected?.message ??
              `Significant but unprofitable: fitness score ${verdict.score} is not > 0`,
          })
        );
      }
    }
  });

/**
 * Stable public alias — `evaluateFitnessEffect` was the original export name
 * in `index.ts` (Effect 4 fitness, ticket Effect 4 gate chain). Kept for API
 * stability; it is the exact same computation as `evaluateFitness`.
 */
export const evaluateFitnessEffect = evaluateFitness;
