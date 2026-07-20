use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{
    run_git, run_git_mutating, run_git_raw, DEFAULT_TIMEOUT, NETWORK_TIMEOUT,
};
use crate::git::types::{Branch, BranchDivergence, RemoteBranch};
use crate::state::AppState;

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
    Ok(())
}

/// If `name` is checked out in a LINKED worktree (one other than `repo_path`
/// itself), returns that worktree's path. git refuses to delete a branch that's
/// checked out anywhere, so a caller turns this into an actionable message.
/// Best-effort: a `worktree list` failure yields `None` and lets git's own error
/// speak. The `repo_path` checkout is excluded so deleting its *current* branch
/// isn't misreported here (that path pre-switches, and git errors clearly if not).
async fn worktree_holding_branch(repo_path: &str, name: &str) -> Option<String> {
    use crate::git::ops::{parse_worktree_branches, parse_worktree_paths};
    use crate::git::worktree::normalize_wt_path;
    let listed = run_git(
        Some(repo_path),
        &["worktree", "list", "--porcelain"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let porcelain = listed.stdout_lossy();
    let self_norm = normalize_wt_path(repo_path);
    // Both parsers emit one entry per `worktree …` stanza in the same list order,
    // so the zip is length-safe and pairs each worktree's path with its branch.
    parse_worktree_paths(&porcelain)
        .into_iter()
        .zip(parse_worktree_branches(&porcelain))
        .find(|(path, branch)| branch == name && normalize_wt_path(path) != self_norm)
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
    // Pre-mutation guard: git refuses to delete a branch checked out in a worktree
    // with a terse message. Detect a linked worktree holding it and surface a
    // clear, actionable one — shared by every caller (branch switcher, bulk
    // cleanup, and any future path), not just the switcher's own UI guard.
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
        // Idempotent: the server ref is already gone, so the goal state holds.
        // A failed delete-push leaves the local remote-tracking ref in place
        // (unlike the success path, which prunes it), so the switcher row would
        // survive until the next pruning fetch — best-effort delete it now so
        // the UI reflects the deletion immediately. The ref may already be absent.
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

/// The repository's default branch: origin's HEAD when known, otherwise a
/// local "main"/"master" if one exists.
#[tauri::command]
pub async fn git_default_branch(repo_path: String) -> AppResult<Option<String>> {
    let out = run_git_raw(
        Some(&repo_path),
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if out.code == 0 {
        let full = out.stdout_lossy().trim().to_string();
        let name = full.strip_prefix("origin/").unwrap_or(&full).to_string();
        if !name.is_empty() {
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
        let valid_head = validate_ref_name(&pair.head).is_ok();
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
        let merged = if valid_head && validate_ref_name(&pair.base).is_ok() {
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

/// Updates `branch` with the latest commits from `base` (typically the default
/// branch) WITHOUT switching to it, so the working tree the user is editing —
/// and any watchers (vite, `tsc --watch`, …) running against it — never change.
///
/// - `branch` already contains `base` → no-op, returns `"up-to-date"`.
/// - `branch` is strictly behind `base` → fast-forward the ref, returns
///   `"fast-forward"`.
/// - `branch` has diverged → merge `base` into `branch` inside a throwaway
///   worktree so the main checkout is untouched, returns `"merge"`. A
///   conflicting merge is aborted and reported; the branch is left unchanged.
///
/// When `branch` IS the current branch there's nothing to avoid switching to,
/// so it merges in place (conflicts surface in the changes list as usual).
#[tauri::command]
pub async fn git_update_branch_from(
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
    base: String,
) -> AppResult<String> {
    validate_ref_name(&branch)?;
    validate_ref_name(&base)?;
    if branch == base {
        return Err(AppError::InvalidArgument(
            "a branch can't be updated from itself".to_string(),
        ));
    }

    // Mutating refs — serialize against other writes to this repo.
    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;

    let current = run_git(
        Some(&repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .stdout_lossy()
    .trim()
    .to_string();

    // The current branch is already checked out, so just merge in place.
    if branch == current {
        run_git(
            Some(&repo_path),
            &["merge", "--no-edit", &base],
            DEFAULT_TIMEOUT,
        )
        .await?;
        return Ok("merge".to_string());
    }

    // base already reachable from branch → nothing to bring in.
    let already = run_git_raw(
        Some(&repo_path),
        &["merge-base", "--is-ancestor", &base, &branch],
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
        Some(&repo_path),
        &["merge-base", "--is-ancestor", &branch, &base],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if ff.code == 0 {
        run_git(
            Some(&repo_path),
            &["fetch", ".", &format!("{base}:{branch}")],
            DEFAULT_TIMEOUT,
        )
        .await?;
        return Ok("fast-forward".to_string());
    }

    // Diverged → merge inside a throwaway worktree so the user's checkout (and
    // its file watchers) is never disturbed.
    let tmp = std::env::temp_dir().join(format!("gd-update-{}", unique_suffix()));
    let tmp_str = tmp.to_string_lossy().to_string();

    run_git(
        Some(&repo_path),
        &["worktree", "add", "--quiet", &tmp_str, &branch],
        DEFAULT_TIMEOUT,
    )
    .await?;

    let merged = run_git(
        Some(&tmp_str),
        &["merge", "--no-edit", &base],
        DEFAULT_TIMEOUT,
    )
    .await;

    let result = match merged {
        Ok(_) => Ok("merge".to_string()),
        Err(_) => {
            // Undo the half-done merge so the branch ref is left as it was.
            let _ = run_git_raw(Some(&tmp_str), &["merge", "--abort"], DEFAULT_TIMEOUT).await;
            Err(AppError::InvalidArgument(format!(
                "{branch} has changes that conflict with {base}. Switch to {branch} to merge and resolve them."
            )))
        }
    };

    // Always tear the throwaway worktree down, success or failure.
    let _ = run_git_raw(
        Some(&repo_path),
        &["worktree", "remove", "--force", &tmp_str],
        DEFAULT_TIMEOUT,
    )
    .await;
    let _ = run_git_raw(Some(&repo_path), &["worktree", "prune"], DEFAULT_TIMEOUT).await;

    result
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
    // Non-zero exit (e.g. an unknown/unfetched sha) → treat as "not on a remote".
    if out.code != 0 {
        return Ok(false);
    }
    Ok(!out.stdout_lossy().trim().is_empty())
}

/// Count of commits reachable from `HEAD` but not from any remote-tracking ref
/// (`git rev-list --count HEAD --not --remotes`) — i.e. how many commits haven't
/// been published anywhere. The History tab uses this to mark the "not pushed"
/// rows on a branch with **no upstream** (a never-pushed branch), where "ahead of
/// upstream" is undefined: the fork point and everything below it live on
/// `origin/<base>` and ARE published, so only the commits above it are unpushed —
/// not the whole branch. A repo with no remotes at all yields the full `HEAD`
/// count (nothing is published), which is the correct answer. A benign git error
/// (e.g. an unborn `HEAD`) maps to `0` — nothing to mark.
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
        build_create_branch_args, git_branches, git_create_branch_core, parse_upstream_track,
        validate_ref_name,
    };
    use crate::git::runner::{run_git, DEFAULT_TIMEOUT};
    use crate::state::AppState;

    // Full decision table for the create-branch argv: checkout × start_point ×
    // no_track (8 cases). The no_track=false rows must stay byte-identical to the
    // pre-`--no-track` behavior for every combination.
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
        // The round-2 security regression guard: `*` would otherwise glob-match /
        // mirror-push every branch via `for-each-ref refs/heads/*` and a wildcard
        // push refspec.
        for bad in ["*", "feat*", "a?b", "a[b", "a:b", "a\\b", "a b", "x\u{7f}"] {
            assert!(validate_ref_name(bad).is_err(), "should reject {bad:?}");
        }
        // Pre-existing rejects still hold.
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

    /// The argv table pins `--no-track` placement; this closes the argv→outcome
    /// gap by driving `git_create_branch_core` against a real repo and asserting
    /// git actually honors it. Synthesizes a remote-tracking ref
    /// (`refs/remotes/origin/x` via `update-ref`, so nothing is ever fetched) and
    /// bases two branches on it: the `no_track=true` arm must have NO upstream,
    /// the `no_track=false` control arm must track `origin/x`. Both arms create
    /// without checkout (`checkout=false`) to keep the assertions simple; the
    /// checkout arm shares the same `--no-track` placement per the argv table.
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

        // Pin the tracking mode repo-locally: a contributor's ambient global
        // `branch.autoSetupMerge = simple|false` would leave `z` untracked and
        // false-fail this control arm (probed live both ways). The `--no-track`
        // arm above is immune — the flag overrides config.
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
        // `branch.autoSetupMerge = simple|false` can't leave `tracked` untracked
        // and false-fail the assertion (same guard as the no-track control arm).
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
}
