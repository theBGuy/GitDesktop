import { toast } from "sonner";
import { create } from "zustand";
import { pruneWorktrees, removeWorktree } from "@/lib/git/worktree";
import { queryClient } from "@/lib/query-client";
import { toastError } from "@/lib/toast";

/** A worktree removal the app is still waiting on. */
export interface WorktreeRemoval {
  /** Absolute path of the worktree being removed (as git reports it). */
  path: string;
  /** What to call it on screen — its branch, or the folder name when detached. */
  name: string;
  /** Epoch ms the removal started. */
  startedAt: number;
}

/** The open delete dialog's hooks for the removal it launched. */
export interface RemovalListener {
  /** The worktree is gone; the dialog has nothing left to confirm. */
  onSuccess: () => void;
  /** Removal failed. `force` is what the attempt used, so the dialog can tell a
   *  "needs --force" refusal from a real failure. */
  onError: (error: unknown, force: boolean) => void;
}

interface WorktreeRemovalState {
  /** repoPath → worktree path → the removal in flight. Keyed by repo so a repo
   *  switch reads an empty set rather than another repo's removals. */
  byRepo: Record<string, Record<string, WorktreeRemoval>>;
  /** Starts a removal and keeps it visible until it settles. Returns null once
   *  started, or the reason it was refused: a second attempt on the same
   *  worktree only queues behind the per-repo git lock and then removes nothing. */
  startRemoval: (args: {
    repoPath: string;
    path: string;
    name: string;
    force: boolean;
  }) => string | null;
}

/** Removal outlives the dialog that started it, so the outcome goes to the
 *  NEWEST dialog still mounted for that target — and to a toast when none is.
 *  That keeps every failure to exactly one, live surface. A stack rather than
 *  one slot: each disposer splices only itself, so an unmounted dialog can
 *  never linger as a stale recipient while a mounted one exists. Listeners
 *  never affect rendering, so they live beside the store, not in its state. */
const listeners = new Map<string, RemovalListener[]>();
// NUL is the one separator no filesystem path can contain — POSIX allows `:`,
// so ("a::b", "c") and ("a", "b::c") would share a "::"-joined key.
const listenerKey = (repoPath: string, path: string) =>
  `${repoPath}\u0000${path}`;

/** Registers a dialog's outcome handlers for one target; call the returned
 *  function on unmount. */
export function registerRemovalListener(
  repoPath: string,
  path: string,
  listener: RemovalListener,
): () => void {
  const key = listenerKey(repoPath, path);
  const stack = listeners.get(key) ?? [];
  stack.push(listener);
  listeners.set(key, stack);
  return () => {
    const cur = listeners.get(key);
    if (!cur) return;
    const i = cur.indexOf(listener);
    if (i !== -1) cur.splice(i, 1);
    if (cur.length === 0) listeners.delete(key);
  };
}

const NO_REMOVALS: WorktreeRemoval[] = [];

export const useWorktreeRemovalStore = create<WorktreeRemovalState>()(
  (set, get) => ({
    byRepo: {},

    startRemoval: ({ repoPath, path, name, force }) => {
      if (get().byRepo[repoPath]?.[path])
        return "This worktree is already being removed.";
      set((s) => ({
        byRepo: {
          ...s.byRepo,
          [repoPath]: {
            ...s.byRepo[repoPath],
            [path]: { path, name, startedAt: Date.now() },
          },
        },
      }));
      void run(repoPath, path, force);
      return null;
    },
  }),
);

function clearRemoval(repoPath: string, path: string) {
  useWorktreeRemovalStore.setState((s) => {
    const repo = s.byRepo[repoPath];
    if (!repo?.[path]) return s;
    const { [path]: _settled, ...rest } = repo;
    const { [repoPath]: _emptied, ...otherRepos } = s.byRepo;
    return {
      byRepo:
        Object.keys(rest).length > 0
          ? { ...s.byRepo, [repoPath]: rest }
          : otherRepos,
    };
  });
}

/**
 * Runs one removal to completion. There is deliberately no cancel: the backend
 * removal is uninterruptible past its first steps, and killing it midway strands
 * a half-removed worktree with a live admin entry.
 */
async function run(repoPath: string, path: string, force: boolean) {
  let failure: { error: unknown } | null = null;
  try {
    // branch=null: removing a worktree leaves its branch intact (deleting a
    // user's branch is a separate, more destructive action).
    await removeWorktree(repoPath, path, null, force);
    // Best-effort cleanup; a clean remove already drops its own admin entry.
    await pruneWorktrees(repoPath).catch(() => undefined);
  } catch (error) {
    failure = { error };
  }

  // Drop the entry before handing the outcome over, so a dialog re-offering a
  // force remove already sees its Remove button live again.
  clearRemoval(repoPath, path);
  // The same set the worktree mutations invalidate: the manager's list, plus
  // branches (a removed worktree frees its branch for checkout elsewhere).
  void queryClient.invalidateQueries({
    queryKey: ["repo", repoPath, "user-worktrees"],
  });
  void queryClient.invalidateQueries({
    queryKey: ["repo", repoPath, "branches"],
  });

  const listener = listeners.get(listenerKey(repoPath, path))?.at(-1);
  if (!failure) {
    toast.success("Worktree removed");
    listener?.onSuccess();
    return;
  }
  if (listener) listener.onError(failure.error, force);
  else toastError(failure.error);
}

/** The removals in flight for one repo, oldest first. */
export function useWorktreeRemovals(repoPath: string): WorktreeRemoval[] {
  const entries = useWorktreeRemovalStore((s) => s.byRepo[repoPath]);
  if (!entries) return NO_REMOVALS;
  return Object.values(entries).sort((a, b) => a.startedAt - b.startedAt);
}

/** True while this exact worktree is being removed. */
export function useIsRemovingWorktree(
  repoPath: string,
  path: string | undefined,
): boolean {
  return useWorktreeRemovalStore((s) =>
    Boolean(path && s.byRepo[repoPath]?.[path]),
  );
}
