import { describe, expect, it } from "vitest";
import {
  ANSI_PATTERN,
  acceptedStep,
  distribution,
  errorSeverityViolation,
  invariantFail,
  maximizeConfig,
  minimizeConfig,
  rejectedStep,
  shortCircuitStep,
  sessionState,
  violation,
} from "./test-fixtures.js";
import { JsonFormatter } from "./json.js";
import type { PerfGymConfig } from "../index.js";
import type { NegativeMemoryEntry } from "../memory/index.js";

const formatter = new JsonFormatter();

const parse = (raw: string): Record<string, unknown> => {
  expect(() => JSON.parse(raw)).not.toThrow();
  return JSON.parse(raw) as Record<string, unknown>;
};

describe("JsonFormatter.formatStep — LLD §6.1 schema", () => {
  it("emits exactly the documented top-level field set, in order", () => {
    const parsed = parse(formatter.formatStep(rejectedStep));

    expect(Object.keys(parsed)).toEqual([
      "status",
      "accepted",
      "score",
      "deltaPercent",
      "isSignificant",
      "executionTimeMs",
      "invariants",
      "typecheck",
      "linter",
      "metrics",
      "stepReceipt",
      "negativeMemoryGuidance",
    ]);
  });

  it("serialises a rejected step with fitnessScore: null, never -Infinity", () => {
    const raw = formatter.formatStep(rejectedStep);
    const parsed = parse(raw);

    expect(raw).not.toContain("Infinity");
    expect(parsed.score).toBeNull();
    expect(parsed.status).toBe("REVERTED");
    expect(parsed.accepted).toBe(false);
    expect(parsed.isSignificant).toBe(false);
    expect(parsed.deltaPercent).toBe(-2.4);
    expect(parsed.executionTimeMs).toBe(340);
  });

  it("serialises an accepted step with its numeric score", () => {
    const parsed = parse(formatter.formatStep(acceptedStep));

    expect(parsed.status).toBe("ACCEPTED");
    expect(parsed.accepted).toBe(true);
    expect(parsed.score).toBe(12.4);
  });

  it("nests the invariants block with the four documented fields", () => {
    const parsed = parse(formatter.formatStep(rejectedStep, minimizeConfig));
    const invariants = parsed.invariants as Record<string, unknown>;

    expect(Object.keys(invariants)).toEqual(["passed", "retriesUsed", "command", "durationMs"]);
    expect(invariants.passed).toBe(true);
    expect(invariants.retriesUsed).toBe(0);
    expect(invariants.durationMs).toBe(85);
    expect(invariants.command).toBe("pnpm test:invariants");
  });

  it("sets command to null when no config is supplied", () => {
    const parsed = parse(formatter.formatStep(rejectedStep));

    expect((parsed.invariants as Record<string, unknown>).command).toBeNull();
  });

  it("keeps retriesUsed null when the evaluation does not report it", () => {
    const parsed = parse(
      formatter.formatTest({ passed: true, output: "ok", durationMs: 1 }),
    );

    expect(parsed.retriesUsed).toBeNull();
  });

  it("nests the typecheck block and reports the sentinel violation", () => {
    const clean = parse(formatter.formatStep(rejectedStep)).typecheck as Record<string, unknown>;
    expect(Object.keys(clean)).toEqual(["passed", "tier", "disqualified"]);
    expect(clean.passed).toBe(true);
    expect(clean.disqualified).toBe(false);

    const broken = parse(formatter.formatStep(shortCircuitStep)).typecheck as Record<string, unknown>;
    expect(broken.passed).toBe(false);
    expect(broken.disqualified).toBe(true);
  });

  it("nests the linter block and every documented match field", () => {
    const parsed = parse(formatter.formatStep(rejectedStep));
    const linter = parsed.linter as Record<string, unknown>;

    expect(Object.keys(linter)).toEqual(["passed", "disqualified", "totalPenalty", "matches"]);
    expect(linter.passed).toBe(false);
    expect(linter.disqualified).toBe(false);
    expect(linter.totalPenalty).toBe(10);

    const matches = linter.matches as Array<Record<string, unknown>>;
    expect(matches).toHaveLength(1);
    expect(Object.keys(matches[0]!)).toEqual([
      "ruleId",
      "file",
      "line",
      "column",
      "message",
      "penalty",
      "action",
      "codeSnippet",
    ]);
    expect(matches[0]!.ruleId).toBe("no-await-in-loop");
    expect(matches[0]!.file).toBe("src/checkout/process.ts");
    expect(matches[0]!.line).toBe(42);
    expect(matches[0]!.action).toBe("penalize");
    // Not present on LintViolation — null, never fabricated.
    expect(matches[0]!.column).toBeNull();
    expect(matches[0]!.codeSnippet).toBeNull();
  });

  it("nests the metrics block with distribution and tail-guard schemas", () => {
    const parsed = parse(formatter.formatStep(rejectedStep, minimizeConfig));
    const metrics = parsed.metrics as Record<string, unknown>;

    expect(Object.keys(metrics)).toEqual(["target", "unit", "goal", "baseline", "current", "tailGuard"]);
    expect(metrics.target).toBe("latency_p50");
    expect(metrics.unit).toBe("ms");
    expect(metrics.goal).toBe("minimize");

    const baseline = metrics.baseline as Record<string, unknown>;
    expect(Object.keys(baseline)).toEqual([
      "p50",
      "p90",
      "p95",
      "p99",
      "min",
      "max",
      "stddev",
      "mad",
      "iqr",
      "sampleCount",
    ]);
    expect(baseline.p50).toBe(42.1);

    const tailGuard = metrics.tailGuard as Record<string, unknown>;
    expect(Object.keys(tailGuard)).toEqual(["passed", "madCeiling", "rule"]);
    expect(tailGuard.rule).toBe("Current_p99 <= Baseline_p50 + 3 * Baseline_MAD");
    // 42.1 + 3 * 1.2 = 45.7; current p99 61.2 breaches it.
    expect(tailGuard.madCeiling).toBeCloseTo(45.7, 5);
    expect(tailGuard.passed).toBe(false);
  });

  it("leaves the tail guard unclaimed when no goal is configured", () => {
    const metrics = parse(formatter.formatStep(rejectedStep)).metrics as Record<string, unknown>;
    const tailGuard = metrics.tailGuard as Record<string, unknown>;

    expect(metrics.goal).toBeNull();
    expect(tailGuard.passed).toBeNull();
    expect(tailGuard.madCeiling).toBeNull();
  });

  it("applies the maximize floor rule instead of the minimize ceiling", () => {
    const metrics = parse(formatter.formatStep(rejectedStep, maximizeConfig)).metrics as Record<
      string,
      unknown
    >;
    const tailGuard = metrics.tailGuard as Record<string, unknown>;

    expect(metrics.goal).toBe("maximize");
    expect(tailGuard.rule).toBe("Current_min >= Baseline_p50 - 3 * Baseline_MAD");
    // Floor = 42.1 - 3.6 = 38.5; current min 41.0 stays above it.
    expect(tailGuard.madCeiling).toBeCloseTo(38.5, 5);
    expect(tailGuard.passed).toBe(true);
  });

  it("does not round the ceiling before comparing it", () => {
    const tiny = distribution({ p50: 10, mad: 0.002, p99: 10.0065 });
    const evaluation = {
      ...rejectedStep,
      baselineDistribution: distribution({ p50: 10, mad: 0.002 }),
      currentDistribution: tiny,
    };

    // floorCoefficient 0 keeps the raw-MAD ceiling so the no-rounding
    // property is tested against the exact arithmetic (10 + 3 * 0.002).
    const parsed = parse(
      formatter.formatStep(evaluation, { ...minimizeConfig, floorCoefficient: 0 })
    );
    const tailGuard = (parsed.metrics as Record<string, unknown>).tailGuard as Record<string, unknown>;

    // Raw ceiling 10.006 < observed 10.0065: the pipeline rejects, so must we.
    expect(tailGuard.passed).toBe(false);
    expect(tailGuard.madCeiling).toBeCloseTo(10.006, 5);
  });

  it("applies the tail-guard MAD floor so an accepted step does not show a failed guard", () => {
    // MAD=0 baseline: the pipeline's floored ceiling is 10 + 3 * (0.01 * 10)
    // = 10.3, so p99 10.2 is ACCEPTED — the report must agree, not show a
    // failed guard computed from the raw MAD (ceiling 10.0).
    const baseline = distribution({
      p50: 10,
      mad: 0,
      p99: 10,
      min: 10,
      max: 10,
      samples: [10, 10, 10, 10, 10],
    });
    const evaluation = {
      ...rejectedStep,
      accepted: true,
      fitnessScore: 5,
      baselineDistribution: baseline,
      currentDistribution: distribution({
        p50: 10,
        mad: 0,
        p99: 10.2,
        min: 10,
        max: 10.2,
        samples: [10, 10, 10, 10, 10.2],
      }),
    };

    const parsed = parse(formatter.formatStep(evaluation, minimizeConfig));
    const tailGuard = (parsed.metrics as Record<string, unknown>).tailGuard as Record<string, unknown>;

    expect(tailGuard.passed).toBe(true);
    expect(tailGuard.madCeiling).toBeCloseTo(10.3, 5);
  });

  it("honours a configured floorCoefficient in the reported tail-guard ceiling", () => {
    const baseline = distribution({
      p50: 10,
      mad: 0,
      p99: 10,
      min: 10,
      max: 10,
      samples: [10, 10, 10, 10, 10],
    });
    const evaluation = {
      ...rejectedStep,
      accepted: true,
      fitnessScore: 5,
      baselineDistribution: baseline,
      currentDistribution: distribution({
        p50: 10,
        mad: 0,
        p99: 10.4,
        min: 10,
        max: 10.4,
        samples: [10, 10, 10, 10, 10.4],
      }),
    };

    // Coefficient 0.05: ceiling 10 + 3 * (0.05 * 10) = 11.5, p99 10.4 accepted.
    const parsed = parse(
      formatter.formatStep(evaluation, { ...minimizeConfig, floorCoefficient: 0.05 })
    );
    const tailGuard = (parsed.metrics as Record<string, unknown>).tailGuard as Record<string, unknown>;

    expect(tailGuard.passed).toBe(true);
    expect(tailGuard.madCeiling).toBeCloseTo(11.5, 5);
  });

  it("reports null distributions rather than fabricated zeros when a step short-circuits", () => {
    const parsed = parse(formatter.formatStep(shortCircuitStep));
    const metrics = parsed.metrics as Record<string, unknown>;

    expect(metrics.target).toBeNull();
    expect(metrics.unit).toBeNull();
    expect(metrics.baseline).toBeNull();
    expect(metrics.current).toBeNull();

    const tailGuard = metrics.tailGuard as Record<string, unknown>;
    expect(tailGuard.passed).toBeNull();
    expect(tailGuard.madCeiling).toBeNull();
  });

  it("keeps typecheck sentinel failures out of the AST-linter block", () => {
    const parsed = parse(formatter.formatStep(shortCircuitStep));
    const linter = parsed.linter as Record<string, unknown>;

    expect(linter.passed).toBe(true);
    expect(linter.disqualified).toBe(false);
    expect(linter.totalPenalty).toBe(0);
    expect(linter.matches).toEqual([]);
    expect((parsed.typecheck as Record<string, unknown>).passed).toBe(false);
  });

  it("keeps stepReceipt and negativeMemoryGuidance pure (null) in JSON mode", () => {
    const parsed = parse(formatter.formatStep(acceptedStep));

    expect(parsed.stepReceipt).toBeNull();
    expect(parsed.negativeMemoryGuidance).toBeNull();
  });

  it("emits no ANSI escape sequences", () => {
    for (const evaluation of [rejectedStep, acceptedStep, shortCircuitStep]) {
      expect(formatter.formatStep(evaluation)).not.toMatch(ANSI_PATTERN);
    }
  });
});

describe("JsonFormatter.formatNegativeMemory — the memory surface", () => {
  const memory: readonly NegativeMemoryEntry[] = [
    {
      id: "hash-serial-awaits",
      strategy: "src/api/checkout.ts, src/api/order.ts",
      deltaPercent: -8.3,
      reason: "Regressed tail latency.",
      step: 2,
      timestamp: 1_700_000_000_000,
    },
  ];

  it("emits a parseable document with the target, the count and the entries", () => {
    const parsed = parse(formatter.formatNegativeMemory(memory, { target: "checkout" }));

    expect(parsed.target).toBe("checkout");
    expect(parsed.count).toBe(1);

    const entries = parsed.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe("hash-serial-awaits");
    expect(entries[0]!.strategy).toBe("src/api/checkout.ts, src/api/order.ts");
    expect(entries[0]!.deltaPercent).toBe(-8.3);
    expect(entries[0]!.reason).toBe("Regressed tail latency.");
    expect(entries[0]!.step).toBe(2);
    expect(entries[0]!.timestamp).toBe(1_700_000_000_000);
  });

  it("reports a null target and zero entries for an empty memory", () => {
    const parsed = parse(formatter.formatNegativeMemory([]));

    expect(parsed.target).toBeNull();
    expect(parsed.count).toBe(0);
    expect(parsed.entries).toEqual([]);
  });

  it("reports an empty or null target as null", () => {
    expect(parse(formatter.formatNegativeMemory(memory, { target: "" })).target).toBeNull();
    expect(parse(formatter.formatNegativeMemory(memory, { target: null })).target).toBeNull();
  });

  it("strips ANSI from a remembered failure", () => {
    const parsed = parse(
      formatter.formatNegativeMemory(
        [{ ...memory[0]!, reason: "\u001b[31mRegressed tail latency.\u001b[39m" }],
        { target: "checkout" },
      ),
    );

    const entries = parsed.entries as Array<Record<string, unknown>>;
    expect(entries[0]!.reason).toBe("Regressed tail latency.");
  });

  it("never emits ANSI across the whole surface", () => {
    expect(formatter.formatNegativeMemory(memory, { target: "checkout" })).not.toMatch(ANSI_PATTERN);
    expect(formatter.formatNegativeMemory([])).not.toMatch(ANSI_PATTERN);
  });
});

describe("JsonFormatter — remaining surface", () => {
  it("does not invent a disqualification for an error-severity rule with no action", () => {
    const parsed = parse(formatter.formatLint([errorSeverityViolation]));
    const matches = parsed.matches as Array<Record<string, unknown>>;

    expect(matches[0]!.action).toBe("penalize");
    expect(parsed.passed).toBe(false);
  });

  it("strips ANSI from forwarded invariant output", () => {
    const parsed = parse(
      formatter.formatTest({ passed: true, output: "\u001b[32m5 tests passed\u001b[0m", durationMs: 1 }),
    );

    expect(parsed.output).toBe("5 tests passed");
  });

  it("formatBaseline emits a parseable baseline document", () => {
    const parsed = parse(formatter.formatBaseline(distribution(), undefined));

    expect(parsed.status).toBe("BASELINE");
    expect(parsed.unit).toBe("ms");
    expect(parsed.sampleCount).toBe(5);
    expect((parsed.distribution as Record<string, unknown>).p99).toBe(58);
  });

  it("formatBaseline tolerates a partial config and reports absent fields as null", () => {
    const parsed = parse(
      formatter.formatBaseline(distribution(), { metrics: [] } as unknown as PerfGymConfig),
    );

    expect(parsed.status).toBe("BASELINE");
    expect(parsed.target).toBeNull();
    expect(parsed.goal).toBeNull();
  });

  it("formatStatus emits the session state and lock", () => {
    const parsed = parse(formatter.formatStatus(sessionState, null));

    expect(parsed.runId).toBe("run-42");
    expect(parsed.status).toBe("accepted");
    expect(parsed.currentStep).toBe(4);
    expect(parsed.bestScore).toBe(12.4);
    expect(parsed.lock).toBeNull();
  });

  it("formatTest emits invariant results", () => {
    const parsed = parse(formatter.formatTest(invariantFail));

    expect(parsed.passed).toBe(false);
    expect(parsed.durationMs).toBe(120);
    expect(parsed.output).toContain("1 test failed");
  });

  it("formatLint emits violations and total penalty", () => {
    const parsed = parse(formatter.formatLint([violation]));

    expect(parsed.passed).toBe(false);
    expect(parsed.totalPenalty).toBe(10);
    expect((parsed.matches as unknown[]).length).toBe(1);
  });

  it("formatBenchmark emits distribution and optional baseline delta", () => {
    const parsed = parse(formatter.formatBenchmark(distribution({ p50: 43.1 }), distribution()));

    expect(parsed.unit).toBe("ms");
    expect(parsed.distribution).toMatchObject({ p50: 43.1 });
    expect(parsed.baseline).toMatchObject({ p50: 42.1 });
    expect(typeof parsed.deltaPercent).toBe("number");
  });

  it("formatError emits a structured error document for Error, tagged and unknown values", () => {
    const plain = parse(formatter.formatError(new Error("boom")));
    expect(plain.error).toMatchObject({ name: "Error", message: "boom" });

    const tagged = parse(formatter.formatError({ _tag: "GitCommandError", message: "git failed" }));
    expect(tagged.error).toMatchObject({ name: "GitCommandError", code: "GitCommandError", message: "git failed" });

    const unknown = parse(formatter.formatError("just a string"));
    expect(unknown.error).toMatchObject({ name: "UnknownError", message: "just a string" });
  });

  it("falls back to _tag for code when a tagged Error has no code field", () => {
    class Tagged extends Error {
      readonly _tag = "SandboxError";
    }

    const parsed = parse(formatter.formatError(new Tagged("sandbox died")));
    expect(parsed.error).toMatchObject({
      name: "Error",
      code: "SandboxError",
      message: "sandbox died",
    });
  });

  it("strips ANSI from lastError and keeps null as null", () => {
    const parsed = parse(
      formatter.formatStatus({ ...sessionState, lastError: "\u001b[31mboom\u001b[0m" }),
    );

    expect(parsed.lastError).toBe("boom");
    expect(parse(formatter.formatStatus(sessionState)).lastError).toBeNull();
  });

  it("never emits ANSI across the whole surface", () => {
    const outputs = [
      formatter.formatBaseline(distribution()),
      formatter.formatStatus(sessionState),
      formatter.formatTest(invariantFail),
      formatter.formatLint([violation]),
      formatter.formatBenchmark(distribution(), distribution()),
      formatter.formatError(new Error("boom")),
    ];

    for (const output of outputs) {
      expect(output).not.toMatch(ANSI_PATTERN);
    }
  });
});

describe("JsonFormatter — suspect flag & DCE warning (ticket #54)", () => {
  it("emits suspect and dceSusceptible booleans on baseline and benchmark documents", () => {
    const flagged = distribution({ suspect: true, dceSusceptible: true });

    const baseline = parse(formatter.formatBaseline(flagged, undefined));
    expect(baseline.suspect).toBe(true);
    expect(baseline.dceSusceptible).toBe(true);

    const benchmark = parse(formatter.formatBenchmark(flagged, distribution()));
    expect(benchmark.suspect).toBe(true);
    expect(benchmark.dceSusceptible).toBe(true);
  });

  it("reports false (never undefined) for a clean distribution", () => {
    const clean = parse(formatter.formatBaseline(distribution(), undefined));

    expect(clean.suspect).toBe(false);
    expect(clean.dceSusceptible).toBe(false);
  });
});
