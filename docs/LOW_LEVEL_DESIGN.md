# 📐 PerfGym Low-Level Design (LLD) Specifications & Diagrams

This document specifies the low-level architecture, class structures, execution sequences, state machines, and data schemas for all four core subsystems of **PerfGym**.

---

## 📑 Table of Contents
1. [Core Architectural Principles](#1-core-architectural-principles)
2. [Feature 1: Workspace Sandbox & Rollback Sentinel](#2-feature-1-workspace-sandbox--rollback-sentinel)
3. [Feature 2: AST Pattern Linter & Anti-Cheating Gate](#3-feature-2-ast-pattern-linter--anti-cheating-gate)
4. [Feature 3: Invariant & Deterministic Fitness Pipeline](#4-feature-3-invariant--deterministic-fitness-pipeline)
5. [Feature 4: CLI Runner, Agent MCP Server & Autonomous Loop](#5-feature-4-cli-runner-agent-mcp-server--autonomous-loop)
6. [Cross-Cutting Data Schemas (Markdown & JSON Mode)](#6-cross-cutting-data-schemas-markdown--json-mode)

---

## 1. Core Architectural Principles

PerfGym follows the **Deep Module Design** pattern:
- **Small Interface, Deep Implementation:** Callers (CLI commands or AI agents via MCP) invoke concise methods (`baseline()`, `step()`). Complex worktree coordination, sub-30ms git rollbacks, AST parsing, and statistical percentile calculations remain private.
- **Explicit Seams with Dual Concrete Adapters:**
  - `WorkspaceDriver`: `GitWorktreeDriver` (production) & `InMemorySandboxDriver` (unit tests).
  - `TypecheckDriver`: `BiomeSyntaxDriver` (per-step fast tier) & `TscProjectDriver` (pre-promotion full tier).
  - `LinterEngine`: `AstGrepNapiDriver` (in-process Rust binding) & `FallbackPatternDriver` (regex fallback).
  - `MetricCollector`: `SubprocessMetricDriver` (standard shell runner) & `InstructionCounterDriver` (Linux perf/V8 profiler).

---

## 2. Feature 1: Workspace Sandbox & Rollback Sentinel

### 2.1 Low-Level Class Diagram
```mermaid
classDiagram
    class WorkspaceDriver {
        <<interface>>
        +initialize(runId: string, baseRef: string) Promise~WorkspaceContext~
        +writeFile(relPath: string, content: string) Promise~void~
        +readFile(relPath: string) Promise~string~
        +assertPathWhitelisted(relPath: string) void
        +commitStep(stepNumber: number, fitnessScore: number) Promise~string~
        +rollbackStep() Promise~void~
        +promote(targetBranch: string) Promise~void~
        +teardown() Promise~void~
        +getWorkingDir() string
    }

    class GitWorktreeDriver {
        -rootDir: string
        -worktreeDir: string
        -branchName: string
        -baseRef: string
        -allowedGlobs: string[]
        -execGit(args: string[]) Promise~GitResult~
        +initialize(runId: string, baseRef: string) Promise~WorkspaceContext~
        +writeFile(relPath: string, content: string) Promise~void~
        +readFile(relPath: string) Promise~string~
        +assertPathWhitelisted(relPath: string) void
        +commitStep(stepNumber: number, fitnessScore: number) Promise~string~
        +rollbackStep() Promise~void~
        +promote(targetBranch: string) Promise~void~
        +teardown() Promise~void~
        +getWorkingDir() string
    }

    class InMemorySandboxDriver {
        -virtualFs: Map~string, string~
        -commitStack: Map~string, string~[]
        -workingDir: string
        -allowedGlobs: string[]
        +initialize(runId: string, baseRef: string) Promise~WorkspaceContext~
        +writeFile(relPath: string, content: string) Promise~void~
        +readFile(relPath: string) Promise~string~
        +assertPathWhitelisted(relPath: string) void
        +commitStep(stepNumber: number, fitnessScore: number) Promise~string~
        +rollbackStep() Promise~void~
        +promote(targetBranch: string) Promise~void~
        +teardown() Promise~void~
        +getWorkingDir() string
    }

    class GitSandboxCoordinator {
        -driver: WorkspaceDriver
        -lockDirPath: string
        -heartbeatTimer: any
        -activeContext: WorkspaceContext | null
        +acquire(runId: string, baseRef?: string) Promise~WorkspaceContext~
        +applyMutation(files: MutationFile[]) Promise~void~
        +acceptStep(stepNumber: number, score: number) Promise~StepReceipt~
        +rejectStep() Promise~void~
        +promoteAndCleanup(targetBranch: string) Promise~void~
        -acquireAtomicLock(runId: string) Promise~void~
        -checkAndReclaimStaleLock() Promise~boolean~
        -startHeartbeat(runId: string) void
        -releaseAtomicLock() Promise~void~
    }

    WorkspaceDriver <|.. GitWorktreeDriver : implements
    WorkspaceDriver <|.. InMemorySandboxDriver : implements
    GitSandboxCoordinator --> WorkspaceDriver : delegates via seam
```

### 2.2 Sequence Diagram: Mutation, Step Evaluation & Rollback
```mermaid
sequenceDiagram
    autonumber
    actor Agent as AI Agent (MCP / CLI)
    participant Coord as GitSandboxCoordinator
    participant Driver as GitWorktreeDriver
    participant OS as Local FileSystem / Git

    Agent->>Coord: acquire(runId: "run-402")
    Coord->>OS: Atomic mkdir .perfgym/.lock.d/ (O_EXCL semantics)
    opt If lock exists
        Coord->>OS: Check lock metadata (PID, heartbeat). Is PID alive?
        alt PID dead or heartbeat > 30s
            Coord->>OS: Break stale lock, run git worktree prune, reclaim
        else PID active
            Coord-->>Agent: Throw ERR_SANDBOX_LOCKED (busy)
        end
    end
    Coord->>Driver: initialize("run-402", "HEAD")
    Driver->>OS: git worktree add .perfgym/worktrees/run-402 HEAD
    Driver->>OS: git checkout -b perfgym/eval-run-402
    Driver-->>Coord: WorkspaceContext { worktreeDir, branch }
    Coord-->>Agent: Ready

    Note over Agent, OS: Mutation Phase (Iteration 1)
    Agent->>Coord: applyMutation([{ path: "src/calc.ts", content: "..." }])
    Coord->>Driver: writeFile("src/calc.ts", content)
    Driver->>Driver: assertPathWhitelisted("src/calc.ts")
    Driver->>OS: fs.writeFileSync(worktreeDir + "/src/calc.ts")
    
    Note over Agent, OS: Evaluation Phase (Regression detected)
    Agent->>Coord: rejectStep()
    Coord->>Driver: rollbackStep()
    Driver->>OS: git reset --hard HEAD
    Driver->>OS: git clean -ffd (removes untracked ignored poison files)
    Driver->>OS: git submodule foreach --recursive git reset --hard
    Note over Driver, OS: Rollback completes in <30ms; worktree clean
    Coord-->>Agent: Rollback verified

    Note over Agent, OS: Mutation Phase (Iteration 2 - Valid Speedup)
    Agent->>Coord: applyMutation([{ path: "src/calc.ts", content: "..." }])
    Coord->>Driver: writeFile("src/calc.ts", content)
    Agent->>Coord: acceptStep(step: 2, score: 28.5)
    Coord->>Driver: commitStep(step: 2, score: 28.5)
    Driver->>OS: git add -A
    Driver->>OS: git commit -m "perfgym(step 2): +28.5% fitness"
    Driver-->>Coord: commitSha: "a9f3b1c"
    Coord-->>Agent: StepReceipt { commitSha, step: 2, status: "COMMITTED" }
```

### 2.3 State Machine: Workspace Sandbox Lifecycle
```mermaid
stateDiagram-v2
    [*] --> Idle
    Idle --> Locked : acquire() [Creates .perfgym/sandbox.lock]
    Locked --> WorktreeActive : git worktree add HEAD
    
    state WorktreeActive {
        [*] --> BaselineClean
        BaselineClean --> Mutating : applyMutation(files)
        Mutating --> Evaluating : run pipeline
        Evaluating --> BaselineClean : rejectStep() [git reset --hard && git clean -fd]
        Evaluating --> StepCommitted : acceptStep() [git commit -am "step"]
        StepCommitted --> Mutating : next iteration
    }

    WorktreeActive --> Promoting : promoteAndCleanup()
    Promoting --> Teardown : git merge / cherry-pick
    Teardown --> Idle : git worktree remove & release lockfile
    Idle --> [*]
```

---

## 3. Feature 2: AST Pattern Linter & Anti-Cheating Gate

### 3.1 Low-Level Class Diagram
```mermaid
classDiagram
    class RuleDefinition {
        +id: string
        +message: string
        +severity: "error" | "warning"
        +penalty: number
        +action: "disqualify" | "penalize"
        +pattern: string
        +language: string
    }

    class RuleMatch {
        +ruleId: string
        +file: string
        +line: number
        +column: number
        +codeSnippet: string
        +penalty: number
        +action: "disqualify" | "penalize"
    }

    class LintResult {
        +passed: boolean
        +disqualified: boolean
        +disqualificationReason: string | null
        +totalPenalty: number
        +matches: RuleMatch[]
    }

    class AstLinterEngine {
        -rules: RuleDefinition[]
        -napiBindings: AstGrepBinding
        +loadRules(config: PerfgymConfig) Promise~void~
        +scan(files: string[], workingDir: string) Promise~LintResult~
        +scanString(content: string, language: string) RuleMatch[]
    }

    class TwoTierTypechecker {
        -fastScanner: FastSyntaxScanner
        -integrityGuard: ConfigIntegrityGuard
        -tscRunner: TscProjectRunner
        +checkStep(files: string[], workingDir: string) Promise~TypecheckResult~
        +checkPromotion(workingDir: string) Promise~TypecheckResult~
    }

    class ConfigIntegrityGuard {
        -baselineHashes: Map~string, string~
        +snapshotBaseline(workingDir: string) void
        +verifyIntegrity(workingDir: string) IntegrityResult
    }

    AstLinterEngine --> RuleDefinition : contains
    AstLinterEngine --> LintResult : returns
    LintResult --> RuleMatch : contains
    TwoTierTypechecker --> AstLinterEngine : coordinates with
    TwoTierTypechecker --> ConfigIntegrityGuard : verifies configs
```

### 3.2 Sequence Diagram: Two-Tier Typecheck & Anti-Cheating Verification
```mermaid
sequenceDiagram
    autonumber
    participant Pipeline as EvaluationPipeline
    participant TypeGate as TwoTierTypechecker
    participant Guard as ConfigIntegrityGuard
    participant Linter as AstLinterEngine
    participant Napi as @ast-grep/napi (Rust/C++ in-process)

    Pipeline->>TypeGate: checkStep(modifiedFiles, worktreeDir)
    
    Note over TypeGate, Guard: Integrity Gate: verify tsconfig.json & test files
    TypeGate->>Guard: verifyIntegrity(worktreeDir)
    alt Hash mismatch in tsconfig.json or tests
        Guard-->>TypeGate: Tampering detected
        TypeGate-->>Pipeline: TypecheckResult { passed: false, disqualified: true, reason: "Integrity violation: tsconfig/tests modified" }
        Note over Pipeline: Immediately aborts pipeline; Score = -Infinity
    end

    Note over TypeGate: Tier 1: Fast Syntax, Dynamic Eval & Suppression Scan (<50ms)
    TypeGate->>Napi: scanForPatterns("// @ts-ignore", "// @ts-nocheck", "as any", "eval($$$)", "Function($$$)")
    alt Type Suppression or Dynamic Eval Found & action == "disqualify"
        TypeGate-->>Pipeline: TypecheckResult { passed: false, disqualified: true, reason: "Forbidden @ts-ignore or dynamic eval" }
        Note over Pipeline: Immediately aborts pipeline; Score = -Infinity
    else Clean Syntax
        TypeGate-->>Pipeline: TypecheckResult { passed: true }
    end

    Pipeline->>Linter: scan(modifiedFiles, worktreeDir)
    Note over Linter, Napi: In-process AST Match (<10ms)
    loop For each rule in rules.yaml
        Linter->>Napi: matchPattern(astRoot, rule.pattern)
        Napi-->>Linter: matchNodes[]
    end
    Linter-->>Pipeline: LintResult { totalPenalty: 30, matches: [ ... ] }
```

---

## 4. Feature 3: Invariant & Deterministic Fitness Pipeline

### 4.1 Low-Level Class Diagram
```mermaid
classDiagram
    class BenchmarkDistribution {
        +samples: number[]
        +p50: number
        +p90: number
        +p95: number
        +p99: number
        +min: number
        +max: number
        +stddev: number
        +mad: number
        +iqr: number
        +sampleCount: number
        +unit: string
    }

    class StepEvaluation {
        +accepted: boolean
        +score: number
        +deltaPercent: number
        +isSignificant: boolean
        +invariantsPassed: boolean
        +invariantsRetriesUsed: number
        +tailGuardPassed: boolean
        +tailGuardReason: string | null
        +lintResult: LintResult
        +baselineDistribution: BenchmarkDistribution
        +currentDistribution: BenchmarkDistribution
        +executionTimeMs: number
        +stepReceipt: StepReceipt | null
    }

    class InvariantGate {
        -command: string
        -timeoutMs: number
        -maxRetries: number
        -frozenHarnessDir: string
        +run(workingDir: string) Promise~InvariantResult~
    }

    class BenchmarkRunner {
        -command: string
        -sampleCount: number
        -warmupCount: number
        -parser: MetricParser
        -frozenHarnessDir: string
        +run(workingDir: string) Promise~BenchmarkDistribution~
        -calculateMAD(samples: number[], median: number) number
    }

    class FitnessCalculator {
        -goal: "minimize" | "maximize"
        -minSignificanceDeltaPercent: number
        -madCeilingMultiplier: number
        +computeDelta(baseline: number, current: number) number
        +checkTailGuard(baseline: BenchmarkDistribution, current: BenchmarkDistribution) TailGuardResult
        +calculateScore(deltaPercent: number, lintResult: LintResult) number
    }

    class EvaluationPipeline {
        -invariantGate: InvariantGate
        -typechecker: TwoTierTypechecker
        -linter: AstLinterEngine
        -benchmarkRunner: BenchmarkRunner
        -fitnessCalculator: FitnessCalculator
        +evaluateStep(context: WorkspaceContext, files: string[]) Promise~StepEvaluation~
    }

    EvaluationPipeline --> InvariantGate
    EvaluationPipeline --> TwoTierTypechecker
    EvaluationPipeline --> AstLinterEngine
    EvaluationPipeline --> BenchmarkRunner
    EvaluationPipeline --> FitnessCalculator
    EvaluationPipeline --> StepEvaluation : produces
    BenchmarkRunner --> BenchmarkDistribution : produces
```

### 4.2 Sequence Diagram: 4-Stage Evaluation Cascade
```mermaid
sequenceDiagram
    autonumber
    participant Pipeline as EvaluationPipeline
    participant Invariants as InvariantGate
    participant TypeGate as TwoTierTypechecker
    participant Linter as AstLinterEngine
    participant Bench as BenchmarkRunner
    participant Calc as FitnessCalculator

    Note over Pipeline: Stage 1: Invariant Correctness Gate
    Pipeline->>Invariants: run(worktreeDir)
    alt Test Fails (exit code != 0)
        opt retries > 0
            Invariants->>Invariants: retry test command
        end
        alt Still Fails
            Invariants-->>Pipeline: InvariantResult { passed: false, error: "AssertionError" }
            Pipeline-->>Pipeline: Score = -Infinity; accepted = false
            Note over Pipeline: Abort immediately, return StepEvaluation
        end
    end
    Invariants-->>Pipeline: InvariantResult { passed: true }

    Note over Pipeline: Stage 2: Anti-Cheating & AST Linter
    Pipeline->>TypeGate: checkStep(files)
    TypeGate-->>Pipeline: Passed
    Pipeline->>Linter: scan(files)
    Linter-->>Pipeline: LintResult { totalPenalty: 10, disqualified: false }

    Note over Pipeline: Stage 3: Deterministic Benchmark Sampling
    Pipeline->>Bench: run(worktreeDir) [N=5 samples + 1 warmup]
    Bench-->>Pipeline: BenchmarkDistribution { p50: 12.1ms, p99: 15.0ms, max: 16.2ms }

    Note over Pipeline: Stage 4: Fitness & Tail Guard Calculation
    Pipeline->>Calc: checkTailGuard(baselineDist, currentDist)
    alt Tail Spike Exceeds Robust Ceiling (Current_p99 > Baseline_p50 + 3 * Baseline_MAD)
        Calc-->>Pipeline: TailGuardResult { passed: false, reason: "p99 degraded beyond 3*MAD ceiling" }
        Pipeline-->>Pipeline: accepted = false; Score = -Infinity
    else Tail Guard OK
        Calc-->>Pipeline: TailGuardResult { passed: true }
        Pipeline->>Calc: computeDelta(baselineDist.p50, currentDist.p50)
        Calc-->>Pipeline: deltaPercent = +28.0%
        alt deltaPercent < minSignificanceDelta (2.5%)
            Pipeline-->>Pipeline: Score = 0; accepted = false (Rejected: Insignificant noise gain)
        else Statistically Significant Win
            Pipeline->>Calc: calculateScore(deltaPercent: 28.0, totalPenalty: 10)
            Calc-->>Pipeline: score = +18.0
            Pipeline-->>Pipeline: accepted = (score > 0) -> true
        end
    end
```

---

## 5. Feature 4: CLI Runner, Agent MCP Server & Autonomous Loop

### 5.1 Low-Level Class Diagram
```mermaid
classDiagram
    class OutputFormatter {
        <<interface>>
        +formatStep(eval: StepEvaluation) string
        +formatBaseline(dist: BenchmarkDistribution) string
        +formatStatus(status: SessionStatus) string
    }

    class MarkdownFormatter {
        -negativeMemory: NegativeMemoryCache
        +formatStep(eval: StepEvaluation) string
        +formatBaseline(dist: BenchmarkDistribution) string
        +formatStatus(status: SessionStatus) string
    }

    class JsonFormatter {
        +formatStep(eval: StepEvaluation) string
        +formatBaseline(dist: BenchmarkDistribution) string
        +formatStatus(status: SessionStatus) string
    }

    class McpServerCoordinator {
        -pipeline: EvaluationPipeline
        -sandbox: GitSandboxCoordinator
        -formatter: OutputFormatter
        +handleBaseline(args: BaselineArgs) Promise~McpResponse~
        +handleStep(args: StepArgs) Promise~McpResponse~
        +handleStatus(args: StatusArgs) Promise~McpResponse~
        +handleTest(args: TestArgs) Promise~McpResponse~
        +handleLint(args: LintArgs) Promise~McpResponse~
        +handleBenchmark(args: BenchmarkArgs) Promise~McpResponse~
        +handleRollback(args: RollbackArgs) Promise~McpResponse~
    }

    class AutonomousHillClimbingRunner {
        -llmDriver: LlmDriver
        -pipeline: EvaluationPipeline
        -sandbox: GitSandboxCoordinator
        -feedbackSynthesizer: GradientFeedbackSynthesizer
        -negativeMemory: NegativeMemoryCache
        +runLoop(config: RunConfig) Promise~RunSummary~
        -generatePrompt(feedback: string, history: StepEvaluation[]) string
    }

    class LlmDriver {
        <<interface>>
        +complete(prompt: string, model: string) Promise~string~
    }

    class VercelAiSdkDriver {
        +complete(prompt: string, model: string) Promise~string~
    }

    class CliAgentSubprocessDriver {
        +complete(prompt: string, model: string) Promise~string~
    }

    OutputFormatter <|.. MarkdownFormatter : implements
    OutputFormatter <|.. JsonFormatter : implements
    LlmDriver <|.. VercelAiSdkDriver : implements
    LlmDriver <|.. CliAgentSubprocessDriver : implements
    McpServerCoordinator --> OutputFormatter
    AutonomousHillClimbingRunner --> LlmDriver
    AutonomousHillClimbingRunner --> OutputFormatter
```

### 5.2 Sequence Diagram: MCP Stdio Request vs Built-in Loop
```mermaid
sequenceDiagram
    autonumber
    actor ExternalAgent as External Agent (Claude / OpenCode)
    participant Mcp as McpServerCoordinator
    participant Pipeline as EvaluationPipeline
    participant Sandbox as GitSandboxCoordinator
    participant Format as OutputFormatter (Markdown / JSON)

    Note over ExternalAgent, Format: Flow A: External Agent via MCP
    ExternalAgent->>Mcp: callTool("perfgym_step", { format: "markdown", files: [...] })
    Mcp->>Sandbox: applyMutation(files)
    Mcp->>Pipeline: evaluateStep()
    alt Step Accepted (Score > 0)
        Pipeline->>Sandbox: acceptStep()
    else Step Rejected (Score <= 0 or Invariant Fail)
        Pipeline->>Sandbox: rejectStep() [Rollback]
    end
    Mcp->>Format: formatStep(stepEvaluation, format: "markdown")
    Format-->>Mcp: Rich Markdown Text (or JSON Schema)
    Mcp-->>ExternalAgent: ToolResult { content: [{ type: "text", text: "..." }] }

    Note over ExternalAgent, Format: Flow B: Built-in Autonomous Loop (perfgym run)
    actor Dev as Developer / CI
    participant Runner as AutonomousHillClimbingRunner
    participant LLM as LlmDriver (API / CLI)
    Dev->>Runner: perfgym run --iterations 15 --model "anthropic/claude-3-7-sonnet"
    loop For each iteration up to 15
        Runner->>LLM: complete(promptWithNegativeMemory)
        LLM-->>Runner: Code Diff / Mutation
        Runner->>Sandbox: applyMutation(diff)
        Runner->>Pipeline: evaluateStep()
        Runner->>Runner: updateNegativeMemory()
        alt Improvement plateau >= 3 steps
            Runner-->>Runner: early stop
        end
    end
    Runner->>Dev: RunSummary (Terminal Table / JSON)
```

---

## 6. Cross-Cutting Data Schemas (Markdown & JSON Mode)

Every CLI command and MCP response supports dual output formatting (`markdown` and `json`).

### 6.1 Step Evaluation Schema (JSON Mode)
When `--format json` or `{ "format": "json" }` is requested:

```json
{
  "status": "REVERTED",
  "accepted": false,
  "score": -12.4,
  "deltaPercent": -2.4,
  "isSignificant": false,
  "executionTimeMs": 340,
  "invariants": {
    "passed": true,
    "retriesUsed": 0,
    "command": "pnpm test:invariants",
    "durationMs": 85
  },
  "typecheck": {
    "passed": true,
    "tier": "fast-syntax",
    "disqualified": false
  },
  "linter": {
    "passed": false,
    "disqualified": false,
    "totalPenalty": 10,
    "matches": [
      {
        "ruleId": "no-await-in-loop",
        "file": "src/checkout/process.ts",
        "line": 42,
        "column": 9,
        "message": "Avoid serial awaits inside loops; use Promise.all or chunking.",
        "penalty": 10,
        "action": "penalize",
        "codeSnippet": "const item = await fetchItem(id);"
      }
    ]
  },
  "metrics": {
    "target": "latency_p50",
    "unit": "ms",
    "goal": "minimize",
    "baseline": {
      "p50": 42.1,
      "p90": 48.0,
      "p95": 51.2,
      "p99": 58.0,
      "min": 40.2,
      "max": 62.1,
      "stddev": 3.4,
      "mad": 1.2,
      "iqr": 2.1,
      "sampleCount": 5
    },
    "current": {
      "p50": 43.1,
      "p90": 49.2,
      "p95": 53.0,
      "p99": 61.2,
      "min": 41.0,
      "max": 65.4,
      "stddev": 4.1,
      "mad": 1.5,
      "iqr": 2.6,
      "sampleCount": 5
    },
    "tailGuard": {
      "passed": true,
      "madCeiling": 45.7,
      "rule": "Current_p99 <= Baseline_p50 + 3 * Baseline_MAD"
    }
  },
  "stepReceipt": null,
  "negativeMemoryGuidance": "Previously failed attempt in step 3 tried batching with 500 items, which exceeded socket pool timeout. Keep batch size <= 50."
}
```

### 6.2 Step Evaluation Schema (Markdown Mode)
When `--format markdown` (default) is requested:

```markdown
### ❌ [REVERTED] Mutation in `src/checkout/process.ts` (Score: -12.4)

The mutation degraded performance and violated AST performance guidelines. Your changes were safely rolled back in **24ms**.

#### 1. Invariants & Types
- **Unit / Invariant Tests:** ✅ 100% Passed (85ms)
- **Typecheck Gate:** ✅ Clean (no type suppressions)

#### 2. Performance Distribution (Baseline vs Mutation)
| Metric | Baseline | Current Mutation | Delta |
|---|---|---|---|
| **Median (p50)** | `42.1ms` | `43.1ms` | 🔻 **+2.4% slower** |
| **p95** | `51.2ms` | `53.0ms` | 🔻 `+3.5%` |
| **p99 (Tail)** | `58.0ms` | `61.2ms` | 🔻 `+5.5%` (Tail Guard passed) |
| **Max Spike** | `62.1ms` | `65.4ms` | 🔻 `+5.3%` |

#### 3. AST Pattern Violations (-10 Penalty Points)
- **`src/checkout/process.ts:42`** — `no-await-in-loop` (penalty: -10)
  ```ts
  42: const item = await fetchItem(id);
  ```
  *Recommendation: Batch IDs into `fetchItemsChunk([id1, id2])` or wrap with `Promise.all`.*

#### 4. Negative Memory & Next Action
- ⚠️ *Do not attempt serial awaits or loop lookups — this pattern regressed latency in steps 2 and 4.*
- 👉 *Next Direction: Optimize `process.ts` by pulling the query outside the loop using an in-memory hash map.*
```
