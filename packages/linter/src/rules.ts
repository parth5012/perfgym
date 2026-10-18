/**
 * @perfgym/linter
 * Declarative YAML rule parser & penalty calculator for AST anti-pattern rules.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AstRule } from "./index.js";
import type { LintViolation } from "@perfgym/core";

export const RuleSchema = z.object({
  id: z.string().min(1),
  message: z.string(),
  severity: z.enum(["error", "warning"]),
  penalty: z.number().min(0),
  action: z.enum(["disqualify", "penalize"]).optional(),
  pattern: z.string().min(1),
  language: z.string().optional(),
});

export type ParsedRule = z.infer<typeof RuleSchema>;

export function validateRule(rule: unknown): AstRule {
  const parsed = RuleSchema.parse(rule);
  return parsed as AstRule;
}

function extractRulesArray(input: unknown): unknown[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (Array.isArray(obj.rules)) return obj.rules;
    if (Array.isArray(obj.default)) return obj.default;
  }
  throw new Error("Invalid rules input: expected an array or an object with a 'rules' array");
}

export function parseRules(yamlOrObj: unknown): AstRule[] {
  let raw: unknown = yamlOrObj;
  if (typeof yamlOrObj === "string") {
    raw = parseYaml(yamlOrObj);
  }
  const arr = extractRulesArray(raw);
  return arr.map((r) => validateRule(r));
}

export function loadRulesFromYaml(yamlString: string): AstRule[] {
  return parseRules(yamlString);
}

const FALLBACK_DEFAULT_RULES: AstRule[] = [
  {
    id: "no-ts-ignore",
    message: "TypeScript suppression comment detected (@ts-ignore); compiler sabotage is not allowed",
    severity: "error",
    penalty: 0,
    action: "disqualify",
    pattern: "// @ts-ignore",
  },
  {
    id: "no-ts-nocheck",
    message: "TypeScript suppression comment detected (@ts-nocheck); compiler sabotage is not allowed",
    severity: "error",
    penalty: 0,
    action: "disqualify",
    pattern: "// @ts-nocheck",
  },
  {
    id: "no-any-cast",
    message: "Explicit `any` cast detected; type weakening is not allowed",
    severity: "error",
    penalty: 0,
    action: "disqualify",
    pattern: "as any",
  },
  {
    id: "no-dynamic-eval",
    message: "Dynamic eval and code generation forbidden",
    severity: "error",
    penalty: 0,
    action: "disqualify",
    pattern: "eval($$$)",
  },
  {
    id: "no-function-constructor",
    message: "Function constructor (code generation) forbidden",
    severity: "error",
    penalty: 0,
    action: "disqualify",
    pattern: "new Function($$$)",
  },
  {
    id: "no-await-in-loops",
    message: "Avoid serial awaits inside loops; use Promise.all or chunking",
    severity: "error",
    penalty: 50,
    action: "penalize",
    pattern: "for ($VAR of $ARR) { $$$BEFORE; await $FUNC($$$ARGS); $$$AFTER; }",
  },
  {
    id: "no-unindexed-filter",
    message: "Found in-memory array filtering on database collections",
    severity: "warning",
    penalty: 30,
    action: "penalize",
    pattern: "$COLL.find().filter($FN)",
  },
  {
    id: "no-sync-methods",
    message: "Synchronous I/O in event loop (e.g. readFileSync) blocks the event loop",
    severity: "error",
    penalty: 80,
    action: "penalize",
    pattern: "$MOD.readFileSync($$$)",
  },
];

export function loadDefaultRules(): AstRule[] {
  try {
    const url = new URL("./defaults/rules.yaml", import.meta.url);
    const filePath = fileURLToPath(url);
    const content = readFileSync(filePath, "utf8");
    return parseRules(content);
  } catch {
    return FALLBACK_DEFAULT_RULES.map((r) => ({ ...r }));
  }
}

export const DEFAULT_PRESET = "perfgym:typescript-perf";
export const DEFAULT_RULES: AstRule[] = loadDefaultRules();

export function hasDisqualifier(violations: readonly (LintViolation | AstRule | any)[] = []): boolean {
  return (violations ?? []).some((v) => v?.action === "disqualify");
}

export function isDisqualified(violations: readonly any[] = []): boolean {
  return hasDisqualifier(violations);
}

export function calculatePenalty(violations: readonly any[] = []): number {
  return (violations ?? []).reduce((acc, v) => {
    const p = typeof v?.penalty === "number" ? v.penalty : 0;
    return acc + p;
  }, 0);
}

export const totalPenalty = calculatePenalty;

export function aggregatePenalties(violations: readonly any[] = []): { total: number; disqualified: boolean } {
  return {
    total: calculatePenalty(violations),
    disqualified: hasDisqualifier(violations),
  };
}

// convenience re-export of z for schema consumers
export { z };