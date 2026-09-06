import {
  ArrowSquareOutIcon,
  CaretUpIcon,
  CheckCircleIcon,
  DotsThreeIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { CommentComposer } from "@/features/conversations/CommentComposer";
import { DeleteCommentDialog } from "@/features/conversations/DeleteCommentDialog";
import { LabelsPopover } from "@/features/conversations/LabelsPopover";
import { makeQuoteReply } from "@/features/conversations/quoteReply";
import { ReactionBar } from "@/features/conversations/ReactionBar";
import {
  AuthorAvatar,
  hasVisibleBody,
  Thread,
} from "@/features/conversations/Thread";
import { useMentionCandidates } from "@/features/conversations/useMentionCandidates";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { ScopeRefreshHint } from "@/features/repo-settings/ScopeRefreshHint";
import { copyText } from "@/lib/clipboard";
import type {
  DiscussionCloseReason,
  DiscussionLockReason,
  MinimizeReason,
} from "@/lib/git/api";
import {
  useAddDiscussionComment,
  useCloseDiscussion,
  useDeleteDiscussion,
  useDeleteDiscussionComment,
  useDiscussionDetails,
  useDiscussionReactions,
  useLockDiscussion,
  useMarkDiscussionAnswer,
  useMinimizeComment,
  useReopenDiscussion,
  useToggleDiscussionUpvote,
  useToggleReaction,
  useUnlockDiscussion,
  useUnminimizeComment,
  useUpdateDiscussionComment,
} from "@/lib/git/queries";
import type { PrThreadOut } from "@/lib/git/types";
import { SUBMIT_HINT } from "@/lib/hotkeys/binding";
import { useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useConfirm } from "@/lib/stores/confirm";
import { useUiStore } from "@/lib/stores/ui";
import { parseableDate } from "@/lib/time";
import { toastError, toastErrorWithNote } from "@/lib/toast";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { useKeyedEntityState } from "@/lib/use-keyed-entity-state";
import { cn } from "@/lib/utils";

/** A discussion comment/reply shares the conversation shape minus review state. */
function toThread(c: {
  author: string;
  body: string;
  date: string;
  id: string;
  url?: string;
  viewerDidAuthor: boolean;
  isMinimized: boolean;
  minimizedReason: string;
}): PrThreadOut {
  return {
    author: c.author,
    // Discussions are GitHub-only, so the avatar is login-derived on the frontend.
    authorAvatarUrl: "",
    state: "",
    body: c.body,
    date: c.date,
    id: c.id,
    url: c.url ?? "",
    viewerDidAuthor: c.viewerDidAuthor,
    isMinimized: c.isMinimized,
    minimizedReason: c.minimizedReason,
    // Discussion comments belong to no review.
    reviewId: "",
  };
}

/** GitHub's discussion lock reasons (menu label → GraphQL LockReason). */
const LOCK_REASONS: [string, DiscussionLockReason | null][] = [
  ["No reason", null],
  ["Off-topic", "OFF_TOPIC"],
  ["Resolved", "RESOLVED"],
  ["Spam", "SPAM"],
  ["Too heated", "TOO_HEATED"],
];

const CLOSE_REASONS: [string, DiscussionCloseReason][] = [
  ["Resolved", "RESOLVED"],
  ["Outdated", "OUTDATED"],
  ["Duplicate", "DUPLICATE"],
];

/** Which comment the reply box is open under, and the text typed into it —
 *  one value so both travel together per discussion. */
type ReplyDraft = { targetId: string | null; body: string };
const EMPTY_REPLY: ReplyDraft = { targetId: null, body: "" };

/** The `useDisabledReason` contract on a plain `<button>` — the chip carries its
 *  own sizing, which none of the vendored Button's sizes match (same arm as
 *  `ReactionButton`, which it sits beside). */
function UpvoteButton({
  count,
  active,
  onClick,
  disabled,
  reason,
}: {
  count: number;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** Why the toggle is held — shown and announced while `disabled` holds.
   *  Absent leaves a native disable, which explains nothing. */
  reason?: string | null;
}) {
  const title = active ? "Remove upvote" : "Upvote";
  const { blockedReason, reasonId, wrapperTitle, describedBy, nativeProps } =
    useDisabledReason({ disabled, reason, title, onClick });

  return (
    <span
      className={cn("inline-flex", blockedReason && "cursor-not-allowed")}
      title={wrapperTitle}
    >
      <button
        {...nativeProps}
        type="button"
        aria-label={`Upvote, ${count}`}
        aria-pressed={active}
        aria-describedby={describedBy}
        title={title}
        className={cn(
          ARIA_DISABLED_CLASS,
          "flex items-center gap-1 border px-1.5 py-0.5 text-[11px] tabular-nums transition-colors",
          active
            ? "border-primary bg-primary/10 text-foreground"
            : "text-muted-foreground hover:bg-muted/60",
        )}
      >
        <CaretUpIcon className="size-3" weight="bold" />
        {count}
      </button>
      {blockedReason ? (
        <span id={reasonId} className="sr-only">
          {blockedReason}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Read + write view for a GitHub Discussion: header (labels, reference-in-new-
 * issue), body, the two-level thread (comments + nested replies), upvotes,
 * reactions, a comment composer, threaded replies, mark-as-answer, and comment
 * edit/delete/hide.
 */
export function DiscussionView({
  repoPath,
  number,
}: {
  repoPath: string;
  number: number;
}) {
  const details = useDiscussionDetails(repoPath, number);
  // Discussions are a GitHub-only surface, and one that never carries the
  // origin/upstream lens — the parent's discussions aren't reachable from here.
  const mentions = useMentionCandidates({
    repoPath,
    lens: "origin",
    provider: "github",
  });
  const reactions = useDiscussionReactions(repoPath, number);
  const addComment = useAddDiscussionComment(repoPath);
  const markAnswer = useMarkDiscussionAnswer(repoPath);
  const updateComment = useUpdateDiscussionComment(repoPath);
  const deleteComment = useDeleteDiscussionComment(repoPath);
  const minimizeComment = useMinimizeComment(repoPath);
  const unminimizeComment = useUnminimizeComment(repoPath);
  const toggleUpvoteMutation = useToggleDiscussionUpvote(repoPath, number);
  const toggleReactionMutation = useToggleReaction(
    repoPath,
    ["repo", repoPath, "discussion", number, "reactions"] as const,
    details.data?.id ?? "",
  );
  const lockDiscussion = useLockDiscussion(repoPath);
  const unlockDiscussion = useUnlockDiscussion(repoPath);
  const closeDiscussion = useCloseDiscussion(repoPath);
  const reopenDiscussion = useReopenDiscussion(repoPath);
  const deleteDiscussion = useDeleteDiscussion(repoPath);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const setPendingIssueDraft = useUiStore((s) => s.setPendingIssueDraft);
  const selectDiscussion = useUiStore((s) => s.selectDiscussion);
  const selectedDiscussion = useUiStore((s) => s.selectedDiscussion);

  const composerRef = useRef<MarkdownEditorHandle>(null);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
  const [deletingDiscussion, setDeletingDiscussion] = useState(false);
  // The repo is part of the identity because discussion numbers repeat across
  // repos.
  const discussionIdentity = `${repoPath}#${number}`;
  const compose = useKeyedEntityState(discussionIdentity, "");
  const reply = useKeyedEntityState(
    discussionIdentity,
    EMPTY_REPLY,
    (v) => v.targetId === null && v.body === "",
  );
  // A different discussion must never inherit this one's delete confirm — a
  // render-time state adjustment, not an effect.
  const [lastIdentity, setLastIdentity] = useState(discussionIdentity);
  if (discussionIdentity !== lastIdentity) {
    // Reply drafts reset on switch, unlike the compose draft: the reply box
    // autoFocuses, so a restored one would steal focus and scroll on return.
    reply.clearFor(lastIdentity);
    setLastIdentity(discussionIdentity);
    setDeletingCommentId(null);
    setDeletingDiscussion(false);
  }

  const onError = (e: unknown) => toastError(e);
  const d = details.data;

  // The palette's route to the comment box, so reaching it never depends on
  // tabbing the whole thread. Only the view that owns the selection answers —
  // the mounted one lags it through a switch.
  useHotkeyAction(
    "focus-comment",
    () => composerRef.current?.focus(),
    selectedDiscussion?.number === number &&
      !!d &&
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
  if (details.isError || !d) {
    return <DiffPlaceholder message="Could not load this discussion" />;
  }

  // Placeholder details are the previous discussion's, and every write on this
  // surface addresses `d.id` — so all of them hold until the rendered discussion
  // is the selected one, or they land on the discussion the viewer just left.
  const detailsStale = details.isPlaceholderData;
  // Matches the wording the PR and issue views use for the same wait.
  const staleReason = detailsStale ? "Loading this discussion…" : undefined;
  // A disabled menu item drops pointer events, so its reason rides the label.
  const staleSuffix = staleReason ? ` — ${staleReason}` : "";
  const busy =
    addComment.isPending ||
    markAnswer.isPending ||
    deleteComment.isPending ||
    detailsStale;
  // Which term of `busy` a control disabled on it names, ranked: the switch window
  // outranks a write the viewer started, being the hold they can't have caused.
  const busyReason = (() => {
    switch (true) {
      case detailsStale:
        return staleReason;
      case addComment.isPending:
        return "Posting your comment…";
      case markAnswer.isPending:
        return "Updating the answer…";
      case deleteComment.isPending:
        return "Deleting a comment…";
      default:
        return undefined;
    }
  })();
  const upvoteHeld = toggleUpvoteMutation.isPending || detailsStale;
  // Ranked like `busyReason`: the switch window outranks the write the viewer
  // started, being the hold they can't have caused themselves.
  const upvoteReason = (() => {
    switch (true) {
      case detailsStale:
        return staleReason;
      case toggleUpvoteMutation.isPending:
        return "Recording your upvote…";
      default:
        return undefined;
    }
  })();
  // A typed draft rides Close/Reopen rather than being discarded by them.
  const draftRidesStateChange = !!compose.value.trim();
  // Both live on menu items, which drop pointer events when disabled and have no
  // room for a title, so the draft promise rides the label like the reasons
  // above — but a hold outranks it: a held item posts nothing.
  const draftSuffix =
    staleSuffix || (draftRidesStateChange ? " — posts your draft" : "");

  // Every write below awaits `mutateAsync` (or detaches with a `.catch`):
  // react-query drops per-call callbacks once the observer loses its listeners,
  // so a tab hide or unmount mid-flight would land the mutation and silently
  // lose the toast, draft clear, or close.
  async function submitComment() {
    if (!d || detailsStale || !compose.value.trim()) return;
    const submittedFor = discussionIdentity;
    try {
      await addComment.mutateAsync({
        discussionId: d.id,
        body: compose.value.trim(),
      });
    } catch (e) {
      onError(e);
      return;
    }
    compose.clearFor(submittedFor);
  }

  async function submitReply(commentId: string) {
    if (!d || detailsStale || !reply.value.body.trim()) return;
    const submittedFor = discussionIdentity;
    try {
      await addComment.mutateAsync({
        discussionId: d.id,
        body: reply.value.body.trim(),
        replyToId: commentId,
      });
    } catch (e) {
      onError(e);
      return;
    }
    reply.clearFor(submittedFor);
  }

  // Deferred into the handler: calling makeQuoteReply(ref) during render made the
  // React Compiler bail out of this whole component (refs-in-render rule).
  const quoteReply = (body: string) => {
    // Every quotable body — the discussion's and each rendered comment's — belongs
    // to the discussion on screen, which mid-switch is the previous one, while the
    // draft it would land in is keyed to the new one.
    if (detailsStale) return;
    makeQuoteReply({ composerRef, setBody: compose.set })(body);
  };

  // Every comment id below comes off the rendered discussion, which mid-switch is
  // the previous one — so each write would land on the discussion the viewer just
  // left. The affordances withhold or disable too; these arms back them up.
  async function saveCommentEdit(commentId: string, body: string) {
    if (detailsStale) return;
    try {
      await updateComment.mutateAsync({ commentId, body });
    } catch (e) {
      onError(e);
      return;
    }
    toast.success("Comment updated");
  }

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

  async function toggleAnswer(commentId: string, isAnswer: boolean) {
    if (detailsStale) return;
    try {
      await markAnswer.mutateAsync({ commentId, answer: !isAnswer });
    } catch (e) {
      onError(e);
      return;
    }
    toast.success(isAnswer ? "Answer unmarked" : "Marked as answer");
  }

  // Both subjects come off the rendered discussion while the optimistic patch
  // writes the SELECTED one's cache entry, so both hold through a switch. The
  // controls disable too; these arms are the belt-and-braces behind them.
  function toggleUpvote(subjectId: string, upvoted: boolean) {
    if (detailsStale) return;
    void toggleUpvoteMutation
      .mutateAsync({ subjectId, up: !upvoted })
      .catch(onError);
  }

  function toggleReaction(subjectId: string, content: string, active: boolean) {
    if (detailsStale) return;
    void toggleReactionMutation
      .mutateAsync({ subjectId, content, active })
      .catch(onError);
  }

  function referenceInNewIssue() {
    // The draft is seeded entirely from the rendered discussion, which mid-switch
    // is the previous one — the new issue would open against it.
    if (!d || detailsStale) return;
    setPendingIssueDraft({
      title: d.title,
      body: `Referenced from discussion [#${d.number}](${d.url}).`,
    });
    setRepoTab("issues");
  }

  // Each of these addresses the rendered discussion's id while the menu belongs to
  // the selected one; the items disable too, and these arms back them up.
  async function doLock(reason: DiscussionLockReason | null) {
    if (!d || detailsStale) return;
    try {
      await lockDiscussion.mutateAsync({ discussionId: d.id, reason });
    } catch (e) {
      onError(e);
      return;
    }
    toast.success("Conversation locked");
  }

  async function doUnlock() {
    if (!d || detailsStale) return;
    try {
      await unlockDiscussion.mutateAsync(d.id);
    } catch (e) {
      onError(e);
      return;
    }
    toast.success("Conversation unlocked");
  }

  /** Posts the riding draft ahead of a state change. False means the comment
   *  failed and the state change is abandoned: the draft stays put for a retry,
   *  so a lost note can never be the price of a failed close. */
  async function postRidingDraft(discussionId: string): Promise<boolean> {
    if (!draftRidesStateChange) return true;
    const submittedFor = discussionIdentity;
    try {
      await addComment.mutateAsync({
        discussionId,
        body: compose.value.trim(),
      });
      // Only a landed comment clears the draft.
      compose.clearFor(submittedFor);
      return true;
    } catch (e) {
      onError(e);
      return false;
    }
  }

  async function doClose(reason: DiscussionCloseReason) {
    // Unlike the button surfaces, a menu item can be reached again during the
    // comment round trip (the menu closes on click, but reopens) — so the
    // in-flight post is the re-entry guard the item's own `disabled` can't be.
    if (!d || detailsStale || addComment.isPending) return;
    // Captured before the await: posting clears the draft, and the error arm
    // below has to know a comment already went out.
    const withComment = draftRidesStateChange;
    // Ahead of the riding draft: a cancelled confirm must leave the comment
    // unposted.
    const ok = await useConfirm.getState().ask({
      title: `Close discussion #${d.number}?`,
      body: `Everyone watching is notified and the discussion leaves the open list. Reopening puts it back, but the notification can't be unsent.${
        withComment ? " Your draft posts as a comment first." : ""
      }`,
      confirmLabel: withComment ? "Close with comment" : "Close discussion",
    });
    if (!ok) return;
    if (!(await postRidingDraft(d.id))) return;
    try {
      await closeDiscussion.mutateAsync({ discussionId: d.id, reason });
    } catch (e) {
      if (withComment)
        toastErrorWithNote(
          e,
          "Your comment was posted, but closing failed — try Close again.",
        );
      else onError(e);
      return;
    }
    toast.success("Discussion closed");
  }

  async function doReopen() {
    if (!d || detailsStale || addComment.isPending) return;
    const withComment = draftRidesStateChange;
    if (!(await postRidingDraft(d.id))) return;
    try {
      await reopenDiscussion.mutateAsync(d.id);
    } catch (e) {
      if (withComment)
        toastErrorWithNote(
          e,
          "Your comment was posted, but reopening failed — try Reopen again.",
        );
      else onError(e);
      return;
    }
    toast.success("Discussion reopened");
  }

  async function doDelete() {
    if (!d || detailsStale) return;
    try {
      await deleteDiscussion.mutateAsync(d.id);
    } catch (e) {
      onError(e);
      setDeletingDiscussion(false);
      return;
    }
    toast.success("Discussion deleted");
    setDeletingDiscussion(false);
    // `selectDiscussion` is a global store write that outlives this view, so a
    // delete settling after the viewer moved on (another discussion, another
    // repo) must not clear their live selection.
    const live = useUiStore.getState();
    if (
      live.repoPath === repoPath &&
      live.selectedDiscussion?.number === number
    )
      selectDiscussion(null);
  }

  /** Close-on-error is the dialog's documented contract, so both arms close it. */
  async function doDeleteComment(commentId: string) {
    try {
      await deleteComment.mutateAsync(commentId);
    } catch (e) {
      onError(e);
      setDeletingCommentId(null);
      return;
    }
    toast.success("Comment deleted");
    setDeletingCommentId(null);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-2 border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <h2 className="text-sm font-medium">
            {d.title}{" "}
            <span className="font-normal text-muted-foreground">
              #{d.number}
            </span>
          </h2>
          <span className="flex-1" />
          <Button
            variant="outline"
            size="xs"
            onClick={() => openUrl(d.url)}
            title="Open this discussion on GitHub"
            className="cursor-pointer"
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            GitHub
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="xs" aria-label="More actions" />
              }
            >
              <DotsThreeIcon className="size-4" weight="bold" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem onClick={() => copyText(d.url, "Link copied")}>
                Copy link
              </DropdownMenuItem>
              {!detailsStale && (
                <DropdownMenuItem onClick={referenceInNewIssue}>
                  Create issue from discussion
                </DropdownMenuItem>
              )}
              {/* Pin and transfer aren't in GitHub's public API (GraphQL or
                  CLI) — open the discussion on GitHub where the web UI has them. */}
              <DropdownMenuItem onClick={() => openUrl(d.url)}>
                <ArrowSquareOutIcon data-icon="inline-start" />
                Pin on GitHub…
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => openUrl(d.url)}>
                <ArrowSquareOutIcon data-icon="inline-start" />
                Transfer on GitHub…
              </DropdownMenuItem>
              {d.closed ? (
                <DropdownMenuItem
                  disabled={reopenDiscussion.isPending || detailsStale}
                  onClick={() => void doReopen()}
                >
                  Reopen discussion{draftSuffix}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSub>
                  {/* The vendored sub-trigger carries no disabled styling of its
                      own (unlike menu items), so the dim rides a call-site class. */}
                  <DropdownMenuSubTrigger
                    disabled={closeDiscussion.isPending || detailsStale}
                    className="data-disabled:opacity-50"
                  >
                    Close discussion…{draftSuffix}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {CLOSE_REASONS.map(([label, reason]) => (
                      <DropdownMenuItem
                        key={reason}
                        disabled={closeDiscussion.isPending || detailsStale}
                        onClick={() => void doClose(reason)}
                      >
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              {d.locked ? (
                <DropdownMenuItem
                  disabled={unlockDiscussion.isPending || detailsStale}
                  onClick={() => void doUnlock()}
                >
                  Unlock conversation{staleSuffix}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger
                    disabled={lockDiscussion.isPending || detailsStale}
                    className="data-disabled:opacity-50"
                  >
                    Lock conversation…{staleSuffix}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {LOCK_REASONS.map(([label, reason]) => (
                      <DropdownMenuItem
                        key={reason ?? "none"}
                        disabled={lockDiscussion.isPending || detailsStale}
                        onClick={() => void doLock(reason)}
                      >
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuItem
                variant="destructive"
                disabled={detailsStale}
                onClick={() => setDeletingDiscussion(true)}
              >
                Delete discussion{staleSuffix}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">
            {d.categoryEmoji ? `${d.categoryEmoji} ` : ""}
            {d.categoryName}
          </Badge>
          {d.isAnswered && <Badge variant="default">answered</Badge>}
          {d.locked && (
            <Badge variant="secondary">
              locked
              {d.activeLockReason
                ? ` · ${d.activeLockReason.toLowerCase().replace(/_/g, "-")}`
                : ""}
            </Badge>
          )}
          {d.closed && (
            <Badge variant="secondary">
              closed{d.stateReason ? ` · ${d.stateReason.toLowerCase()}` : ""}
            </Badge>
          )}
          <AuthorAvatar login={d.author} />
          <span>{d.author || "unknown"}</span>
          {parseableDate(d.createdAt) && (
            <>
              <span>•</span>
              <span>
                opened <RelativeTime date={d.createdAt} />
              </span>
            </>
          )}
        </div>
        {/* Keyed on the discussion: the popover seeds a draft on open and commits
            it on close against LIVE props, and this view is never remounted per
            discussion — so without the key a keyboard switch with it open lands
            the old discussion's draft on the new one. The prefix keeps the key
            unique among siblings (duplicates leak the unmounted DOM).
            Discussions are GitHub-only with no fork/upstream lens (repo labels
            are identical either way); "origin" just satisfies the shared hooks. */}
        <LabelsPopover
          key={`labels-${discussionIdentity}`}
          repoPath={repoPath}
          enabled
          number={number}
          target="discussion"
          labelableId={d.id}
          labels={d.labels}
          lens="origin"
          // `labelableId` is the rendered discussion's while the popover is keyed
          // to the selected one, so a toggle mid-switch would label the wrong one.
          disabledReason={staleReason}
        />
      </header>
      {/* overflow-hidden contains the thread's natural height (vendored Root is
          `relative`-only) so a long discussion can't leak a window scrollbar. */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div className="space-y-4 p-4">
          <div className="group space-y-1">
            <p className="flex items-center gap-2 text-xs">
              <AuthorAvatar login={d.author} />
              <span className="font-medium">{d.author || "unknown"}</span>
              {parseableDate(d.createdAt) && (
                <span className="text-muted-foreground">
                  opened <RelativeTime date={d.createdAt} />
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
                    onClick={() => copyText(d.url, "Link copied")}
                  >
                    Copy link
                  </DropdownMenuItem>
                  {/* Absent, not disabled, while the body belongs to the previous
                      discussion — the same shape the comment menus take when their
                      `onQuote` is withheld. */}
                  {hasVisibleBody(d.body) && !detailsStale && (
                    <DropdownMenuItem onClick={() => quoteReply(d.body)}>
                      Quote reply
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => copyText(d.body, "Markdown copied")}
                  >
                    Copy markdown
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </p>
            {hasVisibleBody(d.body) ? (
              <Markdown refs={mentions.refs}>{d.body}</Markdown>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                No description provided.
              </p>
            )}
            {/* The counts are a read and stay; the toggles hold through a
                switch, each carrying its own reason. */}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <UpvoteButton
                count={d.upvoteCount}
                active={d.viewerHasUpvoted}
                disabled={upvoteHeld}
                reason={upvoteReason}
                onClick={() => toggleUpvote(d.id, d.viewerHasUpvoted)}
              />
              <ReactionBar
                reactions={reactions.data?.body ?? []}
                disabled={detailsStale}
                reason={staleReason}
                onToggle={(content, active) =>
                  toggleReaction(d.id, content, active)
                }
              />
            </div>
          </div>
          {d.comments.map((c) => (
            <div key={c.id} className="space-y-2">
              <div className="space-y-1">
                {c.isAnswer && (
                  <p className="flex items-center gap-1 text-[11px] font-medium text-success">
                    <CheckCircleIcon className="size-3.5" weight="fill" />
                    Answer
                  </p>
                )}
                <Thread
                  thread={toThread(c)}
                  onQuote={detailsStale ? undefined : () => quoteReply(c.body)}
                  onSaveEdit={
                    c.viewerDidAuthor && !detailsStale
                      ? (body) => void saveCommentEdit(c.id, body)
                      : undefined
                  }
                  // Withholding the handler only drops the menu entry; an editor
                  // already open when the switch began needs its Save held too.
                  editHeld={detailsStale}
                  onDelete={
                    c.viewerDidAuthor && !detailsStale
                      ? () => setDeletingCommentId(c.id)
                      : undefined
                  }
                  onHide={
                    c.isMinimized
                      ? undefined
                      : (classifier) => void hideComment(c.id, classifier)
                  }
                  onUnhide={
                    c.isMinimized ? () => void unhideComment(c.id) : undefined
                  }
                  // Hide/Unhide stay visible but disabled — the items carry their
                  // own reason, unlike the entries withheld above.
                  disabledReason={staleReason}
                  reactions={reactions.data?.comments[c.id]}
                  onToggleReaction={(content, active) =>
                    toggleReaction(c.id, content, active)
                  }
                  reactionsHeld={detailsStale}
                  reactionsReason={staleReason}
                  mentions={mentions}
                />
              </div>
              {/* Every control in the row carries its own reason. */}
              <div className="flex flex-wrap items-center gap-2">
                <UpvoteButton
                  count={c.upvoteCount}
                  active={c.viewerHasUpvoted}
                  disabled={upvoteHeld}
                  reason={upvoteReason}
                  onClick={() => toggleUpvote(c.id, c.viewerHasUpvoted)}
                />
                <DisabledReasonButton
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  reason={busyReason}
                  onClick={() =>
                    reply.set((prev) => ({
                      targetId: prev.targetId === c.id ? null : c.id,
                      body: "",
                    }))
                  }
                >
                  Reply
                </DisabledReasonButton>
                {d.isAnswerable && (
                  <DisabledReasonButton
                    size="xs"
                    variant={c.isAnswer ? "secondary" : "outline"}
                    disabled={busy}
                    reason={busyReason}
                    onClick={() => void toggleAnswer(c.id, c.isAnswer)}
                  >
                    <CheckCircleIcon data-icon="inline-start" />
                    {c.isAnswer ? "Unmark answer" : "Mark as answer"}
                  </DisabledReasonButton>
                )}
              </div>
              {(c.replies.length > 0 || reply.value.targetId === c.id) && (
                <div className="space-y-3 border-l pl-4">
                  {c.replies.map((r) => (
                    <Thread
                      key={r.id}
                      thread={toThread(r)}
                      onQuote={
                        detailsStale ? undefined : () => quoteReply(r.body)
                      }
                      onSaveEdit={
                        r.viewerDidAuthor && !detailsStale
                          ? (body) => void saveCommentEdit(r.id, body)
                          : undefined
                      }
                      editHeld={detailsStale}
                      onDelete={
                        r.viewerDidAuthor && !detailsStale
                          ? () => setDeletingCommentId(r.id)
                          : undefined
                      }
                      onHide={
                        r.isMinimized
                          ? undefined
                          : (classifier) => void hideComment(r.id, classifier)
                      }
                      onUnhide={
                        r.isMinimized
                          ? () => void unhideComment(r.id)
                          : undefined
                      }
                      disabledReason={staleReason}
                      reactions={reactions.data?.comments[r.id]}
                      onToggleReaction={(content, active) =>
                        toggleReaction(r.id, content, active)
                      }
                      reactionsHeld={detailsStale}
                      reactionsReason={staleReason}
                      mentions={mentions}
                    />
                  ))}
                  {reply.value.targetId === c.id && (
                    <div className="space-y-2">
                      <MarkdownEditor
                        autoFocus
                        aria-label="Write a reply"
                        placeholder="Write a reply…"
                        value={reply.value.body}
                        onChange={(v) =>
                          reply.set((prev) => ({ ...prev, body: v }))
                        }
                        onKeyDown={(e) => {
                          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                            // preventDefault unconditionally: `commit` is bound to
                            // mod+enter and fires inside editable targets, so a chord
                            // this handler declines to submit would otherwise reach
                            // the global action.
                            e.preventDefault();
                            if (reply.value.body.trim() && !busy)
                              void submitReply(c.id);
                          }
                        }}
                        rows={2}
                        textareaClassName="max-h-32 min-h-12 resize-y"
                        mentions={mentions}
                      />
                      <div className="flex items-center gap-2">
                        <DisabledReasonButton
                          size="xs"
                          variant="outline"
                          disabled={!reply.value.body.trim() || busy}
                          // An empty draft explains itself; only the `busy` hold
                          // needs words.
                          reason={busy ? busyReason : null}
                          onClick={() => void submitReply(c.id)}
                          title={SUBMIT_HINT}
                        >
                          Reply
                        </DisabledReasonButton>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => reply.set(EMPTY_REPLY)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          {d.comments.length === 0 && (
            <p className="text-xs text-muted-foreground">No comments yet.</p>
          )}
        </div>
      </ScrollArea>
      {/* empty:hidden: the hint self-gates to null (scopes covered, non-classic
          token, or still loading), and the wrapper must then contribute no
          border or padding of its own. */}
      <div className="empty:hidden shrink-0 border-t p-2">
        {/* GitHub's scope error names write:discussion, but `repo` covers
            repository-discussion writes — warn only when neither is present. */}
        <ScopeRefreshHint
          scope="write:discussion"
          action="Writing in discussions"
          coveredBy={["repo"]}
        />
      </div>
      <CommentComposer
        ref={composerRef}
        value={compose.value}
        onChange={compose.set}
        onSubmit={() => void submitComment()}
        onClear={() => compose.set("")}
        submitLabel="Comment"
        ariaLabel="Add to the discussion"
        placeholder="Add to the discussion…"
        mentions={mentions}
        busy={busy}
        reason={busyReason}
      />

      <DeleteCommentDialog
        commentId={deletingCommentId}
        onClose={() => setDeletingCommentId(null)}
        pending={deleteComment.isPending}
        onConfirm={(commentId) => void doDeleteComment(commentId)}
      />

      <Dialog open={deletingDiscussion} onOpenChange={setDeletingDiscussion}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this discussion?</DialogTitle>
            <DialogDescription>
              This permanently deletes "{d.title}" and all of its comments on
              GitHub. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeletingDiscussion(false)}
            >
              Cancel
            </Button>
            <DisabledReasonButton
              variant="destructive"
              disabled={deleteDiscussion.isPending || detailsStale}
              reason={staleReason}
              onClick={() => void doDelete()}
            >
              {deleteDiscussion.isPending && (
                <Spinner data-icon="inline-start" />
              )}
              Delete
            </DisabledReasonButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
