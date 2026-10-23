import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { stringify as stringifyYaml } from "yaml";
import {
  InMemorySandboxDriver,
  GitSandboxCoordinator,
  type PerfGymConfig,
} from "../../core/src/index.js";
import {
  McpServerCoordinator,
  type BaselineOutcome,
  type StepEvaluation,
  type StatusReport,
  type InvariantResult,
  type LintOutcome,
  type BenchmarkOutcome,
  type RollbackOutcome,
} from "../src/coordinator/index.js";

describe("McpServerCoordinator Deep Module (Ticket #43)", () => {
  let testDir: string;
  let lockDir: string;
  let driver: InMemorySandboxDriver;
  let sandbox: GitSandboxCoordinator;
  let coordinator: McpServerCoordinator;
  let config: PerfGymConfig;

  beforeEach(() => {
    testDir = path.join(
      tmpdir(),
      `perfgym-coord-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    );
    fs.mkdirSync(testDir, { recursive: true });
    lockDir = path.join(testDir, ".perfgym", ".lock.d");

    // Sample config using reliable shell inline commands
    config = {
      version: "1.0",
      target: {
        name: "test-target",
        language: "typescript",
        files: ["src/**/*.ts"],
      },
      invariants: {
        command: "node -e 'process.exit(0)'",
        timeoutMs: 5000,
      },
      rules: [
        {
          id: "no-any",
          message: "any type is forbidden",
          severity: "error",
          penalty: 50,
          pattern: "let $VAR: any = $VAL",
        },
      ],
      metrics: [
        {
          name: "latency",
          command: "node -e 'console.log(JSON.stringify({ value: 100 }))'",
          goal: "minimize",
          weight: 1,
          unit: "ms",
        },
      ],
    };

    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), stringifyYaml(config), "utf8");

    driver = new InMemorySandboxDriver({
      allowedGlobs: ["src/**/*.ts"],
      initialFiles: {
        "src/index.ts": "export const value = 1;\n",
      },
    });

    sandbox = new GitSandboxCoordinator(driver, {
      lockDir,
      repoRoot: testDir,
    });

    coordinator = new McpServerCoordinator({
      rootDir: testDir,
      sandbox,
      driver,
      config,
    });
  });

  afterEach(async () => {
    if (sandbox.isLocked()) {
      await sandbox.release();
    }
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });

  it("handles status when not initialized without throwing or creating state file", async () => {
    const statePath = path.join(testDir, ".perfgym", "state.json");
    expect(fs.existsSync(statePath)).toBe(false);

    const status = await coordinator.handleStatus();
    expect(status.initialized).toBe(false);
    expect(status.sessionStatus).toBe("not_initialized");
    expect(status.currentStep).toBe(0);
    expect(status.stepHistory).toEqual([]);
    expect(status.lockState.locked).toBe(false);

    // Hard requirement 4 & AC 3: handleStatus is read-only and does NOT write state file
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it("handles baseline and returns structured BaselineOutcome", async () => {
    const outcome = await coordinator.handleBaseline({ samples: 3 });

    expect(outcome.targetName).toBe("test-target");
    expect(outcome.invariantsPassed).toBe(true);
    expect(outcome.baselineMetrics.latency).toBe(100);
    expect(outcome.distributions.latency).toBeDefined();
    expect(outcome.distributions.latency.p50).toBe(100);
    expect(outcome.state).toBeDefined();
    expect(outcome.state.bestFitnessScore).toBe(0);

    // State file is created by baseline
    const statePath = path.join(testDir, ".perfgym", "state.json");
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it("handles step evaluation with mutation and updates state + history", async () => {
    await coordinator.handleBaseline({ samples: 2 });

    // Faster metric command: latency dropped from 100 to 50
    const fasterConfig = {
      ...config,
      metrics: [
        {
          name: "latency",
          command: "node -e 'console.log(JSON.stringify({ value: 50 }))'",
          goal: "minimize" as const,
          weight: 1,
          unit: "ms" as const,
        },
      ],
    };
    coordinator.updateConfig(fasterConfig);

    const step = await coordinator.handleStep({
      mutations: [
        { relPath: "src/index.ts", content: "export const value = 2;\n" },
      ],
      samples: 2,
    });

    expect(step.accepted).toBe(true);
    expect(step.fitnessScore).toBeGreaterThan(0);
    expect(step.deltaPercent).toBe(50);
    expect(await driver.readFile("src/index.ts")).toBe("export const value = 2;\n");

    const status = await coordinator.handleStatus();
    expect(status.currentStep).toBe(1);
    expect(status.bestStep).toBe(1);
    expect(status.bestFitnessScore).toBe(step.fitnessScore);
    expect(status.stepHistory.length).toBe(1);
    expect(status.stepHistory[0].status).toBe("ACCEPTED");
  });

  it("handles test without side-effects (leaves worktree and state untouched)", async () => {
    await coordinator.handleBaseline({ samples: 2 });
    const stateFile = path.join(testDir, ".perfgym", "state.json");
    const stateBefore = fs.readFileSync(stateFile, "utf8");
    const fileBefore = await driver.readFile("src/index.ts");

    const testRes = await coordinator.handleTest();
    expect(testRes.passed).toBe(true);
    expect(testRes.durationMs).toBeGreaterThanOrEqual(0);

    // State and worktree are untouched
    expect(fs.readFileSync(stateFile, "utf8")).toBe(stateBefore);
    expect(await driver.readFile("src/index.ts")).toBe(fileBefore);
  });

  it("handles lint without side-effects (leaves worktree and state untouched)", async () => {
    await coordinator.handleBaseline({ samples: 2 });
    const stateFile = path.join(testDir, ".perfgym", "state.json");
    const stateBefore = fs.readFileSync(stateFile, "utf8");

    // Write a violation into the driver
    await driver.writeFile("src/index.ts", "let x: any = 10;\n");
    const fileBefore = await driver.readFile("src/index.ts");

    const lintOutcome = await coordinator.handleLint({
      files: ["src/index.ts"],
    });

    expect(lintOutcome.passed).toBe(false);
    expect(lintOutcome.violations.length).toBeGreaterThan(0);
    expect(lintOutcome.totalPenalty).toBeGreaterThan(0);

    // State and worktree are untouched
    expect(fs.readFileSync(stateFile, "utf8")).toBe(stateBefore);
    expect(await driver.readFile("src/index.ts")).toBe(fileBefore);
  });

  it("handles benchmark without side-effects (leaves worktree and state untouched)", async () => {
    await coordinator.handleBaseline({ samples: 2 });
    const stateFile = path.join(testDir, ".perfgym", "state.json");
    const stateBefore = fs.readFileSync(stateFile, "utf8");
    const fileBefore = await driver.readFile("src/index.ts");

    const benchOutcome = await coordinator.handleBenchmark({
      samples: 2,
    });

    expect(benchOutcome.metricName).toBe("latency");
    expect(benchOutcome.distribution).toBeDefined();
    expect(benchOutcome.currentValue).toBe(100);
    expect(benchOutcome.deltaPercent).toBe(0);

    // State and worktree are untouched
    expect(fs.readFileSync(stateFile, "utf8")).toBe(stateBefore);
    expect(await driver.readFile("src/index.ts")).toBe(fileBefore);
  });

  it("handles rollback restoring worktree to last approved state and rewinds pointer", async () => {
    await coordinator.handleBaseline({ samples: 2 });

    // Step 1: Accepted improvement
    const fasterConfig = {
      ...config,
      metrics: [
        {
          name: "latency",
          command: "node -e 'console.log(JSON.stringify({ value: 50 }))'",
          goal: "minimize" as const,
          weight: 1,
          unit: "ms" as const,
        },
      ],
    };
    coordinator.updateConfig(fasterConfig);

    await coordinator.handleStep({
      mutations: [{ relPath: "src/index.ts", content: "export const value = 2;\n" }],
      samples: 2,
    });
    expect(await driver.readFile("src/index.ts")).toBe("export const value = 2;\n");

    // Step 2: Another mutation accepted
    const evenFasterConfig = {
      ...config,
      metrics: [
        {
          name: "latency",
          command: "node -e 'console.log(JSON.stringify({ value: 30 }))'",
          goal: "minimize" as const,
          weight: 1,
          unit: "ms" as const,
        },
      ],
    };
    coordinator.updateConfig(evenFasterConfig);

    await coordinator.handleStep({
      mutations: [{ relPath: "src/index.ts", content: "export const value = 3;\n" }],
      samples: 2,
    });
    expect(await driver.readFile("src/index.ts")).toBe("export const value = 3;\n");

    // Rollback step 2 -> should rewind to step 1
    const rollbackRes = await coordinator.handleRollback();
    expect(rollbackRes.success).toBe(true);
    expect(rollbackRes.status).toBe("ROLLED_BACK");
    expect(rollbackRes.rolledBackStep).toBe(2);
    expect(rollbackRes.restoredStep).toBe(1);

    // Worktree restored to step 1 state
    expect(await driver.readFile("src/index.ts")).toBe("export const value = 2;\n");

    // Status shows history kept, step 2 marked ROLLED_BACK, pointer rewound
    const status = await coordinator.handleStatus();
    expect(status.currentStep).toBe(1);
    expect(status.stepHistory.length).toBe(2);
    expect(status.stepHistory[0].status).toBe("ACCEPTED");
    expect(status.stepHistory[1].status).toBe("ROLLED_BACK");

    // Rollback step 1 -> should rewind to baseline (step 0)
    const rollbackRes2 = await coordinator.handleRollback();
    expect(rollbackRes2.success).toBe(true);
    expect(rollbackRes2.rolledBackStep).toBe(1);
    expect(rollbackRes2.restoredStep).toBe(0);

    // Worktree restored to initial baseline state
    expect(await driver.readFile("src/index.ts")).toBe("export const value = 1;\n");

    const status2 = await coordinator.handleStatus();
    expect(status2.currentStep).toBe(0);
    expect(status2.stepHistory.length).toBe(2);
    expect(status2.stepHistory[0].status).toBe("ROLLED_BACK");
  });

  it("proves handleRollback REFUSES while another holder owns the lock and message says 'lock busy'", async () => {
    // Simulate another process holding the lock
    fs.mkdirSync(lockDir, { recursive: true });
    const activeLockMeta = {
      pid: process.pid, // current running process PID
      runId: "alien-run-12345",
      startTime: Date.now(),
      heartbeat: Date.now(),
    };
    fs.writeFileSync(
      path.join(lockDir, "metadata.json"),
      JSON.stringify(activeLockMeta),
      "utf8"
    );

    // A separate coordinator instance attempting rollback must refuse
    const otherDriver = new InMemorySandboxDriver();
    const otherSandbox = new GitSandboxCoordinator(otherDriver, {
      lockDir,
      repoRoot: testDir,
    });
    const alienCoordinator = new McpServerCoordinator({
      rootDir: testDir,
      sandbox: otherSandbox,
      driver: otherDriver,
      config,
    });

    await expect(alienCoordinator.handleRollback()).rejects.toThrow(/lock busy/i);
  });
});

// ============================================================================
// Review round 2 — findings F1–F10
// ============================================================================

import { hashMutatedFiles } from "../../core/src/index.js";
import {
  loadNegativeMemory,
  readState,
  writeState,
} from "../src/engine.js";
import { inspectLockState } from "../src/coordinator/handlers.js";
import { GitWorktreeDriver } from "../../core/src/sandbox/git-worktree-driver.js";

describe("McpServerCoordinator review fixes (F1–F10)", () => {
  let testDir: string;
  let lockDir: string;
  let driver: InMemorySandboxDriver;
  let sandbox: GitSandboxCoordinator;
  let coordinator: McpServerCoordinator;
  let config: PerfGymConfig;

  /** Metered config factory: metric command is configurable per step. */
  const makeConfig = (latencyValue: number): PerfGymConfig => ({
    version: "1.0",
    target: { name: "test-target", language: "typescript", files: ["src/**/*.ts"] },
    invariants: { command: "node -e 'process.exit(0)'", timeoutMs: 5000 },
    metrics: [
      {
        name: "latency",
        command: `node -e 'console.log(JSON.stringify({ value: ${latencyValue} }))'`,
        goal: "minimize",
        weight: 1,
        unit: "ms",
      },
    ],
  });

  beforeEach(() => {
    testDir = path.join(
      tmpdir(),
      `perfgym-coord-fix-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    );
    fs.mkdirSync(testDir, { recursive: true });
    lockDir = path.join(testDir, ".perfgym", ".lock.d");

    config = makeConfig(100);
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), stringifyYaml(config), "utf8");

    driver = new InMemorySandboxDriver({
      allowedGlobs: ["src/**/*.ts"],
      initialFiles: { "src/index.ts": "export const value = 1;\n" },
    });

    sandbox = new GitSandboxCoordinator(driver, { lockDir, repoRoot: testDir });
    coordinator = new McpServerCoordinator({ rootDir: testDir, sandbox, driver, config });
  });

  afterEach(async () => {
    if (sandbox.isLocked()) await sandbox.release();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  });

  // --- F1 -------------------------------------------------------------------
  it("F1: negative memory stores the failed candidate mutation, not the reverted original", async () => {
    await coordinator.handleBaseline({ samples: 2 });

    // Regressing metric command (300 vs baseline 100) forces rejection
    coordinator.updateConfig(makeConfig(300));

    const mutation = { relPath: "src/index.ts", content: "export const value = 99;\n" };
    const step = await coordinator.handleStep({
      mutations: [mutation],
      samples: 2,
      recordNegativeMemory: true,
    });
    expect(step.accepted).toBe(false);

    // The recorded fingerprint must hash the FAILED MUTATION CONTENT.
    const cache = loadNegativeMemory(testDir, config.target.name);
    const entries = cache.entries();
    expect(entries.length).toBe(1);
    expect(entries[0].id).toBe(hashMutatedFiles([mutation]));
  });

  // --- F2 -------------------------------------------------------------------
  it("F2: baseline persists baselineCommit (outcome + state) and rollback-to-baseline targets it", async () => {
    const outcome = await coordinator.handleBaseline({ samples: 2 });

    // Outcome carries the baseline commit reference (in-memory pseudo-commit here)
    expect(typeof outcome.commitHash).toBe("string");
    expect(outcome.commitHash!.length).toBeGreaterThan(0);

    // State file carries it too
    const state = readState(testDir) as { baselineCommit?: string };
    expect(state.baselineCommit).toBe(outcome.commitHash);

    // All-rejected history: rollback rewinds to baseline targeting baselineCommit,
    // never a literal "HEAD" fallback.
    coordinator.updateConfig(makeConfig(300)); // regression → rejected step
    const step = await coordinator.handleStep({
      mutations: [{ relPath: "src/index.ts", content: "export const value = 77;\n" }],
      samples: 2,
    });
    expect(step.accepted).toBe(false);

    const rollbackRes = await coordinator.handleRollback();
    expect(rollbackRes.success).toBe(true);
    expect(rollbackRes.restoredStep).toBe(0);
    expect(rollbackRes.targetCommit).toBe(outcome.commitHash);
    expect(rollbackRes.targetCommit).not.toBe("HEAD");
    expect(await driver.readFile("src/index.ts")).toBe("export const value = 1;\n");
  });

  // --- F3 -------------------------------------------------------------------
  it("F3: rollback restores current metric values/deltas consistent with the restored state", async () => {
    await coordinator.handleBaseline({ samples: 2 }); // latency 100

    coordinator.updateConfig(makeConfig(50)); // step 1 → +50%
    await coordinator.handleStep({
      mutations: [{ relPath: "src/index.ts", content: "export const value = 2;\n" }],
      samples: 2,
    });

    coordinator.updateConfig(makeConfig(30)); // step 2 → +70%
    await coordinator.handleStep({
      mutations: [{ relPath: "src/index.ts", content: "export const value = 3;\n" }],
      samples: 2,
    });

    // Roll back the tip (step 2): current values must reflect restored step 1
    await coordinator.handleRollback();
    let status = await coordinator.handleStatus();
    expect(status.currentValues.latency).toBe(50);
    expect(status.metricDeltas.latency).toBeCloseTo(50);

    // Roll back step 1 too: back to baseline values/deltas
    await coordinator.handleRollback();
    status = await coordinator.handleStatus();
    expect(status.currentValues.latency).toBe(100);
    expect(status.metricDeltas.latency).toBe(0);
  });

  // --- F4 -------------------------------------------------------------------
  it("F4: best fitness/step after rollback is the max over ALL remaining ACCEPTED steps", async () => {
    await coordinator.handleBaseline({ samples: 2 }); // latency 100

    coordinator.updateConfig(makeConfig(40)); // step 1: +60%
    const step1 = await coordinator.handleStep({
      mutations: [{ relPath: "src/index.ts", content: "export const value = 2;\n" }],
      samples: 2,
    });

    coordinator.updateConfig(makeConfig(97)); // step 2: +3% → score 3 (barely significant)
    const step2 = await coordinator.handleStep({
      mutations: [{ relPath: "src/index.ts", content: "export const value = 3;\n" }],
      samples: 2,
    });

    coordinator.updateConfig(makeConfig(50)); // step 3: +50% → score 50
    const step3 = await coordinator.handleStep({
      mutations: [{ relPath: "src/index.ts", content: "export const value = 4;\n" }],
      samples: 2,
    });

    expect(step1.accepted).toBe(true);
    expect(step2.accepted).toBe(true);
    expect(step3.accepted).toBe(true);

    // Targeted rollback of the MIDDLE step (2). Remaining ACCEPTED entries are
    // steps 1 and 3 — the most recent ACCEPTED is step 3 (score 50), but the
    // BEST is step 1 (score 60). The old code only looked at the most recent
    // accepted entry and would report step 3's lower score.
    expect(step1.fitnessScore).toBeGreaterThan(step3.fitnessScore);
    await coordinator.handleRollback({ stepNumber: 2 });
    let status = await coordinator.handleStatus();
    expect(status.stepHistory[1].status).toBe("ROLLED_BACK");
    expect(status.bestFitnessScore).toBe(step1.fitnessScore);
    expect(status.bestStep).toBe(1);

    // Roll back step 3 as well: only step 1 remains accepted
    await coordinator.handleRollback({ stepNumber: 3 });
    status = await coordinator.handleStatus();
    expect(status.bestFitnessScore).toBe(step1.fitnessScore);
    expect(status.bestStep).toBe(1);
  });

  // --- F5 -------------------------------------------------------------------
  it("F5: rollback on uninitialized / empty-history workspace never leaks the lock", async () => {
    // Uninitialized: no state.json at all. No lock may be created or held.
    await expect(coordinator.handleRollback()).rejects.toThrow(/No baseline/);
    expect(sandbox.isLocked()).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(false);

    // Initialized but empty history. The lock must still not leak.
    writeState(
      testDir,
      {
        version: "1.0",
        initializedAt: Date.now(),
        updatedAt: Date.now(),
        targetName: config.target.name,
        baselineMetrics: { latency: 100 },
        invariantsPassed: true,
        bestFitnessScore: 0,
        acceptedStepCount: 0,
        totalStepCount: 0,
        history: [],
      } as never
    );
    await expect(coordinator.handleRollback()).rejects.toThrow(/No step history/);
    expect(sandbox.isLocked()).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  // --- F6 -------------------------------------------------------------------
  it("F6: default rollback target selects the most recent ACCEPTED step, never a REJECTED one", async () => {
    await coordinator.handleBaseline({ samples: 2 }); // latency 100

    // Step 1: accepted improvement
    coordinator.updateConfig(makeConfig(50));
    await coordinator.handleStep({
      mutations: [{ relPath: "src/index.ts", content: "export const value = 2;\n" }],
      samples: 2,
    });

    // Step 2: rejected regression
    coordinator.updateConfig(makeConfig(300));
    const rejected = await coordinator.handleStep({
      mutations: [{ relPath: "src/index.ts", content: "export const value = 9;\n" }],
      samples: 2,
    });
    expect(rejected.accepted).toBe(false);

    // Default rollback must undo step 1 (the last APPLIED/approved step),
    // restoring the baseline — not no-op on the never-applied step 2.
    const rollbackRes = await coordinator.handleRollback();
    expect(rollbackRes.rolledBackStep).toBe(1);
    expect(rollbackRes.restoredStep).toBe(0);
    expect(await driver.readFile("src/index.ts")).toBe("export const value = 1;\n");

    const status = await coordinator.handleStatus();
    expect(status.stepHistory[0].status).toBe("ROLLED_BACK");
    expect(status.stepHistory[1].status).toBe("REJECTED");
  });

  // --- F8 -------------------------------------------------------------------
  it("F8: rejected step leaves the host disk clean (mutated file restored, created file removed)", async () => {
    await coordinator.handleBaseline({ samples: 2 });

    coordinator.updateConfig(makeConfig(300)); // regression → rejected
    const step = await coordinator.handleStep({
      mutations: [
        { relPath: "src/index.ts", content: "export const value = 99;\n" },
        { relPath: "src/extra.ts", content: "export const extra = true;\n" },
      ],
      samples: 2,
    });
    expect(step.accepted).toBe(false);

    // In-memory driver state reverted...
    expect(await driver.readFile("src/index.ts")).toBe("export const value = 1;\n");
    await expect(driver.readFile("src/extra.ts")).rejects.toThrow();

    // ...and the HOST DISK is clean too: mutated file restored, created file gone.
    const diskIndex = fs.readFileSync(path.join(testDir, "src", "index.ts"), "utf8");
    expect(diskIndex).toBe("export const value = 1;\n");
    expect(fs.existsSync(path.join(testDir, "src", "extra.ts"))).toBe(false);
  });
});

// --- F9 (pure function) -----------------------------------------------------
describe("inspectLockState lock semantics (F9)", () => {
  let testDir: string;
  let lockDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `perfgym-lock-f9-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testDir, { recursive: true });
    lockDir = path.join(testDir, ".lock.d");
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("reports unlocked + stale when a live holder's heartbeat is older than the threshold", () => {
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "metadata.json"),
      JSON.stringify({
        pid: process.pid, // alive, but dead in spirit: heartbeat is 40s old
        runId: "zombie",
        startTime: Date.now() - 60_000,
        heartbeat: Date.now() - 40_000,
      }),
      "utf8"
    );

    const report = inspectLockState(lockDir, false, 30_000);
    expect(report.isStale).toBe(true);
    expect(report.locked).toBe(false);
    expect(report.pid).toBe(process.pid);
  });

  it("reports unlocked + stale for a dead holder even with a fresh heartbeat", () => {
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "metadata.json"),
      JSON.stringify({
        pid: 99999999, // dead
        runId: "corpse",
        startTime: Date.now() - 5_000,
        heartbeat: Date.now(),
      }),
      "utf8"
    );

    const report = inspectLockState(lockDir, false, 30_000);
    expect(report.isStale).toBe(true);
    expect(report.locked).toBe(false);
  });

  it("reports locked for a live holder with a fresh heartbeat", () => {
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "metadata.json"),
      JSON.stringify({
        pid: process.pid,
        runId: "active",
        startTime: Date.now(),
        heartbeat: Date.now(),
      }),
      "utf8"
    );

    const report = inspectLockState(lockDir, false, 30_000);
    expect(report.locked).toBe(true);
    expect(report.isStale).toBe(false);
  });
});

// --- F7 (real git worktree driver) ------------------------------------------
describe("handleRollback git restore failure surfaces (F7)", () => {
  let repoDir: string;
  let lockDir: string;

  beforeEach(() => {
    repoDir = path.join(tmpdir(), `perfgym-f7-repo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(repoDir, { recursive: true });
    const run = (args: string[]) => execFileSync("git", args, { cwd: repoDir, stdio: "ignore" });
    try {
      run(["init", "-b", "main"]);
    } catch {
      run(["init"]);
    }
    run(["config", "user.name", "F7 Bot"]);
    run(["config", "user.email", "f7@test.dev"]);
    fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "export const value = 1;\n", "utf8");
    run(["add", "-A"]);
    run(["commit", "-m", "initial"]);
    lockDir = path.join(repoDir, ".perfgym", ".lock.d");
  });

  afterEach(() => {
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("throws a descriptive error instead of claiming success when the git restore fails", async () => {
    const config = {
      version: "1.0",
      target: { name: "f7-target", language: "typescript" as const, files: ["src/**/*.ts"] },
      invariants: { command: "node -e 'process.exit(0)'", timeoutMs: 5000 },
      metrics: [
        {
          name: "latency",
          command: "node -e 'console.log(JSON.stringify({ value: 20 }))'",
          goal: "minimize" as const,
          weight: 1,
          unit: "ms" as const,
        },
      ],
    };

    const driver = new GitWorktreeDriver({ repoRoot: repoDir, allowedGlobs: ["src/**/*"] });
    const sandbox = new GitSandboxCoordinator(driver, { lockDir, repoRoot: repoDir });
    const coordinator = new McpServerCoordinator({
      rootDir: repoDir,
      sandbox,
      driver,
      config,
    });

    try {
      await coordinator.handleBaseline({ samples: 2 });
      await coordinator.handleStep({
        mutations: [{ relPath: "src/index.ts", content: "export const value = 2;\n" }],
        samples: 2,
      });

      // Sabotage git in the worktree: .git is a FILE in worktrees — corrupt it.
      const worktreeDir = sandbox.getContext()!.workingDir;
      fs.writeFileSync(path.join(worktreeDir, ".git"), "this is not a valid gitdir", "utf8");

      // F7: the failure must SURFACE, not be swallowed into a success report.
      await expect(coordinator.handleRollback()).rejects.toThrow(/git|rollback failed/i);
    } finally {
      if (sandbox.isLocked()) await sandbox.release();
    }
  });
});
