import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { maybeFireSync } from "@/lib/automations/sync";
import { gitBranchTips } from "@/lib/git/api";
import { useLocalPrs } from "@/lib/pulls/queries";
import { useAiEnabled } from "@/lib/settings/queries";

/**
 * Watches each OPEN LOCAL PR's head branch for new commits and fires a `pr-sync`
 * automation event when a head advances. Polls all open local PRs' head tips in
 * one `git_branch_tips` call — fast (10 s) and fires the moment you commit. (For
 * remote PRs, `usePrNotifications` watches the GitHub head OID, which also covers
 * heads that aren't local — forks / pushed elsewhere.) `maybeFireSync` debounces
 * by head; the runner gates whether to actually re-review. Mount once per repo.
 * Both the poll and the dispatch are paused while AI features are hidden.
 */
export function useWatchPrHeads(repoPath: string) {
  // This poll exists only to feed automations, which pause with AI hidden — so it
  // stops entirely, and cached tips can't dispatch after the flip.
  const aiEnabled = useAiEnabled();
  const prs = useLocalPrs(repoPath);
  const openPrs = useMemo(
    () => (prs.data ?? []).filter((p) => p.status === "open"),
    [prs.data],
  );
  const headBranches = useMemo(
    () => [...new Set(openPrs.map((p) => p.head))].sort(),
    [openPrs],
  );

  const tips = useQuery({
    queryKey: ["branch-tips", repoPath, headBranches],
    queryFn: () => gitBranchTips(repoPath, headBranches),
    enabled: Boolean(repoPath) && headBranches.length > 0 && aiEnabled,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (!aiEnabled) return;
    const data = tips.data;
    if (!data) return;
    for (const pr of openPrs) {
      const head = data[pr.head];
      if (!head) continue;
      maybeFireSync({
        repoPath,
        kind: "local",
        ref: pr.id,
        currentHeadSha: head,
        base: pr.base,
        head: pr.head,
        title: pr.title,
        body: pr.body,
        commitSubjects: [],
      });
    }
  }, [tips.data, openPrs, repoPath, aiEnabled]);
}
