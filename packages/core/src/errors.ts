import { Data } from "effect";

/**
 * ============================================================================
 * Sandbox & Workspace Errors
 * ============================================================================
 */

export const ERR_PATH_TRAVERSAL = "ERR_PATH_TRAVERSAL";

export class PathTraversalError extends Data.TaggedError("PathTraversalError")<{
  readonly code: typeof ERR_PATH_TRAVERSAL;
  readonly relPath: string;
  readonly allowedGlobs: readonly string[];
  readonly message: string;
}> {}

export const ERR_PATH_OUTSIDE_TARGET = "ERR_PATH_OUTSIDE_TARGET";

export class PathOutsideTargetError extends Data.TaggedError("PathOutsideTargetError")<{
  readonly code: typeof ERR_PATH_OUTSIDE_TARGET;
  readonly relPath: string;
  readonly allowedGlobs: readonly string[];
  readonly message: string;
}> {}

export const ERR_FILE_NOT_FOUND = "ERR_FILE_NOT_FOUND";

export class FileNotFoundError extends Data.TaggedError("FileNotFoundError")<{
  readonly code: typeof ERR_FILE_NOT_FOUND;
  readonly relPath: string;
  readonly message: string;
}> {}

export class SandboxLockBusyError extends Data.TaggedError("SandboxLockBusyError")<{
  readonly lockDir: string;
  readonly holderPid: number;
  readonly startTime: number;
  readonly message: string;
}> {}

export const ERR_SANDBOX_LOCK_NOT_HELD = "ERR_SANDBOX_LOCK_NOT_HELD";

/** Contract violation: a sandbox operation ran while the lock is not held. */
export class SandboxLockNotHeldError extends Data.TaggedError("SandboxLockNotHeldError")<{
  readonly code: typeof ERR_SANDBOX_LOCK_NOT_HELD;
  readonly operation: string;
  readonly message: string;
}> {}

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
  readonly message: string;
}> {}

export class WorktreeNotFoundError extends Data.TaggedError("WorktreeNotFoundError")<{
  readonly worktreeDir: string;
  readonly message: string;
}> {}

export const ERR_INVALID_RUN_ID = "ERR_INVALID_RUN_ID";

/** A runId failed the `[a-zA-Z0-9_-]+` contract required for worktree paths. */
export class InvalidRunIdError extends Data.TaggedError("InvalidRunIdError")<{
  readonly code: typeof ERR_INVALID_RUN_ID;
  readonly runId: string;
  readonly message: string;
}> {}

export const ERR_WORKTREE_DISK_BUDGET_EXCEEDED = "ERR_WORKTREE_DISK_BUDGET_EXCEEDED";

/** The worktree directory outgrew its configured disk cap. */
export class WorktreeDiskBudgetExceededError extends Data.TaggedError("WorktreeDiskBudgetExceededError")<{
  readonly code: typeof ERR_WORKTREE_DISK_BUDGET_EXCEEDED;
  readonly worktreeDir: string;
  readonly capBytes: number;
  readonly usedBytes: number;
  readonly message: string;
}> {}

/**
 * ============================================================================
 * Anti-Cheating, Integrity & Linter Errors
 * ============================================================================
 */

export class TamperingError extends Data.TaggedError("TamperingError")<{
  readonly targetFile: string;
  readonly baselineHash: string;
  readonly currentHash: string;
  readonly message: string;
}> {}

export class DisqualificationError extends Data.TaggedError("DisqualificationError")<{
  readonly ruleId: string;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}> {}

export class TypecheckError extends Data.TaggedError("TypecheckError")<{
  readonly tier: "fast-syntax" | "full-project";
  readonly errors: readonly string[];
  readonly message: string;
}> {}

/**
 * ============================================================================
 * Configuration Errors
 * ============================================================================
 */

export const ERR_CONFIG = "ERR_CONFIG";

/** `.perfgym.yaml` is missing or does not parse/validate. */
export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly code: typeof ERR_CONFIG;
  readonly configPath: string;
  readonly reason: "missing" | "invalid";
  readonly message: string;
}> {}

/**
 * ============================================================================
 * Pipeline, Invariants & Benchmarking Errors
 * ============================================================================
 */

export class InvariantFailureError extends Data.TaggedError("InvariantFailureError")<{
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly retriesUsed: number;
  readonly message: string;
  readonly blocked?: boolean;
  readonly deniedCapability?: string;
  readonly backend?: string;
}> {}

export class BenchmarkExecutionError extends Data.TaggedError("BenchmarkExecutionError")<{
  readonly command: string;
  readonly error: string;
  readonly rawOutput?: string;
  readonly message: string;
  readonly blocked?: boolean;
  readonly backend?: string;
}> {}

export class TailGuardRegressionError extends Data.TaggedError("TailGuardRegressionError")<{
  readonly metric: string;
  readonly currentP99: number;
  readonly maxAllowedCeiling: number;
  readonly baselineMad: number;
  readonly message: string;
}> {}

export class InsignificantDeltaError extends Data.TaggedError("InsignificantDeltaError")<{
  readonly deltaPercent: number;
  readonly minSignificanceThreshold: number;
  readonly message: string;
}> {}

/**
 * ============================================================================
 * LLM Driver Errors
 * ============================================================================
 */

export class UnknownDriverError extends Data.TaggedError("UnknownDriverError")<{
  readonly driverName: string;
  readonly message: string;
}> {}

export class MissingApiKeyError extends Data.TaggedError("MissingApiKeyError")<{
  readonly provider: string;
  readonly envVar: string;
  readonly message: string;
}> {}

export class LlmFatalError extends Data.TaggedError("LlmFatalError")<{
  readonly provider: string;
  readonly reason: string;
  readonly message: string;
}> {}

export const ERR_LLM_DRIVER = "ERR_LLM_DRIVER";

/** Provider call failed; `envVar` names the credential to fix auth failures. */
export type LlmDriverFailureClass = "transient" | "auth" | "bad-request" | "timeout";

export class LlmDriverError extends Data.TaggedError("LlmDriverError")<{
  readonly code: typeof ERR_LLM_DRIVER;
  readonly provider: string;
  readonly failureClass: LlmDriverFailureClass;
  readonly envVar?: string;
  readonly statusCode?: number;
  readonly message: string;
}> {}

export const ERR_LLM_PARSE = "ERR_LLM_PARSE";

/** Structured-output payload from the model could not be parsed. */
export class LlmParseError extends Data.TaggedError("LlmParseError")<{
  readonly code: typeof ERR_LLM_PARSE;
  readonly rawOutput: string;
  readonly detail?: string;
  readonly message: string;
}> {}

export const ERR_BUDGET_EXCEEDED = "ERR_BUDGET_EXCEEDED";

/** A run's cost/token cap was reached before the run completed. */
export class BudgetExceededError extends Data.TaggedError("BudgetExceededError")<{
  readonly code: typeof ERR_BUDGET_EXCEEDED;
  readonly metric: "cost" | "tokens";
  readonly cap: number;
  readonly used: number;
  readonly message: string;
}> {}

/**
 * ============================================================================
 * Session State Errors
 * ============================================================================
 */

export const ERR_SESSION_FLUSH = "ERR_SESSION_FLUSH";

/** A durable session-state flush failed (ADR-018: typed error channels). */
export class SessionFlushError extends Data.TaggedError("SessionFlushError")<{
  readonly code: typeof ERR_SESSION_FLUSH;
  readonly filePath: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * ============================================================================
 * Stable codes for pre-existing errors (shape frozen by rule: existing error
 * types are never changed)
 * ============================================================================
 *
 * These classes predate the `ERR_*` `code` field convention, and their
 * constructor signatures must stay untouched so no call site churns. The code
 * is therefore attached to each class *prototype*: declared types and
 * construction sites are unchanged, while every instance still answers `.code`
 * so the CLI/MCP edge can render `{ code, kind, message, details }`.
 */
export const ERR_SANDBOX_LOCK_BUSY = "ERR_SANDBOX_LOCK_BUSY";
export const ERR_GIT_COMMAND = "ERR_GIT_COMMAND";
export const ERR_WORKTREE_NOT_FOUND = "ERR_WORKTREE_NOT_FOUND";
export const ERR_TAMPERING = "ERR_TAMPERING";
export const ERR_DISQUALIFICATION = "ERR_DISQUALIFICATION";
export const ERR_TYPECHECK = "ERR_TYPECHECK";
export const ERR_INVARIANT_FAILURE = "ERR_INVARIANT_FAILURE";
export const ERR_BENCHMARK_EXECUTION = "ERR_BENCHMARK_EXECUTION";
export const ERR_TAIL_GUARD_REGRESSION = "ERR_TAIL_GUARD_REGRESSION";
export const ERR_INSIGNIFICANT_DELTA = "ERR_INSIGNIFICANT_DELTA";
export const ERR_UNKNOWN_DRIVER = "ERR_UNKNOWN_DRIVER";
export const ERR_MISSING_API_KEY = "ERR_MISSING_API_KEY";
export const ERR_LLM_FATAL = "ERR_LLM_FATAL";

const LEGACY_ERROR_CODE_ENTRIES = [
  [SandboxLockBusyError, ERR_SANDBOX_LOCK_BUSY],
  [GitCommandError, ERR_GIT_COMMAND],
  [WorktreeNotFoundError, ERR_WORKTREE_NOT_FOUND],
  [TamperingError, ERR_TAMPERING],
  [DisqualificationError, ERR_DISQUALIFICATION],
  [TypecheckError, ERR_TYPECHECK],
  [InvariantFailureError, ERR_INVARIANT_FAILURE],
  [BenchmarkExecutionError, ERR_BENCHMARK_EXECUTION],
  [TailGuardRegressionError, ERR_TAIL_GUARD_REGRESSION],
  [InsignificantDeltaError, ERR_INSIGNIFICANT_DELTA],
  [UnknownDriverError, ERR_UNKNOWN_DRIVER],
  [MissingApiKeyError, ERR_MISSING_API_KEY],
  [LlmFatalError, ERR_LLM_FATAL],
] as const;

for (const [ctor, code] of LEGACY_ERROR_CODE_ENTRIES) {
  Object.defineProperty(ctor.prototype, "code", {
    value: code,
    writable: true,
    enumerable: false,
    configurable: true,
  });
}

/**
 * Union of all PerfGym domain errors
 */
export type PerfGymDomainError =
  | PathTraversalError
  | PathOutsideTargetError
  | FileNotFoundError
  | SandboxLockBusyError
  | SandboxLockNotHeldError
  | GitCommandError
  | WorktreeNotFoundError
  | WorktreeDiskBudgetExceededError
  | InvalidRunIdError
  | ConfigError
  | TamperingError
  | DisqualificationError
  | TypecheckError
  | InvariantFailureError
  | BenchmarkExecutionError
  | TailGuardRegressionError
  | InsignificantDeltaError
  | UnknownDriverError
  | MissingApiKeyError
  | LlmFatalError
  | LlmDriverError
  | LlmParseError
  | BudgetExceededError
  | SessionFlushError;
