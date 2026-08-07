import { useState } from "react";
import { toast } from "sonner";
import { isDirtyTreeRefusal, presentError } from "@/lib/error-summary";
import type { AutostashOutcome, PullMode } from "@/lib/git/api";
import { useMergeAutostash, usePullAutostash } from "@/lib/git/queries";
import { useSaveSettings, useSettings } from "@/lib/settings/queries";
import { useErrorDialog } from "@/lib/stores/error-dialog";
import { toastError } from "@/lib/toast";
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

/** The Details/Copy affordance `toastError` gives a thrown error, for stderr
 *  that arrives as an outcome payload instead — every failure variant keeps the
 *  raw git output one click away. */
function stderrDetails(stderr: string) {
  const presentation = presentError(stderr);
  const action = presentation.long
    ? {
        label: "Details",
        onClick: () => useErrorDialog.getState().open(presentation),
      }
    : {
        label: "Copy",
        onClick: () => {
          navigator.clipboard.writeText(presentation.fullText).catch(() => {
            // clipboard denied — nothing useful to do
          });
        },
      };
  return { summary: presentation.summary, action };
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
        { duration: 8000, action: stderrDetails(outcome.stderr).action },
      );
      return;
    case "opFailedStashKept":
      toast(
        outcome.inProgress
          ? `${copy.operation} hit conflicts — continue or abort in the banner. Your changes are safely stashed; pop them after.`
          : (copy.stashKept ??
              `${copy.operation} didn't finish — your changes are safely stashed; pop them when you're ready.`),
        { duration: 8000, action: stderrDetails(outcome.stderr).action },
      );
      return;
    case "opFailedRestored": {
      const { summary, action } = stderrDetails(outcome.stderr);
      toast.error(summary, {
        description: "Your changes are back where they were.",
        duration: 8000,
        action,
      });
      return;
    }
  }
}

/** Which compound to run once the user confirms. */
export type StashReapplyRun =
  | { op: "pull"; mode: PullMode }
  | { op: "merge"; ref: string };

/** One surface's pending recovery: what to say, and what to run. */
export interface StashReapplyRequest {
  /** Lower-case operation word — the dialog title and, capitalized, the toasts. */
  operationLabel: string;
  /** Optional phrase naming the operation's target, e.g. `upstream/main`. */
  detail?: string;
  /** Toast for a clean stash → run → reapply. */
  reappliedMessage: string;
  /** Toast when nothing needed stashing. Required — the user confirmed this
   *  run, so it must confirm back even where the ordinary path stays silent. */
  plainMessage: string;
  run: StashReapplyRun;
}

/**
 * The classify → prompt → retry → report choreography shared by every surface
 * that can hit a dirty-tree refusal (pull, update from upstream, update branch
 * from). Owns the prompt's state and the two compound mutations, so a call site
 * only says what it was doing and how to redo it.
 *
 * With "Always stash and reapply" saved, the prompt is skipped and the compound
 * runs straight away.
 */
export function useStashReapplyRecovery(repoPath: string) {
  const settings = useSettings();
  const saveSettings = useSaveSettings();
  const pullAutostash = usePullAutostash(repoPath);
  const mergeAutostash = useMergeAutostash(repoPath);
  const [request, setRequest] = useState<StashReapplyRequest | null>(null);

  const pending = pullAutostash.isPending || mergeAutostash.isPending;

  function runRecovery(req: StashReapplyRequest) {
    const copy: AutostashCopy = {
      operation: capitalize(req.operationLabel),
      reapplied: req.reappliedMessage,
      plain: req.plainMessage,
    };
    const opts = {
      onSuccess: (outcome: AutostashOutcome) => {
        setRequest(null);
        reportAutostashOutcome(outcome, copy);
      },
      onError: (e: Error) => {
        setRequest(null);
        toastError(e);
      },
    };
    if (req.run.op === "pull") pullAutostash.mutate(req.run.mode, opts);
    else mergeAutostash.mutate(req.run.ref, opts);
  }

  /** Start the recovery for an already-classified refusal. */
  function begin(req: StashReapplyRequest) {
    if (settings.data?.autoStashOnPull) runRecovery(req);
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
      saveSettings.mutate({ ...settings.data, autoStashOnPull: true });
    }
    runRecovery(request);
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
