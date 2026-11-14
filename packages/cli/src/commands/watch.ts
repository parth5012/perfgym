import { watch } from "node:fs";
import { loadConfig } from "../engine.js";
import { matchesGlob } from "../../../core/src/index.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export function matchGlob(filename: string, pattern: string): boolean {
  const placeholder = "\u0000";
  // Expand brace groups {a,b} -> (a|b) using a placeholder so the later
  // escaping pass does not mangle the alternation.
  const braceMatch = pattern.match(/\{[^}]+\}/);
  let working = pattern;
  let braceAlt: string | null = null;
  if (braceMatch) {
    const options = braceMatch[0].slice(1, -1).split(",");
    braceAlt = `(${options.map((o) => o.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("|")})`;
    working = working.replace(braceMatch[0], "\u0001");
  }
  const escaped = working.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const withDouble = escaped
    .replace(/\*\*\//g, `${placeholder}SLASH`)
    .replace(/\/\*\*/g, `SLASH${placeholder}`)
    .replace(/\*\*/g, placeholder)
    .replace(/\u0001/g, braceAlt ?? "");
  const regexSource =
    "^" +
    withDouble
      .replace(/\*/g, "[^/]*")
      .replace(new RegExp(`${placeholder}SLASH`, "g"), "(?:.*/)?")
      .replace(new RegExp(`SLASH${placeholder}`, "g"), "(?:/.*)?")
      .replace(new RegExp(placeholder, "g"), ".*") +
    "$";
  const regex = new RegExp(regexSource);
  if (regex.test(filename)) return true;
  const root = pattern.split("/")[0];
  return regex.test(`${root}/${filename}`);
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
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

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
      const fullPath = root === "." ? rel : `${root}/${rel}`;
      if (!files.some((f: string) => matchesGlob(f, fullPath))) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void runInvariants(), 200);
    });
    watchers.push(w);
  }
  return { stop: () => { if (debounceTimer) clearTimeout(debounceTimer); watchers.forEach((w) => w.close()); } };
}