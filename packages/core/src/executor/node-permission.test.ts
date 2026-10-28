import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodePermissionExecutor } from "./node-permission.js";
import { resolveCommandExecutor } from "./resolve.js";

describe("NodePermissionExecutor & Backend Auto-Resolution", () => {
  it("AC1: runs a Node command under --permission and blocks a denied write path", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "perfgym-perm-test-"));
    const allowedFile = join(tempDir, "allowed.txt");
    const deniedDir = mkdtempSync(join(tmpdir(), "perfgym-denied-test-"));
    const deniedFile = join(deniedDir, "denied.txt");

    try {
      const executor = new NodePermissionExecutor();

      // 1. Allowed write succeeds
      const allowResult = await executor.exec(
        `node -e "require('fs').writeFileSync('${allowedFile}', 'ok')"`,
        {
          capabilities: { writePaths: [tempDir] },
        }
      );
      expect(allowResult.code).toBe(0);
      expect(allowResult.blocked).toBe(false);
      expect(allowResult.backend).toBe("node-permission");
      expect(existsSync(allowedFile)).toBe(true);

      // 2. Denied write is blocked
      const denyResult = await executor.exec(
        `node -e "require('fs').writeFileSync('${deniedFile}', 'forbidden')"`,
        {
          capabilities: { writePaths: [tempDir] },
        }
      );
      expect(denyResult.blocked).toBe(true);
      expect(denyResult.backend).toBe("node-permission");
      expect(denyResult.stderr).toMatch(/ERR_ACCESS_DENIED|Access to this API has been restricted/);
      expect(existsSync(deniedFile)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(deniedDir, { recursive: true, force: true });
    }
  });

  it("AC2: falls back to plain for non-Node commands and reports backend as plain", async () => {
    const executor = new NodePermissionExecutor();
    const result = await executor.exec('sh -c "echo hello non-node"');

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hello non-node");
    expect(result.backend).toBe("plain");
    expect(result.blocked).toBe(false);
  });

  it("AC4: explicit node-permission selection on a non-Node command reports plain (honest reporting)", async () => {
    const executor = new NodePermissionExecutor();
    // Non-node command executed under NodePermissionExecutor
    const result = await executor.exec("echo test-honest-reporting");

    expect(result.backend).toBe("plain");
    expect(result.backend).not.toBe("node-permission");
  });

  it("AC3: auto resolution order (mxc -> bwrap -> node-permission -> plain) and 'none' forces plain", () => {
    // 1. mxc probe succeeds -> mxc chosen
    const mxcResolved = resolveCommandExecutor({
      backend: "auto",
      probes: {
        probeMxc: () => true,
        probeBwrap: () => true,
        probeNodePermission: () => true,
      },
    });
    expect(mxcResolved.backend).toBe("mxc");

    // 2. mxc fails, bwrap probe succeeds -> bwrap chosen
    const bwrapResolved = resolveCommandExecutor({
      backend: "auto",
      probes: {
        probeMxc: () => false,
        probeBwrap: () => true,
        probeNodePermission: () => true,
      },
    });
    expect(bwrapResolved.backend).toBe("bwrap");

    // 3. mxc and bwrap fail, node-permission probe succeeds -> node-permission chosen
    const nodePermResolved = resolveCommandExecutor({
      backend: "auto",
      probes: {
        probeMxc: () => false,
        probeBwrap: () => false,
        probeNodePermission: () => true,
      },
    });
    expect(nodePermResolved.backend).toBe("node-permission");

    // 4. all probes fail -> plain fallback
    const plainResolved = resolveCommandExecutor({
      backend: "auto",
      probes: {
        probeMxc: () => false,
        probeBwrap: () => false,
        probeNodePermission: () => false,
      },
    });
    expect(plainResolved.backend).toBe("plain");

    // 5. explicit 'none' forces plain, ignoring active probes
    const noneResolved = resolveCommandExecutor({
      backend: "none",
      probes: {
        probeMxc: () => true,
        probeBwrap: () => true,
        probeNodePermission: () => true,
      },
    });
    expect(noneResolved.backend).toBe("plain");

    // 6. explicit backend probe failures fall back to plain
    const mxcFailed = resolveCommandExecutor({
      backend: "mxc",
      probes: { probeMxc: () => false },
    });
    expect(mxcFailed.backend).toBe("plain");

    const bwrapFailed = resolveCommandExecutor({
      backend: "bwrap",
      probes: { probeBwrap: () => false },
    });
    expect(bwrapFailed.backend).toBe("plain");

    const nodeFailed = resolveCommandExecutor({
      backend: "node-permission",
      probes: { probeNodePermission: () => false },
    });
    expect(nodeFailed.backend).toBe("plain");

    // 7. auto resolution without OS backends resolves to node-permission in supported Node runtime
    const defaultNodeResolved = resolveCommandExecutor({
      probes: { probeMxc: () => false, probeBwrap: () => false },
    });
    expect(defaultNodeResolved.backend).toBe("node-permission");

    // 8. default resolution on this environment chooses an available confined backend (bwrap or node-permission)
    const defaultResolved = resolveCommandExecutor();
    expect(["bwrap", "node-permission"]).toContain(defaultResolved.backend);
  });

  it("handles compound shell commands and paths with spaces safely", async () => {
    const executor = new NodePermissionExecutor();

    // Compound shell commands fall back to plain
    const compound = await executor.exec("node -e \"process.stdout.write('a')\" && echo b");
    expect(compound.code).toBe(0);
    expect(compound.backend).toBe("plain");
    expect(compound.stdout.trim()).toBe("ab");

    // Quoted executable parsing works
    const tempDir = mkdtempSync(join(tmpdir(), "perfgym space test-"));
    const allowedFile = join(tempDir, "space file.txt");
    try {
      const result = await executor.exec(
        `node -e "require('fs').writeFileSync('${allowedFile}', 'content')"`,
        { capabilities: { writePaths: [tempDir] } }
      );
      expect(result.code).toBe(0);
      expect(result.backend).toBe("node-permission");
      expect(existsSync(allowedFile)).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    // In-script semicolons inside quoted strings do NOT cause fallback to plain
    const jsSemicolon = await executor.exec('node -e "const x = 1; console.log(x);"');
    expect(jsSemicolon.code).toBe(0);
    expect(jsSemicolon.stdout.trim()).toBe("1");
    expect(jsSemicolon.backend).toBe("node-permission");

    // Redirection falls back to plain (honest reporting)
    const redirection = await executor.exec("node -e \"console.log('out')\" > /dev/null");
    expect(redirection.code).toBe(0);
    expect(redirection.backend).toBe("plain");

    // Control characters in capability paths are rejected before execution
    await expect(
      executor.exec('node -e "process.exit(0)"', {
        capabilities: { writePaths: ["/tmp/malicious\nrm -rf /"] },
      })
    ).rejects.toThrow(/prohibited control characters/);

    // Empty readPaths ([]) denies fs reads
    const emptyReadRes = await executor.exec(
      'node -e "require(\'fs\').readFileSync(\'/etc/hosts\')"',
      { capabilities: { readPaths: [] } }
    );
    expect(emptyReadRes.blocked).toBe(true);
    expect(emptyReadRes.backend).toBe("node-permission");
  });
});
