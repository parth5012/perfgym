import {
  createTable,
  getCoreRowModel,
  createColumnHelper,
  type Table,
  type TableState,
} from "@tanstack/table-core";
import type { StepEvaluation } from "../index.js";

export interface StepTableRow {
  readonly iteration: number;
  readonly score: string;
  readonly deltaPercent: string;
  readonly status: "ACCEPTED" | "REJECTED" | "DISQUALIFIED";
  readonly invariants: "PASS" | "FAIL";
  readonly typecheck: "PASS" | "FAIL";
  readonly penalty: number;
  readonly durationMs: number;
}

const columnHelper = createColumnHelper<StepTableRow>();

export const stepTableColumns = [
  columnHelper.accessor("iteration", {
    id: "iteration",
    header: "Iter",
  }),
  columnHelper.accessor("score", {
    id: "score",
    header: "Fitness",
  }),
  columnHelper.accessor("deltaPercent", {
    id: "deltaPercent",
    header: "Delta %",
  }),
  columnHelper.accessor("status", {
    id: "status",
    header: "Decision",
  }),
  columnHelper.accessor("invariants", {
    id: "invariants",
    header: "Invariants",
  }),
  columnHelper.accessor("typecheck", {
    id: "typecheck",
    header: "Types",
  }),
  columnHelper.accessor("penalty", {
    id: "penalty",
    header: "Penalty",
  }),
  columnHelper.accessor("durationMs", {
    id: "durationMs",
    header: "Time (ms)",
  }),
];

/**
 * Dependency-free numeric display token (Ticket #47): non-finite numbers
 * (±Infinity, NaN) collapse to "-" so they never leak into the CLI/report.
 */
export function formatMetricToken(value: number, digits: number, prefix = ""): string {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return `${prefix}${value.toFixed(digits)}`;
}

export function mapEvaluationsToTableRows(evaluations: readonly StepEvaluation[]): StepTableRow[] {
  return evaluations.map((ev) => {
    let status: StepTableRow["status"] = ev.accepted ? "ACCEPTED" : "REJECTED";
    if (ev.violations?.some((v) => v.severity === "error" && v.penalty >= 100)) {
      status = "DISQUALIFIED";
    }

    const firstMetric = ev.metrics[0];
    const deltaVal = firstMetric?.deltaPercent ?? 0;
    // A non-finite metric renders as a bare "-" token — appending the percent
    // suffix to a substitution token would leak "-%" into the UI.
    const deltaToken = formatMetricToken(deltaVal, 1, deltaVal >= 0 ? "+" : "");
    const deltaStr = deltaToken === "-" ? "-" : `${deltaToken}%`;

    return {
      iteration: ev.iteration,
      score: formatMetricToken(ev.fitnessScore, 2),
      deltaPercent: deltaStr,
      status,
      invariants: ev.invariants?.passed ? "PASS" : "FAIL",
      typecheck: "PASS",
      penalty: ev.violations?.reduce((sum, v) => sum + v.penalty, 0) ?? 0,
      durationMs: ev.invariants?.durationMs ?? 0,
    };
  });
}

export function createStepHistoryTable(evaluations: readonly StepEvaluation[]): Table<StepTableRow> {
  const data = mapEvaluationsToTableRows(evaluations);
  // TanStack's header-group derivation dereferences columnPinning.left/right
  // unguarded, so the headless table must start with the visibility/pinning
  // defaults for a flat, unpinned column model (Ticket #47).
  let state = {
    columnOrder: [],
    columnPinning: { left: [], right: [] },
    columnVisibility: {},
  } as unknown as TableState;

  return createTable({
    data,
    columns: stepTableColumns,
    getCoreRowModel: getCoreRowModel(),
    state,
    onStateChange: (updater) => {
      state = typeof updater === "function" ? updater(state) : updater;
    },
    renderFallbackValue: "-",
  });
}
