use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{
    run_git, run_git_mutating, run_git_raw, DEFAULT_TIMEOUT, NETWORK_TIMEOUT,
    WORKTREE_OP_TIMEOUT,
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
    if let Err(e) = crate::review_notes::rename_branch(&identity, &old_name, &new_name) {
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

/// Updates `branch` with the latest commits from `base` WITHOUT switching to it, so
/// the user's working tree — and any watchers (vite, `tsc --watch`) — never change.
///
/// - already contains `base` → no-op, `"up-to-date"`.
/// - strictly behind → fast-forward the ref, `"fast-forward"`.
/// - diverged → merge `base` in a throwaway worktree so the main checkout is
///   untouched, `"merge"`; a conflicting merge is aborted and the branch left as-is.
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

    // Mutating refs — serialize against other writes to this repo.
    let lock = state.repo_lock(repo_path).await;
    let _guard = lock.lock().await;

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
    let tmp = std::env::temp_dir().join(format!("gd-update-{}", unique_suffix()));
    let tmp_str = tmp.to_string_lossy().to_string();

    run_git(
        Some(repo_path),
        &["worktree", "add", "--quiet", &tmp_str, branch],
        WORKTREE_OP_TIMEOUT,
    )
    .await?;

    // The merge keeps the default budget: it rewrites only the differing files, not
    // the whole tree, and both arms below tear the temp worktree down regardless.
    let merged = run_git(
        Some(&tmp_str),
        &["merge", "--no-edit", base],
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
        Some(repo_path),
        &["worktree", "remove", "--force", &tmp_str],
        WORKTREE_OP_TIMEOUT,
    )
    .await;
    let _ = run_git_raw(Some(repo_path), &["worktree", "prune"], DEFAULT_TIMEOUT).await;

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
        build_create_branch_args, git_branches, git_create_branch_core, git_default_branch,
        git_rename_branch_core, parse_upstream_track, update_branch_from, validate_branch_name,
        validate_ref_name,
    };
    use crate::error::AppError;
    use crate::git::runner::{run_git, DEFAULT_TIMEOUT};
    use crate::state::AppState;

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
}
