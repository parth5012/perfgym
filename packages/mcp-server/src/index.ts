/**
 * @perfgym/mcp-server
 * Model Context Protocol (MCP) Server implementation over stdio JSON-RPC.
 */

import * as readline from "node:readline";
import { execFileSync } from "node:child_process";
import {
  runBaseline,
  runStep,
  readState,
  loadConfig,
  type PerfGymState,
} from "../../cli/src/engine.js";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const PERFGYM_TOOLS: McpTool[] = [
  {
    name: "perfgym_baseline",
    description: "Inspects target configuration, invariant status, and current baseline score.",
    inputSchema: {
      type: "object",
      properties: {
        samples: {
          type: "number",
          description: "Number of benchmark samples to collect (default: 5)",
        },
      },
    },
  },
  {
    name: "perfgym_step",
    description: "Runs evaluation on latest mutation and returns structured feedback (accepted, delta %, remaining AST warnings, revert reason).",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of modified relative file paths to evaluate",
        },
        samples: {
          type: "number",
          description: "Number of benchmark samples to collect",
        },
        minDelta: {
          type: "number",
          description: "Minimum significance delta percentage threshold",
        },
      },
    },
  },
  {
    name: "perfgym_rollback",
    description: "Manually restores the worktree to the last checkpoint.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

export interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface McpServerOptions {
  cwd?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

export class PerfGymMcpServer {
  private cwd: string;

  constructor(options: McpServerOptions = {}) {
    this.cwd = options.cwd ?? process.cwd();
  }

  public async handleJsonRpcRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id ?? null;

    try {
      switch (req.method) {
        case "initialize": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: "perfgym-mcp-server",
                version: "0.1.0",
              },
            },
          };
        }

        case "notifications/initialized": {
          // JSON-RPC notifications do not expect a response
          return null as any;
        }

        case "tools/list": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              tools: PERFGYM_TOOLS,
            },
          };
        }

        case "tools/call": {
          const params = req.params ?? {};
          const toolName = params.name;
          const args = params.arguments ?? {};
          const toolResult = await this.executeTool(toolName, args);

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(toolResult, null, 2),
                },
              ],
            },
          };
        }

        default: {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: ${req.method}`,
            },
          };
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: msg,
        },
      };
    }
  }

  private async executeTool(name: string, args: Record<string, any>): Promise<any> {
    switch (name) {
      case "perfgym_baseline": {
        const samples = typeof args.samples === "number" ? args.samples : undefined;
        let state = readState(this.cwd);

        // If baseline hasn't been established yet or re-run requested, run baseline
        if (!state || samples !== undefined) {
          const res = await runBaseline({ cwd: this.cwd, samples });
          if (!res.success) {
            return {
              status: "error",
              error: res.error,
            };
          }
          state = res.state;
        }

        let config;
        try {
          config = loadConfig(this.cwd);
        } catch {
          // best-effort
        }

        return {
          status: "ok",
          targetName: state.targetName,
          invariantsPassed: state.invariantsPassed,
          baselineMetrics: state.baselineMetrics,
          bestFitnessScore: state.bestFitnessScore,
          config: config
            ? {
                target: config.target,
                metrics: config.metrics.map((m) => ({ name: m.name, goal: m.goal, weight: m.weight })),
              }
            : undefined,
        };
      }

      case "perfgym_step": {
        const files = Array.isArray(args.files) ? args.files : undefined;
        const samples = typeof args.samples === "number" ? args.samples : undefined;
        const minDelta = typeof args.minDelta === "number" ? args.minDelta : undefined;

        const res = await runStep({
          cwd: this.cwd,
          files,
          samples,
          minSignificanceDelta: minDelta,
        });

        const ev = res.evaluation;
        return {
          status: "ok",
          accepted: ev.accepted,
          fitnessScore: ev.fitnessScore === -Infinity ? null : ev.fitnessScore,
          deltaPercent: ev.deltaPercent,
          isSignificant: ev.isSignificant,
          invariants: {
            passed: ev.invariants.passed,
            durationMs: ev.invariants.durationMs,
          },
          violations: ev.violations.map((v) => ({
            ruleId: v.ruleId,
            message: v.message,
            file: v.file,
            line: v.line,
            action: v.action,
            penalty: v.penalty,
          })),
          metrics: ev.metrics.map((m) => ({
            name: m.name,
            value: m.value,
            improved: m.improved,
            deltaPercent: m.deltaPercent,
          })),
          revertReason: ev.revertReason,
          executionTimeMs: ev.executionTimeMs,
        };
      }

      case "perfgym_rollback": {
        try {
          execFileSync("git", ["reset", "--hard", "HEAD"], {
            cwd: this.cwd,
            stdio: "ignore",
          });
          execFileSync("git", ["clean", "-ffd"], {
            cwd: this.cwd,
            stdio: "ignore",
          });
          return {
            status: "ok",
            message: "Rollback completed. Working tree restored to HEAD.",
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            status: "error",
            message: `Rollback failed: ${msg}`,
          };
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  public listen(
    stdin: NodeJS.ReadableStream = process.stdin,
    stdout: NodeJS.WritableStream = process.stdout
  ): void {
    const rl = readline.createInterface({
      input: stdin,
      terminal: false,
    });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const req = JSON.parse(trimmed) as JsonRpcRequest;
        const res = await this.handleJsonRpcRequest(req);
        if (res !== null && res !== undefined) {
          stdout.write(JSON.stringify(res) + "\n");
        }
      } catch (err: unknown) {
        const errRes: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error",
          },
        };
        stdout.write(JSON.stringify(errRes) + "\n");
      }
    });
  }
}

// When executed directly as entrypoint:
if (
  process.argv[1] &&
  (/\b(packages\/mcp-server\/src\/index\.[tj]s|perfgym-mcp(\.js)?)$/).test(
    process.argv[1]
  )
) {
  const server = new PerfGymMcpServer();
  server.listen();
}
