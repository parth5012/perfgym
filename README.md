# ⚡ PerfGym

> **Autonomous Performance & Linting Gym for AI Coding Agents**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-blue.svg)](https://www.typescriptlang.org/)
[![Vite](https://img.shields.io/badge/Vite-6.0-646CFF.svg)](https://vitejs.dev/)

**PerfGym** is an open-source evaluation harness and execution gym designed to let AI coding agents (OpenCode, T3 Code, Claude Code, Cursor, Codex) **hill-climb on code performance without breaking correctness**.

---

## 🎯 Why PerfGym?

Current AI coding tools write syntax that works, but they lack a **continuous, deterministic gradient** to optimize performance:
- **Cloud Jitter:** Wall-clock timers vary by 20% between runs. Agents hallucinate speedups that were just idle CPU.
- **Silent Regressions:** Agents introduce N+1 queries, memory leaks, and serial async calls while trying to optimize logic.
- **Destructive Loops:** Agents lack a safe, zero-risk worktree sandbox that rolls back degrading mutations instantly.

**PerfGym turns code performance into a reinforcement-learning-style Gym loop:**
1. **Isolated Worktrees:** Safe sandbox with zero risk to your working directory.
2. **Invariant Gate:** 100% green unit tests are mandatory before metrics are even sampled.
3. **ast-grep Linters:** Custom declarative rules catch anti-patterns via AST patterns.
4. **Deterministic Score:** Computes $\Delta\text{Performance} - \text{Penalties}$ so the agent knows whether it moved closer to the peak.

---

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────┐
│                   AGENT INTERACTION                    │
│   OpenCode Agent • T3 Code • Claude Code • Cursor      │
│   Interfaces: Native CLI (`perfgym`) & MCP Server       │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│                 PERFGYM CORE ENGINE                    │
│  ┌───────────────────────┐   ┌──────────────────────┐  │
│  │ Git Worktree Sandbox  │   │ Evaluation Pipeline  │  │
│  │ • Zero-risk sandbox   │   │ 1. Invariant Gate    │  │
│  │ • Instant rollback    │   │ 2. ast-grep Linter   │  │
│  │ • Checkpoint commit   │   │ 3. Profiler Metric   │  │
│  └───────────────────────┘   │ 4. Fitness Delta     │  │
│                              └──────────────────────┘  │
└──────────────────────────┬─────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────┐
│                   PLATFORM ADAPTERS                    │
│   Web / Fullstack (v0.1) • Mobile (Ph 2) • Desktop(Ph 3)│
└────────────────────────────────────────────────────────┘
```

*For the complete interactive SVG architectural schematic, open [`docs/architecture-diagram.html`](docs/architecture-diagram.html).*

---

## 🚀 Quick Start

### 1. Initialize in any project

```bash
npx perfgym init
```

This creates `.perfgym.yaml`:

```yaml
version: "1.0"
target:
  name: "checkout-endpoint"
  language: "typescript"
  files: ["src/api/checkout/**/*.ts"]

invariants:
  command: "pnpm vitest run src/api/checkout"

rules:
  - id: no-await-in-loops
    message: "Avoid serial awaits in loops"
    severity: "error"
    penalty: 50
    pattern: "for ($VAR of $ARR) { $$$BEFORE; await $FUNC($$$ARGS); $$$AFTER; }"

metrics:
  - name: "cpu_instructions"
    command: "node --prof scripts/benchmark.js"
    goal: "minimize"
    weight: 0.7
```

### 2. Measure baseline

```bash
perfgym baseline
```

### 3. Run the Hill-Climbing loop with your agent

```bash
# Agent mutates code, then verifies progress:
perfgym step
```

If the change improves performance and preserves invariants, PerfGym checkpoints the commit. If the change degrades performance or breaks tests, PerfGym rolls back the worktree and gives the agent the exact reason.

---

## 🗺️ Roadmap

- [x] **v0.1:** Core Architecture, CLI interface, and Web Platform Adapter specification.
- [ ] **v0.2:** Native `ast-grep` Tree-Sitter runtime integration.
- [ ] **v0.3:** OpenCode & T3 Code Model Context Protocol (MCP) server integration.
- [ ] **v0.4:** Android Mobile Adapter (Robolectric + Jetpack Compose recomposition tracker).
- [ ] **v0.5:** Desktop Adapter (Rust/Tauri `cargo bench` + Electron CDP profiler).

---

## 📄 License

MIT © [Parth](https://github.com/parth5012)
