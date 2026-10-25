import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { Effect } from "effect";
import { GitWorktreeDriver } from "../packages/core/src/sandbox/git-worktree-driver.js";
import {
  PathOutsideTargetError,
  PathTraversalError,
  FileNotFoundError,
  GitCommandError,
  InvalidRunIdError,
  WorktreeNotFoundError,
} from "../packages/core/src/errors.js";

const run = Effect.runPromise;

/**
 * Captures the value on the EFFECT FAILURE CHANNEL (ADR-018): `tapError` only
 * fires for typed failures — a defect or a plain rejected promise leaves
 * `captured` undefined.
 */
async function captureFailure<A, E>(effect: Effect.Effect<A, E, never>): Promise<E | undefined> {
  let captured: E | undefined;
  await Effect.runPromiseExit(
    Effect.tapError(effect, (err) =>
      Effect.sync(() => {
        captured = err;
      })
    )
  );
  return captured;
}

describe("GitWorktreeDriver Integration", () => {
  let tempRepoDir: string;
  let driver: GitWorktreeDriver;
  const runId = "test-run-1";

  beforeAll(() => {
    // Create an isolated temporary git repository
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "perfgym-git-driver-test-"));

    // Initialize git repo
    execSync("git init", { cwd: tempRepoDir });
    execSync("git config core.autocrlf false", { cwd: tempRepoDir });
    execSync('git config user.name "PerfGym Tester"', { cwd: tempRepoDir });
    execSync('git config user.email "test@perfgym.dev"', { cwd: tempRepoDir });

    // Ensure main branch
    execSync("git checkout -B main", { cwd: tempRepoDir });

    // Create initial commit
    fs.mkdirSync(path.join(tempRepoDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRepoDir, "src", "index.ts"),
      "export const baseline = 100;\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tempRepoDir, "package.json"),
      '{"name": "test-repo"}\n',
      "utf8"
    );

    execSync("git add -A", { cwd: tempRepoDir });
    execSync('git commit -m "Initial baseline commit"', { cwd: tempRepoDir });
  });

  afterAll(() => {
    try {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error on windows locks
    }
  });

  it("initializes an isolated git worktree without touching main working tree", async () => {
    driver = new GitWorktreeDriver({
      repoRoot: tempRepoDir,
      allowedGlobs: ["src/**/*.ts"],
    });

    const ctx = await run(driver.initialize(runId, "main"));
    expect(ctx.runId).toBe(runId);
    expect(ctx.branchName).toBe(`perfgym/eval-${runId}`);
    expect(ctx.baseRef).toBe("main");
    expect(fs.existsSync(ctx.workingDir)).toBe(true);

    // Verify main working tree remains pristine
    const mainContent = fs.readFileSync(path.join(tempRepoDir, "src", "index.ts"), "utf8");
    expect(mainContent).toBe("export const baseline = 100;\n");
  });

  it("reads and writes files inside worktree enforcing whitelist and traversal boundaries", async () => {
    // Whitelisted write
    await run(driver.writeFile("src/index.ts", "export const baseline = 200;\n"));
    expect(await run(driver.readFile("src/index.ts"))).toBe("export const baseline = 200;\n");
    expect(await run(driver.fileExists("src/index.ts"))).toBe(true);

    // Main repo is NOT modified
    const mainContent = fs.readFileSync(path.join(tempRepoDir, "src", "index.ts"), "utf8");
    expect(mainContent).toBe("export const baseline = 100;\n");

    // Path outside whitelist
    await expect(run(driver.writeFile("package.json", "{}"))).rejects.toThrow(
      PathOutsideTargetError
    );

    // Path traversal
    await expect(run(driver.writeFile("../outside.ts", ""))).rejects.toThrow(
      PathTraversalError
    );

    // Non-existent file read
    await expect(run(driver.readFile("src/missing.ts"))).rejects.toThrow(
      FileNotFoundError
    );
  });

  it("rollbacks dirty mutations and untracked files cleanly", async () => {
    // Dirty mutation
    await run(driver.writeFile("src/index.ts", "export const broken = true;\n"));
    // Untracked file
    await run(driver.writeFile("src/untracked.ts", "export const junk = 1;\n"));

    expect(await run(driver.fileExists("src/untracked.ts"))).toBe(true);

    // Trigger rollback
    await run(driver.rollbackStep());

    // Verify reverted to pristine state
    expect((await run(driver.readFile("src/index.ts"))).replace(/\r\n/g, "\n")).toBe(
      "export const baseline = 100;\n"
    );
    expect(await run(driver.fileExists("src/untracked.ts"))).toBe(false);
  });

  it("records commit-per-win and rolls back only to latest commit", async () => {
    // Step 1: Winning mutation
    await run(driver.writeFile("src/index.ts", "export const win1 = 1;\n"));
    const commitHash = await run(driver.commitStep(1, 105.0));
    expect(typeof commitHash).toBe("string");
    expect(commitHash.length).toBeGreaterThan(0);

    // Step 2: Broken mutation
    await run(driver.writeFile("src/index.ts", "export const brokenStep2 = 2;\n"));
    await run(driver.rollbackStep());

    // Should rollback to step 1 win, not initial commit
    expect((await run(driver.readFile("src/index.ts"))).replace(/\r\n/g, "\n")).toBe(
      "export const win1 = 1;\n"
    );
  });

  it("promotes winning worktree to target branch and tears down cleanly", async () => {
    await run(driver.promote("main"));

    // Main branch in temp repo now has the promoted commit
    execSync("git checkout main", { cwd: tempRepoDir });
    const mainContentAfterPromote = fs.readFileSync(
      path.join(tempRepoDir, "src", "index.ts"),
      "utf8"
    );
    expect(mainContentAfterPromote.replace(/\r\n/g, "\n")).toBe("export const win1 = 1;\n");

    // Teardown worktree
    const worktreeDir = driver.getWorkingDir();
    await run(driver.teardown());
    expect(fs.existsSync(worktreeDir)).toBe(false);
  });

  it("returns InvalidRunIdError on the failure channel for a malformed runId", async () => {
    const err = await captureFailure(driver.initialize("bad run id!", "main"));
    expect(err).toBeInstanceOf(InvalidRunIdError);
  });

  it("returns GitCommandError on the failure channel when git rejects a command", async () => {
    const fresh = new GitWorktreeDriver({
      repoRoot: tempRepoDir,
      allowedGlobs: ["src/**/*.ts"],
    });
    const err = await captureFailure(fresh.initialize("run-bad-base", "no-such-ref"));
    expect(err).toBeInstanceOf(GitCommandError);
  });

  it("returns WorktreeNotFoundError on the failure channel before initialize", async () => {
    const fresh = new GitWorktreeDriver({
      repoRoot: tempRepoDir,
      allowedGlobs: ["src/**/*.ts"],
    });
    expect(await captureFailure(fresh.verifyBlastRadius())).toBeInstanceOf(
      WorktreeNotFoundError
    );
    expect(await captureFailure(fresh.rollbackStep())).toBeInstanceOf(
      WorktreeNotFoundError
    );
    expect(await captureFailure(fresh.commitStep(1, 1.0))).toBeInstanceOf(
      WorktreeNotFoundError
    );
  });
});
