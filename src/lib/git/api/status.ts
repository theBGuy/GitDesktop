import { invoke } from "@/lib/tauri/invoke";
import type { RepoOwner, RepoStatus, WorkingLineStats } from "../types";

export const gitStatus = (repoPath: string) =>
  invoke<RepoStatus>("git_status", { repoPath });

/** Per-file `+added -deleted` counts for the Changes panel's rows, split by
 *  diff side (`git_status` runs porcelain v2, which carries no line data). */
export const gitWorkingLineStats = (repoPath: string) =>
  invoke<WorkingLineStats>("git_working_line_stats", { repoPath });

/** Count of commits on HEAD not on any remote-tracking ref — the "unpublished"
 *  count for a branch with no upstream (where `branch.ahead` is undefined). */
export const gitUnpushedCount = (repoPath: string) =>
  invoke<number>("git_unpushed_count", { repoPath });

export const gitRepoOwners = (repoPaths: string[]) =>
  invoke<RepoOwner[]>("git_repo_owners", { repoPaths });
