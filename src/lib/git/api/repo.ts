import { invoke } from "@/lib/tauri/invoke";
import type {
  ForgeProvider,
  GitInfo,
  RemoteLens,
  RepoInfo,
  RepoOrigin,
} from "../types";

export const checkGitInstalled = () => invoke<GitInfo>("check_git_installed");

export const validateRepo = (path: string) =>
  invoke<RepoInfo>("validate_repo", { path });

/** Whether a path is still a directory on disk — a bare fs check, no git. Lets a
 *  deleted checkout be named as such instead of surfacing as whatever the
 *  repo-scoped read failed with. */
export const pathIsDir = (path: string) =>
  invoke<boolean>("path_is_dir", { path });

/** The checkout's origin host, namespace path, web authority and detection
 *  verdict, each `""` when unknown. Proves a checkout really is a given
 *  repository where a recents match key cannot: that key keeps only the segment
 *  before the repo name, and its host is a stored value that goes stale the
 *  moment a remote is re-pointed. */
export const repoOriginPath = (repoPath: string) =>
  invoke<RepoOrigin>("repo_origin_path", { repoPath });

export const cloneRepo = (
  url: string,
  parentDir: string,
  dirName?: string,
  recurseSubmodules = false,
) =>
  invoke<string>("clone_repo", {
    url,
    parentDir,
    dirName: dirName ?? null,
    recurseSubmodules,
  });

export interface CreateRepoOptions {
  name: string;
  description: string;
  parentDir: string;
  initReadme: boolean;
  gitignore: string | null;
  license: string | null;
  defaultBranch: string;
}

export const createRepo = (options: CreateRepoOptions) =>
  invoke<string>("create_repo", { options });

/** Moves a repository folder to the OS recycle bin. */
export const deleteRepoFolder = (path: string) =>
  invoke<void>("delete_repo_folder", { path });

/** The repo's web URL on its provider (GitHub or GitLab). `lens` picks which
 *  remote answers on a GitHub fork — omitted (the default) is the fork itself,
 *  `"upstream"` the parent. GitLab and Bitbucket have one repo and ignore it. */
export const forgeRepoUrl = (repoPath: string, lens?: RemoteLens) =>
  invoke<string>("forge_repo_url", { repoPath, lens: lens ?? null });

/** A repo's visibility probe: visibility (lowercase "public" | "private" | "internal")
 *  plus fork provenance, in one round-trip. `isFork` is set only on positive API
 *  evidence; `parent` is the upstream slug when supplied. Rejects when visibility is
 *  undeterminable (no remote / no auth / API failure) — callers treat a rejection as
 *  "leave the persisted values alone". */
export interface RepoVisibility {
  visibility: string;
  isFork: boolean;
  parent: string | null;
}

export const forgeRepoVisibility = (repoPath: string) =>
  invoke<RepoVisibility>("forge_repo_visibility", { repoPath });

/** Clone a repo for a provider, supplying provider auth that plain `git clone`
 *  lacks (a private GitLab repo authenticates via glab's token). Returns the
 *  cloned path. */
export const forgeClone = (
  provider: ForgeProvider,
  url: string,
  parentDir: string,
  dirName?: string,
  recurseSubmodules = false,
) =>
  invoke<string>("forge_clone", {
    provider,
    url,
    parentDir,
    dirName: dirName ?? null,
    recurseSubmodules,
  });
