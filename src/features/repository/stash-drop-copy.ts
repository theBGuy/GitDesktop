// Outcome copy for the SHA-verified stash drop, shared by the conflict banner's
// backup drop and View stashes' Drop. Import-free: scripts/stash-drop-copy.test.mjs
// imports it straight from src/ under Node's type stripping.

/** Where a drop ran: the conflict banner's backup offer, or View stashes. */
export type StashDropSurface = "banner" | "dialog";

/** Nothing was dropped. Stays true after a raced drop was stored back on top:
 *  the target survives, only the slots shift. */
export const STASH_DROP_MOVED = "The stash list changed — nothing was dropped.";

/** The sha is no longer listed. Only the banner's population is a backup stash. */
export const STASH_DROP_GONE: Record<StashDropSurface, string> = {
  banner: "The backup stash is already gone, so there was nothing to drop.",
  dialog: "That stash is already gone, so there was nothing to drop.",
};

/** A raced drop took a different entry and storing it back failed. */
export const stashDropRestoreFailed = (droppedSha: string) =>
  `The stash list changed — a different stash (${droppedSha.slice(0, 7)}) was dropped and couldn't be restored. Recover it under View stashes → Recoverable.`;
