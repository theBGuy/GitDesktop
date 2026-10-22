import { type ReactNode, useLayoutEffect, useRef } from "react";
import { DiffStat } from "@/components/diff-stat";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  detailNoticeMessage,
  refreshFailed,
  resolveDetailPane,
} from "@/features/conversations/remote-section-state";
import { presentError } from "@/lib/error-summary";
import {
  useBranchStats,
  useDefaultBranch,
  useRepoStats,
  useRepoStatus,
} from "@/lib/git/queries";
import {
  DateValue,
  fmt,
  formatBytes,
  LanguageMakeup,
  SectionTitle,
  Stat,
} from "./primitives";

/**
 * The Insights sidebar: the repository's at-a-glance numbers (formerly the
 * "Repository statistics…" dialog) — overview, language makeup, top
 * contributors, and the current branch vs the default branch. The richer
 * charts live in the wide `InsightsBoard` on the right.
 */
export function InsightsPanel({
  repoPath,
  active,
}: {
  repoPath: string;
  active: boolean;
}) {
  // useRepoStats/useBranchStats are heavy scans; gate them on the Insights tab
  // being visible (<Activity> keeps this mounted but doesn't defer fetches).
  const stats = useRepoStats(repoPath, active);
  const status = useRepoStatus(repoPath);
  const defaultBranch = useDefaultBranch(repoPath);
  const currentBranch = status.data?.branch?.name ?? null;
  const base = defaultBranch.data ?? null;
  const branchStats = useBranchStats(repoPath, currentBranch, base, active);
  const showBranch =
    currentBranch !== null && base !== null && currentBranch !== base;
  const data = stats.data;

  // A failed refresh keeps the loaded numbers under a notice; only a read with
  // nothing loaded replaces them. The branch comparison below keeps its own line.
  const pane = resolveDetailPane({
    pending: stats.isPending,
    error: stats.isError,
    hasData: data !== undefined,
    paused: stats.isPaused,
    fetching: stats.isFetching,
  });
  const failed = refreshFailed(stats);
  // Retry resets the read to pending, swapping the error arm for the skeleton;
  // every arm renders in the same panel column, so focus lands there.
  const { hostRef, retryRef } = useRetryFocusRescue(
    pane === "error" && stats.isError,
  );
  // Degraded content is the same arm, so a failed or recovered refresh never
  // moves focus.
  const arm = pane === "content-degraded" ? "content" : pane;
  // An arm swap or record switch that unmounts the focused node would drop
  // focus to <body>; land it on the host. Change-only, so a mount never takes
  // focus from elsewhere.
  const focusHost = useRef<HTMLDivElement | null>(null);
  const viewFrame = `${arm}:${repoPath}`;
  const lastViewFrame = useRef(viewFrame);
  useLayoutEffect(() => {
    if (lastViewFrame.current === viewFrame) return;
    lastViewFrame.current = viewFrame;
    if (document.activeElement === document.body)
      focusHost.current?.focus({ preventScroll: true });
  }, [viewFrame]);
  // The host is the panel column, not the scroll body: a tabIndex on the body
  // would take the keyboard tab stop Chromium gives a scroller without one.
  const shell = (content: ReactNode) => (
    <div
      ref={(node) => {
        hostRef(node);
        focusHost.current = node;
      }}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      <div className="flex items-center border-b p-2">
        <h2 className="px-1 text-xs font-medium text-muted-foreground">
          Overview
        </h2>
      </div>
      <DegradedListNotice
        noun="the overview"
        degraded={pane === "content-degraded"}
        message={detailNoticeMessage({
          noun: "overview",
          isError: failed,
          stale: stats.isPlaceholderData,
        })}
        onRetry={failed ? () => void stats.refetch() : undefined}
        className="shrink-0 border-b px-3 py-1.5"
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{content}</div>
    </div>
  );

  // The scan is local, so it never parks offline: that arm keeps loading.
  if (pane === "skeleton" || pane === "offline") {
    return shell(
      <div className="space-y-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>,
    );
  }
  if (pane === "error" || !data) {
    return shell(
      <div className="py-4 text-center text-xs">
        <p className="font-medium text-destructive">
          Couldn't gather statistics.
        </p>
        {stats.isError ? (
          <>
            <p className="mt-1 text-muted-foreground">
              {presentError(stats.error).summary}
            </p>
            <Button
              ref={retryRef}
              variant="outline"
              size="sm"
              className="mt-2 cursor-pointer"
              onClick={() => void stats.refetch()}
            >
              Retry
            </Button>
          </>
        ) : null}
      </div>,
    );
  }

  return shell(
    <div className="space-y-5">
      <section>
        <SectionTitle>Overview</SectionTitle>
        <dl className="grid grid-cols-1 gap-x-8">
          <Stat label="Commits">{fmt(data.commitCount)}</Stat>
          <Stat label="Contributors">
            <span
              title={data.topContributors
                .map((c) => `${c.name} — ${fmt(c.commits)} commits`)
                .join("\n")}
            >
              {fmt(data.contributorCount)}
            </span>
          </Stat>
          <Stat label="Branches">{fmt(data.branchCount)}</Stat>
          <Stat label="Tags">{fmt(data.tagCount)}</Stat>
          <Stat label="Tracked files">{fmt(data.trackedFiles)}</Stat>
          <Stat label="Lines of text">{fmt(data.totalLines)}</Stat>
          <Stat label="Working tree size">
            {formatBytes(data.trackedBytes)}
          </Stat>
          <Stat label="Git data (.git)">{formatBytes(data.gitDirBytes)}</Stat>
          <Stat label="First commit">
            <DateValue date={data.firstCommitDate} />
          </Stat>
          <Stat label="Last commit">
            <DateValue date={data.lastCommitDate} />
          </Stat>
        </dl>
      </section>

      <section>
        <SectionTitle>Code makeup</SectionTitle>
        <LanguageMakeup languages={data.languages} />
      </section>

      {data.topContributors.length > 0 && (
        <section>
          <SectionTitle>Top contributors</SectionTitle>
          <ul className="space-y-0.5">
            {data.topContributors.map((c) => (
              <li
                key={c.name}
                className="flex items-baseline justify-between gap-3 text-xs"
              >
                <span className="truncate">{c.name}</span>
                <span className="tabular-nums text-muted-foreground">
                  {fmt(c.commits)} {c.commits === 1 ? "commit" : "commits"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {showBranch && (
        <section>
          <SectionTitle>
            <span className="font-mono">{currentBranch}</span>{" "}
            <span className="font-normal text-muted-foreground">vs {base}</span>
          </SectionTitle>
          {branchStats.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : branchStats.data ? (
            <dl className="grid grid-cols-1 gap-x-8">
              <Stat label="Commits ahead">
                {fmt(branchStats.data.commitCount)}
              </Stat>
              <Stat label="Contributors">
                {fmt(branchStats.data.contributorCount)}
              </Stat>
              <Stat label="Files changed">
                {fmt(branchStats.data.filesChanged)}
              </Stat>
              <Stat label="Lines changed">
                <DiffStat
                  added={branchStats.data.additions}
                  deleted={branchStats.data.deletions}
                  format={fmt}
                />
              </Stat>
              <Stat label="First branch commit">
                <DateValue date={branchStats.data.firstCommitDate} />
              </Stat>
              <Stat label="Latest branch commit">
                <DateValue date={branchStats.data.lastCommitDate} />
              </Stat>
            </dl>
          ) : (
            <p className="text-xs text-muted-foreground">
              Couldn't compare against {base}.
            </p>
          )}
        </section>
      )}
    </div>,
  );
}
