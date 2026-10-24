import { Store } from "@tanstack/store";
import type { BenchmarkDistribution, StepEvaluation } from "../index.js";

export type SessionStatus =
  | "idle"
  | "baselining"
  | "mutating"
  | "evaluating"
  | "accepted"
  | "rejected"
  | "rolled_back"
  | "completed";

export interface SessionLockState {
  readonly pid: number;
  readonly runId: string;
  readonly startTime: number;
  readonly heartbeat: number;
}

/**
 * A step history entry in the live session state: the evaluation itself plus
 * the rollback marker of Ticket #46. A rolled-back step KEEPS its entry in the
 * history (it happened) but carries `rolledBack: true` so the history stays
 * truthful instead of claiming the step is still applied.
 */
export interface SessionHistoryEntry extends StepEvaluation {
  /** Set when the step (and any step built on top of it) was rolled back. */
  readonly rolledBack?: boolean;
}

export interface PerfGymSessionState {
  readonly runId: string;
  readonly baseRef: string;
  readonly status: SessionStatus;
  readonly currentStep: number;
  readonly baseline: BenchmarkDistribution | null;
  readonly bestScore: number;
  readonly bestStep: number | null;
  readonly history: readonly SessionHistoryEntry[];
  readonly lock: SessionLockState | null;
  readonly lastError: string | null;
  /**
   * Epoch milliseconds of the latest state transition (#46): readers can tell
   * how stale a snapshot is without diffing anything.
   */
  readonly lastUpdatedAt: number;
}

export const initialSessionState: PerfGymSessionState = {
  runId: "",
  baseRef: "HEAD",
  status: "idle",
  currentStep: 0,
  baseline: null,
  bestScore: -Infinity,
  bestStep: null,
  history: [],
  lock: null,
  lastError: null,
  lastUpdatedAt: 0,
};

// ============================================================================
// Serialization bridge (Ticket #48)
//
// `PerfGymSessionState` is the live in-process session and the JSON in
// `.perfgym/state.json` is the durable cross-process artifact. The two meet
// here: `serializeSessionState` turns the live state into JSON-safe values
// (no `-Infinity` — JSON has no Infinity, non-finite scores serialize as
// `null`), and `deserializeSessionState` turns a stored blob back into a live
// session, restoring the `-Infinity` "no best yet" semantics. The bridge is
// defensive: a malformed blob deserializes as "no live session" instead of
// poisoning a reader.
// ============================================================================

/** A session-state view safe to embed into the JSON session file. */
export interface SerializedSessionState {
  readonly runId: string;
  readonly baseRef: string;
  readonly status: SessionStatus;
  readonly currentStep: number;
  readonly baseline: BenchmarkDistribution | null;
  readonly bestScore: number | null;
  readonly bestStep: number | null;
  readonly history: readonly (Omit<SessionHistoryEntry, "fitnessScore"> & {
    readonly fitnessScore: number | null;
  })[];
  readonly lock: SessionLockState | null;
  readonly lastError: string | null;
  readonly lastUpdatedAt: number;
}

const finiteOrNull = (value: number): number | null =>
  Number.isFinite(value) ? value : null;

const finiteOrNegativeInfinity = (raw: unknown): number =>
  typeof raw === "number" && Number.isFinite(raw) ? raw : -Infinity;

export function serializeSessionState(
  state: PerfGymSessionState,
): SerializedSessionState {
  return {
    runId: state.runId,
    baseRef: state.baseRef,
    status: state.status,
    currentStep: state.currentStep,
    baseline: state.baseline,
    bestScore: finiteOrNull(state.bestScore),
    bestStep: state.bestStep,
    history: state.history.map((entry) => ({
      ...entry,
      fitnessScore: finiteOrNull(entry.fitnessScore),
    })),
    lock: state.lock,
    lastError: state.lastError,
    lastUpdatedAt: state.lastUpdatedAt,
  };
}

export function deserializeSessionState(
  raw: unknown,
): PerfGymSessionState | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return null;

  const record = raw as Record<string, unknown>;
  const historyRaw = record.history;
  const history: SessionHistoryEntry[] = Array.isArray(historyRaw)
    ? (historyRaw.filter(
        (entry): entry is Record<string, unknown> & StepEvaluation =>
          entry !== null &&
          typeof entry === "object" &&
          typeof (entry as Record<string, unknown>).iteration === "number" &&
          typeof (entry as Record<string, unknown>).accepted === "boolean",
      ) as SessionHistoryEntry[]).map((entry) => ({
        ...entry,
        fitnessScore: finiteOrNegativeInfinity(entry.fitnessScore),
      }))
    : [];

  const asStatus = (value: unknown): SessionStatus =>
    value === "idle" ||
    value === "baselining" ||
    value === "mutating" ||
    value === "evaluating" ||
    value === "accepted" ||
    value === "rejected" ||
    value === "rolled_back" ||
    value === "completed"
      ? value
      : "idle";

  return {
    runId: typeof record.runId === "string" ? record.runId : "",
    baseRef: typeof record.baseRef === "string" ? record.baseRef : "HEAD",
    status: asStatus(record.status),
    currentStep:
      typeof record.currentStep === "number" ? record.currentStep : 0,
    baseline:
      record.baseline !== null && typeof record.baseline === "object" && !Array.isArray(record.baseline)
        ? (record.baseline as BenchmarkDistribution)
        : null,
    bestScore: finiteOrNegativeInfinity(record.bestScore),
    bestStep: typeof record.bestStep === "number" ? record.bestStep : null,
    history,
    lock:
      record.lock !== null &&
      typeof record.lock === "object" &&
      typeof (record.lock as Record<string, unknown>).pid === "number" &&
      typeof (record.lock as Record<string, unknown>).runId === "string"
        ? (record.lock as SessionLockState)
        : null,
    lastError: typeof record.lastError === "string" ? record.lastError : null,
    lastUpdatedAt:
      typeof record.lastUpdatedAt === "number" ? record.lastUpdatedAt : 0,
  };
}

/** The write-through flush hook: fired with the fresh state after every transition. */
export type SessionFlushHook = (state: PerfGymSessionState) => void;

export interface SessionStoreHooks {
  /** Called after EVERY state mutation with the new state (the flush hook). */
  onTransition?: SessionFlushHook;
  /** Injectable clock for `lastUpdatedAt`. */
  now?: () => number;
}

export class SessionStore {
  private readonly store: Store<PerfGymSessionState>;
  private flushHook: SessionFlushHook | null = null;
  private readonly clock: () => number;

  constructor(initial: Partial<PerfGymSessionState> = {}, hooks: SessionStoreHooks = {}) {
    this.store = new Store<PerfGymSessionState>({
      ...initialSessionState,
      ...initial,
    });
    this.clock = hooks.now ?? (() => Date.now());
    this.flushHook = hooks.onTransition ?? null;
  }

  private apply(updater: (prev: PerfGymSessionState) => PerfGymSessionState): void {
    this.store.setState((prev) => ({
      ...updater(prev),
      lastUpdatedAt: this.clock(),
    }));
    if (this.flushHook !== null) {
      this.flushHook(this.store.state);
    }
  }

  public getState(): PerfGymSessionState {
    return this.store.state;
  }

  public subscribe(listener: (state: PerfGymSessionState) => void): () => void {
    const sub = this.store.subscribe(listener);
    return () => {
      if (typeof sub === "function") {
        (sub as any)();
      } else if (sub && typeof (sub as any).unsubscribe === "function") {
        (sub as any).unsubscribe();
      }
    };
  }

  public setStatus(status: SessionStatus): void {
    this.apply((prev) => ({ ...prev, status }));
  }

  public setBaseline(baseline: BenchmarkDistribution): void {
    this.apply((prev) => ({
      ...prev,
      baseline,
      bestScore: 0,
      status: "idle",
    }));
  }

  public setLock(lock: SessionLockState | null): void {
    this.apply((prev) => ({ ...prev, lock }));
  }

  public recordStep(evaluation: StepEvaluation): void {
    this.apply((prev) => {
      const isNewBest = evaluation.accepted && evaluation.fitnessScore > prev.bestScore;
      return {
        ...prev,
        currentStep: evaluation.iteration,
        status: evaluation.accepted ? "accepted" : "rejected",
        bestScore: isNewBest ? evaluation.fitnessScore : prev.bestScore,
        bestStep: isNewBest ? evaluation.iteration : prev.bestStep,
        history: [...prev.history, evaluation],
      };
    });
  }

  /**
   * The ROLLED_BACK step status of Ticket #46: the evaluated step KEEPS its
   * place in the history, but is marked so the history no longer claims the
   * mutation is applied. The session status moves to `rolled_back`.
   */
  public markStepRolledBack(iteration: number): void {
    this.apply((prev) => ({
      ...prev,
      status: "rolled_back",
      history: prev.history.map((entry) =>
        entry.iteration === iteration ? { ...entry, rolledBack: true } : entry
      ),
    }));
  }

  /**
   * The ROLLED_BACK cascade (#46): rolling back step N invalidates every
   * step built on top of it, so every accepted step from `iteration` onward
   * gets the marker too.
   */
  public markStepsRolledBackFrom(iteration: number): void {
    this.apply((prev) => ({
      ...prev,
      status: "rolled_back",
      history: prev.history.map((entry) =>
        entry.iteration >= iteration && entry.rolledBack !== true
          ? { ...entry, rolledBack: true }
          : entry
      ),
    }));
  }

  public recordError(errorMessage: string): void {
    this.apply((prev) => ({
      ...prev,
      lastError: errorMessage,
    }));
  }

  /**
   * The run-begin transition of Ticket #48: a fresh session context
   * (history, pointer and error cleared) seeded with the hill-climb best the
   * previous run achieved and the ALREADY-ACQUIRED lock metadata (reflective
   * serialization — never a new locking protocol).
   */
  public beginRun(
    runId: string,
    baseRef: string,
    lock: SessionLockState | null = null,
    best: { bestScore: number; bestStep: number | null } = {
      bestScore: -Infinity,
      bestStep: null,
    },
  ): void {
    this.apply(() => ({
      ...initialSessionState,
      runId,
      baseRef,
      status: "mutating",
      lock,
      bestScore: best.bestScore,
      bestStep: best.bestStep,
    }));
  }

  /**
   * Ticket #48: recompute the best from the history that still APPLIES (the
   * non-rolled-back accepted steps) — used after a rollback rewound the
   * workspace, so the live best never claims undone work.
   */
  public reconcileBest(): void {
    this.apply((prev) => {
      let bestScore = -Infinity;
      let bestStep: number | null = null;
      for (const entry of prev.history) {
        if (entry.accepted && entry.rolledBack !== true && entry.fitnessScore > bestScore) {
          bestScore = entry.fitnessScore;
          bestStep = entry.iteration;
        }
      }
      return { ...prev, bestScore, bestStep };
    });
  }
}
