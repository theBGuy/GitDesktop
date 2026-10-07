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

/**
 * "Delete comment?" confirmation, shared by every PR/issue/discussion view.
 * Open while `commentId` is non-null. The dialog does NOT close itself on
 * confirm — `onConfirm(id)` runs the caller's delete and the caller closes
 * (synchronously for local comments; for remote ones in BOTH arms of the
 * awaited continuation — close-on-error is deliberate). `pending` disables
 * Delete during a remote mutation, explained by `reason` (the caller's
 * `pendingWriteReason`, so a delete queued offline says it is waiting); local
 * callers omit both.
 */
export function DeleteCommentDialog({
  commentId,
  onClose,
  onConfirm,
  title = "Delete comment?",
  description = "This permanently deletes the comment on GitHub. This cannot be undone.",
  pending,
  reason,
}: {
  commentId: string | null;
  onClose: () => void;
  onConfirm: (id: string) => void;
  title?: ReactNode;
  description?: ReactNode;
  pending?: boolean;
  reason?: string;
}) {
  return (
    <Dialog
      open={commentId !== null}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <DisabledReasonButton
            variant="destructive"
            disabled={pending}
            reason={reason}
            onClick={() => {
              if (commentId) onConfirm(commentId);
            }}
          >
            Delete
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
