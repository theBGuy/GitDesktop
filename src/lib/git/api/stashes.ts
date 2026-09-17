import { invoke } from "@/lib/tauri/invoke";
import type { FileDiff, OrphanedStash, StashEntry, StashFile } from "../types";

export const gitStashList = (repoPath: string) =>
  invoke<StashEntry[]>("git_stash_list", { repoPath });

export const gitStashFiles = (repoPath: string, index: number) =>
  invoke<StashFile[]>("git_stash_files", { repoPath, index });

export const gitStashFileDiff = (
  repoPath: string,
  index: number,
  filePath: string,
) => invoke<FileDiff>("git_stash_file_diff", { repoPath, index, filePath });

export const gitStashApply = (repoPath: string, index: number, pop: boolean) =>
  invoke<void>("git_stash_apply", { repoPath, index, pop });

export const gitStashDrop = (repoPath: string, index: number) =>
  invoke<void>("git_stash_drop", { repoPath, index });

export const gitOrphanedStashes = (repoPath: string) =>
  invoke<OrphanedStash[]>("git_orphaned_stashes", { repoPath });

export const gitOrphanedStashFiles = (repoPath: string, sha: string) =>
  invoke<StashFile[]>("git_orphaned_stash_files", { repoPath, sha });

export const gitOrphanedStashFileDiff = (
  repoPath: string,
  sha: string,
  filePath: string,
) =>
  invoke<FileDiff>("git_orphaned_stash_file_diff", { repoPath, sha, filePath });

export const gitRestoreOrphaned = (repoPath: string, sha: string) =>
  invoke<void>("git_restore_orphaned", { repoPath, sha });

export const gitStashAll = (repoPath: string) =>
  invoke<void>("git_stash_all", { repoPath });

// True when a stash entry was actually created (a pathspec matching nothing
// no-ops at exit 0).
export const gitStashPaths = (repoPath: string, paths: string[]) =>
  invoke<boolean>("git_stash_paths", { repoPath, paths });

export const gitStashPop = (repoPath: string) =>
  invoke<void>("git_stash_pop", { repoPath });

export const gitStashCount = (repoPath: string) =>
  invoke<number>("git_stash_count", { repoPath });
