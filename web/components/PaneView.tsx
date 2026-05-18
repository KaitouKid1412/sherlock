import { useEffect, useRef, useState } from "react";
import {
  usePanes, selectPath, selectChildren, type UiToolCall, type OpenMode,
} from "../state/panes.ts";
import { openPaneStream } from "../lib/sse-client.ts";
import { MarkdownMessage } from "./MarkdownMessage.tsx";
import { InputBar } from "./InputBar.tsx";
import { ToolUseCard } from "./ToolUseCard.tsx";
import { BranchButtons } from "./BranchButtons.tsx";
import { Breadcrumb } from "./Breadcrumb.tsx";
import type { TreeNodePublic } from "../../types/events.ts";

interface Props {
  paneId: string;
  isRightmost: boolean;
}

export function PaneView({ paneId }: Props) {
  const pane = usePanes((s) => s.panes.find((p) => p.paneId === paneId));
  const tree = usePanes((s) => s.tree);
  const nodeToolCalls = usePanes((s) => s.nodeToolCalls);
  const applyEvent = usePanes((s) => s.applyEvent);
  const sendInPane = usePanes((s) => s.sendInPane);
  const openBranch = usePanes((s) => s.openBranch);
  const navigatePane = usePanes((s) => s.navigatePane);
  const closePane = usePanes((s) => s.closePane);
  const deleteNode = usePanes((s) => s.deleteNode);
  const rootSessionId = usePanes((s) => s.rootSessionId);
  const [draft, setDraft] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const close = openPaneStream(paneId, (ev) => applyEvent(paneId, ev));
    return () => close();
  }, [paneId, applyEvent]);

  // Autoscroll: stay glued to the bottom while a turn streams or a new node opens.
  const path = pane ? selectPath(tree, pane.currentNodeId) : [];
  const currentNode = path.length > 0 ? path[path.length - 1] : undefined;
  const streamingText = currentNode?.text ?? "";
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (isNearBottom) el.scrollTop = el.scrollHeight;
  }, [streamingText, currentNode?.nodeId]);

  if (!pane) return null;

  if (!currentNode) {
    return (
      <div className="pane is-rightmost" ref={containerRef} data-pane-id={paneId}>
        <div className="pane-header">
          <div className="pane-header-row">
            <span className="session">no conversation loaded</span>
            <button className="close" onClick={() => closePane(paneId)} title="Close pane">×</button>
          </div>
        </div>
        <div className="empty-state">Ask anything to start.</div>
      </div>
    );
  }

  const children = selectChildren(tree, currentNode.nodeId);
  const ancestors = path.slice(0, -1);  // everything above the current node
  const isStreaming = currentNode.status === "streaming" || currentNode.status === "queued";

  // Auto-mode: if this would be the parent's FIRST child, drill into it
  // in the same pane (collapse the parent into a breadcrumb). If the parent
  // already has children, this new question creates a sibling branch — so
  // spawn a new pane to keep the existing branches visible.
  // Override (force new pane) via the InputBar's shift-modifier shortcut.
  const handleSend = async (forceNewPane: boolean) => {
    const prompt = draft.trim();
    if (!prompt) return;
    setDraft("");
    const siblingCount = children.length;
    const mode: OpenMode = forceNewPane || siblingCount > 0 ? "new-pane" : "here";
    await sendInPane(paneId, prompt, mode, currentNode.nodeId);
  };

  return (
    <div className="pane is-rightmost" ref={containerRef} data-pane-id={paneId}>
      <div className="pane-header">
        <div className="pane-header-row">
          <div>
            {isStreaming ? <span className="streaming" /> : null}
            <span className="session">
              {rootSessionId ? `conversation ${rootSessionId.slice(0, 8)}` : "no session"}
            </span>
          </div>
          <button className="close" onClick={() => closePane(paneId)} title="Close pane">×</button>
        </div>
      </div>
      <div className="transcript" ref={transcriptRef}>
        <Breadcrumb ancestors={ancestors} onNavigate={(id) => navigatePane(paneId, id)} />
        <NodeView
          node={currentNode}
          toolCalls={nodeToolCalls[currentNode.nodeId] ?? []}
          isRoot={ancestors.length === 0}
        />
        <BranchButtons
          children={children}
          onOpen={(id, mode) => openBranch(paneId, id, mode)}
          onDelete={(id) => deleteNode(id)}
        />
      </div>
      <InputBar
        value={draft}
        onChange={setDraft}
        onSend={handleSend}
        placeholder="Ask a follow-up — opens in a new column by default."
      />
    </div>
  );
}

function NodeView({ node, toolCalls, isRoot }: { node: TreeNodePublic; toolCalls: UiToolCall[]; isRoot: boolean }) {
  return (
    <div className="turn">
      {isRoot ? null : <div className="turn-prompt">{node.prompt}</div>}
      {toolCalls.length > 0 ? (
        <div className="tool-list">
          {toolCalls.map((tc, i) => (
            <ToolUseCard key={`${tc.toolUseId || "tc"}-${tc.blockIndex}-${i}`} call={tc} />
          ))}
        </div>
      ) : null}
      <div className={`turn-answer${node.status === "streaming" ? " streaming" : ""}`}>
        {node.text.length > 0 ? (
          <MarkdownMessage text={node.text} />
        ) : node.status === "queued" ? (
          <span style={{ color: "var(--text-dim)" }}>queued — will start when previous turn finishes</span>
        ) : (
          <span style={{ color: "var(--text-dim)" }}>…</span>
        )}
      </div>
    </div>
  );
}
