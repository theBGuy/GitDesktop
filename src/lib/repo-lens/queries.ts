import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { useForgeStatus, useRemotes, useRemoteUrl } from "@/lib/git/queries";
import type { RemoteLens } from "@/lib/git/types";
import { useUiStore } from "@/lib/stores/ui";
import { loadRepoLens, saveRepoLens } from "./store";

// Deliberately OUTSIDE the ["repo", …] subtree (like `useRepoIdentity`'s key):
// every repo mutation invalidates that whole prefix, and an invalidation
// refetches an active query whatever its staleTime — which would re-read disk
// and overwrite a session-only lens applied by a navigation, repainting the
// other lens's pull request under the selected number.
export const lensKey = (repo: string) => ["repo-lens", repo] as const;

/** The raw persisted lens for a repo, unfiltered by the gate. Prefer
 *  {@link useRepoLens} in surfaces — this exists so the setter and the switcher
 *  can read/write the stored preference directly. */
export function useRepoLensRaw(repo: string) {
  return useQuery({
    queryKey: lensKey(repo),
    queryFn: () => loadRepoLens(repo),
    // The store is the source of truth; there's no server to go stale against.
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** Whether the origin|upstream lens applies at all: a GitHub fork (an `upstream`
 *  remote present) is the only shape where the parent differs from origin. On
 *  GitLab/Bitbucket, or a repo with no upstream remote, the lens is a no-op and
 *  its UI stays hidden. Mirrors SyncControls' `hasUpstreamRemote` idiom. */
export function useLensGate(repo: string): boolean {
  const provider = useForgeStatus(repo).data?.provider;
  const remotes = useRemotes(repo);
  return provider === "github" && Boolean(remotes.data?.includes("upstream"));
}

/** THE lens every PR/Issues surface consumes. Returns "origin" unless the gate
 *  passes AND the persisted value is "upstream" — so removing the upstream remote
 *  silently falls back to origin without touching the store. */
export function useRepoLens(repo: string): RemoteLens {
  const gate = useLensGate(repo);
  const raw = useRepoLensRaw(repo).data;
  return gate && raw === "upstream" ? "upstream" : "origin";
}

/**
 * Point a repo at `lens`: persist it to disk when asked (fire-and-forget with an
 * error toast), write the query cache synchronously so the UI flips instantly,
 * and — when asked — clear any REMOTE PR/issue selection so a selected number
 * can't silently point at a different repo's item. A lens the cache already
 * holds is a UI no-op; the disk write is decided separately, below.
 *
 * Synchronous by contract, so a caller can apply the lens and navigate in the
 * same turn. That means the gate ({@link useLensGate}, an async pair of reads)
 * isn't consulted: the raw preference is written fail-open. Safe by
 * construction — {@link useRepoLens} re-gates on every read, so a repo that
 * isn't a fork keeps resolving to "origin" whatever is stored.
 *
 * `persist` separates the two callers. The switcher is the user CHOOSING a
 * lens, so it writes disk. A navigation only needs the view to land on the
 * right pull request — rewriting the stored preference from a notification
 * click would outlive the visit and change what every later session opens on.
 *
 * INVARIANT from that split: cache and disk DIVERGE by design once a navigation
 * applies a session-only lens, so persistence must never key off cache
 * equality. A switcher choice matching the cached value is exactly the case
 * where disk still holds the other one — hence the unconditional write, which
 * is safe because `saveRepoLens` is idempotent.
 *
 * The cache write keeps its own short-circuit, and a cache MISS is unknown
 * there, never "origin": the cache is cold for any repo the window hasn't
 * opened this session (and after gc), while disk may hold "upstream" — so
 * defaulting the read would let a target of "origin" skip the write and leave
 * the stored value to win once it loads, opening the wrong pull request. A
 * cache-only write still settles the session — {@link lensKey} sits outside the
 * ["repo", …] subtree, so no repo mutation's invalidation can refetch it back
 * to the stored value.
 *
 * `clearSelections` drops any REMOTE PR/issue selection, and only when the
 * lens actually flips — it rides the cache short-circuit, so re-applying the
 * lens already showing never touches the user's selection. Pass true whenever
 * a sibling selection minted under the old lens would outlive the flip: the
 * switcher, and any navigation whose own selection lands after this call
 * (openPr/openIssue run `beforeSelect` inside the navigator's transition
 * callback, before its set(), so the clear can't fight the landing). False
 * only where nothing re-selects afterwards.
 */
export function applyRepoLens(
  queryClient: QueryClient,
  repo: string,
  lens: RemoteLens,
  { clearSelections, persist }: { clearSelections: boolean; persist: boolean },
): void {
  // Ahead of the cache short-circuit, never behind it: an explicit choice has to
  // reach disk even when the cache already shows that lens.
  if (persist) {
    void saveRepoLens(repo, lens).catch(() => {
      toast.error("Couldn't save the fork/upstream view preference.");
    });
  }
  const current = queryClient.getQueryData<RemoteLens>(lensKey(repo));
  if (current !== undefined && current === lens) return;
  queryClient.setQueryData(lensKey(repo), lens);
  if (!clearSelections) return;
  // A remote number selected under the old lens would resolve against the
  // wrong repo — drop it. Local + Jira selections are lens-independent.
  const ui = useUiStore.getState();
  if (ui.selectedPr?.kind === "remote") ui.selectPr(null);
  if (ui.selectedIssue?.kind === "remote") ui.selectIssue(null);
}

/** The switcher's setter — {@link applyRepoLens} with the selection clears and
 *  the disk write on, since this path is the user choosing the lens. */
export function useSetRepoLens(repo: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (lens: RemoteLens) => {
      applyRepoLens(queryClient, repo, lens, {
        clearSelections: true,
        persist: true,
      });
    },
    [queryClient, repo],
  );
}

/** Drop a repo's CACHED lens back to "origin" — the companion to the store's
 *  `deleteRepoLens` for the detach path. Because {@link lensKey} sits outside
 *  the ["repo", …] subtree, no mutation's invalidation reconciles the cache with
 *  the deleted disk entry: without this, re-adding the upstream remote in the
 *  same session would resurrect the preference the delete dropped. */
export function clearRepoLensCache(
  queryClient: QueryClient,
  repo: string,
): void {
  queryClient.setQueryData<RemoteLens>(lensKey(repo), "origin");
}

/** Parse "owner/repo" from a remote's URL (both `https://host/owner/repo(.git)`
 *  and `git@host:owner/repo(.git)` forms). Returns null when the remote is
 *  absent or the URL doesn't parse. Drives the switcher tooltips, the remote
 *  section label, and the issue-create-on-parent confirm framing. */
export function useRemoteSlug(
  repo: string,
  remote: RemoteLens,
  enabled: boolean,
): string | null {
  const url = useRemoteUrl(repo, remote, enabled).data;
  return url ? slugFromRemoteUrl(url) : null;
}

/** "owner/repo" from a git remote URL, or null. Handles the SSH (`git@host:o/r`)
 *  and HTTP(S) (`https://host/o/r`) forms, with or without a trailing `.git`. */
export function slugFromRemoteUrl(url: string): string | null {
  const trimmed = url
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  // SSH: git@host:owner/repo
  const ssh = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  const path = ssh ? ssh[1] : trimmed.replace(/^[a-z]+:\/\/[^/]+\//i, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  // owner/repo are the last two path segments (GitLab subgroups collapse to the
  // final owner segment, which is fine for a display label).
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}
