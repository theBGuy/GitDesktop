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
  /** Git couldn't read the submodule or its status and nothing was mutated —
   *  its local changes can't be checked, so a retry with force is confirmed
   *  first. The clause completes "Git couldn't read <path>: <clause>". */
  refusedUnreadable: string | null;
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

/** A commit on a submodule ref. `onRemote` null = not measured, never "unpushed". */
export interface SubmoduleRefCommit {
  sha: string;
  subject: string;
  author: string;
  authoredAt: string;
  onRemote: boolean | null;
}

/** One page of a ref's history inside a submodule; a `checkout` other than "ok"
 *  means no git ran inside the folder and `commits` is empty. */
export interface SubmoduleCommitPage {
  checkout: SubmoduleCheckout;
  reason: string | null;
  commits: SubmoduleRefCommit[];
  hasMore: boolean;
  shallow: boolean | null;
  /** The commit id `rev` resolved to for this page; later pages pass it as
   *  their `rev`, so a ref that moves between pages never skips commits. */
  tip: string | null;
}

/** `rev` is the full ref name the commit list reads; `name` is what rows show. */
export interface SubmoduleRef {
  rev: string;
  name: string;
  sha: string;
}

/** A submodule's refs and the two commits the picker frames: `pointer` (the
 *  parent index's gitlink) and `head` (what the submodule has checked out). */
export interface SubmoduleRefs {
  checkout: SubmoduleCheckout;
  reason: string | null;
  pointer: string | null;
  head: string | null;
  branch: string | null;
  detached: boolean;
  shallow: boolean | null;
  defaultRev: string | null;
  branches: SubmoduleRef[];
  remoteBranches: SubmoduleRef[];
  tags: SubmoduleRef[];
  truncated: boolean;
  brokenRefs: number;
}

export type SubmodulePickMove = "checkOut" | "alreadyThere";

/** `wouldOverwrite` is tracked local changes only; untracked and ignored files in
 *  the checkout's way have their own kinds, and when several apply, tracked wins
 *  over untracked over ignored. `submoduleMidOperation`'s `reason` names the
 *  operation ("a merge", "unresolved conflicts", …), or is null when unknown. */
export type SubmodulePickBlock =
  | "notInitialized"
  | "unusable"
  | "noPointer"
  | "midOperation"
  | "submoduleMidOperation"
  | "notFetched"
  | "notFound"
  | "ambiguous"
  | "notACommit"
  | "detachedOrphan"
  | "detachedUnverified"
  | "wouldOverwrite"
  | "untrackedInTheWay"
  | "ignoredInTheWay"
  | "checkFailed";

/** Advisory: the setter re-measures everything and can answer differently. */
export type SubmodulePickPlan =
  | { kind: "ready"; checkout: SubmodulePickMove }
  | { kind: "current" }
  | {
      kind: "blocked";
      why: SubmodulePickBlock;
      reason: string | null;
      paths: string[];
    };

/** The candidate against the recorded commit (`rewind` moves the parent back). */
export type SubmodulePickRelation =
  | { kind: "unknown" }
  | { kind: "same" }
  | { kind: "forward"; ahead: number }
  | { kind: "rewind"; behind: number }
  | { kind: "diverged"; ahead: number; behind: number };

/** `sha` is the resolved full id (on notFetched, the full id as typed, which the
 *  submodule doesn't have), or null when the read stopped before resolving
 *  the commit: notFound, ambiguous, notACommit, and every arm that blocks ahead
 *  of resolution (notInitialized, unusable, noPointer, midOperation,
 *  submoduleMidOperation, an early checkFailed). `sha` + `pointer` are the
 *  setter's compare-and-swap token. */
export interface SubmodulePickRead {
  sha: string | null;
  commit: SubmoduleRefCommit | null;
  pointer: string | null;
  plan: SubmodulePickPlan;
  relation: SubmodulePickRelation;
  shallow: boolean | null;
}

/** `shallow` is measured after the fetch; null when that read failed. */
export interface SubmoduleFetchResult {
  shallow: boolean | null;
}

export type SubmodulePickUnstaged =
  | "pointerMoved"
  | "stageFailed"
  | "stageUnconfirmed";

export type SubmodulePickOutcome =
  | {
      kind: "set";
      sha: string;
      checkout: SubmodulePickMove;
      nestedLeft: number | null;
    }
  | { kind: "changed" }
  | {
      kind: "blocked";
      why: SubmodulePickBlock;
      reason: string | null;
      paths: string[];
    }
  | { kind: "checkoutFailed"; reason: string }
  | {
      kind: "checkedOutNotStaged";
      sha: string;
      why: SubmodulePickUnstaged;
      reason: string | null;
    }
  /** The checkout landed, then the submodule's HEAD no longer read `sha`.
   *  `pointer` is the staged gitlink read back (null = none recorded); `head`
   *  is HEAD read back (null = the folder no longer holds that checkout, or HEAD
   *  names no commit). Neither null means unreadable. */
  | {
      kind: "movedAfter";
      sha: string;
      pointer: string | null;
      head: string | null;
    }
  /** The checkout landed, but its state couldn't be read back. */
  | { kind: "readBackFailed"; sha: string; reason: string };
