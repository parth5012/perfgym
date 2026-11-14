import { describe, it, expect } from "vitest";
import { parseBundleSize, parseLighthouseScores } from "./collectors/index.js";

describe("bundle parser", () => {
  it("parses bytes", () => {
    expect(parseBundleSize("dist size 1234 bytes")).toBe(1234);
  });
  it("parses kb", () => {
    expect(parseBundleSize("bundle 2.5kb")).toBe(2560);
  });
});

describe("lighthouse parser", () => {
  it("parses scores", () => {
    const out = JSON.stringify({ categories: { performance: { score: 0.9 }, accessibility: { score: 1 }, "best-practices": { score: 0.8 }, seo: { score: 0.7 } } });
    const s = parseLighthouseScores(out);
    expect(s.performance).toBe(90);
    expect(s.seo).toBe(70);
  });
  it("returns zeros on bad input", () => {
    expect(parseLighthouseScores("nope").performance).toBe(0);
  });
});