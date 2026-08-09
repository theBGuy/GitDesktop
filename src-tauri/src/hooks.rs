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

/// Resolves the effective hooks directory, honoring `core.hooksPath`. Returns
/// `(absolute_dir, is_custom)`.
async fn resolve_hooks_dir(repo_path: &str) -> AppResult<(PathBuf, bool)> {
    let cfg = run_git_raw(
        Some(repo_path),
        &["config", "--get", "core.hooksPath"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if cfg.code == 0 {
        let value = cfg.stdout_lossy().trim().to_string();
        if !value.is_empty() {
            return Ok((absolutize(repo_path, &value), true));
        }
    }
    let out = run_git(
        Some(repo_path),
        &["rev-parse", "--git-path", "hooks"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok((absolutize(repo_path, out.stdout_lossy().trim()), false))
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
    let mut cmd = tokio::process::Command::new(&manager);
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
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::Command(format!(
                    "{manager} isn't installed or isn't on your PATH."
                ))
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
                trash::delete(&path)
                    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
            })
            .await
            .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
        }
    }
    Ok(())
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
}
