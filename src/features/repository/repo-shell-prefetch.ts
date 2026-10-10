import type {
  FetchQueryOptions,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";
import {
  branchRulesOptions,
  sharedBranchRulesOptions,
} from "@/lib/branch-rules/queries";
import {
  branchAheadCountOptions,
  defaultBranchOptions,
  oplogCheckOptions,
  opStateOptions,
  remotesOptions,
  repoStatusOptions,
  stashCountOptions,
  USER_WORKTREES_STALE_TIME,
  userWorktreesOptions,
  workingLineStatsOptions,
} from "@/lib/git/queries";
import type { RepoStatus } from "@/lib/git/types";
import { jiraLinkOptions } from "@/lib/jira/queries";
import { localPrsOptions } from "@/lib/pulls/queries";
import { REPO_SHELL_BUDGET_MS, settleWithin } from "./repo-shell-budget";

/**
 * Warms the local reads the repo view paints first, for a repo about to open, and
 * resolves once the COLD ones land, or after {@link REPO_SHELL_BUDGET_MS}. A key
 * with cached data doesn't hold the switch, with one exception: invalidated
 * personal branch rules hold like a missing read (see below). Otherwise a stale or
 * invalidated key revalidates in the background, and a fresh one (the personal
 * rules until invalidated, the 30 s reads) is served as cached. Every prefetch
 * spreads its hook's own factory — fetch options are per call, and a prefetch
 * missing the factory's `networkMode: "always"` would park offline with the
 * mounted observer joined to it. Forge reads are never prefetched here.
 */
export function warmRepoShell(
  queryClient: QueryClient,
  root: string,
): Promise<void> {
  const held: Promise<unknown>[] = [];
  const isCold = (key: QueryKey, holdInvalidated: boolean) => {
    const state = queryClient.getQueryState(key);
    return (
      state?.data === undefined || (holdInvalidated && state.isInvalidated)
    );
  };
  function warm<TData, TKey extends QueryKey>(
    options: FetchQueryOptions<TData, Error, TData, TKey>,
    { into = held, holdInvalidated = false } = {},
  ): Promise<void> {
    const cold = isCold(options.queryKey, holdInvalidated);
    const done = queryClient.prefetchQuery(options);
    if (cold) into.push(done);
    return done;
  }

  const status = repoStatusOptions(root);
  const defaultBranch = defaultBranchOptions(root);
  const headWasCold =
    isCold(status.queryKey, false) || isCold(defaultBranch.queryKey, false);
  const head = Promise.all([warm(status), warm(defaultBranch)]);
  warm(remotesOptions(root));
  warm(opStateOptions(root));
  warm(oplogCheckOptions(root));
  warm(localPrsOptions(root));
  // Only the personal rules hold on an invalidated read. They are stored by repo
  // identity, so a save from another worktree reaches this checkout as an
  // invalidation alone, and the cached rules would paint a CommitBox notice that
  // flips a moment later. Every `["repo", …]` key is invalidated on each window
  // focus, so holding on those would cost every warm switch the budget.
  warm(branchRulesOptions(root), { holdInvalidated: true });
  warm(sharedBranchRulesOptions(root));
  warm(jiraLinkOptions(root));
  // With the hook's staleTime, so a switch back within 30 s of the last read,
  // with no window focus in between (each focus invalidates every `["repo", …]`
  // key, forcing a refetch), reuses the cached list instead of respawning `git
  // worktree list`. Still held when cold: the header's switcher reads it ungated
  // for the worktree subtitle the moment the switch lands.
  warm({
    ...userWorktreesOptions(root),
    staleTime: USER_WORKTREES_STALE_TIME,
  });
  warm(stashCountOptions(root));

  // The Changes panel's reads keyed by what status and default-branch answer, under
  // the panel's own gates: per-row line counts on a dirty tree, the "Open pull
  // request" ahead-count on a clean branch other than the default.
  const warmDependents = (into: Promise<unknown>[]) => {
    const tree = queryClient.getQueryData<RepoStatus>(status.queryKey);
    const base = queryClient.getQueryData<string | null>(
      defaultBranch.queryKey,
    );
    if (!tree) return;
    const current = tree.branch.detached ? null : tree.branch.name;
    if (tree.entries.length > 0) {
      warm(workingLineStatsOptions(root), { into });
    } else if (
      typeof base === "string" &&
      current !== null &&
      current !== base
    ) {
      warm(branchAheadCountOptions(root, base, current), { into });
    }
  };
  // A cold head decides the dependents once it lands; a warm one decides them now
  // from its cached answers, so a dependent the last visit never read (a tree that
  // went dirty, a branch changed while away) still lands with the switch.
  if (headWasCold) {
    held.push(
      head.then(() => {
        const wave: Promise<unknown>[] = [];
        warmDependents(wave);
        return Promise.all(wave);
      }),
    );
  } else {
    warmDependents(held);
  }
  return settleWithin(held, REPO_SHELL_BUDGET_MS);
}
