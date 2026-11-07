//! Native pull/merge request checkout: the PR's head is fetched into a transient
//! pinned ref (never FETCH_HEAD, which other fetches rewrite), then checked out with
//! the same git verbs the GitHub CLI's `pr checkout` runs.

use crate::error::{AppError, AppResult};
use crate::forge::model::Provider;
use crate::git::branches::{branch_tip_sha, current_branch_name, validate_ref_name};
use crate::git::remote::run_git_with_creds_once;
use crate::git::runner::{
    acquire_repo_lock, config_lock_busy, holder_label, is_config_lock_contention, run_git,
    run_git_config_write_held, run_git_raw, run_git_raw_index_retry, with_config_write_lock,
    GitOutput, RepoLockGuard, DEFAULT_TIMEOUT, LOCK_WAIT_TIMEOUT, NETWORK_LOCK_WAIT_TIMEOUT,
    NETWORK_TIMEOUT, WORKTREE_OP_TIMEOUT,
};
use crate::git::worktree::{
    changed_since_confirm, checkout_pre_spawn_gate_on, divergence_error,
    exclude_if_inside_gitdesktop, git_common_dir, is_ancestor, on_pr_branch, probe_worktree,
    refuse_ambiguous_worktree_path, refuse_ownerless_branch_namesake_on, request_noun,
    resolve_worktree_path, same_wt_path, stdout_path, worktree_path_arg, CheckoutMode,
};
use crate::github::pr::{
    force_mode, is_full_lowercase_oid, is_git_worktree_path_exists, refuse_session_head,
    validate_branch, worktree_not_empty_message,
};
use crate::state::AppState;

/// Where the PR's head is fetched from: a configured remote by name, or a Bitbucket
/// fork's HTTPS clone URL.
pub(crate) enum FetchFrom {
    Remote(&'static str),
    BitbucketUrl(String),
}

/// The ref the forge serves the PR's head under.
pub(crate) enum SourceRef {
    PullHead(u64),
    MergeRequestHead(u64),
    Branch(String),
}

/// One forge's answer to "what does this PR check out", forge-neutral. The head sha
/// is deliberately absent: the fetched tip is the authority.
pub(crate) struct PrCheckoutSource {
    /// Trimmed and non-empty.
    pub head: String,
    /// Drives the local name.
    pub fork: bool,
    /// True only on explicit same-repository evidence; gates upstream tracking.
    pub same_repo: bool,
    /// Trimmed and non-empty; None is an ownerless fork when `fork`.
    pub owner: Option<String>,
    pub from: FetchFrom,
    pub source_ref: SourceRef,
}

/// The local branch a PR checks out as: `<owner>/<head>` for a fork with a known
/// owner, else the bare head. The one composition every checkout route shares.
pub(crate) fn pr_local_branch_name(head: &str, fork: bool, owner: Option<&str>) -> String {
    match owner {
        Some(owner) if fork => format!("{owner}/{head}"),
        _ => head.to_string(),
    }
}

/// The one `refs/heads/` composition, validated first: the forge supplies the name.
fn qualified_head_ref(name: &str) -> AppResult<String> {
    validate_ref_name(name)?;
    Ok(format!("refs/heads/{name}"))
}

/// This process's transient pin for PR `number`. The pid keeps another app instance
/// or the MCP server, which hold other network locks, off the same ref.
fn pin_ref(number: u64) -> String {
    format!(
        "refs/gitdesktop/pr-checkout/{number}-{}",
        std::process::id()
    )
}

/// The forced refspec fetching the PR's head into its pin.
fn fetch_refspec(source: &SourceRef, number: u64) -> AppResult<String> {
    let src = match source {
        SourceRef::PullHead(n) => format!("refs/pull/{n}/head"),
        SourceRef::MergeRequestHead(n) => format!("refs/merge-requests/{n}/head"),
        SourceRef::Branch(name) => qualified_head_ref(name)?,
    };
    Ok(format!("+{src}:{}", pin_ref(number)))
}

/// A same-repo head's remote-tracking refspec, so the upstream the checkout writes
/// resolves instead of reading as gone.
fn tracking_refspec(remote: &'static str, head: &str) -> AppResult<String> {
    let src = qualified_head_ref(head)?;
    let dst = format!("refs/remotes/{remote}/{head}");
    Ok(format!("+{src}:{dst}"))
}

/// The plain checkout's forge. GitHub keeps `gh pr checkout`, and an unknown host may
/// be GitHub Enterprise, so neither is named.
fn plain_forge(p: Option<Provider>) -> AppResult<&'static str> {
    match p {
        Some(Provider::GitLab) => Ok("GitLab"),
        Some(Provider::Bitbucket) => Ok("Bitbucket"),
        Some(Provider::GitHub) | None => Err(AppError::InvalidArgument(
            "This checkout works for GitLab and Bitbucket repositories only.".into(),
        )),
    }
}

/// The worktree checkout's forge. An undetected provider (github.com, GitHub
/// Enterprise or an unknown host) takes the GitHub arm, which reads through gh.
fn worktree_forge(p: Option<Provider>) -> &'static str {
    match p {
        Some(Provider::GitLab) => "GitLab",
        Some(Provider::Bitbucket) => "Bitbucket",
        Some(Provider::GitHub) | None => "GitHub",
    }
}

/// The `-c` credential entries for the fetch: a remote's through the shared funnel,
/// a Bitbucket fork URL's through that funnel's Bitbucket arm.
async fn fetch_credentials(repo_path: &str, from: &FetchFrom) -> AppResult<Vec<String>> {
    match from {
        FetchFrom::Remote(remote) => {
            crate::forge::credential_config_for_remote(repo_path, remote).await
        }
        FetchFrom::BitbucketUrl(url) => {
            Ok(if crate::forge::bitbucket::seed_git_credential().await {
                crate::forge::bitbucket::bitbucket_credential_entries(url)
            } else {
                Vec::new()
            })
        }
    }
}

/// The checkout's names, refused before anything runs: the head and the local name
/// it composes, either of which an owner prefix can turn reserved.
fn checkout_names(src: &PrCheckoutSource) -> AppResult<String> {
    refuse_session_head(&src.head)?;
    validate_branch(&src.head)?;
    let local = pr_local_branch_name(&src.head, src.fork, src.owner.as_deref());
    refuse_session_head(&local)?;
    validate_branch(&local)?;
    Ok(local)
}

/// The one fetch argv: no tags, FETCH_HEAD neither read nor written, and an empty
/// `--refmap` so only the given refspecs write refs (no opportunistic remote-tracking
/// update, which a stale `refs/remotes/<r>/<head>/…` would block).
// `--no-write-fetch-head` needs git 2.29 (the exclude's `--path-format=absolute` 2.31);
// the app already warns below 2.38.
fn fetch_argv<'a>(from: &'a str, refspecs: &[&'a str]) -> Vec<&'a str> {
    let mut argv = vec![
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--refmap=",
        from,
    ];
    argv.extend_from_slice(refspecs);
    argv
}

/// A failed fetch's error: a missing remote ref says the PR's branch is gone.
fn fetch_failure(forge: &str, noun: &str, out: &GitOutput) -> AppError {
    let raw = out.full_failure_text();
    if out.stderr.contains("couldn't find remote ref") {
        return AppError::InvalidArgument(format!(
            "{forge} no longer has this {noun}'s branch, so there's nothing to check out.\n\n{raw}"
        ));
    }
    AppError::Git {
        code: out.code,
        stderr: raw,
    }
}

/// Fetches the PR's head into its pin under the network hold and returns the pinned
/// commit, plus whether the same-repo tracking ref was fetched beside it. Any failure
/// of that pair retries pin-only, untracked. The pin is deleted on every exit. `top` is
/// the open checkout's top level, read at the checkout's entry.
async fn fetch_pr_tip(
    state: &AppState,
    repo_path: &str,
    top: &str,
    number: u64,
    forge: &str,
    src: &PrCheckoutSource,
    cred: &[String],
) -> AppResult<(String, bool)> {
    let noun = request_noun(forge);
    let pin = pin_ref(number);
    let pin_spec = fetch_refspec(&src.source_ref, number)?;
    let (from, tracking) = match &src.from {
        FetchFrom::Remote(remote) if src.same_repo => {
            (*remote, Some(tracking_refspec(remote, &src.head)?))
        }
        FetchFrom::Remote(remote) => (*remote, None),
        FetchFrom::BitbucketUrl(url) => (url.as_str(), None),
    };
    let domain = state.network_lock(repo_path).await;
    let _hold =
        acquire_repo_lock(&domain, NETWORK_LOCK_WAIT_TIMEOUT, holder_label("fetch")).await?;
    // Narrowing only, deliberately not the admin lock (a long removal would hold every
    // fetch): a checkout unlinked since entry would fetch into the enclosing repository.
    refuse_unlinked(top, top).await?;
    let fetched = async {
        let pin_only = fetch_argv(from, &[&pin_spec]);
        let (out, tracked) = match &tracking {
            Some(spec) => {
                let pair = fetch_argv(from, &[&pin_spec, spec]);
                let out = run_git_with_creds_once(repo_path, cred, &pair, NETWORK_TIMEOUT).await?;
                if out.code == 0 {
                    (out, true)
                } else {
                    let out = run_git_with_creds_once(repo_path, cred, &pin_only, NETWORK_TIMEOUT)
                        .await?;
                    (out, false)
                }
            }
            None => (
                run_git_with_creds_once(repo_path, cred, &pin_only, NETWORK_TIMEOUT).await?,
                false,
            ),
        };
        if out.code != 0 {
            return Err(fetch_failure(forge, noun, &out));
        }
        let peeled = format!("{pin}^{{commit}}");
        let read = run_git_raw(
            Some(repo_path),
            &["rev-parse", "--verify", "--quiet", &peeled],
            DEFAULT_TIMEOUT,
        )
        .await?;
        let pr_tip = read.stdout_lossy().trim().to_string();
        if read.code != 0 || !is_full_lowercase_oid(&pr_tip) {
            return Err(AppError::Command(format!(
                "Couldn't read the {noun}'s fetched commit — try again."
            )));
        }
        Ok((pr_tip, tracked))
    }
    .await;
    let _ = run_git_raw(
        Some(repo_path),
        &["update-ref", "-d", &pin],
        DEFAULT_TIMEOUT,
    )
    .await;
    fetched
}

/// A raw run's non-zero exit as [`AppError::Git`] with both streams.
fn git_verdict(out: GitOutput) -> AppResult<GitOutput> {
    if out.code != 0 {
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    Ok(out)
}

/// Upstream tracking for a branch this checkout just CREATED, written only for a
/// proven same-repo PR whose remote-tracking ref was fetched. Config keys directly,
/// so the write never depends on a ref lookup; a failure discloses the partial state.
async fn track_new_branch(
    repo_path: &str,
    local: &str,
    src: &PrCheckoutSource,
    tracked: bool,
) -> AppResult<()> {
    let FetchFrom::Remote(remote) = &src.from else {
        return Ok(());
    };
    if !(src.same_repo && tracked) {
        return Ok(());
    }
    let merge = qualified_head_ref(&src.head)?;
    let remote_key = format!("branch.{local}.remote");
    let merge_key = format!("branch.{local}.merge");
    let out = with_config_write_lock(repo_path, |held| async move {
        let out = run_git_config_write_held(
            &held,
            repo_path,
            &["config", &remote_key, remote],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if out.code != 0 {
            return Ok(out);
        }
        run_git_config_write_held(
            &held,
            repo_path,
            &["config", &merge_key, &merge],
            DEFAULT_TIMEOUT,
        )
        .await
    })
    .await?;
    if out.code == 0 {
        return Ok(());
    }
    if is_config_lock_contention(&out.stderr) {
        return Err(config_lock_busy(&format!(
            "{local} was checked out without upstream tracking — set the upstream on {local} to finish."
        )));
    }
    git_verdict(out).map(|_| ())
}

/// The plain checkout into the open working tree, in gh's order: switch, then
/// fast-forward. An existing branch that has diverged from the PR is refused before
/// any write, and an existing branch's tracking config is never touched.
pub(crate) async fn plain_checkout_core(
    state: &AppState,
    repo_path: &str,
    number: u64,
    forge: &str,
    src: &PrCheckoutSource,
    cred: &[String],
) -> AppResult<()> {
    let local = checkout_names(src)?;
    crate::git::update_marker::refuse_if_branch_updating(state, repo_path, &local).await?;
    // The open checkout can itself be a linked worktree, so it takes the same hold and
    // `.git` checks as a target worktree; on a main checkout `.git` is a directory and
    // the check passes. Resolved at entry, while the checkout is still linked.
    let top = checkout_top(repo_path).await?;
    let (pr_tip, tracked) = fetch_pr_tip(state, repo_path, &top, number, forge, src, cred).await?;
    let noun = request_noun(forge);
    let _hold = hold_linked(state, repo_path, &top, holder_label("switch")).await?;
    // Under the hold, so the namesake verdict and the branch read below see one state.
    refuse_ownerless_branch_namesake_on(forge, repo_path, &src.head, &local, src.fork).await?;
    let Some(local_tip) = branch_tip_sha(repo_path, &local).await? else {
        refuse_unlinked(&top, &top).await?;
        let create = ["switch", "-c", local.as_str(), pr_tip.as_str()];
        git_verdict(run_git_raw_index_retry(repo_path, &create, DEFAULT_TIMEOUT).await?)?;
        return track_new_branch(repo_path, &local, src, tracked).await;
    };
    if !is_ancestor(repo_path, &local_tip, &pr_tip).await?
        && !is_ancestor(repo_path, &pr_tip, &local_tip).await?
    {
        return Err(AppError::InvalidArgument(format!(
            "Your branch {local} has commits that aren't on the {noun}'s branch, so it can't be updated to it — nothing was checked out."
        )));
    }
    let switched = current_branch_name(repo_path).await?.as_deref() != Some(local.as_str());
    if switched {
        refuse_unlinked(&top, &top).await?;
        let switch = ["switch", local.as_str()];
        git_verdict(run_git_raw_index_retry(repo_path, &switch, DEFAULT_TIMEOUT).await?)?;
    }
    refuse_unlinked(&top, &top).await?;
    let merge = [
        "merge",
        "--ff-only",
        "--no-overwrite-ignore",
        pr_tip.as_str(),
    ];
    let out = run_git_raw_index_retry(repo_path, &merge, DEFAULT_TIMEOUT).await?;
    if out.code == 0 {
        return Ok(());
    }
    if switched {
        return Err(AppError::Command(format!(
            "Switched to {local}, but couldn't fast-forward it to the {noun}.\n{}",
            out.full_failure_text()
        )));
    }
    git_verdict(out).map(|_| ())
}

/// The fast-forward re-sync of a worktree already on the PR's branch, its working-tree
/// lock held by the caller. Behind, equal and ahead all exit 0; a failure reports a
/// provable divergence, else git's own refusal.
async fn sync_held(
    repo_path: &str,
    echo_path: &str,
    wt: &str,
    local: &str,
    pr_tip: &str,
) -> AppResult<()> {
    refuse_unlinked(wt, echo_path).await?;
    let merge = ["merge", "--ff-only", "--no-overwrite-ignore", pr_tip];
    let out = run_git_raw_index_retry(wt, &merge, DEFAULT_TIMEOUT).await?;
    if out.code == 0 {
        return Ok(());
    }
    if let Ok(probe) = probe_worktree(repo_path, wt, Some(pr_tip)).await {
        if let Some(e) = probe.entry.as_ref().filter(|e| on_pr_branch(e, local)) {
            if let Some(diverged) = divergence_error(repo_path, echo_path, e, pr_tip).await {
                return Err(diverged);
            }
        }
    }
    git_verdict(out).map(|_| ())
}

/// The sync guard's refusal when the worktree left the PR's branch before its hold.
fn changed_during_checkout(echo_path: &str) -> AppError {
    AppError::InvalidArgument(format!(
        "The worktree at {echo_path} changed during the checkout, so it wasn't updated — run the checkout again."
    ))
}

/// The hold a mutation of a linked worktree runs under: the worktree-admin lock first,
/// which an in-process removal holds while it unlinks the worktree, then the
/// worktree's own working-tree lock. Both waits are bounded, so the nesting can't hang.
async fn hold_linked(
    state: &AppState,
    repo_path: &str,
    wt: &str,
    label: &'static str,
) -> AppResult<(RepoLockGuard, RepoLockGuard)> {
    let admin = state.worktree_admin_lock(repo_path).await;
    let admin = acquire_repo_lock(&admin, LOCK_WAIT_TIMEOUT, label).await?;
    let tree = state.working_tree_lock(wt).await;
    let tree = acquire_repo_lock(&tree, LOCK_WAIT_TIMEOUT, label).await?;
    Ok((admin, tree))
}

/// Whether `wt` still belongs to this repository: its git common dir is the repo's own,
/// so a clone swapped in with a matching branch and HEAD isn't mutated. A failed read
/// answers no.
async fn same_repository(repo_path: &str, wt: &str) -> bool {
    let theirs = run_git(
        Some(wt),
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        DEFAULT_TIMEOUT,
    )
    .await;
    let (Ok(theirs), Ok(ours)) = (theirs, git_common_dir(repo_path).await) else {
        return false;
    };
    let theirs = stdout_path(&theirs.stdout_lossy()).to_string();
    tokio::task::spawn_blocking(move || same_wt_path(&theirs, &ours))
        .await
        .unwrap_or(false)
}

/// The checkout's top-level folder, which holds its `.git` entry.
async fn checkout_top(repo_path: &str) -> AppResult<String> {
    let out = run_git(
        Some(repo_path),
        &["rev-parse", "--show-toplevel"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(stdout_path(&out.stdout_lossy()).to_string())
}

/// Fails closed when `wt` has lost its `.git` entry: git run in the orphaned folder
/// discovers the enclosing repository and would mutate its checkout instead.
async fn refuse_unlinked(wt: &str, echo_path: &str) -> AppResult<()> {
    match tokio::fs::symlink_metadata(std::path::Path::new(wt).join(".git")).await {
        Ok(_) => Ok(()),
        Err(_) => Err(changed_during_checkout(echo_path)),
    }
}

/// [`sync_held`] under [`hold_linked`], for a worktree whose branch was probed outside
/// it: the branch is re-read under the hold, so a switch in between never lands the
/// fast-forward on another branch.
async fn sync(
    state: &AppState,
    repo_path: &str,
    echo_path: &str,
    wt: &str,
    local: &str,
    pr_tip: &str,
) -> AppResult<()> {
    let _hold = hold_linked(state, repo_path, wt, holder_label("merge")).await?;
    if current_branch_name(wt).await.ok().flatten().as_deref() != Some(local)
        || !same_repository(repo_path, wt).await
    {
        return Err(changed_during_checkout(echo_path));
    }
    sync_held(repo_path, echo_path, wt, local, pr_tip).await
}

/// A `git worktree add`, a non-empty target folder rewritten as the app's sentence.
/// `minted` is the (branch, tip) a `-b` add creates, for a branch that didn't exist.
/// The open checkout's `.git` is checked inside the admin hold, which an in-process
/// removal shares: unlinked, git would add the worktree to the enclosing repository.
async fn worktree_add(
    state: &AppState,
    repo_path: &str,
    top: &str,
    path: &str,
    args: &[&str],
    minted: Option<(&str, &str)>,
) -> AppResult<()> {
    let domain = state.worktree_admin_lock(repo_path).await;
    let _admin = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a worktree operation").await?;
    refuse_unlinked(top, top).await?;
    match run_git(Some(repo_path), args, WORKTREE_OP_TIMEOUT).await {
        Err(AppError::Git { stderr, .. }) if stderr.lines().any(is_git_worktree_path_exists) => {
            // git mints `-b`'s branch before refusing the folder, so the refusal would leave
            // a stray branch that steals tracking from the next run. Old-value guarded: a
            // branch anything moved since is kept.
            if let Some((local, pr_tip)) = minted {
                if let Ok(full) = qualified_head_ref(local) {
                    let delete = ["update-ref", "-d", full.as_str(), pr_tip];
                    let _ = run_git_raw(Some(repo_path), &delete, DEFAULT_TIMEOUT).await;
                }
            }
            Err(AppError::InvalidArgument(worktree_not_empty_message(
                path, &stderr,
            )))
        }
        other => other.map(|_| ()),
    }
}

/// The confirmed forced reset: HEAD and branch are re-read under the worktree's lock,
/// and only a worktree still on `local` at `expected` is reset, to the fetched tip.
async fn force_reset(
    state: &AppState,
    repo_path: &str,
    echo_path: &str,
    resolved: &str,
    local: &str,
    expected: &str,
    pr_tip: &str,
) -> AppResult<()> {
    let probe = probe_worktree(repo_path, resolved, Some(pr_tip))
        .await
        .map_err(|_| changed_since_confirm(echo_path))?;
    let Some(e) = probe.entry.filter(|e| on_pr_branch(e, local)) else {
        return Err(changed_since_confirm(echo_path));
    };
    let wt = e.path.as_str();
    let _hold = hold_linked(state, repo_path, wt, holder_label("reset")).await?;
    let head = run_git_raw(Some(wt), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT).await?;
    let branch = current_branch_name(wt).await.ok().flatten();
    if head.code != 0 || head.stdout_lossy().trim() != expected || branch.as_deref() != Some(local)
    {
        return Err(changed_since_confirm(echo_path));
    }
    if !same_repository(repo_path, wt).await {
        return Err(changed_since_confirm(echo_path));
    }
    refuse_unlinked(wt, echo_path).await?;
    let reset = ["reset", "--hard", pr_tip];
    git_verdict(run_git_raw_index_retry(wt, &reset, DEFAULT_TIMEOUT).await?).map(|_| ())
}

/// The worktree checkout at `path` (the gated input spelling, run with cwd = repo), in
/// gh's re-run order: fetch, then the shared gate, then add, switch or fast-forward.
/// An existing branch that diverged lands in its worktree before `WorktreeDiverged`
/// returns, so the forced retry can reach it.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn worktree_checkout_core(
    state: &AppState,
    repo_path: &str,
    number: u64,
    forge: &str,
    src: &PrCheckoutSource,
    cred: &[String],
    path: &str,
    mode: CheckoutMode<'_>,
) -> AppResult<()> {
    let local = checkout_names(src)?;
    let resolved = resolve_worktree_path(repo_path, path);
    let expected = match mode {
        CheckoutMode::Force { expected } => Some(expected),
        CheckoutMode::Sync => None,
    };
    // The open checkout's own `.git` is re-checked before the writes made there (the
    // fetch, tracking config): unlinked, git would deliver them to the enclosing repo.
    let top = checkout_top(repo_path).await?;
    let (pr_tip, tracked) = fetch_pr_tip(state, repo_path, &top, number, forge, src, cred).await?;
    let pre = checkout_pre_spawn_gate_on(
        forge,
        repo_path,
        path,
        &resolved,
        Some(&pr_tip),
        &src.head,
        &local,
        src.fork,
        mode,
    )
    .await?;
    crate::git::update_marker::refuse_if_branch_updating_no_heal(state, repo_path, &local).await?;
    // Before the first write: a post-sync divergence below creates the worktree and
    // still returns Err.
    exclude_if_inside_gitdesktop(repo_path, &resolved).await;
    if let Some(expected) = expected {
        return force_reset(state, repo_path, path, &resolved, &local, expected, &pr_tip).await;
    }
    let Some(pre) = pre else {
        return Err(AppError::InvalidArgument(format!(
            "Couldn't check the worktree at {path} — try again."
        )));
    };
    // The gate cleared an ownerless fork only while its bare-named branch was absent;
    // finding it now means the user made one since, which this checkout must not adopt.
    let ownerless = src.fork && src.head == local;
    let Some(e) = pre.entry else {
        let exists = branch_tip_sha(repo_path, &local).await?.is_some();
        if exists && ownerless {
            return Err(changed_during_checkout(path));
        }
        if !exists {
            let add = [
                "worktree",
                "add",
                "-b",
                local.as_str(),
                path,
                pr_tip.as_str(),
            ];
            let minted = Some((local.as_str(), pr_tip.as_str()));
            worktree_add(state, repo_path, &top, path, &add, minted).await?;
            // Again for the tracking config write, which runs after the admin hold ends.
            refuse_unlinked(&top, &top).await?;
            return track_new_branch(repo_path, &local, src, tracked).await;
        }
        let add = ["worktree", "add", path, local.as_str()];
        worktree_add(state, repo_path, &top, path, &add, None).await?;
        return sync(state, repo_path, path, &resolved, &local, &pr_tip).await;
    };
    if on_pr_branch(&e, &local) {
        return sync(state, repo_path, path, &e.path, &local, &pr_tip).await;
    }
    // A linked worktree on another branch, or detached: gh switches it to the PR's.
    let wt = e.path.as_str();
    let _hold = hold_linked(state, repo_path, wt, holder_label("switch")).await?;
    // One compare re-gates the probe: the gate's main-checkout and namesake refusals
    // read only this worktree's branch, so an unchanged branch keeps their verdicts.
    let probed = (!e.detached).then(|| e.branch.clone());
    if current_branch_name(wt).await.ok() != Some(probed) || !same_repository(repo_path, wt).await {
        return Err(changed_during_checkout(path));
    }
    let exists = branch_tip_sha(repo_path, &local).await?.is_some();
    if exists && ownerless {
        return Err(changed_during_checkout(path));
    }
    refuse_unlinked(wt, path).await?;
    if exists {
        let switch = ["switch", local.as_str()];
        git_verdict(run_git_raw_index_retry(wt, &switch, DEFAULT_TIMEOUT).await?)?;
    } else {
        let create = ["switch", "-c", local.as_str(), pr_tip.as_str()];
        git_verdict(run_git_raw_index_retry(wt, &create, DEFAULT_TIMEOUT).await?)?;
        refuse_unlinked(&top, &top).await?;
        track_new_branch(repo_path, &local, src, tracked).await?;
    }
    sync_held(repo_path, path, wt, &local, &pr_tip).await
}

/// The forge's fresh source lookup. `lens` reaches only the GitHub arm, as the other
/// forges' PR views ignore it.
async fn checkout_source(
    repo_path: &str,
    number: u64,
    forge: &str,
    lens: Option<&str>,
) -> AppResult<PrCheckoutSource> {
    match forge {
        "GitLab" => crate::forge::gitlab::mr_checkout_source(repo_path, number).await,
        "Bitbucket" => crate::forge::bitbucket::pr_checkout_source(repo_path, number).await,
        _ => crate::github::pr::gh_pr_checkout_source(repo_path, number, lens).await,
    }
}

/// Checks a GitLab merge request or Bitbucket pull request out into the open working
/// tree without the GitHub CLI. `lens` is accepted for payload parity and ignored, as
/// those forges' PR views ignore it.
#[tauri::command]
pub async fn native_pr_checkout(
    state: tauri::State<'_, AppState>,
    repo_path: String,
    number: u64,
    lens: Option<String>,
) -> AppResult<()> {
    let _ = lens;
    let forge = plain_forge(
        crate::forge::detect_non_github(&repo_path)
            .await
            .map(|(p, _)| p),
    )?;
    let src = checkout_source(&repo_path, number, forge, None).await?;
    let cred = fetch_credentials(&repo_path, &src.from).await?;
    Box::pin(plain_checkout_core(
        &state, &repo_path, number, forge, &src, &cred,
    ))
    .await
}

/// Checks a PR out into a new or existing linked worktree at `path` without the GitHub
/// CLI's `pr checkout`, on the gh worktree command's contract: an existing worktree
/// re-syncs by fast-forward, a diverged one returns `WorktreeDiverged`, and only a
/// retry with `force` and the confirmed `expected_head` resets it.
#[tauri::command]
pub async fn native_pr_checkout_worktree(
    state: tauri::State<'_, AppState>,
    repo_path: String,
    number: u64,
    lens: Option<String>,
    path: String,
    force: bool,
    expected_head: Option<String>,
) -> AppResult<()> {
    let path = worktree_path_arg(&path)?;
    refuse_ambiguous_worktree_path(path, cfg!(windows))?;
    let mode = force_mode(force, expected_head.as_deref())?;
    let forge = worktree_forge(
        crate::forge::detect_non_github(&repo_path)
            .await
            .map(|(p, _)| p),
    );
    let src = checkout_source(&repo_path, number, forge, lens.as_deref()).await?;
    let cred = fetch_credentials(&repo_path, &src.from).await?;
    Box::pin(worktree_checkout_core(
        &state, &repo_path, number, forge, &src, &cred, path, mode,
    ))
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::worktree::diverged_message;

    async fn run(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap_or_else(|e| panic!("git {args:?} in {repo}: {e}"))
            .stdout_lossy()
    }

    async fn exit(repo: &str, args: &[&str]) -> i32 {
        run_git_raw(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .code
    }

    async fn rev(repo: &str, r: &str) -> String {
        run(repo, &["rev-parse", r]).await.trim().to_string()
    }

    async fn head_ref(repo: &str) -> String {
        run(repo, &["symbolic-ref", "HEAD"])
            .await
            .trim()
            .to_string()
    }

    /// HEAD's branch with exactly `refs/heads/` stripped.
    async fn on_branch(repo: &str) -> String {
        let full = head_ref(repo).await;
        full.strip_prefix("refs/heads/")
            .unwrap_or(&full)
            .to_string()
    }

    async fn heads(repo: &str) -> String {
        run(
            repo,
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/heads/",
            ],
        )
        .await
    }

    /// This process's pins left in `repo`.
    async fn own_pins(repo: &str) -> Vec<String> {
        let suffix = format!("-{}", std::process::id());
        run(
            repo,
            &["for-each-ref", "--format=%(refname)", "refs/gitdesktop/"],
        )
        .await
        .lines()
        .filter(|r| r.ends_with(&suffix))
        .map(str::to_string)
        .collect()
    }

    async fn ident(repo: &str) {
        run(repo, &["config", "user.email", "t@t.local"]).await;
        run(repo, &["config", "user.name", "T"]).await;
    }

    async fn commit(repo: &str, file: &str, content: &str, msg: &str) -> String {
        std::fs::write(std::path::Path::new(repo).join(file), content).unwrap();
        run(repo, &["add", "-A"]).await;
        run(repo, &["commit", "-qm", msg]).await;
        rev(repo, "HEAD").await
    }

    /// A bare `forge.git` (the clone's origin) and `fork.git`, both seeded with
    /// `main`; the PR head `feat` (one commit editing a.txt) is published on both and
    /// as forge.git's `refs/merge-requests/7/head`. The clone keeps no remote-tracking
    /// `feat`, so only the checkout's own fetch can write one.
    struct Fx {
        _dir: tempfile::TempDir,
        seed: String,
        forge: String,
        fork: String,
        clone: String,
        tip: String,
    }

    async fn forge_fixture(marker: &str) -> Fx {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-prc-{marker}-"))
            .tempdir()
            .expect("create temp dir");
        let p = |n: &str| dir.path().join(n).to_string_lossy().into_owned();
        let (root, seed, forge, fork, clone) =
            (p(""), p("seed"), p("forge.git"), p("fork.git"), p("clone"));
        std::fs::create_dir_all(&seed).unwrap();
        run(&seed, &["init", "-q", "-b", "main"]).await;
        ident(&seed).await;
        commit(&seed, "a.txt", "base\n", "seed").await;
        run(&root, &["clone", "-q", "--bare", &seed, &forge]).await;
        run(&root, &["clone", "-q", "--bare", &seed, &fork]).await;
        run(&seed, &["switch", "-q", "-c", "feat"]).await;
        let tip = commit(&seed, "a.txt", "pr one\n", "pr one").await;
        let fx = Fx {
            _dir: dir,
            seed,
            forge,
            fork,
            clone,
            tip,
        };
        publish(&fx).await;
        run(&root, &["clone", "-q", &fx.forge, &fx.clone]).await;
        ident(&fx.clone).await;
        run(&fx.clone, &["update-ref", "-d", "refs/remotes/origin/feat"]).await;
        fx
    }

    async fn publish(fx: &Fx) {
        run(
            &fx.seed,
            &[
                "push",
                "-q",
                "-f",
                &fx.forge,
                "feat:refs/heads/feat",
                "feat:refs/merge-requests/7/head",
                "feat:refs/pull/7/head",
            ],
        )
        .await;
        run(
            &fx.seed,
            &["push", "-q", "-f", &fx.fork, "feat:refs/heads/feat"],
        )
        .await;
    }

    /// The forge's PR head gains a commit; returns the new tip.
    async fn advance(fx: &Fx, file: &str) -> String {
        let tip = commit(&fx.seed, file, "more\n", "pr more").await;
        publish(fx).await;
        tip
    }

    #[derive(Clone, Copy, Debug)]
    enum Arm {
        Gl,
        Bb,
        Bbf,
        Gh,
    }

    fn source(
        head: &str,
        fork: bool,
        same_repo: bool,
        owner: Option<&str>,
        from: FetchFrom,
        source_ref: SourceRef,
    ) -> PrCheckoutSource {
        PrCheckoutSource {
            head: head.into(),
            fork,
            same_repo,
            owner: owner.map(str::to_string),
            from,
            source_ref,
        }
    }

    /// The arm's source for head `feat`, its forge and the local name it lands on.
    fn arm(fx: &Fx, a: Arm) -> (PrCheckoutSource, &'static str, &'static str) {
        match a {
            Arm::Gl => (gl("feat", false, None), "GitLab", "feat"),
            Arm::Bb => (
                source(
                    "feat",
                    false,
                    true,
                    None,
                    FetchFrom::Remote("origin"),
                    SourceRef::Branch("feat".into()),
                ),
                "Bitbucket",
                "feat",
            ),
            Arm::Bbf => (
                source(
                    "feat",
                    true,
                    false,
                    Some("alice"),
                    FetchFrom::BitbucketUrl(fx.fork.clone()),
                    SourceRef::Branch("feat".into()),
                ),
                "Bitbucket",
                "alice/feat",
            ),
            Arm::Gh => (gh("feat", false, true, None), "GitHub", "feat"),
        }
    }

    fn gh(head: &str, fork: bool, same_repo: bool, owner: Option<&str>) -> PrCheckoutSource {
        source(
            head,
            fork,
            same_repo,
            owner,
            FetchFrom::Remote("origin"),
            SourceRef::PullHead(7),
        )
    }

    fn gl(head: &str, fork: bool, owner: Option<&str>) -> PrCheckoutSource {
        source(
            head,
            fork,
            !fork,
            owner,
            FetchFrom::Remote("origin"),
            SourceRef::MergeRequestHead(7),
        )
    }

    async fn plain(fx: &Fx, forge: &str, src: &PrCheckoutSource) -> AppResult<()> {
        plain_checkout_core(&AppState::default(), &fx.clone, 7, forge, src, &[]).await
    }

    const ALL: [Arm; 3] = [Arm::Gl, Arm::Bb, Arm::Bbf];

    #[test]
    fn pr_local_branch_name_prefixes_only_a_fork_with_an_owner() {
        assert_eq!(pr_local_branch_name("feat", false, Some("alice")), "feat");
        assert_eq!(
            pr_local_branch_name("feat", true, Some("alice")),
            "alice/feat"
        );
        assert_eq!(pr_local_branch_name("feat", true, None), "feat");
        assert_eq!(
            pr_local_branch_name("feat", true, Some("grp/sub/proj")),
            "grp/sub/proj/feat"
        );
    }

    #[test]
    fn fetch_refspec_spells_each_source_into_the_pin() {
        // Concatenated, not formatted: the expected spellings stay plain literals.
        let pid = std::process::id().to_string();
        assert_eq!(
            fetch_refspec(&SourceRef::MergeRequestHead(7), 7).unwrap(),
            [
                "+refs/merge-requests/7/head:refs/gitdesktop/pr-checkout/7-",
                &pid
            ]
            .concat()
        );
        assert_eq!(
            fetch_refspec(&SourceRef::PullHead(7), 7).unwrap(),
            ["+refs/pull/7/head:refs/gitdesktop/pr-checkout/7-", &pid].concat()
        );
        assert_eq!(
            fetch_refspec(&SourceRef::Branch("feat/x".into()), 7).unwrap(),
            ["+refs/heads/feat/x:refs/gitdesktop/pr-checkout/7-", &pid].concat()
        );
        assert_eq!(qualified_head_ref("feat/x").unwrap(), "refs/heads/feat/x");
        for bad in [":x", "-x", "a*b", ""] {
            assert!(
                fetch_refspec(&SourceRef::Branch(bad.into()), 7).is_err(),
                "{bad}"
            );
            assert!(qualified_head_ref(bad).is_err(), "{bad}");
            assert!(tracking_refspec("origin", bad).is_err(), "{bad}");
        }
        assert_eq!(
            tracking_refspec("origin", "feat/x").unwrap(),
            "+refs/heads/feat/x:refs/remotes/origin/feat/x"
        );
    }

    #[test]
    fn plain_forge_refuses_github_and_unknown() {
        assert_eq!(plain_forge(Some(Provider::GitLab)).unwrap(), "GitLab");
        assert_eq!(plain_forge(Some(Provider::Bitbucket)).unwrap(), "Bitbucket");
        for p in [Some(Provider::GitHub), None] {
            let err = plain_forge(p).unwrap_err();
            assert!(matches!(err, AppError::InvalidArgument(_)));
            assert_eq!(
                err.to_string(),
                "invalid argument: This checkout works for GitLab and Bitbucket repositories only."
            );
        }
    }

    #[test]
    fn worktree_forge_maps_none_to_github() {
        assert_eq!(worktree_forge(Some(Provider::GitLab)), "GitLab");
        assert_eq!(worktree_forge(Some(Provider::Bitbucket)), "Bitbucket");
        assert_eq!(worktree_forge(Some(Provider::GitHub)), "GitHub");
        assert_eq!(worktree_forge(None), "GitHub");
    }

    /// T-P1: a fresh checkout lands on the local name at the fetched tip, leaves no
    /// pin and never touches FETCH_HEAD; a fork's prefix keeps the user's own `feat`.
    #[tokio::test]
    async fn plain_fresh_checkout_lands_on_the_pinned_tip() {
        for a in ALL {
            let fx = forge_fixture("p1").await;
            let (src, forge, local) = arm(&fx, a);
            let main = rev(&fx.clone, "HEAD").await;
            if matches!(a, Arm::Bbf) {
                run(&fx.clone, &["branch", "feat"]).await;
            }
            let fetch_head = std::path::Path::new(&fx.clone)
                .join(".git")
                .join("FETCH_HEAD");
            let bogus = format!("{main}\t\tbranch 'bogus' of nowhere\n");
            std::fs::write(&fetch_head, &bogus).unwrap();

            plain(&fx, forge, &src)
                .await
                .unwrap_or_else(|e| panic!("{a:?}: {e}"));

            assert_eq!(on_branch(&fx.clone).await, local, "{a:?}");
            assert_eq!(rev(&fx.clone, "HEAD").await, fx.tip, "{a:?}");
            assert!(own_pins(&fx.clone).await.is_empty(), "{a:?}");
            assert_eq!(
                std::fs::read_to_string(&fetch_head).unwrap(),
                bogus,
                "{a:?}"
            );
            if matches!(a, Arm::Bbf) {
                assert_eq!(rev(&fx.clone, "refs/heads/feat").await, main);
            }
        }
    }

    /// T-P2/T-P3: a re-run fast-forwards to the advanced tip, from the branch itself
    /// and from another branch (switched first).
    #[tokio::test]
    async fn plain_rerun_fast_forwards_current_and_switched() {
        for a in ALL {
            for from_main in [false, true] {
                let fx = forge_fixture("p2").await;
                let (src, forge, local) = arm(&fx, a);
                plain(&fx, forge, &src).await.unwrap();
                if from_main {
                    run(&fx.clone, &["switch", "-q", "main"]).await;
                }
                let tip = advance(&fx, "c.txt").await;
                plain(&fx, forge, &src)
                    .await
                    .unwrap_or_else(|e| panic!("{a:?} {from_main}: {e}"));
                assert_eq!(on_branch(&fx.clone).await, local);
                assert_eq!(rev(&fx.clone, "HEAD").await, tip, "{a:?} {from_main}");
                assert!(own_pins(&fx.clone).await.is_empty());
            }
        }
    }

    /// T-P4: a local branch with commits the PR lacks is refused before any write.
    #[tokio::test]
    async fn plain_diverged_branch_is_refused_unchanged() {
        for a in ALL {
            let fx = forge_fixture("p4").await;
            let (src, forge, local) = arm(&fx, a);
            plain(&fx, forge, &src).await.unwrap();
            commit(&fx.clone, "mine.txt", "mine\n", "mine").await;
            run(&fx.clone, &["switch", "-q", "main"]).await;
            advance(&fx, "c.txt").await;
            let before = heads(&fx.clone).await;

            let err = plain(&fx, forge, &src).await.unwrap_err();
            let noun = request_noun(forge);
            assert!(
                matches!(err, AppError::InvalidArgument(_)),
                "{a:?}: {err:?}"
            );
            assert!(
                err.to_string().contains(&format!(
                    "Your branch {local} has commits that aren't on the {noun}'s branch"
                )),
                "{a:?}: {err}"
            );
            assert_eq!(heads(&fx.clone).await, before, "{a:?}");
            assert_eq!(head_ref(&fx.clone).await, "refs/heads/main", "{a:?}");
            assert!(own_pins(&fx.clone).await.is_empty());
        }
    }

    /// T-P5: an ownerless fork refuses while a bare-named branch exists, any case.
    #[tokio::test]
    async fn plain_ownerless_fork_refuses_a_bare_namesake() {
        for existing in ["feat", "Feat"] {
            let fx = forge_fixture("p5").await;
            run(&fx.clone, &["branch", existing]).await;
            let before = heads(&fx.clone).await;
            let err = plain(&fx, "GitLab", &gl("feat", true, None))
                .await
                .unwrap_err();
            assert_eq!(
                err.to_string(),
                "invalid argument: A branch named feat already exists and may be your own: GitLab no longer names this merge request's fork, so its branch can't be told apart from yours — nothing was checked out."
            );
            assert_eq!(heads(&fx.clone).await, before);
            assert_eq!(head_ref(&fx.clone).await, "refs/heads/main");
            assert!(own_pins(&fx.clone).await.is_empty());
        }
    }

    /// T-P6: a reserved head, or an owner prefix spelling one, is refused before the
    /// fetch.
    #[tokio::test]
    async fn plain_reserved_names_refuse_before_the_fetch() {
        let fx = forge_fixture("p6").await;
        let before = heads(&fx.clone).await;
        let bb = |head: &str, fork: bool, owner: Option<&str>| {
            source(
                head,
                fork,
                !fork,
                owner,
                FetchFrom::Remote("origin"),
                SourceRef::Branch(head.into()),
            )
        };
        for (forge, src) in [
            ("GitLab", gl("gd/session/x", false, None)),
            ("GitLab", gl("session/x", true, Some("gd"))),
            ("Bitbucket", bb("gd/session/x", false, None)),
            ("Bitbucket", bb("session/x", true, Some("gd"))),
        ] {
            let err = plain(&fx, forge, &src).await.unwrap_err();
            assert!(
                err.to_string().contains("reserved for agent sessions"),
                "{forge} {}: {err}",
                src.head
            );
            assert_eq!(heads(&fx.clone).await, before);
            assert!(own_pins(&fx.clone).await.is_empty());
            assert_eq!(
                exit(
                    &fx.clone,
                    &[
                        "rev-parse",
                        "--verify",
                        "--quiet",
                        "refs/remotes/origin/feat"
                    ]
                )
                .await,
                1
            );
        }
    }

    /// T-P7: a dirty file the switch would overwrite is git's refusal; nothing moves.
    #[tokio::test]
    async fn plain_dirty_overlap_is_gits_refusal() {
        let fx = forge_fixture("p7").await;
        let a_txt = std::path::Path::new(&fx.clone).join("a.txt");
        std::fs::write(&a_txt, "local edit\n").unwrap();
        let before = heads(&fx.clone).await;
        let err = plain(&fx, "GitLab", &gl("feat", false, None))
            .await
            .unwrap_err();
        assert!(matches!(err, AppError::Git { .. }), "{err:?}");
        assert_eq!(head_ref(&fx.clone).await, "refs/heads/main");
        assert_eq!(heads(&fx.clone).await, before);
        assert_eq!(std::fs::read_to_string(&a_txt).unwrap(), "local edit\n");
    }

    /// T-P9: an update holding the local branch refuses before the fetch or switch.
    // The serializing guard MUST span the awaits: it keeps the process-wide root
    // override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn plain_refuses_while_an_update_holds_the_branch() {
        use crate::git::update_marker as marker;
        let fx = forge_fixture("p9").await;
        let root = std::path::Path::new(&fx.clone)
            .parent()
            .unwrap()
            .join("gd-worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        let _live = marker::UpdateMarker::create_for(
            &root.join("gd-update-live"),
            "pr-checkout-update-holder",
        )
        .expect("the marker mints");

        let src = gl("pr-checkout-update-holder", false, None);
        let err = plain(&fx, "GitLab", &src).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            marker::branch_update_refusal("pr-checkout-update-holder").to_string()
        );
        assert_eq!(head_ref(&fx.clone).await, "refs/heads/main");
        assert!(own_pins(&fx.clone).await.is_empty());
        assert_eq!(
            exit(
                &fx.clone,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    "refs/remotes/origin/pr-checkout-update-holder"
                ]
            )
            .await,
            1
        );
    }

    async fn config(repo: &str, key: &str) -> (i32, String) {
        let out = run_git_raw(Some(repo), &["config", "--get", key], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        (out.code, out.stdout_lossy().trim().to_string())
    }

    /// T-T1 (plain): only a proven same-repo creation gets an upstream, and its
    /// remote-tracking ref exists so the upstream isn't gone.
    #[tokio::test]
    async fn tracking_is_set_only_for_same_repo_creations() {
        for a in ALL {
            let fx = forge_fixture("t1").await;
            let (src, forge, local) = arm(&fx, a);
            plain(&fx, forge, &src).await.unwrap();
            let remote = config(&fx.clone, &format!("branch.{local}.remote")).await;
            if matches!(a, Arm::Bbf) {
                assert_eq!(remote.0, 1, "{a:?}: no upstream for a cross-repo branch");
                assert_eq!(
                    exit(
                        &fx.clone,
                        &[
                            "rev-parse",
                            "--verify",
                            "--quiet",
                            "refs/remotes/origin/alice/feat"
                        ]
                    )
                    .await,
                    1
                );
                continue;
            }
            assert_eq!(remote, (0, "origin".into()), "{a:?}");
            let merge = config(&fx.clone, &format!("branch.{local}.merge")).await;
            assert_eq!(merge, (0, "refs/heads/feat".into()), "{a:?}");
            assert_eq!(rev(&fx.clone, "refs/remotes/origin/feat").await, fx.tip);
            let track = run(
                &fx.clone,
                &[
                    "for-each-ref",
                    "--format=%(upstream:track)",
                    "refs/heads/feat",
                ],
            )
            .await;
            assert!(!track.contains("gone"), "{a:?}: {track}");
        }

        // A GitLab cross-project branch: no upstream, no remote-tracking ref of its name.
        let fx = forge_fixture("t1x").await;
        let src = gl("feat", true, Some("grp/sub/proj"));
        plain(&fx, "GitLab", &src).await.unwrap();
        assert_eq!(head_ref(&fx.clone).await, "refs/heads/grp/sub/proj/feat");
        assert_eq!(
            config(&fx.clone, "branch.grp/sub/proj/feat.remote").await.0,
            1
        );
        assert_eq!(
            exit(
                &fx.clone,
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    "refs/remotes/origin/feat"
                ]
            )
            .await,
            1
        );

        // A pre-existing branch's config is never touched by a re-run.
        let fx = forge_fixture("t1e").await;
        run(&fx.clone, &["branch", "feat", "main"]).await;
        plain(&fx, "GitLab", &gl("feat", false, None))
            .await
            .unwrap();
        assert_eq!(rev(&fx.clone, "HEAD").await, fx.tip);
        assert_eq!(config(&fx.clone, "branch.feat.remote").await.0, 1);

        worktree_tracking_rows().await;
    }

    /// T-T1's worktree-flavor rows.
    async fn worktree_tracking_rows() {
        for a in [Arm::Gl, Arm::Bb, Arm::Gh] {
            let fx = forge_fixture("wt1").await;
            let (src, forge, local) = arm(&fx, a);
            let path = beside(&fx, "wt");
            wt(&fx, forge, &src, &path, None).await.unwrap();
            let key = |k: &str| format!("branch.{local}.{k}");
            assert_eq!(
                config(&fx.clone, &key("remote")).await,
                (0, "origin".into()),
                "{a:?}"
            );
            assert_eq!(
                config(&fx.clone, &key("merge")).await,
                (0, "refs/heads/feat".into()),
                "{a:?}"
            );
            assert_eq!(rev(&fx.clone, "refs/remotes/origin/feat").await, fx.tip);
            let track = run(
                &fx.clone,
                &[
                    "for-each-ref",
                    "--format=%(upstream:track)",
                    "refs/heads/feat",
                ],
            )
            .await;
            assert!(!track.contains("gone"), "{a:?}: {track}");
        }

        // Cross-repo creations, and a GitHub PR whose cross-repository flag is absent
        // (named bare, never proven same-repo): no upstream, no remote-tracking ref.
        let fx = forge_fixture("wt1x").await;
        let cases = [
            (
                "GitLab",
                gl("feat", true, Some("grp/sub/proj")),
                "grp/sub/proj/feat",
            ),
            ("Bitbucket", arm(&fx, Arm::Bbf).0, "alice/feat"),
            (
                "GitHub",
                gh("feat", true, false, Some("alice")),
                "alice/feat",
            ),
            ("GitHub", gh("feat", false, false, None), "feat"),
        ];
        for (i, (forge, src, local)) in cases.into_iter().enumerate() {
            let path = beside(&fx, &format!("wt{i}"));
            wt(&fx, forge, &src, &path, None)
                .await
                .unwrap_or_else(|e| panic!("{forge} {local}: {e}"));
            assert_eq!(on_branch(&path).await, local);
            assert_eq!(rev(&path, "HEAD").await, fx.tip);
            let remote = config(&fx.clone, &format!("branch.{local}.remote")).await;
            assert_eq!(remote.0, 1, "{forge} {local}");
            for r in [
                "refs/remotes/origin/feat",
                &format!("refs/remotes/origin/{local}"),
            ] {
                let found = exit(&fx.clone, &["rev-parse", "--verify", "--quiet", r]).await;
                assert_eq!(found, 1, "{forge} {local}: {r}");
            }
            run(&fx.clone, &["worktree", "remove", "--force", &path]).await;
            run(&fx.clone, &["branch", "-D", local]).await;
        }

        // A same-repo GitHub PR whose head branch is deleted: the pin-only retry checks
        // out refs/pull/7/head, untracked.
        let fx = forge_fixture("wt1d").await;
        run(&fx.forge, &["update-ref", "-d", "refs/heads/feat"]).await;
        let path = beside(&fx, "wt");
        wt(&fx, "GitHub", &gh("feat", false, true, None), &path, None)
            .await
            .unwrap();
        assert_eq!(rev(&path, "HEAD").await, fx.tip);
        assert_eq!(config(&fx.clone, "branch.feat.remote").await.0, 1);
        assert!(own_pins(&fx.clone).await.is_empty());

        // An existing branch checked out into a new folder keeps its config untouched.
        let fx = forge_fixture("wt1e").await;
        run(&fx.clone, &["branch", "feat", "main"]).await;
        let path = beside(&fx, "wt");
        wt(&fx, "GitLab", &gl("feat", false, None), &path, None)
            .await
            .unwrap();
        assert_eq!(rev(&path, "HEAD").await, fx.tip);
        assert_eq!(config(&fx.clone, "branch.feat.remote").await.0, 1);
    }

    /// T-PIN: every exit of the fetch block leaves no pin of this process, and a
    /// foreign process's pin is never touched.
    #[tokio::test]
    async fn fetch_block_exits_leave_no_own_pin() {
        let src = gl("feat", false, None);
        let pin = pin_ref(7);

        // (a) the remote can't be reached.
        let fx = forge_fixture("pin-a").await;
        let missing = std::path::Path::new(&fx.forge).with_extension("missing");
        let missing = missing.to_string_lossy();
        run(&fx.clone, &["config", "remote.origin.url", &missing]).await;
        let err = plain(&fx, "GitLab", &src).await.unwrap_err();
        assert!(matches!(err, AppError::Git { .. }), "(a) {err:?}");
        assert!(own_pins(&fx.clone).await.is_empty(), "(a)");

        // (b) a stale own pin from a crashed run, and the PR's ref is gone.
        let fx = forge_fixture("pin-b").await;
        let main = rev(&fx.clone, "HEAD").await;
        run(&fx.clone, &["update-ref", &pin, &main]).await;
        run(
            &fx.forge,
            &["update-ref", "-d", "refs/merge-requests/7/head"],
        )
        .await;
        let err = plain(&fx, "GitLab", &src).await.unwrap_err();
        assert!(matches!(err, AppError::InvalidArgument(_)), "(b) {err:?}");
        assert!(
            err.to_string()
                .contains("GitLab no longer has this merge request's branch, so there's nothing to check out."),
            "(b) {err}"
        );
        assert!(
            err.to_string().contains("couldn't find remote ref"),
            "(b) {err}"
        );
        assert!(own_pins(&fx.clone).await.is_empty(), "(b)");

        // (c) the source ref names a tree, so the pin peels to no commit.
        let fx = forge_fixture("pin-c").await;
        let tree = rev(&fx.forge, "main^{tree}").await;
        run(
            &fx.forge,
            &["update-ref", "refs/merge-requests/7/head", &tree],
        )
        .await;
        let err = plain(&fx, "GitLab", &src).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            "Couldn't read the merge request's fetched commit — try again.",
            "(c) {err:?}"
        );
        assert!(own_pins(&fx.clone).await.is_empty(), "(c)");

        // (d) another process's pin of the same PR is left byte-identical.
        let fx = forge_fixture("pin-d").await;
        let main = rev(&fx.clone, "HEAD").await;
        let foreign = format!("refs/gitdesktop/pr-checkout/7-{}", std::process::id() + 1);
        run(&fx.clone, &["update-ref", &foreign, &main]).await;
        plain(&fx, "GitLab", &src).await.unwrap();
        assert_eq!(rev(&fx.clone, "HEAD").await, fx.tip, "(d)");
        assert_eq!(rev(&fx.clone, &foreign).await, main, "(d)");
        assert!(own_pins(&fx.clone).await.is_empty(), "(d)");

        // (e) a stale `origin/feat/x` blocks the tracking ref: the pin-only retry
        // checks out untracked.
        let fx = forge_fixture("pin-e").await;
        let main = rev(&fx.clone, "HEAD").await;
        run(
            &fx.clone,
            &["update-ref", "refs/remotes/origin/feat/x", &main],
        )
        .await;
        plain(&fx, "GitLab", &src).await.unwrap();
        assert_eq!(rev(&fx.clone, "HEAD").await, fx.tip, "(e)");
        assert_eq!(config(&fx.clone, "branch.feat.remote").await.0, 1, "(e)");
        assert!(own_pins(&fx.clone).await.is_empty(), "(e)");

        // (e) on the GitHub worktree arm.
        let fx = forge_fixture("pin-eg").await;
        let main = rev(&fx.clone, "HEAD").await;
        run(
            &fx.clone,
            &["update-ref", "refs/remotes/origin/feat/x", &main],
        )
        .await;
        let path = beside(&fx, "wt");
        wt(&fx, "GitHub", &gh("feat", false, true, None), &path, None)
            .await
            .unwrap();
        assert_eq!(rev(&path, "HEAD").await, fx.tip, "(e) gh");
        assert_eq!(config(&fx.clone, "branch.feat.remote").await.0, 1, "(e) gh");
        assert!(own_pins(&fx.clone).await.is_empty(), "(e) gh");

        // (e) on a Bitbucket same-repo PR, whose source IS refs/heads/feat.
        let fx = forge_fixture("pin-eb").await;
        let main = rev(&fx.clone, "HEAD").await;
        run(
            &fx.clone,
            &["update-ref", "refs/remotes/origin/feat/x", &main],
        )
        .await;
        let (src, forge, _) = arm(&fx, Arm::Bb);
        plain(&fx, forge, &src)
            .await
            .unwrap_or_else(|e| panic!("(e) bb: {e}"));
        assert_eq!(rev(&fx.clone, "HEAD").await, fx.tip, "(e) bb");
        assert_eq!(config(&fx.clone, "branch.feat.remote").await.0, 1, "(e) bb");
        assert!(own_pins(&fx.clone).await.is_empty(), "(e) bb");
    }

    /// T-W12 (plain): a deleted head on a same-repo Bitbucket PR names the forge.
    #[tokio::test]
    async fn plain_missing_remote_ref_names_the_forge() {
        let fx = forge_fixture("w12p").await;
        let (src, forge, _) = arm(&fx, Arm::Bb);
        run(&fx.forge, &["update-ref", "-d", "refs/heads/feat"]).await;
        let err = plain(&fx, forge, &src).await.unwrap_err();
        assert!(
            err.to_string()
                .contains("Bitbucket no longer has this pull request's branch"),
            "{err}"
        );
        assert!(own_pins(&fx.clone).await.is_empty());
    }

    /// A path beside the clone, outside the repository.
    fn beside(fx: &Fx, name: &str) -> String {
        std::path::Path::new(&fx.clone)
            .parent()
            .unwrap()
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    async fn wt(
        fx: &Fx,
        forge: &str,
        src: &PrCheckoutSource,
        path: &str,
        expected: Option<&str>,
    ) -> AppResult<()> {
        wt_on(&AppState::default(), fx, forge, src, path, expected).await
    }

    async fn wt_on(
        state: &AppState,
        fx: &Fx,
        forge: &str,
        src: &PrCheckoutSource,
        path: &str,
        expected: Option<&str>,
    ) -> AppResult<()> {
        let mode = force_mode(expected.is_some(), expected)?;
        worktree_checkout_core(state, &fx.clone, 7, forge, src, &[], path, mode).await
    }

    /// Drops the exclude line, so the next checkout into `.gitdesktop/worktrees/`
    /// re-appends it: the last step before the checkout takes its worktree's lock.
    fn clear_exclude(fx: &Fx) -> std::path::PathBuf {
        let exclude = std::path::Path::new(&fx.clone).join(".git/info/exclude");
        let kept: String = std::fs::read_to_string(&exclude)
            .unwrap_or_default()
            .lines()
            .filter(|l| *l != "/.gitdesktop/worktrees/")
            .map(|l| format!("{l}\n"))
            .collect();
        std::fs::write(&exclude, kept).unwrap();
        exclude
    }

    /// Holds `wt`'s working-tree lock until the checkout has re-appended the exclude
    /// line and had time to queue on the lock, then runs `mutate` and releases. The
    /// delay only weakens the pin under load (an early mutation is refused anyway).
    async fn mutate_under_hold(
        state: &AppState,
        wt: &str,
        exclude: &std::path::Path,
        mutate: impl std::future::Future<Output = ()>,
    ) {
        let domain = state.working_tree_lock(wt).await;
        let _hold = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a test hold")
            .await
            .unwrap();
        after_exclude(exclude, mutate).await;
    }

    /// [`mutate_under_hold`] over the repository's worktree-admin lock, the one a
    /// removal holds.
    async fn mutate_under_admin(
        state: &AppState,
        repo: &str,
        exclude: &std::path::Path,
        mutate: impl std::future::Future<Output = ()>,
    ) {
        let domain = state.worktree_admin_lock(repo).await;
        let _hold = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a test removal")
            .await
            .unwrap();
        after_exclude(exclude, mutate).await;
    }

    /// Waits for the checkout's exclude line, then a margin for it to queue, then mutates.
    async fn after_exclude(
        exclude: &std::path::Path,
        mutate: impl std::future::Future<Output = ()>,
    ) {
        after_signal(
            || {
                let text = std::fs::read_to_string(exclude).unwrap_or_default();
                text.lines().any(|l| l == "/.gitdesktop/worktrees/")
            },
            mutate,
        )
        .await;
    }

    async fn after_signal(
        signal: impl Fn() -> bool,
        mutate: impl std::future::Future<Output = ()>,
    ) {
        let mut seen = false;
        for _ in 0..600 {
            if signal() {
                seen = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert!(seen, "the checkout never reached its signal step");
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        mutate.await;
    }

    /// The worktree flavor from an open checkout unlinked while its fetch waits on the
    /// network lock: refused before the fetch, so no pin or remote-tracking ref lands and
    /// no worktree is added. No file signal precedes that lock, so the 1.5 s margin alone
    /// covers the checkout reaching it (its entry steps are a single git read).
    #[tokio::test]
    async fn an_unlinked_open_checkout_is_refused_before_the_fetch() {
        let fx = forge_fixture("lk-fetch").await;
        let open = std::path::Path::new(&fx.clone)
            .join(".gitdesktop/worktrees/open")
            .to_string_lossy()
            .into_owned();
        run(
            &fx.clone,
            &["worktree", "add", "-q", "-b", "other", &open, "main"],
        )
        .await;
        let target = beside(&fx, "wt");
        let state = AppState::default();
        let src = gl("feat", false, None);
        let mode = force_mode(false, None).unwrap();
        let (got, ()) = tokio::join!(
            worktree_checkout_core(&state, &open, 7, "GitLab", &src, &[], &target, mode),
            async {
                let domain = state.network_lock(&fx.clone).await;
                let _hold = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a test fetch")
                    .await
                    .unwrap();
                after_signal(|| true, async {
                    std::fs::remove_file(std::path::Path::new(&open).join(".git")).unwrap();
                })
                .await;
            }
        );
        let err = got.unwrap_err();
        assert!(
            err.to_string().contains("changed during the checkout"),
            "{err}"
        );
        assert!(own_pins(&fx.clone).await.is_empty());
        let tracking = [
            "rev-parse",
            "--verify",
            "--quiet",
            "refs/remotes/origin/feat",
        ];
        assert_eq!(exit(&fx.clone, &tracking).await, 1);
        assert!(!std::path::Path::new(&target).exists());
    }

    /// The plain flavor in an open checkout that is itself a nested linked worktree: a
    /// removal's unlink while the checkout waits is refused, and the parent checkout is
    /// never switched. The fetched tracking ref is the signal that it is past its fetch.
    #[tokio::test]
    async fn plain_in_an_unlinked_worktree_never_mutates_the_parent() {
        let fx = forge_fixture("lk-plain").await;
        let open = std::path::Path::new(&fx.clone)
            .join(".gitdesktop/worktrees/open")
            .to_string_lossy()
            .into_owned();
        run(
            &fx.clone,
            &["worktree", "add", "-q", "-b", "other", &open, "main"],
        )
        .await;
        let a_before = read(&fx.clone, "a.txt");
        let tracking = std::path::Path::new(&fx.clone).join(".git/refs/remotes/origin/feat");
        let state = AppState::default();
        let src = gl("feat", false, None);
        let (got, ()) = tokio::join!(
            plain_checkout_core(&state, &open, 7, "GitLab", &src, &[]),
            async {
                let domain = state.worktree_admin_lock(&fx.clone).await;
                let _hold = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a test removal")
                    .await
                    .unwrap();
                after_signal(|| tracking.exists(), async {
                    std::fs::remove_file(std::path::Path::new(&open).join(".git")).unwrap();
                })
                .await;
            }
        );
        let err = got.unwrap_err();
        assert!(
            err.to_string().contains("changed during the checkout"),
            "{err}"
        );
        assert_eq!(head_ref(&fx.clone).await, "refs/heads/main");
        assert_eq!(read(&fx.clone, "a.txt"), a_before);
        let feat = ["rev-parse", "--verify", "--quiet", "refs/heads/feat"];
        assert_eq!(exit(&fx.clone, &feat).await, 1);
    }

    /// The sync guard: a worktree switched off the PR's branch while the re-run waits
    /// on its lock is refused, and the other branch is never fast-forwarded.
    #[tokio::test]
    async fn sync_rereads_the_branch_under_its_hold() {
        let rel = ".gitdesktop/worktrees/pr-7";
        let fx = forge_fixture("lk-sync").await;
        let src = gl("feat", false, None);
        wt(&fx, "GitLab", &src, rel, None).await.unwrap();
        let path = std::path::Path::new(&fx.clone)
            .join(rel)
            .to_string_lossy()
            .into_owned();
        advance(&fx, "c.txt").await;
        let exclude = clear_exclude(&fx);
        let state = AppState::default();
        let (got, ()) = tokio::join!(
            wt_on(&state, &fx, "GitLab", &src, rel, None),
            mutate_under_hold(&state, &path, &exclude, async {
                run(&path, &["switch", "-q", "-c", "other"]).await;
            })
        );
        assert_eq!(
            got.unwrap_err().to_string(),
            changed_during_checkout(rel).to_string()
        );
        assert_eq!(on_branch(&path).await, "other");
        assert_eq!(rev(&path, "refs/heads/other").await, fx.tip);
    }

    /// The switch guard: a worktree switched to the user's own bare `feat`, or a bare
    /// `feat` made for an ownerless fork, while the checkout waits on the worktree's lock
    /// is refused, and the worktree is never moved.
    #[tokio::test]
    async fn switch_rereads_the_branch_under_its_hold() {
        let rel = ".gitdesktop/worktrees/pr-7";
        // Some: the worktree is switched to the user's `feat`; None (ownerless fork): the
        // user creates a bare `feat` in the repository.
        for owner in [Some("alice"), None] {
            let fx = forge_fixture("lk-switch").await;
            let path = std::path::Path::new(&fx.clone)
                .join(rel)
                .to_string_lossy()
                .into_owned();
            run(
                &fx.clone,
                &["worktree", "add", "-q", "-b", "other", &path, "main"],
            )
            .await;
            let exclude = clear_exclude(&fx);
            let src = gh("feat", true, false, owner);
            let state = AppState::default();
            let (got, ()) = tokio::join!(
                wt_on(&state, &fx, "GitHub", &src, rel, None),
                mutate_under_hold(&state, &path, &exclude, async {
                    match owner {
                        Some(_) => run(&path, &["switch", "-q", "-c", "feat"]).await,
                        None => run(&fx.clone, &["branch", "feat", "main"]).await,
                    };
                })
            );
            assert_eq!(
                got.unwrap_err().to_string(),
                changed_during_checkout(rel).to_string(),
                "{owner:?}"
            );
            let on = if owner.is_some() { "feat" } else { "other" };
            assert_eq!(on_branch(&path).await, on, "{owner:?}");
            assert_eq!(rev(&path, "HEAD").await, rev(&fx.clone, "main").await);
        }
    }

    /// A removal's unlink while the checkout waits: the mutating arms take the admin
    /// lock the removal holds, and a worktree that lost its `.git` is refused, so git
    /// never runs in the orphaned folder, where it would act on the main checkout. The
    /// clone's HEAD is pointed at `feat` so the branch and HEAD re-reads, which git
    /// answers from the enclosing checkout there, can't refuse first.
    #[tokio::test]
    async fn an_unlinked_worktree_never_mutates_the_main_checkout() {
        let rel = ".gitdesktop/worktrees/pr-7";
        for force in [false, true] {
            let fx = forge_fixture("lk-unlink").await;
            let src = gl("feat", false, None);
            wt(&fx, "GitLab", &src, rel, None).await.unwrap();
            let path = std::path::Path::new(&fx.clone)
                .join(rel)
                .to_string_lossy()
                .into_owned();
            let expected = if force {
                Some(commit(&path, "mine.txt", "mine\n", "mine").await)
            } else {
                None
            };
            advance(&fx, "c.txt").await;
            let feat_before = rev(&fx.clone, "refs/heads/feat").await;
            let a_before = read(&fx.clone, "a.txt");
            let exclude = clear_exclude(&fx);
            let state = AppState::default();
            let (got, ()) = tokio::join!(
                wt_on(&state, &fx, "GitLab", &src, rel, expected.as_deref()),
                mutate_under_admin(&state, &fx.clone, &exclude, async {
                    std::fs::remove_file(std::path::Path::new(&path).join(".git")).unwrap();
                    run(&fx.clone, &["symbolic-ref", "HEAD", "refs/heads/feat"]).await;
                })
            );
            assert_eq!(
                got.unwrap_err().to_string(),
                changed_during_checkout(rel).to_string(),
                "force {force}"
            );
            assert_eq!(rev(&fx.clone, "refs/heads/feat").await, feat_before);
            assert_eq!(read(&fx.clone, "a.txt"), a_before, "force {force}");
            assert!(!std::path::Path::new(&fx.clone).join("c.txt").exists());
        }
    }

    /// Each forge's arm calls that forge's own lookup; every swapped arm fails the pin.
    #[test]
    fn checkout_source_dispatches_each_forge_to_its_own_lookup() {
        // Whole calls, arguments included: each arm passes the command's own `number`.
        let (gl, bb, gh) = (
            "crate::forge::gitlab::mr_checkout_source(repo_path, number)",
            "crate::forge::bitbucket::pr_checkout_source(repo_path, number)",
            "crate::github::pr::gh_pr_checkout_source(repo_path, number, lens)",
        );
        let ok = |body: &str| {
            let arm = |key: &str, call: &str| {
                body.lines().any(|l| {
                    let l = l.trim();
                    l.starts_with(key) && l.contains(call)
                })
            };
            arm("\"GitLab\" =>", gl) && arm("\"Bitbucket\" =>", bb) && arm("_ =>", gh)
        };
        let body = crate::github::repo_meta::tests::wiring_body(
            include_str!("pr_checkout.rs"),
            "checkout_source",
        );
        assert!(ok(&body), "{body}");
        let literal = |call: &str| call.replacen("number", "1", 1);
        let swaps = [
            (gl.to_string(), bb.to_string()),
            (bb.to_string(), gl.to_string()),
            (gh.to_string(), gl.to_string()),
            (gl.to_string(), literal(gl)),
            (bb.to_string(), literal(bb)),
            (gh.to_string(), literal(gh)),
        ];
        for (from, to) in swaps {
            assert!(!ok(&body.replacen(&from, &to, 1)), "{from} -> {to}");
        }
    }

    /// The open checkout unlinked while the worktree add waits on the admin lock (which
    /// a removal holds): refused inside the hold, before git could add the worktree to
    /// the enclosing repository, for a new branch and for an existing one.
    #[tokio::test]
    async fn an_unlinked_open_checkout_is_refused_before_the_add() {
        for existing in [false, true] {
            let fx = forge_fixture("lk-add").await;
            let open = std::path::Path::new(&fx.clone)
                .join(".gitdesktop/worktrees/open")
                .to_string_lossy()
                .into_owned();
            run(
                &fx.clone,
                &["worktree", "add", "-q", "-b", "other", &open, "main"],
            )
            .await;
            if existing {
                run(&fx.clone, &["branch", "feat", "main"]).await;
            }
            let target = std::path::Path::new(&fx.clone)
                .join(".gitdesktop/worktrees/pr-7")
                .to_string_lossy()
                .into_owned();
            let exclude = clear_exclude(&fx);
            let (list, branches) = (worktrees(&fx.clone).await, heads(&fx.clone).await);
            let state = AppState::default();
            let src = gl("feat", false, None);
            let mode = force_mode(false, None).unwrap();
            let (got, ()) = tokio::join!(
                worktree_checkout_core(&state, &open, 7, "GitLab", &src, &[], &target, mode),
                mutate_under_admin(&state, &fx.clone, &exclude, async {
                    std::fs::remove_file(std::path::Path::new(&open).join(".git")).unwrap();
                })
            );
            let err = got.unwrap_err();
            assert!(
                err.to_string().contains("changed during the checkout"),
                "existing {existing}: {err}"
            );
            assert!(
                !std::path::Path::new(&target).exists(),
                "existing {existing}"
            );
            // Paths only: the unlink itself marks `open` prunable in the listing.
            let paths = |l: &str| -> Vec<String> {
                l.lines()
                    .filter(|r| r.starts_with("worktree "))
                    .map(str::to_string)
                    .collect()
            };
            let after = worktrees(&fx.clone).await;
            assert_eq!(paths(&after), paths(&list), "existing {existing}");
            assert_eq!(heads(&fx.clone).await, branches, "existing {existing}");
        }
    }

    /// On POSIX a trailing space is part of a folder's name, so the checkout's top level
    /// keeps it and the `.git` check probes the real folder.
    #[cfg(unix)]
    #[tokio::test]
    async fn checkout_top_keeps_a_trailing_space() {
        let dir = tempfile::Builder::new()
            .prefix("gd-prc-top-")
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().join("project ").to_string_lossy().into_owned();
        std::fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-q"]).await;
        let top = checkout_top(&repo).await.unwrap();
        assert!(top.ends_with("project "), "{top:?}");
        refuse_unlinked(&top, &top).await.unwrap();
    }

    /// The command gates its path before any lookup; the tests above call the core.
    #[test]
    fn worktree_command_gates_the_path_before_dispatch() {
        let body = crate::github::repo_meta::tests::wiring_body(
            include_str!("pr_checkout.rs"),
            "native_pr_checkout_worktree",
        );
        let at = |needle: &str| {
            body.find(needle)
                .unwrap_or_else(|| panic!("{needle} missing from the command"))
        };
        let dispatch = at("checkout_source(");
        assert!(at("worktree_path_arg(") < dispatch);
        assert!(at("refuse_ambiguous_worktree_path(path, cfg!(windows))?") < dispatch);
        assert!(at("force_mode(") < dispatch);
    }

    /// The force guard: a commit made while the forced retry waits on its lock is
    /// never reset away.
    #[tokio::test]
    async fn force_rereads_head_under_its_hold() {
        let rel = ".gitdesktop/worktrees/pr-7";
        let fx = forge_fixture("lk-force").await;
        let src = gl("feat", false, None);
        wt(&fx, "GitLab", &src, rel, None).await.unwrap();
        let path = std::path::Path::new(&fx.clone)
            .join(rel)
            .to_string_lossy()
            .into_owned();
        let mine = commit(&path, "mine.txt", "mine\n", "mine").await;
        advance(&fx, "c.txt").await;
        let exclude = clear_exclude(&fx);
        let state = AppState::default();
        let mut later = String::new();
        let (got, ()) = tokio::join!(
            wt_on(&state, &fx, "GitLab", &src, rel, Some(&mine)),
            mutate_under_hold(&state, &path, &exclude, async {
                later = commit(&path, "later.txt", "later\n", "later").await;
            })
        );
        assert_eq!(
            got.unwrap_err().to_string(),
            changed_since_confirm(rel).to_string()
        );
        assert_eq!(rev(&path, "HEAD").await, later);
    }

    /// The force guard's membership check: the worktree's folder swapped, while the
    /// retry waits, for another clone on the same branch at the confirmed HEAD (and
    /// holding the PR's tip) is never reset.
    #[tokio::test]
    async fn force_refuses_a_swapped_in_clone() {
        let rel = ".gitdesktop/worktrees/pr-7";
        let fx = forge_fixture("lk-swap").await;
        let src = gl("feat", false, None);
        wt(&fx, "GitLab", &src, rel, None).await.unwrap();
        let path = std::path::Path::new(&fx.clone)
            .join(rel)
            .to_string_lossy()
            .into_owned();
        let mine = commit(&path, "mine.txt", "mine\n", "mine").await;
        advance(&fx, "c.txt").await;
        let repl = beside(&fx, "repl");
        let root = beside(&fx, "");
        run(&root, &["clone", "-q", "--no-checkout", &fx.clone, &repl]).await;
        run(&repl, &["checkout", "-q", "-b", "feat", &mine]).await;
        run(
            &repl,
            &["fetch", "-q", &fx.forge, "refs/merge-requests/7/head"],
        )
        .await;
        let exclude = clear_exclude(&fx);
        let state = AppState::default();
        let (got, ()) = tokio::join!(
            wt_on(&state, &fx, "GitLab", &src, rel, Some(&mine)),
            mutate_under_hold(&state, &path, &exclude, async {
                std::fs::rename(&path, beside(&fx, "wt-old")).unwrap();
                std::fs::rename(&repl, &path).unwrap();
            })
        );
        assert_eq!(
            got.unwrap_err().to_string(),
            changed_since_confirm(rel).to_string()
        );
        assert_eq!(rev(&path, "HEAD").await, mine);
        assert!(!std::path::Path::new(&path).join("c.txt").exists());
    }

    async fn worktrees(repo: &str) -> String {
        run(repo, &["worktree", "list", "--porcelain"]).await
    }

    fn read(dir: &str, file: &str) -> String {
        std::fs::read_to_string(std::path::Path::new(dir).join(file)).unwrap()
    }

    fn write(dir: &str, file: &str, content: &str) {
        std::fs::write(std::path::Path::new(dir).join(file), content).unwrap();
    }

    const WT_ALL: [Arm; 4] = [Arm::Gl, Arm::Bb, Arm::Bbf, Arm::Gh];

    struct Div {
        path: String,
        shown_path: String,
        head: String,
        commits: usize,
        dirty: bool,
        message: String,
    }

    fn diverged(err: AppError) -> Div {
        let message = err.to_string();
        match err {
            AppError::WorktreeDiverged {
                path,
                shown_path,
                head,
                commits,
                dirty,
                ..
            } => Div {
                path,
                shown_path,
                head,
                commits: commits.len(),
                dirty,
                message,
            },
            other => panic!("expected WorktreeDiverged: {other:?}"),
        }
    }

    /// git's own refusal, its stderr carrying `needle`.
    fn git_refusal(err: AppError, needle: &str) {
        match err {
            AppError::Git { stderr, .. } => assert!(stderr.contains(needle), "{stderr}"),
            other => panic!("expected git's refusal: {other:?}"),
        }
    }

    /// T-W1: a fresh worktree lands on the local name at the fetched tip; the open
    /// checkout, the pins and FETCH_HEAD are untouched.
    #[tokio::test]
    async fn worktree_fresh_checkout_lands_on_the_pinned_tip() {
        for a in WT_ALL {
            let fx = forge_fixture("w1").await;
            let (src, forge, local) = arm(&fx, a);
            let main = rev(&fx.clone, "HEAD").await;
            let fetch_head = std::path::Path::new(&fx.clone)
                .join(".git")
                .join("FETCH_HEAD");
            let bogus = format!("{main}\t\tbranch 'bogus' of nowhere\n");
            std::fs::write(&fetch_head, &bogus).unwrap();
            let path = beside(&fx, "wt");

            wt(&fx, forge, &src, &path, None)
                .await
                .unwrap_or_else(|e| panic!("{a:?}: {e}"));

            assert_eq!(on_branch(&path).await, local, "{a:?}");
            assert_eq!(rev(&path, "HEAD").await, fx.tip, "{a:?}");
            assert_eq!(head_ref(&fx.clone).await, "refs/heads/main", "{a:?}");
            assert!(own_pins(&fx.clone).await.is_empty(), "{a:?}");
            let kept = std::fs::read_to_string(&fetch_head).unwrap();
            assert_eq!(kept, bogus, "{a:?}");
        }
    }

    /// T-W2: a re-run into the same worktree fast-forwards to the advanced tip.
    #[tokio::test]
    async fn worktree_rerun_fast_forwards() {
        for a in WT_ALL {
            let fx = forge_fixture("w2").await;
            let (src, forge, local) = arm(&fx, a);
            let path = beside(&fx, "wt");
            wt(&fx, forge, &src, &path, None).await.unwrap();
            let tip = advance(&fx, "c.txt").await;
            wt(&fx, forge, &src, &path, None)
                .await
                .unwrap_or_else(|e| panic!("{a:?}: {e}"));
            assert_eq!(on_branch(&path).await, local, "{a:?}");
            assert_eq!(rev(&path, "HEAD").await, tip, "{a:?}");
            assert!(own_pins(&fx.clone).await.is_empty(), "{a:?}");
        }
    }

    /// T-W3: a diverged worktree is refused before any write; a relative target keeps
    /// its echo in `path` while the message names git's absolute spelling.
    #[tokio::test]
    async fn worktree_diverged_rerun_is_refused_unchanged() {
        let rel = ".gitdesktop/worktrees/pr-7";
        for a in WT_ALL {
            let fx = forge_fixture("w3").await;
            let (src, forge, _) = arm(&fx, a);
            wt(&fx, forge, &src, rel, None).await.unwrap();
            let path = std::path::Path::new(&fx.clone)
                .join(rel)
                .to_string_lossy()
                .into_owned();
            let mine = commit(&path, "mine.txt", "mine\n", "mine").await;
            advance(&fx, "c.txt").await;

            let err = wt(&fx, forge, &src, rel, None).await.unwrap_err();
            let wire = serde_json::to_value(&err).unwrap();
            let d = diverged(err);
            assert_eq!(d.path, rel, "{a:?}");
            assert_eq!(wire["path"], rel, "{a:?}");
            assert_eq!(
                (d.head.as_str(), d.commits, d.dirty),
                (mine.as_str(), 1, false)
            );
            assert!(
                std::path::Path::new(&d.shown_path).is_absolute(),
                "{}",
                d.shown_path
            );
            assert_eq!(
                std::fs::canonicalize(&d.shown_path).unwrap(),
                std::fs::canonicalize(&path).unwrap()
            );
            assert_eq!(d.message, diverged_message(&d.shown_path, 1, false, false));
            assert_eq!(wire["message"], d.message.as_str());
            assert_eq!(rev(&path, "HEAD").await, mine, "{a:?}");
            assert!(own_pins(&fx.clone).await.is_empty(), "{a:?}");
        }
    }

    /// T-W4: a forced retry at the confirmed head resets to the fetched tip; a stale
    /// confirm changes nothing.
    #[tokio::test]
    async fn worktree_force_resets_only_at_the_confirmed_head() {
        for a in WT_ALL {
            let fx = forge_fixture("w4").await;
            let (src, forge, _) = arm(&fx, a);
            let path = beside(&fx, "wt");
            wt(&fx, forge, &src, &path, None).await.unwrap();
            commit(&path, "mine.txt", "mine\n", "mine").await;
            let tip = advance(&fx, "c.txt").await;
            let d = diverged(wt(&fx, forge, &src, &path, None).await.unwrap_err());

            wt(&fx, forge, &src, &path, Some(&d.head))
                .await
                .unwrap_or_else(|e| panic!("{a:?}: {e}"));
            assert_eq!(rev(&path, "HEAD").await, tip, "{a:?}");

            let err = wt(&fx, forge, &src, &path, Some(&d.head))
                .await
                .unwrap_err();
            assert_eq!(err.to_string(), changed_since_confirm(&path).to_string());
            assert_eq!(rev(&path, "HEAD").await, tip, "{a:?}");
            assert!(own_pins(&fx.clone).await.is_empty(), "{a:?}");
        }
    }

    /// T-W5: dirty tracked changes ride a commit divergence as `dirty`.
    #[tokio::test]
    async fn worktree_dirty_divergence_reports_dirty() {
        for a in [Arm::Gl, Arm::Gh] {
            let fx = forge_fixture("w5").await;
            let (src, forge, _) = arm(&fx, a);
            let path = beside(&fx, "wt");
            wt(&fx, forge, &src, &path, None).await.unwrap();
            let mine = commit(&path, "mine.txt", "mine\n", "mine").await;
            write(&path, "a.txt", "local edit\n");
            advance(&fx, "c.txt").await;
            let d = diverged(wt(&fx, forge, &src, &path, None).await.unwrap_err());
            assert!(d.dirty, "{a:?}");
            assert_eq!(d.head, mine);
            assert_eq!(read(&path, "a.txt"), "local edit\n");
        }
    }

    /// T-W6: a reserved head, or an owner prefix spelling one, refuses before the fetch
    /// on every forge.
    #[tokio::test]
    async fn worktree_reserved_names_refuse_before_the_fetch() {
        let fx = forge_fixture("w6").await;
        let path = beside(&fx, "wt");
        let before = worktrees(&fx.clone).await;
        let srcs = |head: &str, fork: bool, owner: Option<&str>| {
            [
                ("GitLab", gl(head, fork, owner)),
                (
                    "Bitbucket",
                    source(
                        head,
                        fork,
                        !fork,
                        owner,
                        FetchFrom::Remote("origin"),
                        SourceRef::Branch(head.into()),
                    ),
                ),
                (
                    "Bitbucket",
                    source(
                        head,
                        fork,
                        false,
                        owner,
                        FetchFrom::BitbucketUrl(fx.fork.clone()),
                        SourceRef::Branch(head.into()),
                    ),
                ),
                ("GitHub", gh(head, fork, !fork, owner)),
            ]
        };
        let cases = srcs("gd/session/x", false, None).into_iter().chain(srcs(
            "session/x",
            true,
            Some("gd"),
        ));
        for (forge, src) in cases {
            let err = wt(&fx, forge, &src, &path, None).await.unwrap_err();
            assert!(
                err.to_string().contains("reserved for agent sessions"),
                "{forge} {}: {err}",
                src.head
            );
            assert_eq!(worktrees(&fx.clone).await, before);
            assert!(!std::path::Path::new(&path).exists());
            assert!(own_pins(&fx.clone).await.is_empty());
        }
    }

    /// T-W7: an ownerless fork refuses while a bare-named branch exists, in the forge's
    /// own words; nothing is created.
    #[tokio::test]
    async fn worktree_ownerless_fork_refuses_a_bare_namesake() {
        let cases = [
            (
                "GitLab",
                gl("feat", true, None),
                "invalid argument: A branch named feat already exists and may be your own: GitLab no longer names this merge request's fork, so its branch can't be told apart from yours — nothing was checked out.",
            ),
            (
                "GitHub",
                gh("feat", true, false, None),
                "invalid argument: A branch named feat already exists and may be your own: GitHub no longer names this pull request's fork, so its branch can't be told apart from yours — nothing was checked out.",
            ),
        ];
        for (forge, src, expected) in cases {
            let fx = forge_fixture("w7").await;
            run(&fx.clone, &["branch", "feat"]).await;
            let path = beside(&fx, "wt");
            let before = (heads(&fx.clone).await, worktrees(&fx.clone).await);
            let err = wt(&fx, forge, &src, &path, None).await.unwrap_err();
            assert_eq!(err.to_string(), expected);
            let after = (heads(&fx.clone).await, worktrees(&fx.clone).await);
            assert_eq!(after, before, "{forge}");
            assert!(!std::path::Path::new(&path).exists());
            assert!(own_pins(&fx.clone).await.is_empty());
        }
    }

    /// T-W8: a GitLab cross-project branch carries the source project's full path, and
    /// a re-run into the same folder fast-forwards it.
    #[tokio::test]
    async fn worktree_gitlab_cross_project_rerun_syncs() {
        let fx = forge_fixture("w8").await;
        let src = gl("feat", true, Some("grp/sub/proj"));
        let path = beside(&fx, "wt");
        wt(&fx, "GitLab", &src, &path, None).await.unwrap();
        assert_eq!(on_branch(&path).await, "grp/sub/proj/feat");
        assert_eq!(rev(&path, "HEAD").await, fx.tip);
        let tip = advance(&fx, "c.txt").await;
        wt(&fx, "GitLab", &src, &path, None).await.unwrap();
        assert_eq!(on_branch(&path).await, "grp/sub/proj/feat");
        assert_eq!(rev(&path, "HEAD").await, tip);
    }

    /// T-W9: a linked worktree on another branch is switched to the PR's and synced.
    #[tokio::test]
    async fn worktree_on_another_branch_is_switched() {
        let fx = forge_fixture("w9").await;
        let path = beside(&fx, "wt");
        run(
            &fx.clone,
            &["worktree", "add", "-q", "-b", "other", &path, "main"],
        )
        .await;
        wt(&fx, "GitLab", &gl("feat", false, None), &path, None)
            .await
            .unwrap();
        assert_eq!(on_branch(&path).await, "feat");
        assert_eq!(rev(&path, "HEAD").await, fx.tip);
        assert_eq!(
            config(&fx.clone, "branch.feat.remote").await,
            (0, "origin".into())
        );

        // A detached linked worktree is switched too.
        let fx = forge_fixture("w9d").await;
        let path = beside(&fx, "wt");
        run(
            &fx.clone,
            &["worktree", "add", "-q", "--detach", &path, "main"],
        )
        .await;
        wt(&fx, "GitLab", &gl("feat", false, None), &path, None)
            .await
            .unwrap();
        assert_eq!(on_branch(&path).await, "feat");
        assert_eq!(rev(&path, "HEAD").await, fx.tip);
    }

    /// T-W10: an existing diverged branch lands in its new worktree before
    /// `WorktreeDiverged` returns, so the forced retry can reset it.
    #[tokio::test]
    async fn worktree_existing_diverged_branch_lands_then_resets() {
        let fx = forge_fixture("w10").await;
        run(&fx.clone, &["switch", "-q", "-c", "feat"]).await;
        let mine = commit(&fx.clone, "mine.txt", "mine\n", "mine").await;
        run(&fx.clone, &["switch", "-q", "main"]).await;
        let path = beside(&fx, "wt");
        let src = gl("feat", false, None);
        let d = diverged(wt(&fx, "GitLab", &src, &path, None).await.unwrap_err());
        assert_eq!((d.head.as_str(), d.commits), (mine.as_str(), 1));
        assert_eq!(on_branch(&path).await, "feat");
        assert_eq!(rev(&path, "HEAD").await, mine);
        wt(&fx, "GitLab", &src, &path, Some(&d.head)).await.unwrap();
        assert_eq!(rev(&path, "HEAD").await, fx.tip);
        assert_eq!(head_ref(&fx.clone).await, "refs/heads/main");
    }

    /// T-W11: a non-empty folder gets the shared not-empty sentence; the main checkout
    /// gets the gate's refusal.
    #[tokio::test]
    async fn worktree_refuses_a_full_folder_and_the_main_checkout() {
        let fx = forge_fixture("w11").await;
        let src = gl("feat", false, None);
        let path = beside(&fx, "full");
        std::fs::create_dir_all(&path).unwrap();
        write(&path, "keep.txt", "keep\n");
        let before = worktrees(&fx.clone).await;
        let branches = heads(&fx.clone).await;
        let err = wt(&fx, "GitLab", &src, &path, None).await.unwrap_err();
        assert_eq!(heads(&fx.clone).await, branches, "no stray branch");
        assert!(matches!(err, AppError::InvalidArgument(_)), "{err:?}");
        assert!(
            err.to_string()
                .contains(&format!("{path} isn't empty — pick a new or empty folder.")),
            "{err}"
        );
        assert_eq!(worktrees(&fx.clone).await, before);
        assert_eq!(read(&path, "keep.txt"), "keep\n");

        let clone = fx.clone.clone();
        let err = wt(&fx, "GitLab", &src, &clone, None).await.unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("invalid argument: {clone} is this repository's main checkout — pick a new folder, or the pull request's own worktree.")
        );
        assert_eq!(head_ref(&fx.clone).await, "refs/heads/main");
        assert!(own_pins(&fx.clone).await.is_empty());
    }

    /// T-W12: a missing remote ref names the forge and its noun; no pin is left.
    #[tokio::test]
    async fn worktree_missing_remote_ref_names_the_forge() {
        for a in [Arm::Gl, Arm::Bbf] {
            let fx = forge_fixture("w12").await;
            let (src, forge, _) = arm(&fx, a);
            let (bare, gone, expected) = match a {
                Arm::Gl => (
                    &fx.forge,
                    "refs/merge-requests/7/head",
                    "GitLab no longer has this merge request's branch",
                ),
                _ => (
                    &fx.fork,
                    "refs/heads/feat",
                    "Bitbucket no longer has this pull request's branch",
                ),
            };
            run(bare, &["update-ref", "-d", gone]).await;
            let path = beside(&fx, "wt");
            let err = wt(&fx, forge, &src, &path, None).await.unwrap_err();
            assert!(err.to_string().contains(expected), "{a:?}: {err}");
            assert!(
                err.to_string().contains("couldn't find remote ref"),
                "{err}"
            );
            assert!(!std::path::Path::new(&path).exists());
            assert!(own_pins(&fx.clone).await.is_empty());
        }
    }

    /// A GitLab worktree checked out at the PR's first tip, for one parity case.
    async fn par(marker: &str) -> (Fx, PrCheckoutSource, String) {
        let fx = forge_fixture(marker).await;
        let src = gl("feat", false, None);
        let path = beside(&fx, "wt");
        wt(&fx, "GitLab", &src, &path, None).await.unwrap();
        (fx, src, path)
    }

    /// T-PAR: per tree state, the native re-run lands on the gh path's outcome (S1-S9,
    /// F1-F5); S10 is the one deliberate break, below.
    #[tokio::test]
    async fn rerun_matches_the_gh_path_per_tree_state() {
        // S1: clean and behind fast-forwards.
        let (fx, src, path) = par("s1").await;
        let tip = advance(&fx, "c.txt").await;
        wt(&fx, "GitLab", &src, &path, None).await.unwrap();
        assert_eq!(rev(&path, "HEAD").await, tip, "S1");

        // S2: equal, then ahead, are up to date with nothing written.
        let (fx, src, path) = par("s2").await;
        wt(&fx, "GitLab", &src, &path, None).await.unwrap();
        assert_eq!(rev(&path, "HEAD").await, fx.tip, "S2 equal");
        let mine = commit(&path, "mine.txt", "mine\n", "mine").await;
        wt(&fx, "GitLab", &src, &path, None).await.unwrap();
        assert_eq!(rev(&path, "HEAD").await, mine, "S2 ahead");

        // S3: clean and diverged is refused, clean.
        let (fx, src, path) = par("s3").await;
        let mine = commit(&path, "mine.txt", "mine\n", "mine").await;
        advance(&fx, "c.txt").await;
        let d = diverged(wt(&fx, "GitLab", &src, &path, None).await.unwrap_err());
        assert!(!d.dirty, "S3");
        assert_eq!(rev(&path, "HEAD").await, mine, "S3");

        // S4: dirty and diverged is refused as dirty.
        let (fx, src, path) = par("s4").await;
        let mine = commit(&path, "mine.txt", "mine\n", "mine").await;
        write(&path, "a.txt", "local\n");
        advance(&fx, "c.txt").await;
        let d = diverged(wt(&fx, "GitLab", &src, &path, None).await.unwrap_err());
        assert!(d.dirty, "S4");
        assert_eq!(rev(&path, "HEAD").await, mine, "S4");
        assert_eq!(read(&path, "a.txt"), "local\n", "S4");

        // S5: dirty and behind, no overlap: fast-forwards, the edit carried.
        let (fx, src, path) = par("s5").await;
        write(&path, "a.txt", "local\n");
        let tip = advance(&fx, "c.txt").await;
        wt(&fx, "GitLab", &src, &path, None)
            .await
            .unwrap_or_else(|e| panic!("S5: {e}"));
        assert_eq!(rev(&path, "HEAD").await, tip, "S5");
        assert_eq!(read(&path, "a.txt"), "local\n", "S5");

        // S6: dirty and behind, overlapping: git's fast-forward refusal, no divergence.
        let (fx, src, path) = par("s6").await;
        write(&path, "a.txt", "local\n");
        advance(&fx, "a.txt").await;
        let err = wt(&fx, "GitLab", &src, &path, None).await.unwrap_err();
        git_refusal(err, "would be overwritten");
        assert_eq!(rev(&path, "HEAD").await, fx.tip, "S6");
        assert_eq!(read(&path, "a.txt"), "local\n", "S6");

        // S7: an untracked file where the PR adds one: git's refusal.
        let (fx, src, path) = par("s7").await;
        write(&path, "c.txt", "mine\n");
        advance(&fx, "c.txt").await;
        let err = wt(&fx, "GitLab", &src, &path, None).await.unwrap_err();
        git_refusal(err, "would be overwritten");
        assert_eq!(rev(&path, "HEAD").await, fx.tip, "S7");
        assert_eq!(read(&path, "c.txt"), "mine\n", "S7");

        // S8: a clean linked worktree on another branch is switched, then synced.
        let fx = forge_fixture("s8").await;
        run(&fx.clone, &["branch", "feat", "main"]).await;
        let path = beside(&fx, "wt");
        run(
            &fx.clone,
            &["worktree", "add", "-q", "-b", "other", &path, "main"],
        )
        .await;
        wt(&fx, "GitLab", &gl("feat", false, None), &path, None)
            .await
            .unwrap();
        assert_eq!(on_branch(&path).await, "feat", "S8");
        assert_eq!(rev(&path, "HEAD").await, fx.tip, "S8");

        // S9: dirty where the switch would overwrite: git's refusal, nothing created.
        let fx = forge_fixture("s9").await;
        let path = beside(&fx, "wt");
        run(
            &fx.clone,
            &["worktree", "add", "-q", "-b", "other", &path, "main"],
        )
        .await;
        write(&path, "a.txt", "local\n");
        let before = heads(&fx.clone).await;
        let err = wt(&fx, "GitLab", &gl("feat", false, None), &path, None)
            .await
            .unwrap_err();
        git_refusal(err, "would be overwritten");
        assert_eq!(on_branch(&path).await, "other", "S9");
        assert_eq!(heads(&fx.clone).await, before, "S9");
        assert_eq!(read(&path, "a.txt"), "local\n", "S9");

        s10_deliberate_parity_break_refuses_where_gh_overwrites().await;

        // F1: forced at the confirmed head resets to the fetched tip.
        let (fx, src, path) = par("f1").await;
        let mine = commit(&path, "mine.txt", "mine\n", "mine").await;
        let tip = advance(&fx, "c.txt").await;
        wt(&fx, "GitLab", &src, &path, Some(&mine)).await.unwrap();
        assert_eq!(rev(&path, "HEAD").await, tip, "F1");

        // F2: HEAD moved but still diverged: a fresh divergence, nothing reset.
        let (fx, src, path) = par("f2").await;
        let mine = commit(&path, "mine.txt", "mine\n", "mine").await;
        advance(&fx, "c.txt").await;
        let d = diverged(
            wt(&fx, "GitLab", &src, &path, Some(&fx.tip))
                .await
                .unwrap_err(),
        );
        assert_eq!(d.head, mine, "F2");
        assert_eq!(rev(&path, "HEAD").await, mine, "F2");

        // F3: HEAD moved and no longer diverged: the changed copy, nothing reset.
        let (fx, src, path) = par("f3").await;
        let main = rev(&fx.clone, "main").await;
        let err = wt(&fx, "GitLab", &src, &path, Some(&main))
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            changed_since_confirm(&path).to_string(),
            "F3"
        );
        assert_eq!(rev(&path, "HEAD").await, fx.tip, "F3");

        // F4: the worktree is now on another branch: the changed copy.
        let (fx, src, path) = par("f4").await;
        run(&path, &["switch", "-q", "-c", "other"]).await;
        let err = wt(&fx, "GitLab", &src, &path, Some(&fx.tip))
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            changed_since_confirm(&path).to_string(),
            "F4"
        );
        assert_eq!(on_branch(&path).await, "other", "F4");

        // F5: the path isn't a linked worktree.
        let (fx, src, _) = par("f5").await;
        let nope = beside(&fx, "nope");
        let err = wt(&fx, "GitLab", &src, &nope, Some(&fx.tip))
            .await
            .unwrap_err();
        assert_eq!(
            err.to_string(),
            format!("invalid argument: Only an existing worktree of this repository can be reset to the pull request — {nope} isn't one."),
            "F5"
        );
    }

    /// S10, a DELIBERATE parity break: gh's plain `merge --ff-only` silently replaces an
    /// ignored file the PR adds as tracked; the native merge carries
    /// `--no-overwrite-ignore`, so it refuses with git's text naming the file.
    async fn s10_deliberate_parity_break_refuses_where_gh_overwrites() {
        let (fx, src, path) = par("s10").await;
        let exclude = std::path::Path::new(&fx.clone).join(".git/info/exclude");
        std::fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        let mut rules = std::fs::read_to_string(&exclude).unwrap_or_default();
        rules.push_str("\n.env\n");
        std::fs::write(&exclude, rules).unwrap();
        write(&path, ".env", "secret\n");
        advance(&fx, ".env").await;
        let err = wt(&fx, "GitLab", &src, &path, None).await.unwrap_err();
        git_refusal(err, ".env");
        assert_eq!(rev(&path, "HEAD").await, fx.tip, "S10");
        assert_eq!(read(&path, ".env"), "secret\n", "S10");
    }
}
