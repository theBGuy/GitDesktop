import { KanbanIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
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
import {
  forgeFeatureReady,
  useCreateIssue,
  useForgeStatus,
} from "@/lib/git/queries";
import type { LocalIssue } from "@/lib/issues/local";
import { useUpdateLocalIssue } from "@/lib/issues/queries";
import { jiraIssueComment } from "@/lib/jira/api";
import {
  useJiraCreateIssue,
  useJiraIssueTypes,
  useJiraLink,
  useJiraPermissions,
} from "@/lib/jira/queries";
import { useUiStore } from "@/lib/stores/ui";
import { errorMessage } from "@/lib/tauri/invoke";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

type Destination = "forge" | "jira";

/**
 * Publishes a local issue to a real tracker — the repo's forge (GitHub or
 * GitLab) or the linked Jira project — opening a real issue with the same
 * title/description, **re-posting its comments** (so nothing is lost), then
 * closing the local issue with a link to its successor. When both destinations
 * are available the user picks one; when only one is, that's the whole flow.
 * Deliberately fires no automations — the local issue's creation was the trigger
 * point, not this.
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
  const canPublishForge = forgeFeatureReady(forge.data, "issueCreate");

  const link = useJiraLink(repoPath).data;
  const jiraPerms = useJiraPermissions(repoPath, link);
  const canPublishJira = !!link && (jiraPerms.data?.createIssues ?? false);
  const jiraCreate = useJiraCreateIssue(repoPath, link);
  // Fetch the project's issue types only while the dialog is open AND Jira is a
  // possible destination — no picker here, so we auto-resolve the first
  // creatable (`!subtask`) type, mirroring CreateJiraIssueDialog.
  const jiraTypes = useJiraIssueTypes(repoPath, link, open && canPublishJira);
  const creatableTypes = useMemo(
    () => (jiraTypes.data ?? []).filter((t) => !t.subtask),
    [jiraTypes.data],
  );

  const bothAvailable = canPublishForge && canPublishJira;
  const [destination, setDestination] = useState<Destination>(
    canPublishForge ? "forge" : "jira",
  );
  // Keep the selection valid as the async gates resolve (e.g. the Jira
  // permission probe lands after mount). When only one destination is possible,
  // force it; otherwise default to the forge on first availability.
  useEffect(() => {
    if (canPublishForge && !canPublishJira) setDestination("forge");
    else if (canPublishJira && !canPublishForge) setDestination("jira");
  }, [canPublishForge, canPublishJira]);

  const [pending, setPending] = useState(false);

  const carried = issue.comments.filter((c) => c.body.trim());

  const targetLabel = destination === "jira" ? "Jira" : remoteLabel;
  // The auto-resolved Jira type; absent until types load. Its absence disables
  // the Jira submit so we never fire a create with no type.
  const jiraTypeId = creatableTypes[0]?.id ?? null;
  const jiraReady = destination !== "jira" || jiraTypeId !== null;
  // Explain WHY the Jira submit is dead (never a title on a disabled button):
  // still loading the project's types, or the project has none we can create.
  const jiraLoadingTypes = destination === "jira" && jiraTypes.isPending;
  const jiraNoTypes =
    destination === "jira" &&
    !jiraTypes.isPending &&
    !jiraTypes.isError &&
    creatableTypes.length === 0;

  async function promoteForge() {
    // Once the remote issue exists, later steps (comment carry-over, closing the
    // local issue) failing must NOT re-arm the submit — retrying would open a
    // duplicate. Track it so the catch can disclose instead of re-running.
    let created: { number: number; url: string } | null = null;
    let failedStep = "finishing up";
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
      created = { number, url };
      failedStep = "carrying over comments";
      for (const c of carried) {
        await forgeIssueComment(repoPath, number, c.body);
      }
      failedStep = "closing the local issue";
      await closeLocalWithBackLink(
        `Promoted to ${remoteLabel} issue [#${number}](${url}).`,
      );
      toast.success(`Opened issue #${number}`, {
        description: url,
        action: { label: "View", onClick: () => openUrl(url) },
      });
      onOpenChange(false);
      selectIssue({ kind: "remote", id: String(number) });
    } catch (e) {
      if (created === null) {
        // The create itself failed — retrying is correct, keep the dialog open.
        toastError(e);
        return;
      }
      const { number, url } = created;
      onOpenChange(false);
      toast.error(
        `Created issue #${number}, but ${failedStep} failed: ${errorMessage(e)}`,
        {
          duration: 10000,
          action: { label: "View", onClick: () => openUrl(url) },
        },
      );
    }
  }

  async function promoteJira() {
    if (!link || jiraTypeId === null) return;
    // Same retry-safety invariant as the forge path, tracked independently per
    // destination: once the Jira issue exists, a failure in a later step must
    // disclose rather than re-run (a retry would create a duplicate).
    let created: { key: string; url: string } | null = null;
    let failedStep = "finishing up";
    try {
      const { key, url } = await jiraCreate.mutateAsync({
        issueTypeId: jiraTypeId,
        summary: issue.title,
        descriptionMd: issue.body.trim() || undefined,
      });
      created = { key, url };
      failedStep = "carrying over comments";
      for (const c of carried) {
        await jiraIssueComment(link.siteHost, key, c.body);
      }
      failedStep = "closing the local issue";
      await closeLocalWithBackLink(`Promoted to Jira issue [${key}](${url}).`);
      toast.success(`Created ${key}`, {
        description: url,
        action: { label: "View", onClick: () => openUrl(url) },
      });
      onOpenChange(false);
      selectIssue({ kind: "jira", id: key });
    } catch (e) {
      if (created === null) {
        toastError(e);
        return;
      }
      const { key, url } = created;
      onOpenChange(false);
      toast.error(
        `Created ${key}, but ${failedStep} failed: ${errorMessage(e)}`,
        {
          duration: 10000,
          action: { label: "View", onClick: () => openUrl(url) },
        },
      );
    }
  }

  // Provider-agnostic final step: close the local issue with a back-link comment
  // to its successor. Shared by both destinations, unchanged from the original.
  async function closeLocalWithBackLink(backLink: string) {
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
            body: backLink,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    });
  }

  async function promote() {
    setPending(true);
    try {
      if (destination === "jira") await promoteJira();
      else await promoteForge();
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish this issue to {targetLabel}?</DialogTitle>
          <DialogDescription>
            Opens a new issue on {targetLabel} with this title and description
            {carried.length > 0
              ? ` and re-posts its ${carried.length} comment${
                  carried.length === 1 ? "" : "s"
                }`
              : ""}
            . The local issue is then closed with a link to its replacement.
            Free-form local labels aren't carried over.
          </DialogDescription>
        </DialogHeader>

        {bothAvailable && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              Publish to
            </p>
            {/* Segmented toggle: two Tab-focusable buttons with aria-pressed,
                matching the app's existing segmented-tab idiom (each is its own
                tab stop; Enter/Space toggles). */}
            <div className="flex gap-2" aria-label="Publish destination">
              <Button
                variant={destination === "forge" ? "secondary" : "outline"}
                className={cn(
                  "flex-1",
                  destination === "forge" && "font-medium",
                )}
                aria-pressed={destination === "forge"}
                onClick={() => setDestination("forge")}
                disabled={pending}
              >
                {remoteLabel}
              </Button>
              <Button
                variant={destination === "jira" ? "secondary" : "outline"}
                className={cn(
                  "flex-1",
                  destination === "jira" && "font-medium",
                )}
                aria-pressed={destination === "jira"}
                onClick={() => setDestination("jira")}
                disabled={pending}
              >
                <KanbanIcon data-icon="inline-start" />
                Jira
              </Button>
            </div>
          </div>
        )}

        {jiraLoadingTypes && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner data-icon="inline-start" />
            Loading issue types…
          </p>
        )}
        {jiraNoTypes && (
          <p className="text-xs text-warning">
            This Jira project has no creatable issue type — create one in Jira
            or check your project permissions.
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={promote} disabled={pending || !jiraReady}>
            {pending && <Spinner data-icon="inline-start" />}
            Publish to {targetLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
