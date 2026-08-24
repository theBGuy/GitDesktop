import {
  type QueryKey,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { isDirtyTreeRefusal } from "@/lib/error-summary";
import { reloadReviewNotes } from "@/lib/review-notes/store";
import { useUiStore } from "@/lib/stores/ui";
import { isAppError } from "@/lib/tauri/invoke";
import { COLD_START_NO_GH, COLD_START_NO_GIT } from "@/lib/test-mode";
import { toastError } from "@/lib/toast";
import * as api from "./api";
import { primeCommitAuthorIndex } from "./commit-avatar";
import {
  checkoutConflictSide,
  conflictSides,
  resolveConflict,
} from "./conflict";
import { repoIdentity } from "./repo-identity";
import type {
  BbEnvironment,
  BitbucketHookInput,
  BitbucketRepoSettingsInput,
  CiStatus,
  CommitCommentOut,
  DiffStatEntry,
  DiscussionDetails,
  DraftCommentIn,
  ForgeCapabilities,
  ForgeImplemented,
  ForgeProvider,
  ForgeRepoWriteAccess,
  ForgeSearchList,
  ForgeStatus,
  ForgeUserRef,
  GitLabHookInput,
  GitLabProtectedBranch,
  GitLabRepoSettingsInput,
  GitLabTimeStats,
  IssueDetails,
  IssueReactions,
  IssueRelation,
  IssueType,
  PrDetails,
  PrInfo,
  PrMergeabilityState,
  PrThreadOut,
  Reaction,
  RemoteLens,
  RepoOp,
  RepoRole,
  RepoSettingsInput,
  ReviewThreadOut,
  RewriteStep,
  RulesetEnforcement,
  SecretApp,
  SecurityFeature,
  UnignoreRule,
  WebhookInput,
} from "./types";
import {
  addUserWorktree,
  listUserWorktrees,
  lockWorktree,
  moveUserWorktree,
  repairWorktrees,
  unlockWorktree,
} from "./worktree";

/** A repo's worktree-stable identity key (its common git dir), for keying
 *  per-repo app-data the same across the main checkout and every worktree.
 *  Infinite staleTime — a repo's identity never changes while it's open. */
export function useRepoIdentity(repo: string) {
  return useQuery({
    queryKey: ["repo-identity", repo] as const,
    queryFn: () => repoIdentity(repo),
    enabled: repo !== "",
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * `keepPreviousData` scoped to ONE repo: panels stay mounted across repo switches, so
 * plain keepPreviousData would keep the previous repo's rows on screen (and, for
 * number-keyed maps, briefly-wrong data). Keeps previous data only when the previous
 * query's repo segment matches, so Load-more and Open/Closed switches still skip the
 * skeleton. `repoKeyIndex` is where the repo sits in the key (index 1 for every key
 * passed to it).
 * A key that also varies on an identity axis beyond repo (lens, state) needs
 * `keepPreviousDataForKeyAxes` instead (the PR and issue list hooks below do):
 * matching repo alone would serve another axis's data.
 */
export function keepPreviousDataForRepo(repo: string, repoKeyIndex = 1) {
  return <T>(
    previousData: T | undefined,
    previousQuery: { queryKey: QueryKey } | undefined,
  ): T | undefined =>
    previousQuery?.queryKey?.[repoKeyIndex] === repo ? previousData : undefined;
}

/**
 * `keepPreviousData` scoped to a repo PLUS extra key segments: previous data is reused
 * only when every listed `[index, value]` axis matches as well. The indices are
 * positional, so each call site's axes list must stay in sync with its key literal —
 * this helper dedupes that coupling, it does not remove it.
 */
export function keepPreviousDataForKeyAxes(
  repo: string,
  axes: ReadonlyArray<readonly [index: number, value: unknown]>,
  repoKeyIndex = 1,
) {
  return <T>(
    previousData: T | undefined,
    previousQuery: { queryKey: QueryKey } | undefined,
  ): T | undefined => {
    const key = previousQuery?.queryKey;
    if (!key || key[repoKeyIndex] !== repo) return undefined;
    return axes.every(([i, v]) => key[i] === v) ? previousData : undefined;
  };
}

export const repoKeys = {
  all: (repo: string) => ["repo", repo] as const,
  status: (repo: string) => ["repo", repo, "status"] as const,
  opState: (repo: string) => ["repo", repo, "op-state"] as const,
  branches: (repo: string) => ["repo", repo, "branches"] as const,
  diff: (repo: string, file: string, staged: boolean) =>
    ["repo", repo, "diff", file, staged] as const,
  commits: (repo: string) => ["repo", repo, "commits"] as const,
  log: (repo: string) => ["repo", repo, "log"] as const,
  commitDetails: (repo: string, hash: string) =>
    ["repo", repo, "commit", hash] as const,
  commitFiles: (repo: string, hash: string) =>
    ["repo", repo, "commit", hash, "files"] as const,
  commitFileDiff: (repo: string, hash: string, file: string) =>
    ["repo", repo, "commit", hash, "diff", file] as const,
  compare: (repo: string, base: string, compare: string) =>
    ["repo", repo, "compare", base, compare] as const,
  branchDiffFiles: (repo: string, base: string, compare: string) =>
    ["repo", repo, "compare", base, compare, "files"] as const,
  branchFileDiff: (repo: string, base: string, compare: string, file: string) =>
    ["repo", repo, "compare", base, compare, "diff", file] as const,
};

/**
 * The keys a working-tree write invalidates: repo status, every working-tree file diff,
 * and only the MUTABLE file-at-rev slices — `"worktree"` and the index `":0"`, which
 * staging rewrites — all prefix-matched. Staging-class mutations (stage/unstage/discard/
 * apply) pass this ALONE so they don't mark the heavy history/branches/Insights/SBOM
 * queries stale; {@link useCommit} passes it as its AWAITED set and defers what HEAD
 * moves to {@link commitAftermathKeys}. Committed-rev reads are immutable under staging.
 */
const workingTreeKeys = (repo: string) =>
  [
    repoKeys.status(repo),
    ["repo", repo, "diff"],
    ["repo", repo, "file-b64", "worktree"],
    ["repo", repo, "file-b64", ":0"],
  ] as const;

/** The families a commit (or amend) makes stale BEYOND the working tree —
 *  history, branch tips/counters, HEAD-rev blobs, and operation state, both
 *  in-flight (a commit can conclude a merge or an interrupted journaled op)
 *  and prospective (merge/conflict previews, local-PR merge states).
 *  Invalidated fire-and-forget so the Commit button never waits on them;
 *  forge-backed keys (pr/issue/CI/…) are deliberately absent — a local
 *  commit cannot change forge state. */
const commitAftermathKeys = (repo: string) =>
  [
    repoKeys.log(repo),
    repoKeys.commits(repo),
    repoKeys.branches(repo),
    ["repo", repo, "log-search"],
    ["repo", repo, "recent-commits"],
    ["repo", repo, "commit-authors"],
    ["repo", repo, "unpushed-count"],
    ["repo", repo, "unpushed-messages"],
    ["repo", repo, "branch-stats"],
    ["repo", repo, "stats"],
    ["repo", repo, "divergence"],
    ["repo", repo, "compare"],
    ["repo", repo, "file-log"],
    ["repo", repo, "blame"],
    ["repo", repo, "file-b64", "HEAD"],
    repoKeys.opState(repo),
    ["repo", repo, "conflict-file"],
    ["repo", repo, "merge-preview"],
    ["repo", repo, "conflict-preview"],
    ["repo", repo, "local-pr-merge-states"],
    ["repo", repo, "oplog-check"],
    ["repo", repo, "insights", "contributors"],
    ["repo", repo, "insights", "commit-activity"],
    ["repo", repo, "insights", "code-frequency"],
    ["repo", repo, "insights", "punch-card"],
  ] as const;

export function useGitInstalled() {
  return useQuery({
    queryKey: ["git-installed"],
    // Cold-start test mode can pretend git is absent to exercise GitMissingScreen.
    queryFn: COLD_START_NO_GIT
      ? () => Promise.reject(new Error("Git not found (cold-start test mode)"))
      : api.checkGitInstalled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useRepoStatus(repo: string) {
  return useQuery({
    queryKey: repoKeys.status(repo),
    queryFn: () => api.gitStatus(repo),
    refetchInterval: 5000,
    refetchIntervalInBackground: false,
  });
}

export function useBranches(repo: string) {
  return useQuery({
    queryKey: repoKeys.branches(repo),
    queryFn: () => api.gitBranches(repo),
  });
}

/** Commits on HEAD not on any remote — the "unpublished" count for a branch with no
 *  upstream, where `branch.ahead` is undefined (a never-pushed branch's pre-fork-point
 *  commits already live on `origin/<base>`, so the whole branch isn't unpushed).
 *  `enabled` fires it only in that case. Keyed under the repo so commit/push/fetch
 *  invalidation refetches it. */
export function useUnpushedCount(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "unpushed-count"] as const,
    queryFn: () => api.gitUnpushedCount(repo),
    enabled: enabled && Boolean(repo),
    staleTime: 10_000,
  });
}

/** Branches that exist on a remote (reflecting the last fetch), for the switcher's
 *  "Remote" group. `enabled` gates the fetch so it only runs while the menu is
 *  open, like the divergence/worktree queries. */
export function useRemoteBranches(repo: string, enabled = true) {
  return useQuery({
    queryKey: ["repo", repo, "remote-branches"] as const,
    queryFn: () => api.gitRemoteBranches(repo),
    enabled: enabled && Boolean(repo),
    staleTime: 30_000,
  });
}

export const worktreeKey = (repo: string) =>
  ["repo", repo, "user-worktrees"] as const;

/** The repo's user-facing worktrees (session worktrees filtered out by the
 *  backend). `enabled` gates the fetch so it only runs while the manager is open. */
export function useUserWorktrees(repo: string, enabled = true) {
  return useQuery({
    queryKey: worktreeKey(repo),
    queryFn: () => listUserWorktrees(repo),
    enabled: enabled && Boolean(repo),
  });
}

/** Creates a user worktree. Invalidates the worktree list + branches (a new
 *  branch may have been created). */
export function useAddUserWorktree(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      path: string;
      branch: string;
      newBranch: boolean;
      baseRef?: string;
    }) =>
      addUserWorktree(
        repo,
        args.path,
        args.branch,
        args.newBranch,
        args.baseRef,
      ),
    { invalidate: [worktreeKey(repo), repoKeys.branches(repo)] },
  );
}

/** Renames (moves) a user worktree to a new path. */
export function useMoveUserWorktree(repo: string) {
  return useRepoMutation(
    repo,
    (args: { from: string; to: string }) =>
      moveUserWorktree(repo, args.from, args.to),
    { invalidate: [worktreeKey(repo)] },
  );
}

/** Locks a user worktree (optionally with a reason). */
export function useLockUserWorktree(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; reason?: string }) =>
      lockWorktree(repo, args.path, args.reason),
    { invalidate: [worktreeKey(repo)] },
  );
}

/** Unlocks a user worktree. */
export function useUnlockUserWorktree(repo: string) {
  return useRepoMutation(repo, (path: string) => unlockWorktree(repo, path), {
    invalidate: [worktreeKey(repo)],
  });
}

/** Repairs worktree links after the repo folder was moved or renamed. */
export function useRepairWorktrees(repo: string) {
  return useRepoMutation(repo, (_: void) => repairWorktrees(repo), {
    invalidate: [worktreeKey(repo)],
  });
}

/** Owners (from each repo's origin remote) for grouping the repo list. */
export function useRepoOwners(paths: string[]) {
  const sorted = [...paths].sort();
  return useQuery({
    queryKey: ["repo-owners", sorted] as const,
    queryFn: () => api.gitRepoOwners(sorted),
    enabled: sorted.length > 0,
    staleTime: 10 * 60 * 1000,
    // gcTime: Infinity — keep owners warm across popover opens so refreshes stay
    // instant (the stored owner on each RecentRepo is the primary anti-reflow path).
    gcTime: Number.POSITIVE_INFINITY,
  });
}

export function useFileDiff(
  repo: string,
  file: { path: string; staged: boolean; untracked: boolean } | null,
) {
  return useQuery({
    // `untracked` is in the key so the untracked→tracked flip (after staging part
    // of a new file) subscribes to a fresh query — the `--no-index` "all new"
    // diff and the normal remainder diff must not share a cache entry, or an
    // invalidation race could leave the stale all-lines view on screen.
    queryKey: [
      ...repoKeys.diff(repo, file?.path ?? "", file?.staged ?? false),
      file?.untracked ?? false,
    ] as const,
    queryFn: () =>
      api.gitDiffFile(
        repo,
        file?.path ?? "",
        file?.staged ?? false,
        file?.untracked ?? false,
      ),
    enabled: file !== null,
  });
}

/**
 * A file's cumulative diff in an agent session worktree vs the session's base commit.
 * `base` is in the key so a restarted session's new base can't cache-hit; idle until
 * `enabled` (the step is expanded). While `live` it polls: the agent edits the worktree
 * through its own CLI, outside any app mutation that could invalidate this, so an open
 * diff would otherwise freeze.
 */
export function useSessionFileDiff(
  repo: string,
  filePath: string,
  base: string,
  enabled: boolean,
  live: boolean,
) {
  return useQuery({
    queryKey: [...repoKeys.diff(repo, filePath, false), "session-base", base],
    queryFn: () => api.gitSessionFileDiff(repo, filePath, base),
    enabled: enabled && Boolean(repo && filePath && base),
    refetchInterval: enabled && live ? 1500 : false,
    refetchIntervalInBackground: false,
  });
}

export const HISTORY_PAGE_SIZE = 200;

/** Paged commit log; `data.pages.flat()` is the loaded history. */
export function useLog(repo: string) {
  return useInfiniteQuery({
    queryKey: repoKeys.log(repo),
    queryFn: ({ pageParam }) => api.gitLog(repo, HISTORY_PAGE_SIZE, pageParam),
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
  });

const commitFilesOptions = (repo: string, hash: string) =>
  queryOptions({
    queryKey: repoKeys.commitFiles(repo, hash),
    queryFn: () => api.gitCommitFiles(repo, hash),
    staleTime: Number.POSITIVE_INFINITY,
  });

const commitFileDiffOptions = (repo: string, hash: string, file: string) =>
  queryOptions({
    queryKey: repoKeys.commitFileDiff(repo, hash, file),
    queryFn: () => api.gitCommitFileDiff(repo, hash, file),
    staleTime: Number.POSITIVE_INFINITY,
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
  });
}

export function useCommitAuthors(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "commit-authors"] as const,
    queryFn: () => api.gitCommitAuthors(repo),
    staleTime: 60_000,
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
  });
}

/** Invalidates the repo's TODO-scan queries (the detail pane's Rescan), keeping the
 *  query key owned here instead of leaking the literal into the feature. */
export function useTodoScanInvalidate(repo: string) {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: ["repo", repo, "todo-scan"] });
}

export function useGlobalIdentity() {
  return useQuery({
    queryKey: ["global-identity"] as const,
    queryFn: api.gitGlobalIdentity,
  });
}

export function useSetGlobalIdentity() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; email: string }) =>
      api.gitSetGlobalIdentity(args.name, args.email),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["global-identity"] }),
  });
}

/** The global `init.defaultBranch` — the branch `git init` gives new repos
 *  (empty string when unset). */
export function useGlobalDefaultBranch() {
  return useQuery({
    queryKey: ["global-default-branch"] as const,
    queryFn: api.gitGlobalDefaultBranch,
  });
}

export function useSetGlobalDefaultBranch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (branch: string) => api.gitSetGlobalDefaultBranch(branch),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["global-default-branch"] }),
  });
}

/** The global line-ending policy (`core.autocrlf`): "true" | "input" | "false"
 *  | "" (unset). */
export function useGlobalAutocrlf() {
  return useQuery({
    queryKey: ["global-autocrlf"] as const,
    queryFn: api.gitGlobalAutocrlf,
  });
}

export function useSetGlobalAutocrlf() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (value: string) => api.gitSetGlobalAutocrlf(value),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ["global-autocrlf"] }),
  });
}

export function useUserIdentity(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "user-identity"] as const,
    queryFn: () => api.gitUserIdentity(repo),
    staleTime: 5 * 60_000,
  });
}

/** The repo-local identity override (empty name/email = no override). */
export function useLocalIdentity(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "local-identity"] as const,
    queryFn: () => api.gitLocalIdentity(repo),
  });
}

export function useSetLocalIdentity(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; email: string }) =>
      api.gitSetLocalIdentity(repo, args.name, args.email),
    onSettled: () => {
      queryClient.invalidateQueries({
        queryKey: ["repo", repo, "local-identity"],
      });
      // The effective identity (used for co-author suggestions) changes too.
      queryClient.invalidateQueries({
        queryKey: ["repo", repo, "user-identity"],
      });
    },
  });
}

/** Repo-wide stats; the scan is heavy, so only fetch while the dialog is up. */
export function useRepoStats(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "stats"] as const,
    queryFn: () => api.gitRepoStats(repo),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useBranchStats(
  repo: string,
  branch: string | null,
  base: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "branch-stats", branch ?? "", base ?? ""] as const,
    queryFn: () => api.gitBranchStats(repo, branch ?? "", base ?? ""),
    enabled: enabled && branch !== null && base !== null && branch !== base,
    staleTime: 60_000,
  });
}

// ── Insights graphs ──────────────────────────────────────────────────────────
// All keyed on the trailing window (`weeks`) so toggling it refetches. Local-git
// queries are cheap to keep fresh; the gh community call is gated on a GitHub repo.

export function useContributorActivity(
  repo: string,
  weeks: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "contributors", weeks] as const,
    queryFn: () => api.gitContributorActivity(repo, weeks),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useCommitActivity(
  repo: string,
  weeks: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "commit-activity", weeks] as const,
    queryFn: () => api.gitCommitActivity(repo, weeks),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useCodeFrequency(
  repo: string,
  weeks: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "code-frequency", weeks] as const,
    queryFn: () => api.gitCodeFrequency(repo, weeks),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function usePunchCard(repo: string, weeks: number, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "punch-card", weeks] as const,
    queryFn: () => api.gitPunchCard(repo, weeks),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useCommunityInsights(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "community"] as const,
    queryFn: () => api.ghCommunityInsights(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useRepoTraffic(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "traffic"] as const,
    queryFn: () => api.ghRepoTraffic(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useRepoDependencies(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "insights", "dependencies"] as const,
    queryFn: () => api.ghRepoDependencies(repo),
    enabled,
    staleTime: 30 * 60_000,
    retry: false,
  });
}

export function useCompareBranches(
  repo: string,
  base: string | null,
  compare: string | null,
) {
  return useQuery({
    queryKey: repoKeys.compare(repo, base ?? "", compare ?? ""),
    queryFn: () => api.gitCompareBranches(repo, base ?? "", compare ?? ""),
    enabled: base !== null && compare !== null && base !== compare,
  });
}

export function useBranchDiffFiles(
  repo: string,
  base: string | null,
  compare: string | null,
) {
  return useQuery({
    queryKey: repoKeys.branchDiffFiles(repo, base ?? "", compare ?? ""),
    queryFn: () => api.gitBranchDiffFiles(repo, base ?? "", compare ?? ""),
    enabled: base !== null && compare !== null && base !== compare,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

/** `enabled`: same caller gate as `useCommitFileDiff` — hold the fetch off while
 *  `file` still comes from a placeholder file list. */
export function useBranchFileDiff(
  repo: string,
  base: string | null,
  compare: string | null,
  file: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: repoKeys.branchFileDiff(
      repo,
      base ?? "",
      compare ?? "",
      file ?? "",
    ),
    queryFn: () =>
      api.gitBranchFileDiff(repo, base ?? "", compare ?? "", file ?? ""),
    enabled:
      enabled &&
      base !== null &&
      compare !== null &&
      base !== compare &&
      file !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function useRemotes(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "remotes"] as const,
    queryFn: () => api.gitRemotes(repo),
  });
}

export function usePublishRepo(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      provider: "github" | "gitlab" | "bitbucket";
      name: string;
      isPrivate: boolean;
      description: string;
      homepage: string;
      topics: string[];
      /** Bitbucket only — the workspace the repo is created under. */
      workspace?: string;
    }) =>
      api.forgePublishRepo(
        args.provider,
        repo,
        args.name,
        args.isPrivate,
        args.description,
        args.homepage,
        args.topics,
        args.workspace,
      ),
  );
}

/** Which providers this machine can publish to — drives the publish buttons for
 *  a repo with no hosted remote yet. Honors the cold-start test mode like
 *  `useForgeStatus` (the probe hits the real CLIs otherwise). */
export function usePublishTargets(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "publish-targets"] as const,
    queryFn: COLD_START_NO_GH
      ? () =>
          Promise.resolve({ github: false, gitlab: false, bitbucket: false })
      : () => api.forgePublishTargets(repo),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function usePrsForBranch(
  repo: string,
  head: string | null,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "prs", lens, head ?? ""] as const,
    queryFn: () => api.forgePrsForBranch(repo, head ?? "", lens),
    enabled: enabled && head !== null,
    staleTime: 30_000,
  });
}

export function usePrList(
  repo: string,
  enabled: boolean,
  state: api.PrStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "pr-list", lens, state, limit ?? null] as const,
    queryFn: () => api.forgePrList(repo, state, limit, lens),
    enabled,
    staleTime: 30_000,
    // State and limit stay free so a tab switch or "Load more" keeps the current rows
    // instead of flashing skeletons, but lens must match: a fork numbers PRs
    // independently of its parent, so another lens's rows misdescribe the list and a
    // click on one navigates by number to a different PR.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
  });
}

/** Hydrates PR-list rows with each PR's CI rollup, keyed by number. Runs SEPARATELY from
 *  `usePrList` — a full rollup expansion inside the list query 504s on large GitHub
 *  repos. CALLER CONTRACT: idle this hook while the list serves placeholder rows
 *  (`enabled: … && !list.isPlaceholderData`) — the comparator below leaves `state` free,
 *  so an ungated intermediate fetch would build a map from the outgoing rows and cache it
 *  under the incoming key. The numbers digest in the key is the remaining defense: it
 *  keeps such a result from ever caching under another page's key. */
export function usePrListCi(
  repo: string,
  enabled: boolean,
  state: api.PrStateFilter,
  limit: number | undefined,
  prs: PrInfo[] | undefined,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "pr-ci",
      lens,
      state,
      limit ?? null,
      prs?.map((p) => p.number).join(",") ?? "",
    ] as const,
    queryFn: async () => {
      // `enabled` requires a non-empty `prs`, so the cast and `list[0]` below are safe.
      const list = prs as PrInfo[];
      // No lens arg on the api call: `sampleUrl` (list[0].url) already pins which
      // repo these numbers belong to, so the CI rollup is fork/parent-correct by
      // construction. The lens rides the key only, so the fork's and parent's
      // rollups never collide in the cache.
      const rows = await api.forgePrListCi(
        repo,
        list.map((p) => ({ number: p.number, headSha: p.headSha })),
        list[0].url,
      );
      return new Map<number, CiStatus>(rows.map((r) => [r.number, r.ciStatus]));
    },
    enabled: enabled && !!prs && prs.length > 0,
    staleTime: 30_000,
    // Repo and lens must match: a fork numbers PRs independently of its parent, so a
    // cross-lens map paints wrong icons. State stays free — the panel idles this query
    // while the list serves placeholder rows (mirroring the mergeability gate), and
    // open/closed sets are disjoint, so a cross-tab serve can't show another PR's status.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
  });
}

/** Hydrates PR-list rows with each PR's mergeability, keyed by number — the rows' conflict
 *  chip. Runs separately from `usePrList`, and its numbers digest in the key is
 *  load-bearing: the digest pins the key to the row set the map describes, so an
 *  intermediate result can never cache under the next page's key. `prs` never
 *  reaches the backend (it re-queries the page from the filters): it is here only to
 *  form that digest and to keep the read off an empty page. */
export function usePrListMergeability(
  repo: string,
  enabled: boolean,
  state: api.PrStateFilter,
  limit: number | undefined,
  prs: PrInfo[] | undefined,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "pr-mergeability",
      lens,
      state,
      limit ?? null,
      prs?.map((p) => p.number).join(",") ?? "",
    ] as const,
    queryFn: async () => {
      const rows = await api.forgePrListMergeability(repo, state, limit, lens);
      return new Map<number, PrMergeabilityState>(
        Object.entries(rows).map(([number, mergeState]) => [
          Number(number),
          mergeState,
        ]),
      );
    },
    enabled: enabled && !!prs && prs.length > 0,
    staleTime: 30_000,
    // Keeps the current chips while a "Load more" grows the list (that moves only the
    // limit/digest segments, idx 5/6), but ONLY within the same repo, lens AND state.
    // A placeholder is served even while this query is DISABLED — query-core applies it
    // on any keyed query with no data yet — so matching on repo alone (what the shared
    // `keepPreviousDataForRepo` does) would paint the open tab's map onto closed rows,
    // and origin's onto upstream's, since numbers collide across both axes.
    placeholderData: keepPreviousDataForKeyAxes(repo, [
      [3, lens],
      [4, state],
    ]),
  });
}

export function useRepoLabels(
  repo: string,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "labels", lens] as const,
    queryFn: () => api.forgeRepoLabels(repo, lens),
    enabled,
    staleTime: 5 * 60_000,
  });
}

// Shared definitions so the hook and the prefetch path stay in sync. A short
// stale window makes a hover-prefetched PR open with no extra round-trip; the
// window-focus refetch still keeps an open PR current.
const prDetailsOptions = (repo: string, number: number, lens: RemoteLens) =>
  queryOptions({
    queryKey: ["repo", repo, "pr", lens, number] as const,
    queryFn: () => api.forgePrView(repo, number, lens),
    staleTime: 30_000,
  });

export const prDiffOptions = (repo: string, number: number, lens: RemoteLens) =>
  queryOptions({
    queryKey: ["repo", repo, "pr", lens, number, "diff"] as const,
    queryFn: () => api.forgePrDiff(repo, number, lens),
    staleTime: 30_000,
  });

export function usePrDetails(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    ...prDetailsOptions(repo, number ?? 0, lens),
    enabled: number !== null,
    // The lens segment is an IDENTITY axis: a fork's two lenses surface different
    // pull requests at the same number, so a cross-lens placeholder paints the
    // wrong PR. A number change deliberately KEEPS the previous PR's data — the
    // dimmed switch beat that RemotePrView's detailsStale gates compensate for.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
  });
}

/** How many reads the "checking" ladder gets per VISIT before it concedes: GitHub's
 *  async mergeability compute normally settles within a few primed reads, and an
 *  unbounded poll would burn API budget forever on a PR whose answer never comes. */
const MERGEABILITY_POLL_LIMIT = 6;

/** A PR's mergeability against its base — the conflict banner's server truth. GitHub
 *  computes it asynchronously and this read PRIMES that computation, so "checking"
 *  re-polls on the bounded ladder above, and `polling` lets the banner tell "still
 *  climbing" from "gave up". The ladder counts per MOUNT and per PR rather than off the
 *  cache entry's cumulative `dataUpdateCount`, which would leave a PR that once hit the
 *  ceiling unable to poll again all session; `retry` restarts it by hand. `isError`
 *  with no `data` is the read that never landed at all — unreachable rather than
 *  undecided, which the banner answers with the local prediction instead. */
export function usePrMergeability(
  repo: string,
  number: number | null,
  lens: RemoteLens,
  enabled: boolean,
) {
  // The ref is what `refetchInterval` reads — it runs outside render, and a render-time
  // read of mutable state goes stale once the React Compiler memoizes it. The state
  // mirror is the render-visible half.
  const polls = useRef(0);
  const ladderFor = useRef("");
  const seen = useRef({ ok: 0, failed: 0 });
  const [pollsUsed, setPollsUsed] = useState(0);
  const query = useQuery({
    queryKey: ["repo", repo, "pr", lens, number ?? 0, "mergeability"] as const,
    queryFn: () => api.forgePrMergeability(repo, number ?? 0, lens),
    enabled: enabled && number !== null,
    staleTime: 15_000,
    // `polls.current` is the ONE ladder counter, fed below by completions of either
    // kind. The cache's own cumulative counts are deliberately not used here: they
    // outlive the mount, so a PR that once hit the ceiling could never poll again.
    refetchInterval: (q) =>
      q.state.data?.state === "checking" &&
      polls.current < MERGEABILITY_POLL_LIMIT
        ? 2_500
        : false,
    refetchIntervalInBackground: false,
  });

  const identity = [repo, number, lens].join("|");
  const checking = query.data?.state === "checking";
  const updatedAt = query.dataUpdatedAt;
  const failedAt = query.errorUpdatedAt;
  // One ladder step per COMPLETED read that left the question open — a success still
  // saying "checking", OR a failure. Counting failures is what actually bounds a flaky
  // or rate-limited forge: the last good answer stays "checking" in the cache, so a
  // success-only ladder would poll every 2.5s forever and never reach the gave-up arm.
  // Compared against the last timestamps seen so an unrelated re-render can't spend a
  // rung, and reset whenever the PR or lens changes — each is its own question.
  useEffect(() => {
    if (ladderFor.current !== identity) {
      ladderFor.current = identity;
      polls.current = 0;
      seen.current = { ok: 0, failed: 0 };
    }
    const advanced =
      updatedAt > seen.current.ok || failedAt > seen.current.failed;
    seen.current = { ok: updatedAt, failed: failedAt };
    if (advanced && checking) polls.current += 1;
    setPollsUsed(polls.current);
  }, [identity, checking, updatedAt, failedAt]);

  const refetch = query.refetch;
  const retry = useCallback(() => {
    polls.current = 0;
    setPollsUsed(0);
    void refetch();
  }, [refetch]);

  return {
    data: query.data,
    isFetching: query.isFetching,
    /** Still climbing the ladder, so "checking" is an honest thing to show. */
    polling: checking && pollsUsed < MERGEABILITY_POLL_LIMIT,
    /** The last read failed. Only meaningful paired with `data`: without one the forge
     *  was never reached for this PR; with one, a settled answer survives the failure. */
    isError: query.isError,
    /** Restart the ladder and read again — the gave-up banner's Retry. */
    retry,
  };
}

/** The divergence key's repo+PR prefix, deliberately lens-free so one invalidation
 *  covers both lenses. A SIBLING of the PR subtree rather than a child, so
 *  `["repo", repo, "pr", …]` does not prefix-cover it — update-branch has to name it. */
export const prBaseDivergencePrefix = (repo: string, number: number) =>
  ["repo", repo, "pr-base-divergence", number] as const;

/** The full key `usePrBaseDivergence` reads — the prefix plus its lens axis. */
const prBaseDivergenceKey = (
  repo: string,
  number: number,
  lens: RemoteLens | undefined,
) => [...prBaseDivergencePrefix(repo, number), lens ?? "origin"] as const;

/** How many reads the post-update ladder gets before it concedes. Each rung costs TWO
 *  gh calls (the PR view, then the compare), so the budget is tighter per second than
 *  the mergeability ladder's; ~16s covers the usual update job without leaving a
 *  spinner up forever on one that never lands. */
const DIVERGENCE_UPDATE_POLL_LIMIT = 8;

/** How far a PR's head is ahead of / behind its base — the "Update branch"
 *  affordance's driver. `retry: false` keeps a repo without the permission (or a
 *  non-GitHub one) from a retry storm; consumers treat an error as "unknown".
 *  GitHub runs update-branch as a queued job, so `awaitUpdate` arms a bounded poll
 *  and `updating` stays true until a read OBSERVES the head caught up — the only
 *  honest completion signal there is. */
export function usePrBaseDivergence(
  repo: string,
  number: number | null,
  lens: RemoteLens | undefined,
  enabled: boolean,
) {
  // Same ref/state split as the mergeability ladder: `refetchInterval` runs outside
  // render, and a render-time read of mutable state goes stale once the React Compiler
  // memoizes it. The mirror carries the IDENTITY it was armed for rather than a bare
  // boolean, so a PR or lens change retires it in the same render — an effect-cleared
  // flag paints the old PR's line onto the new one for a frame first.
  const awaiting = useRef(false);
  const polls = useRef(0);
  const ladderFor = useRef("");
  const seen = useRef({ ok: 0, failed: 0 });
  const [latch, setLatch] = useState<string | null>(null);
  const identity = [repo, number, lens].join("|");
  const query = useQuery({
    queryKey: prBaseDivergenceKey(repo, number ?? 0, lens),
    queryFn: () => api.ghPrBaseDivergence(repo, number ?? 0, lens ?? "origin"),
    enabled: enabled && number !== null,
    staleTime: 60_000,
    retry: false,
    refetchInterval: (q) =>
      awaiting.current &&
      (q.state.data?.behindBy ?? 0) > 0 &&
      polls.current < DIVERGENCE_UPDATE_POLL_LIMIT
        ? 2_000
        : false,
    refetchIntervalInBackground: false,
  });

  const behind = (query.data?.behindBy ?? 0) > 0;
  const updatedAt = query.dataUpdatedAt;
  const failedAt = query.errorUpdatedAt;
  // One rung per COMPLETED read that still shows the head behind — a success or a
  // failure alike. The query is `retry: false`, so counting failures is the only thing
  // bounding a forge that has started refusing: the cached `behindBy` would otherwise
  // keep the latch armed and poll forever. Timestamps guard against an unrelated
  // re-render spending a rung; a PR or lens change is a different question entirely,
  // so it clears the latch rather than inheriting it.
  useEffect(() => {
    if (ladderFor.current !== identity) {
      ladderFor.current = identity;
      awaiting.current = false;
      polls.current = 0;
      seen.current = { ok: 0, failed: 0 };
      // The mirror already reads false against the new identity; dropping the stale
      // string keeps a switch BACK to that PR from re-arming it.
      setLatch(null);
    }
    const advanced =
      updatedAt > seen.current.ok || failedAt > seen.current.failed;
    seen.current = { ok: updatedAt, failed: failedAt };
    if (advanced && awaiting.current && behind) polls.current += 1;
    if (
      awaiting.current &&
      (!behind || polls.current >= DIVERGENCE_UPDATE_POLL_LIMIT)
    ) {
      awaiting.current = false;
      setLatch(null);
    }
  }, [identity, behind, updatedAt, failedAt]);

  const refetch = query.refetch;
  const awaitUpdate = useCallback(() => {
    // A stale closure (the view moved to another PR mid-submit) must not arm the
    // shared refs against the new key — the mount effect keeps ladderFor current.
    if (ladderFor.current !== identity) return false;
    awaiting.current = true;
    polls.current = 0;
    setLatch(identity);
    void refetch();
    return true;
  }, [refetch, identity]);

  return {
    data: query.data,
    isFetching: query.isFetching,
    /** An update was asked for and the head has not been seen caught up yet. Clears on
     *  `behindBy === 0`, on rung exhaustion, and on a PR/lens change; a query disabled
     *  mid-poll holds the latch until it re-enables or the PR changes, so readers must
     *  gate this on the same `enabled` they passed. */
    updating: latch === identity,
    /** Arm the ladder after a queued update-branch and read again now. Returns false
     *  without arming anything when the view has already moved to another PR or lens,
     *  so the caller drops an answer that is no longer about what's on screen. */
    awaitUpdate,
  };
}

export function usePrDiff(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    ...prDiffOptions(repo, number ?? 0, lens),
    enabled: number !== null,
    // Lens axis mirrors usePrDetails; the number axis stays placeholder-served so
    // RemotePrView's diffStale keeps gating the Files tab during a PR switch.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
  });
}

// File:line-anchored review threads (Copilot/CodeRabbit/human line comments); the
// data serves both the Conversation grouping and the Files diff anchors, so it
// lives at the PR top level.
export const prReviewThreadsKey = (
  repo: string,
  number: number,
  lens: RemoteLens,
) => ["repo", repo, "pr", lens, number, "review-threads"] as const;

export function usePrReviewThreads(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: prReviewThreadsKey(repo, number ?? 0, lens),
    queryFn: () => api.forgePrReviewThreads(repo, number ?? 0, lens),
    staleTime: 30_000,
    // Gate on `number !== null` alone, exactly like usePrDetails/usePrReactions.
    // A transient gh status-probe failure (useForgeStatus has retry:false) leaves
    // forge.data undefined for ~60s; gating this read on it would silently hide
    // threads on a healthy PR. The Implemented flags still gate the WRITE
    // controls (reply/resolve) in the view.
    enabled: number !== null,
  });
}

/**
 * Applies a review suggestion to the working tree (GitHub's "Commit suggestion", done
 * locally). A staging-class edit, so it narrows invalidation to {@link workingTreeKeys}
 * like {@link useStage} — the whole-repo default would prefix-match the review-threads
 * key and force a needless GitHub GraphQL refetch even though no thread changed. The
 * backend verifies the expected lines before editing; a mismatch throws.
 */
export function useApplySuggestion(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      filePath: string;
      startLine: number;
      expectedLines: string[];
      replacementLines: string[];
      stageWhenClean: boolean;
    }) =>
      api.gitReplaceFileLines(
        repo,
        args.filePath,
        args.startLine,
        args.expectedLines,
        args.replacementLines,
        args.stageWhenClean,
      ),
    { invalidate: workingTreeKeys(repo) },
  );
}

/** The unified diff for one commit of a PR/MR. Pass `oid: null` when no commit is
 *  selected so the read doesn't fire; keyed by oid so each commit's diff caches
 *  independently. */
export function usePrCommitDiff(
  repo: string,
  number: number,
  oid: string | null,
  lens: RemoteLens,
) {
  return useQuery({
    // The diff itself is sha-addressed (forgePrCommitDiff takes no lens), but the
    // PARENT PR this attaches to is lens-scoped, so the lens rides the key.
    queryKey: ["repo", repo, "pr", lens, number, "commit-diff", oid] as const,
    queryFn: () => api.forgePrCommitDiff(repo, number, oid ?? ""),
    enabled: oid !== null,
    staleTime: 30_000,
  });
}

/** Comments on a commit (GitHub commit comments / GitLab commit notes). Pass
 *  `sha: null` when no commit is selected so the read doesn't fire. The `lens`
 *  scopes which repo the commit's comments come from — "origin" from the History
 *  surface, the live lens inside the PR-commit review context. */
export function useCommitComments(
  repo: string,
  sha: string | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: commitCommentsKey(repo, sha ?? "", lens),
    queryFn: () => api.forgeCommitComments(repo, sha ?? "", lens),
    enabled: sha !== null,
    staleTime: 30_000,
  });
}

/** Whether a commit lives on any remote — gates the History-tab commit-comment surface
 *  (you can only comment on a commit the forge already has). A push flips it, hence the
 *  short stale window; pass `sha: null` when no commit is selected. */
export function useCommitOnRemote(repo: string, sha: string | null) {
  return useQuery({
    queryKey: ["repo", repo, "commit", sha, "on-remote"] as const,
    queryFn: () => api.commitOnRemote(repo, sha ?? ""),
    enabled: sha !== null,
    staleTime: 30_000,
  });
}

/** The forge's own unified diff for a commit, PR-independent. GitHub commit-comment
 *  `position` mapping must walk GitHub's own patch rather than local git's (rename
 *  detection etc. can differ), so this fetches the provider's diff. Pass `sha: null`
 *  to keep it cold when no commit is selected. */
export function useRemoteCommitDiff(repo: string, sha: string | null) {
  return useQuery({
    queryKey: ["repo", repo, "commit", sha, "remote-diff"] as const,
    queryFn: () => api.forgeCommitDiff(repo, sha ?? ""),
    enabled: sha !== null,
    staleTime: 30_000,
  });
}

const commitCommentsKey = (repo: string, sha: string, lens: RemoteLens) =>
  ["repo", repo, "commit", sha, "comments", lens] as const;

/**
 * The shared skeleton behind the optimistic-cache mutations here: cancel in-flight
 * fetches on the target key, snapshot it, apply an optimistic `setQueryData` patch, roll
 * the snapshot back on error, reconcile on settle. Wrappers differ only in `keyFor(args)`
 * (the key is derived from the args AT MUTATE TIME, so a mid-flight repo/number/sha
 * switch can never corrupt another key's cache), `patch`, and `reconcile`. `TCache` is
 * the shape stored at the key; the rollback context carries the exact key + prior value.
 */
function useOptimisticCacheMutation<TArgs, TData, TCache>(
  mutationFn: (args: TArgs) => Promise<TData>,
  keyFor: (args: TArgs) => QueryKey,
  patch: (prev: TCache | undefined, args: TArgs) => TCache | undefined,
  reconcile: (
    queryClient: ReturnType<typeof useQueryClient>,
    args: TArgs,
  ) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (args: TArgs) => {
      const key = keyFor(args);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<TCache>(key);
      queryClient.setQueryData<TCache>(key, (data) => patch(data, args));
      return { prev, key };
    },
    onError: (
      _e: unknown,
      _args: TArgs,
      ctx: { prev: TCache | undefined; key: QueryKey } | undefined,
    ) => {
      // Explicit guard: in TanStack Query v5 `setQueryData(key, undefined)` BAILS
      // without updating (it does not remove the entry), so an unguarded call would be
      // a silent no-op, not a rollback. A create-from-nothing patch would need
      // removeQueries here instead.
      if (ctx?.prev !== undefined) queryClient.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d: TData | undefined, _e: unknown, args: TArgs) =>
      reconcile(queryClient, args),
  });
}

/**
 * Optimistically appends a synthetic commit comment with exact-key rollback. The
 * synthetic row carries a collision-proof `optimistic:<n>` id and
 * `viewerDidAuthor: false`, so it offers no edit/delete until the reconciling refetch
 * replaces it with the real comment; `author` is the viewer's cached forge login, else
 * "You".
 */
export function useCreateCommitComment(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      sha: string;
      body: string;
      path?: string;
      line?: number;
      startLine?: number;
      position?: number;
    }) => api.forgeCommitCommentCreate(repo, args, lens),
    onMutate: async (args: {
      sha: string;
      body: string;
      path?: string;
      line?: number;
      startLine?: number;
      position?: number;
    }) => {
      const key = commitCommentsKey(repo, args.sha, lens);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<CommitCommentOut[]>(key);
      // The viewer's login is read from the already-cached forge status (no fetch);
      // "You" until the reconciliation refetch swaps in the real comment.
      const login = queryClient.getQueryData<ForgeStatus>([
        "repo",
        repo,
        "forge-status",
      ])?.login;
      const synthetic: CommitCommentOut = {
        id: `optimistic:${(optimisticCommentSeq += 1)}`,
        author: login ?? "You",
        body: args.body,
        createdAt: new Date().toISOString(),
        viewerDidAuthor: false,
        path: args.path ?? null,
        line: args.line ?? null,
        startLine: args.startLine ?? null,
        position: args.position ?? null,
      };
      queryClient.setQueryData<CommitCommentOut[]>(key, (list) =>
        list ? [...list, synthetic] : list,
      );
      return { prev, key };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  });
}

/** Optimistic edit/delete of one commit comment with exact-key rollback — the
 *  commit-comment analogue of {@link useOptimisticCommentMutation}. */
function useOptimisticCommitCommentMutation<TData>(
  repo: string,
  lens: RemoteLens,
  mutationFn: (args: {
    sha: string;
    commentId: string;
    body?: string;
  }) => Promise<TData>,
  patchComment: (
    comment: CommitCommentOut,
    args: { sha: string; commentId: string; body?: string },
  ) => CommitCommentOut | null,
) {
  return useOptimisticCacheMutation<
    { sha: string; commentId: string; body?: string },
    TData,
    CommitCommentOut[]
  >(
    mutationFn,
    (args) => commitCommentsKey(repo, args.sha, lens),
    (list, args) =>
      list?.flatMap((c) => {
        if (c.id !== args.commentId) return [c];
        const patched = patchComment(c, args);
        return patched ? [patched] : [];
      }),
    (queryClient) =>
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  );
}

export function useEditCommitComment(repo: string, lens: RemoteLens) {
  return useOptimisticCommitCommentMutation(
    repo,
    lens,
    (args: { sha: string; commentId: string; body?: string }) =>
      api.forgeCommitCommentEdit(
        repo,
        {
          sha: args.sha,
          commentId: args.commentId,
          body: args.body ?? "",
        },
        lens,
      ),
    (comment, args) => ({ ...comment, body: args.body ?? comment.body }),
  );
}

export function useDeleteCommitComment(repo: string, lens: RemoteLens) {
  return useOptimisticCommitCommentMutation(
    repo,
    lens,
    (args: { sha: string; commentId: string }) =>
      api.forgeCommitCommentDelete(
        repo,
        {
          sha: args.sha,
          commentId: args.commentId,
        },
        lens,
      ),
    () => null,
  );
}

/**
 * Creates a file:line-anchored review thread, optimistically appending a synthetic
 * single-comment {@link ReviewThreadOut} with exact-key rollback so the card shows
 * instantly. The synthetic comment carries an `optimistic:<n>` id and
 * `viewerDidAuthor: false` — no edit/delete until the reconciling refetch replaces it.
 */
export function useCreateReviewThread(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      number: number;
      path: string;
      line: number;
      side: "new" | "old";
      startLine?: number;
      body: string;
    }) => api.forgePrThreadCreate(repo, args, lens),
    onMutate: async (args: {
      number: number;
      path: string;
      line: number;
      side: "new" | "old";
      startLine?: number;
      body: string;
    }) => {
      const key = prReviewThreadsKey(repo, args.number, lens);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<ReviewThreadOut[]>(key);
      const login = queryClient.getQueryData<ForgeStatus>([
        "repo",
        repo,
        "forge-status",
      ])?.login;
      const synthetic: ReviewThreadOut = {
        id: `optimistic:${(optimisticCommentSeq += 1)}`,
        reviewId: "",
        path: args.path,
        line: args.line,
        startLine: args.startLine ?? 0,
        side: args.side,
        isResolved: false,
        isOutdated: false,
        diffHunk: "",
        comments: [
          {
            author: login ?? "You",
            // Optimistic: login-derived (GitHub) / initial until the refetch fills it.
            authorAvatarUrl: "",
            state: "",
            body: args.body,
            date: new Date().toISOString(),
            id: `optimistic:${(optimisticCommentSeq += 1)}`,
            url: "",
            viewerDidAuthor: false,
            isMinimized: false,
            minimizedReason: "",
            // Optimistic reply: the owning review id (if GitHub wraps it in one)
            // arrives with the reconciling refetch.
            reviewId: "",
          },
        ],
      };
      queryClient.setQueryData<ReviewThreadOut[]>(key, (threads) =>
        threads ? [...threads, synthetic] : threads,
      );
      return { prev, key };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  });
}

/** Submit a batch review (verdict + summary + staged draft comments). NOT
 *  optimistic — on some providers it fans out to several calls, so it just
 *  invalidates the repo subtree on success and returns the {@link ReviewSubmitOut}
 *  so the caller can toast the posted/total counts. */
export function useSubmitReview(repo: string, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: {
      number: number;
      verdict: api.ReviewVerdict;
      summary?: string;
      comments: DraftCommentIn[];
    }) => api.forgePrReviewSubmit(repo, args, lens),
  );
}

export function useThreadReply(repo: string, number: number, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: { threadId: string; body: string }) =>
      api.forgePrThreadReply(repo, number, args.threadId, args.body),
    { invalidate: [prReviewThreadsKey(repo, number, lens)] },
  );
}

export function useThreadResolve(
  repo: string,
  number: number,
  lens: RemoteLens,
) {
  return useRepoMutation(
    repo,
    (args: { threadId: string; resolved: boolean }) =>
      api.forgePrThreadResolve(repo, number, args.threadId, args.resolved),
    { invalidate: [prReviewThreadsKey(repo, number, lens)] },
  );
}

/** Warms a remote PR's view (metadata + diff) on row hover and adjacent rows — PR data
 *  is the slowest load in the app, so prefetching pays off most here. */
export function usePrefetchPr(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useCallback(
    (number: number) => {
      queryClient.prefetchQuery(prDetailsOptions(repo, number, lens));
      queryClient.prefetchQuery(prDiffOptions(repo, number, lens));
    },
    [queryClient, repo, lens],
  );
}

/** Reactions for a PR's body + comments — decoupled from the PR view so it
 *  loads in parallel and leaves the (untouched) PR query alone. */
export function usePrReactions(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "pr", lens, number ?? 0, "reactions"] as const,
    queryFn: () => api.forgePrReactions(repo, number ?? 0, lens),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

/** A PR's activity timeline for the Conversation tab. Provider-neutral (the backend
 *  dispatches), so the caller passes `enabled = section === "conversation" && <known
 *  provider>` — a hidden tab must NOT fetch. Decoupled from the PR view like
 *  {@link usePrReactions}. */
export function usePrTimeline(
  repoPath: string,
  number: number,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repoPath, "pr", lens, number, "timeline"] as const,
    queryFn: () => api.forgePrTimeline(repoPath, number, lens),
    enabled,
    staleTime: 30_000,
  });
}

export function useIssueList(
  repo: string,
  enabled: boolean,
  state: api.IssueStateFilter,
  limit: number | undefined,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "issue-list", lens, state, limit ?? null] as const,
    queryFn: () => api.forgeIssueList(repo, state, limit, lens),
    enabled,
    staleTime: 30_000,
    // issuesDisabled is a permanent repo condition — retrying only delays the notice.
    retry: (failureCount, err) =>
      !(isAppError(err) && err.kind === "issuesDisabled") && failureCount < 1,
    // State and limit stay free so a tab switch or "Load more" keeps the current rows
    // instead of flashing skeletons, but lens must match: a fork numbers issues
    // independently of its parent, so another lens's rows misdescribe the list and a
    // click on one navigates by number to a different issue.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
  });
}

export const issueDetailsOptions = (
  repo: string,
  number: number,
  lens: RemoteLens,
) =>
  queryOptions({
    queryKey: ["repo", repo, "issue", lens, number] as const,
    queryFn: () => api.forgeIssueView(repo, number, lens),
    staleTime: 30_000,
  });

export function useIssueDetails(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    ...issueDetailsOptions(repo, number ?? 0, lens),
    enabled: number !== null,
    // Lens is an IDENTITY axis, like the PR details twin: a fork's two lenses
    // number their issues independently, so matching on repo alone would serve
    // the other lens's issue under this one's number. The number axis stays out
    // — a switch between issues keeps the previous one painted by design.
    placeholderData: keepPreviousDataForKeyAxes(repo, [[3, lens]]),
  });
}

/** Warms an issue's view so opening it from the list is instant (hover/adjacent
 *  rows), mirroring {@link usePrefetchPr}. */
export function usePrefetchIssue(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useCallback(
    (number: number) => {
      queryClient.prefetchQuery(issueDetailsOptions(repo, number, lens));
    },
    [queryClient, repo, lens],
  );
}

export function useCreateIssue(repo: string, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: {
      title: string;
      body: string;
      labels: string[];
      assignees: string[];
      milestone: number | null;
      type: string | null;
    }) =>
      api.forgeIssueCreate(
        repo,
        args.title,
        args.body,
        args.labels,
        args.assignees,
        args.milestone,
        args.type,
        lens,
      ),
  );
}

export function useAssignableUsers(
  repo: string,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "assignable-users", lens] as const,
    queryFn: () => api.forgeAssignableUsers(repo, lens),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useMilestones(
  repo: string,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "milestones", lens] as const,
    queryFn: () => api.forgeMilestones(repo, lens),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Shallow-diff two objects, returning the keys whose value changed (`Object.is`).
 *  Lets an optimistic mutation capture exactly which fields it touched, so a
 *  rollback restores only those — never reverting a concurrent edit to a sibling
 *  field on the same cache entry. */
function changedKeys<T extends object>(prev: T, next: T): (keyof T)[] {
  const keys = new Set<keyof T>([
    ...(Object.keys(prev) as (keyof T)[]),
    ...(Object.keys(next) as (keyof T)[]),
  ]);
  return [...keys].filter((k) => !Object.is(prev[k], next[k]));
}

/** An issue meta mutation (assignee/milestone/type) with an optimistic patch of the
 *  issue-details cache + field-scoped rollback. The extra display fields callers pass
 *  (milestone title, the full type) exist only for that patch — the backend takes the
 *  id/name. */
function useOptimisticIssueMutation<TArgs extends { number: number }, TData>(
  repo: string,
  lens: RemoteLens,
  mutationFn: (args: TArgs) => Promise<TData>,
  patch: (issue: IssueDetails, args: TArgs) => IssueDetails,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (args: TArgs) => {
      const key = ["repo", repo, "issue", lens, args.number] as const;
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<IssueDetails>(key);
      if (!prev) return { key, restore: undefined };
      const next = patch(prev, args);
      queryClient.setQueryData<IssueDetails>(key, next);
      // Field-scoped rollback: remember only the fields this patch changed, so
      // onError restores exactly those onto the CURRENT cache. A wholesale
      // snapshot restore would revert a concurrent field mutation on the same
      // issue (e.g. setMilestone landing while setAssignees is in flight).
      const restore: Partial<IssueDetails> = {};
      for (const k of changedKeys(prev, next)) {
        (restore as Record<string, unknown>)[k as string] = prev[k];
      }
      return { key, restore };
    },
    // Reporting lives HERE, not in each caller's `mutate` options: react-query
    // only runs mutate-scoped callbacks while the observer has listeners, and the
    // views re-key their metadata rail per entity — so a switch mid-flight would
    // roll the cache back with nothing said.
    onError: (e, _args, ctx) => {
      if (ctx?.restore) {
        queryClient.setQueryData<IssueDetails>(ctx.key, (cur) =>
          cur ? { ...cur, ...ctx.restore } : cur,
        );
      }
      toastError(e);
    },
    // Narrow reconciliation: only the one issue's detail subtree (not repo-wide),
    // scoped to the lens the mutation ran under.
    onSettled: (_d, _e, args) =>
      void queryClient.invalidateQueries({
        queryKey: ["repo", repo, "issue", lens, args.number],
      }),
  });
}

export function useSetIssueAssignees(repo: string, lens: RemoteLens) {
  return useOptimisticIssueMutation(
    repo,
    lens,
    (args: { number: number; assignees: ForgeUserRef[] }) =>
      api.forgeIssueSetAssignees(
        repo,
        args.number,
        args.assignees.map((a) => a.id),
        lens,
      ),
    (issue, args) => ({ ...issue, assignees: args.assignees }),
  );
}

export function useSetIssueMilestone(repo: string, lens: RemoteLens) {
  return useOptimisticIssueMutation(
    repo,
    lens,
    (args: {
      number: number;
      milestone: number | null;
      /** Title for the optimistic chip (backend takes only the number). */
      title?: string | null;
    }) => api.forgeIssueSetMilestone(repo, args.number, args.milestone, lens),
    (issue, args) => ({
      ...issue,
      milestone:
        args.milestone === null
          ? null
          : { number: args.milestone, title: args.title ?? "" },
    }),
  );
}

/** Toggle an issue's GitLab-only confidential flag, with the optimistic
 *  cache patch every other issue-field mutation uses. GitLab-only, so it only
 *  ever runs under the origin lens (the switcher is GitHub-only). */
export function useSetIssueConfidential(repo: string) {
  return useOptimisticIssueMutation(
    repo,
    "origin",
    (args: { number: number; confidential: boolean }) =>
      api.forgeGlIssueSetConfidential(repo, args.number, args.confidential),
    (issue, args) => ({ ...issue, confidential: args.confidential }),
  );
}

/** Set ("YYYY-MM-DD") or clear (null) an issue's GitLab-only due date. GitLab-only,
 *  so it only ever runs under the origin lens. */
export function useSetIssueDueDate(repo: string) {
  return useOptimisticIssueMutation(
    repo,
    "origin",
    (args: { number: number; dueDate: string | null }) =>
      api.forgeGlIssueSetDueDate(repo, args.number, args.dueDate),
    (issue, args) => ({ ...issue, dueDate: args.dueDate }),
  );
}

// ── GitLab time tracking + related issues ────────────────────────────────────

// GitLab-only keys: the lens switcher is GitHub-only, so these always sit under the
// "origin" lens segment — nested inside the lens-scoped issue/MR detail subtree that
// repoKeys.all + the details refetch reconcile.
const issueTimeStatsKey = (repo: string, number: number) =>
  ["repo", repo, "issue", "origin", number, "time-stats"] as const;
const mrTimeStatsKey = (repo: string, number: number) =>
  ["repo", repo, "pr", "origin", number, "time-stats"] as const;

/** An issue's GitLab time-tracking stats (estimate + spent). Pass `null` when
 *  the section isn't shown so the read doesn't fire. */
export function useGlIssueTimeStats(repo: string, number: number | null) {
  return useQuery({
    queryKey: issueTimeStatsKey(repo, number ?? 0),
    queryFn: () => api.forgeGlIssueTimeStats(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
    retry: false,
  });
}

/** An MR's GitLab time-tracking stats. Pass `null` when the summary isn't shown. */
export function useGlMrTimeStats(repo: string, number: number | null) {
  return useQuery({
    queryKey: mrTimeStatsKey(repo, number ?? 0),
    queryFn: () => api.forgeGlMrTimeStats(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
    retry: false,
  });
}

/** A time-tracking write whose response IS the fresh {@link GitLabTimeStats}: write it
 *  straight into the stats key (no refetch), then invalidate the issue/MR view (the
 *  estimate surfaces elsewhere). `statsKey` picks issue vs MR; `viewKey` is the details
 *  query to nudge. */
function useTimeTrackingMutation(
  repo: string,
  statsKey: (repo: string, number: number) => readonly unknown[],
  viewKey: (repo: string, number: number) => readonly unknown[],
  mutationFn: (args: {
    number: number;
    duration: string | null;
  }) => Promise<GitLabTimeStats>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    // Mutation-level so the report survives the caller unmounting mid-flight (the
    // views re-key their rail per entity, and mutate-scoped callbacks stop firing
    // once the observer loses its listeners).
    onError: (e) => toastError(e),
    mutationFn,
    onSuccess: (stats, args) => {
      queryClient.setQueryData<GitLabTimeStats>(
        statsKey(repo, args.number),
        stats,
      );
      // `exact` — the stats key extends the view key, so a prefix invalidation
      // would mark the stats we just wrote stale and refetch them for nothing.
      queryClient.invalidateQueries({
        queryKey: viewKey(repo, args.number),
        exact: true,
      });
    },
  });
}

// GitLab-only time-tracking view keys — see issueTimeStatsKey: pinned to "origin".
const issueViewKey = (repo: string, number: number) =>
  ["repo", repo, "issue", "origin", number] as const;
const mrViewKey = (repo: string, number: number) =>
  ["repo", repo, "pr", "origin", number] as const;

export function useSetIssueTimeEstimate(repo: string) {
  return useTimeTrackingMutation(
    repo,
    issueTimeStatsKey,
    issueViewKey,
    (args) => api.forgeGlIssueSetTimeEstimate(repo, args.number, args.duration),
  );
}

export function useAddIssueSpentTime(repo: string) {
  return useTimeTrackingMutation(
    repo,
    issueTimeStatsKey,
    issueViewKey,
    (args) => api.forgeGlIssueAddSpentTime(repo, args.number, args.duration),
  );
}

export function useSetMrTimeEstimate(repo: string) {
  return useTimeTrackingMutation(repo, mrTimeStatsKey, mrViewKey, (args) =>
    api.forgeGlMrSetTimeEstimate(repo, args.number, args.duration),
  );
}

export function useAddMrSpentTime(repo: string) {
  return useTimeTrackingMutation(repo, mrTimeStatsKey, mrViewKey, (args) =>
    api.forgeGlMrAddSpentTime(repo, args.number, args.duration),
  );
}

// GitLab-only related-issue links key — pinned to "origin" (see issueTimeStatsKey).
const issueLinksKey = (repo: string, number: number) =>
  ["repo", repo, "issue", "origin", number, "links"] as const;

/** An issue's GitLab related-issue links. Pass `null` when the section isn't
 *  shown so the read doesn't fire. */
export function useGlIssueLinks(repo: string, number: number | null) {
  return useQuery({
    queryKey: issueLinksKey(repo, number ?? 0),
    queryFn: () => api.forgeGlIssueLinks(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
    retry: false,
  });
}

/** Link this issue to another (relates_to). Links are symmetric server-side, so
 *  the target's own links list is invalidated too. */
export function useLinkIssue(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; targetNumber: number }) =>
      api.forgeGlIssueLink(repo, args.number, args.targetNumber),
    // Mutation-level: see useTimeTrackingMutation.
    onError: (e) => toastError(e),
    onSuccess: (_d, args) => {
      queryClient.invalidateQueries({
        queryKey: issueLinksKey(repo, args.number),
      });
      queryClient.invalidateQueries({
        queryKey: issueLinksKey(repo, args.targetNumber),
      });
    },
  });
}

/** Remove a related-issue link by its `linkId`. Invalidates the source's links;
 *  the other side is refreshed on its next open (its `linkId` differs). */
export function useUnlinkIssue(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; linkId: string }) =>
      api.forgeGlIssueUnlink(repo, args.number, args.linkId),
    // Mutation-level: see useTimeTrackingMutation.
    onError: (e) => toastError(e),
    onSuccess: (_d, args) =>
      queryClient.invalidateQueries({
        queryKey: issueLinksKey(repo, args.number),
      }),
  });
}

export function useIssueTypes(
  repo: string,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "issue-types", lens] as const,
    queryFn: () => api.ghIssueTypes(repo, lens),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useSetIssueType(repo: string, lens: RemoteLens) {
  return useOptimisticIssueMutation(
    repo,
    lens,
    (args: {
      number: number;
      typeName: string | null;
      /** The full type for the optimistic patch (backend takes only the name). */
      type?: IssueType | null;
    }) => api.ghIssueSetType(repo, args.number, args.typeName, lens),
    (issue, args) => ({ ...issue, issueType: args.type ?? null }),
  );
}

/**
 * An issue-lifecycle write (close/reopen/edit/pin/lock/transfer/delete) that reconciles
 * NARROWLY instead of whole-repo: the one issue's detail subtree (prefix-matched, so its
 * reactions/relations/dependencies/development sub-queries refresh too) plus every
 * issue-list state variant (row fields change, and transfer/delete change list
 * membership). `numberOf` extracts the number because the arg shapes differ. No
 * optimistic patch — these change fields the details view re-reads wholesale.
 */
function useIssueLifecycleMutation<TArgs, TData>(
  repo: string,
  lens: RemoteLens,
  mutationFn: (args: TArgs) => Promise<TData>,
  numberOf: (args: TArgs) => number,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: (_d, _e, args) =>
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["repo", repo, "issue-list", lens],
        }),
        queryClient.invalidateQueries({
          queryKey: ["repo", repo, "issue", lens, numberOf(args)],
        }),
      ]),
  });
}

export function usePinIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (args: { number: number; pinned: boolean }) =>
      args.pinned
        ? api.ghIssuePin(repo, args.number, lens)
        : api.ghIssueUnpin(repo, args.number, lens),
    (args) => args.number,
  );
}

export function useLockIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (args: { number: number; reason: api.LockReason | null }) =>
      api.forgeIssueLock(repo, args.number, args.reason, lens),
    (args) => args.number,
  );
}

export function useUnlockIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (number: number) => api.forgeIssueUnlock(repo, number, lens),
    (number) => number,
  );
}

export function useIssueReactions(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "issue", lens, number ?? 0, "reactions"] as const,
    queryFn: () => api.forgeIssueReactions(repo, number ?? 0, lens),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

/** An issue's activity timeline for the issue view. Provider-neutral (the backend
 *  dispatches), so the caller passes `enabled = <known provider that has it>` — an
 *  unresolved provider must NOT fetch. Decoupled from the issue view like
 *  {@link useIssueReactions}. */
export function useIssueTimeline(
  repoPath: string,
  number: number,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repoPath, "issue", lens, number, "timeline"] as const,
    queryFn: () => api.forgeIssueTimeline(repoPath, number, lens),
    enabled,
    staleTime: 30_000,
  });
}

function patchReactionList(
  list: Reaction[],
  content: string,
  active: boolean,
): Reaction[] {
  const existing = list.find((r) => r.content === content);
  if (active) {
    // Removing the viewer's reaction.
    if (!existing) return list;
    const count = existing.count - 1;
    return count <= 0
      ? list.filter((r) => r.content !== content)
      : list.map((r) =>
          r.content === content ? { ...r, count, viewerReacted: false } : r,
        );
  }
  // Adding the viewer's reaction.
  if (existing) {
    return list.map((r) =>
      r.content === content
        ? { ...r, count: r.count + 1, viewerReacted: true }
        : r,
    );
  }
  return [...list, { content, count: 1, viewerReacted: true }];
}

/**
 * Toggles the viewer's reaction with an optimistic cache update + rollback.
 * `reactionsKey` is the reactions query; `bodyId` is the issue/PR/discussion body id
 * (anything else is a comment id). `opts` carries the GitLab-side subject (containing
 * issue/MR) — GitHub keys purely on node ids and ignores it.
 */
export function useToggleReaction(
  repo: string,
  reactionsKey: QueryKey,
  bodyId: string,
  opts: { target: api.ReactionTarget; number: number } = {
    target: "discussion",
    number: 0,
  },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      subjectId: string;
      content: string;
      active: boolean;
    }) =>
      args.active
        ? api.forgeRemoveReaction(
            repo,
            opts.target,
            opts.number,
            args.subjectId,
            args.content,
          )
        : api.forgeAddReaction(
            repo,
            opts.target,
            opts.number,
            args.subjectId,
            args.content,
          ),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: reactionsKey });
      const prev = queryClient.getQueryData<IssueReactions>(reactionsKey);
      queryClient.setQueryData<IssueReactions>(reactionsKey, (data) => {
        const base: IssueReactions = data ?? { body: [], comments: {} };
        if (args.subjectId === bodyId) {
          return {
            ...base,
            body: patchReactionList(base.body, args.content, args.active),
          };
        }
        return {
          ...base,
          comments: {
            ...base.comments,
            [args.subjectId]: patchReactionList(
              base.comments[args.subjectId] ?? [],
              args.content,
              args.active,
            ),
          },
        };
      });
      return { prev };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.prev !== undefined) {
        queryClient.setQueryData(reactionsKey, ctx.prev);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: reactionsKey }),
  });
}

export function useDiscussionMeta(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "discussion-meta"] as const,
    queryFn: () => api.ghDiscussionCategories(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useDiscussionList(
  repo: string,
  enabled: boolean,
  category: string | null,
  limit?: number,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "discussion-list",
      category ?? "all",
      limit ?? null,
    ] as const,
    queryFn: () => api.ghDiscussionList(repo, category, limit),
    enabled,
    staleTime: 30_000,
    // Keep current rows visible while a grown "Load more" page loads.
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

const discussionDetailsOptions = (repo: string, number: number) =>
  queryOptions({
    queryKey: ["repo", repo, "discussion", number] as const,
    queryFn: () => api.ghDiscussionView(repo, number),
    staleTime: 30_000,
  });

export function useDiscussionDetails(repo: string, number: number | null) {
  return useQuery({
    ...discussionDetailsOptions(repo, number ?? 0),
    enabled: number !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function usePrefetchDiscussion(repo: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (number: number) => {
      queryClient.prefetchQuery(discussionDetailsOptions(repo, number));
    },
    [queryClient, repo],
  );
}

export function useCreateDiscussion(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      repoId: string;
      categoryId: string;
      title: string;
      body: string;
    }) =>
      api.ghDiscussionCreate(
        repo,
        args.repoId,
        args.categoryId,
        args.title,
        args.body,
      ),
  );
}

export function useAddDiscussionComment(repo: string) {
  return useRepoMutation(
    repo,
    (args: { discussionId: string; body: string; replyToId?: string | null }) =>
      api.ghDiscussionAddComment(
        repo,
        args.discussionId,
        args.body,
        args.replyToId ?? null,
      ),
  );
}

export function useMarkDiscussionAnswer(repo: string) {
  return useRepoMutation(
    repo,
    (args: { commentId: string; answer: boolean }) =>
      args.answer
        ? api.ghDiscussionMarkAnswer(repo, args.commentId)
        : api.ghDiscussionUnmarkAnswer(repo, args.commentId),
  );
}

export function useUpdateDiscussionComment(repo: string) {
  return useRepoMutation(repo, (args: { commentId: string; body: string }) =>
    api.ghDiscussionUpdateComment(repo, args.commentId, args.body),
  );
}

export function useDeleteDiscussionComment(repo: string) {
  return useRepoMutation(repo, (commentId: string) =>
    api.ghDiscussionDeleteComment(repo, commentId),
  );
}

/** Optimistic upvote toggle on a discussion or its comments, with rollback. */
export function useToggleDiscussionUpvote(repo: string, number: number) {
  const queryClient = useQueryClient();
  const key = ["repo", repo, "discussion", number] as const;
  return useMutation({
    mutationFn: (args: { subjectId: string; up: boolean }) =>
      api.ghDiscussionSetUpvote(repo, args.subjectId, args.up),
    onMutate: async (args) => {
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<DiscussionDetails>(key);
      const delta = args.up ? 1 : -1;
      queryClient.setQueryData<DiscussionDetails>(key, (d) =>
        !d
          ? d
          : args.subjectId === d.id
            ? {
                ...d,
                upvoteCount: d.upvoteCount + delta,
                viewerHasUpvoted: args.up,
              }
            : {
                ...d,
                comments: d.comments.map((c) =>
                  c.id === args.subjectId
                    ? {
                        ...c,
                        upvoteCount: c.upvoteCount + delta,
                        viewerHasUpvoted: args.up,
                      }
                    : c,
                ),
              },
      );
      return { prev };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(key, ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: key });
      // The discussion list shows upvote counts too.
      queryClient.invalidateQueries({
        queryKey: ["repo", repo, "discussion-list"],
      });
    },
  });
}

export function useLockDiscussion(repo: string) {
  return useRepoMutation(
    repo,
    (args: { discussionId: string; reason: api.DiscussionLockReason | null }) =>
      api.ghDiscussionLock(repo, args.discussionId, args.reason),
  );
}

export function useUnlockDiscussion(repo: string) {
  return useRepoMutation(repo, (discussionId: string) =>
    api.ghDiscussionUnlock(repo, discussionId),
  );
}

export function useCloseDiscussion(repo: string) {
  return useRepoMutation(
    repo,
    (args: { discussionId: string; reason: api.DiscussionCloseReason }) =>
      api.ghDiscussionClose(repo, args.discussionId, args.reason),
  );
}

export function useReopenDiscussion(repo: string) {
  return useRepoMutation(repo, (discussionId: string) =>
    api.ghDiscussionReopen(repo, discussionId),
  );
}

export function useDeleteDiscussion(repo: string) {
  return useRepoMutation(repo, (discussionId: string) =>
    api.ghDiscussionDelete(repo, discussionId),
  );
}

export function useDiscussionReactions(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "discussion", number ?? 0, "reactions"] as const,
    queryFn: () => api.ghDiscussionReactions(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

export function useCommentIssue(repo: string, lens: RemoteLens) {
  return useOptimisticCreateCommentMutation(repo, "issue", lens, (args) =>
    api.forgeIssueComment(repo, args.number, args.body, lens),
  );
}

export function useCloseIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (args: { number: number; reason: string }) =>
      api.forgeIssueClose(repo, args.number, args.reason, lens),
    (args) => args.number,
  );
}

export function useReopenIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (number: number) => api.forgeIssueReopen(repo, number, lens),
    (number) => number,
  );
}

export function useEditIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (args: { number: number; title: string; body: string }) =>
      api.forgeIssueEdit(repo, args.number, args.title, args.body, lens),
    (args) => args.number,
  );
}

export function useTransferIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (args: { number: number; destination: string }) =>
      api.forgeIssueTransfer(repo, args.number, args.destination, lens),
    (args) => args.number,
  );
}

export function useDeleteIssue(repo: string, lens: RemoteLens) {
  return useIssueLifecycleMutation(
    repo,
    lens,
    (number: number) => api.forgeIssueDelete(repo, number, lens),
    (number) => number,
  );
}

/** An issue's parent + sub-issues, loaded alongside the conversation. */
export function useIssueRelations(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: ["repo", repo, "issue", lens, number ?? 0, "relations"] as const,
    queryFn: () => api.ghIssueRelations(repo, number ?? 0, lens),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

export function useAddSubIssue(repo: string, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: { parentId: string; subNumber: number }) =>
      api.ghIssueAddSubIssue(repo, args.parentId, args.subNumber, lens),
  );
}

/** An issue's blocked-by / blocking dependencies. */
export function useIssueDependencies(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "issue",
      lens,
      number ?? 0,
      "dependencies",
    ] as const,
    queryFn: () => api.ghIssueDependencies(repo, number ?? 0, lens),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

/** An issue's "Development" links: closing PRs + linked branches. */
export function useIssueDevelopment(
  repo: string,
  number: number | null,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "issue",
      lens,
      number ?? 0,
      "development",
    ] as const,
    queryFn: () => api.ghIssueDevelopment(repo, number ?? 0, lens),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

export function useCreateLinkedBranch(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (args: { issueId: string; name: string }) =>
    api.ghIssueCreateLinkedBranch(repo, args.issueId, args.name, lens),
  );
}

export function useSetIssueDependency(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      number: number;
      relation: IssueRelation;
      target: number;
      add: boolean;
    }) =>
      api.ghIssueSetDependency(
        repo,
        args.number,
        args.relation,
        args.target,
        args.add,
        lens,
      ),
    // Cross-issue: a dependency touches BOTH the source's and the target's detail
    // subtrees (their `dependencies` sub-query is keyed by number) — no list-
    // membership change, so scope to the two issues' details rather than repo-wide.
    onSettled: (_d, _e, args) =>
      void Promise.all(
        [args.number, args.target].map((n) =>
          queryClient.invalidateQueries({
            queryKey: ["repo", repo, "issue", lens, n],
          }),
        ),
      ),
  });
}

export function useRemoveSubIssue(repo: string) {
  return useRepoMutation(repo, (args: { parentId: string; subId: string }) =>
    api.ghIssueRemoveSubIssue(repo, args.parentId, args.subId),
  );
}

export function useGhAccounts() {
  return useQuery({
    queryKey: ["gh-accounts"] as const,
    queryFn: api.ghAccounts,
    staleTime: 60_000,
    retry: false,
  });
}

export function useSwitchAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { host: string; login: string }) =>
      api.ghSwitchAccount(args.host, args.login),
    // Deliberately app-wide (no key filter): the active account changes every
    // gh-derived answer, and switches are rare enough that the collateral refetch
    // beats the narrow-invalidation policy used elsewhere.
    onSettled: () => queryClient.invalidateQueries(),
  });
}

/** The saved Bitbucket account (Atlassian API token), or null when none. A fast
 *  keyring check — no network. Connecting/disconnecting invalidates this key and
 *  the forge-status queries so open Bitbucket repos flip ready without a restart. */
export function useBbAccount() {
  return useQuery({
    queryKey: ["bb-account"] as const,
    queryFn: api.forgeBbAccount,
    staleTime: 60_000,
    retry: false,
  });
}

/** The forge session health for THIS repo's provider — drives the "session
 *  expired" reconnect affordances on the not-ready ladders and the expiry notice.
 *  A `state` of "offline" (inconclusive probe) is treated as "no change" by every
 *  consumer, so a network blip never flips the UI. Repo-keyed (repo at index 1). */
export function useForgeSessionHealth(repoPath: string) {
  return useQuery({
    queryKey: ["repo", repoPath, "forge-session-health"] as const,
    queryFn: () => api.forgeSessionHealth(repoPath),
    staleTime: 5 * 60_000,
    enabled: !!repoPath,
    retry: false,
  });
}

/** The health of every known forge account (gh accounts + glab hosts) — the
 *  Accounts settings section merges this into its rows to badge expired sessions
 *  and warn before a knowable token expiry. */
export function useAccountsHealth() {
  return useQuery({
    queryKey: ["accounts-health"] as const,
    queryFn: api.forgeAccountsHealth,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Refresh everything a successful reconnect can change: the accounts-health list,
 *  every repo's forge-status (a dead session flips a repo back to ready) and
 *  forge-session-health, the gh-accounts list (which account is active), the gh
 *  token scopes (a reconnect can grant new ones), and the repo-settings lists a
 *  scope hint sends users here from — secrets, variables and webhooks all fail
 *  closed on a missing scope, so their error cards must retry the call themselves.
 *  Call from a reconnect's `finished: ok` handler. */
export function useInvalidateAfterReconnect() {
  const queryClient = useQueryClient();
  return useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["accounts-health"] });
    queryClient.invalidateQueries({ queryKey: ["gh-accounts"] });
    // Partial key: covers every host variant of useGhScopes' key.
    queryClient.invalidateQueries({ queryKey: ["gh", "token-scopes"] });
    queryClient.invalidateQueries({
      // Partial keys with a repo path in slot 1, so match on the axis instead.
      predicate: (q) =>
        q.queryKey[0] === "repo" &&
        (q.queryKey[2] === "forge-status" ||
          q.queryKey[2] === "forge-session-health" ||
          q.queryKey[2] === "secrets" ||
          q.queryKey[2] === "variables" ||
          q.queryKey[2] === "webhooks"),
    });
  }, [queryClient]);
}

const gitlabReviewBotKey = ["settings", "gitlab-review-bot"] as const;

/** The configured GitLab review-bot login, or null when none. A fast keyring
 *  check — no network. The stored value is only ever the returned login; the
 *  token itself never lands in query data. */
export function useGitlabReviewBotStatus() {
  return useQuery({
    queryKey: gitlabReviewBotKey,
    queryFn: api.forgeGitlabReviewTokenStatus,
    staleTime: 60_000,
    retry: false,
  });
}

/** Save a GitLab review-bot token (validated backend-side); returns the bot login,
 *  which is what the status query then reflects. */
export function useSetGitlabReviewToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) => api.forgeGitlabReviewTokenSet(token),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: gitlabReviewBotKey }),
  });
}

/** Clear the configured GitLab review-bot token. */
export function useClearGitlabReviewToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.forgeGitlabReviewTokenClear(),
    onSettled: () =>
      void queryClient.invalidateQueries({ queryKey: gitlabReviewBotKey }),
  });
}

/** The "no hosted integration" status cold-start test mode forces. */
const NO_FORGE_STATUS: ForgeStatus = {
  provider: null,
  installed: false,
  authenticated: false,
  login: null,
  repo: null,
  host: null,
  capabilities: {
    pullRequests: false,
    draftPrs: false,
    issues: false,
    labels: false,
    milestones: false,
    reactions: false,
    discussions: false,
    stars: false,
    ci: false,
    webhooks: false,
    approvals: false,
    securityFindings: false,
  },
  implemented: {
    pullRequests: false,
    issues: false,
    ci: false,
    releases: false,
    insights: false,
    repoActions: false,
    repoSearch: false,
    repoForkByName: false,
    repoStar: false,
    repoReadme: false,
    publish: false,
    issueComment: false,
    issueState: false,
    mrComment: false,
    mrState: false,
    mrApprove: false,
    mrMerge: false,
    mrAutoMerge: false,
    issueLabels: false,
    mrLabels: false,
    issueAssignees: false,
    issueCreate: false,
    mrCreate: false,
    ciRerun: false,
    ciCancel: false,
    ciDispatch: false,
    releaseCreate: false,
    releaseEdit: false,
    mrAssignees: false,
    mrRequestChanges: false,
    mrReviewers: false,
    issueEdit: false,
    mrEdit: false,
    mrCommentEdit: false,
    issueCommentEdit: false,
    issueMilestone: false,
    issueReactions: false,
    mrReactions: false,
    issueLock: false,
    issueTransfer: false,
    issueDelete: false,
    issueConfidential: false,
    issueDueDate: false,
    repoSettings: false,
    ciJobPlay: false,
    timeTracking: false,
    issueLinks: false,
    prTasks: false,
    mrReviewThreads: false,
    mrThreadReply: false,
    mrThreadResolve: false,
    mrThreadCommentEdit: false,
    commitComments: false,
    mrThreadCreate: false,
    mrReviewSubmit: false,
    mrDraftToggle: false,
  },
};

/**
 * Provider-neutral hosted-integration status — the gate every hosted panel reads
 * (GitHub, GitLab and Bitbucket all dispatch behind it). Honors the cold-start test
 * mode; the probe hits the real CLIs otherwise.
 */
export function useForgeStatus(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "forge-status"] as const,
    queryFn: COLD_START_NO_GH
      ? (): Promise<ForgeStatus> => Promise.resolve(NO_FORGE_STATUS)
      : () => api.forgeStatus(repo),
    staleTime: 60_000,
    retry: false,
  });
}

/** Whether a repo's hosted integration is ready: tooling installed, signed in, and
 *  pointing at a recognized hosted repo. The provider-neutral gate hosted panels check
 *  before fetching or offering hosted actions. */
export function forgeReady(status: ForgeStatus | undefined | null): boolean {
  return Boolean(status?.installed && status?.authenticated && status?.repo);
}

/** Whether the repo's provider supports a given hosted capability — the gate for
 *  a control that some platforms lack (GitLab has no Discussions; Bitbucket has no
 *  labels/milestones/stars/reactions). GitHub is all-true, so this is a no-op gate
 *  there; it's the seam GitLab/Bitbucket need to hide what they can't do. */
export function forgeSupports(
  status: ForgeStatus | undefined | null,
  capability: keyof ForgeCapabilities,
): boolean {
  return Boolean(status?.capabilities[capability]);
}

/** Whether a hosted *feature* is usable here: the integration is ready AND GitDesktop
 *  has built that feature for this provider. Exactly `forgeReady` on GitHub; false on a
 *  *ready* GitLab/Bitbucket repo whose panel isn't wired yet, so it shows "coming
 *  soon". */
export function forgeFeatureReady(
  status: ForgeStatus | undefined | null,
  feature: keyof ForgeImplemented,
): boolean {
  return forgeReady(status) && Boolean(status?.implemented[feature]);
}

// ── Git hooks ────────────────────────────────────────────────────────────────

export function useHooks(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "hooks"] as const,
    queryFn: () => api.gitHooksList(repo),
  });
}

/** A hook's script content, loaded when one is selected for editing. */
export function useHookContent(repo: string, name: string | null) {
  return useQuery({
    queryKey: ["repo", repo, "hook", name] as const,
    queryFn: () => api.gitHookRead(repo, name ?? ""),
    enabled: name !== null,
  });
}

export function useWriteHook(repo: string) {
  return useRepoMutation(repo, (args: { name: string; content: string }) =>
    api.gitHookWrite(repo, args.name, args.content),
  );
}

export function useSetHookEnabled(repo: string) {
  return useRepoMutation(repo, (args: { name: string; enabled: boolean }) =>
    api.gitHookSetEnabled(repo, args.name, args.enabled),
  );
}

export function useDeleteHook(repo: string) {
  return useRepoMutation(repo, (name: string) => api.gitHookDelete(repo, name));
}

export function useRunHookManager(repo: string) {
  return useRepoMutation(
    repo,
    (args: { manager: string; action: "install" | "update" }) =>
      api.gitRunHookManager(repo, args.manager, args.action),
  );
}

/** Every repo the signed-in user can access (clone dialog). */
export function useGhRepos(enabled: boolean) {
  return useQuery({
    queryKey: ["gh-repos"] as const,
    queryFn: api.ghListRepos,
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Stable fallback for an unresolved {@link useForgeRepos} read, so a pending
 *  query doesn't hand its consumers a fresh array identity every render. */
export const EMPTY_NAMESPACES: readonly string[] = [];

/** The signed-in user's repositories on a provider (GitHub via gh, GitLab via
 *  glab), for the clone browser — and its `ownedNamespaces` feeds the repo
 *  menu's Fork gate. The provider-neutral successor to {@link useGhRepos} on
 *  that surface. */
export function useForgeRepos(provider: ForgeProvider, enabled: boolean) {
  return useQuery({
    queryKey: ["forge-repos", provider] as const,
    queryFn: () => api.forgeListRepos(provider),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// ── Explore: search / browse / fork / star / README ──────────────────────────

/** What a provider supports and has built — the Explore surface's gate for the
 *  Fork/Star/README controls. Capabilities rarely change, so cache forever. */
export function useForgeProviderFeatures(provider: ForgeProvider) {
  return useQuery({
    queryKey: ["forge-provider-features", provider] as const,
    queryFn: () => api.forgeProviderFeatures(provider),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** Paged repository search on a provider (empty `query` = the Popular feed on
 *  GitHub/GitLab). Pages are 1-based; `getNextPageParam` walks `hasMore`. */
export function useForgeSearchRepos(
  provider: ForgeProvider,
  query: string,
  sort: "best" | "stars" | "updated",
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: ["forge-search", provider, query, sort] as const,
    queryFn: ({ pageParam }) =>
      api.forgeSearchRepos(provider, query, sort, pageParam),
    initialPageParam: 1,
    getNextPageParam: (lastPage: ForgeSearchList, allPages) =>
      lastPage.hasMore ? allPages.length + 1 : undefined,
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** A repository's rendered README, lazily fetched when a repo is selected in the
 *  Explore detail pane. Null = no README (rendered as a quiet note, not an error). */
export function useRepoReadme(
  provider: ForgeProvider,
  owner: string,
  name: string,
  defaultBranch: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["forge-readme", provider, owner, name, defaultBranch] as const,
    queryFn: () => api.forgeRepoReadme(provider, owner, name, defaultBranch),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

const starredKey = (provider: ForgeProvider, owner: string, name: string) =>
  ["forge-starred", provider, owner, name] as const;

/** Whether the viewer has starred the selected Explore repo — drives the
 *  Star/Unstar toggle's pressed state; only fetched when a repo is selected. */
export function useRepoStarred(
  provider: ForgeProvider,
  owner: string,
  name: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: starredKey(provider, owner, name),
    queryFn: () => api.forgeStarred(provider, owner, name),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Star / unstar a repo, optimistically flipping the starred-query cache with exact-key
 *  snapshot/rollback. The key is derived from the args at mutate time so a mid-flight
 *  repo switch never corrupts another repo's cache. */
export function useStarRepo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      provider: ForgeProvider;
      owner: string;
      name: string;
      star: boolean;
    }) => api.forgeStarRepo(args.provider, args.owner, args.name, args.star),
    onMutate: async (args) => {
      const key = starredKey(args.provider, args.owner, args.name);
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<boolean>(key);
      queryClient.setQueryData<boolean>(key, args.star);
      return { prev, key };
    },
    onError: (_e, _args, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d, _e, args) =>
      void queryClient.invalidateQueries({
        queryKey: starredKey(args.provider, args.owner, args.name),
      }),
  });
}

/** Fork a repo by owner/name. Returns the {@link ForgeForkResult} so the caller
 *  can offer "Clone the fork" (and warn when it's not yet clonable). The new fork
 *  belongs in the provider's own-repos list; invalidating at the mutation level
 *  keeps that refresh alive after the calling pane unmounts. */
export function useForkRepoByName() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      provider: ForgeProvider;
      owner: string;
      name: string;
    }) => api.forgeForkRepo(args.provider, args.owner, args.name),
    onSettled: (_d, _e, args) =>
      void queryClient.invalidateQueries({
        queryKey: ["forge-repos", args.provider],
      }),
  });
}

/**
 * A mutation that invalidates repo queries on completion. Defaults to the whole repo
 * subtree (correct but broad); pass `opts.invalidate` to narrow it for hot mutations
 * (each key is prefix-matched). Reserve the whole-subtree default for ops that touch
 * history or branch topology (checkout/pull/reset/merge); a hot history op (commit)
 * splits instead — narrow awaited `invalidate` plus deferred `opts.invalidateAfter`.
 */
function useRepoMutation<TArgs, TData>(
  repo: string,
  mutationFn: (args: TArgs) => Promise<TData>,
  opts: {
    /** Query keys to invalidate on completion (prefix-matched). Defaults to the
     *  whole repo subtree. */
    invalidate?: readonly (readonly unknown[])[];
    /** Keys invalidated fire-and-forget on top of `invalidate` — NEVER awaited, so
     *  callers can refresh heavy/slow families without holding the mutation's
     *  isPending. Sequenced after the awaited set only under `refetchBeforeSuccess`;
     *  otherwise both fire together in `onSettled`. */
    invalidateAfter?: readonly (readonly unknown[])[];
    /** Invalidate (and AWAIT) in onSuccess instead of fire-and-forget in
     *  onSettled, so the refetch lands BEFORE the caller's own onSuccess —
     *  commit uses this so the emptied list, cleared draft, and toast appear
     *  together. (As a result it does NOT invalidate on error.) */
    refetchBeforeSuccess?: boolean;
    /** Runs on success before any invalidation fires (react-query awaits
     *  `onSuccess` ahead of `onSettled`), so store state can be fixed up while the
     *  cache still describes the pre-mutation world. Must be synchronous — an
     *  async callback's rejection escapes the containment; a synchronous throw
     *  is contained and logged, and the invalidation still runs. */
    onSuccess?: (data: TData, variables: TArgs) => void;
  } = {},
) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    Promise.all(
      (opts.invalidate ?? [repoKeys.all(repo)]).map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
  const invalidateAfter = () =>
    Promise.all(
      (opts.invalidateAfter ?? []).map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
  // A caller's hook must not take the mutation down with it: a throw here would
  // otherwise skip the invalidation, or report a succeeded mutation as failed.
  const notifySuccess = (data: TData, variables: TArgs) => {
    try {
      opts.onSuccess?.(data, variables);
    } catch (e) {
      console.error("[queries] mutation onSuccess failed", e);
    }
  };
  return useMutation({
    mutationFn,
    ...(opts.refetchBeforeSuccess
      ? {
          onSuccess: async (data: TData, variables: TArgs) => {
            notifySuccess(data, variables);
            await invalidate();
            void invalidateAfter();
          },
        }
      : {
          onSuccess: notifySuccess,
          onSettled: () => {
            void invalidate();
            void invalidateAfter();
          },
        }),
  });
}

export function useStage(repo: string) {
  return useRepoMutation(repo, (paths: string[]) => api.gitStage(repo, paths), {
    invalidate: workingTreeKeys(repo),
  });
}

export function useRemoteUrl(repo: string, name: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "remote-url", name] as const,
    queryFn: () => api.gitRemoteUrl(repo, name),
    enabled,
    // Always-visible consumers (RepoLensSwitcher + CreatePrDialog via useRemoteSlug), so
    // it needs a staleTime at all — without one every window focus re-spawned
    // `git remote get-url` twice. Not Infinity: the Rust cache's 5s TTL exists so an
    // external `git remote set-url` is picked up promptly, and in-app edits invalidate
    // this key eagerly (useSetRemoteUrl).
    staleTime: 30_000,
  });
}

export function useSetRemoteUrl(repo: string) {
  return useRepoMutation(repo, (args: { name: string; url: string }) =>
    api.gitRemoteSetUrl(repo, args.name, args.url),
  );
}

/** Adds a remote (e.g. `upstream` on a fork cloned without one). The default broad
 *  invalidation prefix-covers `remotes`/`remote-url`, so `useLensGate` re-reads and the
 *  fork/upstream UI lights up live. */
export function useAddRemote(repo: string) {
  return useRepoMutation(repo, (args: { name: string; url: string }) =>
    api.gitRemoteAdd(repo, args.name, args.url),
  );
}

/** Removes a remote. The default broad invalidation prefix-covers
 *  `remotes`/`remote-url`, so `useLensGate` re-reads and every fork-identity surface
 *  collapses live. */
export function useRemoveRemote(repo: string) {
  return useRepoMutation(repo, (args: { name: string }) =>
    api.gitRemoteRemove(repo, args.name),
  );
}

export function useOpState(repo: string) {
  return useQuery({
    queryKey: repoKeys.opState(repo),
    queryFn: () => api.gitOpState(repo),
  });
}

export function useOpAbort(repo: string) {
  return useRepoMutation(repo, (op: RepoOp) => api.gitOpAbort(repo, op));
}

export function useOpContinue(repo: string) {
  return useRepoMutation(repo, (op: RepoOp) => api.gitOpContinue(repo, op));
}

/** The conflicted file's sides + marked working text, for the conflict editor.
 *  Re-fetches after each per-region resolve (the mutations invalidate this). */
export function useConflictFile(repo: string, path: string) {
  return useQuery({
    queryKey: ["repo", repo, "conflict-file", path] as const,
    queryFn: () => conflictSides(repo, path, []),
    retry: false,
  });
}

const conflictFileKeys = (repo: string) =>
  [...workingTreeKeys(repo), ["repo", repo, "conflict-file"]] as const;

/** Writes a conflict resolution, staging it when `stage` (marks resolved).
 *  Invalidates the working tree + conflict editor so they refresh. */
export function useResolveConflict(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; content: string; stage: boolean }) =>
      resolveConflict(repo, args.path, args.content, args.stage),
    { invalidate: conflictFileKeys(repo) },
  );
}

/** Resolves a whole conflicted file by taking one side ("ours"/"theirs"). */
export function useCheckoutConflictSide(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; side: "ours" | "theirs" }) =>
      checkoutConflictSide(repo, args.path, args.side),
    { invalidate: conflictFileKeys(repo) },
  );
}

export function useFileAtRev(
  repo: string,
  rev: string | null,
  file: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "file-b64", rev ?? "worktree", file] as const,
    queryFn: () => api.gitFileBase64(repo, rev, file),
    enabled,
  });
}

export function useApplyPatch(repo: string) {
  return useRepoMutation(
    repo,
    (args: { patch: string; cached: boolean; reverse: boolean }) =>
      api.gitApplyPatch(repo, args.patch, args.cached, args.reverse),
    { invalidate: workingTreeKeys(repo) },
  );
}

export function useApplyPartial(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      diffText: string;
      selected: api.SelectedLine[];
      cached: boolean;
      reverse: boolean;
    }) =>
      api.gitApplyPartial(
        repo,
        args.diffText,
        args.selected,
        args.cached,
        args.reverse,
      ),
    { invalidate: workingTreeKeys(repo) },
  );
}

/** Discards selected lines from an untracked (new) file (see
 *  {@link api.gitDiscardUntrackedLines}) — line/hunk discard for a new file. */
export function useDiscardUntrackedLines(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; lines: number[] }) =>
      api.gitDiscardUntrackedLines(repo, args.path, args.lines),
    { invalidate: workingTreeKeys(repo) },
  );
}

export function useUnstage(repo: string) {
  return useRepoMutation(
    repo,
    (paths: string[]) => api.gitUnstage(repo, paths),
    { invalidate: workingTreeKeys(repo) },
  );
}

export function useCommit(repo: string) {
  // Awaited: only the working tree, so the emptied changes list, cleared draft,
  // and toast land together without waiting on forge queries; history and branch
  // counters refresh behind the toast (commitAftermathKeys).
  return useRepoMutation(
    repo,
    (args: { title: string; body?: string; amend?: boolean }) =>
      api.gitCommit(repo, args.title, args.body, args.amend ?? false),
    {
      invalidate: workingTreeKeys(repo),
      invalidateAfter: commitAftermathKeys(repo),
      refetchBeforeSuccess: true,
    },
  );
}

export function useCheckoutBranch(repo: string) {
  return useRepoMutation(repo, (name: string) =>
    api.gitCheckoutBranch(repo, name),
  );
}

export function useCheckoutRemoteBranch(repo: string) {
  return useRepoMutation(repo, (args: { remote: string; name: string }) =>
    api.gitCheckoutRemoteBranch(repo, args.remote, args.name),
  );
}

export function useCreateBranch(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      name: string;
      checkout: boolean;
      startPoint?: string;
      noTrack?: boolean;
    }) =>
      api.gitCreateBranch(
        repo,
        args.name,
        args.checkout,
        args.startPoint,
        args.noTrack,
      ),
  );
}

export function useAppendToGitignore(repo: string) {
  return useRepoMutation(repo, (patterns: string[]) =>
    api.appendToGitignore(repo, patterns),
  );
}

export function useAppendRepoAiIgnore(repo: string) {
  return useRepoMutation(
    repo,
    (patterns: string[]) => api.appendRepoAiIgnore(repo, patterns),
    // Staging-class edit — only the working tree changes (the aiignore file
    // appears/updates), so narrow like useStage/useApplySuggestion.
    { invalidate: workingTreeKeys(repo) },
  );
}

export function useUntrack(repo: string) {
  return useRepoMutation(
    repo,
    (args: { pathspecs: string[]; ignorePatterns: string[] }) =>
      api.gitUntrack(repo, args.pathspecs, args.ignorePatterns),
  );
}

/** Every file git tracks — for the Repository files manager. Fetched lazily. */
export function useTrackedFiles(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "tracked-files"] as const,
    queryFn: () => api.gitListTracked(repo),
    enabled,
    staleTime: 30_000,
  });
}

/** Slash-commands + skills available to `agent` (project + global). Fetched
 *  lazily while a slash command is being typed in the agent composer; keyed on
 *  the agent too, since each CLI reads different command/skill directories. */
export function useAgentCommands(
  repo: string,
  agent: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "agent-commands", agent] as const,
    queryFn: () => api.readAgentCommands(repo, agent),
    enabled,
    staleTime: 30_000,
  });
}

/** Files git ignores, with the rule responsible for each. Fetched lazily. */
export function useIgnoredFiles(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "ignored-files"] as const,
    queryFn: () => api.gitIgnoredFiles(repo),
    enabled,
    staleTime: 30_000,
  });
}

export function useForceAdd(repo: string) {
  return useRepoMutation(repo, (pathspecs: string[]) =>
    api.gitForceAdd(repo, pathspecs),
  );
}

export function useUnignoreRules(repo: string) {
  return useRepoMutation(repo, (rules: UnignoreRule[]) =>
    api.gitUnignoreRules(repo, rules),
  );
}

export function useResetToCommit(repo: string) {
  return useRepoMutation(repo, (hash: string) => api.gitReset(repo, hash));
}

/** Moves the CURRENT branch and the working tree to `hash`. The backend refuses
 *  outright while tracked changes are outstanding, so the caller's confirm can
 *  promise a clean tree is required rather than pre-flighting one. */
export function useHardResetToCommit(repo: string) {
  return useRepoMutation(repo, (hash: string) =>
    api.gitReset(repo, hash, "hard"),
  );
}

export function useCheckoutCommit(repo: string) {
  return useRepoMutation(repo, (hash: string) =>
    api.gitCheckoutCommit(repo, hash),
  );
}

export function useRevertCommit(repo: string) {
  return useRepoMutation(repo, (hash: string) => api.gitRevert(repo, hash));
}

export function useCherryPick(repo: string) {
  return useRepoMutation(repo, (hash: string) => api.gitCherryPick(repo, hash));
}

export function useCherryPickOnto(repo: string) {
  return useRepoMutation(
    repo,
    (args: { hashes: string[]; targetBranch: string }) =>
      api.gitCherryPickOnto(repo, args.hashes, args.targetBranch),
  );
}

export function useCreateTag(repo: string) {
  return useRepoMutation(repo, (args: { name: string; hash: string }) =>
    api.gitTag(repo, args.name, args.hash),
  );
}

export function useRewriteCommits(repo: string) {
  return useRepoMutation(repo, (args: { base: string; steps: RewriteStep[] }) =>
    api.gitRewriteCommits(repo, args.base, args.steps),
  );
}

/** Starts a resumable interactive rebase (for plans containing an `edit`); the
 *  rebase pauses and the conflict/op banner takes over. */
export function useRebaseEdit(repo: string) {
  return useRepoMutation(repo, (args: { base: string; steps: RewriteStep[] }) =>
    api.gitRebaseEdit(repo, args.base, args.steps),
  );
}

/** Full messages for the unpushed commits `base..HEAD`, as a hash→message map,
 *  for the Edit-history editor's reword/squash defaults. Enabled only when the
 *  dialog is open with a base. */
export function useUnpushedMessages(
  repo: string,
  base: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "unpushed-messages", base] as const,
    queryFn: async () => {
      const list = await api.gitUnpushedMessages(repo, base);
      return Object.fromEntries(list.map((c) => [c.hash, c.message]));
    },
    enabled: enabled && base !== "",
    staleTime: 0,
  });
}

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

export function useFetchRemote(repo: string) {
  return useRepoMutation(repo, () => api.gitFetch(repo));
}

export function usePull(repo: string) {
  return useRepoMutation(repo, (mode: api.PullMode = "ffOnly") =>
    api.gitPull(repo, mode),
  );
}

/** Stash → run → reapply variants of pull, merge, rebase, and switch. Whole-repo
 *  invalidation like their plain counterparts: each moves HEAD and rewrites the
 *  working tree, and the stash list changes too. */
export function usePullAutostash(repo: string) {
  return useRepoMutation(repo, (mode: api.PullMode = "ffOnly") =>
    api.gitPullAutostash(repo, mode),
  );
}

export function useMergeAutostash(repo: string) {
  return useRepoMutation(repo, (branch: string) =>
    api.gitMergeAutostash(repo, branch),
  );
}

export function useRebaseAutostash(repo: string) {
  return useRepoMutation(repo, (branch: string) =>
    api.gitRebaseAutostash(repo, branch),
  );
}

export function useRebaseOntoAutostash(repo: string) {
  return useRepoMutation(repo, (args: { newBase: string; oldBase: string }) =>
    api.gitRebaseOntoAutostash(repo, args.newBase, args.oldBase),
  );
}

export function useSwitchAutostash(repo: string) {
  return useRepoMutation(
    repo,
    (args: { name: string; remote: string | null; reapply: boolean }) =>
      api.gitSwitchAutostash(repo, args.name, args.remote, args.reapply),
  );
}

/** Outcome of an "Update from upstream" run, for an honest toast. `branch` is
 *  the upstream default branch name (no `upstream/` prefix). */
export type UpstreamUpdateOutcome =
  | { kind: "up-to-date"; branch: string }
  | { kind: "fast-forwarded"; branch: string }
  | { kind: "merged"; branch: string }
  /** The final merge refused to overwrite uncommitted changes. Returned rather
   *  than thrown so the caller can offer stash-and-reapply: `ref` is the
   *  already-resolved `upstream/<branch>`, so the retry needs no re-fetch. */
  | { kind: "dirty-blocked"; branch: string; ref: string };

/**
 * Sync the current branch with a fork's `upstream` remote: fetch upstream
 * (a bare fetch never touches it), resolve upstream's default branch, then
 * bring the current branch up to date by merging `upstream/<default>`.
 *
 * Reuses the existing merge machinery — no second pipeline. The merge
 * fast-forwards silently when possible and creates a merge commit when
 * cleanly diverged; a conflicting merge rejects and leaves the repo in the
 * usual conflict state, so the conflict banner/editor takes over exactly like
 * a branch merge. The preview short-circuits the already-current case so we
 * report "already up to date" instead of a no-op merge. Never auto-pushes —
 * the Push affordance lights up on its own afterward.
 *
 * Default (whole-repo) invalidation, matching the pull/merge flows, so
 * branches, status, and history all refresh.
 */
export function useUpdateFromUpstream(repo: string) {
  return useRepoMutation<void, UpstreamUpdateOutcome>(repo, async () => {
    await api.gitFetchRemote(repo, "upstream");
    const branch = await api.gitRemoteDefaultBranch(repo, "upstream");
    const ref = `upstream/${branch}`;
    // Strategy-free preview: only used to short-circuit the already-current
    // case; every other status runs the real merge below.
    const preview = await api.gitMergePreview(repo, ref, "none");
    if (preview.status === "up-to-date") {
      return { kind: "up-to-date", branch };
    }
    const fastForward = preview.status === "fast-forward";
    // Plain merge: ff-when-possible, merge commit otherwise. A conflict makes
    // gitMerge reject — the error propagates and the conflict UI takes over.
    // Only this final step can hit the dirty-tree refusal (fetch/resolve/preview
    // never touch the working tree), so it alone is caught and reported as an
    // outcome; every other failure still throws.
    try {
      await api.gitMerge(repo, ref, false, false, "none");
    } catch (e) {
      if (isDirtyTreeRefusal(e)) return { kind: "dirty-blocked", branch, ref };
      throw e;
    }
    return { kind: fastForward ? "fast-forwarded" : "merged", branch };
  });
}

export function useSubmodules(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "submodules"] as const,
    queryFn: () => api.gitSubmodules(repo),
    staleTime: 30_000,
  });
}

export function useUpdateSubmodule(repo: string) {
  return useRepoMutation(repo, (path?: string) =>
    api.gitSubmoduleUpdate(repo, path),
  );
}

export function usePush(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      setUpstream: boolean;
      force?: boolean;
      branch?: string;
      remote?: string;
      /** Destination branch name when it differs from the local one (pushing to a
       *  fork PR's head); requires `branch` and `remote`, and never tracks. */
      remoteBranch?: string;
    }) =>
      api.gitPush(
        repo,
        args.setUpstream,
        args.force ?? false,
        args.branch,
        args.remote,
        args.remoteBranch,
      ),
  );
}

export function useUndoCommit(repo: string) {
  return useRepoMutation(repo, () => api.gitUndoCommit(repo));
}

export function useDefaultBranch(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "default-branch"] as const,
    queryFn: () => api.gitDefaultBranch(repo),
  });
}

export function useStashCount(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "stash-count"] as const,
    queryFn: () => api.gitStashCount(repo),
  });
}

export function useRenameBranch(repo: string) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    (args: { oldName: string; newName: string }) =>
      api.gitRenameBranch(repo, args.oldName, args.newName),
    {
      onSuccess: (_data, args) => {
        // Re-key the branch's commit draft before the status refetch reports the new
        // name, so the draft (and any generation streaming into it) survives.
        // Renames from outside the app (MCP, a terminal `git branch -m`) have no such
        // hook and still lose the draft when the ambient poll flips the key.
        useUiStore
          .getState()
          .migrateCommitDraft(repo, args.oldName, args.newName);
        // The backend moved the branch's reviewer note on disk as part of the rename;
        // reload the in-memory store BEFORE invalidating (the focus bridge's pattern in
        // App.tsx) so the Create-PR dialog reads the note under the new name without
        // waiting for a focus cycle. Fire-and-forget — this callback must stay sync.
        void reloadReviewNotes()
          .then(() =>
            queryClient.invalidateQueries({ queryKey: ["review-notes"] }),
          )
          .catch(() => {
            // Best-effort: a failed reload just leaves the last known state.
          });
      },
    },
  );
}

export function useSetBranchArchived(repo: string) {
  return useRepoMutation(repo, (args: { name: string; archived: boolean }) =>
    api.gitSetBranchArchived(repo, args.name, args.archived),
  );
}

export function useDeleteBranch(repo: string) {
  return useRepoMutation(repo, (name: string) =>
    api.gitDeleteBranch(repo, name),
  );
}

/** Deletes a branch on its remote (`git push <remote> --delete`). Invalidates
 *  the remote-branches list (the row disappears) and the local branches (their
 *  upstream may now be gone). */
export function useDeleteRemoteBranch(repo: string) {
  return useRepoMutation(
    repo,
    (args: { remote: string; name: string }) =>
      api.gitDeleteRemoteBranch(repo, args.remote, args.name),
    {
      invalidate: [["repo", repo, "remote-branches"], repoKeys.branches(repo)],
    },
  );
}

export function useDiscardAll(repo: string) {
  return useRepoMutation(repo, () => api.gitDiscardAll(repo));
}

export function useDiscardPaths(repo: string) {
  return useRepoMutation(
    repo,
    (paths: { path: string; untracked: boolean }[]) =>
      api.gitDiscardPaths(repo, paths),
  );
}

export function useStashAll(repo: string) {
  return useRepoMutation(repo, () => api.gitStashAll(repo));
}

export function useStashPaths(repo: string) {
  return useRepoMutation(repo, (paths: string[]) =>
    api.gitStashPaths(repo, paths),
  );
}

export function useStashPop(repo: string) {
  return useRepoMutation(repo, () => api.gitStashPop(repo));
}

export function useStashList(repo: string, enabled = false) {
  return useQuery({
    queryKey: ["repo", repo, "stashes"] as const,
    queryFn: () => api.gitStashList(repo),
    enabled,
  });
}

export function useStashFiles(repo: string, index: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "stash-files", index ?? -1] as const,
    queryFn: () => api.gitStashFiles(repo, index ?? 0),
    enabled: index !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function useStashFileDiff(
  repo: string,
  index: number | null,
  filePath: string | null,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "stash-diff",
      index ?? -1,
      filePath ?? "",
    ] as const,
    queryFn: () => api.gitStashFileDiff(repo, index ?? 0, filePath ?? ""),
    enabled: index !== null && filePath !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function useStashApply(repo: string) {
  return useRepoMutation(repo, (args: { index: number; pop: boolean }) =>
    api.gitStashApply(repo, args.index, args.pop),
  );
}

export function useStashDrop(repo: string) {
  return useRepoMutation(repo, (index: number) =>
    api.gitStashDrop(repo, index),
  );
}

/** Dangling stash commits recovered via `git fsck` — the LAZY fsck trigger for
 *  the Stashes dialog's "Recoverable" view. `fsck` is slow, so enable this only
 *  while that view is actually shown. */
export function useOrphanedStashes(repo: string, enabled = false) {
  return useQuery({
    queryKey: ["repo", repo, "orphaned-stashes"] as const,
    queryFn: () => api.gitOrphanedStashes(repo),
    enabled,
    // fsck is slow: don't re-scan on every toggle back to Recoverable (Rescan forces
    // one), and keep the list on screen during a refetch instead of blanking to a
    // spinner.
    staleTime: 60_000,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function useOrphanedStashFiles(repo: string, sha: string | null) {
  return useQuery({
    queryKey: ["repo", repo, "orphaned-stash-files", sha ?? ""] as const,
    queryFn: () => api.gitOrphanedStashFiles(repo, sha ?? ""),
    enabled: sha !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function useOrphanedStashFileDiff(
  repo: string,
  sha: string | null,
  filePath: string | null,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "orphaned-stash-diff",
      sha ?? "",
      filePath ?? "",
    ] as const,
    queryFn: () =>
      api.gitOrphanedStashFileDiff(repo, sha ?? "", filePath ?? ""),
    enabled: sha !== null && filePath !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

/** Restore an orphaned stash to the working tree (`git stash apply <sha>` — never
 *  drops). Default whole-repo invalidation refreshes the status and stash lists. */
export function useRestoreOrphaned(repo: string) {
  return useRepoMutation(repo, (sha: string) =>
    api.gitRestoreOrphaned(repo, sha),
  );
}

/** Reconcile-on-read for the interrupted-op recovery banner. Lives under the repo
 *  subtree, so a ConflictBanner Continue/Abort re-runs it and clears the banner. */
export function useOplogCheck(repo: string, enabled = true) {
  return useQuery({
    queryKey: ["repo", repo, "oplog-check"] as const,
    queryFn: () => api.gitOplogCheck(repo),
    enabled,
    staleTime: 30_000,
  });
}

/** The full operation journal, gated to fetch only while the history dialog is
 *  open (a pure read, but no reason to run it otherwise). */
export function useOplogHistory(repo: string, enabled = false) {
  return useQuery({
    queryKey: ["repo", repo, "oplog"] as const,
    queryFn: () => api.gitOplogList(repo),
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

/** Dismiss a journal entry so it stops surfacing as interrupted. Default
 *  invalidation refetches the repo subtree, clearing the banner. */
export function useDismissOplog(repo: string) {
  return useRepoMutation(repo, (id: string) => api.gitOplogDismiss(repo, id));
}

export function useMergeBranch(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      branch: string;
      squash: boolean;
      noFf: boolean;
      strategy: api.MergeConflictStrategy;
    }) =>
      api.gitMerge(repo, args.branch, args.squash, args.noFf, args.strategy),
  );
}

/** Predicts a merge's outcome (fast-forward / clean / conflict / …) in memory,
 *  for the merge picker. Strategy-aware — re-runs when the conflict strategy
 *  changes so the prediction matches what the merge will actually do. Enabled
 *  only while the picker is open with a branch. */
export function useMergePreview(
  repo: string,
  branch: string,
  strategy: api.MergeConflictStrategy,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "merge-preview", branch, strategy] as const,
    queryFn: () => api.gitMergePreview(repo, branch, strategy),
    enabled: enabled && branch !== "",
    staleTime: 15_000,
  });
}

export function useRebaseBranch(repo: string) {
  return useRepoMutation(repo, (branch: string) => api.gitRebase(repo, branch));
}

/** Rebases the current branch onto `newBase`, replaying only `oldBase..HEAD`
 *  (the "branched off the wrong branch" fix). Conflicts leave the rebase in
 *  progress for the conflict banner, exactly like {@link useRebaseBranch}. */
export function useRebaseOnto(repo: string) {
  return useRepoMutation(repo, (args: { newBase: string; oldBase: string }) =>
    api.gitRebaseOnto(repo, args.newBase, args.oldBase),
  );
}

/** Ahead/behind of every local branch vs `base`. Gated on `enabled` (it's N rev-list
 *  calls) and keyed under the repo so branch mutations invalidate it. */
export function useBranchDivergence(
  repo: string,
  base: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "divergence", base] as const,
    queryFn: () => api.gitBranchDivergence(repo, base ?? ""),
    enabled: enabled && Boolean(base),
    // Local rev-list reads only. react-query's default "online" mode parks the
    // fetch whenever the OS reports no connection, and a parked query is neither
    // loading nor errored — consumers would silently render without divergence.
    networkMode: "always",
  });
}

export function useUpdateBranchFrom(repo: string) {
  return useRepoMutation(repo, (args: { branch: string; base: string }) =>
    api.gitUpdateBranchFrom(repo, args.branch, args.base),
  );
}

/**
 * Whether a diverged branch's upstream was rewritten under it (a remote rebase
 * or force-push), and what a reset to that upstream would cost.
 *
 * LAZY on purpose: `enabled` must stay false unless a surface is actually facing
 * a diverged branch, so the ordinary in-sync path spawns no git. Keyed under the
 * repo, so the whole-subtree invalidation every fetch/pull/push mutation already
 * runs refreshes it. Local rev-list reads only — `networkMode: "always"` keeps
 * an offline OS from parking the query into a permanent pending state, matching
 * {@link useBranchDivergence}.
 */
export function useBranchRewriteStatus(
  repo: string,
  branch: string | null,
  opts: { enabled: boolean },
) {
  return useQuery({
    ...branchRewriteStatusOptions(repo, branch ?? ""),
    enabled: opts.enabled && Boolean(branch),
  });
}

/** The one options object behind {@link useBranchRewriteStatus}. Exported so an
 *  IMPERATIVE probe — a palette action that has to decide before it acts, with no
 *  render to hang a hook on — reads and caches exactly what the hook would, rather
 *  than a second spelling that can drift from it. */
export function branchRewriteStatusOptions(repo: string, branch: string) {
  return {
    queryKey: ["repo", repo, "rewrite-status", branch] as const,
    queryFn: () => api.gitBranchRewriteStatus(repo, branch),
    staleTime: 30_000,
    networkMode: "always" as const,
  };
}

/** Points a NON-current branch at its upstream's tip, refusing if that upstream
 *  moved away from `expectedTip` since the caller measured it. The current branch
 *  takes {@link useHardResetToCommit} instead — only that moves the working tree
 *  with it. */
export function useBranchResetToUpstream(repo: string) {
  return useRepoMutation(
    repo,
    (args: { branch: string; expectedTip: string }) =>
      api.gitBranchResetToUpstream(repo, args.branch, args.expectedTip),
  );
}

export function useMergeLocalPr(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      base: string;
      head: string;
      message: string;
      strategy: api.MergeStrategy;
    }) =>
      api.gitMergeLocalPr(
        repo,
        args.base,
        args.head,
        args.message,
        args.strategy,
      ),
  );
}

/** Commits a paused local-PR merge once its conflicts are resolved in the worktree. */
export function useFinishLocalPrMerge(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      base: string;
      strategy: api.MergeStrategy;
      message: string;
      worktreePath: string;
      worktreeId: string;
      opId: string | null;
    }) =>
      api.gitFinishLocalPrMerge(
        repo,
        args.base,
        args.strategy,
        args.message,
        args.worktreePath,
        args.worktreeId,
        args.opId,
      ),
  );
}

/** Rolls a paused local-PR merge back by deleting its isolated worktree. */
export function useAbortLocalPrMerge(repo: string) {
  return useRepoMutation(
    repo,
    (args: { worktreePath: string; opId: string | null }) =>
      api.gitAbortLocalPrMerge(repo, args.worktreePath, args.opId),
  );
}

/** Merges the base into a remote PR's head branch in an isolated worktree, pushing the
 *  head when it comes out clean. Repo-wide invalidation is deliberate: a clean run moves
 *  the remote branch, so mergeability, the PR view and branch state all go stale. */
export function useMergeRemotePr(repo: string, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: { number: number; base: string; head: string; message?: string }) =>
      api.gitMergeRemotePr(
        repo,
        args.number,
        args.base,
        args.head,
        args.message ?? null,
        lens,
      ),
  );
}

/** Commits a paused remote-PR resolution and pushes the head branch. */
export function useFinishRemotePrResolve(repo: string, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: {
      head: string;
      worktreePath: string;
      worktreeId: string;
      message?: string;
    }) =>
      api.gitFinishRemotePrResolve(
        repo,
        args.head,
        args.worktreePath,
        args.worktreeId,
        args.message ?? null,
        lens,
      ),
  );
}

/** Discards a paused remote-PR resolution by deleting its worktree. */
export function useAbortRemotePrResolve(repo: string) {
  return useRepoMutation(repo, (args: { worktreePath: string }) =>
    api.gitAbortRemotePrResolve(repo, args.worktreePath),
  );
}

/** An unfinished resolve worktree for this PR (e.g. left by an earlier session), or
 *  null — feeds the banner's resume offer. Keyed by lens like every sibling PR key:
 *  the fork's #7 and the parent's #7 are different pull requests. */
export function useFindRemotePrResolve(
  repo: string,
  number: number | null,
  lens: RemoteLens,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "pr",
      lens,
      number ?? 0,
      "resolve-worktree",
    ] as const,
    queryFn: () => api.gitFindRemotePrResolve(repo, number ?? 0, lens),
    enabled: enabled && number !== null,
    staleTime: 5_000,
  });
}

/** Pre-merge conflict prediction for a local PR's `base`/`head`, keyed under the
 *  repo so merge mutations invalidate it. Gate with `enabled` (skip while the tree
 *  has tracked changes or the PR can't merge). */
export function useConflictPreview(
  repo: string,
  base: string,
  head: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "conflict-preview", base, head] as const,
    queryFn: () => api.gitConflictPreview(repo, base, head),
    enabled: enabled && base !== "" && head !== "",
    staleTime: 15_000,
  });
}

export function useCommentPr(repo: string, lens: RemoteLens) {
  return useOptimisticCreateCommentMutation(repo, "pr", lens, (args) =>
    api.forgePrComment(repo, args.number, args.body, args.asBot, lens),
  );
}

/** A merge/pull request's approval state — the approve/unapprove toggle's driver
 *  (GitLab + Bitbucket; GitHub approves via its Review menu, so `implemented.mrApprove`
 *  is false there). Pass `null` when the toggle isn't shown so the read doesn't fire;
 *  keyed under the "origin" lens segment (the lens switcher is GitHub-only). */
export function usePrApprovals(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "pr", "origin", number ?? 0, "approvals"] as const,
    queryFn: () => api.forgePrApprovals(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
    retry: false,
  });
}

export function useApprovePr(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrApprove(repo, number, lens),
  );
}

/** A PR's task checklist (Bitbucket-only, gated on `implemented.prTasks`). Pass
 *  `null` when the panel isn't shown so the read doesn't fire (mirrors
 *  `usePrApprovals`). */
export function usePrTasks(repo: string, number: number | null) {
  return useQuery({
    queryKey: prTasksKey(repo, number ?? 0),
    queryFn: () => api.forgeBbPrTasks(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
    retry: false,
  });
}

// PR-task mutations invalidate the exact tasks key onSettled; the component patches its
// own local state optimistically (like toggleApproval), so no optimistic logic lives in
// the hooks. Bitbucket-only, so the key sits under the "origin" lens segment.
export const prTasksKey = (repo: string, number: number) =>
  ["repo", repo, "pr", "origin", number, "tasks"] as const;

export function useCreatePrTask(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; text: string }) =>
      api.forgeBbPrTaskCreate(repo, args.number, args.text),
    onSettled: (_d, _e, args) =>
      queryClient.invalidateQueries({
        queryKey: prTasksKey(repo, args.number),
      }),
  });
}

export function useEditPrTask(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; taskId: string; text: string }) =>
      api.forgeBbPrTaskEdit(repo, args.number, args.taskId, args.text),
    onSettled: (_d, _e, args) =>
      queryClient.invalidateQueries({
        queryKey: prTasksKey(repo, args.number),
      }),
  });
}

export function useSetPrTaskState(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; taskId: string; resolved: boolean }) =>
      api.forgeBbPrTaskSetState(repo, args.number, args.taskId, args.resolved),
    onSettled: (_d, _e, args) =>
      queryClient.invalidateQueries({
        queryKey: prTasksKey(repo, args.number),
      }),
  });
}

export function useDeletePrTask(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; taskId: string }) =>
      api.forgeBbPrTaskDelete(repo, args.number, args.taskId),
    onSettled: (_d, _e, args) =>
      queryClient.invalidateQueries({
        queryKey: prTasksKey(repo, args.number),
      }),
  });
}

export function useUnapprovePr(repo: string) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrUnapprove(repo, number),
  );
}

/** Request changes on an MR with an optional comment (GitLab + Bitbucket, gated
 *  on `implemented.mrRequestChanges`). The caller patches the approvals cache
 *  optimistically, like the approve toggle. */
export function useRequestChangesPr(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (args: { number: number; body: string }) =>
    api.forgePrRequestChanges(repo, args.number, args.body, lens),
  );
}

/** Revoke the viewer's requested-changes state (Bitbucket-only — its revoke works
 *  on every plan, so the request-changes control toggles there). Same
 *  caller-patches-optimistically contract as `useRequestChangesPr`. */
export function useUnrequestChangesPr(repo: string) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrUnrequestChanges(repo, number),
  );
}

/** Toggle a PR/MR's draft state both ways on all three providers. `lens` threads the
 *  fork identity through to the GitHub arm. Optimistically patches `isDraft` with
 *  field-scoped rollback so the badge flips instantly; the repo-wide invalidate on
 *  settle reconciles server truth and refreshes the merge gate. */
export function useSetPrDraft(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; draft: boolean }) =>
      api.forgePrSetDraft(repo, args.number, args.draft, lens),
    onMutate: async (args) => {
      const key = ["repo", repo, "pr", lens, args.number] as const;
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<PrDetails>(key);
      queryClient.setQueryData<PrDetails>(key, (d) =>
        d ? { ...d, isDraft: args.draft } : d,
      );
      // Field-scoped rollback: capture only the isDraft we flipped, not the whole
      // PrDetails, so a failed draft-set doesn't revert a concurrent
      // assignee/reviewer-set sharing this PR key.
      return { key, prevIsDraft: prev?.isDraft };
    },
    onError: (_e, _args, ctx) => {
      const prevIsDraft = ctx?.prevIsDraft;
      const key = ctx?.key;
      if (prevIsDraft === undefined || key === undefined) return;
      queryClient.setQueryData<PrDetails>(key, (cur) =>
        cur ? { ...cur, isDraft: prevIsDraft } : cur,
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  });
}

/** The reviewer picker's candidates (Bitbucket: workspace members minus the user the
 *  server would reject). For an existing PR pass its number (excludes the PR author);
 *  at create time pass `null` (no PR yet — excludes the viewer), keyed on "create".
 *  Fetched only while the picker is enabled — the popover is the sole consumer. */
export function useReviewerCandidates(
  repo: string,
  number: number | null,
  enabled: boolean,
  lens: RemoteLens,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "pr",
      lens,
      number ?? "create",
      "reviewer-candidates",
    ] as const,
    queryFn: () => api.forgePrReviewerCandidates(repo, number, lens),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Replace an MR's reviewer list (all three providers, `implemented.mrReviewers`) with
 *  an optimistic PR-details patch + field-scoped rollback. The list is the picker's
 *  HUMAN set; bot/team requests never travel through it (preserved provider-side). */
export function useSetPrReviewers(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; reviewers: ForgeUserRef[] }) =>
      api.forgePrSetReviewers(
        repo,
        args.number,
        args.reviewers.map((r) => r.id),
        lens,
      ),
    onMutate: async (args) => {
      const key = ["repo", repo, "pr", lens, args.number] as const;
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<PrDetails>(key);
      queryClient.setQueryData<PrDetails>(key, (d) =>
        d ? { ...d, reviewers: args.reviewers } : d,
      );
      // Field-scoped rollback: capture only the reviewers we replaced, not the
      // whole PrDetails, so a failed reviewer-set doesn't revert a concurrent
      // assignee-set sharing this PR key.
      return { key, prevReviewers: prev?.reviewers };
    },
    onError: (_e, _args, ctx) => {
      const prevReviewers = ctx?.prevReviewers;
      const key = ctx?.key;
      if (prevReviewers === undefined || key === undefined) return;
      queryClient.setQueryData<PrDetails>(key, (cur) =>
        cur ? { ...cur, reviewers: prevReviewers } : cur,
      );
    },
    onSettled: (_d, _e, args) =>
      queryClient.invalidateQueries({
        queryKey: ["repo", repo, "pr", lens, args.number],
      }),
  });
}

/** Set a PR/MR's assignees (GitHub + GitLab, gated on `implemented.mrAssignees`) with an
 *  optimistic PR-details patch + field-scoped rollback — the CLI spawns a process per
 *  call, so waiting on the round trip is visible. */
export function useSetPrAssignees(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; assignees: ForgeUserRef[] }) =>
      api.forgeMrSetAssignees(
        repo,
        args.number,
        args.assignees.map((a) => a.id),
        lens,
      ),
    onMutate: async (args) => {
      const key = ["repo", repo, "pr", lens, args.number] as const;
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<PrDetails>(key);
      queryClient.setQueryData<PrDetails>(key, (d) =>
        d ? { ...d, assignees: args.assignees } : d,
      );
      // Field-scoped rollback: capture only the assignees we replaced, not the
      // whole PrDetails, so a failed assignee-set doesn't revert a concurrent
      // reviewer-set sharing this PR key.
      return { key, prevAssignees: prev?.assignees };
    },
    onError: (_e, _args, ctx) => {
      const prevAssignees = ctx?.prevAssignees;
      const key = ctx?.key;
      if (prevAssignees === undefined || key === undefined) return;
      queryClient.setQueryData<PrDetails>(key, (cur) =>
        cur ? { ...cur, assignees: prevAssignees } : cur,
      );
    },
    onSettled: (_d, _e, args) =>
      queryClient.invalidateQueries({
        queryKey: ["repo", repo, "pr", lens, args.number],
      }),
  });
}

export function useMergePr(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useRepoMutation(
    repo,
    async (args: {
      number: number;
      strategy: api.MergeStrategy;
      deleteBranch: boolean;
      /** GitLab stale-view guard (the MR head sha); GitHub ignores it. */
      sha?: string;
    }) => {
      const outcome = await api.forgePrMerge(
        repo,
        args.number,
        args.strategy,
        args.deleteBranch,
        args.sha,
        lens,
      );
      // The remote advanced but the local repo is now stale (ahead/behind, history,
      // tracking refs). Kick off a background `git fetch --prune` so they catch up —
      // NOT awaited, so the merge toast fires the moment the call resolves, and
      // silent: the forge already accepted the merge (landed or queued), so a fetch
      // failure toast would misreport it (header Fetch stays the manual fallback).
      // The mutation's own invalidation refreshes the forge-side PR state.
      void api
        .gitFetch(repo)
        .then(() =>
          queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
        )
        .catch(() => undefined);
      return outcome;
    },
  );
}

/** What an update-branch makes stale on the PR side: the PR subtree (details and its
 *  commits/files/checks rollup, mergeability, diff, review threads) plus the rows that
 *  carry PR state. Exported because the set has to run TWICE — once when the forge
 *  accepts the job, and again once the poll sees the head actually move, since the
 *  first pass reads a head that has not shifted yet. */
export const prUpdateBranchKeys = (
  repo: string,
  number: number,
  lens: RemoteLens,
) =>
  [
    ["repo", repo, "pr", lens, number],
    ["repo", repo, "pr-list", lens],
    ["repo", repo, "prs", lens],
  ] as const;

/** Merge (or rebase) the base branch into a PR's head — GitHub's "Update branch".
 *  GitHub QUEUES the work and answers 202, so resolving means accepted, not done —
 *  `usePrBaseDivergence.awaitUpdate` is what waits for the head to move, and the caller
 *  re-runs `prUpdateBranchKeys` once it has. Only the remote moved, so this pass is
 *  narrow: those keys plus the divergence key by name (it is a sibling of the PR
 *  subtree, not a child). Keyed off the args like the label mutation, which
 *  `useRepoMutation`'s static option can't do. */
export function usePrUpdateBranch(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; rebase: boolean; lens: RemoteLens }) =>
      api.ghPrUpdateBranch(repo, args.number, args.rebase, args.lens),
    onSettled: (_d, _e, args) => {
      const keys: QueryKey[] = [
        ...prUpdateBranchKeys(repo, args.number, args.lens),
        prBaseDivergencePrefix(repo, args.number),
      ];
      return void Promise.all(
        keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
  });
}

/** Approve a workflow run GitHub is holding for maintainer approval (a first-time
 *  contributor's fork PR). Invalidates the Actions subtree like re-run/cancel, plus
 *  the PR subtree — the PR checks list renders these runs off PR details. */
export function useApproveWorkflowRun(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // `lens` is optional because the Actions tab is origin-scoped by design;
    // the PR checks strip renders under either lens and must pass its own.
    mutationFn: (args: { runId: number; lens?: RemoteLens }) =>
      api.forgeCiRunApprove(repo, args.runId, args.lens),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["repo", repo, "actions"] });
      queryClient.invalidateQueries({ queryKey: ["repo", repo, "pr"] });
    },
  });
}

/** GitLab pipeline statuses that count as "in flight" — the auto-merge affordance
 *  is only offered while a pipeline hasn't settled, and the merge-state poll runs
 *  fast while one is running. Both the view and this query classify against it. */
export const PIPELINE_IN_FLIGHT = [
  "created",
  "waiting_for_resource",
  "preparing",
  "pending",
  "running",
] as const;

/** A GitLab MR's merge/auto-merge state — the auto-merge dropdown + "auto-merge
 *  enabled" footer. Pass `null` when auto-merge isn't shown so the read doesn't fire.
 *  Polls because the merge fires SERVER-side once the pipeline passes and neither the
 *  pipeline completing nor the auto-merge emits a client event: fast while armed or a
 *  pipeline is in flight, slow otherwise. */
export function useGlMrMergeState(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "pr", number ?? 0, "gl-merge-state"] as const,
    queryFn: () => api.forgeGlMrMergeState(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 5_000,
    retry: false,
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      return d.autoMergeEnabled ||
        (PIPELINE_IN_FLIGHT as readonly string[]).includes(d.pipelineStatus)
        ? 8_000
        : 30_000;
    },
    refetchIntervalInBackground: false,
  });
}

/** Arm auto-merge (merge-when-pipeline-succeeds) on a GitLab MR. Default repo-wide
 *  invalidation is deliberate: an arm can race into an immediate merge when the
 *  pipeline just passed, so the whole MR view must refresh. */
export function useGlArmAutoMerge(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      number: number;
      strategy: api.MergeStrategy;
      deleteBranch: boolean;
      /** Stale-view guard (the MR head sha) — GitLab 409s if the head moved. */
      sha?: string;
    }) =>
      api.forgeGlMrAutoMerge(
        repo,
        args.number,
        args.strategy,
        args.deleteBranch,
        args.sha,
      ),
  );
}

export function useGlCancelAutoMerge(repo: string) {
  return useRepoMutation(repo, (number: number) =>
    api.forgeGlMrCancelAutoMerge(repo, number),
  );
}

/** Remove a GitLab project's fork relationship (detach from the fork network) —
 *  GitLab-only. Deliberately does NO cache patching or invalidation: `isFork` is
 *  forge truth that only flips via a re-probe, so the Danger-zone call site owns
 *  the post-success `probeAndPersistVisibility` + settings invalidation. */
export function useGlRemoveForkRelationship(repo: string) {
  return useMutation({
    mutationFn: () => api.forgeGlRemoveForkRelationship(repo),
  });
}

export function useClosePr(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrClose(repo, number, lens),
  );
}

export function useReopenPr(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrReopen(repo, number, lens),
  );
}

/** Monotonic counter for synthetic optimistic-comment ids — combined with the
 *  `optimistic:` prefix it can never collide with a real provider node id. */
let optimisticCommentSeq = 0;

/**
 * Optimistically appends a synthetic conversation comment to a PR/issue detail cache
 * with exact-key rollback (a full glab round trip is ~2-4s). The synthetic row carries a
 * collision-proof `optimistic:<n>` id and `viewerDidAuthor: false`, so it offers no
 * edit/delete (its temp id would 404 server-side); the reconciling refetch replaces it.
 * Only the flat `comments` array is touched — inline review threads live in another
 * query.
 */
function useOptimisticCreateCommentMutation<TData>(
  repo: string,
  kind: "pr" | "issue",
  lens: RemoteLens,
  // `asBot` posts as the configured GitLab review-bot identity (ignored elsewhere).
  mutationFn: (args: {
    number: number;
    body: string;
    asBot?: boolean;
  }) => Promise<TData>,
) {
  return useOptimisticCacheMutation<
    { number: number; body: string; author: string; asBot?: boolean },
    TData,
    PrDetails | IssueDetails
  >(
    (args) => mutationFn(args),
    (args) => ["repo", repo, kind, lens, args.number] as const,
    (d, args) => {
      const synthetic: PrThreadOut = {
        author: args.author,
        // Optimistic: login-derived (GitHub) / initial until the refetch fills it.
        authorAvatarUrl: "",
        state: "",
        body: args.body,
        date: new Date().toISOString(),
        id: `optimistic:${(optimisticCommentSeq += 1)}`,
        url: "",
        viewerDidAuthor: false,
        isMinimized: false,
        minimizedReason: "",
        // Synthetic conversation comment — belongs to no review.
        reviewId: "",
      };
      return d ? { ...d, comments: [...d.comments, synthetic] } : d;
    },
    (queryClient) =>
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  );
}

/**
 * Optimistic edit/delete of a flat conversation comment on a PR/issue detail cache, with
 * exact-key rollback (a glab round trip is ~2-4s). Only the flat `comments` array is
 * touched; inline review threads live in a separate query and aren't editable here.
 * `kind` selects the detail subtree ("pr" | "issue").
 */
function useOptimisticCommentMutation<
  TArgs extends { number: number; commentId: string },
  TData,
>(
  repo: string,
  kind: "pr" | "issue",
  lens: RemoteLens,
  mutationFn: (args: TArgs) => Promise<TData>,
  patchComment: (comment: PrThreadOut, args: TArgs) => PrThreadOut | null,
) {
  return useOptimisticCacheMutation<TArgs, TData, PrDetails | IssueDetails>(
    mutationFn,
    (args) => ["repo", repo, kind, lens, args.number] as const,
    (d, args) =>
      d
        ? {
            ...d,
            comments: d.comments.flatMap((c) => {
              if (c.id !== args.commentId) return [c];
              const patched = patchComment(c, args);
              return patched ? [patched] : [];
            }),
          }
        : d,
    (queryClient) =>
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  );
}

export function useEditPrComment(repo: string, lens: RemoteLens) {
  return useOptimisticCommentMutation(
    repo,
    "pr",
    lens,
    (args: { number: number; commentId: string; body: string }) =>
      api.forgePrEditComment(repo, args.number, args.commentId, args.body),
    (comment, args) => ({ ...comment, body: args.body }),
  );
}

export function useDeletePrComment(repo: string, lens: RemoteLens) {
  return useOptimisticCommentMutation(
    repo,
    "pr",
    lens,
    (args: { number: number; commentId: string }) =>
      api.forgePrDeleteComment(repo, args.number, args.commentId),
    () => null,
  );
}

export function useEditIssueComment(repo: string, lens: RemoteLens) {
  return useOptimisticCommentMutation(
    repo,
    "issue",
    lens,
    (args: { number: number; commentId: string; body: string }) =>
      api.forgeIssueEditComment(repo, args.number, args.commentId, args.body),
    (comment, args) => ({ ...comment, body: args.body }),
  );
}

export function useDeleteIssueComment(repo: string, lens: RemoteLens) {
  return useOptimisticCommentMutation(
    repo,
    "issue",
    lens,
    (args: { number: number; commentId: string }) =>
      api.forgeIssueDeleteComment(repo, args.number, args.commentId),
    () => null,
  );
}

/**
 * Optimistic edit/delete one level down (thread → comments) in the review-threads cache,
 * with exact-key rollback; a delete that empties a thread drops the thread. `commentId`
 * is unique across threads (provider comment ids), so no threadId is needed.
 */
function useOptimisticReviewCommentMutation<
  TArgs extends { number: number; commentId: string },
  TData,
>(
  repo: string,
  lens: RemoteLens,
  mutationFn: (args: TArgs) => Promise<TData>,
  patchComment: (comment: PrThreadOut, args: TArgs) => PrThreadOut | null,
) {
  return useOptimisticCacheMutation<TArgs, TData, ReviewThreadOut[]>(
    mutationFn,
    (args) => prReviewThreadsKey(repo, args.number, lens),
    (threads, args) =>
      threads?.flatMap((t) => {
        if (!t.comments.some((c) => c.id === args.commentId)) return [t];
        const comments = t.comments.flatMap((c) => {
          if (c.id !== args.commentId) return [c];
          const patched = patchComment(c, args);
          return patched ? [patched] : [];
        });
        // A delete that empties the thread drops the whole card (server does too).
        return comments.length === 0 ? [] : [{ ...t, comments }];
      }),
    (queryClient) =>
      void queryClient.invalidateQueries({ queryKey: repoKeys.all(repo) }),
  );
}

export function useEditReviewComment(repo: string, lens: RemoteLens) {
  return useOptimisticReviewCommentMutation(
    repo,
    lens,
    (args: { number: number; commentId: string; body: string }) =>
      api.forgePrEditReviewComment(
        repo,
        args.number,
        args.commentId,
        args.body,
      ),
    (comment, args) => ({ ...comment, body: args.body }),
  );
}

export function useDeleteReviewComment(repo: string, lens: RemoteLens) {
  return useOptimisticReviewCommentMutation(
    repo,
    lens,
    (args: { number: number; commentId: string }) =>
      api.forgePrDeleteReviewComment(repo, args.number, args.commentId),
    () => null,
  );
}

export function useMinimizeComment(repo: string) {
  return useRepoMutation(
    repo,
    (args: { commentId: string; classifier: api.MinimizeReason }) =>
      api.ghPrMinimizeComment(repo, args.commentId, args.classifier),
  );
}

export function useUnminimizeComment(repo: string) {
  return useRepoMutation(repo, (commentId: string) =>
    api.ghPrUnminimizeComment(repo, commentId),
  );
}

export function useCheckoutPr(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (number: number) =>
    api.ghPrCheckout(repo, number, lens),
  );
}

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

const webhooksKey = (repo: string) => ["repo", repo, "webhooks"] as const;

export function useWebhooks(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: webhooksKey(repo),
    queryFn: () => api.ghHooksList(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

function useWebhookMutation<TArgs, TData>(
  repo: string,
  mutationFn: (args: TArgs) => Promise<TData>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    // Refetch the list so created/edited hooks and ping/test delivery results
    // (last response) show immediately.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: webhooksKey(repo) }),
  });
}

export function useCreateWebhook(repo: string) {
  return useWebhookMutation(repo, (input: WebhookInput) =>
    api.ghHookCreate(repo, input),
  );
}

export function useUpdateWebhook(repo: string) {
  return useWebhookMutation(repo, (args: { id: number; input: WebhookInput }) =>
    api.ghHookUpdate(repo, args.id, args.input),
  );
}

export function useDeleteWebhook(repo: string) {
  return useWebhookMutation(repo, (id: number) => api.ghHookDelete(repo, id));
}

export function usePingWebhook(repo: string) {
  return useWebhookMutation(repo, (id: number) => api.ghHookPing(repo, id));
}

export function useTestWebhook(repo: string) {
  return useWebhookMutation(repo, (id: number) => api.ghHookTest(repo, id));
}

const deliveriesKey = (repo: string, hookId: number) =>
  ["repo", repo, "webhook-deliveries", hookId] as const;

export function useWebhookDeliveries(
  repo: string,
  hookId: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: deliveriesKey(repo, hookId),
    queryFn: () => api.ghHookDeliveries(repo, hookId),
    enabled,
    staleTime: 15_000,
    retry: false,
  });
}

export function useWebhookDelivery(
  repo: string,
  hookId: number,
  deliveryId: string | null,
) {
  return useQuery({
    queryKey: ["repo", repo, "webhook-delivery", hookId, deliveryId] as const,
    queryFn: () => api.ghHookDelivery(repo, hookId, deliveryId as string),
    // A past delivery is immutable, so it never goes stale once fetched.
    enabled: deliveryId != null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

export function useRedeliverWebhook(repo: string, hookId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (deliveryId: string) =>
      api.ghHookRedeliver(repo, hookId, deliveryId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: deliveriesKey(repo, hookId) }),
  });
}

const repoSettingsKey = (repo: string) =>
  ["repo", repo, "repo-settings"] as const;

export function useRepoSettings(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: repoSettingsKey(repo),
    queryFn: () => api.ghRepoSettingsGet(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useUpdateRepoSettings(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: RepoSettingsInput) =>
      api.ghRepoSettingsUpdate(repo, input),
    // The PATCH returns the fresh settings — seed the cache, then refetch.
    onSuccess: (data) => queryClient.setQueryData(repoSettingsKey(repo), data),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: repoSettingsKey(repo) }),
  });
}

// The GitLab settings surface — its own query (the models are provider-shaped;
// see GitLabRepoSettings) but the same key family, so lifecycle mutations'
// invalidations hit both providers' reads.
const glRepoSettingsKey = (repo: string) =>
  ["repo", repo, "repo-settings", "gitlab"] as const;

export function useGlRepoSettings(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: glRepoSettingsKey(repo),
    queryFn: () => api.forgeGlRepoSettings(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useUpdateGlRepoSettings(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GitLabRepoSettingsInput) =>
      api.forgeGlRepoSettingsUpdate(repo, input),
    // The PUT returns the fresh settings — seed the cache, then refetch.
    onSuccess: (data) =>
      queryClient.setQueryData(glRepoSettingsKey(repo), data),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glRepoSettingsKey(repo) }),
  });
}

// The GitLab settings sub-surfaces: Members, Webhooks, CI/CD variables.
const glMembersKey = (repo: string) => ["repo", repo, "gl-members"] as const;
const glHooksKey = (repo: string) => ["repo", repo, "gl-webhooks"] as const;
const glHookEventsKey = (repo: string, hookId: string) =>
  ["repo", repo, "gl-webhook-events", hookId] as const;
const glVariablesKey = (repo: string) =>
  ["repo", repo, "gl-variables"] as const;

export function useGlMembers(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: glMembersKey(repo),
    queryFn: () => api.forgeGlMembers(repo),
    enabled,
    retry: false,
  });
}

export function useGlAddMember(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { username: string; accessLevel: number }) =>
      api.forgeGlMemberAdd(repo, a.username, a.accessLevel),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glMembersKey(repo) }),
  });
}

export function useGlUpdateMember(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { userId: string; accessLevel: number }) =>
      api.forgeGlMemberUpdate(repo, a.userId, a.accessLevel),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glMembersKey(repo) }),
  });
}

export function useGlRemoveMember(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.forgeGlMemberRemove(repo, userId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glMembersKey(repo) }),
  });
}

export function useGlHooks(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: glHooksKey(repo),
    queryFn: () => api.forgeGlHooks(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useGlCreateHook(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: GitLabHookInput) => api.forgeGlHookCreate(repo, input),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glHooksKey(repo) }),
  });
}

export function useGlUpdateHook(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { hookId: string; input: GitLabHookInput }) =>
      api.forgeGlHookUpdate(repo, a.hookId, a.input),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glHooksKey(repo) }),
  });
}

export function useGlDeleteHook(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (hookId: string) => api.forgeGlHookDelete(repo, hookId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glHooksKey(repo) }),
  });
}

export function useGlTestHook(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { hookId: string; trigger: string }) =>
      api.forgeGlHookTest(repo, a.hookId, a.trigger),
    // A test lands in the delivery log (and can flip alert_status).
    onSettled: (_d, _e, a) => {
      queryClient.invalidateQueries({ queryKey: glHooksKey(repo) });
      queryClient.invalidateQueries({
        queryKey: glHookEventsKey(repo, a.hookId),
      });
    },
  });
}

export function useGlHookEvents(repo: string, hookId: string | null) {
  return useQuery({
    queryKey: glHookEventsKey(repo, hookId ?? ""),
    queryFn: () => api.forgeGlHookEvents(repo, hookId ?? ""),
    enabled: hookId != null,
    staleTime: 15_000,
    retry: false,
  });
}

export function useGlResendHookEvent(repo: string, hookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (eventId: string) =>
      api.forgeGlHookResend(repo, hookId, eventId),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: glHookEventsKey(repo, hookId),
      }),
  });
}

export function useGlVariables(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: glVariablesKey(repo),
    queryFn: () => api.forgeGlVariables(repo),
    enabled,
    retry: false,
  });
}

export function useGlSetVariable(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: {
      key: string;
      value: string;
      protected: boolean;
      masked: boolean;
      create: boolean;
      scope: string;
    }) => api.forgeGlVariableSet(repo, a),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glVariablesKey(repo) }),
  });
}

export function useGlDeleteVariable(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { key: string; scope: string }) =>
      api.forgeGlVariableDelete(repo, a.key, a.scope),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: glVariablesKey(repo) }),
  });
}

const glProtectedBranchesKey = (repo: string) =>
  ["repo", repo, "gl-protected-branches"] as const;

export function useGlProtectedBranches(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: glProtectedBranchesKey(repo),
    queryFn: () => api.forgeGlProtectedBranches(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useGlProtectBranch(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: {
      name: string;
      pushAccessLevel: number;
      mergeAccessLevel: number;
      allowForcePush: boolean;
    }) => api.forgeGlProtectedBranchCreate(repo, a),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: glProtectedBranchesKey(repo),
      }),
  });
}

/** Force-push is the only row-editable field; glab spawns a process per call
 *  (~1s+), so patch the cached row optimistically or the Switch visibly lags
 *  and snaps back. */
export function useGlUpdateProtectedBranch(repo: string) {
  const queryClient = useQueryClient();
  const key = glProtectedBranchesKey(repo);
  return useMutation({
    mutationFn: (a: { name: string; allowForcePush: boolean }) =>
      api.forgeGlProtectedBranchUpdate(repo, a.name, a.allowForcePush),
    onMutate: async (a) => {
      await queryClient.cancelQueries({ queryKey: key });
      const prev = queryClient.getQueryData<GitLabProtectedBranch[]>(key);
      queryClient.setQueryData<GitLabProtectedBranch[]>(key, (rows) =>
        rows?.map((r) =>
          r.name === a.name ? { ...r, allowForcePush: a.allowForcePush } : r,
        ),
      );
      return { prev };
    },
    onError: (_e, _a, ctx) => {
      if (ctx?.prev !== undefined) queryClient.setQueryData(key, ctx.prev);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
}

export function useGlUnprotectBranch(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.forgeGlProtectedBranchDelete(repo, name),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: glProtectedBranchesKey(repo),
      }),
  });
}

/** Project paths the viewer is a member of on this repo's host — the Move
 *  dialog's destination suggestions (host-correct for self-managed GitLab). */
export function useGlMemberProjects(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "gl-member-projects"] as const,
    queryFn: () => api.forgeGlMemberProjects(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// ── Bitbucket settings surface ─────────────────────────────────────────────
// Mirrors the useGl* hooks: repo-keyed reads (staleTime + retry:false) and mutations
// that invalidate their read onSettled. The workspaces list is account-scoped, not
// repo-keyed.

/** The viewer's Bitbucket workspaces — the publish target picker. Account-scoped,
 *  so it's NOT repo-keyed; cached broadly since workspaces rarely change. */
export function useBbWorkspaces(enabled: boolean) {
  return useQuery({
    queryKey: ["bb", "workspaces"] as const,
    queryFn: () => api.forgeBbWorkspaces(),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

const bbRepoSettingsKey = (repo: string) =>
  ["repo", repo, "repo-settings", "bitbucket"] as const;

export function useBbRepoSettings(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbRepoSettingsKey(repo),
    queryFn: () => api.forgeBbRepoSettings(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useBbUpdateRepoSettings(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: BitbucketRepoSettingsInput) =>
      api.forgeBbRepoSettingsUpdate(repo, input),
    // The PUT returns the fresh settings — seed the cache, then refetch.
    onSuccess: (data) =>
      queryClient.setQueryData(bbRepoSettingsKey(repo), data),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: bbRepoSettingsKey(repo) }),
  });
}

const bbDefaultReviewersKey = (repo: string) =>
  ["repo", repo, "bb-default-reviewers"] as const;

export function useBbDefaultReviewers(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbDefaultReviewersKey(repo),
    queryFn: () => api.forgeBbDefaultReviewers(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** Workspace members (no author exclusion) — the default-reviewers picker. */
export function useBbMemberCandidates(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "bb-member-candidates"] as const,
    queryFn: () => api.forgeBbMemberCandidates(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useBbAddDefaultReviewer(repo: string) {
  return useRepoMutation(
    repo,
    (uuid: string) => api.forgeBbDefaultReviewerAdd(repo, uuid),
    {
      invalidate: [bbDefaultReviewersKey(repo)],
    },
  );
}

export function useBbRemoveDefaultReviewer(repo: string) {
  return useRepoMutation(
    repo,
    (uuid: string) => api.forgeBbDefaultReviewerRemove(repo, uuid),
    {
      invalidate: [bbDefaultReviewersKey(repo)],
    },
  );
}

const bbBranchRestrictionsKey = (repo: string) =>
  ["repo", repo, "bb-branch-restrictions"] as const;

export function useBbBranchRestrictions(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbBranchRestrictionsKey(repo),
    queryFn: () => api.forgeBbBranchRestrictions(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useBbCreateBranchRestriction(repo: string) {
  return useRepoMutation(
    repo,
    (a: { kind: string; pattern: string; value: number | null }) =>
      api.forgeBbBranchRestrictionCreate(repo, a.kind, a.pattern, a.value),
    { invalidate: [bbBranchRestrictionsKey(repo)] },
  );
}

export function useBbUpdateBranchRestriction(repo: string) {
  return useRepoMutation(
    repo,
    (a: { id: string; kind: string; pattern: string; value: number | null }) =>
      api.forgeBbBranchRestrictionUpdate(
        repo,
        a.id,
        a.kind,
        a.pattern,
        a.value,
      ),
    { invalidate: [bbBranchRestrictionsKey(repo)] },
  );
}

export function useBbDeleteBranchRestriction(repo: string) {
  return useRepoMutation(
    repo,
    (id: string) => api.forgeBbBranchRestrictionDelete(repo, id),
    { invalidate: [bbBranchRestrictionsKey(repo)] },
  );
}

const bbPipelinesConfigKey = (repo: string) =>
  ["repo", repo, "bb-pipelines-config"] as const;

export function useBbPipelinesConfig(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbPipelinesConfigKey(repo),
    queryFn: () => api.forgeBbPipelinesConfig(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useBbSetPipelinesEnabled(repo: string) {
  return useRepoMutation(
    repo,
    (enabled: boolean) => api.forgeBbPipelinesConfigUpdate(repo, enabled),
    { invalidate: [bbPipelinesConfigKey(repo)] },
  );
}

export const bbVariablesKey = (repo: string) =>
  ["repo", repo, "bb-variables"] as const;

export function useBbVariables(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbVariablesKey(repo),
    queryFn: () => api.forgeBbPipelineVariables(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

// Create/update do NOT invalidate immediately: Bitbucket's variables LIST lags a
// write by ~1s (server replication), so an immediate refetch returns a list WITHOUT
// the just-written row and clobbers the optimistic cache patch (the row blinks out).
// The caller upserts the row into the cache and schedules ONE delayed invalidate to
// reconcile the real server row/uuid. Delete keeps its immediate invalidate below.
export function useBbCreateVariable(repo: string) {
  return useMutation({
    mutationFn: (a: { key: string; value: string; secured: boolean }) =>
      api.forgeBbPipelineVariableCreate(repo, a.key, a.value, a.secured),
  });
}

export function useBbUpdateVariable(repo: string) {
  return useMutation({
    mutationFn: (a: { uuid: string; value: string; secured: boolean }) =>
      api.forgeBbPipelineVariableUpdate(repo, a.uuid, a.value, a.secured),
  });
}

export function useBbDeleteVariable(repo: string) {
  return useRepoMutation(
    repo,
    (uuid: string) => api.forgeBbPipelineVariableDelete(repo, uuid),
    { invalidate: [bbVariablesKey(repo)] },
  );
}

const bbSchedulesKey = (repo: string) =>
  ["repo", repo, "bb-schedules"] as const;

export function useBbSchedules(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbSchedulesKey(repo),
    queryFn: () => api.forgeBbPipelineSchedules(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

// Create does NOT invalidate immediately — same ~1s Bitbucket list-replication lag as
// pipeline variables (see useBbCreateVariable): the refetch would return a list WITHOUT
// the new row. The caller upserts the row and schedules ONE delayed invalidate.
// Toggle/delete keep their immediate invalidate below.
export function useBbCreateSchedule(repo: string) {
  return useMutation({
    mutationFn: (a: {
      refName: string;
      cronPattern: string;
      enabled: boolean;
    }) =>
      api.forgeBbPipelineScheduleCreate(
        repo,
        a.refName,
        a.cronPattern,
        a.enabled,
      ),
  });
}

export function useBbSetScheduleEnabled(repo: string) {
  return useRepoMutation(
    repo,
    (a: { uuid: string; enabled: boolean }) =>
      api.forgeBbPipelineScheduleSetEnabled(repo, a.uuid, a.enabled),
    { invalidate: [bbSchedulesKey(repo)] },
  );
}

export function useBbDeleteSchedule(repo: string) {
  return useRepoMutation(
    repo,
    (uuid: string) => api.forgeBbPipelineScheduleDelete(repo, uuid),
    { invalidate: [bbSchedulesKey(repo)] },
  );
}

const bbHooksKey = (repo: string) => ["repo", repo, "bb-webhooks"] as const;

export function useBbHooks(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: bbHooksKey(repo),
    queryFn: () => api.forgeBbHooks(repo),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export function useBbCreateHook(repo: string) {
  return useRepoMutation(
    repo,
    (input: BitbucketHookInput) => api.forgeBbHookCreate(repo, input),
    { invalidate: [bbHooksKey(repo)] },
  );
}

export function useBbUpdateHook(repo: string) {
  return useRepoMutation(
    repo,
    (a: { uuid: string; input: BitbucketHookInput }) =>
      api.forgeBbHookUpdate(repo, a.uuid, a.input),
    { invalidate: [bbHooksKey(repo)] },
  );
}

export function useBbDeleteHook(repo: string) {
  return useRepoMutation(
    repo,
    (uuid: string) => api.forgeBbHookDelete(repo, uuid),
    { invalidate: [bbHooksKey(repo)] },
  );
}

/** The repo's Bitbucket deployment environments (rank-sorted). Read-only —
 *  fetched only when the consuming surface is enabled. */
export function useBbEnvironments(repo: string, enabled: boolean) {
  return useQuery<BbEnvironment[]>({
    queryKey: ["repo", repo, "bb-environments"] as const,
    queryFn: () => api.forgeBbEnvironments(repo),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

// Secrets & variables. `env: null` = repository scope; a string = that
// environment (Actions only). Keyed by app + scope so each list caches apart.
const secretsKey = (repo: string, app: SecretApp, env: string | null) =>
  ["repo", repo, "secrets", app, env ?? "$repo"] as const;
const variablesKey = (repo: string, env: string | null) =>
  ["repo", repo, "variables", env ?? "$repo"] as const;

export function useSecrets(
  repo: string,
  app: SecretApp,
  env: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: secretsKey(repo, app, env),
    queryFn: () => api.ghSecretsList(repo, app, env),
    enabled,
    retry: false,
  });
}

export function useSetSecret(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: {
      app: SecretApp;
      env: string | null;
      name: string;
      value: string;
    }) => api.ghSecretSet(repo, a.app, a.env, a.name, a.value),
    onSettled: (_d, _e, a) =>
      queryClient.invalidateQueries({
        queryKey: secretsKey(repo, a.app, a.env),
      }),
  });
}

export function useDeleteSecret(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { app: SecretApp; env: string | null; name: string }) =>
      api.ghSecretDelete(repo, a.app, a.env, a.name),
    onSettled: (_d, _e, a) =>
      queryClient.invalidateQueries({
        queryKey: secretsKey(repo, a.app, a.env),
      }),
  });
}

export function useVariables(
  repo: string,
  env: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: variablesKey(repo, env),
    queryFn: () => api.ghVariablesList(repo, env),
    enabled,
    retry: false,
  });
}

export function useSetVariable(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { env: string | null; name: string; value: string }) =>
      api.ghVariableSet(repo, a.env, a.name, a.value),
    onSettled: (_d, _e, a) =>
      queryClient.invalidateQueries({ queryKey: variablesKey(repo, a.env) }),
  });
}

export function useDeleteVariable(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { env: string | null; name: string }) =>
      api.ghVariableDelete(repo, a.env, a.name),
    onSettled: (_d, _e, a) =>
      queryClient.invalidateQueries({ queryKey: variablesKey(repo, a.env) }),
  });
}

export function useEnvironments(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "environments"] as const,
    queryFn: () => api.ghEnvironmentsList(repo),
    enabled,
    retry: false,
    staleTime: 60_000,
  });
}

const dependabotKey = (repo: string) => ["repo", repo, "dependabot"] as const;

/** The repo's local `.github/dependabot.yml` text (null when there is none). */
export function useDependabotConfig(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: dependabotKey(repo),
    queryFn: () => api.dependabotGet(repo),
    enabled,
    retry: false,
  });
}

export function useSetDependabot(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.dependabotSet(repo, content),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: dependabotKey(repo) }),
  });
}

export function useDeleteDependabot(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.dependabotDelete(repo),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: dependabotKey(repo) }),
  });
}

const fundingKey = (repo: string) => ["repo", repo, "funding"] as const;

/** The repo's local `.github/FUNDING.yml` text (null when there is none). */
export function useFunding(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: fundingKey(repo),
    queryFn: () => api.fundingGet(repo),
    enabled,
    retry: false,
  });
}

export function useSetFunding(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) => api.fundingSet(repo, content),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: fundingKey(repo) }),
  });
}

export function useDeleteFunding(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.fundingDelete(repo),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: fundingKey(repo) }),
  });
}

const collaboratorsKey = (repo: string) =>
  ["repo", repo, "collaborators"] as const;
const invitationsKey = (repo: string) => ["repo", repo, "invitations"] as const;

export function useCollaborators(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: collaboratorsKey(repo),
    queryFn: () => api.ghCollaboratorsList(repo),
    enabled,
    retry: false,
  });
}

export function useAddCollaborator(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { username: string; role: RepoRole }) =>
      api.ghCollaboratorAdd(repo, a.username, a.role),
    // An add can land as an immediate grant OR a pending invitation.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: collaboratorsKey(repo) });
      queryClient.invalidateQueries({ queryKey: invitationsKey(repo) });
    },
  });
}

export function useRemoveCollaborator(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (username: string) => api.ghCollaboratorRemove(repo, username),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: collaboratorsKey(repo) }),
  });
}

export function useInvitations(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: invitationsKey(repo),
    queryFn: () => api.ghInvitationsList(repo),
    enabled,
    retry: false,
  });
}

export function useUpdateInvitation(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: string; permission: RepoRole }) =>
      api.ghInvitationUpdate(repo, a.id, a.permission),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: invitationsKey(repo) }),
  });
}

export function useCancelInvitation(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.ghInvitationCancel(repo, id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: invitationsKey(repo) }),
  });
}

const securityKey = (repo: string) => ["repo", repo, "security"] as const;

export function useSecurity(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: securityKey(repo),
    queryFn: () => api.ghSecurityGet(repo),
    enabled,
    retry: false,
  });
}

export function useApplySecurity(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: { feature: SecurityFeature; enabled: boolean }[]) =>
      api.ghSecurityApply(repo, changes),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: securityKey(repo) }),
  });
}

// Lifecycle mutations dispatch behind the abstraction (GitHub repo / GitLab
// project). `repoSettingsKey` invalidation prefix-matches the GitLab settings
// key too, so both providers' reads refresh.
export function useSetVisibility(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (visibility: string) =>
      api.forgeRepoSetVisibility(repo, visibility),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: repoSettingsKey(repo) });
      queryClient.invalidateQueries({ queryKey: securityKey(repo) });
    },
  });
}

export function useTransferRepo(repo: string) {
  return useMutation({
    mutationFn: (a: { newOwner: string; newName: string | null }) =>
      api.forgeRepoTransfer(repo, a.newOwner, a.newName),
  });
}

export function useDeleteRepo(repo: string) {
  return useMutation({ mutationFn: () => api.forgeRepoDelete(repo) });
}

export function useSetArchived(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (archived: boolean) => api.forgeRepoSetArchived(repo, archived),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: repoSettingsKey(repo) }),
  });
}

export function useRenameRepo(repo: string) {
  return useMutation({
    mutationFn: (newName: string) => api.forgeRepoRename(repo, newName),
  });
}

const pagesKey = (repo: string) => ["repo", repo, "pages"] as const;

/** GitHub Pages config (null when Pages is disabled). */
export function usePages(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: pagesKey(repo),
    queryFn: () => api.ghPagesGet(repo),
    enabled,
    retry: false,
  });
}

export function useEnablePages(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: {
      buildType: string;
      branch: string | null;
      path: string | null;
    }) => api.ghPagesEnable(repo, a.buildType, a.branch, a.path),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: pagesKey(repo) }),
  });
}

export function useUpdatePages(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      buildType?: string;
      branch?: string;
      path?: string;
      cname?: string;
      httpsEnforced?: boolean;
    }) => api.ghPagesUpdate(repo, args),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: pagesKey(repo) }),
  });
}

export function useDisablePages(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.ghPagesDisable(repo),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: pagesKey(repo) }),
  });
}

const rulesetsKey = (repo: string) => ["repo", repo, "rulesets"] as const;
const rulesetKey = (repo: string, id: number | null) =>
  ["repo", repo, "ruleset", id] as const;

export function useRulesets(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: rulesetsKey(repo),
    queryFn: () => api.ghRulesetsList(repo),
    enabled,
    retry: false,
  });
}

/** The full ruleset for the editor; only fetches once an id is set. */
export function useRuleset(repo: string, id: number | null) {
  return useQuery({
    queryKey: rulesetKey(repo, id),
    queryFn: () => api.ghRulesetGet(repo, id as number),
    enabled: id != null,
    retry: false,
  });
}

export function useCreateRuleset(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.ghRulesetCreate(repo, body),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: rulesetsKey(repo) }),
  });
}

export function useUpdateRuleset(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: number; body: Record<string, unknown> }) =>
      api.ghRulesetUpdate(repo, a.id, a.body),
    onSettled: (_d, _e, a) => {
      queryClient.invalidateQueries({ queryKey: rulesetsKey(repo) });
      queryClient.invalidateQueries({ queryKey: rulesetKey(repo, a.id) });
    },
  });
}

export function useDeleteRuleset(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.ghRulesetDelete(repo, id),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: rulesetsKey(repo) }),
  });
}

export function useSetRulesetEnforcement(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (a: { id: number; enforcement: RulesetEnforcement }) =>
      api.ghRulesetSetEnforcement(repo, a.id, a.enforcement),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: rulesetsKey(repo) }),
  });
}

export function useEditPr(repo: string, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: {
      number: number;
      title: string;
      body: string;
      /** Retarget the PR onto this base branch. Omit to leave the base alone —
       *  a no-op retarget is still a forge write, and GitHub rejects one on a
       *  stacked PR. */
      base?: string;
    }) =>
      api.forgePrEdit(
        repo,
        args.number,
        args.title,
        args.body,
        lens,
        args.base,
      ),
  );
}

/** Stack a chain of open PRs (bottom→top) into a new stack. Takes the default
 *  whole-repo invalidation: stacking rewrites every member's base and position,
 *  so the PR detail, the list, and each member's own row all go stale at once —
 *  the same reasoning as the PR-lifecycle mutations beside it. */
export function useStackCreate(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (pullRequests: number[]) =>
    api.forgeStackCreate(repo, pullRequests, lens),
  );
}

/** Append a chain of open PRs (bottom→top) to an existing stack. */
export function useStackAdd(repo: string, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: { stackNumber: number; pullRequests: number[] }) =>
      api.forgeStackAdd(repo, args.stackNumber, args.pullRequests, lens),
  );
}

/** Dissolve a stack — its members stay open on their branches, unstacked. */
export function useStackDissolve(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (stackNumber: number) =>
    api.forgeStackDissolve(repo, stackNumber, lens),
  );
}

/** Add/remove labels on an issue, MR, or GitHub Discussion. GitHub uses the node-id path
 *  (`labelableId` + `addIds`/`removeIds`); GitLab uses names (`target` + `number` +
 *  `addNames`/`removeNames`). `kind` is the reconcile discriminator and picks the wire
 *  `target` (issue→"issue", mr→"mr", discussion→"issue" with number 0, which the node-id
 *  path ignores). Reconciles per-kind on settle instead of whole-repo. */
export function useEditPrLabels(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      kind: "issue" | "mr" | "discussion";
      number: number;
      labelableId: string;
      addIds: string[];
      removeIds: string[];
      addNames?: string[];
      removeNames?: string[];
    }) =>
      api.forgeEditLabels(
        repo,
        args.kind === "mr" ? "mr" : "issue",
        // GitHub Discussions use the node-id path; the wire number is unused and
        // stays 0 to match the old `args.number ?? 0` default byte-for-byte.
        args.kind === "discussion" ? 0 : args.number,
        args.labelableId,
        args.addIds,
        args.removeIds,
        args.addNames ?? [],
        args.removeNames ?? [],
      ),
    // Mutation-level: see useTimeTrackingMutation. The label pickers are keyed per
    // entity, so a switch mid-flight used to drop the failure silently.
    onError: (e) => toastError(e),
    onSettled: (_d, _e, args) => {
      // Issue/MR narrow keys carry the lens they were read under; discussions are
      // not lens-scoped (GitHub Discussions have no fork lens) — keyed as before.
      const keysByKind: Record<typeof args.kind, (n: number) => QueryKey[]> = {
        issue: (n) => [
          ["repo", repo, "issue-list", lens],
          ["repo", repo, "issue", lens, n],
        ],
        mr: (n) => [
          ["repo", repo, "pr", lens, n],
          ["repo", repo, "pr-list", lens],
        ],
        discussion: (n) => [
          ["repo", repo, "discussion", n],
          ["repo", repo, "discussion-list"],
        ],
      };
      return void Promise.all(
        keysByKind[args.kind](args.number).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  });
}

export function useCreatePr(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      base: string;
      head: string;
      title: string;
      body: string;
      draft: boolean;
      /** Create-time reviewer account uuids (Bitbucket-only; omit elsewhere). */
      reviewers?: string[];
      /** Create-time label names (GitHub/GitLab; omit for Bitbucket). */
      labels?: string[];
      /** Create-time assignee login/username strings (GitHub/GitLab; omit for Bitbucket). */
      assignees?: string[];
      /** Which repo the PR opens against: the fork itself ("origin", default) or
       *  its parent ("upstream" — GitHub fork only; the backend composes
       *  `owner:head` and rejects reviewers/labels/assignees on that path). */
      lens?: RemoteLens;
    }) =>
      api.forgePrCreate(
        repo,
        args.base,
        args.head,
        args.title,
        args.body,
        args.draft,
        args.reviewers,
        args.labels,
        args.assignees,
        args.lens ?? "origin",
      ),
  );
}
