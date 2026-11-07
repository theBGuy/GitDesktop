import {
  CheckIcon,
  LockSimpleIcon,
  MinusIcon,
  TreeStructureIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { LabeledGroup } from "@/components/form/labeled-group";
import { RelativeTime, useRelativeNow } from "@/components/relative-time";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { clipTitleFromText } from "@/lib/clip-title";
import { presentError } from "@/lib/error-summary";
import * as api from "@/lib/git/api";
import { normPath } from "@/lib/git/path";
import {
  refuseWhilePushRuns,
  repoKeys,
  repoStatusOptions,
  useBranchContentCheck,
  useBranchDivergence,
  worktreeKey,
} from "@/lib/git/queries";
import type { Branch } from "@/lib/git/types";
import { listWorktrees } from "@/lib/git/worktree";
import { hasChordModifier } from "@/lib/hotkeys/binding";
import { useRovingRows } from "@/lib/list-keyboard-nav";
import { refuseIfSwitched } from "@/lib/stores/notifications";
import {
  type CleanupRemovalOutcome,
  isBranchPromoting,
  plainRemovalPaths,
  promotionBlocksCheckout,
  removeWorktreeForCleanup,
} from "@/lib/stores/worktree-removal";
import { ARIA_DISABLED_CLASS } from "@/lib/use-disabled-reason";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { cn } from "@/lib/utils";
import { PROMOTION_BLOCKS_CHECKOUT } from "./checkout-copy";
import {
  applySettledChecks,
  dropUntouched,
  keepCandidates,
  namesOfKey,
  type SelectionSeed,
  selectAllOver,
  selectionAfterBatch,
  selectionKey,
  selectionStep,
  settledPreCheck,
} from "./cleanup-selection";

type Mode = "archive" | "delete";

/** The list criteria; the list is the union of every enabled one. */
type Criterion = "merged" | "closed" | "idle";
type Criteria = Record<Criterion, boolean>;

const ALL_CRITERIA_ON: Criteria = { merged: true, closed: true, idle: true };

/** Candidate windows offered for the "no commits in N days" staleness signal. */
const AGE_WINDOWS = [30, 60, 90] as const;
const DEFAULT_WINDOW_DAYS = 60;
const DAY_MS = 86_400_000;

/** A linked worktree holding a branch, as the switcher's worktree read reports it. */
interface WorktreeFact {
  path: string;
  isLocked: boolean;
  isMain: boolean;
}

interface Candidate {
  branch: Branch;
  /** Fully merged into the default branch (0 commits it doesn't have). */
  merged: boolean;
  /** Label of the merged pull request this branch's name maps to ("#123"), or
   *  null. Squash and rebase merges leave no ancestor link, so the PR is the
   *  only evidence they landed. */
  prMerged: string | null;
  /** Label of the pull request this branch's name maps to that closed without
   *  merging ("#34"), or null. */
  prClosed: string | null;
  /** Whole days since the branch tip's commit. */
  ageDays: number;
  /** Idle beyond the selected age window. */
  old: boolean;
  /** The worktree a batch removes before acting on this branch; null for a
   *  plain row. */
  worktree: WorktreeFact | null;
}

const branchNoun = (n: number) => (n === 1 ? "branch" : "branches");
const worktreeNoun = (n: number) => (n === 1 ? "worktree" : "worktrees");
const pluralBranches = (n: number) => `${n} ${branchNoun(n)}`;
const pluralWorktrees = (n: number) => `${n} ${worktreeNoun(n)}`;
const branchPronoun = (n: number) => (n === 1 ? "it" : "them");

/**
 * What the dialog is entitled to say about the pull-request half of merged
 * detection: `"unavailable"` — it never ran, so pull requests go unmentioned;
 * `"pending"` — still reading; `"failed"` — the read failed, which is a coverage
 * gap worth naming; `"checked"` — read and complete.
 */
export type PrCheckState = "unavailable" | "pending" | "failed" | "checked";

/**
 * Derives that state from the forge capability and the closed-PR query. It takes
 * `canGh` rather than the query flags alone because a repo whose forge has no
 * pull requests never STARTS the query: its flags are indistinguishable from a
 * finished, empty read, and "we looked and found none" is a claim the app hasn't
 * earned there.
 *
 * `isPending` carries the same weight for a query that HAS started: status-pending
 * means no data yet, which is also how an offline read looks, since react-query's
 * default `networkMode: "online"` PAUSES the fetch rather than failing it
 * (`isFetching` false, `isError` false). Without that arm an offline dialog would
 * claim the pull requests came back clean.
 */
export function prCheckStateFrom(
  canGh: boolean,
  closedPrs: {
    isError: boolean;
    isPending: boolean;
    isFetching: boolean;
    isPlaceholderData: boolean;
  },
): PrCheckState {
  if (!canGh) return "unavailable";
  if (closedPrs.isError) return "failed";
  if (closedPrs.isPending) return "pending";
  // Data in hand, but a background refetch or a previous key's rows: still not an
  // answer about THIS repo's pull requests.
  if (closedPrs.isFetching || closedPrs.isPlaceholderData) return "pending";
  return "checked";
}

/**
 * How far the worktree read behind `worktreeFacts` got. That map is empty until
 * the read lands, so its state is what the dialog holds on: `"pending"` — no
 * answer yet, and a list painted from it could offer a branch the settled answer
 * excludes; `"failed"` — no answer is coming, a coverage gap the dialog names;
 * `"checked"` — the exclusion is real.
 */
export type WorktreeCheckState = "pending" | "failed" | "checked";

/** Derives that state from the worktree query. Absent data covers both a read in
 *  flight and one that never started — the same thing to a caller that has no
 *  answer to act on.
 *
 *  A PARKED read (react-query's offline mode) counts as failed rather than
 *  pending: nothing will resolve it on its own, so the list must paint with the
 *  caveat instead of waiting out the session. `userWorktreesOptions` sets
 *  `networkMode: "always"` for that local git read, and every caller spreads it
 *  (the hook, the switcher's imperative `fetchQuery`, the repo-open warm-up),
 *  which should keep that arm unreachable; this is the net for one that doesn't.
 *
 *  Placeholder data is a stand-in for another key's rows, never an answer about
 *  this repo, so it reads as pending. That query sets no placeholder today; this
 *  is the same net. */
export function worktreeCheckStateFrom(q: {
  isError: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
  isPlaceholderData: boolean;
  data: unknown;
}): WorktreeCheckState {
  if (q.isError) return "failed";
  // Data in hand answers the exclusion even while a refetch is parked behind it.
  if (q.data !== undefined && !q.isPlaceholderData) return "checked";
  if (q.fetchStatus === "paused") return "failed";
  return "pending";
}

/** Whether the default-branch read FAILED with nothing loaded. Sticky across a
 *  refetch of a read that never loaded; a null answer (no default) and an error
 *  over landed data are not failures. */
export function defaultBranchReadFailed(q: {
  data: unknown;
  errorUpdateCount: number;
}): boolean {
  return q.data === undefined && q.errorUpdateCount > 0;
}

/** Why a stale branch can still be off the list, per mode and worktree opt-in —
 *  the empty state names it rather than claiming nothing is stale, which the
 *  branches sitting on disk would contradict. */
const EMPTY_EXCLUDED_REASON: Record<Mode, Record<"on" | "off", string>> = {
  archive: {
    off: "already archived or checked out in another worktree",
    on: "already archived or checked out in the main workspace",
  },
  delete: {
    off: "protected by branch rules, checked out in another worktree, or in a worktree that's being removed",
    on: "protected by branch rules, checked out in the main workspace, or in a worktree that's being removed",
  },
};

const CRITERION_LABEL: Record<"merged" | "closed", string> = {
  merged: "Merged",
  closed: "Closed PR",
};

const NO_CRITERIA_COPY = "Turn on Merged, Closed PR or Idle to list branches.";

/** One string for the empty state, the live region and the held primary while
 *  the default-branch read has failed. */
const DEFAULT_READ_FAILED_COPY =
  "Couldn't read the default branch, so no branches are listed.";

/** The description's pull-request clause. It names pull requests only while
 *  their check counts or is underway: a FAILED check's note says the opposite,
 *  and the two must never disagree. */
const DESCRIPTION_PR_CLAUSE: Record<PrCheckState, string> = {
  checked:
    ", matched to a merged or closed pull request, or with no commits in a while. ",
  pending:
    ", matched to a merged or closed pull request, or with no commits in a while. ",
  failed: " or with no commits in a while. ",
  unavailable: " or with no commits in a while. ",
};

const MODE_SENTENCE: Record<Mode, string> = {
  archive: "Archiving hides them from the switcher — unarchive anytime.",
  delete: "Deleting removes them permanently, including commits only on them.",
};

/** The empty state's merged-clause aside, per PR-check outcome, on the same
 *  terms as the description's clause. The `pending` arm is unreachable (the
 *  skeleton covers the empty state) and mirrors `checked` to keep it total. */
const MERGED_PR_ASIDE: Record<PrCheckState, string> = {
  checked: ", directly or through a recent pull request",
  pending: ", directly or through a recent pull request",
  failed: "",
  unavailable: "",
};

/** The empty state's closed clause claims a pull-request read found nothing, so
 *  it rides the same per-state rule as {@link MERGED_PR_ASIDE}. */
const CLOSED_PR_CLAIM: Record<PrCheckState, boolean> = {
  checked: true,
  pending: true,
  failed: false,
  unavailable: false,
};

/** What follows "No stale branches." when Closed PR is the only criterion on
 *  and its clause is withheld; a failed read's own caveat follows it instead. */
const CLOSED_ONLY_NOTE: Record<PrCheckState, string> = {
  checked: "",
  pending: "",
  failed: "",
  unavailable:
    " Pull requests aren't being read, so Closed PR can't match a branch.",
};

/** Which of the pull-request criteria a pull-request read serves. */
type PrScope = "merged" | "closed" | "both";

function prScope(criteria: Criteria): PrScope {
  if (criteria.merged && criteria.closed) return "both";
  return criteria.merged ? "merged" : "closed";
}

/** What the candidate list is waiting on, per outstanding read. They settle
 *  independently, so the line names the one actually running rather than
 *  whichever came first. The pull-request lines name only the criteria on;
 *  `contained` is the ancestry read while Merged is off, which still decides
 *  which listed rows start checked (Closed PR alone included). */
const CHECKING_COPY: Record<
  PrScope | "contained" | "default" | "worktrees" | "rules",
  string
> = {
  merged: "Checking which branches are merged…",
  closed: "Checking which branches had a pull request closed…",
  both: "Checking which branches are merged or closed through a pull request…",
  contained: "Checking which branches the default branch already contains…",
  default: "Checking which branch is the default…",
  worktrees: "Checking which branches are checked out in another worktree…",
  rules: "Checking branch protection rules…",
};
type CheckingWhat = keyof typeof CHECKING_COPY;

/** A parked pull-request read's line, naming the criteria it serves. */
const WAITING_COPY: Record<PrScope, string> = {
  merged:
    "Waiting for a connection to check which branches were merged through a pull request…",
  closed:
    "Waiting for a connection to check which branches had a pull request closed without merging…",
  both: "Waiting for a connection to check which branches were merged or closed through a pull request…",
};

/** A failed pull-request read's caveats (the status line, then the empty
 *  state's), naming the criteria it serves. */
const PR_FAILED_LINE: Record<PrScope, string> = {
  merged:
    "Pull requests couldn't be checked — a branch merged through one may be missing.",
  closed:
    "Pull requests couldn't be checked — a branch whose pull request was closed may be missing.",
  both: "Pull requests couldn't be checked — a branch merged or closed through one may be missing.",
};
const PR_FAILED_EMPTY_NOTE: Record<PrScope, string> = {
  merged:
    " Pull requests couldn't be checked, so a branch merged through one may be missing here.",
  closed:
    " Pull requests couldn't be checked, so a branch whose pull request was closed may be missing here.",
  both: " Pull requests couldn't be checked, so a branch merged or closed through one may be missing here.",
};

/** Why a worktree row can't be acted on: a locked or dirty worktree refuses
 *  removal without force, and a status read still running or failed has no
 *  answer to act on. */
type WorktreeHold = "locked" | "dirty" | "pending" | "unreadable";

/** Each hold's reason; the pending one reaches AT only, beside its visible
 *  skeleton. */
const WORKTREE_ROW_REASON: Record<WorktreeHold, string> = {
  locked: "Worktree is locked, so it can't be removed.",
  dirty: "Worktree has uncommitted changes, so it can't be removed.",
  pending: "Checking this worktree for uncommitted changes…",
  unreadable: "Couldn't check the worktree for uncommitted changes.",
};

/** The primary's hold reasons, so a held primary stays focusable and says why:
 *  the confirm returns focus to it while a batch runs. Cancel holds with the
 *  running one. */
const PRIMARY_RUNNING_REASON = "Wait for the current batch to finish.";
const PRIMARY_HOLDING_REASON =
  "Wait for the list to finish checking which branches it can act on.";
const PRIMARY_EMPTY_REASON: Record<Mode, string> = {
  archive: "Select a branch to archive.",
  delete: "Select a branch to delete.",
};

const NO_FAILURES: ReadonlyMap<string, string> = new Map();

/** Title-only badge explanations, also handed to AT through the row checkbox's
 *  description. */
const PR_CLOSED_DETAIL = "Closed without merging — matched by branch name";
const prMergedDetail = (label: string) =>
  `Merged via pull request ${label} — matched by branch name`;

/** What a successful removal did with its branch. */
type RemovedBranchOutcome = Extract<
  CleanupRemovalOutcome,
  { ok: true }
>["branch"];

/** Each successful removal's branch outcome: null when the branch went the way
 *  the batch asked, else why it stayed, read after the row's "Couldn't <mode>: "
 *  lead and stating both outcomes. Total, so a new outcome is a type error. */
const KEPT_BRANCH_REASON: Record<RemovedBranchOutcome, string | null> = {
  archived: null,
  deleted: null,
  keptMoved:
    "the worktree was removed, but the branch gained new commits and was kept",
  keptUnreadable:
    "the worktree was removed, but git couldn't delete the branch, so it was kept",
  keptInUse:
    "the worktree was removed, but the branch was checked out again, so it was left unarchived",
};
/** The kept outcomes whose tip the batch saw move or couldn't read, so the
 *  row's verdict no longer describes it. */
const KEPT_TIP_UNVERIFIED: Record<RemovedBranchOutcome, boolean> = {
  archived: false,
  deleted: false,
  keptMoved: true,
  keptUnreadable: true,
  keptInUse: false,
};

const VERDICT_BADGE: Record<
  "clean" | "changes",
  { lead: string; title: string; tone: string; Icon: typeof CheckIcon }
> = {
  clean: {
    lead: "in",
    title: "Nothing on it is missing from",
    tone: "text-success",
    Icon: CheckIcon,
  },
  changes: {
    lead: "changes not in",
    title: "Has changes not in",
    tone: "text-warning",
    Icon: WarningIcon,
  },
};

const verdictDetail = (verdict: "clean" | "changes", baseRef: string) =>
  `${VERDICT_BADGE[verdict].title} ${baseRef}`;

const WORKTREE_BADGE: Record<
  "locked" | "free",
  { word: string; Icon: typeof CheckIcon }
> = {
  locked: { word: "worktree locked", Icon: LockSimpleIcon },
  free: { word: "worktree", Icon: TreeStructureIcon },
};

type ConfirmKind = "delete" | "archiveWorktrees";

/** The batch a confirm acts on, counted once when it opens. */
interface ConfirmBatch {
  kind: ConfirmKind;
  /** The repo the confirm opened in; it never acts in another. */
  repoPath: string;
  names: string[];
  /** Branch → the worktree the confirm counted for it. The batch removes
   *  exactly these; a name missing here is acted on as a plain branch. */
  worktreePaths: ReadonlyMap<string, string>;
  changes: number;
  /** The ref `changes` was measured against. */
  baseRef: string;
}

const CONFIRM_TITLE: Record<ConfirmKind, (batch: ConfirmBatch) => string> = {
  delete: (b) => `Delete ${branchNoun(b.names.length)}?`,
  archiveWorktrees: (b) => `Remove ${worktreeNoun(b.worktreePaths.size)}?`,
};

const WORKTREE_FOLDER_NOTE =
  "Removing a worktree deletes its folder, including ignored files such as build output.";
/** The confirm button says what the title asks. */
const CONFIRM_LABEL: Record<ConfirmKind, (batch: ConfirmBatch) => string> = {
  delete: (b) => `Delete ${pluralBranches(b.names.length)}`,
  archiveWorktrees: (b) =>
    `Remove and archive ${pluralBranches(b.names.length)}`,
};
const CONFIRM_VARIANT: Record<ConfirmKind, "default" | "destructive"> = {
  delete: "destructive",
  archiveWorktrees: "default",
};
const CONFIRM_REFUSED: Record<ConfirmKind, string> = {
  delete: "nothing was deleted",
  archiveWorktrees: "nothing was archived",
};

/** Why a confirmed name was skipped at its turn: it became the branch the
 *  list never offers after the confirm captured it. */
type SkipReason = "default" | "current";
const SKIPPED_TOAST: Record<SkipReason, (name: string) => string> = {
  default: (name) => `Skipped ${name} — it's now the default branch.`,
  current: (name) => `Skipped ${name} — it's now checked out.`,
};

/** Left/Right step and Home/End jump across a control group's buttons; plain
 *  focus movement, no state. */
const GROUP_KEY_STEP: Partial<
  Record<string, (at: number, count: number) => number>
> = {
  ArrowLeft: (at) => Math.max(at - 1, 0),
  ArrowRight: (at, count) => Math.min(at + 1, count - 1),
  Home: () => 0,
  End: (_, count) => count - 1,
};

function moveFocusInGroup(e: KeyboardEvent<HTMLElement>) {
  const step = GROUP_KEY_STEP[e.key];
  if (step === undefined || hasChordModifier(e)) return;
  const buttons = Array.from(e.currentTarget.querySelectorAll("button"));
  const at = buttons.findIndex((b) => b === e.target);
  if (at === -1) return;
  e.preventDefault();
  buttons[step(at, buttons.length)]?.focus();
}

/** Each captioned control row sits in the parent grid's two columns: caption
 *  left, controls right. A subgrid keeps the group's role, which
 *  `display: contents` would drop. */
const CONTROL_ROW =
  "col-span-2 grid grid-cols-subgrid items-center gap-x-3 space-y-0 [&>label]:text-muted-foreground";

/** The one-line status above the candidate list while a check it depends on
 *  runs. A parked check has no progress to report, so it names what it's waiting
 *  on rather than implying the read is underway — and only the pull-request half
 *  can park, since the other reads work on local data. */
function CheckingLine({
  what,
  waitingOn,
  srOnly,
}: {
  what: CheckingWhat;
  /** The parked pull-request read's scope when no local read the list waits
   *  on (default branch, worktrees, branch rules, ancestry) is running, else
   *  null. */
  waitingOn: PrScope | null;
  /** AT-only while the skeleton paints, whatever un-hides the region. */
  srOnly: boolean;
}) {
  return (
    <p
      className={
        srOnly ? "sr-only" : "px-1 py-1 text-[11px] text-muted-foreground"
      }
    >
      {waitingOn === null ? CHECKING_COPY[what] : WAITING_COPY[waitingOn]}
    </p>
  );
}

/** First paint while a check the list depends on runs. An animated skeleton over
 *  a parked pull-request read would be a false activity signal, so a parked read
 *  paints nothing here — the status region above already names what it's waiting
 *  on. */
function CheckingPlaceholder({ paused }: { paused: boolean }) {
  if (paused) return null;
  return (
    <div className="space-y-1 py-2" aria-busy>
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-7 animate-pulse rounded-none bg-muted/50" />
      ))}
    </div>
  );
}

/** The check mark a pressed criterion shows, or the space it keeps when not. */
function ChipMark({ on }: { on: boolean }) {
  return on ? (
    <CheckIcon weight="bold" aria-hidden className="size-3 text-primary" />
  ) : (
    <span aria-hidden className="size-3" />
  );
}

/** A row's verdict slot; null: no slot (ancestry-merged, or the check is
 *  unsupported). */
type RowVerdict = api.ContentVerdict | "pending" | null;

/** A row's second line: a word for every reason that applies, in a fixed
 *  order, then its content verdict. Words carry the meaning — color never
 *  stands alone. */
function RowBadges({
  candidate: c,
  error,
  verdict,
  baseRef,
}: {
  candidate: Candidate;
  error: string | undefined;
  verdict: RowVerdict;
  /** The ref the verdicts were measured against, as git names it. */
  baseRef: string;
}) {
  const words: { key: string; node: ReactNode }[] = [];
  if (error)
    words.push({
      key: "failed",
      node: (
        <span className="flex items-center gap-1 text-destructive">
          <WarningCircleIcon weight="fill" className="size-3" aria-hidden />
          failed
        </span>
      ),
    });
  if (c.old)
    words.push({
      key: "idle",
      node: <span className="text-muted-foreground">idle</span>,
    });
  if (c.merged)
    words.push({
      key: "merged",
      node: <span className="text-merged">merged</span>,
    });
  if (c.prMerged)
    words.push({
      key: "pr-merged",
      node: (
        <span className="text-merged" title={prMergedDetail(c.prMerged)}>
          merged {c.prMerged}
        </span>
      ),
    });
  if (c.prClosed)
    words.push({
      key: "pr-closed",
      node: (
        <span className="text-muted-foreground" title={PR_CLOSED_DETAIL}>
          closed {c.prClosed}
        </span>
      ),
    });
  if (c.worktree) {
    const w = WORKTREE_BADGE[c.worktree.isLocked ? "locked" : "free"];
    words.push({
      key: "worktree",
      node: (
        <span className="flex items-center gap-0.5 text-muted-foreground">
          <w.Icon aria-hidden className="size-3" />
          {w.word}
        </span>
      ),
    });
  }
  if (verdict === "pending")
    words.push({
      key: "verdict",
      node: (
        <span
          aria-hidden
          className="inline-block h-2.5 w-14 animate-pulse bg-muted"
        />
      ),
    });
  else if (verdict === "clean" || verdict === "changes") {
    const v = VERDICT_BADGE[verdict];
    words.push({
      key: "verdict",
      node: (
        <span
          className={cn("flex items-center gap-0.5", v.tone)}
          title={verdictDetail(verdict, baseRef)}
        >
          <v.Icon weight="bold" aria-hidden className="size-3" />
          <span>
            {v.lead} <span className="font-mono">{baseRef}</span>
          </span>
        </span>
      ),
    });
  }
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 pl-6 text-[11px]">
      {words.map(({ key, node }, i) => (
        <Fragment key={key}>
          {i > 0 ? (
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
          ) : null}
          {node}
        </Fragment>
      ))}
    </span>
  );
}

/** The separator before clause `i`: a comma between, and "and" before the last,
 *  with a comma when three or more clauses run or the one before carries an
 *  aside that needs closing. */
function clauseJoin(i: number, last: number, prevAside: boolean): string {
  if (i < last) return ", ";
  return last >= 2 || prevAside ? ", and " : " and ";
}

/** The no-match empty state, composed from the ENABLED criteria only, so it
 *  never claims a check the user turned off. */
function NoMatchCopy({
  criteria,
  defaultShort,
  prCheckState,
  windowDays,
}: {
  criteria: Criteria;
  defaultShort: string;
  prCheckState: PrCheckState;
  windowDays: number;
}) {
  const aside = MERGED_PR_ASIDE[prCheckState];
  const clauses: { key: Criterion; aside: boolean; node: ReactNode }[] = [];
  if (criteria.merged)
    clauses.push({
      key: "merged",
      aside: aside !== "",
      node: (
        <>
          merged into <span className="font-mono">{defaultShort}</span>
          {aside}
        </>
      ),
    });
  if (criteria.closed && CLOSED_PR_CLAIM[prCheckState])
    clauses.push({
      key: "closed",
      aside: false,
      node: "matched to a pull request closed without merging",
    });
  if (criteria.idle)
    clauses.push({
      key: "idle",
      aside: false,
      node: `idle for ${windowDays} days`,
    });
  // Only a withheld closed clause leaves none: this renders with a criterion on.
  if (clauses.length === 0)
    return <>{`No stale branches.${CLOSED_ONLY_NOTE[prCheckState]}`}</>;
  const last = clauses.length - 1;
  return (
    <>
      {"No stale branches — "}
      {clauses.map((c, i) => (
        <Fragment key={c.key}>
          {i > 0 ? clauseJoin(i, last, clauses[i - 1].aside) : null}
          {"nothing is "}
          {c.node}
        </Fragment>
      ))}
      {"."}
      {criteria.idle && windowDays > AGE_WINDOWS[0]
        ? " Try a shorter window."
        : null}
    </>
  );
}

/** A confirm's body, from the snapshot it opened with. */
function ConfirmBody({ batch }: { batch: ConfirmBatch }) {
  const branches = pluralBranches(batch.names.length);
  const worktrees = batch.worktreePaths.size;
  if (batch.kind === "archiveWorktrees")
    return (
      <>
        {`Removes ${pluralWorktrees(worktrees)}, then archives ${branches}. ${WORKTREE_FOLDER_NOTE} `}
        Archived branches can be unarchived anytime.
      </>
    );
  const count = batch.names.length;
  const changesLead =
    count === 1
      ? "It has"
      : `${batch.changes} of the branches ${batch.changes === 1 ? "has" : "have"}`;
  const lead =
    worktrees > 0
      ? `Removes ${pluralWorktrees(worktrees)} and deletes ${branches}`
      : `Permanently deletes ${branches}`;
  return (
    <>
      {`${lead}, including commits that exist only on ${branchPronoun(count)}.`}
      {worktrees > 0 ? ` ${WORKTREE_FOLDER_NOTE}` : null}
      {batch.changes > 0 ? (
        <>
          {` ${changesLead} changes not in `}
          <span className="font-mono">{batch.baseRef}</span>.
        </>
      ) : null}
      {" This can't be undone."}
    </>
  );
}

/**
 * Bulk "clean up branches" dialog, launched from the branch switcher. Lists the
 * local branches matching any enabled criterion — **merged** into the default
 * branch (by ancestry or a merged pull request), matched to a pull request
 * **closed** without merging, or **idle** past the selected window — and lets
 * the user Archive (reversible hide via the `gitdesktopArchived` flag) or Delete
 * (`git branch -D`) the selected set in one pass. The current branch, the
 * default branch and `gd/session/*` branches are never candidates. A branch
 * checked out in a linked worktree is listed only under the worktree opt-in,
 * which removes that worktree first (never forced), except one whose worktree
 * is already being removed: Archive lists it as a plain row whatever the opt-in
 * says. Archive also skips already-archived branches, and Delete skips
 * rule-protected ones.
 *
 * Pre-checks stay safety-first: ancestry-merged rows seed checked; idle and
 * pull-request rows wait for their content verdict; worktree rows never seed.
 */
export function CleanupBranchesDialog({
  repoPath,
  open,
  onClose,
  branches,
  defaultBranch,
  defaultBranchFailed,
  currentBranch,
  isProtected,
  worktreeFacts,
  isWorktreeRemoving,
  worktreeCheckState,
  rulesSettling,
  prMergedByBranch,
  prClosedByBranch,
  prCheckState,
  prCheckPaused,
}: {
  repoPath: string;
  open: boolean;
  onClose: () => void;
  branches: Branch[];
  /** undefined only while the default-branch read is loading; null once it
   *  settled with none or with an error. */
  defaultBranch: string | null | undefined;
  /** True while that read has failed with nothing loaded
   *  ({@link defaultBranchReadFailed}), sticky across its refetch. The list
   *  then shows nothing and says why, since it can't keep a default it can't
   *  name off the list; a settled null with this false still lists. */
  defaultBranchFailed: boolean;
  currentBranch: string | null;
  /** True when a branch is blocked from deletion by an effective branch rule. */
  isProtected: (name: string) => boolean;
  /** Branches checked out in another worktree → that worktree. git can't delete
   *  a checked-out branch and archiving would hide one in use, so a held branch
   *  is listed only under the worktree opt-in, and never when the main
   *  workspace holds it, since git can't remove that one. */
  worktreeFacts: Map<string, WorktreeFact>;
  /** True when the worktree holding this branch is already being removed, read
   *  from the removal store rather than the worktree list, which goes on listing
   *  that worktree until the removal finishes. Whatever the opt-in says, Archive
   *  takes it back as a plain row — the branch is on its way out of use — while
   *  Delete keeps excluding it: git refuses `branch -D` on a checked-out
   *  branch, and the removal can still fail. */
  isWorktreeRemoving: (name: string) => boolean;
  /** Whether {@link worktreeFacts} has an answer yet. An advisory read that
   *  would have refused an action must be held on, never acted around: while
   *  this is `"pending"` the map is a stand-in that excludes nothing, so the
   *  list neither paints nor pre-selects. (`useEffectiveBranchRulesSettling`
   *  carries the same contract for the branch rules behind `isProtected`.) */
  worktreeCheckState: WorktreeCheckState;
  /** Whether {@link isProtected} has an answer yet — the branch-rules half of
   *  that same contract, from `useEffectiveBranchRulesSettling`. While true the
   *  effective rules stand in as empty, so the predicate excludes nothing and
   *  the list neither paints nor pre-selects. A FAILED rules read is
   *  deliberately not held on: it falls open inside that hook, since nothing
   *  would ever arrive to lift the hold. */
  rulesSettling: boolean;
  /** Branch name → the label of the merged pull request it maps to ("#123").
   *  Name-keyed and limited to the PRs the app has fetched, so it labels rows,
   *  never selects them without a clean content verdict. */
  prMergedByBranch: Map<string, string>;
  /** Branch name → the label of the pull request it maps to that closed
   *  without merging ("#34"), any base. Name-keyed like
   *  {@link prMergedByBranch}. */
  prClosedByBranch: Map<string, string>;
  /** How far the pull-request half of merged detection got. Every line that
   *  mentions pull requests renders off this: a read that failed says so, and
   *  one that never ran leaves them out rather than passing for a clean check. */
  prCheckState: PrCheckState;
  /** True when the pull-request read is parked on a missing connection rather
   *  than in flight. It only retitles the waiting copy — the check itself
   *  resumes on its own once the connection returns. */
  prCheckPaused: boolean;
}) {
  const queryClient = useQueryClient();
  // Prefix for each row's reason ids (hooks stay out of the row map).
  const baseId = useId();
  // Shared 30s clock: the idle-past-the-window classification below must
  // re-evaluate as time passes, and a render-position `Date.now()` is invisible
  // to the React Compiler, so a branch crossing the window never becomes stale.
  const now = useRelativeNow();
  const [mode, setMode] = useState<Mode>("archive");
  const [criteria, setCriteria] = useState<Criteria>(ALL_CRITERIA_ON);
  const [includeWorktrees, setIncludeWorktrees] = useState(false);
  const [windowDays, setWindowDays] = useState<number>(DEFAULT_WINDOW_DAYS);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Snapshotted when a confirm opens, so a verdict landing under it changes
  // neither its counts nor the set it acts on.
  const [confirmBatch, setConfirmBatch] = useState<ConfirmBatch | null>(null);
  // The last confirm shown, so its copy holds through the close animation.
  const [shownConfirm, setShownConfirm] = useState<ConfirmBatch | null>(null);
  // runBatch takes no parameters, so a confirmed set and the worktree rows the
  // confirm counted reach it here; it consumes the ref before its first await.
  const confirmedRef = useRef<Pick<
    ConfirmBatch,
    "names" | "worktreePaths"
  > | null>(null);
  // Batch progress + per-branch failures (kept visible so a partial run is honest).
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [failed, setFailed] = useState<Map<string, string>>(new Map());
  // The repo `failed` was written in: the dialog outlives a repo switch and a
  // batch can settle after one, so its lines render only in that repo.
  const [failedIn, setFailedIn] = useState<string | null>(null);
  // The rows a running batch renders, their verdict slots and its actionable
  // names, frozen at its start: its own removal marks would otherwise reclassify
  // rows under it, drop a row's verdict and move the counts. Rows leave on the
  // refetch. A fully successful batch closes the dialog still frozen, so the
  // close never paints the refetching list; the next open clears it.
  const [frozen, setFrozen] = useState<{
    rows: Candidate[];
    verdicts: ReadonlyMap<string, RowVerdict>;
    actionable: readonly string[];
    /** The ref those verdicts were measured against: a switch or the close's
     *  reset moves the live one. */
    baseRef: string;
  } | null>(null);
  const running = progress !== null;
  // The snapshot paints only while it applies: under its run, and through the
  // close a full success starts. A reopen paints the live list from its first
  // frame, before the seed clears the snapshot.
  const shownFrozen = frozen !== null && (running || !open) ? frozen : null;
  // Rows the user toggled since the last seed; a settled verdict never checks
  // one, so a landing can't override the user's choice.
  const touchedRef = useRef<Set<string>>(new Set());
  // Untouched rows the settled-verdict pass checked. A reopen drops them, so a
  // previous open's verdict never checks a row this open hasn't measured.
  const autoCheckedRef = useRef<Set<string>>(new Set());
  // Rows whose worktree a batch removed but whose branch it kept (moved,
  // undeletable, or checked out again): the user's choice on them was spent,
  // so nothing re-checks them for the rest of the open, a reseed included.
  const keptRef = useRef<Set<string>>(new Set());
  // The kept rows whose tip the batch saw move or couldn't read, for render:
  // their verdict no longer describes them, so they show none and a confirm
  // counts them as having changes. A row kept in use keeps its verdict.
  const [tipUnverified, setTipUnverified] = useState<ReadonlySet<string>>(
    new Set(),
  );
  // Kept rows touched by the batch rather than the user: the next open releases
  // them, so its own verdict decides; a user toggle since makes the touch theirs.
  const keptTouchRef = useRef<Set<string>>(new Set());

  useSeedOnOpen(open, () => {
    setMode("archive");
    setCriteria(ALL_CRITERIA_ON);
    setIncludeWorktrees(false);
    setWindowDays(DEFAULT_WINDOW_DAYS);
    setFailed(new Map());
    setConfirmBatch(null);
    setFrozen(null);
    keptRef.current.clear();
    setTipUnverified(new Set());
    for (const n of keptTouchRef.current) touchedRef.current.delete(n);
    keptTouchRef.current.clear();
    const carried = autoCheckedRef.current;
    autoCheckedRef.current = new Set();
    setSelected((prev) => dropUntouched(prev, carried, touchedRef.current));
  });

  // The dialog outlives a repo switch while runBatch follows the live repoPath,
  // so a confirm opened in one repo closes rather than act in another.
  useEffect(() => {
    setConfirmBatch((c) => (c !== null && c.repoPath !== repoPath ? null : c));
  }, [repoPath]);

  // A loading default branch excludes nothing and gates no divergence, so the
  // list holds on it like the worktree and rules reads. A failed one lists
  // nothing and says why instead, never a hold: no answer is coming until a
  // refetch succeeds. A settled null (no default) still lists.
  const defaultFailed =
    defaultBranchFailed && typeof defaultBranch !== "string";
  const defaultLoading = defaultBranch === undefined && !defaultFailed;
  const defaultOrNull = defaultBranch ?? null;
  const defaultShort = defaultOrNull ?? "the default branch";

  // Merged-into-default comes straight from divergence: a branch with 0 commits
  // the default branch lacks is fully contained in it. Fetched only while open.
  const divergence = useBranchDivergence(repoPath, defaultOrNull, open);
  const mergedSet = useMemo(
    () =>
      new Set(
        (divergence.data ?? [])
          // ahead 0 = no commits the default branch lacks, AND behind > 0 = the
          // default has since moved past it. Requiring behind > 0 keeps a
          // brand-new branch still sitting on the default tip (ahead 0, behind 0)
          // from being mislabeled "merged".
          .filter((d) => d.ahead === 0 && d.behind > 0)
          .map((d) => d.name),
      ),
    [divergence.data],
  );

  // Branches matching an enabled criterion, before the per-mode exclusions.
  // Never the current or default branch, never the app-internal session
  // branches.
  const stale = useMemo(() => {
    const out: Candidate[] = [];
    if (defaultFailed) return out;
    for (const b of branches) {
      if (
        b.isCurrent ||
        b.name === currentBranch ||
        b.name === defaultOrNull ||
        b.name.startsWith("gd/session/")
      )
        continue;
      const ts = Date.parse(b.lastCommitDate);
      const ageDays = Number.isFinite(ts) ? Math.floor((now - ts) / DAY_MS) : 0;
      const merged = mergedSet.has(b.name);
      const prMerged = prMergedByBranch.get(b.name) ?? null;
      const prClosed = prClosedByBranch.get(b.name) ?? null;
      const old = ageDays >= windowDays;
      if (
        (criteria.merged && (merged || prMerged)) ||
        (criteria.closed && prClosed) ||
        (criteria.idle && old)
      )
        out.push({
          branch: b,
          merged,
          prMerged,
          prClosed,
          ageDays,
          old,
          worktree: null,
        });
    }
    return out;
  }, [
    branches,
    criteria,
    currentBranch,
    defaultFailed,
    defaultOrNull,
    mergedSet,
    now,
    prClosedByBranch,
    prMergedByBranch,
    windowDays,
  ]);

  // Mode-specific candidates. Archive drops already-archived branches (a
  // no-op); Delete drops rule-protected ones (they'd fail anyway) but keeps
  // archived ones (a final sweep may want them). A branch held by a worktree
  // already being removed stays a plain row in Archive and out of Delete;
  // otherwise a held branch is a worktree row under the opt-in, never when the
  // main workspace holds it.
  const candidates = useMemo(() => {
    const list: Candidate[] = [];
    for (const c of stale) {
      const name = c.branch.name;
      if (mode === "archive" ? c.branch.archived : isProtected(name)) continue;
      const held = worktreeFacts.get(name);
      if (held === undefined) list.push(c);
      else if (isWorktreeRemoving(name)) {
        if (mode === "archive") list.push(c);
      } else if (includeWorktrees && !held.isMain)
        list.push({ ...c, worktree: held });
    }
    // Merged first (the safest to clean), then oldest first.
    return list.sort((a, b) => {
      if (a.merged !== b.merged) return a.merged ? -1 : 1;
      return b.ageDays - a.ageDays;
    });
  }, [
    stale,
    mode,
    isProtected,
    worktreeFacts,
    isWorktreeRemoving,
    includeWorktrees,
  ]);
  // What the list renders: the frozen rows while a batch runs.
  const rows = shownFrozen?.rows ?? candidates;

  // No `tabAdvances`: Tab must keep reaching the dialog's other controls (mode,
  // criteria, select-all, footer buttons). Held worktree rows stay in the order,
  // focusable, so they can explain why they won't toggle.
  const nav = useRovingRows({
    items: rows,
    rowKey: (c) => c.branch.name,
  });

  // A worktree row is actionable only once a status read this observer fetched
  // calls its worktree clean and no refetch runs over it: a cached answer, or a
  // pending or failed read, has no answer to act on. Every enable refetches
  // (staleTime 0), and the opt-in starts off each open, so the answer is this
  // open's. Locked worktrees need no read. The removal re-checks at fire time.
  const statusPaths = rows.flatMap((c) =>
    c.worktree && !c.worktree.isLocked ? [c.worktree.path] : [],
  );
  const statusReads = useQueries({
    queries: statusPaths.map((path) => ({
      ...repoStatusOptions(path),
      staleTime: 0,
      enabled: open && includeWorktrees && !running,
    })),
  });
  const statusByPath = new Map(
    statusPaths.map((path, i) => [path, statusReads[i]] as const),
  );
  function worktreeHold(c: Candidate): WorktreeHold | null {
    if (c.worktree === null) return null;
    if (c.worktree.isLocked) return "locked";
    const read = statusByPath.get(c.worktree.path);
    // Freshness first: a cached failure is no more this open's answer than a
    // cached clean one.
    if (read === undefined || read.isFetching || !read.isFetchedAfterMount)
      return "pending";
    if (read.isError) return "unreadable";
    if (read.data === undefined) return "pending";
    return read.data.entries.length > 0 ? "dirty" : null;
  }

  // Until the worktree read lands, `worktreeFacts` excludes nothing, so every
  // candidate below is provisional — the list stays behind the skeleton and the
  // selection stays unseeded rather than offering a row the answer would remove.
  const checkingWorktrees = worktreeCheckState === "pending";
  // Settling rules hold exactly as a pending worktree read does — `isProtected`
  // excludes nothing until they land. Held in BOTH modes: rules settle within
  // moments of opening the repo while this dialog opens later, and the mode can
  // flip while it is open, so a delete-only hold buys nothing and can miss.
  const holdingReads = checkingWorktrees || rulesSettling || defaultLoading;

  // Every ACTIONABLE row: held worktree rows render but stay out of the count,
  // Select all and the batch.
  const candidateNames = candidates
    .filter((c) => worktreeHold(c) === null)
    .map((c) => c.branch.name);
  // What the post-batch prune keeps: listed rows not held for good. A status
  // read in flight holds a row only until it lands, and every batch's end
  // re-reads them, so a pending row keeps its check for a retry.
  const keepableKey = selectionKey(
    candidates
      .filter((c) => {
        const hold = worktreeHold(c);
        return hold === null || hold === "pending";
      })
      .map((c) => c.branch.name),
  );
  // Pre-checked at seed: the rows this repo's own history proves are done
  // with. A worktree row never seeds, and the opt-in must not move this set.
  const autoSelectNames = useMemo(
    () =>
      candidates
        .filter((c) => c.merged && !c.worktree)
        .map((c) => c.branch.name),
    [candidates],
  );
  // Content verdicts for every row ancestry doesn't already prove merged; the
  // hook latches each branch's first settled verdict for the open, so a landed
  // verdict never changes within it.
  const checkNames = useMemo(
    () => candidates.filter((c) => !c.merged).map((c) => c.branch.name),
    [candidates],
  );
  // A failed read passes as still loading, so the open latches the name a
  // recovery brings rather than null, which would end the check for the open.
  const check = useBranchContentCheck(
    repoPath,
    defaultFailed ? undefined : defaultBranch,
    checkNames,
    open,
  );
  // The selection re-seeds when the repo changes, or when the pre-checked SET
  // (sorted keys, so a new-but-equal array or a reorder on the 30s clock isn't
  // one) changes across a control change or a reopen; new data that moves the
  // set within one open merges only the change, keeping the user's touches. A
  // close and reopen over the same set, an `<Activity>` re-show or a held-read
  // flap keeps the user's choices. After a batch that leaves the dialog open,
  // until the user changes a control or closes it, a changed set only prunes
  // names no longer listed, or held for good (dirty, locked, unreadable); a
  // pending read holds only for now (cleanup-selection.ts).
  const autoSelectKey = selectionKey(autoSelectNames);
  // The user's own controls; a batch's refetch changes none of them.
  const selectionContext = `${mode}\n${windowDays}\n${criteria.merged ? 1 : 0}${criteria.closed ? 1 : 0}${criteria.idle ? 1 : 0}\n${includeWorktrees ? 1 : 0}`;
  // Rows a settled verdict pre-checks: idle and pull-request rows, never a
  // worktree row. The fallback stands in when the check is unsupported or a
  // verdict comes back unknown, never while one is pending, and idleness counts
  // only while Idle is on: a row listed through a pull request alone starts
  // unchecked.
  const shouldCheckKey = selectionKey(
    candidates
      .filter((c) => {
        if (c.worktree || c.merged) return false;
        const fallback = criteria.idle && c.old;
        if (check.status === "unsupported") return fallback;
        const v = check.verdicts.get(c.branch.name);
        return v !== undefined && settledPreCheck(v, fallback);
      })
      .map((c) => c.branch.name),
  );
  // A ref: the policy's memory must survive renders without causing them.
  const selectionSeed = useRef<SelectionSeed>({
    repo: null,
    seededKey: null,
    afterBatch: null,
    context: null,
  });
  // Read at a reseed or merge only: the seed step must not re-run on every
  // landing.
  const settledCheckNames = useEffectEvent(() => namesOfKey(shouldCheckKey));
  useEffect(() => {
    // Never under a running batch, nor off a stand-in exclusion: the seed
    // re-runs once those reads land and the excluded rows are really gone.
    const prevRepo = selectionSeed.current.repo;
    const prevKey = selectionSeed.current.seededKey;
    const step = selectionStep(selectionSeed.current, {
      repo: repoPath,
      open,
      running,
      holdingReads,
      context: selectionContext,
      autoKey: autoSelectKey,
    });
    selectionSeed.current = {
      repo: step.repo,
      seededKey: step.seededKey,
      afterBatch: step.afterBatch,
      context: step.context,
    };
    // Every unheld step, whatever its action: an ancestry name is never a
    // verdict-only check, so a reopen never drops a check the ancestry key
    // proves, which no verdict would restore (ancestry rows get none).
    if (open && !running && !holdingReads)
      for (const n of namesOfKey(autoSelectKey))
        autoCheckedRef.current.delete(n);
    if (step.action === "reseed") {
      // A reseed forgets the user's touches, except on rows a batch kept in
      // this repo, and re-applies the settled verdicts in the same write: the
      // verdict effect below runs only when they change. A kept row stays out
      // of the ancestry seed too: its worktree's removal can make it one.
      if (step.repo !== prevRepo) {
        keptRef.current.clear();
        setTipUnverified(new Set());
        setFailed(new Map());
      }
      touchedRef.current = new Set(keptRef.current);
      keptTouchRef.current = new Set(keptRef.current);
      const want = settledCheckNames().filter(
        (n) => !touchedRef.current.has(n),
      );
      autoCheckedRef.current = new Set(want);
      setSelected(
        applySettledChecks(
          new Set(
            namesOfKey(autoSelectKey).filter((n) => !keptRef.current.has(n)),
          ),
          touchedRef.current,
          want,
        ),
      );
    } else if (step.action === "merge") {
      // Only new data moved the set: the user's touches stand. A name leaving
      // it drops only if untouched; one entering is added unless touched or
      // kept; the settled verdicts are re-applied on the same terms.
      const before = new Set(namesOfKey(prevKey ?? ""));
      const after = new Set(namesOfKey(autoSelectKey));
      const left = new Set([...before].filter((n) => !after.has(n)));
      const entered = [...after].filter(
        (n) => !before.has(n) && !keptRef.current.has(n),
      );
      const want = settledCheckNames().filter(
        (n) => !touchedRef.current.has(n),
      );
      for (const n of want) autoCheckedRef.current.add(n);
      setSelected((prev) =>
        applySettledChecks(
          dropUntouched(prev, left, touchedRef.current),
          touchedRef.current,
          [...entered, ...want],
        ),
      );
    } else if (step.action === "prune")
      setSelected((prev) => keepCandidates(prev, keepableKey));
  }, [
    repoPath,
    open,
    autoSelectKey,
    keepableKey,
    selectionContext,
    running,
    holdingReads,
  ]);
  // Settled verdicts only ever ADD untouched rows, so a landing never reseeds,
  // never unchecks, and never checks a row the user unchecked.
  useEffect(() => {
    if (running || holdingReads || shouldCheckKey === "") return;
    const want = namesOfKey(shouldCheckKey).filter(
      (n) => !touchedRef.current.has(n),
    );
    for (const n of want) autoCheckedRef.current.add(n);
    setSelected((prev) => applySettledChecks(prev, touchedRef.current, want));
  }, [shouldCheckKey, running, holdingReads]);
  // A worktree row stays checked only by the user's hand: a row checked
  // automatically while it was plain loses that check when a worktree read
  // shows a checkout holding it, since removing its folder was never chosen.
  const worktreeRowKey = selectionKey(
    candidates.filter((c) => c.worktree !== null).map((c) => c.branch.name),
  );
  useEffect(() => {
    if (running || worktreeRowKey === "") return;
    const rows = new Set(namesOfKey(worktreeRowKey));
    setSelected((prev) => dropUntouched(prev, rows, touchedRef.current));
  }, [worktreeRowKey, running]);

  const noCriteria = !criteria.merged && !criteria.closed && !criteria.idle;
  // Pull requests feed only the Merged and Closed PR criteria, so their read
  // holds nothing while both are off.
  const prMatters = criteria.merged || criteria.closed;
  // First load: a merged signal still in flight and nothing has surfaced yet.
  // Age-based candidates already show instantly (branch data is cached), so this
  // only gates the truly-empty first paint.
  const prPending = prMatters && prCheckState === "pending";
  const ancestryLoading = Boolean(defaultOrNull) && divergence.isLoading;
  const checkingMerged = ancestryLoading || prPending;
  // Local reads run offline too, so one still running outranks a parked
  // pull-request read: its line and skeleton show instead of the wait.
  const localRunning = holdingReads || ancestryLoading;
  // Parked counts only for a pull-request read still pending, the list's actual
  // wait: a parked background refetch over settled data has nothing to wait
  // for, and its connection copy would answer for the local reads still running.
  const pausedMergedCheck = prPending && prCheckPaused;
  // The running merged-or-closed check's line: a pull-request read names the
  // criteria it serves; the ancestry read alone serves Merged, or while Merged
  // is off still decides which listed rows start checked (Closed PR alone
  // included), so it claims no merged check.
  function mergedCheckLine(): CheckingWhat {
    if (prPending) return prScope(criteria);
    return ancestryCheckLine();
  }
  function ancestryCheckLine(): CheckingWhat {
    return criteria.merged ? "merged" : "contained";
  }
  // A failed default read outranks every other wait: nothing lists until it
  // recovers, whatever else lands.
  const stillChecking =
    !noCriteria && !defaultFailed && (checkingMerged || holdingReads);
  const showPrFailedLine =
    prCheckState === "failed" && prMatters && candidates.length > 0;
  // While a failed default read lists nothing, the caveats about what the list
  // may hold have nothing to qualify; a frozen batch's rows keep them.
  const caveatsApply = rows.length > 0 || !defaultFailed;
  // Unlike the pull-request caveat, this one shows on an empty list too: a
  // failed read leaves the exclusion vacuous, which the empty state's own copy
  // would otherwise assert as real.
  const worktreeCheckFailed = worktreeCheckState === "failed" && caveatsApply;
  // A provisional list is no list: the skeleton covers the whole exclusion wait,
  // not just the empty first paint the merged check gates.
  const showSkeleton =
    !noCriteria &&
    !defaultFailed &&
    (holdingReads || (checkingMerged && candidates.length === 0));
  // Which of the status region's lines are DRAWN — it announces more than it
  // shows: the check line stays sr-only wherever the skeleton paints (it is the
  // visual signal there), provisional rows under a held read included.
  const skeletonPaints =
    showSkeleton &&
    shownFrozen === null &&
    !(pausedMergedCheck && !localRunning);
  const showCheckLine = stillChecking && !skeletonPaints;
  // Verdicts still landing. The visible count ticks OUTSIDE the live region,
  // which carries one stable sentence instead, so a screen reader hears the
  // check start, not every landing.
  const verdictsPending = check.status === "pending" && checkNames.length > 0;
  // Neither speaks over frozen rows: the live check may be another repo's.
  const tickingBase =
    verdictsPending && !showSkeleton && rows.length > 0 && shownFrozen === null
      ? check.base
      : null;
  const comparedWith =
    shownFrozen === null &&
    check.status === "settled" &&
    check.base !== null &&
    checkNames.length > 0
      ? ` Contents compared with ${check.base.refName}.`
      : "";
  const baseRef = check.base?.refName ?? defaultShort;
  // Frozen rows name the ref their frozen verdicts were measured against.
  const rowsBaseRef = shownFrozen?.baseRef ?? baseRef;
  // A kept row whose tip the batch saw move or couldn't read shows no verdict
  // for the rest of the open: the verdict measured another tip.
  function rowVerdict(c: Candidate): RowVerdict {
    if (c.merged || check.status === "unsupported") return null;
    if (tipUnverified.has(c.branch.name)) return null;
    return check.verdicts.get(c.branch.name) ?? "pending";
  }

  // A running batch counts the rows it froze, as its list shows them.
  const countedNames = shownFrozen?.actionable ?? candidateNames;
  const selectedCount = countedNames.filter((n) => selected.has(n)).length;
  const allChecked =
    countedNames.length > 0 && selectedCount === countedNames.length;
  const someChecked = selectedCount > 0;
  // Withheld while a read holds the live list, never over a shown snapshot.
  const showSelectAll =
    countedNames.length > 0 && (shownFrozen !== null || !holdingReads);

  function toggle(name: string) {
    if (running) return;
    keptTouchRef.current.delete(name);
    touchedRef.current.add(name);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // Select all adds to the checked rows a pending status read holds, so it never
  // drops one the user chose; Deselect all clears everything.
  function toggleAll() {
    if (running) return;
    for (const name of candidateNames) touchedRef.current.add(name);
    for (const name of candidateNames) keptTouchRef.current.delete(name);
    const pendingHeld = candidates
      .filter((c) => worktreeHold(c) === "pending")
      .map((c) => c.branch.name);
    setSelected((prev) =>
      allChecked ? new Set() : selectAllOver(prev, pendingHeld, candidateNames),
    );
  }

  // Changing a control opens a fresh context, so drop any per-branch failures
  // left from a previous batch — otherwise a "failed" badge from a delete
  // attempt would bleed onto the same branch in archive mode. Done in the
  // handlers (not an effect) so the post-batch refetch keeps the just-failed rows
  // flagged.
  function changeMode(next: Mode) {
    if (running) return;
    setMode(next);
    setFailed(new Map());
  }

  function toggleCriterion(key: Criterion) {
    if (running) return;
    setCriteria((prev) => ({ ...prev, [key]: !prev[key] }));
    setFailed(new Map());
  }

  // A window press also turns Idle on, so the window never sits as a control
  // that does nothing.
  function changeWindow(next: number) {
    if (running) return;
    setWindowDays(next);
    setCriteria((prev) => (prev.idle ? prev : { ...prev, idle: true }));
    setFailed(new Map());
  }

  function changeIncludeWorktrees(next: boolean) {
    if (running) return;
    setIncludeWorktrees(next);
    setFailed(new Map());
    // A lock or unlock made outside the app shows only once the list re-reads.
    if (next)
      void queryClient.invalidateQueries({ queryKey: worktreeKey(repoPath) });
  }

  // The latest committed protection read, default and current branch, so a
  // running batch sees what lands after it started; the repo they answer for
  // keeps a switched repo's values away from the batch.
  const protectionRef = useRef({
    repoPath,
    isProtected,
    defaultBranch: defaultOrNull,
    currentBranch,
  });
  useLayoutEffect(() => {
    protectionRef.current = {
      repoPath,
      isProtected,
      defaultBranch: defaultOrNull,
      currentBranch,
    };
  });

  async function runBatch() {
    // A confirm hands over the set and worktree rows it showed; an unconfirmed
    // Archive acts on the live selection and removes no worktree, since it
    // confirms whenever one is selected.
    const confirmed = confirmedRef.current;
    confirmedRef.current = null;
    const names =
      confirmed?.names ?? candidateNames.filter((n) => selected.has(n));
    const worktreePaths = confirmed?.worktreePaths ?? new Map<string, string>();
    if (names.length === 0) return;
    // A promote's branch sits in no checkout while it moves, so the worktree
    // exclusion can't see it.
    if (mode === "delete" && promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    // The batch can include the pushing branch, so any push holds it.
    if (refuseWhilePushRuns(queryClient, repoPath)) return;
    const fails = new Map<string, string>();
    // Removed worktrees whose branch stayed: failures that leave the selection.
    const kept = new Set<string>();
    // The kept rows whose tip the batch saw move or couldn't read.
    const unverified = new Set<string>();
    // A plain row's archive would hide a branch checked out after the confirm
    // in any worktree (session folders too; git refuses only a delete), or one
    // a promote is moving, whose entry outlives its worktree. Read per row and
    // fail OPEN on the list (the flag is reversible); a checkout after the read
    // is out of reach. A worktree whose plain removal was in flight at either
    // edge of the read doesn't count: its row is plain on purpose.
    const checkedOutNow = async (name: string) => {
      if (isBranchPromoting(name)) return true;
      const removing = plainRemovalPaths();
      try {
        const list = await listWorktrees(repoPath);
        for (const p of plainRemovalPaths()) removing.add(p);
        return (
          isBranchPromoting(name) ||
          list.some((w) => w.branch === name && !removing.has(normPath(w.path)))
        );
      } catch {
        return isBranchPromoting(name);
      }
    };
    // Live for the batch's own repo; after a switch, the rules it started with.
    const protectedNow = (name: string) => {
      const live = protectionRef.current;
      return live.repoPath === repoPath
        ? live.isProtected(name)
        : isProtected(name);
    };
    // Names that became the default or current branch after the confirm
    // captured them: never acted on, and neither a success nor a failure.
    const skipped = new Set<string>();
    const skipNow = (name: string): SkipReason | null => {
      const live =
        protectionRef.current.repoPath === repoPath
          ? protectionRef.current
          : { defaultBranch: defaultOrNull, currentBranch };
      if (name === live.defaultBranch) return "default";
      if (name === live.currentBranch) return "current";
      return null;
    };
    setFailed(new Map());
    setFrozen({
      rows: candidates,
      verdicts: new Map(candidates.map((c) => [c.branch.name, rowVerdict(c)])),
      actionable: candidateNames,
      baseRef,
    });
    setProgress({ done: 0, total: names.length });
    let processed = names.length;
    for (let i = 0; i < names.length; i++) {
      // A push can start mid-batch: stop before the next branch, keeping the
      // dialog and the unprocessed selection.
      if (refuseWhilePushRuns(queryClient, repoPath)) {
        processed = i;
        break;
      }
      const name = names[i];
      const wtPath = worktreePaths.get(name);
      const skip = skipNow(name);
      try {
        if (skip !== null) {
          // Both modes, ahead of the rule check, so its worktree stays too.
          skipped.add(name);
          toast.info(SKIPPED_TOAST[skip](name));
        } else if (mode === "delete" && protectedNow(name)) {
          // Delete-mode candidates already exclude protected names; this
          // covers rules that land after the confirm captured its names, or
          // during the batch. First, so a protected branch keeps its worktree.
          fails.set(name, "protected by a branch rule");
        } else if (wtPath !== undefined) {
          // Called per row as it starts: the removal re-checks updates and
          // other removals at call time, which a pre-loop pass would miss.
          const out = await removeWorktreeForCleanup(queryClient, {
            repoPath,
            path: wtPath,
            name,
            branch: name,
            then: mode,
          });
          if (!out.ok) fails.set(name, out.reason);
          else {
            const keptReason = KEPT_BRANCH_REASON[out.branch];
            if (keptReason !== null) {
              fails.set(name, keptReason);
              kept.add(name);
              if (KEPT_TIP_UNVERIFIED[out.branch]) unverified.add(name);
            }
          }
        } else if (mode === "archive") {
          if (await checkedOutNow(name)) {
            skipped.add(name);
            toast.info(SKIPPED_TOAST.current(name));
          } else {
            await api.gitSetBranchArchived(repoPath, name, true);
          }
        } else {
          await api.gitDeleteBranch(repoPath, name);
        }
      } catch (e) {
        fails.set(name, presentError(e).summary);
      }
      setProgress({ done: i + 1, total: names.length });
    }
    // One reconciliation for the whole batch (branch mutations aren't optimistic
    // here) — refreshes the switcher list, divergence, and archived section.
    await queryClient.invalidateQueries({
      queryKey: repoKeys.branches(repoPath),
    });
    await queryClient.invalidateQueries({
      queryKey: ["repo", repoPath, "divergence"],
    });
    // Every name the batch acted on leaves the selection, so a reopen never
    // carries one into another action; a plain failure stays checked for a
    // retry. A kept row leaves too, marked touched: a retry would act on a tip
    // its verdict never measured.
    for (const n of kept) {
      keptRef.current.add(n);
      touchedRef.current.add(n);
      keptTouchRef.current.add(n);
    }
    if (unverified.size > 0)
      setTipUnverified((prev) => new Set([...prev, ...unverified]));
    // A finished or skipped branch is touched too: a stale list can still show
    // it, and a settled verdict must not check it again for a retry.
    for (const n of names.slice(0, processed))
      if (!fails.has(n)) {
        touchedRef.current.add(n);
        keptTouchRef.current.add(n);
      }
    const retryable = { has: (n: string) => fails.has(n) && !kept.has(n) };
    setSelected((prev) =>
      selectionAfterBatch(prev, names, processed, retryable),
    );
    // A stopped or partly failed batch leaves the dialog open: the rows left
    // keep the user's choices, and the live list takes over. A full success
    // closes it still frozen.
    if (processed < names.length || fails.size > 0) {
      selectionSeed.current = {
        ...selectionSeed.current,
        afterBatch: selectionContext,
      };
      setFrozen(null);
    }
    setProgress(null);

    const ok = processed - fails.size - skipped.size;
    const verb = mode === "archive" ? "Archived" : "Deleted";
    if (processed < names.length) {
      if (fails.size > 0) {
        setFailed(fails);
        setFailedIn(repoPath);
        toast.error(`${verb} ${ok}, ${fails.size} failed`);
      } else if (ok > 0) toast.success(`${verb} ${pluralBranches(ok)}`);
      return;
    }
    // A run whose only misses are skips closes like a success; its skip
    // toasts already said what didn't happen.
    if (fails.size === 0) {
      if (ok > 0) toast.success(`${verb} ${pluralBranches(ok)}`);
      onClose();
      return;
    }
    setFailed(fails);
    setFailedIn(repoPath);
    // The successful ones drop out of the candidate list on refetch, leaving the
    // failures on screen with their reason; the user can retry them.
    toast.error(`${verb} ${ok}, ${fails.size} failed`);
  }

  function openConfirm(batch: ConfirmBatch) {
    setConfirmBatch(batch);
    setShownConfirm(batch);
  }

  // Delete always confirms; Archive confirms only when it removes a worktree,
  // since unarchiving doesn't bring the folder back.
  function onPrimary() {
    const names = candidateNames.filter((n) => selected.has(n));
    const rowByName = new Map(candidates.map((c) => [c.branch.name, c]));
    const worktreePaths = new Map(
      names.flatMap((n) => {
        const wt = rowByName.get(n)?.worktree;
        return wt ? [[n, wt.path] as const] : [];
      }),
    );
    const snapshot = {
      repoPath,
      names,
      worktreePaths,
      // A kept row whose tip moved past what its verdict measured, or
      // couldn't be read: counted as having changes, the cautious reading.
      changes: names.filter(
        (n) => tipUnverified.has(n) || check.verdicts.get(n) === "changes",
      ).length,
      baseRef,
    };
    if (mode === "delete") openConfirm({ kind: "delete", ...snapshot });
    else if (worktreePaths.size > 0)
      openConfirm({ kind: "archiveWorktrees", ...snapshot });
    else void runBatch();
  }

  function onConfirmBatch() {
    if (confirmBatch === null) return;
    setConfirmBatch(null);
    if (
      refuseIfSwitched(
        confirmBatch.repoPath,
        CONFIRM_REFUSED[confirmBatch.kind],
      )
    )
      return;
    confirmedRef.current = {
      names: confirmBatch.names,
      worktreePaths: confirmBatch.worktreePaths,
    };
    void runBatch();
  }

  const verb = mode === "archive" ? "Archive" : "Delete";
  const gerund = mode === "archive" ? "Archiving" : "Deleting";
  const primaryLabel = running
    ? `${gerund}… ${progress?.done ?? 0}/${progress?.total ?? 0}`
    : `${verb} ${pluralBranches(selectedCount)}`;
  const primaryHeldReason = ((): string | null => {
    switch (true) {
      case running:
        return PRIMARY_RUNNING_REASON;
      case defaultFailed:
        return DEFAULT_READ_FAILED_COPY;
      case holdingReads:
        return PRIMARY_HOLDING_REASON;
      case selectedCount === 0:
        return PRIMARY_EMPTY_REASON[mode];
      default:
        return null;
    }
  })();
  const failedHere = failedIn === repoPath ? failed : NO_FAILURES;
  // The mode's own exclusions can empty the list while stale branches remain, so
  // both empty states name the exclusion instead of reporting none. One string
  // for the prose and the live region — a reader and a listener get the same
  // sentence.
  const allStaleExcluded = candidates.length === 0 && stale.length > 0;
  function emptyStatusLine(): string {
    if (noCriteria) return NO_CRITERIA_COPY;
    if (defaultFailed) return DEFAULT_READ_FAILED_COPY;
    if (allStaleExcluded)
      return `${pluralBranches(stale.length)} ${stale.length === 1 ? "is" : "are"} stale but excluded from ${verb}: ${EMPTY_EXCLUDED_REASON[mode][includeWorktrees ? "on" : "off"]}.`;
    return "No stale branches.";
  }
  const emptyStatus = emptyStatusLine();

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && !running) onClose();
        }}
      >
        <DialogContent className="flex flex-col gap-4 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Clean up branches</DialogTitle>
            <DialogDescription>
              Local branches merged into{" "}
              <span className="font-mono">{defaultShort}</span>
              {DESCRIPTION_PR_CLAUSE[prCheckState]}
              {MODE_SENTENCE[mode]}
            </DialogDescription>
          </DialogHeader>

          {/* Action / Show captions beside their controls, then the opt-in.
              A running batch natively disables every control here and in the
              list as one run-wide lock, explained by the held primary's
              progress label and reason. onOpenChange refuses every dismissal
              meanwhile (Escape, the header close, a backdrop press); that close
              stays enabled on purpose, since the vendored one takes no reason. */}
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
            <LabeledGroup label="Action" className={CONTROL_ROW}>
              <div className="inline-flex w-fit rounded-none ring-1 ring-border">
                {(["archive", "delete"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={running}
                    aria-pressed={mode === m}
                    onClick={() => changeMode(m)}
                    className={cn(
                      "px-3 py-1 text-xs capitalize transition-colors first:border-r first:border-border disabled:opacity-50",
                      mode === m
                        ? m === "delete"
                          ? "bg-destructive text-white"
                          : "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </LabeledGroup>

            <LabeledGroup label="Show" className={CONTROL_ROW}>
              <div
                className="flex flex-wrap items-center gap-1.5"
                onKeyDown={moveFocusInGroup}
              >
                {(["merged", "closed"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={running}
                    aria-pressed={criteria[k]}
                    onClick={() => toggleCriterion(k)}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-1 ring-1 transition-colors disabled:opacity-50",
                      criteria[k]
                        ? "bg-primary/10 text-foreground ring-primary/50"
                        : "text-muted-foreground ring-border hover:text-foreground",
                    )}
                  >
                    <ChipMark on={criteria[k]} />
                    {CRITERION_LABEL[k]}
                  </button>
                ))}
                <span
                  className={cn(
                    "inline-flex items-stretch ring-1",
                    criteria.idle ? "ring-primary/50" : "ring-border",
                  )}
                >
                  <button
                    type="button"
                    disabled={running}
                    aria-pressed={criteria.idle}
                    onClick={() => toggleCriterion("idle")}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-1 transition-colors disabled:opacity-50",
                      criteria.idle
                        ? "bg-primary/10 text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <ChipMark on={criteria.idle} />
                    Idle for
                  </button>
                  {/* Enabled while Idle is off: a press turns Idle on. */}
                  <span
                    role="group"
                    aria-label="Idle window in days"
                    className="inline-flex"
                  >
                    {AGE_WINDOWS.map((d) => (
                      <button
                        key={d}
                        type="button"
                        disabled={running}
                        aria-pressed={windowDays === d}
                        onClick={() => changeWindow(d)}
                        className={cn(
                          "border-l border-border px-2 py-1 tabular-nums transition-colors disabled:opacity-50",
                          windowDays === d &&
                            criteria.idle &&
                            "bg-primary text-primary-foreground",
                          // Idle off keeps the pick visible without a fill: an
                          // inset primary ring clears 3:1 on the popover.
                          windowDays === d &&
                            !criteria.idle &&
                            "text-foreground ring-1 ring-primary ring-inset",
                          windowDays !== d &&
                            "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {d}
                      </button>
                    ))}
                  </span>
                  <span className="border-l border-border px-2 py-1 text-muted-foreground">
                    days
                  </span>
                </span>
              </div>
            </LabeledGroup>

            <label
              className={cn(
                "col-start-2 flex w-fit cursor-pointer items-center gap-2",
                !includeWorktrees && "text-muted-foreground",
              )}
            >
              <Checkbox
                checked={includeWorktrees}
                disabled={running}
                onCheckedChange={(next) => changeIncludeWorktrees(next)}
              />
              Include branches checked out in a worktree
            </label>
          </div>

          {/* Select-all header — a tri-state indicator (the vendored Checkbox
              has no indeterminate visual, and components/ui/ is off-limits).
              Withheld while the list is provisional — it would count rows an
              outstanding exclusion read may still remove. */}
          {showSelectAll && (
            <button
              type="button"
              disabled={running}
              onClick={toggleAll}
              aria-label={`${allChecked ? "Deselect all" : "Select all"}, ${selectedCount} of ${countedNames.length} selected`}
              className="flex items-center gap-2 text-xs text-muted-foreground disabled:opacity-50"
            >
              <span
                aria-hidden
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-none border border-input",
                  (allChecked || someChecked) &&
                    "border-primary bg-primary text-primary-foreground",
                )}
              >
                {allChecked ? (
                  <CheckIcon className="size-3.5" />
                ) : someChecked ? (
                  <MinusIcon className="size-3.5" />
                ) : null}
              </span>
              <span>
                {selectedCount} of {countedNames.length} selected
              </span>
            </button>
          )}

          {/* Merged-detection status + the list it describes. `gap` (not
              `space-y`) spaces the two, so the status region contributes none
              while it is sr-only and therefore out of flow. */}
          <div className="flex flex-col gap-0.5">
            {/* Mounted unconditionally: a live region created together with its
                text announces unreliably, so the region pre-exists and only its
                CONTENT changes. `sr-only` keeps the silent states out of layout.
                No aria-busy — on a live region it tells a screen reader to hold
                announcements back; it belongs on the skeleton, which sits
                outside this region. */}
            <div
              role="status"
              className={cn(
                "flex flex-col gap-0.5",
                !showCheckLine &&
                  !showPrFailedLine &&
                  !worktreeCheckFailed &&
                  "sr-only",
              )}
            >
              {/* A parked FIRST pull-request fetch is still waiting, so it keeps
                  the waiting line; a parked refetch over settled data falls
                  through to the resting line, which reports the count and claims
                  nothing about the check — what a `role="status"` region can
                  honestly repeat on every control change. */}
              {stillChecking ? (
                (() => {
                  // A RUNNING local read the list waits on (default branch,
                  // worktrees, branch rules, ancestry) outranks the parked
                  // pull-request fetch: the line names the one running, and the
                  // waiting copy shows only while none of them is.
                  const what = ((): CheckingWhat => {
                    switch (true) {
                      case checkingMerged && !pausedMergedCheck:
                        return mergedCheckLine();
                      case ancestryLoading:
                        return ancestryCheckLine();
                      case defaultLoading:
                        return "default";
                      case checkingWorktrees:
                        return "worktrees";
                      case rulesSettling:
                        return "rules";
                      default:
                        return mergedCheckLine();
                    }
                  })();
                  return (
                    <CheckingLine
                      what={what}
                      waitingOn={
                        pausedMergedCheck && !localRunning
                          ? prScope(criteria)
                          : null
                      }
                      srOnly={skeletonPaints}
                    />
                  );
                })()
              ) : (
                <p className="sr-only">
                  {rows.length === 0
                    ? emptyStatus
                    : `${pluralBranches(rows.length)} to review.${comparedWith}`}
                </p>
              )}
              {verdictsPending ? (
                <p className="sr-only">
                  Checking branches for changes not in the default branch…
                </p>
              ) : null}
              {/* Announced even where the empty state carries it in prose: only
                  the region's copy reaches a screen reader as it happens. */}
              {prCheckState === "failed" && prMatters && caveatsApply ? (
                <p
                  className={
                    showPrFailedLine
                      ? "px-1 py-1 text-[11px] text-muted-foreground"
                      : "sr-only"
                  }
                >
                  {PR_FAILED_LINE[prScope(criteria)]}
                </p>
              ) : null}
              {worktreeCheckFailed ? (
                <p className="px-1 py-1 text-[11px] text-muted-foreground">
                  Worktree checkouts couldn't be read, so a branch checked out
                  in another worktree may be listed.
                </p>
              ) : null}
            </div>
            {tickingBase ? (
              <p
                aria-hidden
                className="px-1 py-1 text-[11px] text-muted-foreground"
              >
                Checked {checkNames.length - check.pendingCount} of{" "}
                {checkNames.length} {branchNoun(checkNames.length)} for changes
                not in <span className="font-mono">{tickingBase.refName}</span>…
              </p>
            ) : null}

            {(() => {
              // A frozen batch keeps its rows whatever the reads do.
              switch (true) {
                case noCriteria && shownFrozen === null:
                  return (
                    <p className="py-6 text-center text-xs text-muted-foreground">
                      {NO_CRITERIA_COPY}
                    </p>
                  );
                case showSkeleton && shownFrozen === null:
                  // A running local read (default branch, worktrees, branch
                  // rules, ancestry) is real activity, so it earns the skeleton
                  // even while the pull-request fetch sits parked.
                  return (
                    <CheckingPlaceholder
                      paused={pausedMergedCheck && !localRunning}
                    />
                  );
                case rows.length === 0:
                  return (
                    <p className="py-6 text-center text-xs text-muted-foreground">
                      {allStaleExcluded || defaultFailed ? (
                        emptyStatus
                      ) : (
                        <NoMatchCopy
                          criteria={criteria}
                          defaultShort={defaultShort}
                          prCheckState={prCheckState}
                          windowDays={windowDays}
                        />
                      )}
                      {/* Carried by BOTH arms: an excluded-only list is just as
                          incomplete when the pull-request read failed. A failed
                          default read lists nothing either way. */}
                      {prCheckState === "failed" && prMatters && !defaultFailed
                        ? PR_FAILED_EMPTY_NOTE[prScope(criteria)]
                        : null}
                    </p>
                  );
                default:
                  return (
                    // py-2 contains the Checkbox touch-target's 8px vertical
                    // bleed (after:-inset-y-2) — without it the pseudo adds
                    // scrollable overflow and Windows draws a scrollbar for
                    // even one row.
                    <div
                      className="-mx-1 max-h-[45vh] space-y-0.5 overflow-x-hidden overflow-y-auto px-1 py-2"
                      onKeyDown={nav.onRowKeyDown}
                    >
                      {rows.map((c, index) => {
                        const name = c.branch.name;
                        const hold = worktreeHold(c);
                        const err = failedHere.get(name);
                        const errId = `${baseId}-${index}`;
                        const holdId = `${baseId}-${index}-hold`;
                        const detailId = `${baseId}-${index}-detail`;
                        const holdReason =
                          hold === null ? null : WORKTREE_ROW_REASON[hold];
                        const verdict =
                          shownFrozen === null
                            ? rowVerdict(c)
                            : (shownFrozen.verdicts.get(name) ?? null);
                        // The badges' title-only explanations, for AT; inside
                        // the label they would join the checkbox's name.
                        const details = [
                          c.prMerged ? prMergedDetail(c.prMerged) : null,
                          c.prClosed ? PR_CLOSED_DETAIL : null,
                          verdict === "clean" || verdict === "changes"
                            ? verdictDetail(verdict, rowsBaseRef)
                            : null,
                        ].filter((d) => d !== null);
                        const describedBy =
                          [
                            err ? errId : null,
                            holdReason ? holdId : null,
                            details.length > 0 ? detailId : null,
                          ]
                            .filter(Boolean)
                            .join(" ") || undefined;
                        return (
                          <div
                            key={name}
                            className={cn(
                              "rounded-none px-1.5 py-1.5 text-xs transition-colors",
                              hold === null
                                ? "hover:bg-accent"
                                : "text-muted-foreground",
                              nav.isActive(c) && "bg-accent",
                            )}
                          >
                            {/* The reasons sit outside the label: text inside
                                it would join the Checkbox's accessible name. */}
                            <label
                              className={cn(
                                "block",
                                hold === null && "cursor-pointer",
                              )}
                            >
                              <span className="flex items-center gap-2">
                                {/* A held row stays focusable and in the roving
                                    order, so it can say why it won't toggle. */}
                                <Checkbox
                                  {...nav.rowProps(c)}
                                  checked={hold === null && selected.has(name)}
                                  disabled={running}
                                  onCheckedChange={
                                    hold === null
                                      ? () => toggle(name)
                                      : undefined
                                  }
                                  aria-disabled={
                                    hold === null ? undefined : true
                                  }
                                  className={
                                    hold === null
                                      ? undefined
                                      : ARIA_DISABLED_CLASS
                                  }
                                  aria-describedby={describedBy}
                                />
                                <span
                                  className="min-w-0 flex-1 truncate font-mono"
                                  onMouseEnter={clipTitleFromText}
                                >
                                  {name}
                                </span>
                                <span className="shrink-0 tabular-nums text-muted-foreground">
                                  <RelativeTime
                                    date={c.branch.lastCommitDate}
                                  />
                                </span>
                              </span>
                              <RowBadges
                                candidate={c}
                                error={err}
                                verdict={verdict}
                                baseRef={rowsBaseRef}
                              />
                            </label>
                            {details.length > 0 ? (
                              <span id={detailId} className="sr-only">
                                {details.join(". ")}
                              </span>
                            ) : null}
                            {hold === "pending" ? (
                              <>
                                <div
                                  aria-hidden
                                  className="mt-1 ml-6 h-2.5 w-40 animate-pulse bg-muted"
                                />
                                <span id={holdId} className="sr-only">
                                  {holdReason}
                                </span>
                              </>
                            ) : null}
                            {holdReason && hold !== "pending" ? (
                              <div
                                id={holdId}
                                className="truncate pl-6 text-[11px] text-muted-foreground"
                                onMouseEnter={clipTitleFromText}
                              >
                                {holdReason}
                              </div>
                            ) : null}
                            {err ? (
                              <div
                                id={errId}
                                className="truncate pl-6 text-[11px] text-destructive"
                                onMouseEnter={clipTitleFromText}
                              >
                                {`Couldn't ${mode}: ${err}`}
                              </div>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  );
              }
            })()}
          </div>

          <DialogFooter>
            <DisabledReasonButton
              type="button"
              variant="outline"
              disabled={running}
              reason={running ? PRIMARY_RUNNING_REASON : null}
              onClick={onClose}
            >
              Cancel
            </DisabledReasonButton>
            <DisabledReasonButton
              type="button"
              variant={mode === "delete" ? "destructive" : "default"}
              disabled={primaryHeldReason !== null}
              reason={primaryHeldReason}
              onClick={onPrimary}
            >
              {primaryLabel}
            </DisabledReasonButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {shownConfirm ? (
        <ConfirmDialog
          open={open && confirmBatch !== null}
          onCancel={() => setConfirmBatch(null)}
          title={CONFIRM_TITLE[shownConfirm.kind](shownConfirm)}
          body={<ConfirmBody batch={shownConfirm} />}
          confirmLabel={CONFIRM_LABEL[shownConfirm.kind](shownConfirm)}
          confirmVariant={CONFIRM_VARIANT[shownConfirm.kind]}
          onConfirm={onConfirmBatch}
        />
      ) : null}
    </>
  );
}
