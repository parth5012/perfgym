import type { MetricCollector, BenchmarkDistribution } from "@perfgym/core";
import { computeDistribution } from "./stats.js";

export type SpanDurationProvider = () => number[] | Promise<number[]>;

export class OtelSpanMetricCollector implements MetricCollector {
  readonly name = "otel-spans";

  constructor(
    private readonly provider: SpanDurationProvider,
    private readonly unit: string = "ms",
  ) {}

  async collect(): Promise<BenchmarkDistribution> {
    const durations = await this.provider();
    const dist = computeDistribution(durations, this.unit);
    // Optional OTLP export via env var (stubbed; no network by default).
    if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      // In a full implementation this would export dist via OTLP.
    }
    return dist;
  }
}