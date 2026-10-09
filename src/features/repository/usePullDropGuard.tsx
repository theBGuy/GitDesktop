import { useState } from "react";
import { toast } from "sonner";
import {
  isPullWouldDrop,
  isStalePullDecision,
  PULL_DECISION_STALE_MESSAGE,
} from "@/lib/error-summary";
import type {
  PullDecision,
  PullDecisionShas,
  PullWouldDrop,
} from "@/lib/git/api";
import { usePullRebaseDecided } from "@/lib/git/queries";
import { useUiStore } from "@/lib/stores/ui";
import { promotionBlocksCheckout } from "@/lib/stores/worktree-removal";
import { toastError } from "@/lib/toast";
import { PROMOTION_BLOCKS_CHECKOUT } from "./checkout-copy";
import {
  PULL_DECISION_COPY,
  PullRebaseDropDialog,
} from "./PullRebaseDropDialog";
import type {
  StashReapplyRecovery,
  StashReapplyRequest,
} from "./useStashReapplyRecovery";

/**
 * The refuse → ask → re-run choreography for a rebase pull that would rewrite
 * local commits away. The guard fires before git touches the working tree, so
 * it is asked FIRST on a failed pull — ahead of the dirty-tree recovery, which
 * only ever sees refusals from the run itself.
 *
 * The decision is answered with the SHAs the refusal carried, never re-derived:
 * the app auto-fetches in the background, and Rust refuses outright if HEAD has
 * moved since the question was asked.
 *
 * `recovery` is the call site's own mounted recovery — the decided re-run can
 * still hit a dirty tree, and routing it through the existing hook keeps one
 * stash prompt on the surface instead of two.
 */
export function usePullDropGuard(
  repoPath: string,
  recovery: StashReapplyRecovery,
) {
  const decided = usePullRebaseDecided(repoPath);
  // The open question carries the repo it was raised in: the decided re-run
  // goes through a hook bound to the LIVE repo, so answering it after a repo
  // switch would rebase that repo with the old one's SHAs.
  const [asked, setAsked] = useState<{
    refusal: PullWouldDrop;
    repo: string;
  } | null>(null);
  const refusal = asked?.refusal ?? null;
  const [running, setRunning] = useState<PullDecision | null>(null);
  // `running` is set synchronously before the mutation is fired, while
  // `isPending` only turns true once react-query flushes its own notification —
  // one render frame apart. Taking either as busy closes that window, in which
  // the buttons would still be live and a close still honored.
  const busy = decided.isPending || running !== null;

  /** Take `e` if it's the fork-point refusal; `false` means the caller still
   *  owns the error and should present it normally. */
  function handleError(e: unknown): boolean {
    if (!isPullWouldDrop(e)) return false;
    // A refusal settling after a repo switch is the caller's to report.
    if (useUiStore.getState().repoPath !== repoPath) return false;
    setAsked({ refusal: e, repo: repoPath });
    return true;
  }

  /** The same last look, for errors thrown by a stash → run → reapply retry.
   *  A retried rebase pull re-runs the fork-point guard (it fires before the
   *  stash), and a retried decision can outlive the tip it pinned — both would
   *  otherwise reach the user as a dead-end toast on exactly the scenario this
   *  feature exists to handle. */
  function handleRecoveryError(e: unknown): boolean {
    if (isStalePullDecision(e)) {
      toast(PULL_DECISION_STALE_MESSAGE);
      return true;
    }
    return handleError(e);
  }

  // Awaited rather than given per-call callbacks, matching the recovery hook:
  // react-query drops those once the observer loses its listeners, and a rebase
  // the user explicitly authorized must report back either way.
  async function decide(decision: PullDecision) {
    if (!asked) return;
    const { refusal, repo } = asked;
    if (useUiStore.getState().repoPath !== repo) {
      toast.info(
        "Didn't pull — that question was for another repository. Switch back to it and try again.",
      );
      setAsked(null);
      return;
    }
    if (promotionBlocksCheckout(repoPath)) {
      toast.info(PROMOTION_BLOCKS_CHECKOUT);
      setAsked(null);
      return;
    }
    const shas: PullDecisionShas = {
      branch: refusal.branch,
      decision,
      newTip: refusal.newTip,
      keepBase: refusal.mergeBase,
      dropBase: refusal.forkPoint,
      expectedTip: refusal.branchTip,
    };
    const count = refusal.commits.length;
    const upstream = refusal.upstream;
    // The answer travels with the retry: a dirty-tree recovery that reported
    // only "Pulled with rebase" would drop the very fact the user decided.
    const outcome = PULL_DECISION_COPY[decision].outcome(count);
    const retry: StashReapplyRequest = {
      operationLabel: "pull",
      detail: upstream,
      reappliedMessage: `Pulled with rebase and reapplied your changes — ${outcome}.`,
      plainMessage: `Pulled with rebase — ${outcome}.`,
      run: { op: "pullRebaseDecided", ...shas },
      onUnhandledError: handleRecoveryError,
    };
    setRunning(decision);
    try {
      await decided.mutateAsync(shas);
      toast.success("Pulled with rebase", { description: outcome });
    } catch (e) {
      if (isStalePullDecision(e)) {
        toast(PULL_DECISION_STALE_MESSAGE);
      } else if (!recovery.handleError(e, retry)) {
        toastError(e);
      }
    } finally {
      // Closed on every settled outcome: the answer has been acted on, and a
      // modal left standing would cover the banner or stash prompt the failure
      // arms above just handed the user.
      setRunning(null);
      setAsked(null);
    }
  }

  return {
    handleError,
    handleRecoveryError,
    pending: busy,
    dialog: (
      <PullRebaseDropDialog
        refusal={refusal}
        busy={busy}
        running={running}
        onCancel={() => setAsked(null)}
        onDecide={(decision) => void decide(decision)}
      />
    ),
  };
}
