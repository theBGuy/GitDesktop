import {
  ArrowCounterClockwiseIcon,
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  PencilSimpleIcon,
  TagIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { type KeyboardEvent, type MouseEvent, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import type { CommitRow } from "@/features/conversations/CommitsList";
import type { PrTimelineEvent } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { cn } from "@/lib/utils";

/** A merged timeline entry: the keys the feed sorts by, plus EITHER a ready
 *  `node` (reviews, comments, events — RemotePrView owns their wiring) OR a
 *  `commit` marker that the consumer coalesces into a grouped "pushed N" row
 *  after sorting. Built in RemotePrView; the light rows + sort helper live here. */
export interface TimelineEntry {
  /** ISO date used to order the feed (oldest→newest). "" sinks to the top. */
  date: string;
  /** Tiebreaker within the same instant, so a stable render order survives equal
   *  timestamps (e.g. a review + its request landing together). */
  sortKey: number;
  /** A fully-rendered feed node; omitted for a bare commit marker. */
  node?: React.ReactNode;
  /** A commit to be grouped into a "pushed N commits" row; omitted otherwise. */
  commit?: CommitRow;
}

/** Sort ascending by date (oldest→newest, matching GitHub + the prior order),
 *  falling back to `sortKey` for equal instants. A missing/empty date sorts as
 *  epoch 0 so it lands at the top rather than NaN-poisoning the comparison. */
export function sortTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  const ms = (d: string) => {
    const t = new Date(d).getTime();
    return Number.isNaN(t) ? 0 : t;
  };
  return [...entries].sort(
    (a, b) => ms(a.date) - ms(b.date) || a.sortKey - b.sortKey,
  );
}

/** Sets a hover title only when the content is actually clipped by `truncate`;
 *  mirrors the only-when-clipped pattern across the repo (CommitsList). */
const clipTitle = (value: string) => (e: MouseEvent<HTMLElement>) => {
  const el = e.currentTarget;
  el.title = el.scrollWidth > el.clientWidth ? value : "";
};

/** The thin neutral rail + centered icon that every light event row hangs off.
 *  A 1px structural connective line (NOT a colored side-stripe) — the icon
 *  carries any semantic tone. */
function RailIcon({
  Icon,
  tone,
  label,
}: {
  Icon: typeof GitCommitIcon;
  tone?: string;
  label: string;
}) {
  return (
    <div className="relative flex w-5 shrink-0 justify-center">
      {/* The vertical connective rail: 1px, neutral (border token). */}
      <div
        aria-hidden
        className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-border"
      />
      <div className="relative mt-0.5 bg-background py-0.5">
        <Icon className={cn("size-3.5", tone)} aria-label={label} />
      </div>
    </div>
  );
}

/** Presentation (icon, tone, verb phrase, actor) for one timeline event. Icon +
 *  word — never color-alone. Returns the pieces so the row can render actor +
 *  time consistently. `label` is the accessible verb; `extra` is optional
 *  trailing content (e.g. a label color dot). */
function eventPresentation(event: PrTimelineEvent): {
  Icon: typeof GitCommitIcon;
  tone?: string;
  label: string;
  colorDot?: string;
} {
  switch (event.kind) {
    case "forcePushed":
      return {
        Icon: ArrowsClockwiseIcon,
        label: `force-pushed ${(event.before || "?").slice(0, 7)}…${(event.after || "?").slice(0, 7)}`,
      };
    case "labeled":
      return {
        Icon: TagIcon,
        label: event.added
          ? `added the ${event.label} label`
          : `removed the ${event.label} label`,
        colorDot: event.color,
      };
    case "reviewRequested":
      return {
        Icon: GitPullRequestIcon,
        label: `requested a review from ${event.reviewer || "someone"}`,
      };
    case "readyForReview":
      return {
        Icon: GitPullRequestIcon,
        label: "marked this ready for review",
      };
    case "convertToDraft":
      return { Icon: PencilSimpleIcon, label: "converted this to a draft" };
    case "approved":
      return {
        Icon: CheckCircleIcon,
        tone: "text-success",
        label: "approved these changes",
      };
    case "changesRequested":
      return {
        Icon: XCircleIcon,
        tone: "text-warning",
        label: "requested changes",
      };
    case "unapproved":
      return {
        Icon: ArrowCounterClockwiseIcon,
        label: "withdrew their approval",
      };
    case "closed":
      return {
        Icon: XCircleIcon,
        tone: "text-destructive",
        label: "closed this",
      };
    case "reopened":
      return {
        Icon: CheckCircleIcon,
        tone: "text-success",
        label: "reopened this",
      };
    case "merged":
      return {
        Icon: GitMergeIcon,
        tone: "text-merged",
        label: event.commitOid
          ? `merged this in ${event.commitOid.slice(0, 7)}`
          : "merged this",
      };
    case "renamed":
      return {
        Icon: GitBranchIcon,
        label: `renamed this from ${event.previous} to ${event.current}`,
      };
  }
}

/** A calm, GitHub-timeline-density event row: rail + icon + actor + muted verb
 *  phrase + relative time. */
export function TimelineEventRow({ event }: { event: PrTimelineEvent }) {
  const { Icon, tone, label, colorDot } = eventPresentation(event);
  return (
    <div className="flex items-start gap-2 text-xs">
      <RailIcon Icon={Icon} tone={tone} label={label} />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 py-0.5 text-muted-foreground">
        {event.actor && (
          <span className="font-medium text-foreground">{event.actor}</span>
        )}
        {colorDot && (
          <span
            aria-hidden
            className="inline-block size-2 shrink-0 rounded-full border"
            style={{ backgroundColor: `#${colorDot}` }}
          />
        )}
        <span className="min-w-0 truncate" onMouseEnter={clipTitle(label)}>
          {label}
        </span>
        {event.date && (
          <span className="shrink-0 text-muted-foreground/80">
            · <RelativeTime date={event.date} />
          </span>
        )}
      </div>
    </div>
  );
}

/** A grouped "pushed N commits" row — a keyboard-activable disclosure that
 *  expands to the run of commits (arrow-navigable). Reuses the CommitRow shape
 *  so the sublist matches the Commits tab. When `onSelectCommit` is given each
 *  commit row becomes a button that drills into that commit's detail (click or
 *  Enter, plus arrow-key nav); without it the rows stay non-interactive. */
export function PushedCommitsRow({
  commits,
  onSelectCommit,
}: {
  commits: CommitRow[];
  /** Drill into commit `id` (its oid). When absent, rows are non-interactive. */
  onSelectCommit?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const n = commits.length;
  // The feed is sorted oldest→newest and the run preserves that order, so the
  // newest commit (the run's timestamp) is the last one. This is the AUTHORED
  // date — no push time exists in the PR payload — so a rebased/cherry-picked
  // batch can read older than its position in the feed.
  const headerDate = commits[n - 1]?.date;

  // Arrow keys walk the sublist; Enter/Space activate the focused row — both
  // route through `onSelectCommit`. Wired only when the list is interactive.
  // Roving focus: `activeIndex` is derived from whichever row currently holds DOM
  // focus (its `data-row` = the commit id), so ArrowUp/Down step continuously
  // from wherever focus is — a frozen `activeIndex: -1` would always jump to row 0.
  const onKeyDown = onSelectCommit
    ? (e: KeyboardEvent<HTMLUListElement>) => {
        const focusedId =
          document.activeElement instanceof HTMLElement
            ? document.activeElement.getAttribute("data-row")
            : null;
        const activeIndex = focusedId
          ? commits.findIndex((c) => c.id === focusedId)
          : -1;
        listKeyboardNav({
          items: commits,
          activeIndex,
          onActivate: (c) => onSelectCommit(c.id),
          rowKey: (c) => c.id,
        })(e);
      }
    : undefined;

  return (
    <div className="flex items-start gap-2 text-xs">
      <RailIcon
        Icon={GitCommitIcon}
        label={`pushed ${n} commit${n === 1 ? "" : "s"}`}
      />
      <div className="min-w-0 flex-1 py-0.5">
        <div className="flex items-center gap-x-1.5">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            {open ? (
              <CaretDownIcon className="size-3 shrink-0" />
            ) : (
              <CaretRightIcon className="size-3 shrink-0" />
            )}
            pushed {n} commit{n === 1 ? "" : "s"}
          </button>
          {headerDate && (
            <span className="shrink-0 text-muted-foreground/80">
              · <RelativeTime date={headerDate} />
            </span>
          )}
        </div>
        {open && (
          <ul className="mt-1 space-y-0.5 border-l pl-2" onKeyDown={onKeyDown}>
            {commits.map((c) =>
              onSelectCommit ? (
                // The whole row is the click/focus target (a forgiving hit
                // area); the short sha is cued as the link. Enter fires the
                // same drill-in as click (and arrow-nav focuses each row).
                <li key={c.id}>
                  <button
                    type="button"
                    data-row={c.id}
                    onClick={() => onSelectCommit(c.id)}
                    title={`View commit ${c.shortSha}`}
                    className="group flex w-full cursor-pointer items-baseline gap-2 text-left"
                  >
                    <span
                      className="min-w-0 flex-1 truncate"
                      onMouseEnter={clipTitle(c.subject)}
                    >
                      {c.subject}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-primary underline-offset-2 group-hover:underline">
                      {c.shortSha}
                    </span>
                    {c.date && (
                      <span className="shrink-0 text-[11px] text-muted-foreground/80">
                        · <RelativeTime date={c.date} />
                      </span>
                    )}
                  </button>
                </li>
              ) : (
                <li key={c.id}>
                  <div className="flex items-baseline gap-2">
                    <span
                      className="min-w-0 flex-1 truncate"
                      onMouseEnter={clipTitle(c.subject)}
                    >
                      {c.subject}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {c.shortSha}
                    </span>
                    {c.date && (
                      <span className="shrink-0 text-[11px] text-muted-foreground/80">
                        · <RelativeTime date={c.date} />
                      </span>
                    )}
                  </div>
                </li>
              ),
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The subtle stale marker rendered right after an out-of-date approval /
 *  changes-requested review: warning-toned, icon + word (never color-alone). */
export function StaleReviewMarker({ commitsSince }: { commitsSince: number }) {
  return (
    <div className="flex items-center gap-1 pl-7 text-[11px] text-warning">
      <WarningIcon className="size-3 shrink-0" aria-hidden />
      <span>
        stale · {commitsSince} commit{commitsSince === 1 ? "" : "s"} since
      </span>
    </div>
  );
}
