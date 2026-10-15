/**
 * @perfgym/adapter-web
 * Web, Node.js, and Full-Stack Platform Adapter
 */

import type { InvariantResult, MetricResult } from "@perfgym/core";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class WebPlatformAdapter {
  name = "web-adapter";
  supportedLanguages = ["typescript", "javascript"];

  public async runInvariants(command: string, timeoutMs = 15000): Promise<InvariantResult> {
    const start = Date.now();
    try {
      const { stdout } = await execAsync(command, { timeout: timeoutMs });
      return {
        passed: true,
        output: stdout,
        durationMs: Date.now() - start
      };
    } catch (err: any) {
      return {
        passed: false,
        output: err.stdout || err.message,
        durationMs: Date.now() - start
      };
    }
  }

  public async runBenchmark(command: string, baselineValue?: number): Promise<MetricResult> {
    const { stdout } = await execAsync(command);
    // Parse benchmark output (e.g. ops/sec, ms, or cycle count)
    const numericMatch = stdout.match(/([0-9]+(\.[0-9]+)?)/);
    const value = numericMatch ? parseFloat(numericMatch[0]) : 0;

    let deltaPercent = 0;
    let improved = false;

    if (baselineValue && baselineValue > 0) {
      // Assuming minimization (e.g. latency, memory, instructions)
      deltaPercent = ((baselineValue - value) / baselineValue) * 100;
      improved = deltaPercent > 0;
    }

    return {
      name: "benchmark_metric",
      value,
      unit: "ms",
      improved,
      deltaPercent
    };
  }
}
