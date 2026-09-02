use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{
    acquire_repo_lock, acquire_repo_lock_unbounded, run_git, run_git_mutating, run_git_raw,
    run_git_worktree_admin, try_acquire_repo_lock, DEFAULT_TIMEOUT, LOCK_WAIT_TIMEOUT,
    NETWORK_TIMEOUT, WORKTREE_OP_TIMEOUT,
};
use crate::git::types::{Branch, BranchDivergence, RemoteBranch};
use crate::state::AppState;

/// The shared guard against refspec/argv injection from a user-named ref: every
/// ref-reaching name routes through here or through `validate_tag_name`. Rev
/// syntax (`~ ^ @ { }`) is deliberately accepted, for branch start-points.
pub(crate) fn validate_ref_name(name: &str) -> AppResult<()> {
    if name.is_empty() || name.starts_with('-') {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch name: {name}"
        )));
    }
    // Reject glob/refspec metacharacters. A ref name is interpolated into
    // `for-each-ref refs/heads/<name>` (where `* ? [` glob) and, on the push
    // path, into a push refspec `refs/heads/<name>:refs/heads/<name>` (where `*`
    // is a wildcard and `:` a separator) — so an unfiltered `*` would glob-match
    // and mirror-push every branch. These characters are never valid in a real
    // git ref name. `~ ^ @ { }` are deliberately NOT rejected: this validator is
    // also used for rev-expression start points (e.g. `main~3`, `HEAD@{2}`).
    if name
        .chars()
        .any(|c| matches!(c, '*' | '?' | '[' | ':' | '\\' | ' ') || c.is_ascii_control())
    {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch name: {name}"
        )));
    }
    Ok(())
}

/// The stricter gate for inputs that must name a BRANCH and nothing else: it adds
/// a rejection of rev-expression syntax, which `rev-parse` would otherwise resolve
/// (`feature~1` exists under `refs/heads/` as the branch's parent commit), and of
/// bare `@`, git's HEAD shorthand in the rev positions these names reach.
pub(crate) fn validate_branch_name(name: &str) -> AppResult<()> {
    validate_ref_name(name)?;
    if name == "@" || name.contains(['~', '^']) || name.contains("..") || name.contains("@{") {
        return Err(AppError::InvalidArgument(format!(
            "invalid branch name: {name}"
        )));
    }
    Ok(())
}

#[tauri::command]
pub async fn git_branches(repo_path: String) -> AppResult<Vec<Branch>> {
    let out = run_git(
        Some(&repo_path),
        &[
            "for-each-ref",
            "refs/heads",
            "--format=%(refname:short)%00%(upstream:short)%00%(HEAD)%00%(committerdate:iso8601-strict)%00%(upstream:track)%00%(upstream:remotename)",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let archived = read_archived_set(&repo_path).await?;
    let mut branches = Vec::new();
    for line in text.lines() {
        let mut parts = line.split('\0');
        let (Some(name), upstream, head, date, track, upstream_remote) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        let (upstream_ahead, upstream_behind, upstream_gone) =
            parse_upstream_track(track.unwrap_or(""));
        branches.push(Branch {
            name: name.to_string(),
            is_current: head == Some("*"),
            upstream: upstream.filter(|u| !u.is_empty()).map(str::to_string),
            last_commit_date: date.unwrap_or("").to_string(),
            archived: archived.contains(name),
            upstream_ahead,
            upstream_behind,
            upstream_gone,
            upstream_remote: upstream_remote.filter(|r| !r.is_empty()).map(str::to_string),
        });
    }
    Ok(branches)
}

/// Parses git's `%(upstream:track)` field into `(ahead, behind, gone)`.
///
/// Shapes: `[ahead 1, behind 2]`, `[ahead 1]`, `[behind 2]`, `[gone]`
/// (upstream deleted), or empty (no upstream, or in sync). `[gone]` yields
/// `(0, 0, true)`; empty and anything unparseable yield `(0, 0, false)`.
/// The `gone` bit lets consumers offer "Publish branch" instead of Push/Pull
/// against a dead ref, even though `%(upstream:short)` still names the upstream.
fn parse_upstream_track(track: &str) -> (u32, u32, bool) {
    let inner = track
        .trim()
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'));
    let Some(inner) = inner else {
        return (0, 0, false);
    };
    let (mut ahead, mut behind, mut gone) = (0u32, 0u32, false);
    for part in inner.split(',') {
        let mut words = part.split_whitespace();
        match (words.next(), words.next()) {
            (Some("ahead"), Some(n)) => ahead = n.parse().unwrap_or(0),
            (Some("behind"), Some(n)) => behind = n.parse().unwrap_or(0),
            (Some("gone"), _) => gone = true,
            _ => {}
        }
    }
    (ahead, behind, gone)
}

/// Branches that exist on a remote, for the switcher's "Remote" group. Returns
/// every `refs/remotes/<remote>/<branch>` (skipping each remote's symbolic
/// `HEAD`); the frontend drops the ones already checked out locally and the
/// internal `gd/session/*` branches. The list reflects the last fetch.
#[tauri::command]
pub async fn git_remote_branches(repo_path: String) -> AppResult<Vec<RemoteBranch>> {
    let out = run_git(
        Some(&repo_path),
        &[
            "for-each-ref",
            "refs/remotes",
            "--format=%(refname:short)%00%(committerdate:iso8601-strict)",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let mut branches = Vec::new();
    for line in out.stdout_lossy().lines() {
        let mut parts = line.split('\0');
        let (Some(refname), date) = (parts.next(), parts.next()) else {
            continue;
        };
        // `%(refname:short)` is `<remote>/<branch>` (e.g. `origin/feature/x`).
        // Split once so a branch name containing `/` stays intact.
        let Some((remote, name)) = refname.split_once('/') else {
            continue;
        };
        // Skip the remote's symbolic HEAD (`origin/HEAD` → points at the default).
        if name == "HEAD" || name.is_empty() {
            continue;
        }
        branches.push(RemoteBranch {
            name: name.to_string(),
            remote: remote.to_string(),
            last_commit_date: date.unwrap_or("").to_string(),
        });
    }
    Ok(branches)
}

/// The set of branches the user has archived, from local git config
/// (`branch.<name>.gitdesktopArchived true`). git keeps these in sync across
/// renames and removes them on delete, so they never go stale.
async fn read_archived_set(
    repo_path: &str,
) -> AppResult<std::collections::HashSet<String>> {
    let out = run_git_raw(
        Some(repo_path),
        &["config", "--get-regexp", r"^branch\..*\.gitdesktoparchived$"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let mut set = std::collections::HashSet::new();
    if out.code == 0 {
        for line in out.stdout_lossy().lines() {
            // "branch.<name>.gitdesktoparchived true"
            let Some((key, value)) = line.split_once(' ') else {
                continue;
            };
            if value.trim() != "true" {
                continue;
            }
            if let Some(name) = key
                .strip_prefix("branch.")
                .and_then(|k| k.strip_suffix(".gitdesktoparchived"))
            {
                set.insert(name.to_string());
            }
        }
    }
    Ok(set)
}

/// Archives/unarchives a branch by setting (or unsetting) a personal,
/// local-config flag, so it's hidden from the dropdown without being deleted.
#[tauri::command]
pub async fn git_set_branch_archived(
    repo_path: String,
    name: String,
    archived: bool,
) -> AppResult<()> {
    validate_ref_name(&name)?;
    // No current/default-branch refusal here by design: the frontend owns the
    // guard (the current-branch arm is total; the default arm is best-effort,
    // dropping out while defaultName resolves), no MCP tool mutates the flag,
    // and it is fully reversible — a backend default-branch check would also
    // ride the multi-spawn, fallible remote-HEAD resolution per call.
    let key = format!("branch.{name}.gitdesktopArchived");
    if archived {
        run_git(Some(&repo_path), &["config", &key, "true"], DEFAULT_TIMEOUT).await?;
    } else {
        let out = run_git_raw(
            Some(&repo_path),
            &["config", "--unset", &key],
            DEFAULT_TIMEOUT,
        )
        .await?;
        // exit 5 = "key not found" — already unarchived, which is fine.
        if out.code != 0 && out.code != 5 {
            return Err(AppError::Git {
                code: out.code,
                stderr: out.stderr,
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn git_rename_branch(
    state: State<'_, AppState>,
    repo_path: String,
    old_name: String,
    new_name: String,
) -> AppResult<()> {
    git_rename_branch_core(&state, repo_path, old_name, new_name).await
}

pub(crate) async fn git_rename_branch_core(
    state: &AppState,
    repo_path: String,
    old_name: String,
    new_name: String,
) -> AppResult<()> {
    validate_ref_name(&old_name)?;
    validate_ref_name(&new_name)?;
    run_git_mutating(
        state,
        &repo_path,
        &["branch", "-m", "--", &old_name, &new_name],
        DEFAULT_TIMEOUT,
    )
    .await?;
    // Carry the branch's reviewer note over to the new name, keyed by the same identity
    // the MCP deposit path uses. Strictly after the `?` and best-effort: the rename has
    // already happened, so a store failure must never be reported as a failed rename.
    // This is the one seam both in-app renames share (the GUI command and the MCP
    // `rename_branch` tool); a terminal `git branch -m` has no hook, the same accepted
    // gap as the commit-draft migration. Cold-start test mode is out of reach too — the
    // GUI aliases its store file there (`storeName` in src/lib/test-mode.ts).
    let identity = crate::git::repo::repo_identity(&repo_path).await;
    if let Err(e) = crate::review_notes::rename_branch(&identity, &old_name, &new_name).await {
        eprintln!("gitdesktop: reviewer-note rename failed (branch renamed anyway): {e}");
    }
    Ok(())
}

/// If `name` is checked out in a LINKED worktree (one other than `repo_path`
/// itself), returns that worktree's path. git refuses to delete a branch that's
/// checked out anywhere, so a caller turns this into an actionable message.
/// Best-effort: a `worktree list` failure yields `None` and lets git's own error
/// speak. The `repo_path` checkout is excluded so deleting its *current* branch
/// isn't misreported here (that path pre-switches, and git errors clearly if not).
///
/// The self-exclusion compares CANONICALIZED spellings (the #152 helper, same as
/// `ops::path_is_under`): git's porcelain prints the resolved path, so a caller
/// holding macOS's `/var/…` symlink or a Windows 8.3 short name (`RUNNER~1`)
/// would otherwise fail to recognize its OWN checkout and report the branch as
/// held by a "linked" worktree that is really this one — sending the caller to
/// the wrong remedy. A path that no longer resolves falls back to the raw
/// spelling, so the normalize-only compare stays as a second chance; either
/// match excludes, which can only ever remove a false positive.
async fn worktree_holding_branch(repo_path: &str, name: &str) -> Option<String> {
    use crate::git::ops::{parse_worktree_branches, parse_worktree_paths};
    use crate::git::worktree::{canonical_wt_path, normalize_wt_path};
    let listed = run_git(
        Some(repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let porcelain = listed.stdout_lossy();
    let self_norm = normalize_wt_path(repo_path);
    let self_canon = canonical_wt_path(repo_path);
    let is_self =
        |p: &str| normalize_wt_path(p) == self_norm || canonical_wt_path(p) == self_canon;
    // Both parsers emit one entry per `worktree …` stanza in the same list order,
    // so the zip is length-safe and pairs each worktree's path with its branch.
    parse_worktree_paths(&porcelain)
        .into_iter()
        .zip(parse_worktree_branches(&porcelain))
        .find(|(path, branch)| branch == name && !is_self(path))
        .map(|(path, _)| path)
}

/// Force-deletes a local branch (the UI confirms first, GitHub Desktop style).
#[tauri::command]
pub async fn git_delete_branch(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    git_delete_branch_core(&state, repo_path, name).await
}

pub(crate) async fn git_delete_branch_core(
    state: &AppState,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    validate_ref_name(&name)?;
    // Pre-mutation guard: git's own refusal for a branch checked out in a worktree
    // is terse. Detect the holding worktree here — shared by every caller, not just
    // the switcher's UI guard — and surface an actionable message.
    if let Some(path) = worktree_holding_branch(&repo_path, &name).await {
        return Err(AppError::Command(format!(
            "{name} is checked out in the worktree at {path} — remove that worktree \
             (or switch it to another branch) before deleting {name}."
        )));
    }
    run_git_mutating(
        state,
        &repo_path,
        &["branch", "-D", "--", &name],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Deletes a branch on a remote via `git push <remote> --delete`, authenticating
/// with the same one-shot provider-CLI credential entries `git_push` uses (so a
/// stale ambient credential can't shadow the signed-in CLI's identity). git prunes
/// the local remote-tracking ref on success.
#[tauri::command]
pub async fn git_delete_remote_branch(
    state: State<'_, AppState>,
    repo_path: String,
    remote: String,
    name: String,
) -> AppResult<()> {
    git_delete_remote_branch_core(&state, repo_path, remote, name).await
}

pub(crate) async fn git_delete_remote_branch_core(
    state: &AppState,
    repo_path: String,
    remote: String,
    name: String,
) -> AppResult<()> {
    validate_ref_name(&remote)?;
    validate_ref_name(&name)?;

    // Best-effort guard: if the remote's symbolic HEAD resolves (only set on
    // clone, so absence is fine — skip then) to this branch, it's the remote's
    // default and can't be deleted. The server refuses anyway, but cryptically;
    // check locally first. Probe with a non-propagating raw run.
    let head = run_git_raw(
        Some(&repo_path),
        &["symbolic-ref", "--short", &format!("refs/remotes/{remote}/HEAD")],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if head.code == 0 && head.stdout_lossy().trim() == format!("{remote}/{name}") {
        return Err(AppError::InvalidArgument(format!(
            "\"{name}\" is the default branch on {remote} and can't be deleted from here."
        )));
    }

    let cred = crate::forge::credential_config_for_remote(&repo_path, &remote).await?;
    let out = crate::git::remote::run_git_mutating_with_creds(
        state,
        &repo_path,
        &cred,
        &["push", &remote, "--delete", "--", &name],
        NETWORK_TIMEOUT,
    )
    .await;
    match out {
        Ok(_) => Ok(()),
        // Idempotent: the server ref is already gone. Unlike the success path, a
        // failed delete-push doesn't prune the local remote-tracking ref, so the
        // switcher row would survive until the next pruning fetch — best-effort
        // delete it now (it may already be absent).
        Err(AppError::Git { stderr, .. })
            if stderr.to_lowercase().contains("remote ref does not exist") =>
        {
            let _ = run_git_raw(
                Some(&repo_path),
                &["update-ref", "-d", &format!("refs/remotes/{remote}/{name}")],
                DEFAULT_TIMEOUT,
            )
            .await;
            Ok(())
        }
        Err(e) => Err(e),
    }
}

/// The repository's default branch: the HEAD a remote points at — `origin` first,
/// then every other remote in `git remote` order, so a clone made with `-o <name>`
/// resolves too — otherwise a local "main"/"master" if one exists.
///
/// Local refs only, no network: this runs in read paths and takes no `State`, so a
/// remote whose `refs/remotes/<remote>/HEAD` symref was never written (a hand-added
/// one) falls through to the local-name fallback.
#[tauri::command]
pub async fn git_default_branch(repo_path: String) -> AppResult<Option<String>> {
    // Origin answers almost every repo, so probe it before paying for a remote
    // listing — the common case stays at one git spawn.
    if let Some(name) = crate::git::remote::remote_head_branch(&repo_path, "origin").await? {
        return Ok(Some(name));
    }
    // Only now list, and sweep the OTHER remotes in `git remote` order — a clone made
    // with `-o <name>` keeps its HEAD there. Best-effort: an unlistable remote set
    // just leaves no remote HEAD to consult, which the fallback below already covers.
    let remotes = crate::git::remote::git_remotes(repo_path.clone())
        .await
        .unwrap_or_default();
    for remote in remotes.iter().filter(|r| r.as_str() != "origin") {
        if let Some(name) = crate::git::remote::remote_head_branch(&repo_path, remote).await? {
            return Ok(Some(name));
        }
    }
    for candidate in ["main", "master"] {
        let exists = run_git_raw(
            Some(&repo_path),
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{candidate}"),
            ],
            DEFAULT_TIMEOUT,
        )
        .await?
        .code
            == 0;
        if exists {
            return Ok(Some(candidate.to_string()));
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn git_checkout_branch(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    git_checkout_branch_core(&state, repo_path, name).await
}

pub(crate) async fn git_checkout_branch_core(
    state: &AppState,
    repo_path: String,
    name: String,
) -> AppResult<()> {
    validate_ref_name(&name)?;
    run_git_mutating(state, &repo_path, &["switch", &name], DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// Check out a remote-only branch as a new local tracking branch of a SPECIFIC
/// remote. We pass `--track <remote>/<name>` explicitly rather than plain
/// `switch <name>` because when the same branch name exists on 2+ remotes git's
/// DWIM refuses ("matched multiple remote tracking branches"), and even in the
/// single-remote case the switcher row promised the user this exact remote — so
/// we honor it by construction instead of trusting git's guess.
#[tauri::command]
pub async fn git_checkout_remote_branch(
    state: State<'_, AppState>,
    repo_path: String,
    remote: String,
    name: String,
) -> AppResult<()> {
    validate_ref_name(&remote)?;
    validate_ref_name(&name)?;
    run_git_mutating(
        &state,
        &repo_path,
        &["switch", "--track", &format!("{remote}/{name}")],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Build the argv for creating a branch. Pure so the decision table
/// (checkout × start_point × no_track) is unit-testable without a repo.
///
/// `no_track` suppresses git's automatic upstream setup so that basing a new
/// branch on a remote-tracking ref (e.g. `origin/epic/x`) yields a branch with
/// NO upstream — its first push then publishes it under its own name. Placement
/// matters: `--no-track` goes right after `switch` in the checkout arm, and
/// BEFORE the `--` in the `branch` arm.
fn build_create_branch_args(
    name: &str,
    checkout: bool,
    start_point: Option<&str>,
    no_track: bool,
) -> Vec<String> {
    let mut args: Vec<String> = if checkout {
        let mut a = vec!["switch".to_string()];
        if no_track {
            a.push("--no-track".to_string());
        }
        a.push("-c".to_string());
        a.push(name.to_string());
        a
    } else {
        let mut a = vec!["branch".to_string()];
        if no_track {
            a.push("--no-track".to_string());
        }
        a.push("--".to_string());
        a.push(name.to_string());
        a
    };
    if let Some(start) = start_point {
        args.push(start.to_string());
    }
    args
}

#[tauri::command]
pub async fn git_create_branch(
    state: State<'_, AppState>,
    repo_path: String,
    name: String,
    checkout: bool,
    start_point: Option<String>,
    no_track: bool,
) -> AppResult<()> {
    git_create_branch_core(&state, repo_path, name, checkout, start_point, no_track).await
}

pub(crate) async fn git_create_branch_core(
    state: &AppState,
    repo_path: String,
    name: String,
    checkout: bool,
    start_point: Option<String>,
    no_track: bool,
) -> AppResult<()> {
    validate_ref_name(&name)?;
    if let Some(start) = &start_point {
        // start_point may be a branch name or a commit hash — validate as a ref
        // (non-empty, no leading '-') rather than strictly a hash.
        validate_ref_name(start)?;
    }
    let args = build_create_branch_args(&name, checkout, start_point.as_deref(), no_track);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_mutating(state, &repo_path, &arg_refs, DEFAULT_TIMEOUT).await?;
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePair {
    pub base: String,
    pub head: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchMergeState {
    /// `head` is fully contained in `base` — nothing left to merge.
    pub merged: bool,
    /// The `head` branch still exists locally.
    pub head_exists: bool,
}

/// For each (base, head) pair, whether `head` is merged into `base` and whether
/// the `head` branch still exists. Reconciles local PRs whose branch was merged
/// (→ merged) or deleted (→ closed) outside the app.
#[tauri::command]
pub async fn git_branch_merge_states(
    repo_path: String,
    pairs: Vec<MergePair>,
) -> AppResult<Vec<BranchMergeState>> {
    let mut result = Vec::with_capacity(pairs.len());
    for pair in pairs {
        // The branch-name gate, not the ref gate: this reconciles LOCAL PR records,
        // and a record persisted with a rev expression (`feature~1`) would pass the
        // probe below and auto-transition the PR against a commit no branch is at.
        let valid_head = validate_branch_name(&pair.head).is_ok();
        let head_exists = if valid_head {
            run_git_raw(
                Some(&repo_path),
                &[
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    &format!("refs/heads/{}", pair.head),
                ],
                DEFAULT_TIMEOUT,
            )
            .await?
            .code
                == 0
        } else {
            false
        };
        let merged = if valid_head && validate_branch_name(&pair.base).is_ok() {
            run_git_raw(
                Some(&repo_path),
                &["merge-base", "--is-ancestor", &pair.head, &pair.base],
                DEFAULT_TIMEOUT,
            )
            .await?
            .code
                == 0
        } else {
            false
        };
        result.push(BranchMergeState {
            merged,
            head_exists,
        });
    }
    Ok(result)
}

/// Ahead/behind counts for every local branch measured against `base` (the
/// default branch), driving the at-a-glance counts in the branch menu.
/// Read-only; the base itself reports 0/0.
#[tauri::command]
pub async fn git_branch_divergence(
    repo_path: String,
    base: String,
) -> AppResult<Vec<BranchDivergence>> {
    validate_ref_name(&base)?;
    let out = run_git(
        Some(&repo_path),
        &["for-each-ref", "refs/heads", "--format=%(refname:short)"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let names: Vec<String> = out
        .stdout_lossy()
        .lines()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .collect();

    let mut result = Vec::with_capacity(names.len());
    for name in names {
        if name == base {
            result.push(BranchDivergence {
                name,
                ahead: 0,
                behind: 0,
            });
            continue;
        }
        // `base...name` left/right: left = on base only (behind), right = on
        // name only (ahead). A bad/unrelated ref just yields 0/0.
        let range = format!("{base}...{name}");
        let counts = run_git_raw(
            Some(&repo_path),
            &["rev-list", "--left-right", "--count", &range],
            DEFAULT_TIMEOUT,
        )
        .await?;
        let (mut behind, mut ahead) = (0u32, 0u32);
        if counts.code == 0 {
            let text = counts.stdout_lossy();
            let mut nums = text.split_whitespace();
            behind = nums.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            ahead = nums.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        }
        result.push(BranchDivergence {
            name,
            ahead,
            behind,
        });
    }
    Ok(result)
}

/// Evidence for telling a server-side REWRITE of a branch's upstream (GitHub's
/// "Update branch → rebase", any remote rebase or force-push) apart from ordinary
/// two-sided divergence — the two need OPPOSITE remedies, so the app must not
/// guess.
///
/// `remote_rewritten` answers one narrow question: is the upstream tip absent
/// from this branch's own reflog, i.e. has the branch ever literally been AT it.
/// That is a membership test over the same reflog `--force-if-includes` walks,
/// but a weaker question than the flag's — the flag asks whether the remote tip
/// is REACHABLE from some reflog entry, so a branch that saw the tip and then
/// merged or rebased past it satisfies the flag and fails this test. Those
/// shapes land on the ordinary-divergence arms, which is the safe direction.
///
/// It is NOT proof of a rewrite on its own either — ordinary divergence looks
/// identical (measured). Only paired with `local_only == 0` (no local commit
/// lacks a patch-twin upstream) does it describe the shape a rewrite produces,
/// and only that pair may drive a reset-to-upstream offer.
///
/// `None` means nothing was provable — no upstream, no reflog, any failed probe,
/// or a divergence too large to walk (a probe that SUCCEEDED but whose answer is
/// out of the range these surfaces serve) — and callers MUST then render exactly
/// what they render without this data. The inverse of
/// [`branch_has_reflog`](crate::git::remote)'s fail-safe on purpose: there, an
/// unrunnable probe must not unlock a degraded push; here, it must not unlock a
/// destructive offer.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRewriteStatus {
    /// `Some(true)` = the upstream tip is not in the branch's reflog.
    pub remote_rewritten: Option<bool>,
    /// Commits on the branch with NO patch-equivalent upstream — exactly the work
    /// a reset to the upstream would destroy.
    pub local_only: u32,
    /// Commits on the upstream with no patch-equivalent locally.
    pub remote_only: u32,
    /// Commits `--cherry-mark` matched by patch id. It counts BOTH sides' members
    /// of each pair (measured, git 2.51.1), so a clean N-commit rebase reports
    /// `2 * N` — user-facing copy must not present it as a commit count.
    pub patch_equal: u32,
    /// The upstream's short name (e.g. `origin/feature`).
    pub upstream: Option<String>,
    /// The upstream tip's sha. A confirmed reset targets THIS commit rather than
    /// re-resolving the ref, so it can only ever land on the state the user was
    /// shown — and it keeps `git_reset`'s hex-only validator intact.
    pub upstream_tip: Option<String>,
}

impl BranchRewriteStatus {
    /// The zeroed, verdict-less shape. It is what the PRE-VERDICT arms return —
    /// the ones that bail before any count exists (no upstream, unresolvable tip,
    /// unreadable or oversized counts). A sub-probe that fails AFTER the counts
    /// land does NOT come here: the reflog arm keeps its real counts and only
    /// leaves `remote_rewritten: None` (pinned by
    /// `rewrite_status_without_a_reflog_refuses_to_guess`).
    fn unknown() -> Self {
        Self {
            remote_rewritten: None,
            local_only: 0,
            remote_only: 0,
            patch_equal: 0,
            upstream: None,
            upstream_tip: None,
        }
    }
}

/// Classifies a diverged branch against its upstream. Read-only: every spawn is
/// a `rev-parse`/`rev-list`, so this is safe to call from a menu-open path.
#[tauri::command]
pub async fn git_branch_rewrite_status(
    repo_path: String,
    branch: String,
) -> AppResult<BranchRewriteStatus> {
    branch_rewrite_status(&repo_path, &branch).await
}

pub(crate) async fn branch_rewrite_status(
    repo_path: &str,
    branch: &str,
) -> AppResult<BranchRewriteStatus> {
    validate_branch_name(branch)?;
    let upstream_rev = format!("{branch}@{{upstream}}");

    // No upstream at all → nothing to compare against. `rev-parse` exits non-zero
    // and writes its own diagnostic; that is a normal answer here, not a failure.
    let short = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--abbrev-ref", &upstream_rev],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if short.code != 0 {
        return Ok(BranchRewriteStatus::unknown());
    }
    let upstream = short.stdout_lossy().trim().to_string();
    if upstream.is_empty() {
        return Ok(BranchRewriteStatus::unknown());
    }

    let tip_out = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{upstream_rev}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if tip_out.code != 0 {
        return Ok(BranchRewriteStatus::unknown());
    }
    let tip = tip_out.stdout_lossy().trim().to_string();
    if tip.is_empty() {
        return Ok(BranchRewriteStatus::unknown());
    }

    let range = format!("{branch}...{upstream_rev}");

    // Cheap size gate BEFORE the patch-id walk: `--cherry-mark` computes a patch id
    // for every commit on both sides, which means diffing each one, where a plain
    // left/right count only walks the graph.
    //
    // The two bounds are ASYMMETRIC because they answer different questions, and a
    // single sum-based bound gets the motivating case wrong: "Update branch →
    // rebase" on a branch forked far back leaves a handful of local commits against
    // a huge remote side (3 local vs ~253 remote is the reported shape), which a
    // combined 200 would refuse — disabling the feature exactly where it exists to
    // help. So the LOCAL side alone carries the copy bound, since it is the N in
    // "all N commits are already upstream", and the remote side is allowed to be
    // enormous.
    let sizes = run_git_raw(
        Some(repo_path),
        &["rev-list", "--left-right", "--count", &range],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if sizes.code != 0 {
        return Ok(BranchRewriteStatus::unknown());
    }
    if divergence_out_of_range(
        &sizes.stdout_lossy(),
        MAX_LOCAL_COMMITS_FOR_COPY,
        MAX_CHERRY_MARK_TOTAL,
    ) {
        return Ok(BranchRewriteStatus::unknown());
    }

    // Symmetric difference with patch-id matching: left = branch-only, right =
    // upstream-only, third = the patch-equal commits `--cherry-mark` paired off.
    let counts = run_git_raw(
        Some(repo_path),
        &[
            "rev-list",
            "--left-right",
            "--cherry-mark",
            "--count",
            &range,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if counts.code != 0 {
        return Ok(BranchRewriteStatus::unknown());
    }
    let Some((local_only, remote_only, patch_equal)) =
        parse_cherry_counts(&counts.stdout_lossy())
    else {
        return Ok(BranchRewriteStatus::unknown());
    };

    // `--walk-reflogs` lists the commit each of the branch's reflog entries names.
    // A branch with no reflog (core.logAllRefUpdates=false, or an expired one)
    // yields nothing to walk, which cannot distinguish anything — verdict stays
    // `None` rather than reading absence as a rewrite.
    let reflog = run_git_raw(
        Some(repo_path),
        &["rev-list", "--walk-reflogs", branch],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let reflog_text = reflog.stdout_lossy();
    let mut entries = reflog_text.lines().map(str::trim).filter(|l| !l.is_empty());
    let remote_rewritten = if reflog.code != 0 {
        None
    } else {
        let mut seen = false;
        let contains = entries.any(|l| {
            seen = true;
            l == tip
        });
        // `any` short-circuits, so a hit leaves `seen` true; a miss walked the
        // whole list and `seen` distinguishes "no entries" from "not found".
        if contains {
            Some(false)
        } else if seen {
            Some(true)
        } else {
            None
        }
    };

    Ok(BranchRewriteStatus {
        remote_rewritten,
        local_only,
        remote_only,
        patch_equal,
        upstream: Some(upstream),
        upstream_tip: Some(tip),
    })
}

/// Commits on the LOCAL side past which this probe stops being useful. Purely a
/// UI bound: it is the N in the confirm's "all N commits are already upstream",
/// and a branch carrying that many unique commits wants a rebase, not a one-click
/// reset. The REMOTE side is deliberately unbounded here — a branch forked far
/// back sits hundreds of commits behind by construction, which says nothing about
/// whether its own handful of commits were replayed.
const MAX_LOCAL_COMMITS_FOR_COPY: u32 = 200;

/// Total two-sided divergence past which the patch-id walk is refused on COST
/// alone — nothing to do with the copy. `--cherry-mark` diffs every commit on both
/// sides; this caps that work for a pathological range while staying far above any
/// shape the feature actually serves.
const MAX_CHERRY_MARK_TOTAL: u32 = 1000;

/// Whether a plain `rev-list --left-right --count` reply is outside the range this
/// probe will walk: more than `max_local` commits on the LOCAL side (a copy bound)
/// or more than `max_total` across both (a cost bound). An unreadable reply answers
/// `true` — the caller turns that into the no-verdict shape, the same "never guess"
/// direction that governs [`parse_cherry_counts`].
fn divergence_out_of_range(text: &str, max_local: u32, max_total: u32) -> bool {
    let mut nums = text.split_whitespace();
    let mut next = || nums.next()?.parse::<u32>().ok();
    match (next(), next()) {
        (Some(left), Some(right)) => {
            left > max_local || left.saturating_add(right) > max_total
        }
        _ => true,
    }
}

/// Parses `rev-list --left-right --cherry-mark --count`'s reply into
/// `(local_only, remote_only, patch_equal)`.
///
/// ALL THREE or nothing. A per-field default would fabricate `local_only == 0`,
/// which is half of the pair that unlocks the destructive reset offer — the one
/// value this must never invent, so an unreadable line answers `None` and the
/// whole status degrades to "nothing provable".
fn parse_cherry_counts(text: &str) -> Option<(u32, u32, u32)> {
    let mut nums = text.split_whitespace();
    let mut next = || nums.next()?.parse::<u32>().ok();
    Some((next()?, next()?, next()?))
}

/// Points a branch at its upstream's tip (`git branch -f`), the remedy when the
/// remote rewrote it and nothing local is unique. Never touches a working tree,
/// so it is the NON-current-branch half of the reset story; the current branch
/// goes through `git_reset` in `--hard` mode, which moves the tree too.
///
/// Refused with the holding worktree named when the branch is checked out
/// ANYWHERE — a linked worktree or this checkout itself: git refuses both, but
/// only after the caller has already framed the action as available.
///
/// `expected_tip` is the sha the caller measured and showed the user. The
/// upstream is re-resolved here and must still be at it, so a background fetch
/// that moved the ref while the confirmation sat open turns into a refusal
/// rather than a silent reset onto a state nobody approved.
#[tauri::command]
pub async fn git_branch_reset_to_upstream(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
    expected_tip: String,
) -> AppResult<()> {
    branch_reset_to_upstream(&state, &repo_path, &branch, &expected_tip).await
}

pub(crate) async fn branch_reset_to_upstream(
    state: &AppState,
    repo_path: &str,
    branch: &str,
    expected_tip: &str,
) -> AppResult<()> {
    validate_branch_name(branch)?;
    crate::git::history::validate_hash(expected_tip)?;
    let upstream_rev = format!("{branch}@{{upstream}}");
    let tip_out = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{upstream_rev}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if tip_out.code != 0 {
        return Err(AppError::InvalidArgument(format!(
            "{branch} has no upstream branch to reset to."
        )));
    }
    let tip = tip_out.stdout_lossy().trim().to_string();
    if tip != expected_tip {
        return Err(AppError::InvalidArgument(format!(
            "{branch}'s upstream moved since this was measured — reopen the branch \
             menu to see where it stands now."
        )));
    }

    // Pre-mutation guards: git refuses both of these itself, but only after the
    // user has confirmed a destructive action, and its wording names neither
    // remedy. The linked-worktree probe excludes THIS checkout, so the current
    // branch takes its own arm.
    if let Some(path) = worktree_holding_branch(repo_path, branch).await {
        return Err(AppError::Command(format!(
            "{branch} is checked out in the worktree at {path} — switch that worktree \
             to another branch (or remove it) before resetting {branch}."
        )));
    }
    let current = run_git_raw(
        Some(repo_path),
        &["symbolic-ref", "--short", "-q", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if current.code == 0 && current.stdout_lossy().trim() == branch {
        return Err(AppError::Command(format!(
            "{branch} is checked out here — use Reset to {branch}'s upstream from the \
             sync controls, which moves your working tree with it."
        )));
    }
    run_git_mutating(
        state,
        repo_path,
        &["branch", "-f", "--", branch, &tip],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Updates `branch` with the latest commits from `base` WITHOUT switching to it, so
/// the user's working tree — and any watchers (vite, `tsc --watch`) — never change.
///
/// - already contains `base` → no-op, `"up-to-date"`.
/// - strictly behind → fast-forward the ref, `"fast-forward"`.
/// - diverged → merge `base` in a throwaway worktree so the main checkout is
///   untouched, `"merge"`; a conflicting merge is aborted and the branch left as-is,
///   and a `branch` that moved while that worktree was materializing is refused.
///
/// When `branch` IS the current branch there's nothing to avoid switching to, so it
/// merges in place (conflicts surface in the changes list as usual — no abort).
#[tauri::command]
pub async fn git_update_branch_from(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
    base: String,
) -> AppResult<String> {
    update_branch_from(&state, &repo_path, &branch, &base).await
}

/// Testable core of [`git_update_branch_from`] — takes a plain `&AppState` so
/// real-repo tokio tests can drive it (mirrors `git::ops`' `*_core` pairs).
pub(crate) async fn update_branch_from(
    state: &AppState,
    repo_path: &str,
    branch: &str,
    base: &str,
) -> AppResult<String> {
    validate_branch_name(branch)?;
    validate_branch_name(base)?;
    if branch == base {
        return Err(AppError::InvalidArgument(
            "a branch can't be updated from itself".to_string(),
        ));
    }

    // Mutating refs — serialize against other writes to this repo's working tree.
    let domain = state.working_tree_lock(repo_path).await;
    let guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a branch update").await?;

    let current = run_git(
        Some(repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();

    // The current branch is already checked out, so just merge in place.
    if branch == current {
        let already_unmerged = crate::git::ops::unmerged_paths(repo_path).await;
        // Raw: a conflicted merge reports entirely on stdout and leaves stderr
        // empty (measured, git 2.51.1), which a stderr-only error renders as
        // "git exited with code 1". Lock-free runners only — the hold is ours.
        let out = run_git_raw(
            Some(repo_path),
            &["merge", "--no-edit", base],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if out.code != 0 {
            return Err(crate::git::ops::classify_failure(
                repo_path,
                "merge",
                &already_unmerged,
                out.code,
                out.full_failure_text(),
            )
            .await);
        }
        return Ok("merge".to_string());
    }

    // base already reachable from branch → nothing to bring in.
    let already = run_git_raw(
        Some(repo_path),
        &["merge-base", "--is-ancestor", base, branch],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if already.code == 0 {
        return Ok("up-to-date".to_string());
    }

    // branch reachable from base → pure fast-forward; move the ref directly.
    // `fetch .` refuses to touch a checked-out branch, but we've excluded the
    // current branch above, so this only ever updates an idle branch.
    let ff = run_git_raw(
        Some(repo_path),
        &["merge-base", "--is-ancestor", branch, base],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if ff.code == 0 {
        run_git(
            Some(repo_path),
            &["fetch", ".", &format!("{base}:{branch}")],
            DEFAULT_TIMEOUT,
        )
        .await?;
        return Ok("fast-forward".to_string());
    }

    // Diverged → merge in a throwaway worktree so the user's checkout is untouched.
    // Both ends are pinned under THIS hold, because the worktree steps below run in
    // the worktree-admin domain, which nests with no other: the working-tree lock is
    // released across them, so either ref can move meanwhile.
    let Some(branch_tip) = branch_tip_sha(repo_path, branch).await? else {
        return Err(AppError::InvalidArgument(format!("unknown branch: {branch}")));
    };
    let base_out = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{base}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if base_out.code != 0 {
        return Err(AppError::InvalidArgument(format!("unknown branch: {base}")));
    }
    let pins = UpdatePins {
        branch_tip,
        base_sha: base_out.stdout_lossy().trim().to_string(),
    };
    drop(guard);

    let tmp = std::env::temp_dir().join(format!("gd-update-{}", unique_suffix()));
    let tmp_str = tmp.to_string_lossy().to_string();
    merge_diverged_in_worktree(state, repo_path, &tmp_str, branch, base, &pins).await
}

/// The two refs an update is planned against, resolved under the first working-tree
/// hold so nothing that moves afterwards can change what lands on the branch.
struct UpdatePins {
    branch_tip: String,
    base_sha: String,
}

/// The sha `refs/heads/<branch>` points at, or `None` when there is no such branch.
/// The FULL ref path is the point: under a bare `rev-parse <branch>` a tag sharing
/// the name would shadow it, and the pin would then guard the wrong object.
async fn branch_tip_sha(repo_path: &str, branch: &str) -> AppResult<Option<String>> {
    let out = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(None);
    }
    Ok(Some(out.stdout_lossy().trim().to_string()))
}

/// The diverged arm, run with the working-tree lock RELEASED: `worktree
/// add/remove/prune` belong to the worktree-admin domain, which nests with no other,
/// and materializing a whole checkout takes minutes that staging must not queue
/// behind.
///
/// The add is bounded, so a concurrent removal's prune yields an explained `Busy`
/// instead of an interleaved write to `.git/worktrees/`. Every path out of the merge
/// — refusal, conflict, success — reaches the teardown below.
async fn merge_diverged_in_worktree(
    state: &AppState,
    repo_path: &str,
    tmp: &str,
    branch: &str,
    base: &str,
    pins: &UpdatePins,
) -> AppResult<String> {
    run_git_worktree_admin(
        state,
        repo_path,
        &["worktree", "add", "--quiet", tmp, branch],
        WORKTREE_OP_TIMEOUT,
    )
    .await?;

    let result = verify_pin_and_merge(state, repo_path, tmp, branch, base, pins).await;

    // Try-then-detach is the only teardown shape with no bad arm: a bounded acquire
    // that gave up on `Busy` would leak the throwaway worktree, and a synchronous
    // unbounded one holds a finished update's command hostage for the minutes a
    // node_modules-scale removal can hold the shared admin domain.
    let domain = state.worktree_admin_lock(repo_path).await;
    match try_acquire_repo_lock(&domain, "a worktree operation") {
        Some(_admin) => remove_tmp_worktree(repo_path, tmp).await,
        None => {
            let (repo, tmp) = (repo_path.to_string(), tmp.to_string());
            tauri::async_runtime::spawn(async move {
                let _admin = acquire_repo_lock_unbounded(&domain, "a worktree operation").await;
                remove_tmp_worktree(&repo, &tmp).await;
            });
        }
    }

    result
}

/// `worktree remove --force` then `prune`, both best-effort and both lock-free: every
/// caller already holds the worktree-admin domain.
async fn remove_tmp_worktree(repo_path: &str, tmp: &str) {
    let _ = run_git_raw(
        Some(repo_path),
        &["worktree", "remove", "--force", tmp],
        WORKTREE_OP_TIMEOUT,
    )
    .await;
    let _ = run_git_raw(Some(repo_path), &["worktree", "prune"], DEFAULT_TIMEOUT).await;
}

/// Under a fresh working-tree hold: confirm both pinned refs still stand, then merge
/// `base` by NAME inside the throwaway worktree at `tmp`. The merge writes the shared
/// `refs/heads/<branch>`, which is why it belongs in this domain, and the name is what
/// gives the merge commit its `Merge branch '<base>'` subject; the pins are what keep
/// a ref that moved while the worktree materialized from silently changing the
/// operation. The hold covers writers on THIS checkout only — another worktree of the
/// same repo takes its own working-tree lock, and a session-worktree removal deletes
/// refs under the admin hold, so a cross-checkout mover is outside what it promises.
async fn verify_pin_and_merge(
    state: &AppState,
    repo_path: &str,
    tmp: &str,
    branch: &str,
    base: &str,
    pins: &UpdatePins,
) -> AppResult<String> {
    let domain = state.working_tree_lock(repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a branch update").await?;

    if branch_tip_sha(repo_path, branch).await?.as_deref() != Some(pins.branch_tip.as_str()) {
        return Err(AppError::Command(format!(
            "{branch} moved while this update was running — try again to see where it stands."
        )));
    }

    // The base check runs in the TMP worktree's cwd — the $GIT_DIR the merge itself
    // will resolve in. gitrevisions resolves $GIT_DIR-local names (HEAD, MERGE_HEAD, …)
    // ahead of `refs/heads/`, and `validate_branch_name` admits a literal "HEAD", so a
    // check in the main checkout could pass over a different object than the merge
    // takes. Same cwd makes "whatever the merge resolves" provably the pinned commit.
    let base_now = run_git_raw(
        Some(tmp),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{base}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if base_now.code != 0 || base_now.stdout_lossy().trim() != pins.base_sha {
        return Err(AppError::Command(format!(
            "{base} moved while this update was running — try again to see where it stands."
        )));
    }

    // The merge keeps the default budget: it rewrites only the differing files, not
    // the whole tree. Lock-free runner — the hold is ours.
    let merged = run_git(Some(tmp), &["merge", "--no-edit", base], DEFAULT_TIMEOUT).await;
    match merged {
        Ok(_) => Ok("merge".to_string()),
        Err(_) => {
            // Undo the half-done merge so the branch ref is left as it was.
            let _ = run_git_raw(Some(tmp), &["merge", "--abort"], DEFAULT_TIMEOUT).await;
            Err(AppError::InvalidArgument(format!(
                "{branch} has changes that conflict with {base}. Switch to {branch} to merge and resolve them."
            )))
        }
    }
}

/// Whether a commit is reachable from any remote-tracking ref (`refs/remotes/*`) —
/// i.e. it has been pushed. Gates the History-tab commit-comment surface, which can
/// only anchor a comment on a commit the forge already knows about. The sha is
/// validated (hex) BEFORE spawning git; a VALID sha the repo doesn't recognise
/// (unfetched / unpushed) makes git error, which we map to `Ok(false)` — "not on a
/// remote" is a normal answer here, not an app failure.
#[tauri::command]
pub async fn commit_on_remote(repo_path: String, sha: String) -> AppResult<bool> {
    crate::git::history::validate_hash(&sha)?;
    let out = run_git_raw(
        Some(&repo_path),
        &[
            "for-each-ref",
            "refs/remotes",
            "--contains",
            &sha,
            "--format=%(refname)",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(false);
    }
    Ok(!out.stdout_lossy().trim().is_empty())
}

/// Count of commits reachable from `HEAD` but not from any remote-tracking ref —
/// i.e. unpublished anywhere. The History tab uses this to mark "not pushed" rows on
/// a branch with NO upstream, where "ahead of upstream" is undefined: the fork point
/// and everything below it live on `origin/<base>` and ARE published. A repo with no
/// remotes yields the full `HEAD` count (correct); a benign git error (unborn `HEAD`)
/// maps to `0`.
#[tauri::command]
pub async fn git_unpushed_count(repo_path: String) -> AppResult<u32> {
    let out = run_git_raw(
        Some(&repo_path),
        &["rev-list", "--count", "HEAD", "--not", "--remotes"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(0);
    }
    Ok(out.stdout_lossy().trim().parse().unwrap_or(0))
}

/// A process-unique suffix for the throwaway worktree directory name.
fn unique_suffix() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{}", std::process::id(), nanos)
}

#[cfg(test)]
mod tests {
    use super::{
        branch_reset_to_upstream, branch_rewrite_status, build_create_branch_args,
        divergence_out_of_range, git_branch_merge_states, git_branches, git_create_branch_core,
        git_default_branch, git_rename_branch_core, merge_diverged_in_worktree,
        parse_cherry_counts, parse_upstream_track, update_branch_from, validate_branch_name,
        validate_ref_name, BranchRewriteStatus, MergePair, UpdatePins,
    };
    use crate::error::AppError;
    use crate::git::runner::{acquire_repo_lock, run_git, run_git_raw, DEFAULT_TIMEOUT};
    use crate::state::AppState;
    use std::time::Duration;

    // Full decision table for the create-branch argv: checkout × start_point ×
    // no_track (8 cases). The no_track=false rows are a regression guard — their argv
    // must not change.
    #[test]
    fn build_create_branch_args_checkout_no_start_no_track() {
        assert_eq!(
            build_create_branch_args("feat", true, None, false),
            vec!["switch", "-c", "feat"]
        );
    }

    #[test]
    fn build_create_branch_args_checkout_start_no_track() {
        assert_eq!(
            build_create_branch_args("feat", true, Some("main"), false),
            vec!["switch", "-c", "feat", "main"]
        );
    }

    #[test]
    fn build_create_branch_args_checkout_no_start_track_off() {
        assert_eq!(
            build_create_branch_args("feat", true, None, true),
            vec!["switch", "--no-track", "-c", "feat"]
        );
    }

    #[test]
    fn build_create_branch_args_checkout_remote_start_track_off() {
        // The motivating case: `git switch --no-track -c feat origin/epic/x`.
        assert_eq!(
            build_create_branch_args("feat", true, Some("origin/epic/x"), true),
            vec!["switch", "--no-track", "-c", "feat", "origin/epic/x"]
        );
    }

    #[test]
    fn build_create_branch_args_no_checkout_no_start_no_track() {
        assert_eq!(
            build_create_branch_args("feat", false, None, false),
            vec!["branch", "--", "feat"]
        );
    }

    #[test]
    fn build_create_branch_args_no_checkout_start_no_track() {
        assert_eq!(
            build_create_branch_args("feat", false, Some("main"), false),
            vec!["branch", "--", "feat", "main"]
        );
    }

    #[test]
    fn build_create_branch_args_no_checkout_no_start_track_off() {
        // `--no-track` must come BEFORE the `--`.
        assert_eq!(
            build_create_branch_args("feat", false, None, true),
            vec!["branch", "--no-track", "--", "feat"]
        );
    }

    #[test]
    fn build_create_branch_args_no_checkout_remote_start_track_off() {
        assert_eq!(
            build_create_branch_args("feat", false, Some("origin/epic/x"), true),
            vec!["branch", "--no-track", "--", "feat", "origin/epic/x"]
        );
    }

    #[test]
    fn validate_ref_name_rejects_glob_and_refspec_metacharacters() {
        // `*` would otherwise glob-match via `for-each-ref refs/heads/*` and
        // mirror-push every branch through a wildcard push refspec.
        for bad in ["*", "feat*", "a?b", "a[b", "a:b", "a\\b", "a b", "x\u{7f}"] {
            assert!(validate_ref_name(bad).is_err(), "should reject {bad:?}");
        }
        assert!(validate_ref_name("").is_err());
        assert!(validate_ref_name("-x").is_err());
    }

    #[test]
    fn validate_ref_name_accepts_names_and_rev_start_points() {
        // Real branch names AND rev-expression start points (this validator guards
        // git_create_branch's start_point too) must keep passing.
        for ok in [
            "feature", "feat/x", "origin/feat", "release-1.0",
            "main~3", "HEAD", "HEAD@{2}", "abc123def",
        ] {
            assert!(validate_ref_name(ok).is_ok(), "should accept {ok:?}");
        }
    }

    #[test]
    fn validate_branch_name_rejects_rev_expressions_ref_name_accepts() {
        // The whole point of the stricter gate: `~`/`^` shapes RESOLVE under
        // `rev-parse --verify refs/heads/…`, so an existence probe alone passes
        // them and the caller proceeds against an ancestor commit.
        for bad in ["feature~1", "main^", "HEAD@{1}", "main..other", "a^{commit}", "@"] {
            assert!(validate_ref_name(bad).is_ok(), "ref gate accepts {bad:?}");
            assert!(
                validate_branch_name(bad).is_err(),
                "branch gate should reject {bad:?}"
            );
        }
        // Refspec metacharacters stay rejected, and real branch names stay valid.
        assert!(validate_branch_name("a*b").is_err());
        for ok in ["feature", "feat/x", "release-1.0", "fix_123"] {
            assert!(validate_branch_name(ok).is_ok(), "should accept {ok:?}");
        }
    }

    #[test]
    fn parses_ahead_and_behind() {
        assert_eq!(parse_upstream_track("[ahead 1, behind 2]"), (1, 2, false));
    }

    #[test]
    fn parses_ahead_only() {
        assert_eq!(parse_upstream_track("[ahead 1]"), (1, 0, false));
    }

    #[test]
    fn parses_behind_only() {
        assert_eq!(parse_upstream_track("[behind 2]"), (0, 2, false));
    }

    #[test]
    fn gone_upstream_is_zero() {
        // `[gone]` reports the deleted-upstream bit with zeroed counts.
        assert_eq!(parse_upstream_track("[gone]"), (0, 0, true));
    }

    #[test]
    fn empty_or_unparseable_is_zero() {
        assert_eq!(parse_upstream_track(""), (0, 0, false));
        assert_eq!(parse_upstream_track("   "), (0, 0, false));
        assert_eq!(parse_upstream_track("garbage"), (0, 0, false));
    }

    // --- Real-repo test for the `--no-track` seam (temp_dir, git on PATH). ---

    async fn run(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// A unique temp base dir for a test — the returned `TempDir` guard removes it
    /// on Drop, so a panicking or killed run cannot leak the fixture.
    fn temp_base(tag: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-branches-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    async fn init_repo(repo_s: &str, seed_file: &str) {
        run(repo_s, &["init", "-q"]).await;
        run(repo_s, &["config", "user.email", "t@t.local"]).await;
        run(repo_s, &["config", "user.name", "T"]).await;
        std::fs::write(std::path::Path::new(repo_s).join(seed_file), "hello\n").unwrap();
        run(repo_s, &["add", "-A"]).await;
        run(repo_s, &["commit", "-qm", "seed"]).await;
    }

    /// Drives `git_create_branch_core` against a real repo to prove git honors the
    /// `--no-track` placement the argv table pins. Synthesizes a remote-tracking ref
    /// (`refs/remotes/origin/x` via `update-ref`, so nothing is ever fetched) and bases
    /// two branches on it: the `no_track=true` arm must have NO upstream, the control
    /// arm must track `origin/x`. Both use `checkout=false` to keep assertions simple —
    /// the checkout arm shares the same `--no-track` placement per the argv table.
    #[tokio::test]
    async fn create_branch_honors_no_track_against_real_repo() {
        let (_base, base) = temp_base("no-track");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&repo_s, "r.txt").await;
        // A remote named `origin` (URL is the repo's own path — never fetched) and
        // a synthetic remote-tracking ref pointing at HEAD.
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/x", "HEAD"]).await;

        let state = AppState::default();

        // no-track arm: branch `y` from `origin/x` with tracking suppressed.
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "y".into(),
            false,
            Some("origin/x".into()),
            true,
        )
        .await
        .expect("create y succeeds");
        // No upstream → `y@{upstream}` fails to resolve.
        assert!(
            run_git(
                Some(&repo_s),
                &["rev-parse", "--abbrev-ref", "y@{upstream}"],
                DEFAULT_TIMEOUT,
            )
            .await
            .is_err(),
            "no-track branch y must have no upstream"
        );
        // But it still starts at origin/x's tip.
        assert_eq!(
            run(&repo_s, &["rev-parse", "y"]).await.trim(),
            run(&repo_s, &["rev-parse", "origin/x"]).await.trim(),
            "y should start at origin/x"
        );

        // Pin the tracking mode repo-locally: an ambient global
        // `branch.autoSetupMerge = simple|false` leaves `z` untracked and false-fails
        // this control arm. The `--no-track` arm is immune — the flag overrides config.
        run(&repo_s, &["config", "branch.autoSetupMerge", "true"]).await;

        // control arm: branch `z` from `origin/x` with tracking left on.
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "z".into(),
            false,
            Some("origin/x".into()),
            false,
        )
        .await
        .expect("create z succeeds");
        // Upstream resolves and IS origin/x.
        assert_eq!(
            run(&repo_s, &["rev-parse", "--abbrev-ref", "z@{upstream}"])
                .await
                .trim(),
            "origin/x",
            "z should track origin/x"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "z"]).await.trim(),
            run(&repo_s, &["rev-parse", "origin/x"]).await.trim(),
            "z should start at origin/x"
        );
    }

    /// `git_branches` must surface git's authoritative `%(upstream:remotename)`
    /// on each branch: a tracked branch carries its remote, an untracked one
    /// carries none. This is the single source of truth the UI reads instead of
    /// re-deriving the remote from the upstream string.
    #[tokio::test]
    async fn git_branches_reports_upstream_remote() {
        let (_base, base) = temp_base("upstream-remote");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&repo_s, "r.txt").await;
        // A remote named `origin` (URL is the repo's own path — never fetched) and
        // a synthetic remote-tracking ref pointing at HEAD.
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/x", "HEAD"]).await;

        let state = AppState::default();
        // Pin tracking mode repo-locally so an ambient global
        // `branch.autoSetupMerge = simple|false` can't leave `tracked` untracked.
        run(&repo_s, &["config", "branch.autoSetupMerge", "true"]).await;
        // Tracked branch `tracked` → tracks origin/x.
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "tracked".into(),
            false,
            Some("origin/x".into()),
            false,
        )
        .await
        .expect("create tracked succeeds");
        // Untracked branch `solo` → based on the same ref with tracking suppressed.
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "solo".into(),
            false,
            Some("origin/x".into()),
            true,
        )
        .await
        .expect("create solo succeeds");

        let branches = git_branches(repo_s.clone()).await.expect("list branches");
        let tracked = branches
            .iter()
            .find(|b| b.name == "tracked")
            .expect("tracked branch present");
        assert_eq!(
            tracked.upstream_remote.as_deref(),
            Some("origin"),
            "a tracked branch carries its upstream's remote"
        );
        let solo = branches
            .iter()
            .find(|b| b.name == "solo")
            .expect("solo branch present");
        assert_eq!(
            solo.upstream_remote, None,
            "an untracked branch carries no upstream remote"
        );
    }

    /// `git clone -o upstream` writes `refs/remotes/upstream/HEAD` and no origin ref
    /// at all, so resolution has to consult whatever remotes the repo actually has.
    /// The source branch is named `trunk` — a name the local main/master fallback
    /// can never produce, so only the remote HEAD can satisfy this.
    #[tokio::test]
    async fn default_branch_resolves_a_clone_whose_remote_isnt_origin() {
        let (_base, base) = temp_base("default-branch-upstream");
        let src = base.join("src");
        std::fs::create_dir_all(&src).unwrap();
        let src_s = src.to_string_lossy().into_owned();
        init_repo(&src_s, "r.txt").await;
        run(&src_s, &["branch", "-m", "trunk"]).await;

        let clone_s = base.join("clone").to_string_lossy().into_owned();
        run_git(
            None,
            &["clone", "-q", "-o", "upstream", &src_s, &clone_s],
            DEFAULT_TIMEOUT,
        )
        .await
        .expect("local clone succeeds");

        assert_eq!(
            git_default_branch(clone_s).await.expect("resolves"),
            Some("trunk".to_string()),
            "the only remote's HEAD answers even when it isn't named origin"
        );
    }

    /// With several remotes, origin still wins — it is tried before the others
    /// regardless of where `git remote` lists it.
    #[tokio::test]
    async fn default_branch_prefers_origin_over_other_remotes() {
        let (_base, base) = temp_base("default-branch-origin-wins");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&repo_s, "r.txt").await;
        // URLs are the repo's own path — nothing is ever fetched; the HEAD symrefs
        // are written by hand, exactly as a clone would leave them. `canonical` sorts
        // before `origin`, so it is the remote a naive "first listed wins" would pick.
        for remote in ["canonical", "origin"] {
            run(&repo_s, &["remote", "add", remote, &repo_s]).await;
            let head = format!("refs/remotes/{remote}/{remote}-head");
            run(&repo_s, &["update-ref", &head, "HEAD"]).await;
            run(
                &repo_s,
                &[
                    "symbolic-ref",
                    &format!("refs/remotes/{remote}/HEAD"),
                    &head,
                ],
            )
            .await;
        }
        assert!(
            run(&repo_s, &["remote"])
                .await
                .trim()
                .starts_with("canonical"),
            "fixture must list a non-origin remote first for this to discriminate"
        );

        assert_eq!(
            git_default_branch(repo_s).await.expect("resolves"),
            Some("origin-head".to_string()),
            "origin's HEAD wins over another remote's"
        );
    }

    /// No remote HEAD to read: local `main`/`master` answer, anything else is `None`.
    /// A remote whose HEAD symref was never written (a hand-added one) must fall
    /// through here rather than reaching for the network.
    #[tokio::test]
    async fn default_branch_falls_back_to_local_names() {
        let (_base, base) = temp_base("default-branch-fallback");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();

        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", "-m", "master"]).await;
        assert_eq!(
            git_default_branch(repo_s.clone()).await.expect("resolves"),
            Some("master".to_string()),
            "a remote-less repo falls back to its local master"
        );

        run(&repo_s, &["remote", "add", "upstream", &repo_s]).await;
        run(&repo_s, &["branch", "-m", "topic"]).await;
        assert_eq!(
            git_default_branch(repo_s).await.expect("resolves"),
            None,
            "a remote with no HEAD symref and no main/master resolves to nothing"
        );
    }

    /// "Update from main" on the branch you are ON merges in place, so a conflict
    /// is a PAUSED merge in the user's own checkout — the app has to hand back
    /// git's CONFLICT list and leave the tree mid-merge for the banner to drive.
    /// The conflicted merge writes all of that to stdout with stderr EMPTY, which
    /// is what a stderr-only error turned into "git exited with code 1".
    #[tokio::test]
    async fn update_branch_from_in_place_conflict_names_the_paused_merge() {
        let (_base, base) = temp_base("update-in-place-conflict");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;

        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["switch", "-qc", "feature"]).await;
        std::fs::write(repo.join("a.txt"), "feature-side\n").unwrap();
        run(&repo_s, &["commit", "-qam", "feature edit"]).await;
        run(&repo_s, &["switch", "-q", &main]).await;
        std::fs::write(repo.join("a.txt"), "main-side\n").unwrap();
        run(&repo_s, &["commit", "-qam", "main edit"]).await;

        let state = AppState::default();
        let err = update_branch_from(&state, &repo_s, &main, "feature")
            .await
            .unwrap_err();
        let AppError::Conflict { op, paths, report } = &err else {
            panic!("expected a conflict error, got {err:?}");
        };
        assert_eq!(op, "merge");
        assert_eq!(paths, &vec!["a.txt".to_string()]);
        assert!(
            report.contains("CONFLICT (content): Merge conflict in a.txt"),
            "git's conflict list must survive: {report}"
        );
        assert!(
            crate::git::ops::op_state(&repo_s).await.unwrap().merging,
            "the merge is left in progress for the conflict banner to finish"
        );
    }

    /// End-to-end: a real `branch -m` through the core carries the branch's reviewer
    /// note to the new name. Both the deposit and the assertion go through
    /// `review_notes::store_path`, whose cfg(test) arm keeps them off the developer's
    /// real store; the identity key is this fixture's own git dir, so the shared test
    /// store file can't collide with another test's entries.
    #[tokio::test]
    async fn rename_carries_the_reviewer_note_to_the_new_branch() {
        let (_base, base) = temp_base("rename-review-note");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", "feature"]).await;

        let identity = crate::git::repo::repo_identity(&repo_s).await;
        crate::review_notes::set(&identity, "feature", "look at the migration")
            .await
            .expect("deposit the note");

        let state = AppState::default();
        git_rename_branch_core(&state, repo_s.clone(), "feature".into(), "renamed".into())
            .await
            .expect("rename succeeds");

        assert!(
            run(&repo_s, &["branch", "--list", "renamed"])
                .await
                .contains("renamed"),
            "the branch itself was renamed"
        );
        assert_eq!(
            crate::review_notes::note_body(&identity, "renamed").as_deref(),
            Some("look at the migration"),
            "the note reads back under the new name"
        );
        assert_eq!(
            crate::review_notes::note_body(&identity, "feature"),
            None,
            "and is gone under the old one"
        );
    }

    // --- Rewrite-aware divergence (`git_branch_rewrite_status`). ---

    /// Builds the shape a server-side rebase leaves behind and returns the local
    /// clone's path: a bare `remote`, a `server` clone that rebases `feature` onto
    /// an advanced `main` and force-pushes it, and a `local` clone that has the
    /// PRE-rebase commits on `feature` plus a fetched view of the rewritten
    /// upstream. `local/feature` ends up 2 ahead / 3 behind `origin/feature`, with
    /// both of its commits patch-equal to the rewritten pair.
    async fn server_rebase_fixture(base: &std::path::Path) -> String {
        let remote_s = base.join("remote").to_string_lossy().into_owned();
        run_git(
            None,
            &["init", "-q", "--bare", "-b", "main", &remote_s],
            DEFAULT_TIMEOUT,
        )
        .await
        .expect("init bare remote");

        let server = base.join("server");
        let server_s = server.to_string_lossy().into_owned();
        run_git(None, &["clone", "-q", &remote_s, &server_s], DEFAULT_TIMEOUT)
            .await
            .expect("clone server");
        run(&server_s, &["config", "user.email", "t@t.local"]).await;
        run(&server_s, &["config", "user.name", "T"]).await;
        std::fs::write(server.join("seed.txt"), "seed\n").unwrap();
        run(&server_s, &["add", "-A"]).await;
        run(&server_s, &["commit", "-qm", "seed"]).await;
        run(&server_s, &["push", "-q", "origin", "main"]).await;

        let local = base.join("local");
        let local_s = local.to_string_lossy().into_owned();
        run(&remote_s, &["symbolic-ref", "HEAD", "refs/heads/main"]).await;
        run_git(None, &["clone", "-q", &remote_s, &local_s], DEFAULT_TIMEOUT)
            .await
            .expect("clone local");
        run(&local_s, &["config", "user.email", "t@t.local"]).await;
        run(&local_s, &["config", "user.name", "T"]).await;
        run(&local_s, &["switch", "-qc", "feature"]).await;
        for n in ["one", "two"] {
            std::fs::write(local.join(format!("{n}.txt")), format!("{n}\n")).unwrap();
            run(&local_s, &["add", "-A"]).await;
            run(&local_s, &["commit", "-qm", &format!("feat {n}")]).await;
        }
        run(&local_s, &["push", "-q", "-u", "origin", "feature"]).await;

        // The server advances main, rebases feature onto it, and force-pushes —
        // GitHub's "Update branch → rebase" in miniature.
        run(&server_s, &["fetch", "-q", "origin"]).await;
        std::fs::write(server.join("main.txt"), "main moved\n").unwrap();
        run(&server_s, &["add", "-A"]).await;
        run(&server_s, &["commit", "-qm", "main moves"]).await;
        run(&server_s, &["push", "-q", "origin", "main"]).await;
        run(&server_s, &["switch", "-qc", "feature", "origin/feature"]).await;
        run(&server_s, &["rebase", "-q", "main"]).await;
        run(&server_s, &["push", "-q", "--force", "origin", "feature"]).await;

        run(&local_s, &["fetch", "-q", "origin"]).await;
        local_s
    }

    /// The motivating case: the remote rebased this branch. Nothing local is
    /// unique (both commits have patch-twins upstream) and the rewritten upstream
    /// tip was never in the branch's reflog, so the verdict is a rewrite and a
    /// reset-to-upstream is safe to offer.
    #[tokio::test]
    async fn rewrite_status_detects_a_server_side_rebase() {
        let (_base, base) = temp_base("rewrite-server-rebase");
        let local_s = server_rebase_fixture(&base).await;

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            st.remote_rewritten,
            Some(true),
            "the rewritten upstream tip is absent from the branch's reflog"
        );
        assert_eq!(
            st.local_only, 0,
            "every local commit has a patch-equivalent upstream — nothing unique to lose"
        );
        assert_eq!(
            st.remote_only, 1,
            "only the commit the server added to main is genuinely remote-only"
        );
        // `--cherry-mark` counts BOTH members of each matched pair.
        assert_eq!(st.patch_equal, 4, "two commits matched on two sides");
        assert_eq!(st.upstream.as_deref(), Some("origin/feature"));
        assert_eq!(
            st.upstream_tip.as_deref(),
            Some(run(&local_s, &["rev-parse", "origin/feature"]).await.trim()),
            "the tip a confirmed reset would land on"
        );
    }

    /// NEGATIVE CONTROL for the reflog containment probe. The rewrite verdict must
    /// come from the reflog walk and nothing else: with the branch's reflog removed,
    /// the same fixture — identical counts — must stop claiming a rewrite rather
    /// than fall back to inferring one from `local_only == 0`.
    #[tokio::test]
    async fn rewrite_status_without_a_reflog_refuses_to_guess() {
        let (_base, base) = temp_base("rewrite-no-reflog");
        let local_s = server_rebase_fixture(&base).await;
        std::fs::remove_file(
            std::path::Path::new(&local_s)
                .join(".git")
                .join("logs")
                .join("refs")
                .join("heads")
                .join("feature"),
        )
        .expect("drop the branch reflog");

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            st.remote_rewritten, None,
            "no reflog to walk proves nothing — the UI must stay ordinary"
        );
        assert_eq!(
            (st.local_only, st.remote_only),
            (0, 1),
            "the counts are unchanged, so only the reflog can be driving the verdict"
        );
    }

    /// A commit made locally AFTER the rewrite lands is unique work: `local_only`
    /// must rise above zero so the UI withholds the reset offer.
    #[tokio::test]
    async fn rewrite_status_counts_genuinely_local_commits() {
        let (_base, base) = temp_base("rewrite-local-work");
        let local_s = server_rebase_fixture(&base).await;
        std::fs::write(
            std::path::Path::new(&local_s).join("mine.txt"),
            "unique\n",
        )
        .unwrap();
        run(&local_s, &["add", "-A"]).await;
        run(&local_s, &["commit", "-qm", "my own work"]).await;

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            st.local_only, 1,
            "the new commit has no patch-twin upstream — resetting would destroy it"
        );
        assert_eq!(st.remote_rewritten, Some(true));
    }

    /// The discriminating positive case: a branch whose reflog DOES hold the
    /// upstream tip (it was created there and only moved forward). Without this,
    /// a probe that answered "rewritten" for every branch with a reflog would go
    /// unnoticed — the rewrite tests alone can't tell the two apart.
    #[tokio::test]
    async fn rewrite_status_clears_a_branch_that_has_seen_its_upstream() {
        let (_base, base) = temp_base("rewrite-seen-upstream");
        let local_s = server_rebase_fixture(&base).await;
        // Adopt the rewritten upstream, then commit on top: the branch is now
        // plainly ahead, and its reflog holds the current upstream tip.
        run(&local_s, &["reset", "-q", "--hard", "origin/feature"]).await;
        std::fs::write(
            std::path::Path::new(&local_s).join("after.txt"),
            "after\n",
        )
        .unwrap();
        run(&local_s, &["add", "-A"]).await;
        run(&local_s, &["commit", "-qm", "after the rebase"]).await;

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            st.remote_rewritten,
            Some(false),
            "the upstream tip is in this branch's reflog — nothing was rewritten under it"
        );
        assert_eq!((st.local_only, st.remote_only), (1, 0));
    }

    /// ORDINARY divergence — a teammate pushed while you committed, no rewrite
    /// anywhere. The reflog verdict reads `Some(true)` here too (you have never
    /// been at that remote tip), which is exactly why no surface may treat the
    /// verdict alone as a rewrite: what separates the two is `patchEqual`, zero
    /// here and non-zero whenever commits were actually replayed.
    #[tokio::test]
    async fn rewrite_status_says_true_for_ordinary_divergence_with_no_twins() {
        let (_base, base) = temp_base("rewrite-ordinary");
        let local_s = server_rebase_fixture(&base).await;
        // Start from a synced state, then diverge for real: one commit each side
        // of `feature`, touching different files so nothing is patch-equal.
        run(&local_s, &["reset", "-q", "--hard", "origin/feature"]).await;
        let server_s = base.join("server").to_string_lossy().into_owned();
        std::fs::write(base.join("server").join("theirs.txt"), "theirs\n").unwrap();
        run(&server_s, &["add", "-A"]).await;
        run(&server_s, &["commit", "-qm", "their work"]).await;
        run(&server_s, &["push", "-q", "origin", "feature"]).await;
        std::fs::write(
            std::path::Path::new(&local_s).join("mine.txt"),
            "mine\n",
        )
        .unwrap();
        run(&local_s, &["add", "-A"]).await;
        run(&local_s, &["commit", "-qm", "my work"]).await;
        run(&local_s, &["fetch", "-q", "origin"]).await;

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            st.remote_rewritten,
            Some(true),
            "an unseen remote tip reads the same whether or not anything was rewritten"
        );
        assert_eq!((st.local_only, st.remote_only), (1, 1));
        assert_eq!(
            st.patch_equal, 0,
            "no patch twins — the discriminator between this and a rewrite"
        );
    }

    /// A branch with no upstream has nothing to be rewritten against, and the
    /// answer must be the same "nothing provable" shape as a failed probe.
    #[tokio::test]
    async fn rewrite_status_without_an_upstream_is_unknown() {
        let (_base, base) = temp_base("rewrite-no-upstream");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["switch", "-qc", "solo"]).await;

        let st = branch_rewrite_status(&repo_s, "solo")
            .await
            .expect("status resolves");
        assert_eq!(st.remote_rewritten, None);
        assert_eq!(st.upstream, None);
        assert_eq!(st.upstream_tip, None);
    }

    /// The wire names the TS `BranchRewriteStatus` mirror reads. `rename_all` does
    /// NOT cover a struct's fields by inheritance from anywhere else, so the
    /// camelCase keys are pinned here or the frontend reads `undefined` silently.
    #[test]
    fn rewrite_status_serializes_to_the_camel_case_wire_shape() {
        let json = serde_json::to_string(&BranchRewriteStatus {
            remote_rewritten: Some(true),
            local_only: 0,
            remote_only: 1,
            patch_equal: 4,
            upstream: Some("origin/feature".into()),
            upstream_tip: Some("abc123".into()),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"remoteRewritten":true,"localOnly":0,"remoteOnly":1,"patchEqual":4,"upstream":"origin/feature","upstreamTip":"abc123"}"#
        );
        assert_eq!(
            serde_json::to_string(&BranchRewriteStatus::unknown()).unwrap(),
            r#"{"remoteRewritten":null,"localOnly":0,"remoteOnly":0,"patchEqual":0,"upstream":null,"upstreamTip":null}"#
        );
    }

    /// The non-current-branch remedy moves the ref and leaves the working tree —
    /// and the branch you are actually on — untouched.
    #[tokio::test]
    async fn reset_to_upstream_moves_an_idle_branch() {
        let (_base, base) = temp_base("reset-upstream-idle");
        let local_s = server_rebase_fixture(&base).await;
        // Step off `feature` so it is idle; `main` tracks origin/main already.
        run(&local_s, &["switch", "-q", "main"]).await;
        let target = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();
        let head_before = run(&local_s, &["rev-parse", "HEAD"]).await.trim().to_string();

        let state = AppState::default();
        branch_reset_to_upstream(&state, &local_s, "feature", &target)
            .await
            .expect("reset succeeds");

        assert_eq!(
            run(&local_s, &["rev-parse", "feature"]).await.trim(),
            target,
            "the branch now points at the upstream tip"
        );
        assert_eq!(
            run(&local_s, &["rev-parse", "HEAD"]).await.trim(),
            head_before,
            "the checked-out branch never moved"
        );
    }

    /// The pre-mutation guard: a branch checked out in ANOTHER worktree can't be
    /// force-updated, and the refusal has to name the worktree holding it.
    #[tokio::test]
    async fn reset_to_upstream_refuses_and_names_the_holding_worktree() {
        let (_base, base) = temp_base("reset-upstream-worktree");
        let local_s = server_rebase_fixture(&base).await;
        run(&local_s, &["switch", "-q", "main"]).await;
        let wt = base.join("wt");
        let wt_s = wt.to_string_lossy().into_owned();
        run(&local_s, &["worktree", "add", "--quiet", &wt_s, "feature"]).await;
        let before = run(&local_s, &["rev-parse", "feature"]).await.trim().to_string();
        let target = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();

        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &local_s, "feature", &target)
            .await
            .expect_err("a branch held by a worktree can't be reset");
        let AppError::Command(msg) = &err else {
            panic!("expected an actionable Command error, got {err:?}");
        };
        // The PATH, not the word "worktree": the message has to be actionable, and
        // asserting the noun would pass on a message that never says where.
        //
        // Compared against the path GIT reports, not the fixture's own spelling of
        // it: a Windows runner hands out 8.3 temp paths (`RUNNER~1`) and macOS
        // tempdirs sit behind the `/var` → `/private/var` symlink, so the two are
        // routinely different spellings of one directory. The message quotes git's
        // spelling, so that is what an exact containment check has to use — and the
        // canonical compare below proves it IS this fixture's worktree.
        let porcelain = run(&local_s, &["worktree", "list", "--porcelain"]).await;
        let reported = crate::git::ops::parse_worktree_paths(&porcelain)
            .into_iter()
            .zip(crate::git::ops::parse_worktree_branches(&porcelain))
            .find(|(_, b)| b == "feature")
            .map(|(p, _)| p)
            .expect("git lists a worktree holding feature");
        assert_eq!(
            crate::git::worktree::canonical_wt_path(&reported),
            crate::git::worktree::canonical_wt_path(&wt_s),
            "fixture sanity: git's worktree IS the one this test created"
        );
        assert!(
            msg.contains("feature") && msg.contains(&reported),
            "the refusal must name the branch and the holding worktree's path: {msg}"
        );
        assert_eq!(
            run(&local_s, &["rev-parse", "feature"]).await.trim(),
            before,
            "and the branch must not have moved"
        );

        let _ = run_git(
            Some(&local_s),
            &["worktree", "remove", "--force", &wt_s],
            DEFAULT_TIMEOUT,
        )
        .await;
    }

    /// The stale-evidence guard. A background fetch can move the upstream while
    /// the confirmation sits open, and `branch -f` would then land somewhere the
    /// user never saw — so the measured sha has to survive a re-resolve.
    #[tokio::test]
    async fn reset_to_upstream_refuses_a_tip_that_moved_since_it_was_measured() {
        let (_base, base) = temp_base("reset-upstream-moved");
        let local_s = server_rebase_fixture(&base).await;
        run(&local_s, &["switch", "-q", "main"]).await;
        let measured = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();
        let before = run(&local_s, &["rev-parse", "feature"]).await.trim().to_string();

        // The server pushes again; a background fetch picks it up mid-dialog.
        let server_s = base.join("server").to_string_lossy().into_owned();
        std::fs::write(base.join("server").join("later.txt"), "later\n").unwrap();
        run(&server_s, &["add", "-A"]).await;
        run(&server_s, &["commit", "-qm", "later work"]).await;
        run(&server_s, &["push", "-q", "origin", "feature"]).await;
        run(&local_s, &["fetch", "-q", "origin"]).await;
        assert_ne!(
            run(&local_s, &["rev-parse", "origin/feature"]).await.trim(),
            measured,
            "fixture must actually move the upstream for this to discriminate"
        );

        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &local_s, "feature", &measured)
            .await
            .expect_err("a moved upstream must refuse");
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("moved")),
            "the refusal must say the upstream moved, got {err:?}"
        );
        assert_eq!(
            run(&local_s, &["rev-parse", "feature"]).await.trim(),
            before,
            "and the branch must not have moved"
        );
    }

    /// REGRESSION GUARD for the CI-only failure: the caller's spelling of the repo
    /// path and git's differ, so a normalize-only self-exclusion doesn't recognize
    /// this checkout and reports the branch as held by a "linked" worktree that is
    /// really this one — the wrong remedy.
    ///
    /// The divergence comes from passing the CANONICALIZED path while git reports
    /// its own spelling. That discriminates on Windows, where `canonicalize` adds
    /// the `\\?\` verbatim prefix and `normalize_wt_path` leaves it in place
    /// (locally verified: reverting the self-exclusion to normalize-only fails this
    /// test right here). On macOS and Linux it does NOT discriminate — canonical is
    /// the same side git already resolves to, so both spellings agree and this
    /// degrades to a duplicate of the test above. Inconclusive-by-platform, so the
    /// assertion is on the ARM rather than on any path string.
    #[tokio::test]
    async fn reset_to_upstream_recognizes_its_own_checkout_under_another_spelling() {
        let (_base, base) = temp_base("reset-upstream-spelling");
        let local_s = server_rebase_fixture(&base).await;
        let target = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();
        // The same directory, spelled the way the OS resolves it.
        let resolved = std::fs::canonicalize(&local_s).expect("repo resolves");
        let resolved_s = resolved.to_string_lossy().into_owned();

        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &resolved_s, "feature", &target)
            .await
            .expect_err("feature is checked out in this very repo");
        let AppError::Command(msg) = &err else {
            panic!("expected an actionable Command error, got {err:?}");
        };
        assert!(
            msg.contains("sync controls"),
            "must take the checked-out-HERE arm, not the linked-worktree one: {msg}"
        );
    }

    /// The self-checkout arm of the same guard: `branch -f` can't touch the branch
    /// you are ON, and the refusal has to point at the surface that CAN.
    #[tokio::test]
    async fn reset_to_upstream_refuses_the_branch_checked_out_here() {
        let (_base, base) = temp_base("reset-upstream-current");
        let local_s = server_rebase_fixture(&base).await;
        // `feature` is the checked-out branch of this very repo path.
        let target = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();
        let before = run(&local_s, &["rev-parse", "feature"]).await.trim().to_string();

        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &local_s, "feature", &target)
            .await
            .expect_err("the current branch can't take a ref-only reset");
        let AppError::Command(msg) = &err else {
            panic!("expected an actionable Command error, got {err:?}");
        };
        assert!(
            msg.contains("feature") && msg.contains("sync controls"),
            "the refusal must name the branch and the surface that handles it: {msg}"
        );
        assert_eq!(
            run(&local_s, &["rev-parse", "feature"]).await.trim(),
            before,
            "and the branch must not have moved"
        );
    }

    /// A malformed (but exit-0) counts line must NOT default to zeros: `local_only
    /// == 0` is half the pair that unlocks the destructive reset offer, so a
    /// fabricated one is the worst answer this type can give. Every shape that
    /// isn't three integers has to answer `None`, which the caller turns into the
    /// whole "nothing provable" status.
    #[test]
    fn cherry_counts_parse_is_all_three_or_nothing() {
        assert_eq!(parse_cherry_counts("0\t3\t4\n"), Some((0, 3, 4)));
        assert_eq!(parse_cherry_counts(" 1 2 3 "), Some((1, 2, 3)));
        // A trailing field is ignored — git prints exactly three.
        assert_eq!(parse_cherry_counts("1\t2\t3\t9"), Some((1, 2, 3)));
        for bad in [
            "",                 // empty (a silenced failure)
            "0\t3",             // truncated — the fabrication risk
            "not-a-number",     // wrong shape entirely
            "0\tx\t4",          // one unreadable field
            "-1\t2\t3",         // negative can't be a u32 count
            "0\t3\t",           // trailing separator, third field missing
        ] {
            assert_eq!(
                parse_cherry_counts(bad),
                None,
                "{bad:?} must not yield counts"
            );
        }
    }

    /// The size gate in front of the patch-id walk, both arms. Building a real
    /// fixture at these scales costs far more than the seam is worth, so the
    /// thresholds are pinned on the parse that reads them; the spawn feeding it is
    /// a plain `rev-list --left-right --count`, whose two-integer shape this
    /// mirrors. An unreadable reply must gate OUT, matching the "never guess"
    /// direction the counts parse takes.
    ///
    /// The asymmetry is the point: a big REMOTE side must stay admissible, because
    /// that is the motivating shape (a branch forked far back, rebased by the
    /// remote) — a combined bound would refuse exactly the case the feature exists
    /// for.
    #[test]
    fn divergence_gate_bounds_the_local_side_for_copy_and_the_sum_for_cost() {
        // The reported scenario: 3 local commits, ~253 remote. Must be ADMITTED.
        assert!(
            !divergence_out_of_range("3\t253", 200, 1000),
            "a far-forked branch the remote rebased is the motivating case, not an \
             excluded one"
        );
        assert!(!divergence_out_of_range("200\t800", 200, 1000), "both at the limits runs");
        assert!(!divergence_out_of_range("0\t0", 200, 1000), "in sync runs");

        // Copy bound: the LOCAL side is the N in "all N commits are already upstream".
        assert!(
            divergence_out_of_range("201\t0", 200, 1000),
            "one local commit past the copy bound gates out"
        );
        // Cost bound: the sum alone, regardless of how one-sided it is.
        assert!(
            divergence_out_of_range("1\t1000", 200, 1000),
            "one commit past the total cost bound gates out"
        );
        assert!(
            !divergence_out_of_range("1\t999", 200, 1000),
            "and just inside it still runs"
        );

        for bad in ["", "x\t1", "12", "not a count"] {
            assert!(
                divergence_out_of_range(bad, 200, 1000),
                "{bad:?} is unreadable and must gate out"
            );
        }
    }

    /// `git_branch_merge_states` answers a SHAPE, never an error: a name the branch
    /// gate refuses reads as `merged: false, head_exists: false`. The rows that
    /// discriminate are the ones `rev-parse --verify refs/heads/<name>` RESOLVES
    /// (`feature~1`, `<base>^`, `feature^{commit}`) — ungated, those report a live
    /// branch and an ancestor-merged verdict for a ref no branch is at.
    #[tokio::test]
    async fn branch_merge_states_refuse_rev_expressions_as_unmerged_and_absent() {
        let (_base, base_dir) = temp_base("merge-states-revs");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;

        // Two commits on the base branch, so `<base>^` resolves; `landed` sits at
        // that tip (merged), `feature` one commit past it (not merged).
        let base = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        std::fs::write(repo.join("a.txt"), "second\n").unwrap();
        run(&repo_s, &["commit", "-qam", "second"]).await;
        run(&repo_s, &["branch", "landed"]).await;
        run(&repo_s, &["switch", "-qc", "feature"]).await;
        std::fs::write(repo.join("a.txt"), "feature\n").unwrap();
        run(&repo_s, &["commit", "-qam", "feature edit"]).await;
        run(&repo_s, &["switch", "-q", &base]).await;

        let pair = |b: &str, h: &str| MergePair {
            base: b.to_string(),
            head: h.to_string(),
        };
        // The probe itself works: a merged branch and an unmerged one, both live.
        let states = git_branch_merge_states(
            repo_s.clone(),
            vec![pair(&base, "landed"), pair(&base, "feature")],
        )
        .await
        .expect("real pairs resolve");
        assert_eq!((states[0].merged, states[0].head_exists), (true, true));
        assert_eq!((states[1].merged, states[1].head_exists), (false, true));

        // HEAD side: every rev shape and refspec metacharacter reads absent.
        for head in [
            "feature~1",
            &format!("{base}^"),
            "feature^{commit}",
            "HEAD@{1}",
            &format!("{base}..feature"),
            "@",
            "a*b",
            "a:b",
        ] {
            let states = git_branch_merge_states(repo_s.clone(), vec![pair(&base, head)])
                .await
                .expect("a refused name is a shape, not an error");
            assert_eq!(
                (states[0].merged, states[0].head_exists),
                (false, false),
                "head {head:?}"
            );
        }

        // BASE side: the head stays live, but nothing may be reported merged INTO a
        // rev expression. `feature~1` and `feature^{commit}` both have `landed` as
        // an ancestor, so an ungated base flips `merged` to true.
        for bad_base in ["feature~1", "feature^{commit}", "@", "a*b"] {
            let states = git_branch_merge_states(repo_s.clone(), vec![pair(bad_base, "landed")])
                .await
                .expect("a refused base is a shape, not an error");
            assert_eq!(
                (states[0].merged, states[0].head_exists),
                (false, true),
                "base {bad_base:?}"
            );
        }
    }

    /// `update_branch_from` merges into `refs/heads/<branch>` and merges `<base>`,
    /// so both must name a BRANCH: a rev expression would resolve and merge an
    /// ancestor. Asserts the gate's MESSAGE — the function raises `InvalidArgument`
    /// for a self-update too, which a variant-only match could not tell apart.
    #[tokio::test]
    async fn update_branch_from_rejects_rev_expressions_on_both_sides() {
        let (_base, base_dir) = temp_base("update-from-revs");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "feature"]).await;

        let state = AppState::default();
        for bad in [
            "feature~1",
            "main^",
            "HEAD@{1}",
            "main..other",
            "a^{commit}",
            "@",
            "a*b",
        ] {
            for (branch, base) in [(bad, "feature"), ("feature", bad)] {
                let err = update_branch_from(&state, &repo_s, branch, base)
                    .await
                    .unwrap_err();
                assert!(
                    matches!(&err, AppError::InvalidArgument(m) if m.contains("invalid branch name")),
                    "{branch:?} from {base:?} got: {err:?}"
                );
            }
        }
    }

    /// A repo whose `feature` branch has diverged from the default branch — each side
    /// adds a file the other doesn't have, so the merge itself succeeds. Returns the
    /// temp guard, the repo directory, its path as a string, and the default branch.
    async fn diverged_repo(tag: &str) -> (tempfile::TempDir, std::path::PathBuf, String, String) {
        let (guard, base_dir) = temp_base(tag);
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "seed.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();

        run(&repo_s, &["switch", "-qc", "feature"]).await;
        std::fs::write(repo.join("feature.txt"), "feature\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "feature work"]).await;

        run(&repo_s, &["switch", "-q", &main]).await;
        std::fs::write(repo.join("base.txt"), "base\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "base work"]).await;

        (guard, repo, repo_s, main)
    }

    /// The window the admin prologue opens: while the throwaway worktree materializes,
    /// nothing holds the working-tree lock, so `branch` can move under the update. The
    /// tip pinned before that window is what catches it — a mismatch refuses, leaves
    /// the ref where it stands, and still tears the worktree down.
    #[tokio::test]
    async fn update_branch_from_refuses_a_branch_that_moved_under_it() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-stale-pin").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let base_sha = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("stale-pin-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        // A real commit that simply isn't feature's tip — the shape a branch someone
        // moved mid-update leaves behind.
        let err = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            &main,
            &UpdatePins {
                branch_tip: base_sha.clone(),
                base_sha,
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m) if m.contains("moved while this update was running")),
            "{err:?}"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await.trim(),
            feature_tip,
            "a refused update leaves the branch exactly where it was"
        );
        let list = run(&repo_s, &["worktree", "list", "--porcelain"]).await;
        assert!(
            !list.contains("stale-pin-wt"),
            "the throwaway worktree is unregistered: {list}"
        );
        assert!(!tmp.exists(), "and its directory is gone");
    }

    /// The three cheap arms touch no worktree admin, so a removal holding that domain
    /// must not delay them. A zero budget takes the FREE admin lock deterministically
    /// and refuses a held one.
    #[tokio::test]
    async fn cheap_update_arms_run_while_the_worktree_admin_domain_is_held() {
        let (_guard, _repo, repo_s, main) = diverged_repo("update-admin-free").await;
        run(&repo_s, &["branch", "level", &main]).await;
        run(&repo_s, &["branch", "behind", &format!("{main}~1")]).await;

        let state = AppState::default();
        let _admin = acquire_repo_lock(
            &state.worktree_admin_lock(&repo_s).await,
            Duration::ZERO,
            "a worktree removal",
        )
        .await
        .expect("the admin domain is free");

        assert_eq!(
            update_branch_from(&state, &repo_s, "level", &main)
                .await
                .expect("up-to-date needs no worktree"),
            "up-to-date"
        );
        assert_eq!(
            update_branch_from(&state, &repo_s, "behind", &main)
                .await
                .expect("a fast-forward needs no worktree"),
            "fast-forward"
        );
        // Last, since it moves the default branch: `branch == current` merges in place.
        assert_eq!(
            update_branch_from(&state, &repo_s, &main, "feature")
                .await
                .expect("an in-place merge needs no worktree"),
            "merge"
        );
    }

    /// The base's half of the pin. Merging by NAME is what keeps git's own merge
    /// subject, so the sha the name resolves to has to be checked — a base that gained
    /// a commit while the worktree materialized is a different operation than the one
    /// the user asked for, and is refused rather than quietly merged.
    #[tokio::test]
    async fn a_diverged_update_refuses_a_base_that_moved_under_it() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-moved-base").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let pinned_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        // The base moves after the pin — exactly the window the admin prologue opens.
        std::fs::write(repo.join("later.txt"), "later\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "base work later"]).await;
        let moved_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();
        assert_ne!(pinned_base, moved_base, "the fixture must move the base");

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("moved-base-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        let err = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            &main,
            &UpdatePins {
                branch_tip: feature_tip.clone(),
                base_sha: pinned_base,
            },
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m)
                if m.starts_with(&format!("{main} moved while this update was running"))),
            "{err:?}"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await.trim(),
            feature_tip,
            "a refused update leaves the branch exactly where it was"
        );
        let list = run(&repo_s, &["worktree", "list", "--porcelain"]).await;
        assert!(
            !list.contains("moved-base-wt"),
            "the throwaway worktree is unregistered: {list}"
        );
        assert!(!tmp.exists(), "and its directory is gone");
    }

    /// The happy path: both pins hold, so the merge runs by NAME and the branch gets
    /// git's own `Merge branch '<base>'` subject over the pinned commit.
    #[tokio::test]
    async fn a_diverged_update_merges_the_pinned_base_by_name() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-pinned-base").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let pinned_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("pinned-base-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        let outcome = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            &main,
            &UpdatePins {
                branch_tip: feature_tip,
                base_sha: pinned_base.clone(),
            },
        )
        .await
        .expect("an unmoved base merges cleanly");
        assert_eq!(outcome, "merge");

        let merged_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let parents = run(&repo_s, &["rev-list", "--parents", "-n", "1", &merged_tip]).await;
        assert!(
            parents.contains(pinned_base.as_str()),
            "the pinned base is a parent of the merge: {parents}"
        );
        // Exit 0 specifically: `is_ancestor` answers 1 for "no", and 128 for a bad
        // argument, so anything but 0 has to fail this.
        let reachable = run_git_raw(
            Some(&repo_s),
            &["merge-base", "--is-ancestor", &pinned_base, &merged_tip],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(
            reachable.code, 0,
            "the pinned base is reachable from the merge: {}",
            reachable.stderr
        );
        // Merging by name is the whole reason for the base pin: a sha argument would
        // have written `Merge commit '<sha>'` here instead.
        let subject = run(&repo_s, &["log", "-1", "--format=%s", &merged_tip]).await;
        assert!(
            subject.trim().starts_with(&format!("Merge branch '{main}'")),
            "git's own merge subject survives: {subject}"
        );
        assert!(!tmp.exists(), "the throwaway worktree is torn down");
    }
}
