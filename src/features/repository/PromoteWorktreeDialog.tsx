import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
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
import {
  gitCheckoutBranch,
  gitOpState,
  gitStashAll,
  gitStatus,
  validateRepo,
} from "@/lib/git/api";
import { repoKeys, useUserWorktrees } from "@/lib/git/queries";
import {
  pruneWorktrees,
  removeWorktree,
  type UserWorktree,
} from "@/lib/git/worktree";
import { toastError } from "@/lib/toast";
import { useOpenWorktree } from "./useOpenRepoByPath";

/** Remove a worktree while keeping its branch, retrying once if the folder is
 *  momentarily still held. The app has just switched off this worktree, but its
 *  last in-flight git-status poll (or the OS) can keep the directory busy for a
 *  beat — and `openRepo`'s switch is deferred by a View Transition, so the app
 *  may not have fully let go yet. The retry covers that window; a real, lasting
 *  hold (an editor/terminal in the folder) still surfaces the actionable error. */
async function removeWorktreeFreeingBranch(repoPath: string, path: string) {
  try {
    await removeWorktree(repoPath, path, null, false);
  } catch (e) {
    // Path stripped before matching — a folder NAMED e.g. "docs-in-use" must
    // not read as a transient hold.
    const msg = String((e as { message?: string })?.message ?? e).replaceAll(
      path,
      "",
    );
    if (/close any program|in use|being used|invalid argument/i.test(msg)) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await removeWorktree(repoPath, path, null, false);
    } else {
      throw e;
    }
  }
}

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
  // `pending` lives here (not in PromoteBody) so it gates dismissal: while a
  // promote runs, Esc / the X / an outside click must NOT tear the dialog down —
  // the async chain would keep going with the dialog gone (a background recovery
  // toast; or a second concurrent promote after a quick reopen re-mounts a fresh
  // re-entry latch). Controlled Base UI funnels every dismissal through
  // onOpenChange, so gating onClose on !pending blocks them all.
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={worktree !== null}
      onOpenChange={(o) => {
        if (!o && !pending) onClose();
      }}
    >
      <DialogContent>
        {worktree && (
          <PromoteBody
            repoPath={repoPath}
            worktree={worktree}
            pending={pending}
            setPending={setPending}
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
  pending,
  setPending,
  onClose,
}: {
  repoPath: string;
  worktree: UserWorktree;
  pending: boolean;
  setPending: (value: boolean) => void;
  onClose: () => void;
}) {
  const worktrees = useUserWorktrees(repoPath);
  const openWorktree = useOpenWorktree();
  const queryClient = useQueryClient();
  // Synchronous re-entry latch: `setPending` is async, so two fast clicks could
  // both pass the pending check before a re-render — this stops the second.
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

  async function doPromote() {
    if (!mainPath || !worktree.branch || blocked) return;
    // Synchronous latch — beat a double-click before `setPending` re-renders.
    if (runningRef.current) return;
    runningRef.current = true;
    const willStash = mainDirty;
    // Track how far the composite got. Once the worktree is removed we're past
    // the point of no return: a later failure needs recovery guidance (the
    // folder is gone, the branch is free but unchecked-out), not git's raw error.
    let removed = false;
    let stashed = false;
    setPending(true);
    try {
      // Verify the main workspace is reachable BEFORE any mutation.
      // `useOpenWorktree` swallows its own errors (it toasts, never throws), so a
      // moved/unmounted main path would otherwise let the app stay on the
      // worktree while we go on to delete it. Throwing here aborts cleanly.
      await validateRepo(mainPath);
      // Move the app onto the main workspace — we're about to delete this
      // worktree's folder, and nothing should keep reading git status inside it.
      // There's no fs-watcher (status is polled), so switching away stops future
      // polls; `removeWorktreeFreeingBranch` retries once for any last in-flight
      // poll that hasn't drained (openRepo's switch is deferred by a transition).
      await openWorktree(mainPath);
      await new Promise((resolve) => setTimeout(resolve, 80));
      // Free the branch: remove the worktree but KEEP the branch (null) — we
      // check it out in main next. force=false: the clean-tree guard already ran.
      await removeWorktreeFreeingBranch(mainPath, worktree.path);
      removed = true;
      await pruneWorktrees(mainPath).catch(() => undefined);
      // The branch's working tree is free now; stash main's own WIP (if any) so
      // the checkout can't be blocked, then land main on the promoted branch.
      if (willStash) {
        await gitStashAll(mainPath);
        stashed = true;
      }
      await gitCheckoutBranch(mainPath, worktree.branch);
      await queryClient.invalidateQueries({ queryKey: repoKeys.all(mainPath) });
      toast.success(
        willStash
          ? `Promoted ${worktree.branch} — your main workspace changes were stashed; Pop latest stash brings them back`
          : `Promoted ${worktree.branch} to your main workspace`,
      );
      setPending(false);
      onClose();
    } catch (e) {
      if (removed) {
        // The worktree is already gone and the branch is free but not checked
        // out — surface the recovery path (with git's error as the detail).
        toast.error(
          `Removed the worktree, but couldn't check out ${worktree.branch} in your main workspace — switch to it there manually.${
            stashed ? " Your changes are stashed — use Pop latest stash." : ""
          }`,
          { description: e instanceof Error ? e.message : String(e) },
        );
      } else {
        toastError(e);
      }
      runningRef.current = false;
      setPending(false);
    }
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
        <Button variant="outline" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button disabled={checking || blocked || pending} onClick={doPromote}>
          {pending && <Spinner data-icon="inline-start" />}
          {mainDirty && !blocked ? "Stash & promote" : "Promote"}
        </Button>
      </DialogFooter>
    </>
  );
}
