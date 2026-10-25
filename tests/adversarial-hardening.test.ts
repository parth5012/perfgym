import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { Effect } from "effect";
import { GitWorktreeDriver } from "../packages/core/src/sandbox/git-worktree-driver.js";
import { InMemorySandboxDriver } from "../packages/core/src/sandbox/in-memory-driver.js";
import { GitSandboxCoordinator } from "../packages/core/src/sandbox/coordinator.js";
import { PathOutsideTargetError, PathTraversalError } from "../packages/core/src/errors.js";

const run = Effect.runPromise;

describe("Adversarial Hardening & Blast Radius Verification", () => {
  let tempRepo: string;
  let worktreesDir: string;
  let driver: GitWorktreeDriver;

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), "perfgym-adv-test-"));
    worktreesDir = path.join(tempRepo, ".perfgym", "worktrees");

    fs.mkdirSync(path.join(tempRepo, "src"), { recursive: true });
    execSync("git init", { cwd: tempRepo, stdio: "ignore" });
    execSync("git config core.autocrlf false", { cwd: tempRepo, stdio: "ignore" });
    execSync('git config user.name "Test Runner"', { cwd: tempRepo, stdio: "ignore" });
    execSync('git config user.email "test@perfgym.dev"', { cwd: tempRepo, stdio: "ignore" });
    execSync("git checkout -B main", { cwd: tempRepo, stdio: "ignore" });

    fs.writeFileSync(path.join(tempRepo, "src", "index.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(tempRepo, "package.json"), "{\"name\":\"test\"}\n");
    execSync("git add -A", { cwd: tempRepo, stdio: "ignore" });
    execSync('git commit -m "Initial commit"', { cwd: tempRepo, stdio: "ignore" });

    driver = new GitWorktreeDriver({
      repoRoot: tempRepo,
      worktreesDir,
      allowedGlobs: ["src/**/*"],
    });
  });

  afterEach(async () => {
    try {
      await run(driver.teardown());
    } catch {
      // Ignore
    }
    try {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it("[FLAW-01] detects direct shell/untracked writes outside allowed whitelist during verifyBlastRadius", async () => {
    const ctx = await run(driver.initialize("run-blast-1", "main"));

    // Legitimate write inside allowed whitelist
    await run(driver.writeFile("src/index.ts", "export const a = 2;\n"));
    await expect(run(driver.verifyBlastRadius())).resolves.toBeUndefined();

    // Adversary bypasses driver.writeFile and writes directly via filesystem/shell outside src/
    const evilFile = path.join(ctx.workingDir, "package.json");
    fs.writeFileSync(evilFile, "{\"name\":\"hacked\"}\n");

    // verifyBlastRadius catches the out-of-bounds mutation
    await expect(run(driver.verifyBlastRadius())).rejects.toThrow(PathOutsideTargetError);

    // commitStep refuses to stage and commit out-of-bounds mutations
    await expect(run(driver.commitStep(1, 10.0))).rejects.toThrow(PathOutsideTargetError);
  });

  it("[FLAW-01] detects new untracked files placed directly outside allowed whitelist", async () => {
    const ctx = await run(driver.initialize("run-blast-2", "main"));

    // Adversary drops an untracked script at root
    const evilScript = path.join(ctx.workingDir, "exploit.js");
    fs.writeFileSync(evilScript, "console.log('pwned');\n");

    await expect(run(driver.verifyBlastRadius())).rejects.toThrow(PathOutsideTargetError);
  });

  it("[FLAW-02] detects symlink escaping working directory", async () => {
    const ctx = await run(driver.initialize("run-symlink", "main"));

    // Attempt to create a symlink inside src pointing outside
    const outsideTarget = path.join(tempRepo, "package.json");
    const linkPath = path.join(ctx.workingDir, "src", "link-out");

    try {
      fs.symlinkSync(outsideTarget, linkPath);
      // Attempting to write through the symlink must be blocked
      await expect(run(driver.writeFile("src/link-out", "pwned"))).rejects.toThrow(
        PathTraversalError
      );
    } catch (symlinkErr: any) {
      // On Windows non-elevated, symlink creation might require privileges; if so, skip link creation
      if (symlinkErr.code !== "EPERM") {
        throw symlinkErr;
      }
    }
  });

  it("[FLAW-01 & FLAW-11] InMemorySandboxDriver enforces blast radius verification", async () => {
    const memDriver = new InMemorySandboxDriver({
      allowedGlobs: ["src/**/*"],
      initialFiles: { "src/math.ts": "1" },
    });
    await run(memDriver.initialize("run-mem-1", "main"));

    // Legitimate modification
    await run(memDriver.writeFile("src/math.ts", "2"));
    await expect(run(memDriver.verifyBlastRadius())).resolves.toBeUndefined();

    // Out of bounds mutation attempt via writeFile is blocked
    await expect(run(memDriver.writeFile("package.json", "evil"))).rejects.toThrow(
      PathOutsideTargetError
    );
  });

  it("[FLAW-04 & FLAW-11] GitSandboxCoordinator only releases locks it actually owns", async () => {
    const lockDir = path.join(tempRepo, ".perfgym", ".lock.d");
    const coord1 = new GitSandboxCoordinator(driver, { lockDir, repoRoot: tempRepo });
    await run(coord1.acquire("run-coord-1", "main"));

    expect(coord1.isLocked()).toBe(true);

    // Another coordinator instance for a different run
    const coord2 = new GitSandboxCoordinator(driver, { lockDir, repoRoot: tempRepo });

    // coord2 attempting to release without holding the lock does not delete coord1's lock
    await run(coord2.release());
    expect(fs.existsSync(lockDir)).toBe(true);

    // coord1 properly releases its own lock
    await run(coord1.release());
    expect(fs.existsSync(lockDir)).toBe(false);
  });
});
