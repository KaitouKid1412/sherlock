import { type KeyboardEvent } from "react";
import type { OpenMode } from "../state/panes.ts";

interface Props {
  // Primary action: spawn the response in a new column to the right.
  onSend: (mode: OpenMode) => void | Promise<void>;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  // When true (the initial-conversation composer in the welcome screen),
  // there's no "current pane" yet so the "send here" option doesn't apply.
  hideHereButton?: boolean;
}

export function InputBar({ onSend, placeholder, value, onChange, disabled, hideHereButton }: Props) {
  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (disabled) return;
      // ⌘⇧↵ collapses the current pane; plain ⌘↵ spawns a new pane.
      onSend(e.shiftKey ? "here" : "new-pane");
    }
  };
  const empty = value.trim().length === 0;
  return (
    <div className="input-bar">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        placeholder={placeholder ?? "Ask anything…"}
        disabled={disabled}
      />
      <div className="row">
        <button
          className="primary"
          disabled={disabled || empty}
          onClick={() => onSend("new-pane")}
          title="Open the response in a new column (keeps this one in view)"
        >
          Send → new pane
        </button>
        {hideHereButton ? null : (
          <button
            disabled={disabled || empty}
            onClick={() => onSend("here")}
            title="Collapse this column and open the response here"
          >
            ↳ Send here
          </button>
        )}
      </div>
      <div className="hint">
        {hideHereButton
          ? "⌘↵ Send"
          : "⌘↵ New pane · ⌘⇧↵ Send here"}
      </div>
    </div>
  );
}
