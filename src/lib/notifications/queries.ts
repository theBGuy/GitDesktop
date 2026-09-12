import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRepoIdentity } from "@/lib/git/queries";
import {
  clearNotificationOverride,
  loadNotificationOverrides,
  overrideEntry,
  type RepoNotificationOverride,
  saveRepoNotificationOverride,
} from "./overrides";

export const notificationOverridesKey = ["notification-overrides"] as const;

export function useNotificationOverrides() {
  return useQuery({
    queryKey: notificationOverridesKey,
    queryFn: loadNotificationOverrides,
  });
}

/** The open repo's override (undefined while loading or when none). Keyed by the
 *  repo's worktree-stable identity, falling back to the raw path while that
 *  resolves and for entries still stored under it. */
export function useRepoNotificationOverride(
  repoPath: string,
): RepoNotificationOverride | undefined {
  const overrides = useNotificationOverrides();
  const identity = useRepoIdentity(repoPath).data;
  if (!overrides.data) return undefined;
  return overrideEntry(overrides.data, identity ?? repoPath, repoPath);
}

export function useSaveRepoNotificationOverride(repoPath: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (override: RepoNotificationOverride) =>
      saveRepoNotificationOverride(repoPath, override),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: notificationOverridesKey }),
  });
}

export function useClearNotificationOverride() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (repoKey: string) => clearNotificationOverride(repoKey),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: notificationOverridesKey }),
  });
}
