import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
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
import type { LocalPr } from "@/lib/pulls/local";
import { useUpdateLocalPr } from "@/lib/pulls/queries";
import { useSetRepoLens } from "@/lib/repo-lens/queries";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";

/**
 * Publishes a local PR to the repo's provider (GitHub or GitLab): pushes the head
 * branch, opens a real PR/MR with the same title/description, **re-posts its
 * comments** (so nothing is lost), then closes the local PR with a link to its
 * successor. Fires no automations — the local PR's creation was the pr-open
 * trigger point (see CreateLocalPrDialog), so promoting it would double-run them.
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
  const remoteLabel = isGitLab ? "GitLab" : "GitHub";
  const prNoun = isGitLab ? "merge request" : "pull request";
  const [draft, setDraft] = useState(false);
  const [posting, setPosting] = useState(false);
  const pending = createPr.isPending || update.isPending || posting;

  // Visible comments, in order — skip empty + hidden (collapsed) ones.
  const carried = pr.comments.filter((c) => c.body.trim() && !c.hidden);

  async function promote() {
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
          <Button onClick={promote} disabled={pending}>
            {pending && <Spinner data-icon="inline-start" />}
            {draft ? "Publish as draft" : `Publish to ${remoteLabel}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
