import type { MetricCollector, MetricResult } from "@perfgym/core";

export class CdpMetricCollector implements MetricCollector {
  readonly name = "electron-cdp";
  constructor(private readonly options: { url?: string } = {}) {}
  async collect(): Promise<MetricResult> {
    // Placeholder: real implementation connects over CDP.
    return { name: "electron_heap_bytes", value: 0, unit: "bytes", improved: false, deltaPercent: 0 };
  }
}
