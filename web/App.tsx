import { useEffect, useMemo, useState } from "react";
import { usePanes, type UiPane } from "./state/panes.ts";
import { PaneColumn } from "./components/PaneColumn.tsx";
import { InputBar } from "./components/InputBar.tsx";
import { SelectionToolbar } from "./components/SelectionToolbar.tsx";
import { ErrorToast } from "./components/ErrorToast.tsx";
import { HistorySidebar } from "./components/HistorySidebar.tsx";
import { ConfirmModal } from "./components/ConfirmModal.tsx";

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
  const hydrate = usePanes((s) => s.hydrate);
  const bootstrapWithPrompt = usePanes((s) => s.bootstrapWithPrompt);
  const [draft, setDraft] = useState("");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const beat = () => {
      fetch("/api/heartbeat", { method: "POST", keepalive: true }).catch(() => {});
    };
    beat();
    const id = window.setInterval(beat, 10_000);
    // After laptop wake / tab focus, fire an immediate heartbeat so the server
    // sees us alive within ~ms instead of waiting up to 10s for the next tick.
    // Pairs with the server-side time-jump detection.
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

  const handleBootstrap = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    setDraft("");
    await bootstrapWithPrompt(prompt);
  };

  return (
    <div className="root">
      <HistorySidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
      />
      {panes.length === 0 ? (
        <div className="app">
          <div className="pane is-rightmost" style={{ flex: "1 1 100%" }}>
            <div className="pane-header">
              <div className="pane-header-row">
                <span className="session">Start a conversation</span>
              </div>
            </div>
            <div className="empty-state">What would you like to research?</div>
            <InputBar
              showInlineButton={true}
              value={draft}
              onChange={setDraft}
              onSend={handleBootstrap}
              onSendInNewColumn={handleBootstrap}
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
