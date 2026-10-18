import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { isForcePushBlocked } from "@/lib/branch-rules/match";
import {
  useEffectiveBranchRules,
  useEffectiveBranchRulesSettling,
} from "@/lib/branch-rules/queries";
import { gitCommitDetails, headBranchPin } from "@/lib/git/api";
import { repoStatusOptions, repoStatusPoll } from "@/lib/git/queries";
import type { RepoStatus } from "@/lib/git/types";
import { useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";

/**
 * Loads a commit's message into the commit box and switches to the Changes
 * tab in amend mode. Shared by the history context menu and the commit
 * detail actions menu. Throws on lookup failure; callers surface the error.
 * Resolves whether the amend landed: false when the user moved on (another
 * navigation or repo) while the commit loaded, which is silent.
 */
export function useAmendCommit(repoPath: string) {
  const queryClient = useQueryClient();
  const noteUserInteraction = useUiStore((s) => s.noteUserInteraction);
  const landAmend = useUiStore((s) => s.landAmend);

  return useCallback(
    async (hash: string): Promise<boolean> => {
      // The request is a navigation (to Changes), so it bumps NOW, and the bump
      // stands even if the lookup fails: the click is the user's latest request.
      // The landing after the await is non-bumping and only while nothing moved.
      noteUserInteraction();
      const { interactionEpoch: epoch, repoPath: firedOn } =
        useUiStore.getState();
      // The branch pin is the HEAD shown when this runs (on the force-push route, at
      // confirm), stored beside the oid pin; an unread status leaves the oid pin to
      // stand alone.
      const shownHead = queryClient.getQueryData<RepoStatus>(
        repoStatusOptions(repoPath).queryKey,
      )?.branch;
      const branch = shownHead ? headBranchPin(shownHead) : null;
      const details = await gitCommitDetails(repoPath, hash);
      const live = useUiStore.getState();
      if (live.interactionEpoch !== epoch || live.repoPath !== firedOn) {
        return false;
      }
      landAmend(hash, branch, details.subject, details.body);
      return true;
    },
    [repoPath, queryClient, noteUserInteraction, landAmend],
  );
}

const RULES_SETTLING_MESSAGE =
  "Branch rules are still loading — try again in a moment";

const STATUS_SETTLING_MESSAGE =
  "Still reading this branch's state — try again in a moment";

const protectedBranchMessage = (name: string) =>
  `${name} is protected: force-pushing (amending a pushed commit) is blocked by a branch rule`;

/** The only status fields the force-push gate reads. Structural sharing keeps an
 *  equal result referentially stable, so working-tree changes in the polled
 *  status don't re-render the hosts (the commit detail view's diff pane). */
const selectAmendBranch = (s: RepoStatus) => ({
  name: s.branch?.name ?? null,
  upstream: s.branch?.upstream ?? null,
  upstreamGone: s.branch?.upstreamGone ?? false,
  ahead: s.branch?.ahead ?? 0,
});

/**
 * Amend, gated by a force-push confirmation when the commit is already on the
 * remote (an upstream exists and HEAD isn't ahead of it). Returns the request
 * function plus the state to drive an `<AmendForcePushDialog>`. Pair it with
 * that dialog at the call site.
 */
export function useAmendWithConfirm(repoPath: string) {
  const branch = useQuery({
    ...repoStatusOptions(repoPath),
    ...repoStatusPoll,
    select: selectAmendBranch,
  }).data;
  const settings = useSettings();
  const rulesConfig = useEffectiveBranchRules(repoPath);
  // While either rules scope is on its FIRST read the effective config stands in
  // as empty, so `isForcePushBlocked` is vacuously false — the force-push arm
  // holds on this instead. A plain amend never consults the rules, so it never
  // holds on them.
  const rulesSettling = useEffectiveBranchRulesSettling(repoPath);
  const amend = useAmendCommit(repoPath);
  const [pendingHash, setPendingHash] = useState<string | null>(null);

  const upstream = branch?.upstream ?? null;
  // A gone upstream (remote branch deleted) reads as no upstream: the commit
  // isn't on any live remote, so amending it is a plain re-commit, not a
  // force-push.
  const needsForcePush =
    upstream !== null && !branch?.upstreamGone && (branch?.ahead ?? 0) === 0;
  // The same stand-in problem one axis out: with no status data there is no
  // branch, so `needsForcePush` reads vacuously false and the whole force-push
  // arm is skipped. An ERRORED read is the same blind state and holds too — the
  // query's 5s interval keeps asking, so the hold lifts itself as soon as any
  // read lands, and from then on the gate reads measured values.
  const statusSettling = branch === undefined;

  // Amending an already-pushed commit means force-pushing it. Shared by request
  // and confirm so the two refusal paths can't drift.
  function forcePushRefused(): boolean {
    // Ahead of the `needsForcePush` test, which is the value this hold protects.
    if (statusSettling) {
      toast.error(STATUS_SETTLING_MESSAGE);
      return true;
    }
    if (!needsForcePush) return false;
    if (rulesSettling) {
      toast.error(RULES_SETTLING_MESSAGE);
      return true;
    }
    if (branch?.name && isForcePushBlocked(rulesConfig, branch.name)) {
      toast.error(protectedBranchMessage(branch.name));
      return true;
    }
    return false;
  }

  function requestAmend(hash: string) {
    if (forcePushRefused()) return;
    if (needsForcePush && (settings.data?.confirmAmendForcePush ?? true)) {
      setPendingHash(hash);
    } else {
      amend(hash).catch(toastError);
    }
  }

  /** True once the amend has actually STARTED — the gate accepted it AND the
   *  commit loaded into the box. The dialog keys its "Don't show again" write on
   *  this, so neither a refusal, a failed lookup (a commit gc'd or rewritten
   *  under the open dialog), nor a landing the user navigated away from turns
   *  off the prompt. */
  async function confirmAmend(): Promise<boolean> {
    const hash = pendingHash;
    setPendingHash(null);
    // The gate can flip under an open dialog: the rules may have settled to
    // blocked, or may still be settling. Every read it takes is pre-await.
    if (forcePushRefused()) return false;
    if (!hash) return false;
    try {
      return await amend(hash);
    } catch (e) {
      toastError(e);
      return false;
    }
  }

  return {
    requestAmend,
    /** Props for the paired <AmendForcePushDialog>. */
    forcePushDialog: {
      open: pendingHash !== null,
      upstream,
      onConfirm: confirmAmend,
      onCancel: () => setPendingHash(null),
    },
  };
}
