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
  type NegativeMemoryEntry,
  type StepEvaluation,
  type WorkspaceContext,
  synthesizeGradientFeedback,
} from "../../../core/src/index.js";
import { AstLinterEngine, DEFAULT_RULES, TypecheckGate } from "../../../linter/src/index.js";
import {
  loadConfig,
  readState,
  writeState,
  runBaseline,
  loadNegativeMemory,
  recordNegativeMemory,
  negativeMemoryFilePath,
  type PerfGymState,
} from "../engine.js";

export interface MutationContext {
  iteration: number;
  bestFitnessScore: number;
  lastFeedback?: string;
  /**
   * The remembered failures of the target — newest first.
   *
   * Present on EVERY iteration, including the first one: the persisted
   * memory of the previous run must reach the first mutation of this run,
   * otherwise the very first attempt repeats a known failure. The structured
   * entries are the honest channel here — `lastFeedback` is the gradient of
   * the previous step and only exists from the second iteration on.
   */
  readonly negativeMemory: readonly NegativeMemoryEntry[];
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

  // The negative memory is owned by the loop: it is loaded at the start of
  // the run (so the failures of the previous run are known) and persisted at
  // the end of it (so the next run starts from what was learned).
  const negativeMemoryFile = negativeMemoryFilePath(cwd);
  const negativeMemory = loadNegativeMemory(
    cwd,
    config.target.name,
    config.agentBudget?.negativeMemorySize,
  );
  // Only a run that actually records a failure may rewrite the cache. Saving
  // unconditionally would bump the file's mtime on every "nothing learned"
  // run, and — because the cache is a snapshot taken at run start — could
  // overwrite entries a concurrent run wrote in the meantime.
  let memoryDirty = false;

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
          // The remembered failures reach the generator on every iteration,
          // the first one included.
          negativeMemory: negativeMemory.entries(),
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

      // 1. Accept or reject the step. The reject branch rolls the mutation
      //    back and — only for a GENUINE failure — remembers it.
      let rolledBack = false;

      if (stepEval.accepted && stepEval.fitnessScore > bestFitness) {
        bestFitness = stepEval.fitnessScore;
        acceptedCount++;
        consecutiveRejections = 0;

        await coordinator.acceptStep(i, bestFitness);
        const deltaStr = stepEval.deltaPercent >= 0 ? `+${stepEval.deltaPercent.toFixed(1)}%` : `${stepEval.deltaPercent.toFixed(1)}%`;
        log(chalk.green(`  ✔ Accepted! New best score: +${bestFitness.toFixed(2)} (Delta: ${deltaStr})`));
      } else {
        rolledBack = true;
        consecutiveRejections++;
        await coordinator.rejectStep();

        // Remember the failure — the bounded negative memory is what stops
        // the optimizer from retrying a mutation that already failed. Only a
        // REJECTED step failed: a mutation the pipeline accepted did not,
        // even when the loop rolled it back because it did not beat the
        // champion.
        if (!stepEval.accepted) {
          recordNegativeMemory(negativeMemory, {
            files: mutatedFiles,
            deltaPercent: stepEval.deltaPercent,
            ...(stepEval.revertReason !== undefined ? { reason: stepEval.revertReason } : {}),
            step: i,
          });
          memoryDirty = true;
        }

        const scoreStr = stepEval.fitnessScore === -Infinity ? "-Infinity" : stepEval.fitnessScore.toFixed(2);
        log(chalk.red(`  ✖ Rejected (Score: ${scoreStr}). Mutation rolled back.`));
        if (stepEval.revertReason) {
          log(chalk.dim(`    Reason: ${stepEval.revertReason}`));
        }
      }

      // 2. Synthesize the gradient feedback AFTER the verdict, so the
      //    feedback of step i already carries the failure of step i and the
      //    generator of step i+1 is told what not to repeat.
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
        negativeMemory: negativeMemory.entries(),
      });

      // 3. The plateau check comes last: the feedback of the final step must
      //    never be lost.
      if (rolledBack && consecutiveRejections >= plateauThreshold) {
        stoppedReason = `Plateau reached (${consecutiveRejections} consecutive rejections)`;
        log(chalk.yellow(`\n⚠ Plateau threshold reached (${plateauThreshold} non-improving steps). Auto-terminating.`));
        break;
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
    if (!options.quiet) {
      printSummaryTable({
        totalIterations: evaluations.length,
        acceptedCount,
        bestFitnessScore: bestFitness,
        stoppedReason,
        promoted,
      });
    }

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
  } finally {
    // The negative memory must survive EVERY exit path — the normal end, the
    // plateau break, the "nothing improved" branch and a thrown error — so
    // what the run learned is never lost. A run that learned nothing writes
    // no file at all, and a persistence failure never masks the run's own
    // error.
    if (memoryDirty && negativeMemory.entries().length > 0) {
      try {
        negativeMemory.save(negativeMemoryFile);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(chalk.yellow(`⚠ Could not persist the negative memory: ${message}`));
      }
    }
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
