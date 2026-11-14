import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { MetricCollector, BenchmarkDistribution } from "@perfgym/core";
import { computeBenchmarkDistribution } from "@perfgym/core";

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
  async collect(): Promise<BenchmarkDistribution> {
    const { stdout } = await execAsync(this.command, { timeout: 30000 });
    const samples = parseCargoBenchJson(stdout);
    if (samples.length === 0) throw new Error("no cargo bench samples parsed");
    const msSamples = samples.map((s) => s / 1e6);
    return computeBenchmarkDistribution(msSamples, "ms");
  }
}
