import type { BenchmarkDistribution } from "@perfgym/core";
import { computeBenchmarkDistribution } from "@perfgym/core";

export function computeDistribution(samples: number[], unit: string): BenchmarkDistribution {
  if (samples.length === 0) {
    return computeBenchmarkDistribution([0], unit);
  }
  return computeBenchmarkDistribution(samples, unit);
}