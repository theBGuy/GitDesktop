import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { gitBranchMergeStates } from "@/lib/git/api";
import { useLocalPrs, useUpdateLocalPr } from "@/lib/pulls/queries";
import {
  applyReconcileVerdict,
  reconcileKey,
  reconcileVerdict,
} from "@/lib/pulls/reconcile";

/**
 * Keeps open local PRs honest with git when the work happens outside the app
 * (the branch picker, the CLI): a PR whose head is fully merged into its base
 * becomes merged, and a PR whose head branch was deleted becomes closed (we
 * can't verify a merge once the branch is gone). Mount where local PRs show.
 */
export function useReconcileLocalPrs(repo: string) {
  const prs = useLocalPrs(repo);
  const { mutate } = useUpdateLocalPr(repo);
  const open = (prs.data ?? []).filter((p) => p.status === "open");

  const states = useQuery({
    // Keyed under the repo so in-app branch merges/deletes (which invalidate
    // ["repo", repo]) refetch this and reconcile immediately; otherwise it
    // refreshes on refocus/remount for changes made outside the app.
    queryKey: [
      "repo",
      repo,
      "local-pr-merge-states",
      open.map(reconcileKey),
    ] as const,
    queryFn: () =>
      gitBranchMergeStates(
        repo,
        open.map((p) => ({ base: p.base, head: p.head })),
      ),
    enabled: open.length > 0,
    // A local git read: react-query's default "online" mode would park it offline.
    networkMode: "always",
  });

  // Guard against re-marking the same PR before the list refetch lands.
  const done = useRef<Set<string>>(new Set());
  useEffect(() => {
    const data = states.data;
    if (!data) return;
    open.forEach((pr, i) => {
      const s = data[i];
      const key = reconcileKey(pr);
      if (!s || done.current.has(key)) return;
      const verdict = reconcileVerdict(s);
      if (!verdict) return;
      done.current.add(key);
      // updateLocalPr runs `mutate` on the record it re-reads under the store lock,
      // so the compare-and-set sees a rename's migration that this read predates.
      mutate({
        id: pr.id,
        mutate: (cur) =>
          applyReconcileVerdict(cur, pr, verdict, new Date().toISOString()),
      });
    });
  }, [states.data, open, mutate]);
}
