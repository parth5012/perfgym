import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { WorkspaceDriver, WorkspaceContext } from "./driver.js";
import {
  PathOutsideTargetError,
  PathTraversalError,
  FileNotFoundError,
  GitCommandError,
  ERR_PATH_OUTSIDE_TARGET,
  ERR_PATH_TRAVERSAL,
  ERR_FILE_NOT_FOUND,
} from "../errors.js";

export interface GitWorktreeDriverOptions {
  repoRoot?: string;
  worktreesDir?: string;
  allowedGlobs?: string[];
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

  private execGit(args: string[], cwd: string): string {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string | Buffer; message?: string };
      const stderrStr =
        typeof e.stderr === "string" ? e.stderr : e.stderr?.toString("utf8") ?? "";
      throw new GitCommandError({
        command: `git ${args.join(" ")}`,
        exitCode: e.status ?? 1,
        stderr: stderrStr,
        message: `Git command failed: 'git ${args.join(" ")}' (exit code ${e.status ?? 1}): ${stderrStr || e.message}`,
      });
    }
  }

  public async initialize(runId: string, baseRef: string): Promise<WorkspaceContext> {
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
      throw new Error(
        `Invalid runId '${runId}': must contain only alphanumeric characters, hyphens, or underscores.`
      );
    }

    const worktreePath = path.resolve(this.worktreesDir, runId);
    const relToRoot = path.relative(this.worktreesDir, worktreePath);
    if (relToRoot.startsWith("..") || path.isAbsolute(relToRoot)) {
      throw new PathTraversalError({
        code: ERR_PATH_TRAVERSAL,
        relPath: runId,
        allowedGlobs: [],
        message: `Security violation: runId '${runId}' resolves outside worktree root directory.`,
      });
    }

    const branchName = `perfgym/eval-${runId}`;

    fs.mkdirSync(this.worktreesDir, { recursive: true });

    // Clean up any stale worktree at this path
    if (fs.existsSync(worktreePath)) {
      try {
        this.execGit(["worktree", "remove", "--force", worktreePath], this.repoRoot);
      } catch {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      try {
        this.execGit(["worktree", "prune"], this.repoRoot);
      } catch {
        // Ignore prune error
      }
    }

    // Allocate worktree directly off baseRef without touching developer's working directory
    this.execGit(
      ["worktree", "add", "-B", branchName, worktreePath, baseRef],
      this.repoRoot
    );

    this.context = {
      runId,
      workingDir: worktreePath,
      branchName,
      baseRef,
    };
    this.tornDown = false;

    return this.context;
  }

  public assertPathWhitelisted(relPath: string): void {
    const normalized = relPath.replace(/\\/g, "/");

    // 1. Path traversal & absolute path check (POSIX + Windows drive letters)
    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:/.test(relPath) ||
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

  private resolveSafePath(relPath: string): string {
    if (this.tornDown || !this.context) {
      throw new Error("GitWorktreeDriver is not initialized or has been torn down.");
    }

    const normalized = relPath.replace(/\\/g, "/");
    if (
      normalized.startsWith("/") ||
      /^[a-zA-Z]:/.test(relPath) ||
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

    const workingDir = this.context.workingDir;
    const fullPath = path.resolve(workingDir, relPath);
    const rel = path.relative(workingDir, fullPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new PathTraversalError({
        code: ERR_PATH_TRAVERSAL,
        relPath,
        allowedGlobs: this.allowedGlobs,
        message: `Security violation: Resolved path '${fullPath}' escapes working directory.`,
      });
    }

    // Symlink and junction breakout defense:
    // Check every existing path component from workingDir to resolved target
    const segments = rel.split(/[\\/]/);
    let curr = workingDir;
    for (const segment of segments) {
      curr = path.join(curr, segment);
      if (fs.existsSync(curr)) {
        try {
          const lstat = fs.lstatSync(curr);
          if (lstat.isSymbolicLink()) {
            throw new PathTraversalError({
              code: ERR_PATH_TRAVERSAL,
              relPath,
              allowedGlobs: this.allowedGlobs,
              message: `Security violation: Symlink or junction point detected in path '${relPath}'.`,
            });
          }
        } catch (lstatErr) {
          if (lstatErr instanceof PathTraversalError) throw lstatErr;
        }
      }
    }

    // Verify realpath does not escape physical working directory
    try {
      const realWorkingDir = fs.realpathSync(workingDir);
      if (fs.existsSync(fullPath)) {
        const realFullPath = fs.realpathSync(fullPath);
        const realRel = path.relative(realWorkingDir, realFullPath);
        if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
          throw new PathOutsideTargetError({
            code: ERR_PATH_OUTSIDE_TARGET,
            relPath,
            allowedGlobs: this.allowedGlobs,
            message: `Security violation: Real filesystem path '${realFullPath}' escapes sandbox.`,
          });
        }
      }
    } catch (realErr) {
      if (realErr instanceof PathTraversalError || realErr instanceof PathOutsideTargetError) throw realErr;
    }

    return fullPath;
  }

  public async writeFile(relPath: string, content: string): Promise<void> {
    this.assertPathWhitelisted(relPath);
    const fullPath = this.resolveSafePath(relPath);

    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }

  public async readFile(relPath: string): Promise<string> {
    const fullPath = this.resolveSafePath(relPath);

    if (!fs.existsSync(fullPath)) {
      throw new FileNotFoundError({
        code: ERR_FILE_NOT_FOUND,
        relPath,
        message: `File '${relPath}' does not exist in worktree '${this.context!.workingDir}'.`,
      });
    }

    return fs.readFileSync(fullPath, "utf8");
  }

  public async fileExists(relPath: string): Promise<boolean> {
    if (!this.context) return false;
    try {
      const fullPath = this.resolveSafePath(relPath);
      return fs.existsSync(fullPath);
    } catch {
      return false;
    }
  }

  public snapshot(): string {
    if (this.tornDown || !this.context) {
      throw new Error("GitWorktreeDriver is not initialized or has been torn down.");
    }
    return this.execGit(["rev-parse", "HEAD"], this.context.workingDir);
  }

  public async verifyBlastRadius(): Promise<void> {
    if (this.tornDown || !this.context) {
      throw new Error("GitWorktreeDriver is not initialized or has been torn down.");
    }

    // Inspect working directory status to detect any file modified, added, renamed, or untracked
    const statusOutput = this.execGit(
      ["status", "--porcelain", "-uall"],
      this.context.workingDir
    );

    const lines = statusOutput.split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of lines) {
      const match = line.match(/^[A-Z?0-9 ]{1,2}\s+(.*)$/);
      if (!match) continue;
      const rawEntry = match[1].trim().replace(/^"|"$/g, "");
      const filePath = rawEntry.includes(" -> ") ? rawEntry.split(" -> ")[1].trim() : rawEntry;
      const norm = filePath.replace(/\\/g, "/");

      const isWhitelisted = this.allowedGlobs.some((glob) => matchesGlob(glob, norm));
      if (!isWhitelisted) {
        throw new PathOutsideTargetError({
          code: ERR_PATH_OUTSIDE_TARGET,
          relPath: filePath,
          allowedGlobs: this.allowedGlobs,
          message: `Blast radius violation: Direct file mutation detected outside allowed whitelist: '${filePath}'.`,
        });
      }
    }
  }

  public async rollbackStep(): Promise<void> {
    if (this.tornDown || !this.context) {
      throw new Error("GitWorktreeDriver is not initialized or has been torn down.");
    }
    // Deep rollback: hard reset to HEAD and clean all untracked files with bounded retry for Windows EBUSY
    let attempts = 0;
    while (attempts < 3) {
      try {
        this.execGit(["reset", "--hard", "HEAD"], this.context.workingDir);
        this.execGit(["clean", "-ffd"], this.context.workingDir);
        break;
      } catch (err) {
        attempts++;
        if (attempts >= 3) throw err;
        // Bounded sleep (50ms) to give Windows OS file table / background processes time to release handles
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }

    try {
      this.execGit(["submodule", "foreach", "--recursive", "git", "reset", "--hard"], this.context.workingDir);
      this.execGit(["submodule", "foreach", "--recursive", "git", "clean", "-ffd"], this.context.workingDir);
    } catch {
      // Ignore if repository has no submodules
    }
  }

  public async commitStep(stepNumber: number, fitnessScore: number): Promise<string> {
    if (this.tornDown || !this.context) {
      throw new Error("GitWorktreeDriver is not initialized or has been torn down.");
    }

    // Verify blast radius before committing: reject if agent touched any file outside allowedGlobs
    await this.verifyBlastRadius();

    this.execGit(["add", "-A"], this.context.workingDir);
    this.execGit(
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
      this.context.workingDir
    );
    const hash = this.execGit(["rev-parse", "HEAD"], this.context.workingDir);
    return hash;
  }

  public async promote(targetBranch: string): Promise<void> {
    if (this.tornDown || !this.context) {
      throw new Error("GitWorktreeDriver is not initialized or has been torn down.");
    }

    const latestCommit = this.execGit(["rev-parse", "HEAD"], this.context.workingDir);

    let oldTip: string | null = null;
    try {
      oldTip = this.execGit(["rev-parse", "--verify", `refs/heads/${targetBranch}`], this.repoRoot);
    } catch {
      // Target branch does not exist yet
    }

    if (oldTip) {
      try {
        this.execGit(["merge-base", "--is-ancestor", oldTip, latestCommit], this.repoRoot);
      } catch {
        throw new Error(
          `Cannot promote to '${targetBranch}': worktree branch is not a fast-forward from current '${targetBranch}' tip.`
        );
      }
    }

    // Check if targetBranch is currently checked out in repoRoot
    let currentBranch: string | null = null;
    try {
      currentBranch = this.execGit(["branch", "--show-current"], this.repoRoot);
    } catch {
      // Detached HEAD or unavailable
    }

    if (currentBranch === targetBranch) {
      // Refuse to touch active working directory if it has dirty tracked files
      const dirty = this.execGit(["status", "--porcelain", "--untracked-files=no"], this.repoRoot);
      if (dirty) {
        throw new Error(
          `Cannot promote to checked-out branch '${targetBranch}': working tree has uncommitted tracked changes.`
        );
      }
      this.execGit(["merge", "--ff-only", latestCommit], this.repoRoot);
    } else {
      if (oldTip) {
        this.execGit(["update-ref", `refs/heads/${targetBranch}`, latestCommit, oldTip], this.repoRoot);
      } else {
        this.execGit(["update-ref", `refs/heads/${targetBranch}`, latestCommit], this.repoRoot);
      }
    }
  }

  public async teardown(): Promise<void> {
    if (!this.context || this.tornDown) return;

    const worktreePath = this.context.workingDir;
    try {
      this.execGit(["worktree", "remove", "--force", worktreePath], this.repoRoot);
    } catch {
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
    }

    try {
      this.execGit(["worktree", "prune"], this.repoRoot);
    } catch {
      // Ignore prune failure
    }

    this.tornDown = true;
  }

  public getWorkingDir(): string {
    if (!this.context) {
      throw new Error("GitWorktreeDriver has not been initialized.");
    }
    return this.context.workingDir;
  }

  public getContext(): WorkspaceContext {
    if (!this.context) {
      throw new Error("GitWorktreeDriver has not been initialized.");
    }
    return this.context;
  }
}
