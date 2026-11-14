import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { MetricCollector, BenchmarkDistribution } from "@perfgym/core";
import { computeDistribution } from "./stats.js";

const execAsync = promisify(exec);

export function parseDurations(output: string): number[] {
  const matches = output.match(/(?:duration_ms|ms)\s*[:=]\s*(-?\d+(?:\.\d+)?)/gi) ?? [];
  return matches
    .map((m) => {
      const n = m.match(/(-?\d+(?:\.\d+)?)\s*$/);
      return n ? parseFloat(n[1]) : NaN;
    })
    .filter((n) => Number.isFinite(n));
}

export class CpuFlameGraphCollector implements MetricCollector {
  readonly name = "flamegraph";

  constructor(private readonly command: string, private readonly unit: string = "ms") {}

  async collect(): Promise<BenchmarkDistribution> {
    const { stdout, stderr } = await execAsync(this.command, { timeout: 30000 });
    const samples = parseDurations(`${stdout}\n${stderr}`);
    if (samples.length === 0) throw new Error("no durations parsed");
    return computeDistribution(samples, this.unit);
  }
}