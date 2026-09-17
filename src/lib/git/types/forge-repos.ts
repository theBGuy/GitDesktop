import type {
  ForgeCapabilities,
  ForgeImplemented,
  ForgeProvider,
} from "./forge";

export interface GhRepo {
  nameWithOwner: string;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  cloneUrl: string;
  sshUrl: string;
  description: string | null;
  pushedAt: string | null;
}

export interface GhRepoList {
  /** The signed-in user's login, so the UI can list their repos first. */
  viewer: string;
  repos: GhRepo[];
}

/** Provider-neutral repository row for the clone browser (GitHub via gh, GitLab
 *  via glab). Mirrors {@link GhRepo} but with a provider-agnostic `fullName`. */
export interface ForgeRepo {
  /** "owner/name" (GitHub) or "group/subgroup/name" (GitLab). */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  cloneUrl: string;
  sshUrl: string;
  description: string | null;
  pushedAt: string | null;
}

export interface ForgeRepoList {
  /** The signed-in user's login. Kept on the wire; no frontend consumer today. */
  viewer: string;
  /** The `owner` namespaces that count as the viewer's own — a set because "yours" is
   *  provider-shaped: a login on GitHub and GitLab, any workspace you belong to on
   *  Bitbucket. Drives the own-repo Fork gate and the yours-first grouping; empty
   *  means unresolved, so both fail open. */
  ownedNamespaces: string[];
  repos: ForgeRepo[];
}

/** A repository row from the Explore search/browse surface — richer than
 *  {@link ForgeRepo} (stars/language/updatedAt) so results you don't own can rank and
 *  describe. Rust `Option<T>` serializes to `null`. */
export interface ForgeSearchRepo {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  cloneUrl: string;
  sshUrl: string;
  description: string | null;
  updatedAt: string | null;
  stars: number | null;
  language: string | null;
  webUrl: string | null;
  defaultBranch: string | null;
}

/** One page of Explore search results. `hasMore` drives the load-more button;
 *  `total` is the provider's reported match count (GitHub caps search at 1000
 *  reachable results, so `total` may exceed what paging can reach; null when the
 *  provider gives no count). */
export interface ForgeSearchList {
  repos: ForgeSearchRepo[];
  hasMore: boolean;
  total: number | null;
}

/** The result of forking a repo by name. Fork is async server-side, so
 *  `ready: false` means the fork was created but its git objects may not be
 *  clonable yet. */
export interface ForgeForkResult {
  fullName: string;
  cloneUrl: string;
  webUrl: string | null;
  ready: boolean;
}

/** What a provider supports *and* what GitDesktop has built for it, bundled for
 *  the Explore surface so it can gate Fork/Star/README in one fetch. */
export interface ForgeProviderFeatures {
  capabilities: ForgeCapabilities;
  implemented: ForgeImplemented;
}

/** One row of the cross-repo work inbox: the wire shape of `forge_my_work`.
 *  Items come from the provider, not a local repo, so each carries its own
 *  `host` + `repoFullName` — the only identity a row has to navigate by. */
export interface MyWorkItem {
  number: number;
  title: string;
  isPullRequest: boolean;
  repoFullName: string;
  repoOwner: string;
  repoName: string;
  host: string;
  url: string;
  updatedAt: string;
  authorLogin?: string | null;
  /** Which forge the row came from. The rows of several providers merge into one
   *  list, so the item carries its own provider rather than inheriting the
   *  screen's — it drives the row glyph and the per-row open/link copy. */
  provider: ForgeProvider;
}

/** One page of the work inbox. `truncated` is true when a search leg hit its
 *  own server-side cap, the merged union overshot the page, or a provider lost
 *  part of its results (a host, a repo) — so it can be true on a page that
 *  arrives short; it means "items may be missing", not "the page is full". */
export interface MyWorkPage {
  items: MyWorkItem[];
  truncated: boolean;
}

/** Which forges the work inbox can fetch from right now — one flag per provider,
 *  so a provider the user isn't signed in to is never asked and never contributes
 *  a failure the other providers' rows would have to share a screen with. */
export interface MyWorkSources {
  github: boolean;
  gitlab: boolean;
  bitbucket: boolean;
}
