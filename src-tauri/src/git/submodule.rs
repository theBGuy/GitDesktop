use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::conflict::{
    conflict_rel_path, refuse_linked_path, unmerged_entries, UnmergedEntry, GITLINK_MODE,
    NOT_CONFLICTED_REFUSAL,
};
use crate::git::runner::{
    acquire_repo_lock, config_lock_busy, is_config_lock_contention, run_git, run_git_config_write,
    run_git_config_write_held, run_git_raw, run_git_raw_index_retry, with_config_write_lock,
    GitOutput, DEFAULT_TIMEOUT, LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT, WORKTREE_OP_TIMEOUT,
};
use crate::git::types::{
    Submodule, SubmoduleChanges, SubmoduleCheckout, SubmoduleCommit, SubmoduleRemoveOutcome,
};
use crate::state::AppState;

/// Belongs on EVERY `status --porcelain` probe here whose emptiness is read as
/// "clean": `status.showUntrackedFiles=no` otherwise suppresses the `??` lines and
/// empties the answer while the worktree is dirty (measured, git 2.51.1). Both such
/// probes — the remove path's submodule-worktree check and
/// [`refuse_unsettled_gitmodules`] — carry it.
const UNTRACKED_NORMAL: &str = "--untracked-files=normal";

/// A caller-supplied path that git will resolve inside the repo. Rejected before
/// it reaches argv: a leading `-` parses as an option, and an absolute or
/// `..`-escaping path would place the submodule outside the working tree.
/// Backslashes never appear in git's own output, so they can only be hand-typed.
///
/// `.` segments are refused alongside `..` because they retarget without escaping:
/// as a module-data name, `x/.` stays inside the modules subtree yet resolves to
/// SIBLING `x`. Split on `/` rather than `Path::components`, which normalizes a
/// trailing `.` away entirely and would report `x/.` as one clean Normal component.
fn validate_repo_relative(path: &str, label: &str) -> AppResult<()> {
    let escapes = path.is_empty()
        || path.starts_with('-')
        || path.contains('\\')
        || path.starts_with('/')
        || Path::new(path).is_absolute()
        || has_drive_prefix(path)
        || path.split('/').any(|seg| seg == ".." || seg == ".");
    if escapes {
        return Err(AppError::InvalidArgument(format!(
            "Invalid {label} \"{path}\" — it must be a forward-slash path inside this \
             repository (for example libs/dep), without \".\" or \"..\" segments, a \
             leading \"-\", or a drive prefix."
        )));
    }
    Ok(())
}

/// A Windows drive prefix — `C:/windows` (drive-absolute) or `c:relative` (relative
/// to that drive's current directory). Refused on EVERY platform rather than behind
/// a `cfg`: `Path::is_absolute` reads `C:/windows` as a plain relative path on Unix,
/// and these paths reach the validator from `.gitmodules`, which is untrusted repo
/// content that travels between hosts — what a repo is allowed to contain must not
/// depend on which OS opens it.
fn has_drive_prefix(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// A value that rides in an argv option slot; only the option-injection shape is
/// refused, since git validates URLs and branch names itself.
fn validate_option_value(value: &str, label: &str) -> AppResult<()> {
    if value.is_empty() || value.starts_with('-') {
        return Err(AppError::InvalidArgument(format!(
            "Invalid {label} \"{value}\" — it can't be empty or start with \"-\"."
        )));
    }
    Ok(())
}

/// One submodule's `.gitmodules` metadata.
struct ModuleEntry {
    name: String,
    url: String,
    branch: Option<String>,
}

/// `.gitmodules` keyed by the configured path. A repo can carry a gitlink with no
/// section at all — and the file itself may be missing — so any non-zero exit is
/// an empty map rather than an error, leaving the status-derived list intact.
async fn gitmodules_entries(repo_path: &str) -> HashMap<String, ModuleEntry> {
    let out = run_git_raw(
        Some(repo_path),
        &[
            "config",
            "-f",
            ".gitmodules",
            "-z",
            "--get-regexp",
            r"^submodule\.",
        ],
        DEFAULT_TIMEOUT,
    )
    .await;
    let Ok(out) = out else {
        return HashMap::new();
    };
    if out.code != 0 {
        return HashMap::new();
    }
    // `-z` emits `key\nvalue\0` records, so a section name containing spaces or a
    // value containing newlines still parses unambiguously.
    let text = out.stdout_lossy();
    let mut by_name: HashMap<String, (Option<String>, String, Option<String>)> = HashMap::new();
    for record in text.split('\0').filter(|r| !r.is_empty()) {
        let (key, value) = record.split_once('\n').unwrap_or((record, ""));
        let Some(rest) = key.strip_prefix("submodule.") else {
            continue;
        };
        // The field is the LAST dot-separated token: section names routinely
        // contain dots (a `libs/foo.bar` path is its own default name).
        let Some((name, field)) = rest.rsplit_once('.') else {
            continue;
        };
        let slot = by_name.entry(name.to_string()).or_default();
        match field {
            "path" => slot.0 = Some(value.to_string()),
            "url" => slot.1 = value.to_string(),
            "branch" => slot.2 = Some(value.to_string()),
            _ => {}
        }
    }
    by_name
        .into_iter()
        .filter_map(|(name, (path, url, branch))| {
            Some((path?, ModuleEntry { name, url, branch }))
        })
        .collect()
}

/// The repo's submodules, joining `git submodule status` to `.gitmodules`.
/// Lock-free runners only, so callers may hold the repo lock across it.
///
/// `repo_path` must be the worktree TOPLEVEL — the contract for every command in
/// this module. The join needs it: `.gitmodules` spells `path` relative to the root
/// while `submodule status` spells it relative to the cwd, so from a subdirectory
/// the two sides stop matching and every row silently loses its name, URL and
/// branch. Tauri only ever passes the validated toplevel; the MCP server, which
/// takes `--repo` verbatim, exposes none of these commands.
pub(crate) async fn list_submodules(repo_path: &str) -> AppResult<Vec<Submodule>> {
    // `git submodule status` prints "[ +-U]<sha> <path>[ (<describe>)]" per line.
    // The leading flag means: ' ' in sync, '-' not initialized, '+' the checked-
    // out commit differs from the one recorded, 'U' merge conflicts.
    let out = run_git(Some(repo_path), &["submodule", "status"], DEFAULT_TIMEOUT).await?;
    let entries = gitmodules_entries(repo_path).await;
    let mut subs = Vec::new();
    for line in out.stdout_lossy().lines() {
        if line.is_empty() {
            continue;
        }
        let flag = line.as_bytes()[0];
        let rest = &line[1..];
        let mut parts = rest.splitn(2, ' ');
        let sha = parts.next().unwrap_or("").to_string();
        let remainder = parts.next().unwrap_or("");
        let (path, describe) = match remainder.rfind(" (") {
            Some(i) => (
                remainder[..i].to_string(),
                remainder[i + 2..].trim_end_matches(')').to_string(),
            ),
            None => (remainder.to_string(), String::new()),
        };
        if path.is_empty() {
            continue;
        }
        let status = match flag {
            b'-' => "uninitialized",
            b'+' => "modified",
            b'U' => "conflict",
            _ => "ok",
        };
        let (name, url, branch) = match entries.get(&path) {
            Some(entry) => (entry.name.clone(), entry.url.clone(), entry.branch.clone()),
            None => (path.clone(), String::new(), None),
        };
        subs.push(Submodule {
            path,
            name,
            url,
            branch,
            sha,
            describe,
            status: status.to_string(),
        });
    }
    Ok(subs)
}

/// Lists the repo's submodules with their status. Empty for a repo without any.
#[tauri::command]
pub async fn git_submodules(repo_path: String) -> AppResult<Vec<Submodule>> {
    list_submodules(&repo_path).await
}

/// Initializes (when needed) and updates submodules, recursing into nested ones.
/// `path` targets one submodule; `None` updates all. `remote` advances the
/// TARGETED submodules to their configured branch (their remote HEAD when unset)
/// instead of the commit the parent records; their own nested submodules still
/// settle on what the bumped child records. Only the `remote` arm is gated on a
/// quiet repo: a plain update merely restores the recorded shas, which stays safe
/// (and has always been allowed) mid-merge or mid-rebase, whereas advancing
/// submodules off those shas during one is not.
#[tauri::command]
pub async fn git_submodule_update(
    state: State<'_, AppState>,
    repo_path: String,
    path: Option<String>,
    remote: bool,
) -> AppResult<()> {
    git_submodule_update_core(&state, repo_path, path, remote).await
}

pub(crate) async fn git_submodule_update_core(
    state: &AppState,
    repo_path: String,
    path: Option<String>,
    remote: bool,
) -> AppResult<()> {
    // The path comes from `git submodule status`, so it must match itself alone:
    // the builtin honors pathspec magic, and a raw `libs/[mod]` initializes the
    // sibling `libs/m` INSTEAD — cloning the wrong repo (measured, git 2.51.1).
    let path = path.filter(|p| !p.is_empty());
    if let Some(path) = path.as_deref() {
        validate_repo_relative(path, "submodule path")?;
    }
    let spec = path.as_deref().map(crate::git::pathspec::literal);
    if !remote {
        let mut args = vec!["submodule", "update", "--init", "--recursive"];
        if let Some(spec) = spec.as_deref() {
            args.extend_from_slice(&["--", spec]);
        }
        // Attempt, registration repair and re-run are one sequence: hold the working-tree
        // lock across all three so the re-run sees the attempt's `.gitmodules` and index,
        // with the lock-free index.lock-retrying runner inside.
        let domain = state.working_tree_lock(&repo_path).await;
        let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a submodule update").await?;
        return update_registering_lost_init(&repo_path, spec.as_deref(), &args).await;
    }

    // `--remote --recursive` applies --remote at EVERY depth, silently advancing
    // nested submodules to their own remote tips (measured, git 2.51.1). Only the
    // targeted level should follow its branch, so bump it un-recursively and then
    // settle its children on what it now records — two commands, one lock. Both are
    // network steps, so the working-tree lock is deliberately held for minutes: the
    // pair has to see one unbroken view, and blocking other mutations meanwhile is
    // the point. Labelled because of that duration — a waiter that gives up has to be
    // told it is queued behind a submodule update rather than left guessing.
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a submodule update").await?;
    crate::git::ops::refuse_mid_op_for(&repo_path, "update submodules").await?;

    let mut args = vec!["submodule", "update", "--init", "--remote"];
    if let Some(spec) = spec.as_deref() {
        args.extend_from_slice(&["--", spec]);
    }
    update_registering_lost_init(&repo_path, spec.as_deref(), &args).await?;

    // The settling legs register NESTED submodules in each child's own config, which
    // this repository's config-write mutex doesn't key and its repair doesn't cover.
    match path.as_deref() {
        // Recursing from inside the bumped child resolves its gitlinks against its
        // NEW HEAD; the parent's own `--recursive` would re-walk the other siblings.
        Some(path) => {
            let child = Path::new(&repo_path).join(path);
            run_git(
                Some(&child.to_string_lossy()),
                &["submodule", "update", "--init", "--recursive"],
                NETWORK_TIMEOUT,
            )
            .await?;
        }
        // `foreach` takes the whole trailing command as ONE argument and runs it in
        // each bumped submodule's worktree.
        None => {
            run_git(
                Some(&repo_path),
                &[
                    "submodule",
                    "foreach",
                    "git submodule update --init --recursive",
                ],
                NETWORK_TIMEOUT,
            )
            .await?;
        }
    }
    Ok(())
}

/// Runs a `submodule update --init` (`args`) under the caller's working-tree hold, and
/// re-runs it once [`register_after_lost_init`] lands the registration it lost.
async fn update_registering_lost_init(
    repo_path: &str,
    spec: Option<&str>,
    args: &[&str],
) -> AppResult<()> {
    let out = run_git_raw_index_retry(repo_path, args, NETWORK_TIMEOUT).await?;
    let out = match register_after_lost_init(repo_path, spec, &out).await? {
        InitRepair::Untouched => out,
        InitRepair::Registered => run_git_raw_index_retry(repo_path, args, NETWORK_TIMEOUT).await?,
        InitRepair::LostAgain => {
            return Err(config_lock_busy(if spec.is_some() {
                "the submodule wasn't set up — try again."
            } else {
                "the submodules weren't set up — try again."
            }))
        }
    };
    out.exit_verdict()?;
    Ok(())
}

/// What [`register_after_lost_init`] found.
enum InitRepair {
    /// No registration was lost here, so the attempt's own result stands.
    Untouched,
    /// The lost registration landed, so the update may re-run.
    Registered,
    /// The repair lost the config lock too, before anything was cloned.
    LostAgain,
}

/// Redoes the registration a `submodule update --init` lost to the config lock, under
/// the config-write mutex (a leaf below the caller's working-tree hold). Only a repair
/// that registers something new proves the loss was here, before any clone, so the
/// caller may re-run the update under the same hold with nothing left to write; a
/// CHILD-config loss (after clones landed) registers nothing, so git's error stands.
async fn register_after_lost_init(
    repo_path: &str,
    spec: Option<&str>,
    out: &GitOutput,
) -> AppResult<InitRepair> {
    if out.code == 0 || !is_config_lock_contention(&out.stderr) {
        return Ok(InitRepair::Untouched);
    }
    let mut args = vec!["submodule", "init"];
    if let Some(spec) = spec {
        args.extend_from_slice(&["--", spec]);
    }
    with_config_write_lock(repo_path, |held| async move {
        let before = submodule_registrations(repo_path).await?;
        let init = run_git_config_write_held(&held, repo_path, &args, DEFAULT_TIMEOUT).await?;
        let after = submodule_registrations(repo_path).await?;
        // Init only registers and the update's run clones, so an init lost to the lock left
        // the rest un-set-up even when some names registered first.
        let repair = if init.code != 0 && is_config_lock_contention(&init.stderr) {
            InitRepair::LostAgain
        } else if init.code == 0 && after != before {
            InitRepair::Registered
        } else {
            InitRepair::Untouched
        };
        Ok(repair)
    })
    .await
}

/// This repository's own `submodule.*` keys, empty when there are none.
async fn submodule_registrations(repo_path: &str) -> AppResult<String> {
    let out = run_git_raw(
        Some(repo_path),
        &["config", "--local", "--get-regexp", r"^submodule\."],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(out.stdout_lossy())
}

/// Adds `url` as a submodule at `path` (inferred from the URL when `None`),
/// optionally tracking `branch`. git clones it and stages both `.gitmodules` and
/// the new gitlink; the commit is the user's.
#[tauri::command]
pub async fn git_submodule_add(
    state: State<'_, AppState>,
    repo_path: String,
    url: String,
    path: Option<String>,
    branch: Option<String>,
) -> AppResult<()> {
    git_submodule_add_core(&state, repo_path, url, path, branch).await
}

pub(crate) async fn git_submodule_add_core(
    state: &AppState,
    repo_path: String,
    url: String,
    path: Option<String>,
    branch: Option<String>,
) -> AppResult<()> {
    validate_option_value(&url, "submodule URL")?;
    let path = path.filter(|p| !p.is_empty());
    if let Some(path) = path.as_deref() {
        validate_repo_relative(path, "submodule path")?;
    }
    let branch = branch.filter(|b| !b.trim().is_empty());
    if let Some(branch) = branch.as_deref() {
        validate_option_value(branch, "submodule branch")?;
    }
    let mut args = vec!["submodule", "add"];
    if let Some(branch) = branch.as_deref() {
        args.push("-b");
        args.push(branch);
    }
    // Plain path after `--`, NOT a pathspec: `add` names the directory to create.
    args.push("--");
    args.push(&url);
    if let Some(path) = path.as_deref() {
        args.push(path);
    }

    // Lock-once rather than `run_git_mutating`, so the `.gitmodules` guard cannot be
    // raced by another in-process mutation between check and run — the same shape the
    // other three `.gitmodules` writers use. The costs are deliberate: the working-tree
    // lock is held across the clone, and the lock-free runner gives up
    // `run_git_mutating`'s one-shot index.lock retry.
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a submodule change").await?;
    crate::git::ops::refuse_mid_op_for(&repo_path, "add a submodule").await?;
    refuse_unsettled_gitmodules(&repo_path).await?;
    // An inferred path is named afterwards by the `.gitmodules` entry the add created.
    let before = match path {
        Some(_) => None,
        None => Some(gitmodules_entries(&repo_path).await),
    };
    let out = run_git_raw(Some(&repo_path), &args, NETWORK_TIMEOUT)
        .await?
        .exit_verdict()?;
    // The clone runs without the config-write mutex, and git ignores a lost lock on
    // its `submodule.<name>.url`/`.active` writes: it exits 0, cloned and staged, with
    // the module unregistered (measured, git 2.51.1). `submodule init` writes exactly
    // those keys, so it is the repair, under the mutex.
    if is_config_lock_contention(&out.stderr) {
        let added = match (path, before) {
            (Some(path), _) => Some(path),
            (None, Some(before)) => {
                let mut fresh = gitmodules_entries(&repo_path)
                    .await
                    .into_keys()
                    .filter(|p| !before.contains_key(p));
                fresh.next().filter(|_| fresh.next().is_none())
            }
            (None, None) => None,
        };
        let Some(added) = added else {
            return Err(AppError::Command(
                "The submodule was cloned and staged, but its registration in this \
                 repository couldn't be confirmed — update it to finish setting it up."
                    .into(),
            ));
        };
        let spec = crate::git::pathspec::literal(&added);
        let args = ["submodule", "init", "--", &spec];
        let init = run_git_config_write(&repo_path, &args, DEFAULT_TIMEOUT).await?;
        // Re-adding fails on the now-indexed path; an update registers the clone.
        if init.code != 0 && is_config_lock_contention(&init.stderr) {
            return Err(config_lock_busy(
                "the submodule was cloned and staged but couldn't be registered in this \
                 repository — update it to finish setting it up.",
            ));
        }
        init.exit_verdict()?;
    }
    Ok(())
}

/// Removes the submodule at `path`, leaving the deregistration staged: `deinit`
/// clears its worktree and `.git/config` entry, then `git rm` stages the
/// `.gitmodules` edit plus the deleted gitlink. Without `force` a dirty submodule
/// worktree is refused with nothing mutated. `delete_module_data` additionally
/// erases the submodule's repository data, which git otherwise keeps.
#[tauri::command]
pub async fn git_submodule_remove(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    force: bool,
    delete_module_data: bool,
) -> AppResult<SubmoduleRemoveOutcome> {
    git_submodule_remove_core(&state, repo_path, path, force, delete_module_data).await
}

pub(crate) async fn git_submodule_remove_core(
    state: &AppState,
    repo_path: String,
    path: String,
    force: bool,
    delete_module_data: bool,
) -> AppResult<SubmoduleRemoveOutcome> {
    validate_repo_relative(&path, "submodule path")?;
    let spec = crate::git::pathspec::literal(&path);

    // deinit → rm → module-data delete is one sequence: hold the working-tree lock
    // across it and use the lock-free runners inside — `run_git_mutating` would
    // re-acquire the same non-reentrant mutex and deadlock.
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a submodule change").await?;
    crate::git::ops::refuse_mid_op_for(&repo_path, "remove the submodule").await?;
    refuse_unsettled_gitmodules(&repo_path).await?;

    // Resolve the section name before `git rm` edits `.gitmodules` out from under
    // it — the module data directory is keyed on the name, not the path. The
    // lookup doubles as the only guard on the destructive pair below: `deinit`
    // exits 0 on a path that is not a submodule at all (measured), so an unmatched
    // path would fall straight through to `git rm` and delete a regular file.
    let sub = list_submodules(&repo_path)
        .await?
        .into_iter()
        .find(|s| s.path == path)
        .ok_or_else(|| AppError::InvalidArgument(format!("not a submodule: {path}")))?;

    let worktree = Path::new(&repo_path).join(&path);
    if !force {
        // git refuses deinit on a submodule whose HEAD has moved off the recorded
        // commit even when its worktree is spotless, so the status flag is part of
        // the dirty verdict — the worktree probe alone would let that reach a raw
        // fatal (measured, git 2.51.1). A "conflict" row can't arrive here:
        // `refuse_mid_op_for` above fires first.
        let mut dirty = sub.status == "modified";
        // Probe the submodule's OWN worktree only once it has one: an uninitialized
        // gitlink is an empty directory, and git would walk up and answer with the
        // PARENT repo's status instead (measured, git 2.51.1).
        if !dirty && worktree.join(".git").exists() {
            let dir = worktree.to_string_lossy().into_owned();
            let out = run_git_raw(
                Some(&dir),
                &["status", "--porcelain", UNTRACKED_NORMAL],
                DEFAULT_TIMEOUT,
            )
            .await?;
            // A probe that fails refuses too: nothing has been mutated yet, and the
            // user can still force.
            dirty = out.code != 0 || !out.stdout_lossy().trim().is_empty();
        }
        if dirty {
            return Ok(SubmoduleRemoveOutcome {
                refused_dirty: true,
                module_data_deleted: false,
                module_data_error: None,
            });
        }
    }

    // deinit before `git rm`, or `submodule.<name>.*` is orphaned in `.git/config`.
    // It exits 0 even when there is nothing registered to clear. Both steps delete a
    // whole checkout, so they take the worktree budget rather than the fixed one.
    let mut args = vec!["submodule", "deinit"];
    if force {
        args.push("-f");
    }
    args.extend_from_slice(&["--", spec.as_str()]);
    let deinit = run_git_raw(Some(&repo_path), &args, WORKTREE_OP_TIMEOUT)
        .await?
        .exit_verdict()?;
    // A deinit that loses the config lock still exits 0 and reports the module
    // unregistered, having cleared the worktree but kept `submodule.<name>` (measured,
    // git 2.51.1): exactly the orphan above. The clear ran without the config-write
    // mutex, so only the section removal takes it.
    if is_config_lock_contention(&deinit.stderr) {
        let section = format!("submodule.{}", sub.name);
        let removed = run_git_config_write(
            &repo_path,
            &["config", "--remove-section", &section],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if removed.code != 0 && is_config_lock_contention(&removed.stderr) {
            return Err(config_lock_busy(
                "the submodule's files were cleared but it wasn't removed — try again.",
            ));
        }
        if removed.code != 0 && !removed.stderr.contains("no such section") {
            removed.exit_verdict()?;
        }
    }

    let mut args = vec!["rm"];
    if force {
        args.push("-f");
    }
    args.extend_from_slice(&["--", spec.as_str()]);
    run_git(Some(&repo_path), &args, WORKTREE_OP_TIMEOUT).await?;

    let mut outcome = SubmoduleRemoveOutcome {
        refused_dirty: false,
        module_data_deleted: false,
        module_data_error: None,
    };
    if delete_module_data {
        match module_data_dir(&repo_path, &sub.name).await {
            // Already absent counts as deleted: the requested end state holds.
            Ok(dir) if !dir.exists() => outcome.module_data_deleted = true,
            Ok(dir) => match tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&dir)).await
            {
                Ok(Ok(())) => outcome.module_data_deleted = true,
                Ok(Err(e)) => outcome.module_data_error = Some(e.to_string()),
                Err(e) => outcome.module_data_error = Some(e.to_string()),
            },
            Err(e) => outcome.module_data_error = Some(e.to_string()),
        }
    }
    Ok(outcome)
}

/// `<git-dir>/modules/<name>` — the submodule's repository data, which survives
/// removal. Resolved through `rev-parse` rather than `<repo>/.git`, because the
/// parent can itself be a linked worktree whose git dir (and modules directory)
/// lives under `.git/worktrees/<name>/` (measured, git 2.51.1).
async fn module_data_dir(repo_path: &str, name: &str) -> AppResult<PathBuf> {
    // The name comes from `.gitmodules`, i.e. repo content: validate it like any
    // other untrusted path before it becomes a delete target.
    validate_repo_relative(name, "submodule name")?;
    let out = run_git(
        Some(repo_path),
        &["rev-parse", "--path-format=absolute", "--git-dir"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let stdout = out.stdout_lossy();
    let git_dir = stdout.trim_end_matches(['\r', '\n']);
    if git_dir.is_empty() {
        return Err(AppError::NotARepo(repo_path.to_string()));
    }
    let modules = Path::new(git_dir).join("modules");
    let dir = modules.join(name);
    // Structural containment, independent of the validator above: `join` REPLACES the
    // base when the joined path has a root or a Windows drive prefix, so `C:x` as a
    // name would otherwise hand `remove_dir_all` a target outside the modules subtree.
    if !dir.starts_with(&modules) {
        return Err(AppError::InvalidArgument(format!(
            "Invalid submodule name \"{name}\" — it escapes the repository's module data."
        )));
    }
    Ok(dir)
}

/// Points the submodule at `path` at a new `url`, syncing `.git/config` so the
/// next fetch uses it.
#[tauri::command]
pub async fn git_submodule_set_url(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    url: String,
) -> AppResult<()> {
    git_submodule_set_url_core(&state, repo_path, path, url).await
}

pub(crate) async fn git_submodule_set_url_core(
    state: &AppState,
    repo_path: String,
    path: String,
    url: String,
) -> AppResult<()> {
    validate_repo_relative(&path, "submodule path")?;
    validate_option_value(&url, "submodule URL")?;

    // set-url + stage is one sequence — lock once, lock-free runners inside.
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a submodule change").await?;
    crate::git::ops::refuse_mid_op_for(&repo_path, "change the submodule URL").await?;
    refuse_unsettled_gitmodules(&repo_path).await?;

    // set-url writes `.gitmodules`, then syncs `submodule.<name>.url` here and dies when
    // that sync loses the config lock (measured, git 2.51.1), so the repair re-syncs; a
    // sync takes a pathspec, hence the literal `spec`. A lost `.gitmodules.lock` gives the
    // same lock text with neither written (exit 1, measured), so the repair first checks
    // `.gitmodules` holds the new URL. Short enough to hold the config-write mutex
    // throughout, as a leaf below the working-tree domain.
    let spec = crate::git::pathspec::literal(&path);
    let (repo, path, url, spec) = (
        repo_path.as_str(),
        path.as_str(),
        url.as_str(),
        spec.as_str(),
    );
    let out = with_config_write_lock(repo, |held| async move {
        // A plain path, not a pathspec: `set-url` matches the `.gitmodules` entry by its
        // literal `path` value, which `:(literal)` magic would never equal.
        let args = ["submodule", "set-url", "--", path, url];
        let out = run_git_raw(Some(repo), &args, DEFAULT_TIMEOUT).await?;
        if out.code == 0 || !is_config_lock_contention(&out.stderr) {
            return Ok(out);
        }
        let entries = gitmodules_entries(repo).await;
        if entries.get(path).is_none_or(|entry| entry.url != url) {
            return Ok(out);
        }
        let sync = ["submodule", "sync", "--", spec];
        let synced = run_git_config_write_held(&held, repo, &sync, DEFAULT_TIMEOUT).await?;
        // A plain retry would be refused over the unstaged `.gitmodules` this leaves.
        if synced.code != 0 && is_config_lock_contention(&synced.stderr) {
            return Err(config_lock_busy(
                "the new URL was written to .gitmodules but not staged or synced — stage \
                 .gitmodules (or discard it) and set the URL again.",
            ));
        }
        AppResult::Ok(if synced.code == 0 { synced } else { out })
    })
    .await?;
    out.exit_verdict()?;
    stage_gitmodules(repo).await
}

/// Sets `submodule.<name>.branch` for the submodule at `path`; `None` restores
/// git's default (the remote HEAD), which `--remote` updates then follow.
#[tauri::command]
pub async fn git_submodule_set_branch(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    branch: Option<String>,
) -> AppResult<()> {
    git_submodule_set_branch_core(&state, repo_path, path, branch).await
}

pub(crate) async fn git_submodule_set_branch_core(
    state: &AppState,
    repo_path: String,
    path: String,
    branch: Option<String>,
) -> AppResult<()> {
    validate_repo_relative(&path, "submodule path")?;
    let branch = branch.filter(|b| !b.trim().is_empty());
    if let Some(branch) = branch.as_deref() {
        validate_option_value(branch, "submodule branch")?;
    }

    // set-branch + stage, same one-sequence shape as `set_url`.
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a submodule change").await?;
    crate::git::ops::refuse_mid_op_for(&repo_path, "change the submodule branch").await?;
    refuse_unsettled_gitmodules(&repo_path).await?;

    let mut args = vec!["submodule", "set-branch"];
    match branch.as_deref() {
        Some(branch) => args.extend_from_slice(&["--branch", branch]),
        None => args.push("--default"),
    }
    args.extend_from_slice(&["--", path.as_str()]);
    run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?;
    stage_gitmodules(&repo_path).await
}

/// Commits listed per side of a submodule's range, and inner status rows returned.
const SUBMODULE_COMMITS_CAP: usize = 50;
const SUBMODULE_FILES_CAP: usize = 100;
/// How much of a failed inner read's stderr line the pane shows.
const SUBMODULE_REASON_CAP: usize = 300;

/// What one side of a submodule row changed, for the Changes pane. Read-only and
/// lock-free; every git run is sequential, so the command future stays small.
/// `orig_path` is a staged rename's old path, where HEAD still records the gitlink.
#[tauri::command]
pub async fn git_submodule_changes(
    repo_path: String,
    path: String,
    staged: bool,
    orig_path: Option<String>,
) -> AppResult<SubmoduleChanges> {
    git_submodule_changes_core(&repo_path, &path, staged, orig_path.as_deref()).await
}

/// Only a refused path and a failed parent gitlink read are errors; every
/// checkout state, an unreadable submodule and an unwalkable range are data.
pub(crate) async fn git_submodule_changes_core(
    repo_path: &str,
    path: &str,
    staged: bool,
    orig_path: Option<&str>,
) -> AppResult<SubmoduleChanges> {
    validate_repo_relative(path, "submodule path")?;
    if let Some(orig) = orig_path {
        validate_repo_relative(orig, "submodule path")?;
    }
    let spec = crate::git::pathspec::literal(path);
    let index_sha = index_gitlink(repo_path, path, &spec).await?;
    let tree_sha = if staged {
        let head_path = orig_path.unwrap_or(path);
        let head_spec = crate::git::pathspec::literal(head_path);
        head_gitlink(repo_path, head_path, &head_spec).await?
    } else {
        None
    };

    let mut changes = SubmoduleChanges {
        path: path.to_string(),
        staged,
        checkout: SubmoduleCheckout::Ok,
        reason: None,
        branch: None,
        detached: false,
        head: None,
        from_sha: None,
        to_sha: None,
        range_known: true,
        ahead: Vec::new(),
        ahead_count: 0,
        behind: Vec::new(),
        behind_count: 0,
        files: Vec::new(),
        files_total: 0,
    };

    // git inside a folder with no `.git` of its own walks up and answers for the
    // PARENT (measured, git 2.51.1), so no git runs there unless one exists.
    let worktree = Path::new(repo_path).join(path);
    (changes.checkout, changes.reason) =
        checkout_from_probe(std::fs::symlink_metadata(&worktree), || {
            worktree.join(".git").try_exists()
        });
    let dir = worktree.to_string_lossy().into_owned();
    if changes.checkout == SubmoduleCheckout::Ok {
        let read = run_git_raw(Some(&dir), &submodule_status_args(staged), DEFAULT_TIMEOUT).await;
        match read {
            Ok(out) if out.code == 0 => {
                let status = crate::git::status::parse_status_v2(&out.stdout_lossy());
                changes.head = status.branch.oid;
                changes.branch = status.branch.name;
                changes.detached = status.branch.detached;
                if !staged {
                    changes.files_total = u32::try_from(status.entries.len()).unwrap_or(u32::MAX);
                    changes.files = status.entries;
                    changes.files.truncate(SUBMODULE_FILES_CAP);
                }
            }
            Ok(out) => {
                changes.checkout = SubmoduleCheckout::Unreadable;
                changes.reason = Some(unreadable_reason(&out.stderr, out.code));
            }
            Err(e) => {
                changes.checkout = SubmoduleCheckout::Unreadable;
                changes.reason = Some(nonempty_reason(e.to_string()));
            }
        }
    }

    (changes.from_sha, changes.to_sha) = if staged {
        (tree_sha, index_sha)
    } else {
        (index_sha, changes.head.clone())
    };
    if let (Some(from_sha), Some(to_sha)) = (&changes.from_sha, &changes.to_sha) {
        if from_sha != to_sha {
            let walked = match changes.checkout {
                SubmoduleCheckout::Ok => submodule_range(&dir, from_sha, to_sha).await,
                _ => None,
            };
            match walked {
                Some(range) => {
                    (changes.ahead, changes.ahead_count) = range.ahead;
                    (changes.behind, changes.behind_count) = range.behind;
                }
                None => changes.range_known = false,
            }
        }
    }
    Ok(changes)
}

/// The checkout state from an lstat of the gitlink path's final component (an
/// intermediate junction is still traversed): git run through a link reads the
/// link's target, a repository outside the parent. Only NotFound is missing; any
/// other failure, the `.git` probe's included, is unreadable with its message.
fn checkout_from_probe(
    probe: std::io::Result<std::fs::Metadata>,
    has_git: impl FnOnce() -> std::io::Result<bool>,
) -> (SubmoduleCheckout, Option<String>) {
    match probe {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (SubmoduleCheckout::Missing, None),
        Err(e) => (
            SubmoduleCheckout::Unreadable,
            Some(format!("couldn't read the submodule folder: {e}")),
        ),
        // An lstat reports a link (a junction too) as not a directory.
        Ok(meta) if !meta.is_dir() => (SubmoduleCheckout::Replaced, None),
        Ok(_) => match has_git() {
            Ok(true) => (SubmoduleCheckout::Ok, None),
            Ok(false) => (SubmoduleCheckout::NotInitialized, None),
            Err(e) => (
                SubmoduleCheckout::Unreadable,
                Some(format!("couldn't read the submodule's .git: {e}")),
            ),
        },
    }
}

/// The inner status read. The staged side reads only HEAD and the branch, so it
/// skips the untracked walk; either explicit mode overrides a
/// `status.showUntrackedFiles` config.
fn submodule_status_args(staged: bool) -> [&'static str; 5] {
    let untracked = if staged {
        "--untracked-files=no"
    } else {
        "--untracked-files=all"
    };
    ["status", "--porcelain=v2", "--branch", untracked, "-z"]
}

/// The index's stage-0 gitlink at exactly `path`; a pathspec naming a directory also
/// lists the entries under it. A failed read (no repository, an unreadable index) is
/// an Err carrying git's stderr, never None, which would read as "no gitlink here".
pub(crate) async fn index_gitlink(
    repo_path: &str,
    path: &str,
    spec: &str,
) -> AppResult<Option<String>> {
    let out = run_git_raw(
        Some(repo_path),
        &["ls-files", "-s", "-z", "--", spec],
        DEFAULT_TIMEOUT,
    )
    .await?
    .exit_verdict()?;
    // `<mode> <sha> <stage>\t<path>`
    Ok(out.stdout_lossy().split('\0').find_map(|record| {
        let (meta, rec_path) = record.split_once('\t')?;
        let mut meta = meta.split(' ');
        let (mode, sha, stage) = (meta.next()?, meta.next()?, meta.next()?);
        (rec_path == path && mode == "160000" && stage == "0").then(|| sha.to_string())
    }))
}

/// HEAD's gitlink at exactly `path`. None for a HEAD tree without one, or when the
/// read failed and [`crate::git::history::unborn_head`] confirms HEAD is unborn; any
/// other failure (a broken HEAD, no repository) is an Err, never a "before" of none.
/// A broken HEAD errs on git 2.43+ only: older git reads it as unborn (Ok(None)).
async fn head_gitlink(repo_path: &str, path: &str, spec: &str) -> AppResult<Option<String>> {
    let Some(out) = crate::git::history::read_unless_unborn(
        repo_path,
        &["ls-tree", "-z", "HEAD", "--", spec],
        DEFAULT_TIMEOUT,
    )
    .await?
    else {
        return Ok(None);
    };
    // `<mode> <type> <sha>\t<path>`
    Ok(out.stdout_lossy().split('\0').find_map(|record| {
        let (meta, rec_path) = record.split_once('\t')?;
        let mut meta = meta.split(' ');
        let (mode, _kind, sha) = (meta.next()?, meta.next()?, meta.next()?);
        (rec_path == path && mode == "160000").then(|| sha.to_string())
    }))
}

/// Each side of a measured range: the newest commits listed, and the exact count.
struct SubmoduleRange {
    ahead: (Vec<SubmoduleCommit>, u32),
    behind: (Vec<SubmoduleCommit>, u32),
}

/// Walks `from_sha...to_sha` inside the submodule; None when any read fails (a sha
/// its object store lacks exits 128), so a defaulted zero never reads as measured.
async fn submodule_range(dir: &str, from_sha: &str, to_sha: &str) -> Option<SubmoduleRange> {
    if !is_full_oid(from_sha) || !is_full_oid(to_sha) {
        return None;
    }
    let range = format!("{from_sha}...{to_sha}");
    let out = run_git_raw(
        Some(dir),
        &["rev-list", "--left-right", "--count", &range],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    if out.code != 0 {
        return None;
    }
    let counts = out.stdout_lossy();
    let (left, right) = counts.trim().split_once('\t')?;
    let behind_count: u32 = left.parse().ok()?;
    let ahead_count: u32 = right.parse().ok()?;
    let ahead_range = format!("{from_sha}..{to_sha}");
    let behind_range = format!("{to_sha}..{from_sha}");
    let ahead = if ahead_count > 0 {
        submodule_log(dir, &ahead_range).await?
    } else {
        Vec::new()
    };
    let behind = if behind_count > 0 {
        submodule_log(dir, &behind_range).await?
    } else {
        Vec::new()
    };
    Some(SubmoduleRange {
        ahead: (ahead, ahead_count),
        behind: (behind, behind_count),
    })
}

/// The newest commits of a validated two-dot range, sha and subject each.
async fn submodule_log(dir: &str, range: &str) -> Option<Vec<SubmoduleCommit>> {
    let max = format!("--max-count={SUBMODULE_COMMITS_CAP}");
    let out = run_git_raw(
        Some(dir),
        &[
            "log",
            "--no-color",
            "--no-show-signature",
            "--format=%H%x1f%s",
            &max,
            range,
        ],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?;
    if out.code != 0 {
        return None;
    }
    Some(
        out.stdout_lossy()
            .lines()
            .filter_map(|line| {
                let (sha, subject) = line.split_once('\x1f')?;
                Some(SubmoduleCommit {
                    sha: sha.to_string(),
                    subject: subject.to_string(),
                })
            })
            .collect(),
    )
}

/// A full object id (40 or 64 hex): the only shape a sha reaches argv in.
fn is_full_oid(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The failed inner read's first non-empty stderr line, capped; git's exit code
/// when stderr says nothing.
fn unreadable_reason(stderr: &str, code: i32) -> String {
    match stderr.lines().map(str::trim).find(|line| !line.is_empty()) {
        Some(line) => line.chars().take(SUBMODULE_REASON_CAP).collect(),
        None => format!("git exited with code {code}"),
    }
}

/// A spawn error or timeout's own message, never empty.
fn nonempty_reason(message: String) -> String {
    if message.trim().is_empty() {
        "git could not run in the submodule".to_string()
    } else {
        message
    }
}

/// A conflicted gitlink: the stage shas and what the submodule knows of each.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleConflict {
    /// Stage shas. All three `None` = the path is no longer conflicted.
    pub base: Option<String>,
    pub ours: Option<SubmoduleConflictSide>,
    pub theirs: Option<SubmoduleConflictSide>,
    pub relation: SubmoduleConflictRelation,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleConflictSide {
    pub sha: String,
    /// False: this stage's mode is not 160000 (a file sits on this side).
    pub gitlink: bool,
    /// Some exactly when the submodule's object store has the commit.
    pub commit: Option<SubmoduleConflictCommit>,
    /// What accepting this side would do to the submodule's checkout as of this read;
    /// None when `gitlink` is false. Advisory: the accept plans again under the lock.
    pub plan: Option<SubmoduleCheckoutPlan>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleConflictCommit {
    pub subject: String,
    /// The committer date, `%cI`.
    pub committed_at: String,
}

/// How the two sides' commits relate; measured only when the submodule has both.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SubmoduleConflictRelation {
    Unknown,
    OursContainsTheirs { ahead: u32 },
    TheirsContainsOurs { ahead: u32 },
    Diverged,
}

/// What accepting a side does to the submodule's own checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleCheckoutPlan {
    CheckOut,
    AlreadyThere,
    NotInitialized,
    Unusable,
    Dirty,
    DetachedElsewhere,
    NotFetched,
}

/// What one probe plus one status read measured inside the submodule.
struct SubmoduleCheckoutState {
    checkout: SubmoduleCheckout,
    head: Option<String>,
    detached: bool,
    dirty: bool,
}

/// Pure, no I/O; first match wins. `recorded` = the conflict's listed stage shas.
/// The tree-wide reasons outrank `present`, so two sides of one read differ only by
/// `AlreadyThere` / `NotFetched` / `CheckOut`. A HEAD detached at none of the
/// recorded commits stays put: moving it would orphan a commit no ref names.
fn plan_checkout(
    state: &SubmoduleCheckoutState,
    sha: &str,
    present: bool,
    recorded: &[&str],
) -> SubmoduleCheckoutPlan {
    match state.checkout {
        SubmoduleCheckout::NotInitialized | SubmoduleCheckout::Missing => {
            return SubmoduleCheckoutPlan::NotInitialized
        }
        SubmoduleCheckout::Replaced | SubmoduleCheckout::Unreadable => {
            return SubmoduleCheckoutPlan::Unusable
        }
        SubmoduleCheckout::Ok => {}
    }
    let head = state.head.as_deref();
    if head == Some(sha) {
        SubmoduleCheckoutPlan::AlreadyThere
    } else if state.dirty {
        SubmoduleCheckoutPlan::Dirty
    } else if state.detached && !head.is_some_and(|head| recorded.contains(&head)) {
        SubmoduleCheckoutPlan::DetachedElsewhere
    } else if !present {
        SubmoduleCheckoutPlan::NotFetched
    } else {
        SubmoduleCheckoutPlan::CheckOut
    }
}

/// The stage shas a pick was made from, compared against the live index.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleConflictStages {
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SubmoduleAcceptOutcome {
    /// The pointer is staged at `sha`; `checkout` says what happened inside the submodule.
    Staged {
        sha: String,
        checkout: SubmoduleAcceptCheckout,
    },
    /// The stages, or the checkout the pane promised, no longer match the read the
    /// pick was made from. Nothing was staged.
    Changed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SubmoduleAcceptCheckout {
    CheckedOut,
    AlreadyThere,
    Left {
        why: SubmoduleCheckoutLeft,
        reason: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmoduleCheckoutLeft {
    NotInitialized,
    Unusable,
    Dirty,
    DetachedElsewhere,
    NotFetched,
    Failed,
}

/// The unmerged records at exactly `path` (git's spelling from the path gate).
async fn conflict_entries(repo_path: &str, path: &str) -> AppResult<Vec<UnmergedEntry>> {
    let spec = crate::git::pathspec::literal(path);
    let mut entries = unmerged_entries(repo_path, &spec).await?;
    entries.retain(|entry| entry.path == path);
    Ok(entries)
}

fn stage_entry(entries: &[UnmergedEntry], stage: u8) -> Option<&UnmergedEntry> {
    entries.iter().find(|entry| entry.stage == stage)
}

fn live_stages(entries: &[UnmergedEntry]) -> SubmoduleConflictStages {
    let sha = |stage| stage_entry(entries, stage).map(|entry| entry.sha.clone());
    SubmoduleConflictStages {
        base: sha(1),
        ours: sha(2),
        theirs: sha(3),
    }
}

/// The submodule's folder and its checkout state. No git runs inside unless the
/// probe found a `.git` of its own: git in a folder without one answers for the
/// PARENT (measured, git 2.51.1). A failed status read is `Unreadable`, never clean.
async fn submodule_checkout_state(repo_path: &str, path: &str) -> (String, SubmoduleCheckoutState) {
    let worktree = Path::new(repo_path).join(path);
    let (checkout, _) = checkout_from_probe(std::fs::symlink_metadata(&worktree), || {
        worktree.join(".git").try_exists()
    });
    let dir = worktree.to_string_lossy().into_owned();
    let mut state = SubmoduleCheckoutState {
        checkout,
        head: None,
        detached: false,
        dirty: false,
    };
    if checkout == SubmoduleCheckout::Ok {
        let args = [
            "status",
            "--porcelain=v2",
            "--branch",
            UNTRACKED_NORMAL,
            "-z",
        ];
        match run_git_raw(Some(&dir), &args, DEFAULT_TIMEOUT).await {
            Ok(out) if out.code == 0 => {
                let status = crate::git::status::parse_status_v2(&out.stdout_lossy());
                state.head = status.branch.oid;
                state.detached = status.branch.detached;
                state.dirty = !status.entries.is_empty();
            }
            _ => state.checkout = SubmoduleCheckout::Unreadable,
        }
    }
    (dir, state)
}

/// Whether the submodule's object store has `sha` as a commit. Only a run that
/// answered decides: a spawn error or timeout is an Err, never "absent".
async fn commit_present(dir: &str, sha: &str) -> AppResult<bool> {
    let object = format!("{sha}^{{commit}}");
    let out = run_git_raw(Some(dir), &["cat-file", "-e", &object], DEFAULT_TIMEOUT).await?;
    Ok(out.code == 0)
}

/// Whether `sha` may be looked up inside an initialized submodule at all.
async fn side_present(dir: &str, state: &SubmoduleCheckoutState, sha: &str) -> AppResult<bool> {
    if state.checkout != SubmoduleCheckout::Ok || !is_full_oid(sha) {
        return Ok(false);
    }
    commit_present(dir, sha).await
}

/// A present commit's subject and committer date; a failed read is an Err, never
/// a commit reported as missing.
async fn conflict_commit(dir: &str, sha: &str) -> AppResult<SubmoduleConflictCommit> {
    let out = run_git(
        Some(dir),
        &[
            "log",
            "--no-walk",
            "--no-color",
            "--no-show-signature",
            "--format=%s%x1f%cI",
            sha,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let line = out.stdout_lossy();
    let (subject, committed_at) = line
        .trim_end_matches(['\r', '\n'])
        .split_once('\x1f')
        .ok_or_else(|| AppError::Command(format!("unreadable commit {sha} in the submodule")))?;
    Ok(SubmoduleConflictCommit {
        subject: subject.to_string(),
        committed_at: committed_at.to_string(),
    })
}

/// `ours...theirs` counted inside the submodule; any failure reads `Unknown`. A
/// shallow submodule can read `Diverged` where full history would read contained,
/// never the reverse.
async fn conflict_relation(dir: &str, ours: &str, theirs: &str) -> SubmoduleConflictRelation {
    let range = format!("{ours}...{theirs}");
    let counted = run_git_raw(
        Some(dir),
        &["rev-list", "--left-right", "--count", &range],
        DEFAULT_TIMEOUT,
    )
    .await;
    let Ok(out) = counted else {
        return SubmoduleConflictRelation::Unknown;
    };
    let text = out.stdout_lossy();
    let counts = (out.code == 0)
        .then(|| text.trim().split_once('\t'))
        .flatten()
        .and_then(|(left, right)| Some((left.parse::<u32>().ok()?, right.parse::<u32>().ok()?)));
    match counts {
        Some((0, right)) if right > 0 => {
            SubmoduleConflictRelation::TheirsContainsOurs { ahead: right }
        }
        Some((left, 0)) if left > 0 => {
            SubmoduleConflictRelation::OursContainsTheirs { ahead: left }
        }
        Some((left, right)) if left > 0 && right > 0 => SubmoduleConflictRelation::Diverged,
        _ => SubmoduleConflictRelation::Unknown,
    }
}

/// The two sides of a submodule conflict, for the conflict pane. Read-only and
/// lock-free; every git run is sequential, so the command future stays small.
#[tauri::command]
pub async fn git_submodule_conflict(
    repo_path: String,
    path: String,
) -> AppResult<SubmoduleConflict> {
    git_submodule_conflict_core(&repo_path, &path).await
}

pub(crate) async fn git_submodule_conflict_core(
    repo_path: &str,
    path: &str,
) -> AppResult<SubmoduleConflict> {
    let path = conflict_rel_path(path)?;
    refuse_linked_path(repo_path, &path, true).await?;
    let entries = conflict_entries(repo_path, &path).await?;
    if entries.is_empty() {
        return Ok(SubmoduleConflict {
            base: None,
            ours: None,
            theirs: None,
            relation: SubmoduleConflictRelation::Unknown,
        });
    }
    if !entries.iter().any(|entry| entry.mode == GITLINK_MODE) {
        return Err(AppError::InvalidArgument(
            "not a submodule conflict".to_string(),
        ));
    }
    let (dir, state) = submodule_checkout_state(repo_path, &path).await;
    let recorded: Vec<&str> = entries.iter().map(|entry| entry.sha.as_str()).collect();
    let mut sides = [None, None];
    for (slot, stage) in sides.iter_mut().zip([2u8, 3]) {
        let Some(entry) = stage_entry(&entries, stage) else {
            continue;
        };
        if entry.mode != GITLINK_MODE {
            *slot = Some(SubmoduleConflictSide {
                sha: entry.sha.clone(),
                gitlink: false,
                commit: None,
                plan: None,
            });
            continue;
        }
        let present = side_present(&dir, &state, &entry.sha).await?;
        let commit = if present {
            Some(conflict_commit(&dir, &entry.sha).await?)
        } else {
            None
        };
        *slot = Some(SubmoduleConflictSide {
            sha: entry.sha.clone(),
            gitlink: true,
            commit,
            plan: Some(plan_checkout(&state, &entry.sha, present, &recorded)),
        });
    }
    let [ours, theirs] = sides;
    let relation = match (&ours, &theirs) {
        (Some(o), Some(t)) if o.commit.is_some() && t.commit.is_some() => {
            conflict_relation(&dir, &o.sha, &t.sha).await
        }
        _ => SubmoduleConflictRelation::Unknown,
    };
    Ok(SubmoduleConflict {
        base: stage_entry(&entries, 1).map(|entry| entry.sha.clone()),
        ours,
        theirs,
        relation,
    })
}

/// Resolves a submodule conflict by staging one side's commit, then checks that
/// commit out inside the submodule when the plan allows. `expected` is the stage
/// shas the pick was made from and `expect_checkout` the pane's promise for this
/// side (its read's plan was `CheckOut`); either moving returns `Changed`.
#[tauri::command]
pub async fn git_accept_submodule_conflict_side(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    side: String,
    expected: SubmoduleConflictStages,
    expect_checkout: bool,
) -> AppResult<SubmoduleAcceptOutcome> {
    git_accept_submodule_conflict_side_core(
        &state,
        &repo_path,
        &path,
        &side,
        &expected,
        expect_checkout,
    )
    .await
}

pub(crate) async fn git_accept_submodule_conflict_side_core(
    state: &AppState,
    repo_path: &str,
    path: &str,
    side: &str,
    expected: &SubmoduleConflictStages,
    expect_checkout: bool,
) -> AppResult<SubmoduleAcceptOutcome> {
    let path = conflict_rel_path(path)?;
    let stage = match side {
        "ours" => 2u8,
        "theirs" => 3u8,
        _ => {
            return Err(AppError::InvalidArgument(format!(
                "invalid conflict side: {side}"
            )))
        }
    };
    for sha in [&expected.base, &expected.ours, &expected.theirs]
        .into_iter()
        .flatten()
    {
        if !is_full_oid(sha) {
            return Err(AppError::InvalidArgument(format!(
                "invalid commit id: {sha}"
            )));
        }
    }

    // One hold across compare, plan, swap and checkout. Lock-free runners only
    // while held (see `run_git_mutating`).
    let domain = state.working_tree_lock(repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a conflict resolution").await?;
    refuse_linked_path(repo_path, &path, true).await?;

    // A resolved path refuses: `--cacheinfo` on one exits 0 and re-points it
    // (measured, git 2.51.1), so a stale second press would move a settled pointer.
    let entries = conflict_entries(repo_path, &path).await?;
    if entries.is_empty() {
        return Err(AppError::InvalidArgument(NOT_CONFLICTED_REFUSAL.into()));
    }
    if live_stages(&entries) != *expected {
        return Ok(SubmoduleAcceptOutcome::Changed);
    }
    let Some(target) = stage_entry(&entries, stage).filter(|entry| entry.mode == GITLINK_MODE)
    else {
        return Err(AppError::InvalidArgument(
            "that side has no submodule commit to accept".to_string(),
        ));
    };
    // The LISTED sha, never re-resolved from a ref.
    let sha = target.sha.clone();

    let (dir, live) = submodule_checkout_state(repo_path, &path).await;
    let present = side_present(&dir, &live, &sha).await?;
    let recorded: Vec<&str> = entries.iter().map(|entry| entry.sha.as_str()).collect();
    let plan = plan_checkout(&live, &sha, present, &recorded);
    // The pane said the checkout would stay: re-read and say the new truth before
    // anything moves. Staying when a checkout was promised is always safe.
    if plan == SubmoduleCheckoutPlan::CheckOut && !expect_checkout {
        return Ok(SubmoduleAcceptOutcome::Changed);
    }

    // A path, not a pathspec: git's spelling from the gate, passed raw.
    let info = format!("{GITLINK_MODE},{sha},{path}");
    run_git_raw_index_retry(
        repo_path,
        &["update-index", "--cacheinfo", &info],
        DEFAULT_TIMEOUT,
    )
    .await?
    .exit_verdict()?;

    let left = |why| SubmoduleAcceptCheckout::Left { why, reason: None };
    let checkout = match plan {
        SubmoduleCheckoutPlan::CheckOut => checkout_staged_commit(&dir, &sha).await,
        SubmoduleCheckoutPlan::AlreadyThere => SubmoduleAcceptCheckout::AlreadyThere,
        SubmoduleCheckoutPlan::NotInitialized => left(SubmoduleCheckoutLeft::NotInitialized),
        SubmoduleCheckoutPlan::Unusable => left(SubmoduleCheckoutLeft::Unusable),
        SubmoduleCheckoutPlan::Dirty => left(SubmoduleCheckoutLeft::Dirty),
        SubmoduleCheckoutPlan::DetachedElsewhere => left(SubmoduleCheckoutLeft::DetachedElsewhere),
        SubmoduleCheckoutPlan::NotFetched => left(SubmoduleCheckoutLeft::NotFetched),
    };
    Ok(SubmoduleAcceptOutcome::Staged { sha, checkout })
}

/// Detaches the submodule at the staged commit. A failure is an outcome, never an
/// Err: the pointer is already staged and the caller must hear so. Never `submodule
/// update`, which fetches; `--no-overwrite-ignore` because a plain checkout replaces
/// an ignored file the target tracks while status calls the tree clean (measured,
/// git 2.51.1). Nested submodules are not updated.
async fn checkout_staged_commit(dir: &str, sha: &str) -> SubmoduleAcceptCheckout {
    let failed = |reason| SubmoduleAcceptCheckout::Left {
        why: SubmoduleCheckoutLeft::Failed,
        reason: Some(reason),
    };
    match run_git_raw(
        Some(dir),
        &["checkout", "--no-overwrite-ignore", "--detach", sha],
        WORKTREE_OP_TIMEOUT,
    )
    .await
    {
        Ok(out) if out.code == 0 => SubmoduleAcceptCheckout::CheckedOut,
        Ok(out) => failed(unreadable_reason(&out.stderr, out.code)),
        Err(e) => failed(nonempty_reason(e.to_string())),
    }
}

/// Refuses while `.gitmodules` is unsettled — unstaged edits, or a file git isn't
/// tracking yet — the shared pre-check for all four mutations that write that file.
/// Two reasons, both measured on git 2.51.1: `git rm` on a submodule fails "please
/// stage your changes to .gitmodules" with or without `-f` — and `deinit -f` succeeds
/// first, so the force path would strand a cleared worktree with nothing staged — and
/// `add` (which stages the whole worktree file itself) and [`stage_gitmodules`] would
/// otherwise sweep the user's unrelated edits, tracked or not, into the index. `:/`
/// costs nothing and anchors at the repo root, but does not widen the module's
/// contract — see [`list_submodules`].
async fn refuse_unsettled_gitmodules(repo_path: &str) -> AppResult<()> {
    // `status`, not `diff`: diff compares worktree to index, so an UNTRACKED
    // `.gitmodules` has no index entry and reads as clean — while `submodule add`
    // happily stages its pre-existing content (measured, git 2.51.1).
    // [`UNTRACKED_NORMAL`] is what keeps the untracked arm armed under a
    // `status.showUntrackedFiles=no` config.
    let out = run_git(
        Some(repo_path),
        &[
            "status",
            "--porcelain",
            UNTRACKED_NORMAL,
            "--",
            ":/.gitmodules",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    // Porcelain columns are `XY <path>`: X the index, Y the WORKTREE. Any non-space
    // Y is unsettled (` M`, `??`, ` D`, `MM`); staged-only (`M `, `A `, `D `) means
    // worktree == index, which is the state git's own staging check accepts.
    let stdout = out.stdout_lossy();
    let mut unsettled = false;
    let mut untracked = false;
    for line in stdout.lines() {
        match line.as_bytes().get(1) {
            Some(b' ') | None => continue,
            Some(_) => {
                unsettled = true;
                untracked |= line.starts_with("??");
            }
        }
    }
    if unsettled {
        return Err(AppError::InvalidArgument(
            if untracked {
                ".gitmodules isn't tracked yet — stage it or remove it first."
            } else {
                "Unstaged changes to .gitmodules — stage or discard them first."
            }
            .into(),
        ));
    }
    Ok(())
}

/// `set-url`/`set-branch` leave `.gitmodules` modified but UNSTAGED, unlike
/// `add`/`rm`. Stage it so every manager mutation reaches the user the same way:
/// staged, uncommitted. `:/` costs nothing and anchors at the repo root, but does
/// not widen the module's contract — see [`list_submodules`].
async fn stage_gitmodules(repo_path: &str) -> AppResult<()> {
    run_git(
        Some(repo_path),
        &["add", "--", ":/.gitmodules"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::repo::clone_repo_core;
    use crate::git::runner::{hold_config_lock, lock_events, TEST_GIT_HANG_GUARD};

    /// git refuses `file` transport for submodule clones by default
    /// (`fatal: transport 'file' not allowed`), and the block lives in the CHILD
    /// process, so a repo-local config never reaches it. These env vars are the
    /// only fixture-side lever that propagates: git re-exports them to every git
    /// it spawns. Production code must never inject the equivalent `-c`.
    fn allow_file_submodules() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            // COUNT lands LAST: git parses the pairs only once COUNT is set, so a
            // parallel test's git spawn snapshotting the env mid-triple sees either
            // nothing or a complete set. COUNT-first left a torn `COUNT=1, no KEY_0`
            // window that 128'd a concurrent spawn (seen live, ubuntu matrix).
            std::env::set_var("GIT_CONFIG_KEY_0", "protocol.file.allow");
            std::env::set_var("GIT_CONFIG_VALUE_0", "always");
            std::env::set_var("GIT_CONFIG_COUNT", "1");
        });
    }

    async fn git(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, TEST_GIT_HANG_GUARD)
            .await
            .unwrap_or_else(|e| panic!("git {args:?} in {repo}: {e}"))
            .stdout_lossy()
    }

    fn temp(marker: &str) -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix(&format!("gd-submodule-{marker}-"))
            .tempdir()
            .expect("create temp dir")
    }

    /// A one-commit repo at `dir/<name>`, returned as an absolute path string.
    async fn seed_repo(root: &Path, name: &str) -> String {
        let dir = root.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        let repo = dir.to_string_lossy().into_owned();
        git(&repo, &["init", "-q", "-b", "main", "."]).await;
        git(&repo, &["config", "core.autocrlf", "false"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        std::fs::write(dir.join(format!("{name}.txt")), "v0\n").unwrap();
        git(&repo, &["add", "-A"]).await;
        git(&repo, &["commit", "-qm", "base"]).await;
        repo
    }

    /// `host` with `libs/dep` added and committed, tracking `main`. Returns
    /// `(tempdir, host, dep)` — the tempdir must stay alive for the whole test.
    async fn host_with_submodule(marker: &str) -> (tempfile::TempDir, String, String) {
        allow_file_submodules();
        let dir = temp(marker);
        let dep = seed_repo(dir.path(), "dep").await;
        let host = seed_repo(dir.path(), "host").await;
        git_submodule_add_core(
            &AppState::default(),
            host.clone(),
            "../dep".into(),
            Some("libs/dep".into()),
            Some("main".into()),
        )
        .await
        .expect("submodule add");
        git(&host, &["commit", "-qm", "add dep"]).await;
        (dir, host, dep)
    }

    fn exists(root: &str, rel: &str) -> bool {
        Path::new(root).join(rel).exists()
    }

    #[test]
    fn repo_relative_paths_reject_option_and_escape_shapes() {
        // Multi-segment values stay legal — a submodule NAME falls back to its path.
        assert!(validate_repo_relative("libs/dep", "p").is_ok());
        assert!(validate_repo_relative("", "p").is_err());
        assert!(validate_repo_relative("--upload-pack=x", "p").is_err());
        assert!(validate_repo_relative("/etc/passwd", "p").is_err());
        // Drive shapes: `Path::is_absolute` calls none of these absolute on Unix,
        // so `has_drive_prefix` is what has to carry them everywhere.
        assert!(validate_repo_relative("C:/windows", "p").is_err());
        assert!(validate_repo_relative("c:relative", "p").is_err());
        assert!(validate_repo_relative("C:x", "p").is_err());
        assert!(validate_repo_relative(r"libs\dep", "p").is_err());
        assert!(validate_repo_relative("libs/../../out", "p").is_err());
        // `.` segments retarget without escaping: as a name, `x/.` resolves to the
        // SIBLING module-data dir `x` while still passing containment.
        assert!(validate_repo_relative("x/.", "p").is_err());
        assert!(validate_repo_relative("./x", "p").is_err());
        assert!(validate_repo_relative("libs/./dep", "p").is_err());
        // A `..` INSIDE a segment is a legal directory name, not an escape.
        assert!(validate_repo_relative("libs/a..b", "p").is_ok());
    }

    /// Pins the `join` PREMISE the containment guard rests on: the base is replaced
    /// when the joined path carries a root (or, on Windows, a drive prefix). The
    /// guard's own branch is deliberately unreachable defense-in-depth — the
    /// validator already rejects every base-replacing shape — so the premise, not
    /// the branch, is what a regression here would break.
    // The replacement clippy warns about is the behavior under test, not a mistake.
    #[allow(clippy::join_absolute_paths)]
    #[test]
    fn module_data_join_replacement_premises() {
        let modules = Path::new("/repo/.git").join("modules");
        assert!(modules.join("libs/dep").starts_with(&modules));
        // Rooted on every platform.
        assert!(!modules.join("/abs").starts_with(&modules));
        // Containment alone is NOT sufficient: `x/.` stays inside the subtree and
        // still retargets to sibling `x`, so `validate_repo_relative` owns that arm.
        assert!(modules.join("x/.").starts_with(&modules));
        // Drive shapes replace the base only on Windows; on Unix they are ordinary
        // relative names, which is why `validate_repo_relative` rejects them there
        // and this containment is the second layer rather than the only one.
        #[cfg(windows)]
        for escape in ["C:x", "C:/windows", "c:relative"] {
            assert!(!modules.join(escape).starts_with(&modules), "{escape}");
        }
    }

    #[test]
    fn option_values_reject_empty_and_dash_leading() {
        assert!(validate_option_value("https://example.com/x.git", "u").is_ok());
        assert!(validate_option_value("", "u").is_err());
        assert!(validate_option_value("--upload-pack=touch", "u").is_err());
    }

    /// The frontend reads these keys verbatim; a rename silently blanks the UI.
    #[test]
    fn wire_shapes_are_camel_case() {
        let sub = Submodule {
            path: "libs/dep".into(),
            name: "libs/dep".into(),
            url: "../dep".into(),
            branch: Some("main".into()),
            sha: "abc".into(),
            describe: "heads/main".into(),
            status: "ok".into(),
        };
        let json = serde_json::to_value(&sub).unwrap();
        let obj = json.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["branch", "describe", "name", "path", "sha", "status", "url"]
        );
        assert_eq!(obj["branch"], serde_json::json!("main"));
        // `None` must serialize as an explicit null, not vanish: the frontend
        // distinguishes "no branch configured" from a missing field.
        let unconfigured = Submodule {
            branch: None,
            ..sub.clone()
        };
        assert_eq!(
            serde_json::to_value(&unconfigured).unwrap()["branch"],
            serde_json::Value::Null
        );

        let outcome = SubmoduleRemoveOutcome {
            refused_dirty: true,
            module_data_deleted: false,
            module_data_error: Some("boom".into()),
        };
        let json = serde_json::to_value(&outcome).unwrap();
        let obj = json.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            ["moduleDataDeleted", "moduleDataError", "refusedDirty"]
        );
        assert_eq!(obj["refusedDirty"], serde_json::json!(true));

        let cleared = SubmoduleRemoveOutcome {
            refused_dirty: false,
            module_data_deleted: true,
            module_data_error: None,
        };
        assert_eq!(
            serde_json::to_value(&cleared).unwrap()["moduleDataError"],
            serde_json::Value::Null
        );
    }

    #[tokio::test]
    async fn listing_joins_gitmodules_name_url_and_branch() {
        let (_dir, host, _dep) = host_with_submodule("list").await;
        let subs = list_submodules(&host).await.unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].path, "libs/dep");
        assert_eq!(subs[0].name, "libs/dep");
        assert_eq!(subs[0].url, "../dep");
        assert_eq!(subs[0].branch.as_deref(), Some("main"));
        assert_eq!(subs[0].status, "ok");
        assert!(!subs[0].sha.is_empty());
    }

    /// The checked-out submodule inside `host`, as a path string.
    fn sub_dir(host: &str) -> String {
        Path::new(host)
            .join("libs/dep")
            .to_string_lossy()
            .into_owned()
    }

    /// Commits `file` in `repo` under `subject`; returns the new HEAD sha.
    async fn commit_in(repo: &str, file: &str, subject: &str) -> String {
        std::fs::write(Path::new(repo).join(file), subject).unwrap();
        git(repo, &["add", "-A"]).await;
        git(
            repo,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-qm",
                subject,
            ],
        )
        .await;
        git(repo, &["rev-parse", "HEAD"]).await.trim().to_string()
    }

    /// Points the parent's index gitlink at `sha`, the way a staged pointer bump does,
    /// without `git add` (which an ignore config can make skip the path).
    async fn stage_gitlink(host: &str, sha: &str) {
        let info = format!("160000,{sha},libs/dep");
        git(host, &["update-index", "--add", "--cacheinfo", &info]).await;
    }

    async fn changes(host: &str, staged: bool) -> SubmoduleChanges {
        git_submodule_changes_core(host, "libs/dep", staged, None)
            .await
            .expect("submodule changes")
    }

    #[tokio::test]
    async fn changes_untracked_only_lists_files_and_an_equal_pair() {
        let (_dir, host, _dep) = host_with_submodule("changes-untracked").await;
        let sub = sub_dir(&host);
        std::fs::write(Path::new(&sub).join("new.txt"), "x\n").unwrap();
        let c = changes(&host, false).await;
        assert_eq!(c.checkout, SubmoduleCheckout::Ok);
        assert_eq!(c.reason, None);
        assert_eq!(c.branch.as_deref(), Some("main"));
        assert!(!c.detached);
        assert!(c.head.is_some());
        assert_eq!(c.from_sha, c.head);
        assert_eq!(c.to_sha, c.head);
        assert!(c.range_known);
        assert!(c.ahead.is_empty() && c.behind.is_empty());
        assert_eq!((c.ahead_count, c.behind_count), (0, 0));
        assert_eq!(c.files.len(), 1);
        assert_eq!(c.files[0].path, "new.txt");
        assert_eq!(
            c.files[0].unstaged,
            Some(crate::git::types::ChangeKind::Untracked)
        );
        assert_eq!(c.files_total, 1);
    }

    #[tokio::test]
    async fn changes_new_commits_list_ahead_newest_first() {
        let (_dir, host, _dep) = host_with_submodule("changes-ahead").await;
        let sub = sub_dir(&host);
        let recorded = git(&sub, &["rev-parse", "HEAD"]).await.trim().to_string();
        let first = commit_in(&sub, "a.txt", "first | pipe\tand tab").await;
        let second = commit_in(&sub, "b.txt", "second").await;
        let c = changes(&host, false).await;
        assert_eq!(c.from_sha.as_deref(), Some(recorded.as_str()));
        assert_eq!(c.to_sha.as_deref(), Some(second.as_str()));
        assert!(c.range_known);
        assert_eq!((c.ahead_count, c.behind_count), (2, 0));
        let listed: Vec<(&str, &str)> = c
            .ahead
            .iter()
            .map(|k| (k.sha.as_str(), k.subject.as_str()))
            .collect();
        assert_eq!(
            listed,
            [
                (second.as_str(), "second"),
                (first.as_str(), "first | pipe\tand tab")
            ]
        );
        assert!(c.behind.is_empty());
        assert!(c.files.is_empty());
        assert_eq!(c.files_total, 0);
    }

    #[tokio::test]
    async fn changes_rewound_checkout_lists_behind_detached() {
        let (_dir, host, _dep) = host_with_submodule("changes-behind").await;
        let sub = sub_dir(&host);
        let newer = commit_in(&sub, "a.txt", "newer").await;
        stage_gitlink(&host, &newer).await;
        git(&host, &["commit", "-qm", "bump dep"]).await;
        git(&sub, &["checkout", "-q", "--detach", "HEAD~1"]).await;
        let older = git(&sub, &["rev-parse", "HEAD"]).await.trim().to_string();
        let c = changes(&host, false).await;
        assert!(c.detached);
        assert_eq!(c.branch, None);
        assert_eq!(c.head.as_deref(), Some(older.as_str()));
        assert_eq!(c.from_sha.as_deref(), Some(newer.as_str()));
        assert_eq!(c.to_sha.as_deref(), Some(older.as_str()));
        assert!(c.range_known);
        assert_eq!((c.ahead_count, c.behind_count), (0, 1));
        assert!(c.ahead.is_empty());
        assert_eq!(c.behind.len(), 1);
        assert_eq!(c.behind[0].sha, newer);
        assert_eq!(c.behind[0].subject, "newer");
    }

    #[tokio::test]
    async fn changes_staged_side_compares_head_gitlink_to_index() {
        let (_dir, host, _dep) = host_with_submodule("changes-staged").await;
        let sub = sub_dir(&host);
        let recorded = git(&sub, &["rev-parse", "HEAD"]).await.trim().to_string();
        let newer = commit_in(&sub, "a.txt", "bumped").await;
        stage_gitlink(&host, &newer).await;
        std::fs::write(Path::new(&sub).join("loose.txt"), "x\n").unwrap();
        let c = changes(&host, true).await;
        assert!(c.staged);
        assert_eq!(c.checkout, SubmoduleCheckout::Ok);
        assert_eq!(c.from_sha.as_deref(), Some(recorded.as_str()));
        assert_eq!(c.to_sha.as_deref(), Some(newer.as_str()));
        assert!(c.range_known);
        assert_eq!((c.ahead_count, c.behind_count), (1, 0));
        assert_eq!(c.ahead[0].subject, "bumped");
        // The staged side never lists the submodule's own files.
        assert!(c.files.is_empty());
        assert_eq!(c.files_total, 0);
        // The unstaged side of the same row: index → checkout, equal, with the file.
        let u = changes(&host, false).await;
        assert_eq!(u.from_sha.as_deref(), Some(newer.as_str()));
        assert_eq!(u.to_sha.as_deref(), Some(newer.as_str()));
        assert_eq!(u.files.len(), 1);
    }

    /// An unborn parent HEAD: `ls-tree HEAD` exits 128, so "before" is absent.
    #[tokio::test]
    async fn changes_staged_side_on_an_unborn_parent_head() {
        let dir = temp("changes-unborn");
        let host = dir.path().join("host");
        std::fs::create_dir_all(&host).unwrap();
        let host = host.to_string_lossy().into_owned();
        git(&host, &["init", "-q", "-b", "main", "."]).await;
        let sha = "1".repeat(40);
        stage_gitlink(&host, &sha).await;
        let c = changes(&host, true).await;
        assert_eq!(c.from_sha, None);
        assert_eq!(c.to_sha.as_deref(), Some(sha.as_str()));
        assert_eq!(c.checkout, SubmoduleCheckout::Missing);
        assert!(c.range_known);
        assert!(c.ahead.is_empty() && c.behind.is_empty());
    }

    /// Failed parent gitlink reads are errors, never a payload whose absent sha reads
    /// as "the next commit adds/removes this submodule". The tested set: a folder that
    /// is no repository, a garbage `.git/index`, and a branch ref holding garbage.
    #[tokio::test]
    async fn changes_errs_when_the_parent_is_not_a_repository() {
        let dir = temp("changes-norepo");
        let plain = dir.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        let plain = plain.to_string_lossy().into_owned();
        for staged in [false, true] {
            let result = git_submodule_changes_core(&plain, "libs/dep", staged, None).await;
            assert!(
                matches!(result, Err(AppError::Git { .. })),
                "{staged}: {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn changes_errs_on_a_garbage_parent_index() {
        let (_dir, host, _dep) = host_with_submodule("changes-badindex").await;
        std::fs::write(Path::new(&host).join(".git/index"), b"not an index").unwrap();
        for staged in [false, true] {
            let result = git_submodule_changes_core(&host, "libs/dep", staged, None).await;
            assert!(
                matches!(result, Err(AppError::Git { .. })),
                "{staged}: {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn changes_staged_side_errs_on_a_garbage_branch_ref() {
        let (_dir, host, _dep) = host_with_submodule("changes-badhead").await;
        std::fs::write(Path::new(&host).join(".git/refs/heads/main"), "garbage\n").unwrap();
        // `show-ref --exists` arrived in git 2.43; older git reads this as unborn.
        let exists = run_git_raw(
            Some(&host),
            &["show-ref", "--exists", "refs/heads/main"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        if exists.code == 129 {
            assert!(crate::git::history::unborn_head(&host).await.unwrap());
            return;
        }
        let result = git_submodule_changes_core(&host, "libs/dep", true, None).await;
        assert!(result.is_err(), "{result:?}");
        assert!(
            matches!(
                crate::git::history::unborn_head(&host).await,
                Err(AppError::Command(_))
            ),
            "the fixture must be a broken ref, not an unborn HEAD"
        );
    }

    /// No checkout: no git runs in the folder, so the parent's own changes (which a
    /// walk-up would list) never appear as the submodule's files.
    #[tokio::test]
    async fn changes_missing_replaced_and_not_initialized_run_no_git_inside() {
        let (dir, host, _dep) = host_with_submodule("changes-nocheckout").await;
        std::fs::write(dir.path().join("host").join("host.txt"), "edited\n").unwrap();
        std::fs::write(dir.path().join("host").join("stray.txt"), "x\n").unwrap();
        let sub = sub_dir(&host);
        let recorded = git(&sub, &["rev-parse", "HEAD"]).await.trim().to_string();
        let assert_no_checkout = |c: &SubmoduleChanges, want: SubmoduleCheckout| {
            assert_eq!(c.checkout, want);
            assert_eq!(c.reason, None);
            assert_eq!(c.branch, None);
            assert_eq!(c.head, None);
            assert!(!c.detached);
            assert!(c.files.is_empty());
            assert_eq!(c.files_total, 0);
            assert_eq!(c.from_sha.as_deref(), Some(recorded.as_str()));
            assert_eq!(c.to_sha, None);
            assert!(c.range_known);
        };
        std::fs::remove_dir_all(&sub).unwrap();
        assert_no_checkout(&changes(&host, false).await, SubmoduleCheckout::Missing);
        std::fs::write(&sub, "a file in the folder's place\n").unwrap();
        assert_no_checkout(&changes(&host, false).await, SubmoduleCheckout::Replaced);
        std::fs::remove_file(&sub).unwrap();
        // A link to a repository outside the parent reads as replaced, and git never
        // runs through it. The control: git run at the link answers for the target.
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let outside = outside.to_string_lossy().into_owned();
        git(&outside, &["init", "-q", "-b", "main", "."]).await;
        std::fs::write(Path::new(&outside).join("target-only.txt"), "x\n").unwrap();
        // A junction on Windows: mklink /J needs no privilege, unlike a symlink.
        // It reads a `/` in a path as a switch, so both go backslashed.
        #[cfg(windows)]
        {
            let made = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(sub.replace('/', "\\"))
                .arg(outside.replace('/', "\\"))
                .output()
                .expect("run mklink");
            assert!(
                made.status.success(),
                "mklink /J failed: {}",
                String::from_utf8_lossy(&made.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &sub).unwrap();
        let through = git(&sub, &["status", "--porcelain"]).await;
        assert!(
            through.contains("target-only.txt"),
            "walk-up control: {through}"
        );
        assert_no_checkout(&changes(&host, false).await, SubmoduleCheckout::Replaced);
        let staged = changes(&host, true).await;
        assert_eq!(staged.checkout, SubmoduleCheckout::Replaced);
        assert_eq!((staged.head, staged.reason), (None, None));
        assert!(staged.files.is_empty());
        // A directory link is removed as a directory on Windows, a file on unix.
        #[cfg(windows)]
        std::fs::remove_dir(&sub).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(&sub).unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        assert_no_checkout(
            &changes(&host, false).await,
            SubmoduleCheckout::NotInitialized,
        );
        // A staged pointer move over an empty folder differs, but can't be walked.
        stage_gitlink(&host, &"2".repeat(40)).await;
        let c = changes(&host, true).await;
        assert_eq!(c.checkout, SubmoduleCheckout::NotInitialized);
        assert_eq!(c.from_sha.as_deref(), Some(recorded.as_str()));
        assert_eq!(c.to_sha, Some("2".repeat(40)));
        assert!(!c.range_known);
        assert!(c.ahead.is_empty() && c.behind.is_empty());
        assert_eq!((c.ahead_count, c.behind_count), (0, 0));
        assert!(c.files.is_empty());
    }

    /// The `.git` probe over a real folder. Tested set: present, absent, and an
    /// injected PermissionDenied/Other (a real denied `.git` needs an ACL edit, so
    /// the error arrives through the closure seam instead).
    #[test]
    fn changes_git_probe_errors_read_unreadable_not_uninitialized() {
        use std::io::{Error, ErrorKind};
        let dir = temp("changes-gitprobe");
        let folder = || std::fs::symlink_metadata(dir.path());
        assert_eq!(
            checkout_from_probe(folder(), || Ok(true)),
            (SubmoduleCheckout::Ok, None)
        );
        assert_eq!(
            checkout_from_probe(folder(), || Ok(false)),
            (SubmoduleCheckout::NotInitialized, None)
        );
        for kind in [ErrorKind::PermissionDenied, ErrorKind::Other] {
            let (checkout, reason) = checkout_from_probe(folder(), || Err(Error::from(kind)));
            assert_eq!(checkout, SubmoduleCheckout::Unreadable, "{kind:?}");
            assert!(!reason.expect("a reason").trim().is_empty(), "{kind:?}");
        }
        let file = dir.path().join("file");
        std::fs::write(&file, "x").unwrap();
        let no_git = || panic!("a non-folder never looks for .git");
        assert_eq!(
            checkout_from_probe(std::fs::symlink_metadata(&file), no_git),
            (SubmoduleCheckout::Replaced, None)
        );
    }

    /// A staged `git mv` of the submodule: HEAD records the gitlink at the OLD path,
    /// so the staged side reads it there, never "the next commit adds this submodule".
    #[tokio::test]
    async fn changes_staged_rename_reads_head_gitlink_at_the_orig_path() {
        let (_dir, host, _dep) = host_with_submodule("changes-rename").await;
        let recorded = git(&sub_dir(&host), &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        git(&host, &["mv", "libs/dep", "libs/moved"]).await;
        let c = git_submodule_changes_core(&host, "libs/moved", true, Some("libs/dep"))
            .await
            .expect("submodule changes");
        assert_eq!(c.path, "libs/moved");
        assert_eq!(c.checkout, SubmoduleCheckout::Ok);
        assert_eq!(c.from_sha.as_deref(), Some(recorded.as_str()));
        assert_eq!(c.to_sha.as_deref(), Some(recorded.as_str()));
        // The control: without the old path, HEAD has no gitlink at the new one.
        let bare = git_submodule_changes_core(&host, "libs/moved", true, None)
            .await
            .expect("submodule changes");
        assert_eq!(bare.from_sha, None);
    }

    #[test]
    fn changes_probe_failures_other_than_not_found_are_unreadable() {
        use std::io::{Error, ErrorKind};
        let no_git = || panic!("a failed probe never looks for .git");
        assert_eq!(
            checkout_from_probe(Err(Error::from(ErrorKind::NotFound)), no_git),
            (SubmoduleCheckout::Missing, None)
        );
        for kind in [ErrorKind::PermissionDenied, ErrorKind::Other] {
            let (checkout, reason) = checkout_from_probe(Err(Error::from(kind)), no_git);
            assert_eq!(checkout, SubmoduleCheckout::Unreadable, "{kind:?}");
            assert!(!reason.expect("a reason").trim().is_empty(), "{kind:?}");
        }
    }

    #[test]
    fn changes_status_argv_skips_untracked_files_on_the_staged_side() {
        let staged = submodule_status_args(true);
        assert!(staged.contains(&"--untracked-files=no"));
        assert!(!staged.contains(&"--untracked-files=all"));
        let unstaged = submodule_status_args(false);
        assert!(unstaged.contains(&"--untracked-files=all"));
        assert!(!unstaged.contains(&"--untracked-files=no"));
    }

    #[tokio::test]
    async fn changes_unreadable_when_the_git_file_points_nowhere() {
        let (dir, host, _dep) = host_with_submodule("changes-unreadable").await;
        let sub = sub_dir(&host);
        let nowhere = dir
            .path()
            .join("nowhere")
            .to_string_lossy()
            .replace('\\', "/");
        std::fs::write(Path::new(&sub).join(".git"), format!("gitdir: {nowhere}\n")).unwrap();
        let c = changes(&host, false).await;
        assert_eq!(c.checkout, SubmoduleCheckout::Unreadable);
        let reason = c.reason.expect("a reason");
        assert!(!reason.trim().is_empty());
        assert_eq!(c.head, None);
        assert_eq!(c.branch, None);
        assert!(c.files.is_empty());
        assert!(c.from_sha.is_some());
        assert!(c.range_known);
    }

    #[test]
    fn changes_reason_helper_arms() {
        assert_eq!(unreadable_reason("", 128), "git exited with code 128");
        assert_eq!(unreadable_reason(" \n\t\n", 1), "git exited with code 1");
        assert_eq!(
            unreadable_reason("\n  fatal: not a git repository\nmore\n", 128),
            "fatal: not a git repository"
        );
        let long = "é".repeat(400);
        assert_eq!(unreadable_reason(&long, 1).chars().count(), 300);
        assert_eq!(
            nonempty_reason(String::new()),
            "git could not run in the submodule"
        );
        assert_eq!(nonempty_reason("timed out".into()), "timed out");
    }

    #[tokio::test]
    async fn changes_range_unknown_for_a_sha_the_submodule_lacks() {
        let (_dir, host, _dep) = host_with_submodule("changes-lacks").await;
        let missing = "3".repeat(40);
        stage_gitlink(&host, &missing).await;
        std::fs::write(Path::new(&sub_dir(&host)).join("new.txt"), "x\n").unwrap();
        let c = changes(&host, false).await;
        assert_eq!(c.checkout, SubmoduleCheckout::Ok);
        assert_eq!(c.from_sha.as_deref(), Some(missing.as_str()));
        assert!(c.to_sha.is_some());
        assert!(!c.range_known);
        assert!(c.ahead.is_empty() && c.behind.is_empty());
        assert_eq!((c.ahead_count, c.behind_count), (0, 0));
        // The checkout itself still answers.
        assert_eq!(c.files.len(), 1);
    }

    #[tokio::test]
    async fn changes_caps_files_and_counts_them_all() {
        let (_dir, host, _dep) = host_with_submodule("changes-cap").await;
        let sub = sub_dir(&host);
        for i in 0..101 {
            std::fs::write(Path::new(&sub).join(format!("f{i:03}.txt")), "x\n").unwrap();
        }
        let c = changes(&host, false).await;
        assert_eq!(c.files.len(), 100);
        assert_eq!(c.files_total, 101);
    }

    #[tokio::test]
    async fn changes_refuses_escaping_paths() {
        let dir = temp("changes-refuse");
        let repo = dir.path().to_string_lossy().into_owned();
        for bad in ["../x", "-x", "C:/x"] {
            let err = git_submodule_changes_core(&repo, bad, false, None).await;
            assert!(
                matches!(err, Err(AppError::InvalidArgument(_))),
                "{bad}: {err:?}"
            );
            let err = git_submodule_changes_core(&repo, "libs/dep", true, Some(bad)).await;
            assert!(
                matches!(err, Err(AppError::InvalidArgument(_))),
                "orig {bad}: {err:?}"
            );
        }
    }

    /// The frontend reads these sixteen keys verbatim, absent options as `null`.
    #[test]
    fn changes_wire_shape_is_camel_case_with_explicit_nulls() {
        let c = SubmoduleChanges {
            path: "libs/dep".into(),
            staged: false,
            checkout: SubmoduleCheckout::NotInitialized,
            reason: None,
            branch: None,
            detached: false,
            head: None,
            from_sha: None,
            to_sha: None,
            range_known: true,
            ahead: vec![SubmoduleCommit {
                sha: "a".into(),
                subject: "s".into(),
            }],
            ahead_count: 1,
            behind: Vec::new(),
            behind_count: 0,
            files: Vec::new(),
            files_total: 0,
        };
        let json = serde_json::to_value(&c).unwrap();
        let obj = json.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "ahead",
                "aheadCount",
                "behind",
                "behindCount",
                "branch",
                "checkout",
                "detached",
                "files",
                "filesTotal",
                "fromSha",
                "head",
                "path",
                "rangeKnown",
                "reason",
                "staged",
                "toSha",
            ]
        );
        for key in ["reason", "branch", "head", "fromSha", "toSha"] {
            assert!(obj[key].is_null(), "{key}");
        }
        assert_eq!(obj["checkout"], serde_json::json!("notInitialized"));
        assert_eq!(
            obj["ahead"],
            serde_json::json!([{ "sha": "a", "subject": "s" }])
        );
        let spelled = |checkout| {
            serde_json::to_value(SubmoduleChanges {
                checkout,
                ..c.clone()
            })
            .unwrap()["checkout"]
                .clone()
        };
        assert_eq!(spelled(SubmoduleCheckout::Ok), serde_json::json!("ok"));
        assert_eq!(
            spelled(SubmoduleCheckout::Missing),
            serde_json::json!("missing")
        );
        assert_eq!(
            spelled(SubmoduleCheckout::Replaced),
            serde_json::json!("replaced")
        );
        assert_eq!(
            spelled(SubmoduleCheckout::Unreadable),
            serde_json::json!("unreadable")
        );
    }

    /// A gitlink can exist with no `.gitmodules` section at all — the status rows
    /// must survive that, with the path standing in for the missing name.
    #[tokio::test]
    async fn gitlink_without_gitmodules_entry_falls_back_to_path() {
        let (dir, host, _dep) = host_with_submodule("orphan").await;
        std::fs::remove_file(dir.path().join("host").join(".gitmodules")).unwrap();
        let subs = list_submodules(&host).await.unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].name, "libs/dep");
        assert_eq!(subs[0].url, "");
        assert_eq!(subs[0].branch, None);
    }

    /// host → mid → leaf: the leaf only materializes when the update recurses.
    #[tokio::test]
    async fn update_initializes_nested_submodules() {
        allow_file_submodules();
        let dir = temp("nested");
        let root = dir.path();
        seed_repo(root, "leaf").await;
        let mid = seed_repo(root, "mid").await;
        let host = seed_repo(root, "host").await;
        let state = AppState::default();
        git_submodule_add_core(
            &state,
            mid.clone(),
            "../leaf".into(),
            Some("deep/leaf".into()),
            None,
        )
        .await
        .unwrap();
        git(&mid, &["commit", "-qm", "add leaf"]).await;
        git_submodule_add_core(
            &state,
            host.clone(),
            "../mid".into(),
            Some("libs/mid".into()),
            None,
        )
        .await
        .unwrap();
        git(&host, &["commit", "-qm", "add mid"]).await;

        let clone = clone_repo_core(&host, &root.to_string_lossy(), Some("c1".into()), false, &[])
            .await
            .unwrap();
        assert!(!exists(&clone, "libs/mid/mid.txt"), "clone starts empty");

        git_submodule_update_core(&state, clone.clone(), None, false)
            .await
            .unwrap();
        assert!(exists(&clone, "libs/mid/mid.txt"));
        assert!(
            exists(&clone, "libs/mid/deep/leaf/leaf.txt"),
            "the nested leaf only appears with --recursive"
        );
    }

    /// `--remote` moves the submodule to its configured branch's tip instead of
    /// the commit the parent recorded.
    #[tokio::test]
    async fn update_remote_tracks_the_configured_branch() {
        let (dir, host, dep) = host_with_submodule("remote").await;
        let state = AppState::default();
        std::fs::write(dir.path().join("dep").join("dep.txt"), "v1\n").unwrap();
        git(&dep, &["add", "-A"]).await;
        git(&dep, &["commit", "-qm", "v1"]).await;
        let tip = git(&dep, &["rev-parse", "HEAD"]).await.trim().to_string();

        git_submodule_update_core(&state, host.clone(), None, true)
            .await
            .unwrap();
        let subs = list_submodules(&host).await.unwrap();
        assert_eq!(subs[0].sha, tip, "submodule follows the branch tip");
        assert_eq!(subs[0].status, "modified", "the parent's gitlink is stale");
    }

    #[tokio::test]
    async fn add_stages_gitmodules_and_the_gitlink() {
        allow_file_submodules();
        let dir = temp("add");
        seed_repo(dir.path(), "dep").await;
        let host = seed_repo(dir.path(), "host").await;
        git_submodule_add_core(
            &AppState::default(),
            host.clone(),
            "../dep".into(),
            Some("libs/dep".into()),
            Some("main".into()),
        )
        .await
        .unwrap();

        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("A  .gitmodules"), "status: {status}");
        assert!(status.contains("A  libs/dep"), "status: {status}");
        assert!(exists(&host, "libs/dep/dep.txt"), "the clone materialized");
        let subs = list_submodules(&host).await.unwrap();
        assert_eq!(subs[0].branch.as_deref(), Some("main"));
    }

    #[tokio::test]
    async fn remove_stages_the_deletion_and_keeps_module_data() {
        let (_dir, host, _dep) = host_with_submodule("rm").await;
        let outcome = git_submodule_remove_core(
            &AppState::default(),
            host.clone(),
            "libs/dep".into(),
            false,
            false,
        )
        .await
        .unwrap();
        assert!(!outcome.refused_dirty);
        assert!(!outcome.module_data_deleted);
        assert_eq!(outcome.module_data_error, None);

        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("M  .gitmodules"), "status: {status}");
        assert!(status.contains("D  libs/dep"), "status: {status}");
        // deinit-first, or `submodule.<name>.*` is orphaned in `.git/config`.
        let cfg = run_git_raw(
            Some(&host),
            &["config", "--get-regexp", r"^submodule\."],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_eq!(cfg.code, 1, "no submodule config left: {}", cfg.stdout_lossy());
        assert!(exists(&host, ".git/modules/libs/dep"), "module data survives");
    }

    /// git refuses `deinit` on a submodule whose HEAD has moved off the recorded
    /// commit even with a spotless worktree, so the `+` status row is part of the
    /// dirty verdict — the worktree probe alone sees nothing.
    #[tokio::test]
    async fn remove_refuses_a_submodule_whose_head_moved() {
        let (dir, host, dep) = host_with_submodule("moved").await;
        let state = AppState::default();
        std::fs::write(dir.path().join("dep").join("dep.txt"), "v1\n").unwrap();
        git(&dep, &["add", "-A"]).await;
        git(&dep, &["commit", "-qm", "v1"]).await;
        git_submodule_update_core(&state, host.clone(), None, true)
            .await
            .unwrap();
        assert_eq!(list_submodules(&host).await.unwrap()[0].status, "modified");
        // The child's own worktree is spotless — only the recorded commit differs.
        let child = dir.path().join("host/libs/dep").to_string_lossy().into_owned();
        assert_eq!(git(&child, &["status", "--porcelain"]).await, "");

        let before = git(&host, &["status", "--porcelain"]).await;
        let outcome =
            git_submodule_remove_core(&state, host.clone(), "libs/dep".into(), false, true)
                .await
                .unwrap();
        assert!(outcome.refused_dirty);
        assert!(!outcome.module_data_deleted);
        assert_eq!(git(&host, &["status", "--porcelain"]).await, before);
        assert!(exists(&host, "libs/dep/dep.txt"), "worktree untouched");
        assert!(exists(&host, ".git/modules/libs/dep"), "module data untouched");

        let forced = git_submodule_remove_core(&state, host.clone(), "libs/dep".into(), true, false)
            .await
            .unwrap();
        assert!(!forced.refused_dirty);
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("D  libs/dep"), "status: {status}");
    }

    /// `git rm` on a submodule fails while `.gitmodules` is unstaged — and
    /// `deinit -f` succeeds first, so without this pre-check the force path clears
    /// the worktree and then strands it with nothing staged.
    #[tokio::test]
    async fn remove_refuses_unstaged_gitmodules() {
        let (dir, host, _dep) = host_with_submodule("rm-unstaged").await;
        let gitmodules = dir.path().join("host/.gitmodules");
        let original = std::fs::read_to_string(&gitmodules).unwrap();
        std::fs::write(&gitmodules, format!("{original}\n[core]\n\tjunk = 1\n")).unwrap();
        let before = git(&host, &["status", "--porcelain"]).await;

        let err =
            git_submodule_remove_core(&AppState::default(), host.clone(), "libs/dep".into(), true, true)
                .await
                .expect_err("unstaged .gitmodules must be refused");
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        assert_eq!(git(&host, &["status", "--porcelain"]).await, before);
        assert!(exists(&host, "libs/dep/dep.txt"), "worktree not cleared");
    }

    /// `git submodule add` stages the WHOLE worktree `.gitmodules`, so without the
    /// pre-check a user's unrelated unstaged edit lands in the index alongside the
    /// new submodule (measured, git 2.51.1).
    #[tokio::test]
    async fn add_refuses_unstaged_gitmodules() {
        let (dir, host, _dep) = host_with_submodule("add-unstaged").await;
        seed_repo(dir.path(), "dep2").await;
        let gitmodules = dir.path().join("host/.gitmodules");
        let original = std::fs::read_to_string(&gitmodules).unwrap();
        std::fs::write(&gitmodules, format!("{original}\n[core]\n\tjunk = 1\n")).unwrap();

        let err = git_submodule_add_core(
            &AppState::default(),
            host.clone(),
            "../dep2".into(),
            Some("libs/dep2".into()),
            None,
        )
        .await
        .expect_err("unstaged .gitmodules must be refused");
        // Pins the arm, not just the variant: the two messages differ deliberately.
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("Unstaged changes")),
            "got {err:?}"
        );
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains(" M .gitmodules"), "still unstaged: {status}");
        assert!(!exists(&host, "libs/dep2"), "nothing was cloned");
    }

    /// Adding a submodule mid-merge would bury a new gitlink in an index the user is
    /// still resolving.
    #[tokio::test]
    async fn add_refuses_mid_merge() {
        let (dir, host, _dep) = host_with_submodule("add-midop").await;
        seed_repo(dir.path(), "dep2").await;
        // A bare MERGE_HEAD is what `op_state` reads; a real conflicted merge would
        // also leave unmerged index entries, which the same gate refuses first.
        let head = git(&host, &["rev-parse", "HEAD"]).await.trim().to_string();
        std::fs::write(dir.path().join("host/.git/MERGE_HEAD"), format!("{head}\n")).unwrap();
        let before = git(&host, &["status", "--porcelain"]).await;

        let err = git_submodule_add_core(
            &AppState::default(),
            host.clone(),
            "../dep2".into(),
            Some("libs/dep2".into()),
            None,
        )
        .await
        .expect_err("a mid-merge add must be refused");
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        assert!(!exists(&host, "libs/dep2"), "nothing was cloned");
        assert_eq!(git(&host, &["status", "--porcelain"]).await, before);
    }

    /// An UNTRACKED `.gitmodules` has no index entry, so `git diff` reads it as
    /// clean while `submodule add` stages its pre-existing content along with the
    /// new section — the arm a diff-based probe cannot see.
    #[tokio::test]
    async fn add_refuses_untracked_gitmodules() {
        allow_file_submodules();
        let dir = temp("add-untracked");
        seed_repo(dir.path(), "dep").await;
        let host = seed_repo(dir.path(), "host").await;
        let gitmodules = dir.path().join("host/.gitmodules");
        let sentinel = "[core]\n\tjunk = 1\n";
        std::fs::write(&gitmodules, sentinel).unwrap();
        assert!(
            git(&host, &["status", "--porcelain"]).await.contains("?? .gitmodules"),
            "fixture must start untracked"
        );

        let err = git_submodule_add_core(
            &AppState::default(),
            host.clone(),
            "../dep".into(),
            Some("libs/dep".into()),
            None,
        )
        .await
        .expect_err("an untracked .gitmodules must be refused");
        // The untracked arm must not collapse into the unstaged one: "discard" is
        // wrong advice for a file git isn't tracking.
        assert!(
            matches!(&err, AppError::InvalidArgument(m) if m.contains("isn't tracked")),
            "got {err:?}"
        );
        assert!(!exists(&host, "libs/dep"), "nothing was cloned");
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("?? .gitmodules"), "still untracked: {status}");
        assert_eq!(
            std::fs::read_to_string(&gitmodules).unwrap(),
            sentinel,
            "content byte-identical"
        );
    }

    /// The allow side: staged-only means worktree == index, which is exactly what
    /// git's own staging check accepts — the guard must not refuse it.
    #[tokio::test]
    async fn writers_accept_a_staged_only_gitmodules() {
        let (dir, host, _dep) = host_with_submodule("staged-only").await;
        let gitmodules = dir.path().join("host/.gitmodules");
        let original = std::fs::read_to_string(&gitmodules).unwrap();
        std::fs::write(&gitmodules, format!("{original}\n[core]\n\tjunk = 1\n")).unwrap();
        git(&host, &["add", "--", ".gitmodules"]).await;
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("M  .gitmodules"), "fixture staged-only: {status}");

        git_submodule_set_branch_core(
            &AppState::default(),
            host.clone(),
            "libs/dep".into(),
            Some("release".into()),
        )
        .await
        .expect("staged-only .gitmodules must be accepted");
        assert_eq!(
            list_submodules(&host).await.unwrap()[0].branch.as_deref(),
            Some("release")
        );
    }

    /// The fourth `.gitmodules` writer gets the same guard as add/remove/set_url.
    #[tokio::test]
    async fn set_branch_refuses_unstaged_gitmodules() {
        let (dir, host, _dep) = host_with_submodule("branch-unstaged").await;
        let gitmodules = dir.path().join("host/.gitmodules");
        let original = std::fs::read_to_string(&gitmodules).unwrap();
        std::fs::write(&gitmodules, format!("{original}\n[core]\n\tjunk = 1\n")).unwrap();

        let err = git_submodule_set_branch_core(
            &AppState::default(),
            host.clone(),
            "libs/dep".into(),
            Some("release".into()),
        )
        .await
        .expect_err("unstaged .gitmodules must be refused");
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains(" M .gitmodules"), "still unstaged: {status}");
        assert_eq!(
            list_submodules(&host).await.unwrap()[0].branch.as_deref(),
            Some("main"),
            "the branch is unchanged"
        );
    }

    /// Without the pre-check, `stage_gitmodules` would sweep the user's unrelated
    /// unstaged `.gitmodules` edit into the index alongside the URL change.
    #[tokio::test]
    async fn set_url_refuses_unstaged_gitmodules() {
        let (dir, host, _dep) = host_with_submodule("url-unstaged").await;
        let gitmodules = dir.path().join("host/.gitmodules");
        let original = std::fs::read_to_string(&gitmodules).unwrap();
        std::fs::write(&gitmodules, format!("{original}\n[core]\n\tjunk = 1\n")).unwrap();

        let err = git_submodule_set_url_core(
            &AppState::default(),
            host.clone(),
            "libs/dep".into(),
            "../dep-moved".into(),
        )
        .await
        .expect_err("unstaged .gitmodules must be refused");
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains(" M .gitmodules"), "still unstaged: {status}");
        assert_eq!(list_submodules(&host).await.unwrap()[0].url, "../dep");
    }

    /// `--remote --recursive` applies `--remote` at every depth, dragging nested
    /// submodules to their OWN remote tips. Only the targeted level follows its
    /// branch; its children settle on what it now records.
    #[tokio::test]
    async fn remote_update_does_not_drag_nested_submodules_to_their_tips() {
        allow_file_submodules();
        let dir = temp("remote-nested");
        let root = dir.path();
        let leaf = seed_repo(root, "leaf").await;
        let mid = seed_repo(root, "mid").await;
        let host = seed_repo(root, "host").await;
        let state = AppState::default();
        git_submodule_add_core(&state, mid.clone(), "../leaf".into(), Some("deep/leaf".into()), None)
            .await
            .unwrap();
        git(&mid, &["commit", "-qm", "add leaf"]).await;
        git_submodule_add_core(
            &state,
            host.clone(),
            "../mid".into(),
            Some("libs/mid".into()),
            Some("main".into()),
        )
        .await
        .unwrap();
        git(&host, &["commit", "-qm", "add mid"]).await;

        // The leaf tip moves; mid's RECORDED leaf commit deliberately does not.
        let recorded_leaf = git(&mid, &["rev-parse", "HEAD:deep/leaf"]).await.trim().to_string();
        std::fs::write(root.join("leaf/leaf.txt"), "v1\n").unwrap();
        git(&leaf, &["add", "-A"]).await;
        git(&leaf, &["commit", "-qm", "v1"]).await;
        let leaf_tip = git(&leaf, &["rev-parse", "HEAD"]).await.trim().to_string();
        assert_ne!(recorded_leaf, leaf_tip);
        std::fs::write(root.join("mid/mid.txt"), "v1\n").unwrap();
        git(&mid, &["add", "-A"]).await;
        git(&mid, &["commit", "-qm", "v1"]).await;
        let mid_tip = git(&mid, &["rev-parse", "HEAD"]).await.trim().to_string();

        // Both arms of the remote update: one targeted path, and all submodules.
        for (name, target) in [
            ("targeted", Some("libs/mid".to_string())),
            ("all", None),
        ] {
            let clone = clone_repo_core(&host, &root.to_string_lossy(), Some(name.into()), false, &[])
                .await
                .unwrap();
            git_submodule_update_core(&state, clone.clone(), target, true)
                .await
                .unwrap();
            let child = Path::new(&clone).join("libs/mid").to_string_lossy().into_owned();
            assert_eq!(
                git(&child, &["rev-parse", "HEAD"]).await.trim(),
                mid_tip,
                "{name}: the targeted submodule follows its branch"
            );
            let nested = Path::new(&clone)
                .join("libs/mid/deep/leaf")
                .to_string_lossy()
                .into_owned();
            assert_eq!(
                git(&nested, &["rev-parse", "HEAD"]).await.trim(),
                recorded_leaf,
                "{name}: the nested leaf settles on what mid records, not its own tip"
            );
        }
    }

    /// `git submodule deinit` exits 0 on a path that is not a submodule, so
    /// without the lookup guard the `git rm` behind it would stage a regular
    /// file's deletion.
    #[tokio::test]
    async fn remove_refuses_a_path_that_is_not_a_submodule() {
        let (dir, host, _dep) = host_with_submodule("notsub").await;
        std::fs::write(dir.path().join("host/regular.txt"), "keep\n").unwrap();
        git(&host, &["add", "-A"]).await;
        git(&host, &["commit", "-qm", "regular"]).await;

        let err = git_submodule_remove_core(
            &AppState::default(),
            host.clone(),
            "regular.txt".into(),
            false,
            true,
        )
        .await
        .expect_err("a non-submodule path must be refused");
        assert!(matches!(err, AppError::InvalidArgument(_)), "got {err:?}");
        assert!(exists(&host, "regular.txt"), "the file survives");
        assert_eq!(git(&host, &["status", "--porcelain"]).await, "");
    }

    #[tokio::test]
    async fn remove_deletes_module_data_when_requested() {
        let (_dir, host, _dep) = host_with_submodule("rm-data").await;
        // Pins that the data really is read-only, which is what makes the plain
        // `fs::remove_dir_all` below a claim worth testing: std clears the attribute
        // itself on rustc 1.91.1/Windows (measured).
        let objects = Path::new(&host).join(".git/modules/libs/dep/objects");
        assert!(
            readonly_file_under(&objects),
            "fixture must contain a read-only object file"
        );

        let outcome = git_submodule_remove_core(
            &AppState::default(),
            host.clone(),
            "libs/dep".into(),
            false,
            true,
        )
        .await
        .unwrap();
        assert_eq!(outcome.module_data_error, None);
        assert!(outcome.module_data_deleted);
        assert!(!exists(&host, ".git/modules/libs/dep"));
    }

    fn readonly_file_under(dir: &Path) -> bool {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let found = if path.is_dir() {
                readonly_file_under(&path)
            } else {
                std::fs::metadata(&path).is_ok_and(|m| m.permissions().readonly())
            };
            if found {
                return true;
            }
        }
        false
    }

    #[tokio::test]
    async fn remove_refuses_a_dirty_submodule_and_mutates_nothing() {
        let (dir, host, _dep) = host_with_submodule("dirty").await;
        std::fs::write(dir.path().join("host/libs/dep/dep.txt"), "dirty\n").unwrap();
        let before = git(&host, &["status", "--porcelain"]).await;

        let outcome = git_submodule_remove_core(
            &AppState::default(),
            host.clone(),
            "libs/dep".into(),
            false,
            true,
        )
        .await
        .unwrap();
        assert!(outcome.refused_dirty);
        assert!(!outcome.module_data_deleted);
        assert_eq!(outcome.module_data_error, None);

        assert_eq!(git(&host, &["status", "--porcelain"]).await, before);
        assert!(exists(&host, "libs/dep/dep.txt"), "worktree untouched");
        assert!(exists(&host, ".git/modules/libs/dep"), "module data untouched");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("host/libs/dep/dep.txt")).unwrap(),
            "dirty\n"
        );
    }

    /// git counts untracked files as "local modifications" for deinit, but
    /// `status.showUntrackedFiles=no` hides them from the probe — the config lives in
    /// the SUBMODULE's own repo here, so the fixture stays hermetic.
    #[tokio::test]
    async fn remove_refuses_a_submodule_dirty_only_with_untracked_files() {
        let (dir, host, _dep) = host_with_submodule("untracked-dirty").await;
        let child = dir.path().join("host/libs/dep").to_string_lossy().into_owned();
        git(&child, &["config", "status.showUntrackedFiles", "no"]).await;
        std::fs::write(dir.path().join("host/libs/dep/scratch.txt"), "sentinel\n").unwrap();
        assert_eq!(
            git(&child, &["status", "--porcelain"]).await,
            "",
            "the config must hide it from an unflagged probe, or this proves nothing"
        );
        let before = git(&host, &["status", "--porcelain"]).await;

        let outcome =
            git_submodule_remove_core(&AppState::default(), host.clone(), "libs/dep".into(), false, true)
                .await
                .unwrap();
        assert!(outcome.refused_dirty);
        assert!(!outcome.module_data_deleted);
        assert_eq!(git(&host, &["status", "--porcelain"]).await, before);
        assert!(exists(&host, "libs/dep/scratch.txt"), "untracked file survives");
        assert!(exists(&host, ".git/modules/libs/dep"), "module data untouched");
    }

    #[tokio::test]
    async fn remove_force_discards_a_dirty_submodule() {
        let (dir, host, _dep) = host_with_submodule("force").await;
        std::fs::write(dir.path().join("host/libs/dep/dep.txt"), "dirty\n").unwrap();

        let outcome = git_submodule_remove_core(
            &AppState::default(),
            host.clone(),
            "libs/dep".into(),
            true,
            false,
        )
        .await
        .unwrap();
        assert!(!outcome.refused_dirty);
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("D  libs/dep"), "status: {status}");
        assert!(!exists(&host, "libs/dep/dep.txt"));
    }

    #[tokio::test]
    async fn set_url_stages_gitmodules_and_syncs_git_config() {
        let (_dir, host, _dep) = host_with_submodule("seturl").await;
        git_submodule_set_url_core(
            &AppState::default(),
            host.clone(),
            "libs/dep".into(),
            "../dep-moved".into(),
        )
        .await
        .unwrap();

        let subs = list_submodules(&host).await.unwrap();
        assert_eq!(subs[0].url, "../dep-moved");
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("M  .gitmodules"), "staged, got: {status}");
        let synced = git(&host, &["config", "--get", "submodule.libs/dep.url"]).await;
        assert!(
            synced.trim().ends_with("dep-moved"),
            ".git/config synced: {synced}"
        );
    }

    #[tokio::test]
    async fn set_branch_sets_and_clears_the_tracked_branch() {
        let (_dir, host, _dep) = host_with_submodule("setbranch").await;
        let state = AppState::default();
        git_submodule_set_branch_core(
            &state,
            host.clone(),
            "libs/dep".into(),
            Some("release".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            list_submodules(&host).await.unwrap()[0].branch.as_deref(),
            Some("release")
        );
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("M  .gitmodules"), "staged, got: {status}");

        git_submodule_set_branch_core(&state, host.clone(), "libs/dep".into(), None)
            .await
            .unwrap();
        assert_eq!(list_submodules(&host).await.unwrap()[0].branch, None);
    }

    async fn submodule_config(repo: &str) -> String {
        submodule_registrations(repo).await.unwrap()
    }

    /// The canary the submodule repairs rest on (git 2.51.1): `update --init` dies at
    /// registration having cloned nothing, and once registered writes nothing here;
    /// `set-url` dies at its sync with `.gitmodules` already rewritten, while a lost
    /// `.gitmodules.lock` matches the same lock text with nothing written; `deinit` and
    /// `add` exit 0, having cleared or cloned, with the config write silently lost.
    #[tokio::test]
    async fn git_loses_each_submodule_config_write_at_a_measured_point() {
        let (dir, host, _dep) = host_with_submodule("cfg-shapes").await;
        let root = dir.path().to_string_lossy().into_owned();
        let clone = clone_repo_core(&host, &root, Some("c".into()), false, &[])
            .await
            .unwrap();
        let raw = |repo: &str, args: &[&str]| {
            let (repo, args) = (repo.to_string(), args.iter().map(|a| a.to_string()));
            let args: Vec<String> = args.collect();
            async move {
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                run_git_raw(Some(&repo), &args, NETWORK_TIMEOUT)
                    .await
                    .unwrap()
            }
        };
        let spec = crate::git::pathspec::literal("libs/dep");

        let lock = hold_config_lock(&clone);
        let out = raw(&clone, &["submodule", "update", "--init", "--", &spec]).await;
        assert_eq!(out.code, 128, "{}", out.stderr);
        assert!(is_config_lock_contention(&out.stderr), "{}", out.stderr);
        assert!(!exists(&clone, "libs/dep/dep.txt"), "nothing cloned");
        assert_eq!(submodule_config(&clone).await, "", "nothing registered");
        std::fs::remove_file(&lock).unwrap();
        raw(&clone, &["submodule", "init", "--", &spec]).await;
        let lock = hold_config_lock(&clone);
        let out = raw(&clone, &["submodule", "update", "--init", "--", &spec]).await;
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(
            out.code, 0,
            "registered, it writes nothing here: {}",
            out.stderr
        );
        assert!(exists(&clone, "libs/dep/dep.txt"));

        let registered = submodule_config(&host).await;
        let lock = hold_config_lock(&host);
        let out = raw(
            &host,
            &["submodule", "set-url", "--", "libs/dep", "../dep-moved"],
        )
        .await;
        assert_eq!(out.code, 128, "{}", out.stderr);
        assert!(is_config_lock_contention(&out.stderr), "{}", out.stderr);
        assert_eq!(
            gitmodules_entries(&host).await["libs/dep"].url,
            "../dep-moved"
        );
        assert_eq!(submodule_config(&host).await, registered, "not synced");
        std::fs::remove_file(&lock).unwrap();
        git(&host, &["checkout", "--", ".gitmodules"]).await;
        // A lost `.gitmodules.lock` reads as the same lock text but writes nothing.
        let gitmodules_lock = Path::new(&host).join(".gitmodules.lock");
        std::fs::write(&gitmodules_lock, b"").unwrap();
        let out = raw(
            &host,
            &["submodule", "set-url", "--", "libs/dep", "../dep-moved"],
        )
        .await;
        std::fs::remove_file(&gitmodules_lock).unwrap();
        assert_eq!(out.code, 1, "{}", out.stderr);
        assert!(is_config_lock_contention(&out.stderr), "{}", out.stderr);
        assert_eq!(gitmodules_entries(&host).await["libs/dep"].url, "../dep");
        assert_eq!(submodule_config(&host).await, registered, "not synced");

        let lock = hold_config_lock(&host);
        let out = raw(&host, &["submodule", "deinit", "--", &spec]).await;
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert!(is_config_lock_contention(&out.stderr), "{}", out.stderr);
        assert!(
            !exists(&host, "libs/dep/dep.txt"),
            "the worktree was cleared"
        );
        assert_eq!(
            submodule_config(&host).await,
            registered,
            "the section stays"
        );

        seed_repo(dir.path(), "dep2").await;
        let out = raw(&host, &["submodule", "add", "--", "../dep2", "libs/dep2"]).await;
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert!(is_config_lock_contention(&out.stderr), "{}", out.stderr);
        assert!(exists(&host, "libs/dep2/dep2.txt"), "cloned");
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("A  libs/dep2"), "staged: {status}");
        assert!(
            !submodule_config(&host).await.contains("libs/dep2"),
            "but unregistered"
        );
    }

    /// An update that loses the registration, in both arms, still clones and registers
    /// what an uncontended twin does, and the clone runs only after the mutex is
    /// freed; the twin never takes the mutex at all.
    #[tokio::test]
    async fn an_update_that_loses_the_config_lock_still_clones() {
        use crate::git::runner::{
            release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK, CONFIG_WRITE_LOCK_EVENTS,
        };
        let (dir, host, _dep) = host_with_submodule("cfg-update").await;
        let root = dir.path().to_string_lossy().into_owned();
        let state = AppState::default();
        let mut registered = Vec::new();
        for (name, contended, remote) in [
            ("twin", false, false),
            ("lost", true, false),
            ("lost-remote", true, true),
        ] {
            let clone = clone_repo_core(&host, &root, Some(name.into()), false, &[])
                .await
                .unwrap();
            let lock = Path::new(&clone).join(".git").join("config.lock");
            let (hook, attempts) = if contended {
                release_config_lock_before_attempt(hold_config_lock(&clone), 2)
            } else {
                release_config_lock_before_attempt(lock, usize::MAX)
            };
            let probe = Path::new(&clone).join("libs/dep/dep.txt");
            let (events, log) = lock_events(move || probe.exists());
            let update =
                git_submodule_update_core(&state, clone.clone(), Some("libs/dep".into()), remote);
            CONFIG_WRITE_LOCK_EVENTS
                .scope(events, CONFIG_WRITE_ATTEMPT_HOOK.scope(hook, update))
                .await
                .expect("the update succeeds");
            assert!(exists(&clone, "libs/dep/dep.txt"), "{name}: cloned");
            registered.push(submodule_config(&clone).await);
            let attempts = attempts.load(std::sync::atomic::Ordering::SeqCst);
            if contended {
                assert_eq!(attempts, 2);
                assert_eq!(
                    *log.lock().unwrap(),
                    [("waiting", false), ("acquired", false), ("freed", false)],
                    "the clone came after the hold"
                );
            } else {
                assert_eq!(attempts, 0);
                assert!(log.lock().unwrap().is_empty(), "no mutex uncontended");
            }
        }
        assert!(
            registered[0].contains("submodule.libs/dep.url "),
            "{registered:?}"
        );
        assert_eq!(registered[0], registered[1], "what git itself registers");
        assert_eq!(registered[0], registered[2], "what git itself registers");
    }

    /// An add whose registration is lost ends registered like an uncontended twin
    /// add, the inferred path included; the clone ran before the mutex was requested.
    #[tokio::test]
    async fn an_add_that_loses_the_config_lock_still_registers() {
        use crate::git::runner::{
            release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK, CONFIG_WRITE_LOCK_EVENTS,
        };
        let (dir, host, _dep) = host_with_submodule("cfg-add").await;
        seed_repo(dir.path(), "dep2").await;
        let state = AppState::default();
        git_submodule_add_core(
            &state,
            host.clone(),
            "../dep2".into(),
            Some("libs/twin".into()),
            None,
        )
        .await
        .expect("the twin add succeeds");

        let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&host), 2);
        let probe = Path::new(&host).join("dep2/dep2.txt");
        let (events, log) = lock_events(move || probe.exists());
        let add = git_submodule_add_core(&state, host.clone(), "../dep2".into(), None, None);
        CONFIG_WRITE_LOCK_EVENTS
            .scope(events, CONFIG_WRITE_ATTEMPT_HOOK.scope(hook, add))
            .await
            .expect("the add succeeds");
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 2);
        assert_eq!(
            *log.lock().unwrap(),
            [("waiting", true), ("acquired", true), ("freed", true)],
            "the clone came before the hold"
        );
        let get = |key: &'static str| {
            let host = host.clone();
            async move {
                git(&host, &["config", "--get", key])
                    .await
                    .trim()
                    .to_string()
            }
        };
        assert_eq!(
            get("submodule.dep2.url").await,
            get("submodule.libs/twin.url").await
        );
        assert_eq!(get("submodule.dep2.active").await, "true");
        assert_eq!(get("submodule.libs/twin.active").await, "true");
        let subs = list_submodules(&host).await.unwrap();
        let added = subs.iter().find(|s| s.path == "dep2").expect("listed");
        assert_eq!(added.status, "ok", "initialized, not '-'");
    }

    /// A removal whose deinit loses the section removal still leaves no
    /// `submodule.<name>` behind; the worktree was cleared before the mutex was
    /// requested. A set-url whose sync loses still syncs both configs.
    #[tokio::test]
    async fn a_remove_or_set_url_that_loses_the_config_lock_still_lands() {
        use crate::git::runner::{
            release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK, CONFIG_WRITE_LOCK_EVENTS,
        };
        use std::sync::atomic::Ordering;
        let state = AppState::default();

        let (_dir, host, _dep) = host_with_submodule("cfg-seturl").await;
        let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&host), 2);
        let set = git_submodule_set_url_core(
            &state,
            host.clone(),
            "libs/dep".into(),
            "../dep-moved".into(),
        );
        CONFIG_WRITE_ATTEMPT_HOOK
            .scope(hook, set)
            .await
            .expect("the set-url succeeds");
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        let synced = git(&host, &["config", "--get", "submodule.libs/dep.url"]).await;
        assert!(synced.trim().ends_with("dep-moved"), "{synced}");
        let child = Path::new(&host)
            .join("libs/dep")
            .to_string_lossy()
            .into_owned();
        let remote = git(&child, &["config", "--get", "remote.origin.url"]).await;
        assert!(remote.trim().ends_with("dep-moved"), "{remote}");
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("M  .gitmodules"), "staged: {status}");

        let (_dir, host, _dep) = host_with_submodule("cfg-remove").await;
        let (hook, attempts) = release_config_lock_before_attempt(hold_config_lock(&host), 2);
        let probe = Path::new(&host).join("libs/dep/dep.txt");
        let (events, log) = lock_events(move || probe.exists());
        let remove =
            git_submodule_remove_core(&state, host.clone(), "libs/dep".into(), false, false);
        let outcome = CONFIG_WRITE_LOCK_EVENTS
            .scope(events, CONFIG_WRITE_ATTEMPT_HOOK.scope(hook, remove))
            .await
            .expect("the removal succeeds");
        assert!(!outcome.refused_dirty);
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
        assert_eq!(
            *log.lock().unwrap(),
            [("waiting", false), ("acquired", false), ("freed", false)],
            "the clear came before the hold"
        );
        assert_eq!(submodule_config(&host).await, "", "no orphaned section");
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("D  libs/dep"), "status: {status}");
    }

    /// A set-url that loses `.gitmodules.lock` changed nothing, so it never reaches the
    /// sync repair, which would re-sync the old URL and report success.
    #[tokio::test]
    async fn a_set_url_that_loses_the_gitmodules_lock_reports_it() {
        use crate::git::runner::{release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK};
        let (_dir, host, _dep) = host_with_submodule("gitmodules-lock").await;
        let registered = submodule_config(&host).await;
        let lock = Path::new(&host).join(".gitmodules.lock");
        std::fs::write(&lock, b"").unwrap();
        // Counts held attempts without deleting anything.
        let (hook, attempts) = release_config_lock_before_attempt(lock.clone(), usize::MAX);
        let state = AppState::default();
        let set = git_submodule_set_url_core(
            &state,
            host.clone(),
            "libs/dep".into(),
            "../dep-moved".into(),
        );
        let result = CONFIG_WRITE_ATTEMPT_HOOK.scope(hook, set).await;
        std::fs::remove_file(&lock).unwrap();
        assert!(
            matches!(&result, Err(AppError::Git { stderr, .. }) if stderr.contains(".gitmodules")),
            "{result:?}"
        );
        assert_eq!(
            attempts.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "no sync"
        );
        assert_eq!(gitmodules_entries(&host).await["libs/dep"].url, "../dep");
        assert_eq!(submodule_config(&host).await, registered);
    }

    /// A lost lock in a CHILD's config matches the same lock text after the module was
    /// cloned, and registers nothing in the parent, so git's error stands and the
    /// update is not re-run: released after the parent's registration attempt, the
    /// child lock would otherwise let that re-run succeed.
    #[tokio::test]
    async fn an_update_that_loses_a_childs_config_lock_keeps_gits_error() {
        use crate::git::runner::{release_config_lock_before_attempt, CONFIG_WRITE_ATTEMPT_HOOK};
        allow_file_submodules();
        let dir = temp("child-lock");
        let root = dir.path();
        seed_repo(root, "leaf").await;
        let mid = seed_repo(root, "mid").await;
        let host = seed_repo(root, "host").await;
        let state = AppState::default();
        git_submodule_add_core(
            &state,
            mid.clone(),
            "../leaf".into(),
            Some("deep/leaf".into()),
            None,
        )
        .await
        .unwrap();
        git(&mid, &["commit", "-qm", "add leaf"]).await;
        git_submodule_add_core(
            &state,
            host.clone(),
            "../mid".into(),
            Some("libs/mid".into()),
            None,
        )
        .await
        .unwrap();
        git(&host, &["commit", "-qm", "add mid"]).await;
        let clone = clone_repo_core(&host, &root.to_string_lossy(), Some("c".into()), false, &[])
            .await
            .unwrap();
        git(&clone, &["submodule", "update", "--init", "--", "libs/mid"]).await;
        let registered = submodule_config(&clone).await;

        let child_lock = Path::new(&clone).join(".git/modules/libs/mid/config.lock");
        std::fs::write(&child_lock, b"").unwrap();
        let (hook, attempts) = release_config_lock_before_attempt(child_lock.clone(), 1);
        let update = git_submodule_update_core(&state, clone.clone(), None, false);
        let result = CONFIG_WRITE_ATTEMPT_HOOK.scope(hook, update).await;
        let _ = std::fs::remove_file(&child_lock);
        assert!(
            matches!(&result, Err(AppError::Git { stderr, .. }) if is_config_lock_contention(stderr)),
            "{result:?}"
        );
        assert_eq!(attempts.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(submodule_config(&clone).await, registered);
        assert!(!exists(&clone, "libs/mid/deep/leaf/leaf.txt"), "not re-run");
    }

    /// A lock held through every retry fails each writer with what landed and the next
    /// step, never git's lock-file text nor a success over the partial state git left;
    /// the add's and the removal's advised next steps then finish cleanly.
    #[tokio::test]
    async fn submodule_writers_whose_repair_also_loses_say_what_landed() {
        let (dir, host, _dep) = host_with_submodule("cfg-held").await;
        let root = dir.path().to_string_lossy().into_owned();
        let clone = clone_repo_core(&host, &root, Some("c".into()), false, &[])
            .await
            .unwrap();
        seed_repo(dir.path(), "dep2").await;
        let state = AppState::default();
        let busy = |result: AppResult<()>, tail: &str| match result {
            Err(err @ AppError::Command(_)) => {
                assert_eq!(err.to_string(), config_lock_busy(tail).to_string());
                assert!(
                    !err.to_string().contains("could not lock config file"),
                    "{err}"
                );
            }
            other => panic!("expected the busy refusal, got {other:?}"),
        };

        let lock = hold_config_lock(&clone);
        busy(
            git_submodule_update_core(&state, clone.clone(), None, false).await,
            "the submodules weren't set up — try again.",
        );
        busy(
            git_submodule_update_core(&state, clone.clone(), Some("libs/dep".into()), true).await,
            "the submodule wasn't set up — try again.",
        );
        assert!(!exists(&clone, "libs/dep/dep.txt"));
        assert_eq!(submodule_config(&clone).await, "", "nothing registered");
        std::fs::remove_file(&lock).unwrap();

        let registered = submodule_config(&host).await;
        let lock = hold_config_lock(&host);
        let set = || {
            git_submodule_set_url_core(
                &state,
                host.clone(),
                "libs/dep".into(),
                "../dep-moved".into(),
            )
        };
        busy(
            set().await,
            "the new URL was written to .gitmodules but not staged or synced — stage \
             .gitmodules (or discard it) and set the URL again.",
        );
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(
            gitmodules_entries(&host).await["libs/dep"].url,
            "../dep-moved"
        );
        assert_eq!(submodule_config(&host).await, registered, "not synced");
        let retried = set().await;
        assert!(
            matches!(&retried, Err(AppError::InvalidArgument(m)) if m.contains("Unstaged changes to .gitmodules")),
            "a plain retry is refused: {retried:?}"
        );
        git(&host, &["add", "--", ".gitmodules"]).await;
        set().await.expect("staged, setting the URL again finishes");
        let synced = git(&host, &["config", "--get", "submodule.libs/dep.url"]).await;
        assert!(synced.trim().ends_with("dep-moved"), "{synced}");
        git(&host, &["reset", "-q", "--hard"]).await;

        let lock = hold_config_lock(&host);
        let add = || {
            git_submodule_add_core(
                &state,
                host.clone(),
                "../dep2".into(),
                Some("libs/dep2".into()),
                None,
            )
        };
        busy(
            add().await,
            "the submodule was cloned and staged but couldn't be registered in this \
             repository — update it to finish setting it up.",
        );
        std::fs::remove_file(&lock).unwrap();
        assert!(exists(&host, "libs/dep2/dep2.txt"), "cloned");
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("A  libs/dep2"), "staged: {status}");
        assert!(!submodule_config(&host).await.contains("libs/dep2"));
        assert!(add().await.is_err(), "re-adding is no way out");
        git_submodule_update_core(&state, host.clone(), Some("libs/dep2".into()), false)
            .await
            .expect("the advised update finishes the setup");
        assert!(submodule_config(&host)
            .await
            .contains("submodule.libs/dep2.url "));
        let subs = list_submodules(&host).await.unwrap();
        let added = subs.iter().find(|s| s.path == "libs/dep2").expect("listed");
        assert_eq!(added.status, "ok", "initialized, not '-'");
        git(&host, &["commit", "-qm", "add dep2"]).await;

        let lock = hold_config_lock(&host);
        let remove =
            || git_submodule_remove_core(&state, host.clone(), "libs/dep".into(), false, false);
        busy(
            remove().await.map(drop),
            "the submodule's files were cleared but it wasn't removed — try again.",
        );
        std::fs::remove_file(&lock).unwrap();
        assert!(!exists(&host, "libs/dep/dep.txt"), "the files were cleared");
        assert!(submodule_config(&host)
            .await
            .contains("submodule.libs/dep."));
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(
            !status.contains("D  libs/dep"),
            "never reached `git rm`: {status}"
        );
        let outcome = remove().await.expect("trying again removes it");
        assert!(!outcome.refused_dirty);
        assert!(!submodule_config(&host)
            .await
            .contains("submodule.libs/dep."));
        let status = git(&host, &["status", "--porcelain"]).await;
        assert!(status.contains("D  libs/dep\n"), "status: {status}");
    }

    #[tokio::test]
    async fn clone_recurses_into_submodules_only_when_asked() {
        let (dir, host, _dep) = host_with_submodule("clone").await;
        let parent = dir.path().to_string_lossy().into_owned();

        let shallow = clone_repo_core(&host, &parent, Some("plain".into()), false, &[])
            .await
            .unwrap();
        assert!(!exists(&shallow, "libs/dep/dep.txt"));
        assert!(Path::new(&shallow).join("libs/dep").is_dir(), "empty gitlink dir");

        let deep = clone_repo_core(&host, &parent, Some("recursed".into()), true, &[])
            .await
            .unwrap();
        assert!(exists(&deep, "libs/dep/dep.txt"));
    }

    /// A host whose `libs/dep` submodule sits on `main` at `c2`, with `c1` its parent
    /// and `c0` the pointer the host committed.
    struct GitlinkFixture {
        _dir: tempfile::TempDir,
        host: String,
        sub: String,
        dep: String,
        c0: String,
        c1: String,
        c2: String,
    }

    async fn gitlink_fixture(marker: &str) -> GitlinkFixture {
        let (dir, host, dep) = host_with_submodule(marker).await;
        let sub = sub_dir(&host);
        let c0 = head_of(&sub).await;
        let c1 = commit_in(&sub, "a.txt", "one").await;
        let c2 = commit_in(&sub, "b.txt", "two").await;
        GitlinkFixture {
            _dir: dir,
            host,
            sub,
            dep,
            c0,
            c1,
            c2,
        }
    }

    async fn head_of(repo: &str) -> String {
        git(repo, &["rev-parse", "HEAD"]).await.trim().to_string()
    }

    /// The parent's tree with `libs/dep` at `sha`, or without it; the index stays there.
    async fn tree_with(host: &str, sha: Option<&str>) -> String {
        match sha {
            Some(sha) => stage_gitlink(host, sha).await,
            None => {
                git(host, &["update-index", "--force-remove", "libs/dep"]).await;
            }
        }
        git(host, &["write-tree"]).await.trim().to_string()
    }

    /// Unmerged `libs/dep` stages from three trees, with no merge machinery involved.
    async fn conflict_at(host: &str, base: Option<&str>, ours: Option<&str>, theirs: Option<&str>) {
        let base_tree = tree_with(host, base).await;
        let theirs_tree = tree_with(host, theirs).await;
        // Last, so the index read-tree merges into is the ours tree.
        let ours_tree = tree_with(host, ours).await;
        git(
            host,
            &["read-tree", "-m", &base_tree, &ours_tree, &theirs_tree],
        )
        .await;
    }

    fn stages_of(
        base: Option<&str>,
        ours: Option<&str>,
        theirs: Option<&str>,
    ) -> SubmoduleConflictStages {
        SubmoduleConflictStages {
            base: base.map(Into::into),
            ours: ours.map(Into::into),
            theirs: theirs.map(Into::into),
        }
    }

    async fn read_conflict(host: &str) -> SubmoduleConflict {
        git_submodule_conflict_core(host, "libs/dep")
            .await
            .expect("submodule conflict read")
    }

    async fn accept(
        host: &str,
        side: &str,
        expected: &SubmoduleConflictStages,
        expect_checkout: bool,
    ) -> AppResult<SubmoduleAcceptOutcome> {
        git_accept_submodule_conflict_side_core(
            &AppState::default(),
            host,
            "libs/dep",
            side,
            expected,
            expect_checkout,
        )
        .await
    }

    fn staged_left(sha: &str, why: SubmoduleCheckoutLeft) -> SubmoduleAcceptOutcome {
        SubmoduleAcceptOutcome::Staged {
            sha: sha.to_string(),
            checkout: SubmoduleAcceptCheckout::Left { why, reason: None },
        }
    }

    async fn unmerged(host: &str) -> String {
        git(host, &["ls-files", "-u"]).await
    }

    async fn index_entries(host: &str) -> String {
        git(host, &["ls-files", "-s"]).await
    }

    /// The resolved pointer: `libs/dep` at stage 0 with `sha`, and no unmerged stage left.
    async fn assert_pointer_staged(host: &str, sha: &str) {
        assert_eq!(unmerged(host).await, "", "still conflicted");
        let entry = git(host, &["ls-files", "-s", "--", "libs/dep"]).await;
        assert_eq!(entry.trim(), format!("160000 {sha} 0\tlibs/dep"));
    }

    fn assert_invalid<T>(result: AppResult<T>, want: &str) {
        match result {
            Err(AppError::InvalidArgument(message)) => assert_eq!(message, want),
            Err(other) => panic!("expected InvalidArgument({want}), got {other:?}"),
            Ok(_) => panic!("expected InvalidArgument({want}), got Ok"),
        }
    }

    fn side(read: &Option<SubmoduleConflictSide>) -> &SubmoduleConflictSide {
        read.as_ref().expect("side present")
    }

    #[tokio::test]
    async fn conflict_read_measures_a_descendant_both_ways() {
        let f = gitlink_fixture("conflict-desc").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        let read = read_conflict(&f.host).await;
        assert_eq!(read.base.as_deref(), Some(f.c0.as_str()));
        let (ours, theirs) = (side(&read.ours), side(&read.theirs));
        assert_eq!(
            (ours.sha.as_str(), theirs.sha.as_str()),
            (f.c1.as_str(), f.c2.as_str())
        );
        assert!(ours.gitlink && theirs.gitlink);
        let commit = ours.commit.as_ref().expect("ours is in the submodule");
        assert_eq!(commit.subject, "one");
        // `%cI`: strict ISO 8601, `YYYY-MM-DDTHH:MM:SS±HH:MM`.
        let date = commit.committed_at.as_bytes();
        assert!(
            date.len() == 25 && date[10] == b'T',
            "{}",
            commit.committed_at
        );
        assert_eq!(theirs.commit.as_ref().unwrap().subject, "two");
        assert_eq!(ours.plan, Some(SubmoduleCheckoutPlan::CheckOut));
        assert_eq!(theirs.plan, Some(SubmoduleCheckoutPlan::AlreadyThere));
        assert_eq!(
            read.relation,
            SubmoduleConflictRelation::TheirsContainsOurs { ahead: 1 }
        );

        conflict_at(&f.host, Some(&f.c0), Some(&f.c2), Some(&f.c1)).await;
        assert_eq!(
            read_conflict(&f.host).await.relation,
            SubmoduleConflictRelation::OursContainsTheirs { ahead: 1 }
        );
    }

    #[tokio::test]
    async fn conflict_read_add_add_has_no_base_and_diverged_sides_say_so() {
        let f = gitlink_fixture("conflict-diverged").await;
        git(&f.sub, &["checkout", "-q", "-b", "side", &f.c0]).await;
        let c3 = commit_in(&f.sub, "c.txt", "three").await;
        git(&f.sub, &["checkout", "-q", "main"]).await;
        conflict_at(&f.host, None, Some(&f.c2), Some(&c3)).await;
        let read = read_conflict(&f.host).await;
        assert_eq!(read.base, None);
        assert_eq!(read.relation, SubmoduleConflictRelation::Diverged);
        assert_eq!(side(&read.ours).commit.as_ref().unwrap().subject, "two");
        assert_eq!(side(&read.theirs).commit.as_ref().unwrap().subject, "three");
        assert_eq!(
            side(&read.ours).plan,
            Some(SubmoduleCheckoutPlan::AlreadyThere)
        );
        assert_eq!(
            side(&read.theirs).plan,
            Some(SubmoduleCheckoutPlan::CheckOut)
        );
    }

    #[tokio::test]
    async fn accept_of_an_unfetched_commit_stages_it_and_leaves_the_checkout() {
        let f = gitlink_fixture("conflict-unfetched").await;
        let upstream = commit_in(&f.dep, "x.txt", "upstream").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c2), Some(&upstream)).await;
        let read = read_conflict(&f.host).await;
        assert!(side(&read.theirs).commit.is_none());
        assert_eq!(
            side(&read.theirs).plan,
            Some(SubmoduleCheckoutPlan::NotFetched)
        );
        assert_eq!(
            side(&read.ours).plan,
            Some(SubmoduleCheckoutPlan::AlreadyThere)
        );
        assert_eq!(read.relation, SubmoduleConflictRelation::Unknown);

        let expected = stages_of(Some(&f.c0), Some(&f.c2), Some(&upstream));
        let outcome = accept(&f.host, "theirs", &expected, false).await.unwrap();
        assert_eq!(
            outcome,
            staged_left(&upstream, SubmoduleCheckoutLeft::NotFetched)
        );
        assert_pointer_staged(&f.host, &upstream).await;
        assert_eq!(head_of(&f.sub).await, f.c2);
    }

    #[tokio::test]
    async fn accept_leaves_a_dirty_checkout_tracked_or_untracked() {
        for (marker, file) in [
            ("conflict-dirty-tracked", "dep.txt"),
            ("conflict-dirty-untracked", "new.txt"),
        ] {
            let f = gitlink_fixture(marker).await;
            conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
            let edited = Path::new(&f.sub).join(file);
            std::fs::write(&edited, "local edit\n").unwrap();
            let read = read_conflict(&f.host).await;
            assert_eq!(
                side(&read.ours).plan,
                Some(SubmoduleCheckoutPlan::Dirty),
                "{file}"
            );
            // HEAD's own commit outranks the dirty tree.
            assert_eq!(
                side(&read.theirs).plan,
                Some(SubmoduleCheckoutPlan::AlreadyThere)
            );

            // Promised a checkout, then the tree turned dirty: staged, checkout left.
            let expected = stages_of(Some(&f.c0), Some(&f.c1), Some(&f.c2));
            let outcome = accept(&f.host, "ours", &expected, true).await.unwrap();
            assert_eq!(
                outcome,
                staged_left(&f.c1, SubmoduleCheckoutLeft::Dirty),
                "{file}"
            );
            assert_pointer_staged(&f.host, &f.c1).await;
            assert_eq!(head_of(&f.sub).await, f.c2, "{file}");
            assert_eq!(std::fs::read(&edited).unwrap(), b"local edit\n");
        }
    }

    #[tokio::test]
    async fn accept_into_an_uninitialized_folder_runs_nothing_inside_it() {
        let f = gitlink_fixture("conflict-uninit").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        std::fs::remove_dir_all(&f.sub).unwrap();
        std::fs::create_dir(&f.sub).unwrap();
        let head = head_of(&f.host).await;
        let branch = git(&f.host, &["symbolic-ref", "HEAD"]).await;
        let read = read_conflict(&f.host).await;
        for s in [side(&read.ours), side(&read.theirs)] {
            assert_eq!(s.plan, Some(SubmoduleCheckoutPlan::NotInitialized));
            assert!(s.commit.is_none());
        }
        assert_eq!(read.relation, SubmoduleConflictRelation::Unknown);

        let expected = stages_of(Some(&f.c0), Some(&f.c1), Some(&f.c2));
        let outcome = accept(&f.host, "theirs", &expected, false).await.unwrap();
        assert_eq!(
            outcome,
            staged_left(&f.c2, SubmoduleCheckoutLeft::NotInitialized)
        );
        assert_pointer_staged(&f.host, &f.c2).await;
        assert!(!exists(&f.host, "libs/dep/.git"));
        assert_eq!(head_of(&f.host).await, head);
        assert_eq!(git(&f.host, &["symbolic-ref", "HEAD"]).await, branch);
    }

    #[tokio::test]
    async fn a_removed_side_reads_none_and_cannot_be_accepted() {
        let f = gitlink_fixture("conflict-removed").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), None).await;
        let read = read_conflict(&f.host).await;
        assert!(read.theirs.is_none());
        assert_eq!(side(&read.ours).sha, f.c1);
        let before = index_entries(&f.host).await;
        let expected = stages_of(Some(&f.c0), Some(&f.c1), None);
        assert_invalid(
            accept(&f.host, "theirs", &expected, false).await,
            "that side has no submodule commit to accept",
        );
        assert_eq!(index_entries(&f.host).await, before);

        conflict_at(&f.host, Some(&f.c0), None, Some(&f.c2)).await;
        let read = read_conflict(&f.host).await;
        assert!(read.ours.is_none());
        assert_eq!(side(&read.theirs).sha, f.c2);
    }

    /// Rewrites `path`'s index entries from `--index-info` lines.
    async fn inject_stages(host: &str, path: &str, stages: &[(&str, &str, u8)]) {
        let zero = "0".repeat(40);
        let mut info = format!("0 {zero}\t{path}\n");
        for (mode, sha, stage) in stages {
            info.push_str(&format!("{mode} {sha} {stage}\t{path}\n"));
        }
        crate::git::runner::run_git_input(
            Some(host),
            &["update-index", "--index-info"],
            Some(&info),
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
    }

    async fn blob(host: &str, text: &str) -> String {
        std::fs::write(Path::new(host).join("blob.tmp"), text).unwrap();
        let sha = git(host, &["hash-object", "-w", "blob.tmp"]).await;
        std::fs::remove_file(Path::new(host).join("blob.tmp")).unwrap();
        sha.trim().to_string()
    }

    #[tokio::test]
    async fn a_file_side_reads_as_no_gitlink_and_a_file_conflict_is_refused() {
        let f = gitlink_fixture("conflict-mixed").await;
        let file = blob(&f.host, "text\n").await;
        inject_stages(
            &f.host,
            "libs/dep",
            &[
                (GITLINK_MODE, &f.c0, 1),
                (GITLINK_MODE, &f.c1, 2),
                ("100644", &file, 3),
            ],
        )
        .await;
        let read = read_conflict(&f.host).await;
        let theirs = side(&read.theirs);
        assert!(!theirs.gitlink);
        assert_eq!((theirs.commit.is_none(), theirs.plan), (true, None));
        assert!(side(&read.ours).gitlink);
        assert_eq!(read.relation, SubmoduleConflictRelation::Unknown);
        let before = index_entries(&f.host).await;
        let expected = stages_of(Some(&f.c0), Some(&f.c1), Some(&file));
        assert_invalid(
            accept(&f.host, "theirs", &expected, false).await,
            "that side has no submodule commit to accept",
        );
        assert_eq!(index_entries(&f.host).await, before);

        inject_stages(
            &f.host,
            "plain.txt",
            &[
                ("100644", &file, 1),
                ("100644", &file, 2),
                ("100644", &file, 3),
            ],
        )
        .await;
        assert_invalid(
            git_submodule_conflict_core(&f.host, "plain.txt").await,
            "not a submodule conflict",
        );
    }

    #[tokio::test]
    async fn a_resolved_gitlink_reads_resolved_in_both_reads() {
        let (_dir, host, _dep) = host_with_submodule("conflict-resolved").await;
        let read = read_conflict(&host).await;
        assert_eq!(
            (read.base, read.ours.is_none(), read.theirs.is_none()),
            (None, true, true)
        );
        assert_eq!(read.relation, SubmoduleConflictRelation::Unknown);
        let sides = crate::git::conflict::git_conflict_sides(host, "libs/dep".into(), vec![])
            .await
            .expect("a resolved gitlink is no io error");
        assert_eq!((sides.base, sides.ours, sides.theirs), (None, None, None));
        assert!(!sides.working_exists);
        assert_eq!(sides.working_hash, None);
    }

    #[tokio::test]
    async fn text_reads_and_whole_side_accepts_refuse_a_gitlink_conflict() {
        let f = gitlink_fixture("conflict-refusal").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        let sides =
            || crate::git::conflict::git_conflict_sides(f.host.clone(), "libs/dep".into(), vec![]);
        let refusal = crate::git::conflict::SUBMODULE_REFUSAL;
        // A folder, a text file, nothing: no working read decides it.
        assert_invalid(sides().await, refusal);
        let before = unmerged(&f.host).await;
        assert_invalid(
            crate::git::conflict::git_checkout_conflict_side_core(
                &AppState::default(),
                f.host.clone(),
                "libs/dep".into(),
                "theirs".into(),
            )
            .await,
            refusal,
        );
        assert_eq!(unmerged(&f.host).await, before);
        assert_eq!(before.lines().count(), 3, "{before}");
        std::fs::remove_dir_all(&f.sub).unwrap();
        std::fs::write(&f.sub, "text\n").unwrap();
        assert_invalid(sides().await, refusal);
        std::fs::remove_file(&f.sub).unwrap();
        assert_invalid(sides().await, refusal);
    }

    #[tokio::test]
    async fn a_detached_checkout_elsewhere_stays_and_its_promise_is_kept() {
        let f = gitlink_fixture("conflict-detached").await;
        git(&f.sub, &["checkout", "-q", "-b", "other", &f.c0]).await;
        let c3 = commit_in(&f.sub, "d.txt", "four").await;
        git(&f.sub, &["checkout", "-q", "--detach", &c3]).await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        let read = read_conflict(&f.host).await;
        for s in [side(&read.ours), side(&read.theirs)] {
            assert_eq!(s.plan, Some(SubmoduleCheckoutPlan::DetachedElsewhere));
        }
        let expected = stages_of(Some(&f.c0), Some(&f.c1), Some(&f.c2));
        let outcome = accept(&f.host, "theirs", &expected, false).await.unwrap();
        assert_eq!(
            outcome,
            staged_left(&f.c2, SubmoduleCheckoutLeft::DetachedElsewhere)
        );
        assert_pointer_staged(&f.host, &f.c2).await;
        assert_eq!(head_of(&f.sub).await, c3);

        // The pane said "stays as is"; the commit then went on a branch.
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        git(&f.sub, &["checkout", "-q", "other"]).await;
        let before = unmerged(&f.host).await;
        let outcome = accept(&f.host, "theirs", &expected, false).await.unwrap();
        assert_eq!(outcome, SubmoduleAcceptOutcome::Changed);
        assert_eq!(unmerged(&f.host).await, before);
        assert_eq!(head_of(&f.sub).await, c3);

        let outcome = accept(&f.host, "theirs", &expected, true).await.unwrap();
        assert_eq!(
            outcome,
            SubmoduleAcceptOutcome::Staged {
                sha: f.c2.clone(),
                checkout: SubmoduleAcceptCheckout::CheckedOut,
            }
        );
        assert_pointer_staged(&f.host, &f.c2).await;
        assert_eq!(head_of(&f.sub).await, f.c2);
    }

    #[tokio::test]
    async fn a_dirty_read_then_cleaned_tree_returns_changed() {
        let f = gitlink_fixture("conflict-promise").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        let tracked = Path::new(&f.sub).join("dep.txt");
        let original = std::fs::read(&tracked).unwrap();
        std::fs::write(&tracked, "local edit\n").unwrap();
        assert_eq!(
            side(&read_conflict(&f.host).await.ours).plan,
            Some(SubmoduleCheckoutPlan::Dirty)
        );
        std::fs::write(&tracked, &original).unwrap();
        let before = unmerged(&f.host).await;
        let expected = stages_of(Some(&f.c0), Some(&f.c1), Some(&f.c2));
        let outcome = accept(&f.host, "ours", &expected, false).await.unwrap();
        assert_eq!(outcome, SubmoduleAcceptOutcome::Changed);
        assert_eq!(unmerged(&f.host).await, before);
        assert_eq!(head_of(&f.sub).await, f.c2);

        // Staying is always safe: AlreadyThere stages whatever the promise said.
        let outcome = accept(&f.host, "theirs", &expected, false).await.unwrap();
        assert_eq!(
            outcome,
            SubmoduleAcceptOutcome::Staged {
                sha: f.c2.clone(),
                checkout: SubmoduleAcceptCheckout::AlreadyThere,
            }
        );
    }

    #[tokio::test]
    async fn dirty_outranks_not_fetched_on_one_side() {
        let f = gitlink_fixture("conflict-dirty-unfetched").await;
        let upstream = commit_in(&f.dep, "x.txt", "upstream").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c2), Some(&upstream)).await;
        std::fs::write(Path::new(&f.sub).join("dep.txt"), "local edit\n").unwrap();
        let theirs = read_conflict(&f.host).await.theirs.unwrap();
        assert_eq!(theirs.plan, Some(SubmoduleCheckoutPlan::Dirty));
        assert!(theirs.commit.is_none());
    }

    #[tokio::test]
    async fn an_ignored_file_the_target_tracks_fails_the_checkout_and_keeps_its_bytes() {
        let f = gitlink_fixture("conflict-ignored").await;
        git(&f.sub, &["checkout", "-q", "-b", "ign"]).await;
        let tracks = commit_in(&f.sub, "ign.txt", "tracked").await;
        git(&f.sub, &["checkout", "-q", "main"]).await;
        let exclude = git(&f.sub, &["rev-parse", "--git-path", "info/exclude"]).await;
        let exclude = Path::new(&f.sub).join(exclude.trim());
        std::fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        std::fs::write(&exclude, "ign.txt\n").unwrap();
        let ignored = Path::new(&f.sub).join("ign.txt");
        std::fs::write(&ignored, "LOCAL BYTES\n").unwrap();
        conflict_at(&f.host, Some(&f.c0), Some(&f.c2), Some(&tracks)).await;
        let read = read_conflict(&f.host).await;
        assert_eq!(
            side(&read.theirs).plan,
            Some(SubmoduleCheckoutPlan::CheckOut)
        );

        let expected = stages_of(Some(&f.c0), Some(&f.c2), Some(&tracks));
        let outcome = accept(&f.host, "theirs", &expected, true).await.unwrap();
        match &outcome {
            SubmoduleAcceptOutcome::Staged {
                sha,
                checkout:
                    SubmoduleAcceptCheckout::Left {
                        why: SubmoduleCheckoutLeft::Failed,
                        reason: Some(reason),
                    },
            } => {
                assert_eq!(sha, &tracks);
                assert!(!reason.is_empty());
            }
            other => panic!("expected a failed checkout, got {other:?}"),
        }
        assert_pointer_staged(&f.host, &tracks).await;
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(std::fs::read(&ignored).unwrap(), b"LOCAL BYTES\n");
    }

    #[tokio::test]
    async fn accept_compares_the_stages_and_never_repoints_a_resolved_path() {
        let f = gitlink_fixture("conflict-cas").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        let before = index_entries(&f.host).await;
        let swapped = stages_of(Some(&f.c0), Some(&f.c2), Some(&f.c1));
        let outcome = accept(&f.host, "ours", &swapped, true).await.unwrap();
        assert_eq!(outcome, SubmoduleAcceptOutcome::Changed);
        assert_eq!(index_entries(&f.host).await, before);

        let expected = stages_of(Some(&f.c0), Some(&f.c1), Some(&f.c2));
        let outcome = accept(&f.host, "ours", &expected, true).await.unwrap();
        assert_eq!(
            outcome,
            SubmoduleAcceptOutcome::Staged {
                sha: f.c1.clone(),
                checkout: SubmoduleAcceptCheckout::CheckedOut,
            }
        );
        assert_pointer_staged(&f.host, &f.c1).await;
        assert_eq!(head_of(&f.sub).await, f.c1);

        let after = index_entries(&f.host).await;
        assert_invalid(
            accept(&f.host, "theirs", &expected, true).await,
            crate::git::conflict::NOT_CONFLICTED_REFUSAL,
        );
        assert_eq!(index_entries(&f.host).await, after);
    }

    #[tokio::test]
    async fn submodule_conflict_cores_refuse_hostile_paths_and_bad_input() {
        let f = gitlink_fixture("conflict-hostile").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        let before = index_entries(&f.host).await;
        let expected = stages_of(Some(&f.c0), Some(&f.c1), Some(&f.c2));
        let absolute = format!("{}/libs/dep", f.host.replace('\\', "/"));
        for path in [".git/x", "../x", "-x", absolute.as_str()] {
            assert!(
                matches!(
                    git_submodule_conflict_core(&f.host, path).await,
                    Err(AppError::InvalidArgument(_))
                ),
                "read {path}"
            );
            let accepted = git_accept_submodule_conflict_side_core(
                &AppState::default(),
                &f.host,
                path,
                "theirs",
                &expected,
                true,
            )
            .await;
            assert!(
                matches!(accepted, Err(AppError::InvalidArgument(_))),
                "accept {path}"
            );
        }
        assert_invalid(
            accept(&f.host, "both", &expected, true).await,
            "invalid conflict side: both",
        );
        let short = stages_of(Some("abc"), Some(&f.c1), Some(&f.c2));
        assert_invalid(
            accept(&f.host, "theirs", &short, true).await,
            "invalid commit id: abc",
        );
        assert_eq!(index_entries(&f.host).await, before);
    }

    #[test]
    fn plan_checkout_takes_the_first_matching_arm() {
        use SubmoduleCheckoutPlan as P;
        let (sha, other, stray) = ("a".repeat(40), "b".repeat(40), "c".repeat(40));
        let recorded = [sha.as_str(), other.as_str()];
        let state = |checkout, head: Option<&str>, detached, dirty| SubmoduleCheckoutState {
            checkout,
            head: head.map(Into::into),
            detached,
            dirty,
        };
        let ok = SubmoduleCheckout::Ok;
        let rows = [
            // Tree-wide reasons outrank every per-side one, the head match included.
            (
                state(SubmoduleCheckout::NotInitialized, None, false, false),
                true,
                P::NotInitialized,
            ),
            (
                state(SubmoduleCheckout::Missing, None, false, false),
                true,
                P::NotInitialized,
            ),
            (
                state(SubmoduleCheckout::Replaced, None, false, false),
                true,
                P::Unusable,
            ),
            (
                state(SubmoduleCheckout::Unreadable, None, false, false),
                true,
                P::Unusable,
            ),
            (state(ok, Some(&sha), true, true), false, P::AlreadyThere),
            (state(ok, Some(&other), false, true), false, P::Dirty),
            (state(ok, Some(&stray), true, true), true, P::Dirty),
            (
                state(ok, Some(&stray), true, false),
                false,
                P::DetachedElsewhere,
            ),
            (state(ok, None, true, false), true, P::DetachedElsewhere),
            (state(ok, Some(&other), true, false), false, P::NotFetched),
            (state(ok, Some(&stray), false, false), false, P::NotFetched),
            (state(ok, Some(&other), true, false), true, P::CheckOut),
            (state(ok, Some(&stray), false, false), true, P::CheckOut),
        ];
        for (i, (state, present, want)) in rows.iter().enumerate() {
            assert_eq!(
                plan_checkout(state, &sha, *present, &recorded),
                *want,
                "row {i}"
            );
        }
    }

    #[test]
    fn submodule_conflict_wire_shapes_are_camel_case() {
        fn keys(value: &serde_json::Value) -> Vec<String> {
            let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
            keys.sort_unstable();
            keys
        }
        let conflict = SubmoduleConflict {
            base: Some("b".into()),
            ours: Some(SubmoduleConflictSide {
                sha: "o".into(),
                gitlink: true,
                commit: Some(SubmoduleConflictCommit {
                    subject: "s".into(),
                    committed_at: "2026-01-02T03:04:05+00:00".into(),
                }),
                plan: Some(SubmoduleCheckoutPlan::DetachedElsewhere),
            }),
            theirs: Some(SubmoduleConflictSide {
                sha: "t".into(),
                gitlink: false,
                commit: None,
                plan: None,
            }),
            relation: SubmoduleConflictRelation::Unknown,
        };
        let json = serde_json::to_value(&conflict).unwrap();
        assert_eq!(keys(&json), ["base", "ours", "relation", "theirs"]);
        assert_eq!(keys(&json["ours"]), ["commit", "gitlink", "plan", "sha"]);
        assert_eq!(keys(&json["ours"]["commit"]), ["committedAt", "subject"]);
        assert_eq!(json["theirs"]["commit"], serde_json::Value::Null);
        assert_eq!(json["theirs"]["plan"], serde_json::Value::Null);
        let text = json.to_string();
        assert!(!text.contains("committed_at"), "{text}");

        use SubmoduleCheckoutPlan as P;
        for (plan, wire) in [
            (P::CheckOut, "checkOut"),
            (P::AlreadyThere, "alreadyThere"),
            (P::NotInitialized, "notInitialized"),
            (P::Unusable, "unusable"),
            (P::Dirty, "dirty"),
            (P::DetachedElsewhere, "detachedElsewhere"),
            (P::NotFetched, "notFetched"),
        ] {
            assert_eq!(serde_json::to_value(plan).unwrap(), serde_json::json!(wire));
        }
        use SubmoduleConflictRelation as R;
        for (relation, wire) in [
            (R::Unknown, serde_json::json!({ "kind": "unknown" })),
            (R::Diverged, serde_json::json!({ "kind": "diverged" })),
            (
                R::OursContainsTheirs { ahead: 2 },
                serde_json::json!({ "kind": "oursContainsTheirs", "ahead": 2 }),
            ),
            (
                R::TheirsContainsOurs { ahead: 3 },
                serde_json::json!({ "kind": "theirsContainsOurs", "ahead": 3 }),
            ),
        ] {
            assert_eq!(serde_json::to_value(relation).unwrap(), wire);
        }

        assert_eq!(
            serde_json::to_value(SubmoduleAcceptOutcome::Changed).unwrap(),
            serde_json::json!({ "kind": "changed" })
        );
        use SubmoduleAcceptCheckout as C;
        for (checkout, wire) in [
            (C::CheckedOut, serde_json::json!({ "kind": "checkedOut" })),
            (
                C::AlreadyThere,
                serde_json::json!({ "kind": "alreadyThere" }),
            ),
        ] {
            let staged = SubmoduleAcceptOutcome::Staged {
                sha: "s".into(),
                checkout,
            };
            assert_eq!(
                serde_json::to_value(staged).unwrap(),
                serde_json::json!({ "kind": "staged", "sha": "s", "checkout": wire })
            );
        }
        use SubmoduleCheckoutLeft as L;
        for (why, wire) in [
            (L::NotInitialized, "notInitialized"),
            (L::Unusable, "unusable"),
            (L::Dirty, "dirty"),
            (L::DetachedElsewhere, "detachedElsewhere"),
            (L::NotFetched, "notFetched"),
            (L::Failed, "failed"),
        ] {
            let reason = (why == L::Failed).then(|| "r".to_string());
            assert_eq!(
                serde_json::to_value(C::Left {
                    why,
                    reason: reason.clone()
                })
                .unwrap(),
                serde_json::json!({ "kind": "left", "why": wire, "reason": reason })
            );
        }

        let stages: SubmoduleConflictStages =
            serde_json::from_value(serde_json::json!({ "base": null, "ours": "o", "theirs": "t" }))
                .unwrap();
        assert_eq!(stages, stages_of(None, Some("o"), Some("t")));
    }

    #[test]
    fn submodule_conflict_cores_gate_the_path_and_lock_before_writing() {
        fn body(source: &str, name: &str) -> String {
            let start = source.find(&format!("fn {name}(")).expect(name);
            let rest = &source[start..];
            let end = rest.find("\n}").expect(name);
            rest[..end]
                .lines()
                .map(|line| line.split("//").next().unwrap())
                .collect::<Vec<_>>()
                .join("\n")
        }
        let source = include_str!("submodule.rs");
        let read = body(source, "git_submodule_conflict_core");
        assert!(read.contains("conflict_rel_path("));
        let write = body(source, "git_accept_submodule_conflict_side_core");
        let at = |needle: &str| write.find(needle).unwrap_or_else(|| panic!("{needle}"));
        assert!(at("conflict_rel_path(") < at("working_tree_lock("));
        assert!(at("working_tree_lock(") < at("acquire_repo_lock("));
        assert!(at("acquire_repo_lock(") < at("\"update-index\""));
        assert!(at("acquire_repo_lock(") < at("checkout_staged_commit("));
    }
}
