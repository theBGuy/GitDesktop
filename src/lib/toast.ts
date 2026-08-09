import { toast } from "sonner";
import { type ErrorPresentation, presentError } from "@/lib/error-summary";
import { useErrorDialog } from "@/lib/stores/error-dialog";

/**
 * The toast action for a presented error: long errors (multi-line stderr, forge
 * dumps) get Details, which opens the ErrorDialog with the full raw text; short
 * ones get Copy, since the full text is one line by construction. Shared by
 * every surface that surfaces raw tool output, so the affordance can't drift.
 */
export function errorToastAction(presentation: ErrorPresentation) {
  return presentation.long
    ? {
        label: "Details",
        onClick: () => useErrorDialog.getState().open(presentation),
      }
    : {
        label: "Copy",
        onClick: () => {
          navigator.clipboard.writeText(presentation.fullText).catch(() => {
            // clipboard denied — nothing useful to do
          });
        },
      };
}

/** Error toast — calm one-line summary, full text one click away. */
export function toastError(e: unknown) {
  toastErrorWithNote(e, undefined);
}

/**
 * `toastError` plus a line naming the state the failure left behind. The note is
 * a required parameter on purpose: `toastError` is passed bare as a react-query
 * `onError`, which supplies the mutation's variables as the second argument — an
 * optional one would let the whole variables value land here and render.
 */
export function toastErrorWithNote(e: unknown, note: string | undefined) {
  const presentation = presentError(e);
  toast.error(presentation.summary, {
    description: note,
    duration: 8000,
    action: errorToastAction(presentation),
  });
}
