export interface StashEntry {
  index: number;
  message: string;
  date: string;
}

export interface StashFile {
  path: string;
  added: number;
  deleted: number;
  isBinary: boolean;
  /** In the stash's untracked-files parent; its content reads from there. */
  untracked: boolean;
}

/** A dangling/orphaned stash commit found via `git fsck` — lost uncommitted work
 *  that fell out of `git stash list` (e.g. abandoned by an interrupted op).
 *  Addressed by its raw `sha` since it has no `stash@{n}` slot. */
export interface OrphanedStash {
  sha: string;
  message: string;
  date: string;
  fileCount: number;
}
