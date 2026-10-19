import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

describe("CLI E2E / Bin Execution", () => {
  let testDir: string;
  const cliEntrypoint = path.resolve(__dirname, "../../packages/cli/src/index.ts");

  beforeEach(() => {
    testDir = path.join(tmpdir(), `perfgym-cli-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  function runCli(args: string[], cwd: string = testDir): { stdout: string; stderr: string; status: number } {
    try {
      const tsxBin = path.resolve(__dirname, "../../node_modules/.bin/tsx");
      const stdout = execFileSync(tsxBin, [cliEntrypoint, ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { stdout, stderr: "", status: 0 };
    } catch (err: any) {
      return {
        stdout: err.stdout ? err.stdout.toString() : "",
        stderr: err.stderr ? err.stderr.toString() : "",
        status: err.status ?? 1,
      };
    }
  }

  it("prints help and version cleanly", () => {
    const res = runCli(["--help"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("perfgym");
    expect(res.stdout).toContain("init");
    expect(res.stdout).toContain("baseline");
    expect(res.stdout).toContain("step");
  });

  it("executes init -> baseline -> step flow end to end", () => {
    // 1. init
    const initRes = runCli(["init"]);
    expect(initRes.status).toBe(0);
    expect(fs.existsSync(path.join(testDir, ".perfgym.yaml"))).toBe(true);

    // Prepare dummy test and benchmark commands in config
    const configYaml = `
version: "1.0"
target:
  name: "e2e-target"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "latency"
    command: "node -e 'console.log(JSON.stringify({ value: 100 }))'"
    goal: "minimize"
    weight: 1
    unit: "ms"
`;
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "code.ts"), "export const a = 1;\n", "utf8");

    // 2. baseline
    const baseRes = runCli(["baseline", "--samples", "2"]);
    expect(baseRes.status).toBe(0);
    expect(baseRes.stdout).toContain("Baseline established");
    expect(fs.existsSync(path.join(testDir, ".perfgym", "state.json"))).toBe(true);

    // 3. step with improvement
    const betterConfigYaml = configYaml.replace("value: 100", "value: 70");
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), betterConfigYaml, "utf8");

    const stepRes = runCli(["step", "--samples", "2", "-f", "src/code.ts"]);
    expect(stepRes.status).toBe(0);
    expect(stepRes.stdout).toContain("Change accepted");
  });

  it("returns exit code 1 when step fails invariants or linters", () => {
    const configYaml = `
version: "1.0"
target:
  name: "e2e-fail"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(1)'"
metrics:
  - name: "latency"
    command: "node -e 'console.log(JSON.stringify({ value: 100 }))'"
    goal: "minimize"
    weight: 1
`;
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "code.ts"), "export const a = 1;\n", "utf8");

    // Initialize mock state
    fs.mkdirSync(path.join(testDir, ".perfgym"), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, ".perfgym", "state.json"),
      JSON.stringify({
        version: "1.0",
        targetName: "e2e-fail",
        baselineMetrics: { latency: 100 },
        invariantsPassed: true,
        bestFitnessScore: 0,
        acceptedStepCount: 0,
        totalStepCount: 0,
      }),
      "utf8"
    );

    const stepRes = runCli(["step", "-f", "src/code.ts"]);
    expect(stepRes.status).toBe(1);
    expect(stepRes.stdout).toContain("Change rejected");
  });
});
