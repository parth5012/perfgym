import { describe, it, expect, vi, afterEach } from "vitest";
import { Cause, Effect, Exit, Option } from "effect";
import {
  asEffect,
  collectStrayChildPids,
  dropPid,
  releaseSandbox,
} from "../src/commands/run.js";
import type { GitSandboxCoordinator, GitWorktreeDriver } from "../../core/src/index.js";

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

  it("treats an EMPTY /proc answer as authoritative too (no shell-out)", () => {
    // Linux reports "" when the process has no children — that is an answer,
    // not a failure: falling through to `ps` here made the ps helper list ITSELF
    // and got its (possibly recycled) PID SIGKILLed at the end of every run.
    const exec = vi.fn(() => "9999\n");
    expect(collectStrayChildPids({ readProcChildren: () => "", exec })).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("drops the exec helper's own pid from the candidate list", () => {
    expect(dropPid("5151 4242\n", 4242)).toBe("5151");
    expect(dropPid("4242\n", 4242)).toBe("");
    expect(dropPid("101 102\n", 7)).toBe("101 102");
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

describe("releaseSandbox runs its finalizers in a safe order", () => {
  it("kills strays and tears the worktree down BEFORE releasing the lock", async () => {
    const order: string[] = [];
    const coordinator = {
      release: () =>
        Effect.sync(() => {
          order.push("release-lock");
        }),
    } as unknown as GitSandboxCoordinator;
    const driver = {
      teardown: () =>
        Effect.sync(() => {
          order.push("teardown-worktree");
        }),
    } as unknown as GitWorktreeDriver;

    await Effect.runPromise(releaseSandbox(coordinator, driver));

    // A concurrent process may grab the lock the instant it is free, and
    // stray children may still hold files inside the worktree — so the
    // worktree must be gone first and the lock released last.
    expect(order).toEqual(["teardown-worktree", "release-lock"]);
  });

  it("still releases the lock when the worktree teardown fails", async () => {
    const order: string[] = [];
    const coordinator = {
      release: () =>
        Effect.sync(() => {
          order.push("release-lock");
        }),
    } as unknown as GitSandboxCoordinator;
    const driver = {
      teardown: () => Effect.sync(() => {
        throw new Error("EBUSY: worktree is locked");
      }),
    } as unknown as GitWorktreeDriver;

    await Effect.runPromise(releaseSandbox(coordinator, driver));
    expect(order).toEqual(["release-lock"]);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
