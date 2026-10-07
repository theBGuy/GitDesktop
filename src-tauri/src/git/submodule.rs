use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{
    acquire_repo_lock, config_lock_busy, is_config_lock_contention, run_git, run_git_config_write,
    run_git_config_write_held, run_git_raw, run_git_raw_index_retry, with_config_write_lock,
    GitOutput, DEFAULT_TIMEOUT, LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT, WORKTREE_OP_TIMEOUT,
};
use crate::git::types::{Submodule, SubmoduleRemoveOutcome};
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
    use crate::git::runner::{hold_config_lock, lock_events};

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
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
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
            DEFAULT_TIMEOUT,
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
                assert!(!err.to_string().contains("config.lock"), "{err}");
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
}
