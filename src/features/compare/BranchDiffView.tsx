import { useDeferredValue, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiffSurface } from "@/features/diff/DiffSurfaceLazy";
import { FileRowActions } from "@/features/history/FileRowActions";
import { useBranchDiffFiles, useBranchFileDiff } from "@/lib/git/queries";
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
  const diffEnabled =
    !files.isPlaceholderData &&
    (files.data?.some((f) => f.path === deferredPath) ?? false);
  const diff = useBranchFileDiff(
    repoPath,
    base,
    compare,
    deferredPath,
    diffEnabled,
  );

  // A placeholder list is the PREVIOUS comparison's, so an empty one says nothing
  // about this pair — hold the skeleton rather than claim "no changes" below.
  if (files.isPending || (files.isPlaceholderData && files.data.length === 0)) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (files.isError) {
    return <DiffPlaceholder message="Could not compare these branches" />;
  }
  if (files.data.length === 0) {
    return (
      <DiffPlaceholder
        message={`${compare} has no changes relative to ${base}`}
      />
    );
  }

  const totalAdded = files.data.reduce((sum, f) => sum + f.added, 0);
  const totalDeleted = files.data.reduce((sum, f) => sum + f.deleted, 0);
  // The counts, totals and file list belong to the PREVIOUS comparison until the
  // selected one lands; fade them. The branch names are props — always current.
  const staleDim = files.isPlaceholderData && "opacity-80";
  // The diff pane serves the previous file's diff for longer than the rest (its
  // query stays on placeholder data through the gated window above), so it fades
  // on its own state. Never nested inside another dim — 0.8² reads as disabled.
  const diffDim = (staleDim || diff.isPlaceholderData) && "opacity-80";

  // Arrow keys walk the file list, mirroring the app's other lists.
  const onFilesKeyDown = listKeyboardNav({
    items: files.data ?? [],
    activeIndex: (files.data ?? []).findIndex((f) => f.path === effectivePath),
    onActivate: (file) => setSelectedPath(file.path),
    rowKey: (file) => file.path,
    rowAttr: "data-path",
  });

  return (
    <div className="flex h-full flex-col" aria-busy={Boolean(staleDim)}>
      <header className="flex items-center gap-2 border-b px-4 py-3 text-xs">
        <span className="font-medium">
          <span className="font-mono">{compare}</span> vs{" "}
          <span className="font-mono">{base}</span>
        </span>
        <span className="flex-1" />
        <span
          className={cn("text-muted-foreground", PLACEHOLDER_FADE, staleDim)}
        >
          {files.data.length} file{files.data.length === 1 ? "" : "s"}
        </span>
        <span className={cn("text-success", PLACEHOLDER_FADE, staleDim)}>
          +{totalAdded}
        </span>
        <span className={cn("text-destructive", PLACEHOLDER_FADE, staleDim)}>
          -{totalDeleted}
        </span>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "flex w-72 shrink-0 flex-col border-r",
            PLACEHOLDER_FADE,
            staleDim,
          )}
          role="listbox"
          aria-label="Changed files"
        >
          {/* overflow-hidden contains the list's natural height (vendored Root is
              `relative`-only) so a long list can't leak a window scrollbar. */}
          <ScrollArea className="min-h-0 flex-1 overflow-hidden">
            <FileRowActions
              repoPath={repoPath}
              blameRev={compare}
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
                  title={file.path}
                >
                  <span className="min-w-0 flex-1 truncate font-mono">
                    {file.path}
                  </span>
                  {file.isBinary ? (
                    <span className="shrink-0 text-muted-foreground">bin</span>
                  ) : (
                    <span className="shrink-0 tabular-nums">
                      <span className="text-success">+{file.added}</span>{" "}
                      <span className="text-destructive">-{file.deleted}</span>
                    </span>
                  )}
                </button>
              ))}
            </FileRowActions>
          </ScrollArea>
        </aside>
        <main
          aria-busy={Boolean(diffDim)}
          className={cn("min-w-0 flex-1", PLACEHOLDER_FADE, diffDim)}
        >
          {deferredPath ? (
            <DiffSurface
              filePath={deferredPath}
              diff={diff}
              repoPath={repoPath}
              imageRevs={{ old: base, new: compare }}
            />
          ) : (
            <DiffPlaceholder message="Select a file to see its changes" />
          )}
        </main>
      </div>
    </div>
  );
}
