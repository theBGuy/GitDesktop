// The Changes panel's Discard and Stash confirm copy. Its suite loads it through
// the src hooks with no node_modules, so it imports nothing beyond the
// reserved-name and bulk-row-targets modules.

import {
  pathHasReservedComponent,
  reservedDeviceName,
} from "../../lib/git/reserved-device-name";
import type { FileEntry } from "../../lib/git/types";
import { leftAloneSentence } from "./bulk-row-targets";

/** Target of a discard/stash confirm dialog: specific files (one row or a
 *  multi-selection) or the whole working tree, with the repo it opened in (the
 *  panel outlives a repo switch, and a confirm answered after one refuses).
 *  `split` (stash only) marks a file whose unselected side or twin goes too,
 *  captured at request time since the selection clears before the dialog's
 *  exit animation ends. Null = no dialog open. */
export type ChangeActionScope =
  | {
      kind: "files";
      entries: FileEntry[];
      repo: string;
      split?: boolean;
      /** Set only by the folder routes: the dialog names this directory. */
      folder?: string;
      /** Captured at request: files the action leaves alone, omitted when both
       *  are 0. `conflicted` is Discard-only; the folder Stash passes 0. */
      leftAlone?: { hidden: number; conflicted: number };
    }
  | { kind: "all"; repo: string }
  | null;

/** The discard-copy predicate: recycle-bin refusal keys on the reserved NAME,
 *  not on stageability. A separate predicate from ChangesPanel's `canStage`, so
 *  the two rules can diverge without silently changing the confirm copy. */
export function isReservedName(entry: FileEntry): boolean {
  return reservedDeviceName(entry.path) !== null;
}

/** The backend leaves an untracked path with a reserved device name in ANY
 *  component out of a path stash (git can't remove it), so no Stash count
 *  includes one. Component-wise like the backend's exclude, not `isReservedName`,
 *  which reads only the file name. */
export function staysOutOfStash(entry: FileEntry): boolean {
  return entry.unstaged === "untracked" && pathHasReservedComponent(entry.path);
}

/** Appended to a multi-file discard confirm: the recycle bin refuses a reserved
 *  device name, so the backend removes those outright. */
const RESERVED_DISCARD_NOTE =
  ' Files with Windows-reserved names (like "nul") skip the recycle bin and are deleted permanently.';
/** Appended to a stash confirm: git can't remove an untracked reserved device
 *  name, so the backend leaves those files out of the stash. */
const RESERVED_STASH_NOTE =
  ' New files with Windows-reserved names (like "nul") can\'t be stashed and stay in your working tree.';

/** What the action leaves alone, as " <sentence>" or "". */
function leftAloneOf(scope: ChangeActionScope): string {
  const left =
    scope?.kind === "files"
      ? leftAloneSentence(
          scope.leftAlone?.hidden ?? 0,
          scope.leftAlone?.conflicted ?? 0,
        )
      : "";
  return left ? ` ${left}` : "";
}

/** The Discard confirm's title and body. `repoEntries` is the whole tree, which
 *  the "all" arm's reserved-name sweep reads: it discards everything, not just
 *  what's on screen. */
export function discardConfirmCopy(
  scope: ChangeActionScope,
  repoEntries: readonly FileEntry[],
): { title: string; body: string } {
  const discardFiles = scope?.kind === "files" ? scope.entries : [];
  const discardOne = discardFiles.length === 1 ? discardFiles[0] : null;
  const title =
    scope?.kind === "all"
      ? "Discard all changes?"
      : discardOne
        ? "Discard changes?"
        : `Discard ${discardFiles.length} changes?`;
  // Only untracked entries reach the recycle bin, so only they can be the ones
  // deleted outright.
  const discardHasReserved = (
    scope?.kind === "all" ? repoEntries : discardFiles
  ).some((e) => e.unstaged === "untracked" && isReservedName(e));
  const discardFolder = scope?.kind === "files" ? scope.folder : undefined;
  const discardLeft = leftAloneOf(scope);
  const body = ((): string => {
    switch (true) {
      case scope?.kind === "all":
        return `All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}`;
      // One target takes the file wording below, even from a folder.
      case discardFolder !== undefined && discardFiles.length >= 2:
        return `Changes to ${discardFiles.length} files in ${discardFolder} will be discarded. Tracked files are restored and untracked files move to the recycle bin.${discardLeft} This cannot be undone.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}`;
      // Per-file discard restores the worktree from the INDEX, so a file with
      // staged changes lands on its staged version, not the last commit.
      case discardOne !== null &&
        discardOne.unstaged !== "untracked" &&
        discardOne.staged !== null:
        return `Unstaged changes to ${discardOne.path} will be discarded, returning it to its staged version. Its staged changes are kept.${discardLeft} This cannot be undone.`;
      case discardOne !== null && discardOne.unstaged !== "untracked":
        return `Unstaged changes to ${discardOne.path} will be restored to the last committed version.${discardLeft} This cannot be undone.`;
      case discardOne !== null && discardHasReserved:
        return `${discardOne.path} is untracked. Its Windows-reserved name can't go to the recycle bin, so it will be deleted permanently.${discardLeft}`;
      case discardOne !== null:
        return `${discardOne.path} is untracked — it will be moved to the recycle bin.${discardLeft}`;
      default:
        return `Changes to ${discardFiles.length} files will be discarded — tracked files are restored and untracked files moved to the recycle bin.${discardLeft} This cannot be undone.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}`;
    }
  })();
  return { title, body };
}

/** The Stash confirm's title and body. */
export function stashConfirmCopy(scope: ChangeActionScope): {
  title: string;
  body: string;
} {
  const stashFiles = scope?.kind === "files" ? scope.entries : [];
  const stashOne = stashFiles.length === 1 ? stashFiles[0] : null;
  const stashN = stashFiles.filter((e) => !staysOutOfStash(e)).length;
  const title =
    scope?.kind === "all"
      ? "Stash all changes?"
      : stashOne
        ? "Stash change?"
        : `Stash ${stashN} change${stashN === 1 ? "" : "s"}?`;
  const stashSplitNote =
    scope?.kind === "files" && scope.split
      ? " A stash takes each file whole, staged and unstaged changes alike."
      : "";
  // The backend leaves these out of a path stash: git can't remove them.
  const stashReservedNote = stashFiles.some(staysOutOfStash)
    ? RESERVED_STASH_NOTE
    : "";
  const stashFolder = scope?.kind === "files" ? scope.folder : undefined;
  // The file, folder and selection Stash items never offer a path stash with
  // nothing stashable; `stashN === 0` stays as the fallback for any route that
  // still opens one. (Stash all explains a reserved-only tree itself.)
  const body =
    scope?.kind === "all"
      ? 'Sets your working tree back to the last commit and saves all uncommitted changes — including untracked files — to the stash. "Pop latest stash" restores them.'
      : stashN === 0
        ? `Nothing will be stashed.${stashReservedNote}`
        : stashFolder !== undefined
          ? `${stashN} file${stashN === 1 ? "" : "s"} in ${stashFolder} ${stashN === 1 ? "is" : "are"} saved to the stash and removed from your working tree. "Pop latest stash" restores ${stashN === 1 ? "it" : "them"}.${stashSplitNote}${leftAloneOf(scope)}${stashReservedNote}`
          : stashOne
            ? `${stashOne.path} is saved to the stash and removed from your working tree. "Pop latest stash" restores it.${stashSplitNote}${stashReservedNote}`
            : `${stashN} selected file${stashN === 1 ? " is" : "s are"} saved to the stash and removed from your working tree. "Pop latest stash" restores ${stashN === 1 ? "it" : "them"}.${stashSplitNote}${stashReservedNote}`;
  return { title, body };
}
