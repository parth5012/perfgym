/**
 * @perfgym/core
 * Negative Memory — the bounded record of mutation strategies that already failed.
 *
 * The optimizer asks this module what not to repeat. Every entry is a compact
 * fingerprint — a content hash, the failed strategy name, the measured delta and
 * a one-line reason — never a raw compiler error or stack trace, so the prompt
 * context built from it stays bounded (FLAW-13, docs/ADVERSARIAL_REVIEW.md).
 *
 * The cache is owned by the optimization loop and persisted per target in
 * `.perfgym/negative-memory.json`.
 */

/**
 * A single remembered failure.
 *
 * `id` is the SHA-256 hash of the mutated files (`hashMutatedFiles`) — the same
 * mutation always maps to the same id, which is what makes the cache
 * deduplicating rather than appending.
 */
export interface NegativeMemoryEntry {
  /** SHA-256 content hash of the mutated files. */
  readonly id: string;
  /** Short human/agent-readable name of the attempted strategy. */
  readonly strategy: string;
  /** Measured delta of the failed attempt. */
  readonly deltaPercent: number;
  /** Brief reason — the violation or the revert reason. */
  readonly reason: string;
  /** Iteration number the attempt belongs to. */
  readonly step: number;
  /** Epoch milliseconds of the attempt. */
  readonly timestamp: number;
}

export {
  DEFAULT_NEGATIVE_MEMORY_ENTRIES,
  NEGATIVE_MEMORY_FILE_VERSION,
  NegativeMemoryCache,
  hashMutatedFiles,
} from "./cache.js";
export type { NegativeMemoryCacheOptions } from "./cache.js";
