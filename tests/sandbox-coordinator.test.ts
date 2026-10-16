import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { GitSandboxCoordinator } from "../packages/core/src/sandbox/coordinator.js";
import { InMemorySandboxDriver } from "../packages/core/src/sandbox/in-memory-driver.js";
import { SandboxLockBusyError } from "../packages/core/src/errors.js";

describe("GitSandboxCoordinator Deep Module", () => {
  let tempLockDir: string;

  beforeEach(() => {
    tempLockDir = fs.mkdtempSync(path.join(os.tmpdir(), "perfgym-coord-lock-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempLockDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it("acquires workspace, applies mutations, accepts and rejects steps cleanly", async () => {
    const driver = new InMemorySandboxDriver({
      allowedGlobs: ["src/**/*.ts"],
      initialFiles: {
        "src/calc.ts": "export const calc = () => 1;\n",
      },
    });

    const coordinator = new GitSandboxCoordinator(driver, {
      lockDir: path.join(tempLockDir, ".lock.d"),
    });

    const ctx = await coordinator.acquire("run-coord-1", "main");
    expect(ctx.runId).toBe("run-coord-1");
    expect(coordinator.isLocked()).toBe(true);

    // Apply mutation
    await coordinator.applyMutation([
      { relPath: "src/calc.ts", content: "export const calc = () => 2;\n" },
    ]);
    expect(await driver.readFile("src/calc.ts")).toBe("export const calc = () => 2;\n");

    // Reject mutation (rollback)
    await coordinator.rejectStep();
    expect(await driver.readFile("src/calc.ts")).toBe("export const calc = () => 1;\n");

    // Re-apply and accept step
    await coordinator.applyMutation([
      { relPath: "src/calc.ts", content: "export const calc = () => 3;\n" },
    ]);
    const receipt = await coordinator.acceptStep(1, 120.5);
    expect(receipt.stepNumber).toBe(1);
    expect(receipt.score).toBe(120.5);
    expect(typeof receipt.commitHash).toBe("string");

    // Promote and cleanup
    await coordinator.promoteAndCleanup("main");
    expect(coordinator.isLocked()).toBe(false);
  });

  it("rejects concurrent acquire with SandboxLockBusyError when lock is active", async () => {
    const driver1 = new InMemorySandboxDriver();
    const driver2 = new InMemorySandboxDriver();
    const lockDir = path.join(tempLockDir, ".lock.d");

    const coord1 = new GitSandboxCoordinator(driver1, { lockDir });
    const coord2 = new GitSandboxCoordinator(driver2, { lockDir });

    await coord1.acquire("run-1", "main");

    // Second coordinator should fail to acquire
    await expect(coord2.acquire("run-2", "main")).rejects.toThrow(SandboxLockBusyError);

    await coord1.release();
    expect(coord1.isLocked()).toBe(false);

    // Now coord2 can acquire cleanly
    const ctx2 = await coord2.acquire("run-2", "main");
    expect(ctx2.runId).toBe("run-2");
    await coord2.release();
  });

  it("detects stale lock with dead PID and automatically reclaims lock", async () => {
    const lockDir = path.join(tempLockDir, ".lock.d");
    fs.mkdirSync(lockDir, { recursive: true });

    // Simulate an abandoned lockfile from an old killed process (PID 99999999)
    const deadLockInfo = {
      pid: 99999999, // Unlikely to exist
      runId: "dead-run",
      startTime: Date.now() - 60_000,
      heartbeat: Date.now() - 40_000,
    };
    fs.writeFileSync(
      path.join(lockDir, "metadata.json"),
      JSON.stringify(deadLockInfo),
      "utf8"
    );

    const driver = new InMemorySandboxDriver();
    const coord = new GitSandboxCoordinator(driver, {
      lockDir,
      staleThresholdMs: 30_000,
    });

    // Acquire should detect dead PID, reclaim, and succeed
    const ctx = await coord.acquire("new-live-run", "main");
    expect(ctx.runId).toBe("new-live-run");
    expect(coord.isLocked()).toBe(true);

    await coord.release();
  });
});
