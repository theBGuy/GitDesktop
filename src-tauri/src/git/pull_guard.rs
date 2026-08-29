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
use crate::git::runner::{run_git, run_git_raw, DEFAULT_TIMEOUT, NETWORK_TIMEOUT};
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
/// The caller must already hold the repo lock, so every step here uses the
/// lock-free runners — `run_git_mutating*` would re-acquire it and deadlock.
pub(crate) async fn probe(
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
        let out = run_git_with_creds_once(repo, cred, &["fetch", &target.remote], NETWORK_TIMEOUT)
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

    let lock = state.repo_lock(repo).await;
    let _guard = lock.lock().await;
    // Re-read under the lock: `resolve` saw the tree before it, and another window
    // pausing a rebase in that gap would leave this one rebasing onto a conflict.
    if mid_op(repo).await {
        return Ok(false);
    }
    let Some(plan) = probe(repo, &target, &cred).await? else {
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

    let lock = state.repo_lock(repo).await;
    let _guard = lock.lock().await;
    crate::git::ops::refuse_mid_op(repo).await?;
    let Some(plan) = probe(repo, &target, &cred).await? else {
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
    settle(repo, "rebase", stashed, true, op).await.map(Some)
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
        Some(&decided.new_tip),
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

    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
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
    crate::oplog::finish(
        &repo_path,
        &op_id,
        result.as_ref().err().map(ToString::to_string),
    )
    .await;
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

    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
    crate::git::ops::refuse_mid_op(&repo_path).await?;
    ensure_on_expected_commit(&repo_path, &decided.branch, &expected_tip).await?;

    let op_id =
        begin_drop_journal(&repo_path, &decided, &keep_base, &drop_base, &expected_tip).await;
    let result = decided_autostash_run(&repo_path, &decided).await;
    crate::oplog::finish(&repo_path, &op_id, settled_journal_error(&result)).await;
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

    /// The destructive arm's conflict: dropping V still replays the local commit
    /// above it, which can collide. The journal entry the drop opened has to be
    /// closed — a record left `"pending"` would show up as an interrupted op on
    /// the next launch, offering recovery for a rebase the user is mid-resolve on.
    #[tokio::test]
    async fn decided_drop_that_conflicts_pauses_a_rebase_and_closes_its_record() {
        let (_dir, clone, shas) = colliding_fixture("drop-conflict", true).await;

        let state = AppState::default();
        let err = git_pull_rebase_decided_core(
            &state,
            clone.clone(),
            "main".into(),
            "drop".into(),
            shas.new_tip.clone(),
            shas.keep_base,
            shas.drop_base,
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

        let entry = crate::oplog::git_oplog_list(clone.clone())
            .await
            .expect("the journal must be readable")
            .into_iter()
            .find(|e| e.op == "pull_rebase_drop")
            .expect("a drop must be journaled even when it stops");
        // Recorded as failed rather than paused: the paused-op distinction the
        // sequencer commands draw is a separate question from this one.
        assert_eq!(entry.status, "failed");
        assert_eq!(entry.original_sha, shas.expected_tip);
        assert_eq!(entry.pre_op_tip.as_deref(), Some(shas.new_tip.as_str()));
        assert!(
            entry.error.is_some_and(|e| e.contains("a.txt")),
            "the record carries what stopped it"
        );
        assert!(
            crate::oplog::git_oplog_check(clone.clone())
                .await
                .unwrap()
                .is_empty(),
            "and it is no longer pending, so relaunch offers no recovery for it"
        );
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
}
