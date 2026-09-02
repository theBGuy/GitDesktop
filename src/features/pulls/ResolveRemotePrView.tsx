import {
  CheckCircleIcon,
  SparkleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ConflictFileView } from "@/features/repository/ConflictFileView";
import { ConflictResolveView } from "@/features/repository/ConflictResolveView";
import {
  useAbortRemotePrResolve,
  useFinishRemotePrResolve,
  useRepoStatus,
} from "@/lib/git/queries";
import type { FileEntry, RemoteLens } from "@/lib/git/types";
import { listKeyboardNav } from "@/lib/list-keyboard-nav";
import { useAiEnabled, useReviewConfigured } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

const baseName = (path: string) => path.split("/").pop() || path;

/** The one wording for discarding a resolution — the banner's Discard and this
 *  surface's both ask through it, so the two prompts can't drift apart. */
export const DISCARD_RESOLVE_CONFIRM = {
  title: "Discard this resolution?",
  body: "The hidden worktree is deleted — your branch, working tree, and the pull request are untouched.",
  confirmLabel: "Discard resolution",
  confirmVariant: "destructive",
} as const;

/** Shared by the render derivation and the selection effect so both classify a
 *  conflict the same way. */
const conflictedEntries = (entries: FileEntry[]) =>
  entries.filter(
    (e) => e.unstaged === "conflicted" || e.staged === "conflicted",
  );

/**
 * The isolated-worktree conflict-resolution surface for a REMOTE pull request. The
 * merge of the base into the PR's head lives in a hidden detached worktree — the
 * user's branch and working tree are untouched — and finishing pushes the resolved
 * head back to the pull request. Mirrors the Changes tab scoped to that worktree:
 * conflicted-file list on the left, the shared conflict editor on the right.
 *
 * The conflict machinery is `repoPath`-parameterized, so `ConflictFileView` /
 * `ConflictResolveView` and `useRepoStatus` just take the worktree path.
 */
export function ResolveRemotePrView({
  repoPath,
  head,
  base,
  worktreePath,
  worktreeId,
  lens,
  onDone,
}: {
  repoPath: string;
  head: string;
  base: string;
  worktreePath: string;
  worktreeId: string;
  lens: RemoteLens;
  /** Leave the takeover — the worktree is gone (finished or discarded). */
  onDone: () => void;
}) {
  const status = useRepoStatus(worktreePath);
  const finish = useFinishRemotePrResolve(repoPath, lens);
  const abort = useAbortRemotePrResolve(repoPath);
  const aiEnabled = useAiEnabled();
  const reviewConfigured = useReviewConfigured();
  // Same AI-resolution store the Changes tab drives: `activePath` decides whether
  // the selected file shows the AI streaming view or the manual editor, and
  // `startAll` kicks off a "resolve all" walk. It selects files via the main UI store,
  // so its paths bleed across surfaces — and here they live in a HIDDEN worktree. The
  // store drops any armed walk on a repo or tab switch, so this surface can't adopt
  // one started in another repo or tab; finer per-tree scoping remains deferred.
  const startAll = useConflictResolve((s) => s.startAll);
  const activePath = useConflictResolve((s) => s.activePath);
  const stopResolveWalk = useConflictResolve((s) => s.stop);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  // Leaving the takeover must disarm the walk: a leftover `activePath` pointing into
  // the hidden worktree would otherwise hijack the Changes tab's selection.
  useEffect(() => () => stopResolveWalk(), [stopResolveWalk]);

  const conflicted = conflictedEntries(status.data?.entries ?? []);
  const conflictedPaths = conflicted.map((e) => e.path);

  // Keep a valid selection: default to the first conflict, and drop it once that
  // file is resolved (leaves the list). Following `activePath` lets an AI
  // "resolve all" run visibly walk the list as each file completes.
  useEffect(() => {
    const paths = conflictedEntries(status.data?.entries ?? []).map(
      (e) => e.path,
    );
    if (activePath && paths.includes(activePath)) {
      setSelectedPath(activePath);
      return;
    }
    setSelectedPath((cur) => {
      if (cur && paths.includes(cur)) return cur;
      return paths[0] ?? null;
    });
  }, [activePath, status.data]);

  const remaining = conflictedPaths.length;
  // Gated on a SUCCESSFUL read: an errored status query (a worktree that vanished
  // underneath us) leaves no entries, which would otherwise read as "all resolved".
  const done = status.isSuccess && remaining === 0;
  const canResolveWithAi = aiEnabled && reviewConfigured && remaining > 0;
  const busy = finish.isPending || abort.isPending;

  function onFinish() {
    finish.mutate(
      { head, worktreePath, worktreeId },
      {
        onSuccess: (outcome) => {
          if (outcome.status === "pushed") {
            toast.success(`Conflicts resolved — pushed ${head}`);
            onDone();
            return;
          }
          // Unreachable by contract: finish either pushes or errors — it never hands
          // back conflicts (that shape belongs to the local sibling's rebase path).
          // Surfaced rather than swallowed, so a contract drift can't pass silently.
          toastError(
            new Error("The resolve finished with an unexpected result."),
          );
        },
        onError: toastError,
      },
    );
  }

  async function onAbort() {
    if (!(await useConfirm.getState().ask(DISCARD_RESOLVE_CONFIRM))) return;
    abort.mutate(
      { worktreePath },
      {
        onSuccess: () => {
          toast.success("Resolution discarded");
          onDone();
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
      {/* Header: names the merge direction and where the result lands, with the
          batch AI action, Discard, and Finish (gated on zero remaining conflicts). */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b px-3 py-2 text-xs">
        <span className="flex min-w-0 items-center gap-1.5 text-warning">
          <WarningIcon className="size-3.5 shrink-0" />
          {/* Wraps rather than truncates — this sentence is the only place the
              direction and the push are stated, so it can never be cut off. */}
          <span className="min-w-0">
            Merging <span className="font-mono">{base}</span> into{" "}
            <span className="font-mono">{head}</span> — finishing pushes the
            result to the pull request.
          </span>
        </span>
        <div className="flex items-center gap-1.5">
          {canResolveWithAi && (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
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
            Discard
          </Button>
          <DisabledReasonButton
            size="xs"
            disabled={busy || remaining > 0}
            reason={remaining > 0 ? "Resolve every conflict first" : undefined}
            onClick={onFinish}
          >
            {finish.isPending && <Spinner data-icon="inline-start" />}
            Finish &amp; push
          </DisabledReasonButton>
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
                All conflicts resolved — Finish to push the updated branch.
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
              All conflicts resolved — Finish to push the updated branch.
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
