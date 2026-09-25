import {
  queryOptions,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import * as api from "../api";
import type { DiffStatEntry } from "../types";
import { keepPreviousDataForRepo, repoKeys } from "./core";

export const HISTORY_PAGE_SIZE = 200;

/** Paged commit log; `data.pages.flat()` is the loaded history. */
export function useLog(repo: string) {
  return useInfiniteQuery({
    queryKey: repoKeys.log(repo),
    queryFn: ({ pageParam }) => api.gitLog(repo, HISTORY_PAGE_SIZE, pageParam),
    // Local reads must not park on react-query's default "online" mode offline;
    // the same holds for every `networkMode` in this file.
    networkMode: "always",
    initialPageParam: 0,
    // The next page skips everything loaded so far; a short page means
    // history is exhausted.
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < HISTORY_PAGE_SIZE
        ? undefined
        : allPages.reduce((n, p) => n + p.length, 0),
  });
}

/** Whole-history search by commit message, paged. Idle until `query` is set. */
export function useCommitSearch(repo: string, query: string) {
  const q = query.trim();
  return useInfiniteQuery({
    queryKey: ["repo", repo, "log-search", q] as const,
    queryFn: ({ pageParam }) =>
      api.gitLog(repo, HISTORY_PAGE_SIZE, pageParam, q),
    enabled: q.length > 0,
    networkMode: "always",
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < HISTORY_PAGE_SIZE
        ? undefined
        : allPages.reduce((n, p) => n + p.length, 0),
  });
}

// Shared query definitions so the hook and the prefetch path can't drift.
// Commits are immutable, so once fetched their data never goes stale.
const commitDetailsOptions = (repo: string, hash: string) =>
  queryOptions({
    queryKey: repoKeys.commitDetails(repo, hash),
    queryFn: () => api.gitCommitDetails(repo, hash),
    staleTime: Number.POSITIVE_INFINITY,
    networkMode: "always",
  });

const commitFilesOptions = (repo: string, hash: string) =>
  queryOptions({
    queryKey: repoKeys.commitFiles(repo, hash),
    queryFn: () => api.gitCommitFiles(repo, hash),
    staleTime: Number.POSITIVE_INFINITY,
    networkMode: "always",
  });

const commitFileDiffOptions = (repo: string, hash: string, file: string) =>
  queryOptions({
    queryKey: repoKeys.commitFileDiff(repo, hash, file),
    queryFn: () => api.gitCommitFileDiff(repo, hash, file),
    staleTime: Number.POSITIVE_INFINITY,
    networkMode: "always",
  });

export function useCommitDetails(repo: string, hash: string | null) {
  return useQuery({
    ...commitDetailsOptions(repo, hash ?? ""),
    enabled: hash !== null,
    // Keep the prior commit's content on screen while the next loads, so
    // arrowing through history doesn't flash a skeleton on every step.
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function useCommitFiles(repo: string, hash: string | null) {
  return useQuery({
    ...commitFilesOptions(repo, hash ?? ""),
    enabled: hash !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

/** `enabled` lets a caller hold the fetch off while its `file` argument is still
 *  derived from placeholder data — see the call sites for why an eager fetch there
 *  succeeds with a misleading empty diff. */
export function useCommitFileDiff(
  repo: string,
  hash: string | null,
  file: string | null,
  enabled = true,
) {
  return useQuery({
    ...commitFileDiffOptions(repo, hash ?? "", file ?? ""),
    enabled: enabled && hash !== null && file !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

/** Warms a commit's detail view (header + files + the first file's diff) on row hover
 *  and for rows adjacent to the selection, so keyboard arrowing stays ahead.
 *  prefetchQuery no-ops once cached, so repeats are free. */
export function usePrefetchCommit(repo: string) {
  const queryClient = useQueryClient();
  return useCallback(
    async (hash: string) => {
      queryClient.prefetchQuery(commitDetailsOptions(repo, hash));
      await queryClient.prefetchQuery(commitFilesOptions(repo, hash));
      const files = queryClient.getQueryData<DiffStatEntry[]>(
        repoKeys.commitFiles(repo, hash),
      );
      const first = files?.[0]?.path;
      if (first) {
        queryClient.prefetchQuery(commitFileDiffOptions(repo, hash, first));
      }
    },
    [queryClient, repo],
  );
}

/** Warms a single file's diff within a commit (row hover / adjacent file). */
export function usePrefetchCommitFileDiff(repo: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (hash: string, file: string) =>
      queryClient.prefetchQuery(commitFileDiffOptions(repo, hash, file)),
    [queryClient, repo],
  );
}

/** Debounces hover prefetches so sweeping the pointer down a long list doesn't spawn a
 *  prefetch (and its git subprocess) for every row it crosses. Keyboard-neighbor
 *  prefetch stays immediate. */
export function useHoverPrefetch(delay = 100) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback(
    (run: () => void) => {
      clearTimeout(timer.current);
      timer.current = setTimeout(run, delay);
    },
    [delay],
  );
}

/** Commit history for a single file (follows renames), paged. */
export function useFileLog(repo: string, path: string | null) {
  return useInfiniteQuery({
    queryKey: ["repo", repo, "file-log", path ?? ""] as const,
    queryFn: ({ pageParam }) =>
      api.gitFileLog(repo, path ?? "", HISTORY_PAGE_SIZE, pageParam),
    enabled: path !== null && path !== "",
    networkMode: "always",
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < HISTORY_PAGE_SIZE
        ? undefined
        : allPages.reduce((n, p) => n + p.length, 0),
  });
}

/** `git blame` for a file — at the working tree, or as of `rev` when given. */
export function useBlame(
  repo: string,
  path: string | null,
  rev?: string | null,
) {
  return useQuery({
    queryKey: ["repo", repo, "blame", path ?? "", rev ?? ""] as const,
    queryFn: () => api.gitBlame(repo, path ?? "", rev),
    enabled: path !== null && path !== "",
    staleTime: 60_000,
    networkMode: "always",
  });
}

/** Raw working-tree text of a repo-relative file — the Code TODOs excerpt fallback when
 *  `git blame` refuses the file (an untracked but `--untracked`-scanned file). `enabled`
 *  defers the read until blame has errored, so tracked files never pay for it. */
export function useFileText(repo: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "file-text", path] as const,
    // readTextFile takes an ABSOLUTE path; join like readReadme does.
    queryFn: () => api.readTextFile(`${repo}/${path}`),
    enabled: Boolean(repo) && path !== "" && enabled,
    staleTime: 30_000,
    networkMode: "always",
  });
}

export function useCommitAuthors(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "commit-authors"] as const,
    queryFn: () => api.gitCommitAuthors(repo),
    staleTime: 60_000,
    networkMode: "always",
  });
}

/** Working-tree TODO/FIXME/HACK scan. A heavy `git grep`, so gated on the tab being
 *  active (<Activity> keeps the panel mounted but doesn't defer fetches). Keyed on the
 *  marker set (the chips drive the scan, not a client filter) and on `maxHits`, which is
 *  passed explicitly so the panel's truncated count and the backend cap can't drift. */
export function useTodoScan(
  repo: string,
  markers: string[],
  maxHits: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "todo-scan", markers, maxHits] as const,
    queryFn: () => api.gitTodoScan(repo, markers, maxHits),
    enabled: Boolean(repo) && enabled,
    staleTime: 30_000,
    networkMode: "always",
  });
}

/** Invalidates the repo's TODO-scan queries (the detail pane's Rescan), keeping the
 *  query key owned here instead of leaking the literal into the feature. */
export function useTodoScanInvalidate(repo: string) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: ["repo", repo, "todo-scan"] });
}
