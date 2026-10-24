import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  STATE_PATH,
  loadSession,
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

    // A concurrent writer adds a field between this process's load and save.
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
});
