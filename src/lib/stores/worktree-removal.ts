import { toast } from "sonner";
import { create } from "zustand";
import { gitCheckoutBranch, gitStashAll, validateRepo } from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import { repoKeys, worktreeKey } from "@/lib/git/queries";
import { pruneWorktrees, removeWorktree } from "@/lib/git/worktree";
import { queryClient } from "@/lib/query-client";
import { toastError } from "@/lib/toast";
import { useUiStore } from "./ui";

/** A worktree removal the app is still waiting on. */
export interface WorktreeRemoval {
  /** Absolute path of the worktree being removed (as git reports it). */
  path: string;
  /** What to call it on screen — its branch, or the folder name when detached. */
  name: string;
  /** Epoch ms the removal started. */
  startedAt: number;
  /** Which step of a promote this entry is on. Set only by the promote path — a
   *  plain delete leaves it undefined, and the removal ends with its own step. */
  promotePhase?: "removing" | "stashing" | "checking-out";
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
   *  switch reads an empty set rather than another repo's removals.
   *
   *  The repo key is ALWAYS the ui store's repoPath spelling (`RepoInfo.root`),
   *  because every consumer reads it from there; the worktree key is git's list
   *  spelling. A writer holding git's spelling of the repo (the promote path)
   *  must resolve it through `validateRepo` first, or its entry lands in a
   *  bucket the banner and the manager's rows never read. */
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
  /** Starts a promote — remove the worktree to free its branch, then check that
   *  branch out in the main workspace — and keeps its removal step visible the
   *  same way `startRemoval` does. Returns null once started, or the reason it
   *  was refused. Every precondition is the caller's to check first; this runs
   *  past the point of no return with no dialog left to report to. */
  startPromote: (args: {
    /** The main workspace, and the repo the app is switched onto to run this. */
    mainPath: string;
    /** The worktree whose folder goes away to free the branch. */
    worktreePath: string;
    /** The branch to check out in the main workspace once it's free. */
    branch: string;
    /** Stash the main workspace's own uncommitted changes before checking out. */
    willStash: boolean;
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

/** True while this worktree is being removed, whichever spelling either path
 *  arrived in — the promote path holds git's, the delete path the ui store's. */
function isRemovalInFlight(
  byRepo: Record<string, Record<string, WorktreeRemoval>>,
  repoPath: string,
  path: string,
): boolean {
  const repo = normPath(repoPath);
  const target = normPath(path);
  return Object.entries(byRepo).some(
    ([r, entries]) =>
      normPath(r) === repo &&
      Object.keys(entries).some((p) => normPath(p) === target),
  );
}

/** Main workspaces with a promote running, keyed by {@link normPath} so the two
 *  spellings can't both pass. Two promotes into the same checkout would fight
 *  over the final `gitCheckoutBranch`, and the dialog that started the first is
 *  gone by then — so the latch lives here, not in a component ref. */
const promotingMains = new Set<string>();

/** Worktrees claimed by a promote, keyed by {@link normPath} and GLOBAL rather
 *  than per-repo: a promote reserves its source before it knows which repo key
 *  it will mark under, and the same folder can be targeted from another
 *  checkout's context. Deliberately NOT a `byRepo` entry — that map paints the
 *  banner, and a promote that fails `validateRepo` would leave a removal on
 *  screen that never started. */
const promotingWorktrees = new Set<string>();

/** True while a promote has claimed this worktree. A FIRE-TIME check only:
 *  {@link promotingWorktrees} is deliberately not store state, so nothing
 *  re-renders when it changes — call this where a mutation would start, never
 *  to decide what a component paints. */
export function isWorktreePromoting(path: string): boolean {
  return promotingWorktrees.has(normPath(path));
}

/** The refusal every surface shows for a worktree a promote has claimed — one
 *  spelling, so the store's refusals and the callers' can't drift apart. */
export const WORKTREE_PROMOTING_MESSAGE = "This worktree is being promoted.";

// `_set` unused: every write goes through the module-level helpers below, so a
// runner that outlives its dialog reaches state the same way the starters do.
export const useWorktreeRemovalStore = create<WorktreeRemovalState>()(
  (_set, get) => ({
    byRepo: {},

    startRemoval: ({ repoPath, path, name, force }) => {
      // Matched on the directory, not the string: today's callers all spell it
      // the ui store's way, but the admission rule shouldn't depend on that.
      if (isRemovalInFlight(get().byRepo, repoPath, path))
        return "This worktree is already being removed.";
      if (promotingWorktrees.has(normPath(path)))
        return WORKTREE_PROMOTING_MESSAGE;
      markRemoval(repoPath, path, name);
      void run(repoPath, path, force);
      return null;
    },

    startPromote: ({ mainPath, worktreePath, branch, willStash }) => {
      // `mainPath` is git's spelling; the entry this would collide with was
      // written under the ui store's. Match on the directory, not the string.
      if (isRemovalInFlight(get().byRepo, mainPath, worktreePath))
        return "This worktree is already being removed.";
      if (promotingWorktrees.has(normPath(worktreePath)))
        return WORKTREE_PROMOTING_MESSAGE;
      if (promotingMains.has(normPath(mainPath)))
        return "Another worktree is already being promoted to your main workspace.";
      promotingMains.add(normPath(mainPath));
      // Claim the source worktree BEFORE the first await: `validateRepo` plus
      // the repo switch is long enough for a delete of the same folder to be
      // accepted, and this promote's dialog has already closed.
      promotingWorktrees.add(normPath(worktreePath));
      void runPromote(mainPath, worktreePath, branch, willStash);
      return null;
    },
  }),
);

function markRemoval(
  repoPath: string,
  path: string,
  name: string,
  promotePhase?: WorktreeRemoval["promotePhase"],
) {
  useWorktreeRemovalStore.setState((s) => ({
    byRepo: {
      ...s.byRepo,
      [repoPath]: {
        ...s.byRepo[repoPath],
        [path]: { path, name, startedAt: Date.now(), promotePhase },
      },
    },
  }));
}

/** Moves an existing entry on to the next promote step; a missing entry is a
 *  defensive no-op. */
function advancePromotePhase(
  repoKey: string,
  path: string,
  phase: WorktreeRemoval["promotePhase"],
) {
  useWorktreeRemovalStore.setState((s) => {
    const entry = s.byRepo[repoKey]?.[path];
    if (!entry) return s;
    return {
      byRepo: {
        ...s.byRepo,
        [repoKey]: {
          ...s.byRepo[repoKey],
          [path]: { ...entry, promotePhase: phase },
        },
      },
    };
  });
}

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

/** Drops the entry and refreshes what a settled removal changed: the manager's
 *  list, plus branches (a removed worktree frees its branch for checkout
 *  elsewhere) — the same set the worktree mutations invalidate. */
function settleRemoval(repoPath: string, path: string) {
  clearRemoval(repoPath, path);
  void queryClient.invalidateQueries({ queryKey: worktreeKey(repoPath) });
  void queryClient.invalidateQueries({ queryKey: repoKeys.branches(repoPath) });
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
  settleRemoval(repoPath, path);

  const listener = listeners.get(listenerKey(repoPath, path))?.at(-1);
  if (!failure) {
    toast.success("Worktree removed");
    listener?.onSuccess();
    return;
  }
  if (listener) listener.onError(failure.error, force);
  else toastError(failure.error);
}

/** Remove a worktree while keeping its branch, retrying once if the folder is
 *  momentarily still held. The app has just switched off this worktree, but its
 *  last in-flight git-status poll (or the OS) can keep the directory busy for a
 *  beat — and `openRepo`'s switch is deferred by a View Transition, so the app
 *  may not have fully let go yet. The retry covers that window; a real, lasting
 *  hold (an editor/terminal in the folder) still surfaces the actionable error. */
async function removeWorktreeFreeingBranch(repoPath: string, path: string) {
  try {
    await removeWorktree(repoPath, path, null, false);
  } catch (e) {
    // Path stripped before matching — a folder NAMED e.g. "docs-in-use" must
    // not read as a transient hold.
    const msg = String((e as { message?: string })?.message ?? e).replaceAll(
      path,
      "",
    );
    if (/close any program|in use|being used|invalid argument/i.test(msg)) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await removeWorktree(repoPath, path, null, false);
    } else {
      throw e;
    }
  }
}

/**
 * Runs one promote to completion: free the branch (remove its worktree, keep the
 * branch) then check it out in the main workspace. Store-owned so the composite
 * survives its dialog, which closes as soon as the store accepts the promote;
 * the main workspace's own removal line carries it step by step, and its removal
 * step shows in the manager's row like any other.
 *
 * The generic removal toast and the listener stack stay out of this path: they
 * are the delete dialog's contract, and promote ends on its own composite toast.
 */
async function runPromote(
  mainPath: string,
  worktreePath: string,
  branch: string,
  willStash: boolean,
) {
  // Track how far the composite got. Once the worktree is removed we're past
  // the point of no return: a later failure needs recovery guidance (the
  // folder is gone, the branch is free but unchecked-out), not git's raw error.
  let removed = false;
  let stashed = false;
  // The key the removal entry was marked under, or null once it has settled.
  let markedKey: string | null = null;
  try {
    // Verify the main workspace is reachable BEFORE any mutation: a
    // moved/unmounted main path would otherwise let the app stay on the
    // worktree while we go on to delete it. Throwing here aborts cleanly.
    const info = await validateRepo(mainPath);
    // The spelling every consumer keys by (see `byRepo`), including the
    // invalidations below, which have to hit the mounted query keys. The git
    // calls keep taking `mainPath`; either spelling works for git.
    const activeKey = info.root;
    // Move the app onto the main workspace — we're about to delete this
    // worktree's folder, and nothing should keep reading git status inside it.
    // There's no fs-watcher (status is polled), so switching away stops future
    // polls; `removeWorktreeFreeingBranch` retries once for any last in-flight
    // poll that hasn't drained (openRepo's switch is deferred by a transition).
    useUiStore.getState().openRepo(info);
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Main is the active repo now, so the removal is visible where the user is.
    markRemoval(activeKey, worktreePath, branch, "removing");
    markedKey = activeKey;
    // Free the branch: remove the worktree but KEEP the branch (null) — we
    // check it out in main next. force=false: the clean-tree guard already ran.
    await removeWorktreeFreeingBranch(mainPath, worktreePath);
    removed = true;
    await pruneWorktrees(mainPath).catch(() => undefined);
    // The removed row has to leave the manager's list now, while the entry
    // stays on to report the tail: these are `settleRemoval`'s invalidations
    // without its clear.
    void queryClient.invalidateQueries({ queryKey: worktreeKey(activeKey) });
    void queryClient.invalidateQueries({
      queryKey: repoKeys.branches(activeKey),
    });
    advancePromotePhase(
      activeKey,
      worktreePath,
      willStash ? "stashing" : "checking-out",
    );
    // The branch's working tree is free now; stash main's own WIP (if any) so
    // the checkout can't be blocked, then land main on the promoted branch.
    if (willStash) {
      await gitStashAll(mainPath);
      stashed = true;
      advancePromotePhase(activeKey, worktreePath, "checking-out");
    }
    await gitCheckoutBranch(mainPath, branch);
    settleRemoval(activeKey, worktreePath);
    markedKey = null;
    await queryClient.invalidateQueries({ queryKey: repoKeys.all(activeKey) });
    toast.success(
      willStash
        ? `Promoted ${branch} — your main workspace changes were stashed; Pop latest stash brings them back`
        : `Promoted ${branch} to your main workspace`,
    );
  } catch (e) {
    // Never leave the removal line spinning over a step that has stopped.
    if (markedKey) settleRemoval(markedKey, worktreePath);
    if (removed) {
      // The worktree is already gone and the branch is free but not checked
      // out — surface the recovery path (with git's error as the detail).
      toast.error(
        `Removed the worktree, but couldn't check out ${branch} in your main workspace — switch to it there manually.${
          stashed ? " Your changes are stashed — use Pop latest stash." : ""
        }`,
        { description: e instanceof Error ? e.message : String(e) },
      );
    } else {
      toastError(e);
    }
  } finally {
    // Same expressions `startPromote` claimed under, or a latch never releases.
    promotingMains.delete(normPath(mainPath));
    promotingWorktrees.delete(normPath(worktreePath));
  }
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
