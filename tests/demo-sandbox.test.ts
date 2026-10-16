import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { DemoSandbox } from "../demo/sandbox-api.js";

/**
 * Demo UI backend contract tests.
 *
 * These tests exercise the exact API surface the demo web UI calls, so the
 * interactive sandbox lab is verified end-to-end (minus HTTP) before the
 * server and HTML are wired on top.
 */
describe("DemoSandbox (demo UI backend)", () => {
  let demo: DemoSandbox;
  let repoDir: string;

  beforeEach(async () => {
    repoDir = `.tmp/demo-repo-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    demo = new DemoSandbox({ repoDir });
    await demo.init();
  });

  afterEach(async () => {
    try {
      await demo.dispose();
    } catch {
      // ignore teardown races
    }
    // Remove the throwaway demo repo so vitest never picks up fixture files
    try {
      fs.rmSync(repoDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup races
    }
  });

  it("initializes a locked sandbox with a worktree context", async () => {
    const state = await demo.state();
    expect(state.initialized).toBe(true);
    expect(state.locked).toBe(true);
    expect(state.context?.branchName).toContain("perfgym/eval-");
    expect(state.context?.workingDir).toBeTruthy();
    expect(state.gitStatus).toEqual([]); // pristine worktree
    expect(state.gitLog.length).toBeGreaterThanOrEqual(1);
    expect(state.branches).toContain("main");
  });

  it("allows whitelisted writes and commits them via accept", async () => {
    await demo.write("src/index.ts", "export const baseline = 105;\n");
    await demo.verify();
    const receipt = await demo.accept(1, 8.5);
    expect(receipt.commitHash).toMatch(/^[0-9a-f]{7,40}$/);
    expect(await demo.readFile("src/index.ts")).toBe("export const baseline = 105;\n");
  });

  it("blocks writes outside the allowed whitelist", async () => {
    await expect(demo.write("package.json", "evil")).rejects.toMatchObject({
      _tag: "PathOutsideTargetError",
      code: "ERR_PATH_OUTSIDE_TARGET",
    });
  });

  it("blocks path traversal writes", async () => {
    await expect(demo.write("../../escape.txt", "evil")).rejects.toMatchObject({
      _tag: "PathTraversalError",
      code: "ERR_PATH_TRAVERSAL",
    });
  });

  it("detects raw shell writes outside the whitelist via verifyBlastRadius", async () => {
    await demo.rawWrite("package.json", '{"name":"hacked"}\n');
    await expect(demo.verify()).rejects.toMatchObject({
      _tag: "PathOutsideTargetError",
    });
    await expect(demo.accept(2, 9)).rejects.toMatchObject({
      _tag: "PathOutsideTargetError",
    });
    await demo.reject();
    await demo.verify(); // clean again after rollback
    expect(await demo.readFile("package.json")).toBe('{"name":"perfgym-demo-repo"}\n');
  });

  it("detects untracked files dropped outside the whitelist", async () => {
    await demo.rawWrite("loot.txt", "stolen\n");
    await expect(demo.verify()).rejects.toMatchObject({
      _tag: "PathOutsideTargetError",
    });
    await demo.reject();
    await demo.verify();
  });

  it("rollback restores the previous committed state", async () => {
    const before = await demo.readFile("src/util.ts");
    await demo.write("src/util.ts", "export const util = 999;\n");
    expect(await demo.readFile("src/util.ts")).toBe("export const util = 999;\n");
    await demo.reject();
    expect(await demo.readFile("src/util.ts")).toBe(before);
  });

  it("blocks symlink escape writes", async () => {
    try {
      await demo.symlink("src/escape-link");
    } catch {
      // EPERM: Windows without Developer Mode — scenario not reproducible here
      return;
    }
    await expect(demo.write("src/escape-link", "pwned")).rejects.toMatchObject({
      _tag: "PathTraversalError",
      code: "ERR_PATH_TRAVERSAL",
    });
  });

  it("holds an exclusive lock against a competing coordinator", async () => {
    await expect(demo.attemptCompetingAcquire()).rejects.toMatchObject({
      _tag: "SandboxLockBusyError",
    });
  });

  it(
    "runs the full adversarial suite with every scenario passing",
    async () => {
      const results = await demo.runSuite();
      expect(results.length).toBeGreaterThanOrEqual(10);
      const failed = results
        .filter((r) => r.status === "fail")
        .map((r) => `${r.id}: [${r.expected}] ${r.detail}`);
      expect(failed).toEqual([]);
    },
    180_000
  );
});
