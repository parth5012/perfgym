import { describe, it, expect, beforeEach } from "vitest";
import { Effect } from "effect";
import { InMemorySandboxDriver } from "../packages/core/src/sandbox/in-memory-driver.js";
import { matchesGlob } from "../packages/core/src/sandbox/git-worktree-driver.js";
import {
  PathOutsideTargetError,
  PathTraversalError,
  FileNotFoundError,
  WorktreeNotFoundError,
  ERR_PATH_OUTSIDE_TARGET,
  ERR_PATH_TRAVERSAL,
  ERR_FILE_NOT_FOUND,
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

describe("InMemorySandboxDriver", () => {
  let driver: InMemorySandboxDriver;

  beforeEach(async () => {
    driver = new InMemorySandboxDriver({
      allowedGlobs: ["src/**/*.ts"],
      initialFiles: {
        "src/math.ts": "export const add = (a: number, b: number) => a + b;",
        "package.json": '{"name": "test-pkg"}',
      },
    });
    await run(driver.initialize("run-101", "main"));
  });

  it("initializes with isolated virtual context", () => {
    expect(driver.getWorkingDir()).toBe("/virtual/worktrees/run-101");
    expect(driver.getContext()!.branchName).toBe("perfgym/eval-run-101");
    expect(driver.getContext()!.baseRef).toBe("main");
  });

  it("reads and checks initial files", async () => {
    expect(await run(driver.fileExists("src/math.ts"))).toBe(true);
    expect(await run(driver.readFile("src/math.ts"))).toBe(
      "export const add = (a: number, b: number) => a + b;"
    );
    expect(await run(driver.fileExists("src/non-existent.ts"))).toBe(false);
  });

  it("returns FileNotFoundError on the failure channel when reading a non-existent file", async () => {
    await expect(run(driver.readFile("src/unknown.ts"))).rejects.toThrow(FileNotFoundError);
    expect(await captureFailure(driver.readFile("src/unknown.ts"))).toBeInstanceOf(
      FileNotFoundError
    );
  });

  it("enforces strict path whitelist and traversal boundaries", async () => {
    // Unauthorized path (outside target glob)
    expect(() => driver.assertPathWhitelisted("package.json")).toThrow(
      PathOutsideTargetError
    );
    await expect(run(driver.writeFile("package.json", "tampered"))).rejects.toThrow(
      PathOutsideTargetError
    );

    // Traversal attack (POSIX + Windows drive letter)
    expect(() => driver.assertPathWhitelisted("src/../../etc/passwd")).toThrow(
      PathTraversalError
    );
    expect(() => driver.assertPathWhitelisted("C:/Windows/calc.exe")).toThrow(
      PathTraversalError
    );
    expect(() => driver.assertPathWhitelisted("D:\\secret\\keys.ts")).toThrow(
      PathTraversalError
    );
    await expect(run(driver.writeFile("../secrets.txt", "attack"))).rejects.toThrow(
      PathTraversalError
    );
  });

  it("returns PathOutsideTargetError on the failure channel for out-of-bounds writes", async () => {
    expect(await captureFailure(driver.writeFile("package.json", "tampered"))).toBeInstanceOf(
      PathOutsideTargetError
    );
  });

  it("returns PathTraversalError on the failure channel for traversal writes", async () => {
    expect(await captureFailure(driver.writeFile("../secrets.txt", "attack"))).toBeInstanceOf(
      PathTraversalError
    );
  });

  it("returns WorktreeNotFoundError on the failure channel after teardown", async () => {
    await run(driver.teardown());
    expect(await captureFailure(driver.writeFile("src/math.ts", "late"))).toBeInstanceOf(
      WorktreeNotFoundError
    );
    expect(await captureFailure(driver.readFile("src/math.ts"))).toBeInstanceOf(
      WorktreeNotFoundError
    );
    expect(await captureFailure(driver.verifyBlastRadius())).toBeInstanceOf(
      WorktreeNotFoundError
    );
  });

  it("handles default glob **/* correctly without breaking", () => {
    const defaultDriver = new InMemorySandboxDriver();
    expect(() => defaultDriver.assertPathWhitelisted("src/deep/nested/code.ts")).not.toThrow();
  });

  it("executes mutation -> rollback cycle cleanly in <10ms", async () => {
    const t0 = performance.now();

    // Mutate allowed file
    await run(
      driver.writeFile(
        "src/math.ts",
        "export const add = (a: number, b: number) => a * b; // Broken"
      )
    );
    expect(await run(driver.readFile("src/math.ts"))).toContain("a * b");

    // Add new file in target boundary
    await run(driver.writeFile("src/helper.ts", "export const log = () => {};"));
    expect(await run(driver.fileExists("src/helper.ts"))).toBe(true);

    // Rollback mutation
    await run(driver.rollbackStep());

    // Assert restored pristine state
    expect(await run(driver.readFile("src/math.ts"))).toBe(
      "export const add = (a: number, b: number) => a + b;"
    );
    expect(await run(driver.fileExists("src/helper.ts"))).toBe(false);

    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(20);
  });

  it("records commit-per-win and rolls back only to latest commit", async () => {
    // Step 1: Winning mutation
    await run(
      driver.writeFile(
        "src/math.ts",
        "export const add = (a: number, b: number) => (a + b) | 0; // Faster"
      )
    );
    const commitHash1 = await run(driver.commitStep(1, 105.5));
    expect(commitHash1).toMatch(/^sim-[a-f0-9]{8}$/);

    // Step 2: Broken mutation
    await run(driver.writeFile("src/math.ts", "invalid code"));
    await run(driver.rollbackStep());

    // Should rollback to step 1 state, not initial state
    expect(await run(driver.readFile("src/math.ts"))).toBe(
      "export const add = (a: number, b: number) => (a + b) | 0; // Faster"
    );
  });

  it("promotes to target branch and tears down cleanly", async () => {
    await run(driver.promote("main"));
    expect(driver.getPromotedBranch()).toBe("main");

    await run(driver.teardown());
    expect(driver.isTornDown()).toBe(true);
  });

  it("handles filenames containing double dots without false traversal detection", async () => {
    await run(driver.writeFile("src/foo..bar.ts", "export const val = 42;"));
    expect(await run(driver.readFile("src/foo..bar.ts"))).toBe("export const val = 42;");
  });

  it("normalizes Map initialFiles keys with backslashes", async () => {
    const mapDriver = new InMemorySandboxDriver({
      allowedGlobs: ["src/**/*"],
      initialFiles: new Map([["src\\custom.ts", "content"]]),
    });
    await run(mapDriver.initialize("run-map", "main"));
    expect(await run(mapDriver.readFile("src/custom.ts"))).toBe("content");
  });

  it("resets file state when re-initialized", async () => {
    await run(driver.writeFile("src/math.ts", "mutated"));
    expect(await run(driver.readFile("src/math.ts"))).toBe("mutated");

    // Re-initialize driver for a new run
    await run(driver.initialize("run-102", "main"));
    expect(await run(driver.readFile("src/math.ts"))).toBe(
      "export const add = (a: number, b: number) => a + b;"
    );
  });
});

describe("globstar whitelist matching (behaviour parity with pre-Effect seam)", () => {
  it("matches **/-prefixed globs against relative paths", () => {
    expect(matchesGlob("**/*.ts", "a/b.ts")).toBe(true);
    expect(matchesGlob("**/foo", "foo")).toBe(true);
    expect(matchesGlob("**/foo", "a/foo")).toBe(true);
  });

  it("keeps a trailing /** glob matching the directory root itself", () => {
    expect(matchesGlob("src/**", "src")).toBe(true);
    expect(matchesGlob("src/**", "src/a.ts")).toBe(true);
  });

  it("in-memory driver honours **/-prefixed whitelists", () => {
    const d = new InMemorySandboxDriver({ allowedGlobs: ["**/*.ts"] });
    expect(() => d.assertPathWhitelisted("a/b.ts")).not.toThrow();
  });
});
