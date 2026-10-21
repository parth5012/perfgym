#!/usr/bin/env node
/**
 * @perfgym/cli
 * CLI Entrypoint for PerfGym
 *
 * Every command renders through the shared `OutputFormatter` seam and accepts
 * `--format <markdown|json>` plus `--color <auto|always|never>`. Chalk is
 * applied *around* the finished formatter string — never inside the formatter
 * — and never at all in JSON mode, so machine consumers get clean text.
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  createFormatter,
  ERR_UNKNOWN_FORMAT,
  UnknownFormatError,
  type OutputFormatter,
  type OutputFormat,
} from "../../core/src/index.js";
import { loadConfig, runInit, runBaseline, runStep } from "./engine.js";
import { runOptimizationLoop } from "./commands/run.js";

type ColorMode = "auto" | "always" | "never";

interface OutputOptions {
  format?: string;
  color?: string;
}

const OUTPUT_OPTIONS = [
  ["--format <format>", 'Output format: "markdown" (default) or "json"', "markdown"],
  ["--color <mode>", 'Colour mode: "auto" (TTY detect), "always" or "never"', "auto"],
] as const;

const resolveFormat = (value: string | undefined): OutputFormat => {
  if (value === undefined) {
    return "markdown";
  }
  if (value === "markdown" || value === "json") {
    return value;
  }
  throw new UnknownFormatError({
    code: ERR_UNKNOWN_FORMAT,
    format: value,
    message: `Unknown output format "${value}" — expected "markdown" or "json".`,
  });
};

const shouldColor = (mode: ColorMode, format: OutputFormat): boolean => {
  // Machine-readable output never carries ANSI, whatever --color says.
  if (format === "json" || mode === "never") {
    return false;
  }
  if (mode === "always") {
    return true;
  }
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  return process.stdout.isTTY === true;
};

/**
 * Apply colour to the finished formatter output. Only the headline is tinted:
 * tables and code fences stay legible in plain terminals and diffs.
 */
const colorize = (text: string, enabled: boolean): string => {
  if (!enabled) {
    return text;
  }
  const [headline, ...rest] = text.split("\n");
  return [chalk.bold.cyan(headline ?? ""), ...rest].join("\n");
};

const render = (formatter: OutputFormatter, text: string, options: OutputOptions): string =>
  colorize(text, shouldColor((options.color as ColorMode | undefined) ?? "auto", formatter.format));

/**
 * Make our resolved colour policy authoritative.
 *
 * chalk sniffs argv itself and treats the mere presence of `--color` as
 * force-colour, so a piped `--color never` would still emit escape codes from
 * any chalk call. Pinning `chalk.level` disables that.
 */
const applyColorPolicy = (formatter: OutputFormatter, options: OutputOptions): boolean => {
  const enabled = shouldColor((options.color as ColorMode | undefined) ?? "auto", formatter.format);
  chalk.level = enabled ? 1 : 0;
  return enabled;
};

const write = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

/** Emit a failure through `formatError`; JSON goes to stdout so parsers can read it. */
const fail = (formatter: OutputFormatter, options: OutputOptions, error: unknown): void => {
  const text = render(formatter, formatter.formatError(error), options);
  if (formatter.format === "json") {
    write(text);
  } else {
    process.stderr.write(`${text}\n`);
  }
  process.exitCode = 1;
};

const resolveFormatter = (options: OutputOptions): OutputFormatter =>
  createFormatter(resolveFormat(options.format));

const program = new Command();

program
  .name("perfgym")
  .description("Autonomous Code Optimization & Linting Gym for AI Agents")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize a .perfgym.yaml configuration file in current repository")
  .option("-f, --force", "Overwrite existing configuration if present", false)
  .option(...OUTPUT_OPTIONS[0])
  .option(...OUTPUT_OPTIONS[1])
  .action((options: { force?: boolean } & OutputOptions) => {
    let formatter: OutputFormatter;
    try {
      formatter = resolveFormatter(options);
    } catch (error: unknown) {
      // An invalid --format cannot be honoured; fall back to the default
      // formatter for this one error, like the other commands do.
      fail(resolveFormatter({}), options, error);
      return;
    }

    try {
      applyColorPolicy(formatter, options);
      const res = runInit({ force: options.force });

      if (formatter.format === "json") {
        write(
          render(
            formatter,
            JSON.stringify(
              {
                status: res.success ? "ok" : "error",
                message: res.message,
                configPath: res.configPath,
                config: res.config ?? null,
              },
              null,
              2,
            ),
            options,
          ),
        );
      } else {
        const summary = [
          "### ✨ PerfGym Configuration",
          "",
          `- **Status:** ${res.success ? "✅ Created" : "⚠️ Skipped"}`,
          `- **Config:** \`${res.configPath}\``,
          ...(res.config === undefined
            ? []
            : [
                `- **Target:** \`${res.config.target.name}\` (${res.config.target.language})`,
                `- **Metrics:** ${res.config.metrics.map((metric) => `\`${metric.name}\``).join(", ")}`,
              ]),
          "",
          res.message,
        ].join("\n");
        write(render(formatter, summary, options));
      }

      if (!res.success) {
        process.exitCode = 1;
      }
    } catch (error: unknown) {
      // `formatter` already reflects --format json, so the failure is emitted
      // as JSON on stdout rather than as markdown on stderr.
      fail(formatter, options, error);
    }
  });

program
  .command("baseline")
  .description("Record baseline metrics and invariants for target files")
  .option("-s, --samples <number>", "Number of benchmark samples to collect", "5")
  .option(...OUTPUT_OPTIONS[0])
  .option(...OUTPUT_OPTIONS[1])
  .action(async (options: { samples: string } & OutputOptions) => {
    let formatter: OutputFormatter;
    try {
      formatter = resolveFormatter(options);
    } catch (error: unknown) {
      fail(resolveFormatter({}), options, error);
      return;
    }

    const samples = parseInt(options.samples, 10) || 5;
    applyColorPolicy(formatter, options);
    if (formatter.format === "markdown") {
      write(render(formatter, "📊 Measuring baseline performance & invariant tests...", options));
    }

    let res: Awaited<ReturnType<typeof runBaseline>>;
    try {
      res = await runBaseline({ samples });
    } catch (error: unknown) {
      fail(formatter, options, error);
      return;
    }

    if (!res.success) {
      fail(formatter, options, new Error(`Failed to establish baseline: ${res.error}`));
      return;
    }

    const config = (() => {
      try {
        return loadConfig();
      } catch (error: unknown) {
        fail(formatter, options, error);
        return null;
      }
    })();
    if (config === null) {
      return;
    }

    const primaryName = config.metrics[0]?.name;
    const primaryDistribution =
      primaryName === undefined ? undefined : res.state.baselineDistributions?.[primaryName];

    if (formatter.format === "json") {
      const baselineDoc =
        primaryDistribution === undefined
          ? { status: "BASELINE" }
          : (JSON.parse(formatter.formatBaseline(primaryDistribution, config)) as Record<
              string,
              unknown
            >);
      write(
        render(
          formatter,
          JSON.stringify(
            {
              ...baselineDoc,
              metrics: res.state.baselineMetrics,
              invariantsPassed: res.state.invariantsPassed,
            },
            null,
            2,
          ),
          options,
        ),
      );
      return;
    }

    const body =
      primaryDistribution === undefined
        ? "### 📊 Baseline Recorded"
        : formatter.formatBaseline(primaryDistribution, config);
    write(
      render(
        formatter,
        `${body}\n\n✔ Baseline established. State saved to \`.perfgym/state.json\``,
        options,
      ),
    );
  });

program
  .command("step")
  .description("Evaluate an agent mutation: verify invariants, run AST linters, compute fitness delta")
  .option("-f, --files <files...>", "Specific modified files to evaluate")
  .option("-s, --samples <number>", "Number of benchmark samples to collect", "5")
  .option("--min-delta <number>", "Minimum significance delta percentage threshold", "2.5")
  .option(...OUTPUT_OPTIONS[0])
  .option(...OUTPUT_OPTIONS[1])
  .action(
    async (options: { files?: string[]; samples: string; minDelta: string } & OutputOptions) => {
      let formatter: OutputFormatter;
      try {
        formatter = resolveFormatter(options);
      } catch (error: unknown) {
        fail(resolveFormatter({}), options, error);
        return;
      }

      const samples = parseInt(options.samples, 10) || 5;
      const minDelta = parseFloat(options.minDelta) || 2.5;
      applyColorPolicy(formatter, options);

      try {
        const res = await runStep({
          files: options.files,
          samples,
          minSignificanceDelta: minDelta,
        });

        const { evaluation } = res;
        const config = loadConfig();
        let text = formatter.formatStep(evaluation, config);

        if (formatter.format === "markdown") {
          const deltaStr =
            evaluation.deltaPercent >= 0
              ? `+${evaluation.deltaPercent.toFixed(1)}%`
              : `${evaluation.deltaPercent.toFixed(1)}%`;
          const verdict = evaluation.accepted
            ? `✔ Change accepted! Score: +${evaluation.fitnessScore.toFixed(2)} (Delta: ${deltaStr})`
            : `✖ Change rejected! Score: ${
                Number.isFinite(evaluation.fitnessScore)
                  ? evaluation.fitnessScore.toFixed(2)
                  : "-Infinity"
              }`;
          text = `${text}\n\n${verdict}`;
        }

        write(render(formatter, text, options));

        if (!evaluation.accepted) {
          process.exitCode = 1;
        }
      } catch (error: unknown) {
        fail(formatter, options, error);
      }
    },
  );

program
  .command("run")
  .description("Execute autonomous hill-climbing optimization loop in an isolated sandbox worktree")
  .option("-i, --iterations <number>", "Maximum number of optimization iterations", "15")
  .option("-t, --target-branch <branch>", "Target branch to promote winning commits to", "main")
  .option("-m, --model <provider/model>", "LLM provider and model for mutation generation")
  .option("-s, --samples <number>", "Number of benchmark samples per evaluation", "5")
  .option(...OUTPUT_OPTIONS[0])
  .option(...OUTPUT_OPTIONS[1])
  .action(
    async (
      options: { iterations: string; targetBranch: string; model?: string; samples: string } & OutputOptions,
    ) => {
      let formatter: OutputFormatter;
      try {
        formatter = resolveFormatter(options);
      } catch (error: unknown) {
        fail(resolveFormatter({}), options, error);
        return;
      }

      const iterations = parseInt(options.iterations, 10) || 15;
      const samples = parseInt(options.samples, 10) || 5;
      const json = formatter.format === "json";
      applyColorPolicy(formatter, options);

      try {
        const result = await runOptimizationLoop({
          maxIterations: iterations,
          targetBranch: options.targetBranch,
          model: options.model,
          samples,
          // Keep stdout pure JSON: the loop's live progress is suppressed,
          // its summary is rendered below through the formatter.
          quiet: json,
        });

        if (json) {
          write(
            render(
              formatter,
              JSON.stringify(
                {
                  status: result.stoppedReason,
                  totalIterations: result.totalIterations,
                  acceptedCount: result.acceptedCount,
                  bestFitnessScore: Number.isFinite(result.bestFitnessScore)
                    ? result.bestFitnessScore
                    : null,
                  promoted: result.promoted,
                  evaluations: result.evaluations,
                },
                null,
                2,
              ),
              options,
            ),
          );
        }
      } catch (error: unknown) {
        fail(formatter, options, error);
      }
    },
  );

export { program };

if (process.argv[1] && /\b(index\.[tj]s|perfgym(\.js)?)$/.test(process.argv[1])) {
  program.parse(process.argv);
}
