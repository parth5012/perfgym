import { describe, it, expect, vi, afterEach } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import { asEffect, collectStrayChildPids } from "../src/commands/run.js";

/**
 * Edge-runner helpers behind Ticket #51's cleanup guarantee, unit-tested in
 * isolation (self-review follow-up: the stray-child kill had to become
 * portable beyond GNU/Linux `ps --ppid`).
 */
describe("asEffect normalises a resource handle onto the Effect channel", () => {
  it("passes an Effect through untouched", async () => {
    const out = asEffect(Effect.succeed(42));
    expect(Effect.isEffect(out)).toBe(true);
    await expect(Effect.runPromise(out)).resolves.toBe(42);
  });

  it("lifts a Promise so its rejection lands on the failure channel", async () => {
    const exit = await Effect.runPromiseExit(asEffect(Promise.reject(new Error("release failed"))));
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const error = Cause.findErrorOption(exit.cause);
    expect(Option.isSome(error)).toBe(true);
    // Effect wraps a bare-tryPromise rejection in UnknownError; the original
    // message must survive on the failure channel for `describeExit`/rendering.
    expect(String(exit.cause)).toContain("release failed");
  });

  it("wraps a plain value in a succeeded Effect", async () => {
    await expect(Effect.runPromise(asEffect("plain"))).resolves.toBe("plain");
  });
});

describe("collectStrayChildPids (portable child discovery, self-review fix)", () => {
  const pid = String(process.pid);

  it("reads /proc and never shells out when it answers", () => {
    const exec = vi.fn(() => null);
    const pids = collectStrayChildPids({ readProcChildren: () => "101 102\n", exec });
    expect(pids).toEqual([101, 102]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("prefers pgrep -P over the GNU-only ps --ppid when /proc is unavailable", () => {
    const exec = vi.fn((cmd: string, args: string[]) =>
      cmd === "pgrep" && args[0] === "-P" ? "4242\n" : null,
    );
    const pids = collectStrayChildPids({ readProcChildren: () => null, exec });
    expect(exec.mock.calls[0]).toEqual(["pgrep", ["-P", pid]]);
    expect(pids).toEqual([4242]);
  });

  it("falls back to ps --ppid when pgrep is unavailable", () => {
    const exec = vi.fn((cmd: string) => {
      if (cmd === "pgrep") return null; // not installed / no match
      return "5151\n"; // ps fallback
    });
    const pids = collectStrayChildPids({ readProcChildren: () => null, exec });
    expect(exec.mock.calls.map((call) => call[0])).toEqual(["pgrep", "ps"]);
    expect(exec.mock.calls[1]).toEqual(["ps", ["-o", "pid=", "--ppid", pid]]);
    expect(pids).toEqual([5151]);
  });

  it("swallows a failing exec adapter instead of throwing inside the finalizer", () => {
    const exec = vi.fn(() => {
      throw new Error("no ps here");
    });
    expect(collectStrayChildPids({ readProcChildren: () => null, exec })).toEqual([]);
  });

  it("drops unusable entries and this process itself", () => {
    const pids = collectStrayChildPids({
      readProcChildren: () => `${process.pid} 0 abc -7\n`,
      exec: () => null,
    });
    expect(pids).toEqual([]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
