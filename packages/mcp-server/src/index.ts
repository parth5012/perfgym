/**
 * @perfgym/mcp-server
 * Model Context Protocol (MCP) Server implementation over stdio JSON-RPC.
 *
 * The server is a thin JSON-RPC shim over the shared McpServerCoordinator
 * (Ticket #45): every tool call routes through a coordinator handler, which
 * owns sandbox locking and returns structured domain objects. This file only
 * projects those objects into per-tool JSON/markdown payloads at the edge.
 */

import * as readline from "node:readline";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  createFormatter,
  stripAnsi,
  type OutputFormat,
  type PerfGymConfig,
  type BenchmarkDistribution,
  GitWorktreeDriver,
  InMemorySandboxDriver,
} from "../../core/src/index.js";
import {
  readState,
  loadConfig,
  type PerfGymState,
} from "../../cli/src/engine.js";
import {
  McpServerCoordinator,
  type StepEvaluation,
  type InvariantResult,
  type StatusReport,
  type LintOutcome,
  type BenchmarkOutcome,
} from "../../cli/src/coordinator/index.js";

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
    description: "Manually restores the worktree to the last checkpoint (respects the sandbox lock).",
    inputSchema: {
      type: "object",
      properties: {
        format: FORMAT_PROPERTY,
      },
    },
  },
  {
    name: "perfgym_status",
    description: "Read-only session report: initialization, run id, current step, best fitness score, baseline/current metrics with deltas, step history, negative memory, and sandbox lock state.",
    inputSchema: {
      type: "object",
      properties: {
        format: FORMAT_PROPERTY,
      },
    },
  },
  {
    name: "perfgym_test",
    description: "Runs the invariant command (side-effect-free) and reports pass/fail with output and duration. Leaves the worktree and state untouched.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "Invariant command override (default: the configured invariants.command)",
        },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds for the invariant command",
        },
        samples: {
          type: "number",
          description: "Sample-count hint passed through to the coordinator (the invariant gate does not sample)",
        },
        format: FORMAT_PROPERTY,
      },
    },
  },
  {
    name: "perfgym_lint",
    description: "Runs AST pattern rules plus the tier-1 typecheck over target files and reports violations, total penalty, and disqualification (side-effect-free).",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of relative file paths to lint (default: config target files)",
        },
        format: FORMAT_PROPERTY,
      },
    },
  },
  {
    name: "perfgym_benchmark",
    description: "Runs a configured metric benchmark with the pipeline's sampling and reports the distribution plus delta vs the stored baseline without updating state (side-effect-free).",
    inputSchema: {
      type: "object",
      properties: {
        metric: {
          type: "string",
          description: "Name of the configured metric to benchmark (default: the first configured metric)",
        },
        command: {
          type: "string",
          description: "Benchmark command override (default: the metric's configured command)",
        },
        samples: {
          type: "number",
          description: "Number of benchmark samples to collect",
        },
        format: FORMAT_PROPERTY,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Edge markdown renderers (small, local — the coordinator never renders).
// ---------------------------------------------------------------------------

const renderStatusMarkdown = (report: StatusReport): string => {
  const lines = [
    "### 📈 Perfgym Status",
    "",
    `- **Initialized:** ${report.initialized ? "✅ Yes" : "❌ No"}`,
    `- **Session:** ${report.sessionStatus}`,
    `- **Run:** ${report.runId ?? "—"}`,
    `- **Base ref:** ${report.baseRef}`,
    `- **Current step:** ${report.currentStep}`,
    `- **Best fitness:** ${
      report.bestFitnessScore === null
        ? "—"
        : `${report.bestFitnessScore}${report.bestStep !== null ? ` (step ${report.bestStep})` : ""}`
    }`,
  ];
  const history =
    report.stepHistory.length === 0
      ? []
      : report.stepHistory
          .map((h) => `\`#${h.stepNumber} ${h.status}\``)
          .join(" → ");
  lines.push(`- **Step history:** ${report.stepHistory.length > 0 ? history : "— none —"}`);
  lines.push(
    `- **Sandbox lock:** ${
      report.lockState.locked
        ? `🔒 held by PID ${report.lockState.pid ?? "?"}${report.lockState.isStale ? " (stale)" : ""}`
        : "🔓 free"
    }`
  );
  return lines.join("\n");
};

const renderTestMarkdown = (result: InvariantResult): string =>
  [
    "### 🧪 Test",
    "",
    `- **Result:** ${result.passed ? "✅ Passed" : "❌ Failed"}`,
    `- **Duration:** ${result.durationMs}ms`,
    ...(result.output ? ["", "```", result.output, "```"] : []),
  ].join("\n");

const renderLintMarkdown = (outcome: LintOutcome): string => {
  const lines = [
    "### 🔍 Lint",
    "",
    `- **Result:** ${outcome.passed ? "✅ Passed" : "❌ Failed"}`,
    `- **Violations:** ${outcome.errorCount} error(s), ${outcome.warningCount} warning(s)`,
    `- **Total penalty:** ${outcome.totalPenalty}`,
  ];
  if (outcome.disqualified) {
    lines.push("", "🚫 Disqualified: a disqualify-action rule fired.");
  }
  if (outcome.violations.length > 0) {
    lines.push(
      "",
      // Bounded list: transcripts stay readable for big files.
      ...outcome.violations
        .slice(0, 10)
        .map(
          (v) => `- **${v.ruleId}** \`${v.file}:${v.line}\` — ${v.message} (${v.severity}, penalty ${v.penalty})`
        )
    );
    if (outcome.violations.length > 10) {
      lines.push(`- … and ${outcome.violations.length - 10} more`);
    }
  }
  return lines.join("\n");
};

const renderBenchmarkMarkdown = (outcome: BenchmarkOutcome): string => {
  const lines = [
    "### ⏱️ Benchmark",
    "",
    `- **Metric:** \`${outcome.metricName}\` (${outcome.unit})`,
    `- **Value (p50):** ${outcome.currentValue}`,
  ];
  if (outcome.baselineValue !== undefined) {
    lines.push(
      `- **Baseline:** ${outcome.baselineValue}`,
      `- **Delta:** ${outcome.deltaPercent >= 0 ? "+" : ""}${outcome.deltaPercent}% ${
        outcome.improved ? "📈 improved" : "📉 regressed"
      }`
    );
  }
  return lines.join("\n");
};

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
          const outcome = await this.executeTool(toolName, args);
          const text = stripAnsi(outcome.text);

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
              ...(outcome.isError === true ? { isError: true } : {}),
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

  /**
   * Runs one tool call against a fresh McpServerCoordinator and releases any
   * sandbox lock the call acquired.
   *
   * A fresh coordinator re-reads config/state from disk on every call — the
   * same contract the engine had — and MCP tool calls are stateless: if the
   * coordinator is allowed to keep the session lock after step/baseline, the
   * next call (from the same server) would refuse with "lock busy" forever.
   *
   * R4: on a git workspace the coordinator must back onto a GitWorktreeDriver
   * (the same construction edge as the CLI lifecycle factory) so rollback
   * restores from durable git commits. The default in-memory driver keeps no
   * snapshots across stateless calls, which used to make rollback a
   * success-reporting no-op. Non-git workspaces stay on the in-memory driver.
   */
  private async withCoordinator<T>(
    run: (coordinator: McpServerCoordinator) => Promise<T>
  ): Promise<T> {
    const targetGlobs = this.bestEffortConfig()?.target.files ?? ["src/**/*"];
    const driver = fs.existsSync(path.join(this.cwd, ".git"))
      ? new GitWorktreeDriver({ repoRoot: this.cwd, allowedGlobs: targetGlobs })
      : new InMemorySandboxDriver({ allowedGlobs: targetGlobs });
    const coordinator = new McpServerCoordinator({
      rootDir: this.cwd,
      driver,
    });
    const sandbox = coordinator.getSandbox();
    try {
      const result = await run(coordinator);
      return result;
    } finally {
      if (sandbox.isLocked()) {
        try {
          await sandbox.release();
        } catch {
          // Best-effort cleanup: never mask the tool result with a release error.
        }
      }
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

  /**
   * Renders a tool response through the shared OutputFormatter seam.
   *
   * `isError` travels alongside the text so `tools/call` can set the MCP
   * `result.isError` flag: a formatted failure is still a failed tool call.
   */
  private async executeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError?: boolean }> {
    const formatter = createFormatter(resolveFormat(args));

    switch (name) {
      case "perfgym_baseline": {
        const samples = typeof args.samples === "number" ? args.samples : undefined;
        // Reports the stored record when one exists and no re-run is requested;
        // otherwise records a fresh baseline through the coordinator (which
        // also owns the sandbox lock and writes the state record).
        const stored = samples === undefined ? readState(this.cwd) : null;

        return this.withCoordinator(async (coordinator) => {
          try {
            let state: PerfGymState;
            let distributions: Record<string, BenchmarkDistribution> | undefined;
            if (stored) {
              state = stored;
              distributions = stored.baselineDistributions;
            } else {
              const outcome = await coordinator.handleBaseline({ samples });
              state = outcome.state;
              distributions = outcome.distributions;
            }
            return this.projectBaseline(formatter, state, distributions);
          } catch (err: unknown) {
            return { text: formatter.formatError(err), isError: true };
          }
        });
      }

      case "perfgym_step": {
        const files = Array.isArray(args.files) ? (args.files as string[]) : undefined;
        const samples = typeof args.samples === "number" ? args.samples : undefined;
        const minDelta = typeof args.minDelta === "number" ? args.minDelta : undefined;

        return this.withCoordinator(async (coordinator) => {
          try {
            const evaluation = await coordinator.handleStep({ files, samples, minDelta });
            return { text: formatter.formatStep(evaluation, this.bestEffortConfig()) };
          } catch (err: unknown) {
            return { text: formatter.formatError(err), isError: true };
          }
        });
      }

      case "perfgym_rollback": {
        return this.withCoordinator(async (coordinator) => {
          try {
            const outcome = await coordinator.handleRollback();
            return {
              text: this.renderMessage(
                formatter,
                outcome.message,
              ),
            };
          } catch (err: unknown) {
            // Sessions without a baseline record or step history were always
            // roll-able via a bare working-tree reset, while the coordinator
            // refuses them by design ("No baseline found…/No step history…").
            // Keep that legacy path so uninitialized workspaces still reset.
            const msg = err instanceof Error ? err.message : String(err);
            const uninitialized =
              msg.includes("No baseline found in .perfgym/state.json") ||
              msg.includes("No step history found");
            if (uninitialized) {
              return this.resetWorkingTree(formatter);
            }
            return { text: formatter.formatError(err), isError: true };
          }
        });
      }

      case "perfgym_status": {
        return this.withCoordinator(async (coordinator) => {
          try {
            const report = await coordinator.handleStatus();
            return {
              text:
                formatter.format === "markdown"
                  ? renderStatusMarkdown(report)
                  : JSON.stringify(report, null, 2),
            };
          } catch (err: unknown) {
            return { text: formatter.formatError(err), isError: true };
          }
        });
      }

      case "perfgym_test": {
        const command = typeof args.command === "string" ? args.command : undefined;
        const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
        const samples = typeof args.samples === "number" ? args.samples : undefined;

        return this.withCoordinator(async (coordinator) => {
          try {
            const result = await coordinator.handleTest({ command, timeoutMs, samples });
            return {
              text:
                formatter.format === "markdown"
                  ? renderTestMarkdown(result)
                  : JSON.stringify(result, null, 2),
            };
          } catch (err: unknown) {
            return { text: formatter.formatError(err), isError: true };
          }
        });
      }

      case "perfgym_lint": {
        const files = Array.isArray(args.files) ? (args.files as string[]) : undefined;

        return this.withCoordinator(async (coordinator) => {
          try {
            const outcome = await coordinator.handleLint({ files });
            return {
              text:
                formatter.format === "markdown"
                  ? renderLintMarkdown(outcome)
                  : JSON.stringify(outcome, null, 2),
            };
          } catch (err: unknown) {
            return { text: formatter.formatError(err), isError: true };
          }
        });
      }

      case "perfgym_benchmark": {
        const metric = typeof args.metric === "string" ? args.metric : undefined;
        const command = typeof args.command === "string" ? args.command : undefined;
        const samples = typeof args.samples === "number" ? args.samples : undefined;

        return this.withCoordinator(async (coordinator) => {
          try {
            const outcome = await coordinator.handleBenchmark({ metric, command, samples });
            return {
              text:
                formatter.format === "markdown"
                  ? renderBenchmarkMarkdown(outcome)
                  : JSON.stringify(outcome, null, 2),
            };
          } catch (err: unknown) {
            return { text: formatter.formatError(err), isError: true };
          }
        });
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Projects the baseline session into the per-tool payload. Kept at the
   * edge so the coordinator's BaselineOutcome works for both the freshly
   * recorded and the stored-report paths with today's exact output shape.
   */
  private projectBaseline(
    formatter: ReturnType<typeof createFormatter>,
    state: PerfGymState,
    distributions: Record<string, BenchmarkDistribution> | undefined,
  ): { text: string } {
    const config = this.bestEffortConfig();
    const primaryName = config?.metrics[0]?.name;
    const primaryDistribution =
      primaryName === undefined ? undefined : distributions?.[primaryName];

    if (formatter.format === "markdown") {
      const body =
        primaryDistribution === undefined
          ? "### 📊 Baseline Recorded"
          : formatter.formatBaseline(primaryDistribution, config);
      return {
        text: `${body}\n\n- **Target:** \`${state.targetName}\`\n- **Invariants:** ${
          state.invariantsPassed ? "✅ Passed" : "❌ Failed"
        }`,
      };
    }

    const baselineDoc =
      primaryDistribution === undefined
        ? { status: "BASELINE" }
        : (JSON.parse(formatter.formatBaseline(primaryDistribution, config)) as Record<
            string,
            unknown
          >);

    const document = {
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
    };

    return { text: JSON.stringify(document, null, 2) };
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

  /**
   * Legacy fallback for uninitialized workspaces: a bare reset to HEAD.
   * The coordinator owns rollback for real sessions (lock-aware); this path
   * only exists to preserve the pre-coordinator behaviour.
   */
  private resetWorkingTree(formatter: ReturnType<typeof createFormatter>): {
    text: string;
    isError?: boolean;
  } {
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
        text: this.renderMessage(
          formatter,
          "Rollback completed. Working tree restored to HEAD.",
        ),
      };
    } catch (err: unknown) {
      return {
        text: formatter.formatError(
          new Error(`Rollback failed: ${err instanceof Error ? err.message : String(err)}`)
        ),
        isError: true,
      };
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
