import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Effect } from "effect";
import { GitSandboxCoordinator } from "../packages/core/src/sandbox/coordinator.js";
import { InMemorySandboxDriver } from "../packages/core/src/sandbox/in-memory-driver.js";
import {
  SandboxLockBusyError,
  SandboxLockNotHeldError,
} from "../packages/core/src/errors.js";

const run = Effect.runPromise;

/**
 * Captures the value on the EFFECT FAILURE CHANNEL (ADR-018): `tapError` only
 * fires for typed failures — a defect or a plain rejected promise leaves
 * `captured` undefined.
 */
async function captureFailure<A, E>(effect: Effect.Effect<A, E, never>): Promise<E | undefined> {
  let captured: E | undefined;
  await Effect.runPromiseExit(
    Effect.tapError(effect, (err) =>
      Effect.sync(() => {
        captured = err;
      })
    )
  );
  return captured;
}

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

    const ctx = await run(coordinator.acquire("run-coord-1", "main"));
    expect(ctx.runId).toBe("run-coord-1");
    expect(coordinator.isLocked()).toBe(true);

    // Apply mutation
    await run(
      coordinator.applyMutation([
        { relPath: "src/calc.ts", content: "export const calc = () => 2;\n" },
      ])
    );
    expect(await run(driver.readFile("src/calc.ts"))).toBe("export const calc = () => 2;\n");

    // Reject mutation (rollback)
    await run(coordinator.rejectStep());
    expect(await run(driver.readFile("src/calc.ts"))).toBe("export const calc = () => 1;\n");

    // Re-apply and accept step
    await run(
      coordinator.applyMutation([
        { relPath: "src/calc.ts", content: "export const calc = () => 3;\n" },
      ])
    );
    const receipt = await run(coordinator.acceptStep(1, 120.5));
    expect(receipt.stepNumber).toBe(1);
    expect(receipt.score).toBe(120.5);
    expect(typeof receipt.commitHash).toBe("string");

    // Promote and cleanup
    await run(coordinator.promoteAndCleanup("main"));
    expect(coordinator.isLocked()).toBe(false);
  });

  it("rejects concurrent acquire with SandboxLockBusyError when lock is active", async () => {
    const driver1 = new InMemorySandboxDriver();
    const driver2 = new InMemorySandboxDriver();
    const lockDir = path.join(tempLockDir, ".lock.d");

    const coord1 = new GitSandboxCoordinator(driver1, { lockDir });
    const coord2 = new GitSandboxCoordinator(driver2, { lockDir });

    await run(coord1.acquire("run-1", "main"));

    // Second coordinator should fail to acquire
    await expect(run(coord2.acquire("run-2", "main"))).rejects.toThrow(SandboxLockBusyError);

    await run(coord1.release());
    expect(coord1.isLocked()).toBe(false);

    // Now coord2 can acquire cleanly
    const ctx2 = await run(coord2.acquire("run-2", "main"));
    expect(ctx2.runId).toBe("run-2");
    await run(coord2.release());
  });

  it("returns SandboxLockBusyError on the failure channel when the lock is held", async () => {
    const lockDir = path.join(tempLockDir, ".lock.d");
    const coord1 = new GitSandboxCoordinator(new InMemorySandboxDriver(), { lockDir });
    const coord2 = new GitSandboxCoordinator(new InMemorySandboxDriver(), { lockDir });

    await run(coord1.acquire("run-busy-1", "main"));

    const err = await captureFailure(coord2.acquire("run-busy-2", "main"));
    expect(err).toBeInstanceOf(SandboxLockBusyError);

    await run(coord1.release());
  });

  it("returns SandboxLockNotHeldError on the failure channel when the lock is not held", async () => {
    const driver = new InMemorySandboxDriver({ allowedGlobs: ["src/**/*.ts"] });
    const coordinator = new GitSandboxCoordinator(driver, {
      lockDir: path.join(tempLockDir, ".lock.d"),
    });

    expect(coordinator.isLocked()).toBe(false);

    const applyErr = await captureFailure(
      coordinator.applyMutation([{ relPath: "src/a.ts", content: "x" }])
    );
    expect(applyErr).toBeInstanceOf(SandboxLockNotHeldError);
    expect((applyErr as SandboxLockNotHeldError).operation).toBe("applyMutation");

    expect(await captureFailure(coordinator.verifyBlastRadius())).toBeInstanceOf(
      SandboxLockNotHeldError
    );
    expect(await captureFailure(coordinator.acceptStep(1, 1.0))).toBeInstanceOf(
      SandboxLockNotHeldError
    );
    expect(await captureFailure(coordinator.rejectStep())).toBeInstanceOf(
      SandboxLockNotHeldError
    );
    expect(await captureFailure(coordinator.promoteAndCleanup("main"))).toBeInstanceOf(
      SandboxLockNotHeldError
    );
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
    const ctx = await run(coord.acquire("new-live-run", "main"));
    expect(ctx.runId).toBe("new-live-run");
    expect(coord.isLocked()).toBe(true);

    await run(coord.release());
  });
});
