import {
  type MutationCache,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";
import { useMutation } from "@/lib/started-mutation";
import * as api from "../api";
import { keepPreviousDataForRepo } from "./core";
import { useMutationCacheSnapshot, useRepoMutation } from "./internal";
import {
  pendingMutationEntries,
  pendingTagPushesFor,
  type ReleaseWriteVars,
  releaseWriteKey,
  type TagPushState,
  tagPushKey,
} from "./pr-writes";

/** Pushes a tag to origin, so it keeps the default and pauses offline. Keyed per
 *  repo with the tag in the variables: {@link usePendingTagPushes} reads every
 *  push in flight, whichever mount fired it. */
export function usePushTag(repo: string) {
  return useRepoMutation(repo, (name: string) => api.gitPushTag(repo, name), {
    identity: tagPushKey(repo),
  });
}

const NO_PENDING_TAG_PUSHES: TagPushState[] = [];

/** The tags of `repo` with a push in flight, read from the mutation cache: the
 *  history rows and the tag detail hold on it, so a remount or a switch back
 *  still sees a push an earlier mount started. */
export function usePendingTagPushes(repo: string): TagPushState[] {
  const select = useCallback(
    (cache: MutationCache) =>
      pendingTagPushesFor(
        pendingMutationEntries(
          cache.findAll({ mutationKey: tagPushKey(repo), status: "pending" }),
        ),
        repo,
      ),
    [repo],
  );
  return useMutationCacheSnapshot(select, NO_PENDING_TAG_PUSHES);
}

export function useDeleteLocalTag(repo: string) {
  return useRepoMutation(
    repo,
    (name: ReleaseWriteVars["delete-local-tag"]) =>
      api.gitDeleteLocalTag(repo, name),
    {
      // Local tag write — never park it offline.
      networkMode: "always",
      identity: releaseWriteKey("delete-local-tag", repo),
    },
  );
}

/** Pushes the deletion to origin, so it keeps the default and pauses offline. */
export function useDeleteTagOnOrigin(repo: string) {
  return useRepoMutation(
    repo,
    (name: ReleaseWriteVars["delete-origin-tag"]) =>
      api.gitDeleteTagOnOrigin(repo, name),
    { identity: releaseWriteKey("delete-origin-tag", repo) },
  );
}

// ── Tags & Releases ──────────────────────────────────────────────────────────

export function useTagList(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "tags"] as const,
    queryFn: () => api.gitListTags(repo),
    staleTime: 30_000,
    // Local reads must not park on react-query's default "online" mode offline;
    // the same holds for every `networkMode` in this file.
    networkMode: "always",
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
    networkMode: "always",
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
      // Pinned: the call and its invalidation close over `repo`, and the dialog
      // host survives a repo switch — without the key the newly-live repo's
      // controls would read the pending create as busy.
      identity: ["create-release", repo],
    },
  );
}

export function useEditRelease(repo: string) {
  return useRepoMutation(
    repo,
    (args: ReleaseWriteVars["edit-release"]) =>
      api.forgeReleaseEdit(
        repo,
        args.tag,
        args.title,
        args.notes,
        args.prerelease,
        args.draft,
        args.latest,
      ),
    { identity: releaseWriteKey("edit-release", repo) },
  );
}

/** Syncs the release's `latest.json` updater manifest to the edited notes. Repo
 *  mutation like the asset upload — replacing the asset changes its size/stats. */
export function useSyncUpdaterNotes(repo: string) {
  return useRepoMutation(
    repo,
    (args: ReleaseWriteVars["sync-updater"]) =>
      api.forgeReleaseSyncUpdaterNotes(repo, args.tag, args.notes),
    { identity: releaseWriteKey("sync-updater", repo) },
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
  return useRepoMutation(
    repo,
    (args: ReleaseWriteVars["delete-release"]) =>
      api.forgeReleaseDelete(repo, args.tag, args.cleanupTag),
    { identity: releaseWriteKey("delete-release", repo) },
  );
}

export function useUploadReleaseAsset(repo: string) {
  return useRepoMutation(
    repo,
    (args: ReleaseWriteVars["upload-asset"]) =>
      api.forgeReleaseUploadAsset(repo, args.tag, args.filePath),
    { identity: releaseWriteKey("upload-asset", repo) },
  );
}

export function useDeleteReleaseAsset(repo: string) {
  return useRepoMutation(
    repo,
    (args: ReleaseWriteVars["delete-asset"]) =>
      api.forgeReleaseDeleteAsset(repo, args.tag, args.assetName),
    { identity: releaseWriteKey("delete-asset", repo) },
  );
}

/** Asset download — no cache to invalidate, so a plain mutation. */
export function useDownloadReleaseAsset(repo: string) {
  return useMutation({
    mutationFn: (args: { tag: string; assetName: string; dir: string }) =>
      api.ghReleaseDownloadAsset(repo, args.tag, args.assetName, args.dir),
  });
}
