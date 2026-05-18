import { create } from "zustand";
import type {
  ServerSentEvent, StatePublic, ConversationTreePublic, TreeNodePublic,
} from "../../types/events.ts";

export interface UiToolCall {
  toolName: string;
  toolUseId: string;
  partialJson: string;
  blockIndex: number;
}

export type UiTurnStatus = "queued" | "streaming" | "done" | "error";

export interface UiPane {
  paneId: string;
  rootSessionId: string | null;
  currentNodeId: string | null;
}

export interface HistoryEntry {
  sessionId: string;
  title: string;
  lastModifiedAt: number;
  turnCount: number;
  byteSize: number;
}

interface PaneStore {
  rootSessionId: string | null;
  tree: ConversationTreePublic | null;
  panes: UiPane[];
  // Streaming-only state; tool calls are visible during a live turn but
  // don't survive a server restart. (Tree nodes carry the final response
  // text — that's persisted.)
  nodeToolCalls: Record<string, UiToolCall[]>;
  hydrating: boolean;
  error: string | null;

  hydrate: () => Promise<void>;
  applyEvent: (paneId: string, ev: ServerSentEvent) => void;
  registerPane: (paneId: string, currentNodeId: string | null) => void;
  startConversation: (prompt: string) => Promise<string | null>;
  sendInPane: (paneId: string, prompt: string, parentNodeId?: string) => Promise<void>;
  navigatePane: (paneId: string, nodeId: string) => Promise<void>;
  closePane: (paneId: string) => Promise<void>;
  deleteNode: (nodeId: string) => Promise<void>;
  setError: (msg: string | null) => void;
  newConversation: () => Promise<void>;
  loadHistorySession: (sessionId: string) => Promise<void>;
}

// Selectors are stand-alone helpers (zustand-friendly): callers pass tree
// references and pin renders on the subset they care about.
export function selectChildren(tree: ConversationTreePublic | null, nodeId: string | null): TreeNodePublic[] {
  if (!tree || !nodeId) return [];
  return Object.values(tree.nodes)
    .filter((n) => n.parentNodeId === nodeId)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function selectPath(tree: ConversationTreePublic | null, nodeId: string | null): TreeNodePublic[] {
  if (!tree || !nodeId) return [];
  const path: TreeNodePublic[] = [];
  let cur: TreeNodePublic | undefined = tree.nodes[nodeId];
  while (cur) {
    path.unshift(cur);
    cur = cur.parentNodeId ? tree.nodes[cur.parentNodeId] : undefined;
  }
  return path;
}

export function selectIsAnyStreaming(s: PaneStore): boolean {
  if (!s.tree) return false;
  for (const n of Object.values(s.tree.nodes)) {
    if (n.status === "streaming" || n.status === "queued") return true;
  }
  return false;
}

export const usePanes = create<PaneStore>((set, get) => ({
  rootSessionId: null,
  tree: null,
  panes: [],
  nodeToolCalls: {},
  hydrating: false,
  error: null,

  hydrate: async () => {
    set({ hydrating: true });
    try {
      const res = await fetch("/api/state");
      if (!res.ok) throw new Error(`hydrate failed ${res.status}`);
      const data = (await res.json()) as StatePublic;
      set({
        rootSessionId: data.rootSessionId,
        tree: data.tree,
        panes: data.panes.map((p) => ({
          paneId: p.paneId,
          rootSessionId: p.rootSessionId,
          currentNodeId: p.currentNodeId,
        })),
        hydrating: false,
      });
    } catch (err) {
      set({ error: String(err), hydrating: false });
    }
  },

  applyEvent: (_paneId, ev) => {
    set((state) => {
      switch (ev.type) {
        case "node_added": {
          if (!state.tree) {
            // Special case: very first event of a new conversation — the
            // root node arrives before /api/state has been re-queried.
            // Build a minimal tree from this node.
            if (ev.node.parentNodeId === null) {
              const tree: ConversationTreePublic = {
                version: 1,
                rootSessionId: ev.node.sessionId,
                rootNodeId: ev.node.nodeId,
                nodes: { [ev.node.nodeId]: { ...ev.node } },
              };
              return { tree, rootSessionId: ev.node.sessionId };
            }
            return {};
          }
          if (state.tree.nodes[ev.node.nodeId]) return {};
          return {
            tree: {
              ...state.tree,
              nodes: { ...state.tree.nodes, [ev.node.nodeId]: { ...ev.node } },
            },
          };
        }
        case "tree_updated": {
          // Forced refetch — keep state as is, the next /api/state poll fixes things.
          // (Caller can trigger a refresh externally if needed.)
          return {};
        }
        case "turn_started": {
          if (!state.tree || !ev.nodeId) return {};
          const node = state.tree.nodes[ev.nodeId];
          if (!node) return {};
          const updated = { ...node, status: ev.status === "queued" ? "queued" : "streaming" } as TreeNodePublic;
          return { tree: { ...state.tree, nodes: { ...state.tree.nodes, [ev.nodeId]: updated } } };
        }
        case "turn_status": {
          if (!state.tree) return {};
          const node = state.tree.nodes[ev.turnId];
          if (!node) return {};
          const next: UiTurnStatus =
            ev.status === "queued" || ev.status === "streaming" || ev.status === "done" || ev.status === "error"
              ? ev.status
              : "done";
          return { tree: { ...state.tree, nodes: { ...state.tree.nodes, [ev.turnId]: { ...node, status: next } } } };
        }
        case "text_delta": {
          if (!state.tree) return {};
          const node = state.tree.nodes[ev.turnId];
          if (!node) return {};
          return {
            tree: {
              ...state.tree,
              nodes: { ...state.tree.nodes, [ev.turnId]: { ...node, text: node.text + ev.text } },
            },
          };
        }
        case "assistant_message": {
          if (!state.tree) return {};
          const node = state.tree.nodes[ev.turnId];
          if (!node) return {};
          if (node.text.length > 0) return {};
          return {
            tree: {
              ...state.tree,
              nodes: { ...state.tree.nodes, [ev.turnId]: { ...node, text: ev.text } },
            },
          };
        }
        case "tool_use_start": {
          const existing = state.nodeToolCalls[ev.turnId] ?? [];
          if (existing.some((tc) => tc.blockIndex === ev.blockIndex)) return {};
          return {
            nodeToolCalls: {
              ...state.nodeToolCalls,
              [ev.turnId]: [
                ...existing,
                { toolName: ev.toolName, toolUseId: ev.toolUseId, partialJson: "", blockIndex: ev.blockIndex },
              ],
            },
          };
        }
        case "tool_use_input_delta": {
          const existing = state.nodeToolCalls[ev.turnId] ?? [];
          const updated = existing.map((tc) =>
            tc.blockIndex === ev.blockIndex ? { ...tc, partialJson: tc.partialJson + ev.partialJson } : tc,
          );
          return { nodeToolCalls: { ...state.nodeToolCalls, [ev.turnId]: updated } };
        }
        case "done": {
          if (!state.tree) return {};
          const node = state.tree.nodes[ev.turnId];
          if (!node) return {};
          return {
            tree: {
              ...state.tree,
              nodes: {
                ...state.tree.nodes,
                [ev.turnId]: { ...node, status: "done", text: node.text.length > 0 ? node.text : ev.result },
              },
            },
          };
        }
        case "error": {
          if (!ev.turnId) return { error: ev.message };
          if (!state.tree) return { error: ev.message };
          const node = state.tree.nodes[ev.turnId];
          if (!node) return { error: ev.message };
          return {
            tree: { ...state.tree, nodes: { ...state.tree.nodes, [ev.turnId]: { ...node, status: "error" } } },
            error: ev.message,
          };
        }
        case "session_ready":
          return {};
        default:
          return {};
      }
    });
  },

  registerPane: (paneId, currentNodeId) => {
    set((state) =>
      state.panes.some((p) => p.paneId === paneId)
        ? {}
        : { panes: [...state.panes, { paneId, rootSessionId: state.rootSessionId, currentNodeId }] },
    );
  },

  startConversation: async (prompt) => {
    const res = await fetch("/api/conversation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      set({ error: `start conversation failed: ${await res.text()}` });
      return null;
    }
    const data = (await res.json()) as { paneId: string; rootSessionId: string; rootNodeId: string };
    get().registerPane(data.paneId, data.rootNodeId);
    set({ rootSessionId: data.rootSessionId });
    return data.paneId;
  },

  sendInPane: async (paneId, prompt, parentNodeId) => {
    const res = await fetch(`/api/panes/${paneId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, parentNodeId }),
    });
    if (!res.ok) {
      set({ error: `send failed: ${await res.text()}` });
      return;
    }
    const data = (await res.json()) as { nodeId: string };
    // Auto-navigate the pane to the new child. Server already did this in
    // its state; we mirror it client-side so the UI updates immediately
    // (don't wait for /api/state poll).
    set((state) => ({
      panes: state.panes.map((p) =>
        p.paneId === paneId ? { ...p, currentNodeId: data.nodeId } : p,
      ),
    }));
  },

  navigatePane: async (paneId, nodeId) => {
    // Optimistic: update client-side first, then fire-and-forget the server.
    // If the server rejects, the next /api/state hydrate will correct us.
    set((state) => ({
      panes: state.panes.map((p) =>
        p.paneId === paneId ? { ...p, currentNodeId: nodeId } : p,
      ),
    }));
    await fetch(`/api/panes/${paneId}/navigate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId }),
    }).catch(() => {});
  },

  closePane: async (paneId) => {
    await fetch(`/api/panes/${paneId}`, { method: "DELETE" });
    set((state) => ({
      panes: state.panes.filter((p) => p.paneId !== paneId),
    }));
  },

  deleteNode: async (nodeId) => {
    const tree = get().tree;
    if (!tree) return;
    const res = await fetch(`/api/tree/${tree.rootSessionId}/nodes/${nodeId}`, { method: "DELETE" });
    if (!res.ok) {
      set({ error: `delete failed: ${await res.text()}` });
      return;
    }
    // Refetch after deletion — tree shape and pane currentNodeIds may have shifted.
    await get().hydrate();
  },

  setError: (msg) => set({ error: msg }),

  newConversation: async () => {
    const res = await fetch("/api/conversation/new", { method: "POST" });
    if (!res.ok) {
      set({ error: `new conversation failed: ${await res.text()}` });
      return;
    }
    set({ rootSessionId: null, tree: null, panes: [], nodeToolCalls: {}, error: null });
  },

  loadHistorySession: async (sessionId) => {
    const res = await fetch("/api/conversation/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) {
      set({ error: `load failed: ${await res.text()}` });
      return;
    }
    set({ rootSessionId: null, tree: null, panes: [], nodeToolCalls: {}, error: null });
    await get().hydrate();
  },
}));

export async function fetchHistory(): Promise<HistoryEntry[]> {
  const res = await fetch("/api/history");
  if (!res.ok) return [];
  return (await res.json()) as HistoryEntry[];
}
