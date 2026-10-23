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
