import {
  InfoIcon,
  SparkleIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
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
import { useFocusOnControlsSwap } from "@/features/diff/use-hidden-trigger-focus";
import {
  useDropStashBySha,
  useOpAbort,
  useOpContinue,
  useOpState,
  useStashCount,
} from "@/lib/git/queries";
import type { RepoOp } from "@/lib/git/types";
import { dispatchAction, useHotkeyAction } from "@/lib/hotkeys/hotkeys";
import { useAiEnabled, useReviewConfigured } from "@/lib/settings/queries";
import { useConfirm } from "@/lib/stores/confirm";
import { useConflictResolve } from "@/lib/stores/conflict-resolve";
import { useStashReapplyMarker } from "@/lib/stores/stash-reapply-marker";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  activeRepoOp,
  deriveStashBannerState,
  opPhrase,
} from "./conflict-banner-state";

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

/** The AI button drops to its icon below a 505px banner content box, where the
 *  full-label cluster (396.8px measured with "Continue cherry-pick") can't share
 *  a row with any status. Both classes carry the one cutoff. */
const AI_ICON_ONLY =
  "@max-[505px]/conflict-banner:pr-1.5 @max-[505px]/conflict-banner:*:data-[slot=ai-label]:hidden";

const BUSY_REASON = "An operation is in progress";

/** Clears the reapply marker only while it still names `stashSha`: a compound
 *  that ran meanwhile may have recorded a newer one. */
function clearMarkerIfStill(stashSha: string) {
  const { marker, clear } = useStashReapplyMarker.getState();
  if (marker?.stashSha === stashSha) clear();
}

/** Runs `then` once no dialog popup is mounted (capped at ~300 ms). The confirm
 *  host's dialog animates out and Base UI returns focus around its unmount, so a
 *  single frame can still see focus inside the closing popup. */
function afterDialogCloses(then: () => void): () => void {
  const start = performance.now();
  let frame = 0;
  const tick = () => {
    if (
      document.querySelector('[data-slot="dialog-content"]') &&
      performance.now() - start < 300
    ) {
      frame = requestAnimationFrame(tick);
      return;
    }
    then();
  };
  frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

const dialogClosed = () =>
  new Promise<void>((resolve) => {
    afterDialogCloses(resolve);
  });

function toastStashMoved() {
  toast.info("The stash list changed — nothing was dropped.", {
    action: {
      label: "View stashes",
      onClick: (event) => {
        // Blur first so sonner's focus restore runs before the dialog opens,
        // not after (it would pull focus back out of it).
        event.currentTarget.blur();
        dispatchAction("view-stashes");
      },
    },
  });
}

function toastStashGone() {
  toast.info("The backup stash is already gone, so there was nothing to drop.");
}

/** The conflicted tail with its branch name in mono, wrapping anywhere: a long
 *  base name must never truncate the sentence. Branch names hold no spaces, so
 *  the detail is exactly what precedes the first " finished.". */
function ReapplyTail({ text, detail }: { text: string; detail?: string }) {
  const end = text.indexOf(" finished.");
  const start = detail ? end - detail.length : -1;
  if (!detail || start < 0 || text.slice(start, end) !== detail) return text;
  return (
    <>
      {text.slice(0, start)}
      <span className="font-mono [overflow-wrap:anywhere]">{detail}</span>
      {text.slice(end)}
    </>
  );
}

/**
 * Guides an in-progress merge/rebase/cherry-pick/revert to its end: shows what's
 * mid-flight and how many conflicts remain, with Continue gated on every
 * conflict being resolved (staged) and Abort behind a confirm. Conflicts left by
 * reapplying an autostash are named as such, and once resolved the strip offers
 * to drop or keep the backup stash. Renders only its live region when the repo
 * is in a normal state.
 */
export function ConflictBanner({
  repoPath,
  conflictedPaths,
  statusUpdatedAt,
  landingRef,
}: {
  repoPath: string;
  conflictedPaths: string[];
  /** `dataUpdatedAt` of the status read `conflictedPaths` came from. */
  statusUpdatedAt: number;
  /** Where focus lands when an action here unmounts the strip under it. */
  landingRef: RefObject<HTMLElement | null>;
}) {
  const opState = useOpState(repoPath);
  const abortOp = useOpAbort(repoPath);
  const continueOp = useOpContinue(repoPath);
  const aiEnabled = useAiEnabled();
  const reviewConfigured = useReviewConfigured();
  const startAll = useConflictResolve((s) => s.startAll);
  const [confirmAbort, setConfirmAbort] = useState(false);
  const stashCount = useStashCount(repoPath);
  const marker = useStashReapplyMarker((s) => s.marker);
  const drop = useDropStashBySha(repoPath);
  const confirmClosed = useConfirm((s) => s.request === null);
  const tailId = useId();
  const dropBtnRef = useRef<HTMLButtonElement>(null);
  // A cancelled drop confirm wants focus back on Drop. The flag is read when the
  // dialog has finished closing, never when ask() resolves: that happens inside
  // the host's answer, while focus still sits on the dialog's own Cancel.
  const pendingCancelRefocus = useRef(false);

  const conflictedCount = conflictedPaths.length;
  const op = activeRepoOp(opState.data);
  const { state, clearMarker } = deriveStashBannerState({
    marker,
    repoPath,
    opActive: op !== null,
    conflictedCount,
    statusUpdatedAt,
    stashCount: stashCount.data,
    stashCountUpdatedAt: stashCount.dataUpdatedAt,
  });
  const resolvedShown = op === null && state.kind === "resolved";
  const markerRows = op === null && state.kind !== "none";
  // When Drop, Keep or a refusal unmounts the reapply rows and focus fell to
  // <body>, land it on the panel's landing target. Change-only: never on mount.
  useFocusOnControlsSwap(markerRows, landingRef);

  const clearSha = clearMarker ? marker?.stashSha : undefined;
  useEffect(() => {
    if (clearSha) clearMarkerIfStill(clearSha);
  }, [clearSha]);

  useEffect(() => {
    if (!confirmClosed) return;
    return afterDialogCloses(() => {
      if (!pendingCancelRefocus.current) return;
      pendingCancelRefocus.current = false;
      if (document.activeElement === document.body) {
        dropBtnRef.current?.focus();
      }
    });
  }, [confirmClosed]);

  useHotkeyAction(
    "drop-backup-stash",
    () => void doDrop(),
    resolvedShown && !drop.isPending,
  );
  useHotkeyAction(
    "keep-backup-stash",
    doKeep,
    resolvedShown && !drop.isPending,
  );

  const shown = op !== null || conflictedCount > 0 || resolvedShown;

  const canResolveWithAi = aiEnabled && reviewConfigured && conflictedCount > 0;
  const aiLabel =
    conflictedCount === 1 ? "Resolve with AI" : "Resolve all with AI";

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
  const infoTone = editPaused || resolvedShown;

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

  /** A fast drop settles before the confirm's exit, so its strip can unmount
   *  while focus is still in the dialog; Base UI then returns focus to a removed
   *  Drop button and it falls to `<body>`. */
  function rescueOrphanedFocus() {
    afterDialogCloses(() => {
      if (document.activeElement !== document.body) return;
      (dropBtnRef.current ?? landingRef.current)?.focus();
    });
  }

  async function doDrop() {
    // A superseding ask resolves ours false without the request passing through
    // null, so a flag left from that cancel must not fire on a later close.
    pendingCancelRefocus.current = false;
    const recorded = useStashReapplyMarker.getState().marker;
    if (!recorded || recorded.repoPath !== repoPath) return;
    const ok = await useConfirm.getState().ask({
      title: "Drop the backup stash?",
      body: (
        <>
          Permanently deletes the backup stash (
          <span className="font-mono">{recorded.stashSha.slice(0, 7)}</span>)
          saved before the {opPhrase(recorded)}, along with the changes it
          holds. Your working tree stays as it is now. This cannot be undone.
        </>
      ),
      confirmLabel: "Drop stash",
      confirmVariant: "destructive",
    });
    if (!ok) {
      pendingCancelRefocus.current = true;
      return;
    }
    // The prompt was up for a while: the marker may have moved on. A repo
    // switch already cancelled the prompt with its own notice.
    if (useUiStore.getState().repoPath !== repoPath) return;
    const live = useStashReapplyMarker.getState().marker;
    if (live?.repoPath !== repoPath || live.stashSha !== recorded.stashSha) {
      // A cleared marker needn't mean the backup is gone (a newer stash or a
      // settling compound retires it too), so both causes read as a change.
      toastStashMoved();
      await dialogClosed();
      // The strip that hosted Drop is gone or replaced, so wherever Base UI's
      // fallback put focus, it was never the user's choice: place it outright.
      (dropBtnRef.current ?? landingRef.current)?.focus();
      return;
    }
    let outcome: Awaited<ReturnType<typeof drop.mutateAsync>>;
    try {
      outcome = await drop.mutateAsync(recorded.stashSha);
    } catch (e) {
      // The offer stands for a retry.
      toastError(e);
      rescueOrphanedFocus();
      return;
    }
    switch (outcome.kind) {
      case "dropped":
        toast.success("Backup stash dropped");
        break;
      case "moved":
        toastStashMoved();
        break;
      case "gone":
        toastStashGone();
        break;
      case "restoreFailed":
        toast.error(
          `The stash list changed — a different stash (${outcome.droppedSha.slice(0, 7)}) was dropped and couldn't be restored. Recover it under View stashes → Recoverable.`,
          {
            // The only place the lost entry's sha appears: it stays until closed.
            duration: Infinity,
            action: {
              label: "Recover",
              onClick: (event) => {
                event.currentTarget.blur();
                dispatchAction("recover-lost-work");
              },
            },
          },
        );
        break;
    }
    // Every verdict retires this offer: a refusal would only refuse again. The
    // clear waits out the confirm's exit so Base UI returns focus to a mounted
    // Drop button (an earlier unmount sends it to an older element instead);
    // the strip then unmounts onto <body>, which the marker-rows rescue catches.
    await dialogClosed();
    clearMarkerIfStill(recorded.stashSha);
    rescueOrphanedFocus();
  }

  function doKeep() {
    const recorded = useStashReapplyMarker.getState().marker;
    if (recorded?.repoPath === repoPath) clearMarkerIfStill(recorded.stashSha);
  }

  return (
    <>
      {/* Pre-mounted in every state, at one tree position: a live region created
          together with its text announces unreliably. No aria-busy, which would
          withhold the announcement. */}
      <div role="status" className="sr-only">
        {state.kind === "resolved" ? state.announcement : ""}
      </div>
      {shown && (
        // One row while the full status and the actions fit side by side;
        // otherwise the actions wrap under it, right-aligned. The status keeps
        // its content basis so line-breaking measures its whole text and it
        // never truncates.
        <div className="@container/conflict-banner flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs">
          <span
            className={cn(
              "flex min-w-0 grow items-start gap-1.5",
              infoTone ? "text-info" : "text-warning",
            )}
          >
            {infoTone ? (
              <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
            ) : (
              <WarningIcon className="mt-0.5 size-3.5 shrink-0" />
            )}
            <span className="min-w-0 text-pretty">
              {editPaused ? (
                "Rebase paused — amend this commit's changes in Changes, then Continue"
              ) : opVerb ? (
                `${opVerb} · ${conflictText}`
              ) : markerRows ? (
                <>
                  {state.lead}
                  <span id={tailId} className="block text-muted-foreground">
                    <ReapplyTail text={state.tail} detail={marker?.detail} />
                  </span>
                </>
              ) : (
                // No operation to continue or abort (a conflicted stash pop
                // leaves unmerged paths and nothing else), so the banner has to
                // say where the resolution happens.
                `${conflictText} — resolve ${conflictedCount === 1 ? "it" : "them"} in the changes list.`
              )}
            </span>
          </span>
          {/* `empty:hidden` drops the item when there is nothing to act on: an
              empty flex item still takes the column gap and would wrap onto a
              blank line. */}
          <div className="ml-auto flex shrink-0 items-center gap-1.5 empty:hidden">
            {canResolveWithAi && (
              <Button
                size="xs"
                variant="ghost"
                className={AI_ICON_ONLY}
                title={aiLabel}
                aria-label={aiLabel}
                onClick={() => startAll(conflictedPaths, repoPath)}
              >
                <SparkleIcon data-icon="inline-start" />
                <span data-slot="ai-label">{aiLabel}</span>
              </Button>
            )}
            {resolvedShown && (
              <>
                <DisabledReasonButton
                  ref={dropBtnRef}
                  variant="ghost"
                  size="xs"
                  className="text-destructive"
                  disabled={drop.isPending}
                  reason={BUSY_REASON}
                  aria-describedby={tailId}
                  onClick={() => void doDrop()}
                >
                  {drop.isPending ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <TrashIcon data-icon="inline-start" />
                  )}
                  Drop backup stash…
                </DisabledReasonButton>
                <DisabledReasonButton
                  variant="outline"
                  size="xs"
                  disabled={drop.isPending}
                  reason={BUSY_REASON}
                  aria-describedby={tailId}
                  onClick={doKeep}
                >
                  Keep it
                </DisabledReasonButton>
              </>
            )}
            {op && (
              <>
                <DisabledReasonButton
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  reason={BUSY_REASON}
                  onClick={() => setConfirmAbort(true)}
                >
                  Abort
                </DisabledReasonButton>
                <DisabledReasonButton
                  size="xs"
                  disabled={busy || conflictedCount > 0}
                  reason={
                    conflictedCount > 0
                      ? "Resolve every conflict first"
                      : undefined
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
                        {editPaused
                          ? "Abort editing history?"
                          : `Abort the ${op}?`}
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
                        {abortOp.isPending && (
                          <Spinner data-icon="inline-start" />
                        )}
                        Abort {op}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
