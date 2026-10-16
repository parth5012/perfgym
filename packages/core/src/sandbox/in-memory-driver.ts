import type { WorkspaceDriver, WorkspaceContext } from "./driver.js";
import {
  PathOutsideTargetError,
  PathTraversalError,
  FileNotFoundError,
  ERR_PATH_OUTSIDE_TARGET,
  ERR_PATH_TRAVERSAL,
  ERR_FILE_NOT_FOUND,
} from "../errors.js";

export interface InMemoryDriverOptions {
  allowedGlobs?: string[];
  initialFiles?: Record<string, string> | Map<string, string>;
}

export interface InMemoryCommit {
  hash: string;
  stepNumber: number;
  fitnessScore: number;
  timestamp: number;
}

function matchesGlob(pattern: string, targetPath: string): boolean {
  const normPattern = pattern.replace(/\\/g, "/");
  const normPath = targetPath.replace(/\\/g, "/");

  if (normPattern === normPath) return true;

  const regexStr = normPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\/\*\*\//g, "___SLASH_GLOBSTAR_SLASH___")
    .replace(/\/\*\*$/g, "___SLASH_GLOBSTAR_END___")
    .replace(/^\*\*\//g, "___GLOBSTAR_SLASH_START___")
    .replace(/\*\*/g, "___GLOBSTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___GLOBSTAR___/g, ".*")
    .replace(/___SLASH_GLOBSTAR_SLASH___/g, "/(?:.*/)?")
    .replace(/___SLASH_GLOBSTAR_END___/g, "(?:/.*)?")
    .replace(/___GLOBSTAR_SLASH_START___/g, "(?:.*/)?");

  return new RegExp(`^${regexStr}$`).test(normPath);
}

export class InMemorySandboxDriver implements WorkspaceDriver {
  private context: WorkspaceContext | null = null;
  private allowedGlobs: string[];
  private files: Map<string, string> = new Map();
  private lastCommittedFiles: Map<string, string> = new Map();
  private commits: InMemoryCommit[] = [];
  private promotedBranch: string | null = null;
  private tornDown = false;

  constructor(options: InMemoryDriverOptions = {}) {
    this.allowedGlobs = options.allowedGlobs ?? ["src/**/*"];
    if (options.initialFiles) {
      if (options.initialFiles instanceof Map) {
        this.files = new Map(options.initialFiles);
      } else {
        for (const [k, v] of Object.entries(options.initialFiles)) {
          this.files.set(k.replace(/\\/g, "/"), v);
        }
      }
      this.lastCommittedFiles = new Map(this.files);
    }
  }

  public async initialize(runId: string, baseRef: string): Promise<WorkspaceContext> {
    this.context = {
      runId,
      workingDir: `/virtual/worktrees/${runId}`,
      branchName: `perfgym/eval-${runId}`,
      baseRef,
    };
    this.lastCommittedFiles = new Map(this.files);
    this.tornDown = false;
    return this.context;
  }

  public assertPathWhitelisted(relPath: string): void {
    const normalized = relPath.replace(/\\/g, "/");

    // 1. Path traversal & absolute path check (POSIX + Windows drive letters)
    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:[\\/]/.test(relPath) ||
      normalized.split("/").some((segment) => segment === "..") ||
      normalized.includes("../") ||
      normalized.startsWith("../")
    ) {
      throw new PathTraversalError({
        code: ERR_PATH_TRAVERSAL,
        relPath,
        allowedGlobs: this.allowedGlobs,
        message: `Security violation: Path traversal sequence detected in '${relPath}'.`,
      });
    }

    // 2. Allowed target globs check
    const isWhitelisted = this.allowedGlobs.some((glob) => matchesGlob(glob, normalized));

    if (!isWhitelisted) {
      throw new PathOutsideTargetError({
        code: ERR_PATH_OUTSIDE_TARGET,
        relPath,
        allowedGlobs: this.allowedGlobs,
        message: `File path '${relPath}' is outside the authorized mutation boundary.`,
      });
    }
  }

  public async writeFile(relPath: string, content: string): Promise<void> {
    if (this.tornDown) {
      throw new Error("Cannot write to torn down InMemorySandboxDriver");
    }
    this.assertPathWhitelisted(relPath);
    const normalized = relPath.replace(/\\/g, "/");
    this.files.set(normalized, content);
  }

  public async readFile(relPath: string): Promise<string> {
    if (this.tornDown) {
      throw new Error("Cannot read from torn down InMemorySandboxDriver");
    }
    const normalized = relPath.replace(/\\/g, "/");
    // Traversal check
    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:[\\/]/.test(relPath) ||
      normalized.split("/").some((segment) => segment === "..") ||
      normalized.includes("..")
    ) {
      throw new PathTraversalError({
        code: ERR_PATH_TRAVERSAL,
        relPath,
        allowedGlobs: this.allowedGlobs,
        message: `Security violation: Path traversal sequence detected in '${relPath}'.`,
      });
    }

    if (!this.files.has(normalized)) {
      throw new FileNotFoundError({
        code: ERR_FILE_NOT_FOUND,
        relPath,
        message: `Virtual file '${relPath}' not found in workspace sandbox.`,
      });
    }
    return this.files.get(normalized)!;
  }

  public async fileExists(relPath: string): Promise<boolean> {
    const normalized = relPath.replace(/\\/g, "/");
    return this.files.has(normalized);
  }

  /**
   * Captures an in-memory snapshot of the current virtual file state.
   */
  public snapshot(): Map<string, string> {
    this.lastCommittedFiles = new Map(this.files);
    return new Map(this.lastCommittedFiles);
  }

  /**
   * Alias for commitStep / snapshot recording.
   */
  public checkpoint(stepNumber = 0, fitnessScore = 0): string {
    const hex = Math.random().toString(16).slice(2).padEnd(8, "0").slice(0, 8);
    const pseudoHash = `sim-${hex}`;
    this.lastCommittedFiles = new Map(this.files);
    this.commits.push({
      hash: pseudoHash,
      stepNumber,
      fitnessScore,
      timestamp: Date.now(),
    });
    return pseudoHash;
  }

  public async commitStep(stepNumber: number, fitnessScore: number): Promise<string> {
    return this.checkpoint(stepNumber, fitnessScore);
  }

  /**
   * Restores virtual file state to the latest snapshot/checkpoint.
   */
  public rollback(): void {
    this.files = new Map(this.lastCommittedFiles);
  }

  public async rollbackStep(): Promise<void> {
    this.rollback();
  }

  public async promote(targetBranch: string): Promise<void> {
    this.promotedBranch = targetBranch;
  }

  public async teardown(): Promise<void> {
    this.tornDown = true;
    this.files.clear();
    this.lastCommittedFiles.clear();
  }

  public getWorkingDir(): string {
    if (!this.context) {
      throw new Error("InMemorySandboxDriver has not been initialized.");
    }
    return this.context.workingDir;
  }

  public getContext(): WorkspaceContext {
    if (!this.context) {
      throw new Error("InMemorySandboxDriver has not been initialized.");
    }
    return this.context;
  }

  public getPromotedBranch(): string | null {
    return this.promotedBranch;
  }

  public isTornDown(): boolean {
    return this.tornDown;
  }

  public getFilesSnapshot(): ReadonlyMap<string, string> {
    return new Map(this.files);
  }
}
