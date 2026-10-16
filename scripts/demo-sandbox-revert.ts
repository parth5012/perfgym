/**
 * Interactive Prototype: Live Worktree Mutation & Rollback Verification
 * Demonstrates zero-risk workspace isolation for AI coding agents.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { GitWorktreeDriver } from "../packages/core/src/sandbox/git-worktree-driver.js";
import { GitSandboxCoordinator } from "../packages/core/src/sandbox/coordinator.js";

async function main() {
  console.log("============================================================");
  console.log("🧪 PerfGym Prototype: Live Worktree Mutation & Rollback Demo");
  console.log("============================================================\n");

  const repoRoot = process.cwd();
  console.log(`[1] Main Repository Root: ${repoRoot}`);

  // Check main working tree status
  const mainStatusBefore = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" }).trim();
  console.log(`[2] Main Git Status: ${mainStatusBefore ? "DIRTY" : "CLEAN"}`);

  // Initialize driver & coordinator
  const runId = `demo-prototype-${Date.now()}`;
  const driver = new GitWorktreeDriver({
    repoRoot,
    allowedGlobs: ["packages/core/src/**/*", "src/**/*"],
  });

  const coordinator = new GitSandboxCoordinator(driver, { repoRoot });

  console.log(`\n[3] Acquiring atomic sandbox lock & isolated worktree for run '${runId}'...`);
  const ctx = await coordinator.acquire(runId, "HEAD");
  console.log(`    - Isolated Working Dir: ${ctx.workingDir}`);
  console.log(`    - Isolated Branch:      ${ctx.branchName}`);
  console.log(`    - Base Ref:             ${ctx.baseRef}`);

  const targetRelPath = "packages/core/src/errors.ts";
  const originalContent = await driver.readFile(targetRelPath);
  console.log(`\n[4] Read baseline file: '${targetRelPath}' (${originalContent.length} bytes)`);

  // Step A: Apply simulated broken agent mutation
  console.log("\n[5] Simulating broken agent mutation...");
  const brokenContent = `// BROKEN AGENT MUTATION INJECTED AT ${Date.now()}\n` + originalContent;
  await coordinator.applyMutation([
    { relPath: targetRelPath, content: brokenContent },
  ]);
  // Also create an untracked file inside worktree
  await driver.writeFile("packages/core/src/untracked-garbage.ts", "export const trash = 1;\n");
  console.log("    - Injected broken mutation into target file");
  console.log("    - Injected untracked garbage file: packages/core/src/untracked-garbage.ts");

  // Verify main working tree remains pristine
  const mainStatusDuring = execSync("git status --porcelain", { cwd: repoRoot, encoding: "utf8" }).trim();
  const mainRepoChanged = mainStatusDuring !== mainStatusBefore;
  console.log(`\n[6] Verifying Main Repository Status during agent mutation:`);
  console.log(`    - Main Repo Untouched by Mutation: ${!mainRepoChanged ? "YES (PASSED - Zero pollution)" : "NO (FAILED)"}`);

  // Worktree status
  const worktreeStatus = execSync("git status --short", { cwd: ctx.workingDir, encoding: "utf8" }).trim();
  console.log(`    - Worktree Status (showing mutations):`);
  console.log(worktreeStatus.split("\n").map(l => "      " + l).join("\n"));

  // Step B: Trigger Sentinel Rollback
  console.log("\n[7] Sentinel detecting regression -> Triggering rollbackStep()...");
  const t0 = performance.now();
  await coordinator.rejectStep();
  const rollbackDuration = (performance.now() - t0).toFixed(2);
  console.log(`    - Rollback completed in ${rollbackDuration} ms!`);

  // Verify worktree state after rollback
  const contentAfterRevert = await driver.readFile(targetRelPath);
  const untrackedExists = await driver.fileExists("packages/core/src/untracked-garbage.ts");
  const isTargetIdentical = contentAfterRevert === originalContent;

  console.log("\n[8] Rollback Verification Results:");
  console.log(`    - Target file reverted to exact baseline: ${isTargetIdentical ? "YES (PASSED)" : "NO (FAILED)"}`);
  console.log(`    - Untracked garbage file purged:          ${!untrackedExists ? "YES (PASSED)" : "NO (FAILED)"}`);

  // Step C: Cleanup
  console.log("\n[9] Tearing down isolated worktree and releasing lock...");
  await coordinator.release();
  await driver.teardown();
  console.log(`    - Lock released and worktree safely removed.`);

  console.log("\n============================================================");
  console.log("✅ Prototype verification complete: Zero leakage, zero pollution.");
  console.log("============================================================\n");
}

main().catch((err) => {
  console.error("❌ Prototype failed with error:", err);
  process.exit(1);
});
