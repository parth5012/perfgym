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
import * as fs from "node:fs";
import * as path from "node:path";
import {
  EvaluationPipeline,
  GitSandboxCoordinator,
  GitWorktreeDriver,
  type MutationFile,
  type NegativeMemoryEntry,
  type StepEvaluation,
  type WorkspaceContext,
  synthesizeGradientFeedback,
  PromptBuilder,
  createDriver,
  type LlmDriver,
  type TargetFileContent,
  matchesGlob,
} from "../../../core/src/index.js";
import { AstLinterEngine, DEFAULT_RULES, TypecheckGate } from "../../../linter/src/index.js";
import {
  loadConfig,
  loadSession,
  saveSession,
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
  driver?: "api" | "cli" | string;
  provider?: string;
  model?: string;
  cliCommand?: string;
  cliArgs?: string[];
  maxCostUsd?: number;
  maxTokens?: number;
  llmTimeoutMs?: number;
  generator?: MutationGenerator;
  llmDriver?: LlmDriver; // For injecting stub drivers in tests
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
  totalCostUsd?: number | null;
  totalTokens?: number;
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
  let state = loadSession(cwd);

  // Resolve driver configuration with precedence: CLI flag > .perfgym.yaml > default
  const resolvedDriverName = options.driver ?? config.llm?.driver ?? "api";
  const resolvedProvider = options.provider ?? config.llm?.provider ?? "openai";
  const resolvedModel = options.model ?? config.llm?.model;
  const resolvedCliCommand = options.cliCommand ?? config.llm?.cliCommand;
  const resolvedCliArgs = options.cliArgs ?? config.llm?.cliArgs;
  const resolvedTimeoutMs = options.llmTimeoutMs ?? config.llm?.timeoutMs;
  const maxCostUsd = options.maxCostUsd;
  const maxTokens = options.maxTokens;

  // Instantiate LLM driver if no explicit generator was provided
  let activeLlmDriver: LlmDriver | undefined = options.llmDriver;
  if (!options.generator && !activeLlmDriver) {
    activeLlmDriver = createDriver(resolvedDriverName, {
      provider: resolvedProvider,
      model: resolvedModel,
      cliCommand: resolvedCliCommand,
      cliArgs: resolvedCliArgs,
      timeoutMs: resolvedTimeoutMs,
      baseUrl: config.llm?.baseUrl,
      apiKey: config.llm?.apiKeyEnv ? process.env[config.llm.apiKeyEnv] : undefined,
      pricing: config.llm?.pricing,
    });
  }

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
  let consecutiveLlmFailures = 0;
  let consecutiveGiveUps = 0;
  let cumulativeTokens = 0;
  let cumulativeCostUsd: number | null = 0;
  let lastFeedback: string | undefined;
  let stoppedReason = "max-iterations";
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
          negativeMemory: negativeMemory.entries(),
          targetFiles: config.target.files,
          workingDir: sandboxDir,
        });
      } else if (activeLlmDriver) {
        // Collect current target files from sandboxDir (supports globs and direct files)
        const targetFilesContent: TargetFileContent[] = [];
        const scanDir = (dir: string, baseDir: string) => {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
            if (entry.isDirectory()) {
              if (entry.name !== "node_modules" && entry.name !== ".git" && entry.name !== ".perfgym") {
                scanDir(fullPath, baseDir);
              }
            } else if (entry.isFile()) {
              const matched = config.target.files.some((pat) => matchesGlob(pat, relPath));
              if (matched) {
                const stat = fs.statSync(fullPath);
                targetFilesContent.push({
                  path: relPath,
                  content: fs.readFileSync(fullPath, "utf8"),
                  mtimeMs: stat.mtimeMs,
                });
              }
            }
          }
        };
        scanDir(sandboxDir, sandboxDir);

        // Find primary metric for context
        const primaryMetric = config.metrics[0];
        const prompt = PromptBuilder.build({
          target: {
            name: config.target.name,
            language: config.target.language,
            files: config.target.files,
          },
          metric: {
            name: primaryMetric?.name ?? "fitness",
            unit: primaryMetric?.unit ?? "score",
            goal: primaryMetric?.goal ?? "maximize",
            baseline: state.baselineMetrics?.[primaryMetric?.name ?? ""],
            currentBest: bestFitness,
          },
          targetFiles: targetFilesContent,
          lastFeedback,
          negativeMemory: negativeMemory.entries(),
        });

        const llmResult = await activeLlmDriver.complete({
          prompt,
          model: resolvedModel,
          targetFiles: targetFilesContent,
          timeoutMs: resolvedTimeoutMs,
        });

        // Accumulate usage & cost
        if (llmResult.usage) {
          cumulativeTokens += llmResult.usage.totalTokens;
        }
        if (llmResult.estimatedCostUsd !== undefined) {
          if (llmResult.estimatedCostUsd === null) {
            cumulativeCostUsd = null;
          } else if (cumulativeCostUsd !== null) {
            cumulativeCostUsd += llmResult.estimatedCostUsd;
          }
        }

        // Check budget caps immediately after usage is accumulated
        if (maxTokens !== undefined && cumulativeTokens >= maxTokens) {
          stoppedReason = "budget-exhausted";
          log(chalk.yellow(`  Token budget exhausted (${cumulativeTokens} >= ${maxTokens}). Stopping.`));
          // Apply this iteration's mutations before stopping so work is evaluated and kept
          mutatedFiles = llmResult.mutations.map((m) => ({
            relPath: m.path,
            content: m.content,
          }));
        } else if (maxCostUsd !== undefined && cumulativeCostUsd !== null && cumulativeCostUsd >= maxCostUsd) {
          stoppedReason = "budget-exhausted";
          log(chalk.yellow(`  Cost budget exhausted ($${cumulativeCostUsd.toFixed(4)} >= $${maxCostUsd}). Stopping.`));
          // Apply this iteration's mutations before stopping so work is evaluated and kept
          mutatedFiles = llmResult.mutations.map((m) => ({
            relPath: m.path,
            content: m.content,
          }));
        }

        // Check if LLM call failed or skipped
        if (llmResult.skipped || llmResult.error) {
          log(chalk.yellow(`  LLM call skipped/failed: ${llmResult.error}`));
          consecutiveLlmFailures++;
          if (consecutiveLlmFailures >= 3) {
            stoppedReason = "error";
            log(chalk.red("  3 consecutive LLM failures reached. Aborting loop."));
            break;
          }
          continue;
        }

        // Reset consecutive failures on valid response
        consecutiveLlmFailures = 0;

        // Check if LLM gave up (mutations: [])
        if (!llmResult.mutations || llmResult.mutations.length === 0) {
          log(chalk.yellow("  Model returned 0 mutations (gave up)."));
          consecutiveGiveUps++;
          if (consecutiveGiveUps >= 2) {
            stoppedReason = "llm-gave-up";
            log(chalk.yellow("  2 consecutive give-ups received. Stopping."));
            break;
          }
          continue;
        }

        // Reset give-ups on mutation received
        consecutiveGiveUps = 0;

        mutatedFiles = llmResult.mutations.map((m) => ({
          relPath: m.path,
          content: m.content,
        }));
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
        stoppedReason = "plateau";
        log(chalk.yellow(`\n⚠ Plateau threshold reached (${plateauThreshold} non-improving steps). Auto-terminating.`));
        break;
      }

      // 4. Check budget caps at end of iteration
      if (stoppedReason === "budget-exhausted") {
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
      saveSession(cwd, state);
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
      totalCostUsd: cumulativeCostUsd,
      totalTokens: cumulativeTokens,
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
