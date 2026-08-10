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

/// Paged commit history. When `search` is set, searches the whole history by
/// commit message (literal, case-insensitive) instead of paging recent commits.
#[tauri::command]
pub async fn git_log(
    repo_path: String,
    limit: u32,
    skip: u32,
    search: Option<String>,
) -> AppResult<Vec<CommitSummary>> {
    let head_exists = run_git_raw(
        Some(&repo_path),
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .code
        == 0;
    if !head_exists {
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
const LOG_FORMAT: &str = "--format=%H%x00%s%x00%an%x00%ae%x00%cI%x00%D%x00%P";

fn parse_commit_log(text: &str) -> Vec<CommitSummary> {
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
    let head_exists = run_git_raw(
        Some(&repo_path),
        &["rev-parse", "--verify", "--quiet", "HEAD"],
        DEFAULT_TIMEOUT,
    )
    .await?
    .code
        == 0;
    if !head_exists {
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
    // case, so `git blame` never surfaces raw stderr for either.
    let resolved_rev = match rev.as_deref().map(str::trim) {
        None => {
            // No rev: blame the working tree, but a zero-commit repo has no HEAD to
            // blame — return a friendly error rather than raw git stderr (and never
            // an empty Ok, which would masquerade as an empty file).
            let head_exists = run_git_raw(
                Some(&repo_path),
                &["rev-parse", "--verify", "--quiet", "HEAD"],
                DEFAULT_TIMEOUT,
            )
            .await?
            .code
                == 0;
            if !head_exists {
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
            // Compare surface) and normalizes to a 40-hex sha.
            let resolved = run_git_raw(
                Some(&repo_path),
                &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")],
                DEFAULT_TIMEOUT,
            )
            .await?;
            if resolved.code != 0 {
                return Err(crate::error::AppError::InvalidArgument(format!(
                    "unknown revision: {rev}"
                )));
            }
            Some(resolved.stdout_lossy().trim().to_string())
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

    #[tokio::test]
    async fn blame_dash_prefixed_rev_rejected() {
        let (_dir, repo, _first, _second) = two_commit_repo("dash-rev").await;

        let err = git_blame(repo.clone(), "file.txt".into(), Some("-HEAD".into()))
            .await
            .unwrap_err();
        assert!(matches!(err, crate::error::AppError::InvalidArgument(_)));
    }
}
