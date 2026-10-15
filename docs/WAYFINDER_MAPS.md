# 🗺️ PerfGym Wayfinder Implementation Maps

This document records the four architectural subsystems of **PerfGym**, organized as **Wayfinder Maps** with autonomous **AFK (Away-From-Keyboard) implementation tickets** on GitHub (`parth5012/perfgym`).

All subsystems are structured according to **Deep Module Design** principles:
- **Module**: Behavior hidden behind a small interface.
- **Interface**: Everything a caller must know (types, invariants, ordering, errors, performance).
- **Depth**: High leverage for callers, high locality for maintainers.
- **Seam**: Clean points of variation proved by at least two concrete adapters.
- **The Deletion Test**: Deleting a deep module causes complexity to reappear across $N$ callers; deleting a shallow one merely removes a pass-through.
- **Test Surface**: Callers and tests cross the exact same interface seam.

---

## 🗺️ Map 1: Workspace Sandbox & Rollback Sentinel
* **Parent Issue:** [#1](https://github.com/parth5012/perfgym/issues/1)
* **Subsystem:** `@perfgym/core/sandbox`
* **Deep Module:** `GitSandbox`
* **Seam:** `WorkspaceDriver` interface with dual adapters:
  1. `GitWorktreeDriver` (production native worktree isolation)
  2. `InMemorySandboxDriver` (in-memory virtual file map for <10ms unit tests)

### Child AFK Tickets
1. [#2 - [TASK:AFK] Design WorkspaceDriver Interface & Seam](https://github.com/parth5012/perfgym/issues/2)
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

### Child AFK Tickets
1. [#7 - [TASK:AFK] Integrate @ast-grep/napi Binding in @perfgym/linter](https://github.com/parth5012/perfgym/issues/7)
2. [#8 - [TASK:AFK] Implement Declarative YAML Rule Parser & Penalty Calculator](https://github.com/parth5012/perfgym/issues/8)
3. [#9 - [TASK:AFK] Implement Fast Typecheck Gate (tsc --noEmit)](https://github.com/parth5012/perfgym/issues/9)
4. [#10 - [TASK:AFK] Implement AstLinterEngine Deep Module with Vitest Suite](https://github.com/parth5012/perfgym/issues/10) *(blocked by #7, #8, #9)*

---

## 🗺️ Map 3: Invariant & Deterministic Fitness Pipeline
* **Parent Issue:** [#11](https://github.com/parth5012/perfgym/issues/11)
* **Subsystem:** `@perfgym/core/pipeline`
* **Deep Module:** `EvaluationPipeline`
* **Mathematical Objective:**
  $$\text{Score} = \begin{cases} -\infty & \text{if Invariants Fail} \\ \sum_{i} w_i \cdot \Delta_i - \sum_{j} P_j & \text{if Invariants Pass} \end{cases}$$

### Child AFK Tickets
1. [#12 - [TASK:AFK] Implement Strict Invariant Correctness Gate](https://github.com/parth5012/perfgym/issues/12)
2. [#13 - [TASK:AFK] Implement Deterministic Benchmark Parser & Metrics Seam](https://github.com/parth5012/perfgym/issues/13)
3. [#14 - [TASK:AFK] Implement Continuous Mathematical Fitness Calculator](https://github.com/parth5012/perfgym/issues/14)
4. [#15 - [TASK:AFK] Implement EvaluationPipeline Deep Module with TDD Suite](https://github.com/parth5012/perfgym/issues/15) *(blocked by #10, #12, #13, #14)*

---

## 🗺️ Map 4: CLI Runner, Agent MCP Server & Autonomous Loop
* **Parent Issue:** [#16](https://github.com/parth5012/perfgym/issues/16)
* **Subsystem:** `@perfgym/cli` & `packages/mcp-server`
* **Deep Modules:** `CliRunner`, `PerfGymMcpServer`
* **Modes:**
  - **External Agent Driven:** Coding agents (OpenCode, T3 Code, Claude Code) call MCP tools / CLI.
  - **Built-in Autonomous Loop:** `perfgym run --model ...` executes direct hill-climbing cycles.

### Child AFK Tickets
1. [#17 - [TASK:AFK] Implement CLI Commands: perfgym init, baseline, step](https://github.com/parth5012/perfgym/issues/17) *(blocked by #5, #15)*
2. [#18 - [TASK:AFK] Implement Model Context Protocol (MCP) Server for Agents](https://github.com/parth5012/perfgym/issues/18) *(blocked by #17)*
3. [#19 - [TASK:AFK] Implement Natural-Language Gradient Feedback Synthesizer](https://github.com/parth5012/perfgym/issues/19) *(blocked by #15)*
4. [#20 - [TASK:AFK] Implement Dual-Mode Autonomous Hill-Climbing Loop (perfgym run)](https://github.com/parth5012/perfgym/issues/20) *(blocked by #17, #18, #19)*

---

## ⚡ Frontier Execution Order for Autonomous Agents

To execute this map with `wayfinder-runner`, the unblocked frontier starts immediately with:
1. **[#2](https://github.com/parth5012/perfgym/issues/2)** (`WorkspaceDriver` interface)
2. **[#7](https://github.com/parth5012/perfgym/issues/7)** (`@ast-grep/napi` integration)
3. **[#8](https://github.com/parth5012/perfgym/issues/8)** (Rule YAML parser)
4. **[#9](https://github.com/parth5012/perfgym/issues/9)** (Fast typecheck gate)
5. **[#12](https://github.com/parth5012/perfgym/issues/12)** (Invariant gate)
6. **[#13](https://github.com/parth5012/perfgym/issues/13)** (Benchmark parser)
7. **[#14](https://github.com/parth5012/perfgym/issues/14)** (Fitness calculator)

Running `/wayfinder-runner 1` (or 2, 3, 4) will execute each ticket sequentially with automated review gates.
