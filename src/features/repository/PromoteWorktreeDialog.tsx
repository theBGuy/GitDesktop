import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
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
import { gitOpState, gitStatus } from "@/lib/git/api";
import { repoKeys, useUserWorktrees } from "@/lib/git/queries";
import type { UserWorktree } from "@/lib/git/worktree";
import { useWorktreeRemovalStore } from "@/lib/stores/worktree-removal";

/**
 * Promotes a linked worktree's branch into the MAIN workspace. A branch can only
 * live in one worktree at a time, so promoting is a composite: free the branch
 * (remove the worktree, keep the branch) then check it out in the main checkout.
 *
 * Guards run BEFORE any mutation so a failure never strands the repo — the
 * worktree must be clean (we never discard its work), and the main workspace's
 * own uncommitted changes are stashed first so the checkout can't be blocked.
 * The main workspace is opened first: there's no filesystem watcher (git status
 * is polled), so moving the app off the worktree and letting its last poll
 * settle is what lets the folder delete cleanly — even when you promote the very
 * worktree you're standing in.
 *
 * This dialog only gathers and checks those preconditions. The composite itself
 * is store-owned (`worktree-removal`), so nothing that closes or unmounts this
 * dialog can cut it short — which is why it closes as soon as the store accepts
 * the promote instead of holding the user in a modal for the whole run. Its
 * removal step shows in the repo view's removal line and the manager's row.
 */
export function PromoteWorktreeDialog({
  repoPath,
  worktree,
  onClose,
}: {
  repoPath: string;
  worktree: UserWorktree | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={worktree !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {worktree && (
          <PromoteBody
            repoPath={repoPath}
            worktree={worktree}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function PromoteBody({
  repoPath,
  worktree,
  onClose,
}: {
  repoPath: string;
  worktree: UserWorktree;
  onClose: () => void;
}) {
  const worktrees = useUserWorktrees(repoPath);
  const startPromote = useWorktreeRemovalStore((s) => s.startPromote);
  // Synchronous re-entry latch: no re-render separates two clicks in the same
  // tick, so only a ref can refuse the second.
  const runningRef = useRef(false);

  const mainPath = (worktrees.data ?? []).find((w) => w.isMain)?.path ?? null;

  // Preconditions, checked fresh while the dialog is open and sharing the app's
  // status cache (same query key): the worktree must be clean, and we detect the
  // main workspace's own WIP so we can offer to stash it first. Main is gated on
  // its path resolving from the worktree list.
  const wStatus = useQuery({
    queryKey: repoKeys.status(worktree.path),
    queryFn: () => gitStatus(worktree.path),
  });
  const mStatus = useQuery({
    queryKey: repoKeys.status(mainPath ?? "__pending__"),
    queryFn: () => gitStatus(mainPath as string),
    enabled: Boolean(mainPath),
  });
  // Main's in-progress merge/rebase/cherry-pick/revert: the backend refuses to
  // stash over one, and the stash here runs AFTER the worktree is removed — so it
  // has to be a precondition, not an error past the point of no return. Inline
  // rather than via `useOpState` (which takes no `enabled`) because mainPath
  // resolves a tick later from the worktree list; the shared key keeps one cache
  // entry either way.
  const mOpState = useQuery({
    queryKey: repoKeys.opState(mainPath ?? "__pending__"),
    queryFn: () => gitOpState(mainPath as string),
    enabled: Boolean(mainPath),
  });

  const checking =
    worktrees.isPending ||
    wStatus.isPending ||
    (Boolean(mainPath) && (mStatus.isPending || mOpState.isPending));
  const noMain = !worktrees.isPending && !mainPath;
  const worktreeDirty = (wStatus.data?.entries.length ?? 0) > 0;
  const mainDirty = (mStatus.data?.entries.length ?? 0) > 0;
  const mainBranch = mStatus.data?.branch?.name ?? "the default branch";
  const mainMidOp = Boolean(
    mOpState.data?.merging ||
      mOpState.data?.rebasing ||
      mOpState.data?.cherryPicking ||
      mOpState.data?.reverting,
  );
  // `refuse_mid_op` refuses on unmerged index entries too, and that arm has no
  // marker file behind it: a conflicted squash-merge leaves the conflicts with
  // `op_state` all-false, so mirroring only the marker arm would let the stash
  // refuse past the point of no return.
  const mainConflicted = (mStatus.data?.entries ?? []).some(
    (e) => e.staged === "conflicted" || e.unstaged === "conflicted",
  );
  // A failed status read must NOT read as "clean": with `data` undefined the
  // dirty checks silently become false, which would enable Promote with unknown
  // tree state and could skip the main-WIP stash before the checkout.
  const statusError =
    wStatus.isError ||
    (Boolean(mainPath) && (mStatus.isError || mOpState.isError));
  const blocked =
    noMain ||
    statusError ||
    worktreeDirty ||
    mainMidOp ||
    mainConflicted ||
    worktree.isLocked ||
    !worktree.branch;

  function doPromote() {
    if (!mainPath || !worktree.branch || blocked) return;
    if (runningRef.current) return;
    runningRef.current = true;
    // Resolved here, while the dialog still holds its precondition queries; the
    // store runs the composite from there and outlives this dialog.
    const refused = startPromote({
      mainPath,
      worktreePath: worktree.path,
      branch: worktree.branch,
      willStash: mainDirty,
    });
    if (refused) {
      runningRef.current = false;
      toast.info(refused);
      return;
    }
    onClose();
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Promote to main workspace?</DialogTitle>
        <DialogDescription>
          Checks out{" "}
          <span className="font-mono">{worktree.branch || "this branch"}</span>{" "}
          in your main workspace and removes this worktree — a branch can only
          be checked out in one worktree at a time.
        </DialogDescription>
      </DialogHeader>

      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <span className="text-muted-foreground">Worktree</span>
        <span className="truncate font-mono" title={worktree.path}>
          {worktree.path}
        </span>
        <span className="text-muted-foreground">Main workspace</span>
        <span className="truncate font-mono" title={mainPath ?? undefined}>
          {mainPath ?? "—"}
        </span>
      </div>

      {checking ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> Checking worktree state…
        </p>
      ) : statusError ? (
        <p className="text-xs text-warning">
          Couldn't read the worktree or main workspace state. Close this and try
          again.
        </p>
      ) : noMain ? (
        <p className="text-xs text-warning">
          Couldn't find the main workspace for this repository.
        </p>
      ) : worktreeDirty ? (
        <p className="text-xs text-warning">
          This worktree has uncommitted changes. Commit or stash them before
          promoting.
        </p>
      ) : mainMidOp ? (
        <p className="text-xs text-warning">
          The main workspace has a merge, rebase, cherry-pick or revert in
          progress — finish or abort it first.
        </p>
      ) : mainConflicted ? (
        <p className="text-xs text-warning">
          The main workspace has unresolved conflicts — resolve or abort them
          first.
        </p>
      ) : worktree.isLocked ? (
        <p className="text-xs text-warning">
          This worktree is locked. Unlock it before promoting.
        </p>
      ) : mainDirty ? (
        <p className="text-xs text-info">
          Your main workspace has uncommitted changes on{" "}
          <span className="font-mono">{mainBranch}</span> — they'll be stashed
          first, and Pop latest stash brings them back.
        </p>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={checking || blocked} onClick={doPromote}>
          {mainDirty && !blocked ? "Stash & promote" : "Promote"}
        </Button>
      </DialogFooter>
    </>
  );
}
