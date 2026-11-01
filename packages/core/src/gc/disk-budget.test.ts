import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import {
  DiskBudgetManager,
  type WorktreeUsageEntry,
  type UsageManifest,
  type EvictionOptions,
  formatBytes,
} from "./disk-budget.js";
import {
  WorktreeDiskBudgetExceededError,
  ERR_WORKTREE_DISK_BUDGET_EXCEEDED,
} from "../errors.js";

describe("DiskBudgetManager (Ticket #59)", () => {
  let tempDir: string;
  let worktreesDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "perfgym-disk-budget-test-"));
    worktreesDir = path.join(tempDir, ".perfgym", "worktrees");
    fs.mkdirSync(worktreesDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("size accounting over fixture tree", () => {
    it("computes recursive size of worktree directories accurately", () => {
      const wt1 = path.join(worktreesDir, "run-1");
      const wt2 = path.join(worktreesDir, "run-2");
      fs.mkdirSync(path.join(wt1, "sub"), { recursive: true });
      fs.mkdirSync(wt2, { recursive: true });

      // wt1 has 100 bytes + 200 bytes = 300 bytes
      fs.writeFileSync(path.join(wt1, "file1.txt"), Buffer.alloc(100, 1));
      fs.writeFileSync(path.join(wt1, "sub", "file2.txt"), Buffer.alloc(200, 2));

      // wt2 has 400 bytes
      fs.writeFileSync(path.join(wt2, "file3.txt"), Buffer.alloc(400, 3));

      const manager = DiskBudgetManager.load(worktreesDir);
      const total = manager.totalSizeBytes();

      // Total must be at least 700 bytes (file content size sum)
      expect(total).toBe(700);

      // Measuring specific worktree directory size
      expect(manager.getDirectorySize(wt1)).toBe(300);
      expect(manager.getDirectorySize(wt2)).toBe(400);
    });

    it("ignores symbolic links to prevent circular loops or escaping root", () => {
      const wt1 = path.join(worktreesDir, "run-sym");
      const externalDir = path.join(tempDir, "external");
      fs.mkdirSync(wt1, { recursive: true });
      fs.mkdirSync(externalDir, { recursive: true });
      fs.writeFileSync(path.join(wt1, "real.txt"), Buffer.alloc(100, 1));
      fs.writeFileSync(path.join(externalDir, "external.txt"), Buffer.alloc(10000, 2));

      // Create a symlink pointing to externalDir
      try {
        fs.symlinkSync(externalDir, path.join(wt1, "ext-link"));
      } catch {
        // Symlinks may require elevated privileges on some Windows configurations; skip if unsupported
      }

      const manager = DiskBudgetManager.load(worktreesDir);
      // wt1 size must be 100, ignoring the 10000 bytes in externalDir
      expect(manager.getDirectorySize(wt1)).toBe(100);
      expect(manager.totalSizeBytes()).toBe(100);
    });

    it("rejects path traversal and invalid directory names in runId", () => {
      const manager = DiskBudgetManager.load(worktreesDir);
      expect(() => manager.recordUse("../escaped")).toThrow();
      expect(() => manager.getWorktreeUsage("../../escaped")).toThrow();
      expect(() => manager.recordUse("")).toThrow();
      expect(() => manager.recordUse(".")).toThrow();
      expect(() => manager.recordUse("foo/bar")).toThrow();
      expect(() => manager.recordUse("foo\\bar")).toThrow();
    });

    it("prevents prototype pollution when deserializing manifest", () => {
      const manifestPath = path.join(worktreesDir, ".usage.json");
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          __proto__: { polluted: true },
          "run-safe": { lastUsedAt: 1234, sizeBytes: 100 },
        }),
        "utf8"
      );

      const manager = DiskBudgetManager.load(worktreesDir);
      expect(manager.usage()["run-safe"]).toBeDefined();
      expect(({} as any).polluted).toBeUndefined();
    });
  });

  describe("manifest round-trip & recording", () => {
    it("records use and round-trips correctly via save() and load()", () => {
      const wt1 = path.join(worktreesDir, "run-abc");
      fs.mkdirSync(wt1, { recursive: true });
      fs.writeFileSync(path.join(wt1, "code.ts"), Buffer.alloc(256, 9));

      const manager = DiskBudgetManager.load(worktreesDir);
      const beforeTime = Date.now() - 10;
      manager.recordUse("run-abc");
      manager.save();

      const manifestPath = path.join(worktreesDir, ".usage.json");
      expect(fs.existsSync(manifestPath)).toBe(true);

      // Reload
      const loaded = DiskBudgetManager.load(worktreesDir);
      const usage = loaded.usage();
      expect(usage["run-abc"]).toBeDefined();
      expect(usage["run-abc"].sizeBytes).toBe(256);
      expect(usage["run-abc"].lastUsedAt).toBeGreaterThanOrEqual(beforeTime);
    });

    it("allows explicitly specifying sizeBytes in recordUse", () => {
      const manager = DiskBudgetManager.load(worktreesDir);
      const timestamp = 1700000000000;
      manager.recordUse("run-custom", 1024, timestamp);
      manager.save();

      const loaded = DiskBudgetManager.load(worktreesDir);
      const entry = loaded.usage()["run-custom"];
      expect(entry).toEqual({
        lastUsedAt: timestamp,
        sizeBytes: 1024,
      });
    });
  });

  describe("corrupt or missing manifest fallback", () => {
    it("treats missing manifest as empty usage and falls back to directory mtime", () => {
      const wtPath = path.join(worktreesDir, "run-untracked");
      fs.mkdirSync(wtPath, { recursive: true });
      fs.writeFileSync(path.join(wtPath, "file.txt"), Buffer.alloc(50, 1));

      const stat = fs.statSync(wtPath);

      const manager = DiskBudgetManager.load(worktreesDir);
      expect(manager.usage()).toEqual({});

      const entry = manager.getWorktreeUsage("run-untracked");
      expect(entry.sizeBytes).toBe(50);
      expect(entry.lastUsedAt).toBe(Math.floor(stat.mtimeMs));
    });

    it("treats corrupt or non-object JSON as empty usage without throwing", () => {
      const manifestPath = path.join(worktreesDir, ".usage.json");
      fs.writeFileSync(manifestPath, "{ corrupt json !!!", "utf8");

      const manager = DiskBudgetManager.load(worktreesDir);
      expect(manager.usage()).toEqual({});

      // Non-object JSON
      fs.writeFileSync(manifestPath, "[\"an\", \"array\"]", "utf8");
      const manager2 = DiskBudgetManager.load(worktreesDir);
      expect(manager2.usage()).toEqual({});

      // Null JSON
      fs.writeFileSync(manifestPath, "null", "utf8");
      const manager3 = DiskBudgetManager.load(worktreesDir);
      expect(manager3.usage()).toEqual({});
    });
  });

  describe("atomic manifest write", () => {
    it("ensures previous manifest survives a failed write", () => {
      const manager = DiskBudgetManager.load(worktreesDir);
      manager.recordUse("run-initial", 500, 1000);
      manager.save();

      const manifestPath = path.join(worktreesDir, ".usage.json");
      const initialContent = fs.readFileSync(manifestPath, "utf8");

      // Attempt to save new state with a failing renameSync
      manager.recordUse("run-second", 800, 2000);
      expect(() => {
        manager.save({
          renameSync: () => {
            throw new Error("Disk full or simulated failure during atomic rename");
          },
        });
      }).toThrow("Disk full or simulated failure during atomic rename");

      // The original file content must still be intact and valid
      const contentAfterFail = fs.readFileSync(manifestPath, "utf8");
      expect(contentAfterFail).toBe(initialContent);

      const reloaded = DiskBudgetManager.load(worktreesDir);
      expect(reloaded.usage()["run-initial"]).toEqual({
        lastUsedAt: 1000,
        sizeBytes: 500,
      });
      expect(reloaded.usage()["run-second"]).toBeUndefined();
    });
  });

  describe("LRU Eviction & Pre-Flight Budget Enforcement (Ticket #60)", () => {
    let repoDir: string;
    let gitWorktreesDir: string;

    beforeEach(() => {
      repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "perfgym-git-evict-test-"));
      execSync("git init", { cwd: repoDir, stdio: "ignore" });
      execSync("git config core.autocrlf false", { cwd: repoDir, stdio: "ignore" });
      execSync('git config user.name "PerfGym Tester"', { cwd: repoDir, stdio: "ignore" });
      execSync('git config user.email "test@perfgym.dev"', { cwd: repoDir, stdio: "ignore" });
      execSync("git checkout -B main", { cwd: repoDir, stdio: "ignore" });

      fs.writeFileSync(path.join(repoDir, ".gitignore"), ".perfgym/\n", "utf8");
      fs.writeFileSync(path.join(repoDir, "README.md"), "# Test Repo\n", "utf8");
      execSync("git add .gitignore README.md", { cwd: repoDir, stdio: "ignore" });
      execSync('git commit -m "initial commit"', { cwd: repoDir, stdio: "ignore" });

      gitWorktreesDir = path.join(repoDir, ".perfgym", "worktrees");
      fs.mkdirSync(gitWorktreesDir, { recursive: true });
    });

    afterEach(() => {
      try {
        fs.rmSync(repoDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    });

    it("proves the LRU worktree is evicted first and the newest survives (AC1)", () => {
      // Create three worktrees: wt-old (100 bytes), wt-mid (100 bytes), wt-new (100 bytes)
      const wtOld = path.join(gitWorktreesDir, "run-old");
      const wtMid = path.join(gitWorktreesDir, "run-mid");
      const wtNew = path.join(gitWorktreesDir, "run-new");

      execSync(`git worktree add -B perfgym/eval-run-old ${wtOld} HEAD`, { cwd: repoDir, stdio: "ignore" });
      execSync(`git worktree add -B perfgym/eval-run-mid ${wtMid} HEAD`, { cwd: repoDir, stdio: "ignore" });
      execSync(`git worktree add -B perfgym/eval-run-new ${wtNew} HEAD`, { cwd: repoDir, stdio: "ignore" });

      fs.writeFileSync(path.join(wtOld, "data.bin"), Buffer.alloc(100, 1));
      fs.writeFileSync(path.join(wtMid, "data.bin"), Buffer.alloc(100, 2));
      fs.writeFileSync(path.join(wtNew, "data.bin"), Buffer.alloc(100, 3));

      const manager = DiskBudgetManager.load(gitWorktreesDir);
      manager.recordUse("run-old", 100, 1000);
      manager.recordUse("run-mid", 100, 2000);
      manager.recordUse("run-new", 100, 3000);
      manager.save();

      // Cap is 250 bytes. Total is ~300 bytes (plus metadata/git overhead).
      // If we ask to evict to fit within 200 bytes:
      const result = manager.evictLruToFit({
        capBytes: 200,
        estimatedNewBytes: 0,
        repoRoot: repoDir,
      });

      expect(result.evictedRunIds).toContain("run-old");
      expect(fs.existsSync(wtOld)).toBe(false);
      expect(fs.existsSync(wtNew)).toBe(true);
    });

    it("proves the active worktree is never evicted, even when it is the oldest (AC2)", () => {
      const wtOld = path.join(gitWorktreesDir, "run-old");
      const wtNew = path.join(gitWorktreesDir, "run-new");

      execSync(`git worktree add -B perfgym/eval-run-old ${wtOld} HEAD`, { cwd: repoDir, stdio: "ignore" });
      execSync(`git worktree add -B perfgym/eval-run-new ${wtNew} HEAD`, { cwd: repoDir, stdio: "ignore" });

      fs.writeFileSync(path.join(wtOld, "data.bin"), Buffer.alloc(100, 1));
      fs.writeFileSync(path.join(wtNew, "data.bin"), Buffer.alloc(100, 2));

      const manager = DiskBudgetManager.load(gitWorktreesDir);
      manager.recordUse("run-old", 100, 1000);
      manager.recordUse("run-new", 100, 3000);
      manager.save();

      // run-old is the active worktree (~178 bytes with git overhead). Both total ~350 bytes.
      // Cap is 250 bytes: eviction is required, run-new must be evicted, active run-old must survive.
      const result = manager.evictLruToFit({
        capBytes: 250,
        estimatedNewBytes: 0,
        activeRunId: "run-old",
        repoRoot: repoDir,
      });

      // run-old must survive; run-new was evicted instead
      expect(result.evictedRunIds).toContain("run-new");
      expect(result.evictedRunIds).not.toContain("run-old");
      expect(fs.existsSync(wtOld)).toBe(true);
      expect(fs.existsSync(wtNew)).toBe(false);
    });

    it("proves a worktree whose run is in progress is never evicted (AC3)", () => {
      const wt1 = path.join(gitWorktreesDir, "run-progress");
      const wt2 = path.join(gitWorktreesDir, "run-idle");

      execSync(`git worktree add -B perfgym/eval-run-progress ${wt1} HEAD`, { cwd: repoDir, stdio: "ignore" });
      execSync(`git worktree add -B perfgym/eval-run-idle ${wt2} HEAD`, { cwd: repoDir, stdio: "ignore" });

      fs.writeFileSync(path.join(wt1, "data.bin"), Buffer.alloc(100, 1));
      fs.writeFileSync(path.join(wt2, "data.bin"), Buffer.alloc(100, 2));

      const manager = DiskBudgetManager.load(gitWorktreesDir);
      manager.recordUse("run-progress", 100, 1000);
      manager.recordUse("run-idle", 100, 2000);
      manager.save();

      // Cap is 250 bytes: run-idle is evicted, run-progress is protected and survives.
      const result = manager.evictLruToFit({
        capBytes: 250,
        estimatedNewBytes: 0,
        protectedRunIds: ["run-progress"],
        repoRoot: repoDir,
      });

      expect(result.evictedRunIds).toContain("run-idle");
      expect(result.evictedRunIds).not.toContain("run-progress");
      expect(fs.existsSync(wt1)).toBe(true);
      expect(fs.existsSync(wt2)).toBe(false);
    });

    it("proves eviction uses git worktree remove and keeps git metadata consistent (AC4)", () => {
      const wt1 = path.join(gitWorktreesDir, "run-to-remove");
      execSync(`git worktree add -B perfgym/eval-run-to-remove ${wt1} HEAD`, { cwd: repoDir, stdio: "ignore" });

      const listBefore = execSync("git worktree list --porcelain", { cwd: repoDir, encoding: "utf8" });
      expect(listBefore).toContain("run-to-remove");

      const manager = DiskBudgetManager.load(gitWorktreesDir);
      manager.recordUse("run-to-remove", 100, 1000);
      manager.save();

      manager.evictLruToFit({
        capBytes: 10,
        estimatedNewBytes: 0,
        repoRoot: repoDir,
      });

      // git worktree list must no longer show run-to-remove
      const listAfter = execSync("git worktree list --porcelain", { cwd: repoDir, encoding: "utf8" });
      expect(listAfter).not.toContain("run-to-remove");

      // git status in repoRoot must be pristine and worktree prune exits 0
      const status = execSync("git status --porcelain", { cwd: repoDir, encoding: "utf8" });
      expect(status.trim()).toBe("");
      expect(() => execSync("git worktree prune", { cwd: repoDir })).not.toThrow();
    });

    it("proves the fail-fast error message names the usage, the cap, and the remedy (AC5)", () => {
      const wtActive = path.join(gitWorktreesDir, "run-active");
      execSync(`git worktree add -B perfgym/eval-run-active ${wtActive} HEAD`, { cwd: repoDir, stdio: "ignore" });
      fs.writeFileSync(path.join(wtActive, "data.bin"), Buffer.alloc(200, 1));

      const manager = DiskBudgetManager.load(gitWorktreesDir);
      manager.recordUse("run-active", 200, 1000);
      manager.save();

      // Cap is 100 bytes, but active worktree is 200 bytes and protected -> nothing can be evicted
      let thrown: WorktreeDiskBudgetExceededError | null = null;
      try {
        manager.evictLruToFit({
          capBytes: 100,
          estimatedNewBytes: 0,
          activeRunId: "run-active",
          repoRoot: repoDir,
        });
      } catch (err: unknown) {
        if (err instanceof WorktreeDiskBudgetExceededError) {
          thrown = err;
        }
      }

      expect(thrown).not.toBeNull();
      expect(thrown!.code).toBe(ERR_WORKTREE_DISK_BUDGET_EXCEEDED);
      expect(thrown!.capBytes).toBe(100);
      expect(thrown!.usedBytes).toBeGreaterThanOrEqual(200);

      const msg = thrown!.message;
      // Must name: "disk budget exceeded", usage ("... used"), cap ("cap ..."), remedy ("raise `sandbox.disk_budget_mb` or free space")
      expect(msg).toContain("disk budget exceeded");
      expect(msg).toContain("used");
      expect(msg).toContain("cap");
      expect(msg).toContain("nothing left to evict");
      expect(msg).toContain("raise `sandbox.disk_budget_mb` or free space");
    });

    it("prunes the corresponding branch only if gc.prune_branches is true", () => {
      const wt1 = path.join(gitWorktreesDir, "run-keep-branch");
      execSync(`git worktree add -B perfgym/eval-run-keep-branch ${wt1} HEAD`, { cwd: repoDir, stdio: "ignore" });

      const manager = DiskBudgetManager.load(gitWorktreesDir);
      manager.recordUse("run-keep-branch", 100, 1000);
      manager.save();

      // pruneBranches false (default)
      manager.evictLruToFit({
        capBytes: 10,
        repoRoot: repoDir,
        pruneBranches: false,
      });

      const branchesAfter = execSync("git branch --list perfgym/eval-run-keep-branch", { cwd: repoDir, encoding: "utf8" });
      expect(branchesAfter).toContain("perfgym/eval-run-keep-branch");

      // Now create another worktree and evict with pruneBranches: true
      const wt2 = path.join(gitWorktreesDir, "run-prune-branch");
      execSync(`git worktree add -B perfgym/eval-run-prune-branch ${wt2} HEAD`, { cwd: repoDir, stdio: "ignore" });
      manager.recordUse("run-prune-branch", 100, 2000);
      manager.save();

      manager.evictLruToFit({
        capBytes: 10,
        repoRoot: repoDir,
        pruneBranches: true,
      });

      const branchesAfterPrune = execSync("git branch --list perfgym/eval-run-prune-branch", { cwd: repoDir, encoding: "utf8" });
      expect(branchesAfterPrune.trim()).toBe("");

      // Test with baseRef: if merged into baseRef, branch is preserved; if unmerged, pruned
      const wtMerged = path.join(gitWorktreesDir, "run-merged-branch");
      execSync(`git worktree add -B perfgym/eval-run-merged-branch ${wtMerged} HEAD`, { cwd: repoDir, stdio: "ignore" });
      manager.recordUse("run-merged-branch", 100, 3000);
      manager.save();

      // Because perfgym/eval-run-merged-branch points to HEAD, it is an ancestor of main (merged)
      manager.evictLruToFit({
        capBytes: 10,
        repoRoot: repoDir,
        pruneBranches: true,
        baseRef: "main",
      });

      const branchesMerged = execSync("git branch --list perfgym/eval-run-merged-branch", { cwd: repoDir, encoding: "utf8" });
      expect(branchesMerged).toContain("perfgym/eval-run-merged-branch");
    });
  });
});
