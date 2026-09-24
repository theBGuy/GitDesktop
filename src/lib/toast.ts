import { openUrl } from "@tauri-apps/plugin-opener";
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
 * A failure toast whose title composes app prose around one or more underlying
 * errors ("Created issue #12, but adding it to a project failed: …"). The title
 * stays the calm composed line; this keeps a route to the raw text, which a
 * plain `toastError` gives but these composed sites lost: Details/Copy rides
 * the cancel slot when `view` occupies the action, else it IS the action —
 * exactly `errorToastAction`'s affordance either way.
 */
export function toastComposedError(opts: {
  /** The composed headline (already carries summaries where it wants them). */
  title: string;
  /** The raw failure(s) behind it — at least one. */
  errors: readonly unknown[];
  /** Per-failure heading when several compose (same order as `errors`); each
   *  becomes a section header above that failure's full text in Details. */
  headings?: readonly string[];
  /** Toast description (origin note, or a one-line reason) — free text. */
  description?: string;
  /** Primary View action for the created entity, when one exists. */
  view?: { url: string };
  /** Defaults to 8000, matching `showErrorToast`. */
  duration?: number;
}): void {
  const { title, errors, headings, description, view, duration } = opts;
  const presentation: ErrorPresentation =
    errors.length === 1
      ? presentError(errors[0])
      : {
          label: null,
          summary: title,
          fullText: errors
            .map((e, i) => {
              const heading = headings?.[i];
              const text = presentError(e).fullText;
              return heading ? `${heading}\n${text}` : text;
            })
            .join("\n\n"),
          long: true,
        };
  const details = errorToastAction(presentation);
  toast.error(title, {
    description,
    duration: duration ?? 8000,
    action: view
      ? { label: "View", onClick: () => openUrl(view.url) }
      : details,
    cancel: view ? details : undefined,
  });
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
