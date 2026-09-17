import { invoke } from "@/lib/tauri/invoke";
import type { CommitAuthor } from "../types";

export const gitUserIdentity = (repoPath: string) =>
  invoke<CommitAuthor>("git_user_identity", { repoPath });

export const gitLocalIdentity = (repoPath: string) =>
  invoke<CommitAuthor>("git_local_identity", { repoPath });

export const gitSetLocalIdentity = (
  repoPath: string,
  name: string,
  email: string,
) => invoke<void>("git_set_local_identity", { repoPath, name, email });

export const gitGlobalIdentity = () =>
  invoke<CommitAuthor>("git_global_identity");

export const gitSetGlobalIdentity = (name: string, email: string) =>
  invoke<void>("git_set_global_identity", { name, email });

export const gitGlobalDefaultBranch = () =>
  invoke<string>("git_global_default_branch");

export const gitSetGlobalDefaultBranch = (branch: string) =>
  invoke<void>("git_set_global_default_branch", { branch });

export const gitGlobalAutocrlf = () => invoke<string>("git_global_autocrlf");

export const gitSetGlobalAutocrlf = (value: string) =>
  invoke<void>("git_set_global_autocrlf", { value });
