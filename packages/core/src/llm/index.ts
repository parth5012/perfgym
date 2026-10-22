import { UnknownDriverError } from "../errors.js";
import type { DriverOptions, LlmDriver } from "./driver.js";
import { VercelAiSdkDriver } from "./vercel-driver.js";

export * from "./schema.js";
export * from "./driver.js";
export * from "./prompt-builder.js";
export * from "./usage.js";
export * from "./vercel-driver.js";

export type DriverFactory = (options?: DriverOptions) => LlmDriver;

const DRIVER_REGISTRY: Map<string, DriverFactory> = new Map();

// Register built-in drivers
DRIVER_REGISTRY.set("api", (opts) => new VercelAiSdkDriver(opts));
DRIVER_REGISTRY.set("vercel", (opts) => new VercelAiSdkDriver(opts));

export function registerDriver(name: string, factory: DriverFactory): void {
  DRIVER_REGISTRY.set(name.toLowerCase(), factory);
}

export function createDriver(name: string, options?: DriverOptions): LlmDriver {
  const normalized = name.toLowerCase();
  const factory = DRIVER_REGISTRY.get(normalized);
  if (!factory) {
    throw new UnknownDriverError({
      driverName: name,
      message: `Unknown LLM driver '${name}'. Available drivers: ${Array.from(DRIVER_REGISTRY.keys()).join(", ") || "none"}`,
    });
  }
  return factory(options);
}
