import { useState } from "react";
import { toast } from "sonner";
import { isDirtyTreeRefusal, presentError } from "@/lib/error-summary";
import type {
  AutostashOutcome,
  PullDecisionShas,
  PullMode,
} from "@/lib/git/api";
import {
  useMergeAutostash,
  usePullAutostash,
  usePullRebaseDecidedAutostash,
  useRebaseAutostash,
  useRebaseOntoAutostash,
} from "@/lib/git/queries";
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { errorToastAction, toastError, toastErrorWithNote } from "@/lib/toast";
import {
  StashReapplyDialog,
  type StashReapplyTarget,
} from "./StashReapplyDialog";

/** Sentence-initial form of an operation word ("pull" → "Pull"). */
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Per-surface copy for the outcomes a compound can land on. The conflict and
 *  failure lines are shared templates — only the messages that name a branch or
 *  a ref are supplied per call site. */
export interface AutostashCopy {
  /** Capitalized operation word leading the shared templates ("Pull", "Update"). */
  operation: string;
  /** stash → run → pop, all clean. */
  reapplied: string;
  /** Nothing needed stashing and the operation just ran. Required: a recovery
   *  the user asked for explicitly must never end in silence, even on the
   *  surfaces whose ordinary success path shows no toast. */
  plain: string;
  /** Stash kept on purpose (switch with reapply off). */
  stashedOnly?: string;
  /** Replaces the stash-kept line for a failure that left NO in-progress state,
   *  when the surface can say something more specific than the generic default
   *  (e.g. naming the branch a switch failed to reach). */
  stashKept?: string;
}

/** The affordance `toastError` gives a thrown error, for stderr that arrives as
 *  an outcome payload instead — every failure variant keeps the raw git output
 *  one click away. */
function stderrAction(stderr: string) {
  return errorToastAction(presentError(stderr));
}

/**
 * Terminal feedback for a stash → run → reapply compound. Toasts only: the
 * durable state (conflicted entries, the conflict banner, the stash box) shows
 * itself once the invalidation lands.
 */
export function reportAutostashOutcome(
  outcome: AutostashOutcome,
  copy: AutostashCopy,
) {
  switch (outcome.kind) {
    case "reapplied":
      toast.success(copy.reapplied);
      return;
    case "nothingStashed":
      toast.success(copy.plain);
      return;
    case "stashedOnly":
      if (copy.stashedOnly) toast.success(copy.stashedOnly);
      return;
    case "reapplyConflicted":
      // Not success-styled: the operation landed, but the changes did not come
      // back on their own. Only a conflicted pop leaves anything to resolve.
      toast(
        outcome.conflicted
          ? `${copy.operation} finished — reapplying your changes hit conflicts. Fix them in the changes list; your stash is kept as a backup.`
          : `${copy.operation} finished — your changes couldn't be reapplied automatically. They're kept in the stash.`,
        { duration: 8000, action: stderrAction(outcome.stderr) },
      );
      return;
    case "opFailedStashKept":
      toast(
        outcome.inProgress
          ? `${copy.operation} hit conflicts — continue or abort in the banner. Your changes are safely stashed; pop them after.`
          : (copy.stashKept ??
              `${copy.operation} didn't finish — your changes are safely stashed; pop them when you're ready.`),
        { duration: 8000, action: stderrAction(outcome.stderr) },
      );
      return;
    case "opFailedRestored":
      toastErrorWithNote(
        outcome.stderr,
        "Your changes are back where they were.",
      );
      return;
  }
}

/** Which compound to run once the user confirms. */
export type StashReapplyRun =
  | { op: "pull"; mode: PullMode }
  | { op: "merge"; ref: string }
  | { op: "rebase"; ref: string }
  | { op: "rebaseOnto"; newBase: string; oldBase: string }
  // Carries the SHAs verbatim from the guard that asked the question: the
  // dirty-tree retry has to answer about the same state the user decided on.
  | ({ op: "pullRebaseDecided" } & PullDecisionShas);

/** One surface's pending recovery: what to say, and what to run. */
export interface StashReapplyRequest {
  /** Lower-case operation word — the dialog title and, capitalized, the toasts. */
  operationLabel: string;
  /** Optional phrase naming the operation's target, e.g. `upstream/main`. */
  detail?: string;
  /** Preposition joining `detail` to the operation word in the prompt.
   *  Defaults to "from"; a rebase runs *onto* its target. */
  detailPreposition?: string;
  /** Toast for a clean stash → run → reapply. */
  reappliedMessage: string;
  /** Toast when nothing needed stashing. Required — the user confirmed this
   *  run, so it must confirm back even where the ordinary path stays silent. */
  plainMessage: string;
  run: StashReapplyRun;
  /** Last look at an error this recovery's own run threw, before it becomes a
   *  plain toast. Returning true means the caller took it and will present it
   *  itself — the retried command can raise its own structured refusals (a
   *  rebase pull's fork-point guard runs on the compound too), and those deserve
   *  their dialog rather than a dead-end toast. */
  onUnhandledError?: (e: unknown) => boolean;
}

/** One mounted recovery, as another hook on the same surface consumes it — the
 *  guard that fires BEFORE a dirty-tree refusal hands its own retry back here
 *  rather than mounting a second recovery (and a second dialog). */
export type StashReapplyRecovery = ReturnType<typeof useStashReapplyRecovery>;

/**
 * The classify → prompt → retry → report choreography shared by every surface
 * that can hit a dirty-tree refusal (pull, update from upstream, update branch
 * from, rebase). Owns the prompt's state and the compound mutations, so a call
 * site only says what it was doing and how to redo it.
 *
 * `begin` is also the proactive entry point: a surface that already knows the
 * tree is dirty (the rebase-onto dialog) offers the compound instead of letting
 * git refuse first.
 *
 * With "Always stash and reapply" saved, the prompt is skipped and the compound
 * runs straight away.
 */
export function useStashReapplyRecovery(repoPath: string) {
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const pullAutostash = usePullAutostash(repoPath);
  const mergeAutostash = useMergeAutostash(repoPath);
  const rebaseAutostash = useRebaseAutostash(repoPath);
  const rebaseOntoAutostash = useRebaseOntoAutostash(repoPath);
  const pullDecidedAutostash = usePullRebaseDecidedAutostash(repoPath);
  const [request, setRequest] = useState<StashReapplyRequest | null>(null);

  const pending =
    pullAutostash.isPending ||
    mergeAutostash.isPending ||
    rebaseAutostash.isPending ||
    rebaseOntoAutostash.isPending ||
    pullDecidedAutostash.isPending;

  function runCompound(run: StashReapplyRun): Promise<AutostashOutcome> {
    switch (run.op) {
      case "pull":
        return pullAutostash.mutateAsync(run.mode);
      case "merge":
        return mergeAutostash.mutateAsync(run.ref);
      case "rebase":
        return rebaseAutostash.mutateAsync(run.ref);
      case "rebaseOnto":
        return rebaseOntoAutostash.mutateAsync({
          newBase: run.newBase,
          oldBase: run.oldBase,
        });
      case "pullRebaseDecided":
        return pullDecidedAutostash.mutateAsync(run);
    }
  }

  // Awaited, not per-call callbacks: a host can lose its effects mid-compound
  // (the pull-request selection or the repo tab changes), and react-query drops
  // per-call callbacks once the observer has no listeners — the report of a
  // recovery the user explicitly asked for would never arrive, stash included.
  async function runRecovery(req: StashReapplyRequest) {
    const copy: AutostashCopy = {
      operation: capitalize(req.operationLabel),
      reapplied: req.reappliedMessage,
      plain: req.plainMessage,
    };
    try {
      reportAutostashOutcome(await runCompound(req.run), copy);
    } catch (e) {
      if (!req.onUnhandledError?.(e)) toastError(e);
    } finally {
      setRequest(null);
    }
  }

  /** Start the recovery for an already-classified refusal. */
  function begin(req: StashReapplyRequest) {
    // Fire-and-forget: `handleError` is a synchronous guard expression for its
    // callers, so the compound can't be awaited from here.
    if (settings.data?.autoStashOnPull) void runRecovery(req);
    else setRequest(req);
  }

  /** Take `e` if it's a dirty-tree refusal; `false` means the caller still owns
   *  the error and should present it normally. */
  function handleError(e: unknown, req: StashReapplyRequest): boolean {
    if (!isDirtyTreeRefusal(e)) return false;
    begin(req);
    return true;
  }

  function confirm(always: boolean) {
    if (!request) return;
    // Write only on change (AmendForcePush precedent) — the prompt never shows
    // while the preference is already on.
    if (always && settings.data && !settings.data.autoStashOnPull) {
      void saveSettings
        .mutateAsync({ ...settings.data, autoStashOnPull: true })
        .catch(() => undefined);
    }
    void runRecovery(request);
  }

  return {
    handleError,
    begin,
    pending,
    dialog: (
      <StashReapplyDialog
        target={
          request
            ? ({
                operationLabel: request.operationLabel,
                detail: request.detail,
                detailPreposition: request.detailPreposition,
              } satisfies StashReapplyTarget)
            : null
        }
        onCancel={() => setRequest(null)}
        onConfirm={confirm}
        pending={pending}
      />
    ),
  };
}
