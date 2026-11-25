use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::commit::short_oid;
use crate::git::conflict::{
    conflict_rel_path, refuse_linked_path, unmerged_entries, UnmergedEntry, GITLINK_MODE,
    NOT_CONFLICTED_REFUSAL,
};
use crate::git::runner::{
    acquire_repo_lock, config_lock_busy, holder_label, is_config_lock_contention, run_git,
    run_git_config_write, run_git_config_write_held, run_git_raw, run_git_raw_index_retry,
    run_git_raw_input, with_config_write_lock, GitOutput, DEFAULT_TIMEOUT, LOCK_WAIT_TIMEOUT,
    NETWORK_LOCK_WAIT_TIMEOUT, NETWORK_TIMEOUT, WORKTREE_OP_TIMEOUT,
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
    update: Option<String>,
}

/// `.gitmodules` keyed by the configured path. A repo can carry a gitlink with no
/// section at all, and the file may be missing everywhere [`gitmodules_source`] looks
/// (an unborn HEAD included): git's "no key matched" is an empty map, leaving the
/// status-derived list intact. Any other failure (a corrupt file) is an Err, never a
/// map that reads as "no entries".
async fn gitmodules_entries(repo_path: &str) -> AppResult<HashMap<String, ModuleEntry>> {
    let Some([flag, source]) = gitmodules_source(repo_path).await? else {
        return Ok(HashMap::new());
    };
    let out = run_git_raw(
        Some(repo_path),
        &[
            "config",
            &flag,
            &source,
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
    type Fields = (Option<String>, String, Option<String>, Option<String>);
    let mut by_name: HashMap<String, Fields> = HashMap::new();
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
            "update" => slot.3 = Some(value.to_string()),
            _ => {}
        }
    }
    Ok(by_name
        .into_iter()
        .filter_map(|(name, (path, url, branch, update))| {
            Some((
                path?,
                ModuleEntry {
                    name,
                    url,
                    branch,
                    update,
                },
            ))
        })
        .collect())
}

/// The `git config` source flag and value for `.gitmodules`, where git's own submodule
/// code reads it (submodule-config.c `config_from_gitmodules`, v2.51.1): `if
/// (file_exists(file)) config_source.file = file; else if (repo_get_oid(repo,
/// GITMODULES_INDEX, &oid) >= 0 || repo_get_oid(repo, GITMODULES_HEAD, &oid) >= 0)
/// config_source.blob = ...`. `file_exists` is an lstat, so anything at the path takes
/// the file arm; an unstaged deletion reads the index copy. None when no source has one.
async fn gitmodules_source(repo_path: &str) -> AppResult<Option<[String; 2]>> {
    let file = Path::new(repo_path).join(".gitmodules");
    if tokio::fs::symlink_metadata(&file).await.is_ok() {
        return Ok(Some(["-f".into(), ".gitmodules".into()]));
    }
    for name in [":.gitmodules", "HEAD:.gitmodules"] {
        let args = ["rev-parse", "--verify", "-q", name];
        let out = run_git_raw(Some(repo_path), &args, DEFAULT_TIMEOUT).await?;
        // `-q` turns an unresolvable name into a silent exit 1 (measured, git 2.51.1).
        if out.code == 1 && out.stderr.trim().is_empty() {
            continue;
        }
        let oid = out.exit_verdict()?.stdout_lossy().trim().to_string();
        return Ok(Some(["--blob".into(), oid]));
    }
    Ok(None)
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
    // Both reads walk the index in order, one line or record per gitlink path (a
    // conflicted one once; measured, git 2.51.1), so they pair by position. The path is
    // printed raw and may itself end in " (...)" or hold a newline, so each row is read
    // against its paired path ([`paired_rows`]); any other pairing is a failed read (the
    // index changed between the two reads, a rename to `x (y)` included), never a guess.
    let gitlinks = gitlink_index(repo_path).await?;
    let out = run_git_raw(Some(repo_path), &["submodule", "status"], DEFAULT_TIMEOUT).await?;
    let entries = gitmodules_entries(repo_path).await?;
    let rows = if out.code == 0 {
        let status = out.stdout_lossy();
        let paths: Vec<String> = gitlinks.iter().map(|(path, _)| path.clone()).collect();
        paired_rows(&status, &paths)
            .ok_or_else(status_mismatch)?
            .into_iter()
            .map(|(flag, sha, describe)| Ok((flag, sha.to_string(), describe.to_string())))
            .collect()
    } else {
        status_rows_by_path(repo_path, &gitlinks).await?
    };
    let mut subs = Vec::new();
    for (row, (path, index_sha)) in rows.into_iter().zip(gitlinks) {
        let (status, sha, describe, unreadable_reason) = match row {
            Ok((flag, sha, describe)) => {
                let status = match flag {
                    '-' => "uninitialized",
                    '+' => "modified",
                    'U' => "conflict",
                    _ => "ok",
                };
                (status, sha, describe, None)
            }
            Err(reason) => ("unreadable", index_sha, String::new(), Some(reason)),
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
            unreadable_reason,
        });
    }
    Ok(subs)
}

fn status_mismatch() -> AppError {
    AppError::InvalidArgument(
        "Couldn't read the submodules: git's list didn't match the index.".into(),
    )
}

/// One status row per gitlink once the whole-repo `submodule status` failed: git stops
/// at the first submodule it can't read (exit 128), while a run for one path still
/// answers for a readable one (measured, git 2.51.1). A failed path's row is its
/// reason, git's first line without its `fatal: ` lead, even when several paths fail
/// with one line: children can share one missing git dir, and the one parent-side fault
/// found past the reads before this (a bad `diff.renameLimit`) fails only runs that
/// visit a child, so no parent-only run can tell the two apart (measured, git 2.51.1).
async fn status_rows_by_path(
    repo_path: &str,
    gitlinks: &[(String, String)],
) -> AppResult<Vec<Result<(char, String, String), String>>> {
    let mut rows = Vec::with_capacity(gitlinks.len());
    for (path, _) in gitlinks {
        let spec = crate::git::pathspec::literal(path);
        let args = ["submodule", "status", "--", spec.as_str()];
        let out = run_git_raw(Some(repo_path), &args, DEFAULT_TIMEOUT).await?;
        if out.code != 0 {
            rows.push(Err(status_failure_reason(&out)));
            continue;
        }
        let text = out.stdout_lossy();
        let (flag, sha, describe, _) = paired_status(&text, path)
            .filter(|(.., rest)| rest.is_empty())
            .ok_or_else(status_mismatch)?;
        rows.push(Ok((flag, sha.to_string(), describe.to_string())));
    }
    Ok(rows)
}

/// A failed status run's first line without git's `fatal: ` lead; a line git printed
/// with a path that isn't UTF-8 has no exact spelling, so it reads as [`NOT_UTF8_PATH`].
fn status_failure_reason(out: &GitOutput) -> String {
    let line = unreadable_reason(&out.stderr, out.code);
    if line.contains(LOSSY) {
        return NOT_UTF8_PATH.to_string();
    }
    match line.strip_prefix("fatal: ") {
        Some(rest) if !rest.trim().is_empty() => rest.to_string(),
        _ => line,
    }
}

/// The index's gitlink paths in index order, a conflicted one once. A path that isn't
/// UTF-8 has no exact spelling here, and a caller would walk its lossy one: the read
/// fails instead.
async fn gitlink_paths(repo_path: &str) -> AppResult<Vec<String>> {
    let gitlinks = gitlink_index(repo_path).await?;
    Ok(gitlinks.into_iter().map(|(path, _)| path).collect())
}

/// [`gitlink_paths`] with each path's sha: stage 0's, or a conflicted path's first
/// stage's.
async fn gitlink_index(repo_path: &str) -> AppResult<Vec<(String, String)>> {
    let listing = run_git_raw(Some(repo_path), &["ls-files", "-s", "-z"], DEFAULT_TIMEOUT)
        .await?
        .exit_verdict()?
        .stdout;
    let mut gitlinks: Vec<(String, String)> = Vec::new();
    for record in listing.split(|byte| *byte == 0) {
        if !record.starts_with(b"160000 ") {
            continue;
        }
        let record = std::str::from_utf8(record).map_err(|_| {
            AppError::InvalidArgument(
                "Couldn't read the submodules: git listed a submodule path that isn't UTF-8."
                    .into(),
            )
        })?;
        gitlinks.extend(
            gitlink_records(record).map(|(path, sha, _)| (path.to_string(), sha.to_string())),
        );
    }
    gitlinks.dedup_by(|later, earlier| later.0 == earlier.0);
    Ok(gitlinks)
}

/// `submodule status` output read against the index's gitlink paths, one row each in
/// order: the flag, the sha and the describe per path. None is any other pairing, or
/// text left over.
fn paired_rows<'a>(mut text: &'a str, paths: &[String]) -> Option<Vec<(char, &'a str, &'a str)>> {
    let mut rows = Vec::with_capacity(paths.len());
    for path in paths {
        let (flag, sha, describe, rest) = paired_status(text, path)?;
        rows.push((flag, sha, describe));
        text = rest;
    }
    text.is_empty().then_some(rows)
}

/// The row at the front of `text` read against its paired index path: the flag, the
/// sha, the describe and the text after the row. git prints `<flag><sha> <path>`
/// unquoted, then ` (<describe>)` only on ' ' and '+' rows, then a newline (builtin/
/// submodule--helper.c `print_status`, v2.51.1), so the path is consumed by its exact
/// bytes, a newline inside it included. The describe is a ref name or an abbreviated
/// id, so it holds neither a newline nor a space (`check-ref-format` refuses one): a
/// row for `x (y)` read against `x` leaves `y) (...` and fails. None is any other
/// pairing, a flag git doesn't print included.
fn paired_status<'a>(text: &'a str, path: &str) -> Option<(char, &'a str, &'a str, &'a str)> {
    let mut chars = text.chars();
    let flag = chars.next()?;
    let (sha, rest) = chars.as_str().split_once(' ')?;
    if sha.contains('\n') {
        return None;
    }
    let rest = rest.strip_prefix(path)?;
    let (describe, rest) = match flag {
        ' ' | '+' => match rest.strip_prefix(" (") {
            Some(after) => after.split_once(")\n")?,
            None => ("", rest.strip_prefix('\n')?),
        },
        '-' | 'U' => ("", rest.strip_prefix('\n')?),
        _ => return None,
    };
    if describe.contains(' ') {
        return None;
    }
    Some((flag, sha, describe, rest))
}

/// Lists the repo's submodules with their status. Empty for a repo without any.
#[tauri::command]
pub async fn git_submodules(repo_path: String) -> AppResult<Vec<Submodule>> {
    list_submodules(&repo_path).await
}

/// Initializes (when needed) and updates submodules, recursing into nested ones.
/// `path` targets one submodule; `None` updates all. A plain update follows each
/// submodule's `update` setting against the commit the parent records; `remote`
/// does the same for the TARGETED submodules against the tip of the branch each
/// tracks (their remote HEAD when unset), and their own nested submodules still
/// settle on what the updated child records. Only the `remote` arm is gated on a
/// quiet repo: a plain update works from the recorded commits, which stays safe
/// (and has always been allowed) mid-merge or mid-rebase, whereas updating
/// submodules against branch tips during one is not.
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

    #[cfg(test)]
    if let Ok(settle) = UPDATE_SETTLE_HOOK.try_with(|hook| hook()) {
        settle.await;
    }

    // The settling legs register NESTED submodules in each child's own config, which
    // this repository's config-write mutex doesn't key and its repair doesn't cover.
    // Recursing from inside each bumped child resolves its gitlinks against its NEW
    // HEAD; the parent's own `--recursive` would re-walk the other siblings. Every leg
    // runs pinned to the folder's own repository: from a folder emptied or re-pointed
    // outside the app, git would answer for the parent and settle every sibling.
    // git skips an `update = none` submodule whole, nested ones included, and an inactive
    // one, so their nested legs are skipped too ([`nested_leg_skips`]). git activates a
    // named path, so the targeted arm reports a folder gone since before it reads that.
    let entries = gitmodules_entries(&repo_path).await?;
    let mut specs = ActiveSpecs::default();
    match path.as_deref() {
        Some(path) if update_is_none(&repo_path, &entries, path).await? => {}
        Some(path) => {
            let worktree = Path::new(&repo_path).join(path);
            let child =
                ChildRepo::resolve(&repo_path, &worktree)
                    .await
                    .map_err(|(checkout, reason)| {
                        AppError::InvalidArgument(format!(
                            "Updated the submodule at {}, but not the submodules inside it: {}.",
                            crate::git::ops::discard_shown(path),
                            unusable_why(checkout, reason.as_deref())
                        ))
                    })?;
            if submodule_is_active(&repo_path, &entries, &mut specs, path).await? {
                child
                    .run(
                        &["submodule", "update", "--init", "--recursive"],
                        NETWORK_TIMEOUT,
                    )
                    .await?
                    .exit_verdict()?;
            }
        }
        // What `submodule foreach` walks: the parent's gitlinks in index order, folders
        // that aren't checked out skipped, stopping at the first failure. Read from the
        // index itself: `submodule status` dies on any path through a symlink (git 2.45.1+
        // `validate_submodule_path`), which would abort the whole walk.
        None => {
            for sub_path in gitlink_paths(&repo_path).await? {
                if nested_leg_skips(&repo_path, &entries, &mut specs, &sub_path).await? {
                    continue;
                }
                let worktree = Path::new(&repo_path).join(&sub_path);
                let child = match ChildRepo::resolve(&repo_path, &worktree).await {
                    Ok(child) => child,
                    Err((SubmoduleCheckout::Unreadable, reason)) => {
                        return Err(AppError::InvalidArgument(format!(
                            "Updated the submodules, but not the ones inside {}: {}.",
                            crate::git::ops::discard_shown(&sub_path),
                            unusable_why(SubmoduleCheckout::Unreadable, reason.as_deref())
                        )))
                    }
                    Err(_) => continue,
                };
                child
                    .run(
                        &["submodule", "update", "--init", "--recursive"],
                        NETWORK_TIMEOUT,
                    )
                    .await?
                    .exit_verdict()?;
            }
        }
    }
    Ok(())
}

/// Whether the nested leg skips the submodule at `path`: git's update skipped it whole,
/// for an `update = none` mode or for being inactive, read from the parent's config as
/// the update left it. `update --init` activates what it initializes (helper.c v2.51.1,
/// 461-465: `if (!is_submodule_active(the_repository, path)) { ... repo_config_set_gently(
/// the_repository, sb.buf, "true");`) and leaves an inactive one out only with no path
/// while `submodule.active` is set (551-555: `if (!argc && !repo_config_get(
/// the_repository, "submodule.active")) module_list_active(&list);`).
async fn nested_leg_skips(
    repo_path: &str,
    entries: &HashMap<String, ModuleEntry>,
    specs: &mut ActiveSpecs,
    path: &str,
) -> AppResult<bool> {
    Ok(update_is_none(repo_path, entries, path).await?
        || !submodule_is_active(repo_path, entries, specs, path).await?)
}

/// git's `is_tree_submodule_active` (submodule.c v2.51.1) over the parent's config: no
/// `.gitmodules` mapping, inactive; else `submodule.<name>.active` when set; else whether
/// `submodule.active`'s pathspecs match the path ([`ActiveSpecs`]); else whether
/// `submodule.<name>.url` is set.
async fn submodule_is_active(
    repo_path: &str,
    entries: &HashMap<String, ModuleEntry>,
    specs: &mut ActiveSpecs,
    path: &str,
) -> AppResult<bool> {
    let Some(entry) = entries.get(path) else {
        return Ok(false);
    };
    let unread = |key: &str| AppError::Command(format!("Couldn't read {key}."));
    let key = format!("submodule.{}.active", entry.name);
    let args = ["config", "--type=bool", "--get", key.as_str()];
    let own = run_git_raw(Some(repo_path), &args, DEFAULT_TIMEOUT).await;
    if let Some(own) = config_value(own).ok_or_else(|| unread(&key))? {
        return Ok(own == "true");
    }
    if let Some(matches) = specs.get(repo_path).await? {
        return Ok(matches.iter().any(|listed| listed == path.as_bytes()));
    }
    let key = format!("submodule.{}.url", entry.name);
    let url = config_get(repo_path, &key)
        .await
        .ok_or_else(|| unread(&key))?;
    Ok(url.is_some())
}

/// `submodule.active`'s matches for one update, read on first use and kept: git reads
/// the pathspecs only for a submodule without its own `submodule.<name>.active`, so a
/// value it can't parse fails only an update that consults it.
#[derive(Default)]
struct ActiveSpecs(Option<Option<Vec<Vec<u8>>>>);

impl ActiveSpecs {
    async fn get(&mut self, repo_path: &str) -> AppResult<Option<&[Vec<u8>]>> {
        let matches = match self.0.take() {
            Some(matches) => matches,
            None => active_spec_matches(repo_path).await?,
        };
        Ok(self.0.insert(matches).as_deref())
    }
}

/// The index paths `submodule.active`'s pathspecs match, git doing the matching with
/// every value as written; None when it is unset, or when any of its records has no
/// value: git's read of the list then fails ("missing value", config.c v2.51.1
/// `check_multi_string`) and its activity check falls through to the URL.
async fn active_spec_matches(repo_path: &str) -> AppResult<Option<Vec<Vec<u8>>>> {
    // `--get-all -z` prints a valueless record and an empty value alike; with the key
    // `--get-regexp` prints first, only a record that has a value carries a newline.
    let args = ["config", "-z", "--get-regexp", r"^submodule\.active$"];
    let Some(records) = config_answer(run_git_raw(Some(repo_path), &args, DEFAULT_TIMEOUT).await?)?
    else {
        return Ok(None);
    };
    let records = String::from_utf8(records.stdout)
        .map_err(|_| AppError::Command("Couldn't read submodule.active.".into()))?;
    let mut values = Vec::new();
    for record in records.strip_suffix('\0').unwrap_or(&records).split('\0') {
        match record.split_once('\n') {
            Some((_, value)) => values.push(value),
            None => return Ok(None),
        }
    }
    let mut args = vec!["ls-files", "-z", "--"];
    args.extend(values);
    let listed = run_git_raw(Some(repo_path), &args, DEFAULT_TIMEOUT)
        .await?
        .exit_verdict()?
        .stdout;
    Ok(Some(
        listed
            .split(|byte| *byte == 0)
            .map(<[u8]>::to_vec)
            .collect(),
    ))
}

/// Whether git skips the submodule at `path` on an update given no strategy: its
/// effective mode is `none`. git reads `submodule.<name>.update` from the parent's
/// config, else the `.gitmodules` entry's (builtin/submodule--helper.c v2.51.1):
/// `if (!repo_config_get_string_tmp(the_repository, key, &update_string))
/// update_type = parse_submodule_update_type(update_string); else update_type =
/// sub->update_strategy.type;`. A path `.gitmodules` doesn't list is never skipped.
async fn update_is_none(
    repo_path: &str,
    entries: &HashMap<String, ModuleEntry>,
    path: &str,
) -> AppResult<bool> {
    let Some(entry) = entries.get(path) else {
        return Ok(false);
    };
    let key = format!("submodule.{}.update", entry.name);
    let configured = config_get(repo_path, &key)
        .await
        .ok_or_else(|| AppError::Command(format!("Couldn't read {key}.")))?;
    Ok(configured.or_else(|| entry.update.clone()).as_deref() == Some("none"))
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
/// worktree, or one git can't read, is refused with nothing mutated.
/// `delete_module_data` additionally erases the submodule's repository data, which
/// git otherwise keeps.
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

    // The only guard on the destructive pair below: `deinit` exits 0 on a path that is
    // not a submodule at all (measured), so a path the index doesn't record as a gitlink
    // would fall straight through to `git rm` and delete a regular file. The section
    // name is read before `git rm` edits `.gitmodules` out from under it: the module
    // data directory is keyed on the name, not the path. Neither read needs git to read
    // the submodule itself, so one git can't read still reaches the force offer.
    if !gitlink_recorded(&repo_path, &path, &spec).await? {
        return Err(AppError::InvalidArgument(format!(
            "not a submodule: {path}"
        )));
    }
    let name = gitmodules_entries(&repo_path)
        .await?
        .remove(&path)
        .map_or_else(|| path.clone(), |entry| entry.name);

    let worktree = Path::new(&repo_path).join(&path);
    if !force {
        // Probe the submodule's OWN worktree only once git takes it as one: elsewhere git
        // would walk up and answer with the PARENT repo's status instead. A folder git
        // can't read, or a failed probe, is no evidence of local work: it refuses as
        // unreadable with why, never as dirty, so the force offer can say so.
        let (child, checkout, reason) = child_gate(&repo_path, &worktree).await;
        if checkout == SubmoduleCheckout::Unreadable {
            let why = reason.unwrap_or_else(|| "its status read failed".to_string());
            return Ok(refused_unreadable(&why));
        }
        // git refuses deinit on a submodule whose HEAD has moved off the recorded commit
        // even when its worktree is spotless, so that move is part of the dirty verdict:
        // the worktree probe alone would let it reach a raw fatal (measured, git 2.51.1).
        let mut dirty = false;
        if let Some(child) = child.as_ref() {
            let Some(head) = head_now(child).await else {
                return Ok(refused_unreadable("its HEAD couldn't be read"));
            };
            dirty = head != index_gitlink(&repo_path, &path, &spec).await?;
        }
        if let Some(child) = child.filter(|_| !dirty) {
            let probed = child
                .run(
                    &["status", "--porcelain", UNTRACKED_NORMAL],
                    DEFAULT_TIMEOUT,
                )
                .await;
            let why = match probed {
                Ok(out) if out.code == 0 => {
                    dirty = !out.stdout_lossy().trim().is_empty();
                    None
                }
                Ok(out) => Some(unreadable_reason(&out.stderr, out.code)),
                Err(e) => Some(nonempty_reason(e.to_string())),
            };
            if let Some(why) = why {
                return Ok(refused_unreadable(&why));
            }
        }
        if dirty {
            return Ok(SubmoduleRemoveOutcome {
                refused_dirty: true,
                refused_unreadable: None,
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
        let section = format!("submodule.{name}");
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
        refused_unreadable: None,
        module_data_deleted: false,
        module_data_error: None,
    };
    if delete_module_data {
        match module_data_dir(&repo_path, &name).await {
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

/// A remove refused because git couldn't read the submodule: nothing was mutated, and
/// `why` becomes the clause after "Git couldn't read <path>: ", trailing period dropped.
fn refused_unreadable(why: &str) -> SubmoduleRemoveOutcome {
    SubmoduleRemoveOutcome {
        refused_dirty: false,
        refused_unreadable: Some(why.trim_end().trim_end_matches('.').to_string()),
        module_data_deleted: false,
        module_data_error: None,
    }
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
    let git_dir = single_value(&stdout);
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

    let worktree = Path::new(repo_path).join(path);
    let (child, checkout, reason) = child_gate(repo_path, &worktree).await;
    (changes.checkout, changes.reason) = (checkout, reason);
    if let Some(child) = &child {
        let read = child
            .run(&submodule_status_args(staged), DEFAULT_TIMEOUT)
            .await;
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
            let walked = match (&child, changes.checkout) {
                (Some(child), SubmoduleCheckout::Ok) => {
                    submodule_range(child, from_sha, to_sha).await
                }
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

/// The checkout state from an lstat of the gitlink path's final component (the
/// resolver refuses a link on the way before it): git run through a link reads the
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

use child_repo::ChildRepo;

/// [`ChildRepo::resolve`] for the callers that report the checkout state: Some exactly
/// when the state is `Ok`.
async fn child_gate(
    repo_path: &str,
    worktree: &Path,
) -> (Option<ChildRepo>, SubmoduleCheckout, Option<String>) {
    match ChildRepo::resolve(repo_path, worktree).await {
        Ok(child) => (Some(child), SubmoduleCheckout::Ok, None),
        Err((checkout, reason)) => (None, checkout, reason),
    }
}

/// A refusal's clause for a folder that didn't resolve to its own repository.
fn unusable_why(checkout: SubmoduleCheckout, reason: Option<&str>) -> String {
    match (checkout, reason) {
        (SubmoduleCheckout::Unreadable, Some(reason)) => format!("git couldn't read it: {reason}"),
        _ => "it isn't checked out here".to_string(),
    }
}

/// The only home of child-side git: its fields are private to this module, so nothing
/// else can build a [`ChildRepo`], and every spawn inside a submodule runs through its
/// methods (`child_side_git_goes_through_child_repo` pins the rest of the file).
mod child_repo {
    use std::path::{Component, Path, PathBuf};
    use std::time::Duration;

    use super::{
        checkout_from_probe, nonempty_reason, single_value, unreadable_reason, LOSSY,
        NOT_A_REPOSITORY, NOT_UTF8_PATH, NO_LAZY_FETCH,
    };
    use crate::error::AppResult;
    use crate::git::runner::{
        run_git_raw, run_git_raw_env, run_git_raw_input_env, GitOutput, DEFAULT_TIMEOUT,
    };
    use crate::git::types::SubmoduleCheckout;

    /// Why a folder isn't usable: its checkout state, and git's or the check's line.
    pub(super) type Unusable = (SubmoduleCheckout, Option<String>);

    /// The submodule folder's own repository: found by git's own discovery from the
    /// folder (stopped at the folder's parent, so git's ownership and format checks
    /// apply) and accepted only when it is not the parent's repository (another common
    /// dir), git takes the folder as its work tree, and the repository names the folder
    /// itself: its git dir is the folder's `.git` directory in place, or its own
    /// `core.worktree` points back. A gitfile alone is the folder's claim, which any
    /// folder can make about any repository. Every child-side git then runs pinned
    /// (`--git-dir=<dir>/`, `--work-tree`) and never discovers. The trailing slash is
    /// the guard: with a file at the pinned path git exits 128 instead of following it
    /// as a gitfile (measured: git 2.51.1 on Windows; 2.39.5, 2.43.0 and 2.47.3 on
    /// Linux). Resolved again after every lock wait, just before each checkout, and
    /// by every report that says where the folder's checkout is. Out of reach by
    /// design: a link or junction put in place of the pinned directory, or its contents
    /// replaced in place, between a resolve and a spawn (git reads what is there); and an
    /// inherited `GIT_DIR` / `GIT_WORK_TREE` in the app's own environment, which the
    /// app-wide runner policy owns, not this module.
    #[derive(Debug)]
    pub(super) struct ChildRepo {
        folder: String,
        git_dir: String,
        git_dir_arg: String,
        work_tree_arg: String,
    }

    impl ChildRepo {
        /// [`checkout_from_probe`], then the one discovering read, the only source of a
        /// pin: a pinned call skips git's ownership check (measured, git 2.51.1). git's
        /// discovery miss is `NotInitialized`; any other failure, and an answer naming
        /// the parent's repository, another work tree, or a repository that doesn't name
        /// the folder (V3), is `Unreadable` with its line. The git dir, common dir and
        /// work tree are three discovering reads, each less exactly one trailing newline,
        /// since a folder path may hold or end in CR or LF. V3 costs a gitfile layout one
        /// more spawn; the own `.git` directory needs none. A link or junction at any
        /// component between the parent's root and the folder is `Replaced`, as one at
        /// the folder is: either way the path doesn't reach a folder of the parent, and
        /// git run through it reads the link's target. A path git prints that holds the
        /// lossy decode's marker is `Unreadable`, never compared.
        pub(super) async fn resolve(
            repo_path: &str,
            worktree: &Path,
        ) -> Result<ChildRepo, Unusable> {
            match linked_on_the_way(repo_path, worktree) {
                Ok(false) => {}
                Ok(true) => return Err((SubmoduleCheckout::Replaced, None)),
                Err(e) => {
                    return Err(unreadable(format!(
                        "couldn't read the submodule's path: {e}"
                    )))
                }
            }
            let probed = checkout_from_probe(std::fs::symlink_metadata(worktree), || {
                worktree.join(".git").try_exists()
            });
            if probed.0 != SubmoduleCheckout::Ok {
                return Err(probed);
            }
            let folder = worktree.to_string_lossy().into_owned();
            let ceiling = worktree
                .parent()
                .map(|parent| parent.to_string_lossy().into_owned())
                .unwrap_or_default();
            let env = [
                ("GIT_CEILING_DIRECTORIES", ceiling.as_str()),
                NO_LAZY_FETCH[0],
            ];
            // One value per spawn: a path holding a newline shifts the lines of a
            // multi-value answer.
            let flags = ["--git-dir", "--git-common-dir", "--show-toplevel"];
            let mut answers: [String; 3] = Default::default();
            for (answer, flag) in answers.iter_mut().zip(flags) {
                let args = ["rev-parse", "--path-format=absolute", flag];
                *answer = match run_git_raw_env(Some(&folder), &args, &env, DEFAULT_TIMEOUT).await {
                    Ok(out) if out.code == 0 => single_value(&out.stdout_lossy()).to_string(),
                    Ok(out) if out.stderr.trim() == NOT_A_REPOSITORY => {
                        return Err((SubmoduleCheckout::NotInitialized, None))
                    }
                    Ok(out) => return Err(unreadable(unreadable_reason(&out.stderr, out.code))),
                    Err(e) => return Err(unreadable(nonempty_reason(e.to_string()))),
                };
            }
            let [git_dir, common_dir, toplevel] = answers.each_ref().map(String::as_str);
            let parent_args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
            let parent = match run_git_raw(Some(repo_path), &parent_args, DEFAULT_TIMEOUT).await {
                Ok(out) if out.code == 0 => out.stdout_lossy(),
                Ok(out) => return Err(unreadable(unreadable_reason(&out.stderr, out.code))),
                Err(e) => return Err(unreadable(nonempty_reason(e.to_string()))),
            };
            let parent = single_value(&parent);
            if [git_dir, common_dir, toplevel, parent]
                .iter()
                .any(|path| path.contains(LOSSY))
            {
                return Err(unreadable(NOT_UTF8_PATH.into()));
            }
            // The COMMON dir: the one compare that also catches the parent's linked
            // worktree admin dirs, and both again when the parent is itself linked.
            if same_dir(common_dir, parent)? {
                return Err(unreadable(
                    "its .git names this repository's own git directory".into(),
                ));
            }
            if !same_dir(toplevel, &folder)? {
                return Err(unreadable(format!(
                    "its .git names a repository checked out at {toplevel}"
                )));
            }
            let git_dir_arg = format!("--git-dir={}/", git_dir.trim_end_matches('/'));
            // V3, asked without the folder's `.git` entry: from the parent's root, pinned
            // to the git dir alone, git answers with the folder only when `core.worktree`
            // names it; with none it answers with the cwd.
            if !own_git_dir(git_dir, &folder)? {
                let args = [
                    git_dir_arg.as_str(),
                    "rev-parse",
                    "--path-format=absolute",
                    "--show-toplevel",
                ];
                let named = match run_git_raw(Some(repo_path), &args, DEFAULT_TIMEOUT).await {
                    Ok(out) if out.code == 0 => out.stdout_lossy(),
                    Ok(out) => return Err(unreadable(unreadable_reason(&out.stderr, out.code))),
                    Err(e) => return Err(unreadable(nonempty_reason(e.to_string()))),
                };
                let named = single_value(&named);
                if named.contains(LOSSY) {
                    return Err(unreadable(NOT_UTF8_PATH.into()));
                }
                if !same_dir(named, &folder)? {
                    return Err(unreadable(NOT_ITS_WORK_TREE.into()));
                }
            }
            Ok(ChildRepo {
                git_dir_arg,
                work_tree_arg: format!("--work-tree={folder}"),
                git_dir: git_dir.to_string(),
                folder,
            })
        }

        /// The folder as the parent joined it: a lock key, a credential lookup's cwd,
        /// an on-disk walk's root. Never a git cwd outside this module.
        pub(super) fn folder(&self) -> &str {
            &self.folder
        }

        /// The resolved git dir, absolute.
        pub(super) fn git_dir(&self) -> &str {
            &self.git_dir
        }

        /// Whether a later resolve found the same repository.
        pub(super) fn same_repo(&self, other: &ChildRepo) -> bool {
            self.git_dir == other.git_dir
        }

        /// `args` behind the pin, one argv element each, so no path can read as an
        /// option. The git dir ends in a separator, so a file put where that directory
        /// was is refused (exit 128) rather than followed as a gitfile.
        fn argv<'a>(&'a self, args: &[&'a str]) -> Vec<&'a str> {
            let mut argv = vec![self.git_dir_arg.as_str(), self.work_tree_arg.as_str()];
            argv.extend_from_slice(args);
            argv
        }

        /// A read under [`NO_LAZY_FETCH`].
        pub(super) async fn read(&self, args: &[&str]) -> AppResult<GitOutput> {
            self.run_env(args, None, &NO_LAZY_FETCH, DEFAULT_TIMEOUT)
                .await
        }

        /// A raw run with no env of its own: the checkout, and the reads that never
        /// took [`NO_LAZY_FETCH`]. The folder stays the cwd, which `submodule status`
        /// and `submodule update` need even when pinned (measured).
        pub(super) async fn run(&self, args: &[&str], timeout: Duration) -> AppResult<GitOutput> {
            run_git_raw(Some(&self.folder), &self.argv(args), timeout).await
        }

        /// A raw run with stdin and env.
        pub(super) async fn run_env(
            &self,
            args: &[&str],
            input: Option<&str>,
            env: &[(&str, &str)],
            timeout: Duration,
        ) -> AppResult<GitOutput> {
            run_git_raw_input_env(Some(&self.folder), &self.argv(args), input, env, timeout).await
        }

        /// The fetch: `run_git_with_creds_once` puts its credential pairs ahead of this
        /// argv and hands the same argv to its ambient retry, so both spawns carry the pin.
        pub(super) async fn fetch(
            &self,
            cred: &[String],
            args: &[&str],
            timeout: Duration,
        ) -> AppResult<GitOutput> {
            crate::git::remote::run_git_with_creds_once(
                &self.folder,
                cred,
                &self.argv(args),
                timeout,
            )
            .await
        }
    }

    /// V3's refusal clause.
    const NOT_ITS_WORK_TREE: &str =
        "its .git names a repository that doesn't name this folder as its work tree (core.worktree)";

    fn unreadable(reason: String) -> Unusable {
        (SubmoduleCheckout::Unreadable, Some(reason))
    }

    /// Both paths canonicalized, which folds Windows 8.3 names, case and junctions; a
    /// path that can't be canonicalized refuses, never reads as "different".
    fn same_dir(a: &str, b: &str) -> Result<bool, Unusable> {
        Ok(canonical(a)? == canonical(b)?)
    }

    /// V3's arm (a): the git dir, canonicalized, is a `.git` directly inside the folder.
    /// Never `canonicalize(folder/.git)`, which follows a link put there. The name is
    /// compared exactly: canonicalize returns the on-disk spelling, and git creates
    /// `.git`; any other spelling takes arm (b).
    pub(super) fn own_git_dir(git_dir: &str, folder: &str) -> Result<bool, Unusable> {
        let dir = canonical(git_dir)?;
        let named = dir.file_name().is_some_and(|name| name == ".git");
        Ok(named && dir.parent() == Some(canonical(folder)?.as_path()))
    }

    /// Whether a component between the parent's root and the folder, the folder itself
    /// excluded (the probe's lstat answers for it), is a link or junction. A folder
    /// that isn't a plain path below the root is an error, never "no link".
    fn linked_on_the_way(repo_path: &str, worktree: &Path) -> std::io::Result<bool> {
        let not_plain = || {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "it isn't a plain path inside the repository",
            )
        };
        let rel = worktree.strip_prefix(repo_path).map_err(|_| not_plain())?;
        let mut segments = Vec::new();
        for component in rel.components() {
            match component {
                Component::Normal(segment) => {
                    segments.push(segment.to_str().ok_or_else(not_plain)?)
                }
                _ => return Err(not_plain()),
            }
        }
        crate::git::ops::linked_component(repo_path, &segments.join("/"), false)
    }

    fn canonical(path: &str) -> Result<PathBuf, Unusable> {
        std::fs::canonicalize(path).map_err(|e| unreadable(format!("couldn't read {path}: {e}")))
    }
}

/// git's discovery miss under the runner's LC_ALL=C (git 2.51.1). A `.git` file naming
/// a missing directory prints its own line instead, which stays `Unreadable`.
const NOT_A_REPOSITORY: &str =
    "fatal: not a git repository (or any of the parent directories): .git";

/// The lossy decode's replacement character. Output git printed that holds it has no
/// exact spelling here, so it is never used as a path, argument, key or shown name; a
/// genuine U+FFFD in a name degrades the same way, which is safe.
const LOSSY: char = '\u{FFFD}';

/// The resolver's refusal for a printed path holding [`LOSSY`].
const NOT_UTF8_PATH: &str = "git printed a path that isn't UTF-8";

/// A child-side read never fetches: a full id in a partial clone otherwise fetches from
/// the promisor inside the read. Honoured from git 2.45.0 and the 2.39.4+ security
/// releases, as in blob_sizes.rs. Never on the checkout or the fetch.
const NO_LAZY_FETCH: [(&str, &str); 1] = [("GIT_NO_LAZY_FETCH", "1")];

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
    Ok(
        gitlink_records(&out.stdout_lossy()).find_map(|(rec_path, sha, stage)| {
            (rec_path == path && stage == "0").then(|| sha.to_string())
        }),
    )
}

/// Whether the index records a gitlink at exactly `path` at ANY stage: a conflicted
/// submodule has stages 1-3 and no stage 0. A failed read is an Err.
async fn gitlink_recorded(repo_path: &str, path: &str, spec: &str) -> AppResult<bool> {
    let out = run_git_raw(
        Some(repo_path),
        &["ls-files", "-s", "-z", "--", spec],
        DEFAULT_TIMEOUT,
    )
    .await?
    .exit_verdict()?;
    Ok(gitlink_records(&out.stdout_lossy()).any(|(rec_path, _, _)| rec_path == path))
}

/// The gitlinks of an `ls-files -s -z` listing, as `(path, sha, stage)`.
fn gitlink_records(listing: &str) -> impl Iterator<Item = (&str, &str, &str)> {
    // `<mode> <sha> <stage>\t<path>`
    listing.split('\0').filter_map(|record| {
        let (meta, path) = record.split_once('\t')?;
        let mut meta = meta.split(' ');
        let (mode, sha, stage) = (meta.next()?, meta.next()?, meta.next()?);
        (mode == "160000").then_some((path, sha, stage))
    })
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
async fn submodule_range(
    child: &ChildRepo,
    from_sha: &str,
    to_sha: &str,
) -> Option<SubmoduleRange> {
    if !is_full_oid(from_sha) || !is_full_oid(to_sha) {
        return None;
    }
    let range = format!("{from_sha}...{to_sha}");
    let out = child
        .run(
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
        submodule_log(child, &ahead_range).await?
    } else {
        Vec::new()
    };
    let behind = if behind_count > 0 {
        submodule_log(child, &behind_range).await?
    } else {
        Vec::new()
    };
    Some(SubmoduleRange {
        ahead: (ahead, ahead_count),
        behind: (behind, behind_count),
    })
}

/// The newest commits of a validated two-dot range, sha and subject each.
async fn submodule_log(child: &ChildRepo, range: &str) -> Option<Vec<SubmoduleCommit>> {
    let max = format!("--max-count={SUBMODULE_COMMITS_CAP}");
    let out = child
        .run(
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
    /// The commit id `rev` resolved to, which the page was listed from: passed back as
    /// `rev`, later pages list the same history however the ref moves meanwhile. None
    /// when the checkout gate refused.
    pub tip: Option<String>,
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

    let worktree = Path::new(repo_path).join(path);
    let (child, checkout, reason) = child_gate(repo_path, &worktree).await;
    let mut page = SubmoduleCommitPage {
        checkout,
        reason,
        commits: vec![],
        has_more: false,
        shallow: None,
        tip: None,
    };
    let Some(child) = child else {
        return Ok(page);
    };
    let peeled = format!("{rev}^{{commit}}");
    let tip = child
        .read(&["rev-parse", "--verify", "--end-of-options", &peeled])
        .await?
        .exit_verdict()?
        .stdout_lossy()
        .trim()
        .to_string();
    if !is_full_oid(&tip) {
        return Err(AppError::Command(format!(
            "Couldn't resolve {} in the submodule.",
            crate::git::ops::discard_shown(rev)
        )));
    }
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
    args.extend(["--end-of-options", tip.as_str(), "--"]);
    let out = child.read(&args).await?.exit_verdict()?;
    let mut rows = crate::git::history::parse_commit_log(&out.stdout_lossy());
    page.has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let shas = rows.iter().map(|row| row.hash.clone()).collect::<Vec<_>>();
    page.tip = Some(tip);
    page.shallow = submodule_is_shallow(&child).await;
    let reach = remote_reach(&child, &shas, page.shallow).await;
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

async fn submodule_is_shallow(child: &ChildRepo) -> Option<bool> {
    let out = child
        .read(&["rev-parse", "--is-shallow-repository"])
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
/// A printed commit is asked again of [`reached_from`]: under committer-date skew the
/// walk prints reachable ones.
async fn remote_reach(
    child: &ChildRepo,
    shas: &[String],
    shallow: Option<bool>,
) -> Vec<Option<bool>> {
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
    let Ok(out) = child.read(&args).await else {
        return vec![None; shas.len()];
    };
    let stdout = out.stdout_lossy();
    let printed: std::collections::HashSet<_> = stdout.lines().collect();
    let capped = stdout.lines().count() > SUBMODULE_UNREACHED_CAP;
    let clean = out.stderr.trim().is_empty() && shallow == Some(false);
    let mut verdicts: Vec<Option<bool>> = shas
        .iter()
        .map(|sha| {
            if is_full_oid(sha) {
                reach_verdict(out.code == 0, clean, capped, printed.contains(sha.as_str()))
            } else {
                None
            }
        })
        .collect();
    // One `--contains` read (any of them) over every printed sha: an empty answer proves
    // them all unreached, so each is asked again only when it names a ref, which takes
    // committer-date skew. A failed read leaves them unknown.
    let contains: Vec<String> = shas
        .iter()
        .zip(&verdicts)
        .filter(|(_, verdict)| **verdict == Some(false))
        .map(|(sha, _)| format!("--contains={sha}"))
        .collect();
    if contains.is_empty() {
        return verdicts;
    }
    const REFS: [&str; 2] = ["refs/remotes", "refs/tags"];
    let mut args = vec!["for-each-ref", "--count=1", "--format=%(refname)"];
    args.extend(contains.iter().map(String::as_str));
    args.extend(REFS);
    note_recheck();
    let named = read_answer(child.read(&args).await).map(|listed| !listed.trim().is_empty());
    for (sha, verdict) in shas.iter().zip(verdicts.iter_mut()) {
        if *verdict == Some(false) {
            *verdict = match &named {
                Ok(false) => Some(false),
                Ok(true) => {
                    note_recheck();
                    reached_from(child, sha, &[], &REFS).await.ok()
                }
                Err(_) => None,
            };
        }
    }
    verdicts
}

#[cfg(test)]
tokio::task_local! {
    /// Counts [`remote_reach`]'s `--contains` reads, so a test can pin the batch.
    static RECHECKS: std::cell::Cell<usize>;
}

fn note_recheck() {
    #[cfg(test)]
    let _ = RECHECKS.try_with(|reads| reads.set(reads.get() + 1));
}

/// Whether `commit` is in the history of a `tips` commit or of a ref under `refs`, as
/// `merge-base --is-ancestor` and `for-each-ref --contains` answer: both follow every
/// parent, where a `rev-list --not` walk gives up early under committer-date skew and
/// prints reachable commits (measured, git 2.51.1). Err carries the failed read's line.
async fn reached_from(
    child: &ChildRepo,
    commit: &str,
    tips: &[&str],
    refs: &[&str],
) -> Result<bool, String> {
    for tip in tips {
        let out = child
            .read(&["merge-base", "--is-ancestor", commit, tip])
            .await
            .map_err(|e| nonempty_reason(e.to_string()))?;
        match out.code {
            0 => return Ok(true),
            1 => {}
            code => return Err(unreadable_reason(&out.stderr, code)),
        }
    }
    let contains = format!("--contains={commit}");
    let mut args = vec![
        "for-each-ref",
        "--count=1",
        "--format=%(refname)",
        &contains,
    ];
    args.extend_from_slice(refs);
    let listed = read_answer(child.read(&args).await)?;
    Ok(!listed.trim().is_empty())
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

/// The submodule's repository and its checkout state. No git runs inside unless
/// [`ChildRepo::resolve`] accepted the folder. A failed status read is `Unreadable`,
/// never clean.
async fn submodule_checkout_state(
    repo_path: &str,
    path: &str,
) -> (Option<ChildRepo>, SubmoduleCheckoutState) {
    let worktree = Path::new(repo_path).join(path);
    let (child, checkout, _) = child_gate(repo_path, &worktree).await;
    let mut state = SubmoduleCheckoutState {
        checkout,
        head: None,
        detached: false,
        dirty: false,
    };
    if let Some(child) = &child {
        let args = [
            "status",
            "--porcelain=v2",
            "--branch",
            UNTRACKED_NORMAL,
            "-z",
        ];
        match child.read(&args).await {
            Ok(out) if out.code == 0 => {
                let status = crate::git::status::parse_status_v2(&out.stdout_lossy());
                state.head = status.branch.oid;
                state.detached = status.branch.detached;
                state.dirty = !status.entries.is_empty();
            }
            _ => state.checkout = SubmoduleCheckout::Unreadable,
        }
    }
    (child, state)
}

/// Whether the submodule's object store has `sha` as a commit. Only a run that
/// answered decides: a spawn error or timeout is an Err, never "absent".
async fn commit_present(child: &ChildRepo, sha: &str) -> AppResult<bool> {
    let object = format!("{sha}^{{commit}}");
    let out = child.read(&["cat-file", "-e", &object]).await?;
    Ok(out.code == 0)
}

/// Whether `sha` may be looked up inside an initialized submodule at all.
async fn side_present(
    child: Option<&ChildRepo>,
    state: &SubmoduleCheckoutState,
    sha: &str,
) -> AppResult<bool> {
    match child {
        Some(child) if state.checkout == SubmoduleCheckout::Ok && is_full_oid(sha) => {
            commit_present(child, sha).await
        }
        _ => Ok(false),
    }
}

/// A present commit's subject and committer date; a failed read is an Err, never
/// a commit reported as missing.
async fn conflict_commit(child: &ChildRepo, sha: &str) -> AppResult<SubmoduleConflictCommit> {
    let out = child
        .run(
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
        .await?
        .exit_verdict()?;
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
async fn conflict_relation(
    child: &ChildRepo,
    ours: &str,
    theirs: &str,
) -> SubmoduleConflictRelation {
    let range = format!("{ours}...{theirs}");
    let counted = child
        .run(
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
    let (child, state) = submodule_checkout_state(repo_path, &path).await;
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
        let present = side_present(child.as_ref(), &state, &entry.sha).await?;
        let commit = match child.as_ref().filter(|_| present) {
            Some(child) => Some(conflict_commit(child, &entry.sha).await?),
            None => None,
        };
        *slot = Some(SubmoduleConflictSide {
            sha: entry.sha.clone(),
            gitlink: true,
            commit,
            plan: Some(plan_checkout(&state, &entry.sha, present, &recorded)),
        });
    }
    let [ours, theirs] = sides;
    let relation = match (&ours, &theirs, &child) {
        (Some(o), Some(t), Some(child)) if o.commit.is_some() && t.commit.is_some() => {
            conflict_relation(child, &o.sha, &t.sha).await
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
    // switch there can't land between the plan and the checkout. Only a folder git
    // takes as its own repository has one; git resolves any other to the parent's.
    let worktree = Path::new(repo_path).join(&path);
    let (decided, _, _) = child_gate(repo_path, &worktree).await;
    let submodule_domain = match &decided {
        Some(held) => Some(state.working_tree_lock(held.folder()).await),
        None => None,
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

    let (child, live) = submodule_checkout_state(repo_path, &path).await;
    // A checkout that appeared after the hold was decided, or another repository than
    // the held one, would be moved unheld.
    let replaced = matches!((&decided, &child), (Some(held), Some(now)) if !held.same_repo(now));
    if replaced || (live.checkout == SubmoduleCheckout::Ok && decided.is_none()) {
        return Ok(SubmoduleAcceptOutcome::Changed);
    }
    let present = side_present(child.as_ref(), &live, &sha).await?;
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
    let unchanged = || async {
        let now = conflict_entries(repo_path, &path).await?;
        Ok(!now.is_empty() && live_stages(&now) == *expected)
    };
    match stage_gitlink_write(repo_path, &info, unchanged).await {
        StageWrite::Ran(out) => {
            out?.exit_verdict()?;
        }
        StageWrite::Moved => return Ok(SubmoduleAcceptOutcome::Changed),
        StageWrite::Unchecked(e) => return Err(e),
    }
    // Read back. The write exited 0, so "nothing was staged" is no longer true: a
    // read-back that fails or differs is an Err saying what was staged and what the
    // index reads now, never `Changed`.
    let read_back = match conflict_entries(repo_path, &path).await {
        Ok(now) if !now.is_empty() => Ok(Some("it as conflicted again".to_string())),
        Ok(_) => index_gitlink(repo_path, &path, &crate::git::pathspec::literal(&path))
            .await
            .map(|staged| match staged {
                Some(staged) if staged == sha => None,
                Some(staged) => Some(format!("commit {}", short_oid(&staged))),
                None => Some("no commit for it".to_string()),
            }),
        Err(e) => Err(e),
    };
    let left_as_is = "The submodule's checkout was left as it was.";
    match read_back {
        Ok(None) => {}
        Ok(Some(reads)) => {
            let why = format!("something changed it right after: the index now reads {reads}");
            return Err(staged_but(
                &sha,
                &path,
                &format!(", but {why}. {left_as_is}"),
            ));
        }
        Err(e) => {
            let why = format!("couldn't read it back: {}", error_line(&e));
            return Err(staged_but(
                &sha,
                &path,
                &format!(", but {why}. {left_as_is}"),
            ));
        }
    }

    let left = |why| SubmoduleAcceptCheckout::Left { why, reason: None };
    let checkout = match plan {
        SubmoduleCheckoutPlan::CheckOut => match &child {
            Some(child) => {
                let head = live.head.as_deref();
                checkout_staged_commit(repo_path, &path, &worktree, child, &sha, head).await?
            }
            None => left(SubmoduleCheckoutLeft::Unusable),
        },
        SubmoduleCheckoutPlan::AlreadyThere => SubmoduleAcceptCheckout::AlreadyThere,
        SubmoduleCheckoutPlan::NotInitialized => left(SubmoduleCheckoutLeft::NotInitialized),
        SubmoduleCheckoutPlan::Unusable => left(SubmoduleCheckoutLeft::Unusable),
        SubmoduleCheckoutPlan::Dirty => left(SubmoduleCheckoutLeft::Dirty),
        SubmoduleCheckoutPlan::DetachedElsewhere => left(SubmoduleCheckoutLeft::DetachedElsewhere),
        SubmoduleCheckoutPlan::NotFetched => left(SubmoduleCheckoutLeft::NotFetched),
    };
    Ok(SubmoduleAcceptOutcome::Staged { sha, checkout })
}

/// Detaches the submodule at the staged commit. A checkout that didn't run or didn't
/// exit 0 is an outcome, never an Err: the pointer is already staged and the caller
/// must hear so. Just before the checkout the folder must still resolve to `child`
/// with HEAD at `head`, the one the plan read. After an exit 0 the folder's HEAD is
/// read back ([`head_read_back`]), since the pinned read answers for the held
/// repository, which outlives the folder's checkout: anything but `sha` there is an
/// Err, because the stage and the checkout both ran and "its checkout stays as is"
/// would be false. Out of reach by design: the gap before git takes its own lock
/// ([`detach_run`]) and the pinned directory swapped or replaced ([`ChildRepo`]).
async fn checkout_staged_commit(
    repo_path: &str,
    path: &str,
    worktree: &Path,
    child: &ChildRepo,
    sha: &str,
    head: Option<&str>,
) -> AppResult<SubmoduleAcceptCheckout> {
    let failed = |reason| {
        Ok(SubmoduleAcceptCheckout::Left {
            why: SubmoduleCheckoutLeft::Failed,
            reason: Some(reason),
        })
    };
    pre_checkout_hook().await;
    match head_read_back(repo_path, worktree, child).await {
        now if now.reads(head) => {}
        HeadRead::Unread(line) => return failed(format!("its HEAD couldn't be read: {line}")),
        HeadRead::Gone(why) if why != NO_COMMIT => return failed(why.to_string()),
        _ => return failed("its HEAD moved after it was read".to_string()),
    }
    match detach_run(repo_path, worktree, child, sha, head).await {
        Ok(out) if out.code == 0 => {}
        Ok(out) => return failed(unreadable_reason(&out.stderr, out.code)),
        Err(e) => return failed(nonempty_reason(e.to_string())),
    }
    let why = match head_read_back(repo_path, worktree, child).await {
        HeadRead::At(now) if now == sha => return Ok(SubmoduleAcceptCheckout::CheckedOut),
        HeadRead::At(now) => format!("its HEAD reads {} now", short_oid(&now)),
        HeadRead::Gone(why) => why.to_string(),
        HeadRead::Unread(line) => format!("its HEAD couldn't be read: {line}"),
    };
    Err(staged_but(
        sha,
        path,
        &format!(" and checked it out, but {why}."),
    ))
}

/// The accept's sentence once its stage write exited 0, `rest` completing "Staged
/// <short> for <shown>".
fn staged_but(sha: &str, path: &str, rest: &str) -> AppError {
    let shown = crate::git::ops::discard_shown(path);
    AppError::InvalidArgument(format!("Staged {} for {shown}{rest}", short_oid(sha)))
}

/// An Err's one line for a sentence: git's first stderr line, else its message.
fn error_line(e: &AppError) -> String {
    match e {
        AppError::Git { code, stderr } => unreadable_reason(stderr, *code),
        e => nonempty_reason(e.to_string()),
    }
}

/// The one checkout that moves a submodule, raw: only a spawn error or timeout is an
/// Err. Never `submodule update`, which fetches; `--no-overwrite-ignore` because a
/// plain checkout replaces an ignored file the target tracks while status calls the
/// tree clean (measured, git 2.51.1). `--no-recurse-submodules` keeps nested
/// submodules where they are, whatever `submodule.recurse` says. `<sha>^{commit}`,
/// never the bare id, which `checkout` reads as a same-named branch first (measured).
/// `head` is the HEAD the caller's pre-check just read in the folder. git's
/// index.lock refusal waits, reads the folder's HEAD again ([`head_read_back`]) and
/// retries per [`detach_retry`]. Out of reach by design: the one-spawn gap between a
/// folder check and git taking its own lock, since `checkout` takes no expected HEAD.
async fn detach_run(
    repo_path: &str,
    worktree: &Path,
    child: &ChildRepo,
    sha: &str,
    head: Option<&str>,
) -> AppResult<GitOutput> {
    let target = format!("{sha}^{{commit}}");
    let args = [
        "checkout",
        "--no-recurse-submodules",
        "--no-overwrite-ignore",
        "--detach",
        &target,
    ];
    let mut out = child.run(&args, WORKTREE_OP_TIMEOUT).await?;
    if out.code == 128 && out.stderr.contains("index.lock") {
        tokio::time::sleep(INDEX_LOCK_RETRY_DELAY).await;
        detach_wait_hook().await;
        let after = head_read_back(repo_path, worktree, child).await;
        if detach_retry(&out, head, &after) {
            out = child.run(&args, WORKTREE_OP_TIMEOUT).await?;
        }
    }
    Ok(out)
}

/// [`detach_run`], where exit 0 counts only with the folder's HEAD then at `sha` (a
/// hook can move it, a deinit can empty the folder); anything else is returned as a
/// failed run carrying that sentence.
async fn detach_submodule_at(
    repo_path: &str,
    worktree: &Path,
    child: &ChildRepo,
    sha: &str,
    head: Option<&str>,
) -> AppResult<GitOutput> {
    let out = detach_run(repo_path, worktree, child, sha, head).await?;
    if out.code != 0 {
        return Ok(out);
    }
    let after = head_read_back(repo_path, worktree, child).await;
    Ok(detach_landed(out, sha, &after))
}

/// Pure: an exit-0 checkout judged by the folder's HEAD read after it. At `sha` it
/// stands; a read that couldn't be made says the checkout couldn't be confirmed; any
/// other answer says where HEAD isn't. Both refusals return as a failed run.
fn detach_landed(out: GitOutput, sha: &str, after: &HeadRead) -> GitOutput {
    let stderr = match after {
        HeadRead::At(now) if now == sha => return out,
        HeadRead::Unread(reason) => format!("couldn't confirm the checkout: {reason}"),
        HeadRead::At(_) | HeadRead::Gone(_) => format!("HEAD isn't at {sha} after the checkout"),
    };
    GitOutput {
        stdout: out.stdout,
        stderr,
        code: 1,
    }
}

/// Pure: whether a checkout's index.lock refusal is retried. Only git's own refusal
/// (exit 128) with the folder's HEAD read AFTER the wait as `head`, the one the
/// pre-check read: whatever held the lock may have finished during it and left a
/// commit the plan never judged, or emptied the folder. A refused lock stops git
/// before it touches anything (measured), while a failing post-checkout hook can
/// print the same text after HEAD moved, and a retry would run that hook again.
fn detach_retry(out: &GitOutput, head: Option<&str>, after: &HeadRead) -> bool {
    out.code == 128 && out.stderr.contains("index.lock") && after.reads(head)
}

/// The runner's index.lock retry delay, for the retries this module runs itself.
const INDEX_LOCK_RETRY_DELAY: Duration = Duration::from_millis(300);

/// The submodule's HEAD commit: Some(None) when git answered without one (unborn or
/// unresolvable), None when git couldn't run.
async fn head_now(child: &ChildRepo) -> Option<Option<String>> {
    let out = child
        .read(&["rev-parse", "--verify", "-q", "HEAD"])
        .await
        .ok()?;
    Some((out.code == 0).then(|| out.stdout_lossy().trim().to_string()))
}

/// The folder's HEAD read back ([`head_read_back`]).
#[derive(Debug, Clone, PartialEq, Eq)]
enum HeadRead {
    /// HEAD names this commit.
    At(String),
    /// A confirmed absence, the clause saying which: the folder no longer holds that
    /// repository's checkout, or its HEAD names no commit ([`NO_COMMIT`]).
    Gone(&'static str),
    /// A read that couldn't be made, with its line.
    Unread(String),
}

/// [`HeadRead::Gone`]'s clause for a HEAD naming no commit (unborn or unresolvable).
const NO_COMMIT: &str = "its HEAD names no commit";
/// [`HeadRead::Gone`]'s clause for a folder that is missing, not initialized or replaced.
const FOLDER_GONE: &str = "its folder no longer holds that checkout";

impl HeadRead {
    /// Whether this is the HEAD a plan read: that commit, or no commit for None.
    fn reads(&self, head: Option<&str>) -> bool {
        match (self, head) {
            (HeadRead::At(now), Some(head)) => now == head,
            (HeadRead::Gone(why), None) => *why == NO_COMMIT,
            _ => false,
        }
    }
}

/// The folder's HEAD, not the held repository's: a deinit empties the folder and
/// keeps the module's HEAD (measured), so the folder is resolved again first. `Gone`
/// is a folder that no longer holds that repository's checkout (missing, not
/// initialized, replaced, or another repository there), or a HEAD naming no commit;
/// `Unread` is a read that couldn't be made: an identity refusal or an I/O failure in
/// the resolve, git couldn't answer for HEAD, or HEAD names an object that isn't a
/// commit this repository holds. That takes a second read: `-q HEAD^{commit}` exits
/// 1 silently both on an unborn HEAD and on a missing object (measured, git 2.51.1),
/// so HEAD is resolved first and its id then peeled.
async fn head_read_back(repo_path: &str, worktree: &Path, held: &ChildRepo) -> HeadRead {
    let now = match ChildRepo::resolve(repo_path, worktree).await {
        Ok(now) if now.same_repo(held) => now,
        Ok(_) => return HeadRead::Gone("its folder now holds another repository"),
        Err((SubmoduleCheckout::Unreadable, reason)) => {
            return HeadRead::Unread(reason.unwrap_or_else(|| "git couldn't read it".into()))
        }
        Err(_) => return HeadRead::Gone(FOLDER_GONE),
    };
    // The object id HEAD resolves to, never a name: the peel below reads that object.
    let id = match now.read(&["rev-parse", "--verify", "-q", "HEAD"]).await {
        Ok(out) if out.code == 0 => out.stdout_lossy().trim().to_string(),
        Ok(out) if out.code == 1 && out.stderr.trim().is_empty() => {
            return HeadRead::Gone(NO_COMMIT)
        }
        Ok(out) => return HeadRead::Unread(unreadable_reason(&out.stderr, out.code)),
        Err(e) => return HeadRead::Unread(nonempty_reason(e.to_string())),
    };
    let peel = format!("{id}^{{commit}}");
    let args = ["rev-parse", "--verify", "-q", "--end-of-options", &peel];
    match now.read(&args).await {
        Ok(out) if out.code == 0 && out.stdout_lossy().trim() == id => HeadRead::At(id),
        Ok(out) if out.code == 0 => HeadRead::Unread("its HEAD names a tag, not a commit".into()),
        // Silent: the object is missing; a tree or blob prints git's line.
        Ok(out) if out.stderr.trim().is_empty() => HeadRead::Unread(format!(
            "its HEAD names {}, which this repository doesn't hold",
            short_oid(&id)
        )),
        Ok(out) => HeadRead::Unread(unreadable_reason(&out.stderr, out.code)),
        Err(e) => HeadRead::Unread(nonempty_reason(e.to_string())),
    }
}

/// What one gitlink stage write did.
enum StageWrite {
    Ran(AppResult<GitOutput>),
    /// The compare before the retry found the pointer moved; nothing was written.
    Moved,
    /// The compare before the retry failed; nothing was written.
    Unchecked(AppError),
}

/// The conflict accept's write: `update-index --cacheinfo` with one index.lock retry.
/// `apply --cached` can't patch over unmerged stages (it answers "does not exist in
/// index", measured), so the accept has no compare-and-swap: `unchanged` runs again
/// right before the retry and a moved pointer is left alone.
async fn stage_gitlink_write<F, Fut>(repo_path: &str, info: &str, unchanged: F) -> StageWrite
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<bool>>,
{
    let args = ["update-index", "--cacheinfo", info];
    let first = run_git_raw(Some(repo_path), &args, DEFAULT_TIMEOUT).await;
    if !matches!(&first, Ok(out) if out.code != 0 && out.stderr.contains("index.lock")) {
        return StageWrite::Ran(first);
    }
    tokio::time::sleep(INDEX_LOCK_RETRY_DELAY).await;
    stage_retry_hook().await;
    match unchanged().await {
        Ok(true) => StageWrite::Ran(run_git_raw(Some(repo_path), &args, DEFAULT_TIMEOUT).await),
        Ok(false) => StageWrite::Moved,
        Err(e) => StageWrite::Unchecked(e),
    }
}

#[cfg(test)]
tokio::task_local! {
    /// Awaited between a stage write's lock refusal and its retry, so a test can
    /// release the lock and move the pointer there.
    static STAGE_RETRY_HOOK: PickLandedHook;
}

#[cfg(test)]
async fn stage_retry_hook() {
    if let Ok(hook) = STAGE_RETRY_HOOK.try_with(|hook| hook()) {
        hook.await;
    }
}

#[cfg(not(test))]
async fn stage_retry_hook() {}

/// The pick's stage write, parent-side: [`gitlink_patch`] through `apply --cached` on
/// stdin. apply takes index.lock, then checks the hunk's preimage against the staged
/// gitlink and writes under that one hold (apply.c, git v2.51.1), so a moved pointer
/// is refused, never overwritten, and the one retry after a lock refusal is blind.
async fn stage_gitlink_cas(
    repo_path: &str,
    path: &str,
    expected: &str,
    sha: &str,
) -> AppResult<GitOutput> {
    let patch = gitlink_patch(path, expected, sha);
    let args = ["apply", "--cached", "-"];
    let first = run_git_raw_input(Some(repo_path), &args, Some(&patch), DEFAULT_TIMEOUT).await;
    if !matches!(&first, Ok(out) if out.code != 0 && out.stderr.contains("index.lock")) {
        return first;
    }
    tokio::time::sleep(INDEX_LOCK_RETRY_DELAY).await;
    stage_retry_hook().await;
    run_git_raw_input(Some(repo_path), &args, Some(&patch), DEFAULT_TIMEOUT).await
}

/// One gitlink hunk moving `path` from `expected` to `sha`, both paths C-quoted.
fn gitlink_patch(path: &str, expected: &str, sha: &str) -> String {
    let (a, b) = (
        quote_patch_path(&format!("a/{path}")),
        quote_patch_path(&format!("b/{path}")),
    );
    format!(
        "diff --git {a} {b}\nindex {expected}..{sha} {GITLINK_MODE}\n--- {a}\n+++ {b}\n\
         @@ -1 +1 @@\n-Subproject commit {expected}\n+Subproject commit {sha}\n"
    )
}

/// A patch header's path, always in git's C-quoted form: `\` and `"` escaped, every
/// byte below 0x20 and 0x7f as three octal digits, the rest raw. The unquoted form
/// cuts a name at a tab (measured).
fn quote_patch_path(path: &str) -> String {
    let mut quoted = String::with_capacity(path.len() + 2);
    quoted.push('"');
    for c in path.chars() {
        match c {
            '\\' => quoted.push_str("\\\\"),
            '"' => quoted.push_str("\\\""),
            c if c < ' ' || c == '\x7f' => quoted.push_str(&format!("\\{:03o}", c as u32)),
            c => quoted.push(c),
        }
    }
    quoted.push('"');
    quoted
}

/// Pure: the pick's outcome from its stage write and the two reads after it, first
/// match wins. `wrote` is Err with the line of a write that didn't exit 0, `pointer`
/// the stage-0 gitlink read back (Err with the read's line), and `head` the folder's
/// HEAD read back ([`HeadRead`]). An `Unread` head, or an unread pointer under a head
/// that isn't at `sha`, is `ReadBackFailed`.
fn stage_verdict(
    wrote: &Result<(), String>,
    pointer: &Result<Option<String>, String>,
    head: &HeadRead,
    expected: &str,
    sha: &str,
    checkout: SubmodulePickMove,
) -> SubmodulePickOutcome {
    let unstaged = |why, reason: String| SubmodulePickOutcome::CheckedOutNotStaged {
        sha: sha.to_string(),
        why,
        reason: Some(reason),
    };
    let read_back_failed = |reason: &str| SubmodulePickOutcome::ReadBackFailed {
        sha: sha.to_string(),
        reason: reason.to_string(),
    };
    if let HeadRead::Unread(reason) = head {
        return read_back_failed(reason);
    }
    if !matches!(head, HeadRead::At(now) if now == sha) {
        return match pointer {
            Err(reason) => read_back_failed(reason),
            Ok(pointer) => SubmodulePickOutcome::MovedAfter {
                sha: sha.to_string(),
                pointer: pointer.clone(),
                head: match head {
                    HeadRead::At(now) => Some(now.clone()),
                    _ => None,
                },
            },
        };
    }
    match pointer {
        Ok(Some(pointer)) if pointer == sha => SubmodulePickOutcome::Set {
            sha: sha.to_string(),
            checkout,
            nested_left: None,
        },
        Err(reason) => unstaged(SubmodulePickUnstaged::StageUnconfirmed, reason.clone()),
        Ok(Some(pointer)) if pointer == expected => unstaged(
            SubmodulePickUnstaged::StageFailed,
            match wrote {
                Err(line) => line.clone(),
                Ok(()) => format!("the staged pointer still reads {}", short_oid(expected)),
            },
        ),
        // Nothing this call moved and nothing it staged: what was decided moved.
        Ok(_) if checkout == SubmodulePickMove::AlreadyThere && wrote.is_err() => {
            SubmodulePickOutcome::Changed
        }
        Ok(pointer) => unstaged(
            SubmodulePickUnstaged::PointerMoved,
            format!(
                "the recorded commit reads {} now",
                pointer.as_deref().map_or("nothing", short_oid)
            ),
        ),
    }
}

/// Every pick hold's label, the child's included: the user asked for one change.
const PICK_HOLDER: &str = "a submodule commit change";
/// Completes `refuse_mid_op_for`'s "Can't {action} while …" for the parent.
const PICK_ACTION: &str = "choose a submodule commit";
/// Each ref list's cap.
const SUBMODULE_REFS_CAP: usize = 500;
/// [`commits_by_prefix`]'s cap, history.rs's own: a list this long may be cut.
const PREFIX_LOOKUP_CAP: usize = 20;
/// Files in the way that a refusal lists.
const PICK_PATHS_CAP: usize = 20;
/// git's refusals that name the files in a checkout's way, each followed by
/// tab-led path lines (LC_ALL=C, which the runner pins), with the kind each names.
/// An ignored file in the way is listed under the untracked header: [`all_ignored`]
/// tells them apart.
const WOULD_OVERWRITE_HEADERS: [(&str, SubmodulePickBlock); 4] = [
    (
        "error: Your local changes to the following files would be overwritten by checkout:",
        SubmodulePickBlock::WouldOverwrite,
    ),
    (
        "error: The following untracked working tree files would be overwritten by checkout:",
        SubmodulePickBlock::UntrackedInTheWay,
    ),
    (
        "error: Updating the following directories would lose untracked files in them:",
        SubmodulePickBlock::UntrackedInTheWay,
    ),
    (
        "error: The following untracked working tree files would be removed by checkout:",
        SubmodulePickBlock::UntrackedInTheWay,
    ),
];
/// `read-tree`'s would-overwrite errors (unpack-trees.c's plumbing templates, git
/// v2.51.1) as prefix and suffix around the raw path, which carries no quoting, with
/// the kind each names.
const DRY_RUN_REFUSALS: [(&str, &str, SubmodulePickBlock); 5] = [
    (
        "error: Entry '",
        "' would be overwritten by merge. Cannot merge.",
        SubmodulePickBlock::WouldOverwrite,
    ),
    (
        "error: Entry '",
        "' not uptodate. Cannot merge.",
        SubmodulePickBlock::WouldOverwrite,
    ),
    (
        "error: Updating '",
        "' would lose untracked files in it",
        SubmodulePickBlock::UntrackedInTheWay,
    ),
    (
        "error: Untracked working tree file '",
        "' would be overwritten by merge.",
        SubmodulePickBlock::UntrackedInTheWay,
    ),
    (
        "error: Untracked working tree file '",
        "' would be removed by merge.",
        SubmodulePickBlock::UntrackedInTheWay,
    ),
];

/// The overwrite kinds in precedence order, highest first: several kinds report as
/// the highest one present.
fn overwrite_rank(kind: SubmodulePickBlock) -> u8 {
    match kind {
        SubmodulePickBlock::WouldOverwrite => 0,
        SubmodulePickBlock::UntrackedInTheWay => 1,
        _ => 2,
    }
}

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
    /// Tracked local changes the checkout would overwrite.
    WouldOverwrite,
    /// Untracked files the checkout would overwrite or remove.
    UntrackedInTheWay,
    /// Ignored files at paths the target adds or deletes.
    IgnoredInTheWay,
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
    /// After the stage the folder's HEAD read `head`, not `sha` (None: the folder no
    /// longer holds that checkout, or HEAD names no commit); `pointer` is the staged
    /// gitlink as read back (None: none recorded).
    MovedAfter {
        sha: String,
        pointer: Option<String>,
        head: Option<String>,
    },
    /// The submodule was checked out at `sha`, but a read back after the stage couldn't
    /// be made, so nothing is known about either value now; `reason` is that read's line.
    ReadBackFailed { sha: String, reason: String },
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

/// What the pick's gate measured: [`ChildRepo::resolve`] and, only when it accepted
/// the folder, one status read. A failed read is `Unreadable` with its reason, never
/// clean. `head` is None on an unborn branch.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PickGate {
    checkout: SubmoduleCheckout,
    reason: Option<String>,
    head: Option<String>,
    branch: Option<String>,
    detached: bool,
}

async fn pick_gate(repo_path: &str, path: &str) -> (Option<ChildRepo>, PickGate) {
    let worktree = Path::new(repo_path).join(path);
    let (child, checkout, reason) = child_gate(repo_path, &worktree).await;
    let mut gate = PickGate {
        checkout,
        reason,
        head: None,
        branch: None,
        detached: false,
    };
    let Some(found) = &child else {
        return (child, gate);
    };
    let args = [
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=no",
        "-z",
    ];
    match found.read(&args).await {
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
    (child, gate)
}

/// One mid-operation probe's answer.
#[derive(Debug, Clone, PartialEq, Eq)]
enum MidOpFact {
    Clear,
    /// The parent's refusal sentence, or the submodule's operation as a short noun
    /// phrase ("a merge", "unresolved conflicts"); None when the probe can't tell.
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
    /// The type read failed some other way than a missing object; git's lines.
    Failed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum OrphanFact {
    /// A ref or the target still reaches HEAD.
    Named,
    Orphan,
    Unverified(Option<String>),
}

/// git's dry run of the checkout, for the plan read. `Clear` is a dry run and ignored
/// check that found nothing in the way, including the degrades where the setter's real
/// checkout decides instead: a scratch index that couldn't be built, a partial clone
/// lacking the target's blobs, a sparse checkout, and an unanswered lstat. `Blocked` carries its [`SubmodulePickBlock`] overwrite kind.
#[derive(Debug, Clone, PartialEq, Eq)]
enum OverwriteFact {
    Clear,
    Blocked(SubmodulePickBlock, Vec<String>),
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
        Some(PickTarget::Failed(reason)) => return block(B::CheckFailed, Some(reason)),
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
    // A detached HEAD is always probed: moving it can leave commits no ref names, as
    // git's own "leaving N commits behind" warns, and no parent gitlink keeps one (the
    // child's gc never reads the parent). Only positive reachability proceeds: a shallow
    // entry is no gc root, and the app's own pruning fetch can withdraw the only ref.
    if facts.gate.detached {
        match &facts.orphan {
            None => return PickStep::Need(PickNeed::Orphan),
            Some(OrphanFact::Named) => {}
            Some(OrphanFact::Orphan) => return block(B::DetachedOrphan, None),
            Some(OrphanFact::Unverified(reason)) => {
                return block(B::DetachedUnverified, reason.as_deref())
            }
        }
    }
    if facts.with_overwrite {
        match &facts.overwrite {
            None => return PickStep::Need(PickNeed::Overwrite),
            Some(OverwriteFact::Blocked(why, paths)) => {
                return PickStep::Plan(SubmodulePickPlan::Blocked {
                    why: *why,
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

/// Reads the facts [`plan_pick`] asks for until it decides. A failed pointer read and a
/// failed resolution are Errs; a failed parent mid-operation probe and a failed probe
/// inside the submodule are data, read as a `checkFailed` plan.
async fn settle_pick(
    repo_path: &str,
    path: &str,
    child: Option<&ChildRepo>,
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
            PickNeed::ChildMidOp => {
                facts.child_mid_op = Some(submodule_mid_op(resolved(child)?).await)
            }
            PickNeed::Target => {
                let pointer_len = facts.pointer.clone().flatten().map_or(0, |p| p.len());
                facts.target = Some(resolve_pick(resolved(child)?, id, pointer_len).await?);
            }
            PickNeed::Orphan => {
                let shallow = match facts.shallow {
                    Some(shallow) => shallow,
                    None => submodule_is_shallow(resolved(child)?).await,
                };
                facts.shallow = Some(shallow);
                let head_sha = facts.gate.head.clone().unwrap_or_default();
                let sha = facts.target_sha().unwrap_or_default().to_string();
                let orphan = orphan_probe(resolved(child)?, path, &head_sha, &sha, shallow).await;
                facts.orphan = Some(orphan);
            }
            PickNeed::Overwrite => {
                let sha = facts.target_sha().unwrap_or_default().to_string();
                let child = resolved(child)?;
                let overwrite = pick_dry_run(child, facts.gate.head.as_deref(), &sha).await;
                facts.overwrite = Some(overwrite);
            }
        }
    }
}

/// The submodule a child-side fact reads. [`plan_pick`] asks for one only past a gate
/// that resolved it, so None is a broken invariant, refused before anything moves.
fn resolved(child: Option<&ChildRepo>) -> AppResult<&ChildRepo> {
    child.ok_or_else(|| AppError::Command("the submodule's repository wasn't resolved".into()))
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
/// exits 0 mid-rebase and leaves `rebase-merge` behind (measured). The markers are
/// read at the resolved git dir, so they are the submodule's own. The refusal names
/// what it found; a bisect isn't probed, so it never blocks.
async fn submodule_mid_op(child: &ChildRepo) -> MidOpFact {
    let unmerged = child
        .read(&["ls-files", "--unmerged"])
        .await
        .and_then(GitOutput::exit_verdict);
    match unmerged {
        Ok(out) if !out.stdout_lossy().trim().is_empty() => {
            return MidOpFact::Refused(Some("unresolved conflicts".into()))
        }
        Ok(_) => {}
        Err(e) => return MidOpFact::Failed(nonempty_reason(e.to_string())),
    }
    let state = crate::git::ops::op_state_at(Path::new(child.git_dir()));
    if state.mid_op() {
        MidOpFact::Refused(mid_op_name(&state).map(Into::into))
    } else {
        MidOpFact::Clear
    }
}

/// The operation an op state is in, as the plan's reason names it.
fn mid_op_name(state: &crate::git::types::RepoOpState) -> Option<&'static str> {
    [
        (state.rebasing, "a rebase"),
        (state.merging, "a merge"),
        (state.cherry_picking, "a cherry-pick"),
        (state.reverting, "a revert"),
    ]
    .into_iter()
    .find_map(|(on, name)| on.then_some(name))
}

/// The id is full when it is as long as the store's hashes, a prefix when shorter,
/// and refused when longer: a 64-hex id in a SHA-1 store exits 128 like an absent
/// one (measured). A prefix is looked up as object ids, never as a ref name.
async fn resolve_pick(child: &ChildRepo, id: &str, pointer_len: usize) -> AppResult<PickTarget> {
    if id.len() > pointer_len {
        return Err(invalid_commit_id(id));
    }
    if id.len() < pointer_len {
        return Ok(prefix_target(id, commits_by_prefix(child, id).await?));
    }
    // `cat-file -e <tag>^{commit}` exits 0, so the type is read instead (measured).
    let out = child.read(&["cat-file", "-t", id]).await?;
    let kind = out.stdout_lossy();
    Ok(match (out.code, kind.trim()) {
        (0, "commit") => PickTarget::Commit {
            sha: id.to_string(),
            row: None,
        },
        (0, _) => PickTarget::NotACommit,
        _ if out.stderr.trim() == ABSENT_OBJECT => PickTarget::NotFetched {
            sha: id.to_string(),
        },
        _ => PickTarget::Failed(git_lines(&out.stderr, out.code)),
    })
}

/// `cat-file -t`'s whole stderr for an object the store lacks, partial clones under
/// [`NO_LAZY_FETCH`] included (LC_ALL=C, git 2.51.1). A corrupt object prints its own
/// `error:` lines first.
const ABSENT_OBJECT: &str = "fatal: git cat-file: could not get object info";

/// Every non-empty stderr line, joined and capped; git's exit code when there's none.
fn git_lines(stderr: &str, code: i32) -> String {
    let joined = stderr
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("; ");
    unreadable_reason(&joined, code)
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

/// history.rs's `commits_by_prefix` behind the pin, so a folder emptied outside the app
/// can't answer with the parent's commits: local objects only, newest first by
/// committer date, capped at [`PREFIX_LOOKUP_CAP`]. Its on-branch ordering is left
/// out, since [`prefix_target`] reads only how many matched and the one row.
async fn commits_by_prefix(child: &ChildRepo, prefix: &str) -> AppResult<Vec<CommitSummary>> {
    let p = prefix.trim().to_ascii_lowercase();
    if !(4..=64).contains(&p.len()) || !p.bytes().all(|b| b.is_ascii_hexdigit()) {
        let shown = if prefix.is_empty() {
            "an empty prefix".to_string()
        } else {
            crate::git::ops::discard_shown(prefix)
        };
        return Err(AppError::InvalidArgument(format!(
            "invalid commit prefix: {shown}"
        )));
    }
    // git truncates an overlong prefix to its hash width, so only ids that extend `p`
    // survive.
    let disambiguate = format!("--disambiguate={p}");
    let listed = child
        .read(&["rev-parse", &disambiguate])
        .await?
        .exit_verdict()?
        .stdout_lossy();
    let candidates: Vec<&str> = listed
        .lines()
        .filter(|id| is_full_oid(id) && id.starts_with(&p))
        .collect();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let input: String = candidates.iter().map(|id| format!("{id}\n")).collect();
    let typed = child
        .run_env(
            &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
            Some(&input),
            &NO_LAZY_FETCH,
            DEFAULT_TIMEOUT,
        )
        .await?
        .exit_verdict()?
        .stdout_lossy();
    let lines: Vec<&str> = typed.lines().collect();
    if lines.len() != candidates.len() {
        return Err(AppError::Command(
            "Git returned an unreadable object list.".into(),
        ));
    }
    let commits: String = candidates
        .iter()
        .zip(&lines)
        .filter(|(id, line)| line.strip_suffix(" commit") == Some(**id))
        .map(|(id, _)| format!("{id}\n"))
        .collect();
    if commits.is_empty() {
        return Ok(Vec::new());
    }
    // `-n` turns `--no-walk` back into a full walk (measured, git 2.51.1), so the cap
    // is taken after the read.
    let log = child
        .run_env(
            &[
                "log",
                "--no-walk",
                "--stdin",
                "--no-color",
                "--no-show-signature",
                crate::git::history::LOG_FORMAT,
            ],
            Some(&commits),
            &NO_LAZY_FETCH,
            DEFAULT_TIMEOUT,
        )
        .await?
        .exit_verdict()?;
    Ok(crate::git::history::parse_commit_log(&log.stdout_lossy())
        .into_iter()
        .take(PREFIX_LOOKUP_CAP)
        .collect())
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
/// reads clean (measured). Only the target and the child's own refs count, the
/// retention git's gc applies. Shallow history makes a printed commit inconclusive,
/// with a reason only when the shallow probe itself failed.
async fn orphan_probe(
    child: &ChildRepo,
    path: &str,
    head_sha: &str,
    sha: &str,
    shallow: Option<bool>,
) -> OrphanFact {
    if !is_full_oid(head_sha) || !is_full_oid(sha) {
        return OrphanFact::Unverified(Some("the submodule's HEAD couldn't be read".into()));
    }
    let args = [
        "rev-list",
        "--max-count=1",
        head_sha,
        "--not",
        sha,
        "--branches",
        "--tags",
        "--remotes",
        "--",
    ];
    let printed = match child.read(&args).await {
        Ok(out) if out.code == 0 => !out.stdout_lossy().trim().is_empty(),
        Ok(out) => return OrphanFact::Unverified(Some(unreadable_reason(&out.stderr, out.code))),
        Err(e) => return OrphanFact::Unverified(Some(nonempty_reason(e.to_string()))),
    };
    if !printed {
        return OrphanFact::Named;
    }
    // Under committer-date skew the walk prints reachable commits: HEAD is unnamed only
    // once `merge-base` and `for-each-ref --contains` agree.
    let refs = ["refs/heads", "refs/tags", "refs/remotes"];
    match reached_from(child, head_sha, &[sha], &refs).await {
        Ok(true) => OrphanFact::Named,
        Ok(false) => match shallow {
            Some(false) => OrphanFact::Orphan,
            Some(true) => OrphanFact::Unverified(None),
            None => OrphanFact::Unverified(Some(format!(
                "couldn't tell whether {}'s history is shallow",
                crate::git::ops::discard_shown(path)
            ))),
        },
        Err(reason) => OrphanFact::Unverified(Some(reason)),
    }
}

/// A one-value answer (`rev-parse`, `config --get`) less its one trailing newline: git
/// ends it with exactly one `\n`, and a path or value may itself end in CR or LF.
fn single_value(text: &str) -> &str {
    text.strip_suffix('\n').unwrap_or(text)
}

/// A raw read's answer: stdout on exit 0, else the line a blocked plan carries.
fn read_answer(read: AppResult<GitOutput>) -> Result<String, String> {
    bytes_answer(read).map(|stdout| String::from_utf8_lossy(&stdout).into_owned())
}

/// [`read_answer`] with stdout as git printed it.
fn bytes_answer(read: AppResult<GitOutput>) -> Result<Vec<u8>, String> {
    match read {
        Ok(out) if out.code == 0 => Ok(out.stdout),
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
async fn pick_dry_run(child: &ChildRepo, head: Option<&str>, sha: &str) -> OverwriteFact {
    let from = match head {
        Some(head) => head.to_string(),
        None => match empty_tree(child).await {
            Ok(empty) => empty,
            Err(reason) => return OverwriteFact::Failed(reason),
        },
    };
    let index_path = ["rev-parse", "--path-format=absolute", "--git-path", "index"];
    let index = match read_answer(child.read(&index_path).await) {
        Ok(text) => PathBuf::from(single_value(&text)),
        Err(reason) => return OverwriteFact::Failed(reason),
    };
    let Some((_scratch_dir, scratch, copied)) = build_scratch_index(index).await else {
        return OverwriteFact::Clear;
    };
    let scratch = scratch.to_string_lossy().into_owned();
    let env = [("GIT_INDEX_FILE", scratch.as_str()), NO_LAZY_FETCH[0]];
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
        if let Err(e) = child.run_env(&refresh, None, &env, DEFAULT_TIMEOUT).await {
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
    match child.run_env(&dry_run, None, &env, DEFAULT_TIMEOUT).await {
        Ok(out) if out.code == 0 => {}
        // A partial clone lacking the target's blobs: the checkout fetches them, so it
        // decides.
        Ok(out)
            if out
                .stderr
                .lines()
                .any(|line| line.trim() == LAZY_FETCH_DISABLED) =>
        {
            return OverwriteFact::Clear
        }
        Ok(out) => {
            return match dry_run_refusal(out.code, &out.stderr) {
                Some((why, path)) => OverwriteFact::Blocked(why, vec![path]),
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
        match empty_tree(child).await {
            Ok(empty) => empty,
            Err(reason) => return OverwriteFact::Failed(reason),
        }
    };
    ignored_in_the_way(child, &added_from, sha).await
}

/// git's warning when [`NO_LAZY_FETCH`] stopped a read that needed a missing object
/// (LC_ALL=C, git 2.51.1).
const LAZY_FETCH_DISABLED: &str =
    "warning: lazy fetching disabled; some objects may not be available";

/// The store's own empty tree id (its hash algorithm's).
async fn empty_tree(child: &ChildRepo) -> Result<String, String> {
    let empty = child
        .run_env(
            &["hash-object", "-t", "tree", "--stdin"],
            Some(""),
            &[],
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

/// The kind and path a `read-tree` refusal names, when its stderr is exactly one of
/// git's would-overwrite errors (exit 128); anything else, a path holding [`LOSSY`]
/// included, is not a would-overwrite, and the plan reads it as "couldn't check".
fn dry_run_refusal(code: i32, stderr: &str) -> Option<(SubmodulePickBlock, String)> {
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
    DRY_RUN_REFUSALS.iter().find_map(|(prefix, suffix, why)| {
        line.strip_prefix(prefix)?
            .strip_suffix(suffix)
            .filter(|path| !path.is_empty() && !path.contains(LOSSY))
            .map(|path| (*why, path.to_string()))
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
    let mut seen = std::collections::HashSet::new();
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
        if let Some(found) = found.filter(|found| seen.insert(found.clone())) {
            candidates.push(found);
        }
    }
    Ok(candidates)
}

/// Ignored files in the way of what the target adds or deletes, which `read-tree`
/// replaces or removes where the checkout (`--no-overwrite-ignore`) refuses (both
/// measured). Skipped in a sparse checkout, where an untracked file at an excluded
/// path the target adds went through (measured), and when a candidate's lstat went
/// unanswered. Sparse means `core.sparseCheckout` with a patterns file: without one
/// git checks out the whole tree.
async fn ignored_in_the_way(child: &ChildRepo, from: &str, sha: &str) -> OverwriteFact {
    let sparse = child
        .read(&["config", "--type=bool", "--get", "core.sparseCheckout"])
        .await
        .and_then(config_answer);
    match sparse {
        Ok(Some(out)) if out.stdout_lossy().trim() == "true" => {
            match sparse_patterns(child).await {
                Ok(true) => return OverwriteFact::Clear,
                Ok(false) => {}
                Err(reason) => return OverwriteFact::Failed(reason),
            }
        }
        Ok(_) => {}
        Err(e) => return OverwriteFact::Failed(nonempty_reason(e.to_string())),
    }
    let changes = [
        "diff-tree",
        "-r",
        "--raw",
        "--no-renames",
        "--diff-filter=AD",
        "-z",
        from,
        sha,
    ];
    // `-z` prints paths as bytes: one that isn't UTF-8 has no exact name to look up on
    // disk or to match in a pathspec, and its lossy spelling would check another file.
    let raw = match bytes_answer(child.read(&changes).await).and_then(|raw| {
        String::from_utf8(raw).map_err(|_| "git listed a path that isn't UTF-8".to_string())
    }) {
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
        // A deleted gitlink's folder stays too, so either side's mode counts.
        let mut modes = meta.split(' ').take(2);
        let gitlink = modes.any(|mode| mode == GITLINK_MODE);
        added.push((path.to_string(), gitlink));
    }
    let base = PathBuf::from(child.folder());
    let walked =
        tauri::async_runtime::spawn_blocking(move || ignored_candidates(&base, &added, on_disk))
            .await;
    let candidates = match walked {
        Ok(Ok(candidates)) if !candidates.is_empty() => candidates,
        _ => return OverwriteFact::Clear,
    };
    // One index read: a candidate still in the index is tracked, which the checkout's
    // own refusal names, so only the rest are listed below.
    let index = match bytes_answer(child.read(&["ls-files", "-z"]).await) {
        Ok(index) => index,
        Err(reason) => return OverwriteFact::Failed(reason),
    };
    // Compared as bytes, so a path that isn't UTF-8 never stands in for a candidate.
    let tracked: std::collections::HashSet<&[u8]> = index.split(|byte| *byte == 0).collect();
    let candidates: Vec<&String> = candidates
        .iter()
        .filter(|path| !tracked.contains(path.as_bytes()))
        .collect();
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
        match bytes_answer(child.read(&args).await).and_then(ignored_listed) {
            Ok(listed) => paths.extend(listed),
            Err(reason) => return OverwriteFact::Failed(reason),
        }
        if paths.len() >= PICK_PATHS_CAP {
            break;
        }
    }
    if paths.is_empty() {
        return OverwriteFact::Clear;
    }
    paths.truncate(PICK_PATHS_CAP);
    OverwriteFact::Blocked(SubmodulePickBlock::IgnoredInTheWay, paths)
}

/// Pure: the paths of an `ls-files --others --ignored -z` listing. One that isn't
/// UTF-8 fails the listing, as `diff-tree`'s does: its lossy spelling names another
/// file. An ignored nested repository lists as `nr/`; the checkout names it `nr`.
fn ignored_listed(listed: Vec<u8>) -> Result<Vec<String>, String> {
    let listed =
        String::from_utf8(listed).map_err(|_| "git listed a path that isn't UTF-8".to_string())?;
    Ok(listed
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(|path| path.strip_suffix('/').unwrap_or(path).to_string())
        .collect())
}

/// Whether the sparse patterns file exists; Err carries the failed read's line.
async fn sparse_patterns(child: &ChildRepo) -> Result<bool, String> {
    let args = [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "info/sparse-checkout",
    ];
    let file = read_answer(child.read(&args).await)?;
    let file = PathBuf::from(single_value(&file));
    file.try_exists()
        .map_err(|e| nonempty_reason(e.to_string()))
}

/// The commit's row for the plan read; a failed read is an Err.
async fn pick_commit_row(child: &ChildRepo, sha: &str) -> AppResult<Option<SubmoduleRefCommit>> {
    let out = child
        .read(&[
            "log",
            "--no-walk",
            "--no-color",
            "--no-show-signature",
            crate::git::history::LOG_FORMAT,
            sha,
            "--",
        ])
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
async fn pick_relation(child: &ChildRepo, pointer: &str, sha: &str) -> SubmodulePickRelation {
    if pointer == sha {
        return SubmodulePickRelation::Same;
    }
    if !is_full_oid(pointer) || !is_full_oid(sha) {
        return SubmodulePickRelation::Unknown;
    }
    let range = format!("{pointer}...{sha}");
    let Ok(out) = child
        .read(&["rev-list", "--left-right", "--count", &range])
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
    let (child, gate) = pick_gate(repo_path, path).await;
    let mut facts = PickFacts::new(gate, true);
    let plan = settle_pick(repo_path, path, child.as_ref(), &id, &mut facts).await?;

    let pointer = match facts.pointer.take() {
        Some(pointer) => pointer,
        None => index_gitlink(repo_path, path, &crate::git::pathspec::literal(path)).await?,
    };
    let child = child
        .as_ref()
        .filter(|_| facts.gate.checkout == SubmoduleCheckout::Ok);
    let shallow = match (facts.shallow, child) {
        (Some(shallow), _) => shallow,
        (None, Some(child)) => submodule_is_shallow(child).await,
        (None, None) => None,
    };
    let (sha, mut commit) = match facts.target.take() {
        Some(PickTarget::Commit { sha, row }) => {
            let row = match (row, child) {
                (Some(row), _) => Some(row),
                (None, Some(child)) => pick_commit_row(child, &sha).await?,
                (None, None) => None,
            };
            (Some(sha), row)
        }
        Some(PickTarget::NotFetched { sha }) => (Some(sha), None),
        _ => (None, None),
    };
    let relation = match (&pointer, &sha, &commit, child) {
        (Some(pointer), Some(sha), Some(_), Some(child)) => {
            pick_relation(child, pointer, sha).await
        }
        _ => SubmodulePickRelation::Unknown,
    };
    if let (Some(commit), Some(child)) = (commit.as_mut(), child) {
        commit.on_remote = remote_reach(child, std::slice::from_ref(&commit.sha), shallow)
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
    /// Awaited between a pick's landed checkout and its stage write, so a test can move
    /// the pointer or the checkout there.
    static PICK_LANDED_HOOK: PickLandedHook;
}

#[cfg(test)]
tokio::task_local! {
    /// Awaited between an update's bump and its settling leg, so a test can deinit the
    /// bumped submodule there.
    static UPDATE_SETTLE_HOOK: PickLandedHook;
}

#[cfg(test)]
async fn pick_landed_hook() {
    if let Ok(landed) = PICK_LANDED_HOOK.try_with(|hook| hook()) {
        landed.await;
    }
}

#[cfg(not(test))]
async fn pick_landed_hook() {}

#[cfg(test)]
tokio::task_local! {
    /// Awaited just before a checkout's pre-write re-check, the pick's and the
    /// accept's, before a pick's re-check when its HEAD is already there, and before an
    /// already-current pick's re-check, so a test can move the checkout or the pointer
    /// there.
    static PRE_CHECKOUT_HOOK: PickLandedHook;
}

#[cfg(test)]
async fn pre_checkout_hook() {
    if let Ok(hook) = PRE_CHECKOUT_HOOK.try_with(|hook| hook()) {
        hook.await;
    }
}

#[cfg(not(test))]
async fn pre_checkout_hook() {}

#[cfg(test)]
tokio::task_local! {
    /// Awaited after a checkout's index.lock wait, before HEAD is read again, so a test
    /// can release the lock and move HEAD there.
    static DETACH_WAIT_HOOK: PickLandedHook;
}

#[cfg(test)]
async fn detach_wait_hook() {
    if let Ok(hook) = DETACH_WAIT_HOOK.try_with(|hook| hook()) {
        hook.await;
    }
}

#[cfg(not(test))]
async fn detach_wait_hook() {}

#[cfg(test)]
tokio::task_local! {
    /// Awaited once a fetch holds its network key, before its gates run again, so a
    /// test can move the folder or the parent's record there.
    static FETCH_WAITED_HOOK: PickLandedHook;
}

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
/// parameter so a test can shorten it. git has no transaction across two
/// repositories, so the pick is ordered and then observed. The pointer is compared
/// before anything moves, and just before the checkout the folder must still resolve
/// to the held repository with HEAD where the plan read it (either move answers
/// `Changed`, nothing touched); the checkout lands; the stage is a preimage-checked
/// patch (`apply --cached`), which compares
/// the staged gitlink with `expected` and writes under one index.lock hold, so an
/// outside stage is never overwritten and a lock retry needs no re-compare. The
/// verdict is READ BACK, and each read is three-valued: a value, a confirmed absence,
/// or a read that couldn't be made. `Set` means the staged gitlink and the FOLDER's
/// HEAD (the folder resolved again, since the held repository outlives its checkout)
/// each read `sha`. A confirmed other reading is returned as read (`MovedAfter`,
/// `CheckedOutNotStaged`); a read that couldn't be made is never turned into an
/// absence or a move (`ReadBackFailed`, `StageUnconfirmed` with the read's line).
/// Still open: the two reads are not one snapshot, anything outside the app can move
/// either value after them, and a hook the write runs is seen only by the read-back.
/// Once a checkout landed nothing rolls back and no error escapes. Out of reach by
/// design: the gap before git takes its own lock ([`detach_run`]), the pinned
/// directory swapped or replaced ([`ChildRepo`]), an inherited `GIT_DIR` /
/// `GIT_WORK_TREE` (the app's runner policy), and a path git prints that isn't UTF-8,
/// which reads as "couldn't check". A prune that lands after the orphan check, from the
/// parent's own fetch (which recurses into changed submodules) or from outside the app,
/// can leave the moved-off commit only in the reflog, exactly as the same prune right
/// after Apply would. A HEAD the orphan check can't place never moves: a shallow entry
/// is no gc root and the app's own pruning fetch can withdraw the only ref.
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
    if let Some(stop) = pick_entry_gate(repo_path, &path, &spec, &sha, &expected).await? {
        return Ok(stop);
    }

    // The submodule's own working-tree domain, parent then child as the accept takes
    // them. Only a folder the gate reads as checked out has one: any other spelling
    // resolves to the parent's checkout and would cache that key for the folder.
    let worktree = Path::new(repo_path).join(&path);
    let (decided, _, _) = child_gate(repo_path, &worktree).await;
    let child_domain = match &decided {
        Some(held) => Some(state.working_tree_lock(held.folder()).await),
        None => None,
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
    // An outside stage or a parent merge begun during the wait.
    if let Some(stop) = pick_entry_gate(repo_path, &path, &spec, &sha, &expected).await? {
        return Ok(stop);
    }

    let (child, gate) = pick_gate(repo_path, &path).await;
    // A checkout that appeared after the hold was decided, or another repository than
    // the held one, would be moved unheld.
    let replaced = matches!((&decided, &child), (Some(held), Some(now)) if !held.same_repo(now));
    if replaced || (gate.checkout == SubmoduleCheckout::Ok && decided.is_none()) {
        return Ok(SubmodulePickOutcome::Changed);
    }
    let head_before = gate.head.clone();
    let mut facts = PickFacts::new(gate, false);
    facts.pointer = Some(Some(expected.clone()));
    facts.parent_mid_op = Some(MidOpFact::Clear);
    let checkout = match settle_pick(repo_path, &path, child.as_ref(), &sha, &mut facts).await? {
        SubmodulePickPlan::Blocked { why, reason, paths } => {
            return Ok(SubmodulePickOutcome::Blocked { why, reason, paths })
        }
        SubmodulePickPlan::Current => {
            // Nothing to move, but `Set` still says the pointer and the folder's HEAD
            // read `sha` now: either moved during the probes is `Changed`, and so is a
            // HEAD read that couldn't be made (nothing was touched); a failed pointer
            // read is an Err, as on the other arms.
            pre_checkout_hook().await;
            if index_gitlink(repo_path, &path, &spec).await?.as_deref() != Some(expected.as_str()) {
                return Ok(SubmodulePickOutcome::Changed);
            }
            let Some(held) = child.as_ref() else {
                return Ok(SubmodulePickOutcome::Changed);
            };
            if !head_read_back(repo_path, &worktree, held)
                .await
                .reads(head_before.as_deref())
            {
                return Ok(SubmodulePickOutcome::Changed);
            }
            return Ok(SubmodulePickOutcome::Set {
                checkout: SubmodulePickMove::AlreadyThere,
                nested_left: nested_left(child.as_ref(), head_before.as_deref(), &sha).await,
                sha,
            });
        }
        SubmodulePickPlan::Ready { checkout } => checkout,
    };

    // Again after the child wait and the probes: an early exit that keeps `Changed`'s
    // promise (nothing touched). The stage's preimage check is the guarantee.
    if index_gitlink(repo_path, &path, &spec).await?.as_deref() != Some(expected.as_str()) {
        return Ok(SubmodulePickOutcome::Changed);
    }
    // The pre-write re-check, on both arms: an outside commit on a detached HEAD since
    // the plan's read would be orphaned, a folder deinit-ed meanwhile repopulated, and
    // a pointer staged at a HEAD the folder no longer holds.
    let held = resolved(child.as_ref())?;
    pre_checkout_hook().await;
    if !head_read_back(repo_path, &worktree, held)
        .await
        .reads(head_before.as_deref())
    {
        return Ok(SubmodulePickOutcome::Changed);
    }
    if checkout == SubmodulePickMove::CheckOut {
        let child = held;
        let head = head_before.as_deref();
        let moved = detach_submodule_at(repo_path, &worktree, child, &sha, head).await;
        if !matches!(&moved, Ok(out) if out.code == 0) {
            return Ok(pick_checkout_verdict(child, head_before.as_deref(), moved).await);
        }
        pick_landed_hook().await;
    }
    // A pointer already at `sha` (only the checkout differed) needs no write.
    let wrote = if sha == expected {
        Ok(())
    } else {
        match stage_gitlink_cas(repo_path, &path, &expected, &sha).await {
            Ok(out) if out.code == 0 => Ok(()),
            Ok(out) => Err(unreadable_reason(&out.stderr, out.code)),
            Err(e) => Err(nonempty_reason(e.to_string())),
        }
    };
    let pointer = index_gitlink(repo_path, &path, &spec)
        .await
        .map_err(|e| nonempty_reason(e.to_string()));
    let head = match child.as_ref() {
        Some(child) => head_read_back(repo_path, &worktree, child).await,
        None => HeadRead::Gone(FOLDER_GONE),
    };
    let mut outcome = stage_verdict(&wrote, &pointer, &head, &expected, &sha, checkout);
    if let SubmodulePickOutcome::Set {
        nested_left: left, ..
    } = &mut outcome
    {
        *left = nested_left(child.as_ref(), head_before.as_deref(), &sha).await;
    }
    Ok(outcome)
}

/// The setter's parent-side gate, run on entry and again after the child wait: the
/// pointer still at `expected`, and no operation in progress in the parent. Some is
/// the outcome that stops the pick: an early exit that keeps `Changed`'s promise, not
/// the guarantee, which is the stage's preimage check.
async fn pick_entry_gate(
    repo_path: &str,
    path: &str,
    spec: &str,
    sha: &str,
    expected: &str,
) -> AppResult<Option<SubmodulePickOutcome>> {
    match index_gitlink(repo_path, path, spec).await? {
        // A 64/64 pair against a SHA-1 store would otherwise read as moved.
        Some(live) if live.len() != sha.len() => return Err(invalid_commit_id(sha)),
        Some(live) if live == expected => {}
        _ => return Ok(Some(SubmodulePickOutcome::Changed)),
    }
    Ok(match parent_mid_op(repo_path).await? {
        MidOpFact::Refused(reason) => Some(SubmodulePickOutcome::Blocked {
            why: SubmodulePickBlock::MidOperation,
            reason,
            paths: Vec::new(),
        }),
        _ => None,
    })
}

/// A checkout that didn't exit 0. Only git's own refusal, with HEAD re-read and still
/// where it was, is "in the way": a failing post-checkout hook can print a forged
/// header after HEAD moved (measured), and tab-led lines alone decide nothing.
async fn pick_checkout_verdict(
    child: &ChildRepo,
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
    if let Some((why, header, paths)) = would_overwrite(&out.stderr) {
        let head_after = head_now(child).await.flatten();
        if head_after.is_some() && head_after.as_deref() == head_before {
            let listed = listed_paths(&out.stderr);
            // lstat, never following a link: the listed name itself must be there.
            let folder = PathBuf::from(child.folder());
            let exists = |path: &str| folder.join(path).symlink_metadata().is_ok();
            let (reason, paths, exact) = exact_listing(header, paths, &listed, exists);
            // Untracked paths that are all ignored report as `IgnoredInTheWay`; one
            // that isn't, or one with no exact spelling to ask about, keeps the
            // untracked kind, which outranks it.
            let why = match why {
                SubmodulePickBlock::UntrackedInTheWay
                    if exact && all_ignored(child, &listed).await == Some(true) =>
                {
                    SubmodulePickBlock::IgnoredInTheWay
                }
                why => why,
            };
            return SubmodulePickOutcome::Blocked {
                why,
                reason: Some(reason),
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

/// The highest-ranked kind among git's would-overwrite headers, the first header, and
/// the tab-led paths after each one.
fn would_overwrite(stderr: &str) -> Option<(SubmodulePickBlock, String, Vec<String>)> {
    let mut header = None;
    let mut why: Option<SubmodulePickBlock> = None;
    let mut paths = Vec::new();
    let mut listing = false;
    for line in stderr.lines() {
        if let Some((_, kind)) = WOULD_OVERWRITE_HEADERS
            .iter()
            .find(|(text, _)| *text == line)
        {
            header.get_or_insert_with(|| line.to_string());
            if why.is_none_or(|seen| overwrite_rank(*kind) < overwrite_rank(seen)) {
                why = Some(*kind);
            }
            listing = true;
        } else if let Some(path) = line.strip_prefix('\t').filter(|_| listing) {
            if paths.len() < PICK_PATHS_CAP {
                paths.push(path.to_string());
            }
        } else {
            listing = false;
        }
    }
    Some((why?, header?, paths)).filter(|(_, _, paths)| !paths.is_empty())
}

/// A refused checkout's reason, shown paths, and whether every listed path is exact:
/// one holding [`LOSSY`], or one `exists` doesn't find in the folder, is left out of
/// `paths`, and the reason says so. git prints each path raw up to a newline, so a
/// name holding one arrives cut, naming nothing there.
fn exact_listing(
    header: String,
    paths: Vec<String>,
    listed: &[String],
    exists: impl Fn(&str) -> bool,
) -> (String, Vec<String>, bool) {
    let is_exact = |path: &String| !path.contains(LOSSY) && exists(path);
    let exact = listed.iter().all(is_exact);
    let paths = paths.into_iter().filter(is_exact).collect();
    let reason = if exact {
        header
    } else {
        format!("{header} {LOSSY_PATHS_LEFT_OUT}")
    };
    (reason, paths, exact)
}

const LOSSY_PATHS_LEFT_OUT: &str = "(paths git printed that couldn't be read exactly are left out)";

/// Every tab-led path after one of git's would-overwrite headers, uncapped.
fn listed_paths(stderr: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut listing = false;
    for line in stderr.lines() {
        if WOULD_OVERWRITE_HEADERS
            .iter()
            .any(|(text, _)| *text == line)
        {
            listing = true;
        } else if let Some(path) = line.strip_prefix('\t').filter(|_| listing) {
            paths.push(path.to_string());
        } else {
            listing = false;
        }
    }
    paths
}

/// Whether git's ignore rules match every one of `paths` (folder-relative): one
/// `check-ignore --no-index --stdin -z` read, which answers for untracked paths and
/// never consults the index. None when the read failed or there is nothing to ask.
async fn all_ignored(child: &ChildRepo, paths: &[String]) -> Option<bool> {
    if paths.is_empty() {
        return None;
    }
    // check-ignore reads each input as a pathspec, so a name led by `:` reads as magic,
    // and it refuses `--literal-pathspecs` (measured, git 2.51.1). A `./` lead makes
    // every name a plain path, and git prints each input back as given.
    let asked: Vec<String> = paths.iter().map(|path| format!("./{path}")).collect();
    let input: String = asked.iter().map(|path| format!("{path}\0")).collect();
    let args = ["check-ignore", "--no-index", "--stdin", "-z"];
    let out = child
        .run_env(&args, Some(&input), &NO_LAZY_FETCH, DEFAULT_TIMEOUT)
        .await
        .ok()?;
    // Exit 1: nothing matched.
    if !matches!(out.code, 0 | 1) {
        return None;
    }
    let listed = out.stdout_lossy();
    let ignored: std::collections::HashSet<&str> = listed.split('\0').collect();
    Some(asked.iter().all(|path| ignored.contains(path.as_str())))
}

/// Nested submodules the pick left behind: the `+` rows of `submodule status` (checked
/// out at another commit than it records), and the `-` rows (not checked out) only at
/// gitlinks the pick added or changed against `before`, the pre-pick HEAD (None =
/// unborn), so one the user left uninitialized counts only when the pick moved it.
/// The rows are read against the submodule's own gitlinks, as the list reads the
/// parent's ([`paired_rows`]). None when a read failed, the two reads don't pair, or a
/// path it compares holds [`LOSSY`].
async fn nested_left(child: Option<&ChildRepo>, before: Option<&str>, sha: &str) -> Option<u32> {
    let child = child?;
    let listing = read_answer(child.read(&["ls-files", "-s", "-z"]).await).ok()?;
    let mut paths: Vec<String> = gitlink_records(&listing)
        .map(|(path, ..)| path.to_string())
        .collect();
    paths.dedup();
    let out = child.read(&["submodule", "status"]).await.ok()?;
    if out.code != 0 {
        return None;
    }
    let status = out.stdout_lossy();
    let (mut left, uninitialized) = nested_rows(&status, &paths)?;
    if !uninitialized.is_empty() {
        let from = match before {
            Some(before) => before.to_string(),
            None => empty_tree(child).await.ok()?,
        };
        let args = ["diff-tree", "-r", "--raw", "--no-renames", "-z", &from, sha];
        let raw = read_answer(child.read(&args).await).ok()?;
        let moved = moved_gitlinks(&raw)?;
        left += uninitialized
            .iter()
            .filter(|path| moved.contains(path))
            .count();
    }
    u32::try_from(left).ok()
}

/// Pure: a `submodule status` listing's `+` row count and its `-` rows' paths, each row
/// read against its gitlink in `paths` (a path may hold a newline). None when the
/// listing doesn't pair with `paths`, or a `-` path holds [`LOSSY`]: it has no exact
/// spelling to compare.
fn nested_rows<'a>(status: &str, paths: &'a [String]) -> Option<(usize, Vec<&'a str>)> {
    let rows = paired_rows(status, paths)?;
    let changed = rows.iter().filter(|(flag, ..)| *flag == '+').count();
    let uninitialized: Vec<&str> = rows
        .iter()
        .zip(paths)
        .filter(|((flag, ..), _)| *flag == '-')
        .map(|(_, path)| path.as_str())
        .collect();
    (!uninitialized.iter().any(|path| path.contains(LOSSY))).then_some((changed, uninitialized))
}

/// Pure: the gitlink paths of a `diff-tree --raw -z` listing. None when one holds
/// [`LOSSY`]: it has no exact spelling to compare.
fn moved_gitlinks(raw: &str) -> Option<Vec<&str>> {
    let mut fields = raw.split('\0');
    let mut moved = Vec::new();
    while let (Some(meta), Some(path)) = (fields.next(), fields.next()) {
        let Some(meta) = meta.strip_prefix(':') else {
            break;
        };
        if meta.split(' ').nth(1) == Some(GITLINK_MODE) {
            moved.push(path);
        }
    }
    (!moved.iter().any(|path| path.contains(LOSSY))).then_some(moved)
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
    let (child, gate) = pick_gate(repo_path, path).await;
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
    let (Some(child), SubmoduleCheckout::Ok) = (child, refs.checkout) else {
        return Ok(refs);
    };
    (refs.head, refs.branch, refs.detached) = (gate.head, gate.branch, gate.detached);

    let remotes = child_remotes(&child).await?;
    let listed = child
        .read(&[
            "for-each-ref",
            "--sort=-version:refname",
            "--format=%(refname)%00%(objectname)%00%(symref)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ])
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
        // A name with no exact spelling here would be offered as a rev git can't take.
        if rev.is_empty() || rev.contains(LOSSY) || symref.contains(LOSSY) {
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
        child
            .run_env(
                &["cat-file", "--batch-check=%(objectname) %(objecttype)"],
                Some(&input),
                &NO_LAZY_FETCH,
                DEFAULT_TIMEOUT,
            )
            .await?
            .exit_verdict()?
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
    refs.shallow = submodule_is_shallow(&child).await;
    refs.default_rev = default_rev(
        repo_path,
        path,
        &child,
        refs.branch.as_deref(),
        &refs.remote_branches,
        &symrefs,
    )
    .await;
    Ok(refs)
}

/// What `submodule update --remote` follows: `<b>` = the parent's
/// `submodule.<name>.branch`, else `.gitmodules`' (`.` = the parent's branch); `<r>`
/// = [`followed_remote`]. With `<b>`, the listed
/// `refs/remotes/<r>/<b>`; without, the listed target of `refs/remotes/<r>/HEAD`.
/// None when that isn't listed or any read behind it failed.
async fn default_rev(
    repo_path: &str,
    path: &str,
    child: &ChildRepo,
    branch: Option<&str>,
    remote_branches: &[SubmoduleRef],
    symrefs: &[(String, String)],
) -> Option<String> {
    let entries = gitmodules_entries(repo_path).await.ok()?;
    let (name, listed_branch, url) = match entries.get(path) {
        Some(entry) => (
            entry.name.clone(),
            entry.branch.clone(),
            Some(entry.url.as_str()).filter(|url| !url.is_empty()),
        ),
        None => (path.to_string(), None, None),
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
    let remote = followed_remote(repo_path, child, url, branch).await?;
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

/// The remote `submodule update --remote` reads, in git's order
/// (`get_default_remote_submodule`, builtin/submodule--helper.c v2.51.1): the first
/// remote in git's registration order, one of whose URLs (insteadOf applied) is exactly the
/// `.gitmodules` URL, a relative one resolved against the parent's default remote;
/// else `branch.<b>.remote`; else the sole remote; else `origin`. A branch name with
/// no exact spelling would ask about another key, so it skips that step. None when a
/// read failed.
async fn followed_remote(
    repo_path: &str,
    child: &ChildRepo,
    url: Option<&str>,
    branch: Option<&str>,
) -> Option<String> {
    if let Some(url) = url {
        let url = match strip_dot_slash(url, true).or(strip_dot_dot_slash(url, true)) {
            Some(_) => relative_url(&parent_default_remote_url(repo_path).await?, url)?,
            None => url.to_string(),
        };
        // git registers a remote at its first `remote.<name>.<key>` of ANY key, in config
        // order (remote.c `make_remote`, v2.51.1: `remote_state->remotes[remote_state->
        // remotes_nr++] = ret;` on first sight), and `repo_remote_from_url` returns the
        // first registered one where `remote_has_url` holds. The name runs to the LAST
        // dot; a two-part key (`remote.pushDefault`) names none, and `handle_config`
        // skips a name starting with '/'.
        let keys = ["config", "-z", "--name-only", "--get-regexp", r"^remote\."];
        let keys = config_answer(child.read(&keys).await.ok()?).ok()?;
        let keys = keys.map(|out| out.stdout_lossy()).unwrap_or_default();
        let mut names: Vec<&str> = Vec::new();
        for key in keys.split('\0') {
            let name = key
                .strip_prefix("remote.")
                .and_then(|k| k.rsplit_once('.'))
                .map(|(name, _)| name);
            if let Some(name) =
                name.filter(|n| !n.starts_with('/') && !n.contains(LOSSY) && !names.contains(n))
            {
                names.push(name);
            }
        }
        let read = |args: Vec<String>| async move {
            let args: Vec<&str> = args.iter().map(String::as_str).collect();
            child.read(&args).await
        };
        if let Some(name) = remote_with_url(&names, &url, read).await? {
            return Some(name);
        }
    }
    if let Some(branch_name) = branch.filter(|name| !name.contains(LOSSY)) {
        let key = format!("branch.{branch_name}.remote");
        if let Some(remote) = child_config_get(child, &key).await? {
            return Some(remote);
        }
    }
    Some(match child_remotes(child).await.ok()?.as_slice() {
        [sole] => sole.clone(),
        _ => "origin".to_string(),
    })
}

/// The first of `names` (git's registration order) that `repo_remote_from_url` would
/// return for `url`: one whose URL list, insteadOf applied, holds it exactly
/// (`remote_has_url`, remote.c v2.51.1). Some(None) when none does; None when a read
/// failed. `read` runs git in the submodule.
async fn remote_with_url<F, Fut>(names: &[&str], url: &str, read: F) -> Option<Option<String>>
where
    F: Fn(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = AppResult<GitOutput>>,
{
    let argv = |args: &[&str]| -> Vec<String> { args.iter().map(|a| a.to_string()).collect() };
    for &name in names {
        let listed = read(argv(&["remote", "get-url", "--all", name]))
            .await
            .ok()?;
        // `remote get-url` exits 2 exactly for a remote with no key in this repository's
        // own config (`remote_is_configured(remote, 1)`), which git's walk still
        // registers; `ls-remote --get-url` reads it, but prints only its first URL.
        let outside = listed.code == 2;
        let urls: Vec<String> = if outside {
            let first = read(argv(&["ls-remote", "--get-url", name])).await.ok()?;
            vec![single_value(&first.exit_verdict().ok()?.stdout_lossy()).to_string()]
        } else {
            let listed = listed.exit_verdict().ok()?.stdout_lossy();
            listed.lines().map(str::to_string).collect()
        };
        let matched = urls.iter().any(|listed| listed == url);
        if !matched && !outside {
            continue;
        }
        // Both print a URL-less remote's own name, a URL git's walk never compares.
        let key = format!("remote.{name}.url");
        let raw = read(argv(&["config", "-z", "--get-all", &key]))
            .await
            .ok()?;
        let count = config_answer(raw)
            .ok()?
            .map_or(0, |out| out.stdout.iter().filter(|&&b| b == 0).count());
        match (matched, count) {
            (_, 0) | (false, 1) => continue,
            (true, _) => return Some(Some(name.to_string())),
            // A URL past the first one `ls-remote` prints can't be compared.
            (false, _) => return None,
        }
    }
    Some(None)
}

/// The URL `resolve_relative_url` (helper.c v2.51.1) resolves a relative `.gitmodules`
/// URL against: the parent's default remote's `remote.<r>.url`, else git's cwd, which
/// is the toplevel here, in git's spelling.
async fn parent_default_remote_url(repo_path: &str) -> Option<String> {
    let branch = crate::git::branches::current_branch_name(repo_path)
        .await
        .ok()?;
    let configured = match branch {
        Some(branch) => config_get(repo_path, &format!("branch.{branch}.remote")).await?,
        None => None,
    };
    let remote = match configured {
        Some(remote) => remote,
        None => {
            let listed = run_git(Some(repo_path), &["remote"], DEFAULT_TIMEOUT)
                .await
                .ok()?;
            let listed = listed.stdout_lossy();
            let names: Vec<&str> = listed
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect();
            match names.as_slice() {
                [sole] => sole.to_string(),
                _ => "origin".to_string(),
            }
        }
    };
    if let Some(url) = config_get(repo_path, &format!("remote.{remote}.url")).await? {
        return Some(url);
    }
    let top = ["rev-parse", "--show-toplevel"];
    let top = run_git(Some(repo_path), &top, DEFAULT_TIMEOUT).await.ok()?;
    Some(single_value(&top.stdout_lossy()).to_string())
}

/// git's directory separators: `\` too on Windows, and on every platform when
/// `xplatform`.
fn is_dir_sep(c: char, xplatform: bool) -> bool {
    c == '/' || ((xplatform || cfg!(windows)) && c == '\\')
}

fn strip_dot_slash(s: &str, xplatform: bool) -> Option<&str> {
    let rest = s.strip_prefix('.')?;
    rest.starts_with(|c| is_dir_sep(c, xplatform))
        .then(|| &rest[1..])
}

fn strip_dot_dot_slash(s: &str, xplatform: bool) -> Option<&str> {
    let rest = s.strip_prefix("..")?;
    rest.starts_with(|c| is_dir_sep(c, xplatform))
        .then(|| &rest[1..])
}

fn has_dos_drive_prefix(s: &str) -> bool {
    let b = s.as_bytes();
    cfg!(windows) && b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// remote.c `url_is_local_not_ssh` (v2.51.1).
fn url_is_local_not_ssh(url: &str) -> bool {
    match (url.find(':'), url.find('/')) {
        (None, _) => true,
        (Some(colon), Some(slash)) if slash < colon => true,
        _ => has_dos_drive_prefix(url),
    }
}

fn is_absolute_path(path: &str) -> bool {
    path.starts_with(|c| is_dir_sep(c, false)) || has_dos_drive_prefix(path)
}

/// remote.c `relative_url` (v2.51.1) with no `up_path`: `url` resolved against
/// `remote_url`. None where git dies (a component it can't strip).
fn relative_url(remote_url: &str, url: &str) -> Option<String> {
    if !url_is_local_not_ssh(url) || is_absolute_path(url) {
        return Some(url.to_string());
    }
    let mut remote = remote_url.to_string();
    if remote.ends_with(|c| is_dir_sep(c, false)) {
        remote.pop();
    }
    let is_relative = url_is_local_not_ssh(&remote) && !is_absolute_path(&remote);
    if is_relative
        && strip_dot_slash(&remote, false).is_none()
        && strip_dot_dot_slash(&remote, false).is_none()
    {
        remote = format!("./{remote}");
    }
    let mut url = url;
    let mut colonsep = false;
    loop {
        if let Some(rest) = strip_dot_dot_slash(url, false) {
            url = rest;
            // chop_last_dir: the last separator, else the last colon, else `.`.
            if let Some(at) = remote.rfind(|c| is_dir_sep(c, false)) {
                remote.truncate(at);
            } else if let Some(at) = remote.rfind(':') {
                remote.truncate(at);
                colonsep = true;
            } else if is_relative || remote == "." {
                return None;
            } else {
                remote = ".".into();
            }
        } else if let Some(rest) = strip_dot_slash(url, false) {
            url = rest;
        } else {
            break;
        }
    }
    let mut out = format!("{remote}{}{url}", if colonsep { ':' } else { '/' });
    if url.ends_with('/') {
        out.pop();
    }
    Some(match strip_dot_slash(&out, false) {
        Some(rest) => rest.to_string(),
        None => out,
    })
}

/// One `config --get` in the parent: Some(None) when unset; None when the read failed.
async fn config_get(repo: &str, key: &str) -> Option<Option<String>> {
    config_value(run_git_raw(Some(repo), &["config", "--get", key], DEFAULT_TIMEOUT).await)
}

/// [`config_get`] inside the submodule.
async fn child_config_get(child: &ChildRepo, key: &str) -> Option<Option<String>> {
    config_value(child.read(&["config", "--get", key]).await)
}

fn config_value(read: AppResult<GitOutput>) -> Option<Option<String>> {
    let value = config_answer(read.ok()?).ok()?;
    Some(value.map(|out| single_value(&out.stdout_lossy()).to_string()))
}

/// The submodule's remote names, as `remote::git_remotes` lists a repository's.
async fn child_remotes(child: &ChildRepo) -> AppResult<Vec<String>> {
    let out = child.read(&["remote"]).await?.exit_verdict()?;
    Ok(out
        .stdout_lossy()
        .lines()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect())
}

/// The submodule's checked-out branch, as `branches::current_branch_name` reads a
/// repository's: None when HEAD names no local branch.
async fn child_branch(child: &ChildRepo) -> AppResult<Option<String>> {
    let out = child.read(&["symbolic-ref", "-q", "HEAD"]).await?;
    // `-q` exits 1, silently, exactly when HEAD is not a symbolic ref.
    if out.code == 1 {
        return Ok(None);
    }
    let full = out.exit_verdict()?.stdout_lossy();
    Ok(full
        .trim_end_matches(['\r', '\n'])
        .strip_prefix("refs/heads/")
        .filter(|name| !name.is_empty())
        .map(str::to_string))
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

/// What a submodule fetch left: the history's shallowness measured after it, None
/// when that read failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleFetchResult {
    pub shallow: Option<bool>,
}

/// Fetches the submodule at `path` from the remote a plain `git fetch` there would
/// choose (the checked-out branch's `branch.<b>.remote`, else `origin`), named in the
/// argv; the plain fetch the app runs elsewhere. `unshallow` also completes a shallow
/// history.
#[tauri::command]
pub async fn git_submodule_fetch(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    unshallow: bool,
) -> AppResult<SubmoduleFetchResult> {
    git_submodule_fetch_core(&state, &repo_path, &path, unshallow).await
}

/// The parent's hold covers the gate and the network key's resolve, so the key is
/// minted only for a folder that is the submodule's own checkout; it is dropped before
/// the network wait, so the gate runs again after it and must find the same
/// repository, and the parent must still record a gitlink at the path both times: a
/// folder the parent no longer records is not this repository's submodule, whatever
/// repository it holds. Shallowness is measured under the network hold, so a second
/// concurrent unshallow becomes a plain fetch.
pub(crate) async fn git_submodule_fetch_core(
    state: &AppState,
    repo_path: &str,
    path: &str,
    unshallow: bool,
) -> AppResult<SubmoduleFetchResult> {
    let path = fetch_rel_path(path)?;
    let domain = state.working_tree_lock(repo_path).await;
    let guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a submodule fetch").await?;
    refuse_linked_submodule_path(repo_path, &path, fetch_refusal).await?;
    let spec = crate::git::pathspec::literal(&path);
    let unrecorded = || fetch_refusal(&path, "this repository records no submodule there");
    if !gitlink_recorded(repo_path, &path, &spec).await? {
        return Err(unrecorded());
    }
    let worktree = Path::new(repo_path).join(&path);
    let unusable = |(checkout, reason): (SubmoduleCheckout, Option<String>)| {
        fetch_refusal(&path, &unusable_why(checkout, reason.as_deref()))
    };
    let child = ChildRepo::resolve(repo_path, &worktree)
        .await
        .map_err(unusable)?;
    let network = state.network_lock(child.folder()).await;
    drop(guard);
    let _network =
        acquire_repo_lock(&network, NETWORK_LOCK_WAIT_TIMEOUT, holder_label("fetch")).await?;
    #[cfg(test)]
    if let Ok(waited) = FETCH_WAITED_HOOK.try_with(|hook| hook()) {
        waited.await;
    }
    // A deinit or a re-pointed .git during the wait: the fetch would reach another
    // repository than the one whose network key it holds.
    let now = ChildRepo::resolve(repo_path, &worktree)
        .await
        .map_err(unusable)?;
    if !now.same_repo(&child) {
        return Err(fetch_refusal(
            &path,
            "its repository changed while it waited",
        ));
    }
    if !gitlink_recorded(repo_path, &path, &spec).await? {
        return Err(unrecorded());
    }
    // Chosen after the wait: a branch switched during it changes the remote.
    let remote = fetch_remote(&now)
        .await
        .ok_or_else(|| fetch_refusal(&path, "its remote couldn't be read"))?;
    // Discovers from the folder (forge/mod.rs takes no pin); a config read only.
    let cred = crate::forge::credential_config_for_remote(now.folder(), &remote).await?;
    let shallow = submodule_is_shallow(&now).await;
    let mut args = fetch_args(unshallow, shallow).ok_or_else(|| {
        AppError::InvalidArgument(format!(
            "couldn't tell whether {}'s history is shallow; nothing was fetched",
            crate::git::ops::discard_shown(&path)
        ))
    })?;
    args.push(&remote);
    now.fetch(&cred, &args, NETWORK_TIMEOUT)
        .await?
        .exit_verdict()?;
    Ok(SubmoduleFetchResult {
        shallow: submodule_is_shallow(&now).await,
    })
}

/// The remote a plain `git fetch` in the submodule reads: the checked-out branch's
/// `branch.<b>.remote`, else the only remote when there is exactly one, else `origin`
/// (a detached HEAD included; measured, git 2.51.1). Each step counts only when its
/// names are exact (no [`LOSSY`]), else the next one decides. None when a read failed
/// or the name would reach git as an option.
async fn fetch_remote(child: &ChildRepo) -> Option<String> {
    let exact = |name: &String| !name.contains(LOSSY);
    let branch = child_branch(child).await.ok()?;
    let configured = match branch.filter(exact) {
        Some(branch) => child_config_get(child, &format!("branch.{branch}.remote")).await?,
        None => None,
    };
    let remote = match configured.filter(exact) {
        Some(remote) => remote,
        None => match child_remotes(child).await.ok()?.as_slice() {
            [only] if exact(only) => only.clone(),
            _ => "origin".to_string(),
        },
    };
    (!remote.is_empty() && !remote.starts_with('-')).then_some(remote)
}

/// `git_fetch_core`'s argv plus `--no-recurse-submodules`; `--unshallow` only on
/// history measured shallow (git refuses it on a complete repository, measured). None
/// when an unshallow was asked and the measure failed: a plain fetch would leave the
/// history cut while the call succeeds.
fn fetch_args<'a>(unshallow: bool, shallow: Option<bool>) -> Option<Vec<&'a str>> {
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
    use crate::git::runner::{hold_config_lock, lock_events, run_git_raw_env, TEST_GIT_HANG_GUARD};

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
            unreadable_reason: None,
        };
        let json = serde_json::to_value(&sub).unwrap();
        let obj = json.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "branch",
                "describe",
                "name",
                "path",
                "sha",
                "status",
                "unreadableReason",
                "url"
            ]
        );
        assert!(!obj.contains_key("unreadable_reason"));
        assert_eq!(obj["unreadableReason"], serde_json::Value::Null);
        let unreadable = Submodule {
            status: "unreadable".into(),
            unreadable_reason: Some("why".into()),
            ..sub.clone()
        };
        assert_eq!(
            serde_json::to_value(&unreadable).unwrap()["unreadableReason"],
            serde_json::json!("why")
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
            refused_unreadable: Some("why".into()),
            module_data_deleted: false,
            module_data_error: Some("boom".into()),
        };
        let json = serde_json::to_value(&outcome).unwrap();
        let obj = json.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "moduleDataDeleted",
                "moduleDataError",
                "refusedDirty",
                "refusedUnreadable"
            ]
        );
        for snake in [
            "refused_dirty",
            "refused_unreadable",
            "module_data_deleted",
            "module_data_error",
        ] {
            assert!(!obj.contains_key(snake), "{snake}");
        }
        assert_eq!(obj["refusedDirty"], serde_json::json!(true));
        assert_eq!(obj["refusedUnreadable"], serde_json::json!("why"));

        let cleared = SubmoduleRemoveOutcome {
            refused_dirty: false,
            refused_unreadable: None,
            module_data_deleted: true,
            module_data_error: None,
        };
        let cleared = serde_json::to_value(&cleared).unwrap();
        assert_eq!(cleared["moduleDataError"], serde_json::Value::Null);
        assert_eq!(cleared["refusedUnreadable"], serde_json::Value::Null);
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

    /// With the worktree's `.gitmodules` deleted, the rows name what git's own status
    /// read maps them by: the index's copy.
    #[tokio::test]
    async fn list_reads_a_deleted_gitmodules_from_the_index_copy() {
        let (dir, host, _dep) = host_with_submodule("orphan").await;
        std::fs::remove_file(dir.path().join("host").join(".gitmodules")).unwrap();
        let subs = list_submodules(&host).await.unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].name, "libs/dep");
        assert_eq!(subs[0].url, "../dep");
        assert_eq!(subs[0].branch.as_deref(), Some("main"));
    }

    /// A submodule whose repository data moved away: `submodule status` dies on it, so
    /// the list reads each path alone and keeps its readable sibling, and Remove reads
    /// no list: unforced it refuses as unreadable, forced it removes the one path.
    #[tokio::test]
    async fn an_unreadable_submodule_lists_and_removes_beside_a_readable_one() {
        let (_dir, host, _dep) = host_with_submodule("unreadable-row").await;
        let state = AppState::default();
        let ok = Some("libs/ok".to_string());
        git_submodule_add_core(
            &state,
            host.clone(),
            "../dep".into(),
            ok,
            Some("main".into()),
        )
        .await
        .expect("submodule add");
        git(&host, &["commit", "-qm", "add ok"]).await;
        let modules = Path::new(&host).join(".git").join("modules").join("libs");
        std::fs::rename(modules.join("dep"), modules.join("dep-moved")).unwrap();
        let recorded = git(&host, &["rev-parse", ":libs/dep"]).await;

        let subs = list_submodules(&host).await.unwrap();
        let rows: Vec<(&str, &str)> = subs
            .iter()
            .map(|sub| (sub.path.as_str(), sub.status.as_str()))
            .collect();
        assert_eq!(rows, [("libs/dep", "unreadable"), ("libs/ok", "ok")]);
        let (dep, ok) = (&subs[0], &subs[1]);
        assert_eq!(dep.sha, recorded.trim());
        assert_eq!(dep.describe, "");
        assert_eq!(
            (dep.name.as_str(), dep.url.as_str()),
            ("libs/dep", "../dep")
        );
        assert_eq!(dep.branch.as_deref(), Some("main"));
        let reason = status_reason_of(&host, "libs/dep").await;
        assert_eq!(dep.unreadable_reason.as_deref(), Some(reason.as_str()));
        assert_eq!(ok.unreadable_reason, None);
        assert_eq!(ok.describe, "heads/main");

        let refused =
            git_submodule_remove_core(&state, host.clone(), "host.txt".into(), true, false)
                .await
                .expect_err("a regular file is no submodule");
        assert!(refused.to_string().contains("not a submodule"), "{refused}");
        assert!(exists(&host, "host.txt"));

        let staged = |path: &'static str| {
            let host = host.clone();
            async move { git(&host, &["ls-files", "-s", "--", path]).await }
        };
        let outcome =
            git_submodule_remove_core(&state, host.clone(), "libs/dep".into(), false, false)
                .await
                .unwrap();
        assert!(outcome.refused_unreadable.is_some(), "unforced");
        assert!(!outcome.refused_dirty);
        assert!(!staged("libs/dep").await.is_empty(), "nothing removed");

        let outcome =
            git_submodule_remove_core(&state, host.clone(), "libs/dep".into(), true, false)
                .await
                .unwrap();
        assert_eq!(outcome.refused_unreadable, None, "forced");
        assert!(staged("libs/dep").await.is_empty(), "the gitlink is gone");
        let section = [
            "config",
            "-f",
            ".gitmodules",
            "--get",
            "submodule.libs/dep.path",
        ];
        let read = run_git_raw(Some(&host), &section, TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        assert_eq!(read.code, 1, "the .gitmodules section is gone");
        assert!(!staged("libs/ok").await.is_empty(), "the sibling stays");
        assert!(exists(&host, "libs/ok/.git"));
        let subs = list_submodules(&host).await.unwrap();
        let rows: Vec<(&str, &str)> = subs
            .iter()
            .map(|sub| (sub.path.as_str(), sub.status.as_str()))
            .collect();
        assert_eq!(rows, [("libs/ok", "ok")]);
    }

    /// git's own reason for one path's failed `submodule status`, spelled independently of
    /// the production helpers (a shared call would pass whatever they print) in their
    /// order: the first non-empty line, capped, then the `fatal: ` lead dropped.
    async fn status_reason_of(host: &str, path: &str) -> String {
        let spec = crate::git::pathspec::literal(path);
        let args = ["submodule", "status", "--", spec.as_str()];
        let out = run_git_raw(Some(host), &args, TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        assert_ne!(out.code, 0, "{path} must not read");
        let line = out.stderr.lines().map(str::trim).find(|l| !l.is_empty());
        let line = line.unwrap_or_default();
        let line: String = line.chars().take(SUBMODULE_REASON_CAP).collect();
        let reason = match line.strip_prefix("fatal: ") {
            Some(rest) if !rest.trim().is_empty() => rest.to_string(),
            _ => line.clone(),
        };
        assert!(!reason.is_empty() && reason != NOT_UTF8_PATH, "{reason}");
        reason
    }

    /// Two submodules whose gitfiles name one missing git dir: both list as unreadable,
    /// each row with its own path's reason, and each refuses an unforced Remove as
    /// unreadable. Where git prints one line for both (2.47.3 and 2.51.1; 2.56.1 names
    /// each gitfile), the rows also show equal lines never merge into one fault.
    #[tokio::test]
    async fn submodules_sharing_a_missing_git_dir_each_list_as_unreadable() {
        let (dir, host, _dep) = host_with_submodule("unreadable-shared").await;
        let state = AppState::default();
        let other = Some("libs/other".to_string());
        git_submodule_add_core(&state, host.clone(), "../dep".into(), other, None)
            .await
            .expect("submodule add");
        git(&host, &["commit", "-qm", "add other"]).await;
        let missing = dir.path().join("gone").join("modules").join("x");
        let missing = missing.to_string_lossy().replace('\\', "/");
        for path in ["libs/dep", "libs/other"] {
            point_gitfile(&Path::new(&host).join(path).to_string_lossy(), &missing);
        }
        let reasons = [
            status_reason_of(&host, "libs/dep").await,
            status_reason_of(&host, "libs/other").await,
        ];

        let subs = list_submodules(&host).await.unwrap();
        let rows: Vec<(&str, &str, Option<&str>)> = subs
            .iter()
            .map(|sub| {
                let why = sub.unreadable_reason.as_deref();
                (sub.path.as_str(), sub.status.as_str(), why)
            })
            .collect();
        assert_eq!(
            rows,
            [
                ("libs/dep", "unreadable", Some(reasons[0].as_str())),
                ("libs/other", "unreadable", Some(reasons[1].as_str()))
            ]
        );
        for path in ["libs/dep", "libs/other"] {
            let outcome =
                git_submodule_remove_core(&state, host.clone(), path.into(), false, false)
                    .await
                    .unwrap();
            assert!(outcome.refused_unreadable.is_some(), "{path}: {outcome:?}");
        }
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

    /// The submodule at `sub` as the app resolves it, its parent the folder above.
    async fn child_at(sub: &str) -> ChildRepo {
        let folder = Path::new(sub);
        let parent = folder.parent().unwrap().to_string_lossy().into_owned();
        ChildRepo::resolve(&parent, folder).await.unwrap()
    }

    /// [`detach_submodule_at`] in the folder `sub`, resolved as [`child_at`] does, from
    /// the HEAD it reads now (None when unborn).
    async fn detach_in(sub: &str, child: &ChildRepo, sha: &str) -> AppResult<GitOutput> {
        let folder = Path::new(sub);
        let parent = folder.parent().unwrap().to_string_lossy().into_owned();
        let args = ["rev-parse", "--verify", "-q", "HEAD"];
        let head = run_git_raw(Some(sub), &args, TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        let head = (head.code == 0).then(|| head.stdout_lossy().trim().to_string());
        detach_submodule_at(&parent, folder, child, sha, head.as_deref()).await
    }

    /// `--path-format=absolute` `flag` read in `repo`.
    async fn abs_git_path(repo: &str, flag: &str) -> String {
        single_value(&git(repo, &["rev-parse", "--path-format=absolute", flag]).await).to_string()
    }

    /// Points the folder's `.git` file at `gitdir`.
    fn point_gitfile(folder: &str, gitdir: &str) {
        std::fs::write(
            Path::new(folder).join(".git"),
            format!("gitdir: {gitdir}\n"),
        )
        .unwrap();
    }

    async fn resolve_refusal(host: &str, folder: &str) -> (SubmoduleCheckout, Option<String>) {
        ChildRepo::resolve(host, Path::new(folder))
            .await
            .expect_err("the folder must not resolve")
    }

    #[tokio::test]
    async fn child_repo_refuses_a_gitfile_naming_the_parent() {
        let f = gitlink_fixture("child-repo-parent").await;
        point_gitfile(&f.sub, &abs_git_path(&f.host, "--git-dir").await);
        assert_eq!(
            resolve_refusal(&f.host, &f.sub).await,
            (
                SubmoduleCheckout::Unreadable,
                Some("its .git names this repository's own git directory".into())
            )
        );
        let refs = git_submodule_refs_core(&f.host, "libs/dep").await.unwrap();
        assert_eq!(refs.checkout, SubmoduleCheckout::Unreadable);
        let read = pick_read(&f.host, &f.c1).await;
        assert!(
            matches!(
                &read.plan,
                SubmodulePickPlan::Blocked {
                    why: SubmodulePickBlock::Unusable,
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
                    why: SubmodulePickBlock::Unusable,
                    ..
                }
            ),
            "{outcome:?}"
        );
        assert_eq!(
            git(&f.host, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/main"
        );
        let fetch = git_submodule_fetch_core(&AppState::default(), &f.host, "libs/dep", false)
            .await
            .unwrap_err();
        assert!(fetch.to_string().contains("own git directory"), "{fetch}");
    }

    #[tokio::test]
    async fn child_repo_refuses_the_parents_linked_worktree_admin_dir() {
        let f = gitlink_fixture("child-repo-admin").await;
        let wt = Path::new(&f.host).parent().unwrap().join("wt");
        git(
            &f.host,
            &["worktree", "add", "-q", "--detach", &wt.to_string_lossy()],
        )
        .await;
        let admin = abs_git_path(&wt.to_string_lossy(), "--git-dir").await;
        assert!(admin.contains("/worktrees/"), "fixture: {admin}");
        point_gitfile(&f.sub, &admin);
        assert_eq!(
            resolve_refusal(&f.host, &f.sub).await,
            (
                SubmoduleCheckout::Unreadable,
                Some("its .git names this repository's own git directory".into())
            )
        );
    }

    #[tokio::test]
    async fn child_repo_refuses_a_gitfile_naming_a_sibling_module() {
        let f = gitlink_fixture("child-repo-sibling").await;
        git_submodule_add_core(
            &AppState::default(),
            f.host.clone(),
            "../dep".into(),
            Some("libs/b".into()),
            None,
        )
        .await
        .unwrap();
        let b = Path::new(&f.host)
            .join("libs/b")
            .to_string_lossy()
            .into_owned();
        point_gitfile(&f.sub, &abs_git_path(&b, "--git-dir").await);
        let (checkout, reason) = resolve_refusal(&f.host, &f.sub).await;
        assert_eq!(checkout, SubmoduleCheckout::Unreadable);
        let reason = reason.unwrap();
        assert!(
            reason.starts_with("its .git names a repository checked out at ")
                && reason.ends_with("libs/b"),
            "{reason}"
        );
    }

    #[tokio::test]
    async fn child_repo_accepts_an_own_git_directory_and_a_linked_worktree_parent() {
        let (dir, host, dep) = host_with_submodule("child-repo-accepts").await;
        git(&host, &["clone", "-q", &dep, "libs/own"]).await;
        git(&host, &["submodule", "add", "-q", &dep, "libs/own"]).await;
        let own = Path::new(&host).join("libs/own");
        assert!(
            own.join(".git").is_dir(),
            "fixture: an un-absorbed submodule"
        );
        let child = ChildRepo::resolve(&host, &own).await.unwrap();
        assert!(
            child.git_dir().ends_with("libs/own/.git"),
            "{}",
            child.git_dir()
        );
        // Absorbed by git: the git dir moves under the parent's and names the folder back.
        git(&host, &["submodule", "absorbgitdirs", "--", "libs/own"]).await;
        let child = ChildRepo::resolve(&host, &own).await.unwrap();
        assert!(child.git_dir().contains("/modules/"), "{}", child.git_dir());

        let wt = dir.path().join("wt").to_string_lossy().into_owned();
        git(&host, &["worktree", "add", "-q", "--detach", &wt]).await;
        git(
            &wt,
            &["submodule", "update", "--init", "-q", "--", "libs/dep"],
        )
        .await;
        let child = ChildRepo::resolve(&wt, &Path::new(&wt).join("libs/dep"))
            .await
            .unwrap();
        assert!(
            child.git_dir().contains("/worktrees/"),
            "{}",
            child.git_dir()
        );
        let out = child.read(&["rev-parse", "--show-toplevel"]).await.unwrap();
        assert_eq!(out.code, 0, "{}", out.stderr);
    }

    const V3_REFUSAL: &str =
        "its .git names a repository that doesn't name this folder as its work tree (core.worktree)";

    #[tokio::test]
    async fn child_repo_refuses_a_gitfile_naming_an_ordinary_clone() {
        let f = gitlink_fixture("child-repo-clone").await;
        let sib = Path::new(&f.host)
            .parent()
            .unwrap()
            .join("sib")
            .to_string_lossy()
            .into_owned();
        git(&f.host, &["clone", "-q", &f.dep, &sib]).await;
        point_gitfile(&f.sub, &abs_git_path(&sib, "--git-dir").await);
        assert_eq!(
            resolve_refusal(&f.host, &f.sub).await,
            (SubmoduleCheckout::Unreadable, Some(V3_REFUSAL.into()))
        );
        let read = pick_read(&f.host, &f.c1).await;
        assert!(
            matches!(
                &read.plan,
                SubmodulePickPlan::Blocked {
                    why: SubmodulePickBlock::Unusable,
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
                    why: SubmodulePickBlock::Unusable,
                    ..
                }
            ),
            "{outcome:?}"
        );
        let fetch = git_submodule_fetch_core(&AppState::default(), &f.host, "libs/dep", false)
            .await
            .unwrap_err();
        assert!(fetch.to_string().contains("core.worktree"), "{fetch}");
        assert_eq!(
            git(&sib, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/main"
        );
        assert_eq!(git(&sib, &["status", "--porcelain"]).await, "");
    }

    #[tokio::test]
    async fn child_repo_refuses_a_sibling_module_that_lost_its_work_tree() {
        let f = gitlink_fixture("child-repo-unset").await;
        git_submodule_add_core(
            &AppState::default(),
            f.host.clone(),
            "../dep".into(),
            Some("libs/b".into()),
            None,
        )
        .await
        .unwrap();
        let b = Path::new(&f.host)
            .join("libs/b")
            .to_string_lossy()
            .into_owned();
        let b_git = abs_git_path(&b, "--git-dir").await;
        let config = format!("{b_git}/config");
        git(
            &f.host,
            &["config", "-f", &config, "--unset", "core.worktree"],
        )
        .await;
        point_gitfile(&f.sub, &b_git);
        assert_eq!(
            resolve_refusal(&f.host, &f.sub).await,
            (SubmoduleCheckout::Unreadable, Some(V3_REFUSAL.into()))
        );
    }

    /// `link` made a directory link to `target`: a junction on Windows, a symlink elsewhere.
    fn link_dir(link: &Path, target: &Path) {
        #[cfg(windows)]
        crate::test_junction::make_junction(link, target);
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[tokio::test]
    async fn child_repo_refuses_a_git_directory_reached_through_a_link() {
        let f = gitlink_fixture("child-repo-link").await;
        let sib = Path::new(&f.host).parent().unwrap().join("sib");
        git(&f.host, &["clone", "-q", &f.dep, &sib.to_string_lossy()]).await;
        let dot_git = Path::new(&f.sub).join(".git");
        std::fs::remove_file(&dot_git).unwrap();
        link_dir(&dot_git, &sib.join(".git"));
        assert_eq!(
            resolve_refusal(&f.host, &f.sub).await,
            (SubmoduleCheckout::Unreadable, Some(V3_REFUSAL.into()))
        );
    }

    #[tokio::test]
    async fn child_repo_wants_a_back_link_from_a_separate_git_dir() {
        let (dir, host, dep) = host_with_submodule("child-repo-sep").await;
        let sep = dir.path().join("sepgit").to_string_lossy().into_owned();
        let folder = Path::new(&host).join("libs/sep");
        let shown = folder.to_string_lossy().into_owned();
        git(
            &host,
            &["clone", "-q", "--separate-git-dir", &sep, &dep, &shown],
        )
        .await;
        assert_eq!(
            resolve_refusal(&host, &shown).await,
            (SubmoduleCheckout::Unreadable, Some(V3_REFUSAL.into()))
        );
        let config = format!("{sep}/config");
        git(&host, &["config", "-f", &config, "core.worktree", &shown]).await;
        ChildRepo::resolve(&host, &folder).await.unwrap();
    }

    #[tokio::test]
    async fn pinned_call_refuses_a_gitfile_where_its_git_directory_was() {
        let f = gitlink_fixture("pin-slash").await;
        // A tracking ref the parent's remote lacks: a parent `fetch --prune` deletes it.
        git(&f.host, &["remote", "add", "origin", &f.dep]).await;
        let head = head_of(&f.host).await;
        git(&f.host, &["update-ref", "refs/remotes/origin/ghost", &head]).await;
        git(&f.host, &["clone", "-q", &f.dep, "libs/own"]).await;
        let own = Path::new(&f.host)
            .join("libs/own")
            .to_string_lossy()
            .into_owned();
        let host_git = abs_git_path(&f.host, "--git-dir").await;
        // The absorbed layout, then the own `.git` directory.
        for folder in [f.sub.clone(), own] {
            let child = child_at(&folder).await;
            let pinned = child.git_dir().to_string();
            std::fs::rename(&pinned, format!("{pinned}.moved")).unwrap();
            std::fs::write(&pinned, format!("gitdir: {host_git}\n")).unwrap();
            let read = child.read(&["rev-parse", "--git-dir"]).await.unwrap();
            assert_eq!(read.code, 128, "{folder}: {}", read.stdout_lossy());
            assert!(read.stdout.is_empty(), "{folder}: {}", read.stderr);
            let mut args = fetch_args(false, Some(false)).unwrap();
            args.push("origin");
            let out = child.fetch(&[], &args, NETWORK_TIMEOUT).await.unwrap();
            assert_eq!(out.code, 128, "{folder}: {}", out.stderr);
            git(
                &f.host,
                &["rev-parse", "--verify", "-q", "refs/remotes/origin/ghost"],
            )
            .await;
            assert_eq!(
                git(&f.host, &["symbolic-ref", "HEAD"]).await.trim(),
                "refs/heads/main"
            );
        }
    }

    #[tokio::test]
    async fn fetch_refuses_a_folder_the_parent_no_longer_records() {
        // The gitlink removed before the call, then during the network wait.
        for during in [false, true] {
            let f = gitlink_fixture(if during {
                "fetch-unrecorded-wait"
            } else {
                "fetch-unrecorded"
            })
            .await;
            // A tracking ref the submodule's remote lacks: a `fetch --prune` deletes it.
            let head = head_of(&f.sub).await;
            git(&f.sub, &["update-ref", "refs/remotes/origin/ghost", &head]).await;
            let host = f.host.clone();
            let unrecord: PickLandedHook = Arc::new(move || {
                let host = host.clone();
                Box::pin(async move {
                    git(&host, &["rm", "-q", "--cached", "libs/dep"]).await;
                })
            });
            let state = AppState::default();
            let fetch = git_submodule_fetch_core(&state, &f.host, "libs/dep", false);
            let e = if during {
                FETCH_WAITED_HOOK.scope(unrecord, fetch).await
            } else {
                unrecord().await;
                fetch.await
            }
            .unwrap_err();
            assert!(
                e.to_string().contains("records no submodule there"),
                "{during}: {e}"
            );
            git(
                &f.sub,
                &["rev-parse", "--verify", "-q", "refs/remotes/origin/ghost"],
            )
            .await;
        }
    }

    #[tokio::test]
    async fn pinned_checkout_ignores_a_gitfile_swapped_after_the_resolve() {
        let f = gitlink_fixture("pin-checkout-swap").await;
        let child = child_at(&f.sub).await;
        point_gitfile(&f.sub, &abs_git_path(&f.host, "--git-dir").await);
        // The raw run: the folder's read-back would refuse the swapped gitfile.
        let folder = Path::new(&f.sub);
        let parent = folder.parent().unwrap().to_string_lossy().into_owned();
        let out = detach_run(&parent, folder, &child, &f.c1, Some(&f.c2))
            .await
            .unwrap();
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert_eq!(
            git(child.git_dir(), &["rev-parse", "HEAD"]).await.trim(),
            f.c1
        );
        assert_eq!(
            git(&f.host, &["symbolic-ref", "HEAD"]).await.trim(),
            "refs/heads/main"
        );
    }

    #[tokio::test]
    async fn pinned_fetch_stays_in_the_submodule_after_a_deinit() {
        let f = gitlink_fixture("pin-fetch-deinit").await;
        // A tracking ref the parent's remote lacks: a parent `fetch --prune` deletes it.
        git(&f.host, &["remote", "add", "origin", &f.dep]).await;
        let head = head_of(&f.host).await;
        git(&f.host, &["update-ref", "refs/remotes/origin/ghost", &head]).await;
        let child = child_at(&f.sub).await;
        git(&f.host, &["submodule", "deinit", "-q", "-f", "libs/dep"]).await;
        let mut args = fetch_args(false, Some(false)).unwrap();
        args.push("origin");
        let out = child.fetch(&[], &args, NETWORK_TIMEOUT).await.unwrap();
        assert_eq!(out.code, 0, "{}", out.stderr);
        git(
            &f.host,
            &["rev-parse", "--verify", "-q", "refs/remotes/origin/ghost"],
        )
        .await;
    }

    #[tokio::test]
    async fn both_fetch_spawns_carry_the_pin() {
        let f = gitlink_fixture("pin-fetch-retry").await;
        let child = child_at(&f.sub).await;
        // git echoes the missing path, which `is_auth_class_failure` reads as an auth
        // failure, so the injected spawn is followed by the ambient retry.
        let url = Path::new(&f.host)
            .parent()
            .unwrap()
            .join("repository not found")
            .to_string_lossy()
            .into_owned();
        let spawns = Arc::new(std::sync::Mutex::new(Vec::<Vec<String>>::new()));
        let sink = spawns.clone();
        let hook = Arc::new(move |args: &[&str]| {
            sink.lock()
                .unwrap()
                .push(args.iter().map(|arg| arg.to_string()).collect());
        });
        let cred = ["credential.helper=".to_string()];
        let args = ["fetch", "--no-recurse-submodules", &url];
        let fetch = child.fetch(&cred, &args, NETWORK_TIMEOUT);
        let out = crate::git::runner::GIT_SPAWN_LOG
            .scope(hook, fetch)
            .await
            .unwrap();
        assert_ne!(out.code, 0, "the fixture remote is missing");
        let fetches: Vec<Vec<String>> = spawns
            .lock()
            .unwrap()
            .iter()
            .filter(|argv| argv.iter().any(|arg| arg == "fetch"))
            .cloned()
            .collect();
        assert_eq!(
            fetches.len(),
            2,
            "the injected spawn and the ambient retry: {fetches:?}"
        );
        for argv in &fetches {
            let at = argv.iter().position(|arg| arg == "fetch").unwrap();
            assert_eq!(
                argv[at - 2],
                format!("--git-dir={}/", child.git_dir()),
                "{argv:?}"
            );
            assert_eq!(
                argv[at - 1],
                format!("--work-tree={}", child.folder()),
                "{argv:?}"
            );
        }
    }

    #[tokio::test]
    async fn update_remote_settles_nested_modules_in_the_child_only() {
        let (_dir, host, _dep) = host_with_submodule("update-gate").await;
        let state = AppState::default();
        git_submodule_add_core(
            &state,
            host.clone(),
            "../dep".into(),
            Some("libs/b".into()),
            None,
        )
        .await
        .unwrap();
        git(&host, &["commit", "-qm", "add b"]).await;
        let b = Path::new(&host)
            .join("libs/b")
            .to_string_lossy()
            .into_owned();
        let parked = commit_in(&b, "p.txt", "parked").await;
        let outside = host.clone();
        let deinit: PickLandedHook = Arc::new(move || {
            let host = outside.clone();
            Box::pin(async move {
                git(&host, &["submodule", "deinit", "-q", "-f", "libs/dep"]).await;
            })
        });
        let update = git_submodule_update_core(&state, host.clone(), Some("libs/dep".into()), true);
        let e = UPDATE_SETTLE_HOOK.scope(deinit, update).await.unwrap_err();
        assert!(
            e.to_string().contains("not the submodules inside it"),
            "{e}"
        );
        assert_eq!(
            head_of(&b).await,
            parked,
            "the sibling stays where it was parked"
        );
        assert!(
            !exists(&host, "libs/dep/dep.txt"),
            "the emptied folder stays empty"
        );
    }

    /// A hook that commits in `repo`, on its checked-out branch.
    fn commit_hook(repo: &str) -> PickLandedHook {
        let repo = repo.to_string();
        Arc::new(move || {
            let repo = repo.clone();
            Box::pin(async move {
                commit_in(&repo, "late.txt", "late").await;
            })
        })
    }

    #[tokio::test]
    async fn pick_rechecks_the_checkout_just_before_moving_it() {
        let f = gitlink_fixture("pick-precheck").await;
        let outcome = PRE_CHECKOUT_HOOK
            .scope(commit_hook(&f.sub), pick(&f.host, &f.c1, &f.c0))
            .await
            .unwrap();
        assert!(
            matches!(outcome, SubmodulePickOutcome::Changed),
            "{outcome:?}"
        );
        assert_eq!(
            git(&f.sub, &["log", "-1", "--format=%s"]).await.trim(),
            "late"
        );
        let spec = crate::git::pathspec::literal("libs/dep");
        assert_eq!(
            index_gitlink(&f.host, "libs/dep", &spec).await.unwrap(),
            Some(f.c0.clone())
        );
    }

    #[tokio::test]
    async fn accept_leaves_the_checkout_when_head_moved_just_before_it() {
        let f = gitlink_fixture("accept-precheck").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c2), Some(&f.c1)).await;
        let read = read_conflict(&f.host).await;
        assert_eq!(
            side(&read.theirs).plan,
            Some(SubmoduleCheckoutPlan::CheckOut)
        );
        let expected = stages_of(Some(&f.c0), Some(&f.c2), Some(&f.c1));
        let outcome = PRE_CHECKOUT_HOOK
            .scope(
                commit_hook(&f.sub),
                accept(&f.host, "theirs", &expected, true),
            )
            .await
            .unwrap();
        assert_eq!(
            outcome,
            SubmoduleAcceptOutcome::Staged {
                sha: f.c1.clone(),
                checkout: SubmoduleAcceptCheckout::Left {
                    why: SubmoduleCheckoutLeft::Failed,
                    reason: Some("its HEAD moved after it was read".into()),
                },
            }
        );
        assert_pointer_staged(&f.host, &f.c1).await;
        assert_eq!(
            git(&f.sub, &["log", "-1", "--format=%s"]).await.trim(),
            "late"
        );
    }

    #[tokio::test]
    async fn accept_confirms_its_checkout_through_the_folder() {
        let f = gitlink_fixture("accept-confirm").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c2), Some(&f.c1)).await;
        let expected = stages_of(Some(&f.c0), Some(&f.c2), Some(&f.c1));
        // The checkout lands, then its hook re-points the folder at the parent.
        let module = abs_git_path(&f.sub, "--git-dir").await;
        let host_git = abs_git_path(&f.host, "--git-dir").await;
        write_hook(
            &Path::new(&module).join("hooks"),
            "post-checkout",
            &format!("echo 'gitdir: {host_git}' > .git\n"),
        );
        // The stage and the checkout both ran, so "its checkout stays as is" is false.
        let err = accept(&f.host, "theirs", &expected, true)
            .await
            .unwrap_err();
        let AppError::InvalidArgument(message) = &err else {
            panic!("{err:?}")
        };
        let lead = format!(
            "Staged {} for {} and checked it out, but its HEAD couldn't be read: ",
            short_oid(&f.c1),
            crate::git::ops::discard_shown("libs/dep")
        );
        assert!(message.starts_with(&lead), "{message}");
        assert!(message.contains("own git directory"), "{message}");
        assert_eq!(git(&module, &["rev-parse", "HEAD"]).await.trim(), f.c1);
        assert_pointer_staged(&f.host, &f.c1).await;
    }

    #[tokio::test]
    async fn submodule_paths_with_parentheses_list_and_update_exactly() {
        let (_dir, host, dep) = host_with_submodule("list-paren").await;
        git(&host, &["submodule", "add", "-q", &dep, "vendor (old)"]).await;
        git(&host, &["commit", "-qm", "vendor (old)"]).await;
        let listed = list_submodules(&host).await.unwrap();
        let row = listed
            .iter()
            .find(|sub| sub.path == "vendor (old)")
            .unwrap_or_else(|| panic!("{listed:?}"));
        assert_eq!(
            (row.status.as_str(), row.name.as_str()),
            ("ok", "vendor (old)")
        );
        // Uninitialized, so `submodule status` prints no describe after the path, and an
        // unrelated clone with a submodule of its own at the path the old parse cut out.
        let key = "submodule.vendor (old).update";
        git(&host, &["config", "-f", ".gitmodules", key, "none"]).await;
        git(
            &host,
            &["submodule", "deinit", "-q", "-f", "--", "vendor (old)"],
        )
        .await;
        git(&host, &["clone", "-q", &host, "vendor"]).await;
        git_submodule_update_core(&AppState::default(), host.clone(), None, true)
            .await
            .unwrap();
        assert!(
            !exists(&host, "vendor/libs/dep/dep.txt"),
            "the unrelated clone stays as it was"
        );
        let listed = list_submodules(&host).await.unwrap();
        let row = listed
            .iter()
            .find(|sub| sub.path == "vendor (old)")
            .unwrap_or_else(|| panic!("{listed:?}"));
        assert_eq!(
            (
                row.status.as_str(),
                row.name.as_str(),
                row.describe.as_str()
            ),
            ("uninitialized", "vendor (old)", "")
        );
        assert!(!listed.iter().any(|sub| sub.path == "vendor"), "{listed:?}");
    }

    /// git can't key a name holding a newline ("invalid key (newline)"), so the module
    /// takes a name of its own; the path still reaches the resolver and the stage patch.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_submodule_at_a_path_holding_a_newline_lists_plans_and_sets() {
        let (_dir, host, dep) = host_with_submodule("lf-path").await;
        let path = "a\nb";
        git(
            &host,
            &["submodule", "add", "-q", "--name", "ab", &dep, path],
        )
        .await;
        git(&host, &["commit", "-qm", "a newline"]).await;
        let listed = list_submodules(&host).await.unwrap();
        let row = listed
            .iter()
            .find(|sub| sub.path == path)
            .unwrap_or_else(|| panic!("{listed:?}"));
        assert_eq!((row.status.as_str(), row.name.as_str()), ("ok", "ab"));
        let sub = Path::new(&host).join(path).to_string_lossy().into_owned();
        let pointer = head_of(&sub).await;
        let target = commit_in(&sub, "one.txt", "one").await;
        commit_in(&sub, "two.txt", "two").await;
        let read = git_submodule_pick_plan_core(&host, path, &target)
            .await
            .unwrap();
        assert_eq!(
            (read.pointer.as_deref(), read.plan),
            (Some(pointer.as_str()), ready(SubmodulePickMove::CheckOut))
        );
        let state = AppState::default();
        let set = git_submodule_set_commit_core(&state, &host, path, &target, &pointer).await;
        assert_eq!(set.unwrap(), set_at(&target, SubmodulePickMove::CheckOut));
        let spec = crate::git::pathspec::literal(path);
        let staged = index_gitlink(&host, path, &spec).await.unwrap();
        assert_eq!(staged.as_deref(), Some(target.as_str()));
        assert_eq!(head_of(&sub).await, target);
    }

    /// Nested submodules at paths holding a newline count once each after a pick:
    /// `x\n+y`, in step, is no `+` row, and `m\nn` and `p\nq`, left uninitialized at
    /// gitlinks the pick moved, count as theirs.
    #[cfg(unix)]
    #[tokio::test]
    async fn nested_paths_holding_a_newline_count_exactly_after_a_pick() {
        let (dir, host, _dep) = host_with_submodule("nested-lf").await;
        let sub = sub_dir(&host);
        let pointer = head_of(&sub).await;
        let leaf = seed_repo(dir.path(), "leaf").await;
        let older = head_of(&leaf).await;
        commit_in(&leaf, "leaf.txt", "newer").await;
        for (name, path) in [("xy", "x\n+y"), ("mn", "m\nn"), ("pq", "p\nq")] {
            let args = ["submodule", "add", "-q", "--name", name, &leaf, path];
            git(&sub, &args).await;
        }
        let from = commit_in(&sub, "nested.txt", "nested").await;
        for path in ["m\nn", "p\nq"] {
            let folder = Path::new(&sub).join(path).to_string_lossy().into_owned();
            git(&folder, &["checkout", "-q", &older]).await;
            git(&sub, &["add", "--", path]).await;
        }
        let target = commit_in(&sub, "older.txt", "older nested").await;
        let deinit = ["submodule", "deinit", "-q", "-f", "--", "m\nn", "p\nq"];
        git(&sub, &deinit).await;
        git(&sub, &["checkout", "-q", "--detach", &from]).await;
        let picked = pick(&host, &target, &pointer).await.unwrap();
        let want = SubmodulePickOutcome::Set {
            sha: target,
            checkout: SubmodulePickMove::CheckOut,
            nested_left: Some(2),
        };
        assert_eq!(picked, want);
    }

    /// A folder name ending in CR survives the resolver: each answer loses exactly its
    /// one newline.
    #[cfg(unix)]
    #[tokio::test]
    async fn child_repo_resolves_a_folder_whose_name_ends_in_a_carriage_return() {
        let (_dir, host, dep) = host_with_submodule("cr-path").await;
        let path = "c\r";
        git(
            &host,
            &["submodule", "add", "-q", "--name", "c", &dep, path],
        )
        .await;
        let folder = Path::new(&host).join(path);
        let child = ChildRepo::resolve(&host, &folder)
            .await
            .unwrap_or_else(|refused| panic!("{refused:?}"));
        assert_eq!(child.folder(), folder.to_str().unwrap());
    }

    #[test]
    fn single_value_drops_exactly_one_newline() {
        assert_eq!(single_value("/x/c\r\n"), "/x/c\r");
        assert_eq!(single_value("/x/a\nb\n\n"), "/x/a\nb\n");
        assert_eq!(single_value("/x"), "/x");
    }

    /// The callee whose argument list holds the end of `before`, its `::` path
    /// included; None outside any call.
    fn enclosing_callee(before: &str) -> Option<&str> {
        let mut depth = 0usize;
        for (at, b) in before.bytes().enumerate().rev() {
            match b {
                b')' | b']' | b'}' => depth += 1,
                b'(' if depth == 0 => {
                    let start = before[..at]
                        .bytes()
                        .rposition(|b| !(b.is_ascii_alphanumeric() || b == b'_' || b == b':'))
                        .map_or(0, |i| i + 1);
                    return Some(&before[start..at]);
                }
                b'[' | b'{' | b';' if depth == 0 => return None,
                b'(' | b'[' | b'{' => depth -= 1,
                _ => {}
            }
        }
        None
    }

    /// A call's top-level arguments from its `(` at `open`, whitespace dropped and string
    /// literals kept whole.
    fn top_level_args(text: &str, open: usize) -> Vec<String> {
        let bytes = text.as_bytes();
        let (mut args, mut arg, mut depth, mut i) = (Vec::new(), String::new(), 0, open + 1);
        while i < bytes.len() {
            let b = bytes[i];
            match b {
                b'"' => {
                    let mut close = i + 1;
                    while bytes[close] != b'"' {
                        close += if bytes[close] == b'\\' { 2 } else { 1 };
                    }
                    arg.push_str(&text[i..=close]);
                    i = close;
                }
                b'(' | b'[' | b'{' => {
                    depth += 1;
                    arg.push(b as char);
                }
                b')' | b']' | b'}' if depth == 0 => break,
                b')' | b']' | b'}' => {
                    depth -= 1;
                    arg.push(b as char);
                }
                b',' if depth == 0 => args.push(std::mem::take(&mut arg)),
                _ if b.is_ascii_whitespace() => {}
                _ => arg.push(b as char),
            }
            i += 1;
        }
        args.push(arg);
        args
    }

    /// Runner calls inside `mod child_repo` whose argv isn't `&self.argv(..)`, bar
    /// `resolve`'s discovering reads (the only source of a pin, named in full), and how
    /// many runner calls the scan read.
    fn unpinned_child_calls(source: &str) -> (usize, Vec<String>) {
        const DISCOVERING: [&str; 3] = [
            "run_git_raw_env(Some(&folder),&args,&env,DEFAULT_TIMEOUT",
            "run_git_raw(Some(repo_path),&parent_args,DEFAULT_TIMEOUT",
            "run_git_raw(Some(repo_path),&args,DEFAULT_TIMEOUT",
        ];
        let source = source.replace("\r\n", "\n");
        let start = source
            .find("\nmod child_repo {")
            .expect("child_repo module");
        let end = start + source[start..].find("\n}\n").expect("child_repo's end");
        let module = &source[start..end];
        let ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
        let (mut calls, mut stray) = (0, Vec::new());
        for (open, _) in module.match_indices('(') {
            let name_at = module[..open]
                .bytes()
                .rposition(|b| !ident(b))
                .map_or(0, |i| i + 1);
            let name = &module[name_at..open];
            if !name.starts_with("run_git") || module[..name_at].ends_with("fn ") {
                continue;
            }
            calls += 1;
            let args = top_level_args(module, open);
            if args.iter().any(|arg| arg.starts_with("&self.argv(")) {
                continue;
            }
            let within = module[..name_at].rfind("fn ").map_or("", |at| {
                let rest = &module[at + 3..];
                &rest[..rest.bytes().position(|b| !ident(b)).unwrap_or(rest.len())]
            });
            let call = format!("{name}({}", args.join(","));
            if !(within == "resolve" && DISCOVERING.contains(&call.as_str())) {
                stray.push(format!("{within}: {call}"));
            }
        }
        (calls, stray)
    }

    #[test]
    fn child_repo_runs_git_only_behind_its_pin() {
        let source = include_str!("submodule.rs");
        let (calls, stray) = unpinned_child_calls(source);
        assert!(
            calls >= 6,
            "the scan reads the module's runner calls: {calls}"
        );
        assert_eq!(stray, Vec::<String>::new());
        let anchor = "    /// V3's refusal clause.";
        for splice in [
            "    fn spliced(&self) { run_git_raw(Some(&self.folder), &[\"status\"], DEFAULT_TIMEOUT); }",
            "    fn spliced(repo_path: &str, args: [&str; 1]) { run_git_raw(Some(repo_path), &args, DEFAULT_TIMEOUT); }",
        ] {
            let spliced = source.replacen(anchor, &format!("{splice}\n{anchor}"), 1);
            assert_ne!(
                unpinned_child_calls(&spliced).1,
                Vec::<String>::new(),
                "{splice}"
            );
        }
    }

    /// Runner calls (and the named cross-module git reads) outside `mod child_repo` whose
    /// cwd isn't the parent's path, and how many calls the scan read. The strays also
    /// hold the ways a child path could reach a runner under a parent spelling: a
    /// `.folder()` outside a named sink's arguments, a path-to-string conversion on an
    /// unnamed receiver, a `repo` / `repo_path` binding, and a redirect literal: `-C`,
    /// one starting `--git-dir` (bar a `rev-parse` query) or `--work-tree`, `GIT_DIR`,
    /// `GIT_WORK_TREE`, `GIT_COMMON_DIR`. Still open: a path built with `format!`.
    fn child_side_spawns(source: &str) -> (usize, Vec<String>) {
        const PARENT: [&str; 6] = [
            "repo_path",
            "&repo_path",
            "Some(repo_path)",
            "Some(&repo_path)",
            "repo",
            "Some(repo)",
        ];
        const NAMED: [&str; 8] = [
            "has_unmerged",
            "op_state_strict",
            "op_state",
            "git_remotes",
            "current_branch_name",
            "current_branch_ref",
            "read_unless_unborn",
            "config_get",
        ];
        let source = source.replace("\r\n", "\n");
        let prod = &source[..source.find("\nmod tests {").expect("tests module")];
        let start = prod.find("\nmod child_repo {").expect("child_repo module");
        let end = start + prod[start..].find("\n}\n").expect("child_repo's end");
        let outside = format!("{}{}", &prod[..start], &prod[end..]);
        let bytes = outside.as_bytes();
        let ident = |b: u8| b.is_ascii_alphanumeric() || b == b'_';
        let (mut calls, mut stray) = (0, Vec::new());
        for (open, _) in outside.match_indices('(') {
            let name_at = outside[..open]
                .bytes()
                .rposition(|b| !ident(b))
                .map_or(0, |i| i + 1);
            let name = &outside[name_at..open];
            if !(name.starts_with("run_git") || NAMED.contains(&name))
                || outside[..name_at].ends_with("fn ")
            {
                continue;
            }
            let args = top_level_args(&outside, open);
            calls += 1;
            let cwd = if name == "run_git_config_write_held" {
                &args[1]
            } else {
                &args[0]
            };
            if !PARENT.contains(&cwd.as_str()) {
                stray.push(format!("{name}({cwd}"));
            }
        }
        const FOLDER_SINKS: [&str; 4] = [
            "working_tree_lock",
            "network_lock",
            "crate::forge::credential_config_for_remote",
            "PathBuf::from",
        ];
        const STRING_RECEIVERS: [&str; 2] = ["scratch", "file_name()"];
        for (at, _) in outside.match_indices(".folder()") {
            let callee = enclosing_callee(&outside[..at]);
            if !callee.is_some_and(|callee| FOLDER_SINKS.contains(&callee)) {
                stray.push(format!(".folder() in {}", callee.unwrap_or("no call")));
            }
        }
        // The git dir is a path to read, never a cwd or an argument: only a direct
        // argument of these, `Path::new` wrapping it included.
        const GIT_DIR_SINKS: [&str; 1] = ["crate::git::ops::op_state_at"];
        let ends_arg = |rest: &str| rest.trim_start().starts_with([')', ',']);
        for (at, needle) in outside.match_indices(".git_dir()") {
            let (mut before, mut end) = (&outside[..at], at + needle.len());
            let mut callee = enclosing_callee(before);
            if callee == Some("Path::new") && ends_arg(&outside[end..]) {
                before = &before[..before.rfind("Path::new(").unwrap_or(0)];
                end += outside[end..].find(')').map_or(0, |i| i + 1);
                callee = enclosing_callee(before);
            }
            if !ends_arg(&outside[end..])
                || !callee.is_some_and(|callee| GIT_DIR_SINKS.contains(&callee))
            {
                stray.push(format!(".git_dir() in {}", callee.unwrap_or("no call")));
            }
        }
        for conversion in [".to_string_lossy()", ".to_str()", ".display()"] {
            for (at, _) in outside.match_indices(conversion) {
                let before = outside[..at].trim_end();
                let start = before
                    .trim_end_matches("()")
                    .bytes()
                    .rposition(|b| !ident(b))
                    .map_or(0, |i| i + 1);
                let receiver = &before[start..];
                if !STRING_RECEIVERS.contains(&receiver) {
                    stray.push(format!("{conversion} on {receiver}"));
                }
            }
        }
        for (at, _) in outside.match_indices("let ") {
            if at > 0 && ident(bytes[at - 1]) {
                continue;
            }
            let rest = outside[at + 4..].trim_start_matches("mut ");
            let end = rest.bytes().position(|b| !ident(b)).unwrap_or(rest.len());
            if matches!(&rest[..end], "repo" | "repo_path") {
                stray.push(format!("let {}", &rest[..end]));
            }
        }
        // Anywhere outside the module, so an argv or env built before its call counts.
        const REDIRECTS: [&str; 6] = [
            "\"-C\"",
            "\"--git-dir",
            "\"--work-tree",
            "\"GIT_DIR\"",
            "\"GIT_WORK_TREE\"",
            "\"GIT_COMMON_DIR\"",
        ];
        for needle in REDIRECTS {
            for (at, _) in outside.match_indices(needle) {
                // A `rev-parse` query of `--git-dir` asks for a path; it redirects nothing.
                if outside[at..].starts_with("\"--git-dir\"") {
                    let open = outside[..at].rfind('[').map_or(0, |i| i + 1);
                    if outside[open..].trim_start().starts_with("\"rev-parse\"") {
                        continue;
                    }
                }
                stray.push(format!("redirect {}", needle.trim_matches('"')));
            }
        }
        (calls, stray)
    }

    #[test]
    fn child_side_git_goes_through_child_repo() {
        let source = include_str!("submodule.rs");
        let (calls, stray) = child_side_spawns(source);
        assert!(
            calls >= 20,
            "the scan reads the file's runner calls: {calls}"
        );
        assert_eq!(stray, Vec::<String>::new());
        let anchor = "async fn submodule_is_shallow(";
        for splice in [
            "fn spliced() { run_git_raw(Some(dir), &[], DEFAULT_TIMEOUT); }",
            "fn spliced() { crate::git::ops::has_unmerged(child.folder()); }",
            "fn spliced(child: &ChildRepo) { let repo = child.folder(); \
             let _ = run_git_raw(Some(repo), &[], DEFAULT_TIMEOUT); }",
            "async fn spliced(child: &ChildRepo) { \
             let _ = index_gitlink(child.folder(), \"\", \"\").await; }",
            "fn spliced(worktree: &Path) { let repo_path = worktree.to_str().unwrap_or(\"\"); \
             let _ = run_git_raw(Some(repo_path), &[], DEFAULT_TIMEOUT); }",
            "fn spliced(worktree: &Path) { \
             let _ = run_git_raw(Some(&worktree.to_string_lossy()), &[], DEFAULT_TIMEOUT); }",
            "fn spliced() { run_git_raw(Some(repo_path), &[\"-C\", \"x\", \"status\"], DEFAULT_TIMEOUT); }",
            "fn spliced() { run_git_raw(Some(repo_path), &[\"--git-dir=x\", \"status\"], DEFAULT_TIMEOUT); }",
            "fn spliced() { run_git_raw(Some(repo_path), &[\"--git-dir\", \"x\", \"status\"], DEFAULT_TIMEOUT); }",
            "fn spliced() { run_git_raw(Some(repo_path), &[\"--work-tree=x\", \"status\"], DEFAULT_TIMEOUT); }",
            "fn spliced() { run_git_raw_env(Some(repo_path), &[\"status\"], &[(\"GIT_DIR\", \"x\")], DEFAULT_TIMEOUT); }",
            "fn spliced() { run_git_raw_env(Some(repo_path), &[\"status\"], &[(\"GIT_WORK_TREE\", \"x\")], DEFAULT_TIMEOUT); }",
            "fn spliced() { run_git_raw_env(Some(repo_path), &[\"status\"], &[(\"GIT_COMMON_DIR\", \"x\")], DEFAULT_TIMEOUT); }",
            "fn spliced(child: &ChildRepo) { let dir = child.git_dir(); }",
            "fn spliced(child: &ChildRepo) { let _ = run_git_raw(Some(child.git_dir()), &[], DEFAULT_TIMEOUT); }",
            "fn spliced(child: &ChildRepo) { crate::git::ops::op_state_at(&Path::new(child.git_dir()).join(\"x\")); }",
            "fn spliced(child: &ChildRepo) { crate::git::ops::op_state_at(other(child.git_dir())); }",
        ] {
            let spliced = source.replacen(anchor, &format!("{splice}\n{anchor}"), 1);
            assert_ne!(
                child_side_spawns(&spliced).1,
                Vec::<String>::new(),
                "{splice}"
            );
        }
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
        assert!(at("acquire_repo_lock(") < at("stage_gitlink_write("));
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

        // Passed back as `rev`, the tip lists the same history after the ref rewinds,
        // where the ref name would skip past it.
        assert_eq!(page.tip.as_deref(), Some(third.as_str()));
        assert_eq!(rest.tip.as_deref(), Some(third.as_str()));
        let sub = sub_dir(&host);
        git(&sub, &["update-ref", rev, &first]).await;
        let pinned = commit_page(&host, &third, 2, 2, None).await;
        let shas = |page: &SubmoduleCommitPage| {
            page.commits
                .iter()
                .map(|c| c.sha.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(shas(&pinned), [first.clone(), base.clone()]);
        assert_eq!(pinned.tip.as_deref(), Some(third.as_str()));
        assert_eq!(
            shas(&commit_page(&host, rev, 2, 2, None).await),
            Vec::<String>::new()
        );
        git(&sub, &["update-ref", rev, &third]).await;

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
            tip: Some("b".repeat(40)),
        };
        let json = serde_json::to_value(page.clone()).unwrap();
        assert_eq!(
            keys(&json),
            ["checkout", "commits", "hasMore", "reason", "shallow", "tip"]
        );
        assert_eq!(json["tip"], "b".repeat(40));
        let none = serde_json::to_value(SubmoduleCommitPage { tip: None, ..page }).unwrap();
        assert_eq!(none["tip"], serde_json::Value::Null);
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
                Some(WOULD_OVERWRITE_HEADERS[0].0),
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
            plan_blocked(SubmodulePickBlock::UntrackedInTheWay, None, &["a.txt"])
        );
        let outcome = pick(&f.host, &f.c1, &f.c0).await.unwrap();
        assert_eq!(
            outcome,
            outcome_blocked(
                SubmodulePickBlock::UntrackedInTheWay,
                Some(WOULD_OVERWRITE_HEADERS[1].0),
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
            plan_blocked(SubmodulePickBlock::IgnoredInTheWay, None, &["ign.txt"])
        );
        let outcome = pick(&f.host, &tracks, &f.c0).await.unwrap();
        assert_eq!(
            outcome,
            outcome_blocked(
                SubmodulePickBlock::IgnoredInTheWay,
                Some(WOULD_OVERWRITE_HEADERS[1].0),
                &["ign.txt"]
            ),
            "git lists it under the untracked header; check-ignore tells it apart"
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
        let header = WOULD_OVERWRITE_HEADERS[0].0;
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

        // Detached at a commit only `keep` names, so the pick moves. The checkout's own
        // index write runs post-index-change with "1", which drops `keep` before git's
        // orphan check, so git still warns about leaving the commit behind (measured,
        // git 2.47.3, 2.51.1, 2.56.1).
        std::fs::write(
            &hook,
            "#!/bin/sh\necho 'hook: build step failed' >&2\nexit 1\n",
        )
        .unwrap();
        let drop_keep = hooks.join("post-index-change");
        let script =
            "#!/bin/sh\n[ \"$1\" = 1 ] || exit 0\nexec git update-ref -d refs/heads/keep\n";
        std::fs::write(&drop_keep, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::Permissions::from_mode(0o755);
            std::fs::set_permissions(&drop_keep, mode).unwrap();
        }
        let orphan = commit_in(&f.sub, "x.txt", "orphan").await;
        git(&f.sub, &["branch", "keep", orphan.as_str()]).await;
        stage_gitlink(&f.host, &orphan).await;
        let outcome = pick(&f.host, &f.c1, &orphan).await.unwrap();
        assert_eq!(
            outcome,
            SubmodulePickOutcome::CheckoutFailed {
                reason: "hook: build step failed".into()
            },
            "the reason is the hook's line, past git's orphan warning"
        );
        let keep = git(&f.sub, &["branch", "--list", "keep"]).await;
        assert_eq!(keep.trim(), "", "premise: the checkout dropped keep");
        assert_eq!(head_of(&f.sub).await, f.c1, "the named HEAD moved");
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
        let out = detach_in(sub, &child_at(sub).await, m).await.unwrap();
        match plan {
            SubmodulePickPlan::Ready { .. } => {
                assert_eq!(out.code, 0, "{arm}: the checkout lands: {}", out.stderr)
            }
            SubmodulePickPlan::Blocked {
                why:
                    SubmodulePickBlock::WouldOverwrite
                    | SubmodulePickBlock::UntrackedInTheWay
                    | SubmodulePickBlock::IgnoredInTheWay,
                paths,
                ..
            } => {
                assert_ne!(out.code, 0, "{arm}: the checkout refuses");
                let (_, _, listed) = would_overwrite(&out.stderr)
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
        use SubmodulePickBlock::{IgnoredInTheWay, UntrackedInTheWay, WouldOverwrite};
        for (arm, blocks, why) in [
            (
                "a tracked edit the target changes",
                "edit.txt",
                WouldOverwrite,
            ),
            (
                "an untracked file the target tracks",
                "untracked.txt",
                UntrackedInTheWay,
            ),
            (
                "an ignored file the target tracks",
                "ignored.txt",
                IgnoredInTheWay,
            ),
            (
                "an untracked file where the target needs a directory",
                "need",
                UntrackedInTheWay,
            ),
            (
                "a directory the target makes a file, holding an untracked file",
                "dirfile",
                UntrackedInTheWay,
            ),
            (
                "a directory the target makes a file, holding an ignored file",
                "dirfile/u.ign",
                IgnoredInTheWay,
            ),
            (
                "a directory at a path deleted from disk",
                "dirdel.txt",
                WouldOverwrite,
            ),
            (
                "a staged rename of a file the target changes",
                "r.txt",
                WouldOverwrite,
            ),
            (
                "a staged deletion still on disk of a file the target deletes",
                "gone.txt",
                UntrackedInTheWay,
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
            assert_eq!(plan, plan_blocked(why, None, &[blocks]), "{arm}");
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
            plan_blocked(
                SubmodulePickBlock::IgnoredInTheWay,
                None,
                &["untracked.txt"]
            ),
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
            plan_blocked(SubmodulePickBlock::IgnoredInTheWay, None, &["same.txt"]),
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
            plan_blocked(SubmodulePickBlock::UntrackedInTheWay, None, &["edit.txt"]),
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
        let rows: [(&str, i32, &str, Option<&str>); 12] = [
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
            (
                "a path holding the lossy marker",
                128,
                "error: Untracked working tree file 'a\u{FFFD}.txt' would be overwritten by merge.\n",
                None,
            ),
        ];
        for (name, code, stderr, want) in rows {
            let got = dry_run_refusal(code, stderr);
            assert_eq!(got.as_ref().map(|(_, path)| path.as_str()), want, "{name}");
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
    async fn pick_moves_a_detached_head_only_where_a_ref_still_names_it() {
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

        // Only the index gitlink Apply replaces reaches HEAD: the recorded pointer
        // descends from it.
        let orphaned = || outcome_blocked(SubmodulePickBlock::DetachedOrphan, None, &[]);
        git(&f.sub, &["checkout", "-q", "--detach", &o1]).await;
        assert_eq!(pick(&f.host, &f.c1, &o2).await.unwrap(), orphaned());
        assert_eq!(head_of(&f.sub).await, o1);
        assert_eq!(pointer_row(&f.host).await, row_at(&o2));

        // Only the index gitlink Apply replaces names HEAD.
        let o3 = commit_in(&f.sub, "o3.txt", "o3").await;
        stage_gitlink(&f.host, &o3).await;
        assert_eq!(
            pick_read(&f.host, &f.c2).await.plan,
            plan_blocked(SubmodulePickBlock::DetachedOrphan, None, &[])
        );
        assert_eq!(pick(&f.host, &f.c2, &o3).await.unwrap(), orphaned());
        assert_eq!(head_of(&f.sub).await, o3);
        assert_eq!(pointer_row(&f.host).await, row_at(&o3));

        // The parent's HEAD tree records HEAD on complete history: still an orphan.
        git(&f.sub, &["checkout", "-q", "--detach", &o3]).await;
        stage_gitlink(&f.host, &o3).await;
        git(&f.host, &["commit", "-qm", "record o3"]).await;
        stage_gitlink(&f.host, &f.c2).await;
        assert_eq!(
            pick_read(&f.host, &f.c1).await.plan,
            plan_blocked(SubmodulePickBlock::DetachedOrphan, None, &[])
        );
        assert_eq!(pick(&f.host, &f.c1, &f.c2).await.unwrap(), orphaned());
        assert_eq!(head_of(&f.sub).await, o3);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c2));

        // A branch names that recorded HEAD.
        git(&f.sub, &["branch", "keep-o3", &o3]).await;
        assert_eq!(
            pick_read(&f.host, &f.c1).await.plan,
            ready(SubmodulePickMove::CheckOut)
        );
        assert_eq!(pick(&f.host, &f.c1, &f.c2).await.unwrap(), landed(&f.c1));
        assert_eq!(head_of(&f.sub).await, f.c1);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c1));

        // The parent's HEAD records a descendant of HEAD, and no ref reaches either.
        let d = commit_in(&f.sub, "d.txt", "d").await;
        let e = commit_in(&f.sub, "e.txt", "e").await;
        stage_gitlink(&f.host, &e).await;
        git(&f.host, &["commit", "-qm", "record e"]).await;
        git(&f.sub, &["checkout", "-q", "--detach", &d]).await;
        assert_eq!(
            pick_read(&f.host, &f.c2).await.plan,
            plan_blocked(SubmodulePickBlock::DetachedOrphan, None, &[])
        );
        assert_eq!(pick(&f.host, &f.c2, &e).await.unwrap(), orphaned());
        assert_eq!(head_of(&f.sub).await, d);
        assert_eq!(pointer_row(&f.host).await, row_at(&e));
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

        // The parent's HEAD tree recording that HEAD keeps nothing: still blocked.
        stage_gitlink(&host, &stray).await;
        git(&host, &["commit", "-qm", "record stray"]).await;
        let read = pick_read(&host, &tip).await;
        assert_eq!(read.shallow, Some(true));
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::DetachedUnverified, None, &[])
        );
        assert_eq!(
            pick(&host, &tip, &stray).await.unwrap(),
            outcome_blocked(SubmodulePickBlock::DetachedUnverified, None, &[])
        );
        assert_eq!(head_of(&sub).await, stray);
        assert_eq!(pointer_row(&host).await, row_at(&stray));

        // A branch at that HEAD names it, the history still shallow.
        git(&sub, &["branch", "keep-stray", &stray]).await;
        let child = child_at(&sub).await;
        let probe = orphan_probe(&child, "libs/dep", &stray, &tip, Some(true)).await;
        assert_eq!(probe, OrphanFact::Named);
        let read = pick_read(&host, &tip).await;
        assert_eq!(read.plan, ready(SubmodulePickMove::CheckOut));
        assert_eq!(
            pick(&host, &tip, &stray).await.unwrap(),
            set_at(&tip, SubmodulePickMove::CheckOut)
        );
        assert_eq!(head_of(&sub).await, tip);
        assert_eq!(pointer_row(&host).await, row_at(&tip));
        let shallow = git(&sub, &["rev-parse", "--is-shallow-repository"]).await;
        assert_eq!(shallow.trim(), "true", "never unshallowed");
    }

    /// A detached HEAD a by-sha shallow fetch listed as a shallow root, named by no
    /// ref: the probe can't place it, so the pick stays put, as for any HEAD the probe
    /// can't place. A target that descends from it, or a branch at it, lets it move.
    #[tokio::test]
    async fn pick_blocks_a_shallow_root_no_ref_names() {
        let (_dir, host, dep) = host_with_submodule("pick-shallow-root").await;
        let sub = sub_dir(&host);
        let base = head_of(&sub).await;
        let older = commit_in(&dep, "dep.txt", "one").await;
        let tip = commit_in(&dep, "dep.txt", "two").await;
        git(&sub, &["fetch", "-q", "--depth", "1", "origin", &older]).await;
        git(&sub, &["fetch", "-q", "--depth", "1", "origin"]).await;
        git(&sub, &["checkout", "-q", "--detach", &older]).await;
        let roots = std::fs::read_to_string(git_path(&sub, "shallow").await).unwrap();
        assert!(roots.lines().any(|root| root == older), "premise: listed");
        let child = child_at(&sub).await;
        let probe = orphan_probe(&child, "libs/dep", &older, &tip, Some(true)).await;
        assert_eq!(probe, OrphanFact::Unverified(None), "premise: unnamed");

        let read = pick_read(&host, &tip).await;
        assert_eq!(read.shallow, Some(true));
        let unverified = SubmodulePickBlock::DetachedUnverified;
        assert_eq!(read.plan, plan_blocked(unverified, None, &[]));
        assert_eq!(
            pick(&host, &tip, &base).await.unwrap(),
            outcome_blocked(unverified, None, &[])
        );
        assert_eq!(head_of(&sub).await, older);
        assert_eq!(pointer_row(&host).await, row_at(&base));

        // A target that descends from HEAD reaches it inside the local history.
        let tree = format!("{older}^{{tree}}");
        let above = [
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit-tree",
            tree.as_str(),
            "-p",
            older.as_str(),
            "-m",
            "above",
        ];
        let above = git(&sub, &above).await.trim().to_string();
        let read = pick_read(&host, &above).await;
        assert_eq!(read.plan, ready(SubmodulePickMove::CheckOut));

        // A branch at that HEAD names it, the history still shallow.
        git(&sub, &["branch", "keep", older.as_str()]).await;
        let read = pick_read(&host, &tip).await;
        assert_eq!(read.plan, ready(SubmodulePickMove::CheckOut));
        assert_eq!(
            pick(&host, &tip, &base).await.unwrap(),
            set_at(&tip, SubmodulePickMove::CheckOut)
        );
        assert_eq!(head_of(&sub).await, tip);
        assert_eq!(pointer_row(&host).await, row_at(&tip));
        let shallow = git(&sub, &["rev-parse", "--is-shallow-repository"]).await;
        assert_eq!(shallow.trim(), "true", "never unshallowed");
    }

    /// A depth-1 submodule detached at a branch tip its tracking ref names moves; once
    /// the remote deletes the branch and the app's own Fetch prunes the tracking ref, the
    /// same HEAD, still listed as a shallow root, stays put.
    #[tokio::test]
    async fn pick_blocks_a_shallow_head_once_a_pruning_fetch_drops_its_ref() {
        let (_dir, host, dep) = host_with_submodule("pick-shallow-pruned").await;
        let sub = sub_dir(&host);
        let base = head_of(&sub).await;
        git(&dep, &["checkout", "-q", "-b", "feature"]).await;
        commit_in(&dep, "f.txt", "f1").await;
        let feature = commit_in(&dep, "f.txt", "f2").await;
        git(&dep, &["checkout", "-q", "-"]).await;
        let tip = commit_in(&dep, "dep.txt", "m1").await;
        git(&sub, &["fetch", "-q", "--depth", "1", "origin"]).await;
        git(&sub, &["checkout", "-q", "--detach", "origin/feature"]).await;
        assert_eq!(head_of(&sub).await, feature, "premise: at the branch tip");
        let read = pick_read(&host, &tip).await;
        assert_eq!(read.shallow, Some(true));
        assert_eq!(read.plan, ready(SubmodulePickMove::CheckOut));

        git(&dep, &["branch", "-q", "-D", "feature"]).await;
        git_submodule_fetch_core(&AppState::default(), &host, "libs/dep", false)
            .await
            .unwrap();
        let refs = git(&sub, &["for-each-ref", "refs/remotes/origin/feature"]).await;
        assert_eq!(refs.trim(), "", "premise: pruned");
        let roots = std::fs::read_to_string(git_path(&sub, "shallow").await).unwrap();
        assert!(roots.lines().any(|root| root == feature), "premise: listed");
        let read = pick_read(&host, &tip).await;
        assert_eq!(read.shallow, Some(true));
        let unverified = SubmodulePickBlock::DetachedUnverified;
        assert_eq!(read.plan, plan_blocked(unverified, None, &[]));
        assert_eq!(
            pick(&host, &tip, &base).await.unwrap(),
            outcome_blocked(unverified, None, &[])
        );
        assert_eq!(head_of(&sub).await, feature);
        assert_eq!(pointer_row(&host).await, row_at(&base));
    }

    /// A submodule `update --depth 1` cloned (one branch, the pin fetched by sha) and
    /// Fetch full history completed: a pin on the fetched branch is named and moves; one
    /// off it is complete history no ref names, an orphan. The URL is `file://` because
    /// a local-path clone ignores `--depth`.
    #[tokio::test]
    async fn pick_after_full_history_reads_a_pin_off_the_fetched_branch_as_an_orphan() {
        let (_dir, host, dep) = host_with_submodule("pick-depth-unshallowed").await;
        let older = commit_in(&dep, "dep.txt", "a1").await;
        git(&dep, &["checkout", "-q", "-b", "rel"]).await;
        let rel = commit_in(&dep, "r.txt", "r1").await;
        git(&dep, &["checkout", "-q", "-"]).await;
        let tip = commit_in(&dep, "dep.txt", "a2").await;
        let url = dep.replace('\\', "/");
        let url = format!("file:///{}", url.trim_start_matches('/'));
        let modules = Path::new(&host).join(".git").join("modules").join("libs");
        let cases = [
            ("on the branch", &older, ready(SubmodulePickMove::CheckOut)),
            (
                "off the branch",
                &rel,
                plan_blocked(SubmodulePickBlock::DetachedOrphan, None, &[]),
            ),
        ];
        for (case, pin, want) in cases {
            git(&host, &["submodule", "deinit", "-q", "-f", "libs/dep"]).await;
            std::fs::rename(modules.join("dep"), modules.join(format!("dep-{case}"))).unwrap();
            stage_gitlink(&host, pin).await;
            git(&host, &["submodule", "init", "--", "libs/dep"]).await;
            git(&host, &["config", "submodule.libs/dep.url", url.as_str()]).await;
            let update = ["submodule", "update", "--depth", "1", "--", "libs/dep"];
            git(&host, &update).await;
            let sub = sub_dir(&host);
            let shallow = || git(&sub, &["rev-parse", "--is-shallow-repository"]);
            assert_eq!(shallow().await.trim(), "true", "{case}: premise: depth 1");
            assert_eq!(&head_of(&sub).await, pin, "{case}: premise: at the pin");
            git_submodule_fetch_core(&AppState::default(), &host, "libs/dep", true)
                .await
                .unwrap();
            assert_eq!(shallow().await.trim(), "false", "{case}: unshallowed");
            assert_eq!(pick_read(&host, &tip).await.plan, want, "{case}");
        }
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
        let plain = git_submodule_fetch_core(&state, &host, "libs/dep", false)
            .await
            .unwrap();
        assert_eq!(shallow().await, "true", "a plain fetch keeps the cut");
        assert_eq!(
            plain,
            SubmoduleFetchResult {
                shallow: Some(true)
            }
        );
        let full = git_submodule_fetch_core(&state, &host, "libs/dep", true)
            .await
            .unwrap();
        assert_eq!(shallow().await, "false");
        assert_eq!(
            full,
            SubmoduleFetchResult {
                shallow: Some(false)
            },
            "measured after the fetch"
        );
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
        // A config git can't read fails the folder gate first, which names git's line.
        match git_submodule_fetch_core(&AppState::default(), &host, "libs/dep", true).await {
            Err(AppError::InvalidArgument(message)) => assert!(
                message
                    .starts_with("Can't fetch the submodule at libs/dep — git couldn't read it: "),
                "{message}"
            ),
            other => panic!("an unreadable submodule refuses: {other:?}"),
        }
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
            plan_blocked(
                SubmodulePickBlock::SubmoduleMidOperation,
                Some("a rebase"),
                &[]
            )
        );
        assert_eq!(
            pick(&f.host, &f.c1, &f.c0).await.unwrap(),
            outcome_blocked(
                SubmodulePickBlock::SubmoduleMidOperation,
                Some("a rebase"),
                &[]
            )
        );
        assert!(marker.is_dir(), "rebase-merge is still there");
        assert_eq!(head_of(&f.sub).await, f.c2);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0));
    }

    /// The submodule's op state is read at the git dir its resolve returned, so no git-dir
    /// probe of its own can fail there.
    #[tokio::test]
    async fn pick_reads_the_submodule_op_state_at_the_resolved_git_dir() {
        let f = gitlink_fixture("pick-probe-fault").await;
        let read = crate::git::ops::with_git_dir_probe_fault(git_submodule_pick_plan_core(
            &f.host, "libs/dep", &f.c1,
        ))
        .await
        .unwrap();
        assert_eq!(read.plan, ready(SubmodulePickMove::CheckOut));
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
        let child = child_at(&f.sub).await;
        let probe = |shallow| orphan_probe(&child, "libs/dep", &orphan, &f.c1, shallow);
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
                reason: Some(format!(
                    "the recorded commit reads {} now",
                    short_oid(&f.c2)
                )),
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
                "a detached HEAD only the index records is probed",
                edit(|f| {
                    f.gate.head = Some(pointer.clone());
                    f.orphan = None;
                }),
                need(PickNeed::Orphan),
            ),
            (
                "a detached HEAD only the index records can be an orphan",
                edit(|f| {
                    f.gate.head = Some(pointer.clone());
                    f.orphan = Some(OrphanFact::Orphan);
                }),
                blocked(B::DetachedOrphan, None),
            ),
            (
                "an inconclusive probe blocks",
                edit(|f| f.orphan = Some(OrphanFact::Unverified(None))),
                blocked(B::DetachedUnverified, None),
            ),
            (
                "an inconclusive probe blocks before the dry run",
                edit(|f| {
                    f.orphan = Some(OrphanFact::Unverified(None));
                    f.shallow = Some(Some(true));
                    f.overwrite = None;
                }),
                blocked(B::DetachedUnverified, None),
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
                edit(|f| {
                    f.overwrite = Some(OverwriteFact::Blocked(B::WouldOverwrite, vec!["x".into()]))
                }),
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
        // No remote's URL is the `.gitmodules` one, which would outrank the branch's.
        let elsewhere = [
            "config",
            "-f",
            ".gitmodules",
            "submodule.libs/dep.url",
            "../x",
        ];
        git(&host, &elsewhere).await;
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
            (B::UntrackedInTheWay, "untrackedInTheWay"),
            (B::IgnoredInTheWay, "ignoredInTheWay"),
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
            (
                SubmodulePickOutcome::MovedAfter {
                    sha: "s".into(),
                    pointer: Some("p".into()),
                    head: None,
                },
                json!({ "kind": "movedAfter", "sha": "s", "pointer": "p", "head": null }),
            ),
            (
                SubmodulePickOutcome::ReadBackFailed {
                    sha: "s".into(),
                    reason: "r".into(),
                },
                json!({ "kind": "readBackFailed", "sha": "s", "reason": "r" }),
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
            "moved_after",
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
        assert!(at("acquire_repo_lock(") < at("pick_entry_gate("));
        assert!(at("pick_entry_gate(") < at(child));
        assert!(at(child) < at("detach_submodule_at("));
        assert!(at("detach_submodule_at(") < at("stage_gitlink_cas("));
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
            update: None,
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

    fn write_hook(hooks: &Path, name: &str, body: &str) {
        std::fs::create_dir_all(hooks).unwrap();
        let hook = hooks.join(name);
        std::fs::write(&hook, format!("#!/bin/sh\n{body}")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn sh_path(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    #[tokio::test]
    async fn a_dot_git_folder_git_rejects_reads_not_initialized_and_never_reaches_the_parent() {
        let f = gitlink_fixture("pick-bogus-dot-git").await;
        let dot_git = Path::new(&f.sub).join(".git");
        let gitfile = std::fs::read(&dot_git).unwrap();
        let parent_head = git(&f.host, &["symbolic-ref", "HEAD"]).await;
        for arm in ["an empty .git folder", "a .git folder without HEAD"] {
            std::fs::remove_file(&dot_git).unwrap();
            std::fs::create_dir(&dot_git).unwrap();
            if arm == "a .git folder without HEAD" {
                for sub in ["objects", "refs"] {
                    std::fs::create_dir(dot_git.join(sub)).unwrap();
                }
            }
            let refs = git_submodule_refs_core(&f.host, "libs/dep").await.unwrap();
            assert_eq!(
                refs.checkout,
                SubmoduleCheckout::NotInitialized,
                "{arm}: refs"
            );
            assert!(refs.branches.is_empty(), "{arm}: no parent branches");
            let page =
                git_submodule_commits_core(&f.host, "libs/dep", "refs/heads/main", 0, 10, None)
                    .await
                    .unwrap();
            assert_eq!(
                page.checkout,
                SubmoduleCheckout::NotInitialized,
                "{arm}: commits"
            );
            assert!(page.commits.is_empty(), "{arm}: no parent commits");
            assert_eq!(
                pick_read(&f.host, &f.c1).await.plan,
                plan_blocked(SubmodulePickBlock::NotInitialized, None, &[]),
                "{arm}: plan"
            );
            assert!(
                git_submodule_fetch_core(&AppState::default(), &f.host, "libs/dep", false)
                    .await
                    .is_err(),
                "{arm}: fetch refuses"
            );
            assert_eq!(
                pick(&f.host, &f.c1, &f.c0).await.unwrap(),
                outcome_blocked(SubmodulePickBlock::NotInitialized, None, &[]),
                "{arm}: setter"
            );
            assert_eq!(
                git(&f.host, &["symbolic-ref", "HEAD"]).await,
                parent_head,
                "{arm}: the parent's HEAD stays on its branch"
            );
            assert_eq!(pointer_row(&f.host).await, row_at(&f.c0), "{arm}: pointer");
            std::fs::remove_dir_all(&dot_git).unwrap();
            std::fs::write(&dot_git, &gitfile).unwrap();
        }
    }

    #[tokio::test]
    async fn pick_checks_out_the_commit_when_a_branch_is_named_as_its_id() {
        let f = gitlink_fixture("pick-sha-branch").await;
        git(&f.sub, &["branch", &f.c1, &f.c2]).await;
        assert_eq!(
            pick(&f.host, &f.c1, &f.c0).await.unwrap(),
            set_at(&f.c1, SubmodulePickMove::CheckOut)
        );
        assert_eq!(
            head_of(&f.sub).await,
            f.c1,
            "HEAD is the commit, not the branch tip"
        );
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c1));
    }

    #[tokio::test]
    async fn pick_refuses_a_checkout_that_exits_0_elsewhere() {
        let f = gitlink_fixture("pick-hook-moves-head").await;
        let hooks = git_path(&f.sub, "hooks").await;
        write_hook(
            &hooks,
            "post-checkout",
            &format!("git update-ref --no-deref HEAD {}\n", f.c2),
        );
        assert_eq!(
            pick(&f.host, &f.c1, &f.c0).await.unwrap(),
            SubmodulePickOutcome::CheckoutFailed {
                reason: format!("HEAD isn't at {} after the checkout", f.c1)
            }
        );
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0), "nothing staged");
    }

    #[test]
    fn detach_retries_only_gits_own_lock_refusal_with_head_unmoved() {
        let out = |code: i32, stderr: &str| GitOutput {
            stdout: Vec::new(),
            stderr: stderr.into(),
            code,
        };
        let lock = "fatal: Unable to create 'x/index.lock': File exists.";
        let at = |sha: &str| HeadRead::At(sha.to_string());
        let rows = [
            (
                "git's refusal, HEAD unmoved",
                out(128, lock),
                Some("a"),
                at("a"),
                true,
            ),
            (
                "an unborn HEAD unmoved",
                out(128, lock),
                None,
                HeadRead::Gone(NO_COMMIT),
                true,
            ),
            (
                "HEAD moved (a hook's text)",
                out(128, lock),
                Some("a"),
                at("b"),
                false,
            ),
            (
                "a hook's own exit code",
                out(1, lock),
                Some("a"),
                at("a"),
                false,
            ),
            (
                "no lock text",
                out(128, "fatal: other"),
                Some("a"),
                at("a"),
                false,
            ),
            (
                "HEAD unread after",
                out(128, lock),
                Some("a"),
                HeadRead::Unread("x".into()),
                false,
            ),
            (
                "the folder emptied while unborn",
                out(128, lock),
                None,
                HeadRead::Gone(FOLDER_GONE),
                false,
            ),
        ];
        for (name, out, before, after, want) in rows {
            assert_eq!(detach_retry(&out, before, &after), want, "{name}");
        }
    }

    #[tokio::test]
    async fn detach_runs_a_failing_post_checkout_hook_once() {
        let f = gitlink_fixture("pick-hook-lock-text").await;
        let runs = Path::new(&f.host).parent().unwrap().join("hook-runs.txt");
        let hooks = git_path(&f.sub, "hooks").await;
        let body = format!(
            "echo run >> '{}'\necho \"fatal: Unable to create 'x/index.lock': File exists.\" >&2\nexit 128\n",
            sh_path(&runs)
        );
        write_hook(&hooks, "post-checkout", &body);
        let out = detach_in(&f.sub, &child_at(&f.sub).await, &f.c1)
            .await
            .unwrap();
        assert_ne!(out.code, 0, "the hook's failure stands");
        assert_eq!(head_of(&f.sub).await, f.c1, "HEAD moved before the hook");
        assert_eq!(
            std::fs::read_to_string(&runs).unwrap().lines().count(),
            1,
            "the hook ran once"
        );
    }

    #[tokio::test]
    async fn pick_keeps_an_outside_stage_made_during_the_lock_wait() {
        let f = gitlink_fixture("pick-stage-retry").await;
        let lock = Path::new(&f.host).join(".git").join("index.lock");
        let retried = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let landed: PickLandedHook = {
            let lock = lock.clone();
            Arc::new(move || {
                let lock = lock.clone();
                Box::pin(async move { std::fs::write(&lock, "").unwrap() })
            })
        };
        let retry: PickLandedHook = {
            let (lock, host, c2, retried) = (lock, f.host.clone(), f.c2.clone(), retried.clone());
            Arc::new(move || {
                let (lock, host, c2, retried) =
                    (lock.clone(), host.clone(), c2.clone(), retried.clone());
                Box::pin(async move {
                    retried.store(true, std::sync::atomic::Ordering::SeqCst);
                    std::fs::remove_file(&lock).unwrap();
                    stage_gitlink(&host, &c2).await;
                })
            })
        };
        let outcome = PICK_LANDED_HOOK
            .scope(
                landed,
                STAGE_RETRY_HOOK.scope(retry, pick(&f.host, &f.c1, &f.c0)),
            )
            .await
            .unwrap();
        assert!(
            retried.load(std::sync::atomic::Ordering::SeqCst),
            "the stage hit the lock"
        );
        assert_eq!(
            outcome,
            SubmodulePickOutcome::CheckedOutNotStaged {
                sha: f.c1.clone(),
                why: SubmodulePickUnstaged::PointerMoved,
                reason: Some(format!(
                    "the recorded commit reads {} now",
                    short_oid(&f.c2)
                )),
            }
        );
        assert_eq!(
            pointer_row(&f.host).await,
            row_at(&f.c2),
            "the new pointer stays"
        );
        assert_eq!(head_of(&f.sub).await, f.c1);
    }

    #[tokio::test]
    async fn stage_cas_moves_only_a_matching_pointer() {
        let f = gitlink_fixture("stage-cas").await;
        let moved = stage_gitlink_cas(&f.host, "libs/dep", &f.c0, &f.c1)
            .await
            .unwrap();
        assert_eq!(moved.code, 0, "{}", moved.stderr);
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c1));
        let stale = stage_gitlink_cas(&f.host, "libs/dep", &f.c0, &f.c2)
            .await
            .unwrap();
        assert_ne!(stale.code, 0, "a stale preimage is refused");
        assert_eq!(
            pointer_row(&f.host).await,
            row_at(&f.c1),
            "the outside value stays"
        );
        assert_eq!(head_of(&f.sub).await, f.c2, "the checkout is untouched");
    }

    /// A post-index-change hook body that stages `sha` at `libs/dep` after each write.
    fn rewrite_hook(sha: &str) -> String {
        format!(
            "[ -n \"$GD_REENTRY\" ] && exit 0\n\
             GD_REENTRY=1 git update-index --cacheinfo 160000,{sha},libs/dep\nexit 1\n"
        )
    }

    #[tokio::test]
    async fn pick_reports_the_pointer_a_post_index_change_hook_left() {
        let f = gitlink_fixture("pick-hook-rewrite").await;
        let hooks = git_path(&f.host, "hooks").await;
        write_hook(&hooks, "post-index-change", &rewrite_hook(&f.c2));
        let outcome = pick(&f.host, &f.c1, &f.c0).await.unwrap();
        assert_eq!(
            outcome,
            SubmodulePickOutcome::CheckedOutNotStaged {
                sha: f.c1.clone(),
                why: SubmodulePickUnstaged::PointerMoved,
                reason: Some(format!(
                    "the recorded commit reads {} now",
                    short_oid(&f.c2)
                )),
            }
        );
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c2));
        assert_eq!(head_of(&f.sub).await, f.c1);
    }

    /// The landed hook moves the submodule's HEAD after the checkout.
    #[tokio::test]
    async fn pick_reports_a_checkout_moved_after_it_landed() {
        let f = gitlink_fixture("pick-moved-after").await;
        let landed: PickLandedHook = {
            let (sub, c2) = (f.sub.clone(), f.c2.clone());
            Arc::new(move || {
                let (sub, c2) = (sub.clone(), c2.clone());
                Box::pin(async move {
                    git(&sub, &["checkout", "-q", "--detach", &c2]).await;
                })
            })
        };
        let outcome = PICK_LANDED_HOOK
            .scope(landed, pick(&f.host, &f.c1, &f.c0))
            .await
            .unwrap();
        assert_eq!(
            outcome,
            SubmodulePickOutcome::MovedAfter {
                sha: f.c1.clone(),
                pointer: Some(f.c1.clone()),
                head: Some(f.c2.clone()),
            }
        );
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c1));
    }

    #[test]
    fn stage_verdict_table() {
        use SubmodulePickMove::{AlreadyThere, CheckOut};
        use SubmodulePickUnstaged::{PointerMoved, StageFailed, StageUnconfirmed};
        let (e, s, o) = ("e".repeat(40), "s".repeat(40), "o".repeat(40));
        let (short_e, short_o) = (short_oid(&e), short_oid(&o));
        let at = |sha: &str| -> Result<Option<String>, String> { Ok(Some(sha.to_string())) };
        let head_at = |sha: &str| HeadRead::At(sha.to_string());
        let refused: Result<(), String> = Err("git's line".into());
        let unstaged = |why, reason: String| SubmodulePickOutcome::CheckedOutNotStaged {
            sha: s.clone(),
            why,
            reason: Some(reason),
        };
        let failed = |reason: &str| SubmodulePickOutcome::ReadBackFailed {
            sha: s.clone(),
            reason: reason.into(),
        };
        let unread = |line: &str| HeadRead::Unread(line.into());
        let rows = vec![
            (
                "0: HEAD unread",
                Ok(()),
                at(&s),
                unread("h"),
                CheckOut,
                failed("h"),
            ),
            (
                "0: HEAD unread over an unread pointer",
                Ok(()),
                Err("p".to_string()),
                unread("h"),
                CheckOut,
                failed("h"),
            ),
            (
                "0': pointer unread, HEAD moved",
                Ok(()),
                Err("p".to_string()),
                head_at(&o),
                CheckOut,
                failed("p"),
            ),
            (
                "0': pointer unread, folder gone",
                Ok(()),
                Err("p".to_string()),
                HeadRead::Gone(FOLDER_GONE),
                CheckOut,
                failed("p"),
            ),
            (
                "1: HEAD moved",
                Ok(()),
                at(&s),
                head_at(&o),
                CheckOut,
                SubmodulePickOutcome::MovedAfter {
                    sha: s.clone(),
                    pointer: Some(s.clone()),
                    head: Some(o.clone()),
                },
            ),
            (
                "1: folder gone, no gitlink recorded",
                Ok(()),
                Ok(None),
                HeadRead::Gone(FOLDER_GONE),
                CheckOut,
                SubmodulePickOutcome::MovedAfter {
                    sha: s.clone(),
                    pointer: None,
                    head: None,
                },
            ),
            (
                "1: HEAD names no commit",
                Ok(()),
                at(&s),
                HeadRead::Gone(NO_COMMIT),
                CheckOut,
                SubmodulePickOutcome::MovedAfter {
                    sha: s.clone(),
                    pointer: Some(s.clone()),
                    head: None,
                },
            ),
            (
                "2: both at sha, a refused write included",
                refused.clone(),
                at(&s),
                head_at(&s),
                CheckOut,
                SubmodulePickOutcome::Set {
                    sha: s.clone(),
                    checkout: CheckOut,
                    nested_left: None,
                },
            ),
            (
                "3: pointer unreadable",
                Ok(()),
                Err("read failed".to_string()),
                head_at(&s),
                CheckOut,
                unstaged(StageUnconfirmed, "read failed".into()),
            ),
            (
                "4: pointer unmoved, git's line",
                refused.clone(),
                at(&e),
                head_at(&s),
                CheckOut,
                unstaged(StageFailed, "git's line".into()),
            ),
            (
                "4: pointer unmoved after exit 0",
                Ok(()),
                at(&e),
                head_at(&s),
                CheckOut,
                unstaged(
                    StageFailed,
                    format!("the staged pointer still reads {short_e}"),
                ),
            ),
            (
                "5: nothing this call moved or staged",
                refused.clone(),
                at(&o),
                head_at(&s),
                AlreadyThere,
                SubmodulePickOutcome::Changed,
            ),
            (
                "6: pointer moved",
                refused.clone(),
                at(&o),
                head_at(&s),
                CheckOut,
                unstaged(
                    PointerMoved,
                    format!("the recorded commit reads {short_o} now"),
                ),
            ),
            (
                "6: no gitlink now",
                Ok(()),
                Ok(None),
                head_at(&s),
                AlreadyThere,
                unstaged(PointerMoved, "the recorded commit reads nothing now".into()),
            ),
        ];
        for (name, wrote, pointer, head, checkout, want) in rows {
            assert_eq!(
                stage_verdict(&wrote, &pointer, &head, &e, &s, checkout),
                want,
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn gitlink_patch_quotes_awkward_paths() {
        let dir = temp("patch-quoting");
        let repo = seed_repo(dir.path(), "repo").await;
        git(&repo, &["config", "core.protectNTFS", "false"]).await;
        let (old, new) = ("1".repeat(40), "2".repeat(40));
        let cafe = format!("caf{}", char::from(0xe9_u8));
        let names = [
            "ta\tb",
            "my sub",
            cafe.as_str(),
            "quo\"te",
            "back\\slash",
            "nl\nx",
            " lead",
            "\"q",
        ];
        for name in names {
            let info = format!("160000,{old},{name}");
            git(&repo, &["update-index", "--add", "--cacheinfo", &info]).await;
            let out = stage_gitlink_cas(&repo, name, &old, &new).await.unwrap();
            assert_eq!(out.code, 0, "{name:?}: {}", out.stderr);
            // Every entry, matched by exact name: Windows reads `\` in a pathspec as a
            // separator.
            let staged = index_gitlink(&repo, name, ".").await.unwrap();
            assert_eq!(staged, Some(new.clone()), "{name:?}");
        }
        assert_eq!(
            quote_patch_path("a/ta\tb\"\\\x7f"),
            "\"a/ta\\011b\\\"\\\\\\177\""
        );
        assert!(gitlink_patch("my sub", &old, &new)
            .starts_with("diff --git \"a/my sub\" \"b/my sub\"\nindex "));
    }

    /// The write exited 0, then its hook rewrote the entry: the accept says what it
    /// staged and what the index holds now, never "nothing was staged".
    #[tokio::test]
    async fn accept_errs_with_what_the_index_holds_when_a_hook_rewrites_the_stage() {
        let f = gitlink_fixture("accept-hook-rewrite").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        let expected = stages_of(Some(&f.c0), Some(&f.c1), Some(&f.c2));
        let hooks = git_path(&f.host, "hooks").await;
        write_hook(&hooks, "post-index-change", &rewrite_hook(&f.c0));
        let err = accept(&f.host, "theirs", &expected, false)
            .await
            .unwrap_err();
        let AppError::InvalidArgument(message) = &err else {
            panic!("{err:?}")
        };
        let lead = format!(
            "Staged {} for {}, but something changed it right after: the index now reads \
             commit {}.",
            short_oid(&f.c2),
            crate::git::ops::discard_shown("libs/dep"),
            short_oid(&f.c0)
        );
        assert!(message.starts_with(&lead), "{message}");
        assert_eq!(
            pointer_row(&f.host).await,
            row_at(&f.c0),
            "the hook's entry stands"
        );
    }

    /// The write exited 0, then its hook left an index git can't read.
    #[tokio::test]
    async fn accept_errs_when_the_read_back_fails() {
        let f = gitlink_fixture("accept-read-back-fails").await;
        conflict_at(&f.host, Some(&f.c0), Some(&f.c1), Some(&f.c2)).await;
        let expected = stages_of(Some(&f.c0), Some(&f.c1), Some(&f.c2));
        let hooks = git_path(&f.host, "hooks").await;
        write_hook(&hooks, "post-index-change", "printf garbage > .git/index\n");
        let err = accept(&f.host, "theirs", &expected, false)
            .await
            .unwrap_err();
        let AppError::InvalidArgument(message) = &err else {
            panic!("{err:?}")
        };
        let lead = format!(
            "Staged {} for {}, but couldn't read it back: ",
            short_oid(&f.c2),
            crate::git::ops::discard_shown("libs/dep")
        );
        assert!(message.starts_with(&lead), "{message}");
        assert!(message.ends_with("The submodule's checkout was left as it was."));
    }

    /// A commit on `parent` with its tree, committed at `date` (git's raw format).
    async fn commit_dated(repo: &str, parent: &str, date: &str) -> String {
        let tree = format!("{parent}^{{tree}}");
        let env = [("GIT_COMMITTER_DATE", date), ("GIT_AUTHOR_DATE", date)];
        let args = [
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit-tree",
            &tree,
            "-p",
            parent,
            "-m",
            date,
        ];
        crate::git::runner::run_git_raw_env(Some(repo), &args, &env, TEST_GIT_HANG_GUARD)
            .await
            .unwrap()
            .exit_verdict()
            .unwrap()
            .stdout_lossy()
            .trim()
            .to_string()
    }

    /// A commit dated after its history under six commits dated long before it, the
    /// tip named by a remote-tracking ref: a `rev-list --not` walk gives up on the
    /// old-dated side before it reaches the commit and prints it.
    #[tokio::test]
    async fn reach_checks_recheck_what_a_skewed_walk_printed() {
        let f = gitlink_fixture("reach-skew").await;
        let skewed = commit_dated(&f.sub, &f.c2, "2051222400 +0000").await;
        let mut tip = skewed.clone();
        for _ in 0..6 {
            tip = commit_dated(&f.sub, &tip, "978307200 +0000").await;
        }
        git(&f.sub, &["update-ref", "refs/remotes/origin/skew", &tip]).await;
        let child = child_at(&f.sub).await;
        let reach = remote_reach(&child, std::slice::from_ref(&skewed), Some(false)).await;
        assert_eq!(reach, vec![Some(true)], "a remote-tracking ref holds it");
        let fact = orphan_probe(&child, "libs/dep", &skewed, &f.c0, Some(false)).await;
        assert!(matches!(fact, OrphanFact::Named), "a ref names it");
    }

    /// A page of local-only commits: the walk prints each, and one `--contains` read over
    /// all of them proves them unreached, with no per-commit re-check.
    #[tokio::test]
    async fn reach_checks_batch_a_page_of_local_only_commits() {
        let f = gitlink_fixture("reach-batch").await;
        let c3 = commit_in(&f.sub, "c.txt", "three").await;
        let c4 = commit_in(&f.sub, "d.txt", "four").await;
        let child = child_at(&f.sub).await;
        let shas = [f.c0.clone(), f.c1.clone(), f.c2.clone(), c3, c4];
        let (reach, reads) = RECHECKS
            .scope(std::cell::Cell::new(0), async {
                let reach = remote_reach(&child, &shas, Some(false)).await;
                (reach, RECHECKS.with(std::cell::Cell::get))
            })
            .await;
        let local = Some(false);
        assert_eq!(reach, vec![Some(true), local, local, local, local]);
        assert_eq!(reads, 1, "one --contains read for the whole page");
    }

    /// The checkout lands, then the folder's gitfile is re-pointed at the host: the
    /// read-back's resolve refuses, so the pick says it couldn't read back.
    #[tokio::test]
    async fn pick_reports_a_read_back_it_could_not_make() {
        let f = gitlink_fixture("pick-read-back-unread").await;
        let host_git = abs_git_path(&f.host, "--git-dir").await;
        let landed: PickLandedHook = {
            let (sub, host_git) = (f.sub.clone(), host_git.clone());
            Arc::new(move || {
                let gitfile = Path::new(&sub).join(".git");
                let body = format!("gitdir: {host_git}\n");
                Box::pin(async move {
                    std::fs::write(gitfile, body).unwrap();
                })
            })
        };
        let outcome = PICK_LANDED_HOOK
            .scope(landed, pick(&f.host, &f.c1, &f.c0))
            .await
            .unwrap();
        let SubmodulePickOutcome::ReadBackFailed { sha, reason } = &outcome else {
            panic!("{outcome:?}")
        };
        assert_eq!(sha, &f.c1);
        assert!(reason.contains("own git directory"), "{reason}");
    }

    /// After the checkout the child's HEAD moves and the host's index turns to garbage:
    /// an unread pointer under a moved HEAD is a read-back failure, never "no gitlink".
    #[tokio::test]
    async fn pick_never_reads_a_failed_pointer_read_as_no_gitlink() {
        let f = gitlink_fixture("pick-pointer-unread").await;
        let index = git_path(&f.host, "index").await;
        let landed: PickLandedHook = {
            let (sub, c2, index) = (f.sub.clone(), f.c2.clone(), index.clone());
            Arc::new(move || {
                let (sub, c2, index) = (sub.clone(), c2.clone(), index.clone());
                Box::pin(async move {
                    git(&sub, &["checkout", "-q", "--detach", &c2]).await;
                    std::fs::write(&index, "garbage").unwrap();
                })
            })
        };
        let outcome = PICK_LANDED_HOOK
            .scope(landed, pick(&f.host, &f.c1, &f.c0))
            .await
            .unwrap();
        let SubmodulePickOutcome::ReadBackFailed { sha, reason } = &outcome else {
            panic!("{outcome:?}")
        };
        assert_eq!(sha, &f.c1);
        assert!(reason.contains("index"), "{reason}");
    }

    /// `deinit -f` right after the checkout empties the folder and keeps the module's
    /// HEAD: read through the folder, the pick says the checkout is gone.
    #[tokio::test]
    async fn pick_reports_a_submodule_deinitialized_after_its_checkout() {
        let f = gitlink_fixture("pick-deinit-after").await;
        let landed: PickLandedHook = {
            let host = f.host.clone();
            Arc::new(move || {
                let host = host.clone();
                Box::pin(async move {
                    git(
                        &host,
                        &["submodule", "deinit", "-q", "-f", "--", "libs/dep"],
                    )
                    .await;
                })
            })
        };
        let outcome = PICK_LANDED_HOOK
            .scope(landed, pick(&f.host, &f.c1, &f.c0))
            .await
            .unwrap();
        assert_eq!(
            outcome,
            SubmodulePickOutcome::MovedAfter {
                sha: f.c1.clone(),
                pointer: Some(f.c1.clone()),
                head: None,
            }
        );
    }

    /// A lock in the child's git dir refuses the first run; during the wait the holder
    /// finishes and commits on the detached HEAD. HEAD is read after the wait, so no
    /// retry runs and the outside commit stays HEAD.
    #[tokio::test]
    async fn detach_leaves_a_head_that_moved_during_the_lock_wait() {
        let f = gitlink_fixture("detach-lock-wait").await;
        git(&f.sub, &["checkout", "-q", "--detach", &f.c2]).await;
        let lock = Path::new(&abs_git_path(&f.sub, "--git-dir").await).join("index.lock");
        std::fs::write(&lock, "").unwrap();
        let waited: PickLandedHook = {
            let (sub, lock) = (f.sub.clone(), lock.clone());
            Arc::new(move || {
                let (sub, lock) = (sub.clone(), lock.clone());
                Box::pin(async move {
                    std::fs::remove_file(&lock).unwrap();
                    commit_in(&sub, "late.txt", "late").await;
                })
            })
        };
        let child = child_at(&f.sub).await;
        let out = DETACH_WAIT_HOOK
            .scope(waited, detach_in(&f.sub, &child, &f.c1))
            .await
            .unwrap();
        assert_eq!(out.code, 128, "{}", out.stderr);
        assert_eq!(
            git(&f.sub, &["log", "-1", "--format=%s"]).await.trim(),
            "late"
        );
    }

    /// A path the target adds that isn't UTF-8, built from a C-quoted index line (the
    /// one way Windows holds one): the ignored-file prediction is unanswered, not clear.
    #[tokio::test]
    async fn ignored_in_the_way_never_probes_a_path_that_is_not_utf8() {
        let f = gitlink_fixture("ignored-not-utf8").await;
        let from = head_of(&f.sub).await;
        let blob = git(&f.sub, &["rev-parse", "HEAD:a.txt"]).await;
        let info = format!("100644 {}\t\"\\377bad.log\"\n", blob.trim());
        crate::git::runner::run_git_raw_input(
            Some(&f.sub),
            &["update-index", "--index-info"],
            Some(&info),
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap()
        .exit_verdict()
        .unwrap();
        let c = [
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            "raw",
        ];
        git(&f.sub, &c).await;
        let target = head_of(&f.sub).await;
        let fact = ignored_in_the_way(&child_at(&f.sub).await, &from, &target).await;
        assert!(
            matches!(&fact, OverwriteFact::Failed(reason) if reason.contains("UTF-8")),
            "{fact:?}"
        );
    }

    /// `x`, whose describe is literally `y`, beside a sibling named `x (y)`: both print a
    /// line starting `x (y)`, and index order tells them apart.
    #[tokio::test]
    async fn list_pairs_status_lines_with_the_index_in_order() {
        let (_dir, host, dep) = host_with_submodule("list-order").await;
        git(&host, &["submodule", "add", "-q", &dep, "x (y)"]).await;
        git(&host, &["submodule", "add", "-q", &dep, "x"]).await;
        git(&format!("{host}/x"), &["tag", "y"]).await;
        git(&host, &["commit", "-qm", "x"]).await;
        let listed = list_submodules(&host).await.unwrap();
        let rows: Vec<(&str, &str)> = listed
            .iter()
            .map(|sub| (sub.path.as_str(), sub.describe.as_str()))
            .collect();
        assert!(rows.contains(&("x", "y")), "{rows:?}");
        assert!(
            rows.iter()
                .any(|(path, describe)| *path == "x (y)" && *describe != "y"),
            "{rows:?}"
        );
    }

    /// A gitlink whose path isn't UTF-8, built from a C-quoted index line (the one way
    /// Windows holds one): the list fails rather than name a lossy path.
    #[tokio::test]
    async fn list_refuses_a_gitlink_path_that_is_not_utf8() {
        let (_dir, host, _dep) = host_with_submodule("list-not-utf8").await;
        let sha = head_of(&sub_dir(&host)).await;
        let info = format!("160000 {sha}\t\"\\377bad\"\n");
        crate::git::runner::run_git_raw_input(
            Some(&host),
            &["update-index", "--index-info"],
            Some(&info),
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap()
        .exit_verdict()
        .unwrap();
        let err = list_submodules(&host).await.unwrap_err();
        assert!(
            matches!(&err, AppError::InvalidArgument(message) if message
                == "Couldn't read the submodules: git listed a submodule path that isn't UTF-8."),
            "{err:?}"
        );
    }

    #[test]
    fn ignored_listing_fails_on_a_path_that_is_not_utf8() {
        assert_eq!(
            ignored_listed(b"a.log\0nr/\0".to_vec()),
            Ok(vec!["a.log".to_string(), "nr".to_string()])
        );
        assert_eq!(
            ignored_listed(b"a.log\0\xffbad.log\0".to_vec()),
            Err("git listed a path that isn't UTF-8".to_string())
        );
    }

    /// HEAD naming an object the repository doesn't hold, or a tree: the read couldn't
    /// confirm a commit, so it is `Unread`, never `At`.
    #[tokio::test]
    async fn head_read_back_confirms_head_names_a_commit() {
        let f = gitlink_fixture("head-not-a-commit").await;
        let child = child_at(&f.sub).await;
        let folder = Path::new(&f.sub);
        let parent = folder.parent().unwrap().to_string_lossy().into_owned();
        let head_file = Path::new(&abs_git_path(&f.sub, "--git-dir").await).join("HEAD");
        let read = || head_read_back(&parent, folder, &child);
        assert_eq!(read().await, HeadRead::At(f.c2.clone()));
        let missing = "0123456789abcdef0123456789abcdef01234567";
        std::fs::write(&head_file, format!("{missing}\n")).unwrap();
        assert_eq!(
            read().await,
            HeadRead::Unread(format!(
                "its HEAD names {}, which this repository doesn't hold",
                short_oid(missing)
            ))
        );
        let tree = git(&f.sub, &["rev-parse", &format!("{}^{{tree}}", f.c2)]).await;
        std::fs::write(&head_file, tree).unwrap();
        assert!(
            matches!(read().await, HeadRead::Unread(line) if line.contains("expected commit type")),
            "a tree"
        );
    }

    /// An already-current pick whose pointer or folder HEAD moves during its probes
    /// touched nothing, so it answers `Changed`, never `Set`.
    #[tokio::test]
    async fn pick_already_current_answers_changed_when_either_value_moves() {
        for arm in ["pointer", "head"] {
            let f = gitlink_fixture(&format!("pick-current-{arm}")).await;
            stage_gitlink(&f.host, &f.c2).await;
            assert!(
                matches!(
                    pick(&f.host, &f.c2, &f.c2).await.unwrap(),
                    SubmodulePickOutcome::Set {
                        checkout: SubmodulePickMove::AlreadyThere,
                        ..
                    }
                ),
                "{arm}: the pick is already current"
            );
            let moved: PickLandedHook = {
                let (host, sub, c1) = (f.host.clone(), f.sub.clone(), f.c1.clone());
                Arc::new(move || {
                    let (host, sub, c1) = (host.clone(), sub.clone(), c1.clone());
                    Box::pin(async move {
                        if arm == "pointer" {
                            stage_gitlink(&host, &c1).await;
                        } else {
                            git(&sub, &["checkout", "-q", "--detach", &c1]).await;
                        }
                    })
                })
            };
            let outcome = PRE_CHECKOUT_HOOK
                .scope(moved, pick(&f.host, &f.c2, &f.c2))
                .await
                .unwrap();
            assert_eq!(outcome, SubmodulePickOutcome::Changed, "{arm}");
        }
    }

    /// A lock refuses the pick's checkout, and during the wait the absorbed submodule
    /// is deinit-ed, which keeps the held repository's HEAD. The folder's HEAD is read
    /// after the wait, so no retry runs: the held HEAD stays, the folder stays empty,
    /// and the checkout failed with git's lock line (nothing was staged).
    #[tokio::test]
    async fn pick_never_retries_into_a_folder_emptied_during_the_lock_wait() {
        let f = gitlink_fixture("detach-wait-deinit").await;
        let module = abs_git_path(&f.sub, "--git-dir").await;
        let lock = Path::new(&module).join("index.lock");
        let locked: PickLandedHook = {
            let lock = lock.clone();
            Arc::new(move || {
                let lock = lock.clone();
                Box::pin(async move { std::fs::write(&lock, "").unwrap() })
            })
        };
        let waited: PickLandedHook = {
            let (host, lock) = (f.host.clone(), lock.clone());
            Arc::new(move || {
                let (host, lock) = (host.clone(), lock.clone());
                Box::pin(async move {
                    std::fs::remove_file(&lock).unwrap();
                    let deinit = ["submodule", "deinit", "-q", "-f", "--", "libs/dep"];
                    git(&host, &deinit).await;
                })
            })
        };
        let picked = DETACH_WAIT_HOOK.scope(waited, pick(&f.host, &f.c1, &f.c0));
        let outcome = PRE_CHECKOUT_HOOK.scope(locked, picked).await.unwrap();
        assert_eq!(
            git(&module, &["rev-parse", "HEAD"]).await.trim(),
            f.c2,
            "no retry moved the held repository"
        );
        let left = std::fs::read_dir(&f.sub).unwrap().count();
        assert_eq!(left, 0, "the folder stays empty");
        assert!(
            matches!(&outcome, SubmodulePickOutcome::CheckoutFailed { reason }
                if reason.contains("index.lock")),
            "{outcome:?}"
        );
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c0), "nothing staged");
    }

    #[tokio::test]
    async fn fetch_reads_the_only_remote_when_it_is_not_origin() {
        let f = gitlink_fixture("fetch-sole-remote").await;
        git(&f.sub, &["remote", "rename", "origin", "up"]).await;
        git(&f.sub, &["checkout", "-q", "--detach"]).await;
        let late = commit_in(&f.dep, "late.txt", "late").await;
        git_submodule_fetch_core(&AppState::default(), &f.host, "libs/dep", false)
            .await
            .unwrap();
        let fetched = git(&f.sub, &["rev-parse", "refs/remotes/up/main"]).await;
        assert_eq!(fetched.trim(), late);
    }

    #[tokio::test]
    async fn pick_checkout_refusal_tells_ignored_files_from_untracked_ones() {
        let f = gitlink_fixture("pick-ignored-kind").await;
        let sub = Path::new(&f.sub);
        std::fs::write(sub.join("plain.txt"), "theirs").unwrap();
        let target = commit_in(&f.sub, "ign.txt", "adds two").await;
        git(&f.sub, &["checkout", "-q", "--detach", &f.c2]).await;
        let exclude = git_path(&f.sub, "info/exclude").await;
        std::fs::create_dir_all(exclude.parent().unwrap()).unwrap();
        std::fs::write(&exclude, "ign.txt\n").unwrap();
        std::fs::write(sub.join("ign.txt"), "mine").unwrap();
        let child = child_at(&f.sub).await;
        let refused = |why, paths: &[&str]| SubmodulePickOutcome::Blocked {
            why,
            reason: Some(WOULD_OVERWRITE_HEADERS[1].0.to_string()),
            paths: paths.iter().map(|path| path.to_string()).collect(),
        };
        let moved = detach_in(&f.sub, &child, &target).await;
        assert_eq!(
            pick_checkout_verdict(&child, Some(f.c2.as_str()), moved).await,
            refused(SubmodulePickBlock::IgnoredInTheWay, &["ign.txt"]),
            "only an ignored file"
        );
        std::fs::write(sub.join("plain.txt"), "mine").unwrap();
        let moved = detach_in(&f.sub, &child, &target).await;
        assert_eq!(
            pick_checkout_verdict(&child, Some(f.c2.as_str()), moved).await,
            refused(
                SubmodulePickBlock::UntrackedInTheWay,
                &["ign.txt", "plain.txt"]
            ),
            "an untracked file beside it"
        );
    }

    #[tokio::test]
    async fn ignored_in_the_way_skips_candidates_still_in_the_index() {
        let f = gitlink_fixture("ignored-tracked").await;
        let sub = Path::new(&f.sub);
        std::fs::write(sub.join(".gitignore"), "*.log\n").unwrap();
        std::fs::write(sub.join("t.log"), "tracked").unwrap();
        git(&f.sub, &["add", "-f", ".gitignore", "t.log"]).await;
        let c = [
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            "x0",
        ];
        git(&f.sub, &c).await;
        let from = head_of(&f.sub).await;
        git(&f.sub, &["rm", "-q", "t.log"]).await;
        std::fs::write(sub.join("x.log"), "theirs").unwrap();
        git(&f.sub, &["add", "-f", "x.log"]).await;
        let c = [
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-qm",
            "x1",
        ];
        git(&f.sub, &c).await;
        let target = head_of(&f.sub).await;
        git(&f.sub, &["checkout", "-q", "--detach", &from]).await;
        std::fs::write(sub.join("x.log"), "mine").unwrap();
        assert!(
            sub.join("t.log").exists(),
            "the tracked candidate is on disk"
        );
        assert_eq!(
            ignored_in_the_way(&child_at(&f.sub).await, &from, &target).await,
            OverwriteFact::Blocked(
                SubmodulePickBlock::IgnoredInTheWay,
                vec!["x.log".to_string()]
            )
        );
    }

    /// A no-path update whose settling walk meets a sibling re-pointed at the parent's
    /// own git dir refuses there, and runs no git in it.
    #[tokio::test]
    async fn update_all_refuses_a_sibling_that_names_the_parents_git_dir() {
        let (_dir, host, _dep) = host_with_submodule("update-all-gate").await;
        let state = AppState::default();
        git_submodule_add_core(
            &state,
            host.clone(),
            "../dep".into(),
            Some("libs/b".into()),
            None,
        )
        .await
        .unwrap();
        git(&host, &["commit", "-qm", "add b"]).await;
        let dep = sub_dir(&host);
        let (head, dep_head) = (head_of(&host).await, head_of(&dep).await);
        let b = Path::new(&host)
            .join("libs/b")
            .to_string_lossy()
            .into_owned();
        let own = abs_git_path(&host, "--git-dir").await;
        let repoint: PickLandedHook = Arc::new(move || {
            let (b, own) = (b.clone(), own.clone());
            Box::pin(async move { point_gitfile(&b, &own) })
        });
        let update = git_submodule_update_core(&state, host.clone(), None, true);
        let e = UPDATE_SETTLE_HOOK.scope(repoint, update).await.unwrap_err();
        assert!(
            e.to_string()
                .contains("Updated the submodules, but not the ones inside libs/b: "),
            "{e}"
        );
        let symbolic = git(&host, &["symbolic-ref", "HEAD"]).await;
        assert_eq!(symbolic.trim(), "refs/heads/main", "the parent's HEAD");
        assert_eq!(head_of(&host).await, head);
        assert_eq!(head_of(&dep).await, dep_head, "the other submodule");
    }

    /// A no-path update whose settling walk meets a later submodule whose path now runs
    /// through a directory link to an outside repository skips it: no git runs there.
    #[tokio::test]
    async fn update_all_skips_a_submodule_whose_path_runs_through_a_link() {
        let (dir, host, _dep) = host_with_submodule("update-all-link").await;
        let state = AppState::default();
        git_submodule_add_core(
            &state,
            host.clone(),
            "../dep".into(),
            Some("vendor/b".into()),
            None,
        )
        .await
        .unwrap();
        git(&host, &["commit", "-qm", "add b"]).await;
        // A clone of the host, its submodules uninitialized: a settling leg run inside
        // it would clone them.
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        let foreign = outside.join("b").to_string_lossy().into_owned();
        git(&host, &["clone", "-q", &host, &foreign]).await;
        let vendor = Path::new(&host).join("vendor");
        let parked = Path::new(&host).join("vendor-parked");
        let swap: PickLandedHook = Arc::new(move || {
            let (vendor, parked, outside) = (vendor.clone(), parked.clone(), outside.clone());
            Box::pin(async move {
                std::fs::rename(&vendor, &parked).unwrap();
                link_dir(&vendor, &outside);
            })
        });
        let update = git_submodule_update_core(&state, host.clone(), None, true);
        UPDATE_SETTLE_HOOK.scope(swap, update).await.unwrap();
        assert!(
            !exists(&foreign, "libs/dep/dep.txt"),
            "the outside repository stays untouched"
        );
        let child = Path::new(&host).join("vendor/b");
        assert_eq!(
            ChildRepo::resolve(&host, &child).await.unwrap_err(),
            (SubmoduleCheckout::Replaced, None)
        );
    }

    /// A pick whose HEAD is already at `sha` stages only the pointer, after reading the
    /// folder again: a HEAD moved or a folder emptied during the probes is `Changed`,
    /// with the index untouched.
    #[tokio::test]
    async fn pick_already_there_answers_changed_when_the_folder_moves_before_the_stage() {
        for arm in ["head", "deinit"] {
            let f = gitlink_fixture(&format!("pick-there-{arm}")).await;
            assert_eq!(
                pick_read(&f.host, &f.c2).await.plan,
                ready(SubmodulePickMove::AlreadyThere),
                "{arm}"
            );
            let before = pointer_row(&f.host).await;
            let moved: PickLandedHook = {
                let (host, sub, c1) = (f.host.clone(), f.sub.clone(), f.c1.clone());
                Arc::new(move || {
                    let (host, sub, c1) = (host.clone(), sub.clone(), c1.clone());
                    Box::pin(async move {
                        if arm == "head" {
                            git(&sub, &["checkout", "-q", "--detach", &c1]).await;
                        } else {
                            git(&host, &["submodule", "deinit", "-q", "-f", "libs/dep"]).await;
                        }
                    })
                })
            };
            let outcome = PRE_CHECKOUT_HOOK
                .scope(moved, pick(&f.host, &f.c2, &f.c0))
                .await
                .unwrap();
            assert_eq!(outcome, SubmodulePickOutcome::Changed, "{arm}");
            assert_eq!(pointer_row(&f.host).await, before, "{arm}: the index");
        }
    }

    /// Only ' ' and '+' rows carry a describe, so a '-' or 'U' row's rest is its path
    /// exactly: `vendor (old)` printed for the index's `vendor` is a mismatch.
    #[test]
    fn status_lines_pair_only_with_their_own_path() {
        let sha = "1".repeat(40);
        let rows: [(char, &str, &str, Option<&str>); 11] = [
            (' ', "vendor", "vendor", Some("")),
            (' ', "vendor (heads/main)", "vendor", Some("heads/main")),
            ('+', "vendor (v1)", "vendor", Some("v1")),
            ('-', "vendor (old)", "vendor (old)", Some("")),
            ('-', "vendor (old)", "vendor", None),
            ('U', "vendor (old)", "vendor", None),
            ('U', "vendor", "vendor", Some("")),
            (' ', "vendor (old", "vendor", None),
            (' ', "vendorx", "vendor", None),
            ('-', "vendorx", "vendor", None),
            ('?', "vendor", "vendor", None),
        ];
        for (flag, rest, path, want) in rows {
            let line = format!("{flag}{sha} {rest}\n");
            let got = paired_status(&line, path);
            assert_eq!(
                got.map(|(_, _, describe, _)| describe),
                want,
                "{line:?} against {path:?}"
            );
            if let Some((read_flag, read_sha, _, after)) = got {
                assert_eq!((read_flag, read_sha, after), (flag, sha.as_str(), ""));
            }
        }
    }

    /// A describe is a ref name or an abbreviated id and holds no space, so a row for a
    /// gitlink renamed to `x (y)` after the index read never pairs with `x`.
    #[test]
    fn status_rows_for_a_renamed_path_never_pair_with_the_old_one() {
        let sha = "1".repeat(40);
        for flag in [' ', '+'] {
            let line = format!("{flag}{sha} x (y) (heads/main)\n");
            assert_eq!(paired_status(&line, "x"), None, "{line:?} against \"x\"");
            assert_eq!(
                paired_status(&line, "x (y)"),
                Some((flag, sha.as_str(), "heads/main", "")),
                "{line:?} against \"x (y)\""
            );
        }
        let text = format!(" {sha} x (y) (heads/main)\n");
        assert_eq!(paired_rows(&text, &["x".to_string()]), None);
    }

    /// Arm (a) takes only the on-disk name `.git`: a `.Git` directory inside the folder
    /// isn't one git created.
    #[test]
    fn own_git_dir_takes_only_a_directory_spelled_dot_git() {
        let dir = temp("own-git-name");
        // A folder each: on a case-folding disk `.git` and `.Git` name one directory.
        let check = |folder: &str, name: &str| {
            let folder = dir.path().join(folder);
            let git_dir = folder.join(name);
            std::fs::create_dir_all(&git_dir).unwrap();
            child_repo::own_git_dir(&git_dir.to_string_lossy(), &folder.to_string_lossy())
        };
        assert_eq!(check("exact", ".git"), Ok(true));
        assert_eq!(check("other", ".Git"), Ok(false));
    }

    /// A folder git can't read refuses the remove as unreadable with why, never as
    /// dirty, and mutates nothing.
    #[tokio::test]
    async fn remove_refuses_a_folder_git_cannot_read_as_unreadable() {
        let (_dir, host, _dep) = host_with_submodule("remove-unreadable").await;
        let own = abs_git_path(&host, "--git-dir").await;
        point_gitfile(&sub_dir(&host), &own);
        let removed = git_submodule_remove_core(
            &AppState::default(),
            host.clone(),
            "libs/dep".into(),
            false,
            false,
        )
        .await;
        let outcome = removed.unwrap();
        assert!(!outcome.refused_dirty);
        assert_eq!(
            outcome.refused_unreadable.as_deref(),
            Some("its .git names this repository's own git directory")
        );
        assert!(!outcome.module_data_deleted);
        assert_eq!(outcome.module_data_error, None);
        let listed = git(&host, &["ls-files", "-s", "--", "libs/dep"]).await;
        assert!(listed.starts_with("160000 "), "still a submodule: {listed}");
    }

    /// Output holding the lossy marker is never compared or listed as exact. Built with
    /// a genuine U+FFFD in a name, which degrades the same way.
    #[tokio::test]
    async fn child_repo_refuses_a_printed_path_holding_the_lossy_marker() {
        let dir = temp("child-repo-lossy");
        let host = seed_repo(dir.path(), "host").await;
        let marked = seed_repo(Path::new(&host), &format!("d{LOSSY}")).await;
        assert_eq!(
            ChildRepo::resolve(&host, Path::new(&marked))
                .await
                .unwrap_err(),
            (SubmoduleCheckout::Unreadable, Some(NOT_UTF8_PATH.into()))
        );
        let plain = seed_repo(Path::new(&host), "d").await;
        ChildRepo::resolve(&host, Path::new(&plain)).await.unwrap();
    }

    #[test]
    fn a_refused_checkout_lists_only_exact_paths() {
        let header = WOULD_OVERWRITE_HEADERS[1].0.to_string();
        let owned = |paths: &[&str]| paths.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        let marked = format!("i{LOSSY}.txt");
        assert_eq!(
            exact_listing(
                header.clone(),
                owned(&["a.txt"]),
                &owned(&["a.txt"]),
                |_| true
            ),
            (header.clone(), owned(&["a.txt"]), true)
        );
        assert_eq!(
            exact_listing(
                header.clone(),
                owned(&["a.txt", &marked]),
                &owned(&["a.txt", &marked]),
                |_| true
            ),
            (
                format!("{header} {LOSSY_PATHS_LEFT_OUT}"),
                owned(&["a.txt"]),
                false
            )
        );
    }

    /// An ignored file whose name holds the marker keeps the untracked kind (its name
    /// can't be asked about) and is left out of the listed paths.
    #[tokio::test]
    async fn pick_checkout_refusal_never_asks_about_a_lossy_path() {
        let f = gitlink_fixture("pick-lossy-ignored").await;
        let name = format!("i{LOSSY}.txt");
        let target = commit_in(&f.sub, &name, "adds it").await;
        git(&f.sub, &["checkout", "-q", "--detach", &f.c2]).await;
        exclude_in(&f.sub, &name).await;
        std::fs::write(Path::new(&f.sub).join(&name), "mine").unwrap();
        let child = child_at(&f.sub).await;
        let moved = detach_in(&f.sub, &child, &target).await;
        assert_eq!(
            pick_checkout_verdict(&child, Some(f.c2.as_str()), moved).await,
            SubmodulePickOutcome::Blocked {
                why: SubmodulePickBlock::UntrackedInTheWay,
                reason: Some(format!(
                    "{} {LOSSY_PATHS_LEFT_OUT}",
                    WOULD_OVERWRITE_HEADERS[1].0
                )),
                paths: Vec::new(),
            }
        );
    }

    /// Refs and remotes whose names hold the marker never reach git: the lists leave
    /// them out, and the fetch's remote choice skips them down to `origin`.
    #[tokio::test]
    async fn lossy_ref_and_remote_names_are_left_out() {
        let f = gitlink_fixture("refs-lossy").await;
        let marked = format!("x{LOSSY}");
        git(&f.sub, &["branch", &marked]).await;
        let refs = git_submodule_refs_core(&f.host, "libs/dep").await.unwrap();
        assert_eq!(revs(&refs.branches), ["refs/heads/main"]);
        let remote = format!("up{LOSSY}");
        git(&f.sub, &["remote", "rename", "origin", &remote]).await;
        let configured = git(&f.sub, &["config", "--get", "branch.main.remote"]).await;
        assert_eq!(configured.trim(), remote, "the branch follows the rename");
        let child = child_at(&f.sub).await;
        assert_eq!(fetch_remote(&child).await.as_deref(), Some("origin"));
    }

    /// Runs the pick of `sha` against `expected` with the submodule's own working tree
    /// held, applying `during` while it waits.
    async fn pick_during_child_wait(
        f: &GitlinkFixture,
        sha: &str,
        expected: &str,
        during: impl std::future::Future<Output = ()>,
    ) -> SubmodulePickOutcome {
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
            git_submodule_set_commit_core(&state, &f.host, "libs/dep", sha, expected),
        );
        let moved = async move {
            rx.await
                .expect("the pick waits on the submodule's working tree");
            during.await;
            drop(held);
        };
        let (outcome, ()) = tokio::join!(picked, moved);
        outcome.unwrap()
    }

    #[tokio::test]
    async fn pick_rereads_pointer_and_parent_operation_after_the_child_wait() {
        let f = gitlink_fixture("pick-wait-reread").await;
        stage_gitlink(&f.host, &f.c2).await;
        let outcome = pick_during_child_wait(&f, &f.c2, &f.c2, stage_gitlink(&f.host, &f.c1)).await;
        assert_eq!(outcome, SubmodulePickOutcome::Changed, "a current pick");
        assert_eq!(
            pointer_row(&f.host).await,
            row_at(&f.c1),
            "the new pointer stays"
        );

        let head = head_of(&f.host).await;
        let merge_head = Path::new(&f.host).join(".git").join("MERGE_HEAD");
        let begin = async { std::fs::write(&merge_head, format!("{head}\n")).unwrap() };
        let outcome = pick_during_child_wait(&f, &f.c0, &f.c1, begin).await;
        assert!(
            matches!(
                &outcome,
                SubmodulePickOutcome::Blocked {
                    why: SubmodulePickBlock::MidOperation,
                    ..
                }
            ),
            "a merge begun during the wait: {outcome:?}"
        );
        assert_eq!(head_of(&f.sub).await, f.c2, "nothing checked out");
        assert_eq!(pointer_row(&f.host).await, row_at(&f.c1));
    }

    #[tokio::test]
    async fn pick_plan_reads_an_ignored_file_where_the_target_deletes() {
        let f = gitlink_fixture("pick-ignored-delete").await;
        let a = commit_in(&f.sub, "x", "x").await;
        git(&f.sub, &["checkout", "-q", "-b", "gone"]).await;
        std::fs::remove_file(Path::new(&f.sub).join("x")).unwrap();
        let b = commit_all(&f.sub, "drop x").await;
        git(&f.sub, &["checkout", "-q", "main"]).await;
        assert_eq!(head_of(&f.sub).await, a);
        git(&f.sub, &["rm", "-q", "--cached", "x"]).await;
        exclude_in(&f.sub, "x").await;
        let plan = pick_read(&f.host, &b).await.plan;
        assert_eq!(
            plan,
            plan_blocked(SubmodulePickBlock::IgnoredInTheWay, None, &["x"])
        );
        assert_checkout_agrees(&f.sub, &b, &plan, "an ignored file the target deletes").await;
        assert_eq!(read_at(&f.sub, "x"), "x");
    }

    #[tokio::test]
    async fn pick_plan_checks_ignored_files_when_sparse_has_no_patterns_file() {
        let f = gitlink_fixture("pick-sparse-no-file").await;
        git(&f.sub, &["checkout", "-q", "-b", "target"]).await;
        let t = commit_in(&f.sub, "n.txt", "n").await;
        git(&f.sub, &["checkout", "-q", "main"]).await;
        exclude_in(&f.sub, "n.txt").await;
        write_at(&f.sub, "n.txt", "local");
        git(&f.sub, &["config", "core.sparseCheckout", "true"]).await;
        assert!(!git_path(&f.sub, "info/sparse-checkout").await.exists());
        let plan = pick_read(&f.host, &t).await.plan;
        assert_eq!(
            plan,
            plan_blocked(SubmodulePickBlock::IgnoredInTheWay, None, &["n.txt"])
        );
        assert_checkout_agrees(&f.sub, &t, &plan, "sparse without a patterns file").await;
    }

    #[tokio::test]
    async fn picker_reads_never_fetch_in_a_partial_clone() {
        allow_file_submodules();
        let dir = temp("pick-partial");
        let src = seed_repo(dir.path(), "src").await;
        let old = commit_in(&src, "f.txt", "v1").await;
        let at = commit_in(&src, "f.txt", "v2").await;
        let bare = dir.path().join("bare.git").to_string_lossy().into_owned();
        git(&src, &["clone", "-q", "--bare", &src, &bare]).await;
        git(&bare, &["config", "uploadpack.allowFilter", "true"]).await;
        let host = seed_repo(dir.path(), "host").await;
        let slashed = bare.replace('\\', "/");
        let url = if slashed.starts_with('/') {
            format!("file://{slashed}")
        } else {
            format!("file:///{slashed}")
        };
        let sub = sub_dir(&host);
        git(&host, &["clone", "-q", "--filter=blob:none", &url, &sub]).await;
        stage_gitlink(&host, &at).await;
        let late = commit_in(&src, "late.txt", "late").await;
        git(&src, &["push", "-q", &bare, "HEAD"]).await;

        let read = pick_read(&host, &late).await;
        assert_eq!(
            read.plan,
            plan_blocked(SubmodulePickBlock::NotFetched, None, &[])
        );
        assert!(
            git_submodule_commits_core(&host, "libs/dep", &late, 0, 10, None)
                .await
                .is_err(),
            "the page read fails without the commit"
        );
        let present = run_git_raw_env(
            Some(&sub),
            &["cat-file", "-e", &late],
            &NO_LAZY_FETCH,
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_ne!(present.code, 0, "the commit is still absent");
        assert_eq!(
            pick_read(&host, &old).await.plan,
            ready(SubmodulePickMove::CheckOut),
            "a local commit whose blobs are absent still plans"
        );
    }

    #[tokio::test]
    async fn pick_plan_reads_a_corrupt_object_as_check_failed() {
        let f = gitlink_fixture("pick-corrupt").await;
        // Off main's history, which the gate's status walks for ahead/behind.
        git(&f.sub, &["checkout", "-q", "-b", "side"]).await;
        let side = commit_in(&f.sub, "side.txt", "side").await;
        git(&f.sub, &["checkout", "-q", "main"]).await;
        let object = git_path(&f.sub, &format!("objects/{}/{}", &side[..2], &side[2..])).await;
        let mut perms = std::fs::metadata(&object).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&object, perms).unwrap();
        std::fs::write(&object, "garbage").unwrap();
        match pick_read(&f.host, &side).await.plan {
            SubmodulePickPlan::Blocked {
                why: SubmodulePickBlock::CheckFailed,
                reason: Some(reason),
                ..
            } => {
                assert!(reason.starts_with("error:"), "{reason}");
                assert!(reason.contains(ABSENT_OBJECT), "{reason}");
            }
            other => panic!("a corrupt object is checkFailed: {other:?}"),
        }
    }

    #[tokio::test]
    async fn pick_counts_uninitialized_nested_submodules_only_where_it_moved_them() {
        let n = nested_fixture("pick-nested-uninit").await;
        git(&n.sub, &["checkout", "-q", "--detach", &n.m1]).await;
        let m2 = commit_in(&n.sub, "other.txt", "m2").await;
        // A ref keeps m2 named once the next pick moves off it.
        git(&n.sub, &["tag", "m2"]).await;
        git(&n.sub, &["checkout", "-q", "--detach", &n.m1]).await;
        git(&n.sub, &["submodule", "deinit", "-q", "-f", "deep/leaf"]).await;
        let untouched = pick(&n.host, &m2, &n.m1).await.unwrap();
        assert_eq!(
            untouched,
            SubmodulePickOutcome::Set {
                sha: m2.clone(),
                checkout: SubmodulePickMove::CheckOut,
                nested_left: Some(0),
            },
            "a nested submodule the pick didn't move"
        );
        let moved = pick(&n.host, &n.m0, &m2).await.unwrap();
        assert_eq!(
            moved,
            SubmodulePickOutcome::Set {
                sha: n.m0.clone(),
                checkout: SubmodulePickMove::CheckOut,
                nested_left: Some(1),
            },
            "a nested submodule the pick moved"
        );
    }

    #[test]
    fn submodule_operation_names_its_arm() {
        let clear = crate::git::types::RepoOpState {
            merging: false,
            rebasing: false,
            cherry_picking: false,
            reverting: false,
            edit_paused: false,
            rebase_stop: None,
        };
        assert_eq!(mid_op_name(&clear), None);
        for (set, name) in [
            (
                (|s: &mut crate::git::types::RepoOpState| s.merging = true)
                    as fn(&mut crate::git::types::RepoOpState),
                "a merge",
            ),
            (|s| s.rebasing = true, "a rebase"),
            (|s| s.cherry_picking = true, "a cherry-pick"),
            (|s| s.reverting = true, "a revert"),
        ] {
            let mut state = clear.clone();
            set(&mut state);
            assert_eq!(mid_op_name(&state), Some(name));
        }
    }

    #[tokio::test]
    async fn pick_plan_names_the_submodules_operation() {
        let f = gitlink_fixture("pick-sub-merge").await;
        let merge_head = git_path(&f.sub, "MERGE_HEAD").await;
        std::fs::write(&merge_head, format!("{}\n", f.c1)).unwrap();
        assert_eq!(
            pick_read(&f.host, &f.c1).await.plan,
            plan_blocked(
                SubmodulePickBlock::SubmoduleMidOperation,
                Some("a merge"),
                &[]
            )
        );
    }

    #[test]
    fn would_overwrite_reports_the_highest_kind_and_every_path() {
        let stderr = format!(
            "{}\n\tu.txt\n{}\n\tt.txt\nAborting\n",
            WOULD_OVERWRITE_HEADERS[1].0, WOULD_OVERWRITE_HEADERS[0].0
        );
        assert_eq!(
            would_overwrite(&stderr),
            Some((
                SubmodulePickBlock::WouldOverwrite,
                WOULD_OVERWRITE_HEADERS[1].0.to_string(),
                vec!["u.txt".to_string(), "t.txt".to_string()],
            ))
        );
    }

    #[tokio::test]
    async fn fetch_uses_the_branchs_remote_and_reports_shallowness_after() {
        let f = gitlink_fixture("fetch-branch-remote").await;
        let up = Path::new(&f.host).parent().unwrap().join("up");
        let up = up.to_string_lossy().into_owned();
        git(&f.host, &["clone", "-q", &f.dep, &up]).await;
        let only_up = commit_in(&up, "up.txt", "up").await;
        git(&f.sub, &["remote", "add", "up", &up]).await;
        git(&f.sub, &["config", "branch.main.remote", "up"]).await;
        let fetched = git_submodule_fetch_core(&AppState::default(), &f.host, "libs/dep", false)
            .await
            .unwrap();
        assert_eq!(
            fetched,
            SubmoduleFetchResult {
                shallow: Some(false)
            }
        );
        let present = format!("{only_up}^{{commit}}");
        git(&f.sub, &["cat-file", "-e", &present]).await;
    }

    #[test]
    fn fetch_result_wire_shape() {
        use serde_json::json;
        for (shallow, wire) in [
            (Some(true), json!({ "shallow": true })),
            (None, json!({ "shallow": null })),
        ] {
            assert_eq!(
                serde_json::to_value(SubmoduleFetchResult { shallow }).unwrap(),
                wire
            );
        }
        let blocked = plan_blocked(SubmodulePickBlock::UntrackedInTheWay, None, &["a"]);
        let text = serde_json::to_string(&blocked).unwrap();
        assert!(text.contains("\"untrackedInTheWay\""), "{text}");
        for snake in [
            "untracked_in_the_way",
            "ignored_in_the_way",
            "UntrackedInTheWay",
        ] {
            assert!(!text.contains(snake), "{snake}");
        }
    }

    /// The no-path settling walk reads the index's gitlinks, never `submodule status`,
    /// which dies on a gitlink no `.gitmodules` maps as it does on a path through a
    /// symlink: one added after the parent's update, with no folder, is skipped.
    #[tokio::test]
    async fn update_all_walks_the_index_never_submodule_status() {
        let (_dir, host, _dep) = host_with_submodule("update-all-index").await;
        let sha = head_of(&sub_dir(&host)).await;
        let unmapped: PickLandedHook = {
            let host = host.clone();
            Arc::new(move || {
                let (host, sha) = (host.clone(), sha.clone());
                Box::pin(async move {
                    let info = format!("160000,{sha},vendor/ghost");
                    git(&host, &["update-index", "--add", "--cacheinfo", &info]).await;
                })
            })
        };
        let state = AppState::default();
        let update = git_submodule_update_core(&state, host.clone(), None, true);
        UPDATE_SETTLE_HOOK.scope(unmapped, update).await.unwrap();
        let status = run_git_raw(Some(&host), &["submodule", "status"], TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        assert_ne!(
            status.code, 0,
            "the premise: `submodule status` refuses the unmapped gitlink"
        );
        let subs = list_submodules(&host).await.unwrap();
        let ghost = subs.iter().find(|sub| sub.path == "vendor/ghost").unwrap();
        assert_eq!(ghost.status, "unreadable", "the list reads it path by path");
    }

    /// A status probe that fails refuses the remove as unreadable with git's reason,
    /// never as dirty, and mutates nothing.
    #[tokio::test]
    async fn remove_refuses_as_unreadable_when_the_status_probe_fails() {
        let (_dir, host, _dep) = host_with_submodule("remove-status-fails").await;
        let git_dir = abs_git_path(&sub_dir(&host), "--git-dir").await;
        std::fs::write(Path::new(&git_dir).join("index"), b"junk").unwrap();
        let removed = git_submodule_remove_core(
            &AppState::default(),
            host.clone(),
            "libs/dep".into(),
            false,
            false,
        )
        .await;
        let outcome = removed.unwrap();
        assert!(!outcome.refused_dirty);
        let why = outcome.refused_unreadable.expect("refused as unreadable");
        assert!(!why.is_empty() && !why.ends_with('.'), "{why}");
        assert!(!outcome.module_data_deleted);
        let listed = git(&host, &["ls-files", "-s", "--", "libs/dep"]).await;
        assert!(listed.starts_with("160000 "), "still a submodule: {listed}");
    }

    /// Each row consumes its paired path by its exact bytes, so a newline inside one
    /// leaves its sibling paired; a row short, long or left over fails the read.
    #[test]
    fn status_rows_consume_a_path_holding_a_newline() {
        let sha = "1".repeat(40);
        let paths = ["a\nb".to_string(), "lib".to_string()];
        let text = format!("-{sha} a\nb\n {sha} lib (heads/main)\n");
        assert_eq!(
            paired_rows(&text, &paths),
            Some(vec![
                ('-', sha.as_str(), ""),
                (' ', sha.as_str(), "heads/main")
            ])
        );
        for bad in [
            format!("{text}x"),
            format!("-{sha} a\n"),
            text.replace("a\nb", "a\nc"),
            text.replace("main)\n", "main)"),
        ] {
            assert_eq!(paired_rows(&bad, &paths), None, "{bad:?}");
        }
    }

    /// Git for Windows refuses a path holding a newline under its default
    /// `core.protectNTFS`, so the real listing runs where such a repository arises.
    #[cfg(unix)]
    #[tokio::test]
    async fn submodule_list_reads_a_path_holding_a_newline() {
        let dir = temp("list-lf-path");
        let host = seed_repo(dir.path(), "host").await;
        let sha = head_of(&host).await;
        for (name, path) in [("ab", "a\nb"), ("lib", "lib")] {
            for (field, value) in [("path", path), ("url", "./x")] {
                let key = format!("submodule.{name}.{field}");
                git(&host, &["config", "-f", ".gitmodules", &key, value]).await;
            }
            let info = format!("160000,{sha},{path}");
            git(&host, &["update-index", "--add", "--cacheinfo", &info]).await;
        }
        let listed = list_submodules(&host).await.unwrap();
        let rows: Vec<_> = listed
            .iter()
            .map(|s| (s.path.as_str(), s.name.as_str(), s.status.as_str()))
            .collect();
        assert_eq!(
            rows,
            [
                ("a\nb", "ab", "uninitialized"),
                ("lib", "lib", "uninitialized")
            ]
        );
    }

    /// git skips an `update = none` submodule whole ("Skipping submodule"), so a remote
    /// update of an empty one succeeds and initializes nothing, targeted or not.
    #[tokio::test]
    async fn remote_update_skips_an_empty_update_none_submodule() {
        let (_dir, host, _dep) = host_with_submodule("update-none-empty").await;
        git(&host, &["submodule", "deinit", "-q", "-f", "libs/dep"]).await;
        let none = [
            "config",
            "-f",
            ".gitmodules",
            "submodule.libs/dep.update",
            "none",
        ];
        git(&host, &none).await;
        for path in [Some("libs/dep".to_string()), None] {
            git_submodule_update_core(&AppState::default(), host.clone(), path.clone(), true)
                .await
                .unwrap_or_else(|e| panic!("{path:?}: {e}"));
            assert!(!exists(&host, "libs/dep/.git"), "{path:?}");
        }
    }

    /// The nested leg skips an `update = none` submodule too: its own uninitialized
    /// submodule stays so, targeted or not.
    #[tokio::test]
    async fn remote_update_leaves_an_update_none_submodules_nested_ones_alone() {
        let f = nested_fixture("update-none-nested").await;
        git(&f.sub, &["submodule", "deinit", "-q", "-f", "deep/leaf"]).await;
        let none = [
            "config",
            "-f",
            ".gitmodules",
            "submodule.libs/dep.update",
            "none",
        ];
        git(&f.host, &none).await;
        for path in [Some("libs/dep".to_string()), None] {
            git_submodule_update_core(&AppState::default(), f.host.clone(), path.clone(), true)
                .await
                .unwrap_or_else(|e| panic!("{path:?}: {e}"));
            assert!(!exists(&f.sub, "deep/leaf/.git"), "{path:?}");
        }
    }

    /// With the worktree's `.gitmodules` deleted, git reads `update = none` from the
    /// index's copy and skips the submodule, so the nested leg skips it too.
    #[tokio::test]
    async fn remote_update_reads_update_none_from_the_index_copy() {
        let f = nested_fixture("update-none-index").await;
        git(&f.sub, &["submodule", "deinit", "-q", "-f", "deep/leaf"]).await;
        let none = [
            "config",
            "-f",
            ".gitmodules",
            "submodule.libs/dep.update",
            "none",
        ];
        git(&f.host, &none).await;
        git(&f.host, &["add", ".gitmodules"]).await;
        std::fs::remove_file(Path::new(&f.host).join(".gitmodules")).unwrap();
        for path in [Some("libs/dep".to_string()), None] {
            git_submodule_update_core(&AppState::default(), f.host.clone(), path.clone(), true)
                .await
                .unwrap_or_else(|e| panic!("{path:?}: {e}"));
            assert!(!exists(&f.sub, "deep/leaf/.git"), "{path:?}");
        }
    }

    /// The nested leg follows the children git's update left active: `submodule.active`
    /// picking one child while the other is turned off leaves the other's nested module
    /// uninitialized, as git leaves the child; turned off alone, or named, git activates
    /// it again and its nested module settles.
    #[tokio::test]
    async fn remote_update_settles_nested_modules_only_in_active_children() {
        let f = nested_fixture("update-inactive").await;
        let state = AppState::default();
        let a = Some("libs/a".to_string());
        git_submodule_add_core(&state, f.host.clone(), "../mid".into(), a, None)
            .await
            .unwrap();
        git(&f.host, &["commit", "-qm", "add a"]).await;
        let a = Path::new(&f.host)
            .join("libs/a")
            .to_string_lossy()
            .into_owned();
        let dep_active = ["config", "--get", "submodule.libs/dep.active"];
        // (case, parent config writes, the targeted path, whether dep's nested leg runs)
        type Case<'a> = (&'a str, &'a [&'a [&'a str]], Option<&'a str>, bool);
        let cases: [Case; 4] = [
            (
                "submodule.active picks a, dep turned off",
                &[
                    &["submodule.active", "libs/a"],
                    &["submodule.libs/dep.active", "false"],
                ],
                None,
                false,
            ),
            (
                "a pathspec picks a",
                &[
                    &["--unset-all", "submodule.libs/dep.active"],
                    &["--replace-all", "submodule.active", ":(glob)**/a"],
                ],
                None,
                false,
            ),
            (
                "dep turned off alone",
                &[
                    &["--unset-all", "submodule.active"],
                    &["submodule.libs/dep.active", "false"],
                ],
                None,
                true,
            ),
            (
                "dep turned off and named",
                &[&["submodule.libs/dep.active", "false"]],
                Some("libs/dep"),
                true,
            ),
        ];
        for (case, setup, path, dep_settles) in cases {
            for sub in [&f.sub, &a] {
                let deinit = ["submodule", "deinit", "-q", "-f", "deep/leaf"];
                run_git_raw(Some(sub), &deinit, TEST_GIT_HANG_GUARD)
                    .await
                    .unwrap();
            }
            for args in setup {
                let mut argv = vec!["config"];
                argv.extend_from_slice(args);
                let out = run_git_raw(Some(&f.host), &argv, TEST_GIT_HANG_GUARD)
                    .await
                    .unwrap();
                assert_eq!(out.code, 0, "{case}: {argv:?}: {}", out.stderr);
            }
            let path = path.map(str::to_string);
            git_submodule_update_core(&state, f.host.clone(), path.clone(), true)
                .await
                .unwrap_or_else(|e| panic!("{case}: {e}"));
            let left = run_git_raw(Some(&f.host), &dep_active, TEST_GIT_HANG_GUARD)
                .await
                .unwrap()
                .stdout_lossy();
            assert_eq!(
                left.trim() == "true",
                dep_settles,
                "{case}: git left {left}"
            );
            assert_eq!(exists(&f.sub, "deep/leaf/.git"), dep_settles, "{case}: dep");
            assert_eq!(exists(&a, "deep/leaf/.git"), path.is_none(), "{case}: a");
        }
    }

    /// git reads `submodule.active` only for a submodule without its own
    /// `submodule.<name>.active`, and refuses an empty value as a pathspec (measured, git
    /// 2.51.1): with every flag set the update settles; with one unset, an update naming
    /// a flagged submodule still settles, and one over every submodule fails with git's
    /// own error, as git's own update does.
    #[tokio::test]
    async fn remote_update_reads_submodule_active_only_where_git_does() {
        let f = nested_fixture("update-active-empty").await;
        let state = AppState::default();
        let a = Some("libs/a".to_string());
        git_submodule_add_core(&state, f.host.clone(), "../mid".into(), a, None)
            .await
            .unwrap();
        git(&f.host, &["commit", "-qm", "add a"]).await;
        let a = Path::new(&f.host)
            .join("libs/a")
            .to_string_lossy()
            .into_owned();
        for name in ["libs/dep", "libs/a"] {
            let key = format!("submodule.{name}.active");
            git(&f.host, &["config", key.as_str(), "true"]).await;
        }
        git(&f.host, &["config", "submodule.active", ""]).await;
        let dep = Some("libs/dep".to_string());
        for path in [None, dep.clone()] {
            deinit_leaves(&[f.sub.as_str(), a.as_str()]).await;
            git_submodule_update_core(&state, f.host.clone(), path.clone(), true)
                .await
                .unwrap_or_else(|e| panic!("every flag set, {path:?}: {e}"));
            assert!(exists(&f.sub, "deep/leaf/.git"), "{path:?}: dep's");
            let a_leaf = exists(&a, "deep/leaf/.git");
            assert_eq!(a_leaf, path.is_none(), "{path:?}: a's");
        }

        git(&f.host, &["config", "--unset", "submodule.libs/a.active"]).await;
        deinit_leaves(&[f.sub.as_str()]).await;
        git_submodule_update_core(&state, f.host.clone(), dep, true)
            .await
            .unwrap_or_else(|e| panic!("a unset, dep named: {e}"));
        assert!(exists(&f.sub, "deep/leaf/.git"), "a unset: dep's");
        let own = ["submodule", "update", "--init", "--remote"];
        let own = run_git_raw(Some(&f.host), &own, TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        assert_ne!(own.code, 0, "git's own update refuses the value");
        let first = |text: &str| {
            let line = text.lines().map(str::trim).find(|l| !l.is_empty());
            line.map(str::to_string)
        };
        match git_submodule_update_core(&state, f.host.clone(), None, true).await {
            Err(AppError::Git { stderr, .. }) => assert_eq!(first(&stderr), first(&own.stderr)),
            other => panic!("a unset, every submodule: {other:?}"),
        }
    }

    /// Takes each checkout's nested `deep/leaf` down, so the next update has to set it up
    /// again; a checkout that never set it up answers on its own.
    async fn deinit_leaves(subs: &[&str]) {
        for &sub in subs {
            let deinit = ["submodule", "deinit", "-q", "-f", "deep/leaf"];
            run_git_raw(Some(sub), &deinit, TEST_GIT_HANG_GUARD)
                .await
                .unwrap();
            assert!(!exists(sub, "deep/leaf/.git"), "{sub}: taken down");
        }
    }

    /// A `submodule.active` record with no value fails git's read of the whole list
    /// ("missing value for 'submodule.active'"), so git falls back to each submodule's
    /// URL, a valued record beside it included (measured, git 2.47.3, 2.51.1, 2.56.1): an
    /// update over every submodule settles the one with a URL and leaves the one without
    /// alone, and naming that one sets it up.
    #[tokio::test]
    async fn remote_update_reads_a_valueless_submodule_active_as_unset() {
        let f = nested_fixture("update-active-bare").await;
        let state = AppState::default();
        let a = Some("libs/a".to_string());
        git_submodule_add_core(&state, f.host.clone(), "../mid".into(), a, None)
            .await
            .unwrap();
        git(&f.host, &["commit", "-qm", "add a"]).await;
        let a = Path::new(&f.host)
            .join("libs/a")
            .to_string_lossy()
            .into_owned();
        let config = Path::new(&f.host).join(".git").join("config");
        let cases = [
            ("bare", "\tactive\n"),
            ("beside a value", "\tactive\n\tactive = libs/a\n"),
        ];
        for (case, records) in cases {
            git(&f.host, &["submodule", "deinit", "-q", "-f", "libs/a"]).await;
            deinit_leaves(&[f.sub.as_str()]).await;
            for key in [
                "submodule.libs/dep.active",
                "submodule.libs/a.active",
                "submodule.active",
            ] {
                let unset = ["config", "--unset-all", key];
                let out = run_git_raw(Some(&f.host), &unset, TEST_GIT_HANG_GUARD)
                    .await
                    .unwrap();
                assert!(matches!(out.code, 0 | 5), "{case}: {key}: {}", out.stderr);
            }
            let mut text = std::fs::read_to_string(&config).unwrap();
            text.push_str(&format!("\n[submodule]\n{records}"));
            std::fs::write(&config, text).unwrap();

            git_submodule_update_core(&state, f.host.clone(), None, true)
                .await
                .unwrap_or_else(|e| panic!("{case}, every submodule: {e}"));
            assert!(exists(&f.sub, "deep/leaf/.git"), "{case}: dep's nested leg");
            assert!(!exists(&a, ".git"), "{case}: a left alone");
            let named = Some("libs/a".to_string());
            git_submodule_update_core(&state, f.host.clone(), named, true)
                .await
                .unwrap_or_else(|e| panic!("{case}, a named: {e}"));
            assert!(exists(&a, "deep/leaf/.git"), "{case}: a named");
        }
    }

    /// `.gitmodules` is read where git reads it: the worktree file, else the index's
    /// copy, else HEAD's; nowhere (an unborn HEAD included) is no entries.
    #[tokio::test]
    async fn gitmodules_entries_fall_back_to_the_index_then_head() {
        let (dir, host, _dep) = host_with_submodule("gitmodules-fallback").await;
        let url = |entries: HashMap<String, ModuleEntry>| {
            entries.get("libs/dep").map(|entry| entry.url.clone())
        };
        let committed = url(gitmodules_entries(&host).await.unwrap());
        assert_eq!(committed.as_deref(), Some("../dep"), "the worktree file");
        let staged = [
            "config",
            "-f",
            ".gitmodules",
            "submodule.libs/dep.url",
            "../staged",
        ];
        git(&host, &staged).await;
        git(&host, &["add", ".gitmodules"]).await;
        std::fs::remove_file(Path::new(&host).join(".gitmodules")).unwrap();
        let read = url(gitmodules_entries(&host).await.unwrap());
        assert_eq!(read.as_deref(), Some("../staged"), "the index's copy");
        git(&host, &["rm", "-q", "--cached", ".gitmodules"]).await;
        let read = url(gitmodules_entries(&host).await.unwrap());
        assert_eq!(read, committed, "HEAD's copy");

        let unborn = dir.path().join("unborn");
        std::fs::create_dir_all(&unborn).unwrap();
        let unborn = unborn.to_string_lossy().into_owned();
        git(&unborn, &["init", "-q", "-b", "main", "."]).await;
        assert!(gitmodules_entries(&unborn).await.unwrap().is_empty());
    }

    /// The prefix lookup reads through the pin: a folder emptied outside the app after
    /// the gate answers from the submodule's own store, never the parent's.
    #[tokio::test]
    async fn prefix_lookup_never_answers_with_a_parent_commit_after_an_outside_deinit() {
        let f = gitlink_fixture("prefix-pinned").await;
        let child = ChildRepo::resolve(&f.host, Path::new(&f.sub))
            .await
            .unwrap();
        let own = commits_by_prefix(&child, &f.c1[..12]).await.unwrap();
        let own: Vec<&str> = own.iter().map(|c| c.hash.as_str()).collect();
        assert_eq!(own, [f.c1.as_str()]);
        git(&f.host, &["submodule", "deinit", "-q", "-f", "libs/dep"]).await;
        let parent = head_of(&f.host).await;
        assert_eq!(
            resolve_pick(&child, &parent[..12], parent.len())
                .await
                .unwrap(),
            PickTarget::NotFound
        );
    }

    /// `update --remote` takes the remote whose URL `.gitmodules` names first, then
    /// the branch's remote, then the sole remote (measured against git 2.51.1).
    #[tokio::test]
    async fn submodule_refs_default_takes_the_remote_gitmodules_names_by_url() {
        let (dir, host, _dep) = host_with_submodule("refs-default-url").await;
        let other = seed_repo(dir.path(), "other").await;
        commit_in(&other, "other.txt", "other tip").await;
        let sub = sub_dir(&host);
        git(&sub, &["remote", "add", "upstream", &other]).await;
        git(&sub, &["fetch", "-q", "upstream"]).await;
        git(&sub, &["config", "branch.main.remote", "upstream"]).await;
        let at = |remote: &str| Some(format!("refs/remotes/{remote}/main"));
        assert_eq!(default_rev_of(&host).await, at("origin"), "the URL match");
        let elsewhere = [
            "config",
            "-f",
            ".gitmodules",
            "submodule.libs/dep.url",
            "../x",
        ];
        git(&host, &elsewhere).await;
        assert_eq!(
            default_rev_of(&host).await,
            at("upstream"),
            "the branch's remote"
        );
        git(&sub, &["config", "--unset", "branch.main.remote"]).await;
        git(&sub, &["remote", "remove", "origin"]).await;
        assert_eq!(
            default_rev_of(&host).await,
            at("upstream"),
            "the sole remote"
        );
    }

    /// Two remotes carrying the `.gitmodules` URL: git takes the one it registered first,
    /// at its first key of any kind, not at its first `url` key.
    #[tokio::test]
    async fn submodule_refs_default_takes_the_first_registered_matching_remote() {
        let (_dir, host, _dep) = host_with_submodule("refs-default-order").await;
        let sub = sub_dir(&host);
        let url = git(&sub, &["config", "remote.origin.url"]).await;
        let url = url.trim_end_matches('\n');
        let config = git_path(&sub, "config").await;
        let text = std::fs::read_to_string(&config).unwrap();
        let fetch = "+refs/heads/*:refs/remotes/up/*";
        std::fs::write(
            &config,
            format!("[remote \"up\"]\n\tfetch = {fetch}\n{text}[remote \"up\"]\n\turl = {url}\n"),
        )
        .unwrap();
        git(&sub, &["fetch", "-q", "up"]).await;
        let at = |remote: &str| Some(format!("refs/remotes/{remote}/main"));
        assert_eq!(
            default_rev_of(&host).await,
            at("up"),
            "up.fetch comes first"
        );

        std::fs::write(
            &config,
            format!("{text}[remote \"up\"]\n\turl = {url}\n\tfetch = {fetch}\n"),
        )
        .unwrap();
        assert_eq!(
            default_rev_of(&host).await,
            at("origin"),
            "control: url keys in origin-first order"
        );
    }

    /// [`remote_with_url`] with `pairs` passed as `-c` config, which git scopes outside
    /// the repository the way a global config is (test builds can't reach a global one).
    async fn url_walk(
        sub: &str,
        pairs: &[&str],
        names: &[&str],
        url: &str,
    ) -> Option<Option<String>> {
        let read = |args: Vec<String>| {
            let mut argv: Vec<String> = pairs
                .iter()
                .flat_map(|pair| ["-c".to_string(), pair.to_string()])
                .collect();
            argv.extend(args);
            async move {
                let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
                run_git_raw(Some(sub), &argv, TEST_GIT_HANG_GUARD).await
            }
        };
        remote_with_url(names, url, read).await
    }

    /// A remote registered only outside the repository's config, which `remote get-url`
    /// refuses, stays in git's walk: compared by its first URL, insteadOf applied, and
    /// never by the name git prints for a remote that has no URL.
    #[tokio::test]
    async fn submodule_url_match_reads_remotes_configured_outside_the_repository() {
        let (_dir, host, _dep) = host_with_submodule("url-outside").await;
        let sub = sub_dir(&host);
        let url = git(&sub, &["config", "remote.origin.url"]).await;
        let url = url.trim_end_matches('\n');
        let names = ["review", "origin"];
        let prune = ["remote.review.prune=true"];
        let premise = ["-c", prune[0], "remote", "get-url", "--all", "review"];
        let premise = run_git_raw(Some(&sub), &premise, TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        assert_eq!(premise.code, 2, "premise: {}", premise.stderr);
        let origin = Some(Some("origin".to_string()));
        let review = Some(Some("review".to_string()));
        assert_eq!(
            url_walk(&sub, &prune, &names, url).await,
            origin,
            "a URL-less remote registered first"
        );
        let own = format!("remote.review.url={url}");
        assert_eq!(
            url_walk(&sub, &[&own], &names, url).await,
            review,
            "its own URL matches"
        );
        let short = [
            "remote.review.url=short:x",
            "url.https://h/.insteadOf=short:",
        ];
        assert_eq!(
            url_walk(&sub, &short, &["review"], "https://h/x").await,
            review,
            "insteadOf applied"
        );
        assert_eq!(
            url_walk(&sub, &prune, &["review"], "review").await,
            Some(None),
            "a URL-less remote's name is no URL"
        );
        let first = [own.as_str(), "remote.review.url=https://h/y"];
        assert_eq!(url_walk(&sub, &first, &names, url).await, review);
        let second = ["remote.review.url=https://h/y", own.as_str()];
        assert_eq!(
            url_walk(&sub, &second, &names, url).await,
            None,
            "a second URL ls-remote doesn't print is unknown"
        );
        git(&sub, &["config", "remote.here.prune", "true"]).await;
        assert_eq!(
            url_walk(&sub, &[], &["here", "origin"], "here").await,
            Some(None),
            "nor in the repository's own config"
        );
    }

    #[test]
    fn relative_gitmodules_urls_resolve_the_way_git_resolves_them() {
        for (remote, url, want) in [
            (
                "https://h/o/host.git",
                "../dep.git",
                Some("https://h/o/dep.git"),
            ),
            ("https://h/o/host/", "./sub", Some("https://h/o/host/sub")),
            ("git@h:o/host", "../dep", Some("git@h:o/dep")),
            ("git@h:host", "../dep", Some("git@h:dep")),
            ("../up", "../dep", Some("../dep")),
            ("up", "../../dep", None),
            ("https://h/x", "https://e/y", Some("https://e/y")),
        ] {
            assert_eq!(relative_url(remote, url).as_deref(), want, "{remote} {url}");
        }
    }

    /// `host` with `libs/dep` and a sibling `libs/other`, both committed.
    async fn host_with_two_submodules(marker: &str) -> (tempfile::TempDir, String, String) {
        let (dir, host, dep) = host_with_submodule(marker).await;
        let other = Some("libs/other".to_string());
        git_submodule_add_core(
            &AppState::default(),
            host.clone(),
            "../dep".into(),
            other,
            None,
        )
        .await
        .expect("submodule add");
        git(&host, &["commit", "-qm", "add other"]).await;
        (dir, host, dep)
    }

    /// "Remove anyway" on a layout the unforced remove refuses as unreadable: the
    /// submodule leaves the index and `.gitmodules`, its folder is gone or empty, and
    /// the parent's HEAD and its other submodule stay as they were.
    async fn forced_remove_lands(host: &str) {
        let unforced = git_submodule_remove_core(
            &AppState::default(),
            host.to_string(),
            "libs/dep".into(),
            false,
            false,
        )
        .await
        .unwrap();
        assert!(unforced.refused_unreadable.is_some(), "{unforced:?}");
        let head = head_of(host).await;
        let other = Path::new(host)
            .join("libs/other")
            .to_string_lossy()
            .into_owned();
        let other_head = head_of(&other).await;
        let outcome = git_submodule_remove_core(
            &AppState::default(),
            host.to_string(),
            "libs/dep".into(),
            true,
            false,
        )
        .await
        .unwrap();
        assert_eq!(outcome.refused_unreadable, None);
        assert!(!outcome.refused_dirty);
        assert_eq!(git(host, &["ls-files", "-s", "--", "libs/dep"]).await, "");
        let modules = std::fs::read_to_string(Path::new(host).join(".gitmodules")).unwrap();
        assert!(
            !modules.contains("libs/dep") && modules.contains("libs/other"),
            "{modules}"
        );
        let folder = Path::new(host).join("libs/dep");
        assert!(!folder.exists() || std::fs::read_dir(&folder).unwrap().next().is_none());
        assert_eq!(head_of(host).await, head);
        let listed = git(host, &["ls-files", "-s", "--", "libs/other"]).await;
        assert!(listed.starts_with("160000 "), "{listed}");
        assert_eq!(head_of(&other).await, other_head);
    }

    #[tokio::test]
    async fn forced_remove_lands_on_a_gitfile_naming_the_parents_git_dir() {
        let (_dir, host, _dep) = host_with_two_submodules("remove-force-own").await;
        let own = abs_git_path(&host, "--git-dir").await;
        point_gitfile(&sub_dir(&host), &own);
        let refs = git(&host, &["for-each-ref"]).await;
        forced_remove_lands(&host).await;
        assert_eq!(git(&host, &["for-each-ref"]).await, refs);
    }

    #[tokio::test]
    async fn forced_remove_lands_on_a_gitfile_naming_a_sibling_clone() {
        let (dir, host, dep) = host_with_two_submodules("remove-force-clone").await;
        let clone = dir.path().join("clone").to_string_lossy().into_owned();
        let root = dir.path().to_string_lossy().into_owned();
        git(&root, &["clone", "-q", &dep, &clone]).await;
        let clone_git = abs_git_path(&clone, "--git-dir").await;
        point_gitfile(&sub_dir(&host), &clone_git);
        let (head, index) = (
            head_of(&clone).await,
            git(&clone, &["ls-files", "-s"]).await,
        );
        forced_remove_lands(&host).await;
        assert_eq!(head_of(&clone).await, head);
        assert_eq!(git(&clone, &["ls-files", "-s"]).await, index);
        assert!(exists(&clone, "dep.txt"));
    }

    #[tokio::test]
    async fn forced_remove_lands_when_the_status_probe_fails() {
        let (_dir, host, _dep) = host_with_two_submodules("remove-force-status").await;
        let git_dir = abs_git_path(&sub_dir(&host), "--git-dir").await;
        std::fs::write(Path::new(&git_dir).join("index"), b"junk").unwrap();
        forced_remove_lands(&host).await;
    }

    /// The fetch reads its remote after the network wait: a branch switched during it,
    /// whose `branch.<b>.remote` differs, is fetched from that remote.
    #[tokio::test]
    async fn fetch_picks_its_remote_after_the_network_wait() {
        let f = gitlink_fixture("fetch-remote-after-wait").await;
        let head = head_of(&f.sub).await;
        git(&f.sub, &["remote", "add", "up", &f.dep]).await;
        // A tracking ref neither remote has: the fetched remote's `--prune` deletes it.
        for remote in ["origin", "up"] {
            let ghost = format!("refs/remotes/{remote}/ghost");
            git(&f.sub, &["update-ref", &ghost, &head]).await;
        }
        let sub = f.sub.clone();
        let switch: PickLandedHook = Arc::new(move || {
            let sub = sub.clone();
            Box::pin(async move {
                git(&sub, &["checkout", "-q", "-b", "other"]).await;
                git(&sub, &["config", "branch.other.remote", "up"]).await;
            })
        });
        let state = AppState::default();
        let fetch = git_submodule_fetch_core(&state, &f.host, "libs/dep", false);
        FETCH_WAITED_HOOK.scope(switch, fetch).await.unwrap();
        let ghosts = [
            "for-each-ref",
            "--format=%(refname)",
            "refs/remotes/*/ghost",
        ];
        assert_eq!(
            git(&f.sub, &ghosts).await.trim(),
            "refs/remotes/origin/ghost"
        );
    }

    #[test]
    fn a_landed_checkout_counts_only_with_head_read_at_its_commit() {
        let sha = "a".repeat(40);
        let judged = |after: HeadRead| {
            let ran = GitOutput {
                stdout: Vec::new(),
                stderr: String::new(),
                code: 0,
            };
            let out = detach_landed(ran, &sha, &after);
            (out.code, out.stderr)
        };
        assert_eq!(judged(HeadRead::At(sha.clone())), (0, String::new()));
        assert_eq!(
            judged(HeadRead::Unread("git couldn't read it".into())),
            (
                1,
                "couldn't confirm the checkout: git couldn't read it".into()
            )
        );
        let elsewhere = format!("HEAD isn't at {sha} after the checkout");
        assert_eq!(judged(HeadRead::At("b".repeat(40))), (1, elsewhere.clone()));
        assert_eq!(judged(HeadRead::Gone(FOLDER_GONE)), (1, elsewhere));
    }

    #[test]
    fn a_refused_checkout_leaves_out_a_listed_path_the_folder_lacks() {
        let header = WOULD_OVERWRITE_HEADERS[1].0.to_string();
        let owned = |paths: &[&str]| paths.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        let exists = |path: &str| path != "cut";
        assert_eq!(
            exact_listing(
                header.clone(),
                owned(&["a.txt", "cut"]),
                &owned(&["a.txt", "cut"]),
                exists
            ),
            (
                format!("{header} {LOSSY_PATHS_LEFT_OUT}"),
                owned(&["a.txt"]),
                false
            )
        );
    }

    /// The ignore check reads each name literally: `:i.txt` is not `i.txt`. No file is
    /// made (Windows forbids `:` in names): `check-ignore --no-index` answers from the
    /// rules alone, so this runs the same on every platform.
    #[tokio::test]
    async fn ignore_check_reads_a_colon_led_name_as_a_plain_path() {
        let (_dir, host, _dep) = host_with_submodule("ignore-literal").await;
        let sub = sub_dir(&host);
        exclude_in(&sub, "i.txt").await;
        let child = child_at(&sub).await;
        let ask = |path: &str| vec![path.to_string()];
        assert_eq!(all_ignored(&child, &ask("i.txt")).await, Some(true));
        assert_eq!(all_ignored(&child, &ask(":i.txt")).await, Some(false));
    }

    /// A checked-out branch whose name holds the lossy marker asks no `branch.<b>.remote`
    /// key: `origin` decides. Built with a genuine U+FFFD, which degrades the same way.
    #[tokio::test]
    async fn submodule_refs_default_skips_a_lossy_branch_name() {
        let (_dir, host, dep) = host_with_submodule("refs-default-lossy").await;
        let sub = sub_dir(&host);
        git(&sub, &["remote", "add", "up", &dep]).await;
        git(&sub, &["fetch", "-q", "up"]).await;
        let marked = format!("m{LOSSY}");
        git(&sub, &["checkout", "-q", "-b", &marked]).await;
        git(&sub, &["config", &format!("branch.{marked}.remote"), "up"]).await;
        assert_eq!(
            default_rev_of(&host).await.as_deref(),
            Some("refs/remotes/origin/main")
        );
    }

    #[test]
    fn nested_counts_compare_only_exact_paths() {
        let sha = "1".repeat(40);
        let status = format!("+{sha} a (v1)\n-{sha} b\n");
        let paths = ["a", "b"].map(String::from);
        assert_eq!(nested_rows(&status, &paths), Some((1, vec!["b"])));
        let lossy = format!("{status}-{sha} c{LOSSY}\n");
        let with_lossy = ["a".to_string(), "b".to_string(), format!("c{LOSSY}")];
        assert_eq!(nested_rows(&lossy, &with_lossy), None);
        // A newline in a path: `\n+` doesn't start a row, and `m\nn` is one `-` row.
        let status = format!(" {sha} x\n+y (heads/main)\n-{sha} m\nn\n");
        let paths = ["x\n+y", "m\nn"].map(String::from);
        assert_eq!(nested_rows(&status, &paths), Some((0, vec!["m\nn"])));
        // Rows the gitlinks don't account for degrade as a failed read does.
        assert_eq!(nested_rows(&status, &paths[..1]), None);
        assert_eq!(nested_rows(&status, &["x".to_string()]), None);
        let raw = format!(":160000 160000 {sha} {sha} M\0b\0:100644 100644 {sha} {sha} M\0f\0");
        assert_eq!(moved_gitlinks(&raw), Some(vec!["b"]));
        let marked = format!("{raw}:160000 160000 {sha} {sha} M\0c{LOSSY}\0");
        assert_eq!(moved_gitlinks(&marked), None);
    }
}
