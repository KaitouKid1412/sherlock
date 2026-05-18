import { useState } from "react";
import type { UiToolCall } from "../state/panes.ts";

function tryParse(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function summarize(call: UiToolCall): string {
  const parsed = tryParse(call.partialJson);
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.query === "string") return obj.query;
    if (typeof obj.url === "string") return obj.url;
    if (typeof obj.prompt === "string") return obj.prompt;
  }
  if (call.partialJson) return call.partialJson.slice(0, 80) + (call.partialJson.length > 80 ? "…" : "");
  return "…";
}

const ICON: Record<string, string> = {
  WebSearch: "search",
  WebFetch: "fetch",
};

export function ToolUseCard({ call }: { call: UiToolCall }) {
  const [open, setOpen] = useState(false);
  const tag = ICON[call.toolName] ?? "tool";
  return (
    <div className="tool-card">
      <button className="tool-card-header" type="button" onClick={() => setOpen((v) => !v)}>
        <span className="tool-card-tag">{tag}</span>
        <span className="tool-card-name">{call.toolName}</span>
        <span className="tool-card-summary">{summarize(call)}</span>
        <span className="tool-card-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <pre className="tool-card-body">{call.partialJson || "(no input yet)"}</pre>
      ) : null}
    </div>
  );
}
