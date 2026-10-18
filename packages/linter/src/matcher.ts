/**
 * @perfgym/linter
 * Direct in-process AST pattern matching via @ast-grep/napi bindings.
 */

import { parse, Lang } from "@ast-grep/napi";
import type { SgNode, SgRoot } from "@ast-grep/napi";

export type MatcherLanguage =
  | "ts"
  | "typescript"
  | "js"
  | "javascript"
  | "tsx"
  | "jsx"
  | "html"
  | "css"
  | string;

export interface AstMatch {
  /** 0-based line number of the match start (ast-grep convention). */
  line: number;
  /** 0-based column offset of the match start. */
  column: number;
  /** 0-based line number of the match end. */
  endLine: number;
  /** 0-based column offset of the match end. */
  endColumn: number;
  /** Matched source text. */
  text: string;
  /** Underlying ast-grep node. */
  node: SgNode;
}

export interface ParseAndMatchResult {
  matches: AstMatch[];
  error?: string;
}

function toLang(language: string): string {
  const normalized = language.trim().toLowerCase();
  switch (normalized) {
    case "ts":
    case "typescript":
      return Lang.TypeScript;
    case "js":
    case "javascript":
      return Lang.JavaScript;
    case "tsx":
    case "jsx":
      return Lang.Tsx;
    case "html":
      return Lang.Html;
    case "css":
      return Lang.Css;
    default:
      // Allow callers to pass through a raw Lang value or custom language.
      return language;
  }
}

/**
 * Parse `sourceCode` in memory and return all nodes matching `pattern`.
 *
 * Returns a result object so callers can distinguish "no matches" from
 * "parse/scan failure" without catching exceptions.
 */
export function parseAndMatch(
  pattern: string,
  sourceCode: string,
  language: MatcherLanguage
): ParseAndMatchResult {
  try {
    const lang = toLang(language);
    const root: SgRoot = parse(lang as never, sourceCode);
    const sgRoot = root.root();
    const nodes = sgRoot.findAll(pattern);
    const matches: AstMatch[] = nodes.map((node) => {
      const range = node.range();
      return {
        line: range.start.line,
        column: range.start.column,
        endLine: range.end.line,
        endColumn: range.end.column,
        text: node.text(),
        node,
      };
    });
    return { matches };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { matches: [], error: message };
  }
}

export { Lang };
