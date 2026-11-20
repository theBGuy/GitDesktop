import { useLayoutEffect } from "react";
import { useLensState, useUpstreamRemoteGone } from "@/lib/repo-lens/queries";
import { currentSegment } from "@/lib/stores/nav-history";
import { useUiStore } from "@/lib/stores/ui";

/** Keeps the current segment's lens stamp in step with the live lens of the open
 *  repository, and drops a remote selection recorded under Upstream once the
 *  repository's remotes list shows the `upstream` remote gone while the stored
 *  choice is still Upstream. */
export function useNavLensSync(repoPath: string | null): void {
  const { lens, answered, storedLens } = useLensState(repoPath ?? "");
  const upstreamGone = useUpstreamRemoteGone(repoPath ?? "");
  const stamp = useUiStore((s) => currentSegment(s.navHistory)?.lens ?? null);
  const syncNavLens = useUiStore((s) => s.syncNavLens);
  // Compares the live lens with the history's stamp, never with a previous render,
  // so a flip made while this view was unmounted is caught on remount; `stamp` as a
  // dep re-stamps a history re-seeded behind the hook (a repo switch). A layout
  // effect, so the re-seed lands in the commit that renders the flipped lens.
  useLayoutEffect(() => {
    if (repoPath === null) return;
    // A remote item recorded under Upstream would resolve against the fork once the
    // remote is gone. Ahead of `answered`, which also waits on the forge status:
    // the panels already render the fork meanwhile. Positive evidence only (a list
    // answered without the remote); an unchanged stored choice, since a switch to
    // Fork clears through applyRepoLens and its navigation then selects its own item.
    if (stamp === "upstream" && storedLens === "upstream" && upstreamGone) {
      const ui = useUiStore.getState();
      // Selections are global: never prune them for a repository not on screen.
      // The live stamp, not the render's: a replayed run (Strict Mode) or a write
      // since the render already re-seeded it, and a second clear would drop more.
      if (
        ui.repoPath === repoPath &&
        currentSegment(ui.navHistory)?.lens === "upstream"
      )
        ui.clearRemoteSelections();
      // Stamped here, not behind `answered`, or the next run fires again and clears
      // a fork item picked meanwhile; the gone remote leaves "origin" the only lens.
      syncNavLens(repoPath, "origin");
      return;
    }
    if (!answered || stamp === lens) return;
    syncNavLens(repoPath, lens);
  }, [repoPath, answered, lens, stamp, storedLens, upstreamGone, syncNavLens]);
}
