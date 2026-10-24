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
}> {}

export class BenchmarkExecutionError extends Data.TaggedError("BenchmarkExecutionError")<{
  readonly command: string;
  readonly error: string;
  readonly rawOutput?: string;
  readonly message: string;
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
 * Union of all PerfGym domain errors
 */
export type PerfGymDomainError =
  | PathTraversalError
  | PathOutsideTargetError
  | FileNotFoundError
  | SandboxLockBusyError
  | GitCommandError
  | WorktreeNotFoundError
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
  | SessionFlushError;
