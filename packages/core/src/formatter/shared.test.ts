import { describe, expect, it } from "vitest";
import { stripAnsiDeep } from "./shared.js";

describe("stripAnsiDeep", () => {
  it("strips ANSI from nested strings and preserves every other value", () => {
    const input = {
      status: "ACCEPTED",
      score: 12.4,
      missing: null,
      invariants: { output: "\u001b[31mred\u001b[0m", passed: true },
      evaluations: [
        { revertReason: "\u001b[1mbold\u001b[0m", nested: ["\u001b[32mgreen\u001b[0m"], count: 2 },
      ],
    };

    const clean = stripAnsiDeep(input) as typeof input;

    expect(clean.invariants.output).toBe("red");
    expect(clean.evaluations[0]!.revertReason).toBe("bold");
    expect(clean.evaluations[0]!.nested[0]).toBe("green");
    expect(clean.evaluations[0]!.count).toBe(2);
    expect(clean.score).toBe(12.4);
    expect(clean.missing).toBeNull();
    expect(clean.status).toBe("ACCEPTED");
  });

  it("returns a new structure and never mutates its input", () => {
    const input = { output: "\u001b[31mred\u001b[0m" };

    const clean = stripAnsiDeep(input);

    expect(clean).not.toBe(input);
    expect(input.output).toContain("\u001b");
  });
});
