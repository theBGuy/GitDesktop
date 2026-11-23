import { appErrorDetail } from "@/lib/error-summary";
import { invoke, isAppError } from "@/lib/tauri/invoke";
import type {
  Submodule,
  SubmoduleAcceptOutcome,
  SubmoduleChanges,
  SubmoduleCommitPage,
  SubmoduleConflict,
  SubmoduleConflictStages,
  SubmodulePickOutcome,
  SubmodulePickRead,
  SubmoduleRefs,
  SubmoduleRemoveOutcome,
} from "../types";

/** Twin of conflict.rs's SUBMODULE_REFUSAL and conflict-prefilter.ts's
 *  SUBMODULE_REFUSAL, pinned equal by scripts/conflict-prefilter.test.mjs: the
 *  conflict sides read refuses a gitlink conflict with it. */
export const SUBMODULE_CONFLICT_REFUSAL =
  "submodule conflict — pick a commit to resolve it";

/** Whether a rejected conflict sides read was the submodule-conflict refusal. */
export function isSubmoduleConflictRefusal(error: unknown): boolean {
  return (
    isAppError(error) &&
    error.kind === "invalidArgument" &&
    appErrorDetail(error.kind, error.message) === SUBMODULE_CONFLICT_REFUSAL
  );
}

/** Both sides of a conflicted submodule: the stage shas, each commit the
 *  submodule has, how they relate, and what accepting each would do to its
 *  checkout. Read-only. */
export const gitSubmoduleConflict = (repoPath: string, path: string) =>
  invoke<SubmoduleConflict>("git_submodule_conflict", { repoPath, path });

/** Stages one side's commit for a conflicted submodule and checks it out there
 *  when that is safe. `expected` is the read's stage shas and `expectCheckout`
 *  whether that read's plan for the side was "checkOut"; either moving answers
 *  `changed` with nothing staged. */
export const gitAcceptSubmoduleConflictSide = (
  repoPath: string,
  path: string,
  side: "ours" | "theirs",
  expected: SubmoduleConflictStages,
  expectCheckout: boolean,
) =>
  invoke<SubmoduleAcceptOutcome>("git_accept_submodule_conflict_side", {
    repoPath,
    path,
    side,
    expected,
    expectCheckout,
  });

export const gitSubmodules = (repoPath: string) =>
  invoke<Submodule[]>("git_submodules", { repoPath });

/** Init + update submodules per each one's `update` setting (by default, a
 *  checkout of the recorded commit); `path` for one, else all. `remote` instead
 *  moves them to the tip of the branch they track (the remote's default branch
 *  when none is configured), leaving the move unstaged in the parent for review. */
export const gitSubmoduleUpdate = (
  repoPath: string,
  path?: string,
  remote = false,
) =>
  invoke<void>("git_submodule_update", {
    repoPath,
    path: path ?? null,
    remote,
  });

/** Adds a submodule; `path` null derives it from the URL. Leaves `.gitmodules`
 *  and the new gitlink staged. */
export const gitSubmoduleAdd = (
  repoPath: string,
  url: string,
  path: string | null,
  branch: string | null,
) => invoke<void>("git_submodule_add", { repoPath, url, path, branch });

/** Removes a submodule, staging the deletion. Refuses a dirty one unless `force`;
 *  keeps its cached `.git/modules` data unless `deleteModuleData`. */
export const gitSubmoduleRemove = (
  repoPath: string,
  path: string,
  force: boolean,
  deleteModuleData: boolean,
) =>
  invoke<SubmoduleRemoveOutcome>("git_submodule_remove", {
    repoPath,
    path,
    force,
    deleteModuleData,
  });

export const gitSubmoduleSetUrl = (
  repoPath: string,
  path: string,
  url: string,
) => invoke<void>("git_submodule_set_url", { repoPath, path, url });

/** Sets the branch a submodule tracks; null tracks the remote's default. */
export const gitSubmoduleSetBranch = (
  repoPath: string,
  path: string,
  branch: string | null,
) => invoke<void>("git_submodule_set_branch", { repoPath, path, branch });

/** One side of a submodule row: the commits between its two gitlinks and, on the
 *  unstaged side, the files changed inside. Read-only. `origPath` is a staged
 *  rename's old path, where HEAD still records the gitlink. */
export const gitSubmoduleChanges = (
  repoPath: string,
  path: string,
  staged: boolean,
  origPath?: string,
) =>
  invoke<SubmoduleChanges>("git_submodule_changes", {
    repoPath,
    path,
    staged,
    origPath: origPath ?? null,
  });

/** A submodule's branches, remote branches and tags, plus the commits the
 *  parent records and the submodule has checked out. Read-only. */
export const gitSubmoduleRefs = (repoPath: string, path: string) =>
  invoke<SubmoduleRefs>("git_submodule_refs", { repoPath, path });

/** One page of `rev`'s history inside the submodule; `search` filters by
 *  message. Read-only. */
export const gitSubmoduleCommits = (
  repoPath: string,
  path: string,
  rev: string,
  skip: number,
  limit: number,
  search: string | null,
) =>
  invoke<SubmoduleCommitPage>("git_submodule_commits", {
    repoPath,
    path,
    rev,
    skip,
    limit,
    search,
  });

/** What pointing the submodule at `sha` (4-64 hex, a prefix or a full id)
 *  would do. Read-only and advisory: the setter measures again. */
export const gitSubmodulePickPlan = (
  repoPath: string,
  path: string,
  sha: string,
) =>
  invoke<SubmodulePickRead>("git_submodule_pick_plan", {
    repoPath,
    path,
    sha,
  });

/** Checks `sha` out inside the submodule and, only when that lands, stages it
 *  as the parent's pointer. `expectedIndexSha` is the plan read's `pointer`. */
export const gitSubmoduleSetCommit = (
  repoPath: string,
  path: string,
  sha: string,
  expectedIndexSha: string,
) =>
  invoke<SubmodulePickOutcome>("git_submodule_set_commit", {
    repoPath,
    path,
    sha,
    expectedIndexSha,
  });

/** Fetches inside the submodule; `unshallow` also completes a shallow history. */
export const gitSubmoduleFetch = (
  repoPath: string,
  path: string,
  unshallow: boolean,
) => invoke<void>("git_submodule_fetch", { repoPath, path, unshallow });
