/**
 * Prototype (throwaway): Linter rule false-positive calibration.
 * Run: npx tsx scripts/demo-linter-rules.ts
 *
 * Runs AstLinterEngine across 10 sample code patterns (5 anti-patterns + 5
 * legitimate edge cases) and prints a side-by-side table of matches, line
 * numbers, and penalties. Human reviews whether legitimate patterns trigger
 * false positives and tweaks AST selectors in packages/linter/src/defaults/rules.yaml.
 */
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AstLinterEngine } from "../packages/linter/src/engine.js";
import { DEFAULT_RULES } from "../packages/linter/src/rules.js";

const TMP = join(process.cwd(), ".tmp", "demo-linter-rules");
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

interface Sample {
  name: string;
  kind: "anti-pattern" | "legitimate";
  code: string;
}

const samples: Sample[] = [
  // Anti-patterns
  {
    name: "serial-await-in-loop",
    kind: "anti-pattern",
    code: `async function f(arr: any[]) {\n  for (const x of arr) {\n    await doWork(x);\n  }\n}\n`,
  },
  {
    name: "unindexed-filter",
    kind: "anti-pattern",
    code: `const r = collection.find().filter((x) => x.active);\n`,
  },
  {
    name: "sync-read-file",
    kind: "anti-pattern",
    code: `import fs from "node:fs";\nexport function h() { return fs.readFileSync("a.txt", "utf8"); }\n`,
  },
  {
    name: "ts-ignore-suppression",
    kind: "anti-pattern",
    code: `// @ts-ignore\nconst x: any = 1;\n`,
  },
  {
    name: "dynamic-eval",
    kind: "anti-pattern",
    code: `export function run(s: string) { return eval(s); }\n`,
  },
  // Legitimate edge cases
  {
    name: "promise-all-in-loop-idiom",
    kind: "legitimate",
    code: `async function f(arr: any[]) {\n  await Promise.all(arr.map((x) => doWork(x)));\n}\n`,
  },
  {
    name: "sequential-queue-intentional",
    kind: "legitimate",
    code: `async function f(queue: any[]) {\n  for (const job of queue) {\n    await processOne(job);\n  }\n}\n`,
  },
  {
    name: "typed-filter-on-array",
    kind: "legitimate",
    code: `const r = items.filter((x) => x.active);\n`,
  },
  {
    name: "type-guard-narrowing",
    kind: "legitimate",
    code: `function isStr(v: unknown): v is string { return typeof v === "string"; }\n`,
  },
  {
    name: "legit-readFileSync-at-startup",
    kind: "legitimate",
    code: `import fs from "node:fs";\nconst cfg = fs.readFileSync("config.json", "utf8");\nexport default cfg;\n`,
  },
];

const engine = new AstLinterEngine(DEFAULT_RULES);

console.log("\n=== PerfGym Linter Rule Calibration (Prototype) ===\n");
console.log(
  "Sample".padEnd(32) +
    "Kind".padEnd(16) +
    "Matches".padEnd(40) +
    "Penalty".padEnd(10) +
    "FalsePositive?"
);
console.log("-".repeat(110));

const rows: any[] = [];
for (const s of samples) {
  const path = join(TMP, `${s.name}.ts`);
  writeFileSync(path, s.code, "utf8");
  const res = await engine.scan([path]);
  const ruleIds = res.violations.map((v) => v.ruleId).join(", ") || "(none)";
  const fp = s.kind === "legitimate" && res.violations.length > 0 ? "YES (FP)" : "no";
  rows.push({ name: s.name, kind: s.kind, ruleIds, penalty: res.totalPenalty, fp, lines: res.violations.map((v) => v.line).join(",") });
  console.log(
    s.name.padEnd(32) +
      s.kind.padEnd(16) +
      ruleIds.padEnd(40) +
      String(res.totalPenalty).padEnd(10) +
      fp
  );
  if (res.violations.length) {
    for (const v of res.violations) {
      console.log(`   -> ${v.ruleId} @ line ${v.line}: ${v.message}`);
    }
  }
}

// Summary
const fps = rows.filter((r) => r.fp.startsWith("YES"));
console.log("\n=== Summary ===");
console.log(`Total samples: ${rows.length}`);
console.log(`False positives on legitimate samples: ${fps.length}`);
if (fps.length) {
  console.log("False-positive samples:", fps.map((r) => r.name).join(", "));
}

// Write HTML report
const html = `<!doctype html><html><head><meta charset=utf-8><title>Linter Rule Calibration</title>
<style>body{font-family:system-ui;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:8px;text-align:left}tr.legit-fp{background:#fee}tr.anti{background:#efe}</style></head><body>
<h1>PerfGym Linter Rule Calibration (Prototype)</h1>
<table><thead><tr><th>Sample</th><th>Kind</th><th>Matches</th><th>Lines</th><th>Penalty</th><th>False Positive?</th></tr></thead><tbody>
${rows
  .map(
    (r) =>
      `<tr class="${r.kind === "legitimate" && r.fp.startsWith("YES") ? "legit-fp" : r.kind === "anti-pattern" ? "anti" : ""}"><td>${r.name}</td><td>${r.kind}</td><td>${r.ruleIds}</td><td>${r.lines || "-"}</td><td>${r.penalty}</td><td>${r.fp}</td></tr>`
  )
  .join("\n")}
</tbody></table>
<p>Red rows = false positives on legitimate code (need rule selector tweaks).</p>
</body></html>`;
writeFileSync(join(TMP, "report.html"), html, "utf8");
console.log(`\nHTML report: ${join(TMP, "report.html")}`);
console.log("Note: 'sequential-queue-intentional' is expected to be flagged by no-await-in-loops (it IS a serial await).");
console.log("Tweak selectors in packages/linter/src/defaults/rules.yaml if false positives appear.");
