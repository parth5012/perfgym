import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { GitWorktreeDriver } from "../packages/core/src/sandbox/git-worktree-driver.js";
import {
  PathOutsideTargetError,
  PathTraversalError,
  FileNotFoundError,
} from "../packages/core/src/errors.js";

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

    const ctx = await driver.initialize(runId, "main");
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
    await driver.writeFile("src/index.ts", "export const baseline = 200;\n");
    expect(await driver.readFile("src/index.ts")).toBe("export const baseline = 200;\n");
    expect(await driver.fileExists("src/index.ts")).toBe(true);

    // Main repo is NOT modified
    const mainContent = fs.readFileSync(path.join(tempRepoDir, "src", "index.ts"), "utf8");
    expect(mainContent).toBe("export const baseline = 100;\n");

    // Path outside whitelist
    await expect(driver.writeFile("package.json", "{}")).rejects.toThrow(
      PathOutsideTargetError
    );

    // Path traversal
    await expect(driver.writeFile("../outside.ts", "")).rejects.toThrow(
      PathTraversalError
    );

    // Non-existent file read
    await expect(driver.readFile("src/missing.ts")).rejects.toThrow(
      FileNotFoundError
    );
  });

  it("rollbacks dirty mutations and untracked files cleanly", async () => {
    // Dirty mutation
    await driver.writeFile("src/index.ts", "export const broken = true;\n");
    // Untracked file
    await driver.writeFile("src/untracked.ts", "export const junk = 1;\n");

    expect(await driver.fileExists("src/untracked.ts")).toBe(true);

    // Trigger rollback
    await driver.rollbackStep();

    // Verify reverted to pristine state
    expect((await driver.readFile("src/index.ts")).replace(/\r\n/g, "\n")).toBe(
      "export const baseline = 100;\n"
    );
    expect(await driver.fileExists("src/untracked.ts")).toBe(false);
  });

  it("records commit-per-win and rolls back only to latest commit", async () => {
    // Step 1: Winning mutation
    await driver.writeFile("src/index.ts", "export const win1 = 1;\n");
    const commitHash = await driver.commitStep(1, 105.0);
    expect(typeof commitHash).toBe("string");
    expect(commitHash.length).toBeGreaterThan(0);

    // Step 2: Broken mutation
    await driver.writeFile("src/index.ts", "export const brokenStep2 = 2;\n");
    await driver.rollbackStep();

    // Should rollback to step 1 win, not initial commit
    expect((await driver.readFile("src/index.ts")).replace(/\r\n/g, "\n")).toBe(
      "export const win1 = 1;\n"
    );
  });

  it("promotes winning worktree to target branch and tears down cleanly", async () => {
    await driver.promote("main");

    // Main branch in temp repo now has the promoted commit
    execSync("git checkout main", { cwd: tempRepoDir });
    const mainContentAfterPromote = fs.readFileSync(
      path.join(tempRepoDir, "src", "index.ts"),
      "utf8"
    );
    expect(mainContentAfterPromote.replace(/\r\n/g, "\n")).toBe("export const win1 = 1;\n");

    // Teardown worktree
    const worktreeDir = driver.getWorkingDir();
    await driver.teardown();
    expect(fs.existsSync(worktreeDir)).toBe(false);
  });
});
