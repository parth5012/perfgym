import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/;

describe("CLI E2E / Bin Execution", () => {
  let testDir: string;
  const cliEntrypoint = path.resolve(__dirname, "../../packages/cli/src/index.ts");

  const BENCH_CONFIG = `
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

  const FAILING_CONFIG = `
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

  it("lists --format and --color on every command", () => {
    for (const command of ["init", "baseline", "step", "run"]) {
      const res = runCli([command, "--help"]);
      expect(res.status, `${command} --help should exit 0`).toBe(0);
      expect(res.stdout).toContain("--format");
      expect(res.stdout).toContain("--color");
    }
  });

  it("emits parseable JSON for init and baseline, with no ANSI even under --color always", () => {
    const res = runCli(["init", "--format", "json"]);
    expect(res.status).toBe(0);
    const initDoc = JSON.parse(res.stdout) as {
      configPath: string;
      config: { target: { name: string } };
    };
    expect(initDoc.configPath.endsWith(".perfgym.yaml")).toBe(true);
    expect(initDoc.config.target.name).toBeTruthy();

    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), BENCH_CONFIG, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "code.ts"), "export const a = 1;\n", "utf8");

    const baseRes = runCli(["baseline", "--format", "json", "--color", "always", "--samples", "1"]);
    expect(baseRes.status).toBe(0);
    expect(baseRes.stdout).not.toMatch(/\u001b\[[0-9;]*m/);

    const baseDoc = JSON.parse(baseRes.stdout) as {
      status: string;
      unit: string;
      metrics: Record<string, number>;
    };
    expect(baseDoc.status).toBe("BASELINE");
    expect(baseDoc.unit).toBe("ms");
    expect(baseDoc.metrics.latency).toBe(100);
  });

  it("emits the formatter's JSON for a rejected step with a non-zero exit", () => {
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), FAILING_CONFIG, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "code.ts"), "export const a = 1;\n", "utf8");
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
      "utf8",
    );

    const res = runCli(["step", "--format", "json", "-f", "src/code.ts"]);
    expect(res.status).toBe(1);
    const doc = JSON.parse(res.stdout) as {
      status: string;
      accepted: boolean;
      score: number | null;
      invariants: { passed: boolean };
    };
    expect(doc.status).toBe("REVERTED");
    expect(doc.accepted).toBe(false);
    expect(doc.score).toBeNull();
    expect(doc.invariants.passed).toBe(false);
  });

  it("emits no ANSI under --color never or piped --color auto", () => {
    const initRes = runCli(["init", "--color", "never"]);
    expect(initRes.status).toBe(0);
    expect(initRes.stdout).not.toMatch(ANSI_PATTERN);

    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), BENCH_CONFIG, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "code.ts"), "export const a = 1;\n", "utf8");

    const neverRes = runCli(["baseline", "--samples", "1", "--color", "never"]);
    expect(neverRes.status).toBe(0);
    expect(neverRes.stdout).not.toMatch(ANSI_PATTERN);

    const autoRes = runCli(["baseline", "--samples", "1", "--color", "auto"]);
    expect(autoRes.status).toBe(0);
    expect(autoRes.stdout).not.toMatch(ANSI_PATTERN);

    const stepRes = runCli(["step", "-f", "src/code.ts", "--color", "never"]);
    expect(stepRes.stdout).not.toMatch(ANSI_PATTERN);
  });

  it("emits formatError JSON when a command throws", () => {
    const res = runCli(["baseline", "--format", "json"]);
    expect(res.status).toBe(1);
    const doc = JSON.parse(res.stdout) as { error: { message: string } };
    expect(doc.error.message).toContain("Configuration file not found");
  });

  it("keeps --format json when init itself throws", () => {
    // A directory named .perfgym.yaml makes the write fail, exercising the
    // init catch block: it must honour --format json instead of falling back
    // to the default markdown formatter.
    fs.mkdirSync(path.join(testDir, ".perfgym.yaml"), { recursive: true });

    const res = runCli(["init", "--format", "json", "--force"]);
    expect(res.status).toBe(1);
    const doc = JSON.parse(res.stdout) as { error: { message: string; code: string | null } };
    expect(doc.error.message.length).toBeGreaterThan(0);
  });
});

