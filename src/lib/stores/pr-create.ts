import { create } from "zustand";
import { normPath } from "@/lib/git/path";
import type { RemoteLens } from "@/lib/git/types";

/** What every lane entry carries, whatever phase it is in. */
interface PrCreateBase {
  /** The head branch being pushed and proposed. */
  head: string;
  /** What it is being proposed against, as the dialog spelled it. */
  base: string;
  /** Epoch ms the create started. */
  startedAt: number;
  /** The dialog's title, already trimmed — the spelling the forge was sent. */
  title: string;
  draft: boolean;
  /** Which list this create lands in. A bare number is only valid under the
   *  lens that produced it, so every surface reading this entry filters on it. */
  lens: RemoteLens;
  /** The provider's noun, recorded at claim time so the banner and the list
   *  strip read ONE source rather than each re-deriving it from forge status. */
  noun: "pull request" | "merge request";
}

/**
 * A pull-request creation the app is still waiting on. Discriminated on
 * `phase`: the lane deliberately outlives the forge's answer, and `"created"`
 * — the window where the list has yet to show the PR — is the only phase that
 * HAS a number, so no reader has to defend against a missing one.
 */
export type PrCreate =
  | (PrCreateBase & { phase: "creating" })
  | (PrCreateBase & { phase: "created"; number: number; url: string });

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

/** Why a head branch is blocked, per the phase of the lane holding it — one
 *  source for both readings of that fact: {@link startPrCreate}'s fire-time
 *  refusal toast, and the inline hint a dialog shows beside its held submit.
 *  The caller supplies the noun — the blocking lane's own at
 *  {@link startPrCreate}, the dialog's own at a held-submit hint — identical
 *  for a repo, since both read its forge provider. */
export const LANE_BLOCKED_HINT: Record<
  PrCreate["phase"],
  (noun: string) => string
> = {
  creating: (noun) => `A ${noun} for this branch is already being created.`,
  created: (noun) => `A ${noun} for this branch was just created.`,
};

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
  display: {
    title: string;
    draft: boolean;
    lens: RemoteLens;
    noun: PrCreate["noun"];
  },
): string | null {
  const repo = normPath(repoPath);
  const blocking = usePrCreateStore.getState().byRepo[repo]?.[head];
  if (blocking) return LANE_BLOCKED_HINT[blocking.phase](blocking.noun);
  usePrCreateStore.setState((s) => ({
    byRepo: {
      ...s.byRepo,
      [repo]: {
        ...s.byRepo[repo],
        [head]: {
          head,
          base,
          startedAt: Date.now(),
          ...display,
          phase: "creating",
        },
      },
    },
  }));
  return null;
}

/**
 * Flips `creating` → `created` and records the forge's answer. The lane lives on
 * past this point — until the list actually shows the PR — so this, not the
 * settle, is where a create is known to have succeeded: it clears the
 * {@link consumeLastFailed} latch. No-op once the entry is gone.
 */
export function markPrCreated(
  repoPath: string,
  head: string,
  result: { number: number; url: string },
): void {
  const repo = normPath(repoPath);
  if (!usePrCreateStore.getState().byRepo[repo]?.[head]) return;
  lastFailed.delete(failKey(repoPath, head));
  usePrCreateStore.setState((s) => {
    const entry = s.byRepo[repo]?.[head];
    if (!entry) return s;
    return {
      byRepo: {
        ...s.byRepo,
        [repo]: {
          ...s.byRepo[repo],
          [head]: {
            ...entry,
            phase: "created",
            number: result.number,
            url: result.url,
          },
        },
      },
    };
  });
}

/**
 * Releases the lane. The outcome says what the caller owes
 * {@link consumeLastFailed}, and who may speak for it at all:
 * - `"error"` latches, so a reopen after a failure the user never saw keeps
 *   their draft. CreatePrDialog's form is the only draft this protects, and
 *   that failure is the ONLY outcome either dialog settles.
 * - `"success"` belongs to the hand-off watcher alone (`pr-create-handoff`, or
 *   its timeout): the lane ends when the list contains the PR, not when the
 *   forge answers. It clears the latch, as {@link markPrCreated} already did at
 *   the phase flip, so the outcome stays meaningful for any caller that could
 *   reach it without one.
 * - `"release"` is for a lane holder with no draft to protect —
 *   PromoteLocalPrDialog's failed-before-create path. It only frees the entry,
 *   leaving an earlier create's latch standing.
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

/** The lane's phase for this exact head, null when there is none. A FIRE-TIME
 *  read: call it where a decision is made, never to decide what a component
 *  paints — use {@link usePrCreatePhase} or {@link usePrCreates} for render. */
export function prCreatePhase(
  repoPath: string,
  head: string,
): "creating" | "created" | null {
  return (
    usePrCreateStore.getState().byRepo[normPath(repoPath)]?.[head]?.phase ??
    null
  );
}

/** The lane entry's own start stamp, null when there is none. It is the
 *  hand-off watcher's identity axis: a watcher armed for one create must never
 *  settle a LATER create that re-claimed the same head. */
export function prCreateStartedAt(
  repoPath: string,
  head: string,
): number | null {
  return (
    usePrCreateStore.getState().byRepo[normPath(repoPath)]?.[head]?.startedAt ??
    null
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

/** Render twin of {@link prCreatePhase}. A non-null phase IS the lane's
 *  existence, so this is also the render-time "a create owns this head" read. */
export function usePrCreatePhase(
  repoPath: string,
  head: string | undefined,
): "creating" | "created" | null {
  return usePrCreateStore(
    (s) => (head ? s.byRepo[normPath(repoPath)]?.[head]?.phase : null) ?? null,
  );
}
