import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { PerfGymMcpServer } from "../src/index.js";
import { saveSession } from "../../cli/src/engine.js";

const TOOL_NAMES = [
  "perfgym_baseline",
  "perfgym_step",
  "perfgym_rollback",
  "perfgym_status",
  "perfgym_test",
  "perfgym_lint",
  "perfgym_benchmark",
] as const;

describe("PerfGym MCP Server extended tools (Ticket #45)", () => {
  let testDir: string;
  let server: PerfGymMcpServer;

  const GYM_CONFIG = `
version: "1.0"
target:
  name: "mcp-extended"
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

  /**
   * Seeds a full session state with one accepted step so the coordinator
   * (not the legacy git reset) owns perfgym_rollback. Mirrors the shape the
   * McpServerCoordinator reads from .perfgym/state.json.
   */
  const stateWithHistory = (extras: Record<string, unknown> = {}) => ({
    version: "1.0",
    initializedAt: Date.now(),
    updatedAt: Date.now(),
    targetName: "mcp-extended",
    baselineMetrics: { latency: 100 },
    invariantsPassed: true,
    bestFitnessScore: 0.2,
    acceptedStepCount: 1,
    totalStepCount: 1,
    history: [
      {
        stepNumber: 1,
        score: 0.2,
        status: "ACCEPTED",
        metrics: { latency: 90 },
        metricDeltas: { latency: -10 },
        timestamp: Date.now(),
      },
    ],
    currentMetrics: { latency: 90 },
    metricDeltas: { latency: -10 },
    ...extras,
  });

  const seedWorkspace = () => {
    fs.writeFileSync(path.join(testDir, ".perfgym.yaml"), GYM_CONFIG, "utf8");
    fs.mkdirSync(path.join(testDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(testDir, "src", "index.ts"), "export const x = 1;", "utf8");
  };

  const seedGitRepo = (): string => {
    seedWorkspace();
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
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: testDir, encoding: "utf8" }).trim();
  };

  const readStateFile = (): Record<string, any> =>
    JSON.parse(
      fs.readFileSync(path.join(testDir, ".perfgym", "state.json"), "utf8")
    );

  const call = (name: string, args: Record<string, unknown> = {}) =>
    server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });

  beforeEach(() => {
    testDir = path.join(tmpdir(), `perfgym-mcp-ext-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
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

  it("lists all seven tools and documents every input schema property", async () => {
    const res = await server.handleJsonRpcRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    const tools = res.result.tools as Array<{
      name: string;
      inputSchema: { properties: Record<string, { description?: string }> };
    }>;

    const names = tools.map((t) => t.name);
    for (const expected of TOOL_NAMES) {
      expect(names).toContain(expected);
    }
    expect(tools.length).toBe(7);

    for (const tool of tools) {
      for (const [prop, def] of Object.entries(tool.inputSchema.properties)) {
        expect(def.description, `${tool.name}.${prop} needs a description`).toBeTruthy();
      }
    }
  });

  it("all seven tools are callable and return parseable JSON by default", async () => {
    seedWorkspace();
    saveSession(testDir, stateWithHistory() as Parameters<typeof saveSession>[1]);

    const calls: Array<[string, Record<string, unknown>]> = [
      ["perfgym_baseline", { samples: 2 }],
      ["perfgym_step", { files: ["src/index.ts"], samples: 2 }],
      ["perfgym_status", {}],
      ["perfgym_test", { command: "node -e 'process.exit(0)'" }],
      ["perfgym_lint", { files: ["src/index.ts"] }],
      ["perfgym_benchmark", { samples: 2 }],
    ];

    for (const [name, args] of calls) {
      const res = await call(name, args);
      expect(res.error, `${name} should not fail at the JSON-RPC level`).toBeUndefined();
      expect(res.result.content[0].type).toBe("text");
      expect(res.result.isError, `${name} should succeed`).toBeUndefined();

      const body = JSON.parse(res.result.content[0].text);
      expect(body, `${name} text must be a JSON object`).toBeTypeOf("object");
    }

    // Rollback ran LAST in earlier revisions because it mutated the seeded
    // state. R4: a fresh coordinator (new per call) has no restore material
    // for the seeded in-memory session — it must REFUSE (honest failure)
    // instead of marking history ROLLED_BACK while restoring nothing.
    const rb = await call("perfgym_rollback", {});
    expect(rb.result.isError, "rollback must refuse without restore material").toBe(true);
    const rbBody = JSON.parse(rb.result.content[0].text);
    expect(rbBody.error.message).toMatch(/rollback failed|snapshot|restore/i);

    // Spot-check projections behind the thin shim.
    const status = await call("perfgym_status");
    const statusBody = JSON.parse(status.result.content[0].text);
    expect(statusBody.initialized).toBe(true);

    const test = await call("perfgym_test");
    expect(JSON.parse(test.result.content[0].text).passed).toBe(true);
  });

  it("perfgym_status returns structured content on a workspace without baseline (read-only)", async () => {
    const res = await call("perfgym_status");

    expect(res.error).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    expect(body.initialized).toBe(false);
    expect(body.sessionStatus).toBe("not_initialized");
    expect(body.currentStep).toBe(0);
    expect(body.lockState.locked).toBe(false);

    // handleStatus is read-only: it must not conjure a state file.
    expect(fs.existsSync(path.join(testDir, ".perfgym", "state.json"))).toBe(false);
  });

  it("perfgym_rollback refuses while another holder owns the lock (lock busy)", async () => {
    seedGitRepo();
    fs.writeFileSync(path.join(testDir, "initial.txt"), "corrupted", "utf8");
    saveSession(testDir, stateWithHistory() as Parameters<typeof saveSession>[1]);

    // Craft a foreign live lock exactly like the coordinator tests do.
    const lockDir = path.join(testDir, ".perfgym", ".lock.d");
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "metadata.json"),
      JSON.stringify({
        pid: process.pid,
        runId: "alien-run-12345",
        startTime: Date.now(),
        heartbeat: Date.now(),
      }),
      "utf8"
    );

    const res = await call("perfgym_rollback");

    expect(res.result.isError).toBe(true);
    const body = JSON.parse(res.result.content[0].text);
    expect(body.error.message).toMatch(/lock busy/i);

    // The refused rollback must not have restored the worktree.
    expect(fs.readFileSync(path.join(testDir, "initial.txt"), "utf8")).toBe("corrupted");
  });

  it("perfgym_rollback routes through the coordinator, restores the sandbox worktree from git, and marks history ROLLED_BACK", async () => {
    const baselineCommit = seedGitRepo();
    fs.writeFileSync(path.join(testDir, "initial.txt"), "corrupted", "utf8");
    saveSession(
      testDir,
      stateWithHistory({ baselineCommit }) as Parameters<typeof saveSession>[1]
    );

    const res = await call("perfgym_rollback");

    expect(res.error).toBeUndefined();
    expect(res.result.isError).toBeUndefined();
    const body = JSON.parse(res.result.content[0].text);
    expect(body.status).toBe("ok");
    expect(body.message).toContain("Rollback completed");

    // The user's working directory is NEVER touched by a coordinator rollback
    // (same contract as the CLI lifecycle): the legacy bare reset remains the
    // only path that resets the root, for uninitialized workspaces.
    expect(fs.readFileSync(path.join(testDir, "initial.txt"), "utf8")).toBe("corrupted");

    // Session state is updated by the coordinator, not by a raw git reset.
    const state = readStateFile();
    expect(state.history[0].status).toBe("ROLLED_BACK");
    expect(state.totalStepCount).toBe(0);
  });

  // --- B1 --------------------------------------------------------------------
  it("B1: stateless git calls tear down their worktree and eval branch (no leak)", async () => {
    const baselineCommit = seedGitRepo();
    saveSession(
      testDir,
      stateWithHistory({ baselineCommit }) as Parameters<typeof saveSession>[1]
    );

    // Two sequential stateless calls — the bug (B1) leaked one worktree dir +
    // one `perfgym/eval-*` branch per call.
    const rb1 = await call("perfgym_rollback");
    expect(rb1.result.isError, "rollback 1 must succeed").toBeUndefined();
    const rb2 = await call("perfgym_rollback");
    expect(rb2.result.isError, "rollback 2 must succeed").toBeUndefined();

    // No worktree directories left under .perfgym/worktrees.
    const worktreesDir = path.join(testDir, ".perfgym", "worktrees");
    const leftovers = fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir) : [];
    expect(leftovers.filter((d) => !d.startsWith("."))).toEqual([]);

    // No perfgym/eval-* branches left in the repo.
    const branches = execFileSync(
      "git",
      ["branch", "--list", "perfgym/eval-*"],
      { cwd: testDir, encoding: "utf8" }
    );
    expect(branches.trim()).toBe("");
  });

  // --- R4 --------------------------------------------------------------------
  it("perfgym_rollback refuses (honest failure) when no snapshot and no commit material exists", async () => {
    seedGitRepo();
    // Seeded history WITHOUT baselineCommit and WITHOUT commitHash — a fresh
    // coordinator has nothing to restore from. The old shim reported success
    // while restoring nothing; it must now surface a real failure.
    saveSession(testDir, stateWithHistory() as Parameters<typeof saveSession>[1]);

    const res = await call("perfgym_rollback");

    expect(res.result.isError).toBe(true);
    const body = JSON.parse(res.result.content[0].text);
    expect(body.error.message).toMatch(/rollback failed|snapshot|restore|commit/i);
  });

  it("new tools honor explicit format: json parses, markdown does not", async () => {
    // R4: rollback on a git-backed workspace with commit material — the
    // coordinator restores via the baselineCommit recorded in state.
    const baselineCommit = seedGitRepo();
    saveSession(
      testDir,
      stateWithHistory({ baselineCommit }) as Parameters<typeof saveSession>[1]
    );

    const newTools: Array<[string, Record<string, unknown>]> = [
      ["perfgym_status", {}],
      ["perfgym_test", {}],
      ["perfgym_lint", {}],
      ["perfgym_benchmark", { samples: 2 }],
      ["perfgym_rollback", {}],
    ];

    for (const [name, args] of newTools) {
      const jsonRes = await call(name, { ...args, format: "json" });
      const jsonBody = JSON.parse(jsonRes.result.content[0].text);
      expect(jsonBody).toBeTypeOf("object");

      const mdRes = await call(name, { ...args, format: "markdown" });
      const mdText = mdRes.result.content[0].text as string;
      expect(mdText).toContain("###");
      expect(() => JSON.parse(mdText)).toThrow();
      expect(mdText).not.toMatch(/\u001b\[[0-9;]*m/);
    }
  });
});
