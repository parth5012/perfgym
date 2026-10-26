# 🧠 PerfGym Learnings & Edge Cases

## Workspace Isolation & Security Edge Cases

### 1. Windows Drive-Letter Path Traversal
* **Problem**: Naive path traversal checks (checking if path starts with `/` or contains `../`) fail on Windows when inputs include drive letters (e.g. `C:\Windows\...` or `D:/sensitive/...`).
* **Solution**: Check for drive letters explicitly (`/^[a-zA-Z]:[\\/]/.test(relPath)`) and verify that `path.relative(workingDir, resolvedPath)` does not start with `..` or resolve to an absolute path outside the sandbox.

### 2. Glob Compiler Token Collision
* **Problem**: Converting `**/*` to RegExp by replacing `**` with `.*` and then `*` with `[^/]*` causes the single star pass to corrupt the globstar pattern.
* **Solution**: Tokenize `**` into a unique placeholder token (`___GLOBSTAR___`) before expanding single-star wildcards, then expand to regex wildcards.

### 3. Node.js Signal Interception & Uncontrolled Loops
* **Problem**: Registering custom listeners on `process.on("SIGINT", ...)` or `SIGTERM` prevents Node from terminating automatically. If the handler only releases the lock without calling `process.exit()`, the process continues running without concurrency protection.
* **Solution**: Explicitly call `process.exit(130)` for `SIGINT` and `process.exit(143)` for `SIGTERM` after synchronizing lock cleanup.

### 4. Git Worktree Subprocess Execution & Shell Injection
* **Problem**: Invoking `execSync("git " + cmd)` exposes the system to shell injection if branches, commit messages, or runIds contain shell metacharacters.
* **Solution**: Exclusively use `execFileSync("git", [args...])` with parameter arrays, completely bypassing shell evaluation.

### 5. Trust Boundary Inversion & Shell Mutation Evasion
* **Problem**: Whitelisting only `WorkspaceDriver.writeFile()` is ineffective when the evaluated AI agent has shell or direct filesystem access, as it can directly write to unwhitelisted files (`tests/`, `package.json`, etc.).
* **Solution**: Implement `verifyBlastRadius()` that scans the entire worktree via `git status --porcelain -uall`. Run this check before accepting or committing any step mutation.

### 6. Symlink and NTFS Junction Path Resolution
* **Problem**: `path.resolve` and `path.relative` only resolve lexical path strings. A symlink or junction point placed inside an allowed directory (`src/link -> ../../`) escapes lexical sandbox bounds.
* **Solution**: Inspect path segments with `fs.lstatSync` to detect symlinks and junctions, and verify `fs.realpathSync` against the physical working directory.

### 7. Git Status Porcelain Output Trimming
* **Problem**: Standard `output.trim()` strips leading whitespace from the first line of `git status --porcelain`, turning `" M file.ts"` into `"M file.ts"`. Fixed slice indexing (`line.slice(3)`) then corrupts filenames.
* **Solution**: Use regex parsing `/^[A-Z?0-9 ]{1,2}\s+(.*)$/` on un-trimmed split lines to reliably extract modified file paths.

### 8. Vitest Collects Fixture Files from Scratch Dirs
* **Problem**: Throwaway demo repos under `.tmp/` containing `tests/example.spec.ts` fixtures were picked up by vitest's default include glob (`**/*.{test,spec}.ts`), causing unrelated runs to fail with "No test suite found in file .tmp/...".
* **Solution**: Layered defense — (1) name demo fixtures so they never match test globs (`*.check.ts`), (2) add `**/.tmp/**` to `test.exclude` in `vite.config.ts`, (3) delete throwaway repos in test `afterEach` teardown.

### 9. Block Comment `*/` Embedded in Docstrings
* **Problem**: Writing `defaults to ["src/**/*"]` inside a `/** ... */` doc comment terminates the comment at `**/*` → esbuild parse error "Unexpected `*`".
* **Solution**: Never put literal glob text containing `*/` inside block comments; rephrase (e.g. "the src globstar pattern") or use a line comment.

### 10. Chalk Treats Bare `--color` argv as Force-Colour
* **Problem**: any CLI that passes a `--color <mode>` option leaks escapes even under `--color never | cat`, because chalk inspects `process.argv` itself and treats the mere presence of a `--color` flag as "force colour". Resolving the mode yourself is not enough.
* **Solution**: pin `chalk.level` (1 when enabled, 0 when disabled) from one authoritative `applyColorPolicy` call before emitting anything; formatters stay ANSI-free and the CLI applies colour around the finished string.

### 11. `JSON.stringify` Does Not Sanitise ANSI
* **Problem**: an escape sequence inside a string becomes `\u001b` in the JSON text and `JSON.parse` restores the real ESC, so `--format json` can still hand consumers ANSI when raw subprocess output (invariant output, revert reasons) is serialised. Stripping at the formatter boundary is not enough when a caller serialises domain objects directly.
* **Solution**: deep-clean JSON payloads (`stripAnsiDeep`) before `JSON.stringify`, preserving shape and non-string values, and strip again at the MCP boundary as a second guarantee.

## Bounded-Memory & Barrel-Export Edge Cases

### 12. Two `export *` Barrels Cannot Share a Name (TS2308)
* **Problem**: adding `export * from "./memory/index.js"` to a barrel that already did `export * from "./formatter/index.js"` fails to compile when both modules export the same type name — `error TS2308: Module "./formatter/index.js" has already exported a member named 'NegativeMemoryEntry'`. It is a hard error, not a warning, and it only appears once the second barrel line is added.
* **Solution**: give every type exactly one owner in the public surface. Rename the older placeholder type (here the formatter's `NegativeMemoryEntry` → `MarkdownNegativeMemoryEntry`) and drop its re-export from the intermediate barrel, so the canonical name is exported only by the owning module. Renaming a placeholder keeps the rendered output byte-identical — no behaviour change.

### 13. Bounded-Cache Eviction Must Consider the Incoming Candidate
* **Problem**: choosing the eviction victim among the *retained* entries only, then always inserting the incoming entry, lets a trivial failure (|Δ| = 0.1) evict an informative one (|Δ| = 8). Replaying a persisted file through that rule compounds it: reloading 6 entries (|Δ| = 1…6) into a 5-entry cache dropped |Δ| = 2 while keeping |Δ| = 1, so the retained set was no longer the "top N most relevant anti-patterns" the cache exists to hold.
* **Solution**: pick the victim from the *union* of retained entries and the incoming entry; if the incoming entry is itself the least informative, discard it and leave the cache untouched. Result: the cache always holds the N most informative failures, and a reloaded file trims to its own top N.

### 14. `localeCompare` Is Locale-Dependent — Never Use It For Content Hashes
* **Problem**: `Array.prototype.sort((a, b) => a.path.localeCompare(b.path))` orders by the *host's* locale, so the same file set can hash differently on two machines. A dedup key must be reproducible across hosts or the cache remembers the same failure twice.
* **Solution**: compare by code unit (`a < b ? -1 : a > b ? 1 : 0`) for anything that feeds a hash. Normalise path separators (`\` → `/`) and line endings (`\r\n` → `\n`) before hashing so a Windows mutation and a POSIX mutation of the same file produce one digest.

### 15. Maps Keyed By Untrusted Names Need A Null Prototype
* **Problem**: `const targets: Record<string, T> = {}` then `targets[name] = value` — a name of `__proto__` sets the prototype instead of creating an own property, so that entry vanishes from the serialised output and the lookup later resolves to `Object.prototype`.
* **Solution**: build such maps with `Object.create(null)` so `__proto__` is an ordinary own key, and resolve lookups with `Object.prototype.hasOwnProperty.call(map, key)` so an inherited property can never be mistaken for a stored entry.

## Surface-Contract Edge Cases

### 16. Surfaces Must Agree On How "Absent" Is Spelled
* **Problem**: the markdown formatter's optional dependency was `X[] | null` ("`null` means no memory"), but the gradient synthesizer's equivalent field was `X[] | undefined` — so passing `null` to the synthesizer threw `TypeError: Cannot read properties of null (reading 'length')`. Two surfaces rendering the same domain object had two different contracts for "nothing to show", and the repo convention for absent data is `null` (LLD §6.1: `stepReceipt: null`, `negativeMemoryGuidance: null`).
* **Solution**: when the same optional field is added to more than one surface, define the absent-value contract once and apply it everywhere — widen the type to `| null` and guard with a null-safe check (`x != null && x.length > 0`) so `undefined`, `null` and `[]` all behave identically. A test should assert the `null` output is byte-identical to the omitted-field output.

### 17. Shared Rendering Needs One Owner And Must Stay A Dependency-Free Leaf
* **Problem**: the same delta/entry formatting was written twice (feedback synthesizer and markdown formatter) and the two copies would drift. Hoisting it into a shared module raised the opposite risk — if the shared module sits behind the package barrel, a renderer ends up pulling the cache's `node:fs` / `node:crypto` into its runtime graph.
* **Solution**: put shared rendering in a leaf module with ZERO runtime imports (a type-only import is erased at compile time) and import it by its direct path, never through the barrel that re-exports the I/O-bearing module. Verify the runtime closure, not just the import statements.

### 18. Every Rendered Free Text Must Pass The Formatter's ANSI Filter
* **Problem**: each free-text field in the markdown formatter was routed through `stripAnsi` — except a newly added one. A remembered failure's `reason` is a revert reason and can carry subprocess ANSI, so the markdown output would have leaked escape codes, breaking the "the formatter never emits ANSI" contract in LLD §6.1/§6.2.
* **Solution**: route every rendered text through `stripAnsi` at the formatter boundary — including text composed by a shared renderer — and add a test asserting no `\u001b[` appears in the output.

## Loop & Configuration Edge Cases

### 19. A Persisted Memory Must Reach The FIRST Mutation, Not Just The Second
* **Problem**: the run loop loaded the previous run's negative memory before the loop but only handed the agent the gradient feedback of the *previous step* — synthesized after the first evaluation. So iteration 1 ran blind to everything the last run had learned, and the persistence bought nothing for the first (often most important) attempt. The reviewer's reproduction: `ITER1_FEEDBACK = undefined`, `ITER2_FEEDBACK_HAS_MEMORY = true`.
* **Solution**: give the generator a structured channel that exists on every iteration (`MutationContext.negativeMemory`), not only a feedback string that appears after the first step. Persisted state is only worth persisting if the first consumer can see it.

### 20. A Negative Memory Records Failures, Not Rollbacks
* **Problem**: the loop's reject branch also catches a step the pipeline ACCEPTED but that did not beat the current champion. Recording that step taught the agent that a *successful* strategy had failed — with a positive delta in the prompt ("Previously failed strategies: src/index.ts (+10.0%): rejected") — and, because eviction drops the lowest |delta|, the false positive could evict a real failure.
* **Solution**: distinguish "the pipeline rejected it" from "the loop rolled it back". The negative memory holds pipeline rejections only (`stepEval.accepted === false`); a rollback for lack of improvement is not a failure.

### 21. A Config Normaliser Must Not Replace The Block It Normalises
* **Problem**: `loadConfig` normalised `agent_budget` into a fresh `{ negativeMemorySize }` object and `delete`d the raw block. The keys `docs/SPECIFICATION.md` §1 documents (`max_iterations`, `rollback_on_failure`) vanished from the loaded config — a silent regression for anyone reading them. Even after preserving the raw block, a camelCase `agentBudget` carrying extra fields was still stripped, because the normalised object replaced it wholesale.
* **Solution**: spread the source block into the normalised result (`{ ...budget, negativeMemorySize: resolved }`) and keep the user's original block untouched beside it. A normaliser adds fields; it must never delete them.

### 22. An Unconditional Persist Rewrites State It Did Not Change
* **Problem**: the run loop's `finally` saved the negative memory whenever the cache held entries — including runs that recorded nothing. Every such run bumped the file's mtime and, because the cache was a snapshot taken at run start, could overwrite a concurrent run's entries for a different target. The write looked harmless because the content was identical.
* **Solution**: gate the save on a `memoryDirty` flag set where a failure is actually recorded, so a run that learned nothing touches nothing. The remaining half — a run that *does* record still saving a stale snapshot over another target's concurrent write — needs a re-read-and-merge before save; noted rather than fixed.

### 23. `JSON.stringify` Turns `NaN` Into `null` — Persisted Numbers Need A Finiteness Gate
* **Problem**: the cache accepted a `NaN`/`Infinity` `deltaPercent` from the pipeline (a zero baseline makes the percentage undefined or infinite). `JSON.stringify` silently writes both as `null`, and the loader's validator then rejected the entry — so a real pipeline rejection disappeared on the next run. Worse, a `NaN` weight made the eviction comparison return `false` in both directions, so which entry was evicted depended on Map insertion order, breaking the module's determinism guarantee.
* **Solution**: normalise at the write boundary (`Number.isFinite(value) ? value : 0`) so the persisted value is always representable. An unmeasurable delta is genuinely the least informative outcome, which is exactly what the eviction rule already ranks last — so the failure keeps its strategy and reason and is merely first to be evicted, instead of vanishing on reload.

## LLM Driver & Subprocess Automation Edge Cases

### 24. Stdin EPIPE In Subprocess Streaming
* **Problem**: When piping prompt text via `child.stdin.write()` into a CLI agent process that terminates early (e.g. syntax error, auth failure, immediate exit before reading stdin), Node emits an unhandled `EPIPE` error on `child.stdin`, which crashes the host process.
* **Solution**: Attach a dedicated `child.stdin.on("error", () => {})` handler before initiating `write()` and check `child.stdin.writable` before calling `write()` or `end()`.

### 25. Process Tree Orphan Prevention On Timeout
* **Problem**: Invoking `process.kill(child.pid)` only terminates the direct parent launcher (e.g. `npx` or `sh`), leaving the actual model runner or background workers running orphaned and locking file handles or consuming memory.
* **Solution**: Launch subprocesses with `detached: true` on POSIX to create a distinct process group, and terminate the whole tree using negative PID `process.kill(-child.pid, "SIGTERM")` followed by `SIGKILL`. On Windows, execute `taskkill /pid <pid> /T /F` to kill all child processes.

### 26. Balanced JSON Extraction From Mixed CLI Prose
* **Problem**: LLMs and agent CLIs frequently wrap structured output in markdown code fences or conversational prose. Greedy regex like `/\{[\s\S]*\}/` matches across multiple detached JSON blocks or fails when braces appear in prose.
* **Solution**: Use a depth-counting brace parser that tracks string literals and escape sequences (`\"`, `\\`) to accurately extract the balanced root `{ ... }` object, then parse and validate with Zod.

### 27. Cross-Platform Glob Path Matching In Target File Discovery
* **Problem**: Windows backslashes (`\`) cause POSIX-style glob matchers to fail when matching discovered candidate files against `config.target.files`.
* **Solution**: Normalize all relative paths with `relPath.split(path.sep).join("/")` before evaluating against target globs.


## TanStack Table Headless Model Edge Case (Map 9, #47)

### 28. `createTable` Crashes on Empty `state: {}`
* **Problem**: TanStack Table's headless `createTable` dereferences `columnPinning.left/right` inside the header-group memo — passing `state: {} as TableState` (as the pre-#47 code did) threw when deriving headers, which surfaced the first time the renderer actually consumed the model.
* **Solution**: Seed only the defaults the headless model needs: `columnOrder: [], columnPinning: { left: [], right: [] }, columnVisibility: {}`. A double-cast (`as unknown as TableState`) is unavoidable today and is comment-anchored to the ticket.

### 29. Writing `-Infinity` with `toFixed` Leaks into UI Strings
* **Problem**: `(-Infinity).toFixed(2)` returns the string `"-Infinity"`, and appending a suffix map (e.g. `%`) after a substitution token produces half-substituted tokens like `-%`.
* **Solution**: Normalize non-finite metrics to a bare `-` token at the *mapping layer* (before rendering — never let a rendered suffix follow a substitution token), and assert with UI-level leak tests (`output not.toContain("Infinity"|"NaN"|"-%")`), not just mapping assertions.

## Effect v4 Migration Pitfalls (Ticket #50)

### 30. Effect v4 API Surface Differences
* **Problem**: Effect v4 (4.x) has no `Effect.catchAll`/`Effect.void`; `Effect.match(effect, {onFailure, onSuccess})` folds typed errors only (defects bypass it); `Effect.ensuring` finalizers must be infallible, so fallible cleanup (promoteAndCleanup) fails to typecheck.
* **Solution**: Use `Effect.catchTag`/`Effect.catch` for recovery and `Effect.onExit` for finalizers that may fail — `onExit` merges exit causes like the old throw-in-finally. `Effect.gen` needs a real generator (`function*` + `const self = this` to capture class `this`).

### 31. Awaiting a Non-thenable Effect Silently Does Nothing
* **Problem**: `await someEffect` on an Effect value returns the Effect itself immediately without running it — migrated `await sandbox.release()` compiles under `any`-ish typing and appears to pass while never releasing the lock.
* **Solution**: Every migrated call site must be `await Effect.runPromise(effect)` (edge-only). Sweep all external callers with rg for each migrated method name; rely on tsc (`Effect` is not `Promise`-compatible) to catch leftovers.

## Effect Edge Runner & Signal Handling (Ticket #51)

### 32. Signal Handlers Must Be Installed BEFORE `Effect.runFork`
* **Problem**: `Effect.runFork(program)` executes the program synchronously up to its first async boundary. The run's sandbox `acquire()` is synchronous (`execFileSync("git", ["worktree","add",…])`), so `process.on("SIGINT")` registered AFTER `runFork` does not exist during the whole lock+worktree creation window — a Ctrl-C there hits Node with no listener, the default action kills the process, and the lock/worktree are orphaned (E2E: exit signal `SIGINT`, lock still on disk).
* **Solution**: Register the listeners before forking and wire the fiber-dependent interrupt action right after (`let interrupt: (() => void) | null` closed over the forked fiber). JS signal callbacks run on an event-loop turn, which cannot happen while `runFork` is still blocking, so the fiber reference is always set by the time `onSignal` fires. Prove it with a SIGINT E2E that polls for lock+worktree existence — the polling observer is a *different* process and sees directories mid-`git worktree add`.

### 33. A Wrapper Binary Relays Signals On Its Own Timer
* **Problem**: spawning the CLI through `node_modules/.bin/tsx` starts a WRAPPER process; `child.kill("SIGINT")` signals the wrapper, which relays to its child with its own short timeout and then exits `130` itself. The test observes a "successful" 130 while the real CLI (the process holding the lock) is signalled late or SIGKILLed mid-cleanup — flaky under CPU load, green when idle.
* **Solution**: in signal-sensitive E2E tests, spawn the real entrypoint as ONE process: `node --import <abs>/node_modules/tsx/dist/loader.mjs <cli-entry>` (absolute loader path — the test cwd is a temp dir with no node_modules). Always compare the spawned pid against the lock metadata pid to confirm you are signaling the process that owns the resources.

### 34. Stripping ANSI After `JSON.stringify` Is a No-Op
* **Problem**: `JSON.stringify` escapes the ESC byte as the six characters `\u001b`, so a `raw.replace(ANSI_PATTERN, "")` applied to the serialized document matches nothing — colored messages (`"\u001b[31mboom\u001b[0m"`) survive into `--format json` output.
* **Solution**: strip ANSI from `message` (and any other string you control) while BUILDING the structured error, before serialization; keep the post-stringify replace only as a harmless belt-and-braces.
