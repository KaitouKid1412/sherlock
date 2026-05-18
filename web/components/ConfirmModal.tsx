import { useEffect, useRef } from "react";
import { useConfirm } from "../state/confirm.ts";

export function ConfirmModal() {
  const { open, message, confirmLabel, cancelLabel, onConfirm, close } = useConfirm();
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      if (e.key === "Enter") {
        e.preventDefault();
        confirmRef.current?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const handleConfirm = async () => {
    const fn = onConfirm;
    close();
    await fn();
  };

  return (
    <div className="modal-scrim" onClick={close}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">Sherlock says</div>
        <div className="modal-body">{message}</div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={close}>{cancelLabel}</button>
          <button ref={confirmRef} className="modal-btn primary" onClick={handleConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
