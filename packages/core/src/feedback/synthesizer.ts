/**
 * @perfgym/core
 * Natural-Language Gradient Feedback Synthesizer (Ticket #19)
 *
 * Transforms raw pipeline metrics, invariant errors, and AST violations
 * into structured, deterministic, LLM-actionable guidance.
 */

import type { InvariantResult, LintViolation, MetricResult } from "../index.js";
import type { NegativeMemoryEntry } from "../memory/index.js";
import { formatDeltaPercent, formatNegativeMemoryEntry } from "../memory/render.js";

export interface SynthesizerInput {
  accepted: boolean;
  fitnessScore: number;
  deltaPercent: number;
  isSignificant: boolean;
  invariants: InvariantResult;
  violations: readonly LintViolation[];
  metrics: readonly MetricResult[];
  baselineMetrics?: Record<string, number>;
  revertReason?: string;
  /**
   * Strategies that already failed, newest first. When supplied and non-empty
   * the feedback ends with a "Previously failed strategies" section so the
   * agent knows what not to retry. Absent data is `null` (or an empty list) —
   * both mean "no memory" and leave the rendered feedback unchanged.
   */
  negativeMemory?: readonly NegativeMemoryEntry[] | null;
}

const RULE_RECOMMENDATIONS: Record<string, string> = {
  "no-await-in-loops":
    "Batch asynchronous operations with Promise.all(...) or chunk into concurrent batches rather than serial loop awaits.",
  "no-unindexed-filter":
    "Push filtering predicates into the database query (e.g. SQL WHERE or indexed queries) instead of loading and filtering collections in-memory.",
  "no-sync-methods":
    "Replace synchronous blocking I/O (e.g. readFileSync, execSync) with asynchronous non-blocking alternatives (e.g. fs.promises or streams) to avoid event loop stalls.",
  "no-ts-ignore":
    "Fix underlying TypeScript compiler errors cleanly; type suppression directives (@ts-ignore) are classified as compiler sabotage.",
  "no-ts-nocheck":
    "Keep full typechecking enabled across all target files; @ts-nocheck is disallowed.",
  "no-any-cast":
    "Specify explicit interfaces or generic types instead of unsafe casts to 'any'.",
  "no-dynamic-eval":
    "Avoid eval() and dynamic code generation; use static function references or lookup tables.",
  "no-function-constructor":
    "Avoid Function constructor (new Function); construct logic statically.",
};

export function synthesizeGradientFeedback(input: SynthesizerInput): string {
  const lines: string[] = [];

  // Header
  if (input.accepted) {
    const scoreFmt = input.fitnessScore.toFixed(2);
    const sign = input.fitnessScore > 0 ? "+" : "";
    lines.push(`[ACCEPTED] Mutation improved objective function. Fitness Score: ${sign}${scoreFmt}`);
  } else {
    lines.push(`[REVERTED] Mutation was rejected and rolled back.`);
    if (input.revertReason) {
      lines.push(`Reason: ${input.revertReason}`);
    }
  }

  // Invariants Status
  if (input.invariants.passed) {
    lines.push(`- Invariants: PASSED (${input.invariants.durationMs}ms)`);
  } else {
    lines.push(`- Invariants: FAILED (${input.invariants.durationMs}ms)`);
    if (input.invariants.output) {
      const cleanOut = input.invariants.output.trim().split("\n").slice(0, 5).join("\n  ");
      lines.push(`  Error output:\n  ${cleanOut}`);
    }
  }

  // Benchmarks & Metrics
  if (input.metrics.length > 0) {
    for (const m of input.metrics) {
      const deltaSign = formatDeltaPercent(m.deltaPercent);
      const statusWord = m.improved ? "improved" : "degraded";
      const baseVal = input.baselineMetrics?.[m.name];
      const baseStr = baseVal !== undefined ? ` (Baseline: ${baseVal}${m.unit} -> Current: ${m.value}${m.unit})` : ` (${m.value}${m.unit})`;
      lines.push(`- Benchmark '${m.name}': ${statusWord} by ${deltaSign}${baseStr}`);
    }
  }

  // Linter & AST Violations
  if (input.violations.length > 0) {
    lines.push(`- Linter: ${input.violations.length} violation(s):`);
    for (const v of input.violations) {
      const tag = v.action === "disqualify" ? "[DISQUALIFY]" : `[-${v.penalty}]`;
      lines.push(`  * ${tag} ${v.ruleId} at ${v.file}:${v.line} -> ${v.message}`);
    }
  }

  // Constructive Recommendations
  const recommendations: string[] = [];

  if (!input.invariants.passed) {
    recommendations.push(
      "Correctness precedes speed. Analyze test assertions and restore invariant test compliance before optimizing performance."
    );
  }

  for (const v of input.violations) {
    const rec = RULE_RECOMMENDATIONS[v.ruleId];
    if (rec && !recommendations.includes(rec)) {
      recommendations.push(rec);
    }
  }

  if (input.accepted) {
    recommendations.push(
      "Continue with further optimizations along this gradient, or look for additional serial bottlenecks."
    );
  } else if (input.invariants.passed && input.violations.length === 0 && input.metrics.length > 0) {
    if (!input.isSignificant && input.deltaPercent >= 0) {
      recommendations.push(
        "Metric gain was below the minimum significance threshold (+2.5%). Increase mutation step magnitude or try a higher-leverage optimization."
      );
    } else {
      recommendations.push(
        "Metric did not improve sufficiently beyond the minimum significance threshold or regressed tail latency. Try an alternative algorithm or data structure."
      );
    }
  }

  if (recommendations.length > 0) {
    lines.push(`Recommendation:`);
    for (const r of recommendations) {
      lines.push(`- ${r}`);
    }
  }

  // Negative Memory — the strategies that already failed. Omitted entirely
  // when no memory is supplied (absent, `null` or empty), so the default
  // feedback is unchanged.
  const negativeMemory = input.negativeMemory;
  if (negativeMemory !== undefined && negativeMemory !== null && negativeMemory.length > 0) {
    lines.push(`Previously failed strategies:`);
    for (const entry of negativeMemory) {
      lines.push(`- ${formatNegativeMemoryEntry(entry)}`);
    }
  }

  return lines.join("\n");
}
