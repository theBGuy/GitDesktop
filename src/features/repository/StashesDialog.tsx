import { TrashIcon } from "@phosphor-icons/react";
import {
  type ReactNode,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DiffStat } from "@/components/diff-stat";
import { PathText } from "@/components/path-text";
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
import type { ImageRevs } from "@/features/diff/ImageDiff";
import { presentError } from "@/lib/error-summary";
import {
  useDropStashAtAnyDepth,
  useOrphanedStashes,
  useOrphanedStashFileDiff,
  useOrphanedStashFiles,
  useRepoStatus,
  useRestoreOrphaned,
  useStashApply,
  useStashList,
} from "@/lib/git/queries";
import type { StashEntry } from "@/lib/git/types";
import { dispatchAction } from "@/lib/hotkeys/hotkeys";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { refuseIfSwitched } from "@/lib/stores/notifications";
import { useStashReapplyMarker } from "@/lib/stores/stash-reapply-marker";
import { parseableDate } from "@/lib/time";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import { useRetained } from "@/lib/use-retained";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";
import {
  STASH_DROP_GONE,
  STASH_DROP_MOVED,
  stashDropRestoreFailed,
} from "./stash-drop-copy";
import {
  resolveStashPick,
  type StashPick,
  stashRowKey,
  stashRowReactKeys,
} from "./stash-pick";

/** Which source the left list is drawn from. */
type StashesView = "stashes" | "recoverable";

/** Which list the inner file browser was opened from. Both kinds read the stash
 *  commit by its sha, never a live stash's `stash@{N}` slot, which shifts. */
type FileSource =
  | { kind: "stash"; sha: string }
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

/** A pending apply/pop: the slot it addresses, plus the sha of the stash that
 *  sat there when the prompt opened — `stash@{n}` is a SLOT, not an identity. */
interface PendingApply {
  index: number;
  pop: boolean;
  sha: string;
}

/** A pending drop: the stash the prompt names, and the repo it was asked in. */
interface PendingDrop {
  sha: string;
  message: string;
  date: string;
  repo: string;
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
  const drop = useDropStashAtAnyDepth(repoPath);
  const [selected, setSelected] = useState<StashPick | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<PendingDrop | null>(null);
  // Two presses inside one render both pass the button's `drop.isPending`
  // gate; the ref refuses the second, so one confirm fires one drop.
  const droppingRef = useRef(false);
  // Apply/pop confirm as a NESTED dialog, like the drop confirm below. The
  // app-root confirm host is a SIBLING dialog, and Base UI only suppresses a
  // parent's Escape for dialogs nested in its React tree — Esc over a sibling
  // would close this dialog underneath it too.
  const [confirmApply, setConfirmApply] = useState<PendingApply | null>(null);
  const shownApply = useRetained(confirmApply);
  const shownDrop = useRetained(confirmDrop);
  const [view, setView] = useState<StashesView>(initialView);
  // A toast's Recover reads these at click time: switch this dialog's view while
  // it is up, or open View stashes on Recoverable once it is closed or gone.
  const openNow = useLatestRef(open);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The dialog can be opened straight to either view; seed `view` from the
  // caller's intent each time it opens (mirrors the seed-on-open idiom).
  const seedOnOpen = useEffectEvent(() => setView(initialView));
  useSeedOnOpen(open, seedOnOpen);

  const list = stashes.data ?? [];
  const effective = resolveStashPick(list, selected);
  const effectiveKey = effective ? stashRowKey(effective) : null;
  const rowReactKeys = stashRowReactKeys(list);
  const busy = apply.isPending || drop.isPending;
  const onError = (e: unknown) => toastError(e);

  function askApply(index: number, pop: boolean) {
    const stash = list.find((s) => s.index === index);
    if (!stash) return;
    setConfirmApply({ index, pop, sha: stash.sha });
  }

  async function runApply() {
    if (!confirmApply) return;
    const { index, pop, sha } = confirmApply;
    setConfirmApply(null);
    // A refetch or another surface's push or drop can slide a different stash
    // into the slot while the prompt is open. This runs only while the loaded
    // list still shows the prompt's sha at that slot; the apply itself still
    // addresses the slot.
    const current = list.find((s) => s.index === index);
    if (!current || current.sha !== sha) {
      toast.info("The stash list changed — nothing was applied.");
      return;
    }
    // A conflict here must not read as a recorded reapply's.
    useStashReapplyMarker.getState().clearFor(repoPath);
    try {
      await apply.mutateAsync({ index, pop });
      toast.success(pop ? "Stash applied and dropped" : "Stash applied");
    } catch (e) {
      onError(e);
    }
  }

  const applyPrompt = shownApply ? stashApplyPrompt(shownApply) : null;

  function askDrop(stash: StashEntry) {
    setConfirmDrop({
      sha: stash.sha,
      message: stash.message,
      date: stash.date,
      repo: repoPath,
    });
  }

  // The sha captured at ask time pins the target, so no list re-check: the drop
  // only ever aims at the stash the prompt named, wherever it now sits. A race
  // that makes it take another entry stores that one back, and the outcome toast
  // names an entry it could not restore.
  async function runDrop() {
    if (!confirmDrop || droppingRef.current) return;
    const { sha, repo } = confirmDrop;
    if (refuseIfSwitched(repo, "nothing was dropped")) {
      setConfirmDrop(null);
      return;
    }
    droppingRef.current = true;
    // The settle closes the prompt only while it still names this drop's stash
    // and repo (a backstop: new asks are held while the drop is busy).
    const closeOwnPrompt = () =>
      setConfirmDrop((cur) =>
        cur?.sha === sha && cur.repo === repo ? null : cur,
      );
    let outcome: Awaited<ReturnType<typeof drop.mutateAsync>>;
    try {
      outcome = await drop.mutateAsync(sha);
    } catch (e) {
      closeOwnPrompt();
      onError(e);
      return;
    } finally {
      droppingRef.current = false;
    }
    closeOwnPrompt();
    switch (outcome.kind) {
      case "dropped": {
        // The banner must not offer to drop a backup that is gone now.
        const { marker, clearFor } = useStashReapplyMarker.getState();
        if (marker?.repoPath === repo && marker.stashSha === sha)
          clearFor(repo);
        toast.success("Stash dropped");
        break;
      }
      case "moved":
        toast.info(STASH_DROP_MOVED);
        break;
      case "gone":
        toast.info(STASH_DROP_GONE.dialog);
        break;
      case "restoreFailed":
        toast.error(stashDropRestoreFailed(outcome.droppedSha), {
          // The only place the lost entry's sha appears: it stays until closed.
          duration: Infinity,
          action: {
            label: "Recover",
            onClick: (event) => {
              event.currentTarget.blur();
              if (openNow.current && mounted.current) setView("recoverable");
              else dispatchAction("recover-lost-work");
            },
          },
        });
        break;
      default: {
        const exhaustive: never = outcome;
        return exhaustive;
      }
    }
  }

  // Arrow keys walk the stash list, mirroring the app's other lists.
  const onStashesKeyDown = listKeyboardNav({
    items: list,
    activeIndex: effective ? list.indexOf(effective) : -1,
    onActivate: (stash) => setSelected({ sha: stash.sha, index: stash.index }),
    rowKey: stashRowKey,
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
                  {list.map((stash, i) => (
                    <button
                      type="button"
                      key={rowReactKeys[i]}
                      data-stash={stashRowKey(stash)}
                      className={cn(
                        "block w-full border-b px-3 py-2 text-left",
                        effectiveKey === stashRowKey(stash)
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-muted/60",
                      )}
                      onClick={() =>
                        setSelected({ sha: stash.sha, index: stash.index })
                      }
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
              {effective !== null && (
                <div className="flex items-center gap-1.5 border-t p-2">
                  {busy && <Spinner className="size-3" />}
                  <span className="flex-1" />
                  <Button
                    variant="ghost"
                    size="xs"
                    className="text-destructive"
                    aria-label="Drop stash"
                    disabled={busy}
                    onClick={() => askDrop(effective)}
                  >
                    <TrashIcon data-icon="inline-start" />
                    Drop…
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={busy}
                    onClick={() => askApply(effective.index, false)}
                  >
                    Apply
                  </Button>
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() => askApply(effective.index, true)}
                  >
                    Pop
                  </Button>
                </div>
              )}
            </aside>
            {effective !== null ? (
              <StashFiles
                key={effective.sha}
                repoPath={repoPath}
                source={{ kind: "stash", sha: effective.sha }}
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
              <DialogDescription className="wrap-anywhere">
                Permanently deletes the stash "{shownDrop?.message}"
                {shownDrop && parseableDate(shownDrop.date) && (
                  <>
                    , saved <RelativeTime date={shownDrop.date} />,
                  </>
                )}{" "}
                and the changes it holds. This cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDrop(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={drop.isPending}
                onClick={runDrop}
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
    // Restore applies the commit, so it can conflict like any reapply.
    useStashReapplyMarker.getState().clearFor(repoPath);
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

/** File list + selected file diff for one stash (live or orphaned), both read
 *  by the stash commit's sha; the `^1`/`^3` structure is identical. */
function StashFiles({
  repoPath,
  source,
}: {
  repoPath: string;
  source: FileSource;
}) {
  // The commit-ish the file lives under.
  const base = source.sha;

  const files = useOrphanedStashFiles(repoPath, base);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const effectivePath =
    selectedPath && files.data?.some((f) => f.path === selectedPath)
      ? selectedPath
      : (files.data?.[0]?.path ?? null);
  // Diff off a deferred path so rapid file arrowing only fetches the landed-on
  // file; the highlight stays on effectivePath.
  const deferredPath = useDeferredValue(effectivePath);
  // The file's diff swaps through the pane's two-slot hold. Its entity is the
  // stash's sha, so a drop or pop elsewhere in the stack never re-targets it.
  const diffTarget = deferredPath
    ? keyedPaneView(repoPath, base, deferredPath, deferredPath)
    : placeholderPaneView(base);
  const diffSlots = useFileSlots(diffTarget);

  // A failed refresh keeps the loaded file list under a notice; only a read with
  // nothing loaded replaces it.
  const pane = resolveDetailPane({
    pending: files.isPending,
    error: files.isError,
    hasData: files.data !== undefined,
    paused: files.isPaused,
    fetching: files.isFetching,
  });
  const failed = refreshFailed(files);
  // Retry resets the read to pending, swapping the error arm for the empty
  // pending arm; every arm renders in the same column, so focus lands there.
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
  const viewFrame = `${arm}:${source.kind}:${base}`;
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
      className="flex min-w-0 flex-1 flex-col outline-none"
    >
      <DegradedListNotice
        noun="this stash"
        degraded={pane === "content-degraded"}
        message={detailNoticeMessage({
          noun: "stash",
          isError: failed,
          stale: files.isPlaceholderData,
        })}
        onRetry={failed ? () => void files.refetch() : undefined}
        className="shrink-0 border-b px-3 py-1.5"
      />
      <div className="flex min-h-0 flex-1">{content}</div>
    </div>
  );

  // The read is local, so it never parks offline: that arm loads too.
  if (pane === "skeleton" || pane === "offline") {
    return shell(null);
  }
  if (pane === "error" || !files.data) {
    return shell(
      <div className="flex-1">
        <DiffPlaceholder
          message="Could not load this stash"
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
        />
      </div>,
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

  return shell(
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
                aria-current={effectivePath === file.path || undefined}
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
          </div>
        </ScrollArea>
      </aside>
      <main className="min-w-0 flex-1">
        <FileSlots
          slots={diffSlots}
          target={diffTarget}
          busy={diffSlots.holding || diffSlots.read.loading}
        >
          {(view) =>
            view.kind === "file" ? (
              <StashFileDiffSlot
                repoPath={repoPath}
                base={base}
                path={view.file}
                untracked={
                  fileList.find((f) => f.path === view.file)?.untracked
                }
                reportRead={diffSlots.reportRead}
              />
            ) : (
              <DiffPlaceholder message="This stash has no files" />
            )
          }
        </FileSlots>
      </main>
    </>,
  );
}

/** One stashed file's diff in the pane's slot, on its own read. */
function StashFileDiffSlot({
  repoPath,
  base,
  path,
  untracked,
  reportRead,
}: {
  repoPath: string;
  /** The stash commit's sha: the diff reads by it, and the revs hang off it. */
  base: string;
  path: string;
  /** The file list's flag for this path; absent while the list lacks it. */
  untracked: boolean | undefined;
  reportRead: (read: SlotRead) => void;
}) {
  const diff = useOrphanedStashFileDiff(repoPath, base, path);
  useSlotRead(reportRead, diff);
  // Image/SVG previews need the file's content on each side. Tracked changes
  // read from the stash commit; untracked files from its ^3 parent.
  const imageRevs: ImageRevs | undefined =
    untracked === undefined
      ? undefined
      : { old: `${base}^1`, new: untracked ? `${base}^3` : base };
  return (
    <DiffSurface
      filePath={path}
      diff={diff}
      repoPath={repoPath}
      imageRevs={imageRevs}
      // Stash revs already match the diff's sides (^1↔stash, ^1↔^3 for
      // untracked), so reuse them for whole-file highlight context.
      contentRevs={
        imageRevs ? { oldRev: imageRevs.old, newRev: imageRevs.new } : undefined
      }
    />
  );
}
