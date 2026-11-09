// The Changes panel's Discard and Stash confirm copy. Its suite loads it through
// the src hooks with no node_modules, so it imports nothing beyond the
// reserved-name, bulk-row-targets and submodule-row modules. The whole-tree
// bodies end with a submodule note while any submodule row is modified on
// either side (a moved commit or only dirty files inside), since both commands
// leave those in place, then warn about any repository that replaced a tracked
// file, which both delete.

import {
  pathHasReservedComponent,
  reservedDeviceName,
} from "../../lib/git/reserved-device-name";
import type { FileEntry } from "../../lib/git/types";
import { leftAloneSentence } from "./bulk-row-targets";
import { repoReplacedFile, submoduleFileOnDisk } from "./submodule-row";

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
      /** Captured at request: rows the action leaves alone, omitted when all
       *  are 0. `conflicted` is Discard-only; `submodules` counts the rows
       *  Discard withholds, or for Stash the rows `submoduleStaysOutOfStash`
       *  names; `embedded` (Stash only) the `embeddedRepoStaysOutOfStash` rows. */
      leftAlone?: {
        hidden: number;
        conflicted: number;
        submodules?: number;
        embedded?: number;
      };
      /** Stash only, captured at request: the repo's `untrackedPathsOf`, which
       *  `submoduleStaysOutOfStash` reads. Absent reads as none. */
      untrackedPaths?: ReadonlySet<string>;
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
 *  includes one, and the menu's file Stash disables on it. Component-wise,
 *  like the backend's exclude, never `isReservedName` (the file name only). */
export function staysOutOfStash(entry: FileEntry): boolean {
  return entry.unstaged === "untracked" && pathHasReservedComponent(entry.path);
}

/** Paths holding an untracked FILE record, for `submoduleStaysOutOfStash`. A
 *  trailing-slash record is a directory (`embeddedRepoStaysOutOfStash`), never
 *  a twin: a staged D beside its kept folder doesn't stash (measured). */
export function untrackedPathsOf(
  entries: readonly FileEntry[],
): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const e of entries)
    if (e.unstaged === "untracked" && !e.path.endsWith("/")) paths.add(e.path);
  return paths;
}

/** Status runs with `--untracked-files=all`, so git ends an untracked path with
 *  `/` only for a folder holding its own repository. A path stash saves nothing
 *  of it (measured), so it stays out like a submodule row. */
export function embeddedRepoStaysOutOfStash(entry: FileEntry): boolean {
  return entry.unstaged === "untracked" && entry.path.endsWith("/");
}

/** A path stash saves nothing for a submodule row whose worktree is a gitlink
 *  or nothing (measured, git 2.51.1: S.M., SC.., S..U, staged A, a file that
 *  became a submodule, and a staged D alone), so no Stash count includes one
 *  and the menu's file Stash disables on it. Two shapes stash: a submodule that
 *  became a file (`worktreeIsGitlink` false over a file still on disk), and a
 *  staged D whose path holds an untracked file (`untrackedPaths`), saving both. */
export function submoduleStaysOutOfStash(
  entry: FileEntry,
  untrackedPaths: ReadonlySet<string>,
): boolean {
  return (
    entry.submodule !== undefined &&
    !submoduleFileOnDisk(entry) &&
    !untrackedPaths.has(entry.path)
  );
}

const NO_PATHS: ReadonlySet<string> = new Set();

/** Appended to a multi-file discard confirm: the recycle bin refuses a reserved
 *  device name, so the backend removes those outright. */
const RESERVED_DISCARD_NOTE =
  ' Files with Windows-reserved names (like "nul") skip the recycle bin and are deleted permanently.';
/** Appended to a stash confirm: git can't remove an untracked reserved device
 *  name, so the backend leaves those files out of the stash. */
const RESERVED_STASH_NOTE =
  ' New files with Windows-reserved names (like "nul") can\'t be stashed and stay in your working tree.';

/** Whether a whole-tree Discard or Stash leaves this submodule row in place:
 *  both keep a moved checkout and its uncommitted files (measured), so any
 *  submodule row modified on either side gets the note, dirty files alone too.
 *  A `repoReplacedFile` row yields: both commands put the file back over it, so
 *  the replaced-file warning owns that row. */
export function submoduleStaysPut(entry: FileEntry): boolean {
  return (
    !repoReplacedFile(entry) &&
    entry.submodule !== undefined &&
    (entry.unstaged === "modified" || entry.staged === "modified")
  );
}

/** Appended to the whole-tree confirms, after any reserved-name note. */
const SUBMODULE_DISCARD_NOTE =
  " Submodules keep the commit they have checked out and any uncommitted files inside. Open a submodule to discard its uncommitted files.";
const SUBMODULE_STASH_NOTE =
  " Submodules keep the commit they have checked out and any uncommitted files inside. Open a submodule to stash its uncommitted files.";

/** Appended to the whole-tree confirms after the submodule note: both commands
 *  delete a repository that replaced a tracked file (`repoReplacedFile`). */
function repoReplacedFileNote(entries: readonly FileEntry[]): string {
  const n = entries.filter(repoReplacedFile).length;
  if (n === 0) return "";
  return n === 1
    ? " 1 repository that replaced a tracked file is deleted with its commits — commit or move it first."
    : ` ${n} repositories that replaced tracked files are deleted with their commits — commit or move them first.`;
}

/** The whole-tree confirms' entries: the live repo's only while the dialog's
 *  repo is the live one, so a dialog left open across a switch describes no
 *  other repo's files. */
export function confirmEntries(
  scopeRepo: string | undefined,
  liveRepo: string,
  liveEntries: readonly FileEntry[],
): readonly FileEntry[] {
  return scopeRepo === liveRepo ? liveEntries : [];
}

/** Withheld submodule rows: Discard never sends one (`submoduleDiscardBlocked`),
 *  and Stash never saves one (`submoduleStaysOutOfStash`). */
function submodulesLeftSentence(n: number): string {
  if (n === 0) return "";
  return n === 1
    ? "1 submodule is left as it is."
    : `${n} submodules are left as they are.`;
}

/** Embedded-repository rows a Stash leaves (`embeddedRepoStaysOutOfStash`). */
function embeddedLeftSentence(n: number): string {
  if (n === 0) return "";
  return n === 1
    ? "1 embedded repository is left as it is."
    : `${n} embedded repositories are left as they are.`;
}

/** What the action leaves alone, as " <sentence>" or "". */
function leftAloneOf(scope: ChangeActionScope): string {
  const left =
    scope?.kind === "files"
      ? [
          leftAloneSentence(
            scope.leftAlone?.hidden ?? 0,
            scope.leftAlone?.conflicted ?? 0,
          ),
          submodulesLeftSentence(scope.leftAlone?.submodules ?? 0),
          embeddedLeftSentence(scope.leftAlone?.embedded ?? 0),
        ]
          .filter((s) => s !== "")
          .join(" ")
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
  const discardSubmoduleNote = repoEntries.some(submoduleStaysPut)
    ? SUBMODULE_DISCARD_NOTE
    : "";
  const discardReplacedNote = repoReplacedFileNote(repoEntries);
  const body = ((): string => {
    switch (true) {
      case scope?.kind === "all":
        return `All uncommitted changes are discarded: tracked files reset to the last commit, untracked files move to the recycle bin.${discardHasReserved ? RESERVED_DISCARD_NOTE : ""}${discardSubmoduleNote}${discardReplacedNote}`;
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

/** The Stash confirm's title and body. `repoEntries` is the whole tree, which
 *  the "all" arm's reserved-name sweep reads, as `discardConfirmCopy` does. */
export function stashConfirmCopy(
  scope: ChangeActionScope,
  repoEntries: readonly FileEntry[],
): {
  title: string;
  body: string;
} {
  const stashFiles = scope?.kind === "files" ? scope.entries : [];
  const stashOne = stashFiles.length === 1 ? stashFiles[0] : null;
  const untracked =
    (scope?.kind === "files" ? scope.untrackedPaths : undefined) ?? NO_PATHS;
  const stashN = stashFiles.filter(
    (e) =>
      !staysOutOfStash(e) &&
      !submoduleStaysOutOfStash(e, untracked) &&
      !embeddedRepoStaysOutOfStash(e),
  ).length;
  const stashLeft = leftAloneOf(scope);
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
  // A whole-tree stash leaves the same files behind, so its note sweeps the
  // repo, and so does its submodule note (after it), as Discard all's does.
  const stashAllReservedNote = repoEntries.some(staysOutOfStash)
    ? RESERVED_STASH_NOTE
    : "";
  const stashAllSubmoduleNote = repoEntries.some(submoduleStaysPut)
    ? SUBMODULE_STASH_NOTE
    : "";
  const stashAllReplacedNote = repoReplacedFileNote(repoEntries);
  const stashFolder = scope?.kind === "files" ? scope.folder : undefined;
  // The file, folder and selection Stash items never offer a path stash with
  // nothing stashable; `stashN === 0` stays as the fallback for any route that
  // still opens one. A reserved-only tree's Stash all is refused by the backend.
  const body =
    scope?.kind === "all"
      ? `Sets your working tree back to the last commit and saves all uncommitted changes — including untracked files — to the stash. "Pop latest stash" restores them.${stashAllReservedNote}${stashAllSubmoduleNote}${stashAllReplacedNote}`
      : stashN === 0
        ? `Nothing will be stashed.${stashReservedNote}`
        : stashFolder !== undefined
          ? `${stashN} file${stashN === 1 ? "" : "s"} in ${stashFolder} ${stashN === 1 ? "is" : "are"} saved to the stash and removed from your working tree. "Pop latest stash" restores ${stashN === 1 ? "it" : "them"}.${stashSplitNote}${stashLeft}${stashReservedNote}`
          : stashOne
            ? `${stashOne.path} is saved to the stash and removed from your working tree. "Pop latest stash" restores it.${stashSplitNote}${stashLeft}${stashReservedNote}`
            : `${stashN} selected file${stashN === 1 ? " is" : "s are"} saved to the stash and removed from your working tree. "Pop latest stash" restores ${stashN === 1 ? "it" : "them"}.${stashSplitNote}${stashLeft}${stashReservedNote}`;
  return { title, body };
}
