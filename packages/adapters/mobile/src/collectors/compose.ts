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
    try {
      const { stdout, stderr } = await execAsync(this.command);
      return { name: "recomposition_count", value: parseRecompositionCount(`${stdout}\n${stderr}`), unit: "count", improved: false, deltaPercent: 0 };
    } catch (err: any) {
      return { name: "recomposition_count", value: parseRecompositionCount(`${err?.stdout ?? ""}\n${err?.stderr ?? ""}`), unit: "count", improved: false, deltaPercent: 0 };
    }
  }
}
