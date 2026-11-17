import type { FileEntry } from "./workingtree";

/** A git submodule and its state vs. the commit the parent records. */
export interface Submodule {
  path: string;
  /** Its `.gitmodules` name, which git allows to differ from the path. */
  name: string;
  url: string;
  /** The branch it tracks (`submodule.<name>.branch`); null = the remote's default. */
  branch: string | null;
  sha: string;
  describe: string;
  /** "ok" | "uninitialized" | "modified" | "conflict" */
  status: string;
}

/** What a submodule removal actually did. Every field matters to the user: the
 *  removal only ever stages, and a refusal means nothing changed at all. */
export interface SubmoduleRemoveOutcome {
  /** The submodule has local changes and nothing was mutated — retry with force. */
  refusedDirty: boolean;
  moduleDataDeleted: boolean;
  /** Deleting the cached `.git/modules` data failed; the removal itself is still
   *  staged, so this is a disclosure rather than an error. */
  moduleDataError: string | null;
}

/** What sits at a submodule's path: its own repository (`ok`), a folder with no
 *  `.git` (`notInitialized`), nothing (`missing`), a file (`replaced`), or a
 *  repository whose status read failed (`unreadable`). */
export type SubmoduleCheckout =
  | "ok"
  | "notInitialized"
  | "missing"
  | "replaced"
  | "unreadable";

export interface SubmoduleCommit {
  sha: string;
  subject: string;
}

/** One side of a submodule row in Changes. Staged compares HEAD's gitlink to the
 *  index's; unstaged compares the index's to the checked-out commit. */
export interface SubmoduleChanges {
  path: string;
  staged: boolean;
  checkout: SubmoduleCheckout;
  /** Non-null, and never empty, exactly when `checkout` is "unreadable". */
  reason: string | null;
  /** Null when detached or the checkout isn't "ok". */
  branch: string | null;
  detached: boolean;
  /** The checked-out commit; null when unborn or the checkout isn't "ok". */
  head: string | null;
  fromSha: string | null;
  toSha: string | null;
  /** False: the range below was NOT measured, so its empty lists mean nothing. */
  rangeKnown: boolean;
  /** In `toSha` and not in `fromSha`, newest first, at most 50. */
  ahead: SubmoduleCommit[];
  aheadCount: number;
  /** In `fromSha` and not in `toSha`, newest first, at most 50. */
  behind: SubmoduleCommit[];
  behindCount: number;
  /** The submodule's own status rows, at most 100; empty on the staged side. */
  files: FileEntry[];
  filesTotal: number;
}

/** A conflict side's commit, read inside the submodule. */
export interface SubmoduleConflictCommit {
  subject: string;
  /** The committer date, ISO 8601 (`%cI`). */
  committedAt: string;
}

/** What accepting a side would do to the submodule's own checkout. */
export type SubmoduleCheckoutPlan =
  | "checkOut"
  | "alreadyThere"
  | "notInitialized"
  | "unusable"
  | "dirty"
  | "detachedElsewhere"
  | "notFetched";

export interface SubmoduleConflictSide {
  sha: string;
  /** False: a file sits on this side, not a submodule commit. */
  gitlink: boolean;
  /** Non-null exactly when the submodule's object store has the commit. */
  commit: SubmoduleConflictCommit | null;
  /** As of this read; null when `gitlink` is false. The accept plans again. */
  plan: SubmoduleCheckoutPlan | null;
}

/** How the two sides' commits relate; measured only when the submodule has both. */
export type SubmoduleConflictRelation =
  | { kind: "unknown" }
  | { kind: "diverged" }
  | { kind: "oursContainsTheirs"; ahead: number }
  | { kind: "theirsContainsOurs"; ahead: number };

/** A conflicted gitlink. Every stage null = the path is no longer conflicted. */
export interface SubmoduleConflict {
  base: string | null;
  ours: SubmoduleConflictSide | null;
  theirs: SubmoduleConflictSide | null;
  relation: SubmoduleConflictRelation;
}

/** The stage shas an accept was picked from; any difference returns `changed`. */
export interface SubmoduleConflictStages {
  base: string | null;
  ours: string | null;
  theirs: string | null;
}

export type SubmoduleCheckoutLeft =
  | "notInitialized"
  | "unusable"
  | "dirty"
  | "detachedElsewhere"
  | "notFetched"
  | "failed";

export type SubmoduleAcceptCheckout =
  | { kind: "checkedOut" }
  | { kind: "alreadyThere" }
  | { kind: "left"; why: SubmoduleCheckoutLeft; reason: string | null };

/** `changed`: the stages, or the checkout the pane promised, moved since the
 *  read. Nothing was staged. */
export type SubmoduleAcceptOutcome =
  | { kind: "staged"; sha: string; checkout: SubmoduleAcceptCheckout }
  | { kind: "changed" };
