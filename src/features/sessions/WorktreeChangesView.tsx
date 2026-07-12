import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiffSurface } from "@/features/diff/DiffSurfaceLazy";
import { gitDiffFile, gitStatus } from "@/lib/git/api";
import type { ChangeKind, FileEntry } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { cn } from "@/lib/utils";

/** The working-tree change a session turn is mid-way through making. */
function entryKind(e: FileEntry): ChangeKind {
  return e.unstaged ?? e.staged ?? "modified";
}

const KIND_LABEL: Record<ChangeKind, string> = {
  added: "new",
  untracked: "new",
  modified: "edit",
  typechange: "edit",
  deleted: "deleted",
  renamed: "renamed",
  copied: "copied",
  conflicted: "conflict",
};

/**
 * Read-only view of a worktree's *uncommitted* changes — what the agent has
 * written this turn before the checkpoint commit lands. Polls fast so you can
 * watch it work; it only mounts while a turn is running, so the polling stops
 * when the turn commits and this unmounts (the cumulative committed diff takes
 * over). Mirrors {@link BranchDiffView}'s layout but off working-tree status
 * rather than a branch comparison.
 */
export function WorktreeChangesView({ repoPath }: { repoPath: string }) {
  const status = useQuery({
    queryKey: ["session-worktree-status", repoPath] as const,
    queryFn: () => gitStatus(repoPath),
    refetchInterval: 1500,
  });
  // Anything the agent touched: it writes into the working tree (unstaged) and
  // creates new (untracked) files; it never stages, but include staged
  // defensively so nothing is hidden.
  const entries = (status.data?.entries ?? []).filter(
    (e) => e.unstaged || e.staged,
  );

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const effectivePath =
    selectedPath && entries.some((e) => e.path === selectedPath)
      ? selectedPath
      : (entries[0]?.path ?? null);
  const deferredPath = useDeferredValue(effectivePath);
  const selected = entries.find((e) => e.path === deferredPath) ?? null;
  const untracked = selected?.unstaged === "untracked";
  // Show the unstaged (HEAD → working tree) diff; the agent doesn't stage. Its own
  // polling query (not the shared `useFileDiff`) so the diff keeps refreshing as the
  // agent re-edits the SAME file — the shared key has no content hash, so it would
  // otherwise serve a stale cached diff for the whole turn.
  const diff = useQuery({
    queryKey: [
      "session-worktree-diff",
      repoPath,
      deferredPath ?? "",
      untracked,
    ] as const,
    queryFn: () => gitDiffFile(repoPath, deferredPath ?? "", false, untracked),
    enabled: deferredPath !== null,
    refetchInterval: 1500,
  });

  if (status.isPending) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (entries.length === 0) {
    return (
      <DiffPlaceholder message="The agent is working — no file changes yet this turn." />
    );
  }

  const onFilesKeyDown = listKeyboardNav({
    items: entries,
    activeIndex: entries.findIndex((e) => e.path === effectivePath),
    onActivate: (e) => setSelectedPath(e.path),
    rowKey: (e) => e.path,
    rowAttr: "data-path",
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-3 text-xs">
        <span className="font-medium">Working changes</span>
        <span className="text-muted-foreground">· uncommitted this turn</span>
        <span className="flex-1" />
        <span className="text-muted-foreground">
          {entries.length} file{entries.length === 1 ? "" : "s"}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r">
          <ScrollArea className="min-h-0 flex-1">
            <div onKeyDown={onFilesKeyDown}>
              {entries.map((file) => (
                <button
                  type="button"
                  key={file.path}
                  data-path={file.path}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs",
                    effectivePath === file.path
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60",
                  )}
                  onClick={() => setSelectedPath(file.path)}
                  title={file.path}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {file.path}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {KIND_LABEL[entryKind(file)]}
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>
        </aside>
        <main className="min-w-0 flex-1">
          {deferredPath ? (
            <DiffSurface
              filePath={deferredPath}
              diff={diff}
              repoPath={repoPath}
              imageRevs={{ old: "HEAD", new: null }}
              contentRevs={
                untracked ? { newRev: null } : { oldRev: ":0", newRev: null }
              }
            />
          ) : (
            <DiffPlaceholder message="Select a file to see its changes" />
          )}
        </main>
      </div>
    </div>
  );
}
