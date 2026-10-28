import { spawn, spawnSync } from "node:child_process";
import type { CommandCapabilities, CommandExecutor, ExecOptions, ExecResult } from "./index.js";
import { CapabilityRefusedError, PlainExecutor } from "./plain.js";
import type { ProbeCheckRunner } from "./bwrap.js";
import { defaultProbeCheckRunner } from "./bwrap.js";

export function probeMxc(
  runner: ProbeCheckRunner = defaultProbeCheckRunner,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== "win32") return false;
  return runner("wxc-exec", ["--version"]);
}

function sanitizeMxcPath(p: string): string {
  if (/[\r\n\0]/.test(p)) {
    throw new Error(`Capability path contains prohibited control characters: ${JSON.stringify(p)}`);
  }
  return p.includes(" ") ? `"${p.replace(/"/g, '\\"')}"` : p;
}

export function buildMxcArgs(
  command: string,
  capabilities?: CommandCapabilities
): string[] {
  const args: string[] = ["--tier=BaseContainer"];

  if (!capabilities?.needsNetwork) {
    args.push("--isolate-network");
  }

  if (capabilities?.writePaths && capabilities.writePaths.length > 0) {
    for (const p of capabilities.writePaths) {
      args.push(`--allow-write=${sanitizeMxcPath(p)}`);
    }
  }

  args.push("--", "cmd.exe", "/c", command);
  return args;
}

export type MxcRunner = (
  binary: string,
  args: string[],
  options?: ExecOptions
) => Promise<ExecResult>;

export interface MxcExecutorOptions {
  readonly allowedCapabilities?: CommandCapabilities;
  readonly fallback?: CommandExecutor;
  readonly wxcBinary?: string;
  readonly isAvailable?: () => boolean;
  readonly runner?: MxcRunner;
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to direct kill
    }
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignored
    }
  }
}

const MXC_BLOCK_PATTERN = /wxc-exec: (?:Access is denied|Permission denied|Container policy denied|Isolation violation)/i;

export class MxcExecutor implements CommandExecutor {
  readonly backend = "mxc";
  private readonly fallback: CommandExecutor;
  private readonly allowedCapabilities?: CommandCapabilities;
  private readonly wxcBinary: string;
  private readonly availabilityChecker: () => boolean;
  private readonly customRunner?: MxcRunner;

  constructor(options?: MxcExecutorOptions) {
    this.allowedCapabilities = options?.allowedCapabilities;
    this.wxcBinary = options?.wxcBinary ?? "wxc-exec";
    this.availabilityChecker = options?.isAvailable ?? (() => probeMxc());
    this.fallback = options?.fallback ?? new PlainExecutor({ allowedCapabilities: options?.allowedCapabilities });
    this.customRunner = options?.runner;
  }

  isAvailable(): boolean {
    return this.availabilityChecker();
  }

  canGrant(
    capabilities?: CommandCapabilities,
    options?: { cwd?: string }
  ): { granted: boolean; reason?: string } {
    if (!this.isAvailable()) {
      if (!this.fallback.canGrant) return { granted: true };
      const res = this.fallback.canGrant(capabilities, options);
      if (!res.granted && res.reason) {
        return {
          granted: false,
          reason: res.reason.replace(/Backend 'plain'/g, `Backend '${this.backend}'`),
        };
      }
      return res;
    }
    if (this.fallback.canGrant) {
      const res = this.fallback.canGrant(capabilities, options);
      if (!res.granted && res.reason) {
        return {
          granted: false,
          reason: res.reason.replace(/Backend 'plain'/g, `Backend '${this.backend}'`),
        };
      }
      return res;
    }
    return { granted: true };
  }

  validateCapabilities(capabilities?: CommandCapabilities, options?: { cwd?: string }): void {
    const check = this.canGrant(capabilities, options);
    if (!check.granted) {
      throw new CapabilityRefusedError(
        check.reason ?? "Command requested capability that cannot be granted",
        "capabilities"
      );
    }
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    // When backend binary is unavailable, fall back to plain runner (honest reporting)
    if (!this.isAvailable()) {
      return this.fallback.exec(command, options);
    }

    const effectiveCapabilities = options?.capabilities ?? this.allowedCapabilities;

    // Check capability grants
    if (this.allowedCapabilities || options?.capabilities) {
      const check = this.canGrant(options?.capabilities, { cwd: options?.cwd });
      if (!check.granted) {
        const reason = check.reason ?? "Requested capabilities cannot be granted by backend 'mxc'";
        if (options?.throwOnRefusal) {
          throw new CapabilityRefusedError(reason, "capabilities");
        }
        return {
          code: null,
          stdout: "",
          stderr: `Capability refused before execution: ${reason}`,
          durationMs: 0,
          timedOut: false,
          blocked: true,
          backend: this.backend,
        };
      }
    }

    // Custom runner hook for testing without host binaries
    if (this.customRunner) {
      const mxcArgs = buildMxcArgs(command, effectiveCapabilities);
      return this.customRunner(this.wxcBinary, mxcArgs, options);
    }

    const start = Date.now();
    const timeoutMs = options?.timeoutMs ?? 30000;
    const mxcArgs = buildMxcArgs(command, effectiveCapabilities);

    return new Promise<ExecResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      const safeResolve = (res: ExecResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(res);
      };

      const child = spawn(this.wxcBinary, mxcArgs, {
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killProcessGroup(child.pid);
        }, timeoutMs);
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (err: Error) => {
        safeResolve({
          code: null,
          stdout,
          stderr: stderr || err.message,
          durationMs: Date.now() - start,
          timedOut: false,
          blocked: true,
          backend: this.backend,
        });
      });

      child.on("close", (code) => {
        const blocked = code !== 0 && MXC_BLOCK_PATTERN.test(stderr);
        safeResolve({
          code,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut,
          blocked,
          backend: this.backend,
        });
      });
    });
  }
}
