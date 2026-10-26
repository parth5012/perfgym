import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";

const ANSI_PATTERN = /\u001b\[[0-9;]*m/;

const cliEntrypoint = path.resolve(__dirname, "../../packages/cli/src/index.ts");

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
}

/**
 * Run the CLI as a real subprocess (through tsx) in `cwd` and capture its
 * output and exit code.
 */
function runCli(args: string[], cwd: string): CliResult {
  try {
    const tsxBin = path.resolve(__dirname, "../../node_modules/.bin/tsx");
    const stdout = execFileSync(tsxBin, [cliEntrypoint, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err: unknown) {
    const failure = err as {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number;
    };
    return {
      stdout: failure.stdout ? failure.stdout.toString() : "",
      stderr: failure.stderr ? failure.stderr.toString() : "",
      status: failure.status ?? 1,
    };
  }
}

describe("CLI E2E / Bin Execution", () => {
  let testDir: string;

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

  it("prints help and version cleanly", () => {
    const res = runCli(["--help"], testDir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("perfgym");
    expect(res.stdout).toContain("init");
    expect(res.stdout).toContain("baseline");
    expect(res.stdout).toContain("step");
  });

  it("executes init -> baseline -> step flow end to end", () => {
    // 1. init
    const initRes = runCli(["init"], testDir);
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
    const baseRes = runCli(["baseline", "--samples", "2"], testDir);
    expect(baseRes.status).toBe(0);
    expect(baseRes.stdout).toContain("Baseline established");
    expect(fs.existsSync(path.join(testDir, ".perfgym", "state.json"))).toBe(true);

    // 3. step with improvement
    const betterConfigYaml = configYaml.replace("value: 100", "value: 70");
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), betterConfigYaml, "utf8");

    const stepRes = runCli(["step", "--samples", "2", "-f", "src/code.ts"], testDir);
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

    const stepRes = runCli(["step", "-f", "src/code.ts"], testDir);
    expect(stepRes.status).toBe(1);
    expect(stepRes.stdout).toContain("Change rejected");
  });

  it("lists --format and --color on every command", () => {
    for (const command of ["init", "baseline", "step", "run"]) {
      const res = runCli([command, "--help"], testDir);
      expect(res.status, `${command} --help should exit 0`).toBe(0);
      expect(res.stdout).toContain("--format");
      expect(res.stdout).toContain("--color");
    }
  });

  it("emits parseable JSON for init and baseline, with no ANSI even under --color always", () => {
    const res = runCli(["init", "--format", "json"], testDir);
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

    const baseRes = runCli(["baseline", "--format", "json", "--color", "always", "--samples", "1"], testDir);
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

    const res = runCli(["step", "--format", "json", "-f", "src/code.ts"], testDir);
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
    const initRes = runCli(["init", "--color", "never"], testDir);
    expect(initRes.status).toBe(0);
    expect(initRes.stdout).not.toMatch(ANSI_PATTERN);

    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), BENCH_CONFIG, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "code.ts"), "export const a = 1;\n", "utf8");

    const neverRes = runCli(["baseline", "--samples", "1", "--color", "never"], testDir);
    expect(neverRes.status).toBe(0);
    expect(neverRes.stdout).not.toMatch(ANSI_PATTERN);

    const autoRes = runCli(["baseline", "--samples", "1", "--color", "auto"], testDir);
    expect(autoRes.status).toBe(0);
    expect(autoRes.stdout).not.toMatch(ANSI_PATTERN);

    const stepRes = runCli(["step", "-f", "src/code.ts", "--color", "never"], testDir);
    expect(stepRes.stdout).not.toMatch(ANSI_PATTERN);
  });

  it("emits formatError JSON when a command throws", () => {
    const res = runCli(["baseline", "--format", "json"], testDir);
    // A missing config is a usage/config failure under the Ticket #51
    // exit-code contract: ConfigError → 2 (not the generic domain failure 1).
    expect(res.status).toBe(2);
    const doc = JSON.parse(res.stdout) as { error: { message: string } };
    expect(doc.error.message).toContain("Configuration file not found");
  });

  it("keeps --format json when init itself throws", () => {
    // A directory named .perfgym.yaml makes the write fail, exercising the
    // init catch block: it must honour --format json instead of falling back
    // to the default markdown formatter.
    fs.mkdirSync(path.join(testDir, ".perfgym.yaml"), { recursive: true });

    const res = runCli(["init", "--format", "json", "--force"], testDir);
    expect(res.status).toBe(1);
    const doc = JSON.parse(res.stdout) as { error: { message: string; code: string | null } };
    expect(doc.error.message.length).toBeGreaterThan(0);
  });
});

describe("CLI E2E — Negative Memory (Ticket #38)", () => {
  let testDir: string;

  const MEMORY_FILE = path.join(".perfgym", "negative-memory.json");

  const TARGET_CONFIG = `
version: "1.0"
target:
  name: "e2e-memory"
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

  const FAILING_TARGET_CONFIG = `
version: "1.0"
target:
  name: "e2e-memory"
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
    testDir = path.join(
      tmpdir(),
      `perfgym-cli-memory-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    fs.mkdirSync(testDir, { recursive: true });
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "code.ts"), "export const a = 1;\n", "utf8");
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  const writeMemoryFile = (): void => {
    fs.mkdirSync(path.join(testDir, ".perfgym"), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, MEMORY_FILE),
      JSON.stringify(
        {
          version: 1,
          targets: {
            "e2e-memory": {
              target: "e2e-memory",
              entries: [
                {
                  id: "hash-1",
                  strategy: "src/code.ts",
                  deltaPercent: -8.3,
                  reason: "Regressed tail latency.",
                  step: 2,
                  timestamp: 1_700_000_000_000,
                },
              ],
            },
            "other-target": {
              target: "other-target",
              entries: [
                {
                  id: "hash-2",
                  strategy: "src/other.ts",
                  deltaPercent: -1.5,
                  reason: "Another target's failure.",
                  step: 1,
                  timestamp: 1_700_000_000_001,
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
  };

  const readMemoryFile = (): {
    targets: Record<string, { target: string; entries: Array<Record<string, unknown>> }>;
  } => JSON.parse(fs.readFileSync(path.join(testDir, MEMORY_FILE), "utf8"));

  it("lists the remembered failures with --format json", () => {
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), TARGET_CONFIG, "utf8");
    writeMemoryFile();

    const res = runCli(["memory", "show", "--format", "json"], testDir);
    expect(res.status).toBe(0);
    expect(res.stdout).not.toMatch(ANSI_PATTERN);

    const doc = JSON.parse(res.stdout) as {
      target: string;
      count: number;
      entries: Array<{ strategy: string; deltaPercent: number }>;
    };
    expect(doc.target).toBe("e2e-memory");
    expect(doc.count).toBe(1);
    expect(doc.entries[0]!.strategy).toBe("src/code.ts");
    expect(doc.entries[0]!.deltaPercent).toBe(-8.3);
  });

  it("lists the remembered failures as markdown", () => {
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), TARGET_CONFIG, "utf8");
    writeMemoryFile();

    const res = runCli(["memory", "show"], testDir);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("src/code.ts");
    expect(res.stdout).toContain("-8.3%");
    expect(res.stdout).toContain("e2e-memory");
  });

  it("succeeds with an empty memory and says nothing is remembered", () => {
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), TARGET_CONFIG, "utf8");

    const jsonRes = runCli(["memory", "show", "--format", "json"], testDir);
    expect(jsonRes.status).toBe(0);
    const doc = JSON.parse(jsonRes.stdout) as { target: string; count: number; entries: unknown[] };
    expect(doc.count).toBe(0);
    expect(doc.entries).toEqual([]);

    const markdownRes = runCli(["memory", "show"], testDir);
    expect(markdownRes.status).toBe(0);
    expect(markdownRes.stdout.toLowerCase()).toContain("nothing remembered");
  });

  it("clears the target's entries and leaves other targets alone", () => {
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), TARGET_CONFIG, "utf8");
    writeMemoryFile();

    const clearRes = runCli(["memory", "clear", "--format", "json"], testDir);
    expect(clearRes.status).toBe(0);
    const cleared = JSON.parse(clearRes.stdout) as {
      status: string;
      target: string;
      cleared: number;
      count: number;
      entries: unknown[];
    };
    expect(cleared.status).toBe("CLEARED");
    expect(cleared.target).toBe("e2e-memory");
    expect(cleared.cleared).toBe(1);
    expect(cleared.count).toBe(0);

    const afterRes = runCli(["memory", "show", "--format", "json"], testDir);
    const after = JSON.parse(afterRes.stdout) as { count: number };
    expect(after.count).toBe(0);

    const raw = readMemoryFile();
    expect(raw.targets["e2e-memory"]!.entries).toEqual([]);
    expect(raw.targets["other-target"]!.entries).toHaveLength(1);
  });

  it("clears nothing gracefully when there is no memory yet", () => {
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), TARGET_CONFIG, "utf8");

    const res = runCli(["memory", "clear", "--format", "json"], testDir);
    expect(res.status).toBe(0);
    const doc = JSON.parse(res.stdout) as { status: string; cleared: number };
    expect(doc.status).toBe("CLEARED");
    expect(doc.cleared).toBe(0);

    // Nothing to clear -> the filesystem is left untouched: no empty cache
    // file is created.
    expect(fs.existsSync(path.join(testDir, MEMORY_FILE))).toBe(false);
  });

  it("leaves an existing cache file untouched when the target has nothing to clear", () => {
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), TARGET_CONFIG, "utf8");

    // A cache file that only holds ANOTHER target's entries.
    fs.mkdirSync(path.join(testDir, ".perfgym"), { recursive: true });
    const otherTargetOnly = JSON.stringify(
      {
        version: 1,
        targets: {
          "other-target": {
            target: "other-target",
            entries: [
              {
                id: "hash-2",
                strategy: "src/other.ts",
                deltaPercent: -1.5,
                reason: "Another target's failure.",
                step: 1,
                timestamp: 1_700_000_000_001,
              },
            ],
          },
        },
      },
      null,
      2,
    );
    fs.writeFileSync(path.join(testDir, MEMORY_FILE), otherTargetOnly, "utf8");

    const res = runCli(["memory", "clear", "--format", "json"], testDir);
    expect(res.status).toBe(0);
    const doc = JSON.parse(res.stdout) as { status: string; cleared: number };
    expect(doc.status).toBe("CLEARED");
    expect(doc.cleared).toBe(0);

    // The file is left exactly as it was.
    expect(fs.readFileSync(path.join(testDir, MEMORY_FILE), "utf8")).toBe(otherTargetOnly);
  });

  it("fails with the config error when there is no .perfgym.yaml", () => {
    const res = runCli(["memory", "show", "--format", "json"], testDir);
    // ConfigError is a usage/config failure (Ticket #51 AC1): exit code 2.
    expect(res.status).toBe(2);
    const doc = JSON.parse(res.stdout) as { error: { message: string } };
    expect(doc.error.message).toContain("Configuration file not found");
  });

  it("prints the memory help when no subcommand is given", () => {
    const res = runCli(["memory"], testDir);
    const output = `${res.stdout}${res.stderr}`;
    expect(output).toContain("show");
    expect(output).toContain("clear");
  });

  it("lists --format and --color on the memory subcommands", () => {
    for (const sub of ["show", "clear"]) {
      const res = runCli(["memory", sub, "--help"], testDir);
      expect(res.status, `memory ${sub} --help should exit 0`).toBe(0);
      expect(res.stdout).toContain("--format");
      expect(res.stdout).toContain("--color");
    }
  });

  it("writes nothing to the cache without --record-negative-memory", () => {
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), FAILING_TARGET_CONFIG, "utf8");
    fs.mkdirSync(path.join(testDir, ".perfgym"), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, ".perfgym", "state.json"),
      JSON.stringify({
        version: "1.0",
        targetName: "e2e-memory",
        baselineMetrics: { latency: 100 },
        invariantsPassed: true,
        bestFitnessScore: 0,
        acceptedStepCount: 0,
        totalStepCount: 0,
      }),
      "utf8",
    );

    const res = runCli(["step", "-f", "src/code.ts"], testDir);
    expect(res.status).toBe(1);
    expect(fs.existsSync(path.join(testDir, MEMORY_FILE))).toBe(false);
  });

  it("records a rejected step with --record-negative-memory", () => {
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), FAILING_TARGET_CONFIG, "utf8");
    fs.mkdirSync(path.join(testDir, ".perfgym"), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, ".perfgym", "state.json"),
      JSON.stringify({
        version: "1.0",
        targetName: "e2e-memory",
        baselineMetrics: { latency: 100 },
        invariantsPassed: true,
        bestFitnessScore: 0,
        acceptedStepCount: 0,
        totalStepCount: 0,
      }),
      "utf8",
    );

    const res = runCli(["step", "-f", "src/code.ts", "--record-negative-memory"], testDir);
    expect(res.status).toBe(1);

    const raw = readMemoryFile();
    const entries = raw.targets["e2e-memory"]?.entries ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]!.strategy).toBe("src/code.ts");
    expect(typeof entries[0]!.reason).toBe("string");
    expect(entries[0]!.step).toBe(1);
  });
});


// ============================================================================
// Ctrl-C teardown (Ticket #51 — AC4)
// ============================================================================

describe("CLI E2E — SIGINT interrupts `perfgym run` (Ticket #51)", () => {
  let testDir: string;

  // The run parks inside the CLI mutation driver (`sleep 10`): the sandbox
  // lock and the worktree are held while it waits, so SIGINT always lands in
  // the middle of a run with live resources to tear down.
  const RUN_CONFIG = `
version: "1.0"
target:
  name: "sigint-target"
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
llm:
  driver: cli
  cli_command: sleep
  cli_args: ["10"]
`;

  const lockDir = (): string => path.join(testDir, ".perfgym", ".lock.d");
  const worktreesDir = (): string => path.join(testDir, ".perfgym", "worktrees");
  const worktreeEntries = (): string[] =>
    fs.existsSync(worktreesDir()) ? fs.readdirSync(worktreesDir()) : [];

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    testDir = path.join(
      tmpdir(),
      `perfgym-cli-sigint-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
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
    fs.writeFileSync(path.join(testDir, "src", "code.ts"), "export const a = 1;\n", "utf8");
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), RUN_CONFIG, "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: testDir, stdio: "ignore" });

    // Seeded baseline: `perfgym run` skips the baseline phase and acquires the
    // sandbox immediately, so the worktree/lock appear quickly.
    fs.mkdirSync(path.join(testDir, ".perfgym"), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, ".perfgym", "state.json"),
      JSON.stringify({
        version: "1.0",
        targetName: "sigint-target",
        baselineMetrics: { latency: 100 },
        invariantsPassed: true,
        bestFitnessScore: 0,
        acceptedStepCount: 0,
        totalStepCount: 0,
      }),
      "utf8",
    );
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("releases the lock and removes the worktree when SIGINT interrupts the run", async () => {
    // Spawned as ONE process (node + the tsx loader) instead of the tsx shim:
    // the shim is a wrapper that relays the signal to its child with its own
    // timeout and exits 130 ITSELF — so the signal never reaches the CLI and
    // its child can be killed mid-cleanup, leaving a stale lock behind. Ctrl-C
    // has to hit the process that actually holds the sandbox (Ticket #51 AC4).
    const tsxLoader = path.resolve(__dirname, "../../node_modules/tsx/dist/loader.mjs");
    const child = spawn(
      process.execPath,
      [
        "--import",
        tsxLoader,
        cliEntrypoint,
        "run",
        "--iterations", "1",
        "--driver", "cli",
        "--cli-command", "sleep",
        "--cli-args", "10",
        "--format", "json",
      ],
      { cwd: testDir, stdio: ["ignore", "pipe", "pipe"] },
    );

    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    });

    try {
      // Wait until the run holds the lock AND has created its worktree, then
      // interrupt it while those resources are live.
      const deadline = Date.now() + 25_000;
      while (
        Date.now() < deadline &&
        child.exitCode === null &&
        !(fs.existsSync(lockDir()) && worktreeEntries().length > 0)
      ) {
        await sleep(50);
      }

      expect(
        fs.existsSync(lockDir()),
        `run never acquired the sandbox lock; output:\n${output}`,
      ).toBe(true);
      expect(worktreeEntries().length, "run never created a worktree").toBeGreaterThan(0);

      child.kill("SIGINT");

      const code = await Promise.race([
        exited,
        sleep(15_000).then(() => "timeout" as const),
      ]);
      expect(
        code,
        `CLI did not exit with 130 after SIGINT; output:\n${output}`,
      ).toBe(130);

      // AC4: the interrupt ran the scoped release — no stale lock, no orphaned
      // worktree directory, and git only sees the checked-out worktree.
      expect(
        fs.existsSync(lockDir()),
        `lock survived the interrupt; output:\n${output}`,
      ).toBe(false);
      expect(worktreeEntries(), `worktree survived the interrupt; output:\n${output}`).toEqual([]);

      const listed = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: testDir,
        encoding: "utf8",
      });
      expect(listed.match(/^worktree /gm)?.length ?? 0).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  }, 45_000);
});
