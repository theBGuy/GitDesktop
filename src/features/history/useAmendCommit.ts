import { useCallback, useState } from "react";
import { toast } from "sonner";
import { isForcePushBlocked } from "@/lib/branch-rules/match";
import { useEffectiveBranchRules } from "@/lib/branch-rules/queries";
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
  const amend = useAmendCommit(repoPath);
  const [pendingHash, setPendingHash] = useState<string | null>(null);

  const branch = status.data?.branch;
  const upstream = branch?.upstream ?? null;
  // A gone upstream (remote branch deleted) reads as no upstream: the commit
  // isn't on any live remote, so amending it is a plain re-commit, not a
  // force-push.
  const needsForcePush =
    upstream !== null && !branch?.upstreamGone && (branch?.ahead ?? 0) === 0;

  function requestAmend(hash: string) {
    // Amending an already-pushed commit means force-pushing it. If a branch
    // rule blocks force-pushes here, refuse outright rather than confirm.
    if (
      needsForcePush &&
      branch?.name &&
      isForcePushBlocked(rulesConfig, branch.name)
    ) {
      toast.error(
        `${branch.name} is protected: force-pushing (amending a pushed commit) is blocked by a branch rule`,
      );
      return;
    }
    if (needsForcePush && (settings.data?.confirmAmendForcePush ?? true)) {
      setPendingHash(hash);
    } else {
      amend(hash).catch(toastError);
    }
  }

  function confirmAmend() {
    const hash = pendingHash;
    setPendingHash(null);
    if (hash) amend(hash).catch(toastError);
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
