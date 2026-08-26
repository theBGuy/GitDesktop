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
  /** repoPath → head branch → the create in flight. Keyed by repo so a repo
   *  switch reads an empty set rather than another repo's creates, and by head
   *  because that is what a duplicate would collide on: two creates for
   *  DIFFERENT heads in one repo are fine — they queue on the per-repo git lock
   *  and each opens its own PR. */
  byRepo: Record<string, Record<string, PrCreate>>;
}

const NO_CREATES: PrCreate[] = [];

export const usePrCreateStore = create<PrCreateState>()(() => ({
  byRepo: {},
}));

/** Repos whose most recent create FAILED, keyed by {@link normPath}. Read once
 *  and cleared by {@link consumeLastFailed}: it exists only so the dialog that
 *  reopens after a background failure knows not to blank what the user typed.
 *  Deliberately not store state — nothing renders from it. */
const lastFailed = new Set<string>();

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
  if (usePrCreateStore.getState().byRepo[repoPath]?.[head])
    return "A pull request for this branch is already being created.";
  usePrCreateStore.setState((s) => ({
    byRepo: {
      ...s.byRepo,
      [repoPath]: {
        ...s.byRepo[repoPath],
        [head]: { head, base, startedAt: Date.now() },
      },
    },
  }));
  return null;
}

/** Releases the lane. An "error" outcome latches {@link consumeLastFailed} so a
 *  reopen after a failure the user never saw keeps their draft. */
export function settlePrCreate(
  repoPath: string,
  head: string,
  outcome: "success" | "error",
): void {
  // Success clears the latch as well as setting it on failure: a stale flag left
  // by an older failure would skip a legitimate reset days later, on any branch.
  if (outcome === "error") lastFailed.add(normPath(repoPath));
  else lastFailed.delete(normPath(repoPath));
  usePrCreateStore.setState((s) => {
    const repo = s.byRepo[repoPath];
    if (!repo?.[head]) return s;
    const { [head]: _settled, ...rest } = repo;
    const { [repoPath]: _emptied, ...otherRepos } = s.byRepo;
    return {
      byRepo:
        Object.keys(rest).length > 0
          ? { ...s.byRepo, [repoPath]: rest }
          : otherRepos,
    };
  });
}

/** True while ANY create is in flight for this repo. A FIRE-TIME check: call it
 *  where a decision is made, never to decide what a component paints — use
 *  {@link useIsCreatingPr} or {@link usePrCreates} for render. */
export function isCreatingPrInRepo(repoPath: string): boolean {
  const entries = usePrCreateStore.getState().byRepo[repoPath];
  return entries !== undefined && Object.keys(entries).length > 0;
}

/** Reads and clears the failed-create latch for one repo. */
export function consumeLastFailed(repoPath: string): boolean {
  return lastFailed.delete(normPath(repoPath));
}

/** The creates in flight for one repo, oldest first. */
export function usePrCreates(repoPath: string): PrCreate[] {
  const entries = usePrCreateStore((s) => s.byRepo[repoPath]);
  if (!entries) return NO_CREATES;
  return Object.values(entries).sort((a, b) => a.startedAt - b.startedAt);
}

/** True while a pull request for this exact head branch is being created. */
export function useIsCreatingPr(
  repoPath: string,
  head: string | undefined,
): boolean {
  return usePrCreateStore((s) => Boolean(head && s.byRepo[repoPath]?.[head]));
}
