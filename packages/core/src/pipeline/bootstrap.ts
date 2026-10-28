/**
 * ============================================================================
 * Immutable timer bootstrap & monotonic tripwire (FLAW-09, ticket #53)
 * ============================================================================
 *
 * `TIMER_BOOTSTRAP_SOURCE` is injected AUTOMATICALLY by the benchmark runner
 * (no user opt-in) through `NODE_OPTIONS=--import data:text/javascript,...`
 * (see `withTimerBootstrap`), so it executes BEFORE the benchmark's user code
 * loads. It:
 *
 * 1. Captures the untouched originals and publishes them as the documented
 *    escape hatch `globalThis.__perfgymOriginalTimers` (a frozen object), so
 *    legitimate timing harnesses keep a supported way to read real time.
 *    `dateNow()`, `performanceNow()`, `hrtime()` and `hrtimeBigint()` are
 *    directly callable; `getTime` is the raw `Date.prototype.getTime`, so it
 *    takes a Date receiver: `original.getTime.call(someDate)`.
 * 2. Freezes the timer surfaces — `Date` (plus its `Date.now` clock),
 *    `Date.prototype.getTime`, `globalThis.performance` (plus `.now`),
 *    `process.hrtime` and `process.hrtime.bigint` — as non-configurable
 *    getter/setter shields: the value can no longer be replaced, and any
 *    replacement attempt FLIPS the tamper flag instead of silently failing
 *    (plain `Object.freeze` would swallow the assignment in sloppy-mode code
 *    with no evidence left behind).
 * 3. Records a monotonic before/after stamp (via the frozen
 *    `process.hrtime.bigint` original) and flushes it synchronously to fd 2 as
 *    a `__perfgym_stamp__{...}` line on process exit. The runner rejects a
 *    sample whose stamp is tampered, zero-elapsed, or non-monotonic and
 *    re-collects it within the sample budget (`pipeline/benchmark.ts`).
 *
 * Documented limitations:
 * - The bootstrap only reaches Node.js processes: `NODE_OPTIONS` is ignored by
 *   Python/Rust/Go/Kotlin commands, so non-Node benchmarks are unaffected.
 * - Removing the bootstrap's `exit` listener can suppress the STAMP, but the
 *   frozen surfaces cannot be un-frozen — a zeroed clock stays impossible.
 * - Every measured sample is a separate process spawn, so an in-process V8
 *   warm-up cannot be imposed on an arbitrary user command; JIT warm-up
 *   inside one process remains the responsibility of the user's harness.
 *
 * WHY A RAW STRING: the installer is handed to a child process as a `data:`
 * URL module and must produce byte-identical code under every toolchain.
 * Serialising a typed function with `Function.prototype.toString()` instead
 * would expose whatever a transformer did to it (esbuild's `keepNames` under
 * tsx wraps inner functions in an `__name(...)` helper that does not exist in
 * the injected module scope, and minifiers rename/free locals). The string is
 * opaque to all of them; it is exercised end-to-end by `bootstrap.test.ts`
 * (freeze + escape-hatch assertions) and the tripwire tests in
 * `benchmark.test.ts`. Keep its stamp prefix in sync with
 * `TIMER_STAMP_PREFIX`.
 */

/** Stderr line prefix of a bootstrap monotonic stamp. */
export const TIMER_STAMP_PREFIX = "__perfgym_stamp__";

/** One monotonic stamp pair reported by the bootstrap for a single spawn. */
export interface TimerStamp {
  readonly before: bigint;
  readonly after: bigint;
  /** True when the child attempted to replace a frozen timer surface. */
  readonly tampered: boolean;
}

/**
 * The self-contained installer, injected as an ES module that runs before
 * user code. Written as plain JavaScript on purpose (see the module docblock):
 * no imports, no module-scope references — only globals and its own locals.
 */
export const TIMER_BOOTSTRAP_SOURCE = `(function () {
  "use strict";
  var scope = globalThis;
  if (scope.__perfgymOriginalTimers !== undefined) return;

  // --- capture the originals BEFORE anything is frozen ---
  var dateCtor = Date;
  var dateNow = Date.now;
  var getTime = Date.prototype.getTime;
  var perfObject = globalThis.performance;
  var perfNow = perfObject.now;
  var hrtimeObject = process.hrtime;
  var hrtimeBigint = process.hrtime.bigint;
  var readNs = function () {
    return hrtimeBigint.call(hrtimeObject);
  };
  var before = readNs();

  var tampered = false;
  // Non-configurable get/set shield: replacement is impossible AND flagged.
  // The surface must exist somewhere on the chain (performance.now is
  // inherited from Performance.prototype); the shield then defines it as an
  // OWN non-configurable accessor, shadowing any prototype definition.
  var shield = function (target, key, value) {
    if (!(key in target)) return;
    var existing = Object.getOwnPropertyDescriptor(target, key);
    Object.defineProperty(target, key, {
      configurable: false,
      enumerable: existing ? existing.enumerable : false,
      get: function () {
        return value;
      },
      set: function () {
        tampered = true;
      },
    });
  };

  // Escape hatch: the untouched originals, frozen so they cannot be poisoned.
  Object.defineProperty(globalThis, "__perfgymOriginalTimers", {
    value: Object.freeze({
      Date: dateCtor,
      dateNow: dateNow,
      getTime: getTime,
      performance: perfObject,
      // Bound to its receiver: performance.now is an instance method, so a
      // bare reference would throw ERR_INVALID_THIS when the hatch calls it.
      // The shield publishes performance.now separately and keeps its own
      // this; only this convenience alias needs the binding.
      performanceNow: perfNow.bind(perfObject),
      hrtime: hrtimeObject,
      hrtimeBigint: hrtimeBigint,
    }),
    writable: false,
    enumerable: false,
    configurable: false,
  });

  // Freeze the documented timer surfaces (+ the clocks sitting on them).
  shield(globalThis, "Date", dateCtor);
  shield(dateCtor, "now", dateNow);
  Object.freeze(dateCtor);

  shield(dateCtor.prototype, "getTime", getTime);
  Object.freeze(getTime);

  shield(globalThis, "performance", perfObject);
  shield(perfObject, "now", perfNow);
  Object.freeze(perfObject);

  shield(process, "hrtime", hrtimeObject);
  shield(hrtimeObject, "bigint", hrtimeBigint);
  Object.freeze(hrtimeObject);
  Object.freeze(hrtimeBigint);

  // Tripwire: monotonic before/after stamp per process, flushed synchronously
  // to fd 2 on exit (fs.writeSync — async stderr writes can be dropped while
  // the process is exiting). The prefix is an inline literal kept in sync
  // with TIMER_STAMP_PREFIX (this source never sees module scope).
  // process.getBuiltinModule exists only on Node >= 20.16 / >= 22.3; on older
  // runtimes the guard degrades to no stamp instead of crashing every
  // benchmark child before user code loads.
  var fs = typeof process.getBuiltinModule === "function" ? process.getBuiltinModule("fs") : null;
  process.on("exit", function () {
    if (fs === null) return;
    try {
      var after = readNs();
      fs.writeSync(
        2,
        "\\n__perfgym_stamp__" +
          JSON.stringify({ before: String(before), after: String(after), tampered: tampered }) +
          "\\n"
      );
    } catch (e) {
      // stderr unavailable (closed or mid-kill) — the stamp is best-effort.
    }
  });
})();
`;

/**
 * Detect a `--require`/`-r` preload in a `NODE_OPTIONS` value. Node executes
 * accepted require forms BEFORE `--import` entries, so a preload could replace
 * `process.hrtime.bigint` before the bootstrap captures the originals — the
 * escape hatch would then publish the tampered clock as the "original". The
 * runner treats a positive result as fail-closed and refuses the run.
 *
 * Covers the forms Node actually accepts in `NODE_OPTIONS` (verified on
 * Node 26): `--require mod`, `--require=mod` (quotes included in the value
 * token), and `-r mod`. The `-r=mod` / `-rmod` attached forms are rejected by
 * Node itself, so the spawn fails loudly without our check.
 */
export function hasNodeRequirePreload(existingNodeOptions?: string): boolean {
  // Split into tokens on whitespace outside quotes, mirroring how Node
  // tokenizes NODE_OPTIONS.
  const tokens = existingNodeOptions?.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return tokens.some((token) => {
    const option = token.replace(/^['"]|['"]$/g, "");
    return (
      option === "--require" || option.startsWith("--require=") || option === "-r"
    );
  });
}

/**
 * Build the `NODE_OPTIONS` value that injects the bootstrap before user code:
 * a `--import data:text/javascript,...` entry PREPENDED to whatever
 * `NODE_OPTIONS` the environment already carries. Prepending matters: Node
 * executes `--import` entries left-to-right, so a pre-existing entry must run
 * AFTER the bootstrap or it could patch the timers before the originals are
 * captured (the `--require`/`-r` forms cannot be ordered at all and are
 * rejected outright by `hasNodeRequirePreload`). A data URL needs no temp
 * file and no path quoting, and is parsed identically on every platform.
 */
export function withTimerBootstrap(existingNodeOptions?: string): string {
  const moduleUrl = `data:text/javascript,${encodeURIComponent(TIMER_BOOTSTRAP_SOURCE)}`;
  const injected = `--import ${moduleUrl}`;
  const base = existingNodeOptions?.trim() ?? "";
  return base === "" ? injected : `${injected} ${base}`;
}

/**
 * Parse every `__perfgym_stamp__{...}` line out of a child's stderr.
 * Foreign or malformed lines are ignored — only well-formed stamps count.
 * before/after arrive as decimal strings (JSON cannot carry bigints).
 */
export function parseTimerStamps(stderr: string): TimerStamp[] {
  const stamps: TimerStamp[] = [];
  for (const line of stderr.split("\n")) {
    if (!line.startsWith(TIMER_STAMP_PREFIX)) continue;
    try {
      const parsed = JSON.parse(line.slice(TIMER_STAMP_PREFIX.length)) as {
        before?: unknown;
        after?: unknown;
        tampered?: unknown;
      };
      const before =
        typeof parsed.before === "string" || typeof parsed.before === "number"
          ? BigInt(parsed.before)
          : null;
      const after =
        typeof parsed.after === "string" || typeof parsed.after === "number"
          ? BigInt(parsed.after)
          : null;
      if (before === null || after === null) continue;
      stamps.push({ before, after, tampered: parsed.tampered === true });
    } catch {
      // Malformed stamp line — ignored.
    }
  }
  return stamps;
}

/** A stamp is valid only when it is monotonic, non-zero and untampered. */
export function isValidTimerStamp(stamp: TimerStamp): boolean {
  return !stamp.tampered && stamp.after > stamp.before;
}

/**
 * Sample-level verdict over ALL stamps in one spawn's stderr: a sample is
 * rejected if ANY of its stamps is tampered, zero-elapsed, or non-monotonic.
 * Stderr without any stamp (a non-Node command, or a stamp-less kill) is
 * VALID — non-Node benchmark commands stay unaffected (documented limitation).
 */
export function areTimerStampsValid(stderr: string): boolean {
  return parseTimerStamps(stderr).every(isValidTimerStamp);
}
