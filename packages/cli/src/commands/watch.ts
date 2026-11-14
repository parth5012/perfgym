import { watch } from "node:fs";
import { loadConfig } from "../engine.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

function matchGlob(filename: string, pattern: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, ".*")
        .replace(/\*/g, "[^/]*") +
      "$",
  );
  return regex.test(filename);
}

export interface WatchOptions {
  onEvent?: (msg: string) => void;
}

export function runWatchCommand(options: WatchOptions = {}): { stop: () => void } {
  const log = options.onEvent ?? ((m: string) => console.log(m));
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    log(`watch: ${(err as Error).message}`);
    return { stop: () => {} };
  }
  const files = config.target.files;
  const watchers: ReturnType<typeof watch>[] = [];
  let running = false;
  let pending = false;

  const runInvariants = async () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    try {
      await execAsync(config.invariants.command, { timeout: config.invariants.timeoutMs ?? 10000, maxBuffer: 1024 * 1024 });
      log("invariants: pass");
    } catch (err: any) {
      log(`invariants: fail\n${err?.stderr ?? err?.message ?? ""}`);
    } finally {
      running = false;
      if (pending) {
        pending = false;
        void runInvariants();
      }
    }
  };

  const roots = new Set(files.map((f: string) => (f.includes("/") ? f.split("/")[0] : ".")));
  for (const root of roots) {
    const w = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString().replace(/\\/g, "/");
      if (!files.some((f: string) => matchGlob(rel, f))) return;
      void runInvariants();
    });
    watchers.push(w);
  }
  return { stop: () => watchers.forEach((w) => w.close()) };
}