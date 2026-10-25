import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effect } from "effect";
import type { WorkspaceDriver, WorkspaceContext } from "../packages/core/src/sandbox/driver.js";
import { InMemorySandboxDriver } from "../packages/core/src/sandbox/in-memory-driver.js";
import { GitSandboxCoordinator } from "../packages/core/src/sandbox/coordinator.js";
import {
  PathOutsideTargetError,
  ERR_PATH_OUTSIDE_TARGET,
  ERR_PATH_TRAVERSAL,
  type PerfGymDomainError,
} from "../packages/core/src/errors.js";

const SANDBOX_DIR = new URL("../packages/core/src/sandbox/", import.meta.url);

function readSandboxSource(file: string): string {
  return fs.readFileSync(new URL(file, SANDBOX_DIR), "utf8");
}

/**
 * Removes every `assertPathWhitelisted(...) { ... }` method body (ADR-018's
 * single permitted synchronous tagged throw) so a scan can assert that no
 * OTHER `throw` remains anywhere in the sandbox seam.
 */
function stripSyncAssert(source: string): string {
  const marker = "assertPathWhitelisted(relPath: string): void {";
  let out = source;
  let idx = out.indexOf(marker);
  while (idx !== -1) {
    const braceStart = idx + marker.length - 1;
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < out.length; i++) {
      const ch = out[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out = out.slice(0, idx) + (end === -1 ? out.slice(braceStart) : out.slice(end + 1));
    idx = out.indexOf(marker);
  }
  return out;
}

describe("WorkspaceDriver Contract & Seam", () => {
  it("enforces WorkspaceDriver interface structure and types", () => {
    // Dummy implementation to test interface conformance at runtime & compile time.
    // ADR-018: every async operation returns an Effect (typed error channel).
    class TestDriver implements WorkspaceDriver {
      private ctx: WorkspaceContext | null = null;
      public allowedGlobs: string[] = ["src/**/*.ts"];

      initialize(runId: string, baseRef: string): Effect.Effect<WorkspaceContext, PerfGymDomainError, never> {
        return Effect.sync(() => {
          this.ctx = {
            runId,
            workingDir: `/tmp/worktrees/${runId}`,
            branchName: `perfgym/eval-${runId}`,
            baseRef,
          };
          return this.ctx;
        });
      }

      writeFile(relPath: string, _content: string): Effect.Effect<void, PerfGymDomainError, never> {
        return Effect.sync(() => {
          this.assertPathWhitelisted(relPath);
        });
      }

      readFile(relPath: string): Effect.Effect<string, PerfGymDomainError, never> {
        return Effect.sync(() => {
          this.assertPathWhitelisted(relPath);
          return "content";
        });
      }

      fileExists(relPath: string): Effect.Effect<boolean, PerfGymDomainError, never> {
        return Effect.sync(() => {
          this.assertPathWhitelisted(relPath);
          return true;
        });
      }

      assertPathWhitelisted(relPath: string): void {
        if (!this.allowedGlobs.some((g) => relPath.startsWith("src/"))) {
          throw new PathOutsideTargetError({
            code: ERR_PATH_OUTSIDE_TARGET,
            relPath,
            allowedGlobs: this.allowedGlobs,
            message: `File path '${relPath}' is outside the target mutation boundary.`,
          });
        }
      }

      verifyBlastRadius(): Effect.Effect<void, PerfGymDomainError, never> {
        return Effect.sync(() => undefined);
      }

      commitStep(stepNumber: number, fitnessScore: number): Effect.Effect<string, PerfGymDomainError, never> {
        return Effect.succeed(`commit-hash-${stepNumber}-${fitnessScore}`);
      }

      rollbackStep(): Effect.Effect<void, PerfGymDomainError, never> {
        return Effect.sync(() => undefined);
      }

      promote(_targetBranch: string): Effect.Effect<void, PerfGymDomainError, never> {
        return Effect.sync(() => undefined);
      }

      teardown(): Effect.Effect<void, PerfGymDomainError, never> {
        return Effect.sync(() => undefined);
      }

      getWorkingDir(): string {
        return this.ctx?.workingDir ?? "";
      }
    }

    const driver = new TestDriver();
    expect(driver).toBeDefined();
    expect(typeof driver.initialize).toBe("function");
    expect(typeof driver.writeFile).toBe("function");
    expect(typeof driver.readFile).toBe("function");
    expect(typeof driver.fileExists).toBe("function");
    expect(typeof driver.assertPathWhitelisted).toBe("function");
    expect(typeof driver.commitStep).toBe("function");
    expect(typeof driver.rollbackStep).toBe("function");
    expect(typeof driver.promote).toBe("function");
    expect(typeof driver.teardown).toBe("function");
    expect(typeof driver.getWorkingDir).toBe("function");

    // The async surface is Effect-valued (never a Promise).
    expect(Effect.isEffect(driver.initialize("run-c", "main"))).toBe(true);
    expect(Effect.isEffect(driver.writeFile("src/a.ts", "x"))).toBe(true);
    expect(Effect.isEffect(driver.readFile("src/a.ts"))).toBe(true);
    expect(Effect.isEffect(driver.fileExists("src/a.ts"))).toBe(true);
    expect(Effect.isEffect(driver.verifyBlastRadius())).toBe(true);
    expect(Effect.isEffect(driver.commitStep(1, 100))).toBe(true);
    expect(Effect.isEffect(driver.rollbackStep())).toBe(true);
    expect(Effect.isEffect(driver.promote("main"))).toBe(true);
    expect(Effect.isEffect(driver.teardown())).toBe(true);
  });

  it("InMemorySandboxDriver returns Effects for every async operation (ADR-018)", () => {
    const driver = new InMemorySandboxDriver({ allowedGlobs: ["src/**/*.ts"] });

    expect(Effect.isEffect(driver.initialize("run-101", "main"))).toBe(true);
    expect(Effect.isEffect(driver.writeFile("src/math.ts", "1"))).toBe(true);
    expect(Effect.isEffect(driver.readFile("src/math.ts"))).toBe(true);
    expect(Effect.isEffect(driver.fileExists("src/math.ts"))).toBe(true);
    expect(Effect.isEffect(driver.verifyBlastRadius())).toBe(true);
    expect(Effect.isEffect(driver.commitStep(1, 100))).toBe(true);
    expect(Effect.isEffect(driver.rollbackStep())).toBe(true);
    expect(Effect.isEffect(driver.promote("main"))).toBe(true);
    expect(Effect.isEffect(driver.teardown())).toBe(true);
  });

  it("GitSandboxCoordinator returns Effects for every operation (ADR-018)", () => {
    const coordinator = new GitSandboxCoordinator(new InMemorySandboxDriver(), {
      lockDir: path.join(os.tmpdir(), `perfgym-contract-${Date.now()}`, ".lock.d"),
    });

    expect(Effect.isEffect(coordinator.acquire("run-c", "main"))).toBe(true);
    expect(Effect.isEffect(coordinator.applyMutation([]))).toBe(true);
    expect(Effect.isEffect(coordinator.verifyBlastRadius())).toBe(true);
    expect(Effect.isEffect(coordinator.acceptStep(1, 100))).toBe(true);
    expect(Effect.isEffect(coordinator.rejectStep())).toBe(true);
    expect(Effect.isEffect(coordinator.promoteAndCleanup("main"))).toBe(true);
    expect(Effect.isEffect(coordinator.release())).toBe(true);
  });

  it("driver.ts declares only Effect-returning signatures (no Promise)", () => {
    const source = readSandboxSource("driver.ts");
    expect(source).not.toMatch(/: *Promise</);
    expect(source).toMatch(/Effect\.Effect<WorkspaceContext, PerfGymDomainError, never>/);
  });

  it("no throw remains in the sandbox seam except the synchronous assertPathWhitelisted", () => {
    const files = [
      "driver.ts",
      "git-worktree-driver.ts",
      "in-memory-driver.ts",
      "coordinator.ts",
    ];
    for (const file of files) {
      const stripped = stripSyncAssert(readSandboxSource(file));
      expect(
        /\bthrow\b/.test(stripped),
        `${file} still contains a throw outside assertPathWhitelisted`
      ).toBe(false);
    }
  });

  it("assertPathWhitelisted throws PathOutsideTargetError for unauthorized paths", () => {
    expect(ERR_PATH_OUTSIDE_TARGET).toBe("ERR_PATH_OUTSIDE_TARGET");
    expect(ERR_PATH_TRAVERSAL).toBe("ERR_PATH_TRAVERSAL");

    const error = new PathOutsideTargetError({
      code: ERR_PATH_OUTSIDE_TARGET,
      relPath: "package.json",
      allowedGlobs: ["src/**/*.ts"],
      message: "Path outside target boundary",
    });

    expect(error._tag).toBe("PathOutsideTargetError");
    expect(error.code).toBe(ERR_PATH_OUTSIDE_TARGET);
    expect(error.relPath).toBe("package.json");
    expect(error.allowedGlobs).toEqual(["src/**/*.ts"]);
  });
});
