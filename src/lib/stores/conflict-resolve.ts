import { create } from "zustand";
import { useUiStore } from "./ui";

/**
 * Drives AI conflict resolution in the diff pane. `activePath` is the conflicted
 * file currently in resolution mode (the diff pane swaps to its ConflictResolveView
 * when the selection matches); `queue` is the remaining files to walk in a
 * "resolve all" run. The streaming + accept lifecycle lives in the component —
 * this store only tracks which file is active and what's next.
 */
interface ConflictResolveState {
  /** The conflicted file with an active resolution session, or null. */
  activePath: string | null;
  /** Remaining conflicted paths to resolve in sequence (excludes `activePath`).
   *  Empty for a single-file resolve. */
  queue: string[];

  /** Resolve one file (context-menu / diff-pane button). Selects it so the diff
   *  pane shows its resolution view. */
  startOne: (path: string) => void;
  /** Resolve a list of conflicted files in sequence (the banner's "Resolve all").
   *  No-op on an empty list. */
  startAll: (paths: string[]) => void;
  /** This file is done (accepted) or skipped — move to the next queued file, or
   *  end the run when the queue is empty. */
  advance: () => void;
  /** End the run entirely (discard / cancel / Esc). */
  stop: () => void;
}

/** Select a conflicted file so the working-tree diff pane shows it (conflicts
 *  always live on the unstaged side). */
function selectConflicted(path: string) {
  useUiStore.getState().selectFile({ path, staged: false, untracked: false });
}

export const useConflictResolve = create<ConflictResolveState>()(
  (set, get) => ({
    activePath: null,
    queue: [],

    startOne: (path) => {
      set({ activePath: path, queue: [] });
      selectConflicted(path);
    },

    startAll: (paths) => {
      if (paths.length === 0) return;
      const [first, ...rest] = paths;
      set({ activePath: first, queue: rest });
      selectConflicted(first);
    },

    advance: () => {
      const { queue } = get();
      if (queue.length === 0) {
        set({ activePath: null, queue: [] });
        return;
      }
      const [next, ...rest] = queue;
      set({ activePath: next, queue: rest });
      selectConflicted(next);
    },

    stop: () => set({ activePath: null, queue: [] }),
  }),
);

// A resolve walk belongs to the repo it started in. `conflict-resolve` is a
// separate store, so the ui store's CROSS_REPO_RESET can't reach it — subscribe
// to repo changes and drop the walk here. Without this the walk survives a repo
// switch: the diff pane opens a resolution view for a path that belongs to the
// OLD tree (or, on a same-named path, resolves the wrong file), and a queued
// "resolve all" run keeps advancing through the previous repo's conflicts.
useUiStore.subscribe((s, prev) => {
  if (s.repoPath === prev.repoPath) return;
  const { activePath, queue } = useConflictResolve.getState();
  if (activePath !== null || queue.length > 0) {
    useConflictResolve.setState({ activePath: null, queue: [] });
  }
});
