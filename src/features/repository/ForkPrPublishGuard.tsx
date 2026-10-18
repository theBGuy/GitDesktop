import { WarningIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
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
import { Spinner } from "@/components/ui/spinner";
import { forgeEnsureForkRemote } from "@/lib/git/api";
import {
  branchPushHoldReason,
  refuseWhilePushRuns,
  usePendingBranchPushes,
  usePush,
} from "@/lib/git/queries";
import type { ForkPrMatch } from "@/lib/git/types";
import {
  ACT_PENDING_REASON,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import { refuseIfSwitched } from "@/lib/stores/notifications";
import { toastError } from "@/lib/toast";

/**
 * Shown when the branch being published is a local copy of a fork PR's head:
 * publishing it to a remote of THIS repo makes a separate copy and leaves the
 * pull request untouched. Open when `match` is the detected PR (null = closed).
 * Owns the push-to-fork route; the caller owns the publish this intercepted and
 * resumes it on "Publish … anyway".
 */
export function ForkPrPublishGuard({
  repoPath,
  match,
  branch,
  destination = "origin",
  onClose,
  onPublishAnyway,
}: {
  /** The repo the match was detected in, never the live one: the dialog can
   *  outlive a switch away from it. */
  repoPath: string;
  match: ForkPrMatch | null;
  /** The local branch being published — the push source, whose name may differ
   *  from the fork's branch. */
  branch: string;
  /** The remote the intercepted publish targets. */
  destination?: string;
  /** Dismiss without pushing anywhere; also called once a fork push lands. */
  onClose: () => void;
  onPublishAnyway: () => void;
}) {
  const push = usePush(repoPath);
  const queryClient = useQueryClient();
  const [ensuring, setEnsuring] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const noteId = useId();

  const open = match !== null;
  const pending = ensuring || push.isPending;
  // Another surface's push in this repo (its own push is `pending`): both routes
  // would queue behind it on the network lock, so both hold until it settles.
  const pendingPushes = usePendingBranchPushes(repoPath);
  const otherPushHeld = !pending && pendingPushes.length > 0;
  const otherPushReason = branchPushHoldReason(
    pendingPushes.some((p) => p.paused),
  );
  // Both routes push, so both hold while offline; the dialog can be open when
  // the connection drops.
  const offlineHold = useOfflineHold();
  // Unknown degrades to false by contract, so a denied-or-unknown flag offers
  // the honest fallback rather than a push GitHub would reject.
  const canPushToFork = match?.maintainerCanModify === true;
  // An exact match (the head checked out with nothing on top) is a supported
  // match with nothing to send, so the fork route is dropped entirely rather
  // than offering a push that would claim an update it didn't make. Takes
  // precedence over the permission reason, which is moot with nothing to push.
  const showPushToFork = match !== null && match.aheadCount > 0;
  const slug = match ? `${match.headRepoOwner}/${match.headRepoName}` : "";
  const commits = match
    ? `${match.aheadCount} commit${match.aheadCount === 1 ? "" : "s"}`
    : "";

  // The push answers to `repoPath`, so it runs only while that repo is the one on
  // screen: the dialog describes it, and a switch away refuses and closes it.
  function switchedAway(): boolean {
    if (!refuseIfSwitched(repoPath, "nothing was pushed")) return false;
    onClose();
    return true;
  }

  // One push at a time: another surface's push can start while the dialog is
  // open, and a second one would queue behind it on the network lock.
  const pushRunning = () => refuseWhilePushRuns(queryClient, repoPath);

  // Add the fork remote (idempotent) and push the local branch onto the PR's
  // head ref — no fetch first: the match is ancestry-verified locally, so this
  // fast-forwards unless the contributor pushed meanwhile, which surfaces as a
  // normal push error. The push mutation invalidates the whole repo subtree,
  // which is where the PR list and details live.
  async function pushToFork() {
    if (!match || refuseWhileOffline() || switchedAway() || pushRunning())
      return;
    setEnsuring(true);
    let remote: string;
    try {
      remote = await forgeEnsureForkRemote(
        repoPath,
        match.headRepoOwner,
        match.headRepoName,
      );
    } catch (e) {
      setEnsuring(false);
      toastError(e);
      return;
    }
    setEnsuring(false);
    // Again below the remote setup, an await the connection can drop, the user
    // can switch repositories, and another push can start during.
    if (refuseWhileOffline() || switchedAway() || pushRunning()) return;
    try {
      await push.mutateAsync({
        setUpstream: false,
        branch,
        remote,
        remoteBranch: match.headRefName,
      });
      toast.success(`Pushed ${commits} to ${slug}:${match.headRefName}.`);
      onClose();
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      {/* Cancel always takes the initial focus: every field of the match comes
          from a pull request an outsider authored, so the push it describes is
          an outward write to a repository chosen by attacker-influenced data —
          it must cost a deliberate Tab or click, never an ambient Enter. */}
      <DialogContent initialFocus={() => cancelRef.current}>
        <DialogHeader>
          <DialogTitle>
            This branch belongs to a pull request from a fork
          </DialogTitle>
          <DialogDescription>
            Its history matches{" "}
            {/* Link-styled button, not an anchor: an <a href> would navigate the
                webview itself. Underlined at rest, matching the anchor styling
                DialogDescription applies to its own links. */}
            <button
              type="button"
              title="Open the pull request in your browser"
              className="cursor-pointer underline underline-offset-3 hover:text-foreground"
              onClick={() => match && openUrl(match.url).catch(toastError)}
            >
              PR #{match?.number} — {match?.title}
            </button>{" "}
            — from <span className="font-mono">{slug}</span>. Publishing to{" "}
            <span className="font-mono">{destination}</span> creates a separate
            copy there and won't update the pull request.
          </DialogDescription>
        </DialogHeader>
        {!showPushToFork ? (
          <p className="text-xs text-muted-foreground">
            Your branch matches the pull request head exactly, so there's
            nothing to send to <span className="font-mono">{slug}</span> —
            publishing here would only copy the branch.
          </p>
        ) : canPushToFork ? (
          <p id={noteId} className="text-xs text-muted-foreground">
            Pushes {commits} to{" "}
            <span className="font-mono">{match?.headRefName}</span> — the pull
            request updates.
          </p>
        ) : (
          <p
            id={noteId}
            className="flex items-start gap-1.5 text-xs text-warning"
          >
            <WarningIcon className="size-4 shrink-0" />
            <span>
              {match?.headRepoOwner} hasn't allowed edits from maintainers on
              this pull request.
            </span>
          </p>
        )}
        <DialogFooter>
          {/* Cancel stays live while a push runs: a dismissal can't unsend it,
              but the user must always be able to close the dialog. */}
          <Button ref={cancelRef} variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <DisabledReasonButton
            variant="outline"
            disabled={pending || otherPushHeld || !!offlineHold}
            // `pending` is this dialog's fork push, never this button's own
            // publish; another surface's push holds it the same way.
            reason={(() => {
              switch (true) {
                case pending:
                  return "Pushing to the fork…";
                case otherPushHeld:
                  return otherPushReason;
                default:
                  return offlineHold;
              }
            })()}
            onClick={onPublishAnyway}
          >
            Publish to {destination} anyway
          </DisabledReasonButton>
          {showPushToFork ? (
            <DisabledReasonButton
              disabled={
                !canPushToFork || pending || otherPushHeld || !!offlineHold
              }
              // The permission note already describes its own hold (a plain
              // disable that offline never flips); a running push outranks offline.
              reason={(() => {
                switch (true) {
                  case !canPushToFork:
                    return undefined;
                  case pending:
                    return ACT_PENDING_REASON;
                  case otherPushHeld:
                    return otherPushReason;
                  default:
                    return offlineHold;
                }
              })()}
              aria-describedby={noteId}
              onClick={() => void pushToFork()}
            >
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Push to {slug}
            </DisabledReasonButton>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
