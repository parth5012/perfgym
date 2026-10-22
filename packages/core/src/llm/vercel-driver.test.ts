import { describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { VercelAiSdkDriver } from "./vercel-driver.js";
import { LlmFatalError, MissingApiKeyError } from "../errors.js";

function createMockModel(handler: (options: any) => Promise<any>): any {
  return new MockLanguageModelV4({
    doGenerate: vi.fn().mockImplementation(handler),
  });
}

describe("VercelAiSdkDriver", () => {
  it("throws MissingApiKeyError at construction when API key is missing", () => {
    const originalEnv = { ...process.env };
    delete process.env.OPENAI_API_KEY;
    delete process.env.PERFGYM_API_KEY;

    try {
      expect(() => new VercelAiSdkDriver({ provider: "openai" })).toThrowError(MissingApiKeyError);
    } finally {
      process.env = originalEnv;
    }
  });

  it("accumulates tokens across calls and returns null cost for unknown models", async () => {
    const mockModel = createMockModel(async () => ({
      rawCall: {},
      finishReason: "stop",
      usage: { inputTokens: { total: 100 }, outputTokens: { total: 50 } },
      warnings: [],
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mutations: [
              {
                path: "src/calc.ts",
                content: "export const x = 1;",
                rationale: "const fold",
              },
            ],
          }),
        },
      ],
    }));

    const driver = new VercelAiSdkDriver(
      { provider: "openai", model: "non-existent-custom-model" },
      mockModel
    );

    const res = await driver.complete({ prompt: "optimize" });
    expect(res.mutations).toHaveLength(1);
    expect(res.usage?.totalTokens).toBe(150);
    expect(res.estimatedCostUsd).toBeNull(); // Unknown model -> cost is null, never 0

    const res2 = await driver.complete({ prompt: "optimize again" });
    const cumulative = driver.getUsageTracker().getCumulativeUsage();
    expect(cumulative.totalTokens).toBe(300);
    expect(driver.getUsageTracker().getCumulativeCostUsd()).toBeNull();
  });

  it("computes cost correctly for bundled models", async () => {
    const mockModel = createMockModel(async () => ({
      rawCall: {},
      finishReason: "stop",
      usage: { inputTokens: { total: 1_000_000 }, outputTokens: { total: 1_000_000 } },
      warnings: [],
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mutations: [],
          }),
        },
      ],
    }));

    // openai:gpt-4o-mini is 0.15 prompt + 0.6 completion = 0.75 USD
    const driver = new VercelAiSdkDriver(
      { provider: "openai", model: "gpt-4o-mini" },
      mockModel
    );

    const res = await driver.complete({ prompt: "optimize" });
    expect(res.estimatedCostUsd).toBeCloseTo(0.75, 4);
    expect(driver.getUsageTracker().getCumulativeCostUsd()).toBeCloseTo(0.75, 4);
  });

  it("retries 429 transient errors with backoff and skips iteration when exhausted", async () => {
    let callCount = 0;
    const mockModel = createMockModel(async () => {
      callCount++;
      const err: any = new Error("Rate limit exceeded");
      err.status = 429;
      throw err;
    });

    const driver = new VercelAiSdkDriver({ provider: "openai" }, mockModel);

    // Speed up backoff delays for test
    vi.useFakeTimers();
    const completePromise = driver.complete({ prompt: "optimize" });

    // Advance through the backoff timers: 1s, 4s, 16s
    await vi.runAllTimersAsync();
    const result = await completePromise;
    vi.useRealTimers();

    expect(callCount).toBe(4); // Initial attempt + 3 retries
    expect(result.skipped).toBe(true);
    expect(result.mutations).toHaveLength(0);
    expect(result.error).toContain("transient error");
  });

  it("aborts fatally on 401 unauthorized errors", async () => {
    const mockModel = createMockModel(async () => {
      const err: any = new Error("Incorrect API key provided");
      err.status = 401;
      throw err;
    });

    const driver = new VercelAiSdkDriver({ provider: "openai" }, mockModel);

    await expect(driver.complete({ prompt: "optimize" })).rejects.toThrowError(LlmFatalError);
  });

  it("retries schema parse failure once and then skips iteration if still invalid", async () => {
    let callCount = 0;
    const mockModel = createMockModel(async () => {
      callCount++;
      return {
        rawCall: {},
        finishReason: "stop",
        usage: { inputTokens: { total: 10 }, outputTokens: { total: 10 } },
        warnings: [],
        content: [
          {
            type: "text",
            text: "NOT JSON AT ALL",
          },
        ],
      };
    });

    const driver = new VercelAiSdkDriver({ provider: "openai" }, mockModel);

    const result = await driver.complete({ prompt: "optimize" });
    expect(callCount).toBe(2); // Initial attempt + 1 retry with error feedback
    expect(result.skipped).toBe(true);
    expect(result.mutations).toHaveLength(0);
    expect(result.error).toContain("Schema validation failed");
  });

  it("fires per-request timeout and marks iteration as skipped", async () => {
    const mockModel = createMockModel(async ({ abortSignal }) => {
      return new Promise((resolve, reject) => {
        abortSignal?.addEventListener("abort", () => {
          const err: any = new Error("LLM_TIMEOUT");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const driver = new VercelAiSdkDriver({ provider: "openai" }, mockModel);

    vi.useFakeTimers();
    const completePromise = driver.complete({ prompt: "optimize", timeoutMs: 500 });
    await vi.advanceTimersByTimeAsync(600);
    const result = await completePromise;
    vi.useRealTimers();

    expect(result.skipped).toBe(true);
    expect(result.error).toContain("timed out");
  });
});
