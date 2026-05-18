import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { exec } from "node:child_process";
import { registerPaneRoutes } from "./panes.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === "production";
const PORT_CANDIDATES = process.env.PORT
  ? [Number(process.env.PORT)]
  : [7777, 7778, 7779];

const SUPPORT_DIR = resolve(homedir(), "Library/Application Support/Sherlock");
const PORT_FILE = resolve(SUPPORT_DIR, "port.txt");

const fastify = Fastify({ logger: { level: "info" } });

fastify.get("/api/health", async () => ({
  ok: true,
  apiKeyPresent: Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN),
}));

// Heartbeat — frontend pings every 10s while any Sherlock tab is open.
// In production, the server self-shuts-down 30s after the last heartbeat.
const IDLE_TIMEOUT_MS = 30_000;
const STARTUP_GRACE_MS = 5 * 60 * 1000;
let lastHeartbeatAt = 0;
const serverStartedAt = Date.now();

fastify.post("/api/heartbeat", async () => {
  lastHeartbeatAt = Date.now();
  return { ok: true };
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
  setInterval(() => {
    const now = Date.now();
    if (lastHeartbeatAt === 0) {
      if (now - serverStartedAt > STARTUP_GRACE_MS) {
        fastify.log.info("no tab connected within startup grace; shutting down");
        process.exit(0);
      }
    } else if (now - lastHeartbeatAt > IDLE_TIMEOUT_MS) {
      fastify.log.info("no heartbeat for 30s; shutting down");
      process.exit(0);
    }
  }, 5_000).unref();
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
