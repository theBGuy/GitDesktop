import { create } from "zustand";
import { useUiStore } from "./ui";

/**
 * Drives AI conflict resolution in the diff pane. `activePath` is the conflicted
 * file currently in resolution mode (the diff pane swaps to its ConflictResolveView
 * when the selection matches); `queue` is the remaining files to walk in a
 * "resolve all" run; `scopePath` is the tree those paths belong to. The streaming +
 * accept lifecycle lives in the component — this store only tracks which file is
 * active, what's next, and whose tree it is.
 *
 * Exactly one walk at a time: starting a new one replaces whatever was armed,
 * whatever its scope. ConflictResolveView therefore reads `queue`/`advance`/`stop`
 * ungated — it only ever mounts under a scope-matched parent, so the single walk it
 * finds is its own.
 *
 * Not a liveness signal: a walk outlives the surface that armed it (nothing disarms
 * one when a takeover's worktree is finished or discarded), so a non-null
 * `activePath` means a walk EXISTS, not that one is running. Gate on scope.
 */
interface ConflictResolveState {
  /** The conflicted file with an active resolution session, or null. */
  activePath: string | null;
  /** Remaining conflicted paths to resolve in sequence (excludes `activePath`).
   *  Empty for a single-file resolve. */
  queue: string[];
  /** The tree this walk belongs to — the main working tree's `repoPath`, or a
   *  resolve worktree's path for the PR takeovers; null when idle. Readers compare
   *  it to their own tree and ignore a walk scoped elsewhere, so a walk can never
   *  be adopted by a surface looking at different files. */
  scopePath: string | null;

  /** Resolve one file (context-menu / diff-pane button) in `scope`'s tree. Selects
   *  it so the diff pane shows its resolution view. */
  startOne: (path: string, scope: string) => void;
  /** Resolve a list of conflicted files in `scope`'s tree in sequence (the banner's
   *  "Resolve all"). No-op on an empty list. */
  startAll: (paths: string[], scope: string) => void;
  /** This file is done (accepted) or skipped — move to the next queued file, or
   *  end the run when the queue is empty. */
  advance: () => void;
  /** End the run entirely (discard / cancel / Esc). */
  stop: () => void;
}

/** Select a conflicted file so the working-tree diff pane shows it (conflicts
 *  always live on the unstaged side) — MAIN-tree walks only. A takeover walk's
 *  paths are relative to a hidden worktree, so steering the changes list with them
 *  points it at the wrong tree's files; those surfaces follow `activePath` with
 *  their own local selection instead. */
function selectConflicted(path: string, scope: string | null) {
  const ui = useUiStore.getState();
  if (scope !== ui.repoPath) return;
  ui.selectFile({ path, staged: false, untracked: false });
}

export const useConflictResolve = create<ConflictResolveState>()(
  (set, get) => ({
    activePath: null,
    queue: [],
    scopePath: null,

    startOne: (path, scope) => {
      set({ activePath: path, queue: [], scopePath: scope });
      selectConflicted(path, scope);
    },

    startAll: (paths, scope) => {
      if (paths.length === 0) return;
      const [first, ...rest] = paths;
      set({ activePath: first, queue: rest, scopePath: scope });
      selectConflicted(first, scope);
    },

    advance: () => {
      const { queue, scopePath } = get();
      if (queue.length === 0) {
        set({ activePath: null, queue: [], scopePath: null });
        return;
      }
      const [next, ...rest] = queue;
      set({ activePath: next, queue: rest });
      selectConflicted(next, scopePath);
    },

    stop: () => set({ activePath: null, queue: [], scopePath: null }),
  }),
);

// A walk belongs to one tree and every reader gates on `scopePath`, so no other
// surface can adopt it — a tab switch leaves it armed (an `<Activity>`-hidden view
// cancels its stream on effect cleanup and restarts it on show). A repo switch still
// ends it: this store is separate, so the ui store's CROSS_REPO_RESET can't reach it.
// Subscriptions fire synchronously inside the ui setter, ahead of the commit that
// flips visibility.
useUiStore.subscribe((s, prev) => {
  if (s.repoPath === prev.repoPath) return;
  const { activePath, queue } = useConflictResolve.getState();
  if (activePath !== null || queue.length > 0) {
    useConflictResolve.setState({
      activePath: null,
      queue: [],
      scopePath: null,
    });
  }
});
