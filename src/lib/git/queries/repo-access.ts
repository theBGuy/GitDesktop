import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import * as api from "../api";
import { primeCommitAuthorIndex } from "../commit-avatar";
import type { ForgeRepoWriteAccess, RemoteLens } from "../types";
import { useForgeStatus } from "./accounts";
import { repoKeys } from "./core";
import { useRepoMutation } from "./internal";

export function useForkRepo(repo: string) {
  return useRepoMutation(
    repo,
    (contributeToParent: boolean) => api.ghRepoFork(repo, contributeToParent),
    // `invalidate` replaces the default, so the repo subtree is named again
    // alongside the own-repos list the new fork joins. GitHub by construction:
    // the GitLab and Bitbucket menu arms open the host's fork page instead, so
    // only GitHub reaches this gh-backed command.
    { invalidate: [repoKeys.all(repo), ["forge-repos", "github"]] },
  );
}

export function useRepoStarStatus(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "star-status"] as const,
    queryFn: () => api.forgeRepoStarStatus(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useSetRepoStar(repo: string) {
  const queryClient = useQueryClient();
  const key = ["repo", repo, "star-status"] as const;
  return useMutation({
    mutationFn: (starred: boolean) => api.forgeRepoSetStar(repo, starred),
    onMutate: async (starred: boolean) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<boolean>(key);
      queryClient.setQueryData<boolean>(key, starred);
      return { previous };
    },
    onError: (_e, _starred, ctx) => {
      if (ctx) queryClient.setQueryData(key, ctx.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

/** The settings-management probe ({admin, owner}), behind the abstraction —
 *  GitHub admin, or GitLab Maintainer/Owner. Gates the settings surface. */
export function useRepoAdmin(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "admin"] as const,
    queryFn: () => api.forgeRepoAdmin(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The viewer's push permission on the repo behind `lens` — the PERMISSION axis
 *  the per-action forge flags don't answer. `retry: false` keeps a failed probe
 *  from a retry storm; consumers fail open on anything but `canPush === false`. */
export function useRepoWriteAccess(
  repo: string,
  lens: RemoteLens | undefined,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "write-access", lens ?? "origin"] as const,
    queryFn: () => api.forgeRepoWriteAccess(repo, lens),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The compact reasons appended to a disabled MENU ITEM's label: a disabled item
 *  drops pointer events, so a `title` never surfaces there and the explanation
 *  has to live in the label. Headline buttons use the reason helpers below. */
export const WRITE_ACCESS_ITEM_REASON = "requires write access";

export const TRIAGE_ACCESS_ITEM_REASON = "requires triage access";

/** The disabled-reason string for PUSH-gated controls, or undefined while the
 *  probe hasn't positively denied access (pending / errored / unknown all read
 *  as "allowed" so a probe outage never strips controls). */
export function writeAccessReason(
  access: ForgeRepoWriteAccess | undefined,
): string | undefined {
  if (access?.canPush !== false) return undefined;
  return `Requires write access to ${access.repo ?? "this repository"}`;
}

/** The disabled-reason for TRIAGE-gated controls (labels, assignees,
 *  milestones, review requests, hiding comments, close/reopen) — a lower tier
 *  than push, so it must be read off its own axis or a triager loses controls
 *  they hold. Pin is write-tier; locking is write-tier on GitHub but Reporter
 *  (triage) on GitLab. Same fail-open rule. */
export function triageAccessReason(
  access: ForgeRepoWriteAccess | undefined,
): string | undefined {
  if (access?.canTriage !== false) return undefined;
  return `Requires triage access to ${access.repo ?? "this repository"}`;
}

/** The active gh token's OAuth scopes — for "this needs gh auth refresh -s X"
 *  prompts on governance controls. Account-wide, so not repo-keyed. */
export function useGhScopes(host?: string) {
  return useQuery({
    queryKey: ["gh", "token-scopes", host ?? null] as const,
    queryFn: () => api.ghTokenScopes(host),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** The real avatar URL for a GitHub bot, via `gh api users/<name>[bot]` — bot logins
 *  have no `<host>/<login>.png`. Pass the bare name from {@link botLoginName}, or `null`
 *  for a non-bot / off-GitHub handle. Cached hard (the URL is stable); `retry: false`
 *  keeps a 404/offline miss from a retry storm — the caller falls back to initials on
 *  `""`. */
export function useBotAvatarUrl(name: string | null) {
  return useQuery({
    queryKey: ["bot-avatar", name] as const,
    queryFn: () => api.ghBotAvatar(name ?? ""),
    enabled: name !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 24 * 60 * 60 * 1000,
    retry: false,
  });
}

/** Batch-resolves commit-author `email → GitHub avatar` for the recent-commits window
 *  and primes the commit-avatar module, so History rows for authors with no GitHub
 *  no-reply and no Gravatar upgrade from initials. GitHub-only (gated on the detected
 *  provider, so a GitLab/Bitbucket repo never fires the commits API). 15min staleTime —
 *  the window shifts as commits land. Best-effort: `retry: false`, and the backend
 *  returns `[]` on empty-repo/offline. */
export function useCommitAuthorAvatarIndex(repo: string) {
  const provider = useForgeStatus(repo).data?.provider;
  const query = useQuery({
    queryKey: ["commit-author-avatars", repo] as const,
    queryFn: () => api.ghCommitAuthorAvatars(repo),
    enabled: repo !== "" && provider === "github",
    staleTime: 15 * 60 * 1000,
    retry: false,
  });
  // Prime the commit-avatar module whenever fresh data arrives, notifying mounted
  // rows so already-painted initials/Gravatars upgrade to the real avatar.
  const entries = query.data;
  useEffect(() => {
    if (entries) primeCommitAuthorIndex(entries);
  }, [entries]);
  return query;
}
