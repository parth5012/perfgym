import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SessionFileStore,
  nodeSessionFileAccess,
  type SessionFileAccess,
} from "./persist.js";
import { SessionFlushError } from "../errors.js";

interface FixtureState {
  version: string;
  totalStepCount: number;
  history: string[];
  rival?: string;
  lastUpdatedAt?: number;
}

const initial: FixtureState = {
  version: "1.0",
  totalStepCount: 0,
  history: [],
};

const makeDir = (): { dir: string; filePath: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "perfgym-store-"));
  return { dir, filePath: path.join(dir, "state.json") };
};

const readDisk = (filePath: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;

const writeDisk = (filePath: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
};

describe("SessionFileStore (Ticket #46 — write-through session state)", () => {
  it("round-trips load → mutate → save → reload", () => {
    const { filePath } = makeDir();

    const writer = SessionFileStore.load<FixtureState>({ filePath, initial });
    expect(writer.loadOutcome).toBe("absent");

    writer.update((prev) => ({ ...prev, totalStepCount: 4, history: ["s1"] }));
    writer.flush();

    const reader = SessionFileStore.load<FixtureState>({ filePath, initial });
    expect(reader.loadOutcome).toBe("loaded");
    expect(reader.getState().totalStepCount).toBe(4);
    expect(reader.getState().history).toEqual(["s1"]);
    expect(reader.getState().version).toBe("1.0");
  });

  it("never leaves a torn file: a failed write keeps the previous content intact", () => {
    const { filePath } = makeDir();

    // Seed a good state on disk first.
    const seeded = SessionFileStore.load<FixtureState>({ filePath, initial });
    seeded.update((prev) => ({ ...prev, totalStepCount: 4 }));
    seeded.flush();
    const previous = readDisk(filePath);

    // A disk that dies after half-writing the temp file (simulated crash mid-write).
    const crashingAccess: SessionFileAccess = {
      ...nodeSessionFileAccess,
      writeFile: (target, contents) => {
        nodeSessionFileAccess.writeFile(target, contents.slice(0, Math.floor(contents.length / 2)));
        throw new Error("ENOSPC: simulated crash mid-write");
      },
    };
    const failing = SessionFileStore.load<FixtureState>({ filePath, initial, access: crashingAccess });
    failing.set({ ...initial, totalStepCount: 9 });

    expect(() => failing.flush()).toThrow(/ENOSPC/);

    // The previous file is intact and parseable, and no partial/temp file remains.
    expect(readDisk(filePath)).toEqual(previous);
    const dir = path.dirname(filePath);
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("surfaces flush failures as a typed SessionFlushError (ADR-018) with the cause preserved", () => {
    const { filePath } = makeDir();

    const crashingAccess: SessionFileAccess = {
      ...nodeSessionFileAccess,
      writeFile: () => {
        throw new Error("ENOSPC: injected write failure");
      },
    };
    const store = SessionFileStore.load<FixtureState>({ filePath, initial, access: crashingAccess });
    store.update((prev) => ({ ...prev, totalStepCount: 1 }));

    let thrown: unknown;
    try {
      store.flush();
    } catch (err: unknown) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(SessionFlushError);
    const flushError = thrown as InstanceType<typeof SessionFlushError>;
    expect(flushError._tag).toBe("SessionFlushError");
    expect(flushError.code).toBe("ERR_SESSION_FLUSH");
    expect(flushError.filePath).toBe(filePath);
    expect((flushError.cause as Error).message).toBe("ENOSPC: injected write failure");
    expect(flushError.message).toContain("ENOSPC: injected write failure");
  });

  it("merges on flush: a concurrent update is not clobbered", () => {
    const { filePath } = makeDir();
    writeDisk(filePath, {
      version: "1.0",
      totalStepCount: 5,
      history: ["s1"],
      rival: "untouched",
    });

    const store = SessionFileStore.load<FixtureState>({ filePath, initial });
    store.update((prev) => ({ ...prev, totalStepCount: 9 }));

    // A concurrent writer touches a different field between our load and flush.
    const diskNow = readDisk(filePath);
    writeDisk(filePath, { ...diskNow, history: ["s1", "s2"] });

    store.flush();

    const disk = readDisk(filePath);
    expect(disk.totalStepCount).toBe(9); // our change applied
    expect(disk.history).toEqual(["s1", "s2"]); // concurrent change preserved
    expect(disk.rival).toBe("untouched"); // untouched fields preserved
  });

  it("resets a corrupt state file to a clean session instead of crashing", () => {
    const { filePath } = makeDir();
    writeDisk(filePath, "{ this is not JSON");

    expect(() =>
      SessionFileStore.load<FixtureState>({ filePath, initial })
    ).not.toThrow();

    const store = SessionFileStore.load<FixtureState>({ filePath, initial });
    expect(store.loadOutcome).toBe("reset-corrupt");
    expect(store.getState()).toEqual(initial);

    // The next flush replaces the corrupt file with the clean session.
    store.flush();
    expect(readDisk(filePath)).toEqual({ ...initial, lastUpdatedAt: expect.any(Number) });
  });

  it("stamps lastUpdatedAt on every flush and keeps it across reloads", () => {
    const { filePath } = makeDir();
    let clock = 1000;

    const store = SessionFileStore.load<FixtureState>({
      filePath,
      initial,
      now: () => clock,
    });
    store.update((prev) => ({ ...prev, totalStepCount: 1 }));
    expect(store.flush().lastUpdatedAt).toBe(1000);

    store.update((prev) => ({ ...prev, totalStepCount: 2 }));
    clock = 1500;
    expect(store.flush().lastUpdatedAt).toBe(1500);

    const reader = SessionFileStore.load<FixtureState>({ filePath, initial, now: () => clock });
    expect(reader.getState().lastUpdatedAt).toBe(1500);
  });
});
