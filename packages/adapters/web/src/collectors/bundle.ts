import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { MetricCollector, MetricResult } from "@perfgym/core";

const execAsync = promisify(exec);

export function parseBundleSize(output: string): number {
  const bytesMatch = output.match(/(\d[\d,]*)\s*bytes/i);
  if (bytesMatch) {
    return parseInt(bytesMatch[1].replace(/,/g, ""), 10);
  }
  const unitMatch = output.match(/([\d.]+)\s*(kb|mb|gb)/i);
  if (unitMatch) {
    const value = parseFloat(unitMatch[1]);
    const unit = unitMatch[2].toLowerCase();
    const multiplier = unit === "kb" ? 1024 : unit === "mb" ? 1024 * 1024 : 1024 * 1024 * 1024;
    return Math.round(value * multiplier);
  }
  return 0;
}

export class BundleCollector implements MetricCollector {
  readonly name = "bundle";

  constructor(private readonly command: string) {}

  async collect(): Promise<MetricResult> {
    const { stdout, stderr } = await execAsync(this.command, { timeout: 30000 });
    const bytes = parseBundleSize(`${stdout}\n${stderr}`);
    if (bytes <= 0) throw new Error("bundle size not found");
    return { name: "bundle_bytes", value: bytes, unit: "bytes", improved: false, deltaPercent: 0 };
  }
}