use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::OnceCell;

use crate::error::{AppError, AppResult};
use crate::state::{AppState, HolderSlot, LockDomain};

pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
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
        // The one `submodule` argv reaching this runner is `submodule update`
        // (git::submodule's other paths hold the lock themselves and label it).
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
/// `run_git_raw_input` is the base of the whole git call stack (status, diffs,
/// history, staging — all firing continuously as the user works), and a packaged
/// GUI app on macOS doesn't inherit the user's shell PATH. So we resolve `git`
/// the way the About screen does (`crate::agent::resolve_named`: PATH + known
/// install dirs + a macOS login-shell fallback / the live Windows registry PATH)
/// rather than a bare `Command::new("git")`, which finds nothing when the app is
/// launched from Finder/Dock.
///
/// The result is cached because resolving isn't free: the login-shell fallback
/// (for a git install outside `candidate_dirs()`, e.g. MacPorts `/opt/local/bin`)
/// spawns `$SHELL -lic` with a 20s timeout, and re-running it on every git call
/// would serialize the whole app behind it. Only a *successful* resolution is
/// cached — `get_or_try_init` leaves the cell empty on error — so a git installed
/// after launch is still picked up on the next call without a restart.
static GIT_BIN: OnceCell<PathBuf> = OnceCell::const_new();

async fn git_bin() -> AppResult<PathBuf> {
    GIT_BIN
        .get_or_try_init(|| async {
            crate::agent::resolve_named(&["git"], None)
                .await
                .ok_or(AppError::GitNotFound)
        })
        .await
        .cloned()
}

/// A Windows Job Object holding a spawned git process, armed so that closing the
/// last handle kills everything still in it.
///
/// `kill_on_drop` only reaps the process we spawned, and on Windows that is
/// usually `cmd\git.exe` — the Git-for-Windows SHIM, which runs the real
/// `mingw64\bin\git.exe` as a child. Killing the shim on timeout therefore leaves
/// the real git running as an orphan, still deleting/mutating the repo long after
/// the app reported failure and released the per-repo lock.
#[cfg(windows)]
struct GitJob(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: a job-object HANDLE is a process-wide kernel handle with no thread
// affinity, and the raw pointer is only ever handed back to Win32. The wrapper
// exists so the guard can be held across awaits inside a `Send` future.
#[cfg(windows)]
unsafe impl Send for GitJob {}

#[cfg(windows)]
impl GitJob {
    /// Puts `process` in a fresh kill-on-close job. `None` on any Win32 failure —
    /// the caller then degrades to plain `kill_on_drop` rather than failing the
    /// git call over a missing safety net.
    ///
    /// Processes the child spawns before the assignment lands don't join the job.
    /// Assignment is two syscalls issued immediately after spawn while the shim has
    /// yet to start the real git, so losing that race should take a pathological
    /// scheduling delay — and `kill_on_drop` still covers the direct child anyway.
    fn arm(process: std::os::windows::io::RawHandle) -> Option<Self> {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        // SAFETY: null attributes + null name is the documented way to create an
        // unnamed job with default security; it returns null on failure.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return None;
        }
        // Owned from here so every early return closes the handle.
        let job = GitJob(handle);
        if !job.set_limit_flags(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) {
            return None;
        }
        // SAFETY: `job.0` is the handle we just created and `process` is the live
        // child's handle, valid for as long as the caller holds the `Child`.
        if unsafe { AssignProcessToJobObject(job.0, process) } == 0 {
            return None;
        }
        Some(job)
    }

    /// Consumes the guard, clearing the kill-on-close limit before its handle is
    /// closed. git can leave legitimately detached descendants behind a command that
    /// SUCCEEDED (a background `gc --auto`), and those must outlive the guard. Only a
    /// REAPED command disarms: every abandoned path — a timeout, a failed stdin
    /// write, a failed wait — drops the guard still armed and takes the tree with it.
    ///
    /// A failure to clear leaks the handle instead of closing it: the kernel
    /// reclaims it at process exit, whereas closing a still-armed job would kill
    /// those descendants.
    fn disarm(self) {
        if !self.set_limit_flags(0) {
            std::mem::forget(self);
        }
    }

    fn set_limit_flags(&self, flags: u32) -> bool {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        };

        // SAFETY: the struct is plain old data, so an all-zero value is a valid
        // (limit-free) instance.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = flags;
        // SAFETY: `self.0` is a valid job handle and the pointer/length pair
        // describes the fully-initialized `info` living on this stack frame.
        unsafe {
            SetInformationJobObject(
                self.0,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
        }
    }
}

#[cfg(windows)]
impl Drop for GitJob {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a handle this type created and owns exclusively.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
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
    // A zero budget refuses before spawning — no production caller passes one (they
    // all use a *_TIMEOUT constant), and it makes the tests' `Duration::ZERO` seam
    // deterministic: a nonzero expired budget loses the race to a fast child (Linux).
    if timeout.is_zero() {
        return Err(AppError::Timeout(0));
    }
    let git = git_bin().await?;
    let mut cmd = Command::new(&git);
    // Also covers the credential helpers git spawns in turn.
    crate::agent::sanitize_child_env(&mut cmd);
    // Git for Windows gates long-path support on core.longpaths — the OS
    // LongPathsEnabled flag alone is not enough (probe-proven). Per-invocation so
    // the user's own git config is never mutated; other platforms ignore the key.
    cmd.args([
        "-c",
        "core.quotePath=false",
        "-c",
        "color.ui=false",
        "-c",
        "core.longpaths=true",
    ]);
    cmd.args(args);
    if let Some(repo) = repo_path {
        cmd.current_dir(repo);
    }
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C");
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
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
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let mut child = cmd.spawn().map_err(spawn_err)?;
        #[cfg(windows)]
        let job = child.raw_handle().and_then(GitJob::arm);

        // git interleaves reading stdin with writing stdout, so the write and both
        // drains have to run CONCURRENTLY: writing all of stdin first wedges as soon
        // as git's output fills its pipe buffer — git stops reading, our write
        // blocks behind it, and the whole exchange dies on the timeout below.
        // Local futures rather than `tokio::spawn`, because `input` is borrowed and
        // a `'static` copy would clone a multi-MB patch on every hunk stage.
        let stdin_pipe = child.stdin.take();
        let mut stdout_pipe = child.stdout.take().expect("stdout was piped");
        let mut stderr_pipe = child.stderr.take().expect("stderr was piped");
        let write = async move {
            let (Some(mut pipe), Some(text)) = (stdin_pipe, input) else {
                return Ok(());
            };
            let written = pipe.write_all(text.as_bytes()).await;
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
        let (written, stdout, stderr) = tokio::join!(write, drain_stdout, drain_stderr);

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
            // Abandoned without a reaped child, so the job stays ARMED (see `disarm`).
            Err(e) => return Err(AppError::Io(written.err().unwrap_or(e))),
        };
        #[cfg(windows)]
        if let Some(job) = job {
            job.disarm();
        }
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
    let out = run_git_raw_input(repo_path, args, input, timeout).await?;
    if out.code != 0 {
        return Err(AppError::Git {
            code: out.code,
            stderr: out.stderr,
        });
    }
    Ok(out)
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
/// `remote::run_git_with_creds_once`), accepting the loss of the retry above.
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

    /// Both sides have to clear the point where a write-then-read runner wedges,
    /// and that point is platform-specific: on unix the stdin write blocks once the
    /// 64KB pipe buffer fills, while on Windows tokio absorbs the first
    /// `DEFAULT_MAX_BUF_SIZE` (2 MiB, measured against tokio 1.53) into its
    /// `Blocking` wrapper before the write can stall at all. 50k paths of 100 bytes
    /// send ~4.8 MiB and draw ~5.5 MiB back (four NUL-joined tokens per match, 15
    /// bytes of them fixed), which clears both by a wide margin.
    const PATH_COUNT: usize = 50_000;
    const PAD: usize = 80;

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
        run_git(Some(&repo), &["init", "-q"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        // `*` in the repo's own `.gitignore` outranks any global excludes the
        // machine happens to carry, so every path matches this one rule.
        std::fs::write(dir.path().join(".gitignore"), "*\n").unwrap();

        // One directory, long names: the bytes come from the filename so git has a
        // single parent to look for nested ignore files in.
        let pad = "f".repeat(PAD);
        let paths: Vec<String> = (0..PATH_COUNT)
            .map(|i| format!("generated/{pad}{i:06}.bin"))
            .collect();
        let input: String = paths.iter().map(|p| format!("{p}\0")).collect();
        assert!(
            input.len() > 4 * 1024 * 1024,
            "stdin must outrun tokio's 2 MiB Windows write buffer, got {} bytes",
            input.len()
        );

        // The deadlock can only present as a timeout, so any explicit bound keeps
        // a regression finite; 30s leaves ~10x headroom for slow contended CI
        // runners (measured ~0.8s idle on a 32-thread dev machine).
        let out = run_git_raw_input(
            Some(&repo),
            &["check-ignore", "--verbose", "-z", "--stdin"],
            Some(&input),
            Duration::from_secs(30),
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
        run_git(Some(&repo), &["init", "-q"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        // `-c` is the command-line scope, which outranks the machine's own
        // system/global/local config — so this holds on any dev box.
        for (key, want) in [
            ("core.longpaths", "true"),
            ("core.quotepath", "false"),
            ("color.ui", "false"),
        ] {
            let out = run_git(Some(&repo), &["config", "--get", key], DEFAULT_TIMEOUT)
                .await
                .unwrap_or_else(|e| panic!("read {key}: {e}"));
            assert_eq!(out.stdout_lossy().trim(), want, "{key}");
        }
    }
}

#[cfg(all(test, windows))]
mod job_tests {
    use super::GitJob;
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::path::{Path, PathBuf};

    /// How long the grandchild holds its lock. Bounds the whole fixture: even a
    /// failing assertion can only leave a process around for this long.
    const HOLD_SECS: u32 = 10;

    /// A `cmd.exe` parent whose PowerShell GRANDCHILD opens a file with no sharing.
    /// "Is the grandchild alive?" is then answerable by trying to open that file —
    /// an observable scoped to this test, unlike a process-name search, which also
    /// matches the prober and other sessions' processes.
    fn spawn_locking_tree(dir: &Path) -> (std::process::Child, PathBuf) {
        let lock = dir.join("held.lock");
        let script = dir.join("hold.ps1");
        // PowerShell escapes a single quote inside a single-quoted string by doubling
        // it; an apostrophe in the temp path (a `C:\Users\O'Brien` profile) would
        // otherwise close the literal and fail the test for the wrong reason.
        let quoted = lock.display().to_string().replace('\'', "''");
        std::fs::write(
            &script,
            format!(
                "$f=[IO.File]::Open('{quoted}','OpenOrCreate','ReadWrite','None')\n\
                 Start-Sleep -Seconds {HOLD_SECS}\n\
                 $f.Close()\n"
            ),
        )
        .expect("write the holder script");
        // A delay in front of the launch puts the grandchild strictly AFTER `arm()`,
        // so neither test races the assignment. `ping` rather than `timeout`, which
        // this fixture's null stdin breaks; and ONE raw argument, because std's
        // quoting would escape the `&` that chains the two commands.
        let command = format!(
            "ping -n 2 127.0.0.1 >nul & powershell -NoProfile -NonInteractive \
             -ExecutionPolicy Bypass -File \"{}\"",
            script.display()
        );
        let child = std::process::Command::new("cmd.exe")
            .arg("/c")
            .raw_arg(&command)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn the locking tree");
        (child, lock)
    }

    /// Whether someone still holds the lock file exclusively. A file that doesn't
    /// exist yet counts as unheld — the grandchild hasn't reached the open.
    fn lock_held(lock: &Path) -> bool {
        match std::fs::OpenOptions::new().write(true).open(lock) {
            Ok(_) => false,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => true,
        }
    }

    fn wait_until(mut cond: impl FnMut() -> bool, secs: u64) -> bool {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(secs);
        while std::time::Instant::now() < deadline {
            if cond() {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        cond()
    }

    /// Closing an ARMED job kills descendants the direct child spawned — the
    /// behavior a timed-out `git` needs, since the Git-for-Windows shim runs the
    /// real git as a child of its own.
    #[test]
    fn armed_job_close_kills_the_grandchild() {
        let dir = tempfile::Builder::new()
            .prefix("gd-job-armed-")
            .tempdir()
            .expect("create temp dir");
        let (mut child, lock) = spawn_locking_tree(dir.path());
        let job = GitJob::arm(child.as_raw_handle()).expect("job object armed");
        assert!(
            wait_until(|| lock_held(&lock), 30),
            "the grandchild took the lock"
        );

        drop(job);
        let _ = child.wait();
        assert!(
            wait_until(|| !lock_held(&lock), 15),
            "the lock is released, so the grandchild died with the tree"
        );
    }

    /// The control that proves the observable can fail: on the success path the job
    /// is DISARMED before it closes, and Windows never cascades a kill on its own,
    /// so the grandchild outlives the parent (git's detached `gc --auto` relies on
    /// exactly this).
    #[test]
    fn disarmed_job_close_leaves_the_grandchild_running() {
        let dir = tempfile::Builder::new()
            .prefix("gd-job-disarmed-")
            .tempdir()
            .expect("create temp dir");
        let (mut child, lock) = spawn_locking_tree(dir.path());
        let job = GitJob::arm(child.as_raw_handle()).expect("job object armed");
        assert!(
            wait_until(|| lock_held(&lock), 30),
            "the grandchild took the lock"
        );

        job.disarm();
        child.kill().expect("kill the direct child");
        let _ = child.wait();
        assert!(
            lock_held(&lock),
            "the grandchild survives a disarmed close plus a direct parent kill"
        );

        // No leaked process: the holder's bounded sleep expires on its own.
        assert!(
            wait_until(|| !lock_held(&lock), u64::from(HOLD_SECS) + 15),
            "the orphaned holder exits on its own"
        );
    }
}
