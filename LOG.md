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

---

## Iteration 4: Interactive Sandbox Lab Demo UI
* **Date**: Fri Oct 16 2026
* **Status**: `Done`
* **Subsystem**: Demo tooling (`demo/`) for manual sandbox verification

### What Was Built
1. **`demo/sandbox-api.ts` — `DemoSandbox` backend**: stateful wrapper around the real `GitSandboxCoordinator` + `GitWorktreeDriver` that provisions a throwaway demo git repo in `.tmp/demo-repo`, with an operation queue to serialize UI actions. Exposes init/state/write/read/verify/accept/reject/promote, plus deliberate attack surfaces: `rawWrite()` (driver bypass), `symlink()` (escape), `attemptCompetingAcquire()` (lock contention), and `runSuite()` (12-scenario adversarial suite against a fresh repo).
2. **`demo/server.mjs` — zero-build HTTP server**: loads the TS backend via Vite SSR module loader (`configFile:false`, middleware mode), serves `demo/index.html` + 12 JSON routes. Domain errors return HTTP 200 with `ok:false` so the UI can distinguish "attack correctly blocked" from transport failure. Graceful SIGINT/SIGTERM releases the sandbox lock. Auto-inits on boot. Demo lock tuned to `staleThresholdMs: 3000` / `heartbeatIntervalMs: 1000` for fast crash recovery.
3. **`demo/index.html` — Sandbox Lab UI**: session/worktree observability (git status colored by whitelist, commit-per-win log, branches), mutation lab (write/read/verify/commit/rollback/promote), 4 attack buttons (traversal, raw shell write → auto verify, symlink escape, competing lock), 12-scenario suite results table, and a color console with expectation semantics: **green = sandbox behaved correctly** (legit allowed OR attack blocked), red = sandbox misbehaved.
4. **`tests/demo-sandbox.test.ts`**: 10 contract tests covering the exact API surface the UI calls, including a full `runSuite()` pass (all 12 scenarios).
5. **Root fix**: `vite.config.ts` now excludes `**/.tmp/**` from vitest collection; demo fixture renamed to `tests/example.check.ts`; test teardown removes throwaway repos.
6. Exported `matchesGlob` from `git-worktree-driver.ts` for UI state enrichment (whitelist badges). Added npm script `demo:sandbox`.

### Verification Results
* `vitest run`: 8 test files, 43 tests passed (100% green) — ran concurrently with the live lab server.
* `tsc --noEmit`: 0 errors.
* HTTP smoke tests: legit write allowed; `package.json` write → `PathOutsideTargetError`; `../../escape.txt` → `PathTraversalError`; raw shell escape caught by `/api/verify`; rollback → verify clean.
* UI script validated by parser (`new Function` compile); server confirmed live on `http://localhost:5177`.
* Skill-pipeline notes: `ocr-review` skipped — no desktop browser connected, so no screenshot/visual output to inspect; `code-review`/`repo-quality-orchestrator` skipped as PR-level bots (CodeRabbit) re-run on push; diff self-reviewed before commit.

## Iteration 5: OS-Level Sandbox Options Survey + PR #29 Landing
* **Date**: Fri Oct 16 2026
* **Status**: `Review` (merging PR #29)
* **Subsystem**: Documentation (`docs/SANDBOX_OPTIONS.md`)

### What Was Built
1. **`docs/SANDBOX_OPTIONS.md`**: research record of sandbox isolation options *apart from Docker* — MXC (Windows native process container), Node `--permission` model, WSL2 + Landlock/bubblewrap, Windows Sandbox (.wsb), nsjail, gVisor, cloud microVMs (E2B/Vercel/Daytona/Modal), and Node wrappers (`@cdxgen/safer-exec`, `kern`, `@anthropic-ai/sandbox-runtime`).
2. Documents the current **gap**: PerfGym's file-mutation sandbox (ADR-003/013/014) does not isolate *command execution* — grader and autonomous-loop commands run with full user privileges.
3. Machine probe results: Windows 11 Pro 10.0.26300.9711 (meets MXC build threshold, availability probe pending), WSL2 present, GitHub Actions Linux runners.
4. Recommendation: proposed **ADR-020 — `CommandExecutor` seam** mirroring `WorkspaceDriver`, with tiered backends (Node `--permission` baseline → MXC on Windows / bwrap on Linux CI → optional cloud microVM), config key `sandbox.commandBackend`.

### Verification Results
* Option matrix cross-checked against environment probe (Win build number, WSL2 distro list, Node/CI facts recorded in §3).
* ADR numbering verified — ADR-018/019 already exist, so the new seam proposal is numbered **ADR-020**.
* PR #29 merged into `main` via rebase merge (`--delete-branch`) per the `merge-pr` skill after this commit; demo server unaffected.
* Skill-pipeline notes: `ocr-review` skipped (no UI/screenshot change — markdown only); `code-review`/CodeRabbit re-run on push as PR-level bot; diff self-reviewed before commit.

## Iteration 7: EvaluationPipeline Deep Module (wayfinder #15)
* **Date**: Sun Oct 19 2026
* **Status**: `Done`
* **Subsystem**: `packages/core/src/pipeline/pipeline.ts` (+ sibling `pipeline.test.ts`)

### What Was Built
1. `EvaluationPipeline` — tiny 3-method surface (constructor / `initializeHarness` / `evaluateStep`) hiding the full 4-stage cascade with in-band short-circuits; rejected steps resolve as `StepEvaluation` (Score -Infinity, `revertReason` populated) — callers get verdicts, not throws.
2. Stage flow: (1) invariant gate (zero retries, config timeout clamped by #12 seam); (2) anti-cheat scan (disqualify rules + `@ts-ignore`/config-tamper integrity via AstLinterEngine/TypecheckGate) with instant abort before benchmarks; (3) per-metric `runBenchmark` → `computeMetricResult`; (4) `computeFitnessVerdict` (weights normalized, 2.5% significance, MAD tail guard).
3. Frozen harness: `initializeHarness` copies invariant-command file paths + new `metrics[].harnessScripts` config extension into `<repo>/.perfgym/.harness` read-only (0444/0555); empty harness ⇒ harness stay null and stage 3 skips enforcement (never blocks benchmarking). Mid-flight writable chmod ⇒ benchmark -Inf.
4. `packages/core/src/index.ts`: export line + `harnessScripts?: string[]` on the metric config type.

### Deviations / Notes
* Constructor's 3rd param is optional (`typechecker?: TypecheckGate`) — the linter's `scan` already embeds the two-tier gate; the explicit gate adds an independent integrity/tier-2 check when a tsconfig exists.
* Benchmarks execute sequentially per metric (per #13); missing `baselineMetrics` entry ⇒ Δ% 0 ⇒ insignificant rejection.
* `Effect.catchIf` used for in-band typed failure envelopes (this Effect v4 build has no `Effect.either/catchAll`; `Cause` introspection on private-field classes is unreliable).
* Vitest needs relative imports (`../../../linter/src/engine.js`) since packages have no runtime package.json/aliases.

### Verification Results
* `npx vitest run packages/core/src/pipeline/pipeline.test.ts`: 18/18 green (happy path, stage-1/2/3 short-circuits via side-effect sentinel files, insignificant noise, tail-guard breach, weights, harness freeze + mid-flight tamper, timeout clamp, InMemorySandboxDriver integration, retries=2 legacy ignored).
* `npx vitest run` full suite: 16 files, 182 tests green (matcher micro-benchmark is load-flaky under heavy parallel CPU load — passed on re-run; pre-existing).
* `npx tsc --noEmit`: 0 errors.
