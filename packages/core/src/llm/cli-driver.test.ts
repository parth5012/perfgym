import { describe, expect, it } from "vitest";
import { CliAgentSubprocessDriver } from "./cli-driver.js";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";

describe("CliAgentSubprocessDriver", () => {
  it("extracts the first balanced JSON object from noisy prose", () => {
    const driver = new CliAgentSubprocessDriver();
    const noisy = `
Here is my optimization plan:
We should optimize the inner loop.

{
  "mutations": [
    {
      "path": "src/loop.ts",
      "content": "export function loop() {}",
      "rationale": "optimized"
    }
  ]
}

Hope this helps! Let me know if you need more changes.
`;
    const extracted = driver.extractBalancedJsonObject(noisy);
    expect(extracted).not.toBeNull();
    const parsed = JSON.parse(extracted!);
    expect(parsed.mutations).toHaveLength(1);
    expect(parsed.mutations[0].path).toBe("src/loop.ts");
  });

  it("handles strings with braces and escaped characters inside JSON", () => {
    const driver = new CliAgentSubprocessDriver();
    const payload = JSON.stringify({
      mutations: [
        {
          path: "src/template.ts",
          content: "const a = '{ escaped \" { } } }';",
          rationale: "brace test",
        },
      ],
    });
    const wrapped = `Some prologue\n${payload}\nSome epilogue`;
    const extracted = driver.extractBalancedJsonObject(wrapped);
    expect(extracted).toBe(payload);
  });

  it("spawns a stub script via node, receives prompt on stdin, and parses stdout", async () => {
    // Write a temporary Node script that verifies stdin and echoes valid JSON
    const scriptPath = join(tmpdir(), `stub-cli-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(
      scriptPath,
      `
      let stdinData = '';
      process.stdin.on('data', chunk => { stdinData += chunk; });
      process.stdin.on('end', () => {
        if (!stdinData.includes('TARGET_TOKEN')) {
          console.error('Missing target token on stdin');
          process.exit(1);
        }
        console.log(JSON.stringify({
          mutations: [{ path: 'src/stub.ts', content: 'export const stub = 42;', rationale: 'stubbed' }]
        }));
      });
      `
    );

    try {
      const driver = new CliAgentSubprocessDriver({
        cliCommand: process.execPath,
        cliArgs: [scriptPath],
      });

      const res = await driver.complete({ prompt: "Hello TARGET_TOKEN please optimize" });
      expect(res.mutations).toHaveLength(1);
      expect(res.mutations[0].path).toBe("src/stub.ts");
      expect(res.skipped).toBeUndefined();
    } finally {
      try {
        unlinkSync(scriptPath);
      } catch {}
    }
  });

  it("retries unparseable output once and skips iteration if still invalid", async () => {
    const scriptPath = join(tmpdir(), `stub-bad-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(
      scriptPath,
      `
      console.log("I am completely broken and refuse to return json");
      `
    );

    try {
      const driver = new CliAgentSubprocessDriver({
        cliCommand: process.execPath,
        cliArgs: [scriptPath],
      });

      const res = await driver.complete({ prompt: "optimize" });
      expect(res.skipped).toBe(true);
      expect(res.mutations).toHaveLength(0);
      expect(res.error).toContain("balanced JSON object");
    } finally {
      try {
        unlinkSync(scriptPath);
      } catch {}
    }
  });

  it("enforces timeout, kills the process tree, and marks iteration as skipped", async () => {
    const scriptPath = join(tmpdir(), `stub-hang-${Date.now()}-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(
      scriptPath,
      `
      // Hang forever
      setInterval(() => {}, 10000);
      `
    );

    try {
      const driver = new CliAgentSubprocessDriver({
        cliCommand: process.execPath,
        cliArgs: [scriptPath],
        timeoutMs: 300,
      });

      const start = Date.now();
      const res = await driver.complete({ prompt: "optimize", timeoutMs: 300 });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(res.skipped).toBe(true);
      expect(res.error).toContain("timed out");
    } finally {
      try {
        unlinkSync(scriptPath);
      } catch {}
    }
  });
});
