import { type KeyboardEvent } from "react";

interface Props {
  // Send the draft. `forceNewPane` is true when the user explicitly asked
  // to open the response in a new pane (shift-modifier); otherwise the
  // caller's auto-mode picks the right placement.
  onSend: (forceNewPane: boolean) => void | Promise<void>;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  // The welcome composer has no parent pane yet, so the new-pane override
  // doesn't apply — hide it.
  hideNewPaneButton?: boolean;
}

export function InputBar({ onSend, placeholder, value, onChange, disabled, hideNewPaneButton }: Props) {
  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (disabled) return;
      onSend(e.shiftKey);
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
          onClick={() => onSend(false)}
          title="Send. First follow-up collapses this column; a sibling branch opens in a new column."
        >
          Send
        </button>
        {hideNewPaneButton ? null : (
          <button
            disabled={disabled || empty}
            onClick={() => onSend(true)}
            title="Force the response into a new column even if it's the first follow-up"
          >
            Send → new pane
          </button>
        )}
      </div>
      <div className="hint">
        {hideNewPaneButton
          ? "⌘↵ Send"
          : "⌘↵ Send (auto) · ⌘⇧↵ Send → new pane"}
      </div>
    </div>
  );
}
