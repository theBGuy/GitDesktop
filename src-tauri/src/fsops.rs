use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Best-effort sweep of stale leftover temp files (`.{name}.<pid>.<uuid>.tmp`) from a
/// prior crash in the write→rename window. Only removes ones older than a minute, so a
/// concurrent writer's in-flight temp is never touched. All errors are ignored (advisory).
fn sweep_stale_temps(dir: &Path, file_name: &str) {
    let prefix = format!(".{file_name}.");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if !name.starts_with(&prefix) || !name.ends_with(".tmp") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age.as_secs() >= 60);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Write `contents` to `path` atomically: unique temp file in the same directory, then
/// rename over the target, so a concurrent reader (another GUI or MCP process) never
/// sees a partial file. Creates the parent directory if needed.
///
/// `std::fs::rename` replaces an existing destination on every platform (on Windows via
/// `MoveFileEx` + `MOVEFILE_REPLACE_EXISTING`). On IO failure (target locked,
/// permissions) the temp file is removed rather than leaked.
pub fn atomic_write(path: &Path, contents: &[u8]) -> AppResult<()> {
    let dir = path.parent().ok_or_else(|| {
        AppError::Command(format!("path {} has no parent directory", path.display()))
    })?;
    std::fs::create_dir_all(dir)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "tmp".to_string());
    // Best-effort: clear any temp a prior crash leaked in the write→rename window before
    // adding our own, so a sensitive dir like a repo root doesn't accumulate strays.
    sweep_stale_temps(dir, &file_name);
    // Unique temp name (pid + a fresh uuid) so concurrent writers — GUI, MCP, or parallel
    // test threads sharing one pid — can't collide on it.
    let tmp = dir.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&tmp, contents)?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Io(e));
    }
    Ok(())
}

/// True when `name`'s stem (everything before the first dot) is a reserved DOS
/// device name. Windows resolves such a name to the DEVICE at any position in a
/// path, extension or not, so `nul.txt` is as unopenable as `nul`. Win32 also
/// strips trailing dots and SPACES off the final component, which makes `nul `
/// the device too (measured); the first-dot split covers the dots, the trim
/// covers the spaces. Only COM/LPT 1–9 are devices; `com0`, `com10` and
/// `console` are ordinary names.
#[cfg_attr(not(windows), allow(dead_code))]
fn is_reserved_device_name(name: &str) -> bool {
    let stem = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        _ => stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|d| d.len() == 1 && matches!(d.as_bytes()[0], b'1'..=b'9')),
    }
}

/// Rewrites an absolute path into its `\\?\` verbatim form, which the Win32 layer
/// passes to the filesystem without the DOS-name resolution that turns `nul` into
/// a device. Returns `None` for a relative path — resolving one against the
/// process cwd would target a file the caller never named — and for a `\\.\`
/// device-namespace path, which names a device rather than a file on disk.
#[cfg(windows)]
fn verbatim_path(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    // Verbatim paths take no forward slashes; repo paths arrive from the frontend
    // with them. A non-UTF-8 name (unpaired surrogate) simply gets no verbatim form.
    let text = path.to_str()?.replace('/', "\\");
    if text.starts_with(r"\\.\") {
        return None;
    }
    if text.starts_with(r"\\?\") {
        return Some(PathBuf::from(text));
    }
    Some(PathBuf::from(match text.strip_prefix(r"\\") {
        Some(share) => format!(r"\\?\UNC\{share}"),
        None => format!(r"\\?\{text}"),
    }))
}

/// Permanently removes a reserved-device-named entry through its verbatim path.
/// Returns whether it did; a non-reserved name is left for the caller to report.
#[cfg(windows)]
fn permanent_delete_reserved(path: &Path) -> bool {
    use std::os::windows::fs::FileTypeExt;

    let reserved = path
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(is_reserved_device_name);
    if !reserved {
        return false;
    }
    let Some(verbatim) = verbatim_path(path) else {
        return false;
    };
    // The dir-vs-file probe rides the verbatim path too: a plain-path probe would
    // describe the device rather than the entry on disk.
    // It also does not follow links: a reparse point is classified and removed as
    // ITSELF, so a directory link unlinks with `remove_dir` and only a real
    // directory earns the recursive sweep.
    let kind = std::fs::symlink_metadata(&verbatim)
        .map(|m| m.file_type())
        .ok();
    let removed = match kind {
        Some(k) if k.is_symlink_dir() => std::fs::remove_dir(&verbatim),
        Some(k) if k.is_dir() => std::fs::remove_dir_all(&verbatim),
        // Plain file, file link, or an entry the probe couldn't describe — the
        // file unlink is the only attempt left, and it fails harmlessly.
        _ => std::fs::remove_file(&verbatim),
    };
    removed.is_ok()
}

/// Moves `path` to the OS trash. Trash is always tried first, so anything the
/// recycle bin accepts stays recoverable; only on Windows, and only after trash
/// has refused a reserved-device name (`nul`, `con`, `com3`, …), does the
/// permanent verbatim-path unlink run. A failed fallback reports the original
/// trash error — the second one names the same refusal with less context.
pub(crate) fn trash_delete(path: &Path) -> std::io::Result<()> {
    let err = match trash::delete(path) {
        Ok(()) => return Ok(()),
        Err(e) => std::io::Error::other(e.to_string()),
    };
    #[cfg(windows)]
    if permanent_delete_reserved(path) {
        return Ok(());
    }
    Err(err)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedEditor {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedTerminal {
    /// Known kind id the launcher dispatches on, e.g. "powershell".
    pub id: String,
    pub name: String,
    pub path: String,
}

/// Trims an ignore pattern the way git reads one: a trailing SPACE is
/// insignificant unless backslash-escaped, because `notes\ ` is the only way to
/// name a file whose name ends in a space. A blanket `trim()` eats that escape
/// and silently retargets the pattern at a different file.
///
/// Only `' '` — git's `trim_trailing_spaces` (dir.c) special-cases the space
/// alone, so a trailing TAB is part of the pattern (measured, git 2.51.1:
/// pattern `foo\t` matches `foo\t` and not `foo`). Trimming it here would
/// retarget the pattern exactly the way the space case does.
///
/// The LEADING trim is ours, not git's: git treats leading whitespace as part of
/// the pattern (measured — ` notes.md` hides ` notes.md`, not `notes.md`). It is
/// deliberate and unreachable from the menus, whose patterns all begin with `/`
/// or `*`; it exists to forgive a hand-typed settings line.
pub(crate) fn trim_ignore_pattern(pattern: &str) -> &str {
    let rest = pattern.trim_start().trim_end_matches(['\r', '\n']);
    let bytes = rest.as_bytes();
    let mut end = rest.len();
    while end > 0 && bytes[end - 1] == b' ' {
        // An odd run of preceding backslashes escapes it; an even run is itself
        // escaped backslashes and leaves the space bare.
        let slashes = bytes[..end - 1].iter().rev().take_while(|&&c| c == b'\\').count();
        if slashes % 2 == 1 {
            break;
        }
        end -= 1;
    }
    &rest[..end]
}

/// Appends one or more ignore patterns to the repo root .gitignore (created if
/// absent). Trims and de-duplicates the batch and skips any pattern already
/// present as an exact line, so bulk-ignoring a selection can't add duplicates.
/// Returns the number of patterns actually appended (0 when every pattern was
/// empty or already present).
#[tauri::command]
pub async fn append_to_gitignore(repo_path: String, patterns: Vec<String>) -> AppResult<usize> {
    // Normalize + de-dupe within the batch (preserving order).
    let mut wanted: Vec<String> = Vec::new();
    for p in patterns {
        let t = trim_ignore_pattern(&p).to_string();
        if !t.is_empty() && !wanted.contains(&t) {
            wanted.push(t);
        }
    }
    if wanted.is_empty() {
        return Ok(0);
    }

    let path = Path::new(&repo_path).join(".gitignore");
    let mut content = match tokio::fs::read_to_string(&path).await {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(AppError::Io(e)),
    };

    // Drop anything already in the file (scoped so the borrow ends before we
    // mutate `content`).
    let to_add: Vec<String> = {
        let existing: std::collections::HashSet<&str> =
            content.lines().map(trim_ignore_pattern).collect();
        wanted
            .into_iter()
            .filter(|p| !existing.contains(p.as_str()))
            .collect()
    };
    if to_add.is_empty() {
        return Ok(0);
    }
    let added = to_add.len();

    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    for p in to_add {
        content.push_str(&p);
        content.push('\n');
    }
    tokio::fs::write(&path, content).await.map_err(AppError::Io)?;
    Ok(added)
}

/// Reads a small text file the user picked (e.g. a VSCode
/// `language-configuration.json` or `*.tmLanguage.json` to import). Capped so a
/// misfire can't pull a huge file into memory.
#[tauri::command]
pub async fn read_text_file(path: String) -> AppResult<String> {
    const MAX_BYTES: u64 = 4 * 1024 * 1024;
    let meta = tokio::fs::metadata(&path).await.map_err(AppError::Io)?;
    if meta.len() > MAX_BYTES {
        return Err(AppError::InvalidArgument("file is too large".into()));
    }
    tokio::fs::read_to_string(&path).await.map_err(AppError::Io)
}

/// Moves a repository folder to the OS recycle bin. Refuses anything that
/// isn't a git repository root, so a bad path can never trash an unrelated
/// folder.
#[tauri::command]
pub async fn delete_repo_folder(path: String) -> AppResult<()> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(AppError::InvalidArgument(format!("not a directory: {path}")));
    }
    if !dir.join(".git").exists() {
        return Err(AppError::InvalidArgument(format!(
            "not a git repository root: {path}"
        )));
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Retry briefly: a just-closed repo may still have an in-flight git
        // subprocess holding a handle to the folder, which makes Windows abort
        // the move. A few short waits let those processes exit.
        const ATTEMPTS: usize = 3;
        // Platform-correct name for the OS trash (used in the user-facing message).
        #[cfg(windows)]
        const TRASH_NAME: &str = "Recycle Bin";
        #[cfg(not(windows))]
        const TRASH_NAME: &str = "Trash";

        let mut cause = String::new();
        for attempt in 0..ATTEMPTS {
            match trash_delete(&dir) {
                Ok(()) => return Ok(()),
                Err(e) => {
                    cause = e.to_string();
                    if attempt + 1 < ATTEMPTS {
                        std::thread::sleep(std::time::Duration::from_millis(300));
                    }
                }
            }
        }
        // Lead with actionable copy; keep the raw cause as an honest suffix.
        Err(AppError::Io(std::io::Error::other(format!(
            "Couldn't move the repository to the {TRASH_NAME} — the folder may be in use \
             by an open editor, terminal, or file-explorer window. Close them and try \
             again. ({cause})"
        ))))
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
}

#[tauri::command]
pub async fn reveal_in_explorer(path: String) -> AppResult<()> {
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

#[tauri::command]
pub async fn open_with_default(path: String) -> AppResult<()> {
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

/// Opens a terminal rooted at `path`. `terminal` is a known kind id (e.g.
/// "powershell", "windows-terminal", "git-bash", "custom", "custom-command")
/// and `program` its executable; both empty means pick a sensible default.
/// `command` carries the free-text argv template for the "custom-command" mode.
#[tauri::command]
pub async fn open_in_terminal(
    path: String,
    terminal: Option<String>,
    program: Option<String>,
    command: Option<String>,
) -> AppResult<()> {
    if !Path::new(&path).is_dir() {
        return Err(AppError::InvalidArgument(format!(
            "not a directory: {path}"
        )));
    }
    let kind = terminal.unwrap_or_default();
    let program = program.unwrap_or_default();
    // The custom-command mode is a free-text argv template, resolved and spawned
    // with no shell (see `launch_custom_command`); it is platform-neutral, so it
    // dispatches ahead of the per-OS kind matchers below.
    if kind == "custom-command" {
        let command = command.unwrap_or_default();
        if !command.trim().is_empty() {
            return launch_custom_command(&command, &path).await;
        }
    }
    #[cfg(windows)]
    {
        launch_terminal_windows(&kind, &program, &path)
    }
    #[cfg(not(windows))]
    {
        launch_terminal_unix(&kind, &program, &path)
    }
}

/// Splits a command template into argv tokens: whitespace-separated, with
/// double-quotes grouping a run that may contain spaces (the quotes are
/// stripped). There are no escape sequences beyond quote grouping — a literal
/// double-quote inside a path is not supported, which is fine for the launcher
/// templates this powers. Returns `InvalidArgument` for an empty/whitespace-only
/// template or one with an unbalanced (unterminated) double-quote.
fn tokenize_command(command: &str) -> AppResult<Vec<String>> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut has_token = false;
    for ch in command.chars() {
        match ch {
            '"' => {
                // A quote toggles grouping and always starts a token (so `""`
                // yields an empty argument rather than nothing).
                in_quotes = !in_quotes;
                has_token = true;
            }
            c if c.is_whitespace() && !in_quotes => {
                if has_token {
                    tokens.push(std::mem::take(&mut current));
                    has_token = false;
                }
            }
            c => {
                current.push(c);
                has_token = true;
            }
        }
    }
    if in_quotes {
        // An unterminated quote is almost certainly a typo; parsing "the rest of
        // the string is one token" would silently mis-launch. Reject it instead.
        return Err(AppError::InvalidArgument(
            "unbalanced quote in terminal command".to_string(),
        ));
    }
    if has_token {
        tokens.push(current);
    }
    if tokens.is_empty() {
        return Err(AppError::InvalidArgument(
            "empty terminal command".to_string(),
        ));
    }
    Ok(tokens)
}

/// Substitutes every `{path}` occurrence within each token by `path`. This is a
/// per-token substring replace (not a re-tokenize), so `--cwd={path}` expands in
/// place and a repository path containing spaces, `;`, or `$()` stays a single
/// argv token — it is never re-split and never reaches a shell.
fn substitute_path(tokens: &[String], path: &str) -> Vec<String> {
    tokens.iter().map(|t| t.replace("{path}", path)).collect()
}

/// True when `program` ends in a Windows batch extension (`.cmd`/`.bat`,
/// case-insensitive).
fn is_batch_file(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// True when the first command token looks like an explicit path (contains a
/// `/` or `\` separator) rather than a bare program name to look up. This
/// selects `resolve_named`'s two behaviors: a path-like token is exists-checked
/// as given (`Some(token)`), a bare name goes through the real PATH/PATHEXT
/// (and, on Unix, login-shell) lookup (`None`).
fn first_token_is_pathlike(token: &str) -> bool {
    token.contains(['/', '\\'])
}

/// Returns `p` unchanged if already absolute, else joins it onto `base`. Used to
/// pin a relative resolved program (e.g. `./bin/wt`, which `resolve_named`
/// exists-checks against the app's cwd but returns verbatim) to that same base
/// BEFORE we `current_dir(repo)` the child — otherwise the path we exists-checked
/// (against app cwd) and the path the OS execs (against the repo cwd, on Unix)
/// would differ: a confused deputy. Joining (not `canonicalize`) keeps the bytes
/// identical to what was checked and avoids Windows `\\?\` verbatim-path quirks.
fn ensure_absolute(p: PathBuf, base: &Path) -> PathBuf {
    if p.is_absolute() {
        p
    } else {
        base.join(p)
    }
}

/// Launches a user-supplied command template with no shell: tokenize → expand
/// `{path}` → resolve the first token to an absolute executable → spawn it with
/// the remaining tokens, rooted at the repository directory. Every step here is
/// deliberately shell-free so a path with spaces/metacharacters can never be
/// re-interpreted.
async fn launch_custom_command(command: &str, path: &str) -> AppResult<()> {
    use std::process::Command;

    let tokens = tokenize_command(command)?;
    let tokens = substitute_path(&tokens, path);
    // tokenize_command guarantees a non-empty list — but a quoted-empty template
    // ('"" -d …') yields an EMPTY first token, which would reach the resolver as an
    // empty program name and fail with a confusing blank-named error. Reject it.
    let (first, rest) = tokens.split_first().expect("tokens is non-empty");
    if first.is_empty() {
        return Err(AppError::InvalidArgument(
            "terminal command must start with a program name".to_string(),
        ));
    }

    // SECURITY: resolve the program to an ABSOLUTE path BEFORE building the Command
    // with `current_dir(path)`. On Windows, `Command` resolves a bare program name
    // against the child's current_dir (the repository!) ahead of PATH — so an
    // unresolved bare token would execute a repo-committed `wt.exe`.
    //
    // `resolve_named` only PATH-searches when `bin_path` is None; a Some(non-empty)
    // value is taken as an explicit path and merely exists-checked. So route by shape:
    // a path-like first token is exists-checked as given, a bare name goes through the
    // real PATH/PATHEXT/login-shell lookup.
    let bin_path = first_token_is_pathlike(first).then_some(first.as_str());
    let resolved = crate::agent::resolve_named(&[first.as_str()], bin_path)
        .await
        .ok_or_else(|| {
            AppError::InvalidArgument(format!(
                "terminal command not found: {first}"
            ))
        })?;
    // A relative path-like token (`./bin/wt`) was exists-checked against the APP's cwd
    // but returned verbatim; `current_dir(repo)` below would make the OS exec it
    // against the REPO dir. Pin it so checked path == executed path (`ensure_absolute`).
    let resolved = ensure_absolute(resolved, &std::env::current_dir().map_err(AppError::Io)?);

    // SECURITY: reject batch files on the RESOLVED path — a bare `foo` on PATH
    // can resolve to `foo.cmd`, which runs through `cmd.exe`, silently
    // reintroducing a shell and `%VAR%` expansion that the shell-free
    // custom-command mode must avoid.
    if is_batch_file(&resolved.to_string_lossy()) {
        return Err(AppError::InvalidArgument(format!(
            "terminal command points at a batch file ({}); point at the real \
             executable instead",
            resolved.display()
        )));
    }

    let mut cmd = Command::new(&resolved);
    crate::agent::sanitize_child_env(&mut cmd);
    cmd.args(rest);
    // Always root at the repository directory: harmless when `{path}` is used
    // explicitly, and the only cwd signal for launchers that inherit it
    // (multiplexers, wrappers) rather than taking a directory flag. No `open -a`
    // anywhere — it does not propagate cwd into a `.app`; GUI `.app`s belong in
    // the "Custom…" mode.
    cmd.current_dir(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — hide any transient console
    }
    cmd.spawn().map(|_| ()).map_err(AppError::Io)
}

#[cfg(windows)]
fn launch_terminal_windows(kind: &str, program: &str, path: &str) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Console shells (cmd/powershell/wsl) launch through cmd's `start` so the shell
    // gets a fresh, fully wired console; spawning them with CREATE_NEW_CONSOLE leaves
    // their stdio bound to our parent's handles, so the window opens but takes no
    // keyboard input. `start` inherits the intermediary cmd's working dir, set here.
    // The title argument must be non-empty: `start ""` leaves an empty console title,
    // which makes Node/libuv abort ("Assertion failed: process_title"). The line is
    // built by hand and wrapped in outer quotes so `cmd /c` strips exactly that pair.
    let console = |exe: &str, args: &[String]| -> AppResult<()> {
        let mut inner = format!("start \"GitDesktop\" \"{exe}\"");
        for a in args {
            inner.push_str(" \"");
            inner.push_str(a);
            inner.push('"');
        }
        let mut c = Command::new("cmd");
        c.current_dir(path);
        c.raw_arg(format!("/c \"{inner}\""));
        c.creation_flags(CREATE_NO_WINDOW); // hide the transient cmd shim
        c.spawn().map(|_| ()).map_err(AppError::Io)
    };
    // GUI terminals (Windows Terminal, Git Bash/mintty, ghostty) create their
    // own window; they take the working dir as an argument.
    let gui = |exe: &str, args: &[String]| -> AppResult<()> {
        Command::new(exe).args(args).spawn().map(|_| ()).map_err(AppError::Io)
    };
    let or = |fallback: &str| -> String {
        if program.is_empty() {
            fallback.to_string()
        } else {
            program.to_string()
        }
    };

    match kind {
        "windows-terminal" => gui(&or("wt.exe"), &["-d".into(), path.into()]),
        "powershell" => console(&or("powershell.exe"), &[]),
        "pwsh" => console(&or("pwsh.exe"), &[]),
        "cmd" => console(&or("cmd.exe"), &[]),
        // wsl maps the inherited Windows working dir into the distro, so no
        // `--cd` (which only exists on newer WSL builds) is needed.
        "wsl" => console(&or("wsl.exe"), &[]),
        "git-bash" => gui(&or("git-bash.exe"), &[format!("--cd={path}")]),
        "ghostty" => gui(&or("ghostty.exe"), &[format!("--working-directory={path}")]),
        "custom" if !program.is_empty() => console(program, &[]),
        // Default: cmd.exe is always present and reliably opens a window.
        _ => console("cmd.exe", &[]),
    }
}

#[cfg(not(windows))]
fn launch_terminal_unix(kind: &str, program: &str, path: &str) -> AppResult<()> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    {
        let bundle = Path::new(program);
        // A stored bundle path that no longer exists (the app was uninstalled
        // after being picked) would make `open -a <missing>` a silent no-op that
        // still returns Ok from spawn(); fall back to Terminal.app instead.
        if !program.is_empty() && !bundle.exists() {
            return Command::new("open")
                .args(["-a", "Terminal", path])
                .spawn()
                .map(|_| ())
                .map_err(AppError::Io);
        }
        // `open -a <app> <dir>` only roots the window at the folder for apps that
        // register as folder handlers (Terminal, iTerm). Pure-GUI emulators
        // (Alacritty, kitty, WezTerm) ignore the dir arg, so spawn their inner
        // binary with the tool's own working-directory flag. Warp/Hyper/Ghostty
        // have no stable such flag → best-effort `open -a` (may open at $HOME).
        let inner = |bin: &str| bundle.join("Contents").join("MacOS").join(bin);
        let flag_launch = match kind {
            "alacritty" if !program.is_empty() => {
                Some((inner("alacritty"), vec!["--working-directory", path]))
            }
            "kitty" if !program.is_empty() => Some((inner("kitty"), vec!["--directory", path])),
            "wezterm" if !program.is_empty() => {
                Some((inner("wezterm"), vec!["start", "--cwd", path]))
            }
            _ => None,
        };
        // If the emulator's inner binary is missing/renamed (a future release or a
        // divergent bundle layout), fall through to `open -a` rather than
        // hard-failing — mirroring the Linux branch's fallback posture.
        if let Some((prog, args)) = flag_launch {
            if Command::new(&prog).args(&args).spawn().is_ok() {
                return Ok(());
            }
        }
        // A "Custom…" pick that is a plain executable (not a `.app` bundle) must
        // be spawned directly rooted at the repo: routing it through `open -a`
        // treats the raw binary as an application name and mis-launches it.
        if kind == "custom" && !program.is_empty() && !is_app_bundle(program) {
            return Command::new(program)
                .current_dir(path)
                .spawn()
                .map(|_| ())
                .map_err(AppError::Io);
        }
        let app = mac_terminal_app(kind, program);
        Command::new("open")
            .args(["-a", app.as_str(), path])
            .spawn()
            .map(|_| ())
            .map_err(AppError::Io)
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Honor the picked emulator (its stored path, or the id which equals the
        // binary name); fall back to the common emulators when none was chosen
        // or the pick fails to spawn.
        let chosen = if !program.is_empty() {
            Some(program.to_string())
        } else if !kind.is_empty() && kind != "custom" {
            Some(kind.to_string())
        } else {
            None
        };
        if let Some(bin) = chosen {
            let mut cmd = Command::new(&bin);
            crate::agent::sanitize_child_env(&mut cmd);
            if cmd.current_dir(path).spawn().is_ok() {
                return Ok(());
            }
        }
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            let mut cmd = Command::new(term);
            crate::agent::sanitize_child_env(&mut cmd);
            if cmd.current_dir(path).spawn().is_ok() {
                return Ok(());
            }
        }
        Err(AppError::Io(std::io::Error::other(
            "no terminal emulator found",
        )))
    }
}

/// Probes for installed terminals so users can pick one in Settings.
#[tauri::command]
pub async fn detect_terminals() -> AppResult<Vec<DetectedTerminal>> {
    tauri::async_runtime::spawn_blocking(detect_terminals_sync)
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

#[cfg(windows)]
fn detect_terminals_sync() -> Vec<DetectedTerminal> {
    let sysroot = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    let pf86 =
        std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into());

    let mut found: Vec<DetectedTerminal> = Vec::new();
    let mut add = |id: &str, name: &str, p: PathBuf| {
        if p.is_file() && !found.iter().any(|t| t.id == id) {
            found.push(DetectedTerminal {
                id: id.to_string(),
                name: name.to_string(),
                path: p.to_string_lossy().into_owned(),
            });
        }
    };

    add(
        "windows-terminal",
        "Windows Terminal",
        Path::new(&local).join("Microsoft\\WindowsApps\\wt.exe"),
    );
    add(
        "powershell",
        "Windows PowerShell",
        Path::new(&sysroot).join("System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
    );
    add(
        "pwsh",
        "PowerShell 7",
        Path::new(&pf).join("PowerShell\\7\\pwsh.exe"),
    );
    add(
        "cmd",
        "Command Prompt",
        Path::new(&sysroot).join("System32\\cmd.exe"),
    );
    add("git-bash", "Git Bash", Path::new(&pf).join("Git\\git-bash.exe"));
    add(
        "git-bash",
        "Git Bash",
        Path::new(&pf86).join("Git\\git-bash.exe"),
    );
    add("wsl", "WSL", Path::new(&sysroot).join("System32\\wsl.exe"));
    found
}

// ---- Shared detection cores (platform-neutral, dependency-injected so the
// logic is unit-tested regardless of host OS; the `#[cfg]` wrappers below just
// supply each platform's search dirs / probe tables) ----

/// A macOS application to probe for: (kind id, display name, `.app` bundle name).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
type MacApp = (&'static str, &'static str, &'static str);

/// Scans `dirs` for the terminal `.app` bundles in `table`, one entry per
/// distinct id (first directory match wins). Pure filesystem probing — never
/// PATH — so a Finder-launched app (minimal launchd PATH) detects the same set.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn scan_app_terminals(dirs: &[PathBuf], table: &[MacApp]) -> Vec<DetectedTerminal> {
    let mut found: Vec<DetectedTerminal> = Vec::new();
    for &(id, name, bundle) in table {
        if found.iter().any(|t| t.id == id) {
            continue;
        }
        for dir in dirs {
            let p = dir.join(bundle);
            if p.exists() {
                found.push(DetectedTerminal {
                    id: id.to_string(),
                    name: name.to_string(),
                    path: p.to_string_lossy().into_owned(),
                });
                break;
            }
        }
    }
    found
}

/// Scans `dirs` for the editor `.app` bundles in `table` (display name, bundle
/// name), one entry per distinct name.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn scan_app_editors(dirs: &[PathBuf], table: &[(&str, &str)]) -> Vec<DetectedEditor> {
    let mut found: Vec<DetectedEditor> = Vec::new();
    for &(name, bundle) in table {
        if found.iter().any(|e| e.name == name) {
            continue;
        }
        for dir in dirs {
            let p = dir.join(bundle);
            if p.exists() {
                found.push(DetectedEditor {
                    name: name.to_string(),
                    path: p.to_string_lossy().into_owned(),
                });
                break;
            }
        }
    }
    found
}

/// Lowercased JetBrains product-name prefixes recognized among `*.app` bundles.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const JETBRAINS_PREFIXES: &[&str] = &[
    "intellij idea",
    "pycharm",
    "webstorm",
    "goland",
    "clion",
    "rider",
    "rubymine",
    "phpstorm",
    "datagrip",
    "rustrover",
    "dataspell",
    "aqua",
    "android studio",
];

/// Scans `dirs` for JetBrains IDE `.app` bundles (standalone or Toolbox),
/// matching by product-name prefix. Display name is the bundle's file stem, so
/// edition suffixes ("PyCharm Community") are preserved. Deduped by name.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn scan_jetbrains(dirs: &[PathBuf]) -> Vec<DetectedEditor> {
    let mut found: Vec<DetectedEditor> = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(stem) = file_name.strip_suffix(".app") else {
                continue;
            };
            let lower = stem.to_ascii_lowercase();
            // Match a product name exactly or followed by a space (edition/version
            // suffix), so a short prefix like "aqua" doesn't catch "Aquamacs".
            if !JETBRAINS_PREFIXES
                .iter()
                .any(|&p| lower == p || lower.strip_prefix(p).is_some_and(|r| r.starts_with(' ')))
            {
                continue;
            }
            if found.iter().any(|e| e.name == stem) {
                continue;
            }
            found.push(DetectedEditor {
                name: stem.to_string(),
                path: entry.path().to_string_lossy().into_owned(),
            });
        }
    }
    found
}

/// Assembles detected terminals from `(id, name, bin-names)` rows via `resolve`
/// (a name→path lookup). The injected resolver keeps assembly pure/testable; the
/// real caller passes the Homebrew-aware `crate::agent::find_executable`.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
fn probe_terminal_bins<F>(table: &[(&str, &str, &[&str])], resolve: F) -> Vec<DetectedTerminal>
where
    F: Fn(&[&str]) -> Option<PathBuf>,
{
    let mut found = Vec::new();
    for &(id, name, names) in table {
        if let Some(path) = resolve(names) {
            found.push(DetectedTerminal {
                id: id.to_string(),
                name: name.to_string(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    found
}

/// Assembles detected editors from `(name, bin-names)` rows via `resolve`.
#[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
fn probe_editor_bins<F>(table: &[(&str, &[&str])], resolve: F) -> Vec<DetectedEditor>
where
    F: Fn(&[&str]) -> Option<PathBuf>,
{
    let mut found = Vec::new();
    for &(name, names) in table {
        if let Some(path) = resolve(names) {
            found.push(DetectedEditor {
                name: name.to_string(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    found
}

/// True when `program` points at a macOS `.app` bundle (a directory launched via
/// `open -a`, not executed directly).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn is_app_bundle(program: &str) -> bool {
    program
        .trim_end_matches('/')
        .to_ascii_lowercase()
        .ends_with(".app")
}

/// The macOS application name to pass to `open -a` for a terminal `kind` when no
/// explicit bundle path was stored (the stored bundle path wins when present).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_terminal_app(kind: &str, program: &str) -> String {
    if !program.is_empty() {
        return program.to_string();
    }
    match kind {
        "iterm" => "iTerm",
        "warp" => "Warp",
        "alacritty" => "Alacritty",
        "kitty" => "kitty",
        "wezterm" => "WezTerm",
        "hyper" => "Hyper",
        "ghostty" => "Ghostty",
        _ => "Terminal",
    }
    .to_string()
}

#[cfg(target_os = "macos")]
fn unix_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(target_os = "macos")]
fn mac_app_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/Applications"),
        PathBuf::from("/Applications/Utilities"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ];
    if let Some(home) = unix_home() {
        dirs.push(home.join("Applications"));
    }
    dirs
}

#[cfg(target_os = "macos")]
const MAC_TERMINALS: &[MacApp] = &[
    ("macos-terminal", "Terminal", "Terminal.app"),
    ("iterm", "iTerm", "iTerm.app"),
    ("warp", "Warp", "Warp.app"),
    ("alacritty", "Alacritty", "Alacritty.app"),
    ("kitty", "kitty", "kitty.app"),
    ("wezterm", "WezTerm", "WezTerm.app"),
    ("hyper", "Hyper", "Hyper.app"),
    ("ghostty", "Ghostty", "Ghostty.app"),
];

#[cfg(target_os = "macos")]
fn detect_terminals_sync() -> Vec<DetectedTerminal> {
    scan_app_terminals(&mac_app_dirs(), MAC_TERMINALS)
}

// Linux/other unix: terminal emulators are PATH binaries, resolved through the
// Homebrew-aware `find_executable` (which searches PATH + the well-known bin
// dirs); the id equals the binary name so the launcher can honor a pick even
// without a stored path.
#[cfg(all(not(windows), not(target_os = "macos")))]
const LINUX_TERMINALS: &[(&str, &str, &[&str])] = &[
    ("gnome-terminal", "GNOME Terminal", &["gnome-terminal"]),
    ("konsole", "Konsole", &["konsole"]),
    ("alacritty", "Alacritty", &["alacritty"]),
    ("kitty", "kitty", &["kitty"]),
    ("wezterm", "WezTerm", &["wezterm"]),
    ("tilix", "Tilix", &["tilix"]),
    ("xfce4-terminal", "Xfce Terminal", &["xfce4-terminal"]),
    ("terminator", "Terminator", &["terminator"]),
    ("xterm", "XTerm", &["xterm"]),
];

#[cfg(all(not(windows), not(target_os = "macos")))]
fn detect_terminals_sync() -> Vec<DetectedTerminal> {
    probe_terminal_bins(LINUX_TERMINALS, crate::agent::find_executable)
}

/// Probes well-known install locations for editors/IDEs, GitHub Desktop
/// style, so users can pick one without hunting for the executable.
#[tauri::command]
pub async fn detect_editors() -> AppResult<Vec<DetectedEditor>> {
    tauri::async_runtime::spawn_blocking(detect_editors_sync)
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

#[cfg(windows)]
fn detect_editors_sync() -> Vec<DetectedEditor> {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
    let pf86 = std::env::var("ProgramFiles(x86)")
        .unwrap_or_else(|_| "C:\\Program Files (x86)".into());

    let mut found: Vec<DetectedEditor> = Vec::new();
    let mut add = |name: &str, path: PathBuf| {
        if path.is_file() && !found.iter().any(|e| e.name == name) {
            found.push(DetectedEditor {
                name: name.to_string(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    };

    // Fixed, well-known locations
    let candidates: &[(&str, PathBuf)] = &[
        (
            "Visual Studio Code",
            Path::new(&local).join("Programs\\Microsoft VS Code\\Code.exe"),
        ),
        (
            "Visual Studio Code",
            Path::new(&pf).join("Microsoft VS Code\\Code.exe"),
        ),
        (
            "VS Code Insiders",
            Path::new(&local).join("Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe"),
        ),
        (
            "Cursor",
            Path::new(&local).join("Programs\\cursor\\Cursor.exe"),
        ),
        (
            "Sublime Text",
            Path::new(&pf).join("Sublime Text\\sublime_text.exe"),
        ),
        (
            "Sublime Text",
            Path::new(&pf).join("Sublime Text 3\\sublime_text.exe"),
        ),
        (
            "Notepad++",
            Path::new(&pf).join("Notepad++\\notepad++.exe"),
        ),
        (
            "Notepad++",
            Path::new(&pf86).join("Notepad++\\notepad++.exe"),
        ),
        (
            "Android Studio",
            Path::new(&pf).join("Android\\Android Studio\\bin\\studio64.exe"),
        ),
    ];
    for (name, path) in candidates {
        add(name, path.clone());
    }

    // JetBrains IDEs: "C:\Program Files\JetBrains\<Product Version>\bin\*64.exe"
    // and Toolbox installs under "%LOCALAPPDATA%\Programs\<Product>\bin\*64.exe"
    for root in [
        Path::new(&pf).join("JetBrains"),
        Path::new(&local).join("Programs"),
    ] {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let bin = entry.path().join("bin");
            let Ok(bins) = std::fs::read_dir(&bin) else {
                continue;
            };
            for exe in bins.flatten() {
                let file_name = exe.file_name().to_string_lossy().into_owned();
                if file_name.ends_with("64.exe") {
                    let product = entry.file_name().to_string_lossy().into_owned();
                    // skip Android Studio dupes from the generic scan
                    if product.to_lowercase().contains("android") {
                        continue;
                    }
                    add(&product, exe.path());
                    break;
                }
            }
        }
    }

    found.sort_by(|a, b| a.name.cmp(&b.name));
    found
}

// macOS editors are `.app` bundles under /Applications (+ ~/Applications for
// user/Toolbox installs), never `.exe`. Pure-terminal editors (nvim/vim) are
// deliberately omitted: launched from the GUI file menu they have no controlling
// tty and would fail — GUI-capable editors only (Emacs.app is fine).
#[cfg(target_os = "macos")]
const MAC_EDITORS: &[(&str, &str)] = &[
    ("Visual Studio Code", "Visual Studio Code.app"),
    ("VS Code Insiders", "Visual Studio Code - Insiders.app"),
    ("Cursor", "Cursor.app"),
    ("Sublime Text", "Sublime Text.app"),
    ("Zed", "Zed.app"),
    ("Xcode", "Xcode.app"),
    ("Nova", "Nova.app"),
    ("BBEdit", "BBEdit.app"),
    ("Emacs", "Emacs.app"),
];

#[cfg(target_os = "macos")]
fn detect_editors_sync() -> Vec<DetectedEditor> {
    let dirs = mac_app_dirs();
    let mut found = scan_app_editors(&dirs, MAC_EDITORS);
    // JetBrains IDEs: standalone in /Applications, or Toolbox under
    // ~/Applications (some Toolbox versions nest a "JetBrains Toolbox" folder).
    let mut jb_dirs = dirs.clone();
    if let Some(home) = unix_home() {
        jb_dirs.push(home.join("Applications").join("JetBrains Toolbox"));
    }
    found.extend(scan_jetbrains(&jb_dirs));
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found.dedup_by(|a, b| a.name == b.name);
    found
}

// Linux/other unix: editors are PATH binaries. GUI editors launch fine via
// `open_with_program`'s direct spawn; terminal-only editors are omitted for the
// same reason as macOS.
#[cfg(all(not(windows), not(target_os = "macos")))]
const LINUX_EDITORS: &[(&str, &[&str])] = &[
    ("Visual Studio Code", &["code"]),
    ("VS Code Insiders", &["code-insiders"]),
    ("Cursor", &["cursor"]),
    ("Sublime Text", &["subl"]),
    ("Zed", &["zed", "zeditor"]),
    ("Gedit", &["gedit"]),
    ("Kate", &["kate"]),
    ("GNOME Text Editor", &["gnome-text-editor"]),
    ("Emacs", &["emacs"]),
];

#[cfg(all(not(windows), not(target_os = "macos")))]
fn detect_editors_sync() -> Vec<DetectedEditor> {
    let mut found = probe_editor_bins(LINUX_EDITORS, crate::agent::find_executable);
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found.dedup_by(|a, b| a.name == b.name);
    found
}

/// Opens a file in a user-configured program (e.g. an editor).
#[tauri::command]
pub async fn open_with_program(program: String, path: String) -> AppResult<()> {
    let program = program.trim().to_string();
    if program.is_empty() {
        return Err(AppError::InvalidArgument("no program configured".into()));
    }
    // macOS `.app` bundles (e.g. "/Applications/Visual Studio Code.app") are
    // directories, not executables — launch them with `open -a <bundle> <file>`
    // rather than trying to spawn the bundle directory as a command.
    #[cfg(target_os = "macos")]
    if is_app_bundle(&program) {
        let mut c = std::process::Command::new("open");
        // `open` hands off to LaunchServices, which starts the app in a fresh
        // session that doesn't inherit our environment, so the scrub only affects
        // the `open` child itself (belt-and-braces) and no `ELECTRON_RUN_AS_NODE`
        // removal is needed here.
        crate::agent::sanitize_child_env(&mut c);
        c.args(["-a", program.as_str(), path.as_str()])
            .spawn()
            .map_err(AppError::Io)?;
        return Ok(());
    }
    // Spawn a `.cmd`/`.bat` shim (e.g. VS Code's `code.cmd`) DIRECTLY, not via
    // `cmd /C`: std (≥1.77.2) then applies its batch-file argument escaping
    // (CVE-2024-24576), whereas `cmd /C <shim> <path>` runs the untrusted `path`
    // unquoted, so a space-free filename like `a&calc&b` from a cloned repo injects
    // commands. A toolchain pin below that floor would silently reopen this.
    let mut cmd = std::process::Command::new(&program);
    crate::agent::sanitize_child_env(&mut cmd);
    cmd.arg(&path);
    // When this app is launched from a VS Code terminal, ELECTRON_RUN_AS_NODE=1
    // is in our environment; an Electron editor inheriting it runs as plain
    // Node and tries to *execute* the file instead of opening it.
    cmd.env_remove("ELECTRON_RUN_AS_NODE");
    // The `.cmd`/`.bat` extension only means anything to Windows, which spawns a
    // transient cmd.exe console to run the shim — hide it below.
    #[cfg(windows)]
    let shim = is_batch_file(&program);
    #[cfg(windows)]
    if shim {
        use std::os::windows::process::CommandExt;
        // hide the transient cmd.exe console; GUI editors don't need this and
        // Electron apps can misbehave when launched with it
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn().map_err(AppError::Io)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_ignore_pattern_keeps_an_escaped_trailing_space() {
        assert_eq!(trim_ignore_pattern("  /notes.md  "), "/notes.md");
        assert_eq!(trim_ignore_pattern("/notes.md\r"), "/notes.md");
        // The escape is the whole point: `notes\ ` names a file ending in a space.
        assert_eq!(trim_ignore_pattern("/notes\\ "), "/notes\\ ");
        assert_eq!(trim_ignore_pattern("/notes\\  "), "/notes\\ ");
        // An EVEN run is escaped backslashes, so the space after it is bare.
        assert_eq!(trim_ignore_pattern("/notes\\\\ "), "/notes\\\\");
        assert_eq!(trim_ignore_pattern("   "), "");
        // A trailing TAB is part of the pattern — git trims spaces only (measured,
        // 2.51.1: pattern `foo\t` matches `foo\t`, not `foo`).
        assert_eq!(trim_ignore_pattern("/notes.md\t"), "/notes.md\t");
    }

    #[test]
    fn is_reserved_device_name_matches_dos_devices_only() {
        for name in [
            "nul", "NUL.txt", "Com3.log", "con", "PRN", "aux", "com1", "COM9", "lpt1", "LPT9",
            "nul.tar.gz",
            // Win32 strips trailing dots and spaces off the final component, so
            // these spell the device too (measured).
            "nul ", "nul .txt", "nul.",
        ] {
            assert!(is_reserved_device_name(name), "{name:?} is a device name");
        }
        for name in [
            "nully", "null", "com0", "com10", "lpt10", "lpt0", "console", "prnt", "auxiliary",
            "com", "lpt", "", "a.nul",
            // Only TRAILING spaces are stripped — an interior one is part of the name.
            "nul x", "nul x.txt",
        ] {
            assert!(!is_reserved_device_name(name), "{name:?} is an ordinary name");
        }
    }

    /// Pins the premise the Windows fallback exists for: a file named after a
    /// reserved device is unreachable by its plain path, so trash refuses it and
    /// only the verbatim path can unlink it. A red here means the fallback is
    /// dead code.
    #[cfg(windows)]
    #[test]
    fn trash_delete_removes_a_reserved_device_name_the_recycle_bin_refuses() {
        let tmp = tempfile::tempdir().expect("create temp dir");
        let plain = tmp.path().join("nul");
        let verbatim = verbatim_path(&plain).expect("a temp path is absolute");
        std::fs::write(&verbatim, b"x").expect("the verbatim path creates the file");

        assert!(
            trash::delete(&plain).is_err(),
            "the plain path resolves to the device, so trash cannot take it"
        );
        trash_delete(&plain).expect("the verbatim fallback removes it");
        assert!(
            std::fs::metadata(&verbatim).is_err(),
            "the file is gone from disk"
        );
    }

    #[cfg(windows)]
    #[test]
    fn verbatim_path_normalizes_slashes_and_unc_and_refuses_relative() {
        assert_eq!(
            verbatim_path(Path::new("C:/repo/sub/nul")).unwrap(),
            PathBuf::from(r"\\?\C:\repo\sub\nul")
        );
        assert_eq!(
            verbatim_path(Path::new(r"\\server\share\nul")).unwrap(),
            PathBuf::from(r"\\?\UNC\server\share\nul")
        );
        // An already-verbatim path is passed through, never re-prefixed.
        assert_eq!(
            verbatim_path(Path::new(r"\\?\C:\repo\nul")).unwrap(),
            PathBuf::from(r"\\?\C:\repo\nul")
        );
        assert!(verbatim_path(Path::new("sub/nul")).is_none());
        // A device-namespace path names a device, not a file on disk — no
        // verbatim form, so the caller keeps the plain trash error.
        assert!(verbatim_path(Path::new(r"\\.\nul")).is_none());
        assert!(verbatim_path(Path::new(r"\\.\PhysicalDrive0")).is_none());
    }

    fn gitignore_test_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("gd-gitignore-test-")
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    #[tokio::test]
    async fn append_gitignore_creates_file_and_returns_full_count() {
        let (_tmp, dir) = gitignore_test_repo();
        let repo = dir.to_string_lossy().into_owned();

        let added =
            append_to_gitignore(repo, vec!["target/".to_string(), "*.log".to_string()])
                .await
                .unwrap();
        // A fresh .gitignore: both patterns are appended.
        assert_eq!(added, 2);

        let path = dir.join(".gitignore");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("target/\n"));
        assert!(text.contains("*.log\n"));
    }

    #[tokio::test]
    async fn append_gitignore_skips_present_and_returns_partial_count() {
        let (_tmp, dir) = gitignore_test_repo();
        let repo = dir.to_string_lossy().into_owned();

        let first = append_to_gitignore(repo.clone(), vec!["target/".to_string()])
            .await
            .unwrap();
        assert_eq!(first, 1);

        // Re-add the same line plus a new one: only the new line counts.
        let second =
            append_to_gitignore(repo, vec!["target/".to_string(), "dist/".to_string()])
                .await
                .unwrap();
        assert_eq!(second, 1);

        let path = dir.join(".gitignore");
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text.matches("target/\n").count(), 1);
        assert!(text.contains("dist/\n"));
    }

    #[tokio::test]
    async fn append_gitignore_all_duplicates_returns_zero_and_no_write() {
        let (_tmp, dir) = gitignore_test_repo();
        let repo = dir.to_string_lossy().into_owned();

        append_to_gitignore(repo.clone(), vec!["target/".to_string(), "*.log".to_string()])
            .await
            .unwrap();
        let path = dir.join(".gitignore");
        let before = std::fs::read_to_string(&path).unwrap();

        // An all-duplicates batch appends nothing and leaves the file byte-identical.
        let added =
            append_to_gitignore(repo, vec!["target/".to_string(), "*.log".to_string()])
                .await
                .unwrap();
        assert_eq!(added, 0);
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(before, after);
    }

    // ---- Terminal/editor detection cores (platform-neutral; run on every OS) ----

    fn make_bundle(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir.join(name)).expect("create bundle dir");
    }

    #[test]
    fn is_app_bundle_classifies_paths() {
        assert!(is_app_bundle("/Applications/Visual Studio Code.app"));
        assert!(is_app_bundle("/Applications/iTerm.app/")); // trailing slash
        assert!(is_app_bundle("Cursor.APP")); // case-insensitive
        assert!(!is_app_bundle("/usr/local/bin/code"));
        assert!(!is_app_bundle("/Applications/foo.app.bak"));
        assert!(!is_app_bundle(""));
    }

    #[test]
    fn mac_terminal_app_prefers_program_then_kind_then_default() {
        // A stored bundle path always wins.
        assert_eq!(
            mac_terminal_app("iterm", "/Applications/iTerm.app"),
            "/Applications/iTerm.app"
        );
        // No path: map the known kind id to its app name.
        assert_eq!(mac_terminal_app("warp", ""), "Warp");
        assert_eq!(mac_terminal_app("ghostty", ""), "Ghostty");
        // Unknown/empty kind falls back to Terminal.app.
        assert_eq!(mac_terminal_app("", ""), "Terminal");
        assert_eq!(mac_terminal_app("custom", ""), "Terminal");
    }

    #[test]
    fn scan_app_terminals_detects_and_dedups_by_id() {
        let tmp = tempfile::tempdir().unwrap();
        let apps = tmp.path().join("Applications");
        let utils = tmp.path().join("Utilities");
        make_bundle(&apps, "iTerm.app");
        make_bundle(&apps, "Warp.app");
        make_bundle(&utils, "iTerm.app"); // same id in a later dir → ignored

        let table: &[MacApp] = &[
            ("iterm", "iTerm", "iTerm.app"),
            ("warp", "Warp", "Warp.app"),
            ("kitty", "kitty", "kitty.app"), // not installed
        ];
        let found = scan_app_terminals(&[apps.clone(), utils], table);

        assert_eq!(found.len(), 2);
        let iterm = found.iter().find(|t| t.id == "iterm").unwrap();
        assert_eq!(iterm.name, "iTerm");
        // First matching directory wins.
        assert_eq!(iterm.path, apps.join("iTerm.app").to_string_lossy());
        assert!(found.iter().any(|t| t.id == "warp"));
        assert!(!found.iter().any(|t| t.id == "kitty"));
    }

    #[test]
    fn scan_app_editors_detects_installed_only() {
        let tmp = tempfile::tempdir().unwrap();
        let apps = tmp.path().join("Applications");
        make_bundle(&apps, "Visual Studio Code.app");
        make_bundle(&apps, "Zed.app");

        let table: &[(&str, &str)] = &[
            ("Visual Studio Code", "Visual Studio Code.app"),
            ("Zed", "Zed.app"),
            ("Cursor", "Cursor.app"), // not installed
        ];
        let found = scan_app_editors(&[apps], table);

        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|e| e.name == "Visual Studio Code"));
        assert!(found.iter().any(|e| e.name == "Zed"));
        assert!(!found.iter().any(|e| e.name == "Cursor"));
    }

    #[test]
    fn scan_jetbrains_matches_product_prefixes_and_keeps_edition() {
        let tmp = tempfile::tempdir().unwrap();
        let apps = tmp.path().join("Applications");
        make_bundle(&apps, "IntelliJ IDEA.app");
        make_bundle(&apps, "PyCharm Community Edition.app");
        make_bundle(&apps, "Aquamacs.app"); // NOT JetBrains "aqua" (no word boundary)
        make_bundle(&apps, "Some Random App.app"); // not JetBrains
        make_bundle(&apps, "Cursor.app"); // not JetBrains

        let found = scan_jetbrains(&[apps]);

        let names: Vec<&str> = found.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"IntelliJ IDEA"));
        // Edition suffix is preserved (display name = bundle stem).
        assert!(names.contains(&"PyCharm Community Edition"));
        // "aqua" prefix must not swallow "Aquamacs" (word-boundary match).
        assert!(!names.contains(&"Aquamacs"));
        assert!(!names.iter().any(|n| n.contains("Random")));
        assert!(!names.contains(&"Cursor"));
    }

    #[test]
    fn probe_terminal_bins_resolves_via_injected_lookup() {
        // Fake resolver: only "konsole" and "kitty" are "installed".
        let resolve = |names: &[&str]| -> Option<PathBuf> {
            names
                .iter()
                .find(|n| matches!(**n, "konsole" | "kitty"))
                .map(|n| PathBuf::from(format!("/usr/bin/{n}")))
        };
        let table: &[(&str, &str, &[&str])] = &[
            ("gnome-terminal", "GNOME Terminal", &["gnome-terminal"]),
            ("konsole", "Konsole", &["konsole"]),
            ("kitty", "kitty", &["kitty"]),
        ];
        let found = probe_terminal_bins(table, resolve);

        assert_eq!(found.len(), 2);
        let konsole = found.iter().find(|t| t.id == "konsole").unwrap();
        assert_eq!(konsole.path, "/usr/bin/konsole");
        assert!(!found.iter().any(|t| t.id == "gnome-terminal"));
    }

    #[test]
    fn probe_editor_bins_resolves_first_matching_name() {
        // Zed ships as either `zed` or `zeditor`; only `zeditor` is present here.
        let resolve = |names: &[&str]| -> Option<PathBuf> {
            names
                .iter()
                .find(|n| **n == "zeditor")
                .map(|_| PathBuf::from("/usr/local/bin/zeditor"))
        };
        let table: &[(&str, &[&str])] = &[
            ("Zed", &["zed", "zeditor"]),
            ("Cursor", &["cursor"]), // not installed
        ];
        let found = probe_editor_bins(table, resolve);

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "Zed");
        assert_eq!(found[0].path, "/usr/local/bin/zeditor");
    }

    // ---- Custom terminal-command parsing (pure; run on every OS) ----

    #[test]
    fn tokenize_command_plain_split() {
        assert_eq!(
            tokenize_command("wt -d {path}").unwrap(),
            vec!["wt", "-d", "{path}"]
        );
        // Runs of whitespace collapse; leading/trailing whitespace is trimmed.
        assert_eq!(
            tokenize_command("  tmux   new-window  ").unwrap(),
            vec!["tmux", "new-window"]
        );
    }

    #[test]
    fn tokenize_command_quotes_group_and_strip() {
        // A quoted run with spaces stays a single token; the quotes are stripped.
        assert_eq!(
            tokenize_command("\"C:\\Program Files\\wt.exe\" -d {path}").unwrap(),
            vec!["C:\\Program Files\\wt.exe", "-d", "{path}"]
        );
        // Quotes can open mid-token and still group.
        assert_eq!(
            tokenize_command("start=\"a b\"").unwrap(),
            vec!["start=a b"]
        );
    }

    #[test]
    fn tokenize_command_empty_is_error() {
        assert!(tokenize_command("").is_err());
        assert!(tokenize_command("   ").is_err());
    }

    #[tokio::test]
    async fn launch_custom_command_rejects_empty_program_token() {
        // A quoted-empty first token ('"" -d …') must fail with a clear error
        // before ever reaching the resolver (deterministic: returns pre-resolve).
        assert!(launch_custom_command("\"\" -d {path}", "C:\\nowhere")
            .await
            .is_err());
    }

    #[test]
    fn tokenize_command_unbalanced_quote_is_error() {
        // An unterminated quote is a typo, not "the rest is one token".
        assert!(tokenize_command("wt -d \"C:\\path").is_err());
        assert!(tokenize_command("\"just an opening quote").is_err());
        // A balanced pair around the same content is fine.
        assert_eq!(
            tokenize_command("wt -d \"C:\\path\"").unwrap(),
            vec!["wt", "-d", "C:\\path"]
        );
    }

    #[test]
    fn substitute_path_replaces_standalone_and_embedded() {
        let tokens = vec!["wezterm".into(), "--cwd={path}".into(), "{path}".into()];
        assert_eq!(
            substitute_path(&tokens, "/home/me/repo"),
            vec!["wezterm", "--cwd=/home/me/repo", "/home/me/repo"]
        );
    }

    #[test]
    fn substitute_path_keeps_spaced_path_as_one_token() {
        // A path with spaces is substituted into a single token — it is never
        // re-split, so the launcher receives exactly one argv entry.
        let tokens = vec!["kitty".into(), "--directory".into(), "{path}".into()];
        let out = substitute_path(&tokens, "/Users/me/My Repo");
        assert_eq!(out.len(), 3);
        assert_eq!(out[2], "/Users/me/My Repo");
    }

    #[test]
    fn substitute_path_without_placeholder_is_unchanged() {
        let tokens = vec!["tmux".into(), "new-window".into()];
        assert_eq!(
            substitute_path(&tokens, "/home/me/repo"),
            vec!["tmux", "new-window"]
        );
    }

    #[test]
    fn is_batch_file_matches_cmd_and_bat_case_insensitively() {
        assert!(is_batch_file("C:\\tools\\wt.cmd"));
        assert!(is_batch_file("C:\\tools\\wt.CMD"));
        assert!(is_batch_file("launch.bat"));
        assert!(is_batch_file("launch.BAT"));
        // Real executables / extensionless names pass.
        assert!(!is_batch_file("C:\\tools\\wt.exe"));
        assert!(!is_batch_file("/usr/bin/wezterm"));
        assert!(!is_batch_file("wt"));
    }

    #[test]
    fn first_token_is_pathlike_distinguishes_bare_names_from_paths() {
        // Bare names (looked up on PATH) — not path-like.
        assert!(!first_token_is_pathlike("wt"));
        assert!(!first_token_is_pathlike("wezterm"));
        assert!(!first_token_is_pathlike("tmux"));
        // Explicit paths (exists-checked as given) — path-like.
        assert!(first_token_is_pathlike("./bin/wt"));
        assert!(first_token_is_pathlike("C:\\tools\\wt.exe"));
        assert!(first_token_is_pathlike("/usr/local/bin/wezterm"));
    }

    #[test]
    fn ensure_absolute_joins_relative_and_passes_absolute() {
        let base = if cfg!(windows) {
            Path::new("C:\\app\\cwd")
        } else {
            Path::new("/app/cwd")
        };
        // A relative path is joined onto the base.
        let rel = ensure_absolute(PathBuf::from("bin/wt"), base);
        assert_eq!(rel, base.join("bin/wt"));
        assert!(rel.is_absolute());
        // An already-absolute path is returned unchanged (bytes identical).
        let abs = if cfg!(windows) {
            PathBuf::from("C:\\tools\\wt.exe")
        } else {
            PathBuf::from("/usr/local/bin/wezterm")
        };
        assert_eq!(ensure_absolute(abs.clone(), base), abs);
    }
}
