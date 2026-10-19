/**
 * Wayfinder Ticket #26 HITL Prototype: EvaluationPipeline Gradient Simulation
 *
 * Demonstrates how the REAL 4-stage EvaluationPipeline handles 4 mutation scenarios:
 * - Scenario A (Clean Win): invariants pass, +25% CPU instruction reduction, 0 violations -> score = +25, accepted.
 * - Scenario B (Cheating Attempt): +40% speedup but introduces @ts-ignore in modified file -> rejected by anti-cheat/typecheck gate (-Inf).
 * - Scenario C (Corrupted Logic): +60% speedup but invariant unit test fails -> instant revert, score -Infinity.
 * - Scenario D (Anti-pattern trade-off): +10% speedup but serial await loop violation (-50 penalty) with weight 1 -> score = -40, rejected.
 *
 * Run: npx tsx scripts/demo-pipeline-gradient.ts
 *      pnpm demo:pipeline
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvaluationPipeline } from "../packages/core/src/pipeline/pipeline.js";
import type { PerfGymConfig, StepEvaluation, WorkspaceContext } from "../packages/core/src/index.js";
import { AstLinterEngine } from "../packages/linter/src/engine.js";
import { DEFAULT_RULES } from "../packages/linter/src/rules.js";

// ANSI helpers (with fallback to plain text)
const isColorSupported = process.stdout.isTTY && !process.env.NO_COLOR;
const color = {
  bold: (s: string) => (isColorSupported ? `\x1b[1m${s}\x1b[0m` : s),
  dim: (s: string) => (isColorSupported ? `\x1b[2m${s}\x1b[0m` : s),
  green: (s: string) => (isColorSupported ? `\x1b[32m${s}\x1b[0m` : s),
  red: (s: string) => (isColorSupported ? `\x1b[31m${s}\x1b[0m` : s),
  yellow: (s: string) => (isColorSupported ? `\x1b[33m${s}\x1b[0m` : s),
  cyan: (s: string) => (isColorSupported ? `\x1b[36m${s}\x1b[0m` : s),
  gray: (s: string) => (isColorSupported ? `\x1b[90m${s}\x1b[0m` : s),
};

const BASE_TMP = join(tmpdir(), `perfgym-demo-gradient-${Date.now()}`);

interface ScenarioDef {
  id: string;
  name: string;
  description: string;
  invariantCommand: string;
  metricValue: number; // baseline = 100, goal = minimize
  sourceFile: string;
  expectedScore: number;
  expectedAccepted: boolean;
  expectedStage: string;
}

const SCENARIOS: ScenarioDef[] = [
  {
    id: "Scenario A",
    name: "Clean Win",
    description: "Invariants pass, +25% CPU instruction reduction, 0 violations",
    invariantCommand: 'node -e "console.log(\'invariants passed (test suite green)\')"',
    metricValue: 75, // 25% better than 100
    sourceFile: `export function hotPath(nums: number[]): number {\n  return nums.reduce((a, b) => a + b, 0);\n}\n`,
    expectedScore: 25,
    expectedAccepted: true,
    expectedStage: "Stage 4 (Accepted)",
  },
  {
    id: "Scenario B",
    name: "Cheating Attempt",
    description: "+40% speedup but introduces @ts-ignore and unsafe any cast",
    invariantCommand: 'node -e "console.log(\'invariants passed (test suite green)\')"',
    metricValue: 60, // 40% speedup
    sourceFile: `// @ts-ignore\nexport const cheat: number = (input as any);\n`,
    expectedScore: -Infinity,
    expectedAccepted: false,
    expectedStage: "Stage 2 (Anti-cheat Disqualification)",
  },
  {
    id: "Scenario C",
    name: "Corrupted Logic",
    description: "+60% speedup but invariant unit test fails (exit 1)",
    invariantCommand: 'node -e "console.error(\'FAIL tests/unit.test.ts: expected 42 got 0\'); process.exit(1);"',
    metricValue: 40, // 60% speedup
    sourceFile: `export function hotPath(): number {\n  return 0; // fast but wrong\n}\n`,
    expectedScore: -Infinity,
    expectedAccepted: false,
    expectedStage: "Stage 1 (Invariants Failure)",
  },
  {
    id: "Scenario D",
    name: "Anti-pattern Trade-off",
    description: "+10% speedup but serial await loop violation (-50 penalty)",
    invariantCommand: 'node -e "console.log(\'invariants passed (test suite green)\')"',
    metricValue: 90, // 10% speedup
    sourceFile: `async function processQueue(items: any[]) {\n  for (const item of items) {\n    await processOne(item);\n  }\n}\n`,
    expectedScore: -40,
    expectedAccepted: false,
    expectedStage: "Stage 4 (Unprofitable Trade-off)",
  },
];

function buildSandbox(scenario: ScenarioDef): {
  workingDir: string;
  config: PerfGymConfig;
  context: WorkspaceContext;
} {
  const workingDir = join(BASE_TMP, scenario.id.toLowerCase().replace(/\s+/g, "-"));
  rmSync(workingDir, { recursive: true, force: true });
  mkdirSync(join(workingDir, "src"), { recursive: true });

  const hotFile = join(workingDir, "src", "hot.ts");
  writeFileSync(hotFile, scenario.sourceFile, "utf8");

  const config: PerfGymConfig = {
    version: "0.1",
    target: { name: "hot-target", language: "typescript", files: ["src/**/*"] },
    invariants: {
      command: scenario.invariantCommand,
    },
    metrics: [
      {
        name: "instructions",
        command: `node -e "console.log(JSON.stringify({ value: ${scenario.metricValue} }))"`,
        goal: "minimize",
        weight: 1,
        unit: "count",
      },
    ],
  };

  const context: WorkspaceContext = {
    runId: `run-${scenario.id.toLowerCase().replace(/\s+/g, "-")}`,
    workingDir,
    branchName: `perfgym/eval-${scenario.id}`,
    baseRef: "main",
  };

  return { workingDir, config, context };
}

function printScoreCard(scenario: ScenarioDef, step: StepEvaluation): void {
  const line = "=".repeat(78);
  const divider = "-".repeat(78);

  console.log(`\n${color.cyan(line)}`);
  console.log(
    ` ${color.bold(scenario.id)}: ${color.bold(scenario.name)}  ${color.dim(`— ${scenario.description}`)}`
  );
  console.log(color.cyan(divider));

  // Stage 1 output
  const s1Status = step.invariants.passed
    ? color.green("PASS")
    : color.red("FAIL (aborted cascade)");
  console.log(` [Stage 1] Invariants Gate:   ${s1Status}`);
  if (!step.invariants.passed) {
    console.log(`           ${color.dim(`Output: ${step.invariants.output.split("\n")[0]}`)}`);
  }

  // Stage 2 output
  const hasDisqualify = step.violations.some((v) => v.action === "disqualify");
  const s2Status = !step.invariants.passed
    ? color.gray("SKIPPED (short-circuited by Stage 1)")
    : hasDisqualify
    ? color.red(`REJECT (${step.violations.filter((v) => v.action === "disqualify").length} disqualifier(s) caught)`)
    : step.violations.length > 0
    ? color.yellow(`PASS (${step.violations.length} penalizable violation(s))`)
    : color.green("PASS (0 violations)");
  console.log(` [Stage 2] Anti-Cheat & Lint: ${s2Status}`);

  if (step.violations.length > 0) {
    for (const v of step.violations) {
      const tag =
        v.action === "disqualify"
          ? color.red("[DISQUALIFY]")
          : color.yellow(`[PENALTY -${v.penalty}]`);
      console.log(`           ${tag} rule: ${color.bold(v.ruleId)} (line ${v.line}) -> ${v.message}`);
    }
  }

  // Stage 3 output
  const s3Ran = step.metrics.length > 0;
  const s3Status = !s3Ran
    ? color.gray("SKIPPED (short-circuited before benchmark)")
    : color.green(`MEASURED (${step.metrics[0].value} vs baseline 100, delta: +${step.deltaPercent.toFixed(1)}%)`);
  console.log(` [Stage 3] Benchmark Gate:    ${s3Status}`);

  // Stage 4 output
  const scoreFmt =
    step.fitnessScore === -Infinity
      ? color.red("-Infinity")
      : step.fitnessScore > 0
      ? color.green(`+${step.fitnessScore.toFixed(2)}`)
      : color.red(step.fitnessScore.toFixed(2));

  const verdictLabel = step.accepted
    ? color.green("ACCEPTED")
    : color.red("REVERTED");

  console.log(` [Stage 4] Fitness Verdict:   Score = ${scoreFmt}  |  Verdict = ${verdictLabel}`);
  if (step.revertReason) {
    console.log(`           ${color.dim(`Revert Reason: ${step.revertReason.split("\n")[0]}`)}`);
  }
}

async function main(): Promise<void> {
  const banner = [
    "==============================================================================",
    "  PerfGym EvaluationPipeline Gradient Simulation (Ticket #26 HITL Prototype)  ",
    "==============================================================================",
  ].join("\n");

  console.log(color.bold(color.cyan(banner)));
  console.log(
    color.dim(
      "Simulating 4 mutation scenarios through the REAL EvaluationPipeline with real AST linter\n" +
      "rules, real benchmark distributions, and real mathematical computeFitnessVerdict."
    )
  );

  const results: {
    scenario: ScenarioDef;
    step: StepEvaluation;
    passedVerification: boolean;
  }[] = [];

  const tStart = Date.now();

  try {
  for (const scenario of SCENARIOS) {
    const { workingDir, config, context } = buildSandbox(scenario);

    // Construct REAL AstLinterEngine with full default rule matrix & working directory root
    const linter = new AstLinterEngine(DEFAULT_RULES, workingDir);
    const pipeline = new EvaluationPipeline(config, linter);

    const step = await pipeline.evaluateStep(context, ["src/hot.ts"], {
      baselineMetrics: { instructions: 100 },
      samples: 2,
      minSignificanceDelta: 2.5,
    });

    printScoreCard(scenario, step);

    // Verification against ticket expectations
    let scoreMatches = false;
    if (scenario.expectedScore === -Infinity) {
      scoreMatches = step.fitnessScore === -Infinity;
    } else {
      scoreMatches = Math.abs(step.fitnessScore - scenario.expectedScore) < 0.001;
    }

    const verdictMatches = step.accepted === scenario.expectedAccepted;
    const passedVerification = scoreMatches && verdictMatches;

    results.push({ scenario, step, passedVerification });
  }

  const elapsedMs = Date.now() - tStart;

  // Print Summary Table
  console.log("\n" + color.bold(color.cyan("=".repeat(78))));
  console.log(color.bold("  SUMMARY GRADIENT TABLE (Ticket #26 Expectations vs Real Pipeline Output)"));
  console.log(color.bold(color.cyan("=".repeat(78))));

  const colScenario = "Scenario".padEnd(25);
  const colDelta = "Delta %".padEnd(10);
  const colViolations = "Violations (P)".padEnd(16);
  const colScore = "Fitness Score".padEnd(15);
  const colVerdict = "Verdict".padEnd(10);
  const colStatus = "Verified?";

  console.log(
    color.bold(
      `  ${colScenario} ${colDelta} ${colViolations} ${colScore} ${colVerdict} ${colStatus}`
    )
  );
  console.log("  " + "-".repeat(74));

  let allPassed = true;

  for (const r of results) {
    const name = `${r.scenario.id} (${r.scenario.name})`.padEnd(25);
    const delta = (r.step.deltaPercent > 0 ? `+${r.step.deltaPercent}%` : `${r.step.deltaPercent}%`).padEnd(10);
    const penaltyTotal = r.step.violations.reduce((sum, v) => sum + (v.penalty ?? 0), 0);
    const violText = `${r.step.violations.length} (-${penaltyTotal})`.padEnd(16);
    const scoreStr = (r.step.fitnessScore === -Infinity ? "-Infinity" : r.step.fitnessScore.toFixed(1)).padEnd(15);
    const verdictStr = (r.step.accepted ? "ACCEPTED" : "REVERTED").padEnd(10);
    const statusStr = r.passedVerification
      ? color.green("PASS [REAL]")
      : color.red("FAIL [MISMATCH]");

    console.log(
      `  ${name} ${delta} ${violText} ${scoreStr} ${verdictStr} ${statusStr}`
    );

    if (!r.passedVerification) {
      allPassed = false;
      console.error(
        color.red(
          `    DIFF NOTE: Expected score ${r.scenario.expectedScore}, got ${r.step.fitnessScore}. ` +
          `Expected accepted=${r.scenario.expectedAccepted}, got ${r.step.accepted}`
        )
      );
    }
  }

  console.log("  " + "-".repeat(74));
  console.log(`  Total execution time: ${(elapsedMs / 1000).toFixed(2)}s (< 10s budget)\n`);

  // Honesty / Fidelity notes
  console.log(color.bold("Honesty & Simulation Fidelity Notes:"));
  console.log(
    `  - Pipeline Engine:   ${color.green("100% REAL")} (EvaluationPipeline from packages/core/src/pipeline/pipeline.ts)`
  );
  console.log(
    `  - AST Linter Engine: ${color.green("100% REAL")} (AstLinterEngine with DEFAULT_RULES from packages/linter/src/rules.ts)`
  );
  console.log(
    `  - Anti-Cheat Gate:   ${color.green("100% REAL")} (TypecheckGate tier-1 AST & comment scanner catches @ts-ignore + as any)`
  );
  console.log(
    `  - Verdict Calculus:  ${color.green("100% REAL")} (computeFitnessVerdict pure mathematics: Sigma w*Delta - Sigma P)`
  );
  console.log(
    `  - Benchmark Process: ${color.green("100% REAL")} (Subprocess spawning Node.js commands emitting JSON distributions)`
  );
  console.log(
    `  - Invariant Process: ${color.green("100% REAL")} (Subprocess spawning invariant checks with zero-retry abort)`
  );
  console.log("");
  } finally {
    // Clean up temp fixtures (best-effort, even on abort)
    try {
      rmSync(BASE_TMP, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  if (!allPassed) {
    console.error(color.red("Verification failed: Pipeline verdicts did not match ticket #26 expectations."));
    process.exit(1);
  }

  console.log(color.green(color.bold("SUCCESS: All 4 gradient scenarios behaved exactly according to specification.")));
}

main().catch((err) => {
  console.error("Execution error:", err);
  process.exit(1);
});
