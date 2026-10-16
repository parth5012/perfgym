import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { WorkspaceDriver, WorkspaceContext } from "./driver.js";
import { GitWorktreeDriver } from "./git-worktree-driver.js";
import { SandboxLockBusyError } from "../errors.js";

export interface MutationFile {
  relPath: string;
  content: string;
}

export interface StepReceipt {
  stepNumber: number;
  commitHash: string;
  score: number;
  timestamp: number;
}

export interface CoordinatorOptions {
  lockDir?: string;
  staleThresholdMs?: number;
  heartbeatIntervalMs?: number;
  repoRoot?: string;
}

export interface LockMetadata {
  pid: number;
  runId: string;
  startTime: number;
  heartbeat: number;
}

export class GitSandboxCoordinator {
  private driver: WorkspaceDriver;
  private lockDir: string;
  private staleThresholdMs: number;
  private heartbeatIntervalMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private context: WorkspaceContext | null = null;
  private locked = false;
  private repoRoot: string;
  private boundExitHandler: (() => void) | null = null;
  private boundSigintHandler: (() => void) | null = null;
  private boundSigtermHandler: (() => void) | null = null;

  constructor(driver?: WorkspaceDriver, options: CoordinatorOptions = {}) {
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.driver = driver ?? new GitWorktreeDriver({ repoRoot: this.repoRoot });
    this.lockDir = path.resolve(
      options.lockDir ?? path.join(this.repoRoot, ".perfgym", ".lock.d")
    );
    this.staleThresholdMs = options.staleThresholdMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000;
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const e = err as { code?: string };
      return e.code !== "ESRCH";
    }
  }

  private writeMetadata(metadata: LockMetadata): void {
    const metaPath = path.join(this.lockDir, "metadata.json");
    const tmpPath = path.join(
      this.lockDir,
      `metadata.json.tmp.${process.pid}.${Date.now()}`
    );
    fs.writeFileSync(tmpPath, JSON.stringify(metadata, null, 2), "utf8");
    try {
      fs.renameSync(tmpPath, metaPath);
    } catch {
      try {
        fs.copyFileSync(tmpPath, metaPath);
        fs.unlinkSync(tmpPath);
      } catch {
        // Fallback
      }
    }
  }

  private readMetadata(): LockMetadata | null {
    const metaPath = path.join(this.lockDir, "metadata.json");
    if (!fs.existsSync(metaPath)) return null;
    try {
      const content = fs.readFileSync(metaPath, "utf8");
      return JSON.parse(content) as LockMetadata;
    } catch {
      return null;
    }
  }

  private startHeartbeat(runId: string, startTime: number): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.locked) return;
      try {
        this.writeMetadata({
          pid: process.pid,
          runId,
          startTime,
          heartbeat: Date.now(),
        });
      } catch {
        // Ignore heartbeat write error during teardown
      }
    }, this.heartbeatIntervalMs);

    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private registerHooks(): void {
    this.boundExitHandler = () => {
      this.syncRelease();
    };
    this.boundSigintHandler = () => {
      this.syncRelease();
      process.exit(130);
    };
    this.boundSigtermHandler = () => {
      this.syncRelease();
      process.exit(143);
    };

    process.once("exit", this.boundExitHandler);
    process.once("SIGINT", this.boundSigintHandler);
    process.once("SIGTERM", this.boundSigtermHandler);
  }

  private unregisterHooks(): void {
    if (this.boundExitHandler) {
      process.removeListener("exit", this.boundExitHandler);
      this.boundExitHandler = null;
    }
    if (this.boundSigintHandler) {
      process.removeListener("SIGINT", this.boundSigintHandler);
      this.boundSigintHandler = null;
    }
    if (this.boundSigtermHandler) {
      process.removeListener("SIGTERM", this.boundSigtermHandler);
      this.boundSigtermHandler = null;
    }
  }

  private pruneOrphanedWorktrees(): void {
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: this.repoRoot,
        stdio: "ignore",
      });
    } catch {
      // Ignore git prune failure (e.g. In-Memory test environment without git)
    }
  }

  public async acquire(runId: string, baseRef = "main"): Promise<WorkspaceContext> {
    const parentDir = path.dirname(this.lockDir);
    fs.mkdirSync(parentDir, { recursive: true });

    let acquired = false;
    try {
      fs.mkdirSync(this.lockDir);
      acquired = true;
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === "EEXIST") {
        const meta = this.readMetadata();
        const now = Date.now();

        if (meta) {
          const isAlive = this.isProcessAlive(meta.pid);
          const isStale = now - meta.heartbeat > this.staleThresholdMs;

          if (!isAlive && isStale) {
            // Stale lock recovery: break lock, prune orphaned worktrees, and re-acquire
            try {
              fs.rmSync(this.lockDir, { recursive: true, force: true });
              this.pruneOrphanedWorktrees();
              fs.mkdirSync(this.lockDir);
              acquired = true;
            } catch {
              // Another process may have raced to claim
            }
          } else {
            throw new SandboxLockBusyError({
              lockDir: this.lockDir,
              holderPid: meta.pid,
              startTime: meta.startTime,
              message: `PerfGym sandbox lock is currently held by PID ${meta.pid} (started at ${new Date(
                meta.startTime
              ).toISOString()}).`,
            });
          }
        } else {
          // Lock dir exists without metadata. Check modification time to avoid racing freshly created locks
          try {
            const stat = fs.statSync(this.lockDir);
            if (now - stat.mtimeMs > this.staleThresholdMs) {
              fs.rmSync(this.lockDir, { recursive: true, force: true });
              this.pruneOrphanedWorktrees();
              fs.mkdirSync(this.lockDir);
              acquired = true;
            } else {
              throw new SandboxLockBusyError({
                lockDir: this.lockDir,
                holderPid: 0,
                startTime: stat.mtimeMs,
                message: `PerfGym sandbox lock was recently acquired without metadata.`,
              });
            }
          } catch (statErr) {
            if (statErr instanceof SandboxLockBusyError) throw statErr;
          }
        }
      } else {
        throw err;
      }
    }

    if (!acquired) {
      throw new SandboxLockBusyError({
        lockDir: this.lockDir,
        holderPid: 0,
        startTime: Date.now(),
        message: `Failed to acquire atomic sandbox lock at '${this.lockDir}'.`,
      });
    }

    const startTime = Date.now();
    this.writeMetadata({
      pid: process.pid,
      runId,
      startTime,
      heartbeat: startTime,
    });

    this.locked = true;
    this.startHeartbeat(runId, startTime);
    this.registerHooks();

    try {
      this.context = await this.driver.initialize(runId, baseRef);
    } catch (driverErr) {
      this.syncRelease();
      throw driverErr;
    }

    return this.context;
  }

  public async applyMutation(files: MutationFile[]): Promise<void> {
    if (!this.locked || !this.context) {
      throw new Error("Cannot apply mutation without holding the sandbox lock.");
    }
    for (const file of files) {
      await this.driver.writeFile(file.relPath, file.content);
    }
  }

  public async acceptStep(stepNumber: number, score: number): Promise<StepReceipt> {
    if (!this.locked || !this.context) {
      throw new Error("Cannot accept step without holding the sandbox lock.");
    }
    const commitHash = await this.driver.commitStep(stepNumber, score);
    return {
      stepNumber,
      commitHash,
      score,
      timestamp: Date.now(),
    };
  }

  public async rejectStep(): Promise<void> {
    if (!this.locked || !this.context) {
      throw new Error("Cannot reject step without holding the sandbox lock.");
    }
    await this.driver.rollbackStep();
  }

  public async promoteAndCleanup(targetBranch: string): Promise<void> {
    if (!this.locked || !this.context) {
      throw new Error("Cannot promote without holding the sandbox lock.");
    }
    try {
      await this.driver.promote(targetBranch);
      await this.driver.teardown();
    } finally {
      await this.release();
    }
  }

  public async release(): Promise<void> {
    this.syncRelease();
  }

  private syncRelease(): void {
    this.stopHeartbeat();
    this.unregisterHooks();

    if (this.locked) {
      const meta = this.readMetadata();
      // Only delete if this process still holds the lock
      if (!meta || meta.pid === process.pid) {
        try {
          fs.rmSync(this.lockDir, { recursive: true, force: true });
        } catch {
          // Ignore removal errors on process termination
        }
      }
      this.locked = false;
      this.context = null;
    }
  }

  public isLocked(): boolean {
    return this.locked;
  }

  public getContext(): WorkspaceContext | null {
    return this.context;
  }
}
