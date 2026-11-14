import { toast } from "sonner";
import { composedErrorPresentation } from "@/lib/error-summary";
import { errorToastAction } from "@/lib/toast";
import { FOLLOWUP_HEADING, type ItemKind } from "./comment-post";

/**
 * The toast of an item that was created with a warning (`createdWarning`'s
 * title). View rides the action slot; a follow-up reason adds Details, in the
 * cancel slot beside View (its dialog carries View, since cancel dismisses) or
 * in the action slot when there is no View (no URL).
 * The caller passes the opener, so this module reaches no Tauri plugin.
 */
export function toastCreatedWarning(opts: {
  kind: ItemKind;
  title: string;
  followupError: string | null;
  description?: string;
  view?: { label: string; url: string; onClick: () => void };
}): void {
  const { kind, title, followupError, description, view } = opts;
  const action = view && { label: view.label, onClick: view.onClick };
  if (followupError === null) {
    toast.warning(title, { description, action });
    return;
  }
  const link = view && { url: view.url, label: view.label };
  const details = errorToastAction(
    composedErrorPresentation(
      title,
      [followupError],
      [FOLLOWUP_HEADING[kind]],
      link,
    ),
  );
  toast.warning(title, {
    description,
    duration: 10000,
    action: action ?? details,
    cancel: action ? details : undefined,
  });
}
