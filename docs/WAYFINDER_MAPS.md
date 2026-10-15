# 🗺️ PerfGym Wayfinder Implementation Maps (Two-Phase HITL + AFK)

This document records the four architectural subsystems of **PerfGym**, organized as **Wayfinder Maps** with a strict **Two-Phase Workflow** on GitHub (`parth5012/perfgym`):

```
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1 — HITL (Human Present)                              │
│ - Grilling sessions: resolve load-bearing architectural     │
│   policies and thresholds interactively.                    │
│ - Interactive prototypes: review visual UX, CLI format,     │
│   rule false-positives, and live worktree revert behavior.  │
│ - Agent assists; human decides and approves.                │
└──────────────────────────────┬──────────────────────────────┘
                               │ All HITL tickets resolved
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ PHASE 2 — AFK (Autonomous Agents)                           │
│ - Autonomous coder & research agents execute sequentially.  │
│ - One ticket per agent dispatch, TDD mandatory.             │
│ - Human is free to leave; Phase 2 runs unattended.          │
└─────────────────────────────────────────────────────────────┘
```

All subsystems adhere strictly to **Deep Module Design** principles:
- **Module**: Behavior hidden behind a small interface.
- **Interface**: Everything a caller must know (types, invariants, ordering, errors, performance).
- **Depth**: High leverage for callers, high locality for maintainers.
- **Seam**: Clean points of variation proved by at least two concrete adapters.
- **The Deletion Test**: Deleting a deep module causes complexity to reappear across $N$ callers; deleting a shallow one merely removes a pass-through.
- **Test Surface**: Callers and tests cross the exact same interface seam.
- **Adversarial Hardening (ADR-013 to ADR-017)**: Atomic locks with heartbeat, blast-radius path whitelisting, frozen grader snapshots, MAD small-sample statistics, and deep aggressive rollbacks.

---

## 🗺️ Map 1: Workspace Sandbox & Rollback Sentinel
* **Parent Issue:** [#1](https://github.com/parth5012/perfgym/issues/1)
* **Subsystem:** `@perfgym/core/sandbox`
* **Deep Module:** `GitSandbox`
* **Seam:** `WorkspaceDriver` interface with dual adapters:
  1. `GitWorktreeDriver` (production native worktree isolation)
  2. `InMemorySandboxDriver` (in-memory virtual file map for <10ms unit tests)

### Phase 1: HITL (Human-In-The-Loop)
* [#21 - [GRILL:HITL] Workspace Safety Policies & Worktree Disk Budget](https://github.com/parth5012/perfgym/issues/21) *(Ready)*
* [#22 - [PROTOTYPE:HITL] Live Worktree Mutation & Rollback Verification](https://github.com/parth5012/perfgym/issues/22) *(blocked by #4, #5)*

### Phase 2: AFK (Autonomous)
1. [#2 - [TASK:AFK] Design WorkspaceDriver Interface & Seam](https://github.com/parth5012/perfgym/issues/2) *(Ready)*
2. [#3 - [TASK:AFK] Implement InMemorySandboxDriver with Vitest Suite](https://github.com/parth5012/perfgym/issues/3) *(blocked by #2)*
3. [#4 - [TASK:AFK] Implement GitWorktreeDriver for Production Isolation](https://github.com/parth5012/perfgym/issues/4) *(blocked by #2)*
4. [#5 - [TASK:AFK] Build GitSandbox Coordinator Module with Lockfile & Auto-cleanup](https://github.com/parth5012/perfgym/issues/5) *(blocked by #3, #4)*

---

## 🗺️ Map 2: AST Pattern Linter & Anti-Cheating Gate
* **Parent Issue:** [#6](https://github.com/parth5012/perfgym/issues/6)
* **Subsystem:** `@perfgym/linter`
* **Deep Module:** `AstLinterEngine`
* **Interface:** `scan(files: string[]): Promise<LintResult>`
* **Execution Engine:** In-process `@ast-grep/napi` Tree-Sitter Node bindings (sub-10ms matching).

### Phase 1: HITL (Human-In-The-Loop)
* [#23 - [GRILL:HITL] Anti-Cheating Thresholds & Rule Penalty Weight Matrix](https://github.com/parth5012/perfgym/issues/23) *(Ready)*
* [#24 - [PROTOTYPE:HITL] Anti-Pattern Rule Catalog & False Positive Calibration](https://github.com/parth5012/perfgym/issues/24) *(blocked by #10)*

### Phase 2: AFK (Autonomous)
1. [#7 - [TASK:AFK] Integrate @ast-grep/napi Binding in @perfgym/linter](https://github.com/parth5012/perfgym/issues/7) *(Ready)*
2. [#8 - [TASK:AFK] Implement Declarative YAML Rule Parser & Penalty Calculator](https://github.com/parth5012/perfgym/issues/8) *(Ready)*
3. [#9 - [TASK:AFK] Implement Fast Typecheck Gate (tsc --noEmit)](https://github.com/parth5012/perfgym/issues/9) *(Ready)*
4. [#10 - [TASK:AFK] Implement AstLinterEngine Deep Module with Vitest Suite](https://github.com/parth5012/perfgym/issues/10) *(blocked by #7, #8, #9)*

---

## 🗺️ Map 3: Invariant & Deterministic Fitness Pipeline
* **Parent Issue:** [#11](https://github.com/parth5012/perfgym/issues/11)
* **Subsystem:** `@perfgym/core/pipeline`
* **Deep Module:** `EvaluationPipeline`
* **Mathematical Objective:**
  $$\text{Score} = \begin{cases} -\infty & \text{if Invariants Fail} \\ \sum_{i} w_i \cdot \Delta_i - \sum_{j} P_j & \text{if Invariants Pass} \end{cases}$$

### Phase 1: HITL (Human-In-The-Loop)
* [#25 - [GRILL:HITL] Invariant Test Timeout & Flakiness Policy](https://github.com/parth5012/perfgym/issues/25) *(Ready)*
* [#26 - [PROTOTYPE:HITL] Simulated Agent Hill-Climbing Run & Fitness Gradient Review](https://github.com/parth5012/perfgym/issues/26) *(blocked by #15)*

### Phase 2: AFK (Autonomous)
1. [#12 - [TASK:AFK] Implement Strict Invariant Correctness Gate](https://github.com/parth5012/perfgym/issues/12) *(Ready)*
2. [#13 - [TASK:AFK] Implement Deterministic Benchmark Parser & Metrics Seam](https://github.com/parth5012/perfgym/issues/13) *(Ready)*
3. [#14 - [TASK:AFK] Implement Continuous Mathematical Fitness Calculator](https://github.com/parth5012/perfgym/issues/14) *(Ready)*
4. [#15 - [TASK:AFK] Implement EvaluationPipeline Deep Module with TDD Suite](https://github.com/parth5012/perfgym/issues/15) *(blocked by #10, #12, #13, #14)*

---

## 🗺️ Map 4: CLI Runner, Agent MCP Server & Autonomous Loop
* **Parent Issue:** [#16](https://github.com/parth5012/perfgym/issues/16)
* **Subsystem:** `@perfgym/cli` & `packages/mcp-server`
* **Deep Modules:** `CliRunner`, `PerfGymMcpServer`

### Phase 1: HITL (Human-In-The-Loop)
* [#27 - [PROTOTYPE:HITL] Terminal UX & Agent MCP Feedback Format Review](https://github.com/parth5012/perfgym/issues/27) *(blocked by #17, #19)*
* [#28 - [TASK:HITL] End-to-End Handshake with Live OpenCode / Claude Code Agent](https://github.com/parth5012/perfgym/issues/28) *(blocked by #18, #20)*

### Phase 2: AFK (Autonomous)
1. [#17 - [TASK:AFK] Implement CLI Commands: perfgym init, baseline, step](https://github.com/parth5012/perfgym/issues/17) *(blocked by #5, #15)*
2. [#18 - [TASK:AFK] Implement Model Context Protocol (MCP) Server for Agents](https://github.com/parth5012/perfgym/issues/18) *(blocked by #17)*
3. [#19 - [TASK:AFK] Implement Natural-Language Gradient Feedback Synthesizer](https://github.com/parth5012/perfgym/issues/19) *(blocked by #15)*
4. [#20 - [TASK:AFK] Implement Dual-Mode Autonomous Hill-Climbing Loop (perfgym run)](https://github.com/parth5012/perfgym/issues/20) *(blocked by #17, #18, #19)*

---

## ⚡ Frontier Execution Protocol

When invoking `/wayfinder-runner <MAP_NUMBER>`:
1. **Phase 1 (HITL)** tickets execute first while the human is present.
   - Run grilling sessions (#21, #23, #25) to freeze policies.
   - Run prototype tickets (#22, #24, #26, #27) as soon as their underlying modules build.
2. **Phase 2 (AFK)** tickets execute autonomously in topological order once their blockers clear.
