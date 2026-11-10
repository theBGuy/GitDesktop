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
