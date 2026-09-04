import { type ReactNode, useLayoutEffect, useMemo, useRef } from "react";
import { RelativeTime } from "@/components/relative-time";
import {
  AuthorAvatar,
  hasVisibleBody,
  Thread,
} from "@/features/conversations/Thread";
import type { MentionSource } from "@/features/conversations/useMentionCandidates";
import type { MinimizeReason } from "@/lib/git/api";
import { displayLogin } from "@/lib/git/bot-login";
import { useActiveForgeGhHost } from "@/lib/git/host";
import type {
  ForgeProvider,
  ForgeTimelineEvent,
  IssueReactions,
  PrDetails,
  PrThreadOut,
  ReviewThreadOut,
} from "@/lib/git/types";
import { dropDraftsByReviewIds } from "@/lib/pulls/pending-review-threads";
import { parseableDate } from "@/lib/time";
import {
  coalesceCommitRuns,
  PushedCommitsRow,
  StaleReviewMarker,
  sortTimeline,
  type TimelineEntry,
  TimelineEventRow,
} from "./PrTimeline";
import {
  lineLabel,
  ReviewThreadList,
  type SuggestionApply,
  threadToMarkdown,
} from "./ReviewThreads";

/** Which reviews render, and which line-comment threads each of them claims. */
export interface PrThreadClaims {
  /** Reviews worth a row: a visible body, or a state to report — never the viewer's
   *  own PENDING review, which the notice strip carries instead. */
  renderedReviews: PrThreadOut[];
  /** The viewer's own unfinished reviews, which the notice strip owns instead of the
   *  feed. GitHub returns a PENDING review only to its author and allows one at a
   *  time; the array shape keeps the derivation total. */
  pendingReviews: PrThreadOut[];
  /** Threads grouped by the review that owns them — one pass, reused for the
   *  claimed-id set and each review's inline slice. */
  threadsByReview: Map<string, ReviewThreadOut[]>;
  /** Reviews that are bare thread-reply wrappers (compact row, not a card). */
  wrapperReviewIds: Set<string>;
  /** The thread a wrapper review wraps, keyed by review id. Missing when the
   *  thread wasn't fetched (pagination edge) — the row renders without a locator. */
  wrappedThreadFor: Map<string, ReviewThreadOut>;
  /** Thread ids already rendered inline under a review. */
  claimedThreadIds: Set<string>;
  /** Threads no review claimed — the residual block under the feed. */
  residualThreads: ReviewThreadOut[];
  /** Every thread that survives the pending-draft filter — the ONE list both the
   *  Conversation feed and the Files pane's line anchors read, so the viewer's
   *  unsubmitted drafts can't be hidden on one tab and posted-looking on the other.
   *  `undefined` (not `[]`) while the read hasn't landed, so a consumer can still
   *  tell loading from empty. */
  visibleThreads: ReviewThreadOut[] | undefined;
  /** {@link visibleThreads}' length, 0 while it's still loading — what the feed can
   *  actually render, claimed and residual together. The empty state reads this
   *  rather than the raw query length, which still counts drafts nothing renders. */
  visibleThreadCount: number;
}

/**
 * Derive the review⇄thread claims once per PR payload. The feed and the residual
 * thread block below it BOTH read this: two independent derivations could
 * disagree, leaving the residual heading claiming threads that never rendered.
 */
export function usePrThreadClaims(
  pr: PrDetails | undefined,
  reviewThreads: ReviewThreadOut[] | undefined,
): PrThreadClaims {
  const reviews = pr?.reviews;
  return useMemo(() => {
    // Each rendered review "claims" the line-comment threads it owns (GitHub
    // `reviewId`; always "" on GitLab/Bitbucket, which don't model reviews).
    // Claimed threads render inline under their review; the rest fall to the
    // residual block.
    const all = reviews ?? [];
    // A PENDING review is the viewer's own unsubmitted draft — dateless, so a feed row
    // would sort ahead of everything. Excluded on STATE, not on body: a started review
    // can already carry a draft summary. The notice strip names the review instead,
    // and `dropDraftsByReviewIds` takes its line comments out of the threads read.
    const pendingReviews = all.filter((r) => r.state === "PENDING");
    const renderedReviews = all.filter(
      (r) => r.state !== "PENDING" && (hasVisibleBody(r.body) || r.state),
    );
    // Non-empty ids only — see `dropDraftsByReviewIds` on why an "" member is unsafe.
    const pendingIds = new Set(
      pendingReviews.map((r) => r.id).filter((id) => id !== ""),
    );
    const threads = dropDraftsByReviewIds(reviewThreads ?? [], pendingIds);
    const threadsByReview = new Map<string, ReviewThreadOut[]>();
    // The thread a wrapper review wraps: the FIRST thread holding a comment whose
    // `reviewId` is that review's — a map rather than a per-row scan over every
    // thread's comments.
    const wrappedThreadFor = new Map<string, ReviewThreadOut>();
    for (const t of threads) {
      if (t.reviewId) {
        const bucket = threadsByReview.get(t.reviewId);
        if (bucket) bucket.push(t);
        else threadsByReview.set(t.reviewId, [t]);
      }
      for (const c of t.comments) {
        // Falsy reviewIds never claim: GitLab/Bitbucket reviews can carry an
        // empty id (the key fallbacks exist for that), and an ""-keyed entry
        // would hand every empty-id wrapper review the same arbitrary thread.
        if (c.reviewId && !wrappedThreadFor.has(c.reviewId))
          wrappedThreadFor.set(c.reviewId, t);
      }
    }
    const claimedThreadIds = new Set(
      renderedReviews.flatMap((r) =>
        (threadsByReview.get(r.id) ?? []).map((t) => t.id),
      ),
    );
    // Thread-reply wrapper reviews: replying to a review thread outside a batched
    // review makes GitHub auto-wrap the reply in a new empty-body `COMMENTED`
    // review. It's a wrapper iff it has no visible body, is `COMMENTED` (the
    // backend delivers GitHub's uppercase state verbatim), AND claims no threads.
    // Accepted tradeoff: a genuinely empty COMMENTED review with no fetched
    // threads also renders as the compact row. GitLab/Bitbucket emit no review rows.
    const wrapperReviewIds = new Set(
      renderedReviews
        .filter(
          (r) =>
            !hasVisibleBody(r.body) &&
            r.state === "COMMENTED" &&
            (threadsByReview.get(r.id)?.length ?? 0) === 0,
        )
        .map((r) => r.id),
    );
    const residualThreads = threads.filter((t) => !claimedThreadIds.has(t.id));
    return {
      renderedReviews,
      pendingReviews,
      threadsByReview,
      wrapperReviewIds,
      wrappedThreadFor,
      claimedThreadIds,
      residualThreads,
      // The `?? []` above is an internal convenience; the loading arm is preserved
      // here rather than reported as an empty result.
      visibleThreads: reviewThreads === undefined ? undefined : threads,
      visibleThreadCount: threads.length,
    };
  }, [reviews, reviewThreads]);
}

/**
 * A review row that scrolls ITSELF into view when it's the target of a pending
 * reveal, via a layout effect on its own ref — so a row that only just mounted
 * still lands, with no frame racing — and then clears the request through
 * `onRevealed`. The caller decides which row is the target; nothing queries the
 * DOM for it.
 */
function ReviewAnchor({
  revealTarget,
  onRevealed,
  className,
  children,
}: {
  revealTarget: boolean;
  onRevealed?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!revealTarget) return;
    const node = rootRef.current;
    if (!node) return;
    node.scrollIntoView({ block: "nearest", behavior: "auto" });
    onRevealed?.();
  }, [revealTarget, onRevealed]);
  return (
    <div ref={rootRef} className={className}>
      {children}
    </div>
  );
}

/**
 * The remote PR's merged activity feed: reviews + comments + commits + timeline
 * events, date-sorted oldest→newest. Each source maps to a {date, sortKey, node}
 * entry so the sort is provider-neutral; adjacent commit entries coalesce into
 * one "pushed N commits" row.
 *
 * Extraction's realized win is `usePrThreadClaims`' memoized derivations —
 * review⇄thread grouping no longer recomputes on composer keystrokes (the JSX
 * itself still re-renders while RemotePrView bails out of the React Compiler).
 * Every capability flag arrives separately — the `canX ? handler : undefined`
 * pairs ARE the disabled-control convention and must not collapse to one write
 * flag.
 */
export function PrActivityFeed({
  pr,
  timeline,
  reactions,
  claims,
  providerKey,
  suggestionApply,
  fileDiffLookup,
  disabledReason,
  revealThreadId,
  setRevealThreadId,
  revealReviewId,
  onReviewRevealed,
  setSection,
  onSelectCommit,
  canWrite,
  canThreadReply,
  canThreadResolve,
  canEditOwnThreadComments,
  canEditOwnComments,
  canReact,
  onQuote,
  onThreadReply,
  onThreadResolve,
  onEditThreadComment,
  onDeleteThreadComment,
  onEditComment,
  onDeleteComment,
  editHeld,
  onHideComment,
  onUnhideComment,
  onToggleReaction,
  reactionsHeld = false,
  reactionsReason,
  mentions,
}: {
  pr: PrDetails;
  timeline: ForgeTimelineEvent[] | undefined;
  reactions: IssueReactions | undefined;
  claims: PrThreadClaims;
  providerKey: ForgeProvider;
  suggestionApply: SuggestionApply;
  fileDiffLookup: (path: string) => string | undefined;
  /** Why the triage-tier comment actions are unavailable, when they are. */
  disabledReason: string | undefined;
  revealThreadId: string | null;
  setRevealThreadId: (threadId: string | null) => void;
  /** The review a notification's click-through asked to land on; that row scrolls
   *  itself. Null (and always so off GitHub, which mints no review ids). */
  revealReviewId?: string | null;
  /** Cleared by the row once it has scrolled itself into view for a reveal. */
  onReviewRevealed?: () => void;
  /** Bring the Conversation tab forward — see the "View thread" handler. */
  setSection: (section: "conversation") => void;
  /** Drill into a commit from a grouped push row. */
  onSelectCommit: (oid: string) => void;
  canWrite: boolean;
  canThreadReply: boolean;
  canThreadResolve: boolean;
  canEditOwnThreadComments: boolean;
  canEditOwnComments: boolean;
  canReact: boolean;
  /** Absent hides the Quote affordance wherever this feed offers it — the caller
   *  withholds it while the PR on screen isn't the one a quote would land on. */
  onQuote?: (body: string) => void;
  onThreadReply: (threadId: string, body: string) => Promise<void>;
  onThreadResolve: (threadId: string, resolved: boolean) => Promise<void>;
  /** Absent hides the thread-comment edit affordance — the caller withholds it
   *  while the PR on screen isn't the one the write would address. */
  onEditThreadComment?: (commentId: string, body: string) => void;
  /** Absent hides the thread-comment delete affordance (same reason). */
  onDeleteThreadComment?: (commentId: string) => void;
  /** Absent hides the conversation-comment edit affordance (same reason). */
  onEditComment?: (commentId: string, body: string) => void;
  /** Absent hides the conversation-comment delete affordance (same reason). */
  onDeleteComment?: (commentId: string) => void;
  /** Holds an ALREADY-OPEN comment editor's Save: withholding the callbacks only
   *  drops the menu entries, so a stale caller sets this too. */
  editHeld?: boolean;
  onHideComment: (commentId: string, classifier: MinimizeReason) => void;
  onUnhideComment: (commentId: string) => void;
  onToggleReaction: (
    subjectId: string,
    content: string,
    active: boolean,
  ) => void;
  /** Holds the comment reaction toggles: their subject ids come from the rendered
   *  PR, while the write addresses the selected one. The counts stay visible. */
  reactionsHeld?: boolean;
  /** Why `reactionsHeld` holds — shown and announced on every control it
   *  disables. Absent leaves a plain disable no viewer can interrogate. */
  reactionsReason?: string | null;
  /** Opt in to `@`/`#`/`!` autocomplete in every editor this feed opens (comment
   *  edits, review-thread replies) — only surfaces whose forge autolinks the
   *  completed reference pass one. */
  mentions?: MentionSource;
}) {
  const {
    renderedReviews,
    threadsByReview,
    wrapperReviewIds,
    wrappedThreadFor,
  } = claims;
  // Feed-constant, so it's read once here rather than per event row.
  const ghHost = useActiveForgeGhHost();
  // Newest commit date drives approval staleness. gh returns
  // oldest-first, but be defensive: max over all commit dates.
  const newestCommitMs = pr.commits.reduce((max, c) => {
    const t = new Date(c.date).getTime();
    return Number.isNaN(t) ? max : Math.max(max, t);
  }, 0);
  const commitsSince = (isoDate: string) => {
    const t = new Date(isoDate).getTime();
    if (Number.isNaN(t)) return 0;
    return pr.commits.filter((c) => {
      const ct = new Date(c.date).getTime();
      return !Number.isNaN(ct) && ct > t;
    }).length;
  };

  const entries: TimelineEntry[] = [];

  // A stale APPROVED/CHANGES_REQUESTED review (dated before the newest
  // commit) gets a warning marker after its card.
  for (const r of renderedReviews) {
    // GitLab/Bitbucket reviews carry an EMPTY id, so equality alone would let a
    // blank request claim every one of them at once; a reveal request is always
    // a real GitHub node id.
    const revealTarget = !!revealReviewId && revealReviewId === r.id;
    // A wrapper review renders as a compact row instead of an empty
    // "commented" card, with a jump link when its thread was fetched.
    if (wrapperReviewIds.has(r.id)) {
      const t = wrappedThreadFor.get(r.id);
      const locator = t
        ? [t.path, lineLabel(t.startLine, t.line)].filter(Boolean).join(" · ")
        : "";
      entries.push({
        date: r.date,
        sortKey: 1,
        node: (
          <ReviewAnchor
            key={`reply-wrap-${r.id || `${r.author}-${r.date}`}`}
            revealTarget={revealTarget}
            onRevealed={onReviewRevealed}
            className="flex items-start gap-2 text-xs"
          >
            <AuthorAvatar login={r.author} avatarUrl={r.authorAvatarUrl} />
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 py-1 text-muted-foreground">
              <span className="font-medium text-foreground">
                {displayLogin(r.author)}
              </span>
              <span>replied in a review thread</span>
              {locator && <span className="min-w-0 truncate">· {locator}</span>}
              {t && (
                <button
                  type="button"
                  className="shrink-0 text-primary underline-offset-2 hover:underline cursor-pointer"
                  onClick={() => {
                    // Route through the reveal seam, not a raw DOM
                    // scroll: the owning ReviewThreadList opens the
                    // resolved-group expander + expands the card
                    // before scrolling. Set the section first so the
                    // list is mounted when it reads the request.
                    setSection("conversation");
                    setRevealThreadId(t.id);
                  }}
                >
                  View thread
                </button>
              )}
              {parseableDate(r.date) && (
                <span className="shrink-0 text-muted-foreground/80">
                  · <RelativeTime date={r.date} />
                </span>
              )}
            </div>
          </ReviewAnchor>
        ),
      });
      continue;
    }
    const ownThreads = threadsByReview.get(r.id) ?? [];
    const copyMarkdown =
      ownThreads.length > 0
        ? [
            r.body.trim() ? r.body.trim() : null,
            ...ownThreads.map(threadToMarkdown),
          ]
            .filter(Boolean)
            .join("\n\n---\n\n")
        : undefined;
    const isVerdict = r.state === "APPROVED" || r.state === "CHANGES_REQUESTED";
    const reviewMs = new Date(r.date).getTime();
    const stale =
      isVerdict &&
      newestCommitMs > 0 &&
      !Number.isNaN(reviewMs) &&
      reviewMs < newestCommitMs;
    entries.push({
      date: r.date,
      sortKey: 1,
      node: (
        <ReviewAnchor
          key={`review-${r.id || `${r.author}-${r.date}`}`}
          revealTarget={revealTarget}
          onRevealed={onReviewRevealed}
        >
          <Thread
            thread={r}
            onQuote={
              onQuote && canWrite && hasVisibleBody(r.body)
                ? () => onQuote(r.body)
                : undefined
            }
            copyMarkdown={copyMarkdown}
            mentions={mentions}
          />
          {stale && <StaleReviewMarker commitsSince={commitsSince(r.date)} />}
          {ownThreads.length > 0 && (
            // The review's own line-comment threads, nested under it
            // (a 1px border-l rail). GitLab/Bitbucket never reach
            // here — their threads carry no reviewId, so nothing is
            // claimed.
            <div className="mt-2 border-l pl-3">
              <ReviewThreadList
                threads={ownThreads}
                onQuote={onQuote}
                onReply={canThreadReply ? onThreadReply : undefined}
                onResolve={canThreadResolve ? onThreadResolve : undefined}
                onEditComment={
                  canEditOwnThreadComments ? onEditThreadComment : undefined
                }
                onDeleteComment={
                  canEditOwnThreadComments ? onDeleteThreadComment : undefined
                }
                editHeld={editHeld}
                provider={providerKey}
                apply={suggestionApply}
                fileDiffLookup={fileDiffLookup}
                mentions={mentions}
                revealThreadId={revealThreadId}
                onRevealed={() => setRevealThreadId(null)}
              />
            </div>
          )}
        </ReviewAnchor>
      ),
    });
  }

  // Conversation comments.
  for (const c of pr.comments.filter((c) => hasVisibleBody(c.body))) {
    entries.push({
      date: c.date,
      sortKey: 2,
      node: (
        // `data-comment-id` is a cross-module DOM contract: PrTasksSection
        // scrolls to the comment a Bitbucket task hangs off by querying it.
        <div key={`comment-${c.id}`} data-comment-id={c.id}>
          <Thread
            thread={c}
            onQuote={onQuote && canWrite ? () => onQuote(c.body) : undefined}
            onSaveEdit={
              onEditComment && canEditOwnComments && c.viewerDidAuthor
                ? (body) => onEditComment(c.id, body)
                : undefined
            }
            editHeld={editHeld}
            onDelete={
              onDeleteComment && canEditOwnComments && c.viewerDidAuthor
                ? () => onDeleteComment(c.id)
                : undefined
            }
            onHide={
              canWrite && !c.isMinimized
                ? (classifier) => onHideComment(c.id, classifier)
                : undefined
            }
            onUnhide={
              canWrite && c.isMinimized
                ? () => onUnhideComment(c.id)
                : undefined
            }
            disabledReason={disabledReason}
            reactionsHeld={reactionsHeld}
            reactionsReason={reactionsReason}
            reactions={canReact ? reactions?.comments[c.id] : undefined}
            onToggleReaction={
              canReact
                ? (content, active) => onToggleReaction(c.id, content, active)
                : undefined
            }
            mentions={mentions}
          />
        </div>
      ),
    });
  }

  // Commits — carried as bare markers; adjacent runs coalesce into
  // a single "pushed N commits" row after sorting.
  for (const c of pr.commits) {
    entries.push({
      date: c.date,
      sortKey: 0,
      commit: {
        id: c.oid,
        subject: c.headline,
        shortSha: c.oid.slice(0, 7),
        author: c.author,
        date: c.date,
      },
    });
  }

  // Timeline events — provider-neutral (GitHub, GitLab, Bitbucket);
  // empty otherwise.
  for (const [i, ev] of (timeline ?? []).entries()) {
    entries.push({
      date: ev.date,
      sortKey: 3,
      node: <TimelineEventRow key={`event-${i}`} event={ev} ghHost={ghHost} />,
    });
  }

  const rendered = coalesceCommitRuns(
    sortTimeline(entries),
    (run, runStart) => (
      <PushedCommitsRow
        key={`push-${runStart}-${run[0].id}`}
        commits={run}
        onSelectCommit={onSelectCommit}
      />
    ),
  );

  if (rendered.length === 0) return null;
  return <div className="space-y-4">{rendered}</div>;
}
