import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NegativeMemoryCache,
  hashMutatedFiles,
  type NegativeMemoryEntry,
} from "./index.js";

const tempDirs: string[] = [];

const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "perfgym-negative-memory-"));
  tempDirs.push(dir);
  return dir;
};

const entry = (
  overrides: Partial<NegativeMemoryEntry> & Pick<NegativeMemoryEntry, "id">,
): NegativeMemoryEntry => ({
  strategy: "serial awaits",
  deltaPercent: -5,
  reason: "regressed latency",
  step: 1,
  timestamp: 1_000,
  ...overrides,
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("NegativeMemoryCache — dedup by content hash", () => {
  it("updates an existing entry instead of duplicating it", () => {
    const cache = new NegativeMemoryCache({ target: "demo" });

    cache.record(entry({ id: "hash-a", deltaPercent: -5, reason: "first", step: 1, timestamp: 1_000 }));
    cache.record(
      entry({ id: "hash-a", deltaPercent: -9, reason: "second", step: 4, timestamp: 5_000 }),
    );

    const entries = cache.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      id: "hash-a",
      strategy: "serial awaits",
      deltaPercent: -9,
      reason: "second",
      step: 4,
      timestamp: 5_000,
    });
  });

  it("keeps the cache size stable when the same mutation repeats", () => {
    const cache = new NegativeMemoryCache({ target: "demo", maxEntries: 3 });

    for (let i = 0; i < 5; i += 1) {
      cache.record(entry({ id: "same-hash", timestamp: 1_000 + i }));
    }

    expect(cache.entries()).toHaveLength(1);
    expect(cache.has("same-hash")).toBe(true);
  });

  it("does not evict another entry when a known hash repeats", () => {
    const cache = new NegativeMemoryCache({ target: "demo", maxEntries: 2 });

    cache.record(entry({ id: "known", deltaPercent: -10, timestamp: 1_000 }));
    cache.record(entry({ id: "other", deltaPercent: -5, timestamp: 2_000 }));
    cache.record(entry({ id: "known", deltaPercent: -12, reason: "again", timestamp: 3_000 }));

    const ids = cache.entries().map((item) => item.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("known");
    expect(ids).toContain("other");
    expect(cache.entries()[0]?.reason).toBe("again");
  });

  it("refreshes a weakened measurement in place instead of duplicating the entry", () => {
    const cache = new NegativeMemoryCache({ target: "demo", maxEntries: 1 });

    cache.record(entry({ id: "x", deltaPercent: -10, reason: "first", timestamp: 1_000 }));
    cache.record(entry({ id: "x", deltaPercent: -0.5, reason: "second", timestamp: 5_000 }));

    const entries = cache.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("x");
    expect(entries[0]?.deltaPercent).toBe(-0.5);
    expect(entries[0]?.reason).toBe("second");
    expect(entries[0]?.timestamp).toBe(5_000);

    // The refreshed entry is now the least informative one, so it is the first
    // eviction candidate: the more informative newcomer takes its slot.
    cache.record(entry({ id: "y", deltaPercent: -8, timestamp: 6_000 }));

    expect(cache.entries().map((item) => item.id)).toEqual(["y"]);
    expect(cache.has("x")).toBe(false);
  });

  it("reports unknown ids as absent", () => {
    const cache = new NegativeMemoryCache({ target: "demo" });

    cache.record(entry({ id: "known" }));

    expect(cache.has("known")).toBe(true);
    expect(cache.has("unknown")).toBe(false);
  });

  it("clears every entry", () => {
    const cache = new NegativeMemoryCache({ target: "demo" });

    cache.record(entry({ id: "a" }));
    cache.record(entry({ id: "b" }));
    cache.clear();

    expect(cache.entries()).toEqual([]);
    expect(cache.has("a")).toBe(false);
  });
});

describe("NegativeMemoryCache — bounded eviction", () => {
  it("drops the entry with the lowest absolute delta first", () => {
    const cache = new NegativeMemoryCache({ target: "demo", maxEntries: 2 });

    cache.record(entry({ id: "strong", deltaPercent: -12, timestamp: 1_000 }));
    cache.record(entry({ id: "weak", deltaPercent: -1, timestamp: 2_000 }));
    cache.record(entry({ id: "medium", deltaPercent: -6, timestamp: 3_000 }));

    const ids = cache.entries().map((item) => item.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("strong");
    expect(ids).toContain("medium");
    expect(ids).not.toContain("weak");
  });

  it("breaks absolute-delta ties by evicting the older entry", () => {
    const cache = new NegativeMemoryCache({ target: "demo", maxEntries: 2 });

    cache.record(entry({ id: "older", deltaPercent: -5, timestamp: 1_000 }));
    cache.record(entry({ id: "newer", deltaPercent: 5, timestamp: 2_000 }));
    // The incoming entry must be exactly as informative as the tied pair, so the
    // tie-break on |deltaPercent| cannot decide the victim — only the age of
    // the candidates can. With a less informative incoming entry the incoming
    // one would itself be the victim and the tie-break would never be reached.
    cache.record(entry({ id: "fresh", deltaPercent: -5, timestamp: 3_000 }));

    const ids = cache.entries().map((item) => item.id);
    expect(ids).toContain("newer");
    expect(ids).toContain("fresh");
    expect(ids).not.toContain("older");
  });

  it("does not evict a more informative entry for a less informative failure", () => {
    const cache = new NegativeMemoryCache({ target: "demo", maxEntries: 2 });

    cache.record(entry({ id: "strong", deltaPercent: -10, timestamp: 1_000 }));
    cache.record(entry({ id: "medium", deltaPercent: -8, timestamp: 2_000 }));
    cache.record(entry({ id: "trivial", deltaPercent: -0.1, timestamp: 3_000 }));

    const ids = cache.entries().map((item) => item.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("strong");
    expect(ids).toContain("medium");
    expect(ids).not.toContain("trivial");
  });

  it("keeps the most informative failures after an arbitrary record sequence", () => {
    const cache = new NegativeMemoryCache({ target: "demo", maxEntries: 3 });

    const deltas = [-1, -12, -4, -9, -2, -7, -11];
    deltas.forEach((deltaPercent, index) => {
      cache.record(entry({ id: `hash-${index}`, deltaPercent, timestamp: 1_000 + index }));
    });

    const entries = cache.entries();
    expect(entries).toHaveLength(3);
    expect(entries.map((item) => item.id).sort()).toEqual(["hash-1", "hash-3", "hash-6"]);
    expect(entries.map((item) => Math.abs(item.deltaPercent)).sort((a, b) => b - a)).toEqual([
      12, 11, 9,
    ]);
  });

  it("breaks a full tie by evicting the lexicographically smallest id", () => {
    const cache = new NegativeMemoryCache({ target: "demo", maxEntries: 2 });

    cache.record(entry({ id: "bbb", deltaPercent: -5, timestamp: 1_000 }));
    cache.record(entry({ id: "ccc", deltaPercent: -5, timestamp: 1_000 }));
    cache.record(entry({ id: "aaa", deltaPercent: -5, timestamp: 1_000 }));

    const ids = cache.entries().map((item) => item.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("bbb");
    expect(ids).toContain("ccc");
    expect(ids).not.toContain("aaa");
  });

  it("never exceeds the configured capacity", () => {
    const cache = new NegativeMemoryCache({ target: "demo", maxEntries: 3 });

    for (let i = 0; i < 10; i += 1) {
      cache.record(entry({ id: `hash-${i}`, deltaPercent: -(i + 1), timestamp: 1_000 + i }));
    }

    expect(cache.entries()).toHaveLength(3);
  });

  it("defaults the capacity to five entries", () => {
    const cache = new NegativeMemoryCache({ target: "demo" });

    for (let i = 0; i < 8; i += 1) {
      cache.record(entry({ id: `hash-${i}`, deltaPercent: -(i + 1), timestamp: 1_000 + i }));
    }

    expect(cache.entries()).toHaveLength(5);
  });

  it("does not evict anything while below capacity", () => {
    const cache = new NegativeMemoryCache({ target: "demo", maxEntries: 5 });

    cache.record(entry({ id: "a", deltaPercent: -1 }));
    cache.record(entry({ id: "b", deltaPercent: -9 }));

    expect(cache.entries().map((item) => item.id)).toEqual(["a", "b"]);
  });
});

describe("NegativeMemoryCache — relevance ordering", () => {
  it("returns entries newest first by timestamp", () => {
    const cache = new NegativeMemoryCache({ target: "demo" });

    cache.record(entry({ id: "oldest", timestamp: 1_000 }));
    cache.record(entry({ id: "newest", timestamp: 9_000 }));
    cache.record(entry({ id: "middle", timestamp: 5_000 }));

    expect(cache.entries().map((item) => item.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("breaks timestamp ties with the higher step first", () => {
    const cache = new NegativeMemoryCache({ target: "demo" });

    cache.record(entry({ id: "low-step", step: 2, timestamp: 4_000 }));
    cache.record(entry({ id: "high-step", step: 7, timestamp: 4_000 }));

    expect(cache.entries().map((item) => item.id)).toEqual(["high-step", "low-step"]);
  });

  it("breaks a full timestamp and step tie with the id, independent of record order", () => {
    const forward = new NegativeMemoryCache({ target: "demo" });
    forward.record(entry({ id: "aaa", step: 3, timestamp: 4_000 }));
    forward.record(entry({ id: "bbb", step: 3, timestamp: 4_000 }));

    const backward = new NegativeMemoryCache({ target: "demo" });
    backward.record(entry({ id: "bbb", step: 3, timestamp: 4_000 }));
    backward.record(entry({ id: "aaa", step: 3, timestamp: 4_000 }));

    expect(forward.entries().map((item) => item.id)).toEqual(["aaa", "bbb"]);
    expect(backward.entries().map((item) => item.id)).toEqual(["aaa", "bbb"]);
  });
});

describe("NegativeMemoryCache — persistence", () => {
  it("round-trips entries and the target key through save and load", () => {
    const file = join(makeTempDir(), "negative-memory.json");
    const cache = new NegativeMemoryCache({ target: "checkout" });

    cache.record(entry({ id: "hash-a", strategy: "batch size 500", step: 2, timestamp: 1_000 }));
    cache.record(entry({ id: "hash-b", strategy: "serial awaits", step: 3, timestamp: 2_000 }));
    cache.save(file);

    const loaded = NegativeMemoryCache.load(file, "checkout");

    expect(loaded.entries()).toEqual(cache.entries());
    expect(loaded.entries()).toHaveLength(2);
    expect(loaded.entries()[0]?.id).toBe("hash-b");
  });

  it("writes the documented JSON shape", () => {
    const file = join(makeTempDir(), "negative-memory.json");
    const cache = new NegativeMemoryCache({ target: "checkout" });

    cache.record(entry({ id: "hash-a" }));
    cache.save(file);

    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      version: number;
      targets: Record<string, { target: string; entries: NegativeMemoryEntry[] }>;
    };

    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed.targets)).toEqual(["checkout"]);
    expect(parsed.targets["checkout"]?.target).toBe("checkout");
    expect(parsed.targets["checkout"]?.entries).toHaveLength(1);
    expect(parsed.targets["checkout"]?.entries[0]?.id).toBe("hash-a");
  });

  it("creates the parent directory when it does not exist", () => {
    const file = join(makeTempDir(), "nested", "dir", "negative-memory.json");
    const cache = new NegativeMemoryCache({ target: "checkout" });

    cache.record(entry({ id: "hash-a" }));
    cache.save(file);

    expect(() => readFileSync(file, "utf8")).not.toThrow();
  });

  it("writes the file atomically and leaves no temporary file behind", () => {
    const dir = makeTempDir();
    const file = join(dir, "negative-memory.json");
    const cache = new NegativeMemoryCache({ target: "checkout" });

    cache.record(entry({ id: "hash-a" }));
    cache.save(file);
    cache.record(entry({ id: "hash-b" }));
    cache.save(file);

    // The destination always holds the complete document, and the temp file
    // used for the atomic rename is not left behind.
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      targets: Record<string, { entries: NegativeMemoryEntry[] }>;
    };
    expect(parsed.targets["checkout"]?.entries).toHaveLength(2);
    expect(readdirSync(dir)).toEqual(["negative-memory.json"]);
  });

  it("keeps different targets isolated in the same file", () => {
    const file = join(makeTempDir(), "negative-memory.json");

    const alpha = new NegativeMemoryCache({ target: "alpha" });
    alpha.record(entry({ id: "alpha-hash", strategy: "alpha strategy" }));
    alpha.save(file);

    const beta = new NegativeMemoryCache({ target: "beta" });
    beta.record(entry({ id: "beta-hash", strategy: "beta strategy" }));
    beta.save(file);

    const loadedAlpha = NegativeMemoryCache.load(file, "alpha");
    const loadedBeta = NegativeMemoryCache.load(file, "beta");

    expect(loadedAlpha.entries().map((item) => item.id)).toEqual(["alpha-hash"]);
    expect(loadedBeta.entries().map((item) => item.id)).toEqual(["beta-hash"]);
    expect(loadedAlpha.has("beta-hash")).toBe(false);
    expect(loadedBeta.has("alpha-hash")).toBe(false);
  });

  it("preserves other targets already on disk when saving", () => {
    const file = join(makeTempDir(), "negative-memory.json");

    const alpha = new NegativeMemoryCache({ target: "alpha" });
    alpha.record(entry({ id: "alpha-hash" }));
    alpha.save(file);

    const beta = new NegativeMemoryCache({ target: "beta" });
    beta.record(entry({ id: "beta-hash" }));
    beta.save(file);

    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      targets: Record<string, { entries: NegativeMemoryEntry[] }>;
    };

    expect(Object.keys(parsed.targets).sort()).toEqual(["alpha", "beta"]);
    expect(parsed.targets["alpha"]?.entries[0]?.id).toBe("alpha-hash");
    expect(parsed.targets["beta"]?.entries[0]?.id).toBe("beta-hash");
  });

  it("loads an empty cache when the file is missing", () => {
    const file = join(makeTempDir(), "does-not-exist.json");

    const loaded = NegativeMemoryCache.load(file, "checkout");

    expect(loaded.entries()).toEqual([]);
    expect(loaded.has("anything")).toBe(false);
  });

  it("loads an empty cache when the file is corrupt", () => {
    const file = join(makeTempDir(), "negative-memory.json");
    writeFileSync(file, "{ this is not json", "utf8");

    const loaded = NegativeMemoryCache.load(file, "checkout");

    expect(loaded.entries()).toEqual([]);
  });

  it("loads an empty cache when the target key is missing", () => {
    const file = join(makeTempDir(), "negative-memory.json");

    const alpha = new NegativeMemoryCache({ target: "alpha" });
    alpha.record(entry({ id: "alpha-hash" }));
    alpha.save(file);

    const loaded = NegativeMemoryCache.load(file, "unknown-target");

    expect(loaded.entries()).toEqual([]);
  });

  it("round-trips a target named __proto__", () => {
    const file = join(makeTempDir(), "negative-memory.json");
    const cache = new NegativeMemoryCache({ target: "__proto__" });

    cache.record(entry({ id: "hash-a", strategy: "serial awaits" }));
    cache.save(file);

    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      targets: Record<string, { target: string; entries: NegativeMemoryEntry[] }>;
    };
    expect(parsed.targets["__proto__"]?.target).toBe("__proto__");
    expect(parsed.targets["__proto__"]?.entries[0]?.id).toBe("hash-a");

    const loaded = NegativeMemoryCache.load(file, "__proto__");
    expect(loaded.entries().map((item) => item.id)).toEqual(["hash-a"]);
    expect(loaded.entries()[0]?.strategy).toBe("serial awaits");
  });

  it("never resolves an unknown target to an inherited object property", () => {
    const file = join(makeTempDir(), "negative-memory.json");

    const cache = new NegativeMemoryCache({ target: "demo" });
    cache.record(entry({ id: "hash-a" }));
    cache.save(file);

    for (const target of ["toString", "constructor", "hasOwnProperty"]) {
      expect(NegativeMemoryCache.load(file, target).entries()).toEqual([]);
    }
  });

  it("ignores a bucket inherited from the prototype chain", () => {
    const file = join(makeTempDir(), "negative-memory.json");

    const cache = new NegativeMemoryCache({ target: "demo" });
    cache.record(entry({ id: "hash-a" }));
    cache.save(file);

    const prototype = Object.prototype as unknown as Record<string, unknown>;
    prototype["polluted"] = {
      target: "polluted",
      entries: [entry({ id: "inherited-hash" })],
    };
    try {
      expect(NegativeMemoryCache.load(file, "polluted").entries()).toEqual([]);
    } finally {
      delete prototype["polluted"];
    }
  });

  it("honours the capacity when loading", () => {
    const file = join(makeTempDir(), "negative-memory.json");

    const cache = new NegativeMemoryCache({ target: "checkout", maxEntries: 3 });
    for (let i = 0; i < 5; i += 1) {
      cache.record(entry({ id: `hash-${i}`, deltaPercent: -(i + 1), timestamp: 1_000 + i }));
    }
    cache.save(file);

    const loaded = NegativeMemoryCache.load(file, "checkout");

    expect(loaded.entries()).toHaveLength(3);
  });

  it("keeps the most informative entries when reloading a file with more entries than the capacity", () => {
    const file = join(makeTempDir(), "negative-memory.json");

    const cache = new NegativeMemoryCache({ target: "target", maxEntries: 6 });
    for (let i = 0; i < 6; i += 1) {
      cache.record(entry({ id: `h${i}`, deltaPercent: -(i + 1), timestamp: 1_000 + i }));
    }
    cache.save(file);

    const loaded = NegativeMemoryCache.load(file, "target");

    expect(loaded.entries().map((item) => item.id)).toEqual(["h5", "h4", "h3", "h2", "h1"]);
    expect(loaded.has("h0")).toBe(false);
  });

  it("preserves every entry when reloading a file that fits the capacity", () => {
    const file = join(makeTempDir(), "negative-memory.json");

    const cache = new NegativeMemoryCache({ target: "target", maxEntries: 6 });
    for (let i = 0; i < 6; i += 1) {
      cache.record(entry({ id: `h${i}`, deltaPercent: -(i + 1), timestamp: 1_000 + i }));
    }
    cache.save(file);

    const loaded = NegativeMemoryCache.load(file, "target", 6);

    expect(loaded.entries().map((item) => item.id)).toEqual(["h5", "h4", "h3", "h2", "h1", "h0"]);
  });
});

describe("hashMutatedFiles", () => {
  it("returns the same hash for the same file set", () => {
    const files = [
      { relPath: "src/a.ts", content: "const a = 1;\n" },
      { relPath: "src/b.ts", content: "const b = 2;\n" },
    ];

    expect(hashMutatedFiles(files)).toBe(hashMutatedFiles(files));
  });

  it("ignores the order of the input files", () => {
    const first = hashMutatedFiles([
      { relPath: "src/a.ts", content: "const a = 1;\n" },
      { relPath: "src/b.ts", content: "const b = 2;\n" },
    ]);
    const second = hashMutatedFiles([
      { relPath: "src/b.ts", content: "const b = 2;\n" },
      { relPath: "src/a.ts", content: "const a = 1;\n" },
    ]);

    expect(first).toBe(second);
  });

  it("ignores the input order of files that share a relPath", () => {
    const first = hashMutatedFiles([
      { relPath: "src/a.ts", content: "const a = 1;\n" },
      { relPath: "src/a.ts", content: "const b = 2;\n" },
    ]);
    const second = hashMutatedFiles([
      { relPath: "src/a.ts", content: "const b = 2;\n" },
      { relPath: "src/a.ts", content: "const a = 1;\n" },
    ]);

    expect(first).toBe(second);
  });

  it("normalises path separators so the same change hashes identically on any platform", () => {
    const windows = hashMutatedFiles([
      { relPath: "src\\api\\checkout.ts", content: "const a = 1;\n" },
    ]);
    const posix = hashMutatedFiles([
      { relPath: "src/api/checkout.ts", content: "const a = 1;\n" },
    ]);

    expect(windows).toBe(posix);
  });

  it("changes the hash when the content changes", () => {
    const before = hashMutatedFiles([{ relPath: "src/a.ts", content: "const a = 1;\n" }]);
    const after = hashMutatedFiles([{ relPath: "src/a.ts", content: "const a = 2;\n" }]);

    expect(before).not.toBe(after);
  });

  it("changes the hash when a path changes", () => {
    const before = hashMutatedFiles([{ relPath: "src/a.ts", content: "const a = 1;\n" }]);
    const after = hashMutatedFiles([{ relPath: "src/b.ts", content: "const a = 1;\n" }]);

    expect(before).not.toBe(after);
  });

  it("normalises line endings so CRLF and LF hash identically", () => {
    const lf = hashMutatedFiles([{ relPath: "src/a.ts", content: "const a = 1;\nconst b = 2;\n" }]);
    const crlf = hashMutatedFiles([
      { relPath: "src/a.ts", content: "const a = 1;\r\nconst b = 2;\r\n" },
    ]);

    expect(lf).toBe(crlf);
  });

  it("returns a lowercase hex sha-256 digest", () => {
    const hash = hashMutatedFiles([{ relPath: "src/a.ts", content: "const a = 1;\n" }]);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes an empty file set deterministically", () => {
    expect(hashMutatedFiles([])).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMutatedFiles([])).toBe(hashMutatedFiles([]));
  });
});
