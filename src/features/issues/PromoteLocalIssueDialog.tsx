import { KanbanIcon } from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
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
import { presentError } from "@/lib/error-summary";
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
import {
  pendingWriteReason,
  refuseWhileOffline,
  useOfflineHold,
} from "@/lib/offline-writes";
import { useSetRepoLens } from "@/lib/repo-lens/queries";
import { landedIn } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { toastComposedError, toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import { cn } from "@/lib/utils";

type Destination = "forge" | "jira";

/** The Jira toasts' View, success and partial failure alike. */
const JIRA_VIEW_LABEL = "View in Jira";

/**
 * Publishes a local issue to a real tracker — the repo's forge (GitHub or
 * GitLab) or the linked Jira project. It closes the local issue FIRST, then
 * opens a real issue with the same title/description, links the local issue to
 * its successor and **re-posts its comments** (so nothing is lost). Closing
 * first means a dropped connection can't leave both copies open; a create that
 * fails reopens it. When both destinations are available the user picks one;
 * when only one is, that's the whole flow.
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
  // Promotion always targets the fork's own remote (origin) — never the parent.
  const createIssue = useCreateIssue(repoPath, "origin");
  const update = useUpdateLocalIssue(repoPath);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const setLens = useSetRepoLens(repoPath);

  const forge = useForgeStatus(repoPath);
  const remoteLabel = forge.data?.provider === "gitlab" ? "GitLab" : "GitHub";
  const canPublishForge = forgeFeatureReady(forge.data, "issueCreate");
  // Both forge toasts' View, named only once the forge status has answered:
  // `remoteLabel` defaults to GitHub, and submit isn't gated on the status.
  const forgeViewLabel = forge.data ? `View on ${remoteLabel}` : undefined;

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
  // Init unconditionally to "forge"; the effect below settles the real default
  // once the async gates resolve (a bare init can't, since both gates are still
  // pending at mount).
  const [destination, setDestination] = useState<Destination>("forge");
  // True once the user has explicitly toggled the destination — after that the
  // auto-default effect must not override their pick (only the hidden-destination
  // force-switch below still applies).
  const userPicked = useRef(false);
  // Keep the selection sensible as the async gates resolve (the forge status +
  // Jira permission probes land at different times, often out of order). Two
  // rules:
  //   1. Auto-default only while the user hasn't picked: forge-first when both
  //      are available, jira when only jira is. This is what makes forge win the
  //      race even if the (cached) Jira gate resolves first.
  //   2. Force-switch away from a destination whose gate just turned false —
  //      applies EVEN after a user pick, because a hidden destination must never
  //      be the one that submits.
  useEffect(() => {
    if (!userPicked.current) {
      if (canPublishForge) setDestination("forge");
      else if (canPublishJira) setDestination("jira");
      return;
    }
    // User has picked: only correct an impossible selection.
    setDestination((cur) => {
      if (cur === "forge" && !canPublishForge && canPublishJira) return "jira";
      if (cur === "jira" && !canPublishJira && canPublishForge) return "forge";
      return cur;
    });
  }, [canPublishForge, canPublishJira]);

  // The promote in flight: its destination and carried comment count, which its
  // dialog keeps showing while the shared toggles change or its back-link lands,
  // and its repo and issue, since the host reuses this dialog across local issues.
  const [pendingPub, setPendingPub] = useState<{
    to: Destination;
    repo: string;
    issueId: string;
    count: number;
  } | null>(null);
  const ownPub =
    pendingPub !== null &&
    pendingPub.repo === repoPath &&
    pendingPub.issueId === issue.id
      ? pendingPub
      : null;
  const ownPendingTo = ownPub?.to ?? null;
  // Any other issue's dialog holds only its Publish. Repo-blind on purpose: one
  // slot tracks one run, and the hold copy stays true wherever it shows.
  const otherPublishing = pendingPub !== null && ownPub === null;
  // Both destinations hold offline rather than park: the local issue closes
  // before the create, so a parked create lost to an app quit would strand it
  // closed with no successor. A create that parks anyway (the connection dropped
  // after the press) is what the pending reason below covers.
  const offlineHold = useOfflineHold();
  const destinationLabel: Record<Destination, string> = {
    forge: remoteLabel,
    jira: "Jira",
  };
  const createPaused: Record<Destination, boolean> = {
    forge: createIssue.isPaused,
    jira: jiraCreate.isPaused,
  };
  const pendingReason =
    ownPendingTo === null
      ? undefined
      : pendingWriteReason(
          createPaused[ownPendingTo],
          `Creating the ${destinationLabel[ownPendingTo]} issue…`,
        );

  const carried = issue.comments.filter((c) => c.body.trim());
  // Retained through the close fade, so the look holds while the live state
  // clears; while this issue's run is in flight, the count is the one it carries.
  const shownPendingTo = useRetained(ownPendingTo, open);
  const shownPending = shownPendingTo !== null;
  const shownPendingReason = useRetained(pendingReason, open);
  const shownOtherPublishing = useRetained(otherPublishing, open);
  const shownCarriedCount = useRetained(
    ownPub ? ownPub.count : carried.length,
    open,
  );
  // The destination the dialog shows: the run's own while one is in flight.
  const shownTarget = shownPendingTo ?? destination;

  /** Whether a settle may still close and navigate: its repo is the live one AND
   *  this local issue is still selected. The host keeps one `promoteOpen` state
   *  for the whole view and blanks it when the selection moves, so a close
   *  landing on another issue's confirm would shut a dialog the user opened for
   *  something else. Read after the await, from the store, never from render. */
  function stillOnThisIssue(live: boolean): boolean {
    const { selectedIssue } = useUiStore.getState();
    return (
      live && selectedIssue?.kind === "local" && selectedIssue.id === issue.id
    );
  }

  const targetLabel = destinationLabel[shownTarget];
  // The auto-resolved Jira type; absent until types load. Its absence disables
  // the Jira submit so we never fire a create with no type.
  const jiraTypeId = creatableTypes[0]?.id ?? null;
  const jiraReady = shownTarget !== "jira" || jiraTypeId !== null;
  // Explain WHY the Jira submit is dead (never a title on a disabled button):
  // still loading the project's types, or the project has none we can create.
  const jiraLoadingTypes = shownTarget === "jira" && jiraTypes.isPending;
  const jiraTypesError = shownTarget === "jira" && jiraTypes.isError;
  const jiraNoTypes =
    shownTarget === "jira" &&
    !jiraTypes.isPending &&
    !jiraTypes.isError &&
    creatableTypes.length === 0;

  async function promoteForge() {
    // The host offers Publish only on an open issue; this is what a failed
    // create restores, and `closedAt` stays null until the local close landed.
    const prior = { status: issue.status, closedAt: issue.closedAt };
    let closedAt: string | null = null;
    // Once the remote issue exists, later steps (the back-link, comment
    // carry-over) failing must NOT re-arm the submit — retrying would open a
    // duplicate. Track it so the catch can disclose instead of re-running.
    let created: { number: number; url: string } | null = null;
    let failedStep = "linking the local issue";
    try {
      // Closed before the create: the local close lands even offline, so a
      // connection lost mid-flow can't leave this issue open beside its successor.
      const stamp = new Date().toISOString();
      await closeLocal(stamp);
      closedAt = stamp;
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
      // The back-link before the carry, so a carry failure still leaves it.
      await linkLocal(`Promoted to ${remoteLabel} issue [#${number}](${url}).`);
      failedStep = "carrying over comments";
      for (const c of carried) {
        await forgeIssueComment(repoPath, number, c.body, "origin");
      }
      // One read for both halves: the toast is unconditional and names the repo
      // when it isn't the one on screen, while the navigation below only lands
      // while this repo and this local issue still are — landed elsewhere it
      // would close a dialog the user reopened there and pull them back.
      const { live, away } = landedIn(repoPath);
      toast.success(`Opened issue #${number}${away}`, {
        description: url,
        action: {
          label: forgeViewLabel ?? "View",
          onClick: () => openUrl(url),
        },
      });
      // The promoted issue lives on the fork (origin) — force the origin lens so
      // the Issues tab shows it (and any stale remote selection is cleared) before
      // navigating to it.
      if (stillOnThisIssue(live)) {
        // A settle's close must commit before the finally's `setPendingPub(null)`
        // renders while open, or the twins retain the cleared state.
        flushSync(() => onOpenChange(false));
        setLens("origin");
        selectIssue({ kind: "remote", id: String(number) });
      }
    } catch (e) {
      if (created === null) {
        // Nothing remote exists, so retrying is correct: keep the dialog open.
        await failBeforeCreate(e, closedAt, prior, `${remoteLabel} issue`);
        return;
      }
      // The remote issue already exists and the local issue is already closed.
      // Close the dialog anyway (a retry from it would open a duplicate) and
      // disclose what was created and what failed; a missing back-link or comment
      // is left for the user to reconcile. The close names its subject as well as
      // its repo, while the toast names only the REPO, since that is the part the
      // user can't see for themselves.
      const { number, url } = created;
      const { live, away } = landedIn(repoPath);
      if (stillOnThisIssue(live)) flushSync(() => onOpenChange(false));
      toastComposedError({
        title: `Created issue #${number}${away}, but ${failedStep} failed: ${presentError(e).summary}`,
        errors: [e],
        view: { url, label: forgeViewLabel },
        duration: 10000,
      });
    }
  }

  async function promoteJira() {
    if (!link || jiraTypeId === null) return;
    // Same retry-safety invariant as the forge path, tracked independently per
    // destination: once the Jira issue exists, a failure in a later step must
    // disclose rather than re-run (a retry would create a duplicate).
    const prior = { status: issue.status, closedAt: issue.closedAt };
    let closedAt: string | null = null;
    let created: { key: string; url: string } | null = null;
    let failedStep = "linking the local issue";
    try {
      // Closed first, as on the forge path.
      const stamp = new Date().toISOString();
      await closeLocal(stamp);
      closedAt = stamp;
      const { key, url } = await jiraCreate.mutateAsync({
        issueTypeId: jiraTypeId,
        summary: issue.title,
        descriptionMd: issue.body.trim() || undefined,
      });
      created = { key, url };
      await linkLocal(`Promoted to Jira issue [${key}](${url}).`);
      failedStep = "carrying over comments";
      for (const c of carried) {
        await jiraIssueComment(link.siteHost, key, c.body);
      }
      // Same one read as the forge path: the toast names its repo either way, the
      // selection and close only land while that repo and this local issue are
      // the ones on screen. The pinned `useJiraCreateIssue` means this
      // continuation outlives the detach a switch causes, so it has to answer
      // for where it ended up.
      const { live, away } = landedIn(repoPath);
      toast.success(`Created ${key}${away}`, {
        description: url,
        action: { label: JIRA_VIEW_LABEL, onClick: () => openUrl(url) },
      });
      if (stillOnThisIssue(live)) {
        flushSync(() => onOpenChange(false));
        selectIssue({ kind: "jira", id: key });
      }
    } catch (e) {
      if (created === null) {
        await failBeforeCreate(e, closedAt, prior, "Jira issue");
        return;
      }
      // Same subject-and-repo close as the forge path.
      const { key, url } = created;
      const { live, away } = landedIn(repoPath);
      if (stillOnThisIssue(live)) flushSync(() => onOpenChange(false));
      toastComposedError({
        title: `Created ${key}${away}, but ${failedStep} failed: ${presentError(e).summary}`,
        errors: [e],
        view: { url, label: JIRA_VIEW_LABEL },
        duration: 10000,
      });
    }
  }

  // The provider-agnostic local writes both destinations make, one per step.
  // Each is a functional update, so a concurrent MCP edit to the same record
  // survives it.
  function closeLocal(closedAt: string) {
    return update.mutateAsync({
      id: issue.id,
      mutate: (cur) => ({ ...cur, status: "closed", closedAt }),
    });
  }

  function linkLocal(body: string) {
    return update.mutateAsync({
      id: issue.id,
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

  /** The failure path of a create that produced nothing remote: undoes
   *  {@link closeLocal} BEFORE toasting, so the retry-capable dialog sits over a
   *  record that reads open again. The undo touches only status/closedAt, and
   *  only while the record still carries this flow's close: anything else
   *  changed it since, and that change wins. A null `closedAt` means the close
   *  itself failed and no create was attempted. */
  async function failBeforeCreate(
    e: unknown,
    closedAt: string | null,
    prior: Pick<LocalIssue, "status" | "closedAt">,
    noun: string,
  ) {
    if (closedAt !== null) {
      try {
        await update.mutateAsync({
          id: issue.id,
          mutate: (cur) =>
            cur.status === "closed" && cur.closedAt === closedAt
              ? { ...cur, status: prior.status, closedAt: prior.closedAt }
              : cur,
        });
      } catch (reopenError) {
        toastComposedError({
          title: `Couldn't create the ${noun}: ${presentError(e).summary}`,
          description:
            "The local issue couldn't be reopened — reopen it from its view.",
          errors: [e, reopenError],
          headings: [`Creating the ${noun}`, "Reopening the local issue"],
        });
        return;
      }
    }
    toastError(e);
  }

  async function promote() {
    // The look is retained through the close fade; these live gates add `open`
    // and one run at a time, since `pendingPub` holds a single run.
    if (!open || pendingPub !== null || refuseWhileOffline()) return;
    setPendingPub({
      to: destination,
      repo: repoPath,
      issueId: issue.id,
      count: carried.length,
    });
    try {
      if (destination === "jira") await promoteJira();
      else await promoteForge();
    } finally {
      setPendingPub(null);
    }
  }

  const publishReason = (() => {
    switch (true) {
      case shownPending:
        return shownPendingReason;
      // Offline outranks another issue's run: nothing publishes until the
      // connection returns.
      case !!offlineHold:
        return offlineHold;
      case shownOtherPublishing:
        return "Another local issue is still being published.";
      default:
        return undefined;
    }
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish this issue to {targetLabel}?</DialogTitle>
          <DialogDescription>
            Opens a new issue on {targetLabel} with this title and description
            {shownCarriedCount > 0
              ? ` and re-posts its ${shownCarriedCount} comment${
                  shownCarriedCount === 1 ? "" : "s"
                }`
              : ""}
            . The local issue is closed first, then linked to its replacement
            once it's created. Free-form local labels aren't carried over.
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
            <div
              className="flex gap-2"
              role="group"
              aria-label="Publish destination"
            >
              <DisabledReasonButton
                variant={shownTarget === "forge" ? "secondary" : "outline"}
                wrapperClassName="flex-1"
                className={cn(
                  "w-full",
                  shownTarget === "forge" && "font-medium",
                )}
                aria-pressed={shownTarget === "forge"}
                onClick={() => {
                  userPicked.current = true;
                  setDestination("forge");
                }}
                disabled={shownPending}
                reason={shownPendingReason}
              >
                {remoteLabel}
              </DisabledReasonButton>
              <DisabledReasonButton
                variant={shownTarget === "jira" ? "secondary" : "outline"}
                wrapperClassName="flex-1"
                className={cn(
                  "w-full",
                  shownTarget === "jira" && "font-medium",
                )}
                aria-pressed={shownTarget === "jira"}
                onClick={() => {
                  userPicked.current = true;
                  setDestination("jira");
                }}
                disabled={shownPending}
                reason={shownPendingReason}
              >
                <KanbanIcon data-icon="inline-start" />
                Jira
              </DisabledReasonButton>
            </div>
          </div>
        )}

        {jiraLoadingTypes && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner data-icon="inline-start" />
            Loading issue types…
          </p>
        )}
        {jiraTypesError && (
          <div className="flex items-center gap-2 border px-3 py-2 text-xs text-muted-foreground">
            <span className="flex-1">Couldn't load Jira issue types.</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => jiraTypes.refetch()}
            >
              Retry
            </Button>
          </div>
        )}
        {jiraNoTypes && (
          <p className="text-xs text-warning">
            This Jira project has no creatable issue type — create one in Jira
            or check your project permissions.
          </p>
        )}

        <DialogFooter>
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
              !jiraReady ||
              !!offlineHold
            }
            reason={publishReason}
          >
            {shownPending && <Spinner data-icon="inline-start" />}
            Publish to {targetLabel}
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
