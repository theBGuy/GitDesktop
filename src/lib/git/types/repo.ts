import type { BranchHead } from "./branches";
import type { FileEntry } from "./workingtree";

export interface GitInfo {
  version: string;
}

export interface RepoInfo {
  root: string;
  name: string;
}

export interface RepoStatus {
  branch: BranchHead;
  entries: FileEntry[];
}

export interface RepoOwner {
  path: string;
  owner: string | null;
  /** The origin remote's host (e.g. "github.com", "gitlab.com") — lets per-repo
   *  UI name the actual provider. */
  host: string | null;
  /** The provider that host routes to ("github" / "gitlab" / "bitbucket"),
   *  including self-managed GitLab hosts glab is signed in to. Null when
   *  unrecognized — the UI labels those GitHub (gh stays authoritative). */
  provider: string | null;
  /** Repo name as the origin URL spells it, which a renamed clone's folder
   *  basename doesn't. Null when no remote resolves. */
  repoName: string | null;
}

/** A checkout's origin remote, split into the axes a work-inbox row has to match
 *  before it may open locally. Any field is `""` when unknown, which the caller
 *  reads as UNPROVEN rather than as a mismatch. All are needed: equal namespaces
 *  on two hosts are different projects, and so are equal hostnames on two ports. */
export interface RepoOrigin {
  /** Hostname alone, ports stripped. */
  host: string;
  /** Hostname plus the WEB port, lowercased — the spelling a web URL's `URL.host`
   *  yields. `:443` on https and `:80` on http are elided, any other web port is
   *  kept, and a non-web scheme's transport port (`ssh://…:2222`) is dropped
   *  entirely: it says nothing about where the web UI lives. */
  authority: string;
  /** The full namespace path the provider spells ("group/sub/repo"). */
  path: string;
  /** The checkout's detection verdict at proof time — the integration a landing
   *  there would actually resolve. `"github"` covers the resilient default an
   *  unrecognized host falls back to, so it is an answer, not an absence; `""`
   *  means the path is not a repo at all. */
  provider: string;
}
