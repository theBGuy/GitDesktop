import { invoke } from "@/lib/tauri/invoke";
import type { Submodule, SubmoduleRemoveOutcome } from "../types";

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
