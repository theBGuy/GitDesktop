import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CircleDashedIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useRef } from "react";
import type { MarkdownEditorHandle } from "@/components/markdown-editor";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { CommentComposer } from "@/features/conversations/CommentComposer";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import {
  useLinearComment,
  useLinearIssue,
  useLinearLink,
} from "@/lib/linear/queries";
import type { LinearComment, LinearIssueDetails } from "@/lib/linear/types";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";

function LinearStatusChip({ issue }: { issue: LinearIssueDetails }) {
  const done =
    issue.statusType === "completed" || issue.statusType === "cancelled";
  const Icon = done ? CheckCircleIcon : CircleDashedIcon;
  return (
    <span className="inline-flex w-fit items-center gap-1 whitespace-nowrap border px-1 py-px text-[10px] text-muted-foreground">
      <Icon
        className={`size-3 shrink-0 ${done ? "text-merged" : "text-success"}`}
      />
      {issue.statusName}
    </span>
  );
}

function CommentRow({ comment }: { comment: LinearComment }) {
  return (
    <div className="space-y-1 border-t px-4 py-3">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {comment.author && (
          <>
            <ForgeUserAvatar user={comment.author} ghHost={null} />
            <span className="font-medium text-foreground">
              {comment.author.label}
            </span>
          </>
        )}
        {parseableDate(comment.createdAt) && (
          <RelativeTime date={comment.createdAt} />
        )}
        {comment.updatedAt && comment.updatedAt !== comment.createdAt && (
          <span>(edited)</span>
        )}
      </div>
      <Markdown text={comment.bodyMd} />
    </div>
  );
}

export function LinearIssueView({
  repoPath,
  issueIdentifier,
}: {
  repoPath: string;
  issueIdentifier: string;
}) {
  const link = useLinearLink(repoPath);
  const issue = useLinearIssue(repoPath, link.data, issueIdentifier);
  const comment = useLinearComment(repoPath);
  const editorRef = useRef<MarkdownEditorHandle>(null);

  if (issue.isPending) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (issue.isError || !issue.data) {
    return (
      <DiffPlaceholder
        icon={CircleDashedIcon}
        heading="Couldn't load issue"
        copy={`${issueIdentifier} could not be loaded.`}
      />
    );
  }

  const d = issue.data;

  async function handleComment(body: string) {
    if (!d) return;
    await comment.mutateAsync({
      issueId: d.id,
      issueIdentifier: d.identifier,
      bodyMd: body,
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">{d.title}</h2>
              <div className="flex items-center gap-2">
                <LinearStatusChip issue={d} />
                <span className="font-mono text-xs text-muted-foreground">
                  {d.identifier}
                </span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="xs"
              className="cursor-pointer shrink-0 text-muted-foreground"
              onClick={() => openUrl(d.url).catch(toastError)}
              title={`Open ${d.identifier} in Linear`}
            >
              <ArrowSquareOutIcon data-icon="inline-start" />
              Open in Linear
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
            {d.assignee && (
              <span className="inline-flex items-center gap-1">
                <ForgeUserAvatar user={d.assignee} ghHost={null} />
                {d.assignee.label}
              </span>
            )}
            {d.priorityLabel && (
              <span className="border px-1 py-px">{d.priorityLabel}</span>
            )}
            {d.labels.map((l) => (
              <span key={l} className="border px-1 py-px">
                {l}
              </span>
            ))}
            {d.estimate != null && (
              <span className="border px-1 py-px" title="Estimate">
                {d.estimate}
              </span>
            )}
            {d.cycleName && (
              <span className="border px-1 py-px">{d.cycleName}</span>
            )}
            {d.projectName && (
              <span className="border px-1 py-px">{d.projectName}</span>
            )}
          </div>

          {parseableDate(d.createdAt) && (
            <p className="text-[11px] text-muted-foreground">
              Opened <RelativeTime date={d.createdAt} />
              {parseableDate(d.updatedAt) &&
                d.updatedAt !== d.createdAt && (
                  <>
                    {" · updated "}
                    <RelativeTime date={d.updatedAt} />
                  </>
                )}
            </p>
          )}

          {d.descriptionMd && (
            <div className="border-t pt-3">
              <Markdown text={d.descriptionMd} />
            </div>
          )}
        </div>

        {d.comments.length > 0 && (
          <div>
            {d.comments.map((c) => (
              <CommentRow key={c.id} comment={c} />
            ))}
          </div>
        )}
      </ScrollArea>

      <div className="border-t p-3">
        <CommentComposer
          ref={editorRef}
          onSubmit={handleComment}
          submitting={comment.isPending}
          placeholder="Leave a comment…"
        />
      </div>
    </div>
  );
}
