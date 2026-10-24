import type { Table } from "@tanstack/table-core";
import type { StepTableRow } from "./table.js";

/**
 * Dependency-free CLI table renderer (Ticket #47).
 *
 * Consumes the headless TanStack Table model (`Table<StepTableRow>`) and draws
 * it with box-drawing characters only — no cli-table3/table dependency.
 * The renderer only draws; column defs, rows, and cell accessors come from
 * `createStepHistoryTable` / `stepTableColumns`.
 */

export const emptyStepHistoryMessage = "No steps recorded yet.";

/** Numeric-display columns (by column id) are right-aligned. */
const RIGHT_ALIGNED_IDS = new Set(["iteration", "score", "deltaPercent", "penalty", "durationMs"]);

/**
 * Renders the step-history table to a CLI-safe string. An empty history renders
 * as a single "no steps yet" line — never an empty box.
 */
export function renderStepTable(table: Table<StepTableRow>): string {
  const rows = table.getRowModel().rows;
  if (rows.length === 0) {
    return emptyStepHistoryMessage;
  }

  const headers = table.getFlatHeaders();
  const headerTexts = headers.map((header) => {
    const def = header.column.columnDef.header;
    return typeof def === "string" ? def : header.column.id;
  });
  const cellTexts = rows.map((row) => row.getAllCells().map((cell) => String(cell.getValue())));

  // Column width = max(header, cells) — dependency-free string math only.
  const widths = headerTexts.map((header, columnIndex) =>
    Math.max(header.length, ...cellTexts.map((cells) => (cells[columnIndex] ?? "").length))
  );
  const align = (columnIndex: number) =>
    RIGHT_ALIGNED_IDS.has(headers[columnIndex]?.column.id ?? "") ? "right" : "left";
  const pad = (text: string, width: number, alignment: "left" | "right"): string =>
    alignment === "right" ? text.padStart(width) : text.padEnd(width);
  const edge = (junction: string) =>
    "─".repeat(widths[0] + 2) + widths.slice(1).map((width) => junction + "─".repeat(width + 2)).join("");

  const top = "┌" + edge("┬") + "┐";
  const separator = "├" + edge("┼") + "┤";
  const bottom = "└" + edge("┴") + "┘";
  const drawRow = (cells: readonly string[]): string =>
    "│ " +
    cells
      .map((cell, i) => pad(cell, widths[i], align(i)))
      .join(" │ ") +
    " │";

  const headerRow = drawRow(headerTexts);
  const dataRows = cellTexts.map((cells) => drawRow(cells));

  return [top, headerRow, separator, ...dataRows, bottom].join("\n");
}
