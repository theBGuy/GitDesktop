import { ArrowLeftIcon, CaretRightIcon } from "@phosphor-icons/react";
import type { PrInfo } from "@/lib/git/types";
import { PrStateChip } from "../components/chips";
import {
  EmptyState,
  ErrorState,
  SkeletonRows,
  StaleBanner,
} from "../components/states";
import { timeAgo } from "../lib/format";
import { usePr, usePrs } from "../lib/queries";
import { navigate } from "../lib/router";
import { useRovingList } from "../lib/use-roving-list";

/** The PR list. `active` gates polling. */
export function PrsBody({ active }: { active: boolean }) {
  const { data, isError, error, refetch } = usePrs(active);
  const { register, onKeyDown } = useRovingList();

  // Prefer stale data: keep the last-known list on screen even on error, with a
  // StaleBanner above it. Full-screen ErrorState only when there's nothing to
  // show; skeleton only while the first fetch is pending. (401/409 route through
  // ErrorState/the shell exactly as before.)
  if (!data) {
    if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
    return <SkeletonRows />;
  }

  return (
    <div className="flex flex-col">
      {isError ? <StaleBanner error={error} onRetry={() => refetch()} /> : null}
      {data.length === 0 ? (
        <EmptyState
          title="No open pull requests."
          hint="Open PRs on this repository will show up here."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {data.map((pr, i) => (
            <li key={pr.number}>
              <button
                type="button"
                ref={register(i)}
                onKeyDown={onKeyDown}
                onClick={() => navigate(`#prs/${pr.number}`)}
                className="flex w-full min-h-14 items-center gap-3 px-4 py-3 text-left"
              >
                <PrRow pr={pr} />
                <CaretRightIcon
                  size={16}
                  className="shrink-0 text-muted-foreground"
                />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PrRow({ pr }: { pr: PrInfo }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <PrStateChip state={pr.state} isDraft={pr.isDraft} />
        <span className="text-xs text-muted-foreground">#{pr.number}</span>
      </div>
      <p className="mt-1 truncate text-sm font-medium text-foreground">
        {pr.title}
      </p>
      <p className="truncate text-xs text-muted-foreground">
        {pr.author?.login ? `${pr.author.login} · ` : ""}
        {timeAgo(pr.createdAt)}
      </p>
    </div>
  );
}

/** A read-only PR detail. */
export function PrDetail({ number }: { number: number }) {
  const { data, isPending, isError, error, refetch } = usePr(number);

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-2 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => navigate("#prs")}
          className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm font-medium text-primary"
        >
          <ArrowLeftIcon size={16} />
          PRs
        </button>
      </div>

      {isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isPending || !data ? (
        <SkeletonRows count={3} />
      ) : (
        <article className="flex flex-col gap-4 px-4 py-5">
          <header className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <PrStateChip state={data.state} isDraft={data.isDraft} />
              <span className="text-xs text-muted-foreground">
                #{data.number}
              </span>
            </div>
            <h1 className="text-base font-semibold text-foreground">
              {data.title}
            </h1>
            <p className="text-xs text-muted-foreground">
              {data.author ? `${data.author} · ` : ""}
              {data.headRefName} → {data.baseRefName}
            </p>
            <p className="text-xs text-muted-foreground tabular-nums">
              +{data.additions} −{data.deletions} · {data.commits.length} commit
              {data.commits.length === 1 ? "" : "s"} · {data.files.length} file
              {data.files.length === 1 ? "" : "s"}
            </p>
          </header>

          {data.body ? (
            <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">
              {data.body}
            </p>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              No description.
            </p>
          )}
        </article>
      )}
    </div>
  );
}
