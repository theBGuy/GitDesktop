import { TrashIcon } from "@phosphor-icons/react";
import { useDeferredValue, useEffectEvent, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DiffStat } from "@/components/diff-stat";
import { RelativeTime } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { DiffPlaceholder } from "@/features/diff/DiffPlaceholder";
import { DiffSurface } from "@/features/diff/DiffSurfaceLazy";
import type { ImageRevs } from "@/features/diff/ImageDiff";
import {
  useOrphanedStashes,
  useOrphanedStashFileDiff,
  useOrphanedStashFiles,
  useRepoStatus,
  useRestoreOrphaned,
  useStashApply,
  useStashDrop,
  useStashFileDiff,
  useStashFiles,
  useStashList,
} from "@/lib/git/queries";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { toastError } from "@/lib/toast";
import { useRetained } from "@/lib/use-retained";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";

/** Which source the left list is drawn from. */
type StashesView = "stashes" | "recoverable";

/** Picks the right rev base + hooks for the inner file browser: a live stash by
 *  its `stash@{index}` slot, or an orphaned stash by its raw commit sha. */
type FileSource =
  | { kind: "stash"; index: number }
  | { kind: "orphaned"; sha: string };

/** Apply and pop differ only in what becomes of the stash afterward. The pop
 *  wording is kept in step BY HAND with the branch menu's "Pop latest stash"
 *  prompt (BranchSwitcher) — edit both or hoist a shared prompt. */
const STASH_APPLY_COPY = {
  apply: {
    verb: "Apply",
    fate: "leaves it in the stash list, so you can apply it again.",
    confirmLabel: "Apply stash",
  },
  pop: {
    verb: "Pop",
    fate: "removes it from the stash list. If applying conflicts, the stash is kept.",
    confirmLabel: "Pop stash",
  },
} as const;

/** A pending apply/pop, plus the stash's identity as it was when the prompt
 *  opened — `stash@{n}` is a SLOT, not an identity. */
interface PendingApply {
  index: number;
  pop: boolean;
  message: string;
  date: string;
}

const stashApplyPrompt = ({ index, pop }: PendingApply) => {
  const slot = `stash@{${index}}`;
  const copy = STASH_APPLY_COPY[pop ? "pop" : "apply"];
  return {
    title: `${copy.verb} ${slot}?`,
    body: `Applies ${slot} to your working tree and ${copy.fate}`,
    confirmLabel: copy.confirmLabel,
  };
};

/**
 * Browse the stash stack: pick a stash, see the files it holds, inspect each
 * one's diff, then apply, pop, or drop it. A "Recoverable" view surfaces
 * orphaned/dangling stashes (lost work that fell out of `git stash list`) for
 * non-destructive restore.
 */
export function StashesDialog({
  repoPath,
  open,
  onOpenChange,
  initialView = "stashes",
}: {
  repoPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialView?: StashesView;
}) {
  const stashes = useStashList(repoPath, open);
  const apply = useStashApply(repoPath);
  const drop = useStashDrop(repoPath);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<number | null>(null);
  // Apply/pop confirm as a NESTED dialog, like the drop confirm below. The
  // app-root confirm host is a SIBLING dialog, and Base UI only suppresses a
  // parent's Escape for dialogs nested in its React tree — Esc over a sibling
  // would close this dialog underneath it too.
  const [confirmApply, setConfirmApply] = useState<PendingApply | null>(null);
  const shownApply = useRetained(confirmApply);
  // The hook's nullish retain condition is load-bearing here rather than a
  // truthiness one: stash@{0} is a valid index.
  const shownDrop = useRetained(confirmDrop);
  const [view, setView] = useState<StashesView>(initialView);

  // The dialog can be opened straight to either view; seed `view` from the
  // caller's intent each time it opens (mirrors the seed-on-open idiom).
  const seedOnOpen = useEffectEvent(() => setView(initialView));
  useSeedOnOpen(open, seedOnOpen);

  const list = stashes.data ?? [];
  // Default to the newest stash; fall back when the selected one is gone.
  const effectiveIndex =
    selectedIndex !== null && list.some((s) => s.index === selectedIndex)
      ? selectedIndex
      : (list[0]?.index ?? null);
  const busy = apply.isPending || drop.isPending;
  const onError = (e: unknown) => toastError(e);

  function askApply(index: number, pop: boolean) {
    const stash = list.find((s) => s.index === index);
    if (!stash) return;
    setConfirmApply({ index, pop, message: stash.message, date: stash.date });
  }

  async function runApply() {
    if (!confirmApply) return;
    const { index, pop, message, date } = confirmApply;
    setConfirmApply(null);
    // The list can refetch (or another surface push or drop a stash) while the
    // prompt is open, sliding a different stash into the confirmed slot. Apply
    // only the one the prompt described. message + date is the strongest key
    // StashEntry exposes — two same-second stashes off one HEAD tie, so a sha
    // on the entry is the real identity if this guard ever needs tightening.
    const current = list.find((s) => s.index === index);
    if (!current || current.message !== message || current.date !== date) {
      toast.info("The stash list changed — nothing was applied.");
      return;
    }
    try {
      await apply.mutateAsync({ index, pop });
      toast.success(pop ? "Stash applied and dropped" : "Stash applied");
    } catch (e) {
      onError(e);
    }
  }

  const applyPrompt = shownApply ? stashApplyPrompt(shownApply) : null;

  // Arrow keys walk the stash list, mirroring the app's other lists.
  const onStashesKeyDown = listKeyboardNav({
    items: list,
    activeIndex: list.findIndex((s) => s.index === effectiveIndex),
    onActivate: (stash) => setSelectedIndex(stash.index),
    rowKey: (stash) => String(stash.index),
    rowAttr: "data-stash",
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[70vh] flex-col sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Stashes</DialogTitle>
          <DialogDescription>
            {view === "recoverable"
              ? "Lost, uncommitted work that fell out of the stash list — often left by an interrupted operation. Restore re-applies it to the working tree."
              : "Changes set aside with stash. Apply re-applies a stash to the working tree; pop also removes it from the stack."}
          </DialogDescription>
        </DialogHeader>

        {/* Segmented source toggle — keyboard-focusable native buttons. */}
        <div
          role="group"
          aria-label="Stash source"
          className="flex shrink-0 gap-1"
        >
          <Button
            variant={view === "stashes" ? "default" : "outline"}
            size="xs"
            aria-pressed={view === "stashes"}
            onClick={() => setView("stashes")}
          >
            Stashes
          </Button>
          <Button
            variant={view === "recoverable" ? "default" : "outline"}
            size="xs"
            aria-pressed={view === "recoverable"}
            onClick={() => setView("recoverable")}
          >
            Recoverable
          </Button>
        </div>

        {view === "recoverable" ? (
          <RecoverableView repoPath={repoPath} open={open} />
        ) : list.length === 0 ? (
          <p className="flex-1 py-8 text-center text-xs text-muted-foreground">
            No stashes. "Stash all changes" in the branch menu sets the working
            tree aside here.
          </p>
        ) : (
          <div className="flex min-h-0 flex-1 border">
            <aside className="flex w-56 shrink-0 flex-col border-r">
              <ScrollArea className="min-h-0 flex-1">
                <div onKeyDown={onStashesKeyDown}>
                  {list.map((stash) => (
                    <button
                      type="button"
                      key={stash.index}
                      data-stash={stash.index}
                      className={cn(
                        "block w-full border-b px-3 py-2 text-left",
                        effectiveIndex === stash.index
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-muted/60",
                      )}
                      onClick={() => setSelectedIndex(stash.index)}
                    >
                      <p className="truncate text-xs font-medium">
                        {stash.message}
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        stash@{"{"}
                        {stash.index}
                        {"}"} · <RelativeTime date={stash.date} />
                      </p>
                    </button>
                  ))}
                </div>
              </ScrollArea>
              {effectiveIndex !== null && (
                <div className="flex items-center gap-1.5 border-t p-2">
                  {busy && <Spinner className="size-3" />}
                  <span className="flex-1" />
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-destructive"
                    aria-label="Drop stash"
                    disabled={busy}
                    onClick={() => setConfirmDrop(effectiveIndex)}
                  >
                    <TrashIcon data-icon="inline-start" />
                    Drop…
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={busy}
                    onClick={() => askApply(effectiveIndex, false)}
                  >
                    Apply
                  </Button>
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() => askApply(effectiveIndex, true)}
                  >
                    Pop
                  </Button>
                </div>
              )}
            </aside>
            {effectiveIndex !== null ? (
              <StashFiles
                key={effectiveIndex}
                repoPath={repoPath}
                source={{ kind: "stash", index: effectiveIndex }}
              />
            ) : null}
          </div>
        )}

        {applyPrompt && (
          <ConfirmDialog
            open={confirmApply !== null}
            onCancel={() => setConfirmApply(null)}
            title={applyPrompt.title}
            body={applyPrompt.body}
            confirmLabel={applyPrompt.confirmLabel}
            onConfirm={runApply}
          />
        )}

        <Dialog
          open={confirmDrop !== null}
          onOpenChange={(o) => {
            if (!o) setConfirmDrop(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Drop this stash?</DialogTitle>
              <DialogDescription>
                Permanently deletes stash@{"{"}
                {shownDrop}
                {"}"} and the changes it holds. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDrop(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={drop.isPending}
                onClick={async () => {
                  if (confirmDrop === null) return;
                  try {
                    await drop.mutateAsync(confirmDrop);
                    setConfirmDrop(null);
                    toast.success("Stash dropped");
                  } catch (e) {
                    setConfirmDrop(null);
                    onError(e);
                  }
                }}
              >
                {drop.isPending && <Spinner data-icon="inline-start" />}
                Drop stash
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
}

/** The "Recoverable" view: auto-scans (fsck) for orphaned stashes, lists them,
 *  browses their files/diffs, and restores non-destructively. */
function RecoverableView({
  repoPath,
  open,
}: {
  repoPath: string;
  open: boolean;
}) {
  // Auto-scan whenever this view is shown; `enabled` gates the slow fsck so it
  // never runs on the Stashes view.
  const orphaned = useOrphanedStashes(repoPath, open);
  const status = useRepoStatus(repoPath);
  const restore = useRestoreOrphaned(repoPath);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);

  const list = orphaned.data ?? [];
  const effectiveSha =
    selectedSha && list.some((s) => s.sha === selectedSha)
      ? selectedSha
      : (list[0]?.sha ?? null);

  const onError = (e: unknown) => toastError(e);
  // A dirty tree means restoring can conflict — confirm first. Until status has
  // loaded, assume dirty so the confirm is never skipped by a first-paint race.
  const dirty = status.data ? status.data.entries.length > 0 : true;

  // Awaited: a view swap or a dialog close unmounts this mid-restore, and
  // per-call mutation callbacks don't survive that — the outcome would be lost.
  async function restoreSha(sha: string) {
    try {
      await restore.mutateAsync(sha);
      toast.success("Restored to working tree");
    } catch (e) {
      onError(e);
    }
  }

  function onRestoreClick(sha: string) {
    if (dirty) {
      setConfirmRestore(sha);
    } else {
      void restoreSha(sha);
    }
  }

  // Arrow keys walk the recoverable list, mirroring the app's other lists.
  const onListKeyDown = listKeyboardNav({
    items: list,
    activeIndex: list.findIndex((s) => s.sha === effectiveSha),
    onActivate: (o) => setSelectedSha(o.sha),
    rowKey: (o) => o.sha,
    rowAttr: "data-orphaned",
  });

  if (orphaned.isPending || orphaned.isFetching) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-4" />
        Scanning for recoverable work…
      </div>
    );
  }

  if (list.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-center text-xs text-muted-foreground">
          No recoverable work found.
        </p>
        <Button variant="outline" size="xs" onClick={() => orphaned.refetch()}>
          Rescan
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 border">
      <aside className="flex w-56 shrink-0 flex-col border-r">
        <ScrollArea className="min-h-0 flex-1">
          <div onKeyDown={onListKeyDown}>
            {list.map((o) => (
              <button
                type="button"
                key={o.sha}
                data-orphaned={o.sha}
                className={cn(
                  "block w-full border-b px-3 py-2 text-left",
                  effectiveSha === o.sha
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted/60",
                )}
                onClick={() => setSelectedSha(o.sha)}
              >
                <p className="truncate text-xs font-medium">{o.message}</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  <RelativeTime date={o.date} /> · {o.fileCount} file
                  {o.fileCount === 1 ? "" : "s"}
                </p>
              </button>
            ))}
          </div>
        </ScrollArea>
        {effectiveSha !== null && (
          <div className="flex items-center gap-1.5 border-t p-2">
            {restore.isPending && <Spinner className="size-3" />}
            <span className="flex-1" />
            <Button
              size="xs"
              disabled={restore.isPending}
              onClick={() => onRestoreClick(effectiveSha)}
            >
              Restore to working tree
            </Button>
          </div>
        )}
      </aside>
      {effectiveSha !== null ? (
        <StashFiles
          key={effectiveSha}
          repoPath={repoPath}
          source={{ kind: "orphaned", sha: effectiveSha }}
        />
      ) : null}

      <ConfirmDialog
        open={confirmRestore !== null}
        onCancel={() => setConfirmRestore(null)}
        title="Restore over your changes?"
        body="You have uncommitted changes — restoring may conflict. Continue?"
        confirmLabel="Restore"
        pending={restore.isPending}
        onConfirm={() => {
          if (confirmRestore === null) return;
          const sha = confirmRestore;
          setConfirmRestore(null);
          void restoreSha(sha);
        }}
      />
    </div>
  );
}

/** File list + selected file diff for one stash (live or orphaned). The rev base
 *  differs by source (`stash@{index}` vs the raw sha); the `^1`/`^3` structure
 *  and hook wiring are otherwise identical. */
function StashFiles({
  repoPath,
  source,
}: {
  repoPath: string;
  source: FileSource;
}) {
  const stashIndex = source.kind === "stash" ? source.index : null;
  const orphanSha = source.kind === "orphaned" ? source.sha : null;
  // The commit-ish the file lives under: a live stash's slot, or the raw sha.
  const base = source.kind === "stash" ? `stash@{${source.index}}` : source.sha;

  const stashFilesQuery = useStashFiles(repoPath, stashIndex);
  const orphanFilesQuery = useOrphanedStashFiles(repoPath, orphanSha);
  const files = source.kind === "stash" ? stashFilesQuery : orphanFilesQuery;

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const effectivePath =
    selectedPath && files.data?.some((f) => f.path === selectedPath)
      ? selectedPath
      : (files.data?.[0]?.path ?? null);
  // Diff off a deferred path so rapid file arrowing only fetches the landed-on
  // file; the highlight stays on effectivePath.
  const deferredPath = useDeferredValue(effectivePath);
  const stashDiffQuery = useStashFileDiff(repoPath, stashIndex, deferredPath);
  const orphanDiffQuery = useOrphanedStashFileDiff(
    repoPath,
    orphanSha,
    deferredPath,
  );
  const diff = source.kind === "stash" ? stashDiffQuery : orphanDiffQuery;

  // Image/SVG previews need the file's content on each side. Tracked changes
  // read from the stash commit; untracked files from its ^3 parent.
  const effectiveFile = files.data?.find((f) => f.path === deferredPath);
  const imageRevs: ImageRevs | undefined = effectiveFile
    ? {
        old: `${base}^1`,
        new: effectiveFile.untracked ? `${base}^3` : base,
      }
    : undefined;

  if (files.isPending) {
    return null;
  }
  if (files.isError || !files.data) {
    return (
      <div className="flex-1">
        <DiffPlaceholder message="Could not load this stash" />
      </div>
    );
  }

  const fileList = files.data;
  // Arrow keys walk the file list, mirroring the app's other lists.
  const onFilesKeyDown = listKeyboardNav({
    items: fileList,
    activeIndex: fileList.findIndex((f) => f.path === effectivePath),
    onActivate: (file) => setSelectedPath(file.path),
    rowKey: (file) => file.path,
    rowAttr: "data-path",
  });

  return (
    <>
      <aside className="flex w-60 shrink-0 flex-col border-r">
        <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
          {fileList.length} changed file{fileList.length === 1 ? "" : "s"}
        </p>
        <ScrollArea className="min-h-0 flex-1">
          <div onKeyDown={onFilesKeyDown}>
            {fileList.map((file) => (
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
                <DiffStat
                  added={file.added}
                  deleted={file.deleted}
                  isBinary={file.isBinary}
                />
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
            imageRevs={imageRevs}
            // Stash revs already match the diff's sides (^1↔stash, ^1↔^3 for
            // untracked), so reuse them for whole-file highlight context.
            contentRevs={
              imageRevs
                ? { oldRev: imageRevs.old, newRev: imageRevs.new }
                : undefined
            }
          />
        ) : (
          <DiffPlaceholder message="This stash has no files" />
        )}
      </main>
    </>
  );
}
