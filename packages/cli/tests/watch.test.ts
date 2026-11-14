import { describe, it, expect } from "vitest";
import { matchGlob } from "../src/commands/watch.js";

describe("watch matchGlob", () => {
  it("matches nested glob against root-prefixed path", () => {
    expect(matchGlob("api/checkout/foo.ts", "src/api/checkout/**/*.ts")).toBe(true);
    expect(matchGlob("src/api/checkout/foo.ts", "src/api/checkout/**/*.ts")).toBe(true);
  });
  it("matches star glob", () => {
    expect(matchGlob("a.ts", "src/**/*")).toBe(true);
  });
});