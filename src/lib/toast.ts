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
  showErrorToast(e, undefined);
}

/**
 * `toastError` plus a line naming the state the failure left behind. `note` is
 * required so the intent is explicit: `toastError` rides bare as a react-query
 * `onError`, which passes the mutation's variables second, and the string type
 * keeps a non-string variables value from silently rendering as the note.
 */
export function toastErrorWithNote(e: unknown, note: string) {
  showErrorToast(e, note);
}

/**
 * Toast copy for a bulk ignore / AI-exclude. `total` is LINES written; `added`
 * is the Rust command's count actually appended — it skips lines already
 * present (.gitignore) or already in EFFECT (aiignore, where a later `!`
 * revives a line). Lines ≠ selected entries: a `\`-holding path emits a
 * `/`-separated twin line, so `total` can exceed the selection.
 */
export function ignoreToast(
  added: number,
  total: number,
  file: string,
): string {
  const entries = (n: number) => `entr${n === 1 ? "y" : "ies"}`;
  if (added === 0)
    return total === 1
      ? `Entry already in ${file}`
      : `All ${total} ${entries(total)} already in ${file}`;
  if (added < total)
    return `Added ${added} of ${total} ${entries(total)} to ${file}`;
  return `Added ${added} ${entries(added)} to ${file}`;
}

function showErrorToast(e: unknown, note: string | undefined) {
  const presentation = presentError(e);
  toast.error(presentation.summary, {
    description: note,
    duration: 8000,
    action: errorToastAction(presentation),
  });
}
