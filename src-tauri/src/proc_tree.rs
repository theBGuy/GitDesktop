//! Whole-tree kill guard for one spawned child process.
//!
//! `kill_on_drop` reaches only the process we spawned, and that is often a shim: on
//! Windows `cmd\git.exe` is the Git-for-Windows SHIM, which runs the real
//! `mingw64\bin\git.exe` as a child, so killing the shim leaves the real process
//! running as an orphan. [`TreeGuard`] takes the whole tree instead: a kill-on-close
//! Job Object on Windows, the child's own process group on unix.
//!
//! Every call site follows these rules:
//! 1. Drop order. On unix the guard drops BEFORE the `Child`: an unreaped leader pins
//!    its pid and group id, so the kill cannot land on a recycled group, and tokio's
//!    `Child` drop kills the leader and may reap it at once. Declare the guard
//!    immediately after `child`, in the scope that owns `child` until it is reaped; a
//!    helper that needs the child borrows it while a guard is live.
//! 2. Disarm only after a reap: once `child.wait()` returned Ok, whatever the exit
//!    code. Every abandoned path (timeout, cancel, failed drain, failed wait, panic
//!    unwind, dropped future) leaves the guard armed.
//! 3. `kill_on_drop(true)` stays on every armed command: it covers the direct child
//!    when arming failed.
//! 4. A process the child spawns before the Windows job assignment lands does not join
//!    the job. That race is accepted: no `CREATE_SUSPENDED`.
//! 5. The job carries `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` only, with no breakaway flag.

/// Whole-tree kill guard for one spawned child. Armed right after spawn; dropping it
/// kills every process still in the child's tree. Only a REAPED child may `disarm`.
pub(crate) struct TreeGuard {
    #[cfg(windows)]
    inner: Option<TreeJob>,
    #[cfg(unix)]
    inner: Option<TreeGroup>,
}

impl TreeGuard {
    /// Sets on `cmd` what `arm` relies on, before spawn: unix `process_group(0)`;
    /// nothing on Windows. Not for a child that already leads its own group through a
    /// `setsid` pre_exec: std runs setpgid before pre_exec closures, so setsid would
    /// then fail.
    ///
    /// Leading its own group, the child has no foreground terminal: in an app launched
    /// from a shell (`tauri dev`, an AppImage run from a terminal), a descendant that
    /// reads /dev/tty, such as an ssh passphrase or host-key prompt, is stopped
    /// (SIGTTIN) until the caller's timeout. A GUI launch has no controlling tty.
    pub(crate) fn prepare(cmd: &mut tokio::process::Command) {
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(not(unix))]
        let _ = cmd;
    }

    /// Call immediately after a successful spawn, before any await.
    /// Windows: puts the child in a fresh kill-on-close Job Object; any Win32 failure
    /// gives an UNARMED guard (the caller still has `kill_on_drop` for the direct
    /// child). Unix: records the child's pid as its process-group id; the child must
    /// lead its own group (`prepare`, or a setsid pre_exec). A child with no pid
    /// (already reaped) gives an unarmed guard.
    pub(crate) fn arm(child: &tokio::process::Child) -> Self {
        Self {
            #[cfg(windows)]
            inner: child.raw_handle().and_then(TreeJob::arm),
            #[cfg(unix)]
            inner: child.id().map(TreeGroup),
        }
    }

    /// Whether dropping this guard would kill a tree. False after a failed Windows arm.
    // Its one production caller is agent.rs's `kill_process_tree`, which picks the job
    // terminate or the `taskkill` fallback by it; tests call it on every platform.
    #[cfg(any(windows, test))]
    pub(crate) fn is_armed(&self) -> bool {
        self.inner.is_some()
    }

    /// Kills every process in the tree now and keeps the guard armed, for a caller that
    /// still owns the child and has yet to reap it. A no-op on an unarmed guard. Windows
    /// only: on unix that caller signals the group itself (`kill_process_group`) while
    /// the leader is unreaped.
    #[cfg(windows)]
    pub(crate) fn terminate(&self) {
        if let Some(job) = &self.inner {
            job.terminate();
        }
    }

    /// Consumes the guard WITHOUT killing, so descendants the command left behind on
    /// purpose (a background `gc --auto`) survive. Windows: clears the kill-on-close
    /// limit, then closes the handle; a failed clear leaks the handle instead of
    /// closing an armed job.
    pub(crate) fn disarm(mut self) {
        if let Some(inner) = self.inner.take() {
            inner.disarm();
        }
    }

    /// Kills the tree now and consumes the guard. Same effect as dropping it; named
    /// for call sites where the kill is the point.
    pub(crate) fn kill(self) {
        drop(self);
    }
}

/// A Windows Job Object holding a spawned child, armed so that closing the last
/// handle kills everything still in it. `TreeGroup` is the unix counterpart.
#[cfg(windows)]
pub(crate) struct TreeJob(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: a job-object HANDLE is a process-wide kernel handle with no thread
// affinity, and the raw pointer is only ever handed back to Win32. The wrapper
// exists so the guard can be held across awaits inside a `Send` future.
#[cfg(windows)]
unsafe impl Send for TreeJob {}

#[cfg(windows)]
impl TreeJob {
    /// Puts `process` in a fresh kill-on-close job. `None` on any Win32 failure: the
    /// caller runs on with an unarmed guard rather than failing the call over a
    /// missing safety net (`kill_on_drop` for the direct child; agent runs walk the
    /// tree with `taskkill /T` instead).
    ///
    /// Processes the child spawns before the assignment lands don't join the job.
    /// Arming is three syscalls (create, set the limit, assign) issued immediately
    /// after spawn while a shim has yet to start its real program, so losing that
    /// race should take a pathological scheduling delay, and `kill_on_drop` still
    /// covers the direct child.
    pub(crate) fn arm(process: std::os::windows::io::RawHandle) -> Option<Self> {
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
        let job = TreeJob(handle);
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

    /// Terminates every process in the job now and leaves the handle open, so the job
    /// stays armed: closing it later still kills whatever joined it since.
    pub(crate) fn terminate(&self) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;

        // SAFETY: `self.0` is a valid job handle this type owns. The result is ignored:
        // a failed terminate leaves the job armed, and closing it still kills the tree.
        unsafe { TerminateJobObject(self.0, 1) };
    }

    /// Consumes the guard, clearing the kill-on-close limit before its handle is
    /// closed. A child can leave legitimately detached descendants behind a command
    /// that SUCCEEDED (a background `gc --auto`), and those must outlive the guard.
    /// Only a REAPED command disarms: every abandoned path (a timeout, a failed drain,
    /// a failed wait) drops the guard still armed and takes the tree with it.
    ///
    /// A failure to clear leaks the handle instead of closing it: the kernel
    /// reclaims it at process exit, whereas closing a still-armed job would kill
    /// those descendants.
    pub(crate) fn disarm(self) {
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
impl Drop for TreeJob {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a handle this type created and owns exclusively.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) };
    }
}

/// SIGKILLs the process group `pgid` (a child spawned with `process_group(0)` leads
/// one whose id is its pid) through `killpg` itself: no spawn, so no PATH lookup and
/// no procps-ng `kill` argv parsing, which misreads `-KILL -<pgid>` (wrong group,
/// `kill(-1)`, or the caller's own group). Ids that can't name a child's group are
/// refused, since `killpg(0)` signals the caller's own group.
#[cfg(unix)]
pub(crate) fn kill_process_group(pgid: u32) {
    let Ok(pgid) = libc::pid_t::try_from(pgid) else {
        return;
    };
    if pgid <= 1 {
        return;
    }
    // SAFETY: `killpg` takes plain integers and touches no memory of ours. The result
    // is ignored: ESRCH means the group is already gone.
    unsafe {
        libc::killpg(pgid, libc::SIGKILL);
    }
}

/// The process group of a spawned child on unix (the child leads it), armed so that
/// dropping the guard kills the whole group: `kill_on_drop` reaches only the child
/// itself, not what it spawned. Same contract as `TreeJob`: only a REAPED command
/// disarms.
#[cfg(unix)]
pub(crate) struct TreeGroup(pub(crate) u32);

#[cfg(unix)]
impl TreeGroup {
    /// Consumes the guard without the kill, so a successful command's detached
    /// descendants (a background `gc --auto`) survive.
    pub(crate) fn disarm(self) {
        std::mem::forget(self);
    }
}

#[cfg(unix)]
impl Drop for TreeGroup {
    fn drop(&mut self) {
        // Synchronous, so the group is signalled before the caller's next step (a
        // rollback's abort).
        kill_process_group(self.0);
    }
}

/// Fixtures for tree tests: a "holder" process that marks that it started and then
/// stays alive until the test releases it, so both "alive" and "dead" are observable
/// without a clock.
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, Instant};

    /// Failure-only ceiling for every wait in a tree test. Never sized to a fixture's
    /// run time, and no assertion's truth depends on it.
    pub(crate) const HANG_GUARD: Duration = Duration::from_secs(60);

    /// Polls `cond` until it holds or `ceiling` passes; returns whether it held.
    /// BLOCKS the thread between polls: never call it while another future on the same
    /// runtime still has to make progress (`#[tokio::test]` is current-thread).
    pub(crate) fn wait_until(mut cond: impl FnMut() -> bool, ceiling: Duration) -> bool {
        let deadline = Instant::now() + ceiling;
        loop {
            if cond() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Which shell will run the launch text.
    #[derive(Clone, Copy, Debug)]
    pub(crate) enum HostShell {
        /// cmd.exe syntax (a .cmd wrapper, `cmd /c`). Windows only. A `%` in the
        /// holder's directory is not supported: cmd would expand it.
        #[cfg(windows)]
        Cmd,
        /// POSIX sh syntax (unix; Git for Windows' sh for a hook).
        Sh,
    }

    /// Which of the launching shell's stdout/stderr PIPES the holder keeps open.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(crate) enum Keeps {
        /// Both: while the holder lives, neither pipe reaches EOF.
        Both,
        /// stderr only: the launcher's stdout pipe reaches EOF when the launcher
        /// exits; its stderr pipe stays open.
        StderrOnly,
        /// Neither: both pipes reach EOF when the launcher exits, with the holder
        /// still alive.
        Neither,
    }

    /// The one line the holder writes to each kept pipe when it leaves its loop, and
    /// the only bytes it or its launcher ever write to one.
    #[cfg(unix)]
    const RELEASED: &str = "gd-holder-released";

    /// Leak cap of the holder's poll loop: 18000 passes of at least 50 ms, so at
    /// least 15 minutes. Never a time anything waits for.
    #[cfg(unix)]
    const LEAK_CAP: u32 = 18000;

    /// A process that marks that it started and then stays alive until the test
    /// releases it. It never exits by itself (bar a leak cap far above `HANG_GUARD`, or
    /// its directory being deleted), so "alive" and "dead" are both observable without
    /// a clock.
    ///
    /// Reserved names under the directory (pick other names for your own gates):
    /// `started`, `release`, `ask`, `ask.tmp` and `answer` on every platform, plus
    /// `live` on unix and `hold.ps1` and `held.lock` on Windows.
    ///
    /// Declare the Holder AFTER its TempDir, so it drops first: its Drop releases the
    /// holder and waits for it to die before the directory is deleted. A test that
    /// fails before `started` leaves Drop nothing to wait for. A unix holder that
    /// starts after the drop sees `release` and exits; only one that passed its
    /// `release` check before the drop and reaches `exec 3>` after the FIFO's read end
    /// closed blocks there, on a FIFO with no reader (one sleeping sh, only after a
    /// failed test).
    pub(crate) struct Holder {
        dir: PathBuf,
        asks: AtomicU64,
        /// The FIFO's read end, kept for the Holder's life: a 1-byte read returns
        /// WouldBlock while the holder holds the write end, EOF once no writer is left.
        #[cfg(unix)]
        live: std::fs::File,
    }

    /// Holder mode keeps `held.lock` open with no sharing while it polls; launcher mode
    /// sheds inheritance from every handle the launching shell's pipes could ride on
    /// except the std handles `keeps` names, then starts holder mode and exits.
    #[cfg(windows)]
    const HOLD_PS1: &str = concat!(
        "$ProgressPreference = 'SilentlyContinue'\r\n",
        "$WarningPreference = 'SilentlyContinue'\r\n",
        "$ErrorActionPreference = 'Stop'\r\n",
        "try {\r\n",
        "$dir = $args[0]\r\n",
        "$mode = $args[1]\r\n",
        "if ($mode -eq 'hold') {\r\n",
        "$started = [IO.Path]::Combine($dir, 'started')\r\n",
        "$release = [IO.Path]::Combine($dir, 'release')\r\n",
        "$ask = [IO.Path]::Combine($dir, 'ask')\r\n",
        "$answer = [IO.Path]::Combine($dir, 'answer')\r\n",
        "$lock = [IO.File]::Open([IO.Path]::Combine($dir, 'held.lock'), 'OpenOrCreate', 'ReadWrite', 'None')\r\n",
        "[IO.File]::WriteAllText($started, '')\r\n",
        "$i = 0\r\n",
        "while ([IO.File]::Exists($started) -and (-not [IO.File]::Exists($release)) -and ($i -lt 18000)) {\r\n",
        "try { if ([IO.File]::Exists($ask)) { Move-Item -LiteralPath $ask -Destination $answer -Force } } catch { }\r\n",
        "try { Start-Sleep -Milliseconds 50 } catch { }\r\n",
        "$i++\r\n",
        "}\r\n",
        "$lock.Close()\r\n",
        "try { [Console]::Out.WriteLine('gd-holder-released') } catch { }\r\n",
        "try { [Console]::Error.WriteLine('gd-holder-released') } catch { }\r\n",
        "} else {\r\n",
        "$src = 'using System; using System.Runtime.InteropServices; ",
        "public static class GdHoldShed { ",
        "[DllImport(\"kernel32.dll\")] static extern bool GetHandleInformation(IntPtr h, out uint f); ",
        "[DllImport(\"kernel32.dll\")] static extern bool SetHandleInformation(IntPtr h, uint m, uint f); ",
        "[DllImport(\"kernel32.dll\")] static extern IntPtr GetStdHandle(int n); ",
        "public static void Shed(string mode) { ",
        "IntPtr o = GetStdHandle(-11); IntPtr e = GetStdHandle(-12); ",
        "for (long v = 4; v < 0x100000; v += 4) { ",
        "IntPtr h = new IntPtr(v); ",
        "if (mode == \"both\" && (h == o || h == e)) continue; ",
        "if (mode == \"stderr\" && h == e) continue; ",
        "uint f; ",
        "if (GetHandleInformation(h, out f) && (f & 1) != 0) SetHandleInformation(h, 1, 0); ",
        "} } }'\r\n",
        "$null = Add-Type -IgnoreWarnings -TypeDefinition $src\r\n",
        "[GdHoldShed]::Shed($mode)\r\n",
        "$psi = New-Object System.Diagnostics.ProcessStartInfo\r\n",
        "$psi.FileName = [IO.Path]::Combine($env:SystemRoot, 'System32\\WindowsPowerShell\\v1.0\\powershell.exe')\r\n",
        "$psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $PSCommandPath + '\" \"' + $dir + '\" hold'\r\n",
        "$psi.UseShellExecute = $false\r\n",
        "$psi.CreateNoWindow = $true\r\n",
        "$psi.RedirectStandardInput = $true\r\n",
        "$psi.RedirectStandardOutput = ($mode -ne 'both')\r\n",
        "$psi.RedirectStandardError = ($mode -eq 'none')\r\n",
        "$null = [Diagnostics.Process]::Start($psi)\r\n",
        "}\r\n",
        "} catch { }\r\n",
    );

    /// Windows PowerShell 5.1 by absolute path, so neither PATH nor a pwsh install
    /// decides which host runs the holder.
    #[cfg(windows)]
    fn powershell() -> PathBuf {
        let root = std::env::var_os("SystemRoot").expect("SystemRoot is set");
        Path::new(&root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
    }

    /// Single-quotes `path` for sh, an apostrophe as `'\''`.
    fn sh_quote(path: &Path) -> String {
        format!("'{}'", path.display().to_string().replace('\'', r"'\''"))
    }

    impl Holder {
        /// Prepares the holder's files under `dir` (a tempdir the caller owns). One
        /// Holder per directory: panics if `dir` already holds one.
        pub(crate) fn new(dir: &Path) -> Self {
            #[cfg(windows)]
            {
                let script = dir.join("hold.ps1");
                assert!(!script.exists(), "{} already holds a Holder", dir.display());
                std::fs::write(&script, HOLD_PS1).expect("write the holder script");
                Self {
                    dir: dir.to_path_buf(),
                    asks: AtomicU64::new(0),
                }
            }
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                use std::os::unix::fs::OpenOptionsExt;

                let live = dir.join("live");
                assert!(!live.exists(), "{} already holds a Holder", dir.display());
                let path = std::ffi::CString::new(live.as_os_str().as_bytes())
                    .expect("a path with no NUL");
                let mode: libc::mode_t = 0o600;
                // SAFETY: `path` is a valid NUL-terminated string that outlives the call.
                let rc = unsafe { libc::mkfifo(path.as_ptr(), mode) };
                assert_eq!(rc, 0, "mkfifo: {}", std::io::Error::last_os_error());
                // std opens with O_CLOEXEC, so no exec'd program keeps this read end; a
                // child another thread forks meanwhile holds it until its own exec or exit.
                let live = std::fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NONBLOCK)
                    .open(&live)
                    .expect("open the FIFO's read end");
                Self {
                    dir: dir.to_path_buf(),
                    asks: AtomicU64::new(0),
                    live,
                }
            }
        }

        fn file(&self, name: &str) -> PathBuf {
            self.dir.join(name)
        }

        /// Shell text that starts the holder in the BACKGROUND and returns at once,
        /// written for `shell`: one line with no label, no goto and balanced
        /// parentheses. `keeps` says which of the launching shell's stdout/stderr pipes
        /// the holder keeps, and the text guarantees it: callers add no redirection.
        /// It never reads the launching shell's stdin, and never calls `setsid`,
        /// `nohup` or `start`, so the holder stays in the launcher's process group and
        /// session (unix) and Job Object (Windows).
        ///
        /// On Windows the text is one SYNCHRONOUS call of a transient PowerShell
        /// launcher (a second or more): the holder is not a job of the calling shell,
        /// so a `wait` after it returns at once. sh text that runs under Git for
        /// Windows' sh passes the backslash paths quoted, to a native program only.
        pub(crate) fn launch_snippet(&self, shell: HostShell, keeps: Keeps) -> String {
            #[cfg(windows)]
            {
                let mode = match keeps {
                    Keeps::Both => "both",
                    Keeps::StderrOnly => "stderr",
                    Keeps::Neither => "none",
                };
                let ps = powershell();
                let script = self.file("hold.ps1");
                let flags = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File";
                match shell {
                    HostShell::Cmd => format!(
                        "\"{}\" {flags} \"{}\" \"{}\" {mode} <nul",
                        ps.display(),
                        script.display(),
                        self.dir.display()
                    ),
                    HostShell::Sh => format!(
                        "{} {flags} {} {} {mode} </dev/null",
                        sh_quote(&ps),
                        sh_quote(&script),
                        sh_quote(&self.dir)
                    ),
                }
            }
            #[cfg(unix)]
            {
                let HostShell::Sh = shell;
                let redirect = match keeps {
                    Keeps::Both => "",
                    Keeps::StderrOnly => " >/dev/null",
                    Keeps::Neither => " >/dev/null 2>&1",
                };
                let started = sh_quote(&self.file("started"));
                let release = sh_quote(&self.file("release"));
                let ask = sh_quote(&self.file("ask"));
                let answer = sh_quote(&self.file("answer"));
                let live = sh_quote(&self.file("live"));
                format!(
                    "{{ ( [ -e {release} ] && exit 0; exec 3>{live}; : >{started} 2>/dev/null; \
                     i=0; while [ -e {started} ] && [ ! -e {release} ] && [ \"$i\" -lt {LEAK_CAP} ]; \
                     do [ -e {ask} ] && mv -f {ask} {answer} 2>/dev/null; sleep 0.05 2>/dev/null; \
                     i=$((i+1)); done; echo {RELEASED}; echo {RELEASED} >&2 ) </dev/null{redirect} & }}"
                )
            }
        }

        /// Whether the holder has started and holds its observable.
        pub(crate) fn started(&self) -> bool {
            self.file("started").exists()
        }

        /// Whether the holder is still alive. Meaningful once `started()` has been
        /// true. Proves DEATH only (`wait_until(|| !holder.alive(), HANG_GUARD)`): a
        /// process just killed can still read as alive until the kernel lets go.
        pub(crate) fn alive(&self) -> bool {
            #[cfg(windows)]
            {
                // The holder opens the lock with no sharing, so any open other than a
                // missing file fails while it lives.
                match std::fs::OpenOptions::new()
                    .write(true)
                    .open(self.file("held.lock"))
                {
                    Ok(_) => false,
                    Err(e) => e.kind() != std::io::ErrorKind::NotFound,
                }
            }
            #[cfg(unix)]
            {
                use std::io::Read;
                let mut byte = [0u8; 1];
                loop {
                    match (&self.live).read(&mut byte) {
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(e) => return e.kind() == std::io::ErrorKind::WouldBlock,
                        Ok(n) => return n > 0,
                    }
                }
            }
        }

        /// Proof of SURVIVAL: asks the holder to answer and waits up to `ceiling` for
        /// the answer. True means the holder ran its own code after this call began,
        /// which a killed process cannot do. The holder answers within one poll (about
        /// 50 ms). One caller at a time.
        pub(crate) fn confirm_alive(&self, ceiling: Duration) -> bool {
            let nonce = format!("ask-{}", self.asks.fetch_add(1, Ordering::Relaxed));
            let answer = self.file("answer");
            let _ = std::fs::remove_file(&answer);
            let tmp = self.file("ask.tmp");
            std::fs::write(&tmp, &nonce).expect("write the ask");
            std::fs::rename(&tmp, self.file("ask")).expect("post the ask");
            wait_until(
                || std::fs::read_to_string(&answer).is_ok_and(|text| text == nonce),
                ceiling,
            )
        }

        /// Lets the holder exit. Also runs on Drop, so a failed assertion leaks no
        /// process.
        pub(crate) fn release(&self) {
            let _ = std::fs::write(self.file("release"), "");
        }
    }

    impl Drop for Holder {
        fn drop(&mut self) {
            self.release();
            let _ = wait_until(|| !self.alive(), HANG_GUARD);
        }
    }
}

/// Parents the tree tests share: a gate the Windows fixtures wait on before their
/// first child is born (so the job assignment lands first), and a hold file that
/// keeps a Windows parent alive until the test kills it.
#[cfg(test)]
mod tree_fixtures {
    use super::test_support::{Holder, HostShell, Keeps};
    use std::path::{Path, PathBuf};

    /// The shell each platform's own parents run the snippet in.
    #[cfg(windows)]
    pub(super) const HOST: HostShell = HostShell::Cmd;
    #[cfg(unix)]
    pub(super) const HOST: HostShell = HostShell::Sh;

    /// Every shell this platform can build a snippet for.
    #[cfg(windows)]
    pub(super) const SHELLS: [HostShell; 2] = [HostShell::Cmd, HostShell::Sh];
    #[cfg(unix)]
    pub(super) const SHELLS: [HostShell; 1] = [HostShell::Sh];

    pub(super) const ALL_KEEPS: [Keeps; 3] = [Keeps::Both, Keeps::StderrOnly, Keeps::Neither];

    #[cfg(windows)]
    const GATE: &str = "gate.flag";
    const HOLD: &str = "parent.hold";

    pub(super) fn temp(prefix: &str) -> tempfile::TempDir {
        tempfile::Builder::new()
            .prefix(prefix)
            .tempdir()
            .expect("create temp dir")
    }

    /// Removes the hold file on drop, so a failed test's parent leaves its loop.
    pub(super) struct HoldFile(PathBuf);

    impl Drop for HoldFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// Lets a Windows wrapper past its gate. Unix parents have none.
    pub(super) fn open_gate(dir: &Path) {
        #[cfg(windows)]
        std::fs::write(dir.join(GATE), "").expect("open the gate");
        #[cfg(not(windows))]
        let _ = dir;
    }

    /// A batch wrapper: `@echo off`, a gate loop, the snippet on its own line, then a
    /// loop that waits while the hold file exists. Every loop steps with a real delay
    /// and stops after about 900 passes (about 15 minutes).
    #[cfg(windows)]
    pub(super) fn wrapper(dir: &Path, snippet: &str, hold: bool) -> (PathBuf, HoldFile) {
        let gate = dir.join(GATE);
        let hold_file = dir.join(HOLD);
        if hold {
            std::fs::write(&hold_file, "").expect("create the hold file");
        }
        let step = r#""%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul"#;
        let text = format!(
            "@echo off\r\nset n=0\r\n:gate\r\nif exist \"{gate}\" goto run\r\nset /a n+=1\r\n\
             if %n% geq 900 exit /b 1\r\n{step}\r\ngoto gate\r\n:run\r\n{snippet}\r\nset n=0\r\n\
             :hold\r\nif not exist \"{hold}\" exit /b 0\r\nset /a n+=1\r\nif %n% geq 900 exit /b 0\r\n\
             {step}\r\ngoto hold\r\n",
            gate = gate.display(),
            hold = hold_file.display(),
        );
        let path = dir.join("wrap.cmd");
        std::fs::write(&path, text).expect("write the wrapper");
        (path, HoldFile(hold_file))
    }

    /// The unix parent line: `: <sep> <snippet>; wait`, run by `sh -c`.
    #[cfg(unix)]
    pub(super) fn sh_parent(snippet: &str, sep: &str) -> String {
        format!(": {sep} {snippet}; wait")
    }

    /// A tokio parent that runs `holder`'s snippet and stays alive until it is killed
    /// (Windows: until the hold file goes; unix: until the holder exits). Null stdio.
    pub(super) fn tokio_parent(
        dir: &Path,
        holder: &Holder,
        keeps: Keeps,
    ) -> (tokio::process::Command, HoldFile) {
        let snippet = holder.launch_snippet(HOST, keeps);
        #[cfg(windows)]
        let (mut cmd, hold) = {
            let (path, hold) = wrapper(dir, &snippet, true);
            (tokio::process::Command::new(path), hold)
        };
        #[cfg(unix)]
        let (mut cmd, hold) = {
            let mut cmd = tokio::process::Command::new("sh");
            cmd.arg("-c").arg(sh_parent(&snippet, "&&"));
            (cmd, HoldFile(dir.join(HOLD)))
        };
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        (cmd, hold)
    }

    /// The `Keeps` parent: a wrapper FILE that runs the snippet and exits 0 (a .cmd
    /// on Windows, a script `sh` reads on unix, the shape of an rc file).
    pub(super) fn keeps_parent(dir: &Path, holder: &Holder, keeps: Keeps) -> std::process::Command {
        let snippet = holder.launch_snippet(HOST, keeps);
        #[cfg(windows)]
        {
            let (path, _no_hold) = wrapper(dir, &snippet, false);
            std::process::Command::new(path)
        }
        #[cfg(unix)]
        {
            let path = dir.join("wrap.sh");
            std::fs::write(&path, format!("{snippet}\nexit 0\n")).expect("write the wrapper");
            let mut cmd = std::process::Command::new("sh");
            cmd.arg(path);
            cmd
        }
    }

    /// A command that exits at once.
    pub(super) fn quick() -> tokio::process::Command {
        #[cfg(windows)]
        let mut cmd = {
            let mut cmd = tokio::process::Command::new("cmd.exe");
            cmd.args(["/d", "/c", "rem"]);
            cmd
        };
        #[cfg(unix)]
        let mut cmd = {
            let mut cmd = tokio::process::Command::new("sh");
            cmd.args(["-c", ":"]);
            cmd
        };
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        cmd
    }
}

#[cfg(all(test, unix))]
mod group_tests {
    use super::test_support::{wait_until, Holder, HostShell, Keeps, HANG_GUARD};
    use super::tree_fixtures::{sh_parent, temp, ALL_KEEPS};
    use super::{kill_process_group, TreeGroup};
    use std::os::unix::process::CommandExt;

    /// `sh -c '<line>'` leading its own group, null stdio.
    fn spawn_parent(line: &str) -> std::process::Child {
        std::process::Command::new("sh")
            .arg("-c")
            .arg(line)
            .process_group(0)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn the parent")
    }

    fn armed_group_drop_kills(keeps: Keeps) {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let mut child = spawn_parent(&sh_parent(
            &holder.launch_snippet(HostShell::Sh, keeps),
            "&&",
        ));
        let group = TreeGroup(child.id());
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "{keeps:?}: the holder started"
        );

        drop(group);
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "{keeps:?}: the holder died with the group"
        );
        let _ = child.wait();
    }

    /// Dropping an ARMED group kills a holder the parent backgrounded, under every
    /// `Keeps` value: the snippet keeps it in the parent's group.
    #[test]
    fn armed_group_drop_kills_the_tree() {
        for keeps in ALL_KEEPS {
            armed_group_drop_kills(keeps);
        }
    }

    /// The control that proves the observable can fail: a DISARMED group kills
    /// nothing, and a direct kill of the parent leaves the holder running (a detached
    /// `gc --auto` relies on exactly this).
    #[test]
    fn disarmed_group_drop_leaves_the_tree_running() {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let mut child = spawn_parent(&sh_parent(
            &holder.launch_snippet(HostShell::Sh, Keeps::Both),
            ";",
        ));
        let group = TreeGroup(child.id());
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder started"
        );

        group.disarm();
        child.kill().expect("kill the direct child");
        let _ = child.wait();
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the holder survives a disarmed group plus a direct parent kill"
        );
        holder.release();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder left"
        );
    }

    /// The kill reaches only the named group: a tree outside it survives (and so does
    /// this test's own group, or the test runner would die with it).
    #[test]
    fn a_group_kill_spares_a_process_outside_the_group() {
        let dir_a = temp("gd-proc-tree-");
        let dir_b = temp("gd-proc-tree-");
        let a = Holder::new(dir_a.path());
        let b = Holder::new(dir_b.path());
        let mut parent_a = spawn_parent(&sh_parent(
            &a.launch_snippet(HostShell::Sh, Keeps::Both),
            "&&",
        ));
        let mut parent_b = spawn_parent(&sh_parent(
            &b.launch_snippet(HostShell::Sh, Keeps::Both),
            "&&",
        ));
        assert!(wait_until(|| a.started(), HANG_GUARD), "holder A started");
        assert!(wait_until(|| b.started(), HANG_GUARD), "holder B started");

        kill_process_group(parent_a.id());
        assert!(
            wait_until(|| !a.alive(), HANG_GUARD),
            "holder A died with its group"
        );
        assert!(b.confirm_alive(HANG_GUARD), "holder B survives");
        let _ = parent_a.wait();
        b.release();
        let _ = parent_b.wait();
    }
}

#[cfg(all(test, windows))]
mod job_tests {
    use super::test_support::{wait_until, Holder, HostShell, Keeps, HANG_GUARD};
    use super::tree_fixtures::{open_gate, temp, wrapper, ALL_KEEPS};
    use super::TreeJob;
    use std::os::windows::io::AsRawHandle;

    /// A wrapper parent that stays alive while its hold file exists, null stdio.
    fn spawn_parent(
        dir: &std::path::Path,
        holder: &Holder,
        keeps: Keeps,
    ) -> (std::process::Child, super::tree_fixtures::HoldFile) {
        let (path, hold) = wrapper(dir, &holder.launch_snippet(HostShell::Cmd, keeps), true);
        let child = std::process::Command::new(path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn the wrapper");
        (child, hold)
    }

    fn armed_job_close_kills(keeps: Keeps) {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let (mut child, _hold) = spawn_parent(dir.path(), &holder, keeps);
        let job = TreeJob::arm(child.as_raw_handle()).expect("job object armed");
        open_gate(dir.path());
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "{keeps:?}: the holder started"
        );

        drop(job);
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "{keeps:?}: the holder died with the job"
        );
        let _ = child.wait();
    }

    /// Closing an ARMED job kills a holder whose launcher has already exited, under
    /// every `Keeps` value: the launcher starts it inside its own job.
    #[test]
    fn armed_job_close_kills_the_tree_keeping_both() {
        armed_job_close_kills(ALL_KEEPS[0]);
    }

    #[test]
    fn armed_job_close_kills_the_tree_keeping_stderr_only() {
        armed_job_close_kills(ALL_KEEPS[1]);
    }

    #[test]
    fn armed_job_close_kills_the_tree_keeping_neither() {
        armed_job_close_kills(ALL_KEEPS[2]);
    }

    fn armed_job_terminate_kills(keeps: Keeps) {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let (mut child, _hold) = spawn_parent(dir.path(), &holder, keeps);
        let job = TreeJob::arm(child.as_raw_handle()).expect("job object armed");
        open_gate(dir.path());
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "{keeps:?}: the holder started"
        );

        job.terminate();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "{keeps:?}: the holder died while the job stayed open"
        );
        assert!(
            wait_until(|| matches!(child.try_wait(), Ok(Some(_))), HANG_GUARD),
            "{keeps:?}: the parent outlived the terminate while its hold file stayed"
        );
        drop(job);
    }

    /// Terminating an ARMED job kills the tree with its handle still open, under every
    /// `Keeps` value.
    #[test]
    fn armed_job_terminate_kills_the_tree_keeping_both() {
        armed_job_terminate_kills(ALL_KEEPS[0]);
    }

    #[test]
    fn armed_job_terminate_kills_the_tree_keeping_stderr_only() {
        armed_job_terminate_kills(ALL_KEEPS[1]);
    }

    #[test]
    fn armed_job_terminate_kills_the_tree_keeping_neither() {
        armed_job_terminate_kills(ALL_KEEPS[2]);
    }

    /// A terminated job stays armed: a process assigned to it afterwards still dies when
    /// the handle closes.
    #[test]
    fn a_terminated_job_still_kills_what_joins_it_on_close() {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        let dir1 = temp("gd-proc-tree-");
        let dir2 = temp("gd-proc-tree-");
        let holder1 = Holder::new(dir1.path());
        let holder2 = Holder::new(dir2.path());
        let (mut child1, _hold1) = spawn_parent(dir1.path(), &holder1, Keeps::Both);
        let job = TreeJob::arm(child1.as_raw_handle()).expect("job object armed");
        open_gate(dir1.path());
        assert!(
            wait_until(|| holder1.started(), HANG_GUARD),
            "the first holder started"
        );
        job.terminate();
        assert!(
            wait_until(|| !holder1.alive(), HANG_GUARD),
            "the first holder died with the terminate"
        );
        assert!(
            wait_until(|| matches!(child1.try_wait(), Ok(Some(_))), HANG_GUARD),
            "the first parent outlived the terminate while its hold file stayed"
        );

        let (mut child2, _hold2) = spawn_parent(dir2.path(), &holder2, Keeps::Both);
        // SAFETY: `job.0` is the live job handle `job` owns and the second argument is the
        // live child's handle, valid while `child2` is held.
        let assigned = unsafe { AssignProcessToJobObject(job.0, child2.as_raw_handle()) };
        assert_ne!(assigned, 0, "a terminated job accepts a new process");
        open_gate(dir2.path());
        assert!(
            wait_until(|| holder2.started(), HANG_GUARD),
            "the second holder started"
        );
        drop(job);
        assert!(
            wait_until(|| !holder2.alive(), HANG_GUARD),
            "the second holder died when the terminated job closed"
        );
        assert!(
            wait_until(|| matches!(child2.try_wait(), Ok(Some(_))), HANG_GUARD),
            "the second parent outlived the job's close while its hold file stayed"
        );
    }

    /// The control that proves the observable can fail: a DISARMED job closes without
    /// a kill, and Windows never cascades one on its own, so the holder outlives a
    /// direct kill of the parent (a detached `gc --auto` relies on exactly this).
    #[test]
    fn disarmed_job_close_leaves_the_tree_running() {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let (mut child, _hold) = spawn_parent(dir.path(), &holder, Keeps::Both);
        let job = TreeJob::arm(child.as_raw_handle()).expect("job object armed");
        open_gate(dir.path());
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder started"
        );

        job.disarm();
        child.kill().expect("kill the direct child");
        let _ = child.wait();
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the holder survives a disarmed job plus a direct parent kill"
        );
        holder.release();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder left"
        );
    }
}

#[cfg(test)]
mod guard_tests {
    use super::test_support::{wait_until, Holder, HostShell, Keeps, HANG_GUARD};
    use super::tree_fixtures::{
        keeps_parent, open_gate, quick, temp, tokio_parent, ALL_KEEPS, SHELLS,
    };
    use super::TreeGuard;
    use std::io::Read;
    use std::sync::mpsc;
    use std::time::Duration;

    #[tokio::test]
    async fn an_armed_guard_drop_kills_the_tree() {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let (mut cmd, _hold) = tokio_parent(dir.path(), &holder, Keeps::Both);
        TreeGuard::prepare(&mut cmd);
        let mut child = cmd.spawn().expect("spawn the parent");
        let guard = TreeGuard::arm(&child);
        assert!(guard.is_armed(), "the guard armed");
        open_gate(dir.path());
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder started"
        );

        drop(guard);
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder died with the tree"
        );
        let _ = child.wait().await;
    }

    #[tokio::test]
    async fn kill_takes_the_tree_down() {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let (mut cmd, _hold) = tokio_parent(dir.path(), &holder, Keeps::Both);
        TreeGuard::prepare(&mut cmd);
        let mut child = cmd.spawn().expect("spawn the parent");
        let guard = TreeGuard::arm(&child);
        assert!(guard.is_armed(), "the guard armed");
        open_gate(dir.path());
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder started"
        );

        guard.kill();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder died with the tree"
        );
        let _ = child.wait().await;
    }

    /// The control for `kill_takes_the_tree_down`: a disarmed guard plus a direct kill
    /// of the parent leaves the holder running, so the holder's death there comes
    /// from the guard.
    #[tokio::test]
    async fn a_disarmed_guard_spares_the_tree() {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let (mut cmd, _hold) = tokio_parent(dir.path(), &holder, Keeps::Both);
        TreeGuard::prepare(&mut cmd);
        let mut child = cmd.spawn().expect("spawn the parent");
        let guard = TreeGuard::arm(&child);
        open_gate(dir.path());
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder started"
        );

        guard.disarm();
        child.kill().await.expect("kill and reap the direct child");
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the holder survives a disarmed guard plus a direct parent kill"
        );
        holder.release();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder left"
        );
    }

    #[tokio::test]
    async fn a_reaped_child_arms_nothing() {
        let mut child = quick().spawn().expect("spawn a quick child");
        child.wait().await.expect("reap it");
        let guard = TreeGuard::arm(&child);
        assert!(!guard.is_armed(), "a reaped child has nothing to arm");
    }

    /// `terminate` kills the whole tree, the leader included, while the caller still holds
    /// the guard and the leader's hold file.
    #[cfg(windows)]
    #[tokio::test]
    async fn terminate_kills_the_tree_while_the_guard_is_held() {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let (mut cmd, _hold) = tokio_parent(dir.path(), &holder, Keeps::Both);
        TreeGuard::prepare(&mut cmd);
        let mut child = cmd.spawn().expect("spawn the parent");
        let guard = TreeGuard::arm(&child);
        assert!(guard.is_armed(), "the guard armed");
        open_gate(dir.path());
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder started"
        );

        guard.terminate();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder died with the tree"
        );
        assert!(
            matches!(
                tokio::time::timeout(HANG_GUARD, child.wait()).await,
                Ok(Ok(_))
            ),
            "the leader outlived the terminate while its hold file stayed"
        );
        drop(guard);
    }

    /// The unarmed path's only execution: the call returns. A no-op leaves nothing to
    /// assert after it.
    #[cfg(windows)]
    #[tokio::test]
    async fn terminate_on_an_unarmed_guard_does_nothing() {
        let mut child = quick().spawn().expect("spawn a quick child");
        child.wait().await.expect("reap it");
        let guard = TreeGuard::arm(&child);
        assert!(!guard.is_armed(), "a reaped child has nothing to arm");
        guard.terminate();
    }

    /// The login-shell probe's shape: the child leads its own SESSION through a setsid
    /// pre_exec and is never `prepare`d; its group id is still its pid.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_setsid_child_is_armed_without_prepare() {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c")
            .arg(super::tree_fixtures::sh_parent(
                &holder.launch_snippet(HostShell::Sh, Keeps::Both),
                "&&",
            ))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        // SAFETY: setsid is async-signal-safe and the closure touches no shared state.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = cmd.spawn().expect("spawn the parent");
        let guard = TreeGuard::arm(&child);
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder started"
        );

        drop(guard);
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder died with the session's group"
        );
        let _ = child.wait().await;
    }

    /// `confirm_alive` is true only while the holder runs its loop: twice for a live
    /// holder (a second nonce is not satisfied by the first answer), never for a dead
    /// one.
    #[tokio::test]
    async fn confirm_alive_answers_only_while_the_holder_runs() {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let (mut cmd, _hold) = tokio_parent(dir.path(), &holder, Keeps::Both);
        TreeGuard::prepare(&mut cmd);
        let mut child = cmd.spawn().expect("spawn the parent");
        let guard = TreeGuard::arm(&child);
        open_gate(dir.path());
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder started"
        );

        assert!(holder.confirm_alive(HANG_GUARD), "a live holder answers");
        assert!(holder.confirm_alive(HANG_GUARD), "and answers a second ask");
        guard.kill();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder died with the tree"
        );
        // The one short ceiling: the false case waits it out, on a holder already
        // observed dead.
        assert!(
            !holder.confirm_alive(Duration::from_secs(2)),
            "a dead holder never answers"
        );
        let _ = child.wait().await;
    }

    /// Sends a pipe's complete bytes once it reaches EOF.
    fn drain(mut pipe: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = pipe.read_to_end(&mut bytes);
            let _ = tx.send(bytes);
        });
        rx
    }

    fn is_marker_line(bytes: &[u8]) -> bool {
        bytes == b"gd-holder-released\n" || bytes == b"gd-holder-released\r\n"
    }

    /// A `Keeps` run: the wrapper parent on Rust std pipes, its stdin a LIVE pipe the
    /// test holds open and never writes. Returns once the wrapper was reaped.
    struct KeepsRun {
        _stdin: std::process::ChildStdin,
        stdout: mpsc::Receiver<Vec<u8>>,
        stderr: mpsc::Receiver<Vec<u8>>,
    }

    fn keeps_run(dir: &std::path::Path, holder: &Holder, keeps: Keeps) -> KeepsRun {
        let mut child = keeps_parent(dir, holder, keeps)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn the wrapper");
        // Taken out, because `wait` closes a stdin it still holds.
        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = drain(child.stdout.take().expect("stdout was piped"));
        let stderr = drain(child.stderr.take().expect("stderr was piped"));
        open_gate(dir);
        let status = child.wait().expect("reap the wrapper");
        assert!(
            status.success(),
            "{keeps:?}: the wrapper exits 0: {status:?}"
        );
        KeepsRun {
            _stdin: stdin,
            stdout,
            stderr,
        }
    }

    #[test]
    fn keeps_both() {
        let dir = temp("gd-proc-tree- q ");
        let holder = Holder::new(dir.path());
        let run = keeps_run(dir.path(), &holder, Keeps::Both);
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder started"
        );

        holder.release();
        let out = run
            .stdout
            .recv_timeout(HANG_GUARD)
            .expect("stdout reaches EOF");
        let err = run
            .stderr
            .recv_timeout(HANG_GUARD)
            .expect("stderr reaches EOF");
        assert!(
            is_marker_line(&out),
            "stdout held exactly the marker: {:?}",
            String::from_utf8_lossy(&out)
        );
        assert!(
            is_marker_line(&err),
            "stderr held exactly the marker: {:?}",
            String::from_utf8_lossy(&err)
        );
    }

    #[test]
    fn keeps_stderr_only() {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let run = keeps_run(dir.path(), &holder, Keeps::StderrOnly);
        let out = run
            .stdout
            .recv_timeout(HANG_GUARD)
            .expect("stdout reaches EOF before the release");
        assert!(
            out.is_empty(),
            "stdout carried nothing: {:?}",
            String::from_utf8_lossy(&out)
        );
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder started"
        );
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the holder lives past stdout's EOF"
        );

        holder.release();
        let err = run
            .stderr
            .recv_timeout(HANG_GUARD)
            .expect("stderr reaches EOF");
        assert!(
            is_marker_line(&err),
            "stderr held exactly the marker: {:?}",
            String::from_utf8_lossy(&err)
        );
    }

    #[test]
    fn keeps_neither() {
        let dir = temp("gd-proc-tree-");
        let holder = Holder::new(dir.path());
        let run = keeps_run(dir.path(), &holder, Keeps::Neither);
        let out = run
            .stdout
            .recv_timeout(HANG_GUARD)
            .expect("stdout reaches EOF before the release");
        let err = run
            .stderr
            .recv_timeout(HANG_GUARD)
            .expect("stderr reaches EOF before the release");
        assert!(
            out.is_empty(),
            "stdout carried nothing: {:?}",
            String::from_utf8_lossy(&out)
        );
        assert!(
            err.is_empty(),
            "stderr carried nothing: {:?}",
            String::from_utf8_lossy(&err)
        );
        assert!(
            wait_until(|| holder.started(), HANG_GUARD),
            "the holder started"
        );
        assert!(
            holder.confirm_alive(HANG_GUARD),
            "the holder lives past both EOFs"
        );

        holder.release();
        assert!(
            wait_until(|| !holder.alive(), HANG_GUARD),
            "the holder left"
        );
    }

    /// What breaks embedding the text as one line of a batch file or an sh script: a
    /// second line, a label, a `goto`, unbalanced parentheses or quotes, or a word that
    /// would move the holder out of the launcher's group, session or job.
    fn shape_faults(text: &str, shell: HostShell) -> Vec<&'static str> {
        let mut faults = Vec::new();
        if text.contains(['\n', '\r']) {
            faults.push("more than one line");
        }
        if text.trim_start().starts_with(':') {
            faults.push("a label");
        }
        let sh = matches!(shell, HostShell::Sh);
        let mut quote = None;
        let mut escaped = false;
        let mut depth = 0i32;
        let mut unbalanced = false;
        let mut unquoted = String::new();
        for c in text.chars() {
            if let Some(q) = quote {
                if c == q {
                    quote = None;
                }
                continue;
            }
            if escaped {
                escaped = false;
                continue;
            }
            match c {
                '\\' if sh => escaped = true,
                '"' => quote = Some('"'),
                '\'' if sh => quote = Some('\''),
                '(' => depth += 1,
                ')' => {
                    depth -= 1;
                    unbalanced |= depth < 0;
                }
                _ => {}
            }
            unquoted.push(c);
        }
        if quote.is_some() {
            faults.push("an unclosed quote");
        }
        if unbalanced || depth != 0 {
            faults.push("unbalanced parentheses");
        }
        for word in unquoted.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
            match word.to_ascii_lowercase().as_str() {
                "goto" => faults.push("a goto"),
                "setsid" | "nohup" | "start" => faults.push("a detaching command"),
                _ => {}
            }
        }
        faults
    }

    #[test]
    fn snippets_are_one_embeddable_line() {
        let dir = temp("gd-proc-tree- q ");
        let holder = Holder::new(dir.path());
        for shell in SHELLS {
            for keeps in ALL_KEEPS {
                let snippet = holder.launch_snippet(shell, keeps);
                let faults = shape_faults(&snippet, shell);
                assert!(
                    faults.is_empty(),
                    "{shell:?}/{keeps:?}: {faults:?} in {snippet}"
                );
            }
        }
    }
}
