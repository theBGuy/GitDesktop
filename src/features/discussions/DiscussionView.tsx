import { Popover } from "@base-ui/react/popover";
import {
  ArrowSquareOutIcon,
  CaretUpIcon,
  CheckCircleIcon,
  DotsThreeIcon,
  TagIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
import { Badge } from "@/components/ui/badge";
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
import { DeleteCommentDialog } from "@/features/conversations/DeleteCommentDialog";
import { makeQuoteReply } from "@/features/conversations/quoteReply";
import { ReactionBar } from "@/features/conversations/ReactionBar";
import {
  AuthorAvatar,
  hasVisibleBody,
  LabelChip,
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
  useEditPrLabels,
  useLockDiscussion,
  useMarkDiscussionAnswer,
  useMinimizeComment,
  useReopenDiscussion,
  useRepoLabels,
  useToggleDiscussionUpvote,
  useToggleReaction,
  useUnlockDiscussion,
  useUnminimizeComment,
  useUpdateDiscussionComment,
} from "@/lib/git/queries";
import type { PrThreadOut } from "@/lib/git/types";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useUiStore } from "@/lib/stores/ui";
import { formatRelativeTime } from "@/lib/time";
import { toastError } from "@/lib/toast";
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
  // Discussions are a GitHub-only surface with no fork/upstream lens (repo labels
  // are identical either way); the "origin" lens just satisfies the shared hooks.
  const editLabels = useEditPrLabels(repoPath, "origin");
  const repoLabels = useRepoLabels(repoPath, true, "origin");
  const lockDiscussion = useLockDiscussion(repoPath);
  const unlockDiscussion = useUnlockDiscussion(repoPath);
  const closeDiscussion = useCloseDiscussion(repoPath);
  const reopenDiscussion = useReopenDiscussion(repoPath);
  const deleteDiscussion = useDeleteDiscussion(repoPath);
  const setRepoTab = useUiStore((s) => s.setRepoTab);
  const setPendingIssueDraft = useUiStore((s) => s.setPendingIssueDraft);
  const selectDiscussion = useUiStore((s) => s.selectDiscussion);

  const [composeBody, setComposeBody] = useState("");
  const composerRef = useRef<MarkdownEditorHandle>(null);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [draftLabels, setDraftLabels] = useState<Set<string>>(new Set());
  const [deletingDiscussion, setDeletingDiscussion] = useState(false);
  // A different discussion must never inherit this one's unsent drafts, reply
  // target, delete confirm, or label draft — render-time, not an effect. The
  // repo is part of the identity because discussion numbers repeat across repos.
  const discussionIdentity = `${repoPath}#${number}`;
  const [lastIdentity, setLastIdentity] = useState(discussionIdentity);
  if (discussionIdentity !== lastIdentity) {
    setLastIdentity(discussionIdentity);
    setComposeBody("");
    setReplyingTo(null);
    setReplyBody("");
    setDeletingCommentId(null);
    setDeletingDiscussion(false);
    setLabelsOpen(false);
    setDraftLabels(new Set());
  }
  // Both submits clear their composer only once the mutation resolves, which can
  // be after a switch — an effect event reads the LIVE identity so a late success
  // can't wipe text the user has since typed against another discussion.
  const clearComposeIfSame = useEffectEvent((submittedFor: string) => {
    if (submittedFor !== discussionIdentity) return;
    setComposeBody("");
  });
  const clearReplyIfSame = useEffectEvent((submittedFor: string) => {
    if (submittedFor !== discussionIdentity) return;
    setReplyBody("");
    setReplyingTo(null);
  });

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

  const busy =
    addComment.isPending || markAnswer.isPending || deleteComment.isPending;

  function submitComment() {
    if (!d || !composeBody.trim()) return;
    const submittedFor = discussionIdentity;
    addComment.mutate(
      { discussionId: d.id, body: composeBody.trim() },
      { onSuccess: () => clearComposeIfSame(submittedFor), onError },
    );
  }

  function submitReply(commentId: string) {
    if (!d || !replyBody.trim()) return;
    const submittedFor = discussionIdentity;
    addComment.mutate(
      { discussionId: d.id, body: replyBody.trim(), replyToId: commentId },
      {
        onSuccess: () => clearReplyIfSame(submittedFor),
        onError,
      },
    );
  }

  // Deferred into the handler: calling makeQuoteReply(ref) during render made the
  // React Compiler bail out of this whole component (refs-in-render rule).
  const quoteReply = (body: string) =>
    makeQuoteReply({ composerRef, setBody: setComposeBody })(body);

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

  function toggleDraftLabel(name: string, on: boolean) {
    setDraftLabels((prev) => {
      const next = new Set(prev);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  function handleLabelsOpenChange(open: boolean) {
    if (!d) return;
    if (open) {
      setDraftLabels(new Set(d.labels.map((l) => l.name)));
      setLabelsOpen(true);
      return;
    }
    setLabelsOpen(false);
    const applied = new Set(d.labels.map((l) => l.name));
    const idByName = new Map(
      (repoLabels.data ?? []).map((l) => [l.name, l.id]),
    );
    const ids = (names: string[]) =>
      names.map((n) => idByName.get(n)).filter((id): id is string => !!id);
    const addIds = ids([...draftLabels].filter((n) => !applied.has(n)));
    const removeIds = ids([...applied].filter((n) => !draftLabels.has(n)));
    if (addIds.length > 0 || removeIds.length > 0) {
      editLabels.mutate(
        {
          kind: "discussion",
          number: d.number,
          labelableId: d.id,
          addIds,
          removeIds,
        },
        { onError },
      );
    }
  }

  function referenceInNewIssue() {
    if (!d) return;
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
              <DropdownMenuItem onClick={referenceInNewIssue}>
                Create issue from discussion
              </DropdownMenuItem>
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
          <span>•</span>
          <span>opened {formatRelativeTime(d.createdAt)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Popover.Root open={labelsOpen} onOpenChange={handleLabelsOpenChange}>
            <Popover.Trigger
              render={
                <Button variant="ghost" size="xs" aria-label="Edit labels" />
              }
            >
              {editLabels.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <TagIcon data-icon="inline-start" />
              )}
              Labels
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner
                align="start"
                sideOffset={4}
                className="isolate z-50"
              >
                <Popover.Popup className="w-60 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                  <p className="px-1 pb-1.5 text-xs font-medium">Labels</p>
                  {(repoLabels.data ?? []).length === 0 && (
                    <p className="px-1 py-1 text-xs text-muted-foreground">
                      {repoLabels.isPending
                        ? "Loading labels…"
                        : "This repository has no labels."}
                    </p>
                  )}
                  {(repoLabels.data ?? []).map((label) => (
                    <label
                      key={label.name}
                      className="flex cursor-pointer items-center gap-2 px-1 py-1.5 text-xs hover:bg-muted/60"
                    >
                      <Checkbox
                        checked={draftLabels.has(label.name)}
                        onCheckedChange={(v) =>
                          toggleDraftLabel(label.name, v === true)
                        }
                      />
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: `#${label.color}` }}
                      />
                      <span className="flex-1 truncate">{label.name}</span>
                    </label>
                  ))}
                  {(repoLabels.data ?? []).length > 0 && (
                    <p className="mt-1 border-t px-1 pt-1.5 text-[11px] text-muted-foreground">
                      Changes apply when this closes.
                    </p>
                  )}
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
          {d.labels.map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
        </div>
      </header>
      {/* overflow-hidden contains the thread's natural height (vendored Root is
          `relative`-only) so a long discussion can't leak a window scrollbar. */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div className="space-y-4 p-4">
          <div className="group space-y-1">
            <p className="flex items-center gap-2 text-xs">
              <AuthorAvatar login={d.author} />
              <span className="font-medium">{d.author || "unknown"}</span>
              <span className="text-muted-foreground">
                opened {formatRelativeTime(d.createdAt)}
              </span>
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
                  {hasVisibleBody(d.body) && (
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
                  onQuote={() => quoteReply(c.body)}
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
                  onClick={() => {
                    setReplyBody("");
                    setReplyingTo(replyingTo === c.id ? null : c.id);
                  }}
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
              {(c.replies.length > 0 || replyingTo === c.id) && (
                <div className="space-y-3 border-l pl-4">
                  {c.replies.map((r) => (
                    <Thread
                      key={r.id}
                      thread={toThread(r)}
                      onQuote={() => quoteReply(r.body)}
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
                  {replyingTo === c.id && (
                    <div className="space-y-2">
                      <MarkdownEditor
                        autoFocus
                        aria-label="Write a reply"
                        placeholder="Write a reply…"
                        value={replyBody}
                        onChange={setReplyBody}
                        onKeyDown={(e) => {
                          if (
                            (e.ctrlKey || e.metaKey) &&
                            e.key === "Enter" &&
                            replyBody.trim() &&
                            !busy
                          ) {
                            e.preventDefault();
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
                          disabled={!replyBody.trim() || busy}
                          onClick={() => submitReply(c.id)}
                          title={formatBinding("mod+enter")}
                        >
                          Reply
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => setReplyingTo(null)}
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
      <div className="space-y-2 border-t p-3">
        <MarkdownEditor
          ref={composerRef}
          aria-label="Add to the discussion"
          placeholder="Add to the discussion…"
          value={composeBody}
          onChange={setComposeBody}
          onKeyDown={(e) => {
            if (
              (e.ctrlKey || e.metaKey) &&
              e.key === "Enter" &&
              composeBody.trim() &&
              !busy
            ) {
              e.preventDefault();
              submitComment();
            }
          }}
          rows={2}
          textareaClassName="max-h-32 min-h-12 resize-y"
        />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!composeBody.trim() || busy}
            onClick={submitComment}
            title={formatBinding("mod+enter")}
          >
            Comment
          </Button>
          {composeBody.trim() && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setComposeBody("")}
              title="Discard this draft (e.g. a quote reply)"
            >
              Clear
            </Button>
          )}
        </div>
      </div>

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
