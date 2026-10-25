import { useVirtualizer } from "@tanstack/react-virtual";
import {
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  DEGRADED_ACTION_CLASS,
  listNotice,
  refreshFailed,
} from "@/features/conversations/remote-section-state";
import { presentError } from "@/lib/error-summary";
import { useTrackedFiles } from "@/lib/git/queries";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { cn } from "@/lib/utils";

/**
 * Fuzzy tracked-file picker for the palette "Blame file…" action. Pick a file
 * (arrow keys + Enter, or click) and it opens the {@link BlameDialog} for that
 * path with no rev — a worktree blame ("blame this file as it is now"), matching
 * the palette flow's intent.
 *
 * Filtering is a plain case-insensitive substring on the full path (same
 * simplicity as the command palette). The list virtualizes so it stays smooth at
 * ~5–10k tracked files, mounted in a data-gated child so the scroll element
 * exists when the virtualizer first observes it (mirrors RepositoryFilesDialog).
 */
export function BlameFilePickerDialog({
  repoPath,
  open,
  onOpenChange,
  onPick,
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the chosen path; the caller opens the blame view. */
  onPick: (path: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [activePath, setActivePath] = useState<string | null>(null);
  const tracked = useTrackedFiles(repoPath, open);
  const filterRef = useRef<HTMLInputElement>(null);

  // Reset the transient filter/selection each time the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear on open switch
  useEffect(() => {
    setFilter("");
    setActivePath(null);
  }, [open]);

  const q = filter.trim().toLowerCase();
  const filtered = useMemo(() => {
    const base = tracked.data ?? [];
    return q ? base.filter((p) => p.toLowerCase().includes(q)) : base;
  }, [tracked.data, q]);

  const activeIndex = activePath ? filtered.indexOf(activePath) : -1;

  // A failed refresh keeps the loaded paths under a notice; only a read with
  // nothing loaded says it couldn't load, and "No tracked files." comes only
  // from a read that answered empty.
  const failed = refreshFailed(tracked);
  const loadFailed = tracked.data === undefined && failed;
  const notice =
    tracked.data === undefined
      ? null
      : listNotice({
          noun: "tracked files",
          failed,
          offline: false,
          placeholder: false,
          hasRows: tracked.data.length > 0,
          loadMoreFailed: false,
        });
  const failureLine = loadFailed
    ? `Couldn't load tracked files. ${presentError(tracked.error).summary}`
    : "";
  // Opening re-runs a failed read, so a failure is announced when the read
  // fails, once per read; the filter's description carries it while shown.
  const describedText = failureLine || notice?.message || "";
  const describedId = useId();
  // Either Retry unmounts as its read refetches; focus returns to the filter,
  // which drives the list.
  const rescue = useRetryFocusRescue(loadFailed);
  const noticeRescue = useRetryFocusRescue(notice !== null);

  function pick(path: string) {
    onPick(path);
    onOpenChange(false);
  }

  // ArrowUp/Down move the focused row (single-select — no Shift range here).
  const navKeyDown = listKeyboardNav({
    items: filtered,
    activeIndex,
    onActivate: (path) => setActivePath(path),
  });
  // Enter picks the focused row; arrows navigate — wired on both the input and
  // the list so arrows always move the selection regardless of focus.
  function onFilterKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && activePath && filtered.includes(activePath)) {
      e.preventDefault();
      pick(activePath);
      return;
    }
    navKeyDown(e);
  }
  function onListKeyDown(e: KeyboardEvent) {
    if (
      e.key === "Enter" &&
      e.target === e.currentTarget &&
      activePath &&
      filtered.includes(activePath)
    ) {
      e.preventDefault();
      pick(activePath);
      return;
    }
    navKeyDown(e);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* ph-no-capture: repo file paths — block from replay. */}
      <DialogContent
        className="ph-no-capture flex h-[70vh] flex-col sm:max-w-2xl"
        initialFocus={() => filterRef.current}
      >
        <DialogHeader>
          <DialogTitle>Blame a file</DialogTitle>
          <DialogDescription>
            Pick a tracked file to see line-by-line blame for its current
            contents.
          </DialogDescription>
        </DialogHeader>

        <Input
          ref={(node) => {
            filterRef.current = node;
            rescue.hostRef(node);
            noticeRescue.hostRef(node);
          }}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={onFilterKeyDown}
          placeholder="Filter files — ↑↓ to move, Enter to blame"
          aria-label="Filter tracked files"
          aria-describedby={describedText ? describedId : undefined}
          className="h-8"
          autoComplete="off"
        />
        <span id={describedId} hidden>
          {describedText}
        </span>
        <div role="status" className="sr-only">
          {failureLine}
        </div>
        {/* The Retry sits beside the notice rather than in it, so its rescue
            lands on the filter instead of the notice's own wrapper. */}
        <div
          className={
            notice
              ? "flex flex-wrap items-center gap-x-1.5 px-1 text-[11px] text-muted-foreground"
              : "contents"
          }
        >
          <DegradedListNotice
            noun="tracked files"
            degraded={notice !== null}
            message={notice?.message}
            className="p-0"
          />
          {notice && (
            <button
              ref={noticeRescue.retryRef}
              type="button"
              aria-label={notice.retryLabel}
              onClick={() => void tracked.refetch()}
              className={DEGRADED_ACTION_CLASS}
            >
              Retry
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 border">
          {loadFailed ? (
            <div className="p-4 text-xs">
              <p className="text-muted-foreground">
                Couldn't load tracked files.
              </p>
              <p className="mt-1 text-muted-foreground">
                {presentError(tracked.error).summary}
              </p>
              <Button
                ref={rescue.retryRef}
                variant="outline"
                size="sm"
                className="mt-2 cursor-pointer"
                onClick={() => void tracked.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : tracked.data === undefined ? (
            <div className="flex justify-center p-4">
              <Spinner />
            </div>
          ) : filtered.length === 0 ? (
            <p className="p-4 text-xs text-muted-foreground">
              {tracked.data.length === 0
                ? "No tracked files."
                : "No files match."}
            </p>
          ) : (
            <FileList
              paths={filtered}
              activePath={activePath}
              onPick={pick}
              onKeyDown={onListKeyDown}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The virtualized file rows — mounted only once data is ready and the dialog is
 * laid out, so the scroll element exists when the virtualizer first observes it
 * (the same data-gated structure as RepositoryFilesDialog's FileList).
 */
function FileList({
  paths,
  activePath,
  onPick,
  onKeyDown,
}: {
  paths: string[];
  activePath: string | null;
  onPick: (path: string) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: paths.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 30,
    overscan: 12,
  });

  // Keep the keyboard-focused row scrolled into view (it may not be mounted yet).
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on active/list change
  useEffect(() => {
    if (!activePath) return;
    const idx = paths.indexOf(activePath);
    if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [activePath, paths]);

  return (
    <div
      ref={parentRef}
      className="h-full overflow-y-auto"
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      <div
        className="relative w-full"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const path = paths[vi.index];
          return (
            <div
              key={path}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className="absolute top-0 left-0 w-full"
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              <button
                type="button"
                onClick={() => onPick(path)}
                className={cn(
                  "flex w-full cursor-pointer items-center border-b px-2 py-1.5 text-left text-xs hover:bg-muted/60",
                  path === activePath && "bg-accent text-accent-foreground",
                )}
              >
                <PathText path={path} className="flex-1 font-mono" />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
