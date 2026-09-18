import { invoke } from "@/lib/tauri/invoke";
import type {
  ForgeForkResult,
  ForgeProvider,
  ForgeProviderFeatures,
  ForgeRepoList,
  ForgeSearchList,
  GhRepoList,
  MyWorkPage,
  MyWorkSources,
} from "../types";

/** The signed-in user's repositories on a provider, for the clone browser. */
export const forgeListRepos = (provider: ForgeProvider) =>
  invoke<ForgeRepoList>("forge_list_repos", { provider });

/** The namespaces the signed-in user owns on a provider — derived from the
 *  same probes as `forgeListRepos`' `ownedNamespaces`, without the repository
 *  list. */
export const forgeOwnedNamespaces = (provider: ForgeProvider) =>
  invoke<string[]>("forge_owned_namespaces", { provider });

/** The viewer's work items across every repository on a provider — one leg of the
 *  cross-repo inbox. Provider-scoped rather than repo-scoped: each row names the
 *  repository it came from. `repoPaths` scopes the search to specific local
 *  checkouts for a provider whose API can't answer account-wide (Bitbucket); null
 *  asks the provider for everything involving the viewer. */
export const forgeMyWork = (provider: ForgeProvider, repoPaths?: string[]) =>
  invoke<MyWorkPage>("forge_my_work", {
    provider,
    repoPaths: repoPaths ?? null,
  });

/** Which providers have a usable sign-in for the work inbox — its gate for which
 *  legs to fetch at all. */
export const forgeMyWorkSources = () =>
  invoke<MyWorkSources>("forge_my_work_sources");

// ── Explore: search / browse / fork / star / README ──────────────────────────
//
// The Explore surface searches and browses repositories on a provider. An empty
// `query` means the Popular feed (GitHub/GitLab only — never send an empty query
// for Bitbucket, whose search is workspace-scoped and single-page).

/** Search repositories on a provider (empty `query` = the Popular feed on
 *  GitHub/GitLab). `page` is 1-based; `hasMore` on the result drives paging. */
export const forgeSearchRepos = (
  provider: ForgeProvider,
  query: string,
  sort: "best" | "stars" | "updated",
  page: number,
) =>
  invoke<ForgeSearchList>("forge_search_repos", {
    provider,
    query,
    sort,
    page,
  });

/** Fork a repository under the signed-in user's account. Async server-side — the
 *  result's `ready` is false when the fork's git objects may not be clonable yet. */
export const forgeForkRepo = (
  provider: ForgeProvider,
  owner: string,
  name: string,
) => invoke<ForgeForkResult>("forge_fork_repo", { provider, owner, name });

/** Star (or unstar, when `star` is false) a repository. */
export const forgeStarRepo = (
  provider: ForgeProvider,
  owner: string,
  name: string,
  star: boolean,
) => invoke<void>("forge_star_repo", { provider, owner, name, star });

/** Whether the signed-in user has starred a repository. */
export const forgeStarred = (
  provider: ForgeProvider,
  owner: string,
  name: string,
) => invoke<boolean>("forge_starred", { provider, owner, name });

/** A repository's rendered README (HTML/markdown from the provider); null when the
 *  repo has no README (not an error). `defaultBranch` scopes the lookup when known. */
export const forgeRepoReadme = (
  provider: ForgeProvider,
  owner: string,
  name: string,
  defaultBranch: string | null,
) =>
  invoke<string | null>("forge_repo_readme", {
    provider,
    owner,
    name,
    defaultBranch,
  });

/** What a provider supports and what GitDesktop has built for it — the gate the
 *  Explore surface reads to show only Fork/Star/README controls that work. */
export const forgeProviderFeatures = (provider: ForgeProvider) =>
  invoke<ForgeProviderFeatures>("forge_provider_features", { provider });

// ── The open repo (fork, star) & the viewer's own repos ──────────────────────

/** Remove the project's fork relationship (detach from the fork network) —
 *  GitLab-only. Requires the Owner role; open MRs to the parent are closed. */
export const forgeGlRemoveForkRelationship = (repoPath: string) =>
  invoke<void>("forge_gl_remove_fork_relationship", { repoPath });

/** Every repo the signed-in user can access (+ viewer login), newest first. */
export const ghListRepos = () => invoke<GhRepoList>("gh_list_repos");

/** Returns the fork's URL ("" when the fork already existed). */
export const ghRepoFork = (repoPath: string, contributeToParent: boolean) =>
  invoke<string>("gh_repo_fork", { repoPath, contributeToParent });

/** Whether the signed-in user has starred this repo. */
export const forgeRepoStarStatus = (repoPath: string) =>
  invoke<boolean>("forge_repo_star_status", { repoPath });

/** Stars (true) or unstars (false) this repo for the signed-in user. */
export const forgeRepoSetStar = (repoPath: string, starred: boolean) =>
  invoke<void>("forge_repo_set_star", { repoPath, starred });
