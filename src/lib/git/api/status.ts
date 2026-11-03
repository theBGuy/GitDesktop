import { invoke } from "@/lib/tauri/invoke";
import type { RepoOwner, RepoStatus, WorkingLineStats } from "../types";

export const gitStatus = (repoPath: string) =>
  invoke<RepoStatus>("git_status", { repoPath });

/** Per-file `+added -deleted` counts for the Changes panel's rows, split by
 *  diff side (`git_status` runs porcelain v2, which carries no line data). */
export const gitWorkingLineStats = (repoPath: string) =>
  invoke<WorkingLineStats>("git_working_line_stats", { repoPath });

/** What `git_unpushed_count` counted against: `remotes` (`--not --remotes`)
 *  whenever a remote is configured or a remote-tracking ref resolves. Otherwise
 *  the commits past the local default branch when one verifies and HEAD isn't
 *  on it (`default-branch`), else every HEAD commit: `on-default-branch` when
 *  HEAD is that branch, `unresolved` when no default verifies. */
export type UnpushedBasis =
  | "remotes"
  | "default-branch"
  | "on-default-branch"
  | "unresolved";

/** `defaultBranch` is non-null only for the two default-branch bases. */
export interface UnpushedCount {
  count: number;
  basis: UnpushedBasis;
  defaultBranch: string | null;
}

/** The "unpublished" count for a branch with no upstream (where
 *  `branch.ahead` is undefined), paired with the basis it was taken against. */
export const gitUnpushedCount = (repoPath: string) =>
  invoke<UnpushedCount>("git_unpushed_count", { repoPath });

export const gitRepoOwners = (repoPaths: string[]) =>
  invoke<RepoOwner[]>("git_repo_owners", { repoPaths });
