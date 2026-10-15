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
}

export class AstLinterEngine {
  private rules: AstRule[] = [];

  constructor(rules: AstRule[] = []) {
    this.rules = rules;
  }

  public addRule(rule: AstRule): void {
    this.rules.push(rule);
  }

  /**
   * Scans target files for anti-patterns using structural pattern matching.
   * In full implementation, bridges directly to the ast-grep / tree-sitter binary.
   */
  public async scanFiles(files: string[]): Promise<LintViolation[]> {
    // Stub implementation for scaffold — will execute ast-grep scan via CLI / bindings
    return [];
  }
}
