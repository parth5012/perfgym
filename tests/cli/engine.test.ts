import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { NegativeMemoryCache } from "../../packages/core/src/index.js";
import {
  detectProjectLanguage,
  generateStarterConfig,
  loadConfig,
  loadSession,
  saveSession,
  runInit,
  runBaseline,
  runStep,
  recordNegativeMemory,
  NEGATIVE_MEMORY_PATH,
  type PerfGymState,
} from "../../packages/cli/src/engine.js";

describe("CLI Engine Unit & TDD Suite", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `perfgym-cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("detectProjectLanguage", () => {
    it("detects typescript when tsconfig.json exists", () => {
      fs.writeFileSync(path.join(testDir, "tsconfig.json"), "{}", "utf8");
      expect(detectProjectLanguage(testDir)).toBe("typescript");
    });

    it("detects python when pyproject.toml exists", () => {
      fs.writeFileSync(path.join(testDir, "pyproject.toml"), "", "utf8");
      expect(detectProjectLanguage(testDir)).toBe("python");
    });

    it("detects rust when Cargo.toml exists", () => {
      fs.writeFileSync(path.join(testDir, "Cargo.toml"), "", "utf8");
      expect(detectProjectLanguage(testDir)).toBe("rust");
    });

    it("detects go when go.mod exists", () => {
      fs.writeFileSync(path.join(testDir, "go.mod"), "", "utf8");
      expect(detectProjectLanguage(testDir)).toBe("go");
    });

    it("falls back to typescript by default when package.json exists", () => {
      fs.writeFileSync(path.join(testDir, "package.json"), "{}", "utf8");
      expect(detectProjectLanguage(testDir)).toBe("typescript");
    });
  });

  describe("runInit", () => {
    it("generates a valid .perfgym.yaml file", () => {
      fs.writeFileSync(path.join(testDir, "tsconfig.json"), "{}", "utf8");
      const res = runInit({ cwd: testDir });
      expect(res.success).toBe(true);
      expect(fs.existsSync(path.join(testDir, ".perfgym.yaml"))).toBe(true);

      const config = loadConfig(testDir);
      expect(config.target.language).toBe("typescript");
      expect(config.invariants.command).toBeDefined();
      expect(config.metrics.length).toBeGreaterThan(0);
    });

    it("refuses to overwrite existing .perfgym.yaml unless force is passed", () => {
      fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), "version: '1.0'\n", "utf8");
      const res1 = runInit({ cwd: testDir, force: false });
      expect(res1.success).toBe(false);
      expect(res1.message).toContain("already exists");

      const res2 = runInit({ cwd: testDir, force: true });
      expect(res2.success).toBe(true);
    });
  });

  describe("State Management", () => {
    it("writes and reads .perfgym/state.json through the session accessors", () => {
      const state: PerfGymState = {
        version: "0.1.0",
        initializedAt: Date.now(),
        updatedAt: Date.now(),
        targetName: "my-target",
        baselineMetrics: { instructions: 1250 },
        invariantsPassed: true,
        bestFitnessScore: 0,
        acceptedStepCount: 0,
        totalStepCount: 0,
      };

      saveSession(testDir, state);
      const readBack = loadSession(testDir);
      // The store stamps `lastUpdatedAt` additively (#46); every declared
      // field round-trips exactly.
      expect(readBack).toEqual({ ...state, lastUpdatedAt: expect.any(Number) });
    });

    it("returns null when state.json does not exist", () => {
      expect(loadSession(testDir)).toBeNull();
    });
  });

  describe("loadConfig — agent budget normalisation (Ticket #38)", () => {
    const base = `
version: "1.0"
target:
  name: "budget-target"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "instructions"
    command: "node -e 'process.exit(0)'"
    goal: "minimize"
    weight: 1
`;

    it("maps the documented snake_case agent_budget onto the camelCase config", () => {
      fs.writeFileSync(
        path.join(testDir, ".perfgym.yaml"),
        `${base}\nagent_budget:\n  negative_memory_size: 9\n`,
        "utf8",
      );

      expect(loadConfig(testDir).agentBudget?.negativeMemorySize).toBe(9);
    });

    it("accepts the camelCase spelling as well", () => {
      fs.writeFileSync(
        path.join(testDir, ".perfgym.yaml"),
        `${base}\nagentBudget:\n  negativeMemorySize: 3\n`,
        "utf8",
      );

      expect(loadConfig(testDir).agentBudget?.negativeMemorySize).toBe(3);
    });

    it("defaults to 5 when no agent budget is configured", () => {
      fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), base, "utf8");

      expect(loadConfig(testDir).agentBudget?.negativeMemorySize).toBe(5);
    });

    it("falls back to 5 for invalid negative memory sizes", () => {
      for (const raw of ["0", "-2", '"abc"', "null"]) {
        fs.writeFileSync(
          path.join(testDir, ".perfgym.yaml"),
          `${base}\nagent_budget:\n  negative_memory_size: ${raw}\n`,
          "utf8",
        );

        expect(loadConfig(testDir).agentBudget?.negativeMemorySize).toBe(5);
      }
    });

    it("floors a fractional size to a whole number of entries", () => {
      fs.writeFileSync(
        path.join(testDir, ".perfgym.yaml"),
        `${base}\nagent_budget:\n  negative_memory_size: 2.7\n`,
        "utf8",
      );

      expect(loadConfig(testDir).agentBudget?.negativeMemorySize).toBe(2);
    });

    it("falls back to 5 when the size floors to zero", () => {
      fs.writeFileSync(
        path.join(testDir, ".perfgym.yaml"),
        `${base}\nagent_budget:\n  negative_memory_size: 0.5\n`,
        "utf8",
      );

      expect(loadConfig(testDir).agentBudget?.negativeMemorySize).toBe(5);
    });

    it("keeps the documented agent_budget keys verbatim next to the normalised view", () => {
      fs.writeFileSync(
        path.join(testDir, ".perfgym.yaml"),
        `${base}\nagent_budget:\n  max_iterations: 15\n  rollback_on_failure: true\n  negative_memory_size: 4\n`,
        "utf8",
      );

      // The raw block is not part of the typed config — it is the user's YAML
      // as written, so it is read through a narrow cast.
      const config = loadConfig(testDir) as ReturnType<typeof loadConfig> & {
        readonly agent_budget?: {
          readonly max_iterations?: number;
          readonly rollback_on_failure?: boolean;
        };
      };

      expect(config.agent_budget?.max_iterations).toBe(15);
      expect(config.agent_budget?.rollback_on_failure).toBe(true);
      expect(config.agentBudget?.negativeMemorySize).toBe(4);
    });

    it("keeps the other fields of a camelCase agentBudget block", () => {
      fs.writeFileSync(
        path.join(testDir, ".perfgym.yaml"),
        `${base}\nagentBudget:\n  maxIterations: 7\n  negativeMemorySize: 6\n`,
        "utf8",
      );

      const config = loadConfig(testDir) as ReturnType<typeof loadConfig> & {
        readonly agentBudget?: { readonly maxIterations?: number };
      };

      expect(config.agentBudget?.maxIterations).toBe(7);
      expect(config.agentBudget?.negativeMemorySize).toBe(6);
    });

    it("keeps the other fields of a snake_case agent_budget block", () => {
      fs.writeFileSync(
        path.join(testDir, ".perfgym.yaml"),
        `${base}\nagent_budget:\n  max_iterations: 11\n  negative_memory_size: 8\n`,
        "utf8",
      );

      const config = loadConfig(testDir) as ReturnType<typeof loadConfig> & {
        readonly agentBudget?: { readonly max_iterations?: number };
      };

      expect(config.agentBudget?.max_iterations).toBe(11);
      expect(config.agentBudget?.negativeMemorySize).toBe(8);
    });
  });

  describe("Negative memory recording (Ticket #38)", () => {
    it("pins the documented negative memory file location", () => {
      expect(NEGATIVE_MEMORY_PATH).toBe(path.join(".perfgym", "negative-memory.json"));
    });

    it("falls back to \"rejected\" for a blank revert reason", () => {
      const cache = new NegativeMemoryCache({ target: "blank-reason" });

      recordNegativeMemory(cache, {
        files: [{ relPath: "src/index.ts", content: "export const a = 1;\n" }],
        deltaPercent: -4.2,
        reason: "   ",
        step: 3,
      });

      const entries = cache.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.reason).toBe("rejected");
      expect(entries[0]!.deltaPercent).toBe(-4.2);
      expect(entries[0]!.step).toBe(3);
    });

    it("falls back to \"rejected\" when no reason is given at all", () => {
      const cache = new NegativeMemoryCache({ target: "no-reason" });

      recordNegativeMemory(cache, {
        files: [{ relPath: "src/index.ts", content: "export const a = 1;\n" }],
        deltaPercent: -1,
        step: 1,
      });

      expect(cache.entries()[0]!.reason).toBe("rejected");
    });

    it("keeps a real revert reason", () => {
      const cache = new NegativeMemoryCache({ target: "real-reason" });

      recordNegativeMemory(cache, {
        files: [{ relPath: "src/index.ts", content: "export const a = 1;\n" }],
        deltaPercent: -1,
        reason: "Invariants failed: 1 test failed",
        step: 1,
      });

      expect(cache.entries()[0]!.reason).toBe("Invariants failed: 1 test failed");
    });
  });

  describe("runBaseline", () => {
    it("runs invariant gate and benchmark to establish state.json", async () => {
      const configYaml = `
version: "1.0"
target:
  name: "test-target"
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
      fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export const x = 1;", "utf8");

      const res = await Effect.runPromise(runBaseline({ cwd: testDir, samples: 2 }));
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.state.baselineMetrics["instructions"]).toBe(100);
        expect(res.state.invariantsPassed).toBe(true);
      }

      const savedState = loadSession(testDir);
      expect(savedState).not.toBeNull();
      expect(savedState?.baselineMetrics["instructions"]).toBe(100);
    });

    it("fails when invariant command fails", async () => {
      const configYaml = `
version: "1.0"
target:
  name: "test-target"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(1)'"
metrics:
  - name: "instructions"
    command: "node -e 'console.log(JSON.stringify({ value: 100 }))'"
    goal: "minimize"
    weight: 1
`;
      fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");

      const res = await Effect.runPromise(runBaseline({ cwd: testDir, samples: 1 }));
      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.error).toContain("Invariants gate failed");
      }
    });
  });

  describe("runStep", () => {
    it("evaluates a clean improvement step against baseline", async () => {
      const configYaml = `
version: "1.0"
target:
  name: "test-target"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "instructions"
    command: "node -e 'console.log(JSON.stringify({ value: 80 }))'"
    goal: "minimize"
    weight: 1
    unit: "count"
`;
      fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
      fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export const x = 2;", "utf8");

      // Establish baseline first (baseline = 100)
      const state: PerfGymState = {
        version: "0.1.0",
        initializedAt: Date.now(),
        updatedAt: Date.now(),
        targetName: "test-target",
        baselineMetrics: { instructions: 100 },
        invariantsPassed: true,
        bestFitnessScore: 0,
        acceptedStepCount: 0,
        totalStepCount: 0,
      };
      saveSession(testDir, state);

      const res = await runStep({ cwd: testDir, files: ["src/index.ts"], samples: 2 });
      expect(res.evaluation.accepted).toBe(true);
      expect(res.evaluation.fitnessScore).toBeGreaterThan(0);
      expect(res.evaluation.deltaPercent).toBeCloseTo(20, 1);
    });

    it("warns and writes no cache when every modified path cannot be read as a file", async () => {
      const configYaml = `
version: "1.0"
target:
  name: "test-target"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "instructions"
    command: "node -e 'console.log(JSON.stringify({ value: 80 }))'"
    goal: "minimize"
    weight: 1
`;
      fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");

      // A directory passes the step's "exists + matches target glob" filter,
      // but it cannot be read as a file — exactly the vanished/unreadable-path
      // case where every modified path yields `null`.
      fs.mkdirSync(path.join(testDir, "src", "unreadable"), { recursive: true });

      saveSession(testDir, {
        version: "0.1.0",
        initializedAt: Date.now(),
        updatedAt: Date.now(),
        targetName: "test-target",
        baselineMetrics: { instructions: 100 },
        invariantsPassed: true,
        bestFitnessScore: 0,
        acceptedStepCount: 0,
        totalStepCount: 0,
      });

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        const res = await runStep({
          cwd: testDir,
          files: ["src/unreadable"],
          samples: 1,
          recordNegativeMemory: true,
        });

        expect(res.evaluation.accepted).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);

        const message = String(warn.mock.calls[0]?.[0]);
        expect(message).toContain("1 modified file");
        expect(message).toContain("nothing was recorded");

        expect(
          fs.existsSync(path.join(testDir, ".perfgym", "negative-memory.json")),
        ).toBe(false);
      } finally {
        warn.mockRestore();
      }
    });

    it("rejects when AST violations (e.g. @ts-ignore) are present", async () => {
      const configYaml = `
version: "1.0"
target:
  name: "test-target"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "instructions"
    command: "node -e 'console.log(JSON.stringify({ value: 50 }))'"
    goal: "minimize"
    weight: 1
`;
      fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
      fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(testDir, "src", "index.ts"),
        "// @ts-ignore\nexport const x: any = 1;",
        "utf8"
      );

      const state: PerfGymState = {
        version: "0.1.0",
        initializedAt: Date.now(),
        updatedAt: Date.now(),
        targetName: "test-target",
        baselineMetrics: { instructions: 100 },
        invariantsPassed: true,
        bestFitnessScore: 0,
        acceptedStepCount: 0,
        totalStepCount: 0,
      };
      saveSession(testDir, state);

      const res = await runStep({ cwd: testDir, files: ["src/index.ts"], samples: 1 });
      expect(res.evaluation.accepted).toBe(false);
      expect(res.evaluation.fitnessScore).toBe(-Infinity);
      expect(res.evaluation.revertReason).toBeDefined();
    });
  });
});
