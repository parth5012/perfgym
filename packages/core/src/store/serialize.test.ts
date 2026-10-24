import { describe, expect, it } from "vitest";
import {
  deserializeSessionState,
  initialSessionState,
  serializeSessionState,
  type PerfGymSessionState,
} from "../index.js";

const lockedState: PerfGymSessionState = {
  ...initialSessionState,
  runId: "run-42",
  baseRef: "main",
  status: "accepted",
  currentStep: 3,
  bestScore: 30,
  bestStep: 2,
  history: [
    {
      iteration: 1,
      fitnessScore: -Infinity, // rejected step — must survive the roundtrip
      accepted: false,
      isSignificant: false,
      deltaPercent: -50,
      invariants: { passed: true, output: "ok", durationMs: 4 },
      violations: [],
      metrics: [{ name: "latency", value: 150, unit: "ms", improved: false, deltaPercent: -50 }],
      executionTimeMs: 12,
    },
    {
      iteration: 2,
      fitnessScore: 30,
      accepted: true,
      isSignificant: true,
      deltaPercent: 50,
      invariants: { passed: true, output: "ok", durationMs: 4 },
      violations: [],
      metrics: [{ name: "latency", value: 50, unit: "ms", improved: true, deltaPercent: 50 }],
      executionTimeMs: 12,
      rolledBack: true,
    },
  ],
  lock: { pid: 4242, runId: "run-42", startTime: 100, heartbeat: 200 },
  lastError: null,
  lastUpdatedAt: 999,
};

describe("session serialization bridge (Ticket #48)", () => {
  it("serializes into JSON-safe values and roundtrips back", () => {
    const serialized = JSON.parse(JSON.stringify(serializeSessionState(lockedState))) as
      Record<string, unknown>;

    // A non-finite best score must not turn into `null` on the way out...
    // but a REJECTED step's -Infinity score MUST (JSON has no Infinity).
    expect(serialized.bestScore).toBe(30);
    const history = serialized.history as Array<Record<string, unknown>>;
    expect(history[0].fitnessScore).toBe(null);
    expect(history[1].fitnessScore).toBe(30);

    const restored = deserializeSessionState(serialized);
    expect(restored).not.toBeNull();
    expect(restored?.bestScore).toBe(30);
    expect(restored?.history[0].fitnessScore).toBe(-Infinity);
    expect(restored?.history[1].fitnessScore).toBe(30);
    expect(restored?.history[1].rolledBack).toBe(true);
    expect(restored?.lock?.pid).toBe(4242);
    expect(restored?.status).toBe("accepted");
    expect(restored?.lastUpdatedAt).toBe(999);
  });

  it("deserializes a null best score as -Infinity (fresh session roundtrip)", () => {
    const restored = deserializeSessionState(
      JSON.parse(JSON.stringify(serializeSessionState(initialSessionState))),
    );
    expect(restored).not.toBeNull();
    expect(restored?.bestScore).toBe(-Infinity);
    expect(restored?.bestStep).toBeNull();
  });

  it("returns null for absent, primitive or non-object blobs", () => {
    expect(deserializeSessionState(null)).toBeNull();
    expect(deserializeSessionState(undefined)).toBeNull();
    expect(deserializeSessionState("session")).toBeNull();
    expect(deserializeSessionState([1, 2, 3])).toBeNull();
  });

  it("does not accept garbage history entries", () => {
    const restored = deserializeSessionState({
      ...serializeSessionState(initialSessionState),
      history: [{ iteration: 1 }, "garbage", 42, null],
    });
    // The malformed candidate entry keeps... nothing: every entry here lacks
    // the required evaluation shape except the first (which has iteration but
    // is not a full evaluation) — the deserializer must never fabricate one.
    expect(restored?.history.length).toBe(0);
  });
});
