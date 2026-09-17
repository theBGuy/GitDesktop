import { useQuery } from "@tanstack/react-query";
import { isDirtyTreeRefusal } from "@/lib/error-summary";
import * as api from "../api";
import { useRepoMutation } from "./internal";

export function useFetchRemote(repo: string) {
  return useRepoMutation(repo, () => api.gitFetch(repo));
}

export function usePull(repo: string) {
  return useRepoMutation(repo, (mode: api.PullMode = "ffOnly") =>
    api.gitPull(repo, mode),
  );
}

/** Stash → run → reapply variants of pull, merge, rebase, and switch. Whole-repo
 *  invalidation like their plain counterparts: each moves HEAD and rewrites the
 *  working tree, and the stash list changes too. */
export function usePullAutostash(repo: string) {
  return useRepoMutation(repo, (mode: api.PullMode = "ffOnly") =>
    api.gitPullAutostash(repo, mode),
  );
}

export function useMergeAutostash(repo: string) {
  return useRepoMutation(repo, (branch: string) =>
    api.gitMergeAutostash(repo, branch),
  );
}

export function useRebaseAutostash(repo: string) {
  return useRepoMutation(repo, (branch: string) =>
    api.gitRebaseAutostash(repo, branch),
  );
}

export function useRebaseOntoAutostash(repo: string) {
  return useRepoMutation(repo, (args: { newBase: string; oldBase: string }) =>
    api.gitRebaseOntoAutostash(repo, args.newBase, args.oldBase),
  );
}

export function useSwitchAutostash(repo: string) {
  return useRepoMutation(
    repo,
    (args: { name: string; remote: string | null; reapply: boolean }) =>
      api.gitSwitchAutostash(repo, args.name, args.remote, args.reapply),
  );
}

/** Phase B of a guarded rebase pull, plus its stash → run → reapply twin. Same
 *  whole-repo invalidation as the plain pull: both move HEAD and rewrite the
 *  working tree. */
export function usePullRebaseDecided(repo: string) {
  return useRepoMutation(repo, (decided: api.PullDecisionShas) =>
    api.gitPullRebaseDecided(repo, decided),
  );
}

export function usePullRebaseDecidedAutostash(repo: string) {
  return useRepoMutation(repo, (decided: api.PullDecisionShas) =>
    api.gitPullRebaseDecidedAutostash(repo, decided),
  );
}

/** Outcome of an "Update from upstream" run, for an honest toast. `branch` is
 *  the upstream default branch name (no `upstream/` prefix). */
export type UpstreamUpdateOutcome =
  | { kind: "up-to-date"; branch: string }
  | { kind: "fast-forwarded"; branch: string }
  | { kind: "merged"; branch: string }
  /** The final merge refused to overwrite uncommitted changes. Returned rather
   *  than thrown so the caller can offer stash-and-reapply: `ref` is the
   *  already-resolved `upstream/<branch>`, so the retry needs no re-fetch. */
  | { kind: "dirty-blocked"; branch: string; ref: string };

/**
 * Sync the current branch with a fork's `upstream` remote: fetch upstream
 * (a bare fetch never touches it), resolve upstream's default branch, then
 * bring the current branch up to date by merging `upstream/<default>`.
 *
 * Reuses the existing merge machinery — no second pipeline. The merge
 * fast-forwards silently when possible and creates a merge commit when
 * cleanly diverged; a conflicting merge rejects and leaves the repo in the
 * usual conflict state, so the conflict banner/editor takes over exactly like
 * a branch merge. The preview short-circuits the already-current case so we
 * report "already up to date" instead of a no-op merge. Never auto-pushes —
 * the Push affordance lights up on its own afterward.
 *
 * Default (whole-repo) invalidation, matching the pull/merge flows, so
 * branches, status, and history all refresh.
 */
export function useUpdateFromUpstream(repo: string) {
  return useRepoMutation<void, UpstreamUpdateOutcome>(repo, async () => {
    await api.gitFetchRemote(repo, "upstream");
    const branch = await api.gitRemoteDefaultBranch(repo, "upstream");
    const ref = `upstream/${branch}`;
    // Strategy-free preview: only used to short-circuit the already-current
    // case; every other status runs the real merge below.
    const preview = await api.gitMergePreview(repo, ref, "none");
    if (preview.status === "up-to-date") {
      return { kind: "up-to-date", branch };
    }
    const fastForward = preview.status === "fast-forward";
    // Plain merge: ff-when-possible, merge commit otherwise. A conflict makes
    // gitMerge reject — the error propagates and the conflict UI takes over.
    // Only this final step can hit the dirty-tree refusal (fetch/resolve/preview
    // never touch the working tree), so it alone is caught and reported as an
    // outcome; every other failure still throws.
    try {
      await api.gitMerge(repo, ref, false, false, "none");
    } catch (e) {
      if (isDirtyTreeRefusal(e)) return { kind: "dirty-blocked", branch, ref };
      throw e;
    }
    return { kind: fastForward ? "fast-forwarded" : "merged", branch };
  });
}

export function useSubmodules(repo: string) {
  return useQuery({
    queryKey: ["repo", repo, "submodules"] as const,
    queryFn: () => api.gitSubmodules(repo),
    staleTime: 30_000,
  });
}

/** Init + update submodules; omit `path` for all, set `remote` to move them to
 *  the tip of the branch they track instead of the recorded commit. */
export function useUpdateSubmodule(repo: string) {
  return useRepoMutation(repo, (args: { path?: string; remote?: boolean }) =>
    api.gitSubmoduleUpdate(repo, args.path, args.remote ?? false),
  );
}

export function useAddSubmodule(repo: string) {
  return useRepoMutation(
    repo,
    (args: { url: string; path: string | null; branch: string | null }) =>
      api.gitSubmoduleAdd(repo, args.url, args.path, args.branch),
  );
}

/** Resolves to the removal's outcome — callers must read it: a `refusedDirty`
 *  result mutated nothing and is not an error. */
export function useRemoveSubmodule(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; force: boolean; deleteModuleData: boolean }) =>
      api.gitSubmoduleRemove(
        repo,
        args.path,
        args.force,
        args.deleteModuleData,
      ),
  );
}

export function useSetSubmoduleUrl(repo: string) {
  return useRepoMutation(repo, (args: { path: string; url: string }) =>
    api.gitSubmoduleSetUrl(repo, args.path, args.url),
  );
}

export function useSetSubmoduleBranch(repo: string) {
  return useRepoMutation(
    repo,
    (args: { path: string; branch: string | null }) =>
      api.gitSubmoduleSetBranch(repo, args.path, args.branch),
  );
}

export function usePush(repo: string) {
  return useRepoMutation(
    repo,
    (args: {
      setUpstream: boolean;
      force?: boolean;
      branch?: string;
      remote?: string;
      /** Destination branch name when it differs from the local one (pushing to a
       *  fork PR's head); requires `branch` and `remote`, and never tracks. */
      remoteBranch?: string;
    }) =>
      api.gitPush(
        repo,
        args.setUpstream,
        args.force ?? false,
        args.branch,
        args.remote,
        args.remoteBranch,
      ),
  );
}

export function useUndoCommit(repo: string) {
  return useRepoMutation(repo, () => api.gitUndoCommit(repo));
}
