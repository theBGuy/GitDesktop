// The Discussions tab — a segmented sibling UNDER the Issues tab (see
// components/tab-segment.tsx). Read-only GitHub Discussions on the phone: a list of
// discussions (category-filtered, growing) + a discussion detail with its comment
// threads. Mirrors the Issues screen anatomy (rows, growing list, teaching-state
// blocks, back bar, CommentCard) so the two screens read as one surface.
//
// Discussions are GitHub-only. On a GitLab/Bitbucket repo or a GitHub repo with the
// feature turned off, the LAN server mints `400 { kind: "discussionsUnavailable" }`
// (never a raw gh error), and the screen renders a calm teaching state — see the
// state ladder in DiscussionsBody.

import {
  ArrowLeftIcon,
  CaretRightIcon,
  CaretUpIcon,
  CheckCircleIcon,
  EyeSlashIcon,
  InfoIcon,
  LockIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
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
import type {
  DiscussionComment,
  DiscussionDetails,
  DiscussionInfo,
  DiscussionReply,
} from "../lib/api";
import { timeAgo } from "../lib/format";
import {
  asApiError,
  useDiscussion,
  useDiscussionMeta,
  useDiscussions,
} from "../lib/queries";
import { navigate, repoHash } from "../lib/router";
import { useRovingList } from "../lib/use-roving-list";

/** The calm teaching state for a repo that can't serve Discussions — a non-GitHub
 *  repo (`discussionsUnavailable`) or a GitHub repo with the feature disabled. Mirrors
 *  Issues' `TrackerUnavailableState` anatomy (states.tsx `CenteredState` markup: icon
 *  + title + optional hint) with NO action button — nothing to browse, and a retry
 *  can't turn Discussions on. Inlined per the same convention Issues/Prs use for their
 *  own small presentational blocks (CenteredState isn't exported). */
function DiscussionsUnavailableState({
  title,
  hint,
}: {
  title: string;
  hint?: string;
}) {
  return (
    <div
      className="flex flex-col items-center gap-3 px-8 py-16 text-center"
      role="status"
    >
      <InfoIcon size={32} className="text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint ? (
        <div className="max-w-xs text-sm text-muted-foreground">{hint}</div>
      ) : null}
    </div>
  );
}

// A single GROWING query pages the list: "Load more" bumps `limit` (the server
// re-serves the whole prefix), mirroring IssuesBody. 30 to match the fetcher's
// default page size.
const PAGE = 30;

/** The discussions list. `repoId` scopes the query; `active` gates polling. */
export function DiscussionsBody({
  repoId,
  active,
}: {
  repoId: string;
  active: boolean;
}) {
  const [limit, setLimit] = useState(PAGE);
  const [category, setCategory] = useState<string | null>(null);
  const meta = useDiscussionMeta(repoId);
  // The list query MUST NOT fire until meta confirms Discussions are enabled — the
  // `enabled` gate exists precisely to avoid a doomed GraphQL roundtrip on an
  // unavailable/disabled repo (only the cheap meta probe fires there). DATA-driven,
  // not `isSuccess`: react-query v5 retains the last good `data` while flipping status
  // to 'error' on a transient background-refetch failure — an `isSuccess` gate would
  // kill live list polling on a wifi blip. `data.hasDiscussionsEnabled === true` keeps
  // the list alive across a transient meta error (its own stale-prefer ladder handles
  // the rest).
  const metaOk = meta.data?.hasDiscussionsEnabled === true;
  const list = useDiscussions(repoId, active, category, limit, metaOk);
  const { register, onKeyDown } = useRovingList();

  // Definitive gone WINS over everything else — either query can carry it.
  if (isRepoGoneError(meta.error || list.error)) return <RepoGoneState />;

  // ── Meta-gated states (before the list can meaningfully render) ──
  // `discussionsUnavailable` is DEFINITIVE (a non-GitHub repo, or an older desktop):
  // the calm teaching state wins even over stale cached data, no retry (a retry can't
  // turn the feature on). Checked against `meta.error` regardless of whether `data` is
  // still held — same definitive-wins precedence RepoGone uses above.
  if (asApiError(meta.error)?.isDiscussionsUnavailable) {
    return (
      <DiscussionsUnavailableState
        title="Discussions aren't available for this repository"
        hint={asApiError(meta.error)?.message}
      />
    );
  }
  // No loaded meta yet: a genuine first-load error full-screens (retry refetches meta);
  // otherwise it's still loading → skeleton. Once `data` is held, a TRANSIENT meta
  // error is ignored here (data-driven) so a wifi blip never full-screens over a good
  // cached list — the list keeps rendering below.
  if (!meta.data) {
    if (meta.isError)
      return <ErrorState error={meta.error} onRetry={() => meta.refetch()} />;
    return <SkeletonRows />;
  }
  // Meta loaded but the feature is turned off for this GitHub repo. No retry — a retry
  // can't enable it.
  if (!meta.data.hasDiscussionsEnabled) {
    return (
      <DiscussionsUnavailableState title="Discussions aren't enabled for this repository." />
    );
  }

  // ── List states (meta is confirmed available) ──
  // Prefer stale data: keep the last-known list on screen even on error, with a
  // StaleBanner above it. Full-screen states only when there's nothing to show;
  // skeleton only while the first fetch is pending.
  const data = list.data;
  if (!data) {
    if (list.isError)
      return <ErrorState error={list.error} onRetry={() => list.refetch()} />;
    return <SkeletonRows />;
  }

  // The last page came back short → nothing more to load; hide the button. While a
  // grown page loads, `data` is the PRIOR page held as placeholder — short against
  // the new limit — so keep the button visible (loading-labeled). Mirrors IssuesBody.
  const hasMore = data.length >= limit || list.isPlaceholderData;
  const categories = meta.data.categories;
  const noneAtAll = data.length === 0 && category === null;

  return (
    <div className="flex flex-col">
      <IssuesDiscussionsSegment repoId={repoId} current="discussions" />
      {categories.length > 0 ? (
        <CategoryChips
          categories={categories}
          selected={category}
          onSelect={(id) => {
            setCategory(id);
            setLimit(PAGE); // a category switch resets to the first page
          }}
        />
      ) : null}
      {list.isError ? (
        <StaleBanner error={list.error} onRetry={() => list.refetch()} />
      ) : null}
      {data.length === 0 ? (
        noneAtAll ? (
          <EmptyState
            title="No discussions yet."
            hint="Discussions on this repository will show up here."
          />
        ) : (
          <EmptyState
            title="No discussions in this category."
            hint="Try “All” to see every discussion."
          />
        )
      ) : (
        <>
          {/* While a category switch (or a grown page) loads, keepPreviousData holds
              the OLD category's rows — dim + aria-busy them so the stale content reads
              as refreshing, not final (mirrors the Todos screen). Load-more stays
              outside the dim so its "Loading…" label reads at full contrast. */}
          <ul
            aria-busy={list.isPlaceholderData}
            className={`flex flex-col divide-y divide-border ${
              list.isPlaceholderData ? "opacity-60" : ""
            }`}
          >
            {data.map((d, i) => (
              <li key={d.number}>
                <button
                  type="button"
                  ref={register(i)}
                  onKeyDown={onKeyDown}
                  onClick={() =>
                    navigate(repoHash(repoId, `discussions/${d.number}`))
                  }
                  className="flex w-full min-h-14 items-center gap-3 px-4 py-3 text-left"
                >
                  <DiscussionRow discussion={d} />
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
              disabled={list.isPlaceholderData}
              className="min-h-11 border-t border-border px-4 py-3 text-sm font-medium text-primary disabled:text-muted-foreground"
            >
              {list.isPlaceholderData ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

/** The category filter — a horizontally scrollable row of chips ("All" + each
 *  category). The selected chip carries `aria-pressed` AND `font-medium` on the accent
 *  fill, so selection never rests on color alone (WCAG 1.4.1). `null` = All.
 *
 *  Keyboard nav (repo rule — every new selectable list gets arrow keys in the same
 *  change): ArrowLeft/ArrowRight move focus between chips, Home/End jump to the ends.
 *  Roving tabindex — exactly ONE chip is in the tab order (the selected one, falling
 *  back to "All"), so Tab reaches the group once and arrows navigate within it.
 *  Arrows move FOCUS only; selection stays a deliberate Enter/Space/tap (the
 *  toggle-group convention). Adapted from the BottomNav roving pattern in Chrome.tsx. */
function CategoryChips({
  categories,
  selected,
  onSelect,
}: {
  categories: { id: string; name: string; emoji: string }[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  // The chip index space is [All, ...categories]. The tab-stop index is the selected
  // chip, or "All" (index 0) when nothing/an unknown id is selected.
  const count = categories.length + 1;
  const selectedIndex =
    selected === null
      ? 0
      : Math.max(
          0,
          categories.findIndex((c) => c.id === selected) + 1, // -1 + 1 = 0 → All
        );

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight":
        next = Math.min(index + 1, count - 1);
        break;
      case "ArrowLeft":
        next = Math.max(index - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    // Focus follows the arrow selection (canonical roving behavior); selection itself
    // stays on Enter/Space via the button semantics.
    const chips = e.currentTarget.parentElement?.children;
    (chips?.[next] as HTMLElement | undefined)?.focus();
  }

  return (
    <div
      className="flex gap-1.5 overflow-x-auto border-b border-border px-4 py-2"
      role="group"
      aria-label="Filter by category"
    >
      <CategoryChip
        label="All"
        pressed={selected === null}
        tabStop={selectedIndex === 0}
        onClick={() => onSelect(null)}
        onKeyDown={(e) => onKeyDown(e, 0)}
      />
      {categories.map((c, i) => (
        <CategoryChip
          key={c.id}
          label={`${c.emoji} ${c.name}`}
          pressed={selected === c.id}
          tabStop={selectedIndex === i + 1}
          onClick={() => onSelect(c.id)}
          onKeyDown={(e) => onKeyDown(e, i + 1)}
        />
      ))}
    </div>
  );
}

function CategoryChip({
  label,
  pressed,
  tabStop,
  onClick,
  onKeyDown,
}: {
  label: string;
  pressed: boolean;
  tabStop: boolean;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      tabIndex={tabStop ? 0 : -1}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={`inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full px-3 py-1.5 text-xs ${
        pressed
          ? "bg-primary font-medium text-primary-foreground"
          : "bg-muted font-normal text-muted-foreground"
      }`}
    >
      {label}
    </button>
  );
}

function DiscussionRow({ discussion }: { discussion: DiscussionInfo }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-start gap-2">
        <span className="shrink-0 text-sm" aria-hidden>
          {discussion.categoryEmoji}
        </span>
        <p className="line-clamp-2 flex-1 text-sm font-medium text-foreground">
          {discussion.title}
        </p>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {discussion.isAnswered ? <NeutralChip>Answered</NeutralChip> : null}
        {discussion.closed ? <NeutralChip>Closed</NeutralChip> : null}
      </div>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        #{discussion.number} · {discussion.author || "unknown"} ·{" "}
        {discussion.categoryName}
      </p>
      <p className="flex items-center gap-2 text-xs text-muted-foreground tabular-nums">
        <span>
          {discussion.commentCount}{" "}
          {discussion.commentCount === 1 ? "comment" : "comments"} ·{" "}
          {timeAgo(discussion.createdAt)}
        </span>
        {discussion.upvoteCount > 0 ? (
          <span className="inline-flex items-center gap-0.5">
            <CaretUpIcon size={12} className="shrink-0" />
            {discussion.upvoteCount}
          </span>
        ) : null}
      </p>
      <LabelChips names={discussion.labels.map((l) => l.name)} />
    </div>
  );
}

/** A neutral muted chip whose TEXT carries the meaning (answered / closed / a marker)
 *  — never color alone (WCAG 1.4.1). */
function NeutralChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {children}
    </span>
  );
}

/** A discussion's label names as neutral muted chips (max 2, then a "+n" overflow
 *  chip). Labels carry NO color on the phone (contrast-correcting arbitrary label
 *  colors is out of scope), so the chips are always neutral. Renders nothing when
 *  there are no labels. Mirrors Issues' LabelChips. */
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

/** A read-only discussion detail. */
export function DiscussionDetailBody({
  repoId,
  number,
}: {
  repoId: string;
  number: number;
}) {
  const { data, isPending, isError, error, refetch } = useDiscussion(
    repoId,
    number,
  );

  // Definitive gone WINS: the whole detail (back bar included) is replaced by the
  // teaching state. (A gh "not found" for a bad discussion number arrives as a
  // GENERIC server error, NOT `noSuchRepo` — the generic ErrorState below is the
  // correct rendering for that; don't try to map it to repo-gone.)
  if (isRepoGoneError(error)) return <RepoGoneState />;

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-2 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => navigate(repoHash(repoId, "discussions"))}
          className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm font-medium text-primary"
        >
          <ArrowLeftIcon size={16} />
          Discussions
        </button>
      </div>

      {asApiError(error)?.isDiscussionsUnavailable ? (
        <DiscussionsUnavailableState
          title="Discussions aren't available for this repository"
          hint={asApiError(error)?.message}
        />
      ) : isError ? (
        <ErrorState error={error} onRetry={() => refetch()} />
      ) : isPending || !data ? (
        <SkeletonRows count={3} />
      ) : (
        <article className="flex flex-col gap-4 px-4 py-5">
          <header className="flex flex-col gap-2">
            <NeutralChip>
              {data.categoryEmoji} {data.categoryName}
            </NeutralChip>
            <DiscussionStateChips detail={data} />
            <h1 className="text-base font-semibold text-foreground">
              {data.title}
            </h1>
            <span className="text-xs text-muted-foreground">
              #{data.number}
            </span>
            <p className="text-xs text-muted-foreground">
              {data.author || "unknown"} · {timeAgo(data.createdAt)}
            </p>
            <LabelChips names={data.labels.map((l) => l.name)} />
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

/** The discussion's state chips row — answered / locked / closed, each rendered only
 *  when true. Neutral chips whose TEXT carries the state (locked also gets a lock icon,
 *  mirroring Issues' locked row); never color alone (WCAG 1.4.1). Renders nothing when
 *  the discussion is a plain open one. */
function DiscussionStateChips({ detail }: { detail: DiscussionDetails }) {
  if (!detail.isAnswered && !detail.locked && !detail.closed) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {detail.isAnswered ? <NeutralChip>Answered</NeutralChip> : null}
      {detail.locked ? (
        <NeutralChip>
          <span className="inline-flex items-center gap-1">
            <LockIcon size={12} className="shrink-0" />
            Locked
            {detail.activeLockReason ? ` (${detail.activeLockReason})` : ""}
          </span>
        </NeutralChip>
      ) : null}
      {detail.closed ? (
        <NeutralChip>
          Closed{detail.stateReason ? ` · ${detail.stateReason}` : ""}
        </NeutralChip>
      ) : null}
    </div>
  );
}

/** The discussion's comment threads — top-level comments, each with its nested replies
 *  one level deep. Reads the EXISTING `useDiscussion` detail (no new query), so there's
 *  no separate loading/error state here. The wire caps comments AND replies at 100 each
 *  (GraphQL page caps); v1 shows the served prefix with no "load more" affordance. */
function CommentsSection({ detail }: { detail: DiscussionDetails }) {
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
            <CommentCard
              key={c.id}
              comment={c}
              answerable={detail.isAnswerable}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** One top-level comment — author + relative time, an "Answer" marker when it's the
 *  accepted answer (only meaningful in an answerable/Q&A category), the Markdown body
 *  (or a hidden-comment row when minimized), a display-only upvote count, and its
 *  nested replies. */
function CommentCard({
  comment,
  answerable,
}: {
  comment: DiscussionComment;
  answerable: boolean;
}) {
  const showAnswer = comment.isAnswer && answerable;
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
        {showAnswer ? (
          // Icon + the word "Answer" — the marker never rests on the success tint
          // alone (WCAG 1.4.1).
          <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
            <CheckCircleIcon size={12} weight="fill" />
            Answer
          </span>
        ) : null}
      </div>
      <CommentBody
        body={comment.body}
        isMinimized={comment.isMinimized}
        minimizedReason={comment.minimizedReason}
      />
      {comment.upvoteCount > 0 ? (
        <p className="flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
          <CaretUpIcon size={12} className="shrink-0" />
          {comment.upvoteCount}
        </p>
      ) : null}
      {comment.replies.length > 0 ? (
        <ul className="mt-1 ml-1 flex flex-col gap-2 border-l border-border pl-3">
          {comment.replies.map((r) => (
            <ReplyCard key={r.id} reply={r} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** A nested reply — the same author/time/body anatomy as a comment, minus the answer
 *  marker and upvotes (replies carry no upvote count on the wire). */
function ReplyCard({ reply }: { reply: DiscussionReply }) {
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-foreground/80">
          {reply.author || "unknown"}
        </span>
        {reply.date ? (
          <span className="text-xs text-muted-foreground">
            {timeAgo(reply.date)}
          </span>
        ) : null}
      </div>
      <CommentBody
        body={reply.body}
        isMinimized={reply.isMinimized}
        minimizedReason={reply.minimizedReason}
      />
    </li>
  );
}

/** The body shared by comments and replies: a minimized one collapses to a one-line
 *  muted "Hidden comment (reason)" row (no expand in v1); otherwise its Markdown body.
 *  Mirrors Issues' CommentCard body. */
function CommentBody({
  body,
  isMinimized,
  minimizedReason,
}: {
  body: string;
  isMinimized: boolean;
  minimizedReason: string;
}) {
  if (isMinimized) {
    return (
      <p className="flex items-center gap-1.5 text-xs italic text-muted-foreground">
        <EyeSlashIcon size={14} className="shrink-0" />
        Hidden comment
        {minimizedReason ? ` (${minimizedReason})` : ""}
      </p>
    );
  }
  if (body) return <Markdown className="text-foreground/90">{body}</Markdown>;
  return null;
}
