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

  /**
   * The flush hook of Ticket #46 — invoked with the fresh state after every
   * transition, so a caller can write the state through to a durable file.
   * Setting it mid-session works exactly like passing it to the constructor.
   */
  public setFlushHook(hook: SessionFlushHook | null): void {
    this.flushHook = hook;
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

  public reset(runId = ""): void {
    this.apply(() => ({
      ...initialSessionState,
      runId,
    }));
  }
}
