import {
  ArrowClockwiseIcon,
  CaretDownIcon,
  CheckCircleIcon,
  ClockIcon,
  InfoIcon,
  type Icon as PhosphorIcon,
  SparkleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useId } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { PathText } from "@/components/path-text";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { useRetryFocusRescue } from "@/features/conversations/ConversationListPanel";
import { offlinePendingMessage } from "@/features/conversations/remote-section-state";
import { clipTitleFromText } from "@/lib/clip-title";
import {
  type ForgeProvider,
  shownProviderLabel,
  UNKNOWN_HOST,
} from "@/lib/git/types";
import { PR_NOUN } from "@/lib/pulls/pr-state";
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
 *  still states where things stand rather than going quiet.
 *
 *  `requiredApprovals` gets its own clause rather than joining the waiting-on list:
 *  that list is what the checks join found UNMET, and the rules payload only says how
 *  many approvals are required, never how many the pull request has. */
export function blockedMergeLine(
  requirements: string[],
  requiredApprovals?: number | null,
): string {
  const approvals =
    requiredApprovals && requiredApprovals > 0
      ? `${requiredApprovals} approving review${requiredApprovals === 1 ? "" : "s"}`
      : null;
  if (requirements.length === 0)
    return approvals
      ? `Merge is blocked by the base branch's protection rules, which require ${approvals}.`
      : "Merge is blocked by the base branch's protection rules.";
  const shown = requirements.slice(0, MAX_REQUIREMENT_NAMES);
  const extra = requirements.length - shown.length;
  const names =
    extra > 0 ? `${shown.join(", ")} and ${extra} more` : shown.join(", ");
  const line = `Merge is blocked — waiting on: ${names}.`;
  return approvals ? `${line} The rules also require ${approvals}.` : line;
}

/** GitLab's `detailed_merge_status` values that name a rule refusing the merge, said
 *  in the app's own words. Each maps to the clause after "Merge is blocked — ". The
 *  values are GitLab's documented enum (18.3); anything absent here either already
 *  rides the mergeability `state` or is deliberately unarmed (see
 *  `GITLAB_UNARMED_MERGE_STATUSES`). */
const GITLAB_BLOCKED_REASONS: Record<string, string> = {
  not_approved: "needs approval before it can merge",
  ci_must_pass: "the pipeline must pass first",
  ci_still_running: "the pipeline is still running",
  discussions_not_resolved: "all discussions must be resolved first",
  merge_request_blocked: "it's blocked by another merge request",
  status_checks_must_pass: "external status checks must pass first",
  requested_changes: "a reviewer requested changes",
  need_rebase: "it needs a rebase first",
  merge_time: "it can't merge before its scheduled time",
  jira_association_missing:
    "its title or description must reference a Jira issue",
  security_policy_violations: "security policies must be satisfied first",
  locked_paths: "paths locked by other users must be unlocked first",
  locked_lfs_files: "locked LFS files must be unlocked first",
  title_regex: "its title doesn't match the project's required pattern",
};

/** `detailed_merge_status` values that deliberately arm NOTHING — each is either
 *  already carried by the mergeability state (`mergeable`, the checking family,
 *  `conflict`, `not_open`), owned by another surface (`draft_status` is the merge
 *  control's own refusal), or still being computed (`approvals_syncing`,
 *  `commits_status`). Membership here is the only route to silence: an enum value in
 *  neither table still renders, humanized (`some_status` → "some status"), and
 *  free-form `merge_error` prose renders verbatim. */
const GITLAB_UNARMED_MERGE_STATUSES: ReadonlySet<string> = new Set([
  "mergeable",
  "checking",
  "unchecked",
  "preparing",
  "broken_status",
  "conflict",
  "draft_status",
  "not_open",
  "approvals_syncing",
  "commits_status",
]);

/** Ends a line the app didn't write like a sentence. GitLab's prose sometimes carries
 *  its own terminator and sometimes doesn't, and the blocked arm can append a clause
 *  straight after this line. */
function terminated(line: string): string {
  return /[.!?]$/.test(line) ? line : `${line}.`;
}

/** The banner's line for a GitLab merge request the project's rules are refusing, or
 *  `null` when the detail names nothing worth a line.
 *
 *  `detail` carries GitLab's `merge_error` when there is one and the
 *  `detailed_merge_status` enum otherwise, and the backend keeps both raw — so the
 *  enum lookup is gated on the enum's own shape and free-form prose is shown exactly
 *  as GitLab wrote it. An enum value this app hasn't learned yet is humanized rather
 *  than shown as a token: GitLab's word beats silence about a merge that will refuse. */
export function gitlabBlockedLine(detail: string): string | null {
  const raw = detail.trim();
  if (raw === "") return null;
  if (!/^[a-z_]+$/.test(raw)) return terminated(`Merge is blocked — ${raw}`);
  if (GITLAB_UNARMED_MERGE_STATUSES.has(raw)) return null;
  const reason = GITLAB_BLOCKED_REASONS[raw];
  if (reason) return `Merge is blocked — ${reason}.`;
  return `Merge is blocked — ${raw.replace(/_/g, " ")}.`;
}

/** What a control held open through the PR-switch window says. Shared with the view's
 *  own stale-held controls so the one wording can't drift into two. */
export const PR_SWITCH_LOADING_REASON = "Loading this pull request…";

/** Which line the banner shows. `predicted` is the local fallback wherever the forge has
 *  no mergeability to give — Bitbucket by design, or a read that failed; `unknown` is a
 *  poll on GitHub's still-computing answer that gave up, `unreachable` a read that never landed at all,
 *  `updating` the forge's queued update-branch job still running, and `blocked` a PR
 *  that merges cleanly but whose base branch rules are refusing it. The three quiet
 *  arms keep an open PR's line when nothing else applies: `pending` while the answers
 *  load (the forge's still-computing answer included), `clean` on a positive one,
 *  and `unchecked` where none can be had. `null` (no line) is for a closed or
 *  merged PR. */
export type PrMergeabilityArm =
  | "pending"
  | "clean"
  | "unchecked"
  | "conflicting"
  | "predicted"
  | "unknown"
  | "unreachable"
  | "resume"
  | "behind"
  | "updating"
  | "blocked"
  | null;

/** Which line a LOCAL pull request's strip shows; `null` (no line) for a closed or merged one.
 *  `failed` is a prediction read that errored (a retry can help); `unchecked` is a settled
 *  answer that cannot be a prediction (asking again returns the same). */
export type LocalMergeStripArm =
  | "checking"
  | "clean"
  | "behind"
  | "promotion-gap"
  | "conflicted"
  | "resume"
  | "updating"
  | "failed"
  | "unchecked"
  | null;

/** What makes a pull request a promotion — its head is this repository's default
 *  branch, or a branch the repo's rules name as a promotion branch. `null` for an
 *  ordinary pull request. */
export type PromotionKind = "default" | "configured" | null;

/** The clause naming why the head is a promotion — the only words that differ
 *  between the two kinds, so the rest of the sentence can't drift apart. The remote
 *  banner and the local strip both read it through the one behind sentence. */
const PROMOTION_REASON: Record<Exclude<PromotionKind, null>, string> = {
  default: " is the repository's default branch",
  configured: " is a promotion branch for this repository",
};

/** Why an update holds while the default-branch read the promotion check needs
 *  is still loading. Shared by the remote banner and LocalPrView. */
export const AWAITING_DEFAULT_BRANCH_REASON =
  "Checking which branch is the default…";

/** The same hold while the branch rules that name promotion branches load. */
export const AWAITING_PROMOTION_RULES_REASON =
  "Checking this repository's promotion branches…";

/** The pending line, and the reason a busy Retry holds with: one wording. */
const CHECKING_MESSAGE = "Checking for conflicts…";

/** Both strips' root, line and action-box classes, so the local strip can't
 *  drift from the remote one. */
const STRIP_ROOT_CLASS =
  "flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs";
const STRIP_LINE_CLASS =
  "flex min-h-6 min-w-0 flex-1 basis-0 items-center gap-1.5";
const STRIP_ACTIONS_CLASS = "flex shrink-0 items-center gap-1.5";

/** "Update branch" doesn't say which way the commits travel; its tooltip does, and
 *  so does a local resolve's advance notice. */
export function updateOperation(base: string, head: string): string {
  return `Merges ${base} into ${head}`;
}

function cleanSentence(base: string): ReactNode {
  return (
    <>
      {"No conflicts with "}
      <span className="font-mono">{base}</span>
      {"."}
    </>
  );
}

/** A promotion pull request (main → staging) is permanently behind its base by
 *  design, and "update the branch" would merge the base back into the head, so
 *  its line says which way the work goes instead. The gap does NOT close on merge
 *  (merging the head into the base ADDS a commit the head lacks), so the copy
 *  says it needs no closing. A configured head is no claim about the default
 *  branch: only the reason clause differs between the two kinds. */
function behindSentence({
  base,
  head,
  behindBy,
  promotionKind,
}: {
  base: string;
  head: string;
  behindBy: number;
  promotionKind: PromotionKind;
}): ReactNode {
  return promotionKind !== null ? (
    <>
      <span className="font-mono">{base}</span>
      {` has ${behindBy} commit${behindBy === 1 ? "" : "s"} that `}
      <span className="font-mono">{head}</span>
      {" doesn't. "}
      <span className="font-mono">{head}</span>
      {PROMOTION_REASON[promotionKind]}
      {
        ", so this gap is expected and doesn't need closing. Updating the branch would merge "
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
  );
}

/** One path per row under the sentence, capped so a wide conflict can't run the
 *  strip down the pane. `basis-full` puts the list on its own line without pushing
 *  the actions out of the first row; `pl-5` clears the sentence's icon (size-3.5 +
 *  gap-1.5). Renders nothing for an empty list. `nameCount` names the count row
 *  by its visible text, since a listitem's name otherwise falls back to the
 *  tooltip's whole path list (the local strip sets it). */
function ConflictFileList({
  files,
  nameCount = false,
}: {
  files: string[];
  nameCount?: boolean;
}) {
  if (files.length === 0) return null;
  const shown = files.slice(0, MAX_FILE_ROWS);
  const extra = files.length - shown.length;
  const countText = `and ${extra} more`;
  return (
    <ul className="basis-full pl-5 text-muted-foreground">
      {shown.map((path) => (
        <li key={path}>
          <PathText path={path} className="font-mono" />
        </li>
      ))}
      {extra > 0 && (
        <li
          title={files.join("\n")}
          aria-label={nameCount ? countText : undefined}
        >
          {countText}
        </li>
      )}
    </ul>
  );
}

/** The host at a sentence's start when nothing names it yet. */
const UNKNOWN_HOST_LEAD = "The host";

/** An unresolved provider reads as GitHub, the app's default forge. */
function prNounFor(provider: ForgeProvider | null | undefined): string {
  return provider ? PR_NOUN[provider] : PR_NOUN.github;
}

/** Words carry the meaning; the icon and tone only reinforce it. */
const ARM_ICON: Record<
  Exclude<PrMergeabilityArm, null>,
  PhosphorIcon | typeof Spinner
> = {
  pending: ClockIcon,
  clean: CheckCircleIcon,
  unchecked: InfoIcon,
  conflicting: WarningIcon,
  predicted: WarningIcon,
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
    blockedApprovals: number | null;
    blockedReason: string | null;
    promotionKind: PromotionKind;
    pendingOffline: boolean;
  }) => ReactNode
> = {
  pending: ({ pendingOffline }) =>
    pendingOffline
      ? offlinePendingMessage("the conflict check")
      : CHECKING_MESSAGE,
  clean: ({ base }) => cleanSentence(base),
  // Neither the forge nor the local prediction has an answer to give: a fork's head
  // can't be predicted from our remote, and Bitbucket reports no mergeability.
  unchecked: ({ base, provider }) => (
    <>
      {"Conflicts with "}
      <span className="font-mono">{base}</span>
      {` can't be checked for this ${prNounFor(provider)}.`}
    </>
  ),
  conflicting: ({ base, provider }) => (
    <>
      {`This ${prNounFor(provider)} has conflicts with `}
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
        ? `Couldn't reach ${shownProviderLabel(provider) ?? UNKNOWN_HOST} to check mergeability. Merging into `
        : "Merging into "}
      <span className="font-mono">{base}</span>
      {/* Names the staleness: the prediction runs on remote-tracking refs
          and never fetches, so it can only be as fresh as the last fetch. */}
      {" is predicted to conflict (checked locally from your last fetch)."}
    </>
  ),
  unknown: () => "Couldn't determine mergeability.",
  // The local prediction needs no network, so a clean one is a real answer even with
  // the forge unreachable — and the only one this arm can stand behind.
  unreachable: ({ base, provider, predictedClean }) => (
    <>
      {`Couldn't reach ${shownProviderLabel(provider) ?? UNKNOWN_HOST} to check mergeability.`}
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
      {`${shownProviderLabel(provider) ?? UNKNOWN_HOST_LEAD} is updating this branch from `}
      <span className="font-mono">{base}</span>
      {"…"}
    </>
  ),
  resume: ({ provider }) =>
    `An unfinished conflict resolution exists for this ${prNounFor(provider)}.`,
  // The behind clause rides along in the `behind` arm's own words, because the update
  // controls come with it — a bare refusal beside an Update branch button would leave
  // the button unexplained.
  blocked: ({
    base,
    behindBy,
    blockedRequirements,
    blockedApprovals,
    blockedReason,
    promotionKind,
  }) => (
    <>
      {/* GitLab names its own reason and gets no requirements join — rules and
          branch protections are a GitHub read, and there is nothing to join it to. */}
      {blockedReason ?? blockedMergeLine(blockedRequirements, blockedApprovals)}
      {/* The behind clause exists to explain the Update controls beside it, so it
          goes wherever they go: on a promotion pull request they'd invert the
          flow, and a count with no route out would read as a demand. */}
      {behindBy > 0 && promotionKind === null ? (
        <>
          {` It is also ${behindBy} commit${behindBy === 1 ? "" : "s"} behind `}
          <span className="font-mono">{base}</span>
          {"."}
        </>
      ) : null}
    </>
  ),
  behind: (ctx) => behindSentence(ctx),
};

/**
 * One calm status strip above a remote PR's body: whether it merges into its base,
 * and the way into the isolated-worktree resolution when it doesn't. Dumb by design —
 * the view decides the arm; this only renders it. An open PR always gets its line,
 * so the strip never appears or vanishes under the header; it renders nothing only
 * for the `null` arm (closed or merged).
 */
export function PrMergeabilityBanner({
  arm,
  base,
  head,
  promotionKind,
  provider,
  forkBlocked,
  hasResolveWorktree,
  busy,
  resolveHeldReason,
  conflictFiles,
  predictedClean,
  forgeUnreachable,
  behindBy,
  blockedRequirements,
  blockedApprovals,
  blockedReason,
  pendingOffline,
  updateBlockedReason,
  updateHeldReason,
  updateBusy,
  updateAwaitingDefault,
  updateAwaitingRules,
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
  /** The pull request promotes its head onward (main → staging), because the head
   *  IS this repository's default branch or the repo's rules name it a promotion
   *  branch. Updating such a branch would merge the base back into it, inverting
   *  the flow — so the behind arm keeps its true count and drops the action. The
   *  two kinds only differ in the words that name the reason. */
  promotionKind: PromotionKind;
  /** The provider copy may name (`shownProvider`): undefined while nothing
   *  names the host yet, which reads as neutral copy. */
  provider: ForgeProvider | null | undefined;
  /** The head branch lives in another repository, so there's nowhere to push. */
  forkBlocked: boolean;
  hasResolveWorktree: boolean;
  busy: boolean;
  /** Why both Resolve actions hold, ranked by the caller: every `busy` term, then
   *  offline (a resolve with no conflicts left pushes straight to the head). One
   *  reason for each term keeps the buttons aria-disabled across every flip. */
  resolveHeldReason?: string;
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
  /** Approving reviews the base branch's rules require; `null` when the rules name
   *  no count or the read didn't land. GitHub only, like `blockedRequirements`. */
  blockedApprovals: number | null;
  /** The whole blocked sentence, where the provider supplies the reason itself
   *  (GitLab). Non-null replaces the rules-derived line — the two describe different
   *  refusals and only one provider can be answering. */
  blockedReason: string | null;
  /** The `pending` arm's reads are parked offline, so it says so rather than claim
   *  a check is running. */
  pendingOffline: boolean;
  /** Why updating the branch is refused, if it is; undefined = allowed. */
  updateBlockedReason: string | undefined;
  /** A transient hold (offline), ranked below the refusal AND below every
   *  `updateBusy` cause: a running update outranks it, like the Resolve chain. */
  updateHeldReason?: string;
  updateBusy: boolean;
  /** The slice of `updateBusy` spent waiting on the default-branch read the
   *  promotion demotion depends on — it gets its own wording, since the generic
   *  busy line would claim the pull request is still loading. */
  updateAwaitingDefault: boolean;
  /** The same wait for the other half of the demotion: the repo's branch rules,
   *  which name the promotion branches. */
  updateAwaitingRules: boolean;
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
  const Icon = ARM_ICON[arm];
  const updateDisabled =
    updateBusy ||
    updateBlockedReason !== undefined ||
    updateHeldReason !== undefined;
  // The busy hold now spans the forge's whole queued update, so a silent disabled
  // control would leave the user waiting on nothing they can read. Each cause gets its
  // own words: the queued job, the call that hasn't been accepted yet, the two reads
  // this action's promotion check depends on, and the PR-switch window.
  const updateBusyReason = (() => {
    switch (true) {
      case arm === "updating":
        return `${shownProviderLabel(provider) ?? UNKNOWN_HOST_LEAD} is still updating this branch.`;
      case updateSubmitting:
        return "Submitting the update…";
      case updateAwaitingDefault:
        return AWAITING_DEFAULT_BRANCH_REASON;
      case updateAwaitingRules:
        return AWAITING_PROMOTION_RULES_REASON;
      default:
        return PR_SWITCH_LOADING_REASON;
    }
  })();
  const updateDisabledReason =
    updateBlockedReason ?? (updateBusy ? updateBusyReason : updateHeldReason);
  // The caret gets its own wording rather than the button's tooltip: its menu holds
  // the REBASE variant, which rewrites rather than merges (and names that in its own
  // confirm), so borrowing the button's label there would misdescribe it.
  const updateOptionsLabel = "Other ways to update this branch";

  return (
    <div className={STRIP_ROOT_CLASS}>
      {/* Every arm's first line is ONE line of one height (`min-h-6` matches a row
          of xs buttons): the sentence takes the room left by its actions
          (`basis-0`, so they never wrap under it) and truncates, titled only
          when clipped. Swapping arms never moves what sits below the strip. */}
      <span
        className={cn(
          STRIP_LINE_CLASS,
          conflicting ? "text-warning" : "text-muted-foreground",
        )}
      >
        {/* Decorative throughout — the sentence carries the meaning, and the `updating`
            arm's spinner would otherwise announce a bare "Loading" beside it. */}
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate" onMouseEnter={clipTitleFromText}>
          {ARM_MESSAGE[arm]({
            base,
            head,
            provider,
            behindBy,
            predictedClean,
            forgeUnreachable,
            blockedRequirements,
            blockedApprovals,
            blockedReason,
            promotionKind,
            pendingOffline,
          })}
        </span>
      </span>

      {(conflicting || arm === "resume") && (
        <div className={STRIP_ACTIONS_CLASS}>
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
              disabled={busy || forkBlocked || resolveHeldReason !== undefined}
              reason={forkBlocked ? FORK_BLOCKED_REASON : resolveHeldReason}
              onClick={onResolveWithAi}
            >
              <SparkleIcon data-icon="inline-start" />
              Resolve with AI
            </DisabledReasonButton>
          )}
          <DisabledReasonButton
            variant="ghost"
            size="xs"
            disabled={busy || forkBlocked || resolveHeldReason !== undefined}
            reason={forkBlocked ? FORK_BLOCKED_REASON : resolveHeldReason}
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
        promotionKind === null && (
          <div className={STRIP_ACTIONS_CLASS}>
            <DisabledReasonButton
              variant="ghost"
              size="xs"
              disabled={updateDisabled}
              reason={updateDisabledReason}
              title={updateOperation(base, head)}
              onClick={onUpdateBranch}
            >
              {/* The `updating` arm already spins in the sentence — one progress mark
                per strip, so the button only carries the momentary holds. */}
              {updateBusy && arm !== "updating" && (
                <Spinner data-icon="inline-start" />
              )}
              Update branch
            </DisabledReasonButton>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <DisabledReasonButton
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Update branch options"
                    disabled={updateDisabled}
                    reason={updateDisabledReason}
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
          </div>
        )}

      {(arm === "unknown" || arm === "unreachable") && (
        <div className={STRIP_ACTIONS_CLASS}>
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
      {conflicting && <ConflictFileList files={conflictFiles} />}
    </div>
  );
}

/** What a caller supplies to offer resolving a local PR's conflicts from the strip.
 *  `null` means nothing offers it: the conflicted state then names the
 *  Approve-then-Merge route and renders no action. */
export interface LocalStripResolve {
  /** An unfinished resolve exists for this PR: the strip shows that state, with
   *  Discard and Continue resolving acting on it. */
  unfinished: boolean;
  /** The start call is in flight: the action reads "Preparing…" with a spinner. */
  preparing: boolean;
  /** Why Resolve conflicts, Continue resolving and Discard hold; undefined = enabled.
   *  While `unfinished` it never carries a reason that only blocks a START (a dirty
   *  tree on the checked-out branch): that would hold Discard and Continue too. */
  heldReason: string | undefined;
  /** Start a resolve (conflicted state) or reopen the unfinished one (resume state). */
  onResolve: () => void;
  /** Discard the unfinished resolve; only called from the resume state. */
  onDiscard: () => void;
  /** Advance notice for the START action only: the Resolve button's `title`, and its
   *  description for assistive tech, while that button is enabled. Undefined = none.
   *  Never shown on the resume arm. */
  note?: string;
}

/** The local strip's icons, picked from the remote banner's so the two can't drift. */
const LOCAL_ARM_ICON: Record<
  Exclude<LocalMergeStripArm, null>,
  PhosphorIcon | typeof Spinner
> = {
  checking: ARM_ICON.pending,
  clean: ARM_ICON.clean,
  behind: ARM_ICON.behind,
  "promotion-gap": ARM_ICON.behind,
  conflicted: ARM_ICON.predicted,
  resume: ARM_ICON.resume,
  updating: ARM_ICON.updating,
  failed: ARM_ICON.unchecked,
  unchecked: ARM_ICON.unchecked,
};

/** A starting resolve's label and its hold reason: one wording. */
const PREPARING_LABEL = "Preparing…";

/** The arms whose line carries an Update branch when the caller offers one. */
const LOCAL_UPDATE_ARMS: ReadonlySet<LocalMergeStripArm> = new Set([
  "behind",
  "updating",
  "failed",
  "unchecked",
]);

type LocalArmContext = {
  base: string;
  head: string;
  behindBy: number;
  promotionKind: PromotionKind;
  approved: boolean;
  offerUpdate: boolean;
  offerResolve: boolean;
};

/** The behind clause a failed or impossible check appends, so the Update branch
 *  beside it is explained. */
function trailingBehind({
  base,
  head,
  behindBy,
  offerUpdate,
}: LocalArmContext): ReactNode {
  if (!offerUpdate) return null;
  return <> {behindSentence({ base, head, behindBy, promotionKind: null })}</>;
}

/** The check lines' subject; a record naming no base names no branch. */
function conflictsWith(base: string): ReactNode {
  if (base === "") return "Conflicts";
  return (
    <>
      {"Conflicts with "}
      <span className="font-mono">{base}</span>
    </>
  );
}

/** The line each local arm says. Local copy names no host and no fetch: both reads
 *  are local git, and every step it names is reachable from the state it shows. */
const LOCAL_ARM_MESSAGE: Record<
  Exclude<LocalMergeStripArm, null>,
  (ctx: LocalArmContext) => ReactNode
> = {
  checking: () => CHECKING_MESSAGE,
  clean: ({ base }) => cleanSentence(base),
  behind: ({ base, head, behindBy }) =>
    behindSentence({ base, head, behindBy, promotionKind: null }),
  "promotion-gap": ({ base, head, behindBy, promotionKind }) =>
    behindSentence({ base, head, behindBy, promotionKind }),
  // Without an offered resolve, a merge is what lands the conflicts in the editor,
  // and Merge needs an approval first; an approved PR's line drops that step, since
  // its Approve control would WITHDRAW the approval.
  conflicted: ({ base, approved, offerResolve }) => (
    <>
      {"Merging into "}
      <span className="font-mono">{base}</span>
      {" will conflict."}
      {(() => {
        switch (true) {
          case offerResolve:
            return null;
          case approved:
            return " Merge to resolve the conflicts.";
          default:
            return " Approve, then Merge to resolve the conflicts.";
        }
      })()}
    </>
  ),
  resume: () => "An unfinished conflict resolution exists for this PR.",
  updating: ({ base, head }) => (
    <>
      {"Updating "}
      <span className="font-mono">{head}</span>
      {" from "}
      <span className="font-mono">{base}</span>
      {"…"}
    </>
  ),
  failed: (ctx) => (
    <>
      {conflictsWith(ctx.base)}
      {" can't be checked right now."}
      {trailingBehind(ctx)}
    </>
  ),
  // Fed by "unknown", hence no Retry: a base or head that no longer resolves, an
  // empty merge-tree answer on exit 1, or any other merge-tree exit (git older than
  // 2.38 among them); a record naming no base or head never runs a check.
  unchecked: (ctx) => (
    <>
      {conflictsWith(ctx.base)}
      {" can't be checked."}
      {trailingBehind(ctx)}
    </>
  ),
};

/**
 * The LOCAL pull request's merge strip, the sibling of `PrMergeabilityBanner`: the
 * same root, line, icons and sentences, one state at a time, under the header.
 * Props only; `localMergeStripArm` picks the arm. Its children are FIXED-POSITION
 * conditional siblings (line, Retry box, actions box, file list), so a button that
 * stays across an arm change keeps its DOM node and focus; a box that leaves under
 * focus hands it to the root. No live region: one instance is reused across PRs, so
 * a polite region would announce every switch.
 */
export function LocalPrMergeStrip({
  arm,
  base,
  head,
  promotionKind,
  behindBy,
  conflictFiles,
  approved,
  offerUpdate,
  offerResolve,
  updateHeldReason,
  promotionSettlingReason,
  onUpdateBranch,
  onRetry,
  retryBusy,
  resolve,
}: {
  arm: LocalMergeStripArm;
  base: string;
  head: string;
  promotionKind: PromotionKind;
  /** Commits the base is ahead of the head; 0 when unknown. */
  behindBy: number;
  /** Predicted conflicting paths; may be empty on a conflict. */
  conflictFiles: string[];
  /** The PR is approved: the not-offered conflict line drops its "Approve" step. */
  approved: boolean;
  offerUpdate: boolean;
  offerResolve: boolean;
  /** Why Update branch holds; undefined = enabled. */
  updateHeldReason: string | undefined;
  /** The promotion inputs are still loading: holds a resolve START with this reason. */
  promotionSettlingReason: string | undefined;
  onUpdateBranch: () => void;
  onRetry: () => void;
  /** The conflict preview is fetching. */
  retryBusy: boolean;
  resolve: LocalStripResolve | null;
}): ReactNode {
  const showResolve = arm === "conflicted" && offerResolve && resolve !== null;
  const showResume = arm === "resume" && resolve !== null;
  const showUpdate = offerUpdate && LOCAL_UPDATE_ARMS.has(arm);
  const otherActionsShown = showResolve || showResume || showUpdate;
  // Two rescues, one per box that can leave under focus; both land on the root,
  // whose sentence is the new state.
  const { hostRef: retryHostRef, retryRef } = useRetryFocusRescue(
    arm === "failed",
  );
  const { hostRef: actionsHostRef, retryRef: actionsRef } =
    useRetryFocusRescue(otherActionsShown);
  const messageId = useId();
  const noteId = useId();

  if (arm === null) return null;

  const Icon = LOCAL_ARM_ICON[arm];
  const conflicted = arm === "conflicted";
  // The long lines wrap rather than truncate: a clipped "Approve, then Merge…"
  // would hide the very step the line exists to name, and a clipped "Conflicts
  // with…" would read as a predicted conflict.
  const wraps =
    arm === "promotion-gap" ||
    arm === "failed" ||
    arm === "unchecked" ||
    (conflicted && !offerResolve);
  const message = LOCAL_ARM_MESSAGE[arm]({
    base,
    head,
    behindBy,
    promotionKind,
    approved,
    offerUpdate,
    offerResolve,
  });
  const tone = conflicted ? "text-warning" : "text-muted-foreground";
  const preparing = resolve?.preparing === true;
  const resumeHeldReason = resolve?.heldReason;
  // Resolve's START also waits on the promotion inputs; Continue and Discard act on
  // a resolve that already exists, so only the caller's reason holds them.
  const resolveStartHeld =
    preparing ||
    resumeHeldReason !== undefined ||
    promotionSettlingReason !== undefined;
  const resolveStartReason =
    resumeHeldReason ?? (preparing ? PREPARING_LABEL : promotionSettlingReason);
  // A held start shows its reason, never the notice.
  const note =
    showResolve && !showResume && !resolveStartHeld ? resolve?.note : undefined;
  const resolveLabel = (() => {
    switch (true) {
      case showResume:
        return "Continue resolving";
      case preparing:
        // The label carries the state; an unhidden spinner would name the button
        // "Loading Preparing…".
        return (
          <>
            <Spinner aria-hidden data-icon="inline-start" />
            {PREPARING_LABEL}
          </>
        );
      default:
        return "Resolve conflicts";
    }
  })();

  return (
    <div
      ref={(node) => {
        retryHostRef(node);
        actionsHostRef(node);
      }}
      // Named by its sentence, so it reads without focus; no live region, since
      // one reused strip would re-announce on every PR switch.
      role="group"
      aria-labelledby={messageId}
      tabIndex={-1}
      className={cn(STRIP_ROOT_CLASS, "outline-none")}
    >
      {/* Distinct keys: `clipTitleFromText` sets `title` outside React, so a
          reused text node would carry a stale tooltip into a wrapping arm. */}
      {wraps ? (
        // The first text line sits where a single-line arm's does: `py-1` centres
        // a 16px line in the `min-h-6` row, and `mt-px` the 14px icon beside it.
        <span
          key="wrap"
          className={cn(STRIP_LINE_CLASS, "items-start py-1", tone)}
        >
          <Icon aria-hidden className="mt-px size-3.5 shrink-0" />
          <span id={messageId} className="min-w-0">
            {message}
          </span>
        </span>
      ) : (
        <span key="line" className={cn(STRIP_LINE_CLASS, tone)}>
          <Icon aria-hidden className="size-3.5 shrink-0" />
          <span
            id={messageId}
            className="min-w-0 truncate"
            onMouseEnter={clipTitleFromText}
          >
            {message}
          </span>
        </span>
      )}

      {arm === "failed" && (
        <div ref={retryRef} className={STRIP_ACTIONS_CLASS}>
          <DisabledReasonButton
            variant="ghost"
            size="xs"
            disabled={retryBusy}
            reason={CHECKING_MESSAGE}
            onClick={onRetry}
          >
            Retry
          </DisabledReasonButton>
        </div>
      )}

      {otherActionsShown && (
        <div ref={actionsRef} className={STRIP_ACTIONS_CLASS}>
          {showResume && (
            <DisabledReasonButton
              variant="ghost"
              size="xs"
              disabled={resumeHeldReason !== undefined}
              reason={resumeHeldReason}
              onClick={resolve?.onDiscard}
            >
              Discard
            </DisabledReasonButton>
          )}
          {(showResolve || showResume) && (
            <DisabledReasonButton
              variant="ghost"
              size="xs"
              disabled={
                showResume ? resumeHeldReason !== undefined : resolveStartHeld
              }
              reason={showResume ? resumeHeldReason : resolveStartReason}
              title={note}
              aria-describedby={note === undefined ? undefined : noteId}
              onClick={resolve?.onResolve}
            >
              {resolveLabel}
            </DisabledReasonButton>
          )}
          {showUpdate && (
            <DisabledReasonButton
              variant="ghost"
              size="xs"
              disabled={updateHeldReason !== undefined}
              reason={updateHeldReason}
              title={updateOperation(base, head)}
              onClick={onUpdateBranch}
            >
              <ArrowClockwiseIcon data-icon="inline-start" />
              Update branch
            </DisabledReasonButton>
          )}
          {/* Last, so no button moves when the notice comes and goes. */}
          {note !== undefined && (
            <span id={noteId} className="sr-only">
              {note}
            </span>
          )}
        </div>
      )}

      {/* Last child so it wraps onto its own full-width row beneath the line. */}
      {conflicted && <ConflictFileList files={conflictFiles} nameCount />}
    </div>
  );
}
