// Runtime-import-free on purpose: scripts/conflict-banner-state.test.mjs loads this module
// under Node's type stripping, which resolves no path aliases. The statement-level
// type imports below are erased; an inline `import { type … }` would not be.
import type { RepoOp, RepoOpState } from "@/lib/git/types";
import type { StashReapplyMarker } from "@/lib/stores/stash-reapply-marker";

/** "update from master" / "pull" / "rebase onto main" / "switch to feature/x" —
 *  shared by the banner tail ("The {opPhrase} finished.") and the confirm body
 *  ("saved before the {opPhrase}"). */
export function opPhrase(
  m: Pick<
    StashReapplyMarker,
    "operationLabel" | "detail" | "detailPreposition"
  >,
): string {
  if (!m.detail) return m.operationLabel;
  return `${m.operationLabel} ${m.detailPreposition ?? "from"} ${m.detail}`;
}

export type StashBannerState =
  /** Render exactly what renders without a marker. */
  | { kind: "none" }
  | { kind: "conflicted"; lead: string; tail: string }
  | { kind: "resolved"; lead: string; tail: string; announcement: string };

/** The `RepoOpState` flags that name an operation. Derived, so a renamed field
 *  breaks here; `editPaused` is excluded because it modifies `rebasing` rather
 *  than naming an op of its own. */
type RepoOpFlag = Exclude<keyof RepoOpState, "editPaused">;

/** Which op the banner names. `RepoOpState`'s flags are independent booleans and
 *  the banner shows one op, so the precedence lives here rather than in a
 *  ternary chain that has to be re-read every time an op is added. */
const OP_BY_FLAG: readonly (readonly [RepoOpFlag, RepoOp])[] = [
  ["merging", "merge"],
  ["rebasing", "rebase"],
  ["cherryPicking", "cherry-pick"],
  ["reverting", "revert"],
];

/** Kept beside the deriver, whose `opActive` input it feeds, so the pure suite
 *  pins its precedence. */
export function activeRepoOp(opState: RepoOpState | undefined): RepoOp | null {
  return OP_BY_FLAG.find(([flag]) => opState?.[flag])?.[1] ?? null;
}

const RESOLVED_TAIL =
  "Drop the backup stash if your changes look right, or keep it in View stashes.";

const NONE = { state: { kind: "none" }, clearMarker: false } as const;

/** What the conflict banner says about a recorded stash reapply. Every
 *  marker-derived decision reads only status and stash-count data stamped after
 *  the marker (`> recordedAt`): before that the cached reads are pre-compound, so
 *  a 0 stash count would clear the marker at once and 0 conflicts would flash
 *  the Drop offer. */
export function deriveStashBannerState(args: {
  marker: StashReapplyMarker | null;
  repoPath: string;
  opActive: boolean;
  conflictedCount: number;
  /** useRepoStatus(repo).dataUpdatedAt (0 = never fetched). */
  statusUpdatedAt: number;
  stashCount: number | undefined;
  stashCountUpdatedAt: number;
}): { state: StashBannerState; clearMarker: boolean } {
  const { marker, conflictedCount: n } = args;
  // The store's own repoPath subscription clears a foreign marker.
  if (!marker || marker.repoPath !== args.repoPath) return NONE;
  const countFresh = args.stashCountUpdatedAt > marker.recordedAt;
  // Nothing left to offer or explain once the stash list is empty.
  if (countFresh && args.stashCount === 0) {
    return { state: { kind: "none" }, clearMarker: true };
  }
  if (args.opActive) return NONE;
  const statusFresh = args.statusUpdatedAt > marker.recordedAt;
  if (!statusFresh) return NONE;
  if (n > 0) {
    return {
      state: {
        kind: "conflicted",
        lead: `Reapplying your stashed changes · ${n} conflict${n === 1 ? "" : "s"}`,
        tail: `The ${opPhrase(marker)} finished. Resolve ${n === 1 ? "it" : "them"} in the changes list; your changes are also kept in a backup stash.`,
      },
      clearMarker: false,
    };
  }
  if (!countFresh || args.stashCount === undefined || args.stashCount <= 0) {
    return NONE;
  }
  return {
    state: {
      kind: "resolved",
      lead: "Reapplying your stashed changes · all conflicts resolved",
      tail: RESOLVED_TAIL,
      announcement: `All conflicts resolved. ${RESOLVED_TAIL}`,
    },
    clearMarker: false,
  };
}
