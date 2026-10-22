import type { NegativeMemoryEntry } from "../memory/index.js";
import { formatNegativeMemoryEntry } from "../memory/render.js";
import type { TargetFileContent } from "./driver.js";

export const DEFAULT_PROMPT_BYTE_BUDGET = 60 * 1024; // ~60 KB
export const TRUNCATION_MARKER = "[TRUNCATION NOTICE: File content budget exceeded]";

export interface PromptMetricContext {
  name: string;
  unit: string;
  goal: "minimize" | "maximize";
  baseline?: number;
  currentBest?: number;
}

export interface PromptTargetContext {
  name: string;
  language: string;
  files: readonly string[];
}

export interface PromptBuilderInput {
  target: PromptTargetContext;
  metric: PromptMetricContext;
  targetFiles: readonly TargetFileContent[];
  lastFeedback?: string;
  negativeMemory?: readonly NegativeMemoryEntry[] | null;
  byteBudget?: number;
}

export class PromptBuilder {
  /**
   * Assembles the 7 ordered prompt blocks into a single string.
   */
  public static build(input: PromptBuilderInput): string {
    const blocks: string[] = [];

    // Block 1: Role & Objective
    blocks.push(PromptBuilder.buildBlock1Role(input.target, input.metric));

    // Block 2: Hard Constraints
    blocks.push(PromptBuilder.buildBlock2Constraints(input.target));

    // Block 3: Metric Context
    blocks.push(PromptBuilder.buildBlock3Metric(input.metric));

    // Block 4: Target Source Files (with ~60KB budget & truncation)
    blocks.push(PromptBuilder.buildBlock4Files(input.targetFiles, input.byteBudget ?? DEFAULT_PROMPT_BYTE_BUDGET));

    // Block 5: Last Iteration Feedback
    blocks.push(PromptBuilder.buildBlock5Feedback(input.lastFeedback));

    // Block 6: Previously Failed Strategies (Negative Memory) - omitted if empty
    if (input.negativeMemory && input.negativeMemory.length > 0) {
      blocks.push(PromptBuilder.buildBlock6NegativeMemory(input.negativeMemory));
    }

    // Block 7: JSON Output Contract
    blocks.push(PromptBuilder.buildBlock7OutputContract());

    return blocks.join("\n\n---\n\n");
  }

  private static buildBlock1Role(target: PromptTargetContext, metric: PromptMetricContext): string {
    return [
      `### Block 1: Role & Objective`,
      `You are an expert autonomous performance optimization engineer.`,
      `Your goal is to optimize the target codebase '${target.name}' (${target.language}) to ${metric.goal} the metric '${metric.name}'.`,
      `All existing invariants, unit tests, and typing checks MUST remain green. No regressions in correctness are tolerated.`,
    ].join("\n");
  }

  private static buildBlock2Constraints(target: PromptTargetContext): string {
    const allowed = target.files.map((f) => `- ${f}`).join("\n");
    return [
      `### Block 2: Hard Constraints`,
      `1. Only modify files that match the declared target file list:`,
      allowed,
      `2. NEVER modify configuration files, package manifests, lockfiles, test fixtures, or invariants.`,
      `3. NEVER introduce suppression directives (@ts-ignore, @ts-nocheck, eslint-disable).`,
      `4. Only output valid JSON matching the exact schema specified in Block 7. No conversational markdown wrap around the JSON.`,
      `5. Supply FULL file content for every modified file. Partial diffs or snippets are rejected.`,
    ].join("\n");
  }

  private static buildBlock3Metric(metric: PromptMetricContext): string {
    const baselineStr = metric.baseline !== undefined ? `${metric.baseline} ${metric.unit}` : "N/A";
    const currentBestStr = metric.currentBest !== undefined ? `${metric.currentBest} ${metric.unit}` : baselineStr;
    return [
      `### Block 3: Metric Context`,
      `- Metric Name: ${metric.name}`,
      `- Unit: ${metric.unit}`,
      `- Optimization Goal: ${metric.goal.toUpperCase()} (lower is better: ${metric.goal === "minimize"})`,
      `- Baseline Score: ${baselineStr}`,
      `- Current Best Score: ${currentBestStr}`,
    ].join("\n");
  }

  private static buildBlock4Files(files: readonly TargetFileContent[], byteBudget: number): string {
    // Sort files by mtimeMs descending (most recently modified first) to prioritize recent edits
    const sorted = [...files].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0));

    let accumulatedBytes = 0;
    const includedFiles: Array<{ path: string; content: string }> = [];
    const droppedFiles: string[] = [];

    for (const file of sorted) {
      const fileBytes = Buffer.byteLength(file.content, "utf-8");
      if (accumulatedBytes + fileBytes <= byteBudget) {
        includedFiles.push(file);
        accumulatedBytes += fileBytes;
      } else {
        droppedFiles.push(file.path);
      }
    }

    const lines: string[] = [
      `### Block 4: Target Source Files`,
      `Below is the current source code of the target files in the sandbox workspace:`,
    ];

    if (droppedFiles.length > 0) {
      lines.push(`${TRUNCATION_MARKER}`);
      lines.push(`Truncated / omitted files: ${droppedFiles.join(", ")}`);
      lines.push(`Byte budget: ${byteBudget} bytes (used: ${accumulatedBytes} bytes). Prioritized by last modification time.`);
    }

    for (const file of includedFiles) {
      lines.push(`\nFile: \`${file.path}\`:\n\`\`\`\n${file.content}\n\`\`\``);
    }

    return lines.join("\n");
  }

  private static buildBlock5Feedback(lastFeedback?: string): string {
    const feedbackText = lastFeedback ? lastFeedback.trim() : "Initial step: no previous iterations evaluated yet.";
    return [
      `### Block 5: Last Iteration Feedback`,
      feedbackText,
    ].join("\n");
  }

  private static buildBlock6NegativeMemory(entries: readonly NegativeMemoryEntry[]): string {
    // Top-5 failed strategies
    const topEntries = entries.slice(0, 5);
    const rendered = topEntries.map((e, idx) => {
      return `${idx + 1}. ${formatNegativeMemoryEntry(e)}`;
    }).join("\n");

    return [
      `### Block 6: Previously Failed Strategies (Negative Memory)`,
      `The following strategies were already attempted and failed or caused regressions. DO NOT repeat these approaches:`,
      rendered,
    ].join("\n");
  }

  private static buildBlock7OutputContract(): string {
    return [
      `### Block 7: Output Contract (JSON Only)`,
      `Respond with a single JSON object conforming to the following structure:`,
      `{`,
      `  "mutations": [`,
      `    {`,
      `      "path": "relative/path/to/target/file.ts",`,
      `      "content": "... FULL NEW FILE CONTENT ...",`,
      `      "rationale": "Explanation of the optimization technique applied"`,
      `    }`,
      `  ]`,
      `}`,
      `Note: If no further performance improvements can be found, return \`{"mutations": []}\` to signal completion.`,
    ].join("\n");
  }
}
