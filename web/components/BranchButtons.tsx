import type { TreeNodePublic } from "../../types/events.ts";
import type { OpenMode } from "../state/panes.ts";
import { useConfirm } from "../state/confirm.ts";

interface Props {
  children: TreeNodePublic[];
  // Opens an existing branch. Default click = "here"; the ↳ icon button and
  // shift-click both promote to "new-pane". Clicking on an existing branch
  // never auto-spawns a pane unless the user explicitly asks for it.
  onOpen: (nodeId: string, mode: OpenMode) => void;
  onDelete: (nodeId: string) => void;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

export function BranchButtons({ children, onOpen, onDelete }: Props) {
  const ask = useConfirm((s) => s.ask);
  if (children.length === 0) return null;
  const handleDelete = (node: TreeNodePublic) => {
    ask({
      message: `Delete this branch?\n\n"${truncate(node.prompt, 200)}"\n\nThis removes the question and any follow-ups beneath it. The conversation up to this point is unaffected.`,
      confirmLabel: "Delete branch",
      onConfirm: async () => {
        onDelete(node.nodeId);
      },
    });
  };
  return (
    <div className="branch-buttons">
      <div className="branch-buttons-label">
        {children.length === 1 ? "Follow-up" : `${children.length} follow-ups`}
      </div>
      {children.map((c) => (
        <div key={c.nodeId} className="branch-button-row">
          <button
            className="branch-button"
            title={c.prompt + "\n\nClick: open here (collapse this column)\nShift-click: open in new column"}
            onClick={(e) => onOpen(c.nodeId, e.shiftKey ? "new-pane" : "here")}
          >
            <span className="branch-button-arrow">→</span>
            <span className="branch-button-text">{truncate(c.prompt, 120)}</span>
          </button>
          <button
            className="branch-newpane"
            title="Open this branch in a new column"
            onClick={(e) => { e.stopPropagation(); onOpen(c.nodeId, "new-pane"); }}
            aria-label="Open in new column"
          >
            ⇲
          </button>
          <button
            className="branch-delete"
            title="Delete this branch and everything under it"
            onClick={(e) => { e.stopPropagation(); handleDelete(c); }}
            aria-label="Delete branch"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
