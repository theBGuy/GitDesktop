use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git, run_git_mutating_input, run_git_raw, DEFAULT_TIMEOUT};
use crate::git::types::{DiffStatEntry, FileDiff, StagedDiff};
use crate::state::AppState;

/// Cap on file bytes shipped for image previews.
const IMAGE_MAX_BYTES: usize = 20_000_000;

/// Raw file bytes (base64) at a revision, or from the working tree when
/// `rev` is None. `None` result = the file doesn't exist there (e.g. the
/// old side of an added file). Drives the image diff view.
#[tauri::command]
pub async fn git_file_base64(
    repo_path: String,
    rev: Option<String>,
    file_path: String,
) -> AppResult<Option<String>> {
    use base64::Engine;
    let bytes: Option<Vec<u8>> = match rev {
        Some(rev) => {
            if rev.is_empty() || rev.starts_with('-') {
                return Err(AppError::InvalidArgument(format!("invalid rev: {rev}")));
            }
            let spec = format!("{rev}:{file_path}");
            let out = run_git_raw(Some(&repo_path), &["show", &spec], DEFAULT_TIMEOUT).await?;
            // Nonzero exit = the path doesn't exist at that revision.
            (out.code == 0).then_some(out.stdout)
        }
        None => tokio::fs::read(std::path::Path::new(&repo_path).join(&file_path))
            .await
            .ok(),
    };
    if let Some(b) = &bytes {
        if b.len() > IMAGE_MAX_BYTES {
            return Err(AppError::InvalidArgument(
                "file too large to preview".into(),
            ));
        }
    }
    Ok(bytes.map(|b| base64::engine::general_purpose::STANDARD.encode(b)))
}

/// Applies a patch — typically a single hunk cut out of a working-tree diff.
/// stage hunk = `cached`, unstage hunk = `cached + reverse`,
/// discard hunk = `reverse` (working tree).
#[tauri::command]
pub async fn git_apply_patch(
    state: State<'_, AppState>,
    repo_path: String,
    patch: String,
    cached: bool,
    reverse: bool,
) -> AppResult<()> {
    if patch.trim().is_empty() {
        return Err(AppError::InvalidArgument("empty patch".into()));
    }
    let mut args = vec!["apply", "--whitespace=nowarn"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-"); // read the patch from stdin
    run_git_mutating_input(&state, &repo_path, &args, Some(&patch), DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// One changed line the user selected for partial staging. `side` is which side
/// of the diff the line belongs to: `old` for a deletion (matched by old-file
/// line number), `new` for an addition (matched by new-file line number).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Old,
    New,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct SelectedLine {
    pub side: Side,
    pub line: u32,
}

/// Parse the start line numbers from a `@@ -A[,B] +C[,D] @@ …` header. Only the
/// first `-`/`+` token counts (a section heading may contain more).
fn parse_hunk_starts(header: &str) -> (u32, u32) {
    let mut old = None;
    let mut new = None;
    for tok in header.split_whitespace() {
        if old.is_none() {
            if let Some(rest) = tok.strip_prefix('-') {
                old = rest.split(',').next().and_then(|s| s.parse().ok());
                continue;
            }
        }
        if new.is_none() {
            if let Some(rest) = tok.strip_prefix('+') {
                new = rest.split(',').next().and_then(|s| s.parse().ok());
            }
        }
    }
    (old.unwrap_or(0), new.unwrap_or(0))
}

/// The optional section heading after the closing `@@` of a hunk header.
fn hunk_section(header: &str) -> &str {
    let mut it = header.match_indices("@@");
    it.next();
    match it.next() {
        Some((idx, _)) => &header[idx + 2..],
        None => "",
    }
}

/// Build a patch containing only the user-selected changed lines from a
/// single-file unified diff, neutralizing the rest so the result still applies
/// cleanly. `reverse` means the patch will be applied with `--reverse`
/// (unstage/discard); it flips which unselected changes are dropped vs. turned
/// into context. Returns an empty string if nothing selected lands in any hunk.
///
/// Forward (stage): unselected `+` dropped, unselected `-` → context.
/// Reverse (unstage/discard): unselected `+` → context, unselected `-` dropped.
pub fn build_partial_patch(diff_text: &str, selected: &[SelectedLine], reverse: bool) -> String {
    use std::collections::HashSet;
    let sel_old: HashSet<u32> = selected
        .iter()
        .filter(|s| s.side == Side::Old)
        .map(|s| s.line)
        .collect();
    let sel_new: HashSet<u32> = selected
        .iter()
        .filter(|s| s.side == Side::New)
        .map(|s| s.line)
        .collect();

    let lines: Vec<&str> = diff_text.split('\n').collect();
    let Some(first_hunk) = lines.iter().position(|l| l.starts_with("@@")) else {
        return String::new();
    };
    let header = lines[..first_hunk].join("\n");

    let mut out_hunks = String::new();
    let mut i = first_hunk;
    while i < lines.len() {
        if !lines[i].starts_with("@@") {
            i += 1;
            continue;
        }
        let (old_start, new_start) = parse_hunk_starts(lines[i]);
        let mut j = i + 1;
        while j < lines.len() && !lines[j].starts_with("@@") {
            j += 1;
        }

        let mut out_body: Vec<String> = Vec::new();
        let mut old_no = old_start;
        let mut new_no = new_start;
        let mut old_count = 0u32;
        let mut new_count = 0u32;
        let mut kept_change = false;
        let mut last_kept = false;

        for &bl in &lines[i + 1..j] {
            // The final "\n" split leaves a trailing "" — a real context blank
            // line is " " (a space), so empty strings are just that artifact.
            if bl.is_empty() {
                continue;
            }
            match bl.as_bytes()[0] {
                b' ' => {
                    out_body.push(bl.to_string());
                    old_no += 1;
                    new_no += 1;
                    old_count += 1;
                    new_count += 1;
                    last_kept = true;
                }
                b'+' => {
                    let selected = sel_new.contains(&new_no);
                    new_no += 1;
                    if selected {
                        out_body.push(bl.to_string());
                        new_count += 1;
                        kept_change = true;
                        last_kept = true;
                    } else if reverse {
                        // Stays in the index/worktree — show it as context.
                        out_body.push(format!(" {}", &bl[1..]));
                        old_count += 1;
                        new_count += 1;
                        last_kept = true;
                    } else {
                        last_kept = false; // forward: drop it
                    }
                }
                b'-' => {
                    let selected = sel_old.contains(&old_no);
                    old_no += 1;
                    if selected {
                        out_body.push(bl.to_string());
                        old_count += 1;
                        kept_change = true;
                        last_kept = true;
                    } else if reverse {
                        last_kept = false; // reverse: drop it
                    } else {
                        // Not being removed yet — show it as context.
                        out_body.push(format!(" {}", &bl[1..]));
                        old_count += 1;
                        new_count += 1;
                        last_kept = true;
                    }
                }
                b'\\' => {
                    // "\ No newline at end of file" annotates the previous line.
                    if last_kept {
                        out_body.push(bl.to_string());
                    }
                }
                _ => out_body.push(bl.to_string()),
            }
        }

        if kept_change {
            out_hunks.push_str(&format!(
                "@@ -{old_start},{old_count} +{new_start},{new_count} @@{}\n",
                hunk_section(lines[i])
            ));
            for l in &out_body {
                out_hunks.push_str(l);
                out_hunks.push('\n');
            }
        }
        i = j;
    }

    if out_hunks.is_empty() {
        return String::new();
    }
    format!("{header}\n{out_hunks}")
}

/// Stage/unstage/discard a selected subset of lines (see `build_partial_patch`).
/// stage = cached; unstage = cached + reverse; discard = reverse.
#[tauri::command]
pub async fn git_apply_partial(
    state: State<'_, AppState>,
    repo_path: String,
    diff_text: String,
    selected: Vec<SelectedLine>,
    cached: bool,
    reverse: bool,
) -> AppResult<()> {
    let patch = build_partial_patch(&diff_text, &selected, reverse);
    if patch.trim().is_empty() {
        return Err(AppError::InvalidArgument("no changes selected".into()));
    }
    // --recount lets git fix up hunk line counts from content, a safety net on
    // top of the exact counts we compute.
    let mut args = vec!["apply", "--whitespace=nowarn", "--recount"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-");
    run_git_mutating_input(&state, &repo_path, &args, Some(&patch), DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// Cap on diff text shipped to the webview for rendering.
const VIEWER_MAX_BYTES: usize = 1_000_000;
/// Default cap on staged diff text shipped for AI prompt building.
const AI_DEFAULT_MAX_BYTES: usize = 1_000_000;

#[tauri::command]
pub async fn git_diff_file(
    repo_path: String,
    file_path: String,
    staged: bool,
    untracked: bool,
) -> AppResult<FileDiff> {
    let out = if untracked {
        // Full-file "added" diff for files git doesn't track yet.
        // git maps /dev/null to the platform null device; exit code 1 just
        // means "differences found" for --no-index.
        // `--no-index` takes FILESYSTEM paths, not pathspecs — `:(literal)` here
        // fails with "could not access" (measured), so this half stays raw.
        let out = run_git_raw(
            Some(&repo_path),
            &["diff", "--no-index", "--", "/dev/null", &file_path],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if out.code > 1 {
            return Err(AppError::Git {
                code: out.code,
                stderr: out.stderr,
            });
        }
        out
    } else {
        // Literal pathspec: a `[slug]`-style path would otherwise splice its
        // glob-siblings' hunks into this file's diff.
        let spec = crate::git::pathspec::literal(&file_path);
        let mut args = vec!["diff", "--no-color"];
        if staged {
            args.push("--cached");
        }
        args.extend(["--", spec.as_str()]);
        run_git(Some(&repo_path), &args, DEFAULT_TIMEOUT).await?
    };

    let text = out.stdout_lossy();
    let is_binary = text.lines().any(|l| {
        l.starts_with("Binary files ") && l.ends_with(" differ")
    });
    let (text, is_truncated) = truncate_at_char_boundary(text, VIEWER_MAX_BYTES);

    Ok(FileDiff {
        file_path,
        is_binary,
        is_truncated,
        text,
    })
}

/// Diff a single file in an agent **session** worktree against the session's base
/// commit — the file's *cumulative* change across the whole session (committed
/// turns AND the current uncommitted edits, unlike `git diff HEAD`, which resets
/// per checkpoint commit). Powers the inline edit-step diff in the agent
/// transcript. A brand-new file the agent just wrote is still untracked, so the
/// base diff shows nothing — fall back to a full-file "added" diff (as
/// `git_diff_file` does for untracked files). `repo_path` is the worktree.
#[tauri::command]
pub async fn git_session_file_diff(
    repo_path: String,
    file_path: String,
    base: String,
) -> AppResult<FileDiff> {
    // base → working tree: captures both committed-turn changes and uncommitted edits.
    // Literal pathspec so a `[slug]`-style path can't pull in a glob-sibling's hunks.
    let spec = crate::git::pathspec::literal(&file_path);
    let out = run_git(
        Some(&repo_path),
        &["diff", "--no-color", &base, "--", &spec],
        DEFAULT_TIMEOUT,
    )
    .await?;
    let mut text = out.stdout_lossy();

    // Empty tracked diff + the file is untracked (a just-written new file) →
    // show it as a full add, the same way git_diff_file handles untracked.
    if text.trim().is_empty() {
        let others = run_git(
            Some(&repo_path),
            &["ls-files", "--others", "--exclude-standard", "--", &spec],
            DEFAULT_TIMEOUT,
        )
        .await?;
        if !others.stdout_lossy().trim().is_empty() {
            // `--no-index` takes a FILESYSTEM path, so this one stays raw (see
            // git_diff_file); only the pathspec-taking probe above is literalized.
            let no_index = run_git_raw(
                Some(&repo_path),
                &["diff", "--no-index", "--", "/dev/null", &file_path],
                DEFAULT_TIMEOUT,
            )
            .await?;
            // exit 1 just means "differences found" for --no-index; >1 is a real error.
            if no_index.code > 1 {
                return Err(AppError::Git {
                    code: no_index.code,
                    stderr: no_index.stderr,
                });
            }
            text = no_index.stdout_lossy();
        }
    }

    let is_binary = text
        .lines()
        .any(|l| l.starts_with("Binary files ") && l.ends_with(" differ"));
    let (text, is_truncated) = truncate_at_char_boundary(text, VIEWER_MAX_BYTES);

    Ok(FileDiff {
        file_path,
        is_binary,
        is_truncated,
        text,
    })
}

#[tauri::command]
pub async fn git_staged_diff(
    repo_path: String,
    max_bytes: Option<usize>,
    exclude: Option<Vec<String>>,
    worktree: Option<bool>,
) -> AppResult<StagedDiff> {
    let max_bytes = max_bytes.unwrap_or(AI_DEFAULT_MAX_BYTES);
    // `--cached` diffs staged changes vs HEAD (commit messages); `HEAD` diffs
    // the whole working tree vs HEAD (staged + unstaged), for naming a branch
    // off in-progress work that hasn't been staged yet.
    let base = if worktree.unwrap_or(false) {
        "HEAD"
    } else {
        "--cached"
    };

    // AI-ignore patterns → pathspec excludes (`git::ai_ignore` owns the
    // translation). ":(exclude)" needs an inclusive pathspec alongside it,
    // hence the leading ".".
    let pathspec =
        crate::git::ai_ignore::pathspecs_for_repo(&repo_path, &exclude.unwrap_or_default())
            .await
            .specs;

    let mut diff_args: Vec<&str> = vec!["diff", base, "--no-color"];
    let mut stat_args: Vec<&str> = vec!["diff", base, "--numstat", "-z"];
    if !pathspec.is_empty() {
        for args in [&mut diff_args, &mut stat_args] {
            args.push("--");
            args.push(".");
            args.extend(pathspec.iter().map(String::as_str));
        }
    }

    let (diff_out, stat_out) = tokio::try_join!(
        run_git(Some(&repo_path), &diff_args, DEFAULT_TIMEOUT),
        run_git(Some(&repo_path), &stat_args, DEFAULT_TIMEOUT)
    )?;

    let files = parse_numstat_z(&stat_out.stdout_lossy());

    // Tell the caller how many changed files the excludes hid, so the AI
    // prompt can mention that the diff is not the whole story.
    let excluded_files = if pathspec.is_empty() {
        0
    } else {
        let all = run_git(
            Some(&repo_path),
            &["diff", base, "--numstat", "-z"],
            DEFAULT_TIMEOUT,
        )
        .await?;
        let total = parse_numstat_z(&all.stdout_lossy()).len();
        total.saturating_sub(files.len()) as u32
    };

    let (text, truncated) = truncate_at_file_boundary(diff_out.stdout_lossy(), max_bytes);

    Ok(StagedDiff {
        text,
        truncated,
        files,
        excluded_files,
    })
}

pub fn truncate_at_char_boundary(text: String, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_string(), true)
}

/// Truncates a multi-file diff at a `diff --git` boundary so no file is cut
/// mid-hunk; falls back to a char-boundary cut for a single oversized file.
fn truncate_at_file_boundary(text: String, max: usize) -> (String, bool) {
    if text.len() <= max {
        return (text, false);
    }
    let mut kept_end = 0;
    let mut search_from = 0;
    loop {
        let next = if search_from == 0 && text.starts_with("diff --git ") {
            Some(0)
        } else {
            text[search_from..]
                .find("\ndiff --git ")
                .map(|i| search_from + i + 1)
        };
        match next {
            Some(start) if start <= max => {
                kept_end = start;
                search_from = start + 1;
            }
            _ => break,
        }
    }
    // kept_end is the start of the first file section that crosses the budget;
    // keep everything before it. If even the first file is too big, hard-cut.
    if kept_end == 0 {
        return truncate_at_char_boundary(text, max);
    }
    (text[..kept_end].trim_end().to_string(), true)
}

/// Parses `git diff --numstat -z` output.
/// Regular entry: `added\tdeleted\tpath\0`.
/// Rename entry:  `added\tdeleted\t\0oldpath\0newpath\0`.
/// Binary files report `-` for both counts.
pub fn parse_numstat_z(text: &str) -> Vec<DiffStatEntry> {
    let mut entries = Vec::new();
    let mut tokens = text.split('\0').peekable();
    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        let mut fields = token.splitn(3, '\t');
        let (Some(added), Some(deleted), Some(path)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let is_binary = added == "-";
        let added = added.parse().unwrap_or(0);
        let deleted = deleted.parse().unwrap_or(0);
        let path = if path.is_empty() {
            // rename: skip old path, take new path
            tokens.next();
            match tokens.next() {
                Some(new_path) if !new_path.is_empty() => new_path.to_string(),
                _ => continue,
            }
        } else {
            path.to_string()
        };
        entries.push(DiffStatEntry {
            path,
            added,
            deleted,
            is_binary,
        });
    }
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_numstat_with_rename_and_binary() {
        let text = "3\t1\tapp.js\0-\t-\tbinary.bin\x000\t0\t\0util.js\0helpers.js\0";
        let entries = parse_numstat_z(text);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].path, "app.js");
        assert_eq!(entries[0].added, 3);
        assert_eq!(entries[0].deleted, 1);
        assert!(entries[1].is_binary);
        assert_eq!(entries[1].path, "binary.bin");
        assert_eq!(entries[2].path, "helpers.js");
    }

    #[test]
    fn truncates_multi_file_diff_at_file_boundary() {
        let file_a = format!("diff --git a/a b/a\n{}\n", "+a\n".repeat(10));
        let file_b = format!("diff --git a/b b/b\n{}\n", "+b\n".repeat(10));
        let text = format!("{file_a}{file_b}");
        let (out, truncated) = truncate_at_file_boundary(text, file_a.len() + 5);
        assert!(truncated);
        assert!(out.starts_with("diff --git a/a"));
        assert!(!out.contains("diff --git a/b"));
    }

    #[test]
    fn small_diff_not_truncated() {
        let (out, truncated) = truncate_at_file_boundary("diff --git a/a b/a\n+x\n".into(), 1000);
        assert!(!truncated);
        assert!(out.contains("+x"));
    }

    /// `exclude` filters the staged diff with real gitignore semantics (via
    /// `git::ai_ignore`): a bare name hides every copy at any depth, a leading
    /// `/` anchors to the repo root, and `excluded_files` counts what was hidden.
    #[tokio::test]
    async fn staged_diff_applies_gitignore_style_excludes() {
        let _tmp = tempfile::Builder::new()
            .prefix("gd-staged-exclude-test-")
            .tempdir()
            .expect("create temp dir");
        let dir = _tmp.path().to_path_buf();
        let repo = dir.to_string_lossy().into_owned();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@t.local"],
            vec!["config", "user.name", "T"],
        ] {
            run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap();
        }
        std::fs::write(dir.join("seed.txt"), "seed\n").unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(Some(&repo), &["commit", "-qm", "seed"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        // Two copies of the same file name, one nested, plus an unrelated file.
        std::fs::create_dir_all(dir.join("docs")).unwrap();
        std::fs::write(dir.join("notes.md"), "root\n").unwrap();
        std::fs::write(dir.join("docs").join("notes.md"), "nested\n").unwrap();
        std::fs::write(dir.join("app.rs"), "fn main() {}\n").unwrap();
        run_git(Some(&repo), &["add", "-A"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        // No excludes → everything staged is present, nothing reported hidden.
        let all = git_staged_diff(repo.clone(), None, None, None).await.unwrap();
        assert_eq!(all.files.len(), 3);
        assert_eq!(all.excluded_files, 0);

        // A bare name hides BOTH copies — gitignore matches at any depth.
        let bare = git_staged_diff(repo.clone(), None, Some(vec!["notes.md".into()]), None)
            .await
            .unwrap();
        assert_eq!(bare.files.len(), 1);
        assert!(bare.files.iter().any(|f| f.path == "app.rs"));
        assert!(
            !bare.text.contains("docs/notes.md"),
            "the nested copy is hidden too"
        );
        assert_eq!(bare.excluded_files, 2);

        // A leading `/` anchors to the root, sparing the nested copy — and does
        // NOT wipe the whole diff (it used to read as an absolute path).
        let anchored = git_staged_diff(repo.clone(), None, Some(vec!["/notes.md".into()]), None)
            .await
            .unwrap();
        assert_eq!(anchored.files.len(), 2);
        assert!(
            anchored.files.iter().any(|f| f.path == "docs/notes.md"),
            "an anchored pattern spares the nested copy"
        );
        assert!(!anchored.files.iter().any(|f| f.path == "notes.md"));
        assert_eq!(anchored.excluded_files, 1);

        // Blank / `#` lines translate to no pathspec at all — same as no excludes.
        let noop = git_staged_diff(
            repo,
            None,
            Some(vec!["  ".into(), "# comment".into()]),
            None,
        )
        .await
        .unwrap();
        assert_eq!(noop.files.len(), 3);
        assert_eq!(noop.excluded_files, 0);
    }

    const FILE_HEADER: &str = "diff --git a/f.txt b/f.txt\nindex 000..111 100644\n--- a/f.txt\n+++ b/f.txt\n";

    fn sel(side: Side, line: u32) -> SelectedLine {
        SelectedLine { side, line }
    }

    #[test]
    fn stages_one_of_two_added_lines() {
        let diff = format!("{FILE_HEADER}@@ -1,2 +1,4 @@\n line1\n+added A\n+added B\n line2\n");
        // Select only "added A" (new-side line 2).
        let patch = build_partial_patch(&diff, &[sel(Side::New, 2)], false);
        assert_eq!(
            patch,
            format!("{FILE_HEADER}@@ -1,2 +1,3 @@\n line1\n+added A\n line2\n"),
        );
    }

    #[test]
    fn stages_one_of_two_deleted_lines() {
        // Unselected deletion becomes context so the old side still matches.
        let diff = format!("{FILE_HEADER}@@ -1,4 +1,2 @@\n line1\n-del A\n-del B\n line4\n");
        let patch = build_partial_patch(&diff, &[sel(Side::Old, 2)], false);
        assert_eq!(
            patch,
            format!("{FILE_HEADER}@@ -1,4 +1,3 @@\n line1\n-del A\n del B\n line4\n"),
        );
    }

    #[test]
    fn reverse_unselected_addition_becomes_context() {
        // Unstage only "added A": "added B" must survive as context.
        let diff = format!("{FILE_HEADER}@@ -1,2 +1,4 @@\n line1\n+added A\n+added B\n line2\n");
        let patch = build_partial_patch(&diff, &[sel(Side::New, 2)], true);
        assert_eq!(
            patch,
            format!("{FILE_HEADER}@@ -1,3 +1,4 @@\n line1\n+added A\n added B\n line2\n"),
        );
    }

    #[test]
    fn only_hunks_with_a_selected_change_are_emitted() {
        let diff = format!(
            "{FILE_HEADER}@@ -1,2 +1,3 @@\n a\n+first\n b\n@@ -10,2 +11,3 @@\n c\n+second\n d\n"
        );
        // Select only the addition in the second hunk (new-side line 12).
        let patch = build_partial_patch(&diff, &[sel(Side::New, 12)], false);
        assert!(!patch.contains("+first"));
        assert!(patch.contains("@@ -10,2 +11,3 @@"));
        assert!(patch.contains("+second"));
    }

    #[test]
    fn no_newline_marker_follows_its_line() {
        let diff = format!(
            "{FILE_HEADER}@@ -1,2 +1,2 @@\n line1\n-old last\n\\ No newline at end of file\n+new last\n\\ No newline at end of file\n"
        );
        let patch = build_partial_patch(&diff, &[sel(Side::Old, 2), sel(Side::New, 2)], false);
        assert!(patch.contains("-old last\n\\ No newline at end of file\n"));
        assert!(patch.contains("+new last\n\\ No newline at end of file\n"));
    }

    #[test]
    fn nothing_selected_yields_empty() {
        let diff = format!("{FILE_HEADER}@@ -1,2 +1,3 @@\n line1\n+added\n line2\n");
        assert!(build_partial_patch(&diff, &[], false).is_empty());
    }

    /// The built partial patch is accepted by real `git apply --cached`: of two
    /// added lines, staging one leaves exactly the other unstaged.
    #[tokio::test]
    async fn partial_patch_stages_a_single_added_line() {
        use crate::git::runner::run_git_input;

        let _tmp = tempfile::Builder::new()
            .prefix("gd-partial-test-")
            .tempdir()
            .expect("create temp dir");
        let dir = _tmp.path().to_path_buf();
        let repo = dir.to_string_lossy().into_owned();
        let git = |args: Vec<&'static str>| {
            let repo = repo.clone();
            async move { run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap() }
        };

        git(vec!["init"]).await;
        git(vec!["config", "user.email", "t@t"]).await;
        git(vec!["config", "user.name", "t"]).await;
        let base: Vec<String> = (1..=5).map(|i| format!("line {i}")).collect();
        let file = dir.join("file.txt");
        std::fs::write(&file, base.join("\n") + "\n").unwrap();
        git(vec!["add", "."]).await;
        git(vec!["commit", "-m", "base"]).await;
        // Insert two new lines after "line 2".
        let edited = "line 1\nline 2\nNEW A\nNEW B\nline 3\nline 4\nline 5\n";
        std::fs::write(&file, edited).unwrap();

        let diff = git(vec!["diff", "--no-color"]).await.stdout_lossy();
        // "NEW A" is new-side line 3 in the edited file.
        let patch = build_partial_patch(&diff, &[sel(Side::New, 3)], false);
        run_git_input(
            Some(&repo),
            &["apply", "--whitespace=nowarn", "--recount", "--cached", "-"],
            Some(&patch),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();

        let staged = git(vec!["diff", "--cached", "--no-color"]).await.stdout_lossy();
        let unstaged = git(vec!["diff", "--no-color"]).await.stdout_lossy();
        assert!(staged.contains("NEW A"));
        assert!(!staged.contains("NEW B"));
        assert!(unstaged.contains("NEW B"));
    }

    /// End-to-end check of the hunk-staging plumbing: a single hunk cut out
    /// of a two-hunk diff stages via stdin `git apply --cached` and unstages
    /// via `--reverse`. Requires git on PATH (true for this project's dev
    /// environment).
    #[tokio::test]
    async fn apply_patch_stages_and_unstages_a_single_hunk() {
        use crate::git::runner::run_git_input;

        let _tmp = tempfile::Builder::new()
            .prefix("gd-apply-test-")
            .tempdir()
            .expect("create temp dir");
        let dir = _tmp.path().to_path_buf();
        let repo = dir.to_string_lossy().into_owned();
        let git = |args: Vec<&'static str>| {
            let repo = repo.clone();
            async move { run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap() }
        };

        git(vec!["init"]).await;
        git(vec!["config", "user.email", "t@t"]).await;
        git(vec!["config", "user.name", "t"]).await;
        // Two edit sites far enough apart (> 6 context lines) to force
        // two separate hunks.
        let base: Vec<String> = (1..=30).map(|i| format!("line {i}")).collect();
        let file = dir.join("file.txt");
        std::fs::write(&file, base.join("\n") + "\n").unwrap();
        git(vec!["add", "."]).await;
        git(vec!["commit", "-m", "base"]).await;
        let mut edited = base.clone();
        edited[2] = "line 3 EDITED".into();
        edited[24] = "line 25 EDITED".into();
        std::fs::write(&file, edited.join("\n") + "\n").unwrap();

        let diff = git(vec!["diff", "--no-color"]).await.stdout_lossy();
        let first_hunk_at = diff.find("\n@@").unwrap() + 1;
        let second_hunk_at = diff[first_hunk_at..].find("\n@@").unwrap() + first_hunk_at + 1;
        let patch = format!("{}{}", &diff[..first_hunk_at], &diff[first_hunk_at..second_hunk_at]);

        // Stage only the first hunk.
        run_git_input(
            Some(&repo),
            &["apply", "--whitespace=nowarn", "--cached", "-"],
            Some(&patch),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        let staged = git(vec!["diff", "--cached", "--no-color"]).await.stdout_lossy();
        let unstaged = git(vec!["diff", "--no-color"]).await.stdout_lossy();
        assert!(staged.contains("line 3 EDITED"));
        assert!(!staged.contains("line 25 EDITED"));
        assert!(unstaged.contains("line 25 EDITED"));

        // Unstage it again.
        run_git_input(
            Some(&repo),
            &["apply", "--whitespace=nowarn", "--cached", "--reverse", "-"],
            Some(&patch),
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        let staged = git(vec!["diff", "--cached", "--no-color"]).await.stdout_lossy();
        assert!(staged.trim().is_empty());
    }

    /// `git_session_file_diff` shows a file's CUMULATIVE change vs the session
    /// base — a committed-turn edit PLUS a later uncommitted edit (the base-aware
    /// behavior `git diff HEAD` would miss after a checkpoint commit) — and
    /// surfaces a brand-new untracked file as a full add via the fallback.
    #[tokio::test]
    async fn session_file_diff_is_cumulative_against_base() {
        let _tmp = tempfile::Builder::new()
            .prefix("gd-session-diff-")
            .tempdir()
            .expect("create temp dir");
        let dir = _tmp.path().to_path_buf();
        let repo = dir.to_string_lossy().into_owned();
        let git = |args: Vec<&'static str>| {
            let repo = repo.clone();
            async move { run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap() }
        };

        git(vec!["init"]).await;
        git(vec!["config", "user.email", "t@t"]).await;
        git(vec!["config", "user.name", "t"]).await;
        let file = dir.join("file.txt");
        std::fs::write(&file, "base line\n").unwrap();
        git(vec!["add", "."]).await;
        git(vec!["commit", "-m", "base"]).await;
        let base = git(vec!["rev-parse", "HEAD"]).await.stdout_lossy().trim().to_string();

        // Turn 1: edit + commit (a checkpoint) — HEAD moves past base.
        std::fs::write(&file, "base line\nFROM COMMITTED TURN\n").unwrap();
        git(vec!["commit", "-am", "turn 1"]).await;
        // Turn 2 (in progress): a further uncommitted edit.
        std::fs::write(
            &file,
            "base line\nFROM COMMITTED TURN\nFROM UNCOMMITTED EDIT\n",
        )
        .unwrap();

        let diff = git_session_file_diff(repo.clone(), "file.txt".into(), base.clone())
            .await
            .unwrap();
        assert!(diff.text.contains("FROM COMMITTED TURN"), "{}", diff.text);
        assert!(diff.text.contains("FROM UNCOMMITTED EDIT"), "{}", diff.text);
        assert!(!diff.is_binary);

        // A brand-new untracked file surfaces as a full add (the fallback path).
        std::fs::write(dir.join("new.txt"), "hello new file\n").unwrap();
        let added = git_session_file_diff(repo.clone(), "new.txt".into(), base)
            .await
            .unwrap();
        assert!(added.text.contains("+hello new file"), "{}", added.text);
        assert!(added.text.contains("new.txt"), "{}", added.text);
    }
}
