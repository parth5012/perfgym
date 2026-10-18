import { describe, expect, it } from "vitest";
import {
  DEFAULT_RULES,
  RuleSchema,
  parseRules,
  validateRule,
  loadDefaultRules,
  loadRulesFromYaml,
  calculatePenalty,
  totalPenalty,
  hasDisqualifier,
  aggregatePenalties,
} from "../src/index.js";

describe("rules", () => {
  it("loads default rules", () => {
    const rules = loadDefaultRules();
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.some((r) => r.id === "no-await-in-loops")).toBe(true);
  });

  it("DEFAULT_RULES matches approved matrix", () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    expect(ids).toContain("no-await-in-loops");
    expect(ids).toContain("no-dynamic-eval");
    expect(ids).toContain("no-sync-methods");
    expect(ids).toContain("no-unindexed-filter");
    const awaitRule = DEFAULT_RULES.find((r) => r.id === "no-await-in-loops")!;
    expect(awaitRule.penalty).toBe(50);
    const filterRule = DEFAULT_RULES.find((r) => r.id === "no-unindexed-filter")!;
    expect(filterRule.penalty).toBe(30);
    const syncRule = DEFAULT_RULES.find((r) => r.id === "no-sync-methods")!;
    expect(syncRule.penalty).toBe(80);
  });

  it("parses valid yaml", () => {
    const yaml = `
rules:
  - id: r1
    message: msg
    severity: error
    penalty: 10
    action: penalize
    pattern: "foo"
`;
    const rules = parseRules(yaml);
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("r1");
  });

  it("parses object with rules", () => {
    const rules = parseRules({ rules: [{ id: "r2", message: "m", severity: "warning", penalty: 5, pattern: "p" }] });
    expect(rules[0].id).toBe("r2");
  });

  it("rejects negative penalty", () => {
    expect(() => validateRule({ id: "x", message: "m", severity: "error", penalty: -1, pattern: "p" })).toThrow();
  });

  it("rejects invalid action", () => {
    expect(() => validateRule({ id: "x", message: "m", severity: "error", penalty: 1, action: "nope", pattern: "p" })).toThrow();
  });

  it("loadRulesFromYaml works", () => {
    const rules = loadRulesFromYaml("rules:\n  - id: a\n    message: m\n    severity: error\n    penalty: 0\n    action: disqualify\n    pattern: p\n");
    expect(rules[0].action).toBe("disqualify");
  });

  it("disqualification flagging", () => {
    const violations = [{ ruleId: "x", action: "disqualify", penalty: 0 }] as any;
    expect(hasDisqualifier(violations)).toBe(true);
  });

  it("penalty aggregation", () => {
    const violations = [{ penalty: 10 }, { penalty: 20 }] as any;
    expect(calculatePenalty(violations)).toBe(30);
    expect(totalPenalty(violations)).toBe(30);
    expect(aggregatePenalties(violations)).toEqual({ total: 30, disqualified: false });
  });

  it("RuleSchema validates", () => {
    expect(() => RuleSchema.parse({ id: "x", message: "m", severity: "error", penalty: -5, pattern: "p" })).toThrow();
  });
});