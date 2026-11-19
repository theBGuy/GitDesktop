use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::OnceCell;

use crate::error::{AppError, AppResult};
use crate::proc_tree::TreeGuard;
use crate::state::{AppState, HolderSlot, LockDomain};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Hang guard for git that tests run, as a per-spawn budget or an outer bound around
/// product calls; not a contract. Headroom over `DEFAULT_TIMEOUT` so ordinary machine
/// load does not fail a fixture step; a wedged child still fails the test.
#[cfg(test)]
pub(crate) const TEST_GIT_HANG_GUARD: Duration = Duration::from_secs(120);
/// The env `run_git_spawn` applies to every git child of a test build, so git run
/// through it discovers no system, global or XDG config. A test that spawns git
/// itself must pass it with `cmd.envs(TEST_GIT_ENV)`; without it that git reads the
/// developer's config. The NOSYSTEM pair closes the system config and attributes,
/// `GIT_CONFIG_GLOBAL` the global config file, and `XDG_CONFIG_HOME` the default
/// global ignore and attributes files. A caller's own pairs are applied after these
/// and win, so a test that needs global config passes its own `GIT_CONFIG_GLOBAL`
/// file per call; the runner refuses a `config --global` write without one. Git for
/// Windows reads `/dev/null` there as an empty file and fails a write with "could not
/// lock config file", creating nothing, when the drive has no `\dev` folder
/// (measured, 2.51.1). Never `GIT_CONFIG_COUNT` here: the submodule tests set it
/// process-wide, and a pair here would override theirs.
#[cfg(test)]
pub(crate) const TEST_GIT_ENV: [(&str, &str); 4] = [
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_ATTR_NOSYSTEM", "1"),
    ("GIT_CONFIG_GLOBAL", "/dev/null"),
    ("XDG_CONFIG_HOME", "/dev/null"),
];
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(600);
/// Adding and removing a worktree both write or delete a whole checkout, so their
/// cost is proportional to the tree rather than fixed. A node_modules-scale
/// worktree exceeds the default budget by a wide margin on Windows, and the kill
/// lands mid-materialize or mid-delete — leaving exactly the half-state the
/// registered/prunable reconciliation in `git::worktree` then has to clean up.
pub const WORKTREE_OP_TIMEOUT: Duration = Duration::from_secs(600);

/// How long a caller waits for the working-tree or worktree-admin lock before
/// reporting [`AppError::Busy`]. Short on purpose: the ops holding those domains
/// are local index/ref work, so a wait this long already means the user should be
/// told what they are queued behind rather than watching a spinner.
pub(crate) const LOCK_WAIT_TIMEOUT: Duration = Duration::from_secs(10);

/// The same bound for the network domain, where a legitimate holder is a transfer
/// whose own budget is `NETWORK_TIMEOUT` — a wait of a minute is still ordinary.
pub(crate) const NETWORK_LOCK_WAIT_TIMEOUT: Duration = Duration::from_secs(60);

/// The holder label for a hold whose operation has no better name.
pub(crate) const DEFAULT_HOLDER: &str = "another Git operation";

/// A held domain lock, which publishes its holder's label for as long as it lives
/// so a waiter that times out can name what it lost to.
#[derive(Debug)]
pub(crate) struct RepoLockGuard {
    _guard: tokio::sync::OwnedMutexGuard<()>,
    holder: HolderSlot,
}

impl Drop for RepoLockGuard {
    fn drop(&mut self) {
        *self.holder.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

/// Publish `label` as the domain's holder and wrap the guard, so the label is
/// cleared on every release path.
fn hold(
    domain: &LockDomain,
    guard: tokio::sync::OwnedMutexGuard<()>,
    label: &'static str,
) -> RepoLockGuard {
    let holder = domain.holder_slot();
    *holder.lock().unwrap_or_else(|p| p.into_inner()) = Some(label);
    RepoLockGuard {
        _guard: guard,
        holder,
    }
}

/// Wait up to `bound` for `domain`, labelling the hold `label`. On expiry the
/// CURRENT holder's label rides the error, so the user reads what they are waiting
/// for instead of watching an unbounded hang.
///
/// `bound` is a parameter rather than a constant so tests can pass
/// `Duration::ZERO`: `tokio::time::timeout` polls its inner future first, so a zero
/// budget still succeeds against a FREE lock and fails immediately against a held
/// one — free/held is decided by the lock, never by scheduling.
pub(crate) async fn acquire_repo_lock(
    domain: &LockDomain,
    bound: Duration,
    label: &'static str,
) -> AppResult<RepoLockGuard> {
    match tokio::time::timeout(bound, domain.lock().lock_owned()).await {
        Ok(guard) => Ok(hold(domain, guard, label)),
        Err(_) => Err(AppError::Busy {
            holder: domain.holder_label().unwrap_or(DEFAULT_HOLDER).to_string(),
        }),
    }
}

/// Wait indefinitely for `domain`. For the holds a user never initiated (agent
/// session turns) and the ones that ARE the long operation: erroring there would
/// only move the failure, so they queue.
pub(crate) async fn acquire_repo_lock_unbounded(
    domain: &LockDomain,
    label: &'static str,
) -> RepoLockGuard {
    let guard = domain.lock().lock_owned().await;
    hold(domain, guard, label)
}

/// Take `domain` only if it is free right now. `None` means someone else holds it
/// and the caller's work is skippable — never a queue.
pub(crate) fn try_acquire_repo_lock(
    domain: &LockDomain,
    label: &'static str,
) -> Option<RepoLockGuard> {
    let guard = domain.lock().try_lock_owned().ok()?;
    Some(hold(domain, guard, label))
}

/// How a git subcommand is named to the NEXT caller waiting on the same domain.
/// The user's word for the operation, not git's — this text lands in a toast.
///
/// Compound holds pass their own label instead (`"a history rewrite"`,
/// `"a submodule change"`), since the sequence is what the user did, not any one
/// of its commands.
pub(crate) fn holder_label(subcommand: &str) -> &'static str {
    match subcommand {
        "commit" => "a commit",
        // `apply` reaches this runner only as diff.rs's hunk stage/unstage/discard,
        // which the user knows as staging — never as a standalone patch tool.
        "add" | "apply" => "a staging operation",
        "restore" => "a file restore",
        // git::submodule's paths hold the working-tree lock themselves under
        // their own labels; the arm keeps a future submodule argv from being
        // mislabeled.
        "submodule" => "a submodule update",
        "checkout" | "switch" => "a checkout",
        "stash" => "a stash operation",
        "worktree" => "a worktree operation",
        "branch" => "a branch update",
        "merge" => "a merge",
        "rebase" => "a rebase",
        "cherry-pick" => "a cherry-pick",
        "revert" => "a revert",
        "reset" => "a reset",
        "pull" => "a pull",
        "push" => "a push",
        "fetch" => "a fetch",
        // `remote set-head --auto` — a real network call holding the network domain.
        "remote" => "a remote change",
        _ => DEFAULT_HOLDER,
    }
}

/// The subcommand in an argv that may open with `-c key=value` config pairs
/// (`op_continue`'s `core.editor`, the forge pushes' credential entries), which
/// would otherwise label every one of those holds generically.
pub(crate) fn subcommand_of<'a>(args: &[&'a str]) -> &'a str {
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if *arg == "-c" {
            rest.next();
        } else if !arg.starts_with('-') {
            return arg;
        }
    }
    ""
}

pub struct GitOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub code: i32,
}

impl GitOutput {
    pub fn stdout_lossy(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    /// [`run_git`]'s verdict over a raw run: a non-zero exit is [`AppError::Git`]
    /// carrying stderr alone.
    pub(crate) fn exit_verdict(self) -> AppResult<Self> {
        if self.code != 0 {
            return Err(AppError::Git {
                code: self.code,
                stderr: self.stderr,
            });
        }
        Ok(self)
    }

    /// The text describing a non-zero exit: stderr, or stdout when stderr is
    /// EMPTY. Correct only for the families that report on stdout ALONE — a
    /// conflicted merge or `stash pop` (measured, git 2.51.1) — where an error
    /// carrying that empty stderr renders as "git exited with code N". Anything
    /// that splits ONE report across both streams needs
    /// [`full_failure_text`](Self::full_failure_text) instead.
    pub fn failure_text(&self) -> String {
        let stderr = self.stderr.trim();
        if stderr.is_empty() {
            self.stdout_lossy().trim().to_string()
        } else {
            stderr.to_string()
        }
    }

    /// Both halves of a non-zero exit, stderr first and stdout below it, each
    /// omitted when empty.
    ///
    /// [`failure_text`](Self::failure_text) substitutes rather than combines, so
    /// it is a silent no-op wherever git splits ONE report across both streams:
    /// a conflicted revert/cherry-pick/rebase puts its diagnostic on stderr and
    /// its `CONFLICT (…)` file list on stdout, and a merge-mode `pull` puts the
    /// fetch summary on stderr and the whole merge verdict on stdout (measured,
    /// git 2.51.1). Dropping either half is data loss at the moment the user is
    /// deciding how to resolve.
    ///
    /// stderr leads because the frontend reads line 1 alone: `ROLLBACK_VERDICTS`
    /// and `firstMeaningfulLine` (`src/lib/error-summary.ts`), and the rollback
    /// funnels in `git::ops` prepend their verdict above whatever this returns.
    /// `strip_eol_warnings` runs over the stdout half too — the runner filters
    /// only stderr, so autocrlf advisories would otherwise ride into Details.
    ///
    /// One consequence to know: git's sequencer status stdout can carry
    /// `(all conflicts fixed: run "git cherry-pick --continue")`, which matches
    /// the frontend's `OP_ADVICE`, so combining the streams puts stdout advice
    /// within reach of the summary scanner.
    pub fn full_failure_text(&self) -> String {
        let stdout = strip_eol_warnings(&self.stdout_lossy());
        [self.stderr.trim(), stdout.trim()]
            .into_iter()
            .filter(|half| !half.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// The resolved `git` binary, memoized for the process lifetime.
///
/// `run_git_spawn` is the base of the whole git call stack (status, diffs,
/// history, staging — all firing continuously as the user works), and a packaged
/// GUI app on macOS doesn't inherit the user's shell PATH. So we resolve `git`
/// the way the About screen does (`crate::agent::resolve_named`: PATH + known
/// install dirs + a macOS/Linux login-shell fallback / the live Windows registry
/// PATH) rather than a bare `Command::new("git")`, which finds nothing when the app
/// is launched from Finder/Dock.
///
/// The result is cached because resolving isn't free: the login-shell fallback
/// (for a git install outside `candidate_dirs()`, e.g. MacPorts `/opt/local/bin`)
/// spawns `$SHELL -lic` with a 20s timeout, and re-running it on every git call
/// would serialize the whole app behind it. Only a *successful* resolution is
/// cached — `get_or_try_init` leaves the cell empty on error — so a git installed
/// after launch is still picked up on the next call, unless only the login shell
/// can find it: the resolver remembers that shell's miss (macOS/Linux) until
/// the process restarts, or in the app until About > Re-check.
static GIT_BIN: OnceCell<PathBuf> = OnceCell::const_new();

pub(crate) async fn git_bin() -> AppResult<PathBuf> {
    GIT_BIN
        .get_or_try_init(|| async {
            crate::agent::resolve_named(&["git"], None)
                .await
                .ok_or(AppError::GitNotFound)
        })
        .await
        .cloned()
}

/// Runs git and returns the raw output regardless of exit code.
/// Only spawn failures and timeouts are errors.
pub async fn run_git_raw(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    run_git_raw_input(repo_path, args, None, timeout).await
}

/// Like `run_git_raw`, but optionally feeds `input` to git's stdin
/// (e.g. a patch for `git apply -`).
pub async fn run_git_raw_input(
    repo_path: Option<&str>,
    args: &[&str],
    input: Option<&str>,
    timeout: Duration,
) -> AppResult<GitOutput> {
    run_git_raw_input_bytes(repo_path, args, input.map(str::as_bytes), timeout).await
}

/// [`run_git_raw_input`] over a stdin that need not be text. Callers whose input
/// carries PATH bytes want this: git's path handling is byte-domain, so a name
/// that is not valid UTF-8 has no `&str` spelling that reaches git unchanged.
pub async fn run_git_raw_input_bytes(
    repo_path: Option<&str>,
    args: &[&str],
    input: Option<&[u8]>,
    timeout: Duration,
) -> AppResult<GitOutput> {
    run_git_spawn(repo_path, args, input, &[], timeout).await
}

/// [`run_git_raw`] with extra environment pairs set on the git process, after the
/// runner's own. Only the history rewrite's rebase start and continue use it, to pin
/// GIT_SEQUENCE_EDITOR and GIT_EDITOR: env vars outrank any `-c` editor config. git
/// exports both to every exec line and hook the rebase runs; only GIT_EDITOR=true
/// makes an editor launch there a no-op.
pub(crate) async fn run_git_raw_env(
    repo_path: Option<&str>,
    args: &[&str],
    envs: &[(&str, &str)],
    timeout: Duration,
) -> AppResult<GitOutput> {
    run_git_spawn(repo_path, args, None, envs, timeout).await
}

/// [`run_git_raw_input`] with extra environment pairs, set after the runner's own.
pub(crate) async fn run_git_raw_input_env(
    repo_path: Option<&str>,
    args: &[&str],
    input: Option<&str>,
    envs: &[(&str, &str)],
    timeout: Duration,
) -> AppResult<GitOutput> {
    run_git_spawn(repo_path, args, input.map(str::as_bytes), envs, timeout).await
}

/// Test builds panic before spawning a `config --global` write that `TEST_GIT_ENV`
/// would aim at `/dev/null` (as root on unix it replaces the device with a regular
/// file). A panic, not an Err, because product code under test may swallow an Err.
/// The check is [`writes_global_config`].
#[cfg(test)]
fn refuse_global_config_write(args: &[&str], envs: &[(&str, &str)]) {
    assert!(
        !writes_global_config(args, envs),
        "tests never write the global git config through the runner (TEST_GIT_ENV points \
         it at /dev/null): pass a GIT_CONFIG_GLOBAL file of the test's own; {args:?}"
    );
}

/// Whether `args` run `git config` against the global file without a caller-owned one.
/// Past the top-level options and the separate values of `-c`, `-C`, `--git-dir`,
/// `--work-tree`, `--namespace`, `--config-env` and `--super-prefix`, the subcommand
/// must be `config`. A subcommand word (`get`, `set`, ...) counts only directly after
/// it, as in git, which reads one anywhere later as an old-style key or section name.
/// Only the options after `config` (or after its word) up to the first positional or
/// `--` count, each valued one taking the next token as its value; later tokens are
/// operands. `--global` or a prefix of it down to `--gl` selects the global file, and
/// only a `get` or `list` word, or with no word a dashed read option, reads: anything
/// else is a write, the one-key read (`config --global user.name`) included. A caller's
/// `GIT_CONFIG_GLOBAL` pair exempts it unless it names `/dev/null`; the name ignores
/// ASCII case on Windows.
#[cfg(test)]
fn writes_global_config(args: &[&str], envs: &[(&str, &str)]) -> bool {
    const VALUED: [&str; 7] = [
        "-c",
        "-C",
        "--git-dir",
        "--work-tree",
        "--namespace",
        "--config-env",
        "--super-prefix",
    ];
    const WORDS: [&str; 7] = [
        "list",
        "get",
        "set",
        "unset",
        "rename-section",
        "remove-section",
        "edit",
    ];
    const DASHED_READS: [&str; 8] = [
        "--get",
        "--get-all",
        "--get-regexp",
        "--get-urlmatch",
        "--get-color",
        "--get-colorbool",
        "--list",
        "-l",
    ];
    // `git config -h` (2.51.1) across its modes: the options that take a separate value.
    const CONFIG_VALUED: [&str; 9] = [
        "--file",
        "-f",
        "--blob",
        "--type",
        "-t",
        "--default",
        "--comment",
        "--value",
        "--url",
    ];
    let mut tokens = args.iter().copied();
    loop {
        match tokens.next() {
            Some(t) if VALUED.contains(&t) => {
                tokens.next();
            }
            Some(t) if t.starts_with('-') => {}
            Some("config") => break,
            _ => return false,
        }
    }
    let after: Vec<&str> = tokens.collect();
    let word = after.first().copied().filter(|w| WORDS.contains(w));
    let mut read = Vec::new();
    let mut rest = after[usize::from(word.is_some())..].iter().copied();
    while let Some(t) = rest.next() {
        if t == "--" || !t.starts_with('-') {
            break;
        }
        if CONFIG_VALUED.contains(&t) {
            rest.next();
        }
        read.push(t);
    }
    let global = read
        .iter()
        .any(|t| t.len() >= "--gl".len() && "--global".starts_with(t));
    let reads = match word {
        Some(w) => ["get", "list"].contains(&w),
        None => read.iter().any(|t| DASHED_READS.contains(t)),
    };
    let own_file = envs.iter().any(|(k, v)| {
        let named = if cfg!(windows) {
            k.eq_ignore_ascii_case("GIT_CONFIG_GLOBAL")
        } else {
            *k == "GIT_CONFIG_GLOBAL"
        };
        named && *v != "/dev/null"
    });
    global && !reads && !own_file
}

/// The one spawn path under every raw runner. An abandoned run (a timeout, a failed
/// wait) kills git's whole process tree on both platforms (`TreeGuard`).
async fn run_git_spawn(
    repo_path: Option<&str>,
    args: &[&str],
    input: Option<&[u8]>,
    envs: &[(&str, &str)],
    timeout: Duration,
) -> AppResult<GitOutput> {
    // A zero budget refuses before spawning — no production caller passes one (they
    // all use a *_TIMEOUT constant), and it makes the tests' `Duration::ZERO` seam
    // deterministic: a nonzero expired budget loses the race to a fast child (Linux).
    if timeout.is_zero() {
        return Err(AppError::Timeout(0));
    }
    #[cfg(test)]
    refuse_global_config_write(args, envs);
    #[cfg(test)]
    let _ = GIT_SPAWN_LOG.try_with(|log| log(args));
    let git = git_bin().await?;
    let mut cmd = Command::new(&git);
    // Also covers the credential helpers git spawns in turn, and puts the login-shell
    // PATH on hooks, filter drivers, ssh and by-name helpers.
    crate::agent::sanitize_child_env(&mut cmd);
    // Git for Windows gates long-path support on core.longpaths — the OS
    // LongPathsEnabled flag alone is not enough (probe-proven). Per-invocation so
    // the user's own git config is never mutated; other platforms ignore the key.
    // Diff section keying (diff split, AI ignore) needs literal `a/` `b/` headers, so
    // the prefix keys are pinned over diff.noprefix / custom / mnemonic user config.
    cmd.args([
        "-c",
        "core.quotePath=false",
        "-c",
        "color.ui=false",
        "-c",
        "core.longpaths=true",
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.srcPrefix=a/",
        "-c",
        "diff.dstPrefix=b/",
        "-c",
        "diff.mnemonicPrefix=false",
        // Machine-read log/show output must not carry signature text; an explicit
        // `--show-signature` on the command line still overrides it.
        "-c",
        "log.showSignature=false",
    ]);
    cmd.args(args);
    if let Some(repo) = repo_path {
        cmd.current_dir(repo);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");
    // Before the caller's pairs, which win over it.
    #[cfg(test)]
    cmd.envs(TEST_GIT_ENV);
    cmd.envs(envs.iter().copied());
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    TreeGuard::prepare(&mut cmd);
    cmd.kill_on_drop(true);

    // `git_bin()` already confirmed the binary exists, so a spawn-time NotFound
    // means the memoized path went stale mid-session (git moved/removed) — still
    // "git not found" to the user; anything else is a genuine I/O error.
    let spawn_err = |e: std::io::Error| {
        if e.kind() == std::io::ErrorKind::NotFound {
            AppError::GitNotFound
        } else {
            AppError::Io(e)
        }
    };
    let run = async {
        let mut child = cmd.spawn().map_err(spawn_err)?;
        // Declared after `child`, so on an abandoned run it drops (and kills) while
        // the unreaped leader still holds the group id.
        let guard = TreeGuard::arm(&child);

        // git interleaves reading stdin with writing stdout, so the write and both
        // drains have to run CONCURRENTLY: writing all of stdin first wedges as soon
        // as git's output fills its pipe buffer — git stops reading, our write
        // blocks behind it, and the whole exchange dies on the timeout below.
        // Local futures rather than `tokio::spawn`, because `input` is borrowed and
        // a `'static` copy would clone a multi-MB patch on every hunk stage.
        let stdin_pipe = child.stdin.take();
        let stdout_pipe = child.stdout.take().expect("stdout was piped");
        let stderr_pipe = child.stderr.take().expect("stderr was piped");
        let (written, stdout, stderr) = exchange(stdin_pipe, input, stdout_pipe, stderr_pipe).await;

        // The child's own verdict outranks a failed stdin write: that write fails
        // almost exclusively as a broken pipe from git exiting early, and git's
        // stderr and exit code are what say why. The write error surfaces only when
        // there is no child result to report instead.
        let reaped = match (stdout, stderr) {
            (Ok(out), Ok(err)) => child.wait().await.map(|status| (out, err, status)),
            (Err(e), _) | (_, Err(e)) => Err(e),
        };
        let (stdout, stderr, status) = match reaped {
            Ok(reaped) => reaped,
            // Abandoned without a reaped child, so the guard stays ARMED (see `disarm`).
            Err(e) => return Err(AppError::Io(written.err().unwrap_or(e))),
        };
        guard.disarm();
        Ok(GitOutput {
            stdout,
            stderr: strip_eol_warnings(&String::from_utf8_lossy(&stderr)),
            code: status.code().unwrap_or(-1),
        })
    };
    tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| AppError::Timeout(timeout.as_secs()))?
}

/// `run_git_spawn`'s stdin write and output drains, generic over the pipes so the
/// concurrency contract is testable over in-memory streams without spawning git.
async fn exchange<W, O, E>(
    stdin_pipe: Option<W>,
    input: Option<&[u8]>,
    mut stdout_pipe: O,
    mut stderr_pipe: E,
) -> (
    std::io::Result<()>,
    std::io::Result<Vec<u8>>,
    std::io::Result<Vec<u8>>,
)
where
    W: tokio::io::AsyncWrite + Unpin,
    O: tokio::io::AsyncRead + Unpin,
    E: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let write = async move {
        let (Some(mut pipe), Some(bytes)) = (stdin_pipe, input) else {
            return Ok(());
        };
        let written = pipe.write_all(bytes).await;
        // Close the pipe the moment the write ends (error path included) so
        // git sees EOF while the drains still poll — `--stdin` blocks forever
        // without it; the explicit drop pins that close point across refactors.
        drop(pipe);
        written
    };
    let drain_stdout = async move {
        let mut buf = Vec::new();
        stdout_pipe.read_to_end(&mut buf).await.map(|_| buf)
    };
    let drain_stderr = async move {
        let mut buf = Vec::new();
        stderr_pipe.read_to_end(&mut buf).await.map(|_| buf)
    };
    tokio::join!(write, drain_stdout, drain_stderr)
}

/// With core.autocrlf on, git emits a "LF will be replaced by CRLF the next
/// time Git touches it" advisory for every touched file. It's harmless noise
/// that bloats error toasts (and rides along when a command genuinely fails),
/// so drop those lines — and the CRLF→LF variant — from captured stderr.
fn strip_eol_warnings(stderr: &str) -> String {
    stderr
        .lines()
        .filter(|line| !is_eol_warning(line))
        .collect::<Vec<_>>()
        .join("\n")
}

fn is_eol_warning(line: &str) -> bool {
    line.contains("will be replaced by CRLF")
        || line.contains("will be replaced by LF")
        || line.contains("original line endings in your working directory")
}

/// Runs git, treating any non-zero exit code as an error carrying stderr.
pub async fn run_git(
    repo_path: Option<&str>,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    run_git_input(repo_path, args, None, timeout).await
}

/// `run_git` with optional stdin input.
pub async fn run_git_input(
    repo_path: Option<&str>,
    args: &[&str],
    input: Option<&str>,
    timeout: Duration,
) -> AppResult<GitOutput> {
    run_git_raw_input(repo_path, args, input, timeout)
        .await?
        .exit_verdict()
}

/// The working tree's toplevel for `repo_path`, which may be any directory
/// inside it.
///
/// Anything that reads repo-relative NAMES out of git, or hands git pathspecs
/// meant to match them, has to bind to this rather than to the path it was
/// given: git prints and resolves both relative to the cwd, so a subdirectory
/// silently re-scopes the answer while still looking well-formed. The MCP server
/// takes `--repo` verbatim, so that subdirectory is reachable.
pub(crate) async fn worktree_toplevel(repo_path: &str) -> AppResult<String> {
    let out = run_git(
        Some(repo_path),
        &["rev-parse", "--show-toplevel"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let stdout = out.stdout_lossy();
    // Line endings ONLY: a trailing space can be part of the directory name, and
    // `trim()` would strip it into a path that does not exist.
    let toplevel = stdout.trim_end_matches(['\r', '\n']).to_string();
    if toplevel.is_empty() {
        return Err(AppError::NotARepo(repo_path.to_string()));
    }
    Ok(toplevel)
}

/// Runs a mutating git command under the repo's WORKING-TREE lock, retrying once
/// on index.lock contention caused by external tools (editors, other clients). The
/// wait is bounded by [`LOCK_WAIT_TIMEOUT`] and reports [`AppError::Busy`] naming
/// the current holder, so a caller is never queued behind a long op with no word.
///
/// A repo has three independent domains — working-tree, worktree-admin
/// (`run_git_worktree_admin`), network (`remote::run_git_mutating_with_creds`) —
/// and every one of them is non-reentrant. Compound sequences take their domain's
/// lock themselves, so their guards, anchors and rollback see one unbroken view,
/// and must NOT call a mutating runner of THAT domain from inside the hold: use the
/// lock-free runners (`run_git`, `run_git_raw`, the `_input` pair,
/// `remote::run_git_with_creds_once`), which lose the retry above, or
/// `run_git_raw_index_retry`, which keeps it for a raw run.
/// Crossing domains is allowed in ONE direction: a working-tree hold may take the
/// network lock (a pull is a transfer plus a merge), never the reverse, which is
/// what keeps the wait graph acyclic. Either way the locks serialize callers in
/// THIS process: a separate MCP-server process has its own and is not covered.
pub async fn run_git_mutating(
    state: &AppState,
    repo_path: &str,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    run_git_mutating_input(state, repo_path, args, None, timeout).await
}

/// `run_git_mutating` without its non-zero-exit verdict: same lock and same
/// one-shot index.lock retry, but the raw output comes back so the caller can
/// read STDOUT on failure. [`GitOutput::full_failure_text`] is the shaping those
/// callers share; [`GitOutput::failure_text`] only suits the ones whose failure
/// lands on stdout ALONE, which is merge.
pub async fn run_git_mutating_raw(
    state: &AppState,
    repo_path: &str,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    let domain = state.working_tree_lock(repo_path).await;
    let _guard = acquire_repo_lock(
        &domain,
        LOCK_WAIT_TIMEOUT,
        holder_label(subcommand_of(args)),
    )
    .await?;
    run_git_raw_index_retry(repo_path, args, timeout).await
}

/// The mutating runners' one-shot index.lock retry over a raw run, lock-free — the
/// caller already holds the working-tree domain.
pub(crate) async fn run_git_raw_index_retry(
    repo_path: &str,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    let out = run_git_raw(Some(repo_path), args, timeout).await?;
    if out.code != 0 && out.stderr.contains("index.lock") {
        tokio::time::sleep(Duration::from_millis(300)).await;
        return run_git_raw(Some(repo_path), args, timeout).await;
    }
    Ok(out)
}

/// `run_git_mutating` with optional stdin input.
pub async fn run_git_mutating_input(
    state: &AppState,
    repo_path: &str,
    args: &[&str],
    input: Option<&str>,
    timeout: Duration,
) -> AppResult<GitOutput> {
    let domain = state.working_tree_lock(repo_path).await;
    let _guard = acquire_repo_lock(
        &domain,
        LOCK_WAIT_TIMEOUT,
        holder_label(subcommand_of(args)),
    )
    .await?;
    match run_git_input(Some(repo_path), args, input, timeout).await {
        Err(AppError::Git { ref stderr, .. }) if stderr.contains("index.lock") => {
            tokio::time::sleep(Duration::from_millis(300)).await;
            run_git_input(Some(repo_path), args, input, timeout).await
        }
        other => other,
    }
}

/// How long a config write waits before its one retry. git never waits on
/// `.git/config.lock` itself, and the writers it collides with hold it for milliseconds.
pub(crate) const CONFIG_LOCK_RETRY_DELAY: Duration = Duration::from_millis(250);

/// Whether a failed git run lost `.git/config.lock` to another writer. Read per line in
/// git's C-locale text: a lock line counts when bare or ending `: File exists`; bare lines
/// must count, as section rename/remove print no reason (measured, git 2.51.1), so a
/// read-only disk there still does. Any other reason on any lock line means no retry
/// helps. Colon-space delimits the reason, so a drive-letter path never reads as one.
pub(crate) fn is_config_lock_contention(stderr: &str) -> bool {
    let mut lost = false;
    for line in stderr.lines() {
        let Some((_, rest)) = line.split_once("could not lock config file") else {
            continue;
        };
        if let Some((_, reason)) = rest.rsplit_once(": ") {
            if reason.trim_end() != "File exists" {
                return false;
            }
        }
        lost = true;
    }
    lost
}

/// The lead every [`config_lock_busy`] refusal opens with, so a wrapping caller can
/// recognize one and re-tail it.
pub(crate) const CONFIG_LOCK_BUSY_LEAD: &str =
    "Another Git process was saving this repository's settings, so ";

/// The refusal once a writer's repair failed after a lost config lock: `tail` says what
/// landed and the next step. The text never carries git's lock-file path, and line 1
/// is the toast title.
pub(crate) fn config_lock_busy(tail: &str) -> AppError {
    AppError::Command(format!("{CONFIG_LOCK_BUSY_LEAD}{tail}"))
}

/// Runs `attempt` once more after [`CONFIG_LOCK_RETRY_DELAY`] when its first run lost
/// the config lock; any other outcome, the retry's included, comes back as-is. Generic
/// over the run so the policy is testable without timing a real collision.
pub(crate) async fn retry_on_config_lock<F, Fut>(mut attempt: F) -> AppResult<GitOutput>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = AppResult<GitOutput>>,
{
    let out = attempt().await?;
    if out.code != 0 && is_config_lock_contention(&out.stderr) {
        tokio::time::sleep(CONFIG_LOCK_RETRY_DELAY).await;
        return attempt().await;
    }
    Ok(out)
}

/// A `git config` write under the repo's config-write mutex alone (no domain lock),
/// with the one config-lock retry; raw output, so the caller maps exit codes
/// (`--unset`'s 5) and a second lost race itself.
pub(crate) async fn run_git_config_write(
    repo_path: &str,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    with_config_write_lock(repo_path, |held| async move {
        run_git_config_write_held(&held, repo_path, args, timeout).await
    })
    .await
}

type ConfigWriteLocks = std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>;

/// One mutex per repository for this process's `.git/config` writers: held across short
/// writes' spawns; across only the repair leg of long ones (`push -u`, submodule
/// add/update/deinit, `worktree add -b`, whose case-twin check takes its own short hold
/// before the add); across the checkout of tracking switches and of checked-out creates;
/// and across the app's plain switches onto an existing branch for their HEAD move, so
/// none lands inside a branch delete's guarded window. PR checkout's two switches skip it
/// and are excluded by the worktree-admin hold every delete caller takes. The long
/// commands' unheld first runs, and other processes, can still collide, which the retry
/// and repairs cover. A LEAF lock: taken after any domain lock, never before one.
static CONFIG_WRITE_LOCKS: OnceLock<ConfigWriteLocks> = OnceLock::new();

/// The config-write mutex for `repo_path`, keyed by the common git dir because every
/// checkout of a repository writes the same `.git/config`. An unresolvable identity
/// falls back to the raw spelling, which can only under-serialize onto the retry; it
/// also loses the switch-versus-delete exclusion, leaving the delete's second guard pass
/// as the backstop.
async fn config_write_lock(repo_path: &str) -> Arc<tokio::sync::Mutex<()>> {
    let identity = crate::git::repo::repo_identity(repo_path)
        .await
        .unwrap_or_else(|_| repo_path.to_string());
    let key = crate::git::worktree::normalize_wt_path(&identity);
    let mut locks = CONFIG_WRITE_LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    Arc::clone(locks.entry(key).or_default())
}

/// Proof that the holder is inside [`with_config_write_lock`], so the held runner
/// below is never reached without the mutex (re-taking it inside would deadlock).
/// Only that function mints one, and a body may make any number of writes with a
/// borrow of it. Callers must keep those writes inside the body: nothing in the type
/// stops the token escaping through the body's return value, past the hold.
pub(crate) struct ConfigWriteHeld(());

/// Runs `body` holding `repo_path`'s config-write mutex. The wait is unbounded and a
/// hold lasts as long as its git work: a tracking switch, a plain switch onto an existing
/// branch, or any checked-out create keeps it across the whole checkout (filters, hooks)
/// plus its repairs. A waiter keeps the domains it holds meanwhile, among them any
/// create's, rename's, switch's or plain delete's working-tree domain, and the
/// worktree-admin domain of a branch delete or a new-branch worktree add, so commands in
/// those domains can report Busy.
pub(crate) async fn with_config_write_lock<F, Fut, T>(repo_path: &str, body: F) -> T
where
    F: FnOnce(ConfigWriteHeld) -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let lock = config_write_lock(repo_path).await;
    #[cfg(test)]
    let _ = CONFIG_WRITE_LOCK_EVENTS.try_with(|event| event("waiting"));
    let held = lock.lock().await;
    #[cfg(test)]
    let _ = CONFIG_WRITE_LOCK_EVENTS.try_with(|event| event("acquired"));
    let out = body(ConfigWriteHeld(())).await;
    drop(held);
    #[cfg(test)]
    let _ = CONFIG_WRITE_LOCK_EVENTS.try_with(|event| event("freed"));
    out
}

#[cfg(test)]
tokio::task_local! {
    /// Runs before each held config-write attempt, so a test can release a held
    /// `.git/config.lock` between a first attempt and its retry without timing either.
    pub(crate) static CONFIG_WRITE_ATTEMPT_HOOK: Arc<dyn Fn() + Send + Sync>;

    /// Told "waiting" just before the config-write mutex is requested, "acquired" once
    /// it is held and "freed" once released, so a test can order a parked writer
    /// against its own release, and a long command against the hold.
    pub(crate) static CONFIG_WRITE_LOCK_EVENTS: Arc<dyn Fn(&'static str) + Send + Sync>;

    /// Told each git argv (without the runner's own `-c` pairs) just before it spawns,
    /// so a test can count and order the reads one operation makes.
    pub(crate) static GIT_SPAWN_LOG: Arc<dyn Fn(&[&str]) + Send + Sync>;
}

/// A [`CONFIG_WRITE_ATTEMPT_HOOK`] that deletes `lock` just before held attempt
/// number `release_at` (1-based), plus the attempt counter it bumps.
#[cfg(test)]
pub(crate) fn release_config_lock_before_attempt(
    lock: PathBuf,
    release_at: usize,
) -> (
    Arc<dyn Fn() + Send + Sync>,
    Arc<std::sync::atomic::AtomicUsize>,
) {
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = Arc::clone(&calls);
    let hook = move || {
        if counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1 == release_at {
            std::fs::remove_file(&lock).expect("the held config.lock is released");
        }
    };
    (Arc::new(hook), calls)
}

/// Holds `repo`'s `.git/config.lock` the way another writer would, until the returned
/// path is removed.
#[cfg(test)]
pub(crate) fn hold_config_lock(repo: impl AsRef<std::path::Path>) -> PathBuf {
    let lock = repo.as_ref().join(".git").join("config.lock");
    std::fs::write(&lock, b"").expect("the config.lock is held");
    lock
}

/// Each config-write mutex event, with a probe's verdict at that moment.
#[cfg(test)]
pub(crate) type LockLog = Arc<std::sync::Mutex<Vec<(&'static str, bool)>>>;

/// A [`CONFIG_WRITE_LOCK_EVENTS`] hook logging each mutex event with `probe()`'s
/// verdict at that moment, so a test can place a long command against the hold.
#[cfg(test)]
pub(crate) fn lock_events(
    probe: impl Fn() -> bool + Send + Sync + 'static,
) -> (Arc<dyn Fn(&'static str) + Send + Sync>, LockLog) {
    let log = LockLog::default();
    let sink = Arc::clone(&log);
    let hook = move |event| sink.lock().unwrap().push((event, probe()));
    (Arc::new(hook), log)
}

/// [`run_git_config_write`] for a caller already holding the config-write mutex.
pub(crate) async fn run_git_config_write_held(
    _held: &ConfigWriteHeld,
    repo_path: &str,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    retry_on_config_lock(|| {
        #[cfg(test)]
        let _ = CONFIG_WRITE_ATTEMPT_HOOK.try_with(|hook| hook());
        run_git_raw(Some(repo_path), args, timeout)
    })
    .await
}

/// A working-tree mutation that also rewrites `.git/config` (`branch -m`/`-D`, a
/// tracking switch, the `remote` verbs): the working-tree domain, then the config-write
/// mutex, each taken ONCE. On a lost config lock `repair` gets the raw output and the
/// held mutex and redoes only what the loss left undone, never a branch command's ref
/// change, which lands before git writes the config. Busy as [`run_git_mutating`]; a
/// non-zero exit is [`AppError::Git`] with [`GitOutput::full_failure_text`].
pub(crate) async fn run_git_mutating_config_write<F, Fut>(
    state: &AppState,
    repo_path: &str,
    args: &[&str],
    timeout: Duration,
    repair: F,
) -> AppResult<GitOutput>
where
    F: FnOnce(GitOutput, ConfigWriteHeld) -> Fut,
    Fut: std::future::Future<Output = AppResult<GitOutput>>,
{
    let domain = state.working_tree_lock(repo_path).await;
    let _guard = acquire_repo_lock(
        &domain,
        LOCK_WAIT_TIMEOUT,
        holder_label(subcommand_of(args)),
    )
    .await?;
    let out = with_config_write_lock(repo_path, |held| async move {
        let out = run_git_raw_index_retry(repo_path, args, timeout).await?;
        if is_config_lock_contention(&out.stderr) {
            return repair(out, held).await;
        }
        Ok(out)
    })
    .await?;
    if out.code != 0 {
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    Ok(out)
}

/// Runs a `git worktree …` admin command under the repo's WORKTREE-ADMIN lock —
/// the domain that keeps a multi-minute removal from stalling staging, commits and
/// the worktree list. Same bounded wait and [`AppError::Busy`] contract as
/// [`run_git_mutating`]; no index.lock retry, since these commands touch the admin
/// registry rather than the index.
pub(crate) async fn run_git_worktree_admin(
    state: &AppState,
    repo_path: &str,
    args: &[&str],
    timeout: Duration,
) -> AppResult<GitOutput> {
    let domain = state.worktree_admin_lock(repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a worktree operation").await?;
    run_git(Some(repo_path), args, timeout).await
}

#[cfg(test)]
mod lock_tests {
    use super::*;

    /// A zero budget is the deterministic seam for both verdicts: it resolves for a
    /// FREE lock (timeout polls its inner future first) and expires immediately for
    /// a held one, so neither arm rests on scheduling.
    #[tokio::test]
    async fn a_bounded_acquire_names_the_current_holder() {
        let state = AppState::default();
        let domain = state.worktree_admin_lock("C:/repos/busy").await;

        let held = acquire_repo_lock(&domain, Duration::ZERO, "a worktree removal")
            .await
            .expect("a free lock is taken at a zero budget");

        let err = acquire_repo_lock(&domain, Duration::ZERO, "a commit")
            .await
            .expect_err("a held lock refuses rather than queueing");
        let AppError::Busy { holder } = &err else {
            panic!("expected Busy, got {err:?}");
        };
        assert_eq!(holder, "a worktree removal");
        assert_eq!(
            err.to_string(),
            "A worktree removal is still running — try again when it finishes."
        );

        // Released ⇒ free again, and the stale label is gone with it.
        drop(held);
        assert_eq!(domain.holder_label(), None);
        acquire_repo_lock(&domain, Duration::ZERO, "a commit")
            .await
            .expect("the released lock is taken immediately");
    }

    /// An unlabeled holder still has to produce a sentence, so the waiter never
    /// reads a headless one.
    #[tokio::test]
    async fn an_unlabeled_holder_falls_back_to_the_generic_name() {
        let state = AppState::default();
        let domain = state.working_tree_lock("C:/repos/unlabeled").await;
        let raw = domain.lock();
        let _held = raw.lock().await;

        let err = acquire_repo_lock(&domain, Duration::ZERO, "a commit")
            .await
            .expect_err("the raw hold still blocks");
        assert!(
            matches!(&err, AppError::Busy { holder } if holder == DEFAULT_HOLDER),
            "{err:?}"
        );
    }

    /// The domains are independent by construction: a removal holding ADMIN must
    /// not delay a commit, which is the whole point of the split.
    #[tokio::test]
    async fn the_three_domains_do_not_block_each_other() {
        let state = AppState::default();
        let repo = "C:/repos/domains";
        let _admin = acquire_repo_lock(
            &state.worktree_admin_lock(repo).await,
            Duration::ZERO,
            "a worktree removal",
        )
        .await
        .expect("admin is free");

        for domain in [
            state.working_tree_lock(repo).await,
            state.network_lock(repo).await,
        ] {
            acquire_repo_lock(&domain, Duration::ZERO, "a commit")
                .await
                .expect("another domain is unaffected by the admin hold");
        }
    }

    /// Every accessor call for one repo path hands back the SAME mutex, and a
    /// different path a different one. The whole scheme rests on this: a registry
    /// that minted a fresh domain per call would serialize nothing while every
    /// acquire still succeeded, and one that ignored the path would serialize every
    /// repo against every other.
    #[tokio::test]
    async fn one_repo_path_shares_one_working_tree_mutex() {
        let state = AppState::default();
        let repo = "C:/repos/same-mutex";
        let _held = state.working_tree_lock(repo).await.lock().lock_owned().await;

        assert!(
            state
                .working_tree_lock(repo)
                .await
                .lock()
                .try_lock()
                .is_err(),
            "a second lookup of the same path must find the held mutex"
        );
        assert!(
            state
                .working_tree_lock("C:/repos/other")
                .await
                .lock()
                .try_lock()
                .is_ok(),
            "another repo path must be an independent mutex"
        );
    }

    /// The classifier keys on git's own config-lock wording and nothing nearby:
    /// index.lock has its own retry, a permissions failure is no transient hold, and a
    /// different failure must surface unretried.
    #[test]
    fn config_lock_contention_matches_only_the_config_lock_failure() {
        assert!(is_config_lock_contention(
            "error: could not lock config file .git/config: File exists"
        ));
        assert!(is_config_lock_contention(
            "warning: could not lock config file C:/r/.git/config: File exists\n"
        ));
        for other in [
            "",
            "error: could not lock config file .git/config: Permission denied",
            "fatal: Unable to create 'C:/r/.git/index.lock': File exists.",
            "error: key does not contain a section: gitdesktopArchived",
            "fatal: not a git repository (or any of the parent directories): .git",
        ] {
            assert!(!is_config_lock_contention(other), "{other:?}");
        }
    }

    /// The per-line reason rule: git's bare form (no reason, as the section rename and
    /// remove paths print it) and `File exists` count, a drive-letter path never reads
    /// as a reason, and any other reason is no transient hold.
    #[test]
    fn config_lock_contention_reads_only_the_lines_reason() {
        for held in [
            "error: could not lock config file .git/config\nwarning: update of config-file failed",
            "error: could not lock config file .git/config",
            "error: could not lock config file .git/config\n\
             error: Could not remove config section 'remote.origin'",
            "error: could not lock config file .git/config: File exists",
            "error: could not lock config file C:/Users/me/repo/.git/config: File exists\r\n",
            "error: could not lock config file .git/config\n\
             error: could not lock config file .git/config: File exists",
            "error: could not lock config file .git/config\n\
             error: could not lock config file .git/config",
        ] {
            assert!(is_config_lock_contention(held), "{held:?}");
        }
        for other in [
            "error: could not lock config file .git/config\n\
             error: could not lock config file .git/config: Permission denied",
            "error: could not lock config file C:/r/.git/config: Permission denied",
            "error: could not lock config file .git/config: Read-only file system",
            "error: could not lock config file .git/config: No space left on device",
            "fatal: could not unset 'remote.pushDefault'",
        ] {
            assert!(!is_config_lock_contention(other), "{other:?}");
        }
    }

    fn output(code: i32, stderr: &str) -> GitOutput {
        GitOutput {
            stdout: Vec::new(),
            stderr: stderr.to_string(),
            code,
        }
    }

    /// A lost config lock gets exactly one more attempt; success, an unrelated
    /// failure, and a second lost race all stop there.
    #[tokio::test]
    async fn the_config_write_retries_once_and_only_on_the_config_lock() {
        const LOST: &str = "error: could not lock config file .git/config: File exists";
        for (script, want_calls, want_code) in [
            (vec![output(255, LOST), output(0, "")], 2, 0),
            (vec![output(255, LOST), output(255, LOST)], 2, 255),
            (vec![output(0, "")], 1, 0),
            (vec![output(5, "")], 1, 5),
            (vec![output(128, "fatal: other")], 1, 128),
        ] {
            let calls = std::sync::atomic::AtomicUsize::new(0);
            let script = std::sync::Mutex::new(std::collections::VecDeque::from(script));
            let out = retry_on_config_lock(|| {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let next = script.lock().unwrap().pop_front().expect("a scripted run");
                async move { Ok(next) }
            })
            .await
            .expect("the scripted runs never error");
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), want_calls);
            assert_eq!(out.code, want_code);
        }
    }

    /// The label a waiter reads comes from the argv, and a leading `-c` pair must
    /// not hide the subcommand behind it.
    #[test]
    fn the_holder_label_reads_past_leading_config_pairs() {
        assert_eq!(subcommand_of(&["commit", "-m", "x"]), "commit");
        assert_eq!(
            subcommand_of(&["-c", "core.editor=true", "rebase", "--continue"]),
            "rebase"
        );
        assert_eq!(subcommand_of(&["-c", "a=b", "-c", "c=d", "push"]), "push");
        assert_eq!(subcommand_of(&[]), "");
        assert_eq!(holder_label("cherry-pick"), "a cherry-pick");
        assert_eq!(holder_label("bisect"), DEFAULT_HOLDER);
    }
}

#[cfg(test)]
mod stdin_tests {
    use super::*;

    #[tokio::test]
    async fn nosystem_suppresses_an_explicitly_redirected_system_config() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("system.config");
        std::fs::write(&config, "[gitdesktopFixture]\n poison = visible\n").unwrap();
        let git = git_bin().await.unwrap();
        // The config poison is measured; attribute suppression relies on Git's
        // behavior confirmed with `git var GIT_ATTR_SYSTEM`, not a redirected
        // system-attributes fixture. Explicit `config --system` bypasses NOSYSTEM.
        for suppress in [false, true] {
            let mut cmd = Command::new(&git);
            cmd.current_dir(dir.path())
                .args(["config", "--get", "gitdesktopFixture.poison"])
                .env("GIT_CONFIG_SYSTEM", &config)
                .env_remove("GIT_CONFIG_NOSYSTEM");
            if suppress {
                cmd.env("GIT_CONFIG_NOSYSTEM", "1");
            }
            let out = cmd.output().await.unwrap();
            assert_eq!(out.status.code(), Some(if suppress { 1 } else { 0 }));
            assert_eq!(
                out.stdout,
                if suppress { b"".as_slice() } else { b"visible\n" },
            );
            assert!(
                out.stderr.is_empty(),
                "{}",
                String::from_utf8_lossy(&out.stderr),
            );
        }
    }

    /// Both sides must pass where a write-then-read runner wedges: the 64 KiB stdin
    /// pipe on unix, tokio's `Blocking` write buffer (`DEFAULT_MAX_BUF_SIZE`, 2 MiB) on
    /// Windows. git flushes once per record under `--stdin`, so the cost under load
    /// scales with the record count, not the byte count: keep records few and long.
    /// Each path is 16 directories of 250 bytes, since one component past NAME_MAX
    /// (255) is a different input on unix.
    const PATH_COUNT: usize = 1_200;
    const SEGMENT: usize = 250;
    const SEGMENTS: usize = 16;

    /// Output far larger than the pipe buffer, produced while stdin is still being
    /// written: the shape that deadlocked a write-then-read runner into a spurious
    /// timeout. `git_ignored_files` hits it for real — every path it sends matches
    /// by construction, and `--verbose` answers with four tokens per one sent.
    #[tokio::test]
    async fn large_interleaved_stdin_and_output_complete() {
        let dir = tempfile::Builder::new()
            .prefix("gd-runner-stdin-")
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        run_git(Some(&repo), &["init", "-q"], TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        // `*` in the repo's own `.gitignore` outranks any global excludes the
        // machine happens to carry, so every path matches this one rule.
        std::fs::write(dir.path().join(".gitignore"), "*\n").unwrap();

        // One shared directory chain, so git has a single set of parents to look
        // for nested ignore files in.
        let dirs = format!("{}/", "d".repeat(SEGMENT)).repeat(SEGMENTS);
        let paths: Vec<String> = (0..PATH_COUNT)
            .map(|i| format!("generated/{dirs}{i:06}.bin"))
            .collect();
        let input: String = paths.iter().map(|p| format!("{p}\0")).collect();
        assert!(
            input.len() > 4 * 1024 * 1024,
            "stdin must outrun tokio's 2 MiB Windows write buffer, got {} bytes",
            input.len()
        );

        // Over real pipes a deadlock can only present as a timeout, so the bound
        // keeps a regression finite; the clock-free contract is
        // `exchange_writes_while_draining_both_outputs`.
        let out = run_git_raw_input(
            Some(&repo),
            &["check-ignore", "--verbose", "-z", "--stdin"],
            Some(&input),
            TEST_GIT_HANG_GUARD,
        )
        .await
        .expect("check-ignore answers inside the timeout");
        assert_eq!(out.code, 0, "stderr: {}", out.stderr);
        assert!(
            out.stdout.len() > 1024 * 1024,
            "output must exceed every pipe buffer, got {} bytes",
            out.stdout.len()
        );

        // Byte-compared, not lossy-parsed: partial or interleaved drains would
        // corrupt exactly here. `-z` terminates every token, so the split's last
        // element is empty.
        let tokens: Vec<&[u8]> = out.stdout.split(|b| *b == 0).collect();
        assert_eq!(tokens.len(), PATH_COUNT * 4 + 1, "one record per path sent");
        assert_eq!(tokens[PATH_COUNT * 4], b"");
        for (i, path) in paths.iter().enumerate() {
            assert_eq!(tokens[i * 4], b".gitignore");
            assert_eq!(tokens[i * 4 + 1], b"1");
            assert_eq!(tokens[i * 4 + 2], b"*");
            assert_eq!(tokens[i * 4 + 3], path.as_bytes(), "record {i}");
        }
    }

    /// The exchange over 64-byte in-memory pipes, against a peer that answers each
    /// record before reading the next, as `check-ignore --stdin` does: writing all of
    /// stdin first, holding it open, or draining one output before the other wedges.
    /// One thread and no clock, so a correct run takes the same polls under any load
    /// and a wedge always exhausts the yield budget.
    #[tokio::test(flavor = "current_thread")]
    async fn exchange_writes_while_draining_both_outputs() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

        const RECORDS: usize = 2_000;
        // A correct run used 2,375 yields on every run (measured on tokio 1.54.1,
        // Windows); about 100x that keeps a wedge's failure fast.
        const BUDGET: usize = 250_000;

        let record = |i: usize| format!("generated/{}{i:06}.bin\0", "f".repeat(40));
        let input: String = (0..RECORDS).map(record).collect();
        let mut expected_stdout = Vec::new();
        let mut expected_stderr = Vec::new();
        for i in 0..RECORDS {
            expected_stdout.extend_from_slice(b".gitignore\0");
            expected_stdout.extend_from_slice(b"1\0*\0");
            expected_stdout.extend_from_slice(record(i).as_bytes());
            expected_stderr.extend_from_slice(format!("{i}\n").as_bytes());
        }

        let (stdin, peer_stdin) = tokio::io::duplex(64);
        let (mut peer_stdout, stdout) = tokio::io::duplex(64);
        let (mut peer_stderr, stderr) = tokio::io::duplex(64);
        // The peer owns its write halves, so they close when it returns and the
        // drains see EOF; each answer alone outgrows the 64-byte pipe.
        let peer = tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(peer_stdin);
            let mut record = Vec::new();
            let mut answered = 0usize;
            while reader.read_until(0, &mut record).await.unwrap() > 0 {
                let answer = [&b".gitignore\0"[..], b"1\0*\0", &record].concat();
                peer_stdout.write_all(&answer).await.unwrap();
                let token = format!("{answered}\n");
                peer_stderr.write_all(token.as_bytes()).await.unwrap();
                answered += 1;
                record.clear();
            }
            answered
        });

        let (written, stdout, stderr) = tokio::select! {
            biased;
            r = exchange(Some(stdin), Some(input.as_bytes()), stdout, stderr) => r,
            () = async {
                for _ in 0..BUDGET {
                    tokio::task::yield_now().await;
                }
            } => panic!("exchange wedged: no completion within {BUDGET} yields"),
        };
        let answered = match peer.await {
            Ok(answered) => answered,
            Err(e) => std::panic::resume_unwind(e.into_panic()),
        };

        written.expect("stdin write");
        assert_eq!(answered, RECORDS, "the peer answers every record sent");
        let stdout = stdout.expect("stdout drain");
        let stderr = stderr.expect("stderr drain");
        assert!(
            stdout == expected_stdout,
            "stdout differs: {} bytes, expected {}",
            stdout.len(),
            expected_stdout.len()
        );
        assert!(
            stderr == expected_stderr,
            "stderr differs: {} bytes, expected {}",
            stderr.len(),
            expected_stderr.len()
        );
    }
}

#[cfg(test)]
mod config_tests {
    use super::*;

    /// The per-invocation `-c` block is a behavior contract, not a preference:
    /// `core.longpaths` is what lets Git for Windows write past 260 chars, and
    /// the parse/color settings are what every output parser in the app assumes.
    /// Read back through git so the assertion covers the value REACHING the
    /// child, not merely the argv we build.
    #[tokio::test]
    async fn injected_config_reaches_git() {
        let dir = tempfile::Builder::new()
            .prefix("gd-runner-config-")
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        run_git(Some(&repo), &["init", "-q"], TEST_GIT_HANG_GUARD)
            .await
            .unwrap();

        // `-c` is the command-line scope, which outranks the machine's own
        // system/global/local config — so this holds on any dev box.
        for (key, want) in [
            ("core.longpaths", "true"),
            ("core.quotepath", "false"),
            ("color.ui", "false"),
            ("diff.noprefix", "false"),
            ("diff.srcprefix", "a/"),
            ("diff.dstprefix", "b/"),
            ("diff.mnemonicprefix", "false"),
        ] {
            let out = run_git(Some(&repo), &["config", "--get", key], TEST_GIT_HANG_GUARD)
                .await
                .unwrap_or_else(|e| panic!("read {key}: {e}"));
            assert_eq!(out.stdout_lossy().trim(), want, "{key}");
        }
    }

    /// The prefix pins reach a real `git diff`: a repo whose own config asks for
    /// `diff.noprefix`, `diff.mnemonicPrefix` and custom prefixes still gets `a/` `b/`
    /// headers, which every section-keying parser downstream assumes. Unpinned, the
    /// same repo prints `diff --git x x` (measured, git 2.51.1).
    #[tokio::test]
    async fn diff_headers_keep_literal_prefixes_against_repo_config() {
        let dir = tempfile::Builder::new()
            .prefix("gd-runner-prefix-")
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        let git = |args: &'static [&'static str]| {
            let repo = repo.clone();
            async move {
                run_git(Some(&repo), args, TEST_GIT_HANG_GUARD)
                    .await
                    .unwrap_or_else(|e| panic!("git {args:?}: {e}"))
                    .stdout_lossy()
            }
        };
        git(&["init", "-q"]).await;
        git(&["config", "user.email", "t@t.local"]).await;
        git(&["config", "user.name", "T"]).await;
        std::fs::write(dir.path().join("x"), "one\n").unwrap();
        git(&["add", "x"]).await;
        git(&["commit", "-qm", "seed"]).await;
        git(&["config", "diff.noprefix", "true"]).await;
        git(&["config", "diff.mnemonicPrefix", "true"]).await;
        git(&["config", "diff.srcPrefix", "SRC/"]).await;
        git(&["config", "diff.dstPrefix", "DST/"]).await;
        std::fs::write(dir.path().join("x"), "two\n").unwrap();

        let first_line = |text: String| text.lines().next().unwrap_or_default().to_string();
        assert_eq!(first_line(git(&["diff"]).await), "diff --git a/x b/x");
        assert_eq!(
            first_line(git(&["diff", "HEAD"]).await),
            "diff --git a/x b/x"
        );

        // mnemonicPrefix OUTRANKS srcPrefix/dstPrefix whatever the `-c` order, so
        // its own pin is required (measured, git 2.51.1): re-enabled after the
        // runner's block, it wins over the still-pinned `a/` `b/`.
        assert_eq!(
            first_line(git(&["-c", "diff.mnemonicPrefix=true", "diff"]).await),
            "diff --git i/x w/x"
        );
    }

    /// A fixture home whose global config, default ignore and default attributes
    /// each have a rule the fixture repo's files match.
    struct GlobalFixture {
        _dir: tempfile::TempDir,
        home: String,
        gitconfig: String,
        repo: String,
    }

    async fn global_fixture() -> GlobalFixture {
        let dir = tempfile::Builder::new()
            .prefix("gd-runner-global-")
            .tempdir()
            .expect("create temp dir");
        let home = dir.path().join("home");
        let xdg_git = home.join(".config").join("git");
        std::fs::create_dir_all(&xdg_git).unwrap();
        let gitconfig = home.join(".gitconfig");
        std::fs::write(&gitconfig, "[gdfixture]\n\tpoison = global\n").unwrap();
        std::fs::write(xdg_git.join("ignore"), "ignored.txt\n").unwrap();
        std::fs::write(xdg_git.join("attributes"), "attr.txt gdattr\n").unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        std::fs::write(repo.join("ignored.txt"), "x\n").unwrap();
        std::fs::write(repo.join("attr.txt"), "x\n").unwrap();
        let repo = repo.to_string_lossy().into_owned();
        run_git(Some(&repo), &["init", "-q"], TEST_GIT_HANG_GUARD)
            .await
            .expect("init");
        GlobalFixture {
            _dir: dir,
            home: home.to_string_lossy().into_owned(),
            gitconfig: gitconfig.to_string_lossy().into_owned(),
            repo,
        }
    }

    const POISON_READ: [&str; 3] = ["config", "--get", "gdfixture.poison"];
    const UNTRACKED: [&str; 3] = ["ls-files", "--others", "--exclude-standard"];
    const ATTR_READ: [&str; 4] = ["check-attr", "gdattr", "--", "attr.txt"];

    /// Pins `TEST_GIT_ENV`: through the runner a home's global config, default ignore
    /// and default attributes are all invisible; the same home is visible to a git
    /// spawned without the seam, and a caller's own `GIT_CONFIG_GLOBAL` still wins.
    #[tokio::test]
    async fn the_test_env_hides_global_and_default_xdg_config() {
        let fx = global_fixture().await;
        let home_env = [
            ("HOME", fx.home.as_str()),
            ("USERPROFILE", fx.home.as_str()),
        ];
        let runner = |args: &'static [&'static str]| {
            let repo = fx.repo.clone();
            async move {
                run_git_raw_env(Some(&repo), args, &home_env, TEST_GIT_HANG_GUARD)
                    .await
                    .unwrap_or_else(|e| panic!("git {args:?}: {e}"))
            }
        };

        let poison = runner(&POISON_READ).await;
        assert_eq!(
            (poison.code, poison.stdout_lossy()),
            (1, String::new()),
            "the global config reached the runner"
        );
        let untracked = runner(&UNTRACKED).await.stdout_lossy();
        assert!(
            untracked.lines().any(|l| l == "ignored.txt"),
            "the default global ignore reached the runner: {untracked:?}"
        );
        let attr = runner(&ATTR_READ).await.stdout_lossy();
        assert_eq!(
            attr.trim(),
            "attr.txt: gdattr: unspecified",
            "the default global attributes reached the runner"
        );

        // The fixture is live: without the seam (the NOSYSTEM pair kept, so a system
        // excludesFile or attributesFile cannot mask it) git reads all three rules.
        let git = git_bin().await.expect("resolve git");
        let direct = |args: &'static [&'static str]| {
            let mut cmd = Command::new(&git);
            cmd.args(args)
                .current_dir(&fx.repo)
                .envs(home_env)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_ATTR_NOSYSTEM", "1")
                .env_remove("GIT_CONFIG_GLOBAL")
                .env_remove("XDG_CONFIG_HOME")
                .stdin(Stdio::null());
            async move { cmd.output().await.expect("spawn git") }
        };
        let poison = direct(&POISON_READ).await;
        assert_eq!(String::from_utf8_lossy(&poison.stdout).trim(), "global");
        let untracked = direct(&UNTRACKED).await;
        let untracked = String::from_utf8_lossy(&untracked.stdout);
        assert!(
            !untracked.lines().any(|l| l == "ignored.txt") && untracked.contains("attr.txt"),
            "{untracked:?}"
        );
        let attr = direct(&ATTR_READ).await;
        assert_eq!(
            String::from_utf8_lossy(&attr.stdout).trim(),
            "attr.txt: gdattr: set"
        );

        // A caller's own pair is applied after the seam's and wins.
        let own = [
            ("HOME", fx.home.as_str()),
            ("USERPROFILE", fx.home.as_str()),
            ("GIT_CONFIG_GLOBAL", fx.gitconfig.as_str()),
        ];
        let poison = run_git_raw_env(Some(&fx.repo), &POISON_READ, &own, TEST_GIT_HANG_GUARD)
            .await
            .expect("read with a caller GIT_CONFIG_GLOBAL");
        assert_eq!(
            poison.stdout_lossy().trim(),
            "global",
            "a caller's GIT_CONFIG_GLOBAL lost to the seam"
        );
    }

    /// The refusal's parse over argv and env shapes; no git is spawned.
    #[test]
    fn the_global_write_check_reads_the_config_subcommand_only() {
        let own = [("GIT_CONFIG_GLOBAL", "own.config")];
        let lower = [("git_config_global", "own.config")];
        let null = [("GIT_CONFIG_GLOBAL", "/dev/null")];
        // (argv, caller env, whether it writes the global file)
        type Row<'a> = (&'a [&'a str], &'a [(&'a str, &'a str)], bool);
        let table: [Row; 31] = [
            (&["config", "--global", "gd.fixture", "1"], &[], true),
            (
                &["config", "--global", "init.defaultBranch", "list"],
                &[],
                true,
            ),
            (&["config", "--global", "gd.fixture", "get"], &[], true),
            // After a leading option a subcommand word is an old-style key or section.
            (&["config", "--global", "--unset", "get"], &[], true),
            (
                &["config", "--global", "--remove-section", "get"],
                &[],
                true,
            ),
            (
                &["config", "--global", "--rename-section", "get", "got"],
                &[],
                true,
            ),
            (
                &["config", "--type", "bool", "--global", "k", "v"],
                &[],
                true,
            ),
            (
                &["config", "--type", "bool", "--global", "--get", "k"],
                &[],
                false,
            ),
            (
                &["config", "set", "--type", "bool", "--global", "k", "v"],
                &[],
                true,
            ),
            // git refuses two file options and writes nothing, so refusing it here is free.
            (&["config", "--file", "x", "--global", "k", "v"], &[], true),
            (&["config", "--global", "user.name", "--get"], &[], true),
            (
                &["config", "set", "--global", "user.name", "--list"],
                &[],
                true,
            ),
            (&["config", "--global", "--", "k", "--get"], &[], true),
            (
                &["--git-dir", ".git", "config", "set", "--global", "k", "v"],
                &[],
                true,
            ),
            (
                &["--namespace", "config", "config", "--global", "k", "v"],
                &[],
                true,
            ),
            (&["config", "--glob", "k", "v"], &[], true),
            (&["config", "--g", "k", "v"], &[], false),
            (&["config", "user.name", "--global"], &[], false),
            (&["config", "set", "user.name", "--global"], &[], false),
            (&["config", "--global", "--get", "k"], &[], false),
            (&["config", "--global", "gd.fixture", "1"], &null, true),
            (&["add", "--", "config", "--global"], &[], false),
            (
                &["-c", "k=v", "config", "--global", "--get", "x"],
                &[],
                false,
            ),
            (&["-C", "config", "add", "config", "--global"], &[], false),
            (&["config", "get", "--global", "k"], &[], false),
            (&["config", "list", "--global"], &[], false),
            (&["config", "--global", "-l"], &[], false),
            (
                &["config", "--global", "--type=bool", "--get", "x"],
                &[],
                false,
            ),
            (&["config", "user.name", "x"], &[], false),
            (&["config", "--global", "gd.fixture", "1"], &own, false),
            (
                &["config", "--global", "gd.fixture", "1"],
                &lower,
                !cfg!(windows),
            ),
        ];
        for (args, envs, writes) in table {
            assert_eq!(
                writes_global_config(args, envs),
                writes,
                "{args:?} {envs:?}"
            );
        }
    }

    #[tokio::test]
    #[should_panic(expected = "tests never write the global git config through the runner")]
    async fn a_global_config_write_is_refused_in_tests() {
        // Harmless if the refusal regresses: unsetting a missing key never replaces the file.
        let _ = run_git(
            None,
            &["config", "--global", "--unset", "gd.fixture-never-set"],
            TEST_GIT_HANG_GUARD,
        )
        .await;
    }

    /// The refusal's companion: a global read and a write to a caller-owned global
    /// file both still run.
    #[tokio::test]
    async fn a_global_read_and_a_caller_owned_global_write_still_run() {
        let dir = tempfile::Builder::new()
            .prefix("gd-runner-global-")
            .tempdir()
            .expect("create temp dir");
        let cwd = dir.path().to_string_lossy().into_owned();
        let read = run_git_raw(
            Some(&cwd),
            &["config", "--global", "--get", "gd.fixture"],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .expect("global read");
        assert_eq!((read.code, read.stdout_lossy()), (1, String::new()));

        let file = dir.path().join("global.config");
        std::fs::write(&file, "").unwrap();
        let file_str = file.to_string_lossy().into_owned();
        let write = run_git_raw_env(
            Some(&cwd),
            &["config", "--global", "gd.fixture", "1"],
            &[("GIT_CONFIG_GLOBAL", file_str.as_str())],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .expect("caller-owned global write");
        assert_eq!(write.code, 0, "{}", write.stderr);
        let text = std::fs::read_to_string(&file).unwrap();
        assert!(text.contains("fixture = 1"), "{text:?}");
    }
}

#[cfg(test)]
mod config_write_lock_tests {
    use super::*;

    async fn git(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, TEST_GIT_HANG_GUARD)
            .await
            .unwrap_or_else(|e| panic!("git {args:?}: {e}"))
            .stdout_lossy()
    }

    async fn seeded_repo(tag: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-runner-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo = repo.to_string_lossy().into_owned();
        git(&repo, &["init", "-q"]).await;
        git(&repo, &["config", "user.email", "t@t.local"]).await;
        git(&repo, &["config", "user.name", "T"]).await;
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "seed"]).await;
        (dir, repo)
    }

    async fn config_value(repo: &str, key: &str) -> String {
        git(repo, &["config", "--get", key])
            .await
            .trim()
            .to_string()
    }

    /// Every checkout of one repository writes the same `.git/config`, so a linked
    /// worktree lands on the main checkout's mutex and another repository on its own.
    #[tokio::test]
    async fn config_writers_share_one_mutex_per_repository() {
        let (dir, repo) = seeded_repo("cfg-mutex-key").await;
        let wt = dir.path().join("wt").to_string_lossy().into_owned();
        git(&repo, &["worktree", "add", "-q", "-b", "side", &wt, "HEAD"]).await;
        let (_other_dir, other) = seeded_repo("cfg-mutex-other").await;

        let main = config_write_lock(&repo).await;
        assert!(Arc::ptr_eq(&main, &config_write_lock(&wt).await));
        assert!(!Arc::ptr_eq(&main, &config_write_lock(&other).await));
    }

    /// A config-only writer takes the mutex alone: a held working-tree domain never
    /// delays it. The bound only turns a regression's hang into a failure.
    #[tokio::test]
    async fn a_config_only_write_never_waits_on_the_working_tree_domain() {
        let state = AppState::default();
        let (_dir, repo) = seeded_repo("cfg-no-domain").await;
        let domain = state.working_tree_lock(&repo).await;
        let _held = acquire_repo_lock(&domain, Duration::ZERO, "a commit")
            .await
            .expect("the domain is free");

        let out = tokio::time::timeout(
            Duration::from_secs(60),
            run_git_config_write(&repo, &["config", "gd.probe", "1"], DEFAULT_TIMEOUT),
        )
        .await
        .expect("a config-only write is not queued behind the domain")
        .expect("the write runs");
        assert_eq!(out.code, 0, "{}", out.stderr);
    }

    /// Mutual exclusion, pinned by event order rather than timing. On a current-thread
    /// runtime a writer runs uninterrupted from its "waiting" event to its next await,
    /// so it could log "acquired" ahead of the test's "released" only if the mutex
    /// never parked it. Both writer kinds, the domain-holding one included.
    #[tokio::test(flavor = "current_thread")]
    async fn a_held_config_mutex_parks_every_writer_until_released() {
        let state = Arc::new(AppState::default());
        let (_dir, repo) = seeded_repo("cfg-mutex-exclusion").await;
        for mutating in [false, true] {
            let blocker = config_write_lock(&repo).await.lock_owned().await;
            let log = Arc::new(std::sync::Mutex::new(Vec::<&'static str>::new()));
            let (tx, rx) = tokio::sync::oneshot::channel::<()>();
            let tx = std::sync::Mutex::new(Some(tx));
            let events: Arc<dyn Fn(&'static str) + Send + Sync> = {
                let log = Arc::clone(&log);
                Arc::new(move |event| {
                    log.lock().unwrap().push(event);
                    if event == "waiting" {
                        if let Some(tx) = tx.lock().unwrap().take() {
                            let _ = tx.send(());
                        }
                    }
                })
            };
            let (state_w, repo_w) = (Arc::clone(&state), repo.clone());
            let writer = tokio::spawn(CONFIG_WRITE_LOCK_EVENTS.scope(events, async move {
                let args = ["config", "gd.exclusive", "1"];
                if mutating {
                    run_git_mutating_config_write(
                        &state_w,
                        &repo_w,
                        &args,
                        DEFAULT_TIMEOUT,
                        |out, _| async move { Ok(out) },
                    )
                    .await
                } else {
                    run_git_config_write(&repo_w, &args, DEFAULT_TIMEOUT).await
                }
            }));

            rx.await.expect("the writer reached the mutex");
            log.lock().unwrap().push("released");
            drop(blocker);
            let out = tokio::time::timeout(Duration::from_secs(60), writer)
                .await
                .expect("the writer finishes once released")
                .unwrap()
                .expect("the write runs");
            assert_eq!(out.code, 0, "{}", out.stderr);
            assert_eq!(
                *log.lock().unwrap(),
                ["waiting", "released", "acquired", "freed"],
                "mutating writer: {mutating}"
            );
        }
    }

    /// Lock order is domain, then mutex. A mutating config write parked on the
    /// mutex WHILE holding the domain, and a config-only write queued on the same
    /// mutex, both finish once it frees: the wait graph has no cycle. Exclusion
    /// itself is pinned by the event-order test above.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_mutating_and_a_plain_config_write_overlap_without_deadlock() {
        let state = Arc::new(AppState::default());
        let (_dir, repo) = seeded_repo("cfg-lock-order").await;
        let blocker = config_write_lock(&repo).await.lock_owned().await;

        let mutating = tokio::spawn({
            let (state, repo) = (Arc::clone(&state), repo.clone());
            async move {
                run_git_mutating_config_write(
                    &state,
                    &repo,
                    &["config", "gd.mutating", "1"],
                    DEFAULT_TIMEOUT,
                    |out, _| async move { Ok(out) },
                )
                .await
            }
        });
        // Parked holding the domain: its holder label is published only while held.
        let domain = state.working_tree_lock(&repo).await;
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while domain.holder_label().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the mutating write never took the domain"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let plain = tokio::spawn({
            let repo = repo.clone();
            async move {
                run_git_config_write(&repo, &["config", "gd.plain", "1"], DEFAULT_TIMEOUT).await
            }
        });

        drop(blocker);
        let bound = Duration::from_secs(60);
        tokio::time::timeout(bound, mutating)
            .await
            .expect("no deadlock")
            .unwrap()
            .expect("the mutating write lands");
        let out = tokio::time::timeout(bound, plain)
            .await
            .expect("no deadlock")
            .unwrap()
            .expect("the plain write runs");
        assert_eq!(out.code, 0, "{}", out.stderr);
        assert_eq!(config_value(&repo, "gd.mutating").await, "1");
        assert_eq!(config_value(&repo, "gd.plain").await, "1");
        assert_eq!(domain.holder_label(), None, "and the domain is released");
    }
}

#[cfg(test)]
mod tree_kill_tests {
    use super::*;
    use crate::proc_tree::test_support::{wait_until, Holder, HostShell, Keeps, HANG_GUARD};
    use std::path::{Path, PathBuf};

    const COMMIT: &[&str] = &["commit", "--allow-empty", "-m", "x"];

    /// A repo whose pre-commit hook the test writes, plus the files the hook waits
    /// on. The gate and hold files sit beside the holder's directory, never in it
    /// (its names are reserved).
    struct HookRepo {
        repo: String,
        gate: PathBuf,
        hold: PathBuf,
        holder_dir: PathBuf,
    }

    /// Fixture steps run through the runner, with a LOCAL identity so the commit
    /// never depends on a global one.
    async fn hook_repo(dir: &Path) -> HookRepo {
        let repo = dir.join("repo");
        let holder_dir = dir.join("hold");
        std::fs::create_dir(&repo).expect("create the repo dir");
        std::fs::create_dir(&holder_dir).expect("create the holder dir");
        let repo = repo.to_string_lossy().into_owned();
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "t@t.local"],
            &["config", "user.name", "T"],
        ] {
            run_git(Some(&repo), args, TEST_GIT_HANG_GUARD)
                .await
                .unwrap_or_else(|e| panic!("git {args:?}: {e}"));
        }
        HookRepo {
            repo,
            gate: dir.join("gate.flag"),
            hold: dir.join("hook.hold"),
            holder_dir,
        }
    }

    /// Single-quotes `path` for sh, an apostrophe as `'\''`. Git for Windows' sh reads
    /// the path in its own builtins, so it gets forward slashes there.
    fn sh_path(path: &Path) -> String {
        let text = path.display().to_string();
        #[cfg(windows)]
        let text = text.replace('\\', "/");
        format!("'{}'", text.replace('\'', r"'\''"))
    }

    /// Waits while the gate file is absent. Every loop below steps with a real delay
    /// and stops after 18000 passes (at least 15 minutes): a leak cap, never a time
    /// anything waits for.
    fn gate_loop(gate: &Path) -> String {
        format!(
            "i=0; while [ ! -e {} ] && [ \"$i\" -lt 18000 ]; do sleep 0.05; i=$((i+1)); done",
            sh_path(gate)
        )
    }

    /// Waits while the hold file exists.
    fn hold_loop(hold: &Path) -> String {
        format!(
            "i=0; while [ -e {} ] && [ \"$i\" -lt 18000 ]; do sleep 0.05; i=$((i+1)); done",
            sh_path(hold)
        )
    }

    fn write_hook(repo: &str, lines: &[String]) {
        let hooks = Path::new(repo).join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).expect("create the hooks dir");
        let hook = hooks.join("pre-commit");
        std::fs::write(&hook, format!("#!/bin/sh\n{}\n", lines.join("\n"))).expect("write hook");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755))
                .expect("make the hook executable");
        }
    }

    /// Creates the hold file; removing it on drop lets a failed test's hook exit.
    struct HoldFile(PathBuf);

    impl HoldFile {
        fn create(path: &Path) -> Self {
            std::fs::write(path, "").expect("create the hold file");
            Self(path.to_path_buf())
        }
    }

    impl Drop for HoldFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    fn open_gate(gate: &Path) {
        std::fs::write(gate, "").expect("open the gate");
    }

    /// Deletes the temp dir while still owning it, then drops it. On Windows the delete
    /// fails while a process has a file or its working directory there, so a stuck
    /// process reads as a red; elsewhere it is a plain delete.
    fn remove_when_free(dir: tempfile::TempDir) {
        let removed = wait_until(
            || match std::fs::remove_dir_all(dir.path()) {
                Ok(()) => true,
                Err(e) => e.kind() == std::io::ErrorKind::NotFound,
            },
            HANG_GUARD,
        );
        assert!(removed, "{} stayed in use", dir.path().display());
    }

    fn describe(result: &AppResult<GitOutput>) -> String {
        match result {
            Ok(out) => format!("exit {}: {}", out.code, out.stderr),
            Err(e) => format!("{e:?}"),
        }
    }

    /// A timed-out git takes its whole process tree down: the hook's holder dies
    /// when the run's future is dropped, which is all a timeout does. The test drives
    /// that drop itself once the holder has started, so no budget races startup.
    /// On Windows the armed process can be the `cmd\git.exe` shim (`git_bin` follows
    /// PATH), and the gate holds neither the real git nor the hook's sh: the verdict
    /// there rests on the accepted assign-after-spawn race, a lost race reading as a
    /// red at the ceiling. The gate opens right after the run's first poll, so it still
    /// holds the hook's first child until then.
    #[tokio::test]
    async fn a_timed_out_git_takes_its_hook_down_with_it() {
        let dir = tempfile::Builder::new()
            .prefix("gd-runner- q ")
            .tempdir()
            .expect("create temp dir");
        let fx = hook_repo(dir.path()).await;
        let holder = Holder::new(&fx.holder_dir);
        write_hook(
            &fx.repo,
            &[
                gate_loop(&fx.gate),
                holder.launch_snippet(HostShell::Sh, Keeps::Both),
                hold_loop(&fx.hold),
            ],
        );
        let hold = HoldFile::create(&fx.hold);

        let mut run = Box::pin(run_git(Some(&fx.repo), COMMIT, TEST_GIT_HANG_GUARD));
        let started = async {
            open_gate(&fx.gate);
            let deadline = tokio::time::Instant::now() + HANG_GUARD;
            while !holder.started() {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the hook's holder never started"
                );
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };
        tokio::select! {
            biased;
            result = &mut run => panic!("the commit settled under its hook: {}", describe(&result)),
            () = started => {}
        }
        drop(run);
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the hook's holder outlived the abandoned run"
        );
        drop(hold);
        remove_when_free(dir);
    }

    /// The committed control for the test above: the same hook under a git killed
    /// directly, with no tree guard, leaves the holder running. On Windows the killed
    /// child can be the `cmd\git.exe` shim, whose real git finishes the commit once
    /// the hold file goes; the temp dir comes free only when that git has exited.
    #[tokio::test]
    async fn a_directly_killed_git_leaves_its_hook_running() {
        let dir = tempfile::Builder::new()
            .prefix("gd-runner-direct-")
            .tempdir()
            .expect("create temp dir");
        let fx = hook_repo(dir.path()).await;
        let holder = Holder::new(&fx.holder_dir);
        write_hook(
            &fx.repo,
            &[
                gate_loop(&fx.gate),
                holder.launch_snippet(HostShell::Sh, Keeps::Both),
                hold_loop(&fx.hold),
            ],
        );
        let hold = HoldFile::create(&fx.hold);

        let mut cmd = Command::new(git_bin().await.expect("resolve git"));
        cmd.args(COMMIT)
            .current_dir(&fx.repo)
            .envs(TEST_GIT_ENV)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().expect("spawn git");
        open_gate(&fx.gate);
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the hook's holder never started"
        );
        child.start_kill().expect("kill git");
        child.wait().await.expect("reap git");
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the holder died with a git killed alone"
        );

        drop(hold);
        holder.release();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the released holder never exited"
        );
        remove_when_free(dir);
    }

    /// The Timeout mapping: a hook that blocks until released outlasts any budget, so
    /// the error kind is the only thing asserted.
    #[tokio::test]
    async fn an_elapsed_budget_maps_to_timeout() {
        let dir = tempfile::Builder::new()
            .prefix("gd-runner-budget-")
            .tempdir()
            .expect("create temp dir");
        let fx = hook_repo(dir.path()).await;
        write_hook(&fx.repo, &[gate_loop(&fx.gate), hold_loop(&fx.hold)]);
        let hold = HoldFile::create(&fx.hold);

        // join! polls the run first, so git is spawned and armed before the gate opens.
        let (result, ()) = tokio::join!(
            run_git(Some(&fx.repo), COMMIT, Duration::from_secs(1)),
            async { open_gate(&fx.gate) },
        );
        assert!(
            matches!(result, Err(AppError::Timeout(1))),
            "{}",
            describe(&result)
        );
        drop(hold);
        remove_when_free(dir);
    }

    /// A reaped git disarms its guard, so a descendant it left behind on purpose
    /// (git's detached helpers) keeps running after the call returns.
    #[tokio::test]
    async fn a_reaped_git_leaves_a_detached_descendant_running() {
        let dir = tempfile::Builder::new()
            .prefix("gd-runner-detached-")
            .tempdir()
            .expect("create temp dir");
        let fx = hook_repo(dir.path()).await;
        let holder = Holder::new(&fx.holder_dir);
        write_hook(
            &fx.repo,
            &[
                gate_loop(&fx.gate),
                holder.launch_snippet(HostShell::Sh, Keeps::Neither),
                "exit 0".to_string(),
            ],
        );

        let (result, ()) = tokio::join!(
            run_git(Some(&fx.repo), COMMIT, TEST_GIT_HANG_GUARD),
            async { open_gate(&fx.gate) },
        );
        if let Err(e) = result {
            panic!("the commit returns once its hook exits: {e:?}");
        }
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the hook's holder never started"
        );
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the holder died with the reaped git"
        );
        holder.release();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the released holder never exited"
        );
        remove_when_free(dir);
    }
}
