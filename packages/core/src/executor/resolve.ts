import type { CommandCapabilities, CommandExecutor } from "./index.js";
import { PlainExecutor } from "./plain.js";
import { NodePermissionExecutor, probeNodePermission } from "./node-permission.js";

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
  // Until MxcExecutor is implemented in Ticket #57, default probe returns false
  // so unimplemented stubs are not prematurely selected in auto mode.
  return false;
}

export function defaultProbeBwrap(): boolean {
  // Until BwrapExecutor is implemented in Ticket #57, default probe returns false
  // so unimplemented stubs are not prematurely selected in auto mode.
  return false;
}

export class MxcStubExecutor extends PlainExecutor {
  override readonly backend = "mxc";
}

export class BwrapStubExecutor extends PlainExecutor {
  override readonly backend = "bwrap";
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
  const makeMxc = () => factories?.createMxc?.() ?? new MxcStubExecutor({ allowedCapabilities: allowed });
  const makeBwrap = () => factories?.createBwrap?.() ?? new BwrapStubExecutor({ allowedCapabilities: allowed });

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
