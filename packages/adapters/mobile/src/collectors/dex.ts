import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { MetricCollector, MetricResult } from "@perfgym/core";
const execAsync = promisify(exec);

export function parseDexSize(output: string): number {
  const m = output.match(/(\d+)\s*bytes/i) || output.match(/dex[:\s]+(\d+)/i);
  return m ? parseInt(m[1], 10) : 0;
}

export class DexSizeCollector implements MetricCollector {
  readonly name = "dex";
  constructor(private readonly command: string) {}
  async collect(): Promise<MetricResult> {
    try {
      const { stdout, stderr } = await execAsync(this.command);
      return { name: "dex_size_bytes", value: parseDexSize(`${stdout}\n${stderr}`), unit: "bytes", improved: false, deltaPercent: 0 };
    } catch (err: any) {
      return { name: "dex_size_bytes", value: parseDexSize(`${err?.stdout ?? ""}\n${err?.stderr ?? ""}`), unit: "bytes", improved: false, deltaPercent: 0 };
    }
  }
}
