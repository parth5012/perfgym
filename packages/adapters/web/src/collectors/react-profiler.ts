import type { MetricCollector, MetricResult } from "@perfgym/core";

export class ReactProfilerCollector implements MetricCollector {
  readonly name = "react-profiler";

  constructor(private readonly options: { selector?: string } = {}) {}

  async collect(): Promise<MetricResult> {
    // Graceful skip if Playwright is unavailable.
    try {
      // @ts-ignore
      await import("playwright");
    } catch {
      return {
        name: "react_render_duration_ms",
        value: 0,
        unit: "ms",
        improved: false,
        deltaPercent: 0,
      };
    }
    // Placeholder: real implementation drives Playwright trace + React Profiler.
    return {
      name: "react_render_duration_ms",
      value: 0,
      unit: "ms",
      improved: false,
      deltaPercent: 0,
    };
  }
}