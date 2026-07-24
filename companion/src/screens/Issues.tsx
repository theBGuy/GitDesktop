// The Issues tab: the issue list + an issue detail. Mirrors the Prs screen anatomy
// (list/detail states, back bar, roving-list, Markdown bodies) — issues carry no
// activity timeline over LAN, so there's no Activity/Threads section here.

import {
  ArrowLeftIcon,
  CaretRightIcon,
  EyeSlashIcon,
  InfoIcon,
  LockIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { IssueStateChip } from "../components/chips";
import { Markdown } from "../components/markdown";
import {
  EmptyState,
  ErrorState,
  isRepoGoneError,
  RepoGoneState,
  SkeletonRows,
  StaleBanner,
} from "../components/states";
import { IssuesDiscussionsSegment } from "../components/tab-segment";
import type { IssueComment, IssueDetails, IssueInfo } from "../lib/api";
import { timeAgo } from "../lib/format";
import { asApiError, useIssue, useIssues } from "../lib/queries";
import { navigate, repoHash } from "../lib/router";
import { useRovingList } from "../lib/use-roving-list";

/** Whether a query error is the DEFINITIVE "this repo has no usable issue tracker" —
 *  a GitHub fork with issues turned off (`issuesDisabled`) or a Bitbucket repo
 *  (issues deprecated → a 400 `invalidArgument`). The server sends a human-readable
 *  `message`; the screens surface it as a calm teaching state (NOT the generic error,
 *  and no retry — a retry can't turn the tracker on). Uses the `ApiError` fields — no
 *  string matching. `issuesDisabled` is matched regardless of status: a newer desktop
 *  sends it as a 400, but a phone talking to an OLDER desktop still gets a 502 with
 *  that kind, and it's a stable state either way. */
function isTrackerUnavailable(error: unknown): boolean {
  const api = asApiError(error);
  if (!api) return false;
  return (
    api.kind === "issuesDisabled" ||
    (api.status === 400 && api.kind === "invalidArgument")
  );
}

/** The calm teaching state for a repo whose issue tracker isn't usable. Mirrors the
 *  states.tsx `CenteredState` markup (icon + title + hint), with the server's own
 *  message as the hint and NO action button — the tab itself stays reachable, there's
 *  just nothing to browse. (CenteredState isn't exported from states.tsx, and that
 *  file is out of scope here, so the block is inlined — the same way Prs.tsx inlines
 *  its own small presentational blocks.) */
function TrackerUnavailableState({ message }: { message?: string }) {
  return (
    <div
      className="flex flex-col items-center gap-3 px-8 py-16 text-center"
      role="status"
    >
      <InfoIcon size={32} className="text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">
        Issues aren't available for this repository
      </p>
      {message ? (
        <div className="max-w-xs text-sm text-muted-foreground">{message}</div>
      ) : null}
    </div>
  );
}

// A single GROWING query pages the list: "Load more" bumps `limit` (the server
// re-serves the whole prefix), mirroring HistoryBody. 30 to match the fetcher's
// default page size.
const PAGE = 30;

/** The issues list. `repoId` scopes the query; `active` gates polling. */
export function IssuesBody({
  repoId,
  active,
}: {
  repoId: string;
  active: boolean;
}) {
  const [limit, setLimit] = useState(PAGE);
  const { data, isError, error, refetch, isPlaceholderData } = useIssues(
    repoId,
    active,
    "open",
    limit,
  );
  const { register, onKeyDown } = useRovingList();

  // Definitive gone WINS over stale data: a `noSuchRepo` 404 kicks to the teaching
  // state even when a cached list is on hand (see isRepoGoneError). No segment then —
  // the repo is unshared, so there's nothing (issues OR discussions) to switch to.
  if (isRepoGoneError(error)) return <RepoGoneState />;

  // The Discussions segment is HOISTED above every other IssuesBody state so a repo
  // where issues are unavailable but Discussions are enabled (a GitHub fork with the
  // issue tracker off) still offers a path to Discussions — the issues content was the
  // only entry point before, leaving Discussions unreachable. The segment self-hides on
  // repos without Discussions, so every currently-pixel-identical case stays identical
  // (it renders null, zero extra layout). Never on the issue DETAIL view.
  const segment = <IssuesDiscussionsSegment repoId={repoId} current="issues" />;

  // Prefer stale data: keep the last-known list on screen even on error, with a
  // StaleBanner above it. Full-screen states only when there's nothing to show;
  // skeleton only while the first fetch is pending.
  if (!data) {
    // A repo with no usable issue tracker (Bitbucket / fork-with-issues-off) gets a
    // calm teaching state carrying the server's message — never the generic error,
    // and no retry (retrying can't turn the tracker on).
    if (isTrackerUnavailable(error)) {
      return (
        <div className="flex flex-col">
          {segment}
          <TrackerUnavailableState message={asApiError(error)?.message} />
        </div>
      );
    }
    if (isError)
      return (
        <div className="flex flex-col">
          {segment}
          <ErrorState error={error} onRetry={() => refetch()} />
        </div>
      );
    return (
      <div className="flex flex-col">
        {segment}
        <SkeletonRows />
      </div>
    );
  }

  // The last page came back short (fewer issues than we asked for) → there's nothing
  // more to load. Hide the button then. While the grown page loads, `data` is the
  // PRIOR page held as placeholder — short-looking against the new limit, so keep
  // the button visible (loading-labeled) instead of flickering it off. Mirrors
  // HistoryBody.
  const hasMore = data.length >= limit || isPlaceholderData;

  return (
    <div className="flex flex-col">
      {segment}
      {isError ? <StaleBanner error={error} onRetry={() => refetch()} /> : null}
      {data.length === 0 ? (
        <EmptyState
          title="No open issues."
          hint="Open issues on this repository will show up here."
        />
      ) : (
        <>
          <ul className="flex flex-col divide-y divide-border">
            {data.map((issue, i) => (
              <li key={issue.number}>
                <button
                  type="button"
                  ref={register(i)}
                  onKeyDown={onKeyDown}
                  onClick={() =>
                    navigate(repoHash(repoId, `issues/${issue.number}`))
                  }
                  className="flex w-full min-h-14 items-center gap-3 px-4 py-3 text-left"
                >
                  <IssueRow issue={issue} />
                  <CaretRightIcon
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                </button>
              </li>
            ))}
          </ul>
          {hasMore ? (
            <button
              type="button"
              onClick={() => setLimit((n) => n + PAGE)}
              disabled={isPlaceholderData}
              className="min-h-11 border-t border-border px-4 py-3 text-sm font-medium text-primary disabled:text-muted-foreground"
            >
              {isPlaceholderData ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function IssueRow({ issue }: { issue: IssueInfo }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <IssueStateChip state={issue.state} />
        <span className="text-xs text-muted-foreground">#{issue.number}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-sm font-medium text-foreground">
        {issue.title}
      </p>
      <p className="truncate text-xs text-muted-foreground">
        {issue.author?.login ? `${issue.author.login} · ` : ""}
        {timeAgo(issue.updatedAt)}
      </p>
      <LabelChips names={issue.labels.map((l) => l.name)} />
    </div>
  );
}

/** An issue's label names as neutral muted chips (max 2, then a "+n" overflow chip).
 *  Labels carry NO color on the phone — contrast-correcting arbitrary label colors is
 *  out of scope, so the chips are always neutral. Renders nothing when there are no
 *  labels. */
function LabelChips({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  const shown = names.slice(0, 2);
  const overflow = names.length - shown.length;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      {shown.map((name) => (
        <span
          key={name}
          className="max-w-[10rem] truncate rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
        >
          {name}
        </span>
      ))}
      {overflow > 0 ? (
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          +{overflow}
        </span>
      ) : null}
    </div>
  );
}

/** A read-only issue detail. */
export function IssueDetailBody({
  repoId,
  number,
}: {
  repoId: string;
  number: number;
}) {
  const { data, isPending, isError, error, refetch } = useIssue(repoId, number);

  // Definitive gone WINS: the whole detail (back-bar included) is replaced by the
  // teaching state — "Choose repository" is the only sensible action once the repo
  // is unshared. (ErrorState also routes noSuchRepo here, but making it explicit
  // keeps it robust if the error handling below is ever reordered.)
  if (isRepoGoneError(error)) return <RepoGoneState />;

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-2 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => navigate(repoHash(repoId, "issues"))}
          className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm font-medium text-primary"
        >
          <ArrowLeftIcon size={16} />
          Issues
        </button>
      </div>

      {isTrackerUnavailable(error) ? (
        <TrackerUnavailableState message={asApiError(error)?.message} />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isPending || !data ? (
        <SkeletonRows count={3} />
      ) : (
        <article className="flex flex-col gap-4 px-4 py-5">
          <header className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <IssueStateChip state={data.state} />
              <span className="text-xs text-muted-foreground">
                #{data.number}
              </span>
            </div>
            <h1 className="text-base font-semibold text-foreground">
              {data.title}
            </h1>
            <p className="text-xs text-muted-foreground">
              {data.author ? `${data.author} · ` : ""}
              {timeAgo(data.createdAt)}
            </p>
            <IssueMeta detail={data} />
            {data.locked ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <LockIcon size={14} className="shrink-0" />
                This issue is locked
                {data.activeLockReason ? ` (${data.activeLockReason})` : ""}.
              </p>
            ) : null}
          </header>

          {data.body ? (
            <Markdown className="text-foreground/90">{data.body}</Markdown>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              No description.
            </p>
          )}

          <CommentsSection detail={data} />
        </article>
      )}
    </div>
  );
}

/** The header's secondary metadata: label chips, assignees, and the milestone —
 *  each rendered only when present. Assignees show by their neutral `label` text. */
function IssueMeta({ detail }: { detail: IssueDetails }) {
  const hasLabels = detail.labels.length > 0;
  const hasAssignees = detail.assignees.length > 0;
  const hasMilestone = detail.milestone !== null;
  if (!hasLabels && !hasAssignees && !hasMilestone) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {hasLabels ? (
        <LabelChips names={detail.labels.map((l) => l.name)} />
      ) : null}
      {hasAssignees ? (
        <p className="text-xs text-muted-foreground">
          Assigned to {detail.assignees.map((a) => a.label).join(", ")}
        </p>
      ) : null}
      {detail.milestone ? (
        <p className="text-xs text-muted-foreground">
          Milestone: {detail.milestone.title}
        </p>
      ) : null}
    </div>
  );
}

/** The issue's conversation: a flat list of comments, oldest-first as served. Reads
 *  the EXISTING `useIssue` detail (no new query), so there's no separate
 *  loading/error state — the surrounding detail already owns those. There is no
 *  activity/timeline over LAN, so this is the only conversation section. */
function CommentsSection({ detail }: { detail: IssueDetails }) {
  const comments = detail.comments;
  return (
    <section className="flex flex-col gap-2">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">
        Comments ({comments.length})
      </p>
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {comments.map((c) => (
            <CommentCard key={c.id} comment={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One comment row — author + relative time + Markdown body. A minimized comment
 *  collapses to a one-line muted "Hidden comment (reason)" row instead of its body
 *  (no expand in v1). Body renders as GitHub-flavored Markdown (same as the issue
 *  body). */
function CommentCard({ comment }: { comment: IssueComment }) {
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground/80">
          {comment.author || "unknown"}
        </span>
        {comment.date ? (
          <span className="text-xs text-muted-foreground">
            {timeAgo(comment.date)}
          </span>
        ) : null}
      </div>
      {comment.isMinimized ? (
        <p className="flex items-center gap-1.5 text-xs italic text-muted-foreground">
          <EyeSlashIcon size={14} className="shrink-0" />
          Hidden comment
          {comment.minimizedReason ? ` (${comment.minimizedReason})` : ""}
        </p>
      ) : comment.body ? (
        <Markdown className="text-foreground/90">{comment.body}</Markdown>
      ) : null}
    </li>
  );
}
