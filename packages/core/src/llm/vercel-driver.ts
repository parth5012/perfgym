import { generateObject, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { LlmFatalError, MissingApiKeyError } from "../errors.js";
import type { DriverOptions, LlmDriver, LlmRequest, LlmResult } from "./driver.js";
import { MutationSchema } from "./schema.js";
import { UsageTracker } from "./usage.js";

export const DEFAULT_TIMEOUT_MS = 120_000; // 120s
export const BACKOFF_DELAYS_MS = [1_000, 4_000, 16_000];

export class VercelAiSdkDriver implements LlmDriver {
  public readonly name = "api";
  private readonly providerName: string;
  private readonly modelName: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly usageTracker: UsageTracker;
  private modelInstance?: any;

  constructor(options: DriverOptions = {}, injectedModel?: any) {
    this.providerName = (options.provider || "openai").toLowerCase();
    this.modelName =
      options.model ||
      (this.providerName === "anthropic"
        ? "claude-3-5-sonnet-20241022"
        : this.providerName === "google"
          ? "gemini-1.5-flash"
          : "gpt-4o-mini");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.usageTracker = new UsageTracker(options.pricing);

    if (injectedModel) {
      this.modelInstance = injectedModel;
      this.apiKey = "injected-mock-key";
      return;
    }

    // Resolve API key
    const resolvedKey = this.resolveApiKey(options);
    if (!resolvedKey.key) {
      throw new MissingApiKeyError({
        provider: this.providerName,
        envVar: resolvedKey.envVar,
        message: `Missing API key for LLM provider '${this.providerName}'. Please set environment variable ${resolvedKey.envVar} or PERFGYM_API_KEY.`,
      });
    }
    this.apiKey = resolvedKey.key;
    this.modelInstance = this.initModel(options.baseUrl);
  }

  private resolveApiKey(options: DriverOptions): { key?: string; envVar: string } {
    if (options.apiKey) return { key: options.apiKey, envVar: "options.apiKey" };
    if (process.env.PERFGYM_API_KEY) return { key: process.env.PERFGYM_API_KEY, envVar: "PERFGYM_API_KEY" };

    switch (this.providerName) {
      case "openai":
        return { key: process.env.OPENAI_API_KEY, envVar: "OPENAI_API_KEY" };
      case "anthropic":
        return { key: process.env.ANTHROPIC_API_KEY, envVar: "ANTHROPIC_API_KEY" };
      case "google":
        return { key: process.env.GOOGLE_GENERATIVE_AI_API_KEY, envVar: "GOOGLE_GENERATIVE_AI_API_KEY" };
      default:
        return { key: process.env[`${this.providerName.toUpperCase()}_API_KEY`], envVar: `${this.providerName.toUpperCase()}_API_KEY` };
    }
  }

  private initModel(baseUrl?: string, modelOverride?: string): LanguageModel {
    const targetModel = modelOverride || this.modelName;
    switch (this.providerName) {
      case "openai": {
        const client = createOpenAI({ apiKey: this.apiKey, baseURL: baseUrl });
        return client(targetModel);
      }
      case "anthropic": {
        const client = createAnthropic({ apiKey: this.apiKey, baseURL: baseUrl });
        return client(targetModel);
      }
      case "google": {
        const client = createGoogleGenerativeAI({ apiKey: this.apiKey, baseURL: baseUrl });
        return client(targetModel);
      }
      default:
        throw new LlmFatalError({
          provider: this.providerName,
          reason: "unsupported-provider",
          message: `Unsupported Vercel AI SDK provider: '${this.providerName}'. Supported providers: openai, anthropic, google`,
        });
    }
  }

  public getUsageTracker(): UsageTracker {
    return this.usageTracker;
  }

  public async complete(request: LlmRequest): Promise<LlmResult> {
    const timeout = request.timeoutMs ?? this.timeoutMs;
    const modelToUse = request.model ? this.initModel(undefined, request.model) : this.modelInstance!;
    const modelName = request.model || this.modelName;
    return this.executeWithRetry(request.prompt, timeout, 0, modelToUse, modelName);
  }

  private async executeWithRetry(
    prompt: string,
    timeoutMs: number,
    retryCount: number,
    modelToUse: any,
    modelName: string,
    parseErrorFeedback?: string
  ): Promise<LlmResult> {
    const effectivePrompt = parseErrorFeedback
      ? `${prompt}\n\n[NOTICE: Your previous response failed schema validation with error: ${parseErrorFeedback}. Fix the errors and return strictly valid JSON conforming to the schema.]`
      : prompt;

    try {
      const abortController = new AbortController();
      const timer = setTimeout(() => abortController.abort(new Error("LLM_TIMEOUT")), timeoutMs);

      let res;
      try {
        res = await generateObject({
          model: modelToUse,
          schema: MutationSchema,
          prompt: effectivePrompt,
          abortSignal: abortController.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const promptTokens = (res.usage as any)?.promptTokens ?? (res.usage as any)?.inputTokens ?? 0;
      const completionTokens = (res.usage as any)?.completionTokens ?? (res.usage as any)?.outputTokens ?? 0;
      const totalTokens = res.usage?.totalTokens ?? (promptTokens + completionTokens);
      const usage = {
        promptTokens,
        completionTokens,
        totalTokens,
      };

      const { iterationCostUsd } = this.usageTracker.record(
        this.providerName,
        modelName,
        usage
      );

      return {
        mutations: res.object.mutations,
        usage,
        estimatedCostUsd: iterationCostUsd,
      };
    } catch (err: any) {
      // 1. Check for timeout
      if (err?.message === "LLM_TIMEOUT" || err?.name === "AbortError" || err?.cause?.message === "LLM_TIMEOUT") {
        return {
          mutations: [],
          error: `Request timed out after ${timeoutMs}ms`,
          skipped: true,
        };
      }

      // 2. Check for schema parse failure (retry once)
      const isParseError =
        err?.name === "AI_TypeValidationError" ||
        err?.name === "TypeValidationError" ||
        err?.name === "AI_NoObjectGeneratedError" ||
        err?.name === "NoObjectGeneratedError" ||
        err?.name === "AI_JSONParseError" ||
        err?.name === "JSONParseError" ||
        err?.name === "ZodError" ||
        /validation|schema|json parse|no object generated/i.test(err?.message ?? "");

      if (isParseError && !parseErrorFeedback) {
        // Retry once with validation feedback
        return this.executeWithRetry(prompt, timeoutMs, retryCount, modelToUse, modelName, err.message || "Invalid schema");
      }
      if (isParseError && parseErrorFeedback) {
        // Failed retry -> skip iteration
        return {
          mutations: [],
          error: `Schema validation failed after retry: ${err.message}`,
          skipped: true,
        };
      }

      // 3. Classify fatal errors vs transient
      const statusCode = err?.status ?? err?.statusCode ?? err?.response?.status;
      const isAuthError = statusCode === 401 || statusCode === 403 || /unauthorized|auth|forbidden|api key/i.test(err?.message ?? "");
      const isBadRequest = statusCode === 400 || /invalid model|unknown model|bad request/i.test(err?.message ?? "");

      if (isAuthError || isBadRequest) {
        throw new LlmFatalError({
          provider: this.providerName,
          reason: isAuthError ? "auth-failure" : "bad-request",
          message: `Fatal error calling provider '${this.providerName}' (status ${statusCode ?? "unknown"}): ${err.message}. Check credentials and model parameters.`,
        });
      }

      // 4. Transient failures (429, 5xx, network error) -> backoff up to 3 attempts
      const isTransient =
        statusCode === 429 ||
        (statusCode >= 500 && statusCode < 600) ||
        /rate limit|overloaded|fetch failed|econnreset|etimedout|network/i.test(err?.message ?? "");

      if (isTransient && retryCount < BACKOFF_DELAYS_MS.length) {
        const delay = BACKOFF_DELAYS_MS[retryCount];
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.executeWithRetry(prompt, timeoutMs, retryCount + 1, modelToUse, modelName, parseErrorFeedback);
      }

      // Max retries reached or unclassified transient error -> skip iteration
      return {
        mutations: [],
        error: `LLM call failed (transient error / retries exhausted): ${err?.message ?? String(err)}`,
        skipped: true,
      };
    }
  }
}
