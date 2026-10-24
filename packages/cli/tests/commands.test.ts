import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { program } from "../src/index.js";
import {
  runStatusCommand,
  runRollbackCommand,
  runTestCommand,
  runLintCommand,
  runBenchmarkCommand,
  parseStepNumber,
  resolveTargetGlobs,
} from "../src/commands/lifecycle.js";
import { saveSession } from "../src/engine.js";

const STATE_FILE = path.join(".perfgym", "state.json");

/**
 * Run the real In-process CLI (parseAsync) with stdout captured. Used to pin
 * the entrypoint-level contract: parseAsync resolves only AFTER the action
 * has flushed its output (F4), and the process exit code is propagated.
 */
const runCli = async (
  cliProgram: {
    parseAsync: (args: string[], opts: { from: "user" | "node" | "electron" }) => Promise<unknown>;
  },
  args: string[],
): Promise<{ stdout: string; exitCode: number }> => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  (process.stdout as { write: unknown }).write = (chunk: unknown): boolean => {
    stdout += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  };
  const prevExitCode = process.exitCode;
  process.exitCode = undefined;
  const prevCwd = process.cwd();
  try {
    await cliProgram.parseAsync([...args], { from: "user" });
  } finally {
    (process.stdout as { write: unknown }).write = originalWrite;
    process.chdir(prevCwd);
  }
  return { stdout, exitCode: process.exitCode ?? 0 };
};

/**
 * CLI lifecycle commands (Ticket #44) — status / rollback / test / lint /
 * benchmark. The runners are invoked programmatically (the same way the
 * entrypoint calls them) with an explicit `cwd`, and assertions cover the
 * rendered text, the exit code, and the untouched side-effect surface.
 */

interface GymOptions {
  invariantCommand?: string;
  extraMetric?: boolean;
  lintViolation?: boolean;
  /** B2: adds a config rule whose language cannot be resolved — handleLint must surface it as a scan error. */
  brokenLintRule?: boolean;
}

const setupGymDir = (options: GymOptions = {}): string => {
  const dir = path.join(
    tmpdir(),
    `perfgym-commands-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });

  const git = (args: string[]): unknown =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  try {
    git(["init", "-b", "main"]);
  } catch {
    git(["init"]);
  }
  git(["config", "user.name", "Commands Bot"]);
  git(["config", "user.email", "commands@test.dev"]);

  const indexContent = options.lintViolation === true
    ? "const anyInput = 1;\nexport const value = anyInput as any;\n"
    : "export const value = 1;\n";
  fs.writeFileSync(path.join(dir, "src", "index.ts"), indexContent, "utf8");

  const metrics = [
    `  - name: "instructions"
    command: "node -e 'console.log(JSON.stringify({ value: 100 }))'"
    goal: "minimize"
    weight: 1
    unit: "count"`,
  ];
  if (options.extraMetric === true) {
    metrics.push(
      `  - name: "allocations"
    command: "node -e 'console.log(JSON.stringify({ value: 5 }))'"
    goal: "minimize"
    weight: 1
    unit: "count"`,
    );
  }

  const yaml = `
version: "1.0"
target:
  name: "commands-test"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "${options.invariantCommand ?? "node -e 'process.exit(0)'"}"
metrics:
${metrics.join("\n")}
`;
  const yamlOut = options.brokenLintRule
    ? `${yaml}
rules:
  - id: "broken-rule"
    message: "malformed rule config"
    severity: "warning"
    penalty: 0
    pattern: "$$$X"
    language: "not-a-real-language"
`
    : yaml;
  fs.writeFileSync(path.join(dir, ".perfgym.yaml"), yamlOut, "utf8");

  git(["add", "-A"]);
  git(["commit", "-m", "initial commit"]);
  return dir;
};

const readFile = (dir: string): string =>
  fs.readFileSync(path.join(dir, "src", "index.ts"), "utf8");

const readStateBytes = (dir: string): string =>
  fs.readFileSync(path.join(dir, ".perfgym", "state.json"), "utf8");

const head = (dir: string): string =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

/** A live foreign lock: holder pid is this process, heartbeat is fresh. */
const craftForeignLock = (dir: string): void => {
  const lockDir = path.join(dir, ".perfgym", ".lock.d");
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(
    path.join(lockDir, "metadata.json"),
    JSON.stringify({
      pid: process.pid,
      runId: "foreign-run",
      startTime: Date.now(),
      heartbeat: Date.now(),
    }),
    "utf8",
  );
};

const dirs: string[] = [];
const track = (dir: string): string => {
  dirs.push(dir);
  return dir;
};

let cleanup: Array<() => void> = [];

describe("CLI lifecycle commands (Ticket #44)", () => {
  beforeEach(() => {
    cleanup = [];
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    cleanup = [];
  });

  it("lists the five lifecycle commands in --help", () => {
    const help = program.helpInformation();
    for (const command of ["status", "rollback", "test", "lint", "benchmark"]) {
      expect(help).toContain(command);
    }
  });

  it("status --format json reports best score/step, per-metric deltas, history and lock state", async () => {
    const dir = track(setupGymDir());
    saveSession(dir, {
      version: "1.0",
      initializedAt: 1,
      updatedAt: 2,
      targetName: "commands-test",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 22,
      bestStep: 1,
      acceptedStepCount: 1,
      totalStepCount: 2,
      currentMetrics: { instructions: 90 },
      metricDeltas: { instructions: -10 },
      history: [
        {
          stepNumber: 1,
          score: 22,
          status: "ACCEPTED",
          commitHash: "abc123",
          deltaPercent: 10,
          timestamp: 3,
        },
        {
          stepNumber: 2,
          score: 5,
          status: "REJECTED",
          deltaPercent: -2,
          timestamp: 4,
        },
      ],
    } as unknown as Parameters<typeof saveSession>[1]);
    craftForeignLock(dir);

    const stateBefore = readStateBytes(dir);
    const fileBefore = readFile(dir);

    const res = await runStatusCommand({ cwd: dir, format: "json" });
    expect(res.failed).toBe(false);
    expect(res.exitCode).toBe(0);

    const doc = JSON.parse(res.text) as Record<string, unknown>;
    expect(doc.initialized).toBe(true);
    expect(doc.bestScore).toBe(22);
    expect(doc.bestStep).toBe(1);
    expect(doc.metricDeltas).toEqual({ instructions: -10 });
    expect(doc.historyLength).toBe(2);
    const lock = doc.lock as Record<string, unknown>;
    expect(lock.locked).toBe(true);
    expect(lock.runId).toBe("foreign-run");
    expect(lock.pid).toBe(process.pid);

    // F5: status must not mutate the state file or the worktree.
    expect(readStateBytes(dir)).toBe(stateBefore);
    expect(readFile(dir)).toBe(fileBefore);
  });

  it("status without a baseline exits 0 with guidance (markdown) or initialized:false (json)", async () => {
    const dir = track(setupGymDir());

    const fileBefore = readFile(dir);

    const md = await runStatusCommand({ cwd: dir, format: "markdown" });
    expect(md.failed).toBe(false);
    expect(md.exitCode).toBe(0);
    expect(md.text).toMatch(/no baseline yet/i);

    const json = await runStatusCommand({ cwd: dir, format: "json" });
    expect(json.failed).toBe(false);
    expect(json.exitCode).toBe(0);
    const doc = JSON.parse(json.text) as Record<string, unknown>;
    expect(doc.initialized).toBe(false);
    expect(String(doc.guidance)).toMatch(/baseline/i);

    // F5: status is read-only — the worktree file is untouched and, without a
    // baseline, no state file is ever created.
    expect(readFile(dir)).toBe(fileBefore);
    expect(fs.existsSync(path.join(dir, STATE_FILE))).toBe(false);
  });

  it("rollback restores the sandbox worktree to the remaining accepted commit, keeps the history log, and marks the step ROLLED_BACK", async () => {
    const dir = track(setupGymDir());

    // Craft two accepted steps: value 1 -> 2 (step 1) -> 3 (step 2).
    const writeStep = (n: number): { commit: string } => {
      fs.writeFileSync(path.join(dir, "src", "index.ts"), `export const value = ${n};\n`, "utf8");
      execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", `step ${n}`], { cwd: dir, stdio: "ignore" });
      return { commit: head(dir) };
    };

    const baselineCommit = head(dir);
    const step1 = writeStep(2);
    const step2 = writeStep(3);

    saveSession(dir, {
      version: "1.0",
      initializedAt: 1,
      updatedAt: 2,
      targetName: "commands-test",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 25,
      bestStep: 2,
      acceptedStepCount: 2,
      totalStepCount: 2,
      currentMetrics: { instructions: 98 },
      metricDeltas: { instructions: -2 },
      baselineCommit,
      lastCommitHash: step2.commit,
      history: [
        {
          stepNumber: 1,
          score: 15,
          status: "ACCEPTED",
          commitHash: step1.commit,
          deltaPercent: -15,
          metrics: { instructions: 85 },
          metricDeltas: { instructions: -15 },
          timestamp: 3,
        },
        {
          stepNumber: 2,
          score: 25,
          status: "ACCEPTED",
          commitHash: step2.commit,
          deltaPercent: -20,
          metrics: { instructions: 80 },
          metricDeltas: { instructions: -20 },
          timestamp: 4,
        },
      ],
    } as unknown as Parameters<typeof saveSession>[1]);

    const res = await runRollbackCommand({ cwd: dir, format: "json" });
    expect(res.failed).toBe(false);
    expect(res.exitCode).toBe(0);

    const outcome = JSON.parse(res.text) as Record<string, unknown>;
    expect(outcome.rolledBackStep).toBe(2);
    expect(outcome.restoredStep).toBe(1);
    expect(outcome.targetCommit).toBe(step1.commit);
    expect(String(outcome.message)).toMatch(/rollback/i);

    // The sandbox worktree holds the restored (step 1) content.
    const worktreesDir = path.join(dir, ".perfgym", "worktrees");
    expect(fs.existsSync(worktreesDir)).toBe(true);
    const worktreeDirs = fs.readdirSync(worktreesDir);
    expect(worktreeDirs.length).toBe(1);
    const restored = fs.readFileSync(
      path.join(worktreesDir, worktreeDirs[0]!, "src", "index.ts"),
      "utf8",
    );
    expect(restored).toContain("value = 2");

    // The user's working directory is never touched by a rollback.
    expect(readFile(dir)).toContain("value = 3");

    // History log kept; step 2 marked ROLLED_BACK, step 1 still ACCEPTED.
    const state = JSON.parse(readStateBytes(dir)) as { history: Array<{ stepNumber: number; status: string }> };
    const byStep = (n: number): { status: string } =>
      state.history.find((entry) => entry.stepNumber === n)!;
    expect(byStep(1).status).toBe("ACCEPTED");
    expect(byStep(2).status).toBe("ROLLED_BACK");
  });

  it("rollback refuses a non-ACCEPTED target step with exit 1", async () => {
    const dir = track(setupGymDir());
    saveSession(dir, {
      version: "1.0",
      initializedAt: 1,
      updatedAt: 2,
      targetName: "commands-test",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 2,
      history: [
        {
          stepNumber: 1,
          score: 10,
          status: "ACCEPTED",
          commitHash: "abc",
          deltaPercent: 10,
          metrics: { instructions: 90 },
          metricDeltas: { instructions: -10 },
          timestamp: 3,
        },
        {
          stepNumber: 2,
          score: -Infinity,
          status: "REJECTED",
          revertReason: "regression",
          deltaPercent: -50,
          timestamp: 4,
        },
      ],
    } as unknown as Parameters<typeof saveSession>[1]);

    const res = await runRollbackCommand({ cwd: dir, format: "json", toStep: 2 });
    expect(res.exitCode).toBe(1);
    expect(res.failed).toBe(true);
    expect(res.text).toMatch(/ACCEPTED/i);

    // Step 1 was not rolled back.
    const state = JSON.parse(readStateBytes(dir)) as { history: Array<{ status: string }> };
    expect(state.history.every((entry) => entry.status === "ACCEPTED" || entry.status === "REJECTED"))
      .toBe(true);
    expect(state.history.some((entry) => entry.status === "ROLLED_BACK")).toBe(false);
  });

  it("rollback refuses while the sandbox lock is held and leaves the worktree and state untouched", async () => {
    const dir = track(setupGymDir());
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const value = 3;\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "step"], { cwd: dir, stdio: "ignore" });
    const beforeCommit = head(dir);

    saveSession(dir, {
      version: "1.0",
      initializedAt: 1,
      updatedAt: 2,
      targetName: "commands-test",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 1,
      totalStepCount: 1,
      baselineCommit: beforeCommit,
      history: [
        {
          stepNumber: 1,
          score: 10,
          status: "ACCEPTED",
          commitHash: beforeCommit,
          deltaPercent: 10,
          metrics: { instructions: 90 },
          metricDeltas: { instructions: -10 },
          timestamp: 3,
        },
      ],
    } as unknown as Parameters<typeof saveSession>[1]);

    const stateBefore = readStateBytes(dir);
    const fileBefore = readFile(dir);
    craftForeignLock(dir);

    const res = await runRollbackCommand({ cwd: dir, format: "json" });
    expect(res.exitCode).toBe(1);
    expect(res.failed).toBe(true);
    expect(res.text).toMatch(/lock busy/i);

    expect(readStateBytes(dir)).toBe(stateBefore);
    expect(readFile(dir)).toBe(fileBefore);
    expect(fs.existsSync(path.join(dir, ".perfgym", "worktrees"))).toBe(false);
  });

  it("test reports the invariant outcome and modifies neither state nor worktree", async () => {
    const dir = track(setupGymDir());
    saveSession(dir, {
      version: "1.0",
      initializedAt: 1,
      updatedAt: 2,
      targetName: "commands-test",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });

    const stateBefore = readStateBytes(dir);
    const fileBefore = readFile(dir);

    const res = await runTestCommand({ cwd: dir, format: "json" });
    expect(res.failed).toBe(false);
    expect(res.exitCode).toBe(0);
    const doc = JSON.parse(res.text) as Record<string, unknown>;
    expect(doc.passed).toBe(true);

    expect(readStateBytes(dir)).toBe(stateBefore);
    expect(readFile(dir)).toBe(fileBefore);
  });

  it("test exits 1 when the invariant fails", async () => {
    const dir = track(setupGymDir({ invariantCommand: "node -e 'process.exit(3)'" }));
    const res = await runTestCommand({ cwd: dir, format: "json" });
    expect(res.failed).toBe(false);
    expect(res.exitCode).toBe(1);
    const doc = JSON.parse(res.text) as Record<string, unknown>;
    expect(doc.passed).toBe(false);
  });

  it("lint exits 0 on a clean scan and modifies neither state nor worktree", async () => {
    const dir = track(setupGymDir());
    saveSession(dir, {
      version: "1.0",
      initializedAt: 1,
      updatedAt: 2,
      targetName: "commands-test",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });

    const stateBefore = readStateBytes(dir);
    const fileBefore = readFile(dir);

    const res = await runLintCommand({ cwd: dir, format: "json" });
    expect(res.failed).toBe(false);
    expect(res.exitCode).toBe(0);
    const doc = JSON.parse(res.text) as Record<string, unknown>;
    expect(doc.passed).toBe(true);

    expect(readStateBytes(dir)).toBe(stateBefore);
    expect(readFile(dir)).toBe(fileBefore);
  });

  it("lint exits 1 on an error-severity violation and reports the violation", async () => {
    const dir = track(setupGymDir({ lintViolation: true }));
    const res = await runLintCommand({ cwd: dir, format: "json" });
    expect(res.failed).toBe(false);
    expect(res.exitCode).toBe(1);
    const doc = JSON.parse(res.text) as {
      matches: Array<{ ruleId: string; file: string; line: number; action: string }>;
      totalPenalty: number;
    };
    expect(doc.matches.some((match) => match.ruleId === "no-any-cast")).toBe(true);
    expect(
      doc.matches.every((match) => match.file === "src/index.ts" && match.action === "disqualify"),
    ).toBe(true);
  });

  // --- B2 --------------------------------------------------------------------
  it("lint honours coordinator scanErrors: broken rule means failed scan, exit 1, rendered error", async () => {
    const dir = track(setupGymDir({ brokenLintRule: true }));

    const json = await runLintCommand({ cwd: dir, format: "json" });
    expect(json.exitCode).toBe(1);
    expect(json.failed).toBe(true);
    const doc = JSON.parse(json.text) as { scanErrors: string[]; passed: boolean };
    expect(doc.passed).toBe(false);
    expect(doc.scanErrors.length).toBeGreaterThanOrEqual(1);
    expect(doc.scanErrors[0]).toContain("broken-rule");

    const md = await runLintCommand({ cwd: dir, format: "markdown" });
    expect(md.exitCode).toBe(1);
    expect(md.failed).toBe(true);
    expect(md.text).toContain("broken-rule");
  });

  it("benchmark reports the distribution without updating state or touching the worktree", async () => {
    const dir = track(setupGymDir());
    saveSession(dir, {
      version: "1.0",
      initializedAt: 1,
      updatedAt: 2,
      targetName: "commands-test",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });

    const stateBefore = readStateBytes(dir);
    const fileBefore = readFile(dir);

    const res = await runBenchmarkCommand({ cwd: dir, format: "json", samples: 1 });
    expect(res.failed).toBe(false);
    expect(res.exitCode).toBe(0);
    const doc = JSON.parse(res.text) as Record<string, unknown>;
    expect(doc.metric).toBe("instructions");
    const distribution = doc.distribution as Record<string, unknown>;
    for (const key of ["p50", "p90", "p95", "p99", "mad", "iqr"]) {
      expect(distribution).toHaveProperty(key);
    }
    expect(doc.baselineValue).toBe(100);
    expect(typeof doc.deltaPercent).toBe("number");

    expect(readStateBytes(dir)).toBe(stateBefore);
    expect(readFile(dir)).toBe(fileBefore);
  });

  it("benchmark --metric selects the requested metric", async () => {
    const dir = track(setupGymDir({ extraMetric: true }));
    const res = await runBenchmarkCommand({ cwd: dir, format: "json", samples: 1, metric: "allocations" });
    expect(res.failed).toBe(false);
    expect(res.exitCode).toBe(0);
    const doc = JSON.parse(res.text) as Record<string, unknown>;
    expect(doc.metric).toBe("allocations");
  });

  // --- F1 --------------------------------------------------------------------
  it("rollback --to-step rejects an unparseable value instead of silently defaulting", () => {
    // Red: currently an invalid string silently degrades to a default
    // rollback (exit 0) because parseInt + NaN-undefined swallows it.
    expect(() => parseStepNumber("foo")).toThrow(/to-step/i);
    expect(() => parseStepNumber("0")).toThrow(/to-step/i);
    expect(() => parseStepNumber("2.5")).toThrow(/to-step/i);
    expect(() => parseStepNumber("")).toThrow(/to-step/i);
    expect(parseStepNumber(undefined)).toBeUndefined();
    expect(parseStepNumber("3")).toBe(3);
  });

  // --- F2 --------------------------------------------------------------------
  it("benchmark markdown reports p90, MAD, IQR and the delta vs baseline", async () => {
    const dir = track(setupGymDir());
    saveSession(dir, {
      version: "1.0",
      initializedAt: 1,
      updatedAt: 2,
      targetName: "commands-test",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });

    const res = await runBenchmarkCommand({ cwd: dir, format: "markdown", samples: 1 });
    expect(res.failed).toBe(false);
    expect(res.exitCode).toBe(0);
    expect(res.text).toContain("p50");
    expect(res.text).toContain("p90");
    expect(res.text).toContain("p95");
    expect(res.text).toContain("p99");
    expect(res.text).toContain("MAD");
    expect(res.text).toContain("IQR");
    // Baseline exists (100) → the delta section must be present in markdown.
    expect(res.text).toMatch(/Delta vs baseline/i);
  });

  // --- F3 --------------------------------------------------------------------
  it("the sandbox driver boundary follows the configured target.files", () => {
    const configuredDir = track(setupGymDir());
    // Patch the config to a non-src target so the fallback would be wrong.
    const configuredYaml = `
version: "1.0"
target:
  name: "commands-test"
  language: "typescript"
  files: ["lib/**/*.js"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "instructions"
    command: "node -e 'console.log(JSON.stringify({ value: 100 }))'"
    goal: "minimize"
    weight: 1
    unit: "count"
`;
    fs.writeFileSync(path.join(configuredDir, ".perfgym.yaml"), configuredYaml, "utf8");
    expect(resolveTargetGlobs(configuredDir)).toEqual(["lib/**/*.js"]);

    // No configuration (and even a non-existent directory) → default globs.
    const fallbackDir = path.join(
      tmpdir(),
      `perfgym-no-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    expect(resolveTargetGlobs(fallbackDir)).toEqual(["src/**/*"]);
  });

  // --- F4 --------------------------------------------------------------------
  it("parseAsync awaits the lifecycle action before resolving (output is flushed)", async () => {
    // Red: the entrypoint's actions fire-and-forget the lifecycle runner, so
    // parseAsync resolves BEFORE the (deliberately delayed) result is written.
    vi.resetModules();
    vi.doMock("../src/commands/lifecycle.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/commands/lifecycle.js")>();
      return {
        ...actual,
        runStatusCommand: async (options: { format: string }) => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            text: JSON.stringify({ initialized: false, guidance: "delayed-status-result" }),
            exitCode: 0,
            failed: false,
          };
        },
      };
    });

    try {
      const { program: freshProgram } = await import("../src/index.js");
      const { stdout, exitCode } = await runCli(freshProgram, ["status", "--format", "json"]);
      expect(stdout).toContain("delayed-status-result");
      expect(exitCode).toBe(0);
    } finally {
      vi.doUnmock("../src/commands/lifecycle.js");
      vi.resetModules();
    }
  });

  // --- R8 --------------------------------------------------------------------
  it("R8: the binary entrypoint parses with parseAsync so async lifecycle output survives", async () => {
    // Red: the runtime guard invoked `program.parse(process.argv)`, which does
    // NOT await the async lifecycle actions — output/exitCode can be lost when
    // running the compiled binary. The guard must use `parseAsync`.
    const entryPath = new URL("../src/index.ts", import.meta.url);
    const source = await fs.promises.readFile(entryPath, "utf8");
    expect(source).not.toMatch(/(?<!Async)\)\.parse\(process\.argv\)/);
    expect(source).toContain("await program.parseAsync(process.argv)");
  });
});
