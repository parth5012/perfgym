/**
 * ============================================================================
 * CommandExecutor Seam
 * ============================================================================
 *
 * Single abstraction point for external command execution across PerfGym.
 * Constrains what commands may do with backend-specific capability policies.
 */

export interface CommandCapabilities {
  readPaths?: string[];
  writePaths?: string[];
  needsNetwork?: boolean;
  needsChildProcess?: boolean;
  network?: boolean;
  allowSubprocesses?: boolean;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly capabilities?: CommandCapabilities;
  readonly throwOnRefusal?: boolean;
  readonly stdin?: string;
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  blocked: boolean; // the backend denied or killed the command
  backend: string;
}

export interface CommandExecutor {
  readonly backend: string; // "plain" | "node-permission" | "mxc" | "bwrap"
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  canGrant?(
    capabilities?: CommandCapabilities,
    options?: { cwd?: string }
  ): { granted: boolean; reason?: string };
}

export * from "./plain.js";
export * from "./node-permission.js";
export * from "./mxc.js";
export * from "./bwrap.js";
export * from "./resolve.js";
