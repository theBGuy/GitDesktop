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
    let limit_arg = limit.to_string();
    let skip_arg = skip.to_string();
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
            &path,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(parse_commit_log(&out.stdout_lossy()))
}

/// `git blame` for a file at HEAD: each line's content + the commit that last
/// changed it. Parses the `--porcelain` stream (commit metadata is emitted once
/// per commit, then cached for that commit's later lines).
#[tauri::command]
pub async fn git_blame(repo_path: String, path: String) -> AppResult<Vec<BlameLine>> {
    validate_path(&path)?;
    let out = run_git(
        Some(&repo_path),
        &["blame", "--porcelain", "--", &path],
        DEFAULT_TIMEOUT,
    )
    .await?;
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
            &file_path,
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
