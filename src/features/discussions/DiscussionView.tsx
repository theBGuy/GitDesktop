import {
  ArrowSquareOutIcon,
  CaretUpIcon,
  CheckCircleIcon,
  DotsThreeIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRef, useState } from "react";
import { toast } from "sonner";
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
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
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
import { useUiStore } from "@/lib/stores/ui";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
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

function UpvoteButton({
  count,
  active,
  onClick,
  disabled,
}: {
  count: number;
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={`Upvote, ${count}`}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 border px-1.5 py-0.5 text-[11px] tabular-nums transition-colors",
        active
          ? "border-primary bg-primary/10 text-foreground"
          : "text-muted-foreground hover:bg-muted/60",
      )}
      title={active ? "Remove upvote" : "Upvote"}
    >
      <CaretUpIcon className="size-3" weight="bold" />
      {count}
    </button>
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

  // Placeholder details are the previous discussion's: `busy` holds the composer,
  // reply box and mark-as-answer, and the seeding actions below read this too.
  // Lock/close, delete, upvote/reactions and labels also read `d.id` and stay
  // live — pre-existing exposure, tracked separately.
  const detailsStale = details.isPlaceholderData;
  const busy =
    addComment.isPending ||
    markAnswer.isPending ||
    deleteComment.isPending ||
    detailsStale;

  function submitComment() {
    if (!d || detailsStale || !compose.value.trim()) return;
    const submittedFor = discussionIdentity;
    addComment.mutate(
      { discussionId: d.id, body: compose.value.trim() },
      { onSuccess: () => compose.clearFor(submittedFor), onError },
    );
  }

  function submitReply(commentId: string) {
    if (!d || detailsStale || !reply.value.body.trim()) return;
    const submittedFor = discussionIdentity;
    addComment.mutate(
      {
        discussionId: d.id,
        body: reply.value.body.trim(),
        replyToId: commentId,
      },
      {
        onSuccess: () => reply.clearFor(submittedFor),
        onError,
      },
    );
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

  function saveCommentEdit(commentId: string, body: string) {
    updateComment.mutate(
      { commentId, body },
      { onSuccess: () => toast.success("Comment updated"), onError },
    );
  }

  function hideComment(commentId: string, classifier: MinimizeReason) {
    minimizeComment.mutate(
      { commentId, classifier },
      { onSuccess: () => toast.success("Comment hidden"), onError },
    );
  }

  function unhideComment(commentId: string) {
    unminimizeComment.mutate(commentId, {
      onSuccess: () => toast.success("Comment shown"),
      onError,
    });
  }

  function toggleAnswer(commentId: string, isAnswer: boolean) {
    markAnswer.mutate(
      { commentId, answer: !isAnswer },
      {
        onSuccess: () =>
          toast.success(isAnswer ? "Answer unmarked" : "Marked as answer"),
        onError,
      },
    );
  }

  function toggleUpvote(subjectId: string, upvoted: boolean) {
    toggleUpvoteMutation.mutate({ subjectId, up: !upvoted }, { onError });
  }

  function toggleReaction(subjectId: string, content: string, active: boolean) {
    toggleReactionMutation.mutate({ subjectId, content, active }, { onError });
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

  function doLock(reason: DiscussionLockReason | null) {
    if (!d) return;
    lockDiscussion.mutate(
      { discussionId: d.id, reason },
      { onSuccess: () => toast.success("Conversation locked"), onError },
    );
  }

  function doUnlock() {
    if (!d) return;
    unlockDiscussion.mutate(d.id, {
      onSuccess: () => toast.success("Conversation unlocked"),
      onError,
    });
  }

  function doClose(reason: DiscussionCloseReason) {
    if (!d) return;
    closeDiscussion.mutate(
      { discussionId: d.id, reason },
      { onSuccess: () => toast.success("Discussion closed"), onError },
    );
  }

  function doReopen() {
    if (!d) return;
    reopenDiscussion.mutate(d.id, {
      onSuccess: () => toast.success("Discussion reopened"),
      onError,
    });
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
                  disabled={reopenDiscussion.isPending}
                  onClick={doReopen}
                >
                  Reopen discussion
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={closeDiscussion.isPending}>
                    Close discussion…
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {CLOSE_REASONS.map(([label, reason]) => (
                      <DropdownMenuItem
                        key={reason}
                        disabled={closeDiscussion.isPending}
                        onClick={() => doClose(reason)}
                      >
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              {d.locked ? (
                <DropdownMenuItem
                  disabled={unlockDiscussion.isPending}
                  onClick={doUnlock}
                >
                  Unlock conversation
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={lockDiscussion.isPending}>
                    Lock conversation…
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {LOCK_REASONS.map(([label, reason]) => (
                      <DropdownMenuItem
                        key={reason ?? "none"}
                        disabled={lockDiscussion.isPending}
                        onClick={() => doLock(reason)}
                      >
                        {label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeletingDiscussion(true)}
              >
                Delete discussion
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
              <Markdown>{d.body}</Markdown>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                No description provided.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <UpvoteButton
                count={d.upvoteCount}
                active={d.viewerHasUpvoted}
                disabled={toggleUpvoteMutation.isPending}
                onClick={() => toggleUpvote(d.id, d.viewerHasUpvoted)}
              />
              <ReactionBar
                reactions={reactions.data?.body ?? []}
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
                    c.viewerDidAuthor
                      ? (body) => saveCommentEdit(c.id, body)
                      : undefined
                  }
                  onDelete={
                    c.viewerDidAuthor
                      ? () => setDeletingCommentId(c.id)
                      : undefined
                  }
                  onHide={
                    c.isMinimized
                      ? undefined
                      : (classifier) => hideComment(c.id, classifier)
                  }
                  onUnhide={
                    c.isMinimized ? () => unhideComment(c.id) : undefined
                  }
                  reactions={reactions.data?.comments[c.id]}
                  onToggleReaction={(content, active) =>
                    toggleReaction(c.id, content, active)
                  }
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <UpvoteButton
                  count={c.upvoteCount}
                  active={c.viewerHasUpvoted}
                  disabled={toggleUpvoteMutation.isPending}
                  onClick={() => toggleUpvote(c.id, c.viewerHasUpvoted)}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    reply.set((prev) => ({
                      targetId: prev.targetId === c.id ? null : c.id,
                      body: "",
                    }))
                  }
                >
                  Reply
                </Button>
                {d.isAnswerable && (
                  <Button
                    size="xs"
                    variant={c.isAnswer ? "secondary" : "outline"}
                    disabled={busy}
                    onClick={() => toggleAnswer(c.id, c.isAnswer)}
                  >
                    <CheckCircleIcon data-icon="inline-start" />
                    {c.isAnswer ? "Unmark answer" : "Mark as answer"}
                  </Button>
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
                        r.viewerDidAuthor
                          ? (body) => saveCommentEdit(r.id, body)
                          : undefined
                      }
                      onDelete={
                        r.viewerDidAuthor
                          ? () => setDeletingCommentId(r.id)
                          : undefined
                      }
                      onHide={
                        r.isMinimized
                          ? undefined
                          : (classifier) => hideComment(r.id, classifier)
                      }
                      onUnhide={
                        r.isMinimized ? () => unhideComment(r.id) : undefined
                      }
                      reactions={reactions.data?.comments[r.id]}
                      onToggleReaction={(content, active) =>
                        toggleReaction(r.id, content, active)
                      }
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
                              submitReply(c.id);
                          }
                        }}
                        rows={2}
                        textareaClassName="max-h-32 min-h-12 resize-y"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={!reply.value.body.trim() || busy}
                          onClick={() => submitReply(c.id)}
                          title={SUBMIT_HINT}
                        >
                          Reply
                        </Button>
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
      <CommentComposer
        ref={composerRef}
        value={compose.value}
        onChange={compose.set}
        onSubmit={submitComment}
        onClear={() => compose.set("")}
        submitLabel="Comment"
        ariaLabel="Add to the discussion"
        placeholder="Add to the discussion…"
        busy={busy}
      />

      <DeleteCommentDialog
        commentId={deletingCommentId}
        onClose={() => setDeletingCommentId(null)}
        pending={deleteComment.isPending}
        onConfirm={(commentId) =>
          deleteComment.mutate(commentId, {
            onSuccess: () => {
              toast.success("Comment deleted");
              setDeletingCommentId(null);
            },
            onError: (e) => {
              onError(e);
              setDeletingCommentId(null);
            },
          })
        }
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
            <Button
              variant="destructive"
              disabled={deleteDiscussion.isPending}
              onClick={() =>
                deleteDiscussion.mutate(d.id, {
                  onSuccess: () => {
                    toast.success("Discussion deleted");
                    setDeletingDiscussion(false);
                    selectDiscussion(null);
                  },
                  onError: (e) => {
                    onError(e);
                    setDeletingDiscussion(false);
                  },
                })
              }
            >
              {deleteDiscussion.isPending && (
                <Spinner data-icon="inline-start" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
