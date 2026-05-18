import { useEffect, useRef, useState } from "react";
import { usePanes, type UiTurn } from "../state/panes.ts";
import { openPaneStream } from "../lib/sse-client.ts";
import { MarkdownMessage } from "./MarkdownMessage.tsx";
import { InputBar } from "./InputBar.tsx";
import { ToolUseCard } from "./ToolUseCard.tsx";

interface Props {
  paneId: string;
  isRightmost: boolean;
}

export function PaneView({ paneId, isRightmost }: Props) {
  const pane = usePanes((s) => s.panes.find((p) => p.paneId === paneId));
  const turns = usePanes((s) => s.turns);
  const applyEvent = usePanes((s) => s.applyEvent);
  const sendInline = usePanes((s) => s.sendInline);
  const continueInNewColumn = usePanes((s) => s.continueInNewColumn);
  const closePane = usePanes((s) => s.closePane);
  const sessionId = usePanes((s) => s.sessionId);
  const [draft, setDraft] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Open SSE for this pane once.
  useEffect(() => {
    const close = openPaneStream(paneId, (ev) => applyEvent(paneId, ev));
    return () => close();
  }, [paneId, applyEvent]);

  // Autoscroll
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  });

  if (!pane) return null;

  const isStreaming = pane.turnIds.some((id) => turns[id]?.status === "streaming");
  const firstTurn = pane.turnIds.length > 0 ? turns[pane.turnIds[0]!] : undefined;
  const pinnedTitle = firstTurn?.prompt ?? "";

  const handleSend = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    setDraft("");
    await sendInline(paneId, prompt);
  };

  const handleNewColumn = async () => {
    const prompt = draft.trim();
    if (!prompt) return;
    setDraft("");
    await continueInNewColumn(paneId, prompt);
  };

  const paneClass = `pane${isRightmost ? " is-rightmost" : ""}`;
  return (
    <div className={paneClass} ref={containerRef} data-pane-id={paneId}>
      <div className="pane-header">
        <div className="pane-header-row">
          <div>
            {isStreaming ? <span className="streaming" /> : null}
            <span className="session">
              {sessionId ? `session ${sessionId.slice(0, 8)}` : "no session yet"}
            </span>
          </div>
          <button className="close" onClick={() => closePane(paneId)} title="Close pane">×</button>
        </div>
        {pinnedTitle.length > 0 ? (
          <div className="pane-pinned-question" title={pinnedTitle}>{pinnedTitle}</div>
        ) : null}
      </div>
      <div className="transcript" ref={transcriptRef}>
        {pane.turnIds.length === 0 ? (
          <div className="empty-state">Ask anything to start.</div>
        ) : (
          pane.turnIds.map((id, idx) => {
            const t = turns[id];
            if (!t) return null;
            return <Turn key={id} turn={t} hidePrompt={idx === 0} />;
          })
        )}
      </div>
      <InputBar
        showInlineButton={isRightmost}
        value={draft}
        onChange={setDraft}
        onSend={handleSend}
        onSendInNewColumn={handleNewColumn}
      />
    </div>
  );
}

function Turn({ turn, hidePrompt }: { turn: UiTurn; hidePrompt?: boolean }) {
  return (
    <div className="turn">
      {hidePrompt ? null : <div className="turn-prompt">{turn.prompt}</div>}
      {turn.toolCalls.length > 0 ? (
        <div className="tool-list">
          {turn.toolCalls.map((tc, i) => (
            <ToolUseCard key={`${tc.toolUseId || "tc"}-${tc.blockIndex}-${i}`} call={tc} />
          ))}
        </div>
      ) : null}
      <div className={`turn-answer${turn.status === "streaming" ? " streaming" : ""}`}>
        {turn.text.length > 0 ? (
          <MarkdownMessage text={turn.text} />
        ) : turn.status === "queued" ? (
          <span style={{ color: "var(--text-dim)" }}>queued — will start when previous turn finishes</span>
        ) : (
          <span style={{ color: "var(--text-dim)" }}>…</span>
        )}
      </div>
    </div>
  );
}
