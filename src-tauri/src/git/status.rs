use tauri::State;

use crate::error::AppResult;
use crate::git::runner::{run_git, DEFAULT_TIMEOUT};
use crate::git::types::{BranchHead, ChangeKind, FileEntry, RepoStatus};
use crate::state::AppState;

/// Core of [`git_status`], callable outside a Tauri context (e.g. the Tier-3 MCP
/// server). The `#[tauri::command]` wrapper only adds the (unused) `State` for
/// IPC; both call this, so there's a single source of truth and no drift.
pub async fn status_core(repo_path: &str) -> AppResult<RepoStatus> {
    let out = run_git(
        Some(repo_path),
        // -uall lists files inside untracked directories individually
        // instead of collapsing them to "dir/"
        &[
            "status",
            "--porcelain=v2",
            "--branch",
            "--untracked-files=all",
            "-z",
        ],
        DEFAULT_TIMEOUT,
    )
    .await?;
    Ok(parse_status_v2(&out.stdout_lossy()))
}

#[tauri::command]
pub async fn git_status(_state: State<'_, AppState>, repo_path: String) -> AppResult<RepoStatus> {
    status_core(&repo_path).await
}

fn change_kind(c: char) -> Option<ChangeKind> {
    match c {
        'M' => Some(ChangeKind::Modified),
        'T' => Some(ChangeKind::Typechange),
        'A' => Some(ChangeKind::Added),
        'D' => Some(ChangeKind::Deleted),
        'R' => Some(ChangeKind::Renamed),
        'C' => Some(ChangeKind::Copied),
        _ => None,
    }
}

/// Parses `git status --porcelain=v2 --branch -z` output.
/// With -z, records are NUL-separated; a rename/copy record (`2 ...`) is
/// followed by an extra NUL-separated token holding the original path.
pub fn parse_status_v2(text: &str) -> RepoStatus {
    let mut branch = BranchHead {
        name: None,
        detached: false,
        oid: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        upstream_gone: false,
    };
    let mut entries = Vec::new();
    // Porcelain v2 has no `[gone]` token. When the upstream ref is gone git still
    // emits `# branch.upstream <name>` but omits `# branch.ab` entirely; a live
    // upstream always produces a `branch.ab` line (even `+0 -0`). So a present
    // upstream with no `branch.ab` seen ⇒ gone.
    let mut saw_ab = false;

    let mut tokens = text.split('\0').peekable();
    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        if let Some(header) = token.strip_prefix("# ") {
            if let Some(oid) = header.strip_prefix("branch.oid ") {
                branch.oid = (oid != "(initial)").then(|| oid.to_string());
            } else if let Some(head) = header.strip_prefix("branch.head ") {
                if head == "(detached)" {
                    branch.detached = true;
                } else {
                    branch.name = Some(head.to_string());
                }
            } else if let Some(upstream) = header.strip_prefix("branch.upstream ") {
                branch.upstream = Some(upstream.to_string());
            } else if let Some(ab) = header.strip_prefix("branch.ab ") {
                saw_ab = true;
                for part in ab.split(' ') {
                    if let Some(a) = part.strip_prefix('+') {
                        branch.ahead = a.parse().unwrap_or(0);
                    } else if let Some(b) = part.strip_prefix('-') {
                        branch.behind = b.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }

        match token.chars().next() {
            Some('1') => {
                // 1 XY sub mH mI mW hH hI path
                let mut fields = token.splitn(9, ' ');
                let xy = fields.nth(1).unwrap_or("..");
                let path = fields.nth(6).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                entries.push(entry_from_xy(xy, path, None));
            }
            Some('2') => {
                // 2 XY sub mH mI mW hH hI Xscore path  (NUL)  origPath
                let mut fields = token.splitn(10, ' ');
                let xy = fields.nth(1).unwrap_or("..");
                let path = fields.nth(7).unwrap_or("");
                let orig = tokens.next().map(|s| s.to_string());
                if path.is_empty() {
                    continue;
                }
                entries.push(entry_from_xy(xy, path, orig));
            }
            Some('u') => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let path = token.splitn(11, ' ').nth(10).unwrap_or("");
                if path.is_empty() {
                    continue;
                }
                entries.push(FileEntry {
                    path: path.to_string(),
                    orig_path: None,
                    staged: None,
                    unstaged: Some(ChangeKind::Conflicted),
                });
            }
            Some('?') => {
                let path = token.split_once(' ').map_or("", |x| x.1);
                if path.is_empty() {
                    continue;
                }
                entries.push(FileEntry {
                    path: path.to_string(),
                    orig_path: None,
                    staged: None,
                    unstaged: Some(ChangeKind::Untracked),
                });
            }
            _ => {} // '!' ignored entries and anything unknown
        }
    }

    branch.upstream_gone = branch.upstream.is_some() && !saw_ab;

    RepoStatus { branch, entries }
}

fn entry_from_xy(xy: &str, path: &str, orig_path: Option<String>) -> FileEntry {
    let mut chars = xy.chars();
    let x = chars.next().unwrap_or('.');
    let y = chars.next().unwrap_or('.');
    FileEntry {
        path: path.to_string(),
        orig_path,
        staged: change_kind(x),
        unstaged: change_kind(y),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn z(parts: &[&str]) -> String {
        parts.join("\0")
    }

    #[test]
    fn parses_branch_headers_with_upstream() {
        let text = z(&[
            "# branch.oid abc123",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "",
        ]);
        let s = parse_status_v2(&text);
        assert_eq!(s.branch.name.as_deref(), Some("main"));
        assert!(!s.branch.detached);
        assert_eq!(s.branch.oid.as_deref(), Some("abc123"));
        assert_eq!(s.branch.upstream.as_deref(), Some("origin/main"));
        assert_eq!(s.branch.ahead, 2);
        assert_eq!(s.branch.behind, 1);
        // A live upstream always emits a branch.ab line, so it's not gone.
        assert!(!s.branch.upstream_gone);
        assert!(s.entries.is_empty());
    }

    #[test]
    fn upstream_present_without_ab_line_is_gone() {
        // When the remote branch is deleted, git keeps the upstream header but
        // drops the branch.ab line entirely — porcelain v2's only "gone" signal.
        let text = z(&[
            "# branch.oid abc123",
            "# branch.head feature",
            "# branch.upstream origin/feature",
            "",
        ]);
        let s = parse_status_v2(&text);
        assert_eq!(s.branch.upstream.as_deref(), Some("origin/feature"));
        assert!(s.branch.upstream_gone);
        assert_eq!(s.branch.ahead, 0);
        assert_eq!(s.branch.behind, 0);
    }

    #[test]
    fn no_upstream_is_not_gone() {
        // A branch that never had an upstream must not read as gone.
        let text = z(&["# branch.oid abc123", "# branch.head feature", ""]);
        let s = parse_status_v2(&text);
        assert_eq!(s.branch.upstream, None);
        assert!(!s.branch.upstream_gone);
    }

    #[test]
    fn parses_empty_repo_initial_oid() {
        let text = z(&["# branch.oid (initial)", "# branch.head main", ""]);
        let s = parse_status_v2(&text);
        assert_eq!(s.branch.oid, None);
        assert_eq!(s.branch.name.as_deref(), Some("main"));
    }

    #[test]
    fn parses_detached_head() {
        let text = z(&["# branch.oid abc123", "# branch.head (detached)", ""]);
        let s = parse_status_v2(&text);
        assert!(s.branch.detached);
        assert_eq!(s.branch.name, None);
    }

    #[test]
    fn parses_ordinary_entries() {
        let text = z(&[
            "# branch.head main",
            "1 .M N... 100644 100644 100644 e69de29 e69de29 app.js",
            "1 A. N... 000000 100644 100644 0000000 e69de29 staged.txt",
            "1 MD N... 100644 100644 100644 e69de29 e69de29 weird name.txt",
            "",
        ]);
        let s = parse_status_v2(&text);
        assert_eq!(s.entries.len(), 3);
        assert_eq!(s.entries[0].path, "app.js");
        assert_eq!(s.entries[0].staged, None);
        assert_eq!(s.entries[0].unstaged, Some(ChangeKind::Modified));
        assert_eq!(s.entries[1].staged, Some(ChangeKind::Added));
        assert_eq!(s.entries[1].unstaged, None);
        assert_eq!(s.entries[2].path, "weird name.txt");
        assert_eq!(s.entries[2].staged, Some(ChangeKind::Modified));
        assert_eq!(s.entries[2].unstaged, Some(ChangeKind::Deleted));
    }

    #[test]
    fn parses_rename_with_orig_path() {
        let text = z(&[
            "# branch.head main",
            "2 R. N... 100644 100644 100644 e69de29 e69de29 R100 helpers.js",
            "util.js",
            "1 .M N... 100644 100644 100644 e69de29 e69de29 app.js",
            "",
        ]);
        let s = parse_status_v2(&text);
        assert_eq!(s.entries.len(), 2);
        assert_eq!(s.entries[0].path, "helpers.js");
        assert_eq!(s.entries[0].orig_path.as_deref(), Some("util.js"));
        assert_eq!(s.entries[0].staged, Some(ChangeKind::Renamed));
        assert_eq!(s.entries[1].path, "app.js");
    }

    #[test]
    fn parses_untracked_and_unmerged() {
        let text = z(&[
            "# branch.head main",
            "? untracked.txt",
            "u UU N... 100644 100644 100644 100644 e69de29 e69de29 e69de29 conflict.txt",
            "",
        ]);
        let s = parse_status_v2(&text);
        assert_eq!(s.entries[0].unstaged, Some(ChangeKind::Untracked));
        assert_eq!(s.entries[1].path, "conflict.txt");
        assert_eq!(s.entries[1].unstaged, Some(ChangeKind::Conflicted));
    }
}
