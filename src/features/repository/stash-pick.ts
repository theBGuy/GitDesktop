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

/** A row's identity: its sha plus its current slot, since two slots can hold the
 *  same commit. The highlight, `data-stash` and keyboard nav read it; it shifts
 *  with the stack, so it is not the row's React key (see stashRowReactKeys). */
export const stashRowKey = (stash: Pick<StashEntry, "sha" | "index">) =>
  `${stash.sha}:${stash.index}`;

/** Each row's React key, by list position: `${sha}#${n}`, where n counts the
 *  earlier rows holding the same sha. A stack shift moves the slots but not the
 *  keys, so a focused row keeps its DOM node; only a row of the same sha appearing
 *  or leaving above it re-keys it. */
export function stashRowReactKeys(
  list: readonly Pick<StashEntry, "sha">[],
): string[] {
  const seen = new Map<string, number>();
  return list.map((stash) => {
    const n = seen.get(stash.sha) ?? 0;
    seen.set(stash.sha, n + 1);
    return `${stash.sha}#${n}`;
  });
}

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
