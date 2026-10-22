import { UnknownDriverError } from "../errors.js";
import type { DriverOptions, LlmDriver } from "./driver.js";

export * from "./schema.js";
export * from "./driver.js";
export * from "./prompt-builder.js";

export type DriverFactory = (options?: DriverOptions) => LlmDriver;

const DRIVER_REGISTRY: Map<string, DriverFactory> = new Map();

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
