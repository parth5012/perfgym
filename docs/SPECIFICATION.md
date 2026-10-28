# PerfGym Technical Specification

## 1. Declarative Schema (`.perfgym.yaml`)

Every repository defines its optimization target through `.perfgym.yaml`.

```yaml
version: "1.0"
target:
  name: string
  language: "typescript" | "javascript" | "python" | "go" | "kotlin" | "rust"
  files: string[]

invariants:
  command: string
  timeout_ms?: number

rules:
  - id: string
    message: string
    severity: "error" | "warning"
    penalty: number
    pattern: string

metrics:
  - name: string
    command: string
    goal: "minimize" | "maximize"
    weight: number
    require_checksum?: boolean  # strict opt-in: re-collect/fail on a missing or mismatched blackhole() checksum (FLAW-10)

agent_budget:
  max_iterations?: number
  rollback_on_failure?: boolean
  negative_memory_size?: number  # bounds the negative memory (failed strategies), default 5

benchmark:
  warmup_iterations?: number  # discarded warm-up spawns before sampling; default 5, range 0-20
```

**Warm-up isolation & immutable timers.** Before the first measured sample the
runner executes `benchmark.warmup_iterations` (default 5) *discarded* process
spawns with an identical command and environment; their outputs are never
stored or counted. Every spawn is additionally injected — automatically, with
no opt-in — with a bootstrap that runs before user code, freezes `Date`,
`Date.prototype.getTime`, `globalThis.performance`, `process.hrtime` and
`process.hrtime.bigint` (originals reachable through the documented escape
hatch `globalThis.__perfgymOriginalTimers`), and emits a monotonic
before/after stamp per sample; a tampered, zero-elapsed, or non-monotonic
stamp rejects the sample and it is re-collected within the sample budget.
Documented limitations: each sample is a separate process spawn, so an
in-process V8 warm-up cannot be imposed on an arbitrary user command (JIT
warm-up inside one process stays the harness's responsibility), and non-Node
benchmark commands are unaffected by the timer bootstrap because
`NODE_OPTIONS` only reaches Node.js processes.

**Black-hole sink & checksum verification (FLAW-10).** A benchmark command whose
metric value is never consumed may be eliminated by V8's dead-code elimination,
silently reporting a wrong (often all-zero) number. Metric scripts can defend
against this by consuming the value through `blackhole(value)` — import it from
the main entry, `import { blackhole } from "@perfgym/core"`, which is the
supported distribution surface and resolves anywhere the package is installed
(the `@perfgym/core/bench` subpath also works inside this repository via the
TS/Vite path alias, but is not a packaged export): the sink returns the value
unchanged and, on process exit, publishes an FNV-1a checksum of it on stderr
(`__perfgym_checksum__{...}`). The runner verifies the published checksum
against the value parsed from stdout and re-collects a mismatching or missing
sample within the same budget as a bad timer stamp. Set
`metrics[].require_checksum: true` to enforce this strictly (the run fails
with a clear error when the budget is exhausted); without it, a sample with no
checksum still runs but is reported as `dceSusceptible` (surfaced in markdown
and JSON reports), and a distribution whose samples all collapse to ~0 is
flagged `suspect`.

---

## 2. Mathematical Objective Function

The fitness function evaluates whether an agent's code change should be kept:

$$\text{Score}(M) = \begin{cases}
-\infty & \text{if Invariant Tests Fail} \\
\sum_{i} w_i \cdot \Delta_i - \sum_{j} P_j & \text{if Invariants Pass}
\end{cases}$$

Where:
- $w_i$: Normalized weight of metric $i$.
- $\Delta_i$: Percentage improvement in metric $i$ relative to baseline.
- $P_j$: Penalty value for each violated AST pattern rule $j$.

---

## 3. CLI Command Specification

### `perfgym init`
Generates a starter `.perfgym.yaml` with language detection.

### `perfgym baseline`
Runs the target test suite and benchmark command to record baseline scores. Stores state in `.perfgym/state.json`.

### `perfgym step`
Evaluates the currently active mutation:
1. Runs invariant command. If it fails, exits with non-zero and prints test errors.
2. Runs AST linter on modified files.
3. Runs benchmark command and calculates $\Delta\%$.
4. Computes total fitness score.

### `perfgym rollback`
Restores the sandbox worktree to the latest approved commit.

---

## 4. MCP Server Interface

Exposes tools for autonomous coding agents:

```json
{
  "name": "perfgym_eval",
  "description": "Evaluate current code changes against invariants, linters, and performance benchmarks",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target": { "type": "string" }
    }
  }
}
```
