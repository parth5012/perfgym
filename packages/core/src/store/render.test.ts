import { createStepHistoryTable, mapEvaluationsToTableRows, stepTableColumns } from "./table.js";
import type { StepEvaluation } from "../index.js";
import { renderStepTable } from "./render.js";
import { describe, expect, it } from "vitest";

const baselineEval = (overrides: Partial<StepEvaluation> = {}): StepEvaluation => ({
  iteration: 1,
  fitnessScore: 99.1,
  accepted: true,
  isSignificant: true,
  deltaPercent: 1.2,
  invariants: { passed: true, output: "", durationMs: 12 },
  violations: [],
  metrics: [
    {
      name: "cycles",
      value: 1000,
      unit: "count",
      improved: true,
      deltaPercent: 1.2,
    },
  ],
  executionTimeMs: 300,
  ...overrides,
});

describe("renderStepTable (Ticket #47 — dependency-free CLI table renderer)", () => {
  it("renders headers exactly as defined by stepTableColumns", () => {
    const table = createStepHistoryTable([baselineEval()]);
    const output = renderStepTable(table);

    for (const column of stepTableColumns) {
      // columnHelper columns resolve their header via getValue() on the header object,
      // but at definition time the header string is in the column def.
      const header = column.header;
      expect(typeof header).toBe("string");
      expect(output).toContain(header as string);
    }
    expect(output).toContain("Iter");
    expect(output).toContain("Fitness");
    expect(output).toContain("Delta %");
    expect(output).toContain("Decision");
    expect(output).toContain("Invariants");
    expect(output).toContain("Types");
    expect(output).toContain("Penalty");
    expect(output).toContain("Time (ms)");
  });

  it("snapshots the rendered table for a 3-step history", () => {
    const threeSteps: StepEvaluation[] = [
      baselineEval(),
      baselineEval({
        iteration: 2,
        fitnessScore: 98.55,
        accepted: false,
        isSignificant: false,
        deltaPercent: -0.5,
        invariants: { passed: true, output: "", durationMs: 15 },
        metrics: [{ name: "cycles", value: 1005, unit: "count", improved: false, deltaPercent: -0.5 }],
      }),
      baselineEval({
        iteration: 3,
        fitnessScore: 104.2,
        isSignificant: true,
        deltaPercent: 5.3,
        invariants: { passed: false, output: "lint failed", durationMs: 20 },
        metrics: [{ name: "cycles", value: 980, unit: "count", improved: true, deltaPercent: 5.3 }],
        violations: [
          { ruleId: "r1", message: "boom", file: "a.ts", line: 1, severity: "error", penalty: 100 },
        ],
      }),
    ];
    expect(renderStepTable(createStepHistoryTable(threeSteps))).toMatchInlineSnapshot(`
      "┌──────┬─────────┬─────────┬──────────────┬────────────┬───────┬─────────┬───────────┐
      │ Iter │ Fitness │ Delta % │ Decision     │ Invariants │ Types │ Penalty │ Time (ms) │
      ├──────┼─────────┼─────────┼──────────────┼────────────┼───────┼─────────┼───────────┤
      │    1 │   99.10 │   +1.2% │ ACCEPTED     │ PASS       │ PASS  │       0 │        12 │
      │    2 │   98.55 │   -0.5% │ REJECTED     │ PASS       │ PASS  │       0 │        15 │
      │    3 │  104.20 │   +5.3% │ DISQUALIFIED │ FAIL       │ PASS  │     100 │        20 │
      └──────┴─────────┴─────────┴──────────────┴────────────┴───────┴─────────┴───────────┘"
    `);
  });

  it("snapshots the rendered table for an empty history", () => {
    expect(renderStepTable(createStepHistoryTable([]))).toMatchInlineSnapshot(`"No steps recorded yet."`);
  });

  it("never leaks Infinity/-Infinity tokens into the output", () => {
    const scores: StepEvaluation[] = [
      baselineEval({
        iteration: 1,
        fitnessScore: -Infinity,
        metrics: [{ name: "cycles", value: 1000, unit: "count", improved: false, deltaPercent: -Infinity }],
      }),
      baselineEval({
        iteration: 2,
        fitnessScore: Infinity,
        accepted: true,
        metrics: [{ name: "cycles", value: 900, unit: "count", improved: true, deltaPercent: Infinity }],
      }),
    ];
    const output = renderStepTable(createStepHistoryTable(scores));

    expect(output).not.toContain("Infinity");
    expect(output).not.toContain("NaN");
    expect(output).not.toContain("-%");
    expect(output).toContain("-");
  });

  it("substitutes the '-' token at the row-mapping layer before rendering", () => {
    const rows = mapEvaluationsToTableRows([
      baselineEval({ fitnessScore: -Infinity }),
      baselineEval({ fitnessScore: Infinity }),
    ]);
    expect(rows[0]?.score).not.toContain("Infinity");
    expect(rows[1]?.score).not.toContain("Infinity");
  });

  it("right-aligns numeric columns under fixed widths", () => {
    const output = renderStepTable(createStepHistoryTable([baselineEval()]));
    const dataLine = output.split("\n").find((line) => line.includes("99.10"));
    expect(dataLine).toBeDefined();
    // 'Fitness' is 7 wide, so a 5-char cell is padded with 2 leading spaces
    expect(dataLine).toContain("   99.10 ");
    expect(dataLine).toContain("      0 "); // Penalty (7 wide, right-aligned)
  });
});
