import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  WorktreeDiskBudgetExceededError,
  ERR_WORKTREE_DISK_BUDGET_EXCEEDED,
} from "../errors.js";

export interface WorktreeUsageEntry {
  lastUsedAt: number;
  sizeBytes: number;
}

export type UsageManifest = Record<string, WorktreeUsageEntry>;

export const USAGE_MANIFEST_FILENAME = ".usage.json";

export interface EvictionOptions {
  capBytes: number;
  estimatedNewBytes?: number;
  protectedRunIds?: Iterable<string>;
  activeRunId?: string;
  repoRoot?: string;
  pruneBranches?: boolean;
  baseRef?: string;
  gitExec?: (args: string[], cwd: string) => string;
}

export interface EvictionResult {
  evictedRunIds: string[];
  freedBytes: number;
  totalSizeBytes: number;
}

/**
 * Formats a byte quantity into a human-readable string (e.g. 2 GB, 2.1 GB, 500 MB).
 */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) {
    const formatted = gb.toFixed(1).replace(/\.0$/, "");
    return `${formatted} GB`;
  }
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) {
    const formatted = mb.toFixed(1).replace(/\.0$/, "");
    return `${formatted} MB`;
  }
  const kb = bytes / 1024;
  if (kb >= 1) {
    const formatted = kb.toFixed(1).replace(/\.0$/, "");
    return `${formatted} KB`;
  }
  return `${bytes} B`;
}

/**
 * DiskBudgetManager
 *
 * Implements worktree disk accounting and the durable usage manifest
 * per ADR-004 and Wayfinder Map #73.
 */
export class DiskBudgetManager {
  private worktreesDir: string;
  private manifestData: UsageManifest;

  constructor(worktreesDir: string, manifest: UsageManifest = {}) {
    this.worktreesDir = path.resolve(worktreesDir);
    this.manifestData = { ...manifest };
  }

  /**
   * Asserts that runId is safe (no path traversal).
   */
  private assertSafeRunId(runId: string): string {
    if (
      !runId ||
      runId.trim() === "" ||
      runId === "." ||
      runId.includes("/") ||
      runId.includes("\\")
    ) {
      throw new Error(`Invalid runId '${runId}': must be a valid non-empty single directory name.`);
    }
    const wtPath = path.resolve(this.worktreesDir, runId);
    const rel = path.relative(this.worktreesDir, wtPath);
    if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "" || runId.includes("..")) {
      throw new Error(`Invalid runId '${runId}': cannot traverse outside worktree root directory.`);
    }
    return wtPath;
  }

  /**
   * Calculates the recursive size in bytes of a single directory by summing
   * the size of all contained regular files. Skips symbolic links to avoid
   * loops or counting files outside the directory boundary.
   */
  public getDirectorySize(dirPath: string): number {
    if (!fs.existsSync(dirPath)) return 0;

    let total = 0;
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        try {
          if (entry.isSymbolicLink()) {
            continue;
          } else if (entry.isDirectory()) {
            total += this.getDirectorySize(fullPath);
          } else if (entry.isFile()) {
            const stat = fs.statSync(fullPath);
            total += stat.size;
          }
        } catch {
          // Ignore files that vanished or cannot be stat'd
        }
      }
    } catch {
      // Ignore directory read errors
    }
    return total;
  }

  /**
   * Computes the total recursive size of all worktree subdirectories
   * under worktreesDir, ignoring root-level metadata files (e.g. .usage.json).
   */
  public totalSizeBytes(): number {
    if (!fs.existsSync(this.worktreesDir)) return 0;

    let total = 0;
    try {
      const entries = fs.readdirSync(this.worktreesDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isSymbolicLink() && entry.isDirectory()) {
          const wtPath = path.join(this.worktreesDir, entry.name);
          total += this.getDirectorySize(wtPath);
        }
      }
    } catch {
      // Ignore directory read errors
    }
    return total;
  }

  /**
   * Records or updates the usage timestamp and disk consumption for a given runId.
   */
  public recordUse(runId: string, sizeBytes?: number, lastUsedAt?: number): void {
    const wtPath = this.assertSafeRunId(runId);
    const timestamp = lastUsedAt ?? Date.now();
    let computedSize: number;

    if (sizeBytes !== undefined) {
      computedSize = sizeBytes;
    } else {
      if (fs.existsSync(wtPath)) {
        computedSize = this.getDirectorySize(wtPath);
      } else {
        computedSize = this.manifestData[runId]?.sizeBytes ?? 0;
      }
    }

    this.manifestData[runId] = {
      lastUsedAt: timestamp,
      sizeBytes: computedSize,
    };
  }

  /**
   * Returns a copy of the current usage manifest.
   */
  public usage(): Readonly<UsageManifest> {
    return { ...this.manifestData };
  }

  /**
   * Retrieves the usage info for a worktree.
   * If recorded in the manifest, returns that entry.
   * Otherwise, falls back to inspecting directory mtime and disk size.
   */
  public getWorktreeUsage(runId: string): WorktreeUsageEntry {
    const wtPath = this.assertSafeRunId(runId);
    const entry = this.manifestData[runId];
    if (entry) {
      return { ...entry };
    }

    if (fs.existsSync(wtPath)) {
      try {
        const stat = fs.statSync(wtPath);
        return {
          lastUsedAt: Math.floor(stat.mtimeMs),
          sizeBytes: this.getDirectorySize(wtPath),
        };
      } catch {
        // Fall through
      }
    }

    return {
      lastUsedAt: 0,
      sizeBytes: 0,
    };
  }

  /**
   * Enforces the disk budget before creating a new worktree or during reclamation.
   * Evicts least-recently-used worktrees until `totalSizeBytes + estimatedNewBytes <= capBytes`.
   * Never evicts protected runIds or the active runId.
   * If the budget cannot be met after evicting all eligible worktrees, fails fast with
   * `WorktreeDiskBudgetExceededError`.
   */
  public evictLruToFit(options: EvictionOptions): EvictionResult {
    const estimatedNew = options.estimatedNewBytes ?? 0;
    let currentTotal = this.totalSizeBytes();

    if (currentTotal + estimatedNew <= options.capBytes) {
      return {
        evictedRunIds: [],
        freedBytes: 0,
        totalSizeBytes: currentTotal,
      };
    }

    const protectedSet = new Set<string>(options.protectedRunIds ?? []);
    if (options.activeRunId) {
      protectedSet.add(options.activeRunId);
    }

    // Discover candidate worktrees in worktreesDir
    const candidateRunIds: string[] = [];
    if (fs.existsSync(this.worktreesDir)) {
      try {
        const entries = fs.readdirSync(this.worktreesDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isSymbolicLink() && entry.isDirectory()) {
            const runId = entry.name;
            if (!protectedSet.has(runId)) {
              candidateRunIds.push(runId);
            }
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    // Sort candidate runIds by lastUsedAt ascending (oldest first)
    candidateRunIds.sort((a, b) => {
      const usageA = this.getWorktreeUsage(a);
      const usageB = this.getWorktreeUsage(b);
      return usageA.lastUsedAt - usageB.lastUsedAt;
    });

    const repoRoot = options.repoRoot ?? path.resolve(this.worktreesDir, "..", "..");
    const gitExec =
      options.gitExec ??
      ((args: string[], cwd: string): string =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim());

    const evictedRunIds: string[] = [];
    let freedBytes = 0;

    for (const runId of candidateRunIds) {
      const wtPath = path.join(this.worktreesDir, runId);
      const dirSize = this.getDirectorySize(wtPath);

      // Evict using git worktree remove
      try {
        gitExec(["worktree", "remove", "--force", wtPath], repoRoot);
      } catch {
        // Fall back to deleting directory if git worktree remove encounters issues
      }

      // Ensure directory is completely removed
      if (fs.existsSync(wtPath)) {
        try {
          fs.rmSync(wtPath, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }

      // Prune git metadata
      try {
        gitExec(["worktree", "prune"], repoRoot);
      } catch {
        // Ignore prune failures
      }

      // Prune branch if enabled and (if baseRef is provided) unmerged
      if (options.pruneBranches) {
        const branchName = `perfgym/eval-${runId}`;
        let shouldPrune = true;
        if (options.baseRef) {
          try {
            gitExec(["merge-base", "--is-ancestor", branchName, options.baseRef], repoRoot);
            // If branch is an ancestor of baseRef, it is merged
            shouldPrune = false;
          } catch {
            // Not an ancestor -> unmerged
            shouldPrune = true;
          }
        }

        if (shouldPrune) {
          try {
            gitExec(["branch", "-D", branchName], repoRoot);
          } catch {
            // Ignore branch deletion errors
          }
        }
      }

      // Update manifest
      delete this.manifestData[runId];
      freedBytes += dirSize;
      evictedRunIds.push(runId);

      currentTotal = Math.max(0, currentTotal - dirSize);
      if (currentTotal + estimatedNew <= options.capBytes) {
        break;
      }
    }

    if (currentTotal + estimatedNew > options.capBytes) {
      // Save manifest before throwing to record any partial evictions
      try {
        this.save();
      } catch {
        // Ignore save error on throw
      }

      const totalUsed = currentTotal + estimatedNew;
      const usedStr = formatBytes(totalUsed);
      const capStr = formatBytes(options.capBytes);
      throw new WorktreeDiskBudgetExceededError({
        code: ERR_WORKTREE_DISK_BUDGET_EXCEEDED,
        worktreeDir: this.worktreesDir,
        capBytes: options.capBytes,
        usedBytes: totalUsed,
        message: `disk budget exceeded: ${usedStr} used, cap ${capStr}, nothing left to evict — raise \`sandbox.disk_budget_mb\` or free space`,
      });
    }

    this.save();

    return {
      evictedRunIds,
      freedBytes,
      totalSizeBytes: currentTotal,
    };
  }

  /**
   * Atomically saves the manifest to `.usage.json` via temp file write and rename.
   */
  public save(
    fsAdapter: {
      mkdirSync?: typeof fs.mkdirSync;
      writeFileSync?: typeof fs.writeFileSync;
      renameSync?: typeof fs.renameSync;
      unlinkSync?: typeof fs.unlinkSync;
    } = fs
  ): void {
    const mkdirSync = fsAdapter.mkdirSync ?? fs.mkdirSync;
    const writeFileSync = fsAdapter.writeFileSync ?? fs.writeFileSync;
    const renameSync = fsAdapter.renameSync ?? fs.renameSync;
    const unlinkSync = fsAdapter.unlinkSync ?? fs.unlinkSync;

    mkdirSync(this.worktreesDir, { recursive: true });
    const targetPath = path.join(this.worktreesDir, USAGE_MANIFEST_FILENAME);
    const tmpPath = path.join(
      this.worktreesDir,
      `${USAGE_MANIFEST_FILENAME}.tmp.${process.pid}.${Date.now()}`
    );

    try {
      writeFileSync(tmpPath, JSON.stringify(this.manifestData, null, 2), "utf8");
      try {
        renameSync(tmpPath, targetPath);
      } catch (renameErr: unknown) {
        if (
          process.platform === "win32" &&
          (renameErr as NodeJS.ErrnoException)?.code === "EPERM"
        ) {
          try {
            unlinkSync(targetPath);
          } catch {
            // Target might not exist or failed to unlink
          }
          renameSync(tmpPath, targetPath);
        } else {
          throw renameErr;
        }
      }
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore unlink error on failure cleanup
      }
      throw err;
    }
  }

  /**
   * Loads the usage manifest from `.usage.json`.
   * A missing or corrupt manifest degrades gracefully to an empty manifest
   * (falling back to directory mtime) and never throws.
   */
  public static load(worktreesDir: string): DiskBudgetManager {
    const resolvedDir = path.resolve(worktreesDir);
    const manifestPath = path.join(resolvedDir, USAGE_MANIFEST_FILENAME);

    if (!fs.existsSync(manifestPath)) {
      return new DiskBudgetManager(resolvedDir, {});
    }

    try {
      const content = fs.readFileSync(manifestPath, "utf8");
      const parsed = JSON.parse(content) as unknown;

      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return new DiskBudgetManager(resolvedDir, {});
      }

      const validManifest: UsageManifest = {};
      for (const [key, val] of Object.entries(parsed)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          continue;
        }
        if (
          typeof val === "object" &&
          val !== null &&
          typeof (val as Record<string, unknown>).lastUsedAt === "number" &&
          typeof (val as Record<string, unknown>).sizeBytes === "number"
        ) {
          validManifest[key] = {
            lastUsedAt: (val as WorktreeUsageEntry).lastUsedAt,
            sizeBytes: (val as WorktreeUsageEntry).sizeBytes,
          };
        }
      }

      return new DiskBudgetManager(resolvedDir, validManifest);
    } catch {
      // Corrupt JSON or unreadable file: degrade cleanly to empty manifest
      return new DiskBudgetManager(resolvedDir, {});
    }
  }
}
