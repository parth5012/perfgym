import { watch } from "node:fs";
import { loadConfig } from "../engine.js";
import { execSync } from "node:child_process";

export interface WatchOptions {
  onEvent?: (msg: string) => void;
}

export function runWatchCommand(options: WatchOptions = {}): { stop: () => void } {
  const log = options.onEvent ?? ((m: string) => console.log(m));
  const config = loadConfig();
  const files = config.target.files;
  const dirs = new Set(files.map((f: string) => f.split("/")[0] || "."));
  const watchers = [...dirs].map((d) =>
    watch(d, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (!files.some((f: string) => filename.toString().endsWith(f.split("/").pop() ?? ""))) return;
      log(`change detected: ${filename}`);
      try {
        execSync(config.invariants.command, { stdio: "inherit" });
        log("invariants: pass");
      } catch {
        log("invariants: fail");
      }
    }),
  );
  return { stop: () => watchers.forEach((w) => w.close()) };
}