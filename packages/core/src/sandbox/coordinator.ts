import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Effect } from "effect";
import type { WorkspaceDriver, WorkspaceContext } from "./driver.js";
import { GitWorktreeDriver } from "./git-worktree-driver.js";
import {
  SandboxLockBusyError,
  SandboxLockNotHeldError,
  ERR_SANDBOX_LOCK_NOT_HELD,
  type PerfGymDomainError,
} from "../errors.js";

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
  private currentRunId: string | null = null;
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

  /**
   * ADR-018: the lock-not-held contract violation that used to be a plain
   * Error is now a tagged SandboxLockNotHeldError on the failure channel.
   */
  private lockGuard(
    operation: string,
    message: string
  ): Effect.Effect<void, SandboxLockNotHeldError, never> {
    if (this.locked && this.context) {
      return Effect.succeed(undefined);
    }
    return Effect.fail(
      new SandboxLockNotHeldError({
        code: ERR_SANDBOX_LOCK_NOT_HELD,
        operation,
        message,
      })
    );
  }

  public acquire(
    runId: string,
    baseRef = "main"
  ): Effect.Effect<WorkspaceContext, PerfGymDomainError, never> {
    const self = this;
    return Effect.gen(function* () {
      const parentDir = path.dirname(self.lockDir);
      fs.mkdirSync(parentDir, { recursive: true });

      let acquired = false;
      try {
        fs.mkdirSync(self.lockDir);
        acquired = true;
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e.code !== "EEXIST") {
          // OS-level failure: previously rethrown raw — kept on the defect channel.
          return yield* Effect.die(err);
        }
        const meta = self.readMetadata();
        const now = Date.now();

        if (meta) {
          const isAlive = self.isProcessAlive(meta.pid);
          const isStale = now - meta.heartbeat > self.staleThresholdMs;

          if (!isAlive && isStale) {
            // Stale lock recovery via atomic tombstone rename:
            // Moving the stale directory atomically guarantees only one process can claim ownership
            // of the recovery and prevents clobbering a newly initialized lock from a racing process.
            const tombstone = `${self.lockDir}.tombstone.${process.pid}.${Date.now()}`;
            try {
              fs.renameSync(self.lockDir, tombstone);
              self.pruneOrphanedWorktrees();
              try {
                fs.rmSync(tombstone, { recursive: true, force: true });
              } catch {
                // Ignore tombstone cleanup error
              }
              fs.mkdirSync(self.lockDir);
              acquired = true;
            } catch {
              // Another process won the atomic rename race or directory already moved
            }
          } else {
            return yield* Effect.fail(
              new SandboxLockBusyError({
                lockDir: self.lockDir,
                holderPid: meta.pid,
                startTime: meta.startTime,
                message: `PerfGym sandbox lock is currently held by PID ${meta.pid} (started at ${new Date(
                  meta.startTime
                ).toISOString()}).`,
              })
            );
          }
        } else {
          // Lock dir exists without metadata. Check modification time to avoid racing freshly created locks
          let stat: fs.Stats | null = null;
          try {
            stat = fs.statSync(self.lockDir);
          } catch {
            // A stat failure used to be swallowed here; it falls through to
            // the generic acquisition failure below.
            stat = null;
          }
          if (stat && now - stat.mtimeMs > self.staleThresholdMs) {
            const tombstone = `${self.lockDir}.tombstone.${process.pid}.${Date.now()}`;
            try {
              fs.renameSync(self.lockDir, tombstone);
              self.pruneOrphanedWorktrees();
              try {
                fs.rmSync(tombstone, { recursive: true, force: true });
              } catch {
                // Ignore tombstone cleanup error
              }
              fs.mkdirSync(self.lockDir);
              acquired = true;
            } catch {
              // Another process won race
            }
          } else if (stat) {
            return yield* Effect.fail(
              new SandboxLockBusyError({
                lockDir: self.lockDir,
                holderPid: 0,
                startTime: stat.mtimeMs,
                message: `PerfGym sandbox lock was recently acquired without metadata.`,
              })
            );
          }
        }
      }

      if (!acquired) {
        return yield* Effect.fail(
          new SandboxLockBusyError({
            lockDir: self.lockDir,
            holderPid: 0,
            startTime: Date.now(),
            message: `Failed to acquire atomic sandbox lock at '${self.lockDir}'.`,
          })
        );
      }

      const startTime = Date.now();
      self.currentRunId = runId;
      self.writeMetadata({
        pid: process.pid,
        runId,
        startTime,
        heartbeat: startTime,
      });

      self.locked = true;
      self.startHeartbeat(runId, startTime);
      self.registerHooks();

      // If driver initialization fails, the lock acquired above is released
      // before the typed failure propagates (parity with catch/rethrow).
      const context = yield* Effect.tapCause(
        self.driver.initialize(runId, baseRef),
        () => Effect.sync(() => self.syncRelease())
      );
      self.context = context;
      return context;
    });
  }

  public applyMutation(files: MutationFile[]): Effect.Effect<void, PerfGymDomainError, never> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.lockGuard(
        "applyMutation",
        "Cannot apply mutation without holding the sandbox lock."
      );
      for (const file of files) {
        yield* self.driver.writeFile(file.relPath, file.content);
      }
    });
  }

  public verifyBlastRadius(): Effect.Effect<void, PerfGymDomainError, never> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.lockGuard(
        "verifyBlastRadius",
        "Cannot verify blast radius without holding the sandbox lock."
      );
      yield* self.driver.verifyBlastRadius();
    });
  }

  public acceptStep(
    stepNumber: number,
    score: number
  ): Effect.Effect<StepReceipt, PerfGymDomainError, never> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.lockGuard(
        "acceptStep",
        "Cannot accept step without holding the sandbox lock."
      );
      yield* self.driver.verifyBlastRadius();
      const commitHash = yield* self.driver.commitStep(stepNumber, score);
      return {
        stepNumber,
        commitHash,
        score,
        timestamp: Date.now(),
      };
    });
  }

  public rejectStep(): Effect.Effect<void, PerfGymDomainError, never> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.lockGuard(
        "rejectStep",
        "Cannot reject step without holding the sandbox lock."
      );
      yield* self.driver.rollbackStep();
    });
  }

  public promoteAndCleanup(targetBranch: string): Effect.Effect<void, PerfGymDomainError, never> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.lockGuard(
        "promoteAndCleanup",
        "Cannot promote without holding the sandbox lock."
      );
      // promote → teardown → release; the lock is ALWAYS released, even when
      // promote or teardown fails (try/finally parity with the previous code).
      yield* Effect.onExit(
        Effect.onExit(self.driver.promote(targetBranch), () => self.driver.teardown()),
        () => self.release()
      );
    });
  }

  public release(): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      this.syncRelease();
    });
  }

  private syncRelease(): void {
    this.stopHeartbeat();
    this.unregisterHooks();

    if (this.locked) {
      const meta = this.readMetadata();
      // Only delete if this process still genuinely holds the lock (matching pid and runId)
      if (meta && meta.pid === process.pid && meta.runId === this.currentRunId) {
        try {
          fs.rmSync(this.lockDir, { recursive: true, force: true });
        } catch {
          // Ignore removal errors on process termination
        }
      }
      this.locked = false;
      this.context = null;
      this.currentRunId = null;
    }
  }

  public isLocked(): boolean {
    return this.locked;
  }

  /**
   * The lock directory this coordinator OWNS (Ticket #48 review S3): reflective
   * readers (the lock snapshot in the live session) reuse it instead of
   * re-deriving the `.perfgym/.lock.d` location a second time.
   */
  public get lockDirectory(): string {
    return this.lockDir;
  }

  public getContext(): WorkspaceContext | null {
    return this.context;
  }
}
