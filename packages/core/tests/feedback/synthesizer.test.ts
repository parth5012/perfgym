import { describe, it, expect } from "vitest";
import {
  synthesizeGradientFeedback,
  type SynthesizerInput,
} from "../../src/feedback/synthesizer.js";

describe("GradientFeedbackSynthesizer (Ticket #19)", () => {
  it("synthesizes feedback for an accepted improvement step", () => {
    const input: SynthesizerInput = {
      accepted: true,
      fitnessScore: 18.5,
      deltaPercent: 18.5,
      isSignificant: true,
      invariants: {
        passed: true,
        output: "All 12 test suites passed.",
        durationMs: 450,
      },
      violations: [],
      metrics: [
        {
          name: "latency",
          value: 42,
          unit: "ms",
          improved: true,
          deltaPercent: 18.5,
        },
      ],
      baselineMetrics: {
        latency: 51.5,
      },
    };

    const feedback = synthesizeGradientFeedback(input);
    expect(feedback).toContain("[ACCEPTED]");
    expect(feedback).toContain("Fitness Score: +18.50");
    expect(feedback).toContain("Invariants: PASSED");
    expect(feedback).toContain("Benchmark 'latency': improved by +18.5%");
    expect(feedback).toContain("Recommendation:");
  });

  it("synthesizes feedback for a rejected step due to invariant failure", () => {
    const input: SynthesizerInput = {
      accepted: false,
      fitnessScore: -Infinity,
      deltaPercent: 0,
      isSignificant: false,
      invariants: {
        passed: false,
        output: "AssertionError: expected 42 to equal 0 at calculateTotal (src/calc.ts:25)",
        durationMs: 310,
      },
      violations: [],
      metrics: [],
      revertReason: "invariants failed: AssertionError: expected 42 to equal 0",
    };

    const feedback = synthesizeGradientFeedback(input);
    expect(feedback).toContain("[REVERTED]");
    expect(feedback).toContain("Invariants: FAILED");
    expect(feedback).toContain("AssertionError");
    expect(feedback).toContain("Correctness precedes speed");
  });

  it("synthesizes constructive recommendations based on violated rule IDs", () => {
    const input: SynthesizerInput = {
      accepted: false,
      fitnessScore: -Infinity,
      deltaPercent: 0,
      isSignificant: false,
      invariants: {
        passed: true,
        output: "OK",
        durationMs: 200,
      },
      violations: [
        {
          ruleId: "no-await-in-loops",
          message: "Avoid serial awaits inside loops; use Promise.all or chunking",
          file: "src/worker.ts",
          line: 44,
          severity: "error",
          penalty: 50,
          action: "penalize",
        },
        {
          ruleId: "no-ts-ignore",
          message: "TypeScript suppression comment detected (@ts-ignore)",
          file: "src/worker.ts",
          line: 12,
          severity: "error",
          penalty: 0,
          action: "disqualify",
        },
      ],
      metrics: [
        {
          name: "latency",
          value: 58,
          unit: "ms",
          improved: false,
          deltaPercent: -38.4,
        },
      ],
      baselineMetrics: {
        latency: 42,
      },
      revertReason: "Disqualified during anti-cheat stage: TypeScript suppression comment detected",
    };

    const feedback = synthesizeGradientFeedback(input);
    expect(feedback).toContain("[REVERTED]");
    expect(feedback).toContain("Linter: 2 violation(s)");
    expect(feedback).toContain("[DISQUALIFY] no-ts-ignore");
    expect(feedback).toContain("[-50] no-await-in-loops");
    expect(feedback).toContain("Promise.all");
    expect(feedback).toContain("compiler sabotage");
  });

  it("formats guidance for unindexed filter and sync I/O rules", () => {
    const input: SynthesizerInput = {
      accepted: false,
      fitnessScore: -60,
      deltaPercent: 20,
      isSignificant: true,
      invariants: {
        passed: true,
        output: "OK",
        durationMs: 150,
      },
      violations: [
        {
          ruleId: "no-unindexed-filter",
          message: "Found in-memory array filtering on database collections",
          file: "src/db.ts",
          line: 18,
          severity: "warning",
          penalty: 30,
        },
        {
          ruleId: "no-sync-methods",
          message: "Synchronous I/O in event loop blocks the event loop",
          file: "src/io.ts",
          line: 5,
          severity: "error",
          penalty: 80,
        },
      ],
      metrics: [
        {
          name: "throughput",
          value: 120,
          unit: "count",
          improved: true,
          deltaPercent: 20,
        },
      ],
      revertReason: "Unprofitable Trade-off: penalties exceed metric gains",
    };

    const feedback = synthesizeGradientFeedback(input);
    expect(feedback).toContain("no-unindexed-filter");
    expect(feedback).toContain("no-sync-methods");
    expect(feedback).toContain("asynchronous non-blocking alternatives");
  });
});
