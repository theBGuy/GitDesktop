import { useQuery } from "@tanstack/react-query";
import * as api from "../api";
import type { CommitDate, RewriteStep } from "../types";
import { repoKeys } from "./core";
import { useRepoMutation } from "./internal";

/** Moves the CURRENT branch to `hash` and keeps the working tree (mixed). The
 *  backend refuses unless HEAD is still `expectedHead` on `expectedBranch`, the
 *  tip and branch the dialog opened on. */
export function useResetToCommit(repo: string) {
  return useRepoMutation(
    repo,
    (args: { hash: string; expectedHead: string; expectedBranch: string }) =>
      api.gitReset(
        repo,
        args.hash,
        "mixed",
        args.expectedHead,
        args.expectedBranch,
      ),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Moves the CURRENT branch and the working tree to `hash`. The backend refuses
 *  outright while tracked changes are outstanding, so the caller's confirm can
 *  promise a clean tree is required rather than pre-flighting one. It also
 *  refuses unless HEAD is still `expectedHead` on `expectedBranch`, the tip and branch
 *  the user confirmed. */
export function useHardResetToCommit(repo: string) {
  return useRepoMutation(
    repo,
    (args: { hash: string; expectedHead: string; expectedBranch: string }) =>
      api.gitReset(
        repo,
        args.hash,
        "hard",
        args.expectedHead,
        args.expectedBranch,
      ),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useCheckoutCommit(repo: string) {
  return useRepoMutation(
    repo,
    (hash: string) => api.gitCheckoutCommit(repo, hash),
    {
      // Local history write — never park it offline.
      networkMode: "always",
      localOnly: true,
    },
  );
}

/** A revert or pick's target. `mainline` names a MERGE commit's parent (git's
 *  `-m`, 1-based) and stays unset for an ordinary commit. */
export interface CommitPickArgs {
  hash: string;
  mainline?: number;
}

export function useRevertCommit(repo: string) {
  return useRepoMutation(
    repo,
    (args: CommitPickArgs) => api.gitRevert(repo, args.hash, args.mainline),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useCherryPick(repo: string) {
  return useRepoMutation(
    repo,
    (args: CommitPickArgs) => api.gitCherryPick(repo, args.hash, args.mainline),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Shared by the merge-parent dialog's read and a host's imperative fetch, so
 *  both run under the same options: a commit's parents never change, and the
 *  read is local. */
export const commitParentsOptions = (repo: string, hash: string) => ({
  queryKey: ["repo", repo, "commit", hash, "parents"] as const,
  queryFn: () => api.gitCommitParents(repo, hash),
  staleTime: Number.POSITIVE_INFINITY,
  // A local read: react-query's default "online" mode would park it offline.
  networkMode: "always" as const,
});

/** Whether `hash`'s raw commit header records a parent: false for a true root,
 *  true at a shallow clone's boundary, whose parent the graft hides from the log.
 *  A commit's header never changes, and the read is local. */
export function useCommitRecordsParent(
  repo: string,
  hash: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: repoKeys.recordsParent(repo, hash),
    queryFn: () => api.gitCommitRecordsParent(repo, hash),
    enabled: enabled && hash !== "",
    staleTime: Number.POSITIVE_INFINITY,
    networkMode: "always",
  });
}

/** The parents of `hash`, read only while it is set. */
export function useCommitParents(repo: string, hash: string | null) {
  return useQuery({
    ...commitParentsOptions(repo, hash ?? ""),
    enabled: hash !== null,
  });
}

export function useCherryPickOnto(repo: string) {
  return useRepoMutation(
    repo,
    (args: { hashes: string[]; targetBranch: string; mainline?: number }) =>
      api.gitCherryPickOnto(
        repo,
        args.hashes,
        args.targetBranch,
        args.mainline,
      ),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useCreateTag(repo: string) {
  return useRepoMutation(
    repo,
    (args: { name: string; hash: string }) =>
      api.gitTag(repo, args.name, args.hash),
    {
      // Pinned: the call and its invalidation close over `repo`, and the
      // history/tags hosts survive a repo switch — without the key the newly-live
      // repo's controls would read the pending create as busy.
      identity: ["create-tag", repo],
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

export function useRewriteCommits(repo: string) {
  return useRepoMutation(
    repo,
    (args: { base: string; steps: RewriteStep[]; dropped?: string[] }) =>
      api.gitRewriteCommits(repo, args.base, args.steps, args.dropped),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Starts a resumable interactive rebase (for plans containing an `edit`); the
 *  rebase pauses and the conflict/op banner takes over. */
export function useRebaseEdit(repo: string) {
  return useRepoMutation(
    repo,
    (args: { base: string; steps: RewriteStep[]; dropped?: string[] }) =>
      api.gitRebaseEdit(repo, args.base, args.steps, args.dropped),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

/** Rewrites HEAD's dates only, pinned to the HEAD and branch the dialog opened
 *  on. Unpinned on purpose: its one host, the Edit dates dialog, is keyed per
 *  repo, so no observer outlives a switch; callers consume `mutateAsync`. */
export function useAmendCommitDates(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      expectedHead: string;
      expectedBranch: string;
      authorDate: CommitDate | null;
      committerDate: CommitDate | null;
    }) =>
      api.gitAmendCommitDates(
        repo,
        args.expectedHead,
        args.expectedBranch,
        args.authorDate,
        args.committerDate,
      ),
    {
      // Local history write — never park it offline.
      networkMode: "always",
    },
  );
}

/** One unpushed commit's full message and dates; a date is `null` when the
 *  backend couldn't read it for that row. */
export interface UnpushedCommitData {
  message: string;
  authorDate: CommitDate | null;
  committerDate: CommitDate | null;
}

/** Full messages and dates for the unpushed commits `base..HEAD`, keyed by
 *  hash, for the Edit-history editor's reword/squash defaults and date fields.
 *  Enabled only when the dialog is open with a base. */
export function useUnpushedMessages(
  repo: string,
  base: string,
  enabled: boolean,
) {
  return useQuery({
    queryKey: [...repoKeys.unpushedMessages(repo), base] as const,
    queryFn: async (): Promise<Record<string, UnpushedCommitData>> => {
      const list = await api.gitUnpushedMessages(repo, base);
      return Object.fromEntries(
        list.map((c) => [
          c.hash,
          {
            message: c.message,
            authorDate: c.authorDate,
            committerDate: c.committerDate,
          },
        ]),
      );
    },
    enabled: enabled && base !== "",
    staleTime: 0,
    // A local read: react-query's default "online" mode would park it offline.
    networkMode: "always",
  });
}
