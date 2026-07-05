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
import { useUiStore } from "@/lib/stores/ui";
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
    try {
      const { number, url } = await createPr.mutateAsync({
        base: pr.base,
        head: pr.head,
        title: pr.title,
        body: pr.body,
        draft,
      });
      // Carry the local comments over, in order, so none are lost.
      setPosting(true);
      try {
        for (const c of carried) {
          await forgePrComment(repoPath, number, c.body);
        }
      } finally {
        setPosting(false);
      }
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
      selectPr({ kind: "remote", id: String(number) });
    } catch (e) {
      toastError(e);
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
