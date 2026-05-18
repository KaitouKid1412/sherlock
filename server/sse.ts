import type { FastifyReply, FastifyRequest } from "fastify";
import type { ServerSentEvent } from "../types/events.ts";

export interface SseChannel {
  send: (ev: ServerSentEvent) => void;
  close: () => void;
}

export function startSse(req: FastifyRequest, reply: FastifyReply): SseChannel {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  raw.write(":\n\n");

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { raw.end(); } catch { /* ignore */ }
  };
  req.raw.on("close", cleanup);

  return {
    send: (ev) => {
      if (closed) return;
      try {
        raw.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        cleanup();
      }
    },
    close: cleanup,
  };
}
