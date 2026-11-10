import { WarningIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { useRelativeNow } from "@/components/relative-time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { isConflictedEntry } from "@/features/repository/bulk-row-targets";
import { PROMOTION_BLOCKS_CHECKOUT } from "@/features/repository/checkout-copy";
import { clipTitleFromText } from "@/lib/clip-title";
import { headBranchPin } from "@/lib/git/api";
import {
  repoStatusOptions,
  repoStatusPoll,
  useAmendCommitDates,
  useCommitDetails,
  useCommitRecordsParent,
  useLog,
  useOpState,
} from "@/lib/git/queries";
import type { CommitDate, RepoStatus } from "@/lib/git/types";
import { useConfirm } from "@/lib/stores/confirm";
import { refuseIfSwitched } from "@/lib/stores/notifications";
import { useUiStore } from "@/lib/stores/ui";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import { toastError } from "@/lib/toast";
import { useLatestRef } from "@/lib/use-latest-ref";
import { useRetained } from "@/lib/use-retained";
import { useSeedOnOpen } from "@/lib/use-seed-on-open";
import { CommitDateField, SameAsAuthorCheckbox } from "./CommitDateField";
import {
  beforeParentNote,
  datesBeforeParentConfirm,
  PARENT_DATE_PENDING,
} from "./commit-confirms";
import {
  commitDateFromIso,
  DATE_FORMAT_HINT,
  type DateDraft,
  dateWarnings,
  FIX_DATE_FIRST,
  formatCommitDate,
  inEditableRange,
  OUT_OF_RANGE_NOTE,
  resolveDates,
  rowDateLabel,
  sameCommitDate,
  sameUnreachableNote,
} from "./commit-date";
import { useForcePushGate } from "./useAmendCommit";

/** The commit an Edit dates dialog acts on, and the HEAD and branch its host
 *  saw when it opened: the backend refuses once HEAD is elsewhere. */
export interface EditDatesTarget {
  hash: string;
  repo: string;
  expectedHead: string;
  expectedBranch: string;
}

const UNREADABLE = "This commit's dates can't be read here.";
const BRANCH_SWITCHED_HOLD =
  "The checked-out branch changed while this was open. Close and reopen to edit the new one.";
const HEAD_MOVED_HOLD =
  "The latest commit changed while this was open. Close and reopen to edit the new one.";

/** Only status's HEAD and its branch pin, so working-tree polls don't
 *  re-render the dialog. */
const selectHeadPin = (s: RepoStatus) =>
  s.branch ? { oid: s.branch.oid, pin: headBranchPin(s.branch) } : null;

/** Unmerged entries with no operation stopped (a stash pop that conflicted):
 *  the backend refuses the change. */
const selectUnresolved = (s: RepoStatus) => s.entries.some(isConflictedEntry);

const UNRESOLVED_REASON = "Resolve the conflicts first.";

const PRIMARY_LABEL = "Change dates";

/**
 * Changes HEAD's author and committer dates and nothing else. Its host
 * keys it per repo, so a switch remounts it closed; the submit's continuation
 * still checks the live repo and target before it closes or prunes.
 */
export function EditDatesDialog({
  repoPath,
  target,
  onClose,
  onDatesChanged,
  landFocus,
  adoptSelection = false,
}: {
  repoPath: string;
  target: EditDatesTarget | null;
  onClose: () => void;
  /** Runs after a successful change while the repo is still the target's.
   *  `closed` is false when the dialog was dismissed or moved on before the
   *  change landed, so a host arms no focus landing for it. */
  onDatesChanged?: (oldHash: string, newHash: string, closed: boolean) => void;
  /** Where focus lands when a change closes the dialog: the commit it acted
   *  on is gone, so the default return target may be too. Null leaves focus
   *  alone for the host to place once its target renders. */
  landFocus?: () => HTMLElement | null;
  /** Set by the History panel only: History's selection may have been pruned
   *  to none under the await, and the rewrite then becomes it. Elsewhere that
   *  selection isn't what the user sees, so only the old commit's is moved. */
  adoptSelection?: boolean;
}) {
  const open = target !== null && target.repo === repoPath;
  // The content stays on the target through the close fade.
  const shown = useRetained(open ? target : null);
  const closedByChange = useRef(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      {/* Base UI asks for the return target as the popup unmounts, after the
          fade, so a host's target that rendered meanwhile is found. */}
      <DialogContent
        className="sm:max-w-lg"
        // Lets a host's deferred landing tell focus still in this closing
        // dialog from focus the user moved elsewhere.
        data-edit-dates-dialog=""
        finalFocus={() => {
          if (!closedByChange.current) return true;
          closedByChange.current = false;
          return landFocus?.() ?? false;
        }}
      >
        {/* Mounted only while shown, so a closed dialog reads and polls nothing. */}
        {shown !== null && (
          <EditDatesForm
            repoPath={repoPath}
            target={target}
            shown={shown}
            open={open}
            onClose={onClose}
            onChangeClose={() => {
              if (landFocus !== undefined) closedByChange.current = true;
            }}
            onDatesChanged={onDatesChanged}
            adoptSelection={adoptSelection}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditDatesForm({
  repoPath,
  target,
  shown,
  open,
  onClose,
  onChangeClose,
  onDatesChanged,
  adoptSelection,
}: {
  repoPath: string;
  target: EditDatesTarget | null;
  shown: EditDatesTarget;
  open: boolean;
  onClose: () => void;
  onChangeClose: () => void;
  onDatesChanged?: (oldHash: string, newHash: string, closed: boolean) => void;
  adoptSelection: boolean;
}) {
  const queryClient = useQueryClient();
  const liveTarget = useLatestRef(target);
  const details = useCommitDetails(repoPath, shown?.hash ?? null);
  // HEAD's parent judges a new author date. The log walks HEAD's ancestry, so a
  // single-parent HEAD's next row is its parent; a merge has no one parent to
  // judge against. Undefined = unknown.
  const log = useLog(repoPath);
  const rows = log.data?.pages[0];
  const top = rows?.[0];
  // A lone loaded commit is a true root or a shallow clone's boundary, whose
  // parent exists unfetched; its raw header tells the two apart, as History's
  // undo gate reads it.
  const lone = top?.hash === shown.hash && !top.isMerge && rows?.length === 1;
  const recordsParent = useCommitRecordsParent(repoPath, shown.hash, lone);
  const parentHash = ((): string | null | undefined => {
    if (top?.hash !== shown.hash) return undefined;
    if (top.isMerge || lone) return null;
    return rows?.[1]?.hash ?? null;
  })();
  const parentDetails = useCommitDetails(repoPath, parentHash ?? null);
  const parentRead = ((): "none" | "pending" | "unread" | CommitDate => {
    if (parentHash === null && lone) {
      if (recordsParent.data === false) return "none";
      return recordsParent.data === true || recordsParent.isError
        ? "unread"
        : "pending";
    }
    if (parentHash === null) return "none";
    if (parentHash === undefined) return log.isError ? "unread" : "pending";
    // The details read serves the previous commit as a placeholder.
    if (
      !parentDetails.isPlaceholderData &&
      parentDetails.data?.hash === parentHash
    )
      return commitDateFromIso(parentDetails.data.date) ?? "unread";
    return parentDetails.isError ? "unread" : "pending";
  })();
  const opState = useOpState(repoPath);
  const statusHead = useQuery({
    ...repoStatusOptions(repoPath),
    ...repoStatusPoll,
    select: selectHeadPin,
  }).data;
  const unresolved =
    useQuery({
      ...repoStatusOptions(repoPath),
      ...repoStatusPoll,
      select: selectUnresolved,
    }).data === true;
  const gate = useForcePushGate(repoPath);
  // run() reads the gate after awaiting a prompt, when the press's render is stale.
  const liveGate = useLatestRef(gate);
  const amendDates = useAmendCommitDates(repoPath);
  const nowMs = useRelativeNow();
  const [draft, setDraft] = useState<DateDraft | undefined>(undefined);
  useSeedOnOpen(open, () => setDraft(undefined));

  // The details read serves the previous commit as a placeholder: never
  // prefill or enable from another commit's dates.
  const current =
    shown !== null &&
    !details.isPlaceholderData &&
    details.data?.hash === shown.hash
      ? details.data
      : null;
  const author = current ? commitDateFromIso(current.date) : null;
  const committer = current ? commitDateFromIso(current.committerDate) : null;
  const original =
    author !== null && committer !== null ? { author, committer } : null;
  const resolved = original ? resolveDates(original, draft) : null;
  const shownDraft: DateDraft | null = original
    ? (draft ?? {
        author: formatCommitDate(original.author),
        same: resolved?.same ?? true,
        committer: formatCommitDate(original.committer),
      })
    : null;

  const submitting = amendDates.isPending;
  // Branch first, as the backend's pin refusals are ordered.
  const headMovedReason = ((): string | null => {
    if (shown === null || statusHead == null) return null;
    if (statusHead.pin !== shown.expectedBranch) return BRANCH_SWITCHED_HOLD;
    if (statusHead.oid !== shown.expectedHead) return HEAD_MOVED_HOLD;
    return null;
  })();
  const opInProgress = Boolean(
    opState.data?.merging ||
      opState.data?.rebasing ||
      opState.data?.cherryPicking ||
      opState.data?.reverting,
  );
  const hasError =
    resolved !== null &&
    (resolved.authorError !== null || resolved.committerError !== null);
  // Judged only when the author date changes, as Edit history judges a pair
  // only when a date edit takes part in it.
  const plannedAuthor = resolved?.planned.author ?? null;
  const authorEdited =
    original !== null &&
    plannedAuthor !== null &&
    !sameCommitDate(plannedAuthor, original.author);
  // Null = nothing to flag; a null `label` = the parent's date is unread.
  const parentFlag = ((): { label: string | null } | null => {
    if (!authorEdited || hasError || plannedAuthor === null) return null;
    if (parentRead === "unread") return { label: null };
    if (typeof parentRead === "string") return null;
    return plannedAuthor.epochSeconds < parentRead.epochSeconds
      ? { label: rowDateLabel(parentRead, nowMs) }
      : null;
  })();
  const refusal = gate.refusal();
  const holdReason = ((): string | null => {
    switch (true) {
      case submitting:
        return "Changing dates…";
      case current === null && details.isError:
        return "Couldn't read this commit's dates.";
      case current === null:
        return "Reading this commit's dates…";
      case original === null:
        return UNREADABLE;
      case headMovedReason !== null:
        return headMovedReason;
      case opInProgress:
        return "Finish the operation in Changes first.";
      case unresolved:
        return UNRESOLVED_REASON;
      case refusal !== null:
        return refusal;
      case hasError:
        return FIX_DATE_FIRST;
      case !resolved?.changed:
        return "Change a date first.";
      case authorEdited && parentRead === "pending":
        return PARENT_DATE_PENDING;
      default:
        return null;
    }
  })();
  const fieldHold = submitting ? "Changing dates…" : null;

  // A Retry pressed with focus on it lands on the author field once the dates
  // arrive: the Retry unmounts with the error arm.
  const fieldsRef = useRef<HTMLDivElement>(null);
  const retryFocused = useRef(false);
  const fieldsShown = original !== null;
  useLayoutEffect(() => {
    if (!fieldsShown || !retryFocused.current) return;
    retryFocused.current = false;
    fieldsRef.current?.querySelector("input")?.focus();
  }, [fieldsShown]);

  async function run() {
    const t = target;
    if (t === null || t.repo !== repoPath || resolved === null) return;
    if (parentFlag !== null) {
      // Asked first, so every check below reads the state after the prompt; a
      // dialog closed or retargeted under it drops the change.
      const unread = parentFlag.label === null;
      const ok = await useConfirm
        .getState()
        .ask(
          datesBeforeParentConfirm(
            unread ? 0 : 1,
            PRIMARY_LABEL,
            unread ? "this" : null,
          ),
        );
      if (!ok || liveTarget.current !== t) return;
    }
    if (refuseIfSwitched(t.repo, "no dates were changed")) {
      onClose();
      return;
    }
    // A move the status poll has already seen holds the button; the backend's
    // pin covers the window between this press and its repo lock.
    const cached = queryClient.getQueryData<RepoStatus>(
      repoStatusOptions(repoPath).queryKey,
    )?.branch;
    // Mirrors the backend's pin refusals in their order, branch first; the
    // dialog stays open.
    if (cached && headBranchPin(cached) !== t.expectedBranch) {
      toast.error("The checked-out branch changed — no dates were changed.");
      return;
    }
    if (cached && cached.oid !== t.expectedHead) {
      toast.error("The latest commit changed — no dates were changed.");
      return;
    }
    const refusal = liveGate.current.refusal();
    if (refusal !== null) {
      toast.error(refusal);
      return;
    }
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      return;
    }
    const oldHash = t.hash;
    const requestEpoch = useUiStore.getState().interactionEpoch;
    let newHash: string;
    try {
      newHash = await amendDates.mutateAsync({
        expectedHead: t.expectedHead,
        expectedBranch: t.expectedBranch,
        authorDate: resolved.authorDate ?? null,
        committerDate: resolved.committerDate ?? null,
      });
    } catch (e) {
      // The dialog stays open with what was typed.
      toastError(e);
      return;
    }
    toast.success(
      `Dates changed — ${oldHash.slice(0, 7)} is now ${newHash.slice(0, 7)}`,
    );
    const live = useUiStore.getState();
    if (live.repoPath !== t.repo) return;
    const closed = liveTarget.current === t;
    if (closed) {
      onChangeClose();
      onClose();
    }
    // The rewrite takes the old commit's place in the selection only while
    // nothing newer was asked since the press: a later pick or navigation owns
    // the selection, and the gone commit is only pruned.
    if (
      live.interactionEpoch === requestEpoch &&
      (live.selectedCommitHash === oldHash ||
        (adoptSelection && live.selectedCommitHash === null))
    )
      live.landSelectedCommit(newHash);
    else if (live.selectedCommitHash === oldHash) live.clearSelectedCommit();
    onDatesChanged?.(oldHash, newHash, closed);
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Enter in a field submits past a held button: the hold is re-read here.
    if (holdReason !== null) return;
    void run();
  }

  const warnings =
    resolved !== null ? dateWarnings(resolved.planned, nowMs) : [];
  if (parentFlag !== null)
    warnings.push(beforeParentNote(parentHash ?? null, parentFlag.label));
  const sameNote =
    original !== null && resolved !== null
      ? sameUnreachableNote(original, resolved)
      : null;
  const committerNote =
    resolved !== null &&
    resolved.changed &&
    !hasError &&
    resolved.planned.committer !== null &&
    !inEditableRange(resolved.planned.committer)
      ? OUT_OF_RANGE_NOTE
      : null;

  const body = (() => {
    if (current === null && details.isError)
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-destructive">
            Couldn't read this commit's dates.
          </span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onFocus={() => {
              retryFocused.current = true;
            }}
            onBlur={() => {
              retryFocused.current = false;
            }}
            onClick={() => void details.refetch()}
          >
            Retry
          </Button>
        </div>
      );
    if (current === null)
      return (
        <div className="space-y-2" aria-busy>
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-4 w-40" />
          <span className="sr-only">Reading this commit's dates…</span>
        </div>
      );
    if (original === null || shownDraft === null || resolved === null)
      return <p className="text-xs text-muted-foreground">{UNREADABLE}</p>;
    return (
      <div ref={fieldsRef} className="space-y-1.5">
        <CommitDateField
          label="Author date"
          value={shownDraft.author}
          onChange={(text) => setDraft({ ...shownDraft, author: text })}
          original={original.author}
          date={resolved.planned.author}
          error={resolved.authorError}
          nowMs={nowMs}
          heldReason={fieldHold}
          onReset={() => setDraft(undefined)}
        />
        <SameAsAuthorCheckbox
          checked={resolved.same}
          heldReason={fieldHold}
          // Unticking seeds the committer field with the commit's current one.
          onChange={(same) =>
            setDraft({
              ...shownDraft,
              same,
              committer: same
                ? shownDraft.committer
                : formatCommitDate(original.committer),
            })
          }
        />
        {sameNote !== null && (
          <p className="pl-30 text-[11px] text-muted-foreground">{sameNote}</p>
        )}
        {!resolved.same && (
          <CommitDateField
            label="Committer date"
            value={shownDraft.committer}
            onChange={(text) => setDraft({ ...shownDraft, committer: text })}
            original={original.committer}
            date={resolved.planned.committer}
            error={resolved.committerError}
            nowMs={nowMs}
            note={committerNote}
            heldReason={fieldHold}
            reserveReset
          />
        )}
        {warnings.map((w) => (
          <p
            key={w}
            className="flex items-start gap-1 pl-30 text-[11px] text-warning"
          >
            <WarningIcon aria-hidden className="mt-px size-3 shrink-0" />
            {w}
          </p>
        ))}
        {!hasError && warnings.length === 0 && (
          <p className="pl-30 text-[11px] text-muted-foreground">
            {DATE_FORMAT_HINT}
          </p>
        )}
      </div>
    );
  })();

  // A pushed HEAD warns inline; a protected one says the branch rule
  // instead, and the button holds with that same sentence. Until status reads,
  // whether HEAD is pushed is unknown, so neither line shows.
  const pushedBlock = (() => {
    if (statusHead === undefined) return null;
    if (!gate.needsForcePush)
      return (
        <p className="text-xs text-muted-foreground">
          Rewrites this commit; its id changes.
        </p>
      );
    const text =
      gate.protectedBranch && refusal !== null
        ? refusal
        : `This commit is already on ${gate.upstream}. Changing its dates rewrites it, so the branch will need a force push. Anyone who has pulled it will have to reconcile.`;
    return (
      <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2 text-xs">
        <WarningIcon
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0 text-warning"
        />
        <p>{text}</p>
      </div>
    );
  })();

  return (
    <form onSubmit={onSubmit} className="grid min-w-0 gap-4">
      <DialogHeader className="min-w-0">
        <DialogTitle>Edit dates</DialogTitle>
        <DialogDescription className="flex min-w-0 gap-1.5">
          <span className="shrink-0 font-mono">{shown?.hash.slice(0, 7)}</span>
          <span className="truncate" onMouseEnter={clipTitleFromText}>
            {current?.subject ?? ""}
          </span>
        </DialogDescription>
      </DialogHeader>
      {body}
      {pushedBlock}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <DisabledReasonButton
          type="submit"
          disabled={holdReason !== null}
          reason={holdReason}
        >
          {submitting && <Spinner data-icon="inline-start" />}
          {PRIMARY_LABEL}
        </DisabledReasonButton>
      </DialogFooter>
    </form>
  );
}
