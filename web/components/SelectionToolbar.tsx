import { useEffect, useRef, useState } from "react";
import { usePanes } from "../state/panes.ts";

interface SelectionInfo {
  text: string;
  paneId: string;
  top: number;
  left: number;
}

function readCurrentSelection(): SelectionInfo | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const text = sel.toString().trim();
  if (text.length < 2) return null;
  const anchor = sel.anchorNode;
  if (!anchor) return null;
  const el =
    anchor.nodeType === Node.TEXT_NODE
      ? (anchor.parentElement as HTMLElement | null)
      : (anchor as HTMLElement);
  if (!el) return null;
  if (!el.closest(".transcript")) return null;
  const paneEl = el.closest("[data-pane-id]") as HTMLElement | null;
  const paneId = paneEl?.dataset.paneId;
  if (!paneId) return null;
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    text,
    paneId,
    top: rect.bottom + 8,
    left: rect.left + rect.width / 2,
  };
}

function buildPrompt(quote: string, userQuestion: string): string {
  const truncated = quote.length > 1500 ? quote.slice(0, 1500) + "…" : quote;
  const quoted = truncated.split("\n").map((l) => "> " + l).join("\n");
  return `Regarding this passage from your earlier response:\n\n${quoted}\n\n${userQuestion}`;
}

type Mode = "idle" | "toolbar" | "composer";

export function SelectionToolbar() {
  const [mode, setMode] = useState<Mode>("idle");
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const [draft, setDraft] = useState("");
  const sendInPane = usePanes((s) => s.sendInPane);
  const panes = usePanes((s) => s.panes);
  const composerRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // While the selection lives, show the toolbar pip. Once user clicks "Ask
  // about this…" we switch to the composer mode and stop tracking selection
  // changes (so the user can deselect to type without the toolbar disappearing).
  useEffect(() => {
    if (mode === "composer") return;
    let pending = 0;
    const onSelectionChange = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        const next = readCurrentSelection();
        if (next) {
          setInfo(next);
          setMode("toolbar");
        } else {
          setInfo(null);
          setMode("idle");
        }
      }, 80);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      window.clearTimeout(pending);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [mode]);

  // Esc to cancel the composer; click outside also cancels.
  useEffect(() => {
    if (mode !== "composer") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMode("idle");
        setInfo(null);
        setDraft("");
      }
    };
    const onClick = (e: MouseEvent) => {
      if (composerRef.current && !composerRef.current.contains(e.target as Node)) {
        setMode("idle");
        setInfo(null);
        setDraft("");
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    setTimeout(() => textareaRef.current?.focus(), 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [mode]);

  if (mode === "idle" || !info) return null;

  if (mode === "toolbar") {
    const halfWidth = 110;
    const clampedLeft = Math.max(halfWidth + 8, Math.min(window.innerWidth - halfWidth - 8, info.left));
    const top = Math.max(12, info.top);
    return (
      <div
        className="selection-toolbar"
        style={{ position: "fixed", top, left: clampedLeft, transform: "translateX(-50%)" }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <button
          onClick={(e) => {
            e.preventDefault();
            // Capture selection rect snapshot so the composer doesn't move
            // when the user later clicks (which deselects).
            setMode("composer");
          }}
        >
          Ask about this…
        </button>
      </div>
    );
  }

  // composer mode
  const halfWidth = 190;
  const clampedLeft = Math.max(halfWidth + 8, Math.min(window.innerWidth - halfWidth - 8, info.left));
  const top = Math.max(12, info.top);
  const pane = panes.find((p) => p.paneId === info.paneId) ?? panes[0];

  const handleSubmit = async () => {
    const userQ = draft.trim();
    if (!userQ || !pane) return;
    const finalPrompt = buildPrompt(info.text, userQ);
    setMode("idle");
    setInfo(null);
    setDraft("");
    window.getSelection()?.removeAllRanges();
    // sendInPane uses the pane's currentNodeId as the parent — exactly
    // what we want: the new child node hangs off the response the user
    // was reading. Default to "new-pane" so the explanation opens beside
    // the source response instead of replacing it.
    await sendInPane(pane.paneId, finalPrompt, "new-pane", pane.currentNodeId ?? undefined);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div
      ref={composerRef}
      className="explain-composer"
      style={{ position: "fixed", top, left: clampedLeft, transform: "translateX(-50%)" }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="explain-composer-quote" title={info.text}>{info.text}</div>
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKey}
        placeholder="What would you like to ask about this passage?"
      />
      <div className="explain-composer-row">
        <button onClick={() => { setMode("idle"); setInfo(null); setDraft(""); }}>Cancel</button>
        <button
          className="primary"
          disabled={draft.trim().length === 0}
          onClick={handleSubmit}
        >
          Ask ⌘↵
        </button>
      </div>
    </div>
  );
}
