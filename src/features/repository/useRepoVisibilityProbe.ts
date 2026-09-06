import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  forgeRepoVisibility,
  gitRepoOwners,
  type RepoVisibility,
} from "@/lib/git/api";
import { persistRepoOwners, persistRepoVisibility } from "@/lib/settings/api";
import { settingsKeys } from "@/lib/settings/queries";

/**
 * Probe a repo's hosted visibility + fork provenance and persist it, returning the
 * fresh probe — or `null` when no provider resolves (remote removed/absent), which
 * clears every derived field so a stale badge clears. Owner/host/provider plus the
 * remote's repo name are persisted here too, so a fresh clone shows its provider
 * label, host, and fork badge on the FIRST open, without a RepoList render
 * backfilling them.
 *
 * Shared by the ambient open-time probe below and the Danger zone's "Re-check fork
 * status", which therefore also heals the provider label after the user re-points
 * origin, and converges the fork badge without an app restart after the user leaves
 * a fork network. Persistence is serialized against the other recentRepos writers.
 *
 * Rejections propagate to the caller (the ambient probe swallows them; the Danger
 * zone toasts). Does NOT invalidate the settings query — the caller decides.
 */
export async function probeAndPersistVisibility(
  repoPath: string,
): Promise<RepoVisibility | null> {
  const [owner] = await gitRepoOwners([repoPath]);
  if (!owner?.provider) {
    // Clearing the provider also clears visibility/isFork/forkParent (they can't
    // outlive it) — all seven derived fields in one write. `owner` is undefined when
    // gitRepoOwners returns no entry (no remote at all); the null-filled entry
    // still targets this path, so the clear lands.
    await persistRepoOwners([
      {
        path: repoPath,
        owner: owner?.owner ?? null,
        host: owner?.host ?? null,
        provider: null,
        repoName: owner?.repoName ?? null,
      },
    ]);
    return null;
  }
  // Independent once gitRepoOwners resolved, so run them in parallel; the
  // Promise.all barrier keeps the owners write ahead of the visibility persist, and
  // persistRepoOwners (non-null provider) preserves the visibility fields it doesn't own.
  const [, probe] = await Promise.all([
    persistRepoOwners([owner]),
    forgeRepoVisibility(repoPath),
  ]);
  await persistRepoVisibility([
    {
      path: repoPath,
      visibility: probe.visibility,
      isFork: probe.isFork,
      forkParent: probe.parent ?? undefined,
    },
  ]);
  return probe;
}

/**
 * On every successful repo open (every `repoPath`, including app-relaunch restore),
 * fire-and-forget refresh of the repo's stored owner/visibility/fork metadata via
 * {@link probeAndPersistVisibility}. Never blocks or delays repo open and swallows
 * every error silently — ambient metadata, not a user-facing action (no toasts).
 *
 * Persists through the raw helper + a captured queryClient (both stable across
 * unmount), NOT a component-bound mutation: the repo view unmounts when the repo
 * closes, and a probe in flight then must still land. A resolved value is keyed by
 * its own repo's path, so writing it after a repo switch is never a stale
 * cross-repo write.
 */
export function useRepoVisibilityProbe(repoPath: string | null) {
  const queryClient = useQueryClient();
  // biome-ignore lint/correctness/useExhaustiveDependencies: queryClient is stable; re-run only when the open path changes
  useEffect(() => {
    if (!repoPath) return;
    (async () => {
      try {
        await probeAndPersistVisibility(repoPath);
        queryClient.invalidateQueries({ queryKey: settingsKeys.settings });
      } catch {
        // Ambient metadata — a failed probe leaves the persisted value alone.
      }
    })();
  }, [repoPath]);
}
