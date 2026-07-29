//! AI-assisted merge-conflict resolution plumbing.
//!
//! These commands feed a conflicted file's three sides to the frontend (which
//! asks the configured review model to propose a merge) and apply the user's
//! accepted result. Nothing here calls a model — the AI round-trip lives in the
//! webview, reusing the same streaming engine as PR review. The only write path
//! is `git_resolve_conflict`, gated behind an explicit user accept in the UI.

use std::path::{Component, Path};

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{run_git_mutating, run_git_raw, DEFAULT_TIMEOUT};
use crate::state::AppState;

/// Cap on a conflicted file's working-tree size for AI resolution. Past this the
/// three sides blow the model's context and the round-trip stops being useful;
/// the UI disables the action for files this big (truncated diffs) and this is
/// the backstop.
const RESOLVE_MAX_BYTES: usize = 256_000;

/// The clean and marked versions of one conflicted file.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSides {
    /// The working-tree file, conflict markers and all — the primary input, since
    /// its `<<<<<<<`/`>>>>>>>` markers label each side in place.
    pub working: String,
    /// Common-ancestor version (index stage 1). `None` for add/add conflicts,
    /// which have no shared base.
    pub base: Option<String>,
    /// Our side / current HEAD (index stage 2). `None` when our side deleted it.
    pub ours: Option<String>,
    /// Their side / incoming (index stage 3). `None` when their side deleted it.
    pub theirs: Option<String>,
    /// The path matches an AI-ignore pattern, so it must never be sent to a
    /// model. The UI refuses to resolve it and says why.
    pub ai_ignored: bool,
}

/// Rejects paths that could be read as a git flag or escape the repo root. The
/// path comes from git status (trusted-ish), but the write path
/// (`git_resolve_conflict`) makes traversal worth refusing defensively.
fn validate_rel_path(path: &str) -> AppResult<()> {
    let p = Path::new(path);
    if path.is_empty()
        || path.starts_with('-')
        || p.is_absolute()
        || p.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(AppError::InvalidArgument(format!("invalid path: {path}")));
    }
    Ok(())
}

/// Reads a blob from an unmerged index stage (1 = base, 2 = ours, 3 = theirs).
/// Returns `None` when that stage is absent (a side added or deleted the file).
async fn stage_blob(repo: &str, stage: u8, path: &str) -> AppResult<Option<String>> {
    // `:N:path` is a single rev-spec arg; a leading `-` in the path can't be read
    // as a flag because the `:N:` prefix comes first. validate_rel_path already
    // refused absolute/traversal paths.
    let spec = format!(":{stage}:{path}");
    let out = run_git_raw(Some(repo), &["show", &spec], DEFAULT_TIMEOUT).await?;
    Ok((out.code == 0).then(|| out.stdout_lossy()))
}

/// Whether the path matches any of the user's AI-ignore `exclude` patterns —
/// the highest-consequence AI-ignore gate in the app, since it decides whether
/// a conflicted file's contents go to a model.
///
/// Must stay on the gitignore engine (`git::ai_ignore::filter_ignored`), which
/// a test pins to the same truth table as the pathspec side. An `ls-files` +
/// `:(exclude)` listing CANNOT decide a single path: git strips the positive
/// pathspec's leading directory off every negative pattern as well, so with
/// `docs/secrets.env` as the positive term the pattern `secrets.env` is
/// compared as `rets.env` and silently matches nothing (measured, git 2.51.1).
async fn is_ai_ignored(repo: &str, path: &str, exclude: &[String]) -> AppResult<bool> {
    let one = [path.to_string()];
    let hits = crate::git::ai_ignore::filter_ignored(repo, &one, exclude).await?;
    Ok(!hits.is_empty())
}

/// The base/ours/theirs blobs plus the marked working file for a conflicted
/// path, and whether the path is AI-ignored. `exclude` is the user's combined
/// (repo + global) AI-ignore pattern list.
#[tauri::command]
pub async fn git_conflict_sides(
    repo_path: String,
    path: String,
    exclude: Vec<String>,
) -> AppResult<ConflictSides> {
    validate_rel_path(&path)?;

    let ai_ignored = is_ai_ignored(&repo_path, &path, &exclude).await?;

    // A both-deleted conflict has no working file → "".
    let working_bytes = tokio::fs::read(Path::new(&repo_path).join(&path))
        .await
        .unwrap_or_default();
    if working_bytes.len() > RESOLVE_MAX_BYTES {
        return Err(AppError::InvalidArgument(
            "file is too large for AI conflict resolution".into(),
        ));
    }
    // A binary conflict (a NUL byte, git's own text/binary heuristic) can't be
    // merged as text — a resolution would write garbage UTF-8 over the file.
    if working_bytes.contains(&0) {
        return Err(AppError::InvalidArgument(
            "binary file — resolve this conflict by hand".into(),
        ));
    }
    let working = String::from_utf8_lossy(&working_bytes).into_owned();

    Ok(ConflictSides {
        working,
        base: stage_blob(&repo_path, 1, &path).await?,
        ours: stage_blob(&repo_path, 2, &path).await?,
        theirs: stage_blob(&repo_path, 3, &path).await?,
        ai_ignored,
    })
}

/// Writes a resolution to the working file, and (when `stage`) stages it.
/// Staging an unmerged path collapses its stages, which is what marks the
/// conflict resolved (drops it from the conflict count and lets the
/// merge/rebase/cherry-pick Continue). Per-region resolution writes without
/// staging while markers remain, then stages on the final region; the AI flow
/// and whole-file accepts stage immediately. The UI only reaches this after the
/// user reviews and accepts.
#[tauri::command]
pub async fn git_resolve_conflict(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    content: String,
    stage: bool,
) -> AppResult<()> {
    validate_rel_path(&path)?;
    let full = Path::new(&repo_path).join(&path);
    tokio::fs::write(&full, content)
        .await
        .map_err(AppError::Io)?;
    if stage {
        run_git_mutating(&state, &repo_path, &["add", "--", &path], DEFAULT_TIMEOUT).await?;
    }
    Ok(())
}

/// Resolves a whole conflicted file by taking one side outright: `side` is
/// "ours" (current branch / HEAD) or "theirs" (incoming). `git checkout
/// --ours/--theirs` writes that side's version to the working tree, then `git
/// add` stages it (marks resolved). Works for binary conflicts too, where a
/// text merge is impossible.
#[tauri::command]
pub async fn git_checkout_conflict_side(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    side: String,
) -> AppResult<()> {
    validate_rel_path(&path)?;
    let flag = match side.as_str() {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => {
            return Err(AppError::InvalidArgument(format!(
                "invalid conflict side: {side}"
            )))
        }
    };
    run_git_mutating(
        &state,
        &repo_path,
        &["checkout", flag, "--", &path],
        DEFAULT_TIMEOUT,
    )
    .await?;
    run_git_mutating(&state, &repo_path, &["add", "--", &path], DEFAULT_TIMEOUT).await?;
    Ok(())
}

/// A unified diff between two in-memory contents, for the resolution preview
/// (proposed-vs-ours). Round-trips through a throwaway temp dir + `git diff
/// --no-index` so the output is byte-for-byte the same shape every other diff in
/// the app renders (the viewer supplies its own display filename, so the temp
/// paths never surface).
#[tauri::command]
pub async fn git_diff_contents(old: String, new: String) -> AppResult<String> {
    let dir = std::env::temp_dir().join(format!(
        "gd-conflict-diff-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    ));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(AppError::Io)?;
    let old_path = dir.join("ours");
    let new_path = dir.join("proposed");
    let result = async {
        tokio::fs::write(&old_path, &old).await.map_err(AppError::Io)?;
        tokio::fs::write(&new_path, &new).await.map_err(AppError::Io)?;
        let out = run_git_raw(
            None,
            &[
                "diff",
                "--no-index",
                "--no-color",
                "--",
                &old_path.to_string_lossy(),
                &new_path.to_string_lossy(),
            ],
            DEFAULT_TIMEOUT,
        )
        .await?;
        // `--no-index` exits 1 when the files differ (the common case); only a
        // code above that is a real failure.
        if out.code > 1 {
            return Err(AppError::Git {
                code: out.code,
                stderr: out.stderr,
            });
        }
        Ok(out.stdout_lossy())
    }
    .await;
    let _ = tokio::fs::remove_dir_all(&dir).await;
    result
}

/// Test-only helper: the body of `git_resolve_conflict` without the Tauri
/// `State` (the repo lock the command takes isn't needed in a single-threaded
/// test), so the resolve path is exercised end-to-end against a real repo.
#[cfg(test)]
pub(crate) async fn resolve_for_test(repo: &str, path: &str, content: &str) {
    use crate::git::runner::run_git;
    tokio::fs::write(Path::new(repo).join(path), content)
        .await
        .unwrap();
    run_git(Some(repo), &["add", "--", path], DEFAULT_TIMEOUT)
        .await
        .unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::runner::run_git;

    fn temp_repo(tag: &str) -> (tempfile::TempDir, String) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-conflict-test-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let repo = dir.path().to_string_lossy().into_owned();
        (dir, repo)
    }

    /// Builds a real merge conflict on `file.txt` (base → "base", ours → "ours",
    /// theirs → "theirs") and leaves the repo mid-merge.
    async fn conflicted_repo(tag: &str) -> (tempfile::TempDir, String) {
        let (dir, repo) = temp_repo(tag);
        let git = |args: Vec<&'static str>| {
            let repo = repo.clone();
            async move { run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap() }
        };
        git(vec!["init"]).await;
        git(vec!["config", "user.email", "t@t"]).await;
        git(vec!["config", "user.name", "t"]).await;
        let file = Path::new(&repo).join("file.txt");
        std::fs::write(&file, "base\n").unwrap();
        git(vec!["add", "."]).await;
        git(vec!["commit", "-m", "base"]).await;
        git(vec!["checkout", "-b", "feature"]).await;
        std::fs::write(&file, "theirs\n").unwrap();
        git(vec!["commit", "-am", "theirs"]).await;
        git(vec!["checkout", "-"]).await;
        std::fs::write(&file, "ours\n").unwrap();
        git(vec!["commit", "-am", "ours"]).await;
        // The merge is expected to conflict (non-zero exit), so run it raw.
        run_git_raw(Some(&repo), &["merge", "feature"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        (dir, repo)
    }

    #[tokio::test]
    async fn sides_carry_each_stage_and_markers() {
        let (_dir, repo) = conflicted_repo("sides").await;
        let sides = git_conflict_sides(repo.clone(), "file.txt".into(), vec![])
            .await
            .unwrap();
        assert!(sides.working.contains("<<<<<<<"));
        assert!(sides.working.contains(">>>>>>>"));
        assert_eq!(sides.base.as_deref(), Some("base\n"));
        assert_eq!(sides.ours.as_deref(), Some("ours\n"));
        assert_eq!(sides.theirs.as_deref(), Some("theirs\n"));
        assert!(!sides.ai_ignored);
    }

    #[tokio::test]
    async fn checkout_side_takes_one_side_and_clears() {
        // ours → the current branch's version, conflict cleared.
        let (_dir, repo) = conflicted_repo("ours-side").await;
        run_git(Some(&repo), &["checkout", "--ours", "--", "file.txt"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(Some(&repo), &["add", "--", "file.txt"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        // Normalize line endings: git autocrlf may rewrite \n → \r\n on checkout.
        assert_eq!(
            std::fs::read_to_string(Path::new(&repo).join("file.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "ours\n"
        );
        assert!(run_git(Some(&repo), &["ls-files", "-u"], DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
            .trim()
            .is_empty());

        // theirs → the incoming version.
        let (_dir2, repo2) = conflicted_repo("theirs-side").await;
        run_git(Some(&repo2), &["checkout", "--theirs", "--", "file.txt"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        run_git(Some(&repo2), &["add", "--", "file.txt"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(Path::new(&repo2).join("file.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "theirs\n"
        );
    }

    #[tokio::test]
    async fn ai_ignore_pattern_flags_the_path() {
        let (_dir, repo) = conflicted_repo("ignore").await;
        let hit = git_conflict_sides(repo.clone(), "file.txt".into(), vec!["*.txt".into()])
            .await
            .unwrap();
        assert!(hit.ai_ignored);
        let miss = git_conflict_sides(repo.clone(), "file.txt".into(), vec!["*.lock".into()])
            .await
            .unwrap();
        assert!(!miss.ai_ignored);

        // A NESTED copy of the same name: patterns are gitignore-style, so a bare
        // `file.txt` must flag `docs/file.txt` too — this gate decides whether a
        // file's contents reach a model, so a missed depth is a leak.
        std::fs::create_dir_all(Path::new(&repo).join("docs")).unwrap();
        std::fs::write(Path::new(&repo).join("docs").join("file.txt"), "nested\n").unwrap();
        run_git(Some(&repo), &["add", "--", "docs/file.txt"], DEFAULT_TIMEOUT)
            .await
            .unwrap();

        let nested = git_conflict_sides(repo.clone(), "docs/file.txt".into(), vec!["file.txt".into()])
            .await
            .unwrap();
        assert!(nested.ai_ignored, "a bare name matches at any depth");

        // ...while a leading `/` anchors to the repo root: the nested copy is
        // free, the root one is still flagged.
        let anchored_nested =
            git_conflict_sides(repo.clone(), "docs/file.txt".into(), vec!["/file.txt".into()])
                .await
                .unwrap();
        assert!(!anchored_nested.ai_ignored);
        let anchored_root =
            git_conflict_sides(repo, "file.txt".into(), vec!["/file.txt".into()])
                .await
                .unwrap();
        assert!(anchored_root.ai_ignored);
    }

    #[tokio::test]
    async fn resolve_writes_and_clears_the_conflict() {
        let (_dir, repo) = conflicted_repo("resolve").await;
        // Before: the path is unmerged (`ls-files -u` lists it).
        let unmerged = run_git(Some(&repo), &["ls-files", "-u"], DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy();
        assert!(unmerged.contains("file.txt"));

        // Resolving writes the chosen content and stages it.
        crate::git::conflict::resolve_for_test(&repo, "file.txt", "merged\n").await;

        let after = run_git(Some(&repo), &["ls-files", "-u"], DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy();
        assert!(after.trim().is_empty(), "conflict should be cleared");
        let disk = std::fs::read_to_string(Path::new(&repo).join("file.txt")).unwrap();
        assert_eq!(disk, "merged\n");
        let staged = run_git(Some(&repo), &["diff", "--cached", "--name-only"], DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy();
        assert!(staged.contains("file.txt"));
    }

    #[tokio::test]
    async fn diff_contents_emits_a_unified_diff() {
        let text = git_diff_contents("one\ntwo\n".into(), "one\nTWO\n".into())
            .await
            .unwrap();
        assert!(text.contains("@@"));
        assert!(text.contains("-two"));
        assert!(text.contains("+TWO"));
    }
}
