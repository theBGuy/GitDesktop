import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
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
import { forgePrComment } from "@/lib/git/api";
import { useCreatePr, useForgeStatus } from "@/lib/git/queries";
import { providerLabel } from "@/lib/git/types";
import type { LocalPr } from "@/lib/pulls/local";
import { useUpdateLocalPr } from "@/lib/pulls/queries";
import { useSetRepoLens } from "@/lib/repo-lens/queries";
import { repoNameFromPath } from "@/lib/stores/notifications";
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
import { errorMessage } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";

/**
 * Publishes a local PR to the repo's provider (GitHub, GitLab, or Bitbucket):
 * pushes the head branch, opens a real PR/MR with the same title/description,
 * **re-posts its comments** (so nothing is lost), then closes the local PR with
 * a link to its successor. Fires no automations — the local PR's creation was
 * the pr-open trigger point (see CreateLocalPrDialog), so promoting it would
 * double-run them.
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
  const prNoun = isGitLab ? "merge request" : "pull request";
  const [draft, setDraft] = useState(false);
  const [posting, setPosting] = useState(false);
  const pending = createPr.isPending || update.isPending || posting;
  // Shares the PR-create lane with CreatePrDialog: both push the same head and
  // open a PR for it, so either one holding the lane blocks the other (and
  // paints the same strip above the panels). The lane is held through the whole
  // catch-up window after the forge answers, not just while the call runs, so
  // the hint reads the PHASE — a non-null one IS the lane. `!pending` narrows
  // to the RE-ENTRY case: promote claims the lane synchronously, so a phase is
  // also present during this dialog's own run, where `pending` is what to show —
  // up to a cross-repo navigation that re-renders this view in place, which
  // detaches the pinned create mutation: `pending` goes idle there while the
  // promote runs on, and the phase read here is the new repo's.
  const lanePhase = usePrCreatePhase(repoPath, pr.head);
  const creatingElsewhere = lanePhase !== null && !pending;
  const laneHint = creatingElsewhere
    ? LANE_BLOCKED_HINT[lanePhase](prNoun)
    : null;
  const creatingHintId = useId();

  // Visible comments, in order — skip empty + hidden (collapsed) ones.
  const carried = pr.comments.filter((c) => c.body.trim() && !c.hidden);

  async function promote() {
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
    // "release", not "error": a failed promote produced no draft, so it frees
    // the lane without latching over a real create failure for this branch.
    let outcome: "success" | "release" = "release";
    // Once the remote PR exists, later steps (comment carry-over, closing the
    // local PR) failing must NOT re-arm the submit — retrying would open a
    // duplicate. Track it so the catch can disclose instead of re-running.
    let created: { number: number; url: string } | null = null;
    let failedStep = "finishing up";
    try {
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
      // Carry the local comments over, in order, so none are lost.
      failedStep = "carrying over comments";
      setPosting(true);
      try {
        for (const c of carried) {
          await forgePrComment(repoPath, number, c.body, undefined, "origin");
        }
      } finally {
        setPosting(false);
      }
      failedStep = "closing the local pull request";
      await update.mutateAsync({
        id: pr.id,
        mutate: (cur) => ({
          ...cur,
          status: "closed",
          comments: [
            ...cur.comments,
            {
              id: crypto.randomUUID(),
              body: `Promoted to ${remoteLabel} ${prNoun} [#${number}](${url}).`,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
      // One read for both halves: the toast is unconditional and names the repo
      // when it isn't the one on screen, while the navigation below only lands
      // when it is. That navigation is the lens flip plus the selection plus the
      // close, and this continuation outlives the host's unmount on a repo
      // switch: landed elsewhere they would close a dialog the user reopened
      // there and point that repo's Pulls tab at a number belonging to this one.
      const live = useUiStore.getState().repoPath === repoPath;
      toast.success(
        `Opened ${prNoun} #${number}${live ? "" : ` in ${repoNameFromPath(repoPath)}`}`,
        {
          description: url,
          action: { label: "View", onClick: () => openUrl(url) },
        },
      );
      // The promoted PR lives on the fork (origin) — force the origin lens so the
      // Pulls tab shows it (clearing any stale remote selection) before selecting.
      if (live) {
        onOpenChange(false);
        setLens("origin");
        selectPr({ kind: "remote", id: String(number) });
      }
    } catch (e) {
      if (created === null) {
        // The create itself failed — retrying is correct, keep the dialog open.
        toastError(e);
        return;
      }
      // The remote PR already exists. Close the dialog (leaving it open on this
      // pull request is a duplicate factory — the local PR wasn't closed, so it
      // still reads as promotable) and disclose what was created and what
      // failed. The local PR is left untouched so the user can reconcile
      // manually. The close names its SUBJECT as well as its repo: the host
      // keeps one `promoteOpen` state and already blanks it when the selection
      // moves, so a close landing on another pull request's confirm protects
      // nothing here and shuts a dialog the user opened for something else.
      const { number, url } = created;
      const ui = useUiStore.getState();
      const live = ui.repoPath === repoPath;
      // The close needs the subject too; the toast names only the REPO, since
      // that is the part the user can't see for themselves.
      const onThisPr =
        live && ui.selectedPr?.kind === "local" && ui.selectedPr.id === pr.id;
      if (onThisPr) onOpenChange(false);
      toast.error(
        `Created ${prNoun} #${number}${live ? "" : ` in ${repoNameFromPath(repoPath)}`}, but ${failedStep} failed: ${errorMessage(e)}`,
        {
          duration: 10000,
          action: { label: "View", onClick: () => openUrl(url) },
        },
      );
    } finally {
      // The lane is also the duplicate-create admission guard, so the watcher
      // arms only once this flow's last step is done — armed at the forge's
      // answer, a fast list refetch could settle it mid-carry-over and a
      // remounted dialog would re-arm Publish over a PR that already exists.
      // Armed with the entry's OWN startedAt: a fresh clock read would let this
      // watcher settle a later create that re-claimed the head.
      if (outcome === "release") {
        settlePrCreate(repoPath, pr.head, "release");
      } else if (created) {
        const startedAt = prCreateStartedAt(repoPath, pr.head);
        if (startedAt !== null)
          armPrCreateHandOff(queryClient, {
            repoPath,
            head: pr.head,
            lens: "origin",
            number: created.number,
            startedAt,
          });
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish this pull request to {remoteLabel}?</DialogTitle>
          <DialogDescription>
            Pushes <span className="font-mono">{pr.head}</span> to origin and
            opens a {prNoun} into <span className="font-mono">{pr.base}</span>{" "}
            with this title and description
            {carried.length > 0
              ? `, and re-posts its ${carried.length} comment${
                  carried.length === 1 ? "" : "s"
                }`
              : ""}
            . The local PR is then closed with a link to its replacement.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:items-center">
          {laneHint && (
            <p id={creatingHintId} className="basis-full text-xs text-warning">
              {laneHint}
            </p>
          )}
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={draft}
              onCheckedChange={(checked) => setDraft(checked === true)}
            />
            Create as draft
          </label>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            onClick={promote}
            disabled={pending || creatingElsewhere}
            aria-describedby={laneHint ? creatingHintId : undefined}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {draft ? "Publish as draft" : `Publish to ${remoteLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
