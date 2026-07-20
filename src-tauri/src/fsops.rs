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

/// Write `contents` to `path` atomically: write a uniquely-named temp file in the same
/// directory, then rename it over the target so a concurrent reader (another GUI or MCP
/// process) never sees a partial or truncated file. Creates the parent directory if it
/// doesn't exist yet.
///
/// `std::fs::rename` replaces an existing destination on every platform (on Windows via
/// `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`), so this reliably overwrites a file
/// that's already there. On a genuine IO failure (target locked, permissions) it removes
/// the temp file rather than leaking it, then surfaces the error.
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
        let t = p.trim().to_string();
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
            content.lines().map(str::trim).collect();
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
        // "Recycle Bin" is Windows-only terminology; macOS and Linux call the
        // OS trash "Trash". Pick the right one at compile time.
        #[cfg(windows)]
        const TRASH_NAME: &str = "Recycle Bin";
        #[cfg(not(windows))]
        const TRASH_NAME: &str = "Trash";

        let mut cause = String::new();
        for attempt in 0..ATTEMPTS {
            match trash::delete(&dir) {
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
/// "powershell", "windows-terminal", "git-bash", "custom") and `program` its
/// executable; both empty means pick a sensible default.
#[tauri::command]
pub async fn open_in_terminal(
    path: String,
    terminal: Option<String>,
    program: Option<String>,
) -> AppResult<()> {
    if !Path::new(&path).is_dir() {
        return Err(AppError::InvalidArgument(format!(
            "not a directory: {path}"
        )));
    }
    let kind = terminal.unwrap_or_default();
    let program = program.unwrap_or_default();
    #[cfg(windows)]
    {
        launch_terminal_windows(&kind, &program, &path)
    }
    #[cfg(not(windows))]
    {
        let _ = (&kind, &program);
        launch_terminal_unix(&path)
    }
}

#[cfg(windows)]
fn launch_terminal_windows(kind: &str, program: &str, path: &str) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    // Console shells (cmd/powershell/wsl) are launched through cmd's `start`
    // so the shell allocates a fresh, fully wired console for them. Spawning
    // them directly with CREATE_NEW_CONSOLE leaves their stdio bound to our
    // parent's handles, so the window opens but can't take keyboard input.
    // `start` inherits the intermediary cmd's working dir, which we set here.
    //
    // The title argument must be non-empty: `start ""` leaves the new console
    // with an empty title, which makes Node/libuv abort ("Assertion failed:
    // process_title"). We build the line by hand and wrap it in outer quotes
    // so `cmd /c` strips exactly that pair, leaving start's own quoting intact.
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
fn launch_terminal_unix(path: &str) -> AppResult<()> {
    use std::process::Command;
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Terminal", path])
            .spawn()
            .map(|_| ())
            .map_err(AppError::Io)
    }
    #[cfg(not(target_os = "macos"))]
    {
        for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if Command::new(term).current_dir(path).spawn().is_ok() {
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

#[cfg(not(windows))]
fn detect_terminals_sync() -> Vec<DetectedTerminal> {
    Vec::new()
}

/// Probes well-known install locations for editors/IDEs, GitHub Desktop
/// style, so users can pick one without hunting for the executable.
#[tauri::command]
pub async fn detect_editors() -> AppResult<Vec<DetectedEditor>> {
    tauri::async_runtime::spawn_blocking(detect_editors_sync)
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

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

/// Opens a file in a user-configured program (e.g. an editor).
#[tauri::command]
pub async fn open_with_program(program: String, path: String) -> AppResult<()> {
    let program = program.trim().to_string();
    if program.is_empty() {
        return Err(AppError::InvalidArgument("no program configured".into()));
    }
    let lower = program.to_lowercase();
    // .cmd/.bat shims (like VS Code's `code.cmd`) can't be spawned directly
    let shim = lower.ends_with(".cmd") || lower.ends_with(".bat");
    let mut cmd = if shim {
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", &program, &path]);
        c
    } else {
        let mut c = std::process::Command::new(&program);
        c.arg(&path);
        c
    };
    // When this app is launched from a VS Code terminal, ELECTRON_RUN_AS_NODE=1
    // is in our environment; an Electron editor inheriting it runs as plain
    // Node and tries to *execute* the file instead of opening it.
    cmd.env_remove("ELECTRON_RUN_AS_NODE");
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
}
