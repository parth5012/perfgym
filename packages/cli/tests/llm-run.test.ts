import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runOptimizationLoop } from "../src/commands/run.js";
import { saveSession } from "../src/engine.js";
import type { LlmDriver, LlmResult } from "../../core/src/index.js";
import { MissingApiKeyError } from "../../core/src/index.js";

describe("Autonomous LLM Driver Wiring (Ticket #42)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `perfgym-llm-run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testDir, { recursive: true });

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir, stdio: "ignore" });
    } catch {
      execFileSync("git", ["init"], { cwd: testDir, stdio: "ignore" });
    }
    execFileSync("git", ["config", "user.name", "Sentinel"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "sentinel@test.com"], { cwd: testDir, stdio: "ignore" });

    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "// value: 100\nexport let v = 100;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: testDir, stdio: "ignore" });

    const configYaml = `
version: "1.0"
target:
  name: "llm-test"
  language: "typescript"
  files: ["src/index.ts"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "latency"
    command: "node -e 'const fs = require(\\\"fs\\\"); const txt = fs.readFileSync(\\\"src/index.ts\\\", \\\"utf8\\\"); const m = txt.match(/value: (\\\\d+)/); console.log(JSON.stringify({ value: m ? parseInt(m[1]) : 100 }));'"
    goal: "minimize"
    weight: 1
    unit: "ms"
`;
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "config"], { cwd: testDir, stdio: "ignore" });

    saveSession(testDir, {
      version: "1.0",
      initializedAt: Date.now(),
      updatedAt: Date.now(),
      targetName: "llm-test",
      baselineMetrics: { latency: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("drives run end-to-end with stub driver and explicit stop reason", async () => {
    let callIndex = 0;
    const stubDriver: LlmDriver = {
      name: "stub",
      complete: vi.fn().mockImplementation(async (): Promise<LlmResult> => {
        callIndex++;
        const val = callIndex === 1 ? 80 : 70;
        return {
          mutations: [
            {
              path: "src/index.ts",
              content: `// value: ${val}\nexport let v = ${val};\n`,
              rationale: "fast path",
            },
          ],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
          estimatedCostUsd: 0.005,
        };
      }),
    };

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 2,
      llmDriver: stubDriver,
      samples: 1,
    }));

    expect(res.totalIterations).toBe(2);
    expect(res.acceptedCount).toBe(2);
    expect(res.stoppedReason).toBe("max-iterations");
    expect(res.promoted).toBe(true);
    expect(res.totalTokens).toBe(300);
    expect(res.totalCostUsd).toBeCloseTo(0.01, 4);

    const final = fs.readFileSync(path.join(testDir, "src", "index.ts"), "utf8");
    expect(final).toContain("value: 70");
  });

  it("stops with budget-exhausted when token cap is reached", async () => {
    const stubDriver: LlmDriver = {
      name: "stub",
      complete: vi.fn().mockResolvedValue({
        mutations: [
          {
            path: "src/index.ts",
            content: "// value: 80\nexport let v = 80;\n",
            rationale: "step",
          },
        ],
        usage: { promptTokens: 600, completionTokens: 400, totalTokens: 1000 },
      }),
    };

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 5,
      llmDriver: stubDriver,
      maxTokens: 1500, // Iteration 2 will cross 2000 >= 1500
      samples: 1,
    }));

    expect(res.stoppedReason).toBe("budget-exhausted");
    expect(res.totalIterations).toBe(2);
  });

  it("stops with budget-exhausted when cost cap is reached", async () => {
    const stubDriver: LlmDriver = {
      name: "stub",
      complete: vi.fn().mockResolvedValue({
        mutations: [
          {
            path: "src/index.ts",
            content: "// value: 80\nexport let v = 80;\n",
            rationale: "step",
          },
        ],
        usage: { promptTokens: 100, completionTokens: 100, totalTokens: 200 },
        estimatedCostUsd: 0.05,
      }),
    };

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 5,
      llmDriver: stubDriver,
      maxCostUsd: 0.08, // Iteration 2 will cross 0.10 >= 0.08
      samples: 1,
    }));

    expect(res.stoppedReason).toBe("budget-exhausted");
    expect(res.totalIterations).toBe(2);
  });

  it("stops with llm-gave-up when model returns 2 consecutive empty mutation arrays", async () => {
    const stubDriver: LlmDriver = {
      name: "stub",
      complete: vi.fn().mockResolvedValue({
        mutations: [],
        usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
      }),
    };

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 5,
      llmDriver: stubDriver,
      samples: 1,
    }));

    expect(res.stoppedReason).toBe("llm-gave-up");
  });

  it("aborts loop with error after 3 consecutive LLM errors/skips", async () => {
    const stubDriver: LlmDriver = {
      name: "stub",
      complete: vi.fn().mockResolvedValue({
        mutations: [],
        skipped: true,
        error: "transient network failure",
      }),
    };

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 5,
      llmDriver: stubDriver,
      samples: 1,
    }));

    expect(res.stoppedReason).toBe("error");
  });

  it("fails before first iteration if API key is missing", async () => {
    const originalEnv = { ...process.env };
    delete process.env.OPENAI_API_KEY;
    delete process.env.PERFGYM_API_KEY;

    try {
      await expect(
        Effect.runPromise(runOptimizationLoop({
          cwd: testDir,
          driver: "api",
          provider: "openai",
        }))
      ).rejects.toThrowError(MissingApiKeyError);
    } finally {
      process.env = originalEnv;
    }
  });

  it("respects config defaults and overrides via options", async () => {
    const customYaml = `
version: "1.0"
target:
  name: "llm-test"
  language: "typescript"
  files: ["src/index.ts"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "latency"
    command: "node -e 'console.log(JSON.stringify({ value: 10 }))'"
    goal: "minimize"
    weight: 1
llm:
  driver: "cli"
  cli_command: "${process.execPath}"
  cli_args:
    - "-e"
    - "console.log(JSON.stringify({ mutations: [] }))"
`;
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), customYaml, "utf8");

    const res = await Effect.runPromise(runOptimizationLoop({
      cwd: testDir,
      maxIterations: 3,
      samples: 1,
    }));

    // cli driver ran the custom command and gave up (mutations: [])
    expect(res.stoppedReason).toBe("llm-gave-up");
  });
});
