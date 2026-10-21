import { describe, expect, it } from "vitest";
import { ANSI_PATTERN, acceptedStep, distribution, rejectedStep } from "./test-fixtures.js";
import { JsonFormatter } from "./json.js";
import { MarkdownFormatter } from "./markdown.js";
import { UnknownFormatError, createFormatter } from "./index.js";

const ALL_OUTPUTS = (format: ReturnType<typeof createFormatter>): string[] => [
  format.formatStep(rejectedStep),
  format.formatStep(acceptedStep),
  format.formatBaseline(distribution()),
  format.formatStatus({
    runId: "run-42",
    baseRef: "main",
    status: "idle",
    currentStep: 0,
    baseline: null,
    bestScore: -Infinity,
    bestStep: null,
    history: [],
    lock: null,
    lastError: null,
  }),
  format.formatTest({ passed: true, output: "ok", durationMs: 1 }),
  format.formatLint([]),
  format.formatBenchmark(distribution()),
  format.formatError(new Error("boom")),
];

describe("createFormatter", () => {
  it("returns the markdown adapter", () => {
    const format = createFormatter("markdown");

    expect(format).toBeInstanceOf(MarkdownFormatter);
    expect(format.format).toBe("markdown");
  });

  it("returns the json adapter", () => {
    const format = createFormatter("json");

    expect(format).toBeInstanceOf(JsonFormatter);
    expect(format.format).toBe("json");
  });

  it("throws a typed error for an unknown format string", () => {
    // Cast through unknown: the factory is typed, but callers reach it from
    // unvalidated CLI argv / MCP input, so the runtime guard must hold.
    const unknown = "yaml" as unknown as "json";

    expect(() => createFormatter(unknown)).toThrow(UnknownFormatError);

    try {
      createFormatter(unknown);
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownFormatError);
      expect((error as UnknownFormatError)._tag).toBe("UnknownFormatError");
      expect((error as UnknownFormatError).code).toBe("ERR_UNKNOWN_FORMAT");
      expect((error as Error).message).toContain("yaml");
    }
  });

  it("never emits ANSI through either adapter", () => {
    for (const format of ["markdown", "json"] as const) {
      for (const output of ALL_OUTPUTS(createFormatter(format))) {
        expect(output).not.toMatch(ANSI_PATTERN);
      }
    }
  });
});
