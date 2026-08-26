import {
  ArrowSquareOutIcon,
  LockSimpleIcon,
  StarIcon,
} from "@phosphor-icons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { starParts } from "@/features/explore/explore-utils";
import { clipTitleFromText } from "@/lib/clip-title";
import { forgeRepoUrl } from "@/lib/git/api";
import { useForkDivergence } from "@/lib/git/queries";
import {
  type ForgeForkActivity,
  type ForgeForkEntry,
  type ForgeProvider,
  providerLabel,
} from "@/lib/git/types";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { Empty, fmt } from "./primitives";

// Each provider's recency field measures a different thing — GitHub `pushed_at`,
// GitLab `last_activity_at`, Bitbucket `updated_on` — so the verb names what the
// timestamp actually reports instead of flattening all three to "updated".
const ACTIVE_VERB: Record<ForgeProvider, string> = {
  github: "pushed",
  gitlab: "active",
  bitbucket: "updated",
};

// The provider's own full fork list, which this card summarizes to 10 rows.
// Bitbucket names that page "descendants": `/forks` 404s there (probed
// 2026-08-26).
const ALL_FORKS_SUFFIX: Record<ForgeProvider, string> = {
  github: "/network/members",
  gitlab: "/-/forks",
  bitbucket: "/descendants",
};

/** One row's ahead/behind, fetched only after its Compare is clicked. Owns the
 *  request state so a row's fetch never re-renders its siblings; the query key is
 *  per fork and branch pair, so a re-render (or re-opening Insights) reuses the
 *  cached result. */
function CompareCell({
  repoPath,
  entry,
  baseBranch,
}: {
  repoPath: string;
  entry: ForgeForkEntry;
  baseBranch: string;
}) {
  const [requested, setRequested] = useState(false);
  // The control the user clicked unmounts as its result arrives, so focus would
  // fall to <body>. react-query's notify batching can land the result after any
  // frame scheduled from the click, so the follow-up rides the commit instead.
  const pendingFocusRef = useRef(false);
  const resultRef = useRef<HTMLSpanElement | null>(null);
  const retryRef = useRef<HTMLButtonElement | null>(null);
  const divergence = useForkDivergence(
    repoPath,
    entry.fullName,
    baseBranch,
    entry.defaultBranch,
    requested,
  );

  useLayoutEffect(() => {
    if (!pendingFocusRef.current) return;
    if (divergence.data) {
      pendingFocusRef.current = false;
      resultRef.current?.focus();
    } else if (divergence.isError) {
      pendingFocusRef.current = false;
      retryRef.current?.focus();
    }
  }, [divergence.data, divergence.isError]);

  // Resolved counts outrank an in-flight fetch: `refetchOnWindowFocus` re-runs a
  // stale compare on every alt-tab, and dropping back to a skeleton would erase
  // numbers the user is reading.
  if (divergence.data) {
    return (
      <span
        ref={resultRef}
        tabIndex={-1}
        aria-live="polite"
        className="tabular-nums"
      >
        {fmt(divergence.data.aheadBy)} ahead · {fmt(divergence.data.behindBy)}{" "}
        behind
      </span>
    );
  }
  if (divergence.isError) {
    return (
      <span aria-live="polite" className="flex items-center gap-1">
        Couldn't compare
        <Button
          ref={retryRef}
          type="button"
          size="xs"
          variant="ghost"
          aria-label={`Retry comparing ${entry.fullName} with this repository`}
          onClick={() => {
            pendingFocusRef.current = true;
            void divergence.refetch();
          }}
        >
          Retry
        </Button>
      </span>
    );
  }
  if (divergence.isFetching) return <Skeleton className="h-3 w-16" />;
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      aria-label={`Compare ${entry.fullName} with this repository`}
      onClick={() => {
        pendingFocusRef.current = true;
        setRequested(true);
      }}
    >
      Compare
    </Button>
  );
}

function ForkRow({
  repoPath,
  entry,
  provider,
  baseBranch,
  canCompare,
}: {
  repoPath: string;
  entry: ForgeForkEntry;
  provider: ForgeProvider;
  baseBranch: string | null;
  canCompare: boolean;
}) {
  // Zero stars says nothing a reader needs, and at ten-row density the repeated
  // "0" reads as noise — so the segment drops entirely rather than showing it.
  const star = (entry.stars ?? 0) > 0 ? starParts(entry.stars) : null;
  // Without both branch names there is nothing to compare, so the affordance
  // doesn't render at all rather than sitting disabled.
  const comparable = canCompare && baseBranch && entry.defaultBranch;

  // The right side is one sentence, not a pile of chips: whichever segments this
  // fork has, joined by decorative separators.
  const segments: { key: string; node: React.ReactNode }[] = [];
  if (entry.activeAt && parseableDate(entry.activeAt)) {
    segments.push({
      key: "active",
      node: (
        <span>
          {ACTIVE_VERB[provider]} <RelativeTime date={entry.activeAt} />
        </span>
      ),
    });
  }
  if (star) {
    segments.push({
      key: "stars",
      node: (
        // role="img" prunes the icon AND the number, so the label carries both
        // the count and its unit.
        <span
          role="img"
          aria-label={star.label}
          title={star.label}
          className="flex items-center gap-0.5"
        >
          <StarIcon className="size-3" aria-hidden />
          {star.text}
        </span>
      ),
    });
  }
  if (comparable) {
    segments.push({
      key: "compare",
      node: (
        <CompareCell
          repoPath={repoPath}
          entry={entry}
          baseBranch={baseBranch}
        />
      ),
    });
  }

  return (
    <li className="flex items-baseline justify-between gap-3 text-xs">
      <span className="flex min-w-0 items-baseline gap-1">
        {entry.isPrivate && (
          // Same lock glyph and labelling as Explore's repo rows; every row here
          // is a fork, so the glyph only has to distinguish private ones.
          <span
            role="img"
            aria-label="Private fork"
            title="Private fork"
            className="flex shrink-0 self-center text-muted-foreground"
          >
            <LockSimpleIcon className="size-3" aria-hidden />
          </span>
        )}
        {/* A fork with no web URL stays plain text — a link that can only fail
            is worse than none. */}
        {entry.webUrl ? (
          <button
            type="button"
            className="min-w-0 cursor-pointer truncate text-left hover:underline focus-visible:underline focus-visible:outline-none"
            onMouseEnter={clipTitleFromText}
            onClick={() => openUrl(entry.webUrl).catch(toastError)}
          >
            {entry.fullName}
          </button>
        ) : (
          <span className="min-w-0 truncate" onMouseEnter={clipTitleFromText}>
            {entry.fullName}
          </span>
        )}
      </span>
      <span className="flex shrink-0 items-baseline gap-1 tabular-nums text-muted-foreground">
        {segments.map((segment, i) => (
          <Fragment key={segment.key}>
            {i > 0 && <span aria-hidden="true">·</span>}
            {segment.node}
          </Fragment>
        ))}
      </span>
    </li>
  );
}

/** The repo's most-recently-active direct forks, with an on-demand ahead/behind
 *  per row where the provider can compare. */
export function ForkActivityCard({
  repoPath,
  data,
  provider,
  canCompare,
}: {
  repoPath: string;
  data: ForgeForkActivity;
  provider: ForgeProvider;
  canCompare: boolean;
}) {
  async function openAllForks() {
    try {
      const url = await forgeRepoUrl(repoPath);
      if (!url) return;
      await openUrl(`${url}${ALL_FORKS_SUFFIX[provider]}`);
    } catch (e) {
      toastError(e);
    }
  }

  // A counted-but-unlisted fork is the private-fork case: the provider reports it
  // in the total and withholds the row.
  if (data.forks.length === 0 && (data.totalCount ?? 0) > 0) {
    return <Empty>No forks visible to you.</Empty>;
  }
  if (data.forks.length === 0) return <Empty>No forks yet.</Empty>;

  return (
    <div className="space-y-3">
      <ul className="space-y-0.5">
        {data.forks.map((entry) => (
          <ForkRow
            key={entry.fullName}
            repoPath={repoPath}
            entry={entry}
            provider={provider}
            baseBranch={data.defaultBranch}
            canCompare={canCompare}
          />
        ))}
      </ul>
      <div>
        <Button
          variant="outline"
          size="sm"
          className="cursor-pointer justify-start"
          onClick={openAllForks}
        >
          <ArrowSquareOutIcon data-icon="inline-start" />
          All forks on {providerLabel(provider)}
        </Button>
      </div>
    </div>
  );
}
