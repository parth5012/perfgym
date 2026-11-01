import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, execSync } from "node:child_process";
import { GitWorktreeDriver } from "../../core/src/sandbox/git-worktree-driver.js";
import { DiskBudgetManager } from "../../core/src/gc/disk-budget.js";
import { runOptimizationLoop, type MutationGenerator } from "../src/commands/run.js";
import { loadConfig, saveSession } from "../src/engine.js";

describe("Disk Budget & GC Integration (Ticket #61)", () => {
  let testRepo: string;
  let worktreesDir: string;

  beforeEach(() => {
    testRepo = path.join(
      tmpdir(),
      `perfgym-disk-budget-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    );
    fs.mkdirSync(testRepo, { recursive: true });

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: testRepo, stdio: "ignore" });
    } catch {
      execFileSync("git", ["init"], { cwd: testRepo, stdio: "ignore" });
    }
    execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: testRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test Sentinel"], { cwd: testRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "sentinel@test.com"], { cwd: testRepo, stdio: "ignore" });

    fs.writeFileSync(path.join(testRepo, ".gitignore"), ".perfgym/\n", "utf8");
    fs.mkdirSync(path.join(testRepo, "src"), { recursive: true });
    fs.writeFileSync(path.join(testRepo, "src", "index.ts"), "// value: 100\nexport let count = 0;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: testRepo, stdio: "ignore" });

    worktreesDir = path.join(testRepo, ".perfgym", "worktrees");
    fs.mkdirSync(worktreesDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testRepo, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("AC4: Config loading for sandbox.disk_budget_mb and gc block", () => {
    it("proves the default budget is 2048 MB and the cap is configurable", () => {
      // Default config without sandbox.disk_budget_mb or gc block
      fs.writeFileSync(
        path.join(testRepo, ".perfgym.yaml"),
        `
version: "1.0"
target:
  name: "test-target"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "test-metric"
    command: "node -e 'console.log(JSON.stringify({ value: 100 }))'"
    goal: "minimize"
    weight: 1
`,
        "utf8"
      );

      const defaultConfig = loadConfig(testRepo);
      expect(defaultConfig.sandbox?.disk_budget_mb).toBe(2048);
      expect(defaultConfig.sandbox?.diskBudgetMb).toBe(2048);
      expect(defaultConfig.gc?.enabled).toBe(true);
      expect(defaultConfig.gc?.prune_branches).toBe(false);
      expect(defaultConfig.gc?.pruneBranches).toBe(false);

      // Custom config overriding budget and gc settings
      fs.writeFileSync(
        path.join(testRepo, ".perfgym.yaml"),
        `
version: "1.0"
target:
  name: "test-target"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "test-metric"
    command: "node -e 'console.log(JSON.stringify({ value: 100 }))'"
    goal: "minimize"
    weight: 1
sandbox:
  disk_budget_mb: 512
gc:
  enabled: false
  prune_branches: true
`,
        "utf8"
      );

      const customConfig = loadConfig(testRepo);
      expect(customConfig.sandbox?.disk_budget_mb).toBe(512);
      expect(customConfig.sandbox?.diskBudgetMb).toBe(512);
      expect(customConfig.gc?.enabled).toBe(false);
      expect(customConfig.gc?.prune_branches).toBe(true);
      expect(customConfig.gc?.pruneBranches).toBe(true);
    });
  });

  describe("AC1: GitWorktreeDriver.initialize() pre-flight budget enforcement", () => {
    it("proves exceeding the cap during initialize() evicts an LRU worktree before new one is created", async () => {
      // Pre-create an old worktree `run-stale`
      const staleDir = path.join(worktreesDir, "run-stale");
      execFileSync("git", ["worktree", "add", "-B", "perfgym/eval-run-stale", staleDir, "main"], {
        cwd: testRepo,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(staleDir, "bloat.bin"), Buffer.alloc(1024 * 1024, 1)); // 1MB

      const manager = DiskBudgetManager.load(worktreesDir);
      manager.recordUse("run-stale", 1024 * 1024, 1000);
      manager.save();

      expect(fs.existsSync(staleDir)).toBe(true);

      // Driver configured with very small budget (e.g. 0.0001 MB ~ 100 bytes, so 1MB exceeds it)
      // diskBudgetMb: 1 (1MB cap)
      const driver = new GitWorktreeDriver({
        repoRoot: testRepo,
        worktreesDir,
        allowedGlobs: ["src/**/*"],
        diskBudgetMb: 0.5 as any, // 0.5 MB cap, so 1MB stale worktree exceeds it
        gcEnabled: true,
      });

      // Initialize a new worktree run-fresh
      const ctx = await Effect.runPromise(driver.initialize("run-fresh", "main"));
      expect(ctx.runId).toBe("run-fresh");
      expect(fs.existsSync(ctx.workingDir)).toBe(true);

      // run-stale must have been evicted by initialize()
      expect(fs.existsSync(staleDir)).toBe(false);

      // Usage manifest must now record run-fresh
      const loadedManager = DiskBudgetManager.load(worktreesDir);
      expect(loadedManager.usage()["run-fresh"]).toBeDefined();
      expect(loadedManager.usage()["run-stale"]).toBeUndefined();

      await Effect.runPromise(driver.teardown());
    });
  });

  describe("AC2 & AC3: runOptimizationLoop run-end reclamation pass", () => {
    beforeEach(() => {
      saveSession(testRepo, {
        version: "1.0",
        initializedAt: Date.now(),
        updatedAt: Date.now(),
        targetName: "test-target",
        baselineMetrics: { "test-metric": 100 },
        invariantsPassed: true,
        bestFitnessScore: 0,
        acceptedStepCount: 0,
        totalStepCount: 0,
      });
    });

    it("proves the run-end pass reclaims space from finished runs (AC2)", async () => {
      // Configure .perfgym.yaml with a 1 MB cap
      fs.writeFileSync(
        path.join(testRepo, ".perfgym.yaml"),
        `
version: "1.0"
target:
  name: "test-target"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "test-metric"
    command: "node -e 'console.log(JSON.stringify({ value: 90 }))'"
    goal: "minimize"
    weight: 1
sandbox:
  disk_budget_mb: 1
gc:
  enabled: true
`,
        "utf8"
      );

      const leftoverDir = path.join(worktreesDir, "run-leftover");

      const generator: MutationGenerator = async () => {
        // While the run is progressing, simulate a leftover finished worktree appearing in .perfgym/worktrees
        if (!fs.existsSync(leftoverDir)) {
          execFileSync("git", ["worktree", "add", "-B", "perfgym/eval-run-leftover", leftoverDir, "main"], {
            cwd: testRepo,
            stdio: "ignore",
          });
          fs.writeFileSync(path.join(leftoverDir, "data.bin"), Buffer.alloc(1024 * 1024 * 2, 7)); // 2MB
          const m = DiskBudgetManager.load(worktreesDir);
          m.recordUse("run-leftover", 1024 * 1024 * 2, 1000);
          m.save();
        }
        return [
          { relPath: "src/index.ts", content: "// value: 90\nexport let count = 1;\n" },
        ];
      };

      // Run optimization loop with quiet: false so logs can be checked or output observed
      let loggedOutput = "";
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        loggedOutput += args.join(" ") + "\n";
        originalLog(...args);
      };

      try {
        const res = await Effect.runPromise(
          runOptimizationLoop({
            cwd: testRepo,
            maxIterations: 1,
            generator,
            samples: 1,
            quiet: false,
          })
        );
        expect(res.acceptedCount).toBe(1);
      } finally {
        console.log = originalLog;
      }

      // The leftover worktree must have been evicted during run-end reclamation
      expect(fs.existsSync(leftoverDir)).toBe(false);

      // Output should report eviction/reclamation and budget
      expect(loggedOutput).toContain("GC run-end reclamation");
      expect(loggedOutput).toContain("Worktree disk usage");
    });

    it("proves gc.enabled: false skips enforcement but still reports the size (AC3)", async () => {
      // Create a leftover worktree
      const leftoverDir = path.join(worktreesDir, "run-leftover-disabled");
      execFileSync("git", ["worktree", "add", "-B", "perfgym/eval-run-leftover-disabled", leftoverDir, "main"], {
        cwd: testRepo,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(leftoverDir, "data.bin"), Buffer.alloc(1024 * 1024 * 3, 5)); // 3MB

      const manager = DiskBudgetManager.load(worktreesDir);
      manager.recordUse("run-leftover-disabled", 1024 * 1024 * 3, 1000);
      manager.save();

      // Configure .perfgym.yaml with gc.enabled: false and cap 1 MB (3MB exceeds 1MB)
      fs.writeFileSync(
        path.join(testRepo, ".perfgym.yaml"),
        `
version: "1.0"
target:
  name: "test-target"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "test-metric"
    command: "node -e 'console.log(JSON.stringify({ value: 90 }))'"
    goal: "minimize"
    weight: 1
sandbox:
  disk_budget_mb: 1
gc:
  enabled: false
`,
        "utf8"
      );

      const generator: MutationGenerator = async () => [
        { relPath: "src/index.ts", content: "// value: 90\nexport let count = 1;\n" },
      ];

      let loggedOutput = "";
      const originalLog = console.log;
      console.log = (...args: unknown[]) => {
        loggedOutput += args.join(" ") + "\n";
        originalLog(...args);
      };

      try {
        await Effect.runPromise(
          runOptimizationLoop({
            cwd: testRepo,
            maxIterations: 1,
            generator,
            samples: 1,
            quiet: false,
          })
        );
      } finally {
        console.log = originalLog;
      }

      // Because gc.enabled is false, the 3MB worktree was NOT evicted!
      expect(fs.existsSync(leftoverDir)).toBe(true);

      // Output reports size with GC disabled
      expect(loggedOutput).toContain("GC disabled");
    });
  });
});
