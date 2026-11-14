import type { BenchmarkDistribution } from "@perfgym/core";

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.floor((p / 100) * (sortedValues.length - 1)));
  return sortedValues[idx];
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = sorted(values);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

export function computeDistribution(samples: number[], unit: string): BenchmarkDistribution {
  const s = sorted(samples);
  const mean = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0;
  const variance = samples.length
    ? samples.reduce((acc, v) => acc + (v - mean) ** 2, 0) / samples.length
    : 0;
  const stddev = Math.sqrt(variance);
  const med = median(samples);
  const deviations = samples.map((v) => Math.abs(v - med));
  const mad = median(deviations);
  const q1 = percentile(s, 25);
  const q3 = percentile(s, 75);
  return {
    samples,
    p50: percentile(s, 50),
    p90: percentile(s, 90),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    min: s.length ? s[0] : 0,
    max: s.length ? s[s.length - 1] : 0,
    stddev,
    mad,
    iqr: q3 - q1,
    sampleCount: samples.length,
    unit,
  };
}
