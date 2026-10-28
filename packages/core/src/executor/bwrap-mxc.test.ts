import { describe, it, expect, vi } from "vitest";
import {
  BwrapExecutor,
  probeBwrap,
  buildBwrapArgs,
} from "./bwrap.js";
import {
  MxcExecutor,
  probeMxc,
  buildMxcArgs,
} from "./mxc.js";
import { resolveCommandExecutor } from "./resolve.js";

describe("MxcExecutor & BwrapExecutor (Capability-Probed)", () => {
  describe("AC1: probe functions for binary present and binary absent branches", () => {
    it("probes probeBwrap on linux when present and absent", () => {
      const mockPresentRunner = vi.fn().mockReturnValue(true);
      const mockAbsentRunner = vi.fn().mockReturnValue(false);

      // Binary present on Linux
      expect(probeBwrap(mockPresentRunner, "linux")).toBe(true);
      expect(mockPresentRunner).toHaveBeenCalledWith("bwrap", ["--version"]);

      // Binary absent on Linux
      expect(probeBwrap(mockAbsentRunner, "linux")).toBe(false);

      // Non-Linux platform always returns false without calling runner
      const uncalledRunner = vi.fn();
      expect(probeBwrap(uncalledRunner, "darwin")).toBe(false);
      expect(probeBwrap(uncalledRunner, "win32")).toBe(false);
      expect(uncalledRunner).not.toHaveBeenCalled();
    });

    it("probes probeMxc on win32 when present and absent", () => {
      const mockPresentRunner = vi.fn().mockReturnValue(true);
      const mockAbsentRunner = vi.fn().mockReturnValue(false);

      // Binary present on Windows
      expect(probeMxc(mockPresentRunner, "win32")).toBe(true);
      expect(mockPresentRunner).toHaveBeenCalledWith("wxc-exec", ["--version"]);

      // Binary absent on Windows
      expect(probeMxc(mockAbsentRunner, "win32")).toBe(false);

      // Non-Windows platform always returns false without calling runner
      const uncalledRunner = vi.fn();
      expect(probeMxc(uncalledRunner, "linux")).toBe(false);
      expect(probeMxc(uncalledRunner, "darwin")).toBe(false);
      expect(uncalledRunner).not.toHaveBeenCalled();
    });
  });

  describe("AC4: adapters declare themselves unavailable without throwing when binary is missing", () => {
    it("MxcExecutor reports unavailable and gracefully falls back to plain on exec without throwing", async () => {
      const executor = new MxcExecutor({
        isAvailable: () => false,
      });

      expect(executor.backend).toBe("mxc");
      expect(executor.isAvailable()).toBe(false);

      // Executing on an unavailable adapter must NOT throw; it falls back to plain runner
      const result = await executor.exec("echo fallback-mxc");
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("fallback-mxc");
      expect(result.backend).toBe("plain");
    });

    it("BwrapExecutor reports unavailable and gracefully falls back to plain on exec without throwing", async () => {
      const executor = new BwrapExecutor({
        isAvailable: () => false,
      });

      expect(executor.backend).toBe("bwrap");
      expect(executor.isAvailable()).toBe(false);

      // Executing on an unavailable adapter must NOT throw; it falls back to plain runner
      const result = await executor.exec("echo fallback-bwrap");
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("fallback-bwrap");
      expect(result.backend).toBe("plain");
    });
  });

  describe("AC2: unavailable backends are skipped during auto resolution", () => {
    it("skips unavailable mxc and bwrap and selects node-permission or plain", () => {
      const resolved = resolveCommandExecutor({
        backend: "auto",
        probes: {
          probeMxc: () => false,
          probeBwrap: () => false,
          probeNodePermission: () => true,
        },
      });

      expect(resolved.backend).toBe("node-permission");
    });

    it("falls through all the way to plain when all backends are unavailable", () => {
      const resolved = resolveCommandExecutor({
        backend: "auto",
        probes: {
          probeMxc: () => false,
          probeBwrap: () => false,
          probeNodePermission: () => false,
        },
      });

      expect(resolved.backend).toBe("plain");
    });

    it("selects bwrap when bwrap probe is true and mxc probe is false", () => {
      const resolved = resolveCommandExecutor({
        backend: "auto",
        probes: {
          probeMxc: () => false,
          probeBwrap: () => true,
          probeNodePermission: () => true,
        },
      });

      expect(resolved.backend).toBe("bwrap");
    });

    it("selects mxc when mxc probe is true", () => {
      const resolved = resolveCommandExecutor({
        backend: "auto",
        probes: {
          probeMxc: () => true,
          probeBwrap: () => true,
          probeNodePermission: () => true,
        },
      });

      expect(resolved.backend).toBe("mxc");
    });
  });

  describe("Command argument mapping", () => {
    it("buildBwrapArgs maps capabilities onto bwrap arguments correctly", () => {
      const args = buildBwrapArgs("npm test", {
        writePaths: ["/tmp/build", "/workspace/target"],
        needsNetwork: false,
      }, "/workspace");

      expect(args).toContain("--ro-bind");
      expect(args).toContain("--unshare-net");
      expect(args).toContain("--chdir");
      expect(args).toContain("/workspace");
      expect(args).toContain("--bind");
      expect(args).toContain("/tmp/build");
      expect(args).toContain("/workspace/target");
      expect(args).toContain("--die-with-parent");
      expect(args.slice(-4)).toEqual(["--", "/bin/sh", "-c", "npm test"]);
    });

    it("buildBwrapArgs allows network when needsNetwork is true", () => {
      const args = buildBwrapArgs("curl http://localhost", {
        needsNetwork: true,
      });

      expect(args).not.toContain("--unshare-net");
    });

    it("buildMxcArgs maps capabilities onto wxc-exec arguments correctly", () => {
      const args = buildMxcArgs("test.exe", {
        writePaths: ["C:\\temp\\out"],
        needsNetwork: false,
      });

      expect(args).toContain("--tier=BaseContainer");
      expect(args).toContain("--isolate-network");
      expect(args).toContain("--allow-write=C:\\temp\\out");
      expect(args.slice(-4)).toEqual(["--", "cmd.exe", "/c", "test.exe"]);
    });
  });

  describe("AC3: execution with simulated runner without requiring installed binaries", () => {
    it("executes through BwrapExecutor with custom runner when available", async () => {
      const mockRunner = vi.fn().mockResolvedValue({
        code: 0,
        stdout: "bwrap ok",
        stderr: "",
        durationMs: 12,
        timedOut: false,
        blocked: false,
        backend: "bwrap",
      });

      const executor = new BwrapExecutor({
        isAvailable: () => true,
        runner: mockRunner,
      });

      const result = await executor.exec("echo test", {
        capabilities: { writePaths: ["/tmp/out"], needsNetwork: false },
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("bwrap ok");
      expect(result.backend).toBe("bwrap");
      expect(mockRunner).toHaveBeenCalled();
    });

    it("executes through MxcExecutor with custom runner when available", async () => {
      const mockRunner = vi.fn().mockResolvedValue({
        code: 0,
        stdout: "mxc ok",
        stderr: "",
        durationMs: 15,
        timedOut: false,
        blocked: false,
        backend: "mxc",
      });

      const executor = new MxcExecutor({
        isAvailable: () => true,
        runner: mockRunner,
      });

      const result = await executor.exec("dir", {
        capabilities: { writePaths: ["C:\\temp"] },
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toBe("mxc ok");
      expect(result.backend).toBe("mxc");
      expect(mockRunner).toHaveBeenCalled();
    });
  });
});
