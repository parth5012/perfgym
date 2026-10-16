/**
 * PerfGym Sandbox Lab — demo HTTP server.
 *
 * Loads the TypeScript demo backend through Vite's SSR module loader (no
 * extra build step), then serves the single-page lab UI plus a JSON API:
 *
 *   GET  /api/state       — sandbox status, worktree git status/log, branches
 *   POST /api/init        — (re)create demo repo + acquire sandbox lock
 *   POST /api/write       — sandboxed write (whitelist enforced)
 *   POST /api/read        — sandboxed read
 *   POST /api/rawwrite    — direct fs write BYPASSING the driver (attack sim)
 *   POST /api/symlink     — create symlink inside worktree (attack sim)
 *   POST /api/verify      — blast radius scan
 *   POST /api/accept      — commit step (commit-per-win)
 *   POST /api/reject      — rollback step
 *   POST /api/promote     — promote winning state to a branch
 *   POST /api/compete     — competing lock acquire (must be refused)
 *   POST /api/suite       — run full adversarial scenario suite
 *
 * Run: npm run demo:sandbox   (default http://localhost:5177)
 */
import { createServer as createViteServer } from "vite";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 5177);

const vite = await createViteServer({
  configFile: false,
  root: ROOT,
  logLevel: "warn",
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});

const { DemoSandbox } = await vite.ssrLoadModule("/demo/sandbox-api.ts");
const demo = new DemoSandbox();

const routes = {
  "GET /api/state": () => demo.state(),
  "POST /api/init": (b) => demo.init({ allowedGlobs: b.allowedGlobs }),
  "POST /api/write": (b) => demo.write(b.path, b.content ?? ""),
  "POST /api/read": (b) => demo.readFile(b.path),
  "POST /api/rawwrite": (b) => demo.rawWrite(b.path, b.content ?? ""),
  "POST /api/symlink": (b) => demo.symlink(b.path, b.target),
  "POST /api/verify": () => demo.verify(),
  "POST /api/accept": (b) =>
    demo.accept(Number(b.step ?? 1), Number(b.score ?? 8)),
  "POST /api/reject": () => demo.reject(),
  "POST /api/promote": (b) => demo.promote(b.branch ?? "demo-win"),
  "POST /api/compete": () => demo.attemptCompetingAcquire(),
  "POST /api/suite": () => demo.runSuite(),
};

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function serializeError(err) {
  return {
    tag: err?._tag ?? err?.name ?? "Error",
    code: err?.code ?? err?.name ?? "ERR_DEMO",
    message: err?.message ?? String(err),
  };
}

async function safeState() {
  try {
    return await demo.state();
  } catch (err) {
    return { error: err?.message ?? String(err) };
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(path.join(__dirname, "index.html"), "utf8");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(html);
      return;
    }

    const handler = routes[`${req.method} ${url.pathname}`];
    if (!handler) {
      json(res, 404, {
        ok: false,
        error: {
          tag: "NotFound",
          code: "NOT_FOUND",
          message: `No route: ${req.method} ${url.pathname}`,
        },
      });
      return;
    }

    try {
      const body = req.method === "POST" ? await readBody(req) : {};
      const result = await handler(body);
      json(res, 200, { ok: true, result, state: await safeState() });
    } catch (err) {
      // Domain-level failures (blocked attacks, bad state) are still HTTP 200:
      // the UI decides success/failure from the `ok` flag.
      json(res, 200, { ok: false, error: serializeError(err), state: await safeState() });
    }
  } catch (err) {
    json(res, 500, {
      ok: false,
      error: {
        tag: "ServerError",
        code: "ERR_SERVER",
        message: err?.message ?? String(err),
      },
    });
  }
});

server.listen(PORT, async () => {
  console.log(`PerfGym Sandbox Lab → http://localhost:${PORT}`);
  try {
    await demo.init();
    console.log("Demo sandbox auto-initialized (lock acquired, worktree ready).");
  } catch (err) {
    console.error("Auto-init failed — use the Init button in the UI:", err?.message ?? err);
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} — releasing sandbox lock and shutting down...`);
  try {
    await demo.dispose();
  } catch {
    // ignore
  }
  try {
    await vite.close();
  } catch {
    // ignore
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
