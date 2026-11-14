import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { MetricCollector, MetricResult } from "@perfgym/core";

const execAsync = promisify(exec);

export interface LighthouseScores {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
}

export function parseLighthouseScores(output: string): LighthouseScores {
  try {
    const json = JSON.parse(output);
    const cats = json?.categories ?? {};
    const toCount = (v: any) => (typeof v?.score === "number" ? Math.round(v.score * 100) : 0);
    return {
      performance: toCount(cats.performance),
      accessibility: toCount(cats.accessibility),
      bestPractices: toCount(cats["best-practices"]),
      seo: toCount(cats.seo),
    };
  } catch {
    return { performance: 0, accessibility: 0, bestPractices: 0, seo: 0 };
  }
}

export class LighthouseCollector implements MetricCollector {
  readonly name = "lighthouse";

  constructor(private readonly command: string) {}

  async collect(): Promise<MetricResult> {
    const { stdout, stderr } = await execAsync(this.command, { timeout: 60000 });
    const scores = parseLighthouseScores(stdout || stderr);
    return {
      name: "lighthouse_performance",
      value: scores.performance,
      unit: "count",
      improved: false,
      deltaPercent: 0,
    };
  }
}