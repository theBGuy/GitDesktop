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

const lensKey = (repo: string) => ["repo", repo, "lens"] as const;

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
 * Point a repo at `lens`: write the query cache synchronously (so the UI flips
 * instantly), optionally persist to disk (fire-and-forget with an error toast),
 * and — when asked — clear any REMOTE PR/issue selection so a selected number
 * can't silently point at a different repo's item. No-op when the lens is
 * unchanged.
 *
 * Synchronous by contract, so a caller can apply the lens and navigate in the
 * same turn. That means the gate ({@link useLensGate}, an async pair of reads)
 * isn't consulted: the raw preference is written fail-open. Safe by
 * construction — {@link useRepoLens} re-gates on every read, so a repo that
 * isn't a fork keeps resolving to "origin" whatever is stored.
 *
 * A cache MISS is unknown, never "origin". The cache is cold for any repo the
 * window hasn't opened this session (and after gc), while disk may hold
 * "upstream" — so defaulting the read would let a target of "origin"
 * short-circuit as a no-op and leave the stored value to win once it loads,
 * opening the wrong pull request. Only a HOT cache that already matches skips
 * the write; a cold write is cache-only when `persist` is false, which still
 * settles the session (`lensKey` never goes stale) without touching disk.
 *
 * `persist` separates the two callers. The switcher is the user CHOOSING a
 * lens, so it writes disk. A navigation only needs the view to land on the
 * right pull request — rewriting the stored preference from a notification
 * click would outlive the visit and change what every later session opens on.
 *
 * `clearSelections` is false for a navigation that selects its own PR right
 * after (clearing would fight it) and true for the switcher, whose whole point
 * is to drop a selection minted under the old lens.
 */
export function applyRepoLens(
  queryClient: QueryClient,
  repo: string,
  lens: RemoteLens,
  { clearSelections, persist }: { clearSelections: boolean; persist: boolean },
): void {
  const current = queryClient.getQueryData<RemoteLens>(lensKey(repo));
  if (current !== undefined && current === lens) return;
  queryClient.setQueryData(lensKey(repo), lens);
  if (persist) {
    void saveRepoLens(repo, lens).catch(() => {
      toast.error("Couldn't save the fork/upstream view preference.");
    });
  }
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
