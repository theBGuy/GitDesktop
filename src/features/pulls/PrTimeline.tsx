import {
  ArrowCounterClockwiseIcon,
  ArrowsClockwiseIcon,
  ArrowsLeftRightIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  FlagIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitMergeIcon,
  GitPullRequestIcon,
  LinkBreakIcon,
  LinkIcon,
  LockSimpleIcon,
  LockSimpleOpenIcon,
  PencilSimpleIcon,
  ProhibitIcon,
  PushPinIcon,
  PushPinSlashIcon,
  StackIcon,
  TagIcon,
  UserMinusIcon,
  UserPlusIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useState,
} from "react";
import { ForgeUserAvatar } from "@/components/forge-user-avatar";
import { RelativeTime } from "@/components/relative-time";
import type { CommitRow } from "@/features/conversations/CommitsList";
import type { ForgeTimelineEvent } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { parseableDate } from "@/lib/time";
import { cn } from "@/lib/utils";

/** A merged timeline entry: the keys the feed sorts by, plus EITHER a ready
 *  `node` (reviews, comments, events — the building view owns their wiring) OR a
 *  `commit` marker that {@link coalesceCommitRuns} groups into a "pushed N" row
 *  after sorting. Built in PrActivityFeed (remote PRs) and LocalPrView (local
 *  ones); the light rows, the sort and the coalescer live here. */
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

/** Walk SORTED entries, emitting each ready `node` in place and folding every run
 *  of adjacent commit markers into whatever `renderPush` returns (a grouped
 *  "pushed N commits" row). `runStart` is the run's index into `sorted`, so a
 *  caller's key stays stable across refetches and PushedCommitsRow keeps its
 *  disclosure state.
 *
 *  `renderPush` receives a COPY of the run: the accumulator is cleared in place
 *  and React doesn't read props until the whole render returns, so handing out
 *  the live array would make every earlier row show the last run's commits. */
export function coalesceCommitRuns(
  sorted: TimelineEntry[],
  renderPush: (run: CommitRow[], runStart: number) => ReactNode,
): ReactNode[] {
  const rendered: ReactNode[] = [];
  const run: CommitRow[] = [];
  let runStart = 0;
  const flush = () => {
    if (run.length === 0) return;
    rendered.push(renderPush([...run], runStart));
    run.length = 0;
  };
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i];
    if (entry.commit) {
      if (run.length === 0) runStart = i;
      run.push(entry.commit);
    } else {
      flush();
      rendered.push(entry.node);
    }
  }
  flush();
  return rendered;
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

/** A referenced PR/issue a timeline row points at. `repo` is its `owner/name`, or
 *  `""` when the provider didn't say — a reference can live in ANOTHER repository,
 *  so the number alone can't address it. */
interface ReferenceChipData {
  /** `"pr"` / `"issue"`, or `""` when the entity's type is unknown. */
  kind: string;
  number: number;
  title: string;
  repo: string;
}

interface EventPresentation {
  Icon: typeof GitCommitIcon;
  tone?: string;
  label: string;
  colorDot?: string;
  /** Rendered after the label as a compact `#N` + title reference. */
  refChip?: ReferenceChipData;
}

/** Per-reason presentation for a `closed` event (GitHub issues only); the plain PR
 *  close and every unknown reason fall back to the base close in `eventPresentation`. */
const CLOSE_REASON_PRESENTATION: Partial<Record<string, EventPresentation>> = {
  // Completed is a resolution, so it takes the terminal-success token rather than
  // the destructive close.
  completed: {
    Icon: CheckCircleIcon,
    tone: "text-merged",
    label: "closed this as completed",
  },
  duplicate: {
    Icon: XCircleIcon,
    tone: "text-destructive",
    label: "closed this as a duplicate",
  },
  // Not-planned is a dismissal rather than a resolution, so it reads muted — the
  // prohibit glyph, not the destructive X.
  not_planned: {
    Icon: ProhibitIcon,
    tone: "text-muted-foreground",
    label: "closed this as not planned",
  },
};

/** Presentation (icon, tone, verb phrase, actor) for one timeline event. Icon +
 *  word — never color-alone. Returns the pieces so the row can render actor +
 *  time consistently. `label` is the accessible verb; `extra` is optional
 *  trailing content (e.g. a label color dot). */
function eventPresentation(event: ForgeTimelineEvent): EventPresentation {
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
      return (
        CLOSE_REASON_PRESENTATION[event.stateReason] ?? {
          Icon: XCircleIcon,
          tone: "text-destructive",
          label: "closed this",
        }
      );
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
    case "assigned": {
      // An actor assigning themselves reads as "self-assigned", matching how every
      // forge phrases it; `actor.label` and `assignee` are both the login.
      const self = event.actor.label === event.assignee;
      if (event.added) {
        return {
          Icon: UserPlusIcon,
          label: self ? "self-assigned this" : `assigned ${event.assignee}`,
        };
      }
      return {
        Icon: UserMinusIcon,
        label: self
          ? "removed their assignment"
          : `unassigned ${event.assignee}`,
      };
    }
    case "milestoned":
      return {
        Icon: FlagIcon,
        label: event.added
          ? `added this to the ${event.milestone} milestone`
          : `removed this from the ${event.milestone} milestone`,
      };
    case "crossReferenced":
      // A deleted or inaccessible referent comes back as number 0 — say the plain
      // thing rather than offer a chip that leads nowhere.
      if (!event.sourceNumber) {
        return { Icon: LinkIcon, label: "mentioned this" };
      }
      return {
        Icon: LinkIcon,
        label: "mentioned this in",
        refChip: {
          kind: event.sourceKind,
          number: event.sourceNumber,
          title: event.sourceTitle,
          repo: event.sourceRepo,
        },
      };
    case "connected":
      if (!event.sourceNumber) {
        return {
          Icon: event.added ? LinkIcon : LinkBreakIcon,
          label: event.added ? "linked this" : "unlinked this",
        };
      }
      return {
        Icon: event.added ? LinkIcon : LinkBreakIcon,
        label: event.added ? "linked" : "unlinked",
        refChip: {
          kind: event.sourceKind,
          number: event.sourceNumber,
          title: event.sourceTitle,
          repo: event.sourceRepo,
        },
      };
    case "pinned":
      return {
        Icon: event.added ? PushPinIcon : PushPinSlashIcon,
        label: event.added ? "pinned this" : "unpinned this",
      };
    case "locked":
      if (!event.locked) {
        return {
          Icon: LockSimpleOpenIcon,
          label: "unlocked this conversation",
        };
      }
      return {
        Icon: LockSimpleIcon,
        label: event.reason
          ? `locked this conversation as ${event.reason.replaceAll("_", " ")}`
          : "locked this conversation",
      };
    case "transferred":
      return {
        Icon: ArrowsLeftRightIcon,
        label: event.fromRepo
          ? `transferred this from ${event.fromRepo}`
          : "transferred this from another repository",
      };
    case "markedAsDuplicate":
      if (!event.canonicalNumber) {
        return { Icon: StackIcon, label: "marked this as a duplicate" };
      }
      return {
        Icon: StackIcon,
        label: "marked this as a duplicate of",
        refChip: {
          kind: event.canonicalKind,
          number: event.canonicalNumber,
          title: "",
          repo: event.canonicalRepo,
        },
      };
  }
}

/** The compact `owner/name#N` + title reference a cross-reference / link / duplicate
 *  row points at. Interactive only when the caller can navigate there AND the ref is
 *  in the viewed repo: a cross-repo number would drill into the wrong entity, so it
 *  renders as text carrying its repo prefix instead. An empty `chip.repo` is the
 *  wire's same-repo GUARANTEE, not an unknown (ForgeTimelineEventOut::CrossReferenced
 *  pins that contract), which is why it passes the gate. */
function ReferenceChip({
  chip,
  onOpenRef,
  selfRepo,
}: {
  chip: ReferenceChipData;
  onOpenRef?: (kind: "pr" | "issue", number: number) => void;
  selfRepo?: string;
}) {
  const sameRepo =
    chip.repo === "" || chip.repo.toLowerCase() === selfRepo?.toLowerCase();
  const kind = chip.kind === "pr" || chip.kind === "issue" ? chip.kind : null;
  const ref = `${sameRepo ? "" : chip.repo}#${chip.number}`;
  const body = (
    <>
      <span className="shrink-0 font-mono">{ref}</span>
      {chip.title && (
        <span className="min-w-0 truncate" onMouseEnter={clipTitle(chip.title)}>
          {chip.title}
        </span>
      )}
    </>
  );
  if (!onOpenRef || !kind || !sameRepo) {
    return <span className="flex min-w-0 items-center gap-1">{body}</span>;
  }
  return (
    // No `title` here: the inner span's clipTitle sets title="" when the text isn't
    // clipped, and an empty title on a descendant SUPPRESSES the ancestor's tooltip
    // rather than deferring to it — the clipped-text tooltip is the one that matters.
    <button
      type="button"
      onClick={() => onOpenRef(kind, chip.number)}
      className="flex min-w-0 cursor-pointer items-center gap-1 text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring/50"
    >
      {body}
    </button>
  );
}

/** A calm, GitHub-timeline-density event row: rail + icon + actor avatar + actor +
 *  muted verb phrase + relative time. The avatar is decorative — the login is right
 *  beside it, and a metadata row must not add a tab stop per event. */
export function TimelineEventRow({
  event,
  ghHost,
  onOpenRef,
  selfRepo,
}: {
  event: ForgeTimelineEvent;
  /** GitHub host for the actor's login-derived avatar (`null` off GitHub). Resolved
   *  once by the feed and passed down: it's feed-constant, and reading it per row
   *  would be one store subscription per event. */
  ghHost: string | null;
  /** Drill into a referenced PR/issue from a reference chip. Without it the chip
   *  stays plain text. */
  onOpenRef?: (kind: "pr" | "issue", number: number) => void;
  /** The viewed repo's `owner/name`, so a cross-repo reference can be told apart
   *  from a local one and rendered non-interactive. */
  selfRepo?: string;
}) {
  const { Icon, tone, label, colorDot, refChip } = eventPresentation(event);
  return (
    <div className="flex items-start gap-2 text-xs">
      <RailIcon Icon={Icon} tone={tone} label={label} />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 py-0.5 text-muted-foreground">
        {event.actor.label && (
          <>
            <ForgeUserAvatar
              user={event.actor}
              ghHost={ghHost}
              size="sm"
              decorative
              className="size-4"
            />
            <span className="font-medium text-foreground">
              {event.actor.label}
            </span>
          </>
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
        {refChip && (
          <ReferenceChip
            chip={refChip}
            onOpenRef={onOpenRef}
            selfRepo={selfRepo}
          />
        )}
        {parseableDate(event.date) && (
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
          {headerDate && parseableDate(headerDate) && (
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
                    {c.date && parseableDate(c.date) && (
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
                    {c.date && parseableDate(c.date) && (
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
