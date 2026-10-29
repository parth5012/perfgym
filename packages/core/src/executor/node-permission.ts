import { spawnSync } from "node:child_process";
import type { CommandCapabilities, CommandExecutor, ExecOptions, ExecResult } from "./index.js";
import { CapabilityRefusedError, PlainExecutor } from "./plain.js";

function hasShellMeta(command: string): boolean {
  // Strip single-quoted and double-quoted strings before checking for shell metacharacters
  const withoutStrings = command.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
  // Detect chaining (&, |, ;, \n), redirection (>, <), and command substitutions (`, $()
  return /[&|;\n><`]|\$\(/.test(withoutStrings);
}

export function parseCommandBinary(command: string): { binary: string; rest: string; rawToken: string } | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('"')) {
    const closing = trimmed.indexOf('"', 1);
    if (closing !== -1) {
      return {
        binary: trimmed.slice(1, closing),
        rest: trimmed.slice(closing + 1),
        rawToken: trimmed.slice(0, closing + 1),
      };
    }
  } else if (trimmed.startsWith("'")) {
    const closing = trimmed.indexOf("'", 1);
    if (closing !== -1) {
      return {
        binary: trimmed.slice(1, closing),
        rest: trimmed.slice(closing + 1),
        rawToken: trimmed.slice(0, closing + 1),
      };
    }
  }

  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return { binary: trimmed, rest: "", rawToken: trimmed };
  }
  return {
    binary: trimmed.slice(0, firstSpace),
    rest: trimmed.slice(firstSpace),
    rawToken: trimmed.slice(0, firstSpace),
  };
}

export function isNodeCommand(command: string): boolean {
  const parsed = parseCommandBinary(command);
  if (!parsed) return false;
  const basename = parsed.binary.split("/").pop()?.split("\\").pop()?.toLowerCase();
  return basename === "node" || basename === "node.exe";
}

export function probeNodePermission(): boolean {
  try {
    const nodeBin = process.execPath || "node";
    const res = spawnSync(nodeBin, ["--permission", "-e", "process.exit(0)"], {
      stdio: "ignore",
      timeout: 3000,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

function sanitizeShellPath(p: string): string {
  // Reject newlines, carriage returns, and null bytes that could break shell arguments or inject commands
  if (/[\r\n\0]/.test(p)) {
    throw new Error(`Capability path contains prohibited control characters: ${JSON.stringify(p)}`);
  }
  // Escape backslashes, double quotes, dollar signs, percent signs, and backticks for double-quoted shell arguments
  return p.replace(/(["\\$`%])/g, "\\$1");
}

export function wrapWithNodePermission(
  command: string,
  capabilities?: CommandCapabilities
): string {
  const parsed = parseCommandBinary(command);
  if (!parsed) return command;

  const flags: string[] = ["--permission"];

  if (capabilities?.readPaths !== undefined) {
    for (const p of capabilities.readPaths) {
      flags.push(`--allow-fs-read="${sanitizeShellPath(p)}"`);
    }
  } else {
    flags.push('--allow-fs-read="*"');
  }

  if (capabilities?.writePaths && capabilities.writePaths.length > 0) {
    for (const p of capabilities.writePaths) {
      flags.push(`--allow-fs-write="${sanitizeShellPath(p)}"`);
    }
  }

  if (capabilities?.needsChildProcess === true || capabilities?.allowSubprocesses === true) {
    flags.push("--allow-child-process");
  }

  const restPart = parsed.rest.length > 0 && !parsed.rest.startsWith(" ") ? ` ${parsed.rest}` : parsed.rest;
  return `${parsed.rawToken} ${flags.join(" ")}${restPart}`;
}

export interface NodePermissionExecutorOptions {
  readonly allowedCapabilities?: CommandCapabilities;
  readonly fallback?: CommandExecutor;
}

const ACCESS_DENIED_PATTERN = /ERR_ACCESS_DENIED|Access to this API has been restricted|permission:\s*['"]?(?:FileSystemWrite|FileSystemRead|ChildProcess)/;

export class NodePermissionExecutor implements CommandExecutor {
  readonly backend = "node-permission";
  private readonly fallback: CommandExecutor;
  private readonly allowedCapabilities?: CommandCapabilities;

  constructor(options?: NodePermissionExecutorOptions) {
    this.allowedCapabilities = options?.allowedCapabilities;
    this.fallback = options?.fallback ?? new PlainExecutor({ allowedCapabilities: options?.allowedCapabilities });
  }

  canGrant(
    capabilities?: CommandCapabilities,
    options?: { cwd?: string }
  ): { granted: boolean; reason?: string } {
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
    // Non-Node commands cannot be confined by Node's permission model -> fall back to plain
    if (!isNodeCommand(command)) {
      return this.fallback.exec(command, options);
    }

    // Compound shell commands, redirections, or substitutions cannot be confined safely by wrapping node only -> fall back to plain
    if (hasShellMeta(command)) {
      return this.fallback.exec(command, options);
    }

    const effectiveCapabilities = options?.capabilities ?? this.allowedCapabilities;

    // Pre-check capabilities if configured
    if (this.allowedCapabilities || options?.capabilities) {
      const check = this.canGrant(effectiveCapabilities, { cwd: options?.cwd });
      if (!check.granted) {
        const reason = check.reason ?? "Requested capabilities cannot be granted by backend 'node-permission'";
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

    const wrappedCommand = wrapWithNodePermission(command, effectiveCapabilities);
    // Execute through fallback (plain runner) without capability check since we already checked
    const result = await this.fallback.exec(wrappedCommand, {
      ...options,
      capabilities: undefined,
    });

    const isAccessDenied = result.code !== 0 && ACCESS_DENIED_PATTERN.test(result.stderr);

    return {
      ...result,
      blocked: result.blocked || isAccessDenied,
      backend: this.backend,
    };
  }
}
