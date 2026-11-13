// The words the delete toasts, the Restore outcomes and their follow-ups show.
// `away` is `landedIn(repo).away`, read after the await that settled the work.

/** How long a delete toast offering Restore stays up. */
export const DELETED_TOAST_MS = 15_000;

export const shortTip = (tip: string) => tip.slice(0, 7);

const branchCount = (n: number) => `${n} ${n === 1 ? "branch" : "branches"}`;

export const DELETE_CONFIRM_RESTORABLE =
  " The branch can be restored from Recover lost work.";

export const deletedBranchTitle = (name: string, tip: string, away: string) =>
  `Deleted ${name} (was ${shortTip(tip)})${away}`;

export const DELETE_TIP_MOVED = (name: string) =>
  `${name} changed while it was being deleted — nothing was deleted.`;

/** The note a delete toast carries when its record couldn't be written. The
 *  single delete's title names the commit; a batch's doesn't. */
export const unrecordedNote = (
  unrecorded: number,
  total: number,
  single: boolean,
): string => {
  if (single)
    return "Couldn't add it to Recover lost work. Restore it from this notice, or re-create it from the commit above.";
  if (unrecorded === 1 && total === 1)
    return "Couldn't add it to Recover lost work. Restore it from this notice.";
  return `Couldn't add ${unrecorded} of them to Recover lost work. Restore them from this notice.`;
};

export const restoreActionLabel = (count: number) =>
  count === 1 ? "Restore" : "Restore all";

export const restoredTitle = (name: string, away: string) =>
  `Restored ${name}${away}`;

/** The restored toast's description parts that apply, or undefined. */
export const restoredDescription = (
  keptLocal: boolean,
  upstream: string | null,
): string | undefined => {
  const parts: string[] = [];
  if (keptLocal) parts.push("Keep local is on again.");
  if (upstream !== null)
    parts.push(`Its upstream link to ${upstream} wasn't restored.`);
  return parts.length > 0 ? parts.join(" ") : undefined;
};

export const couldntRestoreTitle = (name: string, away: string) =>
  `Couldn't restore ${name}${away}`;

export const NAME_EXISTS_DESCRIPTION =
  "A branch with that name exists again, and nothing was overwritten. Rename or delete it, then restore from Recover lost work.";

// The follow-ups' variants while an unrecorded entry's delete notice stays
// open: Recover lost work doesn't list that entry, so they point at the notice.
export const NAME_EXISTS_NOTICE_OPEN =
  "A branch with that name exists again, and nothing was overwritten. Rename or delete it, then press Restore on the delete notice, which stays open.";

export const prunedDescription = (tip: string) =>
  `Git has already removed its commit (${shortTip(tip)}), so it can no longer be restored.`;

/** A recorded tip that isn't a full object id; no git call is made. */
export const UNREADABLE_RECORDED_TIP =
  "The recorded commit isn't a full commit id, so it can't be restored safely.";

export const restoreFailedNote = (name: string, away: string) =>
  `${name} wasn't restored${away}.`;

export const restoreFailedNoticeOpenNote = (name: string, away: string) =>
  `${restoreFailedNote(name, away)} Its delete notice stays open so you can retry.`;

export const restoredAllTitle = (total: number, away: string) =>
  `Restored ${branchCount(total)}${away}`;

export const RESTORED_ALL_UPSTREAMS = "Upstream links weren't restored.";

export const restoredSomeTitle = (n: number, total: number, away: string) =>
  n > 0
    ? `Restored ${n} of ${total} branches${away}`
    : `Couldn't restore ${branchCount(total)}${away}`;

/** Why a Restore all entry wasn't restored, keyed by its outcome. */
export const UNRESTORED_REASON: Record<
  "nameExists" | "pruned" | "failed",
  (k: number) => string
> = {
  nameExists: (k) => `a branch with that name exists again (${k})`,
  pruned: (k) => `Git has removed the commit (${k})`,
  failed: (k) => `Git refused (${k})`,
};

export const unrestoredDescription = (failed: number, reasons: string) =>
  `${failed} couldn't be restored: ${reasons}. They're still listed in Recover lost work.`;

export const unrestoredNoticeOpenDescription = (
  failed: number,
  reasons: string,
) =>
  `${failed} couldn't be restored: ${reasons}. The delete notice stays open so you can retry.`;

// Clean up branches (delete mode).

/** The confirm's restorable tail, replacing "This can't be undone." */
export const cleanupRestorableTail = (
  count: number,
  removedWorktrees: string | null,
): string => {
  if (removedWorktrees !== null)
    return ` The ${count === 1 ? "branch" : "branches"} can be restored from Recover lost work; the removed ${removedWorktrees} can't.`;
  return count === 1
    ? " It can be restored from Recover lost work."
    : " They can be restored from Recover lost work.";
};

export const skippedMoved = (name: string) =>
  `Skipped ${name} — it changed since this list loaded, so it was kept.`;

// Row reasons read after "Couldn't delete: ": lowercase, no period.
/** The tips read answered without this branch. */
export const NOT_LISTED_REASON = "git no longer lists this branch";
/** The listed value isn't a full object id, so no delete can be pinned to it. */
export const UNREADABLE_LISTED_TIP_REASON =
  "this list couldn't read its commit — close and reopen Clean up branches";

export const TIPS_READ_FAILED_STATUS =
  "Couldn't read the listed branches' commits, so nothing can be deleted yet.";
export const TIPS_READ_FAILED_HELD =
  "Couldn't read the listed branches' commits. Retry the read to delete.";

// Recover lost work (the Stashes dialog's recoverable view).

export const RECOVER_TITLE = "Recover lost work";
export const RECOVER_DESCRIPTION =
  "Branches you deleted in GitDesktop, and lost uncommitted work that fell out of the stash list. Restoring a branch re-creates it without checking it out; restoring a stash re-applies it to the working tree.";
export const DELETED_BRANCHES_CAPTION = "Deleted branches";
export const LOST_STASHES_CAPTION = "Lost stashes";
export const DELETED_BRANCHES_EMPTY =
  "No deleted branches. Branches you delete in GitDesktop are listed here so you can restore them.";
/** Read as "Loading deleted branches…" by ListRowSkeletons. */
export const DELETED_BRANCHES_LOADING_NAME = "deleted branches";
export const DELETED_BRANCHES_READ_FAILED = "Couldn't load deleted branches.";
export const PRUNED_ROW_NOTE =
  "Can't be restored — Git has removed this commit.";
export const RESTORE_BRANCH_LABEL = "Restore branch";
export const REMOVE_FROM_LIST_LABEL = "Remove from list";
export const nameExistsHeld = (name: string) =>
  `A branch named ${name} exists again. Rename or delete it to restore this one.`;
export const RESTORE_RUNNING_HELD = "A restore is already running.";
export const REMOVING_HELD = "Removing it from the list.";
export const removeFailedTitle = (name: string) =>
  `Couldn't remove ${name} from the list.`;
