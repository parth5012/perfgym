import { loadConfig, loadSession } from "../engine.js";
import { runBenchmark, runInvariantGate } from "../../../core/src/index.js";
import { Effect } from "effect";

export interface CiResult {
  passed: boolean;
  exitCode: number;
  markdown: string;
}

export async function runCiCommand(): Promise<CiResult> {
  const config = loadConfig();
  const session = loadSession();
  const baseline = session?.baselineMetrics ?? {};
  let invariantPassed = true;
  let invariantOutput = "";
  try {
    const res = await Effect.runPromise(
      runInvariantGate({ command: config.invariants.command, timeoutMs: config.invariants.timeoutMs ?? 10000 }),
    );
    invariantPassed = res.passed;
    invariantOutput = res.output;
  } catch (err: any) {
    invariantPassed = false;
    invariantOutput = err?.stderr ?? err?.stdout ?? err?.message ?? "";
  }

  const lines: string[] = ["### CI", "", `- Invariants: ${invariantPassed ? "✅ pass" : "❌ fail"}`];
  if (!invariantPassed) lines.push("", "```", invariantOutput.trim(), "```");
  let passed = invariantPassed;

  if (Object.keys(baseline).length === 0) {
    passed = false;
    lines.push("", "⚠️ No baseline found. Run `perfgym baseline` first; nothing was compared.");
  } else {
    lines.push("", "| Metric | Baseline | Current | Δ |", "|---|---:|---:|---:|");
    for (const metric of config.metrics) {
      const base = baseline[metric.name];
      try {
        const dist: any = await Effect.runPromise(
          runBenchmark({
            command: metric.command,
            samples: 5,
            unit: metric.unit ?? "count",
            ...(metric.timeoutMs !== undefined ? { timeoutMs: metric.timeoutMs } : {}),
            ...(metric.requireChecksum === true ? { requireChecksum: true } : {}),
            ...(metric.requireTimerStamp === true ? { requireTimerStamp: true } : {}),
          }),
        );
        const current = dist.p50;
        const delta = base && base > 0 ? (((metric.goal === "minimize" ? base - current : current - base) / base) * 100).toFixed(1) : "n/a";
        lines.push(`| ${metric.name} | ${base ?? "n/a"} | ${current} | ${delta}% |`);
        if (base === undefined) {
          passed = false;
        } else {
          const regressed = metric.goal === "minimize" ? current > base : current < base;
          if (regressed) passed = false;
        }
      } catch (err: any) {
        passed = false;
        lines.push(`| ${metric.name} | ${base ?? "n/a"} | error | n/a |`);
      }
    }
  }

  return { passed, exitCode: passed ? 0 : 1, markdown: lines.join("\n") };
}