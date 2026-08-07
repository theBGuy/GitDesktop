import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useRemoveUserWorktree } from "@/lib/git/queries";
import type { UserWorktree } from "@/lib/git/worktree";
import { toastError } from "@/lib/toast";

/**
 * Confirms removing a worktree's folder while keeping its branch. Escalates to a
 * force remove when git refuses a dirty or locked worktree. Shared by the
 * worktree manager and the branch switcher's "Delete worktree…" actions.
 */
export function DeleteWorktreeDialog({
  repoPath,
  worktree,
  onClose,
}: {
  repoPath: string;
  worktree: UserWorktree | null;
  onClose: () => void;
}) {
  const remove = useRemoveUserWorktree(repoPath);
  // A locked worktree always needs --force; a dirty one reveals it on first try.
  const [forceNeeded, setForceNeeded] = useState(worktree?.isLocked ?? false);

  function doRemove(force: boolean) {
    if (!worktree) return;
    remove.mutate(
      { path: worktree.path, force },
      {
        onSuccess: () => {
          toast.success("Worktree removed");
          onClose();
        },
        onError: (e) => {
          const msg = String((e as { message?: string })?.message ?? e);
          // git refuses a non-force remove of a dirty/locked worktree; surface
          // the escalation rather than failing silently.
          if (!force && /force|modified|untracked|locked/i.test(msg)) {
            setForceNeeded(true);
          } else {
            toastError(e);
          }
        },
      },
    );
  }

  return (
    <Dialog open={worktree !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this worktree?</DialogTitle>
          <DialogDescription>
            Removes the worktree folder. Its branch{" "}
            {worktree?.branch ? (
              <span className="font-mono">{worktree.branch}</span>
            ) : (
              "and commits"
            )}{" "}
            stays — you can check it out again later.
          </DialogDescription>
        </DialogHeader>

        <p className="truncate rounded bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
          {worktree?.path}
        </p>

        {worktree?.isLocked && (
          <p className="text-xs text-warning">
            This worktree is locked
            {worktree.lockReason ? ` (${worktree.lockReason})` : ""}. Removing
            it forces it.
          </p>
        )}
        {forceNeeded && !worktree?.isLocked && (
          <p className="text-xs text-warning">
            This worktree has uncommitted changes. Force-removing discards them.
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={onClose}
            disabled={remove.isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => doRemove(forceNeeded)}
          >
            {remove.isPending && <Spinner data-icon="inline-start" />}
            {forceNeeded ? "Force remove" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
