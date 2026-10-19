/**
 * @perfgym/linter
 * Deep module: AstLinterEngine.
 */

import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
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
  scanErrors: string[];
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
  private projectRoot: string | null;

  constructor(rules: AstRule[] = [], projectRoot?: string) {
    this.rules = [...rules];
    this.projectRoot = projectRoot ?? null;
    this.typecheck = new TypecheckGate();
    if (this.projectRoot) {
      this.typecheck.initBaseline(this.projectRoot);
    }
  }

  public addRule(rule: AstRule): void {
    this.rules.push(rule);
  }

  public async scan(files: string[]): Promise<ScanResult> {
    const violations: LintViolation[] = [];
    const typeErrors: string[] = [];
    const scanErrors: string[] = [];

    // Configuration integrity check (protected files).
    if (this.projectRoot) {
      const integrity = this.typecheck.checkConfigIntegrity();
      if (!integrity.ok) {
        for (const t of integrity.tampered) {
          typeErrors.push(`Config tampering detected: ${t}`);
        }
      }
    }

    for (const file of files) {
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch {
        typeErrors.push(`Unable to read file: ${file}`);
        continue;
      }

      // Tier 1 fast typecheck scan.
      const tier1 = this.typecheck.tier1Scan([{ path: file, content }]);
      for (const v of tier1.violations) {
        violations.push(v);
        typeErrors.push(`${file}:${v.line} ${v.message}`);
      }

      const language = languageForFile(file);

      for (const rule of this.rules) {
        const lang = rule.language ?? language;
        const result = parseAndMatch(rule.pattern, content, lang);
        if (result.error) {
          scanErrors.push(`Rule "${rule.id}" failed on ${file}: ${result.error}`);
          continue;
        }
        for (const match of result.matches) {
          violations.push({
            ruleId: rule.id,
            message: rule.message,
            file,
            line: match.line + 1,
            severity: rule.severity,
            penalty: rule.penalty,
            action: rule.action,
          });
        }
      }
    }

    // Tier 2 full typecheck (only if project root available).
    if (this.projectRoot) {
      const tsconfig = join(this.projectRoot, "tsconfig.json");
      if (existsSync(tsconfig)) {
        const tier2 = this.typecheck.tier2Run(this.projectRoot);
        if (!tier2.passed) {
          for (const e of tier2.errors) {
            typeErrors.push(e);
          }
        }
      }
    }

    const penalty = totalPenalty(violations);
    const disqualified = hasDisqualifier(violations);
    const passed =
      !disqualified &&
      typeErrors.length === 0 &&
      scanErrors.length === 0;

    return {
      passed,
      violations,
      totalPenalty: penalty,
      typeErrors,
      scanErrors,
    };
  }
}