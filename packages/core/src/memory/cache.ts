/**
 * @perfgym/core
 * NegativeMemoryCache — a bounded, persisted memory of failed mutation strategies.
 *
 * The optimizer must not retry a mutation that already failed, but the memory
 * that records those failures must stay small: FLAW-13 (docs/ADVERSARIAL_REVIEW.md)
 * flagged unbounded negative memory as the source of prompt-context explosion.
 *
 * Every entry is therefore a compressed fingerprint — `[Hash, FailedStrategyName,
 * DeltaScore, BriefReason]` — never a raw compiler error or stack trace, and the
 * cache is capped at `maxEntries` (default 5). Whenever the cap is reached, the
 * eviction victim is the least informative candidate of the retained entries
 * *plus* the incoming one — the lowest `Math.abs(deltaPercent)`, ties broken by
 * the older entry and then by the smaller id — so a trivial failure never
 * displaces a stronger one. Re-recording a known id refreshes its measurement
 * in place (never a duplicate) and never evicts anything: the optimizer must
 * keep remembering that the mutation failed.
 *
 * Persistence is per target: a single JSON file holds a map of target name →
 * entries, so two targets never contaminate each other. The file path is
 * supplied by the caller (`save(file)` / `load(file, target)`) — this module
 * never picks a location. Loading a missing, unreadable or corrupt file yields
 * an empty cache instead of throwing.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NegativeMemoryEntry } from "./index.js";

export interface NegativeMemoryCacheOptions {
  /** Target (project) name — the persistence key that isolates one target from another. */
  readonly target: string;
  /** Maximum number of retained entries (defaults to 5). */
  readonly maxEntries?: number;
}

/** Default capacity of the cache — the "top 5 most relevant anti-patterns" of FLAW-13. */
export const DEFAULT_NEGATIVE_MEMORY_ENTRIES = 5;

/** Schema version written into the persistence file. */
export const NEGATIVE_MEMORY_FILE_VERSION = 1;

interface PersistedTarget {
  readonly target: string;
  readonly entries: readonly NegativeMemoryEntry[];
}

interface PersistedMemoryFile {
  readonly version: number;
  readonly targets: Record<string, PersistedTarget>;
}

/**
 * A target map without a prototype: a target literally named `__proto__` must
 * behave like an ordinary target instead of mutating the object's prototype
 * (which would silently drop that target's entries).
 */
const createTargetMap = (): Record<string, PersistedTarget> =>
  Object.create(null) as Record<string, PersistedTarget>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toEntry = (value: unknown): NegativeMemoryEntry | null => {
  if (!isRecord(value)) {
    return null;
  }

  const { id, strategy, deltaPercent, reason, step, timestamp } = value;
  if (typeof id !== "string" || typeof strategy !== "string" || typeof reason !== "string") {
    return null;
  }
  if (typeof deltaPercent !== "number" || !Number.isFinite(deltaPercent)) {
    return null;
  }
  if (typeof step !== "number" || !Number.isFinite(step)) {
    return null;
  }
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    return null;
  }

  return { id, strategy, deltaPercent, reason, step, timestamp };
};

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
};

/**
 * Order two candidate failures by how informative they are: the smallest
 * `|deltaPercent|` loses, then the older one, then the lexicographically
 * smaller id. The id tie-break keeps the outcome independent of Map iteration
 * order, so eviction is fully deterministic.
 */
const isLessInformative = (
  candidate: NegativeMemoryEntry,
  incumbent: NegativeMemoryEntry,
): boolean => {
  const candidateWeight = Math.abs(candidate.deltaPercent);
  const incumbentWeight = Math.abs(incumbent.deltaPercent);
  if (candidateWeight !== incumbentWeight) {
    return candidateWeight < incumbentWeight;
  }
  if (candidate.timestamp !== incumbent.timestamp) {
    return candidate.timestamp < incumbent.timestamp;
  }
  return candidate.id < incumbent.id;
};

/**
 * Hash the mutated file set into the dedup key of a negative-memory entry.
 *
 * Path separators are normalised to `/` and line endings to `\n`, and the files
 * are sorted by path (and by content for files sharing a path) so the digest
 * depends only on *what* changed, never on the order the files were collected
 * in nor on the platform that produced the paths. The comparison is code-unit
 * based on purpose: a locale-dependent comparison would produce different
 * digests on differently configured machines.
 */
export function hashMutatedFiles(
  files: readonly { readonly relPath: string; readonly content: string }[],
): string {
  const normalized = files.map((file) => ({
    relPath: file.relPath.replace(/\\/g, "/"),
    content: file.content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
  }));

  const ordered = normalized.sort((left, right) => {
    if (left.relPath !== right.relPath) {
      return left.relPath < right.relPath ? -1 : 1;
    }
    if (left.content !== right.content) {
      return left.content < right.content ? -1 : 1;
    }
    return 0;
  });

  const hash = createHash("sha256");
  for (const file of ordered) {
    hash.update(file.relPath, "utf8");
    hash.update("\u0000", "utf8");
    hash.update(file.content, "utf8");
    hash.update("\u0000", "utf8");
  }

  return hash.digest("hex");
}

export class NegativeMemoryCache {
  readonly #target: string;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, NegativeMemoryEntry>();

  constructor(options: NegativeMemoryCacheOptions) {
    this.#target = options.target;
    this.#maxEntries =
      options.maxEntries !== undefined && Number.isFinite(options.maxEntries)
        ? Math.max(0, Math.floor(options.maxEntries))
        : DEFAULT_NEGATIVE_MEMORY_ENTRIES;
  }

  /** The target this cache belongs to — its persistence key. */
  get target(): string {
    return this.#target;
  }

  /** The capacity of this cache. */
  get maxEntries(): number {
    return this.#maxEntries;
  }

  /**
   * Remember a failed attempt. An entry whose `id` is already known is updated
   * in place (never duplicated); a new entry competes with the retained ones
   * for the cache slots and only displaces a *less* informative failure.
   */
  record(entry: NegativeMemoryEntry): void {
    const existing = this.#entries.get(entry.id);
    if (existing !== undefined) {
      this.#entries.set(entry.id, {
        ...existing,
        strategy: entry.strategy,
        deltaPercent: entry.deltaPercent,
        reason: entry.reason,
        step: entry.step,
        timestamp: entry.timestamp,
      });
      return;
    }

    if (this.#maxEntries <= 0) {
      return;
    }

    if (this.#entries.size >= this.#maxEntries) {
      const victim = this.#evictionVictim(entry);
      if (victim === null) {
        return;
      }
      if (victim.id === entry.id) {
        // The incoming failure is the least informative candidate — remembering
        // it would cost a slot that a better failure still needs.
        return;
      }
      this.#entries.delete(victim.id);
    }

    this.#entries.set(entry.id, { ...entry });
  }

  /** Every remembered failure, newest first (ties: higher step, then lower id). */
  entries(): NegativeMemoryEntry[] {
    return [...this.#entries.values()]
      .sort((left, right) => {
        if (right.timestamp !== left.timestamp) {
          return right.timestamp - left.timestamp;
        }
        if (right.step !== left.step) {
          return right.step - left.step;
        }
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      })
      .map((entry) => ({ ...entry }));
  }

  /** Whether a mutation with this content hash already failed. */
  has(id: string): boolean {
    return this.#entries.has(id);
  }

  /** Forget every remembered failure. */
  clear(): void {
    this.#entries.clear();
  }

  /**
   * Persist this cache into `file`, merging it into the target map already on
   * disk. Entries of other targets are preserved untouched.
   */
  save(file: string): void {
    const targets = createTargetMap();

    const existing = readJson(file);
    if (isRecord(existing) && isRecord(existing.targets)) {
      for (const [key, bucket] of Object.entries(existing.targets)) {
        if (!isRecord(bucket)) {
          continue;
        }
        const rawEntries = Array.isArray(bucket.entries) ? bucket.entries : [];
        targets[key] = {
          target: typeof bucket.target === "string" ? bucket.target : key,
          entries: rawEntries
            .map(toEntry)
            .filter((entry): entry is NegativeMemoryEntry => entry !== null),
        };
      }
    }

    targets[this.#target] = { target: this.#target, entries: this.entries() };

    const payload: PersistedMemoryFile = {
      version: NEGATIVE_MEMORY_FILE_VERSION,
      targets,
    };

    mkdirSync(dirname(file), { recursive: true });

    // Write to a sibling temp file and rename it over the destination: a
    // rename within one directory is atomic, so an interrupted run can never
    // leave a half-written file behind. A truncated file would read back as
    // empty (the loader never throws) and the next save would then discard
    // the entries of every other target.
    const tempFile = `${file}.tmp.${process.pid}.${Date.now()}`;
    try {
      writeFileSync(tempFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      renameSync(tempFile, file);
    } catch (error: unknown) {
      try {
        rmSync(tempFile, { force: true });
      } catch {
        // The temp file is best-effort cleanup; the original error matters more.
      }
      throw error;
    }
  }

  /**
   * Load the cache of one target. A missing file, an unreadable file, malformed
   * JSON or an unknown target all yield an empty cache — never a throw.
   */
  static load(file: string, target: string, maxEntries?: number): NegativeMemoryCache {
    const cache = new NegativeMemoryCache({
      target,
      ...(maxEntries !== undefined ? { maxEntries } : {}),
    });

    const parsed = readJson(file);
    if (!isRecord(parsed) || !isRecord(parsed.targets)) {
      return cache;
    }

    // Own-property lookup only: a target named `__proto__` (or `toString`) must
    // resolve to its own data and never to an inherited object property.
    if (!Object.prototype.hasOwnProperty.call(parsed.targets, target)) {
      return cache;
    }

    const bucket = parsed.targets[target];
    if (!isRecord(bucket) || !Array.isArray(bucket.entries)) {
      return cache;
    }

    for (const raw of bucket.entries) {
      const entry = toEntry(raw);
      if (entry !== null) {
        cache.record(entry);
      }
    }

    return cache;
  }

  /**
   * The least informative candidate of the retained entries plus the incoming
   * one: lowest `|deltaPercent|`, then the oldest, then the lexicographically
   * smallest id — so the outcome never depends on Map iteration order.
   */
  #evictionVictim(incoming: NegativeMemoryEntry): NegativeMemoryEntry | null {
    let victim: NegativeMemoryEntry | null = null;

    const consider = (candidate: NegativeMemoryEntry): void => {
      if (victim === null) {
        victim = candidate;
        return;
      }
      if (isLessInformative(candidate, victim)) {
        victim = candidate;
      }
    };

    for (const entry of this.#entries.values()) {
      consider(entry);
    }
    consider(incoming);

    return victim;
  }
}
