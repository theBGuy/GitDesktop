use super::*;

/// The per-branch flags the branch list reads from git config.
#[derive(Debug, Default)]
pub(super) struct BranchFlags {
    pub(super) archived: HashSet<String>,
    pub(super) keep_local: HashSet<String>,
}

/// The branches the user has archived (`branch.<name>.gitdesktopArchived true`) and
/// marked Keep local ([`keep_local_key`]), in one config read. git keeps both in sync
/// across renames and removes them on delete, so they never go stale. A failed read
/// fails the list ([`branch_flags_answer`]): it must not show a marked branch unmarked
/// while the push guard refuses it.
pub(super) async fn read_branch_flags(repo_path: &str) -> AppResult<BranchFlags> {
    let out = run_git_raw(
        Some(repo_path),
        &[
            "config",
            "--get-regexp",
            r"^branch\..*\.gitdesktop(archived|localonly)$",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    branch_flags_answer(&out)
}

/// The verdict over one flag read: exit 1 is "no key matched" whatever stderr carries,
/// since the regex is a constant; any exit other than 0 or 1 is an `Err`.
fn branch_flags_answer(out: &GitOutput) -> AppResult<BranchFlags> {
    match out.code {
        0 => Ok(parse_branch_flags(&out.stdout_lossy())),
        1 => Ok(BranchFlags::default()),
        code => Err(AppError::Git {
            code,
            stderr: out.full_failure_text(),
        }),
    }
}

/// Parses `--get-regexp` lines: `key value`, `key ` for an empty value, bare `key` for
/// a valueless one. Archived keeps its literal `true` rule; Keep local is marked unless
/// git reads the last entry as a definite false, so junk reads marked like the guard.
fn parse_branch_flags(text: &str) -> BranchFlags {
    let mut flags = BranchFlags::default();
    let mut keep_local = std::collections::HashMap::new();
    for line in text.lines() {
        let (key, value) = match line.split_once(' ') {
            Some((key, value)) => (key, Some(value)),
            None => (line, None),
        };
        let Some(rest) = key.strip_prefix("branch.") else {
            continue;
        };
        if let Some(name) = rest.strip_suffix(".gitdesktoparchived") {
            if value.is_some_and(|v| v.trim() == "true") {
                flags.archived.insert(name.to_string());
            }
        } else if let Some(name) = rest.strip_suffix(".gitdesktoplocalonly") {
            let marked = crate::git::diff::git_config_bool(value) != Some(false);
            keep_local.insert(name, marked);
        }
    }
    flags.keep_local = keep_local
        .into_iter()
        .filter(|&(_, marked)| marked)
        .map(|(name, _)| name.to_string())
        .collect();
    flags
}

/// The git config key that marks a branch Keep local. The subsection is the exact
/// branch name (case-sensitive), so only that spelling is marked.
pub(crate) fn keep_local_key(name: &str) -> String {
    format!("branch.{name}.gitdesktopLocalOnly")
}

/// Whether `name` is marked Keep local: the one Rust read, the same command the
/// managed pre-push hook runs, across every config scope. Unset or false allows; any
/// answer git can't give as a bool (junk, an invalid key) is an `Err`, so a guard built
/// on it fails closed. A non-repository reads unset: nothing can be pushed from one.
pub(crate) async fn branch_keep_local(repo_path: &str, name: &str) -> AppResult<bool> {
    branch_keep_local_env(repo_path, name, &[]).await
}

/// [`branch_keep_local`] with extra spawn environment: the tests' per-spawn seam.
async fn branch_keep_local_env(
    repo_path: &str,
    name: &str,
    envs: &[(&str, &str)],
) -> AppResult<bool> {
    let key = keep_local_key(name);
    let out = crate::git::runner::run_git_raw_env(
        Some(repo_path),
        &["config", "--type=bool", "--get", &key],
        envs,
        DEFAULT_TIMEOUT,
    )
    .await?;
    keep_local_answer(&out)
}

/// The verdict over one Keep local read. Exit 1 is "not set" unless git's stderr carries
/// its own `error:`/`fatal:` line (an invalid key): inherited GIT_TRACE* variables put
/// trace lines on stderr of every run, and the runner's LC_ALL=C keeps the prefixes.
fn keep_local_answer(out: &GitOutput) -> AppResult<bool> {
    let stdout = out.stdout_lossy();
    let diagnosed = out.stderr.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("error:") || line.starts_with("fatal:")
    });
    match (out.code, stdout.trim_end_matches(['\r', '\n'])) {
        (0, "true") => Ok(true),
        (0, "false") => Ok(false),
        (1, "") if !diagnosed => Ok(false),
        _ => Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        }),
    }
}

/// Archives/unarchives a branch by setting (or unsetting) a personal,
/// local-config flag, so it's hidden from the dropdown without being deleted.
#[tauri::command]
pub async fn git_set_branch_archived(
    repo_path: String,
    name: String,
    archived: bool,
) -> AppResult<()> {
    set_branch_archived_core(&repo_path, &name, archived).await
}

/// The body of `git_set_branch_archived`.
///
/// No domain lock, only the config-write mutex: the worktree-admin domain is held for a
/// whole removal (minutes on a large tree), so queueing there would turn a second
/// worktree delete into a failed archive for the first. Config writers hold
/// `.git/config.lock` for milliseconds, in this process or another, which the one
/// retry covers.
pub(crate) async fn set_branch_archived_core(
    repo_path: &str,
    name: &str,
    archived: bool,
) -> AppResult<()> {
    // Archiving is held while a publish pushes the branch; unarchiving is not.
    if archived {
        refuse_while_publishing(repo_path, name).await?;
    }
    validate_ref_name(name)?;
    // No current/default-branch refusal here by design: the frontend owns the
    // guard (the current-branch arm is total; the default arm is best-effort,
    // dropping out while defaultName resolves), no MCP tool mutates the flag,
    // and it is fully reversible — a backend default-branch check would also
    // ride the multi-spawn, fallible remote-HEAD resolution per call.
    let key = format!("branch.{name}.gitdesktopArchived");
    let args = if archived {
        ["config", key.as_str(), "true"]
    } else {
        ["config", "--unset-all", key.as_str()]
    };
    let out = run_git_config_write(repo_path, &args, DEFAULT_TIMEOUT).await?;
    // exit 5 = "key not found" — already unarchived, which is fine. `--unset-all`
    // because plain `--unset` ALSO exits 5 on a multi-valued key and removes nothing.
    if out.code == 0 || (!archived && out.code == 5) {
        return Ok(());
    }
    if is_config_lock_contention(&out.stderr) {
        return Err(archive_config_busy(name, archived));
    }
    Err(AppError::Git {
        code: out.code,
        stderr: out.stderr,
    })
}

/// The refusal once the retry ALSO lost the config lock: what happened and what to
/// do, never git's lock-file path.
fn archive_config_busy(name: &str, archived: bool) -> AppError {
    let verb = if archived { "archived" } else { "unarchived" };
    AppError::Command(format!(
        "Another Git process was saving this repository's settings, so {name} wasn't \
         {verb} — try again."
    ))
}

/// Marks or unmarks a branch Keep local (local config), so GitDesktop and its MCP
/// server refuse to push or publish it.
#[tauri::command]
pub async fn git_set_branch_keep_local(
    repo_path: String,
    name: String,
    keep_local: bool,
) -> AppResult<()> {
    set_branch_keep_local_core(&repo_path, &name, keep_local).await
}

/// The body of `git_set_branch_keep_local`, with [`set_branch_archived_core`]'s lock
/// policy. Any local branch may be marked, current and default included. The write is
/// local scope while [`branch_keep_local`] reads every scope, so only a write that read
/// confirms returns Ok; one it contradicts is reported and left in place.
pub(crate) async fn set_branch_keep_local_core(
    repo_path: &str,
    name: &str,
    keep_local: bool,
) -> AppResult<()> {
    validate_ref_name(name)?;
    let key = keep_local_key(name);
    // `--replace-all` and `--unset-all`: a plain set or `--unset` exits 5 on a key a hand
    // edit made multi-valued and writes nothing. Exit 5 on unset is "key not found":
    // already off.
    let args: &[&str] = if keep_local {
        &["config", "--replace-all", &key, "true"]
    } else {
        &["config", "--unset-all", &key]
    };
    let out = run_git_config_write(repo_path, args, DEFAULT_TIMEOUT).await?;
    if out.code != 0 && (keep_local || out.code != 5) {
        if is_config_lock_contention(&out.stderr) {
            let verb = if keep_local { "on" } else { "off" };
            return Err(config_lock_busy(&format!(
                "Keep local wasn't turned {verb} for {name} — try again."
            )));
        }
        return Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        });
    }
    match (keep_local, branch_keep_local(repo_path, name).await?) {
        (false, true) => Err(AppError::Command(format!(
            "Keep local is still on for {name}: it is set outside this repository's own Git \
             config (a global, system, worktree or included config file), so GitDesktop can't \
             turn it off here."
        ))),
        (true, false) => Err(AppError::Command(format!(
            "Keep local is still off for {name}: another Git config scope sets it off (a \
             worktree or included config file), so GitDesktop can't turn it on here."
        ))),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::branches::tests::{
        append_config, branch_section, init_repo, keep_local_repo, run, temp_base,
    };
    use crate::git::runner::TEST_GIT_HANG_GUARD;
    use std::time::Duration;

    async fn archived_flag(repo: &str, branch: &str) -> Option<String> {
        let key = format!("branch.{branch}.gitdesktopArchived");
        let out = run_git_raw(Some(repo), &["config", "--get", &key], TEST_GIT_HANG_GUARD)
            .await
            .unwrap();
        (out.code == 0).then(|| out.stdout_lossy().trim().to_string())
    }

    /// A config lock another writer releases within the retry delay is ridden out on
    /// the real path. Whether the first attempt lands inside the hold depends on spawn
    /// timing; the scripted retry-policy test in `runner` is what pins the policy.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_briefly_held_config_lock_is_ridden_out() {
        let (_base, base) = temp_base("archive-transient-lock");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "feature"]).await;

        let lock = repo.join(".git").join("config.lock");
        std::fs::write(&lock, b"").unwrap();
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            std::fs::remove_file(&lock).unwrap();
        });
        set_branch_archived_core(&repo_s, "feature", true)
            .await
            .expect("the retry lands after the other writer lets go");
        release.await.unwrap();
        assert_eq!(
            archived_flag(&repo_s, "feature").await.as_deref(),
            Some("true")
        );
    }

    /// A config lock held through the retry surfaces the user-register refusal, never
    /// git's lock-file error; released, the same call succeeds, and an unarchive of an
    /// unset flag stays a success.
    #[tokio::test]
    async fn a_held_config_lock_reads_as_try_again_not_a_raw_git_error() {
        let (_base, base) = temp_base("archive-config-lock");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "feature"]).await;

        let lock = repo.join(".git").join("config.lock");
        std::fs::write(&lock, b"").unwrap();
        for archived in [true, false] {
            let err = set_branch_archived_core(&repo_s, "feature", archived)
                .await
                .expect_err("a lock held through the retry refuses");
            assert_eq!(
                err.to_string(),
                archive_config_busy("feature", archived).to_string()
            );
            assert!(!err.to_string().contains("config.lock"), "{err}");
        }

        std::fs::remove_file(&lock).unwrap();
        set_branch_archived_core(&repo_s, "feature", true)
            .await
            .expect("the lock released, the archive lands");
        assert_eq!(
            archived_flag(&repo_s, "feature").await.as_deref(),
            Some("true")
        );
        for _ in 0..2 {
            set_branch_archived_core(&repo_s, "feature", false)
                .await
                .expect("unarchiving, twice, succeeds");
        }
        assert_eq!(archived_flag(&repo_s, "feature").await, None);
    }

    /// A flag that somehow carries two values (a hand edit, another tool) is fully
    /// cleared: plain `--unset` exits 5 on it, the same code as "not set", and removes
    /// nothing.
    #[tokio::test]
    async fn unarchiving_clears_a_multi_valued_flag() {
        let (_base, base) = temp_base("archive-multi-value");
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let repo_s = repo.to_string_lossy().into_owned();
        init_repo(&repo_s, "a.txt").await;
        run(&repo_s, &["branch", "feature"]).await;
        for _ in 0..2 {
            run(
                &repo_s,
                &[
                    "config",
                    "--add",
                    "branch.feature.gitdesktopArchived",
                    "true",
                ],
            )
            .await;
        }
        assert!(git_branches(repo_s.clone())
            .await
            .unwrap()
            .iter()
            .any(|b| b.name == "feature" && b.archived));

        set_branch_archived_core(&repo_s, "feature", false)
            .await
            .expect("unarchiving a multi-valued flag succeeds");
        assert!(git_branches(repo_s.clone())
            .await
            .unwrap()
            .iter()
            .any(|b| b.name == "feature" && !b.archived));
    }

    #[test]
    fn the_config_busy_refusal_names_the_branch_and_the_retry() {
        assert_eq!(
            archive_config_busy("feat/x", true).to_string(),
            "Another Git process was saving this repository's settings, so feat/x wasn't \
             archived — try again."
        );
        assert!(archive_config_busy("feat/x", false)
            .to_string()
            .contains("feat/x wasn't unarchived — try again."));
    }

    async fn listed_keep_local(repo: &str, name: &str) -> bool {
        git_branches(repo.to_string())
            .await
            .unwrap()
            .iter()
            .find(|b| b.name == name)
            .unwrap_or_else(|| panic!("{name} listed"))
            .keep_local
    }

    #[test]
    fn keep_local_list_parse_reads_git_bools_and_the_last_entry() {
        use super::parse_branch_flags;
        let key = |name: &str| super::keep_local_key(name).to_ascii_lowercase();
        assert_eq!(
            super::keep_local_key("rel/1.2"),
            "branch.rel/1.2.gitdesktopLocalOnly"
        );
        let marked = ["true", "yes", "on", "1", "TRUE", "maybe"];
        let unmarked = ["false", "no", "off", "0", ""];
        for value in marked {
            let text = format!("{} {value}\n", key("rel/1.2"));
            assert!(
                parse_branch_flags(&text).keep_local.contains("rel/1.2"),
                "{value:?}"
            );
        }
        for value in unmarked {
            let text = format!("{} {value}\n", key("rel/1.2"));
            assert!(parse_branch_flags(&text).keep_local.is_empty(), "{value:?}");
        }
        // A valueless key is git's true.
        assert!(parse_branch_flags(&format!("{}\n", key("x")))
            .keep_local
            .contains("x"));
        // The last entry wins, a junk-first pair included (the named asymmetry: the
        // guard's `--type=bool --get` fails on the junk entry; the list reads `false`).
        for (first, last, expect) in [
            ("true", "false", false),
            ("false", "true", true),
            ("maybe", "true", true),
            ("maybe", "false", false),
        ] {
            let text = format!("{k} {first}\n{k} {last}\n", k = key("x"));
            assert_eq!(
                parse_branch_flags(&text).keep_local.contains("x"),
                expect,
                "{first} then {last}"
            );
        }
        // Archived keeps its literal rule, beside a Keep local entry for another name.
        let text = format!(
            "branch.a.gitdesktoparchived true\nbranch.b.gitdesktoparchived yes\n\
             branch.c.gitdesktoparchived\n{} true\n",
            key("d")
        );
        let flags = parse_branch_flags(&text);
        assert_eq!(flags.archived, HashSet::from(["a".to_string()]));
        assert_eq!(flags.keep_local, HashSet::from(["d".to_string()]));
    }

    /// The guard's read and the list agree on every value git can hold, except the named
    /// junk-first asymmetry, where the read fails closed.
    #[tokio::test]
    async fn keep_local_read_and_list_agree_on_real_config() {
        let (_guard, base, repo_s) = keep_local_repo("keep-local-read").await;
        run(&repo_s, &["branch", "x"]).await;
        let key = super::keep_local_key("x");
        let reset = |repo_s: String, key: String| async move {
            run_git_raw(
                Some(&repo_s),
                &["config", "--unset-all", &key],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
        };

        assert!(
            !super::branch_keep_local(&repo_s, "x").await.unwrap(),
            "unset"
        );
        assert!(!listed_keep_local(&repo_s, "x").await);
        for (values, read, listed) in [
            (&["true"][..], Some(true), true),
            (&["yes"][..], Some(true), true),
            (&["false"][..], Some(false), false),
            (&[""][..], Some(false), false),
            (&["maybe"][..], None, true),
            (&["true", "false"][..], Some(false), false),
            (&["maybe", "true"][..], None, true),
            (&["maybe", "false"][..], None, false),
        ] {
            reset(repo_s.clone(), key.clone()).await;
            for value in values {
                run(&repo_s, &["config", "--add", &key, value]).await;
            }
            let got = super::branch_keep_local(&repo_s, "x").await;
            match read {
                Some(expect) => assert_eq!(got.unwrap(), expect, "{values:?}"),
                None => {
                    let err = got.expect_err("junk fails closed");
                    assert!(
                        err.to_string().contains("bad boolean config value"),
                        "{values:?}: {err}"
                    );
                }
            }
            assert_eq!(listed_keep_local(&repo_s, "x").await, listed, "{values:?}");
        }
        // A valueless key reads true on both.
        reset(repo_s.clone(), key.clone()).await;
        append_config(&repo_s, "[branch \"x\"]\n\tgitdesktopLocalOnly\n");
        assert!(super::branch_keep_local(&repo_s, "x").await.unwrap());
        assert!(listed_keep_local(&repo_s, "x").await);

        // Exact-name match: the subsection is case-sensitive.
        assert!(!super::branch_keep_local(&repo_s, "X").await.unwrap());
        // An invalid key (exit 1 WITH stderr) is an error, not unset.
        super::branch_keep_local(&repo_s, "x\ny")
            .await
            .expect_err("an invalid key is not 'unset'");
        // git exits 1 silently outside a repository; no route can push from one.
        let plain = base.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(
            !super::branch_keep_local(&plain.to_string_lossy(), "x")
                .await
                .expect("a non-repository reads as unmarked, not an error"),
            "a non-repository reads as unmarked"
        );
    }

    /// Exit 1 reads "not set" through trace output on stderr, and fails closed only on
    /// git's own `error:`/`fatal:` line.
    #[test]
    fn keep_local_answer_reads_exit_1_through_trace_lines() {
        let out = |code: i32, stdout: &str, stderr: &str| crate::git::runner::GitOutput {
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.to_string(),
            code,
        };
        let trace = "11:32:43.281828 exec-cmd.c:266    trace: resolved executable dir: C:/git\n\
                     11:32:43.283829 git.c:502         trace: built-in: git config --get k\n";
        let invalid = format!("{trace}error: key does not contain a section: k\n");
        for (row, given, expect) in [
            ("true", out(0, "true\n", ""), Some(true)),
            ("false", out(0, "false\n", ""), Some(false)),
            ("unset", out(1, "", ""), Some(false)),
            ("unset under GIT_TRACE", out(1, "", trace), Some(false)),
            (
                "invalid key",
                out(1, "", "error: invalid key (newline): branch.x\ny.k\n"),
                None,
            ),
            ("invalid key under GIT_TRACE", out(1, "", &invalid), None),
            ("exit 1 with stdout", out(1, "true\n", ""), None),
            ("fatal", out(128, "", "fatal: bad boolean value\n"), None),
            ("junk", out(0, "maybe\n", ""), None),
        ] {
            match (super::keep_local_answer(&given), expect) {
                (Ok(got), Some(want)) => assert_eq!(got, want, "{row}"),
                (Err(AppError::Git { .. }), None) => {}
                (got, _) => panic!("{row}: {got:?}"),
            }
        }
    }

    /// The branch list's flag read takes only exit 1 as "no flags" (trace lines on
    /// stderr included); any other failed read fails the list instead of hiding a mark.
    #[test]
    fn branch_flags_answer_reads_only_exit_1_as_empty() {
        let out = |code: i32, stdout: &str, stderr: &str| crate::git::runner::GitOutput {
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.to_string(),
            code,
        };
        let trace = "11:32:43.283829 git.c:502         trace: built-in: git config --get-regexp\n";
        let marked = out(0, "branch.x.gitdesktoplocalonly true\n", "");
        let flags = super::branch_flags_answer(&marked).unwrap();
        assert_eq!(
            flags.keep_local,
            std::collections::HashSet::from(["x".to_string()])
        );
        assert!(flags.archived.is_empty());
        for (row, given) in [
            ("no match", out(1, "", "")),
            ("no match under GIT_TRACE", out(1, "", trace)),
        ] {
            let flags =
                super::branch_flags_answer(&given).unwrap_or_else(|e| panic!("{row}: {e:?}"));
            assert!(
                flags.keep_local.is_empty() && flags.archived.is_empty(),
                "{row}"
            );
        }
        for (row, given) in [
            (
                "error",
                out(3, "", "error: could not lock config file .git/config\n"),
            ),
            (
                "fatal",
                out(128, "", "fatal: bad config line 1 in file .git/config\n"),
            ),
            ("invalid regex", out(6, "", "error: invalid pattern\n")),
        ] {
            match super::branch_flags_answer(&given) {
                Err(AppError::Git { code, .. }) => assert_eq!(code, given.code, "{row}"),
                got => panic!("{row}: {got:?}"),
            }
        }
    }

    /// A real read with GIT_TRACE in the spawn's environment still answers the mark.
    #[tokio::test]
    async fn keep_local_read_answers_under_git_trace() {
        let (_guard, _base, repo_s) = keep_local_repo("keep-local-trace").await;
        run(&repo_s, &["branch", "x"]).await;
        for var in ["GIT_TRACE", "GIT_TRACE2", "GIT_TRACE_SETUP"] {
            let envs = [(var, "1")];
            let traced = crate::git::runner::run_git_raw_env(
                Some(&repo_s),
                &["config", "--get", &super::keep_local_key("x")],
                &envs,
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
            assert!(!traced.stderr.trim().is_empty(), "{var} reaches the spawn");
            let unmarked = super::branch_keep_local_env(&repo_s, "x", &envs).await;
            assert!(!unmarked.expect("unmarked under trace"), "{var}");
            super::branch_keep_local_env(&repo_s, "x\ny", &envs)
                .await
                .expect_err("an invalid key still fails closed under trace");
        }
        super::set_branch_keep_local_core(&repo_s, "x", true)
            .await
            .unwrap();
        let envs = [("GIT_TRACE", "1")];
        assert!(super::branch_keep_local_env(&repo_s, "x", &envs)
            .await
            .expect("marked under trace"));
    }

    /// Both directions on the current branch, a branch that is the remote default, and a
    /// dotted name; the read follows each write, and a repeat turn-off stays Ok.
    #[tokio::test]
    async fn keep_local_setter_round_trips_and_the_read_follows() {
        let (_guard, _base, repo_s) = keep_local_repo("keep-local-set").await;
        run(&repo_s, &["remote", "add", "origin", &repo_s]).await;
        run(&repo_s, &["update-ref", "refs/remotes/origin/main", "HEAD"]).await;
        run(
            &repo_s,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        )
        .await;
        run(&repo_s, &["branch", "rel/1.2"]).await;
        run(
            &repo_s,
            &["branch", "--set-upstream-to", "origin/main", "main"],
        )
        .await;
        let main = git_branches(repo_s.clone()).await.unwrap();
        let main = main.iter().find(|b| b.name == "main").unwrap();
        assert!(
            main.is_current && main.upstream_is_remote_default,
            "{main:?}"
        );

        for name in ["main", "rel/1.2"] {
            super::set_branch_keep_local_core(&repo_s, name, true)
                .await
                .expect("turn on");
            assert!(super::branch_keep_local(&repo_s, name).await.unwrap());
            assert!(listed_keep_local(&repo_s, name).await);
            for _ in 0..2 {
                super::set_branch_keep_local_core(&repo_s, name, false)
                    .await
                    .expect("turn off, twice");
            }
            assert!(!super::branch_keep_local(&repo_s, name).await.unwrap());
            assert!(!listed_keep_local(&repo_s, name).await);
        }
        // A multi-valued local flag is fully cleared.
        let key = super::keep_local_key("main");
        run(&repo_s, &["config", "--add", &key, "true"]).await;
        run(&repo_s, &["config", "--add", &key, "true"]).await;
        super::set_branch_keep_local_core(&repo_s, "main", false)
            .await
            .expect("clears a multi-valued flag");
        assert!(!super::branch_keep_local(&repo_s, "main").await.unwrap());
        // A doubled local flag turns on too (a plain set exits 5 there), leaving one value.
        run(&repo_s, &["config", "--add", &key, "false"]).await;
        run(&repo_s, &["config", "--add", &key, "false"]).await;
        super::set_branch_keep_local_core(&repo_s, "main", true)
            .await
            .expect("turns on a multi-valued flag");
        assert!(super::branch_keep_local(&repo_s, "main").await.unwrap());
        assert_eq!(
            run(&repo_s, &["config", "--local", "--get-all", &key]).await,
            "true\n"
        );
        // An invalid name never reaches a config key.
        let err = super::set_branch_keep_local_core(&repo_s, "a b", true)
            .await
            .expect_err("invalid name");
        assert!(matches!(err, AppError::InvalidArgument(_)), "{err:?}");
    }

    /// A mark set in an included file survives a local turn-off: the setter says so
    /// and the read still refuses. Twin: a local mark turns off with Ok.
    #[tokio::test]
    async fn keep_local_setter_reports_a_mark_set_in_another_scope() {
        let (_guard, base, repo_s) = keep_local_repo("keep-local-scope-off").await;
        run(&repo_s, &["branch", "x"]).await;
        run(&repo_s, &["branch", "y"]).await;
        let inc = base.join("inc.gitconfig");
        std::fs::write(&inc, "[branch \"x\"]\n\tgitdesktopLocalOnly = true\n").unwrap();
        let inc_s = inc.to_string_lossy().replace('\\', "/");
        run(&repo_s, &["config", "include.path", &inc_s]).await;

        let err = super::set_branch_keep_local_core(&repo_s, "x", false)
            .await
            .expect_err("the included mark still reads marked");
        assert!(
            matches!(&err, AppError::Command(m) if m == "Keep local is still on for x: it is \
                set outside this repository's own Git config (a global, system, worktree or \
                included config file), so GitDesktop can't turn it off here."),
            "{err:?}"
        );
        assert!(super::branch_keep_local(&repo_s, "x").await.unwrap());

        super::set_branch_keep_local_core(&repo_s, "y", true)
            .await
            .unwrap();
        super::set_branch_keep_local_core(&repo_s, "y", false)
            .await
            .expect("a local mark turns off");
        assert!(!super::branch_keep_local(&repo_s, "y").await.unwrap());
    }

    /// An included `false` after the branch's own section outranks a local turn-on: the
    /// setter says so, the write stays, and the read allows. Twin: no include, Ok.
    #[tokio::test]
    async fn keep_local_setter_reports_an_off_set_in_another_scope() {
        let (_guard, base, repo_s) = keep_local_repo("keep-local-scope-on").await;
        run(&repo_s, &["branch", "x"]).await;
        run(&repo_s, &["branch", "y"]).await;
        run(&repo_s, &["config", "branch.x.remote", "origin"]).await;
        let inc = base.join("inc.gitconfig");
        std::fs::write(&inc, "[branch \"x\"]\n\tgitdesktopLocalOnly = false\n").unwrap();
        let inc_s = inc.to_string_lossy().replace('\\', "/");
        run(&repo_s, &["config", "include.path", &inc_s]).await;

        let err = super::set_branch_keep_local_core(&repo_s, "x", true)
            .await
            .expect_err("the included false still reads unmarked");
        assert!(
            matches!(&err, AppError::Command(m) if m == "Keep local is still off for x: another \
                Git config scope sets it off (a worktree or included config file), so \
                GitDesktop can't turn it on here."),
            "{err:?}"
        );
        assert!(!super::branch_keep_local(&repo_s, "x").await.unwrap());
        let local = run_git_raw(
            Some(&repo_s),
            &["config", "--local", "--get", &super::keep_local_key("x")],
            TEST_GIT_HANG_GUARD,
        )
        .await
        .unwrap();
        assert_eq!(
            local.stdout_lossy().trim(),
            "true",
            "the local write is kept"
        );

        super::set_branch_keep_local_core(&repo_s, "y", true)
            .await
            .expect("no include: the mark takes");
        assert!(super::branch_keep_local(&repo_s, "y").await.unwrap());
    }

    /// A config lock held through the retry reads as the try-again copy, both ways.
    #[tokio::test]
    async fn keep_local_setter_held_config_lock_reads_try_again() {
        let (_guard, _base, repo_s) = keep_local_repo("keep-local-lock").await;
        let lock = std::path::Path::new(&repo_s)
            .join(".git")
            .join("config.lock");
        std::fs::write(&lock, b"").unwrap();
        for (on, verb) in [(true, "on"), (false, "off")] {
            let err = super::set_branch_keep_local_core(&repo_s, "main", on)
                .await
                .expect_err("a held lock refuses");
            assert!(
                matches!(&err, AppError::Command(m) if *m == format!(
                    "Another Git process was saving this repository's settings, so Keep \
                     local wasn't turned {verb} for main — try again."
                )),
                "{err:?}"
            );
        }
        std::fs::remove_file(&lock).unwrap();
    }

    /// git moves the whole `branch.<name>` section on rename and drops it on delete.
    #[tokio::test]
    async fn keep_local_flag_follows_rename_and_delete() {
        let (_guard, _base, repo_s) = keep_local_repo("keep-local-rename").await;
        run(&repo_s, &["branch", "old"]).await;
        super::set_branch_keep_local_core(&repo_s, "old", true)
            .await
            .unwrap();
        run(&repo_s, &["branch", "-m", "--", "old", "new"]).await;
        assert_eq!(branch_section(&repo_s, "old").await, "");
        let moved = branch_section(&repo_s, "new").await;
        assert!(moved.contains("gitdesktoplocalonly true"), "{moved}");
        assert!(super::branch_keep_local(&repo_s, "new").await.unwrap());
        run(&repo_s, &["branch", "-D", "--", "new"]).await;
        assert_eq!(branch_section(&repo_s, "new").await, "");
        assert!(!super::branch_keep_local(&repo_s, "new").await.unwrap());
    }

    #[test]
    fn keep_local_branch_serializes_camel_case_fields() {
        let branch = crate::git::types::Branch {
            name: "x".into(),
            is_current: false,
            upstream: None,
            last_commit_date: String::new(),
            archived: false,
            upstream_ahead: 0,
            upstream_behind: 0,
            upstream_gone: false,
            upstream_remote: None,
            upstream_remote_ref: None,
            keep_local: true,
            upstream_is_remote_default: true,
            renamed_from_upstream: true,
            named_push_remote: Some("origin".into()),
            named_push_branch: Some("x".into()),
            named_push_refused: true,
        };
        let value = serde_json::to_value(&branch).unwrap();
        for (key, expected) in [
            ("renamedFromUpstream", serde_json::json!(true)),
            ("namedPushRemote", serde_json::json!("origin")),
            ("namedPushBranch", serde_json::json!("x")),
            ("namedPushRefused", serde_json::json!(true)),
        ] {
            assert_eq!(value.get(key), Some(&expected), "{key}");
        }
        for snake in [
            "renamed_from_upstream",
            "named_push_remote",
            "named_push_branch",
            "named_push_refused",
        ] {
            assert!(value.get(snake).is_none(), "{snake}");
        }
        let object = value.as_object().unwrap();
        assert_eq!(object.get("keepLocal"), Some(&serde_json::json!(true)));
        assert_eq!(
            object.get("upstreamIsRemoteDefault"),
            Some(&serde_json::json!(true))
        );
        assert!(!object.contains_key("keep_local"));
        assert!(!object.contains_key("upstream_is_remote_default"));
    }
}
