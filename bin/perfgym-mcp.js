#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mcpEntry = resolve(__dirname, "../packages/mcp-server/src/index.ts");
const tsxBin = resolve(__dirname, "../node_modules/.bin/tsx");

const res = spawnSync(tsxBin, [mcpEntry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

if (res.error) {
  console.error(res.error);
  process.exit(1);
}

process.exit(res.status ?? 1);
