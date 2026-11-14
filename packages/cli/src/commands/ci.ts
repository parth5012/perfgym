import { loadConfig } from "../engine.js";
import { execSync } from "node:child_process";

export interface CiResult {
  passed: boolean;
  exitCode: number;
  markdown: string;
}

export function runCiCommand(): CiResult {
  const config = loadConfig();
  try {
    execSync(config.invariants.command, { stdio: "pipe" });
    return { passed: true, exitCode: 0, markdown: "### CI: ✅ pass\n\nInvariants green." };
  } catch (err: any) {
    return { passed: false, exitCode: 1, markdown: `### CI: ❌ fail\n\n${err?.stdout ?? err?.message ?? ""}` };
  }
}