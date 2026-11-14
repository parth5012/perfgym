import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface MobilePlatformProfile {
  name: string;
  targetGlobs: string[];
  defaultInvariantCommand: string;
  defaultMetricCommands: Array<{ name: string; command: string; goal: "minimize" | "maximize"; weight: number; unit: "count" | "bytes" | "ms" }>;
  rulePresets: string[];
}

export function detectMobileProfile(root: string): MobilePlatformProfile {
  const hasGradle = existsSync(join(root, "build.gradle")) || existsSync(join(root, "build.gradle.kts"));
  return {
    name: hasGradle ? "android-mobile" : "unknown-mobile",
    targetGlobs: ["app/src/main/**/*.kt", "app/src/main/**/*.java"],
    defaultInvariantCommand: "./gradlew test",
    defaultMetricCommands: [
      { name: "recomposition_count", command: "./gradlew benchmark", goal: "minimize", weight: 0.4, unit: "count" },
      { name: "dex_size_bytes", command: "./gradlew assembleRelease", goal: "minimize", weight: 0.6, unit: "bytes" },
    ],
    rulePresets: ["no-unstable-compose-state"],
  };
}
