import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Cause, Effect, Exit, Fiber, Option } from "effect";
import {
  EvaluationPipeline,
  runInvariantGate,
  runBenchmark,
  NegativeMemoryCache,
  hashMutatedFiles,
  DEFAULT_NEGATIVE_MEMORY_ENTRIES,
  ConfigError,
  ERR_CONFIG,
  type PerfGymConfig,
  type StepEvaluation,
  type WorkspaceContext,
  type BenchmarkDistribution,
  type NegativeMemoryEntry,
  matchesGlob,
  SessionFileStore,
  stripAnsiDeep,
  type SessionLoadOutcome,
  type SerializedSessionState,
  resolveCommandExecutor,
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
    sandbox: {
      command_backend: "auto",
    },
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

/**
 * Normalise the documented `benchmark` block onto the camelCase
 * `PerfGymConfig["benchmark"]` shape (ticket #53). The YAML spells the
 * warm-up count `benchmark.warmup_iterations` (snake_case, matching the
 * `agent_budget` convention); both spellings are accepted. A non-numeric
 * value is dropped so the runner's `resolveWarmupCount` default of 5
 * applies; out-of-range numbers are clamped by that same resolver.
 * Absent block ⇒ absent view (no phantom config).
 */
const normaliseBenchmark = (config: Record<string, unknown>): PerfGymConfig["benchmark"] => {
  const block = asRecord(config.benchmark);
  if (block === null) return undefined;
  const raw = block.warmupIterations ?? block.warmup_iterations;
  return {
    ...block,
    ...(typeof raw === "number" ? { warmupIterations: raw } : {}),
  } as PerfGymConfig["benchmark"];
};

/**
 * Normalise the documented per-metric `require_checksum` flag (snake_case,
 * ticket #54) onto the camelCase `requireChecksum` field of the typed metric
 * shape. Strict opt-in: the flag only appears when the YAML carries it —
 * absent key ⇒ absent field (never defaulted into enforcement). A
 * non-boolean value is dropped so the runner's default (no enforcement)
 * applies.
 */
const normaliseMetrics = (config: Record<string, unknown>): PerfGymConfig["metrics"] => {
  const metrics = Array.isArray(config.metrics) ? config.metrics : [];
  return metrics.map((entry) => {
    const metric = asRecord(entry) ?? {};
    const flag = metric.requireChecksum ?? metric.require_checksum;
    // `timeout_ms` is the documented YAML spelling (SPECIFICATION.md); both
    // spellings are accepted. A non-numeric value is dropped so the runner's
    // default timeout applies.
    const timeout = metric.timeoutMs ?? metric.timeout_ms;
    return {
      ...metric,
      ...(typeof flag === "boolean" ? { requireChecksum: flag } : {}),
      ...(typeof timeout === "number" ? { timeoutMs: timeout } : {}),
    } as PerfGymConfig["metrics"][number];
  });
};

/**
 * Normalise the documented `sandbox.command_backend` config (ticket #56).
 * Accepts both snake_case `command_backend` and camelCase `commandBackend`.
 * Defaults to "auto".
 */
const normaliseSandbox = (config: Record<string, unknown>): PerfGymConfig["sandbox"] => {
  const block = asRecord(config.sandbox);
  const raw = block ? (block.commandBackend ?? block.command_backend) : undefined;
  const valid = ["auto", "node-permission", "mxc", "bwrap", "none"] as const;
  const backend = typeof raw === "string" && (valid as readonly string[]).includes(raw)
    ? (raw as NonNullable<PerfGymConfig["sandbox"]>["command_backend"])
    : "auto";
  return {
    ...(block ?? {}),
    commandBackend: backend,
    command_backend: backend,
  };
};

export function loadConfig(rootDir: string = process.cwd()): PerfGymConfig {
  const configPath = path.join(rootDir, CONFIG_FILE_NAME);
  if (!fs.existsSync(configPath)) {
    // A missing config is a usage/config failure (exit code 2), so it is a
    // tagged domain error rather than a bare Error (Ticket #51).
    throw new ConfigError({
      code: ERR_CONFIG,
      configPath,
      reason: "missing",
      message: `Configuration file not found: ${configPath}. Run 'perfgym init' first.`,
    });
  }
  const content = fs.readFileSync(configPath, "utf8");
  const parsed = asRecord(parseYaml(content) as unknown);
  if (parsed === null || !parsed.target || !parsed.invariants || !parsed.metrics) {
    throw new ConfigError({
      code: ERR_CONFIG,
      configPath,
      reason: "invalid",
      message: `Invalid configuration format in ${configPath}`,
    });
  }

  // The YAML is returned verbatim — the documented `agent_budget` block
  // (`max_iterations`, `rollback_on_failure`) survives as the user wrote it.
  // `agentBudget` is the normalised, typed view of the same block; the same
  // applies to `benchmark.warmup_iterations` → `benchmark.warmupIterations`.
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
  const normalisedBenchmark = normaliseBenchmark(parsed);
  const normalisedMetrics = normaliseMetrics(parsed);
  const normalisedSandbox = normaliseSandbox(parsed);

  return {
    ...(parsed as unknown as PerfGymConfig),
    metrics: normalisedMetrics,
    agentBudget: normaliseAgentBudget(parsed),
    sandbox: normalisedSandbox,
    ...(normalisedLlm ? { llm: normalisedLlm } : {}),
    ...(normalisedBenchmark ? { benchmark: normalisedBenchmark } : {}),
    // `floorCoefficient` (ticket #52) is a top-level typed field; the YAML
    // convention is snake_case (matching `agent_budget`/`require_checksum`),
    // so both spellings are accepted. A non-numeric value is dropped so the
    // runner default (0.01) applies — `effectiveTailMad` re-clamps anyway.
    ...((parsed.floorCoefficient ?? parsed.floor_coefficient) !== undefined &&
    typeof (parsed.floorCoefficient ?? parsed.floor_coefficient) === "number"
      ? { floorCoefficient: (parsed.floorCoefficient ?? parsed.floor_coefficient) as number }
      : {}),
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

/**
 * Establish (or re-establish) the baseline of a project.
 *
 * Returns an EFFECT — like every other command handler after Ticket #51 —
 * so the edge (`runEffect`) decides how it executes and renders. The two
 * gate/benchmark sub-programs are observed through `Effect.exit`, keeping the
 * original "reported outcome, not a thrown error" contract of this function.
 */
export function runBaseline(
  options: BaselineOptions = {},
): Effect.Effect<BaselineResult, never, never> {
  return Effect.gen(function* () {
    const cwd = options.cwd ?? process.cwd();
    const config = loadConfig(cwd);

    // 1. Run invariant gate
    const invariantExit = yield* Effect.exit(
      runInvariantGate({
        command: config.invariants.command,
        cwd,
        timeoutMs: config.invariants.timeoutMs,
      }),
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
      const benchExit = yield* Effect.exit(
        runBenchmark({
          command: metric.command,
          cwd,
          samples: options.samples ?? 5,
          warmup: config.benchmark?.warmupIterations,
          unit: metric.unit ?? "count",
          ...(metric.timeoutMs !== undefined ? { timeoutMs: metric.timeoutMs } : {}),
          // Ticket #54 (FLAW-10): strict per-metric checksum opt-in.
          ...(metric.requireChecksum === true ? { requireChecksum: true } : {}),
        }),
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
  });
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

  const executor = resolveCommandExecutor({
    backend: config.sandbox?.commandBackend ?? config.sandbox?.command_backend,
  });
  const linter = new AstLinterEngine(DEFAULT_RULES, cwd, executor);
  const typechecker = new TypecheckGate(cwd, executor);
  const pipeline = new EvaluationPipeline(config, linter, typechecker, executor);

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
    ...(config.floorCoefficient !== undefined
      ? { floorCoefficient: config.floorCoefficient }
      : {}),
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

// ============================================================================
// The Effect edge runner (Ticket #51)
//
// ONE place executes Effect programs in production: the CLI and MCP edges
// call `runEffect`, which owns interruption (SIGINT/SIGTERM), outcome
// mapping, and the exit-code contract. Domain code hands back Effects and
// never runs them itself.
// ============================================================================

/** 0 — the program succeeded. */
export const EXIT_SUCCESS = 0;
/** 1 — generic domain error (anything without a more specific class). */
export const EXIT_FAILURE = 1;
/** 2 — usage / configuration error (bad args, missing config, missing API key). */
export const EXIT_USAGE = 2;
/** 3 — the sandbox lock is held by someone else. */
export const EXIT_LOCK_BUSY = 3;
/** 4 — sandbox / integrity violation (traversal, tampering, disqualification). */
export const EXIT_SANDBOX_VIOLATION = 4;
/** 5 — external tool failure (git, tsc, benchmark / invariant command). */
export const EXIT_EXTERNAL_TOOL = 5;
/** 130 — 128 + SIGINT: the run was interrupted by Ctrl-C / SIGTERM. */
export const EXIT_INTERRUPTED = 130;

/**
 * The documented error-class → exit-code table (AC1). Keyed on `_tag`
 * (Effect `Data.TaggedError`) or, for plain Errors, on `name`.
 *
 * Deliberately a MAP and not a chain of instanceof checks: the mapping is
 * data, reviewable at a glance, and a class nobody listed falls through to
 * the generic `1` instead of silently inheriting an unrelated code.
 */
const EXIT_CODE_BY_ERROR_KIND: Readonly<Record<string, number>> = {
  // 1 — generic domain error (map #70): named here so the intent is explicit;
  // every class absent from this map falls through to the same generic 1.
  FileNotFoundError: EXIT_FAILURE,
  SandboxLockNotHeldError: EXIT_FAILURE,
  // 2 — usage / config
  ConfigError: EXIT_USAGE,
  UnknownFormatError: EXIT_USAGE,
  MissingApiKeyError: EXIT_USAGE,
  UnknownDriverError: EXIT_USAGE,
  InvalidRunIdError: EXIT_USAGE,
  InvalidStepOptionError: EXIT_USAGE,
  // 3 — lock busy
  SandboxLockBusyError: EXIT_LOCK_BUSY,
  // 4 — sandbox / integrity
  PathTraversalError: EXIT_SANDBOX_VIOLATION,
  PathOutsideTargetError: EXIT_SANDBOX_VIOLATION,
  TamperingError: EXIT_SANDBOX_VIOLATION,
  DisqualificationError: EXIT_SANDBOX_VIOLATION,
  WorktreeDiskBudgetExceededError: EXIT_SANDBOX_VIOLATION,
  // 5 — external tool failures
  GitCommandError: EXIT_EXTERNAL_TOOL,
  WorktreeNotFoundError: EXIT_EXTERNAL_TOOL,
  TypecheckError: EXIT_EXTERNAL_TOOL,
  InvariantFailureError: EXIT_EXTERNAL_TOOL,
  BenchmarkExecutionError: EXIT_EXTERNAL_TOOL,
  LlmDriverError: EXIT_EXTERNAL_TOOL,
  LlmFatalError: EXIT_EXTERNAL_TOOL,
};

/**
 * The `kind` of an error: the Effect `_tag` when present, otherwise the
 * `name` of an Error, otherwise undefined (a non-error value).
 */
const errorKind = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { _tag?: unknown; name?: unknown };
  if (typeof candidate._tag === "string") return candidate._tag;
  if (typeof candidate.name === "string") return candidate.name;
  return undefined;
};

/**
 * Map any thrown value onto the documented exit-code contract:
 * 0 success is never derived from an error; everything unmapped is the
 * generic domain failure `1`.
 */
export const exitCodeForError = (error: unknown): number => {
  const kind = errorKind(error);
  if (kind !== undefined) {
    const mapped = EXIT_CODE_BY_ERROR_KIND[kind];
    if (mapped !== undefined) return mapped;
  }
  return EXIT_FAILURE;
};

/** ANSI CSI sequences (colour is never part of a structured error document). */
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** The four-key payload of the JSON error document (AC2). */
export interface StructuredError {
  readonly code: string;
  readonly kind: string;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

/**
 * Build `{ error: { code, kind, message, details } }` for any thrown value.
 *
 * - `code`: the domain error's own `code`, falling back to `_tag` (the same
 *   precedence the shared formatter uses), then `ERR_UNKNOWN`.
 * - `kind`: `_tag` / `name` — the error CLASS, never a stack.
 * - `details`: the error's own enumerable payload minus the four envelope
 *   keys (and `cause`), so nothing inlined into a message can smuggle frames.
 *   Values that cannot survive JSON (circular, functions) are dropped so the
 *   rendered document and the object MCP serialises are always identical.
 */
export const structuredError = (error: unknown): { error: StructuredError } => {
  const kind =
    errorKind(error) ?? (typeof error === "object" && error !== null ? "UnknownError" : "Error");

  let code = "ERR_UNKNOWN";
  let details: Record<string, unknown> = {};
  let message = "";

  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; _tag?: unknown; message?: unknown };
    if (typeof candidate.code === "string" && candidate.code.length > 0) {
      code = candidate.code;
    } else if (typeof candidate._tag === "string" && candidate._tag.length > 0) {
      code = candidate._tag;
    }
    if (typeof candidate.message === "string") {
      message = candidate.message;
    }

    const skip = new Set(["code", "_tag", "message", "name", "stack", "cause"]);
    details = {};
    for (const key of Object.keys(error)) {
      if (skip.has(key)) continue;
      const value = (error as Record<string, unknown>)[key];
      // Drop what JSON cannot carry — a document that renders is worth more
      // than a key that makes JSON.stringify (or MCP serialisation) throw.
      try {
        if (JSON.stringify(value) === undefined) continue;
      } catch {
        continue;
      }
      // Detail values are cleaned at the source too: `JSON.stringify` writes
      // ESC as `\u001b`, so a post-serialization strip never matches, and a
      // consumer's `JSON.parse` would otherwise see raw ANSI (AC2).
      details[key] = stripAnsiDeep(value);
    }
  } else if (typeof error === "string") {
    message = error;
  } else {
    message = String(error);
  }

  if (message.length === 0 && typeof error === "object" && error !== null) {
    message = String(error);
  }

  // ANSI never survives into a structured document: `JSON.stringify` escapes
  // the ESC byte as `\u001b`, so stripping AFTER serialization misses it —
  // the message is cleaned here, at the source (AC2).
  message = message.replace(ANSI_PATTERN, "");

  return {
    error: {
      code,
      kind,
      message,
      details,
    },
  };
};

/**
 * Render the structured error as a JSON document — the ONLY shape a
 * `--format json` failure (and an MCP tool failure) ever takes. No stack
 * trace, no ANSI: both are stripped at this single choke point.
 */
export const renderStructuredError = (error: unknown): string => {
  let raw: string;
  try {
    raw = JSON.stringify(structuredError(error));
  } catch {
    raw = JSON.stringify({
      error: { code: "ERR_UNKNOWN", kind: "Error", message: String(error), details: {} },
    });
  }
  return raw.replace(ANSI_PATTERN, "");
};

export interface RunEffectOptions {
  /** Called once for a failed (non-interrupted) program, before the outcome resolves. */
  readonly onError?: (error: unknown, exitCode: number) => void;
  /**
   * Install SIGINT/SIGTERM handlers that interrupt the program's fiber, so
   * `Effect.acquireRelease` finalizers run before the outcome resolves.
   * Opt-in: unit tests and embedding callers keep Node's default behaviour.
   */
  readonly signals?: boolean;
}

/** The terminal state of one `runEffect` call — a discriminated union. */
export type RunOutcome<A> =
  | { readonly status: "success"; readonly value: A; readonly exitCode: typeof EXIT_SUCCESS }
  | { readonly status: "failure"; readonly error: unknown; readonly exitCode: number }
  | { readonly status: "interrupted"; readonly exitCode: typeof EXIT_INTERRUPTED };

/**
 * The one edge at which Effect programs execute (Ticket #51).
 *
 * Runs `program` on a forked fiber so a signal can interrupt it:
 *
 * - **success** → `{ status: "success", value, exitCode: 0 }`;
 * - **failure** → `onError(error, exitCodeForError(error))` is invoked and a
 *   `{ status: "failure", error, exitCode }` outcome resolves — a typed
 *   domain failure wins over any defect raised while unwinding;
 * - **SIGINT/SIGTERM** → the fiber is interrupted, `acquireRelease`
 *   finalizers run to completion, and the outcome is
 *   `{ status: "interrupted", exitCode: 130 }`.
 *
 * The caller decides how to render (JSON vs markdown) and how to exit;
 * `runEffect` itself never writes output and never calls `process.exit`.
 */
export const runEffect = <A>(
  program: Effect.Effect<A, unknown, never>,
  options: RunEffectOptions = {},
): Promise<RunOutcome<A>> =>
  (async (): Promise<RunOutcome<A>> => {
    const signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    let interruptedBySignal = false;
    // The interrupt action is wired AFTER the fork (it closes over the fiber)
    // but the LISTENERS are installed BEFORE it: `Effect.runFork` executes the
    // program synchronously up to its first async boundary, and the run's
    // git-worktree acquisition is synchronous. A Ctrl-C landing in that window
    // must still find a SIGINT listener — otherwise Node's default action kills
    // the process with the sandbox still held (stale lock + orphaned worktree,
    // the exact bug AC4 covers). The listener body can only run on an event
    // loop turn, i.e. after `runFork` returned, so `interrupt` is always set.
    let interrupt: (() => void) | null = null;
    const onSignal = (): void => {
      interruptedBySignal = true;
      interrupt?.();
    };
    if (options.signals === true) {
      for (const signal of signals) process.on(signal, onSignal);
    }

    const fail = (error: unknown): RunOutcome<A> => {
      const exitCode = exitCodeForError(error);
      options.onError?.(error, exitCode);
      return { status: "failure", error, exitCode };
    };

    try {
      const fiber = Effect.runFork(program);
      // Interrupting waits for the finalizers: by the time this settles the
      // sandbox release has already run.
      interrupt = (): void => {
        void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {
          // The fiber may already be done — nothing to interrupt.
        });
      };

      const exit: Exit.Exit<A, unknown> = await Effect.runPromise(Fiber.await(fiber));
      if (Exit.isSuccess(exit)) {
        return { status: "success", value: exit.value, exitCode: EXIT_SUCCESS };
      }

      // 1. A typed domain failure is the run's own verdict.
      const failure = Cause.findErrorOption(exit.cause);
      if (Option.isSome(failure)) {
        return fail(failure.value);
      }
      // 2. Ctrl-C: no domain failure — the interruption IS the outcome.
      if (interruptedBySignal) {
        return { status: "interrupted", exitCode: EXIT_INTERRUPTED };
      }
      // 3. A defect (e.g. an unexpected throw): squashed back to its value so
      //    domain error classes still map to their documented exit code.
      return fail(Cause.squash(exit.cause));
    } finally {
      if (options.signals === true) {
        for (const signal of signals) process.off(signal, onSignal);
      }
    }
  })();

