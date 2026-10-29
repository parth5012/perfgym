import { spawn, spawnSync } from "node:child_process";
import { resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { CommandCapabilities, CommandExecutor, ExecOptions, ExecResult } from "./index.js";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024; // 2MB
const TRUNCATION_MARKER = "\n[truncated]";
const FORCE_SETTLE_TIMEOUT_MS = 500;

export class CapabilityRefusedError extends Error {
  readonly _tag = "CapabilityRefusedError";
  readonly code = "ERR_CAPABILITY_REFUSED";
  readonly capability: string;
  constructor(message: string, capability: string) {
    super(message);
    this.name = "CapabilityRefusedError";
    this.capability = capability;
  }
}

export interface PlainExecutorOptions {
  readonly allowedCapabilities?: CommandCapabilities;
}

function isPathAllowed(targetPath: string, allowedPaths: readonly string[], baseDir?: string): boolean {
  const resolvedTarget = resolve(baseDir ?? process.cwd(), targetPath);
  for (const allowed of allowedPaths) {
    if (allowed === "*") return true;
    const resolvedAllowed = resolve(baseDir ?? process.cwd(), allowed);
    if (resolvedTarget === resolvedAllowed) return true;
    const prefix = resolvedAllowed.endsWith(sep) ? resolvedAllowed : resolvedAllowed + sep;
    if (resolvedTarget.startsWith(prefix)) return true;
  }
  return false;
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already gone or unsupported
    }
  }
}

export class PlainExecutor implements CommandExecutor {
  readonly backend: string = "plain";
  private readonly allowedCapabilities?: CommandCapabilities;

  constructor(options?: PlainExecutorOptions) {
    this.allowedCapabilities = options?.allowedCapabilities;
  }

  canGrant(
    capabilities?: CommandCapabilities,
    options?: { cwd?: string }
  ): { granted: boolean; reason?: string } {
    if (!capabilities || !this.allowedCapabilities) {
      return { granted: true };
    }

    const needsNetwork = capabilities.needsNetwork ?? capabilities.network;
    const allowedNetwork = this.allowedCapabilities.needsNetwork ?? this.allowedCapabilities.network;
    if (needsNetwork === true && allowedNetwork !== true) {
      return {
        granted: false,
        reason: "Backend 'plain' policy denies network access (needsNetwork not granted)",
      };
    }

    const needsChildProcess = capabilities.needsChildProcess ?? capabilities.allowSubprocesses;
    const allowedChildProcess = this.allowedCapabilities.needsChildProcess ?? this.allowedCapabilities.allowSubprocesses;
    if (needsChildProcess === true && allowedChildProcess !== true) {
      return {
        granted: false,
        reason: "Backend 'plain' policy denies child process execution (needsChildProcess not granted)",
      };
    }

    if (capabilities.writePaths && capabilities.writePaths.length > 0) {
      if (!this.allowedCapabilities.writePaths) {
        return {
          granted: false,
          reason: "Backend 'plain' policy denies write operations (no writePaths allowed)",
        };
      }
      for (const p of capabilities.writePaths) {
        if (!isPathAllowed(p, this.allowedCapabilities.writePaths, options?.cwd)) {
          return {
            granted: false,
            reason: `Backend 'plain' policy denies write to "${p}"`,
          };
        }
      }
    }

    if (capabilities.readPaths && capabilities.readPaths.length > 0) {
      if (!this.allowedCapabilities.readPaths) {
        return {
          granted: false,
          reason: "Backend 'plain' policy denies read operations (no readPaths allowed)",
        };
      }
      for (const p of capabilities.readPaths) {
        if (!isPathAllowed(p, this.allowedCapabilities.readPaths, options?.cwd)) {
          return {
            granted: false,
            reason: `Backend 'plain' policy denies read from "${p}"`,
          };
        }
      }
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
    const startedAt = Date.now();

    if (this.allowedCapabilities || options?.capabilities) {
      const check = this.canGrant(options?.capabilities, { cwd: options?.cwd });
      if (!check.granted) {
        const reason = check.reason ?? "Requested capabilities cannot be granted by backend 'plain'";
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

    return new Promise<ExecResult>((resolvePromise) => {
      let stdout = "";
      let stderr = "";
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      let settled = false;
      let timedOut = false;
      let forceSettleTimer: NodeJS.Timeout | undefined;
      let deadline: NodeJS.Timeout | undefined;

      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");

      const child = spawn(command, {
        shell: true,
        detached: true,
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        stdio: [options?.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      });

      if (options?.stdin !== undefined) {
        child.stdin?.on("error", () => {});
        child.stdin?.write(options.stdin);
        child.stdin?.end();
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

      const settle = (res: ExecResult): void => {
        if (settled) return;
        settled = true;
        if (deadline !== undefined) {
          clearTimeout(deadline);
        }
        if (forceSettleTimer !== undefined) {
          clearTimeout(forceSettleTimer);
        }
        resolvePromise(res);
      };

      if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
        deadline = setTimeout(() => {
          timedOut = true;
          killProcessGroup(child.pid);

          child.stdout?.destroy();
          child.stderr?.destroy();

          forceSettleTimer = setTimeout(() => {
            settle({
              code: null,
              stdout,
              stderr,
              durationMs: Date.now() - startedAt,
              timedOut: true,
              blocked: false,
              backend: this.backend,
            });
          }, FORCE_SETTLE_TIMEOUT_MS);
          forceSettleTimer.unref();
        }, options.timeoutMs);
      }

      child.on("error", (err: Error) => {
        settle({
          code: null,
          stdout,
          stderr: stderr ? `${stderr}\n${err.message}` : err.message,
          durationMs: Date.now() - startedAt,
          timedOut,
          blocked: false,
          backend: this.backend,
        });
      });

      child.on("close", (code: number | null) => {
        if (!stdoutTruncated) {
          stdout += stdoutDecoder.end();
        }
        if (!stderrTruncated) {
          stderr += stderrDecoder.end();
        }
        settle({
          code: timedOut ? null : code,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
          blocked: false,
          backend: this.backend,
        });
      });
    });
  }
}
