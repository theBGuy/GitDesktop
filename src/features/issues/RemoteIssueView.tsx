import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  DotsThreeIcon,
  PencilSimpleIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  MarkdownEditor,
  type MarkdownEditorHandle,
} from "@/components/markdown-editor";
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
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { copyText } from "@/lib/clipboard";
import { presentError } from "@/lib/error-summary";
import type { LockReason, MinimizeReason } from "@/lib/git/api";
import {
  forgeFeatureReady,
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
  useLockIssue,
  useMinimizeComment,
  usePinIssue,
  useReopenIssue,
  useToggleReaction,
  useTransferIssue,
  useUnlockIssue,
  useUnminimizeComment,
} from "@/lib/git/queries";
import { providerLabel } from "@/lib/git/types";
import { formatBinding } from "@/lib/hotkeys/binding";
import { useRepoLens } from "@/lib/repo-lens/queries";
import { useUiStore } from "@/lib/stores/ui";
import { formatRelativeTime } from "@/lib/time";
import { toastError } from "@/lib/toast";
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

/** Platform-correct submit hint (Cmd+Enter on macOS, Ctrl+Enter else) — never a
 *  literal modifier (house platform-mod-key rule). */
const SUBMIT_HINT = formatBinding("mod+enter");

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
  const setPendingIssueDraft = useUiStore((s) => s.setPendingIssueDraft);
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
  const toggleReactionMutation = useToggleReaction(
    repoPath,
    ["repo", repoPath, "issue", lens, number, "reactions"] as const,
    details.data?.id ?? "",
    { target: "issue", number },
  );

  const [composeBody, setComposeBody] = useState("");
  const composerRef = useRef<MarkdownEditorHandle>(null);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(
    null,
  );
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferDest, setTransferDest] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
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
  const edit = useEditTitleBody({
    onSave: async ({ title, body }) => {
      await editIssue.mutateAsync({ number, title, body });
    },
    successToast: "Issue updated",
  });

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
  const busy =
    comment.isPending || closeIssue.isPending || reopenIssue.isPending;
  const comments = issue.comments.filter((c) => hasVisibleBody(c.body));

  function submitComment() {
    const body = composeBody.trim();
    if (!body) return;
    // Clear the draft immediately (the perceived-speed win) and append the
    // synthetic comment optimistically; on error restore the draft, but only if
    // the composer is still empty so we never clobber newly-typed text.
    setComposeBody("");
    comment.mutate(
      { number, body, author: forge.data?.login ?? "You" },
      {
        onError: (e) => {
          setComposeBody((cur) => (cur.trim() ? cur : body));
          onError(e);
        },
      },
    );
  }

  // Deferred into the handler: calling makeQuoteReply(ref) during render made the
  // React Compiler bail out of this whole component (refs-in-render rule).
  const quoteReply = (body: string) =>
    makeQuoteReply({ composerRef, setBody: setComposeBody })(body);

  function doClose(reason: "completed" | "not_planned") {
    closeIssue.mutate(
      { number, reason },
      { onSuccess: () => toast.success(`Closed #${number}`), onError },
    );
  }

  function saveCommentEdit(commentId: string, body: string) {
    editComment.mutate(
      { number, commentId, body },
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

  function toggleReaction(subjectId: string, content: string, active: boolean) {
    toggleReactionMutation.mutate({ subjectId, content, active }, { onError });
  }

  // Seeds + opens the GitHub create dialog (IssuesPanel consumes the draft).
  // Labels carry over since they're from this same repo.
  function duplicateIssue() {
    if (!issue) return;
    setPendingIssueDraft({
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((l) => l.name),
    });
  }

  function submitTransfer() {
    const destination = transferDest.trim();
    if (!destination) return;
    transferIssue.mutate(
      { number, destination },
      {
        onSuccess: (url) => {
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
          selectIssue(null);
        },
        onError,
      },
    );
  }

  function confirmDelete() {
    deleteIssue.mutate(number, {
      onSuccess: () => {
        toast.success(`Deleted #${number}`);
        setDeleteOpen(false);
        selectIssue(null);
      },
      onError: (e) => {
        onError(e);
        setDeleteOpen(false);
      },
    });
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

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-2 border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <h2 className="text-sm font-medium">
            {issue.title}{" "}
            <span className="font-normal text-muted-foreground">
              #{issue.number}
            </span>
          </h2>
          <span className="flex-1" />
          <PlanIssueButton title={issue.title} body={issue.body} />
          {isOpen && (
            <SolveIssueButton
              repoPath={repoPath}
              title={issue.title}
              body={issue.body}
            />
          )}
          {isOpen && canEdit && (
            <Button
              variant="outline"
              size="xs"
              onClick={() =>
                edit.openEdit({ title: issue.title, body: issue.body })
              }
              title="Edit the title and description"
            >
              <PencilSimpleIcon data-icon="inline-start" />
              Edit
            </Button>
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
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="xs"
                    aria-label="More actions"
                  />
                }
              >
                <DotsThreeIcon className="size-4" weight="bold" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-52">
                {canWrite && (
                  <DropdownMenuItem
                    onClick={() =>
                      pinIssue.mutate(
                        { number, pinned: !issue.isPinned },
                        {
                          onSuccess: () =>
                            toast.success(
                              issue.isPinned ? "Unpinned" : "Pinned",
                            ),
                          onError,
                        },
                      )
                    }
                  >
                    {issue.isPinned ? "Unpin issue" : "Pin issue"}
                  </DropdownMenuItem>
                )}
                {canLock &&
                  (issue.locked ? (
                    <DropdownMenuItem
                      onClick={() =>
                        unlockIssue.mutate(number, {
                          onSuccess: () =>
                            toast.success("Conversation unlocked"),
                          onError,
                        })
                      }
                    >
                      Unlock conversation
                    </DropdownMenuItem>
                  ) : isGitLab ? (
                    // GitLab locks without a reason — a plain item, no submenu.
                    <DropdownMenuItem
                      onClick={() =>
                        lockIssue.mutate(
                          { number, reason: null },
                          {
                            onSuccess: () =>
                              toast.success("Conversation locked"),
                            onError,
                          },
                        )
                      }
                    >
                      Lock conversation
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>
                        Lock conversation…
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {LOCK_REASONS.map(([label, reason]) => (
                          <DropdownMenuItem
                            key={reason ?? "none"}
                            onClick={() =>
                              lockIssue.mutate(
                                { number, reason },
                                {
                                  onSuccess: () =>
                                    toast.success("Conversation locked"),
                                  onError,
                                },
                              )
                            }
                          >
                            {label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ))}
                {(canWrite || canLock) && <DropdownMenuSeparator />}
                {canDuplicate && (
                  <DropdownMenuItem onClick={duplicateIssue}>
                    Duplicate issue
                  </DropdownMenuItem>
                )}
                {canTransfer && (
                  <DropdownMenuItem
                    onClick={() => {
                      setTransferDest("");
                      setTransferOpen(true);
                    }}
                  >
                    {isGitLab ? "Move issue…" : "Transfer issue…"}
                  </DropdownMenuItem>
                )}
                {canDelete && (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDeleteOpen(true)}
                  >
                    Delete issue…
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
          <span>•</span>
          <span>opened {formatRelativeTime(issue.createdAt)}</span>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
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
                  <span className="text-muted-foreground">
                    opened {formatRelativeTime(issue.createdAt)}
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
                        onClick={() => copyText(issue.url, "Link copied")}
                      >
                        Copy link
                      </DropdownMenuItem>
                      {canWrite && hasVisibleBody(issue.body) && (
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
                      {isOpen && canEdit && (
                        <DropdownMenuItem
                          onClick={() =>
                            edit.openEdit({
                              title: issue.title,
                              body: issue.body,
                            })
                          }
                        >
                          Edit
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </p>
                {hasVisibleBody(issue.body) ? (
                  <Markdown>{issue.body}</Markdown>
                ) : (
                  <p className="text-xs text-muted-foreground italic">
                    No description provided.
                  </p>
                )}
                {canReact && (
                  <ReactionBar
                    reactions={reactions.data?.body ?? []}
                    onToggle={(content, active) =>
                      toggleReaction(issue.id, content, active)
                    }
                  />
                )}
              </div>
              {canWrite && (
                <IssueSubIssues
                  repoPath={repoPath}
                  issueId={issue.id}
                  number={number}
                  lens={lens}
                />
              )}
              {comments.map((c) => (
                <Thread
                  key={c.id}
                  thread={c}
                  onQuote={canWrite ? () => quoteReply(c.body) : undefined}
                  onSaveEdit={
                    canEditOwnComments && c.viewerDidAuthor
                      ? (body) => saveCommentEdit(c.id, body)
                      : undefined
                  }
                  onDelete={
                    canEditOwnComments && c.viewerDidAuthor
                      ? () => setDeletingCommentId(c.id)
                      : undefined
                  }
                  onHide={
                    canWrite && !c.isMinimized
                      ? (classifier) => hideComment(c.id, classifier)
                      : undefined
                  }
                  onUnhide={
                    canWrite && c.isMinimized
                      ? () => unhideComment(c.id)
                      : undefined
                  }
                  reactions={
                    canReact ? reactions.data?.comments[c.id] : undefined
                  }
                  onToggleReaction={
                    canReact
                      ? (content, active) =>
                          toggleReaction(c.id, content, active)
                      : undefined
                  }
                />
              ))}
              {comments.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No comments yet.
                </p>
              )}
            </div>
          </ScrollArea>
          {/* Comment is allowed after the issue closes too, matching GitHub. On
              GitLab the composer + close/reopen show, but the GitHub-only
              close-reason dropdown stays hidden (GitLab has no reasons);
              Bitbucket has neither, so the whole bar hides. */}
          {(canComment || canChangeState) && (
            <div className="space-y-2 border-t p-3">
              {canComment && (
                <MarkdownEditor
                  ref={composerRef}
                  aria-label="Leave a comment"
                  placeholder="Leave a comment…"
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
              )}
              <div className="flex items-center gap-2">
                {canComment && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!composeBody.trim() || busy}
                      onClick={submitComment}
                      title={SUBMIT_HINT}
                    >
                      Comment
                    </Button>
                    {composeBody.trim() && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setComposeBody("")}
                        title="Discard this draft (e.g. a quote reply)"
                      >
                        Clear
                      </Button>
                    )}
                  </>
                )}
                <span className="flex-1" />
                {canChangeState &&
                  (isOpen ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => doClose("completed")}
                      >
                        Close issue
                      </Button>
                      {/* Close reasons are a GitHub concept; GitLab has none. */}
                      {canWrite && (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="outline"
                                size="icon-sm"
                                aria-label="Other close options"
                                disabled={busy}
                              />
                            }
                          >
                            <CaretDownIcon />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="min-w-52">
                            <DropdownMenuItem
                              onClick={() => doClose("completed")}
                            >
                              Close as completed
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => doClose("not_planned")}
                            >
                              Close as not planned
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        reopenIssue.mutate(number, {
                          onSuccess: () => toast.success(`Reopened #${number}`),
                          onError,
                        })
                      }
                    >
                      <ArrowCounterClockwiseIcon data-icon="inline-start" />
                      Reopen
                    </Button>
                  ))}
              </div>
            </div>
          )}
        </div>
        <IssueSidebar
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
        />
      </div>

      <EditTitleBodyDialog
        form={edit.form}
        open={edit.open}
        onOpenChange={edit.setOpen}
        title="Edit issue"
        description={`Updates the title and description of #${number} on ${remoteLabel}.`}
        contentClassName="sm:max-w-lg"
        bodyTextareaClassName="max-h-72 min-h-24 resize-y font-mono"
      />

      <DeleteCommentDialog
        commentId={deletingCommentId}
        onClose={() => setDeletingCommentId(null)}
        pending={deleteComment.isPending}
        description={`This permanently deletes the comment on ${remoteLabel}. This cannot be undone.`}
        onConfirm={(commentId) =>
          deleteComment.mutate(
            { number, commentId },
            {
              onSuccess: () => {
                toast.success("Comment deleted");
                setDeletingCommentId(null);
              },
              onError: (e) => {
                onError(e);
                setDeletingCommentId(null);
              },
            },
          )
        }
      />

      <TransferIssueDialog
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        number={number}
        dest={transferDest}
        onDestChange={setTransferDest}
        suggestions={repoSuggestions}
        pending={transferIssue.isPending}
        onSubmit={submitTransfer}
        move={isGitLab}
      />

      <DeleteIssueDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        number={number}
        title={issue.title}
        pending={deleteIssue.isPending}
        onConfirm={confirmDelete}
        remoteLabel={remoteLabel}
        roleHint={
          isGitLab ? "needs Owner access" : "requires admin or triage access"
        }
      />
    </div>
  );
}
