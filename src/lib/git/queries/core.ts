import { type QueryKey, useQuery } from "@tanstack/react-query";
import { COLD_START_NO_GIT } from "@/lib/test-mode";
import * as api from "../api";
import { repoIdentityQueryOptions } from "../repo-identity-query";

/** A repo's worktree-stable identity key (its common git dir), for keying
 *  per-repo app-data the same across the main checkout and every worktree. Null or
 *  `""` means no repo, which disables the query. On an IPC failure `data` stays
 *  undefined with `isError` set, so consumers read `identity ?? repoPath` and
 *  treat the error as settled rather than waiting on a value that needs a remount —
 *  except surfaces that WRITE under the identity key, which hold their editable
 *  body on `isError` (a Retry arm) rather than composing edits over the raw path. */
export function useRepoIdentity(repo: string | null) {
  return useQuery(repoIdentityQueryOptions(repo || null));
}

/**
 * `keepPreviousData` scoped to ONE repo: panels stay mounted across repo switches, so
 * plain keepPreviousData would keep the previous repo's rows on screen (and, for
 * number-keyed maps, briefly-wrong data). Keeps previous data only when the previous
 * query's repo segment matches, so Load-more and Open/Closed switches still skip the
 * skeleton. `repoKeyIndex` is where the repo sits in the key (index 1 for every key
 * passed to it).
 * A key that also varies on an identity axis beyond repo (lens, state) needs
 * `keepPreviousDataForKeyAxes` instead (e.g. the PR and issue list hooks in
 * prs.ts and issues.ts): matching repo alone would serve another axis's data.
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
  branchAhead: (repo: string, base: string, compare: string) =>
    ["repo", repo, "compare", base, compare, "ahead"] as const,
  branchAheadCount: (repo: string, base: string, compare: string) =>
    ["repo", repo, "compare", base, compare, "ahead-count"] as const,
  branchDiffFiles: (repo: string, base: string, compare: string) =>
    ["repo", repo, "compare", base, compare, "files"] as const,
  branchFileDiff: (repo: string, base: string, compare: string, file: string) =>
    ["repo", repo, "compare", base, compare, "diff", file] as const,
  mergeBase: (repo: string, base: string, compare: string) =>
    ["repo", repo, "compare", base, compare, "merge-base"] as const,
  objectsPresent: (repo: string, oidsKey: string) =>
    ["repo", repo, "objects-present", oidsKey] as const,
  // Family PREFIXES for the forge list queries: hooks append their axes onto these
  // and invalidations pass them bare, so a declaration and its invalidations cannot
  // drift. `scripts/query-key-families.test.mjs` refuses new spellings outside this
  // file, literal or repoKeys.all-composed.
  prList: (repo: string) => ["repo", repo, "pr-list"] as const,
  prCi: (repo: string) => ["repo", repo, "pr-ci"] as const,
  prMergeability: (repo: string) => ["repo", repo, "pr-mergeability"] as const,
  prReviewState: (repo: string) => ["repo", repo, "pr-review-state"] as const,
  issueList: (repo: string) => ["repo", repo, "issue-list"] as const,
};

export function useGitInstalled() {
  return useQuery({
    queryKey: ["git-installed"],
    // Cold-start test mode can pretend git is absent to exercise GitMissingScreen.
    queryFn: COLD_START_NO_GIT
      ? () => Promise.reject(new Error("Git not found (cold-start test mode)"))
      : api.checkGitInstalled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    // A local probe: react-query's default "online" mode would park it offline.
    networkMode: "always",
  });
}
