import { invoke } from "@/lib/tauri/invoke";
import type { HooksInfo } from "../types";

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
