import { describe, it, expect } from "vitest";
import { OtelSpanMetricCollector } from "./otel.js";
import { parseDurations, CpuFlameGraphCollector } from "./flamegraph.js";

describe("otel collector", () => {
  it("builds distribution", async () => {
    const c = new OtelSpanMetricCollector(async () => [1, 2, 3, 4]);
    const d = await c.collect();
    expect(d.sampleCount).toBe(4);
    expect(d.p50).toBeGreaterThan(0);
  });
});

describe("flamegraph parser", () => {
  it("parses durations", () => {
    expect(parseDurations("a 1 2.5 x")).toEqual([1, 2.5]);
  });
});