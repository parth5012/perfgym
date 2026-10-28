/**
 * ============================================================================
 * Black-hole sink & checksum verification (FLAW-10, ticket #54)
 * ============================================================================
 *
 * V8's Turbofan eliminates a benchmark computation whose result is never
 * consumed — the metric silently collapses to a meaningless constant. The
 * countermeasure is a certified black-box sink: the benchmark calls
 *
 * ```ts
 * import { blackhole } from "@perfgym/core"; // main entry — the supported
 *                                            // distribution import
 * const result = heavyWork();
 * blackhole(result); // result MUST be the value reported as the metric
 * console.log(JSON.stringify({ value: result }));
 * ```
 *
 * `blackhole(value)` folds the value into a checksum (FNV-1a over a stable
 * string form) and publishes it on STDERR — `__perfgym_checksum__{"checksum":…}`
 * — from a synchronous `process.on("exit")` hook, exactly like the timer
 * bootstrap's stamp (`pipeline/bootstrap.ts`). Async stderr writes can be
 * dropped while a process is exiting; `fs.writeSync(2, …)` cannot.
 *
 * The runner (`pipeline/benchmark.ts`) verifies a PUBLISHED checksum against
 * the metric value it parsed from stdout: a mismatch rejects the sample into
 * the same re-collection budget as the timer tripwire. A metric declared
 * `require_checksum: true` (`.perfgym.yaml`) additionally treats a MISSING
 * checksum as an invalid sample; benchmarks that never adopt the sink keep
 * running and are flagged DCE-susceptible instead (no forced breaking change).
 *
 * Contract: call `blackhole` with the value you report — the LAST consumed
 * value is what gets published, and it must equal the parsed metric value.
 *
 * WHY A MODULE (not a raw injected string): unlike `TIMER_BOOTSTRAP_SOURCE`,
 * this file is imported by user benchmark code (through the main entry or the
 * in-repo `@perfgym/core/bench` alias), so a normal typed module is fine.
 */

import { writeSync } from "node:fs";

/** Stderr line prefix of a published sink checksum (kept in sync with the exit hook). */
export const CHECKSUM_PREFIX = "__perfgym_checksum__";

/** Verdict of `verifyChecksum` over one spawn's stderr. */
export type ChecksumVerdict = "missing" | "mismatch" | "verified";

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Stable string form of a consumed value: the raw string itself, the
 * primitive form, or JSON when the value is a structure. Non-serializable
 * values (circular structures) fall back to `String(value)` so the checksum
 * stays defined for every input.
 */
const serialize = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return String(value);
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Circular / exotic structure — fall through to String(value).
  }
  return String(value);
};

/**
 * Deterministic FNV-1a (32-bit) checksum of a value, zero-padded to 8 hex
 * chars. Equal values always produce the same checksum in any process; the
 * runner recomputes it from the parsed metric value to verify the sink.
 */
export const computeChecksum = (value: unknown): string => {
  const text = serialize(value);
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

let lastConsumed: unknown = undefined;
let exitHookInstalled = false;

/**
 * Consume `value` so the compiler cannot eliminate the computation that
 * produced it (FLAW-10), and remember it for checksum publication at process
 * exit. Returns `value` unchanged, so the sink composes inline. The LAST
 * call's value is published — it must be the metric value the benchmark
 * reports on stdout.
 */
export function blackhole<T>(value: T): T {
  lastConsumed = value;
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    // Best-effort synchronous flush to fd 2, mirroring the timer bootstrap's
    // stamp hook: stderr may be closed or mid-kill when the exit fires.
    process.on("exit", () => {
      try {
        writeSync(
          2,
          `\n${CHECKSUM_PREFIX}${JSON.stringify({ checksum: computeChecksum(lastConsumed) })}\n`
        );
      } catch {
        // stderr unavailable — the publication is dropped, never fatal.
      }
    });
  }
  return value;
}

/**
 * Parse the checksum a benchmark published on stderr. Returns `null` when no
 * well-formed line exists (a non-Node command, a sink-less benchmark, or a
 * stamp-less kill) — foreign or malformed lines are ignored.
 *
 * Scans BACKWARDS and returns the LAST well-formed line: the exit hook
 * publishes the final consumed value last, so diagnostic noise or an earlier
 * publication sharing the prefix must never mask it.
 */
export function parseChecksum(stderr: string): string | null {
  const lines = stderr.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (!line.startsWith(CHECKSUM_PREFIX)) continue;
    try {
      const parsed = JSON.parse(line.slice(CHECKSUM_PREFIX.length)) as { checksum?: unknown };
      if (typeof parsed.checksum === "string" && parsed.checksum.length > 0) {
        return parsed.checksum;
      }
    } catch {
      // Malformed checksum line — ignored.
    }
  }
  return null;
}

/**
 * Verify the published checksum against the metric value the runner parsed
 * from stdout:
 * - `"missing"` — no checksum published (a sink-less benchmark);
 * - `"mismatch"` — published, but it does not hash to the reported value
 *   (the sink consumed something other than what was reported);
 * - `"verified"` — the reported metric value was consumed by the sink.
 */
export function verifyChecksum(stderr: string, metricValue: number): ChecksumVerdict {
  const published = parseChecksum(stderr);
  if (published === null) return "missing";
  return published === computeChecksum(metricValue) ? "verified" : "mismatch";
}
