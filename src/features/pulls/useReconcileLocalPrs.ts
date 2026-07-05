import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { gitBranchMergeStates } from "@/lib/git/api";
import { useLocalPrs, useUpdateLocalPr } from "@/lib/pulls/queries";

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
      open.map((p) => `${p.id}:${p.base}:${p.head}`),
    ] as const,
    queryFn: () =>
      gitBranchMergeStates(
        repo,
        open.map((p) => ({ base: p.base, head: p.head })),
      ),
    enabled: open.length > 0,
  });

  // Guard against re-marking the same PR before the list refetch lands.
  const done = useRef<Set<string>>(new Set());
  useEffect(() => {
    const data = states.data;
    if (!data) return;
    open.forEach((pr, i) => {
      const s = data[i];
      if (!s || done.current.has(pr.id)) return;
      if (s.merged) {
        done.current.add(pr.id);
        mutate({
          id: pr.id,
          mutate: (cur) => ({
            ...cur,
            status: "merged",
            mergedAt: cur.mergedAt ?? new Date().toISOString(),
          }),
        });
      } else if (!s.headExists) {
        done.current.add(pr.id);
        mutate({
          id: pr.id,
          mutate: (cur) => ({ ...cur, status: "closed" }),
        });
      }
    });
  }, [states.data, open, mutate]);
}
