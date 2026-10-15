import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  evaluateFitnessEffect,
  type BenchmarkDistribution,
  type InvariantResult,
  type MetricResult,
} from "../packages/core/src/index.js";

describe("Effect 4.0 Typesafety & Exception Handling", () => {
  const mockBaseline: BenchmarkDistribution = {
    samples: [10, 11, 10.5, 12, 10.2],
    p50: 10.5,
    p90: 11.8,
    p95: 12.0,
    p99: 12.0,
    min: 10.0,
    max: 12.0,
    stddev: 0.8,
    mad: 0.5,
    iqr: 1.0,
    sampleCount: 5,
    unit: "ms",
  };

  it("yields typed InvariantFailureError when invariants fail", async () => {
    const failedInvariants: InvariantResult = {
      passed: false,
      output: "AssertionError: expected 4 to equal 5",
      durationMs: 40,
    };

    const effect = evaluateFitnessEffect({
      invariants: failedInvariants,
      violations: [],
      metrics: [],
    });

    const result = await Effect.runPromise(
      effect.pipe(
        Effect.map((score) => ({ ok: true as const, score })),
        Effect.catchTag("InvariantFailureError", (err) =>
          Effect.succeed({
            ok: false as const,
            errorType: "InvariantFailureError" as const,
            message: err.message,
          })
        )
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe("InvariantFailureError");
      expect(result.message).toContain("AssertionError");
    }
  });

  it("yields typed DisqualificationError when anti-cheating rule matches", async () => {
    const passedInvariants: InvariantResult = {
      passed: true,
      output: "All 12 tests passed",
      durationMs: 45,
    };

    const effect = evaluateFitnessEffect({
      invariants: passedInvariants,
      violations: [
        {
          ruleId: "no-ts-ignore",
          file: "src/calc.ts",
          line: 14,
          message: "Forbidden @ts-ignore",
          severity: "error",
          penalty: 100,
          action: "disqualify",
        },
      ],
      metrics: [],
    });

    const result = await Effect.runPromise(
      effect.pipe(
        Effect.map((score) => ({ ok: true as const, score })),
        Effect.catchTag("DisqualificationError", (err) =>
          Effect.succeed({
            ok: false as const,
            errorType: "DisqualificationError" as const,
            rule: err.ruleId,
          })
        )
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe("DisqualificationError");
      expect(result.rule).toBe("no-ts-ignore");
    }
  });

  it("yields typed TailGuardRegressionError when p99 exceeds 3*MAD ceiling", async () => {
    const passedInvariants: InvariantResult = {
      passed: true,
      output: "All tests passed",
      durationMs: 50,
    };

    const currentDist: BenchmarkDistribution = {
      ...mockBaseline,
      p50: 9.0, // improved p50
      p99: 15.0, // but blown out tail (ceiling = 10.5 + 3*0.5 = 12.0)
    };

    const effect = evaluateFitnessEffect({
      invariants: passedInvariants,
      violations: [],
      metrics: [{ name: "latency", value: 9.0, unit: "ms", improved: true, deltaPercent: 14.2 }],
      baseline: mockBaseline,
      current: currentDist,
    });

    const result = await Effect.runPromise(
      effect.pipe(
        Effect.map((score) => ({ ok: true as const, score })),
        Effect.catchTag("TailGuardRegressionError", (err) =>
          Effect.succeed({
            ok: false as const,
            errorType: "TailGuardRegressionError" as const,
            currentP99: err.currentP99,
          })
        )
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe("TailGuardRegressionError");
      expect(result.currentP99).toBe(15.0);
    }
  });

  it("yields typed InsignificantDeltaError when gain is < 2.5%", async () => {
    const passedInvariants: InvariantResult = {
      passed: true,
      output: "All tests passed",
      durationMs: 50,
    };

    const effect = evaluateFitnessEffect({
      invariants: passedInvariants,
      violations: [],
      metrics: [{ name: "latency", value: 10.4, unit: "ms", improved: true, deltaPercent: 0.95 }],
      minSignificanceDelta: 2.5,
    });

    const result = await Effect.runPromise(
      effect.pipe(
        Effect.map((score) => ({ ok: true as const, score })),
        Effect.catchTag("InsignificantDeltaError", (err) =>
          Effect.succeed({
            ok: false as const,
            errorType: "InsignificantDeltaError" as const,
            delta: err.deltaPercent,
          })
        )
      )
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorType).toBe("InsignificantDeltaError");
      expect(result.delta).toBe(0.95);
    }
  });

  it("succeeds with positive score for significant, valid optimization", async () => {
    const passedInvariants: InvariantResult = {
      passed: true,
      output: "All tests passed",
      durationMs: 50,
    };

    const validCurrentDist: BenchmarkDistribution = {
      ...mockBaseline,
      p50: 8.0,
      p99: 9.5, // well under 12.0 ceiling
    };

    const metrics: MetricResult[] = [
      { name: "latency", value: 8.0, unit: "ms", improved: true, deltaPercent: 23.8 },
    ];

    const effect = evaluateFitnessEffect({
      invariants: passedInvariants,
      violations: [
        {
          ruleId: "minor-warning",
          file: "src/calc.ts",
          line: 22,
          message: "Unnecessary variable declaration",
          severity: "warning",
          penalty: 5,
          action: "penalize",
        },
      ],
      metrics,
      baseline: mockBaseline,
      current: validCurrentDist,
      minSignificanceDelta: 2.5,
    });

    const score = await Effect.runPromise(effect);
    expect(score).toBe(18.8); // 23.8 - 5.0
  });
});
