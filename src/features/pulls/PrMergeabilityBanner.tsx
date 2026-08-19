import {
  CaretDownIcon,
  ClockIcon,
  InfoIcon,
  type Icon as PhosphorIcon,
  SparkleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { type ForgeProvider, providerLabel } from "@/lib/git/types";
import { useAiEnabled, useReviewConfigured } from "@/lib/settings/queries";
import { cn } from "@/lib/utils";

/** Why both resolve actions are unavailable on a fork PR — one wording for the two
 *  buttons, which are blocked by the same thing. */
const FORK_BLOCKED_REASON =
  "Not available for fork pull requests — the head branch lives in another repository.";

/** How many conflicting paths get their own row before the rest collapse to a count. */
const MAX_FILE_ROWS = 5;

/** How many unmet requirements the blocked line names before the rest collapse. */
const MAX_REQUIREMENT_NAMES = 4;

/** The one wording for a merge the base branch's rules are refusing — the strip says
 *  it, and so does the note on a refused merge, so the two can't drift apart. With
 *  nothing named (the rules read failed, or named nothing the app could join) it
 *  still states where things stand rather than going quiet. */
export function blockedMergeLine(requirements: string[]): string {
  if (requirements.length === 0)
    return "Merge is blocked by the base branch's protection rules.";
  const shown = requirements.slice(0, MAX_REQUIREMENT_NAMES);
  const extra = requirements.length - shown.length;
  const names =
    extra > 0 ? `${shown.join(", ")} and ${extra} more` : shown.join(", ");
  return `Merge is blocked — waiting on: ${names}.`;
}

/** What a control held open through the PR-switch window says. Shared with the view's
 *  own stale-held controls so the one wording can't drift into two. */
export const PR_SWITCH_LOADING_REASON = "Loading this pull request…";

/** Which line the banner shows. `predicted` is the local fallback wherever the forge has
 *  no mergeability to give — Bitbucket by design, or a read that failed; `unknown` is a
 *  `checking` poll that gave up, `unreachable` a read that never landed at all,
 *  `updating` the forge's queued update-branch job still running, and `blocked` a PR
 *  that merges cleanly but whose base branch rules are refusing it. */
export type PrMergeabilityArm =
  | "conflicting"
  | "predicted"
  | "checking"
  | "unknown"
  | "unreachable"
  | "resume"
  | "behind"
  | "updating"
  | "blocked"
  | null;

/** Words carry the meaning; the icon and tone only reinforce it. */
const ARM_ICON: Record<
  Exclude<PrMergeabilityArm, null>,
  PhosphorIcon | typeof Spinner
> = {
  conflicting: WarningIcon,
  predicted: WarningIcon,
  checking: ClockIcon,
  unknown: ClockIcon,
  unreachable: ClockIcon,
  resume: InfoIcon,
  behind: InfoIcon,
  updating: Spinner,
  // Informational, not a warning: nothing is wrong with the pull request, and a
  // viewer who can bypass the rules may still merge it.
  blocked: InfoIcon,
};

/** The line each arm says. */
const ARM_MESSAGE: Record<
  Exclude<PrMergeabilityArm, null>,
  (ctx: {
    base: string;
    head: string;
    provider: ForgeProvider | null | undefined;
    behindBy: number;
    predictedClean: boolean;
    forgeUnreachable: boolean;
    blockedRequirements: string[];
    promotionLike: boolean;
  }) => ReactNode
> = {
  conflicting: ({ base, provider }) => (
    <>
      {"This pull request has conflicts with "}
      <span className="font-mono">{base}</span>
      {"."}
      {/* GitHub runs no pull_request checks on a conflicting PR, so an
          empty checks list there means "never ran", not "passed". */}
      {provider === "github" ? " Checks won't run until they're resolved." : ""}
    </>
  ),
  // The qualifier only rides along when the forge answer never landed; where the forge
  // simply has none to give (Bitbucket) there is nothing that failed to say.
  predicted: ({ base, provider, forgeUnreachable }) => (
    <>
      {forgeUnreachable
        ? `Couldn't reach ${providerLabel(provider)} to check mergeability. Merging into `
        : "Merging into "}
      <span className="font-mono">{base}</span>
      {/* Names the staleness: the prediction runs on remote-tracking refs
          and never fetches, so it can only be as fresh as the last fetch. */}
      {" is predicted to conflict (checked locally from your last fetch)."}
    </>
  ),
  checking: () => "Checking mergeability…",
  unknown: () => "Couldn't determine mergeability.",
  // The local prediction needs no network, so a clean one is a real answer even with
  // the forge unreachable — and the only one this arm can stand behind.
  unreachable: ({ base, provider, predictedClean }) => (
    <>
      {`Couldn't reach ${providerLabel(provider)} to check mergeability.`}
      {predictedClean ? (
        <>
          {" No conflicts with "}
          <span className="font-mono">{base}</span>
          {" in your last fetch."}
        </>
      ) : null}
    </>
  ),
  updating: ({ base, provider }) => (
    <>
      {`${providerLabel(provider)} is updating this branch from `}
      <span className="font-mono">{base}</span>
      {"…"}
    </>
  ),
  resume: () =>
    "An unfinished conflict resolution exists for this pull request.",
  // The behind clause rides along in the `behind` arm's own words, because the update
  // controls come with it — a bare refusal beside an Update branch button would leave
  // the button unexplained.
  blocked: ({ base, behindBy, blockedRequirements, promotionLike }) => (
    <>
      {blockedMergeLine(blockedRequirements)}
      {/* The behind clause exists to explain the Update controls beside it, so it
          goes wherever they go: on a promotion pull request they'd invert the
          flow, and a count with no route out would read as a demand. */}
      {behindBy > 0 && !promotionLike ? (
        <>
          {` It is also ${behindBy} commit${behindBy === 1 ? "" : "s"} behind `}
          <span className="font-mono">{base}</span>
          {"."}
        </>
      ) : null}
    </>
  ),
  // A promotion pull request (main → staging) is permanently behind its base by
  // design, and "update the branch" would merge the base back into the default
  // branch. Say which direction the work is going instead of implying a catch-up.
  // The gap does NOT close on merge — merging the head into the base ADDS a
  // commit the head lacks — so the copy says it needs no closing.
  behind: ({ base, head, behindBy, promotionLike }) =>
    promotionLike ? (
      <>
        <span className="font-mono">{base}</span>
        {` has ${behindBy} commit${behindBy === 1 ? "" : "s"} that `}
        <span className="font-mono">{head}</span>
        {" doesn't. "}
        <span className="font-mono">{head}</span>
        {
          " is the repository's default branch, so this gap is expected and doesn't need closing. Updating the branch would merge "
        }
        <span className="font-mono">{base}</span>
        {" back into "}
        <span className="font-mono">{head}</span>
        {"."}
      </>
    ) : (
      <>
        {`This branch is ${behindBy} commit${behindBy === 1 ? "" : "s"} behind `}
        <span className="font-mono">{base}</span>
        {"."}
      </>
    ),
};

/**
 * One calm status strip above a remote PR's body: whether it merges into its base,
 * and the way into the isolated-worktree resolution when it doesn't. Dumb by design —
 * the view decides the arm; this only renders it. Renders nothing when there's
 * nothing to say (mergeable, or unavailable with no local prediction).
 */
export function PrMergeabilityBanner({
  arm,
  base,
  head,
  promotionLike,
  provider,
  forkBlocked,
  hasResolveWorktree,
  busy,
  conflictFiles,
  predictedClean,
  forgeUnreachable,
  behindBy,
  blockedRequirements,
  updateBlockedReason,
  updateBusy,
  updateAwaitingDefault,
  updateSubmitting,
  onResolve,
  onResolveWithAi,
  onDiscard,
  onRetry,
  onUpdateBranch,
  onUpdateWithRebase,
  retryBusy,
}: {
  arm: PrMergeabilityArm;
  base: string;
  head: string;
  /** The head IS this repository's default branch, so the pull request promotes
   *  it somewhere (main → staging). Updating such a branch would merge the base
   *  back into the default branch, inverting the flow — so the behind arm keeps
   *  its true count and drops the action. */
  promotionLike: boolean;
  provider: ForgeProvider | null | undefined;
  /** The head branch lives in another repository, so there's nowhere to push. */
  forkBlocked: boolean;
  hasResolveWorktree: boolean;
  busy: boolean;
  /** Predicted conflicting paths; empty when the prediction is clean or unavailable. */
  conflictFiles: string[];
  /** The local prediction came back CLEAN — false also covers unknown and not-run, so
   *  it is the only form the `unreachable` arm may make a claim from. */
  predictedClean: boolean;
  /** The forge answer never landed, as opposed to a forge that has none to give. Adds
   *  the couldn't-reach qualifier and a Retry to the arms driven by the prediction. */
  forgeUnreachable: boolean;
  /** Commits the base is ahead of the head — read on the `behind` arm, and on
   *  `blocked` where it decides whether the update controls ride along. */
  behindBy: number;
  /** Unmet requirements of the base branch's rules — only read on the `blocked`
   *  arm, where an empty list means the app couldn't name any and the line stays
   *  generic. */
  blockedRequirements: string[];
  /** Why updating the branch is refused, if it is; undefined = allowed. */
  updateBlockedReason: string | undefined;
  updateBusy: boolean;
  /** The slice of `updateBusy` spent waiting on the default-branch read the
   *  promotion demotion depends on — it gets its own wording, since the generic
   *  busy line would claim the pull request is still loading. */
  updateAwaitingDefault: boolean;
  /** The update call itself is in flight — the slice of `updateBusy` before the forge
   *  has even accepted the job. */
  updateSubmitting: boolean;
  onResolve: () => void;
  onResolveWithAi: () => void;
  onDiscard: () => void;
  onRetry: () => void;
  onUpdateBranch: () => void;
  onUpdateWithRebase: () => void;
  /** A retry read is in flight. */
  retryBusy: boolean;
}) {
  // Same gating pair as ConflictBanner's batch AI action, so the two surfaces offer
  // AI resolution under identical conditions.
  const aiEnabled = useAiEnabled();
  const reviewConfigured = useReviewConfigured();

  if (arm === null) return null;

  const conflicting = arm === "conflicting" || arm === "predicted";
  const resolveLabel = hasResolveWorktree
    ? "Continue resolving"
    : "Resolve conflicts";
  // The AI walk gets its file list from the merge outcome, not this prediction, so it
  // stays offered even when the preview couldn't name the files.
  const canResolveWithAi = aiEnabled && reviewConfigured;
  // One path per row under the sentence, capped so a wide conflict can't run the strip
  // down the pane. `basis-full` puts the list on its own line without pushing the
  // actions out of the first row; `pl-5` clears the sentence's icon (size-3.5 + gap-1.5).
  const shownFiles = conflictFiles.slice(0, MAX_FILE_ROWS);
  const extraFiles = conflictFiles.length - shownFiles.length;
  const fileList = conflictFiles.length > 0 && (
    <ul className="basis-full pl-5 text-muted-foreground">
      {shownFiles.map((path) => (
        <li key={path} className="truncate font-mono" title={path}>
          {path}
        </li>
      ))}
      {extraFiles > 0 && (
        <li title={conflictFiles.join("\n")}>and {extraFiles} more</li>
      )}
    </ul>
  );
  const Icon = ARM_ICON[arm];
  const updateDisabled = updateBusy || updateBlockedReason !== undefined;
  // The busy hold now spans the forge's whole queued update, so a silent disabled
  // control would leave the user waiting on nothing they can read. Each cause gets its
  // own words: the queued job, the call that hasn't been accepted yet, the
  // default-branch read this action's promotion check depends on, and the
  // PR-switch window are four different waits.
  const updateBusyReason = (() => {
    switch (true) {
      case arm === "updating":
        return `${providerLabel(provider)} is still updating this branch.`;
      case updateSubmitting:
        return "Submitting the update…";
      case updateAwaitingDefault:
        return "Checking which branch is the default…";
      default:
        return PR_SWITCH_LOADING_REASON;
    }
  })();
  const updateDisabledReason =
    updateBlockedReason ?? (updateBusy ? updateBusyReason : undefined);
  // "Update branch" doesn't say which way the commits travel; the tooltip does.
  // The caret gets its own wording rather than this one — its menu holds the
  // REBASE variant, which rewrites rather than merges (and names that in its own
  // confirm), so borrowing the button's label there would misdescribe it.
  const updateOperation = `Merges ${base} into ${head}`;
  const updateOptionsLabel = "Other ways to update this branch";

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs">
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          conflicting ? "text-warning" : "text-muted-foreground",
        )}
      >
        {/* Decorative throughout — the sentence carries the meaning, and the `updating`
            arm's spinner would otherwise announce a bare "Loading" beside it. */}
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0">
          {ARM_MESSAGE[arm]({
            base,
            head,
            provider,
            behindBy,
            predictedClean,
            forgeUnreachable,
            blockedRequirements,
            promotionLike,
          })}
        </span>
      </span>

      {(conflicting || arm === "resume") && (
        <div className="flex items-center gap-1.5">
          {/* Only where a read FAILED — a forge with no mergeability to give (Bitbucket)
              answers without an HTTP call, so a Retry there would be a dead button.
              First in the row: the real answer outranks acting on a prediction. */}
          {arm === "predicted" && forgeUnreachable && (
            <Button
              variant="ghost"
              size="xs"
              disabled={retryBusy}
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
          {/* Discard rides along wherever a worktree exists, not just the resume
              arm: a paused resolve keeps the server answer "conflicting", so the
              way out has to be reachable from that arm too. */}
          {hasResolveWorktree && (
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={onDiscard}
            >
              Discard
            </Button>
          )}
          {conflicting && canResolveWithAi && (
            <DisabledReasonButton
              variant="ghost"
              size="xs"
              disabled={busy || forkBlocked}
              reason={forkBlocked ? FORK_BLOCKED_REASON : undefined}
              onClick={onResolveWithAi}
            >
              <SparkleIcon data-icon="inline-start" />
              Resolve with AI
            </DisabledReasonButton>
          )}
          <DisabledReasonButton
            variant="ghost"
            size="xs"
            disabled={busy || forkBlocked}
            reason={forkBlocked ? FORK_BLOCKED_REASON : undefined}
            onClick={onResolve}
          >
            {resolveLabel}
          </DisabledReasonButton>
        </div>
      )}

      {/* The blocked arm re-admits these EXISTING controls when the head is also
          behind: the ladder gives that PR the blocked sentence, and losing the only
          route to the update along with it would be a refusal the app never intended. */}
      {(arm === "behind" ||
        arm === "updating" ||
        (arm === "blocked" && behindBy > 0)) &&
        !promotionLike && (
          <div className="flex items-center gap-1.5">
            <DisabledReasonButton
              variant="ghost"
              size="xs"
              disabled={updateDisabled}
              reason={updateDisabledReason}
              title={updateOperation}
              onClick={onUpdateBranch}
            >
              {/* The `updating` arm already spins in the sentence — one progress mark
                per strip, so the button only carries the momentary holds. */}
              {updateBusy && arm !== "updating" && (
                <Spinner data-icon="inline-start" />
              )}
              Update branch
            </DisabledReasonButton>
            {/* A span-wrapped `render` would swallow the caret's disabled state — the
              vendored Button's `pointer-events-none` routes the click to the span,
              which IS the trigger — so a refused update renders no trigger at all. */}
            {updateDisabled ? (
              <span className="inline-flex" title={updateDisabledReason}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Update branch options"
                  disabled
                >
                  <CaretDownIcon />
                </Button>
              </span>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Update branch options"
                      title={updateOptionsLabel}
                    />
                  }
                >
                  <CaretDownIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuItem
                    disabled={updateDisabled}
                    onClick={onUpdateWithRebase}
                  >
                    Update with rebase…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}

      {(arm === "unknown" || arm === "unreachable") && (
        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="xs"
            disabled={retryBusy}
            onClick={onRetry}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Last child so it wraps onto its own full-width row beneath the sentence and
          actions, rather than competing with them for the first row. */}
      {conflicting && fileList}
    </div>
  );
}
