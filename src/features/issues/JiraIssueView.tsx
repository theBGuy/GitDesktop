import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CircleDashedIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { useJiraIssue, useJiraLink } from "@/lib/jira/queries";
import type { JiraIssueDetails, JiraStatusCategory } from "@/lib/jira/types";
import { useUiStore } from "@/lib/stores/ui";
import { formatRelativeTime } from "@/lib/time";

/** The status chip: category picks the open/closed icon+token, the REAL status
 *  name is the text (so meaning is never color-only). `done` → the closed/merged
 *  treatment; anything else → the open/success treatment. */
function StatusChip({
  category,
  name,
}: {
  category: JiraStatusCategory;
  name: string;
}) {
  const done = category === "done";
  const Icon = done ? CheckCircleIcon : CircleDashedIcon;
  return (
    <span className="inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px]">
      <Icon
        className={`size-3.5 shrink-0 ${done ? "text-merged" : "text-success"}`}
      />
      {name}
    </span>
  );
}

/** A muted issue-type icon + name, part of the meta row. Jira serves a small
 *  square type glyph; rendered through the vendored Avatar primitives (the repo's
 *  image idiom) so it degrades to the type's initial when the glyph won't load. */
function IssueTypeMeta({ iconUrl, name }: { iconUrl: string; name: string }) {
  if (!name) return null;
  return (
    <span className="inline-flex items-center gap-1">
      <Avatar size="sm" className="size-3.5 shrink-0 rounded-none">
        {iconUrl && <AvatarImage src={iconUrl} alt="" />}
        <AvatarFallback className="rounded-none text-[8px]">
          {name.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      {name}
    </span>
  );
}

/**
 * Read-only detail for one Jira issue: header (key + summary + status chip), a
 * muted meta row (type, priority, assignee, reporter, due date / resolution),
 * label chips, the description and comments rendered as markdown, and a "View in
 * Jira" link-out. No write affordances in phase 1 — none rendered, not disabled.
 */
export function JiraIssueView({
  repoPath,
  issueKey,
}: {
  repoPath: string;
  issueKey: string;
}) {
  const link = useJiraLink(repoPath);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const details = useJiraIssue(repoPath, link.data, issueKey);

  // The link resolved to nothing (unlinked, or unlinked while this view was
  // open): the issue query is disabled, so it would otherwise sit on a pending
  // skeleton forever. Teach + offer a way back rather than stranding it. Wait for
  // the link query itself to settle first so we don't flash this during load.
  if (!link.isPending && !link.data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-sm text-xs text-muted-foreground">
          This repository is no longer linked to a Jira project.
        </p>
        <Button variant="outline" size="sm" onClick={() => selectIssue(null)}>
          Back to issues
        </Button>
      </div>
    );
  }

  if (details.isPending) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (details.isError || !details.data) {
    return <DiffPlaceholder message="Could not load this Jira issue" />;
  }

  const issue: JiraIssueDetails = details.data;

  return (
    <div className="flex h-full flex-col">
      <header className="space-y-2 border-b px-4 py-3">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 text-sm font-medium">
            <span className="font-mono font-normal text-muted-foreground">
              {issue.key}
            </span>{" "}
            {issue.summary}
          </h2>
          <span className="flex-1" />
          <Button
            variant="outline"
            size="xs"
            className="cursor-pointer"
            onClick={() => openUrl(issue.url)}
            title="Open this issue in Jira"
          >
            <ArrowSquareOutIcon data-icon="inline-start" />
            Jira
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusChip category={issue.statusCategory} name={issue.statusName} />
          <IssueTypeMeta
            iconUrl={issue.issueTypeIconUrl}
            name={issue.issueTypeName}
          />
          {issue.priorityName && <span>· {issue.priorityName}</span>}
          <span>· opened {formatRelativeTime(issue.createdAt)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {issue.assignee && (
            <span className="inline-flex items-center gap-1.5">
              <ForgeUserAvatar user={issue.assignee} ghHost={null} />
              <span>Assignee: {issue.assignee.label}</span>
            </span>
          )}
          {issue.reporter && (
            <span className="inline-flex items-center gap-1.5">
              <ForgeUserAvatar user={issue.reporter} ghHost={null} />
              <span>Reporter: {issue.reporter.label}</span>
            </span>
          )}
          {issue.dueDate && <span>Due {issue.dueDate}</span>}
          {issue.resolutionName && (
            <span>Resolution: {issue.resolutionName}</span>
          )}
        </div>
        {issue.labels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {issue.labels.map((label) => (
              <span
                key={label}
                className="border px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        )}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          <div className="border-b pb-3">
            {issue.descriptionMd.trim() ? (
              <Markdown>{issue.descriptionMd}</Markdown>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                No description provided.
              </p>
            )}
          </div>
          {issue.comments.map((c) => (
            <div key={c.id} className="space-y-1">
              <p className="flex items-center gap-2 text-xs">
                {c.author && <ForgeUserAvatar user={c.author} ghHost={null} />}
                <span className="font-medium">
                  {c.author?.label ?? "unknown"}
                </span>
                <span className="text-muted-foreground">
                  {formatRelativeTime(c.createdAt)}
                </span>
              </p>
              {c.bodyMd.trim() ? (
                <Markdown>{c.bodyMd}</Markdown>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  (empty comment)
                </p>
              )}
            </div>
          ))}
          {issue.comments.length === 0 && (
            <p className="text-xs text-muted-foreground">No comments yet.</p>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
