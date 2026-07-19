import {
  ArrowDownIcon,
  ArrowLeftIcon,
  CaretRightIcon,
  CheckCircleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ReviewKindChip } from "../components/chips";
import { Markdown } from "../components/markdown";
import {
  EmptyState,
  ErrorState,
  SkeletonRows,
  StaleBanner,
} from "../components/states";
import { timeAgo } from "../lib/format";
import { useReviews } from "../lib/queries";
import { navigate } from "../lib/router";
import {
  type Segment,
  type StreamState,
  TOOL_VERB,
  useReviewStream,
} from "../lib/use-review-stream";
import { useRovingList } from "../lib/use-roving-list";

// The Agents tab: a list of live agent streams (AI PR reviews + agent sessions the
// desktop is broadcasting), and a live watch screen over SSE — the epic's phone
// killer feature. Read-only by design: no approve/deny/write affordances here.

/** The agent-stream list. `active` gates polling (false while a watch is open). */
export function AgentsBody({ active }: { active: boolean }) {
  const { data, isError, error, refetch } = useReviews(active);
  const { register, onKeyDown } = useRovingList();

  // Prefer stale data: keep the last-known list on screen even on error, with a
  // StaleBanner above it. Full-screen ErrorState only when there's nothing to
  // show; skeleton only while the first fetch is pending. (401/409 route through
  // ErrorState/the shell exactly like the other lists.)
  if (!data) {
    if (isError) return <ErrorState error={error} onRetry={() => refetch()} />;
    return <SkeletonRows />;
  }

  return (
    <div className="flex flex-col">
      {isError ? <StaleBanner error={error} onRetry={() => refetch()} /> : null}
      {data.length === 0 ? (
        <EmptyState
          title="Nothing running"
          hint="Start an AI review or agent session on your desktop to watch it here."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {data.map((r, i) => (
            <li key={r.id}>
              <button
                type="button"
                ref={register(i)}
                onKeyDown={onKeyDown}
                onClick={() => navigate(`#agents/${r.id}`)}
                className="flex w-full min-h-14 items-center gap-3 px-4 py-3 text-left"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <ReviewKindChip kind={r.kind} />
                    <span className="text-xs text-muted-foreground">
                      {timeAgo(r.startedAt)}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-sm font-medium text-foreground">
                    {r.kind === "review"
                      ? "AI review in progress"
                      : "Agent session in progress"}
                  </p>
                </div>
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

/** Whether the OS/browser is set to reduced motion — read once (a watch session is
 *  short; we don't need to react to a mid-session toggle). */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** The live watch screen for one agent stream. */
export function AgentWatch({ id }: { id: string }) {
  const stream = useReviewStream(id);

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-background/95 px-2 py-2 backdrop-blur">
        <button
          type="button"
          onClick={() => navigate("#agents")}
          className="inline-flex min-h-11 items-center gap-1 rounded px-2 text-sm font-medium text-primary"
        >
          <ArrowLeftIcon size={16} />
          Agents
        </button>
      </div>
      <WatchBody stream={stream} />
    </div>
  );
}

function WatchBody({ stream }: { stream: StreamState }) {
  const { segments, statusText, terminal, phase } = stream;

  // Auto-follow: keep pinned to newest content while the user is at the bottom; if
  // they scroll up, stop following and reveal "Jump to latest". `following` is a
  // ref (transient, read in effects/handlers only) so scroll churn never re-renders;
  // `showJump` is the small piece of derived state the button needs.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const following = useRef(true);
  // Last observed scrollTop, to read scroll DIRECTION. This is the fix for the
  // auto-follow self-cancel: a smooth `scrollToBottom` emits intermediate `scroll`
  // events whose positions momentarily read not-at-bottom. A position-only test would
  // flip `following` false mid-animation and spuriously show "Jump to latest" though
  // the user never scrolled. Direction sidesteps it entirely — a programmatic scroll
  // only ever moves DOWN toward the bottom, so it never trips the "scrolled up" branch,
  // and it re-arms following when it lands at the bottom. No guard flag / timeout, and
  // no window where a genuine user scroll is ignored. (Reduced-motion "auto" jumps
  // straight to bottom → an atBottom event → following stays true, unchanged.)
  const lastScrollTop = useRef(0);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback((smooth: boolean) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto",
    });
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    // A small tolerance so sub-pixel rounding never reads as "scrolled up".
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    const scrolledUp = el.scrollTop < lastScrollTop.current - 1;
    lastScrollTop.current = el.scrollTop;
    // Stop following only on a deliberate UP scroll; re-arm at the bottom. A
    // programmatic down-scroll never trips the up-branch, so it can't self-cancel.
    if (atBottom) following.current = true;
    else if (scrolledUp) following.current = false;
    setShowJump(!following.current);
  }, []);

  // A primitive that changes on every new content frame — the last segment's text
  // length grows as deltas coalesce, a new tool step bumps the count, status/terminal
  // change too. Depending on it (rather than the object refs) re-runs the pin effect
  // once per frame.
  const lastSeg = segments[segments.length - 1];
  const contentKey = `${segments.length}:${lastSeg?.kind === "text" ? lastSeg.text.length : 0}:${statusText ?? ""}:${terminal ? terminal.kind : ""}`;

  // Stay pinned to newest while the user is following. `following` is a ref, so a
  // manual scroll-up (which flips it false) doesn't itself re-run this. `contentKey`
  // is read here so this is a genuine dependency (the effect must re-run each frame).
  useEffect(() => {
    void contentKey;
    if (following.current) scrollToBottom(true);
  }, [contentKey, scrollToBottom]);

  const empty = segments.length === 0 && !terminal && !statusText;

  return (
    <div className="relative flex flex-col">
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex max-h-[calc(100dvh-8rem)] flex-col gap-3 overflow-y-auto px-4 py-4"
      >
        {phase === "connecting" ? (
          <ConnectingState />
        ) : (
          <>
            {phase === "live" ? <LiveNote /> : null}
            {/* Live but nothing has streamed yet (or a Codex-style run whose only
                output is its terminal). ended/gone own their own states below. */}
            {empty && phase === "live" ? <EmptyTranscript /> : null}
            {segments.map((seg, i) => (
              <SegmentRow key={i} seg={seg} />
            ))}
            {statusText ? <StatusRow text={statusText} /> : null}
            {terminal ? (
              <TerminalCard terminal={terminal} segments={segments} />
            ) : null}
            {/* Closed without a terminal event but still shared (`ended`, no
                terminal): otherwise the transcript would silently freeze with no
                cue to tell "stopped" from "paused". `gone` has its own state. */}
            {phase === "ended" && !terminal ? <EndedNote /> : null}
            {phase === "gone" ? <GoneState /> : null}
          </>
        )}
      </div>

      {showJump ? (
        <button
          type="button"
          onClick={() => {
            following.current = true;
            setShowJump(false);
            scrollToBottom(true);
          }}
          className="absolute bottom-4 left-1/2 inline-flex min-h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-md"
        >
          <ArrowDownIcon size={14} weight="bold" />
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}

/** A live-connection note: there is no replay, so we say what "live" means. */
function LiveNote() {
  return (
    <p
      className="flex items-center gap-2 text-xs text-muted-foreground"
      role="status"
    >
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-success"
      />
      Watching live — activity from when you joined
    </p>
  );
}

/** The opening state: connecting to the stream, nothing received yet. */
function ConnectingState() {
  return (
    <div className="flex flex-col gap-3">
      <p
        className="flex items-center gap-2 text-xs text-muted-foreground"
        role="status"
      >
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-muted-foreground"
        />
        Connecting to the live stream…
      </p>
      <SkeletonRows count={2} />
    </div>
  );
}

/** Connected & live, but nothing has streamed yet (or a Codex-style run that emits
 *  no deltas before its terminal). A calm placeholder, never a blank region. */
function EmptyTranscript() {
  return (
    <p className="text-sm text-muted-foreground">
      Waiting for the agent's next step…
    </p>
  );
}

/** The stream closed and the run is no longer shared (ended / sharing off / repo
 *  switched / device revoked). */
function GoneState() {
  return (
    <div className="flex flex-col items-start gap-3 rounded-md border border-border bg-muted/40 px-4 py-4">
      <p className="text-sm font-medium text-foreground">
        This run ended or is no longer shared.
      </p>
      <button
        type="button"
        onClick={() => navigate("#agents")}
        className="inline-flex min-h-9 items-center gap-1 rounded px-2 text-sm font-medium text-primary"
      >
        <ArrowLeftIcon size={14} />
        Back to agents
      </button>
    </div>
  );
}

/** One transcript row — a prose run or a tool step. */
function SegmentRow({ seg }: { seg: Segment }) {
  if (seg.kind === "text") {
    // Formatted markdown, matching the desktop's live watch — the accumulating
    // buffer re-parses as deltas arrive (partial-markdown artifacts are momentary
    // and marked tolerates incomplete input). Only the TRAILING run's `children`
    // changes per frame; earlier runs are stable and `Markdown` memoizes its parse
    // on `children`, so per-frame cost is a single parse. `.markdown-body` collapses
    // its first/last-child margins, so a run sits in the transcript's `gap-3` rhythm.
    return <Markdown className="text-foreground/90">{seg.text}</Markdown>;
  }
  return (
    <p className="flex min-w-0 items-baseline gap-2 text-xs text-muted-foreground">
      <span className="shrink-0 font-medium text-foreground/70">
        {TOOL_VERB[seg.tool]}
      </span>
      {seg.target ? (
        // CSS truncation (single-line ellipsis), never JS slicing — the server
        // already clips the target to ~2000 chars.
        <span className="truncate font-mono">{seg.target}</span>
      ) : null}
    </p>
  );
}

/** The current transient progress note (replaced by each new status). */
function StatusRow({ text }: { text: string }) {
  return (
    <p
      className="flex items-center gap-2 text-xs italic text-muted-foreground"
      role="status"
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-muted-foreground"
      />
      {text}
    </p>
  );
}

/** The stream closed WITHOUT a terminal event, but the run is still shared (`ended`
 *  with no `done`/`error`). A small designed cue so a stopped stream reads as
 *  stopped, not paused. (`gone` — no longer shared — has its own richer state.) */
function EndedNote() {
  return (
    <p
      className="flex items-center gap-2 text-xs text-muted-foreground"
      role="status"
    >
      <span
        aria-hidden
        className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground"
      />
      Stream ended.
    </p>
  );
}

/** Whether the terminal `done.text` is already the tail of the streamed transcript
 *  — true for a Claude run (its delta buffer ends verbatim with `Done.text`, per
 *  `agent.rs`), so the completion card is metadata-only and doesn't repeat the whole
 *  answer. False for Codex (emits no deltas) or a divergent final answer — those
 *  render `terminal.text` as the card body so it's never lost. */
function terminalDuplicatesTranscript(
  text: string,
  segments: Segment[],
): boolean {
  const answer = text.trim();
  if (!answer) return true; // nothing to add
  const lastText = [...segments].reverse().find((s) => s.kind === "text");
  return lastText?.kind === "text" && lastText.text.trim().endsWith(answer);
}

/** The terminal card — a completed run (its final answer + optional cost) or a
 *  failure. The final answer is shown as the card body ONLY when it isn't already
 *  the tail of the streamed transcript (see {@link terminalDuplicatesTranscript}). */
function TerminalCard({
  terminal,
  segments,
}: {
  terminal: NonNullable<StreamState["terminal"]>;
  segments: Segment[];
}) {
  if (terminal.kind === "error") {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-destructive">
          <WarningCircleIcon size={16} weight="fill" />
          The run failed.
        </p>
        <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">
          {terminal.message}
        </p>
      </div>
    );
  }

  const cost =
    terminal.costUsd != null ? `$${terminal.costUsd.toFixed(2)}` : null;
  const showBody =
    terminal.text.trim().length > 0 &&
    !terminalDuplicatesTranscript(terminal.text, segments);

  if (terminal.isError) {
    return (
      <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3">
        <p className="flex items-center gap-2 text-sm font-medium text-destructive">
          <WarningCircleIcon size={16} weight="fill" />
          Finished with an error
          {cost ? <span className="font-normal">· {cost}</span> : null}
        </p>
        {showBody ? (
          <Markdown className="text-foreground/90">{terminal.text}</Markdown>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-success/40 bg-success/10 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-medium text-success">
        <CheckCircleIcon size={16} weight="fill" />
        Done
        {cost ? (
          <span className="font-normal text-muted-foreground">· {cost}</span>
        ) : null}
      </p>
      {showBody ? (
        <Markdown className="text-foreground/90">{terminal.text}</Markdown>
      ) : null}
    </div>
  );
}
