//! AI-assisted merge-conflict resolution plumbing.
//!
//! These commands feed a conflicted file's three sides to the frontend (which
//! asks the configured review model to propose a merge) and apply the user's
//! accepted result. Nothing here calls a model — the AI round-trip lives in the
//! webview, reusing the same streaming engine as PR review. The write paths are
//! `git_resolve_conflict_core` and `git_checkout_conflict_side_core`, both reached
//! only through an explicit user action in the UI.

use std::path::{Component, Path};

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::git::runner::{
    acquire_repo_lock, run_git, run_git_raw, run_git_raw_index_retry, DEFAULT_TIMEOUT,
    LOCK_WAIT_TIMEOUT,
};
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
    /// Whether the file must never be sent to a model, and why. The UI refuses to
    /// resolve an ignored one and says which cause applies.
    pub ai_ignored: AiIgnoreVerdict,
    /// Whether the working file is on disk. `working` collapses to "" for an
    /// empty file and a deleted one alike; this is what separates them. A file
    /// that exists but can't be read fails the whole command instead.
    pub working_exists: bool,
    /// The working file's bytes are not valid UTF-8, so `working` is a lossy
    /// decode: per-region accepts (which rebuild the file from it) must refuse.
    pub working_undecodable: bool,
    /// `working_undecodable`, OR any present stage blob's raw bytes are invalid
    /// UTF-8 — every string here that an AI resolution splices and writes back is
    /// then lossy, so the AI flow must refuse even when the working file is clean.
    pub undecodable: bool,
    /// Lowercase hex SHA-1 of the working file's raw bytes at this read; `None`
    /// when the file is absent (`working_exists` false). The write guard's
    /// expected value: `git_resolve_conflict` refuses when the live bytes no
    /// longer hash to it, unless they already equal the content being written.
    pub working_hash: Option<String>,
    /// Whether the raw working bytes match the single surviving side's raw
    /// blob bytes after CRLF→LF normalization (the byte-truth twin of the
    /// frontend's `nlf`: every 0x0D 0x0A pair → 0x0A, lone 0x0D kept).
    /// `None` unless exactly one of ours/theirs is present AND the working
    /// file exists.
    pub working_matches_survivor: Option<bool>,
}

/// Lowercase hex SHA-1 of `bytes`.
fn sha1_hex(bytes: &[u8]) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    // digest 0.11's output Array has no LowerHex, so hex-encode byte by byte.
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `nlf` (conflict-parse.ts) on bytes: one left-to-right pass replacing each
/// non-overlapping `\r\n` pair with `\n`, every other byte kept as-is.
fn nlf_bytes(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
            out.push(b'\n');
            i += 2;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    out
}

/// Verdict of a hash-guarded conflict-resolution write.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ResolveConflictOutcome {
    /// The live bytes matched the caller's read; the resolution was written
    /// (and staged when asked).
    Written,
    /// The working file changed after the caller's read — edited, deleted, or
    /// created where the read saw none. Nothing was written or staged.
    ChangedOnDisk,
}

/// The AI-ignore gate's answer for one conflicted path. `unreadable` implies
/// `ignored`: a name the app can't vouch for is withheld with no pattern at all,
/// and the cause stays separate so no copy blames rules the user may not have.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiIgnoreVerdict {
    pub ignored: bool,
    pub unreadable: bool,
}

/// Rejects empty paths and paths that could escape the repo root. The
/// path comes from git status (trusted-ish), but the write paths
/// (`git_resolve_conflict_core`, `git_checkout_conflict_side_core`) make traversal
/// worth refusing defensively.
fn validate_rel_path(path: &str) -> AppResult<()> {
    let p = Path::new(path);
    if path.is_empty()
        || p.is_absolute()
        || p.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(AppError::InvalidArgument(format!("invalid path: {path}")));
    }
    Ok(())
}

/// The sentence refusal for the leading-dash check and the shared path gate; the pane keys
/// on its opening via ConflictFileView.tsx's PATH_REFUSAL_PREFIX.
fn conflict_path_refusal(path: &str, why: &str) -> AppError {
    let shown = crate::git::ops::discard_shown(path);
    AppError::InvalidArgument(format!(
        "Can't resolve the conflict in {shown} — {why}. Nothing was changed."
    ))
}

/// Refuse leading-dash paths with a sentence before the three `invalid path:` refusals;
/// the shared gate then refuses or returns git's spelling.
fn conflict_rel_path(path: &str) -> AppResult<String> {
    if path.starts_with('-') {
        return Err(conflict_path_refusal(path, "its path starts with \"-\""));
    }
    validate_rel_path(path)?;
    crate::git::ops::discard_rel_path(path).map_err(|why| conflict_path_refusal(path, why))
}

/// The refusal reason for a symbolic link AT the conflicted path. Distinct from
/// `DISCARD_LINKED` (a linked ancestor): the conflict pane keeps Accept all
/// offered for this one, keyed on this string, pinned by
/// scripts/conflict-path-refusal.test.mjs.
const CONFLICT_LINKED_LEAF: &str = "it's a symbolic link";

/// Whether the leaf is a Windows directory link (a junction or directory
/// symlink). Git for Windows may lstat a junction as a directory and clear it
/// recursively, reaching through it, so this leaf is refused like an ancestor.
#[cfg(windows)]
fn leaf_is_directory_link(base: &str, rel: &str) -> std::io::Result<bool> {
    use std::os::windows::fs::FileTypeExt;
    let full = Path::new(base).join(rel);
    let spelling = crate::fsops::verbatim_path(&full)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no verbatim form"))?;
    match std::fs::symlink_metadata(spelling) {
        Ok(m) => Ok(m.file_type().is_symlink_dir()),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(false)
        }
        Err(e) => Err(e),
    }
}

#[cfg(not(windows))]
fn leaf_is_directory_link(_base: &str, _rel: &str) -> std::io::Result<bool> {
    Ok(false)
}

/// Refuses `path` when a component below `base` is a symbolic link or junction:
/// an ancestor or a Windows directory-link leaf always (`DISCARD_LINKED`), any
/// other leaf link when `include_leaf` (`CONFLICT_LINKED_LEAF`). `base` must be
/// the root the caller's read or write joins, so the walk covers exactly the
/// path that gets opened.
async fn refuse_linked_path(base: &str, path: &str, include_leaf: bool) -> AppResult<()> {
    let (walk_base, walk_rel) = (base.to_string(), path.to_string());
    let why = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<_> {
        use crate::git::ops::linked_component;
        let carrier = linked_component(&walk_base, &walk_rel, false)?
            || leaf_is_directory_link(&walk_base, &walk_rel)?;
        Ok(if carrier {
            Some(crate::git::ops::DISCARD_LINKED)
        } else if include_leaf && linked_component(&walk_base, &walk_rel, true)? {
            Some(CONFLICT_LINKED_LEAF)
        } else {
            None
        })
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
    .map_err(AppError::Io)?;
    match why {
        Some(why) => Err(conflict_path_refusal(path, why)),
        None => Ok(()),
    }
}

/// Reads a blob from an unmerged index stage (1 = base, 2 = ours, 3 = theirs).
/// `present` is the caller's `unmerged_stages` listing: a stage missing from it
/// (a side added or deleted the file) is `None` without a spawn. A listed stage
/// whose read fails is re-listed once: gone now means an outside resolve landed
/// after the listing (`None`, agreeing with the index); still listed is an
/// `AppError::Git`, never `None`, so a failed read can't pass for an absent side.
/// The `bool` is whether the blob's raw bytes are invalid UTF-8 (the text is
/// then a lossy decode), decided before decoding; the raw bytes ride along for
/// byte-truth compares.
async fn stage_blob(
    repo: &str,
    present: &[u8],
    stage: u8,
    path: &str,
) -> AppResult<Option<(String, bool, Vec<u8>)>> {
    if !present.contains(&stage) {
        return Ok(None);
    }
    // `:N:path` is a single rev-spec arg; a leading `-` in the path can't be read
    // as a flag because the `:N:` prefix comes first. conflict_rel_path already
    // refused absolute/traversal paths.
    let spec = format!(":{stage}:{path}");
    let out = run_git_raw(Some(repo), &["show", &spec], DEFAULT_TIMEOUT).await?;
    if out.code != 0
        && !unmerged_stages(repo, &crate::git::pathspec::literal(path))
            .await?
            .contains(&stage)
    {
        return Ok(None);
    }
    let out = out.exit_verdict()?;
    let undecodable = std::str::from_utf8(&out.stdout).is_err();
    Ok(Some((out.stdout_lossy(), undecodable, out.stdout)))
}

/// The unmerged index stages present for `spec` (1 = base, 2 = ours, 3 = theirs).
/// Empty when the path isn't conflicted at all. The presence truth for both the
/// take-a-side removal gate and `git_conflict_sides`' blob reads.
///
/// One `ls-files -u` spawn answers for every stage and returns only mode/sha/stage
/// metadata; `git show :N:` costs the same spawn but materializes the whole blob
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
///
/// Conflict paths arrive lossy-decoded over IPC, so byte truth is unavailable
/// here: any U+FFFD fails closed as unreadable, matching the TS twins.
async fn is_ai_ignored(repo: &str, path: &str, exclude: &[String]) -> AppResult<AiIgnoreVerdict> {
    if path.contains('\u{FFFD}') {
        return Ok(AiIgnoreVerdict {
            ignored: true,
            unreadable: true,
        });
    }
    let one = [path.to_string()];
    let hits = crate::git::ai_ignore::filter_ignored(repo, &one, exclude).await?;
    Ok(AiIgnoreVerdict {
        ignored: !hits.is_empty(),
        unreadable: false,
    })
}

/// The base/ours/theirs blobs plus the marked working file for a conflicted
/// path, and whether the path is AI-ignored. `exclude` is the user's combined
/// (repo + global) AI-ignore pattern list.
///
/// The stages are listed once, before the working-file and blob reads: a side
/// reads `None` only when the index says it's absent, and a resolve landing
/// after the listing is noticed by the stage reads (see `stage_blob`).
#[tauri::command]
pub async fn git_conflict_sides(
    repo_path: String,
    path: String,
    exclude: Vec<String>,
) -> AppResult<ConflictSides> {
    let path = conflict_rel_path(&path)?;
    // Ahead of every read: a link on the path would feed a file outside the
    // repository to the hash, the editor and the AI prompt.
    refuse_linked_path(&repo_path, &path, true).await?;

    let ai_ignored = is_ai_ignored(&repo_path, &path, &exclude).await?;

    let present = unmerged_stages(&repo_path, &crate::git::pathspec::literal(&path)).await?;
    #[cfg(test)]
    let _ = CONFLICT_SIDES_LISTED_HOOK.try_with(|hook| hook());

    // NotFound means the file is gone (a side or the user deleted it): it reads
    // as "" with `working_exists` false. Every other read failure refuses the
    // whole read, so no caller can mistake an unreadable file for a marker-free
    // one.
    let (working_bytes, working_exists) =
        match tokio::fs::read(Path::new(&repo_path).join(&path)).await {
            Ok(bytes) => (bytes, true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Vec::new(), false),
            Err(e) => return Err(AppError::Io(e)),
        };
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
    // Byte truth, never the decoded text: a genuine U+FFFD is valid UTF-8.
    let working_undecodable = std::str::from_utf8(&working_bytes).is_err();
    let working = String::from_utf8_lossy(&working_bytes).into_owned();

    let base = stage_blob(&repo_path, &present, 1, &path).await?;
    let ours = stage_blob(&repo_path, &present, 2, &path).await?;
    let theirs = stage_blob(&repo_path, &present, 3, &path).await?;
    let undecodable = working_undecodable
        || [&base, &ours, &theirs]
            .iter()
            .any(|blob| blob.as_ref().is_some_and(|(_, bad, _)| *bad));
    // From the reads' own Options, not `present`: the re-list arm in
    // `stage_blob` can read a listed stage as gone, and `deletedSide` reads these.
    let survivor = match (&ours, &theirs) {
        (Some((_, _, raw)), None) | (None, Some((_, _, raw))) => Some(raw),
        _ => None,
    };
    let working_matches_survivor = survivor
        .filter(|_| working_exists)
        .map(|raw| nlf_bytes(&working_bytes) == nlf_bytes(raw));
    let working_hash = working_exists.then(|| sha1_hex(&working_bytes));

    Ok(ConflictSides {
        working,
        base: base.map(|(text, _, _)| text),
        ours: ours.map(|(text, _, _)| text),
        theirs: theirs.map(|(text, _, _)| text),
        ai_ignored,
        working_exists,
        working_undecodable,
        undecodable,
        working_hash,
        working_matches_survivor,
    })
}

#[cfg(test)]
tokio::task_local! {
    /// Runs just after `git_conflict_sides` lists the stages, so a test can change
    /// the index between that listing and the blob reads.
    static CONFLICT_SIDES_LISTED_HOOK: std::sync::Arc<dyn Fn() + Send + Sync>;
}

/// Writes a resolution to the working file, and (when `stage`) stages it.
/// Staging an unmerged path collapses its stages, which is what marks the
/// conflict resolved (drops it from the conflict count and lets the
/// merge/rebase/cherry-pick Continue). Per-region resolution writes without
/// staging while markers remain, then stages on the final region; the AI flow
/// stages unless its proposal still carries markers. The UI only reaches this
/// after the user reviews and accepts.
///
/// `expected_hash` is the `working_hash` of the read the content was built
/// from; `None` means that read found no file, so a missing key fails closed
/// for any file that exists now. Either way, live bytes that already equal the
/// content being written proceed, since rewriting them loses nothing.
#[tauri::command]
pub async fn git_resolve_conflict(
    state: State<'_, AppState>,
    repo_path: String,
    path: String,
    content: String,
    stage: bool,
    expected_hash: Option<String>,
) -> AppResult<ResolveConflictOutcome> {
    git_resolve_conflict_core(&state, repo_path, path, content, stage, expected_hash).await
}

async fn git_resolve_conflict_core(
    state: &AppState,
    repo_path: String,
    path: String,
    content: String,
    stage: bool,
    expected_hash: Option<String>,
) -> AppResult<ResolveConflictOutcome> {
    let path = conflict_rel_path(&path)?;
    let full = Path::new(&repo_path).join(&path);

    // One hold across compare, write and add, so two in-app writers can't both
    // pass the compare and interleave their writes. Lock-free runners only while
    // held (see `run_git_mutating`).
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a conflict resolution").await?;
    // Under the hold, before the live read: a link on the path would compare
    // and overwrite (or, dangling, create) a file outside the repository.
    refuse_linked_path(&repo_path, &path, true).await?;

    // Any read failure but NotFound is an error, never a defaulted verdict.
    let live = match tokio::fs::read(&full).await {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(AppError::Io(e)),
    };
    let unchanged = match (&expected_hash, &live) {
        (None, None) => true,
        (Some(hash), Some(bytes)) => sha1_hex(bytes) == *hash,
        _ => false,
    };
    // Rewriting the bytes already on disk loses nothing (a retry after a landed
    // write whose add failed); a file deleted since the read always refuses.
    let already_written = live.as_deref() == Some(content.as_bytes());
    if !unchanged && !already_written {
        return Ok(ResolveConflictOutcome::ChangedOnDisk);
    }

    tokio::fs::write(&full, content)
        .await
        .map_err(AppError::Io)?;
    if stage {
        let spec = crate::git::pathspec::literal(&path);
        run_git_raw_index_retry(&repo_path, &["add", "--", &spec], DEFAULT_TIMEOUT)
            .await?
            .exit_verdict()?;
    }
    Ok(ResolveConflictOutcome::Written)
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
    let path = conflict_rel_path(&path)?;
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
    let domain = state.working_tree_lock(&repo_path).await;
    let _guard = acquire_repo_lock(&domain, LOCK_WAIT_TIMEOUT, "a conflict resolution").await?;
    // Not a leaf link, which git replaces or removes itself (a Windows directory
    // link stays refused): a linked ancestor could carry the checkout or removal
    // outside the repository.
    refuse_linked_path(&repo_path, &path, false).await?;

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
                "--no-ext-diff",
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

/// `git_resolve_conflict_core`'s write-then-add without the path gate, the literal
/// pathspec, `State`, the working-tree lock, the expected-hash guard, or the
/// add's one-shot index.lock retry.
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

    #[tokio::test]
    async fn conflict_commands_refuse_git_dir_paths() {
        let (dir, repo) = conflicted_repo("path-gate", "file.txt", &[]).await;
        let state = AppState::default();
        let probe = dir.path().join(".git/gd-probe.txt");
        std::fs::write(&probe, "keep\n").unwrap();
        let config = std::fs::read(dir.path().join(".git/config")).unwrap();
        for path in [".git/config", "sub/.git/x", ".git/gd-probe.txt"] {
            let expected = format!(
                "invalid argument: Can't resolve the conflict in {path} — it's inside the repository's .git folder. Nothing was changed."
            );
            assert_eq!(
                git_conflict_sides(repo.clone(), path.into(), vec![])
                    .await
                    .err()
                    .expect("conflict path must refuse")
                    .to_string(),
                expected
            );
            assert_eq!(
                git_resolve_conflict_core(
                    &state,
                    repo.clone(),
                    path.into(),
                    "x".into(),
                    false,
                    None
                )
                .await
                .unwrap_err()
                .to_string(),
                expected
            );
            assert_eq!(
                git_checkout_conflict_side_core(&state, repo.clone(), path.into(), "ours".into())
                    .await
                    .unwrap_err()
                    .to_string(),
                expected
            );
        }
        assert_eq!(std::fs::read(&probe).unwrap(), b"keep\n");
        assert_eq!(
            std::fs::read(dir.path().join(".git/config")).unwrap(),
            config
        );
        assert!(!dir.path().join("sub/.git/x").exists());
        #[cfg(windows)]
        let absolute = "C:\\x";
        #[cfg(not(windows))]
        let absolute = "/x";
        for path in ["", absolute, "../x"] {
            let expected = format!("invalid argument: invalid path: {path}");
            assert_eq!(
                git_conflict_sides(repo.clone(), path.into(), vec![])
                    .await
                    .err()
                    .expect("conflict path must refuse")
                    .to_string(),
                expected
            );
            assert_eq!(
                git_resolve_conflict_core(
                    &state,
                    repo.clone(),
                    path.into(),
                    "x".into(),
                    false,
                    None
                )
                .await
                .unwrap_err()
                .to_string(),
                expected
            );
            assert_eq!(
                git_checkout_conflict_side_core(&state, repo.clone(), path.into(), "ours".into())
                    .await
                    .unwrap_err()
                    .to_string(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn conflict_commands_refuse_leading_dash_paths() {
        let (dir, repo) = conflicted_repo("dash-path-gate", "file.txt", &[]).await;
        let state = AppState::default();
        for path in ["-x", "-dir/x"] {
            let shown = crate::git::ops::discard_shown(path);
            let expected = format!(
                "invalid argument: Can't resolve the conflict in {shown} — its path starts with \"-\". Nothing was changed."
            );
            assert_eq!(
                git_conflict_sides(repo.clone(), path.into(), vec![])
                    .await
                    .err()
                    .expect("conflict path must refuse")
                    .to_string(),
                expected
            );
            assert_eq!(
                git_resolve_conflict_core(
                    &state,
                    repo.clone(),
                    path.into(),
                    "x".into(),
                    false,
                    None
                )
                .await
                .unwrap_err()
                .to_string(),
                expected
            );
            assert_eq!(
                git_checkout_conflict_side_core(&state, repo.clone(), path.into(), "ours".into())
                    .await
                    .unwrap_err()
                    .to_string(),
                expected
            );
        }
        assert!(!dir.path().join("-x").exists());
        assert!(!dir.path().join("-dir").exists());
        assert_eq!(conflict_rel_path("dir/-x").unwrap(), "dir/-x");
    }

    #[cfg(windows)]
    #[test]
    fn conflict_rel_path_refuses_windows_alias_spellings() {
        for path in ["C:x", "\\x", "/x"] {
            assert_eq!(conflict_rel_path(path).unwrap_err().to_string(), format!(
                "invalid argument: Can't resolve the conflict in {path} — it isn't inside this repository's working tree. Nothing was changed."
            ));
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn resolve_refuses_windows_alias_spellings() {
        let (dir, repo) = conflicted_repo("resolve-alias", "file.txt", &[]).await;
        std::fs::create_dir(dir.path().join("a")).unwrap();
        let probe = dir.path().join(".git/gd-probe.txt");
        std::fs::write(&probe, "keep\n").unwrap();
        let shell = "x.{0AFACED1-E828-11D1-9187-B532F1E9575D}";
        std::fs::create_dir(dir.path().join(shell)).unwrap();
        for (path, why) in [
            (
                "a./b.txt",
                "Windows reads a name ending in a dot or space as a different path",
            ),
            (
                "a /b.txt",
                "Windows reads a name ending in a dot or space as a different path",
            ),
            (
                ".GIT/gd-probe.txt",
                "it's inside the repository's .git folder",
            ),
            (
                "x.{0AFACED1-E828-11D1-9187-B532F1E9575D}/y",
                "Windows treats a name ending in .{GUID} as a shell link",
            ),
        ] {
            let err = git_resolve_conflict_core(
                &AppState::default(),
                repo.clone(),
                path.into(),
                "x".into(),
                false,
                None,
            )
            .await
            .unwrap_err();
            assert_eq!(err.to_string(), format!(
                "invalid argument: Can't resolve the conflict in {path} — {why}. Nothing was changed."
            ));
            assert!(!dir.path().join("a/b.txt").exists());
            assert_eq!(std::fs::read(&probe).unwrap(), b"keep\n");
            assert!(!dir.path().join(shell).join("y").exists());
        }
    }

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
        conflicted_repo_with(tag, path, also_tracked, b"base\n", b"ours\n", b"theirs\n").await
    }

    /// A real merge conflict on `path` whose base, ours and theirs sides hold the
    /// given BYTES, left mid-merge, so a test can mint stage blobs (and a merged
    /// working file) that aren't valid UTF-8. `also_tracked` as in
    /// `conflicted_repo`.
    async fn conflicted_repo_with(
        tag: &str,
        path: &str,
        also_tracked: &[&str],
        base: &[u8],
        ours: &[u8],
        theirs: &[u8],
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
        std::fs::write(&file, base).unwrap();
        git(vec!["add", "."]).await;
        git(vec!["commit", "-m", "base"]).await;
        git(vec!["checkout", "-b", "feature"]).await;
        std::fs::write(&file, theirs).unwrap();
        git(vec!["commit", "-am", "theirs"]).await;
        git(vec!["checkout", "-"]).await;
        std::fs::write(&file, ours).unwrap();
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
        assert_eq!(
            sides.ai_ignored,
            AiIgnoreVerdict {
                ignored: false,
                unreadable: false
            }
        );
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
        modify_delete_repo_with(tag, path, deleted_by, b"ours\n", b"theirs\n").await
    }

    /// `modify_delete_repo` whose modifying side commits the given BYTES (`ours`
    /// when theirs deletes, `theirs` when ours deletes), so a survivor blob can be
    /// minted that isn't valid UTF-8.
    async fn modify_delete_repo_with(
        tag: &str,
        path: &str,
        deleted_by: &str,
        ours: &[u8],
        theirs: &[u8],
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
            std::fs::write(&file, theirs).unwrap();
            git_ok(&repo, &["add", "--", path]).await;
        }
        git_ok(&repo, &["commit", "-m", "feature"]).await;

        git_ok(&repo, &["checkout", "-"]).await;
        if deleted_by == "ours" {
            git_ok(&repo, &["rm", "-q", "--", path]).await;
        } else {
            std::fs::write(&file, ours).unwrap();
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

    /// A modify/delete has no stage for the deleting side: it reads `None` while
    /// the surviving side and the base keep their content.
    #[tokio::test]
    async fn modify_delete_reads_the_deleted_side_as_absent() {
        let (_dir, repo) = modify_delete_repo("md-sides", "file.txt", "ours").await;
        assert_modify_delete(&repo, "file.txt", 3, 2).await;

        let sides = git_conflict_sides(repo, "file.txt".into(), vec![])
            .await
            .unwrap();
        assert_eq!(sides.ours, None);
        assert_eq!(sides.theirs.as_deref(), Some("theirs\n"));
        assert_eq!(sides.base.as_deref(), Some("base\n"));
    }

    /// A stage the index still lists but whose blob can't be read is an error:
    /// `None` would tell the frontend that side is absent, and with every read
    /// failing a still-conflicted file would read as resolved. A deleted loose
    /// object is the fixture.
    #[tokio::test]
    async fn an_unreadable_present_stage_fails_the_read() {
        let (_dir, repo) = conflicted_repo("unreadable-stage", "file.txt", &[]).await;
        let listing = stdout_of(&repo, &["ls-files", "-u", "--", "file.txt"]).await;
        let sha = listing
            .lines()
            .find_map(|line| {
                let meta = line.split('\t').next()?;
                let mut fields = meta.split_whitespace();
                let sha = fields.nth(1)?;
                (fields.next()? == "2").then(|| sha.to_string())
            })
            .unwrap_or_else(|| panic!("no stage 2 listed: {listing}"));
        let object = Path::new(&repo)
            .join(".git")
            .join("objects")
            .join(&sha[..2])
            .join(&sha[2..]);
        // git writes loose objects read-only, which Windows refuses to delete.
        let mut perms = std::fs::metadata(&object).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        std::fs::set_permissions(&object, perms).unwrap();
        std::fs::remove_file(&object).unwrap();

        let err = git_conflict_sides(repo, "file.txt".into(), vec![])
            .await
            .err()
            .expect("a present stage that can't be read must not read as Ok");
        assert!(
            matches!(err, AppError::Git { .. }),
            "expected AppError::Git, got {err:?}"
        );
    }

    /// A resolve landing between the stage listing and the blob reads: every
    /// listed stage's read fails, the re-list finds the path resolved, and the
    /// sides read absent rather than failing.
    #[tokio::test]
    async fn a_resolve_after_the_listing_reads_every_side_absent() {
        let (_dir, repo) = conflicted_repo("resolve-mid-read", "file.txt", &[]).await;
        let ran = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let hook: std::sync::Arc<dyn Fn() + Send + Sync> = {
            let repo = repo.clone();
            let ran = std::sync::Arc::clone(&ran);
            std::sync::Arc::new(move || {
                let status = std::process::Command::new("git")
                    .args(["add", "--", "file.txt"])
                    .current_dir(&repo)
                    .status()
                    .expect("spawn git add");
                assert!(status.success(), "git add failed: {status}");
                ran.store(true, std::sync::atomic::Ordering::SeqCst);
            })
        };

        let sides = CONFLICT_SIDES_LISTED_HOOK
            .scope(
                hook,
                git_conflict_sides(repo.clone(), "file.txt".into(), vec![]),
            )
            .await
            .unwrap();

        assert!(
            ran.load(std::sync::atomic::Ordering::SeqCst),
            "the hook never ran"
        );
        let unmerged = stdout_of(&repo, &["ls-files", "-u"]).await;
        assert!(
            unmerged.trim().is_empty(),
            "fixture still conflicted: {unmerged}"
        );
        assert_eq!(sides.base, None);
        assert_eq!(sides.ours, None);
        assert_eq!(sides.theirs, None);
    }

    /// `working_exists` is what separates an emptied working file from a deleted
    /// one, since `working` is "" for both — the discriminator pair the frontend
    /// rides on, so present, emptied and gone each get a leg (an unreadable file
    /// fails the command instead; see `unreadable_working_file_fails_the_read`).
    /// The wire key is asserted too: the frontend reads `workingExists`, and a
    /// rename here would go silent.
    #[tokio::test]
    async fn working_exists_tracks_the_file_on_disk() {
        let (_dir, repo) = conflicted_repo("working-exists", "file.txt", &[]).await;
        let present = git_conflict_sides(repo.clone(), "file.txt".into(), vec![])
            .await
            .unwrap();
        assert!(present.working_exists);
        let json = serde_json::to_string(&present).unwrap();
        assert!(
            json.contains("\"workingExists\":true"),
            "wire key missing: {json}"
        );

        // Emptied on purpose: same "" content as a deletion, opposite verdict.
        std::fs::write(Path::new(&repo).join("file.txt"), "").unwrap();
        let emptied = git_conflict_sides(repo.clone(), "file.txt".into(), vec![])
            .await
            .unwrap();
        assert_eq!(emptied.working, "");
        assert!(emptied.working_exists);
        let json = serde_json::to_string(&emptied).unwrap();
        assert!(
            json.contains("\"workingExists\":true"),
            "wire key missing: {json}"
        );

        std::fs::remove_file(Path::new(&repo).join("file.txt")).unwrap();
        let gone = git_conflict_sides(repo, "file.txt".into(), vec![])
            .await
            .unwrap();
        assert!(!gone.working_exists);
        assert_eq!(gone.working, "", "a missing file still reads as empty");
        // The stages survive the deletion, so the path is still conflicted.
        assert_eq!(gone.ours.as_deref(), Some("ours\n"));
        let json = serde_json::to_string(&gone).unwrap();
        assert!(
            json.contains("\"workingExists\":false"),
            "wire key missing: {json}"
        );
    }

    /// A working file that exists but can't be read must fail the command: an
    /// `Ok` with empty content reads as marker-free, and every staging gate would
    /// pass it unconfirmed. A directory in the file's place is the portable
    /// unreadable fixture: Windows refuses to open it with PermissionDenied (os
    /// error 5, measured), Unix fails the read with IsADirectory.
    #[tokio::test]
    async fn unreadable_working_file_fails_the_read() {
        let (_dir, repo) = conflicted_repo("unreadable", "file.txt", &[]).await;
        let file = Path::new(&repo).join("file.txt");
        std::fs::remove_file(&file).unwrap();
        std::fs::create_dir(&file).unwrap();
        let err = git_conflict_sides(repo, "file.txt".into(), vec![])
            .await
            .err()
            .expect("an unreadable working file must not read as Ok");
        match err {
            AppError::Io(e) => assert_ne!(e.kind(), std::io::ErrorKind::NotFound, "{e}"),
            other => panic!("expected AppError::Io, got {other:?}"),
        }
    }

    /// Mark resolved is a plain `git add` on the unmerged path, and the UI offers
    /// it while the working file is DELETED: git stages that removal and clears
    /// the conflict (measured, git 2.51.1). Nothing else records this — the arm
    /// that offers the button reads only `working_exists`.
    #[tokio::test]
    async fn stage_on_deleted_working_file_records_the_removal() {
        let (_dir, repo) = conflicted_repo("stage-deleted", "file.txt", &[]).await;
        std::fs::remove_file(Path::new(&repo).join("file.txt")).unwrap();
        // Pins the premise: without a live conflict here the post-state asserts
        // nothing.
        let before = stdout_of(&repo, &["ls-files", "-u"]).await;
        assert!(before.contains("file.txt"), "fixture not conflicted: {before}");

        let state = AppState::default();
        crate::git::stage::git_stage_core(
            &state,
            repo.clone(),
            vec![crate::git::pathspec::literal("file.txt")],
        )
        .await
        .unwrap();

        let staged = stdout_of(&repo, &["diff", "--cached", "--name-status"]).await;
        assert!(staged.contains("D\tfile.txt"), "deletion staged: {staged}");
        let unmerged = stdout_of(&repo, &["ls-files", "-u"]).await;
        assert!(
            unmerged.trim().is_empty(),
            "conflict left behind: {unmerged}"
        );
    }

    #[tokio::test]
    async fn ai_ignore_pattern_flags_the_path() {
        let (_dir, repo) = conflicted_repo("ignore", "file.txt", &[]).await;
        let hit = git_conflict_sides(repo.clone(), "file.txt".into(), vec!["*.txt".into()])
            .await
            .unwrap();
        assert!(hit.ai_ignored.ignored);
        assert!(
            !hit.ai_ignored.unreadable,
            "a pattern hit is not an unreadable name"
        );
        let miss = git_conflict_sides(repo.clone(), "file.txt".into(), vec!["*.lock".into()])
            .await
            .unwrap();
        assert!(!miss.ai_ignored.ignored);

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
        assert!(
            nested.ai_ignored.ignored,
            "a bare name matches at any depth"
        );

        // ...while a leading `/` anchors to the repo root: the nested copy is
        // free, the root one is still flagged.
        let anchored_nested =
            git_conflict_sides(repo.clone(), "docs/file.txt".into(), vec!["/file.txt".into()])
                .await
                .unwrap();
        assert!(!anchored_nested.ai_ignored.ignored);
        let anchored_root =
            git_conflict_sides(repo, "file.txt".into(), vec!["/file.txt".into()])
                .await
                .unwrap();
        assert!(anchored_root.ai_ignored.ignored);
    }

    /// A U+FFFD in a conflicted path fails closed as UNREADABLE — ignored with no
    /// pattern configured, and attributed to the name rather than to any rule — since
    /// the path reaches this command lossy-decoded and its real bytes are gone.
    #[tokio::test]
    async fn a_replacement_character_path_is_withheld_as_unreadable() {
        let name = "caf\u{FFFD}.txt";
        let (_dir, repo) = conflicted_repo("fffd", name, &[]).await;
        let unreadable = AiIgnoreVerdict {
            ignored: true,
            unreadable: true,
        };
        for patterns in [
            vec![],
            vec!["*.lock".to_string()],
            vec!["*.txt".to_string()],
        ] {
            let label = format!("{patterns:?}");
            let sides = git_conflict_sides(repo.clone(), name.into(), patterns)
                .await
                .unwrap_or_else(|e| panic!("{label}: {e}"));
            assert_eq!(sides.ai_ignored, unreadable, "{label}");
        }
        // The IPC shape the TS mirror reads.
        let json = serde_json::to_value(unreadable).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "ignored": true, "unreadable": true })
        );
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

    /// A non-UTF-8 working file raises both flags (per-region accepts and the AI
    /// flow both refuse), decided from its bytes; the clean fixture is the
    /// negative control. The wire keys are pinned as the TS mirror reads them.
    #[tokio::test]
    async fn conflict_sides_flag_undecodable_bytes() {
        let (_dir, repo) = conflicted_repo("undecodable-working", "file.txt", &[]).await;
        let clean = git_conflict_sides(repo.clone(), "file.txt".into(), vec![])
            .await
            .unwrap();
        assert!(!clean.working_undecodable);
        assert!(!clean.undecodable);

        std::fs::write(
            Path::new(&repo).join("file.txt"),
            b"<<<<<<< HEAD\nours \xFC\n=======\ntheirs\n>>>>>>> feature\n",
        )
        .unwrap();
        let dirty = git_conflict_sides(repo, "file.txt".into(), vec![])
            .await
            .unwrap();
        assert!(dirty.working_undecodable);
        assert!(dirty.undecodable);
        let json = serde_json::to_string(&dirty).unwrap();
        assert!(
            json.contains("\"workingUndecodable\":true"),
            "wire key missing: {json}"
        );
        assert!(
            json.contains("\"undecodable\":true"),
            "wire key missing: {json}"
        );
        assert!(
            !json.contains("working_undecodable"),
            "snake_case leaked: {json}"
        );
    }

    /// A clean working file over a non-UTF-8 stage blob sets only the OR flag:
    /// per-region accepts rebuild from the working text alone (lossless), while
    /// the AI flow splices every side.
    #[tokio::test]
    async fn conflict_sides_blob_only_undecodable_sets_only_the_or_flag() {
        let (_dir, repo) = conflicted_repo_with(
            "undecodable-blob",
            "file.txt",
            &[],
            b"base\n",
            b"ours\n",
            b"th\xFCirs\n",
        )
        .await;
        std::fs::write(
            Path::new(&repo).join("file.txt"),
            "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> feature\n",
        )
        .unwrap();
        let sides = git_conflict_sides(repo, "file.txt".into(), vec![])
            .await
            .unwrap();
        assert!(sides.theirs.is_some(), "the dirty blob must be present");
        assert!(!sides.working_undecodable);
        assert!(sides.undecodable);
    }

    /// Valid UTF-8 carrying a literal U+FFFD (EF BF BD) is not a lossy decode, so
    /// neither flag fires on any side.
    #[tokio::test]
    async fn conflict_sides_real_replacement_char_is_not_undecodable() {
        let (_dir, repo) = conflicted_repo_with(
            "undecodable-fffd",
            "file.txt",
            &[],
            "base \u{FFFD}\n".as_bytes(),
            "ours \u{FFFD}\n".as_bytes(),
            "theirs \u{FFFD}\n".as_bytes(),
        )
        .await;
        let sides = git_conflict_sides(repo, "file.txt".into(), vec![])
            .await
            .unwrap();
        assert!(sides.working.contains('\u{FFFD}'));
        assert!(sides.working.contains("<<<<<<<"), "fixture not conflicted");
        assert!(!sides.working_undecodable);
        assert!(!sides.undecodable);
    }

    async fn sides_of(repo: &str, path: &str) -> ConflictSides {
        git_conflict_sides(repo.into(), path.into(), vec![])
            .await
            .unwrap()
    }

    async fn resolve(
        repo: &str,
        path: &str,
        content: &str,
        stage: bool,
        expected_hash: Option<String>,
    ) -> ResolveConflictOutcome {
        git_resolve_conflict_core(
            &AppState::default(),
            repo.into(),
            path.into(),
            content.into(),
            stage,
            expected_hash,
        )
        .await
        .unwrap()
    }

    #[test]
    fn sha1_hex_is_lowercase_hex_of_the_bytes() {
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }

    /// The wire shapes the TS mirror narrows on.
    #[tokio::test]
    async fn resolve_outcome_and_sides_wire_keys() {
        assert_eq!(
            serde_json::to_value(ResolveConflictOutcome::Written).unwrap(),
            serde_json::json!({ "kind": "written" })
        );
        assert_eq!(
            serde_json::to_value(ResolveConflictOutcome::ChangedOnDisk).unwrap(),
            serde_json::json!({ "kind": "changedOnDisk" })
        );
        let (_dir, repo) = conflicted_repo("guard-wire", "file.txt", &[]).await;
        let json = serde_json::to_value(sides_of(&repo, "file.txt").await).unwrap();
        let disk = std::fs::read(Path::new(&repo).join("file.txt")).unwrap();
        assert_eq!(json["workingHash"], serde_json::json!(sha1_hex(&disk)));
        assert_eq!(
            json.get("workingMatchesSurvivor"),
            Some(&serde_json::Value::Null)
        );
    }

    /// The refusal contract: an outside edit landing after the read (UTF-8 or
    /// not) keeps its exact bytes on disk, and the index keeps its stages.
    #[tokio::test]
    async fn resolve_refuses_an_outside_edit_after_the_read() {
        let (_dir, repo) = conflicted_repo("guard-edit", "file.txt", &[]).await;
        let read = sides_of(&repo, "file.txt").await;
        assert!(read.working_hash.is_some());
        let before = stdout_of(&repo, &["ls-files", "-u"]).await;
        assert!(
            before.contains("file.txt"),
            "fixture not conflicted: {before}"
        );
        let file = Path::new(&repo).join("file.txt");
        for edit in [b"outside edit\n".as_slice(), b"outside \xFC edit\n"] {
            std::fs::write(&file, edit).unwrap();
            for stage in [false, true] {
                let outcome = resolve(
                    &repo,
                    "file.txt",
                    "resolved\n",
                    stage,
                    read.working_hash.clone(),
                )
                .await;
                assert_eq!(outcome, ResolveConflictOutcome::ChangedOnDisk);
                assert_eq!(std::fs::read(&file).unwrap(), edit);
                assert_eq!(stdout_of(&repo, &["ls-files", "-u"]).await, before);
            }
        }
    }

    /// A file deleted after a read that saw it refuses even when the content is
    /// empty: the identical-bytes exemption never recreates a deleted file.
    #[tokio::test]
    async fn resolve_refuses_a_file_deleted_after_the_read() {
        let (_dir, repo) = conflicted_repo("guard-deleted", "file.txt", &[]).await;
        let read = sides_of(&repo, "file.txt").await;
        let before = stdout_of(&repo, &["ls-files", "-u"]).await;
        let file = Path::new(&repo).join("file.txt");
        std::fs::remove_file(&file).unwrap();
        for content in ["resolved\n", ""] {
            let outcome =
                resolve(&repo, "file.txt", content, true, read.working_hash.clone()).await;
            assert_eq!(
                outcome,
                ResolveConflictOutcome::ChangedOnDisk,
                "{content:?}"
            );
            assert!(!file.exists(), "the deleted file came back: {content:?}");
            assert_eq!(stdout_of(&repo, &["ls-files", "-u"]).await, before);
        }
    }

    /// A read that found no file passes `None`: a file created since then
    /// refuses, and one still absent takes the write.
    #[tokio::test]
    async fn resolve_null_hash_refuses_a_created_file_and_writes_an_absent_one() {
        let (_dir, repo) = modify_delete_repo("guard-null", "file.txt", "ours").await;
        let file = Path::new(&repo).join("file.txt");
        std::fs::remove_file(&file).unwrap();
        let read = sides_of(&repo, "file.txt").await;
        assert!(!read.working_exists);
        assert_eq!(read.working_hash, None);
        let before = stdout_of(&repo, &["ls-files", "-u"]).await;

        std::fs::write(&file, "recreated\n").unwrap();
        let outcome = resolve(&repo, "file.txt", "resolved\n", true, None).await;
        assert_eq!(outcome, ResolveConflictOutcome::ChangedOnDisk);
        assert_eq!(std::fs::read(&file).unwrap(), b"recreated\n");
        assert_eq!(stdout_of(&repo, &["ls-files", "-u"]).await, before);

        std::fs::remove_file(&file).unwrap();
        let outcome = resolve(&repo, "file.txt", "resolved\n", true, None).await;
        assert_eq!(outcome, ResolveConflictOutcome::Written);
        assert_eq!(std::fs::read(&file).unwrap(), b"resolved\n");
        let unmerged = stdout_of(&repo, &["ls-files", "-u"]).await;
        assert!(
            unmerged.trim().is_empty(),
            "conflict left behind: {unmerged}"
        );
    }

    /// An outside save of the very same bytes (CRLF intact) hashes equal, so the
    /// guard never refuses an unchanged file.
    #[tokio::test]
    async fn resolve_accepts_an_identical_bytes_resave() {
        let (_dir, repo) = conflicted_repo("guard-resave", "file.txt", &[]).await;
        let file = Path::new(&repo).join("file.txt");
        let crlf = b"<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> feature\r\n";
        std::fs::write(&file, crlf).unwrap();
        let read = sides_of(&repo, "file.txt").await;
        std::fs::write(&file, crlf).unwrap();
        let outcome = resolve(&repo, "file.txt", "ours\r\n", false, read.working_hash).await;
        assert_eq!(outcome, ResolveConflictOutcome::Written);
        assert_eq!(std::fs::read(&file).unwrap(), b"ours\r\n");
    }

    /// The per-region walk: each accept carries the hash of the read taken after
    /// the previous write, so a two-region file resolves without a false refusal
    /// (while the first read's hash, stale after our own write, refuses).
    #[tokio::test]
    async fn resolve_walks_a_multi_region_file_on_fresh_reads() {
        let (_dir, repo) = conflicted_repo("guard-walk", "file.txt", &[]).await;
        let file = Path::new(&repo).join("file.txt");
        let region =
            |n: u8| format!("<<<<<<< HEAD\nours{n}\n=======\ntheirs{n}\n>>>>>>> feature\n");
        std::fs::write(&file, format!("a\n{}mid\n{}z\n", region(1), region(2))).unwrap();

        let first = sides_of(&repo, "file.txt").await;
        let step1 = format!("a\nours1\nmid\n{}z\n", region(2));
        let outcome = resolve(&repo, "file.txt", &step1, false, first.working_hash.clone()).await;
        assert_eq!(outcome, ResolveConflictOutcome::Written);
        assert!(stdout_of(&repo, &["ls-files", "-u"])
            .await
            .contains("file.txt"));

        let second = sides_of(&repo, "file.txt").await;
        assert_ne!(second.working_hash, first.working_hash);
        let done = "a\nours1\nmid\ntheirs2\nz\n";
        let stale = resolve(&repo, "file.txt", done, true, first.working_hash).await;
        assert_eq!(stale, ResolveConflictOutcome::ChangedOnDisk);
        let outcome = resolve(&repo, "file.txt", done, true, second.working_hash).await;
        assert_eq!(outcome, ResolveConflictOutcome::Written);
        assert_eq!(std::fs::read(&file).unwrap(), done.as_bytes());
        let unmerged = stdout_of(&repo, &["ls-files", "-u"]).await;
        assert!(
            unmerged.trim().is_empty(),
            "conflict left behind: {unmerged}"
        );
    }

    /// The stage step runs under the held working-tree lock, so it must use a
    /// lock-free runner: a re-locking one would wait out LOCK_WAIT_TIMEOUT.
    #[tokio::test]
    async fn resolve_stages_under_its_own_lock() {
        let (_dir, repo) = conflicted_repo("guard-stage", "file.txt", &[]).await;
        let read = sides_of(&repo, "file.txt").await;
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(8),
            resolve(&repo, "file.txt", "merged\n", true, read.working_hash),
        )
        .await
        .expect("the stage step stalled on the held lock");
        assert_eq!(outcome, ResolveConflictOutcome::Written);
        let unmerged = stdout_of(&repo, &["ls-files", "-u", "--", "file.txt"]).await;
        assert!(
            unmerged.trim().is_empty(),
            "conflict left behind: {unmerged}"
        );
        let staged = stdout_of(&repo, &["diff", "--cached", "--name-only"]).await;
        assert!(staged.contains("file.txt"), "not staged: {staged}");
    }

    /// A retry after a landed write whose add failed: disk already holds the
    /// content, so the stale hash doesn't refuse and the stage goes through.
    #[tokio::test]
    async fn resolve_retry_over_its_own_landed_write_stages() {
        let (_dir, repo) = conflicted_repo("guard-retry", "file.txt", &[]).await;
        let read = sides_of(&repo, "file.txt").await;
        let file = Path::new(&repo).join("file.txt");
        std::fs::write(&file, "merged\n").unwrap();
        let outcome = resolve(&repo, "file.txt", "merged\n", true, read.working_hash).await;
        assert_eq!(outcome, ResolveConflictOutcome::Written);
        let unmerged = stdout_of(&repo, &["ls-files", "-u"]).await;
        assert!(
            unmerged.trim().is_empty(),
            "conflict left behind: {unmerged}"
        );
        let staged = stdout_of(&repo, &["diff", "--cached", "--name-only"]).await;
        assert!(staged.contains("file.txt"), "not staged: {staged}");
    }

    /// `nlf` is one non-overlapping left-to-right pass over CRLF pairs only.
    #[test]
    fn nlf_bytes_mirrors_the_frontend_nlf() {
        assert_eq!(nlf_bytes(b"a\r\nb\r\n"), b"a\nb\n");
        assert_eq!(nlf_bytes(b"a\r\r\n"), b"a\r\n");
        assert_eq!(nlf_bytes(b"a\rb\r"), b"a\rb\r");
        assert_eq!(nlf_bytes(b"a\n"), b"a\n");
        assert_eq!(nlf_bytes(b"\xEF\xBB\xBFa\r\n"), b"\xEF\xBB\xBFa\n");
        assert_eq!(nlf_bytes(b"\r\n\n"), b"\n\n");
    }

    /// Byte truth for the deletion arms: lossy decodes can collide or differ by
    /// replacement chars, the raw compare can't.
    #[tokio::test]
    async fn working_matches_survivor_compares_raw_bytes() {
        let (_dir, repo) =
            modify_delete_repo_with("survivor", "file.txt", "ours", b"", b"th\xFCirs\n").await;
        assert_modify_delete(&repo, "file.txt", 3, 2).await;
        let file = Path::new(&repo).join("file.txt");

        let untouched = sides_of(&repo, "file.txt").await;
        assert_eq!(untouched.working_matches_survivor, Some(true));

        // Lossy decodes collide (both "th\u{FFFD}irs\n"), the bytes differ.
        std::fs::write(&file, b"th\xFDirs\n").unwrap();
        let edited = sides_of(&repo, "file.txt").await;
        assert_eq!(edited.working, edited.theirs.clone().unwrap());
        assert_eq!(edited.working_matches_survivor, Some(false));

        std::fs::write(&file, b"th\xFCirs\r\n").unwrap();
        assert_eq!(
            sides_of(&repo, "file.txt").await.working_matches_survivor,
            Some(true),
            "a CRLF-only difference reads unedited"
        );

        std::fs::write(&file, b"th\xFCirs\r\r\n").unwrap();
        assert_eq!(
            sides_of(&repo, "file.txt").await.working_matches_survivor,
            Some(false),
            "\\r\\r\\n normalizes to \\r\\n, which differs from the LF blob"
        );

        std::fs::remove_file(&file).unwrap();
        assert_eq!(
            sides_of(&repo, "file.txt").await.working_matches_survivor,
            None,
            "no verdict without a working file"
        );

        let (_dir2, both) = conflicted_repo("survivor-both", "file.txt", &[]).await;
        assert_eq!(
            sides_of(&both, "file.txt").await.working_matches_survivor,
            None
        );
    }

    fn linked_refusal(path: &str) -> String {
        let shown = crate::git::ops::discard_shown(path);
        format!(
            "invalid argument: Can't resolve the conflict in {shown} — it's reached through a symbolic link or junction. Nothing was changed."
        )
    }

    #[cfg(unix)]
    fn leaf_refusal(path: &str) -> String {
        let shown = crate::git::ops::discard_shown(path);
        format!(
            "invalid argument: Can't resolve the conflict in {shown} — it's a symbolic link. Nothing was changed."
        )
    }

    /// A directory link: a junction on Windows (no privilege needed), a symlink
    /// elsewhere.
    fn directory_link(link: &Path, target: &Path) {
        #[cfg(windows)]
        {
            let made = std::process::Command::new("cmd")
                .args([
                    "/C",
                    "mklink",
                    "/J",
                    &link.to_string_lossy(),
                    &target.to_string_lossy(),
                ])
                .output()
                .expect("run mklink");
            assert!(
                made.status.success(),
                "mklink /J failed: {}",
                String::from_utf8_lossy(&made.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// A conflicted path reached through a linked directory refuses both the
    /// read and the write, and the file it points at keeps its bytes.
    #[tokio::test]
    async fn conflict_commands_refuse_a_linked_ancestor() {
        let (dir, repo) = conflicted_repo("link-ancestor", "sub/file.txt", &[]).await;
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("file.txt");
        std::fs::write(&victim, "precious\n").unwrap();
        std::fs::remove_dir_all(dir.path().join("sub")).unwrap();
        directory_link(&dir.path().join("sub"), outside.path());

        let read = git_conflict_sides(repo.clone(), "sub/file.txt".into(), vec![])
            .await
            .err()
            .expect("a linked ancestor must refuse the read");
        assert_eq!(read.to_string(), linked_refusal("sub/file.txt"));
        let write = git_resolve_conflict_core(
            &AppState::default(),
            repo,
            "sub/file.txt".into(),
            "resolved\n".into(),
            true,
            Some(sha1_hex(b"precious\n")),
        )
        .await
        .unwrap_err();
        assert_eq!(write.to_string(), linked_refusal("sub/file.txt"));
        assert_eq!(std::fs::read(&victim).unwrap(), b"precious\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn conflict_sides_refuse_a_linked_survivor() {
        let (dir, repo) = modify_delete_repo("link-read", "file.txt", "ours").await;
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        std::fs::write(&victim, "precious\n").unwrap();
        std::fs::remove_file(dir.path().join("file.txt")).unwrap();
        std::os::unix::fs::symlink(&victim, dir.path().join("file.txt")).unwrap();
        let error = git_conflict_sides(repo, "file.txt".into(), vec![])
            .await
            .err()
            .expect("a linked survivor must refuse the read");
        assert_eq!(error.to_string(), leaf_refusal("file.txt"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resolve_refuses_a_linked_survivor() {
        let (dir, repo) = modify_delete_repo("link-write", "file.txt", "ours").await;
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        std::fs::write(&victim, "precious\n").unwrap();
        std::fs::remove_file(dir.path().join("file.txt")).unwrap();
        std::os::unix::fs::symlink(&victim, dir.path().join("file.txt")).unwrap();
        let before = stdout_of(&repo, &["ls-files", "-u"]).await;
        let error = git_resolve_conflict_core(
            &AppState::default(),
            repo.clone(),
            "file.txt".into(),
            "resolved\n".into(),
            true,
            Some(sha1_hex(b"precious\n")),
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), leaf_refusal("file.txt"));
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "precious\n");
        assert_eq!(stdout_of(&repo, &["ls-files", "-u"]).await, before);
    }

    /// A dangling link reads as absent through the link, which a `None` hash
    /// would accept: the write would create its target outside the repository.
    #[cfg(unix)]
    #[tokio::test]
    async fn resolve_refuses_a_dangling_link() {
        let (dir, repo) = modify_delete_repo("link-dangling", "file.txt", "ours").await;
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("created.txt");
        std::fs::remove_file(dir.path().join("file.txt")).unwrap();
        std::os::unix::fs::symlink(&target, dir.path().join("file.txt")).unwrap();
        let read = git_conflict_sides(repo.clone(), "file.txt".into(), vec![])
            .await
            .err()
            .expect("a dangling link must refuse the read");
        assert_eq!(read.to_string(), leaf_refusal("file.txt"));
        let error = git_resolve_conflict_core(
            &AppState::default(),
            repo,
            "file.txt".into(),
            "resolved\n".into(),
            true,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(error.to_string(), leaf_refusal("file.txt"));
        assert!(!target.exists(), "the write created the link's target");
    }

    /// Taking a side refuses a linked ancestor before any git call, so neither
    /// the stages nor the file it points at change.
    #[tokio::test]
    async fn checkout_side_refuses_a_linked_ancestor() {
        let (dir, repo) = conflicted_repo("link-ancestor-side", "sub/file.txt", &[]).await;
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("file.txt");
        std::fs::write(&victim, "precious\n").unwrap();
        std::fs::remove_dir_all(dir.path().join("sub")).unwrap();
        directory_link(&dir.path().join("sub"), outside.path());
        let before = stdout_of(&repo, &["ls-files", "-u"]).await;
        assert!(
            before.contains("sub/file.txt"),
            "fixture not conflicted: {before}"
        );

        for side in ["ours", "theirs"] {
            let error = git_checkout_conflict_side_core(
                &AppState::default(),
                repo.clone(),
                "sub/file.txt".into(),
                side.into(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.to_string(), linked_refusal("sub/file.txt"), "{side}");
            assert_eq!(std::fs::read(&victim).unwrap(), b"precious\n", "{side}");
            assert_eq!(
                stdout_of(&repo, &["ls-files", "-u"]).await,
                before,
                "{side}"
            );
        }
    }

    /// Taking the surviving side over a leaf link: git replaces the link with a
    /// regular file holding that side, and the file it pointed at keeps its bytes.
    #[cfg(unix)]
    #[tokio::test]
    async fn checkout_side_replaces_a_leaf_link_with_the_side() {
        let (dir, repo) = modify_delete_repo("link-side-keep", "file.txt", "ours").await;
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        std::fs::write(&victim, "precious\n").unwrap();
        let file = dir.path().join("file.txt");
        std::fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&victim, &file).unwrap();

        git_checkout_conflict_side_core(
            &AppState::default(),
            repo.clone(),
            "file.txt".into(),
            "theirs".into(),
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "precious\n");
        assert!(std::fs::symlink_metadata(&file)
            .unwrap()
            .file_type()
            .is_file());
        assert_eq!(
            std::fs::read_to_string(&file)
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

    /// Taking the deleting side over a leaf link removes the link, never the file
    /// it pointed at.
    #[cfg(unix)]
    #[tokio::test]
    async fn checkout_side_removes_a_leaf_link_for_the_deletion() {
        let (dir, repo) = modify_delete_repo("link-side-delete", "file.txt", "ours").await;
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        std::fs::write(&victim, "precious\n").unwrap();
        let file = dir.path().join("file.txt");
        std::fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&victim, &file).unwrap();

        git_checkout_conflict_side_core(
            &AppState::default(),
            repo.clone(),
            "file.txt".into(),
            "ours".into(),
        )
        .await
        .unwrap();

        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "precious\n");
        assert!(
            std::fs::symlink_metadata(&file).is_err(),
            "the link survived"
        );
        assert_deleted_and_resolved(&repo, "file.txt").await;
    }

    /// A junction AT the conflicted path is refused like a linked ancestor by
    /// every command, side checkout included, and the directory it points at
    /// keeps its contents.
    #[cfg(windows)]
    #[tokio::test]
    async fn conflict_commands_refuse_a_junction_leaf() {
        let (dir, repo) = conflicted_repo("link-junction-leaf", "file.txt", &[]).await;
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim.txt");
        std::fs::write(&victim, "precious\n").unwrap();
        std::fs::remove_file(dir.path().join("file.txt")).unwrap();
        directory_link(&dir.path().join("file.txt"), outside.path());
        let before = stdout_of(&repo, &["ls-files", "-u"]).await;

        let read = git_conflict_sides(repo.clone(), "file.txt".into(), vec![])
            .await
            .err()
            .expect("a junction leaf must refuse the read");
        assert_eq!(read.to_string(), linked_refusal("file.txt"));
        let write = git_resolve_conflict_core(
            &AppState::default(),
            repo.clone(),
            "file.txt".into(),
            "resolved\n".into(),
            true,
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(write.to_string(), linked_refusal("file.txt"));
        for side in ["ours", "theirs"] {
            let error = git_checkout_conflict_side_core(
                &AppState::default(),
                repo.clone(),
                "file.txt".into(),
                side.into(),
            )
            .await
            .unwrap_err();
            assert_eq!(error.to_string(), linked_refusal("file.txt"), "{side}");
        }
        assert_eq!(std::fs::read(&victim).unwrap(), b"precious\n");
        assert_eq!(stdout_of(&repo, &["ls-files", "-u"]).await, before);
    }
}
