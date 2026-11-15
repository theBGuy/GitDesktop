import { ArrowSquareOutIcon, CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { COPY_FAILED, writeClipboard } from "@/lib/clipboard";
import { useErrorDialog } from "@/lib/stores/error-dialog";
import { useRetained } from "@/lib/use-retained";

/**
 * The full-text viewer for a long error. Opened from an error toast's "Details"
 * action; mounted once at the app root. The toast shows a calm one-line summary;
 * this dialog carries the raw, selectable text (git/forge stderr, long paths and
 * hashes) with a Copy action.
 */
export function ErrorDialog() {
  const presentation = useErrorDialog((s) => s.presentation);
  const close = useErrorDialog((s) => s.close);
  const shownPresentation = useRetained(presentation);
  const [copied, setCopied] = useState(false);
  // Hold the copy-feedback timer so handleClose can cancel it — otherwise a
  // Copy → Close → reopen → Copy sequence lets the first dialog's orphaned
  // timer fire mid-window and prematurely hide the new "Copied" feedback.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionRef = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Reset copy feedback when the presentation identity changes — open() called
  // while the dialog is already open swaps `presentation` without ever passing
  // through handleClose(), so a prior Copy's "Copied" state and live timer would
  // otherwise bleed into the new error's session. (Also fires on close.) Each run
  // also advances the session that copy() checks.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `presentation` is the reset trigger, not read in the body.
  useEffect(() => {
    sessionRef.current += 1;
    setCopied(false);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [presentation]);

  // Copy must hand over exactly what the pane shows, so both read the snapshot.
  const fullText = shownPresentation?.fullText ?? "";
  const link = shownPresentation?.link;

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

  async function copy() {
    // The write can settle after the dialog closed or showed something else;
    // "Copied" belongs only to the session the click happened in.
    const session = sessionRef.current;
    try {
      await writeClipboard(fullText);
    } catch {
      toast.error(COPY_FAILED);
      return;
    }
    if (sessionRef.current !== session) return;
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Dialog
      open={presentation !== null}
      onOpenChange={(open) => {
        if (!open) handleClose();
      }}
    >
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-2xl"
        // Close, not the first tabbable: the link-out leads the footer in DOM
        // order too, and opening a dialog must never arm an external navigation.
        initialFocus={() => closeRef.current}
      >
        <DialogHeader>
          <div className="flex items-center gap-2 pr-8">
            <DialogTitle className="min-w-0 wrap-break-word">
              {shownPresentation?.summary}
            </DialogTitle>
            {shownPresentation?.label && (
              <Badge variant="secondary" className="shrink-0">
                {shownPresentation.label}
              </Badge>
            )}
          </div>
        </DialogHeader>
        <pre className="max-h-[60vh] min-w-0 overflow-y-auto font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere] select-text">
          {fullText}
        </pre>
        <DialogFooter className="items-center">
          {link && (
            <Button
              variant="ghost"
              size="sm"
              className="cursor-pointer text-muted-foreground sm:mr-auto"
              onClick={() => openUrl(link.url)}
            >
              <ArrowSquareOutIcon data-icon="inline-start" />
              {link.label}
            </Button>
          )}
          <Button ref={closeRef} variant="outline" onClick={handleClose}>
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
