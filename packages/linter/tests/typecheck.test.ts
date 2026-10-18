import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { TypecheckGate } from "../src/typecheck.js";

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

describe("TypecheckGate", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perfgym-tc-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  });

  it("detects tampering when protected file hash changes", () => {
    fs.writeFileSync(path.join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "x" }));
    const gate = new TypecheckGate();
    gate.initBaseline(tmp);

    const baseline = gate.getBaselineHashes();
    const current: Record<string, string> = { ...baseline };
    // mutate tsconfig hash
    current["tsconfig.json"] = "deadbeef";

    const res = gate.checkConfigIntegrity(current);
    expect(res.ok).toBe(false);
    expect(res.tampered).toContain("tsconfig.json");
    expect(res.disqualified).toBe(true);
    expect(gate.disqualified).toBe(true);
  });

  it("passes when hashes unchanged", () => {
    fs.writeFileSync(path.join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
    const gate = new TypecheckGate(tmp);
    const res = gate.checkConfigIntegrity();
    expect(res.ok).toBe(true);
    expect(res.tampered).toEqual([]);
  });

  it("flags disqualified when strict is disabled", () => {
    fs.writeFileSync(path.join(tmp, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: false } }));
    const gate = new TypecheckGate();
    gate.initBaseline(tmp);
    // even if hash matches (recompute baseline after writing? baseline captured strict:false; simulate detection via content)
    // Force check by reading current file content through checkConfigIntegrity with content
    const res = gate.checkConfigIntegrity([
      { path: "tsconfig.json", content: JSON.stringify({ compilerOptions: { strict: false } }) },
    ]);
    expect(res.tampered).toContain("tsconfig.json");
    expect(res.disqualified).toBe(true);
  });

  it("tier1 detects @ts-ignore", () => {
    const gate = new TypecheckGate();
    const res = gate.tier1Scan("const x: any = 1; // @ts-ignore\n");
    expect(res.passed).toBe(false);
    expect(res.violations.some((v) => v.ruleId === "no-ts-ignore")).toBe(true);
  });

  it("tier1 detects @ts-nocheck", () => {
    const gate = new TypecheckGate();
    const res = gate.tier1Scan("// @ts-nocheck\nconst x = 1;");
    expect(res.passed).toBe(false);
    expect(res.violations.some((v) => v.ruleId === "no-ts-nocheck")).toBe(true);
  });

  it("tier1 detects as any", () => {
    const gate = new TypecheckGate();
    const res = gate.tier1Scan("const x = foo as any;");
    expect(res.passed).toBe(false);
    expect(res.violations.some((v) => v.ruleId === "no-any-cast")).toBe(true);
  });

  it("tier1 passes clean code", () => {
    const gate = new TypecheckGate();
    const res = gate.tier1Scan("const x: number = 1;");
    expect(res.passed).toBe(true);
    expect(res.violations).toEqual([]);
  });

  it("tier1 scans array of files with paths", () => {
    const gate = new TypecheckGate();
    const res = gate.tier1Scan([
      { path: "a.ts", content: "const x = 1;" },
      { path: "b.ts", content: "const y = z as any;" },
    ]);
    expect(res.passed).toBe(false);
    expect(res.violations[0].file).toBe("b.ts");
  });

  it("tier2 passes valid project", { timeout: 60000 }, () => {
    const proj = path.join(tmp, "proj");
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
    fs.writeFileSync(path.join(proj, "index.ts"), "export const x: number = 1;\n");
    const gate = new TypecheckGate();
    const res = gate.tier2Run(proj);
    expect(res.passed).toBe(true);
  });

  it("tier2 fails invalid project", { timeout: 60000 }, () => {
    const proj = path.join(tmp, "proj2");
    fs.mkdirSync(proj);
    fs.writeFileSync(path.join(proj, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }));
    fs.writeFileSync(path.join(proj, "index.ts"), "export const x: number = 'bad';\n");
    const gate = new TypecheckGate();
    const res = gate.tier2Run(proj);
    expect(res.passed).toBe(false);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});
