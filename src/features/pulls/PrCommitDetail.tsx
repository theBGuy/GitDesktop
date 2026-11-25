import { CopyIcon } from "@phosphor-icons/react";
import {
  type ComponentProps,
  useDeferredValue,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DetailRail,
  DetailRailFilterStatus,
  DetailRailRow,
} from "@/components/detail-rail";
import { DiffStat } from "@/components/diff-stat";
import { PathText } from "@/components/path-text";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  FILE_FILTER_SURFACES,
  useFileListFilter,
} from "@/components/use-file-list-filter";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  detailNoticeMessage,
  offlinePendingMessage,
  refreshFailed,
  resolveDetailPane,
} from "@/features/conversations/remote-section-state";
import {
  type DiffContentSource,
  useLatchedFor,
} from "@/features/diff/content-source";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiffContent, type LineWidget } from "@/features/diff/DiffSurfaceLazy";
import {
  FileSlots,
  keyedPaneView,
  placeholderPaneView,
  type SlotRead,
  useFileSlots,
  usePaintedView,
  useSlotRead,
  useSlotWidget,
} from "@/features/diff/file-slot";
import {
  type ForgeWhitespaceRevs,
  useForgeWhitespaceDiff,
} from "@/features/diff/use-forge-whitespace-diff";
import { FileRowActions } from "@/features/history/FileRowActions";
import { copyText } from "@/lib/clipboard";
import { presentError } from "@/lib/error-summary";
import {
  sectionIsBinary,
  sectionOldPath,
  splitUnifiedDiff,
} from "@/lib/git/diff-split";
import {
  useCommitComments,
  useCommitFirstParent,
  useCommitParents,
  useCommitRecordsParent,
  useObjectsPresent,
  usePrCommitDiff,
} from "@/lib/git/queries";
import type {
  CommitCommentOut,
  FileDiff,
  PrCommitOut,
  RemoteLens,
} from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useHideWhitespace } from "@/lib/settings/hide-whitespace";
import { useUiStore } from "@/lib/stores/ui";
import { parseableDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  CommitComments,
  CommitLineComposer,
  type DiffSections,
  useCommentPins,
  useCommitLineAnchors,
} from "./CommitComments";

type DiffProps = ComponentProps<typeof DiffContent>;

/** A commit's whole-file reads: its revs, where they're read from, and the
 *  image pair (absent for a root commit read from the forge). */
interface CommitFileContent {
  revs: NonNullable<DiffProps["contentRevs"]>;
  images?: NonNullable<DiffProps["imageRevs"]>;
  source: DiffContentSource;
}

interface PrCommitDetailProps {
  repoPath: string;
  /** PR number. */
  number: number;
  commit: PrCommitOut;
  onBack: () => void;
  canCommentCommits: boolean;
  /** "GitHub" | "GitLab" | "Bitbucket" — for provider-named copy. */
  remoteLabel: string;
  /** The forge provider, for the line-comment composer's anchoring (GitHub needs
   *  a diff `position`; GitLab/Bitbucket anchor by line). Defaults to "github". */
  provider?: "github" | "gitlab" | "bitbucket";
  /** The origin|upstream lens the parent PR view resolved. */
  lens: RemoteLens;
}

/** Adds/deletions in one file's unified-diff section (its `+`/`-` body lines,
 *  excluding the `+++`/`---` file headers). */
function countChanges(section: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of section.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) deleted += 1;
  }
  return { added, deleted };
}

/**
 * The remote commit-detail surface for a PR's Commits tab drill-in: subject +
 * full message body, a changed-file sidebar with arrow-key nav, the selected
 * file's diff (with any line-anchored commit comments rendered inline), and the
 * whole-commit comment thread + composer. Read-only on the commit itself — a
 * remote commit may not exist locally, so no amend/checkout/revert/cherry-pick.
 *
 * The parent (P5) wires this into the PR view; it never touches those files.
 */
export function PrCommitDetail({
  repoPath,
  number,
  commit,
  onBack,
  canCommentCommits,
  remoteLabel,
  provider = "github",
  lens,
}: PrCommitDetailProps) {
  const diff = usePrCommitDiff(repoPath, number, commit.oid, lens);
  const comments = useCommitComments(repoPath, commit.oid, lens);
  // Markdown preview reads the file at this commit, so it's offered only once
  // the commit is a local object (after a Check out PR or a fetch).
  const commitPresent = useObjectsPresent(repoPath, [commit.oid]);
  // A local commit's parents as this clone resolves them. None is a root, or
  // a shallow clone's boundary, whose parent the graft hides; the raw header
  // tells the two apart.
  const localParents = useCommitParents(
    repoPath,
    commitPresent.data === true ? commit.oid : null,
  );
  const parentless = localParents.data?.length === 0;
  const recordsParent = useCommitRecordsParent(
    repoPath,
    commit.oid,
    parentless,
  );
  // The local reader takes a missing ancestor for an absent file, so a local
  // commit whose first parent doesn't resolve here (a shallow boundary, or a
  // failed parent read) takes its pair from the forge, like one not here.
  const parentElsewhere =
    commitPresent.data === true &&
    (localParents.isError ||
      (parentless && !recordsParent.isPending && recordsParent.data !== false));
  const takesForgeParent = commitPresent.data === false || parentElsewhere;
  const forgeParent = useCommitFirstParent(
    repoPath,
    lens,
    commit.oid,
    takesForgeParent,
  );
  // The forge's parent can still be a local object (fetched past the graft).
  const parentPresent = useObjectsPresent(
    repoPath,
    parentElsewhere && forgeParent.data ? [forgeParent.data] : [],
  );
  // Whole-file reads at the first parent and the commit: this clone's objects
  // when it holds both (a local root's old side reads as absent), else the
  // forge. A root commit read from the forge has no old side, so its images
  // keep the placeholder (null = working tree). The first answer holds for the
  // commit: forge reads by sha stay valid after a fetch, and a failed refetch
  // keeps what it had.
  const answered = ((): CommitFileContent | undefined => {
    if (commitPresent.data === undefined) return undefined;
    if (commitPresent.data && !parentElsewhere) {
      if (localParents.data === undefined) return undefined;
      if (parentless && recordsParent.data === undefined) return undefined;
      const parent = `${commit.oid}~1`;
      return {
        revs: { oldRev: parent, newRev: commit.oid },
        images: { old: parent, new: commit.oid },
        source: "local",
      };
    }
    const parent = forgeParent.data;
    if (parent === undefined) return undefined;
    if (parent === null)
      return { revs: { newRev: commit.oid }, source: { lens } };
    if (commitPresent.data && parentPresent.isPending) return undefined;
    return {
      revs: { oldRev: parent, newRev: commit.oid },
      images: { old: parent, new: commit.oid },
      source: parentPresent.data === true ? "local" : { lens },
    };
  })();
  const content = useLatchedFor(`${lens}\0${commit.oid}`, answered);
  // No pair will come until something re-reads the read the latch waits on:
  // it settled in error with no answer. The forge's parent is the one forge
  // read among them, so only it parks offline.
  const settledEmpty = (q: {
    isError: boolean;
    isFetching: boolean;
    data: unknown;
  }) => q.isError && !q.isFetching && q.data === undefined;
  const contentUnavailable =
    content === undefined &&
    (settledEmpty(commitPresent) ||
      (takesForgeParent && settledEmpty(forgeParent)));
  const contentPaused =
    content === undefined &&
    takesForgeParent &&
    forgeParent.isPaused &&
    forgeParent.data === undefined;

  const sections = useMemo(
    () => splitUnifiedDiff(diff.data ?? "", { joinTypechanges: true }),
    [diff.data],
  );
  const files = useMemo(
    () =>
      [...sections.entries()].map(([path, section]) => ({
        path,
        section,
        ...countChanges(section),
        isBinary: sectionIsBinary(section),
      })),
    [sections],
  );

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // A user file pick, noted first so a pending continuation (a markdown
  // `#N` lookup) strands; the automatic selections stay silent.
  const pickPath = (path: string) => {
    useUiStore.getState().noteUserInteraction();
    setSelectedPath(path);
  };
  const openPathRef = useRef<string | null>(null);
  // Through the filter, only a pick that moves the open file (as last committed)
  // is noted: its pin before a text edit keeps it, and a draft moves no epoch.
  const filter = useFileListFilter({
    ...FILE_FILTER_SURFACES["pr-commits"],
    files,
    settled: diff.data !== undefined,
    picked: selectedPath,
    onPick: (path) => {
      if (path !== openPathRef.current)
        useUiStore.getState().noteUserInteraction();
      setSelectedPath(path);
    },
  });
  useLayoutEffect(() => {
    openPathRef.current = filter.openPath;
  }, [filter.openPath]);
  // The user's pick, else the first match under a filter, else the first file
  // (derived, so there's no empty-selection frame while an effect catches up).
  const effectivePath = filter.openPath;
  // The file's diff swaps through the pane's two-slot hold, within this
  // commit; another one re-targets the shown slot in place.
  const diffTarget = effectivePath
    ? keyedPaneView(repoPath, commit.oid, effectivePath, effectivePath)
    : placeholderPaneView(commit.oid);
  const diffSlots = useFileSlots(diffTarget);
  // What the visible slot has mounted. The comment list judges by it, not by
  // the pick: while the next file prepares behind a held one, the held file
  // is the one on screen.
  const painted = usePaintedView(diffSlots);
  const listPath = painted?.path ?? null;
  // Open list edits: kept out of the pane's anchors and in the list.
  const pins = useCommentPins();
  // The painted file's forge section is the whitespace-shown diff: the
  // comment list reads it instead of a local read a non-local commit fails.
  const selectedPlain = useMemo<FileDiff | undefined>(() => {
    const section = listPath === null ? undefined : sections.get(listPath);
    return listPath === null || section === undefined
      ? undefined
      : {
          filePath: listPath,
          text: section,
          isBinary: sectionIsBinary(section),
          isTruncated: false,
        };
  }, [listPath, sections]);

  const onFilesKeyDown = listKeyboardNav({
    items: filter.visible,
    activeIndex: filter.activeIndex,
    onActivate: (f) => pickPath(f.path),
    rowKey: (f) => f.path,
    rowAttr: "data-path",
  });

  // A failed or parked refresh keeps the loaded commit under a notice; only a
  // read with nothing loaded replaces the rail and pane.
  const pane = resolveDetailPane({
    pending: diff.isPending,
    error: diff.isError,
    hasData: diff.data !== undefined,
    paused: diff.isPaused,
    fetching: diff.isFetching,
  });
  const failed = refreshFailed(diff);
  // The root survives every arm, so a Retry that swaps the error arm for the
  // skeleton lands focus there instead of on <body>.
  const { hostRef, retryRef } = useRetryFocusRescue(
    pane === "error" && diff.isError,
  );
  // Degraded content is the same arm, so a failed or recovered refresh never
  // moves focus.
  const arm = pane === "content-degraded" ? "content" : pane;
  // An arm swap or record switch that unmounts the focused node would drop
  // focus to <body>; land it on the host. Change-only, so a mount never takes
  // focus from elsewhere.
  const focusHost = useRef<HTMLDivElement | null>(null);
  const viewFrame = `${arm}:${commit.oid}`;
  const lastViewFrame = useRef(viewFrame);
  useLayoutEffect(() => {
    if (lastViewFrame.current === viewFrame) return;
    lastViewFrame.current = viewFrame;
    if (document.activeElement === document.body)
      focusHost.current?.focus({ preventScroll: true });
  }, [viewFrame]);

  return (
    <div
      ref={(node) => {
        hostRef(node);
        focusHost.current = node;
      }}
      tabIndex={-1}
      className="flex min-h-0 flex-1 flex-col outline-none"
    >
      <DetailRailFilterStatus filter={filter.rail} blank={pane === "error"} />
      <header className="space-y-1 border-b px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label="Back to commits"
          className="-ml-2 h-7 text-muted-foreground hover:text-foreground"
        >
          ‹ Commits
        </Button>
        {/* Two lines at most, scrolling past that like the message body below,
            so a long subject never squeezes out the diff; a tab stop, so a
            keyboard can scroll it too. */}
        <h2
          tabIndex={0}
          className="max-h-10 overflow-y-auto text-sm font-medium break-words outline-none focus-visible:ring-1 focus-visible:ring-ring/50"
        >
          {commit.headline}
        </h2>
        {commit.messageBody && (
          <pre className="max-h-24 overflow-y-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
            {commit.messageBody}
          </pre>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex size-4 items-center justify-center rounded-full bg-muted text-[9px] uppercase">
            {commit.author.slice(0, 1)}
          </span>
          <span>{commit.author}</span>
          {/* Separator and date are one unit: an unparseable date renders
              nothing, and a lone bullet would dangle beside it. */}
          {parseableDate(commit.date) && (
            <>
              <span>•</span>
              <span>
                <RelativeTime date={commit.date} />
              </span>
            </>
          )}
          <span>•</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-mono hover:text-foreground"
            onClick={() => copyText(commit.oid, "SHA copied")}
            title="Copy full SHA"
          >
            {commit.oid.slice(0, 7)}
            <CopyIcon className="size-3" />
          </button>
        </div>
      </header>

      {(() => {
        switch (pane) {
          case "skeleton":
            return (
              <div className="space-y-3 p-4">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-32 w-full" />
              </div>
            );
          case "offline":
            return (
              <DiffPlaceholder
                message={offlinePendingMessage("this commit's changes")}
              />
            );
          case "error":
            return (
              <DiffPlaceholder
                message="Could not load this commit's changes"
                action={
                  diff.isError ? (
                    <div className="flex flex-col items-center gap-2">
                      <p className="max-w-md text-center text-xs">
                        {presentError(diff.error).summary}
                      </p>
                      <Button
                        ref={retryRef}
                        variant="outline"
                        size="sm"
                        className="cursor-pointer"
                        onClick={() => void diff.refetch()}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : undefined
                }
              />
            );
          case "content":
          case "content-degraded":
            return (
              <>
                <DegradedListNotice
                  noun="this commit's changes"
                  degraded={pane === "content-degraded"}
                  // The diff is keyed on this commit alone and serves no
                  // placeholder, so the retained patch is always its own.
                  message={detailNoticeMessage({
                    noun: "commit's changes",
                    isError: failed,
                    stale: false,
                  })}
                  onRetry={failed ? () => void diff.refetch() : undefined}
                  className="shrink-0 border-b px-4 py-1.5"
                />
                <DetailRailRow>
                  <DetailRail ariaLabel="Changed files" filter={filter.rail}>
                    {/* overflow-hidden contains the list's natural height (vendored Root
                        is `relative`-only) so a long file list can't leak a window scrollbar. */}
                    <ScrollArea className="min-h-0 flex-1 overflow-hidden">
                      <FileRowActions
                        repoPath={repoPath}
                        blameRev={commit.oid}
                        onKeyDown={onFilesKeyDown}
                      >
                        {filter.visible.map((file) => (
                          <button
                            type="button"
                            key={file.path}
                            data-path={file.path}
                            aria-current={
                              effectivePath === file.path || undefined
                            }
                            className={cn(
                              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                              effectivePath === file.path
                                ? "bg-accent text-accent-foreground"
                                : "hover:bg-muted/60",
                            )}
                            onClick={() => pickPath(file.path)}
                          >
                            <PathText
                              path={file.path}
                              className="flex-1 font-mono"
                            />
                            <DiffStat
                              added={file.added}
                              deleted={file.deleted}
                              isBinary={file.isBinary}
                            />
                          </button>
                        ))}
                      </FileRowActions>
                    </ScrollArea>
                  </DetailRail>
                  {/* Scrolls only when the window is too short for the diff's
                      floor plus the comments: the comments' composer never
                      shrinks, so without it the composer spills under the
                      PR footer and the diff collapses to a sliver. */}
                  <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
                    <div className="min-h-40 flex-1">
                      <FileSlots
                        slots={diffSlots}
                        target={diffTarget}
                        busy={diffSlots.holding || diffSlots.read.loading}
                      >
                        {(view) =>
                          view.kind === "file" ? (
                            <PrCommitFileDiffSlot
                              repoPath={repoPath}
                              sha={commit.oid}
                              path={view.file}
                              sections={sections}
                              comments={comments.data}
                              canComment={canCommentCommits}
                              provider={provider}
                              lens={lens}
                              previewRev={
                                commitPresent.data === true
                                  ? commit.oid
                                  : undefined
                              }
                              content={content}
                              contentUnavailable={contentUnavailable}
                              contentPaused={contentPaused}
                              pinned={pins.pinned}
                              reportRead={diffSlots.reportRead}
                            />
                          ) : (
                            <DiffPlaceholder message="No file changes in this commit" />
                          )
                        }
                      </FileSlots>
                    </div>
                    <CommitComments
                      repoPath={repoPath}
                      sha={commit.oid}
                      canComment={canCommentCommits}
                      remoteLabel={remoteLabel}
                      diffSections={sections}
                      // A failed refresh keeps this commit's own patch, which
                      // still resolves.
                      diffReady={diff.data !== undefined}
                      painted={painted}
                      pins={pins}
                      onSelectFile={pickPath}
                      lens={lens}
                      whitespaceShownDiff={selectedPlain}
                      hostScrolls
                    />
                  </main>
                </DetailRailRow>
              </>
            );
        }
      })()}
    </div>
  );
}

/** One file's diff in the commit's pane slot: its section of the commit's
 *  patch, with the comments anchored to it and its own line composer, so a
 *  held file never shows the next one's. */
function PrCommitFileDiffSlot({
  repoPath,
  sha,
  path,
  sections,
  comments,
  canComment,
  provider,
  lens,
  previewRev,
  content,
  contentUnavailable,
  contentPaused,
  pinned,
  reportRead,
}: {
  repoPath: string;
  sha: string;
  path: string;
  sections: DiffSections;
  comments: CommitCommentOut[] | undefined;
  canComment: boolean;
  provider: "github" | "gitlab" | "bitbucket";
  lens: RemoteLens;
  previewRev: string | undefined;
  /** The commit's whole-file reads; absent = a hunk-only diff. */
  content: CommitFileContent | undefined;
  /** No whole-file reads will come for this commit (a settled failure). */
  contentUnavailable: boolean;
  /** The forge read naming the pair is parked offline with no answer. */
  contentPaused: boolean;
  /** The host's open list edits, which draw no anchor here. */
  pinned: ReadonlySet<string>;
  reportRead: (read: SlotRead) => void;
}) {
  const section = sections.get(path);
  const plain =
    section === undefined
      ? undefined
      : {
          filePath: path,
          text: section,
          isBinary: sectionIsBinary(section),
          isTruncated: false,
          oldPath: sectionOldPath(section),
        };
  // Under Hide whitespace the slot draws a proven `-w` view of this file, or
  // the section under a note; anchors and the composer keep the section.
  const [diffRoot, setDiffRoot] = useState<HTMLElement | null>(null);
  const revs = ((): ForgeWhitespaceRevs => {
    // This host's revs are shas (a root commit has no old one), never the
    // working tree a null rev names.
    const newRev = content?.revs.newRev;
    if (content && typeof newRev === "string")
      return {
        state: "ready",
        oldRev: content.revs.oldRev ?? undefined,
        newRev,
        source: content.source,
      };
    if (contentUnavailable) return { state: "none" };
    if (contentPaused) return { state: "paused" };
    return { state: "pending" };
  })();
  const view = useForgeWhitespaceDiff({
    plain,
    placeholder: false,
    repo: repoPath,
    entity: `${lens}\0${sha}`,
    path,
    revs,
    root: diffRoot,
  });
  // The diff builds its rows off a deferred copy of its text, so the slot
  // paints one deferred copy of the view.
  // The content and image revs, anchorCommit and the line widget stay live:
  // a mounted drill-in never changes commit (each pick remounts it).
  const deferredData = useDeferredValue(view.data);
  const deferredPending = useDeferredValue(view.pending);
  const deferredNote = useDeferredValue(view.note);
  const deferredSha = useDeferredValue(sha);
  // While the deferred copy still holds a whitespace-only view with the mode
  // off, the slot takes the live view whole, so a flip off leaves that arm in
  // the same commit (an open editor's held view is live too, and stays).
  const hide = useHideWhitespace();
  const modeStale = !hide && deferredData?.whitespaceOnly === true;
  const shownData = modeStale ? view.data : deferredData;
  const shownPending = modeStale ? view.pending : deferredPending;
  const shownNote = modeStale ? view.note : deferredNote;
  const shownSha = modeStale ? sha : deferredSha;
  // The patch is in memory, never a placeholder: only the view can pend.
  useSlotRead(reportRead, {
    isPlaceholderData: false,
    isPending: shownPending,
  });
  // Line-anchored comments on this file that resolve to a new-side line
  // render inline wherever their row mounts (an expanded gap's included); the
  // list below takes the rest from the pane's painted report. Grouping +
  // range chips live in the shared hook.
  const lineAnchors = useCommitLineAnchors(
    comments,
    sections,
    path,
    { provider, repoPath, lens },
    pinned,
  );
  // Line-anchored comment creation: when the viewer can comment, clicking a diff
  // line opens the inline composer below it. Anchored to this file's section
  // (GitHub recovers the diff `position` from it). Absent otherwise, so the diff
  // stays read-only exactly as before.
  const widget = useMemo<LineWidget | undefined>(() => {
    if (!canComment) return undefined;
    return {
      enabled: true,
      render: ({ side, line, fromLine, onClose }) => (
        <CommitLineComposer
          repoPath={repoPath}
          sha={sha}
          path={path}
          side={side}
          line={line}
          fromLine={fromLine}
          provider={provider}
          fileSection={sections.get(path)}
          onClose={onClose}
          lens={lens}
          patchOnly
        />
      ),
    };
  }, [canComment, path, repoPath, sha, provider, sections, lens]);
  const lineWidget = useSlotWidget(widget);
  return (
    <div ref={setDiffRoot} className="contents">
      <DiffContent
        filePath={path}
        data={shownData}
        isPending={shownPending}
        isError={false}
        repoPath={repoPath}
        previewRev={previewRev}
        contentRevs={content?.revs}
        imageRevs={content?.images}
        // From the first paint, so the diff records it as on screen.
        forgePatch={{
          source: content?.source ?? null,
          scope: `${lens}\0${shownSha}`,
        }}
        whitespaceControl
        whitespaceNote={shownNote}
        typechangeAnchors
        anchorCommit={sha}
        lineAnchors={lineAnchors}
        lineWidget={lineWidget}
      />
    </div>
  );
}
