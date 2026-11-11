import { invoke } from "@/lib/tauri/invoke";
import type { HooksInfo, KeepLocalHookStatus } from "../types";

export const gitHooksList = (repoPath: string) =>
  invoke<HooksInfo>("git_hooks_list", { repoPath });

export const gitHookRead = (repoPath: string, name: string) =>
  invoke<string | null>("git_hook_read", { repoPath, name });

export const gitHookWrite = (repoPath: string, name: string, content: string) =>
  invoke<void>("git_hook_write", { repoPath, name, content });

export const gitHookSetEnabled = (
  repoPath: string,
  name: string,
  enabled: boolean,
) => invoke<void>("git_hook_set_enabled", { repoPath, name, enabled });

export const gitHookDelete = (repoPath: string, name: string) =>
  invoke<void>("git_hook_delete", { repoPath, name });

export const gitKeepLocalHookStatus = (repoPath: string) =>
  invoke<KeepLocalHookStatus>("git_keep_local_hook_status", { repoPath });

/** Installs the Keep local pre-push hook. A blocked clone is left untouched and
 *  its blocked status is RETURNED, not thrown. */
export const gitKeepLocalHookInstall = (repoPath: string) =>
  invoke<KeepLocalHookStatus>("git_keep_local_hook_install", { repoPath });

/** Removes the Keep local pre-push hook; returns the status after. */
export const gitKeepLocalHookRemove = (repoPath: string) =>
  invoke<KeepLocalHookStatus>("git_keep_local_hook_remove", { repoPath });

/** Runs a hook manager's install (pre-commit/lefthook), which only writes the
 *  `.git/hooks` shim; returns its output. */
export const gitInstallHookManager = (repoPath: string, manager: string) =>
  invoke<string>("git_run_hook_manager", {
    repoPath,
    manager,
    action: "install",
  });

/** Runs a hook manager's update (pre-commit `autoupdate`), which fetches each
 *  hook repo's latest tag; returns its output. */
export const gitUpdateHookManager = (repoPath: string, manager: string) =>
  invoke<string>("git_run_hook_manager", {
    repoPath,
    manager,
    action: "update",
  });
