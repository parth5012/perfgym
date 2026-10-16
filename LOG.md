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

---

## Iteration 2: CodeRabbit Review Fixes on PR #29
* **Date**: Fri Oct 16 2026
* **Status**: `Done`
* **PR**: `#29`

### Fixes Applied
1. **Coordinator Teardown Resilience**: Wrapped `promote` and `teardown` in nested `finally` blocks so driver resources are always cleaned up and lock released even if promotion throws.
2. **Coordinator Stale Lock Race Condition**: Replaced `rmSync(lockDir)` with atomic tombstone rename (`fs.renameSync(lockDir, tombstone)`) ensuring only one recovering process can reclaim the lock without race collisions.
3. **Safe Git Promotion**: Added fast-forward verification (`merge-base --is-ancestor`), checked-out dirty tracked file guard, and fast-forward merging (`git merge --ff-only`) instead of dangerous hard resets.
4. **In-Memory Driver Robustness**:
   - Initial `Map` keys normalized (`\` to `/`).
   - Re-initialization resets file state and clears commits cleanly.
   - Path traversal in `readFile` checks segments (`split('/').some(...)`) to allow legitimate filenames like `foo..bar.ts`.
5. **ADR-004 Clarification**: Clarified that 2GB LRU quota tracking is scheduled for the Map 4 CLI runner / GC cohort.

### Verification Results
* `vitest run`: 6 test files, 28 tests passed (100% green).
* `tsc --noEmit`: 0 errors.

---

## Iteration 3: Multi-Agent Adversarial Review Hardening
* **Date**: Fri Oct 16 2026
* **Status**: `Done`
* **Subsystem**: Workspace Sandbox, Blast Radius Gating, and Lock Safety

### Hardening Applied
1. **Worktree Blast Radius Enforcement (`verifyBlastRadius`)**:
   - Added `verifyBlastRadius()` to `WorkspaceDriver`, `GitWorktreeDriver`, and `GitSandboxCoordinator`.
   - Inspects `git status --porcelain -uall` across the whole worktree to detect direct shell writes, untracked files, or deletions outside `allowedGlobs`.
   - Automatically gates `commitStep()` and `acceptStep()` to reject any out-of-bounds mutation.
2. **Symlink and Junction Traversal Defense**:
   - Checks existing directory segments via `fs.lstatSync` to detect symlinks or NTFS junction points.
   - Verifies physical `fs.realpathSync` to guarantee targets stay strictly inside the physical working directory.
3. **Safe Lock Ownership Verification**:
   - `syncRelease()` now checks `meta.pid === process.pid && meta.runId === this.currentRunId` to prevent deleting locks owned by other processes when metadata is unreadable.
4. **Rollback Resilience & Submodule Cleanup**:
   - Added bounded retry loop for Windows `EBUSY` file lock release during `rollbackStep()`.
   - Cleans submodules recursively on rollback.
5. **Glob Pattern Matching**:
   - Fixed regex escaping and added platform-aware case-insensitivity on Windows.

### Verification Results
* `vitest run`: 7 test files, 33 tests passed (100% green).
* `tsc --noEmit`: 0 errors.
* 5 new adversarial verification tests in `tests/adversarial-hardening.test.ts`.
