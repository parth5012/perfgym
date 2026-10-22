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
} from "../../core/src/index.js";
import { AstLinterEngine, DEFAULT_RULES, TypecheckGate } from "../../linter/src/index.js";

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
  lastCommitHash?: string;
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
  return {
    ...(parsed as unknown as PerfGymConfig),
    agentBudget: normaliseAgentBudget(parsed),
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

export function readState(rootDir: string = process.cwd()): PerfGymState | null {
  const stateFile = path.join(rootDir, STATE_PATH);
  if (!fs.existsSync(stateFile)) return null;
  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    return JSON.parse(raw) as PerfGymState;
  } catch {
    return null;
  }
}

export function writeState(rootDir: string = process.cwd(), state: PerfGymState): void {
  const stateFile = path.join(rootDir, STATE_PATH);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
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

  writeState(cwd, state);

  return {
    success: true,
    state,
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
  const state = readState(cwd);

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
    state.acceptedStepCount += 1;
  }
  writeState(cwd, state);

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
    }
  }

  return {
    success: evaluation.accepted,
    evaluation,
  };
}
