import { appErrorDetail } from "@/lib/error-summary";
import { invoke, isAppError } from "@/lib/tauri/invoke";
import type {
  Submodule,
  SubmoduleAcceptOutcome,
  SubmoduleChanges,
  SubmoduleConflict,
  SubmoduleConflictStages,
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

/** Init + update submodules to the recorded commit; `path` for one, else all.
 *  `remote` instead moves them to the tip of the branch they track (the remote's
 *  default branch when none is configured), leaving a bump staged in the parent. */
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
