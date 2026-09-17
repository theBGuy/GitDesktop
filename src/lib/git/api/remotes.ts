import { invoke } from "@/lib/tauri/invoke";
import type { GhPublishOwners } from "../types";

export const gitRemotes = (repoPath: string) =>
  invoke<string[]>("git_remotes", { repoPath });

export const gitRemoteUrl = (repoPath: string, name: string) =>
  invoke<string>("git_remote_url", { repoPath, name });

export const gitRemoteSetUrl = (repoPath: string, name: string, url: string) =>
  invoke<void>("git_remote_set_url", { repoPath, name, url });

export const gitRemoteAdd = (repoPath: string, name: string, url: string) =>
  invoke<void>("git_remote_add", { repoPath, name, url });

export const gitRemoteRemove = (repoPath: string, name: string) =>
  invoke<void>("git_remote_remove", { repoPath, name });

/** Which providers this machine can publish to (CLI installed + signed in) —
 *  asked explicitly since an unpublished repo has no remote to detect one from. */
export const forgePublishTargets = (repoPath: string) =>
  invoke<{ github: boolean; gitlab: boolean; bitbucket: boolean }>(
    "forge_publish_targets",
    { repoPath },
  );

/** Publish a local repo to the CHOSEN provider (create + add origin + push).
 *  GitLab has no homepage field and drops it (the dialog hides that field).
 *  Bitbucket maps homepage → website, drops topics, and needs a `workspace`. */
export const forgePublishRepo = (
  provider: "github" | "gitlab" | "bitbucket",
  repoPath: string,
  name: string,
  isPrivate: boolean,
  description: string,
  homepage: string,
  topics: string[],
  workspace?: string,
) =>
  invoke<string>("forge_publish_repo", {
    provider,
    repoPath,
    name,
    private: isPrivate,
    description,
    homepage,
    topics,
    workspace,
  });

/** Owners the viewer can publish under — the GitHub publish owner picker (account-scoped). */
export const forgeGhPublishOwners = () =>
  invoke<GhPublishOwners>("forge_gh_publish_owners");
