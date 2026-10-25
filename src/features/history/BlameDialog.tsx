import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { PathText } from "@/components/path-text";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { Spinner } from "@/components/ui/spinner";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  detailNoticeMessage,
  refreshFailed,
  resolveDetailPane,
} from "@/features/conversations/remote-section-state";
import { diffLang } from "@/features/diff/diff-lang";
import { HighlightedLine } from "@/features/diff/HighlightedLine";
import { presentError } from "@/lib/error-summary";
import { useBlame } from "@/lib/git/queries";
import type { BlameLine } from "@/lib/git/types";
import { createCardLatch } from "@/lib/hover-card-latch";
import { useUiStore } from "@/lib/stores/ui";
import { validEpochMs } from "@/lib/time";
import { isUnknownRevisionError } from "./blame-errors";

/** `git blame --porcelain` reports uncommitted lines with an all-zero sha
 *  (author "Not Committed Yet"). Those rows aren't navigable commits, so the
 *  gutter stays a plain, inert label for them. */
function isRealCommit(hash: string): boolean {
  return !/^0+$/.test(hash);
}

/** A row's handle on its own card — `setOpen` is stable for the row's life, so
 *  the object doubles as the row's identity in the latch below. */
interface CardOwner {
  setOpen: (open: boolean) => void;
}

/** Teardown for a row the latch is taking the card away from. It ends by
 *  releasing, so the surface's own close paths can call it directly too. */
function resetCard(owner: CardOwner) {
  owner.setOpen(false);
  releaseCard(owner);
}

/** This family is the blame gutter's rows — a card opened by keyboard closes
 *  only on blur or dismissal, so opening one elsewhere in the list fires none of
 *  its close routes and both would float. */
const { claim: claimCard, release: releaseCard } =
  createCardLatch<CardOwner>(resetCard);

/** `git blame` view: each line's content with the commit that last changed it. */
export function BlameDialog({
  repoPath,
  path,
  rev,
  open,
  onOpenChange,
}: {
  repoPath: string;
  path: string;
  rev?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const blame = useBlame(repoPath, open ? path : null, rev);
  const lines = blame.data ?? [];
  const name = path.split("/").pop() ?? path;
  const lang = diffLang(path);
  // Abbreviate a full 40-hex sha to 7 chars; show branch/tag names verbatim.
  const shortRev = rev
    ? /^[0-9a-f]{40}$/i.test(rev)
      ? rev.slice(0, 7)
      : rev
    : null;
  // Native scroll container held in STATE (not a ref) so attaching it
  // re-renders and the child's virtualizer re-initializes with the real node —
  // a plain ref stays null at the virtualizer's mount effect, so
  // getVirtualItems() returns [] and no rows paint. See
  // docs/list-virtualization.md and HistoryPanel's `setScrollEl` wiring.
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  // A failed refresh keeps the loaded lines under a notice; only a read with
  // nothing loaded replaces them.
  const pane = resolveDetailPane({
    pending: blame.isPending,
    error: blame.isError,
    hasData: blame.data !== undefined,
    paused: blame.isPaused,
    fetching: blame.isFetching,
  });
  const failed = refreshFailed(blame);
  // Retry resets the read to pending, swapping the error arm for the spinner;
  // every arm renders in the same wrapper around the list, so focus lands there.
  const { hostRef, retryRef } = useRetryFocusRescue(
    pane === "error" && blame.isError,
  );
  // Degraded content is the same arm, so a failed or recovered refresh never
  // moves focus.
  const arm = pane === "content-degraded" ? "content" : pane;
  // An arm swap or record switch that unmounts the focused node would drop
  // focus to <body>; land it on the host. Change-only, so a mount never takes
  // focus from elsewhere.
  const focusHost = useRef<HTMLDivElement | null>(null);
  const viewFrame = `${arm}:${path}@${rev ?? ""}`;
  const lastViewFrame = useRef(viewFrame);
  useLayoutEffect(() => {
    if (lastViewFrame.current === viewFrame) return;
    lastViewFrame.current = viewFrame;
    if (document.activeElement === document.body)
      focusHost.current?.focus({ preventScroll: true });
  }, [viewFrame]);

  const shell = (content: ReactNode) => (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* ph-no-capture: file name, path, and full file content — block from replay. */}
      <DialogContent className="ph-no-capture flex h-[80vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate">
            {shortRev ? `Blame: ${name} @ ${shortRev}` : `Blame: ${name}`}
          </DialogTitle>
          <DialogDescription>
            <PathText path={path} className="font-mono" />
          </DialogDescription>
        </DialogHeader>

        {/* The host wraps the list rather than being it: a tabIndex on the
            scroller would take the keyboard tab stop Chromium gives a scroller
            with no focusable rows. */}
        <div
          ref={(node) => {
            hostRef(node);
            focusHost.current = node;
          }}
          tabIndex={-1}
          className="flex min-h-0 flex-1 flex-col outline-none"
        >
          {/* A sibling of the list, never inside it: a role="list" container
              takes listitem children only. */}
          <DegradedListNotice
            noun="this file's blame"
            degraded={pane === "content-degraded"}
            message={detailNoticeMessage({
              noun: "file's blame",
              isError: failed,
              stale: blame.isPlaceholderData,
            })}
            onRetry={failed ? () => void blame.refetch() : undefined}
            className="shrink-0 border-b px-3 py-1.5"
          />
          {/* Native overflow scroll container (not the Base-UI ScrollArea) so
              the virtualizer's getScrollElement gets the real scrollable node
              — see docs/list-virtualization.md. Fixed-height flex child so
              getTotalSize resolves (max-h would leave it unbounded → 0). */}
          <div
            ref={setScrollEl}
            // List semantics only while listitem rows are actually rendered —
            // the pending/error/empty branches would otherwise sit as
            // non-listitem children of a role="list" (an invalid a11y tree).
            role={
              (pane === "content" || pane === "content-degraded") &&
              lines.length > 0
                ? "list"
                : undefined
            }
            aria-label={`Blame for ${name}`}
            className="min-h-0 flex-1 overflow-auto border"
          >
            {content}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );

  // The read is local, so it never parks offline: that arm keeps loading.
  if (pane === "skeleton" || pane === "offline") {
    return shell(
      <div className="flex justify-center p-4">
        <Spinner />
      </div>,
    );
  }
  if (pane === "error" || !blame.data) {
    return shell(
      <div className="flex flex-col items-start gap-2 p-3 text-xs text-muted-foreground">
        <p>
          {!shortRev
            ? "Couldn't blame this file."
            : // Only a rev git couldn't resolve says it isn't available; the
              // reason line below shows git's report for every failure.
              isUnknownRevisionError(blame.error)
              ? `Couldn't blame this file at ${shortRev} — that revision isn't available locally.`
              : `Couldn't blame this file at ${shortRev}.`}
        </p>
        {blame.isError ? (
          <>
            <p>{presentError(blame.error).summary}</p>
            <Button
              ref={retryRef}
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={() => void blame.refetch()}
            >
              Retry
            </Button>
          </>
        ) : null}
      </div>,
    );
  }
  if (lines.length === 0) {
    return shell(
      <p className="p-3 text-xs text-muted-foreground">Empty file.</p>,
    );
  }
  // Data-gated child: the useVirtualizer call lives here (never in the dialog
  // host) so (a) BlameDialog keeps compiling under the React Compiler —
  // useVirtualizer bails its host out — and (b) the virtualizer only mounts once
  // there are lines, dodging the variable-height first-row measureElement race
  // (docs/list-virtualization.md).
  return shell(
    <BlameLines
      scrollEl={scrollEl}
      lines={lines}
      language={lang}
      onOpenChange={onOpenChange}
    />,
  );
}

/** The gutter cell for a row that starts a new commit: the trigger, plus the
 *  card describing that commit. The card is controlled — and every open route
 *  claims the latch — so the list can only ever show one at a time; the state
 *  and its owner identity are per row, which is what lets an evicted row give up
 *  its claim without clearing the card of the row that replaced it. */
function BlameCommitCell({
  line,
  short,
  scrollEl,
  onGoToCommit,
}: {
  line: BlameLine;
  short: string;
  scrollEl: HTMLDivElement | null;
  onGoToCommit: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Built once: the latch compares rows by this object's identity, so it has to
  // outlive every render.
  const [card] = useState<CardOwner>(() => ({ setOpen }));
  const whenIso = validEpochMs(line.time * 1000)
    ? new Date(line.time * 1000).toISOString()
    : "";

  // The virtualizer evicts rows mid-dwell, and an evicted row that still held
  // the latch would tear down whichever card claims it next. Release only — a
  // row on its way out has no state left to settle.
  useEffect(() => () => releaseCard(card), [card]);

  // Scrolling takes the row out from under the pointer or the focus that opened
  // its card, so the scroll ends it rather than leaving one nobody holds.
  useEffect(() => {
    if (!open || !scrollEl) return;
    const close = () => resetCard(card);
    scrollEl.addEventListener("scroll", close);
    return () => scrollEl.removeEventListener("scroll", close);
  }, [open, scrollEl, card]);

  return (
    <HoverCard
      open={open}
      // Both open routes land here — the pointer's dwell and keyboard focus —
      // so claiming here is what keeps the list to one card. Re-opening this
      // row's own card is not a takeover.
      onOpenChange={(next) => {
        if (!next) {
          resetCard(card);
          return;
        }
        claimCard(card);
        setOpen(true);
      }}
    >
      <HoverCardTrigger
        render={
          <button
            type="button"
            aria-label={`View commit ${short}: ${line.summary}`}
          />
        }
        onClick={onGoToCommit}
        className="w-40 shrink-0 cursor-pointer truncate border-r px-2 text-left text-muted-foreground hover:text-foreground hover:underline focus-visible:ring-1 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        {`${short} ${line.author}`}
      </HoverCardTrigger>
      <HoverCardContent className="w-72">
        <div className="flex flex-col gap-1.5">
          <p className="font-mono text-muted-foreground">{short}</p>
          <p className="line-clamp-2 font-medium break-words">{line.summary}</p>
          <p className="text-muted-foreground">
            {line.author}
            {whenIso && (
              <>
                {" · "}
                <RelativeTime date={whenIso} />
              </>
            )}
          </p>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="xs" onClick={onGoToCommit}>
              View commit
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(line.hash);
                  toast.success("Commit SHA copied");
                } catch {
                  toast.error("Could not copy to clipboard");
                }
              }}
            >
              Copy SHA
            </Button>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** The virtualized blame rows. Isolated in its own leaf so useVirtualizer
 *  doesn't bail the dialog host out of the React Compiler, and so it mounts
 *  only once `lines` is non-empty. hljs highlighting now runs only for the
 *  mounted (visible) rows — the perf win for very large files. */
function BlameLines({
  scrollEl,
  lines,
  language,
  onOpenChange,
}: {
  scrollEl: HTMLDivElement | null;
  lines: BlameLine[];
  language: string | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const openCommit = useUiStore((s) => s.openCommit);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollEl,
    // Most lines are a single ~18px text row; measureElement corrects any that
    // wrap (whitespace-pre-wrap on long lines makes rows taller).
    estimateSize: () => 18,
    overscan: 24,
    getItemKey: (index) => lines[index].lineNo,
  });

  return (
    <div
      // Presentation wrapper so the virtualizer's positioning div doesn't sit
      // between the role="list" scroll container and its listitem rows in the
      // a11y tree (same reasoning as CloneRepoDialog.tsx:474-476).
      role="presentation"
      className="relative w-full font-mono text-[11px] leading-relaxed"
      style={{ height: `${virtualizer.getTotalSize()}px` }}
    >
      {virtualizer.getVirtualItems().map((vi) => {
        const line = lines[vi.index];
        // Show the commit gutter only when it changes, like git's blame.
        // Index-based against the full `lines` array, so it works unchanged
        // inside virtual rows.
        const newCommit =
          vi.index === 0 || lines[vi.index - 1].hash !== line.hash;
        const short = line.hash.slice(0, 7);
        // Only real commits get the interactive commit reference; uncommitted
        // (all-zero sha) rows and continuation rows keep the plain gutter cell.
        const interactive = newCommit && isRealCommit(line.hash);
        // Close the dialog AND navigate in the SAME synchronous handler: from
        // the ChangesPanel host, landing on History conceals this subtree, so a
        // close that lands after it would wait for Changes to be shown again.
        const goToCommit = () => {
          onOpenChange(false);
          openCommit(line.hash);
        };
        return (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            role="listitem"
            aria-setsize={lines.length}
            aria-posinset={vi.index + 1}
            className="absolute top-0 left-0 flex w-full items-start hover:bg-muted/40"
            style={{ transform: `translateY(${vi.start}px)` }}
          >
            {interactive ? (
              <BlameCommitCell
                line={line}
                short={short}
                scrollEl={scrollEl}
                onGoToCommit={goToCommit}
              />
            ) : (
              <span className="w-40 shrink-0 truncate border-r px-2 text-muted-foreground">
                {newCommit ? `${short} ${line.author}` : ""}
              </span>
            )}
            <span className="w-10 shrink-0 select-none px-1 text-right text-muted-foreground/70">
              {line.lineNo}
            </span>
            <HighlightedLine content={line.content} language={language} />
          </div>
        );
      })}
    </div>
  );
}
