/**
 * McpServerCoordinator Handlers & Domain Types
 * Ticket #43 — Shared coordinator deep module between CLI and MCP Server.
 * All handlers return structured domain objects (NEVER formatted strings).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { BenchmarkDistribution, LintViolation, MetricResult, MutationFile, NegativeMemoryEntry, LlmUsage } from "../../../core/src/index.js";
import type { AstRule } from "../../../linter/src/index.js";
import type { PerfGymState } from "../engine.js";

export interface StepHistoryEntry {
  readonly stepNumber: number;
  readonly score: number;
  readonly status: "ACCEPTED" | "REJECTED" | "ROLLED_BACK";
  readonly commitHash?: string;
  readonly revertReason?: string;
  readonly deltaPercent?: number;
  readonly timestamp: number;
  /**
   * Metric values and per-metric deltas recorded when the step was ACCEPTED
   * (F3): rollback rewinds `currentMetrics`/`metricDeltas` to the restored
   * step's captured values, or the baseline values when rewinding to step 0.
   */
  readonly metrics?: Record<string, number>;
  readonly metricDeltas?: Record<string, number>;
}

export interface LockStateReport {
  readonly locked: boolean;
  readonly pid: number | null;
  readonly runId: string | null;
  readonly heartbeat: number | null;
  readonly isStale: boolean;
  readonly startTime?: number | null;
}

export interface StatusReport {
  readonly initialized: boolean;
  readonly sessionStatus: "not_initialized" | "idle" | "running" | "completed" | "error";
  readonly runId: string | null;
  readonly baseRef: string;
  readonly currentStep: number;
  readonly bestFitnessScore: number | null;
  readonly bestStep: number | null;
  readonly baselineMetrics: Record<string, number>;
  readonly currentValues: Record<string, number>;
  readonly metricDeltas: Record<string, number>;
  readonly stepHistory: readonly StepHistoryEntry[];
  readonly negativeMemory: readonly NegativeMemoryEntry[];
  readonly llmUsage?: LlmUsage;
  readonly lockState: LockStateReport;
  readonly targetName?: string;
}

export interface BaselineOutcome {
  readonly targetName: string;
  readonly invariantsPassed: boolean;
  readonly baselineMetrics: Record<string, number>;
  readonly distributions: Record<string, BenchmarkDistribution>;
  readonly state: PerfGymState;
  readonly commitHash?: string;
}

export interface LintOutcome {
  readonly passed: boolean;
  readonly violations: readonly LintViolation[];
  readonly totalPenalty: number;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly disqualified: boolean;
}

export interface BenchmarkOutcome {
  readonly metricName: string;
  readonly distribution: BenchmarkDistribution;
  readonly baselineValue?: number;
  readonly currentValue: number;
  readonly deltaPercent: number;
  readonly improved: boolean;
  readonly unit: string;
  readonly distributions?: Record<string, BenchmarkDistribution>;
  readonly metrics?: readonly MetricResult[];
}

export interface RollbackOutcome {
  readonly success: boolean;
  readonly status: "ROLLED_BACK";
  readonly rolledBackStep: number;
  readonly restoredStep: number;
  readonly targetCommit?: string;
  readonly message: string;
}

export interface BaselineHandlerOptions {
  cwd?: string;
  samples?: number;
  runId?: string;
}

export interface StepHandlerOptions {
  cwd?: string;
  files?: string[];
  mutations?: MutationFile[];
  samples?: number;
  minDelta?: number;
  recordNegativeMemory?: boolean;
}

export interface StatusHandlerOptions {
  cwd?: string;
}

export interface TestHandlerOptions {
  cwd?: string;
  command?: string;
  timeoutMs?: number;
}

export interface LintHandlerOptions {
  cwd?: string;
  files?: string[];
  rules?: AstRule[];
}

export interface BenchmarkHandlerOptions {
  cwd?: string;
  metric?: string;
  command?: string;
  samples?: number;
  timeoutMs?: number;
}

export interface RollbackHandlerOptions {
  cwd?: string;
  stepNumber?: number;
}

/** Extended state containing step history and tracking */
export interface CoordinatorState extends PerfGymState {
  history?: StepHistoryEntry[];
  currentMetrics?: Record<string, number>;
  metricDeltas?: Record<string, number>;
  bestStep?: number;
  baselineCommit?: string;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const e = err as { code?: string };
    return e.code !== "ESRCH";
  }
}

export function inspectLockState(
  lockDir: string,
  isHeldByUs: boolean,
  staleThresholdMs = 30_000
): LockStateReport {
  const metaPath = path.join(lockDir, "metadata.json");
  if (!fs.existsSync(metaPath)) {
    return {
      locked: isHeldByUs,
      pid: null,
      runId: null,
      heartbeat: null,
      isStale: false,
    };
  }

  try {
    const content = fs.readFileSync(metaPath, "utf8");
    const meta = JSON.parse(content) as {
      pid: number;
      runId: string;
      startTime: number;
      heartbeat: number;
    };
    const now = Date.now();
    const alive = isProcessAlive(meta.pid);
    // F9: a live holder with an old heartbeat is NOT a valid lock (its owner
    // stopped pumping and will be reaped) — staleness is about heartbeat age
    // first, aliveness second. `locked` therefore requires alive AND fresh.
    const stale =
      (meta.heartbeat === undefined || typeof meta.heartbeat !== "number"
        ? false
        : now - meta.heartbeat > staleThresholdMs) || !alive;

    return {
      locked: isHeldByUs || (alive && !stale),
      pid: meta.pid,
      runId: meta.runId,
      heartbeat: meta.heartbeat,
      startTime: meta.startTime,
      isStale: stale,
    };
  } catch {
    return {
      locked: isHeldByUs,
      pid: null,
      runId: null,
      heartbeat: null,
      isStale: true,
    };
  }
}
