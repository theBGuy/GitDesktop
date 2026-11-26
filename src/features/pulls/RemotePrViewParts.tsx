import { ClockIcon } from "@phosphor-icons/react";
import { type ComponentProps, useMemo, useState } from "react";
import { DetailRail, DetailRailRow } from "@/components/detail-rail";
import { DiffStat } from "@/components/diff-stat";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { FileListFilter } from "@/components/use-file-list-filter";
import { refreshFailed } from "@/features/conversations/remote-section-state";
import type { MentionSource } from "@/features/conversations/useMentionCandidates";
import {
  type DiffContentSource,
  useLatchedFor,
} from "@/features/diff/content-source";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import {
  DiffContent,
  type DiffLineAnchor,
  type LineWidget,
} from "@/features/diff/DiffSurfaceLazy";
import {
  OpenEditorsContext,
  useOpenEditorsHost,
} from "@/features/diff/editor-keep";
import {
  FileSlots,
  keyedPaneView,
  placeholderPaneView,
  type SlotRead,
  useFileSlots,
  useSlotRead,
  useSlotRetained,
  useSlotWidget,
} from "@/features/diff/file-slot";
import {
  type ForgeWhitespaceRevs,
  useForgeWhitespaceDiff,
} from "@/features/diff/use-forge-whitespace-diff";
import { FileRowActions } from "@/features/history/FileRowActions";
import { TimeTrackingControls } from "@/features/issues/RemoteIssueViewParts";
import type { PrContentRevs } from "@/lib/git/api";
import { sectionIsBinary, sectionOldPath } from "@/lib/git/diff-split";
import {
  type PendingThreadWrites,
  useAddMrSpentTime,
  useGlMrTimeStats,
  useObjectsPresent,
  useSetMrTimeEstimate,
} from "@/lib/git/queries";
import type {
  ForgeProvider,
  RemoteLens,
  ReviewThreadOut,
} from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import type { ReviewDraft } from "@/lib/pulls/review-drafts";
import { cn } from "@/lib/utils";
import { DraftCommentCard } from "./PendingReviewBar";
import { ReviewThreadCard, type SuggestionApply } from "./ReviewThreads";

type PrFile = { path: string; additions: number; deletions: number };

/** A pull request's whole-file reads: its revs, and where they're read from. */
interface PrFileContent {
  revs: PrContentRevs;
  source: DiffContentSource;
}

/** The handlers/gates the in-diff {@link ReviewThreadCard}s need — a subset of
 *  the Conversation block's, passed straight through from the view. */
interface DiffThreadWiring {
  onQuote?: (body: string) => void;
  onReply?: (threadId: string, body: string) => Promise<void>;
  onResolve?: (threadId: string, resolved: boolean) => Promise<void>;
  /** Present when the viewer may edit their own thread comments; saves the new
   *  body. Wired to a Thread's edit control only for a comment the viewer wrote;
   *  resolves whether the edit saved, as Thread's `onSaveEdit` does. */
  onEditComment?: (
    commentId: string,
    body: string,
  ) => boolean | Promise<boolean>;
  /** Present when the viewer may delete their own thread comments; opens the
   *  delete confirmation. Wired only for a comment the viewer wrote. */
  onDeleteComment?: (commentId: string) => void;
  /** The caller's temporary hold over an ALREADY-OPEN comment editor: Save
   *  holds silently. Set it whenever a stale arm withholds `onEditComment`,
   *  or the open editor reads that absence as a lost permission. Threaded
   *  straight through to every card's Thread. */
  editHeld?: boolean;
  /** Why the viewer's own comments can't be edited (null = they can): holds the
   *  Edit row and an open editor's Save with this reason. */
  editHeldReason?: string | null;
  /** Replies and resolves in flight per thread, from the mutation cache. */
  pendingWrites?: PendingThreadWrites;
  /** The forge the threads came from — disambiguates bare-fence Apply scope for
   *  suggestions (GitHub = whole range, GitLab = anchored line only). Defaults to
   *  "github" in the card so an unwired caller is byte-identical. */
  provider?: ForgeProvider;
  /** Gating inputs + the write for the per-suggestion Apply affordance. Absent =
   *  no Apply shown (identical graceful default as the Conversation block). */
  apply?: SuggestionApply;
  /** File-section lookup for synthesizing a hunk on hunk-less providers, so the
   *  in-diff thread cards get the same Apply affordance. Absent = no synthesis. */
  fileDiffLookup?: (path: string) => string | undefined;
  /** Opt in to `@`/`#`/`!` autocomplete in each card's editors. Absent = no
   *  autocomplete. */
  mentions?: MentionSource;
}

/**
 * One anchor block: the review thread(s) on a single side+line, rendered as a
 * gap-2 stack of compact {@link ReviewThreadCard}s. Owns its own per-thread
 * expanded state (unresolved default-open, resolved default-closed) so each
 * card collapses independently, mirroring the Conversation block's defaults.
 */
export function DiffThreadAnchor({
  threads,
  onQuote,
  onReply,
  onResolve,
  onEditComment,
  onDeleteComment,
  editHeld,
  editHeldReason,
  pendingWrites,
  provider,
  apply,
  fileDiffLookup,
  mentions,
}: { threads: ReviewThreadOut[] } & DiffThreadWiring) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // A thread resolved elsewhere stays open while it draws an open Reply or
  // comment edit, so the editor and its text survive (a remount of the rows
  // and a hide of the tab included); it takes the resolved default once that
  // editor closes. Both read the editors the card draws: a Reply only while
  // replies are wired, an edit only on a comment the thread still lists. A
  // Reply stays in the open set while replies are withdrawn, so their return
  // re-expands the thread with the Reply and its text, on purpose.
  const holds = (t: ReviewThreadOut, has: (id: string) => boolean) =>
    (onReply !== undefined && has(`reply:${t.id}`)) ||
    t.comments.some((c) => has(`edit:${c.id}`));
  const fold = (t: ReviewThreadOut, has: (id: string) => boolean) =>
    expanded[t.id] ?? (!t.isResolved || holds(t, has));
  const editors = useOpenEditorsHost(
    threads.flatMap((t) => [
      ...(onReply === undefined ? [] : [`reply:${t.id}`]),
      ...t.comments.map((c) => `edit:${c.id}`),
    ]),
    // Only the Reply and edit ids are this anchor's to prune; another
    // editor's id under its provider passes through.
    (id, has) =>
      !/^(?:reply|edit):/.test(id) ||
      threads.some(
        (t) =>
          id === `reply:${t.id}` ||
          (fold(t, has) && t.comments.some((c) => id === `edit:${c.id}`)),
      ),
  );
  const isExpanded = (t: ReviewThreadOut) => fold(t, editors.has);
  return (
    <OpenEditorsContext value={editors}>
      <div className="flex flex-col gap-2">
        {threads.map((t) => (
          <ReviewThreadCard
            key={t.id}
            thread={t}
            compact
            expanded={isExpanded(t)}
            onToggleExpand={() =>
              setExpanded((prev) => ({
                ...prev,
                [t.id]: !(
                  prev[t.id] ??
                  (!t.isResolved || holds(t, editors.has))
                ),
              }))
            }
            onQuote={onQuote}
            onReply={onReply}
            onResolve={onResolve}
            onEditComment={onEditComment}
            onDeleteComment={onDeleteComment}
            editHeld={editHeld}
            editHeldReason={editHeldReason}
            pendingWrites={pendingWrites}
            provider={provider}
            apply={apply}
            fileDiffLookup={fileDiffLookup}
            mentions={mentions}
          />
        ))}
      </div>
    </OpenEditorsContext>
  );
}

/** The "Files" sub-tab: a file list down the left, the selected file's diff on
 *  the right. Presentational — the parent owns the selection + diff query
 *  and the file filter.
 *  Review threads anchored to the selected file render under their exact line. */
export function PrFilesPane({
  filter,
  binaryPaths,
  onSelectPath,
  fileDiff,
  isPending,
  isError,
  isPaused,
  isFetching,
  onRetry,
  dataIsPlaceholder,
  contentRevs,
  revsUnavailable = false,
  revsPaused = false,
  threads,
  drafts,
  repoPath,
  lens,
  number,
  lineWidget,
  onQuote,
  onReply,
  onResolve,
  onEditComment,
  onDeleteComment,
  editHeld,
  editHeldReason,
  pendingWrites,
  provider,
  apply,
  fileDiffLookup,
  mentions,
  blameRev,
}: {
  filter: FileListFilter<PrFile>;
  /** Rows to show as binary (`binaryRowPaths`: 0/0 forge counts over a marker
   *  section); absent/empty = no rows flagged. */
  binaryPaths?: ReadonlySet<string>;
  onSelectPath: (path: string) => void;
  fileDiff: ComponentProps<typeof DiffContent>["data"];
  isPending: boolean;
  isError: boolean;
  isPaused?: boolean;
  /** The diff read has a fetch in flight; over `isError` it hasn't settled. */
  isFetching: boolean;
  onRetry?: () => void;
  dataIsPlaceholder?: boolean;
  /** The pull request's merge base and head, for expand context and image
   *  previews. Absent while unknown or while the diff is another record's. */
  contentRevs?: PrContentRevs;
  /** The revs read for the shown head settled in error with no answer, or the
   *  settled details name no head to read. */
  revsUnavailable?: boolean;
  /** The revs read is parked offline with no answer of its own; a parked
   *  refetch over a kept answer is not this. */
  revsPaused?: boolean;
  /** All PR review threads; the pane anchors those on the selected file. */
  threads?: ReviewThreadOut[];
  /** Pending-review drafts; those on the selected file render as anchored cards
   *  under their line (needs `repoPath`/`lens`/`number` for the edit/delete writes). */
  drafts?: ReviewDraft[];
  repoPath?: string;
  /** The origin|upstream lens the parent PR view resolved — part of the draft
   *  store's key, so the cards can't edit the other lens's same-numbered PR. */
  lens?: RemoteLens;
  number?: number;
  /** The inline line-comment composer, passed straight to the diff. Absent =
   *  a read-only diff (unchanged). */
  lineWidget?: LineWidget;
  /** PR head sha — pins the file-row Blame at the PR's tip. Omit to hide Blame. */
  blameRev?: string;
} & DiffThreadWiring) {
  // Markdown preview reads the file at the PR head, so it's offered only once
  // that commit is a local object (after a Check out PR or a fetch).
  const headPresent = useObjectsPresent(
    repoPath ?? null,
    blameRev ? [blameRev] : [],
  );
  const previewRev =
    repoPath && blameRev && headPresent.data === true ? blameRev : undefined;
  // Whole-file reads come from this clone when it holds both commits, else
  // from the forge by sha; a presence read with no answer gives none. The
  // first answer holds for the pair: forge reads by sha stay valid after a
  // fetch, so a later answer never re-keys them.
  const pairPresent = useObjectsPresent(
    repoPath ?? null,
    contentRevs ? [contentRevs.oldSha, contentRevs.newSha] : [],
  );
  const answered = ((): DiffContentSource | undefined => {
    if (pairPresent.data === undefined || lens === undefined) return undefined;
    return pairPresent.data ? "local" : { lens };
  })();
  const source = useLatchedFor(
    contentRevs && lens !== undefined
      ? `${repoPath ?? ""}\0${lens}\0${contentRevs.oldSha}\0${contentRevs.newSha}`
      : null,
    answered,
  );
  const content: PrFileContent | undefined =
    contentRevs && source !== undefined
      ? { revs: contentRevs, source }
      : undefined;
  // Neither read will answer for this pair until something re-reads it; one
  // still fetching or retrying, or failing over an answer it kept, is not this.
  const pairUnavailable =
    revsUnavailable ||
    (contentRevs !== undefined &&
      pairPresent.isError &&
      !pairPresent.isFetching &&
      pairPresent.data === undefined);
  // Rows still showing another pull request's files pick nothing.
  const pickRow = (path: string) => {
    if (filter.rail.settled) onSelectPath(path);
  };
  // Arrow keys walk the file list, mirroring the app's other diff lists.
  const onFilesKeyDown = listKeyboardNav({
    items: filter.visible,
    activeIndex: filter.activeIndex,
    onActivate: (file) => pickRow(file.path),
    rowKey: (file) => file.path,
    rowAttr: "data-path",
  });

  // The file's diff swaps through the pane's two-slot hold, within this pull
  // request; another one re-targets the shown slot in place.
  const diffEntity = `${lens ?? ""}#${number ?? ""}`;
  const openPath = filter.openPath;
  const diffTarget = openPath
    ? keyedPaneView(repoPath ?? "", diffEntity, openPath, openPath)
    : placeholderPaneView(diffEntity);
  const diffSlots = useFileSlots(diffTarget);

  const fileRows = filter.visible.map((file) => (
    <button
      type="button"
      key={file.path}
      data-path={file.path}
      aria-current={openPath === file.path || undefined}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
        openPath === file.path
          ? "bg-accent text-accent-foreground"
          : "hover:bg-muted/60",
      )}
      onClick={() => pickRow(file.path)}
    >
      <PathText path={file.path} className="flex-1 font-mono" />
      {/* Plain DiffStat, not DiffStatSlot: the binary flag arrives after the diff
          loads, but the forge counts ship with the row, so the cell never starts
          empty — and the sibling detail rails all render the plain form. */}
      <DiffStat
        added={file.additions}
        deleted={file.deletions}
        isBinary={binaryPaths?.has(file.path) ?? false}
      />
    </button>
  ));

  return (
    <DetailRailRow>
      <DetailRail ariaLabel="Changed files" filter={filter.rail}>
        {/* overflow-hidden contains the list's natural height (vendored Root is
            `relative`-only) so a long file list can't leak a window scrollbar. */}
        <ScrollArea className="min-h-0 flex-1 overflow-hidden">
          {repoPath !== undefined ? (
            <FileRowActions
              repoPath={repoPath}
              blameRev={blameRev}
              onKeyDown={onFilesKeyDown}
            >
              {fileRows}
            </FileRowActions>
          ) : (
            <div onKeyDown={onFilesKeyDown}>{fileRows}</div>
          )}
        </ScrollArea>
      </DetailRail>
      <main className="min-w-0 flex-1">
        <FileSlots
          slots={diffSlots}
          target={diffTarget}
          busy={diffSlots.holding || diffSlots.read.loading}
        >
          {(view) =>
            view.kind === "file" ? (
              <PrFileDiffSlot
                path={view.file}
                entity={view.entity}
                fileDiff={fileDiff}
                isPending={isPending}
                isError={isError}
                isPaused={isPaused}
                isFetching={isFetching}
                onRetry={onRetry}
                dataIsPlaceholder={dataIsPlaceholder}
                content={content}
                pairUnavailable={pairUnavailable}
                pairPaused={revsPaused}
                threads={threads}
                drafts={drafts}
                repoPath={repoPath}
                lens={lens}
                number={number}
                previewRev={previewRev}
                anchorCommit={blameRev ?? null}
                lineWidget={lineWidget}
                onQuote={onQuote}
                onReply={onReply}
                onResolve={onResolve}
                onEditComment={onEditComment}
                onDeleteComment={onDeleteComment}
                editHeld={editHeld}
                editHeldReason={editHeldReason}
                pendingWrites={pendingWrites}
                provider={provider}
                apply={apply}
                fileDiffLookup={fileDiffLookup}
                mentions={mentions}
                reportRead={diffSlots.reportRead}
              />
            ) : (
              <DiffPlaceholder message="Select a file to see its changes" />
            )
          }
        </FileSlots>
      </main>
    </DetailRailRow>
  );
}

/** One file's diff in the Files pane's slot: its section of the pull request's
 *  patch, and the threads and drafts anchored to it, so a held file never shows
 *  the next one's. */
function PrFileDiffSlot({
  path,
  entity,
  fileDiff,
  isPending,
  isError,
  isPaused,
  isFetching,
  onRetry,
  dataIsPlaceholder,
  content,
  pairUnavailable,
  pairPaused,
  threads,
  drafts,
  repoPath,
  lens,
  number,
  previewRev,
  anchorCommit,
  lineWidget,
  onQuote,
  onReply,
  onResolve,
  onEditComment,
  onDeleteComment,
  editHeld,
  editHeldReason,
  pendingWrites,
  provider,
  apply,
  fileDiffLookup,
  mentions,
  reportRead,
}: {
  path: string;
  /** The pull request (lens and number) this slot's view belongs to. */
  entity: string;
  /** The parent's diff for ITS selected file; absent with no patch loaded. */
  fileDiff: ComponentProps<typeof DiffContent>["data"];
  isPending: boolean;
  isError: boolean;
  isPaused?: boolean;
  isFetching: boolean;
  onRetry?: () => void;
  dataIsPlaceholder?: boolean;
  /** The pull request's whole-file reads; absent = a hunk-only diff. */
  content?: PrFileContent;
  /** No whole-file reads will come for the current pair (a settled failure). */
  pairUnavailable: boolean;
  /** The read naming the current pair is parked offline with no answer. */
  pairPaused: boolean;
  threads?: ReviewThreadOut[];
  drafts?: ReviewDraft[];
  repoPath?: string;
  lens?: RemoteLens;
  number?: number;
  previewRev?: string;
  /** The pull request's head, gating the binary-size lookups. */
  anchorCommit?: string | null;
  /** The parent's composer, for its selected file: only a shown slot opens it. */
  lineWidget?: LineWidget;
  reportRead: (read: SlotRead) => void;
} & DiffThreadWiring) {
  // The parent builds the diff of its selected file; a held slot's file is
  // another section of the same in-memory patch, or failing a lookup, the diff
  // it showed for this file of this pull request. A slot with no diff of its
  // own shows its read's pending or failed state, never another file's.
  const own =
    fileDiff !== undefined && fileDiff.filePath === path ? fileDiff : undefined;
  const shown = useSlotRetained(
    entity,
    path,
    dataIsPlaceholder ? undefined : own,
  );
  const section =
    fileDiff !== undefined && own === undefined
      ? fileDiffLookup?.(path)
      : undefined;
  const resolved =
    own ??
    (section !== undefined
      ? {
          filePath: path,
          text: section,
          isBinary: sectionIsBinary(section),
          isTruncated: false,
        }
      : shown);
  // A renamed or copied file's old side is read at its source path, whichever
  // branch above supplied the diff.
  const oldPath =
    resolved === undefined ? undefined : sectionOldPath(resolved.text);
  const data =
    resolved === undefined || oldPath === undefined
      ? resolved
      : { ...resolved, oldPath };
  // Under Hide whitespace the slot draws a proven `-w` view of this file, or
  // the forge section under a note; anchors and composers keep the section.
  const [diffRoot, setDiffRoot] = useState<HTMLElement | null>(null);
  const revs = ((): ForgeWhitespaceRevs => {
    if (content)
      return {
        state: "ready",
        oldRev: content.revs.oldSha,
        newRev: content.revs.newSha,
        source: content.source,
      };
    if (pairUnavailable) return { state: "none" };
    if (pairPaused) return { state: "paused" };
    return { state: "pending" };
  })();
  const view = useForgeWhitespaceDiff({
    plain: data,
    placeholder: dataIsPlaceholder ?? false,
    repo: repoPath,
    entity,
    path,
    revs,
    root: diffRoot,
  });
  // A placeholder patch without this file (one only a newer head carries)
  // leaves it waiting on the read, offline while that is parked, until the
  // read fails: never an empty diff.
  const awaiting =
    data === undefined &&
    (dataIsPlaceholder ?? false) &&
    !refreshFailed({ isError, isPaused: isPaused ?? false, isFetching });
  const pending = isPending || awaiting || view.pending;
  useSlotRead(reportRead, {
    isPlaceholderData: dataIsPlaceholder ?? false,
    isPending: pending,
    isPaused,
  });

  // Placements for THIS slot's file only: threads (with a known line, not
  // outdated) AND pending-review drafts on this path, as data. An older head's
  // placeholder keeps the placements of this slot's last own paint, and only
  // while it paints that same text of this pull request and path: a thread can
  // land before the patch of the head it names.
  const livePlacements = JSON.stringify(
    prPlacements(
      path,
      threads,
      repoPath !== undefined && lens !== undefined && number !== undefined
        ? drafts
        : undefined,
    ),
  );
  const text = data?.text;
  const [lastOwn, setLastOwn] = useState<{
    entity: string;
    path: string;
    text: string;
    placements: string;
  } | null>(null);
  if (
    !dataIsPlaceholder &&
    text !== undefined &&
    (lastOwn?.entity !== entity ||
      lastOwn.path !== path ||
      lastOwn.text !== text ||
      lastOwn.placements !== livePlacements)
  )
    setLastOwn({ entity, path, text, placements: livePlacements });
  const placements = !dataIsPlaceholder
    ? livePlacements
    : lastOwn !== null &&
        lastOwn.entity === entity &&
        lastOwn.path === path &&
        lastOwn.text === text
      ? lastOwn.placements
      : "[]";
  // Keyed on the placements' value, so a re-render that moves no placement
  // hands the diff the same list.
  const lineAnchors = useMemo<DiffLineAnchor[]>(
    () =>
      (JSON.parse(placements) as PrPlacement[]).map((p) => ({
        side: p.side,
        line: p.line,
        ids: p.ids,
        items: [
          ...p.threadIds.map((id) => `${THREAD_ITEM}${id}`),
          ...p.draftIds.map((id) => `${DRAFT_ITEM}${id}`),
        ],
      })),
    [placements],
  );
  // Read by the diff on every render, held rows included: items resolve by id
  // against the slot's CURRENT threads (all of them, so a thread that went
  // outdated under an open editor keeps its held row) and drafts.
  const owner =
    repoPath !== undefined && lens !== undefined && number !== undefined
      ? { repoPath, lens, number }
      : undefined;
  // By id, the first of a repeated id.
  const threadById = new Map<string, ReviewThreadOut>();
  for (const t of threads ?? [])
    if (!threadById.has(t.id)) threadById.set(t.id, t);
  const draftById = new Map<string, ReviewDraft>();
  for (const d of drafts ?? [])
    if (!draftById.has(d.id)) draftById.set(d.id, d);
  const renderAnchor = (anchor: DiffLineAnchor) => {
    const rowThreads = anchor.items.flatMap((k) =>
      k.startsWith(THREAD_ITEM)
        ? (threadById.get(k.slice(THREAD_ITEM.length)) ?? [])
        : [],
    );
    const rowDrafts =
      owner === undefined
        ? []
        : anchor.items.flatMap((k) =>
            k.startsWith(DRAFT_ITEM)
              ? (draftById.get(k.slice(DRAFT_ITEM.length)) ?? [])
              : [],
          );
    if (rowThreads.length === 0 && rowDrafts.length === 0) return null;
    return (
      <PrAnchorBody
        threads={rowThreads}
        drafts={rowDrafts}
        owner={owner}
        onQuote={onQuote}
        onReply={onReply}
        onResolve={onResolve}
        onEditComment={onEditComment}
        onDeleteComment={onDeleteComment}
        editHeld={editHeld}
        editHeldReason={editHeldReason}
        pendingWrites={pendingWrites}
        provider={provider}
        apply={apply}
        fileDiffLookup={fileDiffLookup}
        mentions={mentions}
      />
    );
  };

  const widget = useSlotWidget(lineWidget);
  return (
    <div ref={setDiffRoot} className="contents">
      <DiffContent
        filePath={path}
        data={view.data}
        isPending={pending}
        isError={isError}
        isPaused={isPaused}
        isFetching={isFetching}
        onRetry={onRetry}
        dataIsPlaceholder={dataIsPlaceholder}
        repoPath={repoPath}
        previewRev={previewRev}
        contentRevs={
          content
            ? { oldRev: content.revs.oldSha, newRev: content.revs.newSha }
            : undefined
        }
        imageRevs={
          content
            ? { old: content.revs.oldSha, new: content.revs.newSha }
            : undefined
        }
        // From the first paint, so the diff records it as on screen.
        forgePatch={{
          source: content?.source ?? null,
          scope: entity,
          ...(pairUnavailable && { pairUnavailable }),
        }}
        whitespaceControl
        whitespaceNote={view.note}
        typechangeAnchors
        anchorCommit={anchorCommit}
        lineAnchors={lineAnchors}
        renderAnchor={renderAnchor}
        lineWidget={widget}
      />
    </div>
  );
}

/** One anchor row's items, by id: `ids` are the editor keep ids. */
interface PrPlacement {
  side: "old" | "new";
  line: number;
  threadIds: string[];
  draftIds: string[];
  ids: string[];
}

/** Multiple items on the same side+line collapse into ONE placement (the diff
 *  library keeps a single render per side+line, last write wins). `drafts` is
 *  absent while the draft store's owner keys are. */
function prPlacements(
  path: string,
  threads: ReviewThreadOut[] | undefined,
  drafts: ReviewDraft[] | undefined,
): PrPlacement[] {
  const bySideLine = new Map<string, PrPlacement>();
  const at = (side: "old" | "new", line: number) => {
    const key = `${side}:${line}`;
    let p = bySideLine.get(key);
    if (p === undefined) {
      p = { side, line, threadIds: [], draftIds: [], ids: [] };
      bySideLine.set(key, p);
    }
    return p;
  };
  for (const t of threads ?? []) {
    if (t.path !== path || t.line <= 0 || t.isOutdated) continue;
    const p = at(t.side === "old" ? "old" : "new", t.line);
    p.threadIds.push(t.id);
    p.ids.push(`reply:${t.id}`, ...t.comments.map((c) => `edit:${c.id}`));
  }
  const draftIds: { p: PrPlacement; id: string }[] = [];
  for (const d of drafts ?? []) {
    if (d.path !== path || d.line <= 0) continue;
    draftIds.push({ p: at(d.side, d.line), id: d.id });
  }
  // Drafts follow every thread id in a row, as the editor keep lists them.
  for (const { p, id } of draftIds) {
    p.draftIds.push(id);
    p.ids.push(`draft:${id}`);
  }
  return [...bySideLine.values()];
}

/** Item-id prefixes in a Files anchor's `items`. */
const THREAD_ITEM = "thread:";
const DRAFT_ITEM = "draft:";

/** An anchor row's cards, from items already resolved against the slot's
 *  current threads and drafts. `owner` is the draft store's key, absent while
 *  any part of it is. */
function PrAnchorBody({
  threads,
  drafts,
  owner,
  ...wiring
}: {
  threads: ReviewThreadOut[];
  drafts: ReviewDraft[];
  owner?: { repoPath: string; lens: RemoteLens; number: number };
} & DiffThreadWiring) {
  return (
    <div className="flex flex-col gap-2">
      {threads.length > 0 && <DiffThreadAnchor threads={threads} {...wiring} />}
      {owner !== undefined &&
        drafts.map((d) => (
          <DraftCommentCard
            key={d.id}
            repoPath={owner.repoPath}
            lens={owner.lens}
            number={owner.number}
            draft={d}
          />
        ))}
    </div>
  );
}

/**
 * The GitLab-only MR time-tracking summary for the header meta area: a compact
 * "Xh est · Ym spent" (zero parts omitted). For an OPEN MR it's a popover
 * trigger wrapping the same estimate/add-spent controls as the issue rail; for a
 * closed/merged MR it's a static line, and it renders nothing at all when there's
 * no time to show. GitHub is zero-diff — the caller only mounts this behind the
 * `timeTracking` flag.
 */
export function MrTimeTracking({
  repoPath,
  number,
  open,
  disabledReason,
  held = false,
}: {
  repoPath: string;
  number: number;
  /** Whether the MR is open — only then are the editing controls offered. */
  open: boolean;
  /** Set when the viewer lacks the access these edits need: the estimate and
   *  spent controls disable, with this text as their hint. The summary is a
   *  read and stays live. */
  disabledReason?: string;
  /** The view is holding this MR while another loads behind it. The view's
   *  `inert` can't reach the portaled popover, so this shuts it, and the writes
   *  refuse until the hold ends. */
  held?: boolean;
}) {
  const stats = useGlMrTimeStats(repoPath, number);
  const setEstimate = useSetMrTimeEstimate(repoPath);
  const addSpent = useAddMrSpentTime(repoPath);
  const [popoverOpen, setPopoverOpen] = useState(false);
  if (held && popoverOpen) setPopoverOpen(false);

  const data = stats.data;
  const humanEstimate = data?.humanTimeEstimate ?? "";
  const humanSpent = data?.humanTotalTimeSpent ?? "";
  const hasAny =
    (data?.timeEstimate ?? 0) > 0 || (data?.totalTimeSpent ?? 0) > 0;

  // Nothing to show and the MR is closed → render nothing (GitHub also lands
  // here via `hasAny` staying false, but the caller already gates on the flag).
  if (!hasAny && !open) return null;

  const summary = (
    <span className="flex items-center gap-1">
      <ClockIcon className="size-3 shrink-0" aria-hidden />
      {hasAny
        ? [
            humanEstimate ? `${humanEstimate} est` : null,
            humanSpent ? `${humanSpent} spent` : null,
          ]
            .filter(Boolean)
            .join(" · ")
        : "Track time"}
    </span>
  );

  // Closed MR: a static, non-interactive summary.
  if (!open) {
    return (
      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
        {summary}
      </span>
    );
  }

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="text-muted-foreground"
            aria-label="Time tracking"
          />
        }
      >
        {summary}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <p className="text-xs font-medium text-muted-foreground">
          Time tracking
        </p>
        {stats.isPending ? (
          <p className="text-[11px] text-muted-foreground">Loading…</p>
        ) : (
          <TimeTrackingControls
            stats={data}
            editable
            pending={setEstimate.isPending || addSpent.isPending}
            disabledReason={disabledReason}
            idPrefix="mr"
            onSetEstimate={(duration) => {
              if (!held) setEstimate.mutate({ number, duration });
            }}
            onAddSpent={(duration) => {
              if (!held) addSpent.mutate({ number, duration });
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
