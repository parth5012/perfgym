import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectWebProfile } from "./profile.js";

describe("detectWebProfile", () => {
  it("detects vite profile and test script", () => {
    const root = mkdtempSync(join(tmpdir(), "web-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", build: "vite build" }, devDependencies: { vite: "^5" } }));
    const profile = detectWebProfile(root);
    expect(profile.name).toBe("vite-web");
    expect(profile.defaultInvariantCommand).toBe("npm test");
    expect(profile.rulePresets).toContain("no-await-in-loops");
  });

  it("detects next profile globs", () => {
    const root = mkdtempSync(join(tmpdir(), "web-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { next: "14" } }));
    mkdirSync(join(root, "app"), { recursive: true });
    const profile = detectWebProfile(root);
    expect(profile.name).toBe("next-web");
    expect(profile.targetGlobs).toContain("app/**/*.{ts,tsx,js,jsx}");
  });
});