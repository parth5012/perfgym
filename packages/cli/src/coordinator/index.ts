/**
 * McpServerCoordinator Deep Module
 * Ticket #43 — Shared coordinator between CLI and MCP Server.
 * All handlers return structured domain objects (NEVER formatted strings).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { Effect, Exit } from "effect";
import {
  type BenchmarkDistribution,
  type InvariantResult,
  type LintViolation,
  type MutationFile,
  type PerfGymConfig,
  type StepEvaluation,
  type WorkspaceContext,
  type WorkspaceDriver,
  type SessionLockState,
  type NegativeMemoryEntry,
  deserializeSessionState,
  serializeSessionState,
  EvaluationPipeline,
  GitSandboxCoordinator,
  InMemorySandboxDriver,
  runInvariantGate,
  runBenchmark,
  computeMetricResult,
  matchesGlob,
  SandboxLockBusyError,
} from "../../../core/src/index.js";
import {
  AstLinterEngine,
  TypecheckGate,
  DEFAULT_RULES,
  totalPenalty,
  parseAndMatch,
  type AstRule,
} from "../../../linter/src/index.js";
import {
  loadSession,
  saveSession,
  saveLiveSession,
  legacyStateCopy,
  loadConfig,
  loadNegativeMemory,
  negativeMemoryFilePath,
  recordNegativeMemory,
} from "../engine.js";
import { liveSessionFor, reflectSessionLock } from "../live-session.js";
import {
  type BaselineOutcome,
  type LintOutcome,
  type BenchmarkOutcome,
  type RollbackOutcome,
  type StatusReport,
  type LiveSessionReport,
  type StepHistoryEntry,
  type LockStateReport,
  type BaselineHandlerOptions,
  type StepHandlerOptions,
  type StatusHandlerOptions,
  type TestHandlerOptions,
  type LintHandlerOptions,
  type BenchmarkHandlerOptions,
  type RollbackHandlerOptions,
  type CoordinatorState,
  inspectLockState,
} from "./handlers.js";

export * from "./handlers.js";
export type { StepEvaluation, InvariantResult } from "../../../core/src/index.js";

export interface McpServerCoordinatorOptions {
  rootDir?: string;
  sandbox?: GitSandboxCoordinator;
  driver?: WorkspaceDriver;
  pipeline?: EvaluationPipeline;
  config?: PerfGymConfig;
  lockDir?: string;
  staleThresholdMs?: number;
}

export class McpServerCoordinator {
  private rootDir: string;
  private lockDir: string;
  private staleThresholdMs: number;
  private driver: WorkspaceDriver;
  private sandbox: GitSandboxCoordinator;
  private pipeline: EvaluationPipeline;
  private config: PerfGymConfig;
  private typecheckGate: TypecheckGate;
  private astLinter: AstLinterEngine;
  private history: StepHistoryEntry[] = [];
  private stepSnapshots: Map<number, Map<string, string>> = new Map();
  /** F8: pre-mutation host-disk state, restored when the step is rejected. */
  private pendingDiskBackup: {
    saved: Map<string, string>;
    created: string[];
  } | null = null;
  /** R3: host-disk files each step CREATED (for targeted rollback cleanup). */
  private stepCreatedPaths: Map<number, string[]> = new Map();

  constructor(options: McpServerCoordinatorOptions = {}) {
    this.rootDir = path.resolve(options.rootDir ?? process.cwd());
    this.staleThresholdMs = options.staleThresholdMs ?? 30_000;
    this.lockDir = path.resolve(
      options.lockDir ?? path.join(this.rootDir, ".perfgym", ".lock.d")
    );

    this.driver =
      options.driver ??
      new InMemorySandboxDriver({
        allowedGlobs: ["src/**/*"],
      });

    this.sandbox =
      options.sandbox ??
      new GitSandboxCoordinator(this.driver, {
        lockDir: this.lockDir,
        repoRoot: this.rootDir,
        staleThresholdMs: this.staleThresholdMs,
      });

    if (options.config) {
      this.config = options.config;
    } else {
      try {
        this.config = loadConfig(this.rootDir);
      } catch {
        this.config = {
          version: "1.0",
          target: { name: "default", language: "typescript", files: ["src/**/*"] },
          invariants: { command: "node -e 'process.exit(0)'" },
          metrics: [{ name: "latency", command: "node -e 'process.exit(0)'", goal: "minimize", weight: 1 }],
        };
      }
    }

    this.typecheckGate = new TypecheckGate();
    this.astLinter = new AstLinterEngine(this.config.rules ?? DEFAULT_RULES, this.rootDir);
    this.pipeline =
      options.pipeline ??
      new EvaluationPipeline(this.config, this.astLinter, this.typecheckGate);

    // Initial sync of driver files if running with in-memory driver on a real directory
    if (this.driver instanceof InMemorySandboxDriver) {
      const snap = this.driver.getFilesSnapshot();
      for (const [relPath, content] of snap.entries()) {
        this.syncDriverToDisk(relPath, content);
      }
    }
  }

  private syncDriverToDisk(relPath: string, content: string): void {
    const dir = this.getWorkingDir();
    if (dir && !dir.startsWith("/virtual/") && fs.existsSync(dir)) {
      const fullPath = path.resolve(dir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content, "utf8");
    }
  }

  /**
   * F8: records the pre-mutation on-disk state of affected files so a
   * rejected mutation never lingers on the host disk (the in-memory driver
   * reverts its own map, but someone has to put the disk back).
   */
  private backupDiskFiles(relPaths: readonly string[]): {
    saved: Map<string, string>;
    created: string[];
  } {
    const saved = new Map<string, string>();
    const created: string[] = [];
    const dir = this.getWorkingDir();
    if (dir && !dir.startsWith("/virtual/") && fs.existsSync(dir)) {
      for (const relPath of relPaths) {
        const full = path.resolve(dir, relPath);
        if (fs.existsSync(full)) {
          saved.set(relPath, fs.readFileSync(full, "utf8"));
        } else {
          created.push(relPath);
        }
      }
    }
    return { saved, created };
  }

  private restoreDiskFromBackup(): void {
    const backup = this.pendingDiskBackup;
    if (!backup) return;
    const dir = this.getWorkingDir();
    if (dir && !dir.startsWith("/virtual/") && fs.existsSync(dir)) {
      for (const [relPath, content] of backup.saved.entries()) {
        const full = path.resolve(dir, relPath);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, "utf8");
      }
      for (const relPath of backup.created) {
        const full = path.resolve(dir, relPath);
        if (fs.existsSync(full)) {
          fs.rmSync(full, { force: true });
          // Prune now-empty parent directories created by the mutation.
          let parent = path.dirname(full);
          while (parent !== dir && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
            fs.rmdirSync(parent);
            parent = path.dirname(parent);
          }
        }
      }
    }
    this.pendingDiskBackup = null;
  }

  /**
   * F8 companion / R3: deletes ONLY host-disk files a rolled-back step
   * CREATED (tracked per step via `backupDiskFiles`), plus pruning of the
   * empty directories they left behind. Pre-existing files are never deleted
   * merely for being absent from an in-memory snapshot — the snapshot only
   * mirrors driver-owned files, not the whole workspace.
   */
  private removeCreatedPathsAfter(restoredStep: number): void {
    const dir = this.getWorkingDir();
    if (!dir || dir.startsWith("/virtual/") || !fs.existsSync(dir)) return;
    for (const [stepNumber, created] of [...this.stepCreatedPaths.entries()]) {
      if (stepNumber <= restoredStep) continue;
      for (const relPath of created) {
        const full = path.resolve(dir, relPath);
        if (fs.existsSync(full)) {
          fs.rmSync(full, { force: true });
          // Prune now-empty parent directories created by the mutation.
          let parent = path.dirname(full);
          while (parent !== dir && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
            fs.rmdirSync(parent);
            parent = path.dirname(parent);
          }
        }
      }
      this.stepCreatedPaths.delete(stepNumber);
    }
  }

  public updateConfig(newConfig: PerfGymConfig): void {
    this.config = newConfig;
    this.astLinter = new AstLinterEngine(this.config.rules ?? DEFAULT_RULES, this.rootDir);
    this.pipeline = new EvaluationPipeline(this.config, this.astLinter, this.typecheckGate);
  }

  public getWorkingDir(): string {
    const ctx = this.sandbox.getContext();
    if (ctx && ctx.workingDir && !ctx.workingDir.startsWith("/virtual/")) {
      return ctx.workingDir;
    }
    return this.rootDir;
  }

  public getDriver(): WorkspaceDriver {
    return this.driver;
  }

  public getSandbox(): GitSandboxCoordinator {
    return this.sandbox;
  }

  private languageForFile(file: string): string {
    const ext = path.extname(file).toLowerCase();
    switch (ext) {
      case ".ts":
        return "typescript";
      case ".tsx":
        return "tsx";
      case ".js":
        return "javascript";
      case ".jsx":
        return "jsx";
      default:
        return "typescript";
    }
  }

  private discoverTargetFiles(dir: string): string[] {
    const matched: string[] = [];
    const patterns = this.config.target.files;

    const walk = (currentDir: string) => {
      if (!fs.existsSync(currentDir)) return;
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".perfgym") {
          continue;
        }
        const full = path.join(currentDir, entry.name);
        const rel = path.relative(dir, full).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          if (patterns.some((p) => matchesGlob(p, rel))) {
            matched.push(rel);
          }
        }
      }
    };

    walk(dir);
    return matched;
  }

  private async captureSnapshot(stepNumber: number): Promise<void> {
    const filesMap = new Map<string, string>();
    if (this.driver instanceof InMemorySandboxDriver) {
      const snap = this.driver.getFilesSnapshot();
      for (const [k, v] of snap.entries()) {
        filesMap.set(k, v);
        this.syncDriverToDisk(k, v);
      }
    } else {
      const targetFiles = this.discoverTargetFiles(this.getWorkingDir());
      for (const rel of targetFiles) {
        try {
          const content = fs.readFileSync(path.resolve(this.getWorkingDir(), rel), "utf8");
          filesMap.set(rel, content);
        } catch {
          // ignore
        }
      }
    }
    this.stepSnapshots.set(stepNumber, filesMap);
  }

  /**
   * Captures the worktree HEAD commit hash (git drivers) or a baseline
   * checkpoint reference (in-memory driver) so rollback can restore exactly
   * this state later (F2) — never a blind "HEAD" fallback.
   */
  private captureBaselineCommit(): string | undefined {
    const workingDir = this.getWorkingDir();
    if (this.driver instanceof InMemorySandboxDriver) {
      // checkpoint() pins lastCommittedFiles to the baseline content and
      // returns a stable pseudo-commit hash usable as a restore reference.
      return this.driver.checkpoint(0, 0);
    }
    if (fs.existsSync(path.join(workingDir, ".git"))) {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: workingDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * The serialized snapshot of the sandbox lock AS IT ACTUALLY IS (Ticket #48
   * review S1/S2): one reflective helper (`reflectSessionLock` in
   * live-session) fed this coordinator's REAL holder state — no site-local
   * duplication, no guessed `locked=true`.
   */
  private serializeLock(): SessionLockState | null {
    return reflectSessionLock(this.lockDir, this.sandbox.isLocked(), this.staleThresholdMs);
  }

  private async restoreSnapshot(
    stepNumber: number,
    targetCommit?: string,
    workingDirOverride?: string
  ): Promise<void> {
    const snap = this.stepSnapshots.get(stepNumber);
    if (this.driver instanceof InMemorySandboxDriver) {
      if (snap) {
        // F8: typed accessor — no untyped field pokes into core state.
        this.driver.restoreFullSnapshot(snap);
        // F8/R3: the host disk mirrors the driver; restore the snapshot files
        // AND drop exactly the files the undone steps created.
        for (const [relPath, content] of snap.entries()) {
          this.syncDriverToDisk(relPath, content);
        }
        this.removeCreatedPathsAfter(stepNumber);
      }
      return;
    }

    // Real workspace driver (e.g. GitWorktreeDriver): best-effort file restore
    // from the recorded snapshot, then an authoritative git restore. The
    // working dir is resolved by the CALLER (pre-acquire) — a fresh MCP-style
    // coordinator acquires its own lock/worktree, but the restore must hit
    // the developer's working tree (same semantics as the legacy bare reset).
    if (snap) {
      for (const [relPath, content] of snap.entries()) {
        await this.driver.writeFile(relPath, content);
      }
    }
    const workingDir = workingDirOverride ?? this.getWorkingDir();
    if (targetCommit && fs.existsSync(path.join(workingDir, ".git"))) {
      try {
        execFileSync("git", ["reset", "--hard", targetCommit], {
          cwd: workingDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
        execFileSync("git", ["clean", "-ffd"], {
          cwd: workingDir,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: unknown) {
        // F7: a failed git restore is a real failure — surface it instead of
        // reporting a rollback that never happened.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Rollback failed: git restore to '${targetCommit}' in '${workingDir}' did not complete (${msg}). The worktree may not match the requested state.`
        );
      }
    }
  }

  /**
   * handleStatus (read-only):
   * Reports session status, runId, baseRef, current step, best fitness score,
   * baseline metrics, current values, metric deltas, step history, negative memory,
   * and lock state. NEVER mutates state or writes to state file.
   *
   * Ticket #48: additionally reports the serialized live-session store view
   * (the run in progress), whose `history` feeds the status step table, plus
   * the state file's `lastUpdatedAt` stamp so a stale snapshot is visibly
   * stale instead of silently wrong.
   */
  public async handleStatus(_options: StatusHandlerOptions = {}): Promise<StatusReport> {
    const state = (loadSession(this.rootDir) as CoordinatorState) ?? null;
    const lockReport = inspectLockState(
      this.lockDir,
      this.sandbox.isLocked(),
      this.staleThresholdMs
    );

    if (!state) {
      return {
        initialized: false,
        sessionStatus: "not_initialized",
        runId: null,
        baseRef: "main",
        currentStep: 0,
        bestFitnessScore: null,
        bestStep: null,
        baselineMetrics: {},
        currentValues: {},
        metricDeltas: {},
        stepHistory: [],
        negativeMemory: [],
        lockState: lockReport,
        targetName: this.config?.target?.name,
        lastUpdatedAt: null,
        liveSession: null,
      };
    }

    const blob = state.session ? deserializeSessionState(state.session) : null;
    const liveSession: LiveSessionReport | null = blob
      ? {
          status: blob.status,
          runId: blob.runId,
          baseRef: blob.baseRef,
          currentStep: blob.currentStep,
          bestScore: Number.isFinite(blob.bestScore) ? blob.bestScore : null,
          bestStep: blob.bestStep,
          lastUpdatedAt: blob.lastUpdatedAt,
          lock: blob.lock,
          lastError: blob.lastError,
          history: blob.history,
        }
      : null;

    const history = state.history ?? this.history ?? [];
    // The rewind-aware pointer stays legacy-owned (a rollback rewinds it);
    // the live blob's own pointer is reported inside `liveSession`.
    const currentStep = state.totalStepCount ?? 0;
    const bestFitnessScore = Number.isFinite(state.bestFitnessScore)
      ? state.bestFitnessScore
      : null;
    const bestStep =
      state.bestStep ??
      (state.acceptedStepCount > 0
        ? history.find((h) => h.score === bestFitnessScore)?.stepNumber ?? null
        : null);

    const baselineMetrics = state.baselineMetrics ?? {};
    const currentValues = state.currentMetrics ?? state.baselineMetrics ?? {};
    const metricDeltas = state.metricDeltas ?? {};

    let negativeMemoryEntries: NegativeMemoryEntry[] = [];
    try {
      negativeMemoryEntries = loadNegativeMemory(
        this.rootDir,
        this.config.target.name,
        this.config.agentBudget?.negativeMemorySize
      ).entries();
    } catch {
      negativeMemoryEntries = [];
    }

    // #48: a live session drives the session status; the lock only shades it.
    let sessionStatus: "running" | "idle" | "completed";
    if (liveSession) {
      if (liveSession.status === "completed") {
        sessionStatus = "completed";
      } else if (liveSession.status === "idle" && !this.sandbox.isLocked()) {
        sessionStatus = "idle";
      } else {
        sessionStatus = "running";
      }
    } else {
      sessionStatus = this.sandbox.isLocked() ? "running" : "idle";
    }

    return {
      initialized: true,
      sessionStatus,
      runId: this.sandbox.getContext()?.runId ?? null,
      baseRef: this.sandbox.getContext()?.baseRef ?? "main",
      currentStep,
      bestFitnessScore,
      bestStep,
      baselineMetrics,
      currentValues,
      metricDeltas,
      stepHistory: history,
      negativeMemory: negativeMemoryEntries,
      lockState: lockReport,
      targetName: state.targetName,
      lastUpdatedAt: state.lastUpdatedAt ?? null,
      liveSession,
    };
  }

  /**
   * handleBaseline:
   * Runs invariant gate + baseline benchmark distributions under lock protection.
   * Records baseline metrics and returns structured BaselineOutcome.
   */
  public async handleBaseline(options: BaselineHandlerOptions = {}): Promise<BaselineOutcome> {
    const cwd = options.cwd ?? this.getWorkingDir();
    const samples = options.samples ?? 5;

    // Check lock
    const lockReport = inspectLockState(
      this.lockDir,
      this.sandbox.isLocked(),
      this.staleThresholdMs
    );
    if (lockReport.locked && !this.sandbox.isLocked() && !lockReport.isStale) {
      throw new SandboxLockBusyError({
        lockDir: this.lockDir,
        holderPid: lockReport.pid ?? 0,
        startTime: lockReport.startTime ?? Date.now(),
        message: `Cannot run baseline: sandbox lock busy (held by PID ${lockReport.pid}, runId ${lockReport.runId})`,
      });
    }

    // CR4 (CodeRabbit review of PR #83): the fallback runId is computed ONCE
    // — two independent `baseline-${Date.now()}` evaluations could differ,
    // mismatching the lock metadata's runId against the live session's.
    const runId = options.runId ?? `baseline-${Date.now()}`;
    if (!this.sandbox.isLocked()) {
      await this.sandbox.acquire(runId, "main");
    }
    // CR3: the live session does NOT begin here. A state file written before
    // the invariant gate and benchmarks would survive their failure as a fake
    // "initialized" session (undoing #46's B1 guarantee). The live run begins
    // after `saveSession` has written the REAL baseline below.

    // F2: capture the baseline commit reference under lock, BEFORE any step
    // work. `handleRollback` with no accepted steps restores exactly this
    // commit instead of a blind "HEAD" reset.
    const baselineCommit = this.captureBaselineCommit();

    // 1. Run invariant gate
    const invariantExit = await Effect.runPromiseExit(
      runInvariantGate({
        command: this.config.invariants.command,
        cwd,
        timeoutMs: this.config.invariants.timeoutMs,
      })
    );

    if (Exit.isFailure(invariantExit)) {
      throw new Error(`Invariant gate failed during baseline: ${invariantExit.cause}`);
    }

    const invariantRes = invariantExit.value;
    if (!invariantRes.passed) {
      throw new Error(`Invariant gate failed during baseline: ${invariantRes.output}`);
    }

    // 2. Measure baseline benchmark distributions
    const baselineMetrics: Record<string, number> = {};
    const baselineDistributions: Record<string, BenchmarkDistribution> = {};

    for (const metric of this.config.metrics) {
      const benchExit = await Effect.runPromiseExit(
        runBenchmark({
          command: metric.command,
          cwd,
          samples,
          unit: metric.unit ?? "count",
          ...(metric.timeoutMs !== undefined ? { timeoutMs: metric.timeoutMs } : {}),
        })
      );

      if (Exit.isFailure(benchExit)) {
        throw new Error(`Benchmark '${metric.name}' failed during baseline: ${benchExit.cause}`);
      }

      const dist = benchExit.value;
      baselineDistributions[metric.name] = dist;
      baselineMetrics[metric.name] = dist.p50;
    }

    const state: CoordinatorState = {
      version: this.config.version || "0.1.0",
      initializedAt: Date.now(),
      updatedAt: Date.now(),
      targetName: this.config.target.name,
      baselineMetrics,
      baselineDistributions,
      invariantsPassed: true,
      bestFitnessScore: 0,
      acceptedStepCount: 0,
      totalStepCount: 0,
      history: [],
      currentMetrics: { ...baselineMetrics },
      metricDeltas: Object.fromEntries(Object.keys(baselineMetrics).map((k) => [k, 0])),
      baselineCommit,
    };

    // Capture baseline snapshot (step 0)
    await this.captureSnapshot(0);

    // CR3 (review of PR #83): the REAL baseline is durably saved FIRST — only
    // then does the live session begin, so a failed invariant gate or
    // benchmark can never leave a fabricated "initialized" session behind
    // (the B1 guarantee of #46). The legacy snapshot carries no `session`
    // key: the blob is owned exclusively by the live-session path below.
    // The lock snapshot is reflective of the ALREADY-ACQUIRED lock (P2).
    // CR4: the same `runId` that acquired the lock backs the live session.
    saveSession(this.rootDir, legacyStateCopy(state));
    const live = liveSessionFor(this.rootDir);
    live.beginRun(runId, "main", this.serializeLock());
    const primaryDistribution = baselineDistributions[this.config.metrics[0]?.name ?? ""];
    if (primaryDistribution) {
      live.setBaseline(primaryDistribution);
    }
    this.history = [];

    return {
      targetName: this.config.target.name,
      invariantsPassed: true,
      baselineMetrics,
      distributions: baselineDistributions,
      state,
      commitHash: baselineCommit,
    };
  }

  /**
   * handleStep:
   * Applies candidate mutations, runs the 4-stage evaluation pipeline under lock protection,
   * commits or rolls back based on acceptance, updates state & history, and returns StepEvaluation.
   */
  public async handleStep(options: StepHandlerOptions = {}): Promise<StepEvaluation> {
    const cwd = options.cwd ?? this.getWorkingDir();
    const state = (loadSession(this.rootDir) as CoordinatorState) ?? null;
    if (!state) {
      throw new Error("No baseline found in .perfgym/state.json. Run 'perfgym baseline' first.");
    }

    // Check lock
    const lockReport = inspectLockState(
      this.lockDir,
      this.sandbox.isLocked(),
      this.staleThresholdMs
    );
    if (lockReport.locked && !this.sandbox.isLocked() && !lockReport.isStale) {
      throw new SandboxLockBusyError({
        lockDir: this.lockDir,
        holderPid: lockReport.pid ?? 0,
        startTime: lockReport.startTime ?? Date.now(),
        message: `Cannot evaluate step: sandbox lock busy (held by PID ${lockReport.pid}, runId ${lockReport.runId})`,
      });
    }

    if (!this.sandbox.isLocked()) {
      await this.sandbox.acquire(`step-${Date.now()}`, "main");
      // P2 (#46): serialize the metadata of the ALREADY-ACQUIRED lock —
      // reflective, no new locking protocol.
      liveSessionFor(this.rootDir).setLock(this.serializeLock());
    }
    const live = liveSessionFor(this.rootDir);
    live.setStatus("mutating");

    let modifiedFiles: string[] = [];
    if (options.mutations && options.mutations.length > 0) {
      // F8: record the pre-mutation host-disk state BEFORE anything is written,
      // so a rejection can put the disk back while the driver reverts its map.
      this.pendingDiskBackup = this.backupDiskFiles(options.mutations.map((m) => m.relPath));
      await this.sandbox.applyMutation(options.mutations);
      for (const m of options.mutations) {
        this.syncDriverToDisk(m.relPath, m.content);
      }
      modifiedFiles = options.mutations.map((m) => m.relPath);
    } else if (options.files && options.files.length > 0) {
      modifiedFiles = [...options.files];
    } else {
      modifiedFiles = this.discoverTargetFiles(cwd);
    }

    const rawContext = this.sandbox.getContext();
    const workingDir = this.getWorkingDir();
    const context: WorkspaceContext = {
      runId: rawContext?.runId ?? `step-${Date.now()}`,
      workingDir,
      branchName: rawContext?.branchName ?? "current",
      baseRef: rawContext?.baseRef ?? "HEAD",
    };

    const history = state.history ?? this.history ?? [];

    // Ticket #48: the live-session history participates in the monotonic
    // numbering — a previous run's live steps are never re-issued.
    const blobRows = deserializeSessionState(state.session)?.history ?? [];
    const maxBlobStep = blobRows.reduce((max, entry) => Math.max(max, entry.iteration), 0);

    // R2: step numbers are MONOTONIC — derived from the highest stepNumber
    // ever recorded in history, never from the (rewound) totalStepCount
    // pointer. Otherwise a rollback to the baseline would re-issue step
    // number 1 and break stepNumber-based lookups across the codebase.
    const nextIteration =
      history.length > 0
        ? Math.max(...history.map((h) => h.stepNumber), maxBlobStep) + 1
        : maxBlobStep + 1;

    const primaryMetricName = this.config.metrics[0]?.name;
    const primaryBaselineDist = primaryMetricName
      ? state.baselineDistributions?.[primaryMetricName]
      : undefined;

    live.setStatus("evaluating");
    const evaluation = await this.pipeline.evaluateStep(context, modifiedFiles, {
      baseline: primaryBaselineDist,
      baselineMetrics: state.baselineMetrics,
      iteration: nextIteration,
      samples: options.samples ?? 5,
      minSignificanceDelta: options.minDelta,
    });

    if (evaluation.accepted) {
      const receipt = await this.sandbox.acceptStep(
        evaluation.iteration,
        evaluation.fitnessScore
      );
      await this.captureSnapshot(evaluation.iteration);
      // R3: remember the host-disk files this accepted step CREATED so a later
      // rollback to an earlier step can remove exactly those.
      this.stepCreatedPaths.set(
        evaluation.iteration,
        this.pendingDiskBackup?.created.slice() ?? []
      );

      history.push({
        stepNumber: evaluation.iteration,
        score: evaluation.fitnessScore,
        status: "ACCEPTED",
        commitHash: receipt.commitHash,
        deltaPercent: evaluation.deltaPercent,
        // F3: carry the metric snapshot of this accepted step so a later
        // rollback can rewind currentValues/metricDeltas to it.
        metrics: Object.fromEntries(evaluation.metrics.map((m) => [m.name, m.value])),
        metricDeltas: Object.fromEntries(
          evaluation.metrics.map((m) => [m.name, m.deltaPercent])
        ),
        timestamp: Date.now(),
      });

      state.totalStepCount = evaluation.iteration;
      state.lastCommitHash = receipt.commitHash;
      state.updatedAt = Date.now();
      state.history = history;

      const currentMetrics: Record<string, number> = { ...(state.currentMetrics ?? {}) };
      const metricDeltas: Record<string, number> = { ...(state.metricDeltas ?? {}) };
      for (const m of evaluation.metrics) {
        currentMetrics[m.name] = m.value;
        metricDeltas[m.name] = m.deltaPercent;
      }
      state.currentMetrics = currentMetrics;
      state.metricDeltas = metricDeltas;

      // R5: every accepted step counts — the increment must not hide inside
      // the new-best branch (an accepted step scoring below the current best
      // still consumed a step and must be counted).
      state.acceptedStepCount = (state.acceptedStepCount ?? 0) + 1;
      if (evaluation.fitnessScore > state.bestFitnessScore) {
        state.bestFitnessScore = evaluation.fitnessScore;
        state.bestStep = evaluation.iteration;
      }

      saveSession(this.rootDir, legacyStateCopy(state));
      // Ticket #48: record the verdict through the store (accepted/rejected
      // status, history entry, bestScore/bestStep maintenance) — flushed.
      live.recordStep(evaluation);
      this.history = history;
      // F8: the mutation was accepted — the disk keeps it; drop the backup.
      this.pendingDiskBackup = null;
    } else {
      await this.sandbox.rejectStep();

      // F8: the driver map was reverted by rejectStep(); now put the HOST DISK
      // back to its pre-mutation state too.
      this.restoreDiskFromBackup();

      history.push({
        stepNumber: evaluation.iteration,
        score: evaluation.fitnessScore,
        status: "REJECTED",
        revertReason: evaluation.revertReason,
        deltaPercent: evaluation.deltaPercent,
        timestamp: Date.now(),
      });

      state.totalStepCount = evaluation.iteration;
      state.updatedAt = Date.now();
      state.history = history;
      saveSession(this.rootDir, legacyStateCopy(state));
      // Ticket #48: the rejected mutation was ROLLED BACK by rejectStep()
      // above — the history keeps the step but is marked so it no longer
      // claims the mutation is applied.
      live.recordStep(evaluation);
      live.markStepRolledBack(evaluation.iteration);
      this.history = history;

      if (options.recordNegativeMemory) {
        const cache = loadNegativeMemory(
          this.rootDir,
          this.config.target.name,
          this.config.agentBudget?.negativeMemorySize
        );
        // F1: the memory must fingerprint the FAILED CANDIDATE MUTATION. By
        // this point the rollback has already restored the pre-mutation
        // content, so reading from the driver would record the original code —
        // poison. Take the content from the mutation payload itself.
        const failedMutations = (options.mutations ?? []).map((m) => ({
          relPath: m.relPath,
          content: m.content,
        }));
        if (options.mutations && options.mutations.length > 0) {
          if (failedMutations.length > 0) {
            recordNegativeMemory(cache, {
              files: failedMutations,
              deltaPercent: evaluation.deltaPercent,
              reason: evaluation.revertReason,
              step: evaluation.iteration,
            });
            cache.save(negativeMemoryFilePath(this.rootDir));
          }
        } else {
          // No mutation payload (files-based step): the candidate lives on
          // disk and the coordinator never reverted it — read it as before.
          const mutatedRecords = await Promise.all(
            modifiedFiles.map(async (relPath) => {
              try {
                const content = await this.driver.readFile(relPath);
                return { relPath, content };
              } catch {
                try {
                  const content = fs.readFileSync(path.resolve(cwd, relPath), "utf8");
                  return { relPath, content };
                } catch {
                  return null;
                }
              }
            })
          );
          const validMutated = mutatedRecords.filter(
            (m): m is { relPath: string; content: string } => m !== null
          );
          if (validMutated.length > 0) {
            recordNegativeMemory(cache, {
              files: validMutated,
              deltaPercent: evaluation.deltaPercent,
              reason: evaluation.revertReason,
              step: evaluation.iteration,
            });
            cache.save(negativeMemoryFilePath(this.rootDir));
          }
        }
      }
    }

    return evaluation;
  }

  /**
   * handleTest (side-effect-free):
   * Runs invariant command and reports pass/fail + output + duration.
   * Leaves worktree and state untouched.
   */
  public async handleTest(options: TestHandlerOptions = {}): Promise<InvariantResult> {
    const command = options.command ?? this.config.invariants.command;
    const cwd = options.cwd ?? this.getWorkingDir();
    const timeoutMs = options.timeoutMs ?? this.config.invariants.timeoutMs;

    const exit = await Effect.runPromiseExit(
      runInvariantGate({
        command,
        cwd,
        timeoutMs,
      })
    );

    if (Exit.isFailure(exit)) {
      return {
        passed: false,
        output: `Invariant command failed: ${exit.cause}`,
        durationMs: 0,
      };
    }

    return exit.value;
  }

  /**
   * handleLint (side-effect-free):
   * AST linter + tier-1 typecheck over target files, reporting violations + total penalty.
   * Leaves worktree and state untouched.
   */
  public async handleLint(options: LintHandlerOptions = {}): Promise<LintOutcome> {
    const cwd = options.cwd ?? this.getWorkingDir();
    let files = options.files;

    if (!files || files.length === 0) {
      files = this.discoverTargetFiles(cwd);
    }

    const rules = options.rules ?? this.config.rules ?? DEFAULT_RULES;
    const violations: LintViolation[] = [];
    // R6: rule/parse failures must be visible — a broken rule silently
    // applying to nothing is not a clean scan (mirrors AstLinterEngine.scan).
    const scanErrors: string[] = [];

    for (const file of files) {
      let content: string | null = null;
      try {
        content = await this.driver.readFile(file);
      } catch {
        try {
          content = fs.readFileSync(path.resolve(cwd, file), "utf8");
        } catch {
          content = null;
        }
      }

      if (content === null) {
        continue;
      }

      // Tier 1 typecheck scan
      const tier1 = this.typecheckGate.tier1Scan([{ path: file, content }]);
      for (const v of tier1.violations) {
        violations.push(v);
      }

      // AST pattern matching
      const language = this.languageForFile(file);
      for (const rule of rules) {
        const lang = (rule as AstRule).language ?? language;
        const result = parseAndMatch(rule.pattern, content, lang);
        if (result.error) {
          // R6: collect the failure — do not pretend the rule ran.
          scanErrors.push(`Rule "${rule.id}" failed on ${file}: ${result.error}`);
          continue;
        }
        for (const match of result.matches) {
            violations.push({
              ruleId: rule.id,
              message: rule.message,
              file,
              line: match.line + 1,
              severity: rule.severity,
              penalty: rule.penalty,
              action: rule.action,
            });
          }
        }
    }

    const penalty = totalPenalty(violations);
    const errorCount = violations.filter((v) => v.severity === "error").length;
    const warningCount = violations.filter((v) => v.severity === "warning").length;
    const disqualified = violations.some((v) => v.action === "disqualify");

    return {
      passed: violations.length === 0 && scanErrors.length === 0,
      violations,
      totalPenalty: penalty,
      errorCount,
      warningCount,
      disqualified,
      scanErrors,
    };
  }

  /**
   * handleBenchmark (side-effect-free):
   * Runs metric command with same sample count/warm-up as the pipeline,
   * reporting distribution p50/p90/p95/p99, MAD, IQR and delta vs stored baseline
   * without updating state. Leaves worktree and state untouched.
   */
  public async handleBenchmark(
    options: BenchmarkHandlerOptions = {}
  ): Promise<BenchmarkOutcome> {
    const cwd = options.cwd ?? this.getWorkingDir();
    // R7: an unmatched explicit metric name must fail loudly — silently
    // benchmarking metrics[0] reports numbers for the wrong metric.
    let metricConfig = this.config.metrics[0];
    if (options.metric) {
      const requested = this.config.metrics.find((m) => m.name === options.metric);
      if (!requested) {
        throw new Error(
          `Unknown metric '${options.metric}'. Configured: ${this.config.metrics
            .map((m) => m.name)
            .join(", ")}`
        );
      }
      metricConfig = requested;
    }

    if (!metricConfig) {
      throw new Error("No metrics configured in PerfGym config.");
    }

    const command = options.command ?? metricConfig.command;
    const samples = options.samples ?? 5;

    const benchExit = await Effect.runPromiseExit(
      runBenchmark({
        command,
        cwd,
        samples,
        unit: metricConfig.unit ?? "count",
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : metricConfig.timeoutMs !== undefined
          ? { timeoutMs: metricConfig.timeoutMs }
          : {}),
      })
    );

    if (Exit.isFailure(benchExit)) {
      throw new Error(`Benchmark '${metricConfig.name}' failed: ${benchExit.cause}`);
    }

    const dist = benchExit.value;
    const state = loadSession(this.rootDir);
    const baselineValue = state?.baselineMetrics?.[metricConfig.name];
    const goal = metricConfig.goal ?? "minimize";

    let deltaPercent = 0;
    let improved = false;
    if (baselineValue !== undefined) {
      const res = computeMetricResult(
        metricConfig.name,
        baselineValue,
        dist.p50,
        metricConfig.unit ?? "count",
        goal
      );
      deltaPercent = res.deltaPercent;
      improved = res.improved;
    }

    return {
      metricName: metricConfig.name,
      distribution: dist,
      baselineValue,
      currentValue: dist.p50,
      deltaPercent,
      improved,
      unit: dist.unit,
    };
  }

  /**
   * handleRollback:
   * Restores worktree to last approved state (commit of most recent accepted/committed step;
   * if none, baseline commit). History log is KEPT; the rolled-back step is marked ROLLED_BACK
   * and the current-step pointer rewinds. Respects session lock — if another holder owns it,
   * refuses with an error whose message contains "lock busy".
   *
   * Ordering (F5): state pre-conditions are validated BEFORE the lock is
   * touched, so an uninitialized/empty-history rollback neither acquires nor
   * leaks the sandbox lock. When the rollback itself acquires the lock, it is
   * released again on success AND on failure (finally).
   */
  public async handleRollback(
    options: RollbackHandlerOptions = {}
  ): Promise<RollbackOutcome> {
    // 1. Read-only foreign-lock check FIRST (never acquires — a foreign live
    //    lock must refuse before any validation, preserving the "lock busy"
    //    contract for concurrent holders).
    const lockReport = inspectLockState(
      this.lockDir,
      this.sandbox.isLocked(),
      this.staleThresholdMs
    );
    if (lockReport.locked && !this.sandbox.isLocked() && !lockReport.isStale) {
      throw new SandboxLockBusyError({
        lockDir: this.lockDir,
        holderPid: lockReport.pid ?? 0,
        startTime: lockReport.startTime ?? Date.now(),
        message: `Cannot rollback: sandbox lock busy (held by PID ${lockReport.pid}, runId ${lockReport.runId})`,
      });
    }

    // 2. Pre-validate BEFORE acquiring (F5): every early return here happens
    //    without ever touching the lock.
    const state = (loadSession(this.rootDir) as CoordinatorState) ?? null;
    if (!state) {
      throw new Error("No baseline found in .perfgym/state.json. Cannot rollback uninitialized session.");
    }

    const history = state.history ?? this.history ?? [];
    if (history.length === 0) {
      throw new Error("No step history found. Nothing to rollback.");
    }

    // Identify the target entry by ARRAY INDEX (append order), not by
    // stepNumber equality (R2): stepNumber-based identity is fragile around
    // rewinds even with the monotonic numbering.
    let targetIndex: number | undefined;
    if (options.stepNumber !== undefined) {
      const idx = history.findIndex((h) => h.stepNumber === options.stepNumber);
      if (idx === -1) {
        throw new Error(`Step ${options.stepNumber} not found in history.`);
      }
      if (history[idx].status !== "ACCEPTED") {
        throw new Error(
          `Step ${history[idx].stepNumber} is ${history[idx].status}; only ACCEPTED (applied) steps can be rolled back.`
        );
      }
      targetIndex = idx;
    } else {
      // F6: the default target is the most recent ACCEPTED step not yet
      // rolled back. REJECTED steps were never applied, so undoing them is a
      // no-op masquerading as a rollback. With no accepted step left, the
      // rollback rewinds to the baseline instead.
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].status === "ACCEPTED") {
          targetIndex = i;
          break;
        }
      }
    }

    // R1 (cascade): rolling back step N restores the worktree to the latest
    // ACCEPTED step BEFORE N (or the baseline) and marks N AND every LATER
    // ACCEPTED step ROLLED_BACK — superseding steps were built on top of the
    // undone work, so leaving them "accepted" would leave the undone
    // mutation in the worktree while history claimed it was reverted.
    const updatedHistory = history.map((h, i) => {
      if (
        targetIndex !== undefined &&
        i >= targetIndex &&
        h.status === "ACCEPTED"
      ) {
        return {
          ...h,
          status: "ROLLED_BACK" as const,
        };
      }
      return h;
    });

    // Restore point: the most recent accepted step that survives the rollback
    // (strictly BEFORE the target), or the baseline when nothing applied remains.
    let restoredEntry: StepHistoryEntry | undefined;
    if (targetIndex !== undefined) {
      for (let i = targetIndex - 1; i >= 0; i--) {
        if (updatedHistory[i].status === "ACCEPTED") {
          restoredEntry = updatedHistory[i];
          break;
        }
      }
    }
    const restoredStep = restoredEntry ? restoredEntry.stepNumber : 0;
    const targetCommit = restoredEntry?.commitHash ?? state.baselineCommit;

    // R4: refuse to LIE. A fresh coordinator (e.g. a stateless MCP tool call)
    // carries no recorded file snapshots; when no snapshot exists for the
    // restored step AND no commit reference can restore it, marking history
    // ROLLED_BACK while restoring nothing would be a successful-looking
    // no-op. Refuse before any lock/state mutation instead.
    const hasSnapshot = this.stepSnapshots.has(restoredStep);
    if (this.driver instanceof InMemorySandboxDriver) {
      if (!hasSnapshot) {
        throw new Error(
          `Rollback failed: no file snapshot for restored step ${restoredStep} exists (fresh coordinator/session) — refusing to mark history ROLLED_BACK without restoring any workspace state.`
        );
      }
    } else if (!hasSnapshot && !targetCommit) {
      throw new Error(
        `Rollback failed: no file snapshot and no commit reference for restored step ${restoredStep} — refusing to report success without a restore.`
      );
    }

    // 3. Acquire (translating foreign busy errors into the reported message),
    //    run, and always release a lock acquired HERE (F5).
    const lockHeldBefore = this.sandbox.isLocked();
    if (!lockHeldBefore) {
      try {
        await this.sandbox.acquire(`rollback-${Date.now()}`, "main");
        // P2 (#46): serialize the metadata of the lock this rollback JUST
        // acquired (reflective; the lock file stays the authority).
        liveSessionFor(this.rootDir).setLock(this.serializeLock());
      } catch (err: unknown) {
        if (err instanceof SandboxLockBusyError || (err as any)?._tag === "SandboxLockBusyError") {
          throw new SandboxLockBusyError({
            lockDir: this.lockDir,
            holderPid: (err as any).holderPid ?? 0,
            startTime: (err as any).startTime ?? Date.now(),
            message: `Cannot rollback: sandbox lock busy. ${(err as any).message ?? ""}`,
          });
        }
        throw err;
      }
    }

    try {
      // Restore worktree / driver (F7: git failures surface as thrown errors).
      // The restore targets THIS coordinator's sandbox worktree (resolved
      // after acquire) — the developer's working directory is never touched
      // by a coordinator rollback (CLI parity).
      await this.restoreSnapshot(restoredStep, targetCommit);

      // F3: rewind current metrics/deltas to the restored state. Simplest
      // consistent approach: every ACCEPTED history entry carries the metric
      // values/deltas captured at accept time, so the restored step's snapshot
      // IS the correct tail; rewinding to baseline falls back to the stored
      // baseline values with zero deltas.
      const baselineMetrics = state.baselineMetrics ?? {};
      state.currentMetrics = restoredEntry?.metrics
        ? { ...restoredEntry.metrics }
        : { ...baselineMetrics };
      state.metricDeltas = restoredEntry?.metricDeltas
        ? { ...restoredEntry.metricDeltas }
        : Object.fromEntries(Object.keys(baselineMetrics).map((k) => [k, 0]));

      // F4: best fitness/step is the max over ALL remaining ACCEPTED entries,
      // not merely the most recent accepted one.
      const remainingAccepted = updatedHistory.filter((h) => h.status === "ACCEPTED");
      let bestScore = -Infinity;
      let bestStep: number | undefined = undefined;
      for (const h of remainingAccepted) {
        if (h.score > bestScore) {
          bestScore = h.score;
          bestStep = h.stepNumber;
        }
      }
      state.bestFitnessScore = remainingAccepted.length > 0 ? bestScore : 0;
      state.bestStep = bestStep;

      state.totalStepCount = restoredStep;
      state.acceptedStepCount = remainingAccepted.length;
      state.history = updatedHistory;
      state.updatedAt = Date.now();

      // Ticket #48: mirror the cascade into the live session when the blob
      // actually recorded the rolled-back step (a `perfgym run` blob uses its
      // own iteration space and is left untouched otherwise), then recompute
      // the live best from what still applies.
      // Obtain the live session handle before saveSession drops the unattached blob.
      const live = liveSessionFor(this.rootDir);
      const rollbackTargetStep = targetIndex !== undefined ? history[targetIndex].stepNumber : undefined;
      const willRollbackLive =
        targetIndex === undefined ||
        (rollbackTargetStep !== undefined &&
          live.state.history.some((entry) => entry.iteration === rollbackTargetStep));

      saveSession(this.rootDir, legacyStateCopy(state));
      this.history = updatedHistory;

      if (targetIndex === undefined) {
        live.markStepsRolledBackFrom(0);
        live.reconcileBest();
      } else if (willRollbackLive && rollbackTargetStep !== undefined) {
        live.markStepsRolledBackFrom(rollbackTargetStep);
        live.reconcileBest();
      } else {
        saveLiveSession(this.rootDir, serializeSessionState(live.state));
      }

      return {
        success: true,
        status: "ROLLED_BACK",
        rolledBackStep: targetIndex !== undefined ? history[targetIndex].stepNumber : 0,
        restoredStep,
        targetCommit,
        message: `Rollback completed. Restored worktree to step ${restoredStep}${
          targetCommit ? ` (${targetCommit})` : ""
        }.`,
      };
    } finally {
      // F5: a lock acquired by THIS rollback is released on success and on
      // failure alike; a lock held by the surrounding session stays held.
      if (!lockHeldBefore && this.sandbox.isLocked()) {
        await this.sandbox.release();
      }
      // The serialized lock snapshot follows the real one either way.
      if (!lockHeldBefore) {
        liveSessionFor(this.rootDir).setLock(this.serializeLock());
      }
    }
  }
}
