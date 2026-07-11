import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useState } from "react";
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

  const fullText = presentation?.fullText ?? "";

  function copy() {
    navigator.clipboard
      .writeText(fullText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard denied — nothing useful to do.
      });
  }

  return (
    <Dialog
      open={presentation !== null}
      onOpenChange={(open) => {
        if (!open) {
          close();
          setCopied(false);
        }
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <DialogTitle className="min-w-0 wrap-break-word">
              {presentation?.summary}
            </DialogTitle>
            {presentation?.label && (
              <Badge variant="secondary">{presentation.label}</Badge>
            )}
          </div>
        </DialogHeader>
        <pre className="max-h-[60vh] min-w-0 overflow-y-auto font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere] select-text">
          {fullText}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
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
