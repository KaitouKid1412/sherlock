import { create } from "zustand";

interface ConfirmState {
  open: boolean;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void | Promise<void>;
  ask: (opts: {
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void | Promise<void>;
  }) => void;
  close: () => void;
}

export const useConfirm = create<ConfirmState>((set) => ({
  open: false,
  message: "",
  confirmLabel: "OK",
  cancelLabel: "Cancel",
  onConfirm: () => {},
  ask: ({ message, confirmLabel = "OK", cancelLabel = "Cancel", onConfirm }) =>
    set({ open: true, message, confirmLabel, cancelLabel, onConfirm }),
  close: () => set({ open: false }),
}));
