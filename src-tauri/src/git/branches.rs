use std::collections::HashSet;

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{
    acquire_repo_lock, acquire_repo_lock_unbounded, is_config_lock_contention, run_git,
    run_git_config_write, run_git_config_write_held, run_git_mutating,
    run_git_mutating_config_write, run_git_raw, run_git_worktree_admin, try_acquire_repo_lock,
    ConfigWriteHeld, GitOutput, DEFAULT_TIMEOUT, LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT,
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

/// HEAD's branch as its full ref (`refs/heads/<name>`), or `None` when HEAD is
/// detached. Read with `symbolic-ref`, never `rev-parse --abbrev-ref`: the short form
/// disambiguates, so a branch shadowed by a same-named tag reads `heads/<name>` (or the
/// full ref, when that is ambiguous too). An UNBORN branch still answers here — sites
/// that must refuse before the first commit check [`head_is_unborn`] themselves. Any
/// other failure (not a repository, git missing) is an `Err`.
pub(crate) async fn current_branch_ref(repo_path: &str) -> AppResult<Option<String>> {
    let out = run_git_raw(
        Some(repo_path),
        &["symbolic-ref", "-q", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match out.code {
        0 => {
            let full = out.stdout_lossy();
            let full = full.trim_end_matches(['\r', '\n']);
            let named = full
                .strip_prefix("refs/heads/")
                .is_some_and(|name| !name.is_empty());
            Ok(named.then(|| full.to_string()))
        }
        // `-q` exits 1, silently, exactly when HEAD is not a symbolic ref.
        1 => Ok(None),
        code => Err(AppError::Git {
            code,
            stderr: out.full_failure_text(),
        }),
    }
}

/// The checked-out branch's NAME (what a branch argument, config key, refspec or
/// comparison against `status --branch` wants), with [`current_branch_ref`]'s
/// detached/unborn/error contract. A rev position takes the full ref instead: a bare
/// name resolves to a same-named tag first.
pub(crate) async fn current_branch_name(repo_path: &str) -> AppResult<Option<String>> {
    Ok(current_branch_ref(repo_path)
        .await?
        .and_then(|full| full.strip_prefix("refs/heads/").map(str::to_string)))
}

/// Whether HEAD names a branch with no commits yet (a fresh `git init`, an orphan
/// switch) — the state [`current_branch_name`] reports as an ordinary branch.
pub(crate) async fn head_is_unborn(repo_path: &str) -> AppResult<bool> {
    let out = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--verify", "-q", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(out.code != 0)
}

/// `name` for a REV position whose callers name LOCAL BRANCHES. A name git already
/// resolves to that branch stays as given (`merge` words its message from it: the full
/// ref would read "Merge branch 'refs/heads/x'"). When something else captures it, a
/// same-named tag first (gitrevisions checks refs/tags before refs/heads), the local
/// branch named exactly `name` is taken by its full ref, git's own `%(refname)`.
/// Anything that names no local branch (a remote-tracking ref, sha, rev expression)
/// passes through, as does a failed read, leaving each command's own error to surface.
/// An input already spelled as a full ref (`refs/...`) is returned untouched, so a
/// branch literally named `refs/heads/x` can never capture it. Callers validate `name`
/// first. Not for inputs that may legitimately be TAGS: a tag sharing a branch's name
/// would lose to the branch.
pub(crate) async fn branch_first_rev(repo_path: &str, name: &str) -> String {
    if name.starts_with("refs/") {
        return name.to_string();
    }
    // Ambiguous names answer empty on stdout with exit 0 (the error rides stderr).
    let resolved = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--symbolic-full-name", name],
        DEFAULT_TIMEOUT,
    )
    .await;
    if let Ok(out) = resolved {
        if out.code == 0 && out.stdout_lossy().trim().strip_prefix("refs/heads/") == Some(name) {
            return name.to_string();
        }
    }
    let listed = run_git_raw(
        Some(repo_path),
        &["for-each-ref", "--format=%(refname)", "refs/heads/"],
        DEFAULT_TIMEOUT,
    )
    .await;
    let Ok(out) = listed else {
        return name.to_string();
    };
    if out.code != 0 {
        return name.to_string();
    }
    out.stdout_lossy()
        .lines()
        .find(|full| full.strip_prefix("refs/heads/") == Some(name))
        .map_or_else(|| name.to_string(), str::to_string)
}

/// The refusal for an operation that needs a commit on HEAD's branch.
pub(crate) fn unborn_head_error() -> AppError {
    AppError::InvalidArgument(
        "The current branch has no commits yet — commit on it, or switch to another branch, \
         first."
            .into(),
    )
}

/// Every local branch. Names are read in FULL and stripped of exactly `refs/heads/`:
/// `%(refname:short)` disambiguates, so a branch shadowed by a same-named tag lists as
/// `heads/<name>` (or the full ref, when that is ambiguous too) and every row action
/// would target the wrong name. `%(upstream:short)` stays short on purpose — the UI
/// hands it back as a rev, which its disambiguated form resolves correctly.
#[tauri::command]
pub async fn git_branches(repo_path: String) -> AppResult<Vec<Branch>> {
    let out = run_git(
        Some(&repo_path),
        &[
            "for-each-ref",
            "refs/heads",
            "--format=%(refname)%00%(upstream:short)%00%(HEAD)%00%(committerdate:iso8601-strict)%00%(upstream:track)%00%(upstream:remotename)",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let archived = read_archived_set(&repo_path).await?;
    let mut branches = Vec::new();
    for line in text.lines() {
        let mut parts = line.split('\0');
        let (Some(refname), upstream, head, date, track, upstream_remote) = (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next(),
        ) else {
            continue;
        };
        let Some(name) = refname
            .strip_prefix("refs/heads/")
            .filter(|n| !n.is_empty())
        else {
            continue;
        };
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
            "--format=%(refname)%00%(committerdate:iso8601-strict)",
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
        // Full ref, stripped of exactly `refs/remotes/`: the short form turns into
        // `remotes/<remote>/<branch>` when a local ref is named `<remote>/<branch>`.
        // Split once so a branch name containing `/` stays intact (a remote name
        // containing `/` still mis-splits).
        let Some((remote, name)) = refname
            .strip_prefix("refs/remotes/")
            .and_then(|r| r.split_once('/'))
        else {
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
    set_branch_archived_core(&repo_path, &name, archived).await
}

/// The body of `git_set_branch_archived`.
///
/// No domain lock, only the config-write mutex: the worktree-admin domain is held for a
/// whole removal (minutes on a large tree), so queueing there would turn a second
/// worktree delete into a failed archive for the first. Config writers hold
/// `.git/config.lock` for milliseconds, in this process or another, which the one
/// retry covers.
pub(crate) async fn set_branch_archived_core(
    repo_path: &str,
    name: &str,
    archived: bool,
) -> AppResult<()> {
    validate_ref_name(name)?;
    // No current/default-branch refusal here by design: the frontend owns the
    // guard (the current-branch arm is total; the default arm is best-effort,
    // dropping out while defaultName resolves), no MCP tool mutates the flag,
    // and it is fully reversible — a backend default-branch check would also
    // ride the multi-spawn, fallible remote-HEAD resolution per call.
    let key = format!("branch.{name}.gitdesktopArchived");
    let args = if archived {
        ["config", key.as_str(), "true"]
    } else {
        ["config", "--unset-all", key.as_str()]
    };
    let out = run_git_config_write(repo_path, &args, DEFAULT_TIMEOUT).await?;
    // exit 5 = "key not found" — already unarchived, which is fine. `--unset-all`
    // because plain `--unset` ALSO exits 5 on a multi-valued key and removes nothing.
    if out.code == 0 || (!archived && out.code == 5) {
        return Ok(());
    }
    if is_config_lock_contention(&out.stderr) {
        return Err(archive_config_busy(name, archived));
    }
    Err(AppError::Git {
        code: out.code,
        stderr: out.stderr,
    })
}

/// The refusal once the retry ALSO lost the config lock: what happened and what to
/// do, never git's lock-file path.
fn archive_config_busy(name: &str, archived: bool) -> AppError {
    let verb = if archived { "archived" } else { "unarchived" };
    AppError::Command(format!(
        "Another Git process was saving this repository's settings, so {name} wasn't \
         {verb} — try again."
    ))
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
    // `branch -m` does NOT refuse a branch checked out elsewhere — it retargets that
    // worktree's HEAD silently, which under a running update means renaming the branch
    // out from under it.
    crate::git::update_marker::refuse_if_branch_updating(state, &repo_path, &old_name).await?;
    let repo = repo_path.as_str();
    let (old_section, new_section) = (format!("branch.{old_name}"), format!("branch.{new_name}"));
    run_git_mutating_config_write(
        state,
        repo,
        &["branch", "-m", "--", &old_name, &new_name],
        DEFAULT_TIMEOUT,
        |out, held| async move {
            if out.code == 0 || !out.stderr.contains(RENAMED_CONFIG_LEFT_BEHIND) {
                return Ok(out);
            }
            let moved = ["config", "--rename-section", &old_section, &new_section];
            if repair_branch_section(&held, repo, &moved).await {
                return Ok(GitOutput { code: 0, ..out });
            }
            Ok(out)
        },
    )
    .await?;
    // Carry the branch's reviewer note over to the new name, keyed by the same identity
    // the MCP deposit path uses. Strictly after the `?` and best-effort: the rename has
    // already happened, so a store failure must never be reported as a failed rename.
    // This is the one seam both in-app renames share (the GUI command and the MCP
    // `rename_branch` tool); a terminal `git branch -m` has no hook, the same accepted
    // gap as the commit-draft migration. Cold-start test mode is out of reach too — the
    // GUI aliases its store file there (`storeName` in src/lib/test-mode.ts).
    let note_result = async {
        let identity = crate::git::repo::repo_identity(&repo_path).await?;
        crate::review_notes::rename_branch(&identity, &old_name, &new_name).await
    }
    .await;
    if let Err(e) = note_result {
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

/// Arbitrates a `worktree_holding_branch` hit that turns out to be an UPDATE's hidden
/// `gd-update-*` checkout. `true` means "cleared — re-probe"; `false` leaves the
/// caller's own message to speak, which is also the answer whenever the marker proves
/// nothing: an unreadable lock, or a checkout from a pre-marker build that may still be
/// mid-update — and, before any of that, a root set this process cannot resolve. Only a
/// lock that EXISTS and is acquirable authorizes the age-free removal, and only a HELD
/// one authorizes a refusal.
async fn clear_update_holder(
    state: &AppState,
    repo_path: &str,
    branch: &str,
    holder: &str,
) -> AppResult<bool> {
    use crate::git::update_marker::{self as marker, LockProbe};
    // Root-scoped: a `gd-update-*` worktree the USER made, outside our app-data root, is
    // their own and takes the ordinary path however its neighbours look. Resolved through
    // the cache the claim below uses, so one call never arbitrates over two root sets.
    let Ok(roots) = marker::roots_for_cached(state, repo_path).await else {
        return Ok(false);
    };
    if !marker::is_managed_update_worktree_in(&roots, holder) {
        return Ok(false);
    }
    match marker::update_worktree_probe(holder) {
        LockProbe::Live => Err(marker::branch_update_refusal(branch)),
        LockProbe::Released => {
            if marker::claim_dead_update_worktree(state, repo_path, holder).await {
                return Ok(true);
            }
            // Provably dead but unclaimable (the admin domain was busy) — the hidden
            // path is nothing the user can act on, so name the state instead.
            Err(marker::interrupted_update_refusal(branch))
        }
        LockProbe::Missing | LockProbe::Unknown => Ok(false),
    }
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
    // Two halves of one window: the marker covers an update that has minted but not yet
    // registered its checkout (the `worktree add` is the long part), the porcelain arm
    // below covers it once registered. Heal-free — the healing lives in the claim arm.
    crate::git::update_marker::refuse_if_branch_updating_no_heal(state, &repo_path, &name).await?;
    // Pre-mutation guard: git's own refusal for a branch checked out in a worktree
    // is terse. Detect the holding worktree here — shared by every caller, not just
    // the switcher's UI guard — and surface an actionable message.
    if let Some(path) = worktree_holding_branch(&repo_path, &name).await {
        // An update's hidden checkout is nothing the user can act on by that path, so
        // it takes its own arm: refused while live, swept and re-probed once dead.
        let swept = clear_update_holder(state, &repo_path, &name, &path).await?;
        let held = if swept {
            worktree_holding_branch(&repo_path, &name).await
        } else {
            Some(path)
        };
        if let Some(path) = held {
            return Err(AppError::Command(format!(
                "{name} is checked out in the worktree at {path} — remove that worktree \
                 (or switch it to another branch) before deleting {name}."
            )));
        }
    }
    let repo = repo_path.as_str();
    let local = name.as_str();
    run_git_mutating_config_write(
        state,
        repo,
        &["branch", "-D", "--", &name],
        DEFAULT_TIMEOUT,
        |out, held| async move {
            if out.code == 0 {
                remove_deleted_branch_section(&held, repo, local).await;
            }
            Ok(out)
        },
    )
    .await?;
    Ok(())
}

/// git's text when `branch -m` moved the ref but lost `.git/config.lock`: exit 128,
/// `branch.<old>.*` left under the old name (measured, git 2.51.1, C locale).
const RENAMED_CONFIG_LEFT_BEHIND: &str = "branch is renamed, but update of config-file failed";

/// git's text when a tracking setup (`switch --track`, a tracked `switch -c`/`branch`,
/// `push -u`) lost the config lock after its ref work landed.
pub(crate) const UPSTREAM_WRITE_FAILED: &str = "unable to write upstream branch configuration";

/// Redoes one `branch.<name>` section edit whose ref change already landed, counting
/// "no such section" as done: the branch had no settings, or another writer already
/// handled them. `false` (logged) leaves the caller's own verdict to speak.
async fn repair_branch_section(held: &ConfigWriteHeld, repo_path: &str, args: &[&str]) -> bool {
    match run_git_config_write_held(held, repo_path, args, DEFAULT_TIMEOUT).await {
        Ok(out) if out.code == 0 || out.stderr.contains("no such section") => true,
        Ok(out) => {
            eprintln!(
                "gitdesktop: branch config repair failed: {}",
                out.stderr.trim()
            );
            false
        }
        Err(e) => {
            eprintln!("gitdesktop: branch config repair failed: {e}");
            false
        }
    }
}

/// `branch -D` exits 0 when it loses `.git/config.lock` (measured, git 2.51.1): the
/// ref is gone but `branch.<name>.*` survives, to resurface on the next branch of that
/// name. Best-effort, since the delete itself succeeded.
pub(crate) async fn remove_deleted_branch_section(
    held: &ConfigWriteHeld,
    repo_path: &str,
    name: &str,
) {
    let section = format!("branch.{name}");
    repair_branch_section(held, repo_path, &["config", "--remove-section", &section]).await;
}

/// Re-establishes `branch` → `upstream` tracking after a tracking setup lost the config
/// lock, never re-running the command that set it up. `upstream` is the fully
/// qualified ref git itself would have tracked; callers that can't pin it don't call.
pub(crate) async fn restore_upstream(
    held: &ConfigWriteHeld,
    repo_path: &str,
    branch: &str,
    upstream: &str,
) -> bool {
    let flag = format!("--set-upstream-to={upstream}");
    match run_git_config_write_held(
        held,
        repo_path,
        &["branch", &flag, "--", branch],
        DEFAULT_TIMEOUT,
    )
    .await
    {
        Ok(out) if out.code == 0 => true,
        Ok(out) => {
            eprintln!("gitdesktop: upstream repair failed: {}", out.stderr.trim());
            false
        }
        Err(e) => {
            eprintln!("gitdesktop: upstream repair failed: {e}");
            false
        }
    }
}

/// What decided a tracking setup's upstream, and so what a repair may re-set.
#[derive(Clone, Copy)]
pub(crate) enum TrackedBy {
    /// An explicit `--track`: always the start ref itself.
    ExplicitTrack,
    /// `branch.autoSetupMerge`, whose mode decides (see [`direct_tracking_target`]).
    AutoSetupMerge,
}

/// What [`finish_tracking_setup`] left behind.
pub(crate) struct FinishedSetup {
    /// The output to report: success once both legs landed, else git's own failure.
    pub(crate) out: GitOutput,
    /// The repair's switch leg landed, so HEAD is on the new branch whatever `out`
    /// says — a caller that treats a failure as "HEAD never moved" must check this.
    pub(crate) switched: bool,
}

/// A tracking setup (`switch --track`, or `switch -c`/`branch` that set tracking up)
/// that loses the config lock has CREATED `branch` and, for a switch, moved the index
/// and working tree to it, yet left HEAD on the old branch and the upstream unwritten
/// (measured, git 2.51.1: exit 1). Finishes both legs, the switch first and whatever
/// the upstream does: the moved tree under the old HEAD reads as staged changes a
/// commit would land on the old branch. An upstream git's own choice can't be pinned
/// for, or that loses again, keeps git's failure in `out`, never a guessed upstream.
pub(crate) async fn finish_tracking_setup(
    held: &ConfigWriteHeld,
    repo_path: &str,
    out: GitOutput,
    branch: &str,
    start: &str,
    tracked_by: TrackedBy,
    switch: bool,
) -> AppResult<FinishedSetup> {
    if out.code == 0 || !out.stderr.contains(UPSTREAM_WRITE_FAILED) {
        return Ok(FinishedSetup {
            out,
            switched: false,
        });
    }
    // Resolved BEFORE the switch leg: a `HEAD` start must name the branch the create
    // started from, never the one the leg is about to check out.
    let upstream = direct_tracking_target(repo_path, start, tracked_by).await;
    if switch {
        let switched = run_git_raw(Some(repo_path), &["switch", branch], DEFAULT_TIMEOUT).await?;
        if switched.code != 0 {
            return Ok(FinishedSetup {
                out: switched,
                switched: false,
            });
        }
    }
    let restored = match upstream {
        Some(upstream) => restore_upstream(held, repo_path, branch, &upstream).await,
        None => false,
    };
    let out = if restored {
        GitOutput { code: 0, ..out }
    } else {
        out
    };
    Ok(FinishedSetup {
        out,
        switched: switch,
    })
}

/// The ref git itself tracked from `start`, fully qualified, or `None` when that can't
/// be pinned. git tracks the start ref directly under an explicit `--track` and under
/// every `branch.autoSetupMerge` value that sets tracking up at all except `inherit`,
/// which copies the START's own upstream (possibly several merge entries) instead
/// (measured, git 2.51.1). The start resolves the way git's create resolved it.
pub(crate) async fn direct_tracking_target(
    repo_path: &str,
    start: &str,
    tracked_by: TrackedBy,
) -> Option<String> {
    if let TrackedBy::AutoSetupMerge = tracked_by {
        let mode = run_git_raw(
            Some(repo_path),
            &["config", "--get", "branch.autoSetupMerge"],
            DEFAULT_TIMEOUT,
        )
        .await
        .ok()?;
        // Exit 1 is unset, git's default `true`. `inherit` is matched as git does,
        // case-sensitively; the last value wins in both readers.
        let direct = match mode.code {
            0 => mode.stdout_lossy().trim() != "inherit",
            1 => true,
            _ => false,
        };
        if !direct {
            return None;
        }
    }
    let resolved = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--symbolic-full-name",
            start,
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    let full = resolved.stdout_lossy().trim().to_string();
    (resolved.code == 0 && (full.starts_with("refs/remotes/") || full.starts_with("refs/heads/")))
        .then_some(full)
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
    // check locally first. Probe with a non-propagating raw run. Read in FULL
    // and stripped of exactly `refs/remotes/`: `--short` disambiguates, so a
    // tag or local branch named `<remote>/<name>` turns the answer into
    // `remotes/<remote>/<name>` (measured, git 2.51.1).
    let head = run_git_raw(
        Some(&repo_path),
        &["symbolic-ref", &format!("refs/remotes/{remote}/HEAD")],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let head_ref = head.stdout_lossy();
    if head.code == 0
        && head_ref
            .trim_end_matches(['\r', '\n'])
            .strip_prefix("refs/remotes/")
            == Some(format!("{remote}/{name}").as_str())
    {
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
    crate::git::update_marker::refuse_if_branch_updating(state, &repo_path, &name).await?;
    run_git_mutating(state, &repo_path, &["switch", &name], DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// Check out a remote-only branch as a new local tracking branch of a SPECIFIC
/// remote. We pass `--track refs/remotes/<remote>/<name>` explicitly rather than plain
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
    git_checkout_remote_branch_core(&state, repo_path, remote, name).await
}

pub(crate) async fn git_checkout_remote_branch_core(
    state: &AppState,
    repo_path: String,
    remote: String,
    name: String,
) -> AppResult<()> {
    validate_ref_name(&remote)?;
    validate_ref_name(&name)?;
    // A live update means a LOCAL `name` already exists and is held, so this switch
    // collides on it rather than creating anything.
    crate::git::update_marker::refuse_if_branch_updating(state, &repo_path, &name).await?;
    // The full ref: a tag or local branch named `<remote>/<name>` makes the bare form
    // ambiguous, and git refuses to start from it.
    let start = format!("refs/remotes/{remote}/{name}");
    let (repo, local, start_s) = (repo_path.as_str(), name.as_str(), start.as_str());
    run_git_mutating_config_write(
        state,
        repo,
        &["switch", "--track", start_s],
        DEFAULT_TIMEOUT,
        |out, held| async move {
            let by = TrackedBy::ExplicitTrack;
            let finished = finish_tracking_setup(&held, repo, out, local, start_s, by, true).await;
            finished.map(|finished| finished.out)
        },
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
    // Any create but `--no-track` can set tracking up, the one leg that writes the
    // config: with no start point git starts from HEAD, where `always` tracks that
    // local branch and `inherit` copies its upstream (measured, git 2.51.1).
    if no_track {
        run_git_mutating(state, &repo_path, &arg_refs, DEFAULT_TIMEOUT).await?;
        return Ok(());
    }
    let start = start_point.as_deref().unwrap_or("HEAD");
    let (repo, local) = (repo_path.as_str(), name.as_str());
    run_git_mutating_config_write(
        state,
        repo,
        &arg_refs,
        DEFAULT_TIMEOUT,
        |out, held| async move {
            let by = TrackedBy::AutoSetupMerge;
            let finished =
                finish_tracking_setup(&held, repo, out, local, start, by, checkout).await;
            finished.map(|finished| finished.out)
        },
    )
    .await?;
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
            // Both are branch names: read as the branches, never same-named tags.
            let head = branch_first_rev(&repo_path, &pair.head).await;
            let base = branch_first_rev(&repo_path, &pair.base).await;
            run_git_raw(
                Some(&repo_path),
                &["merge-base", "--is-ancestor", &head, &base],
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
        &["for-each-ref", "refs/heads", "--format=%(refname)"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    // (full ref, name): the payload and the base comparison take the name, stripped of
    // exactly `refs/heads/` as `git_branches` strips it, and the range takes the full
    // ref (and the base its branch-first rev), which a bare name would lose to a
    // same-named tag.
    let refs: Vec<(String, String)> = out
        .stdout_lossy()
        .lines()
        .map(str::trim)
        .filter_map(|full| {
            let name = full.strip_prefix("refs/heads/").filter(|n| !n.is_empty())?;
            Some((full.to_string(), name.to_string()))
        })
        .collect();

    let base_rev = branch_first_rev(&repo_path, &base).await;
    let mut result = Vec::with_capacity(refs.len());
    for (full, name) in refs {
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
        let range = format!("{base_rev}...{full}");
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
    // git looks the name before `@{upstream}` up as a BRANCH, so no same-named tag can
    // capture it, and the `refs/heads/` spelling is refused ("no such branch").
    let upstream_rev = format!("{branch}@{{upstream}}");

    // No upstream at all → nothing to compare against. `rev-parse` exits non-zero
    // and writes its own diagnostic; that is a normal answer here, not a failure.
    // Read in FULL and stripped: `--abbrev-ref` disambiguates, so a tag named
    // `origin/feature` turns the display into `remotes/origin/feature`.
    let full = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--symbolic-full-name", &upstream_rev],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if full.code != 0 {
        return Ok(BranchRewriteStatus::unknown());
    }
    let full = full.stdout_lossy();
    let full = full.trim();
    let upstream = full
        .strip_prefix("refs/remotes/")
        .or_else(|| full.strip_prefix("refs/heads/"))
        .unwrap_or(full)
        .to_string();
    if upstream.is_empty() {
        return Ok(BranchRewriteStatus::unknown());
    }
    let Some(local_tip) = branch_tip_sha(repo_path, branch).await? else {
        return Ok(BranchRewriteStatus::unknown());
    };

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

    // Both ends as measured shas: a bare branch name resolves to a same-named tag
    // first, and the upstream side is then the exact commit a reset would land on.
    let range = format!("{local_tip}...{tip}");

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
    // `None` rather than reading absence as a rewrite. The full ref, because a bare
    // name with no branch reflog falls back to a same-named ref's (a tag's, under
    // `logAllRefUpdates=always`).
    let reflog = run_git_raw(
        Some(repo_path),
        &[
            "rev-list",
            "--walk-reflogs",
            &format!("refs/heads/{branch}"),
        ],
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

    // Two halves of one window, as in `git_delete_branch_core`: the marker covers an
    // update that has minted but not yet registered its checkout, the porcelain arm
    // below covers it once registered. Heal-free — healing lives in the claim arm.
    crate::git::update_marker::refuse_if_branch_updating_no_heal(state, repo_path, branch).await?;
    // Pre-mutation guards: git refuses both of these itself, but only after the
    // user has confirmed a destructive action, and its wording names neither
    // remedy. The linked-worktree probe excludes THIS checkout, so the current
    // branch takes its own arm.
    if let Some(path) = worktree_holding_branch(repo_path, branch).await {
        // An update's hidden checkout names no remedy the user can follow; it is
        // refused while live and swept once dead (see `clear_update_holder`).
        let swept = clear_update_holder(state, repo_path, branch, &path).await?;
        let held = if swept {
            worktree_holding_branch(repo_path, branch).await
        } else {
            Some(path)
        };
        if let Some(path) = held {
            return Err(AppError::Command(format!(
                "{branch} is checked out in the worktree at {path} — switch that worktree \
                 to another branch (or remove it) before resetting {branch}."
            )));
        }
    }
    // A symbolic-ref that RAN but failed falls through to `branch -f`, which refuses
    // a checked-out branch itself; only a spawn failure aborts here.
    let current = match current_branch_name(repo_path).await {
        Ok(name) => name,
        Err(AppError::Git { .. }) => None,
        Err(e) => return Err(e),
    };
    if current.as_deref() == Some(branch) {
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
/// - checked out in ANOTHER checkout → the same fast-forward or merge runs inside that
///   checkout, which reports back as `holder`; a session's, mid-operation, dirty or
///   conflicting holder is refused as [`AppError::BranchHeld`] with nothing changed.
///
/// When `branch` IS the current branch there's nothing to avoid switching to, so it
/// merges in place (conflicts surface in the changes list as usual — no abort).
#[tauri::command]
pub async fn git_update_branch_from(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    repo_path: String,
    branch: String,
    base: String,
) -> AppResult<UpdateBranchOutcome> {
    use tauri::Manager;
    let session_paths = crate::sessions::session_worktree_paths(&app);
    // The same root `worktree::git_worktree_list_user` hides as app-internal.
    let app_data_root =
        app.path().app_data_dir().ok().map(|d| {
            crate::git::worktree::normalize_wt_path(&d.join("worktrees").to_string_lossy())
        });
    update_branch_from(
        &state,
        &repo_path,
        &branch,
        &base,
        &session_paths,
        app_data_root.as_deref(),
    )
    .await
}

/// What an update did, and where.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateBranchOutcome {
    /// "merge" | "up-to-date" | "fast-forward" — the existing strings, unchanged.
    pub outcome: String,
    /// The holder checkout's path (porcelain spelling from `worktree list`) when the
    /// update ran inside another checkout; None on every other arm.
    pub holder: Option<String>,
}

impl UpdateBranchOutcome {
    /// An update that ran in this checkout or a throwaway one.
    fn unheld(outcome: &str) -> Self {
        Self {
            outcome: outcome.to_string(),
            holder: None,
        }
    }
}

/// Testable core of [`git_update_branch_from`] — takes a plain `&AppState` so
/// real-repo tokio tests can drive it (mirrors `git::ops`' `*_core` pairs).
/// `session_paths` (the agent-session registry's worktree set) and `app_data_root` (the
/// normalized app-data worktrees root) name checkouts a held branch is never updated in.
pub(crate) async fn update_branch_from(
    state: &AppState,
    repo_path: &str,
    branch: &str,
    base: &str,
    session_paths: &HashSet<String>,
    app_data_root: Option<&str>,
) -> AppResult<UpdateBranchOutcome> {
    validate_branch_name(branch)?;
    validate_branch_name(base)?;
    if branch == base {
        return Err(AppError::InvalidArgument(
            "a branch can't be updated from itself".to_string(),
        ));
    }
    // One guard covers both self-collisions: a second update of the same branch, and
    // the fast-forward arm's `fetch . <base>:<branch>`, which git refuses outright
    // against a branch held by the first update's checkout. Heal-free deliberately —
    // this path's own `worktree add` takes the admin domain, and a detached sweep
    // fired here would win it first and time that bounded acquire out.
    crate::git::update_marker::refuse_if_branch_updating_no_heal(state, repo_path, branch).await?;
    // Healing, in two tiers. THIS branch's provably-dead leftovers go first and
    // synchronously, so the first update after a crash clears its own predecessor
    // before the add rather than racing it; everything else waits for the age gate and
    // is skipped outright while the admin domain is busy.
    crate::git::update_marker::claim_dead_updates_for_branch(state, repo_path, branch).await;
    crate::git::update_marker::sweep_orphaned_update_worktrees(state, repo_path).await;

    // Mutating refs — serialize against other writes to this repo's working tree.
    let domain = state.working_tree_lock(repo_path).await;
    let guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a branch update").await?;

    // An unborn branch has nothing to merge into, and an in-place merge would adopt
    // `base`'s history as its first commit.
    let current = current_branch_name(repo_path).await?;
    if current.is_some() && head_is_unborn(repo_path).await? {
        return Err(unborn_head_error());
    }
    // Every rev position below reads `base` as a branch, never a same-named tag, and
    // `branch` by its tip sha.
    let base_rev = branch_first_rev(repo_path, base).await;

    // The current branch is already checked out, so just merge in place.
    if current.as_deref() == Some(branch) {
        let already_unmerged = crate::git::ops::unmerged_paths(repo_path).await;
        // Raw: a conflicted merge reports entirely on stdout and leaves stderr
        // empty (measured, git 2.51.1), which a stderr-only error renders as
        // "git exited with code 1". Lock-free runners only — the hold is ours.
        let out = run_git_raw(
            Some(repo_path),
            &["merge", "--no-edit", &base_rev],
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
        return Ok(UpdateBranchOutcome::unheld("merge"));
    }

    // Read under THIS hold: the holder and diverged arms below pin it too.
    let Some(branch_tip) = branch_tip_sha(repo_path, branch).await? else {
        return Err(AppError::InvalidArgument(format!(
            "unknown branch: {branch}"
        )));
    };

    // base already reachable from branch → nothing to bring in.
    let already = run_git_raw(
        Some(repo_path),
        &["merge-base", "--is-ancestor", &base_rev, &branch_tip],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if already.code == 0 {
        return Ok(UpdateBranchOutcome::unheld("up-to-date"));
    }

    // branch reachable from base → pure fast-forward.
    let ff = run_git_raw(
        Some(repo_path),
        &["merge-base", "--is-ancestor", &branch_tip, &base_rev],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let fast_forward = ff.code == 0;

    // Both ends are pinned under THIS hold, because the holder and diverged arms below
    // release it: either ref can move meanwhile.
    let base_out = run_git_raw(
        Some(repo_path),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{base_rev}^{{commit}}"),
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

    // A branch another checkout holds is updated INSIDE that checkout. Clearing a dead
    // update's holder takes ADMIN and removes its checkout under THIS hold: a bounded,
    // try-only exception to the nesting rule, rare once `claim_dead_updates_for_branch` ran.
    let mut holder = worktree_holding_branch(repo_path, branch).await;
    if let Some(path) = holder.as_deref() {
        if clear_update_holder(state, repo_path, branch, path).await? {
            holder = worktree_holding_branch(repo_path, branch).await;
        }
    }
    if let Some(holder) = holder {
        if is_session_holder(&holder, branch, session_paths, app_data_root) {
            return Err(branch_held(
                "session",
                &holder,
                branch,
                format!(
                    "{branch} is checked out in a worktree GitDesktop manages at {holder}, so \
                     it is not updated from here. {branch} is unchanged."
                ),
            ));
        }
        let merge = if fast_forward {
            HolderMerge::FastForward
        } else {
            HolderMerge::Merge {
                subject: merge_subject(repo_path, &base_rev, branch).await,
            }
        };
        // No task takes two locks of one domain: release this checkout's first.
        drop(guard);
        return update_in_holder(state, &holder, branch, base, &pins.base_sha, merge).await;
    }

    // `fetch .` refuses a branch checked out anywhere, so it runs only for an UNHELD one:
    // the current branch took the in-place arm and every held one the holder arm. Its
    // SOURCE resolves tag-first like any rev; the destination is spelled in full so it
    // can only ever name the branch.
    if fast_forward {
        run_git(
            Some(repo_path),
            &["fetch", ".", &format!("{base_rev}:refs/heads/{branch}")],
            DEFAULT_TIMEOUT,
        )
        .await?;
        return Ok(UpdateBranchOutcome::unheld("fast-forward"));
    }

    // Diverged → merge in a throwaway worktree so the user's checkout is untouched. The
    // worktree steps below run in the worktree-admin domain, which nests with no other.
    drop(guard);

    // Minted under the app-data worktrees root, never the OS temp dir: that
    // placement is what hides the checkout from the user-facing worktree listing
    // and the surfaces built on it (`is_session_worktree`'s app-data arm).
    let tmp = update_worktree_path(repo_path).await?;
    if let Some(root) = tmp.parent() {
        std::fs::create_dir_all(root).map_err(AppError::Io)?;
    }
    // Before the `worktree add`, which is the longest part of the window this marker
    // exists to announce. A failure to mint refuses the update: an app-data write that
    // fails is the same failure domain as materializing the checkout itself.
    let marker = crate::git::update_marker::UpdateMarker::create_for(&tmp, branch)?;
    let tmp_str = tmp.to_string_lossy().to_string();
    merge_diverged_in_worktree(
        state,
        repo_path,
        &tmp_str,
        branch,
        base,
        &pins,
        Some(marker),
    )
    .await
    .map(|outcome| UpdateBranchOutcome::unheld(&outcome))
}

/// Whether `holder` is an app-internal checkout, matched as the worktree manager hides
/// one (`worktree::is_session_worktree`): registry paths compared normalized, with the
/// `gd/session/` branch and the app-data root (a hidden update's home too) as backstops.
/// The root takes a trailing separator, so a SIBLING `<root>x/…` never matches.
fn is_session_holder(
    holder: &str,
    branch: &str,
    session_paths: &HashSet<String>,
    app_data_root: Option<&str>,
) -> bool {
    use crate::git::worktree::normalize_wt_path;
    let holder = normalize_wt_path(holder);
    branch.starts_with("gd/session/")
        || session_paths.iter().any(|p| normalize_wt_path(p) == holder)
        || app_data_root.is_some_and(|root| holder.starts_with(&format!("{root}/")))
}

/// A refusal from the holder arm, which leaves `branch` and its holder as they were.
fn branch_held(reason: &str, holder: &str, branch: &str, message: String) -> AppError {
    AppError::BranchHeld {
        message,
        holder: holder.to_string(),
        branch: branch.to_string(),
        reason: reason.to_string(),
    }
}

/// Which merge the holder arm runs, decided by the ancestry read under the first hold.
enum HolderMerge {
    FastForward,
    /// `subject` words the commit as a merge of `base` by name ([`merge_subject`]).
    Merge {
        subject: Option<String>,
    },
}

/// The update of a `branch` that the checkout at `holder` has checked out: `fetch .`
/// and `worktree add` both refuse a held branch, so the fast-forward or merge runs
/// inside that checkout, under ITS working-tree lock, and its index and tree advance
/// with the ref. The caller must not hold another working-tree lock, and everything
/// here runs on lock-free runners because the hold is ours.
///
/// The merge takes `base_sha`, the base PINNED under the first hold, so a base that
/// moved after the pin cannot change what lands. A branch that already contains the pin
/// by the time the hold is taken answers `"up-to-date"` without merging.
async fn update_in_holder(
    state: &AppState,
    holder: &str,
    branch: &str,
    base: &str,
    base_sha: &str,
    merge: HolderMerge,
) -> AppResult<UpdateBranchOutcome> {
    validate_branch_name(branch)?;
    let domain = state.working_tree_lock(holder).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a branch update").await?;

    // Re-checked under the hold, in order: the holder was found before it was taken.
    if current_branch_name(holder).await?.as_deref() != Some(branch) {
        return Err(branch_held(
            "moved",
            holder,
            branch,
            format!(
                "The checkout at {holder} switched away from {branch} before it could be \
                 updated — try again. {branch} is unchanged."
            ),
        ));
    }
    // The reads `ops::refuse_mid_op_for` gates on, split so the refusal can name the
    // operation.
    let op = crate::git::ops::op_state(holder).await?;
    let paused = if op.rebasing {
        Some("a rebase")
    } else if op.merging {
        Some("a merge")
    } else if op.cherry_picking {
        Some("a cherry-pick")
    } else if op.reverting {
        Some("a revert")
    } else if crate::git::ops::has_unmerged(holder).await? {
        Some("resolving conflicts")
    } else {
        None
    };
    if let Some(paused) = paused {
        return Err(branch_held(
            "mid-op",
            holder,
            branch,
            format!(
                "The checkout at {holder} is in the middle of {paused} — finish or abort it \
                 there, then try again. {branch} is unchanged."
            ),
        ));
    }
    // Tracked changes only: untracked files don't block a merge, and one the merge
    // would overwrite is refused by git itself in the failure arms below.
    if has_tracked_changes(holder).await? {
        return Err(branch_held(
            "dirty",
            holder,
            branch,
            format!(
                "The checkout at {holder} has uncommitted changes — commit or stash them \
                 there, then try again. {branch} is unchanged."
            ),
        ));
    }

    let updated = |outcome: &str| UpdateBranchOutcome {
        outcome: outcome.to_string(),
        holder: Some(holder.to_string()),
    };

    // A branch that took in the base since the first read must not report git's
    // "Already up to date" no-op as an update.
    let contains = run_git_raw(
        Some(holder),
        &["merge-base", "--is-ancestor", base_sha, "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if contains.code == 0 {
        return Ok(updated("up-to-date"));
    }

    // Both merges pass `--no-overwrite-ignore`: an ignored file is local data its owner
    // can't see being consumed, and the flag turns git's silent overwrite into a refusal
    // the failure arms below already classify.
    let subject = match merge {
        HolderMerge::FastForward => {
            let out = run_git_raw(
                Some(holder),
                &["merge", "--ff-only", "--no-overwrite-ignore", base_sha],
                DEFAULT_TIMEOUT,
            )
            .await?;
            if out.code != 0 {
                // A refused ff-only merge writes nothing.
                return Err(branch_held(
                    "failed",
                    holder,
                    branch,
                    format!(
                        "Couldn't fast-forward {branch} to {base} in the checkout at {holder}. \
                         {branch} is unchanged.\n{}",
                        out.full_failure_text()
                    ),
                ));
            }
            return Ok(updated("fast-forward"));
        }
        HolderMerge::Merge { subject } => subject,
    };

    // Raw: a conflicted merge reports entirely on stdout with stderr empty (measured,
    // git 2.51.1), the same trap the in-place arm documents.
    let mut args = vec!["merge", "--no-edit", "--no-overwrite-ignore"];
    if let Some(subject) = subject.as_deref() {
        args.extend(["-m", subject]);
    }
    args.push(base_sha);
    let merged = run_git_raw(Some(holder), &args, DEFAULT_TIMEOUT).await;
    if merged.as_ref().is_ok_and(|out| out.code == 0) {
        return Ok(updated("merge"));
    }
    let merge_text = match &merged {
        Ok(out) => out.full_failure_text(),
        Err(e) => e.to_string(),
    };

    // The conflict list comes from the index, read before the abort clears it. A merge
    // git refused before starting (an untracked or ignored file in the way) has nothing
    // to abort.
    let conflicts = crate::git::ops::unmerged_paths(holder).await;
    // An unreadable op state counts as mid-merge, so it can never pass as restored.
    let mid_merge =
        |probe: AppResult<crate::git::types::RepoOpState>| probe.map_or(true, |s| s.merging);
    let abort_failure = if mid_merge(crate::git::ops::op_state(holder).await) {
        match run_git_raw(Some(holder), &["merge", "--abort"], DEFAULT_TIMEOUT).await {
            Ok(out) if out.code == 0 => None,
            Ok(out) => Some(out.full_failure_text()),
            Err(e) => Some(e.to_string()),
        }
    } else {
        None
    };
    // Our own residue only: the hold serializes GitDesktop, not the user's editor, so a
    // tracked edit saved during the merge is theirs and never reads as a failed restore.
    let restored = abort_failure.is_none() && !mid_merge(crate::git::ops::op_state(holder).await);
    if !restored {
        let abort_text = abort_failure.unwrap_or_default();
        return Err(branch_held(
            "failed",
            holder,
            branch,
            format!(
                "Merging {base} into {branch} in the checkout at {holder} failed, and that \
                 checkout could not be put back as it was, so it needs manual attention. \
                 {branch} is unchanged.\n{merge_text}\n{abort_text}"
            )
            .trim_end()
            .to_string(),
        ));
    }
    if !conflicts.is_empty() {
        return Err(branch_held(
            "conflict",
            holder,
            branch,
            format!(
                "{branch} has changes that conflict with {base} in {}, so the merge in the \
                 checkout at {holder} was aborted. {branch} is unchanged.",
                name_conflicts(&conflicts)
            ),
        ));
    }
    Err(branch_held(
        "failed",
        holder,
        branch,
        format!(
            "Couldn't merge {base} into {branch} in the checkout at {holder}. {branch} is \
             unchanged.\n{merge_text}"
        ),
    ))
}

/// Whether `dir`'s checkout has staged or unstaged changes to TRACKED files.
async fn has_tracked_changes(dir: &str) -> AppResult<bool> {
    let status = run_git(
        Some(dir),
        &["status", "--porcelain", "--untracked-files=no"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(!status.stdout_lossy().trim().is_empty())
}

/// The first three conflicting paths, then a count of the rest.
fn name_conflicts(paths: &[String]) -> String {
    const NAMED: usize = 3;
    let named = paths
        .iter()
        .take(NAMED)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    match paths.len().saturating_sub(NAMED) {
        0 => named,
        more => format!("{named} and {more} more"),
    }
}

/// The subject git gives a merge of `base_rev` by name, for a merge that takes its
/// pinned sha instead, which git would title "Merge commit '<sha>'". `None` — git's own
/// wording — when the rev names neither a local nor a remote-tracking branch.
async fn merge_subject(repo_path: &str, base_rev: &str, branch: &str) -> Option<String> {
    let out = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--symbolic-full-name", base_rev],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .filter(|out| out.code == 0)?;
    let full = out.stdout_lossy();
    let full = full.trim();
    let source = if let Some(name) = full.strip_prefix("refs/heads/") {
        format!("branch '{name}'")
    } else if let Some(name) = full.strip_prefix("refs/remotes/") {
        format!("remote-tracking branch '{name}'")
    } else {
        return None;
    };
    Some(format!("Merge {source} into {branch}"))
}

/// Where an update's throwaway checkout goes: `<app-data>/worktrees/<identity-hash>/
/// gd-update-<unique>`. Resolution only — creating the root is the caller's job.
///
/// Through `update_marker::root_for`, not `ops::worktree_root_dir` directly, so the
/// mint and the guards that police it can never disagree about which root they mean.
/// Alone among that function's callers this one PROPAGATES an unresolvable root instead
/// of failing open: a guard that cannot resolve simply stays quiet, but a mint that
/// cannot would put a checkout where nothing is watching it.
async fn update_worktree_path(repo_path: &str) -> AppResult<std::path::PathBuf> {
    Ok(crate::git::update_marker::root_for(repo_path)
        .await?
        .join(format!("gd-update-{}", unique_suffix())))
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
pub(crate) async fn branch_tip_sha(repo_path: &str, branch: &str) -> AppResult<Option<String>> {
    validate_branch_name(branch)?;
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
    marker: Option<crate::git::update_marker::UpdateMarker>,
) -> AppResult<String> {
    // A killed add can still leave a registered entry over a partial directory, so its
    // early return settles the marker rather than dropping it: the checkout it may have
    // left behind needs a recoverable marker exactly as much as a finished one does.
    if let Err(e) = run_git_worktree_admin(
        state,
        repo_path,
        &["worktree", "add", "--quiet", tmp, branch],
        WORKTREE_OP_TIMEOUT,
    )
    .await
    {
        settle_marker(marker, tmp);
        return Err(e);
    }

    let result = verify_pin_and_merge(state, repo_path, tmp, branch, base, pins).await;

    // Try-then-detach is the only teardown shape with no bad arm: a bounded acquire
    // that gave up on `Busy` would leak the throwaway worktree, and a synchronous
    // unbounded one holds a finished update's command hostage for the minutes a
    // node_modules-scale removal can hold the shared admin domain. On both arms the
    // marker outlives the checkout, since the branch stays held until the directory is
    // gone, and `settle_marker` keeps it on disk when the removal did not finish. A
    // quit or crash leaks the directory with its marker still beside it — released, so
    // the next branch operation clears it without waiting out the age gate.
    let domain = state.worktree_admin_lock(repo_path).await;
    match try_acquire_repo_lock(&domain, "a worktree operation") {
        Some(_admin) => {
            remove_tmp_worktree(repo_path, tmp).await;
            settle_marker(marker, tmp);
        }
        None => {
            let (repo, tmp) = (repo_path.to_string(), tmp.to_string());
            tauri::async_runtime::spawn(async move {
                let _admin = acquire_repo_lock_unbounded(&domain, "a worktree operation").await;
                remove_tmp_worktree(&repo, &tmp).await;
                settle_marker(marker, &tmp);
            });
        }
    }

    result
}

/// Drops `marker` after a teardown attempt. Its files go only when the checkout is
/// confirmed gone; a surviving directory keeps them, unlocked, so the age-free claims
/// can recover it on the next branch operation. Deleting them there would leave a
/// markerless holder instead, which nothing may clear until the age gate expires.
fn settle_marker(marker: Option<crate::git::update_marker::UpdateMarker>, tmp: &str) {
    let Some(mut marker) = marker else { return };
    // try_exists: an UNREADABLE answer must retain (the sidecars' deletion is the one
    // destructive direction here); only a confirmed-gone checkout lets them go.
    if std::path::Path::new(tmp).try_exists().unwrap_or(true) {
        marker.retain_for_recovery();
    }
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

/// Under a fresh working-tree hold: confirm the branch still stands where it was
/// pinned and the base still descends from its pin, then merge `base`'s branch-first
/// rev inside the throwaway worktree at `tmp`. The merge writes the shared
/// `refs/heads/<branch>`, which is why it belongs in this domain. The rev keeps the
/// plain name (and the `Merge branch '<base>'` subject) unless a same-named tag shadows
/// it, when the full ref words the subject instead; the pins are what keep a ref that
/// moved while the worktree materialized from silently changing the operation. The
/// hold covers writers on THIS checkout only — another worktree of the same repo
/// takes its own working-tree lock, and a session-worktree removal deletes refs under
/// the admin hold, so a cross-checkout mover is outside what it promises.
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

    // The base check runs in the TMP worktree's cwd — the $GIT_DIR the merge resolves
    // in. gitrevisions takes $GIT_DIR-local names (HEAD, MERGE_HEAD, …) ahead of
    // `refs/heads/`, and `validate_branch_name` admits a literal "HEAD", so a check in
    // the main checkout could pass over a different object than the merge takes.
    //
    // Three arms, so the refusal describes what happened. A base that only
    // fast-forwarded is what a fresh update would merge — the app's own auto-fetch
    // advances a remote-tracking base mid-window — so it proceeds. Exit 1 means the
    // name did not resolve, and phase 1 already resolved it, so that base was deleted:
    // its own wording, since a retry cannot find it either. A rewound or rewritten
    // base, and any OTHER non-zero exit (128 — a vanished or corrupt tmp gitdir,
    // measured git 2.51.1), take the retry wording, which suits a transient state.
    // Both reads and the merge take the base BRANCH, never a same-named tag.
    let base_rev = branch_first_rev(tmp, base).await;
    let base_now = run_git_raw(
        Some(tmp),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{base_rev}^{{commit}}"),
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if base_now.code == 1 {
        return Err(AppError::Command(format!(
            "{base} was deleted while this update was running — there is nothing to update from."
        )));
    }
    let base_now_sha = base_now.stdout_lossy().trim().to_string();
    if base_now.code != 0 || base_now_sha != pins.base_sha {
        // The ancestor probe needs a resolved sha, so a failed re-resolve skips it
        // and refuses.
        let fast_forwarded = base_now.code == 0
            && run_git_raw(
                Some(tmp),
                &["merge-base", "--is-ancestor", &pins.base_sha, &base_now_sha],
                DEFAULT_TIMEOUT,
            )
            .await
            .is_ok_and(|out| out.code == 0);
        if !fast_forwarded {
            return Err(AppError::Command(format!(
                "{base} moved while this update was running — try again to see where it stands."
            )));
        }
    }

    // The merge keeps the default budget: it rewrites only the differing files, not
    // the whole tree. Lock-free runner — the hold is ours.
    let merged = run_git_raw(
        Some(tmp),
        &["merge", "--no-edit", &base_rev],
        DEFAULT_TIMEOUT,
    )
    .await;
    if merged.as_ref().is_ok_and(|out| out.code == 0) {
        return Ok("merge".to_string());
    }

    // The conflict verdict comes from the INDEX, read before the abort clears it — the
    // exit code cannot carry it: a `pre-merge-commit` hook that declines also exits 1
    // with the auto-merge clean and nothing unmerged, and hooks resolve from the COMMON
    // dir, so the main repo's hooks run in this worktree (measured, git 2.51.1).
    let conflicted = !crate::git::ops::unmerged_paths(tmp).await.is_empty();
    // Undo the half-done merge so the branch ref is left as it was. Every failure path
    // reaches this, the runner's Err included — a timeout that returned early would
    // leave tmp mid-merge.
    let _ = run_git_raw(Some(tmp), &["merge", "--abort"], DEFAULT_TIMEOUT).await;

    // Only a real conflict has a remedy to name; everything else carries git's report.
    if conflicted {
        return Err(AppError::InvalidArgument(format!(
            "{branch} has changes that conflict with {base}. Switch to {branch} to merge and resolve them."
        )));
    }
    Err(match merged {
        Ok(out) => AppError::Command(format!(
            "merging {base} into {branch} failed — try again to see where it stands.\n{}",
            out.full_failure_text()
        )),
        Err(e) => AppError::Command(format!(
            "merging {base} into {branch} failed — try again to see where it stands.\n{e}"
        )),
    })
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
    use super::git_delete_remote_branch_core;
    use super::{archive_config_busy, set_branch_archived_core};
    use super::{
        branch_reset_to_upstream, branch_rewrite_status, build_create_branch_args,
        divergence_out_of_range, git_branch_merge_states, git_branches,
        git_checkout_remote_branch_core, git_create_branch_core, git_default_branch,
        git_delete_branch_core, git_rename_branch_core, is_config_lock_contention,
        merge_diverged_in_worktree, parse_cherry_counts, parse_upstream_track, update_branch_from,
        update_worktree_path, validate_branch_name, validate_ref_name, BranchRewriteStatus,
        MergePair, UpdatePins, RENAMED_CONFIG_LEFT_BEHIND, UPSTREAM_WRITE_FAILED,
    };
    use super::{
        branch_tip_sha, current_branch_name, is_session_holder, name_conflicts, update_in_holder,
        worktree_holding_branch, HolderMerge, UpdateBranchOutcome,
    };
    use crate::error::AppError;
    use crate::git::runner::{
        acquire_repo_lock, hold_config_lock, release_config_lock_before_attempt, run_git,
        run_git_raw, CONFIG_WRITE_ATTEMPT_HOOK, DEFAULT_TIMEOUT,
    };
    use crate::state::AppState;
    use std::collections::HashSet;
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

        // A remote-tracking start point spelled as its full ref keeps the short form's
        // tip and tracking, and a LOCAL branch literally named `origin/x` can't
        // capture it.
        std::fs::write(repo.join("r.txt"), "moved\n").unwrap();
        run(&repo_s, &["commit", "-qam", "local work"]).await;
        run(&repo_s, &["branch", "origin/x"]).await;
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "w".into(),
            false,
            Some("refs/remotes/origin/x".into()),
            false,
        )
        .await
        .expect("create w succeeds");
        assert_eq!(
            run(
                &repo_s,
                &["rev-parse", "--symbolic-full-name", "w@{upstream}"]
            )
            .await
            .trim(),
            "refs/remotes/origin/x",
            "w should track origin/x"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/w"]).await,
            run(&repo_s, &["rev-parse", "refs/remotes/origin/x"]).await,
            "w should start at the remote-tracking ref, not the local origin/x"
        );

        // The local twin: `refs/heads/...` reads the branch even where a same-named
        // tag on another commit captures the short form.
        run(&repo_s, &["tag", "origin/x", "refs/remotes/origin/x"]).await;
        git_create_branch_core(
            &state,
            repo_s.clone(),
            "v".into(),
            false,
            Some("refs/heads/origin/x".into()),
            false,
        )
        .await
        .expect("create v succeeds");
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/v"]).await,
            run(&repo_s, &["rev-parse", "refs/heads/origin/x"]).await,
            "v should start at the local branch, not the tag"
        );
        assert_ne!(
            run(&repo_s, &["rev-parse", "refs/heads/v"]).await,
            run(&repo_s, &["rev-parse", "refs/tags/origin/x"]).await,
            "fixture sanity: the tag sits on another commit"
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

    /// Every row names its branch exactly, however git would shorten it: a branch
    /// shadowed by a same-named tag, and one whose `heads/<name>` is itself taken by a
    /// branch (git then answers the full ref). The archive flag, keyed by name, follows.
    #[tokio::test]
    async fn git_branches_names_branches_shadowed_by_tags() {
        let (_base, base) = temp_base("list-tag-shadow");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["branch", "shadowed"]).await;
        run(&repo_s, &["tag", "shadowed"]).await;
        run(&repo_s, &["branch", "ambiguous"]).await;
        run(&repo_s, &["tag", "ambiguous"]).await;
        run(&repo_s, &["branch", "heads/ambiguous"]).await;
        set_branch_archived_core(&repo_s, "shadowed", true)
            .await
            .expect("archive shadowed");

        let branches = git_branches(repo_s.clone()).await.expect("list branches");
        let mut names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        names.sort_unstable();
        assert!(
            names.contains(&"shadowed")
                && names.contains(&"ambiguous")
                && names.contains(&"heads/ambiguous"),
            "{names:?}"
        );
        assert!(
            !names
                .iter()
                .any(|n| *n == "heads/shadowed" || n.starts_with("refs/")),
            "{names:?}"
        );
        let shadowed = branches.iter().find(|b| b.name == "shadowed").unwrap();
        assert!(
            shadowed.archived,
            "the archive flag is keyed by the real name"
        );
    }

    /// A remote-tracking ref shortened past `<remote>/<branch>` by a tag named
    /// `origin/main` still splits into that remote and branch, and the remote's
    /// symbolic HEAD stays out of the list.
    #[tokio::test]
    async fn git_remote_branches_split_refs_shadowed_by_a_tag() {
        let (_base, base) = temp_base("remote-list-tag-shadow");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        run(
            &repo_s,
            &["update-ref", "refs/remotes/origin/feat/x", "HEAD"],
        )
        .await;
        run(
            &repo_s,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        )
        .await;
        run(&repo_s, &["tag", "origin/main"]).await;

        let rows = super::git_remote_branches(repo_s.clone())
            .await
            .expect("list remote branches");
        let mut pairs: Vec<(String, String)> =
            rows.into_iter().map(|b| (b.remote, b.name)).collect();
        pairs.sort();
        assert_eq!(
            pairs,
            vec![
                ("origin".to_string(), "feat/x".to_string()),
                ("origin".to_string(), "main".to_string()),
            ]
        );
    }

    /// The tracking checkout starts from the remote-tracking ref itself: a tag named
    /// `origin/<branch>` makes the bare `origin/<branch>` ambiguous, and git refuses it.
    #[tokio::test]
    async fn checkout_remote_branch_tracks_the_remote_ref_shadowed_by_a_tag() {
        let (_base, base) = temp_base("checkout-remote-tag-shadow");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        // The tag sits on the seed commit, the remote branch one commit past it.
        run(&repo_s, &["tag", "origin/landing"]).await;
        std::fs::write(repo.join("r.txt"), "remote\n").unwrap();
        run(&repo_s, &["commit", "-qam", "remote work"]).await;
        run(
            &repo_s,
            &["update-ref", "refs/remotes/origin/landing", "HEAD"],
        )
        .await;
        run(&repo_s, &["reset", "-q", "--hard", "HEAD~1"]).await;

        let state = AppState::default();
        git_checkout_remote_branch_core(&state, repo_s.clone(), "origin".into(), "landing".into())
            .await
            .expect("the tracking checkout succeeds");
        assert_eq!(
            run(&repo_s, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/landing"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/landing"]).await,
            run(&repo_s, &["rev-parse", "refs/remotes/origin/landing"]).await,
            "the branch starts at the remote ref, never the tag"
        );
        assert_eq!(
            tracking_of(&repo_s, "landing").await,
            (Some("origin".into()), Some("refs/heads/landing".into()))
        );
    }

    /// Rows are named by the real branch and measured through its full ref, and the
    /// base is read as a branch too: a bare `feature` or base name would resolve to the
    /// same-named tag (gitrevisions checks tags first) and report the tag's counts.
    #[tokio::test]
    async fn branch_divergence_names_and_measures_branches_shadowed_by_tags() {
        let (_base, base) = temp_base("divergence-tag-shadow");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        // Both tags stay on the seed while both branches move past it.
        run(&repo_s, &["tag", &main]).await;
        run(&repo_s, &["switch", "-qc", "feature"]).await;
        run(&repo_s, &["tag", "feature"]).await;
        std::fs::write(repo.join("f.txt"), "f\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "feature work"]).await;
        run(&repo_s, &["switch", "-q", &main]).await;
        std::fs::write(repo.join("m.txt"), "m\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "base work"]).await;

        let rows = super::git_branch_divergence(repo_s.clone(), main.clone())
            .await
            .expect("measure divergence");
        let mut got: Vec<(String, u32, u32)> = rows
            .into_iter()
            .map(|d| (d.name, d.ahead, d.behind))
            .collect();
        got.sort();
        let mut want = vec![("feature".to_string(), 1, 1), (main.clone(), 0, 0)];
        want.sort();
        assert_eq!(got, want);
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
        let err = update_branch_from(&state, &repo_s, &main, "feature", &HashSet::new(), None)
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

        let identity = crate::git::repo::repo_identity(&repo_s).await.unwrap();
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

    #[tokio::test]
    async fn rename_succeeds_without_migrating_notes_when_identity_is_unavailable() {
        let (_base, base) = temp_base("rename-identity-error");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.to_string_lossy().into_owned();
        init_repo(&repo, "r.txt").await;
        run(&repo, &["branch", "feature"]).await;
        let identity = crate::git::repo::repo_identity(&repo).await.unwrap();
        crate::review_notes::set(&identity, "feature", "keep this note")
            .await
            .unwrap();
        let state = AppState::default();
        crate::git::repo::TEST_IDENTITY_ERROR
            .scope(
                || AppError::Timeout(30),
                git_rename_branch_core(
                    &state,
                    repo.clone(),
                    "feature".into(),
                    "renamed".into(),
                ),
            )
            .await
            .expect("identity failure does not turn a completed rename into an error");
        assert!(run(&repo, &["branch", "--list", "renamed"])
            .await
            .contains("renamed"));
        assert!(run(&repo, &["branch", "--list", "feature"])
            .await
            .trim()
            .is_empty());
        assert_eq!(
            crate::review_notes::note_body(&identity, "feature").as_deref(),
            Some("keep this note")
        );
        assert_eq!(crate::review_notes::note_body(&identity, "renamed"), None);
        assert_eq!(crate::review_notes::note_body(&repo, "renamed"), None);
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

    /// Tags named like the branch (sitting on the upstream tip) and like its upstream
    /// must not stand in for either: a bare `feature` in the range resolves to the tag,
    /// collapsing the local side to zero, which is half of the reset offer's unlock.
    #[tokio::test]
    async fn rewrite_status_reads_the_branch_not_a_same_named_tag() {
        let (_base, base) = temp_base("rewrite-tag-shadow");
        let local_s = server_rebase_fixture(&base).await;
        std::fs::write(std::path::Path::new(&local_s).join("mine.txt"), "unique\n").unwrap();
        run(&local_s, &["add", "-A"]).await;
        run(&local_s, &["commit", "-qm", "my own work"]).await;
        run(&local_s, &["tag", "feature", "origin/feature"]).await;
        run(&local_s, &["tag", "origin/feature", "main"]).await;

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            (st.local_only, st.remote_only, st.remote_rewritten),
            (1, 1, Some(true)),
            "the branch's own unique commit still withholds the reset offer"
        );
        assert_eq!(st.upstream.as_deref(), Some("origin/feature"));
        assert_eq!(
            st.upstream_tip.as_deref(),
            Some(
                run(&local_s, &["rev-parse", "refs/remotes/origin/feature"])
                    .await
                    .trim()
            )
        );
    }

    /// The reflog walked is the BRANCH's only. A bare name walks `refs/heads/<name>`'s
    /// reflog when it has one, but with none it falls back to whichever same-named ref
    /// does — here a tag created at the upstream tip under tag reflogs, which would
    /// clear a branch that never saw that tip instead of refusing to guess.
    #[tokio::test]
    async fn rewrite_status_walks_the_branch_reflog_not_a_same_named_tags() {
        let (_base, base) = temp_base("rewrite-tag-reflog");
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
        run(&local_s, &["config", "core.logAllRefUpdates", "always"]).await;
        run(&local_s, &["tag", "feature", "refs/remotes/origin/feature"]).await;
        assert!(
            !run(&local_s, &["reflog", "show", "refs/tags/feature"])
                .await
                .trim()
                .is_empty(),
            "fixture sanity: the tag carries a reflog holding the upstream tip"
        );

        let st = branch_rewrite_status(&local_s, "feature")
            .await
            .expect("status resolves");
        assert_eq!(
            st.remote_rewritten, None,
            "the branch has no reflog to walk, so nothing is provable"
        );
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

    /// A tag sharing the current branch's name must not cost the worded refusal:
    /// the guard still recognizes `feature` as the branch checked out here.
    #[tokio::test]
    async fn reset_to_upstream_refuses_the_current_branch_shadowed_by_a_tag() {
        let (_base, base) = temp_base("reset-upstream-tag-shadow");
        let local_s = server_rebase_fixture(&base).await;
        run(&local_s, &["tag", "feature"]).await;
        let target = run(&local_s, &["rev-parse", "origin/feature"])
            .await
            .trim()
            .to_string();

        let state = AppState::default();
        let err = branch_reset_to_upstream(&state, &local_s, "feature", &target)
            .await
            .expect_err("the current branch can't take a ref-only reset");
        let AppError::Command(msg) = &err else {
            panic!("expected the actionable Command refusal, not git's own, got {err:?}");
        };
        assert!(msg.contains("sync controls"), "{msg}");
    }

    /// The remote's default branch stays undeletable when a tag or local branch named
    /// `<remote>/<branch>` makes `symbolic-ref --short` answer `remotes/origin/main`.
    /// Refused before any push, so the bare remote is never contacted.
    #[tokio::test]
    async fn delete_remote_branch_refuses_the_default_shadowed_by_a_tag() {
        let (_base, base) = temp_base("delete-remote-default-tag-shadow");
        let remote_s = base.join("remote").to_string_lossy().into_owned();
        run_git(None, &["init", "-q", "--bare", &remote_s], DEFAULT_TIMEOUT)
            .await
            .expect("init bare remote");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "r.txt").await;
        run(&repo_s, &["remote", "add", "origin", &remote_s]).await;
        // The local symref layout is written by hand as a clone leaves it; the
        // bare remote stays empty on purpose, so the local guard is what refuses.
        run(&repo_s, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        run(
            &repo_s,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        )
        .await;
        run(&repo_s, &["tag", "origin/main"]).await;

        let state = AppState::default();
        let err = git_delete_remote_branch_core(
            &state,
            repo_s.clone(),
            "origin".to_string(),
            "main".to_string(),
        )
        .await
        .expect_err("the remote's default branch can't be deleted from here");
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("default branch")),
            "{err:?}"
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

    /// The branch-first read: an unambiguous branch keeps its name, a shadowed one
    /// becomes its full ref, and names of no local branch pass through untouched.
    #[tokio::test]
    async fn branch_first_rev_qualifies_only_a_shadowed_branch() {
        let (_base, base_dir) = temp_base("branch-first-rev");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "plain"]).await;
        run(&repo_s, &["branch", "shadowed"]).await;
        run(&repo_s, &["tag", "shadowed"]).await;
        run(&repo_s, &["tag", "v1"]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        // A branch literally named `refs/heads/plain` must not capture that full ref.
        run(
            &repo_s,
            &["update-ref", "refs/heads/refs/heads/plain", "HEAD"],
        )
        .await;

        let mut got = Vec::new();
        for name in [
            "plain",
            "shadowed",
            "v1",
            "origin/main",
            "HEAD~0",
            "nope",
            "refs/heads/plain",
        ] {
            got.push(super::branch_first_rev(&repo_s, name).await);
        }
        assert_eq!(
            got,
            [
                "plain",
                "refs/heads/shadowed",
                "v1",
                "origin/main",
                "HEAD~0",
                "nope",
                "refs/heads/plain"
            ]
        );
    }

    /// A local PR's head is measured as the BRANCH: a same-named tag already merged
    /// into the base must not report an unmerged branch as merged.
    #[tokio::test]
    async fn branch_merge_states_measure_a_head_shadowed_by_a_tag() {
        let (_base, base_dir) = temp_base("merge-states-shadow");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        let base = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["tag", "feature"]).await;
        run(&repo_s, &["switch", "-qc", "feature"]).await;
        std::fs::write(repo.join("a.txt"), "feature\n").unwrap();
        run(&repo_s, &["commit", "-qam", "feature edit"]).await;
        run(&repo_s, &["switch", "-q", &base]).await;

        let states = git_branch_merge_states(
            repo_s.clone(),
            vec![MergePair {
                base: base.clone(),
                head: "feature".into(),
            }],
        )
        .await
        .unwrap();
        assert_eq!((states[0].merged, states[0].head_exists), (false, true));
    }

    /// The throwaway checkout is minted as a direct child of the SAME root the marker
    /// guards read, with a unique `gd-update-` name — which is what keeps it out of the
    /// worktree manager and inside `is_managed_update_worktree`'s scope. That root being
    /// the app-data one in production is `root_for`'s non-test arm, pinned by
    /// `ops::worktree_root_dir_uses_the_shipped_bundle_identifier`. Shape only: resolving
    /// a path creates nothing.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // root override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_worktree_path_sits_directly_under_the_marker_root() {
        use crate::git::update_marker as marker;
        let (_temp, root) = temp_base("mint-root");
        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);

        let repo = "C:\\repos\\app";
        let first = update_worktree_path(repo).await.expect("update path resolves");
        assert_eq!(first.parent(), Some(root.as_path()));
        let name = first
            .file_name()
            .and_then(|s| s.to_str())
            .expect("the mint has a basename");
        assert!(name.starts_with("gd-update-"), "{name}");
        assert!(
            marker::is_managed_update_worktree(repo, &first.to_string_lossy()).await,
            "the mint must land inside the scope its own guards enforce"
        );
        assert_ne!(
            first,
            update_worktree_path(repo).await.expect("update path resolves"),
            "two mints in one process must not collide"
        );
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
                let err = update_branch_from(&state, &repo_s, branch, base, &HashSet::new(), None)
                    .await
                    .unwrap_err();
                assert!(
                    matches!(&err, AppError::InvalidArgument(m) if m.contains("invalid branch name")),
                    "{branch:?} from {base:?} got: {err:?}"
                );
            }
        }
    }

    /// Updating the CURRENT branch merges in place even when a tag shares its name;
    /// missing that arm sends the update to a throwaway checkout of a branch that is
    /// already checked out here.
    #[tokio::test]
    async fn update_branch_from_merges_a_current_branch_shadowed_by_a_tag_in_place() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-tag-shadow").await;
        run(&repo_s, &["switch", "-q", "feature"]).await;
        run(&repo_s, &["tag", "feature"]).await;

        let state = AppState::default();
        let outcome = update_branch_from(&state, &repo_s, "feature", &main, &HashSet::new(), None)
            .await
            .expect("the in-place merge succeeds");
        assert_eq!(outcome.outcome, "merge");
        assert_eq!(
            run(&repo_s, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/feature"
        );
        assert!(
            repo.join("base.txt").exists(),
            "the base's work is merged in"
        );
    }

    /// An unborn current branch is still refused: `symbolic-ref` names it, but there
    /// is nothing to merge INTO, and an in-place merge would quietly adopt `base`'s
    /// history as the branch's first commit.
    #[tokio::test]
    async fn update_branch_from_refuses_an_unborn_current_branch() {
        let (_base, base_dir) = temp_base("update-unborn");
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        run(&repo_s, &["init", "-q"]).await;
        run(&repo_s, &["config", "user.email", "t@t.local"]).await;
        run(&repo_s, &["config", "user.name", "T"]).await;
        run(&repo_s, &["symbolic-ref", "HEAD", "refs/heads/fresh"]).await;
        // A commit for `other` alone, written without moving HEAD off its unborn branch.
        let tree = run(&repo_s, &["write-tree"]).await.trim().to_string();
        let commit = run(&repo_s, &["commit-tree", &tree, "-m", "other"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["update-ref", "refs/heads/other", &commit]).await;

        let state = AppState::default();
        update_branch_from(&state, &repo_s, "fresh", "other", &HashSet::new(), None)
            .await
            .expect_err("an unborn branch has nothing to update");
        let head = run_git_raw(
            Some(&repo_s),
            &["rev-parse", "--verify", "-q", "HEAD"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(head.code, 0, "HEAD is still unborn");
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
            None,
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
            update_branch_from(&state, &repo_s, "level", &main, &HashSet::new(), None)
                .await
                .expect("up-to-date needs no worktree")
                .outcome,
            "up-to-date"
        );
        assert_eq!(
            update_branch_from(&state, &repo_s, "behind", &main, &HashSet::new(), None)
                .await
                .expect("a fast-forward needs no worktree")
                .outcome,
            "fast-forward"
        );
        // Last, since it moves the default branch: `branch == current` merges in place.
        assert_eq!(
            update_branch_from(&state, &repo_s, &main, "feature", &HashSet::new(), None)
                .await
                .expect("an in-place merge needs no worktree")
                .outcome,
            "merge"
        );
    }

    // --- Every update arm reads `branch` and `base` as BRANCHES. A same-named tag on
    // another commit would otherwise win each rev position (gitrevisions checks
    // refs/tags before refs/heads), and `fetch .` resolves its source the same way.

    /// The in-place arm merges the base BRANCH, never a same-named tag behind it.
    #[tokio::test]
    async fn update_in_place_merges_the_base_branch_not_its_tag() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-in-place-base-tag").await;
        run(&repo_s, &["tag", &main, "HEAD~1"]).await;
        run(&repo_s, &["switch", "-q", "feature"]).await;

        let state = AppState::default();
        let outcome = update_branch_from(&state, &repo_s, "feature", &main, &HashSet::new(), None)
            .await
            .expect("the in-place merge succeeds");
        assert_eq!(outcome.outcome, "merge");
        assert!(
            repo.join("base.txt").exists(),
            "the base branch's work is merged in"
        );
    }

    /// The up-to-date probe: a base tag that IS an ancestor of the branch must not
    /// report a branch that lacks the base's work as already up to date.
    #[tokio::test]
    async fn update_up_to_date_probe_reads_the_base_branch_not_its_tag() {
        let (_guard, _repo, repo_s, main) = diverged_repo("update-uptodate-base-tag").await;
        let main_tip = run(&repo_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["branch", "behind", "HEAD~1"]).await;
        run(&repo_s, &["tag", &main, "HEAD~1"]).await;

        let state = AppState::default();
        assert_eq!(
            update_branch_from(&state, &repo_s, "behind", &main, &HashSet::new(), None)
                .await
                .expect("the update succeeds")
                .outcome,
            "fast-forward"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/behind"])
                .await
                .trim(),
            main_tip
        );
    }

    /// The fast-forward probe: a tag named like the BRANCH, off the base's history,
    /// must not turn a plain fast-forward into a merge.
    #[tokio::test]
    async fn update_fast_forward_probe_reads_the_branch_not_its_tag() {
        let (_guard, _repo, repo_s, main) = diverged_repo("update-ff-branch-tag").await;
        let main_tip = run(&repo_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["branch", "behind", "HEAD~1"]).await;
        run(&repo_s, &["tag", "behind", "refs/heads/feature"]).await;

        let state = AppState::default();
        assert_eq!(
            update_branch_from(&state, &repo_s, "behind", &main, &HashSet::new(), None)
                .await
                .expect("the update succeeds")
                .outcome,
            "fast-forward"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/behind"])
                .await
                .trim(),
            main_tip
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/tags/behind"]).await,
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await,
            "the tag is never moved"
        );
    }

    /// The fast-forward MOVE: `fetch .` resolves its source tag-first too, so a base
    /// tag between the branch and the base tip would land the branch on the tag.
    #[tokio::test]
    async fn update_fast_forward_moves_to_the_base_branch_not_its_tag() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-ff-base-tag").await;
        run(&repo_s, &["branch", "behind", "HEAD~1"]).await;
        run(&repo_s, &["tag", &main]).await;
        std::fs::write(repo.join("more.txt"), "more\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "more base work"]).await;
        let main_tip = run(&repo_s, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();

        let state = AppState::default();
        assert_eq!(
            update_branch_from(&state, &repo_s, "behind", &main, &HashSet::new(), None)
                .await
                .expect("the update succeeds")
                .outcome,
            "fast-forward"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/behind"])
                .await
                .trim(),
            main_tip
        );
    }

    /// The diverged arm: the base pin, its re-check and the throwaway merge all read
    /// the base BRANCH. A same-named tag on an unrelated side commit would otherwise be
    /// what lands on the branch.
    // The serializing guard MUST span the awaits — it keeps the process-wide root
    // override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn update_diverged_merge_takes_the_base_branch_not_its_tag() {
        use crate::git::update_marker as marker;
        let (_guard, repo, repo_s, main) = diverged_repo("update-diverged-base-tag").await;
        run(&repo_s, &["switch", "-qc", "side", "HEAD~1"]).await;
        std::fs::write(repo.join("side.txt"), "side\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "side work"]).await;
        run(&repo_s, &["tag", &main]).await;
        run(&repo_s, &["switch", "-q", &main]).await;
        let root = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("worktrees");
        std::fs::create_dir_all(&root).unwrap();
        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        // A name no other test uses: the override root is process-wide.
        run(&repo_s, &["branch", "-m", "feature", "update-base-tag"]).await;

        let state = AppState::default();
        assert_eq!(
            update_branch_from(
                &state,
                &repo_s,
                "update-base-tag",
                &main,
                &HashSet::new(),
                None
            )
            .await
            .expect("the update succeeds")
            .outcome,
            "merge"
        );
        let files = run(
            &repo_s,
            &["ls-tree", "--name-only", "refs/heads/update-base-tag"],
        )
        .await;
        assert!(
            files.contains("base.txt"),
            "the base branch is merged: {files}"
        );
        assert!(
            !files.contains("side.txt"),
            "the tag's commit is not: {files}"
        );
    }

    /// [`diverged_repo`]'s conflicting twin: both branches rewrite the SAME line of the
    /// seed file, so their merge stops with unmerged entries instead of succeeding.
    async fn conflicting_repo(tag: &str) -> (tempfile::TempDir, std::path::PathBuf, String, String) {
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
        std::fs::write(repo.join("seed.txt"), "feature side\n").unwrap();
        run(&repo_s, &["commit", "-qam", "feature edit"]).await;

        run(&repo_s, &["switch", "-q", &main]).await;
        std::fs::write(repo.join("seed.txt"), "main side\n").unwrap();
        run(&repo_s, &["commit", "-qam", "main edit"]).await;

        (guard, repo, repo_s, main)
    }

    /// The diverged path's conflict arm. The merge happens in the throwaway worktree,
    /// so the user's checkout never sees it and the branch ref stays put — the refusal
    /// is the whole outcome, and it has to name the remedy that does apply.
    #[tokio::test]
    async fn a_diverged_update_refuses_a_conflicting_merge_and_leaves_the_branch() {
        let (_guard, repo, repo_s, main) = conflicting_repo("update-conflict").await;
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
            .join("conflict-wt");
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
            None,
        )
        .await
        .unwrap_err();
        let AppError::InvalidArgument(message) = &err else {
            panic!("a conflicting merge must take the conflict refusal: {err:?}");
        };
        assert_eq!(
            message,
            &format!(
                "feature has changes that conflict with {main}. \
                 Switch to feature to merge and resolve them."
            )
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await.trim(),
            feature_tip,
            "the abort leaves the branch exactly where it was"
        );
        let list = run(&repo_s, &["worktree", "list", "--porcelain"]).await;
        assert!(
            !list.contains("conflict-wt"),
            "the throwaway worktree is unregistered: {list}"
        );
        assert!(!tmp.exists(), "and its directory is gone");
    }

    /// The case an exit-code verdict gets wrong: a `pre-merge-commit` hook that
    /// declines exits 1 — the conflict's code — with the auto-merge clean and nothing
    /// unmerged. Hooks resolve from the COMMON dir, so the main repo's hook runs inside
    /// the throwaway worktree. A hook that failed to fire trips the sentinel assertion
    /// below rather than passing as a clean merge.
    #[tokio::test]
    async fn a_declined_merge_hook_is_not_reported_as_a_conflict() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-declined-hook").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let pinned_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        let base_dir = repo.parent().expect("the repo lives under the temp base");
        // The hook stamps a sentinel before declining, so a host `core.hooksPath` that
        // suppressed it fails this test by its real cause rather than as a merge that
        // unexpectedly succeeded. Forward slashes: the script runs under `sh`, where a
        // Windows backslash is an escape character.
        let sentinel = base_dir.join("hook-fired");
        let hook = repo.join(".git").join("hooks").join("pre-merge-commit");
        std::fs::write(
            &hook,
            format!(
                "#!/bin/sh\necho fired > \"{}\"\nexit 1\n",
                sentinel.to_string_lossy().replace('\\', "/")
            ),
        )
        .unwrap();
        // git IGNORES a hook without the executable bit on POSIX, which would let the
        // merge succeed and leave this test asserting nothing.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let tmp = base_dir.join("declined-hook-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        let result = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            &main,
            &UpdatePins {
                branch_tip: feature_tip.clone(),
                base_sha: pinned_base,
            },
            None,
        )
        .await;
        assert!(
            sentinel.exists(),
            "the pre-merge-commit hook never fired — check core.hooksPath"
        );
        let err = result.expect_err("the declined hook stops the merge");
        let AppError::Command(message) = &err else {
            panic!("a clean auto-merge must never be reported as a conflict: {err:?}");
        };
        assert!(
            message.starts_with(&format!("merging {main} into feature failed")),
            "{message}"
        );
        assert!(
            message.contains("Not committing merge"),
            "git's own report rides along: {message}"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await.trim(),
            feature_tip,
            "the abort leaves the branch exactly where it was"
        );
        let list = run(&repo_s, &["worktree", "list", "--porcelain"]).await;
        assert!(
            !list.contains("declined-hook-wt"),
            "the throwaway worktree is unregistered: {list}"
        );
        assert!(!tmp.exists(), "and its directory is gone");
    }

    /// A merge that fails for a reason other than a conflict must not claim one: the
    /// conflict wording names a remedy — switch and resolve — that a hook, a timeout
    /// or unrelated histories give the user no way to act on. Unrelated histories are
    /// the deterministic shape: git refuses before merging anything, so the index has
    /// no unmerged entries and the verdict falls to the report-carrying refusal.
    #[tokio::test]
    async fn a_failed_merge_that_is_not_a_conflict_carries_gits_own_report() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-merge-failure").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();

        // An orphan branch shares no history with `feature`, so git refuses the merge
        // outright rather than conflicting.
        run(&repo_s, &["switch", "-q", "--orphan", "alien"]).await;
        std::fs::write(repo.join("alien.txt"), "alien\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "alien root"]).await;
        let alien_tip = run(&repo_s, &["rev-parse", "refs/heads/alien"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["switch", "-q", &main]).await;

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("merge-failure-wt");
        let tmp_s = tmp.to_string_lossy().into_owned();
        let state = AppState::default();
        let err = merge_diverged_in_worktree(
            &state,
            &repo_s,
            &tmp_s,
            "feature",
            "alien",
            &UpdatePins {
                branch_tip: feature_tip.clone(),
                base_sha: alien_tip,
            },
            None,
        )
        .await
        .unwrap_err();
        let AppError::Command(message) = &err else {
            panic!("a non-conflict failure must not be the conflict refusal: {err:?}");
        };
        assert!(
            message.starts_with("merging alien into feature failed"),
            "{message}"
        );
        assert!(
            message.contains("refusing to merge unrelated histories"),
            "git's own report rides along: {message}"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await.trim(),
            feature_tip,
            "a failed merge leaves the branch exactly where it was"
        );
        assert!(!tmp.exists(), "the throwaway worktree is torn down");
    }

    /// The base's half of the pin, on its refusing side. Merging by NAME is what keeps
    /// git's own merge subject, so the sha the name resolves to has to be checked — a
    /// base whose pinned commit is no longer an ancestor is a different operation than
    /// the one the user asked for, and is refused rather than quietly merged.
    #[tokio::test]
    async fn a_diverged_update_refuses_a_base_rewritten_under_it() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-rewritten-base").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let pinned_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        // `--amend` REPLACES the base tip rather than advancing it, so the pinned
        // commit stops being an ancestor — the only move that invalidates the plan.
        run(&repo_s, &["commit", "-q", "--amend", "-m", "base work, reworded"]).await;
        let moved_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();
        assert_ne!(pinned_base, moved_base, "the fixture must rewrite the base");

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
            None,
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

    /// A base that stops resolving was deleted, not moved: phase 1 resolved the name,
    /// so "try again to see where it stands" would point the user at a retry that
    /// cannot succeed. Paired with the rewritten-base test, which keeps the "moved"
    /// wording, so the two messages discriminate. Driven at the predicate, because a
    /// base deleted mid-window is not a schedulable event.
    #[tokio::test]
    async fn a_diverged_update_reports_a_base_deleted_under_it() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-deleted-base").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let pinned_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        // HEAD has to leave the base branch before git will delete it.
        run(&repo_s, &["switch", "-qc", "spare"]).await;
        run(&repo_s, &["branch", "-D", &main]).await;

        let tmp = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("deleted-base-wt");
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
            None,
        )
        .await
        .unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m)
                if m.starts_with(&format!("{main} was deleted while this update was running"))),
            "{err:?}"
        );
        assert_eq!(
            run(&repo_s, &["rev-parse", "refs/heads/feature"]).await.trim(),
            feature_tip,
            "a refused update leaves the branch exactly where it was"
        );
        let list = run(&repo_s, &["worktree", "list", "--porcelain"]).await;
        assert!(
            !list.contains("deleted-base-wt"),
            "the throwaway worktree is unregistered: {list}"
        );
        assert!(!tmp.exists(), "and its directory is gone");
    }

    /// The base's tolerant side. The app's own auto-fetch advances a remote-tracking
    /// base while the throwaway worktree materializes, and a base that only
    /// fast-forwarded is what a fresh update would merge — refusing it would make
    /// "Update from origin/…" intermittently unusable on an active repo.
    #[tokio::test]
    async fn a_diverged_update_tolerates_a_base_that_fast_forwarded() {
        let (_guard, repo, repo_s, main) = diverged_repo("update-ff-base").await;
        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let pinned_base = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();

        // The base gains a commit after the pin — a fast-forward, the shape a fetch
        // of a moving remote-tracking branch leaves behind.
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
            .join("ff-base-wt");
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
                base_sha: pinned_base,
            },
            None,
        )
        .await
        .expect("a fast-forwarded base still merges");
        assert_eq!(outcome, "merge");

        // Point-of-execution semantics: the NEWER base commit is what landed.
        let merged_tip = run(&repo_s, &["rev-parse", "refs/heads/feature"])
            .await
            .trim()
            .to_string();
        let reachable = run_git_raw(
            Some(&repo_s),
            &["merge-base", "--is-ancestor", &moved_base, &merged_tip],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(
            reachable.code, 0,
            "the commit the base gained after the pin is in the merge: {}",
            reachable.stderr
        );
        assert!(!tmp.exists(), "the throwaway worktree is torn down");
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
            None,
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

    /// The diverged arm end to end, from the public core: the merge lands on `feature`
    /// while `main` stays checked out, and the update leaves nothing behind — no
    /// checkout, no marker pair, no worktree registration. The regression net for the
    /// whole marker path, every step of which resolves its root asynchronously.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // root override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_diverged_update_leaves_no_trace_in_the_marker_root() {
        use crate::git::update_marker as marker;
        let (_guard, repo, repo_s, main) = diverged_repo("update-e2e").await;
        let root = repo
            .parent()
            .expect("the repo lives under the temp base")
            .join("worktrees");
        std::fs::create_dir_all(&root).unwrap();

        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        // A branch name no other test uses: the override root is process-wide, and this
        // test holds a LIVE marker for the length of a real merge, which would refuse a
        // parallel test's guard on a shared name.
        run(&repo_s, &["branch", "-m", "feature", "update-e2e"]).await;

        let feature_tip = run(&repo_s, &["rev-parse", "refs/heads/update-e2e"])
            .await
            .trim()
            .to_string();
        let base_tip = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();
        assert_eq!(
            run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
                .await
                .trim(),
            main,
            "the fixture must update a branch that is NOT the current one"
        );

        let state = AppState::default();
        let outcome =
            update_branch_from(&state, &repo_s, "update-e2e", &main, &HashSet::new(), None)
                .await
                .expect("a diverged update merges");
        assert_eq!(outcome.outcome, "merge");

        // A merge commit carrying exactly the two tips the update pinned.
        let merged = run(
            &repo_s,
            &["rev-list", "--parents", "-n", "1", "refs/heads/update-e2e"],
        )
        .await;
        let parents: Vec<&str> = merged.split_whitespace().skip(1).collect();
        assert_eq!(
            parents,
            vec![feature_tip.as_str(), base_tip.as_str()],
            "the updated branch merges its old tip and base, in that order: {merged}"
        );

        let leftovers: Vec<String> = std::fs::read_dir(&root)
            .expect("the marker root is readable")
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|name| name.starts_with("gd-update-"))
            .collect();
        assert!(
            leftovers.is_empty(),
            "no checkout and no marker pair survive the update: {leftovers:?}"
        );
        assert!(
            !run(&repo_s, &["worktree", "list", "--porcelain"])
                .await
                .contains("gd-update-"),
            "and git holds no registration for it either"
        );
    }

    // --- The holder arm: a branch checked out in ANOTHER checkout is updated inside it.
    // Each test names its branch uniquely, since the marker guards read a process-wide
    // root a concurrently running sibling may have overridden.

    /// A repo whose `branch` is checked out in a LINKED worktree beside it. Returns the
    /// temp guard, the repo path, the default branch, the holder's path, and the holder
    /// as `worktree list --porcelain` spells it.
    async fn held_branch_repo(
        tag: &str,
        branch: &str,
    ) -> (tempfile::TempDir, String, String, String, String) {
        let (guard, base_dir) = temp_base(tag);
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "seed.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        let holder_s = base_dir.join("holder").to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "-q", "-b", branch, &holder_s]).await;
        let porcelain = worktree_holding_branch(&repo_s, branch)
            .await
            .expect("the linked worktree holds the branch");
        (guard, repo_s, main, holder_s, porcelain)
    }

    async fn commit_file(dir: &str, file: &str, body: &str) {
        std::fs::write(std::path::Path::new(dir).join(file), body).unwrap();
        run(dir, &["add", "-A"]).await;
        run(dir, &["commit", "-qm", file]).await;
    }

    async fn tip(repo: &str, branch: &str) -> String {
        branch_tip_sha(repo, branch)
            .await
            .expect("the tip read runs")
            .expect("the branch exists")
    }

    /// Asserts a holder-arm refusal's structured fields, and that its message closes on
    /// the sentence every one of them ends with; returns the message.
    fn expect_branch_held(err: &AppError, reason: &str, holder: &str, branch: &str) -> String {
        let AppError::BranchHeld {
            message,
            holder: named,
            branch: held,
            reason: why,
        } = err
        else {
            panic!("expected a BranchHeld refusal, got {err:?}");
        };
        assert_eq!(
            (why.as_str(), named.as_str(), held.as_str()),
            (reason, holder, branch)
        );
        assert!(
            message.ends_with(&format!("{branch} is unchanged.")),
            "{message}"
        );
        message.clone()
    }

    /// The fast-forward a held branch used to die on (`fetch .` refuses it) runs inside
    /// the holder, and the holder's index and tree advance with its HEAD.
    #[tokio::test]
    async fn a_held_branch_fast_forwards_inside_its_holder() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-ff", "held-ff").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let main_tip = tip(&repo_s, &main).await;

        let state = AppState::default();
        let outcome = update_branch_from(&state, &repo_s, "held-ff", &main, &HashSet::new(), None)
            .await
            .expect("a held fast-forward succeeds");
        assert_eq!(outcome.outcome, "fast-forward");
        assert_eq!(outcome.holder.as_deref(), Some(porcelain.as_str()));

        assert_eq!(run(&holder, &["rev-parse", "HEAD"]).await.trim(), main_tip);
        assert_eq!(
            run(&holder, &["status", "--porcelain"]).await,
            "",
            "the holder's index and tree advanced with its HEAD"
        );
        assert!(std::path::Path::new(&holder).join("base.txt").exists());
        assert_eq!(
            current_branch_name(&repo_s).await.unwrap(),
            Some(main.clone()),
            "the active checkout stays where it was"
        );
        assert_eq!(tip(&repo_s, &main).await, main_tip);
        assert_eq!(run(&repo_s, &["status", "--porcelain"]).await, "");
    }

    /// A diverged held branch merges inside a clean, idle holder, titled as the unheld
    /// arms title theirs rather than by the pinned sha.
    #[tokio::test]
    async fn a_held_diverged_branch_merges_inside_a_clean_holder() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-merge", "held-merge").await;
        commit_file(&holder, "feature.txt", "feature\n").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let (held_tip, main_tip) = (tip(&repo_s, "held-merge").await, tip(&repo_s, &main).await);

        let state = AppState::default();
        let outcome =
            update_branch_from(&state, &repo_s, "held-merge", &main, &HashSet::new(), None)
                .await
                .expect("a held diverged update merges");
        assert_eq!(outcome.outcome, "merge");
        assert_eq!(outcome.holder.as_deref(), Some(porcelain.as_str()));

        let merged = run(
            &repo_s,
            &["rev-list", "--parents", "-n", "1", "refs/heads/held-merge"],
        )
        .await;
        let parents: Vec<&str> = merged.split_whitespace().skip(1).collect();
        assert_eq!(parents, vec![held_tip.as_str(), main_tip.as_str()]);
        assert_eq!(
            run(
                &repo_s,
                &["log", "-1", "--format=%s", "refs/heads/held-merge"]
            )
            .await
            .trim(),
            format!("Merge branch '{main}' into held-merge")
        );
        assert_eq!(run(&holder, &["status", "--porcelain"]).await, "");
        assert!(std::path::Path::new(&holder).join("base.txt").exists());
    }

    /// An agent session's worktree is never updated from outside it, matched on the
    /// path exactly as the porcelain spells it.
    #[tokio::test]
    async fn a_branch_held_by_a_session_worktree_is_refused() {
        let (_guard, repo_s, main, _holder, porcelain) =
            held_branch_repo("held-session", "held-session").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let held_tip = tip(&repo_s, "held-session").await;

        let state = AppState::default();
        let sessions = HashSet::from([porcelain.clone()]);
        let err = update_branch_from(&state, &repo_s, "held-session", &main, &sessions, None)
            .await
            .unwrap_err();
        expect_branch_held(&err, "session", &porcelain, "held-session");
        assert_eq!(tip(&repo_s, "held-session").await, held_tip);
    }

    /// The app-data root backstops an app-internal checkout the registry doesn't list (a
    /// lost session entry, a pre-marker hidden update): a holder under it is refused as
    /// a session's, with the registry empty and the branch not `gd/session/*`.
    #[tokio::test]
    async fn a_branch_held_under_the_app_data_root_is_refused() {
        let (_guard, repo_s, main, _holder, porcelain) =
            held_branch_repo("held-app-data", "held-app-data").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let held_tip = tip(&repo_s, "held-app-data").await;
        // The holder's parent in the porcelain's own spelling stands in for the root.
        let parent = std::path::Path::new(&porcelain).parent().unwrap();
        let root = crate::git::worktree::normalize_wt_path(&parent.to_string_lossy());

        let state = AppState::default();
        let err = update_branch_from(
            &state,
            &repo_s,
            "held-app-data",
            &main,
            &HashSet::new(),
            Some(&root),
        )
        .await
        .unwrap_err();
        expect_branch_held(&err, "session", &porcelain, "held-app-data");
        assert_eq!(tip(&repo_s, "held-app-data").await, held_tip);
    }

    /// Each arm of the session match, and the separator that keeps a SIBLING of the
    /// app-data root from passing as inside it.
    #[test]
    fn session_holder_matches_each_arm_but_not_a_root_sibling() {
        let none = HashSet::new();
        let registry = HashSet::from(["C:/S/One".to_string()]);
        let root = Some("c:/app/wts");
        assert!(is_session_holder(r"c:\s\one", "topic", &registry, None));
        assert!(is_session_holder("C:/x", "gd/session/x", &none, None));
        assert!(is_session_holder("C:/App/wts/h/wt", "topic", &none, root));
        assert!(!is_session_holder("C:/App/wtsx/wt", "topic", &none, root));
        assert!(!is_session_holder("C:/x", "topic", &none, root));
    }

    /// A branch that took in the base between the first read and the holder's lock says
    /// "up-to-date", not git's no-op dressed as an update. Driven through the holder arm
    /// directly, since the outer read would already answer it.
    #[tokio::test]
    async fn a_holder_already_containing_the_base_reports_up_to_date() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-current", "held-current").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let base_sha = tip(&repo_s, &main).await;
        run(&holder, &["merge", "-q", "--ff-only", &base_sha]).await;
        commit_file(&holder, "more.txt", "more\n").await;
        let held_tip = tip(&repo_s, "held-current").await;

        let state = AppState::default();
        for merge in [
            HolderMerge::FastForward,
            HolderMerge::Merge { subject: None },
        ] {
            let outcome =
                update_in_holder(&state, &porcelain, "held-current", &main, &base_sha, merge)
                    .await
                    .expect("a holder already containing the base is not an error");
            assert_eq!(outcome.outcome, "up-to-date");
            assert_eq!(outcome.holder.as_deref(), Some(porcelain.as_str()));
        }
        assert_eq!(tip(&repo_s, "held-current").await, held_tip);
    }

    /// A holder paused mid-merge is refused by name and left paused.
    #[tokio::test]
    async fn a_holder_mid_operation_is_refused() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-midop", "held-midop").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        run(&holder, &["merge", "--no-commit", "--no-ff", &main]).await;
        let held_tip = tip(&repo_s, "held-midop").await;

        let state = AppState::default();
        let err = update_branch_from(&state, &repo_s, "held-midop", &main, &HashSet::new(), None)
            .await
            .unwrap_err();
        let message = expect_branch_held(&err, "mid-op", &porcelain, "held-midop");
        assert!(message.contains("in the middle of a merge"), "{message}");
        assert_eq!(tip(&repo_s, "held-midop").await, held_tip);
        assert!(crate::git::ops::op_state(&holder).await.unwrap().merging);
    }

    /// Tracked changes in the holder refuse the update and survive it untouched.
    #[tokio::test]
    async fn a_holder_with_tracked_changes_is_refused() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-dirty", "held-dirty").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let seed = std::path::Path::new(&holder).join("seed.txt");
        std::fs::write(&seed, "work in progress\n").unwrap();
        let held_tip = tip(&repo_s, "held-dirty").await;

        let state = AppState::default();
        let err = update_branch_from(&state, &repo_s, "held-dirty", &main, &HashSet::new(), None)
            .await
            .unwrap_err();
        expect_branch_held(&err, "dirty", &porcelain, "held-dirty");
        assert_eq!(tip(&repo_s, "held-dirty").await, held_tip);
        assert_eq!(
            std::fs::read_to_string(&seed).unwrap(),
            "work in progress\n"
        );
    }

    /// Untracked files alone don't make the holder dirty: the update proceeds and
    /// leaves them where they were.
    #[tokio::test]
    async fn a_holder_with_only_untracked_files_still_updates() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-untracked", "held-untracked").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let scratch = std::path::Path::new(&holder).join("scratch.txt");
        std::fs::write(&scratch, "notes\n").unwrap();

        let state = AppState::default();
        let outcome = update_branch_from(
            &state,
            &repo_s,
            "held-untracked",
            &main,
            &HashSet::new(),
            None,
        )
        .await
        .expect("untracked files don't block the update");
        assert_eq!(outcome.outcome, "fast-forward");
        assert_eq!(outcome.holder.as_deref(), Some(porcelain.as_str()));
        assert_eq!(
            tip(&repo_s, "held-untracked").await,
            tip(&repo_s, &main).await
        );
        assert!(scratch.exists());
    }

    /// An IGNORED file in the holder at a path the base tracks is refused rather than
    /// silently overwritten (git's default), and survives byte for byte.
    #[tokio::test]
    async fn a_holder_ignored_file_the_base_tracks_is_never_overwritten() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-ignored", "held-ignored").await;
        let holder_dir = std::path::Path::new(&holder);
        std::fs::write(holder_dir.join(".gitignore"), "build.log\n").unwrap();
        let ignored = holder_dir.join("build.log");
        std::fs::write(&ignored, "local build output\n").unwrap();
        commit_file(&repo_s, "build.log", "tracked by the base\n").await;
        let held_tip = tip(&repo_s, "held-ignored").await;

        let state = AppState::default();
        let err = update_branch_from(
            &state,
            &repo_s,
            "held-ignored",
            &main,
            &HashSet::new(),
            None,
        )
        .await
        .unwrap_err();
        let AppError::BranchHeld {
            message,
            holder: named,
            reason,
            ..
        } = &err
        else {
            panic!("expected a BranchHeld refusal, got {err:?}");
        };
        assert_eq!(
            (reason.as_str(), named.as_str()),
            ("failed", porcelain.as_str())
        );
        assert!(message.contains("held-ignored is unchanged."), "{message}");
        assert!(
            message.contains("build.log"),
            "git's refusal names the file: {message}"
        );
        assert_eq!(
            std::fs::read_to_string(&ignored).unwrap(),
            "local build output\n"
        );
        assert_eq!(tip(&repo_s, "held-ignored").await, held_tip);
        assert!(!crate::git::ops::op_state(&holder).await.unwrap().merging);
    }

    /// A conflicting merge inside the holder is aborted: no MERGE_HEAD, a clean tree, the
    /// branch where it stood, and the conflicting file named.
    #[tokio::test]
    async fn a_conflicting_held_merge_is_aborted_and_refused() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-conflict", "held-conflict").await;
        commit_file(&holder, "seed.txt", "holder side\n").await;
        commit_file(&repo_s, "seed.txt", "main side\n").await;
        let held_tip = tip(&repo_s, "held-conflict").await;

        let state = AppState::default();
        let err = update_branch_from(
            &state,
            &repo_s,
            "held-conflict",
            &main,
            &HashSet::new(),
            None,
        )
        .await
        .unwrap_err();
        let message = expect_branch_held(&err, "conflict", &porcelain, "held-conflict");
        assert!(message.contains("seed.txt"), "{message}");
        assert!(message.contains(&porcelain), "{message}");
        assert!(!crate::git::ops::op_state(&holder).await.unwrap().merging);
        assert_eq!(run(&holder, &["status", "--porcelain"]).await, "");
        assert_eq!(tip(&repo_s, "held-conflict").await, held_tip);
    }

    /// A holder that switched away between the lookup and its lock is refused; driven
    /// through the holder arm directly, since a fresh lookup would no longer find it.
    #[tokio::test]
    async fn a_holder_that_switched_branches_is_refused() {
        let (_guard, repo_s, main, holder, porcelain) =
            held_branch_repo("held-moved", "held-moved").await;
        commit_file(&repo_s, "base.txt", "base\n").await;
        let (held_tip, base_sha) = (tip(&repo_s, "held-moved").await, tip(&repo_s, &main).await);
        run(&holder, &["switch", "-qc", "elsewhere"]).await;

        let state = AppState::default();
        let err = update_in_holder(
            &state,
            &porcelain,
            "held-moved",
            &main,
            &base_sha,
            HolderMerge::FastForward,
        )
        .await
        .unwrap_err();
        expect_branch_held(&err, "moved", &porcelain, "held-moved");
        assert_eq!(tip(&repo_s, "held-moved").await, held_tip);
        assert_eq!(
            run(&holder, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/elsewhere"
        );
    }

    #[test]
    fn name_conflicts_names_three_then_counts_the_rest() {
        let paths = |n: usize| (1..=n).map(|i| format!("f{i}")).collect::<Vec<_>>();
        assert_eq!(name_conflicts(&paths(1)), "f1");
        assert_eq!(name_conflicts(&paths(3)), "f1, f2, f3");
        assert_eq!(name_conflicts(&paths(5)), "f1, f2, f3 and 2 more");
    }

    /// The update UI reads both keys; `holder` must serialize as an explicit null on
    /// every arm that ran in no other checkout.
    #[test]
    fn update_outcome_serializes_to_the_pinned_wire_shape() {
        let held = UpdateBranchOutcome {
            outcome: "fast-forward".to_string(),
            holder: Some("C:/path/to/wt".to_string()),
        };
        assert_eq!(
            serde_json::to_string(&held).unwrap(),
            r#"{"outcome":"fast-forward","holder":"C:/path/to/wt"}"#
        );
        assert_eq!(
            serde_json::to_string(&UpdateBranchOutcome::unheld("merge")).unwrap(),
            r#"{"outcome":"merge","holder":null}"#
        );
    }

    /// A repo with `feature` tracking the default branch through the local `.` remote,
    /// so `feature@{upstream}` resolves without a network or a second repo. Returns the
    /// temp guard, the repo path, and the upstream tip.
    async fn repo_with_local_upstream(tag: &str) -> (tempfile::TempDir, String, String) {
        let (guard, base_dir) = temp_base(tag);
        let repo = base_dir.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .trim()
            .to_string();
        run(&repo_s, &["branch", "feature"]).await;
        // One call sets both `branch.feature.remote` (`.`) and `.merge`, which keeps
        // any `refs/heads/<name>` template out of this fixture entirely.
        run(&repo_s, &["branch", "--set-upstream-to", &main, "feature"]).await;
        let tip = run(&repo_s, &["rev-parse", &format!("{main}^{{commit}}")])
            .await
            .trim()
            .to_string();
        (guard, repo_s, tip)
    }

    /// The PRE-ADD window: an update has minted its marker but its `worktree add` has
    /// not registered anything yet, so `worktree list` is empty. Both porcelain-only
    /// sites must still refuse — without this guard a delete succeeds here and the
    /// update dies moments later on a missing ref.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // root override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_live_marker_refuses_delete_and_reset_before_the_checkout_exists() {
        use crate::git::update_marker as marker;
        let (_guard, repo_s, tip) = repo_with_local_upstream("premint-guard").await;
        let root = std::path::Path::new(&repo_s)
            .parent()
            .unwrap()
            .join("worktrees");
        std::fs::create_dir_all(&root).unwrap();

        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        // A branch name no other test uses: the override root is process-wide, and the
        // LIVE marker below would refuse a parallel test's guard on a shared name.
        let branch = "feature-live-refusal";
        run(&repo_s, &["branch", "-m", "feature", branch]).await;
        // Minted, not yet added: nothing is in the worktree registry.
        let _live = marker::UpdateMarker::create_for(&root.join("gd-update-live"), branch)
            .expect("the marker mints");

        let state = AppState::default();
        let expected = marker::branch_update_refusal(branch).to_string();
        let deleted = git_delete_branch_core(&state, repo_s.clone(), branch.into())
            .await
            .expect_err("a delete during the pre-add window is refused");
        assert_eq!(deleted.to_string(), expected);
        let reset = branch_reset_to_upstream(&state, &repo_s, branch, &tip)
            .await
            .expect_err("a reset during the pre-add window is refused");
        assert_eq!(reset.to_string(), expected);
        assert!(
            !run(&repo_s, &["branch", "--list", branch])
                .await
                .trim()
                .is_empty(),
            "and the branch is still there"
        );
    }

    /// The post-add half, both outcomes. A RELEASED marker over a registered checkout is
    /// claimed age-free and the delete then succeeds; a MARKERLESS one (a pre-marker
    /// build's checkout, which may still be running) is left alone and takes the
    /// pre-existing generic message naming the holding worktree.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // root override installed for the whole body.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_registered_holder_is_claimed_when_released_and_left_when_markerless() {
        use crate::git::update_marker as marker;
        let (_guard, repo_s, _tip) = repo_with_local_upstream("registered-holder").await;
        let root = std::path::Path::new(&repo_s)
            .parent()
            .unwrap()
            .join("worktrees");
        std::fs::create_dir_all(&root).unwrap();

        let _serialized = marker::test_root_lock();
        let _override = marker::TestRootOverride::set(&root);
        // A branch name no other test uses, as in the pre-add guard test: the override
        // root is process-wide, so a shared name lets a parallel test's marker decide
        // this one's verdict.
        let branch = "feature-registered-holder";
        run(&repo_s, &["branch", "-m", "feature", branch]).await;
        let state = AppState::default();

        // MARKERLESS: registered, no sidecars — the generic message, unchanged.
        let bare = root.join("gd-update-premarker");
        let bare_s = bare.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "--quiet", &bare_s, branch]).await;
        let err = git_delete_branch_core(&state, repo_s.clone(), branch.into())
            .await
            .expect_err("a markerless holder still blocks the delete");
        assert!(
            err.to_string()
                .starts_with(&format!("{branch} is checked out in the worktree at"))
                && err.to_string().ends_with(&format!(
                    "(or switch it to another branch) before deleting {branch}."
                )),
            "the pre-marker path keeps its original wording: {err}"
        );
        assert!(bare.exists(), "and its checkout is untouched");
        run(&repo_s, &["worktree", "remove", "--force", &bare_s]).await;

        // RELEASED: registered, sidecars present, lock free — claimed with no age gate.
        // The pair is WRITTEN, not minted-and-dropped: a crashed update's lock is
        // released by the OS, and on Linux `drop` cannot be relied on to release one in
        // a process-spawning test binary (see `write_released_marker`).
        let dead = root.join("gd-update-crashed");
        let dead_s = dead.to_string_lossy().into_owned();
        run(&repo_s, &["worktree", "add", "--quiet", &dead_s, branch]).await;
        marker::write_released_marker(&root, "gd-update-crashed", branch);

        git_delete_branch_core(&state, repo_s.clone(), branch.into())
            .await
            .expect("a released holder is cleared and the delete proceeds");
        assert!(!dead.exists(), "the orphaned checkout was removed");
        assert!(
            run(&repo_s, &["branch", "--list", branch])
                .await
                .trim()
                .is_empty(),
            "and the branch it was holding is gone"
        );
    }

    async fn archived_flag(repo: &str, branch: &str) -> Option<String> {
        let key = format!("branch.{branch}.gitdesktopArchived");
        let out = run_git_raw(Some(repo), &["config", "--get", &key], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        (out.code == 0).then(|| out.stdout_lossy().trim().to_string())
    }

    /// A config lock another writer releases within the retry delay is ridden out on
    /// the real path. Whether the first attempt lands inside the hold depends on spawn
    /// timing; the scripted retry-policy test in `runner` is what pins the policy.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_briefly_held_config_lock_is_ridden_out() {
        let (_base, base) = temp_base("archive-transient-lock");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "feature"]).await;

        let lock = repo.join(".git").join("config.lock");
        std::fs::write(&lock, b"").unwrap();
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            std::fs::remove_file(&lock).unwrap();
        });
        set_branch_archived_core(&repo_s, "feature", true)
            .await
            .expect("the retry lands after the other writer lets go");
        release.await.unwrap();
        assert_eq!(
            archived_flag(&repo_s, "feature").await.as_deref(),
            Some("true")
        );
    }

    /// A config lock held through the retry surfaces the user-register refusal, never
    /// git's lock-file error; released, the same call succeeds, and an unarchive of an
    /// unset flag stays a success.
    #[tokio::test]
    async fn a_held_config_lock_reads_as_try_again_not_a_raw_git_error() {
        let (_base, base) = temp_base("archive-config-lock");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "feature"]).await;

        let lock = repo.join(".git").join("config.lock");
        std::fs::write(&lock, b"").unwrap();
        for archived in [true, false] {
            let err = set_branch_archived_core(&repo_s, "feature", archived)
                .await
                .expect_err("a lock held through the retry refuses");
            assert_eq!(
                err.to_string(),
                archive_config_busy("feature", archived).to_string()
            );
            assert!(!err.to_string().contains("config.lock"), "{err}");
        }

        std::fs::remove_file(&lock).unwrap();
        set_branch_archived_core(&repo_s, "feature", true)
            .await
            .expect("the lock released, the archive lands");
        assert_eq!(
            archived_flag(&repo_s, "feature").await.as_deref(),
            Some("true")
        );
        for _ in 0..2 {
            set_branch_archived_core(&repo_s, "feature", false)
                .await
                .expect("unarchiving, twice, succeeds");
        }
        assert_eq!(archived_flag(&repo_s, "feature").await, None);
    }

    /// A flag that somehow carries two values (a hand edit, another tool) is fully
    /// cleared: plain `--unset` exits 5 on it, the same code as "not set", and removes
    /// nothing.
    #[tokio::test]
    async fn unarchiving_clears_a_multi_valued_flag() {
        let (_base, base) = temp_base("archive-multi-value");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "feature"]).await;
        for _ in 0..2 {
            run(
                &repo_s,
                &[
                    "config",
                    "--add",
                    "branch.feature.gitdesktopArchived",
                    "true",
                ],
            )
            .await;
        }
        assert!(git_branches(repo_s.clone())
            .await
            .unwrap()
            .iter()
            .any(|b| b.name == "feature" && b.archived));

        set_branch_archived_core(&repo_s, "feature", false)
            .await
            .expect("unarchiving a multi-valued flag succeeds");
        assert!(git_branches(repo_s.clone())
            .await
            .unwrap()
            .iter()
            .any(|b| b.name == "feature" && !b.archived));
    }

    /// A repo whose `branch` carries BOTH an upstream and the archived flag, so a stale
    /// `branch.<name>` section has something to show, plus a remote-tracking ref
    /// `origin/<tracked>` (synthesized, never fetched) at a commit whose tree DIFFERS
    /// from HEAD's, so a test can tell a moved working tree from an untouched one.
    async fn repo_with_branch_settings(
        tag: &str,
        branch: &str,
        tracked: &str,
    ) -> (tempfile::TempDir, std::path::PathBuf, String) {
        let (guard, base) = temp_base(tag);
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
        run(&repo_s, &["branch", branch]).await;
        run(
            &repo_s,
            &["branch", "--set-upstream-to", main.trim(), branch],
        )
        .await;
        let flag = format!("branch.{branch}.gitdesktopArchived");
        run(&repo_s, &["config", &flag, "true"]).await;
        let nowhere = base.join("nowhere.git").to_string_lossy().into_owned();
        run(&repo_s, &["remote", "add", "origin", &nowhere]).await;
        run(&repo_s, &["switch", "-q", "-c", "remote-side"]).await;
        std::fs::write(repo.join("a.txt"), "remote\n").unwrap();
        std::fs::write(repo.join("remote.txt"), "remote\n").unwrap();
        run(&repo_s, &["add", "-A"]).await;
        run(&repo_s, &["commit", "-qm", "remote side"]).await;
        let tracking = format!("refs/remotes/origin/{tracked}");
        run(&repo_s, &["update-ref", &tracking, "HEAD"]).await;
        run(&repo_s, &["switch", "-q", main.trim()]).await;
        run(&repo_s, &["branch", "-q", "-D", "remote-side"]).await;
        (guard, repo, repo_s)
    }

    /// `git status --porcelain`, so a test can tell staged leftovers from a clean switch.
    async fn porcelain(repo: &str) -> String {
        run(repo, &["status", "--porcelain"]).await
    }

    /// `a.txt` as the working tree holds it, line endings aside.
    fn seed_file(repo: &std::path::Path) -> String {
        std::fs::read_to_string(repo.join("a.txt"))
            .unwrap()
            .trim()
            .to_string()
    }

    /// Every `branch.<name>.*` entry, empty when the section is gone.
    async fn branch_section(repo: &str, branch: &str) -> String {
        let pattern = format!(r"^branch\.{branch}\.");
        run_git_raw(
            Some(repo),
            &["config", "--get-regexp", &pattern],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .stdout_lossy()
    }

    async fn branch_exists(repo: &str, name: &str) -> bool {
        !run(repo, &["branch", "--list", name])
            .await
            .trim()
            .is_empty()
    }

    /// The premise every repair below rests on (git 2.51.1): each command finishes
    /// its ref change BEFORE losing `.git/config.lock`, so re-running it is never the
    /// fix. `branch -D` even exits 0. A git that changes any shape fails here first.
    #[tokio::test]
    async fn git_lands_the_ref_change_before_losing_the_config_lock() {
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-shapes", "shape", "shape-remote").await;
        run(&repo_s, &["branch", "shape-gone"]).await;
        run(
            &repo_s,
            &["config", "branch.shape-gone.gitdesktopArchived", "true"],
        )
        .await;
        let lock = hold_config_lock(&repo);
        let raw = |args: &'static [&'static str]| {
            let repo_s = repo_s.clone();
            async move {
                run_git_raw(Some(&repo_s), args, DEFAULT_TIMEOUT)
                    .await
                    .unwrap()
            }
        };

        let deleted = raw(&["branch", "-D", "--", "shape-gone"]).await;
        assert_eq!(deleted.code, 0, "{}", deleted.stderr);
        assert!(
            is_config_lock_contention(&deleted.stderr),
            "{}",
            deleted.stderr
        );
        assert!(!branch_exists(&repo_s, "shape-gone").await);
        assert!(!branch_section(&repo_s, "shape-gone").await.is_empty());

        let renamed = raw(&["branch", "-m", "--", "shape", "shape-moved"]).await;
        assert_eq!(renamed.code, 128);
        assert!(
            renamed.stderr.contains(RENAMED_CONFIG_LEFT_BEHIND),
            "{}",
            renamed.stderr
        );
        assert!(branch_exists(&repo_s, "shape-moved").await);
        assert!(!branch_section(&repo_s, "shape").await.is_empty());

        // Both switch forms: the branch is created AND the index and working tree move
        // to its tip, but HEAD stays put, so the move reads as staged changes on the
        // old branch. A plain `branch` from the same start point leaves the tree alone.
        let head = run(&repo_s, &["symbolic-ref", "HEAD"]).await;
        let cases: [(&'static [&'static str], &str); 3] = [
            (
                &["switch", "--track", "origin/shape-remote"],
                "shape-remote",
            ),
            (
                &["switch", "-c", "shape-create", "origin/shape-remote"],
                "shape-create",
            ),
            (
                &["branch", "shape-plain", "origin/shape-remote"],
                "shape-plain",
            ),
        ];
        for (args, created) in cases {
            let out = raw(args).await;
            assert_eq!(out.code, 1, "{args:?}: {}", out.stderr);
            assert!(out.stderr.contains(UPSTREAM_WRITE_FAILED), "{}", out.stderr);
            assert!(branch_exists(&repo_s, created).await, "{args:?} created");
            assert_eq!(
                run(&repo_s, &["symbolic-ref", "HEAD"]).await,
                head,
                "{args:?}"
            );
            if args[0] == "switch" {
                assert_eq!(seed_file(&repo), "remote", "{args:?} moved the tree");
                let staged = porcelain(&repo_s).await;
                assert!(
                    staged.contains("M  a.txt") && staged.contains("A  remote.txt"),
                    "{args:?} left the move staged on the old branch: {staged}"
                );
                run(&repo_s, &["reset", "-q", "--hard"]).await;
            } else {
                assert_eq!(seed_file(&repo), "hello", "{args:?} left the tree alone");
                assert_eq!(porcelain(&repo_s).await, "", "{args:?}");
            }
        }
        std::fs::remove_file(&lock).unwrap();
    }

    /// The exit-0 loss is repaired: the ref AND its `branch.<name>` section are gone,
    /// with the repair's one retry riding out a lock still held on its first attempt.
    #[tokio::test]
    async fn a_delete_that_loses_the_config_lock_still_drops_the_branch_settings() {
        let branch = "cfg-lock-delete";
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-delete", branch, "unused").await;
        assert!(!branch_section(&repo_s, branch).await.is_empty());
        let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&repo), 2);

        let state = AppState::default();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_delete_branch_core(&state, repo_s.clone(), branch.into()),
            )
            .await
            .expect("the delete succeeds");
        assert!(!branch_exists(&repo_s, branch).await);
        assert_eq!(
            branch_section(&repo_s, branch).await,
            "",
            "no stale section"
        );
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// A rename that loses the config lock still carries the branch's settings to the
    /// new name, through the repair's retry.
    #[tokio::test]
    async fn a_rename_that_loses_the_config_lock_still_moves_the_branch_settings() {
        let (old, new) = ("cfg-lock-rename", "cfg-lock-renamed");
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-rename", old, "unused").await;
        let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&repo), 2);

        let state = AppState::default();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_rename_branch_core(&state, repo_s.clone(), old.into(), new.into()),
            )
            .await
            .expect("the rename succeeds");
        assert!(branch_exists(&repo_s, new).await);
        assert_eq!(
            branch_section(&repo_s, old).await,
            "",
            "nothing left behind"
        );
        let moved = branch_section(&repo_s, new).await;
        assert!(moved.contains("gitdesktoparchived true"), "{moved}");
        assert!(moved.contains(".merge "), "the upstream moved too: {moved}");
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// A lock held through the repair's retry surfaces git's own half-done error, so a
    /// rename whose settings stayed behind is never reported as a success.
    #[tokio::test]
    async fn a_rename_whose_repair_also_loses_keeps_gits_error() {
        let (old, new) = ("cfg-lock-rename-held", "cfg-lock-rename-held2");
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-rename-held", old, "unused").await;
        let lock = hold_config_lock(&repo);

        let state = AppState::default();
        let err = git_rename_branch_core(&state, repo_s.clone(), old.into(), new.into())
            .await
            .expect_err("a second lost race surfaces");
        let AppError::Git { code, stderr } = &err else {
            panic!("expected git's error, got {err:?}")
        };
        assert_eq!(*code, 128);
        assert!(stderr.contains(RENAMED_CONFIG_LEFT_BEHIND), "{stderr}");
        std::fs::remove_file(&lock).unwrap();
    }

    /// A tracking switch that loses the config lock ends where an uncontended one
    /// does: on the new branch, tracking the remote one.
    #[tokio::test]
    async fn a_tracking_switch_that_loses_the_config_lock_still_tracks_and_switches() {
        let remote_branch = "cfg-lock-track";
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-track", "unrelated", remote_branch).await;
        let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&repo), 2);

        let state = AppState::default();
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(
                hook,
                git_checkout_remote_branch_core(
                    &state,
                    repo_s.clone(),
                    "origin".into(),
                    remote_branch.into(),
                ),
            )
            .await
            .expect("the switch succeeds");
        assert_cleanly_on(&repo, &repo_s, remote_branch).await;
        assert_eq!(
            upstream_of(&repo_s, remote_branch).await.as_deref(),
            Some(format!("origin/{remote_branch}").as_str())
        );
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    /// HEAD on `branch` with the working tree at its tip and nothing staged — where an
    /// uncontended switch ends, and never the moved-tree-under-old-HEAD half state.
    async fn assert_cleanly_on(repo: &std::path::Path, repo_s: &str, branch: &str) {
        assert_eq!(
            run(repo_s, &["symbolic-ref", "--short", "HEAD"])
                .await
                .trim(),
            branch
        );
        assert_eq!(seed_file(repo), "remote");
        assert_eq!(porcelain(repo_s).await, "", "nothing left staged");
    }

    async fn upstream_of(repo: &str, branch: &str) -> Option<String> {
        let spec = format!("{branch}@{{upstream}}");
        run_git(
            Some(repo),
            &["rev-parse", "--abbrev-ref", &spec],
            DEFAULT_TIMEOUT,
        )
        .await
        .ok()
        .map(|out| out.stdout_lossy().trim().to_string())
    }

    /// The switch leg runs even when the upstream repair loses again: the branch is
    /// checked out cleanly and git's upstream error is what the caller hears.
    #[tokio::test]
    async fn a_tracking_switch_whose_upstream_repair_also_loses_still_switches() {
        let remote_branch = "cfg-lock-track-held";
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-track-held", "unrelated", remote_branch).await;
        let lock = hold_config_lock(&repo);

        let state = AppState::default();
        let err = git_checkout_remote_branch_core(
            &state,
            repo_s.clone(),
            "origin".into(),
            remote_branch.into(),
        )
        .await
        .expect_err("the lost upstream is reported");
        let AppError::Git { stderr, .. } = &err else {
            panic!("expected git's error, got {err:?}")
        };
        assert!(stderr.contains(UPSTREAM_WRITE_FAILED), "{stderr}");
        std::fs::remove_file(&lock).unwrap();
        assert_cleanly_on(&repo, &repo_s, remote_branch).await;
        assert_eq!(upstream_of(&repo_s, remote_branch).await, None);
    }

    /// `branch.<name>.remote` and `.merge`, or `None` for each that is unset.
    async fn tracking_of(repo: &str, branch: &str) -> (Option<String>, Option<String>) {
        let get = |key: &'static str| {
            let key = format!("branch.{branch}.{key}");
            async move {
                let out = run_git_raw(Some(repo), &["config", "--get", &key], DEFAULT_TIMEOUT)
                    .await
                    .unwrap();
                (out.code == 0).then(|| out.stdout_lossy().trim().to_string())
            }
        };
        (get("remote").await, get("merge").await)
    }

    /// Every `branch.autoSetupMerge` mode × start kind in which git attempts tracking
    /// (measured, git 2.51.1). Repaired exactly where git's own choice is the start ref
    /// itself, to what an uncontended twin create writes; `inherit` copies the START's
    /// upstream instead, which the repair can't pin, so it surfaces git's error with no
    /// upstream rather than a wrong one, and the switch leg still runs. A create with no
    /// start point starts from HEAD, which `always` tracks like any local start.
    #[tokio::test]
    async fn a_tracked_create_repairs_only_what_git_itself_would_write() {
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-modes", "local-start", "same-name").await;
        let main = run(&repo_s, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
        let state = AppState::default();
        // (mode, start, new branch, checkout, repaired). `simple` tracks only a
        // same-named remote branch, so its row creates `same-name` itself.
        let cases: [(Option<&str>, Option<&str>, &str, bool, bool); 7] = [
            (None, Some("origin/same-name"), "mode-default", false, true),
            (
                Some("always"),
                Some("local-start"),
                "mode-always-local",
                false,
                true,
            ),
            (Some("always"), None, "mode-always-nostart", false, true),
            (Some("always"), None, "mode-always-nostart-co", true, true),
            (
                Some("simple"),
                Some("origin/same-name"),
                "same-name",
                false,
                true,
            ),
            (
                Some("inherit"),
                Some("local-start"),
                "mode-inherit-local",
                false,
                false,
            ),
            (
                Some("inherit"),
                Some("local-start"),
                "mode-inherit-co",
                true,
                false,
            ),
        ];
        for (mode, start, name, checkout, repaired) in cases {
            run(&repo_s, &["switch", "-q", main.trim()]).await;
            let _ = run_git_raw(
                Some(&repo_s),
                &["config", "--unset-all", "branch.autoSetupMerge"],
                DEFAULT_TIMEOUT,
            )
            .await;
            if let Some(mode) = mode {
                run(&repo_s, &["config", "branch.autoSetupMerge", mode]).await;
            }
            // What git itself writes in this mode, uncontended. `simple` gets the
            // measured literal: its twin can't share the name tracking requires.
            let want = if mode == Some("simple") {
                (Some("origin".into()), Some("refs/heads/same-name".into()))
            } else {
                let twin = format!("{name}-twin");
                let mut twin_args = vec!["branch", twin.as_str()];
                twin_args.extend(start);
                run(&repo_s, &twin_args).await;
                tracking_of(&repo_s, &twin).await
            };
            assert!(want.0.is_some(), "{mode:?} × {start:?}: git tracks here");

            let lock = hold_config_lock(&repo);
            let (hook, _) = release_config_lock_before_attempt(lock.clone(), 2);
            let created = CONFIG_WRITE_ATTEMPT_HOOK
                .scope(
                    hook,
                    git_create_branch_core(
                        &state,
                        repo_s.clone(),
                        name.into(),
                        checkout,
                        start.map(str::to_string),
                        false,
                    ),
                )
                .await;
            let _ = std::fs::remove_file(&lock);
            let got = tracking_of(&repo_s, name).await;
            if repaired {
                created.unwrap_or_else(|e| panic!("{mode:?} × {start:?}: {e}"));
                assert_eq!(
                    got, want,
                    "{mode:?} × {start:?}: what git would have written"
                );
            } else {
                let err = created.expect_err("an unpinnable upstream surfaces git's error");
                let AppError::Git { stderr, .. } = &err else {
                    panic!("expected git's error, got {err:?}")
                };
                assert!(stderr.contains(UPSTREAM_WRITE_FAILED), "{stderr}");
                assert_eq!(
                    got,
                    (None, None),
                    "{mode:?} × {start:?}: no guessed upstream"
                );
                assert_ne!(want.1.as_deref(), Some("refs/heads/local-start"));
            }
            assert!(branch_exists(&repo_s, name).await);
            if checkout {
                assert_eq!(
                    run(&repo_s, &["symbolic-ref", "--short", "HEAD"])
                        .await
                        .trim(),
                    name
                );
                assert_eq!(porcelain(&repo_s).await, "", "the switch leg still ran");
            }
        }
    }

    /// A create from a tracked start point that loses the config lock ends where an
    /// uncontended one does, in both modes: switched (or not) and tracking.
    #[tokio::test]
    async fn a_tracked_create_that_loses_the_config_lock_still_tracks() {
        let (_base, repo, repo_s) =
            repo_with_branch_settings("cfg-lock-create", "unrelated", "cfg-lock-start").await;
        let state = AppState::default();
        for (name, checkout) in [("cfg-lock-made", false), ("cfg-lock-made-co", true)] {
            let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&repo), 2);
            CONFIG_WRITE_ATTEMPT_HOOK
                .scope(
                    hook,
                    git_create_branch_core(
                        &state,
                        repo_s.clone(),
                        name.into(),
                        checkout,
                        Some("origin/cfg-lock-start".into()),
                        false,
                    ),
                )
                .await
                .expect("the create succeeds");
            assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
            assert_eq!(
                upstream_of(&repo_s, name).await.as_deref(),
                Some("origin/cfg-lock-start")
            );
            if checkout {
                assert_cleanly_on(&repo, &repo_s, name).await;
            } else {
                assert_eq!(seed_file(&repo), "hello", "a plain create leaves the tree");
                assert_eq!(porcelain(&repo_s).await, "");
            }
        }
    }

    #[test]
    fn the_config_busy_refusal_names_the_branch_and_the_retry() {
        assert_eq!(
            archive_config_busy("feat/x", true).to_string(),
            "Another Git process was saving this repository's settings, so feat/x wasn't \
             archived — try again."
        );
        assert!(archive_config_busy("feat/x", false)
            .to_string()
            .contains("feat/x wasn't unarchived — try again."));
    }
}
