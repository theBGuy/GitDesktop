import {
  CheckCircleIcon,
  SparkleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ConflictFileView } from "@/features/repository/ConflictFileView";
import { ConflictResolveView } from "@/features/repository/ConflictResolveView";
import {
  useAbortLocalPrMerge,
  useFinishLocalPrMerge,
  useRepoStatus,
} from "@/lib/git/queries";
import type { FileEntry } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import type { LocalPr } from "@/lib/pulls/local";
import { useUpdateLocalPr } from "@/lib/pulls/queries";
import { useAiEnabled, useReviewConfigured } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

const baseName = (path: string) => path.split("/").pop() || path;

/** Local-PR wording: this throws away a paused MERGE into the user's own branch, not a
 *  remote-PR resolution — deliberately NOT shared with the remote surface's copy. */
const DISCARD_MERGE_CONFIRM = {
  title: "Discard this merge?",
  body: "The conflict resolution is thrown away; your branch and working tree are untouched.",
  confirmLabel: "Discard merge",
  confirmVariant: "destructive",
} as const;

/**
 * The isolated-worktree conflict-resolution surface for a paused local-PR merge.
 * The merge lives in a hidden detached worktree at `pr.pendingMerge.worktreePath`
 * — the user's branch and working tree are untouched. This surface mirrors the
 * Changes tab, scoped to that worktree: a conflicted-file list on the left, the
 * shared conflict editor on the right. Finish (once every conflict is resolved)
 * commits and advances the base; Abort throws the worktree away.
 *
 * The conflict machinery is `repoPath`-parameterized, so `ConflictFileView` /
 * `ConflictResolveView` and `useRepoStatus` just take the worktree path.
 */
export function ResolveConflictsView({
  repoPath,
  pr,
}: {
  repoPath: string;
  pr: LocalPr;
}) {
  const pending = pr.pendingMerge;
  const worktreePath = pending?.worktreePath ?? "";
  const status = useRepoStatus(worktreePath);
  const update = useUpdateLocalPr(repoPath);
  const finish = useFinishLocalPrMerge(repoPath);
  const abort = useAbortLocalPrMerge(repoPath);
  const aiEnabled = useAiEnabled();
  const reviewConfigured = useReviewConfigured();
  // Same AI-resolution store the Changes tab drives: `activePath` decides whether
  // the selected file shows the AI streaming view or the manual editor, and
  // `startAll` kicks off a "resolve all" walk. It selects files via the main UI
  // store (harmless here — we track our own selection below and follow its walk).
  const startAll = useConflictResolve((s) => s.startAll);
  const activePath = useConflictResolve((s) => s.activePath);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const entries = status.data?.entries ?? [];
  const conflicted: FileEntry[] = entries.filter(
    (e) => e.unstaged === "conflicted" || e.staged === "conflicted",
  );
  const conflictedPaths = conflicted.map((e) => e.path);

  // Keep a valid selection: default to the first conflict, and drop it once that
  // file is resolved (leaves the list). Following `activePath` lets an AI
  // "resolve all" run visibly walk the list as each file completes. Keyed on
  // `status.data` (the source of `conflicted`) so it re-runs as files resolve.
  // biome-ignore lint/correctness/useExhaustiveDependencies: derived from status.data
  useEffect(() => {
    const paths = conflicted.map((e) => e.path);
    if (activePath && paths.includes(activePath)) {
      setSelectedPath(activePath);
      return;
    }
    setSelectedPath((cur) => {
      if (cur && paths.includes(cur)) return cur;
      return paths[0] ?? null;
    });
  }, [activePath, status.data]);

  if (!pending) return null;

  const remaining = conflictedPaths.length;
  // Gated on a SUCCESSFUL read: an errored status query (a worktree that vanished
  // underneath us) leaves no entries, which would otherwise read as "all resolved".
  const done = status.isSuccess && remaining === 0;
  const canResolveWithAi = aiEnabled && reviewConfigured && remaining > 0;
  const busy = finish.isPending || abort.isPending;

  function onFinish() {
    if (!pending) return;
    finish.mutate(
      {
        base: pr.base,
        strategy: pending.strategy,
        message: pending.message,
        worktreePath: pending.worktreePath,
        worktreeId: pending.worktreeId,
        opId: pending.opId,
      },
      {
        onSuccess: (outcome) => {
          if (outcome.status === "merged") {
            update.mutate({
              id: pr.id,
              mutate: (cur) => ({
                ...cur,
                status: "merged",
                mergedAt: new Date().toISOString(),
                pendingMerge: undefined,
              }),
            });
            toast.success(`Merged ${pr.head} into ${pr.base}`);
            return;
          }
          // A multi-step rebase re-paused on the next commit's conflicts, still
          // in the same worktree. Leave `pendingMerge` untouched — the live
          // worktree status already drives this surface.
          toast("More conflicts to resolve");
        },
        onError: toastError,
      },
    );
  }

  async function onAbort() {
    if (!pending) return;
    if (!(await useConfirm.getState().ask(DISCARD_MERGE_CONFIRM))) return;
    abort.mutate(
      { worktreePath: pending.worktreePath, opId: pending.opId },
      {
        onSuccess: () => {
          update.mutate({
            id: pr.id,
            mutate: (cur) => ({ ...cur, pendingMerge: undefined }),
          });
          toast.success("Merge discarded");
        },
        onError: toastError,
      },
    );
  }

  const activeIndex = selectedPath ? conflictedPaths.indexOf(selectedPath) : -1;
  const onListKeyDown = listKeyboardNav({
    items: conflicted,
    activeIndex,
    rowKey: (e) => e.path,
    onActivate: (entry) => setSelectedPath(entry.path),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header: warning tone naming the merge, with the batch AI action, Abort,
          and Finish (gated on zero remaining conflicts). */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b px-3 py-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 text-warning">
          <WarningIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">
            Resolving conflicts · <span className="font-mono">{pr.head}</span> →{" "}
            <span className="font-mono">{pr.base}</span>
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          {canResolveWithAi && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => startAll(conflictedPaths)}
            >
              <SparkleIcon data-icon="inline-start" />
              {remaining === 1 ? "Resolve with AI" : "Resolve all with AI"}
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => void onAbort()}
          >
            Abort
          </Button>
          {/* Wrap so the disabled reason still shows on hover — a native-disabled
              button swallows its `title` (vendored Button's pointer-events-none). */}
          <span
            className="inline-flex"
            title={remaining > 0 ? "Resolve every conflict first" : undefined}
          >
            <Button
              size="xs"
              disabled={busy || remaining > 0}
              onClick={onFinish}
            >
              {finish.isPending && <Spinner data-icon="inline-start" />}
              Finish merge
            </Button>
          </span>
        </div>
      </div>

      {/* Body: conflicted-file list + the selected file's conflict editor. */}
      <div className="flex min-h-0 flex-1">
        <div
          className="w-64 shrink-0 overflow-y-auto border-r"
          onKeyDown={onListKeyDown}
          role="listbox"
          aria-label="Conflicted files"
        >
          {done ? (
            <div className="flex items-start gap-1.5 p-3 text-xs text-muted-foreground">
              <CheckCircleIcon className="mt-px size-3.5 shrink-0 text-success" />
              <span>
                All conflicts resolved — Finish to complete the merge.
              </span>
            </div>
          ) : (
            conflicted.map((entry) => {
              const active = entry.path === selectedPath;
              return (
                <button
                  key={entry.path}
                  type="button"
                  data-row={entry.path}
                  role="option"
                  aria-selected={active}
                  onClick={() => setSelectedPath(entry.path)}
                  className={cn(
                    "flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-xs outline-none",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "hover:bg-muted/60 focus-visible:bg-muted/60",
                  )}
                  title={entry.path}
                >
                  <WarningIcon className="size-3.5 shrink-0 text-warning" />
                  <span className="min-w-0 flex-1 truncate">
                    {baseName(entry.path)}
                  </span>
                </button>
              );
            })
          )}
        </div>
        <div className="min-h-0 flex-1">
          {done ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
              All conflicts resolved — Finish to complete the merge.
            </div>
          ) : selectedPath ? (
            activePath === selectedPath ? (
              <ConflictResolveView
                key={selectedPath}
                repoPath={worktreePath}
                path={selectedPath}
              />
            ) : (
              <ConflictFileView
                key={selectedPath}
                repoPath={worktreePath}
                path={selectedPath}
              />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}
