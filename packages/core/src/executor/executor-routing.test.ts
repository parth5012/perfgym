import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  type CommandCapabilities,
  type CommandExecutor,
  type ExecOptions,
  type ExecResult,
  type PerfGymConfig,
  type StepEvaluation,
  type WorkspaceContext,
  EvaluationPipeline,
  runInvariantGate,
  runBenchmark,
} from "../index.js";
import { AstLinterEngine, TypecheckGate } from "../../../linter/src/index.js";
import { CliAgentSubprocessDriver } from "../llm/cli-driver.js";
import { runOptimizationLoop } from "../../../cli/src/commands/run.js";

class RecordingStubExecutor implements CommandExecutor {
  readonly backend: string;
  readonly calls: Array<{ command: string; options?: ExecOptions }> = [];
  private readonly handler?: (command: string, options?: ExecOptions) => Promise<ExecResult> | ExecResult;

  constructor(
    backend = "stub-sandbox",
    handler?: (command: string, options?: ExecOptions) => Promise<ExecResult> | ExecResult
  ) {
    this.backend = backend;
    this.handler = handler;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ command, options });
    if (this.handler) {
      return this.handler(command, options);
    }
    return {
      code: 0,
      stdout: '{"value": 42}',
      stderr: "",
      durationMs: 10,
      timedOut: false,
      blocked: false,
      backend: this.backend,
    };
  }
}

const sampleConfig: PerfGymConfig = {
  version: "1.0",
  target: { name: "test-target", language: "typescript", files: ["src/**/*"] },
  invariants: { command: "npm test" },
  metrics: [{ name: "latency", command: "npm run bench", goal: "minimize", weight: 1 }],
};

const fakeContext: WorkspaceContext = {
  runId: "run-test",
  workingDir: process.cwd(),
  branchName: "test-branch",
  baseRef: "main",
};

describe("Ticket #58: CommandExecutor Routing & Blocked Semantics", () => {
  describe("AC1: All 4 command types route through CommandExecutor", () => {
    it("routes invariant/test command through CommandExecutor and declares capabilities", async () => {
      const stub = new RecordingStubExecutor();
      const exit = await Effect.runPromiseExit(
        runInvariantGate({
          command: "node -e 'console.log(\"invariants passed\")'",
          executor: stub,
        })
      );

      expect(exit._tag).toBe("Success");
      expect(stub.calls.length).toBeGreaterThanOrEqual(1);
      const call = stub.calls[0];
      expect(call.command).toContain("invariants passed");
      expect(call.options?.capabilities).toBeDefined();
      expect(call.options?.capabilities?.needsChildProcess).toBe(true);
      expect(call.options?.capabilities?.needsNetwork).toBe(false);
      expect(call.options?.capabilities?.readPaths).toBeDefined();
      expect(call.options?.capabilities?.writePaths).toBeDefined();
    });

    it("routes benchmark command through CommandExecutor and declares capabilities", async () => {
      const stub = new RecordingStubExecutor("stub-bench", async () => ({
        code: 0,
        stdout: '{"value": 100}',
        stderr: "",
        durationMs: 5,
        timedOut: false,
        blocked: false,
        backend: "stub-bench",
      }));

      const exit = await Effect.runPromiseExit(
        runBenchmark({
          command: "node -e 'console.log(JSON.stringify({value: 100}))'",
          samples: 1,
          warmup: 0,
          executor: stub,
        })
      );

      expect(exit._tag).toBe("Success");
      expect(stub.calls.length).toBeGreaterThanOrEqual(1);
      const call = stub.calls[0];
      expect(call.command).toContain("value: 100");
      expect(call.options?.capabilities).toBeDefined();
      expect(call.options?.capabilities?.needsNetwork).toBe(false);
      expect(call.options?.capabilities?.readPaths).toBeDefined();
    });

    it("routes typecheck command through CommandExecutor and declares capabilities", async () => {
      const stub = new RecordingStubExecutor("stub-typecheck");
      const gate = new TypecheckGate(process.cwd(), stub);

      const res = await gate.tier2Run(process.cwd(), stub);
      expect(stub.calls.length).toBeGreaterThanOrEqual(1);
      const call = stub.calls[0];
      expect(call.command).toContain("tsc");
      expect(call.options?.capabilities).toBeDefined();
      expect(call.options?.capabilities?.needsNetwork).toBe(false);
      expect(call.options?.capabilities?.writePaths).toEqual([]);
      expect(res.passed).toBe(true);
    });

    it("routes agent CLI driver through CommandExecutor and declares capabilities", async () => {
      const stub = new RecordingStubExecutor("stub-cli", async (_cmd, opts) => {
        expect(opts?.stdin).toBeDefined();
        return {
          code: 0,
          stdout: JSON.stringify({
            mutations: [{ path: "src/index.ts", content: "console.log('optimized');", rationale: "stub" }],
          }),
          stderr: "",
          durationMs: 20,
          timedOut: false,
          blocked: false,
          backend: "stub-cli",
        };
      });

      const driver = new CliAgentSubprocessDriver({
        cliCommand: "my-agent",
        cliArgs: ["run"],
        executor: stub,
      });

      const res = await driver.complete({ prompt: "Please optimize" });
      expect(stub.calls.length).toBe(1);
      const call = stub.calls[0];
      expect(call.command).toBe("my-agent run");
      expect(call.options?.capabilities?.needsNetwork).toBe(true);
      expect(call.options?.capabilities?.needsChildProcess).toBe(true);
      expect(res.mutations).toHaveLength(1);
    });
  });

  describe("AC2: Blocked invariant produces revertReason: 'sandbox-blocked'", () => {
    it("rejects step with revertReason: 'sandbox-blocked' and warns of denied capability", async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const stub = new RecordingStubExecutor("strict-sandbox", async () => ({
        code: null,
        stdout: "",
        stderr: "Backend 'strict-sandbox' policy denies network access (needsNetwork not granted)",
        durationMs: 0,
        timedOut: false,
        blocked: true,
        backend: "strict-sandbox",
      }));

      const linter = new AstLinterEngine([]);
      const pipeline = new EvaluationPipeline(sampleConfig, linter, null, stub);

      const step = await pipeline.evaluateStep(fakeContext, []);

      expect(step.accepted).toBe(false);
      expect(step.revertReason).toBe("sandbox-blocked");
      expect(step.invariants.blocked).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Backend 'strict-sandbox' policy denies network access")
      );
      warnSpy.mockRestore();
    });
  });

  describe("AC3: Blocked benchmark re-collected, all-blocked yields 'unmeasurable'", () => {
    it("re-collects a blocked benchmark sample within the sample budget", async () => {
      let callCount = 0;
      const stub = new RecordingStubExecutor("sample-sandbox", async () => {
        callCount++;
        if (callCount === 1) {
          // First measured sample is blocked
          return {
            code: null,
            stdout: "",
            stderr: "Operation denied by sandbox",
            durationMs: 0,
            timedOut: false,
            blocked: true,
            backend: "sample-sandbox",
          };
        }
        // Subsequent sample passes
        return {
          code: 0,
          stdout: '{"value": 50}',
          stderr: "",
          durationMs: 15,
          timedOut: false,
          blocked: false,
          backend: "sample-sandbox",
        };
      });

      const res = await Effect.runPromise(
        runBenchmark({
          command: "node -e 'console.log(JSON.stringify({value: 50}))'",
          samples: 1,
          warmup: 0,
          executor: stub,
        })
      );

      expect(res.sampleCount).toBe(1);
      expect(res.samples[0]).toBe(50);
      expect(callCount).toBe(2); // 1 blocked + 1 re-collected
    });

    it("yields 'unmeasurable' and rejects step when all benchmark samples are blocked (not scored 0)", async () => {
      const stub = new RecordingStubExecutor("block-all", async () => ({
        code: null,
        stdout: "",
        stderr: "Sandbox killed process (permission denied)",
        durationMs: 0,
        timedOut: false,
        blocked: true,
        backend: "block-all",
      }));

      const linter = new AstLinterEngine([]);
      // Config where invariants pass, but benchmark blocks
      const invStub = new RecordingStubExecutor("plain", async (cmd) => {
        if (cmd.includes("test")) {
          return {
            code: 0,
            stdout: "invariants pass",
            stderr: "",
            durationMs: 5,
            timedOut: false,
            blocked: false,
            backend: "plain",
          };
        }
        return stub.exec(cmd);
      });

      const pipeline = new EvaluationPipeline(sampleConfig, linter, null, invStub);
      const step = await pipeline.evaluateStep(fakeContext, [], { samples: 2 });

      expect(step.accepted).toBe(false);
      expect(step.revertReason).toBe("unmeasurable");
      expect(step.fitnessScore).toBe(-Infinity);
      expect(step.metrics).toEqual([]); // Not scored 0
    });
  });

  describe("AC4: Blocked agent CLI driver aborts the run", () => {
    it("marks result blocked when CLI driver execution is blocked", async () => {
      const stub = new RecordingStubExecutor("strict-sandbox", async () => ({
        code: null,
        stdout: "",
        stderr: "Backend policy denies child process execution",
        durationMs: 0,
        timedOut: false,
        blocked: true,
        backend: "strict-sandbox",
      }));

      const driver = new CliAgentSubprocessDriver({
        cliCommand: "agent-binary",
        executor: stub,
      });

      const res = await driver.complete({ prompt: "mutate code" });
      expect(res.skipped).toBe(true);
      expect(res.blocked).toBe(true);
      expect(res.error).toContain("blocked");
      expect(res.error).toContain("the driver could not start");
    });
  });

  describe("AC5: Run output names guarding backend", () => {
    it("reports guarding backend in evaluation invariants result", async () => {
      const stub = new RecordingStubExecutor("bwrap", async () => ({
        code: 0,
        stdout: '{"value": 10}',
        stderr: "",
        durationMs: 5,
        timedOut: false,
        blocked: false,
        backend: "bwrap",
      }));

      const linter = new AstLinterEngine([]);
      const pipeline = new EvaluationPipeline(sampleConfig, linter, null, stub);
      const step = await pipeline.evaluateStep(fakeContext, [], { samples: 1 });

      expect(step.invariants.backend).toBe("bwrap");
    });
  });
});
