/**
 * Session-file persistence — Ticket #46.
 *
 * `SessionFileStore` makes a durable JSON file the persistence layer of a
 * session whose live state lives in a TanStack `Store`. The contract:
 *
 * - Write-through: state is mutated in memory and flushed to the file on
 *   every meaningful transition (the caller decides what is meaningful —
 *   the store cleans up after every flush).
 * - Atomic write: every flush writes a temp file first and renames it over
 *   the target, so a crash mid-write can never leave a torn state file.
 * - Merge on flush: every flush re-reads the file first and merges only the
 *   fields this store actually changed since its last load/flush, so a field
 *   a concurrent writer has updated in the meantime is not clobbered.
 * - `lastUpdatedAt`: every flush stamps the freshness of the snapshot, so a
 *   reader can tell how stale the file is.
 * - Corrupt file: an unparseable file resets the store to its clean
 *   `initial` session instead of crashing the reader.
 * - Typed failure: a flush failure (injected `SessionFileAccess` rejection,
 *   ENOSPC, unserializable state) surfaces as `SessionFlushError`
 *   (`Data.TaggedError`, ADR-018) with the underlying cause preserved.
 *
 * The store never touches the filesystem directly — all primitives go
 * through an injected `SessionFileAccess` (node implementation by default),
 * which is what makes atomicity testable without module mocking.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Store } from "@tanstack/store";
import { ERR_SESSION_FLUSH, SessionFlushError } from "../errors.js";

/** Anything that can be serialized into the session file. */
export type SessionFileState = Record<string, unknown>;
/** The field every flush stamps so readers know how stale a snapshot is. */
export const LAST_UPDATED_KEY = "lastUpdatedAt";

/**
 * The low-level file primitives the session file needs. Injected (never
 * mocked via module boundaries) so persistence behaviour is unit-testable.
 */
export interface SessionFileAccess {
  /** File contents or null when the file does not exist / is unreadable. */
  readFile(path: string): string | null;
  writeFile(path: string, contents: string): void;
  renamePath(from: string, to: string): void;
  removeFile(path: string): void;
  makeDir(path: string): void;
  fileExists(path: string): boolean;
}

export const nodeSessionFileAccess: SessionFileAccess = {
  readFile: (filePath) => {
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  },
  writeFile: (filePath, contents) => {
    fs.writeFileSync(filePath, contents, "utf8");
  },
  renamePath: (from, to) => {
    fs.renameSync(from, to);
  },
  removeFile: (filePath) => {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // already gone
    }
  },
  makeDir: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  },
  fileExists: (filePath) => fs.existsSync(filePath),
};

/** How the most recent `reload()` saw the durable file. */
export type SessionLoadOutcome = "absent" | "loaded" | "reset-corrupt";

export interface SessionFileStoreOptions<S extends object> {
  /** Absolute path of the durable session file (e.g. `<root>/.perfgym/state.json`). */
  filePath: string;
  /** The clean session the store falls back to (missing or corrupt file). */
  initial: S;
  access?: SessionFileAccess;
  now?: () => number;
}

export class SessionFileStore<S extends object> {
  private readonly store: Store<S>;
  private readonly filePath: string;
  private readonly access: SessionFileAccess;
  private readonly clock: () => number;
  private readonly initial: S;
  /**
   * The durable content this store's in-memory state was last based on:
   * the baseline the merge-on-flush diff is computed against.
   */
  private base: S | null = null;
  private outcome: SessionLoadOutcome = "absent";
  private tempCounter = 0;

  constructor(options: SessionFileStoreOptions<S>) {
    this.filePath = options.filePath;
    this.initial = { ...options.initial };
    this.access = options.access ?? nodeSessionFileAccess;
    this.clock = options.now ?? (() => Date.now());
    this.store = new Store<S>({ ...this.initial });
  }

  /** Constructs the store from the durable file — the process-start read. */
  public static load<S2 extends object>(
    options: SessionFileStoreOptions<S2>
  ): SessionFileStore<S2> {
    const store = new SessionFileStore<S2>(options);
    store.reload();
    return store;
  }

  /**
   * Re-reads the durable file and replaces the in-memory live state. A
   * corrupt or unreadable file resets to the clean `initial` session.
   */
  public reload(): SessionLoadOutcome {
    const raw = this.access.readFile(this.filePath);
    if (raw === null) {
      this.outcome = "absent";
      this.base = null;
      this.store.setState(() => ({ ...this.initial }));
      return this.outcome;
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.outcome = "reset-corrupt";
      this.base = null;
      this.store.setState(() => ({ ...this.initial }));
      return this.outcome;
    }

    this.outcome = "loaded";
    this.base = parsed as S;
    this.store.setState(() => parsed as S);
    return this.outcome;
  }

  public get loadOutcome(): SessionLoadOutcome {
    return this.outcome;
  }

  /** The live session state (the TanStack Store is the source of truth). */
  public getState(): S {
    return this.store.state;
  }

  /** A detached, JSON-representable copy of the live state — safe to mutate. */
  public snapshot(): S {
    return JSON.parse(JSON.stringify(this.store.state)) as S;
  }

  /** In-memory mutation without flushing. */
  public update(updater: (prev: S) => S): void {
    this.store.setState((prev) => updater(prev));
  }

  /** Wholesale replacement of the in-memory state (the saveSession path). */
  public set(next: S): void {
    this.store.setState(() => ({ ...next }));
  }

  /** Replace the in-memory state with `next` and flush it to disk. */
  public save(next: S): S {
    this.set(next);
    const saved = this.flush();
    // The durable file now exists and reflects `next`: the store owns a real
    // session file, so the load outcome is no longer "absent" (later
    // write-through flushes must not be skipped for absence).
    this.outcome = "loaded";
    return saved;
  }

  public subscribe(listener: (state: S) => void): () => void {
    const sub = this.store.subscribe(listener);
    return () => {
      if (typeof sub === "function") {
        (sub as any)();
      } else if (sub && typeof (sub as any).unsubscribe === "function") {
        (sub as any).unsubscribe();
      }
    };
  }

  /**
   * Write-through flush: re-reads the durable file first, merges only the
   * fields this store changed since its last load/flush, stamps
   * `lastUpdatedAt`, and atomically replaces the file (temp + rename).
   */
  public flush(): S {
    const memory = this.store.state;

    const diskRaw = this.access.readFile(this.filePath);
    let disk: S | null = null;
    if (diskRaw !== null) {
      const parsed = this.tryParse(diskRaw);
      if (parsed !== null) {
        disk = parsed as S;
      }
    }

    const own: SessionFileState = {};
    const memoryRecord = memory as unknown as SessionFileState;
    const memoryKeys = Object.keys(memoryRecord);
    const baseRecord = this.base !== null ? (this.base as unknown as SessionFileState) : null;
    const deletedKeys = new Set<string>();

    if (baseRecord === null) {
      // base === null means clean-session reset, first write, or an unseeded store:
      // everything in memory is ours and replaces whatever the file held.
      for (const key of memoryKeys) {
        if (memoryRecord[key] !== undefined) {
          own[key] = memoryRecord[key];
        }
      }
    } else {
      for (const baseKey of Object.keys(baseRecord)) {
        if (!(baseKey in memoryRecord) || memoryRecord[baseKey] === undefined) {
          deletedKeys.add(baseKey);
        }
      }

      for (const key of memoryKeys) {
        if (memoryRecord[key] === undefined) {
          deletedKeys.add(key);
        } else if (!(key in baseRecord) || !deepEqualJson(memoryRecord[key], baseRecord[key])) {
          own[key] = memoryRecord[key];
        }
      }
    }

    const mergedRecord: SessionFileState =
      baseRecord === null
        ? { ...own }
        : {
            ...(disk as unknown as SessionFileState | null),
          };

    if (baseRecord !== null) {
      for (const deletedKey of deletedKeys) {
        delete mergedRecord[deletedKey];
      }
      for (const key of Object.keys(own)) {
        mergedRecord[key] = own[key];
      }
    }

    mergedRecord[LAST_UPDATED_KEY] = this.clock();

    const merged = (mergedRecord as unknown) as S;

    this.writeFileAtomically(merged);
    // Re-base: the merged content (including the fields another writer kept)
    // is what our next diff is computed against.
    this.base = JSON.parse(JSON.stringify(merged)) as S;
    this.store.setState(() => merged);
    return this.snapshot();
  }

  private writeFileAtomically(contents: object): void {
    const dir = path.dirname(this.filePath);
    const temp = path.join(
      dir,
      `.${path.basename(this.filePath)}.tmp-${process.pid}-${this.tempCounter++}`
    );
    let payload: string;
    try {
      // A non-serializable session (e.g. a circular reference) fails the
      // flush typed, before any file is touched.
      payload = JSON.stringify(contents, null, 2);
      this.access.makeDir(dir);
      this.access.writeFile(temp, payload);
      this.access.renamePath(temp, this.filePath);
    } catch (err: unknown) {
      // Never leave a partial file behind — neither in the target location
      // nor as a stray temp file (crash-simulating writers may have written
      // half the temp file before failing). Then rethrow typed (ADR-018).
      try {
        this.access.removeFile(temp);
      } catch {
        // already gone
      }
      throw new SessionFlushError({
        code: ERR_SESSION_FLUSH,
        filePath: this.filePath,
        message: `Failed to persist session state to ${this.filePath}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        cause: err,
      });
    }
  }

  private tryParse(raw: string): unknown {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }
}

/**
 * JSON-aware deep equality: fields mutated in memory must be detected even
 * when they are cloned objects/arrays (identity comparison cannot detect an
 * in-place `push`), while untouched composite fields must remain untouched.
 */
const deepEqualJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return a === b;
  }
  const arrayA = Array.isArray(a);
  const arrayB = Array.isArray(b);
  if (arrayA !== arrayB) return false;
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA);
  const keysB = Object.keys(recordB);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!deepEqualJson(recordA[key], recordB[key])) return false;
  }
  return true;
};
