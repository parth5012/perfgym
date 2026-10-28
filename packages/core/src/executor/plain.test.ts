import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlainExecutor, CapabilityRefusedError } from "./plain.js";
import type { CommandCapabilities, CommandExecutor, ExecResult } from "./index.js";

describe("PlainExecutor", () => {
  it("implements CommandExecutor interface with backend 'plain'", () => {
    const executor: CommandExecutor = new PlainExecutor();
    expect(executor.backend).toBe("plain");
  });

  it("executes a successful command and captures stdout and code 0", async () => {
    const executor = new PlainExecutor();
    const result: ExecResult = await executor.exec("node -e \"console.log('hello plain')\"");

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello plain");
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.backend).toBe("plain");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures non-zero exit code and stderr", async () => {
    const executor = new PlainExecutor();
    const result = await executor.exec("node -e \"console.error('error output'); process.exit(42)\"");

    expect(result.code).toBe(42);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("error output");
    expect(result.timedOut).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.backend).toBe("plain");
  });

  it("captures both stdout and stderr when command emits to both", async () => {
    const executor = new PlainExecutor();
    const result = await executor.exec("node -e \"console.log('out'); console.error('err')\"");

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("out");
    expect(result.stderr.trim()).toBe("err");
  });

  it("handles command timeout and flags timedOut", async () => {
    const executor = new PlainExecutor();
    const result = await executor.exec("node -e \"setTimeout(() => {}, 10000)\"", {
      timeoutMs: 200,
    });

    expect(result.timedOut).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(150);
  });

  it("kills the entire process tree on timeout", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "perfgym-plainkill-"));
    const pidFile = join(tempDir, "child.pid");

    try {
      const executor = new PlainExecutor();
      const result = await executor.exec(`sh -c '(sleep 25 & echo $! > "${pidFile}"; wait)'`, {
        timeoutMs: 300,
      });

      expect(result.timedOut).toBe(true);
      expect(existsSync(pidFile)).toBe(true);

      const rawPid = readFileSync(pidFile, "utf8").trim();
      const pid = Number.parseInt(rawPid, 10);
      expect(Number.isFinite(pid) && pid > 0).toBe(true);

      // Verify the child process was killed
      let stillAlive = true;
      for (let i = 0; i < 20; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((resolve) => setTimeout(resolve, 50));
        } catch {
          stillAlive = false;
          break;
        }
      }
      expect(stillAlive).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("asserts the refusal path when a capability cannot be granted", async () => {
    // PlainExecutor with policy disallowing network access
    const restrictedExecutor = new PlainExecutor({
      allowedCapabilities: {
        needsNetwork: false,
        writePaths: ["/tmp/allowed"],
      },
    });

    // 1. Refusal when command requests network
    const netResult = await restrictedExecutor.exec("node -e \"console.log('fetch')\"", {
      capabilities: { needsNetwork: true },
    });
    expect(netResult.blocked).toBe(true);
    expect(netResult.stderr).toContain("network");

    // 2. Refusal when command requests write to forbidden path
    const writeResult = await restrictedExecutor.exec("node -e \"console.log('write')\"", {
      capabilities: { writePaths: ["/etc/passwd"] },
    });
    expect(writeResult.blocked).toBe(true);
    expect(writeResult.stderr).toContain("/etc/passwd");

    // 3. canGrant returns false with reason
    const check = restrictedExecutor.canGrant({ needsNetwork: true });
    expect(check.granted).toBe(false);
    expect(check.reason).toBeDefined();

    // 4. validateCapabilities throws CapabilityRefusedError
    expect(() => restrictedExecutor.validateCapabilities({ needsNetwork: true })).toThrow(
      CapabilityRefusedError
    );

    // 5. throwOnRefusal rejects the returned promise
    await expect(
      restrictedExecutor.exec("node -e \"console.log('hi')\"", {
        capabilities: { needsNetwork: true },
        throwOnRefusal: true,
      })
    ).rejects.toThrow(CapabilityRefusedError);
  });

  it("resolves relative capability paths against options.cwd", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "perfgym-cwd-test-"));
    try {
      const executor = new PlainExecutor({
        allowedCapabilities: {
          writePaths: [tempDir],
        },
      });

      // Relative path "sub" inside tempDir should be allowed when cwd is tempDir
      const allowed = executor.canGrant({ writePaths: ["./sub"] }, { cwd: tempDir });
      expect(allowed.granted).toBe(true);

      // Relative path outside tempDir should be denied
      const denied = executor.canGrant({ writePaths: ["../outside"] }, { cwd: tempDir });
      expect(denied.granted).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("truncates stdout output exceeding 2MB and appends truncation marker", async () => {
    const executor = new PlainExecutor();
    // Generate ~2.5MB output
    const script = "process.stdout.write('A'.repeat(2.5 * 1024 * 1024))";
    const result = await executor.exec(`node -e "${script}"`);

    const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
    const TRUNCATION_MARKER = "\n[truncated]";

    expect(result.code).toBe(0);
    expect(result.stdout.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(
      MAX_CAPTURE_BYTES + Buffer.byteLength(TRUNCATION_MARKER, "utf8")
    );
  });
});
