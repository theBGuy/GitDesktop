import {
  forgeAwaitingFirstAnswer,
  forgeProbeReason,
  useForgeStatus,
  useRemotes,
} from "@/lib/git/queries";

/**
 * The scope switcher's `probeReason`: non-null while the forge's first check
 * runs, unless the remotes read has answered with no remotes (a repository with
 * none never has a forge, so its row would only collapse at settle). Unknown
 * remotes, cold or failed, count as a possible forge, so an open that skips the
 * shell warm-up still holds the row from the first frame. No remote name is
 * checked: a host gh resolves on its own may sit behind any remote.
 */
export function useScopeProbeReason(repoPath: string): string | null {
  const forge = useForgeStatus(repoPath);
  const remotes = useRemotes(repoPath);
  const mayHaveForge = remotes.data === undefined || remotes.data.length > 0;
  return forgeAwaitingFirstAnswer(forge) && mayHaveForge
    ? forgeProbeReason("checking", "switch the list's scope")
    : null;
}
