/**
 * Branch rules are GitDesktop-local governance, stored per repository in app
 * data (never written into the repo). They're modeled on GitHub's branch
 * protection / rulesets but enforced at GitDesktop's own action points — so
 * they prevent accidents on ANY repo, even ones not hosted on GitHub. (Phase 3
 * will let GitHub repos import/sync their real server-side rulesets on top.)
 */

/** Allowed ways to integrate a head branch into a protected base. */
export type MergeMethod = "merge" | "squash" | "rebase";

/** A protection that applies to every branch whose name matches `pattern`. */
export interface BranchProtection {
  id: string;
  /** fnmatch-style glob, e.g. "main", "release/*", "{main,develop}". */
  pattern: string;
  /** Block deleting matching branches from GitDesktop. */
  blockDeletion: boolean;
  /** Block force-pushing matching branches (amending an already-pushed commit). */
  blockForcePush: boolean;
  /** No direct commits or direct merges — changes must arrive via a pull
   *  request. (GitHub's "lock branch" / "require a pull request".) */
  requirePr: boolean;
  /** Merge methods allowed when integrating INTO a matching branch. A method
   *  absent from this list is blocked; excluding "merge" enforces linear
   *  history. New protections default to all three. */
  allowedMergeMethods: MergeMethod[];
}

export const ALL_MERGE_METHODS: MergeMethod[] = ["merge", "squash", "rebase"];

export const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  merge: "Merge commit",
  squash: "Squash",
  rebase: "Rebase",
};

/** Repo-wide policy for the names of NEW branches. */
export interface NamingPolicy {
  /** When on, new branch names must match `pattern`. */
  enabled: boolean;
  /** fnmatch-style glob a new branch name must match. */
  pattern: string;
  /** Friendly examples shown when a name is rejected, e.g. "feature/*, fix/*". */
  hint: string;
}

export interface BranchRulesConfig {
  naming: NamingPolicy;
  protections: BranchProtection[];
  /** fnmatch-style globs for branches whose pull requests PROMOTE work onward
   *  (a `staging` → `production` PR, say). Their head is behind its base by
   *  design, so GitDesktop never offers to update them from it. */
  promotionBranches: string[];
}

export const EMPTY_BRANCH_RULES: BranchRulesConfig = {
  naming: { enabled: false, pattern: "", hint: "" },
  protections: [],
  promotionBranches: [],
};
