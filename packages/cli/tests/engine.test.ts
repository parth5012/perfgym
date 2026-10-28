import * as fs from "node:fs";
import { Effect } from "effect";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_PATH,
  loadConfig,
  loadSession,
  runBaseline,
  runStep,
  saveSession,
  sessionFileOutcome,
  type PerfGymState,
} from "../src/engine.js";

const makeDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "perfgym-engine-"));

const stateFilePath = (dir: string): string => path.join(dir, STATE_PATH);

const fixture = (overrides: Partial<PerfGymState> = {}): PerfGymState => ({
  version: "1.0",
  initializedAt: 1,
  updatedAt: 2,
  targetName: "engine-test",
  baselineMetrics: { latency: 100 },
  invariantsPassed: true,
  bestFitnessScore: 4,
  acceptedStepCount: 1,
  totalStepCount: 0,
  ...overrides,
});

// A valid config so `runStep` gets past `loadConfig` and can reach the
// baseline guard in the never-initialized / corrupt-file tests.
const stepConfigYaml = `
version: "1.0"
target:
  name: "test-target"
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

describe("engine session accessors (Ticket #46 — loadSession/saveSession)", () => {
  it("round-trips saveSession → loadSession without losing fields", () => {
    const dir = makeDir();

    const saved = saveSession(dir, fixture({ totalStepCount: 3 }));
    expect(saved.totalStepCount).toBe(3);
    expect(saved.lastUpdatedAt).toBeGreaterThan(0);

    const loaded = loadSession(dir);
    expect(loaded).not.toBeNull();
    expect(loaded?.totalStepCount).toBe(3);
    expect(loaded?.targetName).toBe("engine-test");
    expect(loaded?.baselineMetrics).toEqual({ latency: 100 });
    expect(loaded?.lastUpdatedAt).toBeGreaterThan(0);
  });

  it("returns null when the session was never initialized", () => {
    const dir = makeDir();
    expect(loadSession(dir)).toBeNull();
  });

  it("treats a corrupt state file as never-initialized: the No-baseline guard fires", async () => {
    const dir = makeDir();
    fs.writeFileSync(path.join(dir, ".perfgym.yaml"), stepConfigYaml, "utf8");
    fs.mkdirSync(path.dirname(stateFilePath(dir)), { recursive: true });
    fs.writeFileSync(stateFilePath(dir), "{ corrupted", "utf8");

    expect(() => loadSession(dir)).not.toThrow();
    // A corrupt file must never impersonate an initialized session — it
    // maps to null, exactly like a missing file, so every
    // "No baseline found" guard still fires.
    expect(loadSession(dir)).toBeNull();
    // The corrupt-file signal is observable without crashing (#46).
    expect(sessionFileOutcome(dir)).toBe("reset-corrupt");

    // runStep against a corrupt state file throws the guard, never evaluates.
    await expect(
      runStep({ cwd: dir, files: ["src/index.ts"], samples: 1 })
    ).rejects.toThrow(/No baseline found in \.perfgym\/state\.json/);
  });

  it("runStep persists bestStep on improvement and mirrors the step into the live blob (F3/F4)", async () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, ".perfgym.yaml"),
      `
version: "1.0"
target:
  name: "step-mirror"
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
`,
      "utf8",
    );
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "// value: 100\nexport let count = 0;\n", "utf8");

    const baseRes = await Effect.runPromise(runBaseline({ cwd: dir, samples: 1 }));
    expect(baseRes.success).toBe(true);

    // The improvement: 100 → 50 (minimize) — an accepted, better step.
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "// value: 50\nexport let count = 1;\n", "utf8");
    const res = await runStep({ cwd: dir, files: ["src/index.ts"], samples: 1 });
    expect(res.success).toBe(true);
    expect(res.evaluation.accepted).toBe(true);

    // F3: the winning iteration is recorded — parity with the coordinator's
    // handleStep path. F4: the step is mirrored into the live blob (the same
    // live-session machinery the coordinator uses), legacy save first, live
    // flush last.
    const state = loadSession(dir);
    expect(state?.bestStep).toBe(1);
    let doc = JSON.parse(fs.readFileSync(stateFilePath(dir), "utf8")) as {
      session?: { history?: Array<{ iteration: number }>; bestStep?: number | null };
    };
    expect(doc.session?.history?.map((entry) => entry.iteration)).toEqual([1]);
    expect(doc.session?.bestStep).toBe(1);

    // Step 2: 50 → 40 (minimize) — accepted step 2. Both iterations must survive in history.
    fs.writeFileSync(path.join(dir, "src", "index.ts"), "// value: 40\nexport let count = 2;\n", "utf8");
    const res2 = await runStep({ cwd: dir, files: ["src/index.ts"], samples: 1 });
    expect(res2.success).toBe(true);
    expect(res2.evaluation.accepted).toBe(true);

    doc = JSON.parse(fs.readFileSync(stateFilePath(dir), "utf8")) as {
      session?: { history?: Array<{ iteration: number }>; bestStep?: number | null };
    };
    expect(doc.session?.history?.map((entry) => entry.iteration)).toEqual([1, 2]);
    expect(doc.session?.bestStep).toBe(2);
  });

  it("overwrites a corrupt state file with a parseable session on the next save", () => {
    const dir = makeDir();
    fs.mkdirSync(path.dirname(stateFilePath(dir)), { recursive: true });
    fs.writeFileSync(stateFilePath(dir), "{ corrupted", "utf8");

    saveSession(dir, fixture({ totalStepCount: 1 }));

    const disk = JSON.parse(fs.readFileSync(stateFilePath(dir), "utf8")) as Record<string, unknown>;
    expect(disk.totalStepCount).toBe(1);
    expect(disk.lastUpdatedAt).toBeGreaterThan(0);
  });

  it("preserves concurrent fields the caller did not change (merge-before-write)", () => {
    const dir = makeDir();
    saveSession(dir, fixture({ totalStepCount: 1 }));

    // A concurrent writer adds a field between this process's load or save.
    const diskNow = JSON.parse(fs.readFileSync(stateFilePath(dir), "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      stateFilePath(dir),
      JSON.stringify({ ...diskNow, rival: "other-process" }, null, 2),
      "utf8",
    );

    saveSession(dir, fixture({ totalStepCount: 5 }));

    const disk = JSON.parse(fs.readFileSync(stateFilePath(dir), "utf8")) as Record<string, unknown>;
    expect(disk.totalStepCount).toBe(5);
    expect(disk.rival).toBe("other-process");
  });

  it("a fresh-session save drops the previous session's heritage from disk (F1)", () => {
    const dir = makeDir();
    fs.mkdirSync(path.dirname(stateFilePath(dir)), { recursive: true });
    fs.writeFileSync(
      stateFilePath(dir),
      JSON.stringify(
        {
          ...fixture({ totalStepCount: 9, bestFitnessScore: 40, acceptedStepCount: 4 }),
          history: [
            {
              stepNumber: 2,
              score: 40,
              status: "ACCEPTED",
              commitHash: "abc123",
              deltaPercent: 25,
              timestamp: 5,
            },
          ],
          bestStep: 2,
          lastCommitHash: "abc123",
          session: {
            runId: "run-old",
            baseRef: "main",
            status: "accepted",
            currentStep: 2,
            baseline: null,
            bestScore: 40,
            bestStep: 2,
            history: [],
            lock: null,
            lastError: null,
            lastUpdatedAt: 9,
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    // A re-baseline (runBaseline) writes a FULLY fresh PerfGymState: the
    // heritage fields and the old blob are absent from memory and must be
    // gone from disk — a dead session must not leak through merge-on-flush.
    saveSession(dir, fixture({ bestFitnessScore: 0, acceptedStepCount: 0, totalStepCount: 0 }));

    const disk = JSON.parse(fs.readFileSync(stateFilePath(dir), "utf8")) as Record<string, unknown>;
    expect(disk.history).toBeUndefined();
    expect(disk.bestStep).toBeUndefined();
    expect(disk.lastCommitHash).toBeUndefined();
    expect(disk.session).toBeUndefined();
    expect(disk.totalStepCount).toBe(0);
  });
});

describe("loadConfig — metrics[].require_checksum strict opt-in (ticket #54)", () => {
  it("maps the snake_case YAML key onto requireChecksum; absent key stays undefined", () => {
    const dir = makeDir();
    fs.writeFileSync(
      path.join(dir, ".perfgym.yaml"),
      `
version: "1.0"
target:
  name: "strict"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "latency"
    command: "node -e 'console.log(1)'"
    goal: "minimize"
    weight: 1
    require_checksum: true
  - name: "throughput"
    command: "node -e 'console.log(1)'"
    goal: "maximize"
    weight: 1
`,
      "utf8"
    );

    const config = loadConfig(dir);
    expect(config.metrics[0]?.requireChecksum).toBe(true);
    // Strict opt-in: a metric without the key is never defaulted into enforcement.
    expect(config.metrics[1]?.requireChecksum).toBeUndefined();
  });
});
