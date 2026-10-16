# 🏛️ PerfGym Architecture Decision Records (ADRs)

This document records the architectural decisions, context, tradeoffs, and rationale established during the design and grilling sessions for **PerfGym**.

---

## ADR-001: Subsystem Wayfinder Maps Hierarchy
* **Status:** Accepted
* **Context:** Determining whether PerfGym's development roadmap should be a single monolithic issue map or broken down into subsystem-level maps.
* **Decision:** Split roadmap into 4 discrete Wayfinder Maps (one per core subsystem):
  1. Map 1 (#1): Workspace Sandbox & Rollback Sentinel
  2. Map 2 (#6): AST Pattern Linter & Anti-Cheating Gate
  3. Map 3 (#11): Invariant & Deterministic Fitness Pipeline
  4. Map 4 (#16): CLI Runner, Agent MCP Server & Autonomous Loop
* **Rationale:** Reduces coordination blast radius, allows parallel autonomous agent dispatch, and isolates subsystem frontiers.

---

## ADR-002: AST Pattern Linter Binding Engine
* **Status:** Accepted
* **Context:** Choosing between spawning `@ast-grep/cli` as an external subprocess vs embedding `@ast-grep/napi` in-process Node bindings.
* **Decision:** Embed `@ast-grep/napi` Tree-Sitter direct Node bindings.
* **Rationale:** Spawning Node/Rust subprocesses for every step adds 150-300ms overhead. Direct napi in-process scanning runs in <10ms, enabling sub-second step evaluations during rapid agent hill-climbing loops.

---

## ADR-003: Workspace Driver Seam and Dual Adapters
* **Status:** Accepted
* **Context:** Providing reliable filesystem and git isolation for agent mutations while ensuring tests do not touch actual git repos.
* **Decision:** Define a `WorkspaceDriver` interface with two concrete adapters:
  1. `GitWorktreeDriver`: Production adapter managing git worktrees, commit-per-win, and `git reset --hard` rollbacks.
  2. `InMemorySandboxDriver`: Test adapter using an in-memory `Map<string, string>` file map.
* **Rationale:** Satisfies the deep module seam rule ($N \ge 2$ real adapters). Enables fast (<5ms) unit testing of sandbox coordinators without disk or git subprocess overhead.

---

## ADR-004: Worktree Location & Base Working Tree Dirty State
* **Status:** Accepted (Affirmed in #21 Grilling Session)
* **Context:** Handling where worktrees are allocated, disk budget caps, and what to do if the developer's main working tree has uncommitted edits.
* **Decision:**
  - Worktrees are allocated in `.perfgym/worktrees/run-<id>/` by default, configurable in `.perfgym.yaml` (including support for OS temp directories).
  - **Dirty Base Working Tree Policy:** Worktrees branch directly off `HEAD` (`git worktree add <dir> HEAD`). Unstaged/uncommitted files in the main working tree are ignored and untouched, ensuring zero risk of data loss, stash conflicts, or dirty state pollution.
  - **Worktree Disk Budget & Quota:** Maximum disk cap of 2GB enforced for `.perfgym/worktrees`. When the quota is exceeded, the runner automatically performs an LRU (least-recently-used) prune of oldest inactive worktrees (`git worktree remove --force <dir>` + `git worktree prune`).
* **Rationale:** Developers frequently run agents while experimenting on dirty branches. Never auto-stash or touch the user's active editor files. Enforcing a 2GB LRU cap avoids unbounded disk consumption across extended agent runs.

---

## ADR-005: Rollback Mechanism (Commit-Per-Win & Hard Reset)
* **Status:** Accepted
* **Context:** How to guarantee sub-30ms atomic rollbacks when an agent introduces a performance regression or broken invariant.
* **Decision:**
  - On every accepted step, commit to the isolated worktree branch: `git commit -am "perfgym(step): mutation #N"`.
  - On failure or regression: execute `git reset --hard HEAD && git clean -fd`.
* **Rationale:** Built-in git commands are rock-solid, handle directory additions/deletions atomically, and execute in under 30ms.

---

## ADR-006: Anti-Cheating Rule Actions & Configurable Thresholds
* **Status:** Accepted
* **Context:** Handling agent attempts to bypass compiler checks (e.g. injecting `// @ts-ignore`, `// @ts-nocheck`, or cast to `any`).
* **Decision:** Rules define `action: "disqualify" | "penalize"` in `.perfgym.yaml`:
  - `action: "disqualify"` (default for type suppression): Instantly sets $\text{Score} = -\infty$ and triggers rollback.
  - `action: "penalize"`: Deducts scalar penalty points $P_j$ from fitness percentage score.
* **Rationale:** Absolute zero-tolerance for compiler sabotage prevents agents from cheating the fitness function, while still allowing custom heuristic rules to apply softer penalties.

---

## ADR-007: Two-Tier Typechecking Strategy
* **Status:** Accepted
* **Context:** Balancing type safety against step latency (full `tsc --noEmit` takes 3-8s).
* **Decision:**
  - **Tier 1 (Per-Step):** Sub-50ms syntax, import, and type-suppression scan via Biome/Oxlint/AST patterns during each hill-climbing step.
  - **Tier 2 (Pre-Promotion):** Full project `tsc --noEmit` runs once before committing/promoting the winning branch into the user's workspace.
* **Rationale:** Keeps the inner agent mutation loop sub-second (~300-500ms total), while guaranteeing 100% type soundness before final merge.

---

## ADR-008: Invariant Flakiness & Retries Policy
* **Status:** Accepted
* **Context:** Handling sporadic test runner flakiness without accepting broken code.
* **Decision:** Configurable in `.perfgym.yaml` target settings via `invariants.retries: 0 | 1 | 2` (default 0).
* **Rationale:** Strict zero-tolerance by default ensures no regression leaks; configurable retries allow teams with complex integration tests to guard against transient network or timing blips.

---

## ADR-009: Full Distribution Capture & Tail Latency Guard
* **Status:** Accepted
* **Context:** Whether to trim metric extremes (min/max) or measure full distributions.
* **Decision:**
  - Capture the full statistical distribution across $N$ samples: `p50`, `p90`, `p95`, `p99`, `min`, `max`, `stddev`.
  - Enforce a **Tail Guard Ceiling**: Mutations that improve the target metric (e.g. p50) but trigger an unacceptable blowout in `p99` or `max` exceeding the baseline threshold are strictly rejected.
* **Rationale:** Performance optimizations frequently introduce tail degradation (e.g. GC pauses, lock contention, unindexed cache evictions). Trimming extremes blinds the agent to catastrophic edge-case regressions.

---

## ADR-010: Fitness Normalization Formula (Percentage - Penalties)
* **Status:** Accepted
* **Context:** How to combine benchmark improvements and AST linter violations into a single scalar fitness gradient.
* **Decision:**
  $$\text{Score} = \Delta \%_{\text{metric}} - \sum_{j} P_j$$
  Where $\Delta \% = \frac{\text{baseline} - \text{current}}{\text{baseline}} \times 100$ (for minimization metrics) and $P_j$ are discrete penalty points.
* **Rationale:** Intuitively interpretable: a +25% speedup with a 10-point AST penalty results in a net score of +15. Any score $\le 0$ triggers a rollback.

---

## ADR-011: Dual-Tier MCP Server Interface
* **Status:** Accepted
* **Context:** Designing the Model Context Protocol (MCP) tool surface for external AI coding agents (Claude Code, OpenCode, Cursor, T3 Code).
* **Decision:** Expose a Dual-Tier toolset:
  - **Tier 1 (Deep Default):**
    - `perfgym_baseline`: Initializes target, reads specs, records baseline.
    - `perfgym_step`: Evaluates mutation, runs 4-stage cascade, auto-reverts or commits, returns gradient.
    - `perfgym_status`: Reports iteration history, best score, active worktree.
  - **Tier 2 (Granular Advanced):**
    - `perfgym_test`, `perfgym_lint`, `perfgym_benchmark`, `perfgym_rollback`.
* **Rationale:** Deep tools hide complex worktree mechanics from agents by default, minimizing hallucination and token waste, while granular tools allow advanced custom multi-agent orchestrators.

---

## ADR-012: Hybrid Autonomous LLM Driver & Format Toggle
* **Status:** Accepted
* **Context:** How the autonomous runner (`perfgym run`) drives LLMs and formats outputs.
* **Decision:**
  - **Driver:** Hybrid model supporting direct LLM API calls (Vercel AI SDK / OpenAI / Anthropic / Gemini / Ollama) with an optional `--driver cli` flag to delegate to local agent CLIs (OpenCode, Claude Code).
  - **Format Toggle:** All CLI commands and MCP responses support `--format markdown` (rich human/agent readable text with AST line citations and negative memory) and `--format json` (machine-readable structured schema).
* **Rationale:** Flexibility for both autonomous standalone operation and seamless MCP tool usage inside modern coding harness environments.

---

## ADR-013: Atomic Lockfile with Heartbeat, PID Liveness, and Stale Recovery
* **Status:** Accepted (Affirmed in #21 Grilling Session)
* **Context:** A naive check-then-write lockfile suffers from TOCTOU races and permanent deadlocks if an agent process is killed or crashes.
* **Decision:**
  - Use atomic file creation (`O_EXCL` via `proper-lockfile` or atomic `mkdir .perfgym/.lock.d/`).
  - Lock data contains `{ pid, runId, startTime, heartbeat }`.
  - Heartbeat updated every 5 seconds.
  - **Crash Recovery Policy (Auto-reclaim dead PID):** If lock timestamp/heartbeat > 30s old AND `process.kill(pid, 0)` confirms process is dead, the runner automatically reclaims the lock, logs a warning, prunes orphaned worktrees via `git worktree prune`, and recovers cleanly.
* **Rationale:** Eliminates concurrency races between agents and prevents permanent runner deadlocks from orphaned lockfiles.

---

## ADR-014: Strict Path Whitelist & Blast Radius Enforcement
* **Status:** Accepted (Hardened via Adversarial Review)
* **Context:** An agent could modify `tsconfig.json`, tamper with invariant test files, inject global `declare module` shims, or traverse paths outside the project.
* **Decision:**
  - `WorkspaceDriver.writeFile()` strictly verifies that every write target matches the normalized relative glob in `target.files` defined in `.perfgym.yaml`.
  - Path traversal sequences (`../`, absolute paths, symlink tricks) throw an instant `ERR_PATH_TRAVERSAL` error.
  - `tsconfig.json`, `package.json`, `.perfgym.yaml`, and invariant test directories are cryptographically hashed at baseline; any detected mutation immediately disqualifies the step.
* **Rationale:** Completely blocks agents from cheating the grader or escaping the designated mutation boundary.

---

## ADR-015: Frozen Grader Snapshot & Anti-Tampering Isolation
* **Status:** Accepted (Hardened via Adversarial Review)
* **Context:** Agents could mock benchmark endpoints or short-circuit test assertions inside the worktree to fake speedups.
* **Decision:**
  - Invariant tests and benchmark suites are copied to a read-only mirror directory (`.perfgym/.harness/`) at baseline initialization.
  - Test and benchmark executions run against this frozen harness referencing the worktree's source code, preventing the agent from modifying the test assertions or benchmark timing logic.
* **Rationale:** Separates the grader from the graded code, providing absolute integrity against mock-based cheating.

---

## ADR-016: Statistically Sound Metric Variance & Minimum Significance Delta
* **Status:** Accepted (Hardened via Adversarial Review)
* **Context:** $N=5$ samples are mathematically insufficient to compute a valid `p99`, and natural OS variance causes agents to game random noise wins or thrash on false rollbacks.
* **Decision:**
  - For small sample sizes ($N < 30$), replace naive `p99` with **Median Absolute Deviation (MAD)** and **Interquartile Range (IQR)**:
    $$\text{Tail Ceiling} = \text{Baseline}_{\text{Median}} + 3 \times \text{MAD}$$
  - **Minimum Significance Threshold ($\Delta_{\min} = 2.5\%$):** A mutation must improve performance by at least $2.5\%$ to be accepted, preventing noise accumulation drift.
  - Outliers exceeding $3 \times \text{MAD}$ during warmups are flagged and trigger an automatic re-sample.
* **Rationale:** Stops false rollbacks from OS thread jitter while preventing agents from accumulating noisy micro-deltas without algorithmic value.

---

## ADR-017: Deep Aggressive Rollback (`git clean -ffd` & Submodule Reset)
* **Status:** Accepted (Hardened via Adversarial Review)
* **Context:** `git clean -fd` ignores untracked ignored files and nested submodules, potentially leaking poisoned cache files across steps.
* **Decision:**
  - Rollback executes `git reset --hard HEAD && git clean -ffd` (double `-f` forces removal of untracked ignored files and directories).
  - Explicit submodule reset: `git submodule foreach --recursive git reset --hard`.
* **Rationale:** Guarantees 100% pristine worktree state across mutations in sub-30ms.

---

## ADR-018: Effect 4.0 for Typed Error Channels & Exception Safety
* **Status:** Accepted
* **Context:** Traditional Promise-based error handling relies on throwing untyped exceptions (`catch (err: any)`), leading to silent bug leaks, unhandled rejections, missed edge cases, and runtime crashes during agent execution loops.
* **Decision:**
  - Standardize on **Effect 4.0** (`effect` ^4.0.0) across all core subsystem interfaces and pipelines.
  - All domain errors are strictly modeled as tagged errors using `Data.TaggedError` (`PathTraversalError`, `SandboxLockBusyError`, `GitCommandError`, `InvariantFailureError`, `DisqualificationError`, `TailGuardRegressionError`, `InsignificantDeltaError`).
  - Core pipelines return `Effect.Effect<Success, DomainError, Requirements>` rather than untyped Promises.
  - Use `Effect.catchTag` for granular typed recovery, `Effect.retry` with explicit retry schedules, and `Effect.acquireRelease` for guaranteed worktree teardown and lock release even under process interruption.
* **Rationale:** Compile-time enforced exception safety ensures that every possible failure mode across the sandbox, linter, and benchmark pipeline is accounted for and handled with zero untyped runtime exceptions.

---

## ADR-019: TanStack Store & Table for Reactive State and Tabular History
* **Status:** Accepted
* **Context:** The autonomous optimization loop needs a deterministic, reactive state store to track baseline metrics, step evaluations, and best scores across CLI, MCP tools, and Web adapters without coupling state to UI frameworks.
* **Decision:**
  - Adopt **TanStack Store** (`@tanstack/store`) for in-memory session state management (`SessionStore`).
  - The store manages active status, baseline distributions, step history, and active lock states with reactive subscriptions (`store.subscribe(...)`).
  - Adopt **TanStack Table** (`@tanstack/table-core`) to create deterministic tabular models of step history (`StepTableRow`), computing formatted deltas, decisions, and durations for terminal rendering and markdown/HTML reports.
* **Rationale:** Headless, framework-agnostic, and type-safe state and table architecture that works seamlessly across Node.js CLI, background workers, MCP servers, and Web adapters.


