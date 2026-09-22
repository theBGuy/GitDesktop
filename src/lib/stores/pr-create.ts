import { create } from "zustand";
import type { RemoteLens } from "@/lib/git/types";
// Relative and extensioned, not the `@/` alias: `scripts/pr-create-lane.test.mjs`
// imports this module directly under Node's type stripping, which resolves no
// path aliases and no extensionless specifiers. Type-only imports are erased,
// so they may stay aliased.
import { normPath } from "../git/path.ts";

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
 *
 * Two jobs on two clocks: a created entry stops guarding once `guardReleased`
 * flips, and lives on past it purely to hold the list's spot.
 */
export type PrCreate =
  | (PrCreateBase & { phase: "creating" })
  | (PrCreateBase & {
      phase: "created";
      number: number;
      url: string;
      /** The guard half of the lane is done — list containment or the guard
       *  timeout released it. The entry persists only to hold the list spot. */
      guardReleased: boolean;
      /** The owning flow has handed the lane over to its watcher. Until then
       *  the create is still running its post-forge steps, and no DEFERRED
       *  settler may take the entry out from under it. */
      armed: boolean;
    });

/**
 * The held entries a list has caught up to: created, matching that list's lens,
 * and carried by the page it is painting. Empty off the open tab, and empty
 * while the page is PLACEHOLDER data — the deliberate opposite of the strip's
 * hide predicate, which follows whatever is painted. Hiding a strip early costs
 * a frame's cosmetics; DELETING on a previous permutation's placeholder strands
 * the entry when the real page lands without the row.
 */
export function containedHolds(
  creates: PrCreate[],
  rows: { number: number }[] | undefined,
  opts: { open: boolean; lens: RemoteLens; isPlaceholder: boolean },
): PrCreate[] {
  if (!opts.open || opts.isPlaceholder) return [];
  return creates.filter(
    (c) =>
      c.phase === "created" &&
      c.lens === opts.lens &&
      (rows?.some((p) => p.number === c.number) ?? false),
  );
}

/**
 * The settle effect's dependency: membership plus identity plus the ARMED bit,
 * so it fires on a real hand-off rather than on every render, and RE-fires when
 * a contained entry arms — containment can land while the create is still
 * finishing, and the settle no-ops until then. The SPACE is what makes each
 * record injective: a refname cannot contain one and the stamp is digits, so
 * the join cannot alias.
 */
export function containedHoldsKey(holds: PrCreate[]): string {
  return holds
    .map(
      (c) =>
        `${c.head} ${c.startedAt} ${c.phase === "created" && c.armed ? 1 : 0}`,
    )
    .join("|");
}

/** Whether this lane entry still refuses a second create and keeps the
 *  repo-view banner up. A created entry whose guard has been released no
 *  longer blocks — it only holds the list spot. The ONE spelling of that
 *  question: admission, the dialogs' held-submit hints and the banner all
 *  route through it, so none of them can drift from the others. */
export function laneBlocks(entry: PrCreate): boolean {
  return !(entry.phase === "created" && entry.guardReleased);
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
 *  background failure knows not to blank what the user typed. Keyed per HEAD as
 *  well as repo, so a failure on one branch can't preserve its draft in a dialog
 *  opened for another — though CreatePrDialog's two mounts (the Compare and
 *  Pulls tabs, both retained under <Activity>) stay independent here only while
 *  their heads differ; both seed the current branch, so the common case is one
 *  shared key that either mount's read can spend. Two rules bound the set: a
 *  seed retires the key of the draft it destroys, and {@link settlePrCreate}
 *  latches only while the submitting dialog still holds that draft. What gets
 *  past both is one self-consuming entry — a mount torn down mid-flight leaves
 *  one, and the next open for that repo+head spends it, skipping a seed it would
 *  otherwise have run. Only CreatePrDialog latches; see the outcome union on
 *  {@link settlePrCreate}. Not store state: nothing renders it. */
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
 *
 * Only a BLOCKING entry refuses. A guard-released one is REPLACED by the fresh
 * claim, deliberately: it was holding nothing but the previous PR's list spot,
 * and that spot belongs to the create the user just started.
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
  if (blocking && laneBlocks(blocking))
    return LANE_BLOCKED_HINT[blocking.phase](blocking.noun);
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
            guardReleased: false,
            armed: false,
          },
        },
      },
    };
  });
}

/**
 * Ends the GUARD half of one lane: the entry stops refusing a second create and
 * stops the repo-view banner, while staying in the store to hold the list's
 * spot until the list contains the PR (or the hand-off's long-stop fires).
 * Identity-guarded on `startedAt`, so a watcher armed for an earlier create
 * cannot release the one that re-claimed its head. Leaves the
 * {@link consumeLastFailed} latch alone — {@link markPrCreated} already cleared
 * it at the phase flip.
 *
 * REPEAT CALLS ARE EXPECTED: the hand-off fires this on every matching list page
 * for as long as the hold lasts. The already-released arm returning `s` itself
 * is what keeps them render-free — zustand skips the notify on an `Object.is`
 * match, so this is a render-stability invariant rather than an optimization.
 */
export function releasePrCreateGuard(
  repoPath: string,
  head: string,
  startedAt: number,
): void {
  const repo = normPath(repoPath);
  usePrCreateStore.setState((s) => {
    const entry = s.byRepo[repo]?.[head];
    if (
      entry?.phase !== "created" ||
      entry.startedAt !== startedAt ||
      entry.guardReleased
    )
      return s;
    return {
      byRepo: {
        ...s.byRepo,
        [repo]: {
          ...s.byRepo[repo],
          [head]: { ...entry, guardReleased: true },
        },
      },
    };
  });
}

/**
 * Marks the owning flow done with the lane: its post-forge steps have finished
 * and it has handed over to the hand-off watcher, so the DEFERRED settlers may
 * act. Identity-guarded and repeat-safe exactly like
 * {@link releasePrCreateGuard} — the already-armed arm returns the same state
 * object, so a repeat notifies nobody.
 */
export function markPrCreateArmed(
  repoPath: string,
  head: string,
  startedAt: number,
): void {
  const repo = normPath(repoPath);
  usePrCreateStore.setState((s) => {
    const entry = s.byRepo[repo]?.[head];
    if (
      entry?.phase !== "created" ||
      entry.startedAt !== startedAt ||
      entry.armed
    )
      return s;
    return {
      byRepo: {
        ...s.byRepo,
        [repo]: { ...s.byRepo[repo], [head]: { ...entry, armed: true } },
      },
    };
  });
}

/**
 * Releases the lane. The outcome says what the caller owes
 * {@link consumeLastFailed}, and who may speak for it at all:
 * - `"error"` latches, so a reopen after a failure the user never saw keeps
 *   their draft. CreatePrDialog's form is the only draft this protects, which
 *   makes it the caller's job to have one: it settles a failure as `"error"`
 *   only while its form still holds the draft it submitted, and as `"release"`
 *   otherwise — a latch minted over a destroyed draft is one nothing consumes.
 * - `"success"` belongs to the deferred settlers — the pulls panel, whose page
 *   is the one the strip sits in, and `pr-create-handoff` for closed evidence
 *   and the long stop — and reaches them only through
 *   {@link settlePrCreateIfCurrent}: the lane ends when the list contains the
 *   PR, not when the forge answers. It clears the latch, as
 *   {@link markPrCreated} already did at the phase flip, so the outcome stays
 *   meaningful for any caller that could reach it without one.
 * - `"release"` is for a lane holder with no draft to protect —
 *   PromoteLocalPrDialog's failed-before-create path, and CreatePrDialog's own
 *   failure once a seed has taken its draft. It only frees the entry, leaving
 *   any other latch standing.
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

/** Settles a lane as `"success"`, but only while the entry is still the one the
 *  caller claimed AND its owning flow has armed it. Every DEFERRED settle goes
 *  through here — panel containment, the watcher's closed evidence, the long
 *  stop — and none of them may preempt a create still running its post-forge
 *  steps, which would reopen admission mid-continuation and let a reopened
 *  dialog start a second create on the same head. {@link settlePrCreate} itself
 *  stays ungated: the flow's own error/release paths speak for themselves. */
export function settlePrCreateIfCurrent(
  repoPath: string,
  head: string,
  startedAt: number,
): void {
  const entry = usePrCreateStore.getState().byRepo[normPath(repoPath)]?.[head];
  if (!entry || entry.startedAt !== startedAt) return;
  if (entry.phase !== "created" || !entry.armed) return;
  settlePrCreate(repoPath, head, "success");
}

/** The lane's phase for this exact head, null when there is none. A FIRE-TIME
 *  read: call it where a decision is made, never to decide what a component
 *  paints — use {@link usePrCreatePhase} or {@link usePrCreates} for render.
 *  Unlike those, it reports an ENTRY's phase whether or not it still blocks; an
 *  admission decision reads {@link laneBlocks}, not this. */
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

/** Reads and clears the failed-create latch for one repo+head: the read a reopen
 *  makes, and the retire a seed makes for the draft it is about to destroy. Key
 *  it to the repo the DRAFT belongs to — a dialog retained across a repo switch
 *  holds the previous repo's head, and asking under the live repo would spend a
 *  latch that was never formed for it. */
export function consumeLastFailed(repoPath: string, head: string): boolean {
  return lastFailed.delete(failKey(repoPath, head));
}

/** Every lane entry for one repo, oldest first — guard-released holds included,
 *  since the list strip is what they exist for. A surface that speaks for the
 *  GUARD filters on {@link laneBlocks}. */
export function usePrCreates(repoPath: string): PrCreate[] {
  const entries = usePrCreateStore((s) => s.byRepo[normPath(repoPath)]);
  if (!entries) return NO_CREATES;
  return Object.values(entries).sort((a, b) => a.startedAt - b.startedAt);
}

/** Render twin of the ADMISSION read, not of entry existence: a non-null phase
 *  means a create still OWNS this head, so a guard-released entry reads null
 *  here even though it is still in the store holding the list's spot. */
export function usePrCreatePhase(
  repoPath: string,
  head: string | undefined,
): "creating" | "created" | null {
  return usePrCreateStore((s) => {
    const entry = head ? s.byRepo[normPath(repoPath)]?.[head] : undefined;
    return entry && laneBlocks(entry) ? entry.phase : null;
  });
}
