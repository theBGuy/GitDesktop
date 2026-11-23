use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::conflict::{
    conflict_rel_path, refuse_linked_path, unmerged_entries, UnmergedEntry, GITLINK_MODE,
    NOT_CONFLICTED_REFUSAL,
};
use crate::git::runner::{
    acquire_repo_lock, config_lock_busy, holder_label, is_config_lock_contention, run_git,
    run_git_config_write, run_git_config_write_held, run_git_input, run_git_raw, run_git_raw_env,
    run_git_raw_index_retry, run_git_raw_input, with_config_write_lock, GitOutput, DEFAULT_TIMEOUT,
    LOCK_WAIT_TIMEOUT, NETWORK_LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT, WORKTREE_OP_TIMEOUT,
};
use crate::git::types::{
    CommitSummary, Submodule, SubmoduleChanges, SubmoduleCheckout, SubmoduleCommit,
    SubmoduleRemoveOutcome,
};
use crate::state::AppState;

/// Belongs on EVERY `status --porcelain` probe here whose emptiness is read as
/// "clean": `status.showUntrackedFiles=no` otherwise suppresses the `??` lines and
/// empties the answer while the worktree is dirty (measured, git 2.51.1). Both such
/// probes — the remove path's submodule-worktree check and
/// [`refuse_unsettled_gitmodules`] — carry it.
const UNTRACKED_NORMAL: &str = "--untracked-files=normal";

/// The conflict read's refusal once a path's conflict holds no gitlink. The
/// frontend matches it (workingtree.ts NOT_SUBMODULE_CONFLICT), pinned by
/// scripts/conflict-prefilter.test.mjs.
pub(crate) const NOT_SUBMODULE_CONFLICT: &str = "not a submodule conflict";

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
/// section at all, and the file itself may be missing: git's "no key matched" is an
/// empty map, leaving the status-derived list intact. Any other failure (a corrupt
/// file) is an Err, never a map that reads as "no entries".
async fn gitmodules_entries(repo_path: &str) -> AppResult<HashMap<String, ModuleEntry>> {
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
    .await?;
    let Some(out) = config_answer(out)? else {
        return Ok(HashMap::new());
    };
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
    Ok(by_name
        .into_iter()
        .filter_map(|(name, (path, url, branch))| {
            Some((path?, ModuleEntry { name, url, branch }))
        })
        .collect())
}

/// A config read's verdict: exit 0 = its output; exit 1 with nothing on stderr = no
/// key matched (a missing file or section reads the same, measured git 2.51.1);
/// anything else (a corrupt file, not a repository: exit 128) is an Err.
fn config_answer(out: GitOutput) -> AppResult<Option<GitOutput>> {
    if out.code == 1 && out.stderr.trim().is_empty() {
        return Ok(None);
    }
    out.exit_verdict().map(Some)
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
    let entries = gitmodules_entries(repo_path).await?;
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

/// This repository's own `submodule.*` keys, empty when there are none; a failed
/// read is an Err, never an empty answer the repair would compare against.
async fn submodule_registrations(repo_path: &str) -> AppResult<String> {
    let out = run_git_raw(
        Some(repo_path),
        &["config", "--local", "--get-regexp", r"^submodule\."],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(config_answer(out)?
        .map(|out| out.stdout_lossy())
        .unwrap_or_default())
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
        None => Some(gitmodules_entries(&repo_path).await?),
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
                inferred_added_path(&before, gitmodules_entries(&repo_path).await)
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

/// The one `.gitmodules` path an inferred-path add created, from the entries read
/// before it and after it; None when that can't be confirmed (an unreadable file
/// included), which the caller discloses rather than guessing.
fn inferred_added_path(
    before: &HashMap<String, ModuleEntry>,
    after: AppResult<HashMap<String, ModuleEntry>>,
) -> Option<String> {
    let mut fresh = after.ok()?.into_keys().filter(|p| !before.contains_key(p));
    fresh.next().filter(|_| fresh.next().is_none())
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
        let Ok(entries) = gitmodules_entries(repo).await else {
            return Ok(out);
        };
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

const SUBMODULE_PAGE_CAP: u32 = 200;
const SUBMODULE_UNREACHED_CAP: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleRefCommit {
    pub sha: String,
    pub subject: String,
    pub author: String,
    /// The author date, `%aI`: the date History rows show.
    pub authored_at: String,
    /// Whether a remote-tracking branch or a tag reaches the commit; None = not measured.
    pub on_remote: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleCommitPage {
    pub checkout: SubmoduleCheckout,
    pub reason: Option<String>,
    pub commits: Vec<SubmoduleRefCommit>,
    pub has_more: bool,
    pub shallow: Option<bool>,
}

#[tauri::command]
pub async fn git_submodule_commits(
    repo_path: String,
    path: String,
    rev: String,
    skip: u32,
    limit: u32,
    search: Option<String>,
) -> AppResult<SubmoduleCommitPage> {
    git_submodule_commits_core(&repo_path, &path, &rev, skip, limit, search.as_deref()).await
}

pub(crate) async fn git_submodule_commits_core(
    repo_path: &str,
    path: &str,
    rev: &str,
    skip: u32,
    limit: u32,
    search: Option<&str>,
) -> AppResult<SubmoduleCommitPage> {
    validate_repo_relative(path, "submodule path")?;
    validate_submodule_rev(rev)?;
    let search = search.map(str::trim).filter(|q| !q.is_empty());
    if search.is_some_and(|q| q.bytes().any(|b| b.is_ascii_control())) {
        return Err(AppError::InvalidArgument("invalid commit search".into()));
    }

    // Probe before running git: without its own `.git`, this folder answers for the parent repo.
    let worktree = Path::new(repo_path).join(path);
    let (checkout, reason) = checkout_from_probe(std::fs::symlink_metadata(&worktree), || {
        worktree.join(".git").try_exists()
    });
    let mut page = SubmoduleCommitPage {
        checkout,
        reason,
        commits: vec![],
        has_more: false,
        shallow: None,
    };
    if checkout != SubmoduleCheckout::Ok {
        return Ok(page);
    }

    let dir = worktree.to_string_lossy().into_owned();
    let limit = limit.clamp(1, SUBMODULE_PAGE_CAP);
    let max = format!("--max-count={}", limit + 1);
    let skip = format!("--skip={skip}");
    let mut args = vec![
        "log",
        "--no-color",
        "--no-show-signature",
        crate::git::history::LOG_FORMAT,
        &max,
        &skip,
    ];
    if let Some(q) = search {
        args.extend(["-i", "-F", "--grep", q]);
    }
    args.extend(["--end-of-options", rev, "--"]);
    let out = run_git_raw(Some(&dir), &args, DEFAULT_TIMEOUT)
        .await?
        .exit_verdict()?;
    let mut rows = crate::git::history::parse_commit_log(&out.stdout_lossy());
    page.has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let shas = rows.iter().map(|row| row.hash.clone()).collect::<Vec<_>>();
    page.shallow = submodule_is_shallow(&dir).await;
    let reach = remote_reach(&dir, &shas, page.shallow).await;
    page.commits = rows
        .into_iter()
        .zip(reach)
        .map(|(row, on_remote)| SubmoduleRefCommit {
            sha: row.hash,
            subject: row.subject,
            author: row.author,
            authored_at: row.date,
            on_remote,
        })
        .collect();
    Ok(page)
}

/// Require a fully qualified ref or full object ID because a bare name can resolve a same-named tag first.
fn validate_submodule_rev(rev: &str) -> AppResult<()> {
    let full_ref = ["refs/heads/", "refs/remotes/", "refs/tags/"]
        .into_iter()
        .any(|prefix| {
            rev.strip_prefix(prefix)
                .is_some_and(|name| !name.is_empty())
        });
    if is_full_oid(rev)
        || (full_ref
            && !rev.bytes().any(|b| b.is_ascii_control())
            && !rev.contains([' ', '~', '^', ':', '?', '*', '[', '\\'])
            && !rev.contains("..")
            && !rev.contains("@{"))
    {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(format!(
            "invalid commit list ref: {rev}"
        )))
    }
}

async fn submodule_is_shallow(dir: &str) -> Option<bool> {
    let out = run_git_raw(
        Some(dir),
        &["rev-parse", "--is-shallow-repository"],
        DEFAULT_TIMEOUT,
    )
    .await
    .ok()?
    .exit_verdict()
    .ok()?;
    out.stdout_lossy().trim().parse().ok()
}

/// A clean, complete walk prints exactly the unreached commits (measured on git 2.51.1).
/// With no remote or tag refs it prints them all, and a dangling symref leaves that verdict intact.
/// A ref containing garbage or naming a missing object fails the walk: every verdict is unknown.
/// Shallow history or a warning makes printed commits inconclusive.
/// Once the walk exceeds the cap, an omitted commit may still be unreached.
async fn remote_reach(dir: &str, shas: &[String], shallow: Option<bool>) -> Vec<Option<bool>> {
    let max = format!("--max-count={}", SUBMODULE_UNREACHED_CAP + 1);
    let mut args = vec!["rev-list", &max];
    args.extend(
        shas.iter()
            .map(String::as_str)
            .filter(|sha| is_full_oid(sha)),
    );
    if args.len() == 2 {
        return vec![None; shas.len()];
    }
    args.extend(["--not", "--remotes", "--tags", "--"]);
    let Ok(out) = run_git_raw(Some(dir), &args, DEFAULT_TIMEOUT).await else {
        return vec![None; shas.len()];
    };
    let stdout = out.stdout_lossy();
    let printed: std::collections::HashSet<_> = stdout.lines().collect();
    let capped = stdout.lines().count() > SUBMODULE_UNREACHED_CAP;
    let clean = out.stderr.trim().is_empty() && shallow == Some(false);
    shas.iter()
        .map(|sha| {
            if is_full_oid(sha) {
                reach_verdict(out.code == 0, clean, capped, printed.contains(sha.as_str()))
            } else {
                None
            }
        })
        .collect()
}

fn reach_verdict(run_ok: bool, clean: bool, capped: bool, printed: bool) -> Option<bool> {
    if !run_ok {
        None
    } else if printed {
        clean.then_some(false)
    } else {
        (!capped).then_some(true)
    }
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
        return Err(AppError::InvalidArgument(NOT_SUBMODULE_CONFLICT.into()));
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
    accept_submodule_side_within(
        state,
        repo_path,
        path,
        side,
        expected,
        expect_checkout,
        LOCK_WAIT_TIMEOUT,
    )
    .await
}

#[cfg(test)]
tokio::task_local! {
    /// Called as the accept it is scoped to starts waiting for the submodule's own working
    /// tree, so a test can move the parent's stages during that wait.
    static CHILD_WAIT_HOOK: Arc<dyn Fn() + Send + Sync>;
}

/// The accept, with the bound on its wait for the submodule's own working tree
/// as a parameter so a test can shorten it.
async fn accept_submodule_side_within(
    state: &AppState,
    repo_path: &str,
    path: &str,
    side: &str,
    expected: &SubmoduleConflictStages,
    expect_checkout: bool,
    submodule_wait: Duration,
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

    // A submodule opened as its own repository takes its own working-tree domain:
    // hold it too, parent then child (no path takes them the other way), so a
    // switch there can't land between the plan and the checkout. Only a folder
    // with its own `.git` has one; git resolves any other to the parent's checkout.
    let worktree = Path::new(repo_path).join(&path);
    let has_git = worktree.join(".git").try_exists().unwrap_or(false);
    let submodule_domain = if has_git {
        Some(state.working_tree_lock(&worktree.to_string_lossy()).await)
    } else {
        None
    }
    .filter(|child| !Arc::ptr_eq(&child.lock(), &domain.lock()));
    let _submodule_guard = match &submodule_domain {
        Some(child) => {
            #[cfg(test)]
            let _ = CHILD_WAIT_HOOK.try_with(|hook| hook());
            Some(acquire_repo_lock(child, submodule_wait, "a conflict resolution").await?)
        }
        None => None,
    };

    let (dir, live) = submodule_checkout_state(repo_path, &path).await;
    // A checkout that appeared after the hold was decided would be moved unheld.
    if live.checkout == SubmoduleCheckout::Ok && !has_git {
        return Ok(SubmoduleAcceptOutcome::Changed);
    }
    let present = side_present(&dir, &live, &sha).await?;
    let recorded: Vec<&str> = entries.iter().map(|entry| entry.sha.as_str()).collect();
    let plan = plan_checkout(&live, &sha, present, &recorded);
    // The pane said the checkout would stay: re-read and say the new truth before
    // anything moves. Staying when a checkout was promised is always safe.
    if plan == SubmoduleCheckoutPlan::CheckOut && !expect_checkout {
        return Ok(SubmoduleAcceptOutcome::Changed);
    }

    // The stages again, after the child wait and the probes: git outside the app can move
    // them meanwhile, and git's CLI has no index compare-and-swap, so this narrows the
    // window to the gap between this read and the write.
    let now = conflict_entries(repo_path, &path).await?;
    if now.is_empty() {
        return Err(AppError::InvalidArgument(NOT_CONFLICTED_REFUSAL.into()));
    }
    if live_stages(&now) != *expected {
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
/// Err: the pointer is already staged and the caller must hear so.
async fn checkout_staged_commit(dir: &str, sha: &str) -> SubmoduleAcceptCheckout {
    let failed = |reason| SubmoduleAcceptCheckout::Left {
        why: SubmoduleCheckoutLeft::Failed,
        reason: Some(reason),
    };
    match detach_submodule_at(dir, sha).await {
        Ok(out) if out.code == 0 => SubmoduleAcceptCheckout::CheckedOut,
        Ok(out) => failed(unreadable_reason(&out.stderr, out.code)),
        Err(e) => failed(nonempty_reason(e.to_string())),
    }
}

/// The one checkout that moves a submodule, raw: only a spawn error or timeout is an
/// Err. Never `submodule update`, which fetches; `--no-overwrite-ignore` because a
/// plain checkout replaces an ignored file the target tracks while status calls the
/// tree clean (measured, git 2.51.1). `--no-recurse-submodules` keeps nested
/// submodules where they are, whatever `submodule.recurse` says. The index.lock retry
/// is safe: a refused lock exits 128 before git touches anything (measured).
async fn detach_submodule_at(dir: &str, sha: &str) -> AppResult<GitOutput> {
    run_git_raw_index_retry(
        dir,
        &[
            "checkout",
            "--no-recurse-submodules",
            "--no-overwrite-ignore",
            "--detach",
            sha,
        ],
        WORKTREE_OP_TIMEOUT,
    )
    .await
}

/// Every pick hold's label, the child's included: the user asked for one change.
const PICK_HOLDER: &str = "a submodule commit change";
/// Completes `refuse_mid_op_for`'s "Can't {action} while …" for the parent.
const PICK_ACTION: &str = "choose a submodule commit";
/// Each ref list's cap.
const SUBMODULE_REFS_CAP: usize = 500;
/// `git_find_commits_by_prefix`'s own cap (history.rs): a list this long may be cut.
const PREFIX_LOOKUP_CAP: usize = 20;
/// Files in the way that a refusal lists.
const PICK_PATHS_CAP: usize = 20;
/// git's refusals that name the files in a checkout's way, each followed by
/// tab-led path lines (LC_ALL=C, which the runner pins).
const WOULD_OVERWRITE_HEADERS: [&str; 4] = [
    "error: Your local changes to the following files would be overwritten by checkout:",
    "error: The following untracked working tree files would be overwritten by checkout:",
    "error: Updating the following directories would lose untracked files in them:",
    "error: The following untracked working tree files would be removed by checkout:",
];
/// `read-tree`'s would-overwrite errors (unpack-trees.c's plumbing templates, git
/// v2.51.1) as prefix and suffix around the raw path, which carries no quoting.
const DRY_RUN_REFUSALS: [(&str, &str); 5] = [
    (
        "error: Entry '",
        "' would be overwritten by merge. Cannot merge.",
    ),
    ("error: Entry '", "' not uptodate. Cannot merge."),
    ("error: Updating '", "' would lose untracked files in it"),
    (
        "error: Untracked working tree file '",
        "' would be overwritten by merge.",
    ),
    (
        "error: Untracked working tree file '",
        "' would be removed by merge.",
    ),
];

/// One ref of the submodule's, for the commit picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleRef {
    /// The full ref name, the only spelling a rev argument takes.
    pub rev: String,
    /// `rev` with exactly its `refs/heads/`, `refs/remotes/` or `refs/tags/` stripped.
    pub name: String,
    /// The commit it reaches, an annotated tag peeled.
    pub sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleRefs {
    /// Anything but `Ok`: no git ran inside the folder and every list is empty.
    pub checkout: SubmoduleCheckout,
    pub reason: Option<String>,
    /// The parent index's stage-0 gitlink; None = the path has none.
    pub pointer: Option<String>,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub shallow: Option<bool>,
    /// The listed ref `submodule update --remote` follows; None when it isn't listed
    /// or a read behind it failed.
    pub default_rev: Option<String>,
    pub branches: Vec<SubmoduleRef>,
    pub remote_branches: Vec<SubmoduleRef>,
    pub tags: Vec<SubmoduleRef>,
    /// A list was cut at its cap.
    pub truncated: bool,
    /// Refs skipped because they name an object the submodule's store lacks.
    pub broken_refs: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmodulePickMove {
    CheckOut,
    AlreadyThere,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmodulePickBlock {
    NotInitialized,
    Unusable,
    NoPointer,
    MidOperation,
    SubmoduleMidOperation,
    NotFetched,
    NotFound,
    Ambiguous,
    NotACommit,
    DetachedOrphan,
    DetachedUnverified,
    WouldOverwrite,
    CheckFailed,
}

/// What a pick would do, as of one read. Advisory: the setter measures again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SubmodulePickPlan {
    Ready {
        checkout: SubmodulePickMove,
    },
    /// The pointer and the checkout are both at the pick already.
    Current,
    Blocked {
        why: SubmodulePickBlock,
        reason: Option<String>,
        /// A would-overwrite plan's paths: git's first refused path, or the ignored
        /// paths in the way, never git's full list; the setter's outcome carries
        /// git's list, at most 20.
        paths: Vec<String>,
    },
}

/// The pick against the parent's pointer; `Rewind` moves the parent backwards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SubmodulePickRelation {
    Unknown,
    Same,
    Forward { ahead: u32 },
    Rewind { behind: u32 },
    Diverged { ahead: u32, behind: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmodulePickRead {
    /// The resolved commit, lower-cased; a not-fetched read echoes the typed full id.
    pub sha: Option<String>,
    pub commit: Option<SubmoduleRefCommit>,
    pub pointer: Option<String>,
    pub plan: SubmodulePickPlan,
    pub relation: SubmodulePickRelation,
    pub shallow: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmodulePickUnstaged {
    PointerMoved,
    StageFailed,
    StageUnconfirmed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SubmodulePickOutcome {
    /// The submodule is at `sha` and the pointer is staged there.
    Set {
        sha: String,
        checkout: SubmodulePickMove,
        nested_left: Option<u32>,
    },
    /// The pointer, or the checkout's existence, moved since the call was decided.
    Changed,
    Blocked {
        why: SubmodulePickBlock,
        reason: Option<String>,
        paths: Vec<String>,
    },
    /// Nothing was staged; the checkout may have moved files or HEAD.
    CheckoutFailed { reason: String },
    /// The submodule is at `sha`; the pointer was not (or may not have been) staged.
    CheckedOutNotStaged {
        sha: String,
        why: SubmodulePickUnstaged,
        reason: Option<String>,
    },
}

/// The refusal sentence for a pick, `why` completing "— {why}".
fn pick_refusal(path: &str, why: &str) -> AppError {
    let shown = crate::git::ops::discard_shown(path);
    AppError::InvalidArgument(format!(
        "Can't choose a commit for the submodule at {shown} — {why}. Nothing was changed."
    ))
}

/// The refusal sentence for a submodule fetch.
fn fetch_refusal(path: &str, why: &str) -> AppError {
    let shown = crate::git::ops::discard_shown(path);
    AppError::InvalidArgument(format!(
        "Can't fetch the submodule at {shown} — {why}. Nothing was fetched."
    ))
}

/// A write's path through the shared lexical gate, a leading `-` included, refused in
/// the operation's own sentence; returns git's spelling. A trailing slash is refused:
/// the gate keeps it, and the index's gitlink path never matches that spelling.
fn submodule_write_path(path: &str, refusal: fn(&str, &str) -> AppError) -> AppResult<String> {
    if path.starts_with('-') {
        return Err(refusal(path, "its path starts with \"-\""));
    }
    let spelled = crate::git::ops::discard_rel_path(path).map_err(|why| refusal(path, why))?;
    if spelled.ends_with('/') {
        return Err(refusal(path, "its path ends with a slash"));
    }
    Ok(spelled)
}

fn pick_rel_path(path: &str) -> AppResult<String> {
    submodule_write_path(path, pick_refusal)
}

fn fetch_rel_path(path: &str) -> AppResult<String> {
    submodule_write_path(path, fetch_refusal)
}

/// A link or junction on the way to the path refuses, in the operation's sentence.
/// `include_leaf` is false, so a link AT the path takes either shape: a Windows
/// directory link refuses here, any other link is the gate's `Replaced` answer.
async fn refuse_linked_submodule_path(
    repo_path: &str,
    path: &str,
    refusal: fn(&str, &str) -> AppError,
) -> AppResult<()> {
    match refuse_linked_path(repo_path, path, false).await {
        Err(AppError::InvalidArgument(_)) => Err(refusal(path, crate::git::ops::DISCARD_LINKED)),
        other => other,
    }
}

/// `discard_shown` names an empty input "an empty path", which an id isn't.
fn invalid_commit_id(id: &str) -> AppError {
    let shown = if id.trim().is_empty() {
        "an empty id".to_string()
    } else {
        crate::git::ops::discard_shown(id)
    };
    AppError::InvalidArgument(format!("invalid commit id: {shown}"))
}

/// What the pick's gate measured: the folder probe and, only when it found the
/// submodule's own `.git`, one status read. A failed read is `Unreadable` with its
/// reason, never clean. `head` is None on an unborn branch.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PickGate {
    checkout: SubmoduleCheckout,
    reason: Option<String>,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
}

async fn pick_gate(repo_path: &str, path: &str) -> (String, PickGate) {
    let worktree = Path::new(repo_path).join(path);
    let (checkout, reason) = checkout_from_probe(std::fs::symlink_metadata(&worktree), || {
        worktree.join(".git").try_exists()
    });
    let dir = worktree.to_string_lossy().into_owned();
    let mut gate = PickGate {
        checkout,
        reason,
        head: None,
        branch: None,
        detached: false,
    };
    if checkout != SubmoduleCheckout::Ok {
        return (dir, gate);
    }
    let args = [
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=no",
        "-z",
    ];
    match run_git_raw(Some(&dir), &args, DEFAULT_TIMEOUT).await {
        Ok(out) if out.code == 0 => {
            let status = crate::git::status::parse_status_v2(&out.stdout_lossy());
            gate.head = status.branch.oid;
            gate.branch = status.branch.name;
            gate.detached = status.branch.detached;
        }
        Ok(out) => {
            gate.checkout = SubmoduleCheckout::Unreadable;
            gate.reason = Some(unreadable_reason(&out.stderr, out.code));
        }
        Err(e) => {
            gate.checkout = SubmoduleCheckout::Unreadable;
            gate.reason = Some(nonempty_reason(e.to_string()));
        }
    }
    (dir, gate)
}

/// One mid-operation probe's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
enum MidOpFact {
    Clear,
    /// The reason is the parent's refusal sentence; the submodule's arm carries none.
    Refused(Option<String>),
    Failed(String),
}

/// What the pick's id resolved to inside the submodule.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PickTarget {
    /// `row` is the prefix lookup's, when it ran.
    Commit {
        sha: String,
        row: Option<SubmoduleRefCommit>,
    },
    NotFetched {
        sha: String,
    },
    NotACommit,
    NotFound,
    Ambiguous(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OrphanFact {
    /// A ref, the target or a recorded gitlink still reaches HEAD.
    Named,
    Orphan,
    Unverified(Option<String>),
}

/// git's dry run of the checkout, for the plan read. `Clear` also covers a scratch
/// index that couldn't be built: the setter's real checkout decides then.
#[derive(Debug, Clone, PartialEq, Eq)]
enum OverwriteFact {
    Clear,
    Blocked(Vec<String>),
    Failed(String),
}

/// What one pick measured so far; None = not read yet. ONE gatherer fills it for the
/// plan read and the setter, in [`plan_pick`]'s order, so the two can't drift.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PickFacts {
    gate: PickGate,
    pointer: Option<Option<String>>,
    parent_mid_op: Option<MidOpFact>,
    child_mid_op: Option<MidOpFact>,
    target: Option<PickTarget>,
    head_tree_pointer: Option<Option<String>>,
    shallow: Option<Option<bool>>,
    orphan: Option<OrphanFact>,
    overwrite: Option<OverwriteFact>,
    /// The plan read predicts the checkout's refusals; the setter's real checkout
    /// decides them instead.
    with_overwrite: bool,
}

impl PickFacts {
    fn new(gate: PickGate, with_overwrite: bool) -> Self {
        PickFacts {
            gate,
            pointer: None,
            parent_mid_op: None,
            child_mid_op: None,
            target: None,
            head_tree_pointer: None,
            shallow: None,
            orphan: None,
            overwrite: None,
            with_overwrite,
        }
    }

    fn target_sha(&self) -> Option<&str> {
        match &self.target {
            Some(PickTarget::Commit { sha, .. }) => Some(sha),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PickNeed {
    Pointer,
    ParentMidOp,
    ChildMidOp,
    Target,
    HeadTreePointer,
    Orphan,
    Overwrite,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PickStep {
    Plan(SubmodulePickPlan),
    Need(PickNeed),
}

/// Pure, no I/O: the plan once the facts decide it, else the next fact to read.
/// First match wins and a blocking arm stops the gathering.
fn plan_pick(facts: &PickFacts) -> PickStep {
    use SubmodulePickBlock as B;
    let block = |why, reason: Option<&str>| {
        PickStep::Plan(SubmodulePickPlan::Blocked {
            why,
            reason: reason.map(str::to_string),
            paths: Vec::new(),
        })
    };
    match facts.gate.checkout {
        SubmoduleCheckout::NotInitialized | SubmoduleCheckout::Missing => {
            return block(B::NotInitialized, None)
        }
        SubmoduleCheckout::Replaced | SubmoduleCheckout::Unreadable => {
            return block(B::Unusable, facts.gate.reason.as_deref())
        }
        SubmoduleCheckout::Ok => {}
    }
    let pointer = match &facts.pointer {
        None => return PickStep::Need(PickNeed::Pointer),
        Some(None) => return block(B::NoPointer, None),
        Some(Some(pointer)) => pointer.as_str(),
    };
    for (fact, need, refused) in [
        (&facts.parent_mid_op, PickNeed::ParentMidOp, B::MidOperation),
        (
            &facts.child_mid_op,
            PickNeed::ChildMidOp,
            B::SubmoduleMidOperation,
        ),
    ] {
        match fact {
            None => return PickStep::Need(need),
            Some(MidOpFact::Refused(reason)) => return block(refused, reason.as_deref()),
            Some(MidOpFact::Failed(reason)) => return block(B::CheckFailed, Some(reason)),
            Some(MidOpFact::Clear) => {}
        }
    }
    let sha = match &facts.target {
        None => return PickStep::Need(PickNeed::Target),
        Some(PickTarget::Commit { sha, .. }) => sha.as_str(),
        Some(PickTarget::NotFetched { .. }) => return block(B::NotFetched, None),
        Some(PickTarget::NotACommit) => return block(B::NotACommit, None),
        Some(PickTarget::NotFound) => return block(B::NotFound, None),
        Some(PickTarget::Ambiguous(reason)) => return block(B::Ambiguous, Some(reason)),
    };
    let head = facts.gate.head.as_deref();
    if head == Some(sha) {
        return PickStep::Plan(if pointer == sha {
            SubmodulePickPlan::Current
        } else {
            SubmodulePickPlan::Ready {
                checkout: SubmodulePickMove::AlreadyThere,
            }
        });
    }
    // A detached HEAD the parent records nowhere is probed: moving it can leave
    // commits no ref names, as git's own "leaving N commits behind" warns.
    if facts.gate.detached && head != Some(pointer) {
        match &facts.head_tree_pointer {
            None => return PickStep::Need(PickNeed::HeadTreePointer),
            Some(Some(tree)) if Some(tree.as_str()) == head => {}
            Some(_) => match &facts.orphan {
                None => return PickStep::Need(PickNeed::Orphan),
                Some(OrphanFact::Named) => {}
                Some(OrphanFact::Orphan) => return block(B::DetachedOrphan, None),
                Some(OrphanFact::Unverified(reason)) => {
                    return block(B::DetachedUnverified, reason.as_deref())
                }
            },
        }
    }
    if facts.with_overwrite {
        match &facts.overwrite {
            None => return PickStep::Need(PickNeed::Overwrite),
            Some(OverwriteFact::Blocked(paths)) => {
                return PickStep::Plan(SubmodulePickPlan::Blocked {
                    why: B::WouldOverwrite,
                    reason: None,
                    paths: paths.clone(),
                })
            }
            Some(OverwriteFact::Failed(reason)) => return block(B::CheckFailed, Some(reason)),
            Some(OverwriteFact::Clear) => {}
        }
    }
    PickStep::Plan(SubmodulePickPlan::Ready {
        checkout: SubmodulePickMove::CheckOut,
    })
}

/// Reads the facts [`plan_pick`] asks for until it decides. A failed parent-side read
/// and a failed resolution are Errs; a failed probe inside the submodule is data.
async fn settle_pick(
    repo_path: &str,
    path: &str,
    dir: &str,
    id: &str,
    facts: &mut PickFacts,
) -> AppResult<SubmodulePickPlan> {
    let spec = crate::git::pathspec::literal(path);
    loop {
        let need = match plan_pick(facts) {
            PickStep::Plan(plan) => return Ok(plan),
            PickStep::Need(need) => need,
        };
        match need {
            PickNeed::Pointer => facts.pointer = Some(index_gitlink(repo_path, path, &spec).await?),
            PickNeed::ParentMidOp => {
                let fact = parent_mid_op(repo_path)
                    .await
                    .unwrap_or_else(|e| MidOpFact::Failed(nonempty_reason(e.to_string())));
                facts.parent_mid_op = Some(fact);
            }
            PickNeed::ChildMidOp => facts.child_mid_op = Some(submodule_mid_op(dir).await),
            PickNeed::Target => {
                let pointer_len = facts.pointer.clone().flatten().map_or(0, |p| p.len());
                facts.target = Some(resolve_pick(dir, id, pointer_len).await?);
            }
            PickNeed::HeadTreePointer => {
                facts.head_tree_pointer = Some(head_gitlink(repo_path, path, &spec).await?);
            }
            PickNeed::Orphan => {
                let shallow = match facts.shallow {
                    Some(shallow) => shallow,
                    None => submodule_is_shallow(dir).await,
                };
                facts.shallow = Some(shallow);
                let head_sha = facts.gate.head.clone().unwrap_or_default();
                let sha = facts.target_sha().unwrap_or_default().to_string();
                let recorded: Vec<String> = [&facts.pointer, &facts.head_tree_pointer]
                    .into_iter()
                    .filter_map(|gitlink| gitlink.clone().flatten())
                    .collect();
                let orphan = orphan_probe(dir, path, &head_sha, &sha, &recorded, shallow).await;
                facts.orphan = Some(orphan);
            }
            PickNeed::Overwrite => {
                let sha = facts.target_sha().unwrap_or_default().to_string();
                let overwrite = pick_dry_run(dir, facts.gate.head.as_deref(), &sha).await;
                facts.overwrite = Some(overwrite);
            }
        }
    }
}

/// The parent's mid-operation gate, the one the update path runs: its refusal is a
/// fact; a failed probe is an Err the caller maps.
async fn parent_mid_op(repo_path: &str) -> AppResult<MidOpFact> {
    match crate::git::ops::refuse_mid_op_for(repo_path, PICK_ACTION).await {
        Ok(()) => Ok(MidOpFact::Clear),
        Err(AppError::InvalidArgument(sentence)) => Ok(MidOpFact::Refused(Some(sentence))),
        Err(e) => Err(e),
    }
}

/// Unmerged entries or an operation in flight inside the submodule: a checkout there
/// exits 0 mid-rebase and leaves `rebase-merge` behind (measured). Strict on the git
/// dir, since the fail-open `op_state` reads an unresolvable one as "nothing".
async fn submodule_mid_op(dir: &str) -> MidOpFact {
    match crate::git::ops::has_unmerged(dir).await {
        Ok(true) => return MidOpFact::Refused(None),
        Ok(false) => {}
        Err(e) => return MidOpFact::Failed(nonempty_reason(e.to_string())),
    }
    match crate::git::ops::op_state_strict(dir).await {
        Ok(state) if state.mid_op() => MidOpFact::Refused(None),
        Ok(_) => MidOpFact::Clear,
        Err(e) => MidOpFact::Failed(nonempty_reason(e.to_string())),
    }
}

/// The id is full when it is as long as the store's hashes, a prefix when shorter,
/// and refused when longer: a 64-hex id in a SHA-1 store exits 128 like an absent
/// one (measured). A prefix is looked up as object ids, never as a ref name.
async fn resolve_pick(dir: &str, id: &str, pointer_len: usize) -> AppResult<PickTarget> {
    if id.len() > pointer_len {
        return Err(invalid_commit_id(id));
    }
    if id.len() < pointer_len {
        let found =
            crate::git::history::git_find_commits_by_prefix(dir.to_string(), id.to_string())
                .await?;
        return Ok(prefix_target(
            id,
            found.into_iter().map(|found| found.commit).collect(),
        ));
    }
    // `cat-file -e <tag>^{commit}` exits 0, so the type is read instead (measured).
    let out = run_git_raw(Some(dir), &["cat-file", "-t", id], DEFAULT_TIMEOUT).await?;
    let kind = out.stdout_lossy();
    Ok(match (out.code, kind.trim()) {
        (0, "commit") => PickTarget::Commit {
            sha: id.to_string(),
            row: None,
        },
        (0, _) => PickTarget::NotACommit,
        _ => PickTarget::NotFetched {
            sha: id.to_string(),
        },
    })
}

fn prefix_target(prefix: &str, mut rows: Vec<CommitSummary>) -> PickTarget {
    match rows.len() {
        0 => PickTarget::NotFound,
        1 => {
            let row = rows.remove(0);
            PickTarget::Commit {
                sha: row.hash.to_ascii_lowercase(),
                row: Some(ref_commit(row)),
            }
        }
        n if n >= PREFIX_LOOKUP_CAP => PickTarget::Ambiguous(format!(
            "{PREFIX_LOOKUP_CAP} or more commits start with {prefix}"
        )),
        n => PickTarget::Ambiguous(format!("{n} commits start with {prefix}")),
    }
}

fn ref_commit(row: CommitSummary) -> SubmoduleRefCommit {
    SubmoduleRefCommit {
        sha: row.hash,
        subject: row.subject,
        author: row.author,
        authored_at: row.date,
        on_remote: None,
    }
}

/// `--all` can't stand in for the ref list: it includes HEAD, so a detached orphan
/// reads clean. A recorded gitlink the store lacks stays out of the argv, where it
/// would exit 128 `bad object` (both measured). Shallow history makes a printed
/// commit inconclusive, with a reason only when the shallow probe itself failed.
async fn orphan_probe(
    dir: &str,
    path: &str,
    head_sha: &str,
    sha: &str,
    recorded: &[String],
    shallow: Option<bool>,
) -> OrphanFact {
    if !is_full_oid(head_sha) || !is_full_oid(sha) {
        return OrphanFact::Unverified(Some("the submodule's HEAD couldn't be read".into()));
    }
    let mut kept = Vec::new();
    for gitlink in recorded.iter().filter(|gitlink| is_full_oid(gitlink)) {
        match commit_present(dir, gitlink).await {
            Ok(true) => kept.push(gitlink.as_str()),
            Ok(false) => {}
            Err(e) => return OrphanFact::Unverified(Some(nonempty_reason(e.to_string()))),
        }
    }
    let mut args = vec!["rev-list", "--max-count=1", head_sha, "--not", sha];
    args.extend(kept);
    args.extend(["--branches", "--tags", "--remotes", "--"]);
    match run_git_raw(Some(dir), &args, DEFAULT_TIMEOUT).await {
        Ok(out) if out.code == 0 => {
            if out.stdout_lossy().trim().is_empty() {
                OrphanFact::Named
            } else {
                match shallow {
                    Some(false) => OrphanFact::Orphan,
                    Some(true) => OrphanFact::Unverified(None),
                    None => OrphanFact::Unverified(Some(format!(
                        "couldn't tell whether {}'s history is shallow",
                        crate::git::ops::discard_shown(path)
                    ))),
                }
            }
        }
        Ok(out) => OrphanFact::Unverified(Some(unreadable_reason(&out.stderr, out.code))),
        Err(e) => OrphanFact::Unverified(Some(nonempty_reason(e.to_string()))),
    }
}

/// A raw read's answer: stdout on exit 0, else the line a blocked plan carries.
fn read_answer(read: AppResult<GitOutput>) -> Result<String, String> {
    match read {
        Ok(out) if out.code == 0 => Ok(out.stdout_lossy()),
        Ok(out) => Err(unreadable_reason(&out.stderr, out.code)),
        Err(e) => Err(nonempty_reason(e.to_string())),
    }
}

/// The plan read's would-overwrite prediction, asked of git: `read-tree -m` hands
/// `unpack_trees` the same two-way merge `checkout` does, run here as a dry run on a
/// scratch copy of the submodule's index, so it never takes the real `index.lock`
/// and never refreshes the real index. `read-tree` doesn't preserve ignored files,
/// so a pass is followed by the ignored check. An unborn HEAD merges from the
/// store's own empty tree.
async fn pick_dry_run(dir: &str, head: Option<&str>, sha: &str) -> OverwriteFact {
    let from = match head {
        Some(head) => head.to_string(),
        None => match empty_tree(dir).await {
            Ok(empty) => empty,
            Err(reason) => return OverwriteFact::Failed(reason),
        },
    };
    let index_path = ["rev-parse", "--path-format=absolute", "--git-path", "index"];
    let index = match read_answer(run_git_raw(Some(dir), &index_path, DEFAULT_TIMEOUT).await) {
        Ok(text) => PathBuf::from(text.trim_end_matches(['\r', '\n'])),
        Err(reason) => return OverwriteFact::Failed(reason),
    };
    let Some((_scratch_dir, scratch, copied)) = build_scratch_index(index).await else {
        return OverwriteFact::Clear;
    };
    let scratch = scratch.to_string_lossy().into_owned();
    let env = [("GIT_INDEX_FILE", scratch.as_str())];
    if copied {
        // `checkout` refreshes its index in memory first. No hook: a repo's
        // `post-index-change` would otherwise run on every highlight (measured).
        let refresh = [
            "-c",
            "core.hooksPath=/dev/null",
            "update-index",
            "-q",
            "--refresh",
        ];
        // Its exit code is not a verdict: an entry it can't refresh is the dry run's.
        if let Err(e) = run_git_raw_env(Some(dir), &refresh, &env, DEFAULT_TIMEOUT).await {
            return OverwriteFact::Failed(nonempty_reason(e.to_string()));
        }
    }
    // `read-tree` honours `submodule.recurse`, which the checkout's argv turns off.
    let dry_run = [
        "read-tree",
        "-n",
        "-u",
        "-m",
        "--no-recurse-submodules",
        &from,
        sha,
    ];
    match run_git_raw_env(Some(dir), &dry_run, &env, DEFAULT_TIMEOUT).await {
        Ok(out) if out.code == 0 => {}
        Ok(out) => {
            return match dry_run_refusal(out.code, &out.stderr) {
                Some(path) => OverwriteFact::Blocked(vec![path]),
                None => OverwriteFact::Failed(unreadable_reason(&out.stderr, out.code)),
            }
        }
        Err(e) => return OverwriteFact::Failed(nonempty_reason(e.to_string())),
    }
    // Without an index file git checks out as an initial checkout, where every
    // target path is new to it, ignored files included (measured).
    let added_from = if copied || head.is_none() {
        from
    } else {
        match empty_tree(dir).await {
            Ok(empty) => empty,
            Err(reason) => return OverwriteFact::Failed(reason),
        }
    };
    ignored_in_the_way(dir, &added_from, sha).await
}

/// The store's own empty tree id (its hash algorithm's).
async fn empty_tree(dir: &str) -> Result<String, String> {
    let empty = run_git_raw_input(
        Some(dir),
        &["hash-object", "-t", "tree", "--stdin"],
        Some(""),
        DEFAULT_TIMEOUT,
    )
    .await;
    read_answer(empty).map(|text| text.trim().to_string())
}

/// The scratch index: the real one opened ONCE with `File::open`, whose Windows
/// share mode lets git replace the real file meanwhile (a handle without delete
/// sharing failed a concurrent `git add`, measured), its bytes and mtime read from
/// that handle. The mtime is carried: a fresh one reads a racily-clean same-size
/// edit as clean, which the checkout refuses (measured). A missing real index
/// copies nothing (the scratch then reads as unborn, as git does). None = the
/// scratch couldn't be built; the temp dir goes with the returned guard.
async fn build_scratch_index(real: PathBuf) -> Option<(tempfile::TempDir, PathBuf, bool)> {
    #[cfg(test)]
    let fault = SCRATCH_INDEX_FAULT.try_with(Arc::clone).ok();
    let built = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<_> {
        use std::io::{Read, Write};
        let dir = crate::agent_sandbox::private_temp_dir(SCRATCH_INDEX_PREFIX)?;
        // Stale siblings sit beside the fresh folder, which is younger than the age gate.
        if let Some(root) = dir.path().parent() {
            sweep_stale_scratch(root, SCRATCH_SWEEP_AGE);
        }
        #[cfg(test)]
        if let Some(fault) = fault {
            *fault.lock().unwrap() = Some(dir.path().to_path_buf());
            return Err(std::io::Error::other("scratch index fault"));
        }
        let scratch = dir.path().join("index");
        let mut source = match std::fs::File::open(&real) {
            Ok(source) => source,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((dir, scratch, false)),
            Err(e) => return Err(e),
        };
        let mut bytes = Vec::new();
        source.read_to_end(&mut bytes)?;
        let modified = source.metadata()?.modified()?;
        drop(source);
        // A writable handle: Windows refuses `set_modified` on a read-only one.
        let mut copy = std::fs::File::create_new(&scratch)?;
        copy.write_all(&bytes)?;
        copy.set_modified(modified)?;
        Ok((dir, scratch, true))
    })
    .await;
    built.ok()?.ok()
}

const SCRATCH_INDEX_PREFIX: &str = "gd-pick-index-";

/// Older than any plan read runs, so a concurrent read in another instance keeps its
/// scratch.
const SCRATCH_SWEEP_AGE: Duration = Duration::from_secs(10 * 60);

/// Removes scratch folders a timed-out read left behind: a killed git can still hold
/// the scratch when its guard drops on Windows. Best effort, every error ignored;
/// only real directories with the scratch prefix, never a link.
fn sweep_stale_scratch(root: &Path, age: Duration) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(SCRATCH_INDEX_PREFIX)
        {
            continue;
        }
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        let stale = meta
            .modified()
            .ok()
            .and_then(|at| at.elapsed().ok())
            .is_some_and(|elapsed| elapsed > age);
        if meta.is_dir() && stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

// Test-only fault: a task scoped to it fails the scratch build once its folder
// exists, recording that folder, the one degrade no on-disk fixture produces.
#[cfg(test)]
tokio::task_local! {
    static SCRATCH_INDEX_FAULT: Arc<std::sync::Mutex<Option<PathBuf>>>;
}

/// The path a `read-tree` refusal names, when its stderr is exactly one of git's
/// would-overwrite errors (exit 128); anything else is not a would-overwrite.
fn dry_run_refusal(code: i32, stderr: &str) -> Option<String> {
    if code != 128 {
        return None;
    }
    let mut lines = stderr
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.trim().is_empty());
    let line = lines.next()?;
    if lines.next().is_some() {
        return None;
    }
    DRY_RUN_REFUSALS.iter().find_map(|(prefix, suffix)| {
        line.strip_prefix(prefix)?
            .strip_suffix(suffix)
            .filter(|path| !path.is_empty())
            .map(str::to_string)
    })
}

/// What a candidate path's disk entry is; an lstat that neither found the entry nor
/// answered NotFound / NotADirectory is unanswered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OnDisk {
    Missing,
    NonDirectory,
    Directory,
}

fn on_disk(base: &Path, rel: &str) -> std::io::Result<OnDisk> {
    match std::fs::symlink_metadata(base.join(rel)) {
        Ok(meta) if meta.is_dir() => Ok(OnDisk::Directory),
        Ok(_) => Ok(OnDisk::NonDirectory),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(OnDisk::Missing)
        }
        Err(e) => Err(e),
    }
}

/// Where an ignored file can sit in the way of a path the target adds: the first
/// leading component that is a non-directory on disk, else the path itself when it
/// is one, else the path as a directory unless the target puts a gitlink there
/// (git leaves a directory under a gitlink alone, measured). An unanswered lstat
/// is an Err.
fn ignored_candidates(
    base: &Path,
    added: &[(String, bool)],
    disk: impl Fn(&Path, &str) -> std::io::Result<OnDisk>,
) -> std::io::Result<Vec<String>> {
    let mut candidates: Vec<String> = Vec::new();
    for (path, gitlink) in added {
        let mut found = None;
        for (at, _) in path.match_indices('/') {
            if disk(base, &path[..at])? == OnDisk::NonDirectory {
                found = Some(path[..at].to_string());
                break;
            }
        }
        if found.is_none() {
            found = match disk(base, path)? {
                OnDisk::NonDirectory => Some(path.clone()),
                OnDisk::Directory if !gitlink => Some(path.clone()),
                _ => None,
            };
        }
        if let Some(found) = found.filter(|found| !candidates.contains(found)) {
            candidates.push(found);
        }
    }
    Ok(candidates)
}

/// Ignored files in the way of what the target adds, which `read-tree` replaces
/// where the checkout (`--no-overwrite-ignore`) refuses. Skipped in a sparse
/// checkout, where an untracked file at an excluded path the target adds went
/// through (measured), and when a candidate's lstat went unanswered.
async fn ignored_in_the_way(dir: &str, from: &str, sha: &str) -> OverwriteFact {
    let sparse = run_git_raw(
        Some(dir),
        &["config", "--type=bool", "--get", "core.sparseCheckout"],
        DEFAULT_TIMEOUT,
    )
    .await
    .and_then(config_answer);
    match sparse {
        Ok(Some(out)) if out.stdout_lossy().trim() == "true" => return OverwriteFact::Clear,
        Ok(_) => {}
        Err(e) => return OverwriteFact::Failed(nonempty_reason(e.to_string())),
    }
    let adds = [
        "diff-tree",
        "-r",
        "--raw",
        "--no-renames",
        "--diff-filter=A",
        "-z",
        from,
        sha,
    ];
    let raw = match read_answer(run_git_raw(Some(dir), &adds, DEFAULT_TIMEOUT).await) {
        Ok(raw) => raw,
        Err(reason) => return OverwriteFact::Failed(reason),
    };
    // `-z --raw`: a `:<src mode> <dst mode> …` field, then the path, each NUL-ended.
    let mut fields = raw.split('\0');
    let mut added = Vec::new();
    while let (Some(meta), Some(path)) = (fields.next(), fields.next()) {
        let Some(meta) = meta.strip_prefix(':') else {
            break;
        };
        let gitlink = meta.split(' ').nth(1) == Some(GITLINK_MODE);
        added.push((path.to_string(), gitlink));
    }
    let base = PathBuf::from(dir);
    let walked =
        tauri::async_runtime::spawn_blocking(move || ignored_candidates(&base, &added, on_disk))
            .await;
    let candidates = match walked {
        Ok(Ok(candidates)) => candidates,
        _ => return OverwriteFact::Clear,
    };
    let mut paths = Vec::new();
    // Chunked: one argv holds a bounded number of pathspecs.
    for chunk in candidates.chunks(100) {
        let specs: Vec<String> = chunk
            .iter()
            .map(|path| crate::git::pathspec::literal(path))
            .collect();
        let mut args = vec![
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
            "--",
        ];
        args.extend(specs.iter().map(String::as_str));
        let listed = match read_answer(run_git_raw(Some(dir), &args, DEFAULT_TIMEOUT).await) {
            Ok(listed) => listed,
            Err(reason) => return OverwriteFact::Failed(reason),
        };
        // An ignored nested repository lists as `nr/`; the checkout names it `nr`.
        paths.extend(
            listed
                .split('\0')
                .filter(|path| !path.is_empty())
                .map(|path| path.strip_suffix('/').unwrap_or(path).to_string()),
        );
        if paths.len() >= PICK_PATHS_CAP {
            break;
        }
    }
    if paths.is_empty() {
        return OverwriteFact::Clear;
    }
    paths.truncate(PICK_PATHS_CAP);
    OverwriteFact::Blocked(paths)
}

/// The commit's row for the plan read; a failed read is an Err.
async fn pick_commit_row(dir: &str, sha: &str) -> AppResult<Option<SubmoduleRefCommit>> {
    let out = run_git_raw(
        Some(dir),
        &[
            "log",
            "--no-walk",
            "--no-color",
            "--no-show-signature",
            crate::git::history::LOG_FORMAT,
            sha,
            "--",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?
    .exit_verdict()?;
    Ok(crate::git::history::parse_commit_log(&out.stdout_lossy())
        .into_iter()
        .next()
        .map(ref_commit))
}

/// `pointer...sha` counted inside the submodule; any failure (a commit the store
/// lacks exits 128) reads `Unknown`. Shallow history can read `Diverged` where full
/// history would read contained, never the reverse.
async fn pick_relation(dir: &str, pointer: &str, sha: &str) -> SubmodulePickRelation {
    if pointer == sha {
        return SubmodulePickRelation::Same;
    }
    if !is_full_oid(pointer) || !is_full_oid(sha) {
        return SubmodulePickRelation::Unknown;
    }
    let range = format!("{pointer}...{sha}");
    let Ok(out) = run_git_raw(
        Some(dir),
        &["rev-list", "--left-right", "--count", &range],
        DEFAULT_TIMEOUT,
    )
    .await
    else {
        return SubmodulePickRelation::Unknown;
    };
    let text = out.stdout_lossy();
    let counts = (out.code == 0)
        .then(|| text.trim().split_once('\t'))
        .flatten()
        .and_then(|(left, right)| Some((left.parse::<u32>().ok()?, right.parse::<u32>().ok()?)));
    match counts {
        Some((0, 0)) => SubmodulePickRelation::Same,
        Some((0, ahead)) => SubmodulePickRelation::Forward { ahead },
        Some((behind, 0)) => SubmodulePickRelation::Rewind { behind },
        Some((behind, ahead)) => SubmodulePickRelation::Diverged { ahead, behind },
        None => SubmodulePickRelation::Unknown,
    }
}

/// The plan for checking out `sha` (4..=64 hex, any case: a full id or a prefix) in
/// the submodule at `path` and staging the parent's pointer there. Read-only and
/// lock-free; every git run is sequential, so the command future stays small.
#[tauri::command]
pub async fn git_submodule_pick_plan(
    repo_path: String,
    path: String,
    sha: String,
) -> AppResult<SubmodulePickRead> {
    git_submodule_pick_plan_core(&repo_path, &path, &sha).await
}

pub(crate) async fn git_submodule_pick_plan_core(
    repo_path: &str,
    path: &str,
    sha: &str,
) -> AppResult<SubmodulePickRead> {
    validate_repo_relative(path, "submodule path")?;
    let id = sha.trim().to_ascii_lowercase();
    if !(4..=64).contains(&id.len()) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid_commit_id(sha));
    }
    let (dir, gate) = pick_gate(repo_path, path).await;
    let mut facts = PickFacts::new(gate, true);
    let plan = settle_pick(repo_path, path, &dir, &id, &mut facts).await?;

    let pointer = match facts.pointer.take() {
        Some(pointer) => pointer,
        None => index_gitlink(repo_path, path, &crate::git::pathspec::literal(path)).await?,
    };
    let shallow = match facts.shallow {
        Some(shallow) => shallow,
        None if facts.gate.checkout == SubmoduleCheckout::Ok => submodule_is_shallow(&dir).await,
        None => None,
    };
    let (sha, mut commit) = match facts.target.take() {
        Some(PickTarget::Commit { sha, row }) => {
            let row = match row {
                Some(row) => Some(row),
                None => pick_commit_row(&dir, &sha).await?,
            };
            (Some(sha), row)
        }
        Some(PickTarget::NotFetched { sha }) => (Some(sha), None),
        _ => (None, None),
    };
    let relation = match (&pointer, &sha, &commit) {
        (Some(pointer), Some(sha), Some(_)) => pick_relation(&dir, pointer, sha).await,
        _ => SubmodulePickRelation::Unknown,
    };
    if let Some(commit) = commit.as_mut() {
        commit.on_remote = remote_reach(&dir, std::slice::from_ref(&commit.sha), shallow)
            .await
            .pop()
            .flatten();
    }
    Ok(SubmodulePickRead {
        sha,
        commit,
        pointer,
        plan,
        relation,
        shallow,
    })
}

#[cfg(test)]
type PickLandedHook =
    Arc<dyn Fn() -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync>;

#[cfg(test)]
tokio::task_local! {
    /// Awaited between a pick's landed checkout and its last pointer compare, so a
    /// test can move the pointer there.
    static PICK_LANDED_HOOK: PickLandedHook;
}

#[cfg(test)]
async fn pick_landed_hook() {
    if let Ok(landed) = PICK_LANDED_HOOK.try_with(|hook| hook()) {
        landed.await;
    }
}

#[cfg(not(test))]
async fn pick_landed_hook() {}

/// Checks `sha` (a full commit id) out inside the submodule at `path`, then stages
/// the parent's pointer there, only once that checkout landed: a pointer-only stage
/// is undone by the next `git add` of the row. `expected_index_sha` is the pointer
/// the pick was read against; a move answers `Changed`.
#[tauri::command]
pub async fn git_submodule_set_commit(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    sha: String,
    expected_index_sha: String,
) -> AppResult<SubmodulePickOutcome> {
    git_submodule_set_commit_core(&state, &repo_path, &path, &sha, &expected_index_sha).await
}

pub(crate) async fn git_submodule_set_commit_core(
    state: &AppState,
    repo_path: &str,
    path: &str,
    sha: &str,
    expected_index_sha: &str,
) -> AppResult<SubmodulePickOutcome> {
    set_submodule_commit_within(
        state,
        repo_path,
        path,
        sha,
        expected_index_sha,
        LOCK_WAIT_TIMEOUT,
    )
    .await
}

/// The pick, with the bound on its wait for the submodule's own working tree as a
/// parameter so a test can shorten it. git has no index compare-and-swap, so the
/// pointer is compared three times under the hold: on entry, after the child wait
/// and the probes, and right after the checkout landed. Once it landed nothing
/// rolls back and no error escapes: each failure is `CheckedOutNotStaged`.
async fn set_submodule_commit_within(
    state: &AppState,
    repo_path: &str,
    path: &str,
    sha: &str,
    expected_index_sha: &str,
    submodule_wait: Duration,
) -> AppResult<SubmodulePickOutcome> {
    let path = pick_rel_path(path)?;
    let sha = sha.trim().to_ascii_lowercase();
    let expected = expected_index_sha.trim().to_ascii_lowercase();
    for id in [&sha, &expected] {
        if !is_full_oid(id) {
            return Err(invalid_commit_id(id));
        }
    }
    if sha.len() != expected.len() {
        return Err(invalid_commit_id(&sha));
    }

    // One hold across the compares, the checkout and the stage. Lock-free runners only
    // while held (see `run_git_mutating`).
    let domain = state.working_tree_lock(repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, PICK_HOLDER).await?;
    refuse_linked_submodule_path(repo_path, &path, pick_refusal).await?;
    let spec = crate::git::pathspec::literal(&path);
    match index_gitlink(repo_path, &path, &spec).await? {
        // A 64/64 pair against a SHA-1 store would otherwise read as moved.
        Some(live) if live.len() != sha.len() => return Err(invalid_commit_id(&sha)),
        Some(live) if live == expected => {}
        _ => return Ok(SubmodulePickOutcome::Changed),
    }
    if let MidOpFact::Refused(reason) = parent_mid_op(repo_path).await? {
        return Ok(SubmodulePickOutcome::Blocked {
            why: SubmodulePickBlock::MidOperation,
            reason,
            paths: Vec::new(),
        });
    }

    // The submodule's own working-tree domain, parent then child as the accept takes
    // them. Only a folder the gate reads as checked out has one: any other spelling
    // resolves to the parent's checkout and would cache that key for the folder.
    let worktree = Path::new(repo_path).join(&path);
    let (decided, _) = checkout_from_probe(std::fs::symlink_metadata(&worktree), || {
        worktree.join(".git").try_exists()
    });
    let dir = worktree.to_string_lossy().into_owned();
    let child_domain = if decided == SubmoduleCheckout::Ok {
        Some(state.working_tree_lock(&dir).await)
    } else {
        None
    }
    .filter(|child| !Arc::ptr_eq(&child.lock(), &domain.lock()));
    let _child_guard = match &child_domain {
        Some(child) => {
            #[cfg(test)]
            let _ = CHILD_WAIT_HOOK.try_with(|hook| hook());
            Some(acquire_repo_lock(child, submodule_wait, PICK_HOLDER).await?)
        }
        None => None,
    };

    let (_, gate) = pick_gate(repo_path, &path).await;
    // A checkout that appeared after the hold was decided would be moved unheld.
    if gate.checkout == SubmoduleCheckout::Ok && decided != SubmoduleCheckout::Ok {
        return Ok(SubmodulePickOutcome::Changed);
    }
    let head_before = gate.head.clone();
    let mut facts = PickFacts::new(gate, false);
    facts.pointer = Some(Some(expected.clone()));
    facts.parent_mid_op = Some(MidOpFact::Clear);
    let checkout = match settle_pick(repo_path, &path, &dir, &sha, &mut facts).await? {
        SubmodulePickPlan::Blocked { why, reason, paths } => {
            return Ok(SubmodulePickOutcome::Blocked { why, reason, paths })
        }
        SubmodulePickPlan::Current => {
            return Ok(SubmodulePickOutcome::Set {
                checkout: SubmodulePickMove::AlreadyThere,
                nested_left: nested_left(&dir).await,
                sha,
            })
        }
        SubmodulePickPlan::Ready { checkout } => checkout,
    };

    // Again after the child wait and the probes: git outside the app can move it.
    if index_gitlink(repo_path, &path, &spec).await?.as_deref() != Some(expected.as_str()) {
        return Ok(SubmodulePickOutcome::Changed);
    }
    if checkout == SubmodulePickMove::CheckOut {
        let moved = detach_submodule_at(&dir, &sha).await;
        if !matches!(&moved, Ok(out) if out.code == 0) {
            return Ok(pick_checkout_verdict(&dir, head_before.as_deref(), moved).await);
        }
        pick_landed_hook().await;
        // The last compare, right before the write. A moved pointer is left alone.
        let unstaged = |why, reason| SubmodulePickOutcome::CheckedOutNotStaged {
            sha: sha.clone(),
            why,
            reason,
        };
        match index_gitlink(repo_path, &path, &spec).await {
            Ok(Some(live)) if live == expected => {}
            Ok(_) => return Ok(unstaged(SubmodulePickUnstaged::PointerMoved, None)),
            Err(e) => {
                return Ok(unstaged(
                    SubmodulePickUnstaged::StageFailed,
                    Some(nonempty_reason(e.to_string())),
                ))
            }
        }
    }
    // A path, not a pathspec: git's spelling from the gate, passed raw. Never `--add`:
    // the compares above proved a stage-0 gitlink is there.
    let info = format!("{GITLINK_MODE},{sha},{path}");
    let staged = run_git_raw_index_retry(
        repo_path,
        &["update-index", "--cacheinfo", &info],
        DEFAULT_TIMEOUT,
    )
    .await;
    let failed = match staged {
        Ok(out) if out.code == 0 => None,
        Ok(out) => Some((
            SubmodulePickUnstaged::StageFailed,
            unreadable_reason(&out.stderr, out.code),
        )),
        Err(e @ AppError::Timeout(_)) => {
            Some((SubmodulePickUnstaged::StageUnconfirmed, e.to_string()))
        }
        Err(e) => Some((
            SubmodulePickUnstaged::StageFailed,
            nonempty_reason(e.to_string()),
        )),
    };
    if let Some((why, reason)) = failed {
        return Ok(SubmodulePickOutcome::CheckedOutNotStaged {
            sha,
            why,
            reason: Some(reason),
        });
    }
    Ok(SubmodulePickOutcome::Set {
        checkout,
        nested_left: nested_left(&dir).await,
        sha,
    })
}

/// A checkout that didn't exit 0. Only git's own refusal, with HEAD re-read and still
/// where it was, is "in the way": a failing post-checkout hook can print a forged
/// header after HEAD moved (measured), and tab-led lines alone decide nothing.
async fn pick_checkout_verdict(
    dir: &str,
    head_before: Option<&str>,
    moved: AppResult<GitOutput>,
) -> SubmodulePickOutcome {
    let out = match moved {
        Ok(out) => out,
        Err(e) => {
            return SubmodulePickOutcome::CheckoutFailed {
                reason: nonempty_reason(e.to_string()),
            }
        }
    };
    if let Some((header, paths)) = would_overwrite(&out.stderr) {
        let head_after = run_git_raw(
            Some(dir),
            &["rev-parse", "--verify", "HEAD"],
            DEFAULT_TIMEOUT,
        )
        .await
        .ok()
        .filter(|after| after.code == 0)
        .map(|after| after.stdout_lossy().trim().to_string());
        if head_after.is_some() && head_after.as_deref() == head_before {
            return SubmodulePickOutcome::Blocked {
                why: SubmodulePickBlock::WouldOverwrite,
                reason: Some(header),
                paths,
            };
        }
    }
    SubmodulePickOutcome::CheckoutFailed {
        reason: checkout_failure_reason(&out.stderr, out.code),
    }
}

/// git's first `error:` or `fatal:` line, else the last non-empty one: git prints
/// every informational line about the move (an orphan warning's block included)
/// before a post-checkout hook runs, so the last line is the hook's or git's own.
fn checkout_failure_reason(stderr: &str, code: i32) -> String {
    let mut lines = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty());
    let line = lines
        .clone()
        .find(|line| line.starts_with("error:") || line.starts_with("fatal:"))
        .or_else(|| lines.next_back());
    unreadable_reason(line.unwrap_or(""), code)
}

/// The first of git's would-overwrite headers and the tab-led paths after each one.
fn would_overwrite(stderr: &str) -> Option<(String, Vec<String>)> {
    let mut header = None;
    let mut paths = Vec::new();
    let mut listing = false;
    for line in stderr.lines() {
        if WOULD_OVERWRITE_HEADERS.contains(&line) {
            header.get_or_insert_with(|| line.to_string());
            listing = true;
        } else if let Some(path) = line.strip_prefix('\t').filter(|_| listing) {
            if paths.len() < PICK_PATHS_CAP {
                paths.push(path.to_string());
            }
        } else {
            listing = false;
        }
    }
    header
        .filter(|_| !paths.is_empty())
        .map(|header| (header, paths))
}

/// Nested submodules the pick left at another commit than it records (`+` rows of
/// `submodule status`); None when the read failed.
async fn nested_left(dir: &str) -> Option<u32> {
    let out = run_git_raw(Some(dir), &["submodule", "status"], DEFAULT_TIMEOUT)
        .await
        .ok()?;
    if out.code != 0 {
        return None;
    }
    let left = out
        .stdout_lossy()
        .lines()
        .filter(|line| line.starts_with('+'))
        .count();
    u32::try_from(left).ok()
}

/// The submodule's branches, remote branches and tags for the commit picker, with
/// the pointer, checkout and default the picker opens on. Read-only and lock-free.
#[tauri::command]
pub async fn git_submodule_refs(repo_path: String, path: String) -> AppResult<SubmoduleRefs> {
    git_submodule_refs_core(&repo_path, &path).await
}

pub(crate) async fn git_submodule_refs_core(
    repo_path: &str,
    path: &str,
) -> AppResult<SubmoduleRefs> {
    submodule_refs_capped(repo_path, path, SUBMODULE_REFS_CAP).await
}

/// The listing reads no object: the object-atom form exits 128 on a ref naming a
/// missing object and lists nothing, while this one lists it and one batch-check
/// sorts it out (measured). A failed remotes read fails the listing: a guessed
/// split would leak session branches.
async fn submodule_refs_capped(
    repo_path: &str,
    path: &str,
    cap: usize,
) -> AppResult<SubmoduleRefs> {
    validate_repo_relative(path, "submodule path")?;
    let spec = crate::git::pathspec::literal(path);
    let pointer = index_gitlink(repo_path, path, &spec).await?;
    let (dir, gate) = pick_gate(repo_path, path).await;
    let mut refs = SubmoduleRefs {
        checkout: gate.checkout,
        reason: gate.reason,
        pointer,
        head: None,
        branch: None,
        detached: false,
        shallow: None,
        default_rev: None,
        branches: Vec::new(),
        remote_branches: Vec::new(),
        tags: Vec::new(),
        truncated: false,
        broken_refs: 0,
    };
    if refs.checkout != SubmoduleCheckout::Ok {
        return Ok(refs);
    }
    (refs.head, refs.branch, refs.detached) = (gate.head, gate.branch, gate.detached);

    let remotes = crate::git::remote::git_remotes(dir.clone()).await?;
    let listed = run_git_raw(
        Some(&dir),
        &[
            "for-each-ref",
            "--sort=-version:refname",
            "--format=%(refname)%00%(objectname)%00%(symref)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?
    .exit_verdict()?
    .stdout_lossy();
    let mut rows = Vec::new();
    let mut symrefs = Vec::new();
    for line in listed.lines() {
        let mut fields = line.split('\0');
        let (Some(rev), Some(oid)) = (fields.next(), fields.next()) else {
            continue;
        };
        let symref = fields.next().unwrap_or("");
        if rev.is_empty() {
            continue;
        }
        if !symref.is_empty() {
            symrefs.push((rev.to_string(), symref.to_string()));
        } else if is_full_oid(oid) {
            rows.push((rev.to_string(), oid.to_string()));
        } else {
            refs.broken_refs += 1;
        }
    }

    // Two lines per ref: the object itself (`missing` = a broken ref), then its commit
    // (a tag peeled; anything but a commit is dropped).
    let typed = if rows.is_empty() {
        String::new()
    } else {
        let input: String = rows
            .iter()
            .map(|(_, oid)| format!("{oid}\n{oid}^{{commit}}\n"))
            .collect();
        run_git_input(
            Some(&dir),
            &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
            Some(&input),
            DEFAULT_TIMEOUT,
        )
        .await?
        .stdout_lossy()
    };
    let lines: Vec<&str> = typed.lines().collect();
    if lines.len() != rows.len() * 2 {
        return Err(AppError::Command(
            "Git returned an unreadable object list.".into(),
        ));
    }
    let mut tags = Vec::new();
    for ((rev, _), pair) in rows.into_iter().zip(lines.chunks(2)) {
        if pair[0].ends_with(" missing") {
            refs.broken_refs += 1;
            continue;
        }
        let Some(sha) = pair[1]
            .strip_suffix(" commit")
            .filter(|sha| is_full_oid(sha))
        else {
            continue;
        };
        let sha = sha.to_string();
        if let Some(name) = rev.strip_prefix("refs/heads/") {
            if !name.is_empty() && !crate::git::branches::is_session_branch_name(name) {
                let name = name.to_string();
                refs.branches.push(SubmoduleRef { rev, name, sha });
            }
        } else if let Some(name) = rev.strip_prefix("refs/remotes/") {
            let offered = split_remote_ref(name, &remotes).is_some_and(|(_, branch_name)| {
                branch_name != "HEAD" && !crate::git::branches::is_session_branch_name(branch_name)
            });
            if offered {
                let name = name.to_string();
                refs.remote_branches.push(SubmoduleRef { rev, name, sha });
            }
        } else if let Some(name) = rev.strip_prefix("refs/tags/") {
            if !name.is_empty() {
                let name = name.to_string();
                tags.push(SubmoduleRef { rev, name, sha });
            }
        }
    }
    refs.tags = tags;
    refs.branches.sort_by(|a, b| a.name.cmp(&b.name));
    refs.remote_branches.sort_by(|a, b| a.name.cmp(&b.name));
    for list in [
        &mut refs.branches,
        &mut refs.remote_branches,
        &mut refs.tags,
    ] {
        if list.len() > cap {
            list.truncate(cap);
            refs.truncated = true;
        }
    }
    refs.shallow = submodule_is_shallow(&dir).await;
    refs.default_rev = default_rev(
        repo_path,
        path,
        &dir,
        refs.branch.as_deref(),
        &refs.remote_branches,
        &symrefs,
    )
    .await;
    Ok(refs)
}

/// What `submodule update --remote` follows: `<b>` = the parent's
/// `submodule.<name>.branch`, else `.gitmodules`' (`.` = the parent's branch); `<r>`
/// = the submodule branch's configured remote, else `origin`. With `<b>`, the listed
/// `refs/remotes/<r>/<b>`; without, the listed target of `refs/remotes/<r>/HEAD`.
/// None when that isn't listed or any read behind it failed.
async fn default_rev(
    repo_path: &str,
    path: &str,
    dir: &str,
    branch: Option<&str>,
    remote_branches: &[SubmoduleRef],
    symrefs: &[(String, String)],
) -> Option<String> {
    let entries = gitmodules_entries(repo_path).await.ok()?;
    let (name, listed_branch) = match entries.get(path) {
        Some(entry) => (entry.name.clone(), entry.branch.clone()),
        None => (path.to_string(), None),
    };
    let configured = config_get(repo_path, &format!("submodule.{name}.branch")).await?;
    let followed = match configured.or(listed_branch) {
        Some(dot) if dot == "." => Some(
            crate::git::branches::current_branch_name(repo_path)
                .await
                .ok()??,
        ),
        other => other,
    };
    let remote = match branch {
        Some(branch_name) => config_get(dir, &format!("branch.{branch_name}.remote"))
            .await?
            .unwrap_or_else(|| "origin".to_string()),
        None => "origin".to_string(),
    };
    let rev = match followed {
        Some(followed) => format!("refs/remotes/{remote}/{followed}"),
        None => {
            let remote_head = format!("refs/remotes/{remote}/HEAD");
            symrefs
                .iter()
                .find(|(rev, _)| *rev == remote_head)?
                .1
                .clone()
        }
    };
    remote_branches
        .iter()
        .any(|listed| listed.rev == rev)
        .then_some(rev)
}

/// One `config --get`: Some(None) when unset; None when the read failed.
async fn config_get(repo: &str, key: &str) -> Option<Option<String>> {
    let out = run_git_raw(Some(repo), &["config", "--get", key], DEFAULT_TIMEOUT)
        .await
        .ok()?;
    let value = config_answer(out).ok()?;
    Some(value.map(|out| {
        out.stdout_lossy()
            .trim_end_matches(['\r', '\n'])
            .to_string()
    }))
}

/// A remote-tracking ref past `refs/remotes/`, split at the longest configured remote
/// followed by `/`, else at the first `/`; None when either side would be empty. The
/// rule of git::branches' private `split_remote_tracking`, so both lists hide the same
/// session branches.
fn split_remote_ref<'a>(rest: &'a str, remotes: &[String]) -> Option<(&'a str, &'a str)> {
    let mut slash = rest.find('/')?;
    for remote in remotes {
        if remote.len() > slash
            && rest
                .strip_prefix(remote.as_str())
                .is_some_and(|tail| tail.starts_with('/'))
        {
            slash = remote.len();
        }
    }
    let (remote, name) = (&rest[..slash], &rest[slash + 1..]);
    (!remote.is_empty() && !name.is_empty()).then_some((remote, name))
}

/// Fetches the submodule at `path` from its `origin`, the plain fetch the app runs
/// elsewhere; `unshallow` also completes a shallow history.
#[tauri::command]
pub async fn git_submodule_fetch(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    unshallow: bool,
) -> AppResult<()> {
    git_submodule_fetch_core(&state, &repo_path, &path, unshallow).await
}

/// The parent's hold covers the gate and the network key's resolve, so the key is
/// minted only for a folder that is the submodule's own checkout; it is dropped before
/// the network wait, so the gate runs again last. Shallowness is measured under the
/// network hold, so a second concurrent unshallow becomes a plain fetch.
pub(crate) async fn git_submodule_fetch_core(
    state: &AppState,
    repo_path: &str,
    path: &str,
    unshallow: bool,
) -> AppResult<()> {
    let path = fetch_rel_path(path)?;
    let domain = state.working_tree_lock(repo_path).await;
    let guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a submodule fetch").await?;
    refuse_linked_submodule_path(repo_path, &path, fetch_refusal).await?;
    let worktree = Path::new(repo_path).join(&path);
    let dir = worktree.to_string_lossy().into_owned();
    let checked_out = || {
        let probe = std::fs::symlink_metadata(&worktree);
        checkout_from_probe(probe, || worktree.join(".git").try_exists()).0 == SubmoduleCheckout::Ok
    };
    if !checked_out() {
        return Err(fetch_refusal(&path, "it isn't checked out here"));
    }
    let cred = crate::forge::credential_config_for_remote(&dir, "origin").await?;
    let network = state.network_lock(&dir).await;
    drop(guard);
    let _network =
        acquire_repo_lock(&network, NETWORK_LOCK_WAIT_TIMEOUT, holder_label("fetch")).await?;
    let shallow = submodule_is_shallow(&dir).await;
    // A deinit during the wait would let git answer for the parent.
    if !checked_out() {
        return Err(fetch_refusal(&path, "it isn't checked out here"));
    }
    let args = fetch_args(unshallow, shallow).ok_or_else(|| {
        AppError::InvalidArgument(format!(
            "couldn't tell whether {}'s history is shallow; nothing was fetched",
            crate::git::ops::discard_shown(&path)
        ))
    })?;
    crate::git::remote::run_git_with_creds_once(&dir, &cred, &args, NETWORK_TIMEOUT)
        .await?
        .exit_verdict()?;
    Ok(())
}

/// `git_fetch_core`'s argv plus `--no-recurse-submodules`; `--unshallow` only on
/// history measured shallow (git refuses it on a complete repository, measured). None
/// when an unshallow was asked and the measure failed: a plain fetch would leave the
/// history cut while the call succeeds.
fn fetch_args(unshallow: bool, shallow: Option<bool>) -> Option<Vec<&'static str>> {
    let mut args = vec![
        "fetch",
        "--prune",
        "--no-prune-tags",
        "--no-recurse-submodules",
    ];
    match (unshallow, shallow) {
        (true, None) => return None,
        (true, Some(true)) => args.push("--unshallow"),
        _ => {}
    }
    Some(args)
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
        // A junction on Windows: a junction needs no privilege, unlike a symlink.
        #[cfg(windows)]
        crate::test_junction::make_junction(Path::new(&sub), Path::new(&outside));
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
            gitmodules_entries(&host).await.unwrap()["libs/dep"].url,
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
        assert_eq!(
            gitmodules_entries(&host).await.unwrap()["libs/dep"].url,
            "../dep"
        );
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
        assert_eq!(
            gitmodules_entries(&host).await.unwrap()["libs/dep"].url,
            "../dep"
        );
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
            gitmodules_entries(&host).await.unwrap()["libs/dep"].url,
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
        // `%cI`: strict ISO 8601, `YYYY-MM-DDTHH:MM:SS` then `±HH:MM`, or `Z` when the
        // committer's zone is UTC (git 2.51.1; CI runners).
        let date = commit.committed_at.as_bytes();
        let zone_ok = (date.len() == 20 && date[19] == b'Z')
            || (date.len() == 25 && matches!(date[19], b'+' | b'-'));
        assert!(
            zone_ok && date[10] == b'T',
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
            NOT_SUBMODULE_CONFLICT,
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

    /// A submodule opened as its own repository holds its own working-tree domain,
    /// spelled as git spells its toplevel. The accept waits on it, then stages
    /// nothing; once it is free the accept proceeds.
    #[tokio::test]
    async fn accept_waits_on_the_submodules_own_working_tree() {
        let f = gitlink_fixture("conflict-child-lock").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        let expected = stages_of(Some(&f.c0), Some(&f.c1), Some(&f.c2));
        let before = index_entries(&f.host).await;
        let state = AppState::default();
        let tab = git(&f.sub, &["rev-parse", "--show-toplevel"])
            .await
            .trim()
            .to_string();
        let domain = state.working_tree_lock(&tab).await;
        let held = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a test hold")
            .await
            .expect("the tab takes its hold");
        let wait = Duration::from_millis(300);
        let started = std::time::Instant::now();
        let err = accept_submodule_side_within(
            &state, &f.host, "libs/dep", "ours", &expected, true, wait,
        )
        .await
        .expect_err("the accept meets the tab's hold");
        assert!(
            matches!(&err, AppError::Busy { holder } if holder == "a test hold"),
            "got {err:?}"
        );
        assert!(started.elapsed() >= wait, "it waited before giving up");
        assert_eq!(index_entries(&f.host).await, before, "nothing staged");
        assert_eq!(head_of(&f.sub).await, f.c2);
        drop(held);

        let outcome = git_accept_submodule_conflict_side_core(
            &state, &f.host, "libs/dep", "ours", &expected, true,
        )
        .await
        .unwrap();
        assert_eq!(
            outcome,
            SubmoduleAcceptOutcome::Staged {
                sha: f.c1.clone(),
                checkout: SubmoduleAcceptCheckout::CheckedOut,
            }
        );
        assert_pointer_staged(&f.host, &f.c1).await;
        assert_eq!(head_of(&f.sub).await, f.c1);
    }

    /// Stages moved by git outside the app while the accept waits on the submodule's own
    /// working tree: the accept re-reads them before it writes and says Changed, the new
    /// stages and the checkout left as they are.
    #[tokio::test]
    async fn accept_rereads_the_stages_after_waiting_on_the_submodules_own_working_tree() {
        let f = gitlink_fixture("conflict-child-reread").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        let expected = stages_of(Some(&f.c0), Some(&f.c1), Some(&f.c2));
        let state = AppState::default();
        let tab = git(&f.sub, &["rev-parse", "--show-toplevel"])
            .await
            .trim()
            .to_string();
        let domain = state.working_tree_lock(&tab).await;
        let held = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a test hold")
            .await
            .expect("the tab takes its hold");
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let tx = std::sync::Mutex::new(Some(tx));
        let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        });
        let accept = CHILD_WAIT_HOOK.scope(
            hook,
            git_accept_submodule_conflict_side_core(
                &state, &f.host, "libs/dep", "ours", &expected, true,
            ),
        );
        let (host, c0, c1, c2) = (&f.host, &f.c0, &f.c1, &f.c2);
        let moved = async move {
            rx.await
                .expect("the accept waits on the submodule's working tree");
            conflict_at(host, Some(c0), Some(c2), Some(c1)).await;
            let stages = unmerged(host).await;
            drop(held);
            stages
        };
        let (outcome, stages) = tokio::join!(accept, moved);
        assert_eq!(outcome.unwrap(), SubmoduleAcceptOutcome::Changed);
        assert!(
            stages.contains(&format!("{} 2\tlibs/dep", f.c2)),
            "{stages}"
        );
        assert_eq!(unmerged(&f.host).await, stages, "the new stages stay");
        assert_eq!(head_of(&f.sub).await, f.c2, "the checkout stays");
    }

    /// The path resolved by git outside the app while the accept waits on the submodule's
    /// own working tree: the re-read refuses it as not conflicted, as the first read
    /// would, and the accept stages nothing.
    #[tokio::test]
    async fn accept_refuses_a_path_resolved_during_the_child_wait() {
        let f = gitlink_fixture("conflict-child-resolved").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        let expected = stages_of(Some(&f.c0), Some(&f.c1), Some(&f.c2));
        let state = AppState::default();
        let tab = git(&f.sub, &["rev-parse", "--show-toplevel"])
            .await
            .trim()
            .to_string();
        let domain = state.working_tree_lock(&tab).await;
        let held = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a test hold")
            .await
            .expect("the tab takes its hold");
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let tx = std::sync::Mutex::new(Some(tx));
        let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        });
        let accept = CHILD_WAIT_HOOK.scope(
            hook,
            git_accept_submodule_conflict_side_core(
                &state, &f.host, "libs/dep", "ours", &expected, true,
            ),
        );
        let (host, c2) = (&f.host, &f.c2);
        let resolved = async move {
            rx.await
                .expect("the accept waits on the submodule's working tree");
            stage_gitlink(host, c2).await;
            drop(held);
        };
        let (outcome, ()) = tokio::join!(accept, resolved);
        assert_invalid(outcome, NOT_CONFLICTED_REFUSAL);
        assert_pointer_staged(&f.host, &f.c2).await;
        assert_eq!(head_of(&f.sub).await, f.c2, "the checkout stays");
    }

    /// `submodule.recurse=true` would carry the accept's checkout into a nested
    /// submodule whose recorded commit differs between the two sides.
    #[tokio::test]
    async fn accept_leaves_a_nested_submodule_under_submodule_recurse() {
        allow_file_submodules();
        let dir = temp("conflict-nested");
        let root = dir.path();
        let leaf = seed_repo(root, "leaf").await;
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
        let m0 = head_of(&mid).await;
        let l1 = commit_in(&leaf, "leaf.txt", "v1").await;
        let mid_leaf = Path::new(&mid)
            .join("deep/leaf")
            .to_string_lossy()
            .into_owned();
        git(&mid_leaf, &["fetch", "-q", "origin"]).await;
        git(&mid_leaf, &["checkout", "-q", &l1]).await;
        git(&mid, &["add", "deep/leaf"]).await;
        git(&mid, &["commit", "-qm", "leaf v1"]).await;
        let m1 = head_of(&mid).await;
        git_submodule_add_core(
            &state,
            host.clone(),
            "../mid".into(),
            Some("libs/dep".into()),
            Some("main".into()),
        )
        .await
        .unwrap();
        git(&host, &["commit", "-qm", "add mid"]).await;
        let sub = sub_dir(&host);
        git(&sub, &["submodule", "update", "--init", "-q"]).await;
        let nested = Path::new(&sub)
            .join("deep/leaf")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            head_of(&nested).await,
            l1,
            "fixture: nested sits at what m1 records"
        );
        git(&sub, &["config", "submodule.recurse", "true"]).await;

        conflict_at(&host, None, Some(&m1), Some(&m0)).await;
        let expected = stages_of(None, Some(&m1), Some(&m0));
        let outcome = accept(&host, "theirs", &expected, true).await.unwrap();
        assert_eq!(
            outcome,
            SubmoduleAcceptOutcome::Staged {
                sha: m0.clone(),
                checkout: SubmoduleAcceptCheckout::CheckedOut,
            }
        );
        assert_eq!(head_of(&sub).await, m0);
        assert_eq!(head_of(&nested).await, l1, "the nested checkout stays put");
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
        let core = body(source, "git_accept_submodule_conflict_side_core");
        assert!(
            core.contains("LOCK_WAIT_TIMEOUT"),
            "the app waits the bounded default"
        );
        let write = body(source, "accept_submodule_side_within");
        let at = |needle: &str| write.find(needle).unwrap_or_else(|| panic!("{needle}"));
        assert!(at("conflict_rel_path(") < at("working_tree_lock("));
        assert!(at("working_tree_lock(") < at("acquire_repo_lock("));
        assert!(at("acquire_repo_lock(") < at("\"update-index\""));
        assert!(at("acquire_repo_lock(") < at("checkout_staged_commit("));
        // The submodule's own hold: bounded, and taken before anything reads inside it.
        let child = write
            .find("acquire_repo_lock(child, submodule_wait")
            .expect("child hold");
        assert!(at("acquire_repo_lock(") < child);
        assert!(child < at("submodule_checkout_state("));
        assert!(!write.contains("acquire_repo_lock_unbounded"));
    }

    async fn commit_page(
        host: &str,
        rev: &str,
        skip: u32,
        limit: u32,
        search: Option<&str>,
    ) -> SubmoduleCommitPage {
        git_submodule_commits_core(host, "libs/dep", rev, skip, limit, search)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn commit_list_pages_a_ref_newest_first() {
        let (_dir, host, dep) = host_with_submodule("commit-pages").await;
        let base = head_of(&dep).await;
        let first = commit_in(&dep, "dep.txt", "first").await;
        let second = commit_in(&dep, "dep.txt", "second").await;
        let third = commit_in(&dep, "dep.txt", "third").await;
        git(&sub_dir(&host), &["fetch", "-q", "origin"]).await;

        let rev = "refs/remotes/origin/main";
        let page = commit_page(&host, rev, 0, 2, None).await;
        assert_eq!(page.commits.len(), 2);
        assert_eq!(page.commits[0].sha, third);
        assert_eq!(page.commits[1].sha, second);
        assert!(page.has_more);
        let rest = commit_page(&host, rev, 2, 2, None).await;
        assert_eq!(rest.commits.len(), 2);
        assert_eq!(rest.commits[0].sha, first);
        assert_eq!(rest.commits[1].sha, base);
        assert!(!rest.has_more);

        let minimum = commit_page(&host, rev, 0, 0, None).await;
        assert_eq!(minimum.commits.len(), 1);
        assert_eq!(minimum.commits[0].sha, third);
        assert!(minimum.has_more);
        let maximum = commit_page(&host, rev, 0, 500, None).await;
        assert_eq!(maximum.commits.len(), 4);
        assert!(!maximum.has_more);
    }

    #[tokio::test]
    async fn commit_list_searches_messages_literally() {
        let (_dir, host, dep) = host_with_submodule("commit-search").await;
        let first = commit_in(&dep, "dep.txt", "fix (parser)").await;
        let second = commit_in(&dep, "dep.txt", "fix input").await;
        let bracket = commit_in(&dep, "dep.txt", "parse [input]").await;
        let dotted = commit_in(&dep, "dep.txt", "a.b x").await;
        commit_in(&dep, "dep.txt", "axb y").await;
        git(&sub_dir(&host), &["fetch", "-q", "origin"]).await;

        let rev = "refs/remotes/origin/main";
        let literal = commit_page(&host, rev, 0, 2, Some("(")).await;
        assert_eq!(literal.commits.len(), 1);
        assert_eq!(literal.commits[0].sha, first);
        for (query, expected) in [("[", bracket), ("a.b", dotted)] {
            let page = commit_page(&host, rev, 0, 2, Some(query)).await;
            assert_eq!(page.commits.len(), 1, "{query}");
            assert_eq!(page.commits[0].sha, expected);
        }
        let trimmed = commit_page(&host, rev, 0, 2, Some("  fix \n")).await;
        assert_eq!(trimmed.commits.len(), 2);
        assert_eq!(trimmed.commits[0].sha, second);
        assert_eq!(trimmed.commits[1].sha, first);
        let matched = commit_page(&host, rev, 1, 2, Some(" FIX ")).await;
        assert_eq!(matched.commits.len(), 1);
        assert_eq!(matched.commits[0].sha, first);
        assert!(!matched.has_more);
        assert_invalid(
            git_submodule_commits_core(&host, "libs/dep", rev, 0, 2, Some("fix\ninput")).await,
            "invalid commit search",
        );
    }

    #[tokio::test]
    async fn commit_list_reads_a_tag_and_a_full_oid_rev() {
        let (_dir, host, dep) = host_with_submodule("commit-refs").await;
        let sha = commit_in(&dep, "dep.txt", "tagged commit").await;
        git(&dep, &["tag", "light"]).await;
        git(&dep, &["tag", "-a", "annot", "-m", "annot"]).await;
        git(&sub_dir(&host), &["fetch", "-q", "--tags", "origin"]).await;

        for rev in ["refs/tags/light", "refs/tags/annot", &sha] {
            let page = commit_page(&host, rev, 0, 1, None).await;
            assert_eq!(page.commits[0].sha, sha, "{rev}");
        }
    }

    #[tokio::test]
    async fn commit_list_refuses_revs_that_are_not_a_full_ref_or_oid() {
        for rev in [
            "main",
            "HEAD",
            "-n",
            "refs/heads/a..b",
            "refs/heads/a^",
            "refs/heads/a@{u}",
            "refs/stash",
            "refs/heads/",
        ] {
            assert_invalid(
                git_submodule_commits_core("", "libs/dep", rev, 0, 1, None).await,
                &format!("invalid commit list ref: {rev}"),
            );
        }
    }

    #[tokio::test]
    async fn commit_list_errs_on_a_ref_the_submodule_lacks() {
        let (_dir, host, _dep) = host_with_submodule("commit-missing-ref").await;
        let result =
            git_submodule_commits_core(&host, "libs/dep", "refs/heads/nope", 0, 1, None).await;
        assert!(matches!(result, Err(AppError::Git { .. })));
    }

    #[tokio::test]
    async fn commit_list_marks_remote_reach_with_tags_counted() {
        let (_dir, host, dep) = host_with_submodule("commit-reach").await;
        let sub = sub_dir(&host);
        let local = commit_in(&sub, "local.txt", "local").await;
        let remote = commit_in(&dep, "dep.txt", "remote").await;
        git(&dep, &["switch", "-qc", "side"]).await;
        let tagged = commit_in(&dep, "tag.txt", "tag only").await;
        git(&dep, &["tag", "only-tag"]).await;
        git(&dep, &["switch", "-q", "main"]).await;
        git(&dep, &["branch", "-D", "side"]).await;
        git(&sub, &["fetch", "-q", "--tags", "origin"]).await;

        std::fs::write(Path::new(&sub).join(&local), "").unwrap();
        for (rev, sha, reached) in [
            ("refs/heads/main", local, false),
            ("refs/remotes/origin/main", remote, true),
            ("refs/tags/only-tag", tagged, true),
        ] {
            let page = commit_page(&host, rev, 0, 1, None).await;
            assert_eq!(page.shallow, Some(false));
            assert_eq!(page.commits[0].sha, sha);
            assert_eq!(page.commits[0].on_remote, Some(reached), "{rev}");
        }
    }

    #[tokio::test]
    async fn commit_list_reads_unreached_as_unknown_in_a_shallow_submodule() {
        let (_dir, host, dep) = host_with_submodule("commit-shallow").await;
        let sub = sub_dir(&host);
        commit_in(&dep, "dep.txt", "first").await;
        let middle = commit_in(&dep, "dep.txt", "middle").await;
        let tip = commit_in(&dep, "dep.txt", "tip").await;
        git(&sub, &["fetch", "-q", "origin"]).await;
        git(&sub, &["fetch", "-q", "--depth", "1", "origin"]).await;

        let page = commit_page(&host, &middle, 0, 10, None).await;
        assert_eq!(page.shallow, Some(true));
        assert_eq!(page.commits[0].sha, middle);
        assert!(page.commits.iter().all(|row| row.on_remote.is_none()));
        let remote = commit_page(&host, "refs/remotes/origin/main", 0, 10, None).await;
        assert_eq!(remote.commits[0].sha, tip);
        assert_eq!(remote.commits[0].on_remote, Some(true));
    }

    #[tokio::test]
    async fn commit_list_reads_reach_as_unknown_when_a_remote_ref_is_broken() {
        let (_dir, host, _dep) = host_with_submodule("commit-broken-ref").await;
        let sub = sub_dir(&host);
        let sha = head_of(&sub).await;
        let git_dir = git(&sub, &["rev-parse", "--absolute-git-dir"]).await;
        let origin = Path::new(git_dir.trim()).join("refs/remotes/origin");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::write(origin.join("ghost"), format!("{}\n", "1".repeat(40))).unwrap();

        let page = commit_page(&host, "refs/heads/main", 0, 10, None).await;
        assert_eq!(page.commits[0].sha, sha);
        assert!(page.commits.iter().all(|row| row.on_remote.is_none()));
    }

    #[tokio::test]
    async fn commit_list_runs_no_git_in_an_uninitialized_submodule() {
        let (_dir, host, _dep) = host_with_submodule("commit-deinit").await;
        git(&host, &["submodule", "deinit", "-f", "--", "libs/dep"]).await;
        let page = commit_page(&host, "refs/heads/main", 0, 10, None).await;
        assert_eq!(page.checkout, SubmoduleCheckout::NotInitialized);
        assert!(page.commits.is_empty());
        assert!(!page.has_more);
        assert_eq!(page.shallow, None);
    }

    #[test]
    fn reach_verdict_follows_the_probe_table() {
        for clean in [true, false] {
            for capped in [true, false] {
                for printed in [true, false] {
                    assert_eq!(reach_verdict(false, clean, capped, printed), None);
                }
                assert_eq!(
                    reach_verdict(true, clean, capped, true),
                    clean.then_some(false)
                );
                assert_eq!(
                    reach_verdict(true, clean, capped, false),
                    (!capped).then_some(true)
                );
            }
        }
    }

    #[test]
    fn submodule_commit_page_wire_shape_is_camel_case() {
        fn keys(value: &serde_json::Value) -> Vec<&str> {
            let mut keys: Vec<_> = value
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect();
            keys.sort_unstable();
            keys
        }
        let page = SubmoduleCommitPage {
            checkout: SubmoduleCheckout::Ok,
            reason: None,
            commits: vec![SubmoduleRefCommit {
                sha: "a".repeat(40),
                subject: "subject".into(),
                author: "author".into(),
                authored_at: "2026-01-01T00:00:00Z".into(),
                on_remote: None,
            }],
            has_more: false,
            shallow: Some(false),
        };
        let json = serde_json::to_value(page).unwrap();
        assert_eq!(
            keys(&json),
            ["checkout", "commits", "hasMore", "reason", "shallow"]
        );
        assert_eq!(
            keys(&json["commits"][0]),
            ["author", "authoredAt", "onRemote", "sha", "subject"]
        );
        let text = json.to_string();
        for key in ["has_more", "authored_at", "on_remote"] {
            assert!(!text.contains(key), "{key}");
        }
    }

    async fn pick_read(host: &str, sha: &str) -> SubmodulePickRead {
        git_submodule_pick_plan_core(host, "libs/dep", sha)
            .await
            .expect("pick plan read")
    }

    async fn pick(host: &str, sha: &str, expected: &str) -> AppResult<SubmodulePickOutcome> {
        git_submodule_set_commit_core(&AppState::default(), host, "libs/dep", sha, expected).await
    }

    /// The parent's `ls-files -s` row for `libs/dep`.
    async fn pointer_row(host: &str) -> String {
        git(host, &["ls-files", "-s", "--", "libs/dep"])
            .await
            .trim()
            .to_string()
    }

    fn row_at(sha: &str) -> String {
        format!("160000 {sha} 0\tlibs/dep")
    }

    fn set_at(sha: &str, checkout: SubmodulePickMove) -> SubmodulePickOutcome {
        SubmodulePickOutcome::Set {
            sha: sha.to_string(),
            checkout,
            nested_left: Some(0),
        }
    }

    fn ready(checkout: SubmodulePickMove) -> SubmodulePickPlan {
        SubmodulePickPlan::Ready { checkout }
    }

    fn plan_blocked(
        why: SubmodulePickBlock,
        reason: Option<&str>,
        paths: &[&str],
    ) -> SubmodulePickPlan {
        SubmodulePickPlan::Blocked {
            why,
            reason: reason.map(Into::into),
            paths: paths.iter().map(|path| path.to_string()).collect(),
        }
    }

    fn outcome_blocked(
        why: SubmodulePickBlock,
        reason: Option<&str>,
        paths: &[&str],
    ) -> SubmodulePickOutcome {
        SubmodulePickOutcome::Blocked {
            why,
            reason: reason.map(Into::into),
            paths: paths.iter().map(|path| path.to_string()).collect(),
        }
    }

    /// A path inside `repo`'s git dir; a submodule's lives in the parent's modules.
    async fn git_path(repo: &str, name: &str) -> PathBuf {
        let rel = git(repo, &["rev-parse", "--git-path", name]).await;
        Path::new(repo).join(rel.trim())
    }

    /// Writes `text` at `rel` under `root`, creating its folders.
    fn write_at(root: &str, rel: &str, text: &str) {
        let file = Path::new(root).join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, text).unwrap();
    }

    fn read_at(root: &str, rel: &str) -> String {
        std::fs::read_to_string(Path::new(root).join(rel)).unwrap()
    }

    async fn commit_all(repo: &str, subject: &str) -> String {
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
        head_of(repo).await
    }

    async fn exclude_in(repo: &str, pattern: &str) {
        let exclude = git_path(repo, "info/exclude").await;
        std::fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        std::fs::write(&exclude, format!("{pattern}\n")).unwrap();
    }

    /// A ref whose file names an object the store lacks.
    async fn ghost_remote_ref(sub: &str) {
        let git_dir = git(sub, &["rev-parse", "--absolute-git-dir"]).await;
        let origin = Path::new(git_dir.trim()).join("refs/remotes/origin");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::write(origin.join("ghost"), format!("{}\n", "1".repeat(40))).unwrap();
    }

    #[tokio::test]
    async fn pick_moves_back_then_forward_and_stages_each() {
        let f = gitlink_fixture("pick-back-forward").await;
        let read = pick_read(&f.host, &f.c1).await;
        assert_eq!(read.plan, ready(SubmodulePickMove::CheckOut));
        assert_eq!(read.sha.as_deref(), Some(f.c1.as_str()));
        assert_eq!(read.pointer.as_deref(), Some(f.c0.as_str()));
        assert_eq!(read.commit.as_ref().unwrap().subject, "one");
        for (sha, expected) in [(&f.c1, &f.c0), (&f.c0, &f.c1), (&f.c2, &f.c0)] {
            let outcome = pick(&f.host, sha, expected).await.unwrap();
            assert_eq!(outcome, set_at(sha, SubmodulePickMove::CheckOut), "{sha}");
            assert_eq!(head_of(&f.sub).await, *sha);
            assert_eq!(pointer_row(&f.host).await, row_at(sha));
        }
    }

    #[tokio::test]
    async fn pick_stages_without_moving_when_the_checkout_is_already_there() {
        let f = gitlink_fixture("pick-already-there").await;
        write_at(&f.sub, "dep.txt", "local edit\n");
        write_at(&f.sub, "new.txt", "untracked\n");
        let read = pick_read(&f.host, &f.c2).await;
        assert_eq!(read.plan, ready(SubmodulePickMove::AlreadyThere));
        let outcome = pick(&f.host, &f.c2, &f.c0).await.unwrap();
        assert_eq!(outcome, set_at(&f.c2, SubmodulePickMove::AlreadyThere));
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c2));
        assert_eq!(read_at(&f.sub, "dep.txt"), "local edit\n");
    }

    #[tokio::test]
    async fn pick_is_a_no_op_when_pointer_and_checkout_are_already_there() {
        let f = gitlink_fixture("pick-no-op").await;
        stage_gitlink(&f.host, &f.c2).await;
        let index = Path::new(&f.host).join(".git/index");
        let before = std::fs::read(&index).unwrap();
        assert_eq!(
            pick_read(&f.host, &f.c2).await.plan,
            SubmodulePickPlan::Current
        );
        let outcome = pick(&f.host, &f.c2, &f.c2).await.unwrap();
        assert_eq!(outcome, set_at(&f.c2, SubmodulePickMove::AlreadyThere));
        assert_eq!(
            std::fs::read(&index).unwrap(),
            before,
            "index bytes unchanged"
        );
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c2));
    }

    #[tokio::test]
    async fn pick_refuses_a_tracked_edit_the_target_overwrites() {
        let f = gitlink_fixture("pick-tracked-edit").await;
        write_at(&f.sub, "b.txt", "local\n");
        let read = pick_read(&f.host, &f.c1).await;
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::WouldOverwrite, None, &["b.txt"])
        );
        let outcome = pick(&f.host, &f.c1, &f.c0).await.unwrap();
        assert_eq!(
            outcome,
            outcome_blocked(
                SubmodulePickBlock::WouldOverwrite,
                Some(WOULD_OVERWRITE_HEADERS[0]),
                &["b.txt"]
            )
        );
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
        assert_eq!(read_at(&f.sub, "b.txt"), "local\n");
    }

    #[tokio::test]
    async fn pick_refuses_an_untracked_file_the_target_tracks() {
        let f = gitlink_fixture("pick-untracked").await;
        git(&f.sub, &["checkout", "-q", "--detach", &f.c0]).await;
        write_at(&f.sub, "a.txt", "untracked\n");
        let read = pick_read(&f.host, &f.c1).await;
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::WouldOverwrite, None, &["a.txt"])
        );
        let outcome = pick(&f.host, &f.c1, &f.c0).await.unwrap();
        assert_eq!(
            outcome,
            outcome_blocked(
                SubmodulePickBlock::WouldOverwrite,
                Some(WOULD_OVERWRITE_HEADERS[1]),
                &["a.txt"]
            )
        );
        assert_eq!(head_of(&f.sub).await, f.c0);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
        assert_eq!(read_at(&f.sub, "a.txt"), "untracked\n");
    }

    /// The submodule stays on its branch, so the orphan probe can't block first.
    #[tokio::test]
    async fn pick_refuses_an_ignored_file_the_target_tracks() {
        let f = gitlink_fixture("pick-ignored").await;
        git(&f.sub, &["checkout", "-q", "-b", "ign"]).await;
        let tracks = commit_in(&f.sub, "ign.txt", "tracked").await;
        git(&f.sub, &["checkout", "-q", "main"]).await;
        exclude_in(&f.sub, "ign.txt").await;
        write_at(&f.sub, "ign.txt", "LOCAL BYTES\n");
        let read = pick_read(&f.host, &tracks).await;
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::WouldOverwrite, None, &["ign.txt"])
        );
        let outcome = pick(&f.host, &tracks, &f.c0).await.unwrap();
        assert!(
            matches!(
                &outcome,
                SubmodulePickOutcome::Blocked {
                    why: SubmodulePickBlock::WouldOverwrite,
                    ..
                }
            ),
            "outcome is blocked/wouldOverwrite: {outcome:?}"
        );
        assert_eq!(
            outcome,
            outcome_blocked(
                SubmodulePickBlock::WouldOverwrite,
                Some(WOULD_OVERWRITE_HEADERS[1]),
                &["ign.txt"]
            )
        );
        assert_eq!(read_at(&f.sub, "ign.txt"), "LOCAL BYTES\n");
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    #[tokio::test]
    async fn pick_carries_changes_the_target_leaves_alone() {
        let f = gitlink_fixture("pick-carries").await;
        git(&f.sub, &["checkout", "-q", "--detach", &f.c1]).await;
        write_at(&f.sub, "dep.txt", "local\n");
        write_at(&f.sub, "b.txt", "two");
        git(&f.sub, &["add", "b.txt"]).await;
        write_at(&f.sub, "u.txt", "untracked\n");
        exclude_in(&f.sub, "ig.txt").await;
        write_at(&f.sub, "ig.txt", "ignored\n");
        assert_eq!(
            pick_read(&f.host, &f.c2).await.plan,
            ready(SubmodulePickMove::CheckOut)
        );
        let outcome = pick(&f.host, &f.c2, &f.c0).await.unwrap();
        assert_eq!(outcome, set_at(&f.c2, SubmodulePickMove::CheckOut));
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c2));
        assert_eq!(read_at(&f.sub, "dep.txt"), "local\n");
        assert_eq!(read_at(&f.sub, "u.txt"), "untracked\n");
        assert_eq!(read_at(&f.sub, "ig.txt"), "ignored\n");
    }

    /// A failing `post-checkout` hook prints one of git's headers and a tab-led line
    /// after HEAD moved: only the HEAD re-read tells it from git's own refusal. The
    /// second arm leaves an orphan behind, whose warning git prints before the hook.
    #[tokio::test]
    async fn pick_reports_checkout_failed_when_a_hook_fails_after_the_move() {
        let f = gitlink_fixture("pick-hook-fails").await;
        let hooks = git_path(&f.sub, "hooks").await;
        std::fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("post-checkout");
        let header = WOULD_OVERWRITE_HEADERS[0];
        let script =
            format!("#!/bin/sh\necho 'hook: build step failed' >&2\necho '{header}' >&2\nprintf '\\tdep.txt\\n' >&2\nexit 1\n");
        std::fs::write(&hook, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let outcome = pick(&f.host, &f.c1, &f.c0).await.unwrap();
        assert!(
            matches!(&outcome, SubmodulePickOutcome::CheckoutFailed { .. }),
            "outcome is checkoutFailed: {outcome:?}"
        );
        assert_eq!(
            outcome,
            SubmodulePickOutcome::CheckoutFailed {
                reason: header.into()
            },
            "the reason is the hook's first error line"
        );
        assert_eq!(head_of(&f.sub).await, f.c1, "the hook ran after the move");
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0), "nothing staged");

        // Detached at a commit no ref names, which the pointer records: the plan
        // skips the orphan probe, and the checkout warns about leaving it behind.
        std::fs::write(
            &hook,
            "#!/bin/sh\necho 'hook: build step failed' >&2\nexit 1\n",
        )
        .unwrap();
        let orphan = commit_in(&f.sub, "x.txt", "orphan").await;
        stage_gitlink(&f.host, &orphan).await;
        let outcome = pick(&f.host, &f.c1, &orphan).await.unwrap();
        assert_eq!(
            outcome,
            SubmodulePickOutcome::CheckoutFailed {
                reason: "hook: build step failed".into()
            },
            "the reason is the hook's line, past git's orphan warning"
        );
        assert_eq!(head_of(&f.sub).await, f.c1, "the orphan arm moved");
        assert_eq!(
            pointer_row(&f.host).await,
            row_at(&orphan),
            "nothing staged"
        );
    }

    #[test]
    fn checkout_failure_reason_reads_gits_error_else_the_last_line() {
        let orphan = "Warning: you are leaving 1 commit behind, not connected to\n\
            any of your branches:\n\n  1234567 orphan\n\n\
            If you want to keep it by creating a new branch, this may be a good time\n\
            to do so with:\n\n git branch <new-branch-name> 1234567\n\n\
            HEAD is now at 89abcde one\n";
        let rows = [
            (
                "an error line",
                "Previous HEAD position was 1234567 two\n\
                 error: unable to unlink old 'a.txt': Permission denied\n\
                 HEAD is now at 89abcde one\n",
                "error: unable to unlink old 'a.txt': Permission denied",
            ),
            (
                "a fatal line",
                "fatal: Unable to create 'index.lock': File exists.\n\nAnother git process\n",
                "fatal: Unable to create 'index.lock': File exists.",
            ),
            (
                "the hook alone",
                "hook: build step failed\n",
                "hook: build step failed",
            ),
            (
                "an orphan warning, then the hook",
                &format!("{orphan}hook: build step failed\n\n"),
                "hook: build step failed",
            ),
            ("nothing said", " \n\n", "git exited with code 1"),
        ];
        for (name, stderr, want) in rows {
            assert_eq!(checkout_failure_reason(stderr, 1), want, "{name}");
        }
    }

    #[tokio::test]
    async fn pick_reports_checkout_failed_under_a_lock_that_outlives_the_retry() {
        let f = gitlink_fixture("pick-sub-index-lock").await;
        let lock = git_path(&f.sub, "index.lock").await;
        std::fs::write(&lock, "").unwrap();
        assert_eq!(
            pick_read(&f.host, &f.c1).await.plan,
            ready(SubmodulePickMove::CheckOut),
            "the plan read still answers"
        );
        let outcome = pick(&f.host, &f.c1, &f.c0).await.unwrap();
        std::fs::remove_file(&lock).unwrap();
        match &outcome {
            SubmodulePickOutcome::CheckoutFailed { reason } => {
                assert!(reason.contains("index.lock"), "{reason}")
            }
            other => panic!("expected checkoutFailed, got {other:?}"),
        }
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    /// `libs/dep` on `main` at H, and M on branch `target`, which changes, adds or
    /// deletes every path the dry-run arms use and adds a gitlink at `subm`.
    /// Returns `(tempdir, host, sub, M)`.
    async fn overlap_fixture(marker: &str) -> (tempfile::TempDir, String, String, String) {
        let (dir, host, _dep) = host_with_submodule(marker).await;
        let sub = sub_dir(&host);
        for (rel, text) in [
            ("edit.txt", "h"),
            ("same.txt", "same"),
            ("touch.txt", "h"),
            ("stage.txt", "h"),
            ("deleted.txt", "h"),
            ("dirdel.txt", "h"),
            ("r.txt", "h"),
            ("gone.txt", "h"),
            ("dirfile/x.txt", "x"),
        ] {
            write_at(&sub, rel, text);
        }
        let h = commit_all(&sub, "h").await;
        git(&sub, &["checkout", "-q", "-b", "target"]).await;
        for (rel, text) in [
            ("edit.txt", "m"),
            ("touch.txt", "m"),
            ("stage.txt", "m"),
            ("deleted.txt", "m"),
            ("dirdel.txt", "m"),
            ("r.txt", "m"),
            ("untracked.txt", "m"),
            ("ignored.txt", "m"),
            ("need/f.txt", "m"),
        ] {
            write_at(&sub, rel, text);
        }
        std::fs::remove_file(Path::new(&sub).join("gone.txt")).unwrap();
        std::fs::remove_dir_all(Path::new(&sub).join("dirfile")).unwrap();
        write_at(&sub, "dirfile", "m");
        commit_all(&sub, "m").await;
        let gitlink = format!("{GITLINK_MODE},{h},subm");
        git(&sub, &["update-index", "--add", "--cacheinfo", &gitlink]).await;
        git(
            &sub,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit",
                "-qm",
                "m",
            ],
        )
        .await;
        let m = head_of(&sub).await;
        git(&sub, &["checkout", "-q", "main"]).await;
        exclude_in(&sub, "ignored.txt\n*.ign").await;
        (dir, host, sub, m)
    }

    async fn reset_sub(sub: &str) {
        git(sub, &["checkout", "-q", "-f", "main"]).await;
        git(sub, &["clean", "-qfdx"]).await;
        git(sub, &["reset", "-q", "--hard"]).await;
    }

    /// Runs the setter's own checkout in `sub` and asserts it agrees with the plan
    /// read: a ready plan lands, and a would-overwrite plan is refused by git with
    /// each planned path (or a directory holding it) in git's list.
    async fn assert_checkout_agrees(sub: &str, m: &str, plan: &SubmodulePickPlan, arm: &str) {
        let out = detach_submodule_at(sub, m).await.unwrap();
        match plan {
            SubmodulePickPlan::Ready { .. } => {
                assert_eq!(out.code, 0, "{arm}: the checkout lands: {}", out.stderr)
            }
            SubmodulePickPlan::Blocked {
                why: SubmodulePickBlock::WouldOverwrite,
                paths,
                ..
            } => {
                assert_ne!(out.code, 0, "{arm}: the checkout refuses");
                let (_, listed) = would_overwrite(&out.stderr)
                    .unwrap_or_else(|| panic!("{arm}: git's header: {}", out.stderr));
                for path in paths {
                    assert!(
                        listed
                            .iter()
                            .any(|at| at == path || path.starts_with(&format!("{at}/"))),
                        "{arm}: {path} in {listed:?}"
                    );
                }
            }
            other => panic!("{arm}: not a checkout plan: {other:?}"),
        }
    }

    #[tokio::test]
    async fn pick_plan_reads_would_overwrite_for_edits_and_files_in_the_way() {
        let (_dir, host, sub, m) = overlap_fixture("pick-overlap-blocks").await;
        let clean = pick_read(&host, &m).await.plan;
        assert_eq!(clean, ready(SubmodulePickMove::CheckOut), "the clean tree");
        assert_checkout_agrees(&sub, &m, &clean, "the clean tree").await;
        reset_sub(&sub).await;
        for (arm, blocks) in [
            ("a tracked edit the target changes", "edit.txt"),
            ("an untracked file the target tracks", "untracked.txt"),
            ("an ignored file the target tracks", "ignored.txt"),
            (
                "an untracked file where the target needs a directory",
                "need",
            ),
            (
                "a directory the target makes a file, holding an untracked file",
                "dirfile",
            ),
            (
                "a directory the target makes a file, holding an ignored file",
                "dirfile/u.ign",
            ),
            ("a directory at a path deleted from disk", "dirdel.txt"),
            ("a staged rename of a file the target changes", "r.txt"),
            (
                "a staged deletion still on disk of a file the target deletes",
                "gone.txt",
            ),
        ] {
            match blocks {
                "dirfile" => write_at(&sub, "dirfile/u.txt", "local"),
                "dirfile/u.ign" => write_at(&sub, "dirfile/u.ign", "local"),
                "dirdel.txt" => {
                    let at = Path::new(&sub).join("dirdel.txt");
                    std::fs::remove_file(&at).unwrap();
                    std::fs::create_dir(&at).unwrap();
                }
                "r.txt" => {
                    git(&sub, &["mv", "r.txt", "s.txt"]).await;
                }
                "gone.txt" => {
                    git(&sub, &["rm", "-q", "--cached", "gone.txt"]).await;
                }
                _ => write_at(&sub, blocks, "local"),
            }
            let plan = pick_read(&host, &m).await.plan;
            assert_eq!(
                plan,
                plan_blocked(SubmodulePickBlock::WouldOverwrite, None, &[blocks]),
                "{arm}"
            );
            assert_checkout_agrees(&sub, &m, &plan, arm).await;
            reset_sub(&sub).await;
        }

        // Last: `clean -x` leaves a nested repository behind.
        let arm = "an ignored nested repository where the target adds a file";
        exclude_in(&sub, "ignored.txt\n*.ign\nuntracked.txt").await;
        git(&sub, &["init", "-q", "untracked.txt"]).await;
        write_at(&sub, "untracked.txt/z.txt", "local");
        let plan = pick_read(&host, &m).await.plan;
        assert_eq!(
            plan,
            plan_blocked(SubmodulePickBlock::WouldOverwrite, None, &["untracked.txt"]),
            "{arm}"
        );
        assert_checkout_agrees(&sub, &m, &plan, arm).await;
    }

    /// With HEAD there but no index file, git checks out as an initial checkout: an
    /// ignored file at a path both commits track is in the way.
    #[tokio::test]
    async fn pick_plan_reads_an_ignored_file_in_the_way_without_an_index_file() {
        let (_dir, host, sub, m) = overlap_fixture("pick-no-index").await;
        exclude_in(&sub, "same.txt").await;
        let tracked = git(&sub, &["ls-files", "-z"]).await;
        for rel in tracked.split('\0').filter(|rel| !rel.is_empty()) {
            if rel != "same.txt" {
                let _ = std::fs::remove_file(Path::new(&sub).join(rel));
            }
        }
        std::fs::remove_file(git_path(&sub, "index").await).unwrap();
        let arm = "an ignored file both commits track, no index file";
        let plan = pick_read(&host, &m).await.plan;
        assert_eq!(
            plan,
            plan_blocked(SubmodulePickBlock::WouldOverwrite, None, &["same.txt"]),
            "{arm}"
        );
        assert_checkout_agrees(&sub, &m, &plan, arm).await;
    }

    /// A sparse checkout skips the ignored check: an ignored file at a path the
    /// target adds, which the patterns exclude, stays where it is.
    #[tokio::test]
    async fn pick_plan_skips_the_ignored_check_in_a_sparse_checkout() {
        let (_dir, host, sub, m) = overlap_fixture("pick-sparse").await;
        write_at(&sub, "ignored.txt", "local");
        let arm = "an ignored file the target tracks, outside the sparse patterns";
        git(&sub, &["config", "core.sparseCheckout", "true"]).await;
        let patterns = git_path(&sub, "info/sparse-checkout").await;
        std::fs::write(&patterns, "/*\n!/ignored.txt\n").unwrap();
        let plan = pick_read(&host, &m).await.plan;
        assert_eq!(plan, ready(SubmodulePickMove::CheckOut), "{arm}");
        assert_checkout_agrees(&sub, &m, &plan, arm).await;
        assert_eq!(read_at(&sub, "ignored.txt"), "local", "{arm}: left alone");
    }

    /// A scratch index that can't be built degrades to no prediction: the plan
    /// answers ready over an edit the dry run would block, and leaves no folder.
    #[tokio::test]
    async fn pick_plan_degrades_when_the_scratch_index_cant_be_built() {
        let (_dir, host, sub, m) = overlap_fixture("pick-scratch-fault").await;
        write_at(&sub, "edit.txt", "local");
        let made = Arc::new(std::sync::Mutex::new(None::<PathBuf>));
        let read = SCRATCH_INDEX_FAULT
            .scope(
                Arc::clone(&made),
                git_submodule_pick_plan_core(&host, "libs/dep", &m),
            )
            .await
            .unwrap();
        assert_eq!(read.plan, ready(SubmodulePickMove::CheckOut), "degraded");
        let made = made.lock().unwrap().clone().expect("the fault ran");
        assert!(
            !made.exists(),
            "the scratch folder is gone: {}",
            made.display()
        );
        assert_eq!(
            pick_read(&host, &m).await.plan,
            plan_blocked(SubmodulePickBlock::WouldOverwrite, None, &["edit.txt"]),
            "control: unscoped, the dry run blocks"
        );
    }

    #[test]
    fn sweep_stale_scratch_removes_only_old_scratch_folders() {
        let root = temp("scratch-sweep");
        let scratch = root.path().join(format!("{SCRATCH_INDEX_PREFIX}old"));
        let other = root.path().join("gd-other-old");
        let file = root.path().join(format!("{SCRATCH_INDEX_PREFIX}file"));
        std::fs::create_dir_all(scratch.join("inner")).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(&file, "x").unwrap();
        sweep_stale_scratch(root.path(), SCRATCH_SWEEP_AGE);
        assert!(scratch.exists(), "a fresh folder stays");
        std::thread::sleep(Duration::from_millis(20));
        sweep_stale_scratch(root.path(), Duration::from_millis(1));
        assert!(!scratch.exists(), "an old scratch folder goes");
        assert!(other.exists(), "another prefix stays");
        assert!(file.exists(), "a file with the prefix stays");
    }

    #[tokio::test]
    async fn pick_plan_reads_ready_past_changes_the_target_leaves_alone() {
        let (_dir, host, sub, m) = overlap_fixture("pick-overlap-ready").await;
        for arm in [
            "a touched-but-unchanged file",
            "an edit to a file identical in both commits",
            "staged content equal to the target's",
            "an unrelated untracked file",
            "a file deleted from disk only",
            "an untracked directory where the target adds a gitlink",
            "an ignored directory where the target adds a gitlink",
            "an empty directory where the target adds a file",
        ] {
            match arm {
                "a touched-but-unchanged file" => {
                    write_at(&sub, "touch.txt", "h");
                    set_mtime(&Path::new(&sub).join("touch.txt"), old_time());
                }
                "an edit to a file identical in both commits" => {
                    write_at(&sub, "same.txt", "local")
                }
                "staged content equal to the target's" => {
                    write_at(&sub, "stage.txt", "m");
                    git(&sub, &["add", "stage.txt"]).await;
                }
                "an unrelated untracked file" => write_at(&sub, "zzz.txt", "local"),
                "a file deleted from disk only" => {
                    std::fs::remove_file(Path::new(&sub).join("deleted.txt")).unwrap()
                }
                "an untracked directory where the target adds a gitlink" => {
                    write_at(&sub, "subm/u.txt", "local")
                }
                "an ignored directory where the target adds a gitlink" => {
                    write_at(&sub, "subm/u.ign", "local")
                }
                _ => std::fs::create_dir(Path::new(&sub).join("untracked.txt")).unwrap(),
            }
            let plan = pick_read(&host, &m).await.plan;
            assert_eq!(plan, ready(SubmodulePickMove::CheckOut), "{arm}");
            assert_checkout_agrees(&sub, &m, &plan, arm).await;
            reset_sub(&sub).await;
        }

        let n = nested_fixture("pick-overlap-nested").await;
        git(&n.nested, &["checkout", "-q", &n.l0]).await;
        let status = git(&n.sub, &["status", "--porcelain=v2"]).await;
        assert!(status.contains(".M SC.."), "fixture: out of sync: {status}");
        let arm = "an out-of-sync nested submodule the target moves";
        let plan = pick_read(&n.host, &n.m0).await.plan;
        assert_eq!(plan, ready(SubmodulePickMove::CheckOut), "{arm}");
        assert_checkout_agrees(&n.sub, &n.m0, &plan, arm).await;
    }

    fn old_time() -> std::time::SystemTime {
        std::time::UNIX_EPOCH + Duration::from_secs(1_577_836_800)
    }

    /// A write handle: Windows refuses `set_modified` on a read-only one.
    fn set_mtime(file: &Path, when: std::time::SystemTime) {
        std::fs::OpenOptions::new()
            .write(true)
            .open(file)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    fn mtime_of(file: &Path) -> std::time::SystemTime {
        std::fs::metadata(file).unwrap().modified().unwrap()
    }

    /// A same-size edit under the file's old mtime, with the index written in that
    /// same instant: racily clean, so only a content check sees it. The scratch keeps
    /// the real index's mtime, or the dry run would trust the stat and pass.
    #[tokio::test]
    async fn pick_plan_reads_a_racily_clean_edit_as_in_the_way() {
        let (_dir, host, sub, m) = overlap_fixture("pick-racy-edit").await;
        let file = Path::new(&sub).join("edit.txt");
        let before = mtime_of(&file);
        write_at(&sub, "edit.txt", "x");
        set_mtime(&file, before);
        set_mtime(&git_path(&sub, "index").await, before);
        let arm = "a racily clean same-size edit";
        let plan = pick_read(&host, &m).await.plan;
        assert_eq!(
            plan,
            plan_blocked(SubmodulePickBlock::WouldOverwrite, None, &["edit.txt"]),
            "{arm}"
        );
        assert_checkout_agrees(&sub, &m, &plan, arm).await;
        assert_eq!(read_at(&sub, "edit.txt"), "x");
    }

    /// An unborn HEAD merges from the empty tree; the last arm also has no index file.
    #[tokio::test]
    async fn pick_plan_reads_an_unborn_submodule_head_from_the_empty_tree() {
        let (_dir, host, sub, m) = overlap_fixture("pick-unborn").await;
        git(&sub, &["checkout", "-q", "--orphan", "fresh"]).await;
        git(&sub, &["rm", "-q", "-r", "--cached", "."]).await;
        git(&sub, &["clean", "-qfdx"]).await;
        let index = git_path(&sub, "index").await;
        std::fs::remove_file(&index).unwrap();
        let arm = "an untracked file the target tracks, no index file";
        write_at(&sub, "edit.txt", "local");
        let plan = pick_read(&host, &m).await.plan;
        assert_eq!(
            plan,
            plan_blocked(SubmodulePickBlock::WouldOverwrite, None, &["edit.txt"]),
            "{arm}"
        );
        assert_checkout_agrees(&sub, &m, &plan, arm).await;

        let arm = "a staged file the target tracks";
        git(&sub, &["add", "edit.txt"]).await;
        let plan = pick_read(&host, &m).await.plan;
        assert_eq!(
            plan,
            plan_blocked(SubmodulePickBlock::WouldOverwrite, None, &["edit.txt"]),
            "{arm}"
        );
        assert_checkout_agrees(&sub, &m, &plan, arm).await;

        let arm = "nothing in the way";
        git(&sub, &["rm", "-q", "--cached", "edit.txt"]).await;
        std::fs::remove_file(Path::new(&sub).join("edit.txt")).unwrap();
        std::fs::remove_file(&index).unwrap();
        let plan = pick_read(&host, &m).await.plan;
        assert_eq!(plan, ready(SubmodulePickMove::CheckOut), "{arm}");
        assert_checkout_agrees(&sub, &m, &plan, arm).await;
        assert_eq!(head_of(&sub).await, m);
    }

    /// The plan read refreshes a scratch copy, so a repo's `post-index-change` hook
    /// never runs for it. The control: a real refresh of the same stat change runs it.
    #[tokio::test]
    async fn pick_plan_read_runs_no_index_hook() {
        let (_dir, host, sub, m) = overlap_fixture("pick-index-hook").await;
        let hooks = git_path(&sub, "hooks").await;
        std::fs::create_dir_all(&hooks).unwrap();
        let marker = Path::new(&sub).join("..").join("hook-ran");
        let hook = hooks.join("post-index-change");
        std::fs::write(&hook, "#!/bin/sh\necho ran > ../hook-ran\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        set_mtime(&Path::new(&sub).join("touch.txt"), old_time());
        assert_eq!(
            pick_read(&host, &m).await.plan,
            ready(SubmodulePickMove::CheckOut)
        );
        assert!(!marker.exists(), "the plan read ran the hook");
        git(&sub, &["update-index", "-q", "--refresh"]).await;
        assert!(marker.exists(), "control: a real refresh runs the hook");
    }

    /// With the submodule's `index.lock` held, the plan read still answers, and the
    /// real index keeps its bytes and mtime though a refresh would rewrite it.
    #[tokio::test]
    async fn pick_plan_read_leaves_the_real_index_alone_under_a_live_lock() {
        let (_dir, host, sub, m) = overlap_fixture("pick-index-untouched").await;
        set_mtime(&Path::new(&sub).join("touch.txt"), old_time());
        write_at(&sub, "edit.txt", "local");
        let index = git_path(&sub, "index").await;
        let lock = git_path(&sub, "index.lock").await;
        std::fs::write(&lock, "").unwrap();
        let (bytes, mtime) = (std::fs::read(&index).unwrap(), mtime_of(&index));
        assert_eq!(
            pick_read(&host, &m).await.plan,
            plan_blocked(SubmodulePickBlock::WouldOverwrite, None, &["edit.txt"])
        );
        assert_eq!(std::fs::read(&index).unwrap(), bytes, "index bytes");
        assert_eq!(mtime_of(&index), mtime, "index mtime");
        assert_eq!(std::fs::read(&lock).unwrap(), b"", "the lock is untouched");
        std::fs::remove_file(&lock).unwrap();
    }

    #[test]
    fn dry_run_refusal_reads_only_gits_would_overwrite_errors() {
        let rows: [(&str, i32, &str, Option<&str>); 11] = [
            (
                "an edit",
                128,
                "error: Entry 'a.txt' not uptodate. Cannot merge.\n",
                Some("a.txt"),
            ),
            (
                "staged content",
                128,
                "error: Entry 'a b.txt' would be overwritten by merge. Cannot merge.\n",
                Some("a b.txt"),
            ),
            (
                "a directory losing untracked files",
                128,
                "error: Updating 'dir' would lose untracked files in it\n",
                Some("dir"),
            ),
            (
                "an untracked file",
                128,
                "error: Untracked working tree file 'it's.txt' would be overwritten by merge.\n",
                Some("it's.txt"),
            ),
            (
                "an untracked file removed",
                128,
                "error: Untracked working tree file 'gone.txt' would be removed by merge.\r\n",
                Some("gone.txt"),
            ),
            (
                "another unpack error",
                128,
                "error: Refusing to remove 'x' since it is the current working directory.\n",
                None,
            ),
            (
                "two lines",
                128,
                "error: Entry 'a' not uptodate. Cannot merge.\nerror: Entry 'b' not uptodate. Cannot merge.\n",
                None,
            ),
            ("a fatal", 128, "fatal: Not a valid object name x\n", None),
            (
                "another exit",
                1,
                "error: Entry 'a.txt' not uptodate. Cannot merge.\n",
                None,
            ),
            (
                "an empty path",
                128,
                "error: Entry '' not uptodate. Cannot merge.\n",
                None,
            ),
            ("nothing said", 128, "", None),
        ];
        for (name, code, stderr, want) in rows {
            assert_eq!(dry_run_refusal(code, stderr).as_deref(), want, "{name}");
        }
    }

    #[test]
    fn ignored_candidates_follow_their_rules() {
        use OnDisk::{Directory, Missing, NonDirectory};
        let disk = |entries: &'static [(&'static str, OnDisk)]| {
            move |_: &Path, rel: &str| -> std::io::Result<OnDisk> {
                if rel == "denied" {
                    return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
                }
                Ok(entries
                    .iter()
                    .find(|(at, _)| *at == rel)
                    .map_or(Missing, |(_, kind)| *kind))
            }
        };
        let added = |paths: &[(&str, bool)]| -> Vec<(String, bool)> {
            paths
                .iter()
                .map(|(path, gitlink)| (path.to_string(), *gitlink))
                .collect()
        };
        let base = Path::new("base");
        type Row = (
            &'static str,
            &'static [(&'static str, bool)],
            &'static [(&'static str, OnDisk)],
            &'static [&'static str],
        );
        let rows: [Row; 7] = [
            ("nothing on disk", &[("a/b", false)], &[], &[]),
            (
                "a file at a leading component",
                &[("a/b/c", false)],
                &[("a", Directory), ("a/b", NonDirectory)],
                &["a/b"],
            ),
            (
                "a file at the path",
                &[("f", false)],
                &[("f", NonDirectory)],
                &["f"],
            ),
            (
                "a directory at the path",
                &[("d", false)],
                &[("d", Directory)],
                &["d"],
            ),
            (
                "a directory under a gitlink",
                &[("g", true)],
                &[("g", Directory)],
                &[],
            ),
            (
                "a file under a gitlink",
                &[("g", true)],
                &[("g", NonDirectory)],
                &["g"],
            ),
            (
                "one blocker for two paths is listed once",
                &[("n/x", false), ("n/y", false)],
                &[("n", NonDirectory)],
                &["n"],
            ),
        ];
        for (name, paths, entries, want) in rows {
            let got = ignored_candidates(base, &added(paths), disk(entries)).unwrap();
            assert_eq!(got, want, "{name}");
        }
        assert!(
            ignored_candidates(base, &added(&[("denied/x", false)]), disk(&[])).is_err(),
            "an unanswered lstat is no answer"
        );
    }

    #[tokio::test]
    async fn pick_refuses_to_orphan_a_detached_commit() {
        let f = gitlink_fixture("pick-orphan").await;
        git(&f.sub, &["checkout", "-q", "--detach", &f.c2]).await;
        let orphan = commit_in(&f.sub, "o.txt", "orphan").await;
        let read = pick_read(&f.host, &f.c1).await;
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::DetachedOrphan, None, &[])
        );
        let outcome = pick(&f.host, &f.c1, &f.c0).await.unwrap();
        assert_eq!(
            outcome,
            outcome_blocked(SubmodulePickBlock::DetachedOrphan, None, &[])
        );
        assert_eq!(head_of(&f.sub).await, orphan);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    #[tokio::test]
    async fn pick_moves_a_detached_head_that_a_ref_or_the_parent_still_names() {
        let f = gitlink_fixture("pick-detached-named").await;
        let landed = |sha: &str| set_at(sha, SubmodulePickMove::CheckOut);

        // A branch reaches HEAD.
        git(&f.sub, &["checkout", "-q", "--detach", &f.c1]).await;
        assert_eq!(pick(&f.host, &f.c2, &f.c0).await.unwrap(), landed(&f.c2));
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c2));

        // Only a tag reaches HEAD.
        let tagged = commit_in(&f.sub, "t.txt", "tagged").await;
        git(&f.sub, &["tag", "keep"]).await;
        assert_eq!(pick(&f.host, &f.c1, &f.c2).await.unwrap(), landed(&f.c1));
        assert_eq!(head_of(&f.sub).await, f.c1);
        assert_ne!(tagged, f.c1);

        // The target descends from HEAD.
        let o1 = commit_in(&f.sub, "o1.txt", "o1").await;
        let o2 = commit_in(&f.sub, "o2.txt", "o2").await;
        git(&f.sub, &["checkout", "-q", "--detach", &o1]).await;
        assert_eq!(pick(&f.host, &o2, &f.c1).await.unwrap(), landed(&o2));
        assert_eq!(head_of(&f.sub).await, o2);
        assert_eq!(pointer_row(&f.host).await, row_at(&o2));

        // The recorded pointer descends from HEAD.
        git(&f.sub, &["checkout", "-q", "--detach", &o1]).await;
        assert_eq!(pick(&f.host, &f.c1, &o2).await.unwrap(), landed(&f.c1));
        assert_eq!(head_of(&f.sub).await, f.c1);

        // The parent's index names HEAD.
        let o3 = commit_in(&f.sub, "o3.txt", "o3").await;
        stage_gitlink(&f.host, &o3).await;
        assert_eq!(pick(&f.host, &f.c2, &o3).await.unwrap(), landed(&f.c2));
        assert_eq!(head_of(&f.sub).await, f.c2);

        // The parent's HEAD tree names HEAD.
        git(&f.sub, &["checkout", "-q", "--detach", &o3]).await;
        stage_gitlink(&f.host, &o3).await;
        git(&f.host, &["commit", "-qm", "record o3"]).await;
        stage_gitlink(&f.host, &f.c2).await;
        assert_eq!(pick(&f.host, &f.c1, &f.c2).await.unwrap(), landed(&f.c1));
        assert_eq!(head_of(&f.sub).await, f.c1);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c1));
    }

    #[tokio::test]
    async fn pick_reads_an_unverifiable_detached_head_as_unverified() {
        // A broken ref fails the probe: its line rides the reason.
        let f = gitlink_fixture("pick-unverified-broken").await;
        git(&f.sub, &["checkout", "-q", "--detach", &f.c2]).await;
        let orphan = commit_in(&f.sub, "o.txt", "orphan").await;
        ghost_remote_ref(&f.sub).await;
        let read = pick_read(&f.host, &f.c1).await;
        assert!(
            matches!(
                &read.plan,
                SubmodulePickPlan::Blocked {
                    why: SubmodulePickBlock::DetachedUnverified,
                    reason: Some(_),
                    ..
                }
            ),
            "{:?}",
            read.plan
        );
        let outcome = pick(&f.host, &f.c1, &f.c0).await.unwrap();
        assert!(
            matches!(
                &outcome,
                SubmodulePickOutcome::Blocked {
                    why: SubmodulePickBlock::DetachedUnverified,
                    reason: Some(_),
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert_eq!(head_of(&f.sub).await, orphan);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));

        // Shallow history makes a printed commit inconclusive.
        let (_dir, host, dep) = host_with_submodule("pick-unverified-shallow").await;
        let sub = sub_dir(&host);
        let base = head_of(&sub).await;
        commit_in(&dep, "dep.txt", "one").await;
        let tip = commit_in(&dep, "dep.txt", "two").await;
        git(&sub, &["fetch", "-q", "origin"]).await;
        git(&sub, &["fetch", "-q", "--depth", "1", "origin"]).await;
        git(&sub, &["checkout", "-q", "--detach"]).await;
        let stray = commit_in(&sub, "o.txt", "orphan").await;
        let read = pick_read(&host, &tip).await;
        assert_eq!(read.shallow, Some(true));
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::DetachedUnverified, None, &[])
        );
        assert_eq!(
            pick(&host, &tip, &base).await.unwrap(),
            outcome_blocked(SubmodulePickBlock::DetachedUnverified, None, &[])
        );
        assert_eq!(head_of(&sub).await, stray);
        assert_eq!(pointer_row(&host).await, row_at(&base));
    }

    #[tokio::test]
    async fn pick_refuses_a_commit_not_fetched_then_lands_it_after_fetch() {
        let f = gitlink_fixture("pick-not-fetched").await;
        let upstream = commit_in(&f.dep, "x.txt", "upstream").await;
        let read = pick_read(&f.host, &upstream).await;
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::NotFetched, None, &[])
        );
        assert_eq!(read.sha.as_deref(), Some(upstream.as_str()), "the typed id");
        assert_eq!(read.commit, None);
        assert_eq!(read.relation, SubmodulePickRelation::Unknown);
        assert_eq!(
            pick(&f.host, &upstream, &f.c0).await.unwrap(),
            outcome_blocked(SubmodulePickBlock::NotFetched, None, &[])
        );

        git_submodule_fetch_core(&AppState::default(), &f.host, "libs/dep", false)
            .await
            .unwrap();
        let read = pick_read(&f.host, &upstream).await;
        assert_eq!(read.plan, ready(SubmodulePickMove::CheckOut));
        assert_eq!(read.commit.unwrap().on_remote, Some(true));
        let outcome = pick(&f.host, &upstream, &f.c0).await.unwrap();
        assert_eq!(outcome, set_at(&upstream, SubmodulePickMove::CheckOut));
        assert_eq!(head_of(&f.sub).await, upstream);
        assert_eq!(pointer_row(&f.host).await, row_at(&upstream));
    }

    #[tokio::test]
    async fn fetch_unshallows_only_a_shallow_submodule() {
        let (_dir, host, dep) = host_with_submodule("fetch-unshallow").await;
        let sub = sub_dir(&host);
        for subject in ["one", "two", "three"] {
            commit_in(&dep, "dep.txt", subject).await;
        }
        git(&sub, &["fetch", "-q", "origin"]).await;
        git(&sub, &["fetch", "-q", "--depth", "1", "origin"]).await;
        let shallow = || async {
            git(&sub, &["rev-parse", "--is-shallow-repository"])
                .await
                .trim()
                .to_string()
        };
        assert_eq!(shallow().await, "true", "fixture");
        let state = AppState::default();
        git_submodule_fetch_core(&state, &host, "libs/dep", false)
            .await
            .unwrap();
        assert_eq!(shallow().await, "true", "a plain fetch keeps the cut");
        git_submodule_fetch_core(&state, &host, "libs/dep", true)
            .await
            .unwrap();
        assert_eq!(shallow().await, "false");
        git_submodule_fetch_core(&state, &host, "libs/dep", true)
            .await
            .expect("a complete submodule takes a plain fetch");
        assert_eq!(shallow().await, "false");
    }

    #[tokio::test]
    async fn fetch_refuses_unshallow_when_shallowness_is_unreadable() {
        let (_dir, host, _dep) = host_with_submodule("fetch-shallow-unknown").await;
        let sub = sub_dir(&host);
        let config = git_path(&sub, "config").await;
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str("[broken\n");
        std::fs::write(&config, text).unwrap();
        assert_invalid(
            git_submodule_fetch_core(&AppState::default(), &host, "libs/dep", true).await,
            "couldn't tell whether libs/dep's history is shallow; nothing was fetched",
        );
        let plain = vec![
            "fetch",
            "--prune",
            "--no-prune-tags",
            "--no-recurse-submodules",
        ];
        let mut unshallow = plain.clone();
        unshallow.push("--unshallow");
        assert_eq!(fetch_args(true, None), None);
        assert_eq!(fetch_args(true, Some(true)), Some(unshallow));
        for (asked, measured) in [(true, Some(false)), (false, None), (false, Some(true))] {
            assert_eq!(
                fetch_args(asked, measured),
                Some(plain.clone()),
                "{asked} {measured:?}"
            );
        }
    }

    #[tokio::test]
    async fn pick_sets_a_commit_no_remote_ref_reaches() {
        let f = gitlink_fixture("pick-unreached").await;
        let read = pick_read(&f.host, &f.c1).await;
        assert_eq!(read.commit.as_ref().unwrap().on_remote, Some(false));
        assert_eq!(read.shallow, Some(false));
        let outcome = pick(&f.host, &f.c1, &f.c0).await.unwrap();
        assert_eq!(outcome, set_at(&f.c1, SubmodulePickMove::CheckOut));
        assert_eq!(head_of(&f.sub).await, f.c1);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c1));
    }

    #[tokio::test]
    async fn pick_plan_reports_a_tag_only_commit_as_on_remote() {
        let (_dir, host, dep) = host_with_submodule("pick-tag-only").await;
        let sub = sub_dir(&host);
        git(&dep, &["switch", "-qc", "side"]).await;
        let tagged = commit_in(&dep, "tag.txt", "tag only").await;
        git(&dep, &["tag", "only-tag"]).await;
        git(&dep, &["switch", "-q", "main"]).await;
        git(&dep, &["branch", "-D", "side"]).await;
        git(&sub, &["fetch", "-q", "--tags", "origin"]).await;
        let read = pick_read(&host, &tagged).await;
        assert_eq!(read.sha.as_deref(), Some(tagged.as_str()));
        assert_eq!(read.commit.unwrap().on_remote, Some(true));
    }

    #[tokio::test]
    async fn pick_plan_reads_a_prefix_as_object_ids_never_ref_names() {
        let f = gitlink_fixture("pick-prefix").await;
        let commits = git(&f.sub, &["rev-list", "--all"]).await;
        let name = ["dead", "beef", "cafe", "f00d", "abba", "0ddb"]
            .into_iter()
            .find(|name| !commits.lines().any(|id| id.starts_with(name)))
            .expect("a hex name no commit starts with");
        git(&f.sub, &["tag", name, &f.c1]).await;
        let read = pick_read(&f.host, name).await;
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::NotFound, None, &[])
        );
        assert_eq!(read.sha, None);
        assert_eq!(read.commit, None);

        let read = pick_read(&f.host, &f.c1[..8]).await;
        assert_eq!(read.sha.as_deref(), Some(f.c1.as_str()));
        assert_eq!(read.plan, ready(SubmodulePickMove::CheckOut));
        assert_eq!(read.commit.unwrap().subject, "one");
    }

    #[test]
    fn prefix_matches_map_to_their_arm() {
        let id = format!("ABCD{}", "0".repeat(36));
        let row = || CommitSummary {
            hash: id.clone(),
            subject: "s".into(),
            author: "a".into(),
            author_email: "e".into(),
            date: "d".into(),
            committer_date: "c".into(),
            tags: Vec::new(),
            is_merge: false,
        };
        assert_eq!(prefix_target("abcd", Vec::new()), PickTarget::NotFound);
        assert_eq!(
            prefix_target("abcd", vec![row()]),
            PickTarget::Commit {
                sha: id.to_ascii_lowercase(),
                row: Some(SubmoduleRefCommit {
                    sha: id.clone(),
                    subject: "s".into(),
                    author: "a".into(),
                    authored_at: "d".into(),
                    on_remote: None,
                }),
            }
        );
        for (count, want) in [
            (2, "2 commits start with abcd"),
            (19, "19 commits start with abcd"),
            (20, "20 or more commits start with abcd"),
        ] {
            assert_eq!(
                prefix_target("abcd", vec![row(); count]),
                PickTarget::Ambiguous(want.into()),
                "{count}"
            );
        }
    }

    #[tokio::test]
    async fn pick_refuses_a_tag_or_blob_id() {
        let f = gitlink_fixture("pick-tag-blob").await;
        git(
            &f.sub,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "tag",
                "-a",
                "annot",
                "-m",
                "annot",
                &f.c1,
            ],
        )
        .await;
        let tag = git(&f.sub, &["rev-parse", "annot"])
            .await
            .trim()
            .to_string();
        let blob = git(&f.sub, &["rev-parse", &format!("{}:a.txt", f.c1)])
            .await
            .trim()
            .to_string();
        for id in [&tag, &blob] {
            let read = pick_read(&f.host, id).await;
            assert_eq!(
                read.plan,
                plan_blocked(SubmodulePickBlock::NotACommit, None, &[]),
                "{id}"
            );
            assert_eq!(read.sha, None);
            assert_eq!(
                pick(&f.host, id, &f.c0).await.unwrap(),
                outcome_blocked(SubmodulePickBlock::NotACommit, None, &[])
            );
        }
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    #[tokio::test]
    async fn pick_accepts_an_upper_case_id_and_answers_in_lower_case() {
        let f = gitlink_fixture("pick-upper").await;
        let upper = f.c1.to_ascii_uppercase();
        let read = pick_read(&f.host, &upper).await;
        assert_eq!(read.sha.as_deref(), Some(f.c1.as_str()));
        assert_eq!(read.plan, ready(SubmodulePickMove::CheckOut));
        let outcome = pick(&f.host, &upper, &f.c0.to_ascii_uppercase())
            .await
            .unwrap();
        assert_eq!(outcome, set_at(&f.c1, SubmodulePickMove::CheckOut));
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c1));
    }

    #[tokio::test]
    async fn pick_refuses_an_id_longer_than_the_stores_hash() {
        let f = gitlink_fixture("pick-too-long").await;
        let long = format!("{}{}", f.c1, "0".repeat(24));
        let want = format!("invalid commit id: {long}");
        assert_invalid(
            git_submodule_pick_plan_core(&f.host, "libs/dep", &long).await,
            &want,
        );
        let expected = format!("{}{}", f.c0, "0".repeat(24));
        assert_invalid(pick(&f.host, &long, &expected).await, &want);
        for malformed in ["abc", "xyz1"] {
            assert_invalid(
                git_submodule_pick_plan_core(&f.host, "libs/dep", malformed).await,
                &format!(
                    "invalid commit id: {}",
                    crate::git::ops::discard_shown(malformed)
                ),
            );
        }
        for blank in ["", "  "] {
            let want = "invalid commit id: an empty id";
            assert_invalid(
                git_submodule_pick_plan_core(&f.host, "libs/dep", blank).await,
                want,
            );
            assert_invalid(pick(&f.host, blank, &f.c0).await, want);
        }
        assert_invalid(
            pick(&f.host, &f.c1[..8], &f.c0).await,
            &format!("invalid commit id: {}", &f.c1[..8]),
        );
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    #[tokio::test]
    async fn pick_plan_reads_rewind_forward_and_diverged_against_the_pointer() {
        let f = gitlink_fixture("pick-relation").await;
        stage_gitlink(&f.host, &f.c1).await;
        let tree = format!("{}^{{tree}}", f.c1);
        let side = git(
            &f.sub,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "commit-tree",
                &tree,
                "-p",
                &f.c0,
                "-m",
                "side",
            ],
        )
        .await
        .trim()
        .to_string();
        use SubmodulePickRelation as R;
        for (sha, want) in [
            (&f.c0, R::Rewind { behind: 1 }),
            (&f.c2, R::Forward { ahead: 1 }),
            (
                &side,
                R::Diverged {
                    ahead: 1,
                    behind: 1,
                },
            ),
            (&f.c1, R::Same),
        ] {
            assert_eq!(pick_read(&f.host, sha).await.relation, want, "{sha}");
        }
    }

    /// `host` → `libs/dep` (mid) → `deep/leaf`: mid's `m0` records leaf's `l0` and
    /// `m1` records `l1`; the host's pointer and both checkouts sit at `m1` / `l1`.
    struct NestedFixture {
        _dir: tempfile::TempDir,
        host: String,
        sub: String,
        nested: String,
        m0: String,
        m1: String,
        l0: String,
        l1: String,
    }

    async fn nested_fixture(marker: &str) -> NestedFixture {
        allow_file_submodules();
        let dir = temp(marker);
        let root = dir.path();
        let leaf = seed_repo(root, "leaf").await;
        let mid = seed_repo(root, "mid").await;
        let host = seed_repo(root, "host").await;
        let state = AppState::default();
        let l0 = head_of(&leaf).await;
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
        let m0 = head_of(&mid).await;
        let l1 = commit_in(&leaf, "leaf.txt", "v1").await;
        let mid_leaf = Path::new(&mid)
            .join("deep/leaf")
            .to_string_lossy()
            .into_owned();
        git(&mid_leaf, &["fetch", "-q", "origin"]).await;
        git(&mid_leaf, &["checkout", "-q", &l1]).await;
        git(&mid, &["add", "deep/leaf"]).await;
        git(&mid, &["commit", "-qm", "leaf v1"]).await;
        let m1 = head_of(&mid).await;
        git_submodule_add_core(
            &state,
            host.clone(),
            "../mid".into(),
            Some("libs/dep".into()),
            Some("main".into()),
        )
        .await
        .unwrap();
        git(&host, &["commit", "-qm", "add mid"]).await;
        let sub = sub_dir(&host);
        git(&sub, &["submodule", "update", "--init", "-q"]).await;
        let nested = Path::new(&sub)
            .join("deep/leaf")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            head_of(&nested).await,
            l1,
            "fixture: nested sits at m1's l1"
        );
        NestedFixture {
            _dir: dir,
            host,
            sub,
            nested,
            m0,
            m1,
            l0,
            l1,
        }
    }

    #[tokio::test]
    async fn pick_reports_nested_submodules_left_at_their_old_commits() {
        let n = nested_fixture("pick-nested-left").await;
        git(&n.sub, &["config", "submodule.recurse", "true"]).await;
        let outcome = pick(&n.host, &n.m0, &n.m1).await.unwrap();
        assert_eq!(
            outcome,
            SubmodulePickOutcome::Set {
                sha: n.m0.clone(),
                checkout: SubmodulePickMove::CheckOut,
                nested_left: Some(1),
            }
        );
        assert_eq!(head_of(&n.sub).await, n.m0);
        assert_eq!(
            head_of(&n.nested).await,
            n.l1,
            "the nested checkout stays put"
        );
        assert_eq!(pointer_row(&n.host).await, row_at(&n.m0));
    }

    #[tokio::test]
    async fn pick_stages_the_pointer_of_an_ignore_all_submodule() {
        let f = gitlink_fixture("pick-ignore-all").await;
        git(&f.host, &["config", "submodule.libs/dep.ignore", "all"]).await;
        let outcome = pick(&f.host, &f.c1, &f.c0).await.unwrap();
        assert_eq!(outcome, set_at(&f.c1, SubmodulePickMove::CheckOut));
        assert_eq!(head_of(&f.sub).await, f.c1);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c1));
    }

    #[tokio::test]
    async fn pick_reads_and_writes_refuse_a_deinitialized_submodule() {
        let f = gitlink_fixture("pick-deinit").await;
        git(&f.host, &["submodule", "deinit", "-f", "--", "libs/dep"]).await;
        let refs = git_submodule_refs_core(&f.host, "libs/dep").await.unwrap();
        assert_eq!(refs.checkout, SubmoduleCheckout::NotInitialized);
        assert!(
            refs.branches.is_empty() && refs.remote_branches.is_empty() && refs.tags.is_empty()
        );
        assert_eq!((refs.head, refs.shallow), (None, None));
        assert_eq!(refs.pointer.as_deref(), Some(f.c0.as_str()));
        let read = pick_read(&f.host, &f.c1).await;
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::NotInitialized, None, &[])
        );
        assert_eq!(read.pointer.as_deref(), Some(f.c0.as_str()));
        assert_eq!(
            pick(&f.host, &f.c1, &f.c0).await.unwrap(),
            outcome_blocked(SubmodulePickBlock::NotInitialized, None, &[])
        );
        assert_invalid(
            git_submodule_fetch_core(&AppState::default(), &f.host, "libs/dep", false).await,
            "Can't fetch the submodule at libs/dep — it isn't checked out here. Nothing was fetched.",
        );
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    /// A refused call never resolves the folder's lock keys while git would answer for
    /// the parent there: that resolve is cached, and the submodule would share the
    /// parent's lock after it is set up again.
    #[tokio::test]
    async fn refused_calls_on_an_uninitialized_submodule_leave_its_lock_key_unresolved() {
        let (_dir, host, _dep) = host_with_submodule("pick-lock-key").await;
        let sub = sub_dir(&host);
        let pointer = head_of(&sub).await;
        let fetch_refusal =
            "Can't fetch the submodule at libs/dep — it isn't checked out here. Nothing was fetched.";

        let state = AppState::default();
        git(&host, &["submodule", "deinit", "-f", "--", "libs/dep"]).await;
        let outcome = git_submodule_set_commit_core(&state, &host, "libs/dep", &pointer, &pointer)
            .await
            .unwrap();
        assert_eq!(
            outcome,
            outcome_blocked(SubmodulePickBlock::NotInitialized, None, &[])
        );
        assert_invalid(
            git_submodule_fetch_core(&state, &host, "libs/dep", false).await,
            fetch_refusal,
        );
        git_submodule_update_core(&state, host.clone(), Some("libs/dep".into()), false)
            .await
            .unwrap();
        let child = state.working_tree_lock(&sub).await;
        let parent = state.working_tree_lock(&host).await;
        assert!(
            !Arc::ptr_eq(&child.lock(), &parent.lock()),
            "the submodule keeps a lock of its own"
        );

        // Control: resolving the folder while it is deinitialized pins the parent's key.
        let control = AppState::default();
        git(&host, &["submodule", "deinit", "-f", "--", "libs/dep"]).await;
        let _ = control.working_tree_lock(&sub).await;
        git_submodule_update_core(&control, host.clone(), Some("libs/dep".into()), false)
            .await
            .unwrap();
        let child = control.working_tree_lock(&sub).await;
        let parent = control.working_tree_lock(&host).await;
        assert!(
            Arc::ptr_eq(&child.lock(), &parent.lock()),
            "control: an early resolve shares the parent's lock"
        );
    }

    #[tokio::test]
    async fn pick_refuses_while_the_parent_is_mid_merge() {
        let f = gitlink_fixture("pick-parent-merge").await;
        let merge_head = format!("{}\n", head_of(&f.host).await);
        std::fs::write(Path::new(&f.host).join(".git/MERGE_HEAD"), merge_head).unwrap();
        let sentence = "Can't choose a submodule commit while a merge, rebase, cherry-pick or \
                        revert is in progress — finish or abort it first.";
        let read = pick_read(&f.host, &f.c1).await;
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::MidOperation, Some(sentence), &[])
        );
        assert_eq!(
            pick(&f.host, &f.c1, &f.c0).await.unwrap(),
            outcome_blocked(SubmodulePickBlock::MidOperation, Some(sentence), &[])
        );
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    #[tokio::test]
    async fn pick_refuses_while_the_submodule_is_mid_rebase() {
        let f = gitlink_fixture("pick-sub-rebase").await;
        let marker = git_path(&f.sub, "rebase-merge").await;
        std::fs::create_dir_all(&marker).unwrap();
        std::fs::write(marker.join("head-name"), "refs/heads/main\n").unwrap();
        std::fs::write(marker.join("onto"), format!("{}\n", f.c1)).unwrap();
        let read = pick_read(&f.host, &f.c1).await;
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::SubmoduleMidOperation, None, &[])
        );
        assert_eq!(
            pick(&f.host, &f.c1, &f.c0).await.unwrap(),
            outcome_blocked(SubmodulePickBlock::SubmoduleMidOperation, None, &[])
        );
        assert!(marker.is_dir(), "rebase-merge is still there");
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    #[tokio::test]
    async fn pick_reads_a_failed_submodule_operation_probe_as_check_failed() {
        let f = gitlink_fixture("pick-probe-fault").await;
        let read = crate::git::ops::with_git_dir_probe_fault(git_submodule_pick_plan_core(
            &f.host, "libs/dep", &f.c1,
        ))
        .await
        .unwrap();
        assert_eq!(
            read.plan,
            plan_blocked(
                SubmodulePickBlock::CheckFailed,
                Some("invalid argument: couldn't resolve the git dir"),
                &[]
            )
        );
        let outcome = crate::git::ops::with_git_dir_probe_fault(pick(&f.host, &f.c1, &f.c0))
            .await
            .unwrap();
        assert_eq!(
            outcome,
            outcome_blocked(
                SubmodulePickBlock::CheckFailed,
                Some("invalid argument: couldn't resolve the git dir"),
                &[]
            )
        );
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    #[tokio::test]
    async fn pick_and_fetch_refuse_a_hostile_path_in_their_own_words() {
        let f = gitlink_fixture("pick-hostile").await;
        let state = AppState::default();
        for path in ["libs/../x", "-x"] {
            match git_submodule_set_commit_core(&state, &f.host, path, &f.c1, &f.c0).await {
                Err(AppError::InvalidArgument(message)) => assert!(
                    message.starts_with("Can't choose a commit for the submodule at "),
                    "{message}"
                ),
                other => panic!("pick {path}: {other:?}"),
            }
            match git_submodule_fetch_core(&state, &f.host, path, false).await {
                Err(AppError::InvalidArgument(message)) => {
                    assert!(
                        message.starts_with("Can't fetch the submodule at "),
                        "{message}"
                    )
                }
                other => panic!("fetch {path}: {other:?}"),
            }
        }
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    /// The gate keeps a trailing slash, which no index path spells; both writes refuse
    /// it in their own words rather than read the pointer as moved.
    #[tokio::test]
    async fn pick_and_fetch_refuse_a_trailing_slash() {
        let f = gitlink_fixture("pick-trailing-slash").await;
        let state = AppState::default();
        let mut paths = vec!["libs/dep/"];
        if cfg!(windows) {
            paths.push("libs\\dep\\");
        }
        for path in paths {
            let shown = crate::git::ops::discard_shown(path);
            assert_invalid(
                git_submodule_set_commit_core(&state, &f.host, path, &f.c1, &f.c0).await,
                &format!(
                    "Can't choose a commit for the submodule at {shown} — its path ends with \
                     a slash. Nothing was changed."
                ),
            );
            assert_invalid(
                git_submodule_fetch_core(&state, &f.host, path, false).await,
                &format!(
                    "Can't fetch the submodule at {shown} — its path ends with a slash. \
                     Nothing was fetched."
                ),
            );
        }
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    /// A link AT the submodule's path moves nothing, in either shape: a Windows
    /// directory link refuses like a linked ancestor, and any other link is the
    /// gate's `Replaced` answer, `unusable`.
    #[tokio::test]
    async fn pick_moves_nothing_through_a_link_at_the_submodule_path() {
        let f = gitlink_fixture("pick-link-leaf").await;
        let outside = seed_repo(f._dir.path(), "outside").await;
        let outside_head = head_of(&outside).await;
        let unusable = plan_blocked(SubmodulePickBlock::Unusable, None, &[]);
        std::fs::remove_dir_all(&f.sub).unwrap();
        #[cfg(windows)]
        {
            crate::test_junction::make_junction(Path::new(&f.sub), Path::new(&outside));
            assert_eq!(pick_read(&f.host, &f.c1).await.plan, unusable, "junction");
            assert_invalid(
                pick(&f.host, &f.c1, &f.c0).await,
                &format!(
                    "Can't choose a commit for the submodule at libs/dep — {}. Nothing was \
                     changed.",
                    crate::git::ops::DISCARD_LINKED
                ),
            );
            std::fs::remove_dir(&f.sub).unwrap();
            let file = Path::new(&outside).join("outside.txt");
            match std::os::windows::fs::symlink_file(&file, &f.sub) {
                Ok(()) => {
                    assert_eq!(pick_read(&f.host, &f.c1).await.plan, unusable, "file link");
                    assert_eq!(
                        pick(&f.host, &f.c1, &f.c0).await.unwrap(),
                        outcome_blocked(SubmodulePickBlock::Unusable, None, &[]),
                        "file link"
                    );
                }
                Err(e) => eprintln!("file symlinks need a privilege here, arm skipped: {e}"),
            }
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, &f.sub).unwrap();
            assert_eq!(pick_read(&f.host, &f.c1).await.plan, unusable, "symlink");
            assert_eq!(
                pick(&f.host, &f.c1, &f.c0).await.unwrap(),
                outcome_blocked(SubmodulePickBlock::Unusable, None, &[]),
                "symlink"
            );
        }
        assert_eq!(head_of(&outside).await, outside_head);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    /// A printed commit is an orphan only on complete history; a shallow probe that
    /// failed says so in the reason.
    #[tokio::test]
    async fn orphan_probe_names_a_shallow_probe_that_failed() {
        let f = gitlink_fixture("pick-orphan-shallow-unknown").await;
        git(&f.sub, &["checkout", "-q", "--detach", &f.c2]).await;
        let orphan = commit_in(&f.sub, "o.txt", "orphan").await;
        let recorded = [f.c0.clone()];
        let probe = |shallow| orphan_probe(&f.sub, "libs/dep", &orphan, &f.c1, &recorded, shallow);
        assert_eq!(probe(Some(false)).await, OrphanFact::Orphan);
        assert_eq!(probe(Some(true)).await, OrphanFact::Unverified(None));
        assert_eq!(
            probe(None).await,
            OrphanFact::Unverified(Some(
                "couldn't tell whether libs/dep's history is shallow".into()
            ))
        );
    }

    #[tokio::test]
    async fn pick_says_changed_when_the_pointer_moved_since_the_read() {
        let f = gitlink_fixture("pick-changed").await;
        let read = pick_read(&f.host, &f.c1).await;
        let pointer = read.pointer.expect("the read's pointer");
        assert_eq!(pointer, f.c0);
        stage_gitlink(&f.host, &f.c2).await;
        assert_eq!(
            pick(&f.host, &f.c1, &pointer).await.unwrap(),
            SubmodulePickOutcome::Changed
        );
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c2));
    }

    #[tokio::test]
    async fn pick_says_changed_on_a_conflicted_path() {
        let f = gitlink_fixture("pick-conflicted").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        let read = pick_read(&f.host, &f.c1).await;
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::NoPointer, None, &[])
        );
        assert_eq!(read.pointer, None);
        let before = index_entries(&f.host).await;
        assert_eq!(
            pick(&f.host, &f.c1, &f.c0).await.unwrap(),
            SubmodulePickOutcome::Changed
        );
        assert_eq!(index_entries(&f.host).await, before);
        assert_eq!(head_of(&f.sub).await, f.c2);
    }

    /// The landed hook writes a third sha into the pointer after the checkout.
    #[tokio::test]
    async fn pick_leaves_the_pointer_when_it_moved_during_the_checkout() {
        let f = gitlink_fixture("pick-pointer-moved").await;
        let (host, third) = (f.host.clone(), f.c2.clone());
        let hook: PickLandedHook = Arc::new(
            move || -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> {
                let (host, third) = (host.clone(), third.clone());
                Box::pin(async move { stage_gitlink(&host, &third).await })
            },
        );
        let outcome = PICK_LANDED_HOOK
            .scope(hook, pick(&f.host, &f.c1, &f.c0))
            .await
            .unwrap();
        assert_eq!(
            outcome,
            SubmodulePickOutcome::CheckedOutNotStaged {
                sha: f.c1.clone(),
                why: SubmodulePickUnstaged::PointerMoved,
                reason: None,
            },
            "outcome is checkedOutNotStaged/pointerMoved"
        );
        assert_eq!(head_of(&f.sub).await, f.c1);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c2), "left alone");
    }

    #[tokio::test]
    async fn pick_reports_a_checkout_that_landed_when_staging_fails() {
        let f = gitlink_fixture("pick-stage-fails").await;
        let lock = Path::new(&f.host).join(".git/index.lock");
        std::fs::write(&lock, "").unwrap();
        let outcome = pick(&f.host, &f.c1, &f.c0).await.unwrap();
        std::fs::remove_file(&lock).unwrap();
        match &outcome {
            SubmodulePickOutcome::CheckedOutNotStaged {
                sha,
                why: SubmodulePickUnstaged::StageFailed,
                reason: Some(reason),
            } => {
                assert_eq!(sha, &f.c1);
                assert!(reason.contains("index.lock"), "{reason}");
            }
            other => panic!("expected checkedOutNotStaged/stageFailed, got {other:?}"),
        }
        assert_eq!(head_of(&f.sub).await, f.c1);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0), "index unchanged");
    }

    #[tokio::test]
    async fn pick_waits_on_the_submodules_own_working_tree() {
        let f = gitlink_fixture("pick-child-lock").await;
        let state = AppState::default();
        let tab = git(&f.sub, &["rev-parse", "--show-toplevel"])
            .await
            .trim()
            .to_string();
        let domain = state.working_tree_lock(&tab).await;
        let held = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a test hold")
            .await
            .expect("the tab takes its hold");
        let wait = Duration::from_millis(300);
        let started = std::time::Instant::now();
        let err = set_submodule_commit_within(&state, &f.host, "libs/dep", &f.c1, &f.c0, wait)
            .await
            .expect_err("the pick meets the tab's hold");
        assert!(
            matches!(&err, AppError::Busy { holder } if holder == "a test hold"),
            "got {err:?}"
        );
        assert!(started.elapsed() >= wait, "it waited before giving up");
        assert_eq!(head_of(&f.sub).await, f.c2, "nothing moved");
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0), "nothing staged");
        drop(held);

        let outcome = git_submodule_set_commit_core(&state, &f.host, "libs/dep", &f.c1, &f.c0)
            .await
            .unwrap();
        assert_eq!(outcome, set_at(&f.c1, SubmodulePickMove::CheckOut));
        assert_eq!(head_of(&f.sub).await, f.c1);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c1));
    }

    #[tokio::test]
    async fn pick_rereads_the_pointer_after_waiting_on_the_submodules_own_working_tree() {
        let f = gitlink_fixture("pick-child-reread").await;
        let state = AppState::default();
        let tab = git(&f.sub, &["rev-parse", "--show-toplevel"])
            .await
            .trim()
            .to_string();
        let domain = state.working_tree_lock(&tab).await;
        let held = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a test hold")
            .await
            .expect("the tab takes its hold");
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let tx = std::sync::Mutex::new(Some(tx));
        let hook: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        });
        let picked = CHILD_WAIT_HOOK.scope(
            hook,
            git_submodule_set_commit_core(&state, &f.host, "libs/dep", &f.c1, &f.c0),
        );
        let (host, c2) = (&f.host, &f.c2);
        let moved = async move {
            rx.await
                .expect("the pick waits on the submodule's working tree");
            stage_gitlink(host, c2).await;
            drop(held);
        };
        let (outcome, ()) = tokio::join!(picked, moved);
        assert_eq!(outcome.unwrap(), SubmodulePickOutcome::Changed);
        assert_eq!(head_of(&f.sub).await, f.c2, "the checkout stays");
        assert_eq!(
            pointer_row(&f.host).await,
            row_at(&f.c2),
            "the new pointer stays"
        );
    }

    #[test]
    fn plan_pick_takes_the_first_matching_arm() {
        use SubmodulePickBlock as B;
        type Edit<'a> = Box<dyn Fn(&mut PickFacts) + 'a>;
        fn edit<'a>(change: impl Fn(&mut PickFacts) + 'a) -> Edit<'a> {
            Box::new(change)
        }
        let (sha, pointer, elsewhere) = ("a".repeat(40), "b".repeat(40), "c".repeat(40));
        let decided = || PickFacts {
            gate: PickGate {
                checkout: SubmoduleCheckout::Ok,
                reason: None,
                head: Some(elsewhere.clone()),
                branch: None,
                detached: true,
            },
            pointer: Some(Some(pointer.clone())),
            parent_mid_op: Some(MidOpFact::Clear),
            child_mid_op: Some(MidOpFact::Clear),
            target: Some(PickTarget::Commit {
                sha: sha.clone(),
                row: None,
            }),
            head_tree_pointer: Some(None),
            shallow: Some(Some(false)),
            orphan: Some(OrphanFact::Named),
            overwrite: Some(OverwriteFact::Clear),
            with_overwrite: true,
        };
        let blocked = |why, reason: Option<&str>| {
            PickStep::Plan(SubmodulePickPlan::Blocked {
                why,
                reason: reason.map(Into::into),
                paths: Vec::new(),
            })
        };
        let need = PickStep::Need;
        let check_out = PickStep::Plan(ready(SubmodulePickMove::CheckOut));
        let rows: Vec<(&str, Edit, PickStep)> = vec![
            ("every fact clear", edit(|_| {}), check_out.clone()),
            (
                "not initialized outranks every later fact",
                edit(|f| {
                    f.gate.checkout = SubmoduleCheckout::NotInitialized;
                    f.pointer = Some(None);
                }),
                blocked(B::NotInitialized, None),
            ),
            (
                "a missing folder reads not initialized",
                edit(|f| f.gate.checkout = SubmoduleCheckout::Missing),
                blocked(B::NotInitialized, None),
            ),
            (
                "a file at the path is unusable with no reason",
                edit(|f| f.gate.checkout = SubmoduleCheckout::Replaced),
                blocked(B::Unusable, None),
            ),
            (
                "an unreadable checkout keeps its reason",
                edit(|f| {
                    f.gate.checkout = SubmoduleCheckout::Unreadable;
                    f.gate.reason = Some("r".into());
                }),
                blocked(B::Unusable, Some("r")),
            ),
            (
                "the pointer is read next",
                edit(|f| {
                    f.pointer = None;
                    f.parent_mid_op = Some(MidOpFact::Failed("p".into()));
                }),
                need(PickNeed::Pointer),
            ),
            (
                "no pointer outranks the parent's state",
                edit(|f| {
                    f.pointer = Some(None);
                    f.parent_mid_op = Some(MidOpFact::Refused(Some("s".into())));
                }),
                blocked(B::NoPointer, None),
            ),
            (
                "the parent's state is read next",
                edit(|f| f.parent_mid_op = None),
                need(PickNeed::ParentMidOp),
            ),
            (
                "the parent mid-operation carries its sentence",
                edit(|f| {
                    f.parent_mid_op = Some(MidOpFact::Refused(Some("s".into())));
                    f.child_mid_op = Some(MidOpFact::Failed("c".into()));
                }),
                blocked(B::MidOperation, Some("s")),
            ),
            (
                "a failed parent probe",
                edit(|f| f.parent_mid_op = Some(MidOpFact::Failed("p".into()))),
                blocked(B::CheckFailed, Some("p")),
            ),
            (
                "the submodule's state is read next",
                edit(|f| f.child_mid_op = None),
                need(PickNeed::ChildMidOp),
            ),
            (
                "the submodule mid-operation",
                edit(|f| {
                    f.child_mid_op = Some(MidOpFact::Refused(None));
                    f.target = Some(PickTarget::NotFound);
                }),
                blocked(B::SubmoduleMidOperation, None),
            ),
            (
                "a failed submodule probe",
                edit(|f| f.child_mid_op = Some(MidOpFact::Failed("c".into()))),
                blocked(B::CheckFailed, Some("c")),
            ),
            (
                "the id resolves next",
                edit(|f| f.target = None),
                need(PickNeed::Target),
            ),
            (
                "not fetched",
                edit(|f| {
                    f.target = Some(PickTarget::NotFetched { sha: sha.clone() });
                }),
                blocked(B::NotFetched, None),
            ),
            (
                "not a commit",
                edit(|f| f.target = Some(PickTarget::NotACommit)),
                blocked(B::NotACommit, None),
            ),
            (
                "not found",
                edit(|f| f.target = Some(PickTarget::NotFound)),
                blocked(B::NotFound, None),
            ),
            (
                "ambiguous, with the count",
                edit(|f| f.target = Some(PickTarget::Ambiguous("2 commits".into()))),
                blocked(B::Ambiguous, Some("2 commits")),
            ),
            (
                "HEAD and the pointer at the pick: current, whatever follows",
                edit(|f| {
                    f.gate.head = Some(sha.clone());
                    f.pointer = Some(Some(sha.clone()));
                    f.orphan = Some(OrphanFact::Orphan);
                    f.overwrite = Some(OverwriteFact::Failed("o".into()));
                }),
                PickStep::Plan(SubmodulePickPlan::Current),
            ),
            (
                "HEAD at the pick alone: already there",
                edit(|f| {
                    f.gate.head = Some(sha.clone());
                    f.orphan = Some(OrphanFact::Orphan);
                }),
                PickStep::Plan(ready(SubmodulePickMove::AlreadyThere)),
            ),
            (
                "a detached HEAD the index records skips the probe",
                edit(|f| {
                    f.gate.head = Some(pointer.clone());
                    f.head_tree_pointer = None;
                    f.orphan = None;
                }),
                check_out.clone(),
            ),
            (
                "the parent's HEAD tree is read next",
                edit(|f| {
                    f.head_tree_pointer = None;
                    f.orphan = None;
                }),
                need(PickNeed::HeadTreePointer),
            ),
            (
                "a detached HEAD the HEAD tree records skips the probe",
                edit(|f| {
                    f.head_tree_pointer = Some(Some(elsewhere.clone()));
                    f.orphan = None;
                }),
                check_out.clone(),
            ),
            (
                "the orphan probe runs next",
                edit(|f| f.orphan = None),
                need(PickNeed::Orphan),
            ),
            (
                "a detached orphan",
                edit(|f| f.orphan = Some(OrphanFact::Orphan)),
                blocked(B::DetachedOrphan, None),
            ),
            (
                "an unverifiable HEAD keeps its reason",
                edit(|f| f.orphan = Some(OrphanFact::Unverified(Some("u".into())))),
                blocked(B::DetachedUnverified, Some("u")),
            ),
            (
                "a HEAD on a branch skips the probe",
                edit(|f| {
                    f.gate.detached = false;
                    f.head_tree_pointer = None;
                    f.orphan = None;
                }),
                check_out.clone(),
            ),
            (
                "the dry run is read next",
                edit(|f| f.overwrite = None),
                need(PickNeed::Overwrite),
            ),
            (
                "an unborn HEAD goes to the dry run",
                edit(|f| {
                    f.gate.head = None;
                    f.gate.detached = false;
                    f.overwrite = None;
                }),
                need(PickNeed::Overwrite),
            ),
            (
                "files in the way",
                edit(|f| f.overwrite = Some(OverwriteFact::Blocked(vec!["x".into()]))),
                PickStep::Plan(SubmodulePickPlan::Blocked {
                    why: B::WouldOverwrite,
                    reason: None,
                    paths: vec!["x".into()],
                }),
            ),
            (
                "a failed dry run",
                edit(|f| f.overwrite = Some(OverwriteFact::Failed("o".into()))),
                blocked(B::CheckFailed, Some("o")),
            ),
            (
                "the setter skips the dry run",
                edit(|f| {
                    f.with_overwrite = false;
                    f.overwrite = None;
                }),
                check_out.clone(),
            ),
        ];
        for (name, change, want) in rows {
            let mut facts = decided();
            change(&mut facts);
            assert_eq!(plan_pick(&facts), want, "{name}");
        }
    }

    fn revs(list: &[SubmoduleRef]) -> Vec<&str> {
        list.iter().map(|listed| listed.rev.as_str()).collect()
    }

    #[tokio::test]
    async fn submodule_refs_lists_full_refs_and_hides_session_branches() {
        let (_dir, host, dep) = host_with_submodule("refs-list").await;
        let sub = sub_dir(&host);
        for branch_name in ["feature", "gd/session/x"] {
            git(&dep, &["branch", branch_name]).await;
        }
        git(&sub, &["fetch", "-q", "origin"]).await;
        for branch_name in ["gd/session/x", "local-only"] {
            git(&sub, &["branch", branch_name]).await;
        }
        git(&sub, &["tag", "v1"]).await;
        git(
            &sub,
            &[
                "-c",
                "user.email=t@t",
                "-c",
                "user.name=t",
                "tag",
                "-a",
                "v2",
                "-m",
                "v2",
            ],
        )
        .await;
        let sha = head_of(&sub).await;
        let refs = git_submodule_refs_core(&host, "libs/dep").await.unwrap();
        assert_eq!(refs.checkout, SubmoduleCheckout::Ok);
        assert_eq!(
            revs(&refs.branches),
            ["refs/heads/local-only", "refs/heads/main"]
        );
        assert_eq!(
            revs(&refs.remote_branches),
            ["refs/remotes/origin/feature", "refs/remotes/origin/main"]
        );
        assert_eq!(revs(&refs.tags), ["refs/tags/v2", "refs/tags/v1"]);
        let names: Vec<&str> = refs
            .remote_branches
            .iter()
            .map(|listed| listed.name.as_str())
            .collect();
        assert_eq!(names, ["origin/feature", "origin/main"]);
        assert_eq!(refs.branches[1].name, "main");
        assert_eq!(refs.tags[0].name, "v2");
        let every = [&refs.branches, &refs.remote_branches, &refs.tags];
        assert!(
            every
                .iter()
                .flat_map(|list| list.iter())
                .all(|listed| listed.sha == sha),
            "an annotated tag reads as its commit"
        );
        assert_eq!(refs.pointer.as_deref(), Some(sha.as_str()));
        assert_eq!(refs.head.as_deref(), Some(sha.as_str()));
        assert_eq!(refs.branch.as_deref(), Some("main"));
        assert!(!refs.detached);
        assert_eq!(refs.shallow, Some(false));
        assert_eq!(
            refs.default_rev.as_deref(),
            Some("refs/remotes/origin/main")
        );
        assert!(!refs.truncated);
        assert_eq!(refs.broken_refs, 0);
    }

    #[tokio::test]
    async fn submodule_refs_skips_a_ref_naming_a_missing_object() {
        let (_dir, host, _dep) = host_with_submodule("refs-broken").await;
        ghost_remote_ref(&sub_dir(&host)).await;
        let refs = git_submodule_refs_core(&host, "libs/dep").await.unwrap();
        assert_eq!(refs.broken_refs, 1);
        assert_eq!(revs(&refs.branches), ["refs/heads/main"]);
        assert_eq!(revs(&refs.remote_branches), ["refs/remotes/origin/main"]);
    }

    #[tokio::test]
    async fn submodule_refs_cuts_each_list_at_the_cap() {
        let (_dir, host, _dep) = host_with_submodule("refs-cap").await;
        let sub = sub_dir(&host);
        for tag in ["v1", "v2", "v10"] {
            git(&sub, &["tag", tag]).await;
        }
        for branch_name in ["b", "a"] {
            git(&sub, &["branch", branch_name]).await;
        }
        let refs = submodule_refs_capped(&host, "libs/dep", 2).await.unwrap();
        assert!(refs.truncated);
        assert_eq!(revs(&refs.tags), ["refs/tags/v10", "refs/tags/v2"]);
        assert_eq!(revs(&refs.branches), ["refs/heads/a", "refs/heads/b"]);
        assert_eq!(revs(&refs.remote_branches), ["refs/remotes/origin/main"]);
        let full = git_submodule_refs_core(&host, "libs/dep").await.unwrap();
        assert!(!full.truncated);
        assert_eq!(full.tags.len(), 3);
        assert_eq!(full.branches.len(), 3);
    }

    /// The same table as git::branches' `split_remote_tracking` test.
    #[test]
    fn submodule_remote_refs_split_at_the_longest_configured_remote() {
        type Case<'a> = (&'a str, &'a [String], Option<(&'a str, &'a str)>);
        let list = |names: &[&str]| names.iter().map(|n| n.to_string()).collect::<Vec<_>>();
        let slash_remote = list(&["origin", "team/fork"]);
        let longer_first = list(&["team/fork", "team"]);
        let shorter_first = list(&["team", "team/fork"]);
        let only_slash = list(&["team/fork"]);
        let cases: &[Case] = &[
            ("origin/main", &slash_remote, Some(("origin", "main"))),
            ("origin/feat/x", &slash_remote, Some(("origin", "feat/x"))),
            ("team/fork/Feat", &slash_remote, Some(("team/fork", "Feat"))),
            (
                "team/fork/gd/session/abc",
                &slash_remote,
                Some(("team/fork", "gd/session/abc")),
            ),
            ("ghost/x/y", &slash_remote, Some(("ghost", "x/y"))),
            ("team/fork/x", &shorter_first, Some(("team/fork", "x"))),
            ("team/other", &shorter_first, Some(("team", "other"))),
            ("team/fork/x", &longer_first, Some(("team/fork", "x"))),
            ("team/other", &longer_first, Some(("team", "other"))),
            ("team/fork", &only_slash, Some(("team", "fork"))),
            ("lonely", &slash_remote, None),
        ];
        for (rest, remotes, want) in cases {
            assert_eq!(split_remote_ref(rest, remotes), *want, "{rest}");
        }
    }

    async fn default_rev_of(host: &str) -> Option<String> {
        git_submodule_refs_core(host, "libs/dep")
            .await
            .unwrap()
            .default_rev
    }

    #[tokio::test]
    async fn submodule_refs_default_follows_what_update_remote_follows() {
        let (_dir, host, dep) = host_with_submodule("refs-default").await;
        let sub = sub_dir(&host);
        git(&dep, &["branch", "dev"]).await;
        git(&sub, &["fetch", "-q", "origin"]).await;
        let origin = |name: &str| Some(format!("refs/remotes/origin/{name}"));
        assert_eq!(default_rev_of(&host).await, origin("main"), ".gitmodules");

        git(&host, &["config", "submodule.libs/dep.branch", "dev"]).await;
        assert_eq!(
            default_rev_of(&host).await,
            origin("dev"),
            "the parent's config outranks .gitmodules"
        );
        git(&host, &["config", "submodule.libs/dep.branch", "."]).await;
        assert_eq!(
            default_rev_of(&host).await,
            origin("main"),
            "`.` follows the parent's branch"
        );

        git(&host, &["config", "--unset", "submodule.libs/dep.branch"]).await;
        let unset = [
            "config",
            "-f",
            ".gitmodules",
            "--unset",
            "submodule.libs/dep.branch",
        ];
        git(&host, &unset).await;
        git(&sub, &["remote", "set-head", "origin", "dev"]).await;
        assert_eq!(
            default_rev_of(&host).await,
            origin("dev"),
            "unset follows the remote's HEAD"
        );

        let restore = [
            "config",
            "-f",
            ".gitmodules",
            "submodule.libs/dep.branch",
            "main",
        ];
        git(&host, &restore).await;
        git(&sub, &["remote", "add", "up", &dep]).await;
        git(&sub, &["fetch", "-q", "up"]).await;
        git(&sub, &["config", "branch.main.remote", "up"]).await;
        assert_eq!(
            default_rev_of(&host).await.as_deref(),
            Some("refs/remotes/up/main"),
            "a branch whose remote is not origin"
        );
    }

    #[test]
    fn submodule_pick_wire_shapes_are_camel_case() {
        use serde_json::json;
        use SubmodulePickBlock as B;
        fn keys(value: &serde_json::Value) -> Vec<String> {
            let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
            keys.sort_unstable();
            keys
        }
        let mut texts = Vec::new();
        let refs = SubmoduleRefs {
            checkout: SubmoduleCheckout::Ok,
            reason: None,
            pointer: Some("p".into()),
            head: None,
            branch: Some("main".into()),
            detached: false,
            shallow: Some(false),
            default_rev: Some("refs/remotes/origin/main".into()),
            branches: vec![SubmoduleRef {
                rev: "refs/heads/main".into(),
                name: "main".into(),
                sha: "s".into(),
            }],
            remote_branches: Vec::new(),
            tags: Vec::new(),
            truncated: false,
            broken_refs: 1,
        };
        let json = serde_json::to_value(&refs).unwrap();
        assert_eq!(
            keys(&json),
            [
                "branch",
                "branches",
                "brokenRefs",
                "checkout",
                "defaultRev",
                "detached",
                "head",
                "pointer",
                "reason",
                "remoteBranches",
                "shallow",
                "tags",
                "truncated"
            ]
        );
        assert_eq!(keys(&json["branches"][0]), ["name", "rev", "sha"]);
        assert_eq!(json["head"], serde_json::Value::Null);
        texts.push(json.to_string());

        let read = SubmodulePickRead {
            sha: None,
            commit: None,
            pointer: Some("p".into()),
            plan: SubmodulePickPlan::Current,
            relation: SubmodulePickRelation::Same,
            shallow: None,
        };
        let json = serde_json::to_value(&read).unwrap();
        assert_eq!(
            keys(&json),
            ["commit", "plan", "pointer", "relation", "sha", "shallow"]
        );
        assert_eq!(json["sha"], serde_json::Value::Null);

        for (checkout, wire) in [
            (SubmodulePickMove::CheckOut, "checkOut"),
            (SubmodulePickMove::AlreadyThere, "alreadyThere"),
        ] {
            assert_eq!(serde_json::to_value(checkout).unwrap(), json!(wire));
        }
        for (why, wire) in [
            (B::NotInitialized, "notInitialized"),
            (B::Unusable, "unusable"),
            (B::NoPointer, "noPointer"),
            (B::MidOperation, "midOperation"),
            (B::SubmoduleMidOperation, "submoduleMidOperation"),
            (B::NotFetched, "notFetched"),
            (B::NotFound, "notFound"),
            (B::Ambiguous, "ambiguous"),
            (B::NotACommit, "notACommit"),
            (B::DetachedOrphan, "detachedOrphan"),
            (B::DetachedUnverified, "detachedUnverified"),
            (B::WouldOverwrite, "wouldOverwrite"),
            (B::CheckFailed, "checkFailed"),
        ] {
            assert_eq!(serde_json::to_value(why).unwrap(), json!(wire));
        }
        for (plan, wire) in [
            (
                ready(SubmodulePickMove::CheckOut),
                json!({ "kind": "ready", "checkout": "checkOut" }),
            ),
            (SubmodulePickPlan::Current, json!({ "kind": "current" })),
            (
                plan_blocked(B::WouldOverwrite, Some("r"), &["a"]),
                json!({ "kind": "blocked", "why": "wouldOverwrite", "reason": "r", "paths": ["a"] }),
            ),
        ] {
            assert_eq!(serde_json::to_value(plan).unwrap(), wire);
        }
        use SubmodulePickRelation as R;
        for (relation, wire) in [
            (R::Unknown, json!({ "kind": "unknown" })),
            (R::Same, json!({ "kind": "same" })),
            (
                R::Forward { ahead: 2 },
                json!({ "kind": "forward", "ahead": 2 }),
            ),
            (
                R::Rewind { behind: 3 },
                json!({ "kind": "rewind", "behind": 3 }),
            ),
            (
                R::Diverged {
                    ahead: 1,
                    behind: 4,
                },
                json!({ "kind": "diverged", "ahead": 1, "behind": 4 }),
            ),
        ] {
            assert_eq!(serde_json::to_value(relation).unwrap(), wire);
        }
        for (why, wire) in [
            (SubmodulePickUnstaged::PointerMoved, "pointerMoved"),
            (SubmodulePickUnstaged::StageFailed, "stageFailed"),
            (SubmodulePickUnstaged::StageUnconfirmed, "stageUnconfirmed"),
        ] {
            assert_eq!(serde_json::to_value(why).unwrap(), json!(wire));
        }
        for (outcome, wire) in [
            (
                SubmodulePickOutcome::Set {
                    sha: "s".into(),
                    checkout: SubmodulePickMove::AlreadyThere,
                    nested_left: Some(2),
                },
                json!({ "kind": "set", "sha": "s", "checkout": "alreadyThere", "nestedLeft": 2 }),
            ),
            (SubmodulePickOutcome::Changed, json!({ "kind": "changed" })),
            (
                outcome_blocked(B::NotFetched, None, &[]),
                json!({ "kind": "blocked", "why": "notFetched", "reason": null, "paths": [] }),
            ),
            (
                SubmodulePickOutcome::CheckoutFailed { reason: "r".into() },
                json!({ "kind": "checkoutFailed", "reason": "r" }),
            ),
            (
                SubmodulePickOutcome::CheckedOutNotStaged {
                    sha: "s".into(),
                    why: SubmodulePickUnstaged::StageUnconfirmed,
                    reason: None,
                },
                json!({
                    "kind": "checkedOutNotStaged",
                    "sha": "s",
                    "why": "stageUnconfirmed",
                    "reason": null
                }),
            ),
        ] {
            let json = serde_json::to_value(outcome).unwrap();
            texts.push(json.to_string());
            assert_eq!(json, wire);
        }
        let text = texts.join("\n");
        for snake in [
            "nested_left",
            "default_rev",
            "remote_branches",
            "broken_refs",
            "checked_out_not_staged",
            "checkout_failed",
        ] {
            assert!(!text.contains(snake), "{snake}");
        }
    }

    #[test]
    fn pick_core_locks_before_it_reads_and_checks_out_before_it_stages() {
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
        let core = body(source, "git_submodule_set_commit_core");
        assert!(
            core.contains("LOCK_WAIT_TIMEOUT"),
            "the app waits the bounded default"
        );
        let write = body(source, "set_submodule_commit_within");
        let at = |needle: &str| write.find(needle).unwrap_or_else(|| panic!("{needle}"));
        let child = "acquire_repo_lock(child, submodule_wait";
        assert!(at("pick_rel_path(") < at("working_tree_lock("));
        assert!(at("working_tree_lock(") < at("acquire_repo_lock("));
        assert!(at("acquire_repo_lock(") < at("index_gitlink("));
        assert!(at("index_gitlink(") < at(child));
        assert!(at(child) < at("detach_submodule_at("));
        assert!(at("detach_submodule_at(") < at("\"update-index\""));
        assert!(!write.contains("acquire_repo_lock_unbounded"));
        assert!(!write.contains("conflict_rel_path("));
    }

    #[tokio::test]
    async fn registrations_read_errs_on_a_failed_git_exit() {
        let dir = temp("registrations");
        let repo = seed_repo(dir.path(), "repo").await;
        assert_eq!(submodule_registrations(&repo).await.unwrap(), "", "no key");
        git(&repo, &["config", "submodule.x.url", "../x"]).await;
        assert!(submodule_registrations(&repo)
            .await
            .unwrap()
            .contains("submodule.x.url ../x"));
        let config = Path::new(&repo).join(".git/config");
        let mut text = std::fs::read_to_string(&config).unwrap();
        text.push_str("[broken\n");
        std::fs::write(&config, text).unwrap();
        assert!(matches!(
            submodule_registrations(&repo).await,
            Err(AppError::Git { .. })
        ));
    }

    #[tokio::test]
    async fn gitmodules_read_errs_on_a_corrupt_file_and_is_empty_when_missing() {
        let dir = temp("gitmodules-read");
        let repo = seed_repo(dir.path(), "repo").await;
        assert!(
            gitmodules_entries(&repo).await.unwrap().is_empty(),
            "missing"
        );
        let file = Path::new(&repo).join(".gitmodules");
        std::fs::write(&file, "[core]\n\tx = 1\n").unwrap();
        assert!(
            gitmodules_entries(&repo).await.unwrap().is_empty(),
            "no submodule key"
        );
        std::fs::write(&file, "[submodule \"a\"]\n\tpath = libs/a\n\turl = ../a\n").unwrap();
        assert_eq!(
            gitmodules_entries(&repo).await.unwrap()["libs/a"].url,
            "../a"
        );
        std::fs::write(&file, "[broken\n").unwrap();
        assert!(matches!(
            gitmodules_entries(&repo).await,
            Err(AppError::Git { .. })
        ));
    }

    /// No fixture can make `.gitmodules` unreadable between the clone's write and the
    /// re-read that follows it, so the mapping that discloses that case is tested alone.
    #[test]
    fn add_discloses_an_unconfirmed_registration_when_gitmodules_cannot_be_read() {
        let entry = |name: &str| ModuleEntry {
            name: name.into(),
            url: String::new(),
            branch: None,
        };
        let before: HashMap<String, ModuleEntry> = [("old".to_string(), entry("old"))].into();
        let after = |paths: &[&str]| -> AppResult<HashMap<String, ModuleEntry>> {
            Ok(paths
                .iter()
                .map(|path| (path.to_string(), entry(path)))
                .collect())
        };
        assert_eq!(
            inferred_added_path(&before, after(&["old", "new"])),
            Some("new".into())
        );
        assert_eq!(inferred_added_path(&before, after(&["old"])), None);
        assert_eq!(
            inferred_added_path(&before, after(&["old", "a", "b"])),
            None
        );
        let unreadable = Err(AppError::Command("unreadable .gitmodules".into()));
        assert_eq!(inferred_added_path(&before, unreadable), None);
    }
}
