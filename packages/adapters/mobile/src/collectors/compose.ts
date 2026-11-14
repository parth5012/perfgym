import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { MetricCollector, MetricResult } from "@perfgym/core";
const execAsync = promisify(exec);

export function parseRecompositionCount(output: string): number {
  const m = output.match(/recomposition[s]?\s*[:=]\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

export class ComposeRecompositionCollector implements MetricCollector {
  readonly name = "compose";
  constructor(private readonly command: string) {}
  async collect(): Promise<MetricResult> {
    const { stdout, stderr } = await execAsync(this.command, { timeout: 30000 });
    const value = parseRecompositionCount(`${stdout}\n${stderr}`);
    return { name: "recomposition_count", value, unit: "count", improved: false, deltaPercent: 0 };
  }
}
