import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  DisqualificationError,
  InsignificantDeltaError,
  InvariantFailureError,
  TailGuardRegressionError,
} from "../errors.js";
import {
  DEFAULT_MIN_SIGNIFICANCE_DELTA,
  calculateFitnessScore,
  computeFitnessVerdict,
  evaluateFitness,
  evaluateFitnessEffect,
  normalizeWeights,
} from "./fitness.js";
import type { BenchmarkDistribution, InvariantResult, LintViolation, MetricResult } from "../index.js";

// ============================================================================
// Fixtures
// ============================================================================

const metric = (name: string, deltaPercent: number): MetricResult => ({
  name,
  value: 100,
  unit: "count",
  improved: deltaPercent > 0,
  deltaPercent,
});

const violation = (overrides: Partial<LintViolation> = {}): LintViolation => ({
  ruleId: "r1",
  message: "forbidden pattern",
  file: "src/calc.ts",
  line: 1,
  severity: "warning",
  penalty: 5,
  ...overrides,
});

const passedInvariants: InvariantResult = {
  passed: true,
  output: "All 12 tests passed",
  durationMs: 45,
};

const failedInvariants: InvariantResult = {
  passed: false,
  output: "AssertionError: expected 4 to equal 5",
  durationMs: 40,
};

/** Constant distribution: p50 = 10 with the given MAD. */
const dist = (p50: number, mad: number, p99 = p50): BenchmarkDistribution => ({
  samples: [p50, p50, p50, p50, p50],
  p50,
  p90: p50,
  p95: p50,
  p99,
  min: p50,
  max: p50,
  stddev: 0,
  mad,
  iqr: 0,
  sampleCount: 5,
  unit: "count",
});

// ============================================================================
// Hard rejects: -Infinity sentinels
// ============================================================================

describe("computeFitnessVerdict — hard rejects (-Infinity sentinels)", () => {
  it("scores -Infinity when invariants fail, even with a huge positive delta", () => {
    const verdict = computeFitnessVerdict({
      invariants: failedInvariants,
      violations: [],
      metrics: [metric("cpu", 1000)],
    });

    expect(verdict.score).toBe(-Infinity);
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejected?.reason).toBe("invariants");
    expect(verdict.rejected?.message).toContain("AssertionError");
  });

  it("scores -Infinity when a disqualify rule fires, even with a huge delta and penalties", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [
        violation({ ruleId: "no-ts-ignore", action: "disqualify", penalty: 100 }),
        violation({ ruleId: "minor", action: "penalize", penalty: 3 }),
      ],
      metrics: [metric("cpu", 1000)],
    });

    expect(verdict.score).toBe(-Infinity);
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejected?.reason).toBe("disqualification");
  });

  it("disqualification wins even when the disqualify penalty is 0 or undefined", () => {
    for (const penalty of [0, undefined]) {
      const verdict = computeFitnessVerdict({
        invariants: passedInvariants,
        violations: [violation({ action: "disqualify", penalty })],
        metrics: [metric("cpu", 10)],
      });

      expect(verdict.score).toBe(-Infinity);
      expect(verdict.rejected?.reason).toBe("disqualification");
    }
  });

  it("scores -Infinity when current p99 breaches the 3×MAD ceiling", () => {
    const baseline = dist(10.5, 0.5); // ceiling = 10.5 + 3*0.5 = 12.0
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("latency", 14.2)],
      baseline,
      current: { ...baseline, p50: 9.0, p99: 15.0 },
    });

    expect(verdict.score).toBe(-Infinity);
    expect(verdict.accepted).toBe(false);
    expect(verdict.tailGuardPassed).toBe(false);
    expect(verdict.rejected?.reason).toBe("tail-guard");
    expect(verdict.tailGuardCeiling).toBe(12.0);
    expect(verdict.currentP99).toBe(15.0);
  });
});

// ============================================================================
// Tail guard edge cases
// ============================================================================

describe("computeFitnessVerdict — tail guard edge cases", () => {
  it("passes when p99 is strictly below the ceiling", () => {
    const baseline = dist(10.5, 0.5);
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("latency", 5)],
      baseline,
      current: { ...baseline, p50: 9.0, p99: 11.9 },
    });

    expect(verdict.tailGuardPassed).toBe(true);
    expect(verdict.rejected).toBeUndefined();
  });

  it("rejects a p99 above the floored ceiling for a MAD=0 (constant) baseline", () => {
    const baseline = dist(10, 0); // floored ceiling is p50 + 3 × 1% × p50 = 10.3
    const above = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("latency", 1)],
      baseline,
      current: { ...baseline, p50: 9.5, p99: 10.5 },
    });
    expect(above.tailGuardPassed).toBe(false);
    expect(above.rejected?.reason).toBe("tail-guard");

    // A p99 below the floored ceiling passes (comparison is strict `>`).
    const withinCeiling = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("latency", 1)],
      baseline,
      current: { ...baseline, p50: 9.5, p99: 10 },
    });
    expect(withinCeiling.tailGuardPassed).toBe(true);
  });

  it("treats the tail guard as not applicable (passed) when a distribution is missing", () => {
    for (const sparse of [
      { invariants: passedInvariants, violations: [], metrics: [metric("cpu", 5)] },
      {
        invariants: passedInvariants,
        violations: [],
        metrics: [metric("cpu", 5)],
        baseline: dist(10, 1),
      },
      {
        invariants: passedInvariants,
        violations: [],
        metrics: [metric("cpu", 5)],
        current: dist(10, 1),
      },
    ] as const) {
      const verdict = computeFitnessVerdict(sparse);
      expect(verdict.tailGuardPassed).toBe(true);
    }
  });

  it("passes tail guard when baseline MAD is non-finite", () => {
    const baseline = { ...dist(10, 0), mad: Number.NaN };
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("latency", 5)],
      baseline,
      current: { ...dist(10, 0), p50: 9, p99: 999 },
    });
    expect(verdict.tailGuardPassed).toBe(true);
  });

  it("for goal maximize: accepts when current.min does not fall below baseline.p50 - 3*MAD", () => {
    // baseline: p50 1000, mad 10 -> floor = 1000 - 30 = 970
    const baseline: BenchmarkDistribution = {
      ...dist(1000, 10),
      min: 980,
    };
    // current: throughput win, everything high, min = 975 (> 970)
    const current: BenchmarkDistribution = {
      ...dist(1500, 5),
      min: 975,
    };
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("ops", 50)],
      baseline,
      current,
      primaryGoal: "maximize",
    });

    expect(verdict.tailGuardPassed).toBe(true);
    expect(verdict.accepted).toBe(true);
    expect(verdict.score).toBe(50);
  });

  it("for goal maximize: rejects with -Infinity when current.min falls below baseline.p50 - 3*MAD", () => {
    // baseline: p50 1000, mad 10 -> floor = 970
    const baseline: BenchmarkDistribution = {
      ...dist(1000, 10),
      min: 980,
    };
    // current: throughput win on p50, but min = 960 (< 970)
    const current: BenchmarkDistribution = {
      ...dist(1500, 5),
      min: 960,
    };
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("ops", 50)],
      baseline,
      current,
      primaryGoal: "maximize",
    });

    expect(verdict.tailGuardPassed).toBe(false);
    expect(verdict.score).toBe(-Infinity);
    expect(verdict.rejected?.reason).toBe("tail-guard");
    expect(verdict.rejected?.message).toContain("fell below floor");
    expect(verdict.tailGuardCeiling).toBe(970);
    expect(verdict.currentP99).toBe(960);
  });
});

// ============================================================================
// Tail guard MAD floor (#52)
// ============================================================================

describe("computeFitnessVerdict — tail guard MAD floor", () => {
  it("accepts a jittery p99 within the floored ceiling when baseline samples are identical (MAD=0)", () => {
    // N=5 identical integer CPU-loop samples ⇒ MAD = 0, which used to
    // collapse the ceiling onto p50 and reject one jittery p99 outlier.
    const baseline = dist(10, 0); // samples [10, 10, 10, 10, 10]
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("latency", 5)],
      baseline,
      current: { ...baseline, samples: [9.5, 9.5, 9.5, 9.5, 10.2], p50: 9.5, p99: 10.2 },
    });

    // Floored ceiling: 10 + 3 × max(0, 0.01 × 10) = 10.3 ≥ p99 10.2.
    expect(verdict.tailGuardCeiling).toBe(10.3);
    expect(verdict.tailGuardPassed).toBe(true);
    expect(verdict.accepted).toBe(true);
    expect(verdict.score).toBe(5);
  });

  it("still rejects a genuine tail blowout for a MAD=0 baseline (the floor cannot mask a regression)", () => {
    const baseline = dist(10, 0);
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("latency", 5)],
      baseline,
      current: { ...baseline, p50: 9.5, p99: 15 }, // 50% p99 blowout
    });

    expect(verdict.score).toBe(-Infinity);
    expect(verdict.accepted).toBe(false);
    expect(verdict.tailGuardPassed).toBe(false);
    expect(verdict.rejected?.reason).toBe("tail-guard");
    // The floor lifts the ceiling by 0.3 — not far enough to swallow the blowout.
    expect(verdict.tailGuardCeiling).toBe(10.3);
  });

  it("honours a configurable floorCoefficient", () => {
    const baseline = dist(10, 0);
    const params = {
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("latency", 5)],
      baseline,
      current: { ...baseline, p50: 9.5, p99: 11 },
    };

    // Default coefficient 0.01: ceiling 10.3, p99 11.0 still breaches.
    const defaulted = computeFitnessVerdict(params);
    expect(defaulted.tailGuardCeiling).toBe(10.3);
    expect(defaulted.tailGuardPassed).toBe(false);

    // Coefficient 0.05: ceiling 10 + 3 × (0.05 × 10) = 11.5, p99 11.0 is accepted.
    const configured = computeFitnessVerdict({ ...params, floorCoefficient: 0.05 });
    expect(configured.tailGuardCeiling).toBe(11.5);
    expect(configured.tailGuardPassed).toBe(true);
    expect(configured.accepted).toBe(true);
  });

  it("keeps the floor positive for a negative baseline p50", () => {
    // A negative median would make `floorCoefficient × p50` negative and
    // collapse effectiveMAD back onto MAD; the tolerance band must stay
    // positive regardless of the median's sign.
    const baseline = dist(-10, 0);
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("latency", 3)],
      baseline,
      current: { ...baseline, p50: -10, p99: -9.8 },
    });

    expect(verdict.tailGuardCeiling).toBeCloseTo(-9.7, 10);
    expect(verdict.tailGuardPassed).toBe(true);
    expect(verdict.rejected).toBeUndefined();
  });
});

// ============================================================================
// Significance threshold
// ============================================================================

describe("computeFitnessVerdict — significance threshold", () => {
  it("rejects a +0.8% noisy gain as insignificant: score 0, not accepted", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("latency", 0.8)],
    });

    expect(verdict.score).toBe(0);
    expect(verdict.accepted).toBe(false);
    expect(verdict.isSignificant).toBe(false);
    expect(verdict.rejected?.reason).toBe("insignificant-delta");
    expect(verdict.rejected?.message).toContain("0.80");
  });

  it("accepts a delta exactly at the 2.5% threshold (score > 0)", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("cpu", 2.5)],
    });

    expect(verdict.isSignificant).toBe(true);
    expect(verdict.accepted).toBe(true);
    expect(verdict.score).toBe(2.5);
  });

  it("rejects a regression (negative delta) as insignificant", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("cpu", -30)],
    });

    expect(verdict.score).toBe(0);
    expect(verdict.accepted).toBe(false);
    expect(verdict.isSignificant).toBe(false);
    expect(verdict.rejected?.reason).toBe("insignificant-delta");
  });

  it("honours a custom minimum significance delta", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("cpu", 1.5)],
      minSignificanceDelta: 1,
    });

    expect(verdict.isSignificant).toBe(true);
    expect(verdict.score).toBe(1.5);
  });

  it("defaults the threshold to 2.5", () => {
    expect(DEFAULT_MIN_SIGNIFICANCE_DELTA).toBe(2.5);
    expect(
      computeFitnessVerdict({
        invariants: passedInvariants,
        violations: [],
        metrics: [metric("cpu", 2.4)],
      }).rejected?.reason
    ).toBe("insignificant-delta");
  });
});

// ============================================================================
// Score mathematics
// ============================================================================

describe("computeFitnessVerdict — score mathematics", () => {
  it("uses default weight 1 per metric when weights={}", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [
        violation({ ruleId: "v1", penalty: 2 }),
        violation({ ruleId: "v2", penalty: 3 }),
      ],
      metrics: [metric("cpu", 10), metric("mem", 5)],
    });

    expect(verdict.score).toBe(10); // 15 - 5
    expect(verdict.isSignificant).toBe(true);
    expect(verdict.accepted).toBe(true);
    expect(verdict.normalizedWeights).toEqual({ cpu: 1, mem: 1 });
  });

  it("sums penalties across all penalize violations", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [violation({ penalty: 2 }), violation({ penalty: 3 })],
      metrics: [metric("cpu", 10)],
    });

    expect(verdict.score).toBe(5);
    expect(verdict.totalPenalty).toBe(5);
  });

  it("treats an undefined action as a penalize violation", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [violation({ action: undefined as unknown as LintViolation["action"] })],
      metrics: [metric("cpu", 10)],
    });

    expect(verdict.score).toBe(5);
    expect(verdict.totalPenalty).toBe(5);
  });

  it("keeps significant-but-unprofitable steps unaccepted without a gate rejection", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [violation({ penalty: 20 })],
      metrics: [metric("cpu", 10)], // 10 - 20 = -10
    });

    expect(verdict.score).toBe(-10);
    expect(verdict.isSignificant).toBe(true);
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejected).toBeUndefined();
    expect(verdict.reasons.some((r) => r.includes("Unprofitable step"))).toBe(true);
  });

  it("handles exact-zero boundary: delta 5%, penalty 5 -> score 0, isSignificant true, accepted false", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [violation({ penalty: 5 })],
      metrics: [metric("cpu", 5)],
    });

    expect(verdict.score).toBe(0);
    expect(verdict.isSignificant).toBe(true);
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejected).toBeUndefined();
    expect(verdict.reasons.some((r) => r.includes("Unprofitable step: fitness score 0.00 is not > 0"))).toBe(true);
  });
});

// ============================================================================
// Weight normalization
// ============================================================================

describe("normalizeWeights", () => {
  it("normalizes raw weights to sum 1", () => {
    const { normalized, notes } = normalizeWeights(["cpu", "mem"], { cpu: 2, mem: 6 });
    expect(normalized).toEqual({ cpu: 0.25, mem: 0.75 });
    expect(notes).toEqual([]);
  });

  it("omits metrics without a configured weight (weight 0) when partial weights are given", () => {
    const { normalized } = normalizeWeights(["cpu", "mem", "io"], { cpu: 1, mem: 3 });
    expect(normalized).toEqual({ cpu: 0.25, mem: 0.75, io: 0 });
  });

  it("sanitizes non-finite weights to 0 with a note, falling back to default 1 when all zero", () => {
    const { normalized, notes } = normalizeWeights(["cpu", "mem"], {
      cpu: Number.NaN,
      mem: Infinity,
    });
    expect(normalized).toEqual({ cpu: 1, mem: 1 }); // all sanitized to zero → documented fallback
    expect(notes).toHaveLength(3); // 2 sanitization notes + 1 fallback note
    expect(notes[0]).toContain("not a finite number");
  });

  it("sanitizes negative weights to 0 with a note, falling back to default 1 when all zero", () => {
    const { normalized, notes } = normalizeWeights(["cpu"], { cpu: -3 });
    expect(normalized).toEqual({ cpu: 1 }); // sum of sanitized weights is 0 → documented fallback
    expect(notes[0]).toContain("negative");
    expect(notes.some((n) => n.includes("default weight 1 per metric"))).toBe(true);
  });

  it("falls back to default weight 1 per metric when every weight sanitizes to zero", () => {
    const { normalized, notes } = normalizeWeights(["cpu", "mem"], { cpu: 0, mem: Number.NaN });
    expect(normalized).toEqual({ cpu: 1, mem: 1 });
    expect(notes.some((n) => n.includes("default weight 1 per metric"))).toBe(true);
  });

  it("falls back to default weight 1 per metric when weights sum to Infinity (overflow)", () => {
    const { normalized, notes } = normalizeWeights(["cpu", "mem"], {
      cpu: Number.MAX_VALUE,
      mem: Number.MAX_VALUE,
    });
    expect(normalized).toEqual({ cpu: 1, mem: 1 });
    expect(notes.some((n) => n.includes("default weight 1 per metric"))).toBe(true);
  });

  it("falls back to default weight 1 per metric when weights={} (documented fallback)", () => {
    const { normalized, notes } = normalizeWeights(["cpu", "mem"]);
    expect(normalized).toEqual({ cpu: 1, mem: 1 });
    expect(notes).toEqual([]);
  });

  it("ignores config keys that match no metric name entirely", () => {
    const { normalized, notes } = normalizeWeights(["cpu"], { typo: 4 });
    expect(normalized).toEqual({ cpu: 1 }); // no matched entries → documented fallback
    expect(notes).toEqual([]);
  });
});

describe("computeFitnessVerdict — normalized weight mathematics", () => {
  it("normalizes explicit weights before scoring", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [violation({ penalty: 5 })],
      metrics: [metric("cpu", 10), metric("mem", 5)],
      weights: { cpu: 3, mem: 1 }, // → 0.75 / 0.25
    });

    expect(verdict.score).toBeCloseTo(3.75, 10); // 7.5 + 1.25 - 5
    expect(verdict.normalizedWeights).toEqual({ cpu: 0.75, mem: 0.25 });
  });
});

// ============================================================================
// Non-finite / NaN hygiene
// ============================================================================

describe("computeFitnessVerdict — non-finite hygiene", () => {
  it("rejects a non-finite deltaPercent as a measurement error (score 0)", () => {
    for (const deltaPercent of [Number.NaN, Infinity, -Infinity]) {
      const verdict = computeFitnessVerdict({
        invariants: passedInvariants,
        violations: [],
        metrics: [metric("cpu", deltaPercent)],
      });

      expect(verdict.score).toBe(0);
      expect(verdict.accepted).toBe(false);
      expect(verdict.isSignificant).toBe(false);
      expect(verdict.rejected?.reason).toBe("invalid-metric");
      expect(verdict.rejected?.message).toContain("non-finite");
    }
  });

  it("rejects a non-finite delta even when another metric is healthy", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [metric("cpu", 10), metric("mem", Number.NaN)],
    });

    expect(verdict.score).toBe(0);
    expect(verdict.rejected?.reason).toBe("invalid-metric");
  });

  it("sanitizes non-finite penalties to 0 with a recorded note", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [violation({ penalty: Number.NaN })],
      metrics: [metric("cpu", 10)],
    });

    expect(verdict.score).toBe(10);
    expect(verdict.totalPenalty).toBe(0);
    expect(verdict.reasons.some((n) => n.toLowerCase().includes("penalty"))).toBe(true);
  });

  it("rejects with no metrics produced (nothing measured)", () => {
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [],
      metrics: [],
    });

    expect(verdict.score).toBe(0);
    expect(verdict.accepted).toBe(false);
    expect(verdict.rejected?.reason).toBe("invalid-metric");
  });
});

// ============================================================================
// Accepted path end-to-end
// ============================================================================

describe("computeFitnessVerdict — accepted path", () => {
  it("accepts a significant, tail-safe, profitable step", () => {
    const baseline = dist(10.5, 0.5); // ceiling 12.0
    const verdict = computeFitnessVerdict({
      invariants: passedInvariants,
      violations: [violation({ ruleId: "minor-warning", penalty: 5 })],
      metrics: [metric("latency", 23.8)],
      baseline,
      current: { ...baseline, p50: 8.0, p99: 9.5 },
    });

    expect(verdict.tailGuardPassed).toBe(true);
    expect(verdict.isSignificant).toBe(true);
    expect(verdict.accepted).toBe(true);
    expect(verdict.score).toBe(18.8); // 23.8 - 5
    expect(verdict.rejected).toBeUndefined();
  });
});

// ============================================================================
// calculateFitnessScore (pure math re-export)
// ============================================================================

describe("calculateFitnessScore", () => {
  it("computes weighted deltas minus penalties", () => {
    expect(
      calculateFitnessScore(
        [metric("cpu", 10), metric("mem", 5)],
        [violation({ penalty: 3 })],
        {}
      )
    ).toBe(12);
  });

  it("normalizes explicit raw weights", () => {
    expect(
      calculateFitnessScore([metric("cpu", 10), metric("mem", 5)], [], { cpu: 3, mem: 1 })
    ).toBeCloseTo(8.75, 10);
  });
});

// ============================================================================
// Effect wrapper: pure sentinel ↔ typed channel mapping
// ============================================================================

describe("evaluateFitness (Effect wrapper)", () => {
  const baseline = dist(10.5, 0.5);

  it("fails with InvariantFailureError on the invariants branch", async () => {
    const result = await Effect.runPromise(
      evaluateFitness({
        invariants: failedInvariants,
        violations: [],
        metrics: [metric("cpu", 10)],
      }).pipe(
        Effect.map((score) => ({ ok: true as const, score })),
        Effect.catchTag("InvariantFailureError", (err) =>
          Effect.succeed({ ok: false as const, tag: err._tag, message: err.message })
        )
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tag).toBe("InvariantFailureError");
      expect(result.message).toContain("AssertionError");
    }
  });

  it("fails with DisqualificationError on the disqualification branch", async () => {
    const result = await Effect.runPromise(
      evaluateFitness({
        invariants: passedInvariants,
        violations: [violation({ ruleId: "no-ts-ignore", action: "disqualify" })],
        metrics: [metric("cpu", 10)],
      }).pipe(
        Effect.map((score) => ({ ok: true as const, score })),
        Effect.catchTag("DisqualificationError", (err) =>
          Effect.succeed({ ok: false as const, tag: err._tag, ruleId: err.ruleId })
        )
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tag).toBe("DisqualificationError");
      expect(result.ruleId).toBe("no-ts-ignore");
    }
  });

  it("fails with TailGuardRegressionError on the tail-guard branch", async () => {
    const result = await Effect.runPromise(
      evaluateFitness({
        invariants: passedInvariants,
        violations: [],
        metrics: [metric("latency", 14.2)],
        baseline,
        current: { ...baseline, p50: 9.0, p99: 15.0 },
      }).pipe(
        Effect.map((score) => ({ ok: true as const, score })),
        Effect.catchTag("TailGuardRegressionError", (err) =>
          Effect.succeed({
            ok: false as const,
            tag: err._tag,
            metric: err.metric,
            p99: err.currentP99,
            ceiling: err.maxAllowedCeiling,
          })
        )
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tag).toBe("TailGuardRegressionError");
      expect(result.metric).toBe("latency");
      expect(result.p99).toBe(15.0);
      expect(result.ceiling).toBe(12.0);
    }
  });

  it("fails with InsignificantDeltaError on the significance branch", async () => {
    const result = await Effect.runPromise(
      evaluateFitness({
        invariants: passedInvariants,
        violations: [],
        metrics: [metric("latency", 0.8)],
      }).pipe(
        Effect.map((score) => ({ ok: true as const, score })),
        Effect.catchTag("InsignificantDeltaError", (err) =>
          Effect.succeed({ ok: false as const, tag: err._tag, delta: err.deltaPercent })
        )
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tag).toBe("InsignificantDeltaError");
      expect(result.delta).toBe(0.8);
    }
  });

  it("fails with InsignificantDeltaError for a measurement-error metric (hygiene channel)", async () => {
    const result = await Effect.runPromise(
      evaluateFitness({
        invariants: passedInvariants,
        violations: [],
        metrics: [metric("cpu", Number.NaN)],
      }).pipe(
        Effect.map((score) => ({ ok: true as const, score })),
        Effect.catchTag("InsignificantDeltaError", (err) =>
          Effect.succeed({ ok: false as const, tag: err._tag, message: err.message })
        )
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tag).toBe("InsignificantDeltaError");
      expect(result.message).toContain("non-finite");
    }
  });

  it("fails with InsignificantDeltaError when delta is significant but penalties dominate", async () => {
    const result = await Effect.runPromise(
      evaluateFitness({
        invariants: passedInvariants,
        violations: [violation({ penalty: 20 })],
        metrics: [metric("cpu", 10)],
      }).pipe(
        Effect.map((score) => ({ ok: true as const, score })),
        Effect.catchTag("InsignificantDeltaError", (err) =>
          Effect.succeed({ ok: false as const, tag: err._tag, message: err.message })
        )
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tag).toBe("InsignificantDeltaError");
      expect(result.message).toContain("Significant but unprofitable");
    }
  });

  it("fails with InsignificantDeltaError on exact-zero boundary (delta 5%, penalty 5 -> score 0)", async () => {
    const result = await Effect.runPromise(
      evaluateFitness({
        invariants: passedInvariants,
        violations: [violation({ penalty: 5 })],
        metrics: [metric("cpu", 5)],
      }).pipe(
        Effect.map((score) => ({ ok: true as const, score })),
        Effect.catchTag("InsignificantDeltaError", (err) =>
          Effect.succeed({ ok: false as const, tag: err._tag, message: err.message })
        )
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tag).toBe("InsignificantDeltaError");
      expect(result.message).toContain("Significant but unprofitable");
    }
  });

  it("succeeds with the positive score on the accepted path", async () => {
    const score = await Effect.runPromise(
      evaluateFitness({
        invariants: passedInvariants,
        violations: [violation({ ruleId: "minor-warning", penalty: 5 })],
        metrics: [metric("latency", 23.8)],
        baseline,
        current: { ...baseline, p50: 8.0, p99: 9.5 },
      })
    );
    expect(score).toBe(18.8);
  });

  it("fails with TailGuardRegressionError when goal=maximize drops below low-tail floor", async () => {
    const baseDist = { ...dist(100, 2), min: 95 }; // floor = 100 - 6 = 94
    const result = await Effect.runPromise(
      evaluateFitness({
        invariants: passedInvariants,
        violations: [],
        metrics: [metric("ops", 20)],
        baseline: baseDist,
        current: { ...dist(120, 2), min: 90 }, // drops below floor
        primaryGoal: "maximize",
      }).pipe(
        Effect.map((score) => ({ ok: true as const, score })),
        Effect.catchTag("TailGuardRegressionError", (err) =>
          Effect.succeed({
            ok: false as const,
            tag: err._tag,
            metric: err.metric,
            p99: err.currentP99,
            ceiling: err.maxAllowedCeiling,
          })
        )
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.tag).toBe("TailGuardRegressionError");
      expect(result.p99).toBe(90);
      expect(result.ceiling).toBe(94);
    }
  });
});

describe("public API stability (index.ts delegation)", () => {
  it("exposes evaluateFitnessEffect as the stable alias of evaluateFitness", async () => {
    const score = await Effect.runPromise(
      evaluateFitnessEffect({
        invariants: passedInvariants,
        violations: [],
        metrics: [metric("latency", 23.8)],
      })
    );
    expect(score).toBe(23.8);
  });
});
