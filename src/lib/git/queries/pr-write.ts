import {
  type QueryKey,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { toastError } from "@/lib/toast";
import * as api from "../api";
import type { RemoteLens } from "../types";
import { useRepoMutation } from "./internal";

export function useEditPr(repo: string, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: {
      number: number;
      title: string;
      body: string;
      /** Retarget the PR onto this base branch. Omit to leave the base alone —
       *  a no-op retarget is still a forge write, and GitHub rejects one on a
       *  stacked PR. */
      base?: string;
    }) =>
      api.forgePrEdit(
        repo,
        args.number,
        args.title,
        args.body,
        lens,
        args.base,
      ),
  );
}

/** Stack a chain of open PRs (bottom→top) into a new stack. Takes the default
 *  whole-repo invalidation: stacking rewrites every member's base and position,
 *  so the PR detail, the list, and each member's own row all go stale at once —
 *  the same reasoning as the PR-lifecycle mutations beside it. */
export function useStackCreate(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (pullRequests: number[]) =>
    api.forgeStackCreate(repo, pullRequests, lens),
  );
}

/** Append a chain of open PRs (bottom→top) to an existing stack. */
export function useStackAdd(repo: string, lens: RemoteLens) {
  return useRepoMutation(
    repo,
    (args: { stackNumber: number; pullRequests: number[] }) =>
      api.forgeStackAdd(repo, args.stackNumber, args.pullRequests, lens),
  );
}

/** Dissolve a stack — its members stay open on their branches, unstacked. */
export function useStackDissolve(repo: string, lens: RemoteLens) {
  return useRepoMutation(repo, (stackNumber: number) =>
    api.forgeStackDissolve(repo, stackNumber, lens),
  );
}

/** Add/remove labels on an issue, MR, or GitHub Discussion. GitHub uses the node-id path
 *  (`labelableId` + `addIds`/`removeIds`); GitLab uses names (`target` + `number` +
 *  `addNames`/`removeNames`). `kind` is the reconcile discriminator and picks the wire
 *  `target` (issue→"issue", mr→"mr", discussion→"issue" with number 0, which the node-id
 *  path ignores). Reconciles per-kind on settle instead of whole-repo. */
export function useEditPrLabels(repo: string, lens: RemoteLens) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      kind: "issue" | "mr" | "discussion";
      number: number;
      labelableId: string;
      addIds: string[];
      removeIds: string[];
      addNames?: string[];
      removeNames?: string[];
    }) =>
      api.forgeEditLabels(
        repo,
        args.kind === "mr" ? "mr" : "issue",
        // GitHub Discussions use the node-id path; the wire number is unused and
        // stays 0 to match the old `args.number ?? 0` default byte-for-byte.
        args.kind === "discussion" ? 0 : args.number,
        args.labelableId,
        args.addIds,
        args.removeIds,
        args.addNames ?? [],
        args.removeNames ?? [],
      ),
    // Mutation-level: see useTimeTrackingMutation. The label pickers are keyed per
    // entity, so a switch mid-flight used to drop the failure silently.
    onError: (e) => toastError(e),
    onSettled: (_d, _e, args) => {
      // Issue/MR narrow keys carry the lens they were read under; discussions are
      // not lens-scoped (GitHub Discussions have no fork lens) — keyed as before.
      const keysByKind: Record<typeof args.kind, (n: number) => QueryKey[]> = {
        issue: (n) => [
          ["repo", repo, "issue-list", lens],
          ["repo", repo, "issue", lens, n],
        ],
        mr: (n) => [
          ["repo", repo, "pr", lens, n],
          ["repo", repo, "pr-list", lens],
          // A label edit moves the PR's `updatedAt`, so the grouping map has to
          // refresh with the rows (see usePrReviewState). Issues and discussions
          // have no such sibling.
          ["repo", repo, "pr-review-state", lens],
        ],
        discussion: (n) => [
          ["repo", repo, "discussion", n],
          ["repo", repo, "discussion-list"],
        ],
      };
      return void Promise.all(
        keysByKind[args.kind](args.number).map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  });
}

export function useCreatePr(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      base: string;
      head: string;
      title: string;
      body: string;
      draft: boolean;
      /** Create-time reviewer account uuids (Bitbucket-only; omit elsewhere). */
      reviewers?: string[];
      /** Create-time label names (GitHub/GitLab; omit for Bitbucket). */
      labels?: string[];
      /** Create-time assignee login/username strings (GitHub/GitLab; omit for Bitbucket). */
      assignees?: string[];
      /** Which repo the PR opens against: the fork itself ("origin", default) or
       *  its parent ("upstream" — GitHub fork only; the backend composes
       *  `owner:head` and rejects reviewers/labels/assignees on that path). */
      lens?: RemoteLens;
    }) =>
      api.forgePrCreate(
        repo,
        args.base,
        args.head,
        args.title,
        args.body,
        args.draft,
        args.reviewers,
        args.labels,
        args.assignees,
        args.lens ?? "origin",
      ),
  );
}
