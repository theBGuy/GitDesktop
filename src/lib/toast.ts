import { toast } from "sonner";
import { presentError } from "@/lib/error-summary";
import { useErrorDialog } from "@/lib/stores/error-dialog";

/**
 * Error toast — calm one-line summary. Short errors keep a Copy action (the full
 * text is one line by construction); long errors (multi-line stderr, forge dumps)
 * get a Details action that opens the ErrorDialog with the full raw text.
 */
export function toastError(e: unknown) {
  const presentation = presentError(e);
  const { summary, fullText, long } = presentation;

  toast.error(summary, {
    duration: 8000,
    action: long
      ? {
          label: "Details",
          onClick: () => useErrorDialog.getState().open(presentation),
        }
      : {
          label: "Copy",
          onClick: () => {
            navigator.clipboard.writeText(fullText).catch(() => {
              // clipboard denied — nothing useful to do
            });
          },
        },
  });
}
