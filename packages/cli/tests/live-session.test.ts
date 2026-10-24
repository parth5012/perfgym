import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  LiveSession,
  createLiveSession,
  liveSessionFor,
  reflectSessionLock,
} from "../src/live-session.js";
import { saveSession, loadSession } from "../src/engine.js";
import { serializeSessionState, initialSessionState } from "../../core/src/index.js";
import type { StepEvaluation } from "../../core/src/index.js";

const stepEvaluation = (iteration: number, accepted: boolean, score: number): StepEvaluation => ({
  iteration,
  fitnessScore: accepted ? score : -Infinity,
  accepted,
  isSignificant: accepted,
  deltaPercent: accepted ? score : -5,
  invariants: { passed: true, output: "ok", durationMs: 40 },
  violations: [],
  metrics: [{ name: "latency", value: 8, unit: "ms", improved: accepted, deltaPercent: accepted ? score : -5 }],
  executionTimeMs: 100,
});

const statePath = (dir: string): string => path.join(dir, ".perfgym", "state.json");

const readFileState = (dir: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(statePath(dir), "utf8")) as Record<string, unknown>;

describe("LiveSession wiring (Ticket #48)", () => {
  let dir: string;

  const seedLegacy = (): void => {
    saveSession(dir, {
      version: "1.0",
      initializedAt: 1,
      updatedAt: 2,
      targetName: "live-session",
      baselineMetrics: { latency: 100 },
      invariantsPassed: true,
      bestFitnessScore: 4, // hill-climb best of a previous run
      acceptedStepCount: 1,
      totalStepCount: 1,
      bestStep: 1,
    });
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(tmpdir(), "perfgym-live-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("seeds the store from the durable blob and the legacy hill-climb best", () => {
    seedLegacy();
    const fresh = createLiveSession(dir);
    fresh.recordStep(stepEvaluation(2, true, 10));

    // A NEW instance simulates a second process: it must unlock the same
    // live-session context from the durable artifact.
    const second = new LiveSession(dir);
    const state = second.state;
    expect(state.history).toHaveLength(1);
    expect(state.history[0].iteration).toBe(2);
    expect(state.bestScore).toBe(10);
    expect(state.currentStep).toBe(2);
  });

  it("seeds the cross-run best from the legacy file when no blob exists", () => {
    seedLegacy();
    const live = createLiveSession(dir);
    expect(live.state.bestScore).toBe(4);
    expect(live.state.bestStep).toBe(1);
  });

  it("flushes the durable file on every transition (write-through)", () => {
    seedLegacy();
    const live = liveSessionFor(dir);

    live.setStatus("mutating");
    expect((readFileState(dir).session as Record<string, unknown>).status).toBe("mutating");

    live.recordStep(stepEvaluation(1, true, 15));
    const doc = readFileState(dir);
    const session = doc.session as Record<string, unknown>;
    expect(session.status).toBe("accepted");
    expect(session.bestScore).toBe(15);
    expect(session.bestStep).toBe(1);
    expect((session.history as unknown[]).length).toBe(1);
    // The flush always stamps how stale the snapshot is.
    expect(doc.lastUpdatedAt).toBeGreaterThan(0);
  });

  it("shares ONE store per project root (the cached instance)", () => {
    seedLegacy();
    expect(liveSessionFor(dir)).toBe(liveSessionFor(dir));
    expect(liveSessionFor(dir)).not.toBe(createLiveSession(dir));
  });

  it("beginRun resets the history and carries the cross-run best forward", () => {
    seedLegacy();
    const live = liveSessionFor(dir);
    live.recordStep(stepEvaluation(1, true, 3));
    expect(live.state.history).toHaveLength(1);

    live.beginRun("run-2", "main", { pid: 1, runId: "run-2", startTime: 1, heartbeat: 1 });
    const state = live.state;
    expect(state.runId).toBe("run-2");
    expect(state.baseRef).toBe("main");
    expect(state.history).toHaveLength(0);
    expect(state.currentStep).toBe(0);
    // The hill climb continues where the last run left off.
    expect(state.bestScore).toBe(4);
    expect(state.lock?.runId).toBe("run-2");
  });

  it("writes the serialized blob through the durable file and loadSession ignores it", () => {
    seedLegacy();
    const live = createLiveSession(dir);
    live.recordStep(stepEvaluation(1, false, -5)); // rejected step → -Infinity score

    const legacy = loadSession(dir);
    const onDisk = readFileState(dir).session as Record<string, unknown>;
    expect(legacy).not.toBeNull();
    // Rejected steps serialize -Infinity scores as null — verifiable JSON.
    expect((onDisk.history as Array<Record<string, unknown>>)[0].fitnessScore).toBe(null);
    // The live blob never leaks into the legacy shape's fields.
    expect(legacy?.session).toBeDefined();
    expect(serializeSessionState({
      ...initialSessionState,
      ...live.state,
    }).status).toBe("rejected");
  });

  it("serializes the already-acquired lock and clears it on release", () => {
    seedLegacy();
    const live = createLiveSession(dir);
    live.setLock({ pid: 4311, runId: "run-x", startTime: 1, heartbeat: 2 });
    expect(((readFileState(dir).session as Record<string, unknown>).lock as { pid: number }).pid).toBe(4311);

    live.setLock(null);
    expect((readFileState(dir).session as Record<string, unknown>).lock).toBeNull();
  });

  it("ignores a store that is not of a real session (no fabricated state files)", () => {
    // No legacy state exists — a live flush must not fabricate a session file.
    const live = createLiveSession(dir);
    live.recordStep(stepEvaluation(1, true, 5));
    expect(fs.existsSync(statePath(dir))).toBe(false);
  });

  it("reflects the REAL lockfile: holder metadata when held, never a guessed lock (S2)", () => {
    const lockDir = path.join(dir, ".perfgym", ".lock.d");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "metadata.json"),
      JSON.stringify({ pid: 4311, runId: "run-x", startTime: 1, heartbeat: Date.now() }),
      "utf8",
    );

    // A genuinely held lock serializes its holder — read from disk, not assumed.
    expect(reflectSessionLock(lockDir, true, 30_000)).toMatchObject({
      pid: 4311,
      runId: "run-x",
    });

    // A lock not held by this process (and with no metadata at all) serializes
    // to null: a snapshot must never claim a lock that does not exist.
    expect(reflectSessionLock(path.join(dir, "no-such-lock-dir"), false, 30_000)).toBeNull();
  });

  it("keeps the cached instance while the durable blob is unchanged (CR5a)", () => {
    seedLegacy();
    const first = liveSessionFor(dir);
    expect(liveSessionFor(dir)).toBe(first);
    // This instance's OWN flushes must not trigger a spurious refresh.
    first.setLock(null);
    expect(liveSessionFor(dir)).toBe(first);
  });

  it("re-reads from disk when another process wrote a newer blob — its history survives (CR5b)", () => {
    seedLegacy();
    const cached = liveSessionFor(dir);
    cached.recordStep(stepEvaluation(1, true, 10)); // history H1, flushed
    expect(liveSessionFor(dir)).toBe(cached);

    // Simulate a SECOND process (a CLI `perfgym run`): it writes its own newer
    // blob (history H2) straight into the durable file, outside this
    // process's live-session module (acceptance-criteria-2 pattern).
    const doc = JSON.parse(fs.readFileSync(statePath(dir), "utf8")) as Record<string, unknown>;
    const outsider = serializeSessionState({
      ...initialSessionState,
      runId: "run-x",
      status: "accepted",
      currentStep: 2,
      history: [stepEvaluation(2, true, 6)],
      bestScore: 6,
      bestStep: 2,
    }) as unknown as Record<string, unknown>;
    doc.session = { ...outsider, lastUpdatedAt: Date.now() + 5_000 };
    fs.writeFileSync(statePath(dir), JSON.stringify(doc), "utf8");

    // The cache is now stale: liveSessionFor must discard it and re-read.
    const refreshed = liveSessionFor(dir);
    expect(refreshed).not.toBe(cached);
    expect(refreshed.state.history.map((entry) => entry.iteration)).toEqual([2]);

    // The NEXT flush persists H2 (plus the new step) — never a reset to H1.
    refreshed.recordStep(stepEvaluation(3, true, 8));
    const flushedSession = (readFileState(dir).session ?? {}) as {
      history?: Array<{ iteration: number }>;
    };
    expect(flushedSession.history?.map((entry) => entry.iteration)).toEqual([2, 3]);
  });
});
