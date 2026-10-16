# 📝 PerfGym Iteration Log

## Iteration 1: Wayfinder Map 1 Resolution (Workspace Sandbox & Rollback Sentinel)
* **Date**: Fri Oct 16 2026
* **Status**: `Done`
* **Map**: `#1` ([WAYFINDER MAP 1] Workspace Sandbox & Rollback Sentinel)

### Work Executed
1. **[GRILL:HITL] #21**: Pinned down load-bearing workspace policies in interactive session:
   - Dirty Base Working Tree Policy: Branch off HEAD directly, zero pollution in main repo.
   - Worktree Disk Budget: 2GB LRU quota pruning.
   - Crash Recovery Policy: Stale lock recovery with PID liveness check (`process.kill(pid, 0)`).
   - Documented in `docs/DECISIONS.md` (ADR-004 & ADR-013).
2. **[TASK:AFK] #2**: Designed `WorkspaceDriver` interface and seam in `packages/core/src/sandbox/driver.ts` with error definitions in `packages/core/src/errors.ts`.
3. **[TASK:AFK] #3**: Implemented `InMemorySandboxDriver` in `packages/core/src/sandbox/in-memory-driver.ts` with <20ms virtual filesystem operations in RAM.
4. **[TASK:AFK] #4**: Implemented `GitWorktreeDriver` in `packages/core/src/sandbox/git-worktree-driver.ts` using safe `execFileSync` subprocess execution, commit-per-win, and hard reset + clean rollback.
5. **[TASK:AFK] #5**: Built `GitSandboxCoordinator` deep module in `packages/core/src/sandbox/coordinator.ts` managing atomic locking, heartbeats, dead PID recovery, and step receipts.
6. **[PROTOTYPE:HITL] #22**: Built and ran `scripts/demo-sandbox-revert.ts`, demonstrating live worktree isolation, zero pollution in developer's main working tree, and clean rollback; visually verified and approved by human architect.

### Verification Results
* `vitest run`: 6 test files, 25 tests passed (100% green, ~3.9s runtime).
* `tsc --noEmit`: 0 errors (clean typecheck).
* Map 1 closed and all 6 child tickets completed.
