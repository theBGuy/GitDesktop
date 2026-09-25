import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import {
  composedErrorPresentation,
  type ErrorPresentation,
  presentError,
} from "@/lib/error-summary";
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
        onClick: (event: { currentTarget: HTMLElement }) => {
          // sonner's toaster refocuses the pre-toast element when focus leaves it,
          // which would pull focus back out of the dialog. Blurring first runs that
          // restore synchronously (React's onBlur rides focusout), before the open.
          event.currentTarget.blur();
          useErrorDialog.getState().open(presentation);
        },
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
 * A failure toast whose title composes app prose around one or more raw errors
 * ("Created issue #12, but adding it to a project failed: …"). Details/Copy
 * (`errorToastAction`) rides the cancel slot when `view` holds the action,
 * else it IS the action; the dialog content is `composedErrorPresentation`'s.
 * sonner's cancel slot always dismisses the toast, so `view` also rides into the
 * dialog as its `link` — Details must never cost the user the View route.
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
  /** Primary View action for the created entity, when one exists. `label`
   *  names the provider where the call site knows it ("View on GitHub");
   *  defaults to "View". */
  view?: { url: string; label?: string };
  /** Defaults to 8000, matching `showErrorToast`. */
  duration?: number;
}): void {
  const { title, errors, headings, description, view, duration } = opts;
  const link = view && { url: view.url, label: view.label ?? "View" };
  const details = errorToastAction(
    composedErrorPresentation(title, errors, headings, link),
  );
  toast.error(title, {
    description,
    duration: duration ?? 8000,
    action: link
      ? { label: link.label, onClick: () => openUrl(link.url) }
      : details,
    cancel: link ? details : undefined,
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
