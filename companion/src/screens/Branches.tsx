import {
  ArrowDownIcon,
  ArrowUpIcon,
  GitBranchIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import {
  EmptyState,
  ErrorState,
  isRepoGoneError,
  RepoGoneState,
  SkeletonRows,
  StaleBanner,
} from "../components/states";
import type { Branch } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useBranches } from "../lib/queries";
import { useRovingList } from "../lib/use-roving-list";

// The Branches tab: the repo's local-branch list (read-only in slice 6). Mirrors
// the Prs list anatomy — SkeletonRows / ErrorState / RepoGoneState / EmptyState /
// StaleBanner semantics, `<ul>` divide-y, roving keyboard nav — but rows are NOT
// tappable (there's no branch-detail surface), so each row is a plain list item
// (roving still moves focus for scanning/scroll). Order: current branch first,
// then by lastCommitDate desc; archived branches are de-emphasized and sorted last.

/** The local branches list. `repoId` scopes the query; `active` gates polling. */
export function BranchesBody({
  repoId,
  active,
}: {
  repoId: string;
  active: boolean;
}) {
  const { data, isError, error, refetch } = useBranches(repoId, active);
  const { register, onKeyDown } = useRovingList();
  // True roving tabindex: the tab stop follows the last-focused row (arrow nav or
  // click), so Tab-ing away and back returns to it, not row 0. Keyed by branch
  // NAME, not index — a poll can reorder the list under a remembered position,
  // and identity keeps the stop on the same branch; an unknown/absent name falls
  // back to row 0. `onFocus` syncs with useRovingList's .focus(). (Review r6+r7.)
  const [focusName, setFocusName] = useState<string | null>(null);

  // Definitive gone WINS over stale data: a `noSuchRepo` 404 kicks to the teaching
  // state even when a cached list is on hand (see isRepoGoneError).
  if (isRepoGoneError(error)) return <RepoGoneState />;

  // Prefer stale data: keep the last-known list on screen even on error, with a
  // StaleBanner above it. Full-screen ErrorState only when there's nothing to
  // show; skeleton only while the first fetch is pending.
  if (!data) {
    if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
    return <SkeletonRows />;
  }

  const branches = sortBranches(data);
  // "Only the current branch exists" is a real (fresh-repo) state — show the single
  // row PLUS a teaching hint rather than an empty list.
  const onlyCurrent = branches.length === 1 && branches[0].isCurrent;

  return (
    <div className="flex flex-col">
      {isError ? <StaleBanner error={error} onRetry={() => refetch()} /> : null}
      {branches.length === 0 ? (
        <EmptyState
          title="No branches."
          hint="This repository's local branches will show up here."
        />
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border">
            {branches.map((branch, i) => (
              <li key={branch.name}>
                <div
                  ref={register(i)}
                  onKeyDown={onKeyDown}
                  // A focusable, roving list row (repo convention: every list gets
                  // keyboard nav) — but NOT a control: there's no branch detail to
                  // open, so it's a plain row, not a button/link.
                  tabIndex={
                    (
                      focusName != null &&
                      branches.some((b) => b.name === focusName)
                        ? branch.name === focusName
                        : i === 0
                    )
                      ? 0
                      : -1
                  }
                  onFocus={() => setFocusName(branch.name)}
                  className={`flex min-h-14 items-center gap-3 px-4 py-3 outline-none focus-visible:bg-muted/40 ${
                    branch.archived ? "opacity-60" : ""
                  }`}
                >
                  <BranchRow branch={branch} />
                </div>
              </li>
            ))}
          </ul>
          {onlyCurrent ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              No other branches.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Sort branches for display: the current branch first, then archived branches
 *  last; within each group, most-recently-committed first. */
function sortBranches(branches: Branch[]): Branch[] {
  return [...branches].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return dateOrder(b.lastCommitDate) - dateOrder(a.lastCommitDate);
  });
}

/** Sort key for a branch's last-commit date — parsed epoch ms, or 0 for an
 *  empty/invalid date (Array.sort here is stable, so equal keys keep input order). */
function dateOrder(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function BranchRow({ branch }: { branch: Branch }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <GitBranchIcon
          size={16}
          className={`shrink-0 ${
            branch.isCurrent ? "text-primary" : "text-muted-foreground"
          }`}
          aria-hidden
        />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {branch.name}
        </span>
        {branch.isCurrent ? <TagChip label="current" /> : null}
        {branch.archived ? <TagChip label="archived" /> : null}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {branch.upstream
            ? `${branch.upstream}${branch.upstreamGone ? " (gone)" : ""}`
            : "No upstream"}
        </span>
        <Divergence branch={branch} />
        <span className="shrink-0 tabular-nums">
          {timeAgo(branch.lastCommitDate)}
        </span>
      </div>
    </div>
  );
}

/** The ahead/behind badges. Glyph + number so the divergence never rests on color
 *  alone (WCAG 1.4.1) — the same info/warning icon colors Status uses for ahead
 *  (info) / behind (warning). Nothing renders when the branch is even, has no
 *  upstream, or its upstream is gone. */
function Divergence({ branch }: { branch: Branch }) {
  if (!branch.upstream || branch.upstreamGone) return null;
  const { upstreamAhead: ahead, upstreamBehind: behind } = branch;
  if (ahead === 0 && behind === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-2 tabular-nums">
      {ahead > 0 ? (
        <span className="flex items-center gap-0.5">
          <ArrowUpIcon size={12} className="text-info" aria-hidden />
          {ahead}
          <span className="sr-only"> ahead</span>
        </span>
      ) : null}
      {behind > 0 ? (
        <span className="flex items-center gap-0.5">
          <ArrowDownIcon size={12} className="text-warning" aria-hidden />
          {behind}
          <span className="sr-only"> behind</span>
        </span>
      ) : null}
    </span>
  );
}

/** A small neutral marker chip (current / archived) — text-only, no color-coded
 *  meaning, matching the companion's restrained register. */
function TagChip({ label }: { label: string }) {
  return (
    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {label}
    </span>
  );
}
