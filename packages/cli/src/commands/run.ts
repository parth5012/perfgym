/**
 * @perfgym/cli
 * Dual-Mode Autonomous Hill-Climbing Loop (`perfgym run` - Ticket #20)
 *
 * Runs continuous hill-climbing iterations in an isolated Git worktree:
 * - Direct mutation generators (e.g. LLM provider integration) or mock generators
 * - Step evaluation via EvaluationPipeline
 * - Commit-per-win and atomic rollback on regression or invariant/linter failure
 * - Plateau early termination after consecutive rejections
 * - Auto-promotion of the winning worktree state to the target branch
 */

import chalk from "chalk";
import {
  EvaluationPipeline,
  GitSandboxCoordinator,
  GitWorktreeDriver,
  type MutationFile,
  type StepEvaluation,
  type WorkspaceContext,
  synthesizeGradientFeedback,
} from "../../../core/src/index.js";
import { AstLinterEngine, DEFAULT_RULES, TypecheckGate } from "../../../linter/src/index.js";
import { loadConfig, readState, writeState, runBaseline, type PerfGymState } from "../engine.js";

export interface MutationContext {
  iteration: number;
  bestFitnessScore: number;
  lastFeedback?: string;
  targetFiles: string[];
  workingDir: string;
}

export type MutationGenerator = (context: MutationContext) => Promise<MutationFile[]>;

export interface RunLoopOptions {
  cwd?: string;
  targetBranch?: string;
  maxIterations?: number;
  model?: string;
  generator?: MutationGenerator;
  samples?: number;
  minSignificanceDelta?: number;
  plateauThreshold?: number;
  quiet?: boolean;
}

export interface RunLoopResult {
  totalIterations: number;
  acceptedCount: number;
  bestFitnessScore: number;
  promoted: boolean;
  stoppedReason: string;
  evaluations: StepEvaluation[];
}

export async function runOptimizationLoop(options: RunLoopOptions = {}): Promise<RunLoopResult> {
  const cwd = options.cwd ?? process.cwd();
  const maxIterations = options.maxIterations ?? 15;
  const targetBranch = options.targetBranch ?? "main";
  const plateauThreshold = options.plateauThreshold ?? 3;
  const samples = options.samples ?? 5;
  const minSignificanceDelta = options.minSignificanceDelta ?? 2.5;

  const log = (msg: string) => {
    if (!options.quiet) {
      console.log(msg);
    }
  };

  const config = loadConfig(cwd);
  let state = readState(cwd);

  if (!state) {
    log(chalk.blue("📊 Establishing initial baseline before optimization loop..."));
    const baseRes = await runBaseline({ cwd, samples });
    if (!baseRes.success) {
      throw new Error(`Failed to establish baseline: ${baseRes.error}`);
    }
    state = baseRes.state;
  }

  // Worktree driver & sandbox coordinator
  const worktreeDriver = new GitWorktreeDriver({
    repoRoot: cwd,
    allowedGlobs: config.target.files,
  });

  const coordinator = new GitSandboxCoordinator(worktreeDriver, {
    repoRoot: cwd,
  });

  const runId = `run-${Date.now()}`;
  const workspaceContext = await coordinator.acquire(runId, targetBranch);
  const sandboxDir = workspaceContext.workingDir;

  const linter = new AstLinterEngine(DEFAULT_RULES, sandboxDir);
  const typechecker = new TypecheckGate(sandboxDir);
  const pipeline = new EvaluationPipeline(config, linter, typechecker);

  let bestFitness = state.bestFitnessScore ?? 0;
  let acceptedCount = 0;
  let consecutiveRejections = 0;
  let lastFeedback: string | undefined;
  let stoppedReason = "Completed maximum iterations";
  const evaluations: StepEvaluation[] = [];

  log(chalk.bold.cyan(`\n🚀 Starting PerfGym Autonomous Optimization Loop (${maxIterations} iterations)`));
  log(chalk.dim(`   Sandbox worktree: ${sandboxDir}`));
  log(chalk.dim(`   Target: ${config.target.name} (${config.target.language}) | Baseline Score: ${bestFitness}\n`));

  try {
    for (let i = 1; i <= maxIterations; i++) {
      log(chalk.bold.blue(`▶ Iteration ${i}/${maxIterations}:`));

      let mutatedFiles: MutationFile[] = [];

      if (options.generator) {
        mutatedFiles = await options.generator({
          iteration: i,
          bestFitnessScore: bestFitness,
          lastFeedback,
          targetFiles: config.target.files,
          workingDir: sandboxDir,
        });
      } else {
        // External loop or default fallback message
        log(chalk.yellow("  No mutation generator configured; waiting for external mutations."));
        break;
      }

      if (mutatedFiles.length === 0) {
        log(chalk.yellow("  No files mutated this round. Skipping."));
        consecutiveRejections++;
        if (consecutiveRejections >= plateauThreshold) {
          stoppedReason = `Plateau reached (${consecutiveRejections} consecutive rejections)`;
          break;
        }
        continue;
      }

      // Apply mutations through coordinator
      await coordinator.applyMutation(mutatedFiles);

      const modifiedRelativePaths = mutatedFiles.map((m) => m.relPath);

      // Evaluate step
      const stepEval = await pipeline.evaluateStep(workspaceContext, modifiedRelativePaths, {
        baselineMetrics: state.baselineMetrics,
        iteration: i,
        samples,
        minSignificanceDelta,
      });

      evaluations.push(stepEval);

      // Synthesize gradient feedback
      lastFeedback = synthesizeGradientFeedback({
        accepted: stepEval.accepted,
        fitnessScore: stepEval.fitnessScore,
        deltaPercent: stepEval.deltaPercent,
        isSignificant: stepEval.isSignificant,
        invariants: stepEval.invariants,
        violations: stepEval.violations,
        metrics: stepEval.metrics,
        baselineMetrics: state.baselineMetrics,
        revertReason: stepEval.revertReason,
      });

      if (stepEval.accepted && stepEval.fitnessScore > bestFitness) {
        bestFitness = stepEval.fitnessScore;
        acceptedCount++;
        consecutiveRejections = 0;

        await coordinator.acceptStep(i, bestFitness);
        const deltaStr = stepEval.deltaPercent >= 0 ? `+${stepEval.deltaPercent.toFixed(1)}%` : `${stepEval.deltaPercent.toFixed(1)}%`;
        log(chalk.green(`  ✔ Accepted! New best score: +${bestFitness.toFixed(2)} (Delta: ${deltaStr})`));
      } else {
        consecutiveRejections++;
        await coordinator.rejectStep();
        const scoreStr = stepEval.fitnessScore === -Infinity ? "-Infinity" : stepEval.fitnessScore.toFixed(2);
        log(chalk.red(`  ✖ Rejected (Score: ${scoreStr}). Mutation rolled back.`));
        if (stepEval.revertReason) {
          log(chalk.dim(`    Reason: ${stepEval.revertReason}`));
        }

        if (consecutiveRejections >= plateauThreshold) {
          stoppedReason = `Plateau reached (${consecutiveRejections} consecutive rejections)`;
          log(chalk.yellow(`\n⚠ Plateau threshold reached (${plateauThreshold} non-improving steps). Auto-terminating.`));
          break;
        }
      }
    }

    let promoted = false;
    if (acceptedCount > 0) {
      log(chalk.green(`\n✔ Promoting winning worktree commits to '${targetBranch}'...`));
      await coordinator.promoteAndCleanup(targetBranch);
      promoted = true;

      // Update state
      state.bestFitnessScore = bestFitness;
      state.acceptedStepCount += acceptedCount;
      state.totalStepCount += evaluations.length;
      state.updatedAt = Date.now();
      writeState(cwd, state);
    } else {
      log(chalk.yellow("\n⚠ No mutations improved fitness. Worktree torn down cleanly without changes."));
      await coordinator.release();
      await worktreeDriver.teardown();
    }

    // Print summary table
    printSummaryTable({
      totalIterations: evaluations.length,
      acceptedCount,
      bestFitnessScore: bestFitness,
      stoppedReason,
      promoted,
    });

    return {
      totalIterations: evaluations.length,
      acceptedCount,
      bestFitnessScore: bestFitness,
      promoted,
      stoppedReason,
      evaluations,
    };
  } catch (err: unknown) {
    try {
      await coordinator.release();
      await worktreeDriver.teardown();
    } catch {
      // ignore
    }
    throw err;
  }
}

function printSummaryTable(summary: {
  totalIterations: number;
  acceptedCount: number;
  bestFitnessScore: number;
  stoppedReason: string;
  promoted: boolean;
}): void {
  console.log(chalk.bold.cyan("\n================================================================================"));
  console.log(chalk.bold.cyan("                     PERFGYM OPTIMIZATION RUN SUMMARY                           "));
  console.log(chalk.bold.cyan("================================================================================"));
  console.log(`  Total Iterations Evaluated:  ${chalk.bold(summary.totalIterations)}`);
  console.log(`  Winning Mutations Accepted:  ${chalk.green.bold(summary.acceptedCount)}`);
  console.log(`  Peak Fitness Improvement:    ${chalk.green.bold(`+${summary.bestFitnessScore.toFixed(2)}`)}`);
  console.log(`  Status / Termination Reason: ${chalk.yellow(summary.stoppedReason)}`);
  console.log(`  Promoted to Target Branch:   ${summary.promoted ? chalk.green("YES") : chalk.gray("NO")}`);
  console.log(chalk.bold.cyan("================================================================================\n"));
}
