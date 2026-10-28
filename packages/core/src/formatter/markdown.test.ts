import { describe, expect, it } from "vitest";
import {
  ANSI_PATTERN,
  acceptedStep,
  distribution,
  invariantFail,
  minimizeConfig,
  rejectedStep,
  shortCircuitStep,
  sessionState,
  typecheckViolation,
  violation,
} from "./test-fixtures.js";
import { MarkdownFormatter } from "./markdown.js";
import type { NegativeMemoryEntry } from "../memory/index.js";

const formatter = new MarkdownFormatter();

describe("MarkdownFormatter.formatStep — LLD §6.2 template", () => {
  it("reproduces the documented section order and headers", () => {
    const output = formatter.formatStep(rejectedStep);

    const headers = output.split("\n").filter((line) => line.startsWith("####"));
    expect(headers).toEqual([
      "#### 1. Invariants & Types",
      "#### 2. Performance Distribution (Baseline vs Mutation)",
      "#### 3. AST Pattern Violations (-10 Penalty Points)",
      "#### 4. Negative Memory & Next Action",
    ]);
  });

  it("opens with the emoji status header and the score", () => {
    const rejected = formatter.formatStep(rejectedStep).split("\n")[0]!;
    expect(rejected).toContain("### ❌ [REVERTED]");
    expect(rejected).toContain("Mutation at step 3");
    expect(rejected).toContain("Score: -∞");

    const accepted = formatter.formatStep(acceptedStep).split("\n")[0]!;
    expect(accepted).toContain("### ✅ [ACCEPTED]");
    expect(accepted).toContain("Score: 12.4");
  });

  it("states the rollback and its latency for a rejected step", () => {
    const output = formatter.formatStep(rejectedStep);

    expect(output).toContain("safely rolled back in **340ms**");
    expect(output).toContain("Tail guard regression");
  });

  it("renders the invariants and typecheck bullets", () => {
    const output = formatter.formatStep(rejectedStep);

    expect(output).toContain("- **Unit / Invariant Tests:** ✅ Passed (85ms)");
    expect(output).toContain("- **Typecheck Gate:** ✅ Clean (no type suppressions)");
  });

  it("marks a failed invariant gate and a failed typecheck gate", () => {
    const output = formatter.formatStep(shortCircuitStep);

    expect(output).toContain("- **Unit / Invariant Tests:** ❌ Failed (120ms)");
    expect(output).toContain("- **Typecheck Gate:** ❌ Failed");
  });

  it("checks the tail guard when the metric goal is configured", () => {
    const output = formatter.formatStep(rejectedStep, minimizeConfig);

    expect(output).toContain("(Tail Guard failed)");
  });

  it("does not repeat typecheck sentinel failures as AST violations", () => {
    const output = formatter.formatStep(shortCircuitStep);

    expect(output).toContain("#### 3. AST Pattern Violations (-0 Penalty Points)");
    expect(output).toContain("No AST pattern violations detected.");
    expect(output).not.toContain("perfgym:typecheck");
    expect(output).toContain("#### 1. Invariants & Types");
  });

  it("renders the baseline-vs-mutation distribution table", () => {
    const output = formatter.formatStep(rejectedStep);

    expect(output).toContain("| Metric | Baseline | Current Mutation | Delta |");
    expect(output).toContain("| **Median (p50)** | `42.1ms` | `43.1ms` |");
    expect(output).toContain("| **p95** | `51.2ms` | `53.0ms` |");
    expect(output).toContain("| **p99 (Tail)** | `58.0ms` | `61.2ms` |");
    expect(output).toContain("| **Max Spike** | `62.1ms` | `65.4ms` |");
    expect(output).toContain("Tail Guard");
  });

  it("renders AST violations with location, penalty and a recommendation", () => {
    const output = formatter.formatStep(rejectedStep);

    expect(output).toContain("**`src/checkout/process.ts:42`** — `no-await-in-loop` (penalty: -10)");
    expect(output).toContain("*Recommendation:");
  });

  it("renders a clean lint section when there are no violations", () => {
    const output = formatter.formatStep(acceptedStep);

    expect(output).toContain("#### 3. AST Pattern Violations (-0 Penalty Points)");
    expect(output).toContain("No AST pattern violations detected.");
  });

  it("omits the negative-memory section entirely when no memory and no revert reason exist", () => {
    const output = formatter.formatStep(acceptedStep);

    expect(output).not.toContain("#### 4. Negative Memory & Next Action");
    expect(output).not.toContain("Next Direction");
  });

  it("renders negative memory when entries are supplied", () => {
    const memory: readonly NegativeMemoryEntry[] = [
      {
        id: "hash-serial-awaits",
        strategy: "serial awaits",
        deltaPercent: -8.3,
        reason: "Regressed tail latency.",
        step: 2,
        timestamp: 1_700_000_000_000,
      },
      {
        id: "hash-batch-500",
        strategy: "batch size 500",
        deltaPercent: 2.5,
        reason: "Keep batch size <= 50 to stay inside the socket pool.",
        step: 4,
        timestamp: 1_700_000_001_000,
      },
    ];
    const withMemory = new MarkdownFormatter({ negativeMemory: memory });

    const output = withMemory.formatStep(rejectedStep);

    expect(output).toContain("#### 4. Negative Memory & Next Action");
    expect(output).toContain("- ⚠️ *serial awaits (-8.3%): Regressed tail latency.*");
    expect(output).toContain(
      "- ⚠️ *batch size 500 (+2.5%): Keep batch size <= 50 to stay inside the socket pool.*",
    );
    expect(output).toContain("Next Direction");
  });

  it("treats a nullable memory dependency as absent", () => {
    const withNullMemory = new MarkdownFormatter({ negativeMemory: null });

    expect(withNullMemory.formatStep(acceptedStep)).not.toContain("#### 4. Negative Memory");
  });

  it("strips ANSI escapes from a remembered failure", () => {
    const memory: readonly NegativeMemoryEntry[] = [
      {
        id: "hash-ansi",
        strategy: "serial awaits",
        deltaPercent: -8.3,
        reason: "\u001b[31mRegressed tail latency.\u001b[39m",
        step: 2,
        timestamp: 1_700_000_000_000,
      },
    ];

    const output = new MarkdownFormatter({ negativeMemory: memory }).formatStep(rejectedStep);

    expect(output).toContain("- ⚠️ *serial awaits (-8.3%): Regressed tail latency.*");
    expect(output).not.toContain("\u001b[");
  });

  it("treats an empty memory list as absent", () => {
    const withEmptyMemory = new MarkdownFormatter({ negativeMemory: [] });

    expect(withEmptyMemory.formatStep(acceptedStep)).not.toContain("#### 4. Negative Memory");
    expect(withEmptyMemory.formatStep(acceptedStep)).not.toContain("⚠️");
  });

  it("emits no ANSI escape sequences", () => {
    for (const evaluation of [rejectedStep, acceptedStep, shortCircuitStep]) {
      expect(formatter.formatStep(evaluation)).not.toMatch(ANSI_PATTERN);
    }
  });
});

describe("MarkdownFormatter.formatNegativeMemory — the memory surface", () => {
  const memory: readonly NegativeMemoryEntry[] = [
    {
      id: "hash-serial-awaits",
      strategy: "src/api/checkout.ts, src/api/order.ts",
      deltaPercent: -8.3,
      reason: "Regressed tail latency.",
      step: 2,
      timestamp: 1_700_000_000_000,
    },
    {
      id: "hash-batch-500",
      strategy: "src/api/order.ts",
      deltaPercent: 2.5,
      reason: "Keep batch size <= 50 to stay inside the socket pool.",
      step: 4,
      timestamp: 1_700_000_001_000,
    },
  ];

  it("renders the target, the count and every remembered failure", () => {
    const output = formatter.formatNegativeMemory(memory, { target: "checkout" });

    expect(output).toContain("checkout");
    expect(output).toContain("2");
    expect(output).toContain(
      "src/api/checkout.ts, src/api/order.ts (-8.3%): Regressed tail latency.",
    );
    expect(output).toContain(
      "src/api/order.ts (+2.5%): Keep batch size <= 50 to stay inside the socket pool.",
    );
  });

  it("renders the empty state when nothing is remembered", () => {
    const output = formatter.formatNegativeMemory([], { target: "checkout" });

    expect(output).toContain("checkout");
    expect(output.toLowerCase()).toContain("nothing remembered");
  });

  it("renders without a target when none is supplied", () => {
    const output = formatter.formatNegativeMemory(memory);

    expect(output).toContain("src/api/order.ts (+2.5%)");
  });

  it("omits the target line for an empty or null target", () => {
    const empty = formatter.formatNegativeMemory(memory, { target: "" });
    expect(empty).not.toContain("**Target:**");
    expect(empty).toContain("src/api/order.ts (+2.5%)");

    const nullTarget = formatter.formatNegativeMemory(memory, { target: null });
    expect(nullTarget).not.toContain("**Target:**");
  });

  it("strips ANSI escapes from a remembered failure", () => {
    const noisy: readonly NegativeMemoryEntry[] = [
      {
        ...memory[0]!,
        reason: "\u001b[31mRegressed tail latency.\u001b[39m",
      },
    ];

    const output = formatter.formatNegativeMemory(noisy, { target: "checkout" });

    expect(output).toContain("Regressed tail latency.");
    expect(output).not.toMatch(ANSI_PATTERN);
  });
});

describe("MarkdownFormatter — remaining surface", () => {
  it("formatBaseline renders a stats table", () => {
    const output = formatter.formatBaseline(distribution());

    expect(output).toContain("### 📊 Baseline Recorded");
    expect(output).toContain("| **p50** |");
    expect(output).toContain("`42.1ms`");
  });

  it("formatStatus renders run metadata", () => {
    const output = formatter.formatStatus(sessionState, null);

    expect(output).toContain("### 📍 Session Status: accepted");
    expect(output).toContain("run-42");
    expect(output).toContain("**Step:** 4");
  });

  it("formatTest renders the invariant verdict and output", () => {
    const output = formatter.formatTest(invariantFail);

    expect(output).toContain("### ❌ Invariant Tests Failed (120ms)");
    expect(output).toContain("1 test failed");
  });

  it("formatLint renders violations or a clean bill", () => {
    expect(formatter.formatLint([violation])).toContain("`src/checkout/process.ts:42`");
    expect(formatter.formatLint([violation])).toContain("Total penalty: -10");
    expect(formatter.formatLint([])).toContain("No AST pattern violations detected.");
  });

  it("strips ANSI from typecheck, lint and lastError strings", () => {
    const ansi = (value: string): string => `\u001b[31m${value}\u001b[0m`;

    const step = formatter.formatStep({
      ...shortCircuitStep,
      violations: [{ ...typecheckViolation, message: ansi("Types broken") }],
    });
    expect(step).toContain("Types broken");
    expect(step).not.toMatch(ANSI_PATTERN);

    const lint = formatter.formatLint([{ ...violation, message: ansi("Avoid serial awaits") }]);
    expect(lint).toContain("Avoid serial awaits");
    expect(lint).not.toMatch(ANSI_PATTERN);

    const status = formatter.formatStatus({ ...sessionState, lastError: ansi("boom") }, null);
    expect(status).toContain("**Last error:** boom");
    expect(status).not.toMatch(ANSI_PATTERN);
  });

  it("formatLint keeps typecheck sentinel violations out of the AST list", () => {
    expect(formatter.formatLint([typecheckViolation])).toContain(
      "No AST pattern violations detected.",
    );
  });

  it("strips ANSI from forwarded invariant output", () => {
    const output = formatter.formatTest({
      passed: true,
      output: "\u001b[32m5 tests passed\u001b[0m",
      durationMs: 1,
    });

    expect(output).toContain("5 tests passed");
    expect(output).not.toMatch(ANSI_PATTERN);
  });

  it("formatBenchmark renders current vs baseline", () => {
    const output = formatter.formatBenchmark(distribution({ p50: 43.1 }), distribution());

    expect(output).toContain("### ⏱️ Benchmark Distribution");
    expect(output).toContain("`43.1ms`");
    expect(output).toContain("`42.1ms`");
  });

  it("formatError renders name and message without leaking stack traces", () => {
    const output = formatter.formatError(new Error("boom"));

    expect(output).toContain("### ❌ Error");
    expect(output).toContain("**Error:** boom");
    expect(output).not.toContain("    at ");
  });

  it("strips ANSI from revert reasons and error messages", () => {
    const noisyStep = {
      ...rejectedStep,
      revertReason: "\u001b[31mInvariants failed\u001b[0m",
    };

    expect(formatter.formatStep(noisyStep)).not.toMatch(ANSI_PATTERN);
    expect(formatter.formatStep(noisyStep)).toContain("Invariants failed");
    expect(formatter.formatError(new Error("\u001b[31mboom\u001b[0m"))).not.toMatch(ANSI_PATTERN);
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

describe("MarkdownFormatter — suspect flag & DCE warning (ticket #54)", () => {
  it("surfaces the suspect flag and the DCE-susceptible warning on baseline and benchmark reports", () => {
    const flagged = distribution({ suspect: true, dceSusceptible: true });

    const baseline = formatter.formatBaseline(flagged);
    expect(baseline).toContain("SUSPECT");
    expect(baseline).toContain("DCE-susceptible");
    expect(baseline).toContain("blackhole");

    const benchmark = formatter.formatBenchmark(flagged, distribution());
    expect(benchmark).toContain("SUSPECT");
    expect(benchmark).toContain("DCE-susceptible");
  });

  it("surfaces both warnings on the step's current distribution", () => {
    const output = formatter.formatStep({
      ...acceptedStep,
      currentDistribution: distribution({ suspect: true, dceSusceptible: true }),
    });

    expect(output).toContain("SUSPECT");
    expect(output).toContain("DCE-susceptible");
  });

  it("a clean distribution carries neither warning", () => {
    const clean = formatter.formatBaseline(distribution());

    expect(clean).not.toContain("SUSPECT");
    expect(clean).not.toContain("DCE-susceptible");
    expect(formatter.formatStep(acceptedStep)).not.toContain("DCE-susceptible");
  });
});
