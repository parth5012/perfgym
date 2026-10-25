import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Effect } from "effect";
import type { WorkspaceDriver, WorkspaceContext } from "./driver.js";
import {
  PathOutsideTargetError,
  PathTraversalError,
  FileNotFoundError,
  GitCommandError,
  InvalidRunIdError,
  WorktreeNotFoundError,
  ERR_PATH_OUTSIDE_TARGET,
  ERR_PATH_TRAVERSAL,
  ERR_FILE_NOT_FOUND,
  ERR_INVALID_RUN_ID,
} from "../errors.js";

export interface GitWorktreeDriverOptions {
  repoRoot?: string;
  worktreesDir?: string;
  allowedGlobs?: string[];
}

export function matchesGlob(pattern: string, targetPath: string): boolean {
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
    .replace(/___SLASH_GLOBSTAR_END___/g, "/(?:.*)?")
    .replace(/___GLOBSTAR_SLASH_START___/g, "/(?:.*/)?");

  return new RegExp(`^${regexStr}$`, isWin ? "i" : "").test(normPath);
}

/** Non-raising fs helpers used by the symlink / junction defence. */
function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

export class GitWorktreeDriver implements WorkspaceDriver {
  private repoRoot: string;
  private worktreesDir: string;
  private allowedGlobs: string[];
  private context: WorkspaceContext | null = null;
  private tornDown = false;

  constructor(options: GitWorktreeDriverOptions = {}) {
    this.repoRoot = path.resolve(options.repoRoot ?? process.cwd());
    this.worktreesDir = path.resolve(
      options.worktreesDir ?? path.join(this.repoRoot, ".perfgym", "worktrees")
    );
    this.allowedGlobs = options.allowedGlobs ?? ["src/**/*"];
  }

  private execGit(args: string[], cwd: string): Effect.Effect<string, GitCommandError, never> {
    return Effect.try({
      try: () =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim(),
      catch: (err: unknown) => {
        const e = err as { status?: number; stderr?: string | Buffer; message?: string };
        const stderrStr =
          typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf8") ?? "";
        return new GitCommandError({
          command: `git ${args.join(" ")}`,
          exitCode: e.status ?? 1,
          stderr: stderrStr,
          message: `Git command failed: 'git ${args.join(" ")}' (exit code ${e.status ?? 1}): ${stderrStr || e.message}`,
        });
      },
    });
  }

  /**
   * The driver lifecycle guard that used to raise a plain Error now surfaces
   * as a tagged WorktreeNotFoundError on the Effect failure channel (ADR-018).
   */
  private lifecycleViolation(): WorktreeNotFoundError | null {
    if (!this.tornDown && this.context) return null;
    return new WorktreeNotFoundError({
      worktreeDir: this.context?.workingDir ?? this.worktreesDir,
      message: "GitWorktreeDriver is not initialized or has been torn down.",
    });
  }

  public initialize(
    runId: string,
    baseRef: string
  ): Effect.Effect<WorkspaceContext, InvalidRunIdError | PathTraversalError | GitCommandError, never> {
    const self = this;
    return Effect.gen(function* () {
      if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
        return yield* Effect.fail(
          new InvalidRunIdError({
            code: ERR_INVALID_RUN_ID,
            runId,
            message: `Invalid runId '${runId}': must contain only alphanumeric characters, hyphens, or underscores.`,
          })
        );
      }

      const worktreePath = path.resolve(self.worktreesDir, runId);
      const relToRoot = path.relative(self.worktreesDir, worktreePath);
      if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
        return yield* Effect.fail(
          new PathTraversalError({
            code: ERR_PATH_TRAVERSAL,
            relPath: runId,
            allowedGlobs: [],
            message: `Security violation: runId '${runId}' resolves outside worktree root directory.`,
          })
        );
      }

      const branchName = `perfgym/eval-${runId}`;

      fs.mkdirSync(self.worktreesDir, { recursive: true });

      // Clean up any stale worktree at this path
      if (fs.existsSync(worktreePath)) {
        const removed = yield* Effect.match(
          self.execGit(["worktree", "remove", "--force", worktreePath], self.repoRoot),
          { onFailure: () => false, onSuccess: () => true }
        );
        if (!removed) {
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
        // Ignore prune error
        yield* Effect.match(self.execGit(["worktree", "prune"], self.repoRoot), {
          onFailure: () => null,
          onSuccess: () => null,
        });
      }

      // Allocate worktree directly off baseRef without touching developer's working directory
      yield* self.execGit(
        ["worktree", "add", "-B", branchName, worktreePath, baseRef],
        self.repoRoot
      );

      const context: WorkspaceContext = {
        runId,
        workingDir: worktreePath,
        branchName,
        baseRef,
      };
      self.context = context;
      self.tornDown = false;

      return context;
    });
  }

  private whitelistViolation(relPath: string): PathTraversalError | PathOutsideTargetError | null {
    const normalized = relPath.replace(/\\/g, "/");

    // 1. Path traversal & absolute path check (POSIX + Windows drive letters)
    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:/.test(relPath) ||
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

    // 2. Allowed target globs check
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

  public assertPathWhitelisted(relPath: string): void {
    const violation = this.whitelistViolation(relPath);
    if (violation) {
      throw violation;
    }
  }

  private resolveSafePath(
    relPath: string
  ): Effect.Effect<
    string,
    WorktreeNotFoundError | PathTraversalError | PathOutsideTargetError,
    never
  > {
    const lifecycle = this.lifecycleViolation();
    if (lifecycle) {
      return Effect.fail(lifecycle);
    }

    const normalized = relPath.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:/.test(relPath) ||
      normalized.split("/").some((segment) => segment === "..") ||
      normalized.includes("..")
    ) {
      return Effect.fail(
        new PathTraversalError({
          code: ERR_PATH_TRAVERSAL,
          relPath,
          allowedGlobs: this.allowedGlobs,
          message: `Security violation: Path traversal sequence detected in '${relPath}'.`,
        })
      );
    }

    const workingDir = this.context!.workingDir;
    const fullPath = path.resolve(workingDir, relPath);
    const rel = path.relative(workingDir, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return Effect.fail(
        new PathTraversalError({
          code: ERR_PATH_TRAVERSAL,
          relPath,
          allowedGlobs: this.allowedGlobs,
          message: `Security violation: Resolved path '${fullPath}' escapes working directory.`,
        })
      );
    }

    // Symlink and junction breakout defense:
    // Check every existing path component from workingDir to resolved target
    const segments = rel.split(/[\\/]/);
    let curr = workingDir;
    for (const segment of segments) {
      curr = path.join(curr, segment);
      if (fs.existsSync(curr)) {
        const lstat = lstatOrNull(curr);
        if (lstat?.isSymbolicLink()) {
          return Effect.fail(
            new PathTraversalError({
              code: ERR_PATH_TRAVERSAL,
              relPath,
              allowedGlobs: this.allowedGlobs,
              message: `Security violation: Symlink or junction point detected in path '${relPath}'.`,
            })
          );
        }
      }
    }

    // Verify realpath does not escape physical working directory
    const realWorkingDir = realpathOrNull(workingDir);
    const realFullPath = realpathOrNull(fullPath);
    if (realWorkingDir !== null && fs.existsSync(fullPath) && realFullPath !== null) {
      const realRel = path.relative(realWorkingDir, realFullPath);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        return Effect.fail(
          new PathOutsideTargetError({
            code: ERR_PATH_OUTSIDE_TARGET,
            relPath,
            allowedGlobs: this.allowedGlobs,
            message: `Security violation: Real filesystem path '${realFullPath}' escapes sandbox.`,
          })
        );
      }
    }

    return Effect.succeed(fullPath);
  }

  public writeFile(
    relPath: string,
    content: string
  ): Effect.Effect<
    void,
    PathTraversalError | PathOutsideTargetError | WorktreeNotFoundError,
    never
  > {
    const self = this;
    return Effect.gen(function* () {
      const violation = self.whitelistViolation(relPath);
      if (violation) {
        return yield* Effect.fail(violation);
      }
      const fullPath = yield* self.resolveSafePath(relPath);

      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf8");
    });
  }

  public readFile(
    relPath: string
  ): Effect.Effect<
    string,
    PathTraversalError | PathOutsideTargetError | WorktreeNotFoundError | FileNotFoundError,
    never
  > {
    const self = this;
    return Effect.gen(function* () {
      const fullPath = yield* self.resolveSafePath(relPath);

      if (!fs.existsSync(fullPath)) {
        return yield* Effect.fail(
          new FileNotFoundError({
            code: ERR_FILE_NOT_FOUND,
            relPath,
            message: `File '${relPath}' does not exist in worktree '${self.context!.workingDir}'.`,
          })
        );
      }

      return fs.readFileSync(fullPath, "utf8");
    });
  }

  public fileExists(relPath: string): Effect.Effect<boolean, never, never> {
    if (!this.context) return Effect.succeed(false);
    const self = this;
    return Effect.gen(function* () {
      const fullPath = yield* Effect.match(self.resolveSafePath(relPath), {
        onFailure: () => null,
        onSuccess: (resolved) => resolved,
      });
      if (fullPath === null) return false;
      return fs.existsSync(fullPath);
    });
  }

  public snapshot(): Effect.Effect<string, WorktreeNotFoundError | GitCommandError, never> {
    const lifecycle = this.lifecycleViolation();
    if (lifecycle) {
      return Effect.fail(lifecycle);
    }
    return this.execGit(["rev-parse", "HEAD"], this.context!.workingDir);
  }

  public verifyBlastRadius(): Effect.Effect<
    void,
    WorktreeNotFoundError | GitCommandError | PathOutsideTargetError,
    never
  > {
    const self = this;
    return Effect.gen(function* () {
      const lifecycle = self.lifecycleViolation();
      if (lifecycle) {
        return yield* Effect.fail(lifecycle);
      }

      // Inspect working directory status to detect any file modified, added, renamed, or untracked
      const statusOutput = yield* self.execGit(
        ["status", "--porcelain", "-uall"],
        self.context!.workingDir
      );

      const lines = statusOutput.split(/\r?\n/).filter((l) => l.trim().length > 0);
      for (const line of lines) {
        const match = line.match(/^[A-Z?0-9 ]{1,2}\s+(.*)$/);
        if (!match) continue;
        const rawEntry = match[1].trim().replace(/^"|"$/g, "");
        const filePath = rawEntry.includes(" -> ") ? rawEntry.split(" -> ")[1].trim() : rawEntry;
        const norm = filePath.replace(/\\/g, "/");

        const isWhitelisted = self.allowedGlobs.some((glob) => matchesGlob(glob, norm));
        if (!isWhitelisted) {
          return yield* Effect.fail(
            new PathOutsideTargetError({
              code: ERR_PATH_OUTSIDE_TARGET,
              relPath: filePath,
              allowedGlobs: self.allowedGlobs,
              message: `Blast radius violation: Direct file mutation detected outside allowed whitelist: '${filePath}'.`,
            })
          );
        }
      }
    });
  }

  public rollbackStep(): Effect.Effect<void, WorktreeNotFoundError | GitCommandError, never> {
    const self = this;
    return Effect.gen(function* () {
      const lifecycle = self.lifecycleViolation();
      if (lifecycle) {
        return yield* Effect.fail(lifecycle);
      }
      const workingDir = self.context!.workingDir;

      // Deep rollback: hard reset to HEAD and clean all untracked files with bounded retry for Windows EBUSY
      let attempts = 0;
      for (;;) {
        const failure = yield* Effect.match(
          Effect.flatMap(self.execGit(["reset", "--hard", "HEAD"], workingDir), () =>
            self.execGit(["clean", "-ffd"], workingDir)
          ),
          { onFailure: (err) => err, onSuccess: () => null }
        );
        if (failure === null) break;
        attempts++;
        if (attempts >= 3) return yield* Effect.fail(failure);
        // Bounded sleep (50ms) to give Windows OS file table / background processes time to release handles
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }

      // Ignore if repository has no submodules
      yield* Effect.match(
        Effect.flatMap(
          self.execGit(
            ["submodule", "foreach", "--recursive", "git", "reset", "--hard"],
            workingDir
          ),
          () => self.execGit(["submodule", "foreach", "--recursive", "git", "clean", "-ffd"], workingDir)
        ),
        { onFailure: () => null, onSuccess: () => null }
      );
    });
  }

  public commitStep(
    stepNumber: number,
    fitnessScore: number
  ): Effect.Effect<
    string,
    WorktreeNotFoundError | GitCommandError | PathOutsideTargetError,
    never
  > {
    const self = this;
    return Effect.gen(function* () {
      const lifecycle = self.lifecycleViolation();
      if (lifecycle) {
        return yield* Effect.fail(lifecycle);
      }

      // Verify blast radius before committing: reject if agent touched any file outside allowedGlobs
      yield* self.verifyBlastRadius();

      yield* self.execGit(["add", "-A"], self.context!.workingDir);
      yield* self.execGit(
        [
          "-c",
          "user.name=PerfGym Sentinel",
          "-c",
          "user.email=sentinel@perfgym.dev",
          "commit",
          "--allow-empty",
          "-m",
          `perfgym(step): mutation #${stepNumber} (fitness: ${fitnessScore})`,
        ],
        self.context!.workingDir
      );
      return yield* self.execGit(["rev-parse", "HEAD"], self.context!.workingDir);
    });
  }

  public promote(
    targetBranch: string
  ): Effect.Effect<
    void,
    WorktreeNotFoundError | GitCommandError,
    never
  > {
    const self = this;
    return Effect.gen(function* () {
      const lifecycle = self.lifecycleViolation();
      if (lifecycle) {
        return yield* Effect.fail(lifecycle);
      }

      const latestCommit = yield* self.execGit(
        ["rev-parse", "HEAD"],
        self.context!.workingDir
      );

      const oldTip = yield* Effect.match(
        self.execGit(["rev-parse", "--verify", `refs/heads/${targetBranch}`], self.repoRoot),
        { onFailure: () => null, onSuccess: (tip) => tip }
      );

      if (oldTip) {
        const isAncestor = yield* Effect.match(
          self.execGit(["merge-base", "--is-ancestor", oldTip, latestCommit], self.repoRoot),
          { onFailure: () => false, onSuccess: () => true }
        );
        if (!isAncestor) {
          return yield* Effect.fail(
            new GitCommandError({
              command: `git merge-base --is-ancestor ${oldTip} ${latestCommit}`,
              exitCode: 1,
              stderr: `not a fast-forward from '${targetBranch}' tip`,
              message: `Cannot promote to '${targetBranch}': worktree branch is not a fast-forward from current '${targetBranch}' tip.`,
            })
          );
        }
      }

      // Check if targetBranch is currently checked out in repoRoot
      const currentBranch = yield* Effect.match(
        self.execGit(["branch", "--show-current"], self.repoRoot),
        { onFailure: () => null, onSuccess: (branch) => branch }
      );

      if (currentBranch === targetBranch) {
        // Refuse to touch active working directory if it has dirty tracked files
        const dirty = yield* self.execGit(
          ["status", "--porcelain", "--untracked-files=no"],
          self.repoRoot
        );
        if (dirty) {
          return yield* Effect.fail(
            new GitCommandError({
              command: `git status --porcelain --untracked-files=no`,
              exitCode: 1,
              stderr: dirty,
              message: `Cannot promote to checked-out branch '${targetBranch}': working tree has uncommitted tracked changes.`,
            })
          );
        }
        yield* self.execGit(["merge", "--ff-only", latestCommit], self.repoRoot);
      } else {
        if (oldTip) {
          yield* self.execGit(
            ["update-ref", `refs/heads/${targetBranch}`, latestCommit, oldTip],
            self.repoRoot
          );
        } else {
          yield* self.execGit(
            ["update-ref", `refs/heads/${targetBranch}`, latestCommit],
            self.repoRoot
          );
        }
      }
    });
  }

  public teardown(): Effect.Effect<void, GitCommandError, never> {
    if (!this.context || this.tornDown) {
      return Effect.succeed(undefined);
    }

    const self = this;
    const worktreePath = this.context.workingDir;
    return Effect.gen(function* () {
      const removed = yield* Effect.match(
        self.execGit(["worktree", "remove", "--force", worktreePath], self.repoRoot),
        { onFailure: () => false, onSuccess: () => true }
      );
      if (!removed && fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }

      // Ignore prune failure
      yield* Effect.match(self.execGit(["worktree", "prune"], self.repoRoot), {
        onFailure: () => null,
        onSuccess: () => null,
      });

      self.tornDown = true;
    });
  }

  public getWorkingDir(): string {
    return this.context?.workingDir ?? "";
  }

  public getContext(): WorkspaceContext | null {
    return this.context;
  }
}
