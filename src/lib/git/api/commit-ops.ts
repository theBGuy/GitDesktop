import { invoke } from "@/lib/tauri/invoke";
import type { BranchHead, RewriteStep } from "../types";

/** The `expectedBranch` IPC form of the HEAD a surface displayed: its branch name, or
 *  `HEAD` when detached (git refuses a branch named `HEAD`, so the two never
 *  collide). A pinned rewrite refuses when HEAD now names something else, which an
 *  oid pin alone can't see when another branch sits at the same commit. */
export const headBranchPin = (head: BranchHead): string =>
  head.detached || head.name === null ? "HEAD" : head.name;

/** Moves the branch pointer to `hash`. `"mixed"` (the default) keeps every
 *  working-tree change; `"hard"` rewrites the working tree too and is refused
 *  outright while tracked changes are outstanding. `expectedHead` and
 *  `expectedBranch` ({@link headBranchPin}) apply to hard mode only: the backend
 *  refuses when HEAD is no longer that commit on that branch. */
export const gitReset = (
  repoPath: string,
  hash: string,
  mode?: "mixed" | "hard",
  expectedHead?: string,
  expectedBranch?: string,
) =>
  invoke<void>("git_reset", {
    repoPath,
    hash,
    mode: mode ?? null,
    expectedHead: expectedHead ?? null,
    expectedBranch: expectedBranch ?? null,
  });

export const gitCheckoutCommit = (repoPath: string, hash: string) =>
  invoke<void>("git_checkout_commit", { repoPath, hash });

/** `mainline` is the 1-based parent a MERGE commit is reverted against (git's
 *  `-m`); omitted for an ordinary commit. */
export const gitRevert = (repoPath: string, hash: string, mainline?: number) =>
  invoke<void>("git_revert", { repoPath, hash, mainline: mainline ?? null });

/** Resolves true when a commit was created, false when there was nothing
 *  to apply (the changes already exist on this branch). `mainline` as for
 *  {@link gitRevert}. */
export const gitCherryPick = (
  repoPath: string,
  hash: string,
  mainline?: number,
) =>
  invoke<boolean>("git_cherry_pick", {
    repoPath,
    hash,
    mainline: mainline ?? null,
  });

/** Mirrors the Rust `CommitParent` wire shape (pinned by its serialization test). */
export interface CommitParent {
  hash: string;
  subject: string;
}

/** A commit's parents in git's parent order: index 0 is mainline 1. */
export const gitCommitParents = (repoPath: string, hash: string) =>
  invoke<CommitParent[]>("git_commit_parents", { repoPath, hash });

export interface CherryPickRangeResult {
  applied: number;
  skipped: number;
}

/** Copies `hashes` (oldest-first) onto `targetBranch` and leaves you there.
 *  A single commit that conflicts stops on `targetBranch` with the pick in
 *  progress, for the conflict banner to continue or abort. Every other failure
 *  (and any failure in a multi-commit batch) rolls `targetBranch` back to its
 *  prior tip and returns you to your starting branch; the error says when
 *  either rollback step failed and how to recover. `mainline` is a LONE merge
 *  commit's `-m` parent; the backend refuses it alongside a batch. */
export const gitCherryPickOnto = (
  repoPath: string,
  hashes: string[],
  targetBranch: string,
  mainline?: number,
) =>
  invoke<CherryPickRangeResult>("git_cherry_pick_onto", {
    repoPath,
    hashes,
    targetBranch,
    mainline: mainline ?? null,
  });

export const gitRewriteCommits = (
  repoPath: string,
  base: string,
  steps: RewriteStep[],
  dropped?: string[],
) =>
  invoke<void>("git_rewrite_commits", {
    repoPath,
    base,
    steps,
    dropped: dropped ?? null,
  });

/** Like gitRewriteCommits but via a real, resumable `git rebase -i` — used when
 *  a step is marked `edit` (pause to amend its contents). Leaves the rebase in
 *  progress for the banner to continue/abort. */
export const gitRebaseEdit = (
  repoPath: string,
  base: string,
  steps: RewriteStep[],
  dropped?: string[],
) =>
  invoke<void>("git_rebase_edit", {
    repoPath,
    base,
    steps,
    dropped: dropped ?? null,
  });

/** Full messages (subject + body) for the unpushed commits `base..HEAD`, to
 *  pre-fill the Edit-history editor without truncating multi-line bodies. */
export const gitUnpushedMessages = (repoPath: string, base: string) =>
  invoke<{ hash: string; message: string }[]>("git_unpushed_messages", {
    repoPath,
    base,
  });

/** The backend refuses when the latest commit is no longer `expectedHead`, or HEAD no
 *  longer names `expectedBranch` ({@link headBranchPin}). */
export const gitUndoCommit = (
  repoPath: string,
  expectedHead: string,
  expectedBranch: string,
) =>
  invoke<void>("git_undo_commit", { repoPath, expectedHead, expectedBranch });
