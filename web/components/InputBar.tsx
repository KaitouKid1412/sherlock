import { useState, type KeyboardEvent } from "react";

interface Props {
  showInlineButton: boolean;
  onSend: () => void | Promise<void>;
  onSendInNewColumn: () => void | Promise<void>;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
}

export function InputBar({
  showInlineButton,
  onSend,
  onSendInNewColumn,
  placeholder,
  value,
  onChange,
}: Props) {
  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (e.shiftKey || !showInlineButton) {
        onSendInNewColumn();
      } else {
        onSend();
      }
    }
  };
  return (
    <div className="input-bar">
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKey}
        placeholder={placeholder ?? "Ask anything…"}
      />
      <div className="row">
        {showInlineButton ? (
          <button
            className="primary"
            disabled={value.trim().length === 0}
            onClick={() => onSend()}
          >
            Send
          </button>
        ) : null}
        <button
          className={showInlineButton ? "" : "primary"}
          disabled={value.trim().length === 0}
          onClick={() => onSendInNewColumn()}
        >
          Continue in new column
        </button>
      </div>
      <div className="hint">
        {showInlineButton
          ? "⌘↵ Send · ⌘⇧↵ New column"
          : "⌘↵ New column"}
      </div>
    </div>
  );
}
