import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Cause, Effect, Exit } from "effect";
import type { AstLinterEngine, ScanResult, TypecheckGate } from "../../../linter/src/index.js";
import type {
  BenchmarkDistribution,
  InvariantResult,
  LintViolation,
  MetricResult,
  PerfGymConfig,
  StepEvaluation,
  WorkspaceContext,
} from "../index.js";
import { runInvariantGate } from "./invariants.js";
import { computeMetricResult, runBenchmark } from "./benchmark.js";
import { computeFitnessVerdict } from "./fitness.js";

/**
 * ============================================================================
 * EvaluationPipeline — the deep module behind the gym loop (ticket #15)
 * ============================================================================
 *
 * A single tiny surface — `new EvaluationPipeline(config, linter,
 * typechecker?)`, `initializeHarness(repoDir)`, `evaluateStep(context,
 * modifiedFiles, opts?)` — that hides the entire 4-stage cascade:
 *
 *   1. Invariant gate  (correctness precedes speed; ADR-020 zero retries)
 *   2. Anti-cheat scan (disqualify-action rules + two-tier typecheck gate)
 *   3. Benchmark run   (deterministic distribution sampling per metric)
 *   4. Fitness verdict (weighted deltas − penalties, tail guard, significance)
 *
 * Tier-2 tsc --noEmit runs pre-promotion (ADR-007), not per-step; pipeline performs tier-1 + config integrity per step.
 *
 * Contract: callers hand in mutated file paths (relative to the workspace's
 * `context.workingDir`) and receive a full `StepEvaluation`. The cascade
 * SHORT-CIRCUITS: a stage-1 invariant failure or a stage-2 disqualification /
 * tamper finding aborts instantly with `fitnessScore: -Infinity` and stages
 * 3-4 never execute. `evaluateStep` never throws on pipeline semantics — a
 * rejected step is still a resolved verdict (score -Infinity, `accepted:
 * false`, `revertReason` populated), because a gym loop asks for a verdict,
 * not a throw. Only construction misuse (e.g. a config without an invariant
 * command or metric list) throws.
 *
 * Legacy config note: `invariants.retries` is deliberately IGNORED in favor
 * of ADR-020 (zero tolerance, zero retries, unit-only, per-step invariants).
 * A nonzero legacy value is never honored.
 *
 * Harness pragmatics (documented honestly): `initializeHarness` freezes what
 * the config lets it know about — file paths occurring in the invariant
 * command plus the optional `metrics[].harnessScripts` extension — into
 * `<repo>/.perfgym/.harness` with no write bits (files 0444, dirs 0555).
 * When nothing is freezable the harness stays EMPTY and the benchmark stage
 * silently skips frozen-harness enforcement (the #13 seam only verifies when
 * a non-empty `harnessDir` is provided), so an empty harness never blocks
 * benchmarking. Test-assertion tampering is additionally covered by the
 * linter's two-tier TypecheckGate (protected-file integrity when the engine
 * is constructed with a project root).
 *
 * Failure plumbing: the unavoidable subprocess seams are Effect channels
 * (#12 invariant gate, #13 benchmark seam). Every *expected* failure is
 * caught IN-BAND with `Effect.catchIf` so the generator never fails and we
 * never have to reverse-engineer an opaque `Cause`. Only a genuine defect
 * (a bug) falls through to the `runPromiseExit` fallback envelope.
 */

export const DEFAULT_HARNESS_PATH = ".perfgym/.harness";

/** Options for a single step evaluation (kept compatible with the 2-arg call form). */
export interface EvaluateStepOptions {
  /** Baseline distribution for the primary metric (tail-guard input). */
  readonly baseline?: BenchmarkDistribution;
  /** Baseline values per metric name; a missing entry yields Δ% = 0. */
  readonly baselineMetrics?: Record<string, number>;
  /** Echoed back on the StepEvaluation (defaults to 0). */
  readonly iteration?: number;
  /** Overrides the minimum significance threshold (default 2.5%, clamped ≥ 0). */
  readonly minSignificanceDelta?: number;
  /**
   * Relative MAD floor of the tail-guard ceiling (default 0.01 = 1% of
   * baseline p50, ticket #52). Threaded through to `computeFitnessVerdict`.
   */
  readonly floorCoefficient?: number;
  /** Measured samples per benchmark command (default 5, see #13 clamps). */
  readonly samples?: number;
  /** Explicit harness dir for tamper verification; defaults to the frozen one. */
  readonly harnessDir?: string;
}

interface InitializeHarnessOptions {
  readonly harnessDir?: string;
}

const REJECT_MESSAGE_LIMIT = 500;

/** Config-declared immutable grade inputs: invariant test paths from the command + harnessScripts. */
const FREEZABLE_FILE_REGEX =
  /^(?:\.{1,2}\/)?[\w@][\w@.\-/\\]*\.(?:tsx?|jsx?|mjs|cjs|py|sh|rb|go|rs|kt)$/;

const TYPECHECK_SENTINEL_RULE = "perfgym:typecheck";

/** In-band short-circuit envelope: a rejected step smuggled as a success value. */
interface RejectedEnveloped {
  readonly __pipelineRejected: true;
  readonly step: StepEvaluation;
}

function envelopedRejected(step: StepEvaluation): RejectedEnveloped {
  return { __pipelineRejected: true, step };
}

function isRejectedEnveloped(
  value: unknown
): value is RejectedEnveloped {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __pipelineRejected?: unknown }).__pipelineRejected === true
  );
}

export class EvaluationPipeline {
  readonly #config: PerfGymConfig;
  readonly #linter: AstLinterEngine;
  readonly #typechecker: TypecheckGate | null;
  #frozenHarnessDir: string | null = null;

  constructor(
    config: PerfGymConfig,
    linter: AstLinterEngine,
    typechecker?: TypecheckGate
  ) {
    if (!config || typeof config.invariants?.command !== "string" || config.invariants.command.trim() === "") {
      throw new Error(
        "EvaluationPipeline requires a PerfGymConfig with a non-empty invariants.command"
      );
    }
    if (!Array.isArray(config.metrics) || config.metrics.length === 0) {
      throw new Error("EvaluationPipeline requires a PerfGymConfig with a non-empty metrics array");
    }
    if (!linter || typeof linter.scan !== "function") {
      throw new Error("EvaluationPipeline requires an AstLinterEngine instance");
    }
    this.#config = config;
    this.#linter = linter;
    this.#typechecker = typechecker ?? null;
  }

  /**
   * Absolute path of the frozen harness, or null when nothing was frozen
   * (empty harness ⇒ stage 3 skips tamper enforcement entirely).
   */
  public get harnessDir(): string | null {
    return this.#frozenHarnessDir;
  }

  // ==========================================================================
  // Harness freezing (read-only grader snapshot)
  // ==========================================================================

  /**
   * Copy the config-declared grade inputs (invariant files referenced by the
   * invariant command + `metrics[].harnessScripts`) from `repoDir` into the
   * frozen harness dir, stripping every write permission bit. Re-initializing
   * over the same repo first restores permissions and replaces the snapshot.
   * Throws on filesystem errors (harness misconfiguration is a launcher bug,
   * not a step verdict).
   */
  public async initializeHarness(repoDir: string, options?: InitializeHarnessOptions): Promise<void> {
    const candidates = extractFreezablePaths(this.#config);
    const baseDir = resolve(repoDir);
    if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) {
      throw new Error(`Cannot freeze harness: repo dir "${repoDir}" does not exist`);
    }

    // Validate that the target harness dir is strictly inside repoDir before any operations (B1).
    const targetHarnessDir = resolve(baseDir, options?.harnessDir ?? DEFAULT_HARNESS_PATH);
    const relHarness = relative(baseDir, targetHarnessDir);
    if (relHarness.startsWith("..") || isAbsolute(relHarness) || relHarness === "") {
      throw new Error(
        `harnessDir must be strictly contained inside repoDir: "${targetHarnessDir}" is outside "${baseDir}"`
      );
    }

    // Replace a previous snapshot: restore write bits, remove, rebuild.
    if (this.#frozenHarnessDir !== null) {
      restoreWriteBits(this.#frozenHarnessDir);
      this.#frozenHarnessDir = null;
    } else if (existsSync(targetHarnessDir)) {
      restoreWriteBits(targetHarnessDir);
    }
    rmSync(targetHarnessDir, { recursive: true, force: true });

    if (candidates.length === 0) {
      return; // nothing freezable declared — leave enforcement opt-out (documented)
    }

    const copied: string[] = [];
    for (const candidate of candidates) {
      const sourcePath = resolve(baseDir, candidate);
      const rel = relative(baseDir, sourcePath);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        continue; // never copy outside the repo boundary
      }
      if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
        continue; // best-effort: only existing, real files are frozen
      }
      const realSource = realpathSync(sourcePath);
      const relReal = relative(baseDir, realSource);
      if (relReal.startsWith("..") || isAbsolute(relReal)) {
        continue; // skip symlinked sources resolving outside repoDir (B2)
      }
      const targetPath = join(targetHarnessDir, rel);
      mkdirSync(dirname(targetPath), { recursive: true });
      cpSync(sourcePath, targetPath);
      chmodSync(targetPath, 0o444);
      copied.push(rel);
    }

    if (copied.length === 0) {
      return; // declared paths were absent — empty harness, enforcement skipped
    }

    makeReadOnlyRecursive(targetHarnessDir);
    this.#frozenHarnessDir = targetHarnessDir;
  }

  // ==========================================================================
  // The 4-stage cascade
  // ==========================================================================

  public async evaluateStep(
    context: WorkspaceContext,
    modifiedFiles: readonly string[],
    opts?: EvaluateStepOptions
  ): Promise<StepEvaluation> {
    const startedAt = Date.now();
    const iteration = sanitizeIteration(opts?.iteration);
    const meta = { context, opts, startedAt, iteration };
    const pipeline = this;

    let completedInvariants: InvariantResult | undefined;

    const program: Effect.Effect<StepEvaluation, Error> = Effect.gen(function* () {
      // ----------------------------------------------------------------
      // Stage 1 — invariant gate (correctness precedes speed). Any
      // failure — exit code, timeout, spawn error — rejects instantly.
      // ----------------------------------------------------------------
      const stage1: InvariantResult | RejectedEnveloped = yield* Effect.catchIf(
        runInvariantGate({
          command: pipeline.#config.invariants.command,
          cwd: context.workingDir,
          timeoutMs: pipeline.#config.invariants.timeoutMs, // seam clamps (10s/30s policy)
          // `invariants.retries` is legacy and ignored (ADR-020: zero retries).
        }),
        () => true,
        (failure: { readonly message: string }) =>
          Effect.succeed(
            envelopedRejected(
              rejectedStep({
                ...meta,
                revertReason: `invariants failed: ${truncate(failure.message)}`,
                invariants: {
                  passed: false,
                  output: truncate(failure.message),
                  durationMs: Date.now() - startedAt,
                  retriesUsed: 0,
                },
              })
            )
          )
      );
      if (isRejectedEnveloped(stage1)) {
        return stage1.step;
      }
      const invariants: InvariantResult = stage1;
      completedInvariants = invariants;

      // ----------------------------------------------------------------
      // Stage 2 — anti-cheat scan: disqualify-action rules, @ts-ignore /
      // any-casts / tampered config integrity via the two-tier gate.
      // ----------------------------------------------------------------
      const scanEnvelope: ScanResult | RejectedEnveloped = yield* Effect.catchIf(
        Effect.callback<ScanResult, Error>((resume) => {
          let files: string[];
          try {
            files = resolveModifiedFiles(context, modifiedFiles);
          } catch (cause) {
            resume(Effect.fail(cause instanceof Error ? cause : new Error(String(cause))));
            return;
          }
          pipeline.#linter
            .scan(files)
            .then(
              (result) => resume(Effect.succeed(result)),
              (cause: unknown) =>
                resume(Effect.fail(cause instanceof Error ? cause : new Error(String(cause))))
            );
        }),
        () => true,
        (cause: { readonly message: string }) =>
          // An unscannable mutation cannot be graded — treat as types-broken.
          Effect.succeed(
            envelopedRejected(
              rejectedStep({
                ...meta,
                revertReason: `Types broken (anti-cheat scan failed): ${truncate(cause.message)}`,
                invariants,
                violations: [
                  typecheckViolation(context, `Anti-cheat scan could not run: ${cause.message}`),
                ],
              })
            )
          )
      );
      if (isRejectedEnveloped(scanEnvelope)) {
        return scanEnvelope.step;
      }

      const violations = pipeline.antiCheatViolations(context, scanEnvelope);

      // Instant abort: any disqualification (anti-cheat rule OR a typecheck /
      // tamper sentinel violation) stops the cascade before benchmarks run.
      if (violations.some((v) => v.action === "disqualify")) {
        const preVerdict = computeFitnessVerdict({
          invariants,
          violations,
          metrics: [],
        });
        return rejectedStep({
          ...meta,
          revertReason:
            preVerdict.rejected?.message ??
            `Disqualified during anti-cheat stage: ${preVerdict.reasons.join("; ")}`,
          invariants,
          violations,
        });
      }

      // ----------------------------------------------------------------
      // Stage 3 — deterministic benchmark sampling per metric (the frozen
      // harness is verified inside the seam when a harness dir exists).
      // ----------------------------------------------------------------
      const metricResults: MetricResult[] = [];
      const distributions: BenchmarkDistribution[] = [];
      const harnessEnforcementDir =
        opts?.harnessDir !== undefined ? opts.harnessDir : pipeline.#frozenHarnessDir;

      for (const metricConfig of pipeline.#config.metrics) {
        const stage3: BenchmarkDistribution | RejectedEnveloped = yield* Effect.catchIf(
          runBenchmark({
            command: metricConfig.command,
            cwd: context.workingDir,
            samples: opts?.samples,
            warmup: pipeline.#config.benchmark?.warmupIterations,
            unit: metricConfig.unit ?? "count",
            ...(metricConfig.timeoutMs !== undefined ? { timeoutMs: metricConfig.timeoutMs } : {}),
            ...(harnessEnforcementDir !== null && harnessEnforcementDir !== ""
              ? { harnessDir: harnessEnforcementDir }
              : {}),
          }),
          () => true,
          (failure: { readonly message: string }) =>
            Effect.succeed(
              envelopedRejected(
                rejectedStep({
                  ...meta,
                  revertReason: `benchmark failed: ${truncate(failure.message)}`,
                  invariants,
                  violations,
                })
              )
            )
        );
        if (isRejectedEnveloped(stage3)) {
          return stage3.step;
        }
        const distribution = stage3;
        distributions.push(distribution);
        const baselineValue = opts?.baselineMetrics?.[metricConfig.name] ?? 0;
        metricResults.push(
          computeMetricResult(
            metricConfig.name,
            baselineValue,
            distribution.p50,
            metricConfig.unit ?? "count",
            metricConfig.goal
          )
        );
      }

      return pipeline.finalVerdictStep(meta, {
        invariants,
        violations: [...violations],
        metricResults,
        distributions,
      });
    });

    const exit = await Effect.runPromiseExit(program);
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    // Genuine defect fallback — always a resolved rejection, never a throw.
    return rejectedStep({
      ...meta,
      revertReason: `pipeline error: ${truncate(describeExit(exit.cause))}`,
      invariants: completedInvariants ?? {
        passed: false,
        output: truncate(describeExit(exit.cause)),
        durationMs: Date.now() - startedAt,
        retriesUsed: 0,
      },
    });
  }

  // ==========================================================================
  // Stage 4 + stage-2 internals
  // ==========================================================================

  private finalVerdictStep(
    meta: { context: WorkspaceContext; opts: EvaluateStepOptions | undefined; startedAt: number; iteration: number },
    stageData: {
      readonly invariants: InvariantResult;
      readonly violations: readonly LintViolation[];
      readonly metricResults: readonly MetricResult[];
      readonly distributions: readonly BenchmarkDistribution[];
    }
  ): StepEvaluation {
    const verdict = computeFitnessVerdict({
      invariants: stageData.invariants,
      violations: stageData.violations,
      metrics: [...stageData.metricResults],
      baseline: meta.opts?.baseline,
      current: stageData.distributions[0],
      minSignificanceDelta: meta.opts?.minSignificanceDelta,
      floorCoefficient: meta.opts?.floorCoefficient ?? this.#config.floorCoefficient,
      weights: Object.fromEntries(this.#config.metrics.map((m) => [m.name, m.weight])),
      primaryGoal: this.#config.metrics[0]?.goal,
    });

    return {
      iteration: meta.iteration,
      fitnessScore: verdict.score,
      accepted: verdict.accepted,
      isSignificant: verdict.isSignificant,
      deltaPercent: verdict.primaryDeltaPercent ?? 0,
      invariants: stageData.invariants,
      violations: [...stageData.violations],
      metrics: [...stageData.metricResults],
      ...(meta.opts?.baseline !== undefined
        ? { baselineDistribution: meta.opts.baseline }
        : {}),
      ...(stageData.distributions[0] !== undefined
        ? { currentDistribution: stageData.distributions[0] }
        : {}),
      ...(verdict.rejected !== undefined
        ? { revertReason: verdict.rejected.message }
        : verdict.accepted
        ? {}
        : { revertReason: verdict.reasons.join("; ") }),
      executionTimeMs: Date.now() - meta.startedAt,
    };
  } /**
   * Anti-cheat channel: every scan/typecheck failure is expressed as a
   * `disqualify` violation so the fitness verdict's disqualification gate is
   * the single branch that produces -Infinity for stage-2 rejections.
   */
  private antiCheatViolations(
    context: WorkspaceContext,
    scan: ScanResult
  ): LintViolation[] {
    const violations = [...scan.violations];
    const typeFailures = [...scan.typeErrors, ...scan.scanErrors];
    if (typeFailures.length > 0) {
      violations.push(
        typecheckViolation(context, `Types broken: ${typeFailures.join("; ")}`)
      );
    }
    if (this.#typechecker !== null) {
      // Independent config integrity check on the workspace context.
      // Tier-2 tsc --noEmit runs pre-promotion (ADR-007), not per-step.
      try {
        const tsconfigPath = join(context.workingDir, "tsconfig.json");
        if (existsSync(tsconfigPath)) {
          const integrity = this.#typechecker.checkConfigIntegrity(context.workingDir);
          if (!integrity.ok) {
            violations.push(
              typecheckViolation(
                context,
                `Config integrity violated: ${integrity.tampered.join("; ")}`
              )
            );
          }
        }
      } catch (cause) {
        violations.push(
          typecheckViolation(
            context,
            `Typecheck gate crashed: ${cause instanceof Error ? cause.message : String(cause)}`
          )
        );
      }
    }
    return violations;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function typecheckViolation(context: WorkspaceContext, message: string): LintViolation {
  return {
    ruleId: TYPECHECK_SENTINEL_RULE,
    message: truncate(message, 300),
    file: context.workingDir,
    line: 0,
    severity: "error",
    penalty: 0,
    action: "disqualify",
  };
}

interface RejectedStepInput {
  readonly context: WorkspaceContext;
  readonly opts?: EvaluateStepOptions;
  readonly startedAt: number;
  readonly iteration: number;
  readonly revertReason: string;
  readonly invariants: InvariantResult;
  readonly violations?: readonly LintViolation[];
}

/** Uniform rejection envelope for short-circuited stages (Score = -Infinity). */
function rejectedStep(input: RejectedStepInput): StepEvaluation {
  return {
    iteration: sanitizeIteration(input.iteration),
    fitnessScore: -Infinity,
    accepted: false,
    isSignificant: false,
    deltaPercent: 0,
    invariants: input.invariants,
    violations: [...(input.violations ?? [])],
    metrics: [],
    revertReason: input.revertReason,
    executionTimeMs: Date.now() - input.startedAt,
  };
}

function sanitizeIteration(iteration: number | undefined): number {
  if (iteration === undefined || typeof iteration !== "number" || !Number.isFinite(iteration)) {
    return 0;
  }
  return Math.max(0, Math.floor(iteration));
}

function truncate(text: string, limit: number = REJECT_MESSAGE_LIMIT): string {
  const raw = text.trim();
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}… [truncated]`;
}

/**
 * Defect-fallback extraction off an Effect Cause. Expected (typed) failures
 * never reach this — they are caught in-band with `Effect.catchIf`, so this
 * only has to be a best effort for genuine bugs.
 */
function describeExit(cause: unknown): string {
  if (Cause.isCause(cause)) {
    const reasons = cause.reasons;
    for (const reason of reasons) {
      const rec = reason as {
        readonly _tag?: string;
        readonly error?: unknown;
        readonly defect?: unknown;
      };
      if (rec._tag === "Fail" && rec.error !== undefined) {
        const msg = (rec.error as { readonly message?: unknown } | null)?.message;
        if (typeof msg === "string" && msg !== "") return msg;
        return String(rec.error);
      }
      if (rec._tag === "Die" && rec.defect !== undefined) {
        const msg = (rec.defect as { readonly message?: unknown } | null)?.message;
        if (typeof msg === "string" && msg !== "") return msg;
        return String(rec.defect);
      }
    }
    const pretty = Cause.pretty(cause);
    if (typeof pretty === "string" && pretty !== "") {
      return pretty;
    }
  }
  return "unknown pipeline defect";
}

/**
 * Resolve mutated file paths against the workspace dir, passing the absolute
 * paths through to the linter (absolute inputs are used as-is). Any path resolving
 * outside context.workingDir throws "Modified file outside workspace" (N7).
 */
function resolveModifiedFiles(
  context: WorkspaceContext,
  modifiedFiles: readonly string[]
): string[] {
  const baseDir = resolve(context.workingDir);
  return modifiedFiles.map((file) => {
    const resolved = isAbsolute(file) ? resolve(file) : resolve(baseDir, file);
    const rel = relative(baseDir, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`Modified file outside workspace: "${file}" resolves to "${resolved}"`);
    }
    return resolved;
  });
}

/**
 * Best-effort extraction of declared grade inputs: any file path token
 * appearing in the invariant command plus the explicit
 * `metrics[].harnessScripts` extension. Limitations are documented in the
 * class docblock: the frozen snapshot exists for tamper *verification*
 * (#13 `verifyFrozenHarness`), and the grading commands themselves still run
 * from the workspace cwd against the original files, whose integrity is
 * additionally protected by the linter's TypecheckGate when a project root
 * is configured.
 */
function extractFreezablePaths(config: PerfGymConfig): string[] {
  const candidates = new Set<string>();
  const command = config.invariants.command ?? "";
  for (const token of command.split(/[\s"'`]+/)) {
    if (token.startsWith("-")) continue; // CLI flags are not files
    if (FREEZABLE_FILE_REGEX.test(token)) {
      candidates.add(token.replace(/\\/g, "/"));
    }
  }
  for (const metric of config.metrics) {
    const scripts = (metric as { harnessScripts?: readonly string[] }).harnessScripts;
    for (const script of scripts ?? []) {
      if (typeof script === "string" && script !== "") {
        candidates.add(script.replace(/\\/g, "/"));
      }
    }
  }
  return [...candidates];
}

/** Restore write bits recursively so an old snapshot can be replaced/cleaned. */
function restoreWriteBits(dir: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        chmodSync(fullPath, 0o755);
        restoreWriteBits(fullPath);
      } else {
        chmodSync(fullPath, 0o644);
      }
    } catch {
      // best-effort restoration
    }
  }
  chmodSync(dir, 0o755);
}

/**
 * Recursively chmod files 0o444 and directories 0o555 so the entire frozen
 * harness snapshot is deeply read-only (M4).
 */
function makeReadOnlyRecursive(dir: string): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        makeReadOnlyRecursive(fullPath);
        chmodSync(fullPath, 0o555);
      } else {
        chmodSync(fullPath, 0o444);
      }
    } catch {
      // best-effort
    }
  }
  chmodSync(dir, 0o555);
}
