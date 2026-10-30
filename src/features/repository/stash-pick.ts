// View stashes' selection over the live stash list. Import-free apart from a
// type-only import: scripts/stash-pick.test.mjs imports it straight from src/
// under Node's type stripping.
import type { StashEntry } from "@/lib/git/types";

/** A picked stash: the sha is its identity; the index is the slot it was picked
 *  at, which tells duplicate rows of one commit apart and is where the selection
 *  lands once that sha is gone. */
export interface StashPick {
  sha: string;
  index: number;
}

/** Two slots can hold the same commit, so a row is keyed by both. */
export const stashRowKey = (stash: Pick<StashEntry, "sha" | "index">) =>
  `${stash.sha}:${stash.index}`;

/** The row picked exactly; else the first row holding the picked sha (the stack
 *  shifted under it); else the row now at its slot, clamped to the last; the
 *  newest with no pick; null for an empty list. */
export function resolveStashPick<T extends Pick<StashEntry, "sha" | "index">>(
  list: readonly T[],
  pick: StashPick | null,
): T | null {
  if (list.length === 0) return null;
  if (pick === null) return list[0];
  return (
    list.find((s) => s.sha === pick.sha && s.index === pick.index) ??
    list.find((s) => s.sha === pick.sha) ??
    list[Math.min(pick.index, list.length - 1)]
  );
}
