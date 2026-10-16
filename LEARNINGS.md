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
