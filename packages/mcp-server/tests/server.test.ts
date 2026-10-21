import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { PerfGymMcpServer } from "../src/index.js";
import { writeState } from "../../cli/src/engine.js";

describe("PerfGym MCP Server (Ticket #18)", () => {
  let testDir: string;
  let server: PerfGymMcpServer;

  const STEP_CONFIG = `
version: "1.0"
target:
  name: "mcp-format"
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

  const stateFixture = (targetName: string) => ({
    version: "1.0",
    initializedAt: Date.now(),
    updatedAt: Date.now(),
    targetName,
    baselineMetrics: { latency: 100 },
    invariantsPassed: true,
    bestFitnessScore: 0,
    acceptedStepCount: 0,
    totalStepCount: 0,
  });

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
    expect(body.status).toBe("BASELINE");
    expect(body.targetName).toBe("mcp-test");
    expect(body.invariantsPassed).toBe(true);
    expect(body.baselineMetrics.latency).toBe(120);
    expect(body.unit).toBe("ms");
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
    expect(body.status).toBe("ACCEPTED");
    expect(body.accepted).toBe(true);
    expect(body.deltaPercent).toBeCloseTo(10, 1);
    expect(body.score).toBeGreaterThan(0);
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
    expect(body.status).toBe("REVERTED");
    expect(body.accepted).toBe(false);
    expect(body.score).toBe(null); // -Infinity serializes as null
    expect(body.linter.matches.length).toBeGreaterThan(0);
  });

  it("exposes a format property on every tool input schema", async () => {
    const res = await server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/list",
      params: {},
    });

    const tools = res.result.tools as Array<{
      name: string;
      inputSchema: { properties: Record<string, { enum?: string[]; default?: string }> };
    }>;

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const format = tool.inputSchema.properties.format;
      expect(format, `${tool.name} should accept a format property`).toBeDefined();
      expect(format!.enum).toEqual(["markdown", "json"]);
      expect(format!.default).toBe("json");
    }
  });

  it("defaults to the LLD §6.1 JSON and falls back to JSON for unknown formats", async () => {
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), STEP_CONFIG, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export const x = 2;", "utf8");
    writeState(testDir, stateFixture("mcp-format"));

    const defaultRes = await server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "perfgym_step", arguments: { files: ["src/index.ts"], samples: 2 } },
    });
    const defaultBody = JSON.parse(defaultRes.result.content[0].text) as Record<string, unknown>;

    expect(Object.keys(defaultBody)).toEqual([
      "status",
      "accepted",
      "score",
      "deltaPercent",
      "isSignificant",
      "executionTimeMs",
      "invariants",
      "typecheck",
      "linter",
      "metrics",
      "stepReceipt",
      "negativeMemoryGuidance",
    ]);

    const unknownRes = await server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 22,
      method: "tools/call",
      params: {
        name: "perfgym_step",
        arguments: { files: ["src/index.ts"], samples: 2, format: "yaml" },
      },
    });
    expect(unknownRes.error).toBeUndefined();
    const unknownBody = JSON.parse(unknownRes.result.content[0].text) as Record<string, unknown>;
    expect(unknownBody.status).toBe(defaultBody.status);
  });

  it("renders markdown when format is markdown, for baseline and step", async () => {
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), STEP_CONFIG, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export const x = 2;", "utf8");
    writeState(testDir, stateFixture("mcp-markdown"));

    const baselineRes = await server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: {
        name: "perfgym_baseline",
        arguments: { samples: 2, format: "markdown" },
      },
    });
    const baselineText = baselineRes.result.content[0].text as string;
    expect(baselineText).toContain("### 📊 Baseline Recorded");
    expect(() => JSON.parse(baselineText)).toThrow();

    const stepRes = await server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: {
        name: "perfgym_step",
        arguments: { files: ["src/index.ts"], samples: 2, format: "markdown" },
      },
    });
    const stepText = stepRes.result.content[0].text as string;
    expect(stepText).toContain("#### 1. Invariants & Types");
    expect(stepText).toContain("#### 2. Performance Distribution (Baseline vs Mutation)");
    expect(stepText).toContain("#### 3. AST Pattern Violations");
    expect(stepText).not.toMatch(/\u001b\[[0-9;]*m/);
  });

  it("never leaks ANSI from subprocess output into MCP text content", async () => {
    // The invariant command writes a real ESC byte to stderr, so both the
    // revert reason (markdown) and the error message (JSON failure) carry ANSI.
    fs.writeFileSync(
      path.join(testDir, "noisy.js"),
      'process.stderr.write(String.fromCharCode(27) + "[31mFAIL" + String.fromCharCode(27) + "[0m");\nprocess.exit(1);\n',
      "utf8",
    );
    const noisyConfig = STEP_CONFIG.replace(
      `command: "node -e 'process.exit(0)'"`,
      `command: "node noisy.js"`,
    );
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), noisyConfig, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export const x = 2;", "utf8");

    const carryingEscape = (value: unknown): boolean => {
      if (typeof value === "string") return value.includes("\u001b");
      if (Array.isArray(value)) return value.some(carryingEscape);
      if (value !== null && typeof value === "object") {
        return Object.values(value).some(carryingEscape);
      }
      return false;
    };

    writeState(testDir, stateFixture("mcp-ansi"));
    for (const format of ["markdown", "json"] as const) {
      const res = await server.handleJsonRpcRequest({
        jsonrpc: "2.0",
        id: 30,
        method: "tools/call",
        params: {
          name: "perfgym_step",
          arguments: { files: ["src/index.ts"], samples: 1, format },
        },
      });

      const text = res.result.content[0].text as string;
      expect(text).not.toContain("\u001b");
      if (format === "json") {
        expect(carryingEscape(JSON.parse(text))).toBe(false);
      } else {
        expect(text).toContain("FAIL");
      }
    }

    // The baseline gate fails on the same command and surfaces through formatError.
    fs.rmSync(path.join(testDir, ".perfgym"), { recursive: true, force: true });
    for (const format of ["markdown", "json"] as const) {
      const res = await server.handleJsonRpcRequest({
        jsonrpc: "2.0",
        id: 31,
        method: "tools/call",
        params: { name: "perfgym_baseline", arguments: { samples: 1, format } },
      });

      const text = res.result.content[0].text as string;
      expect(text).not.toContain("\u001b");
      if (format === "json") {
        expect(carryingEscape(JSON.parse(text))).toBe(false);
      }
    }
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
