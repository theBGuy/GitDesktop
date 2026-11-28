//! Writes files that tests then run as programs (git hooks, scripts on PATH).

use std::path::Path;

/// Writes `body` to `path` as an executable script (unix mode 755), replacing any file
/// there in place. On unix a `sh` child writes it, so this process never holds a write
/// descriptor on the file: a child another test thread forks meanwhile keeps a copy
/// until its own exec, and running a file still open for writing fails with ETXTBSY.
/// Panics on any failure; the parent directory must exist.
pub(crate) fn write_executable(path: &Path, body: &str) {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let mut child = Command::new("sh")
            .args(["-c", r#"cat > "$1" && chmod 755 -- "$1""#, "sh"])
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn sh to write the executable");
        // Dropping the handle closes the pipe, so cat sees EOF.
        let fed = child
            .stdin
            .take()
            .expect("the writer's stdin")
            .write_all(body.as_bytes());
        let out = child.wait_with_output().expect("wait for the writer");
        // Before `fed`: a failed sh breaks the pipe, and its stderr names the cause.
        assert!(
            out.status.success(),
            "writing {} failed: {}",
            path.display(),
            String::from_utf8_lossy(&out.stderr)
        );
        fed.expect("send the executable's body");
    }
    #[cfg(not(unix))]
    std::fs::write(path, body).unwrap_or_else(|e| panic!("writing {} failed: {e}", path.display()));
}

#[cfg(test)]
mod tests {
    use super::write_executable;

    #[test]
    fn write_executable_writes_the_body_and_replaces_an_existing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("script");
        write_executable(&path, "one");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one");
        write_executable(&path, "#!/bin/sh\ntwo\n");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "#!/bin/sh\ntwo\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755, "{mode:o}");
        }
    }

    /// Proves the chmod operand's quoting; the redirect target is not field-split by
    /// POSIX sh. The path reaches sh as an argument, never as script text.
    #[test]
    fn write_executable_takes_a_path_with_shell_metacharacters() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("a b'c$HOME;d");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("script");
        write_executable(&path, "#!/bin/sh\necho ok\n");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "#!/bin/sh\necho ok\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_written_script_runs_as_a_program() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("script");
        write_executable(&path, "#!/bin/sh\necho ran\n");
        let out = std::process::Command::new(&path).output().unwrap();
        assert!(out.status.success(), "{out:?}");
        assert_eq!(out.stdout, b"ran\n");
    }

    /// Pins the helper's own sentence: on unix the panic also carries sh's stderr, which
    /// names the path by itself.
    #[test]
    fn a_failed_write_panics_with_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing").join("script");
        let payload = std::panic::catch_unwind(|| write_executable(&path, "#!/bin/sh\n"))
            .expect_err("a write into a missing directory panics");
        let msg = payload
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| payload.downcast_ref::<&str>().copied())
            .expect("a string panic payload");
        assert!(
            msg.contains(&format!("writing {} failed", path.display())),
            "{msg}"
        );
    }

    /// Spawner threads that fork children until dropped; the drop stops and joins them,
    /// so a failed test never leaves them loading the rest of the suite.
    #[cfg(unix)]
    struct ForkLoad {
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        threads: Vec<std::thread::JoinHandle<()>>,
    }

    #[cfg(unix)]
    impl ForkLoad {
        fn start(forkers: usize) -> Self {
            use std::process::{Command, Stdio};
            use std::sync::atomic::Ordering;
            let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let threads = (0..forkers)
                .map(|_| {
                    let stop = stop.clone();
                    std::thread::spawn(move || {
                        while !stop.load(Ordering::Relaxed) {
                            let _ = Command::new("true")
                                .stdin(Stdio::null())
                                .stdout(Stdio::null())
                                .stderr(Stdio::null())
                                .status();
                        }
                    })
                })
                .collect();
            Self { stop, threads }
        }
    }

    #[cfg(unix)]
    impl Drop for ForkLoad {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            for thread in self.threads.drain(..) {
                let _ = thread.join();
            }
        }
    }

    /// Each script runs the moment it is written, while other threads fork: an in-process
    /// write fails some rounds with ETXTBSY (os error 26), the sh writer none, since this
    /// process never holds the write descriptor a forked child could inherit.
    #[cfg(unix)]
    #[test]
    #[ignore = "stress: its spawner threads would load timing-sensitive tests on small CI \
                runners; run it with --ignored"]
    fn scripts_written_under_fork_load_never_meet_text_file_busy() {
        const FORKERS: usize = 4;
        const ROUNDS: usize = 200;
        let dir = tempfile::tempdir().unwrap();
        let load = ForkLoad::start(FORKERS);
        let mut failed = Vec::new();
        for i in 0..ROUNDS {
            let path = dir.path().join(format!("s{i}"));
            write_executable(&path, "#!/bin/sh\nexit 0\n");
            let result = std::process::Command::new(&path).status();
            if !matches!(&result, Ok(status) if status.success()) {
                failed.push(format!("round {i}: {result:?}"));
            }
        }
        drop(load);
        assert!(
            failed.is_empty(),
            "{} of {ROUNDS} rounds failed: {failed:#?}",
            failed.len()
        );
    }

    /// Files whose literal permission modes carry an execute bit, by count. The rows count
    /// production lines as well (a production writer gets its own row); a test that writes
    /// a script it then runs uses `write_executable` instead of a row.
    const EXEC_MODE_SITES: &[(&str, usize, &str)] = &[
        (
            "agent_sandbox.rs",
            2,
            "a private temp dir, and write_temp_script's executable mode",
        ),
        (
            "attachments.rs",
            2,
            "an owner-only directory, and a test fixture making one",
        ),
        (
            "forge/pr_content.rs",
            2,
            "an owner-only folder and its per-run temp dir",
        ),
        (
            "git/ai_ignore.rs",
            2,
            "an owner-only temp dir, and a test widening one",
        ),
        (
            "git/ops.rs",
            2,
            "a worktree directory made read-only, then restored",
        ),
        (
            "git/worktree.rs",
            2,
            "the info directory made read-only, then restored",
        ),
        (
            "hooks.rs",
            4,
            "the production hook writers, and two restores of a file a test made unreadable",
        ),
        (
            "mcp.rs",
            3,
            "an owner-only directory, and a test widening one",
        ),
    ];

    /// Counts literal modes written as `mode(0o` + three octal digits + `)` with any digit
    /// odd: an execute bit for anyone, the owner included, since tests run as the owner.
    fn exec_mode_count(text: &str) -> usize {
        text.match_indices("mode(0o")
            .filter(|(at, needle)| {
                let rest = &text.as_bytes()[at + needle.len()..];
                rest.len() >= 4
                    && rest[..3].iter().all(|b| (b'0'..=b'7').contains(b))
                    && rest[3] == b')'
                    && rest[..3].iter().any(|b| (b - b'0') % 2 == 1)
            })
            .count()
    }

    fn rust_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        let entries =
            std::fs::read_dir(dir).unwrap_or_else(|e| panic!("read {}: {e}", dir.display()));
        for entry in entries {
            let path = entry
                .unwrap_or_else(|e| panic!("list {}: {e}", dir.display()))
                .path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    /// Ratchets hand-set execute bits in src-tauri/src. It cannot see a mode held in a
    /// variable or const, a literal spelled any other way (spaces, other digit counts, a
    /// line break), a plain overwrite of a file already executable, `fs::copy` of one, or
    /// a chmod a child process runs. Nor does a test that runs a file production code
    /// wrote in-process add a literal, so that test re-materializes the file first, as
    /// hooks.rs `rematerialize_pre_push` does.
    #[test]
    fn execute_bit_literals_match_the_allowlist() {
        let root = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
        let mut files = Vec::new();
        rust_files(root, &mut files);
        let mut counts = std::collections::BTreeMap::new();
        for path in &files {
            let text = std::fs::read_to_string(path)
                .unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            counts.insert(rel, exec_mode_count(&text));
        }
        for required in ["lib.rs", "git/runner.rs", "test_exec.rs"] {
            assert!(
                counts.contains_key(required),
                "the walk missed {required}: {} files read",
                counts.len()
            );
        }
        let mut wrong = Vec::new();
        for (file, &count) in &counts {
            let allowed = EXEC_MODE_SITES
                .iter()
                .find(|(row, ..)| row == file)
                .map_or(0, |&(_, n, _)| n);
            if count != allowed {
                wrong.push(format!(
                    "{file}: {count} literal execute modes, {allowed} allowed"
                ));
            }
        }
        for (row, ..) in EXEC_MODE_SITES {
            if !counts.contains_key(*row) {
                wrong.push(format!("{row}: listed but not found"));
            }
        }
        assert!(
            wrong.is_empty(),
            "{wrong:#?}\nwrite a script a test runs through crate::test_exec::write_executable; \
             the rows count production lines too, and a production writer gets its own row"
        );
    }
}
