import { type ReactNode, useState } from "react";
import { DiffStat } from "@/components/diff-stat";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DegradedListNotice } from "@/features/conversations/ConversationListPanel";
import {
  offlinePendingMessage,
  refreshFailed,
} from "@/features/conversations/remote-section-state";
import { presentError } from "@/lib/error-summary";
import {
  forgeFeatureReady,
  useCodeFrequency,
  useCommitActivity,
  useCommunityInsights,
  useContributorActivity,
  useForgeStatus,
  useForkActivity,
  usePunchCard,
  useRepoDependencies,
  useRepoTraffic,
} from "@/lib/git/queries";
import type { ContributorChurn } from "@/lib/git/types";
import { useWorkflowRuns } from "@/lib/github/actions";
import { CommunityCard } from "./CommunityCard";
import {
  ActionsDurationChart,
  CodeFrequencyChart,
  CommitActivityChart,
  type RunDurationPoint,
} from "./charts";
import { DependenciesCard } from "./DependenciesCard";
import { ForkActivityCard } from "./ForkActivityCard";
import {
  BitbucketLinkOutsCard,
  GitLabLinkOutsCard,
  LinkOutsCard,
  LinkOutsSkeleton,
} from "./LinkOutsCard";
import { PunchCard, PunchCardSkeleton } from "./PunchCard";
import { Empty, fmt, InsightCard } from "./primitives";
import { TrafficCard } from "./TrafficCard";

const WINDOW_WEEKS = 52;

/** Body heights: each at least the loaded arm (a chart card counts a 2-line
 *  caption and the table toggle), so loading, empty and loaded paint one
 *  height. A min, not a fixed height: an expanded data table, or a list longer
 *  than its reservation, still grows the card. `contributors` is exactly the
 *  six-row skeleton (6 x 26px rows + 5 x 6px gaps). `traffic` is sized for
 *  4-digit counts at the 640 px window floor. */
const CARD_BODY = {
  chart: "min-h-57",
  community: "min-h-48",
  dependencies: "min-h-74",
  contributors: "min-h-46.5",
  traffic: "min-h-72.5",
} as const;

/** Rows the contributors skeleton reserves: a typical list. Shorter lists keep
 *  the space ({@link CARD_BODY}); longer ones grow downward to the 12-row cap. */
const CONTRIBUTOR_SKELETON_ROWS = ["a", "b", "c", "d", "e", "f"];

/** Fills a {@link CARD_BODY} slot. */
function ChartSkeleton() {
  return <Skeleton className="w-full flex-1" />;
}

/** {@link ContributorsList}'s row boxes (name line + bar), so loaded rows land
 *  where the skeleton's were. */
function ContributorsSkeleton() {
  return (
    <ul aria-hidden className="space-y-1.5">
      {CONTRIBUTOR_SKELETON_ROWS.map((key) => (
        <li key={key} className="space-y-1">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-1.5 w-full rounded-full" />
        </li>
      ))}
    </ul>
  );
}

/** TrafficCard's usual top: the stat row and the 14-day chart figure. The
 *  referrer and path lists below it may still grow the card. */
function TrafficSkeleton() {
  return (
    <div aria-hidden className="flex flex-1 flex-col gap-3">
      <Skeleton className="h-6 w-full" />
      <Skeleton className="min-h-48 w-full flex-1" />
    </div>
  );
}

/** Top contributors as an accessible bar-list (name + commits + line churn). */
function ContributorsList({ data }: { data: ContributorChurn[] }) {
  const top = data.slice(0, 12);
  const max = Math.max(1, ...top.map((c) => c.commits));
  return (
    <ul className="space-y-1.5">
      {top.map((c) => (
        <li key={c.name} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="truncate font-medium" title={c.name}>
              {c.name}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {fmt(c.commits)} {c.commits === 1 ? "commit" : "commits"} ·{" "}
              <DiffStat
                added={c.additions}
                deleted={c.deletions}
                format={fmt}
              />
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${(c.commits / max) * 100}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Every card that reads data of its own, in board order: the board notice
 *  names the first failure in this order. */
type CardId =
  | "commitActivity"
  | "codeFrequency"
  | "contributors"
  | "commitTimes"
  | "runs"
  | "forkActivity"
  | "community"
  | "traffic"
  | "dependencies";

/** What a card's failure line says it couldn't load. `runs` is the GitHub
 *  noun; pipeline providers swap in their own at the call site. */
const CARD_NOUN: Record<CardId, string> = {
  commitActivity: "commit activity",
  codeFrequency: "code frequency",
  contributors: "contributors",
  commitTimes: "commit times",
  runs: "workflow runs",
  forkActivity: "fork activity",
  community: "community insights",
  traffic: "traffic",
  dependencies: "dependencies",
};

type CardRead = {
  data: unknown;
  error: unknown;
  isError: boolean;
  isPaused: boolean;
  isFetching: boolean;
  refetch: () => Promise<unknown>;
};

/** A card's body while its read holds no data. A hosted read parked offline
 *  says it waits, a settled failure says it couldn't load (never an empty
 *  claim), and anything else still loads. Muted and non-live: the board notice
 *  is the one announcement. */
function unloadedCard(q: CardRead, noun: string, skeleton: ReactNode) {
  if (q.isPaused) return <Empty>{offlinePendingMessage(noun)}</Empty>;
  if (refreshFailed(q)) return <Empty>Couldn't load {noun}.</Empty>;
  return skeleton;
}

/** The board's one failure line and the reads its Retry refetches, or null.
 *  Silent only while a user's Retry is settling (`retrying`), so the sentence
 *  never swaps mid-retry; a background refetch, a polling run list's
 *  included, never blanks it. */
function boardNotice(
  cards: readonly (readonly [CardId, CardRead])[],
  retrying: boolean,
) {
  const failed = cards.filter(([, q]) => refreshFailed(q));
  if (retrying || failed.length === 0) return null;
  const message = failed.every(([, q]) => q.data !== undefined)
    ? "Couldn't refresh some insights — showing the last loaded ones."
    : `Couldn't load some insights. ${presentError(failed[0][1].error).summary}`;
  return { message, failed: failed.map(([, q]) => q) };
}

function durationMinutes(start: string, end: string): number {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 0;
  // ms → minutes (÷60_000), rounded to 2 decimals (×100 / round / ÷100).
  return Math.round(((e - s) / 60_000) * 100) / 100;
}

/**
 * The wide Insights board: the local-git graphs (commit activity, code
 * frequency, contributors, punch card) over a trailing window, plus a GitHub
 * Actions duration/success trend and a community-health card. All local data is
 * computed from the clone (works offline, on private repos, with no token).
 */
export function InsightsBoard({
  repoPath,
  active,
}: {
  repoPath: string;
  active: boolean;
}) {
  const [allTime, setAllTime] = useState(false);
  // The Retry in flight, as a token: a newer press supersedes an older one's
  // settle. Cleared on a repo switch, whose cards it never refetched.
  const [retrying, setRetrying] = useState<object | null>(null);
  const [retryRepo, setRetryRepo] = useState(repoPath);
  if (retryRepo !== repoPath) {
    setRetryRepo(repoPath);
    setRetrying(null);
  }
  const weeks = allTime ? 0 : WINDOW_WEEKS;

  const gh = useForgeStatus(repoPath);
  // The hosted cards gate on the insights flag; the CI card is forge-backed
  // (GitLab pipelines work), while community / traffic / dependencies are
  // GitHub-only APIs with no GitLab analogue and hide per provider.
  const canGh = active && forgeFeatureReady(gh.data, "insights");
  const isGitLab = gh.data?.provider === "gitlab";
  const isBitbucket = gh.data?.provider === "bitbucket";
  // Positive gate: the community / traffic / dependencies cards are GitHub-only
  // APIs, so fire them ONLY for GitHub. A `!isGitLab` shape would (with insights
  // now enabled for Bitbucket) light them up on Bitbucket repos too.
  const canGhOnly = canGh && gh.data?.provider === "github";
  // Fork activity is hosted-but-all-forge (like CI), so it rides its own flag
  // rather than the GitHub-only gate; ahead/behind is a separate flag because
  // only GitHub can compare across forks.
  const canForks = active && forgeFeatureReady(gh.data, "forkActivity");
  const canCompare = forgeFeatureReady(gh.data, "forkCompare");
  const forkProvider = gh.data?.provider ?? null;
  // While the forge probe is unanswered, the GitHub cards draw as skeletons in
  // their slots (their queries are disabled, so each reads pending) instead of
  // mounting late and pushing the grid down; any other answer drops them once.
  const forgeDetecting = active && gh.isPending;

  // These are heavy (full-history git scans + gh calls); gate them on the
  // Insights tab being visible, as a backstop: a hidden <Activity> panel holds
  // no query observers, so it already fetches nothing until Insights opens.
  const commitActivity = useCommitActivity(repoPath, weeks, active);
  const codeFreq = useCodeFrequency(repoPath, weeks, active);
  const punchCard = usePunchCard(repoPath, weeks, active);
  const contributors = useContributorActivity(repoPath, weeks, active);
  const community = useCommunityInsights(repoPath, canGhOnly);
  const traffic = useRepoTraffic(repoPath, canGhOnly);
  const dependencies = useRepoDependencies(repoPath, canGhOnly);
  const forkActivity = useForkActivity(repoPath, canForks);
  const runs = useWorkflowRuns(repoPath, canGh, active);

  const completed = (runs.data ?? []).filter((r) => r.status === "completed");
  const successRate = completed.length
    ? Math.round(
        (100 * completed.filter((r) => r.conclusion === "success").length) /
          completed.length,
      )
    : null;
  const durationPoints: RunDurationPoint[] = completed
    .filter((r) => r.startedAt)
    .slice(0, 30)
    .reverse()
    .map((r) => ({
      run: `#${r.number}`,
      minutes: durationMinutes(r.startedAt, r.updatedAt),
      conclusion: r.conclusion || "—",
    }));

  const noun: Record<CardId, string> = {
    ...CARD_NOUN,
    runs: isGitLab || isBitbucket ? "pipelines" : CARD_NOUN.runs,
  };
  // The cards on screen with a read of their own, in board order.
  const notice = boardNotice(
    [
      ["commitActivity", commitActivity],
      ["codeFrequency", codeFreq],
      ["contributors", contributors],
      ["commitTimes", punchCard],
      ...(canGh ? ([["runs", runs]] as const) : []),
      ...(canForks && forkProvider
        ? ([["forkActivity", forkActivity]] as const)
        : []),
      ...(canGhOnly
        ? ([
            ["community", community],
            ["traffic", traffic],
            ["dependencies", dependencies],
          ] as const)
        : []),
    ],
    retrying !== null,
  );
  const retryFailed = notice
    ? () => {
        const token = {};
        setRetrying(token);
        void Promise.allSettled(notice.failed.map((q) => q.refetch())).then(
          () => setRetrying((t) => (t === token ? null : t)),
        );
      }
    : undefined;

  return (
    // `h-full`, not `flex-1`: the tab host this mounts in is a block element, so
    // a flex-item sizing hint is inert there and the grid's natural height would
    // leak into the document instead of scrolling inside the board.
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between border-b p-2">
        <h2 className="px-1 text-xs font-medium text-muted-foreground">
          Insights
        </h2>
        <div
          className="flex items-center gap-0.5"
          role="group"
          aria-label="Time window"
        >
          <Button
            type="button"
            size="xs"
            variant={allTime ? "ghost" : "secondary"}
            aria-pressed={!allTime}
            onClick={() => setAllTime(false)}
          >
            {WINDOW_WEEKS} weeks
          </Button>
          <Button
            type="button"
            size="xs"
            variant={allTime ? "secondary" : "ghost"}
            aria-pressed={allTime}
            onClick={() => setAllTime(true)}
          >
            All time
          </Button>
        </div>
      </div>
      <DegradedListNotice
        noun="insights"
        degraded={notice !== null}
        message={notice?.message}
        retryLabel="Retry loading insights"
        onRetry={retryFailed}
        className="shrink-0 border-b px-3 py-1.5"
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <InsightCard
            title="Commit activity"
            bodyClassName={CARD_BODY.chart}
            stale={commitActivity.isPlaceholderData}
          >
            {commitActivity.data === undefined ? (
              unloadedCard(
                commitActivity,
                noun.commitActivity,
                <ChartSkeleton />,
              )
            ) : commitActivity.data.length ? (
              <CommitActivityChart data={commitActivity.data} />
            ) : (
              <Empty>No commits in this window.</Empty>
            )}
          </InsightCard>

          <InsightCard
            title="Code frequency"
            bodyClassName={CARD_BODY.chart}
            stale={codeFreq.isPlaceholderData}
          >
            {codeFreq.data === undefined ? (
              unloadedCard(codeFreq, noun.codeFrequency, <ChartSkeleton />)
            ) : codeFreq.data.length ? (
              <CodeFrequencyChart data={codeFreq.data} />
            ) : (
              <Empty>No code changes in this window.</Empty>
            )}
          </InsightCard>

          <InsightCard
            title="Contributors"
            className="xl:col-span-2"
            bodyClassName={CARD_BODY.contributors}
            stale={contributors.isPlaceholderData}
          >
            {contributors.data === undefined ? (
              unloadedCard(
                contributors,
                noun.contributors,
                <ContributorsSkeleton />,
              )
            ) : contributors.data.length ? (
              <ContributorsList data={contributors.data} />
            ) : (
              <Empty>No contributors in this window.</Empty>
            )}
          </InsightCard>

          <InsightCard
            title="Commits by day & hour"
            className="xl:col-span-2"
            stale={punchCard.isPlaceholderData}
          >
            {punchCard.data === undefined ? (
              unloadedCard(punchCard, noun.commitTimes, <PunchCardSkeleton />)
            ) : (
              <PunchCard grid={punchCard.data} />
            )}
          </InsightCard>

          {(canGh || forgeDetecting) && (
            <InsightCard
              title={isGitLab || isBitbucket ? "Pipelines" : "Actions"}
              bodyClassName={CARD_BODY.chart}
              action={
                successRate !== null && (
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {successRate}% success · {completed.length} runs
                  </span>
                )
              }
            >
              {runs.data === undefined ? (
                unloadedCard(runs, noun.runs, <ChartSkeleton />)
              ) : durationPoints.length ? (
                <ActionsDurationChart data={durationPoints} />
              ) : (
                <Empty>No completed {noun.runs} yet.</Empty>
              )}
            </InsightCard>
          )}

          {((canForks && forkProvider) || forgeDetecting) && (
            <InsightCard
              title="Fork activity"
              bodyClassName={CARD_BODY.chart}
              action={
                forkActivity.data?.totalCount != null && (
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {fmt(forkActivity.data.totalCount)}{" "}
                    {forkActivity.data.totalCount === 1 ? "fork" : "forks"}
                  </span>
                )
              }
            >
              {forkActivity.data === undefined ? (
                unloadedCard(forkActivity, noun.forkActivity, <ChartSkeleton />)
              ) : forkProvider ? (
                <ForkActivityCard
                  repoPath={repoPath}
                  data={forkActivity.data}
                  provider={forkProvider}
                  canCompare={canCompare}
                />
              ) : (
                <Empty>Fork activity is unavailable.</Empty>
              )}
            </InsightCard>
          )}

          {(canGhOnly || forgeDetecting) && (
            <InsightCard title="Community" bodyClassName={CARD_BODY.community}>
              {community.data === undefined ? (
                unloadedCard(community, noun.community, <ChartSkeleton />)
              ) : (
                <CommunityCard data={community.data} />
              )}
            </InsightCard>
          )}

          {(canGhOnly || forgeDetecting) && (
            <InsightCard
              title="Traffic"
              className="xl:col-span-2"
              bodyClassName={CARD_BODY.traffic}
            >
              {traffic.data === undefined ? (
                unloadedCard(traffic, noun.traffic, <TrafficSkeleton />)
              ) : (
                <TrafficCard data={traffic.data} />
              )}
            </InsightCard>
          )}

          {(canGhOnly || forgeDetecting) && (
            <InsightCard
              title="Dependencies"
              bodyClassName={CARD_BODY.dependencies}
            >
              {dependencies.data === undefined ? (
                unloadedCard(dependencies, noun.dependencies, <ChartSkeleton />)
              ) : (
                <DependenciesCard data={dependencies.data} />
              )}
            </InsightCard>
          )}

          {(canGhOnly || forgeDetecting) && (
            <InsightCard title="More on GitHub">
              {forgeDetecting ? (
                <LinkOutsSkeleton />
              ) : (
                <LinkOutsCard
                  repoPath={repoPath}
                  // Undefined while community loads, which holds the
                  // public-only link's cell; a failed read hides it, and so
                  // does one parked offline, which could hold it for the
                  // whole outage.
                  isPublic={
                    community.isPending && community.fetchStatus !== "paused"
                      ? undefined
                      : community.data
                        ? !community.data.private
                        : false
                  }
                />
              )}
            </InsightCard>
          )}

          {canGh && isGitLab && (
            // GitLab analytics that only render on the web (no usable API) —
            // link out rather than pretend they don't exist.
            <InsightCard title="More on GitLab">
              <GitLabLinkOutsCard repoPath={repoPath} />
            </InsightCard>
          )}

          {canGh && isBitbucket && (
            // Bitbucket views that only render on the web (no usable API) —
            // link out rather than pretend they don't exist.
            <InsightCard title="More on Bitbucket">
              <BitbucketLinkOutsCard repoPath={repoPath} />
            </InsightCard>
          )}
        </div>
      </div>
    </div>
  );
}
