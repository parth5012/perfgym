import type { MutationPayload } from "./schema.js";

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmResult {
  mutations: MutationPayload["mutations"];
  rawText?: string;
  usage?: LlmUsage;
  estimatedCostUsd?: number | null;
  error?: string;
  skipped?: boolean;
}

export interface TargetFileContent {
  path: string;
  content: string;
  mtimeMs?: number;
}

export interface LlmRequest {
  prompt: string;
  model?: string;
  targetFiles?: readonly TargetFileContent[];
  timeoutMs?: number;
}

export interface DriverOptions {
  provider?: string;
  model?: string;
  apiKey?: string;
  timeoutMs?: number;
  baseUrl?: string;
  pricing?: Record<string, { promptPerMillion: number; completionPerMillion: number }>;
  cliCommand?: string;
  cliArgs?: string[];
}

export interface LlmDriver {
  readonly name: string;
  complete(request: LlmRequest): Promise<LlmResult>;
}
