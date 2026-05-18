import { useEffect, useMemo, useState } from "react";
import { usePanes, type UiPane } from "./state/panes.ts";
import { PaneColumn } from "./components/PaneColumn.tsx";
import { InputBar } from "./components/InputBar.tsx";
import { SelectionToolbar } from "./components/SelectionToolbar.tsx";
import { ErrorToast } from "./components/ErrorToast.tsx";
import { HistorySidebar } from "./components/HistorySidebar.tsx";
import { ConfirmModal } from "./components/ConfirmModal.tsx";
import { openConversationStream } from "./lib/sse-client.ts";

const SEED_COLUMN_WIDTH = 620;
const STACKED_COLUMN_WIDTH = 480;
const SIDEBAR_STORAGE_KEY = "sherlock.sidebar.collapsed";

function groupIntoColumns(panes: UiPane[]): UiPane[][] {
  if (panes.length === 0) return [];
  const cols: UiPane[][] = [[panes[0]!]];
  for (let i = 1; i < panes.length; i++) {
    const colIdx = Math.floor((i - 1) / 2) + 1;
    if (!cols[colIdx]) cols[colIdx] = [];
    cols[colIdx]!.push(panes[i]!);
  }
  return cols;
}

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function App() {
  const panes = usePanes((s) => s.panes);
  const tree = usePanes((s) => s.tree);
  const hydrate = usePanes((s) => s.hydrate);
  const applyEvent = usePanes((s) => s.applyEvent);
  const startConversation = usePanes((s) => s.startConversation);
  const [draft, setDraft] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // Single conversation-wide SSE channel. Every pane reads from the shared
  // Zustand state that this listener feeds, so each event is applied exactly
  // once regardless of how many panes are open.
  useEffect(() => {
    const close = openConversationStream((ev) => applyEvent("", ev));
    return () => close();
  }, [applyEvent]);

  useEffect(() => {
    const beat = () => {
      fetch("/api/heartbeat", { method: "POST", keepalive: true }).catch(() => {});
    };
    beat();
    const id = window.setInterval(beat, 10_000);
    const onVisible = () => { if (!document.hidden) beat(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [sidebarCollapsed]);

  const columns = useMemo(() => groupIntoColumns(panes), [panes]);
  const rightmostPaneId = panes[panes.length - 1]?.paneId ?? "";

  const handleStart = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    setDraft("");
    await startConversation(prompt);
  };

  // The InputBar in the welcome screen is mode-agnostic — there's no pane
  // to open here vs new-pane against. Just start the conversation.
  const handleWelcomeSend = (_forceNewPane: boolean) => handleStart();

  // Empty state: no conversation loaded at all. Show the welcome composer.
  const noConversation = !tree || panes.length === 0;

  return (
    <div className="root">
      <HistorySidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
      />
      {noConversation ? (
        <div className="app">
          <div className="pane is-rightmost" style={{ flex: "1 1 100%" }}>
            <div className="pane-header">
              <div className="pane-header-row">
                <span className="session">Start a conversation</span>
              </div>
            </div>
            <div className="empty-state">What would you like to research?</div>
            <InputBar
              value={draft}
              onChange={setDraft}
              onSend={handleWelcomeSend}
              hideNewPaneButton={true}
            />
          </div>
        </div>
      ) : (
        <div className="app">
          {columns.map((col, ci) => {
            const isLast = ci === columns.length - 1;
            const isSeed = ci === 0;
            return (
              <PaneColumn
                key={col[0]!.paneId}
                panes={col}
                defaultWidth={isSeed ? SEED_COLUMN_WIDTH : STACKED_COLUMN_WIDTH}
                isLastColumn={isLast}
                rightmostPaneId={rightmostPaneId}
              />
            );
          })}
        </div>
      )}
      <SelectionToolbar />
      <ErrorToast />
      <ConfirmModal />
    </div>
  );
}
