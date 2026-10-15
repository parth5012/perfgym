# PerfGym System Architecture

PerfGym is the first open-source **Performance & Linting Gym** engineered specifically for AI coding agents (OpenCode, T3 Code, Claude Code, Cursor, Codex).

---

## 1. The Core Problem It Solves

AI agents are proficient at writing code that compiles and passes surface-level unit tests, but they struggle with **performance optimization**:
1. **Noisy Evaluation:** Cloud wall-clock execution has 15–25% variance. Agents cannot hill-climb on noisy reward signals.
2. **Hallucinated Speedups:** Without deterministic cycle counts, agents declare code "optimized" when it actually introduced memory leaks or N+1 queries.
3. **Destructive Iterations:** When an agent refactors code to make it faster, it frequently breaks invariants or silently drops edge cases.

---

## 2. The 4-Stage Closed Loop

```
Agent Mutation
     │
     ▼
┌────────────────────────────────────────┐
│ Stage 1: Invariant Correctness Gate    │ ───► Fails? ──► Revert worktree immediately
└──────────────────┬─────────────────────┘
                   │ Passes
                   ▼
┌────────────────────────────────────────┐
│ Stage 2: Custom AST Anti-Pattern Linter│ ───► ast-grep structural checks
└──────────────────┬─────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────┐
│ Stage 3: Deterministic Profiling       │ ───► CPU cycles / Heap allocation / DB queries
└──────────────────┬─────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────┐
│ Stage 4: Fitness & Gradient Calculator │
│ Score = ΔPerfMetric − Σ(RulePenalties) │
└──────────────────┬─────────────────────┘
                   │
         ┌─────────┴─────────┐
         ▼                   ▼
    Score > 0           Score <= 0
  Commit & Advance    Rollback Worktree & Guide Agent
```

---

## 3. Sandboxed Git Worktrees

PerfGym isolates all agent mutations inside dedicated git worktrees (`.perfgym/worktrees/*`).
- The user's main branch and uncommitted changes are never touched.
- Rollbacks happen instantaneously via `git reset --hard` / worktree stash.
- Only mutations that achieve a positive fitness score ($\text{Score} > 0$) with 100% green invariants are preserved.

---

## 4. Platform Adapter Roadmap

- **Phase 1 (v0.1 - Web & Fullstack):** TypeScript, Node.js, Bun, Vite, Vitest, Pytest, Go. (Target cycle: 2–5 seconds).
- **Phase 2 (Mobile):** Android Kotlin (Robolectric headless JVM, Compose Recomposition counters, DEX size) and iOS Swift.
- **Phase 3 (Desktop):** Rust / Tauri (cargo bench), Electron (CDP heap snapshots and IPC latency).

---

*See interactive architecture visualization in `docs/architecture-diagram.html`.*
