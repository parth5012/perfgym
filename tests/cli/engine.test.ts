import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import {
  detectProjectLanguage,
  generateStarterConfig,
  loadConfig,
  readState,
  writeState,
  runInit,
  runBaseline,
  runStep,
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
    it("writes and reads .perfgym/state.json correctly", () => {
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

      writeState(testDir, state);
      const readBack = readState(testDir);
      expect(readBack).toEqual(state);
    });

    it("returns null when state.json does not exist", () => {
      expect(readState(testDir)).toBeNull();
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

      const res = await runBaseline({ cwd: testDir, samples: 2 });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.state.baselineMetrics["instructions"]).toBe(100);
        expect(res.state.invariantsPassed).toBe(true);
      }

      const savedState = readState(testDir);
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

      const res = await runBaseline({ cwd: testDir, samples: 1 });
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
      writeState(testDir, state);

      const res = await runStep({ cwd: testDir, files: ["src/index.ts"], samples: 2 });
      expect(res.evaluation.accepted).toBe(true);
      expect(res.evaluation.fitnessScore).toBeGreaterThan(0);
      expect(res.evaluation.deltaPercent).toBeCloseTo(20, 1);
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
      writeState(testDir, state);

      const res = await runStep({ cwd: testDir, files: ["src/index.ts"], samples: 1 });
      expect(res.evaluation.accepted).toBe(false);
      expect(res.evaluation.fitnessScore).toBe(-Infinity);
      expect(res.evaluation.revertReason).toBeDefined();
    });
  });
});
