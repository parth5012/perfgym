import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { CommandCapabilities, CommandExecutor, ExecOptions, ExecResult } from "./index.js";
import { CapabilityRefusedError, PlainExecutor } from "./plain.js";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024; // 2MB
const TRUNCATION_MARKER = "\n[truncated]";
const FORCE_SETTLE_TIMEOUT_MS = 500;

export type ProbeCheckRunner = (binary: string, args: string[]) => boolean;

export function defaultProbeCheckRunner(binary: string, args: string[]): boolean {
  try {
    const res = spawnSync(binary, args, { stdio: "ignore", timeout: 3000 });
    return res.status === 0;
  } catch {
    return false;
  }
}

export function probeBwrap(
  runner: ProbeCheckRunner = defaultProbeCheckRunner,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== "linux") return false;
  return runner("bwrap", ["--version"]);
}

export function buildBwrapArgs(
  command: string,
  capabilities?: CommandCapabilities,
  cwd?: string
): string[] {
  const args: string[] = [
    "--ro-bind", "/", "/",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
  ];

  const needsNet = capabilities?.needsNetwork ?? capabilities?.network ?? false;
  if (!needsNet) {
    args.push("--unshare-net");
  }

  if (cwd) {
    args.push("--chdir", cwd);
  }

  if (capabilities?.writePaths && capabilities.writePaths.length > 0) {
    for (const p of capabilities.writePaths) {
      args.push("--bind", p, p);
    }
  }

  if (capabilities?.readPaths && capabilities.readPaths.length > 0) {
    for (const p of capabilities.readPaths) {
      if (p.startsWith("/tmp") && (!capabilities.writePaths || !capabilities.writePaths.includes(p))) {
        args.push("--ro-bind", p, p);
      }
    }
  }

  args.push("--die-with-parent");
  args.push("--", "/bin/sh", "-c", command);
  return args;
}

export type BwrapRunner = (
  binary: string,
  args: string[],
  options?: ExecOptions
) => Promise<ExecResult>;

export interface BwrapExecutorOptions {
  readonly allowedCapabilities?: CommandCapabilities;
  readonly fallback?: CommandExecutor;
  readonly bwrapBinary?: string;
  readonly isAvailable?: () => boolean;
  readonly runner?: BwrapRunner;
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
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

const BWRAP_BLOCK_PATTERN = /bwrap: (?:setting up uid map|Can't (?:mount|bind|make)|Operation not permitted|Permission denied|seccomp)/i;

export class BwrapExecutor implements CommandExecutor {
  readonly backend = "bwrap";
  private readonly fallback: CommandExecutor;
  private readonly allowedCapabilities?: CommandCapabilities;
  private readonly bwrapBinary: string;
  private readonly availabilityChecker: () => boolean;
  private readonly customRunner?: BwrapRunner;

  constructor(options?: BwrapExecutorOptions) {
    this.allowedCapabilities = options?.allowedCapabilities;
    this.bwrapBinary = options?.bwrapBinary ?? "bwrap";
    this.availabilityChecker = options?.isAvailable ?? (() => probeBwrap());
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
      const check = this.canGrant(effectiveCapabilities, { cwd: options?.cwd });
      if (!check.granted) {
        const reason = check.reason ?? "Requested capabilities cannot be granted by backend 'bwrap'";
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
      const bwrapArgs = buildBwrapArgs(command, effectiveCapabilities, options?.cwd);
      return this.customRunner(this.bwrapBinary, bwrapArgs, options);
    }

    const start = Date.now();
    const timeoutMs = options?.timeoutMs ?? 30000;
    const bwrapArgs = buildBwrapArgs(command, effectiveCapabilities, options?.cwd);

    return new Promise<ExecResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");

      const safeResolve = (res: ExecResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(res);
      };

      const child = spawn(this.bwrapBinary, bwrapArgs, {
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        detached: true,
        stdio: [options?.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });

      if (options?.stdin !== undefined) {
        child.stdin?.on("error", () => {});
        child.stdin?.write(options.stdin);
        child.stdin?.end();
      }

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killProcessGroup(child.pid);
          child.stdout?.destroy();
          child.stderr?.destroy();
          setTimeout(() => {
            safeResolve({
              code: null,
              stdout,
              stderr,
              durationMs: Date.now() - start,
              timedOut: true,
              blocked: false,
              backend: this.backend,
            });
          }, FORCE_SETTLE_TIMEOUT_MS).unref();
        }, timeoutMs);
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdoutTruncated) return;
        const remaining = MAX_CAPTURE_BYTES - stdoutBytes;
        if (chunk.length <= remaining) {
          stdout += stdoutDecoder.write(chunk);
          stdoutBytes += chunk.length;
        } else {
          stdout += stdoutDecoder.write(chunk.subarray(0, remaining)) + stdoutDecoder.end() + TRUNCATION_MARKER;
          stdoutBytes = MAX_CAPTURE_BYTES;
          stdoutTruncated = true;
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderrTruncated) return;
        const remaining = MAX_CAPTURE_BYTES - stderrBytes;
        if (chunk.length <= remaining) {
          stderr += stderrDecoder.write(chunk);
          stderrBytes += chunk.length;
        } else {
          stderr += stderrDecoder.write(chunk.subarray(0, remaining)) + stderrDecoder.end() + TRUNCATION_MARKER;
          stderrBytes = MAX_CAPTURE_BYTES;
          stderrTruncated = true;
        }
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
        if (!stdoutTruncated) {
          stdout += stdoutDecoder.end();
        }
        if (!stderrTruncated) {
          stderr += stderrDecoder.end();
        }
        const blocked = code !== 0 && BWRAP_BLOCK_PATTERN.test(stderr);
        safeResolve({
          code: timedOut ? null : code,
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
