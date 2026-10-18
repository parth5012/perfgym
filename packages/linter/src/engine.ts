/**
 * @perfgym/linter
 * Deep module: AstLinterEngine.
 *
 * Presents a tiny interface (`scan(files)`) while hiding rule compilation,
 * Tree-Sitter AST parsing (matcher), severity mapping, penalty scoring, and
 * the fast typecheck gate behind it.
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { LintViolation } from "@perfgym/core";
import type { AstRule } from "./index.js";
import { parseAndMatch } from "./matcher.js";
import { totalPenalty, hasDisqualifier } from "./rules.js";
import { TypecheckGate } from "./typecheck.js";

export interface ScanResult {
  passed: boolean;
  violations: LintViolation[];
  totalPenalty: number;
  typeErrors: string[];
}

function languageForFile(file: string): string {
  const ext = extname(file).toLowerCase();
  switch (ext) {
    case ".ts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
      return "javascript";
    case ".jsx":
      return "jsx";
    default:
      return "typescript";
  }
}

export class AstLinterEngine {
  private rules: AstRule[];
  private typecheck: TypecheckGate;

  constructor(rules: AstRule[] = []) {
    this.rules = [...rules];
    this.typecheck = new TypecheckGate();
  }

  public addRule(rule: AstRule): void {
    this.rules.push(rule);
  }

  public get rulesCount(): number {
    return this.rules.length;
  }

  public async scan(files: string[]): Promise<ScanResult> {
    const violations: LintViolation[] = [];
    const typeErrors: string[] = [];

    // Fast typecheck gate (Tier 1) per file for suppression/any-cast/e eval.
    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        typeErrors.push(`Unable to read file: ${file}`);
        continue;
      }

      const tier1 = this.typecheck.tier1Scan([{ path: file, content }]);
      for (const v of tier1.violations) {
        typeErrors.push(`${file}:${v.line} ${v.message}`);
      }
      // Reset gate disqualified state between independent scans? Keep but don't block other files.
      this.typecheck.disqualified = false;

      const language = languageForFile(file);

      for (const rule of this.rules) {
        const lang = rule.language ?? language;
        const result = parseAndMatch(rule.pattern, content, lang);
        if (result.error) {
          // Skip unparseable rule but don't crash.
          continue;
        }
        for (const match of result.matches) {
          violations.push({
            ruleId: rule.id,
            message: rule.message,
            file,
            line: match.line + 1, // convert 0-based to 1-based
            severity: rule.severity,
            penalty: rule.penalty,
            action: rule.action,
          });
        }
      }
    }

    const penalty = totalPenalty(violations);
    const disqualified = hasDisqualifier(violations);
    const passed = !disqualified && typeErrors.length === 0;

    return {
      passed,
      violations,
      totalPenalty: penalty,
      typeErrors,
    };
  }
}