//! In-app **terminal** backend: real PTYs streamed to the frontend's xterm.js.
//!
//! Each terminal is a pseudo-terminal (ConPTY on Windows via `portable-pty`)
//! running a host shell in the session worktree, a shell inside the worktree's
//! test container (`agent_sandbox::container_shell_command`), or — for Tasks — a
//! user-registered script run argv-only by the chosen interpreter (the body is
//! never interpolated into a `-c` shell string). Output streams to the UI over a
//! Tauri `Channel` as base64 chunks (binary + partial UTF-8 safe); input/resize/
//! close come back as commands. PTYs live in app state keyed by a frontend id.
//!
//! **Windows dev caveat (known limitation, not a bug — do not re-chase):** the
//! in-app terminal works in a RELEASE install but NOT under `pnpm tauri dev`.
//! The dev launcher runs the app as a child of the terminal, so it inherits a
//! console, and that inherited console makes the ConPTY child spawn fail (empty
//! output, instant exit). `FreeConsole()`, `CREATE_NO_WINDOW` and a windowless
//! subsystem were all tried and reverted — a windowless subsystem only stops
//! Windows ALLOCATING a console, it can't shed an inherited one. In dev, use
//! "Open in external terminal"; don't reopen without a real diagnostic build.

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

/// Control side of one PTY: the master (resize), an input queue, and the child
/// (kill). The reader is owned by the streaming thread, not here.
struct PtyHandle {
    /// Behind its own `Arc<Mutex<…>>` so `pty_resize` can clone it out of the map,
    /// release the map lock, and only then make the blocking OS call; the mutex is
    /// what makes that clone shareable at all, since `Arc<T>: Send` needs `T: Send +
    /// Sync` and the bare `Box<dyn MasterPty + Send>` is not `Sync`.
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// Queues input for the PTY's writer thread. The writer itself lives there, so
    /// a child that stops reading can never block a caller holding the PTY map
    /// lock; dropping this handle closes the channel, which ends that thread.
    input: std::sync::mpsc::Sender<Vec<u8>>,
    /// Bytes sitting in `input` — added on queue, subtracted once written. Shared
    /// with the writer thread; see [`PTY_INPUT_QUEUE_CAP`].
    queued: Arc<std::sync::atomic::AtomicUsize>,
    child: Box<dyn Child + Send + Sync>,
    /// A temp script file to delete once the process exits (Tasks runs write the
    /// script body to a temp file); `None` for host/container shells.
    cleanup: Option<PathBuf>,
    /// Kill the whole process tree on teardown. Tasks spawn their own children
    /// (git, node, pnpm…) that a single-process kill would orphan; a shell's
    /// children are reached by the PTY hangup, so this stays off for those.
    tree_kill: bool,
    /// Registration generation — lets a reader thread prove the map entry under its
    /// id is still ITS OWN before tearing it down. React StrictMode (dev)
    /// double-mounts and fires two `pty_open`s for one id; without this the first
    /// reader's exit would kill the second's live process.
    gen: u64,
}

/// Monotonic source for [`PtyHandle::gen`].
static PTY_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Bytes one PTY may have queued for its writer thread. Deliberately far above any
/// legitimate burst (the largest paste anyone would make), because its only job is
/// to bound memory against a child that has genuinely stopped reading — a healthy
/// child that's merely busy must never lose a keystroke to it. Input past the cap
/// is dropped rather than queued: a wedged PTY's input is already lost, and
/// dropping it beats growing without bound. The gate reads the BACKLOG only, so
/// one oversized chunk still lands (memory bound = cap + one in-flight chunk)
/// rather than a healthy giant paste being dropped whole.
const PTY_INPUT_QUEUE_CAP: usize = 8 * 1024 * 1024;

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
/// extension, and the argv that runs the script FILE. Argv-only by design: the
/// body is never interpolated into a `-c` string (also dodges the Windows
/// `.cmd`-shim multi-line-argv rejection). The frontend's dropdown mirrors these
/// keys; an unknown key errors at run time rather than doing nothing.
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

/// Full run-resolution for a SINGLE interpreter — the resolution an actual task
/// run uses (login-shell PATH recovery, Windows live-registry PATH), unlike the
/// cheap PATH-only `detect_interpreters`. The editor calls it lazily for the
/// SELECTED interpreter when the cheap pass missed it, so a Finder-launched
/// macOS app doesn't warn that an nvm-managed `node` is absent when it will run
/// fine. `None` (incl. unknown keys) = not resolvable.
#[tauri::command]
pub async fn resolve_task_interpreter(key: String) -> AppResult<Option<String>> {
    // git-bash resolves specially inside `resolve_interpreter_run` (names ignored);
    // every other key maps through `task_interp`.
    let names: &[&str] = if key == "git-bash" {
        &[]
    } else {
        match task_interp(&key) {
            Some((names, _, _)) => names,
            None => return Ok(None),
        }
    };
    Ok(resolve_interpreter_run(&key, names)
        .await
        .map(|p| p.to_string_lossy().into_owned()))
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

/// Kills a PTY's child: tasks tree-kill (their git/node/pnpm descendants would
/// orphan), shells rely on the PTY hangup. Returns the still-running `taskkill`
/// so the caller can WAIT before deleting the temp script — deleting while a
/// descendant holds it open fails silently on Windows and leaks the file.
fn kill_handle(h: &mut PtyHandle) -> Option<std::process::Child> {
    let tk = if h.tree_kill {
        kill_tree(&mut h.child)
    } else {
        None
    };
    let _ = h.child.kill();
    tk
}

/// Best-effort process-tree kill for a task run (see `kill_handle`). Windows:
/// `taskkill /T`, returned for the caller to wait on. Unix: nothing extra — the
/// PTY hangup plus `child.kill()` already reach descendants.
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

/// Full teardown of a removed handle: kill (tree first), wait for the Windows
/// tree-kill, then delete the temp script. Blocking — run on a dedicated or
/// detached thread, never the main thread (sync Tauri commands run there).
fn teardown_handle(mut h: PtyHandle) {
    if let Some(mut tk) = kill_handle(&mut h) {
        let _ = tk.wait();
    }
    cleanup_handle(&mut h);
}

/// Hands `data` to a PTY's writer thread, unless that PTY is already sitting on
/// [`PTY_INPUT_QUEUE_CAP`] bytes it hasn't managed to write. Counts the bytes in
/// BEFORE queuing them, so the writer can never subtract a chunk it hasn't seen.
fn queue_pty_input(
    input: &std::sync::mpsc::Sender<Vec<u8>>,
    queued: &std::sync::atomic::AtomicUsize,
    data: Vec<u8>,
) {
    let len = data.len();
    if queued.load(std::sync::atomic::Ordering::Relaxed) >= PTY_INPUT_QUEUE_CAP {
        return;
    }
    queued.fetch_add(len, std::sync::atomic::Ordering::Relaxed);
    if input.send(data).is_err() {
        // Nothing will ever write it — the writer thread is gone.
        queued.fetch_sub(len, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Drains queued input to the PTY on a dedicated thread. Writing can block for as
/// long as the child ignores its input, so it must never happen under the PTY map
/// lock (that froze the app once, and made `pty_close` unreachable). A single
/// consumer keeps per-PTY writes in the order they were queued. Returns — dropping
/// the writer, which sends EOF to the slave — when the channel closes (the handle
/// was torn down) or the write fails.
fn pump_pty_input(
    mut writer: impl Write,
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    queued: Arc<std::sync::atomic::AtomicUsize>,
) {
    while let Ok(chunk) = rx.recv() {
        let written = writer.write_all(&chunk).is_ok();
        if written {
            let _ = writer.flush();
        }
        // Off the books either way: a failed chunk is gone, not pending.
        queued.fetch_sub(chunk.len(), std::sync::atomic::Ordering::Relaxed);
        if !written {
            break;
        }
    }
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
    // only subtract (whatever `sanitize_child_env` removes — the AppImage bundle's
    // paths and an inherited PWD, which would misdirect host tools run in the
    // terminal) and advertise a capable terminal — re-copying every var is
    // redundant and can introduce odd-cased duplicate Windows vars.
    crate::agent::sanitize_child_env(&mut cmd);
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

    // Input goes through a channel to a thread that owns the writer — see
    // `pump_pty_input`.
    let (input, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let queued = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let pump_queued = queued.clone();
    std::thread::spawn(move || pump_pty_input(writer, input_rx, pump_queued));

    let gen = PTY_GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let cleanup_path = cleanup.clone();
    let prev = state.ptys.lock().unwrap().insert(
        id.clone(),
        PtyHandle {
            master: Arc::new(Mutex::new(pair.master)),
            input,
            queued,
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

/// Queues the user's keystrokes (UTF-8) for the PTY. Sync command (main thread),
/// so it only enqueues — the blocking write happens on the writer thread. Input
/// that can't be delivered (the thread exited, or the queue is at
/// [`PTY_INPUT_QUEUE_CAP`] because the child stopped reading) is dropped: the
/// caller discards write errors anyway, and `Exit` is what reports a dead terminal.
#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> AppResult<()> {
    let map = state.ptys.lock().unwrap();
    if let Some(h) = map.get(&id) {
        queue_pty_input(&h.input, &h.queued, data.into_bytes());
    }
    Ok(())
}

/// Resizes the PTY when the terminal element resizes. Sync command (main thread),
/// so the master is cloned OUT of the map and the guard dropped before the resize:
/// that is an OS call, and holding the map lock across it stalls `pty_write`,
/// `pty_close` and every reader/writer thread on a resize storm.
///
/// A resize racing `pty_close` keeps the master alive through this clone for the
/// length of the call — harmless: the result is discarded either way, and teardown
/// owns the handle's child and temp-script halves regardless.
#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> AppResult<()> {
    let master = {
        let map = state.ptys.lock().unwrap();
        map.get(&id).map(|h| Arc::clone(&h.master))
    };
    if let Some(master) = master {
        let _ = master.lock().unwrap().resize(PtySize {
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
// Dev-only external-terminal fallback: runs a task in the user's OS terminal
// because the in-app PTY can't spawn under `pnpm tauri dev` on Windows (see the
// module header). Compiled out of release builds (`debug_assertions`), and the
// frontend's gate is statically false there. Mirrors
// `agent_sandbox::launch_container_shell`.

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

/// Launches a task in the user's OS terminal — the dev fallback for the Windows
/// ConPTY-under-`tauri dev` limitation. Dev builds only; in release the body is
/// compiled out and this answers with an error (nothing routes here).
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc::{channel, Receiver, Sender};
    use std::sync::Condvar;
    use std::time::{Duration, Instant};

    /// The input side of the PTY map. A real `PtyHandle` needs a live child, so the
    /// concurrency tests key on the two fields `pty_write` touches.
    type TestPtys = Arc<Mutex<HashMap<String, (Sender<Vec<u8>>, Arc<AtomicUsize>)>>>;

    /// The resize side of the PTY map: a real master needs a live child, so this
    /// mirrors the one field `pty_resize` touches, wrapping included.
    type TestResizePtys = Arc<Mutex<HashMap<String, Arc<Mutex<WedgedResizer>>>>>;

    /// Blocks inside `resize` until released — the OS resize call that has not
    /// returned yet.
    struct WedgedResizer {
        entered: Sender<()>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }
    impl WedgedResizer {
        fn resize(&self) {
            let _ = self.entered.send(());
            let (lock, cv) = &*self.release;
            let mut go = lock.lock().unwrap();
            while !*go {
                go = cv.wait(go).unwrap();
            }
        }
    }

    /// Appends every write to a shared buffer, so a test can assert ordering.
    struct RecordingWriter(Arc<Mutex<Vec<u8>>>);
    impl Write for RecordingWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// Blocks inside `write` until released — a child that has stopped reading its
    /// input (a full ConPTY input buffer).
    struct WedgedWriter {
        entered: Sender<()>,
        release: Arc<(Mutex<bool>, Condvar)>,
        written: Arc<AtomicUsize>,
    }
    impl Write for WedgedWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let _ = self.entered.send(());
            let (lock, cv) = &*self.release;
            let mut go = lock.lock().unwrap();
            while !*go {
                go = cv.wait(go).unwrap();
            }
            self.written.fetch_add(buf.len(), Ordering::SeqCst);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    /// The control side of a [`WedgedWriter`]: `entered` fires as each write blocks,
    /// `gate` releases them, `written` totals the bytes that got through.
    struct Wedge {
        entered: Receiver<()>,
        gate: Arc<(Mutex<bool>, Condvar)>,
        written: Arc<AtomicUsize>,
    }

    fn wedged_writer() -> (WedgedWriter, Wedge) {
        let (entered_tx, entered) = channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let written = Arc::new(AtomicUsize::new(0));
        (
            WedgedWriter {
                entered: entered_tx,
                release: gate.clone(),
                written: written.clone(),
            },
            Wedge {
                entered,
                gate,
                written,
            },
        )
    }

    fn release(gate: &Arc<(Mutex<bool>, Condvar)>) {
        let (lock, cv) = &**gate;
        *lock.lock().unwrap() = true;
        cv.notify_all();
    }

    /// Waits for the writer thread to work the queue down to nothing.
    fn wait_for_drain(queued: &AtomicUsize) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while queued.load(Ordering::SeqCst) != 0 {
            assert!(Instant::now() < deadline, "the writer never drained the queue");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// Reports its own drop — the observable that stands in for "EOF reached the
    /// slave", which dropping the writer is what produces.
    struct DropSpy {
        dropped: Arc<AtomicBool>,
        fail: bool,
    }
    impl Write for DropSpy {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if self.fail {
                Err(std::io::Error::other("the child is gone"))
            } else {
                Ok(buf.len())
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl Drop for DropSpy {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn queued_writes_reach_the_pty_in_order() {
        // One consumer, so keystrokes land in the order the frontend queued them —
        // it fires unordered, unawaited invokes, one per keystroke.
        let sink = Arc::new(Mutex::new(Vec::new()));
        let queued = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = channel();
        let writer = RecordingWriter(sink.clone());
        let pump = std::thread::spawn(move || pump_pty_input(writer, rx, queued));

        let mut expected = Vec::new();
        for i in 0..1000u32 {
            let chunk = format!("{i};").into_bytes();
            expected.extend_from_slice(&chunk);
            tx.send(chunk).unwrap();
        }
        drop(tx);
        pump.join().unwrap();
        assert_eq!(*sink.lock().unwrap(), expected);
    }

    #[test]
    fn a_wedged_write_leaves_the_pty_map_lock_free() {
        // Mirrors the commands: `pty_write` sends under the map lock, `pty_close`
        // takes that same lock — which must stay reachable while a write is stuck.
        let ptys: TestPtys = Arc::default();
        let queued = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = channel();
        ptys.lock()
            .unwrap()
            .insert("t".to_string(), (tx, queued.clone()));
        let (writer, wedge) = wedged_writer();
        let pump = std::thread::spawn(move || pump_pty_input(writer, rx, queued));

        // `pty_write`: lock → get → queue → drop the guard.
        {
            let map = ptys.lock().unwrap();
            let (input, queued) = map.get("t").unwrap();
            queue_pty_input(input, queued, b"hello".to_vec());
        }
        wedge
            .entered
            .recv_timeout(Duration::from_secs(10))
            .expect("the writer thread should have reached the blocking write");
        assert!(
            ptys.try_lock().is_ok(),
            "a wedged write is holding the PTY map lock — pty_close would be stuck"
        );

        release(&wedge.gate);
        ptys.lock().unwrap().remove("t");
        pump.join().unwrap();
    }

    #[test]
    fn a_blocked_resize_leaves_the_pty_map_lock_free() {
        // `resize` is an OS call on the main thread, so `pty_resize` clones the master
        // out and DROPS the map guard before making it — `pty_write` and `pty_close`
        // take that same lock and must stay reachable through a resize storm.
        let ptys: TestResizePtys = Arc::default();
        let (entered_tx, entered) = channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        ptys.lock().unwrap().insert(
            "t".to_string(),
            Arc::new(Mutex::new(WedgedResizer {
                entered: entered_tx,
                release: gate.clone(),
            })),
        );

        let resizing = ptys.clone();
        let resize = std::thread::spawn(move || {
            let master = {
                let map = resizing.lock().unwrap();
                map.get("t").map(Arc::clone)
            };
            master.expect("the handle is registered").lock().unwrap().resize();
        });
        entered
            .recv_timeout(Duration::from_secs(10))
            .expect("the resizing thread should have reached the blocking resize");
        assert!(
            ptys.try_lock().is_ok(),
            "a blocked resize is holding the PTY map lock — pty_close would be stuck"
        );

        release(&gate);
        resize.join().unwrap();
    }

    #[test]
    fn writing_under_the_map_lock_blocks_close_control() {
        // Negative control for the test above: the pre-fix shape (write_all under the
        // map lock) DOES block a `pty_close`-style acquire, so that assertion can fail.
        let writers: Arc<Mutex<HashMap<String, WedgedWriter>>> = Arc::default();
        let (writer, wedge) = wedged_writer();
        writers.lock().unwrap().insert("t".to_string(), writer);

        let writing = writers.clone();
        let write = std::thread::spawn(move || {
            let mut map = writing.lock().unwrap();
            let _ = map.get_mut("t").unwrap().write_all(b"hello");
        });
        wedge
            .entered
            .recv_timeout(Duration::from_secs(10))
            .expect("the writing thread should have reached the blocking write");
        assert!(
            writers.try_lock().is_err(),
            "control failed: the write is not actually holding the lock"
        );

        release(&wedge.gate);
        write.join().unwrap();
    }

    #[test]
    fn input_past_the_queue_cap_is_dropped_while_the_pty_is_wedged() {
        // A child that stopped reading must not let continued typing grow the queue
        // without bound — but nothing under the cap may ever be dropped.
        let ptys: TestPtys = Arc::default();
        let queued = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = channel();
        ptys.lock()
            .unwrap()
            .insert("t".to_string(), (tx, queued.clone()));
        let (writer, wedge) = wedged_writer();
        let pump = {
            let queued = queued.clone();
            std::thread::spawn(move || pump_pty_input(writer, rx, queued))
        };

        let mib = vec![b'x'; 1024 * 1024];
        let queue = |data: Vec<u8>| {
            let map = ptys.lock().unwrap();
            let (input, queued) = map.get("t").unwrap();
            queue_pty_input(input, queued, data);
        };
        for _ in 0..8 {
            queue(mib.clone());
        }
        wedge
            .entered
            .recv_timeout(Duration::from_secs(10))
            .expect("the writer thread should have reached the blocking write");
        assert_eq!(queued.load(Ordering::SeqCst), PTY_INPUT_QUEUE_CAP);

        queue(mib.clone());
        queue(mib.clone());
        assert_eq!(
            queued.load(Ordering::SeqCst),
            PTY_INPUT_QUEUE_CAP,
            "input past the cap must be dropped, not queued"
        );
        assert!(
            ptys.try_lock().is_ok(),
            "a wedged write is holding the PTY map lock — pty_close would be stuck"
        );

        release(&wedge.gate);
        ptys.lock().unwrap().remove("t");
        pump.join().unwrap();
        assert_eq!(
            wedge.written.load(Ordering::SeqCst),
            PTY_INPUT_QUEUE_CAP,
            "the over-cap writes reached the PTY after all"
        );
        assert_eq!(queued.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_drained_queue_accepts_input_again() {
        // The cap gates a backlog, it isn't a latch: once the child catches up, the
        // next keystroke goes through.
        let sink = Arc::new(Mutex::new(Vec::new()));
        let queued = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = channel();
        let writer = RecordingWriter(sink.clone());
        let pump = {
            let queued = queued.clone();
            std::thread::spawn(move || pump_pty_input(writer, rx, queued))
        };

        queue_pty_input(&tx, &queued, b"first".to_vec());
        wait_for_drain(&queued);
        queue_pty_input(&tx, &queued, b"second".to_vec());
        drop(tx);
        pump.join().unwrap();
        assert_eq!(*sink.lock().unwrap(), b"firstsecond".to_vec());
        assert_eq!(queued.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn closing_the_channel_drops_the_writer() {
        // Dropping the writer is what sends EOF to the slave, so a torn-down handle
        // (close, or a StrictMode re-open displacing it) must end the pump.
        let dropped = Arc::new(AtomicBool::new(false));
        let writer = DropSpy {
            dropped: dropped.clone(),
            fail: false,
        };
        let queued = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = channel();
        let pump = std::thread::spawn(move || pump_pty_input(writer, rx, queued));
        tx.send(b"hi".to_vec()).unwrap();
        drop(tx);
        pump.join().unwrap();
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[test]
    fn a_failed_write_ends_the_writer_thread() {
        let dropped = Arc::new(AtomicBool::new(false));
        let writer = DropSpy {
            dropped: dropped.clone(),
            fail: true,
        };
        let queued = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = channel();
        let pump = {
            let queued = queued.clone();
            std::thread::spawn(move || pump_pty_input(writer, rx, queued))
        };
        queue_pty_input(&tx, &queued, b"hi".to_vec());
        pump.join().unwrap();
        assert!(dropped.load(Ordering::SeqCst));
        // The failed chunk comes off the books too, so a live handle whose writer
        // died doesn't sit at a phantom backlog.
        assert_eq!(queued.load(Ordering::SeqCst), 0);
        // Later keystrokes then find a closed channel: `pty_write` drops them and
        // still answers Ok — the Exit event is what reports the dead terminal.
        queue_pty_input(&tx, &queued, b"more".to_vec());
        assert_eq!(queued.load(Ordering::SeqCst), 0);
    }

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
