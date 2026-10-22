/**
 * @perfgym/core
 * MarkdownFormatter — the human-facing adapter of the OutputFormatter seam.
 *
 * Pure and synchronous. Colour-agnostic: it emits plain markdown and the CLI
 * applies chalk around the finished string. The template follows LLD §6.2 —
 * header, invariants/types, performance distribution, AST violations, then
 * optional negative memory / next action.
 */

import type {
  BenchmarkDistribution,
  InvariantResult,
  LintViolation,
  MetricGoal,
  PerfGymConfig,
  StepEvaluation,
} from "../index.js";
import type { PerfGymSessionState, SessionLockState } from "../store/index.js";
import type { NegativeMemoryEntry } from "../memory/index.js";
import { formatNegativeMemoryEntry } from "../memory/render.js";
import {
  astViolationsOf,
  describeError,
  resolveLintAction,
  stripAnsi,
  tailGuardOf,
  totalPenaltyOf,
  typecheckFailuresOf,
} from "./shared.js";

export interface MarkdownFormatterOptions {
  /**
   * The strategies that already failed. Resolved entries — the formatter never
   * touches the memory cache itself, so it stays testable in isolation — and
   * nullable: `null` (or an empty list) means "no memory", which omits the
   * section entirely.
   */
  readonly negativeMemory?: readonly NegativeMemoryEntry[] | null;
}

const RULE_RECOMMENDATIONS: Record<string, string> = {
  "no-await-in-loop":
    "Batch IDs into `fetchItemsChunk([id1, id2])` or wrap with `Promise.all`.",
  "no-await-in-loops":
    "Batch asynchronous operations with `Promise.all` or chunk into concurrent batches.",
  "no-unindexed-filter":
    "Push the predicate into the query (SQL `WHERE` or an indexed lookup) instead of filtering in memory.",
  "no-sync-methods":
    "Replace blocking I/O (`readFileSync`, `execSync`) with asynchronous alternatives.",
  "no-ts-ignore": "Fix the underlying type error instead of suppressing it.",
  "no-ts-nocheck": "Keep typechecking enabled across target files.",
  "no-any-cast": "Specify an explicit interface or generic instead of an `any` cast.",
  "no-dynamic-eval": "Use static function references or a lookup table instead of `eval`.",
  "no-function-constructor": "Construct the logic statically instead of `new Function`.",
};

const formatScore = (score: number): string =>
  Number.isFinite(score) ? score.toFixed(1) : "-∞";

const formatValue = (value: number, unit: string): string => `${value.toFixed(1)}${unit}`;

/** 🔻 marks a regression, 🔺 an improvement — direction follows the metric goal. */
const formatDelta = (current: number, baseline: number, goal: MetricGoal | null): string => {
  if (baseline === 0) {
    return "—";
  }

  const delta = ((current - baseline) / baseline) * 100;
  const regression = goal === "maximize" ? delta < 0 : delta > 0;

  let sign = "";
  let arrow = "➖";
  if (delta > 0) {
    sign = "+";
    arrow = regression ? "🔻" : "🔺";
  } else if (delta < 0) {
    sign = "-";
    arrow = regression ? "🔻" : "🔺";
  }

  return `${arrow} \`${sign}${Math.abs(delta).toFixed(1)}%\``;
};

const recommendationFor = (violation: LintViolation): string =>
  RULE_RECOMMENDATIONS[violation.ruleId] ??
  "Rework the code so it no longer matches this pattern.";

const renderTypesSection = (evaluation: StepEvaluation): string[] => {
  const { invariants } = evaluation;
  const retries =
    invariants.retriesUsed !== undefined && invariants.retriesUsed > 0
      ? ` after ${invariants.retriesUsed} retr${invariants.retriesUsed === 1 ? "y" : "ies"}`
      : "";
  const invariantLine =
    `- **Unit / Invariant Tests:** ${invariants.passed ? "✅ Passed" : "❌ Failed"} ` +
    `(${invariants.durationMs}ms${retries})`;

  const typecheckFailures = typecheckFailuresOf(evaluation);
  const typecheckLine =
    typecheckFailures.length === 0
      ? "- **Typecheck Gate:** ✅ Clean (no type suppressions)"
      : `- **Typecheck Gate:** ❌ Failed — ${typecheckFailures
          .map((violation) => stripAnsi(violation.message))
          .join("; ")}`;

  return ["#### 1. Invariants & Types", invariantLine, typecheckLine];
};

const renderDistributionSection = (
  evaluation: StepEvaluation,
  goal: MetricGoal | null,
): string[] => {
  const { baselineDistribution: baseline, currentDistribution: current } = evaluation;

  if (baseline === undefined || current === undefined) {
    return [
      "#### 2. Performance Distribution (Baseline vs Mutation)",
      "_Performance distribution unavailable — this step stopped before benchmarking._",
    ];
  }

  const unit = current.unit;
  const tail = tailGuardOf(baseline, current, goal);
  let tailNote: string;
  if (tail.passed === null) {
    tailNote = "(Tail Guard unchecked)";
  } else {
    tailNote = `(Tail Guard ${tail.passed ? "passed" : "failed"})`;
  }
  const tailLabel = goal === "maximize" ? "Min (Tail)" : "p99 (Tail)";
  const tailBaseline = goal === "maximize" ? baseline.min : baseline.p99;
  const tailCurrent = goal === "maximize" ? current.min : current.p99;

  const rows = [
    `| **Median (p50)** | \`${formatValue(baseline.p50, unit)}\` | \`${formatValue(
      current.p50,
      unit,
    )}\` | ${formatDelta(current.p50, baseline.p50, goal)} |`,
    `| **p95** | \`${formatValue(baseline.p95, unit)}\` | \`${formatValue(
      current.p95,
      unit,
    )}\` | ${formatDelta(current.p95, baseline.p95, goal)} |`,
    `| **${tailLabel}** | \`${formatValue(tailBaseline, unit)}\` | \`${formatValue(
      tailCurrent,
      unit,
    )}\` | ${formatDelta(tailCurrent, tailBaseline, goal)} ${tailNote} |`,
    `| **Max Spike** | \`${formatValue(baseline.max, unit)}\` | \`${formatValue(
      current.max,
      unit,
    )}\` | ${formatDelta(current.max, baseline.max, goal)} |`,
  ];

  return [
    "#### 2. Performance Distribution (Baseline vs Mutation)",
    "| Metric | Baseline | Current Mutation | Delta |",
    "|---|---|---|---|",
    ...rows,
  ];
};

const renderViolationsSection = (violations: readonly LintViolation[]): string[] => {
  const astViolations = astViolationsOf(violations);
  const penalty = totalPenaltyOf(astViolations);
  const lines = [`#### 3. AST Pattern Violations (-${penalty} Penalty Points)`];

  if (astViolations.length === 0) {
    lines.push("- No AST pattern violations detected.");
    return lines;
  }

  for (const violation of astViolations) {
    lines.push(
      `- **\`${violation.file}:${violation.line}\`** — \`${violation.ruleId}\` (penalty: -${violation.penalty})`,
      `  > ${stripAnsi(violation.message)}`,
      `  *Recommendation: ${recommendationFor(violation)}*`,
    );
  }

  return lines;
};

const hasMemory = (
  memory: readonly NegativeMemoryEntry[] | null | undefined,
): memory is readonly NegativeMemoryEntry[] =>
  memory !== undefined && memory !== null && memory.length > 0;

export class MarkdownFormatter {
  readonly format = "markdown" as const;

  readonly #negativeMemory: readonly NegativeMemoryEntry[] | null;

  constructor(options: MarkdownFormatterOptions = {}) {
    this.#negativeMemory = options.negativeMemory ?? null;
  }

  formatStep(evaluation: StepEvaluation, config?: PerfGymConfig): string {
    const status = evaluation.accepted ? "ACCEPTED" : "REVERTED";
    const emoji = evaluation.accepted ? "✅" : "❌";
    const score = formatScore(evaluation.fitnessScore);
    const goal: MetricGoal | null = config?.metrics?.[0]?.goal ?? null;
    const lines: string[] = [
      `### ${emoji} [${status}] Mutation at step ${evaluation.iteration} (Score: ${score})`,
      "",
      evaluation.accepted
        ? `Your changes were accepted in **${evaluation.executionTimeMs}ms**.`
        : `Your changes were safely rolled back in **${evaluation.executionTimeMs}ms**.`,
      "",
      ...renderTypesSection(evaluation),
      "",
      ...renderDistributionSection(evaluation, goal),
      "",
      ...renderViolationsSection(evaluation.violations),
    ];

    const memory = this.#negativeMemory;
    const memoryLines = hasMemory(memory)
      ? memory.map((entry) => `- ⚠️ *${stripAnsi(formatNegativeMemoryEntry(entry))}*`)
      : [];

    const nextDirection =
      evaluation.revertReason !== undefined && evaluation.revertReason.length > 0
        ? `- 👉 *Next Direction: ${stripAnsi(evaluation.revertReason)}*`
        : null;

    if (memoryLines.length > 0 || nextDirection !== null) {
      lines.push("", "#### 4. Negative Memory & Next Action", ...memoryLines);
      if (nextDirection !== null) {
        lines.push(nextDirection);
      }
    }

    return lines.join("\n");
  }

  formatBaseline(distribution: BenchmarkDistribution, config?: PerfGymConfig): string {
    const unit = distribution.unit;
    const target = config?.target?.name;

    return [
      "### 📊 Baseline Recorded",
      "",
      ...(target === undefined ? [] : [`Target: \`${target}\``, ""]),
      "| Metric | Value |",
      "|---|---|",
      `| **p50** | \`${formatValue(distribution.p50, unit)}\` |`,
      `| **p90** | \`${formatValue(distribution.p90, unit)}\` |`,
      `| **p95** | \`${formatValue(distribution.p95, unit)}\` |`,
      `| **p99 (Tail)** | \`${formatValue(distribution.p99, unit)}\` |`,
      `| **Min** | \`${formatValue(distribution.min, unit)}\` |`,
      `| **Max** | \`${formatValue(distribution.max, unit)}\` |`,
      `| **Std Dev** | \`${formatValue(distribution.stddev, unit)}\` |`,
      `| **MAD** | \`${formatValue(distribution.mad, unit)}\` |`,
      `| **IQR** | \`${formatValue(distribution.iqr, unit)}\` |`,
      `| **Samples** | \`${distribution.sampleCount}\` |`,
    ].join("\n");
  }

  formatStatus(state: PerfGymSessionState, lock?: SessionLockState | null): string {
    const resolvedLock = lock ?? state.lock ?? null;
    const bestScore = formatScore(state.bestScore);

    return [
      `### 📍 Session Status: ${state.status}`,
      "",
      `- **Run:** \`${state.runId || "—"}\``,
      `- **Base ref:** \`${state.baseRef}\``,
      `- **Step:** ${state.currentStep}`,
      `- **Best score:** ${bestScore}${
        state.bestStep === null ? "" : ` (step ${state.bestStep})`
      }`,
      `- **Baseline:** ${
        state.baseline === null
          ? "not recorded"
          : `recorded (p50 \`${formatValue(state.baseline.p50, state.baseline.unit)}\`)`
      }`,
      `- **Lock:** ${
        resolvedLock === null ? "none" : `pid ${resolvedLock.pid} (run \`${resolvedLock.runId}\`)`
      }`,
      `- **Last error:** ${state.lastError === null ? "none" : stripAnsi(state.lastError)}`,
    ].join("\n");
  }

  formatTest(result: InvariantResult): string {
    const retries =
      result.retriesUsed !== undefined && result.retriesUsed > 0
        ? `, ${result.retriesUsed} retries`
        : "";
    const output = stripAnsi(result.output).trim();

    return [
      `### ${result.passed ? "✅" : "❌"} Invariant Tests ${
        result.passed ? "Passed" : "Failed"
      } (${result.durationMs}ms${retries})`,
      "",
      "```text",
      output.length === 0 ? "(no output)" : output,
      "```",
    ].join("\n");
  }

  formatLint(violations: readonly LintViolation[]): string {
    const astViolations = astViolationsOf(violations);
    const lines = ["### 🧹 AST Pattern Violations"];

    if (astViolations.length === 0) {
      lines.push("", "- No AST pattern violations detected.");
      return lines.join("\n");
    }

    lines.push("");
    for (const violation of astViolations) {
      lines.push(
        `- **\`${violation.file}:${violation.line}\`** — \`${violation.ruleId}\` (${resolveLintAction(
          violation,
        )}: -${violation.penalty})`,
        `  > ${stripAnsi(violation.message)}`,
        `  *Recommendation: ${recommendationFor(violation)}*`,
      );
    }
    lines.push("", `Total penalty: -${totalPenaltyOf(astViolations)}`);

    return lines.join("\n");
  }

  formatBenchmark(
    distribution: BenchmarkDistribution,
    baseline?: BenchmarkDistribution,
  ): string {
    const unit = distribution.unit;
    const rows = [
      `| **Median (p50)** | \`${formatValue(distribution.p50, unit)}\` |`,
      `| **p95** | \`${formatValue(distribution.p95, unit)}\` |`,
      `| **p99 (Tail)** | \`${formatValue(distribution.p99, unit)}\` |`,
      `| **Max Spike** | \`${formatValue(distribution.max, unit)}\` |`,
    ];

    if (baseline === undefined) {
      return [
        "### ⏱️ Benchmark Distribution",
        "",
        "| Metric | Current |",
        "|---|---|",
        ...rows,
      ].join("\n");
    }

    return [
      "### ⏱️ Benchmark Distribution",
      "",
      "| Metric | Baseline | Current | Delta |",
      "|---|---|---|---|",
      `| **Median (p50)** | \`${formatValue(baseline.p50, unit)}\` | \`${formatValue(
        distribution.p50,
        unit,
      )}\` | ${formatDelta(distribution.p50, baseline.p50, null)} |`,
      `| **p95** | \`${formatValue(baseline.p95, unit)}\` | \`${formatValue(
        distribution.p95,
        unit,
      )}\` | ${formatDelta(distribution.p95, baseline.p95, null)} |`,
      `| **p99 (Tail)** | \`${formatValue(baseline.p99, unit)}\` | \`${formatValue(
        distribution.p99,
        unit,
      )}\` | ${formatDelta(distribution.p99, baseline.p99, null)} |`,
      `| **Max Spike** | \`${formatValue(baseline.max, unit)}\` | \`${formatValue(
        distribution.max,
        unit,
      )}\` | ${formatDelta(distribution.max, baseline.max, null)} |`,
    ].join("\n");
  }

  formatError(error: unknown): string {
    const described = describeError(error);

    return [
      "### ❌ Error",
      "",
      `**${described.name}:** ${described.message}`,
      ...(described.code === null ? [] : ["", `Code: \`${described.code}\``]),
    ].join("\n");
  }

  formatNegativeMemory(
    entries: readonly NegativeMemoryEntry[],
    options?: { target?: string | null },
  ): string {
    const target = options?.target;
    const lines: string[] = ["### 🧠 Negative Memory", ""];

    // Only a real target name is rendered: absent, null and "" all mean
    // "no target".
    if (typeof target === "string" && target.length > 0) {
      lines.push(`- **Target:** \`${target}\``);
    }
    lines.push(`- **Remembered failures:** ${entries.length}`);

    if (entries.length === 0) {
      lines.push("", "_Nothing remembered yet._");
      return lines.join("\n");
    }

    lines.push("");
    for (const entry of entries) {
      lines.push(`- ⚠️ *${stripAnsi(formatNegativeMemoryEntry(entry))}* — step ${entry.step}`);
    }

    return lines.join("\n");
  }
}
