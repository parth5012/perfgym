import type { LlmUsage } from "./driver.js";

export interface ModelPricing {
  promptPerMillion: number;
  completionPerMillion: number;
}

/**
 * Bundled static pricing table in USD per 1M tokens.
 */
export const BUNDLED_PRICING: Record<string, ModelPricing> = {
  // OpenAI
  "openai:gpt-4o": { promptPerMillion: 2.5, completionPerMillion: 10.0 },
  "openai:gpt-4o-mini": { promptPerMillion: 0.15, completionPerMillion: 0.6 },
  "openai:o1": { promptPerMillion: 15.0, completionPerMillion: 60.0 },
  "openai:o1-mini": { promptPerMillion: 1.1, completionPerMillion: 4.4 },
  "openai:o3-mini": { promptPerMillion: 1.1, completionPerMillion: 4.4 },

  // Anthropic
  "anthropic:claude-3-5-sonnet-20241022": { promptPerMillion: 3.0, completionPerMillion: 15.0 },
  "anthropic:claude-3-5-haiku-20241022": { promptPerMillion: 0.8, completionPerMillion: 4.0 },
  "anthropic:claude-3-opus-20240229": { promptPerMillion: 15.0, completionPerMillion: 75.0 },

  // Google
  "google:gemini-1.5-pro": { promptPerMillion: 1.25, completionPerMillion: 5.0 },
  "google:gemini-1.5-flash": { promptPerMillion: 0.075, completionPerMillion: 0.3 },
  "google:gemini-2.0-flash": { promptPerMillion: 0.1, completionPerMillion: 0.4 },
};

export class UsageTracker {
  private accumulatedUsage: LlmUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  private accumulatedCost: number = 0;
  private hasUnknownCost: boolean = false;

  constructor(
    private readonly customPricing: Record<string, ModelPricing> = {}
  ) {}

  public record(
    provider: string,
    model: string,
    usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
  ): { iterationCostUsd: number | null } {
    const prompt = usage.promptTokens ?? 0;
    const completion = usage.completionTokens ?? 0;
    const total = usage.totalTokens ?? prompt + completion;

    this.accumulatedUsage.promptTokens += prompt;
    this.accumulatedUsage.completionTokens += completion;
    this.accumulatedUsage.totalTokens += total;

    const pricing = this.resolvePricing(provider, model);
    if (!pricing) {
      this.hasUnknownCost = true;
      return { iterationCostUsd: null };
    }

    const promptCost = (prompt / 1_000_000) * pricing.promptPerMillion;
    const completionCost = (completion / 1_000_000) * pricing.completionPerMillion;
    const iterationCost = promptCost + completionCost;

    this.accumulatedCost += iterationCost;
    return { iterationCostUsd: iterationCost };
  }

  public resolvePricing(provider: string, model: string): ModelPricing | null {
    const key1 = `${provider.toLowerCase()}:${model.toLowerCase()}`;
    const key2 = model.toLowerCase();

    // Check custom overrides first
    for (const [k, p] of Object.entries(this.customPricing)) {
      const kl = k.toLowerCase();
      if (kl === key1 || kl === key2) return p;
    }

    // Check bundled
    for (const [k, p] of Object.entries(BUNDLED_PRICING)) {
      const kl = k.toLowerCase();
      if (kl === key1 || kl === key2) return p;
    }

    return null;
  }

  public getCumulativeUsage(): LlmUsage {
    return { ...this.accumulatedUsage };
  }

  public getCumulativeCostUsd(): number | null {
    if (this.hasUnknownCost) return null;
    return this.accumulatedCost;
  }

  public reset(): void {
    this.accumulatedUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.accumulatedCost = 0;
    this.hasUnknownCost = false;
  }
}
