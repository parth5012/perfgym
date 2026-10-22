/**
 * @perfgym/core
 * Negative Memory rendering — the single owner of how a remembered failure is
 * turned into text.
 *
 * Both the gradient feedback synthesizer and the markdown formatter render the
 * same entry shape, so the formatting lives here once: the surfaces add only
 * their own decoration around `formatNegativeMemoryEntry`.
 */

import { describe, expect, it } from "vitest";
import type { NegativeMemoryEntry } from "./index.js";
import { formatDeltaPercent, formatNegativeMemoryEntry } from "./render.js";

describe("formatDeltaPercent", () => {
  it("prefixes a non-negative delta with an explicit plus sign", () => {
    expect(formatDeltaPercent(2.5)).toBe("+2.5%");
    expect(formatDeltaPercent(0)).toBe("+0.0%");
    expect(formatDeltaPercent(12)).toBe("+12.0%");
  });

  it("keeps the minus sign of a negative delta", () => {
    expect(formatDeltaPercent(-8.3)).toBe("-8.3%");
    expect(formatDeltaPercent(-0.04)).toBe("-0.0%");
  });

  it("rounds to a single decimal", () => {
    expect(formatDeltaPercent(2.45)).toBe("+2.5%");
    expect(formatDeltaPercent(-2.45)).toBe("-2.5%");
  });

  it("renders a non-finite delta verbatim — no finite guard is applied", () => {
    expect(formatDeltaPercent(Number.NaN)).toBe("NaN%");
    expect(formatDeltaPercent(Number.POSITIVE_INFINITY)).toBe("+Infinity%");
    expect(formatDeltaPercent(Number.NEGATIVE_INFINITY)).toBe("-Infinity%");
  });
});

describe("formatNegativeMemoryEntry", () => {
  const entry: NegativeMemoryEntry = {
    id: "hash-serial-awaits",
    strategy: "serial awaits",
    deltaPercent: -8.3,
    reason: "regressed tail latency",
    step: 2,
    timestamp: 1_700_000_000_000,
  };

  it("renders strategy, delta and reason", () => {
    expect(formatNegativeMemoryEntry(entry)).toBe(
      "serial awaits (-8.3%): regressed tail latency",
    );
  });

  it("renders a non-negative delta with a plus sign", () => {
    expect(
      formatNegativeMemoryEntry({
        ...entry,
        deltaPercent: 2.5,
        reason: "gain below the significance threshold",
      }),
    ).toBe("serial awaits (+2.5%): gain below the significance threshold");
  });
});
