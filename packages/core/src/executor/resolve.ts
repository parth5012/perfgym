import type { CommandCapabilities, CommandExecutor } from "./index.js";
import { PlainExecutor } from "./plain.js";
import { NodePermissionExecutor, probeNodePermission } from "./node-permission.js";
import { MxcExecutor, probeMxc as probeMxcBackend } from "./mxc.js";
import { BwrapExecutor, probeBwrap as probeBwrapBackend } from "./bwrap.js";

export type CommandBackendName =
  | "auto"
  | "node-permission"
  | "mxc"
  | "bwrap"
  | "none"
  | "plain";

export interface ProbeFunctions {
  probeMxc?: () => boolean;
  probeBwrap?: () => boolean;
  probeNodePermission?: () => boolean;
}

export function defaultProbeMxc(): boolean {
  return probeMxcBackend();
}

export function defaultProbeBwrap(): boolean {
  return probeBwrapBackend();
}

export interface ResolveExecutorOptions {
  readonly backend?: CommandBackendName;
  readonly probes?: ProbeFunctions;
  readonly allowedCapabilities?: CommandCapabilities;
  readonly factories?: {
    readonly createMxc?: () => CommandExecutor;
    readonly createBwrap?: () => CommandExecutor;
    readonly createNodePermission?: () => CommandExecutor;
    readonly createPlain?: () => CommandExecutor;
  };
}

export function resolveCommandExecutor(options?: ResolveExecutorOptions): CommandExecutor {
  const requestedBackend = options?.backend ?? "auto";
  const probes = options?.probes;
  const allowed = options?.allowedCapabilities;
  const factories = options?.factories;

  const probeMxc = probes?.probeMxc ?? defaultProbeMxc;
  const probeBwrap = probes?.probeBwrap ?? defaultProbeBwrap;
  const probeNode = probes?.probeNodePermission ?? probeNodePermission;

  const makePlain = () => factories?.createPlain?.() ?? new PlainExecutor({ allowedCapabilities: allowed });
  const makeNodePerm = () => factories?.createNodePermission?.() ?? new NodePermissionExecutor({ allowedCapabilities: allowed });
  const makeMxc = () => factories?.createMxc?.() ?? new MxcExecutor({ allowedCapabilities: allowed });
  const makeBwrap = () => factories?.createBwrap?.() ?? new BwrapExecutor({ allowedCapabilities: allowed });

  if (requestedBackend === "none" || requestedBackend === "plain") {
    return makePlain();
  }

  if (requestedBackend === "mxc") {
    if (probeMxc()) {
      return makeMxc();
    }
    return makePlain();
  }

  if (requestedBackend === "bwrap") {
    if (probeBwrap()) {
      return makeBwrap();
    }
    return makePlain();
  }

  if (requestedBackend === "node-permission") {
    if (probeNode()) {
      return makeNodePerm();
    }
    return makePlain();
  }

  // "auto" resolution order: mxc -> bwrap -> node-permission -> plain
  if (probeMxc()) {
    return makeMxc();
  }

  if (probeBwrap()) {
    return makeBwrap();
  }

  if (probeNode()) {
    return makeNodePerm();
  }

  return makePlain();
}
