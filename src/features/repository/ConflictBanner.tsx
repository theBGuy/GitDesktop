import { InfoIcon, SparkleIcon, WarningIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useOpAbort, useOpContinue, useOpState } from "@/lib/git/queries";
import type { RepoOp, RepoOpState } from "@/lib/git/types";
import { useAiEnabled, useReviewConfigured } from "@/lib/settings/queries";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";

const OP_LABELS: Record<
  RepoOp,
  { banner: string; cont: string; verb: string }
> = {
  merge: { banner: "Merge in progress", cont: "Finish merge", verb: "Merging" },
  rebase: {
    banner: "Rebase in progress",
    cont: "Continue rebase",
    verb: "Rebasing",
  },
  "cherry-pick": {
    banner: "Cherry-pick in progress",
    cont: "Continue cherry-pick",
    verb: "Cherry-picking",
  },
  revert: {
    banner: "Revert in progress",
    cont: "Continue revert",
    verb: "Reverting",
  },
};

/** What Abort undoes, per op. A cherry-pick can be reached from "Cherry-pick to
 *  branch…", which switched branches to get here and whose abort does NOT switch
 *  back — so its copy promises this branch back, never the whole repository. */
const ABORT_DESCRIPTIONS: Record<RepoOp, string> = {
  merge:
    "Abandons the in-progress merge and restores the repository to the state before it started. Any conflict resolutions you've made will be lost.",
  rebase:
    "Abandons the in-progress rebase and restores the repository to the state before it started. Any conflict resolutions you've made will be lost.",
  "cherry-pick":
    "Abandons the in-progress cherry-pick and restores this branch to the state before the pick started. You stay on this branch, and any conflict resolutions you've made will be lost.",
  revert:
    "Abandons the in-progress revert and restores the repository to the state before it started. Any conflict resolutions you've made will be lost.",
};

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

/**
 * Guides an in-progress merge/rebase/cherry-pick/revert to its end: shows what's
 * mid-flight and how many conflicts remain, with Continue gated on every
 * conflict being resolved (staged) and Abort behind a confirm. Renders
 * nothing when the repo is in a normal state.
 */
export function ConflictBanner({
  repoPath,
  conflictedPaths,
}: {
  repoPath: string;
  conflictedPaths: string[];
}) {
  const opState = useOpState(repoPath);
  const abortOp = useOpAbort(repoPath);
  const continueOp = useOpContinue(repoPath);
  const aiEnabled = useAiEnabled();
  const reviewConfigured = useReviewConfigured();
  const startAll = useConflictResolve((s) => s.startAll);
  const [confirmAbort, setConfirmAbort] = useState(false);

  const conflictedCount = conflictedPaths.length;
  const op: RepoOp | null =
    OP_BY_FLAG.find(([flag]) => opState.data?.[flag])?.[1] ?? null;
  if (!op && conflictedCount === 0) return null;

  const canResolveWithAi = aiEnabled && reviewConfigured && conflictedCount > 0;

  const busy = abortOp.isPending || continueOp.isPending;
  const onError = (e: unknown) => toastError(e);
  const opVerb = op ? OP_LABELS[op].verb : null;
  const conflictText =
    conflictedCount > 0
      ? `${conflictedCount} conflict${conflictedCount === 1 ? "" : "s"}`
      : "all conflicts resolved";
  // A rebase deliberately paused at an `edit` (not a conflict): the user amends
  // the commit via the Changes tab, then continues.
  const editPaused = Boolean(opState.data?.editPaused) && conflictedCount === 0;

  // Awaited rather than per-call callbacks: this banner unmounts the moment the
  // op ends (and rides an <Activity>-hidden tab), and react-query drops per-call
  // callbacks once the observer has no listeners. The op travels as an argument
  // because `op` is nullable at component scope.
  async function doContinue(target: RepoOp) {
    try {
      const recorded = await continueOp.mutateAsync(target);
      // Only a resolution that emptied the pick reaches this: a commit whose
      // changes the destination already had never conflicts, so it is skipped
      // inside the pick itself and never pauses here. The flag speaks for that
      // one pick — a longer sequence may still have applied its remaining
      // commits.
      if (!recorded) {
        toast.info("Commit skipped — your resolution left nothing to commit.");
        return;
      }
      toast.success(
        target === "merge" ? "Merge completed" : `${opVerb} continued`,
      );
    } catch (e) {
      onError(e);
    }
  }

  async function doAbort(target: RepoOp) {
    try {
      await abortOp.mutateAsync(target);
      setConfirmAbort(false);
      toast.success(`Aborted the ${target}`);
    } catch (e) {
      setConfirmAbort(false);
      onError(e);
    }
  }

  return (
    // One calm status line — the per-file resolution actions live in the diff
    // pane's conflict view, so this just carries merge state + Continue/Abort
    // and the batch "Resolve all with AI".
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs">
      <span
        className={cn(
          "flex items-center gap-1.5",
          editPaused ? "text-info" : "text-warning",
        )}
      >
        {editPaused ? (
          <InfoIcon className="size-3.5 shrink-0" />
        ) : (
          <WarningIcon className="size-3.5 shrink-0" />
        )}
        {editPaused
          ? "Rebase paused — amend this commit's changes in Changes, then Continue"
          : opVerb
            ? `${opVerb} · ${conflictText}`
            : // No operation to continue or abort (a conflicted stash pop leaves
              // unmerged paths and nothing else), so the banner has to say where
              // the resolution happens.
              `${conflictText} — resolve ${conflictedCount === 1 ? "it" : "them"} in the changes list.`}
      </span>
      <div className="flex items-center gap-1.5">
        {canResolveWithAi && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => startAll(conflictedPaths, repoPath)}
          >
            <SparkleIcon data-icon="inline-start" />
            {conflictedCount === 1 ? "Resolve with AI" : "Resolve all with AI"}
          </Button>
        )}
        {op && (
          <>
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => setConfirmAbort(true)}
            >
              Abort
            </Button>
            <DisabledReasonButton
              size="xs"
              disabled={busy || conflictedCount > 0}
              reason={
                conflictedCount > 0 ? "Resolve every conflict first" : undefined
              }
              onClick={() => void doContinue(op)}
            >
              {continueOp.isPending && <Spinner data-icon="inline-start" />}
              {OP_LABELS[op].cont}
            </DisabledReasonButton>

            <Dialog open={confirmAbort} onOpenChange={setConfirmAbort}>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>
                    {editPaused ? "Abort editing history?" : `Abort the ${op}?`}
                  </DialogTitle>
                  <DialogDescription>
                    {editPaused
                      ? "Abandons the rebase and restores your branch to its original history. Any changes you've amended into this commit are lost."
                      : ABORT_DESCRIPTIONS[op]}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setConfirmAbort(false)}
                  >
                    Keep going
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={abortOp.isPending}
                    onClick={() => void doAbort(op)}
                  >
                    {abortOp.isPending && <Spinner data-icon="inline-start" />}
                    Abort {op}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        )}
      </div>
    </div>
  );
}
