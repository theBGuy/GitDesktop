import { useVirtualizer } from "@tanstack/react-virtual";
import hljs from "highlight.js/lib/common";
import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import { diffLang } from "@/features/diff/diff-lang";
import { useBlame } from "@/lib/git/queries";
import type { BlameLine } from "@/lib/git/types";
import { createCardLatch } from "@/lib/hover-card-latch";
import { useUiStore } from "@/lib/stores/ui";
import { validEpochMs } from "@/lib/time";
import "@/features/diff/code-highlight.css";

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

/** One code line, syntax-highlighted when the language is recognized. */
function BlameCode({
  content,
  language,
}: {
  content: string;
  language: string | undefined;
}) {
  const html =
    language && hljs.getLanguage(language)
      ? hljs.highlight(content, { language, ignoreIllegals: true }).value
      : null;
  if (html === null) {
    return <span className="px-2 whitespace-pre-wrap">{content || " "}</span>;
  }
  return (
    <span
      className="gd-code px-2 whitespace-pre-wrap"
      dangerouslySetInnerHTML={{ __html: html || " " }}
    />
  );
}

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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* ph-no-capture: file name, path, and full file content — block from replay. */}
      <DialogContent className="ph-no-capture flex h-[80vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate">
            {shortRev ? `Blame: ${name} @ ${shortRev}` : `Blame: ${name}`}
          </DialogTitle>
          <DialogDescription className="truncate font-mono">
            {path}
          </DialogDescription>
        </DialogHeader>

        {/* Native overflow scroll container (not the Base-UI ScrollArea) so the
            virtualizer's getScrollElement gets the real scrollable node — see
            docs/list-virtualization.md. Fixed-height flex child so getTotalSize
            resolves (max-h would leave it unbounded → 0). */}
        <div
          ref={setScrollEl}
          // List semantics only while listitem rows are actually rendered — the
          // pending/error/empty branches would otherwise sit as non-listitem
          // children of a role="list" (an invalid a11y tree).
          role={
            !blame.isPending && !blame.isError && lines.length > 0
              ? "list"
              : undefined
          }
          aria-label={`Blame for ${name}`}
          className="min-h-0 flex-1 overflow-auto border"
        >
          {blame.isPending ? (
            <div className="flex justify-center p-4">
              <Spinner />
            </div>
          ) : blame.isError ? (
            <p className="p-3 text-xs text-muted-foreground">
              {shortRev
                ? `Couldn't blame this file at ${shortRev} — it may not exist at that revision, or the commit isn't available locally.`
                : "Couldn't blame this file (it may be binary or untracked)."}
            </p>
          ) : lines.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">Empty file.</p>
          ) : (
            // Data-gated child: the useVirtualizer call lives here (never in the
            // dialog host) so (a) BlameDialog keeps compiling under the React
            // Compiler — useVirtualizer bails its host out — and (b) the
            // virtualizer only mounts once there are lines, dodging the
            // variable-height first-row measureElement race
            // (docs/list-virtualization.md).
            <BlameLines
              scrollEl={scrollEl}
              lines={lines}
              language={lang}
              onOpenChange={onOpenChange}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
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
            <BlameCode content={line.content} language={language} />
          </div>
        );
      })}
    </div>
  );
}
