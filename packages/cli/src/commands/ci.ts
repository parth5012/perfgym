import { loadConfig, loadSession } from "../engine.js";
import { runBenchmark } from "../../../core/src/index.js";
import { execSync } from "node:child_process";
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
    invariantOutput = execSync(config.invariants.command, { timeout: config.invariants.timeoutMs ?? 10000, encoding: "utf8", maxBuffer: 1024 * 1024 });
  } catch (err: any) {
    invariantPassed = false;
    invariantOutput = err?.stdout ?? err?.stderr ?? err?.message ?? "";
  }

  const lines: string[] = ["### CI", "", `- Invariants: ${invariantPassed ? "✅ pass" : "❌ fail"}`];
  let passed = invariantPassed;

  if (Object.keys(baseline).length > 0) {
    lines.push("", "| Metric | Baseline | Current | Δ |", "|---|---:|---:|---:|");
    for (const metric of config.metrics) {
      const base = baseline[metric.name];
      try {
        const dist: any = await Effect.runPromise(
          runBenchmark({
            command: metric.command,
            samples: 1,
            unit: metric.unit ?? "count",
            ...(metric.timeoutMs !== undefined ? { timeoutMs: metric.timeoutMs } : {}),
            ...(metric.requireChecksum === true ? { requireChecksum: true } : {}),
            ...(metric.requireTimerStamp === true ? { requireTimerStamp: true } : {}),
          }),
        );
        const current = dist.p50;
        const delta = base && base > 0 ? (((metric.goal === "minimize" ? base - current : current - base) / base) * 100).toFixed(1) : "n/a";
        lines.push(`| ${metric.name} | ${base ?? "n/a"} | ${current} | ${delta}% |`);
      } catch (err: any) {
        passed = false;
        lines.push(`| ${metric.name} | ${base ?? "n/a"} | error | n/a |`);
      }
    }
  }

  return { passed, exitCode: passed ? 0 : 1, markdown: lines.join("\n") };
}