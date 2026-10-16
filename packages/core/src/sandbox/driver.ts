/**
 * WorkspaceDriver Seam & Context Specification
 * Per $codebase-design and ADR-003, ADR-014, ADR-017
 */

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
  initialize(runId: string, baseRef: string): Promise<WorkspaceContext>;

  /**
   * Writes content to a file inside the isolated workspace.
   * Enforces target file whitelist boundaries.
   */
  writeFile(relPath: string, content: string): Promise<void>;

  /**
   * Reads content of a file inside the isolated workspace.
   */
  readFile(relPath: string): Promise<string>;

  /**
   * Checks if a file exists inside the isolated workspace.
   */
  fileExists(relPath: string): Promise<boolean>;

  /**
   * Asserts that a relative path is strictly whitelisted in the target mutation boundary.
   * Throws PathTraversalError (ERR_PATH_TRAVERSAL) if escaping or PathOutsideTargetError (ERR_PATH_OUTSIDE_TARGET) if unauthorized.
   */
  assertPathWhitelisted(relPath: string): void;

  /**
   * Atomically commits an accepted step mutation (commit-per-win).
   * Returns the commit hash or revision string.
   */
  commitStep(stepNumber: number, fitnessScore: number): Promise<string>;

  /**
   * Rollbacks uncommitted or degrading mutations cleanly.
   * Restores pristine state of the current step baseline.
   */
  rollbackStep(): Promise<void>;

  /**
   * Promotes the winning worktree state to the specified target branch.
   */
  promote(targetBranch: string): Promise<void>;

  /**
   * Teardowns and frees worktree / sandbox resources.
   */
  teardown(): Promise<void>;

  /**
   * Returns the absolute path of the active working directory.
   */
  getWorkingDir(): string;
}
