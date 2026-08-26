import { create } from "zustand";
import { normPath } from "@/lib/git/path";

/** A pull-request creation the app is still waiting on. */
export interface PrCreate {
  /** The head branch being pushed and proposed. */
  head: string;
  /** What it is being proposed against, as the dialog spelled it. */
  base: string;
  /** Epoch ms the create started. */
  startedAt: number;
}

interface PrCreateState {
  /** repoPath → head branch → the create in flight. The repo key is ALWAYS a
   *  {@link normPath} spelling, applied at every entry point, so a writer
   *  holding git's spelling and a reader holding the ui store's land in the
   *  same bucket. Keyed by repo so a repo switch reads an empty set rather than
   *  another repo's creates, and by head because that is what a duplicate would
   *  collide on: two creates for DIFFERENT heads in one repo are fine — they
   *  queue on the per-repo git lock and each opens its own PR. */
  byRepo: Record<string, Record<string, PrCreate>>;
}

const NO_CREATES: PrCreate[] = [];

export const usePrCreateStore = create<PrCreateState>()(() => ({
  byRepo: {},
}));

/** Repo+head pairs whose most recent create FAILED. Read once and cleared by
 *  {@link consumeLastFailed}: it exists only so the dialog that reopens after a
 *  background failure knows not to blank what the user typed. Per HEAD, not per
 *  repo — a failure on one branch must not preserve its draft in a dialog the
 *  user opened for another. The lane has several writers but only CreatePrDialog
 *  holds a draft this can protect, so it is the only one that latches; see the
 *  outcome union on {@link settlePrCreate}. Not store state: nothing renders it. */
const lastFailed = new Set<string>();

// NUL is the one separator neither a path nor a ref name can contain, so
// ("a b", "c") and ("a", "b c") can't share a key — the same join
// worktree-removal uses for its listener keys.
const failKey = (repoPath: string, head: string) =>
  `${normPath(repoPath)}\u0000${head}`;

/**
 * Claims the lane for one head branch. Returns null once claimed, or the reason
 * it was refused. Call this SYNCHRONOUSLY before the first await: a `git push`
 * plus `gh pr create` runs for minutes behind a closed dialog, and a second
 * attempt on the same head would only queue on the repo lock and then open a
 * duplicate PR.
 */
export function startPrCreate(
  repoPath: string,
  head: string,
  base: string,
): string | null {
  const repo = normPath(repoPath);
  if (usePrCreateStore.getState().byRepo[repo]?.[head])
    return "A pull request for this branch is already being created.";
  usePrCreateStore.setState((s) => ({
    byRepo: {
      ...s.byRepo,
      [repo]: {
        ...s.byRepo[repo],
        [head]: { head, base, startedAt: Date.now() },
      },
    },
  }));
  return null;
}

/**
 * Releases the lane. The outcome says what the caller owes
 * {@link consumeLastFailed}, and only a caller that owns a preservable draft may
 * speak for it:
 * - `"error"` latches, so a reopen after a failure the user never saw keeps
 *   their draft. CreatePrDialog's form is the only draft this protects.
 * - `"success"` clears, because a stale flag from an older failure would skip a
 *   legitimate reset later — and once the branch has a PR the point is moot.
 * - `"release"` is for a lane holder with no draft to protect. It only frees the
 *   entry, leaving an earlier create's latch standing.
 */
export function settlePrCreate(
  repoPath: string,
  head: string,
  outcome: "success" | "error" | "release",
): void {
  if (outcome === "error") lastFailed.add(failKey(repoPath, head));
  else if (outcome === "success") lastFailed.delete(failKey(repoPath, head));
  const repo = normPath(repoPath);
  usePrCreateStore.setState((s) => {
    const entries = s.byRepo[repo];
    if (!entries?.[head]) return s;
    const { [head]: _settled, ...rest } = entries;
    const { [repo]: _emptied, ...otherRepos } = s.byRepo;
    return {
      byRepo:
        Object.keys(rest).length > 0
          ? { ...s.byRepo, [repo]: rest }
          : otherRepos,
    };
  });
}

/** True while a create for this exact head is in flight. A FIRE-TIME check:
 *  call it where a decision is made, never to decide what a component paints —
 *  use {@link useIsCreatingPr} or {@link usePrCreates} for render. */
export function isCreatingPrFor(repoPath: string, head: string): boolean {
  return Boolean(
    usePrCreateStore.getState().byRepo[normPath(repoPath)]?.[head],
  );
}

/** Reads and clears the failed-create latch for one repo+head. */
export function consumeLastFailed(repoPath: string, head: string): boolean {
  return lastFailed.delete(failKey(repoPath, head));
}

/** The creates in flight for one repo, oldest first. */
export function usePrCreates(repoPath: string): PrCreate[] {
  const entries = usePrCreateStore((s) => s.byRepo[normPath(repoPath)]);
  if (!entries) return NO_CREATES;
  return Object.values(entries).sort((a, b) => a.startedAt - b.startedAt);
}

/** True while a pull request for this exact head branch is being created. */
export function useIsCreatingPr(
  repoPath: string,
  head: string | undefined,
): boolean {
  return usePrCreateStore((s) =>
    Boolean(head && s.byRepo[normPath(repoPath)]?.[head]),
  );
}
