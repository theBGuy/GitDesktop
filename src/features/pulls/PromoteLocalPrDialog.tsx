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
import {
  settlePrCreate,
  startPrCreate,
  useIsCreatingPr,
} from "@/lib/stores/pr-create";
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
  // open a PR for it, so either one running blocks the other (and paints the
  // same strip above the panels). `!pending` narrows it to the RE-ENTRY case —
  // promote claims the lane synchronously, so the flag is also true during this
  // dialog's own run, where `pending` is the honest thing to show.
  const creatingElsewhere = useIsCreatingPr(repoPath, pr.head) && !pending;
  const creatingHintId = useId();

  // Visible comments, in order — skip empty + hidden (collapsed) ones.
  const carried = pr.comments.filter((c) => c.body.trim() && !c.hidden);

  async function promote() {
    // Fire-time admission, claimed before the first await: the push plus the
    // forge call outlives this dialog, and a second create for the same head
    // would queue on the repo lock and then open a duplicate PR.
    const refusal = startPrCreate(repoPath, pr.head, pr.base);
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
      toast.success(`Opened ${prNoun} #${number}`, {
        description: url,
        action: { label: "View", onClick: () => openUrl(url) },
      });
      onOpenChange(false);
      // The promoted PR lives on the fork (origin) — force the origin lens so the
      // Pulls tab shows it (clearing any stale remote selection) before selecting.
      setLens("origin");
      selectPr({ kind: "remote", id: String(number) });
    } catch (e) {
      if (created === null) {
        // The create itself failed — retrying is correct, keep the dialog open.
        toastError(e);
        return;
      }
      // The remote PR already exists. Close the dialog (leaving it open is a
      // duplicate factory) and disclose what was created and what failed. The
      // local PR is left untouched so the user can reconcile manually.
      const { number, url } = created;
      onOpenChange(false);
      toast.error(
        `Created ${prNoun} #${number}, but ${failedStep} failed: ${errorMessage(e)}`,
        {
          duration: 10000,
          action: { label: "View", onClick: () => openUrl(url) },
        },
      );
    } finally {
      settlePrCreate(repoPath, pr.head, outcome);
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
          {creatingElsewhere && (
            <p id={creatingHintId} className="basis-full text-xs text-warning">
              A pull request for this branch is already being created.
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
            aria-describedby={creatingElsewhere ? creatingHintId : undefined}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {draft ? "Publish as draft" : `Publish to ${remoteLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
