import type { BranchMergeState } from "@/lib/git/api";
import type { LocalPr } from "./local";

// Pure on purpose: scripts/local-pr-reconcile.test.mjs imports this file straight
// under Node's type stripping, which resolves no aliases, so imports stay type-only.

/** What git says a merge-states row means for its open local PR, if anything. A
 *  deleted head closes the PR: a merge can't be verified once the branch is gone. */
export function reconcileVerdict(
  state: BranchMergeState,
): "merged" | "closed" | null {
  if (state.merged) return "merged";
  if (!state.headExists) return "closed";
  return null;
}

/** The once-per-evaluation key. It carries the head and base, so a PR a rename
 *  migrated is evaluated again under its new branches instead of skipped. */
export function reconcileKey(pr: Pick<LocalPr, "id" | "base" | "head">) {
  return `${pr.id}:${pr.base}:${pr.head}`;
}

/** Compare-and-set over the FRESH record: the verdict lands only while `cur` is
 *  still open on the `head` and `base` the merge-states read was made for. A
 *  rename that migrated the PR between that read and this write keeps it open. */
export function applyReconcileVerdict(
  cur: LocalPr,
  read: Pick<LocalPr, "base" | "head">,
  verdict: "merged" | "closed",
  now: string,
): LocalPr {
  if (cur.status !== "open" || cur.head !== read.head || cur.base !== read.base)
    return cur;
  if (verdict === "merged")
    return { ...cur, status: "merged", mergedAt: cur.mergedAt ?? now };
  return { ...cur, status: "closed" };
}
