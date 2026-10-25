import { describe, expect, it } from "vitest";
import * as Errors from "./errors.js";
import {
  BudgetExceededError,
  ConfigError,
  DisqualificationError,
  ERR_BUDGET_EXCEEDED,
  ERR_CONFIG,
  ERR_INVALID_RUN_ID,
  ERR_LLM_DRIVER,
  ERR_LLM_PARSE,
  ERR_SANDBOX_LOCK_NOT_HELD,
  ERR_WORKTREE_DISK_BUDGET_EXCEEDED,
  FileNotFoundError,
  GitCommandError,
  InsignificantDeltaError,
  InvariantFailureError,
  InvalidRunIdError,
  BenchmarkExecutionError,
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
  WorktreeDiskBudgetExceededError,
  WorktreeNotFoundError,
} from "./errors.js";

/** Structural shape every sample instance must satisfy (code/message sweep). */
type SampleError = {
  readonly _tag: string;
  readonly message?: unknown;
  readonly code?: unknown;
};

describe("new tagged error vocabulary (#49)", () => {
  it("builds SandboxLockNotHeldError as a tagged error with a stable code", () => {
    const err = new SandboxLockNotHeldError({
      code: ERR_SANDBOX_LOCK_NOT_HELD,
      operation: "applyMutation",
      message: "Cannot apply mutation without holding the sandbox lock (operation 'applyMutation').",
    });

    expect(err).toBeInstanceOf(SandboxLockNotHeldError);
    expect(err._tag).toBe("SandboxLockNotHeldError");
    expect(err.code).toBe(ERR_SANDBOX_LOCK_NOT_HELD);
    expect(err.operation).toBe("applyMutation");
    expect(err.message).toContain("applyMutation");
  });

  it("builds InvalidRunIdError as a tagged error with a stable code", () => {
    const err = new InvalidRunIdError({
      code: ERR_INVALID_RUN_ID,
      runId: "bad run id!",
      message: "Invalid runId 'bad run id!': must contain only alphanumeric characters.",
    });

    expect(err).toBeInstanceOf(InvalidRunIdError);
    expect(err._tag).toBe("InvalidRunIdError");
    expect(err.code).toBe(ERR_INVALID_RUN_ID);
    expect(err.runId).toBe("bad run id!");
    expect(err.message).toContain("bad run id!");
  });

  it("builds ConfigError as a tagged error with a stable code", () => {
    const err = new ConfigError({
      code: ERR_CONFIG,
      configPath: "/repo/.perfgym.yaml",
      reason: "missing",
      message: "Configuration file not found: /repo/.perfgym.yaml. Run 'perfgym init' first.",
    });

    expect(err).toBeInstanceOf(ConfigError);
    expect(err._tag).toBe("ConfigError");
    expect(err.code).toBe(ERR_CONFIG);
    expect(err.configPath).toBe("/repo/.perfgym.yaml");
    expect(err.reason).toBe("missing");
    expect(err.message).toContain("/repo/.perfgym.yaml");
  });

  it("builds LlmDriverError with provider, failure class and env var", () => {
    const err = new LlmDriverError({
      code: ERR_LLM_DRIVER,
      provider: "openai",
      failureClass: "auth",
      envVar: "OPENAI_API_KEY",
      message: "LLM provider 'openai' rejected the credentials. Set OPENAI_API_KEY.",
    });

    expect(err).toBeInstanceOf(LlmDriverError);
    expect(err._tag).toBe("LlmDriverError");
    expect(err.code).toBe(ERR_LLM_DRIVER);
    expect(err.provider).toBe("openai");
    expect(err.failureClass).toBe("auth");
    expect(err.envVar).toBe("OPENAI_API_KEY");
    expect(err.message).toContain("OPENAI_API_KEY");
  });

  it("restricts LlmDriverError failureClass to the four documented classes", () => {
    const classes = ["transient", "auth", "bad-request", "timeout"] as const;
    for (const failureClass of classes) {
      const err = new LlmDriverError({
        code: ERR_LLM_DRIVER,
        provider: "openai",
        failureClass,
        message: `failure: ${failureClass}`,
      });
      expect(err.failureClass).toBe(failureClass);
    }
  });

  it("builds LlmParseError as a tagged error with a stable code", () => {
    const err = new LlmParseError({
      code: ERR_LLM_PARSE,
      rawOutput: "{ not valid json",
      detail: "Unexpected token '{'",
      message: "Failed to parse structured LLM output: Unexpected token '{'",
    });

    expect(err).toBeInstanceOf(LlmParseError);
    expect(err._tag).toBe("LlmParseError");
    expect(err.code).toBe(ERR_LLM_PARSE);
    expect(err.rawOutput).toBe("{ not valid json");
    expect(err.detail).toBe("Unexpected token '{'");
    expect(err.message).toContain("Unexpected token '{'");
  });

  it("builds BudgetExceededError with the cap and the usage", () => {
    const err = new BudgetExceededError({
      code: ERR_BUDGET_EXCEEDED,
      metric: "cost",
      cap: 5,
      used: 5.5,
      message: "Cost cap exceeded: used 5.5 of 5 USD.",
    });

    expect(err).toBeInstanceOf(BudgetExceededError);
    expect(err._tag).toBe("BudgetExceededError");
    expect(err.code).toBe(ERR_BUDGET_EXCEEDED);
    expect(err.metric).toBe("cost");
    expect(err.cap).toBe(5);
    expect(err.used).toBe(5.5);
    expect(err.message).toContain("5.5");
  });

  it("builds WorktreeDiskBudgetExceededError with byte caps", () => {
    const err = new WorktreeDiskBudgetExceededError({
      code: ERR_WORKTREE_DISK_BUDGET_EXCEEDED,
      worktreeDir: "/repo/.perfgym/worktrees/run-42",
      capBytes: 1024,
      usedBytes: 2048,
      message: "Worktree disk budget exceeded: 2048 of 1024 bytes used.",
    });

    expect(err).toBeInstanceOf(WorktreeDiskBudgetExceededError);
    expect(err._tag).toBe("WorktreeDiskBudgetExceededError");
    expect(err.code).toBe(ERR_WORKTREE_DISK_BUDGET_EXCEEDED);
    expect(err.worktreeDir).toBe("/repo/.perfgym/worktrees/run-42");
    expect(err.capBytes).toBe(1024);
    expect(err.usedBytes).toBe(2048);
    expect(err.message).toContain("2048");
  });
});

describe("error vocabulary invariants", () => {
  // One representative instance per error class declared in errors.ts.
  const SAMPLES: ReadonlyArray<() => SampleError> = [
    () =>
      new PathTraversalError({
        code: Errors.ERR_PATH_TRAVERSAL,
        relPath: "src/../../etc/passwd",
        allowedGlobs: ["src/**"],
        message: "path traversal blocked",
      }),
    () =>
      new PathOutsideTargetError({
        code: Errors.ERR_PATH_OUTSIDE_TARGET,
        relPath: "secrets.env",
        allowedGlobs: ["src/**"],
        message: "path outside target",
      }),
    () =>
      new FileNotFoundError({
        code: Errors.ERR_FILE_NOT_FOUND,
        relPath: "src/missing.ts",
        message: "file not found",
      }),
    () =>
      new SandboxLockBusyError({
        lockDir: ".perfgym/lock",
        holderPid: 4242,
        startTime: 1_700_000_000_000,
        message: "sandbox lock busy",
      }),
    () =>
      new GitCommandError({
        command: "git status",
        exitCode: 128,
        stderr: "fatal: not a git repository",
        message: "git command failed",
      }),
    () =>
      new WorktreeNotFoundError({
        worktreeDir: "/repo/.perfgym/worktrees/run-1",
        message: "worktree not found",
      }),
    () =>
      new TamperingError({
        targetFile: "src/solution.ts",
        baselineHash: "aaa",
        currentHash: "bbb",
        message: "tampering detected",
      }),
    () =>
      new DisqualificationError({
        ruleId: "no-network",
        file: "src/solution.ts",
        line: 12,
        message: "disqualified",
      }),
    () =>
      new TypecheckError({
        tier: "fast-syntax",
        errors: ["TS1005: ';' expected."],
        message: "typecheck failed",
      }),
    () =>
      new InvariantFailureError({
        command: "pnpm test",
        exitCode: 1,
        stdout: "",
        stderr: "1 failed",
        retriesUsed: 0,
        message: "invariant failure",
      }),
    () =>
      new BenchmarkExecutionError({
        command: "pnpm bench",
        error: "exit code 1",
        message: "benchmark execution failed",
      }),
    () =>
      new TailGuardRegressionError({
        metric: "p99",
        currentP99: 150,
        maxAllowedCeiling: 120,
        baselineMad: 4,
        message: "tail guard regression",
      }),
    () =>
      new InsignificantDeltaError({
        deltaPercent: 0.4,
        minSignificanceThreshold: 2,
        message: "insignificant delta",
      }),
    () =>
      new UnknownDriverError({
        driverName: "carrier-pigeon",
        message: "unknown llm driver",
      }),
    () =>
      new MissingApiKeyError({
        provider: "openai",
        envVar: "OPENAI_API_KEY",
        message: "missing api key",
      }),
    () =>
      new LlmFatalError({
        provider: "openai",
        reason: "model deprecated",
        message: "llm fatal error",
      }),
    () =>
      new SessionFlushError({
        code: Errors.ERR_SESSION_FLUSH,
        filePath: ".perfgym/state.json",
        message: "session flush failed",
      }),
    () =>
      new SandboxLockNotHeldError({
        code: ERR_SANDBOX_LOCK_NOT_HELD,
        operation: "acceptStep",
        message: "lock not held",
      }),
    () =>
      new InvalidRunIdError({
        code: ERR_INVALID_RUN_ID,
        runId: "bad!",
        message: "invalid run id",
      }),
    () =>
      new ConfigError({
        code: ERR_CONFIG,
        configPath: ".perfgym.yaml",
        reason: "invalid",
        message: "invalid configuration",
      }),
    () =>
      new LlmDriverError({
        code: ERR_LLM_DRIVER,
        provider: "openai",
        failureClass: "timeout",
        message: "llm driver timeout",
      }),
    () =>
      new LlmParseError({
        code: ERR_LLM_PARSE,
        rawOutput: "nope",
        message: "llm parse failed",
      }),
    () =>
      new BudgetExceededError({
        code: ERR_BUDGET_EXCEEDED,
        metric: "tokens",
        cap: 1000,
        used: 1200,
        message: "token budget exceeded",
      }),
    () =>
      new WorktreeDiskBudgetExceededError({
        code: ERR_WORKTREE_DISK_BUDGET_EXCEEDED,
        worktreeDir: "/repo/.perfgym/worktrees/run-1",
        capBytes: 100,
        usedBytes: 200,
        message: "worktree disk budget exceeded",
      }),
  ];

  type ErrorCtorFn = Function & { readonly name: string };

  const exportedErrorClasses = Object.values(Errors).filter(
    (value) =>
      typeof value === "function" &&
      typeof (value as ErrorCtorFn).name === "string" &&
      (value as ErrorCtorFn).name.endsWith("Error")
  ) as readonly ErrorCtorFn[];

  it("has a sample for every error class exported from errors.ts", () => {
    const instances = SAMPLES.map((make) => make());

    expect(exportedErrorClasses.length).toBeGreaterThanOrEqual(SAMPLES.length);
    for (const cls of exportedErrorClasses) {
      expect(
        instances.some((instance) => instance instanceof cls),
        `no sample instance for ${cls.name}`
      ).toBe(true);
    }
  });

  it("gives every error a non-empty message", () => {
    for (const make of SAMPLES) {
      const instance = make();
      expect(typeof instance.message).toBe("string");
      expect((instance.message as string).length).toBeGreaterThan(0);
    }
  });

  it("gives every error a non-empty ERR_* code", () => {
    for (const make of SAMPLES) {
      const instance = make();
      expect(typeof instance.code).toBe("string");
      expect(instance.code as string).toMatch(/^ERR_[A-Z0-9_]+$/);
    }
  });
});
