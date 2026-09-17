import type { ForgeUserRef } from "./forge";

/**
 * One activity-timeline event on a PR/MR or an issue, mirroring the Rust
 * `ForgeTimelineEventOut` tagged enum. Provider-neutral: GitHub renders reviews as
 * cards so it emits no approved/changesRequested, while GitLab/Bitbucket emit approval
 * events here. Events arrive oldest→newest; every string field is `""` (and every
 * number `0`) when the provider returned null, so absence reads as empty rather than
 * missing.
 */
export type ForgeTimelineEvent =
  | {
      kind: "forcePushed";
      before: string;
      after: string;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "labeled";
      label: string;
      color: string;
      /** true for a LABELED_EVENT, false for an UNLABELED_EVENT. */
      added: boolean;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "reviewRequested";
      reviewer: string;
      actor: ForgeUserRef;
      date: string;
    }
  | { kind: "readyForReview"; actor: ForgeUserRef; date: string }
  | { kind: "convertToDraft"; actor: ForgeUserRef; date: string }
  | { kind: "approved"; actor: ForgeUserRef; date: string }
  | { kind: "changesRequested"; actor: ForgeUserRef; date: string }
  | { kind: "unapproved"; actor: ForgeUserRef; date: string }
  | {
      kind: "closed";
      actor: ForgeUserRef;
      /** `"completed" | "not_planned" | "duplicate"` on a GitHub issue close; `""`
       *  for PRs and for GitLab/Bitbucket, which report no reason. */
      stateReason: string;
      date: string;
    }
  | { kind: "reopened"; actor: ForgeUserRef; date: string }
  | { kind: "merged"; actor: ForgeUserRef; commitOid?: string; date: string }
  | {
      kind: "renamed";
      previous: string;
      current: string;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "assigned";
      assignee: string;
      /** true for an assignment, false for an unassignment. */
      added: boolean;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "milestoned";
      milestone: string;
      /** true when added to the milestone, false when removed. */
      added: boolean;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "crossReferenced";
      /** `"pr" | "issue"`, or `""` when the referring entity's type is unknown. */
      sourceKind: string;
      sourceNumber: number;
      sourceTitle: string;
      /** The referring entity's `owner/name` — a cross-reference can live in another
       *  repository, so the number alone can't address it. Empty is a same-repo
       *  GUARANTEE, not an unknown: GitHub always names the repo, and GitLab only
       *  emits same-project references. The reference chip's gate relies on it. */
      sourceRepo: string;
      /** Whether the referring entity would close this one on merge. Carried on the
       *  wire so a future closing-reference treatment needs no shape change; no
       *  renderer reads it today. */
      willClose: boolean;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "connected";
      sourceKind: string;
      sourceNumber: number;
      sourceTitle: string;
      /** Same shape and same-repo contract as `crossReferenced`'s `sourceRepo`. */
      sourceRepo: string;
      /** true when the link was made, false when it was broken. */
      added: boolean;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "pinned";
      /** true for a pin, false for an unpin. */
      added: boolean;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "locked";
      locked: boolean;
      /** The lock reason lowercased (`"off_topic"`, `"too_heated"`, `"resolved"`,
       *  `"spam"`); `""` when none was given, and on unlock. */
      reason: string;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "transferred";
      /** The `owner/name` the issue moved here from; `""` when unknown. */
      fromRepo: string;
      actor: ForgeUserRef;
      date: string;
    }
  | {
      kind: "markedAsDuplicate";
      canonicalKind: string;
      canonicalNumber: number;
      /** The canonical entity's `owner/name` — same cross-repo reason and same
       *  empty-means-same-repo contract as `sourceRepo`. */
      canonicalRepo: string;
      actor: ForgeUserRef;
      date: string;
    };
