import type { ReactNode } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ACT_PENDING_REASON, pendingWriteReason } from "@/lib/offline-writes";

/**
 * A title/body confirmation dialog with a Cancel and a single confirm button —
 * the app's recurring "are you sure?" prompt. The parent owns the open state and
 * the action; this owns only the shared chrome, so the many near-identical
 * confirm dialogs (discard/stash/delete a branch, …) don't each re-spell it.
 *
 * For prompts with more than one action (e.g. "Stash and switch" / "Bring
 * changes") use a plain `<Dialog>` — this is deliberately the two-button case.
 */
export function ConfirmDialog({
  open,
  onCancel,
  title,
  body,
  confirmLabel,
  confirmVariant = "default",
  pending = false,
  paused = false,
  heldReason,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  title: ReactNode;
  body: ReactNode;
  confirmLabel: ReactNode;
  confirmVariant?: "default" | "destructive";
  pending?: boolean;
  /** The pending write is parked offline — the `isPaused` of the same mutation
   *  that feeds `pending`, so its reason says it is waiting, not running. */
  paused?: boolean;
  /** Holds the confirm button with this reason (e.g. offline); a running
   *  `pending` write outranks it. */
  heldReason?: string;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <DisabledReasonButton
            variant={confirmVariant}
            disabled={pending || !!heldReason}
            reason={
              pending
                ? pendingWriteReason(paused, ACT_PENDING_REASON)
                : heldReason
            }
            onClick={onConfirm}
          >
            {confirmLabel}
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
