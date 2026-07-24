import type { ReactNode } from "react";
import { create } from "zustand";

/** A pending confirmation request awaiting the user's Cancel/Confirm. */
interface ConfirmRequest {
  title: ReactNode;
  body: ReactNode;
  confirmLabel: ReactNode;
  confirmVariant: "default" | "destructive";
  /** Settles the `confirm()` promise: `true` = confirmed, `false` = cancelled. */
  resolve: (ok: boolean) => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  /** Open the confirm dialog and resolve when the user answers. Called from
   *  non-JSX code (hooks, event handlers) that can't render a dialog itself. */
  ask: (
    opts: Omit<ConfirmRequest, "resolve" | "confirmVariant"> & {
      confirmVariant?: "default" | "destructive";
    },
  ) => Promise<boolean>;
  /** Answer the current request (host-only); a no-op if none is pending. */
  answer: (ok: boolean) => void;
}

/**
 * A promise-based confirmation prompt for code that has no JSX of its own (shared
 * hooks, imperative handlers). Call `useConfirm.getState().ask({...})` and await
 * the boolean; a single {@link ConfirmDialogHost} mounted at the app root renders
 * the actual dialog. Only one request is live at a time — asking again while one
 * is pending cancels (resolves `false`) the previous one.
 */
export const useConfirm = create<ConfirmState>()((set, get) => ({
  request: null,
  ask: (opts) => {
    // A new ask supersedes any in-flight one — cancel the old so its awaiter
    // doesn't hang forever.
    get().request?.resolve(false);
    return new Promise<boolean>((resolve) => {
      set({
        request: {
          confirmVariant: "default",
          ...opts,
          resolve: (ok) => {
            set({ request: null });
            resolve(ok);
          },
        },
      });
    });
  },
  answer: (ok) => get().request?.resolve(ok),
}));
