import { spawn, spawnSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { Effect } from "effect";
import { verifyChecksum } from "../bench/blackhole.js";
import { BenchmarkExecutionError } from "../errors.js";
import type { BenchmarkDistribution, MetricResult } from "../index.js";
import { areTimerStampsValid, withTimerBootstrap } from "./bootstrap.js";

/**
 * ============================================================================
 * Deterministic Benchmark Seam (pipeline stage 2)
 * ============================================================================
 *
 * Executes each configured metric command W times as DISCARDED warm-up spawns
 * (default 5, clamped to 0..20 — `.perfgym.yaml` `benchmark.warmup_iterations`)
 * and then N times as measured samples (default 5, clamped to 1..20), reducing
 * the captured samples to a full `BenchmarkDistribution`. Commands run
 * strictly sequentially (one process at a time) so samples are recorded in
 * capture order.
 *
 * Warm-up isolation (FLAW-12 / ticket #53): the W warm-up spawns use an
 * IDENTICAL command and environment; their outputs are discarded entirely —
 * not stored, not parsed, never in the distribution — so cold-start
 * (process spawn, page cache, first-JIT) pollution never reaches the
 * statistics. Documented limitation: every measured sample is its own process
 * spawn, so an in-process V8 warm-up CANNOT be imposed on an arbitrary user
 * command; JIT warm-up inside a single process stays the responsibility of
 * the user's harness.
 *
 * Immutable timer bootstrap & tripwire (FLAW-09 / ticket #53): every spawn is
 * injected — automatically, no user opt-in — with `pipeline/bootstrap.ts` via
 * NODE_OPTIONS, so it runs BEFORE user code loads, freezes the timer surfaces
 * (originals reachable only through `globalThis.__perfgymOriginalTimers`) and
 * emits a monotonic before/after stamp on stderr. A sample whose stamp is
 * tampered, zero-elapsed, or non-monotonic is rejected as invalid and
 * re-collected within the sample budget (at most N rejections per run); an
 * invalid sample is never counted toward the distribution. Non-Node benchmark
 * commands are unaffected (documented limitation — NODE_OPTIONS is ignored by
 * Python/Rust/... processes, and a stamp-less spawn is treated as valid).
 *
 * Black-hole sink & checksum verification (FLAW-10 / ticket #54): a benchmark
 * result nobody consumes lets V8's Turbofan eliminate the whole computation.
 * `blackhole(result)` (exported from `@perfgym/core/bench`) publishes a
 * checksum on stderr; the runner VERIFIES a published checksum against the
 * parsed metric value — a mismatch rejects the sample through the SAME
 * rejection budget as the timer tripwire. A metric with
 * `requireChecksum: true` (`.perfgym.yaml` `metrics[].require_checksum`)
 * additionally treats a MISSING checksum as an invalid sample. Benchmarks
 * that never adopt the sink keep running (no forced breaking change) but the
 * resulting distribution is flagged `dceSusceptible`, and a distribution
 * whose samples are all (absurdly) close to zero is flagged `suspect`
 * independently of the sink — both flags surface in the formatted reports.
 *
 * Determinism policy (map ticket #13):
 * - Small-sample statistics must lean on robust estimators (MAD, IQR) rather
 *   than naive percentiles; the distribution still exposes p50/p90/p95/p99
 *   via deterministic linear interpolation for compatibility.
 * - Parse seam: if stdout (or any single line of it) parses as JSON carrying
 *   a standard metric key (`value`, `cycles`, `ops_per_sec`, `result`), that
 *   number is used; otherwise the LAST numeric token in stdout is used.
 *   Anything else is a hard failure — silent zeros would corrupt the
 *   hill-climbing search.
 * - Improvement semantics: `minimize` ⇒ lower is better and
 *   deltaPercent = (baseline - current) / baseline * 100;
 *   `maximize` ⇒ higher is better and
 *   deltaPercent = (current - baseline) / baseline * 100.
 *   A zero baseline guards the division: deltaPercent is 0 and `improved`
 *   falls back to a direct value comparison (documented below).
 * - Optional frozen-harness tamper protection: when `harnessDir` is provided
 *   the directory must exist, be non-empty, and every file in it must be
 *   read-only (no write bits) — an agent must not be able to rewrite the
 *   timing harness it is graded by. Enforcement is opt-in here; pipeline
 *   integration finalizes whether/what to enforce.
 *
 * The spawn/capture machinery mirrors `pipeline/invariants.ts` exactly:
 * detached process group, process-group SIGKILL on timeout, timeout fallback
 * settle, 2MB captured-stream caps, and the exit-code protocol.
 */

export const DEFAULT_HARNESS_DIR = ".perfgym/.harness";
export const DEFAULT_BENCHMARK_SAMPLES = 5;
export const MAX_BENCHMARK_SAMPLES = 20;
/** Discarded warm-up spawns before the first measured sample (ticket #53). */
export const DEFAULT_BENCHMARK_WARMUP = 5;
export const MAX_BENCHMARK_WARMUP = 20;
export const DEFAULT_BENCHMARK_TIMEOUT_MS = 30_000;
export const MAX_BENCHMARK_TIMEOUT_MS = 60_000;
/**
 * Magnitude at or below which a sample counts as "absurdly small" for any
 * metric unit (ticket #54): exact zeros and sub-nanosecond DCE remnants both
 * land here. A distribution whose samples ALL sit at or below it is flagged
 * `suspect` — a degenerate metric that carries no signal.
 */
export const SUSPECT_METRIC_EPSILON = 1e-9;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024; // 2MB capture cap per stream

const TIMEOUT_EXIT_CODE = 124; // GNU timeout convention: killed after the deadline.
const FORCE_SETTLE_TIMEOUT_MS = 500;
const TRUNCATION_MARKER = "\n[truncated]";

/** Ordered metric keys recognized in a JSON benchmark object (first match wins). */
export const BENCHMARK_JSON_KEYS = ["value", "cycles", "ops_per_sec", "result"] as const;

/**
 * Resolve the effective sample count: default 5, clamped into [1, 20].
 * NaN/undefined use the default; Infinity clamps to the max.
 */
export function resolveSampleCount(configured: number | undefined): number {
  if (configured === undefined || Number.isNaN(configured)) {
    return DEFAULT_BENCHMARK_SAMPLES;
  }
  return Math.min(MAX_BENCHMARK_SAMPLES, Math.max(1, configured));
}

/**
 * Resolve the effective warm-up spawn count: default 5, clamped into [0, 20]
 * (0 disables warm-ups entirely). NaN/undefined use the default; Infinity
 * clamps to the max. Truncated to an integer first — the spawn loop tests
 * `i < warmupCount`, so a fractional count (2.5) would otherwise fire
 * Math.ceil() spawns. Read from `.perfgym.yaml` `benchmark.warmup_iterations`
 * by the config layer (ticket #53).
 */
export function resolveWarmupCount(configured: number | undefined): number {
  if (configured === undefined || Number.isNaN(configured)) {
    return DEFAULT_BENCHMARK_WARMUP;
  }
  return Math.min(MAX_BENCHMARK_WARMUP, Math.max(0, Math.trunc(configured)));
}

/**
 * Resolve the effective per-run timeout: `.perfgym.yaml` `metrics[].timeout_ms`
 * may lower the 30s default and may raise it, but never above the 60s hard cap.
 * Non-positive or NaN values default to DEFAULT_BENCHMARK_TIMEOUT_MS.
 */
export function resolveBenchmarkTimeoutMs(configured: number | undefined): number {
  if (configured === undefined || Number.isNaN(configured) || configured <= 0) {
    return DEFAULT_BENCHMARK_TIMEOUT_MS;
  }
  if (!Number.isFinite(configured) || configured > MAX_BENCHMARK_TIMEOUT_MS) {
    return MAX_BENCHMARK_TIMEOUT_MS;
  }
  return configured;
}

// ============================================================================
// Pure distribution mathematics
// ============================================================================

/**
 * Deterministic percentile via linear interpolation (numpy "linear" method):
 * position = (n-1) * p/100, then interpolate between the two neighbors.
 * Expects a pre-sorted (ascending) sample array.
 */
export function percentileOf(sortedSamples: readonly number[], percentile: number): number {
  const n = sortedSamples.length;
  if (n === 0) {
    throw new RangeError("percentileOf() requires a non-empty sample array");
  }
  const clamped = Math.min(100, Math.max(0, percentile));
  const position = ((n - 1) * clamped) / 100;
  const lower = Math.floor(position);
  const upper = Math.min(n - 1, lower + 1);
  const fraction = position - lower;
  return sortedSamples[lower] + fraction * (sortedSamples[upper] - sortedSamples[lower]);
}

/** Population standard deviation (root-mean-square deviation from the mean). */
export function computeStddev(samples: readonly number[]): number {
  const n = samples.length;
  if (n === 0) {
    throw new RangeError("computeStddev() requires a non-empty sample array");
  }
  const mean = samples.reduce((acc, x) => acc + x, 0) / n;
  const variance = samples.reduce((acc, x) => acc + (x - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

/** MAD = median(|x_i − median(X)|) — the robust spread estimator. */
export function computeMad(samples: readonly number[]): number {
  const n = samples.length;
  if (n === 0) {
    throw new RangeError("computeMad() requires a non-empty sample array");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = percentileOf(sorted, 50);
  const deviations = sorted.map((x) => Math.abs(x - median));
  deviations.sort((a, b) => a - b);
  return percentileOf(deviations, 50);
}

/** IQR = p75 − p25 (quartiles use the same interpolation as the percentiles). */
export function computeIqr(samples: readonly number[]): number {
  const n = samples.length;
  if (n === 0) {
    throw new RangeError("computeIqr() requires a non-empty sample array");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return percentileOf(sorted, 75) - percentileOf(sorted, 25);
}

/** Reduce raw samples (any order) into the shared BenchmarkDistribution. */
export function computeBenchmarkDistribution(
  samples: readonly number[],
  unit: string = "count"
): BenchmarkDistribution {
  const n = samples.length;
  if (n === 0) {
    throw new RangeError("computeBenchmarkDistribution() requires at least one sample");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  // Degenerate-metric detection (ticket #54): every sample (absurdly) close
  // to zero means the metric measures nothing — flagged independently of
  // whether the black-hole sink was adopted. Only set when true, so a healthy
  // distribution keeps its exact shape.
  const suspect = samples.every(
    (sample) => Number.isFinite(sample) && Math.abs(sample) <= SUSPECT_METRIC_EPSILON
  );
  return {
    samples: [...samples],
    p50: percentileOf(sorted, 50),
    p90: percentileOf(sorted, 90),
    p95: percentileOf(sorted, 95),
    p99: percentileOf(sorted, 99),
    min: sorted[0],
    max: sorted[n - 1],
    stddev: computeStddev(samples),
    mad: computeMad(samples),
    iqr: computeIqr(samples),
    sampleCount: n,
    unit,
    ...(suspect ? { suspect: true } : {}),
  };
}

// ============================================================================
// Improvement semantics (pure; reused by step/eval stages)
// ============================================================================

export type MetricUnit = MetricResult["unit"];
export type MetricGoal = "minimize" | "maximize";

/**
 * Pure improvement calculus so every consumer agrees on what "better" means.
 *
 * - minimize: improved = current < baseline; deltaPercent = (baseline - current) / baseline * 100
 * - maximize: improved = current > baseline; deltaPercent = (current - baseline) / baseline * 100
 * - baseline === 0: division is undefined, so deltaPercent is pinned to 0 and
 *   `improved` degrades to a direct comparison (minimize: current < 0;
 *   maximize: current > 0). A zero baseline metric is a configuration smell —
 *   surface the lack of relative signal instead of inventing a fake percentage.
 */
export function computeMetricResult(
  name: string,
  baselineValue: number,
  currentValue: number,
  unit: MetricUnit,
  goal: MetricGoal
): MetricResult {
  if (baselineValue === 0) {
    return {
      name,
      value: currentValue,
      unit,
      improved: goal === "minimize" ? currentValue < 0 : currentValue > 0,
      deltaPercent: 0,
    };
  }
  const denominator = Math.abs(baselineValue);
  const deltaPercent =
    goal === "minimize"
      ? ((baselineValue - currentValue) / denominator) * 100
      : ((currentValue - baselineValue) / denominator) * 100;
  return {
    name,
    value: currentValue,
    unit,
    improved: goal === "minimize" ? currentValue < baselineValue : currentValue > baselineValue,
    deltaPercent,
  };
}

// ============================================================================
// Deterministic output parsing
// ============================================================================

export interface ParsedBenchmarkValue {
  readonly value: number;
  readonly source: "json" | "stdout";
}

/** Pull the first recognized metric number out of a parsed JSON candidate. */
function readJsonMetricNumber(candidate: unknown): number | undefined {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  for (const key of BENCHMARK_JSON_KEYS) {
    const raw = record[key];
    let numeric: number | undefined;
    if (typeof raw === "number") {
      if (Number.isFinite(raw)) {
        numeric = raw;
      }
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed !== "") {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
          numeric = parsed;
        }
      }
    }
    if (numeric !== undefined) return numeric;
  }
  return undefined;
}

const ANSI_REGEX = /\x1B\[[0-9;]*[a-zA-Z]/g;
const THOUSANDS_SEPARATOR_REGEX = new RegExp("(?<=\\d),(?=\\d)", "g");
const NUMBER_TOKEN_RE = /[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/g;

/** Scan text for balanced top-level JSON objects and find one with a metric key. */
function extractMetricFromJsonObjects(text: string): number | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      if (inString) escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          const candidate = text.slice(start, i + 1);
          start = -1;
          try {
            const parsed = JSON.parse(candidate);
            const val = readJsonMetricNumber(parsed);
            if (val !== undefined) {
              return val;
            }
          } catch {
            // Not valid JSON; keep scanning
          }
        }
      }
    }
  }
  return undefined;
}

/**
 * Parse a benchmark command's stdout into a single metric number:
 * 1. Strip ANSI escape sequences globally.
 * 2. Attempt JSON.parse on the whole stdout first (covers standard/pretty JSON).
 * 3. If that fails, scan consecutive balanced top-level JSON objects from the text
 *    or any line starting with JSON, checking for recognized metric keys.
 * 4. Fall back to the LAST numeric token in stdout (stripping thousands separators),
 *    rejecting non-finite values.
 * 5. Otherwise null — the caller must fail loudly rather than guess.
 */
export function parseBenchmarkValue(stdout: string): ParsedBenchmarkValue | null {
  // Strip ANSI escape sequences globally
  const cleaned = stdout.replace(ANSI_REGEX, "");
  const trimmed = cleaned.trim();
  if (trimmed !== "") {
    // 1. Whole-stdout JSON (covers single-line and pretty-printed multi-line schemas).
    try {
      const whole = readJsonMetricNumber(JSON.parse(trimmed));
      if (whole !== undefined) return { value: whole, source: "json" };
    } catch {
      // Not whole-stdout JSON; try extracting balanced JSON object.
    }

    // 2. Scan consecutive balanced top-level JSON objects from text.
    const fromObjects = extractMetricFromJsonObjects(trimmed);
    if (fromObjects !== undefined) {
      return { value: fromObjects, source: "json" };
    }

    // 3. Fallback per-line JSON check (e.g. single-line embedded in non-JSON lines).
    for (const line of trimmed.split("\n")) {
      const text = line.trim();
      if (!text.startsWith("{")) continue;
      try {
        const fromLine = readJsonMetricNumber(JSON.parse(text));
        if (fromLine !== undefined) return { value: fromLine, source: "json" };
      } catch {
        // Line is not JSON; keep scanning.
      }
    }
  }

  // 4. Last numeric token in stdout (with thousands separators stripped)
  const fallbackText = trimmed.replace(THOUSANDS_SEPARATOR_REGEX, "");
  let last: RegExpExecArray | null = null;
  for (const match of fallbackText.matchAll(NUMBER_TOKEN_RE)) {
    last = match;
  }
  if (last === null) return null;
  const num = Number(last[0]);
  if (!Number.isFinite(num)) return null;
  return { value: num, source: "stdout" };
}

// ============================================================================
// Frozen harness tamper protection
// ============================================================================

/**
 * Verify the frozen benchmark harness directory: it must exist, be a real
 * directory, be non-writable, contain at least one file, and every file in it
 * (scanned recursively) must carry zero write permission bits (owner/group/other).
 * Any symlinks must resolve inside the harness directory.
 * Throws Error with an actionable message on the first violation; returns silently
 * when the harness is sound.
 */
export function verifyFrozenHarness(harnessDir: string, cwd?: string): void {
  const baseDir = cwd ?? process.cwd();
  const resolved = resolve(baseDir, harnessDir);
  let dirStat: ReturnType<typeof statSync>;
  try {
    dirStat = statSync(resolved);
  } catch {
    throw new Error(
      `harness directory "${harnessDir}" does not exist (expected the frozen read-only ` +
        `harness at ${DEFAULT_HARNESS_DIR}); create it with read-only files before benchmarking`
    );
  }
  if (!dirStat.isDirectory()) {
    throw new Error(`harness path "${harnessDir}" is not a directory`);
  }
  if ((dirStat.mode & 0o222) !== 0) {
    throw new Error(
      `harness directory "${harnessDir}" is writable (mode 0o` +
        `${(dirStat.mode & 0o777).toString(8).padStart(3, "0")}) — agents could rewrite the ` +
        "timing harness directory they are graded by; chmod it read-only"
    );
  }

  // Recursive walk to find all files and check write bits and symlinks
  const canonicalHarnessDir = realpathSync(resolved);
  const allFiles: { relPath: string; fullPath: string; isSymlink: boolean }[] = [];

  function walk(currentDir: string): void {
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(currentDir, entry.name);
      const relPath = relative(resolved, fullPath);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        allFiles.push({ relPath, fullPath, isSymlink: entry.isSymbolicLink() });
      }
    }
  }

  walk(resolved);

  if (allFiles.length === 0) {
    throw new Error(
      `harness directory "${harnessDir}" contains no files; the frozen harness must ship at least one file`
    );
  }

  for (const file of allFiles) {
    if (file.isSymlink) {
      let targetRealPath: string;
      try {
        targetRealPath = realpathSync(file.fullPath);
      } catch (cause) {
        throw new Error(
          `cannot resolve symlink "${file.relPath}" in "${harnessDir}": "${(cause as Error).message}"`
        );
      }
      const rel = relative(canonicalHarnessDir, targetRealPath);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        throw new Error(
          `symlink "${file.relPath}" in "${harnessDir}" resolves outside the harness directory (${targetRealPath})`
        );
      }
    }

    let fileMode: number;
    try {
      fileMode = statSync(file.fullPath).mode;
    } catch (cause) {
      throw new Error(
        `cannot stat harness file "${file.relPath}" in "${harnessDir}": "${(cause as Error).message}"`
      );
    }
    if ((fileMode & 0o222) !== 0) {
      throw new Error(
        `frozen harness file "${file.relPath}" in "${harnessDir}" is writable (mode 0o` +
          `${(fileMode & 0o777).toString(8).padStart(3, "0")}) — agents could rewrite the ` +
          "timing harness they are graded by; chmod it read-only"
      );
    }
  }
}

// ============================================================================
// Captured execution (same rigor as the invariant gate)
// ============================================================================

export interface BenchmarkRunOptions {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly samples?: number;
  /**
   * Discarded warm-up spawns before the first measured sample (default 5,
   * clamped 0..20 — `.perfgym.yaml` `benchmark.warmup_iterations`, ticket #53).
   */
  readonly warmup?: number;
  readonly unit?: string;
  /**
   * Strict checksum opt-in (`.perfgym.yaml` `metrics[].require_checksum`,
   * ticket #54): a sample that publishes NO `blackhole` checksum is rejected
   * and re-collected through the same budget as the timer tripwire; when the
   * budget is exhausted the run fails loudly instead of measuring a
   * DCE-susceptible metric.
   */
  readonly requireChecksum?: boolean;
  /**
   * Provide to enforce frozen-harness tamper protection (existence, non-empty,
   * all files read-only). Omit for the plain benchmarking API with no
   * enforcement; integration decides what to pass.
   */
  readonly harnessDir?: string;
}

interface CapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  if (process.platform === "win32") {
    // taskkill /T /F reliably kills Windows trees (process-group negative pid is unsupported there).
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Group kill failed (e.g. Windows without negative pid support, or ESRCH).
    // Attempt single-pid kill fallback.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already gone (ESRCH) or unsupported — swallow error.
    }
  }
}

const benchmarkFailure = (
  command: string,
  error: string,
  message: string,
  rawOutput?: string
): BenchmarkExecutionError =>
  new BenchmarkExecutionError({ command, error, rawOutput, message });

/**
 * One measured execution of the benchmark command with the identical
 * spawn hygiene of the invariant gate: detached process group so the kill
 * reaches worker children, 2MB per-stream capture caps with truncation
 * marker, SIGKILL process-group kill on deadline, a 500ms force-settle
 * fallback if the killed process refuses to exit, and interruption cleanup.
 * Exit-code protocol: 0 = success, nonzero/timeout = BenchmarkExecutionError.
 */
const runCapturedCommand = (options: {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly env?: Readonly<Record<string, string>>;
}): Effect.Effect<CapturedOutput, BenchmarkExecutionError> =>
  Effect.callback<CapturedOutput, BenchmarkExecutionError>((resume) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let forceSettleTimer: NodeJS.Timeout | undefined;

    const child = spawn(options.command, {
      shell: true,
      detached: true,
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      const remaining = MAX_CAPTURE_BYTES - stdoutBytes;
      if (chunk.length <= remaining) {
        stdout += chunk.toString();
        stdoutBytes += chunk.length;
      } else {
        stdout += chunk.subarray(0, remaining).toString() + TRUNCATION_MARKER;
        stdoutBytes = MAX_CAPTURE_BYTES;
        stdoutTruncated = true;
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrTruncated) return;
      const remaining = MAX_CAPTURE_BYTES - stderrBytes;
      if (chunk.length <= remaining) {
        stderr += chunk.toString();
        stderrBytes += chunk.length;
      } else {
        stderr += chunk.subarray(0, remaining).toString() + TRUNCATION_MARKER;
        stderrBytes = MAX_CAPTURE_BYTES;
        stderrTruncated = true;
      }
    });

    const settle = (result: Effect.Effect<CapturedOutput, BenchmarkExecutionError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (forceSettleTimer !== undefined) {
        clearTimeout(forceSettleTimer);
      }
      resume(result);
    };

    const timeoutResult = (why: string): Effect.Effect<CapturedOutput, BenchmarkExecutionError> =>
      Effect.fail(
        benchmarkFailure(
          options.command,
          why,
          `Benchmark command "${options.command}" timed out after ${options.timeoutMs}ms ` +
            `(exit ${TIMEOUT_EXIT_CODE}). The command was killed with SIGKILL along with its whole ` +
            "process group; raise `metrics[].timeout_ms` in .perfgym.yaml if this benchmark is " +
            `legitimately slow (hard cap: ${MAX_BENCHMARK_TIMEOUT_MS}ms).`
        )
      );

    const deadline = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child.pid);

      child.stdout?.destroy();
      child.stderr?.destroy();

      forceSettleTimer = setTimeout(() => {
        settle(timeoutResult(`process did not exit after SIGKILL (force-settled after ${FORCE_SETTLE_TIMEOUT_MS}ms)`));
      }, FORCE_SETTLE_TIMEOUT_MS);
      forceSettleTimer.unref();
    }, options.timeoutMs);

    child.on("error", (cause: Error) => {
      settle(
        Effect.fail(
          benchmarkFailure(
            options.command,
            cause.message,
            `Benchmark command "${options.command}" could not spawn: ${cause.message}`
          )
        )
      );
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      if (timedOut) {
        settle(timeoutResult("deadline exceeded"));
        return;
      }
      if (code !== 0) {
        const reason = signal !== null && code === null ? `killed by ${signal}` : `exit ${code ?? -1}`;
        settle(
          Effect.fail(
            benchmarkFailure(
              options.command,
              `exit code ${code ?? -1}`,
              `Benchmark command "${options.command}" failed (${reason}): ` +
                `${(stdout + stderr).trim().slice(0, 2000)}`
            )
          )
        );
        return;
      }
      settle(
        Effect.succeed({
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
        })
      );
    });

    // If the fiber is interrupted (test harness, pipeline shutdown, ...),
    // make sure no process group is left behind either.
    return Effect.sync(() => {
      clearTimeout(deadline);
      if (forceSettleTimer !== undefined) {
        clearTimeout(forceSettleTimer);
      }
      killProcessGroup(child.pid);
    });
  });

/**
 * The deterministic benchmark seam: optional frozen-harness verification,
 * then W discarded warm-up spawns (identical command and environment; their
 * outputs never reach the distribution), then N sequential measured samples —
 * each stamped by the immutable timer bootstrap and rejected/re-collected
 * when the stamp is tampered, zero-elapsed, or non-monotonic, and
 * rejected/re-collected when its published `blackhole` checksum fails
 * verification or is absent under `requireChecksum` (FLAW-10 / ticket #54) —
 * reduced to a full BenchmarkDistribution with robust MAD/IQR spread
 * statistics plus the `suspect` / `dceSusceptible` visibility flags.
 */
export const runBenchmark = (
  options: BenchmarkRunOptions
): Effect.Effect<BenchmarkDistribution, BenchmarkExecutionError> => {
  const timeoutMs = resolveBenchmarkTimeoutMs(options.timeoutMs);
  const sampleCount = resolveSampleCount(options.samples);
  const warmupCount = resolveWarmupCount(options.warmup);
  const unit = options.unit ?? "count";

  let resolvedCwd: string | undefined;
  if (options.cwd !== undefined) {
    resolvedCwd = resolve(options.cwd);
    let isDir = false;
    try {
      isDir = statSync(resolvedCwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return Effect.fail(
        benchmarkFailure(
          options.command,
          `Invalid working directory: ${options.cwd}`,
          `Benchmark failed: working directory "${options.cwd}" does not exist or is not a directory`
        )
      );
    }
  }

  const executionOptions = {
    command: options.command,
    cwd: resolvedCwd,
    timeoutMs,
    env: {
      ...options.env,
      // Timer bootstrap (FLAW-09): injected AUTOMATICALLY, no opt-in — it
      // runs before user code in every (Node) spawn, warm-up or measured.
      NODE_OPTIONS: withTimerBootstrap(
        options.env?.NODE_OPTIONS ?? process.env.NODE_OPTIONS
      ),
    },
  };

  return Effect.gen(function* () {
    // 1. Frozen harness tamper protection — only when enforced by the caller.
    const harnessDir = options.harnessDir;
    if (harnessDir !== undefined && harnessDir !== "") {
      yield* Effect.try({
        try: () => verifyFrozenHarness(harnessDir, options.cwd),
        catch: (cause: unknown) =>
          benchmarkFailure(
            options.command,
            cause instanceof Error ? cause.message : String(cause),
            `Benchmark harness verification failed: ${
              cause instanceof Error ? cause.message : String(cause)
            }`
          ),
      });
    }

    const execute = runCapturedCommand(executionOptions);

    // 2. W discarded warm-up spawns (FLAW-12): identical command and
    //    environment, outputs thrown away entirely — never stored, never
    //    parsed, never counted in the distribution — so cold-start
    //    pollution (spawn cost, page cache, first-JIT) lands here instead of
    //    in the samples. Their stamps are ignored too: only measured samples
    //    are tripwire-checked.
    for (let i = 0; i < warmupCount; i++) {
      yield* Effect.asVoid(execute);
    }

    // 3. N sequential measured samples, recorded in capture order. A sample
    //    with a tampered / zero-elapsed / non-monotonic bootstrap stamp — or
    //    with a failing checksum (FLAW-10 / ticket #54) — is rejected and
    //    re-collected; the re-collection budget is the sample budget itself
    //    (at most `sampleCount` rejections per run), so a persistently
    //    cheating command fails loudly instead of looping.
    const collected: number[] = [];
    let rejectedSamples = 0;
    let stampRejections = 0;
    let checksumRejections = 0;
    let verifiedChecksumSamples = 0;
    while (collected.length < sampleCount) {
      const captured = yield* execute;

      // Tripwire first: a tampered clock invalidates whatever stdout says.
      if (!areTimerStampsValid(captured.stderr)) {
        rejectedSamples += 1;
        stampRejections += 1;
        if (rejectedSamples > sampleCount) {
          return yield* Effect.fail(
            benchmarkFailure(
              options.command,
              "invalid timer stamp",
              `Benchmark command "${options.command}" produced ${rejectedSamples} samples with ` +
                "tampered, zero-elapsed, or non-monotonic timer stamps — the immutable timer " +
                `bootstrap rejected them all and the re-collection budget (${sampleCount} within ` +
                "the sample budget) is exhausted. Stop replacing Date/performance/hrtime in the " +
                "benchmark; read time through globalThis.__perfgymOriginalTimers instead.",
              captured.stderr.trim()
            )
          );
        }
        continue; // rejected as invalid — never counted toward the distribution
      }

      const parsed = parseBenchmarkValue(captured.stdout);
      if (parsed === null) {
        return yield* Effect.fail(
          benchmarkFailure(
            options.command,
            "unparseable benchmark output",
            "Benchmark command exited 0 but produced no parseable numeric metric. " +
              "Emit a JSON object with a standard metric key (" +
              `${BENCHMARK_JSON_KEYS.join("/")}) or end stdout with a plain number.`,
            captured.stdout.trim() || captured.stderr.trim()
          )
        );
      }

      // Checksum verification (FLAW-10): a PUBLISHED checksum must hash to
      // the reported metric value, and under `requireChecksum` a checksum
      // must be published at all. Either failure rejects the sample into the
      // SAME re-collection budget as the timer tripwire — an invalid sample
      // is never counted toward the distribution.
      const checksumVerdict = verifyChecksum(captured.stderr, parsed.value);
      if (
        checksumVerdict === "mismatch" ||
        (checksumVerdict === "missing" && options.requireChecksum === true)
      ) {
        rejectedSamples += 1;
        checksumRejections += 1;
        if (rejectedSamples > sampleCount) {
          return yield* Effect.fail(
            benchmarkFailure(
              options.command,
              "checksum verification failed",
              `Benchmark command "${options.command}" produced ${rejectedSamples} samples that ` +
                "failed checksum verification — the re-collection budget " +
                `(${sampleCount} within the sample budget) is exhausted. ` +
                (options.requireChecksum === true
                  ? "require_checksum is set but no checksum was published: consume the " +
                    'reported metric value with blackhole(result) from "@perfgym/core/bench".'
                  : "The sink consumed a different value than the benchmark reported: " +
                    'blackhole(result) must receive the reported metric value from ' +
                    '"@perfgym/core/bench".') +
                (stampRejections > 0
                  ? ` (${stampRejections} further rejection(s) were tampered timer stamps.)`
                  : ""),
              captured.stderr.trim()
            )
          );
        }
        continue; // rejected as invalid — never counted toward the distribution
      }
      if (checksumVerdict === "verified") {
        verifiedChecksumSamples += 1;
      }
      collected.push(parsed.value);
    }

    const distribution = computeBenchmarkDistribution(collected, unit);
    // DCE visibility (ticket #54): all samples verified ⇒ the sink is
    // adopted; otherwise at least one sample published no checksum and the
    // distribution must carry the DCE-susceptible warning into the reports.
    return {
      ...distribution,
      ...(verifiedChecksumSamples === collected.length
        ? { checksumVerified: true }
        : { dceSusceptible: true }),
    };
  });
};
