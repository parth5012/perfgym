/**
 * WorkspaceDriver Seam & Context Specification
 * Per $codebase-design and ADR-003, ADR-014, ADR-017, ADR-018
 *
 * ADR-018: every async operation returns an `Effect` whose failure channel
 * carries a tagged `PerfGymDomainError` — domain failures are values, never
 * exceptions. Effects are constructed here and executed only at the CLI/MCP
 * edge (`Effect.runPromise` never runs inside this seam).
 *
 * The one deliberate exception is `assertPathWhitelisted`: a synchronous
 * security assertion whose tagged raise is part of its contract.
 */

import type { Effect } from "effect";
import type { PerfGymDomainError } from "../errors.js";

export interface WorkspaceContext {
  runId: string;
  workingDir: string;
  branchName: string;
  baseRef: string;
}

export interface WorkspaceDriver {
  /**
   * Initializes the workspace sandbox for a given run and base git ref.
   */
  initialize(
    runId: string,
    baseRef: string
  ): Effect.Effect<WorkspaceContext, PerfGymDomainError, never>;

  /**
   * Writes content to a file inside the isolated workspace.
   * Enforces target file whitelist boundaries.
   */
  writeFile(relPath: string, content: string): Effect.Effect<void, PerfGymDomainError, never>;

  /**
   * Reads content of a file inside the isolated workspace.
   */
  readFile(relPath: string): Effect.Effect<string, PerfGymDomainError, never>;

  /**
   * Checks if a file exists inside the isolated workspace.
   */
  fileExists(relPath: string): Effect.Effect<boolean, PerfGymDomainError, never>;

  /**
   * Asserts that a relative path is strictly whitelisted in the target mutation boundary.
   * Raises PathTraversalError (ERR_PATH_TRAVERSAL) if escaping or PathOutsideTargetError (ERR_PATH_OUTSIDE_TARGET) if unauthorized.
   * This synchronous tagged raise is the single exception to the Effect contract (ADR-018).
   */
  assertPathWhitelisted(relPath: string): void;

  /**
   * Scans the working directory state to verify that no files outside the whitelisted
   * boundaries have been modified, created, or deleted (e.g. by direct agent shell commands).
   * Fails with PathOutsideTargetError if any non-whitelisted path was mutated.
   */
  verifyBlastRadius(): Effect.Effect<void, PerfGymDomainError, never>;

  /**
   * Atomically commits an accepted step mutation (commit-per-win).
   * Returns the commit hash or revision string.
   */
  commitStep(
    stepNumber: number,
    fitnessScore: number
  ): Effect.Effect<string, PerfGymDomainError, never>;

  /**
   * Rollbacks uncommitted or degrading mutations cleanly.
   * Restores pristine state of the current step baseline.
   */
  rollbackStep(): Effect.Effect<void, PerfGymDomainError, never>;

  /**
   * Promotes the winning worktree state to the specified target branch.
   */
  promote(targetBranch: string): Effect.Effect<void, PerfGymDomainError, never>;

  /**
   * Teardowns and frees worktree / sandbox resources.
   */
  teardown(): Effect.Effect<void, PerfGymDomainError, never>;

  /**
   * Returns the absolute path of the active working directory.
   */
  getWorkingDir(): string;
}
