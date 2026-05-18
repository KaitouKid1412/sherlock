import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { spawnClaude, type RunningClaude } from "./claude-runner.ts";
import { createStreamParser } from "./stream-parser.ts";
import { startSse, type SseChannel } from "./sse.ts";
import { listHistory, loadSession } from "./history.ts";
import {
  loadTree, saveTree, createTree, addNode, canLinearContinue,
  removeSubtree, synthesizeTreeFromTurns,
} from "./tree.ts";
import { snapshotSession, deleteSessionFile, findSessionTailUuid } from "./fork.ts";
import type {
  PanePublic, ServerSentEvent, StatePublic, TurnPublic, ConversationTreePublic, TreeNodePublic,
} from "../types/events.ts";

interface PaneState extends PanePublic {}
interface TurnState extends TurnPublic {}

interface QueuedOp {
  paneId: string;
  nodeId: string;
}

// Server state. One conversation (one tree) loaded at a time; multiple panes
// can be open against it, each pinned to its own currentNodeId.
const state = {
  rootSessionId: null as string | null,
  tree: null as ConversationTreePublic | null,
  panes: [] as PaneState[],
  turns: new Map<string, TurnState>(),  // runtime streaming buffers, keyed by nodeId
  eventLog: new Map<string, ServerSentEvent[]>(),
  subscribers: new Map<string, Set<SseChannel>>(),
  running: new Map<string, RunningClaude>(),  // keyed by nodeId
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
  state.rootSessionId = null;
  state.tree = null;
}

function broadcast(ev: ServerSentEvent): void {
  // Conversation-scoped broadcast: every pane in the current conversation
  // sees every event, so a node spawned in pane A shows up live in pane B.
  // Event log is also keyed per-pane (for replay on SSE reconnect).
  for (const pane of state.panes) {
    if (!state.eventLog.has(pane.paneId)) state.eventLog.set(pane.paneId, []);
    state.eventLog.get(pane.paneId)!.push(ev);
    const subs = state.subscribers.get(pane.paneId);
    if (subs) for (const s of subs) s.send(ev);
  }
}

function createPane(currentNodeId: string | null, afterPaneId?: string): PaneState {
  const pane: PaneState = {
    paneId: randomUUID(),
    rootSessionId: state.rootSessionId,
    currentNodeId,
    createdAt: Date.now(),
  };
  if (afterPaneId) {
    const idx = state.panes.findIndex((p) => p.paneId === afterPaneId);
    if (idx >= 0) {
      state.panes.splice(idx + 1, 0, pane);
    } else {
      state.panes.push(pane);
    }
  } else {
    state.panes.push(pane);
  }
  state.eventLog.set(pane.paneId, []);
  return pane;
}

function turnFromNode(node: TreeNodePublic): TurnState {
  return {
    turnId: node.nodeId,
    prompt: node.prompt,
    text: node.text,
    status: node.status,
    startedAt: node.createdAt,
    nodeId: node.nodeId,
  };
}

function enqueue(op: QueuedOp): void {
  state.queue.push(op);
}

function drainQueue(): void {
  if (state.running.size > 0) return;
  while (state.queue.length > 0) {
    const op = state.queue.shift()!;
    if (!state.tree) continue;
    const node = state.tree.nodes[op.nodeId];
    if (!node || node.status === "cancelled") continue;
    node.status = "streaming";
    broadcast({ type: "turn_status", turnId: node.nodeId, status: "streaming" });
    runNode(node);
    return;
  }
}

function runNode(node: TreeNodePublic): void {
  if (!state.tree) return;
  const tree = state.tree;
  const isRoot = node.parentNodeId === null;
  const running = spawnClaude({
    prompt: node.prompt,
    bootstrap: isRoot ? { sessionId: node.sessionId } : undefined,
    resume: isRoot ? undefined : { sessionId: node.sessionId },
  });
  state.running.set(node.nodeId, running);

  const parser = createStreamParser(
    { turnId: node.nodeId },
    (ev) => {
      if (ev.type === "text_delta") {
        node.text += ev.text;
      } else if (ev.type === "assistant_message" && node.text.length === 0) {
        node.text = ev.text;
      } else if (ev.type === "done") {
        node.status = "done";
      } else if (ev.type === "error") {
        node.status = "error";
      }
      broadcast(ev);
    },
    debugLog,
  );

  running.onLine(parser);
  running.onClose(async (code) => {
    state.running.delete(node.nodeId);
    if (node.status === "streaming") {
      node.status = code === 0 ? "done" : "error";
      broadcast({ type: "done", turnId: node.nodeId, result: node.text });
    }
    // Capture the just-written .jsonl tail uuid as this node's fork point.
    // Done after onClose because Claude Code finishes flushing its file write
    // by the time the child process exits.
    try {
      const tail = await findSessionTailUuid(node.sessionId);
      if (tail) node.claudeUuid = tail;
    } catch {
      /* best-effort */
    }
    // Persist tree on every turn completion so a crash mid-conversation
    // doesn't lose anything that's already been generated.
    void saveTree(tree);
    drainQueue();
  });
}

async function addChildNode(parentNodeId: string, prompt: string): Promise<TreeNodePublic> {
  if (!state.tree) throw new Error("no tree loaded");
  const tree = state.tree;
  const parent = tree.nodes[parentNodeId];
  if (!parent) throw new Error(`parent node ${parentNodeId} not in tree`);

  // Decide: linear continuation (reuse parent's session) or fork (snapshot).
  let childSessionId: string;
  if (canLinearContinue(tree, parentNodeId)) {
    childSessionId = parent.sessionId;
  } else {
    if (!parent.claudeUuid) {
      // We don't have the parent's tail UUID — common for legacy (synthesized)
      // trees where the snapshot point wasn't recorded. Fall back to linear:
      // accept that the parent's session will get extended even though it has
      // a child elsewhere. In practice this only happens on the FIRST branch
      // off a legacy conversation, and the worst case is "we re-extend the
      // original .jsonl alongside the older branch."
      childSessionId = parent.sessionId;
    } else {
      const snap = await snapshotSession(parent.sessionId, parent.claudeUuid);
      childSessionId = snap.newSessionId;
    }
  }

  const child = addNode(tree, parentNodeId, childSessionId, prompt);
  return child;
}

export function registerPaneRoutes(fastify: FastifyInstance): void {
  fastify.get("/api/state", async (): Promise<StatePublic> => ({
    rootSessionId: state.rootSessionId,
    panes: state.panes,
    turns: Object.fromEntries(state.turns),
    tree: state.tree,
  }));

  // Create a brand-new conversation: tree, root node, initial pane all at once.
  fastify.post<{ Body: { prompt?: string } }>("/api/conversation", async (req, reply) => {
    const prompt = req.body?.prompt;
    if (!prompt || typeof prompt !== "string") {
      reply.code(400);
      return { error: "prompt required" };
    }
    if (state.tree !== null) {
      reply.code(409);
      return { error: "conversation already exists; use new-conversation to reset first" };
    }
    const rootSessionId = randomUUID();
    state.rootSessionId = rootSessionId;
    state.tree = createTree(rootSessionId, prompt);
    const root = state.tree.nodes[state.tree.rootNodeId]!;
    const pane = createPane(root.nodeId);
    broadcast({ type: "node_added", node: root });
    broadcast({ type: "turn_started", turnId: root.nodeId, prompt: root.prompt, status: root.status, nodeId: root.nodeId });
    if (state.running.size === 0) {
      runNode(root);
    } else {
      enqueue({ paneId: pane.paneId, nodeId: root.nodeId });
    }
    return { rootSessionId, rootNodeId: root.nodeId, paneId: pane.paneId };
  });

  // Send a follow-up: creates a child of the given parent node and runs
  // Claude Code. Does NOT mutate the source pane's currentNodeId — the
  // caller decides whether to navigate this pane to the child ("open here")
  // or spawn a new pane viewing the child ("open in new pane"). Keeping the
  // source pane put preserves the multi-column workflow: sibling branches
  // accumulate as adjacent panes instead of overwriting each other.
  fastify.post<{ Params: { id: string }; Body: { prompt?: string; parentNodeId?: string } }>(
    "/api/panes/:id/send",
    async (req, reply) => {
      const pane = state.panes.find((p) => p.paneId === req.params.id);
      if (!pane) { reply.code(404); return { error: "pane not found" }; }
      if (!state.tree) { reply.code(409); return { error: "no conversation loaded" }; }
      const prompt = req.body?.prompt;
      if (!prompt || typeof prompt !== "string") {
        reply.code(400);
        return { error: "prompt required" };
      }
      const parentNodeId = req.body?.parentNodeId ?? pane.currentNodeId;
      if (!parentNodeId) { reply.code(400); return { error: "no parent node — pane has no current node" }; }
      const parent = state.tree.nodes[parentNodeId];
      if (!parent) { reply.code(404); return { error: "parent node not in tree" }; }
      const child = await addChildNode(parentNodeId, prompt);
      broadcast({ type: "node_added", node: child });
      broadcast({ type: "turn_started", turnId: child.nodeId, prompt: child.prompt, status: child.status, nodeId: child.nodeId });
      if (state.running.size === 0) {
        runNode(child);
      } else {
        child.status = "queued";
        enqueue({ paneId: pane.paneId, nodeId: child.nodeId });
      }
      reply.code(202);
      return { nodeId: child.nodeId, status: child.status };
    },
  );

  // Move the pane's view to a different node in the same tree. No model call.
  fastify.post<{ Params: { id: string }; Body: { nodeId?: string } }>(
    "/api/panes/:id/navigate",
    async (req, reply) => {
      const pane = state.panes.find((p) => p.paneId === req.params.id);
      if (!pane) { reply.code(404); return { error: "pane not found" }; }
      const nodeId = req.body?.nodeId;
      if (!nodeId || typeof nodeId !== "string") { reply.code(400); return { error: "nodeId required" }; }
      if (!state.tree || !state.tree.nodes[nodeId]) { reply.code(404); return { error: "node not in tree" }; }
      pane.currentNodeId = nodeId;
      return { ok: true, currentNodeId: nodeId };
    },
  );

  // Spawn a new pane viewing a specific node of the current tree. This is
  // how "open in new column" works in the tree world: pass the node the new
  // pane should display, and optionally the source pane (afterPaneId) so the
  // new column gets inserted immediately to the right of the click target
  // instead of at the end of the row.
  fastify.post<{ Body: { currentNodeId?: string; afterPaneId?: string } }>(
    "/api/panes",
    async (req, reply) => {
      if (!state.tree) { reply.code(409); return { error: "no conversation loaded" }; }
      const startNodeId = req.body?.currentNodeId ?? state.tree.rootNodeId;
      if (!state.tree.nodes[startNodeId]) { reply.code(404); return { error: "currentNodeId not in tree" }; }
      const pane = createPane(startNodeId, req.body?.afterPaneId);
      return { paneId: pane.paneId, currentNodeId: pane.currentNodeId };
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

    // Replay: send the tree's current state, then any buffered conversation events.
    if (state.tree) {
      for (const node of Object.values(state.tree.nodes)) {
        channel.send({ type: "node_added", node });
      }
    }
    const log = state.eventLog.get(pane.paneId) ?? [];
    for (const ev of log) channel.send(ev);

    req.raw.on("close", () => {
      state.subscribers.get(pane.paneId)?.delete(channel);
    });
  });

  fastify.get("/api/history", async () => {
    return await listHistory(process.cwd());
  });

  // Returns the tree without touching state — used by clients that want
  // to inspect a conversation tree (currently unused but cheap to expose).
  fastify.get<{ Params: { rootSessionId: string } }>(
    "/api/tree/:rootSessionId",
    async (req, reply) => {
      const tree = await loadTree(req.params.rootSessionId);
      if (!tree) { reply.code(404); return { error: "tree not found" }; }
      return tree;
    },
  );

  fastify.post("/api/conversation/new", async () => {
    resetState();
    return { ok: true };
  });

  // Load an existing conversation into server state. If the session has a
  // tree.json, load it; otherwise synthesize one from the legacy linear .jsonl
  // so old conversations open as a single-spine tree.
  fastify.post<{ Body: { sessionId?: string } }>("/api/conversation/load", async (req, reply) => {
    const sid = req.body?.sessionId;
    if (!sid || typeof sid !== "string") {
      reply.code(400);
      return { error: "sessionId required" };
    }
    let tree = await loadTree(sid);
    if (!tree) {
      // Legacy path: build tree on the fly from the .jsonl.
      const loaded = await loadSession(process.cwd(), sid);
      if (!loaded || loaded.turns.length === 0) {
        reply.code(404);
        return { error: "session not found or empty" };
      }
      tree = synthesizeTreeFromTurns(
        sid,
        loaded.turns.map((t) => ({ prompt: t.prompt, text: t.text, lastClaudeUuid: t.lastClaudeUuid ?? "" })),
      );
      await saveTree(tree);
    }
    resetState();
    state.rootSessionId = tree.rootSessionId;
    state.tree = tree;
    const pane = createPane(tree.rootNodeId);
    return { paneId: pane.paneId, rootSessionId: tree.rootSessionId, rootNodeId: tree.rootNodeId };
  });

  fastify.delete<{ Params: { id: string } }>("/api/panes/:id", async (req, reply) => {
    const idx = state.panes.findIndex((p) => p.paneId === req.params.id);
    if (idx === -1) { reply.code(404); return { error: "pane not found" }; }
    state.subscribers.get(req.params.id)?.forEach((s) => s.close());
    state.subscribers.delete(req.params.id);
    state.eventLog.delete(req.params.id);
    state.panes.splice(idx, 1);
    // Closing a pane never affects the tree or any running turn (turns are
    // bound to node IDs, not pane IDs).
    return { ok: true };
  });

  // Delete a subtree (a branch). Removes nodes from the tree and the
  // associated Claude Code session files for any session that's now
  // unreferenced by the remaining tree.
  fastify.delete<{ Params: { rootSessionId: string; nodeId: string } }>(
    "/api/tree/:rootSessionId/nodes/:nodeId",
    async (req, reply) => {
      if (!state.tree || state.tree.rootSessionId !== req.params.rootSessionId) {
        reply.code(404);
        return { error: "tree not loaded or mismatched root" };
      }
      const tree = state.tree;
      const target = tree.nodes[req.params.nodeId];
      if (!target) { reply.code(404); return { error: "node not in tree" }; }
      if (target.parentNodeId === null) { reply.code(400); return { error: "cannot delete root node — use /api/conversation/new" }; }
      // Kill any running Claude processes for nodes in the subtree.
      const removed = removeSubtree(tree, target.nodeId);
      const removedIds = new Set(removed.map((n) => n.nodeId));
      for (const [nodeId, running] of state.running.entries()) {
        if (removedIds.has(nodeId)) { running.kill(); state.running.delete(nodeId); }
      }
      // Repoint any pane that was viewing a removed node to its closest
      // surviving ancestor (or the tree root as fallback).
      for (const pane of state.panes) {
        if (pane.currentNodeId && removedIds.has(pane.currentNodeId)) {
          let cur: TreeNodePublic | undefined = target.parentNodeId ? tree.nodes[target.parentNodeId] : undefined;
          pane.currentNodeId = cur?.nodeId ?? tree.rootNodeId;
        }
      }
      // Delete the underlying Claude Code .jsonl for any session that's now
      // unreferenced. The root session stays because deleting it would
      // effectively delete the conversation; that's handled by /new.
      const survivingSessions = new Set(Object.values(tree.nodes).map((n) => n.sessionId));
      for (const r of removed) {
        if (!survivingSessions.has(r.sessionId) && r.sessionId !== tree.rootSessionId) {
          await deleteSessionFile(r.sessionId);
        }
      }
      await saveTree(tree);
      broadcast({ type: "tree_updated", rootSessionId: tree.rootSessionId });
      return { ok: true, removedNodeIds: Array.from(removedIds) };
    },
  );
}

// Expose helpers used by tests / index.ts diagnostics.
export function _internalState() { return state; }
