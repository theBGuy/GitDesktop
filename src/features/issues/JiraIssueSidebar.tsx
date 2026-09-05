import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { DueDateRow } from "@/features/issues/RemoteIssueViewParts";
import { useJiraSetDueDate } from "@/lib/jira/queries";
import type { JiraLink } from "@/lib/jira/store";
import { formatStoryPoints, type JiraIssueDetails } from "@/lib/jira/types";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  IssueTypeMeta,
  JiraAssigneePicker,
  JiraLabelsPopover,
  JiraPriorityMenu,
  JiraTimeTrackingSection,
} from "./JiraIssueView";

/**
 * The Jira issue's right-hand metadata rail — mirrors {@link IssueSidebar}'s
 * shell and section-label idiom (a fixed-width, self-scrolling `aside`), and
 * carries everything the header used to stack: type / priority, assignee,
 * reporter, due date, agile fields (story points, resolution, sprint, parent),
 * labels, components / fix versions, and the time-tracking block. Status stays
 * in the header (a chip/dropdown next to the title), so it isn't rendered here.
 *
 * Every write affordance stays gated exactly as before — permitted → the
 * interactive picker; not-permitted → the read-only value (or the section is
 * omitted). Optional agile fields follow the IssueSidebar precedent: a section
 * renders only when its value is present, rather than showing a "None" row.
 */
export function JiraIssueSidebar({
  repoPath,
  issueKey,
  link,
  issue,
  canAssign,
  canSchedule,
  canEditIssue,
  canLogWork,
  canEditOwnWorklogs,
  canDeleteOwnWorklogs,
  canEditAllWorklogs,
  canDeleteAllWorklogs,
  stale = false,
  className,
}: {
  repoPath: string;
  issueKey: string;
  /** `null` during the link-pending window — read-only rows render; the write
   *  affordances are gated on `link` (like the co-located subcomponents). */
  link: JiraLink | null;
  issue: JiraIssueDetails;
  canAssign: boolean;
  canSchedule: boolean;
  canEditIssue: boolean;
  canLogWork: boolean;
  canEditOwnWorklogs: boolean;
  canDeleteOwnWorklogs: boolean;
  canEditAllWorklogs: boolean;
  canDeleteAllWorklogs: boolean;
  /** `issue` is a previously selected one the caller is still rendering, so rows
   *  carrying ITS ids (the worklog entries) hold their write actions; everything
   *  addressed by `issueKey` alone stays live. */
  stale?: boolean;
  /** Merged into the rail's own classes — the caller owns the placeholder fade,
   *  since it holds the query whose data these rows render. */
  className?: string;
}) {
  const setDueDate = useJiraSetDueDate(repoPath, link);
  const selectIssue = useUiStore((s) => s.selectIssue);

  return (
    <aside
      // Stacked below the body once JiraIssueView's pane drops under 672px, where
      // it keeps its own scroller (the body's ScrollArea is a sibling, so a single
      // shared scroll would mean moving the rail inside it). The cap is what keeps
      // that scroller reachable: uncapped, `shrink-0` takes the rail's full natural
      // height and leaves the body none.
      className={cn(
        "w-64 shrink-0 space-y-4 overflow-y-auto border-l p-4 @max-2xl/jira-detail:max-h-[45%] @max-2xl/jira-detail:w-full @max-2xl/jira-detail:border-t @max-2xl/jira-detail:border-l-0",
        className,
      )}
    >
      {/* Type + priority. Type is a muted glyph + name; priority is editable
          when permitted, else the muted value (omitted when neither present). */}
      {(issue.issueTypeName ||
        issue.priorityName ||
        (canEditIssue && link)) && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Details</p>
          {issue.issueTypeName && (
            <div className="text-xs">
              <IssueTypeMeta
                iconUrl={issue.issueTypeIconUrl}
                name={issue.issueTypeName}
              />
            </div>
          )}
          {canEditIssue && link ? (
            <div className="text-xs text-muted-foreground">
              <JiraPriorityMenu
                repoPath={repoPath}
                link={link}
                issueKey={issueKey}
                priorityName={issue.priorityName}
              />
            </div>
          ) : (
            issue.priorityName && (
              <p className="text-xs">Priority: {issue.priorityName}</p>
            )
          )}
        </div>
      )}

      {/* Assignee — editable picker when permitted, else the read-only avatar. */}
      {(canAssign && link) || issue.assignee ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Assignee</p>
          {canAssign && link ? (
            <JiraAssigneePicker
              repoPath={repoPath}
              link={link}
              issueKey={issueKey}
              assignee={issue.assignee}
            />
          ) : (
            issue.assignee && (
              <span className="inline-flex items-center gap-1.5 text-xs">
                <ForgeUserAvatar user={issue.assignee} ghHost={null} />
                <span>{issue.assignee.label}</span>
              </span>
            )
          )}
        </div>
      ) : null}

      {/* Reporter — always read-only (avatar + name). */}
      {issue.reporter && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Reporter</p>
          <span className="inline-flex items-center gap-1.5 text-xs">
            <ForgeUserAvatar user={issue.reporter} ghHost={null} />
            <span>{issue.reporter.label}</span>
          </span>
        </div>
      )}

      {/* Due date — editable when permitted, else the read-only value. The
          editable branch has NO section heading: DueDateRow renders its own
          "Due date" label (matching how IssueSidebar hosts it bare). The
          read-only value branch keeps the heading (a bare date has no label). */}
      {canSchedule && link ? (
        <DueDateRow
          value={issue.dueDate}
          open={issue.statusCategory !== "done"}
          pending={setDueDate.isPending}
          onChange={(dueDate) =>
            void setDueDate.mutateAsync({ issueKey, dueDate }).catch(toastError)
          }
        />
      ) : (
        issue.dueDate && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              Due date
            </p>
            <p className="text-xs">{issue.dueDate}</p>
          </div>
        )
      )}

      {/* Story points — render only when present (IssueSidebar precedent). */}
      {issue.storyPoints != null && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Story points
          </p>
          <p className="text-xs">{formatStoryPoints(issue.storyPoints)}</p>
        </div>
      )}

      {/* Resolution — render only when present. */}
      {issue.resolutionName && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Resolution
          </p>
          <p className="text-xs">{issue.resolutionName}</p>
        </div>
      )}

      {/* Sprint — render only when present. */}
      {issue.sprintName && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Sprint</p>
          <p className="text-xs">
            {issue.sprintName}
            {issue.sprintState ? ` (${issue.sprintState})` : ""}
          </p>
        </div>
      )}

      {/* Parent — clickable, navigates in-app exactly as before. */}
      {issue.parent && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Parent</p>
          <button
            type="button"
            // Navigate to the parent in-app. This view already lives inside the
            // Issues tab, so `selectIssue` alone re-targets it — no `setRepoTab`.
            // The `issue.parent &&` guard is NOT dead: TS narrowing from the
            // outer `{issue.parent && …}` doesn't extend into a callback
            // (TS18047 without it) — it satisfies the compiler, not runtime.
            onClick={() =>
              issue.parent &&
              selectIssue({ kind: "jira", id: issue.parent.key })
            }
            title={`${issue.parent.key} ${issue.parent.summary}`}
            aria-label={`Open parent issue ${issue.parent.key}`}
            className="flex w-full cursor-pointer items-center gap-1 border px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-accent"
          >
            <span className="shrink-0 font-mono">{issue.parent.key}</span>
            {/* min-w-0 lets the truncate engage: a flex item defaults to
                min-width:auto (won't shrink below its content), so without it a
                long summary forces the button past the w-64 rail and leaks a
                horizontal scrollbar onto the page (caught live). */}
            <span className="min-w-0 truncate">{issue.parent.summary}</span>
          </button>
        </div>
      )}

      {/* Labels — editable popover when permitted, else static chips. The
          editable branch has NO section heading: the JiraLabelsPopover trigger
          is itself labeled "Labels" (matching how IssueSidebar hosts
          LabelsPopover bare). The read-only chips branch keeps the heading. */}
      {canEditIssue && link ? (
        <JiraLabelsPopover
          repoPath={repoPath}
          link={link}
          issueKey={issueKey}
          labels={issue.labels}
        />
      ) : (
        issue.labels.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Labels</p>
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
          </div>
        )
      )}

      {/* Components — static chips, only when non-empty. */}
      {issue.components.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Components
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {issue.components.map((component) => (
              <span
                key={component}
                className="border px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {component}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Fix versions — static chips, only when non-empty. */}
      {issue.fixVersions.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Fix versions
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {issue.fixVersions.map((version) => (
              <span
                key={version}
                className="border px-1.5 py-0.5 text-[11px] text-muted-foreground"
              >
                {version}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Time tracking — only when the feature is enabled on the project
          (timeTracking !== null); disabled ⇒ no section at all. Moved as-is. */}
      {issue.timeTracking !== null && (
        <JiraTimeTrackingSection
          repoPath={repoPath}
          link={link}
          issueKey={issueKey}
          tracking={issue.timeTracking}
          worklogs={issue.worklogs}
          worklogsTotal={issue.worklogsTotal}
          viewerAccountId={issue.viewerAccountId}
          issueUrl={issue.url}
          canLogWork={canLogWork}
          canEditEstimates={canEditIssue}
          canEditOwnWorklogs={canEditOwnWorklogs}
          canDeleteOwnWorklogs={canDeleteOwnWorklogs}
          canEditAllWorklogs={canEditAllWorklogs}
          canDeleteAllWorklogs={canDeleteAllWorklogs}
          stale={stale}
        />
      )}
    </aside>
  );
}
