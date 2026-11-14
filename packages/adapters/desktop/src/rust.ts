import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { MetricCollector, MetricResult, BenchmarkDistribution } from "@perfgym/core";

const execAsync = promisify(exec);

export function parseCargoBenchJson(output: string): number[] {
  const samples: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    try {
      const obj = JSON.parse(line);
      if (typeof obj?.mean?.estimate === "number") samples.push(obj.mean.estimate);
    } catch {}
  }
  return samples;
}

export class RustCargoBenchCollector implements MetricCollector {
  readonly name = "cargo-bench";
  constructor(private readonly command: string) {}
  async collect(): Promise<MetricResult> {
    try {
      const { stdout } = await execAsync(this.command);
      const samples = parseCargoBenchJson(stdout);
      const ns = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
      const value = ns / 1e6;
      return { name: "cargo_bench_ms", value, unit: "ms", improved: false, deltaPercent: 0 };
    } catch (err: any) {
      return { name: "cargo_bench_ns", value: 0, unit: "ms", improved: false, deltaPercent: 0 };
    }
  }
}
