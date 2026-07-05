import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
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
import { forgeIssueComment } from "@/lib/git/api";
import { useCreateIssue, useForgeStatus } from "@/lib/git/queries";
import type { LocalIssue } from "@/lib/issues/local";
import { useUpdateLocalIssue } from "@/lib/issues/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";

/**
 * Publishes a local issue to the repo's provider (GitHub or GitLab): opens a real
 * issue with the same title/description, **re-posts its comments** (so nothing is
 * lost), then closes the local issue with a link to its successor. Deliberately
 * fires no automations — the local issue's creation was the trigger point, not this.
 */
export function PromoteLocalIssueDialog({
  repoPath,
  issue,
  open,
  onOpenChange,
}: {
  repoPath: string;
  issue: LocalIssue;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createIssue = useCreateIssue(repoPath);
  const update = useUpdateLocalIssue(repoPath);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const forge = useForgeStatus(repoPath);
  const remoteLabel = forge.data?.provider === "gitlab" ? "GitLab" : "GitHub";
  const [pending, setPending] = useState(false);

  const carried = issue.comments.filter((c) => c.body.trim());

  async function promote() {
    setPending(true);
    try {
      const { number, url } = await createIssue.mutateAsync({
        title: issue.title,
        body: issue.body,
        // Local labels are free-form and may not exist remotely; leave them off.
        labels: [],
        assignees: [],
        milestone: null,
        type: null,
      });
      // Carry the local comments over, in order, so none are lost.
      for (const c of carried) {
        await forgeIssueComment(repoPath, number, c.body);
      }
      await update.mutateAsync({
        id: issue.id,
        mutate: (cur) => ({
          ...cur,
          status: "closed",
          closedAt: new Date().toISOString(),
          comments: [
            ...cur.comments,
            {
              id: crypto.randomUUID(),
              body: `Promoted to ${remoteLabel} issue [#${number}](${url}).`,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
      toast.success(`Opened issue #${number}`, {
        description: url,
        action: { label: "View", onClick: () => openUrl(url) },
      });
      onOpenChange(false);
      selectIssue({ kind: "remote", id: String(number) });
    } catch (e) {
      toastError(e);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish this issue to {remoteLabel}?</DialogTitle>
          <DialogDescription>
            Opens a new issue on {remoteLabel} with this title and description
            {carried.length > 0
              ? ` and re-posts its ${carried.length} comment${
                  carried.length === 1 ? "" : "s"
                }`
              : ""}
            . The local issue is then closed with a link to its replacement.
            Free-form local labels aren't carried over.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={promote} disabled={pending}>
            {pending && <Spinner data-icon="inline-start" />}
            Publish to {remoteLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
