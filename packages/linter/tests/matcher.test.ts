import { describe, expect, it } from "vitest";
import { parseAndMatch } from "../src/matcher.js";

describe("parseAndMatch", () => {
  it("matches console.log calls with line/column offsets", () => {
    const src = "const a = 1;\nconsole.log(a);\nconst b = 2;\n";
    const res = parseAndMatch("console.log($X)", src, "typescript");
    expect(res.error).toBeUndefined();
    expect(res.matches).toHaveLength(1);
    const m = res.matches[0];
    expect(m.line).toBe(1);
    expect(m.column).toBe(0);
    expect(m.endLine).toBe(1);
    expect(m.text).toContain("console.log");
  });

  it("returns multiple matches", () => {
    const src = "foo();\nbar();\nfoo();\n";
    const res = parseAndMatch("foo()", src, "javascript");
    expect(res.matches).toHaveLength(2);
  });

  it("returns empty matches for no match", () => {
    const res = parseAndMatch("baz()", "const x = 1;", "ts");
    expect(res.matches).toEqual([]);
    expect(res.error).toBeUndefined();
  });

  it("reports error instead of crashing on invalid language", () => {
    const res = parseAndMatch("foo()", "const x = 1;", "not-a-lang");
    expect(Array.isArray(res.matches)).toBe(true);
    expect(res.error).toBeDefined();
  });

  it("reports error on invalid pattern gracefully", () => {
    const res = parseAndMatch("$$$", "const x = 1;", "typescript");
    expect(Array.isArray(res.matches)).toBe(true);
    expect(res.error).toBeDefined();
  });

  it("micro-benchmark under 15ms for 500-line file", () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`const v${i} = ${i};`);
    }
    // sprinkle a few matches
    lines[100] = "console.log(v100);";
    lines[400] = "console.log(v400);";
    const src = lines.join("\n");
    const start = performance.now();
    const res = parseAndMatch("console.log($X)", src, "typescript");
    const elapsed = performance.now() - start;
    expect(res.matches.length).toBe(2);
    expect(elapsed).toBeLessThan(15);
  });
});
