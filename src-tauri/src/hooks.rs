use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git, run_git_raw, DEFAULT_TIMEOUT};

/// The client-side hooks GitDesktop surfaces, with a short description each.
/// (Server-side hooks like pre-receive/update aren't useful in a desktop app.)
const KNOWN_HOOKS: &[(&str, &str)] = &[
    (
        "pre-commit",
        "Before a commit is created — lint, format, or run quick tests.",
    ),
    (
        "prepare-commit-msg",
        "Before the message editor opens — seed or template the message.",
    ),
    (
        "commit-msg",
        "Validate or normalize the commit message (e.g. Conventional Commits).",
    ),
    (
        "post-commit",
        "After a commit is created — notifications or bookkeeping.",
    ),
    (
        "pre-merge-commit",
        "Before a merge commit is created.",
    ),
    (
        "post-merge",
        "After a merge — e.g. reinstall deps when the lockfile changed.",
    ),
    (
        "post-checkout",
        "After switching branches or checking out files.",
    ),
    ("pre-rebase", "Before a rebase begins."),
    (
        "post-rewrite",
        "After commits are rewritten (rebase, amend).",
    ),
    (
        "pre-push",
        "Before pushing — run tests or block protected refs.",
    ),
];

/// Whether a hook is installed and runs, kept-but-disabled, or absent.
/// Serializes to the lowercase strings the frontend's union type mirrors.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HookState {
    Active,
    Disabled,
    Inactive,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEntry {
    pub name: String,
    pub description: String,
    pub state: HookState,
    /// Whether git's stock `<name>.sample` is present (a starting point).
    pub has_sample: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HooksInfo {
    /// Absolute path to the effective hooks directory.
    pub hooks_path: String,
    /// True when `core.hooksPath` redirects hooks away from `.git/hooks`.
    pub custom_hooks_path: bool,
    /// A detected hook manager that owns the hooks ("husky" | "pre-commit" |
    /// "lefthook"), so the UI can adapt.
    pub manager: Option<String>,
    /// Path to the manager's config file/dir (e.g. `.pre-commit-config.yaml`,
    /// `lefthook.yml`, the `.husky` dir), for an "Open config" affordance.
    pub manager_config: Option<String>,
    pub entries: Vec<HookEntry>,
}

/// Hook names are embedded into filesystem paths, so restrict them hard to the
/// known set — no traversal, no `.sample`/`.disabled` smuggling.
fn validate_hook_name(name: &str) -> AppResult<()> {
    if KNOWN_HOOKS.iter().any(|(n, _)| *n == name) {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(format!("unknown hook: {name}")))
    }
}

fn absolutize(repo_path: &str, raw: &str) -> PathBuf {
    let p = Path::new(raw);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        Path::new(repo_path).join(p)
    }
}

/// Resolves the effective hooks directory as git's own `rev-parse --git-path hooks`
/// answer: a raw `core.hooksPath` needs git's pathname rules (`~`, the `:(optional)`
/// prefix), which only git applies. Returns `(absolute_dir, is_custom)`.
async fn resolve_hooks_dir(repo_path: &str) -> AppResult<(PathBuf, bool)> {
    let out = run_git(
        Some(repo_path),
        &["rev-parse", "--git-path", "hooks"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let printed = out.stdout_lossy();
    let dir = absolutize(repo_path, crate::git::worktree::stdout_path(&printed));
    let cfg = run_git_raw(
        Some(repo_path),
        &["config", "--get", "core.hooksPath"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let set = cfg.code == 0 && !cfg.stdout_lossy().trim().is_empty();
    // A value git ignores (a missing optional dir) or that names the managed dir
    // redirects nothing; an unresolvable managed dir keeps the value's own answer.
    let custom = set
        && match managed_hooks_dir(repo_path).await {
            Ok(managed) => !same_hooks_dir(&dir, &managed),
            Err(_) => true,
        };
    Ok((dir, custom))
}

/// Detects a hook manager that owns this repo's hooks (and its config path).
fn detect_manager(repo_path: &str, hooks_dir: &Path) -> Option<(String, PathBuf)> {
    let root = Path::new(repo_path);
    if root.join(".husky").is_dir() || hooks_dir.to_string_lossy().contains(".husky") {
        return Some(("husky".to_string(), root.join(".husky")));
    }
    for f in [".pre-commit-config.yaml", ".pre-commit-config.yml"] {
        if root.join(f).is_file() {
            return Some(("pre-commit".to_string(), root.join(f)));
        }
    }
    for f in ["lefthook.yml", ".lefthook.yml", "lefthook.toml"] {
        if root.join(f).is_file() {
            return Some(("lefthook".to_string(), root.join(f)));
        }
    }
    None
}

#[tauri::command]
pub async fn git_hooks_list(repo_path: String) -> AppResult<HooksInfo> {
    let (hooks_dir, custom) = resolve_hooks_dir(&repo_path).await?;
    let detected = detect_manager(&repo_path, &hooks_dir);
    let manager = detected.as_ref().map(|(m, _)| m.clone());
    let manager_config = detected
        .as_ref()
        .map(|(_, p)| p.to_string_lossy().into_owned());
    let entries = KNOWN_HOOKS
        .iter()
        .map(|(name, desc)| {
            let active = hooks_dir.join(name).is_file();
            let disabled = hooks_dir.join(format!("{name}.disabled")).is_file();
            let has_sample = hooks_dir.join(format!("{name}.sample")).is_file();
            let state = if active {
                HookState::Active
            } else if disabled {
                HookState::Disabled
            } else {
                HookState::Inactive
            };
            HookEntry {
                name: (*name).to_string(),
                description: (*desc).to_string(),
                state,
                has_sample,
            }
        })
        .collect();
    Ok(HooksInfo {
        hooks_path: hooks_dir.to_string_lossy().into_owned(),
        custom_hooks_path: custom,
        manager,
        manager_config,
        entries,
    })
}

/// Runs a hook manager's CLI in the repo and returns its combined output.
/// Inputs are allowlisted (pre-commit install/autoupdate, lefthook install),
/// so no arbitrary command can be run.
#[tauri::command]
pub async fn git_run_hook_manager(
    repo_path: String,
    manager: String,
    action: String,
) -> AppResult<String> {
    let args: &[&str] = match (manager.as_str(), action.as_str()) {
        ("pre-commit", "install") => &["install"],
        ("pre-commit", "update") => &["autoupdate"],
        ("lefthook", "install") => &["install"],
        _ => {
            return Err(AppError::InvalidArgument(format!(
                "unsupported hook manager action: {manager} {action}"
            )));
        }
    };
    let not_installed =
        || AppError::Command(format!("{manager} isn't installed or isn't on your PATH."));
    // Retries a failed startup capture here, where a stale PATH would show as
    // "isn't installed"; after the allowlist, so a rejected action never waits on it.
    crate::agent::prime_shell_path().await;
    // The merged shell PATH decides first: the dialog must run the same install that
    // git hooks will find, not whichever copy the inherited PATH reaches.
    let binary = match crate::agent::find_on_shell_path(&manager) {
        Some(found) => found,
        None => crate::agent::resolve_named(&[manager.as_str()], None)
            .await
            .ok_or_else(not_installed)?,
    };
    let mut cmd = tokio::process::Command::new(&binary);
    crate::agent::sanitize_child_env(&mut cmd);
    cmd.args(args)
        .current_dir(&repo_path)
        .stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let run = cmd.output();
    let timeout = std::time::Duration::from_secs(300);
    let output = tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| AppError::Timeout(timeout.as_secs()))?
        .map_err(|e| {
            // The resolved path went stale between the lookup and the spawn.
            if e.kind() == std::io::ErrorKind::NotFound {
                not_installed()
            } else {
                AppError::Io(e)
            }
        })?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    if output.status.success() {
        Ok(combined.trim().to_string())
    } else {
        Err(AppError::Command(format!(
            "{manager} {action} failed:\n{}",
            combined.trim()
        )))
    }
}

/// The hook's script contents — the active file if installed, else the disabled
/// twin, else git's `.sample` as a starting point, else None.
#[tauri::command]
pub async fn git_hook_read(repo_path: String, name: String) -> AppResult<Option<String>> {
    validate_hook_name(&name)?;
    let (dir, _) = resolve_hooks_dir(&repo_path).await?;
    for candidate in [
        dir.join(&name),
        dir.join(format!("{name}.disabled")),
        dir.join(format!("{name}.sample")),
    ] {
        match tokio::fs::read_to_string(&candidate).await {
            Ok(text) => return Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::Io(e)),
        }
    }
    Ok(None)
}

#[cfg(unix)]
async fn make_executable(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = tokio::fs::metadata(path)
        .await
        .map_err(AppError::Io)?
        .permissions();
    perms.set_mode(0o755);
    tokio::fs::set_permissions(path, perms)
        .await
        .map_err(AppError::Io)
}

#[cfg(not(unix))]
async fn make_executable(_path: &Path) -> AppResult<()> {
    Ok(())
}

/// Writes (creating or replacing) a hook's script and makes it active: the file
/// is written as `<name>` and marked executable, and any disabled twin removed.
#[tauri::command]
pub async fn git_hook_write(repo_path: String, name: String, content: String) -> AppResult<()> {
    validate_hook_name(&name)?;
    let (dir, _) = resolve_hooks_dir(&repo_path).await?;
    tokio::fs::create_dir_all(&dir).await.map_err(AppError::Io)?;
    let path = dir.join(&name);
    tokio::fs::write(&path, content).await.map_err(AppError::Io)?;
    make_executable(&path).await?;
    let _ = tokio::fs::remove_file(dir.join(format!("{name}.disabled"))).await;
    Ok(())
}

/// Enables/disables a hook by renaming between `<name>` and `<name>.disabled`,
/// so the script is kept either way (git only runs the unsuffixed file).
#[tauri::command]
pub async fn git_hook_set_enabled(
    repo_path: String,
    name: String,
    enabled: bool,
) -> AppResult<()> {
    validate_hook_name(&name)?;
    let (dir, _) = resolve_hooks_dir(&repo_path).await?;
    let active = dir.join(&name);
    let disabled = dir.join(format!("{name}.disabled"));
    if enabled {
        if disabled.is_file() && !active.exists() {
            tokio::fs::rename(&disabled, &active)
                .await
                .map_err(AppError::Io)?;
            make_executable(&active).await?;
        }
    } else if active.is_file() {
        let _ = tokio::fs::remove_file(&disabled).await;
        tokio::fs::rename(&active, &disabled)
            .await
            .map_err(AppError::Io)?;
    }
    Ok(())
}

/// Deletes a hook (active and disabled variants) to the OS recycle bin, so a
/// hand-written script can be recovered.
#[tauri::command]
pub async fn git_hook_delete(repo_path: String, name: String) -> AppResult<()> {
    validate_hook_name(&name)?;
    let (dir, _) = resolve_hooks_dir(&repo_path).await?;
    for path in [dir.join(&name), dir.join(format!("{name}.disabled"))] {
        if path.exists() {
            tauri::async_runtime::spawn_blocking(move || {
                crate::fsops::trash_delete(&path).map_err(AppError::Io)
            })
            .await
            .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
        }
    }
    Ok(())
}

/// A `pre-push` holding a line equal to this (trailing whitespace ignored) is
/// GitDesktop's managed hook, whatever else the file holds.
const KEEP_LOCAL_HOOK_MARKER: &str = "# gitdesktop:keep-local-pre-push";

/// The managed pre-push hook: plain POSIX sh, LF endings, ASCII. An inline literal,
/// since a checked-out file would gain CRLF on Windows. It reads Keep local with the
/// same `git config --type=bool --get` as `branch_keep_local`, so the two agree. Exit
/// codes are captured with `|| gd_rc=$?`, so a host hook under `set -e` keeps running.
const KEEP_LOCAL_HOOK_SCRIPT: &str = concat!(
    "#!/bin/sh\n",
    "# gitdesktop:keep-local-pre-push\n",
    "# Managed by GitDesktop: stops a push of any branch marked Keep local.\n",
    "# Bypass once with: git push --no-verify. Remove it from GitDesktop, or delete this file.\n",
    "gd_blocked=0\n",
    "while read -r gd_local gd_local_oid gd_remote gd_remote_oid; do\n",
    "  case \"$gd_local\" in\n",
    "    refs/heads/*) gd_branch=${gd_local#refs/heads/} ;;\n",
    "    HEAD)\n",
    "      gd_rc=0\n",
    "      gd_branch=$(git symbolic-ref -q HEAD) || gd_rc=$?\n",
    "      case $gd_rc in\n",
    "        0) ;;\n",
    "        1) continue ;;\n",
    "        *)\n",
    "          printf 'GitDesktop: could not read which branch HEAD is on, so this push was stopped. Bypass once with: git push --no-verify\\n' >&2\n",
    "          gd_blocked=1\n",
    "          continue ;;\n",
    "      esac\n",
    "      case \"$gd_branch\" in\n",
    "        refs/heads/*) gd_branch=${gd_branch#refs/heads/} ;;\n",
    "        *) continue ;;\n",
    "      esac ;;\n",
    "    *) continue ;;\n",
    "  esac\n",
    "  gd_rc=0\n",
    "  gd_flag=$(git config --type=bool --get \"branch.$gd_branch.gitdesktopLocalOnly\" 2>/dev/null) || gd_rc=$?\n",
    "  case \"$gd_rc:$gd_flag\" in\n",
    "    0:true)\n",
    "      printf 'GitDesktop: \"%s\" is marked Keep local, so this push was stopped. Turn off Keep local in GitDesktop, or bypass once with: git push --no-verify\\n' \"$gd_branch\" >&2\n",
    "      gd_blocked=1 ;;\n",
    "    0:*|1:*) ;;\n",
    "    *)\n",
    "      printf 'GitDesktop: could not read whether \"%s\" is marked Keep local, so this push was stopped. Bypass once with: git push --no-verify\\n' \"$gd_branch\" >&2\n",
    "      gd_blocked=1 ;;\n",
    "  esac\n",
    "done\n",
    "[ \"$gd_blocked\" = 0 ] || exit 1\n",
);

/// The managed script's body, for pasting into a user's own pre-push hook: no
/// shebang and no marker, so a pasted copy is never mistaken for the managed file.
fn keep_local_hook_snippet() -> &'static str {
    let start = KEEP_LOCAL_HOOK_SCRIPT.find("gd_blocked=0").unwrap_or(0);
    &KEEP_LOCAL_HOOK_SCRIPT[start..]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum KeepLocalHookState {
    Installed,
    Absent,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KeepLocalHookBlock {
    HookManager,
    CustomHooksPath,
    ForeignHook,
}

/// Where the managed Keep local pre-push hook stands. `blocked` is set exactly when
/// `state` is blocked, and `manager` exactly when the block is a hook manager.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepLocalHookStatus {
    pub state: KeepLocalHookState,
    pub blocked: Option<KeepLocalHookBlock>,
    pub manager: Option<String>,
    /// The effective hooks directory, absolute.
    pub hooks_path: String,
    pub snippet: String,
    /// A marker-carrying regular `pre-push` sits in `<common>/hooks`, in any state:
    /// what remove would delete. Always false through a redirected hooks dir.
    pub managed_hook_present: bool,
    /// `<common>/hooks` exists and is not a real directory (a link or a plain file), so
    /// install and remove never act through it and a remove there deletes nothing.
    pub hooks_dir_redirected: bool,
}

/// The one place the managed hook lives: the COMMON git dir's hooks folder, so every
/// linked worktree runs it. Install and remove never act anywhere else.
async fn managed_hooks_dir(repo_path: &str) -> AppResult<PathBuf> {
    let common = crate::git::worktree::git_common_dir(repo_path).await?;
    Ok(PathBuf::from(common).join("hooks"))
}

/// Whether two hooks dirs are one: the same directory on disk or spelling, or, when
/// the dir doesn't exist yet, the same name under the same parent. Unsure reads as
/// different, which blocks install.
fn same_hooks_dir(a: &Path, b: &Path) -> bool {
    use crate::git::worktree::same_wt_path;
    if same_wt_path(&a.to_string_lossy(), &b.to_string_lossy()) {
        return true;
    }
    match (a.parent(), a.file_name(), b.parent(), b.file_name()) {
        (Some(pa), Some(na), Some(pb), Some(nb)) => {
            na == nb && same_wt_path(&pa.to_string_lossy(), &pb.to_string_lossy())
        }
        _ => false,
    }
}

/// What sits at a hook path. Only a regular file is ever read, rewritten or deleted:
/// a link could point outside the hooks dir, and a FIFO would block the read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HookFile {
    Missing,
    Ours,
    Foreign,
    NotRegular,
}

/// Classifies `path` without following a link; an unreadable regular file is an Err,
/// never absent. The marker test here is the one "ours" predicate.
fn hook_file(path: &Path) -> std::io::Result<HookFile> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HookFile::Missing),
        Err(e) => return Err(e),
    };
    if !meta.file_type().is_file() {
        return Ok(HookFile::NotRegular);
    }
    match std::fs::read(path) {
        Ok(bytes) => {
            let ours = String::from_utf8_lossy(&bytes)
                .lines()
                .any(|line| line.trim_end() == KEEP_LOCAL_HOOK_MARKER);
            Ok(if ours {
                HookFile::Ours
            } else {
                HookFile::Foreign
            })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HookFile::Missing),
        Err(e) => Err(e),
    }
}

/// Whether `<common>/hooks` is a link, junction or non-directory: a write through it
/// would land outside the git dir. A missing dir is fine (install creates it).
fn hooks_dir_redirected(dir: &Path) -> std::io::Result<bool> {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) => Ok(!meta.file_type().is_dir()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(unix)]
fn set_hook_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn set_hook_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

static HOOK_TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Writes the whole script, executable, to a uniquely named temp file in `dir`, so the
/// live `pre-push` only ever appears complete. A failed write removes the temp.
fn write_hook_temp(dir: &Path) -> std::io::Result<PathBuf> {
    use std::io::Write;
    let seq = HOOK_TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(
        ".pre-push.gitdesktop-{}-{seq}.tmp",
        std::process::id()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)?;
    let written = file
        .write_all(KEEP_LOCAL_HOOK_SCRIPT.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = written.and_then(|()| set_hook_executable(&tmp)) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(tmp)
}

/// Puts the script at `path` only when nothing is there: Ok(false) when anything
/// (a file, a dangling link) already is. A hard link from the temp is create-new with
/// content; a filesystem without hard links falls back to create-new + write.
fn create_hook_file(dir: &Path, path: &Path) -> std::io::Result<bool> {
    let tmp = write_hook_temp(dir)?;
    let linked = std::fs::hard_link(&tmp, path);
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(_) => create_hook_file_in_place(path),
    }
}

/// The no-hard-link fallback: a failed write deletes the file it created, so no empty
/// `pre-push` is left behind.
fn create_hook_file_in_place(path: &Path) -> std::io::Result<bool> {
    use std::io::Write;
    let created = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path);
    let mut file = match created {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e),
    };
    let written = file
        .write_all(KEEP_LOCAL_HOOK_SCRIPT.as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    if let Err(e) = written.and_then(|()| set_hook_executable(path)) {
        let _ = std::fs::remove_file(path);
        return Err(e);
    }
    Ok(true)
}

/// Replaces our own `path` by renaming a complete temp over it, so git never runs a
/// truncated script; Ok(false), with nothing written, when the live file is no
/// longer ours.
fn replace_hook_file(dir: &Path, path: &Path) -> std::io::Result<bool> {
    let tmp = write_hook_temp(dir)?;
    let replaced = match hook_file(path) {
        Ok(HookFile::Ours) => std::fs::rename(&tmp, path).map(|()| true),
        _ => Ok(false),
    };
    if !matches!(replaced, Ok(true)) {
        let _ = std::fs::remove_file(&tmp);
    }
    replaced
}

/// Deletes the file at `path` only when it is a regular file carrying the marker.
fn remove_if_keep_local_hook(path: &Path) -> std::io::Result<()> {
    if hook_file(path)? == HookFile::Ours {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// The effective hooks dir as the UI shows it: forward slashes on Windows, no `.`
/// segments, no trailing separator.
fn display_hooks_path(path: &Path) -> String {
    let mut shown = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        shown = shown.replace('\\', "/");
    }
    while shown.contains("/./") {
        shown = shown.replace("/./", "/");
    }
    let trailing =
        |s: &str| s.ends_with("/.") || (s.len() > 1 && s.ends_with('/') && !s.ends_with(":/"));
    while trailing(&shown) {
        shown.pop();
    }
    shown
}

/// A custom hooks dir blocks first: git doesn't run `<common>/hooks` then, even if
/// our file sits there. Past it, a marker-carrying managed file is what git runs, so
/// it reads installed before a manager config in the tree can block. Config-defined
/// hooks (`hook.<name>.*`, git 2.54+) aren't detected: they run beside the hooks-folder
/// file, whose non-zero exit still stops the push.
async fn keep_local_hook_status_core(repo_path: &str) -> AppResult<KeepLocalHookStatus> {
    use KeepLocalHookBlock::{CustomHooksPath, ForeignHook, HookManager};
    use KeepLocalHookState::{Absent, Blocked, Installed};
    let (effective, _) = resolve_hooks_dir(repo_path).await?;
    let managed = managed_hooks_dir(repo_path).await?;
    let manager = detect_manager(repo_path, &effective).map(|(name, _)| name);
    let pre_push = managed.join("pre-push");
    // One lstat feeds both fields; an unreadable dir reads unlinked here and fails the
    // same-dir arm below.
    let redirected = hooks_dir_redirected(&managed);
    let linked = matches!(redirected, Ok(true));
    let (state, blocked, managed_hook_present) = if !same_hooks_dir(&effective, &managed) {
        let reason = if manager.is_some() {
            HookManager
        } else {
            CustomHooksPath
        };
        // git doesn't run this file here, so a failed read reports it absent rather
        // than failing a status whose state doesn't depend on it.
        let present =
            matches!(redirected, Ok(false)) && matches!(hook_file(&pre_push), Ok(HookFile::Ours));
        (Blocked, Some(reason), present)
    } else if redirected.map_err(AppError::Io)? {
        (Blocked, Some(CustomHooksPath), false)
    } else {
        let file = hook_file(&pre_push).map_err(AppError::Io)?;
        let (state, blocked) = match file {
            HookFile::Ours => (Installed, None),
            _ if manager.is_some() => (Blocked, Some(HookManager)),
            HookFile::Foreign | HookFile::NotRegular => (Blocked, Some(ForeignHook)),
            HookFile::Missing => (Absent, None),
        };
        (state, blocked, file == HookFile::Ours)
    };
    Ok(KeepLocalHookStatus {
        state,
        blocked,
        manager: manager.filter(|_| blocked == Some(HookManager)),
        hooks_path: display_hooks_path(&effective),
        snippet: keep_local_hook_snippet().to_string(),
        managed_hook_present,
        hooks_dir_redirected: linked,
    })
}

/// Writes the managed hook into `<common>/hooks` unless the status is blocked: an
/// absent file is created create-new and an installed one replaced by rename, so a
/// file that isn't ours is never overwritten. Install never answers `absent`.
async fn keep_local_hook_install_core(repo_path: &str) -> AppResult<KeepLocalHookStatus> {
    let status = keep_local_hook_status_core(repo_path).await?;
    if status.state == KeepLocalHookState::Blocked {
        return Ok(status);
    }
    let dir = managed_hooks_dir(repo_path).await?;
    std::fs::create_dir_all(&dir).map_err(AppError::Io)?;
    let path = dir.join("pre-push");
    let wrote = if status.state == KeepLocalHookState::Installed {
        replace_hook_file(&dir, &path)
    } else {
        create_hook_file(&dir, &path)
    }
    .map_err(AppError::Io)?;
    if wrote {
        // Best-effort: the hook is in place, so a stuck twin doesn't fail the install.
        let _ = remove_if_keep_local_hook(&dir.join("pre-push.disabled"));
        return keep_local_hook_status_core(repo_path).await;
    }
    let mut after = keep_local_hook_status_core(repo_path).await?;
    if after.state == KeepLocalHookState::Absent {
        after.state = KeepLocalHookState::Blocked;
        after.blocked = Some(KeepLocalHookBlock::ForeignHook);
    }
    Ok(after)
}

/// Deletes the managed hook from `<common>/hooks` in any state (a hook left inert
/// behind a later custom hooksPath stays removable); only marker-carrying regular
/// files go, and nothing is deleted through a redirected hooks dir.
async fn keep_local_hook_remove_core(repo_path: &str) -> AppResult<KeepLocalHookStatus> {
    let dir = managed_hooks_dir(repo_path).await?;
    if !hooks_dir_redirected(&dir).map_err(AppError::Io)? {
        for name in ["pre-push", "pre-push.disabled"] {
            remove_if_keep_local_hook(&dir.join(name)).map_err(AppError::Io)?;
        }
    }
    keep_local_hook_status_core(repo_path).await
}

#[tauri::command]
pub async fn git_keep_local_hook_status(repo_path: String) -> AppResult<KeepLocalHookStatus> {
    keep_local_hook_status_core(&repo_path).await
}

/// Installs the Keep local pre-push hook and returns the status after.
#[tauri::command]
pub async fn git_keep_local_hook_install(repo_path: String) -> AppResult<KeepLocalHookStatus> {
    keep_local_hook_install_core(&repo_path).await
}

/// Removes the Keep local pre-push hook and returns the status after.
#[tauri::command]
pub async fn git_keep_local_hook_remove(repo_path: String) -> AppResult<KeepLocalHookStatus> {
    keep_local_hook_remove_core(&repo_path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_known_client_hooks() {
        for (name, _) in KNOWN_HOOKS {
            assert!(validate_hook_name(name).is_ok(), "{name} should be allowed");
        }
    }

    #[test]
    fn rejects_unknown_and_unsafe_names() {
        // Empty, traversal, separators, suffix smuggling, server-side hooks,
        // and case variants must all be refused (they're not in KNOWN_HOOKS).
        for name in [
            "",
            "..",
            "../config",
            "pre-commit/x",
            "pre-commit.sample",
            "pre-commit.disabled",
            "post-update",
            "Pre-Commit",
        ] {
            assert!(
                validate_hook_name(name).is_err(),
                "{name} should be rejected"
            );
        }
    }

    // --- Keep local pre-push hook (real repos under a temp dir, git on PATH). ---

    use crate::git::runner::GitOutput;
    use KeepLocalHookBlock::{CustomHooksPath, ForeignHook, HookManager};
    use KeepLocalHookState::{Absent, Blocked, Installed};

    async fn git(repo: &str, args: &[&str]) -> GitOutput {
        run_git_raw(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
    }

    async fn git_ok(repo: &str, args: &[&str]) -> String {
        let out = git(repo, args).await;
        assert_eq!(out.code, 0, "git {args:?}: {}", out.full_failure_text());
        out.stdout_lossy().trim().to_string()
    }

    fn slashed(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    /// A repository pinned against a hostile global config: identity, the default
    /// hooks dir by absolute path, push settings, and a local bare `origin` that is
    /// not a mirror. Empty templates, so a global template hook can't seed a foreign
    /// file. Returns (guard, base, repo, remote).
    async fn hook_repo(tag: &str) -> (tempfile::TempDir, PathBuf, String, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-hook-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let base = dir.path().to_path_buf();
        let base_s = slashed(&base);
        git_ok(
            &base_s,
            &["init", "-q", "--template=", "-b", "main", "repo"],
        )
        .await;
        git_ok(
            &base_s,
            &["init", "-q", "--template=", "--bare", "remote.git"],
        )
        .await;
        let repo = format!("{base_s}/repo");
        let remote = format!("{base_s}/remote.git");
        std::fs::create_dir_all(Path::new(&repo).join(".git").join("hooks")).unwrap();
        let common = crate::git::worktree::git_common_dir(&repo).await.unwrap();
        for (key, value) in [
            ("commit.gpgsign", "false"),
            ("user.name", "T"),
            ("user.email", "t@t.local"),
            ("core.hooksPath", &format!("{common}/hooks")),
            ("push.default", "simple"),
            ("branch.autoSetupMerge", "true"),
        ] {
            git_ok(&repo, &["config", key, value]).await;
        }
        git_ok(&repo, &["remote", "add", "origin", &remote]).await;
        git_ok(&repo, &["config", "remote.origin.mirror", "false"]).await;
        git_ok(&repo, &["config", "remote.pushDefault", "origin"]).await;
        std::fs::write(format!("{repo}/seed.txt"), "seed\n").unwrap();
        git_ok(&repo, &["add", "-A"]).await;
        git_ok(&repo, &["commit", "-qm", "seed"]).await;
        (dir, base, repo, remote)
    }

    fn managed_file(repo: &str, name: &str) -> PathBuf {
        Path::new(repo).join(".git").join("hooks").join(name)
    }

    fn assert_status(
        status: &KeepLocalHookStatus,
        state: KeepLocalHookState,
        blocked: Option<KeepLocalHookBlock>,
        manager: Option<&str>,
    ) {
        assert_eq!(status.state, state, "{status:?}");
        assert_eq!(status.blocked, blocked, "{status:?}");
        assert_eq!(status.manager.as_deref(), manager, "{status:?}");
        assert_eq!(status.snippet, keep_local_hook_snippet());
        match state {
            Installed => assert!(status.managed_hook_present, "{status:?}"),
            Absent => assert!(!status.managed_hook_present, "{status:?}"),
            Blocked => {}
        }
        if state != Blocked {
            assert!(!status.hooks_dir_redirected, "{status:?}");
        }
    }

    fn assert_present(status: &KeepLocalHookStatus, present: bool) {
        assert_eq!(status.managed_hook_present, present, "{status:?}");
    }

    fn assert_redirected(status: &KeepLocalHookStatus, redirected: bool) {
        assert_eq!(status.hooks_dir_redirected, redirected, "{status:?}");
    }

    async fn status(repo: &str) -> KeepLocalHookStatus {
        git_keep_local_hook_status(repo.to_string()).await.unwrap()
    }

    async fn install(repo: &str) -> KeepLocalHookStatus {
        git_keep_local_hook_install(repo.to_string()).await.unwrap()
    }

    async fn remove(repo: &str) -> KeepLocalHookStatus {
        git_keep_local_hook_remove(repo.to_string()).await.unwrap()
    }

    async fn remote_tip(remote: &str, branch: &str) -> Option<String> {
        let heads = git_ok(
            remote,
            &[
                "for-each-ref",
                "--format=%(refname:lstrip=2) %(objectname)",
                "refs/heads",
            ],
        )
        .await;
        heads.lines().find_map(|line| {
            let (name, sha) = line.split_once(' ')?;
            (name == branch).then(|| sha.to_string())
        })
    }

    async fn commit(repo: &str, msg: &str) -> String {
        std::fs::write(format!("{repo}/f.txt"), format!("{msg}\n")).unwrap();
        git_ok(repo, &["add", "-A"]).await;
        git_ok(repo, &["commit", "-qm", msg]).await;
        git_ok(repo, &["rev-parse", "HEAD"]).await
    }

    /// Asserts a push the hook stopped: non-zero, with the line naming `branch`.
    async fn assert_stopped(repo: &str, args: &[&str], branch: &str, line: &str) {
        let out = git(repo, args).await;
        assert_ne!(out.code, 0, "git {args:?} should be stopped");
        assert!(
            out.stderr.contains(&format!("\"{branch}\" {line}"))
                && out.stderr.contains("git push --no-verify"),
            "git {args:?}: {}",
            out.stderr
        );
    }

    #[test]
    fn keep_local_hook_script_is_lf_ascii_sh_with_the_marker() {
        let script = KEEP_LOCAL_HOOK_SCRIPT;
        assert!(script.is_ascii());
        assert!(!script.contains('\r'));
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.ends_with("[ \"$gd_blocked\" = 0 ] || exit 1\n"));
        assert!(script.lines().any(|l| l == KEEP_LOCAL_HOOK_MARKER));
        // Only a detached HEAD (exit 1) passes; any other symbolic-ref failure stops.
        let head_read = "gd_branch=$(git symbolic-ref -q HEAD) || gd_rc=$?\n      case $gd_rc in\n";
        assert!(script.contains(head_read));
        // Every command substitution captures its status errexit-safely.
        for line in script.lines().filter(|l| l.contains("=$(")) {
            assert!(line.ends_with(" || gd_rc=$?"), "{line}");
        }
        assert!(script.contains("        1) continue ;;\n"));
        assert!(script.contains("could not read which branch HEAD is on"));
        // The hook reads the same key the Rust guard and setter use.
        let key = crate::git::branches::keep_local_key("$gd_branch");
        assert!(script.contains(&format!("--get \"{key}\"")));
        let snippet = keep_local_hook_snippet();
        assert!(snippet.starts_with("gd_blocked=0\n"));
        assert!(script.ends_with(snippet));
        assert!(!snippet.contains("#!/bin/sh"));
        assert!(!snippet.contains(KEEP_LOCAL_HOOK_MARKER));
    }

    #[test]
    fn keep_local_hook_status_serializes_to_the_pinned_wire_shape() {
        let installed = KeepLocalHookStatus {
            state: Installed,
            blocked: None,
            manager: None,
            hooks_path: "C:/repo/.git/hooks".into(),
            snippet: "S".into(),
            managed_hook_present: true,
            hooks_dir_redirected: false,
        };
        let json = serde_json::to_string(&installed).unwrap();
        assert_eq!(
            json,
            r#"{"state":"installed","blocked":null,"manager":null,"hooksPath":"C:/repo/.git/hooks","snippet":"S","managedHookPresent":true,"hooksDirRedirected":false}"#
        );
        assert!(!json.contains("managed_hook_present"));
        assert!(!json.contains("hooks_dir_redirected"));
        let blocked = KeepLocalHookStatus {
            state: Blocked,
            blocked: Some(HookManager),
            manager: Some("husky".into()),
            hooks_path: "C:/repo/.husky/_".into(),
            snippet: "S".into(),
            managed_hook_present: false,
            hooks_dir_redirected: true,
        };
        let json = serde_json::to_string(&blocked).unwrap();
        assert_eq!(
            json,
            r#"{"state":"blocked","blocked":"hookManager","manager":"husky","hooksPath":"C:/repo/.husky/_","snippet":"S","managedHookPresent":false,"hooksDirRedirected":true}"#
        );
        assert!(!json.contains("hooks_path"));
        assert!(!json.contains("managed_hook_present"));
        assert!(!json.contains("hooks_dir_redirected"));
        for (reason, wire) in [
            (CustomHooksPath, "\"customHooksPath\""),
            (ForeignHook, "\"foreignHook\""),
        ] {
            assert_eq!(serde_json::to_string(&reason).unwrap(), wire);
        }
        assert_eq!(serde_json::to_string(&Absent).unwrap(), "\"absent\"");
    }

    #[tokio::test]
    async fn keep_local_hook_installs_into_a_missing_hooks_dir_and_removes() {
        let (_g, _base, repo, _remote) = hook_repo("absent").await;
        std::fs::remove_dir_all(Path::new(&repo).join(".git").join("hooks")).unwrap();
        assert_status(&status(&repo).await, Absent, None, None);
        let after = install(&repo).await;
        assert_status(&after, Installed, None, None);
        let file = managed_file(&repo, "pre-push");
        assert_eq!(
            std::fs::read(&file).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&file).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111, "executable: {mode:o}");
        }
        // Installing again rewrites the same file.
        assert_status(&install(&repo).await, Installed, None, None);
        assert_status(&remove(&repo).await, Absent, None, None);
        assert!(!file.exists());
        // Removing with nothing installed succeeds.
        assert_status(&remove(&repo).await, Absent, None, None);
    }

    #[tokio::test]
    async fn keep_local_hook_leaves_a_foreign_pre_push_alone() {
        let (_g, _base, repo, _remote) = hook_repo("foreign").await;
        let file = managed_file(&repo, "pre-push");
        let foreign = b"#!/bin/sh\necho mine\n";
        std::fs::write(&file, foreign).unwrap();
        let st = status(&repo).await;
        assert_status(&st, Blocked, Some(ForeignHook), None);
        assert_present(&st, false);
        assert_status(&install(&repo).await, Blocked, Some(ForeignHook), None);
        assert_eq!(std::fs::read(&file).unwrap(), foreign);
        let st = remove(&repo).await;
        assert_status(&st, Blocked, Some(ForeignHook), None);
        assert_present(&st, false);
        assert_eq!(std::fs::read(&file).unwrap(), foreign);
    }

    #[tokio::test]
    async fn keep_local_hook_handles_the_disabled_twin_by_its_marker() {
        let (_g, _base, repo, _remote) = hook_repo("disabled").await;
        let twin = managed_file(&repo, "pre-push.disabled");
        let foreign = b"#!/bin/sh\necho mine\n";
        std::fs::write(&twin, foreign).unwrap();
        assert_status(&status(&repo).await, Absent, None, None);
        assert_status(&install(&repo).await, Installed, None, None);
        assert_eq!(std::fs::read(&twin).unwrap(), foreign, "foreign twin kept");
        assert_status(&remove(&repo).await, Absent, None, None);
        assert_eq!(std::fs::read(&twin).unwrap(), foreign, "foreign twin kept");
        // A marker-carrying twin is ours: install drops it, and so does remove. It
        // isn't the live hook, so the status reads absent with no managed hook present.
        std::fs::write(&twin, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        let st = status(&repo).await;
        assert_status(&st, Absent, None, None);
        assert_present(&st, false);
        assert_status(&install(&repo).await, Installed, None, None);
        assert!(!twin.exists());
        std::fs::write(&twin, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        assert_status(&remove(&repo).await, Absent, None, None);
        assert!(!twin.exists());
    }

    #[tokio::test]
    async fn keep_local_hook_reads_a_user_edited_file_as_installed() {
        let (_g, _base, repo, _remote) = hook_repo("edited").await;
        let file = managed_file(&repo, "pre-push");
        let edited = "#!/bin/sh\r\n# gitdesktop:keep-local-pre-push  \r\necho extra\r\n";
        std::fs::write(&file, edited).unwrap();
        assert_status(&status(&repo).await, Installed, None, None);
        assert_status(&install(&repo).await, Installed, None, None);
        assert_eq!(
            std::fs::read(&file).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
        std::fs::write(&file, edited).unwrap();
        assert_status(&remove(&repo).await, Absent, None, None);
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn keep_local_hook_blocks_on_each_hook_manager() {
        let (_g, _base, repo, _remote) = hook_repo("managers").await;
        let root = Path::new(&repo);
        let file = managed_file(&repo, "pre-push");
        for (manager, config) in [
            ("husky", ".husky"),
            ("pre-commit", ".pre-commit-config.yaml"),
            ("lefthook", "lefthook.yml"),
        ] {
            let path = root.join(config);
            if manager == "husky" {
                std::fs::create_dir(&path).unwrap();
            } else {
                std::fs::write(&path, "x\n").unwrap();
            }
            assert_status(
                &status(&repo).await,
                Blocked,
                Some(HookManager),
                Some(manager),
            );
            let after = install(&repo).await;
            assert_status(&after, Blocked, Some(HookManager), Some(manager));
            assert!(!file.exists(), "{manager}: install wrote nothing");
            if manager == "husky" {
                std::fs::remove_dir(&path).unwrap();
            } else {
                std::fs::remove_file(&path).unwrap();
            }
        }
        assert_status(&status(&repo).await, Absent, None, None);
    }

    #[tokio::test]
    async fn keep_local_hook_blocks_a_custom_hooks_path() {
        let (_g, base, repo, _remote) = hook_repo("custom").await;
        let custom = slashed(&base.join("elsewhere"));
        git_ok(&repo, &["config", "core.hooksPath", &custom]).await;
        let st = install(&repo).await;
        assert_status(&st, Blocked, Some(CustomHooksPath), None);
        assert!(same_hooks_dir(
            Path::new(&st.hooks_path),
            Path::new(&custom)
        ));
        assert!(
            !Path::new(&custom).exists(),
            "nothing written in the custom dir"
        );
        assert!(!managed_file(&repo, "pre-push").exists());
        // An empty hooksPath makes git look for `/<hook>`, never in the default dir.
        git_ok(&repo, &["config", "core.hooksPath", ""]).await;
        assert_status(&install(&repo).await, Blocked, Some(CustomHooksPath), None);
        assert!(!managed_file(&repo, "pre-push").exists());
        assert!(!Path::new(&repo).join("pre-push").exists());
    }

    #[tokio::test]
    async fn keep_local_hook_never_counts_or_removes_a_marker_file_in_another_dir() {
        let (_g, _base, repo, _remote) = hook_repo("elsewhere").await;
        for (dir, reason, manager) in [
            (".husky/_", HookManager, Some("husky")),
            ("custom-hooks", CustomHooksPath, None),
        ] {
            let folder = Path::new(&repo).join(dir);
            std::fs::create_dir_all(&folder).unwrap();
            let file = folder.join("pre-push");
            std::fs::write(&file, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
            git_ok(&repo, &["config", "core.hooksPath", dir]).await;
            let st = status(&repo).await;
            assert_status(&st, Blocked, Some(reason), manager);
            assert_present(&st, false);
            assert_status(&install(&repo).await, Blocked, Some(reason), manager);
            let st = remove(&repo).await;
            assert_status(&st, Blocked, Some(reason), manager);
            assert_present(&st, false);
            assert_eq!(
                std::fs::read(&file).unwrap(),
                KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
            );
            let top = dir.split('/').next().unwrap();
            std::fs::remove_dir_all(Path::new(&repo).join(top)).unwrap();
        }
    }

    #[tokio::test]
    async fn keep_local_hook_stays_installed_when_a_manager_config_appears() {
        let (_g, _base, repo, _remote) = hook_repo("later-manager").await;
        assert_status(&install(&repo).await, Installed, None, None);
        let root = Path::new(&repo);
        std::fs::write(root.join(".pre-commit-config.yaml"), "x\n").unwrap();
        assert_status(&status(&repo).await, Installed, None, None);
        std::fs::write(root.join("lefthook.yml"), "x\n").unwrap();
        assert_status(&status(&repo).await, Installed, None, None);
        std::fs::create_dir(root.join(".husky")).unwrap();
        assert_status(&status(&repo).await, Installed, None, None);
    }

    /// Removing under a manager config reads blocked afterwards, and the flag is what
    /// tells the caller the file really went.
    #[tokio::test]
    async fn keep_local_hook_remove_under_a_manager_config_reports_the_file_gone() {
        let (_g, _base, repo, _remote) = hook_repo("remove-manager").await;
        assert_status(&install(&repo).await, Installed, None, None);
        std::fs::write(Path::new(&repo).join("lefthook.yml"), "x\n").unwrap();
        assert_status(&status(&repo).await, Installed, None, None);
        let st = remove(&repo).await;
        assert_status(&st, Blocked, Some(HookManager), Some("lefthook"));
        assert_present(&st, false);
        assert_redirected(&st, false);
        assert!(!managed_file(&repo, "pre-push").exists());
    }

    /// Installs, then points core.hooksPath at `dir`: the inert managed file still
    /// reads present until remove deletes it.
    async fn assert_removed_behind_later_path(
        tag: &str,
        dir: &str,
        reason: KeepLocalHookBlock,
        manager: Option<&str>,
    ) {
        let (_g, _base, repo, _remote) = hook_repo(tag).await;
        let file = managed_file(&repo, "pre-push");
        assert_status(&install(&repo).await, Installed, None, None);
        git_ok(&repo, &["config", "core.hooksPath", dir]).await;
        let st = status(&repo).await;
        assert_status(&st, Blocked, Some(reason), manager);
        assert_present(&st, true);
        let st = remove(&repo).await;
        assert_status(&st, Blocked, Some(reason), manager);
        assert_present(&st, false);
        assert_redirected(&st, false);
        assert!(!file.exists(), "{dir}: the managed file was removed");
    }

    #[tokio::test]
    async fn keep_local_hook_behind_a_later_custom_path_still_removes() {
        assert_removed_behind_later_path("later-custom", "custom-hooks", CustomHooksPath, None)
            .await;
    }

    #[tokio::test]
    async fn keep_local_hook_behind_a_later_manager_path_still_removes() {
        assert_removed_behind_later_path("later-husky", ".husky/_", HookManager, Some("husky"))
            .await;
    }

    #[tokio::test]
    async fn keep_local_hook_unreadable_file_is_an_error() {
        let (_g, _base, repo, _remote) = hook_repo("unreadable").await;
        let file = managed_file(&repo, "pre-push");
        std::fs::write(&file, b"#!/bin/sh\n").unwrap();
        // Hold the file so a read can't open it.
        #[cfg(windows)]
        let hold = {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&file)
                .unwrap()
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
            if std::fs::read(&file).is_ok() {
                eprintln!("skipped: this user can read a mode-000 file (root)");
                return;
            }
        }
        assert!(git_keep_local_hook_status(repo.clone()).await.is_err());
        assert!(git_keep_local_hook_install(repo.clone()).await.is_err());
        assert!(git_keep_local_hook_remove(repo.clone()).await.is_err());
        #[cfg(windows)]
        drop(hold);
        assert!(file.is_file());
    }

    /// A `pre-push` that is no regular file is never read, written or deleted.
    #[tokio::test]
    async fn keep_local_hook_treats_a_non_regular_pre_push_as_foreign() {
        let (_g, _base, repo, _remote) = hook_repo("dir").await;
        let file = managed_file(&repo, "pre-push");
        std::fs::create_dir(&file).unwrap();
        assert_status(&status(&repo).await, Blocked, Some(ForeignHook), None);
        assert_status(&install(&repo).await, Blocked, Some(ForeignHook), None);
        assert_status(&remove(&repo).await, Blocked, Some(ForeignHook), None);
        assert!(file.is_dir());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn keep_local_hook_never_opens_a_fifo_pre_push() {
        let (_g, _base, repo, _remote) = hook_repo("fifo").await;
        let file = managed_file(&repo, "pre-push");
        let made = std::process::Command::new("mkfifo").arg(&file).status();
        if !matches!(made, Ok(s) if s.success()) {
            eprintln!("skipped: mkfifo unavailable");
            return;
        }
        let read = tokio::time::timeout(std::time::Duration::from_secs(20), status(&repo));
        let st = read.await.expect("status must not block on a FIFO");
        assert_status(&st, Blocked, Some(ForeignHook), None);
        assert_status(&install(&repo).await, Blocked, Some(ForeignHook), None);
        assert_status(&remove(&repo).await, Blocked, Some(ForeignHook), None);
    }

    /// Makes a file symlink, or None where the platform refuses (Windows without the
    /// symlink privilege).
    fn try_symlink_file(target: &Path, link: &Path) -> Option<()> {
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(target, link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link);
        match made {
            Ok(()) => Some(()),
            Err(e) => {
                eprintln!("skipped: can't create a symlink here: {e}");
                None
            }
        }
    }

    fn try_symlink_dir(target: &Path, link: &Path) -> Option<()> {
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(target, link);
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link);
        match made {
            Ok(()) => Some(()),
            Err(e) => {
                eprintln!("skipped: can't create a symlink here: {e}");
                None
            }
        }
    }

    #[tokio::test]
    async fn keep_local_hook_never_follows_a_symlinked_pre_push() {
        let (_g, base, repo, _remote) = hook_repo("link").await;
        let outside = base.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let target = outside.join("pre-push");
        std::fs::write(&target, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        let link = managed_file(&repo, "pre-push");
        if try_symlink_file(&target, &link).is_none() {
            return;
        }
        let st = status(&repo).await;
        assert_status(&st, Blocked, Some(ForeignHook), None);
        assert_present(&st, false);
        assert_status(&install(&repo).await, Blocked, Some(ForeignHook), None);
        assert_status(&remove(&repo).await, Blocked, Some(ForeignHook), None);
        let meta = std::fs::symlink_metadata(&link).unwrap();
        assert!(meta.file_type().is_symlink(), "the link itself is kept");
        assert_eq!(
            std::fs::read(&target).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
    }

    #[tokio::test]
    async fn keep_local_hook_never_writes_through_a_symlinked_hooks_dir() {
        let (_g, base, repo, _remote) = hook_repo("dirlink").await;
        let outside = base.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let hooks = Path::new(&repo).join(".git").join("hooks");
        std::fs::remove_dir(&hooks).unwrap();
        if try_symlink_dir(&outside, &hooks).is_none() {
            return;
        }
        let st = status(&repo).await;
        assert_status(&st, Blocked, Some(CustomHooksPath), None);
        assert_redirected(&st, true);
        let st = install(&repo).await;
        assert_status(&st, Blocked, Some(CustomHooksPath), None);
        assert_redirected(&st, true);
        assert!(
            !outside.join("pre-push").exists(),
            "nothing written through it"
        );
        std::fs::write(outside.join("pre-push"), KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        assert_present(&status(&repo).await, false);
        let st = remove(&repo).await;
        assert_status(&st, Blocked, Some(CustomHooksPath), None);
        assert_redirected(&st, true);
        assert!(
            outside.join("pre-push").is_file(),
            "nothing deleted through it"
        );
    }

    /// Links `<repo>/.git/hooks` to `outside`: a junction when `junction` (Windows),
    /// else a directory symlink. None, with the reason printed, when it can't be made.
    fn link_hooks_dir(base: &Path, hooks: &Path, outside: &Path, junction: bool) -> Option<()> {
        if !junction {
            return try_symlink_dir(outside, hooks);
        }
        assert!(hooks.starts_with(base), "{hooks:?} under {base:?}");
        assert!(outside.starts_with(base), "{outside:?} under {base:?}");
        for path in [hooks, outside] {
            let shown = path.to_string_lossy();
            if shown.contains(['&', '|', '<', '>', '^', '%', '!', '(', ')', '"']) {
                eprintln!("skipped: temp path carries a cmd metacharacter: {shown}");
                return None;
            }
        }
        let made = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(hooks)
            .arg(outside)
            .output()
            .expect("spawn cmd mklink /J");
        assert!(
            made.status.success(),
            "mklink /J failed: {}",
            String::from_utf8_lossy(&made.stderr)
        );
        Some(())
    }

    /// Installs, then moves `.git/hooks` (hook and all) to `<base>/outside` and links
    /// it back: git still runs the hook, so remove deletes nothing and says so.
    async fn assert_remove_through_a_swapped_link(tag: &str, junction: bool) {
        let (_g, base, repo, _remote) = hook_repo(tag).await;
        let st = install(&repo).await;
        assert_status(&st, Installed, None, None);
        assert_redirected(&st, false);
        let hooks = base.join("repo").join(".git").join("hooks");
        let outside = base.join("outside");
        std::fs::rename(&hooks, &outside).unwrap();
        if link_hooks_dir(&base, &hooks, &outside, junction).is_none() {
            return;
        }
        for st in [status(&repo).await, remove(&repo).await] {
            assert_status(&st, Blocked, Some(CustomHooksPath), None);
            assert_present(&st, false);
            assert_redirected(&st, true);
        }
        assert_eq!(
            std::fs::read(outside.join("pre-push")).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
    }

    #[tokio::test]
    async fn keep_local_hook_remove_through_a_swapped_hooks_link_deletes_nothing_and_says_so() {
        assert_remove_through_a_swapped_link("swap-link", false).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn keep_local_hook_remove_through_a_swapped_hooks_junction_deletes_nothing() {
        assert_remove_through_a_swapped_link("swap-junction", true).await;
    }

    /// Behind a custom hooksPath the field still reports a linked `<common>/hooks`.
    async fn assert_custom_path_reports_a_linked_hooks_dir(tag: &str, junction: bool) {
        let (_g, base, repo, _remote) = hook_repo(tag).await;
        assert_status(&install(&repo).await, Installed, None, None);
        git_ok(&repo, &["config", "core.hooksPath", "custom-hooks"]).await;
        let st = status(&repo).await;
        assert_status(&st, Blocked, Some(CustomHooksPath), None);
        assert_present(&st, true);
        assert_redirected(&st, false);
        let hooks = base.join("repo").join(".git").join("hooks");
        let outside = base.join("outside");
        std::fs::rename(&hooks, &outside).unwrap();
        if link_hooks_dir(&base, &hooks, &outside, junction).is_none() {
            return;
        }
        let st = status(&repo).await;
        assert_status(&st, Blocked, Some(CustomHooksPath), None);
        assert_present(&st, false);
        assert_redirected(&st, true);
    }

    #[tokio::test]
    async fn keep_local_hook_custom_path_reports_a_linked_hooks_dir() {
        assert_custom_path_reports_a_linked_hooks_dir("custom-link", false).await;
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn keep_local_hook_custom_path_reports_a_junctioned_hooks_dir() {
        assert_custom_path_reports_a_linked_hooks_dir("custom-junction", true).await;
    }

    /// The create step itself never overwrites: a file already at `pre-push` (one
    /// that appeared after the status read) stays byte-identical, and no temp is left.
    #[tokio::test]
    async fn keep_local_hook_create_step_never_overwrites() {
        let (_g, _base, repo, _remote) = hook_repo("create-new").await;
        let dir = Path::new(&repo).join(".git").join("hooks");
        let file = dir.join("pre-push");
        let foreign = b"#!/bin/sh\necho mine\n";
        std::fs::write(&file, foreign).unwrap();
        assert!(!create_hook_file(&dir, &file).unwrap());
        assert_eq!(std::fs::read(&file).unwrap(), foreign);
        assert!(!create_hook_file_in_place(&file).unwrap());
        assert_eq!(std::fs::read(&file).unwrap(), foreign);
        // The rename step refuses a live file that is no longer ours.
        assert!(!replace_hook_file(&dir, &file).unwrap());
        assert_eq!(std::fs::read(&file).unwrap(), foreign);
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["pre-push"], "no temp file left behind");
    }

    #[tokio::test]
    async fn keep_local_hook_compares_hooks_dirs_by_place_not_name() {
        let (_g, base, repo, _remote) = hook_repo("same-dir").await;
        let managed = Path::new(&repo).join(".git").join("hooks");
        let other = base.join("other").join("hooks");
        assert!(!same_hooks_dir(&other, &managed));
        std::fs::remove_dir(&managed).unwrap();
        assert!(!same_hooks_dir(&other, &managed), "neither exists");
        let relative = Path::new(&repo).join("./.git/hooks");
        assert!(same_hooks_dir(&relative, &managed));
        if cfg!(windows) {
            let back = PathBuf::from(format!("{}\\.git\\hooks", repo.replace('/', "\\")));
            assert!(same_hooks_dir(&back, &managed));
        }
        // A relative core.hooksPath to the default dir stays installable.
        git_ok(&repo, &["config", "core.hooksPath", ".git/hooks"]).await;
        let st = status(&repo).await;
        assert_status(&st, Absent, None, None);
        assert!(!st.hooks_path.contains("/./") && !st.hooks_path.ends_with('/'));
        if cfg!(windows) {
            assert!(!st.hooks_path.contains('\\'), "{}", st.hooks_path);
        }
    }

    /// Sets `core.hooksPath` in `repo` (None unsets it) and resolves from `wt`.
    async fn resolve_with(repo: &str, wt: &str, value: Option<&str>) -> (PathBuf, bool) {
        match value {
            Some(v) => {
                git_ok(repo, &["config", "core.hooksPath", v]).await;
            }
            None => {
                let _ = git(repo, &["config", "--unset", "core.hooksPath"]).await;
            }
        }
        resolve_hooks_dir(wt).await.unwrap()
    }

    /// Whether a commit in `wt` runs a `pre-commit` placed in `dir`. The hook and its
    /// marker are removed afterwards, so the next row starts clean.
    async fn git_runs_hooks_from(wt: &str, dir: &Path, marker: &Path) -> bool {
        std::fs::create_dir_all(dir).unwrap();
        let hook = dir.join("pre-commit");
        let script = format!("#!/bin/sh\necho ran > \"{}\"\n", slashed(marker));
        std::fs::write(&hook, script).unwrap();
        set_hook_executable(&hook).unwrap();
        git_ok(wt, &["commit", "-q", "--allow-empty", "-m", "probe"]).await;
        std::fs::remove_file(&hook).unwrap();
        let ran = marker.exists();
        let _ = std::fs::remove_file(marker);
        ran
    }

    async fn add_linked_worktree(repo: &str, base: &Path) -> String {
        let wt = slashed(&base.join("wt"));
        git_ok(repo, &["worktree", "add", "-q", "-b", "wtb", &wt]).await;
        wt
    }

    /// For every value shape git resolves alike on all versions, the resolver names the
    /// folder a commit really runs hooks from, in the main and a linked worktree. An
    /// empty value is git's `./` answer, but git looks up `/<hook>` then, so it isn't run.
    #[tokio::test]
    async fn hooks_dir_is_where_git_runs_hooks_for_every_plain_shape() {
        let (_g, base, repo, _remote) = hook_repo("resolve-rows").await;
        let linked = add_linked_worktree(&repo, &base).await;
        let abs = slashed(&base.join("abs-hooks"));
        let marker = base.join("ran.txt");
        let managed = Path::new(&repo).join(".git").join("hooks");
        let default_dir = slashed(&managed);
        for wt in [repo.as_str(), linked.as_str()] {
            let root = Path::new(wt);
            // (value, expected dir, is_custom, git runs a hook placed there)
            let rows: [(Option<&str>, PathBuf, bool, bool); 5] = [
                (None, managed.clone(), false, true),
                (Some(&default_dir), managed.clone(), false, true),
                (Some("rel-hooks"), root.join("rel-hooks"), true, true),
                (Some(&abs), PathBuf::from(&abs), true, true),
                (Some(""), root.to_path_buf(), false, false),
            ];
            for (value, expected, custom, runs) in rows {
                let row = format!("{wt} {value:?}");
                let (dir, is_custom) = resolve_with(&repo, wt, value).await;
                let leaked = git(&repo, &["config", "--get", "core.hooksPath"]).await;
                if value.is_none() && leaked.code == 0 {
                    eprintln!("skipping {row}: a global config sets core.hooksPath");
                    continue;
                }
                assert!(dir.is_absolute(), "{row}: {dir:?}");
                assert!(
                    same_hooks_dir(&dir, &expected),
                    "{row}: {dir:?} vs {expected:?}"
                );
                assert_eq!(is_custom, custom, "{row}");
                if runs {
                    assert!(
                        git_runs_hooks_from(wt, &dir, &marker).await,
                        "{row}: git ran no hook in {dir:?}"
                    );
                }
            }
        }
    }

    /// A `~` value resolves under the home folder git expands it to, never under the
    /// repository. Nothing is created there.
    #[tokio::test]
    async fn hooks_dir_expands_a_tilde_value_like_git() {
        let (_g, base, repo, _remote) = hook_repo("resolve-tilde").await;
        let linked = add_linked_worktree(&repo, &base).await;
        let name = format!(
            "gd-tilde-hooks-{}",
            base.file_name().unwrap().to_string_lossy()
        );
        let value = format!("~/{name}");
        for wt in [repo.as_str(), linked.as_str()] {
            let (dir, custom) = resolve_with(&repo, wt, Some(&value)).await;
            assert!(dir.is_absolute(), "{wt}: {dir:?}");
            assert!(
                !dir.components().any(|c| c.as_os_str() == "~"),
                "{wt}: {dir:?}"
            );
            assert!(
                !slashed(&dir).starts_with(&slashed(&base)),
                "{wt}: {dir:?} is under the repository"
            );
            assert_eq!(dir.file_name(), Some(std::ffi::OsStr::new(&name)), "{wt}");
            assert!(!dir.exists(), "{wt}: nothing created in the home folder");
            assert!(custom, "{wt}");
            assert_status(&status(wt).await, Blocked, Some(CustomHooksPath), None);
        }
    }

    /// `:(optional)` values follow the installed git: a prefix-stripping git (2.52+) uses
    /// an existing dir and ignores a missing one, so the managed hook installs; an older
    /// git prints the value as is, and the status reads custom.
    #[tokio::test]
    async fn hooks_dir_follows_git_on_optional_values() {
        let (_g, base, repo, _remote) = hook_repo("resolve-optional").await;
        let linked = add_linked_worktree(&repo, &base).await;
        let present = base.join("opt-present");
        std::fs::create_dir_all(&present).unwrap();
        let present_value = format!(":(optional){}", slashed(&present));
        let missing_value = format!(":(optional){}", slashed(&base.join("opt-missing")));
        git_ok(&repo, &["config", "core.hooksPath", &present_value]).await;
        let printed = git_ok(&repo, &["rev-parse", "--git-path", "hooks"]).await;
        let strips = !printed.starts_with(":(optional)");
        eprintln!("installed git strips :(optional): {strips}");
        let managed = Path::new(&repo).join(".git").join("hooks");
        std::fs::remove_dir(&managed).unwrap();
        for wt in [repo.as_str(), linked.as_str()] {
            let (dir, custom) = resolve_with(&repo, wt, Some(&present_value)).await;
            if strips {
                assert!(same_hooks_dir(&dir, &present), "{wt}: {dir:?}");
            } else {
                let printed = git_ok(wt, &["rev-parse", "--git-path", "hooks"]).await;
                assert_eq!(dir, absolutize(wt, &printed), "{wt}");
            }
            assert!(custom, "{wt}: existing optional dir");
            assert_status(&status(wt).await, Blocked, Some(CustomHooksPath), None);

            let (dir, custom) = resolve_with(&repo, wt, Some(&missing_value)).await;
            if strips {
                assert!(same_hooks_dir(&dir, &managed), "{wt}: {dir:?}");
                assert!(!custom, "{wt}: an ignored optional dir redirects nothing");
                assert_status(&status(wt).await, Absent, None, None);
            } else {
                let printed = git_ok(wt, &["rev-parse", "--git-path", "hooks"]).await;
                assert_eq!(dir, absolutize(wt, &printed), "{wt}");
                assert!(custom, "{wt}: missing optional dir");
                assert_status(&status(wt).await, Blocked, Some(CustomHooksPath), None);
            }
        }
        if strips {
            assert_status(&install(&repo).await, Installed, None, None);
            assert!(managed_file(&repo, "pre-push").is_file());
        }
        assert!(!present.join("pre-push").exists(), "nothing written there");
    }

    /// The hook and the Rust guard agree on every flag shape: refuse = guard Ok(true)
    /// or Err, allow = guard Ok(false).
    #[tokio::test]
    async fn keep_local_hook_and_guard_agree_on_every_flag_shape() {
        let (_g, _base, repo, remote) = hook_repo("shapes").await;
        assert_status(&install(&repo).await, Installed, None, None);
        git_ok(&repo, &["checkout", "-q", "-b", "feat/x"]).await;
        let key = crate::git::branches::keep_local_key("feat/x");
        let config = Path::new(&repo).join(".git").join("config");
        let valueless = "[branch \"feat/x\"]\n\tgitdesktopLocalOnly\n";
        // (name, values added in order, or None for a valueless key, refuses)
        let rows: [(&str, Option<&[&str]>, bool); 6] = [
            ("valueless", None, true),
            ("empty", Some(&[""]), false),
            ("true then false", Some(&["true", "false"]), false),
            ("maybe then true", Some(&["maybe", "true"]), true),
            ("maybe then false", Some(&["maybe", "false"]), true),
            ("true", Some(&["true"]), true),
        ];
        for (name, values, refuses) in rows {
            let _ = git(&repo, &["config", "--unset-all", &key]).await;
            match values {
                None => {
                    let mut text = std::fs::read_to_string(&config).unwrap();
                    text.push_str(valueless);
                    std::fs::write(&config, text).unwrap();
                }
                Some(values) => {
                    for value in values {
                        git_ok(&repo, &["config", "--add", &key, value]).await;
                    }
                }
            }
            let guard = crate::git::branches::branch_keep_local(&repo, "feat/x").await;
            assert_eq!(
                !matches!(guard, Ok(false)),
                refuses,
                "{name}: guard {guard:?}"
            );
            let tip = commit(&repo, name).await;
            let out = git(&repo, &["push", "origin", "HEAD"]).await;
            assert_eq!(out.code != 0, refuses, "{name}: hook {}", out.stderr);
            let landed = remote_tip(&remote, "feat/x").await == Some(tip);
            assert_eq!(landed, !refuses, "{name}: landed");
        }
    }

    #[tokio::test]
    async fn keep_local_hook_stops_upstream_and_all_pushes_and_passes_detached() {
        let (_g, _base, repo, remote) = hook_repo("forms").await;
        assert_status(&install(&repo).await, Installed, None, None);
        git_ok(&repo, &["checkout", "-q", "-b", "feat/x"]).await;
        crate::git::branches::set_branch_keep_local_core(&repo, "feat/x", true)
            .await
            .unwrap();
        let tip = commit(&repo, "marked").await;
        let marked = "is marked Keep local";
        let upstream = ["push", "-u", "origin", "HEAD"];
        assert_stopped(&repo, &upstream, "feat/x", marked).await;
        assert_stopped(&repo, &["push", "--all", "origin"], "feat/x", marked).await;
        assert_eq!(remote_tip(&remote, "feat/x").await, None);
        assert_eq!(
            remote_tip(&remote, "main").await,
            None,
            "--all sent nothing"
        );
        // A detached HEAD names no branch, so the hook lets it through.
        git_ok(&repo, &["checkout", "-q", "--detach"]).await;
        let detached = ["push", "origin", "HEAD:refs/heads/x"];
        let out = git(&repo, &detached).await;
        assert_eq!(out.code, 0, "{}", out.full_failure_text());
        assert_eq!(remote_tip(&remote, "x").await, Some(tip));
    }

    #[tokio::test]
    async fn keep_local_hook_lands_in_the_common_dir_from_a_linked_worktree() {
        let (_g, base, repo, remote) = hook_repo("linked").await;
        let wt = slashed(&base.join("wt"));
        git_ok(&repo, &["worktree", "add", "-q", "-b", "wtb", &wt]).await;
        assert_status(&install(&wt).await, Installed, None, None);
        assert!(managed_file(&repo, "pre-push").is_file());
        assert_status(&status(&repo).await, Installed, None, None);
        crate::git::branches::set_branch_keep_local_core(&repo, "wtb", true)
            .await
            .unwrap();
        commit(&wt, "wt change").await;
        let stopped = "is marked Keep local";
        assert_stopped(&wt, &["push", "origin", "HEAD"], "wtb", stopped).await;
        assert_eq!(remote_tip(&remote, "wtb").await, None);
        let pushed = git(&wt, &["push", "--no-verify", "origin", "HEAD"]).await;
        assert_eq!(pushed.code, 0, "{}", pushed.full_failure_text());
        assert!(remote_tip(&remote, "wtb").await.is_some());
    }

    #[tokio::test]
    async fn keep_local_hook_stops_a_marked_push_and_passes_the_rest() {
        let (_g, _base, repo, remote) = hook_repo("push").await;
        assert_status(&install(&repo).await, Installed, None, None);
        let marked = "is marked Keep local";
        let marked_line = "\"feat/x\" is marked Keep local, so this push was stopped. Turn off";
        let push_ok = |args: &'static [&'static str]| {
            let repo = repo.clone();
            async move {
                let out = git(&repo, args).await;
                assert_eq!(out.code, 0, "git {args:?}: {}", out.full_failure_text());
            }
        };
        // Unmarked branches push through the installed hook.
        push_ok(&["push", "origin", "main"]).await;
        git_ok(&repo, &["checkout", "-q", "-b", "feat/x"]).await;
        let c1 = commit(&repo, "c1").await;
        push_ok(&["push", "-u", "origin", "feat/x"]).await;
        crate::git::branches::set_branch_keep_local_core(&repo, "feat/x", true)
            .await
            .unwrap();
        let c2 = commit(&repo, "c2").await;
        assert_stopped(&repo, &["push", "origin", "HEAD"], "feat/x", marked).await;
        assert_stopped(&repo, &["push"], "feat/x", marked).await;
        let forced = ["push", "--force", "origin", "HEAD"];
        assert_stopped(&repo, &forced, "feat/x", marked).await;
        let renamed = ["push", "origin", "feat/x:refs/heads/other"];
        assert_stopped(&repo, &renamed, "feat/x", marked).await;
        let two = [
            "push",
            "origin",
            "main:refs/heads/m2",
            "feat/x:refs/heads/x2",
        ];
        assert_stopped(&repo, &two, "feat/x", marked).await;
        assert_eq!(remote_tip(&remote, "feat/x").await, Some(c1.clone()));
        for absent in ["other", "m2", "x2"] {
            assert_eq!(remote_tip(&remote, absent).await, None, "{absent}");
        }
        // Tags, deletes and a sha source are not a branch's local side.
        git_ok(&repo, &["tag", "v1"]).await;
        push_ok(&["push", "origin", "refs/tags/v1"]).await;
        let sha_push = [c2.as_str(), ":refs/heads/y"].concat();
        let out = git(&repo, &["push", "origin", &sha_push]).await;
        assert_eq!(out.code, 0, "{}", out.full_failure_text());
        push_ok(&["push", "origin", "--delete", "y"]).await;
        // A junk value can't be read as a bool, so the push stops.
        let flag = "branch.feat/x.gitdesktopLocalOnly";
        git_ok(&repo, &["config", flag, "maybe"]).await;
        let out = git(&repo, &["push", "origin", "HEAD"]).await;
        assert_ne!(out.code, 0);
        assert!(
            out.stderr
                .contains("could not read whether \"feat/x\" is marked Keep local")
                && !out.stderr.contains(marked_line),
            "{}",
            out.stderr
        );
        // A false value allows; a manager config appearing later doesn't disarm it.
        git_ok(&repo, &["config", flag, "false"]).await;
        push_ok(&["push", "origin", "HEAD"]).await;
        assert_eq!(remote_tip(&remote, "feat/x").await, Some(c2));
        git_ok(&repo, &["config", flag, "true"]).await;
        let c3 = commit(&repo, "c3").await;
        std::fs::write(Path::new(&repo).join(".pre-commit-config.yaml"), "x\n").unwrap();
        std::fs::write(Path::new(&repo).join("lefthook.yml"), "x\n").unwrap();
        std::fs::create_dir(Path::new(&repo).join(".husky")).unwrap();
        assert_status(&status(&repo).await, Installed, None, None);
        assert_stopped(&repo, &["push", "origin", "HEAD"], "feat/x", marked).await;
        // --no-verify skips the hook.
        push_ok(&["push", "--no-verify", "origin", "HEAD"]).await;
        assert_eq!(remote_tip(&remote, "feat/x").await, Some(c3));
    }

    /// Writes `body` as the repository's own pre-push hook, executable.
    fn write_pre_push(repo: &str, body: &str) {
        let file = managed_file(repo, "pre-push");
        std::fs::write(&file, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// The managed script run with errexit on (git runs the hook through its own sh)
    /// passes an unmarked branch and stops a marked one.
    #[tokio::test]
    async fn keep_local_hook_script_runs_under_errexit() {
        let (_g, _base, repo, remote) = hook_repo("errexit").await;
        let body = KEEP_LOCAL_HOOK_SCRIPT.strip_prefix("#!/bin/sh\n").unwrap();
        write_pre_push(&repo, &format!("#!/bin/sh\nset -e\n{body}"));
        git_ok(&repo, &["checkout", "-q", "-b", "feat/x"]).await;
        let tip = commit(&repo, "unmarked").await;
        let out = git(&repo, &["push", "origin", "HEAD"]).await;
        assert_eq!(out.code, 0, "unmarked: {}", out.full_failure_text());
        assert_eq!(remote_tip(&remote, "feat/x").await, Some(tip.clone()));
        crate::git::branches::set_branch_keep_local_core(&repo, "feat/x", true)
            .await
            .unwrap();
        commit(&repo, "marked").await;
        let marked = "is marked Keep local";
        assert_stopped(&repo, &["push", "origin", "HEAD"], "feat/x", marked).await;
        assert_eq!(remote_tip(&remote, "feat/x").await, Some(tip));
    }

    /// The snippet pasted into a host hook under `flags`: an unmarked branch (a quoted
    /// name included) and a detached HEAD pushing `HEAD` let the host hook run on to its
    /// last line; a marked branch stops it there.
    async fn assert_host_hook_continues(flags: &str, tag: &str) {
        const SENTINEL: &str = "host hook reached its last line";
        let (_g, _base, repo, remote) = hook_repo(tag).await;
        let snippet = keep_local_hook_snippet();
        let host = format!("#!/bin/sh\nset {flags}\n{snippet}echo '{SENTINEL}' >&2\n");
        assert!(host.is_ascii() && !host.contains('\r'));
        write_pre_push(&repo, &host);
        // A `"` would be a valid ref name, but no Windows file name can carry one.
        for branch in ["feat/x", "it's"] {
            let row = format!("set {flags}, {branch}");
            git_ok(&repo, &["checkout", "-q", "-b", branch]).await;
            let tip = commit(&repo, &format!("{branch} unmarked")).await;
            let out = git(&repo, &["push", "origin", "HEAD"]).await;
            assert_eq!(out.code, 0, "{row}: {}", out.full_failure_text());
            assert!(out.stderr.contains(SENTINEL), "{row}: {}", out.stderr);
            let landed = remote_tip(&remote, branch).await;
            assert_eq!(landed, Some(tip.clone()), "{row}");
            let key = crate::git::branches::keep_local_key(branch);
            git_ok(&repo, &["config", &key, "true"]).await;
            commit(&repo, &format!("{branch} marked")).await;
            let out = git(&repo, &["push", "origin", "HEAD"]).await;
            assert_ne!(out.code, 0, "{row}: marked");
            assert!(
                out.stderr
                    .contains(&format!("\"{branch}\" is marked Keep local"))
                    && !out.stderr.contains(SENTINEL),
                "{row}: {}",
                out.stderr
            );
            assert_eq!(remote_tip(&remote, branch).await, Some(tip), "{row}");
        }
        git_ok(&repo, &["checkout", "-q", "--detach"]).await;
        let out = git(&repo, &["push", "origin", "HEAD:refs/heads/d"]).await;
        assert_eq!(out.code, 0, "detached: {}", out.full_failure_text());
        assert!(out.stderr.contains(SENTINEL), "set {flags}: {}", out.stderr);
        let head = git_ok(&repo, &["rev-parse", "HEAD"]).await;
        assert_eq!(remote_tip(&remote, "d").await, Some(head));
    }

    #[tokio::test]
    async fn keep_local_hook_snippet_keeps_a_set_e_host_hook_running() {
        assert_host_hook_continues("-e", "host-e").await;
    }

    #[tokio::test]
    async fn keep_local_hook_snippet_keeps_a_set_eu_host_hook_running() {
        assert_host_hook_continues("-eu", "host-eu").await;
    }
}
