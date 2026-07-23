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
 * Probe a repo's hosted visibility + fork provenance and persist the result,
 * returning the fresh probe (or `null` when the repo has no known provider — a
 * removed/absent remote, which clears every derived field so a stale badge
 * clears). Shared by the ambient open-time probe below and the Danger zone's
 * "Re-check fork status" affordance, so the fork badge + persisted `isFork`
 * converge without an app restart after the user leaves the fork network on
 * GitHub. Persistence is serialized against the other recentRepos writers.
 *
 * The owner/host/provider from `gitRepoOwners` are ALSO persisted here (not just
 * visibility/fork) — that's what makes a fresh clone's provider label, host, and
 * fork badge land on the FIRST open, without waiting for a RepoList render to
 * backfill them. The Danger-zone "Re-check fork status" therefore also refreshes
 * owners now, which is desired: after the user re-points origin then re-checks,
 * the provider label heals in the same action.
 *
 * A rejection propagates to the caller (the ambient probe swallows it; the
 * Danger-zone re-check surfaces it as a toast). Does NOT invalidate the settings
 * query — the caller decides whether to (the ambient probe does).
 */
export async function probeAndPersistVisibility(
  repoPath: string,
): Promise<RepoVisibility | null> {
  const [owner] = await gitRepoOwners([repoPath]);
  if (!owner?.provider) {
    // No resolvable provider (remote removed/absent): persistRepoOwners with a
    // null provider clears owner/host/provider AND, because visibility/isFork/
    // forkParent can't outlive the provider, those three too — all six derived
    // fields cleared in one write. (owner is undefined when gitRepoOwners
    // returns no entry for this path — e.g. no remote at all; the null-filled
    // entry still targets this path so the clear lands.)
    await persistRepoOwners([
      {
        path: repoPath,
        owner: owner?.owner ?? null,
        host: owner?.host ?? null,
        provider: null,
      },
    ]);
    return null;
  }
  // The owners write and the visibility probe are independent once gitRepoOwners
  // resolved, so run them in parallel; the Promise.all barrier still guarantees
  // the owners write completes before the visibility/fork persist below, and
  // persistRepoOwners (non-null provider) preserves the visibility fields it
  // doesn't own — so the ordering that matters is kept.
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
 * On every successful repo open (this fires for every `repoPath` — including
 * app-relaunch restore), fire-and-forget refreshes the repo's stored
 * visibility badge:
 *
 * - Resolve the provider via `gitRepoOwners` (a cheap local read) and persist
 *   the owner/host/provider onto the record. When it's null (no remote, or the
 *   remote was removed), that clears all six derived fields so a stale badge
 *   clears.
 * - When the provider is known, probe `forgeRepoVisibility` and persist the
 *   result. A rejection (signed out, API failure) persists nothing beyond the
 *   owners already stored — the prior visibility/fork value is left alone.
 *
 * Because the owner/host/provider land here, a freshly cloned repo shows its
 * provider label and fork badge on the FIRST open, not the second — this probe
 * runs even when the repo list never rendered to backfill them.
 *
 * Never blocks or delays repo open, and swallows every error silently: this is
 * ambient metadata, not a user-facing action (no toasts).
 *
 * Persistence goes through the raw helper + a captured queryClient (both stable
 * across unmount), NOT a component-bound mutation: the repo view unmounts when
 * the repo closes, and a probe in flight at that moment must still land its
 * result. A value already resolved is always persisted (it's keyed by its own
 * repo's path, so writing it after a repo switch is still correct, never a stale
 * cross-repo write). `persistRepoVisibility` is serialized against the other
 * recentRepos writers, so it can't lose an update.
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
