/**
 * @perfgym/linter
 * Fast Typecheck Gate (ADR-007 two-tier, ADR-014 config integrity).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { LintViolation } from "@perfgym/core";

export interface ConfigIntegrityResult {
  ok: boolean;
  tampered: string[];
  disqualified: boolean;
}

export interface Tier1Result {
  passed: boolean;
  violations: LintViolation[];
  disqualified: boolean;
}

export interface Tier2Result {
  passed: boolean;
  errors: string[];
}

export interface BaselineEntry {
  path: string;
  hash: string;
}

type HashRecord = Record<string, string>;

interface FileContentInput {
  path?: string;
  file?: string;
  name?: string;
  content?: string;
  source?: string;
  hash?: string;
}

const PROTECTED_ROOT_FILES = ["tsconfig.json", "package.json", ".perfgym.yaml"];

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function hashFile(filePath: string): string {
  if (!existsSync(filePath)) return "";
  return sha256(readFileSync(filePath));
}

function isTestFile(rel: string): boolean {
  const norm = normalizePath(rel);
  return (
    /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(norm) ||
    norm.includes("/__tests__/") ||
    norm.startsWith("tests/") ||
    norm.includes("/tests/")
  );
}

function walkFiles(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist") continue;
    const full = path.join(root, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(full, out);
    } else if (st.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function discoverProtectedFiles(root: string): string[] {
  const result = new Set<string>();
  for (const f of PROTECTED_ROOT_FILES) {
    const full = path.join(root, f);
    if (existsSync(full)) result.add(normalizePath(f));
  }
  const all = walkFiles(root);
  for (const full of all) {
    const rel = normalizePath(path.relative(root, full));
    if (isTestFile(rel)) result.add(rel);
  }
  return Array.from(result);
}

function toHashRecord(input: unknown, root?: string): HashRecord {
  const out: HashRecord = {};
  if (input == null) return out;

  if (typeof input === "string") {
    if (existsSync(input) && statSync(input).isDirectory()) {
      const files = root ? discoverProtectedFiles(root) : discoverProtectedFiles(input);
      const base = input;
      for (const rel of files) {
        out[rel] = hashFile(path.join(base, rel));
      }
      return out;
    }
    return out;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        if (existsSync(item) && statSync(item).isFile()) {
          const key = root ? normalizePath(path.relative(root, item)) : normalizePath(item);
          out[key || item] = hashFile(item);
        } else if (existsSync(item) && statSync(item).isDirectory()) {
          const files = discoverProtectedFiles(item);
          for (const rel of files) {
            out[rel] = hashFile(path.join(item, rel));
          }
        }
      } else if (item && typeof item === "object") {
        const obj = item as FileContentInput;
        const key = normalizePath(
          (obj.path ?? obj.file ?? obj.name ?? "").toString()
        );
        if (!key) continue;
        if (typeof obj.hash === "string") {
          out[key] = obj.hash;
        } else if (typeof obj.content === "string" || typeof obj.source === "string") {
          out[key] = sha256((obj.content ?? obj.source) as string);
        }
      }
    }
    return out;
  }

  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (obj.hashes && typeof obj.hashes === "object") return toHashRecord(obj.hashes, root);
    if (obj.baseline && typeof obj.baseline === "object") return toHashRecord(obj.baseline, root);
    if (Array.isArray(obj.files)) return toHashRecord(obj.files, root);
    if (Array.isArray(obj.entries)) return toHashRecord(obj.entries, root);

    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") {
        out[normalizePath(k)] = v;
      } else if (v && typeof v === "object") {
        const nested = v as FileContentInput;
        if (typeof nested.hash === "string") out[normalizePath(k)] = nested.hash;
        else if (typeof nested.content === "string" || typeof nested.source === "string") {
          out[normalizePath(k)] = sha256((nested.content ?? nested.source) as string);
        }
      }
    }
    return out;
  }

  return out;
}

function strictDisabledInContent(content: string): boolean {
  return /"strict"\s*:\s*false/.test(content);
}

function strictDisabledInTsconfig(root: string): string[] {
  const tampered: string[] = [];
  const full = path.join(root, "tsconfig.json");
  if (existsSync(full)) {
    try {
      const content = readFileSync(full, "utf8");
      if (strictDisabledInContent(content)) tampered.push("tsconfig.json");
    } catch {
      // ignore
    }
  }
  return tampered;
}

export class TypecheckGate {
  public disqualified: boolean;
  protected root: string | null;
  protected baseline: HashRecord;
  protected protectedFiles: string[];

  constructor(baselineFiles?: string[] | string) {
    this.disqualified = false;
    this.root = null;
    this.baseline = {};
    this.protectedFiles = [];

    if (typeof baselineFiles === "string") {
      this.initBaseline(baselineFiles);
    } else if (Array.isArray(baselineFiles)) {
      const record: HashRecord = {};
      for (const f of baselineFiles) {
        if (typeof f !== "string") continue;
        if (existsSync(f) && statSync(f).isFile()) {
          const key = normalizePath(f);
          record[key] = hashFile(f);
        }
      }
      this.protectedFiles = baselineFiles.map((f) => normalizePath(f));
      this.baseline = record;
    } else {
      this.protectedFiles = [];
    }
  }

  public initBaseline(projectRoot: string, protectedFiles?: string[]): this {
    this.root = projectRoot;
    this.disqualified = false;
    const files = protectedFiles
      ? protectedFiles.map((f) => normalizePath(f))
      : discoverProtectedFiles(projectRoot);
    this.protectedFiles = files;
    const record: HashRecord = {};
    for (const rel of files) {
      record[rel] = hashFile(path.join(projectRoot, rel));
    }
    this.baseline = record;
    return this;
  }

  public getBaselineHashes(): HashRecord {
    return { ...this.baseline };
  }

  public getProtectedFiles(): string[] {
    return [...this.protectedFiles];
  }

  public hashFile(filePath: string): string {
    return hashFile(filePath);
  }

  public static hashContent(content: string): string {
    return sha256(content);
  }

  public checkConfigIntegrity(currentHashes?: unknown): ConfigIntegrityResult {
    const baseline = this.baseline;
    const root = this.root;

    let current: HashRecord;
    if (currentHashes === undefined) {
      if (root) {
        current = {};
        for (const rel of Object.keys(baseline)) {
          current[rel] = existsSync(path.join(root, rel))
            ? hashFile(path.join(root, rel))
            : "";
        }
      } else {
        // No root: re-hash from disk when a baseline key resolves to an
        // existing file; otherwise preserve the baseline entry.
        current = {};
        for (const key of Object.keys(baseline)) {
          if (existsSync(key) && statSync(key).isFile()) {
            current[key] = hashFile(key);
          } else {
            current[key] = baseline[key];
          }
        }
      }
    } else {
      current = toHashRecord(currentHashes, root ?? undefined);
    }

    if (Object.keys(current).length === 0 && root) {
      const files = this.protectedFiles.length ? this.protectedFiles : discoverProtectedFiles(root);
      for (const rel of files) {
        current[rel] = existsSync(path.join(root, rel)) ? hashFile(path.join(root, rel)) : "";
      }
    }

    const tampered = new Set<string>();

    for (const [key, baseHash] of Object.entries(baseline)) {
      const cur = current[key];
      if (cur === undefined) {
        if (root) {
          if (existsSync(path.join(root, key))) {
            const diskHash = hashFile(path.join(root, key));
            if (diskHash !== baseHash) tampered.add(key);
          } else {
            tampered.add(key);
          }
        } else if (existsSync(key) && statSync(key).isFile()) {
          if (hashFile(key) !== baseHash) tampered.add(key);
        } else {
          tampered.add(key);
        }
      } else if (cur === "" && baseHash !== "") {
        tampered.add(key);
      } else if (cur !== baseHash) {
        tampered.add(key);
      }
    }

    if (root) {
      for (const t of strictDisabledInTsconfig(root)) tampered.add(t);
    }

    try {
      const raw = currentHashes as any;
      if (raw && typeof raw === "object") {
        const stack: any[] = [raw];
        while (stack.length) {
          const node = stack.pop();
          if (!node || typeof node !== "object") continue;
          if (typeof node.content === "string" && strictDisabledInContent(node.content)) {
            const p = node.path ?? node.file ?? node.name;
            tampered.add(p ? normalizePath(String(p)) : "tsconfig.json");
          }
          if (typeof node.source === "string" && strictDisabledInContent(node.source)) {
            const p = node.path ?? node.file ?? node.name;
            tampered.add(p ? normalizePath(String(p)) : "tsconfig.json");
          }
          for (const v of Object.values(node)) {
            if (v && typeof v === "object") stack.push(v);
          }
        }
      }
      if (typeof currentHashes === "string" && strictDisabledInContent(currentHashes)) {
        tampered.add("tsconfig.json");
      }
    } catch {
      // ignore
    }

    if (Object.keys(baseline).length === 0 && root) {
      const full = path.join(root, "tsconfig.json");
      if (existsSync(full)) {
        try {
          if (strictDisabledInContent(readFileSync(full, "utf8"))) {
            tampered.add("tsconfig.json");
          }
        } catch {
          // ignore
        }
      }
    }

    const tamperedArr = Array.from(tampered);
    const ok = tamperedArr.length === 0;
    this.disqualified = this.disqualified || !ok;
    return { ok, tampered: tamperedArr, disqualified: this.disqualified };
  }

  public tier1Scan(fileContents: string | unknown): Tier1Result {
    const items: { path: string; content: string }[] = [];
    if (typeof fileContents === "string") {
      items.push({ path: "<input>", content: fileContents });
    } else if (Array.isArray(fileContents)) {
      for (const entry of fileContents) {
        if (typeof entry === "string") {
          items.push({ path: "<input>", content: entry });
        } else if (entry && typeof entry === "object") {
          const obj = entry as FileContentInput;
          const p = (obj.path ?? obj.file ?? obj.name ?? "<input>").toString();
          const c = (obj.content ?? obj.source ?? "").toString();
          items.push({ path: p, content: c });
        }
      }
    } else if (fileContents && typeof fileContents === "object") {
      const obj = fileContents as FileContentInput;
      if (typeof obj.content === "string" || typeof obj.source === "string") {
        items.push({
          path: (obj.path ?? obj.file ?? obj.name ?? "<input>").toString(),
          content: (obj.content ?? obj.source ?? "").toString(),
        });
      }
    }

    const violations: LintViolation[] = [];
    for (const item of items) {
      const lines = item.content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/@ts-ignore\b/.test(line) || /@ts-nocheck\b/.test(line) || /@ts-expect-error\b/.test(line)) {
          const directive = /@ts-expect-error\b/.test(line)
            ? "no-ts-expect-error"
            : /@ts-nocheck\b/.test(line)
            ? "no-ts-nocheck"
            : "no-ts-ignore";
          violations.push({
            ruleId: directive,
            message: `Forbidden TypeScript suppression comment ${directive.replace("no-", "@")}`,
            file: item.path,
            line: i + 1,
            severity: "error",
            penalty: 0,
            action: "disqualify",
          });
        }
        if (/\beval\s*\(/.test(line) || /\bnew\s+Function\s*\(/.test(line)) {
          violations.push({
            ruleId: "no-dynamic-eval",
            message: "Forbidden dynamic code generation (eval / Function)",
            file: item.path,
            line: i + 1,
            severity: "error",
            penalty: 0,
            action: "disqualify",
          });
        }
        if (/\bas\s+any\b/.test(line)) {
          violations.push({
            ruleId: "no-any-cast",
            message: "Unsafe cast to 'any' detected",
            file: item.path,
            line: i + 1,
            severity: "error",
            penalty: 0,
            action: "disqualify",
          });
        }
      }
    }

    const hasDisqualify = violations.some((v) => v.action === "disqualify");
    if (hasDisqualify) this.disqualified = true;
    return {
      passed: violations.length === 0,
      violations,
      disqualified: this.disqualified,
    };
  }

  public tier2Run(projectRoot?: string): Tier2Result {
    const root = projectRoot ?? this.root ?? process.cwd();
    const candidatePaths = [
      path.join(root, "node_modules", "typescript", "bin", "tsc"),
      path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
    ];
    let tscPath: string | null = null;
    for (const c of candidatePaths) {
      if (existsSync(c)) {
        tscPath = c;
        break;
      }
    }

    let result: ReturnType<typeof spawnSync>;
    try {
      if (tscPath) {
        result = spawnSync(process.execPath, [tscPath, "--noEmit"], {
          cwd: root,
          encoding: "utf8",
          timeout: 180000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } else {
        result = spawnSync("tsc", ["--noEmit"], {
          cwd: root,
          encoding: "utf8",
          timeout: 180000,
          maxBuffer: 10 * 1024 * 1024,
          shell: true,
        });
      }
    } catch (err) {
      return { passed: false, errors: [String(err)] };
    }

    const stdout = (result.stdout ?? "").toString();
    const stderr = (result.stderr ?? "").toString();
    const combined = `${stdout}\n${stderr}`.trim();
    const errors = combined
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (result.error) {
      return { passed: false, errors: [result.error.message, ...errors] };
    }

    const passed = result.status === 0;
    return { passed, errors: passed ? [] : errors };
  }
}

export const ConfigIntegrityGuard = TypecheckGate;
export type ConfigIntegrityGuard = TypecheckGate;

export function initBaseline(projectRoot: string): TypecheckGate {
  return new TypecheckGate().initBaseline(projectRoot);
}

export function checkConfigIntegrity(currentHashes: unknown): ConfigIntegrityResult {
  return new TypecheckGate().checkConfigIntegrity(currentHashes);
}

export function tier1Scan(fileContents: string | unknown): Tier1Result {
  return new TypecheckGate().tier1Scan(fileContents);
}

export function tier2Run(projectRoot?: string): Tier2Result {
  return new TypecheckGate().tier2Run(projectRoot);
}

export function hashContent(content: string): string {
  return sha256(content);
}

export { sha256 as hashString, hashFile };
export default TypecheckGate;
