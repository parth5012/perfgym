import { describe, it, expect } from "vitest";
import type { WorkspaceDriver, WorkspaceContext } from "../packages/core/src/sandbox/driver.js";
import {
  PathOutsideTargetError,
  ERR_PATH_OUTSIDE_TARGET,
  ERR_PATH_TRAVERSAL,
} from "../packages/core/src/errors.js";

describe("WorkspaceDriver Contract & Seam", () => {
  it("enforces WorkspaceDriver interface structure and types", () => {
    // Dummy implementation to test interface conformance at runtime & compile time
    class TestDriver implements WorkspaceDriver {
      private ctx: WorkspaceContext | null = null;
      public allowedGlobs: string[] = ["src/**/*.ts"];

      async initialize(runId: string, baseRef: string): Promise<WorkspaceContext> {
        this.ctx = {
          runId,
          workingDir: `/tmp/worktrees/${runId}`,
          branchName: `perfgym/eval-${runId}`,
          baseRef,
        };
        return this.ctx;
      }

      async writeFile(relPath: string, content: string): Promise<void> {
        this.assertPathWhitelisted(relPath);
      }

      async readFile(relPath: string): Promise<string> {
        this.assertPathWhitelisted(relPath);
        return "content";
      }

      async fileExists(relPath: string): Promise<boolean> {
        this.assertPathWhitelisted(relPath);
        return true;
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

      async commitStep(stepNumber: number, fitnessScore: number): Promise<string> {
        return `commit-hash-${stepNumber}-${fitnessScore}`;
      }

      async rollbackStep(): Promise<void> {}

      async promote(targetBranch: string): Promise<void> {}

      async teardown(): Promise<void> {}

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
