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
import type { ForgeProvider } from "@/lib/git/types";
import { useAiEnabled, useReviewConfigured } from "@/lib/settings/queries";
import { cn } from "@/lib/utils";

/** Why both resolve actions are unavailable on a fork PR — one wording for the two
 *  buttons, which are blocked by the same thing. */
const FORK_BLOCKED_REASON =
  "Not available for fork pull requests — the head branch lives in another repository.";

/** How many conflicting paths get their own row before the rest collapse to a count. */
const MAX_FILE_ROWS = 5;

/** Which line the banner shows. `predicted` is the local fallback when the forge answers
 *  but has no mergeability to give (Bitbucket) — not when the read itself failed;
 *  `unknown` is a `checking` poll that gave up. */
export type PrMergeabilityArm =
  | "conflicting"
  | "predicted"
  | "checking"
  | "unknown"
  | "resume"
  | "behind"
  | null;

/** Words carry the meaning; the icon and tone only reinforce it. */
const ARM_ICON: Record<Exclude<PrMergeabilityArm, null>, PhosphorIcon> = {
  conflicting: WarningIcon,
  predicted: WarningIcon,
  checking: ClockIcon,
  unknown: ClockIcon,
  resume: InfoIcon,
  behind: InfoIcon,
};

/** The line each arm says. */
const ARM_MESSAGE: Record<
  Exclude<PrMergeabilityArm, null>,
  (ctx: {
    base: string;
    provider: ForgeProvider | null | undefined;
    behindBy: number;
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
  predicted: ({ base }) => (
    <>
      {"Merging into "}
      <span className="font-mono">{base}</span>
      {/* Names the staleness: the prediction runs on remote-tracking refs
          and never fetches, so it can only be as fresh as the last fetch. */}
      {" is predicted to conflict (checked locally from your last fetch)."}
    </>
  ),
  checking: () => "Checking mergeability…",
  unknown: () => "Couldn't determine mergeability.",
  resume: () =>
    "An unfinished conflict resolution exists for this pull request.",
  behind: ({ base, behindBy }) => (
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
  provider,
  forkBlocked,
  hasResolveWorktree,
  busy,
  conflictFiles,
  behindBy,
  updateBlockedReason,
  updateBusy,
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
  provider: ForgeProvider | null | undefined;
  /** The head branch lives in another repository, so there's nowhere to push. */
  forkBlocked: boolean;
  hasResolveWorktree: boolean;
  busy: boolean;
  /** Predicted conflicting paths; empty when the prediction is clean or unavailable. */
  conflictFiles: string[];
  /** Commits the base is ahead of the head — only read on the `behind` arm. */
  behindBy: number;
  /** Why updating the branch is refused, if it is; undefined = allowed. */
  updateBlockedReason: string | undefined;
  updateBusy: boolean;
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

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs">
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5",
          conflicting ? "text-warning" : "text-muted-foreground",
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="min-w-0">
          {ARM_MESSAGE[arm]({ base, provider, behindBy })}
        </span>
      </span>

      {(conflicting || arm === "resume") && (
        <div className="flex items-center gap-1.5">
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

      {arm === "behind" && (
        <div className="flex items-center gap-1.5">
          <DisabledReasonButton
            variant="ghost"
            size="xs"
            disabled={updateDisabled}
            reason={updateBlockedReason}
            onClick={onUpdateBranch}
          >
            {updateBusy && <Spinner data-icon="inline-start" />}
            Update branch
          </DisabledReasonButton>
          {/* A span-wrapped `render` would swallow the caret's disabled state — the
              vendored Button's `pointer-events-none` routes the click to the span,
              which IS the trigger — so a refused update renders no trigger at all. */}
          {updateDisabled ? (
            <span className="inline-flex" title={updateBlockedReason}>
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

      {arm === "unknown" && (
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
