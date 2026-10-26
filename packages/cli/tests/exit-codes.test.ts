import { describe, expect, it } from "vitest";
import {
  BudgetExceededError,
  ConfigError,
  DisqualificationError,
  ERR_BUDGET_EXCEEDED,
  ERR_CONFIG,
  ERR_INVALID_RUN_ID,
  ERR_LLM_DRIVER,
  ERR_LLM_PARSE,
  ERR_PATH_OUTSIDE_TARGET,
  ERR_PATH_TRAVERSAL,
  ERR_SANDBOX_LOCK_NOT_HELD,
  ERR_SESSION_FLUSH,
  ERR_UNKNOWN_FORMAT,
  ERR_WORKTREE_DISK_BUDGET_EXCEEDED,
  FileNotFoundError,
  GitCommandError,
  InsignificantDeltaError,
  InvariantFailureError,
  InvalidRunIdError,
  LlmDriverError,
  LlmFatalError,
  LlmParseError,
  MissingApiKeyError,
  PathOutsideTargetError,
  PathTraversalError,
  SandboxLockBusyError,
  SandboxLockNotHeldError,
  SessionFlushError,
  TamperingError,
  TailGuardRegressionError,
  TypecheckError,
  UnknownDriverError,
  UnknownFormatError,
  WorktreeDiskBudgetExceededError,
  WorktreeNotFoundError,
  BenchmarkExecutionError,
} from "../../core/src/index.js";
import { exitCodeForError, renderStructuredError } from "../src/engine.js";
import { InvalidStepOptionError } from "../src/commands/lifecycle.js";

/**
 * Ticket #51 — the stable exit-code contract of the CLI/MCP edge.
 *
 * 0 success · 1 generic domain error · 2 usage/config · 3 lock busy ·
 * 4 sandbox/integrity violation · 5 external tool failure (git, tsc,
 * benchmark command).
 */
describe("exit-code contract (Ticket #51, AC1)", () => {
  it("maps every domain error class to its documented exit code", () => {
    const cases: ReadonlyArray<readonly [string, number, unknown]> = [
      // 2 — usage / config errors (bad args, missing config, missing API key)
      ["ConfigError", 2, new ConfigError({ code: ERR_CONFIG, configPath: ".perfgym.yaml", reason: "missing", message: "Configuration file not found" })],
      ["UnknownFormatError", 2, new UnknownFormatError({ code: ERR_UNKNOWN_FORMAT, format: "xml", message: "Unknown output format" })],
      ["MissingApiKeyError", 2, new MissingApiKeyError({ provider: "openai", envVar: "OPENAI_API_KEY", message: "Missing API key" })],
      ["UnknownDriverError", 2, new UnknownDriverError({ driverName: "nope", message: "Unknown driver" })],
      ["InvalidRunIdError", 2, new InvalidRunIdError({ code: ERR_INVALID_RUN_ID, runId: "../evil", message: "Invalid runId" })],
      ["InvalidStepOptionError", 2, new InvalidStepOptionError("0")],

      // 3 — the sandbox lock is held by someone else
      ["SandboxLockBusyError", 3, new SandboxLockBusyError({ lockDir: "/tmp/.lock.d", holderPid: 42, startTime: 1, message: "lock busy" })],

      // 4 — sandbox / integrity violations
      ["PathTraversalError", 4, new PathTraversalError({ code: ERR_PATH_TRAVERSAL, relPath: "../../etc/passwd", allowedGlobs: ["src/**"], message: "traversal" })],
      ["PathOutsideTargetError", 4, new PathOutsideTargetError({ code: ERR_PATH_OUTSIDE_TARGET, relPath: "secrets.ts", allowedGlobs: ["src/**"], message: "outside" })],
      ["TamperingError", 4, new TamperingError({ targetFile: "src/a.ts", baselineHash: "a", currentHash: "b", message: "tampered" })],
      ["DisqualificationError", 4, new DisqualificationError({ ruleId: "no-cheat", file: "src/a.ts", line: 3, message: "disqualified" })],
      ["WorktreeDiskBudgetExceededError", 4, new WorktreeDiskBudgetExceededError({ code: ERR_WORKTREE_DISK_BUDGET_EXCEEDED, worktreeDir: "/tmp/wt", capBytes: 10, usedBytes: 99, message: "disk budget" })],

      // 5 — external tool failures (git, tsc, benchmark / invariant command)
      ["GitCommandError", 5, new GitCommandError({ command: "git status", exitCode: 128, stderr: "boom", message: "git failed" })],
      ["WorktreeNotFoundError", 5, new WorktreeNotFoundError({ worktreeDir: "/tmp/wt", message: "worktree gone" })],
      ["TypecheckError", 5, new TypecheckError({ tier: "full-project", errors: ["TS2322"], message: "tsc failed" })],
      ["InvariantFailureError", 5, new InvariantFailureError({ command: "pnpm test", exitCode: 1, stdout: "", stderr: "", retriesUsed: 0, message: "invariants failed" })],
      ["BenchmarkExecutionError", 5, new BenchmarkExecutionError({ command: "node bench.js", error: "ENOENT", message: "benchmark failed" })],
      ["LlmDriverError", 5, new LlmDriverError({ code: ERR_LLM_DRIVER, provider: "openai", failureClass: "timeout", message: "provider timeout" })],
      ["LlmFatalError", 5, new LlmFatalError({ provider: "openai", reason: "unreachable", message: "fatal" })],

      // 1 — every other domain error is a generic domain failure
      ["FileNotFoundError", 1, new FileNotFoundError({ code: "ERR_FILE_NOT_FOUND", relPath: "src/a.ts", message: "missing" })],
      ["SandboxLockNotHeldError", 1, new SandboxLockNotHeldError({ code: ERR_SANDBOX_LOCK_NOT_HELD, operation: "applyMutation", message: "lock not held" })],
      ["TailGuardRegressionError", 1, new TailGuardRegressionError({ metric: "p99", currentP99: 10, maxAllowedCeiling: 5, baselineMad: 1, message: "tail regression" })],
      ["InsignificantDeltaError", 1, new InsignificantDeltaError({ deltaPercent: 0.1, minSignificanceThreshold: 2.5, message: "insignificant" })],
      ["LlmParseError", 1, new LlmParseError({ code: ERR_LLM_PARSE, rawOutput: "not json", message: "parse failed" })],
      ["BudgetExceededError", 1, new BudgetExceededError({ code: ERR_BUDGET_EXCEEDED, metric: "cost", cap: 1, used: 2, message: "budget" })],
      ["SessionFlushError", 1, new SessionFlushError({ code: ERR_SESSION_FLUSH, filePath: ".perfgym/state.json", message: "flush failed" })],
      ["plain Error", 1, new Error("boom")],
      ["unknown value", 1, "just a string"],
    ];

    for (const [label, expected, error] of cases) {
      expect(exitCodeForError(error), `${label} must map to exit code ${expected}`).toBe(expected);
    }
  });

  it("falls back to 1 for values that are not domain errors", () => {
    expect(exitCodeForError(undefined)).toBe(1);
    expect(exitCodeForError(null)).toBe(1);
    expect(exitCodeForError({ some: "object" })).toBe(1);
  });
});

describe("JSON error document (Ticket #51, AC2)", () => {
  it("renders code, kind, message and details — never a stack trace", () => {
    const raw = renderStructuredError(
      new PathTraversalError({
        code: ERR_PATH_TRAVERSAL,
        relPath: "../../etc/passwd",
        allowedGlobs: ["src/**/*"],
        message: "Security violation: path traversal.",
      }),
    );

    const doc = JSON.parse(raw) as { error: Record<string, unknown> };
    expect(doc.error).toMatchObject({
      code: "ERR_PATH_TRAVERSAL",
      kind: "PathTraversalError",
      message: "Security violation: path traversal.",
      details: { relPath: "../../etc/passwd", allowedGlobs: ["src/**/*"] },
    });

    // Never a stack trace: no frames, no `stack` key, no `name` leak.
    expect(raw).not.toMatch(/\bat \S+:\d+:\d+/);
    expect(raw.toLowerCase()).not.toContain("stack");
    expect(doc.error.stack).toBeUndefined();
  });

  it("renders a plain thrown error with the same four keys", () => {
    const error = new Error("boom");
    const doc = JSON.parse(renderStructuredError(error)) as { error: Record<string, unknown> };

    expect(doc.error).toMatchObject({
      code: "ERR_UNKNOWN",
      kind: "Error",
      message: "boom",
      details: {},
    });
    expect(doc.error.stack).toBeUndefined();
  });

  it("keeps ANSI out of the rendered document", () => {
    const doc = JSON.parse(
      renderStructuredError(new Error("\u001b[31mboom\u001b[0m")),
    ) as { error: { message: string } };
    expect(doc.error.message).toBe("boom");
  });
});
