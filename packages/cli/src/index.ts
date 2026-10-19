#!/usr/bin/env node
/**
 * @perfgym/cli
 * CLI Entrypoint for PerfGym
 */

import { Command } from "commander";
import chalk from "chalk";
import { runInit, runBaseline, runStep } from "./engine.js";

const program = new Command();

program
  .name("perfgym")
  .description("Autonomous Code Optimization & Linting Gym for AI Agents")
  .version("0.1.0");

program
  .command("init")
  .description("Initialize a .perfgym.yaml configuration file in current repository")
  .option("-f, --force", "Overwrite existing configuration if present", false)
  .action((options: { force?: boolean }) => {
    console.log(chalk.cyan("✨ Initializing PerfGym configuration (.perfgym.yaml)..."));
    const res = runInit({ force: options.force });
    if (res.success) {
      console.log(chalk.green(`✔ ${res.message}`));
    } else {
      console.log(chalk.yellow(`⚠ ${res.message}`));
      process.exitCode = 1;
    }
  });

program
  .command("baseline")
  .description("Record baseline metrics and invariants for target files")
  .option("-s, --samples <number>", "Number of benchmark samples to collect", "5")
  .action(async (options: { samples: string }) => {
    console.log(chalk.blue("📊 Measuring baseline performance & invariant tests..."));
    try {
      const samples = parseInt(options.samples, 10) || 5;
      const res = await runBaseline({ samples });
      if (!res.success) {
        console.error(chalk.red(`✖ Failed to establish baseline: ${res.error}`));
        process.exit(1);
      }
      console.log(chalk.green("✔ Invariant tests: PASSED"));
      for (const [name, val] of Object.entries(res.state.baselineMetrics)) {
        console.log(chalk.cyan(`  - Metric '${name}': baseline = ${val}`));
      }
      console.log(chalk.green("✔ Baseline established. State saved to .perfgym/state.json"));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`✖ Baseline error: ${msg}`));
      process.exit(1);
    }
  });

program
  .command("step")
  .description("Evaluate an agent mutation: verify invariants, run AST linters, compute fitness delta")
  .option("-f, --files <files...>", "Specific modified files to evaluate")
  .option("-s, --samples <number>", "Number of benchmark samples to collect", "5")
  .option("--min-delta <number>", "Minimum significance delta percentage threshold", "2.5")
  .action(async (options: { files?: string[]; samples: string; minDelta: string }) => {
    console.log(chalk.magenta("🔄 Running PerfGym evaluation cycle..."));
    try {
      const samples = parseInt(options.samples, 10) || 5;
      const minDelta = parseFloat(options.minDelta) || 2.5;

      const res = await runStep({
        files: options.files,
        samples,
        minSignificanceDelta: minDelta,
      });

      const { evaluation } = res;

      if (!evaluation.invariants.passed) {
        console.log(chalk.red("✖ Invariant tests: FAILED"));
        if (evaluation.invariants.output) {
          console.log(chalk.red(`  ${evaluation.invariants.output.trim()}`));
        }
      } else {
        console.log(chalk.green("✔ Invariants passed."));
      }

      if (evaluation.violations.length > 0) {
        console.log(chalk.yellow(`⚠ AST Violations (${evaluation.violations.length}):`));
        for (const v of evaluation.violations) {
          const prefix = v.action === "disqualify" ? chalk.red("[DISQUALIFIED]") : chalk.yellow(`[-${v.penalty}]`);
          console.log(`  ${prefix} ${v.ruleId}: ${v.message} (${v.file}:${v.line})`);
        }
      }

      if (evaluation.accepted) {
        const deltaStr = evaluation.deltaPercent >= 0 ? `+${evaluation.deltaPercent.toFixed(1)}%` : `${evaluation.deltaPercent.toFixed(1)}%`;
        console.log(chalk.green(`✔ Change accepted! Score: +${evaluation.fitnessScore.toFixed(2)} (Delta: ${deltaStr})`));
      } else {
        const scoreStr = evaluation.fitnessScore === -Infinity ? "-Infinity" : evaluation.fitnessScore.toFixed(2);
        console.log(chalk.red(`✖ Change rejected! Score: ${scoreStr}`));
        if (evaluation.revertReason) {
          console.log(chalk.red(`  Rollback reason: ${evaluation.revertReason}`));
        }
        process.exitCode = 1;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`✖ Step evaluation error: ${msg}`));
      process.exitCode = 1;
    }
  });

export { program };

if (process.argv[1] && (/\b(index\.[tj]s|perfgym(\.js)?)$/).test(process.argv[1])) {
  program.parse(process.argv);
}
