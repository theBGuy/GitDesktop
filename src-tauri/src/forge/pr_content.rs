//! Whole-file reads behind a forge pull request's diff: its merge base, a commit's first
//! parent, and one file's bytes at a commit, on GitHub, GitLab and Bitbucket. Each
//! provider arm is a private fn; a command validates, dispatches, and awaits one arm.
//! Also the local `git diff -w` of two file versions those reads returned.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use base64::Engine;
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::forge::bitbucket::workspace_slug;
use crate::forge::gitlab::{encode_project, gl_unreadable, glab_output_is_404, project_path};
use crate::forge::glab::{run_glab, run_glab_raw, GlabOutput, GLAB_NETWORK_TIMEOUT};
use crate::forge::http::{self, bb_unreadable, BbCredentials, BbGetFailure, BbOpKind};
use crate::forge::model::Provider;
use crate::forge::session::{classify_gh_failure, GhFailure};
use crate::forge::{detect_non_github, encode_query_value};
use crate::git::diff::{with_ignore_whitespace, FileBytes};
use crate::git::runner::{run_git_raw, DEFAULT_TIMEOUT};
use crate::github::runner::{run_gh, run_gh_raw, GhOutput, GH_NETWORK_TIMEOUT};
use crate::github::{gh_failure_reason, gh_lens_slug, gh_unreadable, lens_remote};
use crate::image_sniff::{dimensions_within_caps, has_raster_magic, sniff_image};

/// The byte ceiling of one by-sha read, the local preview reader's cap.
const FORGE_FILE_MAX_BYTES: u64 = 20_000_000;

/// The decoded ceiling of one side of a whitespace diff. The frontend sends at most its
/// content budget; this keeps the command safe from any caller.
const WHITESPACE_SIDE_MAX_BYTES: usize = 1_000_000;

/// The folder under the app's per-user cache dir that holds every whitespace diff's
/// private run dir.
const WHITESPACE_DIFF_ROOT: &str = "pr-ws-diff";

/// The run-dir root, set once at startup from the app's per-user cache dir.
static WHITESPACE_ROOT: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// The root is set only at startup, so this holds for the whole session.
const WHITESPACE_ROOT_UNSET: &str =
    "The whitespace diff isn't available because GitDesktop couldn't open its cache folder.";

/// A run dir idle this long outlived its run (a failed close) and is swept.
const WHITESPACE_RUN_STALE_AFTER: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrContentRevs {
    /// Old side: the pull request's merge base. Full-length oid.
    pub old_sha: String,
    /// New side: the head the caller passed, echoed.
    pub new_sha: String,
}

/// The merge base and head a pull request's whole-file reads pair. The head is the
/// caller's (Bitbucket's PR object abbreviates its hashes); only the old side is read.
#[tauri::command]
pub async fn forge_pr_content_revs(
    repo_path: String,
    number: u64,
    lens: Option<String>,
    head_sha: String,
    base_ref: Option<String>,
    base_sha: Option<String>,
) -> AppResult<PrContentRevs> {
    lens_remote(lens.as_deref())?;
    full_sha(&head_sha)?;
    if let Some(base) = &base_sha {
        full_sha(base)?;
    }
    let (base_ref, base_sha) = (base_ref.as_deref(), base_sha.as_deref());
    let old_sha = match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            gitlab_merge_base(&repo_path, number, &head_sha, base_ref, base_sha).await?
        }
        Some((Provider::Bitbucket, _)) => {
            let creds = http::load_credentials().await?;
            bitbucket_merge_base(&creds, &repo_path, number, &head_sha, base_ref).await?
        }
        _ => {
            let target = TargetBase { base_ref, base_sha };
            github_merge_base(&repo_path, number, lens.as_deref(), &head_sha, target).await?
        }
    };
    Ok(PrContentRevs {
        old_sha,
        new_sha: head_sha,
    })
}

/// What a pull request diff read proved about its text: the diff of the caller's head
/// against its base, a text no read could tie to them, or the forge naming another
/// head or base (the text is then dropped).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HeadProof {
    Proven,
    Unproven,
    Moved,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDiffAt {
    /// The unified diff, capped like `forge_pr_diff`; empty when `head_proof` is moved.
    pub diff: String,
    pub head_proof: HeadProof,
}

fn diff_at(diff: String, head_proof: HeadProof) -> PrDiffAt {
    PrDiffAt {
        diff: if head_proof == HeadProof::Moved {
            String::new()
        } else {
            diff
        },
        head_proof,
    }
}

/// A pull request's diff tied to the head and base the caller's details named.
/// `base_ref` is only compared with the forge's answer, never put in a path or argv.
#[tauri::command]
pub async fn forge_pr_diff_at(
    repo_path: String,
    number: u64,
    lens: Option<String>,
    head_sha: String,
    base_ref: String,
    base_sha: Option<String>,
) -> AppResult<PrDiffAt> {
    lens_remote(lens.as_deref())?;
    full_sha(&head_sha)?;
    if let Some(base) = &base_sha {
        full_sha(base)?;
    }
    let base_sha = base_sha.as_deref();
    let (diff, proof) = match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => {
            Box::pin(crate::forge::gitlab::diff_pr_at(
                &repo_path, number, &head_sha, &base_ref, base_sha,
            ))
            .await?
        }
        Some((Provider::Bitbucket, _)) => {
            Box::pin(bitbucket_diff_at(&repo_path, number, &head_sha, &base_ref)).await?
        }
        _ => {
            Box::pin(github_diff_at(
                &repo_path,
                number,
                lens.as_deref(),
                &head_sha,
                &base_ref,
                base_sha,
            ))
            .await?
        }
    };
    Ok(diff_at(diff, proof))
}

/// Whether a fresh read of the pull request ties an unproven text to the head and base
/// the caller's details named, judged per axis like the diff read's own re-read. A
/// failed or unreadable read is unproven; only a bad argument is an error.
#[tauri::command]
pub async fn forge_pr_head_proof(
    repo_path: String,
    number: u64,
    lens: Option<String>,
    head_sha: String,
    base_ref: String,
    base_sha: Option<String>,
) -> AppResult<HeadProof> {
    lens_remote(lens.as_deref())?;
    full_sha(&head_sha)?;
    if let Some(base) = &base_sha {
        full_sha(base)?;
    }
    let provider = detect_non_github(&repo_path)
        .await
        .map(|(provider, _)| provider);
    let read = |provider: Option<Provider>| async move {
        match provider {
            Some(Provider::GitLab) => Box::pin(gitlab_mr(&repo_path, number)).await,
            Some(Provider::Bitbucket) => {
                Box::pin(async {
                    let (creds, base) = bb_session(&repo_path).await?;
                    bitbucket_pr(&creds, &base, number).await
                })
                .await
            }
            _ => {
                Box::pin(async {
                    let slug = gh_lens_slug(&repo_path, lens.as_deref()).await?;
                    github_pr(&repo_path, &slug, number).await
                })
                .await
            }
        }
    };
    Ok(head_proof_at(provider, &head_sha, &base_ref, base_sha.as_deref(), read).await)
}

/// [`forge_pr_head_proof`]'s per-forge dispatch over its read: `read` fetches the
/// provider's pull request, and that forge's rule judges it.
async fn head_proof_at<F, Fut>(
    provider: Option<Provider>,
    head: &str,
    base_ref: &str,
    base_sha: Option<&str>,
    read: F,
) -> HeadProof
where
    F: FnOnce(Option<Provider>) -> Fut,
    Fut: std::future::Future<Output = AppResult<Value>>,
{
    let pr = read(provider).await;
    match provider {
        Some(Provider::GitLab) => {
            crate::forge::gitlab::gl_head_read_proof(&pr, head, base_ref, base_sha)
        }
        Some(Provider::Bitbucket) => bb_reread_proof(&pr, head, base_ref),
        _ => gh_reread_proof(&pr, head, base_ref, base_sha),
    }
}

/// The one per-axis rule every head proof shares. Each axis is Some(moved) from readable
/// evidence or None when it can't be read: a readable contradiction on any axis is
/// movement, even beside unreadable ones; proven needs every required axis readable.
/// A contradiction-only axis never proves and never blocks.
pub(crate) fn head_proof_verdict(
    required: &[Option<bool>],
    contradiction_only: &[Option<bool>],
) -> HeadProof {
    if required
        .iter()
        .chain(contradiction_only)
        .any(|axis| *axis == Some(true))
    {
        HeadProof::Moved
    } else if required.contains(&None) {
        HeadProof::Unproven
    } else {
        HeadProof::Proven
    }
}

/// First parent of `oid`; None = a root commit.
#[tauri::command]
pub async fn forge_commit_first_parent(
    repo_path: String,
    oid: String,
    lens: Option<String>,
) -> AppResult<Option<String>> {
    lens_remote(lens.as_deref())?;
    full_sha(&oid)?;
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab_first_parent(&repo_path, &oid).await,
        Some((Provider::Bitbucket, _)) => {
            let creds = http::load_credentials().await?;
            bitbucket_first_parent(&creds, &repo_path, &oid).await
        }
        _ => github_first_parent(&repo_path, lens.as_deref(), &oid).await,
    }
}

/// One file's bytes at a commit, from the forge. None = the path does not exist at that commit.
#[tauri::command]
pub async fn forge_file_at_sha(
    repo_path: String,
    sha: String,
    file_path: String,
    lens: Option<String>,
    max_bytes: Option<u64>,
) -> AppResult<Option<FileBytes>> {
    lens_remote(lens.as_deref())?;
    full_sha(&sha)?;
    let segments = file_segments(&file_path)?;
    let cap = effective_cap(max_bytes);
    match detect_non_github(&repo_path).await {
        Some((Provider::GitLab, _)) => gitlab_file(&repo_path, &sha, &file_path, cap).await,
        Some((Provider::Bitbucket, _)) => {
            let creds = http::load_credentials().await?;
            bitbucket_file(&creds, &repo_path, &sha, &file_path, &segments, cap).await
        }
        _ => {
            github_file(
                &repo_path,
                lens.as_deref(),
                &sha,
                &file_path,
                &segments,
                cap,
            )
            .await
        }
    }
}

/// The `-w` diff of two file versions held in memory, hunks only.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhitespaceHunks {
    /// From the first `@@` line on; empty when the versions differ in whitespace only, or not at all.
    pub hunks: String,
    /// git called the pair binary; `hunks` is empty.
    pub is_binary: bool,
}

/// Stores `<cache_dir>/pr-ws-diff` in `cell`; a second call keeps the first root.
fn init_whitespace_root_in(cell: &std::sync::OnceLock<PathBuf>, cache_dir: &Path) {
    let root = cache_dir.join(WHITESPACE_DIFF_ROOT);
    let root = std::path::absolute(&root).unwrap_or(root);
    let _ = cell.set(root);
}

/// Called from the app's setup with the per-user cache dir, beside the image-staging root.
pub(crate) fn init_whitespace_root(cache_dir: &Path) {
    init_whitespace_root_in(&WHITESPACE_ROOT, cache_dir);
}

/// Never a shared-dir fallback: an unset root refuses, and the frontend shows the forge diff.
fn whitespace_root_in(cell: &std::sync::OnceLock<PathBuf>) -> AppResult<PathBuf> {
    cell.get()
        .cloned()
        .ok_or_else(|| AppError::Command(WHITESPACE_ROOT_UNSET.to_string()))
}

/// `git diff -w` of two file versions the frontend already holds, as base64; None = no
/// file at that side, diffed as an empty one. A local run over private files in the app's
/// cache dir, with the user's git config applied, so line endings and blank context lines
/// vary.
#[tauri::command]
pub async fn git_diff_bytes_ignoring_whitespace(
    old_base64: Option<String>,
    new_base64: Option<String>,
) -> AppResult<WhitespaceHunks> {
    let (old, new) = whitespace_sides(old_base64.as_deref(), new_base64.as_deref())?;
    let root = whitespace_root_in(&WHITESPACE_ROOT)?;
    sweep_stale_runs_once(root.clone()).await;
    whitespace_diff_in(root, old, new).await
}

/// The `-w` diff of two decoded sides, run in a fresh run dir under `root`.
async fn whitespace_diff_in(
    root: PathBuf,
    old: Vec<u8>,
    new: Vec<u8>,
) -> AppResult<WhitespaceHunks> {
    let args = with_ignore_whitespace(
        &["diff", "--no-ext-diff", "--no-index", "--no-color"],
        Some(true),
    );
    let stdout = diff_written_pair(root, &args, old, new).await?;
    Ok(whitespace_hunks(&stdout))
}

/// Once per process, off the async runtime, before its first run: removes run dirs a
/// failed close left behind. The sweep never reads through a linked or foreign root.
async fn sweep_stale_runs_once(root: PathBuf) {
    static SWEPT: std::sync::Once = std::sync::Once::new();
    if SWEPT.is_completed() {
        return;
    }
    let _ = tokio::task::spawn_blocking(move || {
        SWEPT.call_once(|| sweep_stale_runs(&root, SystemTime::now()));
    })
    .await;
}

fn sweep_stale_runs(root: &Path, now: SystemTime) {
    crate::attachments::sweep_stale_in(root, now, WHITESPACE_RUN_STALE_AFTER);
}

// ── Validation and shared pieces ─────────────────────────────────────────────

/// Both sides decoded and size-checked before anything is written; None = empty.
fn whitespace_sides(old: Option<&str>, new: Option<&str>) -> AppResult<(Vec<u8>, Vec<u8>)> {
    if old.is_none() && new.is_none() {
        return Err(AppError::InvalidArgument(
            "a whitespace diff needs at least one side".into(),
        ));
    }
    Ok((whitespace_side(old, "old")?, whitespace_side(new, "new")?))
}

fn whitespace_side(side: Option<&str>, name: &str) -> AppResult<Vec<u8>> {
    let Some(encoded) = side else {
        return Ok(Vec::new());
    };
    let over = || {
        AppError::InvalidArgument(format!(
            "the {name} side is over {WHITESPACE_SIDE_MAX_BYTES} bytes"
        ))
    };
    // The estimate counts a partial last quad as three bytes; any valid last quad
    // decodes to at least one, so past the cap by more than two is over before decoding.
    if base64::decoded_len_estimate(encoded.len()).saturating_sub(2) > WHITESPACE_SIDE_MAX_BYTES {
        return Err(over());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| AppError::InvalidArgument(format!("the {name} side is not base64: {e}")))?;
    if bytes.len() > WHITESPACE_SIDE_MAX_BYTES {
        return Err(over());
    }
    Ok(bytes)
}

/// `--no-index` exits 1 when the files differ, and also when it can't read one (an
/// `error:` on stderr, nothing on stdout), so an exit 1 counts only with a diff line
/// printed. Any other code is a failure, the -1 of a git killed by a signal included.
fn no_index_diff_ok(code: i32, stdout: &[u8]) -> bool {
    match code {
        0 => true,
        1 => stdout.split(|&b| b == b'\n').any(|line| {
            line.starts_with(b"diff --git ")
                || line.starts_with(b"@@ ")
                || line.starts_with(b"Binary files ")
        }),
        _ => false,
    }
}

/// A fresh run dir in `root`, named 32 lowercase hex (the shape the stale sweep
/// removes). `root` (and its parent) is created when missing, the root owner-only, and
/// refused unless it is a real directory only this user can enter: a linked or foreign
/// root would let someone else read or swap the files git diffs.
fn private_run_dir(root: &Path) -> std::io::Result<tempfile::TempDir> {
    if let Some(parent) = root.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    let folder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut folder = std::fs::DirBuilder::new();
        folder.mode(0o700);
        folder
    };
    #[cfg(not(unix))]
    let folder = std::fs::DirBuilder::new();
    match folder.create(root) {
        Err(e) if e.kind() != std::io::ErrorKind::AlreadyExists => return Err(e),
        _ => {}
    }
    // On Windows this verifies only a real, unlinked directory: the root lives in the
    // per-user app cache dir, whose profile ACL admits no other ordinary account (the
    // attachments root's model), and the run dir and its files inherit that ACL.
    if !crate::attachments::root_is_private(root)? {
        return Err(std::io::Error::other(format!(
            "the whitespace diff folder isn't private: {}",
            root.display()
        )));
    }
    let name = uuid::Uuid::new_v4().simple().to_string();
    let mut run = tempfile::Builder::new();
    run.prefix(&name).rand_bytes(0);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        run.permissions(std::fs::Permissions::from_mode(0o700));
    }
    run.tempdir_in(root)
}

/// A path as git's `&str` argv takes it: a lossy spelling would name another file.
fn utf8_arg(path: &Path) -> AppResult<&str> {
    path.to_str().ok_or_else(|| {
        AppError::Io(std::io::Error::other(format!(
            "the temp path isn't UTF-8: {}",
            path.display()
        )))
    })
}

/// Runs `args` then `-- <old> <new>`.
async fn no_index_diff(args: &[&str], old: &Path, new: &Path) -> AppResult<Vec<u8>> {
    let mut argv = args.to_vec();
    argv.extend(["--", utf8_arg(old)?, utf8_arg(new)?]);
    let out = run_git_raw(None, &argv, DEFAULT_TIMEOUT).await?;
    if !no_index_diff_ok(out.code, &out.stdout) {
        let text = out.full_failure_text();
        return Err(AppError::Git {
            code: out.code,
            stderr: if text.is_empty() {
                "git diff printed no diff".into()
            } else {
                text
            },
        });
    }
    Ok(out.stdout)
}

/// [`no_index_diff`] over the two buffers written into a fresh run dir in `root`, which
/// is closed on every path; a dir that fails to close is left to the stale sweep.
async fn diff_written_pair(
    root: PathBuf,
    args: &[&str],
    old: Vec<u8>,
    new: Vec<u8>,
) -> AppResult<Vec<u8>> {
    let dir = tokio::task::spawn_blocking(move || private_run_dir(&root))
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
        .map_err(AppError::Io)?;
    let old_path = dir.path().join("old");
    let new_path = dir.path().join("new");
    let result = async {
        tokio::fs::write(&old_path, &old)
            .await
            .map_err(AppError::Io)?;
        tokio::fs::write(&new_path, &new)
            .await
            .map_err(AppError::Io)?;
        no_index_diff(args, &old_path, &new_path).await
    }
    .await;
    match tokio::task::spawn_blocking(move || dir.close()).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => eprintln!("gitdesktop: whitespace diff temp dir not removed: {e}"),
        Err(e) => eprintln!("gitdesktop: whitespace diff temp dir cleanup failed: {e}"),
    }
    result
}

/// The hunks of one file's `git diff`, from its first `@@ ` line on: the header, which
/// names the temp paths, never leaves Rust.
fn whitespace_hunks(stdout: &[u8]) -> WhitespaceHunks {
    let mut is_binary = false;
    let mut offset = 0;
    let mut start = None;
    for line in stdout.split_inclusive(|&b| b == b'\n') {
        if line.starts_with(b"@@ ") {
            start = Some(offset);
            break;
        }
        let text = line.trim_ascii_end();
        if text.starts_with(b"Binary files ") && text.ends_with(b" differ") {
            is_binary = true;
        }
        offset += line.len();
    }
    let hunks = match start {
        Some(at) if !is_binary => String::from_utf8_lossy(&stdout[at..]).into_owned(),
        _ => String::new(),
    };
    WhitespaceHunks { hunks, is_binary }
}

pub(crate) fn is_full_sha(sha: &str) -> bool {
    matches!(sha.len(), 40 | 64) && sha.bytes().all(|b| b.is_ascii_hexdigit())
}

fn full_sha(sha: &str) -> AppResult<()> {
    if is_full_sha(sha) {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(format!(
            "expected a full commit sha: {sha}"
        )))
    }
}

/// The path's `/`-separated segments. Beyond `is_repo_relative`, an empty or `.` segment
/// is refused too: git never lists one, and a forge URL would normalize it away.
fn file_segments(path: &str) -> AppResult<Vec<&str>> {
    let segments: Vec<&str> = path.split('/').collect();
    if path.is_empty()
        || !crate::git::diff::is_repo_relative(path)
        || segments.iter().any(|s| s.is_empty() || *s == ".")
    {
        return Err(AppError::InvalidArgument(format!(
            "invalid file path: {path}"
        )));
    }
    Ok(segments)
}

fn effective_cap(max_bytes: Option<u64>) -> u64 {
    max_bytes
        .unwrap_or(FORGE_FILE_MAX_BYTES)
        .min(FORGE_FILE_MAX_BYTES)
}

/// Each segment percent-encoded on its own; an encoded `{` also keeps gh from reading
/// the endpoint as a placeholder.
fn encode_segments(segments: &[&str]) -> String {
    segments
        .iter()
        .map(|s| encode_query_value(s))
        .collect::<Vec<_>>()
        .join("/")
}

/// A full sha at `pointer`, never an abbreviation or a guessed default.
pub(crate) fn sha_at(value: &Value, pointer: &str) -> Option<String> {
    value
        .pointer(pointer)?
        .as_str()
        .filter(|sha| is_full_sha(sha))
        .map(str::to_string)
}

/// The first entry of the parent list at `list`: a sha string (GitLab's `parent_ids`)
/// or an object carrying it under `field`. An empty list is a root commit; a missing
/// list or an unreadable first entry is an error, never "root".
fn first_parent(value: &Value, list: &str, field: Option<&str>) -> Result<Option<String>, String> {
    let parents = value
        .pointer(list)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("no parent list at {list}"))?;
    let Some(first) = parents.first() else {
        return Ok(None);
    };
    let sha = match field {
        Some(field) => first.get(field),
        None => Some(first),
    };
    sha.and_then(Value::as_str)
        .filter(|sha| is_full_sha(sha))
        .map(|sha| Some(sha.to_string()))
        .ok_or_else(|| "the first parent isn't a full sha".to_string())
}

fn too_large(size: u64) -> FileBytes {
    FileBytes {
        base64: None,
        mime: None,
        too_large: true,
        size: Some(size),
    }
}

/// The twin of git/diff.rs `finish_preview` over forge bytes, under the caller's cap
/// (at most that reader's 20 MB): over the cap is refused with the producer's size, a
/// sniffable raster past the dimension caps or raster magic with an unreadable header
/// is refused, and everything else (text, SVG, BMP, ICO) ships base64 with its size.
fn finish_forge_bytes(bytes: Vec<u8>, cap: u64, size: Option<u64>) -> FileBytes {
    if bytes.len() as u64 > cap {
        return FileBytes {
            base64: None,
            mime: None,
            too_large: true,
            size,
        };
    }
    let sniffed = sniff_image(&bytes);
    let refuse = match sniffed {
        Some((_, width, height)) => !dimensions_within_caps(width, height),
        None => has_raster_magic(&bytes),
    };
    if refuse {
        return FileBytes {
            base64: None,
            mime: sniffed.map(|(media_type, _, _)| media_type.to_string()),
            too_large: true,
            size: None,
        };
    }
    FileBytes {
        base64: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        mime: sniffed.map(|(media_type, _, _)| media_type.to_string()),
        too_large: false,
        size: Some(bytes.len() as u64),
    }
}

/// `git merge-base` over two local commits; no common ancestor is an error.
async fn local_merge_base(repo: &str, a: &str, b: &str) -> AppResult<String> {
    let out = run_git_raw(Some(repo), &["merge-base", a, b], DEFAULT_TIMEOUT).await?;
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.code == 0 && is_full_sha(&sha) {
        return Ok(sha);
    }
    let stderr = out.stderr.trim();
    Err(AppError::Git {
        code: out.code,
        stderr: if stderr.is_empty() {
            "these commits share no merge base".into()
        } else {
            stderr.to_string()
        },
    })
}

// ── GitHub ───────────────────────────────────────────────────────────────────

async fn gh_json(repo: &str, endpoint: &str, what: &str) -> AppResult<Value> {
    let out = run_gh(Some(repo), &["api", endpoint], GH_NETWORK_TIMEOUT).await?;
    serde_json::from_slice(&out.stdout).map_err(|e| gh_unreadable(what, e.to_string()))
}

/// The base the caller's details named for the pull request.
#[derive(Clone, Copy)]
struct TargetBase<'a> {
    base_ref: Option<&'a str>,
    base_sha: Option<&'a str>,
}

/// The caller's base sha, else the re-read PR's base sha while its base branch is the
/// caller's; then the merge base of it and the head: local when both commits are, else
/// the base repo's compare by sha (it holds a fork PR's head as its pull ref).
async fn github_merge_base(
    repo: &str,
    number: u64,
    lens: Option<&str>,
    head: &str,
    target: TargetBase<'_>,
) -> AppResult<String> {
    let slug = gh_lens_slug(repo, lens).await?;
    let base = match target.base_sha {
        Some(sha) => sha.to_string(),
        None => gh_live_base_outcome(&github_pr(repo, &slug, number).await?, target.base_ref)?,
    };
    let both = vec![base.clone(), head.to_string()];
    let present = matches!(
        crate::git::compare::git_objects_present(repo.to_string(), both).await,
        Ok(true)
    );
    let endpoint = format!("{}?per_page=1", github_compare_path(&slug, &base, head)?);
    let compare = async {
        let compare = gh_json(repo, &endpoint, "the comparison").await?;
        sha_at(&compare, "/merge_base_commit/sha")
            .ok_or_else(|| gh_unreadable("the comparison", "its merge base sha is missing".into()))
    };
    merge_base_local_first(repo, &base, head, present, compare).await
}

/// The re-read PR's base sha, only when it names the caller's base branch: the branch is
/// then the caller's one base identity, so a retarget or an unnamed branch refuses.
fn gh_live_base_outcome(pr: &Value, base_ref: Option<&str>) -> AppResult<String> {
    let base = sha_at(pr, "/base/sha")
        .ok_or_else(|| gh_unreadable("the pull request", "its base sha is missing".into()))?;
    let live_ref = pr
        .pointer("/base/ref")
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty());
    match (live_ref, base_ref) {
        (_, None) => Ok(base),
        (Some(live), Some(want)) if live == want => Ok(base),
        (Some(live), Some(want)) => Err(AppError::Gh(format!(
            "this pull request now targets {live}, not {want}."
        ))),
        (None, Some(_)) => Err(gh_unreadable(
            "the pull request",
            "its base branch is missing".into(),
        )),
    }
}

async fn github_pr(repo: &str, slug: &str, number: u64) -> AppResult<Value> {
    gh_json(
        repo,
        &format!("repos/{slug}/pulls/{number}"),
        "the pull request",
    )
    .await
}

/// The base repo's three-dot comparison of two commits, the one builder of that path.
/// With the caller's base sha the diff text and the content revs compare the same pair;
/// without it, each reads the PR's base sha while its base branch is the caller's.
fn github_compare_path(slug: &str, base: &str, head: &str) -> AppResult<String> {
    full_sha(base)?;
    full_sha(head)?;
    Ok(format!("repos/{slug}/compare/{base}...{head}"))
}

/// The webview's diff ceiling, `gh_pr_diff`'s cap, measured on the decoded text. A
/// compare text past it is not served; the by-number read answers, cut at the same cap.
const PR_DIFF_CAP: usize = 2_000_000;

const GH_DIFF_ACCEPT: &str = "Accept: application/vnd.github.diff";

/// Distinct over-cap comparisons remembered before the memo starts over.
const OVER_CAP_MEMO_MAX: usize = 256;

/// Comparisons whose diff measured over the cap. A verdict over two immutable commits
/// and a constant cap, so it needs no expiry or auth epoch.
static OVER_CAP: std::sync::LazyLock<std::sync::Mutex<OverCapMemo>> =
    std::sync::LazyLock::new(Default::default);

#[derive(Debug, PartialEq)]
enum ComparePlan {
    Compare,
    Skip,
}

#[derive(Debug, Default)]
struct OverCapMemo(std::collections::HashSet<(String, String, String)>);

impl OverCapMemo {
    fn key(slug: &str, base: &str, head: &str) -> (String, String, String) {
        (
            slug.to_string(),
            base.to_ascii_lowercase(),
            head.to_ascii_lowercase(),
        )
    }

    fn plan(&self, slug: &str, base: &str, head: &str) -> ComparePlan {
        if self.0.contains(&Self::key(slug, base, head)) {
            ComparePlan::Skip
        } else {
            ComparePlan::Compare
        }
    }

    fn note(&mut self, slug: &str, base: &str, head: &str) {
        let key = Self::key(slug, base, head);
        if self.0.len() >= OVER_CAP_MEMO_MAX && !self.0.contains(&key) {
            self.0.clear();
        }
        self.0.insert(key);
    }
}

fn lock_memo(memo: &std::sync::Mutex<OverCapMemo>) -> std::sync::MutexGuard<'_, OverCapMemo> {
    memo.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Debug, PartialEq)]
enum CompareAnswer {
    Text(String),
    /// The by-number diff can still answer when the compare exceeds the cap or is refused.
    NotAddressable,
}

/// Only an exit-0 body over the cap is noted in `memo`. A refusal can depend on the
/// account or the forge.
fn gh_compare_outcome(
    result: AppResult<GhOutput>,
    memo: &mut OverCapMemo,
    slug: &str,
    base: &str,
    head: &str,
) -> AppResult<CompareAnswer> {
    let out = result?;
    if out.code == 0 {
        // The lossy decode can grow the text (an invalid byte becomes a 3-byte U+FFFD).
        let text = out.stdout_lossy();
        if text.len() > PR_DIFF_CAP {
            memo.note(slug, base, head);
            return Ok(CompareAnswer::NotAddressable);
        }
        return Ok(CompareAnswer::Text(text));
    }
    match classify_gh_failure(&out.stderr) {
        GhFailure::NotFound | GhFailure::Answered => Ok(CompareAnswer::NotAddressable),
        GhFailure::RateLimited | GhFailure::Transport => Err(AppError::Gh(gh_failure_reason(&out))),
    }
}

/// A re-read pull request against the caller's head, base branch and base sha, each read
/// on its own: any readable mismatch is another comparison, even beside a field it can't
/// read; proven needs both shas, and the base branch when the caller has no base sha.
fn gh_reread_proof(
    pr: &AppResult<Value>,
    head: &str,
    base_ref: &str,
    base_sha: Option<&str>,
) -> HeadProof {
    let Ok(pr) = pr else {
        return HeadProof::Unproven;
    };
    // Each check: Some(moved) from readable evidence, None when it can't be read.
    let head_check = sha_at(pr, "/head/sha").map(|sha| !sha.eq_ignore_ascii_case(head));
    let base_check = sha_at(pr, "/base/sha")
        .map(|sha| base_sha.is_some_and(|want| !sha.eq_ignore_ascii_case(want)));
    let ref_check = pr
        .pointer("/base/ref")
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty())
        .map(|r| r != base_ref);
    if base_sha.is_none() {
        head_proof_verdict(&[head_check, base_check, ref_check], &[])
    } else {
        head_proof_verdict(&[head_check, base_check], &[ref_check])
    }
}

/// Use the by-number diff and re-read the PR when there is no compare base, the diff
/// exceeds the cap, or GitHub refuses the compare. Rate limits and transport failures
/// return their error.
async fn github_diff_at(
    repo: &str,
    number: u64,
    lens: Option<&str>,
    head: &str,
    base_ref: &str,
    base_sha: Option<&str>,
) -> AppResult<(String, HeadProof)> {
    let slug = gh_lens_slug(repo, lens).await?;
    let slug = slug.as_str();
    gh_diff_at_from(
        head,
        base_ref,
        base_sha,
        || github_pr(repo, slug, number),
        |base| {
            gh_compare_at(&OVER_CAP, slug, base, head, |path| async move {
                run_gh_raw(
                    Some(repo),
                    &["api", "-H", GH_DIFF_ACCEPT, &path],
                    GH_NETWORK_TIMEOUT,
                )
                .await
            })
        },
        || crate::github::pr::gh_pr_diff(repo.to_string(), number, lens.map(str::to_string)),
    )
    .await
}

/// One compare of `base...head` in `slug` through `run`, which answers the compare path:
/// a pair `memo` holds as over the cap is not asked again.
async fn gh_compare_at<R, RF>(
    memo: &std::sync::Mutex<OverCapMemo>,
    slug: &str,
    base: String,
    head: &str,
    run: R,
) -> AppResult<CompareAnswer>
where
    R: FnOnce(String) -> RF,
    RF: std::future::Future<Output = AppResult<GhOutput>>,
{
    if lock_memo(memo).plan(slug, &base, head) == ComparePlan::Skip {
        return Ok(CompareAnswer::NotAddressable);
    }
    let path = github_compare_path(slug, &base, head)?;
    let result = run(path).await;
    gh_compare_outcome(result, &mut lock_memo(memo), slug, &base, head)
}

/// [`github_diff_at`] over its reads: `read_pr` answers the pull request, `compare` the
/// base repo's diff of a base sha and the head, `by_number` the PR's own diff, capped.
/// Without the caller's base sha (a gh older than 2.63.0 names none), a PR read naming
/// the caller's head and base branch gives the compare its base sha, so the text carries
/// the head's identity either way; any other read keeps the by-number path.
async fn gh_diff_at_from<P, PF, C, CF, N, NF>(
    head: &str,
    base_ref: &str,
    base_sha: Option<&str>,
    read_pr: P,
    compare: C,
    by_number: N,
) -> AppResult<(String, HeadProof)>
where
    P: Fn() -> PF,
    PF: std::future::Future<Output = AppResult<Value>>,
    C: FnOnce(String) -> CF,
    CF: std::future::Future<Output = AppResult<CompareAnswer>>,
    N: FnOnce() -> NF,
    NF: std::future::Future<Output = AppResult<String>>,
{
    let compare_base = match base_sha {
        Some(base) => Some(base.to_string()),
        None => gh_compare_base(&read_pr().await, head, base_ref),
    };
    if let Some(base) = compare_base {
        if let CompareAnswer::Text(text) = compare(base).await? {
            return Ok((text, HeadProof::Proven));
        }
    }
    let diff = by_number().await?;
    let pr = read_pr().await;
    Ok((diff, gh_reread_proof(&pr, head, base_ref, base_sha)))
}

/// The read PR's base sha, only when the read names the caller's head and its base
/// branch is the caller's; a failed read or any other answer gives none.
fn gh_compare_base(pr: &AppResult<Value>, head: &str, base_ref: &str) -> Option<String> {
    let pr = pr.as_ref().ok()?;
    let names_head = sha_at(pr, "/head/sha").is_some_and(|sha| sha.eq_ignore_ascii_case(head));
    names_head
        .then(|| gh_live_base_outcome(pr, Some(base_ref)).ok())
        .flatten()
}

/// The local merge base when the clone holds both commits, is measured not shallow and
/// can answer, else the forge's: past a shallow boundary git can answer an older common
/// ancestor as readily as none.
async fn merge_base_local_first(
    repo: &str,
    base: &str,
    head: &str,
    present: bool,
    forge: impl std::future::Future<Output = AppResult<String>>,
) -> AppResult<String> {
    if present && matches!(is_shallow(repo).await, Ok(false)) {
        if let Ok(sha) = local_merge_base(repo, base, head).await {
            return Ok(sha);
        }
    }
    forge.await
}

/// git's own shallowness answer; anything but "true" or "false" is an error.
async fn is_shallow(repo: &str) -> AppResult<bool> {
    let out = run_git_raw(
        Some(repo),
        &["rev-parse", "--is-shallow-repository"],
        DEFAULT_TIMEOUT,
    )
    .await?;
    match (out.code, String::from_utf8_lossy(&out.stdout).trim()) {
        (0, "true") => Ok(true),
        (0, "false") => Ok(false),
        _ => Err(AppError::Git {
            code: out.code,
            stderr: out.full_failure_text(),
        }),
    }
}

async fn github_first_parent(
    repo: &str,
    lens: Option<&str>,
    oid: &str,
) -> AppResult<Option<String>> {
    let slug = gh_lens_slug(repo, lens).await?;
    let commit = gh_json(
        repo,
        &format!("repos/{slug}/git/commits/{oid}"),
        "the commit",
    )
    .await?;
    first_parent(&commit, "/parents", Some("sha")).map_err(|e| gh_unreadable("the commit", e))
}

/// A gh read's verdict: Some(body) on exit 0, None for a not-found answer the caller
/// must confirm, and every other failure (rate limit, transport, any other answer) Err.
fn gh_read_outcome(result: AppResult<GhOutput>) -> AppResult<Option<GhOutput>> {
    let out = result?;
    if out.code == 0 {
        return Ok(Some(out));
    }
    match classify_gh_failure(&out.stderr) {
        GhFailure::NotFound => Ok(None),
        GhFailure::RateLimited | GhFailure::Transport | GhFailure::Answered => {
            Err(AppError::Gh(gh_failure_reason(&out)))
        }
    }
}

/// A commit lookup's verdict: a not-found commit is an error, never an absent file.
fn gh_commit_outcome(result: AppResult<GhOutput>, sha: &str) -> AppResult<()> {
    match gh_read_outcome(result)? {
        Some(_) => Ok(()),
        None => Err(AppError::Gh(format!("GitHub doesn't have commit {sha}."))),
    }
}

#[derive(serde::Deserialize)]
struct GhContents {
    #[serde(rename = "type", default)]
    kind: Option<String>,
    #[serde(default)]
    size: Option<u64>,
    #[serde(default)]
    encoding: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    sha: Option<String>,
}

#[derive(Debug, PartialEq)]
enum GhPlan {
    /// The bytes came inline (base64 up to 1 MB, or a link's target text), with their
    /// declared size and the blob id the answer names.
    Bytes(Vec<u8>, u64, String),
    TooLarge(u64),
    /// Past the inline limit: read the body through the raw media type.
    Raw(u64, String),
    /// A directory or a submodule: no file at that path.
    Absent,
}

/// The contents answer's body. A directory answers as the array of its entries, which
/// is no file there; an array that isn't the requested path's listing is an error.
fn gh_contents_body(stdout: &[u8], requested: &str) -> AppResult<Option<GhContents>> {
    let unreadable = |detail: String| gh_unreadable("the file", detail);
    // An object parses typed, so serde still refuses a duplicated field.
    if stdout.iter().find(|b| !b" \t\r\n".contains(b)) != Some(&b'[') {
        return serde_json::from_slice(stdout)
            .map(Some)
            .map_err(|e| unreadable(e.to_string()));
    }
    let entries: Vec<Value> =
        serde_json::from_slice(stdout).map_err(|e| unreadable(e.to_string()))?;
    let listed = !entries.is_empty()
        && entries.iter().all(|entry| {
            (entry.get("path").and_then(Value::as_str))
                .and_then(|path| path.strip_prefix(requested)?.strip_prefix('/'))
                .is_some_and(|child| !child.is_empty() && !child.contains('/'))
        });
    if !listed {
        return Err(unreadable("the answer lists another directory".into()));
    }
    Ok(None)
}

/// The contents answer as a plan. An answer for another path is an error, never that
/// other content; a directory or submodule there is no file.
fn gh_contents_plan(contents: GhContents, requested: &str, cap: u64) -> AppResult<GhPlan> {
    let unreadable = |detail: &str| gh_unreadable("the file", detail.to_string());
    if contents.path.as_deref() != Some(requested) {
        return Err(unreadable("the answer names another path"));
    }
    let blob = || {
        contents
            .sha
            .clone()
            .filter(|sha| is_full_sha(sha))
            .ok_or_else(|| unreadable("its blob id is missing"))
    };
    match contents.kind.as_deref() {
        Some("symlink") => {
            let blob = blob()?;
            let target = contents
                .target
                .ok_or_else(|| unreadable("the link's target is missing"))?;
            let len = target.len() as u64;
            Ok(GhPlan::Bytes(target.into_bytes(), len, blob))
        }
        Some("file") => {
            let blob = blob()?;
            let size = contents
                .size
                .ok_or_else(|| unreadable("its size is missing"))?;
            if size > cap {
                return Ok(GhPlan::TooLarge(size));
            }
            match (contents.encoding.as_deref(), contents.content) {
                (Some("base64"), Some(content)) => {
                    let compact: String = content
                        .chars()
                        .filter(|c| !c.is_ascii_whitespace())
                        .collect();
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(compact)
                        .map_err(|e| unreadable(&e.to_string()))?;
                    Ok(GhPlan::Bytes(bytes, size, blob))
                }
                _ => Ok(GhPlan::Raw(size, blob)),
            }
        }
        Some("dir" | "submodule") => Ok(GhPlan::Absent),
        _ => Err(unreadable("the path isn't a file")),
    }
}

/// Lowercase hex of the git blob id of `bytes` (`blob <len>\0` + bytes) under `D`.
fn git_blob_hex<D: sha1::Digest>(bytes: &[u8]) -> String {
    let mut hasher = D::new();
    hasher.update(format!("blob {}\0", bytes.len()).as_bytes());
    hasher.update(bytes);
    // digest 0.11's output Array has no LowerHex, so hex-encode byte by byte.
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn git_blob_sha1(bytes: &[u8]) -> String {
    git_blob_hex::<sha1::Sha1>(bytes)
}

fn git_blob_sha256(bytes: &[u8]) -> String {
    git_blob_hex::<sha2::Sha256>(bytes)
}

/// Whether `bytes` are the blob `id` names, hashed in the id's own object format (40
/// hex SHA-1, 64 hex SHA-256); an id of any other width never matches.
fn blob_id_matches(bytes: &[u8], id: &str) -> bool {
    let actual = match id.len() {
        40 => git_blob_sha1(bytes),
        64 => git_blob_sha256(bytes),
        _ => return false,
    };
    actual.eq_ignore_ascii_case(id)
}

#[derive(Debug)]
enum GhBody {
    Ship(FileBytes),
    /// The body isn't the blob the answer names: read that blob by id. Measured: the
    /// contents API follows a symlink to an in-repo file and serves the target's
    /// bytes, size and type under the link blob's `sha`.
    ReadBlob,
}

/// A contents body (inline or raw) for blob `blob`: a body that isn't its declared size
/// is an error, and one that hashes to another blob is never shipped.
fn gh_body(bytes: Vec<u8>, size: u64, blob: &str, cap: u64) -> AppResult<GhBody> {
    if bytes.len() as u64 != size {
        return Err(gh_unreadable(
            "the file",
            "its content doesn't match its size".into(),
        ));
    }
    Ok(if blob_id_matches(&bytes, blob) {
        GhBody::Ship(finish_forge_bytes(bytes, cap, Some(size)))
    } else {
        GhBody::ReadBlob
    })
}

/// The blob read by id: bytes that hash to another blob are an error.
fn gh_blob_answer(bytes: Vec<u8>, blob: &str, cap: u64) -> AppResult<FileBytes> {
    if !blob_id_matches(&bytes, blob) {
        return Err(gh_unreadable(
            "the file",
            "its blob doesn't match its id".into(),
        ));
    }
    let size = bytes.len() as u64;
    Ok(finish_forge_bytes(bytes, cap, Some(size)))
}

async fn github_file(
    repo: &str,
    lens: Option<&str>,
    sha: &str,
    path: &str,
    segments: &[&str],
    cap: u64,
) -> AppResult<Option<FileBytes>> {
    let slug = gh_lens_slug(repo, lens).await?;
    let endpoint = format!(
        "repos/{slug}/contents/{}?ref={sha}",
        encode_segments(segments)
    );
    let read = run_gh_raw(Some(repo), &["api", &endpoint], GH_NETWORK_TIMEOUT).await;
    let Some(out) = gh_read_outcome(read)? else {
        let commit = format!("repos/{slug}/git/commits/{sha}");
        let known = run_gh_raw(Some(repo), &["api", &commit], GH_NETWORK_TIMEOUT).await;
        gh_commit_outcome(known, sha)?;
        return Ok(None);
    };
    let Some(contents) = gh_contents_body(&out.stdout, path)? else {
        return Ok(None);
    };
    let (bytes, size, blob) = match gh_contents_plan(contents, path, cap)? {
        GhPlan::Absent => return Ok(None),
        GhPlan::TooLarge(size) => return Ok(Some(too_large(size))),
        GhPlan::Bytes(bytes, size, blob) => (bytes, size, blob),
        GhPlan::Raw(size, blob) => {
            let args = ["api", "-H", GH_RAW_ACCEPT, &endpoint];
            let out = run_gh(Some(repo), &args, GH_NETWORK_TIMEOUT).await?;
            (out.stdout, size, blob)
        }
    };
    match gh_body(bytes, size, &blob, cap)? {
        GhBody::Ship(answer) => Ok(Some(answer)),
        GhBody::ReadBlob => {
            let endpoint = format!("repos/{slug}/git/blobs/{blob}");
            let args = ["api", "-H", GH_RAW_ACCEPT, &endpoint];
            let out = run_gh(Some(repo), &args, GH_NETWORK_TIMEOUT).await?;
            gh_blob_answer(out.stdout, &blob, cap).map(Some)
        }
    }
}

const GH_RAW_ACCEPT: &str = "Accept: application/vnd.github.raw";

// ── GitLab ───────────────────────────────────────────────────────────────────

async fn glab_json(repo: &str, endpoint: &str, what: &str) -> AppResult<Value> {
    let out = run_glab(Some(repo), &["api", endpoint], GLAB_NETWORK_TIMEOUT).await?;
    serde_json::from_slice(&out.stdout).map_err(|e| gl_unreadable(what, e.to_string()))
}

async fn gitlab_project(repo: &str) -> AppResult<String> {
    Ok(encode_project(&project_path(repo).await?))
}

/// GitLab's `diff_refs.base_sha` is the merge base (`start_sha` is the target tip); this
/// duplicates gitlab.rs `mr_diff_refs`' read, which is private there.
async fn gitlab_merge_base(
    repo: &str,
    number: u64,
    head: &str,
    base_ref: Option<&str>,
    base_sha: Option<&str>,
) -> AppResult<String> {
    let mr = gitlab_mr(repo, number).await?;
    gl_merge_base_outcome(&mr, head, base_ref, base_sha)
}

/// The plain merge request GET (no changes payload).
async fn gitlab_mr(repo: &str, number: u64) -> AppResult<Value> {
    let enc = gitlab_project(repo).await?;
    let endpoint = format!("projects/{enc}/merge_requests/{number}");
    glab_json(repo, &endpoint, "the merge request").await
}

/// The merge base, only while the merge request's diff refs are for the caller's head
/// (right after a push they can pair the old base with a new head) and its readable
/// target branch and base sha are the caller's. Without the caller's base sha the
/// target branch must be readable, since it is then the one base identity.
fn gl_merge_base_outcome(
    mr: &Value,
    head: &str,
    base_ref: Option<&str>,
    base_sha: Option<&str>,
) -> AppResult<String> {
    let no_refs = || {
        AppError::Glab("this merge request has no diff refs to read its merge base from.".into())
    };
    let base = sha_at(mr, "/diff_refs/base_sha").ok_or_else(no_refs)?;
    let refs_head = sha_at(mr, "/diff_refs/head_sha").ok_or_else(no_refs)?;
    if !refs_head.eq_ignore_ascii_case(head) {
        return Err(AppError::Glab(format!(
            "this merge request's diff refs are for {refs_head}, not {head}."
        )));
    }
    if let Some(want) = base_sha.filter(|want| !base.eq_ignore_ascii_case(want)) {
        return Err(AppError::Glab(format!(
            "this merge request's diff refs are against {base}, not {want}."
        )));
    }
    let target = mr
        .pointer("/target_branch")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty());
    match (target, base_ref) {
        (Some(live), Some(want)) if live != want => Err(AppError::Glab(format!(
            "this merge request now targets {live}, not {want}."
        ))),
        (None, Some(_)) if base_sha.is_none() => Err(gl_unreadable(
            "the merge request",
            "its target branch is missing".into(),
        )),
        _ => Ok(base),
    }
}

async fn gitlab_first_parent(repo: &str, oid: &str) -> AppResult<Option<String>> {
    let enc = gitlab_project(repo).await?;
    let endpoint = format!("projects/{enc}/repository/commits/{oid}");
    let commit = glab_json(repo, &endpoint, "the commit").await?;
    first_parent(&commit, "/parent_ids", None).map_err(|e| gl_unreadable("the commit", e))
}

#[derive(Debug, PartialEq)]
enum GlHead {
    /// The file exists, with its `X-Gitlab-Size` and its `X-Gitlab-Blob-Id` when sent.
    Found {
        size: u64,
        blob_id: Option<String>,
    },
    Missing,
}

/// A `glab api --method HEAD -i` answer, read from its status line and headers: glab
/// exits 1 on a 404, and no status line at all is a failure before any answer. A
/// HEAD answer has no body, so glab's own error for any other status names none of it.
fn gl_head_outcome(out: &GlabOutput) -> AppResult<GlHead> {
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines();
    let (status, reason) = match lines.next().and_then(|line| line.strip_prefix("HTTP/")) {
        Some(rest) => {
            let mut words = rest.split_whitespace().skip(1);
            let status = words.next().and_then(|code| code.parse::<u16>().ok());
            (status, words.collect::<Vec<_>>().join(" "))
        }
        None => (None, String::new()),
    };
    match status {
        Some(200) if out.code == 0 => {
            let headers: Vec<(&str, &str)> = lines
                .take_while(|line| !line.trim().is_empty())
                .filter_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    Some((name.trim(), value.trim()))
                })
                .collect();
            let header = |wanted: &str| {
                headers
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(wanted))
                    .map(|(_, value)| *value)
            };
            let size = header("x-gitlab-size")
                .and_then(|value| value.parse::<u64>().ok())
                .ok_or_else(|| gl_unreadable("the file", "its size is missing".into()))?;
            Ok(GlHead::Found {
                size,
                blob_id: header("x-gitlab-blob-id").map(str::to_string),
            })
        }
        Some(404) => Ok(GlHead::Missing),
        Some(status) if status != 200 => Err(gl_status_error(status, &reason)),
        _ => {
            let msg = out.stderr.trim();
            Err(AppError::Glab(if msg.is_empty() {
                format!("glab exited with code {} reading the file", out.code)
            } else {
                msg.to_string()
            }))
        }
    }
}

/// An answered status in glab's own spelling (`429 Too Many Requests (HTTP 429)`), so
/// forge-backoff.ts reads a 429 or a 401 here as it reads one from glab.
fn gl_status_error(status: u16, reason: &str) -> AppError {
    let reason = if reason.is_empty() {
        String::new()
    } else {
        format!(" {reason}")
    };
    AppError::Glab(format!("{status}{reason} (HTTP {status})"))
}

/// The raw body for a file the HEAD read sized: a body of another length, or one that
/// hashes to another blob than `X-Gitlab-Blob-Id` names, is an error.
fn gitlab_raw_answer(
    out: GlabOutput,
    cap: u64,
    size: u64,
    blob_id: Option<&str>,
) -> AppResult<FileBytes> {
    if out.stdout.len() as u64 != size {
        return Err(gl_unreadable(
            "the file",
            "its content doesn't match its size".into(),
        ));
    }
    if let Some(id) = blob_id {
        if !is_full_sha(id) || !blob_id_matches(&out.stdout, id) {
            return Err(gl_unreadable(
                "the file",
                "its content doesn't match its blob id".into(),
            ));
        }
    }
    Ok(finish_forge_bytes(out.stdout, cap, Some(size)))
}

/// A commit lookup's verdict: only an answered read confirms the commit.
fn gl_commit_outcome(out: &GlabOutput, sha: &str) -> AppResult<()> {
    if out.code == 0 {
        return Ok(());
    }
    if glab_output_is_404(&out.stderr, &out.stdout_lossy()) {
        return Err(AppError::Glab(format!("GitLab doesn't have commit {sha}.")));
    }
    let msg = out.stderr.trim();
    Err(AppError::Glab(if msg.is_empty() {
        format!("glab exited with code {} reading the commit", out.code)
    } else {
        msg.to_string()
    }))
}

async fn gitlab_file(repo: &str, sha: &str, path: &str, cap: u64) -> AppResult<Option<FileBytes>> {
    let enc = gitlab_project(repo).await?;
    // GitLab takes the whole file path as one encoded segment.
    let file = encode_query_value(path);
    let meta = format!("projects/{enc}/repository/files/{file}?ref={sha}");
    let head = run_glab_raw(
        Some(repo),
        &["api", "--method", "HEAD", "-i", &meta],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    match gl_head_outcome(&head)? {
        GlHead::Missing => {
            let commit = format!("projects/{enc}/repository/commits/{sha}");
            let out = run_glab_raw(Some(repo), &["api", &commit], GLAB_NETWORK_TIMEOUT).await?;
            gl_commit_outcome(&out, sha)?;
            Ok(None)
        }
        GlHead::Found { size, .. } if size > cap => Ok(Some(too_large(size))),
        GlHead::Found { size, blob_id } => {
            let raw = format!("projects/{enc}/repository/files/{file}/raw?ref={sha}");
            let out = run_glab(Some(repo), &["api", &raw], GLAB_NETWORK_TIMEOUT).await?;
            gitlab_raw_answer(out, cap, size, blob_id.as_deref()).map(Some)
        }
    }
}

// ── Bitbucket ────────────────────────────────────────────────────────────────

async fn bb_repo_base(repo: &str) -> AppResult<String> {
    let (ws, slug) = workspace_slug(repo).await?;
    Ok(format!(
        "repositories/{}/{}",
        encode_query_value(&ws),
        encode_query_value(&slug)
    ))
}

/// Bitbucket abbreviates the PR's destination hash, so the full merge base comes from
/// the merge-base endpoint over the caller's head and that hash.
async fn bitbucket_merge_base(
    creds: &BbCredentials,
    repo: &str,
    number: u64,
    head: &str,
    base_ref: Option<&str>,
) -> AppResult<String> {
    let base = bb_repo_base(repo).await?;
    let pr = bitbucket_pr(creds, &base, number).await?;
    let dest = bb_destination_outcome(&pr, base_ref)?;
    let endpoint = format!("{base}/merge-base/{head}..{dest}");
    let merge_base: Value =
        http::bb_get_json(creds, &endpoint, "merge base", BbOpKind::Read).await?;
    sha_at(&merge_base, "/hash")
        .ok_or_else(|| bb_unreadable("merge base", "its commit hash is missing".into()))
}

/// The PR's abbreviated destination hash, only when it names the caller's destination
/// branch, the caller's one base identity: a retarget or an unnamed branch refuses.
fn bb_destination_outcome<'a>(pr: &'a Value, base_ref: Option<&str>) -> AppResult<&'a str> {
    let live = pr
        .pointer("/destination/branch/name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty());
    match (live, base_ref) {
        (Some(live), Some(want)) if live != want => {
            return Err(AppError::Bitbucket(format!(
                "this pull request now targets {live}, not {want}."
            )));
        }
        (None, Some(_)) => {
            return Err(bb_unreadable(
                "pull request",
                "its destination branch is missing".into(),
            ));
        }
        _ => {}
    }
    bb_destination_hash(pr).ok_or_else(|| {
        bb_unreadable(
            "pull request",
            "its destination commit hash is missing".into(),
        )
    })
}

/// The pull request first, then its diff addressed by commit, the way the PR's own diff
/// link addresses it: `diff/{source repo}:{head}%0D{dest}` with `topic=true` answers the
/// PR's diff byte for byte (measured on one Bitbucket Cloud PR, bb-probe 2026-11-26), and
/// the source qualifier reaches a head only a fork holds. A readable contradiction drops
/// the text unfetched; a read naming no destination hash or source repository, one that
/// proves nothing, or a failed read by commit falls back to the by-number diff.
async fn bitbucket_diff_at(
    repo: &str,
    number: u64,
    head: &str,
    base_ref: &str,
) -> AppResult<(String, HeadProof)> {
    let by_number = || crate::forge::bitbucket::diff_pr(repo, number);
    // Without a session nothing is read by commit: the by-number diff, which
    // loads its own, answers or reports the failure, as a failed PR read would.
    let Ok((creds, base)) = bb_session(repo).await else {
        return Ok((by_number().await?, HeadProof::Unproven));
    };
    let pr = bitbucket_pr(&creds, &base, number).await;
    bb_diff_at_from(
        &pr,
        head,
        base_ref,
        |rel| async move {
            http::bb_get_text(&creds, &format!("{base}/{rel}"), BbOpKind::Read).await
        },
        by_number,
    )
    .await
}

/// [`bitbucket_diff_at`] over its two diff reads: `by_commits` takes the path below the
/// repository, `by_number` answers the PR's own diff, already capped.
async fn bb_diff_at_from<C, CF, N, NF>(
    pr: &AppResult<Value>,
    head: &str,
    base_ref: &str,
    by_commits: C,
    by_number: N,
) -> AppResult<(String, HeadProof)>
where
    C: FnOnce(String) -> CF,
    CF: std::future::Future<Output = AppResult<String>>,
    N: FnOnce() -> NF,
    NF: std::future::Future<Output = AppResult<String>>,
{
    match bb_reread_proof(pr, head, base_ref) {
        HeadProof::Moved => return Ok((String::new(), HeadProof::Moved)),
        HeadProof::Proven => {
            let read = pr.as_ref().ok();
            let dest = read.and_then(bb_destination_hash);
            let source = read.and_then(bb_source_full_name);
            if let (Some(dest), Some(source)) = (dest, source) {
                let rel = format!("diff/{source}:{head}%0D{dest}?topic=true");
                // Its error is never the answer: the PR's own diff can still serve.
                if let Ok(diff) = by_commits(rel).await {
                    let (text, _) = crate::git::diff::truncate_at_char_boundary(diff, PR_DIFF_CAP);
                    return Ok((text, HeadProof::Proven));
                }
            }
        }
        HeadProof::Unproven => {}
    }
    Ok((by_number().await?, HeadProof::Unproven))
}

/// The PR's abbreviated destination commit hash, when it reads as one.
fn bb_destination_hash(pr: &Value) -> Option<&str> {
    pr.pointer("/destination/commit/hash")
        .and_then(Value::as_str)
        .filter(|h| bb_short_hash(h))
}

/// The PR's source repository as `{workspace}/{slug}`, when both segments read as
/// Bitbucket slugs: the value lands in a request path.
fn bb_source_full_name(pr: &Value) -> Option<&str> {
    let name = pr
        .pointer("/source/repository/full_name")
        .and_then(Value::as_str)?;
    let (workspace, slug) = name.split_once('/')?;
    let segment = |s: &str| {
        !s.is_empty()
            && !s.bytes().all(|b| b == b'.')
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    };
    (segment(workspace) && segment(slug)).then_some(name)
}

/// The stored credentials and API path a command's Bitbucket reads share; the by-number
/// fallback (`diff_pr`) loads its own.
async fn bb_session(repo: &str) -> AppResult<(BbCredentials, String)> {
    Ok((http::load_credentials().await?, bb_repo_base(repo).await?))
}

/// The core pull request GET, whose source hash is the head the proof reads.
async fn bitbucket_pr(creds: &BbCredentials, base: &str, number: u64) -> AppResult<Value> {
    http::bb_get_json::<Value>(
        creds,
        &format!("{base}/pullrequests/{number}"),
        "pull request",
        BbOpKind::Read,
    )
    .await
}

/// The PR's source hash is abbreviated, so it proves the head as a prefix of it. Each
/// field reads on its own: a readable mismatch is another comparison, and proven needs
/// both a readable hash and a named (non-empty) destination branch.
fn bb_reread_proof(pr: &AppResult<Value>, head: &str, base_ref: &str) -> HeadProof {
    let Ok(pr) = pr else {
        return HeadProof::Unproven;
    };
    // Each check: Some(moved) from readable evidence, None when it can't be read.
    let head_check = pr
        .pointer("/source/commit/hash")
        .and_then(Value::as_str)
        .filter(|hash| bb_short_hash(hash))
        .map(|source| {
            !head
                .get(..source.len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(source))
        });
    let dest_check = pr
        .pointer("/destination/branch/name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(|dest| dest != base_ref);
    head_proof_verdict(&[head_check, dest_check], &[])
}

/// A commit hash Bitbucket abbreviates: its 12-hex form up to a full SHA-256 id. A
/// shorter prefix would tie more commits than the forge itself names.
fn bb_short_hash(hash: &str) -> bool {
    (12..=64).contains(&hash.len()) && hash.bytes().all(|b| b.is_ascii_hexdigit())
}

async fn bitbucket_first_parent(
    creds: &BbCredentials,
    repo: &str,
    oid: &str,
) -> AppResult<Option<String>> {
    let base = bb_repo_base(repo).await?;
    let commit: Value = http::bb_get_json(
        creds,
        &format!("{base}/commit/{oid}"),
        "commit",
        BbOpKind::Read,
    )
    .await?;
    first_parent(&commit, "/parents", Some("hash")).map_err(|e| bb_unreadable("commit", e))
}

#[derive(Debug, PartialEq)]
enum BbMeta {
    Size(u64),
    Missing,
    Directory,
}

/// Meta `attributes` whose `src` body is not the git blob a local read returns: a link, an
/// LFS object (Bitbucket serves the stored object, not the pointer), a submodule.
const BB_UNREADABLE_ATTRIBUTES: [&str; 3] = ["link", "lfs", "subrepository"];

/// A `src/{sha}/{path}?format=meta` answer: 200 with a file's size, 200 for a directory
/// (no file there), 404 for the caller to confirm, and any other status (or an answer
/// for another path, a file under an attribute above or without a readable attribute
/// list, or an unreadable 200) an error.
fn bb_meta_outcome(status: u16, body: &str, requested: &str) -> AppResult<BbMeta> {
    match status {
        200 => {
            let meta: Value = serde_json::from_str(body)
                .map_err(|e| bb_unreadable("file", format!("could not parse its metadata: {e}")))?;
            let kind = meta.get("type").and_then(Value::as_str);
            if !matches!(kind, Some("commit_file" | "commit_directory")) {
                return Err(bb_unreadable("file", "the path isn't a file".into()));
            }
            if meta.get("path").and_then(Value::as_str) != Some(requested) {
                return Err(bb_unreadable(
                    "file",
                    "the answer names another path".into(),
                ));
            }
            if kind == Some("commit_directory") {
                return Ok(BbMeta::Directory);
            }
            // Measured: every file's meta carries `attributes` (`[]` for a plain file),
            // so an answer without a readable list could be any of the kinds below.
            let attributes: Option<Vec<&str>> = meta
                .get("attributes")
                .and_then(Value::as_array)
                .and_then(|list| list.iter().map(Value::as_str).collect());
            let attributes = attributes
                .ok_or_else(|| bb_unreadable("file", "its attributes are missing".into()))?;
            if let Some(attribute) = attributes
                .into_iter()
                .find(|a| BB_UNREADABLE_ATTRIBUTES.contains(a))
            {
                return Err(bb_unreadable(
                    "file",
                    format!("its {attribute} content isn't the file's git blob"),
                ));
            }
            meta.get("size")
                .and_then(Value::as_u64)
                .map(BbMeta::Size)
                .ok_or_else(|| bb_unreadable("file", "its size is missing".into()))
        }
        404 => Ok(BbMeta::Missing),
        _ => Err(AppError::Bitbucket(http::bb_error_detail(
            status,
            body,
            BbOpKind::Read,
        ))),
    }
}

/// A commit lookup's verdict: a not-found commit is an error, never an absent file.
fn bb_commit_outcome(status: u16, body: &str, sha: &str) -> AppResult<()> {
    match status {
        200 => Ok(()),
        404 => Err(AppError::Bitbucket(format!(
            "Bitbucket doesn't have commit {sha}."
        ))),
        _ => Err(AppError::Bitbucket(http::bb_error_detail(
            status,
            body,
            BbOpKind::Read,
        ))),
    }
}

/// The body for a file the meta read sized: a body of another length is an error.
fn bitbucket_body_answer(bytes: Vec<u8>, cap: u64, size: u64) -> AppResult<FileBytes> {
    if bytes.len() as u64 != size {
        return Err(bb_unreadable(
            "file",
            "its content doesn't match its size".into(),
        ));
    }
    Ok(finish_forge_bytes(bytes, cap, Some(size)))
}

async fn bitbucket_file(
    creds: &BbCredentials,
    repo: &str,
    sha: &str,
    path: &str,
    segments: &[&str],
    cap: u64,
) -> AppResult<Option<FileBytes>> {
    let base = bb_repo_base(repo).await?;
    let src = format!("{base}/src/{sha}/{}", encode_segments(segments));
    // The byte reader folds every non-2xx into lossy text, so the status comes first.
    let (status, body) = http::bb_get_classified(creds, &format!("{src}?format=meta")).await?;
    match bb_meta_outcome(status, &body, path)? {
        BbMeta::Missing => {
            let (status, body) =
                http::bb_get_classified(creds, &format!("{base}/commit/{sha}")).await?;
            bb_commit_outcome(status, &body, sha)?;
            Ok(None)
        }
        BbMeta::Directory => Ok(None),
        BbMeta::Size(size) if size > cap => Ok(Some(too_large(size))),
        BbMeta::Size(size) => {
            let bytes = http::bb_get_json_bytes(creds, &src, BbOpKind::Read)
                .await
                .map_err(|failure| match failure {
                    BbGetFailure::Transport(error) | BbGetFailure::Other(error) => error,
                })?;
            bitbucket_body_answer(bytes, cap, size).map(Some)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::runner::TEST_GIT_HANG_GUARD;
    use crate::github::test_support::{
        gh_output, ANSWERED_STDERR, HELD_REST_STDERR, NOT_FOUND_STDERR,
    };
    use crate::image_sniff::png_fixture;
    use serde_json::json;

    const SHA: &str = "0123456789abcdef0123456789abcdef01234567";

    /// Non-UTF-8 bodies every arm must carry unchanged: a PNG header and a lone 0xFF.
    fn binary_bodies() -> Vec<Vec<u8>> {
        vec![
            png_fixture(2, 3),
            vec![0xFF],
            vec![0x00, 0xC3, 0x28, 0xFF, 0xFE, b'\r', b'\n'],
        ]
    }

    fn decoded(bytes: &FileBytes) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(bytes.base64.as_deref().unwrap())
            .unwrap()
    }

    fn glab(code: i32, stdout: &[u8], stderr: &str) -> GlabOutput {
        GlabOutput {
            stdout: stdout.to_vec(),
            stderr: stderr.into(),
            code,
        }
    }

    #[test]
    fn revs_serialize_to_the_pinned_wire_shape() {
        let value = serde_json::to_value(PrContentRevs {
            old_sha: "a".into(),
            new_sha: "b".into(),
        })
        .unwrap();
        assert_eq!(value, json!({ "oldSha": "a", "newSha": "b" }));
        assert!(value.get("old_sha").is_none() && value.get("new_sha").is_none());
    }

    #[test]
    fn the_shared_verdict_reads_each_axis_on_its_own() {
        let (moved, agrees, unreadable) = (Some(true), Some(false), None);
        assert_eq!(
            head_proof_verdict(&[agrees, agrees], &[]),
            HeadProof::Proven
        );
        assert_eq!(
            head_proof_verdict(&[agrees, agrees], &[unreadable]),
            HeadProof::Proven
        );
        assert_eq!(
            head_proof_verdict(&[agrees, unreadable], &[agrees]),
            HeadProof::Unproven
        );
        assert_eq!(
            head_proof_verdict(&[unreadable, moved], &[]),
            HeadProof::Moved
        );
        assert_eq!(
            head_proof_verdict(&[unreadable], &[moved]),
            HeadProof::Moved
        );
        assert_eq!(head_proof_verdict(&[], &[agrees]), HeadProof::Proven);
    }

    #[test]
    fn diff_at_serializes_to_the_pinned_wire_shape() {
        for (proof, wire) in [
            (HeadProof::Proven, "proven"),
            (HeadProof::Unproven, "unproven"),
            (HeadProof::Moved, "moved"),
        ] {
            // `forge_pr_head_proof` answers the bare enum.
            assert_eq!(serde_json::to_value(proof).unwrap(), json!(wire));
            let value = serde_json::to_value(diff_at("d".into(), proof)).unwrap();
            let diff = if proof == HeadProof::Moved { "" } else { "d" };
            assert_eq!(value, json!({ "diff": diff, "headProof": wire }));
            assert!(value.get("head_proof").is_none());
        }
    }

    const SHA256: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OTHER: &str = "fedcba9876543210fedcba9876543210fedcba98";
    const TOO_MANY_LINES: &str =
        "gh: Sorry, the diff exceeded the maximum number of lines (20000) (HTTP 406)";
    const TOO_MANY_FILES: &str = "gh: Sorry, the diff exceeded the maximum number of files (300). Consider using 'List pull requests files' API or locally cloning the repository instead. (HTTP 406)";
    const TRANSPORT_STDERR: &str =
        "error connecting to api.github.com\ncheck your internet connection or https://githubstatus.com";

    fn compare(result: AppResult<GhOutput>, memo: &mut OverCapMemo) -> AppResult<CompareAnswer> {
        gh_compare_outcome(result, memo, "o/r", SHA, SHA256)
    }

    #[test]
    fn compare_answers_split_text_fallback_and_failure() {
        assert!(matches!(
            classify_gh_failure(TRANSPORT_STDERR),
            GhFailure::Transport
        ));
        let mut memo = OverCapMemo::default();
        let at_cap = "a".repeat(PR_DIFF_CAP);
        assert_eq!(
            compare(gh_output(0, &at_cap, ""), &mut memo).unwrap(),
            CompareAnswer::Text(at_cap.clone())
        );
        assert_eq!(memo.plan("o/r", SHA, SHA256), ComparePlan::Compare);
        let over = "a".repeat(PR_DIFF_CAP + 1);
        assert_eq!(
            compare(gh_output(0, &over, ""), &mut memo).unwrap(),
            CompareAnswer::NotAddressable
        );
        // Under the cap in bytes, over it once each invalid byte decodes to U+FFFD.
        let mut grows = OverCapMemo::default();
        let invalid = GhOutput {
            stdout: vec![0xFF; PR_DIFF_CAP / 2],
            stderr: String::new(),
            code: 0,
        };
        assert_eq!(
            compare(Ok(invalid), &mut grows).unwrap(),
            CompareAnswer::NotAddressable
        );
        assert_eq!(grows.plan("o/r", SHA, SHA256), ComparePlan::Skip);
        for stderr in [
            TOO_MANY_LINES,
            TOO_MANY_FILES,
            NOT_FOUND_STDERR,
            ANSWERED_STDERR,
            "",
        ] {
            assert_eq!(
                compare(gh_output(1, "", stderr), &mut memo).unwrap(),
                CompareAnswer::NotAddressable,
                "{stderr}"
            );
        }
        assert!(compare(Err(AppError::GhNotFound), &mut memo).is_err());
    }

    #[test]
    fn an_answered_compare_refusal_reads_by_number() {
        let mut memo = OverCapMemo::default();
        let refusal = "gh: Resource not accessible by personal access token (HTTP 403)";
        assert_eq!(
            compare(gh_output(1, "", refusal), &mut memo).unwrap(),
            CompareAnswer::NotAddressable
        );
        assert_eq!(memo.plan("o/r", SHA, SHA256), ComparePlan::Compare);

        for stderr in [HELD_REST_STDERR, TRANSPORT_STDERR] {
            assert!(
                matches!(
                    compare(gh_output(1, "", stderr), &mut memo),
                    Err(AppError::Gh(_))
                ),
                "{stderr}"
            );
        }
    }

    #[test]
    fn only_an_over_cap_body_is_remembered() {
        let over = "a".repeat(PR_DIFF_CAP + 1);
        let mut memo = OverCapMemo::default();
        for stderr in [TOO_MANY_LINES, NOT_FOUND_STDERR, HELD_REST_STDERR] {
            let _ = compare(gh_output(1, "", stderr), &mut memo);
        }
        let _ = compare(Err(AppError::GhNotFound), &mut memo);
        assert_eq!(memo.plan("o/r", SHA, SHA256), ComparePlan::Compare);
        compare(gh_output(0, &over, ""), &mut memo).unwrap();
        assert_eq!(memo.plan("o/r", SHA, SHA256), ComparePlan::Skip);
        let upper = (SHA.to_ascii_uppercase(), SHA256.to_ascii_uppercase());
        assert_eq!(memo.plan("o/r", &upper.0, &upper.1), ComparePlan::Skip);
        assert_eq!(memo.plan("o/r", SHA, OTHER), ComparePlan::Compare);
        assert_eq!(memo.plan("o/r", OTHER, SHA256), ComparePlan::Compare);
        assert_eq!(memo.plan("o/other", SHA, SHA256), ComparePlan::Compare);
    }

    #[test]
    fn the_memo_never_holds_more_than_its_cap() {
        let mut memo = OverCapMemo::default();
        for n in 0..=OVER_CAP_MEMO_MAX {
            memo.note("o/r", SHA, &format!("{n:040x}"));
            assert!(memo.0.len() <= OVER_CAP_MEMO_MAX);
        }
        assert_eq!(memo.0.len(), 1);
        let last = format!("{OVER_CAP_MEMO_MAX:040x}");
        assert_eq!(memo.plan("o/r", SHA, &last), ComparePlan::Skip);
        // Noting a remembered triple at the cap keeps the rest.
        let mut full = OverCapMemo::default();
        for n in 0..OVER_CAP_MEMO_MAX {
            full.note("o/r", SHA, &format!("{n:040x}"));
        }
        full.note("o/r", SHA, &format!("{:040x}", 0));
        assert_eq!(full.0.len(), OVER_CAP_MEMO_MAX);
    }

    fn gh_pr(head: Option<&str>, base: Option<&str>) -> AppResult<Value> {
        let mut pr = json!({ "number": 1 });
        if let Some(head) = head {
            pr["head"] = json!({ "sha": head });
        }
        if let Some(base) = base {
            pr["base"] = json!({ "sha": base, "ref": "main" });
        }
        Ok(pr)
    }

    #[test]
    fn github_reread_proves_only_the_callers_head_and_base() {
        let failed: AppResult<Value> = Err(AppError::Gh("HTTP 502".into()));
        assert_eq!(
            gh_reread_proof(&failed, SHA, "main", None),
            HeadProof::Unproven
        );
        let pr = gh_pr(Some(SHA), Some(SHA256));
        for base in [None, Some(SHA256)] {
            assert_eq!(gh_reread_proof(&pr, SHA, "main", base), HeadProof::Proven);
            // A readable base branch naming another target is another comparison.
            assert_eq!(gh_reread_proof(&pr, SHA, "develop", base), HeadProof::Moved);
        }
        // Without the caller's base sha, an unreadable base branch ties nothing.
        let mut no_ref = gh_pr(Some(SHA), Some(SHA256)).unwrap();
        no_ref["base"]["ref"] = Value::Null;
        let no_ref: AppResult<Value> = Ok(no_ref);
        assert_eq!(
            gh_reread_proof(&no_ref, SHA, "main", None),
            HeadProof::Unproven
        );
        assert_eq!(
            gh_reread_proof(&no_ref, SHA, "main", Some(SHA256)),
            HeadProof::Proven
        );
        assert_eq!(
            gh_reread_proof(
                &gh_pr(Some(&SHA.to_ascii_uppercase()), Some(SHA256)),
                SHA,
                "main",
                Some(&SHA256.to_ascii_uppercase())
            ),
            HeadProof::Proven
        );
        assert_eq!(
            gh_reread_proof(&gh_pr(Some(OTHER), Some(SHA256)), SHA, "main", Some(SHA256)),
            HeadProof::Moved
        );
        assert_eq!(
            gh_reread_proof(&gh_pr(Some(SHA), Some(OTHER)), SHA, "main", Some(SHA256)),
            HeadProof::Moved
        );
        for pr in [
            gh_pr(None, Some(SHA256)),
            gh_pr(Some(SHA), None),
            gh_pr(Some("abc1234"), Some(SHA256)),
        ] {
            assert_eq!(gh_reread_proof(&pr, SHA, "main", None), HeadProof::Unproven);
        }
        // A readable contradiction wins over a missing sha on another axis.
        let mut no_base_sha = gh_pr(Some(SHA), Some(SHA256)).unwrap();
        no_base_sha["base"]["sha"] = Value::Null;
        let no_base_sha: AppResult<Value> = Ok(no_base_sha);
        assert_eq!(
            gh_reread_proof(&no_base_sha, SHA, "develop", Some(SHA256)),
            HeadProof::Moved
        );
        assert_eq!(
            gh_reread_proof(&no_base_sha, SHA, "main", Some(SHA256)),
            HeadProof::Unproven
        );
        assert_eq!(
            gh_reread_proof(&gh_pr(None, Some(OTHER)), SHA, "main", Some(SHA256)),
            HeadProof::Moved
        );
    }

    /// What [`gh_diff_at_from`] asked of recording fakes: its answer, the base shas the
    /// compare was asked for, how many PR reads ran, whether the by-number read ran, and
    /// the order of every call.
    struct GhDiffRun {
        out: AppResult<(String, HeadProof)>,
        compared: Vec<String>,
        reads: usize,
        by_number: bool,
        order: Vec<&'static str>,
    }

    /// `pr` is told whether the PR read was issued after the by-number text completed,
    /// so a fake can answer differently on either side of it. The text's marker is set
    /// when its future completes and the PR read samples it when first polled, so a read
    /// issued early or alongside the text, whatever the await order, still shows.
    async fn gh_diff_run(
        pr: impl Fn(bool) -> AppResult<Value>,
        base_ref: &str,
        base_sha: Option<&str>,
        answer: AppResult<CompareAnswer>,
    ) -> GhDiffRun {
        let compared = std::cell::RefCell::new(Vec::new());
        let reads = std::cell::Cell::new(0);
        let by_number = std::cell::Cell::new(false);
        let order = std::cell::RefCell::new(Vec::new());
        let (pr, compared_ref, reads_ref) = (&pr, &compared, &reads);
        let (by_number_ref, order_ref) = (&by_number, &order);
        let out = gh_diff_at_from(
            SHA,
            base_ref,
            base_sha,
            move || async move {
                let after_text = by_number_ref.get();
                tokio::task::yield_now().await;
                reads_ref.set(reads_ref.get() + 1);
                order_ref.borrow_mut().push("read");
                pr(after_text)
            },
            move |base| async move {
                tokio::task::yield_now().await;
                compared_ref.borrow_mut().push(base);
                order_ref.borrow_mut().push("compare");
                answer
            },
            move || async move {
                tokio::task::yield_now().await;
                by_number_ref.set(true);
                order_ref.borrow_mut().push("by number");
                Ok("by number".to_string())
            },
        )
        .await;
        GhDiffRun {
            out,
            compared: compared.into_inner(),
            reads: reads.get(),
            by_number: by_number.get(),
            order: order.into_inner(),
        }
    }

    fn compared_text() -> AppResult<CompareAnswer> {
        Ok(CompareAnswer::Text("by sha".into()))
    }

    #[tokio::test]
    async fn github_diff_without_a_base_sha_compares_from_a_read_naming_the_target() {
        for head in [SHA.to_string(), SHA.to_ascii_uppercase()] {
            let run = gh_diff_run(
                |_| gh_pr(Some(&head), Some(SHA256)),
                "main",
                None,
                compared_text(),
            )
            .await;
            assert_eq!(run.compared, vec![SHA256.to_string()]);
            assert_eq!(run.out.unwrap(), ("by sha".into(), HeadProof::Proven));
            assert_eq!((run.reads, run.by_number), (1, false));
        }
        // The caller's own base sha needs no read first.
        let run = gh_diff_run(
            |_| gh_pr(Some(SHA), Some(SHA256)),
            "main",
            Some(OTHER),
            compared_text(),
        )
        .await;
        assert_eq!(run.compared, vec![OTHER.to_string()]);
        assert_eq!(run.out.unwrap(), ("by sha".into(), HeadProof::Proven));
        assert_eq!((run.reads, run.by_number), (0, false));
    }

    #[tokio::test]
    async fn github_diff_without_a_base_sha_reads_by_number_unless_the_read_names_the_target() {
        // Another base branch, or another head: nothing compared, today's path.
        let retargeted = gh_diff_run(
            |_| gh_pr(Some(SHA), Some(SHA256)),
            "develop",
            None,
            compared_text(),
        )
        .await;
        let moved_head = gh_diff_run(
            |_| gh_pr(Some(OTHER), Some(SHA256)),
            "main",
            None,
            compared_text(),
        )
        .await;
        for run in [retargeted, moved_head] {
            assert!(run.compared.is_empty());
            assert_eq!(run.out.unwrap(), ("by number".into(), HeadProof::Moved));
            assert_eq!((run.reads, run.by_number), (2, true));
        }
        // A failed read, or one missing the base branch or a full base sha, proves nothing.
        let no_ref = |_: bool| -> AppResult<Value> {
            let mut pr = gh_pr(Some(SHA), Some(SHA256))?;
            pr["base"]["ref"] = Value::Null;
            Ok(pr)
        };
        let failed = gh_diff_run(
            |_| Err(AppError::Gh("HTTP 502".into())),
            "main",
            None,
            compared_text(),
        )
        .await;
        let unnamed = gh_diff_run(no_ref, "main", None, compared_text()).await;
        let short_base = gh_diff_run(
            |_| gh_pr(Some(SHA), Some("abc1234")),
            "main",
            None,
            compared_text(),
        )
        .await;
        for run in [failed, unnamed, short_base] {
            assert!(run.compared.is_empty());
            assert_eq!(run.out.unwrap(), ("by number".into(), HeadProof::Unproven));
            assert_eq!((run.reads, run.by_number), (2, true));
        }
    }

    #[tokio::test]
    async fn github_diff_from_a_read_base_keeps_the_fallback_and_the_failure() {
        let mut memo = OverCapMemo::default();
        let over = "a".repeat(PR_DIFF_CAP + 1);
        let over_cap = gh_compare_outcome(gh_output(0, &over, ""), &mut memo, "o/r", SHA256, SHA);
        assert_eq!(memo.plan("o/r", SHA256, SHA), ComparePlan::Skip);
        for answer in [over_cap, Ok(CompareAnswer::NotAddressable)] {
            let run = gh_diff_run(|_| gh_pr(Some(SHA), Some(SHA256)), "main", None, answer).await;
            assert_eq!(run.compared, vec![SHA256.to_string()]);
            assert_eq!(run.out.unwrap(), ("by number".into(), HeadProof::Proven));
            assert_eq!((run.reads, run.by_number), (2, true));
            assert_eq!(run.order, ["read", "compare", "by number", "read"]);
        }
        let run = gh_diff_run(
            |_| gh_pr(Some(SHA), Some(SHA256)),
            "main",
            None,
            Err(AppError::Gh("HTTP 502".into())),
        )
        .await;
        assert!(matches!(run.out, Err(AppError::Gh(_))));
        assert_eq!((run.reads, run.by_number), (1, false));
    }

    #[tokio::test]
    async fn the_github_fallback_proves_its_text_with_a_read_after_it() {
        // The head moves once the by-number text is read: only a read after it sees that.
        let moves_after_text =
            |text_read: bool| gh_pr(Some(if text_read { OTHER } else { SHA }), Some(SHA256));
        let not_addressable = || Ok(CompareAnswer::NotAddressable);
        let read_base = gh_diff_run(moves_after_text, "main", None, not_addressable()).await;
        assert_eq!(
            read_base.out.unwrap(),
            ("by number".into(), HeadProof::Moved)
        );
        assert_eq!(read_base.order, ["read", "compare", "by number", "read"]);
        let callers_base =
            gh_diff_run(moves_after_text, "main", Some(SHA256), not_addressable()).await;
        assert_eq!(
            callers_base.out.unwrap(),
            ("by number".into(), HeadProof::Moved)
        );
        assert_eq!(callers_base.order, ["compare", "by number", "read"]);
    }

    #[tokio::test]
    async fn an_over_cap_comparison_is_asked_once() {
        let memo = std::sync::Mutex::new(OverCapMemo::default());
        let over = "a".repeat(PR_DIFF_CAP + 1);
        let paths = std::cell::RefCell::new(Vec::new());
        let by_number = std::cell::Cell::new(0);
        for _ in 0..2 {
            let out = gh_diff_at_from(
                SHA,
                "main",
                Some(SHA256),
                || async { gh_pr(Some(SHA), Some(SHA256)) },
                |base| {
                    gh_compare_at(&memo, "o/r", base, SHA, |path| {
                        paths.borrow_mut().push(path);
                        let out = gh_output(0, &over, "");
                        async move { out }
                    })
                },
                || {
                    by_number.set(by_number.get() + 1);
                    async { Ok("by number".to_string()) }
                },
            )
            .await;
            assert_eq!(out.unwrap(), ("by number".into(), HeadProof::Proven));
        }
        assert_eq!(
            paths.into_inner(),
            vec![["repos/o/r/compare/", SHA256, "...", SHA].concat()]
        );
        assert_eq!(by_number.get(), 2);
    }

    #[tokio::test]
    async fn the_head_proof_dispatch_judges_each_forges_read_with_its_arguments() {
        // Each payload agrees on head and branch and contradicts on one axis only
        // that forge's rule reads with the caller's arguments.
        let github = gh_pr(Some(SHA), Some(OTHER));
        let gitlab = Ok(json!({ "sha": OTHER, "target_branch": "main" }));
        let bitbucket = bb_pr(Some(&OTHER[..12]), Some("main"));
        for (provider, pr) in [
            (None, github),
            (Some(Provider::GitLab), gitlab),
            (Some(Provider::Bitbucket), bitbucket),
        ] {
            let asked = std::cell::Cell::new(None);
            let proof = head_proof_at(provider, SHA, "main", Some(SHA256), |p| {
                asked.set(Some(p));
                async move { pr }
            })
            .await;
            assert_eq!(proof, HeadProof::Moved, "{provider:?}");
            assert_eq!(asked.get(), Some(provider));
        }
    }

    fn bb_pr(hash: Option<&str>, branch: Option<&str>) -> AppResult<Value> {
        let mut pr = json!({ "id": 1, "source": {}, "destination": {} });
        if let Some(hash) = hash {
            pr["source"]["commit"] = json!({ "hash": hash });
        }
        if let Some(branch) = branch {
            pr["destination"]["branch"] = json!({ "name": branch });
        }
        Ok(pr)
    }

    #[test]
    fn bitbucket_reread_proves_the_head_by_prefix_and_the_base_by_branch() {
        let failed: AppResult<Value> = Err(AppError::Command("offline".into()));
        assert_eq!(bb_reread_proof(&failed, SHA, "main"), HeadProof::Unproven);
        for head in [SHA, SHA256] {
            assert_eq!(
                bb_reread_proof(&bb_pr(Some(&head[..12]), Some("main")), head, "main"),
                HeadProof::Proven
            );
        }
        assert_eq!(
            bb_reread_proof(
                &bb_pr(Some(&SHA[..12].to_ascii_uppercase()), Some("main")),
                SHA,
                "main"
            ),
            HeadProof::Proven
        );
        assert_eq!(
            bb_reread_proof(&bb_pr(Some(&OTHER[..12]), Some("main")), SHA, "main"),
            HeadProof::Moved
        );
        assert_eq!(
            bb_reread_proof(&bb_pr(Some(&SHA[..12]), Some("develop")), SHA, "main"),
            HeadProof::Moved
        );
        // A readable hash longer than the head can't be its prefix.
        let longer = format!("{SHA}0");
        assert_eq!(
            bb_reread_proof(&bb_pr(Some(&longer), Some("main")), SHA, "main"),
            HeadProof::Moved
        );
        for pr in [
            bb_pr(Some(&SHA[..6]), Some("main")),
            bb_pr(Some("0123456789zz"), Some("main")),
            bb_pr(None, Some("main")),
            bb_pr(Some(&SHA[..12]), None),
            bb_pr(Some(&SHA[..12]), Some("")),
        ] {
            assert_eq!(bb_reread_proof(&pr, SHA, "main"), HeadProof::Unproven);
        }
        // An empty name is an unread branch, never the caller's empty base.
        assert_eq!(
            bb_reread_proof(&bb_pr(Some(&SHA[..12]), Some("")), SHA, ""),
            HeadProof::Unproven
        );
        // A readable contradiction wins over the other field missing.
        assert_eq!(
            bb_reread_proof(&bb_pr(None, Some("develop")), SHA, "main"),
            HeadProof::Moved
        );
        assert_eq!(
            bb_reread_proof(&bb_pr(Some(&OTHER[..12]), Some("")), SHA, "main"),
            HeadProof::Moved
        );
    }

    fn bb_pr_at(hash: Option<&str>, branch: Option<&str>, dest: Option<&str>) -> AppResult<Value> {
        let mut pr = bb_pr(hash, branch)?;
        if let Some(dest) = dest {
            pr["destination"]["commit"] = json!({ "hash": dest });
        }
        pr["source"]["repository"] = json!({ "full_name": "o/r" });
        pr["destination"]["repository"] = json!({ "full_name": "o/r" });
        Ok(pr)
    }

    /// [`bb_diff_at_from`] over recording fakes: the paths asked of the by-commit read
    /// (answering `body`), and whether the by-number read ran.
    async fn bb_diff_run(
        pr: AppResult<Value>,
        head: &str,
        body: AppResult<String>,
    ) -> (AppResult<(String, HeadProof)>, Vec<String>, bool) {
        let asked = std::cell::RefCell::new(Vec::new());
        let by_number = std::cell::Cell::new(false);
        let out = bb_diff_at_from(
            &pr,
            head,
            "main",
            |rel| {
                asked.borrow_mut().push(rel);
                async move { body }
            },
            || {
                by_number.set(true);
                async { Ok("by number".to_string()) }
            },
        )
        .await;
        (out, asked.into_inner(), by_number.get())
    }

    #[tokio::test]
    async fn bitbucket_diff_reads_by_commit_only_when_the_pr_names_the_head() {
        let dest = &OTHER[..12];
        let commits = || Ok("by commits".to_string());
        for (pr, head) in [
            (bb_pr_at(Some(&SHA[..12]), Some("main"), Some(dest)), SHA),
            (
                bb_pr_at(
                    Some(&SHA[..12].to_ascii_uppercase()),
                    Some("main"),
                    Some(dest),
                ),
                SHA,
            ),
            (
                bb_pr_at(Some(&SHA256[..12]), Some("main"), Some(OTHER)),
                SHA256,
            ),
        ] {
            let want_dest = pr.as_ref().unwrap()["destination"]["commit"]["hash"]
                .as_str()
                .unwrap()
                .to_string();
            let (out, asked, by_number) = bb_diff_run(pr, head, commits()).await;
            assert_eq!(out.unwrap(), ("by commits".into(), HeadProof::Proven));
            // The caller's full head, never the PR's abbreviated source.
            assert_eq!(asked, [format!("diff/o/r:{head}%0D{want_dest}?topic=true")]);
            assert!(!by_number);
        }
        // A readable contradiction: moved, and no diff read at all.
        for pr in [
            bb_pr_at(Some(&OTHER[..12]), Some("main"), Some(dest)),
            bb_pr_at(Some(&SHA[..12]), Some("develop"), Some(dest)),
            bb_pr_at(Some(&OTHER[..12]), None, None),
        ] {
            let (out, asked, by_number) = bb_diff_run(pr, SHA, commits()).await;
            assert_eq!(out.unwrap(), (String::new(), HeadProof::Moved));
            assert!(asked.is_empty() && !by_number);
        }
        // Nothing readable to address the diff by: by number, unproven.
        for pr in [
            Err(AppError::Bitbucket("offline".into())),
            bb_pr_at(Some(&SHA[..12]), Some("main"), None),
            bb_pr_at(Some(&SHA[..12]), Some("main"), Some("0123456789zz")),
            bb_pr_at(Some(&SHA[..12]), Some(""), Some(dest)),
            bb_pr_at(None, Some("main"), Some(dest)),
        ] {
            let (out, asked, by_number) = bb_diff_run(pr, SHA, commits()).await;
            assert_eq!(out.unwrap(), ("by number".into(), HeadProof::Unproven));
            assert!(asked.is_empty() && by_number);
        }
        // A missing or unusable source repository can't address the comparison.
        for name in [
            None,
            Some(json!(7)),
            Some(json!("")),
            Some(json!("o")),
            Some(json!("o/r/x")),
            Some(json!("../r")),
            Some(json!("o/r?x")),
        ] {
            let mut pr = bb_pr_at(Some(&SHA[..12]), Some("main"), Some(dest)).unwrap();
            match name {
                Some(name) => pr["source"]["repository"]["full_name"] = name,
                None => pr["source"] = json!({ "commit": { "hash": &SHA[..12] } }),
            }
            let (out, asked, by_number) = bb_diff_run(Ok(pr), SHA, commits()).await;
            assert_eq!(out.unwrap(), ("by number".into(), HeadProof::Unproven));
            assert!(asked.is_empty() && by_number);
        }
    }

    #[tokio::test]
    async fn a_bitbucket_fork_pr_addresses_its_head_in_the_source_repository() {
        let mut pr = bb_pr_at(Some(&SHA[..12]), Some("main"), Some(&OTHER[..12])).unwrap();
        pr["source"]["repository"]["full_name"] = json!("team/fork");
        pr["destination"]["repository"]["full_name"] = json!("team/upstream");
        let (out, asked, by_number) = bb_diff_run(Ok(pr), SHA, Ok("by commits".to_string())).await;
        assert_eq!(out.unwrap(), ("by commits".into(), HeadProof::Proven));
        let dest = &OTHER[..12];
        assert_eq!(asked, [format!("diff/team/fork:{SHA}%0D{dest}?topic=true")]);
        assert!(!by_number);
    }

    #[tokio::test]
    async fn a_bitbucket_diff_by_commit_keeps_the_cap_and_falls_back_on_failure() {
        let pr = || bb_pr_at(Some(&SHA[..12]), Some("main"), Some(&OTHER[..12]));
        let long = format!("{}é", "a".repeat(PR_DIFF_CAP - 1));
        let (out, _, _) = bb_diff_run(pr(), SHA, Ok(long)).await;
        let (text, proof) = out.unwrap();
        assert_eq!((text.len(), proof), (PR_DIFF_CAP - 1, HeadProof::Proven));
        // A failed read by commit never surfaces: the PR's own diff answers, unproven.
        let (out, asked, by_number) =
            bb_diff_run(pr(), SHA, Err(AppError::Bitbucket("gone".into()))).await;
        assert_eq!(out.unwrap(), ("by number".into(), HeadProof::Unproven));
        assert_eq!(asked.len(), 1);
        assert!(by_number);
    }

    #[test]
    fn the_compare_path_takes_only_full_shas() {
        assert_eq!(
            github_compare_path("o/r", SHA, SHA256).unwrap(),
            ["repos/o/r/compare/", SHA, "...", SHA256].concat()
        );
        for bad in ["main", "abc1234", "{branch}", &format!("{SHA}?x")] {
            assert!(github_compare_path("o/r", bad, SHA).is_err());
            assert!(github_compare_path("o/r", SHA, bad).is_err());
        }
    }

    #[tokio::test]
    async fn invalid_input_is_refused_before_any_spawn() {
        // A missing folder: any git, gh or glab spawn would fail with another kind.
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("missing").to_string_lossy().into_owned();
        let invalid = |result: AppResult<_>, starts: &str| match result {
            Err(AppError::InvalidArgument(message)) => {
                assert!(message.starts_with(starts), "{message}")
            }
            Err(other) => panic!("expected InvalidArgument, got {other}"),
            Ok(_) => panic!("expected InvalidArgument, got Ok"),
        };
        // The lens is validated first, so it wins over a bad sha and a bad path.
        invalid(
            forge_pr_content_revs(
                repo.clone(),
                1,
                Some("fork".into()),
                "abc".into(),
                None,
                None,
            )
            .await
            .map(|_| ()),
            "unknown remote lens",
        );
        invalid(
            forge_file_at_sha(
                repo.clone(),
                "abc".into(),
                "".into(),
                Some("fork".into()),
                None,
            )
            .await
            .map(|_| ()),
            "unknown remote lens",
        );
        invalid(
            forge_commit_first_parent(repo.clone(), "abc".into(), Some("fork".into()))
                .await
                .map(|_| ()),
            "unknown remote lens",
        );
        invalid(
            forge_pr_diff_at(
                repo.clone(),
                1,
                Some("fork".into()),
                "abc".into(),
                "main".into(),
                Some("abc".into()),
            )
            .await
            .map(|_| ()),
            "unknown remote lens",
        );
        for bad in [
            "",
            "abc1234",
            &"a".repeat(39),
            &"a".repeat(41),
            &"a".repeat(65),
            &format!("{}g", "a".repeat(39)),
            &format!("{}\n", "a".repeat(39)),
            &format!("-{}", "a".repeat(39)),
        ] {
            invalid(
                forge_pr_content_revs(repo.clone(), 1, None, bad.to_string(), None, None)
                    .await
                    .map(|_| ()),
                "expected a full commit sha",
            );
            invalid(
                forge_commit_first_parent(repo.clone(), bad.to_string(), Some("upstream".into()))
                    .await
                    .map(|_| ()),
                "expected a full commit sha",
            );
            // A bad head refuses, and so does a bad base beside a full head.
            invalid(
                forge_pr_diff_at(repo.clone(), 1, None, bad.to_string(), "main".into(), None)
                    .await
                    .map(|_| ()),
                "expected a full commit sha",
            );
            invalid(
                forge_pr_diff_at(
                    repo.clone(),
                    1,
                    Some("upstream".into()),
                    SHA.into(),
                    "main".into(),
                    Some(bad.to_string()),
                )
                .await
                .map(|_| ()),
                "expected a full commit sha",
            );
            invalid(
                forge_pr_content_revs(
                    repo.clone(),
                    1,
                    None,
                    SHA.into(),
                    Some("main".into()),
                    Some(bad.to_string()),
                )
                .await
                .map(|_| ()),
                "expected a full commit sha",
            );
            // The sha precedes the path.
            invalid(
                forge_file_at_sha(repo.clone(), bad.to_string(), "".into(), None, None)
                    .await
                    .map(|_| ()),
                "expected a full commit sha",
            );
        }
        let absolute = std::env::temp_dir()
            .join("x.png")
            .to_string_lossy()
            .into_owned();
        for bad in [
            "",
            absolute.as_str(),
            "/etc/passwd",
            "../x.png",
            "a/../../x.png",
            "a/..",
            "a//b.png",
            "./a.png",
            "a/./b.png",
            "a/",
        ] {
            invalid(
                forge_file_at_sha(repo.clone(), SHA.into(), bad.into(), None, Some(1))
                    .await
                    .map(|_| ()),
                "invalid file path",
            );
        }
    }

    #[test]
    fn paths_encode_per_segment_and_caps_never_exceed_the_preview_cap() {
        let segments = file_segments("dir/a b/\u{e9}{#%?}.png").unwrap();
        assert_eq!(
            encode_segments(&segments),
            "dir/a%20b/%C3%A9%7B%23%25%3F%7D.png"
        );
        assert_eq!(encode_query_value("src/app.py"), "src%2Fapp.py");
        assert_eq!(effective_cap(None), 20_000_000);
        assert_eq!(effective_cap(Some(300_000)), 300_000);
        assert_eq!(effective_cap(Some(50_000_000)), 20_000_000);
        assert_eq!(effective_cap(Some(0)), 0);
    }

    #[test]
    fn shas_and_parents_read_only_full_hashes() {
        let full = "a".repeat(40);
        let wide = "B".repeat(64);
        assert_eq!(
            sha_at(&json!({"base": {"sha": full}}), "/base/sha"),
            Some(full.clone())
        );
        assert_eq!(sha_at(&json!({"hash": wide}), "/hash"), Some(wide.clone()));
        for bad in [
            json!("abc1234"),
            json!(null),
            json!(7),
            json!("z".repeat(40)),
        ] {
            assert_eq!(sha_at(&json!({ "hash": bad }), "/hash"), None, "{bad}");
        }
        assert_eq!(sha_at(&json!({}), "/hash"), None);

        let objects = json!({"parents": [{"sha": full}, {"sha": wide}]});
        assert_eq!(
            first_parent(&objects, "/parents", Some("sha")),
            Ok(Some(full.clone()))
        );
        let ids = json!({"parent_ids": [wide, full]});
        assert_eq!(
            first_parent(&ids, "/parent_ids", None),
            Ok(Some(wide.clone()))
        );
        // Only an answered empty list is a root commit.
        assert_eq!(
            first_parent(&json!({"parents": []}), "/parents", Some("hash")),
            Ok(None)
        );
        for bad in [
            json!({}),
            json!({"parents": null}),
            json!({"parents": [{"hash": "abc1234"}]}),
            json!({"parents": [{}]}),
            json!({"parents": ["not-a-sha"]}),
        ] {
            assert!(
                first_parent(&bad, "/parents", Some("hash")).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn finishing_mirrors_the_local_preview_rules() {
        // Over the cap: refused with the producer's size, never the buffer length.
        for size in [None, Some(99)] {
            let refused = finish_forge_bytes(vec![0; 11], 10, size);
            assert!(refused.too_large && refused.base64.is_none() && refused.mime.is_none());
            assert_eq!(refused.size, size);
        }
        let at_cap = finish_forge_bytes(vec![0; 10], 10, Some(10));
        assert!(!at_cap.too_large);
        assert_eq!(at_cap.size, Some(10));
        let full_cap = finish_forge_bytes(vec![0; 21], effective_cap(None), None);
        assert!(!full_cap.too_large);
        // A raster past the dimension caps ships its type without bytes or size.
        let huge = finish_forge_bytes(png_fixture(9000, 10), u64::MAX, Some(1));
        assert!(huge.too_large && huge.base64.is_none() && huge.size.is_none());
        assert_eq!(huge.mime.as_deref(), Some("image/png"));
        // Raster magic over an unreadable header is a refusal, not a pass.
        let truncated = png_fixture(4, 4)[..12].to_vec();
        assert!(sniff_image(&truncated).is_none() && has_raster_magic(&truncated));
        let refused = finish_forge_bytes(truncated, u64::MAX, None);
        assert!(refused.too_large && refused.base64.is_none() && refused.mime.is_none());
        // A readable raster ships with its sniffed type.
        let png = finish_forge_bytes(png_fixture(4, 4), u64::MAX, None);
        assert_eq!(png.mime.as_deref(), Some("image/png"));
        assert_eq!(decoded(&png), png_fixture(4, 4));
        // SVG and text carry no raster magic and ship under the byte cap alone.
        for body in [
            &b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"[..],
            b"plain\r\ntext\n",
            b"",
        ] {
            let shipped = finish_forge_bytes(body.to_vec(), 100, None);
            assert!(!shipped.too_large && shipped.mime.is_none());
            assert_eq!(decoded(&shipped), body);
            assert_eq!(shipped.size, Some(body.len() as u64));
        }
        assert_eq!(too_large(42).size, Some(42));
        assert!(too_large(42).too_large);
    }

    fn shipped(body: AppResult<GhBody>) -> FileBytes {
        match body.unwrap() {
            GhBody::Ship(bytes) => bytes,
            GhBody::ReadBlob => panic!("expected the body to ship"),
        }
    }

    #[test]
    fn every_arms_body_survives_non_utf8_bytes_unchanged() {
        for body in binary_bodies() {
            let len = body.len() as u64;
            let blob = git_blob_sha1(&body);
            let gh = shipped(gh_body(Vec::new(), 0, &git_blob_sha1(b""), u64::MAX));
            assert_eq!(decoded(&gh), b"");
            let gh = shipped(gh_body(body.clone(), len, &blob, u64::MAX));
            assert_eq!(decoded(&gh), body);
            let gh = gh_blob_answer(body.clone(), &blob, u64::MAX).unwrap();
            assert_eq!(decoded(&gh), body);
            let gl = gitlab_raw_answer(glab(0, &body, ""), u64::MAX, len, Some(&blob)).unwrap();
            assert_eq!(decoded(&gl), body);
            let bb = bitbucket_body_answer(body.clone(), u64::MAX, len).unwrap();
            assert_eq!(decoded(&bb), body);
            // GitHub's inline base64, wrapped the way the contents API wraps it.
            let encoded = base64::engine::general_purpose::STANDARD.encode(&body);
            let wrapped = encoded
                .as_bytes()
                .chunks(4)
                .map(|c| std::str::from_utf8(c).unwrap())
                .collect::<Vec<_>>()
                .join("\n");
            let plan = gh_contents_plan(contents("file", &wrapped, len, &blob), "p", u64::MAX);
            assert_eq!(plan.unwrap(), GhPlan::Bytes(body.clone(), len, blob));
        }
    }

    fn contents(kind: &str, content: &str, size: u64, sha: &str) -> GhContents {
        serde_json::from_value(json!({
            "type": kind, "size": size, "encoding": "base64", "content": content, "path": "p",
            "sha": sha
        }))
        .unwrap()
    }

    #[test]
    fn github_contents_plans_read_size_before_any_body() {
        let parse = |value: Value| serde_json::from_value::<GhContents>(value).unwrap();
        assert_eq!(
            gh_contents_plan(contents("file", "", 11, SHA), "p", 10).unwrap(),
            GhPlan::TooLarge(11)
        );
        let none = parse(json!({
            "type": "file", "size": 2_000_000, "encoding": "none", "content": "", "path": "p",
            "sha": SHA
        }));
        assert_eq!(
            gh_contents_plan(none, "p", u64::MAX).unwrap(),
            GhPlan::Raw(2_000_000, SHA.into())
        );
        let link = parse(
            json!({"type": "symlink", "target": "../real.png", "path": "p", "size": 11, "sha": SHA}),
        );
        assert_eq!(
            gh_contents_plan(link, "p", u64::MAX).unwrap(),
            GhPlan::Bytes(b"../real.png".to_vec(), 11, SHA.into())
        );
        for bad in [
            json!({"type": "file", "size": 1, "encoding": "base64", "content": "QQ==", "path": "other", "sha": SHA}),
            json!({"type": "dir", "size": 0, "path": "other", "sha": SHA}),
            json!({"type": "symlink", "path": "p", "sha": SHA}),
            json!({"type": "symlink", "target": "x", "path": "p"}),
            json!({"type": "file", "encoding": "base64", "content": "QQ==", "path": "p", "sha": SHA}),
            json!({"type": "file", "size": 1, "encoding": "base64", "content": "QQ==", "path": "p"}),
            json!({"type": "file", "size": 1, "encoding": "base64", "content": "QQ==", "path": "p", "sha": "abc1234"}),
            json!({"type": "file", "size": 1, "encoding": "base64", "content": "!!", "path": "p", "sha": SHA}),
            json!({"size": 1, "path": "p", "sha": SHA}),
        ] {
            let error = gh_contents_plan(parse(bad.clone()), "p", u64::MAX).unwrap_err();
            assert!(matches!(error, AppError::Gh(_)), "{bad}");
        }
        // A directory listing is an array, which no file answer parses as.
        assert!(serde_json::from_value::<GhContents>(json!([{"type": "file"}])).is_err());
    }

    #[test]
    fn github_reads_a_directory_or_submodule_object_as_no_file() {
        for kind in ["dir", "submodule"] {
            let answer = json!({"type": kind, "size": 0, "path": "p", "sha": SHA});
            let answer = serde_json::from_value::<GhContents>(answer).unwrap();
            assert_eq!(
                gh_contents_plan(answer, "p", u64::MAX).unwrap(),
                GhPlan::Absent,
                "{kind}"
            );
        }
    }

    #[test]
    fn github_reads_a_directory_listing_as_no_file() {
        let body = |value: Value| gh_contents_body(value.to_string().as_bytes(), "p");
        let listing = json!([
            {"type": "file", "name": "a.txt", "path": "p/a.txt", "sha": SHA},
            {"type": "dir", "name": "d", "path": "p/d", "sha": SHA},
        ]);
        assert!(body(listing).unwrap().is_none());
        let file = json!({"type": "file", "size": 1, "path": "p", "sha": SHA});
        assert!(body(file).unwrap().is_some());
        // A listing of another directory, or of nothing, is no answer for this path.
        for bad in [
            json!([]),
            json!([{"type": "file", "path": "other/a.txt", "sha": SHA}]),
            json!([{"type": "file", "path": "p", "sha": SHA}]),
            json!([{"type": "file", "sha": SHA}]),
        ] {
            assert!(matches!(body(bad.clone()), Err(AppError::Gh(_))), "{bad}");
        }
        assert!(matches!(
            gh_contents_body(b"not json", "p"),
            Err(AppError::Gh(_))
        ));
    }

    #[test]
    fn github_listing_entries_must_name_a_child() {
        let body = |value: Value| gh_contents_body(value.to_string().as_bytes(), "icon.png");
        let child = json!([{"type": "file", "path": "icon.png/a.txt", "sha": SHA}]);
        assert!(body(child).unwrap().is_none());
        for bad in [
            json!([{"type": "file", "path": "icon.png/", "sha": SHA}]),
            json!([
                {"type": "file", "path": "icon.png/a.txt", "sha": SHA},
                {"type": "dir", "path": "icon.png/", "sha": SHA},
            ]),
            json!([{"type": "file", "path": "icon.pngx/a.txt", "sha": SHA}]),
            // Only direct children: a deeper path is another directory's entry.
            json!([{"type": "file", "path": "icon.png/sub/a.txt", "sha": SHA}]),
            json!([
                {"type": "file", "path": "icon.png/a.txt", "sha": SHA},
                {"type": "file", "path": "icon.png/sub/a.txt", "sha": SHA},
            ]),
        ] {
            assert!(matches!(body(bad.clone()), Err(AppError::Gh(_))), "{bad}");
        }
    }

    #[test]
    fn github_contents_object_refuses_a_duplicated_field() {
        let twice = format!(
            r#"{{"type":"file","size":1,"path":"other.png","path":"icon.png","sha":"{SHA}"}}"#
        );
        let got = gh_contents_body(twice.as_bytes(), "icon.png");
        assert!(
            matches!(got, Err(AppError::Gh(_))),
            "{:?}",
            got.map(|c| c.is_some())
        );
        // Leading whitespace still reads an object, and an array, as what it is.
        let once = format!(r#"  {{"type":"file","size":1,"path":"icon.png","sha":"{SHA}"}}"#);
        assert!(gh_contents_body(once.as_bytes(), "icon.png")
            .unwrap()
            .is_some());
        let listing = b"\n [{\"path\":\"icon.png/a.txt\"}]";
        assert!(gh_contents_body(listing, "icon.png").unwrap().is_none());
    }

    /// Measured on git/git (`RelNotes` is a 120000 link to
    /// `Documentation/RelNotes/2.98.0.adoc`): the tree's blob for the link and its bytes.
    const LINK_BLOB: &str = "513bc0bea80652bcd4583ea0071b5cb96d172fa0";
    const LINK_TEXT: &[u8] = b"Documentation/RelNotes/2.98.0.adoc";
    /// The same bytes' blob id in a SHA-256 repository.
    const LINK_BLOB_256: &str = "21e5a8939ce9839f52415ac24c1a81e72331ae0436936d4130f179109c45781e";

    #[test]
    fn git_blob_ids_match_git() {
        assert_eq!(git_blob_sha1(LINK_TEXT), LINK_BLOB);
        // `git hash-object /dev/null`.
        assert_eq!(
            git_blob_sha1(b""),
            "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
        );
        // `git hash-object` in a `git init --object-format=sha256` repo.
        assert_eq!(git_blob_sha256(LINK_TEXT), LINK_BLOB_256);
        assert_eq!(
            git_blob_sha256(b""),
            "473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813"
        );
        for (bytes, id) in [(LINK_TEXT, LINK_BLOB), (LINK_TEXT, LINK_BLOB_256)] {
            assert!(blob_id_matches(bytes, id), "{id}");
            assert!(blob_id_matches(bytes, &id.to_uppercase()), "{id}");
            assert!(!blob_id_matches(b"other", id), "{id}");
        }
        // An id of either width must be that format's hash of these bytes.
        assert!(!blob_id_matches(LINK_TEXT, &"a".repeat(64)));
        assert!(!blob_id_matches(LINK_TEXT, &LINK_BLOB_256[..40]));
        assert!(!blob_id_matches(LINK_TEXT, &LINK_BLOB[..39]));
        assert!(!blob_id_matches(LINK_TEXT, ""));
    }

    #[test]
    fn a_github_body_of_another_blob_is_read_again_by_its_id() {
        // The followed link's answer: `type: file`, the target's bytes and size, under
        // the link blob's sha.
        let target = b"Git v2.98 Release Notes\n=======================\n".to_vec();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&target);
        let answer = serde_json::from_value::<GhContents>(json!({
            "type": "file", "path": "p", "sha": LINK_BLOB, "size": target.len(),
            "encoding": "base64", "content": encoded
        }))
        .unwrap();
        let GhPlan::Bytes(bytes, size, blob) = gh_contents_plan(answer, "p", u64::MAX).unwrap()
        else {
            panic!("expected inline bytes");
        };
        assert_eq!(blob, LINK_BLOB);
        assert!(matches!(
            gh_body(bytes, size, &blob, u64::MAX).unwrap(),
            GhBody::ReadBlob
        ));
        // The raw arm reads the same way.
        assert!(matches!(
            gh_body(target.clone(), target.len() as u64, LINK_BLOB, u64::MAX).unwrap(),
            GhBody::ReadBlob
        ));
        // A SHA-256 id is hashed the same way: its own blob ships, another is read by id.
        let shipped_256 = gh_body(LINK_TEXT.to_vec(), 34, LINK_BLOB_256, u64::MAX).unwrap();
        assert!(matches!(&shipped_256, GhBody::Ship(read) if decoded(read) == LINK_TEXT));
        assert!(matches!(
            gh_body(LINK_TEXT.to_vec(), 34, &"a".repeat(64), u64::MAX).unwrap(),
            GhBody::ReadBlob
        ));
        // The blob read by id ships the link's own bytes; anything else is an error.
        for id in [LINK_BLOB, LINK_BLOB_256] {
            let link = gh_blob_answer(LINK_TEXT.to_vec(), id, u64::MAX).unwrap();
            assert_eq!(decoded(&link), LINK_TEXT);
            assert_eq!(link.size, Some(34));
            assert!(matches!(
                gh_blob_answer(target.clone(), id, u64::MAX),
                Err(AppError::Gh(_))
            ));
        }
        assert!(matches!(
            gh_blob_answer(LINK_TEXT.to_vec(), &"a".repeat(64), u64::MAX),
            Err(AppError::Gh(_))
        ));
        let capped = gh_blob_answer(LINK_TEXT.to_vec(), LINK_BLOB, 10).unwrap();
        assert!(capped.too_large && capped.base64.is_none());
        assert_eq!(capped.size, Some(34));
        // A short or long body is an error before any hash, inline and raw alike.
        for (bytes, size) in [(b"A".to_vec(), 2), (b"AB".to_vec(), 1), (Vec::new(), 1)] {
            let blob = git_blob_sha1(&bytes);
            assert!(
                matches!(gh_body(bytes, size, &blob, u64::MAX), Err(AppError::Gh(_))),
                "{size}"
            );
        }
    }

    #[test]
    fn github_failures_are_never_absence_without_a_known_commit() {
        assert!(gh_read_outcome(gh_output(0, "{}", "")).unwrap().is_some());
        assert!(gh_read_outcome(gh_output(1, "", NOT_FOUND_STDERR))
            .unwrap()
            .is_none());
        for stderr in [
            HELD_REST_STDERR,
            ANSWERED_STDERR,
            "dial tcp: connection refused",
            "GraphQL: rate limit exceeded",
            "",
        ] {
            assert!(
                matches!(
                    gh_read_outcome(gh_output(1, "", stderr)),
                    Err(AppError::Gh(_))
                ),
                "{stderr:?}"
            );
        }
        assert!(matches!(
            gh_read_outcome(Err(AppError::GhNotFound)),
            Err(AppError::GhNotFound)
        ));
        // The confirming lookup: a known commit makes the 404 an absence; an unknown
        // commit's 404 is an error of gh's kind, never None.
        assert!(gh_commit_outcome(gh_output(0, "{}", ""), SHA).is_ok());
        let unknown = gh_commit_outcome(gh_output(1, "", NOT_FOUND_STDERR), SHA).unwrap_err();
        assert!(
            matches!(&unknown, AppError::Gh(m) if m.contains(SHA)),
            "{unknown}"
        );
        assert!(matches!(
            gh_commit_outcome(gh_output(1, "", HELD_REST_STDERR), SHA),
            Err(AppError::Gh(_))
        ));
    }

    #[test]
    fn gitlab_head_answers_split_size_absence_and_failure() {
        let ok = b"HTTP/2.0 200 OK\r\nX-Gitlab-Blob-Id: e6\r\nX-Gitlab-Size: 102\r\n\r\n";
        assert_eq!(
            gl_head_outcome(&glab(0, ok, "")).unwrap(),
            GlHead::Found {
                size: 102,
                blob_id: Some("e6".into())
            }
        );
        let lower = b"HTTP/1.1 200 OK\nx-gitlab-size:  7 \n\n";
        assert_eq!(
            gl_head_outcome(&glab(0, lower, "")).unwrap(),
            GlHead::Found {
                size: 7,
                blob_id: None
            }
        );
        let missing = b"HTTP/2.0 404 Not Found\nCache-Control: no-store\n\n";
        assert_eq!(
            gl_head_outcome(&glab(1, missing, "ERROR")).unwrap(),
            GlHead::Missing
        );
        // A 200 without a size (or with it only past the headers) would read an
        // unbounded body, so it is refused like GitHub's and Bitbucket's.
        for unsized_ok in [
            &b"HTTP/2.0 200 OK\nContent-Type: text/plain\n\nX-Gitlab-Size: 9\n"[..],
            b"HTTP/2.0 200 OK\nX-Gitlab-Size: many\n\n",
        ] {
            assert!(matches!(
                gl_head_outcome(&glab(0, unsized_ok, "")),
                Err(AppError::Glab(_))
            ));
        }
        for (code, stdout) in [
            (1, &b"HTTP/2.0 429 Too Many Requests\n\n"[..]),
            (1, b"HTTP/2.0 401 Unauthorized\n\n"),
            (1, b"HTTP/2.0 500 Internal Server Error\n\n"),
            (1, b""),
            (1, b"HTTP/2.0 200 OK\n\n"),
            (0, b"not a status line"),
        ] {
            assert!(
                matches!(
                    gl_head_outcome(&glab(code, stdout, "boom")),
                    Err(AppError::Glab(_))
                ),
                "{}",
                String::from_utf8_lossy(stdout)
            );
        }
        assert!(gl_commit_outcome(&glab(0, b"{}", ""), SHA).is_ok());
        let unknown =
            gl_commit_outcome(&glab(1, b"", "glab: 404 Commit Not Found (HTTP 404)"), SHA)
                .unwrap_err();
        assert!(
            matches!(&unknown, AppError::Glab(m) if m.contains(SHA)),
            "{unknown}"
        );
        assert!(matches!(
            gl_commit_outcome(&glab(1, b"", "dial tcp: connection refused"), SHA),
            Err(AppError::Glab(_))
        ));
    }

    /// A 429 from the HEAD read must reach forge-backoff.ts `isRateLimitError`, whose
    /// matcher is `matches(text, RATE_LIMIT_PHRASES, RATE_LIMIT_STATUS)` over the
    /// lowercased message: "too many requests" as a substring, or a standalone "http 429".
    #[test]
    fn gitlab_head_statuses_keep_their_code_for_the_frontend_classifiers() {
        // glab's own error for a bodiless answer, which named no status.
        let json_noise = "ERROR\n\nUnexpected end of JSON input.";
        let message = |stdout: &[u8]| match gl_head_outcome(&glab(1, stdout, json_noise)) {
            Err(AppError::Glab(message)) => message,
            other => panic!("expected a glab error, got {other:?}"),
        };
        let limited = message(b"HTTP/2.0 429 Too Many Requests\nRetry-After: 60\n\n");
        assert_eq!(limited, "429 Too Many Requests (HTTP 429)");
        let lower = limited.to_lowercase();
        assert!(lower.contains("too many requests") && lower.contains("(http 429)"));
        assert_eq!(
            message(b"HTTP/2.0 401 Unauthorized\n\n"),
            "401 Unauthorized (HTTP 401)"
        );
        assert_eq!(message(b"HTTP/1.1 503\n\n"), "503 (HTTP 503)");
        assert!(!message(b"HTTP/2.0 500 Internal Server Error\n\n").contains("JSON"));
        // No status line: glab's own words are all there is.
        assert!(message(b"").contains("Unexpected end of JSON input."));
    }

    #[test]
    fn gitlab_bodies_must_be_the_sized_blob() {
        let body = b"print('hi')\n".to_vec();
        let len = body.len() as u64;
        let blob = git_blob_sha1(&body);
        // `git hash-object` of the same bytes in a SHA-256 repository.
        let blob_256 = "fa6030fda55d07405b0121c6857402a405c7dbac40c83efd6b6df392da5c7a73";
        let out = || glab(0, &body, "");
        for blob_id in [None, Some(blob.as_str()), Some(blob_256)] {
            let read = gitlab_raw_answer(out(), u64::MAX, len, blob_id).unwrap();
            assert_eq!(decoded(&read), body);
        }
        for (size, blob_id) in [
            (len + 1, None),
            (len - 1, Some(blob.as_str())),
            (len, Some(LINK_BLOB)),
            (len, Some(LINK_BLOB_256)),
            (len, Some(&"a".repeat(64))),
            (len, Some("e6")),
        ] {
            assert!(
                matches!(
                    gitlab_raw_answer(out(), u64::MAX, size, blob_id),
                    Err(AppError::Glab(_))
                ),
                "{size} {blob_id:?}"
            );
        }
    }

    #[test]
    fn gitlab_merge_bases_answer_only_for_the_callers_head() {
        let base = "b".repeat(40);
        let head = "c".repeat(40);
        let mr = |head_sha: &str| json!({"diff_refs": {"base_sha": base, "start_sha": "d".repeat(40), "head_sha": head_sha}});
        let outcome = |mr: &Value, head: &str| gl_merge_base_outcome(mr, head, None, None);
        assert_eq!(outcome(&mr(&head), &head).unwrap(), base);
        assert_eq!(outcome(&mr(&head.to_uppercase()), &head).unwrap(), base);
        // The caller's base sha and target branch must be the merge request's.
        let mut targeted = mr(&head);
        targeted["target_branch"] = json!("main");
        let caller = |base_ref: Option<&str>, base_sha: Option<&str>| {
            gl_merge_base_outcome(&targeted, &head, base_ref, base_sha)
        };
        assert_eq!(
            caller(Some("main"), Some(&base.to_uppercase())).unwrap(),
            base
        );
        assert_eq!(caller(None, None).unwrap(), base);
        let other = "f".repeat(40);
        for (base_ref, base_sha) in [(Some("develop"), None), (None, Some(other.as_str()))] {
            assert!(
                matches!(caller(base_ref, base_sha), Err(AppError::Glab(_))),
                "{base_ref:?} {base_sha:?}"
            );
        }
        // Right after a push the refs still pair the old base with the old head.
        let moved = outcome(&mr(&"e".repeat(40)), &head).unwrap_err();
        assert!(
            matches!(&moved, AppError::Glab(m) if m.contains(&head)),
            "{moved}"
        );
        for bad in [
            json!({}),
            json!({"diff_refs": null}),
            json!({"diff_refs": {"base_sha": base}}),
            json!({"diff_refs": {"head_sha": head}}),
            json!({"diff_refs": {"base_sha": "", "head_sha": head}}),
        ] {
            assert!(
                matches!(outcome(&bad, &head), Err(AppError::Glab(_))),
                "{bad}"
            );
        }
    }

    #[test]
    fn live_bases_refuse_a_retargeted_pull_request() {
        let base = "b".repeat(40);
        let gh = json!({ "base": { "sha": base, "ref": "main" } });
        assert_eq!(gh_live_base_outcome(&gh, Some("main")).unwrap(), base);
        assert_eq!(gh_live_base_outcome(&gh, None).unwrap(), base);
        let retargeted = gh_live_base_outcome(&gh, Some("develop"));
        assert!(
            matches!(&retargeted, Err(AppError::Gh(m)) if m.contains("develop")),
            "{retargeted:?}"
        );
        // The branch is the caller's one base identity here, so it must be named.
        for unnamed in [
            json!({ "base": { "sha": base } }),
            json!({ "base": { "sha": base, "ref": "" } }),
            json!({ "base": { "sha": base, "ref": null } }),
        ] {
            assert!(
                matches!(
                    gh_live_base_outcome(&unnamed, Some("main")),
                    Err(AppError::Gh(_))
                ),
                "{unnamed}"
            );
            assert!(
                matches!(
                    gh_live_base_outcome(&unnamed, Some("")),
                    Err(AppError::Gh(_))
                ),
                "{unnamed}"
            );
        }
        let bb = json!({
            "destination": { "commit": { "hash": "abcdef123456" }, "branch": { "name": "main" } }
        });
        assert_eq!(
            bb_destination_outcome(&bb, Some("main")).unwrap(),
            "abcdef123456"
        );
        assert_eq!(bb_destination_outcome(&bb, None).unwrap(), "abcdef123456");
        assert!(matches!(
            bb_destination_outcome(&bb, Some("develop")),
            Err(AppError::Bitbucket(_))
        ));
        for name in [json!(""), Value::Null] {
            let mut unnamed = bb.clone();
            unnamed["destination"]["branch"]["name"] = name;
            for want in ["main", ""] {
                assert!(
                    matches!(
                        bb_destination_outcome(&unnamed, Some(want)),
                        Err(AppError::Bitbucket(_))
                    ),
                    "{unnamed} {want:?}"
                );
            }
        }
    }

    #[test]
    fn gitlab_merge_bases_need_a_named_target_without_a_base_sha() {
        let base = "b".repeat(40);
        let head = "c".repeat(40);
        let refs = json!({"base_sha": base, "start_sha": base, "head_sha": head});
        for target in [None, Some(""), Some("main")] {
            let mut mr = json!({ "diff_refs": refs });
            if let Some(target) = target {
                mr["target_branch"] = json!(target);
            }
            let named = gl_merge_base_outcome(&mr, &head, Some("main"), None);
            assert_eq!(
                named.is_ok(),
                target == Some("main"),
                "{target:?} {named:?}"
            );
            assert!(
                gl_merge_base_outcome(&mr, &head, Some(""), None).is_err(),
                "{target:?}"
            );
            // The caller's base sha ties the base when the branch can't be read.
            if target != Some("main") {
                assert_eq!(
                    gl_merge_base_outcome(&mr, &head, Some("main"), Some(&base)).unwrap(),
                    base
                );
            }
        }
    }

    #[test]
    fn bitbucket_reads_a_directory_as_no_file() {
        let directory = r#"{"type":"commit_directory","path":"README.md"}"#;
        assert_eq!(
            bb_meta_outcome(200, directory, "README.md").unwrap(),
            BbMeta::Directory
        );
    }

    #[test]
    fn bitbucket_meta_answers_split_size_absence_and_failure() {
        // Measured on dispatch-demo: README.md answers `attributes: []`, a PNG `["binary"]`.
        let file = r#"{"type":"commit_file","size":642,"path":"README.md","attributes":[]}"#;
        assert_eq!(
            bb_meta_outcome(200, file, "README.md").unwrap(),
            BbMeta::Size(642)
        );
        let plain = r#"{"type":"commit_file","size":9,"path":"a/b.png","attributes":["binary"]}"#;
        assert_eq!(
            bb_meta_outcome(200, plain, "a/b.png").unwrap(),
            BbMeta::Size(9)
        );
        assert_eq!(
            bb_meta_outcome(404, "{}", "README.md").unwrap(),
            BbMeta::Missing
        );
        for (status, body) in [
            (200, r#"{"type":"commit_directory","path":"docs"}"#),
            (200, r#"{"type":"commit_link","path":"README.md"}"#),
            (200, r#"{"type":"commit_file","path":"README.md"}"#),
            (200, "not json"),
            // An answer for another path, or for none.
            (
                200,
                r#"{"type":"commit_file","size":642,"path":"docs/README.md"}"#,
            ),
            (200, r#"{"type":"commit_file","size":642}"#),
            // No readable attribute list: the body could be any of the kinds below.
            (
                200,
                r#"{"type":"commit_file","size":642,"path":"README.md"}"#,
            ),
            (
                200,
                r#"{"type":"commit_file","size":642,"path":"README.md","attributes":null}"#,
            ),
            (
                200,
                r#"{"type":"commit_file","size":642,"path":"README.md","attributes":"lfs"}"#,
            ),
            (
                200,
                r#"{"type":"commit_file","size":642,"path":"README.md","attributes":[{"lfs":true}]}"#,
            ),
            // A body that isn't the git blob: a link, an LFS object, a submodule.
            (
                200,
                r#"{"type":"commit_file","size":642,"path":"README.md","attributes":["link"]}"#,
            ),
            (
                200,
                r#"{"type":"commit_file","size":130,"path":"README.md","attributes":["binary","lfs"]}"#,
            ),
            (
                200,
                r#"{"type":"commit_file","size":0,"path":"README.md","attributes":["subrepository"]}"#,
            ),
            (401, "{}"),
            (403, "{}"),
            (429, "{}"),
            (500, "oops"),
        ] {
            assert!(
                matches!(
                    bb_meta_outcome(status, body, "README.md"),
                    Err(AppError::Bitbucket(_))
                ),
                "{status} {body}"
            );
        }
        assert!(bb_commit_outcome(200, "{}", SHA).is_ok());
        let unknown = bb_commit_outcome(404, "{}", SHA).unwrap_err();
        assert_eq!(
            unknown.to_string(),
            AppError::Bitbucket(format!("Bitbucket doesn't have commit {SHA}.")).to_string()
        );
        for status in [401, 500] {
            assert!(matches!(
                bb_commit_outcome(status, "{}", SHA),
                Err(AppError::Bitbucket(m)) if !m.contains("doesn't have commit")
            ));
        }
    }

    #[test]
    fn bitbucket_bodies_and_hashes_are_checked() {
        let read = bitbucket_body_answer(b"abc".to_vec(), u64::MAX, 3).unwrap();
        assert_eq!(decoded(&read), b"abc");
        for size in [2, 4] {
            assert!(matches!(
                bitbucket_body_answer(b"abc".to_vec(), u64::MAX, size),
                Err(AppError::Bitbucket(_))
            ));
        }
        assert!(bb_short_hash("abcdef123456") && bb_short_hash(&"a".repeat(64)));
        let too_long = "a".repeat(65);
        for bad in ["", "abc1234", "abcdef12345", "abcdef12345g", &too_long] {
            assert!(!bb_short_hash(bad), "{bad}");
        }
    }

    /// A test git run in `dir` on the hang guard, whatever its exit code.
    async fn git_run(dir: &str, args: &[&str]) -> crate::git::runner::GitOutput {
        run_git_raw(Some(dir), args, TEST_GIT_HANG_GUARD)
            .await
            .unwrap()
    }

    async fn git(repo: &str, args: &[&str]) -> String {
        let out = git_run(repo, args).await;
        assert_eq!(out.code, 0, "git {args:?}: {}", out.stderr);
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A `--depth` clone of `origin` at `<dir>/shallow`, over a `file://` URL: git
    /// ignores `--depth` on a plain-path local clone.
    async fn shallow_clone(dir: &std::path::Path, origin: &str, depth: &str) -> String {
        let slashed = origin.replace('\\', "/");
        let url = if slashed.starts_with('/') {
            format!("file://{slashed}")
        } else {
            format!("file:///{slashed}")
        };
        let shallow = dir.join("shallow").to_string_lossy().into_owned();
        let parent = dir.to_string_lossy().into_owned();
        git(
            &parent,
            &[
                "clone",
                "-q",
                "--depth",
                depth,
                "--no-single-branch",
                &url,
                &shallow,
            ],
        )
        .await;
        shallow
    }

    #[tokio::test]
    async fn the_local_arm_answers_git_merge_base() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_string_lossy().into_owned();
        git(&repo, &["init", "-q", "-b", "main"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        git(&repo, &["config", "user.email", "t@example.invalid"]).await;
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "root"]).await;
        let fork = git(&repo, &["rev-parse", "HEAD"]).await;
        git(&repo, &["checkout", "-q", "-b", "topic"]).await;
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "topic"]).await;
        let head = git(&repo, &["rev-parse", "HEAD"]).await;
        git(&repo, &["checkout", "-q", "main"]).await;
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "main"]).await;
        let base = git(&repo, &["rev-parse", "HEAD"]).await;
        let expected = git(&repo, &["merge-base", &base, &head]).await;
        assert_eq!(expected, fork);
        assert_eq!(
            local_merge_base(&repo, &base, &head).await.unwrap(),
            expected
        );
        git(&repo, &["checkout", "-q", "--orphan", "other"]).await;
        git(&repo, &["commit", "-q", "--allow-empty", "-m", "unrelated"]).await;
        let unrelated = git(&repo, &["rev-parse", "HEAD"]).await;
        assert!(matches!(
            local_merge_base(&repo, &unrelated, &head).await,
            Err(AppError::Git { .. })
        ));
    }

    /// A shallow clone holds both tips but not the merge base behind its boundary: the
    /// forge answers then, and a clone that can answer is never asked past.
    #[tokio::test]
    async fn a_local_merge_base_failure_falls_back_to_the_forge() {
        let dir = tempfile::tempdir().unwrap();
        let origin = dir.path().join("origin").to_string_lossy().into_owned();
        std::fs::create_dir(&origin).unwrap();
        git(&origin, &["init", "-q", "-b", "main"]).await;
        git(&origin, &["config", "user.name", "t"]).await;
        git(&origin, &["config", "user.email", "t@example.invalid"]).await;
        git(&origin, &["commit", "-q", "--allow-empty", "-m", "root"]).await;
        let fork = git(&origin, &["rev-parse", "HEAD"]).await;
        git(&origin, &["checkout", "-q", "-b", "topic"]).await;
        git(&origin, &["commit", "-q", "--allow-empty", "-m", "topic"]).await;
        let head = git(&origin, &["rev-parse", "HEAD"]).await;
        git(&origin, &["checkout", "-q", "main"]).await;
        git(&origin, &["commit", "-q", "--allow-empty", "-m", "main"]).await;
        let base = git(&origin, &["rev-parse", "HEAD"]).await;

        let shallow = shallow_clone(dir.path(), &origin, "1").await;
        let both = vec![base.clone(), head.clone()];
        assert!(
            crate::git::compare::git_objects_present(shallow.clone(), both)
                .await
                .unwrap()
        );
        assert!(local_merge_base(&shallow, &base, &head).await.is_err());

        let forge = "f".repeat(40);
        let answer =
            merge_base_local_first(&shallow, &base, &head, true, async { Ok(forge.clone()) }).await;
        assert_eq!(answer.unwrap(), forge);
        // The full clone answers itself; the forge's answer is never awaited.
        let unused = async { Err(AppError::Gh("asked the forge".into())) };
        let local = merge_base_local_first(&origin, &base, &head, true, unused).await;
        assert_eq!(local.unwrap(), fork);
        // Objects missing: straight to the forge.
        let skipped =
            merge_base_local_first(&origin, &base, &head, false, async { Ok(forge.clone()) }).await;
        assert_eq!(skipped.unwrap(), forge);
    }

    /// Past a shallow boundary git can answer an older common ancestor: base and head
    /// each merge the root, so the root is reachable from both while the true merge base
    /// hides behind the topic side's boundary. A shallow clone asks the forge.
    #[tokio::test]
    async fn a_shallow_clone_never_trusts_its_own_merge_base() {
        let dir = tempfile::tempdir().unwrap();
        let origin = dir.path().join("origin").to_string_lossy().into_owned();
        std::fs::create_dir(&origin).unwrap();
        git(&origin, &["init", "-q", "-b", "main"]).await;
        git(&origin, &["config", "user.name", "t"]).await;
        git(&origin, &["config", "user.email", "t@example.invalid"]).await;
        git(&origin, &["commit", "-q", "--allow-empty", "-m", "root"]).await;
        let root = git(&origin, &["rev-parse", "HEAD"]).await;
        let tree = git(&origin, &["rev-parse", "HEAD^{tree}"]).await;
        let commit = |parents: Vec<String>, msg: &'static str| {
            let origin = origin.clone();
            let tree = tree.clone();
            async move {
                let mut args = vec!["commit-tree".to_string(), tree, "-m".into(), msg.into()];
                for p in parents {
                    args.extend(["-p".to_string(), p]);
                }
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                git(&origin, &args).await
            }
        };
        let fork = commit(vec![root.clone()], "fork").await;
        let base = commit(vec![fork.clone(), root.clone()], "base").await;
        let topic = commit(vec![fork.clone()], "topic").await;
        let head = commit(vec![topic, root.clone()], "head").await;
        git(&origin, &["update-ref", "refs/heads/main", &base]).await;
        git(&origin, &["update-ref", "refs/heads/topic", &head]).await;
        assert_eq!(git(&origin, &["merge-base", &base, &head]).await, fork);

        let shallow = shallow_clone(dir.path(), &origin, "2").await;
        let all = vec![base.clone(), head.clone(), fork.clone(), root.clone()];
        assert!(
            crate::git::compare::git_objects_present(shallow.clone(), all)
                .await
                .unwrap()
        );
        // The premise: the shallow clone answers, and answers the older ancestor.
        assert_eq!(
            local_merge_base(&shallow, &base, &head).await.unwrap(),
            root
        );
        assert!(is_shallow(&shallow).await.unwrap());
        assert!(!is_shallow(&origin).await.unwrap());

        let answer =
            merge_base_local_first(&shallow, &base, &head, true, async { Ok(fork.clone()) }).await;
        assert_eq!(answer.unwrap(), fork);
        let unused = async { Err(AppError::Gh("asked the forge".into())) };
        let local = merge_base_local_first(&origin, &base, &head, true, unused).await;
        assert_eq!(local.unwrap(), fork);
    }

    /// How a live test reaches the forge: through the commands, or straight to the
    /// Bitbucket arms with the stored pair, since `load_credentials`' test slot is
    /// background.rs's alone.
    #[derive(Clone, Copy)]
    enum Live<'a> {
        Commands,
        Bitbucket(&'a BbCredentials),
    }

    impl Live<'_> {
        async fn file(
            self,
            repo: &str,
            sha: &str,
            path: &str,
            max_bytes: Option<u64>,
        ) -> AppResult<Option<FileBytes>> {
            match self {
                Live::Commands => {
                    forge_file_at_sha(repo.into(), sha.into(), path.into(), None, max_bytes).await
                }
                Live::Bitbucket(creds) => {
                    let segments = file_segments(path)?;
                    let cap = effective_cap(max_bytes);
                    bitbucket_file(creds, repo, sha, path, &segments, cap).await
                }
            }
        }

        async fn merge_base(self, repo: &str, number: u64, head: &str) -> AppResult<String> {
            match self {
                Live::Commands => {
                    let revs =
                        forge_pr_content_revs(repo.into(), number, None, head.into(), None, None)
                            .await?;
                    assert_eq!(revs.new_sha, head);
                    Ok(revs.old_sha)
                }
                Live::Bitbucket(creds) => {
                    bitbucket_merge_base(creds, repo, number, head, None).await
                }
            }
        }

        async fn first_parent(self, repo: &str, oid: &str) -> AppResult<Option<String>> {
            match self {
                Live::Commands => forge_commit_first_parent(repo.into(), oid.into(), None).await,
                Live::Bitbucket(creds) => bitbucket_first_parent(creds, repo, oid).await,
            }
        }
    }

    /// Live, read-only: each forge's answers against the fixture clone's own objects.
    /// Run one at a time with `GD_LIVE_FIXTURE_ROOT` set and `-- --ignored --exact <path>`.
    async fn live_matches_local(live: Live<'_>, repo: &str, pairs: &[(&str, &str)]) {
        for (sha, path) in pairs {
            let local = run_git_raw(
                Some(repo),
                &["show", &format!("{sha}:{path}")],
                TEST_GIT_HANG_GUARD,
            )
            .await
            .unwrap();
            assert_eq!(local.code, 0, "{sha}:{path}");
            let read = live.file(repo, sha, path, None).await.unwrap().unwrap();
            assert_eq!(decoded(&read), local.stdout, "{sha}:{path}");
            println!(
                "live {repo} {sha}:{path} = {} B, identical",
                local.stdout.len()
            );
        }
        let (sha, path) = pairs[0];
        let missing = live
            .file(repo, sha, &format!("{path}.absent"), None)
            .await
            .unwrap();
        assert!(missing.is_none());
        let unknown = live.file(repo, &"f".repeat(40), path, None).await;
        match &unknown {
            Ok(_) => panic!("an unknown commit read as Ok"),
            Err(error) => println!(
                "live unknown commit -> Err: {}",
                error.to_string().lines().next().unwrap_or("")
            ),
        }
        let capped = live.file(repo, sha, path, Some(1)).await.unwrap().unwrap();
        assert!(capped.too_large && capped.base64.is_none());
    }

    async fn live_revs_match_local(
        live: Live<'_>,
        repo: &str,
        number: u64,
        head: &str,
        base_tip: &str,
    ) {
        let old_sha = live.merge_base(repo, number, head).await.unwrap();
        let local = git(repo, &["merge-base", base_tip, head]).await;
        println!("live {repo} #{number} merge base {old_sha} (local {local})");
        assert_eq!(old_sha, local);
        let parent = live.first_parent(repo, head).await.unwrap();
        assert_eq!(
            parent.as_deref(),
            Some(
                git(repo, &["rev-parse", &format!("{head}^1")])
                    .await
                    .as_str()
            )
        );
    }

    /// The live fixture clone `name` under `GD_LIVE_FIXTURE_ROOT`. Unset, the test is
    /// skipped and says so; set but missing the clone panics, since an absent fixture
    /// must never read as a pass.
    fn fixture(name: &str) -> Option<String> {
        let Some(root) = std::env::var_os("GD_LIVE_FIXTURE_ROOT") else {
            eprintln!("skipped: GD_LIVE_FIXTURE_ROOT is unset, so no live fixture is read");
            return None;
        };
        let path = std::path::Path::new(&root).join(name);
        assert!(path.is_dir(), "live fixture {} is missing", path.display());
        Some(path.to_string_lossy().into_owned())
    }

    #[tokio::test]
    #[ignore = "live forge reads; needs GD_LIVE_FIXTURE_ROOT/dispatch-demo and a stored token"]
    async fn live_bitbucket_reads_match_git() {
        let Some(repo) = fixture("dispatch-demo") else {
            return;
        };
        // Test builds refuse the keyring inside `load_credentials`; this opt-in live
        // probe reads the stored pair itself and hands it to the Bitbucket arms.
        let secret = |key| {
            crate::secrets::read_forge_secret(http::BB_HOST, key)
                .unwrap()
                .unwrap()
        };
        let creds = BbCredentials {
            email: secret(http::KEY_EMAIL),
            token: secret(http::KEY_TOKEN),
        };
        let live = Live::Bitbucket(&creds);
        let png = git(&repo, &["rev-parse", "2375ce8b"]).await;
        let readme = git(&repo, &["rev-parse", "db7d0969"]).await;
        live_matches_local(
            live,
            &repo,
            &[
                (&png, "src/lib/images/svelte-welcome.png"),
                (&readme, "README.md"),
            ],
        )
        .await;
        let base = bb_repo_base(&repo).await.unwrap();
        for number in [1, 7] {
            let pr: Value = http::bb_get_json(
                &creds,
                &format!("{base}/pullrequests/{number}"),
                "pull request",
                BbOpKind::Read,
            )
            .await
            .unwrap();
            let short = |side: &str| {
                pr.pointer(&format!("/{side}/commit/hash"))
                    .and_then(Value::as_str)
                    .unwrap()
                    .to_string()
            };
            let head = git(&repo, &["rev-parse", &short("source")]).await;
            let dest = git(&repo, &["rev-parse", &short("destination")]).await;
            live_revs_match_local(live, &repo, number, &head, &dest).await;
        }
    }

    #[tokio::test]
    #[ignore = "live forge reads; needs GD_LIVE_FIXTURE_ROOT/gitdesktop-gitlab-demo and glab auth"]
    async fn live_gitlab_reads_match_git() {
        let Some(repo) = fixture("gitdesktop-gitlab-demo") else {
            return;
        };
        let sha = "b85aba600beec62db61cd8c5dc1cab2aa562da73";
        live_matches_local(
            Live::Commands,
            &repo,
            &[
                (sha, "README.md"),
                (sha, "src/app.py"),
                (sha, ".gitlab/child-quality.yml"),
            ],
        )
        .await;
        let parent = forge_commit_first_parent(repo.clone(), sha.into(), None)
            .await
            .unwrap();
        assert_eq!(
            parent.as_deref(),
            Some("e9c187fb046d0252159ec5bf8a2fd5eba22c480e")
        );
        let enc = gitlab_project(&repo).await.unwrap();
        let mr = glab_json(&repo, &format!("projects/{enc}/merge_requests/64"), "mr")
            .await
            .unwrap();
        let start = sha_at(&mr, "/diff_refs/start_sha").unwrap();
        let head = sha_at(&mr, "/diff_refs/head_sha").unwrap();
        live_revs_match_local(Live::Commands, &repo, 64, &head, &start).await;
    }

    /// Live, read-only: git/git's `RelNotes` is a link to an in-repo file, which the
    /// contents API follows; the reader must return the link blob's own bytes.
    #[tokio::test]
    #[ignore = "live forge reads; needs GD_LIVE_FIXTURE_ROOT set (any value) and gh auth"]
    async fn live_github_followed_link_reads_the_link_blob() {
        if std::env::var_os("GD_LIVE_FIXTURE_ROOT").is_none() {
            eprintln!("skipped: GD_LIVE_FIXTURE_ROOT is unset, so no live read runs");
            return;
        }
        // A bare clone stand-in: only its origin URL is read.
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().to_string_lossy().into_owned();
        git(&repo, &["init", "-q", "-b", "main"]).await;
        git(
            &repo,
            &["remote", "add", "origin", "https://github.com/git/git.git"],
        )
        .await;
        let commit = "f7de81456940dd6f3274e461149bba12965de609";
        let read = forge_file_at_sha(repo, commit.into(), "RelNotes".into(), None, None)
            .await
            .unwrap()
            .unwrap();
        let bytes = decoded(&read);
        println!(
            "live git/git {commit}:RelNotes = {} B {:?}",
            bytes.len(),
            String::from_utf8_lossy(&bytes)
        );
        assert_eq!(bytes, LINK_TEXT);
        assert_eq!(git_blob_sha1(&bytes), LINK_BLOB);
        assert_eq!(read.size, Some(LINK_TEXT.len() as u64));
    }

    #[tokio::test]
    #[ignore = "live forge reads; needs GD_LIVE_FIXTURE_ROOT/GitDesktopTesting and gh auth"]
    async fn live_github_reads_match_git() {
        let Some(repo) = fixture("GitDesktopTesting") else {
            return;
        };
        let base = "73b582487b0491471273733a809943044684e17b";
        live_matches_local(
            Live::Commands,
            &repo,
            &[(base, "src/assets/hero.png"), (base, "src/style.css")],
        )
        .await;
        live_revs_match_local(
            Live::Commands,
            &repo,
            152,
            "b739cdf906b34cf5fa035362d4d4a7116d1c41a7",
            "0ee260bca3c925c2586e041aff906b281973a689",
        )
        .await;
        // The fork PR's head is not local: the compare arm answers.
        let fork = forge_pr_content_revs(
            repo.clone(),
            84,
            None,
            "3080dcb5570904def71e7feee50ceeeb0c02d8c0".into(),
            None,
            None,
        )
        .await
        .unwrap();
        println!("live github #84 merge base {}", fork.old_sha);
        assert_eq!(fork.old_sha, base);
        let read = forge_file_at_sha(
            repo.clone(),
            fork.new_sha,
            "src/style.css".into(),
            None,
            None,
        )
        .await
        .unwrap()
        .unwrap();
        println!("live github #84 head src/style.css = {:?} B", read.size);
    }

    // ── The local `-w` diff ──────────────────────────────────────────────────────

    fn b64(bytes: &[u8]) -> Option<String> {
        Some(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    /// The command's path past its root lookup, over a throwaway root: tests never touch
    /// the app's real cache dir.
    async fn ws_diff(old: Option<&[u8]>, new: Option<&[u8]>) -> WhitespaceHunks {
        let base = tempfile::tempdir().unwrap();
        let (old, new) =
            whitespace_sides(old.and_then(b64).as_deref(), new.and_then(b64).as_deref()).unwrap();
        whitespace_diff_in(base.path().join(WHITESPACE_DIFF_ROOT), old, new)
            .await
            .unwrap()
    }

    #[test]
    fn the_root_is_the_cache_dirs_folder_and_an_unset_one_refuses() {
        let cell = std::sync::OnceLock::new();
        let refused = whitespace_root_in(&cell);
        assert!(
            matches!(&refused, Err(AppError::Command(m)) if m == WHITESPACE_ROOT_UNSET),
            "{refused:?}"
        );
        let base = tempfile::tempdir().unwrap();
        init_whitespace_root_in(&cell, &base.path().join("cache"));
        init_whitespace_root_in(&cell, &base.path().join("other"));
        let root = whitespace_root_in(&cell).unwrap();
        assert!(root.is_absolute());
        assert_eq!(root, base.path().join("cache").join("pr-ws-diff"));
        // The first run creates the missing cache dir and the root inside it.
        private_run_dir(&root).unwrap().close().unwrap();
        assert_eq!(entries(base.path()), ["cache"]);
        assert_eq!(entries(&root), Vec::<String>::new());
    }

    /// The header git prints (temp paths included) never reaches `hunks`.
    fn assert_hunks_only(hunks: &str) {
        assert!(!hunks.contains(WHITESPACE_DIFF_ROOT), "{hunks}");
        for line in hunks.lines() {
            assert!(
                !line.starts_with("diff --git")
                    && !line.starts_with("--- ")
                    && !line.starts_with("+++ ")
                    && !line.starts_with("Binary files "),
                "{hunks}"
            );
        }
        if !hunks.is_empty() {
            assert!(hunks.starts_with("@@ "), "{hunks}");
        }
    }

    fn hunk_count(hunks: &str) -> usize {
        hunks.lines().filter(|l| l.starts_with("@@ ")).count()
    }

    /// Twenty lines, `c` at index 2 and `d` at index 17: far enough apart that a change
    /// at each is its own hunk.
    fn twenty(c: &str, d: &str) -> Vec<u8> {
        let mut lines: Vec<String> = (0..20).map(|i| format!("line {i}")).collect();
        lines[2] = c.into();
        lines[17] = d.into();
        format!("{}\n", lines.join("\n")).into_bytes()
    }

    /// A unique temp prefix per test, so "the dir is gone" reads no other run's dirs.
    fn test_prefix(name: &str) -> String {
        format!("gd-pr-ws-test-{}-{name}-", std::process::id())
    }

    /// The names directly under `dir`, sorted; a missing dir holds none.
    fn entries(dir: &Path) -> Vec<String> {
        let Ok(read) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut names: Vec<String> = read
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    fn dir_link(target: &Path, link: &Path) {
        #[cfg(windows)]
        crate::test_junction::make_junction(link, target);
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[tokio::test]
    async fn whitespace_diffs_keep_only_the_hunks_that_change_content() {
        let indented = ws_diff(
            Some(b"fn a() {\n  body();\n}\n"),
            Some(b"fn a() {\n    body();\n}\n"),
        )
        .await;
        assert_eq!(indented.hunks, "");
        assert!(!indented.is_binary);

        let mixed = ws_diff(
            Some(&twenty("  keep", "old text")),
            Some(&twenty("        keep", "new text")),
        )
        .await;
        assert_hunks_only(&mixed.hunks);
        assert_eq!(hunk_count(&mixed.hunks), 1, "{}", mixed.hunks);
        assert!(mixed.hunks.contains("\n-old text\n"), "{}", mixed.hunks);
        assert!(mixed.hunks.contains("\n+new text\n"), "{}", mixed.hunks);
        assert!(!mixed.hunks.contains("keep"), "{}", mixed.hunks);

        let added = ws_diff(None, Some(b"one\ntwo\n")).await;
        assert_hunks_only(&added.hunks);
        assert_eq!(added.hunks, "@@ -0,0 +1,2 @@\n+one\n+two\n");

        let removed = ws_diff(Some(b"one\n"), None).await;
        assert_eq!(removed.hunks, "@@ -1 +0,0 @@\n-one\n");

        let endings = ws_diff(Some(b"a\r\nb\r\n"), Some(b"a\nb\n")).await;
        assert_eq!(endings.hunks, "");
        assert!(!endings.is_binary);

        let same = ws_diff(Some(b"x\n"), Some(b"x\n")).await;
        assert_eq!(same.hunks, "");
    }

    #[tokio::test]
    async fn whitespace_diffs_report_binary_pairs_and_survive_non_utf8_bytes() {
        let binary = ws_diff(Some(b"a\0b\n"), Some(b"a\0c\n")).await;
        assert!(binary.is_binary);
        assert_eq!(binary.hunks, "");

        let latin = ws_diff(Some(b"\xff\xfe a\n"), Some(b"\xff\xfe b\n")).await;
        assert!(!latin.is_binary);
        assert_hunks_only(&latin.hunks);
        assert_eq!(hunk_count(&latin.hunks), 1, "{}", latin.hunks);
        assert!(latin.hunks.contains(char::REPLACEMENT_CHARACTER));
    }

    #[tokio::test]
    async fn whitespace_diffs_refuse_bad_sides_by_kind() {
        let over = vec![b'x'; WHITESPACE_SIDE_MAX_BYTES + 1];
        let cases: [(Option<String>, Option<String>); 4] = [
            (None, None),
            (Some("not base64!".into()), None),
            (None, Some("QUJD=x".into())),
            (b64(&over), Some(String::new())),
        ];
        for (old, new) in cases {
            let label = format!("{:?}", (old.as_deref().map(str::len), new.as_deref()));
            let refused = git_diff_bytes_ignoring_whitespace(old, new).await;
            assert!(
                matches!(refused, Err(AppError::InvalidArgument(_))),
                "{label}: {refused:?}"
            );
        }
        // The ceiling itself is accepted, and an empty side is an empty file.
        let at_cap = vec![b'x'; WHITESPACE_SIDE_MAX_BYTES];
        let (old, new) = whitespace_sides(b64(&at_cap).as_deref(), Some("")).unwrap();
        assert_eq!((old.len(), new.len()), (WHITESPACE_SIDE_MAX_BYTES, 0));
    }

    /// Without `-w` the same re-indent pair has hunks: the flag, not the fixture, empties it.
    #[tokio::test]
    async fn the_same_pair_without_ignore_whitespace_has_hunks() {
        let (old, new) = (b"fn a() {\n  body();\n}\n", b"fn a() {\n    body();\n}\n");
        // The product's `-w` run leaves nothing behind on success.
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("runs");
        let ignoring = with_ignore_whitespace(
            &["diff", "--no-ext-diff", "--no-index", "--no-color"],
            Some(true),
        );
        let stdout = diff_written_pair(root.clone(), &ignoring, old.to_vec(), new.to_vec())
            .await
            .unwrap();
        assert_eq!(whitespace_hunks(&stdout).hunks, "");
        assert!(root.is_dir());
        assert_eq!(entries(&root), Vec::<String>::new());

        let dir = crate::agent_sandbox::private_temp_dir(&test_prefix("plain-run")).unwrap();
        std::fs::write(dir.path().join("old"), old).unwrap();
        std::fs::write(dir.path().join("new"), new).unwrap();
        let mut args =
            with_ignore_whitespace(&["diff", "--no-ext-diff", "--no-index", "--no-color"], None);
        args.extend(["--", "old", "new"]);
        let out = git_run(&dir.path().to_string_lossy(), &args).await;
        assert_eq!(out.code, 1, "{}", out.stderr);
        let plain = whitespace_hunks(&out.stdout);
        assert_hunks_only(&plain.hunks);
        assert_eq!(hunk_count(&plain.hunks), 1, "{}", plain.hunks);
        assert!(plain.hunks.contains("\n-  body();\n+    body();\n"));
        dir.close().unwrap();
    }

    #[test]
    fn a_no_index_diff_passes_exit_0_and_an_exit_1_that_printed_a_diff() {
        let hunk = b"@@ -1 +1 @@\n-a\n+b\n";
        for (code, ok) in [(0, true), (1, true), (2, false), (128, false), (-1, false)] {
            assert_eq!(no_index_diff_ok(code, hunk), ok, "exit {code}");
        }
        // Exit 0 passes whatever it printed (an identical or whitespace-only pair).
        assert!(no_index_diff_ok(0, b""));
        for printed in [
            &b"diff --git a/old b/new\nold mode 100644\nnew mode 100755\n"[..],
            b"diff --git a/old b/new\r\nBinary files a/old and b/new differ\r\n",
            b"Binary files a/old and b/new differ\n",
        ] {
            assert!(no_index_diff_ok(1, printed), "{printed:?}");
        }
        // Git's exit 1 for an input it couldn't read prints no diff line.
        for printed in [
            &b""[..],
            b"\n",
            b"warning: in the working copy of 'old', LF will be replaced by CRLF\n",
            b"x @@ -1 +1 @@\n",
        ] {
            assert!(!no_index_diff_ok(1, printed), "{printed:?}");
        }
    }

    /// Measured, git 2.51.1: `--no-index` over an unreadable input exits 1 with an empty
    /// stdout and `error: Could not access '<path>'`, the code a real difference exits with.
    #[tokio::test]
    async fn an_input_git_cannot_read_is_an_error_never_whitespace_only() {
        let base = tempfile::tempdir().unwrap();
        let present = base.path().join("old");
        std::fs::write(&present, b"a\n").unwrap();
        let missing = base.path().join("new");
        let args = with_ignore_whitespace(
            &["diff", "--no-ext-diff", "--no-index", "--no-color"],
            Some(true),
        );
        for (old, new) in [(&present, &missing), (&missing, &present)] {
            let failed = no_index_diff(&args, old, new).await;
            assert!(
                matches!(&failed, Err(AppError::Git { code: 1, stderr }) if stderr.contains("Could not access")),
                "{failed:?}"
            );
        }
        // The same run over two readable files still answers.
        std::fs::write(&missing, b"b\n").unwrap();
        let stdout = no_index_diff(&args, &present, &missing).await.unwrap();
        assert_eq!(whitespace_hunks(&stdout).hunks, "@@ -1 +1 @@\n-a\n+b\n");
        std::fs::write(&missing, b"  a\n").unwrap();
        let stdout = no_index_diff(&args, &present, &missing).await.unwrap();
        assert_eq!(whitespace_hunks(&stdout).hunks, "");
    }

    #[test]
    fn a_path_that_is_not_utf8_is_refused_never_spelled_lossily() {
        #[cfg(windows)]
        let odd = {
            use std::os::windows::ffi::OsStringExt;
            std::ffi::OsString::from_wide(&[u16::from(b'a'), 0xD800])
        };
        #[cfg(unix)]
        let odd = {
            use std::os::unix::ffi::OsStrExt;
            std::ffi::OsStr::from_bytes(b"a\xff").to_os_string()
        };
        let failed = utf8_arg(Path::new(&odd));
        assert!(
            matches!(&failed, Err(AppError::Io(e)) if e.to_string().starts_with("the temp path isn't UTF-8")),
            "{failed:?}"
        );
        assert_eq!(utf8_arg(Path::new("a/b")).unwrap(), "a/b");
    }

    /// The estimate refuses a side too long to fit before any decode: a string that is not
    /// base64 at all reports "over", not "not base64".
    #[test]
    fn an_over_cap_side_is_refused_before_it_is_decoded() {
        let cap = WHITESPACE_SIDE_MAX_BYTES;
        // The shortest length whose every valid decoding is past the cap, and one shorter.
        let over = cap.div_ceil(3) * 4 + 1;
        assert_eq!(base64::decoded_len_estimate(over) - 2, cap + 3);
        assert_eq!(base64::decoded_len_estimate(over - 1) - 2, cap);
        let refused = |len: usize| match whitespace_side(Some(&"!".repeat(len)), "old") {
            Err(AppError::InvalidArgument(message)) => message,
            other => panic!("expected InvalidArgument, got {other:?}"),
        };
        assert_eq!(refused(over), format!("the old side is over {cap} bytes"));
        assert!(refused(over - 1).starts_with("the old side is not base64"));
    }

    #[tokio::test]
    async fn the_temp_dir_is_gone_after_a_git_failure() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("runs");
        let failed = diff_written_pair(
            root.clone(),
            &["diff", "--no-ext-diff", "--no-index", "--no-such-option"],
            b"a\n".to_vec(),
            b"b\n".to_vec(),
        )
        .await;
        assert!(
            matches!(failed, Err(AppError::Git { code, .. }) if code > 1),
            "{failed:?}"
        );
        assert_eq!(entries(&root), Vec::<String>::new());
    }

    /// A run dir that outlived its run is swept past the limit; anything not run-shaped
    /// is never touched.
    #[test]
    fn the_sweep_removes_a_stale_run_dir_and_keeps_a_fresh_one() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("runs");
        let run = private_run_dir(&root).unwrap().keep();
        std::fs::write(run.join("old"), b"a\n").unwrap();
        let name = run.file_name().unwrap().to_string_lossy().into_owned();
        assert!(crate::attachments::is_session_id(&name), "{name}");
        std::fs::create_dir(root.join("not-a-run")).unwrap();
        std::fs::write(root.join("loose.txt"), b"x").unwrap();

        let fresh = SystemTime::now() + WHITESPACE_RUN_STALE_AFTER / 2;
        sweep_stale_runs(&root, fresh);
        assert_eq!(entries(&root), [name.as_str(), "loose.txt", "not-a-run"]);
        let stale = SystemTime::now() + WHITESPACE_RUN_STALE_AFTER * 2;
        sweep_stale_runs(&root, stale);
        assert_eq!(entries(&root), ["loose.txt", "not-a-run"]);
    }

    /// A linked root is refused before any run dir is made in its target, and the sweep
    /// never deletes through it.
    #[test]
    fn a_linked_or_non_directory_root_is_never_used() {
        let base = tempfile::tempdir().unwrap();
        let target = base.path().join("target");
        let stale_run = target.join("0123456789abcdef0123456789abcdef");
        std::fs::create_dir_all(&stale_run).unwrap();
        let root = base.path().join("runs");
        dir_link(&target, &root);
        let refused = private_run_dir(&root).unwrap_err();
        assert!(
            refused
                .to_string()
                .starts_with("the whitespace diff folder isn't private"),
            "{refused}"
        );
        sweep_stale_runs(&root, SystemTime::now() + WHITESPACE_RUN_STALE_AFTER * 2);
        assert_eq!(entries(&target), ["0123456789abcdef0123456789abcdef"]);

        let file = base.path().join("file");
        std::fs::write(&file, b"x").unwrap();
        assert!(private_run_dir(&file).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), b"x");
    }

    #[test]
    fn whitespace_hunks_cut_the_header_at_the_first_hunk() {
        let out = b"diff --git a/x b/y\nindex 1..2 100644\n--- a/x\n+++ b/y\n@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n";
        let parsed = whitespace_hunks(out);
        assert_eq!(parsed.hunks, "@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d\n");
        assert!(!parsed.is_binary);
        let binary = whitespace_hunks(
            b"diff --git a/x b/y\nindex 1..2 100644\r\nBinary files a/x and b/y differ\r\n",
        );
        assert!(binary.is_binary);
        assert_eq!(binary.hunks, "");
        let empty = whitespace_hunks(b"");
        assert_eq!((empty.hunks.as_str(), empty.is_binary), ("", false));
        // A content line that merely looks like a binary verdict is not one.
        let content = whitespace_hunks(b"@@ -1 +1 @@\n-Binary files a and b differ\n+x\n");
        assert!(!content.is_binary);
    }
}
