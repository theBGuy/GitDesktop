import {
  type ReactNode,
  useDeferredValue,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { DetailRail, DetailRailRow } from "@/components/detail-rail";
import { DiffStat } from "@/components/diff-stat";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  detailNoticeMessage,
  refreshFailed,
  resolveDetailPane,
} from "@/features/conversations/remote-section-state";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiffSurface } from "@/features/diff/DiffSurfaceLazy";
import {
  FileSlots,
  keyedPaneView,
  placeholderPaneView,
  type SlotRead,
  useFileSlots,
  useSlotRead,
} from "@/features/diff/file-slot";
import { FileRowActions } from "@/features/history/FileRowActions";
import { clipTitleFromText } from "@/lib/clip-title";
import { presentError } from "@/lib/error-summary";
import {
  useBranchDiffFiles,
  useBranchFileDiff,
  useMergeBase,
} from "@/lib/git/queries";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { cn, PLACEHOLDER_FADE } from "@/lib/utils";

/**
 * The net change `compare` introduces relative to `base` (the three-dot diff,
 * what a PR would show): a changed-file list plus the selected file's diff.
 */
export function BranchDiffView({
  repoPath,
  base,
  compare,
}: {
  repoPath: string;
  base: string;
  compare: string;
}) {
  const files = useBranchDiffFiles(repoPath, base, compare);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Reset the manual selection when the comparison changes — a render-time
  // state adjustment, not an effect.
  // ".." can't appear inside a valid ref name, so the key is unambiguous.
  const cmpKey = `${base}..${compare}`;
  const [lastKey, setLastKey] = useState(cmpKey);
  if (cmpKey !== lastKey) {
    setLastKey(cmpKey);
    setSelectedPath(null);
  }
  // Default to the first changed file until the user picks one.
  const effectivePath =
    selectedPath && files.data?.some((f) => f.path === selectedPath)
      ? selectedPath
      : (files.data?.[0]?.path ?? null);
  // Diff off a deferred path so rapidly arrowing the file list only fetches +
  // renders the landed-on file; the highlight stays on effectivePath.
  const deferredPath = useDeferredValue(effectivePath);
  // Fetch only once the path is one this comparison actually changed. The path
  // comes FROM the file list, so it belongs to the previous comparison both while
  // that list is a placeholder AND for the deferred frame after it settles — and a
  // fetch there "succeeds" with an empty diff, flashing "No changes to show".
  // Per slot path: a held slot's read stays enabled while the current list
  // still names its file (a tip move can refetch the list mid-hold).
  const diffEnabledFor = (path: string) =>
    !files.isPlaceholderData &&
    (files.data?.some((f) => f.path === path) ?? false);
  // The file's diff swaps through the pane's two-slot hold, within this
  // comparison; another one re-targets the shown slot in place.
  const diffTarget = deferredPath
    ? keyedPaneView(repoPath, cmpKey, deferredPath, deferredPath)
    : placeholderPaneView(cmpKey);
  const diffSlots = useFileSlots(diffTarget);
  // The diff is three-dot, so its old side is the fork point, not `base`'s tip.
  // The new side, and Blame, read at `compareRev`, the rev the backend resolved
  // `compare` to: the bare name would read a same-named tag's files instead. The
  // query's own placeholder flag proves both revs belong to this (base, compare);
  // the converse — a stale DIFF paired with fresh revs — is DiffContent's refusal
  // via `dataIsPlaceholder`.
  const mergeBase = useMergeBase(repoPath, base, compare);
  const sides =
    mergeBase.data !== undefined && !mergeBase.isPlaceholderData
      ? mergeBase.data
      : null;

  // A failed refresh keeps the loaded comparison under a notice; only a read
  // with nothing loaded replaces the pane.
  const pane = resolveDetailPane({
    pending: files.isPending,
    error: files.isError,
    hasData: files.data !== undefined,
    paused: files.isPaused,
    fetching: files.isFetching,
  });
  const failed = refreshFailed(files);
  // Retry resets the read to pending, swapping the error arm for the skeleton;
  // every arm renders in the same host div, so focus lands there.
  const { hostRef, retryRef } = useRetryFocusRescue(
    pane === "error" && files.isError,
  );
  // Degraded content is the same arm, so a failed or recovered refresh never
  // moves focus.
  const arm = pane === "content-degraded" ? "content" : pane;
  // An arm swap or record switch that unmounts the focused node would drop
  // focus to <body>; land it on the host. Change-only, so a mount never takes
  // focus from elsewhere.
  const focusHost = useRef<HTMLDivElement | null>(null);
  const viewFrame = `${arm}:${cmpKey}`;
  const lastViewFrame = useRef(viewFrame);
  useLayoutEffect(() => {
    if (lastViewFrame.current === viewFrame) return;
    lastViewFrame.current = viewFrame;
    if (document.activeElement === document.body)
      focusHost.current?.focus({ preventScroll: true });
  }, [viewFrame]);
  const shell = (content: ReactNode) => (
    <div
      ref={(node) => {
        hostRef(node);
        focusHost.current = node;
      }}
      tabIndex={-1}
      className="flex h-full flex-col outline-none"
    >
      {content}
    </div>
  );

  // A placeholder list is the PREVIOUS comparison's, so an empty one says nothing
  // about this pair — hold the skeleton rather than claim "no changes" below.
  // The read is local, so it never parks offline: that arm loads too.
  if (
    pane === "skeleton" ||
    pane === "offline" ||
    (files.isPlaceholderData && files.data?.length === 0)
  ) {
    return shell(
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>,
    );
  }
  if (pane === "error" || !files.data) {
    return shell(
      <DiffPlaceholder
        message="Could not compare these branches"
        action={
          files.isError ? (
            <div className="flex flex-col items-center gap-2">
              <p className="max-w-md text-center text-xs">
                {presentError(files.error).summary}
              </p>
              <Button
                ref={retryRef}
                variant="outline"
                size="sm"
                className="cursor-pointer"
                onClick={() => void files.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : undefined
        }
      />,
    );
  }
  // Mounted in every content render: its live region announces only text that
  // arrives after it is in the DOM.
  const notice = (
    <DegradedListNotice
      noun="this comparison"
      degraded={pane === "content-degraded"}
      message={detailNoticeMessage({
        noun: "comparison",
        isError: failed,
        stale: files.isPlaceholderData,
      })}
      onRetry={failed ? () => void files.refetch() : undefined}
      className="shrink-0 border-b px-4 py-1.5"
    />
  );
  if (files.data.length === 0) {
    return shell(
      <>
        {notice}
        <DiffPlaceholder
          message={`${compare} has no changes relative to ${base}`}
        />
      </>,
    );
  }

  const totalAdded = files.data.reduce((sum, f) => sum + f.added, 0);
  const totalDeleted = files.data.reduce((sum, f) => sum + f.deleted, 0);
  // The counts, totals and file list belong to the PREVIOUS comparison until the
  // selected one lands; fade them. The branch names are props — always current.
  const staleDim = files.isPlaceholderData && "opacity-80";
  // The diff pane serves the previous file's diff for longer than the rest (its
  // query stays on placeholder data through the gated window above), so it fades
  // on its own state, and never over a held slot, which carries its own dim:
  // 0.8² reads as disabled.
  const diffDim =
    !diffSlots.holding &&
    (staleDim || diffSlots.read.placeholder) &&
    "opacity-80";
  // Busy through a hold too, and through the blank a slow file promotes into.
  const diffBusy =
    Boolean(diffDim) || diffSlots.holding || diffSlots.read.loading;

  // Arrow keys walk the file list, mirroring the app's other lists.
  const onFilesKeyDown = listKeyboardNav({
    items: files.data ?? [],
    activeIndex: (files.data ?? []).findIndex((f) => f.path === effectivePath),
    onActivate: (file) => setSelectedPath(file.path),
    rowKey: (file) => file.path,
    rowAttr: "data-path",
  });

  return shell(
    <div className="flex h-full flex-col" aria-busy={Boolean(staleDim)}>
      <header className="flex items-center gap-2 border-b px-4 py-3 text-xs">
        {/* Branch names are unbreakable tokens — without the clamp a long pair
            sets the whole view's minimum width. */}
        <span
          className="min-w-0 truncate font-medium"
          onMouseEnter={clipTitleFromText}
        >
          <span className="font-mono">{compare}</span> vs{" "}
          <span className="font-mono">{base}</span>
        </span>
        <span className="flex-1" />
        <span
          className={cn("text-muted-foreground", PLACEHOLDER_FADE, staleDim)}
        >
          {files.data.length} file{files.data.length === 1 ? "" : "s"}
        </span>
        <DiffStat
          added={totalAdded}
          deleted={totalDeleted}
          className={cn("flex items-center gap-2", PLACEHOLDER_FADE, staleDim)}
        />
      </header>

      {notice}
      <DetailRailRow>
        <DetailRail
          className={cn(PLACEHOLDER_FADE, staleDim)}
          role="listbox"
          ariaLabel="Changed files"
        >
          {/* overflow-hidden contains the list's natural height (vendored Root is
              `relative`-only) so a long list can't leak a window scrollbar. */}
          <ScrollArea className="min-h-0 flex-1 overflow-hidden">
            <FileRowActions
              repoPath={repoPath}
              blameRev={sides?.compareRev}
              onKeyDown={onFilesKeyDown}
            >
              {files.data.map((file) => (
                <button
                  type="button"
                  key={file.path}
                  data-path={file.path}
                  role="option"
                  aria-selected={effectivePath === file.path}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                    effectivePath === file.path
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60",
                  )}
                  onClick={() => setSelectedPath(file.path)}
                >
                  <PathText path={file.path} className="flex-1 font-mono" />
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
        <main
          aria-busy={diffBusy}
          className={cn("min-w-0 flex-1", PLACEHOLDER_FADE, diffDim)}
        >
          <FileSlots slots={diffSlots} target={diffTarget}>
            {(view) =>
              view.kind === "file" ? (
                <BranchFileDiffSlot
                  repoPath={repoPath}
                  base={base}
                  compare={compare}
                  path={view.file}
                  enabled={diffEnabledFor(view.file)}
                  sides={sides}
                  reportRead={diffSlots.reportRead}
                />
              ) : (
                <DiffPlaceholder message="Select a file to see its changes" />
              )
            }
          </FileSlots>
        </main>
      </DetailRailRow>
    </div>,
  );
}

/** One file's diff in the comparison's pane slot, on its own read. */
function BranchFileDiffSlot({
  repoPath,
  base,
  compare,
  path,
  enabled,
  sides,
  reportRead,
}: {
  repoPath: string;
  base: string;
  compare: string;
  path: string;
  enabled: boolean;
  /** The fork point and the rev `compare` resolved to, once they belong to
   *  this pair. */
  sides: { mergeBase: string; compareRev: string } | null;
  reportRead: (read: SlotRead) => void;
}) {
  const diff = useBranchFileDiff(repoPath, base, compare, path, enabled);
  useSlotRead(reportRead, diff);
  return (
    <DiffSurface
      filePath={path}
      diff={diff}
      repoPath={repoPath}
      imageRevs={
        sides ? { old: sides.mergeBase, new: sides.compareRev } : undefined
      }
      contentRevs={
        sides
          ? { oldRev: sides.mergeBase, newRev: sides.compareRev }
          : undefined
      }
    />
  );
}
