//! Two-phase guard for a rebase-mode pull.
//!
//! `git pull --rebase` resolves `merge-base --fork-point <upstream> <branch>`
//! itself and hands the answer to `rebase --onto <new tip> <fork point>`, so a
//! commit the user PUSHED that a teammate then force-pushed away is replayed out
//! of existence with no conflict and no warning — the push wrote that commit into
//! the tracking ref's reflog, which is what fork-point reads. Pull bakes the
//! verdict into that argv: it has no `--no-fork-point` and never consults
//! `rebase.forkPoint` (measured, git 2.51.1), so deciding at all means running the
//! phases ourselves — probe here, then rebase onto pinned SHAs on the user's answer.

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::autostash::{autostash_push, settle, AutostashOutcome};
use crate::git::history::validate_hash;
use crate::git::remote::run_git_with_creds_once;
use crate::git::runner::{
    acquire_repo_lock, run_git, run_git_raw, DEFAULT_TIMEOUT, LOCK_WAIT_TIMEOUT,
    NETWORK_LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT,
};
use crate::state::AppState;

/// One commit the fork-point verdict would rewrite away, as the decision UI names
/// it. The whole wire shape — this struct included — is pinned by
/// `pull_rebase_would_drop_serializes_to_the_pinned_wire_shape` (error.rs).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedCommit {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub author_date: String,
}

/// Everything the keep-or-drop decision rests on, carried by
/// [`AppError::PullRebaseWouldDrop`]. The frontend hands `new_tip`, `merge_base`,
/// `fork_point` and `branch_tip` straight back to `git_pull_rebase_decided`, which
/// is why the guard reports SHAs rather than the refs it read them from.
#[derive(Debug)]
pub struct WouldDrop {
    pub message: String,
    pub branch: String,
    pub upstream: String,
    pub branch_tip: String,
    pub new_tip: String,
    pub merge_base: String,
    pub fork_point: String,
    pub commits: Vec<DroppedCommit>,
}

/// Marker the frontend keys its stale-decision toast off: the branch moved between
/// the probe and the answer, so every SHA the decision pins describes a state that
/// no longer exists.
pub(crate) const PULL_DECISION_STALE: &str = "PULL_DECISION_STALE";

/// The branch/upstream pair a guarded pull runs against — everything resolvable
/// without touching the network.
pub(crate) struct PullTarget {
    /// Short branch name (`main`).
    branch: String,
    /// Full tracking ref (`refs/remotes/origin/main`), or a local `refs/heads/…`
    /// when the upstream is another local branch.
    upstream_ref: String,
    /// Short upstream name (`origin/main`) — what the user is shown.
    upstream: String,
    /// The upstream's remote, or `"."` for a local-branch upstream (nothing to fetch).
    remote: String,
}

/// The fork-point verdict for one pull, with every SHA it rests on pinned. The
/// fork point IS the rebase base: a pull with no fork point can't vaporize
/// anything, so the guard stands down there rather than substituting a base of
/// its own (which would hand a criss-cross history a different one than pull).
pub(crate) struct PullPlan {
    branch: String,
    upstream: String,
    branch_tip: String,
    new_tip: String,
    merge_base: String,
    fork_point: String,
    dropped: Vec<DroppedCommit>,
}

impl PullPlan {
    /// The commits a bare `git pull --rebase` would rewrite away right now. Empty
    /// on virtually every pull, which is the case that must stay promptless.
    pub(crate) fn dropped(&self) -> &[DroppedCommit] {
        &self.dropped
    }

    /// The structured refusal naming those commits. Only meaningful with a
    /// non-empty drop set, which is also the only state where the fork point
    /// differs from the merge base.
    pub(crate) fn into_error(self) -> AppError {
        AppError::PullRebaseWouldDrop(Box::new(WouldDrop {
            message: would_drop_message(self.dropped.len(), &self.upstream),
            branch: self.branch,
            upstream: self.upstream,
            branch_tip: self.branch_tip,
            new_tip: self.new_tip,
            merge_base: self.merge_base,
            fork_point: self.fork_point,
            commits: self.dropped,
        }))
    }
}

/// Human summary carried by [`AppError::PullRebaseWouldDrop`]'s `message`, and so
/// by every non-presenting reader (MCP, the oplog's error text).
fn would_drop_message(count: usize, upstream: &str) -> String {
    let noun = if count == 1 { "commit" } else { "commits" };
    format!("Pulling with rebase would drop {count} {noun} that {upstream} no longer contains.")
}

/// `git rebase` argv for replaying `base..HEAD` onto `new_tip`. SHAs only, never
/// ref names: the app auto-fetches in the background, so a ref can move between
/// the probe and the rebase. `core.editor=true` mirrors the other inlined rebases
/// so git can never block on an editor.
///
/// `autostash` is the flag to carry, or `None` to pass none at all — see
/// [`plain_autostash_flag`]. The stash-for-themselves compounds always pass
/// `--no-autostash`, as pull's own rebase invocation does.
fn rebase_argv<'a>(autostash: Option<&'a str>, new_tip: &'a str, base: &'a str) -> Vec<&'a str> {
    let mut argv = vec!["-c", "core.editor=true", "rebase"];
    argv.extend(autostash);
    argv.extend(["--onto", new_tip, base]);
    argv
}

/// The autostash flag a PLAIN (non-compound) rebase pull carries, mirroring what
/// bare `git pull --rebase` would have done — all four arms measured on git
/// 2.51.1:
///
/// - `pull.autoStash=true` ⇒ `--autostash`; a bare rebase would IGNORE that key.
/// - `pull.autoStash=false` ⇒ `--no-autostash`, refusing as pull would.
/// - unset ⇒ NO flag, which is what lets `rebase.autoStash` govern (pull's own
///   fallback; ignoring it there was a bug git fixed in 2.36).
///
/// An unreadable or non-boolean value reads as unset: the flagless form leaves
/// git's own resolution in charge rather than forcing a verdict.
async fn plain_autostash_flag(repo: &str) -> Option<&'static str> {
    let out = run_git_raw(
        Some(repo),
        &["config", "--bool", "pull.autoStash"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    if out.code != 0 {
        return None;
    }
    match out.stdout_lossy().trim() {
        "true" => Some("--autostash"),
        "false" => Some("--no-autostash"),
        _ => None,
    }
}

/// The compounds' flag: they stash and reapply themselves, so git must not.
const COMPOUND_AUTOSTASH: Option<&str> = Some("--no-autostash");

/// Whether the user's `submodule.recurse` is on. Read through git's own `--bool`
/// resolution, so system/global/local precedence and every spelling of true stay
/// git's verdict rather than ours; absent, unreadable or non-boolean reads as false,
/// which is the key's documented default ("Defaults to false", git-config).
async fn submodule_recurse(repo: &str) -> bool {
    let Ok(out) = run_git_raw(
        Some(repo),
        &["config", "--bool", "submodule.recurse"],
        DEFAULT_TIMEOUT,
    )
    .await
    else {
        return false;
    };
    out.code == 0 && out.stdout_lossy().trim() == "true"
}

/// The submodule worktree update a rebase-mode `git pull` runs after its rebase —
/// the one thing the guard's plain `git rebase` cannot do for itself:
/// `submodule.recurse`'s supported-command list (git-config) omits `rebase`, and
/// the step pull runs for it is `git submodule update --recursive --rebase`
/// (measured via GIT_TRACE, git 2.51.1.windows.1).
///
/// The fetch half needs nothing: the guard's plain `git fetch` inherits
/// `submodule.recurse` like pull's own, and forcing `--recurse-submodules` would
/// recurse where `fetch.recurseSubmodules=no` makes plain pull not (measured).
///
/// The gate is "did the rebase land", not "is the tree clean" — both directions
/// measured on that git: a conflicted rebase gets no submodule step, while a landed
/// rebase gets one even when the autostash reapply conflicted (pull exits 0 and
/// still runs it). [`fold_submodule_failure`] keeps that from costing the reapply
/// report. `submodule update` clones and fetches what a moved pointer needs,
/// so it runs on `NETWORK_TIMEOUT`.
async fn update_submodules_after_rebase(repo: &str) -> AppResult<()> {
    if !submodule_recurse(repo).await {
        return Ok(());
    }
    let out = run_git_raw(
        Some(repo),
        &["submodule", "update", "--recursive", "--rebase"],
        NETWORK_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    Ok(())
}

/// Fold a failed submodule step into the compound's own report, so the step can run
/// on a conflicted REAPPLY (which is parity — see
/// [`update_submodules_after_rebase`]) without that outcome being thrown away.
///
/// `ReapplyConflicted` is the one outcome the user MUST still see: it names a
/// retained stash and unmerged paths, which no `AppError` from a submodule checkout
/// would tell them about, so the step's failure is appended to its detail instead of
/// replacing it. Every other landed outcome carries nothing the error does not, so
/// there the failure IS the result and is never swallowed.
///
/// That arm is defensive rather than common: with the index left unmerged by the
/// conflicted pop, `git submodule update` skips the submodules it would have to CLONE
/// and exits 0 (measured, git 2.51.1.windows.1), so it often has nothing to fail at.
/// It can still act — and so still fail — on an already-cloned submodule whose new
/// sha needs a fetch, which is the path pull was measured taking with unmerged paths
/// present.
fn fold_submodule_failure(
    result: AppResult<AutostashOutcome>,
    submodule: AppResult<()>,
) -> AppResult<AutostashOutcome> {
    let Err(failure) = submodule else {
        return result;
    };
    // Every arm is spelled out, with no `Ok(_)` catch-all: a new outcome variant must
    // then come here for a decision rather than defaulting into the discarding arm.
    match result {
        Ok(AutostashOutcome::ReapplyConflicted {
            stderr,
            conflicted,
        }) => Ok(AutostashOutcome::ReapplyConflicted {
            stderr: format!("{stderr}\n{failure}"),
            conflicted,
        }),
        // The landed outcomes that carry nothing the error does not, so the failure IS
        // the result. `StashedOnly` is landed too and belongs here even though neither
        // caller can produce it (both settle with `reapply: true`) — listing it keeps
        // the arm about what the outcome MEANS, not about which callers exist.
        Ok(
            AutostashOutcome::Reapplied
            | AutostashOutcome::NothingStashed
            | AutostashOutcome::StashedOnly,
        ) => Err(failure),
        // Not landed: both carry the stderr naming a retained stash or a paused
        // rebase, which no submodule error would tell the user about. Unreachable
        // while both callers gate the step on the rebase having landed — matched
        // explicitly so that guarantee is the compiler's, not the caller's.
        stopped @ (Ok(AutostashOutcome::OpFailedRestored { .. })
        | Ok(AutostashOutcome::OpFailedStashKept { .. })
        | Err(_)) => stopped,
    }
}

/// The current branch's short name, or `None` on a detached HEAD.
async fn current_branch(repo: &str) -> Option<String> {
    let out = run_git_raw(
        Some(repo),
        &["symbolic-ref", "--short", "-q", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    (out.code == 0)
        .then(|| out.stdout_lossy().trim().to_string())
        .filter(|b| !b.is_empty())
}

/// The current branch's upstream, spelled the way git itself resolves it.
const UPSTREAM_REV: &str = "HEAD@{upstream}";

/// `(full upstream ref, short upstream, remote)` for the current branch, or
/// `None` when it tracks nothing.
///
/// Resolved through `HEAD@{upstream}` rather than a `refs/heads/<branch>`
/// pattern: no ref is built from a name, and `for-each-ref`'s prefix matching
/// (`refs/heads/feat` also matches `refs/heads/feat/sub`) can't apply. The remote
/// comes from `branch.<b>.remote`, which is what DEFINES it — a remote name may
/// contain a slash (`git remote add a/b` is accepted, measured), so the tracking
/// ref's path cannot be split for it.
async fn upstream_of(repo: &str, branch: &str) -> AppResult<Option<(String, String, String)>> {
    let out = run_git_raw(
        Some(repo),
        &[
            "rev-parse",
            "--symbolic-full-name",
            UPSTREAM_REV,
            "--abbrev-ref",
            UPSTREAM_REV,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(None);
    }
    let stdout = out.stdout_lossy();
    let mut lines = stdout.lines();
    let (Some(upstream_ref), Some(upstream)) = (lines.next(), lines.next()) else {
        return Ok(None);
    };
    let remote = run_git_raw(
        Some(repo),
        &["config", &format!("branch.{branch}.remote")],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(upstream_parts(
        upstream_ref,
        upstream,
        remote.stdout_lossy().trim(),
    ))
}

/// Accept a resolved upstream only when every part can be used as-is: the remote
/// reaches `git fetch <remote>` argv, so a flag-shaped or empty one is refused
/// rather than passed along, and an upstream that didn't resolve to a ref is not
/// one the guard can rev-parse.
fn upstream_parts(
    upstream_ref: &str,
    upstream: &str,
    remote: &str,
) -> Option<(String, String, String)> {
    if !upstream_ref.starts_with("refs/")
        || upstream.is_empty()
        || remote.is_empty()
        || remote.starts_with('-')
    {
        return None;
    }
    Some((
        upstream_ref.to_string(),
        upstream.to_string(),
        remote.to_string(),
    ))
}

/// Whether the tree is mid-operation, reading unmerged as "yes" when the probe
/// itself fails — the guard stands down on doubt.
async fn mid_op(repo: &str) -> bool {
    crate::git::ops::has_unmerged(repo).await.unwrap_or(true)
        || crate::git::ops::op_in_progress(repo).await
}

/// The guarded pull's target, or `None` when the guard stands down and bare
/// `git pull --rebase` runs unchanged.
///
/// A tree mid-op stands down deliberately: pull refuses it outright ("Pulling is
/// not possible because you have unmerged files"), while `rebase --onto` answers
/// "cannot rebase: You have unstaged changes" — a message the frontend's
/// dirty-tree classifier would offer to stash-recover, which corrupts a resolve in
/// progress (measured, git 2.51.1). Detached HEAD and an untracked branch stand
/// down because there is no fork-point question to ask.
pub(crate) async fn resolve(repo: &str) -> AppResult<Option<PullTarget>> {
    if mid_op(repo).await {
        return Ok(None);
    }
    let Some(branch) = current_branch(repo).await else {
        return Ok(None);
    };
    let Some((upstream_ref, upstream, remote)) = upstream_of(repo, &branch).await? else {
        return Ok(None);
    };
    Ok(Some(PullTarget {
        branch,
        upstream_ref,
        upstream,
        remote,
    }))
}

/// One-shot credential `-c` entries for the target's remote. A local-branch
/// upstream (`.`) has no URL to authenticate against and skips the resolution.
pub(crate) async fn credentials(repo: &str, target: &PullTarget) -> AppResult<Vec<String>> {
    if target.remote == "." {
        return Ok(Vec::new());
    }
    crate::forge::credential_config_for_remote(repo, &target.remote).await
}

/// `rev-parse --verify <rev>^{commit}`, or `None` when it doesn't resolve.
async fn rev_parse(repo: &str, rev: &str) -> Option<String> {
    let out = run_git_raw(
        Some(repo),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    (out.code == 0)
        .then(|| out.stdout_lossy().trim().to_string())
        .filter(|sha| !sha.is_empty())
}

/// `git merge-base` for the given args, or `None` on any non-zero exit — which is
/// how git reports both "no merge base" (unrelated histories) and "no fork point".
async fn run_merge_base(repo: &str, args: &[&str]) -> Option<String> {
    let mut argv = vec!["merge-base"];
    argv.extend_from_slice(args);
    let out = run_git_raw(Some(repo), &argv, DEFAULT_TIMEOUT).await.ok()?;
    (out.code == 0)
        .then(|| out.stdout_lossy().trim().to_string())
        .filter(|sha| !sha.is_empty())
}

/// The commits in `merge_base..fork_point` — reachable from the fork point the
/// upstream's reflog still remembers, but no longer from the upstream itself.
///
/// Reconciled against `rev-list --count` over the same range, because every way
/// this can go wrong is silent: a record the parser skips shrinks the drop set,
/// and a set that shrinks to empty stands the guard down into the vaporize it
/// exists to prevent.
async fn dropped_commits(
    repo: &str,
    merge_base: &str,
    fork_point: &str,
) -> AppResult<Vec<DroppedCommit>> {
    let out = run_git(
        Some(repo),
        &[
            "log",
            "--format=%H%x00%s%x00%an%x00%aI",
            &format!("{merge_base}..{fork_point}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    reconcile_dropped(
        parse_dropped(&out.stdout_lossy()),
        rev_list_count(repo, merge_base, fork_point).await,
    )
}

/// Refuse unless the parsed commits account for every commit in the range. Fails
/// CLOSED — an under-reported set is worse than a refusal, because the user would
/// approve a drop that takes more than it named.
fn reconcile_dropped(
    parsed: Vec<DroppedCommit>,
    counted: Option<usize>,
) -> AppResult<Vec<DroppedCommit>> {
    if counted != Some(parsed.len()) {
        return Err(AppError::Command(
            "could not enumerate the commits at risk — pull again".to_string(),
        ));
    }
    Ok(parsed)
}

/// One commit per line, four NUL-separated fields. A short record is skipped
/// rather than half-filled: these commits are named to the user, and a blank
/// author or date would read as fact. [`reconcile_dropped`] is what keeps a skip
/// from passing as a smaller drop set.
fn parse_dropped(stdout: &str) -> Vec<DroppedCommit> {
    stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.split('\0');
            Some(DroppedCommit {
                sha: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                author_date: parts.next()?.to_string(),
            })
        })
        .collect()
}

/// Phase A: fetch, then compute the fork-point verdict. Touches nothing the user
/// owns — no stash, no ref of theirs — so a would-drop refusal leaves the tree
/// exactly as it found it. `None` re-stands-down (the branch changed under the
/// lock, or the upstream ref doesn't resolve post-fetch).
///
/// The fetch PRUNES, which the stand-down below depends on: without it, an
/// upstream branch deleted on the forge leaves its tracking ref behind, every
/// rev here resolves against that stale tip, and the rebase reports success for a
/// pull that bare git refuses outright ("no such ref was fetched"). Pruned, the
/// upstream ref stops resolving and that refusal is what the user sees.
///
/// The caller must already hold the repo's working-tree lock, so every step here
/// uses the lock-free runners — `run_git_mutating*` would re-acquire it and
/// deadlock. The fetch below takes the NETWORK lock for its own duration (that
/// nesting direction only), which is what keeps it from racing the background
/// auto-fetch at the ref level.
pub(crate) async fn probe(
    state: &AppState,
    repo: &str,
    target: &PullTarget,
    cred: &[String],
) -> AppResult<Option<PullPlan>> {
    // Taking the lock is what makes `target` current; a switch between `resolve`
    // and here would rebase `base..HEAD` for the wrong branch.
    if current_branch(repo).await.as_deref() != Some(target.branch.as_str()) {
        return Ok(None);
    }
    if target.remote != "." {
        let network = state.network_lock(repo).await;
        let _net_guard =
            acquire_repo_lock(&network, NETWORK_LOCK_WAIT_TIMEOUT, "a fetch").await?;
        let out = run_git_with_creds_once(
            repo,
            cred,
            &["fetch", "--prune", &target.remote],
            NETWORK_TIMEOUT,
        )
        .await?;
        if out.code != 0 {
            return Err(AppError::Git {
                code: out.code,
                stderr: out.full_failure_text(),
            });
        }
    }

    // The local side of every rev below is HEAD, not the branch NAME: rev-parse
    // resolves `refs/tags/<n>` ahead of `refs/heads/<n>`, so a tag sharing the
    // branch's name would silently answer for it. The check above is what makes
    // HEAD exactly this branch.
    let (Some(branch_tip), Some(new_tip)) = (
        rev_parse(repo, "HEAD").await,
        rev_parse(repo, &target.upstream_ref).await,
    ) else {
        return Ok(None);
    };
    let Some(merge_base) = run_merge_base(repo, &["HEAD", &target.upstream_ref]).await else {
        return Ok(None);
    };
    // No fork point, no hazard: the vaporize needs a fork-point verdict to happen
    // at all. Standing down leaves bare pull to pick its own base rather than
    // handing a criss-cross history a different one than pull would have used.
    let Some(fork_point) =
        run_merge_base(repo, &["--fork-point", &target.upstream_ref, "HEAD"]).await
    else {
        return Ok(None);
    };
    // A fork point equal to the merge base drops nothing — the overwhelmingly
    // common case, and the one that must stay promptless.
    let dropped = if fork_point == merge_base {
        Vec::new()
    } else {
        dropped_commits(repo, &merge_base, &fork_point).await?
    };

    Ok(Some(PullPlan {
        branch: target.branch.clone(),
        upstream: target.upstream.clone(),
        branch_tip,
        new_tip,
        merge_base,
        fork_point,
        dropped,
    }))
}

/// The guarded rebase-mode pull for the plain (non-autostash) core. `false` means
/// the guard stood down and the caller must run bare `git pull --rebase` exactly
/// as before.
pub(crate) async fn guarded_pull(state: &AppState, repo: &str) -> AppResult<bool> {
    let Some(target) = resolve(repo).await? else {
        return Ok(false);
    };
    // Shells out to git and the forge CLI — resolved before the lock, as the
    // autostash compounds do.
    let cred = credentials(repo, &target).await?;

    let domain = state.working_tree_lock(repo).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a pull").await?;
    // Re-read under the lock: `resolve` saw the tree before it, and another window
    // pausing a rebase in that gap would leave this one rebasing onto a conflict.
    if mid_op(repo).await {
        return Ok(false);
    }
    let Some(plan) = probe(state, repo, &target, &cred).await? else {
        return Ok(false);
    };
    if !plan.dropped().is_empty() {
        return Err(plan.into_error());
    }
    let autostash = plain_autostash_flag(repo).await;
    let already_unmerged = crate::git::ops::unmerged_paths(repo).await;
    let out = run_git_raw(
        Some(repo),
        &rebase_argv(autostash, &plan.new_tip, &plan.fork_point),
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Err(crate::git::ops::classify_failure(
            repo,
            "rebase",
            &already_unmerged,
            out.code,
            out.full_failure_text(),
        )
        .await);
    }
    // Only after a rebase that LANDED — a conflicted pull runs no submodule step
    // either (measured), and the tree is mid-rebase.
    update_submodules_after_rebase(repo).await?;
    Ok(true)
}

/// The guarded rebase-mode pull for the autostash core. `None` means the guard
/// stood down. The would-drop refusal fires BEFORE the stash, so a refused pull
/// leaves the dirty tree untouched and there is nothing to settle.
pub(crate) async fn guarded_pull_autostash(
    state: &AppState,
    repo: &str,
) -> AppResult<Option<AutostashOutcome>> {
    let Some(target) = resolve(repo).await? else {
        return Ok(None);
    };
    let cred = credentials(repo, &target).await?;

    let domain = state.working_tree_lock(repo).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a pull").await?;
    crate::git::ops::refuse_mid_op(repo).await?;
    let Some(plan) = probe(state, repo, &target, &cred).await? else {
        return Ok(None);
    };
    if !plan.dropped().is_empty() {
        return Err(plan.into_error());
    }
    let stashed = autostash_push(repo).await?;
    let op = run_git_raw(
        Some(repo),
        &rebase_argv(COMPOUND_AUTOSTASH, &plan.new_tip, &plan.fork_point),
        DEFAULT_TIMEOUT,
    )
    .await;
    let result = settle(repo, "rebase", stashed, true, op).await;
    // `settled_journal_error` is exactly the "did the rebase itself land" verdict a
    // conflicted REAPPLY still passes, which is the gate pull uses too — the stash
    // comes back before the submodule step runs either way.
    if settled_journal_error(&result).is_none() {
        let submodule = update_submodules_after_rebase(repo).await;
        return fold_submodule_failure(result, submodule).map(Some);
    }
    result.map(Some)
}

/// Which base the user's answer rebases from: `keep` starts below the rewritten-away
/// commits and replays them too, `drop` starts above them.
fn decided_base<'a>(decision: &str, keep_base: &'a str, drop_base: &'a str) -> AppResult<&'a str> {
    match decision {
        "keep" => Ok(keep_base),
        "drop" => Ok(drop_base),
        other => Err(AppError::InvalidArgument(format!(
            "unknown pull decision: {other}"
        ))),
    }
}

/// A validated decision: which branch it was made on, which SHA to rebase from,
/// and whether it drops commits.
struct Decided {
    branch: String,
    base: String,
    new_tip: String,
    dropping: bool,
}

/// Validate everything the decided commands take from IPC before any git runs.
/// Both commands are callable at any time by anything on the frontend, so the
/// decision word, the branch name and all four SHAs are checked here rather than
/// trusted. The branch takes the app's ref-name chokepoint because the journal
/// label reads `branch.<b>.remote` with it.
fn validate_decided(
    branch: &str,
    decision: &str,
    new_tip: &str,
    keep_base: &str,
    drop_base: &str,
    expected_tip: &str,
) -> AppResult<Decided> {
    crate::git::branches::validate_ref_name(branch)?;
    for sha in [new_tip, keep_base, drop_base, expected_tip] {
        validate_hash(sha)?;
    }
    let base = decided_base(decision, keep_base, drop_base)?;
    Ok(Decided {
        branch: branch.to_string(),
        base: base.to_string(),
        new_tip: new_tip.to_string(),
        dropping: decision == "drop",
    })
}

/// Refuse unless HEAD is still the branch AND the tip the decision was made on.
/// The tip alone is not identity: switching to another branch at the same commit
/// — or detaching — passes a tip check while a `--onto` replay would rewrite a ref
/// the user never chose. A detached HEAD names no branch, so it can never match.
async fn ensure_on_expected_commit(repo: &str, branch: &str, expected_tip: &str) -> AppResult<()> {
    let head_branch = current_branch(repo).await;
    let head = rev_parse(repo, "HEAD").await.unwrap_or_default();
    if head_branch.as_deref() != Some(branch) || !head.eq_ignore_ascii_case(expected_tip) {
        return Err(AppError::Command(format!(
            "{PULL_DECISION_STALE}: the branch or its tip moved while this pull was waiting for a decision — pull again to see where it stands."
        )));
    }
    Ok(())
}

/// `rev-list --count <from>..<to>`, or `None` when the count can't be read.
async fn rev_list_count(repo: &str, from: &str, to: &str) -> Option<usize> {
    let out = run_git_raw(
        Some(repo),
        &["rev-list", "--count", &format!("{from}..{to}")],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    (out.code == 0)
        .then(|| out.stdout_lossy().trim().parse().ok())
        .flatten()
}

/// Journal label for a decided drop. Both reads are best-effort, and an
/// unreadable one degrades the wording rather than asserting a number or an
/// upstream the journal never measured.
async fn drop_label(repo: &str, keep_base: &str, drop_base: &str, branch: &str) -> String {
    let count = rev_list_count(repo, keep_base, drop_base).await;
    let upstream = upstream_of(repo, branch)
        .await
        .ok()
        .flatten()
        .map(|(_, up, _)| up)
        .unwrap_or_else(|| "its upstream".to_string());
    match count {
        Some(n) => {
            let noun = if n == 1 { "commit" } else { "commits" };
            format!("Drop {n} {noun} rewritten away on {upstream}")
        }
        None => format!("Drop the commits rewritten away on {upstream}"),
    }
}

/// Journal the DROP arm only: it is the one answer that rewrites commits away, so
/// it is the one a crash or a regretted click needs a record of. Keeping is an
/// ordinary rebase. Inform-only — a journal failure never affects the op.
///
/// The branch is the VALIDATED one, not a fresh read: recording decide-time HEAD
/// would hide exactly the mix-up the identity check exists to catch.
///
/// `pre_op_tip` is the pre-op HEAD, duplicating `original_sha` — the house shape
/// for an op that moves a single ref (`rewrite_commits` and `rebase_edit` both
/// pass their `orig`/`original_sha` twice). The slot is a reset-rollback target,
/// so the upstream tip is the one sha it must never hold: resetting there is
/// exactly the drop the user might want undone.
async fn begin_drop_journal(
    repo: &str,
    decided: &Decided,
    keep_base: &str,
    drop_base: &str,
    expected_tip: &str,
) -> Option<String> {
    if !decided.dropping {
        return None;
    }
    let label = drop_label(repo, keep_base, drop_base, &decided.branch).await;
    crate::oplog::begin(
        repo,
        "pull_rebase_drop",
        &label,
        Some(decided.branch.clone()),
        expected_tip,
        Some(expected_tip),
    )
    .await
}

/// The journal's failure text for a settled compound. An outcome that CARRIES the
/// op's failure is still a failed op even though `settle` reports it as `Ok`; a
/// conflicted REAPPLY is not — the rebase itself landed.
fn settled_journal_error(result: &AppResult<AutostashOutcome>) -> Option<String> {
    match result {
        Err(err) => Some(err.to_string()),
        Ok(AutostashOutcome::OpFailedRestored { stderr })
        | Ok(AutostashOutcome::OpFailedStashKept { stderr, .. }) => Some(stderr.clone()),
        Ok(_) => None,
    }
}

/// Whether a settled compound HANDED the tree to the user rather than ending — the
/// journal's pause condition, and the compound's answer to the plain core's
/// `AppError::Conflict`.
///
/// `in_progress` is the whole discrimination, not decoration: it is true only when
/// the rebase stopped and left itself for the user to continue or abort. The same
/// variant with `in_progress: false` means the op is OVER and the stash was kept
/// because the RESTORE-pop failed — a real failure with nothing waiting on the user,
/// which must journal as one.
fn settled_paused(result: &AppResult<AutostashOutcome>) -> bool {
    matches!(
        result,
        Ok(AutostashOutcome::OpFailedStashKept {
            in_progress: true,
            ..
        })
    )
}

/// Phase B: rebase onto the SHAs the user decided on, keeping or dropping the
/// commits the fork-point verdict would have rewritten away. `branch` is the one
/// the refusal named — the decision only means anything on that ref.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // one flat arg per pinned SHA the decision rests on
pub async fn git_pull_rebase_decided(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
    decision: String,
    new_tip: String,
    keep_base: String,
    drop_base: String,
    expected_tip: String,
) -> AppResult<()> {
    git_pull_rebase_decided_core(
        &state,
        repo_path,
        branch,
        decision,
        new_tip,
        keep_base,
        drop_base,
        expected_tip,
    )
    .await
}

#[allow(clippy::too_many_arguments)] // one flat arg per pinned SHA the decision rests on
pub(crate) async fn git_pull_rebase_decided_core(
    state: &AppState,
    repo_path: String,
    branch: String,
    decision: String,
    new_tip: String,
    keep_base: String,
    drop_base: String,
    expected_tip: String,
) -> AppResult<()> {
    let decided = validate_decided(
        &branch,
        &decision,
        &new_tip,
        &keep_base,
        &drop_base,
        &expected_tip,
    )?;

    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a pull").await?;
    // Names what the user asked for: this arm stashes nothing, so `refuse_mid_op`'s
    // "Can't stash …" would describe an operation that isn't happening.
    crate::git::ops::refuse_mid_op_for(&repo_path, "pull").await?;
    ensure_on_expected_commit(&repo_path, &decided.branch, &expected_tip).await?;

    let op_id =
        begin_drop_journal(&repo_path, &decided, &keep_base, &drop_base, &expected_tip).await;
    let autostash = plain_autostash_flag(&repo_path).await;
    let out = run_git_raw(
        Some(&repo_path),
        &rebase_argv(autostash, &decided.new_tip, &decided.base),
        DEFAULT_TIMEOUT,
    )
    .await;
    let result = match out {
        Err(err) => Err(err),
        // The baseline is empty because `refuse_mid_op` already ruled out an
        // unmerged index, so anything unmerged now is this rebase's own.
        Ok(out) if out.code != 0 => Err(crate::git::ops::classify_failure(
            &repo_path,
            "rebase",
            &[],
            out.code,
            out.full_failure_text(),
        )
        .await),
        Ok(_) => Ok(()),
    };
    // The submodule step belongs to THIS op as far as the journal is concerned, so it
    // runs BEFORE the record closes: settling first would leave a green "done" row
    // behind a call the caller saw fail.
    let result = match result {
        Ok(()) => update_submodules_after_rebase(&repo_path).await,
        stopped => stopped,
    };
    // A conflict did not END the op — it handed the tree to the user, who still has
    // to continue or abort it. The record pauses exactly as the cherry-pick stop
    // arm's does; every other failure is a real failure.
    if matches!(result, Err(AppError::Conflict { .. })) {
        crate::oplog::pause(&repo_path, &op_id).await;
    } else {
        crate::oplog::finish(
            &repo_path,
            &op_id,
            result.as_ref().err().map(ToString::to_string),
        )
        .await;
    }
    result
}

/// [`git_pull_rebase_decided`] with the uncommitted changes stashed across the
/// rebase and reapplied afterwards.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // one flat arg per pinned SHA the decision rests on
pub async fn git_pull_rebase_decided_autostash(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
    decision: String,
    new_tip: String,
    keep_base: String,
    drop_base: String,
    expected_tip: String,
) -> AppResult<AutostashOutcome> {
    git_pull_rebase_decided_autostash_core(
        &state,
        repo_path,
        branch,
        decision,
        new_tip,
        keep_base,
        drop_base,
        expected_tip,
    )
    .await
}

#[allow(clippy::too_many_arguments)] // one flat arg per pinned SHA the decision rests on
pub(crate) async fn git_pull_rebase_decided_autostash_core(
    state: &AppState,
    repo_path: String,
    branch: String,
    decision: String,
    new_tip: String,
    keep_base: String,
    drop_base: String,
    expected_tip: String,
) -> AppResult<AutostashOutcome> {
    let decided = validate_decided(
        &branch,
        &decision,
        &new_tip,
        &keep_base,
        &drop_base,
        &expected_tip,
    )?;

    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a pull").await?;
    crate::git::ops::refuse_mid_op(&repo_path).await?;
    ensure_on_expected_commit(&repo_path, &decided.branch, &expected_tip).await?;

    let op_id =
        begin_drop_journal(&repo_path, &decided, &keep_base, &drop_base, &expected_tip).await;
    let result = decided_autostash_run(&repo_path, &decided).await;
    // Submodule step first, folded into the result, so the record below closes on the
    // SAME verdict the caller receives — a settle-then-step order journals "done" for
    // a call that goes on to return an error.
    let result = if settled_journal_error(&result).is_none() {
        let submodule = update_submodules_after_rebase(&repo_path).await;
        fold_submodule_failure(result, submodule)
    } else {
        result
    };
    // The compound's conflict shape — see [`settled_paused`]. A stash kept for any
    // OTHER reason is a real failure.
    if settled_paused(&result) {
        crate::oplog::pause(&repo_path, &op_id).await;
    } else {
        crate::oplog::finish(&repo_path, &op_id, settled_journal_error(&result)).await;
    }
    result
}

/// stash → rebase → reapply for the decided autostash command, split out so the
/// journal entry is finished on every exit — a failed stash push included.
async fn decided_autostash_run(repo: &str, decided: &Decided) -> AppResult<AutostashOutcome> {
    let stashed = autostash_push(repo).await?;
    let op = run_git_raw(
        Some(repo),
        &rebase_argv(COMPOUND_AUTOSTASH, &decided.new_tip, &decided.base),
        DEFAULT_TIMEOUT,
    )
    .await;
    settle(repo, "rebase", stashed, true, op).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    async fn rev(repo: &str, r: &str) -> String {
        git(repo, &["rev-parse", r]).await.trim().to_string()
    }

    async fn log_subjects(repo: &str) -> Vec<String> {
        git(repo, &["log", "--format=%s"])
            .await
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn temp(marker: &str) -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix(&format!("gd-pullguard-{marker}-"))
            .tempdir()
            .expect("create temp dir")
    }

    async fn configure(repo: &str) {
        git(repo, &["config", "core.autocrlf", "false"]).await;
        git(repo, &["config", "user.email", "t@t.local"]).await;
        git(repo, &["config", "user.name", "T"]).await;
    }

    /// A bare origin, a teammate's `work` clone, and the clone under test — in
    /// which the user has PUSHED a commit `V` that the teammate then force-pushed
    /// away. Returns the fixture guard, the clone's path, and V's sha.
    ///
    /// The push is what arms the trap: it writes V into the clone's
    /// `refs/remotes/origin/main` reflog, which is where fork-point finds it.
    async fn vaporize_fixture(marker: &str) -> (tempfile::TempDir, String, String) {
        let dir = temp(marker);
        let root = dir.path().to_string_lossy().into_owned();
        git(&root, &["init", "-q", "--bare", "-b", "main", "origin.git"]).await;
        let url = format!(
            "file://{}",
            dir.path()
                .join("origin.git")
                .to_string_lossy()
                .replace('\\', "/")
        );

        git(&root, &["init", "-q", "-b", "main", "work"]).await;
        let work_dir = dir.path().join("work");
        let work = work_dir.to_string_lossy().into_owned();
        configure(&work).await;
        std::fs::write(work_dir.join("a.txt"), "base\n").unwrap();
        git(&work, &["add", "-A"]).await;
        git(&work, &["commit", "-qm", "base"]).await;
        git(&work, &["remote", "add", "origin", &url]).await;
        git(&work, &["push", "-q", "-u", "origin", "main"]).await;

        git(
            &root,
            &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"],
        )
        .await;
        let clone_dir = dir.path().join("clone");
        let clone = clone_dir.to_string_lossy().into_owned();
        configure(&clone).await;

        // The user commits and PUSHES V.
        std::fs::write(clone_dir.join("v.txt"), "v\n").unwrap();
        git(&clone, &["add", "-A"]).await;
        git(&clone, &["commit", "-qm", "V the victim"]).await;
        git(&clone, &["push", "-q"]).await;
        let victim = rev(&clone, "HEAD").await;

        // The teammate rewrites origin's history over it.
        git(&work, &["fetch", "-q"]).await;
        git(&work, &["reset", "-q", "--hard", "origin/main~1"]).await;
        std::fs::write(work_dir.join("r.txt"), "r\n").unwrap();
        git(&work, &["add", "-A"]).await;
        git(&work, &["commit", "-qm", "teammate rewrite"]).await;
        git(&work, &["push", "-q", "--force"]).await;

        (dir, clone, victim)
    }

    /// The clone with its guard already run: the fixture above plus the SHAs the
    /// decision would carry. Fetching here is what the guard's phase A does.
    async fn decided_fixture(marker: &str) -> (tempfile::TempDir, String, DecisionShas) {
        let (dir, clone, victim) = vaporize_fixture(marker).await;
        git(&clone, &["fetch", "-q"]).await;
        let shas = DecisionShas {
            new_tip: rev(&clone, "refs/remotes/origin/main").await,
            keep_base: run_merge_base(&clone, &["main", "refs/remotes/origin/main"])
                .await
                .expect("the histories are related"),
            drop_base: run_merge_base(
                &clone,
                &["--fork-point", "refs/remotes/origin/main", "main"],
            )
            .await
            .expect("the push left a fork point in the reflog"),
            expected_tip: victim,
        };
        (dir, clone, shas)
    }

    struct DecisionShas {
        new_tip: String,
        keep_base: String,
        drop_base: String,
        expected_tip: String,
    }

    // ---- pure ---------------------------------------------------------------

    #[test]
    fn parse_dropped_reads_every_nul_separated_field() {
        // `\x00` before a digit: a bare `\0` there reads as an octal escape.
        let out = "abc\0first subject\0Ada\x002026-08-28T23:37:38-04:00\n\
                   def\0second\0Bob\x002026-08-27T10:00:00+00:00\n";
        assert_eq!(
            parse_dropped(out),
            vec![
                DroppedCommit {
                    sha: "abc".into(),
                    subject: "first subject".into(),
                    author: "Ada".into(),
                    author_date: "2026-08-28T23:37:38-04:00".into(),
                },
                DroppedCommit {
                    sha: "def".into(),
                    subject: "second".into(),
                    author: "Bob".into(),
                    author_date: "2026-08-27T10:00:00+00:00".into(),
                },
            ]
        );
    }

    #[test]
    fn parse_dropped_skips_a_short_record() {
        // A half-filled commit would present a blank author or date as fact.
        assert_eq!(parse_dropped("abc\0subject\0Ada\n"), vec![]);
        assert_eq!(parse_dropped(""), vec![]);
    }

    fn dropped_fixture(n: usize) -> Vec<DroppedCommit> {
        (0..n)
            .map(|i| DroppedCommit {
                sha: format!("sha{i}"),
                subject: "s".into(),
                author: "a".into(),
                author_date: "d".into(),
            })
            .collect()
    }

    /// The skip above is only safe because the count reconciles: an under-reported
    /// drop set would have the user approve a drop that takes more than it named,
    /// and a set that shrank to empty would stand the guard down into the very
    /// vaporize it exists to prevent. Every non-matching case refuses.
    #[test]
    fn reconcile_dropped_fails_closed_on_any_count_mismatch() {
        assert_eq!(
            reconcile_dropped(dropped_fixture(2), Some(2)).unwrap(),
            dropped_fixture(2)
        );
        for counted in [Some(3), Some(1), Some(0), None] {
            let err = reconcile_dropped(dropped_fixture(2), counted)
                .expect_err("a count that disagrees must refuse");
            assert!(
                matches!(&err, AppError::Command(m) if m.contains("commits at risk")),
                "counted={counted:?} → {err:?}"
            );
        }
        // The empty range is the promptless path and must still pass cleanly.
        assert_eq!(reconcile_dropped(Vec::new(), Some(0)).unwrap(), vec![]);
    }

    /// The three arms that mean "the op failed" — a conflicted REAPPLY is not one
    /// of them, because the rebase itself landed.
    #[test]
    fn settled_journal_error_reports_only_a_failed_op() {
        assert_eq!(
            settled_journal_error(&Err(AppError::Command("boom".into()))).as_deref(),
            Some("boom")
        );
        assert_eq!(
            settled_journal_error(&Ok(AutostashOutcome::OpFailedRestored {
                stderr: "restored".into()
            }))
            .as_deref(),
            Some("restored")
        );
        assert_eq!(
            settled_journal_error(&Ok(AutostashOutcome::OpFailedStashKept {
                stderr: "kept".into(),
                in_progress: true
            }))
            .as_deref(),
            Some("kept")
        );
        assert_eq!(
            settled_journal_error(&Ok(AutostashOutcome::ReapplyConflicted {
                stderr: "pop".into(),
                conflicted: true
            })),
            None
        );
        assert_eq!(
            settled_journal_error(&Ok(AutostashOutcome::Reapplied)),
            None
        );
        assert_eq!(
            settled_journal_error(&Ok(AutostashOutcome::NothingStashed)),
            None
        );
    }

    /// `in_progress` is the whole pause discrimination: the SAME variant with it
    /// false means the op ended and the stash was kept because the restore-pop
    /// failed, which is a failure to journal, not a hand-off to the user. An
    /// integration fixture cannot pin that half — a conflicted rebase always leaves
    /// itself in progress — so the predicate is pinned here instead.
    #[test]
    fn settled_paused_is_only_a_rebase_left_in_progress() {
        assert!(settled_paused(&Ok(AutostashOutcome::OpFailedStashKept {
            stderr: "conflict".into(),
            in_progress: true
        })));
        assert!(
            !settled_paused(&Ok(AutostashOutcome::OpFailedStashKept {
                stderr: "the restore-pop failed".into(),
                in_progress: false
            })),
            "the op is over — nothing is waiting on the user"
        );
        // No other settled shape is a pause, failed or landed.
        assert!(!settled_paused(&Ok(AutostashOutcome::OpFailedRestored {
            stderr: "restored".into()
        })));
        assert!(
            !settled_paused(&Ok(AutostashOutcome::ReapplyConflicted {
                stderr: "pop".into(),
                conflicted: true
            }))
        );
        assert!(!settled_paused(&Ok(AutostashOutcome::Reapplied)));
        assert!(!settled_paused(&Ok(AutostashOutcome::NothingStashed)));
        assert!(!settled_paused(&Ok(AutostashOutcome::StashedOnly)));
        assert!(!settled_paused(&Err(AppError::Command("boom".into()))));
    }

    #[test]
    fn rebase_argv_carries_only_the_autostash_flag_it_is_given() {
        assert_eq!(
            rebase_argv(None, "tip", "base"),
            vec!["-c", "core.editor=true", "rebase", "--onto", "tip", "base"]
        );
        assert_eq!(
            rebase_argv(Some("--autostash"), "tip", "base"),
            vec![
                "-c",
                "core.editor=true",
                "rebase",
                "--autostash",
                "--onto",
                "tip",
                "base"
            ]
        );
        assert_eq!(
            rebase_argv(COMPOUND_AUTOSTASH, "tip", "base"),
            vec![
                "-c",
                "core.editor=true",
                "rebase",
                "--no-autostash",
                "--onto",
                "tip",
                "base"
            ]
        );
    }

    #[test]
    fn upstream_parts_accepts_a_resolved_tracking_ref() {
        assert_eq!(
            upstream_parts("refs/remotes/origin/main", "origin/main", "origin"),
            Some((
                "refs/remotes/origin/main".into(),
                "origin/main".into(),
                "origin".into()
            ))
        );
        // A local-branch upstream is a valid target — it just has nothing to fetch.
        assert_eq!(
            upstream_parts("refs/heads/dev", "dev", "."),
            Some(("refs/heads/dev".into(), "dev".into(), ".".into()))
        );
    }

    #[test]
    fn upstream_parts_refuses_anything_it_cannot_use_as_argv() {
        // A flag-shaped remote would reach `git fetch <remote>` as its own token.
        assert_eq!(
            upstream_parts("refs/remotes/-x/main", "-x/main", "-x"),
            None
        );
        // An unset `branch.<b>.remote` leaves nothing to fetch from.
        assert_eq!(
            upstream_parts("refs/remotes/origin/main", "origin/main", ""),
            None
        );
        // An upstream that didn't resolve to a ref is not one to rev-parse.
        assert_eq!(upstream_parts("HEAD", "HEAD", "origin"), None);
    }

    #[test]
    fn decided_base_maps_the_two_answers_and_refuses_anything_else() {
        assert_eq!(decided_base("keep", "mb", "fp").unwrap(), "mb");
        assert_eq!(decided_base("drop", "mb", "fp").unwrap(), "fp");
        for bad in ["", "Keep", "keep ", "rebase", "--onto"] {
            assert!(
                matches!(
                    decided_base(bad, "mb", "fp"),
                    Err(AppError::InvalidArgument(_))
                ),
                "{bad:?} must not decide anything"
            );
        }
    }

    #[test]
    fn would_drop_message_names_the_count_and_upstream() {
        assert_eq!(
            would_drop_message(1, "origin/main"),
            "Pulling with rebase would drop 1 commit that origin/main no longer contains."
        );
        assert_eq!(
            would_drop_message(2, "origin/main"),
            "Pulling with rebase would drop 2 commits that origin/main no longer contains."
        );
    }

    // ---- decided (phase B) --------------------------------------------------

    /// Keep replays the rewritten-away commit on top of the new upstream tip —
    /// the answer that costs the user nothing but a duplicated commit.
    #[tokio::test]
    async fn decided_keep_replays_the_commit_the_upstream_dropped() {
        let (_dir, clone, shas) = decided_fixture("keep").await;

        let state = AppState::default();
        git_pull_rebase_decided_core(
            &state,
            clone.clone(),
            "main".into(),
            "keep".into(),
            shas.new_tip.clone(),
            shas.keep_base.clone(),
            shas.drop_base.clone(),
            shas.expected_tip.clone(),
        )
        .await
        .expect("keeping rebases cleanly");

        assert_eq!(
            log_subjects(&clone).await,
            vec!["V the victim", "teammate rewrite", "base"],
            "V is replayed on top of the rewritten upstream"
        );
    }

    /// Drop is the destructive answer, so it is the one the journal records.
    #[tokio::test]
    async fn decided_drop_removes_the_commit_and_journals_the_op() {
        let (_dir, clone, shas) = decided_fixture("drop").await;

        let state = AppState::default();
        git_pull_rebase_decided_core(
            &state,
            clone.clone(),
            "main".into(),
            "drop".into(),
            shas.new_tip.clone(),
            shas.keep_base.clone(),
            shas.drop_base.clone(),
            shas.expected_tip.clone(),
        )
        .await
        .expect("dropping rebases cleanly");

        assert_eq!(
            log_subjects(&clone).await,
            vec!["teammate rewrite", "base"],
            "V is gone from the branch"
        );
        let entry = crate::oplog::git_oplog_list(clone.clone())
            .await
            .expect("the journal must be readable")
            .into_iter()
            .find(|e| e.op == "pull_rebase_drop")
            .expect("a drop must be journaled");
        assert_eq!(entry.status, "done");
        assert_eq!(
            entry.original_sha, shas.expected_tip,
            "the record anchors on the pre-op tip"
        );
        assert_eq!(entry.label, "Drop 1 commit rewritten away on origin/main");
        assert_eq!(
            entry.original_ref.as_deref(),
            Some("main"),
            "the record names the branch the decision was validated against"
        );
    }

    /// The keep arm rewrites nothing away, so it leaves no journal entry.
    #[tokio::test]
    async fn decided_keep_journals_nothing() {
        let (_dir, clone, shas) = decided_fixture("keep-nojournal").await;

        let state = AppState::default();
        git_pull_rebase_decided_core(
            &state,
            clone.clone(),
            "main".into(),
            "keep".into(),
            shas.new_tip,
            shas.keep_base,
            shas.drop_base,
            shas.expected_tip,
        )
        .await
        .unwrap();

        assert!(
            crate::oplog::git_oplog_list(clone.clone())
                .await
                .unwrap()
                .iter()
                .all(|e| e.op != "pull_rebase_drop"),
            "keeping is an ordinary rebase"
        );
    }

    /// Every SHA in a decision describes the moment it was made, so a branch that
    /// moved since is refused outright — with the marker the frontend keys on.
    #[tokio::test]
    async fn decided_refuses_a_stale_expected_tip() {
        let (dir, clone, shas) = decided_fixture("stale").await;
        // The branch moves after the decision was computed.
        std::fs::write(dir.path().join("clone").join("late.txt"), "late\n").unwrap();
        git(&clone, &["add", "-A"]).await;
        git(&clone, &["commit", "-qm", "late local commit"]).await;
        let moved = rev(&clone, "HEAD").await;

        let state = AppState::default();
        let err = git_pull_rebase_decided_core(
            &state,
            clone.clone(),
            "main".into(),
            "drop".into(),
            shas.new_tip,
            shas.keep_base,
            shas.drop_base,
            shas.expected_tip,
        )
        .await
        .expect_err("a moved branch must be refused");
        assert!(
            err.to_string().contains(PULL_DECISION_STALE),
            "the frontend keys its toast off the marker: {err}"
        );
        assert_eq!(rev(&clone, "HEAD").await, moved, "the branch never moved");
        assert_eq!(
            log_subjects(&clone).await.first().map(String::as_str),
            Some("late local commit")
        );
    }

    /// The tip alone is not identity. Another branch sitting at the SAME commit
    /// passes a tip check, and the `--onto` replay would then rewrite a ref the
    /// user never decided anything about.
    #[tokio::test]
    async fn decided_refuses_a_switch_to_another_branch_at_the_same_commit() {
        let (_dir, clone, shas) = decided_fixture("switched").await;
        git(&clone, &["switch", "-q", "-c", "elsewhere"]).await;
        assert_eq!(
            rev(&clone, "HEAD").await,
            shas.expected_tip,
            "the fixture's whole point: same commit, different branch"
        );

        let state = AppState::default();
        let err = git_pull_rebase_decided_core(
            &state,
            clone.clone(),
            "main".into(),
            "drop".into(),
            shas.new_tip,
            shas.keep_base,
            shas.drop_base,
            shas.expected_tip.clone(),
        )
        .await
        .expect_err("the decision was made on main, not on elsewhere");
        assert!(
            err.to_string().contains(PULL_DECISION_STALE),
            "the frontend keys its toast off the marker: {err}"
        );
        assert_eq!(rev(&clone, "refs/heads/main").await, shas.expected_tip);
        assert_eq!(rev(&clone, "refs/heads/elsewhere").await, shas.expected_tip);
        assert!(crate::oplog::git_oplog_list(clone.clone())
            .await
            .unwrap()
            .iter()
            .all(|e| e.op != "pull_rebase_drop"));
    }

    /// A detached HEAD names no branch, so it can never be the branch the refusal
    /// named — even parked on the very commit the decision was made at.
    #[tokio::test]
    async fn decided_refuses_a_detached_head() {
        let (_dir, clone, shas) = decided_fixture("detached").await;
        git(&clone, &["switch", "-q", "--detach"]).await;

        let state = AppState::default();
        let err = git_pull_rebase_decided_core(
            &state,
            clone.clone(),
            "main".into(),
            "drop".into(),
            shas.new_tip,
            shas.keep_base,
            shas.drop_base,
            shas.expected_tip.clone(),
        )
        .await
        .expect_err("a detached HEAD is not the branch that was decided on");
        assert!(err.to_string().contains(PULL_DECISION_STALE), "{err}");
        assert_eq!(rev(&clone, "refs/heads/main").await, shas.expected_tip);
    }

    /// What the flag translation has to mirror, measured on git 2.51.1: bare
    /// `git pull --rebase` honors `pull.autoStash`, and falls back to
    /// `rebase.autoStash` when it is unset — while a bare `git rebase` ignores
    /// `pull.autoStash` entirely, which is why an explicit flag is needed.
    #[tokio::test]
    async fn plain_autostash_flag_translates_pull_autostash_only() {
        let (_dir, clone, _shas) = decided_fixture("autostash-flag").await;

        assert_eq!(
            plain_autostash_flag(&clone).await,
            None,
            "unset ⇒ no flag, so `rebase.autoStash` still governs"
        );
        git(&clone, &["config", "rebase.autoStash", "true"]).await;
        assert_eq!(
            plain_autostash_flag(&clone).await,
            None,
            "rebase.autoStash is git's own business — we must not translate it"
        );
        git(&clone, &["config", "pull.autoStash", "true"]).await;
        assert_eq!(plain_autostash_flag(&clone).await, Some("--autostash"));
        git(&clone, &["config", "pull.autoStash", "false"]).await;
        assert_eq!(plain_autostash_flag(&clone).await, Some("--no-autostash"));
        // `--bool` normalizes git's other spellings of true.
        git(&clone, &["config", "pull.autoStash", "yes"]).await;
        assert_eq!(plain_autostash_flag(&clone).await, Some("--autostash"));
        // A non-boolean value reads as unset rather than forcing a verdict.
        git(&clone, &["config", "pull.autoStash", "sometimes"]).await;
        assert_eq!(plain_autostash_flag(&clone).await, None);
    }

    /// The commands are fresh IPC surface: a bad decision word or a non-hex SHA is
    /// refused before any git runs.
    #[tokio::test]
    async fn decided_refuses_bad_arguments_without_touching_the_repo() {
        let (_dir, clone, shas) = decided_fixture("bad-args").await;
        let before = rev(&clone, "HEAD").await;
        let state = AppState::default();

        let bad_decision = git_pull_rebase_decided_core(
            &state,
            clone.clone(),
            "main".into(),
            "vaporize".into(),
            shas.new_tip.clone(),
            shas.keep_base.clone(),
            shas.drop_base.clone(),
            shas.expected_tip.clone(),
        )
        .await
        .expect_err("only keep and drop decide anything");
        assert!(matches!(bad_decision, AppError::InvalidArgument(_)));

        for bad in ["--onto", "refs/heads/main", "", "deadbeef;rm"] {
            let err = git_pull_rebase_decided_core(
                &state,
                clone.clone(),
                "main".into(),
                "drop".into(),
                bad.into(),
                shas.keep_base.clone(),
                shas.drop_base.clone(),
                shas.expected_tip.clone(),
            )
            .await
            .expect_err("a non-hex sha never reaches argv");
            assert!(
                matches!(&err, AppError::InvalidArgument(m) if m.contains("invalid commit hash")),
                "{bad:?} → {err:?}"
            );
        }
        assert_eq!(rev(&clone, "HEAD").await, before);
        assert!(crate::oplog::git_oplog_list(clone.clone())
            .await
            .unwrap()
            .iter()
            .all(|e| e.op != "pull_rebase_drop"));
    }

    /// The vaporize fixture with every side editing `a.txt`, so whichever commit a
    /// decision replays collides with the new upstream tip. `extra_local` adds an
    /// unpushed commit ON TOP of V — the only way a DROP can conflict, since
    /// dropping V alone leaves nothing to replay.
    async fn colliding_fixture(
        marker: &str,
        extra_local: bool,
    ) -> (tempfile::TempDir, String, DecisionShas) {
        let dir = temp(marker);
        let root = dir.path().to_string_lossy().into_owned();
        git(&root, &["init", "-q", "--bare", "-b", "main", "origin.git"]).await;
        let url = format!(
            "file://{}",
            dir.path()
                .join("origin.git")
                .to_string_lossy()
                .replace('\\', "/")
        );
        git(&root, &["init", "-q", "-b", "main", "work"]).await;
        let work_dir = dir.path().join("work");
        let work = work_dir.to_string_lossy().into_owned();
        configure(&work).await;
        std::fs::write(work_dir.join("a.txt"), "base\n").unwrap();
        git(&work, &["add", "-A"]).await;
        git(&work, &["commit", "-qm", "base"]).await;
        git(&work, &["remote", "add", "origin", &url]).await;
        git(&work, &["push", "-q", "-u", "origin", "main"]).await;
        git(
            &root,
            &["-c", "core.autocrlf=false", "clone", "-q", &url, "clone"],
        )
        .await;
        let clone_dir = dir.path().join("clone");
        let clone = clone_dir.to_string_lossy().into_owned();
        configure(&clone).await;

        std::fs::write(clone_dir.join("a.txt"), "mine\n").unwrap();
        git(&clone, &["commit", "-qam", "V the victim"]).await;
        git(&clone, &["push", "-q"]).await;
        if extra_local {
            std::fs::write(clone_dir.join("a.txt"), "mine, later\n").unwrap();
            git(&clone, &["commit", "-qam", "W the survivor"]).await;
        }
        let expected_tip = rev(&clone, "HEAD").await;

        git(&work, &["fetch", "-q"]).await;
        git(&work, &["reset", "-q", "--hard", "origin/main~1"]).await;
        std::fs::write(work_dir.join("a.txt"), "theirs\n").unwrap();
        git(&work, &["commit", "-qam", "teammate rewrite"]).await;
        git(&work, &["push", "-q", "--force"]).await;
        git(&clone, &["fetch", "-q"]).await;

        let shas = DecisionShas {
            new_tip: rev(&clone, "refs/remotes/origin/main").await,
            keep_base: run_merge_base(&clone, &["HEAD", "refs/remotes/origin/main"])
                .await
                .unwrap(),
            drop_base: run_merge_base(
                &clone,
                &["--fork-point", "refs/remotes/origin/main", "HEAD"],
            )
            .await
            .unwrap(),
            expected_tip,
        };
        (dir, clone, shas)
    }

    /// A keep whose replay collides with the new tip pauses a rebase, reported in
    /// the same conflict shape as any other paused rebase.
    #[tokio::test]
    async fn decided_keep_that_conflicts_pauses_a_rebase() {
        let (_dir, clone, shas) = colliding_fixture("keep-conflict", false).await;

        let state = AppState::default();
        let err = git_pull_rebase_decided_core(
            &state,
            clone.clone(),
            "main".into(),
            "keep".into(),
            shas.new_tip,
            shas.keep_base,
            shas.drop_base,
            shas.expected_tip,
        )
        .await
        .expect_err("the replay collides");
        let AppError::Conflict { op, paths, .. } = &err else {
            panic!("expected a conflict error, got {err:?}");
        };
        assert_eq!(op, "rebase");
        assert_eq!(paths, &vec!["a.txt".to_string()]);
        assert!(crate::git::ops::op_state(&clone).await.unwrap().rebasing);
    }

    /// Drive a decided DROP to its conflict: dropping V still replays the local
    /// commit above it, which collides with the rewritten upstream.
    async fn conflicted_drop(marker: &str) -> (tempfile::TempDir, String, DecisionShas) {
        let (dir, clone, shas) = colliding_fixture(marker, true).await;

        let state = AppState::default();
        let err = git_pull_rebase_decided_core(
            &state,
            clone.clone(),
            "main".into(),
            "drop".into(),
            shas.new_tip.clone(),
            shas.keep_base.clone(),
            shas.drop_base.clone(),
            shas.expected_tip.clone(),
        )
        .await
        .expect_err("W's replay collides with the rewritten upstream");
        let AppError::Conflict { op, paths, .. } = &err else {
            panic!("expected a conflict error, got {err:?}");
        };
        assert_eq!(op, "rebase");
        assert_eq!(paths, &vec!["a.txt".to_string()]);
        assert!(crate::git::ops::op_state(&clone).await.unwrap().rebasing);
        (dir, clone, shas)
    }

    /// `repo`'s journaled drop record.
    async fn drop_entry(repo: &str) -> crate::oplog::OpLogEntry {
        crate::oplog::git_oplog_list(repo.to_string())
            .await
            .expect("the journal must be readable")
            .into_iter()
            .find(|e| e.op == "pull_rebase_drop")
            .expect("a drop must be journaled even when it stops")
    }

    /// The destructive arm's conflict did not END the drop — it handed the tree to
    /// the user, who still has to continue or abort it. The record takes the same
    /// `"paused"` disposition a stopped cherry-pick gets: neither a failure that
    /// hasn't happened, nor a `"pending"` row offering recovery for a rebase the
    /// user is mid-resolve on.
    #[tokio::test]
    async fn decided_drop_that_conflicts_pauses_a_rebase_and_its_record() {
        let (_dir, clone, shas) = conflicted_drop("drop-conflict").await;

        let entry = drop_entry(&clone).await;
        assert_eq!(entry.status, "paused");
        assert!(entry.finished_at.is_none(), "a paused op has not ended");
        assert!(
            entry.error.is_none(),
            "the conflict lives in the banner, not in a failure line"
        );
        assert_eq!(entry.original_sha, shas.expected_tip);
        // The rollback slot holds the PRE-op tip, never the upstream's: resetting
        // to the upstream tip would redo the very drop a recovery is undoing.
        assert_eq!(
            entry.pre_op_tip.as_deref(),
            Some(shas.expected_tip.as_str()),
            "the rollback target is where the branch stood before the drop"
        );
        assert_ne!(entry.pre_op_tip.as_deref(), Some(shas.new_tip.as_str()));
        assert!(
            crate::oplog::git_oplog_check(clone.clone())
                .await
                .unwrap()
                .is_empty(),
            "and it is not pending, so relaunch offers no recovery for it"
        );
        assert_eq!(
            drop_entry(&clone).await.status,
            "paused",
            "a check must not retire the handle of a rebase that is still live"
        );
    }

    /// Continuing the paused rebase in-app ends the drop, so `op_continue`'s rebase
    /// arm closes its record done — the mirror of the route a pick already has.
    #[tokio::test]
    async fn continuing_a_paused_drop_closes_its_record() {
        let (dir, clone, _shas) = conflicted_drop("drop-continue").await;
        std::fs::write(dir.path().join("clone").join("a.txt"), "resolved\n").unwrap();
        git(&clone, &["add", "a.txt"]).await;

        let state = AppState::default();
        assert!(crate::git::ops::op_continue(&state, &clone, "rebase")
            .await
            .expect("the resolved rebase continues to completion"));
        assert!(!crate::git::ops::op_state(&clone).await.unwrap().rebasing);
        assert_eq!(drop_entry(&clone).await.status, "done");
    }

    /// Aborting it abandons the drop, journaled the way every user-abandoned op is.
    #[tokio::test]
    async fn aborting_a_paused_drop_closes_its_record() {
        let (_dir, clone, shas) = conflicted_drop("drop-abort").await;

        let state = AppState::default();
        crate::git::ops::op_abort(&state, &clone, "rebase")
            .await
            .expect("the paused rebase aborts");
        assert_eq!(
            rev(&clone, "HEAD").await,
            shas.expected_tip,
            "the abort restored the branch"
        );
        let entry = drop_entry(&clone).await;
        assert_eq!(entry.status, "failed");
        assert_eq!(entry.error.as_deref(), Some("aborted by user"));
    }

    /// The COMPOUND's pause predicate is a different shape from the plain core's
    /// `AppError::Conflict`: the conflict arrives as an `Ok` outcome, and only
    /// `in_progress` separates a rebase left for the user from a stash kept because
    /// the restore-pop itself failed. Matching the wrong variant — or dropping that
    /// narrowing — would journal a paused pull as "failed" with nothing to catch it.
    #[tokio::test]
    async fn a_conflicted_drop_under_autostash_pauses_its_record() {
        let (dir, clone, shas) = colliding_fixture("drop-conflict-autostash", true).await;
        // Uncommitted work, so the compound actually stashes: with a clean tree
        // `settle` takes its no-stash path and reports the conflict as an Err instead.
        std::fs::write(dir.path().join("clone").join("dirty.txt"), "dirty\n").unwrap();

        let state = AppState::default();
        let outcome = git_pull_rebase_decided_autostash_core(
            &state,
            clone.clone(),
            "main".into(),
            "drop".into(),
            shas.new_tip,
            shas.keep_base,
            shas.drop_base,
            shas.expected_tip.clone(),
        )
        .await
        .expect("a paused rebase settles as an outcome, not an error");
        assert!(
            matches!(
                outcome,
                AutostashOutcome::OpFailedStashKept {
                    in_progress: true,
                    ..
                }
            ),
            "the rebase stopped and left itself in progress: {outcome:?}"
        );
        assert!(crate::git::ops::op_state(&clone).await.unwrap().rebasing);

        let entry = drop_entry(&clone).await;
        assert_eq!(entry.status, "paused", "not a failure — it is waiting on the user");
        assert!(entry.finished_at.is_none(), "a paused op has not ended");
        assert!(entry.error.is_none());
        assert_eq!(entry.original_sha, shas.expected_tip);
    }

    /// The autostash variant stashes the dirty tree across the rebase and puts it
    /// back on the far side.
    #[tokio::test]
    async fn decided_autostash_stashes_rebases_and_reapplies() {
        let (dir, clone, shas) = decided_fixture("autostash").await;
        let clone_dir = dir.path().join("clone");
        std::fs::write(clone_dir.join("dirty.txt"), "dirty\n").unwrap();

        let state = AppState::default();
        let outcome = git_pull_rebase_decided_autostash_core(
            &state,
            clone.clone(),
            "main".into(),
            "drop".into(),
            shas.new_tip,
            shas.keep_base,
            shas.drop_base,
            shas.expected_tip,
        )
        .await
        .expect("the compound settles");
        assert!(
            matches!(outcome, AutostashOutcome::Reapplied),
            "{outcome:?}"
        );
        assert_eq!(log_subjects(&clone).await, vec!["teammate rewrite", "base"]);
        assert_eq!(
            std::fs::read_to_string(clone_dir.join("dirty.txt")).unwrap(),
            "dirty\n"
        );
        assert!(git(&clone, &["stash", "list"]).await.trim().is_empty());
    }

    // ---- submodule parity ---------------------------------------------------

    /// The gate is git's own boolean resolution, so every spelling of true counts
    /// and anything non-boolean reads as the key's documented default, false.
    #[tokio::test]
    async fn submodule_recurse_reads_gits_own_boolean() {
        let (_dir, clone, _shas) = decided_fixture("submodule-config").await;

        assert!(!submodule_recurse(&clone).await, "unset defaults to false");
        git(&clone, &["config", "submodule.recurse", "yes"]).await;
        assert!(submodule_recurse(&clone).await);
        git(&clone, &["config", "submodule.recurse", "false"]).await;
        assert!(!submodule_recurse(&clone).await);
        git(&clone, &["config", "submodule.recurse", "sometimes"]).await;
        assert!(!submodule_recurse(&clone).await);
    }

    /// git refuses `file://` transport for submodule CLONE, and a repo-local
    /// `protocol.file.allow` does not lift it — only a command-line `-c` does
    /// (measured, git 2.51.1.windows.1). The fixture's own setup commands carry it;
    /// nothing under test needs it, because the clone already holds every object the
    /// parity step checks out.
    const ALLOW_FILE_SUBMODULE: &str = "protocol.file.allow=always";

    /// A superproject carrying one submodule, cloned so the clone is the repo under
    /// test: it has a local commit (so the guard has something to rebase) while
    /// upstream has moved the pointer to a second submodule commit. Returns the
    /// fixture guard, the clone, and that second submodule sha.
    ///
    /// Both submodule commits are pushed BEFORE anything clones, so the clone's
    /// submodule object store already holds the one the bump records.
    async fn submodule_fixture(marker: &str) -> (tempfile::TempDir, String, String) {
        let dir = temp(marker);
        let root = dir.path().to_string_lossy().into_owned();
        git(&root, &["init", "-q", "--bare", "-b", "main", "sub.git"]).await;
        git(&root, &["init", "-q", "--bare", "-b", "main", "super.git"]).await;
        let url = |name: &str| {
            format!(
                "file://{}",
                dir.path().join(name).to_string_lossy().replace('\\', "/")
            )
        };

        // The submodule's own upstream.
        git(&root, &["init", "-q", "-b", "main", "sub-work"]).await;
        let sub_dir = dir.path().join("sub-work");
        let sub = sub_dir.to_string_lossy().into_owned();
        configure(&sub).await;
        std::fs::write(sub_dir.join("s.txt"), "s1\n").unwrap();
        git(&sub, &["add", "-A"]).await;
        git(&sub, &["commit", "-qm", "s1"]).await;
        git(&sub, &["remote", "add", "origin", &url("sub.git")]).await;
        git(&sub, &["push", "-q", "-u", "origin", "main"]).await;
        let s1 = rev(&sub, "HEAD").await;
        std::fs::write(sub_dir.join("s.txt"), "s2\n").unwrap();
        git(&sub, &["commit", "-qam", "s2"]).await;
        git(&sub, &["push", "-q"]).await;
        let s2 = rev(&sub, "HEAD").await;

        // The superproject, recording the submodule at s1.
        git(&root, &["init", "-q", "-b", "main", "super-work"]).await;
        let work_dir = dir.path().join("super-work");
        let work = work_dir.to_string_lossy().into_owned();
        configure(&work).await;
        std::fs::write(work_dir.join("a.txt"), "base\n").unwrap();
        git(&work, &["add", "-A"]).await;
        git(&work, &["commit", "-qm", "base"]).await;
        git(
            &work,
            &[
                "-c",
                ALLOW_FILE_SUBMODULE,
                "submodule",
                "add",
                "-q",
                &url("sub.git"),
                "sub",
            ],
        )
        .await;
        let work_sub = work_dir.join("sub").to_string_lossy().into_owned();
        git(&work_sub, &["checkout", "-q", &s1]).await;
        git(&work, &["add", "sub"]).await;
        git(&work, &["commit", "-qm", "add the submodule"]).await;
        git(&work, &["remote", "add", "origin", &url("super.git")]).await;
        git(&work, &["push", "-q", "-u", "origin", "main"]).await;

        // The clone under test, plus a local commit so the guard has a rebase to run.
        git(
            &root,
            &[
                "-c",
                "core.autocrlf=false",
                "-c",
                ALLOW_FILE_SUBMODULE,
                "clone",
                "-q",
                "--recurse-submodules",
                &url("super.git"),
                "clone",
            ],
        )
        .await;
        let clone_dir = dir.path().join("clone");
        let clone = clone_dir.to_string_lossy().into_owned();
        configure(&clone).await;
        std::fs::write(clone_dir.join("mine.txt"), "mine\n").unwrap();
        git(&clone, &["add", "-A"]).await;
        git(&clone, &["commit", "-qm", "local commit"]).await;

        // Upstream moves the pointer to s2, leaving the clone's worktree behind.
        git(&work_sub, &["checkout", "-q", &s2]).await;
        git(&work, &["add", "sub"]).await;
        git(&work, &["commit", "-qm", "bump the submodule"]).await;
        git(&work, &["push", "-q"]).await;

        (dir, clone, s2)
    }

    /// `submodule.recurse=true` asks git to keep submodule worktrees in step with
    /// the pointer, which the guard's plain `git rebase` cannot do — `rebase` is not
    /// one of the commands that key enables `--recurse-submodules` for. The parity
    /// step is what moves the submodule after the superproject records it.
    #[tokio::test]
    async fn a_guarded_pull_updates_submodules_when_the_user_asked_for_it() {
        let (dir, clone, s2) = submodule_fixture("submodule-recurse").await;
        git(&clone, &["config", "submodule.recurse", "true"]).await;
        let sub = dir
            .path()
            .join("clone")
            .join("sub")
            .to_string_lossy()
            .into_owned();
        let before = rev(&sub, "HEAD").await;
        assert_ne!(before, s2, "the fixture must leave the submodule behind");

        let state = AppState::default();
        assert!(
            guarded_pull(&state, &clone)
                .await
                .expect("the guarded pull rebases cleanly"),
            "the guard must engage, or this test proves nothing"
        );

        assert_eq!(
            rev(&clone, "HEAD:sub").await,
            s2,
            "the superproject records the new submodule commit"
        );
        assert_eq!(
            rev(&sub, "HEAD").await,
            s2,
            "and the submodule worktree is checked out at it"
        );
    }

    /// Commit a submodule that can never be checked out — a gitlink whose object is
    /// absent and a URL git will not use — and register it, so the parity step fails
    /// deterministically and offline. `update-index --cacheinfo` accepts a gitlink
    /// with no local object, and the entry survives a `rebase --onto` (both measured,
    /// git 2.51.1.windows.1), which is what lets the failure land AFTER the rebase.
    ///
    /// Returns the new tip, since the extra commit moves HEAD past the one a decision
    /// fixture pinned.
    async fn commit_a_broken_submodule(repo: &str, dir: &std::path::Path) -> String {
        std::fs::write(
            dir.join(".gitmodules"),
            "[submodule \"brk\"]\n\tpath = brk\n\turl = file:///gd-no-such-submodule\n",
        )
        .unwrap();
        git(
            repo,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                "160000,0123456789012345678901234567890123456789,brk",
            ],
        )
        .await;
        git(repo, &["add", ".gitmodules"]).await;
        git(repo, &["commit", "-qm", "a submodule that cannot resolve"]).await;
        git(repo, &["submodule", "init"]).await;
        git(repo, &["config", "submodule.recurse", "true"]).await;
        rev(repo, "HEAD").await
    }

    /// The journal row and the returned result must never disagree. The rebase lands,
    /// the parity step then fails, and the record has to close on THAT verdict — a
    /// record settled before the step would show a green Done row for a call the
    /// caller saw fail.
    #[tokio::test]
    async fn a_submodule_failure_after_a_landed_rebase_journals_the_failure() {
        let (dir, clone, shas) = decided_fixture("submodule-step-fails").await;
        let expected_tip =
            commit_a_broken_submodule(&clone, &dir.path().join("clone")).await;

        let state = AppState::default();
        let err = git_pull_rebase_decided_core(
            &state,
            clone.clone(),
            "main".into(),
            "drop".into(),
            shas.new_tip,
            shas.keep_base,
            shas.drop_base,
            expected_tip,
        )
        .await
        .expect_err("the submodule step cannot resolve its gitlink");
        assert!(
            matches!(&err, AppError::Git { .. }),
            "the step's own failure reaches the caller: {err:?}"
        );

        // The rebase itself landed — this is a failure AFTER it, not instead of it.
        assert_eq!(
            log_subjects(&clone).await.get(1).map(String::as_str),
            Some("teammate rewrite"),
            "the drop replayed onto the rewritten upstream"
        );
        let entry = drop_entry(&clone).await;
        assert_eq!(entry.status, "failed", "the row agrees with the result");
        assert!(
            entry.error.is_some_and(|e| e.contains("brk")),
            "and it carries what actually stopped it"
        );
    }

    /// The fold's contract, driven directly. An integration fixture cannot reach it
    /// reliably: the conflicted pop leaves the index unmerged, and `git submodule
    /// update` then skips the submodules it would have to clone and exits 0
    /// (measured) — so the fixture version of this test passed without the fold ever
    /// running, which its negative control is what caught.
    #[test]
    fn a_submodule_failure_never_replaces_a_conflicted_reapply() {
        let boom = || AppError::Command("submodule brk exploded".into());

        let folded = fold_submodule_failure(
            Ok(AutostashOutcome::ReapplyConflicted {
                stderr: "pop conflicted on a.txt".into(),
                conflicted: true,
            }),
            Err(boom()),
        )
        .expect("the reapply report survives the failing step");
        let AutostashOutcome::ReapplyConflicted { stderr, conflicted } = folded else {
            panic!("the outcome must keep its variant");
        };
        assert!(conflicted, "and its discriminant");
        assert!(stderr.contains("pop conflicted on a.txt"), "{stderr}");
        assert!(stderr.contains("submodule brk exploded"), "{stderr}");

        // An outcome carrying nothing the error does not: the failure IS the result,
        // so it can never be swallowed.
        for outcome in [
            AutostashOutcome::Reapplied,
            AutostashOutcome::NothingStashed,
        ] {
            let err = fold_submodule_failure(Ok(outcome), Err(boom()))
                .expect_err("a failure with nothing to preserve is never swallowed");
            assert!(err.to_string().contains("submodule brk exploded"), "{err}");
        }

        // A clean step changes nothing.
        assert!(matches!(
            fold_submodule_failure(Ok(AutostashOutcome::Reapplied), Ok(())),
            Ok(AutostashOutcome::Reapplied)
        ));
    }

    /// The flip side: with `submodule.recurse` unset the guard must leave submodule
    /// worktrees where the user left them — a bare `git pull` does not recurse
    /// either, and that default is the whole reason the step is gated.
    #[tokio::test]
    async fn a_guarded_pull_leaves_submodules_alone_by_default() {
        let (dir, clone, s2) = submodule_fixture("submodule-default").await;
        let sub = dir
            .path()
            .join("clone")
            .join("sub")
            .to_string_lossy()
            .into_owned();
        let before = rev(&sub, "HEAD").await;

        let state = AppState::default();
        assert!(guarded_pull(&state, &clone)
            .await
            .expect("the guarded pull rebases cleanly"));

        assert_eq!(
            rev(&clone, "HEAD:sub").await,
            s2,
            "the pointer still moves — that is the rebase's own work"
        );
        assert_eq!(
            rev(&sub, "HEAD").await,
            before,
            "the worktree stays where the user left it"
        );
    }
}
