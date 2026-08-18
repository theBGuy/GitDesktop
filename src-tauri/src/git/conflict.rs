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
use crate::git::runner::{run_git, run_git_mutating, run_git_raw, DEFAULT_TIMEOUT};
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
    /// its `<<<<<<<`/`>>>>>>>` markers label each side in place. Not every
    /// conflict carries markers — a modify/delete file, for one, is just the
    /// surviving side's content.
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

/// The unmerged index stages present for `spec` (1 = base, 2 = ours, 3 = theirs).
/// Empty when the path isn't conflicted at all.
///
/// One `ls-files -u` spawn answers for every stage and returns only mode/sha/stage
/// metadata; `stage_blob` costs the same spawn but materializes the whole blob
/// (up to the 256 KB cap, binary bytes included) just to test for presence.
async fn unmerged_stages(repo: &str, spec: &str) -> AppResult<Vec<u8>> {
    let out = run_git(Some(repo), &["ls-files", "-u", "--", spec], DEFAULT_TIMEOUT).await?;
    Ok(out
        .stdout_lossy()
        .lines()
        // `<mode> <sha> <stage>\t<path>` — read the stage from the metadata half
        // only, so a path containing whitespace can't shift the field index.
        .filter_map(|line| {
            line.split('\t')
                .next()?
                .split_whitespace()
                .nth(2)?
                .parse()
                .ok()
        })
        .collect())
}

/// Whether the path matches any of the user's AI-ignore `exclude` patterns —
/// the gate that decides whether a conflicted file's contents go to a model.
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
        let spec = crate::git::pathspec::literal(&path);
        run_git_mutating(&state, &repo_path, &["add", "--", &spec], DEFAULT_TIMEOUT).await?;
    }
    Ok(())
}

/// Resolves a whole conflicted file by taking one side outright: `side` is
/// "ours" (current branch / HEAD) or "theirs" (incoming). `git checkout
/// --ours/--theirs` writes that side's version to the working tree, then `git
/// add` stages it (marks resolved). When the chosen side has no version at this
/// path — it deleted or renamed the file away — `git rm` takes that removal
/// instead. Works for binary conflicts too, where a text merge is impossible.
#[tauri::command]
pub async fn git_checkout_conflict_side(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    side: String,
) -> AppResult<()> {
    git_checkout_conflict_side_core(&state, repo_path, path, side).await
}

pub(crate) async fn git_checkout_conflict_side_core(
    state: &AppState,
    repo_path: String,
    path: String,
    side: String,
) -> AppResult<()> {
    validate_rel_path(&path)?;
    let (flag, stage) = match side.as_str() {
        "ours" => ("--ours", 2u8),
        "theirs" => ("--theirs", 3u8),
        _ => {
            return Err(AppError::InvalidArgument(format!(
                "invalid conflict side: {side}"
            )))
        }
    };
    // Literal pathspec on every step: a `[slug]`-style path would otherwise take
    // this side for its glob-siblings too, silently resolving conflicts the user
    // never opened.
    let spec = crate::git::pathspec::literal(&path);

    // One hold across the stage read and checkout→add: between them a concurrent
    // stage or discard can rewrite the working-tree file, and the `add` would then
    // stage THAT content as the user's chosen side. Lock-free runners only while
    // held (see `run_git_mutating`).
    let lock = state.repo_lock(&repo_path).await;
    let _guard = lock.lock().await;

    // A side that removed the file (deleted it, or renamed it away) has no stage
    // entry, and `checkout --ours|--theirs` then exits 1 ("does not have our
    // version"), so taking that side means `git rm` — which needs no `-f` on an
    // unmerged path, whatever the working copy holds (measured, git 2.51.1).
    // Gated on the path being unmerged RIGHT NOW: on an already-resolved path
    // `git rm` exits 0 and deletes the file, turning a stale second click into
    // data loss.
    let stages = unmerged_stages(&repo_path, &spec).await?;
    if !stages.is_empty() && !stages.contains(&stage) {
        run_git(Some(&repo_path), &["rm", "--", &spec], DEFAULT_TIMEOUT).await?;
        return Ok(());
    }
    // Nothing unmerged and nothing on disk: an accept landing after this path was
    // already resolved AS A REMOVAL. `checkout` would exit 1 on the missing
    // pathspec and put raw git text in a toast, so settle for the state the user
    // asked for. Positive knowledge of absence only — a resolved path whose file
    // still exists keeps today's harmless checkout no-op.
    if stages.is_empty()
        && matches!(
            tokio::fs::try_exists(Path::new(&repo_path).join(&path)).await,
            Ok(false)
        )
    {
        return Ok(());
    }

    run_git(
        Some(&repo_path),
        &["checkout", flag, "--", &spec],
        DEFAULT_TIMEOUT,
    )
    .await?;
    run_git(Some(&repo_path), &["add", "--", &spec], DEFAULT_TIMEOUT).await?;
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

    /// Builds a real merge conflict on `path` (base → "base", ours → "ours",
    /// theirs → "theirs") and leaves the repo mid-merge. `also_tracked` files are
    /// committed at the base and never touched by the merge, so a test can modify
    /// one and assert an operation left it alone.
    async fn conflicted_repo(
        tag: &str,
        path: &str,
        also_tracked: &[&str],
    ) -> (tempfile::TempDir, String) {
        let (dir, repo) = temp_repo(tag);
        let git = |args: Vec<&'static str>| {
            let repo = repo.clone();
            async move { run_git(Some(&repo), &args, DEFAULT_TIMEOUT).await.unwrap() }
        };
        git(vec!["init"]).await;
        git(vec!["config", "user.email", "t@t"]).await;
        git(vec!["config", "user.name", "t"]).await;
        let file = Path::new(&repo).join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        for extra in also_tracked {
            let p = Path::new(&repo).join(extra);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, "sibling base\n").unwrap();
        }
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
        let (_dir, repo) = conflicted_repo("sides", "file.txt", &[]).await;
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
        let (_dir, repo) = conflicted_repo("ours-side", "file.txt", &[]).await;
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
        let (_dir2, repo2) = conflicted_repo("theirs-side", "file.txt", &[]).await;
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

    /// Taking one side touches ONLY the chosen path. Pathspecs glob, so a raw
    /// `src/app/[slug]/page.tsx` also sweeps the character-class sibling
    /// `src/app/s/page.tsx`: `checkout` reverts the user's separate edit to it
    /// from the index and `add` stages the result, both exiting 0 (measured, git
    /// 2.51.1).
    #[tokio::test]
    async fn checkout_side_does_not_touch_glob_siblings() {
        let (_dir, repo) = conflicted_repo(
            "conflict-glob",
            "src/app/[slug]/page.tsx",
            &["src/app/s/page.tsx"],
        )
        .await;
        let sibling = Path::new(&repo).join("src/app/s/page.tsx");
        std::fs::write(&sibling, "SIBLING WIP\n").unwrap();

        let state = AppState::default();
        git_checkout_conflict_side_core(
            &state,
            repo.clone(),
            "src/app/[slug]/page.tsx".into(),
            "theirs".into(),
        )
        .await
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(Path::new(&repo).join("src/app/[slug]/page.tsx"))
                .unwrap()
                .replace("\r\n", "\n"),
            "theirs\n",
            "the chosen file took its side"
        );
        assert_eq!(
            std::fs::read_to_string(&sibling)
                .unwrap()
                .replace("\r\n", "\n"),
            "SIBLING WIP\n",
            "the glob-sibling keeps its uncommitted edit"
        );
        let staged = run_git(
            Some(&repo),
            &["diff", "--cached", "--name-only"],
            DEFAULT_TIMEOUT,
        )
        .await
        .unwrap()
        .stdout_lossy();
        assert!(
            !staged.contains("src/app/s/page.tsx"),
            "the glob-sibling was staged: {staged}"
        );
    }

    async fn git_ok(repo: &str, args: &[&str]) {
        run_git(Some(repo), args, DEFAULT_TIMEOUT).await.unwrap();
    }

    async fn stdout_of(repo: &str, args: &[&str]) -> String {
        run_git(Some(repo), args, DEFAULT_TIMEOUT)
            .await
            .unwrap()
            .stdout_lossy()
    }

    /// Builds a real modify/delete conflict on `path`: one side deletes the file
    /// while the other modifies it, so the deleting side has NO index stage.
    /// `deleted_by` is "ours" (the current branch) or "theirs" (the merged one).
    async fn modify_delete_repo(
        tag: &str,
        path: &str,
        deleted_by: &str,
    ) -> (tempfile::TempDir, String) {
        let (dir, repo) = temp_repo(tag);
        git_ok(&repo, &["init"]).await;
        git_ok(&repo, &["config", "user.email", "t@t"]).await;
        git_ok(&repo, &["config", "user.name", "t"]).await;
        let file = Path::new(&repo).join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "base\n").unwrap();
        // A file neither branch touches, so the deleting side still commits a
        // non-empty tree.
        std::fs::write(Path::new(&repo).join("keep.txt"), "keep\n").unwrap();
        git_ok(&repo, &["add", "."]).await;
        git_ok(&repo, &["commit", "-m", "base"]).await;

        git_ok(&repo, &["checkout", "-b", "feature"]).await;
        if deleted_by == "theirs" {
            git_ok(&repo, &["rm", "-q", "--", path]).await;
        } else {
            std::fs::write(&file, "theirs\n").unwrap();
            git_ok(&repo, &["add", "--", path]).await;
        }
        git_ok(&repo, &["commit", "-m", "feature"]).await;

        git_ok(&repo, &["checkout", "-"]).await;
        if deleted_by == "ours" {
            git_ok(&repo, &["rm", "-q", "--", path]).await;
        } else {
            std::fs::write(&file, "ours\n").unwrap();
            git_ok(&repo, &["add", "--", path]).await;
        }
        git_ok(&repo, &["commit", "-m", "ours"]).await;

        // The merge is expected to conflict (non-zero exit), so run it raw.
        run_git_raw(Some(&repo), &["merge", "feature"], DEFAULT_TIMEOUT)
            .await
            .unwrap();
        (dir, repo)
    }

    /// Asserts the fixture really is a modify/delete: `present` survives as an
    /// index stage and `missing` does not.
    async fn assert_modify_delete(repo: &str, path: &str, present: u8, missing: u8) {
        let stages = stdout_of(repo, &["ls-files", "-u"]).await;
        assert!(
            stages.contains(&format!(" {present}\t{path}")),
            "stage {present} should survive: {stages}"
        );
        assert!(
            !stages.contains(&format!(" {missing}\t{path}")),
            "stage {missing} should be absent: {stages}"
        );
    }

    /// Asserts the path is fully resolved AND gone — no unmerged stages, no index
    /// entry, no working file.
    async fn assert_deleted_and_resolved(repo: &str, path: &str) {
        let unmerged = stdout_of(repo, &["ls-files", "-u"]).await;
        assert!(
            unmerged.trim().is_empty(),
            "conflict left behind: {unmerged}"
        );
        let tracked = stdout_of(repo, &["ls-files", "--", path]).await;
        assert!(tracked.trim().is_empty(), "still in the index: {tracked}");
        assert!(
            !Path::new(repo).join(path).exists(),
            "the working file survived the deletion"
        );
    }

    /// Accept-all-current when OUR side deleted the file: `checkout --ours` can't
    /// serve a side with no stage, so taking it has to mean taking the deletion.
    /// Reverting the deletion arm turns this red — the core call errors instead.
    #[tokio::test]
    async fn accept_current_takes_the_deletion_when_our_side_deleted() {
        let (_dir, repo) = modify_delete_repo("md-ours", "file.txt", "ours").await;
        assert_modify_delete(&repo, "file.txt", 3, 2).await;

        let state = AppState::default();
        git_checkout_conflict_side_core(&state, repo.clone(), "file.txt".into(), "ours".into())
            .await
            .unwrap();

        assert_deleted_and_resolved(&repo, "file.txt").await;
    }

    /// The mirror: accept-all-incoming when THEIR side deleted the file. Here the
    /// deletion is also a staged change, since HEAD still carries the file.
    #[tokio::test]
    async fn accept_incoming_takes_the_deletion_when_their_side_deleted() {
        let (_dir, repo) = modify_delete_repo("md-theirs", "file.txt", "theirs").await;
        assert_modify_delete(&repo, "file.txt", 2, 3).await;

        let state = AppState::default();
        git_checkout_conflict_side_core(&state, repo.clone(), "file.txt".into(), "theirs".into())
            .await
            .unwrap();

        assert_deleted_and_resolved(&repo, "file.txt").await;
        let staged = stdout_of(&repo, &["diff", "--cached", "--name-status"]).await;
        assert!(staged.contains("D\tfile.txt"), "deletion staged: {staged}");
    }

    /// The other half of a modify/delete: taking the side that KEPT the file still
    /// goes through checkout, so the deletion arm must not swallow it.
    #[tokio::test]
    async fn modify_delete_keeps_the_file_when_the_surviving_side_is_taken() {
        let (_dir, repo) = modify_delete_repo("md-keep", "file.txt", "ours").await;
        // Pins the fixture: a typo in `deleted_by` would silently build the mirror
        // and leave this test asserting the wrong direction.
        assert_modify_delete(&repo, "file.txt", 3, 2).await;

        let state = AppState::default();
        git_checkout_conflict_side_core(&state, repo.clone(), "file.txt".into(), "theirs".into())
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(Path::new(&repo).join("file.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "theirs\n"
        );
        let unmerged = stdout_of(&repo, &["ls-files", "-u"]).await;
        assert!(
            unmerged.trim().is_empty(),
            "conflict left behind: {unmerged}"
        );
    }

    /// The guard on the deletion arm: `git rm` exits 0 and DELETES an
    /// already-resolved path (measured, git 2.51.1), so a second accept on a file
    /// whose conflict is gone must stay the harmless no-op it is today.
    #[tokio::test]
    async fn a_resolved_path_is_never_removed_by_a_second_accept() {
        let (_dir, repo) = conflicted_repo("md-double-fire", "file.txt", &[]).await;
        let state = AppState::default();
        git_checkout_conflict_side_core(&state, repo.clone(), "file.txt".into(), "ours".into())
            .await
            .unwrap();

        // The stale second click: same side, conflict already gone.
        git_checkout_conflict_side_core(&state, repo.clone(), "file.txt".into(), "ours".into())
            .await
            .unwrap();

        assert_eq!(
            std::fs::read_to_string(Path::new(&repo).join("file.txt"))
                .unwrap()
                .replace("\r\n", "\n"),
            "ours\n",
            "the resolved file survives a repeat accept"
        );
    }

    /// The aftermath of a taken removal: no stages left AND no file, so the
    /// checkout path would exit 1 on a pathspec matching nothing and hand the user
    /// raw git text. A repeat accept has to settle instead.
    #[tokio::test]
    async fn a_second_accept_after_a_taken_removal_is_a_no_op() {
        let (_dir, repo) = modify_delete_repo("md-repeat", "file.txt", "ours").await;
        let state = AppState::default();
        git_checkout_conflict_side_core(&state, repo.clone(), "file.txt".into(), "ours".into())
            .await
            .unwrap();
        assert_deleted_and_resolved(&repo, "file.txt").await;

        // Both sides, since either button is reachable in the header.
        git_checkout_conflict_side_core(&state, repo.clone(), "file.txt".into(), "ours".into())
            .await
            .unwrap();
        git_checkout_conflict_side_core(&state, repo.clone(), "file.txt".into(), "theirs".into())
            .await
            .unwrap();
        assert_deleted_and_resolved(&repo, "file.txt").await;
    }

    #[tokio::test]
    async fn ai_ignore_pattern_flags_the_path() {
        let (_dir, repo) = conflicted_repo("ignore", "file.txt", &[]).await;
        let hit = git_conflict_sides(repo.clone(), "file.txt".into(), vec!["*.txt".into()])
            .await
            .unwrap();
        assert!(hit.ai_ignored);
        let miss = git_conflict_sides(repo.clone(), "file.txt".into(), vec!["*.lock".into()])
            .await
            .unwrap();
        assert!(!miss.ai_ignored);

        // A NESTED copy of the same name: patterns are gitignore-style, so a bare
        // `file.txt` must flag `docs/file.txt` too — a missed depth is a leak.
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
        let (_dir, repo) = conflicted_repo("resolve", "file.txt", &[]).await;
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
