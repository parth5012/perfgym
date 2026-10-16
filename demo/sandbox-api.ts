/**
 * PerfGym Sandbox Lab — demo UI backend.
 *
 * Wraps the real GitSandboxCoordinator + GitWorktreeDriver behind a small,
 * stateful API that a browser UI can drive interactively, so operators can
 * verify that the sandbox actually isolates mutations:
 *
 *  - whitelisted writes / commit-per-win / rollback lifecycle
 *  - path traversal, out-of-bounds and symlink escape attacks (must be BLOCKED)
 *  - raw shell writes bypassing the driver (must be caught by blast radius)
 *  - lock exclusivity and promote flow
 *
 * `runSuite()` runs the full adversarial scenario list against a throwaway
 * repository and reports pass/fail per scenario.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  GitWorktreeDriver,
  matchesGlob,
} from "../packages/core/src/sandbox/git-worktree-driver.js";
import { GitSandboxCoordinator } from "../packages/core/src/sandbox/coordinator.js";
import type { WorkspaceContext } from "../packages/core/src/sandbox/driver.js";

export interface DemoOptions {
  /** Absolute or cwd-relative directory for the demo repository. */
  repoDir?: string;
  /** Mutation whitelist globs (defaults to the src globstar pattern). */
  allowedGlobs?: string[];
}

export interface DemoInitOptions {
  allowedGlobs?: string[];
}

export interface DemoStatusEntry {
  raw: string;
  path: string;
  whitelisted: boolean;
}

export interface DemoState {
  initialized: boolean;
  locked: boolean;
  context: WorkspaceContext | null;
  repoDir: string;
  worktreesDir: string;
  lockDir: string;
  allowedGlobs: string[];
  gitStatus: DemoStatusEntry[];
  gitLog: string[];
  branches: string[];
}

export interface SuiteResult {
  id: string;
  name: string;
  expected: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface PromoteResult {
  branch: string;
  commitHash: string;
}

const DEFAULT_GLOBS = ["src/**/*"];

const BASELINE_FILES: Record<string, string> = {
  "src/index.ts": "export const baseline = 100;\n",
  "src/util.ts": "export const util = 1;\n",
  "package.json": '{"name":"perfgym-demo-repo"}\n',
  "README.md": "# PerfGym demo repository\n",
  "tests/example.check.ts": "export const check = true;\n",
};

class SuiteSkip extends Error {
  public readonly suiteSkip = true;
  constructor(message: string) {
    super(message);
    this.name = "SuiteSkip";
  }
}

function gitLines(args: string[], cwd: string): string[] {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out ? out.split(/\r?\n/) : [];
  } catch {
    return [];
  }
}

function gitOut(args: string[], cwd: string): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function parseStatusLine(raw: string): { path: string; whitelisted: boolean } {
  const match = raw.match(/^[A-Z?0-9 ]{1,2}\s+(.*)$/);
  const entry = (match?.[1] ?? raw).trim().replace(/^"|"$/g, "");
  const filePath = entry.includes(" -> ") ? entry.split(" -> ")[1].trim() : entry;
  return { path: filePath.replace(/\\/g, "/"), whitelisted: false };
}

export class DemoSandbox {
  private repoDir: string;
  private worktreesDir: string;
  private lockDir: string;
  private allowedGlobs: string[];
  private driver: GitWorktreeDriver | null = null;
  private coordinator: GitSandboxCoordinator | null = null;
  private context: WorkspaceContext | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: DemoOptions = {}) {
    this.repoDir = path.resolve(
      options.repoDir ?? path.join(process.cwd(), ".tmp", "demo-repo")
    );
    this.worktreesDir = path.join(this.repoDir, ".perfgym", "worktrees");
    this.lockDir = path.join(this.repoDir, ".perfgym", ".lock.d");
    this.allowedGlobs = options.allowedGlobs?.length
      ? [...options.allowedGlobs]
      : [...DEFAULT_GLOBS];
  }

  /** Serializes mutating operations so UI actions never race the lock. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private ensureSession(): {
    driver: GitWorktreeDriver;
    coordinator: GitSandboxCoordinator;
    context: WorkspaceContext;
  } {
    if (!this.driver || !this.coordinator || !this.context) {
      throw new Error("Sandbox is not initialized. Click 'Init sandbox' first.");
    }
    return { driver: this.driver, coordinator: this.coordinator, context: this.context };
  }

  private containedPath(root: string, relPath: string): string {
    const abs = path.resolve(root, relPath);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Path '${relPath}' escapes the sandbox working directory.`);
    }
    return abs;
  }

  private createRepo(): void {
    const git = (args: string[]): void => {
      execFileSync("git", args, { cwd: this.repoDir, stdio: "ignore" });
    };
    fs.mkdirSync(this.repoDir, { recursive: true });
    git(["init"]);
    git(["config", "core.autocrlf", "false"]);
    git(["config", "user.name", "PerfGym Demo"]);
    git(["config", "user.email", "demo@perfgym.dev"]);
    git(["checkout", "-B", "main"]);
    for (const [rel, content] of Object.entries(BASELINE_FILES)) {
      const abs = path.join(this.repoDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
    git(["add", "-A"]);
    git(["commit", "-m", "baseline"]);
  }

  private async disposeInternal(): Promise<void> {
    const driver = this.driver;
    const coordinator = this.coordinator;
    this.driver = null;
    this.coordinator = null;
    this.context = null;
    if (driver) {
      try {
        await driver.teardown();
      } catch {
        // ignore teardown races
      }
    }
    if (coordinator) {
      try {
        await coordinator.release();
      } catch {
        // ignore release races
      }
    }
  }

  /** (Re)creates the demo repository and acquires a fresh sandbox lock. */
  public init(options: DemoInitOptions = {}): Promise<WorkspaceContext> {
    return this.enqueue(async () => {
      await this.disposeInternal();
      fs.rmSync(this.repoDir, { recursive: true, force: true });
      this.createRepo();
      if (options.allowedGlobs?.length) {
        this.allowedGlobs = [...options.allowedGlobs];
      }

      this.driver = new GitWorktreeDriver({
        repoRoot: this.repoDir,
        worktreesDir: this.worktreesDir,
        allowedGlobs: this.allowedGlobs,
      });
      // Demo-friendly staleness: a killed server (dead PID + stale heartbeat)
      // reclaims the lock after 3s instead of the production default of 30s.
      this.coordinator = new GitSandboxCoordinator(this.driver, {
        repoRoot: this.repoDir,
        lockDir: this.lockDir,
        staleThresholdMs: 3_000,
        heartbeatIntervalMs: 1_000,
      });

      try {
        this.context = await this.coordinator.acquire(
          `demo-${Date.now().toString(36)}`,
          "main"
        );
      } catch (err) {
        await this.disposeInternal();
        throw err;
      }
      return this.context;
    });
  }

  public state(): DemoState {
    const base = {
      repoDir: this.repoDir,
      worktreesDir: this.worktreesDir,
      lockDir: this.lockDir,
      allowedGlobs: this.allowedGlobs,
    };
    const initialized = this.context !== null && this.coordinator !== null;
    const locked = this.coordinator?.isLocked() ?? false;
    const branches = gitLines(
      ["branch", "--list", "--format=%(refname:short)"],
      this.repoDir
    );

    if (!initialized || !this.context) {
      return {
        ...base,
        initialized: false,
        locked,
        context: null,
        gitStatus: [],
        gitLog: [],
        branches,
      };
    }

    const workingDir = this.context.workingDir;
    const gitStatus = gitLines(
      ["status", "--porcelain", "-uall"],
      workingDir
    ).map((raw) => {
      const parsed = parseStatusLine(raw);
      return {
        raw,
        path: parsed.path,
        whitelisted: this.allowedGlobs.some((g) => matchesGlob(g, parsed.path)),
      };
    });
    const gitLog = gitLines(["log", "--oneline", "-5"], workingDir);

    return {
      ...base,
      initialized,
      locked,
      context: this.context,
      gitStatus,
      gitLog,
      branches,
    };
  }

  /** Sandboxed write — enforces traversal + whitelist boundaries. */
  public write(relPath: string, content: string): Promise<void> {
    return this.enqueue(async () => {
      const { coordinator } = this.ensureSession();
      await coordinator.applyMutation([{ relPath, content }]);
    });
  }

  public readFile(relPath: string): Promise<string> {
    return this.enqueue(async () => {
      const { driver } = this.ensureSession();
      return driver.readFile(relPath);
    });
  }

  /**
   * Deliberate whitelist BYPASS (simulates the agent using a shell / direct
   * filesystem access instead of driver.writeFile). Used to demonstrate that
   * verifyBlastRadius catches out-of-band mutations.
   */
  public rawWrite(relPath: string, content: string): Promise<string> {
    return this.enqueue(async () => {
      const { context } = this.ensureSession();
      const abs = this.containedPath(context.workingDir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
      return abs;
    });
  }

  /**
   * Creates a symlink inside the worktree pointing at an arbitrary target
   * (defaults to the demo repo's package.json) — the classic sandbox escape.
   * May throw EPERM on Windows without Developer Mode.
   */
  public symlink(relPath: string, targetAbs?: string): Promise<{
    link: string;
    target: string;
  }> {
    return this.enqueue(async () => {
      const { context } = this.ensureSession();
      const abs = this.containedPath(context.workingDir, relPath);
      const target = targetAbs
        ? path.resolve(targetAbs)
        : path.join(this.repoDir, "package.json");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.symlinkSync(target, abs);
      return { link: relPath.replace(/\\/g, "/"), target };
    });
  }

  /** Scans the worktree for mutations outside allowedGlobs. */
  public verify(): Promise<void> {
    return this.enqueue(async () => {
      const { coordinator } = this.ensureSession();
      await coordinator.verifyBlastRadius();
    });
  }

  public accept(stepNumber: number, score: number) {
    return this.enqueue(async () => {
      const { coordinator } = this.ensureSession();
      return coordinator.acceptStep(stepNumber, score);
    });
  }

  public reject(): Promise<void> {
    return this.enqueue(async () => {
      const { coordinator } = this.ensureSession();
      await coordinator.rejectStep();
    });
  }

  /** Fast-forwards the winning state to `targetBranch`, then ends the session. */
  public promote(targetBranch: string): Promise<PromoteResult> {
    if (!/^[a-zA-Z0-9_./-]+$/.test(targetBranch)) {
      return Promise.reject(new Error(`Invalid branch name '${targetBranch}'.`));
    }
    return this.enqueue(async () => {
      const { coordinator } = this.ensureSession();
      await coordinator.promoteAndCleanup(targetBranch);
      const commitHash = gitOut(["rev-parse", targetBranch], this.repoDir) ?? "";
      this.driver = null;
      this.coordinator = null;
      this.context = null;
      return { branch: targetBranch, commitHash };
    });
  }

  /**
   * Builds a second coordinator against the same lock directory and tries to
   * acquire it — must fail with SandboxLockBusyError while a session is live.
   */
  public attemptCompetingAcquire(): Promise<void> {
    return this.enqueue(async () => {
      this.ensureSession();
      const rivalDriver = new GitWorktreeDriver({
        repoRoot: this.repoDir,
        worktreesDir: this.worktreesDir,
        allowedGlobs: this.allowedGlobs,
      });
      const rival = new GitSandboxCoordinator(rivalDriver, {
        repoRoot: this.repoDir,
        lockDir: this.lockDir,
        staleThresholdMs: 3_000,
        heartbeatIntervalMs: 1_000,
      });
      try {
        await rival.acquire("competing-run", "main");
      } catch (err) {
        try {
          await rival.release();
        } catch {
          // ignore: never acquired
        }
        throw err;
      }
      // Reaching here means the lock was NOT exclusive — tear down and fail.
      try {
        await rivalDriver.teardown();
      } catch {
        // ignore
      }
      try {
        await rival.release();
      } catch {
        // ignore
      }
      throw new Error("Competing acquire unexpectedly succeeded — lock is not exclusive.");
    });
  }

  public async dispose(): Promise<void> {
    return this.enqueue(() => this.disposeInternal());
  }

  /**
   * Runs the full adversarial scenario list against a throwaway repository.
   * Returns one result per scenario; `fail` means the sandbox misbehaved.
   */
  public async runSuite(): Promise<SuiteResult[]> {
    const suiteRepo = path.resolve(
      process.cwd(),
      `.tmp/demo-suite-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    );
    const d = new DemoSandbox({ repoDir: suiteRepo, allowedGlobs: this.allowedGlobs });
    const results: SuiteResult[] = [];

    const run = async (
      id: string,
      name: string,
      expected: string,
      fn: () => Promise<string>
    ): Promise<void> => {
      let status: SuiteResult["status"] = "pass";
      let detail = "";
      try {
        detail = await fn();
      } catch (err) {
        if (err instanceof SuiteSkip) {
          status = "skip";
          detail = err.message;
        } else {
          const e = err as { _tag?: string; name?: string; message?: string };
          status = "fail";
          detail = `${e._tag ?? e.name ?? "Error"}: ${e.message ?? String(err)}`;
        }
      } finally {
        try {
          await d.reject();
        } catch {
          // best-effort cleanup between scenarios
        }
      }
      results.push({ id, name, expected, status, detail });
    };

    const expectBlocked = async (
      tag: string,
      fn: () => Promise<unknown>
    ): Promise<string> => {
      try {
        await fn();
      } catch (err) {
        const e = err as { _tag?: string };
        if (e._tag === tag) return `blocked with ${tag}`;
        throw err;
      }
      throw new Error(`operation was NOT blocked (expected ${tag})`);
    };

    try {
      await d.init();

      await run("whitelist-write", "Whitelisted write via driver allowed", "success", async () => {
        await d.write("src/index.ts", "export const baseline = 110;\n");
        return "write accepted";
      });

      await run("verify-clean", "Blast radius clean after whitelisted write", "success", async () => {
        await d.verify();
        return "worktree within whitelist";
      });

      await run("accept-commit", "Accept step records commit-per-win hash", "commit hash", async () => {
        const r = await d.accept(1, 8.5);
        if (!/^[0-9a-f]{7,40}$/.test(r.commitHash)) {
          throw new Error(`invalid commit hash '${r.commitHash}'`);
        }
        return `commit ${r.commitHash.slice(0, 7)}`;
      });

      await run("block-oob", "Driver write outside whitelist blocked", "ERR_PATH_OUTSIDE_TARGET", () =>
        expectBlocked("PathOutsideTargetError", () => d.write("package.json", "evil"))
      );

      await run("block-traversal", "Path traversal write blocked", "ERR_PATH_TRAVERSAL", () =>
        expectBlocked("PathTraversalError", () => d.write("../../escape.txt", "evil"))
      );

      await run("rollback-restore", "Rollback restores previous committed state", "restored", async () => {
        const before = await d.readFile("src/util.ts");
        await d.write("src/util.ts", "export const util = 42;\n");
        await d.reject();
        const after = await d.readFile("src/util.ts");
        if (after !== before) {
          throw new Error(`rollback failed: expected ${JSON.stringify(before)}, got ${JSON.stringify(after)}`);
        }
        return "baseline restored";
      });

      await run(
        "detect-shell-escape",
        "Raw shell write outside whitelist caught by verify",
        "ERR_PATH_OUTSIDE_TARGET",
        () =>
          expectBlocked("PathOutsideTargetError", async () => {
            await d.rawWrite("package.json", '{"name":"hacked"}\n');
            await d.verify();
          })
      );

      await run(
        "block-commit-dirty",
        "Commit refused while blast radius dirty",
        "ERR_PATH_OUTSIDE_TARGET",
        () =>
          expectBlocked("PathOutsideTargetError", async () => {
            await d.rawWrite("package.json", '{"name":"hacked"}\n');
            await d.accept(2, 9);
          })
      );

      await run("detect-untracked", "Untracked file outside whitelist caught", "ERR_PATH_OUTSIDE_TARGET", () =>
        expectBlocked("PathOutsideTargetError", async () => {
          await d.rawWrite("loot.txt", "stolen\n");
          await d.verify();
        })
      );

      await run("block-symlink", "Symlink escape write blocked", "ERR_PATH_TRAVERSAL", async () => {
        try {
          await d.symlink("src/escape-link");
        } catch (err) {
          const e = err as { code?: string; message?: string };
          throw new SuiteSkip(`symlink creation unavailable (${e.code ?? e.message})`);
        }
        return expectBlocked("PathTraversalError", () => d.write("src/escape-link", "pwned"));
      });

      await run("lock-exclusive", "Competing coordinator refused by lock", "SandboxLockBusyError", () =>
        expectBlocked("SandboxLockBusyError", () => d.attemptCompetingAcquire())
      );

      await run("promote", "Promote winning state to demo-win branch", "branch updated", async () => {
        await d.verify();
        const r = await d.accept(3, 9.5);
        const { commitHash } = await d.promote("demo-win");
        const branches = gitLines(["branch", "--list", "--format=%(refname:short)"], suiteRepo);
        if (!branches.includes("demo-win")) {
          throw new Error("demo-win branch missing after promote");
        }
        return `demo-win @ ${(commitHash || r.commitHash).slice(0, 7)}`;
      });
    } finally {
      try {
        await d.dispose();
      } catch {
        // ignore
      }
      try {
        fs.rmSync(suiteRepo, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }

    return results;
  }
}
