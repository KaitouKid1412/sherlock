import { useEffect, useState } from "react";
import { fetchHistory, usePanes, type HistoryEntry } from "../state/panes.ts";
import { useConfirm } from "../state/confirm.ts";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ms).toLocaleDateString();
}

type UpdateState = "idle" | "updating" | "updated";
interface UpdateStatus {
  state: UpdateState;
  at?: number;
  head?: string;
}

function formatTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

const UPDATED_FRESH_WINDOW_MS = 30_000;

export function HistorySidebar({ collapsed, onToggle }: Props) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ state: "idle" });
  const [now, setNow] = useState<number>(Date.now());
  const currentSessionId = usePanes((s) => s.sessionId);
  const panes = usePanes((s) => s.panes);
  const loadHistorySession = usePanes((s) => s.loadHistorySession);
  const newConversation = usePanes((s) => s.newConversation);
  const ask = useConfirm((s) => s.ask);

  useEffect(() => {
    if (collapsed) return;
    void fetchHistory().then(setEntries);
  }, [collapsed, currentSessionId]);

  // Poll update status so the sidebar reflects when the launcher's
  // background self-update is in flight or has just finished.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/update-status");
        if (!res.ok) return;
        const data = (await res.json()) as UpdateStatus;
        if (!cancelled) setUpdateStatus(data);
      } catch {
        /* ignore — server may be momentarily unreachable */
      }
    };
    void tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Keep `now` ticking so the "fresh" → "old" visual transition happens on time
  // without waiting for the next poll. 1Hz is plenty for the 30s window.
  useEffect(() => {
    if (!updateStatus.at) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [updateStatus.at]);

  const handleLoad = async (sessionId: string) => {
    if (sessionId === currentSessionId) return;
    setLoadingId(sessionId);
    await loadHistorySession(sessionId);
    setLoadingId(null);
  };

  const newConversationDisabled = panes.length === 0;
  const handleNew = () => {
    if (newConversationDisabled) return;
    ask({
      message:
        "Start a new conversation? The current one stays saved on disk and you can reopen it from History.",
      confirmLabel: "New conversation",
      onConfirm: async () => {
        await newConversation();
      },
    });
  };

  if (collapsed) {
    return (
      <div className="history-sidebar collapsed">
        <button
          className="sidebar-icon-btn"
          onClick={onToggle}
          title="Show history"
          aria-label="Show history"
        >
          ›
        </button>
        <button
          className="sidebar-icon-btn"
          onClick={handleNew}
          disabled={newConversationDisabled}
          title="New conversation"
          aria-label="New conversation"
        >
          +
        </button>
      </div>
    );
  }

  return (
    <div className="history-sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-row">
          <span className="sidebar-brand-name">Sherlock</span>
          <button
            className="sidebar-icon-btn"
            onClick={onToggle}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            ‹
          </button>
        </div>
        {updateStatus.state === "updating" ? (
          <span
            className="sidebar-update-status sidebar-update-status--updating"
            title="Sherlock is pulling the latest release in the background"
          >
            <span className="sidebar-update-dot" aria-hidden /> Updating…
          </span>
        ) : updateStatus.state === "updated" && updateStatus.at ? (
          <span
            className={
              "sidebar-update-status " +
              (now - updateStatus.at * 1000 < UPDATED_FRESH_WINDOW_MS
                ? "sidebar-update-status--fresh"
                : "sidebar-update-status--old")
            }
            title={`Last applied: ${new Date(updateStatus.at * 1000).toLocaleString()}${updateStatus.head ? ` (${updateStatus.head.slice(0, 7)})` : ""}`}
          >
            ✓ Updated at {formatTime(updateStatus.at)}
          </span>
        ) : null}
        {currentSessionId ? (
          <span className="sidebar-brand-session" title={currentSessionId}>
            session {currentSessionId.slice(0, 8)}
          </span>
        ) : null}
        <button
          className="sidebar-new-btn"
          onClick={handleNew}
          disabled={newConversationDisabled}
        >
          + New conversation
        </button>
      </div>
      <div className="sidebar-section-label">History</div>
      {entries === null ? (
        <div className="history-empty">Loading…</div>
      ) : entries.length === 0 ? (
        <div className="history-empty">No previous conversations.</div>
      ) : (
        <ul className="history-list">
          {entries.map((e) => {
            const isCurrent = e.sessionId === currentSessionId;
            return (
              <li key={e.sessionId}>
                <button
                  className={`history-item${isCurrent ? " is-current" : ""}`}
                  onClick={() => handleLoad(e.sessionId)}
                  disabled={loadingId !== null || isCurrent}
                  aria-current={isCurrent ? "true" : undefined}
                >
                  {isCurrent ? <span className="history-item-active-dot" aria-hidden /> : null}
                  <div className="history-item-title">{e.title}</div>
                  <div className="history-item-meta">
                    {isCurrent ? <span className="history-item-current-tag">current</span> : null}
                    <span>{e.turnCount} turn{e.turnCount === 1 ? "" : "s"}</span>
                    <span>·</span>
                    <span>{formatRelative(e.lastModifiedAt)}</span>
                    <span className="history-item-id">{e.sessionId.slice(0, 8)}</span>
                  </div>
                  {loadingId === e.sessionId ? <div className="history-item-loading">Loading…</div> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
