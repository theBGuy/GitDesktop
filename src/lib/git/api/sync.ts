import { invoke } from "@/lib/tauri/invoke";

export const gitFetch = (repoPath: string) =>
  invoke<void>("git_fetch", { repoPath });

/** Fetch a single named remote (`git fetch --prune --no-prune-tags <remote>`),
 *  unlike {@link gitFetch}, which only touches the default remote. Used to
 *  sync a fork's `upstream`, which a bare fetch never reaches. */
export const gitFetchRemote = (repoPath: string, remote: string) =>
  invoke<void>("git_fetch_remote", { repoPath, remote });

/** The default branch name (e.g. `"main"`) of a named remote — the branch a
 *  fork's upstream sync targets. Resolves the local remote HEAD, doing one
 *  network call to set it if unknown. */
export const gitRemoteDefaultBranch = (repoPath: string, remote: string) =>
  invoke<string>("git_remote_default_branch", { repoPath, remote });

/** Pull mode: fast-forward only (default), or reconcile a diverged branch. */
export type PullMode = "ffOnly" | "rebase" | "merge";

export const gitPull = (repoPath: string, mode: PullMode = "ffOnly") =>
  invoke<void>("git_pull", { repoPath, mode });

/**
 * What a stash → run → reapply compound did. Each command below stashes
 * (including untracked files), runs its operation, then pops — reporting which
 * of those steps landed rather than collapsing to a bare success/failure, so
 * the UI can say where the user's changes ended up.
 *
 * `stderr` on the failure variants is the underlying git output; the stash is
 * retained in every variant that names it, and is the user's safety net.
 */
export type AutostashOutcome =
  /** Tree was clean at stash time; the operation ran plainly. */
  | { kind: "nothingStashed" }
  /** Switch with `reapply: false` — stash kept deliberately, no pop attempted. */
  | { kind: "stashedOnly" }
  /** stash → run → pop, all clean. */
  | { kind: "reapplied" }
  /** The operation succeeded but the pop failed; the stash is kept.
   *  `conflicted` = the pop left unmerged paths to resolve, rather than
   *  refusing outright. */
  | { kind: "reapplyConflicted"; stderr: string; conflicted: boolean }
  /** The operation failed cleanly and the changes were restored. */
  | { kind: "opFailedRestored"; stderr: string }
  /** The operation failed and the stash is kept. `inProgress` = it left
   *  in-progress state, so ConflictBanner offers Continue/Abort; false = the
   *  restore-pop failed instead, and there is no banner. */
  | { kind: "opFailedStashKept"; stderr: string; inProgress: boolean };

export const gitPullAutostash = (repoPath: string, mode: PullMode = "ffOnly") =>
  invoke<AutostashOutcome>("git_pull_autostash", { repoPath, mode });

export const gitMergeAutostash = (repoPath: string, branch: string) =>
  invoke<AutostashOutcome>("git_merge_autostash", { repoPath, branch });

export const gitRebaseAutostash = (repoPath: string, branch: string) =>
  invoke<AutostashOutcome>("git_rebase_autostash", { repoPath, branch });

export const gitRebaseOntoAutostash = (
  repoPath: string,
  newBase: string,
  oldBase: string,
) =>
  invoke<AutostashOutcome>("git_rebase_onto_autostash", {
    repoPath,
    newBase,
    oldBase,
  });

export const gitSwitchAutostash = (
  repoPath: string,
  name: string,
  remote: string | null,
  reapply: boolean,
) =>
  invoke<AutostashOutcome>("git_switch_autostash", {
    repoPath,
    name,
    remote,
    reapply,
  });

/** One commit a rebase pull would rewrite away (mirrors the Rust
 *  `DroppedCommit` in git/pull_guard.rs). */
export interface DroppedCommit {
  sha: string;
  subject: string;
  author: string;
  authorDate: string;
}

/** The structured refusal a rebase pull throws when the upstream was rewritten
 *  and replaying would rewrite local commits away. Wire shape pinned by the Rust
 *  test `pull_rebase_would_drop_serializes_to_the_pinned_wire_shape` (error.rs);
 *  narrow a thrown value to it with `isPullWouldDrop` (lib/error-summary.ts).
 *
 *  Deliberately outside the `AppError` union: its `kind` carries a payload no
 *  generic error presenter reads, and every consumer reaches it through the
 *  classifier instead. */
export interface PullWouldDrop {
  kind: "pullRebaseWouldDrop";
  message: string;
  /** Short local branch name (`main`). */
  branch: string;
  /** Short upstream name (`origin/main`). */
  upstream: string;
  /** The local branch's tip when the guard ran — the decision's `expectedTip`. */
  branchTip: string;
  /** The upstream tip a rebase would land on. */
  newTip: string;
  /** Base BELOW the doomed commits, so a rebase from it replays them — `keep`. */
  mergeBase: string;
  /** Base ABOVE them, so a rebase from it leaves them behind — `drop`. */
  forkPoint: string;
  commits: DroppedCommit[];
}

/** The user's answer to the pull guard. Mirrors the two words Rust's
 *  `decided_base` accepts; anything else is refused there. */
export type PullDecision = "keep" | "drop";

/** What a decided pull rebases against. Every SHA is copied verbatim off the
 *  `PullWouldDrop` that raised the question — the app auto-fetches in the
 *  background, so re-deriving any of them would answer about a different state
 *  than the user was shown. */
export interface PullDecisionShas {
  /** The branch the guard asked about, so the answer can only ever land on it. */
  branch: string;
  decision: PullDecision;
  newTip: string;
  keepBase: string;
  dropBase: string;
  expectedTip: string;
}

/** Phase B of a guarded rebase pull. Rejects with a `PULL_DECISION_STALE`
 *  message when the branch moved since the guard ran. */
export const gitPullRebaseDecided = (
  repoPath: string,
  decided: PullDecisionShas,
) =>
  invoke<void>("git_pull_rebase_decided", {
    repoPath,
    branch: decided.branch,
    decision: decided.decision,
    newTip: decided.newTip,
    keepBase: decided.keepBase,
    dropBase: decided.dropBase,
    expectedTip: decided.expectedTip,
  });

export const gitPullRebaseDecidedAutostash = (
  repoPath: string,
  decided: PullDecisionShas,
) =>
  invoke<AutostashOutcome>("git_pull_rebase_decided_autostash", {
    repoPath,
    branch: decided.branch,
    decision: decided.decision,
    newTip: decided.newTip,
    keepBase: decided.keepBase,
    dropBase: decided.dropBase,
    expectedTip: decided.expectedTip,
  });

/** Which guarantee a completed push actually ran under (mirrors the Rust
 *  `PushGuard` in git/remote.rs). Only meaningful when `force` is set: a
 *  non-force push has no lease to degrade and reports the neutral
 *  `"leaseAndIncludes"`. The two `leaseOnly*` values mean the push landed with
 *  `--force-with-lease` alone, so a caller announcing it must not claim the
 *  stronger `--force-if-includes` protection. */
export type PushGuard =
  | "leaseAndIncludes"
  | "leaseOnlyOldGit"
  | "leaseOnlyNoReflog";

/** `remoteBranch` names the DESTINATION branch when it differs from the local
 *  one (pushing back to a fork PR's head); it requires both `branch` and
 *  `remote`, and never sets upstream. */
export const gitPush = (
  repoPath: string,
  setUpstream: boolean,
  force = false,
  branch?: string,
  remote?: string,
  remoteBranch?: string,
) =>
  invoke<PushGuard>("git_push", {
    repoPath,
    setUpstream,
    force,
    branch: branch ?? null,
    remote: remote ?? null,
    remoteBranch: remoteBranch ?? null,
  });
