//! Ignored local data survives checkout merges: refuse before any merge or stash push.
//! This reaches Pull (ff-only/merge), Merge (squash, no-ff, -X), current-branch Update
//! from default/upstream, fork Update from upstream, and stash-and-reapply retries.
//!
//! Local-PR finalization and MCP merge_branch/pull in merge modes share these checks.
//! A merge that runs the check waits up to `NETWORK_LOCK_WAIT_TIMEOUT` for a running fetch.
//! Candidate and ignore probes add 1–3 git spawns, plus worktree-root, HEAD, merge-base and
//! target resolution.
//!
//! Checkout/switch, rebase/cherry-pick/revert, rebase-mode pulls, MCP rebase/decision
//! modes, stash operations and the deliberate reset --hard paths remain outside this guard.
//!
//! External tools can write between check and merge; criss-cross histories use one
//! merge base. Non-UTF-8 names are lossy, and ort directory-rename relocation is unprobed.
//! Bare pull cannot check commits that its own transfer brings into the repository.

use std::collections::HashSet;
use std::time::Duration;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git, run_git_raw};

/// Bind names to the worktree root; the caller holds the WT lock through its write.
/// Probe incoming changes since the merge base except deletions; unborn HEAD uses the whole tree.
/// Born, unrelated histories need no check: git refuses them before any merge can overwrite files.
/// Adds count, as do modifies/type changes of locally deleted paths:
/// their conflicts overwrite ignored data, then merge --abort deletes it (measured, git 2.51.1).
/// File/symlink ancestors count because merge replaces them with directories; directory
/// ancestors only receive files. Tracked paths never qualify because check-ignore skips them.
/// A candidate directory counts if ignored itself or holding ignored files (measured).
/// 3-way merges ignore --no-overwrite-ignore (measured, git 2.51.1); runners must stay lock-free.
pub(crate) async fn ignored_files_in_the_way(
    repo_path: &str,
    incoming_sha: &str,
    timeout: Duration,
) -> AppResult<Vec<String>> {
    let toplevel = crate::git::runner::worktree_toplevel(repo_path).await?;
    let holder = toplevel.as_str();
    let whole_tree = if crate::git::branches::head_is_unborn(holder).await? {
        true
    } else {
        let base =
            run_git_raw(Some(holder), &["merge-base", "HEAD", incoming_sha], timeout).await?;
        match base.code {
            0 => false,
            1 => return Ok(Vec::new()),
            code => {
                return Err(AppError::Git {
                    code,
                    stderr: base.full_failure_text(),
                })
            }
        }
    };
    let changed = if whole_tree {
        run_git(
            Some(holder),
            &["ls-tree", "-r", "-z", "--name-only", incoming_sha],
            timeout,
        )
        .await?
    } else {
        run_git(
            Some(holder),
            &[
                "diff",
                "--no-relative",
                "--name-only",
                "--no-renames",
                "--diff-filter=d",
                "-z",
                &format!("HEAD...{incoming_sha}"),
            ],
            timeout,
        )
        .await?
    };
    let dir = std::path::Path::new(holder);
    let changed = changed.stdout_lossy();
    // Diff paths are unique and, being one tree's, never a prefix of each other, so the
    // prefix memo is the only dedupe needed: a repeat prefix was already classified.
    let mut probed = HashSet::new();
    let (mut files, mut folders): (Vec<&str>, Vec<&str>) = (Vec::new(), Vec::new());
    for path in changed.split('\0').filter(|p| !p.is_empty()) {
        for (at, _) in path.match_indices('/') {
            let prefix = &path[..at];
            let file = || {
                dir.join(prefix)
                    .symlink_metadata()
                    .is_ok_and(|m| !m.is_dir())
            };
            if probed.insert(prefix) && file() {
                files.push(prefix);
            }
        }
        match dir.join(path).symlink_metadata() {
            Ok(meta) if meta.is_dir() => folders.push(path),
            Ok(_) => files.push(path),
            Err(_) => {}
        }
    }

    let mut in_the_way = Vec::new();
    if !files.is_empty() {
        let checked = crate::git::runner::run_git_raw_input(
            Some(holder),
            &["check-ignore", "--stdin", "-z"],
            Some(&files.join("\0")),
            timeout,
        )
        .await?;
        // Exit 1 is git's "none of these is ignored"; anything past it is a failure.
        match checked.code {
            0 => in_the_way.extend(nul_separated(&checked.stdout_lossy())),
            1 => {}
            code => {
                return Err(AppError::Git {
                    code,
                    stderr: checked.full_failure_text(),
                })
            }
        }
    }
    if !folders.is_empty() {
        // `check-ignore` on a folder's own name misses one that is not ignored itself but
        // holds ignored files. This lists an ignored folder as `<dir>/`, else the ignored
        // files inside, and for a folder of ONLY ignored files both (measured).
        let specs: Vec<String> = folders
            .iter()
            .map(|f| crate::git::pathspec::literal(f))
            .collect();
        let mut args = vec![
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
            "--",
        ];
        args.extend(specs.iter().map(String::as_str));
        let listed = run_git_raw(Some(holder), &args, timeout).await?;
        if listed.code != 0 {
            return Err(AppError::Git {
                code: listed.code,
                stderr: listed.full_failure_text(),
            });
        }
        let listed = nul_separated(&listed.stdout_lossy());
        // A `<dir>/` entry with its own contents listed beside it names nothing new.
        let covered = |p: &String| {
            p.ends_with('/')
                && listed
                    .iter()
                    .any(|q| q.len() > p.len() && q.starts_with(p.as_str()))
        };
        in_the_way.extend(listed.iter().filter(|p| !covered(p)).cloned());
    }
    Ok(in_the_way)
}

/// The non-empty entries of git's `-z` output.
fn nul_separated(text: &str) -> Vec<String> {
    text.split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

/// The first three paths, then a count of the rest.
pub(crate) fn name_paths(paths: &[String]) -> String {
    const NAMED: usize = 3;
    let named = paths
        .iter()
        .take(NAMED)
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join(", ");
    match paths.len().saturating_sub(NAMED) {
        0 => named,
        more => format!("{named} and {more} more"),
    }
}

pub(crate) fn check_failed(op: &str, e: AppError) -> AppError {
    AppError::Command(format!(
        "{op} stopped: couldn't check for ignored files it would replace, so your branch and files are unchanged. Try again in a moment.\n{e}"
    ))
}

pub(crate) fn merge_refusal(branch: &str, paths: &[String]) -> AppError {
    AppError::Command(format!(
        "Merging {branch} would replace ignored files in your working tree: {}. Move them aside, then merge again. Nothing was changed.",
        name_paths(paths)
    ))
}

pub(crate) fn update_refusal(branch: &str, base: &str, paths: &[String]) -> AppError {
    AppError::Command(format!(
        "Updating {branch} from {base} would replace ignored files in your working tree: {}. Move them aside, then update again. {branch} is unchanged.",
        name_paths(paths)
    ))
}

pub(crate) fn pull_refusal(paths: &[String]) -> AppError {
    AppError::Command(format!(
        "The incoming commits would replace ignored files in your working tree: {}. Move them aside, then pull again. Your branch and files are unchanged.",
        name_paths(paths)
    ))
}

pub(crate) fn finalize_refusal(base: &str, worktree: Option<&str>, paths: &[String]) -> AppError {
    let paths = name_paths(paths);
    AppError::Command(match worktree {
        Some(worktree) => format!(
            "{base} is checked out at {worktree}, where fast-forwarding it would replace ignored files: {paths}. Move them aside, then try again. {base} is unchanged."
        ),
        None => format!(
            "Fast-forwarding {base} would replace ignored files in your working tree: {paths}. Move them aside, then try again. {base} is unchanged."
        ),
    })
}

/// Resolve under the caller's WT and network holds; the merge still takes the ref for its subject.
/// An unresolved ref skips the guard so git's own merge refusal supplies the error.
pub(crate) async fn target_commit(
    repo: &str,
    rev: &str,
    timeout: Duration,
    op: &str,
) -> AppResult<Option<String>> {
    let out = run_git_raw(
        Some(repo),
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("{rev}^{{commit}}"),
        ],
        timeout,
    )
    .await
    .map_err(|e| check_failed(op, e))?;
    Ok((out.code == 0).then(|| out.stdout_lossy().trim().to_string()))
}

/// Only these markers and an unmerged index stop git merge itself (measured, git 2.51.1).
/// REVERT_HEAD and sequencer-only states still need the ignored-file guard.
pub(crate) async fn merge_is_blocked(repo: &str, unmerged: &[String]) -> AppResult<bool> {
    if !unmerged.is_empty() {
        return Ok(true);
    }
    let root = crate::git::runner::worktree_toplevel(repo).await?;
    Ok(
        crate::git::ops::resolve_git_admin_dir(std::path::Path::new(&root)).is_some_and(|dir| {
            dir.join("MERGE_HEAD").exists() || dir.join("CHERRY_PICK_HEAD").exists()
        }),
    )
}

/// A non-fast-forward refusal precedes the ignored-file check, just as git refuses it.
pub(crate) async fn pull_can_merge(
    repo: &str,
    incoming_sha: &str,
    ff_only: bool,
) -> AppResult<bool> {
    if crate::git::branches::head_is_unborn(repo)
        .await
        .map_err(|e| check_failed("Pull", e))?
        || !ff_only
    {
        return Ok(true);
    }
    let out = run_git_raw(
        Some(repo),
        &["merge-base", "--is-ancestor", "HEAD", incoming_sha],
        crate::git::runner::WORKTREE_OP_TIMEOUT,
    )
    .await
    .map_err(|e| check_failed("Pull", e))?;
    match out.code {
        0 => Ok(true),
        1 => Ok(false),
        code => Err(check_failed(
            "Pull",
            AppError::Git {
                code,
                stderr: out.full_failure_text(),
            },
        )),
    }
}

/// Bare pull can only check the upstream already present before its own transfer.
/// A failed probe refuses like every other guard step; only a non-zero exit means none.
pub(crate) async fn upstream_commit(repo: &str) -> AppResult<Option<String>> {
    upstream_commit_within(repo, crate::git::runner::WORKTREE_OP_TIMEOUT).await
}

async fn upstream_commit_within(repo: &str, timeout: Duration) -> AppResult<Option<String>> {
    let out = run_git_raw(
        Some(repo),
        &["rev-parse", "--verify", "--quiet", "@{upstream}^{commit}"],
        timeout,
    )
    .await
    .map_err(|e| check_failed("Pull", e))?;
    Ok((out.code == 0).then(|| out.stdout_lossy().trim().to_string()))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::git::runner::DEFAULT_TIMEOUT;
    use std::path::Path;

    pub(crate) const SENTINEL: &[u8] = b"private local bytes\0keep me\n";

    #[derive(Clone, Copy, Debug, PartialEq)]
    pub(crate) enum Shape {
        IgnoredFile,
        ModifyDelete,
        IgnoredDirVsFile,
        PatternIgnoredFolder,
        InsideIgnoredDir,
    }

    pub(crate) const SHAPES: [Shape; 5] = [
        Shape::IgnoredFile,
        Shape::ModifyDelete,
        Shape::IgnoredDirVsFile,
        Shape::PatternIgnoredFolder,
        Shape::InsideIgnoredDir,
    ];

    pub(crate) async fn run(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
            .trim()
            .to_string()
    }

    pub(crate) struct Fixture {
        pub dir: tempfile::TempDir,
        pub repo: String,
        pub target: String,
        pub head: String,
        pub ignored: &'static str,
        pub named: &'static str,
        pub incoming: &'static str,
        pub stash: String,
        shape: Shape,
        index: String,
        porcelain: String,
        orig_head: Option<Vec<u8>>,
    }

    impl Fixture {
        pub(crate) async fn new(shape: Shape, diverged: bool) -> Self {
            let dir = tempfile::Builder::new()
                .prefix("gd-ignored-")
                .tempdir()
                .unwrap();
            let repo = dir.path().join("repo");
            std::fs::create_dir(&repo).unwrap();
            let repo = repo.to_string_lossy().into_owned();
            run(&repo, &["init", "-q", "-b", "local"]).await;
            run(&repo, &["config", "user.name", "Test"]).await;
            run(&repo, &["config", "user.email", "test@example.com"]).await;
            run(&repo, &["config", "commit.gpgsign", "false"]).await;
            run(&repo, &["config", "core.autocrlf", "false"]).await;
            let (pattern, ignored, named, incoming) = match shape {
                Shape::IgnoredFile => ("local.cfg", "local.cfg", "local.cfg", "local.cfg"),
                Shape::ModifyDelete => ("seed.txt", "seed.txt", "seed.txt", "seed.txt"),
                Shape::IgnoredDirVsFile => ("build/", "build/out.txt", "build/", "build"),
                Shape::PatternIgnoredFolder => ("*.log", "logs/run.log", "logs/run.log", "logs"),
                Shape::InsideIgnoredDir => ("logs/", "logs/run.log", "", "logs/keep.txt"),
            };
            std::fs::write(Path::new(&repo).join(".gitignore"), format!("{pattern}\n")).unwrap();
            std::fs::write(Path::new(&repo).join("tracked.txt"), "seed\n").unwrap();
            if shape == Shape::ModifyDelete {
                std::fs::write(Path::new(&repo).join("seed.txt"), "seed\n").unwrap();
                run(&repo, &["add", "-f", "seed.txt"]).await;
            }
            run(&repo, &["add", ".gitignore", "tracked.txt"]).await;
            run(&repo, &["commit", "-qm", "seed"]).await;
            run(&repo, &["branch", "incoming"]).await;
            if shape == Shape::ModifyDelete {
                // A committed local deletion necessarily diverges from the modifying side.
                run(&repo, &["rm", "seed.txt"]).await;
                run(&repo, &["commit", "-qm", "delete seed"]).await;
            } else if diverged {
                std::fs::write(Path::new(&repo).join("local.txt"), "local commit\n").unwrap();
                run(&repo, &["add", "local.txt"]).await;
                run(&repo, &["commit", "-qm", "local commit"]).await;
            }
            let head = run(&repo, &["rev-parse", "HEAD"]).await;
            run(&repo, &["switch", "-q", "incoming"]).await;
            let path = Path::new(&repo).join(incoming);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "incoming bytes\n").unwrap();
            run(&repo, &["add", "-f", incoming]).await;
            run(&repo, &["commit", "-qm", "incoming file"]).await;
            let target = run(&repo, &["rev-parse", "HEAD"]).await;
            run(&repo, &["switch", "-q", "local"]).await;
            let local = Path::new(&repo).join(ignored);
            std::fs::create_dir_all(local.parent().unwrap()).unwrap();
            std::fs::write(local, SENTINEL).unwrap();
            let stash = run(&repo, &["stash", "list"]).await;
            let mut fixture = Self {
                dir,
                repo,
                target,
                head,
                ignored,
                named,
                incoming,
                stash,
                shape,
                index: String::new(),
                porcelain: String::new(),
                orig_head: None,
            };
            fixture.snapshot().await;
            fixture
        }

        pub(crate) async fn with_remote(&self) {
            let remote = self
                .dir
                .path()
                .join("remote.git")
                .to_string_lossy()
                .into_owned();
            run(&self.repo, &["clone", "--bare", &self.repo, &remote]).await;
            run(&self.repo, &["remote", "add", "origin", &remote]).await;
            run(
                &self.repo,
                &["update-ref", "refs/remotes/origin/incoming", &self.head],
            )
            .await;
            run(&self.repo, &["config", "branch.local.remote", "origin"]).await;
            run(
                &self.repo,
                &["config", "branch.local.merge", "refs/heads/incoming"],
            )
            .await;
        }

        pub(crate) async fn snapshot(&mut self) {
            self.index = run(&self.repo, &["ls-files", "-s"]).await;
            self.porcelain = run(&self.repo, &["status", "--porcelain=v1"]).await;
            let admin = run(&self.repo, &["rev-parse", "--absolute-git-dir"]).await;
            self.orig_head = std::fs::read(Path::new(&admin).join("ORIG_HEAD")).ok();
        }

        pub(crate) async fn assert_snapshot(&self) {
            assert_eq!(
                run(&self.repo, &["ls-files", "-s"]).await,
                self.index,
                "index changed"
            );
            assert_eq!(
                run(&self.repo, &["status", "--porcelain=v1"]).await,
                self.porcelain,
                "porcelain changed"
            );
            let admin = run(&self.repo, &["rev-parse", "--absolute-git-dir"]).await;
            assert!(!Path::new(&admin).join("SQUASH_MSG").exists());
            assert_eq!(
                std::fs::read(Path::new(&admin).join("ORIG_HEAD")).ok(),
                self.orig_head,
                "ORIG_HEAD changed"
            );
        }

        pub(crate) fn remove_ignored(&self) {
            let path = Path::new(&self.repo).join(self.ignored);
            std::fs::remove_file(&path).unwrap();
            let parent = path.parent().unwrap();
            if parent != Path::new(&self.repo) {
                std::fs::remove_dir(parent).unwrap();
            }
        }

        pub(crate) async fn assert_unchanged(&self, err: &AppError) {
            let AppError::Command(message) = err else {
                panic!("expected Command, got {err:?}");
            };
            assert!(message.contains(self.named), "{message}");
            assert!(message.contains("would replace ignored files"), "{message}");
            self.assert_intact().await;
        }

        pub(crate) async fn assert_intact(&self) {
            self.assert_snapshot().await;
            assert_eq!(
                std::fs::read(Path::new(&self.repo).join(self.ignored)).unwrap(),
                SENTINEL
            );
            assert_eq!(run(&self.repo, &["rev-parse", "HEAD"]).await, self.head);
            assert_eq!(
                run(&self.repo, &["rev-parse", "refs/heads/local"]).await,
                self.head
            );
            assert_eq!(
                run(&self.repo, &["rev-parse", "refs/heads/incoming"]).await,
                self.target
            );
            assert!(!crate::git::ops::op_state(&self.repo).await.unwrap().merging);
            assert_eq!(run(&self.repo, &["stash", "list"]).await, self.stash);
        }

        pub(crate) async fn assert_landed(&self) {
            if self.shape == Shape::InsideIgnoredDir {
                assert_eq!(
                    std::fs::read(Path::new(&self.repo).join(self.ignored)).unwrap(),
                    SENTINEL
                );
            }
            assert_eq!(
                std::fs::read_to_string(Path::new(&self.repo).join(self.incoming)).unwrap(),
                "incoming bytes\n"
            );
            assert_eq!(run(&self.repo, &["stash", "list"]).await, self.stash);
        }
    }

    #[tokio::test]
    async fn subdirectory_still_finds_ignored_file() {
        let f = Fixture::new(Shape::IgnoredFile, true).await;
        let sub = Path::new(&f.repo).join("sub");
        std::fs::create_dir(&sub).unwrap();
        let hits = ignored_files_in_the_way(&sub.to_string_lossy(), &f.target, DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(hits, vec!["local.cfg"]);
    }
    #[tokio::test]
    async fn candidate_shapes_and_negative_controls() {
        for shape in SHAPES {
            for diverged in [false, true] {
                if shape == Shape::ModifyDelete && !diverged {
                    continue;
                }
                let f = Fixture::new(shape, diverged).await;
                let hits = ignored_files_in_the_way(&f.repo, &f.target, DEFAULT_TIMEOUT)
                    .await
                    .unwrap();
                if shape == Shape::InsideIgnoredDir {
                    assert!(hits.is_empty(), "{hits:?}");
                    f.assert_intact().await;
                } else {
                    assert!(
                        hits.iter().any(|p| p.contains(f.named)),
                        "{shape:?}: {hits:?}"
                    );
                    f.remove_ignored();
                    assert!(
                        ignored_files_in_the_way(&f.repo, &f.target, DEFAULT_TIMEOUT)
                            .await
                            .unwrap()
                            .is_empty()
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn relative_diff_config_keeps_root_paths() {
        let f = Fixture::new(Shape::IgnoredFile, false).await;
        run(&f.repo, &["config", "diff.relative", "true"]).await;
        let sub = Path::new(&f.repo).join("sub");
        std::fs::create_dir(&sub).unwrap();
        assert_eq!(
            ignored_files_in_the_way(&sub.to_string_lossy(), &f.target, DEFAULT_TIMEOUT)
                .await
                .unwrap(),
            vec!["local.cfg"]
        );
    }

    #[tokio::test]
    async fn unborn_checks_whole_tree_but_unrelated_heads_keep_native_refusal() {
        for born in [false, true] {
            let f = Fixture::new(Shape::IgnoredFile, false).await;
            run(&f.repo, &["switch", "--orphan", "orphan"]).await;
            std::fs::write(Path::new(&f.repo).join(".gitignore"), "local.cfg\n").unwrap();
            if born {
                run(&f.repo, &["add", ".gitignore"]).await;
                run(&f.repo, &["commit", "-qm", "unrelated root"]).await;
            }
            assert_eq!(
                ignored_files_in_the_way(&f.repo, &f.target, DEFAULT_TIMEOUT)
                    .await
                    .unwrap(),
                if born {
                    Vec::<String>::new()
                } else {
                    vec!["local.cfg".into()]
                }
            );
            if born {
                let out = run_git_raw(Some(&f.repo), &["merge", "incoming"], DEFAULT_TIMEOUT)
                    .await
                    .unwrap();
                assert_ne!(out.code, 0);
                assert!(
                    out.full_failure_text()
                        .contains("refusing to merge unrelated histories"),
                    "{}",
                    out.full_failure_text()
                );
            }
            assert_eq!(
                std::fs::read(Path::new(&f.repo).join(f.ignored)).unwrap(),
                SENTINEL
            );
        }
    }

    #[tokio::test]
    async fn upstream_probe_failure_refuses_but_no_upstream_does_not() {
        let f = Fixture::new(Shape::IgnoredFile, false).await;
        assert_eq!(upstream_commit(&f.repo).await.unwrap(), None);
        let err = upstream_commit_within(&f.repo, Duration::ZERO)
            .await
            .unwrap_err();
        let AppError::Command(message) = err else {
            panic!("expected Command, got {err:?}");
        };
        assert!(message.starts_with("Pull stopped: "), "{message}");
        f.with_remote().await;
        assert_eq!(
            upstream_commit(&f.repo).await.unwrap(),
            Some(f.head.clone())
        );
    }

    #[tokio::test]
    async fn invalid_target_fails_closed() {
        let f = Fixture::new(Shape::IgnoredFile, false).await;
        assert!(
            ignored_files_in_the_way(&f.repo, "not-a-revision", DEFAULT_TIMEOUT)
                .await
                .is_err()
        );
    }

    #[test]
    fn refusal_copy_does_not_offer_stashing_or_conflict_resolution() {
        let paths = ["local.cfg", "logs/run.log", "private.cfg", "build/out"].map(str::to_string);
        assert_eq!(
            name_paths(&paths),
            "local.cfg, logs/run.log, private.cfg and 1 more"
        );
        let mut errors = vec![
            merge_refusal("topic", &paths),
            update_refusal("topic", "main", &paths),
            pull_refusal(&paths),
            finalize_refusal("main", None, &paths),
            finalize_refusal("main", Some("C:/work"), &paths),
        ];
        for op in ["Merge", "Update", "Pull", "Fast-forward"] {
            errors.push(check_failed(
                op,
                AppError::Git {
                    code: 128,
                    stderr: "fatal: bad object refs/remotes/origin/main".into(),
                },
            ));
        }
        let dirty = [
            "your local changes to the following files would be overwritten by merge",
            "the following untracked working tree files would be overwritten by merge",
            "your local changes to the following files would be overwritten by checkout",
            "the following untracked working tree files would be overwritten by checkout",
            "cannot pull with rebase: you have unstaged changes",
            "cannot pull with rebase: your index contains uncommitted changes",
            "cannot rebase: you have unstaged changes",
            "cannot rebase: your index contains uncommitted changes",
        ];
        // Mirrors the frontend's four anchored regexes without a regex dependency.
        let conflict = |message: &str| {
            message
                .split(['\r', '\n', '\u{2028}', '\u{2029}'])
                .any(|line| {
                    let error = line.strip_prefix("error: ").unwrap_or(line);
                    let advice = error.strip_prefix("hint: ").unwrap_or(error);
                    [
                        "could not apply ",
                        "Could not apply ",
                        "could not revert ",
                        "Could not revert ",
                    ]
                    .iter()
                    .any(|prefix| error.starts_with(prefix))
                        || advice.starts_with("Resolve all conflicts")
                        || line.starts_with("CONFLICT (")
                        || line.trim_end().ends_with(": needs merge")
                })
        };
        for err in errors {
            let AppError::Command(message) = err else {
                panic!("expected Command");
            };
            let lower = message.to_lowercase();
            assert!(
                !dirty.iter().any(|marker| lower.contains(marker)),
                "{message}"
            );
            assert!(!conflict(&message), "{message}");
        }
    }

    #[derive(Clone, Copy, Debug)]
    pub(crate) enum MergeState {
        MergeHead,
        CherryPickHead,
        RevertHead,
        Sequencer,
        Unmerged,
    }

    pub(crate) const MERGE_STATES: [MergeState; 5] = [
        MergeState::MergeHead,
        MergeState::CherryPickHead,
        MergeState::RevertHead,
        MergeState::Sequencer,
        MergeState::Unmerged,
    ];

    impl MergeState {
        pub(crate) fn blocks_merge(self) -> bool {
            matches!(
                self,
                Self::MergeHead | Self::CherryPickHead | Self::Unmerged
            )
        }

        pub(crate) async fn install(self, f: &Fixture) {
            let admin = Path::new(&f.repo).join(".git");
            match self {
                Self::MergeHead | Self::CherryPickHead | Self::RevertHead => {
                    let marker = match self {
                        Self::MergeHead => "MERGE_HEAD",
                        Self::CherryPickHead => "CHERRY_PICK_HEAD",
                        _ => "REVERT_HEAD",
                    };
                    std::fs::write(admin.join(marker), format!("{}\n", f.target)).unwrap();
                }
                Self::Sequencer => {
                    std::fs::create_dir(admin.join("sequencer")).unwrap();
                    std::fs::write(
                        admin.join("sequencer/todo"),
                        format!("pick {} incoming file\n", f.target),
                    )
                    .unwrap();
                }
                Self::Unmerged => {
                    let blob = run(&f.repo, &["rev-parse", "HEAD:tracked.txt"]).await;
                    let input = format!(
                        "0 {}\ttracked.txt\n100644 {blob} 1\ttracked.txt\n100644 {blob} 2\ttracked.txt\n100644 {blob} 3\ttracked.txt\n",
                        "0".repeat(40),
                    );
                    let out = crate::git::runner::run_git_raw_input(
                        Some(&f.repo),
                        &["update-index", "--index-info"],
                        Some(&input),
                        DEFAULT_TIMEOUT,
                    )
                    .await
                    .unwrap();
                    assert_eq!(out.code, 0, "{}", out.full_failure_text());
                }
            }
        }
    }

    #[tokio::test]
    async fn merge_native_operation_states() {
        for state in MERGE_STATES {
            let f = Fixture::new(Shape::IgnoredFile, true).await;
            f.remove_ignored();
            state.install(&f).await;
            let out = run_git_raw(
                Some(&f.repo),
                &["merge", "--no-edit", "--no-overwrite-ignore", "incoming"],
                DEFAULT_TIMEOUT,
            )
            .await
            .unwrap();
            assert_eq!(
                out.code != 0,
                state.blocks_merge(),
                "{state:?}: {}",
                out.full_failure_text(),
            );
            if state.blocks_merge() {
                let marker = match state {
                    MergeState::MergeHead => "MERGE_HEAD exists",
                    MergeState::CherryPickHead => "CHERRY_PICK_HEAD exists",
                    _ => "unmerged files",
                };
                assert!(
                    out.full_failure_text().contains(marker),
                    "{state:?}: {}",
                    out.full_failure_text()
                );
            } else {
                f.assert_landed().await;
            }
        }
    }
}
