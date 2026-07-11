import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useErrorDialog } from "@/lib/stores/error-dialog";

/**
 * The full-text viewer for a long error. Opened from an error toast's "Details"
 * action; mounted once at the app root. The toast shows a calm one-line summary;
 * this dialog carries the raw, selectable text (git/forge stderr, long paths and
 * hashes) with a Copy action.
 */
export function ErrorDialog() {
  const presentation = useErrorDialog((s) => s.presentation);
  const close = useErrorDialog((s) => s.close);
  const [copied, setCopied] = useState(false);
  // Hold the copy-feedback timer so handleClose can cancel it — otherwise a
  // Copy → Close → reopen → Copy sequence lets the first dialog's orphaned
  // timer fire mid-window and prematurely hide the new "Copied" feedback.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fullText = presentation?.fullText ?? "";

  // Controlled Base UI dialogs don't fire onOpenChange when `open` flips via the
  // prop, so the Close button clears `copied` itself — otherwise a Copy → Close
  // within 1.5s leaves the next-opened dialog briefly showing "Copied".
  function handleClose() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    close();
    setCopied(false);
  }

  function copy() {
    navigator.clipboard
      .writeText(fullText)
      .then(() => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard denied — nothing useful to do.
      });
  }

  return (
    <Dialog
      open={presentation !== null}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle className="min-w-0 wrap-break-word">
              {presentation?.summary}
            </DialogTitle>
            {presentation?.label && (
              <Badge variant="secondary" className="shrink-0">
                {presentation.label}
              </Badge>
            )}
          </div>
        </DialogHeader>
        <pre className="max-h-[60vh] min-w-0 overflow-y-auto font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere] select-text">
          {fullText}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Close
          </Button>
          <Button variant="secondary" onClick={copy}>
            {copied ? (
              <>
                <CheckIcon data-icon="inline-start" /> Copied
              </>
            ) : (
              <>
                <CopyIcon data-icon="inline-start" /> Copy
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
