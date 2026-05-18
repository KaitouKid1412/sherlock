import { create } from "zustand";
import type { ServerSentEvent, StatePublic } from "../../types/events.ts";

export interface UiToolCall {
  toolName: string;
  toolUseId: string;
  partialJson: string;
  blockIndex: number;
}

export type UiTurnStatus = "queued" | "streaming" | "done" | "error";

export interface UiTurn {
  turnId: string;
  prompt: string;
  text: string;
  status: UiTurnStatus;
  toolCalls: UiToolCall[];
}

export interface UiPane {
  paneId: string;
  turnIds: string[];
}

interface PaneStore {
  sessionId: string | null;
  panes: UiPane[];
  turns: Record<string, UiTurn>;
  hydrating: boolean;
  error: string | null;

  hydrate: () => Promise<void>;
  applyEvent: (paneId: string, ev: ServerSentEvent) => void;
  registerPane: (paneId: string) => void;
  bootstrapWithPrompt: (prompt: string) => Promise<string | null>;
  sendInline: (paneId: string, prompt: string) => Promise<void>;
  continueInNewColumn: (srcPaneId: string, prompt: string) => Promise<string | null>;
  closePane: (paneId: string) => Promise<void>;
  setError: (msg: string | null) => void;
  newConversation: () => Promise<void>;
  loadHistorySession: (sessionId: string) => Promise<void>;
}

export interface HistoryEntry {
  sessionId: string;
  title: string;
  lastModifiedAt: number;
  turnCount: number;
  byteSize: number;
}

export function selectIsAnyStreaming(s: PaneStore): boolean {
  for (const id in s.turns) {
    if (s.turns[id]?.status === "streaming") return true;
  }
  return false;
}

function emptyTurn(turnId: string, prompt: string, status: UiTurnStatus): UiTurn {
  return { turnId, prompt, text: "", status, toolCalls: [] };
}

export const usePanes = create<PaneStore>((set, get) => ({
  sessionId: null,
  panes: [],
  turns: {},
  hydrating: false,
  error: null,

  hydrate: async () => {
    set({ hydrating: true });
    try {
      const res = await fetch("/api/state");
      if (!res.ok) throw new Error(`hydrate failed ${res.status}`);
      const data = (await res.json()) as StatePublic;
      const turns: Record<string, UiTurn> = {};
      for (const [id, t] of Object.entries(data.turns)) {
        const status: UiTurnStatus =
          t.status === "streaming" || t.status === "done" || t.status === "error" || t.status === "queued"
            ? t.status
            : "done";
        turns[id] = { turnId: t.turnId, prompt: t.prompt, text: t.text, status, toolCalls: [] };
      }
      set({
        sessionId: data.sessionId,
        panes: data.panes.map((p) => ({ paneId: p.paneId, turnIds: p.turnIds })),
        turns,
        hydrating: false,
      });
    } catch (err) {
      set({ error: String(err), hydrating: false });
    }
  },

  applyEvent: (paneId, ev) => {
    set((state) => {
      switch (ev.type) {
        case "session_ready":
          return { sessionId: ev.sessionId };
        case "turn_started": {
          const initialStatus: UiTurnStatus = ev.status === "queued" ? "queued" : "streaming";
          const turn = emptyTurn(ev.turnId, ev.prompt, initialStatus);
          const panes = state.panes.map((p) =>
            p.paneId === paneId && !p.turnIds.includes(ev.turnId)
              ? { ...p, turnIds: [...p.turnIds, ev.turnId] }
              : p,
          );
          return {
            turns: { ...state.turns, [ev.turnId]: turn },
            panes,
          };
        }
        case "turn_status": {
          const turn = state.turns[ev.turnId];
          if (!turn) return {};
          const next: UiTurnStatus =
            ev.status === "queued" || ev.status === "streaming" || ev.status === "done" || ev.status === "error"
              ? ev.status
              : "done";
          return { turns: { ...state.turns, [ev.turnId]: { ...turn, status: next } } };
        }
        case "text_delta": {
          const turn = state.turns[ev.turnId];
          if (!turn) return {};
          return { turns: { ...state.turns, [ev.turnId]: { ...turn, text: turn.text + ev.text } } };
        }
        case "assistant_message": {
          const turn = state.turns[ev.turnId];
          if (!turn) return {};
          // Only fill if no streaming text accumulated (defensive).
          if (turn.text.length > 0) return {};
          return { turns: { ...state.turns, [ev.turnId]: { ...turn, text: ev.text } } };
        }
        case "tool_use_start": {
          const turn = state.turns[ev.turnId];
          if (!turn) return {};
          return {
            turns: {
              ...state.turns,
              [ev.turnId]: {
                ...turn,
                toolCalls: [
                  ...turn.toolCalls,
                  { toolName: ev.toolName, toolUseId: ev.toolUseId, partialJson: "", blockIndex: ev.blockIndex },
                ],
              },
            },
          };
        }
        case "tool_use_input_delta": {
          const turn = state.turns[ev.turnId];
          if (!turn) return {};
          const toolCalls = turn.toolCalls.map((tc) =>
            tc.blockIndex === ev.blockIndex ? { ...tc, partialJson: tc.partialJson + ev.partialJson } : tc,
          );
          return { turns: { ...state.turns, [ev.turnId]: { ...turn, toolCalls } } };
        }
        case "done": {
          const turn = state.turns[ev.turnId];
          if (!turn) return {};
          return {
            turns: {
              ...state.turns,
              [ev.turnId]: { ...turn, status: "done", text: turn.text.length > 0 ? turn.text : ev.result },
            },
          };
        }
        case "error": {
          if (!ev.turnId) return { error: ev.message };
          const turn = state.turns[ev.turnId];
          if (!turn) return { error: ev.message };
          return { turns: { ...state.turns, [ev.turnId]: { ...turn, status: "error" } }, error: ev.message };
        }
        default:
          return {};
      }
    });
  },

  registerPane: (paneId) => {
    set((state) =>
      state.panes.some((p) => p.paneId === paneId)
        ? {}
        : { panes: [...state.panes, { paneId, turnIds: [] }] },
    );
  },

  bootstrapWithPrompt: async (prompt) => {
    const res = await fetch("/api/panes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const text = await res.text();
      set({ error: `bootstrap failed: ${text}` });
      return null;
    }
    const data = (await res.json()) as { paneId: string };
    get().registerPane(data.paneId);
    return data.paneId;
  },

  sendInline: async (paneId, prompt) => {
    const res = await fetch(`/api/panes/${paneId}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const text = await res.text();
      set({ error: `send failed: ${text}` });
    }
  },

  continueInNewColumn: async (srcPaneId, prompt) => {
    const res = await fetch(`/api/panes/${srcPaneId}/continue-in-new-column`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) {
      const text = await res.text();
      set({ error: `new column failed: ${text}` });
      return null;
    }
    const data = (await res.json()) as { paneId: string };
    get().registerPane(data.paneId);
    return data.paneId;
  },

  closePane: async (paneId) => {
    await fetch(`/api/panes/${paneId}`, { method: "DELETE" });
    set((state) => ({
      panes: state.panes.filter((p) => p.paneId !== paneId),
    }));
  },

  setError: (msg) => set({ error: msg }),

  newConversation: async () => {
    const res = await fetch("/api/conversation/new", { method: "POST" });
    if (!res.ok) {
      set({ error: `new conversation failed: ${await res.text()}` });
      return;
    }
    set({ sessionId: null, panes: [], turns: {}, error: null });
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
    set({ sessionId: null, panes: [], turns: {}, error: null });
    await get().hydrate();
  },
}));

export async function fetchHistory(): Promise<HistoryEntry[]> {
  const res = await fetch("/api/history");
  if (!res.ok) return [];
  return (await res.json()) as HistoryEntry[];
}
