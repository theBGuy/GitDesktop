import { useEffect, useState } from "react";
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
import type { UserWorktree } from "@/lib/git/worktree";
import {
  registerRemovalListener,
  useIsRemovingWorktree,
  useWorktreeRemovalStore,
} from "@/lib/stores/worktree-removal";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";

/** Last path segment, tolerating both separators — what to call a detached
 *  worktree that has no branch name. */
function folderName(p: string) {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

/**
 * Confirms removing a worktree's folder while keeping its branch. Escalates to a
 * force remove when git refuses a dirty or locked worktree. Shared by the
 * worktree manager and the branch switcher's "Delete worktree…" actions.
 *
 * The removal itself belongs to `worktree-removal`, not this dialog: it can run
 * for minutes, and closing the dialog must not take its spinner (or its failure)
 * with it. While one runs this dialog is a view of it — dismissible, with no
 * cancel to offer.
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
  const startRemoval = useWorktreeRemovalStore((s) => s.startRemoval);
  const removing = useIsRemovingWorktree(repoPath, worktree?.path);
  // A locked worktree always needs --force; a dirty one reveals it on first try.
  const [forceNeeded, setForceNeeded] = useState(worktree?.isLocked ?? false);

  // Behind a ref because the store invokes these from its own async stack, long
  // after the render that wrote them: what gets registered is a plain object
  // whose methods read the ref, so nothing bound to a render escapes into the
  // module-level registry.
  const handlersRef = useLatestRef({
    onSuccess: () => onClose(),
    onError: (e: unknown, force: boolean) => {
      if (!worktree) return;
      const msg = String((e as { message?: string })?.message ?? e);
      // git refuses a non-force remove of a dirty/locked worktree; surface
      // the escalation rather than failing silently. The path is stripped
      // first so a folder NAMED e.g. "locked-tools" can't turn every
      // refusal into a force offer.
      const reason = msg.replaceAll(worktree.path, "");
      if (!force && /force|modified|untracked|locked/i.test(reason)) {
        setForceNeeded(true);
      } else {
        toastError(e);
      }
    },
  });

  // Claim this target's outcome for as long as the dialog is mounted; the store
  // falls back to a toast once it isn't, so a failure surfaces exactly once.
  useEffect(() => {
    if (!worktree) return;
    return registerRemovalListener(repoPath, worktree.path, {
      onSuccess: () => handlersRef.current.onSuccess(),
      onError: (e, force) => handlersRef.current.onError(e, force),
    });
  }, [repoPath, worktree]);

  function doRemove(force: boolean) {
    if (!worktree) return;
    const refused = startRemoval({
      repoPath,
      path: worktree.path,
      name: worktree.branch || folderName(worktree.path),
      force,
    });
    if (refused) toast.info(refused);
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
        {removing && (
          <p className="text-xs text-muted-foreground">
            Removing a worktree can take a few minutes. You can close this and
            keep working; it stays visible at the top of the repository until it
            finishes.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {/* Never "Cancel" while a removal runs: closing this dialog is all
                it does — the removal itself can't be called off. */}
            {removing ? "Close" : "Cancel"}
          </Button>
          <Button
            variant="destructive"
            disabled={removing}
            onClick={() => doRemove(forceNeeded)}
          >
            {removing && <Spinner data-icon="inline-start" />}
            {forceNeeded ? "Force remove" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
