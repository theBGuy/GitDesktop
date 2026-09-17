import type { CommitSummary } from "./history";

export interface BranchHead {
  name: string | null;
  detached: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** The upstream is configured but its remote-tracking ref is gone (e.g. the
   *  remote branch was deleted after a PR merge). Treat like "no upstream" for
   *  decisions: offer Publish over Push/Pull, allow undo-commit, don't demand a
   *  force-push on amend. */
  upstreamGone: boolean;
}

export interface Branch {
  name: string;
  isCurrent: boolean;
  upstream: string | null;
  /** ISO-8601 committer date of the branch tip (for recency sorting). */
  lastCommitDate: string;
  /** Hidden from the branch dropdown (a personal, local-config flag). */
  archived: boolean;
  /** Commits this branch is ahead of its own upstream. 0 when the branch is
   *  untracked, its upstream is gone, or the two are in sync. */
  upstreamAhead: number;
  /** Commits this branch is behind its own upstream — drives the
   *  "Update from {upstream}" action. 0 when untracked, gone, or in sync. */
  upstreamBehind: number;
  /** The upstream is configured but its remote-tracking ref is gone (e.g. the
   *  remote branch was deleted after a PR merge). Read as "no upstream" for
   *  pushed-ness decisions. */
  upstreamGone: boolean;
  /** The remote of the branch's upstream (git's `%(upstream:remotename)`), e.g.
   *  `origin` — null when untracked. Authoritative source for which remote a push
   *  targets; the UI must never re-derive it from the upstream string. */
  upstreamRemote: string | null;
}

/** A branch that exists on a remote but not locally — offered in the switcher so
 *  it can be checked out (which creates a local tracking branch). */
export interface RemoteBranch {
  /** Short branch name, without the remote prefix (e.g. `feature/x`). */
  name: string;
  /** The remote it lives on (e.g. `origin`). */
  remote: string;
  /** ISO-8601 committer date of the branch tip (for recency sorting). */
  lastCommitDate: string;
}

/**
 * Evidence for telling a server-side REWRITE of a branch's upstream (a remote
 * rebase or force-push — GitHub's "Update branch → rebase") apart from ordinary
 * two-sided divergence. The two want opposite remedies, so the app measures
 * rather than guesses.
 *
 * `remoteRewritten` answers one narrow question: is the upstream tip absent from
 * this branch's own reflog. That is NOT proof of a rewrite on its own — ordinary
 * divergence looks identical — so only the pair `remoteRewritten === true &&
 * localOnly === 0` (nothing local lacks a patch-twin upstream) may unlock a
 * reset-to-upstream offer. `null` means nothing was provable and every surface
 * must render exactly what it renders without this data.
 */
export interface BranchRewriteStatus {
  remoteRewritten: boolean | null;
  /** Commits on the branch with no patch-equivalent upstream — exactly the work
   *  a reset to the upstream would destroy. */
  localOnly: number;
  /** Commits on the upstream with no patch-equivalent locally. */
  remoteOnly: number;
  /** Commits matched by patch id. Counts BOTH sides of each pair, so a clean
   *  N-commit rebase reports `2 * N` — never render it as a commit count. */
  patchEqual: number;
  /** The upstream's short name (e.g. `origin/feature`). */
  upstream: string | null;
  /** The upstream tip's sha — a confirmed reset targets this commit, so it can
   *  only land on the state the user was shown. */
  upstreamTip: string | null;
}

/** A local branch's ahead/behind counts vs. the default branch. */
export interface BranchDivergence {
  name: string;
  /** Commits on this branch the default branch doesn't have. */
  ahead: number;
  /** Commits on the default branch this branch doesn't have. */
  behind: number;
}

export interface MergePreview {
  /** "up-to-date" (already merged) · "fast-forward" · "clean" (merge commit, no
   *  conflicts) · "conflict" · "unknown" (couldn't predict — old git/error). */
  status: "up-to-date" | "fast-forward" | "clean" | "conflict" | "unknown";
  /** Conflicting file paths when `status` is "conflict" (may be empty). */
  conflicts: string[];
}

export interface BranchComparison {
  /** On `compare` but not `base` — what a PR would introduce. */
  ahead: CommitSummary[];
  /** On `base` but not `compare` — what `compare` is missing. */
  behind: CommitSummary[];
}
