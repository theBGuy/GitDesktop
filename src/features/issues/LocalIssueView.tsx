import { Popover } from "@base-ui/react/popover";
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  DotsThreeIcon,
  GithubLogoIcon,
  GitlabLogoIcon,
  KanbanIcon,
  PencilSimpleIcon,
  TagIcon,
  TrashIcon,
  UploadSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { CommentComposer } from "@/features/conversations/CommentComposer";
import { DeleteCommentDialog } from "@/features/conversations/DeleteCommentDialog";
import {
  EditTitleBodyDialog,
  useEditTitleBody,
} from "@/features/conversations/EditTitleBodyDialog";
import { LocalComment } from "@/features/conversations/LocalComment";
import { useLocalConversation } from "@/features/conversations/useLocalConversation";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { copyText } from "@/lib/clipboard";
import { forgeFeatureReady, useForgeStatus } from "@/lib/git/queries";
import {
  useDeleteLocalIssue,
  useLocalIssues,
  useUpdateLocalIssue,
} from "@/lib/issues/queries";
import { useJiraLink, useJiraPermissions } from "@/lib/jira/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { PlanIssueButton } from "../plan/PlanIssueButton";
import { SolveIssueButton } from "../sessions/SolveIssueButton";
import { PromoteLocalIssueDialog } from "./PromoteLocalIssueDialog";

export function LocalIssueView({
  repoPath,
  id,
}: {
  repoPath: string;
  id: string;
}) {
  const issues = useLocalIssues(repoPath);
  const issue = issues.data?.find((i) => i.id === id);
  const update = useUpdateLocalIssue(repoPath);
  const del = useDeleteLocalIssue(repoPath);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const ghStatus = useForgeStatus(repoPath);
  // Two independent publish gates: the forge's static issue-create capability
  // and a live per-user Jira permission probe. The Publish affordance shows when
  // EITHER is available; the dialog itself parameterizes / offers a choice.
  const canPublishForge = forgeFeatureReady(ghStatus.data, "issueCreate");
  const jiraLink = useJiraLink(repoPath).data;
  const jiraPerms = useJiraPermissions(repoPath, jiraLink);
  const canPublishJira = !!jiraLink && (jiraPerms.data?.createIssues ?? false);
  const canPublish = canPublishForge || canPublishJira;
  const {
    comment,
    setComment,
    labelInput,
    setLabelInput,
    deletingCommentId,
    setDeletingCommentId,
    composerRef,
    quoteReply,
    addComment,
    editComment,
    deleteComment,
    setCommentHidden,
    addLabel,
    removeLabel,
  } = useLocalConversation(id, issue, (mutate) => {
    if (issue) update.mutate({ id: issue.id, mutate });
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [promoteOpen, setPromoteOpen] = useState(false);
  const edit = useEditTitleBody({
    onSave: async ({ title, body }) => {
      if (!issue) return;
      await update.mutateAsync({
        id: issue.id,
        mutate: (cur) => ({ ...cur, title, body }),
      });
    },
  });
  // A different issue must never inherit this one's half-typed label or open
  // confirm/promote/edit dialogs — a render-time state adjustment, not an effect.
  const [lastId, setLastId] = useState(id);
  if (id !== lastId) {
    setLastId(id);
    setLabelInput("");
    setDeletingCommentId(null);
    setConfirmDelete(false);
    setPromoteOpen(false);
    edit.setOpen(false);
  }

  if (!issue) {
    return <DiffPlaceholder message="This local issue no longer exists" />;
  }

  const isOpen = issue.status === "open";
  // A typed note rides Close/Reopen rather than being discarded by them.
  const draftRidesStateChange = !!comment.trim();

  function openEdit() {
    if (!issue) return;
    edit.openEdit({ title: issue.title, body: issue.body });
  }

  /** Close/Reopen, carrying any typed note. The note is appended in the SAME
   *  record mutation as the status flip, so the store can never persist one
   *  without the other; the draft clears only once that write lands. */
  function setStatus(next: "open" | "closed") {
    // Appending the note makes this non-idempotent, and the mutate callback
    // re-reads the record from disk — so a second click lands after the first
    // note is already stored and would post it twice.
    if (!issue || update.isPending) return;
    const note = comment.trim();
    update.mutate(
      {
        id: issue.id,
        mutate: (cur) => ({
          ...cur,
          comments: note
            ? [
                ...cur.comments,
                {
                  id: crypto.randomUUID(),
                  body: note,
                  createdAt: new Date().toISOString(),
                },
              ]
            : cur.comments,
          status: next,
          closedAt: next === "closed" ? new Date().toISOString() : undefined,
        }),
      },
      {
        onSuccess: () => setComment(""),
        // Nothing was written, the note included — say so rather than leave a
        // silent no-op behind a button that promised to post it.
        onError: toastError,
      },
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-2 border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <h2 className="text-sm font-medium">{issue.title}</h2>
          <span className="flex-1" />
          <PlanIssueButton title={issue.title} body={issue.body} />
          {isOpen && (
            <SolveIssueButton
              repoPath={repoPath}
              title={issue.title}
              body={issue.body}
            />
          )}
          {isOpen && (
            <Button
              variant="outline"
              size="xs"
              onClick={openEdit}
              title="Edit the title and description"
            >
              <PencilSimpleIcon data-icon="inline-start" />
              Edit
            </Button>
          )}
          <Badge
            variant={isOpen ? "default" : "secondary"}
            className="capitalize"
          >
            {issue.status}
          </Badge>
          {issue.archived && <Badge variant="secondary">archived</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            local · opened <RelativeTime date={issue.createdAt} />
          </span>
        </div>
        {(issue.labels.length > 0 || isOpen) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Trigger first, so it never shifts as chips come and go. */}
            {isOpen && (
              <Popover.Root>
                <Popover.Trigger
                  render={
                    <Button variant="ghost" size="xs" aria-label="Add label" />
                  }
                >
                  <TagIcon data-icon="inline-start" />
                  Labels
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner
                    align="start"
                    sideOffset={4}
                    className="isolate z-50"
                  >
                    <Popover.Popup className="w-60 rounded-none bg-popover p-2 text-popover-foreground shadow-md ring-1 ring-foreground/10">
                      <p className="px-1 pb-1.5 text-xs font-medium">
                        Add label
                      </p>
                      <div className="flex gap-2 px-1">
                        <Input
                          value={labelInput}
                          onChange={(e) => setLabelInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              addLabel();
                            }
                          }}
                          placeholder="e.g. bug, idea"
                          className="h-7 flex-1"
                          autoComplete="off"
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={!labelInput.trim()}
                          onClick={addLabel}
                        >
                          Add
                        </Button>
                      </div>
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
            )}
            {issue.labels.map((label) => (
              <span
                key={label}
                className="flex items-center gap-1 border px-1.5 py-0.5 text-[11px]"
              >
                {label}
                {isOpen && (
                  <button
                    type="button"
                    aria-label={`Remove label ${label}`}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => removeLabel(label)}
                  >
                    <XIcon className="size-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </header>

      {/* overflow-hidden contains the content's natural height (vendored Root is
          `relative`-only) so a long issue can't leak a window scrollbar. */}
      <ScrollArea className="min-h-0 flex-1 overflow-hidden">
        <div className="space-y-4 p-4">
          <div className="group flex items-start justify-between gap-2 border-b pb-3">
            <div className="min-w-0 flex-1">
              {issue.body.trim() ? (
                <Markdown>{issue.body}</Markdown>
              ) : (
                <p className="text-xs text-muted-foreground">No description.</p>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Description actions"
                    className="shrink-0 text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
                  />
                }
              >
                <DotsThreeIcon className="size-4" weight="bold" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuItem onClick={() => quoteReply(issue.body)}>
                  Quote reply
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => copyText(issue.body, "Markdown copied")}
                >
                  Copy markdown
                </DropdownMenuItem>
                {isOpen && (
                  <DropdownMenuItem onClick={openEdit}>Edit</DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {issue.comments.map((c) => (
            <LocalComment
              key={c.id}
              comment={c}
              onQuote={() => quoteReply(c.body)}
              onSaveEdit={(body) => editComment(c.id, body)}
              onDelete={() => setDeletingCommentId(c.id)}
              onHide={() => setCommentHidden(c.id, true)}
              onUnhide={() => setCommentHidden(c.id, false)}
            />
          ))}
          {issue.comments.length === 0 && (
            <p className="text-xs text-muted-foreground">No comments yet.</p>
          )}
        </div>
      </ScrollArea>

      <CommentComposer
        ref={composerRef}
        ariaLabel="Leave a note"
        placeholder="Leave a note…"
        value={comment}
        onChange={setComment}
        onSubmit={addComment}
        onClear={() => setComment("")}
        submitLabel="Comment"
      />

      <div className="flex items-center gap-2 border-t p-3">
        <Button
          variant="outline"
          size="sm"
          className="text-destructive"
          onClick={() => setConfirmDelete(true)}
        >
          <TrashIcon data-icon="inline-start" />
          Delete
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            if (issue.archived) {
              update.mutate({
                id: issue.id,
                mutate: (cur) => ({ ...cur, archived: false }),
              });
            } else {
              update.mutate({
                id: issue.id,
                mutate: (cur) => ({ ...cur, archived: true }),
              });
              selectIssue(null);
            }
          }}
        >
          <ArchiveIcon data-icon="inline-start" />
          {issue.archived ? "Unarchive" : "Archive"}
        </Button>
        <span className="flex-1" />
        {isOpen && (
          <>
            {canPublish && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPromoteOpen(true)}
                title={
                  canPublishForge && canPublishJira
                    ? "Publish this issue to your forge or Jira, carrying its comments"
                    : canPublishJira
                      ? "Open this issue in Jira, carrying its comments"
                      : `Open this issue on ${ghStatus.data?.provider === "gitlab" ? "GitLab" : "GitHub"}, carrying its comments`
                }
              >
                {canPublishForge && canPublishJira ? (
                  <UploadSimpleIcon data-icon="inline-start" />
                ) : canPublishJira ? (
                  <KanbanIcon data-icon="inline-start" />
                ) : ghStatus.data?.provider === "gitlab" ? (
                  <GitlabLogoIcon data-icon="inline-start" />
                ) : (
                  <GithubLogoIcon data-icon="inline-start" />
                )}
                {canPublishForge && canPublishJira
                  ? "Publish"
                  : canPublishJira
                    ? "Publish to Jira"
                    : `Publish to ${ghStatus.data?.provider === "gitlab" ? "GitLab" : "GitHub"}`}
              </Button>
            )}
            {/* The label swaps while a note rides along: the action changed
                meaning, and only the label reaches a viewer before the click. */}
            <DisabledReasonButton
              variant="outline"
              size="sm"
              disabled={update.isPending}
              reason="Saving…"
              onClick={() => setStatus("closed")}
              title={
                draftRidesStateChange
                  ? "Closes and posts your draft as a comment"
                  : undefined
              }
            >
              {draftRidesStateChange ? "Close with comment" : "Close"}
            </DisabledReasonButton>
          </>
        )}
        {!isOpen && (
          <DisabledReasonButton
            variant="outline"
            size="sm"
            disabled={update.isPending}
            reason="Saving…"
            onClick={() => setStatus("open")}
            title={
              draftRidesStateChange
                ? "Reopens and posts your draft as a comment"
                : undefined
            }
          >
            <ArrowCounterClockwiseIcon data-icon="inline-start" />
            {draftRidesStateChange ? "Reopen with comment" : "Reopen"}
          </DisabledReasonButton>
        )}
      </div>

      <PromoteLocalIssueDialog
        repoPath={repoPath}
        issue={issue}
        open={promoteOpen}
        onOpenChange={setPromoteOpen}
      />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this local issue?</DialogTitle>
            <DialogDescription>
              Permanently deletes "{issue.title}"
              {issue.comments.length > 0
                ? ` and its ${issue.comments.length} comment${
                    issue.comments.length === 1 ? "" : "s"
                  }`
                : ""}
              . This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={del.isPending}
              onClick={() =>
                del.mutate(issue.id, {
                  onSuccess: () => {
                    setConfirmDelete(false);
                    selectIssue(null);
                  },
                  onError: toastError,
                })
              }
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EditTitleBodyDialog
        form={edit.form}
        open={edit.open}
        onOpenChange={edit.setOpen}
        title="Edit issue"
        description="Updates the title and description of this local issue."
        contentClassName={undefined}
        bodyTextareaClassName="max-h-72"
      />

      <DeleteCommentDialog
        commentId={deletingCommentId}
        onClose={() => setDeletingCommentId(null)}
        description="Removes this comment from the local issue. This cannot be undone."
        onConfirm={(commentId) => {
          deleteComment(commentId);
          setDeletingCommentId(null);
        }}
      />
    </div>
  );
}
