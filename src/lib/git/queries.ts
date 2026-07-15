import {
  type QueryKey,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { COLD_START_NO_GH, COLD_START_NO_GIT } from "@/lib/test-mode";
import * as api from "./api";
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
  PrThreadOut,
  Reaction,
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
  pruneWorktrees,
  removeWorktree,
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
 * `keepPreviousData`, scoped to a single repo. Panels stay mounted across repo
 * switches, so a plain `keepPreviousData` `placeholderData` would keep the PREVIOUS
 * repo's rows on screen while the new repo's query loads — a visible flash of the
 * wrong repo's PRs/issues/etc. (and, for number-keyed maps, briefly-wrong data).
 * This keeps the previous data only when the previous query was for the SAME repo
 * (so Load-more page growth and Open/Closed tab switches still avoid a skeleton),
 * and drops to fresh skeletons the moment the key's repo segment changes.
 *
 * Pass the current `repo` and the index of the repo segment in the query key (all
 * `repoKeys.*` and the `["repo", repo, …]` literals here put it at index 1).
 */
function keepPreviousDataForRepo(repo: string, repoKeyIndex = 1) {
  return <T>(
    previousData: T | undefined,
    previousQuery: { queryKey: QueryKey } | undefined,
  ): T | undefined =>
    previousQuery?.queryKey?.[repoKeyIndex] === repo ? previousData : undefined;
}

export const repoKeys = {
  all: (repo: string) => ["repo", repo] as const,
  status: (repo: string) => ["repo", repo, "status"] as const,
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
 * The working-tree query keys a staging-class mutation actually touches: repo
 * status, every working-tree file diff, and the worktree side of file-at-rev
 * reads (the image-diff "new" pane) — all prefix-matched. Hot mutations
 * (stage/unstage/discard/apply) pass this to {@link useRepoMutation} so they
 * don't needlessly mark the heavy history/branches/Insights/SBOM queries stale.
 * Of the file-at-rev reads (image diffs + the diff viewer's whole-file highlight
 * context), only the mutable sides are invalidated: the `"worktree"` slice and
 * the index (`":0"`) slice, which staging rewrites. Committed-rev reads (HEAD,
 * commit SHAs) are immutable here and deliberately left alone.
 */
const workingTreeKeys = (repo: string) =>
  [
    repoKeys.status(repo),
    ["repo", repo, "diff"],
    ["repo", repo, "file-b64", "worktree"],
    ["repo", repo, "file-b64", ":0"],
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

/** Count of commits on HEAD not on any remote — the "unpublished" count for a
 *  branch with no upstream, where `branch.ahead` is undefined (a never-pushed
 *  branch's commits below the fork point already live on `origin/<base>`, so the
 *  whole branch isn't unpushed). `enabled` fires it only in that case. Keyed
 *  under the repo so a commit / push / fetch invalidation refetches it. */
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

const worktreeKey = (repo: string) => ["repo", repo, "user-worktrees"] as const;

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

/** Removes a user worktree (keeping its branch), then prunes any stale admin
 *  entry. `force` drops a worktree with uncommitted changes. */
export function useRemoveUserWorktree(repo: string) {
  return useRepoMutation(
    repo,
    async (args: { path: string; force: boolean }) => {
      // Pass branch=null: removing a worktree leaves the branch intact (deleting
      // a user's branch is a separate, more destructive action).
      await removeWorktree(repo, args.path, null, args.force);
      // Best-effort cleanup; a clean remove already drops its own admin entry.
      await pruneWorktrees(repo).catch(() => undefined);
    },
    { invalidate: [worktreeKey(repo), repoKeys.branches(repo)] },
  );
}

/** Owners (from each repo's origin remote) for grouping the repo list. */
export function useRepoOwners(paths: string[]) {
  const sorted = [...paths].sort();
  return useQuery({
    queryKey: ["repo-owners", sorted] as const,
    queryFn: () => api.gitRepoOwners(sorted),
    enabled: sorted.length > 0,
    staleTime: 10 * 60 * 1000,
    // Survive the switcher popover closing so the owners stay warm across opens
    // (the stored owner on each RecentRepo is the primary anti-reflow path; this
    // just avoids re-running the owner scan and keeps refreshes instant).
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
 * A single file's cumulative diff in an agent session worktree vs the session's
 * base commit — for the inline edit-step diff in the transcript. `base` is in the
 * key so a different base (e.g. after a restart) doesn't cache-hit. Idle until
 * `enabled` (the step is expanded), so an unopened edit step costs nothing. While
 * `live` (the session is still working), it polls: the agent edits the worktree
 * through its own CLI, outside any app mutation that could invalidate this, so an
 * open diff would otherwise freeze as the agent keeps editing the same file. A
 * settled session needs no poll — the last fetch is the final diff.
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

export function useCommitFileDiff(
  repo: string,
  hash: string | null,
  file: string | null,
) {
  return useQuery({
    ...commitFileDiffOptions(repo, hash ?? "", file ?? ""),
    enabled: hash !== null && file !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

/**
 * Warms a commit's detail view (header + file list + the first file's diff) so
 * selecting it is instant. Called on row hover and for the rows adjacent to the
 * current selection (so keyboard arrowing stays ahead). prefetchQuery is a
 * no-op once the data is cached, so repeats are free.
 */
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

/**
 * Debounces hover-triggered prefetches so sweeping the pointer down a long list
 * doesn't spawn a prefetch (and its git subprocesses) for every row it crosses
 * — only the row the pointer settles on fires. Keyboard-neighbor prefetch stays
 * immediate. Returns a trigger you hand the prefetch thunk to.
 */
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

export function useCommitAuthors(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "commit-authors"] as const,
    queryFn: () => api.gitCommitAuthors(repo),
    staleTime: 60_000,
  });
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

export function useBranchFileDiff(
  repo: string,
  base: string | null,
  compare: string | null,
  file: string | null,
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
      base !== null && compare !== null && base !== compare && file !== null,
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
) {
  return useQuery({
    queryKey: ["repo", repo, "prs", head ?? ""] as const,
    queryFn: () => api.forgePrsForBranch(repo, head ?? ""),
    enabled: enabled && head !== null,
    staleTime: 30_000,
  });
}

export function usePrList(
  repo: string,
  enabled: boolean,
  state: api.PrStateFilter,
  limit?: number,
) {
  return useQuery({
    queryKey: ["repo", repo, "pr-list", state, limit ?? null] as const,
    queryFn: () => api.forgePrList(repo, state, limit),
    enabled,
    staleTime: 30_000,
    // Growing the limit ("Load more") keeps the current rows visible instead of
    // flashing skeletons while the larger page loads.
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

/** Hydrates the PR-list rows with each PR's CI rollup, keyed by number. Runs
 *  SEPARATELY from `usePrList` so the list paints immediately and the row icons
 *  appear a moment later — a full rollup expansion in the list query 504s on large
 *  GitHub repos. Provider-neutral: the backend routes to GitHub/GitLab/Bitbucket, so
 *  `enabled` only needs the list to be ready (`ghReady`); it self-disables when `prs`
 *  is empty. The numbers digest in the key is load-bearing: the list uses
 *  keepPreviousData, so on a tab switch this hook can fire against the PREVIOUS
 *  tab's placeholder rows — keyed by state+limit alone that result would cache
 *  under the new tab's key and the real rows would never get statuses. */
export function usePrListCi(
  repo: string,
  enabled: boolean,
  state: api.PrStateFilter,
  limit: number | undefined,
  prs: PrInfo[] | undefined,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "pr-ci",
      state,
      limit ?? null,
      prs?.map((p) => p.number).join(",") ?? "",
    ] as const,
    queryFn: async () => {
      // `enabled` guarantees a non-empty list here; `prs![0]` is safe.
      const list = prs as PrInfo[];
      const rows = await api.forgePrListCi(
        repo,
        list.map((p) => ({ number: p.number, headSha: p.headSha })),
        list[0].url,
      );
      return new Map<number, CiStatus>(rows.map((r) => [r.number, r.ciStatus]));
    },
    enabled: enabled && !!prs && prs.length > 0,
    staleTime: 30_000,
    // Keep the current icons while a "Load more" grows the list, matching usePrList.
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function useRepoLabels(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "labels"] as const,
    queryFn: () => api.forgeRepoLabels(repo),
    enabled,
    staleTime: 5 * 60_000,
  });
}

// Shared definitions so the hook and the prefetch path stay in sync. A short
// stale window makes a hover-prefetched PR open with no extra round-trip; the
// window-focus refetch still keeps an open PR current.
const prDetailsOptions = (repo: string, number: number) =>
  queryOptions({
    queryKey: ["repo", repo, "pr", number] as const,
    queryFn: () => api.forgePrView(repo, number),
    staleTime: 30_000,
  });

export const prDiffOptions = (repo: string, number: number) =>
  queryOptions({
    queryKey: ["repo", repo, "pr", number, "diff"] as const,
    queryFn: () => api.forgePrDiff(repo, number),
    staleTime: 30_000,
  });

export function usePrDetails(repo: string, number: number | null) {
  return useQuery({
    ...prDetailsOptions(repo, number ?? 0),
    enabled: number !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

export function usePrDiff(repo: string, number: number | null) {
  return useQuery({
    ...prDiffOptions(repo, number ?? 0),
    enabled: number !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

// File:line-anchored review threads (Copilot/CodeRabbit/human line comments); the
// data serves both the Conversation grouping and the Files diff anchors, so it
// lives at the PR top level.
export const prReviewThreadsKey = (repo: string, number: number) =>
  ["repo", repo, "pr", number, "review-threads"] as const;

export function usePrReviewThreads(repo: string, number: number | null) {
  return useQuery({
    queryKey: prReviewThreadsKey(repo, number ?? 0),
    queryFn: () => api.forgePrReviewThreads(repo, number ?? 0),
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
 * Applies a review suggestion to the working tree (GitHub's "Commit suggestion",
 * done locally). It's a staging-class edit — only the working tree changes — so it
 * narrows invalidation to {@link workingTreeKeys} (status + working-tree file
 * diffs + the mutable file-at-rev slices), exactly like {@link useStage}. That
 * refreshes the Changes tab/status/diffs WITHOUT prefix-matching the review-threads
 * query key (which the whole-repo default would, forcing a needless GitHub GraphQL
 * refetch even though no thread changed). The backend verifies the expected lines
 * before editing; a mismatch throws.
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

/** The unified diff for one commit of a PR/MR — the per-commit review view. Pass
 *  `oid: null` (no commit selected) so the read doesn't fire; keyed by oid so each
 *  commit's diff caches independently, with the same short stale window as the
 *  other PR-detail queries. */
export function usePrCommitDiff(
  repo: string,
  number: number,
  oid: string | null,
) {
  return useQuery({
    queryKey: ["repo", repo, "pr", number, "commit-diff", oid] as const,
    queryFn: () => api.forgePrCommitDiff(repo, number, oid ?? ""),
    enabled: oid !== null,
    staleTime: 30_000,
  });
}

/** Comments on a commit (GitHub commit comments / GitLab commit notes). Pass
 *  `sha: null` when no commit is selected so the read doesn't fire. */
export function useCommitComments(repo: string, sha: string | null) {
  return useQuery({
    queryKey: ["repo", repo, "commit", sha, "comments"] as const,
    queryFn: () => api.forgeCommitComments(repo, sha ?? ""),
    enabled: sha !== null,
    staleTime: 30_000,
  });
}

/** Whether a commit lives on any remote — gates the History-tab commit-comment
 *  surface (you can only comment on a commit the forge already has). A push can
 *  flip it from false to true, hence the short stale window; pass `sha: null` when
 *  no commit is selected so the read doesn't fire. */
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

const commitCommentsKey = (repo: string, sha: string) =>
  ["repo", repo, "commit", sha, "comments"] as const;

/**
 * The shared skeleton behind every optimistic-cache mutation in this file:
 * cancel in-flight fetches on the target key, snapshot it, apply an optimistic
 * `setQueryData` patch, roll the snapshot back on error, and reconcile on
 * settle. The five exported factories below (`useOptimisticCommitCommentMutation`,
 * `useOptimisticIssueMutation`, `useOptimisticCreateCommentMutation`,
 * `useOptimisticCommentMutation`, `useOptimisticReviewCommentMutation`) are thin
 * wrappers over this — they only differ in the *deltas*:
 *
 * - `keyFor(args)` — the cache key to patch (derived from the mutation args at
 *   mutate time, so a mid-flight repo/number/sha switch never corrupts another
 *   key's cache).
 * - `patch(prev, args)` — the optimistic `setQueryData` updater.
 * - `reconcile(queryClient, args)` — the onSettled invalidation. Four factories
 *   pass a repo-wide invalidate (server-truth reconciliation, matching what
 *   `useRepoMutation`'s default did before they were made optimistic); the issue
 *   factory passes a narrow single-issue invalidate.
 *
 * `TCache` is the shape stored at the key (a list, a detail object, …); the
 * rollback context carries the exact key + prior value so onError restores
 * precisely what onMutate captured.
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
      // The explicit guard is deliberate: in TanStack Query v5,
      // setQueryData(key, undefined) BAILS without updating (it does not
      // remove the entry), so an unguarded call would be a silent no-op, not
      // a rollback. A future "create from nothing" patch (prev === undefined,
      // patch returns data) would need removeQueries here instead — but
      // onSettled's reconcile invalidates immediately after, so there is no
      // observable window today.
      if (ctx?.prev !== undefined) queryClient.setQueryData(ctx.key, ctx.prev);
    },
    onSettled: (_d: TData | undefined, _e: unknown, args: TArgs) =>
      reconcile(queryClient, args),
  });
}

/**
 * Optimistically append a synthetic commit comment to the commit-comments cache,
 * with exact-key rollback — mirroring {@link useOptimisticCreateCommentMutation}
 * for the flat commit-comment list. The synthetic row carries a collision-proof
 * `optimistic:<n>` id and `viewerDidAuthor: false` (so it offers no edit/delete
 * until the reconciliation refetch replaces it with the real comment). `author` is
 * the viewer's forge login when cheaply cached, else "You". The key is derived
 * from `sha` at mutate time so a mid-flight commit switch never corrupts another
 * key's cache; onSettled keeps the repo-wide invalidation as server-truth
 * reconciliation.
 */
export function useCreateCommitComment(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      sha: string;
      body: string;
      path?: string;
      line?: number;
      startLine?: number;
      position?: number;
    }) => api.forgeCommitCommentCreate(repo, args),
    onMutate: async (args: {
      sha: string;
      body: string;
      path?: string;
      line?: number;
      startLine?: number;
      position?: number;
    }) => {
      const key = commitCommentsKey(repo, args.sha);
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

/**
 * Optimistically patch the commit-comments cache (edit replaces one comment's
 * body; delete removes it) with exact-key rollback — the commit-comment analogue
 * of {@link useOptimisticCommentMutation}. The key is derived from `sha` at mutate
 * time so a mid-flight commit switch never corrupts another key's cache; onSettled
 * keeps the repo-wide invalidation as server-truth reconciliation.
 */
function useOptimisticCommitCommentMutation<TData>(
  repo: string,
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
    (args) => commitCommentsKey(repo, args.sha),
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

export function useEditCommitComment(repo: string) {
  return useOptimisticCommitCommentMutation(
    repo,
    (args: { sha: string; commentId: string; body?: string }) =>
      api.forgeCommitCommentEdit(repo, {
        sha: args.sha,
        commentId: args.commentId,
        body: args.body ?? "",
      }),
    (comment, args) => ({ ...comment, body: args.body ?? comment.body }),
  );
}

export function useDeleteCommitComment(repo: string) {
  return useOptimisticCommitCommentMutation(
    repo,
    (args: { sha: string; commentId: string }) =>
      api.forgeCommitCommentDelete(repo, {
        sha: args.sha,
        commentId: args.commentId,
      }),
    () => null,
  );
}

/**
 * Create a new file:line-anchored review thread, optimistically appending a
 * synthetic single-comment {@link ReviewThreadOut} to the review-threads cache
 * with exact-key rollback — so the thread card shows instantly instead of waiting
 * on the write + refetch. The synthetic thread carries a collision-proof
 * `optimistic:<n>` comment id and `viewerDidAuthor: false` (no edit/delete until
 * the reconciliation refetch replaces it); onSettled keeps the repo-wide
 * invalidation as server-truth reconciliation.
 */
export function useCreateReviewThread(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      number: number;
      path: string;
      line: number;
      side: "new" | "old";
      startLine?: number;
      body: string;
    }) => api.forgePrThreadCreate(repo, args),
    onMutate: async (args: {
      number: number;
      path: string;
      line: number;
      side: "new" | "old";
      startLine?: number;
      body: string;
    }) => {
      const key = prReviewThreadsKey(repo, args.number);
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
export function useSubmitReview(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      number: number;
      verdict: api.ReviewVerdict;
      summary?: string;
      comments: DraftCommentIn[];
    }) => api.forgePrReviewSubmit(repo, args),
  );
}

export function useThreadReply(repo: string, number: number) {
  return useRepoMutation(
    repo,
    (args: { threadId: string; body: string }) =>
      api.forgePrThreadReply(repo, number, args.threadId, args.body),
    { invalidate: [prReviewThreadsKey(repo, number)] },
  );
}

export function useThreadResolve(repo: string, number: number) {
  return useRepoMutation(
    repo,
    (args: { threadId: string; resolved: boolean }) =>
      api.forgePrThreadResolve(repo, number, args.threadId, args.resolved),
    { invalidate: [prReviewThreadsKey(repo, number)] },
  );
}

/**
 * Warms a remote PR's view (metadata + diff) so opening it is instant. PR data
 * comes over the network (the slowest loads in the app), so prefetching on row
 * hover and for the adjacent rows pays off most here.
 */
export function usePrefetchPr(repo: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (number: number) => {
      queryClient.prefetchQuery(prDetailsOptions(repo, number));
      queryClient.prefetchQuery(prDiffOptions(repo, number));
    },
    [queryClient, repo],
  );
}

/** Reactions for a PR's body + comments — decoupled from the PR view so it
 *  loads in parallel and leaves the (untouched) PR query alone. */
export function usePrReactions(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "pr", number ?? 0, "reactions"] as const,
    queryFn: () => api.forgePrReactions(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

/** A PR's activity timeline (force-pushes, label changes, review requests, state
 *  changes, approvals) for the Conversation tab. Provider-neutral (the backend
 *  dispatches per provider), so the caller passes
 *  `enabled = section === "conversation" && <a known remote provider>`; a hidden
 *  tab must NOT fetch. Decoupled from the PR view like {@link usePrReactions}. */
export function usePrTimeline(
  repoPath: string,
  number: number,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repoPath, "pr", number, "timeline"] as const,
    queryFn: () => api.forgePrTimeline(repoPath, number),
    enabled,
    staleTime: 30_000,
  });
}

export function useIssueList(
  repo: string,
  enabled: boolean,
  state: api.IssueStateFilter,
  limit?: number,
) {
  return useQuery({
    queryKey: ["repo", repo, "issue-list", state, limit ?? null] as const,
    queryFn: () => api.forgeIssueList(repo, state, limit),
    enabled,
    staleTime: 30_000,
    // Keep current rows visible while a grown "Load more" page loads.
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

const issueDetailsOptions = (repo: string, number: number) =>
  queryOptions({
    queryKey: ["repo", repo, "issue", number] as const,
    queryFn: () => api.forgeIssueView(repo, number),
    staleTime: 30_000,
  });

export function useIssueDetails(repo: string, number: number | null) {
  return useQuery({
    ...issueDetailsOptions(repo, number ?? 0),
    enabled: number !== null,
    placeholderData: keepPreviousDataForRepo(repo),
  });
}

/** Warms an issue's view so opening it from the list is instant (hover/adjacent
 *  rows), mirroring {@link usePrefetchPr}. */
export function usePrefetchIssue(repo: string) {
  const queryClient = useQueryClient();
  return useCallback(
    (number: number) => {
      queryClient.prefetchQuery(issueDetailsOptions(repo, number));
    },
    [queryClient, repo],
  );
}

export function useCreateIssue(repo: string) {
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
      ),
  );
}

export function useAssignableUsers(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "assignable-users"] as const,
    queryFn: () => api.forgeAssignableUsers(repo),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useMilestones(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "milestones"] as const,
    queryFn: () => api.forgeMilestones(repo),
    enabled,
    staleTime: 5 * 60_000,
  });
}

/**
 * An issue meta mutation (assignee/milestone/type) with an optimistic patch of
 * the issue-details cache + rollback, so the sidebar updates instantly instead
 * of waiting on the PATCH + refetch. `patch` applies the new value locally; the
 * extra display fields callers pass (milestone title, the full type) are only
 * for this patch — the backend takes just the id/name.
 */
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

function useOptimisticIssueMutation<TArgs extends { number: number }, TData>(
  repo: string,
  mutationFn: (args: TArgs) => Promise<TData>,
  patch: (issue: IssueDetails, args: TArgs) => IssueDetails,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onMutate: async (args: TArgs) => {
      const key = ["repo", repo, "issue", args.number] as const;
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
    onError: (_e, _args, ctx) => {
      if (!ctx?.restore) return;
      queryClient.setQueryData<IssueDetails>(ctx.key, (cur) =>
        cur ? { ...cur, ...ctx.restore } : cur,
      );
    },
    // Narrow reconciliation: only the one issue's detail subtree (not repo-wide).
    onSettled: (_d, _e, args) =>
      void queryClient.invalidateQueries({
        queryKey: ["repo", repo, "issue", args.number],
      }),
  });
}

export function useSetIssueAssignees(repo: string) {
  return useOptimisticIssueMutation(
    repo,
    (args: { number: number; assignees: ForgeUserRef[] }) =>
      api.forgeIssueSetAssignees(
        repo,
        args.number,
        args.assignees.map((a) => a.id),
      ),
    (issue, args) => ({ ...issue, assignees: args.assignees }),
  );
}

export function useSetIssueMilestone(repo: string) {
  return useOptimisticIssueMutation(
    repo,
    (args: {
      number: number;
      milestone: number | null;
      /** Title for the optimistic chip (backend takes only the number). */
      title?: string | null;
    }) => api.forgeIssueSetMilestone(repo, args.number, args.milestone),
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
 *  cache patch every other issue-field mutation uses. */
export function useSetIssueConfidential(repo: string) {
  return useOptimisticIssueMutation(
    repo,
    (args: { number: number; confidential: boolean }) =>
      api.forgeGlIssueSetConfidential(repo, args.number, args.confidential),
    (issue, args) => ({ ...issue, confidential: args.confidential }),
  );
}

/** Set ("YYYY-MM-DD") or clear (null) an issue's GitLab-only due date. */
export function useSetIssueDueDate(repo: string) {
  return useOptimisticIssueMutation(
    repo,
    (args: { number: number; dueDate: string | null }) =>
      api.forgeGlIssueSetDueDate(repo, args.number, args.dueDate),
    (issue, args) => ({ ...issue, dueDate: args.dueDate }),
  );
}

// ── GitLab time tracking + related issues ────────────────────────────────────

const issueTimeStatsKey = (repo: string, number: number) =>
  ["repo", repo, "issue", number, "time-stats"] as const;
const mrTimeStatsKey = (repo: string, number: number) =>
  ["repo", repo, "pr", number, "time-stats"] as const;

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

/**
 * A time-tracking write (set-estimate / add-spent) whose response IS the fresh
 * {@link GitLabTimeStats}: on success we write it straight into the matching
 * time-stats query key (no refetch needed), then invalidate the issue/MR view
 * (the time estimate can surface elsewhere). `statsKey` picks the issue vs MR
 * cache; `viewKey` is the details query to nudge.
 */
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

const issueViewKey = (repo: string, number: number) =>
  ["repo", repo, "issue", number] as const;
const mrViewKey = (repo: string, number: number) =>
  ["repo", repo, "pr", number] as const;

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

const issueLinksKey = (repo: string, number: number) =>
  ["repo", repo, "issue", number, "links"] as const;

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
    onSuccess: (_d, args) =>
      queryClient.invalidateQueries({
        queryKey: issueLinksKey(repo, args.number),
      }),
  });
}

export function useIssueTypes(repo: string, enabled: boolean) {
  return useQuery({
    queryKey: ["repo", repo, "issue-types"] as const,
    queryFn: () => api.ghIssueTypes(repo),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useSetIssueType(repo: string) {
  return useOptimisticIssueMutation(
    repo,
    (args: {
      number: number;
      typeName: string | null;
      /** The full type for the optimistic patch (backend takes only the name). */
      type?: IssueType | null;
    }) => api.ghIssueSetType(repo, args.number, args.typeName),
    (issue, args) => ({ ...issue, issueType: args.type ?? null }),
  );
}

/**
 * An issue-lifecycle write (close/reopen/edit/pin/lock/unlock/transfer/delete)
 * that reconciles NARROWLY on settle instead of the whole-repo default: the one
 * issue's detail subtree (`["repo", repo, "issue", n]`, prefix-matched so its
 * reactions/relations/dependencies/development sub-queries refresh too) + every
 * issue-list state variant (`["repo", repo, "issue-list"]` — the list row shows
 * state/title/labels/assignees/pinned/locked, and transfer/delete change list
 * membership). `numberOf` extracts the issue number from the mutation args (the
 * arg shapes differ — a bare `number` vs `{ number, … }`). No optimistic patch:
 * these change fields the details view re-reads wholesale, so a scoped refetch is
 * the reconciliation.
 */
function useIssueLifecycleMutation<TArgs, TData>(
  repo: string,
  mutationFn: (args: TArgs) => Promise<TData>,
  numberOf: (args: TArgs) => number,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: (_d, _e, args) =>
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["repo", repo, "issue-list"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["repo", repo, "issue", numberOf(args)],
        }),
      ]),
  });
}

export function usePinIssue(repo: string) {
  return useIssueLifecycleMutation(
    repo,
    (args: { number: number; pinned: boolean }) =>
      args.pinned
        ? api.ghIssuePin(repo, args.number)
        : api.ghIssueUnpin(repo, args.number),
    (args) => args.number,
  );
}

export function useLockIssue(repo: string) {
  return useIssueLifecycleMutation(
    repo,
    (args: { number: number; reason: api.LockReason | null }) =>
      api.forgeIssueLock(repo, args.number, args.reason),
    (args) => args.number,
  );
}

export function useUnlockIssue(repo: string) {
  return useIssueLifecycleMutation(
    repo,
    (number: number) => api.forgeIssueUnlock(repo, number),
    (number) => number,
  );
}

export function useIssueReactions(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "issue", number ?? 0, "reactions"] as const,
    queryFn: () => api.forgeIssueReactions(repo, number ?? 0),
    enabled: number !== null,
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
 * Toggles the viewer's reaction with an optimistic cache update + rollback, so
 * the chip responds instantly instead of waiting on a refetch. `reactionsKey`
 * is the reactions query; `bodyId` is the issue/PR/discussion body's id
 * (anything else is a comment id). `opts` carries the GitLab-side subject
 * (containing issue/MR — GitHub keys purely on node ids and ignores it);
 * discussions are GitHub-only, so the default rides the GitHub arm untouched.
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

export function useCommentIssue(repo: string) {
  return useOptimisticCreateCommentMutation(repo, "issue", (args) =>
    api.forgeIssueComment(repo, args.number, args.body),
  );
}

export function useCloseIssue(repo: string) {
  return useIssueLifecycleMutation(
    repo,
    (args: { number: number; reason: string }) =>
      api.forgeIssueClose(repo, args.number, args.reason),
    (args) => args.number,
  );
}

export function useReopenIssue(repo: string) {
  return useIssueLifecycleMutation(
    repo,
    (number: number) => api.forgeIssueReopen(repo, number),
    (number) => number,
  );
}

export function useEditIssue(repo: string) {
  return useIssueLifecycleMutation(
    repo,
    (args: { number: number; title: string; body: string }) =>
      api.forgeIssueEdit(repo, args.number, args.title, args.body),
    (args) => args.number,
  );
}

export function useTransferIssue(repo: string) {
  return useIssueLifecycleMutation(
    repo,
    (args: { number: number; destination: string }) =>
      api.forgeIssueTransfer(repo, args.number, args.destination),
    (args) => args.number,
  );
}

export function useDeleteIssue(repo: string) {
  return useIssueLifecycleMutation(
    repo,
    (number: number) => api.forgeIssueDelete(repo, number),
    (number) => number,
  );
}

/** An issue's parent + sub-issues, loaded alongside the conversation. */
export function useIssueRelations(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "issue", number ?? 0, "relations"] as const,
    queryFn: () => api.ghIssueRelations(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

export function useAddSubIssue(repo: string) {
  return useRepoMutation(
    repo,
    (args: { parentId: string; subNumber: number }) =>
      api.ghIssueAddSubIssue(repo, args.parentId, args.subNumber),
  );
}

/** An issue's blocked-by / blocking dependencies. */
export function useIssueDependencies(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "issue", number ?? 0, "dependencies"] as const,
    queryFn: () => api.ghIssueDependencies(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

/** An issue's "Development" links: closing PRs + linked branches. */
export function useIssueDevelopment(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "issue", number ?? 0, "development"] as const,
    queryFn: () => api.ghIssueDevelopment(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
  });
}

export function useCreateLinkedBranch(repo: string) {
  return useRepoMutation(repo, (args: { issueId: string; name: string }) =>
    api.ghIssueCreateLinkedBranch(repo, args.issueId, args.name),
  );
}

export function useSetIssueDependency(repo: string) {
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
      ),
    // Cross-issue: a dependency touches BOTH the source's and the target's detail
    // subtrees (their `dependencies` sub-query is keyed by number) — no list-
    // membership change, so scope to the two issues' details rather than repo-wide.
    onSettled: (_d, _e, args) =>
      void Promise.all(
        [args.number, args.target].map((n) =>
          queryClient.invalidateQueries({
            queryKey: ["repo", repo, "issue", n],
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
    // The active account changes what every gh query returns.
    // Deliberately app-wide (no key filter): the collateral refetch of non-gh
    // caches is accepted because account switches are rare, and correctness of
    // every gh-derived answer wins over the narrow-invalidation policy elsewhere.
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
  },
  implemented: {
    pullRequests: false,
    issues: false,
    ci: false,
    releases: false,
    insights: false,
    repoActions: false,
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
  },
};

/**
 * Provider-neutral hosted-integration status — the gate every hosted panel reads.
 * GitHub delegates to the gh-backed probe; GitLab and Bitbucket join as their
 * impls land.
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

/** Whether a repo's hosted integration is ready — its tooling is installed, signed
 *  in, and pointing at a recognized hosted repo. The provider-neutral gate hosted
 *  panels check before fetching or offering hosted actions, replacing the inline
 *  `gh.data?.installed && …` duplication. */
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

/** Whether a specific hosted *feature* is usable for this repo: the integration is
 *  ready (installed/signed-in/recognized) **and** GitDesktop has actually built
 *  that feature for this provider. The gate every feature panel checks before
 *  firing its data calls. GitHub implements everything, so this is exactly
 *  `forgeReady` there; for a *ready* GitLab/Bitbucket repo it stays false for the
 *  panels not yet wired up, so they show "coming soon" instead of breaking. */
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

/** The signed-in user's repositories on a provider (GitHub via gh, GitLab via
 *  glab), for the clone browser. The provider-neutral successor to
 *  {@link useGhRepos} on that surface. */
export function useForgeRepos(provider: ForgeProvider, enabled: boolean) {
  return useQuery({
    queryKey: ["forge-repos", provider] as const,
    queryFn: () => api.forgeListRepos(provider),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Builds a mutation that invalidates repo queries when it completes. By default
 * it invalidates the entire repo subtree (correct but broad) in `onSettled`;
 * pass `opts.invalidate` to narrow it for hot mutations (each key is
 * prefix-matched). Reserve the whole-subtree default for ops that touch history
 * or branch topology (checkout/pull/reset/merge). Pass `opts.refetchBeforeSuccess`
 * for commit, where the refetch must land before the caller's onSuccess.
 */
function useRepoMutation<TArgs, TData>(
  repo: string,
  mutationFn: (args: TArgs) => Promise<TData>,
  opts: {
    /** Query keys to invalidate on completion (prefix-matched). Defaults to the
     *  whole repo subtree. */
    invalidate?: readonly (readonly unknown[])[];
    /** Invalidate (and AWAIT) in onSuccess instead of fire-and-forget in
     *  onSettled, so the refetch lands BEFORE the caller's own onSuccess —
     *  commit uses this so the emptied list, cleared draft, and toast appear
     *  together. (As a result it does NOT invalidate on error.) */
    refetchBeforeSuccess?: boolean;
  } = {},
) {
  const queryClient = useQueryClient();
  const invalidate = () =>
    Promise.all(
      (opts.invalidate ?? [repoKeys.all(repo)]).map((queryKey) =>
        queryClient.invalidateQueries({ queryKey }),
      ),
    );
  return useMutation({
    mutationFn,
    ...(opts.refetchBeforeSuccess
      ? { onSuccess: () => invalidate() }
      : { onSettled: () => void invalidate() }),
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
  });
}

export function useSetRemoteUrl(repo: string) {
  return useRepoMutation(repo, (args: { name: string; url: string }) =>
    api.gitRemoteSetUrl(repo, args.name, args.url),
  );
}

export function useOpState(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "op-state"] as const,
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
  // refetchBeforeSuccess so the emptied changes list, cleared draft, and success
  // toast land together instead of the toast firing while the list still shows
  // old entries (react-query awaits the onSuccess refetch before the caller's).
  return useRepoMutation(
    repo,
    (args: { title: string; body?: string; amend?: boolean }) =>
      api.gitCommit(repo, args.title, args.body, args.amend ?? false),
    { refetchBeforeSuccess: true },
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
    (args: { name: string; checkout: boolean; startPoint?: string }) =>
      api.gitCreateBranch(repo, args.name, args.checkout, args.startPoint),
  );
}

export function useDiscard(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; untracked: boolean }) =>
      api.gitDiscard(repo, args.path, args.untracked),
    { invalidate: workingTreeKeys(repo) },
  );
}

export function useAppendToGitignore(repo: string) {
  return useRepoMutation(repo, (patterns: string[]) =>
    api.appendToGitignore(repo, patterns),
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
      latest: boolean;
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

/** Outcome of an "Update from upstream" run, for an honest toast. `branch` is
 *  the upstream default branch name (no `upstream/` prefix). */
export type UpstreamUpdateOutcome =
  | { kind: "up-to-date"; branch: string }
  | { kind: "fast-forwarded"; branch: string }
  | { kind: "merged"; branch: string };

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
    await api.gitMerge(repo, ref, false, false, "none");
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
    (args: { setUpstream: boolean; force?: boolean }) =>
      api.gitPush(repo, args.setUpstream, args.force ?? false),
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
  return useRepoMutation(repo, (args: { oldName: string; newName: string }) =>
    api.gitRenameBranch(repo, args.oldName, args.newName),
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
    // fsck is slow: don't re-scan on every toggle back to the Recoverable view
    // within a session (the Rescan button forces a fresh scan), and keep the
    // list on screen during a refetch instead of blanking to the spinner.
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
 *  drops). Default invalidation refetches the whole repo subtree, so the status
 *  and stash lists reflect the applied change. */
export function useRestoreOrphaned(repo: string) {
  return useRepoMutation(repo, (sha: string) =>
    api.gitRestoreOrphaned(repo, sha),
  );
}

/**
 * Reconcile-on-read: renders the interrupted-op recovery banner. Lives under
 * the repo subtree, so a ConflictBanner Continue/Abort (a repo mutation) re-runs
 * it and clears the banner once the op is resolved.
 */
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

/**
 * Ahead/behind of every local branch vs. `base`. Gated on `enabled` so it only
 * runs while the branch menu is open (it's N rev-list calls), and keyed under
 * the repo so branch mutations invalidate it.
 */
export function useBranchDivergence(
  repo: string,
  base: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: ["repo", repo, "divergence", base] as const,
    queryFn: () => api.gitBranchDivergence(repo, base ?? ""),
    enabled: enabled && Boolean(base),
  });
}

export function useUpdateBranchFrom(repo: string) {
  return useRepoMutation(repo, (args: { branch: string; base: string }) =>
    api.gitUpdateBranchFrom(repo, args.branch, args.base),
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

export function useReviewPr(repo: string) {
  return useRepoMutation(
    repo,
    (args: { number: number; action: api.ReviewAction; body: string }) =>
      api.ghPrReview(repo, args.number, args.action, args.body),
  );
}

export function useCommentPr(repo: string) {
  return useOptimisticCreateCommentMutation(repo, "pr", (args) =>
    api.forgePrComment(repo, args.number, args.body, args.asBot),
  );
}

/** A merge request's approval state — the GitLab-only approve/unapprove toggle's
 *  driver. Pass `null` when the toggle isn't shown (GitHub, or a closed MR) so the
 *  read doesn't fire. */
export function usePrApprovals(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "pr", number ?? 0, "approvals"] as const,
    queryFn: () => api.forgePrApprovals(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
    retry: false,
  });
}

export function useApprovePr(repo: string) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrApprove(repo, number),
  );
}

/** A PR's task checklist (Bitbucket-only, gated on `implemented.prTasks`). Pass
 *  `null` when the panel isn't shown so the read doesn't fire (mirrors
 *  `usePrApprovals`). */
export function usePrTasks(repo: string, number: number | null) {
  return useQuery({
    queryKey: ["repo", repo, "pr", number, "tasks"] as const,
    queryFn: () => api.forgeBbPrTasks(repo, number ?? 0),
    enabled: number !== null,
    staleTime: 30_000,
    retry: false,
  });
}

// PR-task mutations invalidate the exact tasks key onSettled (keyed on the PR number
// carried in the mutation args); the component patches its own local state
// optimistically (like toggleApproval), so no optimistic logic lives in the hook.
export const prTasksKey = (repo: string, number: number) =>
  ["repo", repo, "pr", number, "tasks"] as const;

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
export function useRequestChangesPr(repo: string) {
  return useRepoMutation(repo, (args: { number: number; body: string }) =>
    api.forgePrRequestChanges(repo, args.number, args.body),
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

/** Toggle a PR's draft state (Bitbucket-only — both directions, unlike GitHub's
 *  one-way `gh pr ready`). Invalidation via useRepoMutation refreshes the badge
 *  and the merge gate. */
export function useSetPrDraft(repo: string) {
  return useRepoMutation(repo, (args: { number: number; draft: boolean }) =>
    api.forgePrSetDraft(repo, args.number, args.draft),
  );
}

/** The reviewer picker's candidates (Bitbucket: workspace members minus the user the
 *  server would reject). For an existing PR pass its number (excludes the PR author);
 *  at create time pass `null` (no PR yet — excludes the viewer), keyed on "create".
 *  Fetched only while the picker is enabled — the popover is the sole consumer. */
export function useReviewerCandidates(
  repo: string,
  number: number | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [
      "repo",
      repo,
      "pr",
      number ?? "create",
      "reviewer-candidates",
    ] as const,
    queryFn: () => api.forgePrReviewerCandidates(repo, number),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/**
 * Replace an MR's reviewer list (all three providers, gated on
 * `implemented.mrReviewers`) with an optimistic patch of the PR-details cache +
 * rollback, mirroring `useSetPrAssignees` — the picker's chips update instantly
 * instead of waiting on the PUT + refetch. The list is the picker's HUMAN set;
 * bot/team requests never travel through it (preserved provider-side).
 */
export function useSetPrReviewers(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; reviewers: ForgeUserRef[] }) =>
      api.forgePrSetReviewers(
        repo,
        args.number,
        args.reviewers.map((r) => r.id),
      ),
    onMutate: async (args) => {
      const key = ["repo", repo, "pr", args.number] as const;
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
        queryKey: ["repo", repo, "pr", args.number],
      }),
  });
}

/**
 * Set a PR/MR's assignees (GitHub + GitLab, gated on `implemented.mrAssignees`)
 * with an optimistic patch of the PR-details cache + rollback, mirroring
 * `useSetIssueAssignees` — the picker's chips update instantly instead of
 * waiting on the PATCH/PUT + refetch (the CLI spawns a process per call).
 */
export function useSetPrAssignees(repo: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { number: number; assignees: ForgeUserRef[] }) =>
      api.forgeMrSetAssignees(
        repo,
        args.number,
        args.assignees.map((a) => a.id),
      ),
    onMutate: async (args) => {
      const key = ["repo", repo, "pr", args.number] as const;
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
        queryKey: ["repo", repo, "pr", args.number],
      }),
  });
}

export function useMergePr(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      number: number;
      strategy: api.MergeStrategy;
      deleteBranch: boolean;
      /** GitLab stale-view guard (the MR head sha); GitHub ignores it. */
      sha?: string;
    }) =>
      api.forgePrMerge(
        repo,
        args.number,
        args.strategy,
        args.deleteBranch,
        args.sha,
      ),
  );
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

/** A GitLab MR's merge/auto-merge state — drives the auto-merge dropdown items
 *  and the "auto-merge enabled" footer indicator. Pass `null` when auto-merge
 *  isn't shown (GitHub, or a closed MR) so the read doesn't fire.
 *
 *  Polls: the merge fires SERVER-side once the pipeline passes, so the view has
 *  to notice both the pipeline completing (which un-gates / re-gates the arm
 *  affordance) and the auto-merge itself — neither emits a client event. Poll
 *  fast while armed or a pipeline is in flight, slowly otherwise. */
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

export function useClosePr(repo: string) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrClose(repo, number),
  );
}

export function useReopenPr(repo: string) {
  return useRepoMutation(repo, (number: number) =>
    api.forgePrReopen(repo, number),
  );
}

/** Monotonic counter for synthetic optimistic-comment ids — combined with the
 *  `optimistic:` prefix it can never collide with a real provider node id. */
let optimisticCommentSeq = 0;

/**
 * Optimistically append a synthetic conversation comment to a PR/issue detail
 * cache, with exact-key rollback — so a freshly-posted comment shows instantly
 * instead of waiting on the write + repo-wide refetch (a full glab round trip is
 * ~2-4s on GitLab). The synthetic row carries a collision-proof `optimistic:<n>`
 * id and `viewerDidAuthor: false`, so it offers no edit/delete (its temp id would
 * 404 server-side); the reconciliation refetch replaces it with the real comment,
 * whose real controls then appear. `author` is the viewer's login when the caller
 * has it cheaply, else "You". Only the flat `comments` array is touched; inline
 * review threads live in a separate query. The key is derived from the mutation
 * args at mutate time so a mid-flight repo/number switch never corrupts another
 * key's cache. onSettled keeps the repo-wide invalidation as server-truth
 * reconciliation (what useRepoMutation did before).
 */
function useOptimisticCreateCommentMutation<TData>(
  repo: string,
  kind: "pr" | "issue",
  // `asBot` is threaded through for the PR path (posts as the review-bot identity
  // on GitLab; ignored elsewhere). Optional + additive — the issue path and the
  // existing PR callers never pass it, so their behavior is unchanged.
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
    (args) => ["repo", repo, kind, args.number] as const,
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
 * Optimistically patch the flat conversation comments of a PR/issue detail cache
 * (edit replaces one comment's body; delete removes it), with exact-key rollback
 * — so the body swaps / row vanishes instantly instead of waiting on the write +
 * repo-wide refetch (a full glab round trip is ~2-4s on GitLab). Only the flat
 * `comments` array is touched; inline review threads live in a separate query and
 * aren't editable here. `kind` selects the detail subtree ("pr" | "issue"); the
 * key is derived from the mutation args at mutate time so a mid-flight repo/number
 * switch never corrupts another key's cache. onSettled keeps the repo-wide
 * invalidation as server-truth reconciliation (what useRepoMutation did before).
 */
function useOptimisticCommentMutation<
  TArgs extends { number: number; commentId: string },
  TData,
>(
  repo: string,
  kind: "pr" | "issue",
  mutationFn: (args: TArgs) => Promise<TData>,
  patchComment: (comment: PrThreadOut, args: TArgs) => PrThreadOut | null,
) {
  return useOptimisticCacheMutation<TArgs, TData, PrDetails | IssueDetails>(
    mutationFn,
    (args) => ["repo", repo, kind, args.number] as const,
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

export function useEditPrComment(repo: string) {
  return useOptimisticCommentMutation(
    repo,
    "pr",
    (args: { number: number; commentId: string; body: string }) =>
      api.forgePrEditComment(repo, args.number, args.commentId, args.body),
    (comment, args) => ({ ...comment, body: args.body }),
  );
}

export function useDeletePrComment(repo: string) {
  return useOptimisticCommentMutation(
    repo,
    "pr",
    (args: { number: number; commentId: string }) =>
      api.forgePrDeleteComment(repo, args.number, args.commentId),
    () => null,
  );
}

export function useEditIssueComment(repo: string) {
  return useOptimisticCommentMutation(
    repo,
    "issue",
    (args: { number: number; commentId: string; body: string }) =>
      api.forgeIssueEditComment(repo, args.number, args.commentId, args.body),
    (comment, args) => ({ ...comment, body: args.body }),
  );
}

export function useDeleteIssueComment(repo: string) {
  return useOptimisticCommentMutation(
    repo,
    "issue",
    (args: { number: number; commentId: string }) =>
      api.forgeIssueDeleteComment(repo, args.number, args.commentId),
    () => null,
  );
}

/**
 * Optimistically patch the NESTED comments of the review-threads cache (edit
 * replaces one comment's body; delete removes it, dropping a thread that empties)
 * with exact-key rollback — mirroring {@link useOptimisticCommentMutation} for the
 * flat conversation comments, but one level down (thread → comments). `commentId`
 * is unique across threads (provider comment ids), so no threadId is needed. The
 * key is derived from the mutation args at mutate time so a mid-flight
 * repo/number switch never corrupts another key's cache; onSettled keeps the
 * repo-wide invalidation as server-truth reconciliation.
 */
function useOptimisticReviewCommentMutation<
  TArgs extends { number: number; commentId: string },
  TData,
>(
  repo: string,
  mutationFn: (args: TArgs) => Promise<TData>,
  patchComment: (comment: PrThreadOut, args: TArgs) => PrThreadOut | null,
) {
  return useOptimisticCacheMutation<TArgs, TData, ReviewThreadOut[]>(
    mutationFn,
    (args) => prReviewThreadsKey(repo, args.number),
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

export function useEditReviewComment(repo: string) {
  return useOptimisticReviewCommentMutation(
    repo,
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

export function useDeleteReviewComment(repo: string) {
  return useOptimisticReviewCommentMutation(
    repo,
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

export function useCheckoutPr(repo: string) {
  return useRepoMutation(repo, (number: number) =>
    api.ghPrCheckout(repo, number),
  );
}

export function useForkRepo(repo: string) {
  return useRepoMutation(repo, (contributeToParent: boolean) =>
    api.ghRepoFork(repo, contributeToParent),
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
    // Optimistic: flip the cached star state at once, roll back on failure.
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

/** The real avatar URL for a GitHub bot (dependabot, renovate, …), resolved via
 *  `gh api users/<name>[bot]` since bot logins have no `<host>/<login>.png`.
 *  Pass the bare bot name from {@link botLoginName}, or `null` for a non-bot /
 *  off-GitHub handle (disabled — no lookup). The URL is stable, so it's cached
 *  hard; `retry: false` keeps a 404 / offline miss from a retry storm — the
 *  caller falls back to initials on `""`. */
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

// ── Bitbucket settings surface (wave 2/3) ──────────────────────────────────
//
// Mirrors the useGl* hooks: repo-keyed reads with staleTime + retry:false, and
// mutations that invalidate their read on onSettled. The workspaces list is
// account-scoped (not repo-keyed).

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

// Create does NOT invalidate immediately: like pipeline variables, the schedules
// LIST lags a write by ~1s (server replication), so an immediate refetch returns a
// list WITHOUT the new row and keeps the empty state until a later manual refetch.
// The caller upserts the row into the cache and schedules ONE delayed invalidate to
// reconcile the real server row/uuid. Toggle/delete keep their invalidate below.
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

export function useReadyPr(repo: string) {
  return useRepoMutation(repo, (number: number) => api.ghPrReady(repo, number));
}

export function useEditPr(repo: string) {
  return useRepoMutation(
    repo,
    (args: { number: number; title: string; body: string }) =>
      api.forgePrEdit(repo, args.number, args.title, args.body),
  );
}

/** Add/remove labels on an issue, MR, or GitHub Discussion.
 *  GitHub uses the node-id path (`labelableId` + `addIds`/`removeIds`); GitLab uses
 *  names (`target` + `number` + `addNames`/`removeNames`). `kind` is the reconcile
 *  discriminator (the args carry no reliable entity id otherwise); `number` every
 *  entity has — for the GitHub node-id path it is used only for invalidation, so a
 *  discussion still sends `0` on the wire (byte-identical to the old default). The
 *  wire `target` derives from `kind`: issue→"issue", mr→"mr", discussion→"issue"
 *  (the old default). Reconciles per-kind on settle instead of the whole-repo
 *  default, since the args now carry a reliable discriminator. */
export function useEditPrLabels(repo: string) {
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
    onSettled: (_d, _e, args) => {
      const keys =
        args.kind === "issue"
          ? [
              ["repo", repo, "issue-list"],
              ["repo", repo, "issue", args.number],
            ]
          : args.kind === "mr"
            ? [
                ["repo", repo, "pr", args.number],
                ["repo", repo, "pr-list"],
              ]
            : args.kind === "discussion"
              ? [
                  ["repo", repo, "discussion", args.number],
                  ["repo", repo, "discussion-list"],
                ]
              : [repoKeys.all(repo)];
      return void Promise.all(
        keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
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
      ),
  );
}
