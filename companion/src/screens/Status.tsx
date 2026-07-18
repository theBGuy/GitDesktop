import {
  ArrowDownIcon,
  ArrowUpIcon,
  GitBranchIcon,
} from "@phosphor-icons/react";
import type { FileEntry } from "@/lib/git/types";
import { SkeletonRows } from "../components/states";
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

/** The Status body. Loading/error/no-repo are handled by the shell; this only
 *  renders once data (or a skeleton) is available. */
export function StatusBody({ active }: { active: boolean }) {
  const { data, isPending } = useStatus(active);

  if (isPending || !data) return <SkeletonRows count={4} />;

  const branch = data.branch;
  const counts = changeCounts(data.entries);
  const clean = counts.total === 0;

  return (
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
