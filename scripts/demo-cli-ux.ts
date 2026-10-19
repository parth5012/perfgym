import chalk from "chalk";
import { synthesizeGradientFeedback } from "../packages/core/src/feedback/synthesizer.js";

console.log(chalk.bold.cyan("\n================================================================================"));
console.log(chalk.bold.cyan("   PERFGYM TERMINAL UX & AGENT MCP FEEDBACK REVIEW (Ticket #27 Prototype)     "));
console.log(chalk.bold.cyan("================================================================================\n"));

console.log(chalk.bold.white("--- 1. CLI COMMAND OUTPUT EXAMPLES ---\n"));

console.log(chalk.bold.blue("▶ Scenario: perfgym init"));
console.log(chalk.cyan("✨ Initializing PerfGym configuration (.perfgym.yaml)..."));
console.log(chalk.green("✔ Initialized .perfgym.yaml with typescript preset.\n"));

console.log(chalk.bold.blue("▶ Scenario: perfgym baseline"));
console.log(chalk.blue("📊 Measuring baseline performance & invariant tests..."));
console.log(chalk.green("✔ Invariant tests: PASSED"));
console.log(chalk.cyan("  - Metric 'latency': baseline = 42ms"));
console.log(chalk.cyan("  - Metric 'cpu_cycles': baseline = 150000count"));
console.log(chalk.green("✔ Baseline established. State saved to .perfgym/state.json\n"));

console.log(chalk.bold.blue("▶ Scenario: perfgym step (Accepted Improvement)"));
console.log(chalk.magenta("🔄 Running PerfGym evaluation cycle..."));
console.log(chalk.green("✔ Invariants passed."));
console.log(chalk.green("✔ Change accepted! Score: +18.50 (Delta: +18.5%)\n"));

console.log(chalk.bold.blue("▶ Scenario: perfgym step (Rejected Degradation & AST Penalties)"));
console.log(chalk.magenta("🔄 Running PerfGym evaluation cycle..."));
console.log(chalk.green("✔ Invariants passed."));
console.log(chalk.yellow("⚠ AST Violations (1):"));
console.log(chalk.yellow("  [-50] no-await-in-loops: Avoid serial awaits inside loops; use Promise.all or chunking (src/worker.ts:44)"));
console.log(chalk.red("✖ Change rejected! Score: -11.60"));
console.log(chalk.red("  Rollback reason: Unprofitable Trade-off: penalties (-50) exceed metric gains (+38.4%)\n"));

console.log(chalk.bold.white("--- 2. AGENT MCP GRADIENT FEEDBACK FORMAT (Rendered Markdown) ---\n"));

const sampleFeedbackAccepted = synthesizeGradientFeedback({
  accepted: true,
  fitnessScore: 18.5,
  deltaPercent: 18.5,
  isSignificant: true,
  invariants: { passed: true, output: "OK", durationMs: 420 },
  violations: [],
  metrics: [
    { name: "latency", value: 34.2, unit: "ms", improved: true, deltaPercent: 18.5 },
  ],
  baselineMetrics: { latency: 42.0 },
});

console.log(chalk.cyan("Sample MCP Feedback for Accepted Step:"));
console.log(chalk.gray("```markdown"));
console.log(sampleFeedbackAccepted);
console.log(chalk.gray("```\n"));

const sampleFeedbackReverted = synthesizeGradientFeedback({
  accepted: false,
  fitnessScore: -Infinity,
  deltaPercent: -38.4,
  isSignificant: false,
  invariants: { passed: true, output: "OK", durationMs: 450 },
  violations: [
    {
      ruleId: "no-await-in-loops",
      message: "Avoid serial awaits inside loops; use Promise.all or chunking",
      file: "src/worker.ts",
      line: 44,
      severity: "error",
      penalty: 50,
      action: "penalize",
    },
  ],
  metrics: [
    { name: "latency", value: 58.1, unit: "ms", improved: false, deltaPercent: -38.4 },
  ],
  baselineMetrics: { latency: 42.0 },
  revertReason: "Disqualified during anti-cheat stage or unprofitable trade-off",
});

console.log(chalk.cyan("Sample MCP Feedback for Reverted Step:"));
console.log(chalk.gray("```markdown"));
console.log(sampleFeedbackReverted);
console.log(chalk.gray("```\n"));
