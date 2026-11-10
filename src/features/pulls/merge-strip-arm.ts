// Which line the merge strip under an open PR's header shows. Import-free (the
// type-only imports are erased) so scripts/merge-strip-arm.test.mjs and
// scripts/local-merge-strip-arm.test.mjs load it under Node's type stripping.
import type { MergePreview, PrMergeabilityState } from "@/lib/git/types";
import type {
  LocalMergeStripArm,
  PrMergeabilityArm,
  PromotionKind,
} from "./PrMergeabilityBanner";

/** Local-prediction outcomes that mean the head merges into the base cleanly.
 *  Typed on the preview's own union, so a renamed status fails to compile. */
export const PREVIEW_NO_CONFLICT: ReadonlySet<MergePreview["status"]> = new Set<
  MergePreview["status"]
>(["clean", "up-to-date", "fast-forward"]);

/** The shown PR's strip inputs, each read as the view holds it. */
export interface MergeStripInputs {
  /** Only an open PR has a strip. */
  isOpen: boolean;
  /** The app is offline: a forge read with no answer is parked, not running. */
  offline: boolean;
  /** The forge's mergeability read. `polling` is its ladder still climbing on a
   *  "checking" answer. */
  mergeability: {
    data: { state: PrMergeabilityState } | undefined;
    isFetching: boolean;
    isError: boolean;
    polling: boolean;
  };
  /** The local conflict prediction; `enabled` is the view's gate on it. */
  preview: {
    enabled: boolean;
    isPending: boolean;
    data: Pick<MergePreview, "status"> | undefined;
  };
  /** The unfinished-resolve-worktree read (local); `enabled` is its tab gate. */
  resolve: { enabled: boolean; isPending: boolean; found: boolean };
  /** A queued update-branch job is still running. */
  updating: boolean;
  /** The base branch's rules refuse a merge the forge calls clean. */
  blocked: boolean;
  /** How far the base has moved on (GitHub only); `enabled` is the view's gate. */
  divergence: { enabled: boolean; data: unknown; isFetching: boolean };
  behindBy: number;
}

/**
 * The strip's arm: server truth, then the local prediction where the forge has
 * none, then the resume offer, the running update, the still-computing answer,
 * the unreachable line, the base's rules, and behind-the-base; an open PR always
 * keeps one line, so only positive evidence earns "clean" and with none the line
 * says the conflicts can't be checked. Each rung waits only on its OWN input: an
 * arm decided above a read still loading shows at once (a cached conflict,
 * offline too), and a pending read holds the one waiting line so the strip never
 * trades an arm for one that outranks it. `pendingOffline` blames the connection
 * only when the read waited on is a forge read, which parks; the local preview
 * and resolve-worktree reads never do.
 */
export function mergeStripArm(input: MergeStripInputs): {
  arm: PrMergeabilityArm;
  pendingOffline: boolean;
} {
  const { mergeability, preview, resolve, divergence } = input;
  // The forge reads expose no paused flag, hence the offline term; an errored
  // read has answered.
  const unanswered = (q: { data: unknown; isFetching: boolean }) =>
    q.data === undefined && (q.isFetching || input.offline);
  const mergeabilityPending = unanswered(mergeability) && !mergeability.isError;
  const previewPending = preview.enabled && preview.isPending;
  const resolvePending = resolve.enabled && resolve.isPending;
  const serverState = mergeability.data?.state;
  const previewStatus = preview.enabled ? preview.data?.status : undefined;
  const arm: PrMergeabilityArm = (() => {
    switch (true) {
      case !input.isOpen:
        return null;
      case mergeabilityPending:
        return "pending";
      case serverState === "conflicting":
        return "conflicting";
      case previewPending:
        return "pending";
      case previewStatus === "conflict":
        return "predicted";
      case resolvePending:
        return "pending";
      case resolve.found:
        return "resume";
      // Above the still-computing answer: GitHub reports UNKNOWN for the whole
      // update window, which would hide the update the user just started.
      case input.updating:
        return "updating";
      // GitHub answers UNKNOWN while it computes and the ladder re-polls: the same
      // waiting line as a first load, until the poll gives up.
      case serverState === "checking":
        return mergeability.polling ? "pending" : "unknown";
      // Only a read that never landed is unreachable; a settled answer a later
      // refresh failed on stays.
      case mergeability.isError && mergeability.data === undefined:
        return "unreachable";
      // A BLOCKED detail rides a settled "mergeable" answer, so it sits below the
      // answer-shaped rungs; rules the base enforces outrank a base that has only
      // moved on (`behind`).
      case input.blocked:
        return "blocked";
      case divergence.enabled && unanswered(divergence):
        return "pending";
      case input.behindBy > 0:
        return "behind";
      case serverState === "mergeable" ||
        (previewStatus !== undefined && PREVIEW_NO_CONFLICT.has(previewStatus)):
        return "clean";
      default:
        return "unchecked";
    }
  })();
  return {
    arm,
    pendingOffline:
      arm === "pending" &&
      input.offline &&
      (mergeabilityPending || (!previewPending && !resolvePending)),
  };
}

/** A local PR's strip inputs, each read as the view holds it. */
export interface LocalMergeStripInputs {
  /** Only an open PR has a strip. */
  isOpen: boolean;
  /** The conflict prediction (useConflictPreview). `enabled` is false when the record
   *  names no base or no head, so no check can run. */
  preview: {
    enabled: boolean;
    isPending: boolean;
    isError: boolean;
    data: Pick<MergePreview, "status"> | undefined;
  };
  /** The base..head comparison (useCompareBranches). `enabled` is false when base
   *  and head are the same branch; `behindBy` is undefined until a read answers. */
  comparison: {
    enabled: boolean;
    isPending: boolean;
    behindBy: number | undefined;
  };
  promotionKind: PromotionKind;
  /** The default-branch read or the branch rules are still on their first load, so a
   *  null `promotionKind` is not yet an answer. */
  promotionSettling: boolean;
  /** An update-from write naming THIS head and base is running. */
  updating: boolean;
  /** The resolve slot; null when nothing offers a resolve. */
  resolve: { unfinished: boolean } | null;
}

/**
 * A running update outranks all (every input reads the head it moves); an unfinished resolve
 * needs no read and its conflict stays predicted; an errored preview is `failed` over any
 * retained answer. `unknown` (a base or head that no longer resolves such as a deleted
 * branch, an empty merge-tree answer on exit 1, or any other merge-tree exit, git older
 * than 2.38 among them), a disabled preview or an unrecognised status is `unchecked`,
 * never behind. Conflict outranks behind; a pending read
 * holds `checking`; `clean` claims only the prediction: a FAILED comparison never says behind.
 */
export function localMergeStripArm(input: LocalMergeStripInputs): {
  arm: LocalMergeStripArm;
  /** Update branch renders (it may still be held by a reason). */
  offerUpdate: boolean;
  /** Resolve conflicts renders on the conflicted arm (it may still be held). */
  offerResolve: boolean;
  /** An offered action must hold until the promotion inputs land. */
  awaitingPromotion: boolean;
} {
  const { preview, comparison, promotionKind, resolve } = input;
  const behind = comparison.behindBy ?? 0;
  const arm: LocalMergeStripArm = (() => {
    switch (true) {
      case !input.isOpen:
        return null;
      case input.updating:
        return "updating";
      case resolve?.unfinished === true:
        return "resume";
      case !preview.enabled:
        return "unchecked";
      case preview.isPending:
        return "checking";
      case preview.isError:
        return "failed";
      case preview.data?.status === "unknown":
        return "unchecked";
      case preview.data?.status === "conflict":
        return "conflicted";
      case preview.data === undefined ||
        !PREVIEW_NO_CONFLICT.has(preview.data.status):
        return "unchecked";
      case comparison.enabled && comparison.isPending:
        return "checking";
      case behind > 0:
        return promotionKind !== null ? "promotion-gap" : "behind";
      default:
        return "clean";
    }
  })();
  const offerUpdate =
    promotionKind === null &&
    behind > 0 &&
    (arm === "behind" ||
      arm === "updating" ||
      arm === "failed" ||
      arm === "unchecked");
  const offerResolve =
    arm === "conflicted" && resolve !== null && promotionKind === null;
  return {
    arm,
    offerUpdate,
    offerResolve,
    awaitingPromotion:
      input.promotionSettling &&
      promotionKind === null &&
      (offerUpdate || offerResolve),
  };
}
