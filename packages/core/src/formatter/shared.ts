/**
 * @perfgym/core
 * Shared, adapter-agnostic helpers for the formatter seam.
 *
 * Both adapters speak the same domain shapes (distributions, lint matches,
 * errors). Keeping those projections here means neither adapter depends on
 * the other — the seam stays a two-way fork under the `OutputFormatter`
 * interface, not a chain.
 *
 * Domain rules (lint actions, tail guard) are mirrored from
 * `pipeline/fitness.ts` deliberately: the formatter must report the verdict
 * the pipeline reached, never a second opinion.
 */

import type {
  BenchmarkDistribution,
  LintViolation,
  MetricGoal,
  StepEvaluation,
} from "../index.js";

/** The linter rule id the pipeline uses to surface typecheck failures. */
export const TYPECHECK_SENTINEL_RULE = "perfgym:typecheck";

/** LLD §6.1 rule text for the minimize (latency/size) tail guard. */
export const MINIMIZE_TAIL_GUARD_RULE = "Current_p99 <= Baseline_p50 + 3 * Baseline_MAD";

/** The maximize (throughput/ops) counterpart, as implemented by the pipeline. */
export const MAXIMIZE_TAIL_GUARD_RULE = "Current_min >= Baseline_p50 - 3 * Baseline_MAD";

/** Backwards-compatible alias for the default (minimize) rule. */
export const TAIL_GUARD_RULE = MINIMIZE_TAIL_GUARD_RULE;

export type LintAction = "disqualify" | "penalize";

export interface DistributionJson {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  stddev: number;
  mad: number;
  iqr: number;
  sampleCount: number;
}

export interface LintMatchJson {
  ruleId: string;
  file: string;
  line: number;
  column: number | null;
  message: string;
  penalty: number;
  action: LintAction;
  codeSnippet: string | null;
}

export interface TailGuardJson {
  passed: boolean | null;
  madCeiling: number | null;
  rule: string;
}

export interface ErrorJson {
  name: string;
  code: string | null;
  message: string;
}

/** Strip CSI/ANSI escapes from forwarded subprocess output (test runners colourise by default). */
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export const stripAnsi = (text: string): string => text.replace(ANSI_ESCAPE, "");

/**
 * Strip ANSI from every string inside a JSON-shaped value.
 *
 * `render` only governs colour the CLI itself adds; escapes that arrive from
 * subprocess output survive `JSON.stringify` (as `\u001b`) and are restored by
 * the consumer's `JSON.parse`. Deep-clean the payload before serialising it.
 */
export const stripAnsiDeep = <T>(value: T): T => {
  if (typeof value === "string") {
    return stripAnsi(value) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stripAnsiDeep(item)) as unknown as T;
  }

  if (typeof value === "object" && value !== null) {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const cleaned: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        cleaned[key] = stripAnsiDeep(item);
      }
      return cleaned as unknown as T;
    }
  }

  return value;
};

export const toDistributionJson = (distribution: BenchmarkDistribution): DistributionJson => ({
  p50: distribution.p50,
  p90: distribution.p90,
  p95: distribution.p95,
  p99: distribution.p99,
  min: distribution.min,
  max: distribution.max,
  stddev: distribution.stddev,
  mad: distribution.mad,
  iqr: distribution.iqr,
  sampleCount: distribution.sampleCount,
});

/**
 * An omitted action means `penalize` — matching `sumPenalties` in
 * `pipeline/fitness.ts`. Only an explicit `disqualify` disqualifies.
 */
export const resolveLintAction = (violation: LintViolation): LintAction =>
  violation.action ?? "penalize";

export const toLintMatchJson = (violation: LintViolation): LintMatchJson => ({
  ruleId: violation.ruleId,
  file: violation.file,
  line: violation.line,
  // Neither column nor a code snippet is carried on LintViolation today.
  column: null,
  message: stripAnsi(violation.message),
  penalty: violation.penalty,
  action: resolveLintAction(violation),
  codeSnippet: null,
});

export const totalPenaltyOf = (violations: readonly LintViolation[]): number =>
  violations.reduce((sum, violation) => sum + violation.penalty, 0);

export const roundToCents = (value: number): number => Math.round(value * 100) / 100;

export const typecheckFailuresOf = (evaluation: StepEvaluation): readonly LintViolation[] =>
  evaluation.violations.filter((violation) => violation.ruleId === TYPECHECK_SENTINEL_RULE);

/**
 * AST-linter violations only. The pipeline injects typecheck-gate failures as
 * synthetic violations under `perfgym:typecheck`; those belong to the
 * `typecheck` block (LLD §6.1) and must not be double-reported as AST matches.
 */
export const astViolationsOf = (violations: readonly LintViolation[]): readonly LintViolation[] =>
  violations.filter((violation) => violation.ruleId !== TYPECHECK_SENTINEL_RULE);

/**
 * Tail guard, mirroring `computeFitnessVerdict`:
 * - minimize: reject when current p99 > baseline p50 + 3 × MAD;
 * - maximize: reject when current min < baseline p50 - 3 × MAD;
 * - non-finite statistics cannot be judged and do not fail.
 *
 * Without a configured goal the verdict is unknowable, so `passed` and
 * `madCeiling` stay `null` rather than guessing a direction.
 */
export const tailGuardOf = (
  baseline: BenchmarkDistribution | null | undefined,
  current: BenchmarkDistribution | null | undefined,
  goal: MetricGoal | null,
): TailGuardJson => {
  if (goal === null) {
    return { passed: null, madCeiling: null, rule: MINIMIZE_TAIL_GUARD_RULE };
  }

  const rule = goal === "maximize" ? MAXIMIZE_TAIL_GUARD_RULE : MINIMIZE_TAIL_GUARD_RULE;

  if (baseline === null || baseline === undefined || current === null || current === undefined) {
    return { passed: null, madCeiling: null, rule };
  }

  const ceiling =
    goal === "maximize" ? baseline.p50 - 3 * baseline.mad : baseline.p50 + 3 * baseline.mad;
  const observed = goal === "maximize" ? current.min : current.p99;

  // Compare against the raw ceiling: rounding before comparison would flip
  // verdicts within ±0.005 of the boundary.
  let passed = true;
  if (Number.isFinite(ceiling) && Number.isFinite(observed)) {
    if (goal === "maximize") {
      passed = !(observed < ceiling);
    } else {
      passed = !(observed > ceiling);
    }
  }

  return { passed, madCeiling: ceiling, rule };
};

export const describeError = (error: unknown): ErrorJson => {
  if (error instanceof Error) {
    // Effect `Data.TaggedError` values extend Error, so the `_tag` fallback
    // must match the plain-object branch: same domain error, same `code`.
    const candidate = error as { code?: unknown; _tag?: unknown };

    let code: string | null = null;
    if (typeof candidate.code === "string") {
      code = candidate.code;
    } else if (typeof candidate._tag === "string") {
      code = candidate._tag;
    }

    return {
      name: error.name,
      code,
      // Messages often embed raw subprocess output; consumers must never get ANSI.
      message: stripAnsi(error.message),
    };
  }

  if (typeof error === "object" && error !== null) {
    const candidate = error as { _tag?: unknown; code?: unknown; message?: unknown };

    let name = "UnknownError";
    if (typeof candidate._tag === "string") {
      name = candidate._tag;
    } else if (typeof candidate.code === "string") {
      name = candidate.code;
    }

    let code: string | null = null;
    if (typeof candidate.code === "string") {
      code = candidate.code;
    } else if (typeof candidate._tag === "string") {
      code = candidate._tag;
    }

    return {
      name,
      code,
      message: stripAnsi(
        typeof candidate.message === "string" ? candidate.message : String(error),
      ),
    };
  }

  return { name: "UnknownError", code: null, message: stripAnsi(String(error)) };
};
