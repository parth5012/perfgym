import { Effect } from "effect";
import type { WorkspaceDriver, WorkspaceContext } from "./driver.js";
import {
  PathOutsideTargetError,
  PathTraversalError,
  FileNotFoundError,
  WorktreeNotFoundError,
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

  const isWin = process.platform === "win32";
  if (isWin ? normPattern.toLowerCase() === normPath.toLowerCase() : normPattern === normPath) {
    return true;
  }

  const regexStr = normPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\?/g, "[^/]")
    .replace(/\/\*\*\//g, "___SLASH_GLOBSTAR_SLASH___")
    .replace(/\/\*\*$/g, "___SLASH_GLOBSTAR_END___")
    .replace(/^\*\*\//g, "___GLOBSTAR_SLASH_START___")
    .replace(/\*\*/g, "___GLOBSTAR___")
    .replace(/\*/g, "[^/]*")
    .replace(/___GLOBSTAR___/g, ".*")
    .replace(/___SLASH_GLOBSTAR_SLASH___/g, "/(?:.*/)?")
    .replace(/___SLASH_GLOBSTAR_END___/g, "(?:/.*)?")
    .replace(/___GLOBSTAR_SLASH_START___/g, "(?:.*/)?");

  return new RegExp(`^${regexStr}$`, isWin ? "i" : "").test(normPath);
}

export class InMemorySandboxDriver implements WorkspaceDriver {
  private context: WorkspaceContext | null = null;
  private allowedGlobs: string[];
  private initialFiles: Map<string, string> = new Map();
  private files: Map<string, string> = new Map();
  private lastCommittedFiles: Map<string, string> = new Map();
  private commits: InMemoryCommit[] = [];
  private promotedBranch: string | null = null;
  private tornDown = false;

  constructor(options: InMemoryDriverOptions = {}) {
    this.allowedGlobs = options.allowedGlobs ?? ["src/**/*"];
    if (options.initialFiles) {
      if (options.initialFiles instanceof Map) {
        for (const [k, v] of options.initialFiles.entries()) {
          this.initialFiles.set(k.replace(/\\/g, "/"), v);
        }
      } else {
        for (const [k, v] of Object.entries(options.initialFiles)) {
          this.initialFiles.set(k.replace(/\\/g, "/"), v);
        }
      }
      this.files = new Map(this.initialFiles);
      this.lastCommittedFiles = new Map(this.files);
    }
  }

  /**
   * ADR-018: the torn-down guard that used to raise a plain Error now surfaces
   * as a tagged WorktreeNotFoundError on the Effect failure channel.
   */
  private lifecycleViolation(operation: string): WorktreeNotFoundError | null {
    if (!this.tornDown) return null;
    return new WorktreeNotFoundError({
      worktreeDir: this.context?.workingDir ?? "",
      message: `Cannot ${operation} torn down InMemorySandboxDriver`,
    });
  }

  /** Path traversal check shared by assertPathWhitelisted and readFile. */
  private traversalViolation(relPath: string): PathTraversalError | null {
    const normalized = relPath.replace(/\\/g, "/");

    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:[\\/]/.test(relPath) ||
      normalized.split("/").some((segment) => segment === "..") ||
      normalized.includes("../") ||
      normalized.startsWith("../")
    ) {
      return new PathTraversalError({
        code: ERR_PATH_TRAVERSAL,
        relPath,
        allowedGlobs: this.allowedGlobs,
        message: `Security violation: Path traversal sequence detected in '${relPath}'.`,
      });
    }
    return null;
  }

  /** Full whitelist check: traversal + allowed target globs. */
  private whitelistViolation(relPath: string): PathTraversalError | PathOutsideTargetError | null {
    const traversal = this.traversalViolation(relPath);
    if (traversal) return traversal;

    const normalized = relPath.replace(/\\/g, "/");
    const isWhitelisted = this.allowedGlobs.some((glob) => matchesGlob(glob, normalized));

    if (!isWhitelisted) {
      return new PathOutsideTargetError({
        code: ERR_PATH_OUTSIDE_TARGET,
        relPath,
        allowedGlobs: this.allowedGlobs,
        message: `File path '${relPath}' is outside the authorized mutation boundary.`,
      });
    }
    return null;
  }

  public initialize(runId: string, baseRef: string): Effect.Effect<WorkspaceContext, never, never> {
    return Effect.sync(() => {
      const context: WorkspaceContext = {
        runId,
        workingDir: `/virtual/worktrees/${runId}`,
        branchName: `perfgym/eval-${runId}`,
        baseRef,
      };
      this.context = context;
      this.files = new Map(this.initialFiles);
      this.lastCommittedFiles = new Map(this.files);
      this.commits = [];
      this.promotedBranch = null;
      this.tornDown = false;
      return context;
    });
  }

  public assertPathWhitelisted(relPath: string): void {
    const violation = this.whitelistViolation(relPath);
    if (violation) {
      throw violation;
    }
  }

  public writeFile(
    relPath: string,
    content: string
  ): Effect.Effect<void, WorktreeNotFoundError | PathTraversalError | PathOutsideTargetError, never> {
    const self = this;
    return Effect.gen(function* () {
      const lifecycle = self.lifecycleViolation("write to");
      if (lifecycle) {
        return yield* Effect.fail(lifecycle);
      }
      const violation = self.whitelistViolation(relPath);
      if (violation) {
        return yield* Effect.fail(violation);
      }
      const normalized = relPath.replace(/\\/g, "/");
      self.files.set(normalized, content);
    });
  }

  public readFile(
    relPath: string
  ): Effect.Effect<string, WorktreeNotFoundError | PathTraversalError | FileNotFoundError, never> {
    const self = this;
    return Effect.gen(function* () {
      const lifecycle = self.lifecycleViolation("read from");
      if (lifecycle) {
        return yield* Effect.fail(lifecycle);
      }
      const traversal = self.traversalViolation(relPath);
      if (traversal) {
        return yield* Effect.fail(traversal);
      }

      const normalized = relPath.replace(/\\/g, "/");
      if (!self.files.has(normalized)) {
        return yield* Effect.fail(
          new FileNotFoundError({
            code: ERR_FILE_NOT_FOUND,
            relPath,
            message: `Virtual file '${relPath}' not found in workspace sandbox.`,
          })
        );
      }
      return self.files.get(normalized)!;
    });
  }

  public fileExists(relPath: string): Effect.Effect<boolean, never, never> {
    const normalized = relPath.replace(/\\/g, "/");
    return Effect.sync(() => this.files.has(normalized));
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

  public verifyBlastRadius(): Effect.Effect<
    void,
    WorktreeNotFoundError | PathOutsideTargetError,
    never
  > {
    const self = this;
    return Effect.gen(function* () {
      const lifecycle = self.lifecycleViolation("verify blast radius on");
      if (lifecycle) {
        return yield* Effect.fail(lifecycle);
      }

      // Check all files that differ from last committed state
      const allKeys = new Set([...self.files.keys(), ...self.lastCommittedFiles.keys()]);
      for (const key of allKeys) {
        const current = self.files.get(key);
        const committed = self.lastCommittedFiles.get(key);

        if (current !== committed) {
          const isWhitelisted = self.allowedGlobs.some((glob) => matchesGlob(glob, key));
          if (!isWhitelisted) {
            return yield* Effect.fail(
              new PathOutsideTargetError({
                code: ERR_PATH_OUTSIDE_TARGET,
                relPath: key,
                allowedGlobs: self.allowedGlobs,
                message: `Blast radius violation: Direct mutation detected outside allowed whitelist: '${key}'.`,
              })
            );
          }
        }
      }
    });
  }

  public commitStep(
    stepNumber: number,
    fitnessScore: number
  ): Effect.Effect<string, WorktreeNotFoundError | PathOutsideTargetError, never> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.verifyBlastRadius();
      return self.checkpoint(stepNumber, fitnessScore);
    });
  }

  /**
   * Restores the FULL virtual state (current files AND last-committed snapshot)
   * to the given map. Typed accessor (F8) for the coordinator's snapshot
   * restore in Ticket #43 — replaces previous untyped field pokes.
   */
  public restoreFullSnapshot(files: ReadonlyMap<string, string>): void {
    const copy = new Map(files);
    this.files = new Map(copy);
    this.lastCommittedFiles = new Map(copy);
  }

  /**
   * Restores virtual file state to the latest snapshot/checkpoint.
   */
  public rollback(): void {
    this.files = new Map(this.lastCommittedFiles);
  }

  public rollbackStep(): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      this.rollback();
    });
  }

  public promote(targetBranch: string): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      this.promotedBranch = targetBranch;
    });
  }

  public teardown(): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      this.tornDown = true;
      this.files.clear();
      this.lastCommittedFiles.clear();
    });
  }

  public getWorkingDir(): string {
    return this.context?.workingDir ?? "";
  }

  public getContext(): WorkspaceContext | null {
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
