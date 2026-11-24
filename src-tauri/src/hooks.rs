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
    /// The active `pre-push` is GitDesktop's own Keep local guard, exactly when the
    /// guard status for this repository reads installed; false on any failed read.
    pub managed: bool,
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
/// prefix), which only git applies. Returns `(absolute_dir, is_custom, is_empty)`: an
/// empty value prints the repository root, though git looks up `/<hook>` and runs no
/// hook from that root.
async fn resolve_hooks_dir(repo_path: &str) -> AppResult<(PathBuf, bool, bool)> {
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
    let value = cfg.stdout_lossy();
    let set = cfg.code == 0 && !value.trim().is_empty();
    let empty = cfg.code == 0 && value.trim_end_matches(['\r', '\n']).is_empty();
    // A value git ignores (a missing optional dir) or that names the managed dir
    // redirects nothing; an unresolvable managed dir keeps the value's own answer.
    let custom = set
        && match managed_hooks_dir(repo_path).await {
            Ok(managed) => !same_hooks_dir(&dir, &managed),
            Err(_) => true,
        };
    Ok((dir, custom, empty))
}

/// Detects a hook manager that owns this repo's hooks (and its config path). husky is a
/// `<root>/.husky` folder, or a `.husky` component of the hooks dir: below the root only
/// in the part under it, so a repository stored inside a `.husky` folder isn't husky.
/// The component matches exactly, never case-folded; the config is that `.husky` folder.
fn detect_manager(repo_path: &str, hooks_dir: &Path) -> Option<(String, PathBuf)> {
    let root = Path::new(repo_path);
    if root.join(".husky").is_dir() {
        return Some(("husky".to_string(), root.join(".husky")));
    }
    if let Some(husky) = husky_dir_in_hooks_path(root, hooks_dir) {
        return Some(("husky".to_string(), husky));
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

/// The `.husky` folder a hooks dir sits in: the first exact `.husky` component of the
/// part below `root` when the dir is under it, else of the whole `..`-normalized path,
/// since git prints a climbing `core.hooksPath` verbatim.
fn husky_dir_in_hooks_path(root: &Path, hooks_dir: &Path) -> Option<PathBuf> {
    let normal = normal_hooks_dir(hooks_dir);
    let (side, skip) = match hooks_dir_below_root(root, &normal) {
        Some(below) => below,
        None => (normal, 0),
    };
    let at = side
        .components()
        .skip(skip)
        .position(|c| c.as_os_str() == ".husky")?;
    Some(side.components().take(skip + at + 1).collect())
}

/// When `normal`, the `..`-normalized hooks dir, is under `root`: that spelling and how
/// many of its components spell the root. Lexical first (separators normalized, case
/// folded only on Windows), then the nearest ancestor whose canonical form is the
/// root's, so `/var` vs `/private/var`, 8.3 names and a linked ancestor still compare
/// while links below the root keep their names. With no such ancestor, a link that
/// enters the clone below its root is judged by its canonical form.
fn hooks_dir_below_root(root: &Path, normal: &Path) -> Option<(PathBuf, usize)> {
    if let Some(skip) = root_prefix_len(root, normal) {
        return Some((normal.to_path_buf(), skip));
    }
    let root = dunce::canonicalize(root).ok()?;
    if let Some(at) = normal
        .ancestors()
        .find(|a| dunce::canonicalize(a).is_ok_and(|a| a == root))
    {
        return Some((normal.to_path_buf(), at.components().count()));
    }
    let landed = canonicalize_existing_prefix(normal)?;
    root_prefix_len(&root, &landed).map(|skip| (landed, skip))
}

/// `hooks_dir` with its `..` collapsed the way the OS opens it. Win32 collapses `..`
/// lexically before the filesystem sees the path. A unix kernel resolves each `..`
/// after the links before it, so when the part through the last `..` names another
/// folder lexically, its physical form wins, the names after it kept as spelled; a
/// lexical spelling of the same folder is kept as written.
fn normal_hooks_dir(hooks_dir: &Path) -> PathBuf {
    let normal = lexically_normal(hooks_dir);
    #[cfg(unix)]
    {
        use std::path::Component;
        let parts: Vec<Component> = hooks_dir.components().collect();
        if let Some(last) = parts.iter().rposition(|c| *c == Component::ParentDir) {
            let prefix: PathBuf = parts[..=last].iter().collect();
            let lexical = canonicalize_existing_prefix(&lexically_normal(&prefix));
            if let Ok(physical) = dunce::canonicalize(&prefix) {
                if Some(&physical) != lexical.as_ref() {
                    return parts[last + 1..]
                        .iter()
                        .fold(physical, |acc, c| acc.join(c));
                }
            }
        }
    }
    normal
}

/// `path` with each `..` popping the normal component before it, lexically; a `..` with
/// nothing to pop stays.
fn lexically_normal(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut parts: Vec<Component> = Vec::new();
    for c in path.components() {
        if c == Component::ParentDir && matches!(parts.last(), Some(Component::Normal(_))) {
            parts.pop();
        } else {
            parts.push(c);
        }
    }
    parts.iter().collect()
}

/// The number of `hooks` components that spell `root`, or None when `root` isn't a
/// lexical prefix or a `..` follows it.
fn root_prefix_len(root: &Path, hooks: &Path) -> Option<usize> {
    let same = |a: &std::ffi::OsStr, b: &std::ffi::OsStr| {
        if cfg!(windows) {
            a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
        } else {
            a == b
        }
    };
    let root: Vec<_> = root.components().collect();
    let hooks: Vec<_> = hooks.components().collect();
    let matched = root.len() <= hooks.len()
        && root
            .iter()
            .zip(&hooks)
            .all(|(a, b)| same(a.as_os_str(), b.as_os_str()));
    let climbs = hooks
        .iter()
        .skip(root.len())
        .any(|c| matches!(c, std::path::Component::ParentDir));
    (matched && !climbs).then_some(root.len())
}

/// `path` canonicalized through its nearest existing ancestor, the missing tail
/// re-joined as spelled.
fn canonicalize_existing_prefix(path: &Path) -> Option<PathBuf> {
    let mut tail = Vec::new();
    let mut at = path;
    loop {
        if let Ok(found) = dunce::canonicalize(at) {
            return Some(tail.iter().rev().fold(found, |acc, part| acc.join(part)));
        }
        tail.push(at.file_name()?);
        at = at.parent()?;
    }
}

#[tauri::command]
pub async fn git_hooks_list(repo_path: String) -> AppResult<HooksInfo> {
    let (hooks_dir, custom, _) = resolve_hooks_dir(&repo_path).await?;
    let detected = detect_manager(&repo_path, &hooks_dir);
    let manager = detected.as_ref().map(|(m, _)| m.clone());
    let manager_config = detected
        .as_ref()
        .map(|(_, p)| p.to_string_lossy().into_owned());
    let mut entries: Vec<HookEntry> = KNOWN_HOOKS
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
                managed: false,
            }
        })
        .collect();
    if let Some(pre_push) = entries
        .iter_mut()
        .find(|e| e.name == "pre-push" && matches!(e.state, HookState::Active))
    {
        pre_push.managed = hook_is_managed(&repo_path, &hooks_dir, "pre-push").await;
    }
    Ok(HooksInfo {
        hooks_path: hooks_dir.to_string_lossy().into_owned(),
        custom_hooks_path: custom,
        manager,
        manager_config,
        entries,
    })
}

/// Whether `name` in the listed hooks dir is GitDesktop's managed guard, by the three
/// reads that make the Keep local guard status `installed`, so the Hooks list never
/// labels a file the guard dialog calls blocked. A name other than `pre-push`, no such
/// file (a hooks path through a file included), a directory or symlink in its place,
/// another hooks dir, a redirected one or a file without the marker is `false`; a read
/// that fails on what exists, or a failed common-dir read, is the `Err`. The entry is
/// classified by its own lstat, so a symlink is `false` whatever it points at; one
/// swapped in after that lstat can still be followed by the marker read ([`hook_file`]
/// states that race). A failure reading the entry (its lstat or its marker read) is
/// [`ManagedReadError::Entry`], which callers turn into a sentence; any other failure
/// keeps its own error.
async fn hook_managed_state(
    repo_path: &str,
    hooks_dir: &Path,
    name: &str,
) -> Result<bool, ManagedReadError> {
    if name != "pre-push" {
        return Ok(false);
    }
    match std::fs::symlink_metadata(hooks_dir.join(name)) {
        Ok(meta) if meta.is_file() => {}
        Ok(_) => return Ok(false),
        Err(e) if is_absent(&e) => return Ok(false),
        Err(e) => return Err(ManagedReadError::Entry(e)),
    }
    let managed = managed_hooks_dir(repo_path)
        .await
        .map_err(ManagedReadError::Other)?;
    if !same_hooks_dir(hooks_dir, &managed)
        || hooks_dir_redirected(&managed).map_err(|e| ManagedReadError::Other(AppError::Io(e)))?
    {
        return Ok(false);
    }
    let file = hook_file(&managed.join("pre-push")).map_err(ManagedReadError::Entry)?;
    Ok(file == HookFile::Ours)
}

/// Why [`hook_managed_state`] failed: reading the hook entry itself, or anything else
/// (the common-dir git read, the hooks-folder lstat).
#[derive(Debug)]
enum ManagedReadError {
    Entry(std::io::Error),
    Other(AppError),
}

/// The caller's error for a failed managed read: an entry failure is a sentence naming
/// what wasn't done (`verb`), with the cause on the next line; the rest pass through.
fn managed_read_error(err: ManagedReadError, name: &str, verb: &str) -> AppError {
    match err {
        ManagedReadError::Entry(e) => {
            AppError::Command(format!("Couldn't read {name}, so nothing was {verb}.\n{e}"))
        }
        ManagedReadError::Other(e) => e,
    }
}

/// The lstat answers that mean nothing is at the path (a hooks path through a file
/// included).
fn is_absent(e: &std::io::Error) -> bool {
    matches!(
        e.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

/// [`hook_managed_state`] for the list's `HookEntry.managed` and a write's outcome,
/// where a failed read is `false`; the expected-state checks read the fallible one.
async fn hook_is_managed(repo_path: &str, hooks_dir: &Path, name: &str) -> bool {
    hook_managed_state(repo_path, hooks_dir, name)
        .await
        .unwrap_or(false)
}

/// The expected-state check of a write, toggle or delete: `Some(now)` when the managed
/// state read now differs from `expected`, None when it matches or nothing is expected.
async fn managed_changed(
    repo_path: &str,
    dir: &Path,
    name: &str,
    expected: Option<bool>,
    verb: &str,
) -> AppResult<Option<bool>> {
    let Some(expected) = expected else {
        return Ok(None);
    };
    let managed = hook_managed_state(repo_path, dir, name)
        .await
        .map_err(|e| managed_read_error(e, name, verb))?;
    Ok((managed != expected).then_some(managed))
}

/// Refuses a write or rename at `path` when it is a link (a junction included): git
/// would run whatever it points at, and the write would land there. Nothing at the path
/// passes; a failed lstat refuses, since it can't tell.
fn refuse_link(path: &Path, verb: &str, act: &str) -> AppResult<()> {
    let file = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    link_refusal(std::fs::symlink_metadata(path), &file, verb, act)
}

/// [`refuse_link`]'s answer for the lstat of `file`.
fn link_refusal(
    lstat: std::io::Result<std::fs::Metadata>,
    file: &str,
    verb: &str,
    act: &str,
) -> AppResult<()> {
    match lstat {
        Ok(meta) if meta.file_type().is_symlink() => Err(AppError::Command(format!(
            "{file} is a link, so GitDesktop won't {act}. Edit or replace the link outside GitDesktop."
        ))),
        Ok(_) => Ok(()),
        Err(e) if is_absent(&e) => Ok(()),
        Err(e) => Err(managed_read_error(ManagedReadError::Entry(e), file, verb)),
    }
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
    let (dir, _, _) = resolve_hooks_dir(&repo_path).await?;
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

/// Whether a hook write or toggle landed; [`HookWriteOutcome`] gives each its meaning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HookWriteStatus {
    Written,
    ManagedChanged,
}

/// What a hook write or toggle did. `written`: the change landed (or there was nothing
/// to rename), `managed` being the list's read after it; `managedChanged`: nothing
/// changed because the managed state no longer matches the caller's list, `managed`
/// being the value read now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookWriteOutcome {
    pub status: HookWriteStatus,
    pub managed: bool,
}

impl HookWriteOutcome {
    fn managed_changed(managed: bool) -> Self {
        Self {
            status: HookWriteStatus::ManagedChanged,
            managed,
        }
    }

    async fn written(repo_path: &str, dir: &Path, name: &str) -> Self {
        Self {
            status: HookWriteStatus::Written,
            managed: hook_is_managed(repo_path, dir, name).await,
        }
    }
}

/// Writes (creating or replacing) a hook's script and makes it active: the file
/// is written as `<name>` and marked executable, and any disabled twin removed (a link
/// there, a junction included, is removed itself, never followed; a failed removal is
/// ignored). With an expected managed state, a hook whose
/// managed state changed since the caller's list is left alone, and one that can't be
/// read is the `Err`. A `<name>` that is a link is refused whatever is expected. Both
/// refusals run before the hooks dir is created; check and write are not atomic.
#[tauri::command]
pub async fn git_hook_write(
    repo_path: String,
    name: String,
    content: String,
    expected_managed: Option<bool>,
) -> AppResult<HookWriteOutcome> {
    validate_hook_name(&name)?;
    let (dir, _, _) = resolve_hooks_dir(&repo_path).await?;
    if let Some(managed) =
        managed_changed(&repo_path, &dir, &name, expected_managed, "saved").await?
    {
        return Ok(HookWriteOutcome::managed_changed(managed));
    }
    let path = dir.join(&name);
    refuse_link(&path, "saved", "save through it")?;
    tokio::fs::create_dir_all(&dir).await.map_err(AppError::Io)?;
    tokio::fs::write(&path, content).await.map_err(AppError::Io)?;
    make_executable(&path).await?;
    let twin = dir.join(format!("{name}.disabled"));
    if let Ok(meta) = std::fs::symlink_metadata(&twin) {
        let _ = if meta.file_type().is_symlink() {
            remove_link(&twin, &meta)
        } else {
            std::fs::remove_file(&twin)
        };
    }
    Ok(HookWriteOutcome::written(&repo_path, &dir, &name).await)
}

/// Enables/disables a hook by renaming between `<name>` and `<name>.disabled`,
/// so the script is kept either way (git only runs the unsuffixed file). The expected
/// managed state is checked as [`git_hook_write`] checks it, and a link at either name
/// is refused, since the rename's checks and enable's chmod would follow it. A toggle
/// with nothing to rename is `written`; check and rename are not atomic.
#[tauri::command]
pub async fn git_hook_set_enabled(
    repo_path: String,
    name: String,
    enabled: bool,
    expected_managed: Option<bool>,
) -> AppResult<HookWriteOutcome> {
    validate_hook_name(&name)?;
    let (dir, _, _) = resolve_hooks_dir(&repo_path).await?;
    let (verb, act) = if enabled {
        ("enabled", "enable it")
    } else {
        ("disabled", "disable it")
    };
    if let Some(managed) = managed_changed(&repo_path, &dir, &name, expected_managed, verb).await? {
        return Ok(HookWriteOutcome::managed_changed(managed));
    }
    let active = dir.join(&name);
    let disabled = dir.join(format!("{name}.disabled"));
    refuse_link(&active, verb, act)?;
    refuse_link(&disabled, verb, act)?;
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
    Ok(HookWriteOutcome::written(&repo_path, &dir, &name).await)
}

/// What a hook delete did: deleted, or nothing deleted because the hook's managed
/// state no longer matches the caller's list, `managed` being the value read now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HookDeleteOutcome {
    Deleted,
    ManagedChanged { managed: bool },
}

/// Deletes a hook (active and disabled variants): a link (dangling, looping or a
/// junction included) is unlinked, never followed, so its target stays unless it is the
/// hook's other name, and anything else at the path goes to the OS recycle bin, so a
/// hand-written script can be recovered. With an
/// expected managed state, a hook whose managed state changed since the caller's list is
/// left alone, and one that can't be read is the `Err` with nothing deleted; the check
/// and the delete are not atomic. A failure is a sentence naming what was already done.
#[tauri::command]
pub async fn git_hook_delete(
    repo_path: String,
    name: String,
    expected_managed: Option<bool>,
) -> AppResult<HookDeleteOutcome> {
    hook_delete_core(
        &repo_path,
        &name,
        expected_managed,
        crate::fsops::trash_delete,
    )
    .await
}

/// [`git_hook_delete`] with the recycle-bin call injected, so a test can make it refuse.
async fn hook_delete_core(
    repo_path: &str,
    name: &str,
    expected_managed: Option<bool>,
    trash: impl Fn(&Path) -> std::io::Result<()> + Send + 'static,
) -> AppResult<HookDeleteOutcome> {
    validate_hook_name(name)?;
    let (dir, _, _) = resolve_hooks_dir(repo_path).await?;
    if let Some(managed) =
        managed_changed(repo_path, &dir, name, expected_managed, "deleted").await?
    {
        return Ok(HookDeleteOutcome::ManagedChanged { managed });
    }
    let name = name.to_string();
    tauri::async_runtime::spawn_blocking(move || delete_hook_files(&dir, &name, trash))
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    Ok(HookDeleteOutcome::Deleted)
}

/// Removes `<name>` then `<name>.disabled` from `dir`, each read without following.
fn delete_hook_files(
    dir: &Path,
    name: &str,
    trash: impl Fn(&Path) -> std::io::Result<()>,
) -> AppResult<()> {
    let mut done: Option<String> = None;
    for file in [name.to_string(), format!("{name}.disabled")] {
        let path = dir.join(&file);
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) if is_absent(&e) => continue,
            Err(e) => return Err(delete_failure(done.as_deref(), &format!("read {file}"), &e)),
        };
        if meta.file_type().is_symlink() {
            remove_link(&path, &meta).map_err(|e| {
                delete_failure(done.as_deref(), &format!("remove the {file} link"), &e)
            })?;
            done = Some(format!("Removed the {file} link"));
        } else {
            trash(&path).map_err(|e| {
                let act = format!("move {file} to the recycle bin");
                delete_failure(done.as_deref(), &act, &e)
            })?;
            done = Some(format!("Moved {file} to the recycle bin"));
        }
    }
    Ok(())
}

/// Unlinks a link itself: `remove_dir` for a Windows directory link or junction, else
/// `remove_file` (which unlinks a unix link to a directory too).
fn remove_link(path: &Path, meta: &std::fs::Metadata) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if meta.file_type().is_symlink_dir() {
            return std::fs::remove_dir(path);
        }
    }
    #[cfg(not(windows))]
    let _ = meta;
    std::fs::remove_file(path)
}

/// A delete's failure: keyed on what was already done, never on which path came first,
/// with the cause on the next line.
fn delete_failure(done: Option<&str>, act: &str, cause: &std::io::Error) -> AppError {
    let sentence = match done {
        None => format!("Couldn't {act}, so nothing was deleted."),
        Some(done) => format!("{done}, but couldn't {act}."),
    };
    AppError::Command(format!("{sentence}\n{cause}"))
}

/// A `pre-push` holding a line equal to this (trailing whitespace ignored) is
/// GitDesktop's managed hook, whatever else the file holds.
const KEEP_LOCAL_HOOK_MARKER: &str = "# gitdesktop:keep-local-pre-push";

/// The managed pre-push hook: plain POSIX sh, LF endings, ASCII. An inline literal,
/// since a checked-out file would gain CRLF on Windows. It reads Keep local with the
/// same `git config --type=bool --get` as `branch_keep_local`, so the two agree. Exit
/// codes are captured with `|| gd_rc=$?`, so a host hook under `set -e` keeps running.
/// It reads the pushed refs once and hands them back on standard input, so
/// later readers in a host hook still see them. The capture runs only when
/// standard input is open: bash would otherwise reuse the closed descriptor for
/// the capture's own pipe and wait on itself. In a host hook run by bash outside
/// POSIX mode a failed hand-back doesn't stop the hook, so its later readers see
/// no refs; the Keep local verdict has already been given by then. The hand-back's
/// last two lines must stay unindented in a pasted copy.
const KEEP_LOCAL_HOOK_SCRIPT: &str = concat!(
    "#!/bin/sh\n",
    "# gitdesktop:keep-local-pre-push\n",
    "# Managed by GitDesktop: stops a push of any branch marked Keep local.\n",
    "# Bypass once with: git push --no-verify. Remove it from GitDesktop, or delete this file.\n",
    "gd_blocked=0\n",
    "gd_refs=\n",
    "gd_rc=0\n",
    "( exec 9<&0 ) 2>/dev/null || gd_rc=1\n",
    "if [ \"$gd_rc\" = 0 ]; then\n",
    "  gd_refs=$(cat) || gd_rc=$?\n",
    "fi\n",
    "case $gd_rc in\n",
    "  0) ;;\n",
    "  *)\n",
    "    printf 'GitDesktop: could not read the pushed refs, so this push was stopped. Bypass once with: git push --no-verify\\n' >&2\n",
    "    exit 1 ;;\n",
    "esac\n",
    "printf '%s\\n' \"$gd_refs\" | {\n",
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
    "[ \"$gd_blocked\" = 0 ]\n",
    "} || exit 1\n",
    "# Keep the two lines after \"exec\" unindented: the refs and GD_REFS must start their lines.\n",
    "if [ -n \"$gd_refs\" ]; then\n",
    "  exec <<GD_REFS\n",
    "$gd_refs\n",
    "GD_REFS\n",
    "fi\n",
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
    /// `pre-push` is a link to a marker-carrying file: git runs the guard, but install
    /// and remove never act through a link.
    LinkedHook,
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

/// What sits at a hook path. Only an entry classified as a regular file is rewritten or
/// deleted, since a link could point outside the hooks dir and a FIFO would block the
/// read; the rename or delete acts on the entry itself, never through a link. `LinkedOurs`
/// is a link whose followed target is a regular file carrying the marker; every act that
/// keys on `Ours` still refuses it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HookFile {
    Missing,
    Ours,
    LinkedOurs,
    Foreign,
    NotRegular,
}

/// Classifies `path` by its lstat; an unreadable regular file is an Err, never absent.
/// A link is followed only to read a regular-file target of at most
/// [`LINKED_HOOK_READ_CAP`] bytes for the marker, and any failure there reads
/// `NotRegular`, never an Err. The entry's kind comes from the lstat and its bytes from
/// a later open by path, and the two aren't atomic: a path swapped in between is read
/// as whatever regular file it then opens to. Both kinds read through
/// [`read_if_regular`], so a non-regular target swapped in is never read or blocked on.
/// The marker test here is the one "ours" predicate.
fn hook_file(path: &Path) -> std::io::Result<HookFile> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HookFile::Missing),
        Err(e) => return Err(e),
    };
    if meta.file_type().is_symlink() {
        return Ok(followed_link(path));
    }
    if !meta.file_type().is_file() {
        return Ok(HookFile::NotRegular);
    }
    match read_if_regular(path, None) {
        Ok(Some(bytes)) => Ok(if carries_marker(&bytes) {
            HookFile::Ours
        } else {
            HookFile::Foreign
        }),
        Ok(None) => Ok(HookFile::NotRegular),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HookFile::Missing),
        Err(e) => Err(e),
    }
}

/// [`hook_file`]'s answer for a path its lstat found to be a link.
fn followed_link(path: &Path) -> HookFile {
    // Stat before the open: a device or FIFO target is opened only if swapped in after.
    let cap = Some(LINKED_HOOK_READ_CAP);
    let marked = std::fs::metadata(path).is_ok_and(|m| m.is_file())
        && read_if_regular(path, cap).is_ok_and(|b| b.is_some_and(|b| carries_marker(&b)));
    if marked {
        HookFile::LinkedOurs
    } else {
        HookFile::NotRegular
    }
}

/// Whether `path`'s lstat says it is a link; a failed lstat is no link.
fn is_link(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// Whether `link` resolves to `file`: the same device and inode, so a second spelling
/// or a hard link of the file matches; a failure on either side is no match.
#[cfg(unix)]
fn resolves_to(link: &Path, file: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let id = |path: &Path| std::fs::metadata(path).map(|m| (m.dev(), m.ino()));
    matches!((id(link), id(file)), (Ok(a), Ok(b)) if a == b)
}

/// Whether `link` resolves to `file`: equal canonical paths, which spell the on-disk
/// letter case; a failure on either side is no match.
#[cfg(not(unix))]
fn resolves_to(link: &Path, file: &Path) -> bool {
    matches!(
        (std::fs::canonicalize(link), std::fs::canonicalize(file)),
        (Ok(a), Ok(b)) if a == b
    )
}

/// The most a linked hook's target is read for the marker, far above the guard script:
/// a link can point at any file, and a status read holds a runtime worker.
const LINKED_HOOK_READ_CAP: u64 = 64 * 1024;

/// Opens `path` once and reads it only when the opened handle is a regular file (None
/// otherwise): the type check reads the handle, never the path. With `cap`, a file
/// longer than `cap` bytes is None too, and the read stops one byte past it, so a file
/// growing under the handle stays bounded. Unix opens with `O_NONBLOCK`, because a
/// FIFO's open otherwise waits for a writer (it doesn't change regular-file reads).
fn read_if_regular(path: &Path, cap: Option<u64>) -> std::io::Result<Option<Vec<u8>>> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let flags: libc::c_int = libc::O_NONBLOCK;
        options.custom_flags(flags);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Ok(None);
    }
    read_capped(meta.len(), file, cap)
}

/// `reader`'s bytes, or None past `cap`: a stat'd `len` over it is None unread, and the
/// read stops one byte past it, so a reader longer than `len` stays bounded.
fn read_capped(
    len: u64,
    reader: impl std::io::Read,
    cap: Option<u64>,
) -> std::io::Result<Option<Vec<u8>>> {
    use std::io::Read;
    let over = |len: u64| cap.is_some_and(|cap| len > cap);
    if over(len) {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    let limit = cap.map_or(u64::MAX, |cap| cap + 1);
    reader.take(limit).read_to_end(&mut bytes)?;
    Ok((!over(bytes.len() as u64)).then_some(bytes))
}

fn carries_marker(bytes: &[u8]) -> bool {
    String::from_utf8_lossy(bytes)
        .lines()
        .any(|line| line.trim_end() == KEEP_LOCAL_HOOK_MARKER)
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
/// our file sits there, unless the custom dir's `pre-push` links to a marker-carrying
/// file, which git runs through the link and so reads `linkedHook` ahead of a manager.
/// An empty `core.hooksPath` never reads that link: git runs no hook from the root it
/// prints. Past it, a marker-carrying managed file is what git runs, so it reads installed
/// before a manager config in the tree can block, and a link to a marker-carrying file
/// reads `linkedHook` there for the same reason. Config-defined hooks
/// (`hook.<name>.*`, git 2.54+) aren't detected: they run beside the hooks-folder file,
/// whose non-zero exit still stops the push.
async fn keep_local_hook_status_core(repo_path: &str) -> AppResult<KeepLocalHookStatus> {
    use KeepLocalHookBlock::{CustomHooksPath, ForeignHook, HookManager, LinkedHook};
    use KeepLocalHookState::{Absent, Blocked, Installed};
    let (effective, _, empty) = resolve_hooks_dir(repo_path).await?;
    let managed = managed_hooks_dir(repo_path).await?;
    let manager = detect_manager(repo_path, &effective).map(|(name, _)| name);
    let pre_push = managed.join("pre-push");
    // One lstat feeds both fields; an unreadable dir reads unlinked here and fails the
    // same-dir arm below.
    let redirected = hooks_dir_redirected(&managed);
    let linked = matches!(redirected, Ok(true));
    let (state, blocked, managed_hook_present) = if !same_hooks_dir(&effective, &managed) {
        if !empty && links_to_a_guard_elsewhere(&effective, &managed) {
            (Blocked, Some(LinkedHook), false)
        } else {
            let reason = if manager.is_some() {
                HookManager
            } else {
                CustomHooksPath
            };
            // git reaches this file here only through the other dir's `pre-push`, whose
            // link to a marker-carrying file is answered above, so a failed read reports
            // it absent rather than failing a status whose state doesn't depend on it.
            let present = matches!(redirected, Ok(false))
                && matches!(hook_file(&pre_push), Ok(HookFile::Ours));
            (Blocked, Some(reason), present)
        }
    } else if redirected.map_err(AppError::Io)? {
        // git runs a linked guard through the redirect too; Blocked either way, so
        // Install never writes through it.
        let reason = if links_to_a_managed_guard(&pre_push, &managed) {
            LinkedHook
        } else {
            CustomHooksPath
        };
        (Blocked, Some(reason), false)
    } else {
        let file = hook_file(&pre_push).map_err(AppError::Io)?;
        let (state, blocked) = match file {
            HookFile::Ours => (Installed, None),
            HookFile::LinkedOurs => (Blocked, Some(LinkedHook)),
            HookFile::NotRegular if links_to_a_managed_guard(&pre_push, &managed) => {
                (Blocked, Some(LinkedHook))
            }
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

/// Whether git reads a hooks dir other than `managed` whose `pre-push` links to a
/// managed guard ([`links_to_a_managed_guard`]). git runs it through the link, so the
/// status reads `linkedHook` and Remove leaves the managed dir alone. Callers skip it
/// for an empty `core.hooksPath`, whose printed dir git reads no hook from.
fn links_to_a_guard_elsewhere(effective: &Path, managed: &Path) -> bool {
    !same_hooks_dir(effective, managed)
        && links_to_a_managed_guard(&effective.join("pre-push"), managed)
}

/// Whether `link` is a link to a marker-carrying file within the read cap, or to the
/// managed `pre-push` or `pre-push.disabled` carrying it at any size. One lstat decides
/// it is a link; a path that isn't one is never read.
fn links_to_a_managed_guard(link: &Path, managed: &Path) -> bool {
    is_link(link)
        && (followed_link(link) == HookFile::LinkedOurs
            || ["pre-push", "pre-push.disabled"].into_iter().any(|name| {
                let file = managed.join(name);
                resolves_to(link, &file) && matches!(hook_file(&file), Ok(HookFile::Ours))
            }))
}

/// Deletes the managed hook from `<common>/hooks` in any state (a hook left inert
/// behind a later custom hooksPath stays removable); only marker-carrying regular
/// files go, nothing is deleted through a redirected hooks dir, nothing at all while
/// another hooks dir git reads links its `pre-push` to a marker-carrying file, and
/// never the file the effective `pre-push` link resolves to. An empty `core.hooksPath`
/// names no hooks dir git reads, so its root `pre-push` link protects nothing.
async fn keep_local_hook_remove_core(repo_path: &str) -> AppResult<KeepLocalHookStatus> {
    let dir = managed_hooks_dir(repo_path).await?;
    let (effective, _, empty) = resolve_hooks_dir(repo_path).await?;
    if (empty || !links_to_a_guard_elsewhere(&effective, &dir))
        && !hooks_dir_redirected(&dir).map_err(AppError::Io)?
    {
        let link = effective.join("pre-push");
        let linked = !empty && is_link(&link);
        for name in ["pre-push", "pre-push.disabled"] {
            let file = dir.join(name);
            if !(linked && resolves_to(&link, &file)) {
                remove_if_keep_local_hook(&file).map_err(AppError::Io)?;
            }
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
    use crate::git::runner::TEST_GIT_HANG_GUARD;

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
    use KeepLocalHookBlock::{CustomHooksPath, ForeignHook, HookManager, LinkedHook};
    use KeepLocalHookState::{Absent, Blocked, Installed};

    async fn git(repo: &str, args: &[&str]) -> GitOutput {
        run_git_raw(Some(repo), args, TEST_GIT_HANG_GUARD)
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
        hook_repo_at(tag, "repo").await
    }

    /// [`hook_repo`] with the repository at `<base>/<rel>`.
    async fn hook_repo_at(tag: &str, rel: &str) -> (tempfile::TempDir, PathBuf, String, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-hook-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let base = dir.path().to_path_buf();
        let base_s = slashed(&base);
        git_ok(&base_s, &["init", "-q", "--template=", "-b", "main", rel]).await;
        git_ok(
            &base_s,
            &["init", "-q", "--template=", "--bare", "remote.git"],
        )
        .await;
        let repo = format!("{base_s}/{rel}");
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
        // The refs are read once, judged in a pipeline subshell, then handed back on
        // stdin; the hand-back is the only here-document, so the verdict runs first.
        let hand_back = "if [ -n \"$gd_refs\" ]; then\n  exec <<GD_REFS\n$gd_refs\nGD_REFS\nfi\n";
        assert!(script.ends_with(hand_back));
        // The paste note travels with the snippet, directly above the hand-back.
        let note = "# Keep the two lines after \"exec\" unindented: the refs and GD_REFS must start their lines.\n";
        assert!(script.ends_with(&format!("{note}{hand_back}")));
        assert!(keep_local_hook_snippet().contains(note));
        let verdict = script.find("[ \"$gd_blocked\" = 0 ]\n} || exit 1\n");
        let exec = script.find("exec <<GD_REFS");
        assert!(verdict.is_some() && verdict < exec, "verdict first");
        let capture = script.find("gd_refs=$(cat) || gd_rc=$?\n");
        let first_read = script.find("while read");
        assert!(capture.is_some() && capture < first_read, "capture first");
        // Stdin is tested open before the capture, and unreadable refs exit at once,
        // before the verdict pipeline runs any more fd work on a closed stdin.
        let open_check = script.find("( exec 9<&0 ) 2>/dev/null || gd_rc=1\n");
        assert!(open_check.is_some() && open_check < capture, "open first");
        let exit_arm =
            "push --no-verify\\n' >&2\n    exit 1 ;;\nesac\nprintf '%s\\n' \"$gd_refs\" | {\n";
        assert!(script.contains(exit_arm), "exit first");
        assert_eq!(script.matches("<<").count(), 1);
        assert!(!script.contains("<<-"));
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
        // The message set, verbatim: a failed read of the refs stops the push too.
        for message in [
            "printf 'GitDesktop: could not read the pushed refs, so this push was stopped. Bypass once with: git push --no-verify\\n' >&2\n",
            "printf 'GitDesktop: could not read which branch HEAD is on, so this push was stopped. Bypass once with: git push --no-verify\\n' >&2\n",
            "printf 'GitDesktop: \"%s\" is marked Keep local, so this push was stopped. Turn off Keep local in GitDesktop, or bypass once with: git push --no-verify\\n' \"$gd_branch\" >&2\n",
            "printf 'GitDesktop: could not read whether \"%s\" is marked Keep local, so this push was stopped. Bypass once with: git push --no-verify\\n' \"$gd_branch\" >&2\n",
        ] {
            assert!(script.contains(message), "{message}");
        }
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
            (LinkedHook, "\"linkedHook\""),
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
        if try_mkfifo(&managed_file(&repo, "pre-push")).is_none() {
            return;
        }
        for st in acts_within_bound(&repo) {
            assert_status(&st, Blocked, Some(ForeignHook), None);
        }
    }

    /// Makes a FIFO at `path`, or None where mkfifo is unavailable; CI must have it.
    #[cfg(unix)]
    fn try_mkfifo(path: &Path) -> Option<()> {
        let made = std::process::Command::new("mkfifo").arg(path).status();
        if matches!(made, Ok(s) if s.success()) {
            return Some(());
        }
        assert!(
            std::env::var_os("CI").is_none(),
            "CI must be able to make a FIFO: {made:?}"
        );
        eprintln!("skipped: mkfifo unavailable: {made:?}");
        None
    }

    /// Status, install and remove for `repo`, each on a thread with its own runtime and
    /// failed past a bound: they classify the hook synchronously, so a blocking open
    /// would stall a shared runtime's only thread and no timer on it could fire.
    #[cfg(unix)]
    fn acts_within_bound(repo: &str) -> Vec<KeepLocalHookStatus> {
        ["status", "install", "remove"]
            .into_iter()
            .map(|act| {
                let repo = repo.to_string();
                within_bound(act, move || {
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .unwrap();
                    rt.block_on(async {
                        match act {
                            "status" => status(&repo).await,
                            "install" => install(&repo).await,
                            _ => remove(&repo).await,
                        }
                    })
                })
            })
            .collect()
    }

    /// Runs `f` on a thread and fails past a bound; a panic inside `f` is re-raised as
    /// itself rather than reported as a timeout.
    #[cfg(unix)]
    fn within_bound<T: Send + 'static>(what: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        match rx.recv_timeout(std::time::Duration::from_secs(20)) {
            Ok(value) => value,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => match handle.join() {
                Err(panic) => std::panic::resume_unwind(panic),
                Ok(()) => panic!("{what} sent nothing"),
            },
            Err(e) => panic!("{what} must not block on a FIFO: {e}"),
        }
    }

    /// The pin for `O_NONBLOCK`: opening a FIFO with no writer by path returns at once,
    /// and the handle check answers None.
    #[cfg(unix)]
    #[test]
    fn read_if_regular_never_blocks_on_a_fifo() {
        let guard = tempfile::Builder::new()
            .prefix("gd-hook-fifo-read-")
            .tempdir()
            .unwrap();
        let fifo = guard.path().join("fifo");
        if try_mkfifo(&fifo).is_none() {
            return;
        }
        let read = within_bound("read_if_regular", move || {
            read_if_regular(&fifo, None).map_err(|e| e.to_string())
        });
        assert_eq!(read, Ok(None));
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
                assert!(
                    std::env::var_os("CI").is_none(),
                    "CI must be able to create a symlink: {e}"
                );
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
                assert!(
                    std::env::var_os("CI").is_none(),
                    "CI must be able to create a symlink: {e}"
                );
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
        assert_status(&st, Blocked, Some(LinkedHook), None);
        assert_present(&st, false);
        for st in [install(&repo).await, remove(&repo).await] {
            assert_status(&st, Blocked, Some(LinkedHook), None);
            assert_present(&st, false);
        }
        let meta = std::fs::symlink_metadata(&link).unwrap();
        assert!(meta.file_type().is_symlink(), "the link itself is kept");
        assert_eq!(
            std::fs::read(&target).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
    }

    /// git runs another hooks dir's `pre-push` link to the clone's own guard, so it reads
    /// `linkedHook` ahead of the custom-dir and manager reasons with no leftover counted,
    /// and Install and Remove leave both the link and the guard.
    #[tokio::test]
    async fn keep_local_hook_reads_another_dirs_link_to_the_guard_as_linked() {
        let (_g, base, repo, _remote) = hook_repo("other-dir-link").await;
        assert_status(&install(&repo).await, Installed, None, None);
        let guard = base
            .join("repo")
            .join(".git")
            .join("hooks")
            .join("pre-push");
        for dir in ["custom-hooks", ".husky/_"] {
            let folder = Path::new(&repo).join(dir);
            std::fs::create_dir_all(&folder).unwrap();
            let link = folder.join("pre-push");
            if try_symlink_file(&guard, &link).is_none() {
                return;
            }
            git_ok(&repo, &["config", "core.hooksPath", dir]).await;
            for st in [
                status(&repo).await,
                install(&repo).await,
                remove(&repo).await,
            ] {
                assert_status(&st, Blocked, Some(LinkedHook), None);
                assert_present(&st, false);
                assert_redirected(&st, false);
            }
            assert_link(&link);
            assert_eq!(
                std::fs::read(&guard).unwrap(),
                KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
            );
            let top = dir.split('/').next().unwrap();
            std::fs::remove_dir_all(Path::new(&repo).join(top)).unwrap();
        }
    }

    /// Without a link to a marker-carrying file in the other hooks dir, its answers are
    /// the custom-dir or manager reason: the common leftover reads present until Remove
    /// deletes it, and the other dir's file stays as it was.
    #[tokio::test]
    async fn keep_local_hook_other_dir_without_a_link_to_the_guard_keeps_its_answers() {
        let (_g, base, repo, _remote) = hook_repo("other-dir-rows").await;
        let guard = managed_file(&repo, "pre-push");
        let foreign = base.join("foreign.sh");
        std::fs::write(&foreign, FOREIGN).unwrap();
        let dirs = [
            ("custom-hooks", CustomHooksPath, None),
            (".husky/_", HookManager, Some("husky")),
        ];
        for (dir, reason, manager) in dirs {
            for shape in ["none", "foreign", "marker", "foreign-link"] {
                let folder = Path::new(&repo).join(dir);
                std::fs::create_dir_all(&folder).unwrap();
                let file = folder.join("pre-push");
                match shape {
                    "none" => {}
                    "foreign" => std::fs::write(&file, FOREIGN).unwrap(),
                    "marker" => std::fs::write(&file, KEEP_LOCAL_HOOK_SCRIPT).unwrap(),
                    _ => {
                        if try_symlink_file(&foreign, &file).is_none() {
                            continue;
                        }
                    }
                }
                std::fs::write(&guard, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
                git_ok(&repo, &["config", "core.hooksPath", dir]).await;
                for st in [status(&repo).await, install(&repo).await] {
                    assert_status(&st, Blocked, Some(reason), manager);
                    assert_present(&st, true);
                }
                let st = remove(&repo).await;
                assert_status(&st, Blocked, Some(reason), manager);
                assert_present(&st, false);
                assert_gone(&guard);
                match shape {
                    "none" => assert_gone(&file),
                    "foreign" => assert_eq!(std::fs::read(&file).unwrap(), FOREIGN),
                    "marker" => assert_eq!(
                        std::fs::read(&file).unwrap(),
                        KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
                    ),
                    _ => assert_link(&file),
                }
                let top = dir.split('/').next().unwrap();
                std::fs::remove_dir_all(Path::new(&repo).join(top)).unwrap();
            }
        }
    }

    /// A linked target is read for the marker only up to the cap, so a longer one reads
    /// foreign; a regular file is read whole, so a longer guard is still ours.
    #[tokio::test]
    async fn keep_local_hook_reads_a_linked_target_only_up_to_the_cap() {
        let (_g, base, repo, _remote) = hook_repo("link-cap").await;
        let cap = usize::try_from(LINKED_HOOK_READ_CAP).unwrap();
        let mut body = KEEP_LOCAL_HOOK_SCRIPT.as_bytes().to_vec();
        body.push(b'\n');
        body.resize(cap + 1, b'#');
        let hook = managed_file(&repo, "pre-push");
        std::fs::write(&hook, &body).unwrap();
        assert_status(&status(&repo).await, Installed, None, None);
        std::fs::remove_file(&hook).unwrap();
        let target = base.join("target");
        std::fs::write(&target, &body[..cap]).unwrap();
        if try_symlink_file(&target, &hook).is_none() {
            return;
        }
        assert_status(&status(&repo).await, Blocked, Some(LinkedHook), None);
        std::fs::write(&target, &body).unwrap();
        for st in [
            status(&repo).await,
            install(&repo).await,
            remove(&repo).await,
        ] {
            assert_status(&st, Blocked, Some(ForeignHook), None);
            assert_present(&st, false);
        }
        assert_link(&hook);
        assert_eq!(std::fs::read(&target).unwrap(), body);
    }

    /// The guard script padded to one byte past the linked-read cap.
    fn over_cap_guard() -> Vec<u8> {
        let mut body = KEEP_LOCAL_HOOK_SCRIPT.as_bytes().to_vec();
        body.push(b'\n');
        body.resize(usize::try_from(LINKED_HOOK_READ_CAP).unwrap() + 1, b'#');
        body
    }

    /// Another hooks dir's `pre-push` link to the clone's own `pre-push` or
    /// `pre-push.disabled` is a linked guard at any size: no leftover is counted, and
    /// Install and Remove leave the link and the file.
    #[tokio::test]
    async fn keep_local_hook_reads_a_link_to_an_over_cap_managed_guard_as_linked() {
        let (_g, _base, repo, _remote) = hook_repo("link-identity").await;
        let body = over_cap_guard();
        let folder = Path::new(&repo).join("custom-hooks");
        std::fs::create_dir_all(&folder).unwrap();
        git_ok(&repo, &["config", "core.hooksPath", "custom-hooks"]).await;
        let link = folder.join("pre-push");
        for name in ["pre-push", "pre-push.disabled"] {
            let guard = managed_file(&repo, name);
            std::fs::write(&guard, &body).unwrap();
            if try_symlink_file(&guard, &link).is_none() {
                return;
            }
            for st in [
                status(&repo).await,
                install(&repo).await,
                remove(&repo).await,
            ] {
                assert_status(&st, Blocked, Some(LinkedHook), None);
                assert_present(&st, false);
                assert_redirected(&st, false);
            }
            assert_link(&link);
            assert_eq!(std::fs::read(&guard).unwrap(), body, "{name}");
            std::fs::remove_file(&link).unwrap();
            std::fs::remove_file(&guard).unwrap();
        }
    }

    /// While another hooks dir's `pre-push` links to a separate marker-carrying script,
    /// Remove deletes nothing: the clone's own leftover guard stays with the link.
    #[tokio::test]
    async fn keep_local_hook_remove_leaves_a_leftover_while_another_dir_links_to_a_separate_guard()
    {
        let (_g, base, repo, _remote) = hook_repo("other-dir-separate").await;
        let target = base.join("guard.sh");
        std::fs::write(&target, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        let leftover = managed_file(&repo, "pre-push");
        std::fs::write(&leftover, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        let folder = Path::new(&repo).join("custom-hooks");
        std::fs::create_dir_all(&folder).unwrap();
        let link = folder.join("pre-push");
        if try_symlink_file(&target, &link).is_none() {
            return;
        }
        git_ok(&repo, &["config", "core.hooksPath", "custom-hooks"]).await;
        for st in [
            status(&repo).await,
            install(&repo).await,
            remove(&repo).await,
        ] {
            assert_status(&st, Blocked, Some(LinkedHook), None);
            assert_present(&st, false);
            assert_redirected(&st, false);
        }
        assert_eq!(
            std::fs::read(&leftover).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
        assert_link(&link);
        assert_eq!(
            std::fs::read(&target).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
    }

    /// A root `pre-push` link to a marker-carrying file reads `linkedHook` under a `.`
    /// hooksPath, which git runs, but not under an empty one, which runs no hook there:
    /// that reads the custom-dir answer and Remove deletes the inert managed file, the
    /// link's own target included.
    #[tokio::test]
    async fn keep_local_hook_empty_hooks_path_ignores_a_root_link_to_a_guard() {
        let (_g, base, repo, _remote) = hook_repo("empty-hooks-path").await;
        let outside = base.join("guard.sh");
        std::fs::write(&outside, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        let leftover = managed_file(&repo, "pre-push");
        let link = Path::new(&repo).join("pre-push");
        for target in [outside.clone(), leftover.clone()] {
            let row = format!("{target:?}");
            std::fs::write(&leftover, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
            let _ = std::fs::remove_file(&link);
            if try_symlink_file(&target, &link).is_none() {
                return;
            }
            git_ok(&repo, &["config", "core.hooksPath", "."]).await;
            for st in [
                status(&repo).await,
                install(&repo).await,
                remove(&repo).await,
            ] {
                assert_status(&st, Blocked, Some(LinkedHook), None);
                assert_present(&st, false);
            }
            assert!(leftover.is_file(), "{row}: Remove kept it under `.`");
            git_ok(&repo, &["config", "core.hooksPath", ""]).await;
            for st in [status(&repo).await, install(&repo).await] {
                assert_status(&st, Blocked, Some(CustomHooksPath), None);
                assert_present(&st, true);
            }
            assert_eq!(
                std::fs::read(&leftover).unwrap(),
                KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
            );
            for st in [remove(&repo).await, status(&repo).await] {
                assert_status(&st, Blocked, Some(CustomHooksPath), None);
                assert_present(&st, false);
            }
            assert!(!leftover.exists(), "{row}: Remove deletes the managed file");
            assert_link(&link);
        }
        assert_eq!(
            std::fs::read(&outside).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
    }

    /// A link to an over-cap marker-carrying file outside the managed dir keeps the
    /// custom-dir answer: the common leftover reads present and Remove deletes only it.
    #[tokio::test]
    async fn keep_local_hook_reads_a_link_to_an_over_cap_file_elsewhere_as_custom() {
        let (_g, base, repo, _remote) = hook_repo("link-elsewhere").await;
        let body = over_cap_guard();
        let target = base.join("big-guard.sh");
        std::fs::write(&target, &body).unwrap();
        let guard = managed_file(&repo, "pre-push");
        std::fs::write(&guard, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        let folder = Path::new(&repo).join("custom-hooks");
        std::fs::create_dir_all(&folder).unwrap();
        let link = folder.join("pre-push");
        if try_symlink_file(&target, &link).is_none() {
            return;
        }
        git_ok(&repo, &["config", "core.hooksPath", "custom-hooks"]).await;
        for st in [status(&repo).await, install(&repo).await] {
            assert_status(&st, Blocked, Some(CustomHooksPath), None);
            assert_present(&st, true);
        }
        let st = remove(&repo).await;
        assert_status(&st, Blocked, Some(CustomHooksPath), None);
        assert_present(&st, false);
        assert_gone(&guard);
        assert_link(&link);
        assert_eq!(std::fs::read(&target).unwrap(), body);
    }

    /// A regular `pre-push` in another hooks dir is never opened, so one that can't be
    /// read leaves the custom-dir answer as it is, with no error.
    #[tokio::test]
    async fn keep_local_hook_does_not_read_a_regular_pre_push_in_another_dir() {
        let (_g, _base, repo, _remote) = hook_repo("other-dir-unread").await;
        let guard = managed_file(&repo, "pre-push");
        std::fs::write(&guard, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        let folder = Path::new(&repo).join("custom-hooks");
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("pre-push");
        std::fs::write(&file, FOREIGN).unwrap();
        git_ok(&repo, &["config", "core.hooksPath", "custom-hooks"]).await;
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
        }
        for st in [status(&repo).await, install(&repo).await] {
            assert_status(&st, Blocked, Some(CustomHooksPath), None);
            assert_present(&st, true);
        }
        assert_status(&remove(&repo).await, Blocked, Some(CustomHooksPath), None);
        assert_gone(&guard);
        #[cfg(windows)]
        drop(hold);
        assert!(file.is_file());
    }

    /// The clone's own `pre-push` linked to its `pre-push.disabled` twin: Remove leaves
    /// the twin, the file git runs through the link.
    #[tokio::test]
    async fn keep_local_hook_remove_keeps_the_twin_its_pre_push_links_to() {
        let (_g, _base, repo, _remote) = hook_repo("twin-link").await;
        let twin = managed_file(&repo, "pre-push.disabled");
        std::fs::write(&twin, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        let link = managed_file(&repo, "pre-push");
        if try_symlink_file(&twin, &link).is_none() {
            return;
        }
        for st in [
            status(&repo).await,
            install(&repo).await,
            remove(&repo).await,
        ] {
            assert_status(&st, Blocked, Some(LinkedHook), None);
            assert_present(&st, false);
        }
        assert_link(&link);
        assert_eq!(
            std::fs::read(&twin).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
    }

    /// The clone's own `pre-push` linked to an over-cap marker-carrying twin is a linked
    /// guard too: the twin is matched by name, not by the capped read.
    #[tokio::test]
    async fn keep_local_hook_reads_its_pre_push_linked_to_an_over_cap_twin_as_linked() {
        let (_g, _base, repo, _remote) = hook_repo("twin-over-cap").await;
        let body = over_cap_guard();
        let twin = managed_file(&repo, "pre-push.disabled");
        std::fs::write(&twin, &body).unwrap();
        let link = managed_file(&repo, "pre-push");
        if try_symlink_file(&twin, &link).is_none() {
            return;
        }
        for st in [
            status(&repo).await,
            install(&repo).await,
            remove(&repo).await,
        ] {
            assert_status(&st, Blocked, Some(LinkedHook), None);
            assert_present(&st, false);
        }
        assert_link(&link);
        assert_eq!(std::fs::read(&twin).unwrap(), body);
    }

    /// A `pre-push` link to a hard-linked second name of the twin resolves to the twin:
    /// Remove keeps it.
    #[cfg(unix)]
    #[tokio::test]
    async fn keep_local_hook_remove_keeps_a_twin_its_pre_push_reaches_by_a_hard_link() {
        let (_g, base, repo, _remote) = hook_repo("twin-hard-link").await;
        let twin = managed_file(&repo, "pre-push.disabled");
        std::fs::write(&twin, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        let alias = base.join("alias");
        std::fs::hard_link(&twin, &alias).unwrap();
        let link = managed_file(&repo, "pre-push");
        try_symlink_file(&alias, &link).expect("a unix symlink is made");
        let st = remove(&repo).await;
        assert_status(&st, Blocked, Some(LinkedHook), None);
        assert_link(&link);
        assert_eq!(
            std::fs::read(&twin).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
    }

    /// `read_capped` refuses a stat'd length past the cap unread, and a reader longer
    /// than its stat'd length (a file grown since) stops one byte past the cap as None.
    #[test]
    fn read_capped_stops_one_byte_past_the_cap() {
        let cap = LINKED_HOOK_READ_CAP;
        let len = usize::try_from(cap).unwrap();
        let src = vec![b'#'; len + 2];
        let mut rest = &src[..];
        assert_eq!(read_capped(cap, &mut rest, Some(cap)).unwrap(), None);
        assert_eq!(rest.len(), 1, "the read takes cap + 1 bytes");
        let mut unread = &src[..];
        assert_eq!(read_capped(cap + 1, &mut unread, Some(cap)).unwrap(), None);
        assert_eq!(unread.len(), src.len(), "a length past the cap isn't read");
        let exact = read_capped(cap, &src[..len], Some(cap)).unwrap();
        assert_eq!(exact.as_deref(), Some(&src[..len]));
        let whole = read_capped(cap + 2, &src[..], None).unwrap();
        assert_eq!(whole, Some(src.clone()));
    }

    /// A `pre-push` link to a marker-carrying file inside a redirected hooks dir reads
    /// `linkedHook`, with nothing written or deleted through the redirect; a regular
    /// guard there keeps the custom-dir reason.
    #[tokio::test]
    async fn keep_local_hook_reads_a_linked_guard_inside_a_redirected_hooks_dir() {
        let (_g, base, repo, _remote) = hook_repo("redirected-link").await;
        let outside = base.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let hooks = base.join("repo").join(".git").join("hooks");
        std::fs::remove_dir(&hooks).unwrap();
        if link_hooks_dir(&base, &hooks, &outside, cfg!(windows)).is_none() {
            return;
        }
        let target = base.join("guard.sh");
        std::fs::write(&target, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        let link = outside.join("pre-push");
        if try_symlink_file(&target, &link).is_none() {
            return;
        }
        for st in [
            status(&repo).await,
            install(&repo).await,
            remove(&repo).await,
        ] {
            assert_status(&st, Blocked, Some(LinkedHook), None);
            assert_present(&st, false);
            assert_redirected(&st, true);
        }
        assert_link(&link);
        assert_eq!(
            std::fs::read(&target).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
        let names: Vec<_> = std::fs::read_dir(&outside)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["pre-push"], "nothing else written through it");
        std::fs::remove_file(&link).unwrap();
        std::fs::write(&link, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        for st in [status(&repo).await, remove(&repo).await] {
            assert_status(&st, Blocked, Some(CustomHooksPath), None);
            assert_redirected(&st, true);
        }
        assert!(link.is_file(), "nothing deleted through it");
    }

    /// A redirected hooks dir whose `pre-push` links to an over-cap marker-carrying
    /// `pre-push.disabled` beside it reads `linkedHook`: the link resolves to that managed file.
    #[tokio::test]
    async fn keep_local_hook_reads_a_redirected_pre_push_linked_to_an_over_cap_twin_as_linked() {
        let (_g, base, repo, _remote) = hook_repo("redirected-twin").await;
        let outside = base.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let hooks = base.join("repo").join(".git").join("hooks");
        std::fs::remove_dir(&hooks).unwrap();
        if link_hooks_dir(&base, &hooks, &outside, cfg!(windows)).is_none() {
            return;
        }
        let body = over_cap_guard();
        let twin = outside.join("pre-push.disabled");
        std::fs::write(&twin, &body).unwrap();
        let link = outside.join("pre-push");
        if try_symlink_file(&twin, &link).is_none() {
            return;
        }
        for st in [
            status(&repo).await,
            install(&repo).await,
            remove(&repo).await,
        ] {
            assert_status(&st, Blocked, Some(LinkedHook), None);
            assert_present(&st, false);
            assert_redirected(&st, true);
        }
        assert_link(&link);
        assert_eq!(std::fs::read(&twin).unwrap(), body);
        let mut names: Vec<_> = std::fs::read_dir(&outside)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        names.sort();
        assert_eq!(names, ["pre-push", "pre-push.disabled"]);
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
        make_hooks_junction(hooks, outside)
    }

    #[cfg(windows)]
    fn make_hooks_junction(hooks: &Path, outside: &Path) -> Option<()> {
        crate::test_junction::make_junction(hooks, outside);
        Some(())
    }

    /// Only the Windows tests ask for a junction.
    #[cfg(not(windows))]
    fn make_hooks_junction(_hooks: &Path, _outside: &Path) -> Option<()> {
        unreachable!("junctions are made only on Windows")
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
        let (dir, custom, _) = resolve_hooks_dir(wt).await.unwrap();
        (dir, custom)
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

    /// Lists from `from` and asserts the `pre-push` label agrees with the guard status
    /// read from the same path, equals `expected`, and that no other entry is labelled.
    async fn assert_managed_row(row: &str, from: &str, expected: bool) {
        let info = git_hooks_list(from.to_string()).await.unwrap();
        let st = status(from).await;
        for entry in info.entries.iter().filter(|e| e.name != "pre-push") {
            assert!(!entry.managed, "{row}: {entry:?}");
        }
        let pre_push = info.entries.iter().find(|e| e.name == "pre-push").unwrap();
        let guard = (st.state, st.blocked);
        assert_eq!(
            pre_push.managed,
            st.state == Installed,
            "{row}: {pre_push:?} {guard:?}"
        );
        assert_eq!(pre_push.managed, expected, "{row}: {pre_push:?} {guard:?}");
    }

    #[tokio::test]
    async fn hooks_list_managed_matches_the_guard_status() {
        let (_g, base, repo, _remote) = hook_repo("managed-list").await;
        let file = managed_file(&repo, "pre-push");
        assert_managed_row("fresh repo", &repo, false).await;
        install(&repo).await;
        assert_managed_row("installed", &repo, true).await;
        let edited = "#!/bin/sh\r\n# gitdesktop:keep-local-pre-push  \r\necho extra\r\n";
        std::fs::write(&file, edited).unwrap();
        assert_managed_row("user-edited marker file", &repo, true).await;
        std::fs::write(&file, "#!/bin/sh\necho mine\n").unwrap();
        assert_managed_row("foreign pre-push", &repo, false).await;
        std::fs::remove_file(&file).unwrap();
        let twin_file = managed_file(&repo, "pre-push.disabled");
        std::fs::write(&twin_file, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        let info = git_hooks_list(repo.clone()).await.unwrap();
        let twin = info.entries.iter().find(|e| e.name == "pre-push").unwrap();
        assert!(matches!(twin.state, HookState::Disabled), "{twin:?}");
        assert_managed_row("marker-carrying disabled twin only", &repo, false).await;
        std::fs::remove_file(&twin_file).unwrap();

        install(&repo).await;
        let wt = slashed(&base.join("wt"));
        git_ok(&repo, &["worktree", "add", "-q", "-b", "wtb", &wt]).await;
        assert_managed_row("listed from a linked worktree", &wt, true).await;

        let elsewhere = base.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("pre-push"), KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        git_ok(&repo, &["config", "core.hooksPath", &slashed(&elsewhere)]).await;
        assert!(file.is_file(), "managed file kept");
        assert_managed_row("repointed hooksPath holding a copy", &repo, false).await;
    }

    #[test]
    fn hook_entry_serializes_managed_to_the_pinned_wire_shape() {
        let entry = HookEntry {
            name: "pre-push".into(),
            description: "D".into(),
            state: HookState::Active,
            has_sample: false,
            managed: true,
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert_eq!(
            json,
            r#"{"name":"pre-push","description":"D","state":"active","hasSample":false,"managed":true}"#
        );
        assert!(!json.contains("has_sample"));
    }

    #[test]
    fn hook_delete_outcome_serializes_to_the_pinned_wire_shape() {
        let deleted = serde_json::to_string(&HookDeleteOutcome::Deleted).unwrap();
        assert_eq!(deleted, r#"{"status":"deleted"}"#);
        let changed =
            serde_json::to_string(&HookDeleteOutcome::ManagedChanged { managed: true }).unwrap();
        assert_eq!(changed, r#"{"status":"managedChanged","managed":true}"#);
        let unmanaged =
            serde_json::to_string(&HookDeleteOutcome::ManagedChanged { managed: false }).unwrap();
        assert_eq!(unmanaged, r#"{"status":"managedChanged","managed":false}"#);
        for json in [&deleted, &changed, &unmanaged] {
            for rust in ["\"Deleted\"", "\"ManagedChanged\"", "\"managed_changed\""] {
                assert!(!json.contains(rust), "{json}");
            }
        }
    }

    #[tokio::test]
    async fn hook_delete_expecting_the_guard_deletes_it() {
        let (_g, _base, repo, _remote) = hook_repo("delete-guard").await;
        install(&repo).await;
        let outcome = git_hook_delete(repo.clone(), "pre-push".into(), Some(true))
            .await
            .unwrap();
        assert_eq!(outcome, HookDeleteOutcome::Deleted);
        assert!(!managed_file(&repo, "pre-push").exists());
        assert_eq!(status(&repo).await.state, Absent);
    }

    #[tokio::test]
    async fn hook_delete_expecting_no_guard_refuses_a_guard_installed_since() {
        let (_g, _base, repo, _remote) = hook_repo("delete-installed-since").await;
        install(&repo).await;
        let outcome = git_hook_delete(repo.clone(), "pre-push".into(), Some(false))
            .await
            .unwrap();
        assert_eq!(outcome, HookDeleteOutcome::ManagedChanged { managed: true });
        let file = managed_file(&repo, "pre-push");
        assert!(file.is_file());
        assert!(matches!(hook_file(&file), Ok(HookFile::Ours)));
        assert_eq!(status(&repo).await.state, Installed);
    }

    #[tokio::test]
    async fn hook_delete_expecting_the_guard_refuses_once_it_is_gone() {
        let (_g, base, repo, _remote) = hook_repo("delete-gone").await;
        let file = managed_file(&repo, "pre-push");
        let foreign = b"#!/bin/sh\necho mine\n";
        std::fs::write(&file, foreign).unwrap();
        let outcome = git_hook_delete(repo.clone(), "pre-push".into(), Some(true))
            .await
            .unwrap();
        assert_eq!(
            outcome,
            HookDeleteOutcome::ManagedChanged { managed: false }
        );
        assert_eq!(std::fs::read(&file).unwrap(), foreign);

        std::fs::remove_file(&file).unwrap();
        install(&repo).await;
        let elsewhere = base.join("elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("pre-push"), KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        git_ok(&repo, &["config", "core.hooksPath", &slashed(&elsewhere)]).await;
        let outcome = git_hook_delete(repo.clone(), "pre-push".into(), Some(true))
            .await
            .unwrap();
        assert_eq!(
            outcome,
            HookDeleteOutcome::ManagedChanged { managed: false }
        );
        assert!(file.is_file(), "managed file kept");
        assert!(elsewhere.join("pre-push").is_file(), "repointed copy kept");

        let (_g2, _base2, other, _remote2) = hook_repo("delete-gone-other").await;
        let pre_commit = managed_file(&other, "pre-commit");
        std::fs::write(&pre_commit, foreign).unwrap();
        let outcome = git_hook_delete(other.clone(), "pre-commit".into(), Some(true))
            .await
            .unwrap();
        assert_eq!(
            outcome,
            HookDeleteOutcome::ManagedChanged { managed: false }
        );
        assert!(pre_commit.is_file());
        let outcome = git_hook_delete(other.clone(), "pre-commit".into(), Some(false))
            .await
            .unwrap();
        assert_eq!(outcome, HookDeleteOutcome::Deleted);
        assert!(!pre_commit.exists());
    }

    #[tokio::test]
    async fn hook_delete_without_an_expected_state_deletes_as_before() {
        let (_g, _base, repo, _remote) = hook_repo("delete-unchecked").await;
        let file = managed_file(&repo, "pre-push");
        install(&repo).await;
        assert_eq!(
            git_hook_delete(repo.clone(), "pre-push".into(), None)
                .await
                .unwrap(),
            HookDeleteOutcome::Deleted
        );
        assert!(!file.exists());

        let twin = managed_file(&repo, "pre-push.disabled");
        std::fs::write(&file, "#!/bin/sh\necho mine\n").unwrap();
        std::fs::write(&twin, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        assert_eq!(
            git_hook_delete(repo.clone(), "pre-push".into(), None)
                .await
                .unwrap(),
            HookDeleteOutcome::Deleted
        );
        assert!(!file.exists());
        assert!(!twin.exists());
    }

    /// A `pre-push` whose managed state can't be read: the list labels it unmanaged, while
    /// a delete expecting either state is the read's `Err`, as a sentence, and leaves the
    /// file.
    #[tokio::test]
    async fn hook_delete_after_a_failed_managed_read_refuses() {
        let (_g, _base, repo, _remote) = hook_repo("delete-unreadable").await;
        let file = managed_file(&repo, "pre-push");
        std::fs::write(&file, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
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
        let info = git_hooks_list(repo.clone()).await.unwrap();
        let listed = info.entries.iter().find(|e| e.name == "pre-push").unwrap();
        assert!(matches!(listed.state, HookState::Active), "{listed:?}");
        assert!(!listed.managed, "{listed:?}");
        // Expecting the guard tells the fallible read apart on Windows too, where a
        // delete of the held file would fail on its own.
        for expected in [false, true] {
            let result = git_hook_delete(repo.clone(), "pre-push".into(), Some(expected)).await;
            assert!(
                matches!(&result, Err(AppError::Command(m))
                    if m.starts_with("Couldn't read pre-push, so nothing was deleted.\n")),
                "expected {expected}: {result:?}"
            );
            assert!(file.is_file(), "expected {expected}");
        }
        #[cfg(windows)]
        drop(hold);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert!(matches!(hook_file(&file), Ok(HookFile::Ours)));
    }

    /// A readable hook without the marker, expected unmanaged, is deleted as before.
    #[tokio::test]
    async fn hook_delete_expecting_no_guard_deletes_a_readable_foreign_hook() {
        let (_g, _base, repo, _remote) = hook_repo("delete-foreign").await;
        let file = managed_file(&repo, "pre-push");
        std::fs::write(&file, "#!/bin/sh\necho mine\n").unwrap();
        let outcome = git_hook_delete(repo.clone(), "pre-push".into(), Some(false))
            .await
            .unwrap();
        assert_eq!(outcome, HookDeleteOutcome::Deleted);
        assert!(!file.exists());
    }

    /// A hooks path whose parent is a regular file has no such hook: `false`, never the
    /// `Err` (Unix reports it as not-a-directory, Windows as not-found).
    #[tokio::test]
    async fn hook_managed_state_reads_a_hooks_path_through_a_file_as_no_hook() {
        let (_g, base, repo, _remote) = hook_repo("managed-through-file").await;
        let not_a_dir = base.join("hooks-file");
        std::fs::write(&not_a_dir, "plain\n").unwrap();
        assert!(matches!(
            hook_managed_state(&repo, &not_a_dir, "pre-push").await,
            Ok(false)
        ));
    }

    /// A `pre-push` symlink is no managed hook, whatever it points at: a loop, which a
    /// followed read fails on, and a regular file carrying the managed marker. Unix only,
    /// since creating a symlink on Windows needs a privilege.
    #[cfg(unix)]
    #[tokio::test]
    async fn hook_managed_state_reads_a_pre_push_symlink_as_unmanaged() {
        let (_g, base, repo, _remote) = hook_repo("managed-symlink").await;
        let file = managed_file(&repo, "pre-push");
        let hooks_dir = file.parent().unwrap().to_path_buf();
        assert_status(&install(&repo).await, Installed, None, None);
        let marked = base.join("marked-pre-push");
        std::fs::copy(&file, &marked).unwrap();
        std::fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&marked, &file).unwrap();
        assert_eq!(
            hook_file(&marked).unwrap(),
            HookFile::Ours,
            "fixture sanity"
        );
        assert!(matches!(
            hook_managed_state(&repo, &hooks_dir, "pre-push").await,
            Ok(false)
        ));
        std::fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&file, &file).unwrap();
        assert!(matches!(
            hook_managed_state(&repo, &hooks_dir, "pre-push").await,
            Ok(false)
        ));
    }

    /// The Windows twin of the test above, with file symlinks: it returns, with the reason
    /// printed, where a link cannot be created (for example, a privilege this process
    /// lacks).
    #[cfg(windows)]
    #[tokio::test]
    async fn hook_managed_state_reads_a_pre_push_symlink_as_unmanaged_on_windows() {
        let (_g, base, repo, _remote) = hook_repo("managed-symlink-win").await;
        let file = managed_file(&repo, "pre-push");
        let hooks_dir = file.parent().unwrap().to_path_buf();
        assert_status(&install(&repo).await, Installed, None, None);
        let marked = base.join("marked-pre-push");
        std::fs::copy(&file, &marked).unwrap();
        std::fs::remove_file(&file).unwrap();
        if try_symlink_file(&marked, &file).is_none() {
            return;
        }
        assert_eq!(
            hook_file(&marked).unwrap(),
            HookFile::Ours,
            "fixture sanity"
        );
        assert!(matches!(
            hook_managed_state(&repo, &hooks_dir, "pre-push").await,
            Ok(false)
        ));
        std::fs::remove_file(&file).unwrap();
        try_symlink_file(&file, &file).expect("a second link is made where the first was");
        assert!(
            std::fs::metadata(&file).is_err(),
            "fixture sanity: a followed read fails on the loop"
        );
        assert!(matches!(
            hook_managed_state(&repo, &hooks_dir, "pre-push").await,
            Ok(false)
        ));
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

    /// A host check that reads the pushed refs: it echoes each line's remote ref and
    /// local oid, refuses `host-refused` on its own, then reports how many it read.
    const HOST_REF_READER: &str = concat!(
        "h_n=0\n",
        "while read -r h_local h_oid h_remote h_remote_oid; do\n",
        "  h_n=$((h_n + 1))\n",
        "  echo \"host saw $h_remote $h_oid\" >&2\n",
        "  if [ \"$h_remote\" = refs/heads/host-refused ]; then echo 'host refused' >&2; exit 1; fi\n",
        "done\n",
        "echo \"host read $h_n refs\" >&2\n",
    );

    /// The snippet pasted ABOVE a host check that reads the pushed refs, under `flags`:
    /// the check reads every ref line the push sends and keeps its own verdict. Each
    /// row commits first, since git leaves an up-to-date ref out of the hook's input.
    async fn assert_snippet_hands_the_host_its_refs(flags: &str, tag: &str) {
        let (_g, _base, repo, remote) = hook_repo(tag).await;
        let snippet = keep_local_hook_snippet();
        let host = format!("#!/bin/sh\nset {flags}\n{snippet}{HOST_REF_READER}");
        assert!(host.is_ascii() && !host.contains('\r'));
        write_pre_push(&repo, &host);
        let saw = |branch: &str, tip: &str| ["host saw refs/heads/", branch, " ", tip].concat();
        git_ok(&repo, &["checkout", "-q", "-b", "feat/x"]).await;
        let tip = commit(&repo, "one").await;
        let out = git(&repo, &["push", "origin", "HEAD"]).await;
        let row = format!("set {flags}, one ref");
        assert_eq!(out.code, 0, "{row}: {}", out.full_failure_text());
        for line in [saw("feat/x", &tip), "host read 1 refs".into()] {
            assert!(out.stderr.contains(&line), "{row}: {}", out.stderr);
        }
        assert_eq!(remote_tip(&remote, "feat/x").await, Some(tip), "{row}");
        git_ok(&repo, &["checkout", "-q", "main"]).await;
        let main_tip = commit(&repo, "two main").await;
        git_ok(&repo, &["checkout", "-q", "feat/x"]).await;
        let tip = commit(&repo, "two").await;
        let out = git(&repo, &["push", "origin", "main", "feat/x"]).await;
        let row = format!("set {flags}, two refs");
        assert_eq!(out.code, 0, "{row}: {}", out.full_failure_text());
        let lines = [saw("main", &main_tip), saw("feat/x", &tip)];
        for line in lines.into_iter().chain(["host read 2 refs".into()]) {
            assert!(out.stderr.contains(&line), "{row}: {}", out.stderr);
        }
        assert_eq!(remote_tip(&remote, "main").await, Some(main_tip), "{row}");
        let landed = remote_tip(&remote, "feat/x").await;
        assert_eq!(landed, Some(tip.clone()), "{row}");
        // A marked branch stops the push before the host check reads anything.
        let key = crate::git::branches::keep_local_key("feat/x");
        git_ok(&repo, &["config", &key, "true"]).await;
        commit(&repo, "three").await;
        let out = git(&repo, &["push", "origin", "HEAD"]).await;
        let row = format!("set {flags}, marked");
        assert_ne!(out.code, 0, "{row}");
        assert!(
            out.stderr.contains("\"feat/x\" is marked Keep local")
                && !out.stderr.contains("host saw"),
            "{row}: {}",
            out.stderr
        );
        assert_eq!(remote_tip(&remote, "feat/x").await, Some(tip), "{row}");
        // The host check's own refusal of an unmarked branch still stops the push.
        git_ok(&repo, &["checkout", "-q", "-b", "host-refused"]).await;
        let tip = commit(&repo, "four").await;
        let out = git(&repo, &["push", "origin", "host-refused"]).await;
        let row = format!("set {flags}, host refuses");
        assert_ne!(out.code, 0, "{row}");
        assert!(
            out.stderr.contains(&saw("host-refused", &tip))
                && out.stderr.contains("host refused")
                && !out.stderr.contains("is marked Keep local"),
            "{row}: {}",
            out.stderr
        );
        assert_eq!(remote_tip(&remote, "host-refused").await, None, "{row}");
    }

    #[tokio::test]
    async fn keep_local_hook_snippet_above_a_reader_hands_it_the_refs_under_set_e() {
        assert_snippet_hands_the_host_its_refs("-e", "above-e").await;
    }

    #[tokio::test]
    async fn keep_local_hook_snippet_above_a_reader_hands_it_the_refs_under_set_eu() {
        assert_snippet_hands_the_host_its_refs("-eu", "above-eu").await;
    }

    /// The documented limit, pinned rather than wanted: below a host reader that drained
    /// the pushed refs the snippet reads none, so a marked branch's push goes through.
    /// The dialog and the guide say to paste the check above anything else that reads
    /// the pushed refs for this reason.
    #[tokio::test]
    async fn keep_local_hook_snippet_below_a_draining_reader_sees_no_refs() {
        const SENTINEL: &str = "host hook reached its last line";
        let (_g, _base, repo, remote) = hook_repo("drained").await;
        let snippet = keep_local_hook_snippet();
        let host = format!("#!/bin/sh\ncat >/dev/null\n{snippet}echo '{SENTINEL}' >&2\n");
        write_pre_push(&repo, &host);
        git_ok(&repo, &["checkout", "-q", "-b", "feat/x"]).await;
        let key = crate::git::branches::keep_local_key("feat/x");
        git_ok(&repo, &["config", &key, "true"]).await;
        let tip = commit(&repo, "marked").await;
        let out = git(&repo, &["push", "origin", "HEAD"]).await;
        assert_eq!(out.code, 0, "{}", out.full_failure_text());
        assert!(
            out.stderr.contains(SENTINEL) && !out.stderr.contains("is marked Keep local"),
            "{}",
            out.stderr
        );
        assert_eq!(remote_tip(&remote, "feat/x").await, Some(tip));
    }

    /// A host hook that closed standard input before the snippet: the refs can't be
    /// read, so the snippet stops the push instead of passing it unchecked.
    #[tokio::test]
    async fn keep_local_hook_snippet_stops_when_it_cannot_read_the_refs() {
        const SENTINEL: &str = "host hook reached its last line";
        let (_g, _base, repo, remote) = hook_repo("closed").await;
        let snippet = keep_local_hook_snippet();
        let host = format!("#!/bin/sh\nexec <&-\n{snippet}echo '{SENTINEL}' >&2\n");
        write_pre_push(&repo, &host);
        git_ok(&repo, &["checkout", "-q", "-b", "feat/x"]).await;
        commit(&repo, "unmarked").await;
        let out = git(&repo, &["push", "origin", "HEAD"]).await;
        assert_ne!(out.code, 0, "{}", out.stderr);
        let stopped = "GitDesktop: could not read the pushed refs, so this push was stopped. \
                       Bypass once with: git push --no-verify";
        assert!(
            out.stderr.contains(stopped) && !out.stderr.contains(SENTINEL),
            "{}",
            out.stderr
        );
        assert_eq!(remote_tip(&remote, "feat/x").await, None);
    }

    // --- Hook writes, toggles and deletes: the expected managed state and links. ---

    const FOREIGN: &[u8] = b"#!/bin/sh\necho mine\n";

    fn written(managed: bool) -> HookWriteOutcome {
        HookWriteOutcome {
            status: HookWriteStatus::Written,
            managed,
        }
    }

    fn changed(managed: bool) -> HookWriteOutcome {
        HookWriteOutcome::managed_changed(managed)
    }

    async fn write_hook(
        repo: &str,
        content: &str,
        expected: Option<bool>,
    ) -> AppResult<HookWriteOutcome> {
        git_hook_write(repo.into(), "pre-push".into(), content.into(), expected).await
    }

    async fn toggle_hook(
        repo: &str,
        enabled: bool,
        expected: Option<bool>,
    ) -> AppResult<HookWriteOutcome> {
        git_hook_set_enabled(repo.into(), "pre-push".into(), enabled, expected).await
    }

    fn assert_command_starts(result: &AppResult<HookWriteOutcome>, lead: &str) {
        assert!(
            matches!(result, Err(AppError::Command(m)) if m.starts_with(lead)),
            "{lead:?}: {result:?}"
        );
    }

    fn assert_link_refused(result: AppResult<HookWriteOutcome>, file: &str, act: &str) {
        let want = format!(
            "{file} is a link, so GitDesktop won't {act}. Edit or replace the link outside GitDesktop."
        );
        assert!(
            matches!(&result, Err(AppError::Command(m)) if *m == want),
            "{want:?}: {result:?}"
        );
    }

    fn assert_gone(path: &Path) {
        let err = std::fs::symlink_metadata(path).expect_err("nothing is left at the path");
        assert_eq!(err.kind(), std::io::ErrorKind::NotFound, "{path:?}");
    }

    fn assert_link(path: &Path) {
        let meta = std::fs::symlink_metadata(path).unwrap();
        assert!(meta.file_type().is_symlink(), "{path:?} is still a link");
    }

    type TrashCalls = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

    /// A trash that records the file name of each path it is handed, refuses `refuse`
    /// with "refused", and removes anything else.
    fn recording_trash(
        refuse: Option<&'static str>,
    ) -> (
        TrashCalls,
        impl Fn(&Path) -> std::io::Result<()> + Send + 'static,
    ) {
        let calls = TrashCalls::default();
        let seen = calls.clone();
        let trash = move |path: &Path| {
            let file = path.file_name().unwrap().to_string_lossy().into_owned();
            seen.lock().unwrap().push(file.clone());
            if Some(file.as_str()) == refuse {
                return Err(std::io::Error::other("refused"));
            }
            std::fs::remove_file(path)
        };
        (calls, trash)
    }

    fn trashed(calls: &TrashCalls) -> Vec<String> {
        calls.lock().unwrap().clone()
    }

    #[test]
    fn hook_write_outcome_serializes_to_the_pinned_wire_shape() {
        let rows = [
            (written(false), r#"{"status":"written","managed":false}"#),
            (written(true), r#"{"status":"written","managed":true}"#),
            (
                changed(false),
                r#"{"status":"managedChanged","managed":false}"#,
            ),
            (
                changed(true),
                r#"{"status":"managedChanged","managed":true}"#,
            ),
        ];
        for (outcome, wire) in rows {
            let json = serde_json::to_string(&outcome).unwrap();
            assert_eq!(json, wire);
            for rust in ["\"Written\"", "\"ManagedChanged\"", "\"managed_changed\""] {
                assert!(!json.contains(rust), "{json}");
            }
        }
    }

    /// Expecting the guard on the guard: the write and the rename land, and `written`
    /// carries the state the list reads next.
    #[tokio::test]
    async fn hook_write_and_toggle_expecting_the_guard_act_and_report_the_state_after() {
        let (_g, _base, repo, _remote) = hook_repo("write-guard").await;
        let file = managed_file(&repo, "pre-push");
        let twin = managed_file(&repo, "pre-push.disabled");
        install(&repo).await;
        let saved = write_hook(&repo, KEEP_LOCAL_HOOK_SCRIPT, Some(true)).await;
        assert_eq!(saved.unwrap(), written(true));
        assert_eq!(
            std::fs::read(&file).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
        assert_eq!(
            toggle_hook(&repo, false, Some(true)).await.unwrap(),
            written(false)
        );
        assert_gone(&file);
        assert_eq!(
            std::fs::read(&twin).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
        assert_eq!(toggle_hook(&repo, true, None).await.unwrap(), written(true));
        let foreign = std::str::from_utf8(FOREIGN).unwrap();
        let saved = write_hook(&repo, foreign, Some(true)).await;
        assert_eq!(saved.unwrap(), written(false));
        assert_eq!(std::fs::read(&file).unwrap(), FOREIGN);
    }

    /// A list that showed no guard can't overwrite or disable one installed since.
    #[tokio::test]
    async fn hook_write_and_toggle_expecting_no_guard_refuse_a_guard_installed_since() {
        let (_g, _base, repo, _remote) = hook_repo("write-installed-since").await;
        install(&repo).await;
        let file = managed_file(&repo, "pre-push");
        let foreign = std::str::from_utf8(FOREIGN).unwrap();
        let saved = write_hook(&repo, foreign, Some(false)).await;
        assert_eq!(saved.unwrap(), changed(true));
        assert_eq!(
            toggle_hook(&repo, false, Some(false)).await.unwrap(),
            changed(true)
        );
        assert_eq!(
            std::fs::read(&file).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
        assert_gone(&managed_file(&repo, "pre-push.disabled"));
        assert_eq!(status(&repo).await.state, Installed);
    }

    #[tokio::test]
    async fn hook_write_and_toggle_expecting_the_guard_refuse_a_foreign_hook() {
        let (_g, _base, repo, _remote) = hook_repo("write-foreign-expected").await;
        let file = managed_file(&repo, "pre-push");
        std::fs::write(&file, FOREIGN).unwrap();
        let saved = write_hook(&repo, KEEP_LOCAL_HOOK_SCRIPT, Some(true)).await;
        assert_eq!(saved.unwrap(), changed(false));
        assert_eq!(
            toggle_hook(&repo, false, Some(true)).await.unwrap(),
            changed(false)
        );
        assert_eq!(std::fs::read(&file).unwrap(), FOREIGN);
        assert_gone(&managed_file(&repo, "pre-push.disabled"));
    }

    /// No expected state acts as before, over the guard too; an unmanaged hook expected
    /// unmanaged is written and renamed; a toggle with nothing to rename is `written`.
    #[tokio::test]
    async fn hook_write_and_toggle_without_or_matching_an_expected_state_act_as_before() {
        let (_g, _base, repo, _remote) = hook_repo("write-unchecked").await;
        let file = managed_file(&repo, "pre-push");
        let twin = managed_file(&repo, "pre-push.disabled");
        install(&repo).await;
        let foreign = std::str::from_utf8(FOREIGN).unwrap();
        assert_eq!(
            write_hook(&repo, foreign, None).await.unwrap(),
            written(false)
        );
        assert_eq!(std::fs::read(&file).unwrap(), FOREIGN);
        std::fs::write(&file, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        assert_eq!(
            toggle_hook(&repo, false, None).await.unwrap(),
            written(false)
        );
        assert_gone(&file);
        assert_eq!(toggle_hook(&repo, true, None).await.unwrap(), written(true));
        assert_gone(&twin);
        let edited = "#!/bin/sh\necho edited\n";
        assert_eq!(
            write_hook(&repo, foreign, Some(true)).await.unwrap(),
            written(false)
        );
        assert_eq!(
            write_hook(&repo, edited, Some(false)).await.unwrap(),
            written(false)
        );
        assert_eq!(std::fs::read_to_string(&file).unwrap(), edited);
        assert_eq!(
            toggle_hook(&repo, false, Some(false)).await.unwrap(),
            written(false)
        );
        assert_gone(&file);
        assert_eq!(std::fs::read_to_string(&twin).unwrap(), edited);
        assert_eq!(
            toggle_hook(&repo, false, Some(false)).await.unwrap(),
            written(false),
            "nothing to disable"
        );
        assert_eq!(std::fs::read_to_string(&twin).unwrap(), edited);
    }

    /// A `pre-push` whose managed state can't be read: a write or toggle expecting either
    /// state is a sentence naming what wasn't done, and the file is untouched.
    #[tokio::test]
    async fn hook_write_and_toggle_after_a_failed_managed_read_refuse_with_a_sentence() {
        let (_g, _base, repo, _remote) = hook_repo("write-unreadable").await;
        let file = managed_file(&repo, "pre-push");
        std::fs::write(&file, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
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
        for expected in [false, true] {
            let saved = write_hook(&repo, "#!/bin/sh\n", Some(expected)).await;
            assert_command_starts(&saved, "Couldn't read pre-push, so nothing was saved.\n");
            for (enabled, verb) in [(false, "disabled"), (true, "enabled")] {
                let toggled = toggle_hook(&repo, enabled, Some(expected)).await;
                let lead = format!("Couldn't read pre-push, so nothing was {verb}.\n");
                assert_command_starts(&toggled, &lead);
            }
        }
        #[cfg(windows)]
        drop(hold);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        assert_eq!(
            std::fs::read(&file).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
        assert_gone(&managed_file(&repo, "pre-push.disabled"));
    }

    /// Only a failure reading the hook entry becomes the sentence; any other failure in
    /// the managed read (the common-dir git read, the hooks-folder lstat) keeps its own.
    #[test]
    fn managed_read_error_words_only_an_entry_failure() {
        let other = ManagedReadError::Other(AppError::Timeout(5));
        let other = managed_read_error(other, "pre-push", "saved");
        assert!(matches!(other, AppError::Timeout(5)), "{other:?}");
        let entry = ManagedReadError::Entry(std::io::Error::other("held"));
        let entry = managed_read_error(entry, "pre-push", "saved");
        assert!(
            matches!(&entry, AppError::Command(m)
                if m == "Couldn't read pre-push, so nothing was saved.\nheld"),
            "{entry:?}"
        );
    }

    /// A refused Save creates no hooks dir: both refusals run before `create_dir_all`.
    #[tokio::test]
    async fn hook_write_refused_into_a_missing_hooks_dir_creates_nothing() {
        let (_g, _base, repo, _remote) = hook_repo("write-missing-dir").await;
        let missing = Path::new(&repo).join("missing-hooks");
        git_ok(&repo, &["config", "core.hooksPath", "missing-hooks"]).await;
        let saved = write_hook(&repo, KEEP_LOCAL_HOOK_SCRIPT, Some(true)).await;
        assert_eq!(saved.unwrap(), changed(false));
        assert!(!missing.exists(), "the refused write created the hooks dir");
        let saved = write_hook(&repo, "#!/bin/sh\n", Some(false)).await;
        assert_eq!(saved.unwrap(), written(false));
        assert!(missing.join("pre-push").is_file());
    }

    /// Enable reads the state at `pre-push`, the name it would land on.
    #[tokio::test]
    async fn hook_enable_refuses_when_a_guard_appeared_at_pre_push() {
        let (_g, _base, repo, _remote) = hook_repo("enable").await;
        let file = managed_file(&repo, "pre-push");
        let twin = managed_file(&repo, "pre-push.disabled");
        std::fs::write(&twin, FOREIGN).unwrap();
        assert_eq!(
            toggle_hook(&repo, true, Some(false)).await.unwrap(),
            written(false)
        );
        assert_eq!(std::fs::read(&file).unwrap(), FOREIGN);
        assert_gone(&twin);
        std::fs::rename(&file, &twin).unwrap();
        install(&repo).await;
        assert_eq!(
            toggle_hook(&repo, true, Some(false)).await.unwrap(),
            changed(true)
        );
        assert_eq!(
            std::fs::read(&file).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
        assert_eq!(std::fs::read(&twin).unwrap(), FOREIGN);
    }

    /// Save, Disable and Enable never act through a link at either name, whatever the
    /// expected state, and the link and its target stay as they were.
    #[tokio::test]
    async fn hook_write_and_toggle_refuse_a_linked_hook() {
        let (_g, base, repo, _remote) = hook_repo("write-link").await;
        let outside = base.join("outside.sh");
        std::fs::write(&outside, FOREIGN).unwrap();
        let link = managed_file(&repo, "pre-push");
        let twin = managed_file(&repo, "pre-push.disabled");
        if try_symlink_file(&outside, &link).is_none() {
            return;
        }
        for expected in [None, Some(false)] {
            let saved = write_hook(&repo, "#!/bin/sh\necho new\n", expected).await;
            assert_link_refused(saved, "pre-push", "save through it");
            let off = toggle_hook(&repo, false, expected).await;
            assert_link_refused(off, "pre-push", "disable it");
            let on = toggle_hook(&repo, true, expected).await;
            assert_link_refused(on, "pre-push", "enable it");
        }
        // A link at pre-push reads unmanaged, so a list that showed the guard gets that.
        let saved = write_hook(&repo, KEEP_LOCAL_HOOK_SCRIPT, Some(true)).await;
        assert_eq!(saved.unwrap(), changed(false));
        assert_eq!(std::fs::read(&outside).unwrap(), FOREIGN);
        assert_link(&link);
        assert_gone(&twin);
        std::fs::remove_file(&link).unwrap();
        try_symlink_file(&outside, &twin).expect("a second link is made where the first was");
        for expected in [None, Some(false)] {
            let on = toggle_hook(&repo, true, expected).await;
            assert_link_refused(on, "pre-push.disabled", "enable it");
        }
        assert_gone(&link);
        assert_link(&twin);
        assert_eq!(std::fs::read(&outside).unwrap(), FOREIGN);
    }

    /// A write through a dangling link would create its target: refused, nothing made.
    #[tokio::test]
    async fn hook_write_refuses_a_dangling_link_and_creates_no_target() {
        let (_g, base, repo, _remote) = hook_repo("write-dangling").await;
        let target = base.join("missing-target.sh");
        let link = managed_file(&repo, "pre-push");
        if try_symlink_file(&target, &link).is_none() {
            return;
        }
        for expected in [None, Some(false)] {
            let saved = write_hook(&repo, "#!/bin/sh\n", expected).await;
            assert_link_refused(saved, "pre-push", "save through it");
            let off = toggle_hook(&repo, false, expected).await;
            assert_link_refused(off, "pre-push", "disable it");
        }
        let saved = write_hook(&repo, KEEP_LOCAL_HOOK_SCRIPT, Some(true)).await;
        assert_eq!(saved.unwrap(), changed(false));
        assert_gone(&target);
        assert_link(&link);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn hook_write_and_toggle_refuse_a_dangling_junction() {
        let (_g, base, repo, _remote) = hook_repo("write-junction").await;
        let gone = base.join("gone");
        std::fs::create_dir(&gone).unwrap();
        let link = managed_file(&repo, "pre-push");
        crate::test_junction::make_junction(&link, &gone);
        std::fs::remove_dir(&gone).unwrap();
        for expected in [None, Some(false)] {
            let saved = write_hook(&repo, "#!/bin/sh\n", expected).await;
            assert_link_refused(saved, "pre-push", "save through it");
            let off = toggle_hook(&repo, false, expected).await;
            assert_link_refused(off, "pre-push", "disable it");
            let on = toggle_hook(&repo, true, expected).await;
            assert_link_refused(on, "pre-push", "enable it");
        }
        assert_gone(&gone);
        assert_link(&link);
    }

    /// A dangling or looping `pre-push` link beside a disabled twin: both go, and only
    /// the regular twin reaches the recycle bin.
    #[tokio::test]
    async fn hook_delete_removes_a_dangling_or_looping_link_beside_a_disabled_twin() {
        let (_g, base, repo, _remote) = hook_repo("delete-dangling").await;
        let link = managed_file(&repo, "pre-push");
        let twin = managed_file(&repo, "pre-push.disabled");
        let partner = managed_file(&repo, "loop");
        let target = base.join("missing-target.sh");
        for looping in [false, true] {
            for expected in [None, Some(false)] {
                let row = format!("looping {looping}, expected {expected:?}");
                std::fs::write(&twin, FOREIGN).unwrap();
                let pointed = if looping { &partner } else { &target };
                if try_symlink_file(pointed, &link).is_none() {
                    return;
                }
                if looping {
                    try_symlink_file(&link, &partner).expect("the loop's second link");
                }
                let (calls, trash) = recording_trash(None);
                let outcome = hook_delete_core(&repo, "pre-push", expected, trash).await;
                assert_eq!(outcome.unwrap(), HookDeleteOutcome::Deleted, "{row}");
                assert_gone(&link);
                assert_gone(&twin);
                assert_eq!(trashed(&calls), ["pre-push.disabled"], "{row}");
                if looping {
                    assert_link(&partner);
                    std::fs::remove_file(&partner).unwrap();
                }
            }
        }
        assert_gone(&target);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn hook_delete_removes_a_dangling_junction() {
        let (_g, base, repo, _remote) = hook_repo("delete-junction").await;
        let link = managed_file(&repo, "pre-push");
        let twin = managed_file(&repo, "pre-push.disabled");
        let gone = base.join("gone");
        for expected in [None, Some(false)] {
            std::fs::create_dir(&gone).unwrap();
            crate::test_junction::make_junction(&link, &gone);
            std::fs::remove_dir(&gone).unwrap();
            std::fs::write(&twin, FOREIGN).unwrap();
            let (calls, trash) = recording_trash(None);
            let outcome = hook_delete_core(&repo, "pre-push", expected, trash).await;
            assert_eq!(outcome.unwrap(), HookDeleteOutcome::Deleted, "{expected:?}");
            assert_gone(&link);
            assert_gone(&twin);
            assert_eq!(trashed(&calls), ["pre-push.disabled"], "{expected:?}");
        }
    }

    /// A valid link is removed itself, never trashed, and what it points at survives:
    /// a file, and a folder (a directory link, and a junction on Windows).
    #[tokio::test]
    async fn hook_delete_removes_a_valid_link_and_keeps_its_target() {
        let (_g, base, repo, _remote) = hook_repo("delete-valid-link").await;
        let link = managed_file(&repo, "pre-push");
        let target = base.join("target.sh");
        std::fs::write(&target, FOREIGN).unwrap();
        if try_symlink_file(&target, &link).is_none() {
            return;
        }
        let (calls, trash) = recording_trash(None);
        let outcome = hook_delete_core(&repo, "pre-push", Some(false), trash).await;
        assert_eq!(outcome.unwrap(), HookDeleteOutcome::Deleted);
        assert_gone(&link);
        assert_eq!(std::fs::read(&target).unwrap(), FOREIGN);
        assert!(trashed(&calls).is_empty());
        let folder = base.join("folder");
        std::fs::create_dir(&folder).unwrap();
        let inner = folder.join("inner.sh");
        std::fs::write(&inner, FOREIGN).unwrap();
        for junction in [false, cfg!(windows)] {
            if junction {
                make_hooks_junction(&link, &folder).unwrap();
            } else {
                try_symlink_dir(&folder, &link).expect("a directory link is made");
            }
            let (calls, trash) = recording_trash(None);
            let outcome = hook_delete_core(&repo, "pre-push", None, trash).await;
            assert_eq!(outcome.unwrap(), HookDeleteOutcome::Deleted, "{junction}");
            assert_gone(&link);
            assert!(folder.is_dir(), "{junction}");
            assert_eq!(std::fs::read(&inner).unwrap(), FOREIGN, "{junction}");
            assert!(trashed(&calls).is_empty(), "{junction}");
        }
    }

    fn assert_delete_failed(result: AppResult<()>, message: &str) {
        assert!(
            matches!(&result, Err(AppError::Command(m)) if m == message),
            "{message:?}: {result:?}"
        );
    }

    /// A delete that can't finish says what was already done and which file stayed.
    #[test]
    fn hook_delete_failures_name_what_was_done() {
        let dir = tempfile::Builder::new()
            .prefix("gd-hook-delete-msg-")
            .tempdir()
            .unwrap();
        let dir = dir.path();
        let file = dir.join("pre-push");
        let twin = dir.join("pre-push.disabled");
        std::fs::write(&file, FOREIGN).unwrap();
        let (calls, trash) = recording_trash(Some("pre-push"));
        assert_delete_failed(
            delete_hook_files(dir, "pre-push", trash),
            "Couldn't move pre-push to the recycle bin, so nothing was deleted.\nrefused",
        );
        assert_eq!(std::fs::read(&file).unwrap(), FOREIGN);
        assert_eq!(trashed(&calls), ["pre-push"]);
        std::fs::write(&twin, FOREIGN).unwrap();
        let (_calls, trash) = recording_trash(Some("pre-push.disabled"));
        assert_delete_failed(
            delete_hook_files(dir, "pre-push", trash),
            "Moved pre-push to the recycle bin, but couldn't move pre-push.disabled to the recycle bin.\nrefused",
        );
        assert_gone(&file);
        assert_eq!(std::fs::read(&twin).unwrap(), FOREIGN);
        let outside = dir.join("outside.sh");
        std::fs::write(&outside, FOREIGN).unwrap();
        if try_symlink_file(&outside, &file).is_none() {
            return;
        }
        let (calls, trash) = recording_trash(Some("pre-push.disabled"));
        assert_delete_failed(
            delete_hook_files(dir, "pre-push", trash),
            "Removed the pre-push link, but couldn't move pre-push.disabled to the recycle bin.\nrefused",
        );
        assert_gone(&file);
        assert_eq!(std::fs::read(&outside).unwrap(), FOREIGN);
        assert_eq!(std::fs::read(&twin).unwrap(), FOREIGN);
        assert_eq!(trashed(&calls), ["pre-push.disabled"]);
    }

    /// The read and link-removal forms, through the one builder.
    #[test]
    fn hook_delete_failure_builds_each_form() {
        let cause = std::io::Error::other("x");
        let moved = Some("Moved pre-push to the recycle bin");
        let rows = [
            (
                None,
                "read pre-push.disabled",
                "Couldn't read pre-push.disabled, so nothing was deleted.\nx",
            ),
            (
                moved,
                "read pre-push.disabled",
                "Moved pre-push to the recycle bin, but couldn't read pre-push.disabled.\nx",
            ),
            (
                None,
                "remove the pre-push link",
                "Couldn't remove the pre-push link, so nothing was deleted.\nx",
            ),
            (
                moved,
                "remove the pre-push.disabled link",
                "Moved pre-push to the recycle bin, but couldn't remove the pre-push.disabled link.\nx",
            ),
        ];
        for (done, act, message) in rows {
            assert_delete_failed(Err(delete_failure(done, act, &cause)), message);
        }
    }

    /// Other `pre-push` links: a link to a foreign file or a dangling one reads foreign,
    /// a link to a marker-carrying file reads linked ahead of a manager config, and the
    /// list shows it active and unmanaged.
    #[tokio::test]
    async fn keep_local_hook_reads_each_kind_of_pre_push_link() {
        let (_g, base, repo, _remote) = hook_repo("link-kinds").await;
        let link = managed_file(&repo, "pre-push");
        let foreign = base.join("foreign.sh");
        std::fs::write(&foreign, FOREIGN).unwrap();
        let missing = base.join("missing.sh");
        let marked = base.join("marked.sh");
        std::fs::write(&marked, KEEP_LOCAL_HOOK_SCRIPT).unwrap();
        for target in [&foreign, &missing] {
            if try_symlink_file(target, &link).is_none() {
                return;
            }
            for st in [
                status(&repo).await,
                install(&repo).await,
                remove(&repo).await,
            ] {
                assert_status(&st, Blocked, Some(ForeignHook), None);
                assert_present(&st, false);
            }
            assert_link(&link);
            std::fs::remove_file(&link).unwrap();
        }
        assert_eq!(std::fs::read(&foreign).unwrap(), FOREIGN);
        assert_gone(&missing);
        try_symlink_file(&marked, &link).expect("a third link is made");
        let husky = Path::new(&repo).join(".husky");
        std::fs::create_dir(&husky).unwrap();
        for st in [
            status(&repo).await,
            install(&repo).await,
            remove(&repo).await,
        ] {
            assert_status(&st, Blocked, Some(LinkedHook), None);
            assert_present(&st, false);
        }
        std::fs::remove_dir(&husky).unwrap();
        let info = git_hooks_list(repo.clone()).await.unwrap();
        let listed = info.entries.iter().find(|e| e.name == "pre-push").unwrap();
        assert!(matches!(listed.state, HookState::Active), "{listed:?}");
        assert!(!listed.managed, "{listed:?}");
        assert_link(&link);
        assert_eq!(
            std::fs::read(&marked).unwrap(),
            KEEP_LOCAL_HOOK_SCRIPT.as_bytes()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn keep_local_hook_does_not_block_on_a_fifo_behind_a_pre_push_link() {
        let (_g, base, repo, _remote) = hook_repo("fifo-link").await;
        let fifo = base.join("fifo");
        if try_mkfifo(&fifo).is_none() {
            return;
        }
        let link = managed_file(&repo, "pre-push");
        try_symlink_file(&fifo, &link).expect("a unix symlink is made");
        for st in acts_within_bound(&repo) {
            assert_status(&st, Blocked, Some(ForeignHook), None);
        }
        assert_link(&link);
    }

    /// Makes `link` a directory link to `target` on every platform: a junction on
    /// Windows (no privilege needed), a symlink elsewhere.
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(windows)]
        crate::test_junction::make_junction(link, target);
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// The husky config `detect_manager` reports for `hooks` under `root`, or None.
    fn husky_config(root: &Path, hooks: &Path) -> Option<PathBuf> {
        let (manager, config) = detect_manager(&root.to_string_lossy(), hooks)?;
        assert_eq!(manager, "husky", "{root:?} {hooks:?}");
        Some(config)
    }

    fn canonical(path: &Path) -> PathBuf {
        dunce::canonicalize(path).unwrap()
    }

    #[test]
    fn detect_manager_matches_husky_as_a_path_component() {
        let guard = tempfile::Builder::new()
            .prefix("gd-husky-")
            .tempdir()
            .unwrap();
        let t = guard.path();
        let made = |p: PathBuf| {
            std::fs::create_dir_all(&p).unwrap();
            p
        };
        let repo = made(t.join("repo"));
        let nested = made(t.join(".husky").join("repo"));
        let with_dir = made(t.join("with-dir"));
        made(with_dir.join(".husky"));
        let none_rows = [
            (&repo, made(t.join("x.husky").join("hooks"))),
            (&repo, made(t.join(".husky-tools").join("hooks"))),
            (&nested, made(nested.join(".git").join("hooks"))),
            (&nested, made(nested.join("up").join(".HUSKY").join("_"))),
            // A hooks path climbing out of the root past the `.husky` folder holding it.
            (&nested, made(nested.join("..").join("..").join("hooks"))),
            // The root spelled raw, the hooks dir canonically (macOS /private/var, 8.3).
            (
                &nested,
                canonical(t)
                    .join(".husky")
                    .join("repo")
                    .join(".git")
                    .join("hooks"),
            ),
        ];
        for (root, hooks) in none_rows {
            assert_eq!(husky_config(root, &hooks), None, "{root:?} {hooks:?}");
        }
        let husky_rows = [
            (
                &nested,
                made(nested.join("frontend").join(".husky").join("_")),
                nested.join("frontend").join(".husky"),
            ),
            (
                &repo,
                made(t.join(".husky").join("hooks")),
                t.join(".husky"),
            ),
            (
                &with_dir,
                made(with_dir.join(".git").join("hooks")),
                with_dir.join(".husky"),
            ),
            (
                &nested,
                made(nested.join("..").join("hooks")),
                t.join(".husky"),
            ),
        ];
        for (root, hooks, expected) in husky_rows {
            let config = husky_config(root, &hooks).expect("husky");
            assert_eq!(
                canonical(&config),
                canonical(&expected),
                "{root:?} {hooks:?}"
            );
        }
        // The lexical arm alone: a hooks dir not created yet below the root.
        let pending = nested.join("sub").join(".husky").join("_");
        assert_eq!(
            husky_config(&nested, &pending),
            Some(nested.join("sub").join(".husky"))
        );
        // A `..` that stays below the root, under no `.husky`; the tail isn't created, so
        // the `<root>/.husky` folder rule can't answer for it.
        let climb = made(t.join("climb"));
        made(climb.join("x"));
        let hooks = climb.join("x").join("..").join(".husky").join("_");
        assert_eq!(husky_config(&climb, &hooks), Some(climb.join(".husky")));
        // The canonical arm: a root spelled through a linked folder, its hooks dir
        // through the real one under a `.husky` folder, is the root's own `.git/hooks`.
        let real = made(t.join(".husky").join("real"));
        let hooks = made(real.join(".git").join("hooks"));
        let alias = t.join("alias");
        link_dir(&real, &alias);
        assert_eq!(husky_config(&alias, &canonical(&hooks)), None);
        let inside = made(real.join("web").join(".husky").join("_"));
        let config = husky_config(&alias, &canonical(&inside)).expect("husky");
        assert_eq!(
            canonical(&config),
            canonical(&real.join("web").join(".husky"))
        );
    }

    /// unix resolves a `..` after a linked folder physically, so a hooks path climbing
    /// back out of a link to a shared `.husky` subfolder is that shared `.husky`, though
    /// its lexical spelling names a folder under no `.husky`.
    #[cfg(unix)]
    #[test]
    fn detect_manager_resolves_a_climb_through_a_linked_folder_physically() {
        let guard = tempfile::Builder::new()
            .prefix("gd-husky-link-")
            .tempdir()
            .unwrap();
        let t = guard.path();
        let repo = t.join("repo");
        std::fs::create_dir_all(repo.join("vendor")).unwrap();
        let stubs = t.join("shared").join(".husky").join("stubs");
        std::fs::create_dir_all(&stubs).unwrap();
        let link = repo.join("vendor").join("hooks-link");
        std::os::unix::fs::symlink(&stubs, &link).unwrap();
        let hooks = link.join("..").join("hooks");
        assert_eq!(lexically_normal(&hooks), repo.join("vendor").join("hooks"));
        let config = husky_config(&repo, &hooks).expect("husky");
        assert_eq!(
            canonical(&config),
            canonical(&t.join("shared").join(".husky"))
        );
        // The names after the last `..` keep their spelling: a `_` linked to a folder
        // under no `.husky` is still in the shared `.husky`.
        let plain = t.join("plain");
        std::fs::create_dir(&plain).unwrap();
        std::os::unix::fs::symlink(&plain, t.join("shared").join(".husky").join("_")).unwrap();
        let config = husky_config(&repo, &link.join("..").join("_")).expect("husky");
        assert_eq!(config, canonical(&t.join("shared").join(".husky")));
    }

    /// The canonical root compare keeps the names below the root: a root reached only
    /// through a linked ancestor, whose `.husky` is itself a link, is still husky. The
    /// alias sits under a `.husky` folder, which a spelled-path scan would pick instead.
    #[test]
    fn detect_manager_keeps_a_linked_husky_below_a_root_matched_canonically() {
        let guard = tempfile::Builder::new()
            .prefix("gd-husky-canon-")
            .tempdir()
            .unwrap();
        let t = guard.path();
        let real = t.join("real");
        let home = real.join("tools").join("home");
        std::fs::create_dir_all(home.join("_")).unwrap();
        std::fs::create_dir_all(real.join("web")).unwrap();
        link_dir(&home, &real.join("web").join(".husky"));
        std::fs::create_dir_all(t.join(".husky")).unwrap();
        let alias = t.join(".husky").join("alias");
        link_dir(&real, &alias);
        let hooks = alias.join("web").join(".husky").join("_");
        let config = husky_config(&real, &hooks).expect("husky");
        assert_eq!(config, alias.join("web").join(".husky"));
    }

    /// A hooks path that enters the clone through a link below its root, where no
    /// spelled ancestor is the root, is judged by where it lands, never by `.husky`
    /// folders in its spelling outside the clone.
    #[test]
    fn detect_manager_judges_a_link_into_the_root_by_where_it_lands() {
        let guard = tempfile::Builder::new()
            .prefix("gd-husky-landed-")
            .tempdir()
            .unwrap();
        let t = guard.path();
        let husky = t.join(".husky");
        let repo = husky.join("repo");
        std::fs::create_dir_all(repo.join(".git").join("hooks")).unwrap();
        let alias = husky.join("hook-alias");
        link_dir(&repo.join(".git").join("hooks"), &alias);
        assert_eq!(husky_config(&repo, &alias), None);
        let plain = t.join("plain").join("repo");
        let husky_dir = plain.join("frontend").join(".husky");
        std::fs::create_dir_all(husky_dir.join("_")).unwrap();
        let hk = t.join("hk");
        link_dir(&husky_dir, &hk);
        let config = husky_config(&plain, &hk.join("_")).expect("husky");
        assert_eq!(canonical(&config), canonical(&husky_dir));
        std::fs::create_dir_all(repo.join("tools").join("hooks")).unwrap();
        let al = husky.join("al");
        link_dir(&repo.join("tools"), &al);
        assert_eq!(husky_config(&repo, &al.join("hooks")), None);
    }

    /// A climb whose lexical and physical folders differ through the last `..` takes the
    /// physical one, though both then reach one folder through their `_` links.
    #[cfg(unix)]
    #[test]
    fn detect_manager_takes_a_physical_climb_whose_endpoints_meet() {
        let guard = tempfile::Builder::new()
            .prefix("gd-husky-meet-")
            .tempdir()
            .unwrap();
        let t = guard.path();
        let repo = t.join("repo");
        std::fs::create_dir_all(repo.join("vendor")).unwrap();
        let stubs = t.join("shared").join(".husky").join("stubs");
        std::fs::create_dir_all(&stubs).unwrap();
        let shims = t.join("shims");
        std::fs::create_dir(&shims).unwrap();
        let link = repo.join("vendor").join("link");
        std::os::unix::fs::symlink(&stubs, &link).unwrap();
        std::os::unix::fs::symlink(&shims, t.join("shared").join(".husky").join("_")).unwrap();
        std::os::unix::fs::symlink(&shims, repo.join("vendor").join("_")).unwrap();
        let config = husky_config(&repo, &link.join("..").join("_")).expect("husky");
        assert_eq!(config, canonical(&t.join("shared").join(".husky")));
    }

    /// A repository stored inside a `.husky` folder, with the default hooks folder, is
    /// no husky install.
    #[tokio::test]
    async fn keep_local_hook_reads_a_repository_inside_a_husky_folder_as_its_own() {
        let (_g, _base, repo, _remote) = hook_repo_at("in-husky", ".husky/repo").await;
        assert_status(&status(&repo).await, Absent, None, None);
        let info = git_hooks_list(repo.clone()).await.unwrap();
        assert_eq!(info.manager, None);
        assert_eq!(info.manager_config, None);
    }

    /// git prints a climbing `core.hooksPath` verbatim; one that climbs out past the
    /// `.husky` folder holding the repository is a custom hooks path, not husky.
    #[tokio::test]
    async fn keep_local_hook_reads_a_hooks_path_climbing_out_of_a_husky_folder_as_custom() {
        let (_g, base, repo, _remote) = hook_repo_at("climb", ".husky/repo").await;
        std::fs::create_dir(base.join("hooks")).unwrap();
        git_ok(&repo, &["config", "core.hooksPath", "../../hooks"]).await;
        assert_status(&status(&repo).await, Blocked, Some(CustomHooksPath), None);
        let info = git_hooks_list(repo.clone()).await.unwrap();
        assert_eq!(info.manager, None);
        assert_eq!(info.manager_config, None);
    }

    /// A Save removes a linked disabled twin itself, a file link and (on Windows) a
    /// junction, and what it pointed at survives.
    #[tokio::test]
    async fn hook_write_removes_a_linked_disabled_twin_and_keeps_its_target() {
        let (_g, base, repo, _remote) = hook_repo("write-twin-link").await;
        let twin = managed_file(&repo, "pre-push.disabled");
        let target = base.join("target.sh");
        std::fs::write(&target, FOREIGN).unwrap();
        let folder = base.join("folder");
        std::fs::create_dir(&folder).unwrap();
        let inner = folder.join("inner.sh");
        std::fs::write(&inner, FOREIGN).unwrap();
        for junction in [false, cfg!(windows)] {
            if junction {
                make_hooks_junction(&twin, &folder).unwrap();
            } else if try_symlink_file(&target, &twin).is_none() {
                continue;
            }
            let saved = write_hook(&repo, "#!/bin/sh\necho new\n", None).await;
            assert_eq!(saved.unwrap(), written(false), "{junction}");
            assert_gone(&twin);
            assert_eq!(std::fs::read(&target).unwrap(), FOREIGN, "{junction}");
            assert_eq!(std::fs::read(&inner).unwrap(), FOREIGN, "{junction}");
        }
    }

    /// The lexical root compare folds letter case on Windows.
    #[cfg(windows)]
    #[test]
    fn root_prefix_len_folds_letter_case_on_windows() {
        let root = Path::new(r"C:\Users\Someone\Repo");
        let upper = PathBuf::from(r"C:\USERS\SOMEONE\REPO");
        assert_eq!(root_prefix_len(&upper, &root.join("x")), Some(5));
    }

    /// A failed lstat refuses with the read sentence: it can't tell whether a link is there.
    #[test]
    fn link_refusal_words_a_failed_lstat() {
        let denied = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let refused = link_refusal(Err(denied), "pre-push.disabled", "enabled", "enable it");
        assert!(
            matches!(&refused, Err(AppError::Command(m))
                if m == "Couldn't read pre-push.disabled, so nothing was enabled.\ndenied"),
            "{refused:?}"
        );
        let wire = serde_json::to_value(refused.unwrap_err()).unwrap();
        assert_eq!(wire["kind"], "command", "{wire}");
    }
}
