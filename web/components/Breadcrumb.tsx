import type { TreeNodePublic } from "../../types/events.ts";

interface Props {
  ancestors: TreeNodePublic[];   // root → ... → parent-of-current (current excluded)
  onNavigate: (nodeId: string) => void;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + "…";
}

export function Breadcrumb({ ancestors, onNavigate }: Props) {
  if (ancestors.length === 0) return null;
  return (
    <div className="breadcrumb">
      {ancestors.map((a, idx) => (
        <button
          key={a.nodeId}
          className="breadcrumb-item"
          onClick={() => onNavigate(a.nodeId)}
          title={a.prompt}
        >
          <span className="breadcrumb-depth">{idx === 0 ? "↑ Root" : `↑ Depth ${idx + 1}`}</span>
          <span className="breadcrumb-prompt">{truncate(a.prompt, 90)}</span>
        </button>
      ))}
    </div>
  );
}
