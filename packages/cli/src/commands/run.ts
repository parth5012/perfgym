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

import { execFileSync } from "node:child_process";
import chalk from "chalk";
import * as fs from "node:fs";
import * as path from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
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
  legacyStateCopy,
  saveSession,
  runBaseline,
  loadNegativeMemory,
  recordNegativeMemory,
  negativeMemoryFilePath,
  type PerfGymState,
} from "../engine.js";
import { liveSessionFor, reflectSessionLock } from "../live-session.js";

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

// ============================================================================
// The edge runner's sandbox lifecycle (Ticket #51)
// ============================================================================

/**
 * Normalise a resource handle onto the Effect channel.
 *
 * `coordinator.release()` returns an Effect, but a test spy (or a future
 * caller) may hand back a Promise instead: yielding a raw Promise would die
 * with "not an Effect" AND leave its rejection unhandled. Converting it here
 * keeps both worlds cleanup-safe.
 */
export const asEffect = (value: unknown): Effect.Effect<unknown, unknown, never> => {
  if (Effect.isEffect(value)) {
    return value as Effect.Effect<unknown, unknown, never>;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  ) {
    return Effect.tryPromise({
      try: () => value as Promise<unknown>,
      catch: (error) => error,
    });
  }
  return Effect.sync(() => value);
};

/**
 * Discover this process's direct children without assuming a platform.
 *
 * Order matters: `/proc` is authoritative on Linux, `pgrep -P` is portable
 * (BSD/macOS/Linux), and `ps --ppid` is a GNU extension kept as the last
 * resort — shelling out to a flag BSD `ps` rejects would throw inside the
 * catch and silently find nothing, leaving stray children alive. Pure, so
 * every branch is unit-testable; adapters are responsible for their output.
 */
export const collectStrayChildPids = (adapters: {
  readProcChildren: () => string | null;
  exec: (cmd: string, args: string[]) => string | null;
}): number[] => {
  const pids: number[] = [];
  const collect = (raw: string | null): void => {
    if (raw === null) return;
    for (const token of raw.split(/\s+/)) {
      if (token.length === 0) continue;
      const pid = Number(token);
      if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
      pids.push(pid);
    }
  };
  // A failing adapter is "no answer", never a throw: this runs inside a
  // finalizer, where nothing may mask the run's own outcome.
  const tryRead = (): string | null => {
    try {
      return adapters.readProcChildren();
    } catch {
      return null;
    }
  };
  const tryExec = (cmd: string, args: string[]): string | null => {
    try {
      return adapters.exec(cmd, args);
    } catch {
      return null;
    }
  };
  collect(tryRead());
  if (pids.length === 0) collect(tryExec("pgrep", ["-P", String(process.pid)]));
  if (pids.length === 0) {
    collect(tryExec("ps", ["-o", "pid=", "--ppid", String(process.pid)]));
  }
  return pids;
};

/**
 * Best-effort SIGKILL of this process's direct children.
 *
 * The run's sandbox may own a long-lived child — the LLM CLI driver's
 * process, a benchmark command that outlived its parent — whose working
 * directory lives INSIDE the worktree we are about to delete. Every step
 * swallows its own failure: this runs inside a finalizer, where nothing is
 * allowed to mask the run's own outcome.
 */
const killStrayChildProcesses = (): void => {
  const children = collectStrayChildPids({
    readProcChildren: () =>
      fs.readFileSync(`/proc/self/task/${process.pid}/children`, "utf8"),
    exec: (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }),
  });
  for (const pid of children) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
};

/**
 * The release half of `Effect.acquireRelease` for the run sandbox — the
 * guarantee of Ticket #51: it runs on success, on failure AND on interruption.
 *
 * Each step runs inside its own `Effect.exit`, so a failing (or mocked)
 * release can never mask the run's own error, and one broken step still lets
 * the remaining ones run: an unremovable lock must not skip the worktree
 * teardown, and neither may skip the stray-child kill.
 */
export const releaseSandbox = (
  coordinator: GitSandboxCoordinator,
  driver: GitWorktreeDriver,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    // Order matters (self-review, high): stray children may hold files inside
    // the worktree, and a waiting process grabs the lock the instant it is
    // free — so kill first, remove the worktree second, release the lock last.
    yield* Effect.exit(Effect.sync(() => killStrayChildProcesses()));
    yield* Effect.exit(asEffect(driver.teardown()));
    yield* Effect.exit(asEffect(coordinator.release()));
  });

/** Whether a cause carries an interrupt reason (Effect 4 stores them as `reasons`). */
const isInterruptCause = (cause: unknown): boolean => {
  const reasons = (cause as { reasons?: ReadonlyArray<{ readonly _tag?: unknown }> }).reasons;
  return Array.isArray(reasons) && reasons.some((reason) => reason._tag === "Interrupt");
};

/**
 * The reason a run ended on a failure exit — what the session records for the
 * next `perfgym status`. Typed domain failures and defects squash down to
 * their message; a pure interruption says so explicitly (it has no message of
 * its own, and leaving a stale "mutating" status would lie about the run).
 */
const describeExit = (exit: Exit.Exit<unknown, unknown>): string | null => {
  if (Exit.isSuccess(exit)) return null;
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) {
    const error = failure.value;
    return error instanceof Error ? error.message : String(error);
  }
  if (isInterruptCause(exit.cause)) {
    return "Run interrupted by SIGINT/SIGTERM before it could complete.";
  }
  const defect = Cause.squash(exit.cause);
  return defect instanceof Error ? defect.message : String(defect);
};

/**
 * The optimization loop as an Effect PROGRAM (Ticket #51).
 *
 * This function builds — but never runs — the program: execution belongs to
 * the single edge helper `runEffect` in engine.ts. The sandbox lifecycle is
 * `Effect.acquireRelease` inside `Effect.scoped`:
 *
 * - acquire: take the lock + create the worktree;
 * - release: remove the worktree, release the lock, kill stray children — on
 *   success, on failure, and when SIGINT/SIGTERM interrupts the fiber;
 * - session finalization (record the error, flush the negative memory) hangs
 *   on the outer `Effect.onExit`, which runs AFTER the release, so the lock
 *   snapshot it writes reflects the real post-release state.
 */
export function runOptimizationLoop(
  options: RunLoopOptions = {},
): Effect.Effect<RunLoopResult, unknown, never> {
  return Effect.gen(function* () {
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
    let loadedState = loadSession(cwd);

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

    if (!loadedState) {
      log(chalk.blue("📊 Establishing initial baseline before optimization loop..."));
      const baseRes = yield* runBaseline({ cwd, samples });
      if (!baseRes.success) {
        throw new Error(`Failed to establish baseline: ${baseRes.error}`);
      }
      loadedState = baseRes.state;
    }
    // Non-null handle for the closure below: the baseline is established by
    // now (or existed all along), so the scoped program captures it as a
    // `PerfGymState` instead of re-proving a narrowing it cannot see.
    const initialSession: PerfGymState = loadedState;

    // The worktree driver & sandbox coordinator
    const worktreeDriver = new GitWorktreeDriver({
      repoRoot: cwd,
      allowedGlobs: config.target.files,
    });

    const coordinator = new GitSandboxCoordinator(worktreeDriver, {
      repoRoot: cwd,
      // Ticket #51: `runEffect`'s interrupt handler owns SIGINT/SIGTERM for
      // this run. The coordinator's own shortcut (release + exit(130)) would
      // kill the process BEFORE the scoped finalizers below could remove the
      // worktree — exactly the orphaned-worktree bug this ticket closes. Its
      // `exit` fallback hook still releases the lock if the process dies.
      signalHooks: false,
    });

    // The live session of this run (Ticket #48): every transition below flows
    // through the TanStack SessionStore and its write-through flush hook, so
    // `perfgym status` in another terminal (or the MCP server) sees the run in
    // progress from the shared durable state file.
    const live = liveSessionFor(cwd);
    // ONE reflective lock snapshot (Ticket #48 review S1/S2): the lock dir is
    // the coordinator's own (S3) and the holder flag is the sandbox's REAL
    // state — the snapshot can never claim a lock that is not held.
    const serializeLock = (): Parameters<typeof live.setLock>[0] =>
      reflectSessionLock(coordinator.lockDirectory, coordinator.isLocked());

    const runId = `run-${Date.now()}`;

    // ---- The scoped sandbox lifecycle (Effect.acquireRelease, Ticket #51) ----
    const runScoped = Effect.scoped(
      Effect.gen(function* () {
        // acquire = take the lock + create the worktree. A lock-busy failure
        // stops here WITHOUT running release: this run acquired nothing, so
        // it must not release a lock someone else is holding.
        const workspaceContext = yield* Effect.acquireRelease(
          coordinator.acquire(runId, targetBranch),
          () => releaseSandbox(coordinator, worktreeDriver),
        );
        const sandboxDir = workspaceContext.workingDir;

        // P2 (#46): the ALREADY-ACQUIRED lock metadata is serialized reflectively
        // — the lock file stays the single authority; this is only a snapshot.
        live.beginRun(runId, targetBranch, serializeLock());

        const linter = new AstLinterEngine(DEFAULT_RULES, sandboxDir);
        const typechecker = new TypecheckGate(sandboxDir);
        const pipeline = new EvaluationPipeline(config, linter, typechecker);

        // The run's mutable session state — never null (seeded above).
        let state = initialSession;
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

        for (let i = 1; i <= maxIterations; i++) {
          log(chalk.bold.blue(`▶ Iteration ${i}/${maxIterations}:`));

          // Per-iteration store contract (#48): the transition chain is
          // mutating → evaluating → accepted/rejected (then the rollback marker
          // for a rejected step), flushed to disk at every transition.
          live.setStatus("mutating");

          let mutatedFiles: MutationFile[] = [];

          if (options.generator) {
            const generator = options.generator;
            mutatedFiles = yield* Effect.tryPromise({
              try: () =>
                generator({
                  iteration: i,
                  bestFitnessScore: bestFitness,
                  lastFeedback,
                  negativeMemory: negativeMemory.entries(),
                  targetFiles: config.target.files,
                  workingDir: sandboxDir,
                }),
              catch: (error: unknown) => error,
            });
          } else if (activeLlmDriver) {
            // Captured for the Effect closure below: a `let` narrowed outside
            // a callback is not narrowed inside it.
            const llmDriver = activeLlmDriver;
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

            const llmResult = yield* Effect.tryPromise({
              try: () =>
                llmDriver.complete({
                  prompt,
                  model: resolvedModel,
                  targetFiles: targetFilesContent,
                  timeoutMs: resolvedTimeoutMs,
                }),
              catch: (error: unknown) => error,
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
          yield* coordinator.applyMutation(mutatedFiles);

          const modifiedRelativePaths = mutatedFiles.map((m) => m.relPath);

          live.setStatus("evaluating");

          // Evaluate step
          const stepEval = yield* Effect.tryPromise({
            try: () =>
              pipeline.evaluateStep(workspaceContext, modifiedRelativePaths, {
                baselineMetrics: state.baselineMetrics,
                iteration: i,
                samples,
                minSignificanceDelta,
              }),
            catch: (error: unknown) => error,
          });

          evaluations.push(stepEval);

          // 1. Accept or reject the step. The reject branch rolls the mutation
          //    back and — only for a GENUINE failure — remembers it.
          let rolledBack = false;

          if (stepEval.accepted && stepEval.fitnessScore > bestFitness) {
            bestFitness = stepEval.fitnessScore;
            acceptedCount++;
            consecutiveRejections = 0;

            yield* coordinator.acceptStep(i, bestFitness);
            live.recordStep(stepEval);
            const deltaStr = stepEval.deltaPercent >= 0 ? `+${stepEval.deltaPercent.toFixed(1)}%` : `${stepEval.deltaPercent.toFixed(1)}%`;
            log(chalk.green(`  ✔ Accepted! New best score: +${bestFitness.toFixed(2)} (Delta: ${deltaStr})`));
          } else {
            rolledBack = true;
            consecutiveRejections++;
            yield* coordinator.rejectStep();
            // The store records the verdict FIRST (accepted/rejected + history),
            // then the rollback marker marks the undone step in the history.
            live.recordStep(stepEval);
            live.markStepRolledBack(i);

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
          yield* coordinator.promoteAndCleanup(targetBranch);
          promoted = true;

          // Update state — through the detached legacy snapshot (the `session`
          // blob is owned by the live-session path and must not regress).
          state.bestFitnessScore = bestFitness;
          if (live.state.bestStep !== null) {
            state.bestStep = live.state.bestStep;
          }
          state.acceptedStepCount += acceptedCount;
          state.totalStepCount += evaluations.length;
          state.updatedAt = Date.now();
          saveSession(cwd, legacyStateCopy(state));
        } else {
          log(chalk.yellow("\n⚠ No mutations improved fitness. Worktree torn down cleanly without changes."));
          // Release here (not only in the finalizer) so the "completed" lock
          // snapshot written below already reflects the released lock — the
          // scoped release then repeats it idempotently.
          yield* asEffect(coordinator.release());
          yield* asEffect(worktreeDriver.teardown());
        }

        // The run's final transitions: completed, and the lock snapshot resolved
        // against the (now released) session lock.
        live.setStatus("completed");
        live.setLock(serializeLock());

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
      })
    );

    // Session finalization — runs for EVERY exit (success, failure,
    // interruption) AFTER the scoped release above, so the lock snapshot
    // written here reflects the real post-release state. Nothing in here may
    // replace the run's own error (CR2): every persistence failure is
    // reported, never rethrown.
    return yield* Effect.onExit(runScoped, (exit) =>
      Effect.sync(() => {
        if (Exit.isFailure(exit)) {
          // The session must reflect the failed (or interrupted) run honestly:
          // keep the error visible for the next `perfgym status`, and let the
          // blob mirror the REAL lock — if the release above failed the
          // lockfile is still held, and the reflective snapshot says so
          // instead of a hardcoded null (S2/S4).
          try {
            const message = describeExit(exit);
            if (message !== null) {
              live.recordError(message);
            }
            live.setLock(serializeLock());
          } catch (flushErr: unknown) {
            const message = flushErr instanceof Error ? flushErr.message : String(flushErr);
            console.error(chalk.yellow(`⚠ Could not persist the live session: ${message}`));
          }
        }
        // The negative memory must survive EVERY exit path — the normal end,
        // the plateau break, the "nothing improved" branch, a failure and an
        // interruption — so what the run learned is never lost. A run that
        // learned nothing writes no file at all, and a persistence failure
        // never masks the run's own error.
        if (memoryDirty && negativeMemory.entries().length > 0) {
          try {
            negativeMemory.save(negativeMemoryFile);
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(chalk.yellow(`⚠ Could not persist the negative memory: ${message}`));
          }
        }
      }),
    );
  });
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
