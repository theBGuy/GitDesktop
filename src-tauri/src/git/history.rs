use crate::error::AppResult;
use crate::git::diff::parse_numstat_z;
use crate::git::runner::{run_git, run_git_raw, GitOutput, DEFAULT_TIMEOUT};
use crate::git::types::{
    BlameLine, CommitDetails, CommitSummary, DiffStatEntry, FileDiff, FileLogEntry, StagedDiff,
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
/// branch ref that exists but holds garbage (measured, git 2.51.1), so an exit
/// 1 is confirmed: `symbolic-ref -q HEAD` names the branch and `show-ref
/// --exists` says whether it exists. That check needs git 2.43+; older git has
/// no `--exists` and reads a broken ref as unborn too. A ref that appears
/// between the probes (a first commit landing) gets one re-probe of HEAD.
/// Anything else (not a repository, a detached HEAD that doesn't resolve, a
/// broken ref) is an error, carrying git's report where git gave one, never an
/// empty answer. The healthy path is one spawn.
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
    let broken = || {
        crate::error::AppError::Command(
            format!(
                "{name} doesn't resolve to a commit.\n{}",
                exists.full_failure_text()
            )
            .trim_end()
            .to_string(),
        )
    };
    match exists.code {
        // 2 is `--exists`'s "missing"; 129 is a git older than 2.43, which has
        // no `--exists` and so can't tell a missing ref from a broken one.
        2 | 129 => Ok(true),
        // The ref exists: either a first commit landed since the first probe,
        // or the ref is broken. One re-probe of HEAD tells them apart.
        0 => {
            let again = run_git_raw(
                Some(repo_path),
                &["rev-parse", "--verify", "--quiet", "HEAD"],
                DEFAULT_TIMEOUT,
            )
            .await?;
            match again.code {
                0 => Ok(false),
                1 => Err(broken()),
                _ => again.exit_verdict().map(|_| false),
            }
        }
        _ => Err(broken()),
    }
}

/// Runs a read git refuses on an unborn HEAD: `None` when it failed and HEAD
/// is unborn (there is no history to read), the output when it succeeded, and
/// an Err for any other failure. When the probe finds HEAD born after the run
/// failed (a first commit landing between the two), the read runs once more,
/// so that race answers instead of erring; a real failure fails again with its
/// own report. Accepted cost: a non-timeout failure on a born HEAD runs the
/// read twice (a timeout returns before the re-run).
pub(crate) async fn read_unless_unborn(
    repo_path: &str,
    args: &[&str],
    timeout: std::time::Duration,
) -> AppResult<Option<GitOutput>> {
    let out = run_git_raw(Some(repo_path), args, timeout).await?;
    if out.code == 0 {
        return Ok(Some(out));
    }
    if unborn_head(repo_path).await? {
        return Ok(None);
    }
    run_git_raw(Some(repo_path), args, timeout)
        .await?
        .exit_verdict()
        .map(Some)
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
        .filter_map(|line| parse_commit_record(&mut line.split('\0')))
        .collect()
}

/// Reads one `LOG_FORMAT` record's fields, in that order, from `parts`.
fn parse_commit_record<'a>(parts: &mut impl Iterator<Item = &'a str>) -> Option<CommitSummary> {
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
}

/// Whether a `log -z --name-status` token is a status (`M`, `R100`, …): an
/// uppercase letter then digits, which a lowercase-hex hash never matches.
fn is_bare_status_token(token: &str) -> bool {
    let mut chars = token.chars();
    chars.next().is_some_and(|c| c.is_ascii_uppercase()) && chars.all(|c| c.is_ascii_digit())
}

/// Whether a token opens a record's status rows: git glues a `\n` before the
/// first row only, so later rows of the same record are bare statuses.
fn is_status_token(token: &str) -> bool {
    token.strip_prefix('\n').is_some_and(is_bare_status_token)
}

/// Reads one status row's (old, new) paths after its `status` token: `R`/`C`
/// rows name old, then new; every other row names one path.
fn read_status_row<'a>(
    status: &str,
    tokens: &mut impl Iterator<Item = &'a str>,
) -> (Option<&'a str>, Option<&'a str>) {
    if status.starts_with(['R', 'C']) {
        (tokens.next(), tokens.next())
    } else {
        let own = tokens.next();
        (own, own)
    }
}

/// Parses `log --follow -z --name-status` output in `LOG_FORMAT` into entries
/// carrying the file's new-side path at each commit. A record can carry several
/// rows (the literal pathspec also matches a directory the name once was): the
/// entry takes the row whose new side is the name tracked at that point, else
/// its first row. A record without a status row takes the path the file had
/// just before the next-newer entry (its old side), or `path` for the first, so
/// pages are sliced only after the whole walk is parsed.
fn parse_file_log(text: &str, path: &str) -> Vec<FileLogEntry> {
    let mut tokens = text.split('\0').peekable();
    let mut entries = Vec::new();
    let mut newer_old_side = path.to_string();
    while let Some(first) = tokens.next() {
        let hash = first.trim_start_matches('\n');
        if hash.is_empty() {
            continue;
        }
        let Some(commit) = parse_commit_record(&mut std::iter::once(hash).chain(tokens.by_ref()))
        else {
            break;
        };
        let mut rows = Vec::new();
        if let Some(status) = tokens.next_if(|t| is_status_token(t)) {
            rows.push(read_status_row(&status[1..], &mut tokens));
            while let Some(status) = tokens.next_if(|t| is_bare_status_token(t)) {
                rows.push(read_status_row(status, &mut tokens));
            }
        }
        let (old_side, new_side) = rows
            .iter()
            .copied()
            .find(|&(_, new)| new == Some(newer_old_side.as_str()))
            .or_else(|| rows.first().copied())
            .unwrap_or((None, None));
        let entry_path = new_side.map_or_else(|| newer_old_side.clone(), str::to_string);
        newer_old_side = old_side.map_or(entry_path.clone(), str::to_string);
        entries.push(FileLogEntry {
            commit,
            path: entry_path,
        });
    }
    entries
}

/// One `git_file_log` page: the walk of `skip + limit` file commits, parsed
/// whole, minus its first `skip` entries.
fn file_log_page(text: &str, path: &str, skip: u32) -> Vec<FileLogEntry> {
    let mut entries = parse_file_log(text, path);
    entries.drain(..entries.len().min(skip as usize));
    entries
}

fn validate_path(path: &str) -> AppResult<()> {
    if path.is_empty() {
        return Err(crate::error::AppError::InvalidArgument(
            "empty file path".into(),
        ));
    }
    Ok(())
}

/// Commit history for a single file, following renames; each entry carries the
/// file's path as of that commit.
#[tauri::command]
pub async fn git_file_log(
    repo_path: String,
    path: String,
    limit: u32,
    skip: u32,
) -> AppResult<Vec<FileLogEntry>> {
    validate_path(&path)?;
    // A zero-commit repo has no HEAD to walk, so `git log --follow` would surface
    // raw git stderr. Mirror `git_log`'s guard: an unborn HEAD has no history, so
    // return an empty list rather than an error.
    if unborn_head(&repo_path).await? {
        return Ok(Vec::new());
    }
    // `--skip` counts commits before `--follow` filters them, so pages would
    // overlap: walk `skip + limit` file commits and drop the first `skip` here.
    // `-M` keeps a user's `diff.renames=false` from turning a rename into A/D.
    // `--no-show-signature`: `log.showSignature` prints verification text ahead of a
    // signed record, which the NUL-split parser would read as part of the hash.
    // `--relative` names rows from `repo_path` like the queried path, since the MCP
    // server may be bound to a subdirectory; history stops at a rename from outside
    // it, whose source git doesn't follow there.
    // git refuses an `-n` past i32::MAX ("not an integer", measured).
    let n_arg = skip.saturating_add(limit).min(i32::MAX as u32).to_string();
    // Literal pathspec, honored even under `--follow`: a raw `[slug]`-style path
    // lists a glob-sibling's commits as this file's history (measured).
    let spec = crate::git::pathspec::literal(&path);
    let out = run_git(
        Some(&repo_path),
        &[
            "log",
            "--no-show-signature",
            "--follow",
            "-M",
            "--relative",
            "--name-status",
            "-z",
            "-n",
            &n_arg,
            LOG_FORMAT,
            "--",
            &spec,
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(file_log_page(&out.stdout_lossy(), &path, skip))
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

    // Resolve the optional rev to a concrete full sha, or guard the unborn-HEAD
    // case: an unknown rev (exit 1) and an unborn HEAD get friendly errors, and
    // any other probe failure is an error, carrying git's report where git gave
    // one.
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
            // Compare surface) and normalizes to a full sha. Only exit 1 means
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
        // Header: "<full sha> <orig-line> <final-line> [<group-size>]"; the sha
        // is 40 hex digits in a SHA-1 repository and 64 in a SHA-256 one.
        if let Some((sha, rest)) = line.split_once(' ') {
            if (sha.len() == 40 || sha.len() == 64) && sha.bytes().all(|b| b.is_ascii_hexdigit()) {
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
    // The helper passes literal pathspecs: a raw `[slug]`-style path splices a
    // glob-sibling's hunks into the commit diff shown for this file (measured).
    let out = super::diff::diff_with_rename_pairing(
        &repo_path,
        &file_path,
        &[
            "show",
            "--no-show-signature",
            "-m",
            "--first-parent",
            "--no-color",
            "--format=",
            &hash,
        ],
        &[
            "show",
            "--no-show-signature",
            "-m",
            "--first-parent",
            "--name-status",
            "-z",
            "--format=",
            &hash,
        ],
    )
    .await?;
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
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
        old_path: out.old_path,
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
            // blame-errors.ts matches these opening words, after stripping the
            // serialized "invalid argument: " Display lead.
            crate::error::AppError::InvalidArgument(msg) => {
                assert!(
                    msg.starts_with("repository has no commits yet"),
                    "unexpected message: {msg}"
                );
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

    /// The frontend's `FileLogEntry extends CommitSummary`: the commit fields sit
    /// at the top level beside `path`, never nested under `commit`.
    #[test]
    fn file_log_entry_wire_shape_is_flat() {
        let json = serde_json::to_value(FileLogEntry {
            commit: CommitSummary {
                hash: "abc".into(),
                subject: "s".into(),
                author: "a".into(),
                author_email: "a@x".into(),
                date: "d".into(),
                tags: vec![],
                is_merge: false,
            },
            path: "p.txt".into(),
        })
        .unwrap();
        for key in [
            "hash",
            "subject",
            "author",
            "authorEmail",
            "date",
            "tags",
            "isMerge",
            "path",
        ] {
            assert!(json.get(key).is_some(), "missing {key}: {json}");
        }
        assert!(json.get("commit").is_none(), "{json}");
        assert!(json.get("author_email").is_none(), "{json}");
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
        // `show-ref --exists` arrived in git 2.43; older git reads this as unborn.
        let exists = run_git_raw(
            Some(&repo),
            &["show-ref", "--exists", &branch],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        if exists.code == 129 {
            assert!(unborn_head(&repo).await.unwrap());
            return;
        }
        let unborn = unborn_head(&repo).await;
        assert!(unborn.is_err(), "unborn_head: {unborn:?}");
        assert!(git_log(repo.clone(), 10, 0, None).await.is_err());
        let unpushed = crate::git::branches::git_unpushed_count(repo).await;
        assert!(unpushed.is_err(), "{unpushed:?}");
    }

    /// One of the two "no history to blame" shapes blame-errors.ts reads as
    /// not tracked (the other is `blame_unborn_head_errors`'s refusal); any
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

    async fn file_log_repo(tag: &str) -> (tempfile::TempDir, String) {
        let (dir, repo) = temp_repo(tag);
        git(&repo, &["init", "-q"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        git(&repo, &["config", "commit.gpgSign", "false"]).await;
        (dir, repo)
    }

    async fn head_sha(repo: &str) -> String {
        run_git(Some(repo), &["rev-parse", "HEAD"], DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
            .trim()
            .to_string()
    }

    /// Writes `content` to `rel` (creating its folder), commits everything, and
    /// returns the new commit's sha.
    async fn commit_file(repo: &str, rel: &str, content: &str, msg: &str) -> String {
        let file = Path::new(repo).join(rel);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(file, content).unwrap();
        git(repo, &["add", "-A"]).await;
        git(repo, &["commit", "-q", "-m", msg]).await;
        head_sha(repo).await
    }

    async fn rename_file(repo: &str, from: &str, to: &str, msg: &str) -> String {
        if let Some(parent) = Path::new(repo).join(to).parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        git(repo, &["mv", from, to]).await;
        git(repo, &["commit", "-q", "-m", msg]).await;
        head_sha(repo).await
    }

    /// The single full `--follow` walk every page must be a slice of.
    async fn full_walk(repo: &str, path: &str) -> Vec<String> {
        let spec = crate::git::pathspec::literal(path);
        run_git(
            Some(repo),
            &["log", "--follow", "--format=%H", "--", &spec],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .stdout_lossy()
        .lines()
        .map(str::to_string)
        .collect()
    }

    /// Every page `git_file_log` serves at `limit`, through the first short one.
    async fn all_pages(repo: &str, path: &str, limit: u32) -> Vec<Vec<FileLogEntry>> {
        let mut pages = Vec::new();
        let mut skip = 0;
        loop {
            let page = git_file_log(repo.to_string(), path.to_string(), limit, skip)
                .await
                .unwrap();
            let short = page.len() < limit as usize;
            pages.push(page);
            if short {
                return pages;
            }
            skip += limit;
        }
    }

    fn page_hashes(page: &[FileLogEntry]) -> Vec<&str> {
        page.iter().map(|e| e.commit.hash.as_str()).collect()
    }

    /// Asserts each page is the matching `limit`-slice of the full walk.
    async fn assert_pages_slice_the_walk(repo: &str, path: &str, limit: u32) {
        let walk = full_walk(repo, path).await;
        let pages = all_pages(repo, path, limit).await;
        let chunks: Vec<&[String]> = walk.chunks(limit as usize).collect();
        for (i, page) in pages.iter().enumerate() {
            let expected: Vec<&str> = chunks
                .get(i)
                .map_or(Vec::new(), |c| c.iter().map(String::as_str).collect());
            assert_eq!(page_hashes(page), expected, "page {i} of {path}");
        }
        let served: usize = pages.iter().map(Vec::len).sum();
        assert_eq!(served, walk.len(), "pages served a different total");
    }

    #[test]
    fn parse_file_log_reads_the_measured_z_stream() {
        let (h3, h2, h1) = ("c".repeat(40), "b".repeat(40), "a".repeat(40));
        let text = format!(
            "{h3}\0rename\0t\0t@t\0d3\0HEAD -> main\0{h2}\0\nR100\0f.txt\0g.txt\0\
             {h2}\0edit\0t\0t@t\0d2\0\0{h1}\0\nM\0f.txt\0\
             {h1}\0root\0t\0t@t\0d1\0tag: v1\0\0\nA\0f.txt\0"
        );
        let entries = parse_file_log(&text, "g.txt");
        let got: Vec<(&str, &str)> = entries
            .iter()
            .map(|e| (e.commit.hash.as_str(), e.path.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                (h3.as_str(), "g.txt"),
                (h2.as_str(), "f.txt"),
                (h1.as_str(), "f.txt")
            ]
        );
        assert_eq!(entries[0].commit.subject, "rename");
        assert_eq!(entries[2].commit.tags, vec!["v1".to_string()]);
        assert!(entries.iter().all(|e| !e.commit.is_merge));
    }

    /// A record with no status row (a listed merge) takes the path the file had
    /// just before its next-newer entry, resolved over the whole walk: opening
    /// page 2 it must not fall back to the queried name.
    #[test]
    fn file_log_page_inherits_a_statusless_path_before_slicing() {
        let (h4, h3, h2, h1) = (
            "d".repeat(64),
            "c".repeat(64),
            "b".repeat(64),
            "a".repeat(64),
        );
        let text = format!(
            "{h4}\0edit\0t\0t@t\0d4\0\0{h3}\0\nM\0g.txt\0\
             {h3}\0rename\0t\0t@t\0d3\0\0{h2}\0\nR087\0f.txt\0g.txt\0\
             {h2}\0merge\0t\0t@t\0d2\0\0{h1} {h1}\0\
             {h1}\0root\0t\0t@t\0d1\0\0\0\nA\0f.txt\0"
        );
        let page2 = file_log_page(&text, "g.txt", 2);
        let got: Vec<(&str, &str, bool)> = page2
            .iter()
            .map(|e| (e.commit.hash.as_str(), e.path.as_str(), e.commit.is_merge))
            .collect();
        assert_eq!(
            got,
            vec![(h2.as_str(), "f.txt", true), (h1.as_str(), "f.txt", false)]
        );

        // Statusless first record: the queried path; a `\n` before the next
        // record's hash is tolerated.
        let lead = format!(
            "{h2}\0merge\0t\0t@t\0d2\0\0{h1} {h1}\0\n{h1}\0root\0t\0t@t\0d1\0\0\0\nA\0f.txt\0"
        );
        let entries = parse_file_log(&lead, "f.txt");
        assert_eq!(page_hashes(&entries), vec![h2.as_str(), h1.as_str()]);
        assert!(entries.iter().all(|e| e.path == "f.txt"));

        assert!(file_log_page(&text, "g.txt", u32::MAX).is_empty());
    }

    /// Only a record's first status row carries the `\n`; the rest are read as
    /// rows of the same record, and the entry takes the row naming the tracked
    /// file.
    #[test]
    fn parse_file_log_reads_every_row_of_a_record() {
        let (h3, h2, h1) = ("c".repeat(40), "b".repeat(40), "a".repeat(40));
        let text = format!(
            "{h3}\0edit\0t\0t@t\0d3\0\0{h2}\0\nM\0a\0\
             {h2}\0swap\0t\0t@t\0d2\0\0{h1}\0\nD\0a/x\0R090\0b\0a\0M\0a/y\0\
             {h1}\0root\0t\0t@t\0d1\0\0\0\nA\0b\0"
        );
        let entries = parse_file_log(&text, "a");
        let got: Vec<(&str, &str, &str)> = entries
            .iter()
            .map(|e| {
                (
                    e.commit.hash.as_str(),
                    e.commit.subject.as_str(),
                    e.path.as_str(),
                )
            })
            .collect();
        assert_eq!(
            got,
            vec![
                (h3.as_str(), "edit", "a"),
                (h2.as_str(), "swap", "a"),
                (h1.as_str(), "root", "b")
            ]
        );
    }

    /// A followed file whose name was once a directory: the literal pathspec
    /// matches the directory's file too, so one commit lists two rows.
    #[tokio::test]
    async fn file_log_follows_a_name_that_was_once_a_directory() {
        let (_dir, repo) = file_log_repo("file-log-dir-name").await;
        commit_file(&repo, "a/x", "directory file\n", "c1").await;
        let dir = Path::new(&repo).join("a");
        git(&repo, &["rm", "-q", "a/x"]).await;
        if dir.exists() {
            std::fs::remove_dir_all(&dir).unwrap();
        }
        let c2 = commit_file(&repo, "a", "a plain file\nnothing alike\n", "c2").await;
        let c3 = commit_file(&repo, "a", "a plain file\nedited\n", "c3").await;
        let walk = full_walk(&repo, "a").await;
        let entries = git_file_log(repo.clone(), "a".into(), 50, 0).await.unwrap();
        assert_eq!(
            page_hashes(&entries),
            walk.iter().map(String::as_str).collect::<Vec<_>>()
        );
        let subjects: Vec<&str> = entries.iter().map(|e| e.commit.subject.as_str()).collect();
        assert_eq!(subjects, vec!["c3", "c2", "c1"]);
        assert_eq!(entries[0].commit.hash, c3);
        assert_eq!(entries[1].commit.hash, c2);
        assert_eq!(entries[1].path, "a");
        assert_pages_slice_the_walk(&repo, "a", 1).await;
    }

    /// With untouched commits between the file's own, each page is the next
    /// `limit` file commits: no commit repeats and none is skipped.
    #[tokio::test]
    async fn file_log_pages_skip_untouched_commits_exactly() {
        let (_dir, repo) = file_log_repo("file-log-pages").await;
        let mut touched = Vec::new();
        let mut body = String::new();
        for i in 1..=8 {
            if i == 4 || i == 7 {
                commit_file(&repo, "other.txt", &format!("{i}\n"), &format!("c{i}")).await;
            } else {
                body.push_str(&format!("{i}\n"));
                touched.push(commit_file(&repo, "f.txt", &body, &format!("c{i}")).await);
            }
        }
        touched.reverse();
        let pages = all_pages(&repo, "f.txt", 2).await;
        let got: Vec<Vec<&str>> = pages.iter().map(|p| page_hashes(p)).collect();
        let expected: Vec<Vec<&str>> = touched
            .chunks(2)
            .map(|c| c.iter().map(String::as_str).collect())
            .chain(std::iter::once(Vec::new()))
            .collect();
        assert_eq!(got, expected);
        assert_pages_slice_the_walk(&repo, "f.txt", 2).await;
        assert!(pages.iter().flatten().all(|e| e.path == "f.txt"));
    }

    #[tokio::test]
    async fn file_log_pages_list_merged_side_commits_once() {
        let (_dir, repo) = file_log_repo("file-log-merge").await;
        commit_file(&repo, "f.txt", "a\nb\nc\n", "m1").await;
        let main = run_git(
            Some(&repo),
            &["symbolic-ref", "--short", "HEAD"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .stdout_lossy()
        .trim()
        .to_string();
        // A clean merge: TREESAME to the side parent, so only the side commit lists.
        git(&repo, &["checkout", "-q", "-b", "side"]).await;
        let side = commit_file(&repo, "f.txt", "A\nb\nc\n", "s1").await;
        git(&repo, &["checkout", "-q", &main]).await;
        commit_file(&repo, "other.txt", "o\n", "m2").await;
        git(
            &repo,
            &["merge", "-q", "--no-ff", "-m", "merge side", "side"],
        )
        .await;
        // A conflicted merge resolved to content neither side had.
        git(&repo, &["checkout", "-q", "-b", "side2"]).await;
        let side2 = commit_file(&repo, "f.txt", "A\nx\nc\n", "s2").await;
        git(&repo, &["checkout", "-q", &main]).await;
        let m3 = commit_file(&repo, "f.txt", "A\ny\nc\n", "m3").await;
        let merged = run_git_raw(
            Some(&repo),
            &["merge", "-q", "-m", "merge side2", "side2"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_ne!(merged.code, 0, "the second merge must conflict");
        let conflicted = commit_file(&repo, "f.txt", "A\nz\nc\n", "resolve").await;
        commit_file(&repo, "f.txt", "A\nz\nc\nd\n", "m4").await;
        commit_file(&repo, "f.txt", "A\nz\nc\nd\ne\n", "m5").await;

        assert_pages_slice_the_walk(&repo, "f.txt", 2).await;
        let pages = all_pages(&repo, "f.txt", 2).await;
        let all: Vec<&FileLogEntry> = pages.iter().flatten().collect();
        for sha in [&side, &side2, &m3] {
            let n = all.iter().filter(|e| &e.commit.hash == sha).count();
            assert_eq!(n, 1, "{sha} listed {n} times");
        }
        let mut seen = std::collections::HashSet::new();
        assert!(all.iter().all(|e| seen.insert(e.commit.hash.as_str())));
        // git 2.51.1 does not list the conflicted merge under `--follow` (merge
        // diffs are off); were it listed, it would carry the inherited path.
        assert!(all
            .iter()
            .filter(|e| e.commit.hash == conflicted)
            .all(|e| e.path == "f.txt"));
        assert!(all.iter().all(|e| e.path == "f.txt"));
    }

    /// The rename commit closes page 1 under its new name; the commit before it
    /// opens page 2 under the old one. `diff.renames=false` is pinned to prove
    /// the argv's `-M` keeps the row a rename.
    #[tokio::test]
    async fn file_log_carries_each_commits_path_across_a_rename_at_a_page_boundary() {
        let (_dir, repo) = file_log_repo("file-log-rename").await;
        git(&repo, &["config", "diff.renames", "false"]).await;
        let a1 = commit_file(&repo, "f.txt", "one\ntwo\nthree\n", "a1").await;
        let a2 = commit_file(&repo, "f.txt", "one\ntwo\nthree\nfour\n", "a2").await;
        let a3 = rename_file(&repo, "f.txt", "g.txt", "a3").await;
        let a4 = commit_file(&repo, "g.txt", "one\ntwo\nthree\nfour\nfive\n", "a4").await;

        let pages = all_pages(&repo, "g.txt", 2).await;
        let got: Vec<Vec<(&str, &str)>> = pages
            .iter()
            .map(|p| {
                p.iter()
                    .map(|e| (e.commit.hash.as_str(), e.path.as_str()))
                    .collect()
            })
            .collect();
        assert_eq!(
            got,
            vec![
                vec![(a4.as_str(), "g.txt"), (a3.as_str(), "g.txt")],
                vec![(a2.as_str(), "f.txt"), (a1.as_str(), "f.txt")],
                vec![],
            ]
        );
        assert_pages_slice_the_walk(&repo, "g.txt", 2).await;
    }

    /// `-z` keeps non-ASCII names raw and the literal pathspec keeps `[slug]`
    /// from matching its glob sibling `s/a.txt`.
    #[tokio::test]
    async fn file_log_paths_round_trip_hostile_names_verbatim() {
        let (_dir, repo) = file_log_repo("file-log-names").await;
        let created = commit_file(&repo, "s\u{e4}gen.txt", "saw\nblade\nteeth\n", "create").await;
        commit_file(&repo, "s/a.txt", "sibling\n", "sibling").await;
        let renamed = rename_file(&repo, "s\u{e4}gen.txt", "[slug]/a.txt", "rename").await;
        let edited =
            commit_file(&repo, "[slug]/a.txt", "saw\nblade\nteeth\nhandle\n", "edit").await;
        commit_file(&repo, "s/a.txt", "sibling\nagain\n", "sibling again").await;

        let entries = git_file_log(repo.clone(), "[slug]/a.txt".into(), 10, 0)
            .await
            .unwrap();
        let got: Vec<(&str, &str)> = entries
            .iter()
            .map(|e| (e.commit.hash.as_str(), e.path.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![
                (edited.as_str(), "[slug]/a.txt"),
                (renamed.as_str(), "[slug]/a.txt"),
                (created.as_str(), "s\u{e4}gen.txt"),
            ]
        );
    }

    #[tokio::test]
    async fn file_log_saturates_an_overflowing_page_request() {
        let (_dir, repo, _first, _second) = two_commit_repo("file-log-overflow").await;
        let all = git_file_log(repo.clone(), "file.txt".into(), u32::MAX, 0)
            .await
            .unwrap();
        assert_eq!(all.len(), 2);
        let beyond = git_file_log(repo, "file.txt".into(), u32::MAX, u32::MAX)
            .await
            .unwrap();
        assert!(beyond.is_empty());
    }

    /// SHA-256 repositories print 64-hex blame headers and log hashes.
    #[tokio::test]
    async fn blame_and_file_log_read_a_sha256_repository() {
        let (_dir, repo) = temp_repo("sha256");
        let init = run_git_raw(
            Some(&repo),
            &["init", "-q", "--object-format=sha256"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        if init.code != 0 {
            eprintln!(
                "SKIPPED blame_and_file_log_read_a_sha256_repository: this git can't init \
                 a sha256 repository ({})",
                init.stderr.trim()
            );
            return;
        }
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        git(&repo, &["config", "commit.gpgSign", "false"]).await;
        let first = commit_file(&repo, "file.txt", "first\n", "one").await;
        let second = commit_file(&repo, "file.txt", "first\nsecond\n", "two").await;
        assert_eq!(first.len(), 64, "{first}");

        let lines = git_blame(repo.clone(), "file.txt".into(), None)
            .await
            .unwrap();
        let got: Vec<(&str, &str, &str)> = lines
            .iter()
            .map(|l| (l.hash.as_str(), l.author.as_str(), l.summary.as_str()))
            .collect();
        assert_eq!(
            got,
            vec![(first.as_str(), "t", "one"), (second.as_str(), "t", "two")]
        );
        assert!(lines.iter().all(|l| l.time > 0));

        let entries = git_file_log(repo, "file.txt".into(), 10, 0).await.unwrap();
        assert_eq!(page_hashes(&entries), vec![second.as_str(), first.as_str()]);
    }
}
