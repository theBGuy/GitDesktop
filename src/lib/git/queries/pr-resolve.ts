import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import type { RemoteLens } from "../types";
import { useRepoMutation } from "./internal";
import { localPrWriteKey, prWriteKey } from "./pr-writes";

/** Merge a local PR in an isolated worktree. Keyed so the view's hold reads the
 *  cache, which outlives the view's own mount. */
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
    {
      // Local merge write — never park it offline.
      networkMode: "always",
      identity: localPrWriteKey("merge", repo),
    },
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
    {
      // Local merge write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Rolls a paused local-PR merge back by deleting its isolated worktree. */
export function useAbortLocalPrMerge(repo: string) {
  return useRepoMutation(
    repo,
    (args: { worktreePath: string; opId: string | null }) =>
      api.gitAbortLocalPrMerge(repo, args.worktreePath, args.opId),
    {
      // Local merge write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Merges the base into a remote PR's head branch in an isolated worktree, pushing the
 *  head when it comes out clean. Repo-wide invalidation is deliberate: a clean run moves
 *  the remote branch, so mergeability, the PR view and branch state all go stale.
 *  The variables name the PR, so the view holds each PR's resolve on its own. */
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
    { identity: prWriteKey("resolve-merge", repo) },
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

/** Discards a paused remote-PR resolution by deleting its worktree. The variables
 *  name no PR, so the view holds this repo-wide. */
export function useAbortRemotePrResolve(repo: string) {
  return useRepoMutation(
    repo,
    (args: { worktreePath: string }) =>
      api.gitAbortRemotePrResolve(repo, args.worktreePath),
    {
      // Local merge write — never park it offline.
      networkMode: "always",
      identity: prWriteKey("abort-resolve", repo),
    },
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
    // Local reads must not park on react-query's default "online" mode offline;
    // the same holds for every `networkMode` in this file.
    networkMode: "always",
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
    networkMode: "always",
  });
}
