import type { MetricCollector, MetricResult } from "@perfgym/core";

export class CdpMetricCollector implements MetricCollector {
  readonly name = "electron-cdp";
  constructor(private readonly options: { url?: string } = {}) {}
  async collect(): Promise<MetricResult> {
    throw new Error("CdpMetricCollector not implemented: requires CDP connection");
  }
}
