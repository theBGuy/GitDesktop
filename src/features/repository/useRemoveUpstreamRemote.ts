import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useRemoveRemote } from "@/lib/git/queries";
import { clearRepoLensCache } from "@/lib/repo-lens/queries";
import { deleteRepoLens } from "@/lib/repo-lens/store";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";

/** Drops the `upstream` remote and everything keyed to it, shared by the Danger
 *  zone row and the repository menu/palette action so the two can't drift. A
 *  local git-config write, so nothing here reads the admin probe. `remove`
 *  resolves whether the remote went, having toasted either way. */
export function useRemoveUpstreamRemote(repoPath: string) {
  const queryClient = useQueryClient();
  const removeRemote = useRemoveRemote(repoPath);

  async function remove(): Promise<boolean> {
    try {
      await removeRemote.mutateAsync({ name: "upstream" });
      // Hygiene: the persisted "upstream" lens no longer applies.
      // Fire-and-forget — the lens read safe-defaults to origin,
      // so a failure here is harmless. The CACHED lens drops with
      // it: its key sits outside the repo subtree this mutation
      // invalidates, so re-adding upstream in the same session
      // would otherwise resurrect the preference just deleted.
      deleteRepoLens(repoPath).catch(() => undefined);
      clearRepoLensCache(queryClient, repoPath);
      // Removing upstream collapses the lens to origin, so a still-
      // selected remote number would resolve against the other repo:
      // the same non-bumping prune a lens flip runs, and only while
      // this repo is the open one (the selections are global).
      const ui = useUiStore.getState();
      if (ui.repoPath === repoPath) ui.clearRemoteSelections();
      toast.success("Upstream remote removed");
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  }

  return { remove, isPending: removeRemote.isPending };
}
