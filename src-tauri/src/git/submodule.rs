use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{
    run_git, run_git_mutating, run_git_raw, DEFAULT_TIMEOUT, NETWORK_TIMEOUT, WORKTREE_OP_TIMEOUT,
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
        run_git_mutating(state, &repo_path, &args, NETWORK_TIMEOUT).await?;
        return Ok(());
    }

    // `--remote --recursive` applies --remote at EVERY depth, silently advancing
    // nested submodules to their own remote tips (measured, git 2.51.1). Only the
    // targeted level should follow its branch, so bump it un-recursively and then
    // settle its children on what it now records — two commands, one lock. Both are
    // network steps, so the lock is deliberately held for minutes: the pair has to
    // see one unbroken view, and blocking other mutations meanwhile is the point.
    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
    crate::git::ops::refuse_mid_op_for(&repo_path, "update submodules").await?;

    let mut args = vec!["submodule", "update", "--init", "--remote"];
    if let Some(spec) = spec.as_deref() {
        args.extend_from_slice(&["--", spec]);
    }
    run_git(Some(&repo_path), &args, NETWORK_TIMEOUT).await?;

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
    // other three `.gitmodules` writers use. The costs are deliberate: the lock is held
    // across the clone, and the lock-free runner gives up `run_git_mutating`'s one-shot
    // index.lock retry.
    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
    crate::git::ops::refuse_mid_op_for(&repo_path, "add a submodule").await?;
    refuse_unsettled_gitmodules(&repo_path).await?;
    run_git(Some(&repo_path), &args, NETWORK_TIMEOUT).await?;
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

    // deinit → rm → module-data delete is one sequence: hold the per-repo lock
    // across it and use the lock-free runners inside — `run_git_mutating` would
    // re-acquire the same non-reentrant mutex and deadlock.
    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
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
    run_git(Some(&repo_path), &args, WORKTREE_OP_TIMEOUT).await?;

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
    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
    crate::git::ops::refuse_mid_op_for(&repo_path, "change the submodule URL").await?;
    refuse_unsettled_gitmodules(&repo_path).await?;

    // A plain path, not a pathspec: `set-url` matches the `.gitmodules` entry by
    // its literal `path` value, which `:(literal)` magic would never equal.
    run_git(
        Some(&repo_path),
        &["submodule", "set-url", "--", &path, &url],
        DEFAULT_TIMEOUT,
    )
    .await?;
    stage_gitmodules(&repo_path).await
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

    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;
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
