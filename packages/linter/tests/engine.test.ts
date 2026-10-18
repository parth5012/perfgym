import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AstLinterEngine } from "../src/engine.js";
import { DEFAULT_RULES } from "../src/rules.js";

const TMP = join(process.cwd(), ".tmp", "engine-test");

function setup(files: Record<string, string>): string[] {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  const paths: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const p = join(TMP, name);
    writeFileSync(p, content, "utf8");
    paths.push(p);
  }
  return paths;
}

describe("AstLinterEngine", () => {
  it("detects serial awaits in loops", async () => {
    const files = setup({
      "a.ts": "async function f(arr: any[]) {\n  for (const x of arr) {\n    await doWork(x);\n  }\n}\n",
    });
    const engine = new AstLinterEngine(DEFAULT_RULES);
    const res = await engine.scan(files);
    expect(res.violations.some((v) => v.ruleId === "no-await-in-loops" || v.ruleId === "no-await-in-loops-let")).toBe(true);
    expect(res.totalPenalty).toBeGreaterThan(0);
  });

  it("detects unindexed collection scans", async () => {
    const files = setup({
      "b.ts": "const r = collection.find().filter((x) => x.active);\n",
    });
    const engine = new AstLinterEngine(DEFAULT_RULES);
    const res = await engine.scan(files);
    expect(res.violations.some((v) => v.ruleId === "no-unindexed-filter")).toBe(true);
  });

  it("returns passed true for clean code", async () => {
    const files = setup({
      "c.ts": "export const x = 1;\n",
    });
    const engine = new AstLinterEngine(DEFAULT_RULES);
    const res = await engine.scan(files);
    expect(res.passed).toBe(true);
    expect(res.violations).toHaveLength(0);
    expect(res.totalPenalty).toBe(0);
  });

  it("flags type suppression as typeError", async () => {
    const files = setup({
      "d.ts": "// @ts-ignore\nconst x: any = 1;\n",
    });
    const engine = new AstLinterEngine(DEFAULT_RULES);
    const res = await engine.scan(files);
    expect(res.passed).toBe(false);
    expect(res.typeErrors.length).toBeGreaterThan(0);
  });

  it("scan interface returns required fields", async () => {
    const files = setup({ "e.ts": "const x = 1;\n" });
    const engine = new AstLinterEngine([]);
    const res = await engine.scan(files);
    expect(res).toHaveProperty("passed");
    expect(res).toHaveProperty("violations");
    expect(res).toHaveProperty("totalPenalty");
    expect(res).toHaveProperty("typeErrors");
  });
});
