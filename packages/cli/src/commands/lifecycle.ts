/**
 * Lifecycle CLI commands (Ticket #44) — status / rollback / test / lint / benchmark.
 *
 * These five commands all go through the shared McpServerCoordinator domain
 * handlers instead of the ad-hoc engine pipelines, so the CLI and the MCP
 * server behave identically. Each runner:
 *
 * - receives the already-resolved `OutputFormat` (the entrypoint owns
 *   `--format`/`--color` parsing and colouring) plus an optional `cwd` the
 *   tests use to point the command at a scratch repository;
 * - constructs one coordinator per invocation (stateless between calls);
 * - returns finished, colour-free text plus the process exit code.
 *
 * Placement rule (mirrors the entrypoint's `fail()`): a failure's text goes
 * to stdout in JSON mode and to stderr in markdown mode — the entrypoint
 * decides, anchored on the `failed` flag.
 */

import * as path from "node:path";
import {
  createFormatter,
  toDistributionJson,
  createStepHistoryTable,
  renderStepTable,
  type OutputFormat,
} from "../../../core/src/index.js";
import { GitWorktreeDriver } from "../../../core/src/sandbox/git-worktree-driver.js";
import { loadConfig } from "../engine.js";
import {
  McpServerCoordinator,
  type RollbackOutcome,
  type StatusReport,
} from "../coordinator/index.js";

export interface LifecycleCommandOptions {
  /** Project root to operate on (defaults to the process working directory). */
  cwd?: string;
  format: OutputFormat;
}

export interface LifecycleCommandResult {
  /** Finished formatter text (JSON or markdown), ready to emit. */
  readonly text: string;
  readonly exitCode: number;
  /** Marks a thrown coordinator error; the entrypoint owns placement. */
  readonly failed: boolean;
}

const resolveRoot = (cwd?: string): string => path.resolve(cwd ?? process.cwd());

/** Default mutation boundary for projects without a (valid) configuration. */
export const FALLBACK_TARGET_GLOBS: string[] = ["src/**/*"];

/**
 * The sandbox driver's mutation boundary is the project's configured target
 * globs: a hardcoded `src/**` breaks projects whose target lives in another
 * directory (the restore's `driver.writeFile` would refuse with
 * PathOutsideTargetError, F3). Coordinators built before initialization (or
 * against an unreadable config) keep the documented default.
 */
export const resolveTargetGlobs = (root: string): string[] => {
  try {
    const files = loadConfig(root).target.files;
    if (Array.isArray(files) && files.length > 0) {
      return [...files];
    }
  } catch {
    // Uninitialized project / unreadable config — fall through to the default.
  }
  return [...FALLBACK_TARGET_GLOBS];
};

/** Raised when `--to-step` is not a positive integer (F1). */
export class InvalidStepOptionError extends Error {
  readonly rawValue: string;

  constructor(rawValue: string) {
    super(`Invalid step number "${rawValue}" — --to-step expects a positive integer.`);
    this.name = "InvalidStepOptionError";
    this.rawValue = rawValue;
  }
}

/**
 * F1: an unparseable `--to-step` must fail loudly. A silent fallback to the
 * default rollback would destroy work the agent never asked to undo.
 */
export const parseStepNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new InvalidStepOptionError(value);
  }
  return parseInt(value, 10);
};

/** One shared coordinator instance per command invocation. */
const createCoordinator = (root: string): McpServerCoordinator =>
  new McpServerCoordinator({
    rootDir: root,
    // A file-backed driver: rollback's authoritative restore path performs a
    // git reset inside the sandbox worktree it acquires, which only exists
    // with a real git driver. The user's own checkout/branch is never
    // touched — the worktree is created off the base ref (F2/F5 contract).
    driver: new GitWorktreeDriver({ repoRoot: root, allowedGlobs: resolveTargetGlobs(root) }),
  });

/** Render a thrown error through the shared OutputFormatter seam. */
const failure = (format: OutputFormat, error: unknown): LifecycleCommandResult => ({
  text: createFormatter(format).formatError(error),
  exitCode: 1,
  failed: true,
});

const percent = (delta: number): string => `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;

// ============================================================================
// perfgym status — read-only session report
// ============================================================================

const statusJson = (report: StatusReport): Record<string, unknown> => ({
  initialized: report.initialized,
  target: report.targetName ?? null,
  sessionStatus: report.sessionStatus,
  runId: report.runId,
  baseRef: report.baseRef,
  currentStep: report.currentStep,
  bestScore: report.bestFitnessScore,
  bestStep: report.bestStep,
  // #48: how stale this snapshot is — visibly stale beats silently wrong.
  lastUpdatedAt: report.lastUpdatedAt ?? null,
  baseline: report.baselineMetrics,
  current: report.currentValues,
  metricDeltas: report.metricDeltas,
  historyLength: report.stepHistory.length,
  history: report.stepHistory.map((entry) => ({
    step: entry.stepNumber,
    score: Number.isFinite(entry.score) ? entry.score : null,
    status: entry.status,
    commitHash: entry.commitHash ?? null,
    deltaPercent: entry.deltaPercent ?? null,
    timestamp: entry.timestamp,
  })),
  negativeMemoryCount: report.negativeMemory.length,
  negativeMemory: report.negativeMemory.map((entry) => ({
    strategy: entry.strategy,
    deltaPercent: entry.deltaPercent,
    reason: entry.reason,
    step: entry.step,
    timestamp: entry.timestamp,
  })),
  llmUsage: report.llmUsage ?? null,
  // #48: the serialized live-session store view (the run in progress).
  liveSession: report.liveSession
    ? {
        status: report.liveSession.status,
        runId: report.liveSession.runId,
        baseRef: report.liveSession.baseRef,
        currentStep: report.liveSession.currentStep,
        bestScore: report.liveSession.bestScore,
        bestStep: report.liveSession.bestStep,
        lastUpdatedAt: report.liveSession.lastUpdatedAt,
        lastError: report.liveSession.lastError,
        lock: report.liveSession.lock
          ? {
              pid: report.liveSession.lock.pid,
              runId: report.liveSession.lock.runId,
              startTime: report.liveSession.lock.startTime,
              heartbeat: report.liveSession.lock.heartbeat,
            }
          : null,
        history: report.liveSession.history,
      }
    : null,
  lock: {
    locked: report.lockState.locked,
    pid: report.lockState.pid,
    runId: report.lockState.runId,
    heartbeat: report.lockState.heartbeat,
    isStale: report.lockState.isStale,
    startTime: report.lockState.startTime ?? null,
  },
});

/**
 * Safely format a timestamp for markdown status output.
 * Returns null if the timestamp is null, undefined, not finite, or an invalid date.
 */
function formatTimestampBullet(label: string, stamp: unknown): string | null {
  if (typeof stamp !== "number" || !Number.isFinite(stamp)) {
    return null;
  }
  try {
    const date = new Date(stamp);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return `- **${label}:** \`${stamp}\` (${date.toISOString()})`;
  } catch {
    return null;
  }
}

const renderStatusMarkdown = (report: StatusReport): string => {
  const lock = report.lockState;
  const lockText = lock.locked
    ? `held by PID ${lock.pid ?? "?"} — run \`${lock.runId ?? "?"}\`, heartbeat ${
        lock.heartbeat === null ? "?" : new Date(lock.heartbeat).toISOString()
      }${lock.isStale ? " (stale)" : ""}`
    : "unlocked";

  const lines: string[] = [
    "### 🏋️ PerfGym Status",
    "",
    `- **Target:** \`${report.targetName ?? "unknown"}\``,
    `- **Session:** ${report.sessionStatus}`,
    `- **Run:** \`${report.runId ?? "—"}\` (base ref \`${report.baseRef}\`)`,
    `- **Step:** ${report.currentStep}`,
    `- **Best:** ${
      report.bestFitnessScore === null
        ? "—"
        : report.bestFitnessScore.toFixed(2)
    }${report.bestStep === null ? "" : ` (step ${report.bestStep})`}`,
    `- **Lock:** ${lockText}`,
    // #48: a stale snapshot is visibly stale rather than silently wrong.
    // The live session's own stamp is the precise one; the file stamp is the
    // fallback when no live session is recorded.
    formatTimestampBullet(
      "Last updated",
      report.liveSession !== null ? report.liveSession.lastUpdatedAt : report.lastUpdatedAt,
    ),
    formatTimestampBullet(
      "Session heartbeat",
      report.liveSession && report.liveSession.lock ? report.liveSession.lock.heartbeat : null,
    ),
  ].filter((line): line is string => line !== null);

  if (report.llmUsage !== undefined) {
    lines.push(
      `- **LLM usage:** ${report.llmUsage.promptTokens} prompt + ${report.llmUsage.completionTokens} completion = ${report.llmUsage.totalTokens} tokens`,
    );
  }

  const metricNames = Object.keys(report.baselineMetrics);
  if (metricNames.length > 0) {
    lines.push("", "#### Metrics", "", "| Metric | Baseline | Current | Δ |", "|---|---|---|---|");
    for (const name of metricNames) {
      const baseline = report.baselineMetrics[name];
      const current = report.currentValues[name];
      const delta = report.metricDeltas[name];
      lines.push(
        `| **${name}** | \`${baseline}\` | \`${current ?? "—"}\` | ${
          delta === undefined ? "—" : `\`${percent(delta)}\``
        } |`,
      );
    }
  }

  if (report.liveSession !== null && report.liveSession.history.length > 0) {
    // #48 + #47: the live session's recorded evaluations render as the
    // dependency-free step-history table.
    lines.push(
      "",
      "#### Step History",
      "",
      "```",
      renderStepTable(createStepHistoryTable(report.liveSession.history)),
      "```",
    );
  } else if (report.stepHistory.length > 0) {
    lines.push("", "#### Step History");
    for (const entry of report.stepHistory) {
      lines.push(
        `- Step ${entry.stepNumber} — ${entry.status}` +
          `${entry.deltaPercent === undefined ? "" : ` (Δ ${percent(entry.deltaPercent)})`}` +
          `${Number.isFinite(entry.score) ? ` — score ${entry.score.toFixed(2)}` : ""}` +
          `${entry.revertReason === undefined ? "" : ` — ${entry.revertReason}`}`,
      );
    }
  } else {
    lines.push("", "_No step history yet._");
  }

  if (report.negativeMemory.length > 0) {
    lines.push("", `#### Negative Memory (${report.negativeMemory.length})`);
    for (const entry of report.negativeMemory) {
      lines.push(
        `- ⚠️ \`${entry.strategy}\` — ${entry.reason} (Δ ${percent(entry.deltaPercent)}, step ${entry.step})`,
      );
    }
  }

  return lines.join("\n");
};

export const runStatusCommand = async (
  options: LifecycleCommandOptions,
): Promise<LifecycleCommandResult> => {
  const root = resolveRoot(options.cwd);
  try {
    const coordinator = createCoordinator(root);
    const report = await coordinator.handleStatus({ cwd: root });

    if (!report.initialized) {
      // Read-only and never an error: point the agent at the next step.
      const guidance = "no baseline yet — run `perfgym baseline` first.";
      if (options.format === "json") {
        return {
          text: JSON.stringify({ ...statusJson(report), guidance }, null, 2),
          exitCode: 0,
          failed: false,
        };
      }
      return {
        text: ["### 🏋️ PerfGym Status", "", guidance].join("\n"),
        exitCode: 0,
        failed: false,
      };
    }

    const text =
      options.format === "json"
        ? JSON.stringify(statusJson(report), null, 2)
        : renderStatusMarkdown(report);
    return { text, exitCode: 0, failed: false };
  } catch (error: unknown) {
    return failure(options.format, error);
  }
};

// ============================================================================
// perfgym rollback — restore the sandbox worktree to the last approved state
// ============================================================================

const rollbackJson = (outcome: RollbackOutcome): Record<string, unknown> => ({
  status: outcome.status,
  rolledBackStep: outcome.rolledBackStep,
  restoredStep: outcome.restoredStep,
  targetCommit: outcome.targetCommit ?? null,
  message: outcome.message,
});

const renderRollbackMarkdown = (outcome: RollbackOutcome): string => [
  "### ⏪ Rollback Complete",
  "",
  `- **Rolled back step:** ${outcome.rolledBackStep}`,
  `- **Restored to step:** ${outcome.restoredStep}`,
  `- **Target commit:** \`${outcome.targetCommit ?? "—"}\``,
  "",
  outcome.message,
].join("\n");

export interface RollbackCommandOptions extends LifecycleCommandOptions {
  /** Target step from history (must be ACCEPTED); omit for the latest one. */
  toStep?: number;
}

export const runRollbackCommand = async (
  options: RollbackCommandOptions,
): Promise<LifecycleCommandResult> => {
  const root = resolveRoot(options.cwd);
  try {
    const coordinator = createCoordinator(root);
    const outcome = await coordinator.handleRollback({
      cwd: root,
      ...(options.toStep !== undefined ? { stepNumber: options.toStep } : {}),
    });

    const text =
      options.format === "json"
        ? JSON.stringify(rollbackJson(outcome), null, 2)
        : renderRollbackMarkdown(outcome);
    return { text, exitCode: 0, failed: false };
  } catch (error: unknown) {
    // Lock-busy, non-ACCEPTED targets and missing state all land here as a
    // booked failure: the coordinator's message is shown, exit code 1, and
    // nothing has been changed anywhere.
    return failure(options.format, error);
  }
};

// ============================================================================
// perfgym test — run the invariant gate only
// ============================================================================

export interface TestCommandOptions extends LifecycleCommandOptions {
  timeoutMs?: number;
}

export const runTestCommand = async (
  options: TestCommandOptions,
): Promise<LifecycleCommandResult> => {
  const root = resolveRoot(options.cwd);
  try {
    const coordinator = createCoordinator(root);
    const result = await coordinator.handleTest({
      cwd: root,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });

    const text = createFormatter(options.format).formatTest(result);
    // A failing invariant is an expected, reported outcome (exit 1), not a
    // thrown error — parity with `perfgym step`'s rejected-step exit.
    return { text, exitCode: result.passed ? 0 : 1, failed: false };
  } catch (error: unknown) {
    return failure(options.format, error);
  }
};

// ============================================================================
// perfgym lint — AST rules + tier-1 typecheck, side-effect-free
// ============================================================================

export interface LintCommandOptions extends LifecycleCommandOptions {
  files?: string[];
}

export const runLintCommand = async (
  options: LintCommandOptions,
): Promise<LifecycleCommandResult> => {
  const root = resolveRoot(options.cwd);
  try {
    const coordinator = createCoordinator(root);
    const outcome = await coordinator.handleLint({
      cwd: root,
      ...(options.files !== undefined && options.files.length > 0 ? { files: options.files } : {}),
    });

    const formatter = createFormatter(options.format);
    const text = formatter.formatLint(outcome.violations, outcome.scanErrors);
    // Exit 1 on any error-severity or disqualifying violation; warnings-only
    // scans still succeed.
    // B2: a rule/scan failure is an infrastructural failure the coordinator
    // reports via scanErrors — the command must mark the scan failed (exit 1)
    // and render the errors instead of printing a clean report.
    const scanFailed = outcome.scanErrors.length > 0;
    const exitCode = outcome.errorCount > 0 || outcome.disqualified || scanFailed ? 1 : 0;
    return { text, exitCode, failed: scanFailed };
  } catch (error: unknown) {
    return failure(options.format, error);
  }
};

// ============================================================================
// perfgym benchmark — measure one metric against the stored baseline
// ============================================================================

const benchmarkJson = (outcome: Awaited<ReturnType<McpServerCoordinator["handleBenchmark"]>>): Record<string, unknown> => ({
  metric: outcome.metricName,
  unit: outcome.unit,
  distribution: toDistributionJson(outcome.distribution),
  baselineValue: outcome.baselineValue ?? null,
  currentValue: outcome.currentValue,
  deltaPercent: outcome.deltaPercent,
  improved: outcome.improved,
});

export interface BenchmarkCommandOptions extends LifecycleCommandOptions {
  samples: number;
  metric?: string;
}

export const runBenchmarkCommand = async (
  options: BenchmarkCommandOptions,
): Promise<LifecycleCommandResult> => {
  const root = resolveRoot(options.cwd);
  try {
    const coordinator = createCoordinator(root);
    const outcome = await coordinator.handleBenchmark({
      cwd: root,
      samples: options.samples,
      ...(options.metric !== undefined ? { metric: options.metric } : {}),
    });

    let text: string;
    if (options.format === "json") {
      text = JSON.stringify(benchmarkJson(outcome), null, 2);
    } else {
      // Hand-rolled markdown (not the formatter's p50/p95/p99-only table):
      // the spec asks for the full distribution — p50/p90/p95/p99, MAD and
      // IQR — plus the delta against the stored baseline (F2).
      const dist = outcome.distribution;
      const unit = dist.unit;
      const rows: Array<[string, number]> = [
        ["Median (p50)", dist.p50],
        ["p90", dist.p90],
        ["p95", dist.p95],
        ["p99 (Tail)", dist.p99],
        ["Min", dist.min],
        ["Max Spike", dist.max],
        ["Std Dev", dist.stddev],
        ["MAD", dist.mad],
        ["IQR", dist.iqr],
      ];
      const baselineLines =
        outcome.baselineValue === undefined
          ? []
          : [
              "",
              `- **Baseline (p50):** \`${outcome.baselineValue}${unit}\``,
              `- **Current (p50):** \`${outcome.currentValue}${unit}\``,
              `- **Delta vs baseline:** \`${percent(outcome.deltaPercent)}\`${
                outcome.improved ? " — improved" : " — no improvement"
              }`,
            ];
      text = [
        "### ⏱️ Benchmark Distribution",
        "",
        `- **Metric:** \`${outcome.metricName}\``,
        "",
        "| Metric | Value |",
        "|---|---|",
        ...rows.map(([label, value]) => `| **${label}** | \`${value.toFixed(1)}${unit}\` |`),
        `| **Samples** | \`${dist.sampleCount}\` |`,
        ...baselineLines,
      ].join("\n");
    }
    return { text, exitCode: 0, failed: false };
  } catch (error: unknown) {
    return failure(options.format, error);
  }
};
