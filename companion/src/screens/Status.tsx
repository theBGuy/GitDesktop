import {
  ArrowDownIcon,
  ArrowUpIcon,
  GitBranchIcon,
} from "@phosphor-icons/react";
import type { FileEntry } from "@/lib/git/types";
import {
  ErrorState,
  isRepoGoneError,
  RepoGoneState,
  SkeletonRows,
  StaleBanner,
} from "../components/states";
import { useStatus } from "../lib/queries";

// Status is a calm glanceable column (not a dashboard): current branch, its
// ahead/behind vs. upstream, and a small tally of working-tree changes.

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
      <div className="flex flex-col gap-6 px-4 py-6">
        <section className="flex flex-col gap-1">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Current branch
          </p>
          <p className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <GitBranchIcon size={20} className="shrink-0 text-primary" />
            <span className="truncate">
              {branch.detached ? "Detached HEAD" : (branch.name ?? "—")}
            </span>
          </p>
          {branch.upstream ? (
            <p className="text-xs text-muted-foreground">
              Tracking {branch.upstream}
              {branch.upstreamGone ? " (gone)" : ""}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">No upstream</p>
          )}
        </section>

        {branch.upstream && !branch.upstreamGone ? (
          <section className="flex gap-6">
            <Stat
              icon={<ArrowUpIcon size={16} className="text-info" />}
              label="Ahead"
              value={branch.ahead}
            />
            <Stat
              icon={<ArrowDownIcon size={16} className="text-warning" />}
              label="Behind"
              value={branch.behind}
            />
          </section>
        ) : null}

        <section className="flex flex-col gap-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Working tree
          </p>
          {clean ? (
            <p className="text-sm text-muted-foreground">Clean — no changes.</p>
          ) : (
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <Stat label="Staged" value={counts.staged} />
              <Stat label="Changed" value={counts.unstaged} />
              <Stat label="Untracked" value={counts.untracked} />
            </div>
          )}
        </section>
      </div>
    </div>
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
      <span className="flex items-center gap-1.5 text-2xl font-semibold tabular-nums text-foreground">
        {icon}
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
