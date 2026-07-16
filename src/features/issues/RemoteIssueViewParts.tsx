import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { LabelsPopover } from "@/features/conversations/LabelsPopover";
import { AuthorAvatar, LabelChip } from "@/features/conversations/Thread";
import {
  useAddIssueSpentTime,
  useGlIssueLinks,
  useGlIssueTimeStats,
  useLinkIssue,
  useSetIssueAssignees,
  useSetIssueConfidential,
  useSetIssueDueDate,
  useSetIssueMilestone,
  useSetIssueTimeEstimate,
  useSetIssueType,
  useUnlinkIssue,
} from "@/lib/git/queries";
import type {
  GitLabLinkedIssue,
  GitLabTimeStats,
  IssueDetails,
  RemoteLens,
} from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { IssueDevelopment } from "./IssueDevelopment";
import {
  AssigneesPopover,
  IssueTypeMenu,
  MilestoneMenu,
} from "./IssueMetaPickers";
import { IssuePicker, IssueRelationships, RelatedRow } from "./IssueRelations";

/** The issue's right-hand metadata rail. Three shapes by provider:
 *  • GitHub (`canWrite`): the full interactive rail — type / assignees / labels /
 *    milestone pickers plus relationships, development, and Projects/Notifications.
 *  • GitLab (labels / assignees / milestone editable, the rest GitHub-only): a
 *    hybrid rail — the three pickers and a link out.
 *  • Read-only (Bitbucket / not-ready): a static rail ({@link ReadOnlyIssueSidebar})
 *    of just what the issue payload carries. */
export function IssueSidebar({
  repoPath,
  number,
  issue,
  canWrite,
  canEditLabels,
  canEditAssignees,
  canSetMilestone,
  canSetConfidential,
  canSetDueDate,
  canTrackTime,
  canLinkIssues,
  remoteLabel,
  lens,
}: {
  repoPath: string;
  number: number;
  issue: IssueDetails;
  canWrite: boolean;
  canEditLabels: boolean;
  canEditAssignees: boolean;
  canSetMilestone: boolean;
  /** GitLab-unique fields — false for GitHub (no confidential/due-date concept). */
  canSetConfidential: boolean;
  canSetDueDate: boolean;
  /** GitLab-unique: time tracking + related issues. */
  canTrackTime: boolean;
  canLinkIssues: boolean;
  remoteLabel: string;
  /** The origin|upstream lens the parent issue view resolved. */
  lens: RemoteLens;
}) {
  const setAssignees = useSetIssueAssignees(repoPath, lens);
  const setMilestone = useSetIssueMilestone(repoPath, lens);
  const setType = useSetIssueType(repoPath, lens);
  const setConfidential = useSetIssueConfidential(repoPath);
  const setDueDate = useSetIssueDueDate(repoPath);
  const onError = (e: unknown) => toastError(e);

  // A provider we can only read from (Bitbucket, or a not-ready repo): static rail.
  if (
    !canWrite &&
    !canEditLabels &&
    !canEditAssignees &&
    !canSetMilestone &&
    !canSetConfidential &&
    !canSetDueDate &&
    !canTrackTime &&
    !canLinkIssues
  ) {
    return <ReadOnlyIssueSidebar issue={issue} remoteLabel={remoteLabel} />;
  }

  // GitLab: Labels + Assignees + Milestone are editable, but the GitHub-only
  // surfaces (issue type, relationships, development, projects/notifications)
  // aren't wired — a hybrid of the editable pickers and a link out. The affordance
  // carries the cue: a ghost-button picker means editable; a muted label + value
  // means read-only.
  if (!canWrite) {
    return (
      <aside className="w-64 shrink-0 space-y-4 overflow-y-auto border-l p-4">
        {canEditLabels && (
          <LabelsPopover
            repoPath={repoPath}
            enabled
            number={number}
            target="issue"
            labelableId={issue.id}
            labels={issue.labels}
            lens={lens}
          />
        )}
        {canEditAssignees && (
          <AssigneesPopover
            repoPath={repoPath}
            enabled
            value={issue.assignees}
            commitOnClose
            lens={lens}
            onChange={(next) =>
              setAssignees.mutate({ number, assignees: next }, { onError })
            }
          />
        )}
        {canSetMilestone ? (
          <MilestoneMenu
            repoPath={repoPath}
            enabled
            value={issue.milestone?.number ?? null}
            valueLabel={issue.milestone?.title}
            lens={lens}
            onChange={(m, title) =>
              setMilestone.mutate({ number, milestone: m, title }, { onError })
            }
          />
        ) : (
          issue.milestone && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">
                Milestone
              </p>
              <p className="text-xs">{issue.milestone.title}</p>
            </div>
          )
        )}
        {canSetDueDate && (
          <DueDateRow
            value={issue.dueDate}
            open={issue.state === "OPEN"}
            pending={setDueDate.isPending}
            onChange={(dueDate) =>
              setDueDate.mutate({ number, dueDate }, { onError })
            }
          />
        )}
        {canSetConfidential && (
          <ConfidentialRow
            value={issue.confidential}
            pending={setConfidential.isPending}
            onChange={(confidential) =>
              setConfidential.mutate({ number, confidential }, { onError })
            }
          />
        )}
        {canTrackTime && (
          <IssueTimeTrackingSection
            repoPath={repoPath}
            number={number}
            editable={issue.state === "OPEN"}
          />
        )}
        {canLinkIssues && (
          <IssueLinksSection
            repoPath={repoPath}
            number={number}
            editable={issue.state === "OPEN"}
            lens={lens}
          />
        )}
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Links</p>
          <button
            type="button"
            onClick={() => openUrl(issue.url)}
            className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
          >
            <ArrowSquareOutIcon className="size-3" />
            View on {remoteLabel}
          </button>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-64 shrink-0 space-y-4 overflow-y-auto border-l p-4">
      <IssueTypeMenu
        repoPath={repoPath}
        enabled
        value={issue.issueType}
        lens={lens}
        onChange={(type) =>
          setType.mutate(
            { number, typeName: type?.name ?? null, type },
            { onError },
          )
        }
      />
      <AssigneesPopover
        repoPath={repoPath}
        enabled
        value={issue.assignees}
        commitOnClose
        lens={lens}
        onChange={(next) =>
          setAssignees.mutate({ number, assignees: next }, { onError })
        }
      />
      <LabelsPopover
        repoPath={repoPath}
        enabled
        number={number}
        target="issue"
        labelableId={issue.id}
        labels={issue.labels}
        lens={lens}
      />
      <MilestoneMenu
        repoPath={repoPath}
        enabled
        value={issue.milestone?.number ?? null}
        valueLabel={issue.milestone?.title}
        lens={lens}
        onChange={(m, title) =>
          setMilestone.mutate({ number, milestone: m, title }, { onError })
        }
      />
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Projects</p>
        <button
          type="button"
          onClick={() => openUrl(issue.url)}
          className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        >
          <ArrowSquareOutIcon className="size-3" />
          Manage on GitHub
        </button>
      </div>
      <IssueRelationships repoPath={repoPath} number={number} lens={lens} />
      <IssueDevelopment
        repoPath={repoPath}
        number={number}
        issueId={issue.id}
        issueTitle={issue.title}
        issueUrl={issue.url}
        lens={lens}
      />
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          Notifications
        </p>
        <button
          type="button"
          onClick={() => openUrl(issue.url)}
          className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        >
          <ArrowSquareOutIcon className="size-3" />
          Subscribe on GitHub
        </button>
      </div>
    </aside>
  );
}

/** Whether a due date lies before today, in LOCAL time (`Date`/`toISOString`
 *  is UTC and would flip "past due" up to a day around midnight — Temporal's
 *  PlainDate is calendar math with no timezone to get wrong; WebView2 ≥ 149
 *  ships it). Degrades to false (never crashes the rail) on a malformed API
 *  date or a pre-Temporal runtime. */
function isPastDue(dueDate: string): boolean {
  try {
    const due = Temporal.PlainDate.from(dueDate);
    return Temporal.PlainDate.compare(due, Temporal.Now.plainDateISO()) < 0;
  } catch {
    return false;
  }
}

/** The GitLab-only due-date rail row. Commits on BLUR (or Enter), not
 *  per-keystroke: on the native input's year segment every digit yields a
 *  "complete" date ("2" → year 0002), so an onChange commit would fire a
 *  mutation per keystroke with garbage intermediate dates (caught live).
 *  While mid-edit the value also passes through "", which must not read as a
 *  clear — clearing is the explicit Clear button instead. */
export function DueDateRow({
  value,
  open,
  pending,
  onChange,
}: {
  /** "YYYY-MM-DD" or null. */
  value: string | null;
  /** Whether the issue is open — only then does a past date read "past due". */
  open: boolean;
  pending: boolean;
  onChange: (date: string | null) => void;
}) {
  const pastDue = open && value !== null && isPastDue(value);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label
          htmlFor="issue-due-date"
          className="text-xs font-medium text-muted-foreground"
        >
          Due date
        </Label>
        {value !== null && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            disabled={pending}
            onClick={() => onChange(null)}
          >
            Clear
          </Button>
        )}
      </div>
      {/* Uncontrolled while focused (key remounts on external change) so the
          segment editing never fights a controlled re-render; blur commits. */}
      <Input
        key={value ?? ""}
        id="issue-due-date"
        type="date"
        defaultValue={value ?? ""}
        className="h-7"
        onBlur={(e) => {
          const next = e.target.value;
          if (next && next !== value) onChange(next);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
      {pastDue && <p className="text-[11px] text-destructive">Past due</p>}
    </div>
  );
}

/** The GitLab-only confidential rail row — hides the issue from non-members. */
function ConfidentialRow({
  value,
  pending,
  onChange,
}: {
  value: boolean;
  pending: boolean;
  onChange: (confidential: boolean) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label
          htmlFor="issue-confidential"
          className="text-xs font-medium text-muted-foreground"
        >
          Confidential
        </Label>
        <Switch
          id="issue-confidential"
          checked={value}
          disabled={pending}
          onCheckedChange={onChange}
        />
      </div>
      {value && (
        <p className="text-[11px] text-muted-foreground">
          Only visible to project members.
        </p>
      )}
    </div>
  );
}

/** The estimate/spent summary + optional editing controls, shared by the issue
 *  rail section and the MR popover (both drive GitLab time tracking). `stats` is
 *  the current values; `editable` reveals the free-text duration inputs (the
 *  issue must be open — same gate DueDate uses). The estimate input commits on
 *  blur/Enter (uncontrolled-while-focused, like DueDateRow); the add-spent input
 *  commits on Enter and clears itself; both surface a server rejection via toast
 *  while KEEPING their content so the user can fix it. Meaning never rests on the
 *  progress bar alone — the human values are always spelled out. */
export function TimeTrackingControls({
  stats,
  editable,
  pending,
  onSetEstimate,
  onAddSpent,
  idPrefix,
}: {
  stats: GitLabTimeStats | undefined;
  editable: boolean;
  pending: boolean;
  /** null resets the estimate. */
  onSetEstimate: (duration: string | null) => void;
  /** null resets spent time; a negative duration ("-15m") subtracts. */
  onAddSpent: (duration: string | null) => void;
  /** Disambiguates the input ids when two instances mount (issue rail + MR). */
  idPrefix: string;
}) {
  const estimate = stats?.timeEstimate ?? 0;
  const spent = stats?.totalTimeSpent ?? 0;
  const humanEstimate = stats?.humanTimeEstimate ?? "";
  const humanSpent = stats?.humanTotalTimeSpent ?? "";
  const hasAny = estimate > 0 || spent > 0;
  // Progress + overage (only meaningful when both sides exist).
  const pct =
    estimate > 0 ? Math.min(100, Math.round((spent / estimate) * 100)) : 0;
  const overSpent = estimate > 0 && spent > estimate;

  return (
    <div className="space-y-1.5">
      {hasAny ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Estimate</span>
            <span className="tabular-nums">{humanEstimate || "—"}</span>
          </div>
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Spent</span>
            <span className={cn("tabular-nums", overSpent && "text-warning")}>
              {humanSpent || "—"}
            </span>
          </div>
          {estimate > 0 && spent > 0 && (
            <div
              className="h-1 w-full bg-muted"
              aria-hidden
              title={`${humanSpent} of ${humanEstimate}`}
            >
              <div
                className={cn(
                  "h-full transition-[width]",
                  overSpent ? "bg-warning" : "bg-primary",
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
          {overSpent && (
            <p className="text-[11px] text-warning">
              {humanTimeOver(spent - estimate)} over
            </p>
          )}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">No time tracked.</p>
      )}
      {editable && (
        <div className="space-y-1.5 pt-0.5">
          <div className="flex items-center gap-1.5">
            <Input
              id={`${idPrefix}-time-estimate`}
              key={humanEstimate}
              defaultValue={humanEstimate}
              className="h-7"
              placeholder="Estimate (e.g. 3h)"
              aria-label="Set time estimate"
              disabled={pending}
              onBlur={(e) => {
                const next = e.target.value.trim();
                if (next && next !== humanEstimate) onSetEstimate(next);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
            />
            {estimate > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="shrink-0 text-muted-foreground"
                disabled={pending}
                onClick={() => onSetEstimate(null)}
              >
                Clear
              </Button>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Input
              id={`${idPrefix}-time-spent`}
              className="h-7"
              placeholder="Add spent (e.g. 45m, -15m)"
              aria-label="Add spent time"
              disabled={pending}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const el = e.currentTarget;
                const next = el.value.trim();
                if (next) {
                  onAddSpent(next);
                  el.value = "";
                }
              }}
            />
            {spent > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="shrink-0 text-muted-foreground"
                disabled={pending}
                onClick={() => onAddSpent(null)}
              >
                Reset
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Compact human duration for a positive second-count (the overage line), in the
 *  same units GitLab uses. */
function humanTimeOver(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(m, 1)}m`;
}

/** The GitLab-only time-tracking rail section: a heading, the estimate/spent
 *  summary, and (when the issue is open) the editing controls. */
function IssueTimeTrackingSection({
  repoPath,
  number,
  editable,
}: {
  repoPath: string;
  number: number;
  editable: boolean;
}) {
  const stats = useGlIssueTimeStats(repoPath, number);
  const setEstimate = useSetIssueTimeEstimate(repoPath);
  const addSpent = useAddIssueSpentTime(repoPath);
  const onError = (e: unknown) => toastError(e);

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">Time tracking</p>
      {stats.isPending ? (
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      ) : (
        <TimeTrackingControls
          stats={stats.data}
          editable={editable}
          pending={setEstimate.isPending || addSpent.isPending}
          idPrefix="issue"
          onSetEstimate={(duration) =>
            setEstimate.mutate({ number, duration }, { onError })
          }
          onAddSpent={(duration) =>
            addSpent.mutate({ number, duration }, { onError })
          }
        />
      )}
    </div>
  );
}

/** The GitLab-only related-issues rail section: a heading with an "Add" affordance,
 *  the linked-issue list (reusing RelatedRow), and an inline picker. Read-only when
 *  the issue is closed (no add/remove). */
function IssueLinksSection({
  repoPath,
  number,
  editable,
  lens,
}: {
  repoPath: string;
  number: number;
  editable: boolean;
  /** The parent issue's lens (GitLab-only section, so always "origin"). */
  lens: RemoteLens;
}) {
  const links = useGlIssueLinks(repoPath, number);
  const linkIssue = useLinkIssue(repoPath);
  const unlinkIssue = useUnlinkIssue(repoPath);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const [adding, setAdding] = useState(false);
  const onError = (e: unknown) => toastError(e);

  const data = links.data ?? [];
  const exclude = new Set<number>([number, ...data.map((l) => l.number)]);

  function open(n: number) {
    selectIssue({ kind: "remote", id: String(n) });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Related issues
        </span>
        <span className="flex-1" />
        {editable && !adding && (
          <Button
            variant="ghost"
            size="xs"
            aria-label="Link a related issue"
            onClick={() => setAdding(true)}
          >
            <PlusIcon data-icon="inline-start" />
            Add
            <CaretDownIcon data-icon="inline-end" />
          </Button>
        )}
      </div>

      {data.map((l) => (
        <RelatedRow
          key={l.linkId}
          issue={toRelated(l)}
          onOpen={open}
          onRemove={() =>
            unlinkIssue.mutate({ number, linkId: l.linkId }, { onError })
          }
        />
      ))}

      {links.isPending ? (
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      ) : (
        data.length === 0 &&
        !adding && (
          <p className="text-[11px] text-muted-foreground">
            No related issues.
          </p>
        )
      )}

      {adding && (
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <IssuePicker
              repoPath={repoPath}
              exclude={exclude}
              pending={linkIssue.isPending}
              lens={lens}
              onPick={(target) =>
                linkIssue.mutate(
                  { number, targetNumber: target },
                  { onSuccess: () => setAdding(false), onError },
                )
              }
            />
          </div>
          <Button variant="ghost" size="xs" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

/** Adapt a GitLab link to RelatedRow's `RelatedIssue` shape (linkId → id, webUrl
 *  → url). RelatedRow uses `id` only as a React key upstream; here we key on
 *  `linkId` at the call site, so any stable value works. */
function toRelated(l: GitLabLinkedIssue) {
  return {
    id: l.linkId,
    number: l.number,
    title: l.title,
    state: l.state,
    url: l.webUrl,
  };
}

/** The read-only metadata rail for a provider we only read from (Bitbucket, or a
 *  not-ready repo — GitLab gets the editable hybrid rail above): static
 *  assignees / labels / milestone — exactly what the issue payload carries — plus
 *  one link out. No mutating pickers and none of the GitHub-only
 *  relationships/development/notifications surfaces (those fetch via `gh_*`).
 *  Values render at full contrast; only the section headers are muted. */
function ReadOnlyIssueSidebar({
  issue,
  remoteLabel,
}: {
  issue: IssueDetails;
  remoteLabel: string;
}) {
  const hasMeta =
    issue.assignees.length > 0 ||
    issue.labels.length > 0 ||
    issue.milestone !== null ||
    issue.dueDate !== null ||
    issue.confidential;

  return (
    <aside className="w-64 shrink-0 space-y-4 overflow-y-auto border-l p-4">
      {issue.assignees.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Assignees</p>
          <ul className="space-y-1">
            {issue.assignees.map((user) => (
              <li key={user.id} className="flex items-center gap-1.5 text-xs">
                <AuthorAvatar login={user.id} avatarUrl={user.avatarUrl} />
                <span className="truncate">{user.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {issue.labels.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Labels</p>
          <div className="flex flex-wrap gap-1.5">
            {issue.labels.map((label) => (
              <LabelChip key={label.name} label={label} />
            ))}
          </div>
        </div>
      )}
      {issue.milestone && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Milestone</p>
          <p className="text-xs">{issue.milestone.title}</p>
        </div>
      )}
      {issue.dueDate && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Due date</p>
          <p className="text-xs">{issue.dueDate}</p>
        </div>
      )}
      {issue.confidential && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Confidential
          </p>
          <p className="text-xs">Only visible to project members.</p>
        </div>
      )}
      {!hasMeta && (
        <p className="text-xs text-muted-foreground">
          No labels, assignees, or milestone.
        </p>
      )}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Links</p>
        <button
          type="button"
          onClick={() => openUrl(issue.url)}
          className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        >
          <ArrowSquareOutIcon className="size-3" />
          View on {remoteLabel}
        </button>
      </div>
    </aside>
  );
}

/** Transfer/move-to-another-repo dialog. Presentational — the parent owns the
 *  mutation, the destination text, and the repo suggestions. `move` switches
 *  the copy to GitLab's vocabulary (an issue "moves" to another project, and
 *  the original closes with a "moved" marker rather than disappearing). */
export function TransferIssueDialog({
  open,
  onClose,
  number,
  dest,
  onDestChange,
  suggestions,
  pending,
  onSubmit,
  move = false,
}: {
  open: boolean;
  onClose: () => void;
  number: number;
  dest: string;
  onDestChange: (v: string) => void;
  suggestions: string[];
  pending: boolean;
  onSubmit: () => void;
  move?: boolean;
}) {
  const verb = move ? "Move" : "Transfer";
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {verb} issue #{number}
            </DialogTitle>
            <DialogDescription>
              {move
                ? "Moves this issue to another project with issues enabled. Its comments, labels, and milestone move with it; the original closes with a “moved” marker."
                : "Moves this issue to another repository you can push to. Its comments, labels, and assignees move with it."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Input
              autoFocus
              value={dest}
              onChange={(e) => onDestChange(e.target.value)}
              placeholder={move ? "group/project" : "owner/repo"}
              autoComplete="off"
            />
            {suggestions.length > 0 && (
              <div className="max-h-40 overflow-auto border">
                {suggestions.map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="block w-full truncate px-2 py-1.5 text-left text-xs hover:bg-muted/60"
                    onClick={() => onDestChange(name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!dest.trim() || pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {verb}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Delete-issue confirm dialog. Presentational — the parent owns the mutation
 *  and passes the provider name + its role requirement for the warning copy. */
export function DeleteIssueDialog({
  open,
  onClose,
  number,
  title,
  pending,
  onConfirm,
  remoteLabel,
  roleHint,
}: {
  open: boolean;
  onClose: () => void;
  number: number;
  title: string;
  pending: boolean;
  onConfirm: () => void;
  /** "GitHub" / "GitLab" — where the delete lands. */
  remoteLabel: string;
  /** The provider's role requirement (e.g. "requires admin or triage access"). */
  roleHint: string;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete issue #{number}?</DialogTitle>
          <DialogDescription>
            This permanently deletes “{title}” on {remoteLabel}. This cannot be
            undone, and {roleHint}.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending && <Spinner data-icon="inline-start" />}
            Delete issue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
