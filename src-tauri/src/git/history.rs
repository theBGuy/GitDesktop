use crate::error::AppResult;
use crate::git::diff::parse_numstat_z;
use crate::git::runner::{run_git, run_git_raw, DEFAULT_TIMEOUT};
use crate::git::types::{
    BlameLine, CommitDetails, CommitSummary, DiffStatEntry, FileDiff, StagedDiff,
};

pub fn validate_hash(hash: &str) -> AppResult<()> {
    if hash.is_empty() || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(crate::error::AppError::InvalidArgument(format!(
            "invalid commit hash: {hash}"
        )));
    }
    Ok(())
}

/// Whether HEAD is unborn: a symbolic HEAD naming a branch ref that doesn't
/// exist. `rev-parse --verify --quiet HEAD` exits 1 both for that and for a
/// branch ref that exists but holds garbage (measured, git 2.51.1), so exit 1
/// is confirmed with `show-ref --exists`. Anything else (not a repository, a
/// detached HEAD that doesn't resolve, a broken ref) is a failed read carrying
/// git's report, never an empty answer. The healthy path is one spawn.
pub(crate) async fn unborn_head(repo_path: &str) -> AppResult<bool> {
    let head = run_git_raw(
        Some(repo_path),
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match head.code {
        0 => return Ok(false),
        1 => {}
        _ => return head.exit_verdict().map(|_| false),
    }
    let target = run_git_raw(
        Some(repo_path),
        &["symbolic-ref", "-q", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    if target.code != 0 {
        return Err(crate::error::AppError::Command(
            "HEAD doesn't resolve to a commit.".into(),
        ));
    }
    let name = target.stdout_lossy().trim().to_string();
    let exists = run_git_raw(
        Some(repo_path),
        &["show-ref", "--exists", &name],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match exists.code {
        // 2 is `--exists`'s "missing"; 129 is a git older than 2.43, which has
        // no `--exists` and so can't tell a missing ref from a broken one.
        2 | 129 => Ok(true),
        _ => Err(crate::error::AppError::Command(
            format!(
                "{name} doesn't resolve to a commit.\n{}",
                exists.full_failure_text()
            )
            .trim_end()
            .to_string(),
        )),
    }
}

/// Paged commit history. When `search` is set, searches the whole history by
/// commit message (literal, case-insensitive) instead of paging recent commits.
#[tauri::command]
pub async fn git_log(
    repo_path: String,
    limit: u32,
    skip: u32,
    search: Option<String>,
) -> AppResult<Vec<CommitSummary>> {
    if unborn_head(&repo_path).await? {
        return Ok(Vec::new());
    }

    let limit_arg = limit.to_string();
    let skip_arg = skip.to_string();
    let search = search
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let mut args: Vec<&str> = vec![
        "log",
        "-n",
        &limit_arg,
        "--skip",
        &skip_arg,
        LOG_FORMAT,
    ];
    if let Some(q) = &search {
        // Literal, case-insensitive match against the whole commit message.
        args.extend(["-i", "-F", "--grep", q.as_str()]);
    }
    let out = run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?;
    Ok(parse_commit_log(&out.stdout_lossy()))
}

/// The `%H%x00%s%x00%an%x00%ae%x00%cI%x00%D%x00%P` log format, one commit per line.
/// Paired with `parse_commit_log` — the history and compare listings share both,
/// so those paths can't drift into reporting empty tags or merge flags.
pub(crate) const LOG_FORMAT: &str = "--format=%H%x00%s%x00%an%x00%ae%x00%cI%x00%D%x00%P";

pub(crate) fn parse_commit_log(text: &str) -> Vec<CommitSummary> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.split('\0');
            Some(CommitSummary {
                hash: parts.next()?.to_string(),
                subject: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                author_email: parts.next()?.to_string(),
                date: parts.next()?.to_string(),
                // %D: "HEAD -> main, tag: v1.0, origin/main" — keep the tags.
                tags: parts
                    .next()
                    .unwrap_or("")
                    .split(", ")
                    .filter_map(|d| d.strip_prefix("tag: "))
                    .map(str::to_string)
                    .collect(),
                // %P: space-separated parent hashes.
                is_merge: parts.next().unwrap_or("").split_whitespace().count() > 1,
            })
        })
        .collect()
}

fn validate_path(path: &str) -> AppResult<()> {
    if path.is_empty() {
        return Err(crate::error::AppError::InvalidArgument(
            "empty file path".into(),
        ));
    }
    Ok(())
}

/// Commit history for a single file, following renames.
#[tauri::command]
pub async fn git_file_log(
    repo_path: String,
    path: String,
    limit: u32,
    skip: u32,
) -> AppResult<Vec<CommitSummary>> {
    validate_path(&path)?;
    // A zero-commit repo has no HEAD to walk, so `git log --follow` would surface
    // raw git stderr. Mirror `git_log`'s guard: an unborn HEAD has no history, so
    // return an empty list rather than an error.
    if unborn_head(&repo_path).await? {
        return Ok(Vec::new());
    }
    let limit_arg = limit.to_string();
    let skip_arg = skip.to_string();
    // Literal pathspec, honored even under `--follow`: a raw `[slug]`-style path
    // lists a glob-sibling's commits as this file's history (measured).
    let spec = crate::git::pathspec::literal(&path);
    let out = run_git(
        Some(&repo_path),
        &[
            "log",
            "--follow",
            "-n",
            &limit_arg,
            "--skip",
            &skip_arg,
            LOG_FORMAT,
            "--",
            &spec,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(parse_commit_log(&out.stdout_lossy()))
}

/// `git blame` for a file — at the working tree by default, or as of `rev`
/// (any SHA/branch/tag) when given. Parses the `--porcelain` stream (commit
/// metadata is emitted once per commit, then cached for that commit's later
/// lines).
#[tauri::command]
pub async fn git_blame(
    repo_path: String,
    path: String,
    rev: Option<String>,
) -> AppResult<Vec<BlameLine>> {
    validate_path(&path)?;

    // Resolve the optional rev to a concrete 40-hex sha, or guard the unborn-HEAD
    // case: an unknown rev (exit 1) and an unborn HEAD get friendly errors, and
    // any other probe failure carries git's own report.
    let resolved_rev = match rev.as_deref().map(str::trim) {
        None => {
            // No rev: blame the working tree, but a zero-commit repo has no HEAD to
            // blame — return a friendly error rather than raw git stderr (and never
            // an empty Ok, which would masquerade as an empty file).
            if unborn_head(&repo_path).await? {
                return Err(crate::error::AppError::InvalidArgument(
                    "repository has no commits yet — blame needs at least one commit".into(),
                ));
            }
            None
        }
        Some(rev) => {
            // A rev is passed positionally before `--`, so a leading dash would be
            // parsed as a flag — reject it (and empties) before touching git.
            if rev.is_empty() || rev.starts_with('-') {
                return Err(crate::error::AppError::InvalidArgument(format!(
                    "invalid revision: {rev}"
                )));
            }
            // Resolve first: validates arbitrary revspecs (branch names from the
            // Compare surface) and normalizes to a 40-hex sha. Only exit 1 means
            // the rev doesn't resolve; any other failure keeps git's own reason.
            let resolved = run_git_raw(
                Some(&repo_path),
                &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")],
                DEFAULT_TIMEOUT,
            )
            .await?;
            if resolved.code == 1 {
                return Err(crate::error::AppError::InvalidArgument(format!(
                    "unknown revision: {rev}"
                )));
            }
            Some(resolved.exit_verdict()?.stdout_lossy().trim().to_string())
        }
    };

    let mut args: Vec<&str> = vec!["blame", "--porcelain"];
    if let Some(sha) = &resolved_rev {
        args.push(sha);
    }
    // `blame` takes a literal PATH, not a pathspec — it never globbed, and
    // `:(literal)` makes it fail outright ("no such path in HEAD", measured).
    // Do not "fix" this the way the diff/log call sites were fixed.
    args.extend(["--", &path]);
    let out = run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?;
    let text = out.stdout_lossy();

    let mut cache: std::collections::HashMap<String, (String, i64, String)> =
        std::collections::HashMap::new();
    let mut lines = Vec::new();
    let (mut cur_sha, mut author, mut summary) =
        (String::new(), String::new(), String::new());
    let mut cur_line = 0u32;
    let mut time = 0i64;

    for line in text.lines() {
        // Header: "<40-hex sha> <orig-line> <final-line> [<group-size>]".
        if let Some((sha, rest)) = line.split_once(' ') {
            if sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
                cur_sha = sha.to_string();
                cur_line = rest
                    .split(' ')
                    .nth(1)
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0);
                if let Some((a, t, s)) = cache.get(sha) {
                    author = a.clone();
                    time = *t;
                    summary = s.clone();
                } else {
                    author.clear();
                    summary.clear();
                    time = 0;
                }
                continue;
            }
        }
        if let Some(a) = line.strip_prefix("author ") {
            author = a.to_string();
        } else if let Some(t) = line.strip_prefix("author-time ") {
            time = t.trim().parse().unwrap_or(0);
        } else if let Some(s) = line.strip_prefix("summary ") {
            summary = s.to_string();
        } else if let Some(content) = line.strip_prefix('\t') {
            cache
                .entry(cur_sha.clone())
                .or_insert((author.clone(), time, summary.clone()));
            lines.push(BlameLine {
                line_no: cur_line,
                hash: cur_sha.clone(),
                author: author.clone(),
                time,
                summary: summary.clone(),
                content: content.to_string(),
            });
        }
    }
    Ok(lines)
}

#[tauri::command]
pub async fn git_commit_details(repo_path: String, hash: String) -> AppResult<CommitDetails> {
    validate_hash(&hash)?;
    // -z terminates the record so the multi-line body (%b) parses unambiguously
    let out = run_git(
        Some(&repo_path),
        &[
            "log",
            "-1",
            "-z",
            "--format=%H%x00%s%x00%an%x00%ae%x00%cI%x00%b",
            &hash,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let record = text.trim_end_matches('\0');
    let mut parts = record.splitn(6, '\0');
    let (Some(hash), Some(subject), Some(author), Some(author_email), Some(date)) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return Err(crate::error::AppError::Git {
            code: 0,
            stderr: "unexpected git log output".into(),
        });
    };
    let body = parts.next().unwrap_or("").trim().to_string();

    Ok(CommitDetails {
        hash: hash.to_string(),
        subject: subject.to_string(),
        body,
        author: author.to_string(),
        author_email: author_email.to_string(),
        date: date.to_string(),
    })
}

/// One parent of a commit. Its position in [`git_commit_parents`]'s list is the
/// parent number `-m` takes, counting from 1.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitParent {
    pub hash: String,
    pub subject: String,
}

/// A commit's parents in git's parent order, each with its subject: the choice a
/// merge commit's revert or cherry-pick needs. A root commit has none.
#[tauri::command]
pub async fn git_commit_parents(repo_path: String, hash: String) -> AppResult<Vec<CommitParent>> {
    validate_hash(&hash)?;
    let out = run_git(
        Some(&repo_path),
        &["rev-list", "--parents", "-n", "1", &hash],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let line = out.stdout_lossy();
    let parents: Vec<&str> = line.split_whitespace().skip(1).collect();
    if parents.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec!["log", "--no-walk=unsorted", "--format=%H%x00%s"];
    args.extend(parents.iter().copied());
    let out = run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?;
    let text = out.stdout_lossy();
    let subjects: std::collections::HashMap<&str, &str> =
        text.lines().filter_map(|l| l.split_once('\0')).collect();
    parents
        .into_iter()
        .map(|p| match subjects.get(p) {
            Some(subject) => Ok(CommitParent {
                hash: p.to_string(),
                subject: (*subject).to_string(),
            }),
            None => Err(crate::error::AppError::Git {
                code: 0,
                stderr: format!("git log did not list parent {p}"),
            }),
        })
        .collect()
}

/// Files changed by a commit. `-m --first-parent` makes merge commits show
/// their diff against the first parent (like GitHub), and `show` handles the
/// root commit by diffing against the empty tree.
#[tauri::command]
pub async fn git_commit_files(repo_path: String, hash: String) -> AppResult<Vec<DiffStatEntry>> {
    validate_hash(&hash)?;
    let out = run_git(
        Some(&repo_path),
        &[
            "show",
            "-m",
            "--first-parent",
            "--numstat",
            "-z",
            "--format=",
            &hash,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(parse_numstat_z(&out.stdout_lossy()))
}

/// The combined diff a commit introduced (vs its first parent) plus numstat —
/// the commit-shaped analogue of `git_branch_diff`, used for AI review.
#[tauri::command]
pub async fn git_commit_diff(
    repo_path: String,
    hash: String,
    max_bytes: Option<usize>,
) -> AppResult<StagedDiff> {
    validate_hash(&hash)?;
    let text_out = run_git(
        Some(&repo_path),
        &[
            "show",
            "-m",
            "--first-parent",
            "--no-color",
            "--format=",
            &hash,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let (text, truncated) = super::diff::truncate_at_char_boundary(
        text_out.stdout_lossy(),
        max_bytes.unwrap_or(1_000_000),
    );
    let files_out = run_git(
        Some(&repo_path),
        &[
            "show",
            "-m",
            "--first-parent",
            "--numstat",
            "-z",
            "--format=",
            &hash,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(StagedDiff {
        text,
        truncated,
        files: parse_numstat_z(&files_out.stdout_lossy()),
        excluded_files: 0,
        unreadable_files: 0,
    })
}

#[tauri::command]
pub async fn git_commit_file_diff(
    repo_path: String,
    hash: String,
    file_path: String,
) -> AppResult<FileDiff> {
    validate_hash(&hash)?;
    // Literal pathspec: a raw `[slug]`-style path splices a glob-sibling's hunks
    // into the commit diff shown for this file (measured).
    let spec = crate::git::pathspec::literal(&file_path);
    let out = run_git(
        Some(&repo_path),
        &[
            "show",
            "-m",
            "--first-parent",
            "--no-color",
            "--format=",
            &hash,
            "--",
            &spec,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let is_binary = text
        .lines()
        .any(|l| l.starts_with("Binary files ") && l.ends_with(" differ"));
    let (text, is_truncated) = super::diff::truncate_at_char_boundary(text, 1_000_000);
    Ok(FileDiff {
        file_path,
        is_binary,
        is_truncated,
        text,
        undecodable: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn temp_repo(tag: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-blame-test-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        (dir, repo)
    }

    async fn git(repo: &str, args: &[&str]) {
        run_git(Some(repo), args, DEFAULT_TIMEOUT).await.unwrap();
    }

    /// Builds a repo where `file.txt` gets two commits: line one is written in the
    /// first commit and a second line is appended in the second. Returns the repo
    /// path plus the two commit shas (first, second).
    async fn two_commit_repo(tag: &str) -> (tempfile::TempDir, String, String, String) {
        let (dir, repo) = temp_repo(tag);
        git(&repo, &["init"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        let file = Path::new(&repo).join("file.txt");
        std::fs::write(&file, "first\n").unwrap();
        git(&repo, &["add", "."]).await;
        git(&repo, &["commit", "-m", "one"]).await;
        let first = run_git(Some(&repo), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
            .trim()
            .to_string();
        std::fs::write(&file, "first\nsecond\n").unwrap();
        git(&repo, &["commit", "-am", "two"]).await;
        let second = run_git(Some(&repo), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
            .trim()
            .to_string();
        (dir, repo, first, second)
    }

    #[tokio::test]
    async fn blame_at_rev_shows_that_revs_content() {
        let (_dir, repo, first, second) = two_commit_repo("at-rev").await;

        // At the first commit, the file has only one line, all attributed to `first`.
        let at_first = git_blame(repo.clone(), "file.txt".into(), Some(first.clone()))
            .await
            .unwrap();
        assert_eq!(at_first.len(), 1);
        assert_eq!(at_first[0].content, "first");
        assert_eq!(at_first[0].hash, first);

        // Worktree blame sees both lines; the appended one belongs to `second`.
        let at_worktree = git_blame(repo.clone(), "file.txt".into(), None)
            .await
            .unwrap();
        assert_eq!(at_worktree.len(), 2);
        assert_eq!(at_worktree[0].hash, first);
        assert_eq!(at_worktree[1].content, "second");
        assert_eq!(at_worktree[1].hash, second);
    }

    #[tokio::test]
    async fn blame_unborn_head_errors() {
        let (_dir, repo) = temp_repo("unborn");
        git(&repo, &["init"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;

        let err = git_blame(repo.clone(), "file.txt".into(), None)
            .await
            .unwrap_err();
        match err {
            crate::error::AppError::InvalidArgument(msg) => {
                assert!(msg.contains("no commits yet"), "unexpected message: {msg}");
            }
            other => panic!("expected InvalidArgument, got {other:?}"),
        }
    }

    /// The diff pane discards a rendered body whose `file_path` doesn't match the
    /// path it asked for (that mismatch is how it detects a stale placeholder), so
    /// the echo must stay verbatim — including a `[slug]`-style name, which only
    /// survives because the pathspec is quoted literally.
    #[tokio::test]
    async fn commit_file_diff_echoes_the_requested_path() {
        let (_dir, repo) = temp_repo("file-diff-echo");
        git(&repo, &["init"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        let root = Path::new(&repo);
        std::fs::create_dir_all(root.join("[slug]")).unwrap();
        std::fs::write(root.join("plain.txt"), "one\n").unwrap();
        std::fs::write(root.join("[slug]").join("a.txt"), "one\n").unwrap();
        git(&repo, &["add", "."]).await;
        git(&repo, &["commit", "-m", "seed"]).await;
        std::fs::write(root.join("plain.txt"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("[slug]").join("a.txt"), "one\ntwo\n").unwrap();
        git(&repo, &["commit", "-am", "change both"]).await;
        let hash = run_git(Some(&repo), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
            .trim()
            .to_string();

        for path in ["plain.txt", "[slug]/a.txt"] {
            let diff = git_commit_file_diff(repo.clone(), hash.clone(), path.to_string())
                .await
                .unwrap();
            assert_eq!(diff.file_path, path);
            assert!(
                diff.text.contains("+two"),
                "no hunk for {path}: {}",
                diff.text
            );
        }
    }

    /// The TS mirror reads these exact keys; a rename would read `undefined`.
    #[test]
    fn commit_parent_serializes_its_exact_wire_keys() {
        let value = serde_json::to_value(CommitParent {
            hash: "abc1234".into(),
            subject: "main work".into(),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "hash": "abc1234", "subject": "main work" })
        );
    }

    #[tokio::test]
    async fn commit_parents_reads_none_for_the_root_and_one_for_the_next_commit() {
        let (_dir, repo, first, second) = two_commit_repo("parents-root").await;
        let at_root = git_commit_parents(repo.clone(), first.clone())
            .await
            .unwrap();
        assert!(at_root.is_empty(), "a root commit has no parents");
        let next = git_commit_parents(repo.clone(), second).await.unwrap();
        assert_eq!(next.len(), 1);
        assert_eq!(next[0].hash, first);
        assert_eq!(next[0].subject, "one");
    }

    #[tokio::test]
    async fn blame_unknown_rev_says_unknown_revision() {
        let (_dir, repo, _first, _second) = two_commit_repo("unknown-rev").await;
        let err = git_blame(repo.clone(), "file.txt".into(), Some("no-such-rev".into()))
            .await
            .unwrap_err();
        assert!(
            matches!(&err, crate::error::AppError::InvalidArgument(msg) if msg == "unknown revision: no-such-rev"),
            "{err:?}"
        );
    }

    /// A git run that fails for any reason but "absent" carries git's own report,
    /// on both the rev probe and the no-rev HEAD probe.
    #[tokio::test]
    async fn blame_in_a_broken_repo_reports_gits_reason() {
        let (dir, repo, first, _second) = two_commit_repo("broken").await;
        std::fs::rename(dir.path().join(".git"), dir.path().join("git-moved")).unwrap();
        for rev in [Some(first), None] {
            let err = git_blame(repo.clone(), "file.txt".into(), rev.clone())
                .await
                .unwrap_err();
            assert!(
                matches!(&err, crate::error::AppError::Git { stderr, .. } if stderr.contains("not a git repository")),
                "rev {rev:?}: {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn git_log_errs_in_a_broken_repo() {
        let (dir, repo, _first, _second) = two_commit_repo("log-broken").await;
        std::fs::rename(dir.path().join(".git"), dir.path().join("git-moved")).unwrap();
        for search in [None, Some("one".to_string())] {
            let result = git_log(repo.clone(), 10, 0, search.clone()).await;
            assert!(
                matches!(&result, Err(crate::error::AppError::Git { stderr, .. }) if stderr.contains("not a git repository")),
                "search {search:?}: {result:?}"
            );
        }
    }

    #[tokio::test]
    async fn git_log_is_empty_on_an_unborn_head() {
        let (_dir, repo) = temp_repo("log-unborn");
        git(&repo, &["init"]).await;
        assert!(git_log(repo, 10, 0, None).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn file_history_errs_in_a_broken_repo() {
        let (dir, repo, _first, _second) = two_commit_repo("file-log-broken").await;
        std::fs::rename(dir.path().join(".git"), dir.path().join("git-moved")).unwrap();
        let result = git_file_log(repo, "file.txt".into(), 10, 0).await;
        assert!(
            matches!(&result, Err(crate::error::AppError::Git { stderr, .. }) if stderr.contains("not a git repository")),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn file_history_is_empty_on_an_unborn_head() {
        let (_dir, repo) = temp_repo("file-log-unborn");
        git(&repo, &["init"]).await;
        assert!(git_file_log(repo, "file.txt".into(), 10, 0)
            .await
            .unwrap()
            .is_empty());
    }

    /// A branch ref that exists but holds garbage is a damaged repository, not an
    /// unborn HEAD: every read through it must fail, never answer empty.
    #[tokio::test]
    async fn unborn_head_errs_on_a_corrupt_branch_ref() {
        let (dir, repo, _first, _second) = two_commit_repo("corrupt-ref").await;
        let branch = run_git(Some(&repo), &["symbolic-ref", "HEAD"], DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
            .trim()
            .to_string();
        // Loose, so the corrupt file is the ref git reads.
        let ref_file = dir.path().join(".git").join(&branch);
        assert!(ref_file.is_file(), "{branch} is not a loose ref");
        std::fs::write(&ref_file, "not-a-sha\n").unwrap();
        let probe = run_git_raw(
            Some(&repo),
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        // The premise: the probe alone reads this exactly like an unborn HEAD.
        assert_eq!(probe.code, 1, "{:?}", probe.stderr);
        let unborn = unborn_head(&repo).await;
        assert!(unborn.is_err(), "unborn_head: {unborn:?}");
        assert!(git_log(repo.clone(), 10, 0, None).await.is_err());
    }

    /// The Code TODOs detail view reads this exact phrase as "untracked"; any
    /// other blame failure is a failed read.
    #[tokio::test]
    async fn blame_untracked_file_says_no_such_path_in_head() {
        let (dir, repo, _first, _second) = two_commit_repo("untracked").await;
        std::fs::write(dir.path().join("new.txt"), "fresh\n").unwrap();
        let err = git_blame(repo, "new.txt".into(), None).await.unwrap_err();
        assert!(
            matches!(&err, crate::error::AppError::Git { stderr, .. } if stderr.contains("no such path 'new.txt' in HEAD")),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn blame_dash_prefixed_rev_rejected() {
        let (_dir, repo, _first, _second) = two_commit_repo("dash-rev").await;

        let err = git_blame(repo.clone(), "file.txt".into(), Some("-HEAD".into()))
            .await
            .unwrap_err();
        assert!(matches!(err, crate::error::AppError::InvalidArgument(_)));
    }
}
