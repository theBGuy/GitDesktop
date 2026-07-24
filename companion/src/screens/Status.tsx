import {
  ArrowDownIcon,
  ArrowUpIcon,
  CaretRightIcon,
  GitBranchIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { FileEntry } from "@/lib/git/types";
import {
  ErrorState,
  isRepoGoneError,
  RepoGoneState,
  SkeletonRows,
  StaleBanner,
} from "../components/states";
import type { CommitSummary, TagInfo } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useLog, useStatus, useTags } from "../lib/queries";
import { navigate, repoHash, type Tab } from "../lib/router";

// Status is the repo HUB — still glanceable (each group ANSWERS at a glance:
// branch + divergence, change counts, latest commit subjects), with drilling into
// the fuller surface an optional tap deeper. Three full-width tappable groups
// (Branches / Changes / History) plus a small recent-commits strip. Restrained
// register: existing tokens only, chevron affordance, ≥44px targets, never
// color-alone.

function changeCounts(entries: FileEntry[]) {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const e of entries) {
    if (e.staged) staged++;
    if (e.unstaged === "untracked") untracked++;
    else if (e.unstaged) unstaged++;
  }
  return { staged, unstaged, untracked, total: entries.length };
}

/** The Status body. The shell handles 401 (→ #pair) and 409 (no repo shared)
 *  centrally; every OTHER error is handled here keyed on THIS query, preferring
 *  stale data: when a snapshot exists we keep showing it (with a StaleBanner on
 *  error) rather than blanking to a full-screen error — the phone-on-flaky-wifi
 *  case is the normal case. Full-screen `ErrorState` only when there's no data at
 *  all; skeleton only while pending. */
export function StatusBody({
  repoId,
  active,
}: {
  repoId: string;
  active: boolean;
}) {
  const { data, isError, error, refetch } = useStatus(repoId, active);

  // Definitive gone WINS over stale data: a `noSuchRepo` 404 means the repo is no
  // longer shared, so the teaching state must render even when a cached snapshot
  // exists (otherwise the poll's 404 would sit silently behind stale content).
  if (isRepoGoneError(error)) return <RepoGoneState />;

  if (!data) {
    if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
    return <SkeletonRows count={4} />;
  }

  const branch = data.branch;
  const counts = changeCounts(data.entries);
  const clean = counts.total === 0;

  return (
    <div className="flex flex-col">
      {isError ? <StaleBanner error={error} onRetry={() => refetch()} /> : null}
      <div className="flex flex-col divide-y divide-border">
        <HubGroup repoId={repoId} tab="branches" label="Branch">
          <p className="flex items-center gap-2 text-base font-semibold text-foreground">
            <GitBranchIcon size={18} className="shrink-0 text-primary" />
            <span className="truncate">
              {branch.detached ? "Detached HEAD" : (branch.name ?? "—")}
            </span>
          </p>
          {branch.upstream ? (
            <p className="truncate text-xs text-muted-foreground">
              Tracking {branch.upstream}
              {branch.upstreamGone ? " (gone)" : ""}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">No upstream</p>
          )}
          {branch.upstream && !branch.upstreamGone ? (
            <div className="mt-1 flex gap-4">
              <Stat
                icon={<ArrowUpIcon size={14} className="text-info" />}
                label="Ahead"
                value={branch.ahead}
              />
              <Stat
                icon={<ArrowDownIcon size={14} className="text-warning" />}
                label="Behind"
                value={branch.behind}
              />
            </div>
          ) : null}
        </HubGroup>

        <HubGroup repoId={repoId} tab="changes" label="Working tree">
          {clean ? (
            <p className="text-sm text-muted-foreground">Clean — no changes.</p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Stat label="Staged" value={counts.staged} />
              <Stat label="Changed" value={counts.unstaged} />
              <Stat label="Untracked" value={counts.untracked} />
            </div>
          )}
        </HubGroup>

        <HubGroup repoId={repoId} tab="history" label="Recent commits">
          <RecentCommits repoId={repoId} active={active} />
        </HubGroup>

        <HubGroup repoId={repoId} tab="tags" label="Tags">
          <TagsGlance repoId={repoId} active={active} />
        </HubGroup>

        <HubGroup repoId={repoId} tab="todos" label="Code TODOs">
          {/* Deliberately a STATIC child, NOT a query: a TODO scan is a git-grep
              sweep across the working tree, so the hub must never fire one — the
              scan runs only once the user opens the tab. */}
          <p className="text-sm text-muted-foreground">
            Scan the working tree for TODO markers.
          </p>
        </HubGroup>
      </div>
    </div>
  );
}

/** One tappable hub group: a full-width link row that drills into `tab`, with a
 *  right chevron affordance and a ≥44px target. The group still ANSWERS at a
 *  glance (its children render live data) — drilling is optional depth. It's a
 *  real `<a>` so it joins the screen's natural tab order (no roving for 3 items). */
function HubGroup({
  repoId,
  tab,
  label,
  children,
}: {
  repoId: string;
  tab: Tab;
  label: string;
  children: ReactNode;
}) {
  return (
    <a
      href={repoHash(repoId, tab)}
      onClick={(e) => {
        // Keep in-app hash navigation (adds a history entry) rather than a full
        // document navigation, matching the rest of the companion's link rows.
        e.preventDefault();
        navigate(repoHash(repoId, tab));
      }}
      className="flex min-h-11 items-center gap-3 px-4 py-4"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        {children}
      </div>
      <CaretRightIcon
        size={16}
        className="shrink-0 text-muted-foreground"
        aria-hidden
      />
    </a>
  );
}

/** The recent-commits strip inside the History hub group: up to 3 truncated
 *  subjects + relative times. Deliberately non-blocking — while loading it shows a
 *  quiet skeleton line, and on error it omits its rows entirely (the group row
 *  itself stays tappable, so History can still load its own data). Fetches only 3
 *  rows; the History tab pages the full log. */
function RecentCommits({
  repoId,
  active,
}: {
  repoId: string;
  active: boolean;
}) {
  const { data, isPending } = useLog(repoId, active, 0, 3);

  if (isPending && !data) {
    return (
      <div className="flex flex-col gap-1.5" aria-hidden>
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  // On error (data undefined, not pending) omit the strip's rows — never block the
  // hub on the strip. The group header row stays tappable.
  if (!data || data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {data ? "No commits yet." : "Open to view history."}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-1">
      {data.slice(0, 3).map((commit: CommitSummary) => (
        <li
          key={commit.hash}
          className="flex items-baseline justify-between gap-2 text-sm"
        >
          <span className="min-w-0 truncate text-foreground/90">
            {commit.subject}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {timeAgo(commit.date)}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The tags glance inside the Tags hub group: the single newest tag as
 *  `{name} · {timeAgo}`. Non-blocking exactly like RecentCommits — a quiet pulse
 *  line while loading, a calm "Open to view tags." on error (the group row stays
 *  tappable), and "No tags yet." when there are none. Fetches the full tags list
 *  (the same query the Tags tab uses, so the hub warms its cache) and reads only
 *  the first entry. */
function TagsGlance({ repoId, active }: { repoId: string; active: boolean }) {
  const { data, isPending } = useTags(repoId, active);

  if (isPending && !data) {
    return (
      <div className="flex flex-col gap-1.5" aria-hidden>
        <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  // On error (data undefined, not pending) omit the glance — never block the hub on
  // it. The group header row stays tappable.
  if (!data || data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {data ? "No tags yet." : "Open to view tags."}
      </p>
    );
  }

  const tag: TagInfo = data[0];
  return (
    <p className="flex items-baseline gap-1.5 text-sm">
      <span className="min-w-0 truncate font-medium text-foreground">
        {tag.name}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        · {timeAgo(tag.date)}
      </span>
    </p>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-xl font-semibold tabular-nums text-foreground">
        {icon}
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
