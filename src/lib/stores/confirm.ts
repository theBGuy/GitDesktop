import type { ReactNode } from "react";
import { create } from "zustand";

/** What every prompt asks. `checkboxLabel` opts into the extra tick-box slot. */
interface ConfirmOptions {
  title: ReactNode;
  body: ReactNode;
  confirmLabel: ReactNode;
  confirmVariant?: "default" | "destructive";
}

interface CheckedConfirmOptions extends ConfirmOptions {
  /** Renders an opt-in checkbox under the body; its state rides the answer. */
  checkboxLabel: ReactNode;
  checkboxInitial?: boolean;
}

/** A confirmed answer plus the checkbox state at the moment it was given
 *  (`false` for a prompt with no checkbox). */
export interface ConfirmAnswer {
  ok: boolean;
  checked: boolean;
}

/** A pending confirmation request awaiting the user's Cancel/Confirm. An
 *  `undefined` `checkboxLabel` is what tells the host to render no checkbox. */
export interface ConfirmRequest {
  title: ReactNode;
  body: ReactNode;
  confirmLabel: ReactNode;
  confirmVariant: "default" | "destructive";
  checkboxLabel: ReactNode | undefined;
  checkboxInitial?: boolean;
  /** Settles the `ask`/`askChecked` promise: `ok` = confirmed, else cancelled. */
  resolve: (ok: boolean, checked: boolean) => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  /** Open the confirm dialog and resolve when the user answers. Called from
   *  non-JSX code (hooks, event handlers) that can't render a dialog itself. */
  ask: (opts: ConfirmOptions) => Promise<boolean>;
  /** {@link ask} with an opt-in checkbox (e.g. "also delete the cached data"),
   *  resolving the answer and the box's final state together. */
  askChecked: (opts: CheckedConfirmOptions) => Promise<ConfirmAnswer>;
  /** Answer the current request (host-only); a no-op if none is pending. */
  answer: (ok: boolean, checked?: boolean) => void;
}

/**
 * A promise-based confirmation prompt for code that has no JSX of its own (shared
 * hooks, imperative handlers). Call `useConfirm.getState().ask({...})` and await
 * the boolean; a single {@link ConfirmDialogHost} mounted at the app root renders
 * the actual dialog. Only one request is live at a time — asking again while one
 * is pending cancels (resolves `false`) the previous one.
 */
export const useConfirm = create<ConfirmState>()((set, get) => {
  const open = (
    opts: ConfirmOptions & Partial<CheckedConfirmOptions>,
  ): Promise<ConfirmAnswer> => {
    // A new ask supersedes any in-flight one — cancel the old so its awaiter
    // doesn't hang forever.
    get().request?.resolve(false, false);
    return new Promise<ConfirmAnswer>((resolve) => {
      set({
        request: {
          confirmVariant: "default",
          checkboxLabel: undefined,
          ...opts,
          resolve: (ok, checked) => {
            set({ request: null });
            resolve({ ok, checked });
          },
        },
      });
    });
  };

  return {
    request: null,
    ask: (opts) => open(opts).then((a) => a.ok),
    askChecked: open,
    answer: (ok, checked = false) => get().request?.resolve(ok, checked),
  };
});
