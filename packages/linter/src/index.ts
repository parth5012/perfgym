/**
 * @perfgym/linter
 * AST Pattern Matching and Anti-Pattern Detection (ast-grep wrapper)
 */

import type { LintViolation } from "@perfgym/core";

export interface AstRule {
  id: string;
  message: string;
  severity: "error" | "warning";
  penalty: number;
  pattern: string;
  action?: "disqualify" | "penalize";
  language?: string;
}

export { AstLinterEngine } from "./engine.js";
export type { ScanResult } from "./engine.js";

export * from "./typecheck.js";
export * from "./rules.js";
export * from "./matcher.js";
