//! In-app **terminal** backend: real PTYs streamed to the frontend's xterm.js.
//!
//! Each terminal is a pseudo-terminal (ConPTY on Windows via `portable-pty`)
//! running either a **host shell** in the session worktree, a shell *inside* the
//! worktree's test container (reusing the exact run-or-exec + port-publish +
//! cleanup logic the external "Test in container" launcher uses, see
//! `agent_sandbox::container_shell_command`), or — for the **Tasks** feature — a
//! user-registered script: its body is written to a temp file and run by the
//! chosen interpreter (argv-only; the body is never interpolated into a `-c`
//! shell string). Output is streamed to the UI over a Tauri `Channel` (base64
//! chunks, so binary + partial-UTF-8 are safe); input/resize/close come back as
//! commands. PTYs are held in app state keyed by a frontend id and torn down on
//! close (or when the process exits).
//!
//! **Windows dev caveat (known limitation, not a bug — do not re-chase):** the
//! in-app terminal works in a RELEASE install but NOT under `pnpm tauri dev`. The
//! dev launcher runs the app as a child of the terminal, so it inherits a console;
//! that inherited console makes the ConPTY child spawn fail (empty output, child
//! exits immediately). Three fixes were tried and reverted — `FreeConsole()`,
//! `CREATE_NO_WINDOW` on the child, and making the binary windowless
//! (`windows_subsystem = "windows"` in dev too) — none worked, because a windowless
//! subsystem only stops Windows *allocating* a console, it doesn't shed an
//! *inherited* one. In dev, use the UI's "Open in external terminal" escape hatch
//! instead; don't reopen this without a real diagnostic build (instrument the spawn
//! to see the child's actual std handles), not another guess.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;

use crate::agent::resolve_named;
use crate::agent_sandbox::container_shell_command;
use crate::error::{AppError, AppResult};

/// Live PTYs keyed by the frontend-supplied id. `Arc` so the per-PTY reader thread
/// can remove its own entry on exit without going through Tauri's `State`.
#[derive(Default, Clone)]
pub struct PtyState {
    ptys: Arc<Mutex<HashMap<String, PtyHandle>>>,
}

/// Control side of one PTY: the master (resize), a writer (input), and the child
/// (kill). The reader is owned by the streaming thread, not here.
struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// A temp script file to delete once the process exits (Tasks runs write the
    /// script body to a temp file); `None` for host/container shells.
    cleanup: Option<PathBuf>,
    /// Kill the whole process tree on teardown. Tasks spawn their own children
    /// (git, node, pnpm…) that a single-process kill would orphan; a shell's
    /// children are reached by the PTY hangup, so this stays off for those.
    tree_kill: bool,
    /// Registration generation — lets a reader thread prove the map entry under
    /// its id is still ITS OWN before tearing it down. React StrictMode (dev)
    /// double-mounts the terminal, firing two `pty_open`s for the same id; the
    /// second insert clobbers the first, and without this guard the first
    /// reader's exit teardown would kill the second's live process.
    gen: u64,
}

/// Monotonic source for [`PtyHandle::gen`].
static PTY_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyOpts {
    /// "host" — a shell in `cwd`; "container" — a shell in the worktree's test
    /// container (publishing `ports`); "task" — run `interpreter` on a temp file
    /// holding `body`, in `cwd`.
    kind: String,
    /// The cwd: a host shell's / task's working directory, and (container) the
    /// mount + key.
    cwd: String,
    /// Dev-server ports to publish (container only; ignored otherwise).
    #[serde(default)]
    ports: Vec<String>,
    cols: u16,
    rows: u16,
    /// Task only: the interpreter key (see `task_interp`) to run the script with.
    #[serde(default)]
    interpreter: Option<String>,
    /// Task only, inline source: the script body written to a temp file and run.
    #[serde(default)]
    body: Option<String>,
    /// Task only, file source: an existing script file to run in place (relative
    /// to `cwd`, or absolute). Takes precedence over `body` when set.
    #[serde(default)]
    path: Option<String>,
    /// Task only: extra arguments passed to the script after its path. Argv form
    /// (already split by the frontend), so no shell re-parsing happens here.
    #[serde(default)]
    args: Vec<String>,
}

/// Streamed to the frontend terminal. `Output` carries base64-encoded bytes.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PtyEvent {
    Output { data: String },
    /// The process exited; `code` is its exit status when known (surfaced in the
    /// UI so a silent/erroring exit is diagnosable, not just "exited").
    Exit { code: Option<u32> },
}

/// The host shell to run for a "host" terminal — `%COMSPEC%` (cmd.exe) on Windows,
/// `$SHELL` (else `/bin/bash`) elsewhere.
fn host_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

/// Maps a Tasks interpreter key to the binary names to resolve, the temp-file
/// extension, and the argv that runs the script *file*. Argv-only by design: the
/// script body is executed as a file, never interpolated into a `-c` string (which
/// is the one shell-injection class the rest of the app has zero instances of, and
/// avoids the Windows `.cmd`-shim multi-line-argv rejection).
///
/// The frontend's interpreter dropdown mirrors these keys; an unknown key errors
/// at run time rather than silently doing nothing.
type TaskArgs = fn(&str) -> Vec<String>;
fn task_interp(interpreter: &str) -> Option<(&'static [&'static str], &'static str, TaskArgs)> {
    let ps: TaskArgs = |p| {
        vec![
            "-NoProfile".into(),
            "-ExecutionPolicy".into(),
            "Bypass".into(),
            "-File".into(),
            p.into(),
        ]
    };
    let file_arg: TaskArgs = |p| vec![p.into()];
    let cmd_c: TaskArgs = |p| vec!["/c".into(), p.into()];
    // Deno needs the `run` subcommand; `-A` grants full permissions — this is the
    // user's own registered script, run as they would themselves.
    let deno: TaskArgs = |p| vec!["run".into(), "-A".into(), p.into()];
    match interpreter {
        // Prefer PowerShell 7 (`pwsh`), fall back to Windows PowerShell 5.1.
        "powershell" => Some((&["pwsh", "powershell"], "ps1", ps)),
        "cmd" => Some((&["cmd"], "cmd", cmd_c)),
        // Git Bash resolves specially (see `find_git_bash`); `bash` here is only a
        // detection/fallback name, not what the run uses on Windows.
        "git-bash" => Some((&["bash"], "sh", file_arg)),
        "bash" => Some((&["bash"], "sh", file_arg)),
        "sh" => Some((&["sh"], "sh", file_arg)),
        "zsh" => Some((&["zsh"], "sh", file_arg)),
        "node" => Some((&["node"], "mjs", file_arg)),
        "python" => Some((&["python3", "python"], "py", file_arg)),
        "deno" => Some((&["deno"], "ts", deno)),
        "bun" => Some((&["bun"], "ts", file_arg)),
        "ruby" => Some((&["ruby"], "rb", file_arg)),
        _ => None,
    }
}

/// Every interpreter key, for detection. Mirrors the frontend's `INTERPRETERS`.
const INTERPRETER_KEYS: &[&str] = &[
    "powershell", "cmd", "git-bash", "bash", "sh", "zsh", "node", "python", "deno", "bun", "ruby",
];

/// Locates Git Bash's `bash.exe` — a bare `bash` on Windows resolves to WSL, not
/// Git's, so this is separate. Derives it from the resolved `git` (walking up to
/// the Git root's `bin\bash.exe` / `usr\bin\bash.exe`), then falls back to
/// well-known install locations.
#[cfg(windows)]
fn find_git_bash() -> Option<PathBuf> {
    if let Some(git) = crate::agent::find_executable(&["git"]) {
        let mut anc = git.parent();
        for _ in 0..4 {
            let dir = anc?;
            for rel in ["bin\\bash.exe", "usr\\bin\\bash.exe"] {
                let b = dir.join(rel);
                if b.is_file() {
                    return Some(b);
                }
            }
            anc = dir.parent();
        }
    }
    let mut bases: Vec<String> = Vec::new();
    if let Ok(p) = std::env::var("ProgramFiles") {
        bases.push(p);
    }
    if let Ok(p) = std::env::var("ProgramFiles(x86)") {
        bases.push(p);
    }
    if let Ok(l) = std::env::var("LOCALAPPDATA") {
        bases.push(format!("{l}\\Programs"));
    }
    for base in bases {
        for rel in ["Git\\bin\\bash.exe", "Git\\usr\\bin\\bash.exe"] {
            let b = std::path::Path::new(&base).join(rel);
            if b.is_file() {
                return Some(b);
            }
        }
    }
    None
}

/// On non-Windows, "Git Bash" is just bash — the frontend doesn't offer it there,
/// but detection stays honest if it's ever queried.
#[cfg(not(windows))]
fn find_git_bash() -> Option<PathBuf> {
    crate::agent::find_executable(&["bash"])
}

/// Resolves an interpreter's binary for a RUN — full resolution (macOS login-shell
/// PATH recovery, Windows live-registry PATH), with Git Bash special-cased.
async fn resolve_interpreter_run(key: &str, names: &[&str]) -> Option<PathBuf> {
    if key == "git-bash" {
        return find_git_bash();
    }
    resolve_named(names, None).await
}

/// Resolves an interpreter's binary for DETECTION — cheap (PATH + install dirs, no
/// login-shell probe, so probing missing ones can't hang). "Found" here means "on
/// your PATH"; a run additionally recovers login-shell/registry PATH.
fn detect_interpreter_bin(key: &str) -> Option<PathBuf> {
    if key == "git-bash" {
        return find_git_bash();
    }
    let names = task_interp(key)?.0;
    crate::agent::find_executable(names)
}

/// One interpreter's availability for the task editor's dropdown.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedInterpreter {
    /// The interpreter key (matches the frontend `Interpreter` union).
    id: String,
    /// Resolved absolute path, or `None` when it isn't on PATH.
    path: Option<String>,
}

/// Reports which task interpreters are installed, so the editor can show what a
/// task can actually run with. Cheap + off-thread.
#[tauri::command]
pub async fn detect_interpreters() -> AppResult<Vec<DetectedInterpreter>> {
    tauri::async_runtime::spawn_blocking(|| {
        INTERPRETER_KEYS
            .iter()
            .map(|&key| DetectedInterpreter {
                id: key.to_string(),
                path: detect_interpreter_bin(key).map(|p| p.to_string_lossy().into_owned()),
            })
            .collect()
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))
}

/// The built PTY child plus teardown metadata.
struct BuiltCommand {
    cmd: CommandBuilder,
    /// A dim first line to print (the container port hint), if any.
    tip: Option<String>,
    /// Temp script file to remove on teardown (task runs).
    cleanup: Option<PathBuf>,
    tree_kill: bool,
}

/// Builds the PTY command for the requested kind.
///
/// `docker` is spawned directly as the PTY child: the vendored portable-pty patch
/// (NULL std handles) makes the child attach to the pseudoconsole, so its TTY check
/// passes and `-t` allocates a real container TTY.
async fn build_command(opts: &PtyOpts, id: &str) -> AppResult<BuiltCommand> {
    if opts.kind == "container" {
        let (bin, args, tip) = container_shell_command(&opts.cwd, &opts.ports).await?;
        let mut cmd = CommandBuilder::new(bin);
        for a in args {
            cmd.arg(a);
        }
        return Ok(BuiltCommand {
            cmd,
            tip: Some(tip),
            cleanup: None,
            tree_kill: false,
        });
    }

    if opts.kind == "task" {
        let interpreter = opts.interpreter.as_deref().unwrap_or_default();
        let (names, ext, build_args) = task_interp(interpreter).ok_or_else(|| {
            AppError::Command(format!("unknown task interpreter '{interpreter}'"))
        })?;
        let bin = resolve_interpreter_run(interpreter, names)
            .await
            .ok_or_else(|| {
                AppError::Command(format!(
                    "couldn't find the '{interpreter}' interpreter on your PATH — is it installed?"
                ))
            })?;

        // File source: run an EXISTING script file in place — never written, never
        // deleted (it's the user's own file, run live so edits take effect). Inline
        // source: write the body to a temp file (unique per run) and run that.
        let (script_path, cleanup) = match opts.path.as_deref().filter(|p| !p.is_empty()) {
            Some(file) => {
                let full = if std::path::Path::new(file).is_absolute() {
                    std::path::PathBuf::from(file)
                } else {
                    std::path::Path::new(&opts.cwd).join(file)
                };
                if !full.exists() {
                    return Err(AppError::Command(format!(
                        "script file not found: {}",
                        full.display()
                    )));
                }
                (full.to_string_lossy().into_owned(), None)
            }
            None => {
                let body = opts.body.as_deref().unwrap_or_default();
                // Sanitize the (unique-per-run) id to safe filename chars.
                let safe: String = id
                    .chars()
                    .map(|c| {
                        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                            c
                        } else {
                            '-'
                        }
                    })
                    .collect();
                let tmp = std::env::temp_dir().join(format!("gd-task-{safe}.{ext}"));
                std::fs::write(&tmp, body).map_err(AppError::Io)?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if let Ok(meta) = std::fs::metadata(&tmp) {
                        let mut perm = meta.permissions();
                        perm.set_mode(0o755);
                        let _ = std::fs::set_permissions(&tmp, perm);
                    }
                }
                (tmp.to_string_lossy().into_owned(), Some(tmp))
            }
        };

        let mut cmd = CommandBuilder::new(bin);
        for a in build_args(&script_path) {
            cmd.arg(a);
        }
        // The user's arguments, after the script path (argv, never shell-parsed).
        for a in &opts.args {
            cmd.arg(a);
        }
        cmd.cwd(&opts.cwd);
        return Ok(BuiltCommand {
            cmd,
            tip: None,
            cleanup,
            tree_kill: true,
        });
    }

    let mut cmd = CommandBuilder::new(host_shell());
    cmd.cwd(&opts.cwd);
    Ok(BuiltCommand {
        cmd,
        tip: None,
        cleanup: None,
        tree_kill: false,
    })
}

fn encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Kills a PTY's child. Tasks tree-kill (Windows `taskkill /F /T`) so their git /
/// node / pnpm descendants don't orphan; a shell relies on the PTY hangup reaching
/// its foreground group, so `child.kill()` alone is enough there. Returns the
/// still-running `taskkill` process (when one was spawned) so the caller can WAIT
/// for it before deleting the temp script — deleting while a descendant still has
/// the file open fails silently on Windows and leaks the file.
fn kill_handle(h: &mut PtyHandle) -> Option<std::process::Child> {
    let tk = if h.tree_kill {
        kill_tree(&mut h.child)
    } else {
        None
    };
    let _ = h.child.kill();
    tk
}

/// Best-effort process-tree kill for a task run. On Windows `taskkill /T` reaches
/// the whole tree (git/node/pnpm children a bare `TerminateProcess` would orphan);
/// the spawned `taskkill` is returned for the caller to wait on. On Unix the PTY
/// hangup (SIGHUP to the foreground group when the master drops) plus the caller's
/// `child.kill()` already reach descendants, so there's nothing extra to do.
fn kill_tree(child: &mut Box<dyn Child + Send + Sync>) -> Option<std::process::Child> {
    #[cfg(windows)]
    if let Some(pid) = child.process_id() {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        return std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .ok();
    }
    #[cfg(not(windows))]
    let _ = child;
    None
}

/// Deletes a task's temp script file (best-effort). No-op for shells.
fn cleanup_handle(h: &mut PtyHandle) {
    if let Some(p) = h.cleanup.take() {
        let _ = std::fs::remove_file(p);
    }
}

/// Full teardown of a removed handle: kill (tree first), WAIT for the Windows
/// `taskkill` to finish sweeping descendants, then delete the temp script. The
/// wait is what makes the delete stick — a child that still holds the script
/// open at delete time would otherwise leak it. Blocking: run this on a
/// dedicated or detached thread, never the main thread (sync Tauri commands run
/// there).
fn teardown_handle(mut h: PtyHandle) {
    if let Some(mut tk) = kill_handle(&mut h) {
        let _ = tk.wait();
    }
    cleanup_handle(&mut h);
}

/// Opens a PTY, starts streaming its output to `on_event`, and registers it under
/// `id`. The frontend writes/resizes/closes it by that id.
#[tauri::command]
pub async fn pty_open(
    state: State<'_, PtyState>,
    id: String,
    opts: PtyOpts,
    on_event: Channel<PtyEvent>,
) -> AppResult<()> {
    let BuiltCommand {
        mut cmd,
        tip,
        cleanup,
        tree_kill,
    } = build_command(&opts, &id).await?;
    // portable-pty's CommandBuilder already inherits the parent environment, so we
    // only advertise a capable terminal here (re-copying every var is redundant and
    // can introduce odd-cased duplicate Windows vars).
    cmd.env("TERM", "xterm-256color");

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: opts.rows.max(1),
            cols: opts.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| AppError::Command(format!("failed to open a terminal: {e}")))?;

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| {
        // The temp script file is orphaned if the spawn fails — clean it up.
        if let Some(p) = &cleanup {
            let _ = std::fs::remove_file(p);
        }
        AppError::Command(format!("failed to start the process: {e}"))
    })?;
    // Drop the slave so the child owns the only handle to it (else close can hang).
    drop(pair.slave);

    // From here the child is LIVE: any error return must kill it and remove the
    // temp script, or the process (and file) leak untracked — no PtyHandle
    // exists yet for Stop/pty_close to reach. (A just-spawned interpreter has no
    // descendants yet, so a plain kill suffices on these instant-failure paths.)
    let mut fail = |e: String| {
        let _ = child.kill();
        if let Some(p) = &cleanup {
            let _ = std::fs::remove_file(p);
        }
        AppError::Command(e)
    };
    let reader = match pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => return Err(fail(format!("terminal reader: {e}"))),
    };
    let writer = match pair.master.take_writer() {
        Ok(w) => w,
        Err(e) => return Err(fail(format!("terminal writer: {e}"))),
    };

    let gen = PTY_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let cleanup_path = cleanup.clone();
    let prev = state.ptys.lock().unwrap().insert(
        id.clone(),
        PtyHandle {
            master: pair.master,
            writer,
            child,
            cleanup,
            tree_kill,
            gen,
        },
    );
    // A same-id re-open (React StrictMode double-mount in dev fires two opens
    // whose closes can't catch them) — tear the stale process tree down so it
    // can't orphan. Skip deleting its temp script when this run reuses the same
    // path (inline tasks derive the name from the shared id).
    if let Some(mut old) = prev {
        if old.cleanup == cleanup_path {
            old.cleanup = None;
        }
        std::thread::spawn(move || teardown_handle(old));
    }

    // A dim first line with the container's reachable URL(s).
    if let Some(tip) = tip {
        let _ = on_event.send(PtyEvent::Output {
            data: encode(format!("\x1b[2m{tip}\x1b[0m\r\n").as_bytes()),
        });
    }

    // Stream output until EOF on a blocking thread, then drop the handle + notify.
    let ptys = state.ptys.clone();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Err(_) => break,
                Ok(n) => {
                    if on_event
                        .send(PtyEvent::Output {
                            data: encode(&buf[..n]),
                        })
                        .is_err()
                    {
                        break;
                    }
                }
            }
        }
        // Reap WITHOUT holding the lock across anything blocking (a blocking
        // wait() under the lock froze the app once). Remove OUR OWN entry only —
        // gen-guarded, so if `pty_close` already tore us down (Stop) or a
        // same-id re-open clobbered us (StrictMode dev), we leave the newer
        // entry alone and just report the exit.
        let handle = {
            let mut map = ptys.lock().unwrap();
            if map.get(&id).map(|h| h.gen) == Some(gen) {
                map.remove(&id)
            } else {
                None
            }
        };
        let mut code = None;
        if let Some(mut h) = handle {
            // EOF often lands a beat before the OS finalizes the exit status —
            // poll briefly (dedicated thread; blocking is fine) so a clean exit
            // reports its real code instead of a false "Stopped".
            for _ in 0..50 {
                if let Ok(Some(status)) = h.child.try_wait() {
                    code = Some(status.exit_code());
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            if code.is_none() {
                // Still alive after the grace window (the reader stopped early)
                // — kill it (tree first) so it can't orphan, and wait for the
                // Windows tree-kill so the temp delete below sticks.
                if let Some(mut tk) = kill_handle(&mut h) {
                    let _ = tk.wait();
                }
            }
            cleanup_handle(&mut h);
        }
        let _ = on_event.send(PtyEvent::Exit { code });
    });

    Ok(())
}

/// Writes the user's keystrokes (UTF-8) to the PTY.
#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> AppResult<()> {
    let mut map = state.ptys.lock().unwrap();
    if let Some(h) = map.get_mut(&id) {
        h.writer.write_all(data.as_bytes()).map_err(AppError::Io)?;
        let _ = h.writer.flush();
    }
    Ok(())
}

/// Resizes the PTY when the terminal element resizes.
#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> AppResult<()> {
    let map = state.ptys.lock().unwrap();
    if let Some(h) = map.get(&id) {
        let _ = h.master.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        });
    }
    Ok(())
}

/// Kills the process and drops the PTY (on terminal unmount / dock close / task
/// Stop). Tree-kills a task's descendants and removes its temp script. Idempotent.
/// Sync command (main thread) — the teardown waits on the Windows tree-kill
/// before deleting the temp script, so it runs detached rather than blocking UI.
#[tauri::command]
pub fn pty_close(state: State<'_, PtyState>, id: String) -> AppResult<()> {
    let handle = state.ptys.lock().unwrap().remove(&id);
    if let Some(h) = handle {
        std::thread::spawn(move || teardown_handle(h));
    }
    Ok(())
}

// ── Dev-only external-terminal fallback ─────────────────────────────────────
// Runs a task in the user's OS terminal instead of the in-app PTY. This exists
// ONLY for the Windows ConPTY-under-`pnpm tauri dev` limitation (see the module
// header): the in-app terminal can't spawn in dev, so the frontend silently
// routes Run here on Windows dev builds. **Compiled out of release binaries**
// (`debug_assertions`) — a production build carries none of this; its frontend
// gate is statically false there too, so nothing ever calls it. Structure
// mirrors `agent_sandbox::launch_container_shell`.

#[cfg(debug_assertions)]
static TERM_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(all(unix, debug_assertions))]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Windows: write a temp `.cmd` that cds to the repo, runs the (double-quoted)
/// command, and pauses; `start` it so it gets a fresh, fully-wired console.
#[cfg(all(windows, debug_assertions))]
fn spawn_terminal(cwd: &str, bin: &str, argv: &[String]) -> AppResult<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut line = format!("\"{bin}\"");
    for a in argv {
        line.push_str(&format!(" \"{a}\""));
    }
    let script = format!(
        "@echo off\r\ntitle GitDesktop task\r\ncd /d \"{cwd}\"\r\n{line}\r\necho.\r\necho (task exited) Press any key to close...\r\npause >nul\r\n"
    );
    let n = TERM_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path =
        std::env::temp_dir().join(format!("gd-task-run-{}-{n}.cmd", std::process::id()));
    std::fs::write(&path, script).map_err(AppError::Io)?;
    let mut c = std::process::Command::new("cmd");
    c.raw_arg(format!("/c start \"GitDesktop\" \"{}\"", path.display()));
    c.creation_flags(CREATE_NO_WINDOW);
    c.spawn().map(|_| ()).map_err(AppError::Io)
}

/// macOS: write a temp `.command` (Terminal.app runs it on `open`).
#[cfg(all(target_os = "macos", debug_assertions))]
fn spawn_terminal(cwd: &str, bin: &str, argv: &[String]) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut line = sh_quote(bin);
    for a in argv {
        line.push(' ');
        line.push_str(&sh_quote(a));
    }
    let script = format!(
        "#!/bin/bash\ncd {}\n{line}\necho\necho '(task exited)'\n",
        sh_quote(cwd)
    );
    let n = TERM_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path =
        std::env::temp_dir().join(format!("gd-task-run-{}-{n}.command", std::process::id()));
    std::fs::write(&path, script).map_err(AppError::Io)?;
    let mut perm = std::fs::metadata(&path).map_err(AppError::Io)?.permissions();
    perm.set_mode(0o755);
    std::fs::set_permissions(&path, perm).map_err(AppError::Io)?;
    std::process::Command::new("open")
        .arg(&path)
        .spawn()
        .map(|_| ())
        .map_err(AppError::Io)
}

/// Linux: run the command in the first available terminal emulator, dropping into a
/// shell afterwards so the window stays open.
#[cfg(all(unix, not(target_os = "macos"), debug_assertions))]
fn spawn_terminal(cwd: &str, bin: &str, argv: &[String]) -> AppResult<()> {
    let mut line = sh_quote(bin);
    for a in argv {
        line.push(' ');
        line.push_str(&sh_quote(a));
    }
    let cmd = format!(
        "cd {}; {line}; echo; echo '(task exited)'; exec bash",
        sh_quote(cwd)
    );
    for term in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
        if std::process::Command::new(term)
            .args(["-e", "bash", "-c", &cmd])
            .spawn()
            .is_ok()
        {
            return Ok(());
        }
    }
    Err(AppError::Command(
        "no terminal emulator found".to_string(),
    ))
}

/// Launches a task in the user's OS terminal (rather than the in-app PTY) — the
/// automatic dev fallback for the Windows ConPTY-under-`tauri dev` limitation.
/// Dev builds only: in release the implementation is compiled out and this
/// answers with an error (nothing routes here in production — the frontend's
/// dev gate is statically false in a production bundle).
#[tauri::command]
pub async fn task_open_terminal(
    cwd: String,
    interpreter: String,
    body: Option<String>,
    path: Option<String>,
    args: Vec<String>,
) -> AppResult<()> {
    #[cfg(debug_assertions)]
    {
        task_open_terminal_impl(cwd, interpreter, body, path, args).await
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (cwd, interpreter, body, path, args);
        Err(AppError::Command(
            "opening a task in an external terminal is a dev-only fallback".to_string(),
        ))
    }
}

/// The dev-only body of [`task_open_terminal`]: resolves the interpreter,
/// materializes the script (an existing file, or a temp file for an inline body),
/// and opens a terminal window running `<interpreter> <script> <args>` in the repo
/// directory. Argv-only, like the in-app path.
#[cfg(debug_assertions)]
async fn task_open_terminal_impl(
    cwd: String,
    interpreter: String,
    body: Option<String>,
    path: Option<String>,
    args: Vec<String>,
) -> AppResult<()> {
    let (names, ext, build_args) = task_interp(&interpreter).ok_or_else(|| {
        AppError::Command(format!("unknown task interpreter '{interpreter}'"))
    })?;
    let bin = resolve_interpreter_run(&interpreter, names)
        .await
        .ok_or_else(|| {
            AppError::Command(format!(
                "couldn't find the '{interpreter}' interpreter on your PATH — is it installed?"
            ))
        })?;

    let script_path = match path.as_deref().filter(|p| !p.is_empty()) {
        Some(file) => {
            let full = if std::path::Path::new(file).is_absolute() {
                std::path::PathBuf::from(file)
            } else {
                std::path::Path::new(&cwd).join(file)
            };
            if !full.exists() {
                return Err(AppError::Command(format!(
                    "script file not found: {}",
                    full.display()
                )));
            }
            full.to_string_lossy().into_owned()
        }
        None => {
            // Inline body → a temp script the external terminal reads after we
            // return. Not cleaned up here (we'd race the terminal); the OS clears
            // its temp dir.
            let body = body.as_deref().unwrap_or_default();
            let n = TERM_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let tmp = std::env::temp_dir()
                .join(format!("gd-task-inline-{}-{n}.{ext}", std::process::id()));
            std::fs::write(&tmp, body).map_err(AppError::Io)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(meta) = std::fs::metadata(&tmp) {
                    let mut perm = meta.permissions();
                    perm.set_mode(0o755);
                    let _ = std::fs::set_permissions(&tmp, perm);
                }
            }
            tmp.to_string_lossy().into_owned()
        }
    };

    let mut argv = build_args(&script_path);
    argv.extend(args);
    let bin = bin.to_string_lossy().into_owned();
    spawn_terminal(&cwd, &bin, &argv)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_interp_maps_every_key_the_frontend_offers() {
        // The frontend's INTERPRETERS list and this backend map must agree, or a
        // dropdown choice errors at run time.
        for key in INTERPRETER_KEYS {
            assert!(
                task_interp(key).is_some(),
                "{key} is a detection key but has no task_interp mapping"
            );
        }
    }

    #[test]
    fn task_interp_rejects_unknown_keys() {
        // An unknown/empty interpreter must be rejected, not silently run something.
        assert!(task_interp("perl").is_none());
        assert!(task_interp("").is_none());
        assert!(task_interp("bash;rm").is_none());
    }

    #[test]
    fn deno_prepends_run_then_the_file() {
        // Deno is the one interpreter with a subcommand before the file.
        let (_names, ext, build) = task_interp("deno").unwrap();
        assert_eq!(ext, "ts");
        let args = build("/tmp/gd-task-x.ts");
        assert_eq!(args.first().unwrap(), "run");
        assert!(args.last().unwrap().ends_with("gd-task-x.ts"));
    }

    #[test]
    fn powershell_runs_the_script_file_not_a_command_string() {
        let (_names, ext, build) = task_interp("powershell").unwrap();
        assert_eq!(ext, "ps1");
        let args = build("C:/tmp/gd-task-x.ps1");
        // Argv form: the body is a FILE argument, never interpolated into `-Command`.
        assert!(args.iter().any(|a| a == "-File"));
        assert!(args.last().unwrap().ends_with("gd-task-x.ps1"));
        assert!(!args.iter().any(|a| a == "-Command"));
    }

    #[test]
    fn interpreters_pass_the_file_as_a_discrete_arg() {
        for key in ["bash", "git-bash", "sh", "zsh", "node", "python", "bun", "ruby"] {
            let (_names, _ext, build) = task_interp(key).unwrap();
            let path = "/tmp/gd-task-x";
            let args = build(path);
            assert!(
                args.iter().any(|a| a == path),
                "{key} should pass the script path as an argv element"
            );
        }
        // cmd runs the file via `/c <file>`.
        let (_n, ext, build) = task_interp("cmd").unwrap();
        assert_eq!(ext, "cmd");
        assert_eq!(build("x.cmd"), vec!["/c".to_string(), "x.cmd".to_string()]);
    }
}
