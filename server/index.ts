import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { exec, spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerPaneRoutes } from "./panes.ts";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === "production";
const PORT_CANDIDATES = process.env.PORT
  ? [Number(process.env.PORT)]
  : [7777, 7778, 7779];

const SUPPORT_DIR = resolve(homedir(), "Library/Application Support/Sherlock");
const PORT_FILE = resolve(SUPPORT_DIR, "port.txt");
const UPDATE_STATUS_FILE = resolve(SUPPORT_DIR, ".update-status");

const fastify = Fastify({ logger: { level: "info" } });

fastify.get("/api/health", async () => ({
  ok: true,
  apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN),
}));

// Heartbeat — frontend pings every 10s while any Sherlock tab is open.
// We track lastHeartbeatAt for diagnostics and to gate the startup-grace
// orphan-cleanup check below, but we no longer kill the server on
// heartbeat staleness (see startIdleWatcher comment).
const STARTUP_GRACE_MS = 5 * 60 * 1000;
let lastHeartbeatAt = 0;
const serverStartedAt = Date.now();

fastify.post("/api/heartbeat", async () => {
  lastHeartbeatAt = Date.now();
  return { ok: true };
});

// Version: lets the frontend detect when the running process is behind the
// on-disk checkout, and decide whether the user needs a "Refresh" (FE-only
// change) or a full "Restart Sherlock" (anything touching server/types/
// package.json — those files are loaded into Node memory at boot, so only
// a fresh process picks them up).
const BOOTED_SHA = (() => {
  const fromEnv = process.env.SHERLOCK_BOOT_SHA;
  if (fromEnv) return fromEnv.trim();
  try {
    const cwd = process.cwd();
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

// Files that, if changed, require a Node restart (memory-loaded modules).
// Anything else (web/, dist/, scripts/, packaging/, README.md) is safe to
// pick up with a browser refresh.
const RESTART_REQUIRING_PREFIXES = ["server/", "types/", "package.json", "package-lock.json", "tsconfig.json"];

function requiresRestart(changedFiles: string[]): boolean {
  return changedFiles.some((f) => RESTART_REQUIRING_PREFIXES.some((p) => f === p || f.startsWith(p)));
}

fastify.get("/api/version", async () => {
  if (BOOTED_SHA === "unknown") {
    return { booted: "unknown", head: "unknown", restartRequired: false };
  }
  let head = BOOTED_SHA;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd() });
    head = stdout.trim();
  } catch {
    return { booted: BOOTED_SHA, head: BOOTED_SHA, restartRequired: false };
  }
  if (head === BOOTED_SHA) {
    return { booted: BOOTED_SHA, head, restartRequired: false };
  }
  // SHAs differ — inspect the diff to decide refresh vs restart.
  let changed: string[] = [];
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", BOOTED_SHA, head], { cwd: process.cwd() });
    changed = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    // If we can't compute the diff, be conservative and require restart.
    return { booted: BOOTED_SHA, head, restartRequired: true };
  }
  return { booted: BOOTED_SHA, head, restartRequired: requiresRestart(changed) };
});

// Restart: detach a relauncher, then exit. The frontend handles polling for
// the new server to come up and reloads itself.
fastify.post("/api/restart", async (_req, reply) => {
  reply.send({ ok: true });
  // Give Fastify a moment to flush the response, then spawn the detached
  // relauncher and exit. The relauncher waits 500ms (for our process to
  // fully die) and then invokes `open /Applications/Sherlock.app`, which
  // calls launcher.sh, which cold-starts a new server.
  setTimeout(() => {
    spawn("/bin/sh", ["-c", "sleep 0.5; open /Applications/Sherlock.app"], {
      detached: true,
      stdio: "ignore",
    }).unref();
    fastify.log.info("restart requested; exiting");
    process.exit(0);
  }, 200);
});

// Update status: launcher.sh + install.sh write this file as updates happen.
// Sidebar polls and shows "Updating…" / "✓ Updated at HH:MM".
fastify.get("/api/update-status", async () => {
  try {
    const content = await readFile(UPDATE_STATUS_FILE, "utf8");
    const data = JSON.parse(content) as { state?: string; at?: number; head?: string };
    if (!data.state || !data.at) return { state: "idle" };
    const ageMs = Date.now() - data.at * 1000;
    // Treat a stuck "updating" (>5 min old) as idle so the indicator self-clears
    // if the launcher's background update crashed before writing "updated".
    if (data.state === "updating" && ageMs > 5 * 60_000) {
      return { state: "idle" };
    }
    return { state: data.state, at: data.at, head: data.head };
  } catch {
    return { state: "idle" };
  }
});

registerPaneRoutes(fastify);

if (IS_PROD) {
  const distPath = resolve(__dirname, "../dist");
  await fastify.register(fastifyStatic, { root: distPath, wildcard: false });
  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) {
      reply.code(404).send({ error: "not found" });
      return;
    }
    reply.type("text/html").sendFile("index.html");
  });
}

async function listenWithFallback(): Promise<number> {
  let lastErr: unknown;
  for (const port of PORT_CANDIDATES) {
    try {
      await fastify.listen({ port, host: "127.0.0.1" });
      return port;
    } catch (err: unknown) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EADDRINUSE") throw err;
      fastify.log.warn(`port ${port} in use, trying next`);
    }
  }
  throw lastErr;
}

async function writePortFile(port: number) {
  try {
    await mkdir(SUPPORT_DIR, { recursive: true });
    await writeFile(PORT_FILE, String(port), "utf8");
  } catch (err) {
    fastify.log.warn({ err }, "failed to write port file");
  }
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin"
    ? `open ${url}`
    : process.platform === "win32"
      ? `start ${url}`
      : `xdg-open ${url}`;
  exec(cmd, (err) => {
    if (err) fastify.log.warn({ err }, "failed to open browser");
  });
}

function startIdleWatcher() {
  // We deliberately do NOT shut down on heartbeat staleness anymore. macOS
  // Power Nap + closed-lid keeps the Node process ticking while the browser
  // pauses its tab JS — so the frontend's heartbeats stop while the server
  // keeps running, then the server self-killed after 30s, and refresh-after-
  // wake failed. Trading "auto-cleanup after closed tabs" for "always alive"
  // is the right call: ~80MB idle RAM is cheap; broken refresh-after-sleep
  // is unusable.
  //
  // We KEEP the startup-grace check: if no tab connects within 5 min of
  // boot, kill the orphan. This still cleans up the install-but-never-open
  // edge case without touching the sleep path.
  setInterval(() => {
    const now = Date.now();
    if (lastHeartbeatAt === 0 && now - serverStartedAt > STARTUP_GRACE_MS) {
      fastify.log.info("no tab connected within startup grace; shutting down");
      process.exit(0);
    }
  }, 30_000).unref();
}

try {
  const port = await listenWithFallback();
  const url = `http://127.0.0.1:${port}`;
  fastify.log.info(`sherlock server listening on ${url}`);
  if (IS_PROD) {
    await writePortFile(port);
    openBrowser(url);
    startIdleWatcher();
  }
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
