import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  DiskBudgetManager,
  type WorktreeUsageEntry,
  type UsageManifest,
} from "./disk-budget.js";

describe("DiskBudgetManager (Ticket #59)", () => {
  let tempDir: string;
  let worktreesDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "perfgym-disk-budget-test-"));
    worktreesDir = path.join(tempDir, ".perfgym", "worktrees");
    fs.mkdirSync(worktreesDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("size accounting over fixture tree", () => {
    it("computes recursive size of worktree directories accurately", () => {
      const wt1 = path.join(worktreesDir, "run-1");
      const wt2 = path.join(worktreesDir, "run-2");
      fs.mkdirSync(path.join(wt1, "sub"), { recursive: true });
      fs.mkdirSync(wt2, { recursive: true });

      // wt1 has 100 bytes + 200 bytes = 300 bytes
      fs.writeFileSync(path.join(wt1, "file1.txt"), Buffer.alloc(100, 1));
      fs.writeFileSync(path.join(wt1, "sub", "file2.txt"), Buffer.alloc(200, 2));

      // wt2 has 400 bytes
      fs.writeFileSync(path.join(wt2, "file3.txt"), Buffer.alloc(400, 3));

      const manager = DiskBudgetManager.load(worktreesDir);
      const total = manager.totalSizeBytes();

      // Total must be at least 700 bytes (file content size sum)
      expect(total).toBe(700);

      // Measuring specific worktree directory size
      expect(manager.getDirectorySize(wt1)).toBe(300);
      expect(manager.getDirectorySize(wt2)).toBe(400);
    });

    it("ignores symbolic links to prevent circular loops or escaping root", () => {
      const wt1 = path.join(worktreesDir, "run-sym");
      const externalDir = path.join(tempDir, "external");
      fs.mkdirSync(wt1, { recursive: true });
      fs.mkdirSync(externalDir, { recursive: true });
      fs.writeFileSync(path.join(wt1, "real.txt"), Buffer.alloc(100, 1));
      fs.writeFileSync(path.join(externalDir, "external.txt"), Buffer.alloc(10000, 2));

      // Create a symlink pointing to externalDir
      try {
        fs.symlinkSync(externalDir, path.join(wt1, "ext-link"));
      } catch {
        // Symlinks may require elevated privileges on some Windows configurations; skip if unsupported
      }

      const manager = DiskBudgetManager.load(worktreesDir);
      // wt1 size must be 100, ignoring the 10000 bytes in externalDir
      expect(manager.getDirectorySize(wt1)).toBe(100);
      expect(manager.totalSizeBytes()).toBe(100);
    });

    it("rejects path traversal and invalid directory names in runId", () => {
      const manager = DiskBudgetManager.load(worktreesDir);
      expect(() => manager.recordUse("../escaped")).toThrow();
      expect(() => manager.getWorktreeUsage("../../escaped")).toThrow();
      expect(() => manager.recordUse("")).toThrow();
      expect(() => manager.recordUse(".")).toThrow();
      expect(() => manager.recordUse("foo/bar")).toThrow();
      expect(() => manager.recordUse("foo\\bar")).toThrow();
    });

    it("prevents prototype pollution when deserializing manifest", () => {
      const manifestPath = path.join(worktreesDir, ".usage.json");
      fs.writeFileSync(
        manifestPath,
        JSON.stringify({
          __proto__: { polluted: true },
          "run-safe": { lastUsedAt: 1234, sizeBytes: 100 },
        }),
        "utf8"
      );

      const manager = DiskBudgetManager.load(worktreesDir);
      expect(manager.usage()["run-safe"]).toBeDefined();
      expect(({} as any).polluted).toBeUndefined();
    });
  });

  describe("manifest round-trip & recording", () => {
    it("records use and round-trips correctly via save() and load()", () => {
      const wt1 = path.join(worktreesDir, "run-abc");
      fs.mkdirSync(wt1, { recursive: true });
      fs.writeFileSync(path.join(wt1, "code.ts"), Buffer.alloc(256, 9));

      const manager = DiskBudgetManager.load(worktreesDir);
      const beforeTime = Date.now() - 10;
      manager.recordUse("run-abc");
      manager.save();

      const manifestPath = path.join(worktreesDir, ".usage.json");
      expect(fs.existsSync(manifestPath)).toBe(true);

      // Reload
      const loaded = DiskBudgetManager.load(worktreesDir);
      const usage = loaded.usage();
      expect(usage["run-abc"]).toBeDefined();
      expect(usage["run-abc"].sizeBytes).toBe(256);
      expect(usage["run-abc"].lastUsedAt).toBeGreaterThanOrEqual(beforeTime);
    });

    it("allows explicitly specifying sizeBytes in recordUse", () => {
      const manager = DiskBudgetManager.load(worktreesDir);
      const timestamp = 1700000000000;
      manager.recordUse("run-custom", 1024, timestamp);
      manager.save();

      const loaded = DiskBudgetManager.load(worktreesDir);
      const entry = loaded.usage()["run-custom"];
      expect(entry).toEqual({
        lastUsedAt: timestamp,
        sizeBytes: 1024,
      });
    });
  });

  describe("corrupt or missing manifest fallback", () => {
    it("treats missing manifest as empty usage and falls back to directory mtime", () => {
      const wtPath = path.join(worktreesDir, "run-untracked");
      fs.mkdirSync(wtPath, { recursive: true });
      fs.writeFileSync(path.join(wtPath, "file.txt"), Buffer.alloc(50, 1));

      const stat = fs.statSync(wtPath);

      const manager = DiskBudgetManager.load(worktreesDir);
      expect(manager.usage()).toEqual({});

      const entry = manager.getWorktreeUsage("run-untracked");
      expect(entry.sizeBytes).toBe(50);
      expect(entry.lastUsedAt).toBe(Math.floor(stat.mtimeMs));
    });

    it("treats corrupt or non-object JSON as empty usage without throwing", () => {
      const manifestPath = path.join(worktreesDir, ".usage.json");
      fs.writeFileSync(manifestPath, "{ corrupt json !!!", "utf8");

      const manager = DiskBudgetManager.load(worktreesDir);
      expect(manager.usage()).toEqual({});

      // Non-object JSON
      fs.writeFileSync(manifestPath, "[\"an\", \"array\"]", "utf8");
      const manager2 = DiskBudgetManager.load(worktreesDir);
      expect(manager2.usage()).toEqual({});

      // Null JSON
      fs.writeFileSync(manifestPath, "null", "utf8");
      const manager3 = DiskBudgetManager.load(worktreesDir);
      expect(manager3.usage()).toEqual({});
    });
  });

  describe("atomic manifest write", () => {
    it("ensures previous manifest survives a failed write", () => {
      const manager = DiskBudgetManager.load(worktreesDir);
      manager.recordUse("run-initial", 500, 1000);
      manager.save();

      const manifestPath = path.join(worktreesDir, ".usage.json");
      const initialContent = fs.readFileSync(manifestPath, "utf8");

      // Attempt to save new state with a failing renameSync
      manager.recordUse("run-second", 800, 2000);
      expect(() => {
        manager.save({
          renameSync: () => {
            throw new Error("Disk full or simulated failure during atomic rename");
          },
        });
      }).toThrow("Disk full or simulated failure during atomic rename");

      // The original file content must still be intact and valid
      const contentAfterFail = fs.readFileSync(manifestPath, "utf8");
      expect(contentAfterFail).toBe(initialContent);

      const reloaded = DiskBudgetManager.load(worktreesDir);
      expect(reloaded.usage()["run-initial"]).toEqual({
        lastUsedAt: 1000,
        sizeBytes: 500,
      });
      expect(reloaded.usage()["run-second"]).toBeUndefined();
    });
  });
});
