import { describe, it, expect } from "vitest";
import { matchesGlob } from "@perfgym/core";

describe("watch glob matching", () => {
  it("matches nested glob", () => {
    expect(matchesGlob("src/api/checkout/**/*.ts", "src/api/checkout/foo.ts")).toBe(true);
  });
  it("matches brace glob", () => {
    expect(matchesGlob("src/*.{ts,tsx}", "src/a.ts")).toBe(true);
    expect(matchesGlob("src/*.{ts,tsx}", "src/b.tsx")).toBe(true);
    expect(matchesGlob("src/*.{ts,tsx}", "src/c.js")).toBe(false);
  });
});