import { describe, expect, it } from "vitest";
import {
  SessionStore,
  type BenchmarkDistribution,
  type PerfGymSessionState,
  type StepEvaluation,
} from "../index.js";

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

const stepEvaluation = (iteration: number, accepted: boolean): StepEvaluation => ({
  iteration,
  fitnessScore: accepted ? 18.5 : -Infinity,
  accepted,
  isSignificant: true,
  deltaPercent: accepted ? 23.5 : -5.0,
  invariants: { passed: true, output: "ok", durationMs: 40 },
  violations: [],
  metrics: [
    { name: "latency", value: 8.0, unit: "ms", improved: accepted, deltaPercent: 23.5 },
  ],
  executionTimeMs: 100,
});

describe("SessionStore write-through extensions (Ticket #46)", () => {
  it("stamps lastUpdatedAt and fires the flush hook on every transition", () => {
    const snapshots: PerfGymSessionState[] = [];
    let clock = 42;

    const store = new SessionStore({ runId: "run-1" }, {
      onTransition: (state) => snapshots.push(state),
      now: () => clock,
    });

    store.setStatus("baselining");
    clock = 43;
    store.setBaseline(mockBaseline);
    clock = 44;
    store.setLock({ pid: 1, runId: "run-1", startTime: 1, heartbeat: 1 });
    store.recordStep(stepEvaluation(1, true));

    expect(snapshots.length).toBe(4);
    expect(snapshots[0].lastUpdatedAt).toBe(42);
    expect(snapshots[1].lastUpdatedAt).toBe(43);
    expect(snapshots[2].lastUpdatedAt).toBe(44);
    expect(snapshots[3].lastUpdatedAt).toBe(44);
    expect(store.getState().lastUpdatedAt).toBeGreaterThan(0);
  });

  it("marks a rolled-back step in history without dropping any step", () => {
    let clock = 10;
    const store = new SessionStore({ runId: "run-2" }, { now: () => clock++ });

    store.recordStep(stepEvaluation(1, true));
    store.recordStep(stepEvaluation(2, false));
    store.markStepRolledBack(1);

    const state = store.getState();
    expect(state.history.length).toBe(2); // history stays truthful
    expect(state.history[0].rolledBack).toBe(true);
    expect(state.history[1].rolledBack).toBeUndefined();
    expect(state.status).toBe("rolled_back");
  });

  it("rolls back every step from the target onward (cascade marker)", () => {
    const store = new SessionStore({ runId: "run-3" });
    store.recordStep(stepEvaluation(1, true));
    store.recordStep(stepEvaluation(2, true));
    store.recordStep(stepEvaluation(3, true));

    store.markStepsRolledBackFrom(2);

    const state = store.getState();
    expect(state.history.map((h) => h.rolledBack)).toEqual([      undefined,
      true,
      true,
    ]);
  });
});
