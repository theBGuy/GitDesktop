import { useEffect, useState } from "react";
import { CommitAuthorAvatar } from "@/components/commit-author-avatar";
import { RelativeTime } from "@/components/relative-time";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiffSurface } from "@/features/diff/DiffSurfaceLazy";
import {
  useCommitAuthorAvatarIndex,
  useCommitFileDiff,
  useFileLog,
} from "@/lib/git/queries";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { cn } from "@/lib/utils";

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
  const commits = fileLog.data?.pages.flat() ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  // Default to the newest commit; reset when the dialog closes.
  const activeHash = selected ?? commits[0]?.hash ?? null;
  useEffect(() => {
    if (!open) setSelected(null);
  }, [open]);

  const diff = useCommitFileDiff(
    repoPath,
    open ? activeHash : null,
    open ? path : null,
  );
  const name = path.split("/").pop() ?? path;

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
          <DialogTitle className="truncate">History of {name}</DialogTitle>
          <DialogDescription className="truncate font-mono">
            {path}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 gap-3">
          <div className="flex w-64 shrink-0 flex-col border">
            <ScrollArea className="min-h-0 flex-1">
              {fileLog.isPending ? (
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
                    <button
                      type="button"
                      className="flex w-full items-center justify-center gap-1.5 px-2.5 py-2 text-center text-[11px] text-muted-foreground hover:bg-muted/60"
                      disabled={fileLog.isFetchingNextPage}
                      onClick={() => fileLog.fetchNextPage()}
                    >
                      {fileLog.isFetchingNextPage && (
                        <Spinner data-icon="inline-start" />
                      )}
                      Load more
                    </button>
                  )}
                </div>
              )}
            </ScrollArea>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden border">
            {activeHash ? (
              <DiffSurface filePath={path} diff={diff} repoPath={repoPath} />
            ) : (
              <DiffPlaceholder message="Select a commit" />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
