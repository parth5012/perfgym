/**
 * @perfgym/core
 * Negative Memory rendering — the single owner of how a remembered failure
 * becomes text.
 *
 * The gradient feedback synthesizer and the markdown formatter render the same
 * entry shape, so the formatting lives here once: every surface adds only its
 * own decoration around `formatNegativeMemoryEntry`.
 *
 * This module is a dependency-free leaf on purpose — it has no runtime import
 * at all — so a surface that renders the negative memory never pulls the
 * cache's `node:fs` / `node:crypto` dependencies into its runtime graph. The
 * entry type is imported type-only, which is erased at compile time.
 */

import type { NegativeMemoryEntry } from "./index.js";

/**
 * Format a measured delta: one decimal, a `%` sign and an explicit `+` for
 * non-negative values (`+2.5%`, `-8.3%`).
 */
export function formatDeltaPercent(deltaPercent: number): string {
  return deltaPercent >= 0 ? `+${deltaPercent.toFixed(1)}%` : `${deltaPercent.toFixed(1)}%`;
}

/**
 * Render one remembered failure as `<strategy> (<delta>): <reason>` — the
 * shared core of every surface that shows the negative memory.
 */
export function formatNegativeMemoryEntry(entry: NegativeMemoryEntry): string {
  return `${entry.strategy} (${formatDeltaPercent(entry.deltaPercent)}): ${entry.reason}`;
}
