import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Effect, Exit } from "effect";
import {
  EvaluationPipeline,
  runInvariantGate,
  runBenchmark,
  NegativeMemoryCache,
  hashMutatedFiles,
  DEFAULT_NEGATIVE_MEMORY_ENTRIES,
  type PerfGymConfig,
  type StepEvaluation,
  type WorkspaceContext,
  type BenchmarkDistribution,
  type NegativeMemoryEntry,
  matchesGlob,
  SessionFileStore,
  type SessionLoadOutcome,
  type SerializedSessionState,
} from "../../core/src/index.js";
import { AstLinterEngine, DEFAULT_RULES, TypecheckGate } from "../../linter/src/index.js";
import { liveSessionFor } from "./live-session.js";

export interface PerfGymState {
  version: string;
  initializedAt: number;
  updatedAt: number;
  targetName: string;
  baselineMetrics: Record<string, number>;
  baselineDistributions?: Record<string, BenchmarkDistribution>;
  invariantsPassed: boolean;
  bestFitnessScore: number;
  acceptedStepCount: number;
  totalStepCount: number;
  /** The step of the best accepted evaluation (additive, #48 status parity). */
  bestStep?: number;
  lastCommitHash?: string;
  /**
   * Epoch milliseconds of the last write-through flush (Ticket #46). Additive:
   * older readers that ignore this field keep working.
   */
  lastUpdatedAt?: number;
  /**
   * The serialized live-session blob (Ticket #48): the bridge between the
   * in-process TanStack `SessionStore` and this durable cross-process
   * artifact. Written EXCLUSIVELY through `saveLiveSession` — the legacy
   * detached-snapshot path (see `legacyStateCopy`) never carries the key, so
   * a legacy writer cannot regress a live snapshot. `null` explicitly marks
   * "no live session".
   */
  session?: SerializedSessionState | null;
}

export type SupportedLanguage = "typescript" | "javascript" | "python" | "go" | "kotlin" | "rust";

/**
 * Detect language of project in root directory.
 */
export function detectProjectLanguage(rootDir: string): SupportedLanguage {
  if (fs.existsSync(path.join(rootDir, "tsconfig.json"))) return "typescript";
  if (fs.existsSync(path.join(rootDir, "Cargo.toml"))) return "rust";
  if (fs.existsSync(path.join(rootDir, "pyproject.toml")) || fs.existsSync(path.join(rootDir, "requirements.txt"))) return "python";
  if (fs.existsSync(path.join(rootDir, "go.mod"))) return "go";
  if (fs.existsSync(path.join(rootDir, "build.gradle.kts"))) return "kotlin";
  if (fs.existsSync(path.join(rootDir, "package.json"))) return "typescript";
  return "typescript";
}

/**
 * Generate starter .perfgym.yaml configuration.
 */
export function generateStarterConfig(language: SupportedLanguage = "typescript"): PerfGymConfig {
  let invariantCmd = "pnpm test";
  let metricCmd = "node benchmarks/run.js";

  if (language === "python") {
    invariantCmd = "pytest tests/";
    metricCmd = "python benchmarks/run.py";
  } else if (language === "rust") {
    invariantCmd = "cargo test";
    metricCmd = "cargo bench";
  } else if (language === "go") {
    invariantCmd = "go test ./...";
    metricCmd = "go test -bench=.";
  } else if (language === "kotlin") {
    invariantCmd = "./gradlew test";
    metricCmd = "./gradlew benchmark";
  }

  return {
    version: "1.0",
    target: {
      name: "default-target",
      language,
      files:
        language === "python"
          ? ["src/**/*.py"]
          : language === "rust"
          ? ["src/**/*.rs"]
          : language === "go"
          ? ["**/*.go"]
          : language === "kotlin"
          ? ["src/**/*.kt"]
          : ["src/**/*"],
    },
    invariants: {
      command: invariantCmd,
      timeoutMs: 15000,
    },
    metrics: [
      {
        name: "latency",
        command: metricCmd,
        goal: "minimize",
        weight: 1,
        unit: "ms",
      },
    ],
  };
}

export const STATE_PATH = path.join(".perfgym", "state.json");
export const NEGATIVE_MEMORY_PATH = path.join(".perfgym", "negative-memory.json");
export const CONFIG_FILE_NAME = ".perfgym.yaml";

/** A plain object (not an array, not null) — the shape of a YAML mapping. */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The capacity of the negative memory: a positive whole number, or the
 * documented default of 5 entries (the "top 5 anti-patterns" bound of
 * FLAW-13). Anything else — 0, a negative number, NaN, a non-numeric YAML
 * scalar, or a size that floors to 0 — falls back to the default instead of
 * producing a zero-capacity cache that would remember nothing at all.
 */
const resolveNegativeMemorySize = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_NEGATIVE_MEMORY_ENTRIES;
  }
  const floored = Math.floor(value);
  // A capacity below 1 entry would disable the feature silently — the
  // documented default is the better answer.
  return floored > 0 ? floored : DEFAULT_NEGATIVE_MEMORY_ENTRIES;
};

/**
 * Normalise the documented `agent_budget` block onto the camelCase
 * `agentBudget` shape of `PerfGymConfig`.
 *
 * The `agent_budget` block itself is documented in docs/SPECIFICATION.md §1
 * (`max_iterations`, `rollback_on_failure`); the `negative_memory_size` entry
 * inside it comes from the wayfinder map #66 GitHub issue (the bounded
 * negative memory of FLAW-13 — not docs/WAYFINDER_MAPS.md, which only
 * covers Maps 1–4). The YAML spells the block in snake_case while the
 * TypeScript config type is camelCase — both spellings are accepted here so
 * the documented configuration actually works.
 */
const normaliseAgentBudget = (config: Record<string, unknown>): PerfGymConfig["agentBudget"] => {
  const budget = asRecord(config.agentBudget ?? config.agent_budget);
  const size =
    budget === null ? undefined : (budget.negativeMemorySize ?? budget.negative_memory_size);

  // The block is untyped YAML: its other fields (e.g. the documented
  // `max_iterations` / `rollback_on_failure`) are carried through verbatim,
  // and only the memory size is normalised onto the typed shape.
  return {
    ...(budget ?? {}),
    negativeMemorySize: resolveNegativeMemorySize(size),
  } as PerfGymConfig["agentBudget"];
};

export function loadConfig(rootDir: string = process.cwd()): PerfGymConfig {
  const configPath = path.join(rootDir, CONFIG_FILE_NAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}. Run 'perfgym init' first.`);
  }
  const content = fs.readFileSync(configPath, "utf8");
  const parsed = asRecord(parseYaml(content) as unknown);
  if (parsed === null || !parsed.target || !parsed.invariants || !parsed.metrics) {
    throw new Error(`Invalid configuration format in ${configPath}`);
  }

  // The YAML is returned verbatim — the documented `agent_budget` block
  // (`max_iterations`, `rollback_on_failure`) survives as the user wrote it.
  // `agentBudget` is the normalised, typed view of the same block.
  const rawLlm = asRecord(parsed.llm);
  const normalisedLlm = rawLlm
    ? {
        driver: rawLlm.driver as any,
        provider: rawLlm.provider as string | undefined,
        model: rawLlm.model as string | undefined,
        baseUrl: (rawLlm.base_url ?? rawLlm.baseUrl) as string | undefined,
        apiKeyEnv: (rawLlm.api_key_env ?? rawLlm.apiKeyEnv) as string | undefined,
        cliCommand: (rawLlm.cli_command ?? rawLlm.cliCommand) as string | undefined,
        cliArgs: (rawLlm.cli_args ?? rawLlm.cliArgs) as string[] | undefined,
        timeoutMs: (rawLlm.timeout_ms ?? rawLlm.timeoutMs) as number | undefined,
        pricing: rawLlm.pricing as any,
      }
    : undefined;

  return {
    ...(parsed as unknown as PerfGymConfig),
    agentBudget: normaliseAgentBudget(parsed),
    ...(normalisedLlm ? { llm: normalisedLlm } : {}),
  };
}

// ============================================================================
// Negative memory — the bounded record of failed mutation strategies
// ============================================================================

/** The absolute path of the negative memory file of a project. */
export const negativeMemoryFilePath = (rootDir: string): string =>
  path.join(rootDir, NEGATIVE_MEMORY_PATH);

/**
 * Load the negative memory of one target.
 *
 * The capacity fallback lives HERE: a hand-built config may omit the
 * `agentBudget` block entirely, and the cache must still get the documented
 * default capacity. Every caller goes through this helper, so "which file,
 * which target, how many entries" is decided in exactly one place.
 */
export const loadNegativeMemory = (
  rootDir: string,
  target: string,
  maxEntries?: number,
): NegativeMemoryCache =>
  NegativeMemoryCache.load(
    negativeMemoryFilePath(rootDir),
    target,
    resolveNegativeMemorySize(maxEntries),
  );

/**
 * A short, human-readable label for the mutation strategy that failed.
 *
 * The mutation generator hands back file paths, not strategy names, so the
 * label is derived deterministically from the mutated paths (sorted, joined
 * with `", "`). The prompt builder (Map 7) will eventually name the
 * strategies itself; until then this keeps the memory inspectable.
 */
const describeMutationStrategy = (
  files: readonly { readonly relPath: string }[],
): string =>
  [...files.map((file) => file.relPath.replace(/\\/g, "/"))].sort().join(", ");

/** Everything a rejected step contributes to the negative memory. */
export interface NegativeMemoryRecord {
  /** The mutated files — their contents decide the dedup hash. */
  readonly files: readonly { readonly relPath: string; readonly content: string }[];
  /** The measured delta of the failed attempt. */
  readonly deltaPercent: number;
  /** The revert reason; a rejected step without one is remembered as "rejected". */
  readonly reason?: string;
  /** The iteration the attempt belongs to. */
  readonly step: number;
  /** Epoch milliseconds of the attempt (defaults to now). */
  readonly timestamp?: number;
}

/**
 * Build the compact fingerprint of a failed attempt:
 * `[Hash, FailedStrategyName, DeltaScore, BriefReason]` (FLAW-13).
 */
const buildNegativeMemoryEntry = (record: NegativeMemoryRecord): NegativeMemoryEntry => {
  // A blank (whitespace-only) reason carries no information — the entry
  // falls back to the generic "rejected".
  const reason = record.reason?.trim() ?? "";

  return {
    id: hashMutatedFiles(record.files),
    strategy: describeMutationStrategy(record.files),
    deltaPercent: record.deltaPercent,
    reason: reason.length > 0 ? reason : "rejected",
    step: record.step,
    timestamp: record.timestamp ?? Date.now(),
  };
};

/**
 * Remember a failed attempt in the negative memory.
 *
 * One place builds the fingerprint and records it, so the optimization loop
 * and the manual `perfgym step` cannot drift apart.
 */
export const recordNegativeMemory = (
  cache: NegativeMemoryCache,
  failure: NegativeMemoryRecord,
): void => {
  cache.record(buildNegativeMemoryEntry(failure));
};

/** Read a file's contents, tolerating a file that disappeared in the meantime. */
const readFileIfPresent = (absolutePath: string): string | null => {
  try {
    return fs.readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }
};

// ============================================================================
// Session state accessors (Ticket #46)
//
// The SessionFileStore is the live state of a session and
// `.perfgym/state.json` is the durable cross-process artifact. Every state
// read/write goes through a store-backed accessor: reads construct (or reuse)
// the store built from the file, writes mutate in memory and are flushed
// atomically (temp file + rename) with a merge-on-write, so a field a
// concurrent process has updated is never clobbered.
// ============================================================================

/** The absolute path of the durable session state file of a project root. */
export const stateFilePath = (rootDir: string): string => path.join(rootDir, STATE_PATH);

/**
 * A clean, fresh session — the reset target when the durable file is corrupt
 * (Ticket #46: a corrupt state file is handled, never fatal). This shape is
 * what the STORE falls back to internally; the engine accessors never leak it
 * to a caller as an initialized session (see `loadSession`).
 */
export const cleanPerfGymSession = (): PerfGymState => ({
  version: "1.0",
  initializedAt: Date.now(),
  updatedAt: Date.now(),
  targetName: "",
  baselineMetrics: {},
  invariantsPassed: false,
  bestFitnessScore: 0,
  acceptedStepCount: 0,
  totalStepCount: 0,
});

/**
 * One SessionFileStore per project root for the lifetime of the process: the
 * live session state. The store is created WITHOUT reading the file — the
 * first `loadSession` call does the durable read — so a `saveSession`
 * without a prior load (e.g. `runBaseline` seeding a fresh session) performs
 * a full overwrite.
 */
const sessionStores = new Map<string, SessionFileStore<PerfGymState>>();

const sessionStoreFor = (rootDir: string): SessionFileStore<PerfGymState> => {
  const filePath = stateFilePath(rootDir);
  const cached = sessionStores.get(filePath);
  if (cached) return cached;
  const created = new SessionFileStore<PerfGymState>({
    filePath,
    initial: cleanPerfGymSession(),
  });
  sessionStores.set(filePath, created);
  return created;
};

/**
 * Load the session state of a project root.
 *
 * Returns null when the session was never initialized (no state file) AND
 * when the durable file is corrupt: a corrupt file resets the underlying
 * store to a clean session without crashing (#46), but it must never
 * impersonate an initialized session — every "No baseline found" guard keeps
 * firing, so `runStep` / the coordinator refuse to evaluate against a
 * nonexistent baseline instead of silently overwriting the file.
 */
export function loadSession(rootDir: string = process.cwd()): PerfGymState | null {
  const store = sessionStoreFor(rootDir);
  const outcome = store.reload();
  return outcome === "loaded" ? store.snapshot() : null;
}

/**
 * The corrupt-file signal of the durable session file (#46): observable
 * without crashing. `"reset-corrupt"` means the file was unparseable and was
 * handled by resetting the store to a clean session; `"absent"` means the
 * session was never initialized; `"loaded"` means a real session exists.
 */
export function sessionFileOutcome(rootDir: string = process.cwd()): SessionLoadOutcome {
  return sessionStoreFor(rootDir).reload();
}

/**
 * Save session state (write-through): mutates the in-memory store and flushes
 * atomically. The flush re-reads the durable file, merges the fields this
 * process actually changed, stamps `lastUpdatedAt`, and renames a temp file
 * over the target — a torn write is impossible.
 */
export function saveSession(rootDir: string = process.cwd(), state: PerfGymState): PerfGymState {
  return sessionStoreFor(rootDir).save(state);
}

// ============================================================================
// Live-session bridge (Ticket #48)
//
// The TanStack `SessionStore` (packages/core/src/store/index.ts) is the live
// session state; this file is the durable artifact. Everything a legacy
// reader ("history", counters, metrics) is written through `saveSession`
// (merge-on-flush), and the live-session blob is written EXCLUSIVELY through
// `saveLiveSession`, so the two paths never clobber each other.
// ============================================================================

/**
 * A detached, writable LEGACY snapshot of the session file for the
 * load-mutate-`saveSession` pattern. The `session` key is physically deleted:
 * a stale blob on an old snapshot must never be persisted over the live
 * one — the live blob is owned solely by `saveLiveSession`.
 */
export function legacyStateCopy(state: PerfGymState): PerfGymState {
  if (!("session" in state)) return { ...state };
  const copy = { ...state } as PerfGymState & { session?: unknown };
  delete (copy as { session?: unknown }).session;
  return copy;
}

/**
 * Persist (or explicitly clear) the serialized live-session blob through the
 * ONE write path of the state file. Everything else on disk survives: the
 * shared `SessionFileStore` re-reads the file and merges only the fields
 * this call actually changed. A store without a real loaded session writes
 * nothing — a live flush must never fabricate a state file. The state file
 * is created by the baseline's `saveSession` (CR3 of the #48 review), never
 * by a live flush. Returns whether the blob was actually persisted.
 */
export function saveLiveSession(rootDir: string = process.cwd(), session: SerializedSessionState | null): boolean {
  const store = sessionStoreFor(rootDir);
  // A live flush must never fabricate a state file out of an absent store.
  if (store.loadOutcome !== "loaded") return false;
  store.update((prev) => ({ ...prev, session }));
  store.flush();
  return true;
}

export interface InitOptions {
  cwd?: string;
  force?: boolean;
}

export function runInit(options: InitOptions = {}): {
  success: boolean;
  message: string;
  configPath: string;
  config?: PerfGymConfig;
} {
  const cwd = options.cwd ?? process.cwd();
  const configPath = path.join(cwd, CONFIG_FILE_NAME);

  if (fs.existsSync(configPath) && !options.force) {
    return {
      success: false,
      message: `Configuration file ${CONFIG_FILE_NAME} already exists. Use --force to overwrite.`,
      configPath,
    };
  }

  const lang = detectProjectLanguage(cwd);
  const config = generateStarterConfig(lang);
  const yamlStr = stringifyYaml(config);
  fs.writeFileSync(configPath, yamlStr, "utf8");

  return {
    success: true,
    message: `Initialized ${CONFIG_FILE_NAME} with ${lang} preset.`,
    configPath,
    config,
  };
}

export interface BaselineOptions {
  cwd?: string;
  samples?: number;
}

export type BaselineResult =
  | {
      success: true;
      state: PerfGymState;
    }
  | {
      success: false;
      state?: undefined;
      error: string;
    };

export async function runBaseline(options: BaselineOptions = {}): Promise<BaselineResult> {
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(cwd);

  // 1. Run invariant gate
  const invariantExit = await Effect.runPromiseExit(
    runInvariantGate({
      command: config.invariants.command,
      cwd,
      timeoutMs: config.invariants.timeoutMs,
    })
  );

  if (Exit.isFailure(invariantExit)) {
    const err = invariantExit.cause;
    return {
      success: false,
      error: `Invariants gate failed: ${err}`,
    };
  }

  const invariantRes = invariantExit.value;
  if (!invariantRes.passed) {
    return {
      success: false,
      error: `Invariants gate failed: ${invariantRes.output}`,
    };
  }

  // 2. Measure baseline benchmark distributions
  const baselineMetrics: Record<string, number> = {};
  const baselineDistributions: Record<string, BenchmarkDistribution> = {};

  for (const metric of config.metrics) {
    const benchExit = await Effect.runPromiseExit(
      runBenchmark({
        command: metric.command,
        cwd,
        samples: options.samples ?? 5,
        unit: metric.unit ?? "count",
        ...(metric.timeoutMs !== undefined ? { timeoutMs: metric.timeoutMs } : {}),
      })
    );

    if (Exit.isFailure(benchExit)) {
      return {
        success: false,
        error: `Benchmark '${metric.name}' failed during baseline measurement: ${benchExit.cause}`,
      };
    }

    const dist = benchExit.value;
    baselineDistributions[metric.name] = dist;
    baselineMetrics[metric.name] = dist.p50;
  }

  const state: PerfGymState = {
    version: config.version || "0.1.0",
    initializedAt: Date.now(),
    updatedAt: Date.now(),
    targetName: config.target.name,
    baselineMetrics,
    baselineDistributions,
    invariantsPassed: true,
    bestFitnessScore: 0,
    acceptedStepCount: 0,
    totalStepCount: 0,
  };

  const saved = saveSession(cwd, state);

  return {
    success: true,
    state: saved,
  };
}

export interface StepOptions {
  cwd?: string;
  files?: string[];
  samples?: number;
  minSignificanceDelta?: number;
  /**
   * Opt-in: remember a rejected step in the negative memory cache.
   *
   * `perfgym step` never records by default — the optimization loop owns the
   * cache — so the flag has to be passed explicitly.
   */
  recordNegativeMemory?: boolean;
}

export interface StepResult {
  success: boolean;
  evaluation: StepEvaluation;
}

export async function runStep(options: StepOptions = {}): Promise<StepResult> {
  const cwd = options.cwd ?? process.cwd();
  const config = loadConfig(cwd);
  const state = loadSession(cwd);

  if (!state) {
    throw new Error("No baseline found in .perfgym/state.json. Run 'perfgym baseline' first.");
  }

  // Modified files detection or passed explicitly
  let modifiedFiles = options.files;
  if (!modifiedFiles || modifiedFiles.length === 0) {
    // Determine modified files using git status
    try {
      const { execFileSync } = await import("node:child_process");
      const statusOut = execFileSync("git", ["status", "--porcelain"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const lines = statusOut.split(/\r?\n/).filter((l) => l.trim().length > 0);
      modifiedFiles = lines
        .map((l) => {
          const status = l.slice(0, 2);
          if (status.includes("D")) return null;
          const raw = l.slice(3).trim();
          return raw.includes(" -> ") ? raw.split(" -> ")[1].trim() : raw;
        })
        .filter((file): file is string =>
          typeof file === "string" &&
          file.length > 0 &&
          !file.startsWith(".perfgym") &&
          fs.existsSync(path.resolve(cwd, file)) &&
          config.target.files.some((pattern) => matchesGlob(pattern, file))
        );
    } catch {
      modifiedFiles = [];
    }
  } else {
    // Sanitize user-provided files: filter existing files matching target
    modifiedFiles = modifiedFiles.filter((file: string) =>
      fs.existsSync(path.resolve(cwd, file)) &&
      config.target.files.some((pattern) => matchesGlob(pattern, file))
    );
  }

  const linter = new AstLinterEngine(DEFAULT_RULES, cwd);
  const typechecker = new TypecheckGate(cwd);
  const pipeline = new EvaluationPipeline(config, linter, typechecker);

  const context: WorkspaceContext = {
    runId: `step-${Date.now()}`,
    workingDir: cwd,
    branchName: "current",
    baseRef: "HEAD",
  };

  const primaryMetricName = config.metrics[0]?.name;
  const primaryBaselineDist = primaryMetricName ? state.baselineDistributions?.[primaryMetricName] : undefined;

  const evaluation = await pipeline.evaluateStep(context, modifiedFiles, {
    baseline: primaryBaselineDist,
    baselineMetrics: state.baselineMetrics,
    iteration: state.totalStepCount + 1,
    samples: options.samples ?? 5,
    minSignificanceDelta: options.minSignificanceDelta,
  });

  // Update state
  state.totalStepCount += 1;
  state.updatedAt = Date.now();
  if (evaluation.accepted && evaluation.fitnessScore > state.bestFitnessScore) {
    state.bestFitnessScore = evaluation.fitnessScore;
    state.bestStep = evaluation.iteration;
    state.acceptedStepCount += 1;
  }
  // The legacy snapshot never carries the `session` blob — the live-session
  // path owns it (Ticket #48), so a stale blob must not regress the file.
  // Take the handle first: saveSession drops the on-disk blob, and a later
  // liveSessionFor would then re-read a blob-less file.
  const live = liveSessionFor(cwd);
  saveSession(cwd, legacyStateCopy(state));
  live.recordStep(evaluation);
  if (!evaluation.accepted) {
    live.markStepRolledBack(evaluation.iteration);
  }

  // Negative memory — opt-in only, and only for a REJECTED step: the memory
  // holds failures, and an accepted step is not one. `perfgym step` discovers
  // the modified files as paths only, so their contents are read from disk to
  // compute the content hash.
  if (options.recordNegativeMemory === true && !evaluation.accepted) {
    const mutated = modifiedFiles
      .map((relPath) => {
        const content = readFileIfPresent(path.resolve(cwd, relPath));
        return content === null ? null : { relPath, content };
      })
      .filter((file): file is { relPath: string; content: string } => file !== null);

    if (mutated.length > 0) {
      const cache = loadNegativeMemory(
        cwd,
        config.target.name,
        config.agentBudget?.negativeMemorySize,
      );
      recordNegativeMemory(cache, {
        files: mutated,
        deltaPercent: evaluation.deltaPercent,
        ...(evaluation.revertReason !== undefined ? { reason: evaluation.revertReason } : {}),
        step: evaluation.iteration,
      });
      cache.save(negativeMemoryFilePath(cwd));
    } else {
      // The user asked to record a failure, but none of the modified paths
      // could be read (an ancestor vanished, the tree was reverted, or the
      // path is not a file). Writing an entry for nothing is not useful, but
      // the skip must not be silent: say what happened and why.
      console.warn(
        `⚠ Negative memory not recorded: could not read any of the ${modifiedFiles.length} modified file(s); nothing was recorded.`,
      );
    }
  }

  return {
    success: evaluation.accepted,
    evaluation,
  };
}
