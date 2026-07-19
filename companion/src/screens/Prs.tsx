import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  CaretRightIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  EyeSlashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import type {
  PrDetails,
  PrInfo,
  PrThreadOut,
  PrTimelineEvent,
  ReviewThreadOut,
} from "@/lib/git/types";
import { PrStateChip } from "../components/chips";
import { Markdown } from "../components/markdown";
import {
  EmptyState,
  ErrorState,
  isRepoGoneError,
  RepoGoneState,
  SkeletonRows,
  StaleBanner,
} from "../components/states";
import { timeAgo } from "../lib/format";
import { usePr, usePrs, usePrThreads, usePrTimeline } from "../lib/queries";
import { navigate, repoHash } from "../lib/router";
import { useRovingList } from "../lib/use-roving-list";

/** The PR list. `repoId` scopes the query; `active` gates polling. */
export function PrsBody({
  repoId,
  active,
}: {
  repoId: string;
  active: boolean;
}) {
  const { data, isError, error, refetch } = usePrs(repoId, active);
  const { register, onKeyDown } = useRovingList();

  // Definitive gone WINS over stale data: a `noSuchRepo` 404 kicks to the teaching
  // state even when a cached list is on hand (see isRepoGoneError).
  if (isRepoGoneError(error)) return <RepoGoneState />;

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
                onClick={() => navigate(repoHash(repoId, `prs/${pr.number}`))}
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
export function PrDetail({
  repoId,
  number,
}: {
  repoId: string;
  number: number;
}) {
  const { data, isPending, isError, error, refetch } = usePr(repoId, number);

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
          onClick={() => navigate(repoHash(repoId, "prs"))}
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
            <Markdown className="text-foreground/90">{data.body}</Markdown>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              No description.
            </p>
          )}

          <ConversationSection detail={data} />
          <ActivitySection repoId={repoId} number={number} />
          <ThreadsSection repoId={repoId} number={number} />
        </article>
      )}
    </div>
  );
}

/** A section heading, matching the PrDetail overview typography. */
function SectionHeading({ children }: { children: string }) {
  return (
    <p className="text-xs uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

/** A compact inline error with retry, scoped to ONE conversation section — a
 *  failure here must never blank the whole PrDetail (the overview stays up). */
function SectionError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
      <span className="flex items-center gap-2 text-muted-foreground">
        <WarningCircleIcon size={16} className="shrink-0 text-destructive" />
        Couldn't load this section.
      </span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded px-2 py-1 font-medium text-primary"
      >
        <ArrowClockwiseIcon size={14} weight="bold" />
        Retry
      </button>
    </div>
  );
}

// One conversation entry — a plain comment or a review verdict — merged into a
// single chronological stream. `state` is empty for comments and a review verdict
// (APPROVED / CHANGES_REQUESTED / COMMENTED / …) for reviews.
type ConversationEntry = { comment: PrThreadOut; isReview: boolean };

/** The PR's conversation: plain comments and review verdicts, in date order. Reads
 *  the EXISTING `usePr` detail (no new query), so there's no separate loading/error
 *  state — the surrounding PrDetail already owns those. */
function ConversationSection({ detail }: { detail: PrDetails }) {
  // Drop GitHub's thread-reply wrapper reviews: replying to a review thread outside
  // a batched review makes GitHub auto-wrap the reply in a new empty-body COMMENTED
  // review (state delivered uppercase verbatim). Rendered here it's a contentless
  // "Reviewed · No comment" card duplicating the reply already shown under Review
  // threads. Matches the desktop's filter (RemotePrView.tsx) at its "body blank AND
  // COMMENTED" core; the accepted tradeoff is that a genuinely empty COMMENTED review
  // is also hidden (GitHub's reply-wrapping is by far the dominant producer). A
  // bodyless APPROVED / CHANGES_REQUESTED still renders — its verdict carries meaning.
  const visibleReviews = detail.reviews.filter(
    (r) => r.body.trim().length > 0 || r.state.toUpperCase() !== "COMMENTED",
  );
  const entries: ConversationEntry[] = [
    ...detail.comments.map((c) => ({ comment: c, isReview: false })),
    ...visibleReviews.map((c) => ({ comment: c, isReview: true })),
  ].sort((a, b) => dateOrder(a.comment.date) - dateOrder(b.comment.date));

  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Conversation</SectionHeading>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((e) => (
            <CommentCard
              key={`${e.isReview ? "r" : "c"}:${e.comment.id}`}
              comment={e.comment}
              isReview={e.isReview}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Sort key for a conversation entry — parsed epoch ms, or 0 for an empty/invalid
 *  date (keeps such rows first without reordering each other, Array.sort here is
 *  stable). */
function dateOrder(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** One conversation row. A review verdict leads with its state chip; a plain
 *  comment is just author + time + body. A minimized comment collapses to a hidden
 *  line instead of its body. Body renders as GitHub-flavored Markdown (same as the
 *  PR body). */
function CommentCard({
  comment,
  isReview,
}: {
  comment: PrThreadOut;
  isReview: boolean;
}) {
  return (
    <li className="flex flex-col gap-1 rounded-md border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground/80">
          {comment.author || "unknown"}
        </span>
        {isReview && comment.state ? (
          <ReviewStateBadge state={comment.state} />
        ) : null}
        {comment.date ? (
          <span className="text-xs text-muted-foreground">
            {timeAgo(comment.date)}
          </span>
        ) : null}
      </div>
      {comment.isMinimized ? (
        <p className="flex items-center gap-1.5 text-xs italic text-muted-foreground">
          <EyeSlashIcon size={14} className="shrink-0" />
          Comment hidden
          {comment.minimizedReason ? ` (${comment.minimizedReason})` : ""}
        </p>
      ) : comment.body ? (
        <Markdown className="text-foreground/90">{comment.body}</Markdown>
      ) : isReview ? (
        // A bodyless review (e.g. a bare approval) — the verdict chip above says it all.
        <p className="text-sm italic text-muted-foreground">No comment.</p>
      ) : null}
    </li>
  );
}

/** A review verdict badge — icon + text so the verdict never rests on color alone
 *  (WCAG 1.4.1). Recognizes the GitHub-convention states; any other string renders
 *  verbatim with a neutral look. */
function ReviewStateBadge({ state }: { state: string }) {
  const s = state.toLowerCase();
  if (s === "approved") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
        <CheckCircleIcon size={12} weight="fill" />
        Approved
      </span>
    );
  }
  if (s === "changes_requested") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
        <WarningCircleIcon size={12} weight="fill" />
        Changes requested
      </span>
    );
  }
  if (s === "commented") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
        <ChatCircleIcon size={12} />
        Reviewed
      </span>
    );
  }
  // Dismissed, pending, or any other provider string — show it verbatim, neutral.
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      <ChatCircleIcon size={12} />
      {state}
    </span>
  );
}

/** The PR's activity timeline (force-pushes, labels, review requests, state
 *  changes). Polls while the detail is open; a failure shows an inline retry. */
function ActivitySection({
  repoId,
  number,
}: {
  repoId: string;
  number: number;
}) {
  const { data, isPending, isError, error, refetch } = usePrTimeline(
    repoId,
    number,
  );

  // Definitive gone WINS: if this sub-section's poll is the first to see the 404
  // (before the parent detail's own poll), take over the whole screen with the
  // teaching state rather than showing a small inline section error.
  if (isRepoGoneError(error)) return <RepoGoneState />;

  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Activity</SectionHeading>
      {isError && !data ? (
        <SectionError onRetry={() => refetch()} />
      ) : isPending || !data ? (
        <SkeletonRows count={2} />
      ) : data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No activity yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {data.map((ev, i) => {
            const row = timelineRow(ev);
            if (!row) return null; // unknown kind → skip silently (forward-compat)
            return (
              <li
                key={i}
                className="flex items-baseline justify-between gap-2 text-xs"
              >
                <span className="min-w-0 text-foreground/90">{row}</span>
                <span className="shrink-0 text-muted-foreground">
                  {timeAgo(ev.date)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Render one timeline event as a compact verb + actor phrase. Returns null for an
 *  unknown kind so the caller can skip it (forward-compatible with new events). */
function timelineRow(ev: PrTimelineEvent): string | null {
  const by = (actor: string) => (actor ? ` by ${actor}` : "");
  switch (ev.kind) {
    case "forcePushed":
      return `Force-pushed ${short(ev.before)} → ${short(ev.after)}${by(ev.actor)}`;
    case "labeled":
      return `${ev.added ? "Added" : "Removed"} label “${ev.label}”${by(ev.actor)}`;
    case "reviewRequested":
      return `Requested review from ${ev.reviewer || "someone"}${by(ev.actor)}`;
    case "readyForReview":
      return `Marked ready for review${by(ev.actor)}`;
    case "convertToDraft":
      return `Converted to draft${by(ev.actor)}`;
    case "approved":
      return `Approved${by(ev.actor)}`;
    case "changesRequested":
      return `Requested changes${by(ev.actor)}`;
    case "unapproved":
      return `Dismissed approval${by(ev.actor)}`;
    case "closed":
      return `Closed${by(ev.actor)}`;
    case "reopened":
      return `Reopened${by(ev.actor)}`;
    case "merged":
      return `Merged${by(ev.actor)}`;
    case "renamed":
      return `Renamed “${ev.previous}” → “${ev.current}”${by(ev.actor)}`;
    default:
      return null;
  }
}

/** Shorten a commit oid to its short form; "" stays "". */
function short(oid: string): string {
  return oid ? oid.slice(0, 7) : "";
}

/** The PR's file:line-anchored review threads with their comments. Polls while the
 *  detail is open; a failure shows an inline retry. The diff hunk is deliberately
 *  omitted (too wide for the phone). */
function ThreadsSection({
  repoId,
  number,
}: {
  repoId: string;
  number: number;
}) {
  const { data, isPending, isError, error, refetch } = usePrThreads(
    repoId,
    number,
  );

  // Definitive gone WINS (see ActivitySection): a first-seen 404 here takes over
  // the whole screen with the teaching state.
  if (isRepoGoneError(error)) return <RepoGoneState />;

  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>Review threads</SectionHeading>
      {isError && !data ? (
        <SectionError onRetry={() => refetch()} />
      ) : isPending || !data ? (
        <SkeletonRows count={2} />
      ) : data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No review threads.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {data.map((thread) => (
            <ThreadCard key={thread.id} thread={thread} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ThreadCard({ thread }: { thread: ReviewThreadOut }) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-mono text-xs text-foreground/80">
          {thread.path}
          {thread.line > 0 ? `:${thread.line}` : ""}
        </span>
        {thread.isResolved ? (
          <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
            Resolved
          </span>
        ) : null}
        {thread.isOutdated ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
            Outdated
          </span>
        ) : null}
      </div>
      <ul className="flex flex-col gap-2">
        {thread.comments.map((c) => (
          <li key={c.id} className="flex flex-col gap-1">
            <p className="flex items-baseline gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">
                {c.author || "unknown"}
              </span>
              {c.date ? <span>{timeAgo(c.date)}</span> : null}
            </p>
            <Markdown className="text-foreground/90">{c.body}</Markdown>
          </li>
        ))}
      </ul>
    </li>
  );
}
