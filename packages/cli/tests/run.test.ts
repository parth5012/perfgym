import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runOptimizationLoop, type MutationContext, type MutationGenerator } from "../src/commands/run.js";
import { runEffect, saveSession } from "../src/engine.js";
import { liveSessionFor } from "../src/live-session.js";
import { GitSandboxCoordinator } from "../../core/src/index.js";

/**
 * The live-session store assertions of Ticket #48: the run loop updates the
 * SessionStore on every iteration (status mutating → evaluating →
 * accepted/rejected, recordStep, bestScore/bestStep) and the flush hook
 * persists each transition to the durable state file, so `perfgym status` in
 * another process reflects a run in progress.
 */
describe("Session store wiring in the run loop (Ticket #48)", () => {
  const configYaml = `
version: "1.0"
target:
  name: "session-loop"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "instructions"
    command: "node -e 'const fs = require(\\"fs\\"); const txt = fs.readFileSync(\\"src/index.ts\\", \\"utf8\\"); const m = txt.match(/value: (\\\\d+)/); const v = m ? parseInt(m[1]) : 100; console.log(JSON.stringify({ value: v }));'"
    goal: "minimize"
    weight: 1
    unit: "count"
`;

  let testDir: string;
  const statePath = path.join(".perfgym", "state.json");
  const readState = (dir: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(dir, statePath), "utf8")) as Record<string, unknown>;

  beforeEach(() => {
    testDir = path.join(
      tmpdir(),
      `perfgym-run-session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir, stdio: "ignore" });
    } catch {
      execFileSync("git", ["init"], { cwd: testDir, stdio: "ignore" });
    }
    execFileSync("git", ["config", "user.name", "Test Sentinel"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "sentinel@test.com"], { cwd: testDir, stdio: "ignore" });

    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "// value: 100\nexport let count = 0;\n", "utf8");
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: testDir, stdio: "ignore" });

    // Established baseline (the "second process" story: the state file exists
    // before the run starts, exactly like `perfgym baseline` would leave it).
    saveSession(testDir, {
      version: "1.0",
      initializedAt: Date.now(),
      updatedAt: Date.now(),
      targetName: "session-loop",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("updates the store's history, bestScore, bestStep and status per iteration", async () => {
    // Step 1 improves (accepted, +15%), step 2 regresses (rejected).
    const mutations = [
      "// value: 85\nexport let count = 1;\n",
      "// value: 150\nexport let count = 2;\n",
    ];
    let iteration = 0;
    const observed: Array<{ history: unknown[]; status: string; bestScore: number; bestStep: number | null; onDiskStatus: string }> = [];

    const generator: MutationGenerator = async () => {
      // The generator runs at the START of iteration i+1, so it observes the
      // store exactly as `status` in another terminal would.
      const store = liveSessionFor(testDir);
      const s = store.store.getState();
      observed.push({
        history: [...s.history],
        status: s.status,
        bestScore: s.bestScore,
        bestStep: s.bestStep,
        onDiskStatus: String(((readState(testDir).session as Record<string, unknown> | undefined)?.status) ?? ""),
      });
      const code = mutations[iteration++] ?? mutations[0]!;
      return [{ relPath: "src/index.ts", content: code }];
    };

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 2,
      generator,
      samples: 1,
    }));

    expect(res.acceptedCount).toBe(1);
    // Iteration 1 observer: no steps yet, mid-mutation status... already
    // stamped, lock acquired.
    expect(observed).toHaveLength(2);
    expect(observed[0].history).toHaveLength(0);
    expect(observed[0].onDiskStatus).toBe("mutating");

    // The accepted step of iteration 1 is visible from iteration 2.
    expect(observed[1].history).toHaveLength(1);
    expect(observed[1].bestScore).toBe(res.evaluations[0]!.fitnessScore);
    expect(observed[1].bestStep).toBe(1);

    const finalDoc = readState(testDir);
    const session = finalDoc.session as Record<string, unknown>;
    expect(session.status).toBe("completed");
    expect((session.history as unknown[]).length).toBe(2);
    expect((session.history as Array<Record<string, unknown>>)[1].rolledBack).toBe(true);
    expect(session.bestScore).toBe(res.evaluations[0]!.fitnessScore);
    expect(session.bestStep).toBe(1);
    expect(finalDoc.lastUpdatedAt).toBeGreaterThan(0);

    // The serialized lock of the run was released with the run.
    expect(session.lock).toBeNull();
  });

  it("mirrors the REAL lockfile in a failed run's blob when the release fails", async () => {
    // The release fails AFTER the mutation blew up: the lock directory stays
    // on disk and still belongs to this process. The blob must say the same
    // thing the lockfile says — a hardcoded null here would claim "unlocked"
    // while the lock is held, so a second `perfgym status` would be lied to.
    const failingRelease = vi
      .spyOn(GitSandboxCoordinator.prototype, "release")
      .mockRejectedValue(new Error("release broke"));
    const generator: MutationGenerator = async () => {
      throw new Error("mutation blew up");
    };

    try {
      await expect(
        Effect.runPromise(runOptimizationLoop({
          cwd: testDir,
          maxIterations: 1,
          generator,
          samples: 1,
        })),
      ).rejects.toThrow("mutation blew up");
    } finally {
      failingRelease.mockRestore();
    }

    const session = readState(testDir).session as Record<string, unknown>;
    const lock = session.lock as { pid: number; runId: string } | null;
    // The snapshot reflects the still-held lock: this process's pid and a runId.
    expect(lock).not.toBeNull();
    expect(lock!.pid).toBe(process.pid);
    expect(typeof lock!.runId).toBe("string");
  });

  it("a live-session flush failure in the error path never replaces the real run error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const generator: MutationGenerator = async () => {
      // The sabotage replaces the durable state file with a DIRECTORY: the
      // write-through flush's atomic rename then fails on every subsequent
      // persistence — including the one the error handler performs.
      const stateFilePath = path.join(testDir, ".perfgym", "state.json");
      fs.rmSync(stateFilePath);
      fs.mkdirSync(stateFilePath);
      throw new Error("mutation blew up");
    };

    try {
      await expect(
        Effect.runPromise(runOptimizationLoop({
          cwd: testDir,
          maxIterations: 1,
          generator,
          samples: 1,
        })),
      ).rejects.toThrow("mutation blew up");
      // The flush failure was surfaced as a warning, not swallowed silently.
      expect(
        consoleSpy.mock.calls.some((call) => String(call[0]).includes("Could not persist the live session")),
      ).toBe(true);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

describe("Autonomous Hill-Climbing Loop (perfgym run - Ticket #20)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `perfgym-run-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testDir, { recursive: true });

    // Initialize git repo in testDir so worktree and promotion work
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir, stdio: "ignore" });
    } catch {
      execFileSync("git", ["init"], { cwd: testDir, stdio: "ignore" });
    }
    execFileSync("git", ["config", "user.name", "Test Sentinel"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "sentinel@test.com"], { cwd: testDir, stdio: "ignore" });

    // Initial files
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export let count = 0;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: testDir, stdio: "ignore" });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("runs hill-climbing loop accepting improvements and rejecting regressions", async () => {
    const configYaml = `
version: "1.0"
target:
  name: "loop-test"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "instructions"
    command: "node -e 'const fs = require(\\"fs\\"); const txt = fs.readFileSync(\\"src/index.ts\\", \\"utf8\\"); const m = txt.match(/value: (\\\\d+)/); const v = m ? parseInt(m[1]) : 100; console.log(JSON.stringify({ value: v }));'"
    goal: "minimize"
    weight: 1
    unit: "count"
`;
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "// value: 100\nexport let count = 0;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add config"], { cwd: testDir, stdio: "ignore" });

    // Establish baseline
    saveSession(testDir, {
      version: "1.0",
      initializedAt: Date.now(),
      updatedAt: Date.now(),
      targetName: "loop-test",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });

    // Mock mutations:
    // Step 1: improve to 85 (accepted, +15%)
    // Step 2: regress to 95 (rejected)
    // Step 3: improve to 70 (accepted, +30%)
    const mutations = [
      "// value: 85\nexport let count = 1;\n",
      "// value: 95\nexport let count = 2;\n",
      "// value: 70\nexport let count = 3;\n",
    ];

    let currentStep = 0;
    const mockGenerator: MutationGenerator = async (context) => {
      const code = mutations[currentStep] || "// value: 70\nexport let count = 3;\n";
      currentStep++;
      return [
        {
          relPath: "src/index.ts",
          content: code,
        },
      ];
    };

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 3,
      generator: mockGenerator,
      samples: 2,
    }));

    expect(res.totalIterations).toBe(3);
    expect(res.acceptedCount).toBe(2);
    expect(res.bestFitnessScore).toBeCloseTo(30, 1);
    expect(res.promoted).toBe(true);

    // Verify file content in target branch/cwd has the winning mutation
    const finalContent = fs.readFileSync(path.join(testDir, "src", "index.ts"), "utf8");
    expect(finalContent).toContain("value: 70");
  });

  it("records the winning iteration as state.bestStep at promotion (F3)", async () => {
    const configYaml = `
version: "1.0"
target:
  name: "promotion-test"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "instructions"
    command: "node -e 'const fs = require(\\"fs\\"); const txt = fs.readFileSync(\\"src/index.ts\\", \\"utf8\\"); const m = txt.match(/value: (\\\\d+)/); const v = m ? parseInt(m[1]) : 100; console.log(JSON.stringify({ value: v }));'"
    goal: "minimize"
    weight: 1
    unit: "count"
`;
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "// value: 100\nexport let count = 0;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add config"], { cwd: testDir, stdio: "ignore" });

    saveSession(testDir, {
      version: "1.0",
      initializedAt: Date.now(),
      updatedAt: Date.now(),
      targetName: "session-loop",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });

    // Step 1 improves to 85 (accepted); step 2 regresses. The best is
    // achieved at iteration 1 — promotion must persist bestStep, not just
    // bestFitnessScore.
    let currentStep = 0;
    const mutations = [
      "// value: 85\nexport let count = 1;\n",
      "// value: 95\nexport let count = 2;\n",
    ];
    const generator: MutationGenerator = async () => {
      const code = mutations[currentStep] ?? mutations[mutations.length - 1];
      currentStep++;
      return [{ relPath: "src/index.ts", content: code }];
    };

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 2,
      generator,
      samples: 2,
    }));
    expect(res.acceptedCount).toBe(1);
    expect(res.promoted).toBe(true);

    const state = JSON.parse(
      fs.readFileSync(path.join(testDir, ".perfgym", "state.json"), "utf8"),
    ) as { bestStep?: number };
    expect(state.bestStep).toBe(1);
  });

  it("auto-terminates when plateauing over 3 consecutive steps", async () => {
    const configYaml = `
version: "1.0"
target:
  name: "plateau-test"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "instructions"
    command: "node -e 'console.log(JSON.stringify({ value: 100 }))'"
    goal: "minimize"
    weight: 1
    unit: "count"
`;
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export let x = 1;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add config"], { cwd: testDir, stdio: "ignore" });

    saveSession(testDir, {
      version: "1.0",
      initializedAt: Date.now(),
      updatedAt: Date.now(),
      targetName: "plateau-test",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });

    // Always produces identical metric -> 0% delta -> rejected due to significance (<2.5%)
    const mockGenerator: MutationGenerator = async () => {
      return [
        {
          relPath: "src/index.ts",
          content: "export let x = 2;\n",
        },
      ];
    };

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 10,
      generator: mockGenerator,
      samples: 1,
      plateauThreshold: 3,
    }));

    // Should stop at iteration 3 due to 3 consecutive non-improving steps
    expect(res.totalIterations).toBe(3);
    expect(res.stoppedReason).toMatch(/plateau/i);
  });
});

describe("Negative Memory in the Run Loop (Ticket #38)", () => {
  const NEGATIVE_MEMORY_FILE = path.join(".perfgym", "negative-memory.json");

  let testDir: string;

  const configYaml = `
version: "1.0"
target:
  name: "memory-test"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "instructions"
    command: "node -e 'const fs = require(\\"fs\\"); const txt = fs.readFileSync(\\"src/index.ts\\", \\"utf8\\"); const m = txt.match(/value: (\\\\d+)/); const v = m ? parseInt(m[1]) : 100; console.log(JSON.stringify({ value: v }));'"
    goal: "minimize"
    weight: 1
    unit: "count"
`;

  const readMemoryFile = (dir: string): {
    version: number;
    targets: Record<string, { target: string; entries: Array<Record<string, unknown>> }>;
  } => JSON.parse(fs.readFileSync(path.join(dir, NEGATIVE_MEMORY_FILE), "utf8"));

  beforeEach(() => {
    testDir = path.join(
      tmpdir(),
      `perfgym-run-memory-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir, stdio: "ignore" });
    } catch {
      execFileSync("git", ["init"], { cwd: testDir, stdio: "ignore" });
    }
    execFileSync("git", ["config", "user.name", "Test Sentinel"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "sentinel@test.com"], {
      cwd: testDir,
      stdio: "ignore",
    });

    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "// value: 100\nexport let count = 0;\n", "utf8");
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: testDir, stdio: "ignore" });

    saveSession(testDir, {
      version: "1.0",
      initializedAt: Date.now(),
      updatedAt: Date.now(),
      targetName: "memory-test",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("records a rejected step and persists the cache at run end", async () => {
    // A regression (100 -> 150) is rejected: the negative memory must learn it.
    const generator: MutationGenerator = async () => [
      { relPath: "src/index.ts", content: "// value: 150\nexport let count = 1;\n" },
    ];

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 1,
      generator,
      samples: 1,
    }));

    expect(res.acceptedCount).toBe(0);
    expect(res.evaluations).toHaveLength(1);
    expect(res.evaluations[0]!.accepted).toBe(false);

    const memoryFile = path.join(testDir, NEGATIVE_MEMORY_FILE);
    expect(fs.existsSync(memoryFile)).toBe(true);

    const doc = readMemoryFile(testDir);
    const entries = doc.targets["memory-test"]?.entries ?? [];
    expect(entries).toHaveLength(1);

    const entry = entries[0]!;
    expect(entry.strategy).toBe("src/index.ts");
    expect(entry.step).toBe(1);
    expect(entry.deltaPercent).toBe(res.evaluations[0]!.deltaPercent);
    expect(typeof entry.reason).toBe("string");
    expect((entry.reason as string).length).toBeGreaterThan(0);
    expect(typeof entry.id).toBe("string");
    expect((entry.id as string).length).toBeGreaterThan(0);
  });

  it("reloads the previous run's entries and merges them with the new one", async () => {
    const firstGenerator: MutationGenerator = async () => [
      { relPath: "src/index.ts", content: "// value: 150\nexport let count = 1;\n" },
    ];
    await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 1,
      generator: firstGenerator,
      samples: 1,
    }));

    const afterFirst = readMemoryFile(testDir);
    expect(afterFirst.targets["memory-test"]?.entries).toHaveLength(1);
    const firstId = afterFirst.targets["memory-test"]!.entries[0]!.id;

    // A different mutation content -> a different hash -> a second entry.
    const secondGenerator: MutationGenerator = async () => [
      { relPath: "src/index.ts", content: "// value: 170\nexport let count = 2;\n" },
    ];
    await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 1,
      generator: secondGenerator,
      samples: 1,
    }));

    const afterSecond = readMemoryFile(testDir);
    const entries = afterSecond.targets["memory-test"]?.entries ?? [];
    expect(entries).toHaveLength(2);

    const ids = entries.map((entry) => entry.id);
    expect(ids).toContain(firstId);
    expect(new Set(ids).size).toBe(2);
    expect(entries.map((entry) => entry.step).sort()).toEqual([1, 1]);
  });

  it("writes no cache file when the run learned nothing", async () => {
    const generator: MutationGenerator = async () => [
      { relPath: "src/index.ts", content: "// value: 70\nexport let count = 3;\n" },
    ];

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 1,
      generator,
      samples: 1,
    }));

    expect(res.acceptedCount).toBe(1);
    expect(fs.existsSync(path.join(testDir, NEGATIVE_MEMORY_FILE))).toBe(false);
  });

  it("leaves a pre-existing cache untouched when the run records nothing", async () => {
    // The cache already holds entries for this target (so the old "entries
    // exist ⇒ save" rule would rewrite it) plus another target's entries
    // (which must survive untouched).
    const memoryFile = path.join(testDir, NEGATIVE_MEMORY_FILE);
    fs.mkdirSync(path.dirname(memoryFile), { recursive: true });
    fs.writeFileSync(
      memoryFile,
      `${JSON.stringify(
        {
          version: 1,
          targets: {
            "memory-test": {
              target: "memory-test",
              entries: [
                {
                  id: "seeded-entry",
                  strategy: "src/previous.ts",
                  deltaPercent: -12.5,
                  reason: "Regressed tail latency.",
                  step: 7,
                  timestamp: 1_700_000_000_000,
                },
              ],
            },
            "other-target": {
              target: "other-target",
              entries: [
                {
                  id: "other-entry",
                  strategy: "src/other.ts",
                  deltaPercent: -3,
                  reason: "Failed elsewhere.",
                  step: 1,
                  timestamp: 1_700_000_001_000,
                },
              ],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // Pin the mtime to a known instant in 2001. Any rewrite replaces it with
    // "now", so the assertion can never flake on timestamp resolution.
    const pinnedSeconds = 1_000_000_000;
    fs.utimesSync(memoryFile, pinnedSeconds, pinnedSeconds);
    const bytesBefore = fs.readFileSync(memoryFile);
    const mtimeBefore = fs.statSync(memoryFile).mtimeMs;

    const generator: MutationGenerator = async () => [
      { relPath: "src/index.ts", content: "// value: 70\nexport let count = 3;\n" },
    ];

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 1,
      generator,
      samples: 1,
    }));

    // Every step was accepted: nothing new was learned, so the file is not
    // rewritten at all.
    expect(res.acceptedCount).toBe(1);
    expect(fs.readFileSync(memoryFile).equals(bytesBefore)).toBe(true);
    expect(fs.statSync(memoryFile).mtimeMs).toBe(mtimeBefore);
    expect(mtimeBefore).toBe(pinnedSeconds * 1000);
  });

  it("feeds the failure of step i into the feedback the generator gets at step i+1", async () => {
    const contexts: MutationContext[] = [];
    const contents = [
      "// value: 150\nexport let count = 1;\n",
      "// value: 170\nexport let count = 2;\n",
    ];
    let index = 0;

    const generator: MutationGenerator = async (context) => {
      contexts.push(context);
      const content = contents[index++] ?? contents[0]!;
      return [{ relPath: "src/index.ts", content }];
    };

    await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 2,
      generator,
      samples: 1,
    }));

    // The memory channel is present on EVERY iteration — the first one
    // included, even when nothing has been remembered yet.
    expect(Array.isArray(contexts[0]!.negativeMemory)).toBe(true);
    expect(contexts[0]!.negativeMemory).toHaveLength(0);

    // The second iteration must already know about the failure of the first.
    const secondFeedback = contexts[1]!.lastFeedback;
    expect(secondFeedback).toBeDefined();
    expect(secondFeedback).toContain("Previously failed strategies:");
    expect(secondFeedback).toContain("src/index.ts");
    expect(secondFeedback).toContain("-50.0%");
  });

  it("gives the first mutation of a run the memory persisted by the previous run", async () => {
    // Seed the memory of a previous run for this target.
    fs.mkdirSync(path.join(testDir, ".perfgym"), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, NEGATIVE_MEMORY_FILE),
      JSON.stringify(
        {
          version: 1,
          targets: {
            "memory-test": {
              target: "memory-test",
              entries: [
                {
                  id: "seeded-entry",
                  strategy: "src/previous.ts",
                  deltaPercent: -12.5,
                  reason: "Regressed tail latency.",
                  step: 7,
                  timestamp: 1_700_000_000_000,
                },
              ],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const contexts: MutationContext[] = [];
    const generator: MutationGenerator = async (context) => {
      contexts.push(context);
      return [{ relPath: "src/index.ts", content: "// value: 150\nexport let count = 1;\n" }];
    };

    await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 1,
      generator,
      samples: 1,
    }));

    // The very first mutation already knows about the persisted failure.
    const remembered = contexts[0]!.negativeMemory;
    expect(remembered).toHaveLength(1);
    expect(remembered[0]!.id).toBe("seeded-entry");
    expect(remembered[0]!.strategy).toBe("src/previous.ts");
  });

  it("never remembers an accepted-but-not-better mutation as a failure", async () => {
    // 1: accepted (100 -> 70, best +30). 2: accepted by the pipeline (100 -> 90,
    // +10) but it does not beat the champion, so the loop rolls it back.
    // 3: a genuine regression (100 -> 150) that the pipeline rejects.
    const contents = [
      "// value: 70\nexport let count = 1;\n",
      "// value: 90\nexport let count = 2;\n",
      "// value: 150\nexport let count = 3;\n",
    ];
    let index = 0;

    const generator: MutationGenerator = async () => [
      { relPath: "src/index.ts", content: contents[index++] ?? contents[0]! },
    ];

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 3,
      generator,
      samples: 1,
    }));

    expect(res.evaluations[1]!.accepted).toBe(true);
    expect(res.evaluations[2]!.accepted).toBe(false);

    const doc = readMemoryFile(testDir);
    const entries = doc.targets["memory-test"]?.entries ?? [];

    // Only the genuine failure is remembered.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.step).toBe(3);
    expect(entries[0]!.deltaPercent).toBe(res.evaluations[2]!.deltaPercent);

    // The accepted-but-not-better step must not appear at all.
    expect(entries.some((entry) => entry.step === 2)).toBe(false);
    expect(entries.some((entry) => entry.deltaPercent === 10)).toBe(false);
  });
});

// ============================================================================
// Sandbox lifecycle at the edge (Ticket #51 — AC3)
// ============================================================================

describe("Sandbox lifecycle under the edge runner (Ticket #51)", () => {
  const configYaml = `
version: "1.0"
target:
  name: "lifecycle-target"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "instructions"
    command: "node -e 'const fs = require(\\"fs\\"); const txt = fs.readFileSync(\\"src/index.ts\\", \\"utf8\\"); const m = txt.match(/value: (\\\\d+)/); const v = m ? parseInt(m[1]) : 100; console.log(JSON.stringify({ value: v }));'"
    goal: "minimize"
    weight: 1
    unit: "count"
`;

  let testDir: string;
  const lockDir = (): string => path.join(testDir, ".perfgym", ".lock.d");

  beforeEach(() => {
    testDir = path.join(
      tmpdir(),
      `perfgym-run-lifecycle-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir, stdio: "ignore" });
    } catch {
      execFileSync("git", ["init"], { cwd: testDir, stdio: "ignore" });
    }
    execFileSync("git", ["config", "user.name", "Test Sentinel"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "sentinel@test.com"], { cwd: testDir, stdio: "ignore" });

    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "// value: 100\nexport let count = 0;\n", "utf8");
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: testDir, stdio: "ignore" });

    saveSession(testDir, {
      version: "1.0",
      initializedAt: Date.now(),
      updatedAt: Date.now(),
      targetName: "lifecycle-target",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("removes the worktree and releases the lock when the program fails", async () => {
    let sandboxDir = "";
    const rendered: { error: unknown; exitCode: number | null } = {
      error: null,
      exitCode: null,
    };
    const generator: MutationGenerator = async (context) => {
      // The sandbox exists at this point: remember it so the assertions can
      // prove it is gone after the failure.
      sandboxDir = context.workingDir;
      throw new Error("mutation blew up");
    };

    const outcome = await runEffect(
      runOptimizationLoop({ cwd: testDir, maxIterations: 1, generator, samples: 1 }),
      {
        onError: (error, exitCode) => {
          rendered.error = error;
          rendered.exitCode = exitCode;
        },
      },
    );

    expect(outcome.status).toBe("failure");
    if (outcome.status !== "failure") return;

    // The failure reaches the edge with the generic-domain-error exit code (1)
    // and is handed to `onError` for rendering.
    expect(outcome.exitCode).toBe(1);
    expect(rendered.exitCode).toBe(1);
    expect((rendered.error as Error).message).toContain("mutation blew up");

    // AC3: teardown ran despite the failure — no orphaned worktree, no lock.
    expect(sandboxDir).not.toBe("");
    expect(fs.existsSync(sandboxDir)).toBe(false);
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it("leaves no worktree and no lock behind a successful run either", async () => {
    let sandboxDir = "";
    const generator: MutationGenerator = async (context) => {
      sandboxDir = context.workingDir;
      return [{ relPath: "src/index.ts", content: "// value: 70\nexport let count = 1;\n" }];
    };

    const outcome = await runEffect(
      runOptimizationLoop({ cwd: testDir, maxIterations: 1, generator, samples: 1 }),
    );

    expect(outcome.status).toBe("success");
    if (outcome.status !== "success") return;
    expect(outcome.value.promoted).toBe(true);
    expect(fs.existsSync(sandboxDir)).toBe(false);
    expect(fs.existsSync(lockDir())).toBe(false);
  });
});
