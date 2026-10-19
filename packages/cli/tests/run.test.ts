import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runOptimizationLoop, type MutationGenerator } from "../src/commands/run.js";
import { writeState } from "../src/engine.js";

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
    command: "node -e 'const fs = require(\\\"fs\\\"); const txt = fs.readFileSync(\\\"src/index.ts\\\", \\\"utf8\\\"); const m = txt.match(/value: (\\\\d+)/); const v = m ? parseInt(m[1]) : 100; console.log(JSON.stringify({ value: v }));'"
    goal: "minimize"
    weight: 1
    unit: "count"
`;
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "// value: 100\nexport let count = 0;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "add config"], { cwd: testDir, stdio: "ignore" });

    // Establish baseline
    writeState(testDir, {
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

    const res = await runOptimizationLoop({
      cwd: testDir,
      maxIterations: 3,
      generator: mockGenerator,
      samples: 2,
    });

    expect(res.totalIterations).toBe(3);
    expect(res.acceptedCount).toBe(2);
    expect(res.bestFitnessScore).toBeCloseTo(30, 1);
    expect(res.promoted).toBe(true);

    // Verify file content in target branch/cwd has the winning mutation
    const finalContent = fs.readFileSync(path.join(testDir, "src", "index.ts"), "utf8");
    expect(finalContent).toContain("value: 70");
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

    writeState(testDir, {
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

    const res = await runOptimizationLoop({
      cwd: testDir,
      maxIterations: 10,
      generator: mockGenerator,
      samples: 1,
      plateauThreshold: 3,
    });

    // Should stop at iteration 3 due to 3 consecutive non-improving steps
    expect(res.totalIterations).toBe(3);
    expect(res.stoppedReason).toContain("Plateau reached");
  });
});
