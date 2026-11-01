import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Cause, Effect, Exit } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { runOptimizationLoop, type MutationGenerator } from "../src/commands/run.js";
import { saveSession } from "../src/engine.js";

/**
 * ADR-020 (map #74): the pre-flight E2E certification pass is wired into the
 * run loop as two run-level gates — one before iteration 1 (failure aborts
 * the whole run with a distinct non-invariant error) and one before promotion
 * (failure blocks promotion but keeps the winning commit and sets
 * `stopReason: certification-failed`). The pass is NEVER a per-step check and
 * never a fitness term: across a whole run it may only run twice.
 *
 * The certification command is a committed probe script that appends to a
 * counter file OUTSIDE the worktree (absolute path baked into the command), so
 * invocation counts survive worktree teardown.
 */
describe("ADR-020 certification gates in the run loop (map #74)", () => {
  let testDir: string;
  let counterPath: string;
  let headBefore: string;

  const PROBE = `const fs = require("fs");
const counter = process.argv[2];
const mode = process.argv[3] ?? "always-pass";
const c = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
fs.writeFileSync(counter, String(c + 1));
process.exit(mode === "fail-after-first" && c >= 1 ? 1 : 0);
`;

  const certBlockWithProbe = (mode?: string, extra = ""): string =>
    `certification:\n  command: "node cert-probe.js ${counterPath}${mode ? ` ${mode}` : ""}"\n${extra}`;

  const statePath = path.join(".perfgym", "state.json");
  const readState = (dir: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(dir, statePath), "utf8")) as Record<string, unknown>;
  const readCounter = (): number =>
    fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;

  const setupRepo = (certBlock: string): void => {
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "// value: 100\nexport let count = 0;\n", "utf8");
    fs.writeFileSync(path.join(testDir, "cert-probe.js"), PROBE, "utf8");
    fs.writeFileSync(
      path.join(testDir, ".perfgym.yaml"),
      `
version: "1.0"
target:
  name: "cert-gate"
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
${certBlock}`,
      "utf8",
    );
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: testDir, stdio: "ignore" });
    headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: testDir }).toString().trim();

    saveSession(testDir, {
      version: "1.0",
      initializedAt: Date.now(),
      updatedAt: Date.now(),
      targetName: "cert-gate",
      baselineMetrics: { instructions: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });
  };

  const improvingMutation: MutationGenerator = async () => [
    { relPath: "src/index.ts", content: "// value: 85\nexport let count = 1;\n" },
  ];

  beforeEach(() => {
    testDir = path.join(
      tmpdir(),
      `perfgym-run-cert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    );
    counterPath = path.join(testDir, "cert-counter.txt");
    fs.mkdirSync(testDir, { recursive: true });

    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir, stdio: "ignore" });
    } catch {
      execFileSync("git", ["init"], { cwd: testDir, stdio: "ignore" });
    }
    execFileSync("git", ["config", "user.name", "Test Sentinel"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "sentinel@test.com"], { cwd: testDir, stdio: "ignore" });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("AC1: a failing pre-loop certification aborts the run before iteration 1 with a distinct CertificationError", async () => {
    setupRepo(`certification:\n  command: "node -e 'process.exit(1)'"\n  timeout_ms: 10000\n`);

    let generatorCalls = 0;
    const generator: MutationGenerator = async () => {
      generatorCalls++;
      return [];
    };

    const exit = await Effect.runPromiseExit(
      runOptimizationLoop({ cwd: testDir, maxIterations: 3, generator, samples: 1, quiet: true }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const error = Exit.isFailure(exit) ? (Cause.squash(exit.cause) as { _tag?: string; phase?: string; code?: string }) : null;
    // Certification is its OWN gate: a distinct tagged error, never an
    // InvariantFailureError (ADR-020, map #74).
    expect(error?._tag).toBe("CertificationError");
    expect(error?._tag).not.toBe("InvariantFailureError");
    expect(error?.phase).toBe("pre-loop");
    expect(error?.code).toBe("ERR_CERTIFICATION_FAILURE");
    // The abort happens BEFORE the first mutation is requested.
    expect(generatorCalls).toBe(0);

    // The failed pass is durably recorded on the session state.
    const certification = readState(testDir).certification as
      | { passed: boolean; exitCode: number | null }
      | undefined;
    expect(certification?.passed).toBe(false);
    expect(certification?.exitCode).toBe(1);
  });

  it("AC2: a failing pre-promotion certification blocks promotion, keeps the winning commit and sets stopReason 'certification-failed'", async () => {
    setupRepo(certBlockWithProbe("fail-after-first", "  timeout_ms: 10000\n"));

    const res = await Effect.runPromise(
      runOptimizationLoop({ cwd: testDir, maxIterations: 1, generator: improvingMutation, samples: 1, quiet: true }),
    );

    expect(res.acceptedCount).toBe(1);
    expect(res.promoted).toBe(false);
    expect(res.stoppedReason).toBe("certification-failed");

    // The run's accepted steps are recorded even though promotion was blocked
    // (OCR medium: status must not show stale counters after a blocked run).
    const stateAfter = readState(testDir);
    expect(stateAfter.acceptedStepCount).toBe(1);
    expect(stateAfter.totalStepCount).toBe(1);
    expect(stateAfter.bestFitnessScore).toBeGreaterThan(0);

    // The target branch is untouched.
    const mainHead = execFileSync("git", ["rev-parse", "main"], { cwd: testDir }).toString().trim();
    expect(mainHead).toBe(headBefore);

    // The winning commit survives on the eval branch (teardown removes the
    // worktree but keeps branch refs).
    const evalBranches = execFileSync("git", ["for-each-ref", "refs/heads/perfgym", "--format=%(refname)"], {
      cwd: testDir,
    })
      .toString()
      .trim()
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(evalBranches.length).toBeGreaterThanOrEqual(1);
    const winningTree = execFileSync("git", ["show", `${evalBranches[0]}:src/index.ts`], { cwd: testDir }).toString();
    expect(winningTree).toContain("value: 85");
  });

  it("AC3: certification runs exactly twice across a 2-iteration run (pre-loop + pre-promotion, never per-step)", async () => {
    setupRepo(certBlockWithProbe());

    const mutations = [
      "// value: 85\nexport let count = 1;\n",
      "// value: 150\nexport let count = 2;\n",
    ];
    let iteration = 0;
    const generator: MutationGenerator = async () => {
      const code = mutations[iteration++] ?? mutations[0]!;
      return [{ relPath: "src/index.ts", content: code }];
    };

    const res = await Effect.runPromise(
      runOptimizationLoop({ cwd: testDir, maxIterations: 2, generator, samples: 1, quiet: true }),
    );

    expect(res.acceptedCount).toBe(1);
    expect(res.promoted).toBe(true);
    // Exactly one pass before iteration 1 and one before promotion — the
    // per-step loop must never run the E2E suite.
    expect(readCounter()).toBe(2);
    expect(res.certification?.passed).toBe(true);

    const certification = readState(testDir).certification as { passed: boolean } | undefined;
    expect(certification?.passed).toBe(true);
  });

  it("AC4: before_promotion: false skips the second pass (exactly one invocation)", async () => {
    setupRepo(certBlockWithProbe(undefined, "  before_promotion: false\n"));

    const res = await Effect.runPromise(
      runOptimizationLoop({ cwd: testDir, maxIterations: 1, generator: improvingMutation, samples: 1, quiet: true }),
    );

    expect(res.acceptedCount).toBe(1);
    expect(res.promoted).toBe(true);
    expect(readCounter()).toBe(1);
  });

  it("AC5: required: false makes both gates advisory — the run proceeds and still promotes", async () => {
    setupRepo(`certification:\n  command: "node -e 'process.exit(1)'"\n  required: false\n`);

    const res = await Effect.runPromise(
      runOptimizationLoop({ cwd: testDir, maxIterations: 1, generator: improvingMutation, samples: 1, quiet: true }),
    );

    expect(res.acceptedCount).toBe(1);
    expect(res.promoted).toBe(true);
    expect(res.stoppedReason).toBe("max-iterations");
    // The failed passes are still recorded honestly.
    const certification = readState(testDir).certification as { passed: boolean } | undefined;
    expect(certification?.passed).toBe(false);
  });

  it("AC6: the run summary prints the certification outcome on its own labelled line", async () => {
    setupRepo(`certification:\n  command: "node -e 'process.exit(1)'"\n  required: false\n`);

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    try {
      await Effect.runPromise(
        runOptimizationLoop({ cwd: testDir, maxIterations: 1, generator: improvingMutation, samples: 1 }),
      );
    } finally {
      logSpy.mockRestore();
    }

    const certLine = logs.find((line) => line.includes("E2E Certification"));
    expect(certLine).toBeDefined();
    expect(certLine).toContain("FAILED");
    // The summary never folds certification into an invariant (AC4).
    expect(certLine).not.toContain("Invariant");
  });

  it("AC7: without a certification block the summary says so and no pass runs", async () => {
    setupRepo("");

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
    });

    try {
      await Effect.runPromise(
        runOptimizationLoop({ cwd: testDir, maxIterations: 1, generator: improvingMutation, samples: 1 }),
      );
    } finally {
      logSpy.mockRestore();
    }

    const certLine = logs.find((line) => line.includes("E2E Certification"));
    expect(certLine).toBeDefined();
    expect(certLine).toContain("not configured");
    expect(readCounter()).toBe(0);
  });
});
