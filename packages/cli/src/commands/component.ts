import { loadConfig } from "../engine.js";
import type { PerfGymConfig } from "../../../core/src/index.js";

export interface ComponentCommandResult {
  markdown: string;
}

export function runComponentCommand(): ComponentCommandResult {
  let config: PerfGymConfig;
  try {
    config = loadConfig();
  } catch (err) {
    return { markdown: `Component monitoring unavailable: ${(err as Error).message}` };
  }
  const components = config?.components ?? [];
  if (!components.length) {
    return { markdown: "No component budgets configured. Add `components:` to .perfgym.yaml." };
  }
  const lines = ["### Component Budgets", "", ...components.map((c: any) => `- ${c.name} (${c.selector}): ${c.metric} <= ${c.threshold}`)];
  return { markdown: lines.join("\n") };
}