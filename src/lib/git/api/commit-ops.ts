import { invoke } from "@/lib/tauri/invoke";
import type { RewriteStep } from "../types";

/** Moves the branch pointer to `hash`. `"mixed"` (the default) keeps every
 *  working-tree change; `"hard"` rewrites the working tree too and is refused
 *  outright while tracked changes are outstanding. */
export const gitReset = (
  repoPath: string,
  hash: string,
  mode?: "mixed" | "hard",
) => invoke<void>("git_reset", { repoPath, hash, mode: mode ?? null });

export const gitCheckoutCommit = (repoPath: string, hash: string) =>
  invoke<void>("git_checkout_commit", { repoPath, hash });

export const gitRevert = (repoPath: string, hash: string) =>
  invoke<void>("git_revert", { repoPath, hash });

/** Resolves true when a commit was created, false when there was nothing
 *  to apply (the changes already exist on this branch). */
export const gitCherryPick = (repoPath: string, hash: string) =>
  invoke<boolean>("git_cherry_pick", { repoPath, hash });

export interface CherryPickRangeResult {
  applied: number;
  skipped: number;
}

/** Copies `hashes` (oldest-first) onto `targetBranch` and leaves you there.
 *  A single commit that conflicts stops on `targetBranch` with the pick in
 *  progress, for the conflict banner to continue or abort. Every other failure
 *  (and any failure in a multi-commit batch) rolls `targetBranch` back to its
 *  prior tip and returns you to your starting branch; the error says when
 *  either rollback step failed and how to recover. */
export const gitCherryPickOnto = (
  repoPath: string,
  hashes: string[],
  targetBranch: string,
) =>
  invoke<CherryPickRangeResult>("git_cherry_pick_onto", {
    repoPath,
    hashes,
    targetBranch,
  });

export const gitRewriteCommits = (
  repoPath: string,
  base: string,
  steps: RewriteStep[],
) => invoke<void>("git_rewrite_commits", { repoPath, base, steps });

/** Like gitRewriteCommits but via a real, resumable `git rebase -i` — used when
 *  a step is marked `edit` (pause to amend its contents). Leaves the rebase in
 *  progress for the banner to continue/abort. */
export const gitRebaseEdit = (
  repoPath: string,
  base: string,
  steps: RewriteStep[],
) => invoke<void>("git_rebase_edit", { repoPath, base, steps });

/** Full messages (subject + body) for the unpushed commits `base..HEAD`, to
 *  pre-fill the Edit-history editor without truncating multi-line bodies. */
export const gitUnpushedMessages = (repoPath: string, base: string) =>
  invoke<{ hash: string; message: string }[]>("git_unpushed_messages", {
    repoPath,
    base,
  });

export const gitUndoCommit = (repoPath: string) =>
  invoke<void>("git_undo_commit", { repoPath });
