import { Store } from "@tanstack/store";
import type { BenchmarkDistribution, StepEvaluation } from "../index.js";

export type SessionStatus =
  | "idle"
  | "baselining"
  | "mutating"
  | "evaluating"
  | "accepted"
  | "rejected"
  | "completed";

export interface SessionLockState {
  readonly pid: number;
  readonly runId: string;
  readonly startTime: number;
  readonly heartbeat: number;
}

export interface PerfGymSessionState {
  readonly runId: string;
  readonly baseRef: string;
  readonly status: SessionStatus;
  readonly currentStep: number;
  readonly baseline: BenchmarkDistribution | null;
  readonly bestScore: number;
  readonly bestStep: number | null;
  readonly history: readonly StepEvaluation[];
  readonly lock: SessionLockState | null;
  readonly lastError: string | null;
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
};

export class SessionStore {
  private readonly store: Store<PerfGymSessionState>;

  constructor(initial: Partial<PerfGymSessionState> = {}) {
    this.store = new Store<PerfGymSessionState>({
      ...initialSessionState,
      ...initial,
    });
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
    this.store.setState((prev) => ({ ...prev, status }));
  }

  public setBaseline(baseline: BenchmarkDistribution): void {
    this.store.setState((prev) => ({
      ...prev,
      baseline,
      bestScore: 0,
      status: "idle",
    }));
  }

  public setLock(lock: SessionLockState | null): void {
    this.store.setState((prev) => ({ ...prev, lock }));
  }

  public recordStep(evaluation: StepEvaluation): void {
    this.store.setState((prev) => {
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

  public recordError(errorMessage: string): void {
    this.store.setState((prev) => ({
      ...prev,
      lastError: errorMessage,
    }));
  }

  public reset(runId = ""): void {
    this.store.setState(() => ({
      ...initialSessionState,
      runId,
    }));
  }
}
