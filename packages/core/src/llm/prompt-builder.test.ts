import { describe, expect, it } from "vitest";
import { MutationSchema } from "./schema.js";
import {
  DEFAULT_PROMPT_BYTE_BUDGET,
  PromptBuilder,
  TRUNCATION_MARKER,
  type PromptBuilderInput,
} from "./prompt-builder.js";
import { createDriver } from "./index.js";
import { UnknownDriverError } from "../errors.js";

describe("MutationSchema", () => {
  it("accepts a well-formed mutation payload", () => {
    const valid = {
      mutations: [
        {
          path: "src/worker.ts",
          content: "export function run() { return 42; }",
          rationale: "Inline constant return to reduce latency",
        },
      ],
    };
    const parsed = MutationSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  it("accepts an empty mutations array representing giving up", () => {
    const empty = { mutations: [] };
    const parsed = MutationSchema.parse(empty);
    expect(parsed.mutations).toHaveLength(0);
  });

  it("rejects a payload with a missing content field", () => {
    const invalid = {
      mutations: [
        {
          path: "src/worker.ts",
          rationale: "Missing content",
        },
      ],
    };
    expect(() => MutationSchema.parse(invalid)).toThrow();
  });

  it("rejects non-object or malformed structures", () => {
    expect(() => MutationSchema.parse(null)).toThrow();
    expect(() => MutationSchema.parse({})).toThrow();
    expect(() => MutationSchema.parse({ mutations: "not-an-array" })).toThrow();
  });
});

describe("PromptBuilder", () => {
  const baseInput: PromptBuilderInput = {
    target: {
      name: "fast-service",
      language: "typescript",
      files: ["src/handler.ts", "src/util.ts"],
    },
    metric: {
      name: "latency_p95",
      unit: "ms",
      goal: "minimize",
      baseline: 120,
      currentBest: 95,
    },
    targetFiles: [
      {
        path: "src/handler.ts",
        content: "export function handle() { return 'handled'; }",
        mtimeMs: 2000,
      },
      {
        path: "src/util.ts",
        content: "export function helper() { return true; }",
        mtimeMs: 1000,
      },
    ],
    lastFeedback: "[REVERTED] Mutation was rejected and rolled back.\nReason: Benchmark degraded",
    negativeMemory: [
      {
        id: "hash123",
        strategy: "loop unrolling",
        deltaPercent: -15.5,
        reason: "Benchmark 'latency_p95': degraded by -15.5%",
        step: 1,
        timestamp: 1700000000000,
      },
    ],
  };

  it("orders the seven blocks correctly and includes all blocks when negative memory is present", () => {
    const prompt = PromptBuilder.build(baseInput);

    const b1Idx = prompt.indexOf("### Block 1: Role & Objective");
    const b2Idx = prompt.indexOf("### Block 2: Hard Constraints");
    const b3Idx = prompt.indexOf("### Block 3: Metric Context");
    const b4Idx = prompt.indexOf("### Block 4: Target Source Files");
    const b5Idx = prompt.indexOf("### Block 5: Last Iteration Feedback");
    const b6Idx = prompt.indexOf("### Block 6: Previously Failed Strategies (Negative Memory)");
    const b7Idx = prompt.indexOf("### Block 7: Output Contract (JSON Only)");

    expect(b1Idx).toBeGreaterThanOrEqual(0);
    expect(b2Idx).toBeGreaterThan(b1Idx);
    expect(b3Idx).toBeGreaterThan(b2Idx);
    expect(b4Idx).toBeGreaterThan(b3Idx);
    expect(b5Idx).toBeGreaterThan(b4Idx);
    expect(b6Idx).toBeGreaterThan(b5Idx);
    expect(b7Idx).toBeGreaterThan(b6Idx);

    expect(prompt).toContain("fast-service");
    expect(prompt).toContain("src/handler.ts");
    expect(prompt).toContain("src/util.ts");
    expect(prompt).toContain("latency_p95");
    expect(prompt).toContain("loop unrolling");
    expect(prompt).toContain("[REVERTED]");
  });

  it("omits block 6 when negative memory is empty or null", () => {
    const promptNoMem = PromptBuilder.build({
      ...baseInput,
      negativeMemory: [],
    });

    expect(promptNoMem).not.toContain("### Block 6: Previously Failed Strategies (Negative Memory)");
    expect(promptNoMem).toContain("### Block 5: Last Iteration Feedback");
    expect(promptNoMem).toContain("### Block 7: Output Contract (JSON Only)");

    const promptNullMem = PromptBuilder.build({
      ...baseInput,
      negativeMemory: null,
    });
    expect(promptNullMem).not.toContain("### Block 6: Previously Failed Strategies (Negative Memory)");
  });

  it("omits or adjusts block 5 when there is no last feedback (e.g. initial step)", () => {
    const prompt = PromptBuilder.build({
      ...baseInput,
      lastFeedback: undefined,
      negativeMemory: [],
    });
    expect(prompt).toContain("### Block 5: Last Iteration Feedback");
    expect(prompt).toContain("Initial step: no previous iterations evaluated yet.");
  });

  it("truncates target files when byte budget is exceeded, prioritizing most recently modified files and naming what was dropped", () => {
    const largeFile1 = "A".repeat(500);
    const largeFile2 = "B".repeat(500);
    const largeFile3 = "C".repeat(500);

    const input: PromptBuilderInput = {
      ...baseInput,
      byteBudget: 900, // Budget less than 1500 bytes
      targetFiles: [
        { path: "src/old.ts", content: largeFile1, mtimeMs: 100 },
        { path: "src/recent.ts", content: largeFile2, mtimeMs: 300 },
        { path: "src/middle.ts", content: largeFile3, mtimeMs: 200 },
      ],
    };

    const prompt = PromptBuilder.build(input);

    expect(prompt).toContain(TRUNCATION_MARKER);
    expect(prompt).toContain("src/old.ts");
    // Most recent should be included fully
    expect(prompt).toContain("src/recent.ts");
    // Truncation notice explicitly lists what was dropped or truncated
    expect(prompt).toMatch(/Truncated \/ omitted files:.*src\/old\.ts/);
  });
});

describe("createDriver factory", () => {
  it("throws UnknownDriverError for unknown driver names", () => {
    expect(() => createDriver("unknown-driver" as any)).toThrowError(UnknownDriverError);
  });
});
