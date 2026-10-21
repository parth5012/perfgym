import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Effect, Exit } from "effect";
import {
  EvaluationPipeline,
  runInvariantGate,
  runBenchmark,
  type PerfGymConfig,
  type StepEvaluation,
  type WorkspaceContext,
  type BenchmarkDistribution,
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
export const CONFIG_FILE_NAME = ".perfgym.yaml";

export function loadConfig(rootDir: string = process.cwd()): PerfGymConfig {
  const configPath = path.join(rootDir, CONFIG_FILE_NAME);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}. Run 'perfgym init' first.`);
  }
  const content = fs.readFileSync(configPath, "utf8");
  const parsed = parseYaml(content) as PerfGymConfig;
  if (!parsed || !parsed.target || !parsed.invariants || !parsed.metrics) {
    throw new Error(`Invalid configuration format in ${configPath}`);
  }
  return parsed;
}

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

  return {
    success: evaluation.accepted,
    evaluation,
  };
}
