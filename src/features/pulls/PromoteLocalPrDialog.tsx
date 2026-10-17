import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useId, useState } from "react";
import { flushSync } from "react-dom";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { presentError } from "@/lib/error-summary";
import { forgePrComment } from "@/lib/git/api";
import { useCreatePr, useForgeStatus } from "@/lib/git/queries";
import { providerLabel } from "@/lib/git/types";
import { notifyPrCreateFailed } from "@/lib/notifications/pr-create-failed";
import {
  pendingWriteReason,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import type { LocalPr } from "@/lib/pulls/local";
import { useUpdateLocalPr } from "@/lib/pulls/queries";
import { useSetRepoLens } from "@/lib/repo-lens/queries";
import { landedIn } from "@/lib/stores/notifications";
import {
  LANE_BLOCKED_HINT,
  markPrCreated,
  prCreateStartedAt,
  settlePrCreate,
  startPrCreate,
  usePrCreatePhase,
} from "@/lib/stores/pr-create";
import { armPrCreateHandOff } from "@/lib/stores/pr-create-handoff";
import { useUiStore } from "@/lib/stores/ui";
import { toastComposedError, toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";

/**
 * Publishes a local PR to the repo's provider (GitHub, GitLab, or Bitbucket):
 * closes the local PR FIRST, then pushes the head branch, opens a real PR/MR with
 * the same title/description, links the local PR to its successor and
 * **re-posts its comments** (so nothing is lost). Closing first means a dropped
 * connection can't leave both copies open; a create that fails reopens it. Fires
 * no automations — the local PR's creation was the pr-open trigger point (see
 * CreateLocalPrDialog), so promoting it would double-run them.
 */
export function PromoteLocalPrDialog({
  repoPath,
  pr,
  open,
  onOpenChange,
}: {
  repoPath: string;
  pr: LocalPr;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createPr = useCreatePr(repoPath);
  const update = useUpdateLocalPr(repoPath);
  const queryClient = useQueryClient();
  const selectPr = useUiStore((s) => s.selectPr);
  const setLens = useSetRepoLens(repoPath);
  const forge = useForgeStatus(repoPath);
  const isGitLab = forge.data?.provider === "gitlab";
  // The label names the detected forge (all three); the noun stays two-way
  // because only GitLab calls it a merge request.
  const remoteLabel = providerLabel(forge.data?.provider);
  // Both toasts' View, named only once the forge status has answered:
  // `providerLabel` defaults to GitHub, and nothing gates this flow on the status.
  const forgeViewLabel = forge.data ? `View on ${remoteLabel}` : undefined;
  const prNoun = isGitLab ? "merge request" : "pull request";
  const [draft, setDraft] = useState(false);
  // The publish in flight, set for its whole run (comment carry included): its
  // repo and local PR, since the host reuses this dialog across local PRs, and
  // the comment count it carries, which the dialog keeps showing while its
  // back-link lands. Any other PR's dialog holds only its Publish.
  const [pendingPub, setPendingPub] = useState<{
    repo: string;
    prId: string;
    count: number;
  } | null>(null);
  const ownPub =
    pendingPub !== null &&
    pendingPub.repo === repoPath &&
    pendingPub.prId === pr.id
      ? pendingPub
      : null;
  // Repo-blind on purpose: one slot tracks one run, and the hold copy stays true
  // wherever it shows.
  const otherPublishing = pendingPub !== null && ownPub === null;
  // Shares the PR-create lane with CreatePrDialog: both push the same head and
  // open a PR for it, so either one holding the lane blocks the other (and
  // paints the same strip above the panels). The lane guards through the whole
  // catch-up window after the forge answers, not just while the call runs, so
  // the hint reads the PHASE — non-null exactly while the lane still blocks,
  // which a guard-released hold does not. `ownPub === null` narrows it to the
  // RE-ENTRY case: promote claims the lane synchronously, so a phase is also
  // present during this dialog's own run, where the own slot is what to show.
  // A repo switch normally unmounts the host view and drops the slot, so a
  // return mid-publish is expected to land here: the lane holds Publish with
  // Cancel live and no own spinner, and the paused copy can't show (the pinned
  // create's observer detached).
  const lanePhase = usePrCreatePhase(repoPath, pr.head);
  const creatingElsewhere = lanePhase !== null && ownPub === null;
  const laneHint = creatingElsewhere
    ? LANE_BLOCKED_HINT[lanePhase](prNoun)
    : null;
  const shownPending = useRetained(ownPub !== null, open);
  const shownOtherPublishing = useRetained(otherPublishing, open);
  const shownCreatingElsewhere = useRetained(creatingElsewhere, open);
  const shownLaneHint = useRetained(laneHint, open);
  const creatingHintId = useId();
  // Publish pushes and opens a PR, so it holds offline rather than park — a
  // parked create would keep the run's slot set, locking Cancel until reconnect.
  const offlineHold = useOfflineHold();
  // Why Cancel and Publish hold during this dialog's own run: a create that parks
  // anyway (the connection dropped after the press) says it is waiting, not running.
  const pendingReason =
    ownPub === null
      ? undefined
      : pendingWriteReason(createPr.isPaused, `Creating the ${prNoun}…`);
  const shownPendingReason = useRetained(pendingReason, open);

  // Visible comments, in order — skip empty + hidden (collapsed) ones.
  const carried = pr.comments.filter((c) => c.body.trim() && !c.hidden);
  // While this PR's run is in flight, the count is the one it carries.
  const shownCarriedCount = useRetained(
    ownPub ? ownPub.count : carried.length,
    open,
  );

  /** Whether a settle may still close and navigate: its repo is the live one AND
   *  this local PR is still selected. The host keeps one `promoteOpen` state and
   *  blanks it when the selection moves, so a close landing on another pull
   *  request's confirm would shut a dialog the user opened for something else.
   *  Read after the await, from the store, never from render. */
  function stillOnThisPr(live: boolean): boolean {
    const { selectedPr } = useUiStore.getState();
    return live && selectedPr?.kind === "local" && selectedPr.id === pr.id;
  }

  // The local writes promotion makes, one per step. Each is a functional update,
  // so a concurrent MCP edit to the same record survives it.
  function closeLocal(closedAt: string) {
    return update.mutateAsync({
      id: pr.id,
      mutate: (cur) => ({ ...cur, status: "closed", closedAt }),
    });
  }

  function linkLocal(body: string) {
    return update.mutateAsync({
      id: pr.id,
      mutate: (cur) => ({
        ...cur,
        comments: [
          ...cur.comments,
          {
            id: crypto.randomUUID(),
            body,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    });
  }

  /** Undoes {@link closeLocal} after a create that produced nothing remote. It
   *  touches only status/closedAt, and only while the record still carries this
   *  flow's close: anything else changed it since, and that change wins. */
  function reopenLocal(
    closedAt: string,
    prior: Pick<LocalPr, "status" | "closedAt">,
  ) {
    return update.mutateAsync({
      id: pr.id,
      mutate: (cur) =>
        cur.status === "closed" && cur.closedAt === closedAt
          ? { ...cur, status: prior.status, closedAt: prior.closedAt }
          : cur,
    });
  }

  async function promote() {
    // The look is retained through the close fade; these live gates add `open`
    // and one run at a time, since `pendingPub` holds a single run.
    if (!open || pendingPub !== null || refuseWhileOffline()) return;
    // Fire-time admission, claimed before the first await: the push plus the
    // forge call outlives this dialog, and a second create for the same head
    // would queue on the repo lock and then open a duplicate PR.
    const refusal = startPrCreate(repoPath, pr.head, pr.base, {
      title: pr.title,
      draft,
      // Promotion always publishes to the fork's own remote.
      lens: "origin",
      noun: prNoun,
    });
    if (refusal) {
      toast.error(refusal);
      return;
    }
    // Captured before any await, so the `finally` arms exactly this claim.
    const claimedAt = prCreateStartedAt(repoPath, pr.head);
    // "release", not "error": a failed promote produced no draft, so it frees
    // the lane without latching over a real create failure for this branch.
    let outcome: "success" | "release" = "release";
    // The host offers Publish only on an open PR; this is what a failed create
    // restores, and `closedAt` stays null until the local close has landed.
    const prior = { status: pr.status, closedAt: pr.closedAt };
    let closedAt: string | null = null;
    // Once the remote PR exists, later steps (the back-link, comment carry-over)
    // failing must NOT re-arm the submit — retrying would open a duplicate.
    // Track it so the catch can disclose instead of re-running.
    let created: { number: number; url: string } | null = null;
    let failedStep = "linking the local pull request";
    setPendingPub({ repo: repoPath, prId: pr.id, count: carried.length });
    try {
      // Closed before the create: the local close lands even offline, so a
      // connection lost mid-flow can't leave this PR open beside its successor.
      const stamp = new Date().toISOString();
      await closeLocal(stamp);
      closedAt = stamp;
      const { number, url } = await createPr.mutateAsync({
        base: pr.base,
        head: pr.head,
        title: pr.title,
        body: pr.body,
        draft,
      });
      created = { number, url };
      outcome = "success";
      // Flip the lane HERE, not in the finally: the comment carry-over below can
      // run long, and the strip would sit on "creating" with the number already
      // known. The watcher itself arms in the finally, once those steps are done.
      markPrCreated(repoPath, pr.head, { number, url });
      // The back-link before the carry, so a carry failure still leaves it.
      await linkLocal(
        `Promoted to ${remoteLabel} ${prNoun} [#${number}](${url}).`,
      );
      // Carry the local comments over, in order, so none are lost.
      failedStep = "carrying over comments";
      for (const c of carried) {
        await forgePrComment(repoPath, number, c.body, undefined, "origin");
      }
      // One read for both halves: the toast is unconditional and names the repo
      // when it isn't the one on screen, while the navigation below only lands
      // while this repo and this local PR still are. That navigation is the lens
      // flip plus the selection plus the close, and this continuation outlives
      // both a repo switch and a move to another pull request: landed elsewhere
      // they would close a dialog the user reopened there and pull them back.
      const { live, away } = landedIn(repoPath);
      toast.success(`Opened ${prNoun} #${number}${away}`, {
        description: url,
        action: {
          label: forgeViewLabel ?? "View",
          onClick: () => openUrl(url),
        },
      });
      // The promoted PR lives on the fork (origin) — force the origin lens so the
      // Pulls tab shows it (clearing any stale remote selection) before selecting.
      if (stillOnThisPr(live)) {
        // A settle's close must commit before the finally's `setPendingPub(null)`
        // renders while open, or the twins retain the re-entry hint through the
        // fade.
        flushSync(() => onOpenChange(false));
        setLens("origin");
        selectPr({ kind: "remote", id: String(number) });
      }
    } catch (e) {
      if (created === null) {
        // Nothing remote exists, so retrying is correct: keep the dialog open.
        // A failed local close attempted no create, so there's nothing to undo.
        if (closedAt === null) {
          toastError(e);
          return;
        }
        // Reopened BEFORE the toast, so the retry-capable dialog sits over a
        // record that reads open again.
        let reopenError: unknown = null;
        try {
          await reopenLocal(closedAt, prior);
        } catch (err) {
          reopenError = err;
        }
        if (reopenError === null) toastError(e);
        else
          toastComposedError({
            title: `Couldn't create the ${prNoun}: ${presentError(e).summary}`,
            description:
              "The local PR couldn't be reopened — reopen it from its view.",
            errors: [e, reopenError],
            headings: [`Creating the ${prNoun}`, "Reopening the local PR"],
          });
        // The toast fades in seconds; this outlives it for a user who moved on.
        notifyPrCreateFailed({
          repoPath,
          head: pr.head,
          noun: prNoun,
          error: e,
        });
        return;
      }
      // The remote PR already exists and the local PR is already closed. Close
      // the dialog anyway (a retry from it would open a duplicate) and disclose
      // what was created and what failed; a missing back-link or comment is left
      // for the user to reconcile. The close names its subject as well as its
      // repo, while the toast names only the REPO, since that is the part the
      // user can't see for themselves.
      const { number, url } = created;
      const { live, away } = landedIn(repoPath);
      if (stillOnThisPr(live)) flushSync(() => onOpenChange(false));
      toastComposedError({
        title: `Created ${prNoun} #${number}${away}, but ${failedStep} failed: ${presentError(e).summary}`,
        errors: [e],
        view: { url, label: forgeViewLabel },
        duration: 10000,
      });
    } finally {
      setPendingPub(null);
      // The lane is also the duplicate-create admission guard, so the watcher
      // arms only once this flow's last step is done — armed at the forge's
      // answer, a fast list refetch could settle it mid-carry-over and a
      // remounted dialog would re-arm Publish over a PR that already exists.
      // Armed with the stamp captured at claim time: a stale one only yields a
      // watcher that no-ops and reaps itself, which is the designed outcome.
      if (outcome === "release") {
        settlePrCreate(repoPath, pr.head, "release");
      } else if (created && claimedAt !== null) {
        armPrCreateHandOff(queryClient, {
          repoPath,
          head: pr.head,
          lens: "origin",
          number: created.number,
          startedAt: claimedAt,
        });
      }
    }
  }

  const publishReason = (() => {
    switch (true) {
      case shownPending:
        return shownPendingReason;
      // The lane hint describes its own hold (aria-describedby below), and
      // outranks offline.
      case shownCreatingElsewhere:
        return undefined;
      case !!offlineHold:
        return offlineHold;
      case shownOtherPublishing:
        return "Another local pull request is still being published.";
      default:
        return undefined;
    }
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish this pull request to {remoteLabel}?</DialogTitle>
          <DialogDescription>
            Pushes <span className="font-mono">{pr.head}</span> to origin and
            opens a {prNoun} into <span className="font-mono">{pr.base}</span>{" "}
            with this title and description
            {shownCarriedCount > 0
              ? `, and re-posts its ${shownCarriedCount} comment${
                  shownCarriedCount === 1 ? "" : "s"
                }`
              : ""}
            . The local PR is closed first, then linked to its replacement once
            it's created.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:items-center">
          {shownLaneHint && (
            <p id={creatingHintId} className="basis-full text-xs text-warning">
              {shownLaneHint}
            </p>
          )}
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={draft}
              onCheckedChange={(checked) => setDraft(checked === true)}
            />
            Create as draft
          </label>
          <DisabledReasonButton
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={shownPending}
            reason={shownPendingReason}
          >
            Cancel
          </DisabledReasonButton>
          <DisabledReasonButton
            onClick={promote}
            disabled={
              shownPending ||
              shownOtherPublishing ||
              shownCreatingElsewhere ||
              !!offlineHold
            }
            reason={publishReason}
            aria-describedby={shownLaneHint ? creatingHintId : undefined}
          >
            {shownPending && <Spinner data-icon="inline-start" />}
            {draft ? "Publish as draft" : `Publish to ${remoteLabel}`}
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
