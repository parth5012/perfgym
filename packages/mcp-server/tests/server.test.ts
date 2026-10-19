import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { PerfGymMcpServer } from "../src/index.js";
import { writeState } from "../../cli/src/engine.js";

describe("PerfGym MCP Server (Ticket #18)", () => {
  let testDir: string;
  let server: PerfGymMcpServer;

  beforeEach(() => {
    testDir = path.join(tmpdir(), `perfgym-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testDir, { recursive: true });
    server = new PerfGymMcpServer({ cwd: testDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("handles initialize request with tool capabilities", async () => {
    const res = await server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });

    expect(res.id).toBe(1);
    expect(res.result).toBeDefined();
    expect(res.result.serverInfo.name).toBe("perfgym-mcp-server");
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it("lists all required tools: perfgym_baseline, perfgym_step, perfgym_rollback", async () => {
    const res = await server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(res.id).toBe(2);
    const tools = res.result.tools;
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("perfgym_baseline");
    expect(names).toContain("perfgym_step");
    expect(names).toContain("perfgym_rollback");
  });

  it("executes perfgym_baseline tool call and returns structured JSON output", async () => {
    const configYaml = `
version: "1.0"
target:
  name: "mcp-test"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "latency"
    command: "node -e 'console.log(JSON.stringify({ value: 120 }))'"
    goal: "minimize"
    weight: 1
    unit: "ms"
`;
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export const x = 1;", "utf8");

    const callRes = await server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "perfgym_baseline",
        arguments: { samples: 2 },
      },
    });

    expect(callRes.id).toBe(3);
    expect(callRes.error).toBeUndefined();
    expect(callRes.result.content).toBeDefined();
    expect(callRes.result.content[0].type).toBe("text");

    const body = JSON.parse(callRes.result.content[0].text);
    expect(body.status).toBe("ok");
    expect(body.targetName).toBe("mcp-test");
    expect(body.invariantsPassed).toBe(true);
    expect(body.baselineMetrics.latency).toBe(120);
  });

  it("executes perfgym_step tool call and returns accepted mutation verdict", async () => {
    const configYaml = `
version: "1.0"
target:
  name: "mcp-step"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "latency"
    command: "node -e 'console.log(JSON.stringify({ value: 90 }))'"
    goal: "minimize"
    weight: 1
    unit: "ms"
`;
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export const x = 2;", "utf8");

    // Establish baseline
    writeState(testDir, {
      version: "1.0",
      initializedAt: Date.now(),
      updatedAt: Date.now(),
      targetName: "mcp-step",
      baselineMetrics: { latency: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });

    const callRes = await server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "perfgym_step",
        arguments: {
          files: ["src/index.ts"],
          samples: 2,
        },
      },
    });

    expect(callRes.id).toBe(4);
    const body = JSON.parse(callRes.result.content[0].text);
    expect(body.status).toBe("ok");
    expect(body.accepted).toBe(true);
    expect(body.deltaPercent).toBeCloseTo(10, 1);
    expect(body.fitnessScore).toBeGreaterThan(0);
  });

  it("executes perfgym_step tool call and reports rejection on AST rule violation", async () => {
    const configYaml = `
version: "1.0"
target:
  name: "mcp-step-cheat"
  language: "typescript"
  files: ["src/**/*"]
invariants:
  command: "node -e 'process.exit(0)'"
metrics:
  - name: "latency"
    command: "node -e 'console.log(JSON.stringify({ value: 50 }))'"
    goal: "minimize"
    weight: 1
`;
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), configYaml, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, "src", "index.ts"),
      "// @ts-ignore\nexport const x: any = 1;",
      "utf8"
    );

    writeState(testDir, {
      version: "1.0",
      initializedAt: Date.now(),
      updatedAt: Date.now(),
      targetName: "mcp-step-cheat",
      baselineMetrics: { latency: 100 },
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
    });

    const callRes = await server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "perfgym_step",
        arguments: {
          files: ["src/index.ts"],
        },
      },
    });

    expect(callRes.id).toBe(5);
    const body = JSON.parse(callRes.result.content[0].text);
    expect(body.status).toBe("ok");
    expect(body.accepted).toBe(false);
    expect(body.fitnessScore).toBe(null); // -Infinity serializes as null
    expect(body.revertReason).toBeDefined();
    expect(body.violations.length).toBeGreaterThan(0);
  });

  it("executes perfgym_rollback and restores clean working tree", async () => {
    // Initialize git repo in testDir so git reset works
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: testDir, stdio: "ignore" });
    } catch {
      execFileSync("git", ["init"], { cwd: testDir, stdio: "ignore" });
    }
    execFileSync("git", ["config", "user.name", "Tester"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "tester@test.com"], { cwd: testDir, stdio: "ignore" });
    fs.writeFileSync(path.join(testDir, "initial.txt"), "hello", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: testDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: testDir, stdio: "ignore" });

    // Mutate file
    fs.writeFileSync(path.join(testDir, "initial.txt"), "corrupted", "utf8");

    const callRes = await server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "perfgym_rollback",
        arguments: {},
      },
    });

    expect(callRes.id).toBe(6);
    expect(callRes.result.content).toBeDefined();
    const body = JSON.parse(callRes.result.content[0].text);
    expect(body.status).toBe("ok");
    expect(body.message).toContain("Rollback completed");

    // Check that file was restored
    expect(fs.readFileSync(path.join(testDir, "initial.txt"), "utf8")).toBe("hello");
  });
});
