import { describe, expect, it } from "vitest";
import {
  SessionStore,
  createStepHistoryTable,
  mapEvaluationsToTableRows,
  type StepEvaluation,
  type BenchmarkDistribution,
} from "../packages/core/src/index.js";

describe("TanStack Store & Table Integration", () => {
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

  it("manages session state reactively with TanStack Store", () => {
    const store = new SessionStore({ runId: "run-test-101" });
    const states: string[] = [];

    const unsubscribe = store.subscribe((state) => {
      states.push(`${state.status}:${state.currentStep}`);
    });

    store.setStatus("baselining");
    store.setBaseline(mockBaseline);

    const step1: StepEvaluation = {
      iteration: 1,
      fitnessScore: 18.5,
      accepted: true,
      isSignificant: true,
      deltaPercent: 23.5,
      invariants: { passed: true, output: "ok", durationMs: 40 },
      violations: [
        {
          ruleId: "warning-1",
          file: "src/a.ts",
          line: 5,
          message: "nit",
          severity: "warning",
          penalty: 5,
        },
      ],
      metrics: [{ name: "latency", value: 8.0, unit: "ms", improved: true, deltaPercent: 23.5 }],
      executionTimeMs: 120,
    };

    store.recordStep(step1);

    const state = store.getState();
    expect(state.bestScore).toBe(18.5);
    expect(state.bestStep).toBe(1);
    expect(state.history.length).toBe(1);
    expect(state.status).toBe("accepted");

    unsubscribe();
    store.setStatus("completed");
    // After unsubscribe, listener is not called
    expect(states[states.length - 1]).toBe("accepted:1");
  });

  it("builds table rows and TanStack Table model for step history", () => {
    const evaluations: StepEvaluation[] = [
      {
        iteration: 1,
        fitnessScore: 18.5,
        accepted: true,
        isSignificant: true,
        deltaPercent: 23.5,
        invariants: { passed: true, output: "ok", durationMs: 40 },
        violations: [],
        metrics: [{ name: "latency", value: 8.0, unit: "ms", improved: true, deltaPercent: 23.5 }],
        executionTimeMs: 100,
      },
      {
        iteration: 2,
        fitnessScore: -10,
        accepted: false,
        isSignificant: false,
        deltaPercent: -5.0,
        invariants: { passed: true, output: "ok", durationMs: 38 },
        violations: [
          {
            ruleId: "disqualify-bad",
            file: "src/b.ts",
            line: 10,
            message: "Cheating",
            severity: "error",
            penalty: 100,
          },
        ],
        metrics: [{ name: "latency", value: 11.0, unit: "ms", improved: false, deltaPercent: -5.0 }],
        executionTimeMs: 95,
      },
    ];

    const rows = mapEvaluationsToTableRows(evaluations);
    expect(rows.length).toBe(2);
    expect(rows[0].status).toBe("ACCEPTED");
    expect(rows[0].score).toBe("18.50");
    expect(rows[0].deltaPercent).toBe("+23.5%");

    expect(rows[1].status).toBe("DISQUALIFIED");

    const table = createStepHistoryTable(evaluations);
    expect(table.getCoreRowModel().rows.length).toBe(2);
  });
});
