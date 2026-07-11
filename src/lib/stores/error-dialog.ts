import { create } from "zustand";
import type { ErrorPresentation } from "@/lib/error-summary";

/**
 * Drives the globally-mounted ErrorDialog. A long error toast opens this with
 * its presentation; the dialog shows the full raw text with Copy. Session-only,
 * not persisted — only one error dialog is ever open at a time.
 */
interface ErrorDialogState {
  /** The error currently shown in the dialog, or null when closed. */
  presentation: ErrorPresentation | null;
  /** Open the dialog on an error's presentation (the toast's "Details" action). */
  open: (presentation: ErrorPresentation) => void;
  /** Close the dialog (Close button / Esc / backdrop). */
  close: () => void;
}

export const useErrorDialog = create<ErrorDialogState>()((set) => ({
  presentation: null,
  open: (presentation) => set({ presentation }),
  close: () => set({ presentation: null }),
}));
