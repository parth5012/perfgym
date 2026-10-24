/**
 * LiveSession — Ticket #48.
 *
 * The TanStack `SessionStore` (@perfgym/core) is THE live session state of a
 * run; `.perfgym/state.json` is the durable cross-process artifact that
 * `perfgym status` (or the MCP server) in another terminal reads. This module
 * is the fusion the run loop and every coordinator handler flow through:
 *
 * - Every status transition (`setStatus`, `recordStep`,
 *   `markStepRolledBack`, `reconcileBest`, `setLock`, …) happens through the
 *   SessionStore's write-through methods.
 * - The store's flush hook serializes the fresh state and persists it as the
 *   `session` blob of the state file via `saveLiveSession` (atomic,
 *   merge-on-flush, `lastUpdatedAt` stamped by the file store).
 * - The legacy `PerfGymState` shape stays the artifact for counters, metrics
 *   and the coordinator's rich history — written through `saveSession` with
 *   `legacyStateCopy`, never carrying or regressing the blob.
 * - Lock plumbing (P2 of #46): the ALREADY-ACQUIRED sandbox lock metadata is
 *   serialized reflectively at acquire (and cleared at release). No new
 *   locking protocol — the session lock stays the single authority.
 *
 * One store instance per project root per process (`liveSessionFor`), so the
 * CLI run loop, the coordinator handlers, and tests all share the same live
 * state path. The cache is drift-checked (CR5 of the #48 review): another
 * process may flush a newer durable blob in between calls; a mismatch
 * between the disk blob's `lastUpdatedAt` and the stamp this instance last
 * observed discards the cache and re-reads the disk — the fresh instance
 * never fabricates a state file (a live flush writes nothing into an absent
 * store; the baseline's `saveSession` owns creation, CR3).
 */

import {
  SessionStore,
  deserializeSessionState,
  type BenchmarkDistribution,
  type PerfGymSessionState,
  type SessionLockState,
  type SessionStatus,
  serializeSessionState,
  type StepEvaluation,
} from "../../core/src/index.js";
import {
  loadSession,
  saveLiveSession,
} from "./engine.js";
import { inspectLockState, type LockStateReport } from "./coordinator/handlers.js";

/**
 * The serialized lock metadata of the ALREADY-ACQUIRED sandbox lock (P2).
 * `inspectLockState` reads the lock metadata reflectively — it never
 * acquires or releases anything.
 */
export const toSessionLock = (report: LockStateReport): SessionLockState | null =>
  report.locked && report.pid !== null && report.runId !== null
    ? {
        pid: report.pid,
        runId: report.runId,
        startTime: report.startTime ?? Date.now(),
        heartbeat: report.heartbeat ?? Date.now(),
      }
    : null;

/**
 * The ONE reflective lock snapshot (Ticket #48 review S1/S2), shared by the
 * run loop and every coordinator handler: it reads the metadata of the
 * sandbox lock AS IT ACTUALLY IS — `isHeld` is the process's real holder
 * state (e.g. `sandbox.isLocked()`), never a guessed `true` — so a snapshot
 * can never claim a lock that does not exist.
 */
export const reflectSessionLock = (
  lockDir: string,
  isHeld: boolean,
  staleThresholdMs?: number,
): SessionLockState | null => toSessionLock(inspectLockState(lockDir, isHeld, staleThresholdMs));

export class LiveSession {
  public readonly store: SessionStore;
  public readonly rootDir: string;
  /**
   * CR5 (review of #48/PR83): the durable blob's `lastUpdatedAt` as this
   * instance has OBSERVED it — the disk value read at construction, then the
   * value of every blob this instance actually flushed. `liveSessionFor`
   * compares it against the current disk value to detect another process's
   * writes (drift, in both directions) and refreshes instead of clobbering.
   */
  private observedBlobStamp: number | null;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
    const legacy = loadSession(rootDir);
    const blob = legacy?.session ? deserializeSessionState(legacy.session) : null;
    this.observedBlobStamp = blob?.lastUpdatedAt ?? null;

    // The hill-climb best continues across runs: seed from the previous live
    // session when one exists, else (or as bound) from the legacy best.
    const legacyBest = legacy?.bestFitnessScore ?? -Infinity;
    const bestScore = Math.max(blob?.bestScore ?? -Infinity, legacyBest);
    const bestStep =
      (blob?.bestScore ?? -Infinity) >= legacyBest ? (blob?.bestStep ?? null) : (legacy?.bestStep ?? null);
    this.store = new SessionStore(
      {
        runId: blob?.runId ?? "",
        baseRef: blob?.baseRef ?? "HEAD",
        status: blob?.status ?? "idle",
        currentStep: blob?.currentStep ?? 0,
        bestScore: Number.isFinite(bestScore) ? bestScore : -Infinity,
        bestStep,
        history: blob?.history ?? [],
        lock: blob?.lock ?? null,
        lastError: blob?.lastError ?? null,
      },
      {
        // The write-through flush hook: EVERY transition lands in the
        // durable file (via the shared merge-on-flush store), which is what
        // makes `perfgym status` in another process see the run in progress.
        // The observe-stamp advances ONLY when the blob was actually
        // persisted — a skipped flush (absent store) leaves the disk blob
        // (and the stamp) untouched.
        onTransition: (state) => {
          const serialized = serializeSessionState(state);
          if (saveLiveSession(rootDir, serialized)) {
            this.observedBlobStamp = serialized.lastUpdatedAt;
          }
        },
      },
    );
  }

  /** The live session state (the TanStack Store is the source of truth). */
  public get state(): PerfGymSessionState {
    return this.store.getState();
  }

  /** The run-begin transition: fresh history, continuing hill-climb best. */
  public beginRun(runId: string, baseRef: string, lock?: SessionLockState | null): void {
    this.store.beginRun(runId, baseRef, lock ?? null, {
      bestScore: this.state.bestScore,
      bestStep: this.state.bestStep,
    });
  }

  public setStatus(status: SessionStatus): void {
    this.store.setStatus(status);
  }

  public setLock(lock: SessionLockState | null): void {
    this.store.setLock(lock);
  }

  public recordStep(evaluation: StepEvaluation): void {
    this.store.recordStep(evaluation);
  }

  public markStepRolledBack(iteration: number): void {
    this.store.markStepRolledBack(iteration);
  }

  public markStepsRolledBackFrom(iteration: number): void {
    this.store.markStepsRolledBackFrom(iteration);
  }

  public reconcileBest(): void {
    this.store.reconcileBest();
  }

  /** The baseline transition: the hill-climb best resets to the measured baseline. */
  public setBaseline(baseline: BenchmarkDistribution): void {
    this.store.setBaseline(baseline);
  }

  public recordError(message: string): void {
    this.store.recordError(message);
  }

  /** The recorded durable blob stamp, for the drift check in `liveSessionFor`. */
  public get syncedBlobStamp(): number | null {
    return this.observedBlobStamp;
  }
}

/** One live session per project root for the lifetime of the process. */
const liveSessions = new Map<string, LiveSession>();

/** A FRESH instance that re-reads the durable file — the "other process". */
export const createLiveSession = (rootDir: string): LiveSession => new LiveSession(rootDir);

/**
 * The durable blob's `lastUpdatedAt` on disk right now — `null` when no
 * session blob exists (absent file or legacy-only state).
 */
const diskBlobStamp = (rootDir: string): number | null => {
  const legacy = loadSession(rootDir);
  const blob = legacy?.session ? deserializeSessionState(legacy.session) : null;
  return blob?.lastUpdatedAt ?? null;
};

/**
 * The process-wide live session for a project root. Returns the cached
 * instance while its durable-blob stamp is in sync with the disk (including
 * when both are absent); on ANY drift — another process flushed a newer
 * blob, an older one, or removed it — discards the cache and returns a
 * fresh instance re-read from disk (which never fabricates a file).
 */
export const liveSessionFor = (rootDir: string): LiveSession => {
  // CR5 (review of #48/PR83): a long-lived process (perfgym-mcp) may hold one
  // cached LiveSession forever, while a CLI run in ANOTHER process flushes a
  // newer durable blob in between calls; the cached instance's next flush
  // would replace the whole `session` blob and lose that history. Drift is
  // detected against the stamp this instance last observed (constructor read
  // or its own flush): ANY mismatch — newer, older, or no blob at all —
  // discards the cache and re-reads the disk. Equal stamps (including both
  // sides absent) keep the cached instance. The replacement is a plain
  // constructor read: it never fabricates a state file (CR3).
  const cached = liveSessions.get(rootDir);
  if (cached && diskBlobStamp(rootDir) === cached.syncedBlobStamp) {
    return cached;
  }
  const created = new LiveSession(rootDir);
  liveSessions.set(rootDir, created);
  return created;
};
