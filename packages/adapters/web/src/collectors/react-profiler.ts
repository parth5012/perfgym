import type { MetricCollector, MetricResult } from "@perfgym/core";

export class ReactProfilerCollector implements MetricCollector {
  readonly name = "react-profiler";

  constructor(private readonly options: { selector?: string } = {}) {}

  async collect(): Promise<MetricResult> {
    try {
      await import("playwright" as any);
    } catch {
      throw new Error("ReactProfilerCollector requires playwright; install it to enable component monitoring");
    }
    throw new Error("ReactProfilerCollector not implemented: requires Playwright trace + React Profiler driver");
  }
}