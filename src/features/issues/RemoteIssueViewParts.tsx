import {
  ArrowSquareOutIcon,
  CaretDownIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Fragment, type ReactNode, useState } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { HeldSwitch } from "@/components/held-switch";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { LabelsPopover } from "@/features/conversations/LabelsPopover";
import { ProjectFieldValues } from "@/features/conversations/ProjectFieldValues";
import { ProjectsPopover } from "@/features/conversations/ProjectsPopover";
import { AuthorAvatar, LabelChip } from "@/features/conversations/Thread";
import {
  pendingIssueWrite,
  useAddIssueSpentTime,
  useGlIssueLinks,
  useGlIssueTimeStats,
  useLinkIssue,
  usePendingIssueWrites,
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
import {
  ACT_PENDING_REASON,
  pendingWriteReason,
  SAVING_LAST_CHANGE_REASON,
} from "@/lib/offline-writes";
import { useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import {
  ARIA_DISABLED_CLASS,
  useDisabledReason,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";
import { IssueDevelopment } from "./IssueDevelopment";
import {
  AssigneesPopover,
  IssueTypeMenu,
  MilestoneMenu,
} from "./IssueMetaPickers";
import {
  IssuePicker,
  IssueRelationships,
  PendingWriteNote,
  RelatedRow,
  rowPending,
} from "./IssueRelations";

/** What a control held through an issue switch says: the issue on screen is
 *  not the selected one yet. Shared by every issue view's stale-held controls so
 *  the one wording can't drift. */
export const ISSUE_SWITCH_LOADING_REASON = "Loading this issue…";

/** A rail row's hold while its own write is pending: parked offline or saving. */
function rowPendingReason(
  pending: { paused: boolean } | undefined,
  inFlight = SAVING_LAST_CHANGE_REASON,
): string | undefined {
  return pending ? pendingWriteReason(pending.paused, inFlight) : undefined;
}

/** One row of an issue's metadata rail. Two shapes, because the shared pickers
 *  label themselves inside their trigger ("Assignees"/"Milestone"/"Type") and a
 *  wrapper heading would double-label them: a row with no `heading` is hosted
 *  bare, one with a `heading` gets the muted section header above its value. */
export type IssueRailRow = {
  key: string;
  /** Mount gate — see {@link IssueRail}. */
  when: boolean;
  heading?: string;
  render: () => ReactNode;
};

/** Renders an ordered rail: the shared shell plus each row that passes its gate.
 *  A gated-out row is never rendered rather than rendered-and-disabled, because
 *  the GitHub-only rows fetch `gh_*` and the GitLab-only rows fetch GitLab on
 *  mount — an always-mounted list would fire both providers' APIs on every
 *  issue. This is why the per-provider rails existed, and why one list still
 *  can't be unconditional. `held` remounts the rows (never the aside, whose
 *  scroll stays): their pickers' popups are portaled, out of `inert`'s reach,
 *  so a held switch shuts them this way. */
export function IssueRail({
  rows,
  held = false,
}: {
  rows: IssueRailRow[];
  held?: boolean;
}) {
  return (
    // Stacked below the body once RemoteIssueView's pane drops under 672px, where
    // it keeps its own scroller (the body's ScrollArea is a sibling, so a single
    // shared scroll would mean moving the rail inside it). The cap is what keeps
    // that scroller reachable: uncapped, `shrink-0` takes the rail's full natural
    // height and leaves the body none.
    <aside className="w-64 shrink-0 space-y-4 overflow-y-auto border-l p-4 @max-2xl/issue-detail:max-h-[45%] @max-2xl/issue-detail:w-full @max-2xl/issue-detail:border-t @max-2xl/issue-detail:border-l-0">
      {rows.map((row) => {
        if (!row.when) return null;
        const key = held ? `${row.key}:held` : row.key;
        return row.heading === undefined ? (
          <Fragment key={key}>{row.render()}</Fragment>
        ) : (
          <div key={key} className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              {row.heading}
            </p>
            {row.render()}
          </div>
        );
      })}
    </aside>
  );
}

/** A rail row's link out. Every one targets the issue's own URL — only the
 *  framing (Links / Notifications) differs per provider surface. */
function RailLinkButton({
  url,
  disabledReason,
  children,
}: {
  url: string;
  /** Set while `url` belongs to an issue that isn't the selected one yet. */
  disabledReason?: string;
  children: ReactNode;
}) {
  const { blockedReason, reasonId, wrapperTitle, describedBy, nativeProps } =
    useDisabledReason({
      disabled: !!disabledReason,
      reason: disabledReason,
      onClick: () => void openUrl(url),
    });
  return (
    <span
      className={cn("flex", blockedReason && "cursor-not-allowed")}
      title={wrapperTitle}
    >
      <button
        type="button"
        {...nativeProps}
        aria-describedby={describedBy}
        className={cn(
          ARIA_DISABLED_CLASS,
          "flex w-full cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline",
        )}
      >
        <ArrowSquareOutIcon className="size-3" />
        {children}
      </button>
      {blockedReason ? (
        <span id={reasonId} className="sr-only">
          {blockedReason}
        </span>
      ) : null}
    </span>
  );
}

/** The static milestone row: the hybrid rail's fallback when the picker isn't
 *  available, and the read-only rail's only milestone shape. */
function milestoneValueRow(issue: IssueDetails, when: boolean): IssueRailRow {
  return {
    key: "milestone-value",
    when: when && issue.milestone !== null,
    heading: "Milestone",
    render: () => <p className="text-xs">{issue.milestone?.title}</p>,
  };
}

/** The "View on <provider>" row every non-GitHub rail ends with. */
function viewOnRemoteRow(
  issue: IssueDetails,
  remoteLabel: string,
  when: boolean,
  loadingReason: string | undefined,
): IssueRailRow {
  return {
    key: "links",
    when,
    heading: "Links",
    render: () => (
      <RailLinkButton url={issue.url} disabledReason={loadingReason}>
        View on {remoteLabel}
      </RailLinkButton>
    ),
  };
}

/** The issue's right-hand metadata rail — one ordered row list, each row gated on
 *  the capability that feeds it. Assignees / labels / milestone are the shared
 *  three; issue type, projects, relationships, development and notifications are
 *  GitHub-only (their data comes from `gh_*`); due date, confidential, time
 *  tracking and related issues are GitLab-only (GitHub pins those four
 *  capabilities false, so the two groups can never appear together). A provider
 *  we can only read from gets the static rail instead
 *  ({@link ReadOnlyIssueSidebar}). The affordance carries the cue: a ghost-button
 *  picker means editable; a muted label + value means read-only. */
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
  pickerDisabledReason,
  writeItemReason,
  loadingReason,
  reserve = false,
  held = false,
  paletteEnabled = false,
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
  /** Set when these pickers can't be edited right now — the viewer lacks the tier
   *  they need (TRIAGE, not push), or the rail is still loading the selected
   *  issue. They stay visible but disabled, with this text explaining why.
   *  Absent = editable as before. */
  pickerDisabledReason?: string;
  /** The compact WRITE-axis reason for the rail's one push-tier affordance
   *  (Development → create a linked branch), which triage doesn't cover. */
  writeItemReason?: string;
  /** Set while `issue` is a placeholder for another selected issue: the
   *  link-outs and the branch create hold on it, being `issue`'s own. */
  loadingReason?: string;
  /** The provider is known to be GitHub: its sections hold their empty
   *  state's line while their reads are out. */
  reserve?: boolean;
  /** The host is holding this issue on screen while another loads: portaled
   *  dialogs and picker popups, which `inert` can't reach, stay shut. */
  held?: boolean;
  /** Whether the view hosting this rail owns the current selection, so its
   *  Projects popups may answer the palette. The provider/access term is the
   *  rows' own `when` gate, which is what decides they mount at all. */
  paletteEnabled?: boolean;
}) {
  const setAssignees = useSetIssueAssignees(repoPath, lens);
  const setMilestone = useSetIssueMilestone(repoPath, lens);
  const setType = useSetIssueType(repoPath, lens);
  const setConfidential = useSetIssueConfidential(repoPath);
  const setDueDate = useSetIssueDueDate(repoPath);
  // From the cache, not the observers: the rail remounts per issue, and a write
  // still pending on the issue switched back to must still show.
  const pendingWrites = usePendingIssueWrites(repoPath);
  const dueDateReason = rowPendingReason(
    pendingIssueWrite(pendingWrites, "due-date", (v) => v.number === number),
  );
  const confidentialReason = rowPendingReason(
    pendingIssueWrite(
      pendingWrites,
      "confidential",
      (v) => v.number === number,
    ),
  );

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
    return (
      <ReadOnlyIssueSidebar
        issue={issue}
        remoteLabel={remoteLabel}
        loadingReason={loadingReason}
      />
    );
  }

  // GitHub-only rows gate on `canWrite` ("not a known read-only provider", true
  // while the forge probe is pending) — never a provider equality check.
  const rows: IssueRailRow[] = [
    {
      key: "type",
      when: canWrite,
      render: () => (
        <IssueTypeMenu
          repoPath={repoPath}
          enabled
          value={issue.issueType}
          lens={lens}
          disabledReason={pickerDisabledReason}
          onChange={(type) =>
            setType.mutate({ number, typeName: type?.name ?? null, type })
          }
        />
      ),
    },
    {
      key: "assignees",
      when: canEditAssignees,
      render: () => (
        <AssigneesPopover
          repoPath={repoPath}
          enabled
          value={issue.assignees}
          commitOnClose
          lens={lens}
          disabledReason={pickerDisabledReason}
          onChange={(next) => setAssignees.mutate({ number, assignees: next })}
        />
      ),
    },
    {
      key: "labels",
      when: canEditLabels,
      render: () => (
        <LabelsPopover
          repoPath={repoPath}
          enabled
          number={number}
          target="issue"
          labelableId={issue.id}
          labels={issue.labels}
          lens={lens}
          disabledReason={pickerDisabledReason}
        />
      ),
    },
    {
      key: "projects",
      when: canWrite,
      render: () => (
        <ProjectsPopover
          repoPath={repoPath}
          enabled
          kind="issue"
          number={number}
          contentId={issue.id}
          lens={lens}
          disabledReason={pickerDisabledReason}
          paletteEnabled={paletteEnabled}
        />
      ),
    },
    {
      key: "project-fields",
      when: canWrite,
      render: () => (
        <ProjectFieldValues
          repoPath={repoPath}
          enabled
          kind="issue"
          number={number}
          lens={lens}
          disabledReason={pickerDisabledReason}
          paletteEnabled={paletteEnabled}
        />
      ),
    },
    {
      key: "milestone",
      when: canSetMilestone,
      render: () => (
        <MilestoneMenu
          repoPath={repoPath}
          enabled
          value={issue.milestone?.number ?? null}
          valueLabel={issue.milestone?.title}
          lens={lens}
          disabledReason={pickerDisabledReason}
          onChange={(m, title) =>
            setMilestone.mutate({ number, milestone: m, title })
          }
        />
      ),
    },
    milestoneValueRow(issue, !canSetMilestone),
    {
      key: "relationships",
      when: canWrite,
      render: () => (
        <IssueRelationships
          repoPath={repoPath}
          number={number}
          lens={lens}
          disabledReason={pickerDisabledReason}
          reserve={reserve}
        />
      ),
    },
    {
      key: "development",
      when: canWrite,
      // The rail's one PUSH-tier affordance (creating a linked branch), so it
      // takes the write reason where every other row takes the triage one.
      render: () => (
        <IssueDevelopment
          repoPath={repoPath}
          number={number}
          issue={issue}
          lens={lens}
          disabledReason={writeItemReason ?? loadingReason}
          linkOutReason={loadingReason}
          reserve={reserve}
        />
      ),
    },
    {
      key: "notifications",
      when: canWrite,
      heading: "Notifications",
      render: () => (
        <RailLinkButton url={issue.url} disabledReason={loadingReason}>
          Subscribe on GitHub
        </RailLinkButton>
      ),
    },
    {
      key: "due-date",
      when: canSetDueDate,
      render: () => (
        <DueDateRow
          value={issue.dueDate}
          open={issue.state === "OPEN"}
          pendingReason={dueDateReason}
          disabledReason={pickerDisabledReason}
          onChange={(dueDate) => setDueDate.mutate({ number, dueDate })}
        />
      ),
    },
    {
      key: "confidential",
      when: canSetConfidential,
      render: () => (
        <ConfidentialRow
          value={issue.confidential}
          pendingReason={confidentialReason}
          disabledReason={pickerDisabledReason}
          onChange={(confidential) =>
            setConfidential.mutate({ number, confidential })
          }
        />
      ),
    },
    {
      key: "time-tracking",
      when: canTrackTime,
      render: () => (
        <IssueTimeTrackingSection
          repoPath={repoPath}
          number={number}
          editable={issue.state === "OPEN"}
          disabledReason={pickerDisabledReason}
        />
      ),
    },
    {
      key: "related",
      when: canLinkIssues,
      render: () => (
        <IssueLinksSection
          repoPath={repoPath}
          number={number}
          editable={issue.state === "OPEN"}
          lens={lens}
          disabledReason={pickerDisabledReason}
        />
      ),
    },
    // GitHub frames its link out as Notifications above instead.
    viewOnRemoteRow(issue, remoteLabel, !canWrite, loadingReason),
  ];

  return <IssueRail rows={rows} held={held} />;
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
  pendingReason,
  onChange,
  disabledReason,
}: {
  /** "YYYY-MM-DD" or null. */
  value: string | null;
  /** Whether the issue is open — only then does a past date read "past due". */
  open: boolean;
  /** Set while this row's own write is pending, worded for whether it's saving or
   *  parked offline: Clear holds on it and the row shows it. */
  pendingReason?: string;
  onChange: (date: string | null) => void;
  /** Set when this row can't be edited right now — the viewer lacks the tier it
   *  needs, or the surface is still loading the entity. The input and Clear stay
   *  visible but disabled, with this text as their hint. */
  disabledReason?: string;
}) {
  const pastDue = open && value !== null && isPastDue(value);
  const blocked = !!disabledReason;
  const held = blocked || pendingReason !== undefined;
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
          // The hint sits on the control, not the row — the Label stays live
          // either way.
          <DisabledReasonButton
            type="button"
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            disabled={pendingReason !== undefined || blocked}
            reason={disabledReason ?? pendingReason}
            onClick={() => onChange(null)}
          >
            Clear
          </DisabledReasonButton>
        )}
      </div>
      {/* Uncontrolled while focused (key remounts on external change) so the
          segment editing never fights a controlled re-render; blur commits. */}
      {/* Held while its own write is pending too, so no second date can start;
          the note below the input carries that reason. */}
      <span
        title={disabledReason ?? pendingReason}
        className={held ? "block cursor-not-allowed" : "block"}
      >
        <Input
          key={value ?? ""}
          id="issue-due-date"
          type="date"
          defaultValue={value ?? ""}
          className="h-7"
          disabled={held}
          onBlur={(e) => {
            const next = e.target.value;
            if (next && next !== value) onChange(next);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </span>
      {pastDue && <p className="text-[11px] text-destructive">Past due</p>}
      <PendingWriteNote reason={pendingReason} />
    </div>
  );
}

/** The GitLab-only confidential rail row — hides the issue from non-members. */
function ConfidentialRow({
  value,
  pendingReason,
  onChange,
  disabledReason,
}: {
  value: boolean;
  /** Set while this row's own write is pending; the switch holds on it. */
  pendingReason?: string;
  onChange: (confidential: boolean) => void;
  /** Set when this row can't be edited right now — the viewer lacks the tier it
   *  needs, or the surface is still loading the entity. The switch stays visible
   *  but held, with this text as its hint. */
  disabledReason?: string;
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
        <HeldSwitch
          id="issue-confidential"
          checked={value}
          heldReason={disabledReason ?? pendingReason}
          onCheckedChange={onChange}
        />
      </div>
      {value && (
        <p className="text-[11px] text-muted-foreground">
          Only visible to project members.
        </p>
      )}
      <PendingWriteNote reason={pendingReason} />
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
  disabledReason,
  pendingReason,
}: {
  stats: GitLabTimeStats | undefined;
  editable: boolean;
  pending: boolean;
  /** Words `pending` (saving, or parked offline) for the group's hint and a
   *  visible note; absent leaves the hold unexplained, as the MR popover does. */
  pendingReason?: string;
  /** null resets the estimate. */
  onSetEstimate: (duration: string | null) => void;
  /** null resets spent time; a negative duration ("-15m") subtracts. */
  onAddSpent: (duration: string | null) => void;
  /** Disambiguates the input ids when two instances mount (issue rail + MR). */
  idPrefix: string;
  /** Set when these edits can't be used right now — the viewer lacks the tier they
   *  need, and on the issue rail also while that issue is still loading (the MR
   *  popover passes the permission axis alone). The inputs and their Clear/Reset
   *  buttons disable, with this text as the group's hint. The summary above them
   *  is a read and stays live. */
  disabledReason?: string;
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
        // Group-level hint: the disabled inputs and buttons inside swallow
        // `title`, so the wrapper is the hover target.
        <div
          className={cn(
            "space-y-1.5 pt-0.5",
            disabledReason && "cursor-not-allowed",
          )}
          title={disabledReason ?? (pending ? pendingReason : undefined)}
        >
          <div className="flex items-center gap-1.5">
            <Input
              id={`${idPrefix}-time-estimate`}
              key={humanEstimate}
              defaultValue={humanEstimate}
              className="h-7"
              placeholder="Estimate (e.g. 3h)"
              aria-label="Set time estimate"
              disabled={pending || !!disabledReason}
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
                disabled={pending || !!disabledReason}
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
              disabled={pending || !!disabledReason}
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
                disabled={pending || !!disabledReason}
                onClick={() => onAddSpent(null)}
              >
                Reset
              </Button>
            )}
          </div>
        </div>
      )}
      <PendingWriteNote reason={pending ? pendingReason : undefined} />
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
  disabledReason,
}: {
  repoPath: string;
  number: number;
  editable: boolean;
  /** Set when the editing controls can't be used right now — the viewer lacks the
   *  tier they need, or the rail is still loading the selected issue. The summary
   *  is a read and stays live. */
  disabledReason?: string;
}) {
  const stats = useGlIssueTimeStats(repoPath, number);
  const setEstimate = useSetIssueTimeEstimate(repoPath);
  const addSpent = useAddIssueSpentTime(repoPath);
  const pendingWrites = usePendingIssueWrites(repoPath);
  const estimatePending = pendingIssueWrite(
    pendingWrites,
    "time-estimate",
    (v) => v.number === number,
  );
  const spentPending = pendingIssueWrite(
    pendingWrites,
    "spent-time",
    (v) => v.number === number,
  );
  // Parked only when every pending time write is: one still running is saving.
  const timePending = [estimatePending, spentPending].filter(
    (p) => p !== undefined,
  );
  const pendingReason = rowPendingReason(
    timePending.length > 0
      ? { paused: timePending.every((p) => p.paused) }
      : undefined,
  );

  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">Time tracking</p>
      {stats.isPending ? (
        <p className="text-[11px] text-muted-foreground">Loading…</p>
      ) : (
        <TimeTrackingControls
          stats={stats.data}
          editable={editable}
          pending={pendingReason !== undefined}
          pendingReason={pendingReason}
          disabledReason={disabledReason}
          idPrefix="issue"
          onSetEstimate={(duration) => setEstimate.mutate({ number, duration })}
          onAddSpent={(duration) => addSpent.mutate({ number, duration })}
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
  disabledReason,
}: {
  repoPath: string;
  number: number;
  editable: boolean;
  /** The parent issue's lens (GitLab-only section, so always "origin"). */
  lens: RemoteLens;
  /** Set when link edits can't be used right now — the viewer lacks the tier they
   *  need, or the rail is still loading the selected issue. Add and the per-row
   *  removes disable, with this text as their hint. The list stays live. */
  disabledReason?: string;
}) {
  const links = useGlIssueLinks(repoPath, number);
  const linkIssue = useLinkIssue(repoPath);
  const unlinkIssue = useUnlinkIssue(repoPath);
  const selectIssue = useUiStore((s) => s.selectIssue);
  const [adding, setAdding] = useState(false);
  // From the cache, so a link still pending survives this section's remount.
  const pendingWrites = usePendingIssueWrites(repoPath);
  const linkReason = rowPendingReason(
    pendingIssueWrite(pendingWrites, "link", (v) => v.number === number),
    "Linking the issue…",
  );
  const unlinking = (linkId: string) =>
    rowPending(
      pendingIssueWrite(
        pendingWrites,
        "unlink",
        (v) => v.number === number && v.linkId === linkId,
      ),
      "Removing this link…",
    );
  // A second link while one is pending could name the same issue twice.
  const addReason = disabledReason ?? linkReason;

  const data = links.data ?? [];
  const exclude = new Set<number>([number, ...data.map((l) => l.number)]);

  function open(n: number) {
    selectIssue({ kind: "remote", id: String(n) });
  }

  async function link(target: number) {
    try {
      await linkIssue.mutateAsync({ number, targetNumber: target });
    } catch {
      // useLinkIssue toasts at the mutation level, so a second report here
      // would double up.
      return;
    }
    setAdding(false);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          Related issues
        </span>
        <span className="flex-1" />
        {editable && !adding && (
          <DisabledReasonButton
            variant="ghost"
            size="xs"
            aria-label="Link a related issue"
            disabled={addReason !== undefined}
            reason={addReason}
            onClick={() => setAdding(true)}
          >
            <PlusIcon data-icon="inline-start" />
            Add
            <CaretDownIcon data-icon="inline-end" />
          </DisabledReasonButton>
        )}
      </div>

      {data.map((l) => (
        <RelatedRow
          key={l.linkId}
          issue={toRelated(l)}
          onOpen={open}
          removeDisabledReason={disabledReason}
          pending={unlinking(l.linkId)}
          onRemove={() => unlinkIssue.mutate({ number, linkId: l.linkId })}
        />
      ))}
      <PendingWriteNote reason={linkReason} />

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
              pending={linkReason !== undefined}
              lens={lens}
              onPick={(target) => void link(target)}
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
  loadingReason,
}: {
  issue: IssueDetails;
  remoteLabel: string;
  loadingReason: string | undefined;
}) {
  const hasMeta =
    issue.assignees.length > 0 ||
    issue.labels.length > 0 ||
    issue.milestone !== null ||
    issue.dueDate !== null ||
    issue.confidential;

  const rows: IssueRailRow[] = [
    {
      key: "assignees",
      when: issue.assignees.length > 0,
      heading: "Assignees",
      render: () => (
        <ul className="space-y-1">
          {issue.assignees.map((user) => (
            <li key={user.id} className="flex items-center gap-1.5 text-xs">
              <AuthorAvatar login={user.id} avatarUrl={user.avatarUrl} />
              <span className="truncate" title={user.label}>
                {user.label}
              </span>
            </li>
          ))}
        </ul>
      ),
    },
    {
      key: "labels",
      when: issue.labels.length > 0,
      heading: "Labels",
      render: () => (
        <div className="flex flex-wrap gap-1.5">
          {issue.labels.map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
        </div>
      ),
    },
    milestoneValueRow(issue, true),
    {
      key: "due-date",
      when: !!issue.dueDate,
      heading: "Due date",
      render: () => <p className="text-xs">{issue.dueDate}</p>,
    },
    {
      key: "confidential",
      when: issue.confidential,
      heading: "Confidential",
      render: () => <p className="text-xs">Only visible to project members.</p>,
    },
    {
      key: "empty",
      when: !hasMeta,
      render: () => (
        <p className="text-xs text-muted-foreground">
          No assignees, labels, milestone, or due date.
        </p>
      ),
    },
    viewOnRemoteRow(issue, remoteLabel, true, loadingReason),
  ];

  return <IssueRail rows={rows} />;
}

/**
 * The issue view's loading arm, for an issue with no answer of its own yet (a
 * first open, a lens flip, or a switch whose hold ran out): the loaded view's
 * header, conversation, rail and composer boxes at their loaded positions, so
 * the issue fills in where it will stand rather than reflowing from a stub.
 * `actions` are the loaded header's own controls, held in place while it
 * loads; the caller renders them disabled.
 */
export function IssueLoadingFrame({
  title,
  number,
  actions,
  composer,
}: {
  /** The issue's title from its cached list row, when there is one. The loaded
   *  title wraps around the actions by its length, so the real text wraps this
   *  row the same way; without it a typical title's width stands in. */
  title?: string;
  number: number;
  actions?: ReactNode;
  /** What the loaded view docks under the thread: the comment composer, the
   *  close/reopen bar alone, or nothing. */
  composer: "comment" | "bar" | null;
}) {
  // The composer's collapse is one global preference, read as it reads it.
  const composerCollapsed =
    useSettings().data?.commentComposerCollapsed ?? false;
  return (
    <>
      <span role="status" className="sr-only">
        {ISSUE_SWITCH_LOADING_REASON}
      </span>
      {/* The loaded header's rows, class for class: the title row wraps
          around the same actions, and the meta row is its avatar's 24px. */}
      <header className="space-y-2 border-b px-4 py-3">
        <div className="flex flex-wrap items-start gap-2">
          <div className="min-w-0 flex-auto text-sm font-medium break-words">
            {title === undefined ? (
              <Skeleton
                aria-hidden
                className="inline-block h-4 w-80 max-w-full align-middle"
              />
            ) : (
              <>
                {title}{" "}
                <span className="font-normal text-muted-foreground">
                  #{number}
                </span>
              </>
            )}
          </div>
          {actions}
        </div>
        <div aria-hidden className="flex flex-wrap items-center gap-2">
          <Skeleton className="h-5 w-12" />
          <Skeleton className="size-6 rounded-full" />
          <Skeleton className="h-4 w-40" />
        </div>
      </header>
      <div className="flex min-h-0 flex-1 @max-2xl/issue-detail:flex-col">
        <div
          aria-hidden
          className="min-w-0 flex-1 space-y-2 overflow-hidden p-4 @max-2xl/issue-detail:min-h-0"
        >
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-3/4" />
        </div>
        <aside
          aria-hidden
          className="w-64 shrink-0 space-y-4 overflow-hidden border-l p-4 @max-2xl/issue-detail:max-h-[45%] @max-2xl/issue-detail:w-full @max-2xl/issue-detail:border-t @max-2xl/issue-detail:border-l-0"
        >
          {LOADING_RAIL_BLOCKS.map((key) => (
            <div key={key} className="space-y-1.5">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-4 w-36" />
            </div>
          ))}
        </aside>
      </div>
      {/* CommentComposer's boxes: border-t p-3, then (expanded) the editor
          in an mb-2 wrapper (space-y-1.5: the Write/Preview row and the
          toolbar row of xs buttons, 24 each, and the textarea's min-h-12),
          then the h-7 actions row: 169px expanded, 53 collapsed. The state
          bar alone is the same p-3 around one h-7 row. */}
      {composer !== null && (
        <div aria-hidden className="border-t p-3">
          {composer === "comment" && !composerCollapsed && (
            <div className="mb-2 space-y-1.5">
              <div className="flex items-center gap-1">
                <Skeleton className="h-6 w-12" />
                <Skeleton className="h-6 w-14" />
              </div>
              <Skeleton className="h-6 w-56 max-w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Skeleton className="h-7 w-24" />
            {composer === "comment" && (
              <>
                <span className="flex-1" />
                <Skeleton className="h-7 w-20" />
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

const LOADING_RAIL_BLOCKS = ["a", "b", "c", "d"] as const;

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
  heldReason,
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
  /** Holds the submit with this reason (offline); the parent's handler refuses
   *  the form's Enter submit on the same verdict. */
  heldReason?: string;
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
            {/* The running write outranks the hold. An empty destination stays a
                plain disable: no copy names it. */}
            <DisabledReasonButton
              type="submit"
              disabled={!dest.trim() || pending || heldReason !== undefined}
              reason={pending ? ACT_PENDING_REASON : heldReason}
            >
              {pending && <Spinner data-icon="inline-start" />}
              {verb}
            </DisabledReasonButton>
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
  heldReason,
  onConfirm,
  remoteLabel,
  roleHint,
}: {
  open: boolean;
  onClose: () => void;
  number: number;
  title: string;
  pending: boolean;
  /** Holds the delete with this reason (offline) while the dialog stays open. */
  heldReason?: string;
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
          <DisabledReasonButton
            variant="destructive"
            disabled={pending || heldReason !== undefined}
            reason={pending ? ACT_PENDING_REASON : heldReason}
            onClick={onConfirm}
          >
            {pending && <Spinner data-icon="inline-start" />}
            Delete issue
          </DisabledReasonButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
