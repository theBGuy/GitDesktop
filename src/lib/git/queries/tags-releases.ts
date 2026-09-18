import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import * as api from "../api";
import { keepPreviousDataForRepo } from "./core";
import { useRepoMutation } from "./internal";

export function usePushTag(repo: string) {
  return useRepoMutation(repo, (name: string) => api.gitPushTag(repo, name));
}

export function useDeleteTag(repo: string) {
  return useRepoMutation(repo, (args: { name: string; onRemote: boolean }) =>
    api.gitDeleteTag(repo, args.name, args.onRemote),
  );
}

// ── Tags & Releases ──────────────────────────────────────────────────────────

export function useTagList(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "tags"] as const,
    queryFn: () => api.gitListTags(repo),
    staleTime: 30_000,
  });
}

/** Recent commits, for the release-target picker. */
export function useRecentCommits(
  repo: string,
  limit: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "recent-commits", limit] as const,
    queryFn: () => api.gitRecentCommits(repo, limit),
    enabled,
    staleTime: 30_000,
  });
}

export function useReleaseList(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "releases"] as const,
    queryFn: () => api.forgeReleaseList(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

const releaseDetailsOptions = (repo: string, tag: string) =>
  queryOptions({
    queryKey: ["repo", repo, "release", tag] as const,
    queryFn: () => api.forgeReleaseView(repo, tag),
    staleTime: 30_000,
    // A plain tag has no release → the provider 404s; the detail treats that as
    // "no release", so don't retry the expected miss.
    retry: false,
  });

export function useReleaseDetails(repo: string, tag: string | null) {
  return useQuery({
    ...releaseDetailsOptions(repo, tag ?? ""),
    enabled: tag !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function usePrefetchRelease(repo: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (tag: string) =>
      queryClient.prefetchQuery(releaseDetailsOptions(repo, tag)),
    [queryClient, repo],
  );
}

export function useCreateRelease(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      tag: string;
      title: string;
      notes: string;
      target: string;
      prerelease: boolean;
      draft: boolean;
      latest: boolean;
    }) =>
      api.forgeReleaseCreate(
        repo,
        args.tag,
        args.title,
        args.notes,
        args.target,
        args.prerelease,
        args.draft,
        args.latest,
      ),
    {
      // Pinned: the call and its invalidation close over `repo`, and the dialog host
      // survives a repo switch — without the key a switch retargets the pending create.
      identity: ["create-release", repo],
    },
  );
}

export function useEditRelease(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      tag: string;
      title: string;
      notes: string;
      prerelease: boolean;
      draft: boolean;
      latest: boolean | undefined;
    }) =>
      api.forgeReleaseEdit(
        repo,
        args.tag,
        args.title,
        args.notes,
        args.prerelease,
        args.draft,
        args.latest,
      ),
  );
}

/** Syncs the release's `latest.json` updater manifest to the edited notes. Repo
 *  mutation like the asset upload — replacing the asset changes its size/stats. */
export function useSyncUpdaterNotes(repo: string) {
  return useRepoMutation(repo, (args: { tag: string; notes: string }) =>
    api.forgeReleaseSyncUpdaterNotes(repo, args.tag, args.notes),
  );
}

/** GitHub's auto-generated release notes (for the preview-then-edit flow). */
export function useGithubReleaseNotes(repo: string) {
  return useMutation({
    mutationFn: (args: { tag: string; target: string; previousTag: string }) =>
      api.ghReleaseGenerateNotes(repo, args.tag, args.target, args.previousTag),
  });
}

export function useDeleteRelease(repo: string) {
  return useRepoMutation(repo, (args: { tag: string; cleanupTag: boolean }) =>
    api.forgeReleaseDelete(repo, args.tag, args.cleanupTag),
  );
}

export function useUploadReleaseAsset(repo: string) {
  return useRepoMutation(repo, (args: { tag: string; filePath: string }) =>
    api.forgeReleaseUploadAsset(repo, args.tag, args.filePath),
  );
}

export function useDeleteReleaseAsset(repo: string) {
  return useRepoMutation(repo, (args: { tag: string; assetName: string }) =>
    api.forgeReleaseDeleteAsset(repo, args.tag, args.assetName),
  );
}

/** Asset download — no cache to invalidate, so a plain mutation. */
export function useDownloadReleaseAsset(repo: string) {
  return useMutation({
    mutationFn: (args: { tag: string; assetName: string; dir: string }) =>
      api.ghReleaseDownloadAsset(repo, args.tag, args.assetName, args.dir),
  });
}
