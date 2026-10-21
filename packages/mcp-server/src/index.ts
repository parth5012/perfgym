/**
 * @perfgym/mcp-server
 * Model Context Protocol (MCP) Server implementation over stdio JSON-RPC.
 */

import * as readline from "node:readline";
import { execFileSync } from "node:child_process";
import {
  createFormatter,
  stripAnsi,
  type OutputFormat,
  type PerfGymConfig,
} from "../../core/src/index.js";
import {
  runBaseline,
  runStep,
  readState,
  loadConfig,
  type PerfGymState,
} from "../../cli/src/engine.js";

/**
 * Every tool accepts an explicit response format. Agents are the primary MCP
 * consumer, so JSON is the default; markdown is for humans reading transcripts.
 */
const FORMAT_PROPERTY = {
  type: "string",
  enum: ["markdown", "json"],
  default: "json",
  description:
    'Response format: "json" (LLD §6.1, default) or "markdown" (LLD §6.2)',
} as const;

const resolveFormat = (args: Record<string, unknown>): OutputFormat =>
  // Unknown or missing values fall back to JSON rather than failing the call.
  args.format === "markdown" ? "markdown" : "json";

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
        format: FORMAT_PROPERTY,
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
        format: FORMAT_PROPERTY,
      },
    },
  },
  {
    name: "perfgym_rollback",
    description: "Manually restores the worktree to the last checkpoint.",
    inputSchema: {
      type: "object",
      properties: {
        format: FORMAT_PROPERTY,
      },
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
          // Tool responses are already rendered through the shared formatter;
          // strip ANSI at the protocol boundary as a belt-and-braces guarantee.
          const text = stripAnsi(await this.executeTool(toolName, args));

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text,
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

  private bestEffortConfig(): PerfGymConfig | undefined {
    try {
      return loadConfig(this.cwd);
    } catch {
      // The tools must stay usable before `perfgym init` — config is optional.
      return undefined;
    }
  }

  /** Renders a tool response through the shared OutputFormatter seam. */
  private async executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    const formatter = createFormatter(resolveFormat(args));

    switch (name) {
      case "perfgym_baseline": {
        const samples = typeof args.samples === "number" ? args.samples : undefined;
        let state = readState(this.cwd);

        // If baseline hasn't been established yet or re-run requested, run baseline
        if (!state || samples !== undefined) {
          const res = await runBaseline({ cwd: this.cwd, samples });
          if (!res.success) {
            return formatter.formatError(new Error(String(res.error)));
          }
          state = res.state;
        }

        const config = this.bestEffortConfig();
        const primaryName = config?.metrics[0]?.name;
        const primaryDistribution =
          primaryName === undefined ? undefined : state.baselineDistributions?.[primaryName];

        if (formatter.format === "markdown") {
          const body =
            primaryDistribution === undefined
              ? "### 📊 Baseline Recorded"
              : formatter.formatBaseline(primaryDistribution, config);
          return `${body}\n\n- **Target:** \`${state.targetName}\`\n- **Invariants:** ${
            state.invariantsPassed ? "✅ Passed" : "❌ Failed"
          }`;
        }

        const baselineDoc =
          primaryDistribution === undefined
            ? { status: "BASELINE" }
            : (JSON.parse(formatter.formatBaseline(primaryDistribution, config)) as Record<
                string,
                unknown
              >);

        return JSON.stringify(
          {
            ...baselineDoc,
            targetName: state.targetName,
            invariantsPassed: state.invariantsPassed,
            baselineMetrics: state.baselineMetrics,
            bestFitnessScore: Number.isFinite(state.bestFitnessScore)
              ? state.bestFitnessScore
              : null,
            ...(config === undefined
              ? {}
              : {
                  config: {
                    target: config.target,
                    metrics: config.metrics.map((m) => ({
                      name: m.name,
                      goal: m.goal,
                      weight: m.weight,
                    })),
                  },
                }),
          },
          null,
          2,
        );
      }

      case "perfgym_step": {
        const files = Array.isArray(args.files) ? args.files : undefined;
        const samples = typeof args.samples === "number" ? args.samples : undefined;
        const minDelta = typeof args.minDelta === "number" ? args.minDelta : undefined;

        try {
          const res = await runStep({
            cwd: this.cwd,
            files,
            samples,
            minSignificanceDelta: minDelta,
          });

          return formatter.formatStep(res.evaluation, this.bestEffortConfig());
        } catch (err: unknown) {
          return formatter.formatError(err);
        }
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
          return this.renderMessage(
            formatter,
            "Rollback completed. Working tree restored to HEAD.",
          );
        } catch (err: unknown) {
          return formatter.formatError(
            new Error(`Rollback failed: ${err instanceof Error ? err.message : String(err)}`),
          );
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Lifecycle messages (rollback) have no LLD schema and no formatter method;
   * render them consistently in whichever mode the caller asked for.
   */
  private renderMessage(formatter: { format: OutputFormat }, message: string): string {
    return formatter.format === "markdown"
      ? `### ✅ Rollback\n\n${message}`
      : JSON.stringify({ status: "ok", message }, null, 2);
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
