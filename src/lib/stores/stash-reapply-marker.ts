import { create } from "zustand";
import { useUiStore } from "./ui";

/** A reapply that conflicted, recorded so the banner can name its cause and offer
 *  the kept backup stash once every conflict is resolved. */
export interface StashReapplyMarker {
  /** The ui store's repoPath spelling at record time. */
  repoPath: string;
  /** Full hex object id of the kept backup stash entry (40, or 64 in SHA-256 repos). */
  stashSha: string;
  /** Lower-case operation word ("pull", "update", "merge", "rebase", "switch"). */
  operationLabel: string;
  /** Optional target phrase, e.g. "master", "origin/main", "feature/x". */
  detail?: string;
  /** Joins detail to the label. Default "from"; rebase passes "onto", switch "to". */
  detailPreposition?: string;
  /** Date.now() at record time — the freshness gate's anchor. The marker is
   *  recorded after the compound's `onSettled` invalidation fired, whose default
   *  `cancelRefetch` restarts any status/stash-count fetch in flight mid-compound,
   *  so a read stamped later than this carries post-compound data. The one gap: a
   *  FIRST-ever fetch started mid-compound dedupes instead of restarting, and could
   *  land later carrying pre-pop data — it needs a repo view that never read status
   *  or stash count before running the compound. */
  recordedAt: number;
}

interface StashReapplyMarkerState {
  /** The last reapply that conflicted, until its backup stash is dropped or kept.
   *  In memory only: a restart falls back to the banner's generic conflict copy. */
  marker: StashReapplyMarker | null;
  record: (marker: StashReapplyMarker) => void;
  clear: () => void;
  /** Retires `repoPath`'s marker: a later stash or reapply in that repo makes it
   *  describe the wrong event (and its backup no longer sits on top). */
  clearFor: (repoPath: string) => void;
}

export const useStashReapplyMarker = create<StashReapplyMarkerState>()(
  (set, get) => ({
    marker: null,
    record: (marker) => set({ marker }),
    clear: () => set({ marker: null }),
    clearFor: (repoPath) => {
      if (get().marker?.repoPath === repoPath) set({ marker: null });
    },
  }),
);

// In-memory per-repo state in a separate store: ui.ts's CROSS_REPO_RESET cannot
// reach it, so it clears itself on any repo change.
useUiStore.subscribe((s, prev) => {
  if (s.repoPath === prev.repoPath) return;
  if (useStashReapplyMarker.getState().marker) {
    useStashReapplyMarker.setState({ marker: null });
  }
});
