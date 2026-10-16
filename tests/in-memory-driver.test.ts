import { describe, it, expect, beforeEach } from "vitest";
import { InMemorySandboxDriver } from "../packages/core/src/sandbox/in-memory-driver.js";
import {
  PathOutsideTargetError,
  PathTraversalError,
  FileNotFoundError,
  ERR_PATH_OUTSIDE_TARGET,
  ERR_PATH_TRAVERSAL,
  ERR_FILE_NOT_FOUND,
} from "../packages/core/src/errors.js";

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
    await driver.initialize("run-101", "main");
  });

  it("initializes with isolated virtual context", () => {
    expect(driver.getWorkingDir()).toBe("/virtual/worktrees/run-101");
    expect(driver.getContext().branchName).toBe("perfgym/eval-run-101");
    expect(driver.getContext().baseRef).toBe("main");
  });

  it("reads and checks initial files", async () => {
    expect(await driver.fileExists("src/math.ts")).toBe(true);
    expect(await driver.readFile("src/math.ts")).toBe(
      "export const add = (a: number, b: number) => a + b;"
    );
    expect(await driver.fileExists("src/non-existent.ts")).toBe(false);
  });

  it("throws FileNotFoundError when reading non-existent file", async () => {
    await expect(driver.readFile("src/unknown.ts")).rejects.toThrow(FileNotFoundError);
  });

  it("enforces strict path whitelist and traversal boundaries", async () => {
    // Unauthorized path (outside target glob)
    expect(() => driver.assertPathWhitelisted("package.json")).toThrow(
      PathOutsideTargetError
    );
    await expect(driver.writeFile("package.json", "tampered")).rejects.toThrow(
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
    await expect(driver.writeFile("../secrets.txt", "attack")).rejects.toThrow(
      PathTraversalError
    );
  });

  it("handles default glob **/* correctly without breaking", () => {
    const defaultDriver = new InMemorySandboxDriver();
    expect(() => defaultDriver.assertPathWhitelisted("src/deep/nested/code.ts")).not.toThrow();
  });

  it("executes mutation -> rollback cycle cleanly in <10ms", async () => {
    const t0 = performance.now();

    // Mutate allowed file
    await driver.writeFile(
      "src/math.ts",
      "export const add = (a: number, b: number) => a * b; // Broken"
    );
    expect(await driver.readFile("src/math.ts")).toContain("a * b");

    // Add new file in target boundary
    await driver.writeFile("src/helper.ts", "export const log = () => {};");
    expect(await driver.fileExists("src/helper.ts")).toBe(true);

    // Rollback mutation
    await driver.rollbackStep();

    // Assert restored pristine state
    expect(await driver.readFile("src/math.ts")).toBe(
      "export const add = (a: number, b: number) => a + b;"
    );
    expect(await driver.fileExists("src/helper.ts")).toBe(false);

    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(20);
  });

  it("records commit-per-win and rolls back only to latest commit", async () => {
    // Step 1: Winning mutation
    await driver.writeFile(
      "src/math.ts",
      "export const add = (a: number, b: number) => (a + b) | 0; // Faster"
    );
    const commitHash1 = await driver.commitStep(1, 105.5);
    expect(commitHash1).toMatch(/^sim-[a-f0-9]{8}$/);

    // Step 2: Broken mutation
    await driver.writeFile("src/math.ts", "invalid code");
    await driver.rollbackStep();

    // Should rollback to step 1 state, not initial state
    expect(await driver.readFile("src/math.ts")).toBe(
      "export const add = (a: number, b: number) => (a + b) | 0; // Faster"
    );
  });

  it("promotes to target branch and tears down cleanly", async () => {
    await driver.promote("main");
    expect(driver.getPromotedBranch()).toBe("main");

    await driver.teardown();
    expect(driver.isTornDown()).toBe(true);
  });

  it("handles filenames containing double dots without false traversal detection", async () => {
    await driver.writeFile("src/foo..bar.ts", "export const val = 42;");
    expect(await driver.readFile("src/foo..bar.ts")).toBe("export const val = 42;");
  });

  it("normalizes Map initialFiles keys with backslashes", async () => {
    const mapDriver = new InMemorySandboxDriver({
      allowedGlobs: ["src/**/*"],
      initialFiles: new Map([["src\\custom.ts", "content"]]),
    });
    await mapDriver.initialize("run-map", "main");
    expect(await mapDriver.readFile("src/custom.ts")).toBe("content");
  });

  it("resets file state when re-initialized", async () => {
    await driver.writeFile("src/math.ts", "mutated");
    expect(await driver.readFile("src/math.ts")).toBe("mutated");

    // Re-initialize driver for a new run
    await driver.initialize("run-102", "main");
    expect(await driver.readFile("src/math.ts")).toBe(
      "export const add = (a: number, b: number) => a + b;"
    );
  });
});
