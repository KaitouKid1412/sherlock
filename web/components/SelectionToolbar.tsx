import { useEffect, useState } from "react";
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
    top: rect.top - 44,
    left: rect.left + rect.width / 2,
  };
}

function buildPrompt(quote: string): string {
  const truncated = quote.length > 1500 ? quote.slice(0, 1500) + "…" : quote;
  const quoted = truncated.split("\n").map((l) => "> " + l).join("\n");
  return `Please explain the following passage from your earlier response in much more depth. Unpack the underlying mechanism, edge cases, and any prerequisites I would need to understand it. Here is the passage I selected:\n\n${quoted}`;
}

export function SelectionToolbar() {
  const [info, setInfo] = useState<SelectionInfo | null>(null);
  const continueInNewColumn = usePanes((s) => s.continueInNewColumn);

  useEffect(() => {
    let pending = 0;
    const onSelectionChange = () => {
      // Debounce: only act after the selection settles (avoid flicker while dragging).
      window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        setInfo(readCurrentSelection());
      }, 80);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      window.clearTimeout(pending);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, []);

  if (!info) return null;

  // Clamp horizontal position so the button doesn't overflow viewport.
  const halfWidth = 130;
  const clampedLeft = Math.max(halfWidth + 8, Math.min(window.innerWidth - halfWidth - 8, info.left));
  const top = Math.max(12, info.top);

  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    const captured = info;
    setInfo(null);
    window.getSelection()?.removeAllRanges();
    await continueInNewColumn(captured.paneId, buildPrompt(captured.text));
  };

  return (
    <div
      className="selection-toolbar"
      style={{ position: "fixed", top, left: clampedLeft, transform: "translateX(-50%)" }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <button onClick={handleClick}>Explain selected in new column</button>
    </div>
  );
}
