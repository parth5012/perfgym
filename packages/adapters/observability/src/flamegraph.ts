import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { MetricCollector, BenchmarkDistribution } from "@perfgym/core";
import { computeDistribution } from "./stats.js";

const execAsync = promisify(exec);

export function parseDurations(output: string): number[] {
  const matches = output.match(/-?\d+(?:\.\d+)?/g);
  return matches ? matches.map((m) => parseFloat(m)).filter((n) => Number.isFinite(n)) : [];
}

export class CpuFlameGraphCollector implements MetricCollector {
  readonly name = "flamegraph";

  constructor(private readonly command: string, private readonly unit: string = "ms") {}

  async collect(): Promise<BenchmarkDistribution> {
    try {
      const { stdout, stderr } = await execAsync(this.command);
      const samples = parseDurations(`${stdout}\n${stderr}`);
      return computeDistribution(samples, this.unit);
    } catch (err: any) {
      const samples = parseDurations(`${err?.stdout ?? ""}\n${err?.stderr ?? ""}`);
      return computeDistribution(samples, this.unit);
    }
  }
}