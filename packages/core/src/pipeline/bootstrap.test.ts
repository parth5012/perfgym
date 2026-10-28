import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  TIMER_STAMP_PREFIX,
  areTimerStampsValid,
  hasNodeRequirePreload,
  isValidTimerStamp,
  parseTimerStamps,
  withTimerBootstrap,
} from "./bootstrap.js";

/**
 * The immutable timer bootstrap (FLAW-09) and its monotonic tripwire —
 * ticket #53. The freeze runs in a real Node child process (never in the
 * vitest process itself), injected exactly the way the benchmark runner
 * injects it.
 */
describe("timer bootstrap — immutable timers (AC3)", () => {
  it("flags every NODE_OPTIONS require form Node accepts, and nothing else", () => {
    // Empirically accepted by Node 26 (and documented for NODE_OPTIONS):
    expect(hasNodeRequirePreload("--require ./evil.js")).toBe(true);
    expect(hasNodeRequirePreload("--require=./evil.js")).toBe(true);
    expect(hasNodeRequirePreload("-r ./evil.js")).toBe(true);
    expect(hasNodeRequirePreload("--require='node:fs'")).toBe(true);
    expect(hasNodeRequirePreload('--require="node:fs"')).toBe(true);
    // Combined with other options, either order.
    expect(hasNodeRequirePreload("--max-old-space-size=4096 --require ./evil.js")).toBe(true);
    expect(hasNodeRequirePreload("--require ./a.js --max-old-space-size=4096")).toBe(true);
    // A pre-existing --import entry is NOT a require preload.
    expect(hasNodeRequirePreload("--import ./setup.js")).toBe(false);
    expect(hasNodeRequirePreload("--max-old-space-size=4096")).toBe(false);
    expect(hasNodeRequirePreload("")).toBe(false);
    expect(hasNodeRequirePreload(undefined)).toBe(false);
    // `-r` as a substring of another token must not false-positive.
    expect(hasNodeRequirePreload("--report-uncaught-exceptions")).toBe(false);
  });

  it("exposes working escape-hatch helpers — performanceNow bound, getTime via a Date receiver", () => {
    const script = `
      "use strict";
      const original = globalThis.__perfgymOriginalTimers;
      const call = (label, fn) => {
        try { fn(); return true; }
        catch (e) { console.error(label + ": " + e.message); return false; }
      };
      console.log(JSON.stringify({
        dateNow: call("dateNow", () => original.dateNow()),
        performanceNow: call("performanceNow", () => original.performanceNow()),
        hrtime: call("hrtime", () => original.hrtime()),
        hrtimeBigint: call("hrtimeBigint", () => original.hrtimeBigint()),
        perfViaMember: call("performance.now", () => original.performance.now()),
        // getTime is Date.prototype.getTime: it needs a Date receiver, so it
        // is reachable but not zero-argument callable (parked, see ticket #53).
        getTimeWithReceiver: (() => {
          try { return typeof original.getTime.call(new Date()) === "number"; }
          catch (e) { console.error("getTime: " + e.message); return false; }
        })(),
      }));
    `;

    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: withTimerBootstrap(process.env.NODE_OPTIONS) },
    });

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      dateNow: true,
      performanceNow: true,
      hrtime: true,
      hrtimeBigint: true,
      perfViaMember: true,
      getTimeWithReceiver: true,
    });
  });

  it("freezes the timer surfaces against replacement while __perfgymOriginalTimers keeps working", () => {
    const script = `
      "use strict";
      // Every replacement attempt below must leave the clocks ticking.
      Date.now = () => 0;
      Date.prototype.getTime = () => 0;
      performance.now = () => 0;
      process.hrtime = () => [0, 0];
      process.hrtime.bigint = () => 0n;
      globalThis.Date = { now: () => 0 };
      const original = globalThis.__perfgymOriginalTimers;
      console.log(JSON.stringify({
        dateNowKeepsRealTime: Date.now() > 1.6e12,
        getTimeKeepsRealTime: new Date().getTime() > 1.6e12,
        performanceNowKeepsRealTime: Number.isFinite(performance.now()) && performance.now() >= 0,
        hrtimeStillWorks: Array.isArray(process.hrtime()) && process.hrtime.bigint() > 0n,
        dateFrozen: Object.isFrozen(Date),
        escapeHatchWorks:
          typeof original.Date === "function" &&
          typeof original.dateNow === "function" && original.dateNow() > 1.6e12 &&
          typeof original.getTime === "function" &&
          typeof original.performance === "object" &&
          typeof original.hrtime === "function" &&
          typeof original.hrtimeBigint === "function" && original.hrtimeBigint() > 0n,
        escapeHatchFrozen: Object.isFrozen(original),
      }));
    `;

    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: withTimerBootstrap(process.env.NODE_OPTIONS) },
    });

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      dateNowKeepsRealTime: true,
      getTimeKeepsRealTime: true,
      performanceNowKeepsRealTime: true,
      hrtimeStillWorks: true,
      dateFrozen: true,
      escapeHatchWorks: true,
      escapeHatchFrozen: true,
    });
  });

  it("runs before user code loads (no opt-in — the runner injects it via NODE_OPTIONS)", () => {
    // If the bootstrap ran after user code, this stamp would be falsy.
    const script = `"use strict"; console.log(globalThis.__perfgymOriginalTimers !== undefined)`;
    const result = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: withTimerBootstrap(process.env.NODE_OPTIONS) },
    });

    expect(result.status, `stderr: ${result.stderr}`).toBe(0);
    expect(result.stdout.trim()).toBe("true");
  });
});

describe("monotonic tripwire stamps (AC4)", () => {
  it("accepts an increasing stamp and rejects zero-elapsed, non-monotonic and tampered ones", () => {
    expect(isValidTimerStamp({ before: 100n, after: 200n, tampered: false })).toBe(true);
    // Zero elapsed — a fabricated or frozen clock.
    expect(isValidTimerStamp({ before: 100n, after: 100n, tampered: false })).toBe(false);
    // Non-monotonic — time moved backwards.
    expect(isValidTimerStamp({ before: 200n, after: 100n, tampered: false })).toBe(false);
    // A timer-surface replacement attempt was flagged inside the child.
    expect(isValidTimerStamp({ before: 100n, after: 200n, tampered: true })).toBe(false);
  });

  it("extracts stamp lines from stderr and ignores foreign or malformed output", () => {
    const stderr =
      `user noise\n` +
      `${TIMER_STAMP_PREFIX}{"before":"1","after":"2","tampered":false}\n` +
      `${TIMER_STAMP_PREFIX}not-json\n` +
      `${TIMER_STAMP_PREFIX}{"before":"x","after":"2"}\n`;
    expect(parseTimerStamps(stderr)).toEqual([{ before: 1n, after: 2n, tampered: false }]);
  });

  it("treats stderr without stamps (non-Node commands) as valid, and any invalid stamp as invalid", () => {
    expect(areTimerStampsValid("plain python output\n")).toBe(true);
    expect(areTimerStampsValid("")).toBe(true);
    expect(
      areTimerStampsValid(`${TIMER_STAMP_PREFIX}{"before":"1","after":"2","tampered":false}\n`)
    ).toBe(true);
    expect(
      areTimerStampsValid(
        `${TIMER_STAMP_PREFIX}{"before":"2","after":"1","tampered":false}\n` +
          `${TIMER_STAMP_PREFIX}{"before":"1","after":"2","tampered":false}\n`
      )
    ).toBe(false);
  });
});
