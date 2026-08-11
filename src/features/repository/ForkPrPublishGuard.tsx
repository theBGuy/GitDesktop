import { WarningIcon } from "@phosphor-icons/react";
import { useId, useRef, useState } from "react";
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
import { forgeEnsureForkRemote } from "@/lib/git/api";
import { usePush } from "@/lib/git/queries";
import type { ForkPrMatch } from "@/lib/git/types";
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
  const [ensuring, setEnsuring] = useState(false);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const noteId = useId();

  const open = match !== null;
  const pending = ensuring || push.isPending;
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

  // Add the fork remote (idempotent) and push the local branch onto the PR's
  // head ref — no fetch first: the match is ancestry-verified locally, so this
  // fast-forwards unless the contributor pushed meanwhile, which surfaces as a
  // normal push error. The push mutation invalidates the whole repo subtree,
  // which is where the PR list and details live.
  async function pushToFork() {
    if (!match) return;
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
    push.mutate(
      { setUpstream: false, branch, remote, remoteBranch: match.headRefName },
      {
        onSuccess: () => {
          toast.success(`Pushed ${commits} to ${slug}:${match.headRefName}.`);
          onClose();
        },
        onError: toastError,
      },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      {/* Focus the action that updates the pull request, so Enter takes the
          route the user came for; when it's denied, Cancel takes the focus —
          no key press should publish to the wrong repository. */}
      <DialogContent
        initialFocus={() =>
          showPushToFork && canPushToFork
            ? primaryRef.current
            : cancelRef.current
        }
      >
        <DialogHeader>
          <DialogTitle>
            This branch belongs to a pull request from a fork
          </DialogTitle>
          <DialogDescription>
            Its history matches PR #{match?.number} — {match?.title} — from{" "}
            <span className="font-mono">{slug}</span>. Publishing to{" "}
            <span className="font-mono">{destination}</span> creates a separate
            copy under this repository and won't update the pull request.
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
          <Button
            variant="outline"
            disabled={pending}
            onClick={onPublishAnyway}
          >
            Publish to {destination} anyway
          </Button>
          {showPushToFork ? (
            <Button
              ref={primaryRef}
              disabled={!canPushToFork || pending}
              aria-describedby={noteId}
              onClick={() => void pushToFork()}
            >
              {pending ? <Spinner data-icon="inline-start" /> : null}
              Push to {slug}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
