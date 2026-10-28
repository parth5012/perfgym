import { describe, expect, it } from "vitest";
import {
  CHECKSUM_PREFIX,
  blackhole,
  computeChecksum,
  parseChecksum,
  verifyChecksum,
} from "@perfgym/core/bench";
import { blackhole as blackholeFromMainEntry } from "@perfgym/core";

/**
 * The black-hole sink (FLAW-10 / ticket #54): a benchmark's result must be
 * consumed by an un-optimizable sink or V8's Turbofan eliminates the whole
 * computation as dead code. `blackhole(result)` folds the value into a
 * checksum published on stderr at process exit; the runner verifies that
 * checksum against the metric value it parsed from stdout.
 */
describe("blackhole sink (@perfgym/core/bench, FLAW-10 / ticket #54)", () => {
  it("is importable from the @perfgym/core/bench subpath AND the main entry (AC5)", () => {
    expect(typeof blackhole).toBe("function");
    expect(typeof blackholeFromMainEntry).toBe("function");
    // Both specifiers resolve to the SAME sink — not a duplicated copy.
    expect(blackholeFromMainEntry).toBe(blackhole);
  });

  it("returns the value it consumed so it can be used inline", () => {
    expect(blackhole(42)).toBe(42);
    expect(blackhole("payload")).toBe("payload");
  });

  it("computes a deterministic checksum: equal values match, different values differ", () => {
    expect(computeChecksum(42)).toBe(computeChecksum(42));
    expect(computeChecksum(42)).not.toBe(computeChecksum(43));
    expect(computeChecksum(42)).toMatch(/^[0-9a-f]{8}$/);
  });

  it("parses a published checksum line out of stderr and verifies it (AC1 unit)", () => {
    const checksum = computeChecksum(42);
    const stderr = `noisy output\n${CHECKSUM_PREFIX}${JSON.stringify({ checksum })}\n`;

    expect(parseChecksum(stderr)).toBe(checksum);
    expect(verifyChecksum(stderr, 42)).toBe("verified");
    // The sink consumed 42 but the runner parsed 7 — verification must fail.
    expect(verifyChecksum(stderr, 7)).toBe("mismatch");
    // No published checksum at all.
    expect(verifyChecksum("quiet stderr", 42)).toBe("missing");
    expect(parseChecksum("quiet stderr")).toBeNull();
  });
});
