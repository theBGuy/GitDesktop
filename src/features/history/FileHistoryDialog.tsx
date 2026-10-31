import { useEffect, useState } from "react";
import { CommitAuthorAvatar } from "@/components/commit-author-avatar";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  DegradedListNotice,
  useRetryFocusRescue,
} from "@/features/conversations/ConversationListPanel";
import {
  listNotice,
  refreshFailed,
  splitInfiniteFailure,
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
import { presentError } from "@/lib/error-summary";
import {
  useCommitAuthorAvatarIndex,
  useCommitFileDiff,
  useFileLog,
} from "@/lib/git/queries";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import {
  ARIA_DISABLED_CLASS,
  heldButtonRender,
} from "@/lib/use-disabled-reason";
import { cn } from "@/lib/utils";
import { dedupeByHash, entryPathFor } from "./file-history-entries";

/** Commit history for one file: pick a commit to see the file's diff there. */
export function FileHistoryDialog({
  repoPath,
  path,
  open,
  onOpenChange,
}: {
  repoPath: string;
  path: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fileLog = useFileLog(repoPath, open ? path : null);
  // Batch-resolve commit-author avatars (GitHub-only; deduped by react-query with
  // the other History surfaces, so this shares one call per repo per 15min).
  useCommitAuthorAvatarIndex(repoPath);
  // Offset pages can repeat a row when HEAD moves between fetches.
  const commits = dedupeByHash(fileLog.data?.pages.flat() ?? []);
  const [selected, setSelected] = useState<string | null>(null);
  // Default to the newest commit; reset when the dialog closes.
  const activeHash = selected ?? commits[0]?.hash ?? null;
  useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);

  // The diff swaps through the pane's two-slot hold, keyed on the commit (the
  // rail is commits); the dialog's file is the entity, and a closed dialog
  // rests on the placeholder so a reopen starts fresh.
  const diffTarget =
    open && activeHash
      ? keyedPaneView(repoPath, path, activeHash, activeHash)
      : placeholderPaneView(path);
  const diffSlots = useFileSlots(diffTarget);
  const name = path.split("/").pop() ?? path;

  // A failed read never reads as "No history for this file.": with nothing
  // loaded it says it couldn't load, and loaded commits stay under a notice.
  const loadFailed = fileLog.data === undefined && refreshFailed(fileLog);
  const notice =
    fileLog.data === undefined
      ? null
      : listNotice({
          noun: "commits",
          ...splitInfiniteFailure(fileLog),
          offline: false,
          placeholder: false,
          hasRows: commits.length > 0,
        });
  // Retry resets the read to loading, unmounting itself; focus lands on the
  // list column.
  const { hostRef, retryRef } = useRetryFocusRescue(loadFailed);
  // Loading the last page unmounts Load more under the user's focus; land it
  // on the column too. True exactly while the button is mounted.
  const moreRescue = useRetryFocusRescue(
    commits.length > 0 && fileLog.hasNextPage,
  );

  // Arrow keys walk the commit list (single-select), mirroring HistoryPanel.
  const onListKeyDown = listKeyboardNav({
    items: commits,
    activeIndex: commits.findIndex((c) => c.hash === activeHash),
    rowKey: (c) => c.hash,
    rowAttr: "data-hash",
    onActivate: (commit) => setSelected(commit.hash),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">History of {name}</DialogTitle>
          <DialogDescription>
            <PathText path={path} className="font-mono" />
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-3">
          <div
            ref={(node) => {
              hostRef(node);
              moreRescue.hostRef(node);
            }}
            tabIndex={-1}
            className="flex w-64 shrink-0 flex-col border outline-none"
          >
            {/* Pre-mounted, never under aria-busy: a live region created
                together with its text announces unreliably. */}
            <div role="status" className="sr-only">
              {loadFailed
                ? `Couldn't load this file's history. ${presentError(fileLog.error).summary}`
                : ""}
            </div>
            <DegradedListNotice
              noun="commits"
              degraded={notice !== null}
              message={notice?.message}
              retryLabel={notice?.retryLabel}
              onRetry={
                notice?.cause === "refresh"
                  ? () => void fileLog.refetch()
                  : undefined
              }
              className="shrink-0 border-b px-2.5 py-1.5"
            />
            <ScrollArea className="min-h-0 flex-1">
              {loadFailed ? (
                <div className="p-3 text-xs">
                  <p className="text-muted-foreground">
                    Couldn't load this file's history.
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {presentError(fileLog.error).summary}
                  </p>
                  <Button
                    ref={retryRef}
                    variant="outline"
                    size="sm"
                    className="mt-2 cursor-pointer"
                    onClick={() => void fileLog.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              ) : fileLog.data === undefined ? (
                <div className="flex justify-center p-4">
                  <Spinner />
                </div>
              ) : commits.length === 0 ? (
                <p className="p-3 text-xs text-muted-foreground">
                  No history for this file.
                </p>
              ) : (
                // Arrow-key nav lives on the focusable row buttons below; this
                // wrapper only routes their bubbled keydown to listKeyboardNav.
                <div onKeyDown={onListKeyDown}>
                  {commits.map((c) => (
                    <button
                      type="button"
                      key={c.hash}
                      data-hash={c.hash}
                      aria-current={c.hash === activeHash || undefined}
                      onClick={() => setSelected(c.hash)}
                      className={cn(
                        "flex w-full items-start gap-2 border-b px-2.5 py-2 text-left text-xs",
                        c.hash === activeHash
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-muted/60",
                      )}
                    >
                      <CommitAuthorAvatar
                        name={c.author}
                        email={c.authorEmail}
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{c.subject}</p>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {c.author} · <RelativeTime date={c.date} />
                        </p>
                      </div>
                    </button>
                  ))}
                  {fileLog.hasNextPage && (
                    <Button
                      ref={moreRescue.retryRef}
                      variant="ghost"
                      size="xs"
                      className={cn(
                        "h-auto w-full gap-1.5 px-2.5 py-2 text-[11px] font-normal text-muted-foreground",
                        ARIA_DISABLED_CLASS,
                      )}
                      // Focusable while busy, so a press never drops focus to
                      // <body>; the button is the Load more retry too.
                      disabled={fileLog.isFetchingNextPage}
                      focusableWhenDisabled
                      render={heldButtonRender(fileLog.isFetchingNextPage)}
                      onClick={() => fileLog.fetchNextPage()}
                    >
                      {fileLog.isFetchingNextPage && (
                        <Spinner data-icon="inline-start" />
                      )}
                      Load more
                    </Button>
                  )}
                </div>
              )}
            </ScrollArea>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden border">
            <FileSlots
              slots={diffSlots}
              target={diffTarget}
              busy={diffSlots.holding || diffSlots.read.loading}
            >
              {(view) =>
                view.kind === "file" ? (
                  <FileHistoryDiffSlot
                    repoPath={repoPath}
                    entryPath={entryPathFor(commits, view.file, path)}
                    hash={view.file}
                    reportRead={diffSlots.reportRead}
                  />
                ) : (
                  <DiffPlaceholder message="Select a commit" />
                )
              }
            </FileSlots>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The dialog file's diff at one commit, in the pane's slot, on its own read.
 *  `entryPath` is the file's name as of that commit, so a pre-rename commit
 *  reads the blob it actually touched. */
function FileHistoryDiffSlot({
  repoPath,
  entryPath,
  hash,
  reportRead,
}: {
  repoPath: string;
  entryPath: string;
  hash: string;
  reportRead: (read: SlotRead) => void;
}) {
  const diff = useCommitFileDiff(repoPath, hash, entryPath);
  useSlotRead(reportRead, diff);
  return (
    <DiffSurface
      filePath={entryPath}
      diff={diff}
      repoPath={repoPath}
      imageRevs={{ old: `${hash}~1`, new: hash }}
      contentRevs={{ oldRev: `${hash}~1`, newRev: hash }}
    />
  );
}
