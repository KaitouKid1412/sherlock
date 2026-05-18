import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { spawnClaude, type RunningClaude } from "./claude-runner.ts";
import { createStreamParser } from "./stream-parser.ts";
import { startSse, type SseChannel } from "./sse.ts";
import { listHistory, loadSession } from "./history.ts";
import type { PanePublic, ServerSentEvent, StatePublic, TurnPublic } from "../types/events.ts";

interface PaneState extends PanePublic {}
interface TurnState extends TurnPublic {}

interface QueuedOp {
  paneId: string;
  turnId: string;
}

const state = {
  sessionId: null as string | null,
  panes: [] as PaneState[],
  turns: new Map<string, TurnState>(),
  eventLog: new Map<string, ServerSentEvent[]>(),
  subscribers: new Map<string, Set<SseChannel>>(),
  running: new Map<string, RunningClaude>(),
  queue: [] as QueuedOp[],
};

function debugLog(label: string, payload: unknown): void {
  process.stdout.write(`[debug ${label}] ${JSON.stringify(payload)}\n`);
}

function resetState(): void {
  for (const running of state.running.values()) running.kill();
  state.running.clear();
  for (const subs of state.subscribers.values()) {
    for (const s of subs) s.close();
  }
  state.subscribers.clear();
  state.eventLog.clear();
  state.turns.clear();
  state.panes = [];
  state.queue = [];
  state.sessionId = null;
}

function append(paneId: string, ev: ServerSentEvent): void {
  if (!state.eventLog.has(paneId)) state.eventLog.set(paneId, []);
  state.eventLog.get(paneId)!.push(ev);
  const subs = state.subscribers.get(paneId);
  if (subs) for (const s of subs) s.send(ev);
}

function createPane(): PaneState {
  const pane: PaneState = {
    paneId: randomUUID(),
    turnIds: [],
    createdAt: Date.now(),
  };
  state.panes.push(pane);
  state.eventLog.set(pane.paneId, []);
  return pane;
}

function startTurn(paneId: string, prompt: string): TurnState {
  const willRunNow = state.running.size === 0;
  const turn: TurnState = {
    turnId: randomUUID(),
    prompt,
    text: "",
    status: willRunNow ? "streaming" : "queued",
    startedAt: Date.now(),
  };
  state.turns.set(turn.turnId, turn);
  const pane = state.panes.find((p) => p.paneId === paneId);
  if (pane) pane.turnIds.push(turn.turnId);
  append(paneId, { type: "turn_started", turnId: turn.turnId, prompt, status: turn.status });
  return turn;
}

function enqueue(op: QueuedOp): void {
  state.queue.push(op);
}

function drainQueue(): void {
  if (state.running.size > 0) return;
  while (state.queue.length > 0) {
    const op = state.queue.shift()!;
    const pane = state.panes.find((p) => p.paneId === op.paneId);
    const turn = state.turns.get(op.turnId);
    if (!pane || !turn || turn.status === "cancelled") continue;
    turn.status = "streaming";
    append(pane.paneId, { type: "turn_status", turnId: turn.turnId, status: "streaming" });
    runTurn(pane, turn);
    return;
  }
}

function runTurn(pane: PaneState, turn: TurnState): void {
  const isBootstrap = state.sessionId === null;
  if (isBootstrap) state.sessionId = randomUUID();
  const running = spawnClaude({
    prompt: turn.prompt,
    bootstrap: isBootstrap ? { sessionId: state.sessionId! } : undefined,
    resume: isBootstrap ? undefined : { sessionId: state.sessionId! },
  });
  state.running.set(pane.paneId, running);

  const parser = createStreamParser(
    { turnId: turn.turnId },
    (ev) => {
      if (ev.type === "text_delta") {
        turn.text += ev.text;
      } else if (ev.type === "assistant_message" && turn.text.length === 0) {
        turn.text = ev.text;
      } else if (ev.type === "done") {
        turn.status = "done";
        turn.endedAt = Date.now();
      } else if (ev.type === "error") {
        turn.status = "error";
        turn.endedAt = Date.now();
      }
      append(pane.paneId, ev);
    },
    debugLog,
  );

  running.onLine(parser);
  running.onClose((code) => {
    state.running.delete(pane.paneId);
    if (turn.status === "streaming") {
      turn.status = code === 0 ? "done" : "error";
      turn.endedAt = Date.now();
      append(pane.paneId, { type: "done", turnId: turn.turnId, result: turn.text });
    }
    drainQueue();
  });
}

export function registerPaneRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/state", async (): Promise<StatePublic> => ({
    sessionId: state.sessionId,
    panes: state.panes,
    turns: Object.fromEntries(state.turns),
  }));

  fastify.post<{ Body: { prompt?: string } }>("/api/panes", async (req, reply) => {
    const prompt = req.body?.prompt;
    if (!prompt || typeof prompt !== "string") {
      reply.code(400);
      return { error: "prompt required" };
    }
    if (state.panes.length > 0) {
      reply.code(409);
      return { error: "root pane already exists; POST /api/panes/:id/send instead" };
    }
    const pane = createPane();
    const turn = startTurn(pane.paneId, prompt);
    if (turn.status === "streaming") runTurn(pane, turn);
    else enqueue({ paneId: pane.paneId, turnId: turn.turnId });
    return { paneId: pane.paneId, turnId: turn.turnId };
  });

  fastify.post<{ Params: { id: string }; Body: { prompt?: string } }>(
    "/api/panes/:id/send",
    async (req, reply) => {
      const pane = state.panes.find((p) => p.paneId === req.params.id);
      if (!pane) { reply.code(404); return { error: "pane not found" }; }
      const isLatest = state.panes[state.panes.length - 1]?.paneId === pane.paneId;
      if (!isLatest) { reply.code(409); return { error: "send is only allowed in the rightmost pane" }; }
      const prompt = req.body?.prompt;
      if (!prompt || typeof prompt !== "string") {
        reply.code(400);
        return { error: "prompt required" };
      }
      const turn = startTurn(pane.paneId, prompt);
      if (turn.status === "streaming") runTurn(pane, turn);
      else enqueue({ paneId: pane.paneId, turnId: turn.turnId });
      reply.code(202);
      return { turnId: turn.turnId, status: turn.status };
    },
  );

  fastify.post<{ Params: { id: string }; Body: { prompt?: string } }>(
    "/api/panes/:id/continue-in-new-column",
    async (req, reply) => {
      const src = state.panes.find((p) => p.paneId === req.params.id);
      if (!src) { reply.code(404); return { error: "source pane not found" }; }
      const prompt = req.body?.prompt;
      if (!prompt || typeof prompt !== "string") {
        reply.code(400);
        return { error: "prompt required" };
      }
      const pane = createPane();
      const turn = startTurn(pane.paneId, prompt);
      if (turn.status === "streaming") runTurn(pane, turn);
      else enqueue({ paneId: pane.paneId, turnId: turn.turnId });
      return { paneId: pane.paneId, turnId: turn.turnId, status: turn.status };
    },
  );

  fastify.get<{ Params: { id: string } }>("/api/panes/:id/stream", (req, reply) => {
    const pane = state.panes.find((p) => p.paneId === req.params.id);
    if (!pane) {
      reply.code(404);
      return reply.send({ error: "pane not found" });
    }
    const channel = startSse(req, reply);
    if (!state.subscribers.has(pane.paneId)) state.subscribers.set(pane.paneId, new Set());
    state.subscribers.get(pane.paneId)!.add(channel);

    const log = state.eventLog.get(pane.paneId) ?? [];
    for (const ev of log) channel.send(ev);

    req.raw.on("close", () => {
      state.subscribers.get(pane.paneId)?.delete(channel);
    });
  });

  fastify.get("/api/history", async () => {
    return await listHistory(process.cwd());
  });

  fastify.post("/api/conversation/new", async () => {
    resetState();
    return { ok: true };
  });

  fastify.post<{ Body: { sessionId?: string } }>("/api/conversation/load", async (req, reply) => {
    const sid = req.body?.sessionId;
    if (!sid || typeof sid !== "string") {
      reply.code(400);
      return { error: "sessionId required" };
    }
    const loaded = await loadSession(process.cwd(), sid);
    if (!loaded || loaded.turns.length === 0) {
      reply.code(404);
      return { error: "session not found or empty" };
    }
    resetState();
    state.sessionId = loaded.sessionId;
    const pane = createPane();
    for (const t of loaded.turns) {
      const turn: TurnState = {
        turnId: randomUUID(),
        prompt: t.prompt,
        text: t.text,
        status: "done",
        startedAt: Date.now(),
        endedAt: Date.now(),
      };
      state.turns.set(turn.turnId, turn);
      pane.turnIds.push(turn.turnId);
    }
    return { paneId: pane.paneId, turnCount: loaded.turns.length, sessionId: loaded.sessionId };
  });

  fastify.delete<{ Params: { id: string } }>("/api/panes/:id", async (req, reply) => {
    const idx = state.panes.findIndex((p) => p.paneId === req.params.id);
    if (idx === -1) { reply.code(404); return { error: "pane not found" }; }
    const running = state.running.get(req.params.id);
    if (running) running.kill();
    state.running.delete(req.params.id);
    state.subscribers.get(req.params.id)?.forEach((s) => s.close());
    state.subscribers.delete(req.params.id);
    state.eventLog.delete(req.params.id);
    state.queue = state.queue.filter((op) => op.paneId !== req.params.id);
    const pane = state.panes[idx]!;
    for (const turnId of pane.turnIds) state.turns.delete(turnId);
    state.panes.splice(idx, 1);
    if (state.panes.length === 0) state.sessionId = null;
    drainQueue();
    return { ok: true };
  });
}
