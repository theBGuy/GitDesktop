import { useCallback, useState } from "react";
import { toast } from "sonner";
import { isForcePushBlocked } from "@/lib/branch-rules/match";
import {
  useEffectiveBranchRules,
  useEffectiveBranchRulesSettling,
} from "@/lib/branch-rules/queries";
import { gitCommitDetails } from "@/lib/git/api";
import { useRepoStatus } from "@/lib/git/queries";
import { useSettings } from "@/lib/settings/queries";
import { useUiStore } from "@/lib/stores/ui";
import { toastError } from "@/lib/toast";

/**
 * Loads a commit's message into the commit box and switches to the Changes
 * tab in amend mode. Shared by the history context menu and the commit
 * detail actions menu. Throws on lookup failure; callers surface the error.
 */
export function useAmendCommit(repoPath: string) {
  const setCommitDraft = useUiStore((s) => s.setCommitDraft);
  const setAmending = useUiStore((s) => s.setAmending);
  const setRepoTab = useUiStore((s) => s.setRepoTab);

  return useCallback(
    async (hash: string) => {
      const details = await gitCommitDetails(repoPath, hash);
      setCommitDraft(details.subject, details.body);
      setAmending(hash);
      setRepoTab("changes");
    },
    [repoPath, setCommitDraft, setAmending, setRepoTab],
  );
}

const RULES_SETTLING_MESSAGE =
  "Branch rules are still loading — try again in a moment";

const STATUS_SETTLING_MESSAGE =
  "Still reading this branch's state — try again in a moment";

const protectedBranchMessage = (name: string) =>
  `${name} is protected: force-pushing (amending a pushed commit) is blocked by a branch rule`;

/**
 * Amend, gated by a force-push confirmation when the commit is already on the
 * remote (an upstream exists and HEAD isn't ahead of it). Returns the request
 * function plus the state to drive an `<AmendForcePushDialog>`. Pair it with
 * that dialog at the call site.
 */
export function useAmendWithConfirm(repoPath: string) {
  const status = useRepoStatus(repoPath);
  const settings = useSettings();
  const rulesConfig = useEffectiveBranchRules(repoPath);
  // While either rules scope is on its FIRST read the effective config stands in
  // as empty, so `isForcePushBlocked` is vacuously false — the force-push arm
  // holds on this instead. A plain amend never consults the rules, so it never
  // holds on them.
  const rulesSettling = useEffectiveBranchRulesSettling(repoPath);
  const amend = useAmendCommit(repoPath);
  const [pendingHash, setPendingHash] = useState<string | null>(null);

  const branch = status.data?.branch;
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
  const statusSettling = status.data === undefined;

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
   *  this, so neither a refusal nor a failed lookup (a commit gc'd or rewritten
   *  under the open dialog) turns off the prompt. */
  async function confirmAmend(): Promise<boolean> {
    const hash = pendingHash;
    setPendingHash(null);
    // The gate can flip under an open dialog: the rules may have settled to
    // blocked, or may still be settling. Every read it takes is pre-await.
    if (forcePushRefused()) return false;
    if (!hash) return false;
    try {
      await amend(hash);
    } catch (e) {
      toastError(e);
      return false;
    }
    return true;
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
