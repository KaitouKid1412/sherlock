import { type KeyboardEvent } from "react";

interface Props {
  onSend: () => void | Promise<void>;
  placeholder?: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}

export function InputBar({ onSend, placeholder, value, onChange, disabled }: Props) {
  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!disabled) onSend();
    }
  };
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
          disabled={disabled || value.trim().length === 0}
          onClick={() => onSend()}
        >
          Send
        </button>
      </div>
      <div className="hint">⌘↵ Send</div>
    </div>
  );
}
