use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git, run_git_raw, DEFAULT_TIMEOUT};

/// One full-history `git log` pass plus a working-tree scan can outlast the
/// default timeout on very large repositories.
const STATS_TIMEOUT: Duration = Duration::from_secs(120);

/// Files larger than this are sized but not read for line counting — anything
/// this big is generated output or an asset, not hand-written code.
const MAX_COUNTED_FILE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguageStat {
    pub name: String,
    pub files: u32,
    pub lines: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributorStat {
    pub name: String,
    pub commits: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStats {
    pub commit_count: u64,
    pub branch_count: u32,
    pub tag_count: u32,
    pub contributor_count: u32,
    /// Most-active authors first, capped at five.
    pub top_contributors: Vec<ContributorStat>,
    pub first_commit_date: Option<String>,
    pub last_commit_date: Option<String>,
    pub tracked_files: u32,
    /// Size of the tracked files as they sit in the working tree.
    pub tracked_bytes: u64,
    /// Size of the .git directory (objects, packs, refs).
    pub git_dir_bytes: u64,
    /// Lines across all tracked text files (binaries excluded).
    pub total_lines: u64,
    /// Per-language line/byte makeup, largest line count first.
    pub languages: Vec<LanguageStat>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchStats {
    /// Commits on the branch that the base branch doesn't have.
    pub commit_count: u64,
    pub contributor_count: u32,
    pub top_contributors: Vec<ContributorStat>,
    pub first_commit_date: Option<String>,
    pub last_commit_date: Option<String>,
    /// Diff vs the merge base with the base branch.
    pub files_changed: u32,
    pub additions: u64,
    pub deletions: u64,
}

/// Display-name for a tracked file's language, by filename then extension.
/// None means binary-adjacent or unclassifiable — it still counts toward
/// totals but lands in the "Other" bucket.
fn language_of(path: &str) -> Option<&'static str> {
    let name = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    match name.as_str() {
        "dockerfile" => return Some("Dockerfile"),
        "makefile" => return Some("Makefile"),
        "cmakelists.txt" => return Some("CMake"),
        _ => {}
    }
    let ext = match name.rfind('.') {
        // dot at 0 is a dotfile like .gitignore — no extension to map
        Some(dot) if dot > 0 => &name[dot + 1..],
        _ => return None,
    };
    Some(match ext {
        "ts" | "tsx" | "mts" | "cts" => "TypeScript",
        "js" | "jsx" | "mjs" | "cjs" => "JavaScript",
        "rs" => "Rust",
        "py" => "Python",
        "rb" => "Ruby",
        "go" => "Go",
        "java" => "Java",
        "kt" | "kts" => "Kotlin",
        "c" | "h" => "C",
        "cpp" | "cc" | "cxx" | "hpp" => "C++",
        "cs" => "C#",
        "swift" => "Swift",
        "php" => "PHP",
        "css" => "CSS",
        "scss" => "SCSS",
        "less" => "Less",
        "html" | "htm" => "HTML",
        "xml" | "svg" => "XML",
        "json" => "JSON",
        "yaml" | "yml" => "YAML",
        "toml" => "TOML",
        "ini" => "INI",
        "md" | "markdown" => "Markdown",
        "sh" | "bash" | "zsh" => "Shell",
        "ps1" | "psm1" | "psd1" => "PowerShell",
        "bat" | "cmd" => "Batch",
        "sql" => "SQL",
        "graphql" | "gql" => "GraphQL",
        "vue" => "Vue",
        "svelte" => "Svelte",
        "lua" => "Lua",
        "r" => "R",
        "dart" => "Dart",
        "ex" | "exs" => "Elixir",
        "erl" => "Erlang",
        "hs" => "Haskell",
        "scala" => "Scala",
        "pl" | "pm" => "Perl",
        "proto" => "Protocol Buffers",
        "zig" => "Zig",
        "tf" => "HCL",
        _ => return None,
    })
}

/// Tallies author names and commit dates from `git log --format=%aN%x00%cI`
/// output (newest first): contributor counts plus the first/last dates.
struct LogTally {
    commit_count: u64,
    contributor_count: u32,
    top_contributors: Vec<ContributorStat>,
    first_commit_date: Option<String>,
    last_commit_date: Option<String>,
}

fn tally_log(stdout: &str) -> LogTally {
    let mut authors: HashMap<&str, u32> = HashMap::new();
    let mut commit_count = 0u64;
    let mut last: Option<String> = None;
    let mut first: Option<String> = None;
    for line in stdout.lines() {
        let Some((author, date)) = line.split_once('\0') else {
            continue;
        };
        commit_count += 1;
        *authors.entry(author).or_default() += 1;
        if last.is_none() {
            last = Some(date.to_string());
        }
        first = Some(date.to_string());
    }
    let mut top: Vec<ContributorStat> = authors
        .iter()
        .map(|(name, commits)| ContributorStat {
            name: (*name).to_string(),
            commits: *commits,
        })
        .collect();
    top.sort_by(|a, b| b.commits.cmp(&a.commits).then(a.name.cmp(&b.name)));
    top.truncate(5);
    LogTally {
        commit_count,
        contributor_count: authors.len() as u32,
        top_contributors: top,
        first_commit_date: first,
        last_commit_date: last,
    }
}

/// Recursive size of a directory; unreadable entries are skipped rather
/// than failing the whole scan.
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            total += dir_size(&entry.path());
        } else {
            total += meta.len();
        }
    }
    total
}

struct TreeScan {
    tracked_files: u32,
    tracked_bytes: u64,
    total_lines: u64,
    languages: Vec<LanguageStat>,
}

/// Sizes and line-counts the tracked files, bucketing text files by language.
/// Binary files (NUL byte near the start) count toward files/bytes only.
fn scan_tree(root: &Path, files: Vec<String>) -> TreeScan {
    let mut buckets: HashMap<&'static str, LanguageStat> = HashMap::new();
    let mut other = LanguageStat {
        name: "Other".into(),
        files: 0,
        lines: 0,
        bytes: 0,
    };
    let mut tracked_files = 0u32;
    let mut tracked_bytes = 0u64;
    let mut total_lines = 0u64;
    for rel in files {
        let path = root.join(&rel);
        let Ok(meta) = std::fs::metadata(&path) else {
            // Deleted from the working tree but still tracked — skip.
            continue;
        };
        tracked_files += 1;
        tracked_bytes += meta.len();
        if meta.len() > MAX_COUNTED_FILE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let head = &bytes[..bytes.len().min(8000)];
        if head.contains(&0) {
            continue; // binary
        }
        let mut lines = bytes.iter().filter(|b| **b == b'\n').count() as u64;
        if !bytes.is_empty() && bytes.last() != Some(&b'\n') {
            lines += 1;
        }
        total_lines += lines;
        let bucket = match language_of(&rel) {
            Some(lang) => buckets.entry(lang).or_insert_with(|| LanguageStat {
                name: lang.into(),
                files: 0,
                lines: 0,
                bytes: 0,
            }),
            None => &mut other,
        };
        bucket.files += 1;
        bucket.lines += lines;
        bucket.bytes += meta.len();
    }
    let mut languages: Vec<LanguageStat> = buckets.into_values().collect();
    if other.files > 0 {
        languages.push(other);
    }
    languages.sort_by(|a, b| b.lines.cmp(&a.lines).then(a.name.cmp(&b.name)));
    TreeScan {
        tracked_files,
        tracked_bytes,
        total_lines,
        languages,
    }
}

#[tauri::command]
pub async fn git_repo_stats(repo_path: String) -> AppResult<RepoStats> {
    // Non-zero exit means an unborn HEAD (no commits yet) — empty stats.
    let log = run_git_raw(
        Some(&repo_path),
        &["log", "--format=%aN%x00%cI"],
        STATS_TIMEOUT,
    )
    .await?;
    let tally = if log.code == 0 {
        tally_log(&log.stdout_lossy())
    } else {
        tally_log("")
    };

    let branches = run_git(
        Some(&repo_path),
        &["for-each-ref", "refs/heads", "--format=%(refname)"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let branch_count = branches.stdout_lossy().lines().count() as u32;
    let tags = run_git(Some(&repo_path), &["tag", "--list"], DEFAULT_TIMEOUT).await?;
    let tag_count = tags
        .stdout_lossy()
        .lines()
        .filter(|l| !l.trim().is_empty())
        .count() as u32;

    let git_dir = run_git(
        Some(&repo_path),
        &["rev-parse", "--absolute-git-dir"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let git_dir = PathBuf::from(git_dir.stdout_lossy().trim());
    let ls = run_git(Some(&repo_path), &["ls-files", "-z"], STATS_TIMEOUT).await?;
    let files: Vec<String> = ls
        .stdout_lossy()
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();

    let root = PathBuf::from(&repo_path);
    let (scan, git_dir_bytes) = tokio::task::spawn_blocking(move || {
        (scan_tree(&root, files), dir_size(&git_dir))
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e)))?;

    Ok(RepoStats {
        commit_count: tally.commit_count,
        branch_count,
        tag_count,
        contributor_count: tally.contributor_count,
        top_contributors: tally.top_contributors,
        first_commit_date: tally.first_commit_date,
        last_commit_date: tally.last_commit_date,
        tracked_files: scan.tracked_files,
        tracked_bytes: scan.tracked_bytes,
        git_dir_bytes,
        total_lines: scan.total_lines,
        languages: scan.languages,
    })
}

#[tauri::command]
pub async fn git_branch_stats(
    repo_path: String,
    branch: String,
    base: String,
) -> AppResult<BranchStats> {
    for name in [&branch, &base] {
        if name.is_empty() || name.starts_with('-') {
            return Err(AppError::InvalidArgument(format!(
                "invalid branch name: {name}"
            )));
        }
    }
    // Both are branch names: read as the branches, never same-named tags.
    let branch = crate::git::branches::branch_first_rev(&repo_path, &branch).await;
    let base = crate::git::branches::branch_first_rev(&repo_path, &base).await;
    let range = format!("{base}..{branch}");
    let log = run_git(
        Some(&repo_path),
        &["log", "--format=%aN%x00%cI", &range],
        STATS_TIMEOUT,
    )
    .await?;
    let tally = tally_log(&log.stdout_lossy());

    // Three-dot: changes since the merge base, i.e. what this branch adds.
    let merge_range = format!("{base}...{branch}");
    let diff = run_git(
        Some(&repo_path),
        &["diff", "--numstat", &merge_range],
        STATS_TIMEOUT,
    )
    .await?;
    let mut files_changed = 0u32;
    let mut additions = 0u64;
    let mut deletions = 0u64;
    for line in diff.stdout_lossy().lines() {
        let mut parts = line.split('\t');
        let (Some(add), Some(del)) = (parts.next(), parts.next()) else {
            continue;
        };
        files_changed += 1;
        // "-" marks binary files: counted as changed, no line totals.
        additions += add.parse::<u64>().unwrap_or(0);
        deletions += del.parse::<u64>().unwrap_or(0);
    }

    Ok(BranchStats {
        commit_count: tally.commit_count,
        contributor_count: tally.contributor_count,
        top_contributors: tally.top_contributors,
        first_commit_date: tally.first_commit_date,
        last_commit_date: tally.last_commit_date,
        files_changed,
        additions,
        deletions,
    })
}

// ---------------------------------------------------------------------------
// Insights graphs — computed locally from git (no token, works on private
// repos and offline, no rate limit, and none of GitHub's stats/* API
// degradations at ≥10k commits). `--no-merges` + an ISO week-year (`%G-%V`)
// bucket match GitHub's own graphs. `weeks > 0` limits to a trailing window
// (GitHub defaults to ~52); `weeks == 0` means all history.
// ---------------------------------------------------------------------------

/// Builds a `git log` arg list with the common insights flags, optionally
/// windowed. `since` must outlive the returned borrow.
fn insights_log_args<'a>(
    pretty: &'a str,
    date_format: Option<&'a str>,
    numstat: bool,
    weeks: u32,
    since: &'a str,
) -> Vec<&'a str> {
    let mut args = vec!["log", "--no-merges"];
    if numstat {
        args.push("--numstat");
    }
    if let Some(df) = date_format {
        args.push(df);
    }
    args.push(pretty);
    if weeks > 0 {
        args.push(since);
    }
    args
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributorChurn {
    pub name: String,
    pub commits: u32,
    pub additions: u64,
    pub deletions: u64,
}

/// Every contributor with their commit count and line churn (`git log
/// --numstat`), most commits first. The Insights superset of `top_contributors`.
#[tauri::command]
pub async fn git_contributor_activity(
    repo_path: String,
    weeks: u32,
) -> AppResult<Vec<ContributorChurn>> {
    let since = format!("--since={weeks} weeks ago");
    let args = insights_log_args(
        "--pretty=format:%x01%aN%x00%aE",
        None,
        true,
        weeks,
        &since,
    );
    let out = run_git_raw(Some(&repo_path), &args, STATS_TIMEOUT).await?;
    if out.code != 0 {
        return Ok(Vec::new());
    }
    let text = out.stdout_lossy();
    let mut by_author: HashMap<String, ContributorChurn> = HashMap::new();
    // Each commit block starts with the \x01 sentinel; its first line is
    // "name\0email", the rest are numstat "adds\tdels\tpath" rows.
    for block in text.split('\u{1}') {
        let block = block.trim_start_matches('\n');
        if block.is_empty() {
            continue;
        }
        let mut lines = block.lines();
        let Some(header) = lines.next() else { continue };
        let (name, _email) = header.split_once('\0').unwrap_or((header, ""));
        let entry = by_author
            .entry(name.to_string())
            .or_insert_with(|| ContributorChurn {
                name: name.to_string(),
                commits: 0,
                additions: 0,
                deletions: 0,
            });
        entry.commits += 1;
        for l in lines {
            let mut parts = l.split('\t');
            let (Some(add), Some(del)) = (parts.next(), parts.next()) else {
                continue;
            };
            entry.additions += add.parse::<u64>().unwrap_or(0);
            entry.deletions += del.parse::<u64>().unwrap_or(0);
        }
    }
    let mut list: Vec<ContributorChurn> = by_author.into_values().collect();
    list.sort_by(|a, b| b.commits.cmp(&a.commits).then(a.name.cmp(&b.name)));
    Ok(list)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeekCount {
    /// ISO week-year, e.g. "2025-07" (sorts chronologically as a string).
    pub week: String,
    pub commits: u32,
}

/// Commits per ISO week — GitHub's "commit activity" graph.
#[tauri::command]
pub async fn git_commit_activity(repo_path: String, weeks: u32) -> AppResult<Vec<WeekCount>> {
    let since = format!("--since={weeks} weeks ago");
    let args = insights_log_args(
        "--pretty=format:%ad",
        Some("--date=format:%G-%V"),
        false,
        weeks,
        &since,
    );
    let out = run_git_raw(Some(&repo_path), &args, STATS_TIMEOUT).await?;
    if out.code != 0 {
        return Ok(Vec::new());
    }
    let mut counts: HashMap<String, u32> = HashMap::new();
    for line in out.stdout_lossy().lines() {
        let week = line.trim();
        if week.is_empty() {
            continue;
        }
        *counts.entry(week.to_string()).or_default() += 1;
    }
    let mut list: Vec<WeekCount> = counts
        .into_iter()
        .map(|(week, commits)| WeekCount { week, commits })
        .collect();
    list.sort_by(|a, b| a.week.cmp(&b.week));
    Ok(list)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFreqPoint {
    pub week: String,
    pub additions: u64,
    pub deletions: u64,
}

/// Additions/deletions per ISO week — GitHub's "code frequency" graph.
#[tauri::command]
pub async fn git_code_frequency(repo_path: String, weeks: u32) -> AppResult<Vec<CodeFreqPoint>> {
    let since = format!("--since={weeks} weeks ago");
    let args = insights_log_args(
        "--pretty=format:%x00%ad",
        Some("--date=format:%G-%V"),
        true,
        weeks,
        &since,
    );
    let out = run_git_raw(Some(&repo_path), &args, STATS_TIMEOUT).await?;
    if out.code != 0 {
        return Ok(Vec::new());
    }
    let mut by_week: HashMap<String, (u64, u64)> = HashMap::new();
    let mut current: Option<String> = None;
    // A "\0<week>" line sets the current bucket; following numstat rows add to it.
    for line in out.stdout_lossy().lines() {
        if let Some(week) = line.strip_prefix('\0') {
            current = Some(week.to_string());
            continue;
        }
        let Some(week) = &current else { continue };
        let mut parts = line.split('\t');
        let (Some(add), Some(del)) = (parts.next(), parts.next()) else {
            continue;
        };
        let entry = by_week.entry(week.clone()).or_insert((0, 0));
        entry.0 += add.parse::<u64>().unwrap_or(0);
        entry.1 += del.parse::<u64>().unwrap_or(0);
    }
    let mut list: Vec<CodeFreqPoint> = by_week
        .into_iter()
        .map(|(week, (additions, deletions))| CodeFreqPoint {
            week,
            additions,
            deletions,
        })
        .collect();
    list.sort_by(|a, b| a.week.cmp(&b.week));
    Ok(list)
}

/// Commits bucketed into a 7×24 day-of-week × hour grid (`%w` 0=Sunday, matching
/// GitHub's punch card). Always 7 rows of 24, zero-filled.
#[tauri::command]
pub async fn git_punch_card(repo_path: String, weeks: u32) -> AppResult<Vec<Vec<u32>>> {
    let since = format!("--since={weeks} weeks ago");
    let args = insights_log_args(
        "--pretty=format:%ad",
        Some("--date=format:%w %H"),
        false,
        weeks,
        &since,
    );
    let out = run_git_raw(Some(&repo_path), &args, STATS_TIMEOUT).await?;
    let mut grid = vec![vec![0u32; 24]; 7];
    if out.code != 0 {
        return Ok(grid);
    }
    for line in out.stdout_lossy().lines() {
        let mut parts = line.split_whitespace();
        let (Some(d), Some(h)) = (parts.next(), parts.next()) else {
            continue;
        };
        let (Ok(day), Ok(hour)) = (d.parse::<usize>(), h.parse::<usize>()) else {
            continue;
        };
        if day < 7 && hour < 24 {
            grid[day][hour] += 1;
        }
    }
    Ok(grid)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn git(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// Both sides are read as BRANCHES: tags named like the base and the branch sit
    /// on the seed, where a bare name would resolve to them (gitrevisions checks tags
    /// first) and measure an empty range.
    #[tokio::test]
    async fn branch_stats_measure_branches_shadowed_by_tags() {
        let dir = tempfile::Builder::new()
            .prefix("gd-stats-tag-shadow-")
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        git(&repo, &["init", "-q"]).await;
        git(&repo, &["config", "user.email", "t@t.local"]).await;
        git(&repo, &["config", "user.name", "T"]).await;
        git(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]).await;
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "seed"]).await;
        git(&repo, &["tag", "main"]).await;
        git(&repo, &["tag", "feature"]).await;
        std::fs::write(dir.path().join("m.txt"), "m\n").unwrap();
        git(&repo, &["add", "-A"]).await;
        git(&repo, &["commit", "-qm", "base work"]).await;
        git(&repo, &["switch", "-qc", "feature"]).await;
        std::fs::write(dir.path().join("f.txt"), "f\nf\n").unwrap();
        git(&repo, &["add", "-A"]).await;
        git(&repo, &["commit", "-qm", "branch work"]).await;

        let stats = git_branch_stats(repo, "feature".into(), "main".into())
            .await
            .expect("measure the branch");
        assert_eq!(
            (stats.commit_count, stats.files_changed, stats.additions),
            (1, 1, 2)
        );
    }

    #[test]
    fn language_of_maps_names_and_extensions() {
        assert_eq!(language_of("src/main.rs"), Some("Rust"));
        assert_eq!(language_of("src/App.TSX"), Some("TypeScript"));
        assert_eq!(language_of("docker/Dockerfile"), Some("Dockerfile"));
        assert_eq!(language_of(".gitignore"), None);
        assert_eq!(language_of("assets/logo.png"), None);
    }

    #[test]
    fn tally_log_counts_authors_and_dates() {
        let log = "Bea\x002026-06-10T10:00:00+00:00\nAl\x002026-06-09T10:00:00+00:00\nBea\x002026-06-08T10:00:00+00:00\n";
        let t = tally_log(log);
        assert_eq!(t.commit_count, 3);
        assert_eq!(t.contributor_count, 2);
        assert_eq!(t.top_contributors[0].name, "Bea");
        assert_eq!(t.top_contributors[0].commits, 2);
        assert_eq!(t.last_commit_date.as_deref(), Some("2026-06-10T10:00:00+00:00"));
        assert_eq!(t.first_commit_date.as_deref(), Some("2026-06-08T10:00:00+00:00"));
    }
}
