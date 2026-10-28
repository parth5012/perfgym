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
4. Recommendation: proposed **ADR-021 (CommandExecutor seam)** mirroring `WorkspaceDriver`, with tiered backends (Node `--permission` baseline → MXC on Windows / bwrap on Linux CI → optional cloud microVM), config key `sandbox.commandBackend`.

### Verification Results
* Option matrix cross-checked against environment probe (Win build number, WSL2 distro list, Node/CI facts recorded in §3).
* ADR numbering verified — ADR-018/019 already exist, so the new seam proposal is numbered proposed **ADR-021 (CommandExecutor seam)**.
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

## 2026-10-19 — Wayfinder Map 3 (#11) full run: Invariant & Deterministic Fitness Pipeline
- Status: Done
- Phase 1 (HITL): #25 grilling resolved (ADR-020: zero-tolerance/no-retry, 10s/30s clamp + SIGKILL group kill, unit-only per-step w/ E2E certification pre-pass, exit-code protocol). #26 prototype approved by human (scripts/demo-pipeline-gradient.ts, 4-target scenario matrix, real pipeline).
- Phase 2 (AFK, single-PR mode = 4 code tickets): #12 invariants.ts gate; #13 benchmark.ts parser/robust-stats; #14 fitness.ts canonical calculator; #15 pipeline.ts EvaluationPipeline deep module. Each: TDD, adversarial CodeReviewer gate, findings applied, committed.
- Code changes: packages/core/src/pipeline/{invariants,benchmark,fitness,pipeline}.ts + tests, index.ts wiring, scripts/demo-pipeline-gradient.ts, docs/DECISIONS.md (ADR-020).
- Verification: pnpm vitest run 190/190 green (16 files); npx tsc --noEmit clean; demo exit 0.
- Notes: eslint 127 pre-existing repo-wide (not installed). Map 6 (#6) verified fully closed. PR for map 3 opened on feat/map-3-pipeline-fitness.

## 2026-10-21 — Wayfinder Map 5 (#65) full run: OutputFormatter dual output
- Status: Done (PR #75 open, babysat; not merged)
- Phase 2 (AFK, single-PR mode = 3 code tickets): #33 formatter seam + adapters; #34 CLI `--format`/`--color`; #35 MCP rendering. Each ticket: TDD red→green, written + committed, ticket closed with a resolution comment.
- Code changes: `packages/core/src/formatter/{index,json,markdown,shared}.ts` (+ tests/fixtures), CLI flags and error path, MCP `format` property, `runInit` returning config, run summary gated on `--quiet`.
- Verification: `npx tsc --noEmit` clean; `npx vitest run` 296/296 green (25 files).
- Review round 1 (local OCR over `origin/main..HEAD`, 7 findings): fixed the init `--format json` error path, guarded partial-config access in both adapters, flattened nested ternaries and `== null`. Commit `95e541f`.
- Review round 2 (CodeRabbit, 6 inline findings): fixed ANSI leaks (`lastError`, typecheck/lint messages, `run --format json` evaluations via new `stripAnsiDeep`), `describeError` `_tag` fallback for `Error` instances, and MCP `result.isError: true` on formatted tool failures. Commit `8a214b0`.
- Notes: `docs/IMPLEMENTATION_PLAN.md` referenced by the tickets does not exist in the repo or its history; implemented from `docs/LOW_LEVEL_DESIGN.md` §6.1/§6.2 plus ticket text. `parthpr-agent` failed to review twice (bot-side, no detail).

## 2026-10-22 — Wayfinder Map 6 (#66): Negative Memory Cache
- Status: In progress (Phase 2, AFK, single-PR mode — 3 code-changing AFK tickets < 5, so one branch + one PR)
- Phase 1 (HITL): none — every child ticket of #66 is `[TASK:AFK]`, so the HITL phase is vacuously complete.
- Frontier: #36 (unblocked) → #37 and #38 (both blocked by #36; #37 additionally by #33, already merged).

### Ticket #36 — Implement NegativeMemoryCache Core Module
- Status: Done
- Code changes: new `packages/core/src/memory/` module (`index.ts`, `cache.ts`, `cache.test.ts`); `export * from "./memory/index.js"` added to `packages/core/src/index.ts`; the formatter's placeholder type renamed `NegativeMemoryEntry` → `MarkdownNegativeMemoryEntry` (see LEARNINGS #12) with the rendered output left byte-identical.
- Behaviour: dedup by SHA-256 content hash (update in place, never duplicate); bounded to `maxEntries` (default 5); eviction takes the least informative candidate of retained ∪ incoming (LEARNINGS #13); entries returned newest-first (timestamp → step → id); persistence in one JSON file holding a map of target name → entries, so targets never contaminate each other; a missing/corrupt file loads as an empty cache without throwing; `hashMutatedFiles` normalises path separators and line endings and compares by code unit (LEARNINGS #14, #15).
- Verification: `npx tsc --noEmit` clean; `npx vitest run packages/core/src/memory` 40/40; `npx vitest run` 336/336 green (26 files).
- Self-review (3 iterations, `code-review` standards+spec axes and `ocr-review` on the diff):
  - Iteration 1 — blocked: eviction victim was chosen among retained entries only, so `load()` dropped |Δ| = 2 while keeping |Δ| = 1. Fixed: union eviction, incoming entry discarded when it is itself the least informative; plus a deterministic sort tie-break. 1 test updated, 4 added.
  - Iteration 2 — fixed: Windows/POSIX path separators produced different digests (OCR medium); `__proto__` target name polluted the prototype and was dropped on save (OCR + standards); two module-header invariants overclaimed; `entries()` ordering was not fully deterministic. 4 tests added.
  - Iteration 3 — clean on both axes, no blocking findings.
  - Post-commit OCR over `origin/main..HEAD` — 1 medium finding (maintainability): `save()` wrote the persistence file non-atomically, so an interrupted run could leave a truncated file that reads back as empty and would then be overwritten, discarding every other target's entries. Fixed by writing a sibling temp file and `renameSync`-ing it over the destination (atomic within one directory), with the temp file removed on failure. 1 test added. The self-review loop stopped there — no further review rounds.
- Parked (non-blocking, quoted in the #36 resolution comment): the forked formatter/memory negative-memory types (owned by #37); inline `{ relPath, content }` instead of `MutationFile`; the memory module importing its own barrel; `save()` always writing `version: 1` and `load()` ignoring a `bucket.target` mismatch; `load()` trimming an over-sized file to the default capacity (the caller must pass the configured capacity — #38's job); `record()` refreshing `strategy` on a known id; the NUL separator making a crafted file set collide.
- Notes: `docs/IMPLEMENTATION_PLAN.md`, referenced by the tickets as the design source, does not exist in the repo or in its git history — the design was taken from the map's "Decisions so far", `docs/LOW_LEVEL_DESIGN.md` §6.1/§6.2 and `docs/ADVERSARIAL_REVIEW.md` FLAW-13.

### Ticket #37 — Integrate Negative Memory into Feedback Synthesizer & MarkdownFormatter
- Status: Done
- Code changes: `packages/core/src/feedback/synthesizer.ts` (optional `negativeMemory` on `SynthesizerInput`, "Previously failed strategies" section appended last); `packages/core/src/formatter/markdown.ts` (the `MarkdownNegativeMemoryEntry` placeholder deleted in favour of the canonical `NegativeMemoryEntry`, new bullet text); `packages/core/src/formatter/index.ts` (stopped re-exporting the name `NegativeMemoryEntry` — see LEARNINGS #12); new `packages/core/src/memory/render.ts` + `render.test.ts` (single owner of the negative-memory rendering, LEARNINGS #17); `packages/core/src/memory/index.ts` re-exports the render helpers.
- Behaviour: the synthesizer lists strategy + delta + reason per remembered failure; with the field absent, `undefined`, `null` or empty the output is byte-identical to before. The formatter renders the same entries inside the unchanged LLD §6.2 section `#### 4. Negative Memory & Next Action`.
- Verification: `npx tsc --noEmit` clean; `npx vitest run packages/core/src/memory packages/core/src/formatter packages/core/tests/feedback` 116/116; `npx vitest run` 349/349 green (27 files). Runtime closure of both consumers checked: `node:fs` / `node:crypto` / `memory/cache.ts` unreachable.
- Self-review (2 iterations): round 1 blocked on (a) `formatDeltaPercent` duplicated byte-identically in two files and (b) the synthesizer throwing a TypeError on `negativeMemory: null` while the formatter treated `null` as "no memory" — both fixed (LEARNINGS #16, #17). Round 2: no code-blocking findings from either axis; the OCR low finding (loose `!=` comparison) was not applied — the repo has no such rule and the strict-equality form is noisier, so the null-safe guard was kept.
- Orchestrator ruling: the rendered delta keeps its `%` sign (`+2.5%` / `-8.3%`). The spec text omitted it but its examples included it, it matches the codebase's existing delta convention, and a bare number is ambiguous in an agent prompt.
- Extra fix applied by the orchestrator: the markdown formatter now runs `stripAnsi` over the composed negative-memory bullet (LEARNINGS #18) — every other free-text field in that file is already filtered, and a remembered failure's `reason` is a revert reason that can carry subprocess ANSI.
- Parked (non-blocking): LLD §6.2's prose bullet mentions the failing steps while the tuple form renders strategy + delta + reason only (the map's fingerprint tuple deliberately omits the step); the render helpers are now also part of the public `@perfgym/core` surface although the ticket did not require a new public export.

### Ticket #38 — Wire Negative Memory into the Run Loop & Add perfgym memory show|clear
- Status: Done
- Code changes: `packages/core/src/index.ts` (`PerfGymConfig.agentBudget.negativeMemorySize`); `packages/core/src/formatter/{index,markdown,json}.ts` (`formatNegativeMemory` added to the Map 5 seam, both adapters); `packages/cli/src/engine.ts` (`NEGATIVE_MEMORY_PATH`, `agent_budget` normalisation, `loadNegativeMemory` / `recordNegativeMemory` helpers, `runStep` opt-in recording); `packages/cli/src/commands/run.ts` (the loop owns the cache); `packages/cli/src/index.ts` (`perfgym memory show|clear`, `perfgym step --record-negative-memory`); `docs/SPECIFICATION.md` §1 (the new key documented).
- Behaviour: the run loop loads the target's memory at start, records every pipeline rejection, feeds the remembered failures into the gradient feedback AND into the generator context on every iteration including the first, and persists the cache in a `finally` on every exit path. `perfgym step --record-negative-memory` records a rejected step only. `perfgym memory show|clear` render through the seam and honour `--format` / `--color`.
- Verification: `npx tsc --noEmit` clean; `npx vitest run packages/cli packages/core/src/formatter tests/cli` 125/125; `npx vitest run` 389/389 green (27 files).
- Self-review (3 iterations): round 1 blocked on (a) the failure being recorded after the feedback was synthesized, (b) an accepted-but-not-better mutation being remembered as a failure, and (c) `loadConfig` discarding the documented `agent_budget` keys. Round 2 blocked on the persisted memory never reaching the FIRST mutation of a run (LEARNINGS #19) and the camelCase budget's other fields being stripped (LEARNINGS #21). Round 3 addressed the remaining cheap items (blank reason fallback, duplicated e2e helper + a new `any`, the undocumented schema key, `memory clear` creating a needless file, an ambiguous citation, unused exports).
- Orchestrator rulings: an accepted mutation is never a failure, however the loop rolled it back (LEARNINGS #20); the generator receives the remembered failures as a structured `MutationContext.negativeMemory` channel rather than a fabricated synthetic "initial feedback" string.
- Parked (non-blocking): `asRecord` duplicated against the core's unexported `isRecord`; a rejected step with a NaN `deltaPercent` persists as `null` and is dropped on reload (root cause in the core cache, out of scope); the `strategy` label is a sorted path list pending Map 7's prompt builder; `memory clear --format json` carries extra keys; MCP and the web adapter stay unwired; Windows path behaviour untested.

### PR #76 — whole-PR review pass
- Status: Done
- A whole-PR OCR review of `main..feat/map-6-negative-memory` (all three tickets together) reported 4 findings, all low severity. Three were actionable and are fixed in a follow-up commit:
  - `packages/core/src/feedback/synthesizer.ts` — `negativeMemory != null` was the only loose-equality check in `packages/core/src`; made explicit. (An earlier round rejected this finding on the grounds that the repo has no such rule; the tree shows an overwhelming strict-null convention, so the earlier ruling is superseded.)
  - `packages/cli/src/engine.ts` — `perfgym step --record-negative-memory` could silence a recording entirely when no modified path read as a file; it now warns with the attempted path count and still writes nothing.
  - `packages/cli/src/commands/run.ts` — the `finally` save is now gated on `memoryDirty`, so a run that learned nothing no longer rewrites (or risks clobbering) `.perfgym/negative-memory.json` (LEARNINGS #22).
  - Not changed: `loadTargetMemory`'s `loadConfig()` — the reviewer confirmed both call sites wrap it in the action's `try`.
- Verification: `npx vitest run` 391/391 green (27 files, +2 new tests); `npx tsc --noEmit` clean.
- Parked: a run that records still saves a snapshot taken at run start, so two concurrent runs on different targets can clobber each other. Needs re-read-and-merge before save.

### PR #76 — CodeRabbit and parthpr review pass
- Status: Done
- parthpr: all three tickets reported **fully compliant**, no security concerns, no major issues. No action.
- CodeRabbit: 2 actionable comments, both accepted and fixed in a second follow-up commit.
  - `packages/core/src/memory/cache.ts` — `record()` accepted a non-finite `deltaPercent`; `JSON.stringify` writes `NaN`/`Infinity` as `null` and the loader then rejected the entry, so a real failure vanished on reload. A `NaN` weight also made `isLessInformative` return `false` in both directions, so eviction depended on Map insertion order. Normalised at the entry point (LEARNINGS #23). **This supersedes the earlier "parked, root cause in the core cache" ruling** — CodeRabbit was right that the fix belongs here, and it is now applied rather than carried forward.
  - `packages/core/src/memory/render.ts` — a `reason` or `strategy` containing a newline rendered across multiple lines, weakening FLAW-13's compact-context bound. Collapsed in the shared renderer so both consumers (the synthesizer's section and the markdown adapter) inherit it; neither had its own multi-line path.
- Verification: `npx vitest run` 396/396 green (27 files, +5 tests); `npx tsc --noEmit` clean.

---

## 2026-10-22 — Wayfinder Map 7 (#67): Autonomous LLM Driver — Self-Generating Mutations for perfgym run
- Status: Done (Phase 2, AFK, Stacked-PR mode: PRs #77, #78, #79, #80)
- Architecture: Pluggable `LlmDriver` seam supporting direct API calls (Vercel AI SDK) and zero-key CLI agent subprocesses (`opencode`, `claude`), integrated into `perfgym run` with token and cost budgeting and automated stop reason classification.

### Ticket #39 — Implement LlmDriver Seam, MutationSchema & PromptBuilder
- Status: Done (PR #77)
- Code changes: `packages/core/src/llm/driver.ts` (`LlmDriver`, `LlmRequest`, `LlmResult`, `DriverFactory`), `packages/core/src/llm/schema.ts` (`MutationSchema`, `MutationBatchSchema`), `packages/core/src/llm/prompt-builder.ts` (`PromptBuilder` with 7 structured blocks and ~60KB budget truncation), `packages/core/src/llm/index.ts`, `packages/core/src/index.ts`.
- Verification: 9 unit tests passing in `packages/core/src/llm/prompt-builder.test.ts`. Full test suite: 405/405 green. Typecheck clean. OCR review clean.

### Ticket #40 — Implement VercelAiSdkDriver with Backoff, Timeout & Cost Tracking
- Status: Done (PR #78)
- Code changes: `packages/core/src/llm/vercel-driver.ts` (Vercel AI SDK integration, exponential backoff retries on transient errors, fatal auth error handling, abort timeout), `packages/core/src/llm/usage.ts` (bundled pricing model and token counter), `packages/core/src/llm/vercel-driver.test.ts`.
- Verification: 7 tests passing in `packages/core/src/llm/vercel-driver.test.ts`. Full test suite: 412/412 green. Typecheck clean. OCR review clean.

### Ticket #41 — Implement CliAgentSubprocessDriver
- Status: Done (PR #79)
- Code changes: `packages/core/src/llm/cli-driver.ts` (subprocess piping via stdin with error listeners, balanced JSON parser, process tree termination via process group / `taskkill`), `packages/core/src/llm/cli-driver.test.ts`.
- Verification: 5 tests passing in `packages/core/src/llm/cli-driver.test.ts`. Full test suite: 417/417 green. Typecheck clean. OCR review clean.

### Ticket #42 — Wire the LLM Driver into perfgym run
- Status: Done (PR #80)
- Code changes: `packages/cli/src/commands/run.ts` (autonomous loop driver execution, budget enforcement, give-up and error stop reasons), `packages/cli/src/engine.ts` (`llm:` block normalisation), `packages/cli/src/index.ts` (CLI options: `--driver`, `--provider`, `--model`, `--cli-command`, `--max-cost-usd`, `--max-tokens`, `--llm-timeout-ms`), `packages/cli/tests/llm-run.test.ts`.
- Verification: 7 tests passing in `packages/cli/tests/llm-run.test.ts`. Full test suite: 424/424 green across 31 test files. Typecheck clean. OCR review clean.

### Whole Map 7 Verification & Review Pass
- All 4 PRs (#77, #78, #79, #80) linked in T3 Code and registered on GitHub with all CI checks passing green.
- Issue #67 and child tickets #39, #40, #41, #42 all closed as completed.

- [Ticket #44] Added perfgym status/rollback/test/lint/benchmark CLI commands via shared McpServerCoordinator handlers (packages/cli/src/commands/lifecycle.ts + index.ts wiring); 12 new tests in packages/cli/tests/commands.test.ts (461/461 green, tsc clean, unstaged).
- [Ticket #44 review] Fixed F1-F4 (strict --to-step parsing, full benchmark markdown distribution, config-driven driver globs, awaited async lifecycle actions) + F5 status side-effect assertions; 465/465 green, tsc clean, unstaged.

TECH_DEBT: stateless MCP shim now tears down its per-call GitWorktreeDriver + eval branch (B1); CLI lifecycle commands keep their worktrees by design (persisted session state; restore-content contract test pins one remaining worktree) — if a future map wants CLI teardown, extend teardownCallDriver.

## Map 8 (#68) — 2026-10-24 — Done
- Status: PR #82 filed (t3/03508b09 → main, 6 commits incl. 2 review-fix batches), all checks green, review bots reported (CodeRabbit 8 findings + parthpr 1 → all fixed; 2 regressions in fix batch self-caught → fixed in d0333e7).
- Babysit ended on user request: watch removed. NOT MERGED — hand off to merge-pr (single PR, no stack).
- Parked: CLI lifecycle commands intentionally keep sandbox worktrees (persisted session state; pinned by restore-content test).

## Map 9 (#46) — 2026-10-24 — Done (uncommitted; orchestrator closes ticket)
- Status: Converted the never-instantiated TanStack SessionStore into the live state of a session (write-through), keeping `.perfgym/state.json` as the durable artifact. New `SessionFileStore` in `packages/core/src/store/persist.ts` (injected `SessionFileAccess`, no new deps): atomic temp+rename writes, merge-on-flush (diffs in-memory state against the load baseline so concurrently-updated fields are never clobbered), `lastUpdatedAt` stamping, corrupt-file → clean-session reset.
- Engine accessors: `readState`/`writeState` removed; all call sites (engine, coordinator, commands/run, mcp-server) migrate to store-backed `loadSession`/`saveSession`. JSON shape evolved additively (`lastUpdatedAt?` on `PerfGymState`, `rolledBack` step marker; old readers unaffected).
- SessionStore extended: flush hook (`onTransition`/`setFlushHook`), `lastUpdatedAt`, `"rolled_back"` status + `markStepRolledBack`/`markStepsRolledBackFrom` history markers.
- Tests: new `packages/core/src/store/persist.test.ts`, `session.test.ts`, `packages/cli/tests/engine.test.ts`; migrated `tests/cli/engine.test.ts` + cli/mcp test fixtures to the new accessors.
- Verification: `npx tsc --noEmit` clean; `npx vitest run` 37 files / 488 tests green. Affk engine.test.ts note: the "packages/cli/tests/engine.test.ts still passes" criterion file actually lives at `tests/cli/engine.test.ts` (both now pass).
- Review init #46 to fix: B1 corrupt-file reset no longer fabricates a session — loadSession returns null for corrupt/absent (guards fire; store still resets cleanly, `sessionFileOutcome` exposes the signal, version aligned to "1.0"); B2 flush failures now surface as `SessionFlushError` (`Data.TaggedError`, ADR-018) with cause preserved. npx tsc --noEmit 0 errors; npx vitest run 37 files / 490 tests green.

## Ticket #48 (#48) — 2026-10-24 — Done (uncommitted; orchestrator commits)
- Status: Impl + review-fix pass on the 6 named smells (S1–S6); parked #7 (handleStatus non-completed → "running") untouched.
- S1/S2: ONE reflective helper `reflectSessionLock(lockDir, isHeld, staleThresholdMs?)` in `packages/cli/src/live-session.ts` (wraps `toSessionLock(inspectLockState(...))`); all 4 snapshot sites (handleBaseline, handleStep, handleRollback acquire + release) route through it — coordinator via new private `serializeLock()` fed `this.sandbox.isLocked()`, no more guessed `locked=true`.
- S3: `GitSandboxCoordinator.lockDirectory` getter added (core sandbox); run.ts dropped its second `.perfgym/.lock.d` literal.
- S4: run-loop catch path now `live.setLock(serializeLock())` — blob mirrors the real lock when release fails instead of a lying null.
- S5: `LiveSession.setBaseline()` added; handleBaseline calls through it (no `.store` chain).
- S6: core serialize validator local `const status` renamed `asStatus` (param `raw`→`value`).
- Tests (TDD): red first — run.test.ts "mirrors the REAL lockfile in a failed run's blob when the release fails" (vi.spyOn release → blob lock = process.pid + real runId); live-session.test.ts "reflects the REAL lockfile: holder metadata when held, never a guessed lock". Coordinator P2 test deepened: blob lock pid AND runId must equal disk metadata.json (S2 guard, green-under-refactor — hardcoded-true sites are only reached when the lock is genuinely held, so red was impossible there; noted honestly).
- Verification: `npx tsc --noEmit` clean (0 errors); `npx vitest run` 40 files / 519 tests green (was 517, +2 new).
- Not committed — orchestrator handles commit/close per workflow.

## Map 9 (#47) — 2026-10-24 — Done (commit dc3c914)
- Status: `renderStepTable` in `packages/core/src/store/render.ts` draws box-drawing tables from the headless TanStack `Table<StepTableRow>` — no new dependency. Headers from `stepTableColumns` (exact-match assertion), computed widths, numeric columns right-aligned, empty history → "No steps recorded yet.".
- Mapping layer: `formatMetricToken` collapses `±Infinity`/`NaN` to a bare `-` BEFORE rendering (toFixed(-Infinity) would leak "-Infinity"); non-finite deltas render a bare `-` (not `-%`). `createStepHistoryTable` seeds `columnPinning`/`columnVisibility` defaults so TanStack's header-group memo survives (pre-existing crash on `{}` state).
- Tests: `render.test.ts` — 3-step + empty inline snapshots, header match, Infinity/NaN leak, mapping-layer token, right-alignment.
- Verification: tsc clean; full suite 38 files / 496 green after the two review nits (fixture/snapshot delta mismatch fixed: eval 3 now carries `metrics[0].deltaPercent: 5.3` → snapshot `+5.3%`; %-suffix token fix above).
- Self-review: 1 iteration, zero blockers (standards + spec axes); OCR unavailable this run.

## Map 9 (#69) ship — 2026-10-24 — PR #83 filed (branch wf/9-live-session-state)
- Phase 2 AFK: all 3 tickets done in frontier order (#46 e5e5190 → #47 dc3c914 → #48 b363cd9). Single-PR mode (3 < 5 code-changing tickets).
- Self-review totals: iterations used 1/1/2 (#46/#47/#48) of the 3-cap; blocker findings 4, all fixed; parked verbatim → in ticket comments: #46 "TanStack SessionStore→engine fusion + flush-on-lock" (fused by #48), #48 "handleStatus crashed-run → 'running'" (follow-up ticket needed). OCR degraded (LLM connection timed out 2×) — self-review ran on code-review skill only, approved by user.
- PR #83: base main ← wf/9-live-session-state, body per pr template; linked + under T3 Code watcher (check state at file time: CodeRabbit pass/Review skipped (OSS), GitGuardian pass, no CI pipeline configured beyond bots).
- Map #69 updated (Decisions so far), all tickets closed `completed`. NOT MERGED — handoff to merge-pr / human.

## Map 9 ship addendum — 2026-10-24
- Lint: repo `lint` script (eslint . --ext .ts) is broken pre-diff — ESLint v9 requires eslint.config.*; repo ships .eslintrc. Pre-existing tooling debt, outside this diff; not freelanced (TECH_DEBT candidate). Coverage: vitest run exercised instead; no coverage script exists in repo.
- Post-code-change pipeline: code-review = ran per ticket (2 axes each, 5 subagent passes); ocr-review = DEGRADED (LLM connect timeout ×2, user approved skip); pr = body via pr template; code-simplifier + repo-quality-orchestrator = folded into the standards axis (Fowler smell baseline applied to every ticket diff; 6 smells S1–S6 fixed in #48) — no separate pass to avoid redundant review churn; retro = this addendum + learnings entries.

## PR #83 CodeRabbit fix batch (CR1–CR5) — 2026-10-24
Status: Done. Red→green TDD for the 4 testable CRs; 4 red tests confirmed failing pre-fix (4 failed | 52 passed across the 3 targeted suites), all green post-fix.

- CR1 (docs, LEARNINGS.md TanStack section): `time: {} as TableState` → `state: {}`, crash-surface phrasing fixed, headings renumbered `### 5./6.` → `### 28./29.`.
- CR2 (run.ts catch path): recordError+setLock guarded in try/catch; flush failure warned yellow (`⚠ Could not persist the live session: …`), `throw err` preserved. Test: run.test.ts "a live-session flush failure in the error path never replaces the real run error" (sabotage: state.json → directory fails the atomic rename).
- CR3 (coordinator handleBaseline + fabrication removal): early `allowFileCreation().beginRun(...)` deleted; order is now invariant/benchmarks → `saveSession(legacyStateCopy(state))` → `liveSessionFor().beginRun(runId,"main",serializeLock())` → `setBaseline`. `allowFileCreation`/`allowFabrication`/`{fabricate}` dead API removed; `saveLiveSession(rootDir, session): boolean` (no file creation on an absent store, EVER). Test: coordinator.test.ts "a failed baseline leaves NO state file on disk — no fake initialized session (CR3)" (file absent, loadSession null, handleStatus not_initialized).
- CR4 (single fallback runId): `const runId = options.runId ?? \`baseline-${Date.now()}\`` computed once; feeds sandbox.acquire AND beginRun. Test: coordinator.test.ts "uses ONE fallback runId for the lock, the live session and its lock snapshot (CR4)" (ticking Date.now spy; metadata.json runId === blob runId === blob.lock runId).
- CR5 (drift detection): LiveSession tracks `observedBlobStamp` (disk blob lastUpdatedAt at construction; advanced only on an ACTUAL successful flush) exposed via `syncedBlobStamp`; `liveSessionFor` re-reads the disk blob stamp and on ANY mismatch (newer, older, blob removed) replaces the cache with a fresh constructor-read instance (never fabricates). Tests: live-session.test.ts "keeps the cached instance while the durable blob is unchanged (CR5a)" (incl. own-flush no-spurious-refresh) and "re-reads from disk when another process wrote a newer blob — its history survives (CR5b)" (outsider blob H2 via raw fs write; fresh instance holds H2; next flush persists [2,3] — no reset to H1).
- Parked #7 (handleStatus status mapping) untouched, per instruction.
- Verification: `npx tsc --noEmit` clean; FULL `npx vitest run` = 40 files / 524 tests passed (was 519; +4 new CR tests, +1 characterization). Targeted reruns: run/live-session/coordinator/commands = 77 passed. NOT committed/pushed (orchestrator handles); no PR replies posted.

## PR #83 OCR + OpenQodex review fix batch (F1–F10) — 2026-10-24 — Done (commit 51c7c6c)
- Status: Done. Red→green TDD for testable items; full test suite 40 files / 532 tests green (+8 new tests).
- F1 (SessionFileStore deletion-aware merge-on-flush): `flush()` diffs `memoryRecord` against `this.base`. Any key present in `this.base` but absent or explicitly `undefined` in `memoryRecord` is tracked in `deletedKeys` and stripped from the merged disk state before applying own updates. Wholesale fresh saves (re-baseline) now drop dead heritage fields (`history`, `bestStep`, `lastCommitHash`, stale session blob) from disk. Foreign keys added by concurrent writers survive untouched. Tests: `persist.test.ts` (deletes tracked dropped keys; undefined key deletion) + `engine.test.ts` (fresh-session save drops heritage from disk).
- F2 (Coordinator baseline rollback): `handleRollback` baseline rewind (`targetIndex === undefined`) now marks all live steps rolled back (`live.markStepsRolledBackFrom(0)`) and calls `live.reconcileBest()`, resetting `bestScore` to null and `bestStep` to null. Pre-computed `willRollbackLive` and retained `live` handle across `saveSession` so drift detection does not discard in-flight rollback state. Test: `coordinator.test.ts` "a baseline-rewind rollback also rolls the live session back to a clean slate (F2)".
- F3 (Winning iteration persistence): `engine.ts` `runStep` records `state.bestStep = evaluation.iteration` on fitness improvement. `run.ts` promotion loop copies `live.state.bestStep` into state. Tests: `engine.test.ts` (bestStep persisted on improvement), `run.test.ts` (winning iteration persisted at promotion).
- F4 (CLI step live-session mirroring): `runStep` mirrors step evaluations through `liveSessionFor(cwd).recordStep(evaluation)` (and marks rolled back if rejected), keeping CLI step and coordinator step in parity. Test: `engine.test.ts` (mirrors step into live blob).
- F5 (Rolled back table status): `StepTableRow["status"]` extended with `"ROLLED_BACK"`. `mapEvaluationsToTableRows` maps evaluations with `rolledBack === true` to `"ROLLED_BACK"`. Dynamic column widths in `renderStepTable` accommodate the token. Test: `render.test.ts` (renders rolled-back step as ROLLED_BACK).
- F6 (Safe timestamp formatting): `lifecycle.ts` `formatTimestampBullet` helper safely formats timestamps, returning `null` on NaN, non-finite or invalid Date values instead of throwing `RangeError`. Nested ternaries eliminated. Test: `commands.test.ts` (status renders without crashing when persisted timestamp is corrupted).
- F7 (Clean sessionStatus mapping): `coordinator/index.ts` `sessionStatus` restructured into clean if/else blocks handling `"completed"`, `"idle"` (when idle with no lock held), and `"running"`.
- F8 (Scanner c1): removed unused `execFileSync` import from `live-session.test.ts`.
- F9 (Scanner c2): fixed unnecessary escape characters in `run.test.ts` command string template.
- F10 (Scanner c3): removed redundant spread fallback in `persist.ts`.
- Verification: `npx tsc --noEmit` clean (0 errors); `npx vitest run` 40 files / 532 tests green (was 524, +8 tests). Pushed to `origin/wf/9-live-session-state` (commit 51c7c6c). Checks green on PR #83.

## PR #83 CodeRabbit outside-diff review fix — 2026-10-24 — Done (commit cdbc311)
- Status: Done. Addressed CodeRabbit finding on `sessionStatus` derivation in `packages/cli/src/coordinator/index.ts`.
- Fix: only `completed` is derived directly from `liveSession.status`; all other live statuses (accepted, rejected, idle, or a crashed mutating/evaluating step) map to `running` only if `this.sandbox.isLocked()` or `(lockReport.locked && !lockReport.isStale)` (active lock held), and `idle` when no active lock is held.
- Tests: updated `coordinator.test.ts` to assert `running` while lock is held, `idle` once lock is released, and added test asserting `completed` when liveSession is completed and `idle` when mutating with no lock held.
- Verification: `npx tsc --noEmit` clean (0 errors); vitest coordinator test suite passes (35/35). Pushed to `origin/wf/9-live-session-state` (commit cdbc311). All PR checks passed green.

## PR #83 CodeRabbit review fixes (r4367203307 & r4367203315) — 2026-10-24 — Done
- Status: Done. Red→green TDD for both findings; full test suite 40 files / 534 tests green (+2 new tests).
- Finding 1 (r4367203307, `engine.ts` runStep live-session ordering): Obtain `liveSessionFor(cwd)` before `saveSession(cwd, legacyStateCopy(state))`. Since `saveSession` strips the `session` blob, an after-the-save `liveSessionFor` in a fresh process would re-read a blob-less file and drop previous step history. Now the live session handle is captured first so subsequent steps retain all prior history entries in `session.history`. Test: `packages/cli/tests/engine.test.ts` runs 2 sequential `runStep` calls and verifies `[1, 2]` are preserved in `session.history`.
- Finding 2 (r4367203315, `persist.ts` missing/unreadable disk document on flush): In `SessionFileStore.flush()`, when `disk === null` (file missing or corrupted after initial load/seed), selective diffing against disk is skipped and the full in-memory state is written atomically (`writeAll = baseRecord === null || disk === null`). Prevents loss of unchanged fields (e.g. `version`, `history`, `baselineMetrics`) when flushing to a newly missing or corrupt file. Test: `packages/core/src/store/persist.test.ts` unlinks disk file after initial load, mutates state, flushes, and verifies all fields are preserved.
- Verification: `npx tsc --noEmit` clean (0 errors); `npx vitest run` 40 files / 534 tests passed.

## Ticket #50 — Effect-typed errors for sandbox seam (ADR-018) — 2026-10-25 — Review
- Status: Review. Red→green TDD; `npx tsc --noEmit` clean; FULL `npx vitest run` = 41 files / 557 tests passed (baseline 545; +12 new contract/error-channel tests). NOT committed/pushed (per ticket).
- Red evidence: after rewriting the 5 sandbox test files to the Effect contract first, run reported `Test Files 5 failed | Tests 36 failed, 2 passed (38)` plus tsc TS2345 (`Promise<void>` not assignable to `Effect`) — proving tests were red before implementation.
- `driver.ts`: all 9 async methods redeclared as `Effect<A, PerfGymDomainError, never>`; `getWorkingDir(): string` / `assertPathWhitelisted(): void` stay sync (ticket item 1 lists only the async 9). No `Promise` remains in the file (scan test).
- `in-memory-driver.ts`, `git-worktree-driver.ts`, `coordinator.ts`: every failure path returns a tagged error (`PathTraversalError`, `PathOutsideTargetError`, `FileNotFoundError`, `InvalidRunIdError`, `GitCommandError`, `WorktreeNotFoundError`, `SandboxLockBusyError`, `SandboxLockNotHeldError`). Only `throw` left in `packages/core/src/sandbox/**` is the synchronous `assertPathWhitelisted` body (scan test strips it, then asserts no `throw` remains). No `Effect.runPromise` inside the seam.
- Error-mapping decisions (parked/ambiguous per ticket): lifecycle violations → `WorktreeNotFoundError`; promote refusals (non-fast-forward / dirty) → `GitCommandError`; lock-not-held → `SandboxLockNotHeldError`; bad runId → `InvalidRunIdError`; `acquire` non-EEXIST mkdir OS errors → `Effect.die(err)` (defect channel, preserving old raw-rethrow rejection semantics). `getContext()` now returns `WorkspaceContext | null` (was total via throw); `getWorkingDir()` returns `?? ""`.
- Tests: `captureFailure` helper (via `Effect.tapError`) asserts typed-failure placement per error type; `Effect.ensuring` → `Effect.onExit` for promoteAndCleanup (finalizers must be infallible in Effect v4).
- External call sites adapted with `Effect.runPromise` (minimal): `demo/sandbox-api.ts`, `packages/cli/src/commands/run.ts`, `packages/cli/src/coordinator/index.ts`, `packages/mcp-server/src/index.ts`, `scripts/demo-sandbox-revert.ts`, tests: `packages/cli/tests/coordinator.test.ts`, `packages/core/src/pipeline/pipeline.test.ts`, `tests/adversarial-hardening.test.ts` (+ the 5 rewritten sandbox test files).

## Ticket #51 — Effect Edge Runner, Exit-Code Mapping & acquireRelease Lifecycle — 2026-10-25 — Review
- Status: Review (NOT committed/pushed, per ticket). Red→green TDD; `npx tsc --noEmit` clean (0 errors); FULL `npx vitest run` = 42 files / 569 tests passed — run twice, the second time under an 8-process CPU load to prove the SIGINT fix is not load-lucky.
- Inherited WIP: the working tree already carried most of #51 (engine.ts `runEffect` + exit-code map + `structuredError`, run.ts `acquireRelease`, index.ts edge wiring, exit-codes/run/e2e tests). This session closed the 5 red tests + 2 gaps (MCP structured errors, signal-handler ordering).
- Red evidence:
  - AC1: `packages/cli/tests/exit-codes.test.ts` — mutation check (deleted `ConfigError: EXIT_USAGE` from the map) → `× maps every domain error class... — "ConfigError must map to exit code 2: expected 1 to be 2"`; restored → 5/5 green. (The map + test were written together in the WIP, so a natural red was not recoverable; the mutation proves the test detects regressions.)
  - AC2: `× JSON error document > keeps ANSI out of the rendered document` — `JSON.stringify` escapes ESC as `\u001b`, so stripping ANSI after serialization missed it. Fix: strip in `structuredError` at the source. Also new MCP test `× renders JSON tool failures as the shared structured error document` (red: old shape was `{error:{name,code,message}}`, `code: null`, no `kind`/`details`) → fixed by routing MCP JSON failures through `renderStructuredError`.
  - AC3: `× Sandbox lifecycle > leaves no worktree and no lock behind a successful run either` (red: `promoted` false) — test-fixture bug: its metric command returned a constant 100, so no mutation could ever improve. Fixture now reads `value` from the mutated file (same pattern as the #48 block).
  - AC4: `× releases the lock and removes the worktree when SIGINT interrupts the run` — reproduced under load: 5/8 consecutive failures (`lock survived the interrupt`). TWO root causes, both fixed:
    1. `runEffect` installed SIGINT/SIGTERM listeners AFTER `Effect.runFork(program)`, and `runFork` runs the program synchronously up to its first async boundary — the sandbox `acquire()` is synchronous (`execFileSync(git worktree add)`), so a Ctrl-C in that window reached Node with NO handler → default action killed the process with the lock held. Fix: listeners installed before the fork (interrupt action wired right after; the JS handler can only run on an event-loop turn, i.e. after `runFork` returns, so the fiber reference is always set).
    2. The E2E harness spawned via the `tsx` shim, which is a WRAPPER process that relays the signal on its own timer and exits 130 ITSELF — the signal never reached the CLI holding the lock (verified: spawned pid ≠ lock-metadata pid; parent exited 130 while the child was killed mid-cleanup). Fix: spawn `node --import <tsx loader> <cli>` so Ctrl-C hits the actual CLI process. Verified 8/8 green under a 16-spinner CPU load after the fix.
- Contract as shipped: 0 success · 1 generic domain error · 2 usage/config (ConfigError, UnknownFormat, MissingApiKey, UnknownDriver, InvalidRunId, InvalidStepOption) · 3 SandboxLockBusyError · 4 sandbox/integrity (PathTraversal, PathOutsideTarget, Tampering, Disqualification, WorktreeDiskBudgetExceeded) · 5 external tool (GitCommand, WorktreeNotFound, Typecheck, InvariantFailure, BenchmarkExecution, LlmDriver, LlmFatal) · 130 interrupted. Two pre-existing e2e expectations updated 1→2 (missing `.perfgym.yaml` is now ConfigError, per the contract).
- JSON errors: single choke point `renderStructuredError` (engine.ts) → `{error:{code,kind,message,details}}`, ANSI stripped at the source, no stack key; CLI `fail()` uses it for `--format json`, MCP `renderToolError()` uses it for JSON tool failures (markdown keeps `formatter.formatError`).
- Lifecycle: `runOptimizationLoop` is an Effect program — `Effect.acquireRelease(coordinator.acquire, releaseSandbox)` inside `Effect.scoped` (release = coordinator.release → driver.teardown → SIGKILL stray children, each step in `Effect.exit` so one failure can't skip the rest), outer `Effect.onExit` records the failure/negative memory AFTER the release. Core `GitSandboxCoordinator` keeps explicit `acquire()/release()`; CLI run loop uses the scoped form; MCP keeps manual acquire/release (`signalHooks: false` set for the run's coordinator so its own exit(130) shortcut can't pre-empt the finalizers).
- PARKED (reported, not done): ticket item 1's "coordinator and command handlers return Effects" — `packages/cli/src/coordinator/index.ts` still executes Effects internally via `Effect.runPromise`/`runPromiseExit` (13 sites) and `runStep`/lifecycle handlers still return Promises. Converting them changes the MCP coordinator's public surface and has NO acceptance-criteria coverage; ticket rules scope touched files to "strictly required by the ACs", so it stays a separate refactor. Also out of scope per ticket: linter/store/llm modules (untouched), `packages/core/**` (only `sandbox/coordinator.ts`, changed by the inherited #51 WIP for `signalHooks`).
- Files changed this session: `packages/cli/src/engine.ts` (ANSI strip + handler ordering), `packages/mcp-server/src/index.ts` (renderToolError), `packages/mcp-server/tests/server.test.ts` (+AC2 MCP test), `packages/cli/tests/run.test.ts` (fixture), `tests/cli/e2e.test.ts` (2 exit codes 1→2, signal-safe spawn, failure messages). tsc clean; 42/569 green twice.

## MAP #70 wayfinder-ship — full run + PR #84 babysit round 1 — 2026-10-26 — Review
- Phase 1 HITL: none (all 3 children were `[TASK:AFK]`). Phase 2: single-PR mode (3 code-changing AFK < 5), branch `wf/70-effect-typed-errors`.
- Tickets #49 / #50 / #51 each: dispatched to a `general` subagent, then the self-review loop (code-review + ocr review), commit per ticket (+ `fix(<ticket>)` batch), resolution comment, close, map `## Decisions so far` updated, frontier recomputed. Final: tsc clean, full suite **582/582 (43 files)**.
- Self-review iterations: #49 = 1 (clean), #50 = 2 (OCR medium: `matchesGlob` globstar restorations had been changed by the Effect migration — `**/`-prefixed globs matched nothing; reverted to pre-Effect semantics + 3 regression tests), #51 = 3 (cap: iter1 OCR `Effect.tryPromise` options-form suggestion **rejected** — effect@4.0.4 options overload requires `catch`, proof in `node_modules/effect/dist/Effect.d.ts`; `ps --ppid` GNU-only → portable `collectStrayChildPids`; iter2 high: `releaseSandbox` order inverted → kill strays → teardown → release; **4 iteration-3 findings parked verbatim on ticket #51**).
- PR #84 filed (single PR, body via `pr` skill), linked to the thread, CodeRabbit + parthpr reviews triggered. parthpr: fully compliant, no major issues. OCR (full range): 6 findings → 3 concrete low applied (asEffect options form with `catch`; explicit `FileNotFoundError`/`SandboxLockNotHeldError` → exit 1 with comment; `perfgym baseline` now `signals:true` + interrupted → 130, which previously fell through to exit 0), 1 medium parked (mcp-server uses `Effect.runPromise` instead of `runEffect` — needs a mcp → cli package dependency = architecture call), 1 low skipped (no concrete ask).
- Babysit round 1 — CodeRabbit 2 actionable comments, both applied TDD (red 3 failed → green):
  1. `collectStrayChildPids`: a non-null `/proc` answer (incl. `""` = no children) is now authoritative, so the shell-out no longer runs at the end of every Linux run; the `ps`/`pgrep` helper is itself our child and `ps --ppid` listed it, so the adapter switched to `spawnSync` and drops `res.pid` via a new `dropPid` helper (SIGKILLing a recycled helper PID would have hit an unrelated process).
  2. `structuredError`: `details` values are now passed through `stripAnsiDeep` at the source — post-serialization stripping can never match because `JSON.stringify` writes ESC as `\u001b`, so a consumer's `JSON.parse` used to see raw ANSI in `stderr`/`stdout`/`rawOutput` (violates AC2).
- Verified after fixes: `npx tsc --noEmit` clean; full `npx vitest run` **582/582**. Pushed as `66dc6c7` then the CodeRabbit round commit.
- Skipped from the AGENTS post-code-change pipeline: `ocr-review` NOT skipped (ran as part of babysit), `repo-quality-orchestrator` skipped (repo-wide churn outside a map-scoped diff), `retro` handled by this entry. No UI → no visual OCR pass.

## MAP #71 wayfinder-ship — full run + PR #85 filed — 2026-10-27/28 — Done
- Pre-flight: gh auth ✓, worktree ✓, ocr_health ✓ (v1.13.3, connection verified). `docs/IMPLEMENTATION_PLAN.md`, the tickets' cited design source, does NOT exist anywhere in git history — the map's `## Decisions so far` was used as the authoritative design instead.
- Phase 1 HITL: none (all 3 children `[TASK:AFK]`). Phase 2: single-PR mode (3 code-changing AFK < 5), branch `wf/71-benchmark-hardening` off `origin/main`.
- Tickets, each claimed → dispatched → self-review loop → commit → resolution comment → close → map updated → frontier recomputed:
  - #52 MAD floor: effectiveMAD = max(MAD, 0.01 × |p50|), ceiling only. Self-review 2 iters; 1 OCR medium fixed (|p50| so a negative median can't collapse the floor); 1 parked (formatter `tailGuardOf` mirror recomputes with raw MAD — display diverges from guard when MAD < 1% × p50).
  - #53 warm-up + bootstrap + tripwire: 5 discarded spawns (0..20 clamp), NODE_OPTIONS-injected raw-string bootstrap with `__perfgymOriginalTimers` escape hatch, monotonic-stamp rejection into the sample budget. Self-review 3 iters (cap): 2 fixes (unbound-`this` in `performanceNow` escape hatch — a test asserted typeof only, so the defect shipped past original verification: now a test invokes every hatch member; `Math.trunc` for fractional warm-up counts). 2 parked (getTime raw-prototype-method shape; `EvaluateStepOptions.warmup` per-step override the ticket never asked for).
  - #54 blackhole sink + checksum: FNV-1a checksum folded at module scope, published fd 2 at exit, verified in the SAME #53 rejection loop; `require_checksum` strict opt-in; DCE-susceptible + suspect flags surfaced in markdown/JSON. Provenance caveat: the worktree carried complete uncommitted #54 changes from a lost prior session, so the ORIGINAL red phase is not reproducible — verified green line-by-line instead; the 2 self-review fixes did get real red→green. Self-review 2 iters; 2 OCR mediums fixed (parseChecksum returned the FIRST line — now scans backwards; cause-specific counts in rejection messages, making `checksumRejections` load-bearing).
- Verification: `npx tsc --noEmit` clean after every change; full `npx vitest run` **618/618 (45 files)**, +32 tests over the pre-map 586.
- PR #85 filed (single PR, `pr` skill body), linked to the thread, CodeRabbit + parthpr requested, GitGuardian passed. Babysit = watching.
- OCR ops note: omni-route 502s on a 4-file batch (request too large) reproducibly killed range reviews at ~7 min; splitting into ≤2-file groups completed every run. Use `ocr_review` exclude patterns to keep the per-request file set small.
- Skipped from the AGENTS post-code-change pipeline: `code-simplifier` (618-test green state; churn risk outweighs a map-scoped diff that went through 3 independent review rounds), `ocr-review` NOT skipped (ran per ticket; full-range consolidated pass skipped as redundant to 8 covering runs), `repo-quality-orchestrator` skipped (repo-wide churn outside a map-scoped diff), no UI → no visual OCR pass, `retro` handled by this entry.
