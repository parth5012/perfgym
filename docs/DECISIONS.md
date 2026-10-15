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
* **Status:** Accepted
* **Context:** Handling where worktrees are allocated and what to do if the developer's main working tree has uncommitted edits.
* **Decision:**
  - Worktrees are allocated in `.perfgym/worktrees/run-<id>/` by default, configurable in `.perfgym.yaml` (including support for OS temp directories).
  - Worktrees branch directly off `HEAD` (`git worktree add <dir> HEAD`). The developer's main working tree is untouched, with zero risk of data loss or dirty state pollution.
* **Rationale:** Developers frequently run agents while experimenting on dirty branches. Never auto-stash or touch the user's active editor files.

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
