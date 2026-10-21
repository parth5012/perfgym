/**
 * @perfgym/core
 * OutputFormatter — one rendering seam for every PerfGym surface.
 *
 * The CLI, the MCP server and the autonomous runner all hand domain objects
 * to this interface instead of assembling console text or response bodies
 * themselves. Two adapters satisfy it: `MarkdownFormatter` (human-facing,
 * LLD §6.2) and `JsonFormatter` (machine-facing, LLD §6.1).
 *
 * Contract for every implementation:
 * - synchronous and pure: domain objects in, string out, no I/O;
 * - colour-agnostic: never emit ANSI — the CLI applies chalk around the
 *   finished string, and MCP/JSON consumers must never receive escape codes;
 * - absent data is `null`, never a fabricated zero.
 */

import { Data } from "effect";
import type {
  BenchmarkDistribution,
  InvariantResult,
  LintViolation,
  PerfGymConfig,
  StepEvaluation,
} from "../index.js";
import type { PerfGymSessionState, SessionLockState } from "../store/index.js";
import { JsonFormatter } from "./json.js";
import { MarkdownFormatter, type MarkdownFormatterOptions } from "./markdown.js";

export type OutputFormat = "markdown" | "json";

export const ERR_UNKNOWN_FORMAT = "ERR_UNKNOWN_FORMAT";

/** Raised when a caller reaches the factory with an unvalidated format string. */
export class UnknownFormatError extends Data.TaggedError("UnknownFormatError")<{
  readonly code: typeof ERR_UNKNOWN_FORMAT;
  readonly format: string;
  readonly message: string;
}> {}

export interface OutputFormatter {
  /** Which adapter this is — useful for callers that branch on colour/no-colour. */
  readonly format: OutputFormat;

  /**
   * A single evaluated candidate step (LLD §6.1 JSON / §6.2 markdown).
   * `config` is optional: when supplied, fields the evaluation cannot carry
   * (invariant command, metric target/goal) and the goal-dependent tail guard
   * are populated from it.
   */
  formatStep(evaluation: StepEvaluation, config?: PerfGymConfig): string;

  /** A recorded baseline distribution. */
  formatBaseline(distribution: BenchmarkDistribution, config?: PerfGymConfig): string;

  /** Session state plus the live lock, when one is held. */
  formatStatus(state: PerfGymSessionState, lock?: SessionLockState | null): string;

  /** Invariant-gate outcome. */
  formatTest(result: InvariantResult): string;

  /** AST linter violations (empty array = clean). */
  formatLint(violations: readonly LintViolation[]): string;

  /** A benchmark distribution, optionally against a baseline. */
  formatBenchmark(distribution: BenchmarkDistribution, baseline?: BenchmarkDistribution): string;

  /** Any thrown or tagged error, rendered without leaking stack traces. */
  formatError(error: unknown): string;
}

/**
 * Resolve an adapter once per process/command. `options` only affects the
 * markdown adapter's optional negative-memory dependency; the JSON adapter is
 * pure and ignores it.
 */
export function createFormatter(
  format: OutputFormat,
  options?: MarkdownFormatterOptions,
): OutputFormatter {
  switch (format) {
    case "markdown":
      return new MarkdownFormatter(options);
    case "json":
      return new JsonFormatter();
    default:
      throw new UnknownFormatError({
        code: ERR_UNKNOWN_FORMAT,
        format: String(format),
        message: `Unknown output format "${String(
          format,
        )}" — expected "markdown" or "json".`,
      });
  }
}

export { JsonFormatter } from "./json.js";
export type { StepEvaluationJson } from "./json.js";
export { MarkdownFormatter } from "./markdown.js";
export type { MarkdownFormatterOptions, NegativeMemoryEntry } from "./markdown.js";
export {
  MAXIMIZE_TAIL_GUARD_RULE,
  MINIMIZE_TAIL_GUARD_RULE,
  TAIL_GUARD_RULE,
  TYPECHECK_SENTINEL_RULE,
  astViolationsOf,
  describeError,
  resolveLintAction,
  roundToCents,
  stripAnsi,
  stripAnsiDeep,
  tailGuardOf,
  toDistributionJson,
  toLintMatchJson,
  totalPenaltyOf,
  typecheckFailuresOf,
} from "./shared.js";
export type { DistributionJson, ErrorJson, LintAction, LintMatchJson, TailGuardJson } from "./shared.js";
