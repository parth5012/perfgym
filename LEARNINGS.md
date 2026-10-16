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
