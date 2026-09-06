import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  DotsThreeIcon,
  PencilSimpleIcon,
} from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import type { MarkdownEditorHandle } from "@/components/markdown-editor";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { CommentComposer } from "@/features/conversations/CommentComposer";
import { DeleteCommentDialog } from "@/features/conversations/DeleteCommentDialog";
import {
  EditTitleBodyDialog,
  useEditTitleBody,
} from "@/features/conversations/EditTitleBodyDialog";
import { makeQuoteReply } from "@/features/conversations/quoteReply";
import { ReactionBar } from "@/features/conversations/ReactionBar";
import {
  AuthorAvatar,
  hasVisibleBody,
  Thread,
} from "@/features/conversations/Thread";
import { useMentionCandidates } from "@/features/conversations/useMentionCandidates";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import {
  sortTimeline,
  type TimelineEntry,
  TimelineEventRow,
} from "@/features/pulls/PrTimeline";
import { copyText } from "@/lib/clipboard";
import { presentError } from "@/lib/error-summary";
import type { LockReason, MinimizeReason } from "@/lib/git/api";
import { useForgeGhHost } from "@/lib/git/host";
import {
  forgeFeatureReady,
  TRIAGE_ACCESS_ITEM_REASON,
  triageAccessReason,
  useCloseIssue,
  useCommentIssue,
  useDeleteIssue,
  useDeleteIssueComment,
  useEditIssue,
  useEditIssueComment,
  useForgeStatus,
  useGhRepos,
  useGlMemberProjects,
  useIssueDetails,
  useIssueReactions,
  useIssueTimeline,
  useLockIssue,
  useMinimizeComment,
  usePinIssue,
  useReopenIssue,
  useRepoWriteAccess,
  useToggleReaction,
  useTransferIssue,
  useUnlockIssue,
  useUnminimizeComment,
  WRITE_ACCESS_ITEM_REASON,
  writeAccessReason,
} from "@/lib/git/queries";
import { providerLabel, type RemoteLens } from "@/lib/git/types";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { lensKey, useRepoLens } from "@/lib/repo-lens/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { parseableDate } from "@/lib/time";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import { useKeyedEntityState } from "@/lib/use-keyed-entity-state";
import { PlanIssueButton } from "../plan/PlanIssueButton";
import { SolveIssueButton } from "../sessions/SolveIssueButton";
import { IssueSubIssues } from "./IssueRelations";
import {
  DeleteIssueDialog,
  IssueSidebar,
  TransferIssueDialog,
} from "./RemoteIssueViewParts";

/** GitHub's lock reasons (menu label → API value); null locks with no reason. */
const LOCK_REASONS: [string, LockReason | null][] = [
  ["No reason", null],
  ["Off-topic", "off_topic"],
  ["Resolved", "resolved"],
  ["Spam", "spam"],
  ["Too heated", "too_heated"],
];

/** What the close prompt's title adds per route: GitHub's "not planned" close is
 *  a different act from a plain one, and only the title says so. */
const CLOSE_TITLE_QUALIFIER = {
  completed: "",
  not_planned: " as not planned",
} as const;

/**
 * Full read+write view for a GitHub issue: header, description, threaded
 * conversation, comment composer, label editor, close-with-reason / reopen, and
 * edit. Labels and comment edit/delete/hide reuse the PR GraphQL mutations,
 * which key off node ids and so work unchanged for issues.
 */
export function RemoteIssueView({
  repoPath,
  number,
}: {
  repoPath: string;
  number: number;
}) {
  // The read view is provider-neutral. The remaining GitHub-only mutations
  // (pin, sub-issues, close reason) route through `gh_*` commands and stay
  // gated on `canWrite` — "not a known read-only provider" rather than
  // `=== "github"`, so that while the (separate) forge-status query is still
  // pending or after it fails, a GitHub issue keeps its write controls exactly
  // as before — only an explicitly-detected GitLab/Bitbucket repo suppresses
  // them.
  const forge = useForgeStatus(repoPath);
  const provider = forge.data?.provider;
  const canWrite = provider !== "gitlab" && provider !== "bitbucket";
  const remoteLabel = providerLabel(provider);
  // The single lens-resolution point for this surface (package B2): every issue
  // read/write below targets the fork (origin) or its parent (upstream).
  const lens = useRepoLens(repoPath);
  const queryClient = useQueryClient();
  // The viewer's permission on the lens repo — a PERMISSION axis the per-action
  // flags below don't cover, so it never hides a control: it only disables one,
  // and only on an explicit denial. Triage is its own, LOWER tier: labels,
  // assignees, milestones, hide-comments, close/reopen and the other
  // issue-metadata rows come with it without push, so those read `canTriage`;
  // pin, transfer, delete and branch creation are write-tier. Each blocked flag
  // derives from its reason so the two can never disagree.
  const writeAccess = useRepoWriteAccess(repoPath, lens, !!provider);
  const writeReason = writeAccessReason(writeAccess.data);
  const triageReason = triageAccessReason(writeAccess.data);
  const writeBlocked = !!writeReason;
  const triageBlocked = !!triageReason;
  // A disabled menu item drops pointer events, so its explanation goes in the
  // label; each suffix is empty whenever its axis allows the action.
  const triageItemReason = triageReason ? TRIAGE_ACCESS_ITEM_REASON : undefined;
  const writeItemReason = writeReason ? WRITE_ACCESS_ITEM_REASON : undefined;
  const itemSuffix = writeItemReason ? ` — ${writeItemReason}` : "";
  const triageSuffix = triageItemReason ? ` — ${triageItemReason}` : "";
  // GitLab WRITES land per-action. Each shared control is
  // `canWrite || forgeFeatureReady(...)` so GitHub keeps its controls while a
  // forge-status query is pending/failed (canWrite default-true) AND a ready GitLab
  // repo positively enables just these.
  const canComment = canWrite || forgeFeatureReady(forge.data, "issueComment");
  const canChangeState =
    canWrite || forgeFeatureReady(forge.data, "issueState");
  // Labels + assignees are shared controls (both providers) — same `canWrite || …`
  // gate: GitHub keeps them up while forge-status is pending, GitLab un-gates when ready.
  const canEditLabels =
    canWrite || forgeFeatureReady(forge.data, "issueLabels");
  const canEditAssignees =
    canWrite || forgeFeatureReady(forge.data, "issueAssignees");
  // Title/body editing and the milestone picker are shared controls too.
  const canEdit = canWrite || forgeFeatureReady(forge.data, "issueEdit");
  const canSetMilestone =
    canWrite || forgeFeatureReady(forge.data, "issueMilestone");
  // Lock, transfer/move, delete, and duplicate are shared "More actions" too;
  // pin stays GitHub-only via `canWrite`. GitLab locks without a reason and
  // "moves" instead of transferring — labels/submenus branch on the provider.
  const isGitLab = provider === "gitlab";
  // Locking is write-tier on GitHub but only Reporter (triage) on GitLab, so
  // the lock arms take their axis from the provider.
  const lockBlocked = isGitLab ? triageBlocked : writeBlocked;
  const lockSuffix = isGitLab ? triageSuffix : itemSuffix;
  const canLock = canWrite || forgeFeatureReady(forge.data, "issueLock");
  const canTransfer =
    canWrite || forgeFeatureReady(forge.data, "issueTransfer");
  const canDelete = canWrite || forgeFeatureReady(forge.data, "issueDelete");
  const canDuplicate = canWrite || forgeFeatureReady(forge.data, "issueCreate");
  // Confidential + due date are GitLab-UNIQUE (no GitHub analogue), so unlike
  // the shared controls above there's no `canWrite ||` arm — the flag alone
  // gates, and it's false for GitHub.
  const canSetConfidential = forgeFeatureReady(forge.data, "issueConfidential");
  const canSetDueDate = forgeFeatureReady(forge.data, "issueDueDate");
  // Time tracking + related issues are GitLab-unique too — flag alone gates.
  const canTrackTime = forgeFeatureReady(forge.data, "timeTracking");
  const canLinkIssues = forgeFeatureReady(forge.data, "issueLinks");
  const details = useIssueDetails(repoPath, number, lens);
  const mentions = useMentionCandidates({ repoPath, lens, provider });
  const comment = useCommentIssue(repoPath, lens);
  const closeIssue = useCloseIssue(repoPath, lens);
  const reopenIssue = useReopenIssue(repoPath, lens);
  const editIssue = useEditIssue(repoPath, lens);
  const editComment = useEditIssueComment(repoPath, lens);
  const deleteComment = useDeleteIssueComment(repoPath, lens);
  const minimizeComment = useMinimizeComment(repoPath);
  const unminimizeComment = useUnminimizeComment(repoPath);
  const pinIssue = usePinIssue(repoPath, lens);
  const lockIssue = useLockIssue(repoPath, lens);
  const unlockIssue = useUnlockIssue(repoPath, lens);
  const transferIssue = useTransferIssue(repoPath, lens);
  const deleteIssue = useDeleteIssue(repoPath, lens);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const selectPr = useUiStore((s) => s.selectPr);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const selectedIssue = useUiStore((s) => s.selectedIssue);
  const setPendingIssueDraft = useUiStore((s) => s.setPendingIssueDraft);
  // Whether this view owns the current selection: the mounted view lags the
  // selection through a switch, and only the selected one may answer the palette.
  const isSelectedIssue =
    selectedIssue?.kind === "remote" && selectedIssue.id === String(number);
  // Reactions are a shared control (GitLab awards emoji); the fetch is gated so
  // it never fires for a provider whose reactions aren't wired (Bitbucket).
  const canReact = canWrite || forgeFeatureReady(forge.data, "issueReactions");
  // Editing/deleting your OWN comments is a shared control (GitHub + GitLab) —
  // same `canWrite || …` gate as comment CREATE above; the per-comment
  // `viewerDidAuthor` check narrows it to the author. Bitbucket issues aren't
  // wired, so `issueCommentEdit` is false there.
  const canEditOwnComments =
    canWrite || forgeFeatureReady(forge.data, "issueCommentEdit");
  const reactions = useIssueReactions(repoPath, canReact ? number : null, lens);
  // Activity-timeline events (labels, assignment, milestones, cross-references,
  // state changes) interleaved into the feed below; provider-neutral via the
  // backend's `forge_issue_timeline`. The composite gate is load-bearing: an
  // unresolved provider must not fetch, and Bitbucket issues aren't wired.
  const timelineEnabled = !!provider && provider !== "bitbucket";
  const timeline = useIssueTimeline(repoPath, number, timelineEnabled, lens);
  // Feed-constant, so it's read once here rather than per event row; the
  // repo-path variant avoids the active-repo hook's second store subscription.
  const ghHost = useForgeGhHost(repoPath);
  const toggleReactionMutation = useToggleReaction(
    repoPath,
    ["repo", repoPath, "issue", lens, number, "reactions"] as const,
    details.data?.id ?? "",
    { target: "issue", number },
  );

  const composerRef = useRef<MarkdownEditorHandle>(null);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferDest, setTransferDest] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const edit = useEditTitleBody({
    onSave: async ({ title, body }) => {
      await editIssue.mutateAsync({ number, title, body });
    },
    successToast: "Issue updated",
  });
  // A different issue must never inherit this one's open delete/transfer/edit
  // dialogs — a render-time state adjustment, not an effect. The lens is part of
  // the identity: it can collapse to "origin" without a remount (upstream remote
  // goes away), leaving the number pointing at another repo. The same identity
  // keys the sidebar below, remounting its own per-issue drafts.
  const issueIdentity = `${repoPath}#${lens}#${number}`;
  const compose = useKeyedEntityState(issueIdentity, "");
  const [lastIdentity, setLastIdentity] = useState(issueIdentity);
  if (issueIdentity !== lastIdentity) {
    setLastIdentity(issueIdentity);
    setDeletingCommentId(null);
    setDeleteOpen(false);
    setTransferOpen(false);
    setTransferDest("");
    edit.setOpen(false);
  }
  // Destination suggestions come from the viewer's repos on the SAME provider
  // as this repo; each query only fires while its dialog variant is open. The
  // GitLab list is repo-scoped so it targets the repo's own (possibly
  // self-managed) host, not glab's default.
  const transferRepos = useGhRepos(transferOpen && !isGitLab);
  const transferProjects = useGlMemberProjects(
    repoPath,
    transferOpen && isGitLab,
  );

  const onError = (e: unknown) => toastError(e);

  const issue = details.data;

  // The composer sits below the thread AND the sidebar, so reaching it by Tab
  // means crossing the whole rail — this is the keyboard route past it. Enabled
  // only while the box is actually on screen.
  useHotkeyAction(
    "focus-comment",
    () => composerRef.current?.focus(),
    isSelectedIssue &&
      canComment &&
      !!issue &&
      !details.isPlaceholderData &&
      !details.isError,
  );

  if (details.isPending) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (details.isError || !issue) {
    return (
      <DiffPlaceholder
        message={
          details.error
            ? presentError(details.error).summary
            : "Could not load this issue"
        }
        action={
          details.isError ? (
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={() => details.refetch()}
            >
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  }

  const isOpen = issue.state === "OPEN";
  // The rendered issue is the previous one during a switch while `number` is
  // already the new one, so everything that seeds a dialog from it, or reads a
  // verb off it, holds until the selected issue is on screen.
  const detailsStale = details.isPlaceholderData;
  // What a control that holds through the switch says, in one wording. It ranks
  // BELOW any permission reason wherever both hold: that one never lifts on its
  // own and is the one still true once the new issue is on screen.
  const staleReason = detailsStale ? "Loading this issue…" : undefined;
  const busy =
    comment.isPending ||
    closeIssue.isPending ||
    reopenIssue.isPending ||
    detailsStale;
  // Which term of `busy` the composer names, ranked: the switch window outranks a
  // write the viewer started, being the hold they can't have caused themselves.
  const composerReason = (() => {
    switch (true) {
      case detailsStale:
        return staleReason;
      case comment.isPending:
        return "Posting your comment…";
      case closeIssue.isPending:
        return "Closing this issue…";
      case reopenIssue.isPending:
        return "Reopening this issue…";
      default:
        return undefined;
    }
  })();
  const comments = issue.comments.filter((c) => hasVisibleBody(c.body));

  function submitComment() {
    const body = compose.value.trim();
    if (!body || detailsStale) return;
    // Clear the draft immediately (the perceived-speed win) and append the
    // synthetic comment optimistically; on error restore the draft, but only if
    // that issue's composer is still empty so we never clobber newly-typed text.
    const submittedFor = issueIdentity;
    compose.set("");
    void comment
      .mutateAsync({ number, body, author: forge.data?.login ?? "You" })
      .catch((e) => {
        compose.setFor(submittedFor, (prev) => (prev.trim() ? prev : body));
        onError(e);
      });
  }

  // Deferred into the handler: calling makeQuoteReply(ref) during render made the
  // React Compiler bail out of this whole component (refs-in-render rule).
  const quoteReply = (body: string) => {
    // Every quotable body — the issue's and each rendered comment's — belongs to
    // the issue on screen, which mid-switch is the previous one, while the draft
    // it would land in is keyed to the new one.
    if (detailsStale) return;
    makeQuoteReply({ composerRef, setBody: compose.set })(body);
  };

  // A typed draft rides Close/Reopen rather than being discarded by them. Gated
  // on `canComment` so the labels below never promise a comment the provider
  // won't take.
  const draftRidesStateChange = canComment && !!compose.value.trim();
  const draftSuffix = draftRidesStateChange ? " — posts your draft" : "";

  /** Posts the riding draft ahead of a state change. False means the comment
   *  failed and the state change is abandoned: the draft stays put for a retry,
   *  so a lost note can never be the price of a failed close. */
  async function postRidingDraft(): Promise<boolean> {
    if (!draftRidesStateChange) return true;
    const body = compose.value.trim();
    const submittedFor = issueIdentity;
    try {
      await comment.mutateAsync({
        number,
        body,
        author: forge.data?.login ?? "You",
      });
      // Only a landed comment clears the draft.
      compose.clearFor(submittedFor);
      return true;
    } catch (e) {
      onError(e);
      return false;
    }
  }

  async function doClose(reason: "completed" | "not_planned") {
    // The caret menu can sit open across a selection switch or a mutation, so
    // the hold has to be re-checked here — item clicks bypass the trigger's
    // disable.
    if (busy || triageBlocked) return;
    // Captured before the await: posting clears the draft, and the error arm
    // below has to know a comment already went out.
    const withComment = draftRidesStateChange;
    // Ahead of the riding draft: a cancelled confirm must leave the comment
    // unposted.
    const ok = await useConfirm.getState().ask({
      title: `Close issue #${number}${CLOSE_TITLE_QUALIFIER[reason]}?`,
      body: `Everyone watching is notified and the issue leaves the open list. Reopening puts it back, but the notification can't be unsent.${
        withComment ? " Your draft posts as a comment first." : ""
      }`,
      confirmLabel: withComment ? "Close with comment" : "Close issue",
    });
    if (!ok) return;
    if (!(await postRidingDraft())) return;
    try {
      await closeIssue.mutateAsync({ number, reason });
    } catch (e) {
      if (withComment) {
        toastErrorWithNote(
          e,
          "Your comment was posted, but closing failed — try Close again.",
        );
      } else {
        onError(e);
      }
      return;
    }
    toast.success(`Closed #${number}`);
  }

  async function doReopen() {
    if (busy || triageBlocked) return;
    const withComment = draftRidesStateChange;
    if (!(await postRidingDraft())) return;
    try {
      await reopenIssue.mutateAsync(number);
    } catch (e) {
      if (withComment) {
        toastErrorWithNote(
          e,
          "Your comment was posted, but reopening failed — try Reopen again.",
        );
      } else {
        onError(e);
      }
      return;
    }
    toast.success(`Reopened #${number}`);
  }

  function saveCommentEdit(commentId: string, body: string) {
    // The comment id is the rendered issue's while the write addresses `number`
    // — GitLab routes by both, so a mismatched pair 404s.
    if (detailsStale) return;
    // Detached: Thread closes its inline editor on submit, so there is nothing
    // left for an await to hold open.
    void editComment
      .mutateAsync({ number, commentId, body })
      .then(() => toast.success("Comment updated"))
      .catch(onError);
  }

  // Both take a comment id off the RENDERED issue, which through a switch is the
  // previous one, so either would hide a comment on the issue the viewer just
  // left. The menu items disable on the same wait; these arms back them up.
  async function hideComment(commentId: string, classifier: MinimizeReason) {
    if (detailsStale) return;
    try {
      await minimizeComment.mutateAsync({ commentId, classifier });
    } catch (e) {
      onError(e);
      return;
    }
    toast.success("Comment hidden");
  }

  async function unhideComment(commentId: string) {
    if (detailsStale) return;
    try {
      await unminimizeComment.mutateAsync(commentId);
    } catch (e) {
      onError(e);
      return;
    }
    toast.success("Comment shown");
  }

  function toggleReaction(subjectId: string, content: string, active: boolean) {
    // The subject is the rendered issue's body or one of its comments, while the
    // write and its optimistic patch address `number` — GitLab routes by both, so
    // a mismatched pair awards the wrong note or 404s. The bars disable on the
    // same flag; this arm is the belt-and-braces behind them.
    if (detailsStale) return;
    void toggleReactionMutation
      .mutateAsync({ subjectId, content, active })
      .catch(onError);
  }

  /** Opens the title/body editor seeded from the issue as it stands. */
  function openIssueEdit() {
    if (!issue || detailsStale) return;
    edit.openEdit({ title: issue.title, body: issue.body });
  }

  // Seeds + opens the GitHub create dialog (IssuesPanel consumes the draft).
  // Labels carry over since they're from this same repo.
  function duplicateIssue() {
    if (!issue || detailsStale) return;
    setPendingIssueDraft({
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((l) => l.name),
    });
  }

  /** Drill into a PR/issue a timeline reference row points at. The bare number it
   *  hands over resolves under the CURRENT lens, so the call site wires this only
   *  under the origin lens (see the lens note on `onOpenRef` there). Each arm is the
   *  navigation its own surface uses (Development panel / related issues). */
  function openRef(kind: "pr" | "issue", refNumber: number) {
    if (kind === "pr") {
      selectPr({ kind: "remote", id: String(refNumber) });
      setRepoTab("pulls");
      return;
    }
    selectIssue({ kind: "remote", id: String(refNumber) });
  }

  /** Clear the selection only while it still points at this issue — the write
   *  can settle after the user has selected another one. */
  // `selectedIssue` carries no lens, so a continuation fired on one side of a
  // fork pair must not clear a same-numbered selection made on the other. The
  // lens is read from the query cache, which outlives this instance (the lens
  // switcher unmounts it); an undefined read is a cold cache, not "origin".
  function deselectIfStillHere(firedUnder: RemoteLens | undefined) {
    const liveLens = queryClient.getQueryData<RemoteLens>(lensKey(repoPath));
    if (firedUnder !== undefined && liveLens !== firedUnder) return;
    const { selectedIssue: sel, repoPath: liveRepo } = useUiStore.getState();
    if (liveRepo !== repoPath) return;
    if (sel?.kind === "remote" && sel.id === String(number)) selectIssue(null);
  }

  async function submitTransfer() {
    const destination = transferDest.trim();
    if (!destination) return;
    const firedUnder = queryClient.getQueryData<RemoteLens>(lensKey(repoPath));
    let url: string;
    try {
      url = await transferIssue.mutateAsync({ number, destination });
    } catch (e) {
      onError(e);
      return;
    }
    toast.success(
      `${isGitLab ? "Moved" : "Transferred"} #${number}`,
      url
        ? {
            description: url,
            action: { label: "View", onClick: () => openUrl(url) },
          }
        : undefined,
    );
    setTransferOpen(false);
    // The issue no longer lives in this repo; clear the now-stale view.
    deselectIfStillHere(firedUnder);
  }

  async function confirmDelete() {
    const firedUnder = queryClient.getQueryData<RemoteLens>(lensKey(repoPath));
    try {
      await deleteIssue.mutateAsync(number);
    } catch (e) {
      onError(e);
      setDeleteOpen(false);
      return;
    }
    toast.success(`Deleted #${number}`);
    setDeleteOpen(false);
    deselectIfStillHere(firedUnder);
  }

  /** `wasPinned` comes from the render the click landed on: the refetch that
   *  follows already carries the new state, so the verb has to be captured. */
  async function togglePin(wasPinned: boolean) {
    try {
      await pinIssue.mutateAsync({ number, pinned: !wasPinned });
    } catch (e) {
      onError(e);
      return;
    }
    toast.success(wasPinned ? "Unpinned" : "Pinned");
  }

  async function doLock(reason: LockReason | null) {
    try {
      await lockIssue.mutateAsync({ number, reason });
    } catch (e) {
      onError(e);
      return;
    }
    toast.success("Conversation locked");
  }

  async function doUnlock() {
    try {
      await unlockIssue.mutateAsync(number);
    } catch (e) {
      onError(e);
      return;
    }
    toast.success("Conversation unlocked");
  }

  async function removeComment(commentId: string) {
    try {
      await deleteComment.mutateAsync({ number, commentId });
    } catch (e) {
      // Closes on failure too: DeleteCommentDialog never closes itself, and the
      // toast already carries the outcome.
      onError(e);
      setDeletingCommentId(null);
      return;
    }
    toast.success("Comment deleted");
    setDeletingCommentId(null);
  }

  // Repo suggestions for the transfer/move destination (excludes archived
  // repos, which can't receive issues); only loaded while the dialog is open.
  const repoQuery = transferDest.trim().toLowerCase();
  const repoSuggestions = (
    isGitLab
      ? (transferProjects.data ?? [])
      : (transferRepos.data?.repos ?? [])
          .filter((r) => !r.archived)
          .map((r) => r.nameWithOwner)
  )
    .filter((n) => !repoQuery || n.toLowerCase().includes(repoQuery))
    .slice(0, 6);

  // The activity feed: comments interleaved with timeline events, oldest→newest,
  // on the PR feed's slot convention (comments 2, events 3). Keys are slot-prefixed
  // because a comment id and an event index share one child list.
  const feedEntries: TimelineEntry[] = [];
  for (const c of comments) {
    feedEntries.push({
      date: c.date,
      sortKey: 2,
      node: (
        <Thread
          key={`comment-${c.id}`}
          thread={c}
          onQuote={
            canWrite && !detailsStale ? () => quoteReply(c.body) : undefined
          }
          onSaveEdit={
            canEditOwnComments && c.viewerDidAuthor && !detailsStale
              ? (body) => saveCommentEdit(c.id, body)
              : undefined
          }
          // Withholding the handler only drops the menu entry; an editor
          // already open when the switch began needs its Save held too.
          editHeld={detailsStale}
          onDelete={
            canEditOwnComments && c.viewerDidAuthor && !detailsStale
              ? () => setDeletingCommentId(c.id)
              : undefined
          }
          onHide={
            canWrite && !c.isMinimized
              ? (classifier) => void hideComment(c.id, classifier)
              : undefined
          }
          onUnhide={
            canWrite && c.isMinimized
              ? () => void unhideComment(c.id)
              : undefined
          }
          // Hide/Unhide stay visible but disabled through the switch. The
          // permission reason ranks first — it's the one still true once
          // the selected issue is on screen.
          disabledReason={triageItemReason ?? staleReason}
          reactions={canReact ? reactions.data?.comments[c.id] : undefined}
          onToggleReaction={
            canReact
              ? (content, active) => toggleReaction(c.id, content, active)
              : undefined
          }
          reactionsHeld={detailsStale}
          reactionsReason={staleReason}
          mentions={mentions}
        />
      ),
    });
  }
  // Details keep the PREVIOUS issue painted through a switch while the timeline
  // keys on the NEW number and can resolve first — hold events until the
  // identities agree, or the feed interleaves two issues.
  for (const [i, ev] of (detailsStale ? [] : (timeline.data ?? [])).entries()) {
    feedEntries.push({
      date: ev.date,
      sortKey: 3,
      node: (
        <TimelineEventRow
          key={`event-${i}`}
          event={ev}
          ghHost={ghHost}
          // `ForgeStatus.repo` is the ORIGIN slug, so a chip's same-repo verdict is
          // only trustworthy under the origin lens: off it, a ref living in the fork
          // matches the slug while the drill-in resolves against the upstream repo
          // and lands on a different entity. BOTH props gate on the lens — the
          // handler so off-lens refs are inert, and selfRepo so they keep their
          // explicit owner/name prefix instead of reading as this repo's number.
          onOpenRef={lens === "origin" ? openRef : undefined}
          selfRepo={
            lens === "origin" ? (forge.data?.repo ?? undefined) : undefined
          }
        />
      ),
    });
  }
  const feed = sortTimeline(feedEntries);

  // The close/reopen arm LEADS the bottom bar in both permission states — inside
  // the composer's action row (Comment is the primary and stays last), or alone
  // in the bar when the provider permits state changes but not comments, so
  // Close keeps the same corner either way. The composer call site supplies its
  // own spacer; the state-only bar left-aligns, so this fragment carries none.
  const stateActions = (
    <>
      {canChangeState &&
        (isOpen ? (
          <>
            {/* The label swaps while a draft rides along: the action changed
                meaning, and only the label reaches a viewer before the click. */}
            <DisabledReasonButton
              variant="outline"
              size="sm"
              disabled={busy || triageBlocked}
              reason={triageReason ?? staleReason}
              onClick={() => doClose("completed")}
              title={
                draftRidesStateChange
                  ? "Closes and posts your draft as a comment"
                  : undefined
              }
            >
              {draftRidesStateChange ? "Close with comment" : "Close issue"}
            </DisabledReasonButton>
            {/* Close reasons are a GitHub concept; GitLab has none. The caret is
                a menu TRIGGER: native `disabled` holds the menu shut, and the
                hint rides a wrapping span since a disabled Button swallows
                `title` (house trigger idiom). */}
            {canWrite && (
              <DropdownMenu>
                <span
                  title={triageReason ?? staleReason}
                  className="inline-flex"
                >
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label="Other close options"
                        disabled={busy || triageBlocked}
                      />
                    }
                  >
                    <CaretDownIcon />
                  </DropdownMenuTrigger>
                </span>
                <DropdownMenuContent align="end" className="min-w-52">
                  {/* A menu item drops pointer events when disabled and has no
                      room for a title, so the draft promise rides the label —
                      the same reason-in-label idiom the items above use. */}
                  <DropdownMenuItem onClick={() => doClose("completed")}>
                    Close as completed{draftSuffix}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => doClose("not_planned")}>
                    Close as not planned{draftSuffix}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        ) : (
          <DisabledReasonButton
            variant="outline"
            size="sm"
            disabled={busy || triageBlocked}
            reason={triageReason ?? staleReason}
            onClick={doReopen}
            title={
              draftRidesStateChange
                ? "Reopens and posts your draft as a comment"
                : undefined
            }
          >
            <ArrowCounterClockwiseIcon data-icon="inline-start" />
            {draftRidesStateChange ? "Reopen with comment" : "Reopen"}
          </DisabledReasonButton>
        ))}
    </>
  );

  return (
    <div className="@container/issue-detail flex h-full flex-col">
      <header className="space-y-2 border-b px-4 py-3">
        {/* `flex-auto`, not `flex-1`: a basis-0 title never triggers the wrap, so
            the actions would stay put and the title collapse instead. Growing also
            replaces the spacer that used to right-align them. */}
        <div className="flex flex-wrap items-start gap-2">
          <h2 className="min-w-0 flex-auto text-sm font-medium break-words">
            {issue.title}{" "}
            <span className="font-normal text-muted-foreground">
              #{issue.number}
            </span>
          </h2>
          {/* Both seed an AI run from the rendered issue, so they're absent while
              that issue isn't the one you selected. */}
          {!detailsStale && (
            <>
              <PlanIssueButton title={issue.title} body={issue.body} />
              {isOpen && (
                <SolveIssueButton
                  repoPath={repoPath}
                  title={issue.title}
                  body={issue.body}
                />
              )}
            </>
          )}
          {isOpen && canEdit && (
            // A natively-disabled Button swallows its own `title`, so the wait
            // needs the reason prop to reach the viewer at all.
            <DisabledReasonButton
              variant="outline"
              size="xs"
              disabled={detailsStale}
              reason={staleReason}
              onClick={openIssueEdit}
              title="Edit the title and description"
            >
              <PencilSimpleIcon data-icon="inline-start" />
              Edit
            </DisabledReasonButton>
          )}
          <Button
            variant="outline"
            size="xs"
            onClick={() => openUrl(issue.url)}
            title={`Open this issue on ${remoteLabel}`}
            className="cursor-pointer"
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            {remoteLabel}
          </Button>
          {(canLock || canDuplicate || canTransfer || canDelete) && (
            <DropdownMenu>
              {/* Every item but Transfer is withheld while the rendered issue is
                  the previous one, so hold the menu shut rather than open a near-
                  empty popup; the reason rides a wrapping span since a disabled
                  Button swallows `title` (house trigger idiom). */}
              <span title={staleReason} className="inline-flex">
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="xs"
                      aria-label="More actions"
                      disabled={detailsStale}
                    />
                  }
                >
                  <DotsThreeIcon className="size-4" weight="bold" />
                </DropdownMenuTrigger>
              </span>
              <DropdownMenuContent align="end" className="min-w-52">
                {/* Absent while a placeholder is served: the verb comes from the
                    rendered issue's pin state while the write addresses
                    `number`, and a disabled item can't say why it's held. */}
                {canWrite && !detailsStale && (
                  <DropdownMenuItem
                    disabled={writeBlocked}
                    onClick={() => void togglePin(issue.isPinned)}
                  >
                    {issue.isPinned ? "Unpin issue" : "Pin issue"}
                    {itemSuffix}
                  </DropdownMenuItem>
                )}
                {/* Absent while a placeholder is served: which affordance renders
                    comes from the LOADED issue's lock state, so a click during that
                    window would lock or unlock the issue you actually selected. */}
                {canLock &&
                  !detailsStale &&
                  (issue.locked ? (
                    <DropdownMenuItem
                      disabled={lockBlocked}
                      onClick={() => void doUnlock()}
                    >
                      Unlock conversation{lockSuffix}
                    </DropdownMenuItem>
                  ) : isGitLab ? (
                    // GitLab locks without a reason — a plain item, no submenu.
                    <DropdownMenuItem
                      disabled={lockBlocked}
                      onClick={() => void doLock(null)}
                    >
                      Lock conversation{lockSuffix}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuSub>
                      {/* The vendored sub-trigger carries no disabled styling
                          of its own (unlike menu items), so the dim rides a
                          call-site class. */}
                      <DropdownMenuSubTrigger
                        disabled={writeBlocked}
                        className="data-disabled:opacity-50"
                      >
                        Lock conversation…{itemSuffix}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {LOCK_REASONS.map(([label, reason]) => (
                          <DropdownMenuItem
                            key={reason ?? "none"}
                            onClick={() => void doLock(reason)}
                          >
                            {label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                {/* Both items above it are absent while stale, so the rule would
                    otherwise open the menu with nothing over it. */}
                {(canWrite || canLock) && !detailsStale && (
                  <DropdownMenuSeparator />
                )}
                {/* Absent while a placeholder is served: the draft it seeds is the
                    rendered issue's, which isn't the one you selected. */}
                {canDuplicate && !detailsStale && (
                  <DropdownMenuItem onClick={duplicateIssue}>
                    Duplicate issue
                  </DropdownMenuItem>
                )}
                {canTransfer && (
                  <DropdownMenuItem
                    disabled={writeBlocked}
                    onClick={() => {
                      setTransferDest("");
                      setTransferOpen(true);
                    }}
                  >
                    {isGitLab ? "Move issue…" : "Transfer issue…"}
                    {itemSuffix}
                  </DropdownMenuItem>
                )}
                {/* Absent while a placeholder is served: the confirm names the
                    rendered issue's title while the delete addresses `number`,
                    and a disabled item can't say why it's held. */}
                {canDelete && !detailsStale && (
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={writeBlocked}
                    onClick={() => setDeleteOpen(true)}
                  >
                    Delete issue…{itemSuffix}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={isOpen ? "default" : "secondary"}>
            {issue.state.toLowerCase()}
          </Badge>
          {issue.isPinned && <Badge variant="secondary">pinned</Badge>}
          {issue.locked && (
            <Badge variant="secondary">
              locked
              {issue.activeLockReason
                ? ` · ${issue.activeLockReason.replace(/_/g, "-")}`
                : ""}
            </Badge>
          )}
          <AuthorAvatar
            login={issue.author}
            avatarUrl={issue.authorAvatarUrl}
          />
          <span>{issue.author || "unknown"}</span>
          {parseableDate(issue.createdAt) && (
            <>
              <span>•</span>
              <span>
                opened <RelativeTime date={issue.createdAt} />
              </span>
            </>
          )}
        </div>
      </header>
      {/* Below ~672px of pane the 256px rail leaves under ~57ch of body, so it
          stacks under the thread instead (see IssueRail). */}
      <div className="flex min-h-0 flex-1 @max-2xl/issue-detail:flex-col">
        {/* `min-h-0` only bites once stacked: the auto minimum size applies to the
            flex MAIN axis, so in the column the body would otherwise floor at its
            thread's full height and push a scrollbar onto the document. */}
        <div className="flex min-w-0 flex-1 flex-col @max-2xl/issue-detail:min-h-0">
          {/* overflow-hidden contains the thread's natural height (vendored Root is
              `relative`-only) so a long issue can't leak a window scrollbar. */}
          <ScrollArea className="min-h-0 flex-1 overflow-hidden">
            <div className="space-y-4 p-4">
              <div className="group space-y-1">
                <p className="flex items-center gap-2 text-xs">
                  <AuthorAvatar
                    login={issue.author}
                    avatarUrl={issue.authorAvatarUrl}
                  />
                  <span className="font-medium">
                    {issue.author || "unknown"}
                  </span>
                  {parseableDate(issue.createdAt) && (
                    <span className="text-muted-foreground">
                      opened <RelativeTime date={issue.createdAt} />
                    </span>
                  )}
                  <span className="flex-1" />
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label="Description actions"
                          className="text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
                        />
                      }
                    >
                      <DotsThreeIcon className="size-4" weight="bold" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                      <DropdownMenuItem
                        onClick={() => copyText(issue.url, "Link copied")}
                      >
                        Copy link
                      </DropdownMenuItem>
                      {/* Absent, not disabled, while the body belongs to the
                          previous issue — the same shape the comment menus take
                          when their `onQuote` is withheld. */}
                      {canWrite &&
                        hasVisibleBody(issue.body) &&
                        !detailsStale && (
                          <DropdownMenuItem
                            onClick={() => quoteReply(issue.body)}
                          >
                            Quote reply
                          </DropdownMenuItem>
                        )}
                      <DropdownMenuItem
                        onClick={() => copyText(issue.body, "Markdown copied")}
                      >
                        Copy markdown
                      </DropdownMenuItem>
                      {/* Absent, not disabled, while the description belongs to
                          the previous issue: the dialog seeds from it, and a
                          disabled item drops pointer events so no hint could
                          reach the viewer to explain it. */}
                      {isOpen && canEdit && !detailsStale && (
                        <DropdownMenuItem onClick={openIssueEdit}>
                          Edit
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </p>
                {hasVisibleBody(issue.body) ? (
                  <Markdown refs={mentions.refs}>{issue.body}</Markdown>
                ) : (
                  <p className="text-xs text-muted-foreground italic">
                    No description provided.
                  </p>
                )}
                {canReact && (
                  // The counts are a read and stay; only the toggles hold.
                  <ReactionBar
                    reactions={reactions.data?.body ?? []}
                    disabled={detailsStale}
                    reason={staleReason}
                    onToggle={(content, active) =>
                      toggleReaction(issue.id, content, active)
                    }
                  />
                )}
              </div>
              {canWrite && (
                <IssueSubIssues
                  // Remounts per issue like the sidebar: its add/create state is
                  // local, and a dialog left open across a switch would re-point
                  // its parent id as the placeholder resolves.
                  key={issueIdentity}
                  repoPath={repoPath}
                  issueId={issue.id}
                  number={number}
                  lens={lens}
                  // The writes take the rendered issue's id while the list is
                  // fetched for `number` — hold them until the two agree. A
                  // viewer who can't write hears that first instead: their reason
                  // is the one still true once the switch lands.
                  disabledReason={writeReason ?? staleReason}
                />
              )}
              {feed.map((e) => e.node)}
              {/* Wait for the timeline too: on an events-only issue the details
                  can resolve first and flash this before the rows arrive. A
                  DISABLED timeline query never leaves pending, so it can't be
                  the thing waited on — when the forge probe settles without
                  enabling it, no events are coming and the line shows. */}
              {feed.length === 0 &&
                !forge.isPending &&
                (!timelineEnabled || !timeline.isPending) && (
                  <p className="text-xs text-muted-foreground">
                    No comments yet.
                  </p>
                )}
            </div>
          </ScrollArea>
        </div>
        <IssueSidebar
          // Remounts the rail per issue so its sections' drafts (the uncontrolled
          // "Add spent" input, the link picker) can't commit against a new number.
          key={issueIdentity}
          repoPath={repoPath}
          number={number}
          issue={issue}
          canWrite={canWrite}
          canEditLabels={canEditLabels}
          canEditAssignees={canEditAssignees}
          canSetMilestone={canSetMilestone}
          canSetConfidential={canSetConfidential}
          canSetDueDate={canSetDueDate}
          canTrackTime={canTrackTime}
          canLinkIssues={canLinkIssues}
          remoteLabel={remoteLabel}
          lens={lens}
          // The remount clears the rail's drafts, but `issue` is still the
          // placeholder through a switch and every picker seeds from it, so they
          // hold until details are fresh — triage first, since it outlasts the wait.
          pickerDisabledReason={triageReason ?? staleReason}
          writeItemReason={writeItemReason}
        />
      </div>
      {/* Below the thread AND the rail: the conversation is the widest thing on
          this surface, so the box you write in spans the same width the other
          conversation surfaces (which have no rail) already get.
          Comment is allowed after the issue closes too, matching GitHub. On
          GitLab the composer + close/reopen show, but the GitHub-only
          close-reason dropdown stays hidden (GitLab has no reasons);
          Bitbucket has neither, so the whole bar hides. */}
      {canComment ? (
        <CommentComposer
          ref={composerRef}
          ariaLabel="Leave a comment"
          placeholder="Leave a comment…"
          value={compose.value}
          onChange={compose.set}
          onSubmit={submitComment}
          mentions={mentions}
          submitLabel="Comment"
          busy={busy}
          reason={composerReason}
          // Close/reopen lead, Comment ends the row where a form's submit is
          // looked for. Clear is site-rendered rather than the shared `onClear`
          // one so it sits just left of Comment: the shared Clear is `ml-auto`,
          // which would put it past the submit button.
          leadingActions={
            <>
              {stateActions}
              <span className="flex-1" />
              {compose.value.trim() && (
                <DisabledReasonButton
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  reason={composerReason}
                  onClick={() => compose.set("")}
                  title="Discard this draft (e.g. a quote reply)"
                >
                  Clear
                </DisabledReasonButton>
              )}
            </>
          }
        />
      ) : canChangeState ? (
        <div className="space-y-2 border-t p-3">
          <div className="flex items-center gap-2">{stateActions}</div>
        </div>
      ) : null}

      <EditTitleBodyDialog
        form={edit.form}
        open={edit.open}
        onOpenChange={edit.setOpen}
        title="Edit issue"
        description={`Updates the title and description of #${number} on ${remoteLabel}.`}
        contentClassName="sm:max-w-lg"
        bodyTextareaClassName="max-h-72 min-h-24 resize-y font-mono"
        mentions={mentions}
      />

      <DeleteCommentDialog
        commentId={deletingCommentId}
        onClose={() => setDeletingCommentId(null)}
        pending={deleteComment.isPending}
        description={`This permanently deletes the comment on ${remoteLabel}. This cannot be undone.`}
        onConfirm={(commentId) => void removeComment(commentId)}
      />

      <TransferIssueDialog
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        number={number}
        dest={transferDest}
        onDestChange={setTransferDest}
        suggestions={repoSuggestions}
        pending={transferIssue.isPending}
        onSubmit={() => void submitTransfer()}
        move={isGitLab}
      />

      <DeleteIssueDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        number={number}
        title={issue.title}
        pending={deleteIssue.isPending}
        onConfirm={() => void confirmDelete()}
        remoteLabel={remoteLabel}
        roleHint={
          isGitLab ? "needs Owner access" : "requires admin or triage access"
        }
      />
    </div>
  );
}
