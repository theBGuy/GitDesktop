import { useDeferredValue, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiffSurface } from "@/features/diff/DiffSurfaceLazy";
import { useBranchDiffFiles, useBranchFileDiff } from "@/lib/git/queries";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { cn } from "@/lib/utils";

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
  const diff = useBranchFileDiff(repoPath, base, compare, deferredPath);

  if (files.isPending) {
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

  // Arrow keys walk the file list, mirroring the app's other lists.
  const onFilesKeyDown = listKeyboardNav({
    items: files.data ?? [],
    activeIndex: (files.data ?? []).findIndex((f) => f.path === effectivePath),
    onActivate: (file) => setSelectedPath(file.path),
    rowKey: (file) => file.path,
    rowAttr: "data-path",
  });

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-3 text-xs">
        <span className="font-medium">
          <span className="font-mono">{compare}</span> vs{" "}
          <span className="font-mono">{base}</span>
        </span>
        <span className="flex-1" />
        <span className="text-muted-foreground">
          {files.data.length} file{files.data.length === 1 ? "" : "s"}
        </span>
        <span className="text-success">+{totalAdded}</span>
        <span className="text-destructive">-{totalDeleted}</span>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-72 shrink-0 flex-col border-r">
          <ScrollArea className="min-h-0 flex-1">
            <div onKeyDown={onFilesKeyDown}>
              {files.data.map((file) => (
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
            </div>
          </ScrollArea>
        </aside>
        <main className="min-w-0 flex-1">
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
