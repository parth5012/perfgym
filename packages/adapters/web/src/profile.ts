import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetricResult } from "@perfgym/core";

export interface WebMetricCommand {
  name: string;
  command: string;
  goal: "minimize" | "maximize";
  weight: number;
  unit: MetricResult["unit"];
}

export interface WebPlatformProfile {
  name: string;
  targetGlobs: string[];
  defaultInvariantCommand: string;
  defaultMetricCommands: WebMetricCommand[];
  rulePresets: string[];
}

const DEFAULT_INVARIANT = "npm test";
const DEFAULT_GLOBS = ["src/**/*.{ts,tsx,js,jsx}", "app/**/*.{ts,tsx,js,jsx}"];

export function detectWebProfile(root: string): WebPlatformProfile {
  let pkg: any = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    pkg = {};
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const scripts = pkg.scripts ?? {};
  const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
  const hasFile = (p: string) => existsSync(join(root, p));

  const isNext = has("next") || hasFile("next.config.js") || hasFile("next.config.mjs") || hasFile("next.config.ts");
  const isVite = has("vite") || hasFile("vite.config.ts") || hasFile("vite.config.js") || hasFile("vite.config.mjs");
  const isBun = hasFile("bun.lockb") || hasFile("bun.lock");
  const pm = isBun ? "bun" : "npm";

  const invariantCmd =
    scripts.test ? `${pm} test` : scripts["test:unit"] ? `${pm} run test:unit` : DEFAULT_INVARIANT;

  const metricCommands: WebMetricCommand[] = [];
  if (scripts.build) {
    metricCommands.push({ name: "bundle_bytes", command: `${pm} run build`, goal: "minimize", weight: 0.6, unit: "bytes" });
  }
  if (has("lighthouse") || has("@lhci/cli")) {
    metricCommands.push({ name: "lighthouse_performance", command: "npx lighthouse http://localhost:3000 --output=json --quiet", goal: "maximize", weight: 0.4, unit: "count" });
  }

  const globs = isNext
    ? ["app/**/*.{ts,tsx,js,jsx}", "pages/**/*.{ts,tsx,js,jsx}", "components/**/*.{ts,tsx,js,jsx}"]
    : DEFAULT_GLOBS;

  return {
    name: isNext ? "next-web" : isVite ? "vite-web" : "node-web",
    targetGlobs: globs,
    defaultInvariantCommand: invariantCmd,
    defaultMetricCommands: metricCommands.length ? metricCommands : [{ name: "bundle_bytes", command: `${pm} run build`, goal: "minimize", weight: 1, unit: "bytes" }],
    rulePresets: ["no-await-in-loops", "no-fetch-in-loops", "no-unindexed-filter"],
  };
}