import { useMemo } from "react";
import {
  forgeFeatureReady,
  useForgeStatus,
  usePrList,
} from "@/lib/git/queries";
import { useLocalPrs } from "./queries";

/** PR lifecycle states — the same vocabulary the branch picker badges use. */
export type PrAuditState = "open" | "draft" | "merged" | "closed";

export interface PrAudit {
  state: PrAuditState;
  /** "#123" for a GitHub PR, "local" for a local-only one. */
  label: string;
}

// Most actionable / authoritative state wins when a branch has several PRs —
// mirrors BranchSwitcher's PR_RANK so the two surfaces never disagree.
const RANK: Record<PrAuditState, number> = {
  open: 3,
  draft: 3,
  merged: 2,
  closed: 1,
};

/** GitHub's PR-state palette, via the app's semantic color tokens. */
export const PR_AUDIT_TONE: Record<PrAuditState, string> = {
  open: "text-success",
  draft: "text-muted-foreground",
  merged: "text-merged",
  closed: "text-destructive",
};

/** Short labels for a compact audit chip (text carries the meaning, not color). */
export const PR_AUDIT_LABEL: Record<PrAuditState, string> = {
  open: "PR open",
  draft: "PR draft",
  merged: "Merged",
  closed: "PR closed",
};

/**
 * Maps each branch name to its pull-request state, drawn from BOTH the local PR
 * store and (when `enabled` and a GitHub remote is connected) the repo's GitHub
 * PRs. This is the audit link for an agent session: its branch → was a PR opened,
 * and was it merged? Both sources matter because **promoting** a local PR to
 * GitHub closes the local record, so the merge then lives only on the remote PR;
 * looking at the local store alone would under-report a real merge as "closed".
 *
 * Why PR status and not `git merge-base --is-ancestor`: the squash/rebase merges
 * GitHub does by default leave no ancestor link, so an is-ancestor probe reports a
 * merged branch as un-merged. The PR's own status is the reliable signal.
 *
 * Remote lists are cached (30s) and shared with the rest of the app, and only
 * fetched when `enabled` — pass `false` until there's something finalized to audit.
 */
export function usePrAuditByBranch(
  repo: string,
  enabled: boolean,
): Map<string, PrAudit> {
  const localPrs = useLocalPrs(repo);
  const forge = useForgeStatus(repo);
  const remote = enabled && forgeFeatureReady(forge.data, "pullRequests");
  // Origin lens: the branch audit maps the FORK's own branches to their PRs; the
  // fork/upstream lens is a PR/Issues-tab affordance.
  const openPrs = usePrList(repo, remote, "open", undefined, "origin");
  const closedPrs = usePrList(repo, remote, "closed", undefined, "origin");

  return useMemo(() => {
    const map = new Map<string, PrAudit>();
    const consider = (branch: string, cand: PrAudit) => {
      const cur = map.get(branch);
      if (!cur || RANK[cand.state] > RANK[cur.state]) map.set(branch, cand);
    };
    // Remote PRs first, so they win ties against a local PR of equal state.
    for (const pr of [...(openPrs.data ?? []), ...(closedPrs.data ?? [])]) {
      // Fork PRs never attach by name — same guard and rationale as
      // BranchSwitcher's prByBranch (origin-pinned lists; GitHub-only flag).
      if (pr.crossRepository) continue;
      const state: PrAuditState =
        pr.isDraft && pr.state === "OPEN"
          ? "draft"
          : pr.state === "MERGED"
            ? "merged"
            : pr.state === "CLOSED"
              ? "closed"
              : "open";
      consider(pr.headRefName, { state, label: `#${pr.number}` });
    }
    for (const pr of localPrs.data ?? []) {
      const state: PrAuditState =
        pr.status === "merged"
          ? "merged"
          : pr.status === "closed"
            ? "closed"
            : "open";
      consider(pr.head, { state, label: "local" });
    }
    return map;
  }, [openPrs.data, closedPrs.data, localPrs.data]);
}
