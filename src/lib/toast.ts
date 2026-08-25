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
 * Toast copy for a bulk ignore / AI-exclude, where `total` is the number of
 * LINES written and `added` came back from the Rust command as the count
 * actually appended — skipping lines already present (.gitignore) or already in
 * EFFECT (.gitdesktop/aiignore, where a later `!` un-ignore revives a line).
 * Lines, not selected entries: on the AI path a `\`-holding path emits a second
 * `/`-separated line, so the total can exceed the selection. Reports the honest
 * end state: nothing new when everything was already covered, a partial when
 * some were skipped.
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
