//! Image attachments for comment and pull request bodies. Pasted or picked bytes are
//! staged as sniff-validated files under `<app cache dir>/attachments/<session>/`;
//! a post then passes them to the forge CLI by their short relative names.
//!
//! Every path here is rebuilt from a session id and a file name that passed their
//! grammar at the same call site, so no frontend string ever becomes a path. File
//! lifetime: a post that returns Err leaves every staged file on disk, and a post that
//! returns Ok has deleted every posted one.

use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::github::pr::PrRef;

pub(crate) const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;
pub(crate) const MAX_IMAGES: usize = 10;
pub(crate) const GH_ATTACH_FLOOR: (u64, u64, u64) = (2, 99, 0);
pub(crate) const GLAB_ATTACH_FLOOR: (u64, u64, u64) = (1, 91, 0);
pub(crate) const STALE_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

pub(crate) const BITBUCKET_REFUSAL: &str = "Image attachments aren't available on Bitbucket.";
pub(crate) const AS_BOT_REFUSAL: &str = "Images can't be attached when posting as the review bot.";
pub(crate) const GH_AUTH_TYPE_REFUSAL: &str = "This GitHub CLI version can't attach images with your sign-in type. Update GitHub CLI to 2.103.2 or newer.";
/// gh's own GHES refusal when the host gate had no host to read (Rust-only sentence).
pub(crate) const GHES_UNKNOWN_HOST_REFUSAL: &str =
    "Image attachments need GitHub.com or GitHub Enterprise Cloud.";
const TOO_MANY_REFUSAL: &str = "You can attach up to 10 images at a time.";
const PASTED_LABEL: &str = "The pasted file";

/// Taken by every staging-folder write or delete in this process (stage, discard,
/// release, sweep), so a stage never races a post's cleanup in the same session.
static FS_LOCK: Mutex<()> = Mutex::new(());

fn fs_lock() -> std::sync::MutexGuard<'static, ()> {
    FS_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StagedImage {
    pub session: String,
    pub name: String,
    pub mime: String,
    pub size: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentRefs {
    pub session: String,
    pub names: Vec<String>,
}

/// Empty `failed_attachments` means everything posted.
#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommentOutcome {
    pub failed_attachments: Vec<String>,
}

/// `forge_pr_create`'s wire shape: `{number, url, failedAttachments}`. `PrRef` stays
/// unchanged because the issue and discussion creates serialize it too.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreateOutcome {
    #[serde(flatten)]
    pub pr: PrRef,
    pub failed_attachments: Vec<String>,
}

/// Attachments that passed every structural check; only [`post_checks`] builds one,
/// so `dir` is always `root/<valid session>`.
#[derive(Debug)]
pub(crate) struct StagedRefs {
    pub names: Vec<String>,
    pub dir: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AttachForge {
    GitHub,
    GitLab,
    Bitbucket,
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

pub(crate) fn ghes_refusal(host: &str) -> String {
    format!(
        "Image attachments need GitHub.com or GitHub Enterprise Cloud. {host} is GitHub Enterprise Server."
    )
}

pub(crate) fn gh_version_refusal(version: Option<&str>) -> String {
    match version {
        Some(v) => format!("Attaching images needs GitHub CLI 2.99 or newer (you have {v})."),
        None => "Attaching images needs GitHub CLI 2.99 or newer.".to_string(),
    }
}

pub(crate) fn glab_version_refusal(version: Option<&str>) -> String {
    match version {
        Some(v) => format!("Attaching images needs GitLab CLI 1.91 or newer (you have {v})."),
        None => "Attaching images needs GitLab CLI 1.91 or newer.".to_string(),
    }
}

pub(crate) fn write_access_refusal(slug: &str) -> String {
    format!("GitHub CLI only attaches images where you have write access, and you don't on {slug}.")
}

pub(crate) fn no_longer_attached(name: &str) -> AppError {
    AppError::InvalidArgument(format!("{name} is no longer attached. Attach it again."))
}

fn not_an_image(label: &str) -> AppError {
    AppError::InvalidArgument(format!(
        "{label} isn't an image. Attach a PNG, JPEG, GIF or WebP."
    ))
}

fn too_big(label: &str, bytes: usize) -> AppError {
    AppError::InvalidArgument(format!(
        "{label} is {}. Images can be at most 10 MB.",
        size_label(bytes as u64)
    ))
}

fn invalid(msg: &str) -> AppError {
    AppError::InvalidArgument(msg.to_string())
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

pub(crate) fn is_session_id(s: &str) -> bool {
    s.len() == 32 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// CON, PRN, AUX, NUL, COM1-9 and LPT1-9, any case.
fn is_reserved_device(stem: &str) -> bool {
    let up = stem.to_ascii_uppercase();
    if matches!(up.as_str(), "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let b = up.as_bytes();
    b.len() == 4
        && (up.starts_with("COM") || up.starts_with("LPT"))
        && (b'1'..=b'9').contains(&b[3])
}

pub(crate) fn is_staged_name(name: &str) -> bool {
    let Some(first) = name.bytes().next() else {
        return false;
    };
    if name.len() > 80 || !first.is_ascii_alphanumeric() {
        return false;
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return false;
    }
    let Some((_, ext)) = name.rsplit_once('.') else {
        return false;
    };
    if !matches!(ext, "png" | "jpg" | "gif" | "webp") {
        return false;
    }
    !is_reserved_device(name.split('.').next().unwrap_or_default())
}

pub(crate) fn ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

/// The base a hint names: its stem with every char outside `[A-Za-z0-9._-]` made `-`,
/// runs of `-` collapsed, leading non-alphanumerics trimmed, cut to 60 chars; empty or
/// a reserved device stem (text before the first dot) gives `image`.
fn hint_base(hint: &str) -> String {
    let stem = match hint.rsplit_once('.') {
        Some((stem, _)) => stem,
        None => hint,
    };
    let mut base = String::new();
    for c in stem.chars() {
        let c = if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            c
        } else {
            '-'
        };
        if c == '-' && base.ends_with('-') {
            continue;
        }
        base.push(c);
    }
    let trimmed = base.trim_start_matches(|c: char| !c.is_ascii_alphanumeric());
    let cut: String = trimmed.chars().take(60).collect();
    if cut.is_empty() || is_reserved_device(cut.split('.').next().unwrap_or_default()) {
        "image".to_string()
    } else {
        cut
    }
}

/// The staged name for a new file. Pasted data (no hint) gets `image-N.<ext>` with the
/// smallest free N; a hint gets [`hint_base`], then `-2`, `-3`, ... on a collision.
pub(crate) fn name_for(hint: Option<&str>, ext: &str, taken: impl Fn(&str) -> bool) -> String {
    match hint {
        None => (1u32..)
            .map(|n| format!("image-{n}.{ext}"))
            .find(|name| !taken(name))
            .unwrap_or_default(),
        Some(hint) => {
            let base = hint_base(hint);
            let first = format!("{base}.{ext}");
            if !taken(&first) {
                return first;
            }
            (2u32..)
                .map(|n| format!("{base}-{n}.{ext}"))
                .find(|name| !taken(name))
                .unwrap_or_default()
        }
    }
}

/// The one reference rule both sides share: a body references NAME iff it holds
/// `](NAME)`. A reference inside a code span or fence counts (accepted gap).
pub(crate) fn references(body: &str, name: &str) -> bool {
    body.contains(&reference_token(name))
}

/// `](NAME)`: the token [`references`] looks for and the GitLab rewrite replaces.
pub(crate) fn reference_token(name: &str) -> String {
    format!("]({name})")
}

/// The `--version` reading the health probe uses: the first line of stdout followed
/// by stderr, trimmed, with an empty line read as none.
pub(crate) fn version_line(stdout: &str, stderr: &str) -> Option<String> {
    format!("{stdout}{stderr}")
        .lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// `Some` with no names is treated as no attachments.
pub(crate) fn normalize(refs: Option<AttachmentRefs>) -> Option<AttachmentRefs> {
    refs.filter(|r| !r.names.is_empty())
}

/// Megabytes to one decimal, rounded UP in integer tenths so a file one byte over the
/// cap never reads as exactly the cap.
pub(crate) fn size_label(bytes: u64) -> String {
    let tenths = (bytes * 10).div_ceil(1_048_576);
    format!("{}.{} MB", tenths / 10, tenths % 10)
}

/// The first match of `\d+(?:\.\d+)+` in `line` (leftmost start, greedy), the rule the
/// frontend's health read uses.
pub(crate) fn version_token(line: &str) -> Option<String> {
    let b = line.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let mut end = i;
        while end + 1 < b.len() && b[end] == b'.' && b[end + 1].is_ascii_digit() {
            end += 1;
            while end < b.len() && b[end].is_ascii_digit() {
                end += 1;
            }
        }
        if end > i {
            return Some(line[start..end].to_string());
        }
    }
    None
}

/// `(major, minor, patch)`, a missing patch counting as 0.
pub(crate) fn version_triple(token: &str) -> Option<(u64, u64, u64)> {
    let mut parts = token.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = match parts.next() {
        Some(p) => p.parse().ok()?,
        None => 0,
    };
    Some((major, minor, patch))
}

/// Lowercased with a trailing `:<digits>` port removed.
pub(crate) fn host_label(host: &str) -> String {
    let lower = host.to_ascii_lowercase();
    match lower.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => {
            h.to_string()
        }
        _ => lower,
    }
}

pub(crate) fn host_attaches(label: &str) -> bool {
    label == "github.com" || (label.len() > ".ghe.com".len() && label.ends_with(".ghe.com"))
}

/// `Err(sentence)` when the CLI's `--version` line is missing, has no token, or is
/// older than `floor`.
fn version_gate(
    line: Option<&str>,
    floor: (u64, u64, u64),
    refusal: fn(Option<&str>) -> String,
) -> AppResult<()> {
    let token = line.and_then(version_token);
    let Some(token) = token else {
        return Err(AppError::InvalidArgument(refusal(None)));
    };
    match version_triple(&token) {
        Some(v) if v >= floor => Ok(()),
        Some(_) => {
            let shown = token.split('.').take(3).collect::<Vec<_>>().join(".");
            Err(AppError::InvalidArgument(refusal(Some(&shown))))
        }
        None => Err(AppError::InvalidArgument(refusal(None))),
    }
}

/// Check steps 1-4 for a post that carries attachments: provider, host (GitHub only;
/// `None` means gh's default chain and passes), CLI version, then the as-bot refusal.
/// It reads no file and builds no path; a failed version probe arrives as `None`.
pub(crate) fn attach_gate_verdict(
    forge: AttachForge,
    host: Option<&str>,
    version_line: Option<&str>,
    as_bot: bool,
) -> AppResult<()> {
    match forge {
        AttachForge::Bitbucket => return Err(invalid(BITBUCKET_REFUSAL)),
        AttachForge::GitHub => {
            if let Some(host) = host {
                let label = host_label(host);
                if !host_attaches(&label) {
                    return Err(AppError::InvalidArgument(ghes_refusal(&label)));
                }
            }
            version_gate(version_line, GH_ATTACH_FLOOR, gh_version_refusal)?;
        }
        AttachForge::GitLab => {
            version_gate(version_line, GLAB_ATTACH_FLOOR, glab_version_refusal)?;
        }
    }
    if as_bot {
        return Err(invalid(AS_BOT_REFUSAL));
    }
    Ok(())
}

/// The usual network timeout plus 30 s per attached file.
pub(crate) fn attach_timeout(n: usize) -> Duration {
    crate::github::runner::GH_NETWORK_TIMEOUT + Duration::from_secs(30) * n as u32
}

// ---------------------------------------------------------------------------
// Filesystem (root-parameterized; the commands and post paths pass the real root)
// ---------------------------------------------------------------------------

/// The staging root, set once at startup from the app's per-user cache dir.
static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// The root is set only at startup, so this holds for the whole session.
const ROOT_UNSET_REFUSAL: &str =
    "Image attachments aren't available because GitDesktop couldn't open its cache folder.";

/// Stores `<cache_dir>/attachments` in `cell`; a second call keeps the first root.
/// Absolute, so the checks and a CLI spawned in another cwd (glab's `file=@` runs in
/// the repo) read the same file.
fn init_root_in(cell: &OnceLock<PathBuf>, cache_dir: &Path) {
    let root = cache_dir.join("attachments");
    let root = std::path::absolute(&root).unwrap_or(root);
    let _ = cell.set(root);
}

/// Called from the app's setup, before the startup sweep is spawned.
pub(crate) fn init_root(cache_dir: &Path) {
    init_root_in(&ROOT, cache_dir);
}

/// Never invents a fallback: an unset root refuses rather than staging into a shared dir.
fn root_in(cell: &OnceLock<PathBuf>) -> AppResult<PathBuf> {
    cell.get()
        .cloned()
        .ok_or_else(|| AppError::Command(ROOT_UNSET_REFUSAL.to_string()))
}

pub(crate) fn attachments_root() -> AppResult<PathBuf> {
    root_in(&ROOT)
}

/// Names the folder so the user can fix or remove it; a foreign root is never repaired.
fn not_private(root: &Path) -> AppError {
    AppError::Io(std::io::Error::other(format!(
        "the image staging folder isn't private: {}",
        root.display()
    )))
}

/// Creates `dir` if missing (0o700 on unix); an existing one is left as it is.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.mode(0o700);
        builder
    };
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    match builder.create(dir) {
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        other => other,
    }
}

/// The root is a real directory, never a link, and on unix also owned by this user
/// with no group or other access. Errs when it is absent.
fn root_is_private(root: &Path) -> std::io::Result<bool> {
    let meta = fs::symlink_metadata(root)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions and cannot fail.
        let euid = unsafe { libc::geteuid() };
        if meta.uid() != euid || meta.mode() & 0o077 != 0 {
            return Ok(false);
        }
    }
    Ok(meta.file_type().is_dir())
}

/// Creates the root (and its parents) if missing; it must then pass [`root_is_private`],
/// the same rule the sweep applies.
fn prepare_root(root: &Path) -> AppResult<()> {
    if let Some(parent) = root.parent() {
        fs::create_dir_all(parent)?;
    }
    create_private_dir(root)?;
    if !root_is_private(root)? {
        return Err(not_private(root));
    }
    Ok(())
}

/// Staged files in a session folder that count toward the cap; a missing folder holds 0.
fn staged_count(dir: &Path) -> AppResult<usize> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    Ok(entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| e.file_name().to_str().is_some_and(is_staged_name))
        .count())
}

/// `len/4*3 - padding`: the decoded size of standard base64, read before decoding.
fn decoded_len(b64: &str) -> usize {
    let padding = b64.bytes().rev().take(2).filter(|&b| b == b'=').count();
    (b64.len() / 4 * 3).saturating_sub(padding)
}

/// Stages one image. Order: session grammar, too big (from the base64 length), too
/// many, not an image. A valid session id whose folder is missing is re-created.
pub(crate) fn stage_in(
    root: &Path,
    session: Option<&str>,
    hint: Option<&str>,
    b64: &str,
) -> AppResult<StagedImage> {
    let session = match session {
        Some(s) if is_session_id(s) => s.to_string(),
        Some(_) => return Err(invalid("invalid attachment session")),
        None => uuid::Uuid::new_v4().simple().to_string(),
    };
    let hint = hint.filter(|h| !h.is_empty());
    let label = hint.unwrap_or(PASTED_LABEL);
    let size = decoded_len(b64);
    if size > MAX_IMAGE_BYTES {
        return Err(too_big(label, size));
    }

    let _guard = fs_lock();
    prepare_root(root)?;
    let dir = root.join(&session);
    if staged_count(&dir)? >= MAX_IMAGES {
        return Err(invalid(TOO_MANY_REFUSAL));
    }
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|_| not_an_image(label))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(too_big(label, bytes.len()));
    }
    let (mime, width, height) =
        crate::image_sniff::sniff_image(&bytes).ok_or_else(|| not_an_image(label))?;
    let ext = ext_for_mime(mime).ok_or_else(|| not_an_image(label))?;

    create_private_dir(&dir)?;
    // Names are taken case-insensitively on every filesystem, as `post_checks` refuses
    // case-only duplicates; a lost create_new race moves on to the next free name.
    let present: HashSet<String> = fs::read_dir(&dir)?
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_ascii_lowercase))
        .collect();
    let mut lost: Vec<String> = Vec::new();
    let name = loop {
        let name = name_for(hint, ext, |n| {
            let n = n.to_ascii_lowercase();
            lost.contains(&n) || present.contains(&n)
        });
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(dir.join(&name)) {
            Ok(mut file) => {
                if let Err(e) = file.write_all(&bytes) {
                    drop(file);
                    let _ = fs::remove_file(dir.join(&name));
                    return Err(e.into());
                }
                break name;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                lost.push(name.to_ascii_lowercase())
            }
            Err(e) => return Err(e.into()),
        }
    };
    Ok(StagedImage {
        session,
        name,
        mime: mime.to_string(),
        size: bytes.len() as u32,
        width,
        height,
    })
}

/// Idempotent: a missing file or folder is Ok. `names: None` removes the whole session;
/// named discards also remove the folder once they leave it empty, as a release does.
pub(crate) fn discard_in(root: &Path, session: &str, names: Option<&[String]>) -> AppResult<()> {
    if !is_session_id(session) {
        return Err(invalid("invalid attachment session"));
    }
    if names.is_some_and(|ns| ns.iter().any(|n| !is_staged_name(n))) {
        return Err(invalid("invalid attachment name"));
    }
    let _guard = fs_lock();
    // A linked or foreign root is never deleted through; an absent one holds nothing.
    if !root_is_private(root).unwrap_or(false) {
        return Ok(());
    }
    let dir = root.join(session);
    let result = match names {
        None => fs::remove_dir_all(&dir),
        // Every name is tried; the first failure is reported after the rest.
        Some(names) => {
            let mut first_err = Ok(());
            for n in names {
                if let Err(e) = fs::remove_file(dir.join(n)) {
                    if e.kind() != std::io::ErrorKind::NotFound && first_err.is_ok() {
                        first_err = Err(e);
                    }
                }
            }
            first_err
        }
    };
    if names.is_some() {
        // Best effort: fails harmlessly while other files remain.
        let _ = fs::remove_dir(&dir);
    }
    match result {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

/// Check step 5: grammar, unique, 1..=10, each file present, each referenced. `None`
/// or no names gives `Ok(None)`, and the post proceeds exactly as without attachments.
pub(crate) fn post_checks(
    root: &Path,
    body: &str,
    refs: Option<AttachmentRefs>,
) -> AppResult<Option<StagedRefs>> {
    let Some(AttachmentRefs { session, names }) = normalize(refs) else {
        return Ok(None);
    };
    if !is_session_id(&session) {
        return Err(invalid("invalid attachment session"));
    }
    if names.iter().any(|n| !is_staged_name(n)) {
        return Err(invalid("invalid attachment name"));
    }
    // Case-folded, since NTFS finds `A.png` as `a.png` (every valid name is ASCII).
    let mut seen = HashSet::new();
    if let Some(dup) = names.iter().find(|n| !seen.insert(n.to_ascii_lowercase())) {
        return Err(AppError::InvalidArgument(format!(
            "duplicate attachment {dup}"
        )));
    }
    if names.len() > MAX_IMAGES {
        return Err(invalid(TOO_MANY_REFUSAL));
    }
    let _guard = fs_lock();
    prepare_root(root)?;
    let dir = root.join(&session);
    if let Some(gone) = names.iter().find(|n| !dir.join(n).is_file()) {
        return Err(no_longer_attached(gone));
    }
    if let Some(loose) = names.iter().find(|n| !references(body, n)) {
        return Err(AppError::InvalidArgument(format!(
            "{loose} isn't referenced in the text"
        )));
    }
    Ok(Some(StagedRefs { names, dir }))
}

/// [`post_checks`] against the real root, off the async runtime.
pub(crate) async fn checked_refs(
    body: &str,
    refs: AttachmentRefs,
) -> AppResult<Option<StagedRefs>> {
    let body = body.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        post_checks(&attachments_root()?, &body, Some(refs))
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
}

/// Deletes every staged name not in `failed`, then the session folder once empty.
/// Best-effort: errors are ignored.
fn release_in(dir: &Path, names: &[String], failed: &[String]) {
    let _guard = fs_lock();
    for name in names.iter().filter(|n| !failed.contains(n)) {
        let _ = fs::remove_file(dir.join(name));
    }
    let _ = fs::remove_dir(dir);
}

/// Called only on a path about to return Ok, after every fallible step.
pub(crate) async fn release_posted(staged: &StagedRefs, failed: &[String]) {
    let dir = staged.dir.clone();
    let names = staged.names.clone();
    let failed = failed.to_vec();
    let _ = tauri::async_runtime::spawn_blocking(move || release_in(&dir, &names, &failed)).await;
}

/// The origin-lens PR create's only release: after the labels/assignees follow-up, so
/// that follow-up's Err keeps every staged file.
pub(crate) async fn finish_attached(
    followup: AppResult<()>,
    staged: Option<&StagedRefs>,
    failed: Vec<String>,
) -> AppResult<Vec<String>> {
    followup?;
    if let Some(staged) = staged {
        release_posted(staged, &failed).await;
    }
    Ok(failed)
}

/// The newest mtime among a folder and its direct entries: an NTFS directory mtime
/// does not move when a contained file is rewritten.
fn newest_mtime(dir: &Path) -> Option<SystemTime> {
    let mut newest = fs::symlink_metadata(dir).and_then(|m| m.modified()).ok()?;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(t) = entry.metadata().and_then(|m| m.modified()) {
                newest = newest.max(t);
            }
        }
    }
    Some(newest)
}

/// Removes 32-hex session folders directly under `root` idle longer than `max_age`.
/// Best-effort; every other entry is left alone. A root failing [`root_is_private`]
/// is never read: a planted link would aim the deletes at its target.
pub(crate) fn sweep_stale_in(root: &Path, now: SystemTime, max_age: Duration) {
    if !root_is_private(root).unwrap_or(false) {
        return;
    }
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let _guard = fs_lock();
    for entry in entries.flatten() {
        let is_session = entry.file_name().to_str().is_some_and(is_session_id);
        if !is_session || !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let path = entry.path();
        let Some(newest) = newest_mtime(&path) else {
            continue;
        };
        if now.duration_since(newest).is_ok_and(|age| age > max_age) {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

/// Startup only, never at exit: a second app instance may still be using its sessions.
/// An unset root has nothing to sweep.
pub(crate) fn sweep_stale_sessions() {
    if let Ok(root) = attachments_root() {
        sweep_stale_in(&root, SystemTime::now(), STALE_AFTER);
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// [`stage_in`] at the root `cell` holds; an unset root refuses before any write.
fn stage_at(
    cell: &OnceLock<PathBuf>,
    session: Option<&str>,
    hint: Option<&str>,
    b64: &str,
) -> AppResult<StagedImage> {
    stage_in(&root_in(cell)?, session, hint, b64)
}

#[tauri::command]
pub async fn attachment_stage(
    session: Option<String>,
    name_hint: Option<String>,
    data_base64: String,
) -> AppResult<StagedImage> {
    tauri::async_runtime::spawn_blocking(move || {
        stage_at(
            &ROOT,
            session.as_deref(),
            name_hint.as_deref(),
            &data_base64,
        )
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
}

#[tauri::command]
pub async fn attachment_discard(session: String, names: Option<Vec<String>>) -> AppResult<()> {
    tauri::async_runtime::spawn_blocking(move || {
        discard_in(&attachments_root()?, &session, names.as_deref())
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_sniff::{gif_fixture, jpeg_fixture, png_fixture};
    use base64::Engine;

    fn b64(bytes: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(bytes)
    }

    fn webp_fixture() -> Vec<u8> {
        // VP8L: signature byte, then 14-bit width-1 and height-1 (3 x 2).
        let bits: u32 = 2 | (1 << 14);
        let mut chunk = vec![0x2f];
        chunk.extend_from_slice(&bits.to_le_bytes());
        let mut bytes = b"RIFF".to_vec();
        bytes.extend_from_slice(&((12 + chunk.len()) as u32).to_le_bytes());
        bytes.extend_from_slice(b"WEBP");
        bytes.extend_from_slice(b"VP8L");
        bytes.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&chunk);
        bytes
    }

    fn msg(r: AppResult<impl std::fmt::Debug>) -> String {
        match r {
            Err(AppError::InvalidArgument(m)) => m,
            other => panic!("expected InvalidArgument, got {other:?}"),
        }
    }

    const SID: &str = "0123456789abcdef0123456789abcdef";

    fn entries(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .map(|es| {
                es.flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        v.sort();
        v
    }

    fn refs(session: &str, names: &[&str]) -> Option<AttachmentRefs> {
        Some(AttachmentRefs {
            session: session.to_string(),
            names: names.iter().map(|s| s.to_string()).collect(),
        })
    }

    fn fill(dir: &Path, n: usize) {
        fs::create_dir_all(dir).unwrap();
        for i in 1..=n {
            fs::write(dir.join(format!("image-{i}.png")), b"x").unwrap();
        }
    }

    // T-W1, T-W3, T-W2, T-W5, T-W4
    #[test]
    fn wire_shapes_are_exact_camel_case() {
        let keys = |v: serde_json::Value| -> Vec<String> {
            let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        let c = serde_json::to_value(CommentOutcome::default()).unwrap();
        assert!(c.get("failed_attachments").is_none());
        assert_eq!(keys(c), ["failedAttachments"]);

        let s = serde_json::to_value(StagedImage {
            session: SID.into(),
            name: "image-1.png".into(),
            mime: "image/png".into(),
            size: 1,
            width: 2,
            height: 3,
        })
        .unwrap();
        assert_eq!(
            keys(s),
            ["height", "mime", "name", "session", "size", "width"]
        );

        let p = serde_json::to_value(PrCreateOutcome {
            pr: PrRef {
                number: 7,
                url: "u".into(),
            },
            failed_attachments: vec!["a.png".into()],
        })
        .unwrap();
        assert!(p.get("pr").is_none() && p.get("failed_attachments").is_none());
        assert_eq!(keys(p), ["failedAttachments", "number", "url"]);

        let bare = serde_json::to_value(PrRef {
            number: 7,
            url: "u".into(),
        })
        .unwrap();
        assert_eq!(keys(bare), ["number", "url"]);

        let r: AttachmentRefs =
            serde_json::from_str(r#"{"session":"s","names":["a.png","b.gif"]}"#).unwrap();
        assert_eq!(r.session, "s");
        assert_eq!(r.names, ["a.png", "b.gif"]);
    }

    // T-H1: every row of the contract 2b name table.
    #[test]
    fn staged_name_grammar_pins_the_table() {
        let long_ok = format!("{}.png", "a".repeat(76));
        let long_bad = format!("{}.png", "a".repeat(77));
        let valid = [
            "image-1.png",
            "a.b-c_d.webp",
            "photo.png.png",
            "A.jpg",
            "0.gif",
            long_ok.as_str(),
        ];
        for name in valid {
            assert!(is_staged_name(name), "{name} should be valid");
        }
        let invalid_names = [
            "",
            ".png",
            "-a.png",
            "_a.png",
            "a.jpeg",
            "a.PNG",
            "a.svg",
            "a.png.",
            "a.png ",
            "a b.png",
            "a/b.png",
            "a\\b.png",
            "../a.png",
            "con.png",
            "NUL.gif",
            "Com1.webp",
            "lpt9.x.jpg",
            "image-1",
            "png",
            "\u{e9}.png",
            long_bad.as_str(),
        ];
        assert_eq!(invalid_names.len(), 21);
        for name in invalid_names {
            assert!(!is_staged_name(name), "{name:?} should be invalid");
        }
    }

    // T-H2
    #[test]
    fn session_id_grammar_pins_the_table() {
        assert!(is_session_id(SID));
        for bad in [
            &SID[..31],
            &format!("{SID}a")[..],
            &SID.to_uppercase()[..],
            "0123456789abcdef0123456789abcdeg",
            "..",
            "0123456789abcdef/123456789abcdef",
        ] {
            assert!(!is_session_id(bad), "{bad} should be invalid");
        }
    }

    // T-H3: a hostile session at stage writes nothing into the root.
    #[test]
    fn stage_refuses_a_hostile_session_before_any_path() {
        let root = tempfile::tempdir().unwrap();
        let r = stage_in(root.path(), Some("."), None, &b64(&png_fixture(1, 1)));
        assert_eq!(msg(r), "invalid attachment session");
        assert!(entries(root.path()).is_empty());
    }

    // T-H4: a non-hex session that exists keeps its folder and file.
    #[test]
    fn discard_refuses_a_hostile_session() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("keep")).unwrap();
        fs::write(root.path().join("keep").join("image-1.png"), b"x").unwrap();
        assert_eq!(
            msg(discard_in(root.path(), "keep", None)),
            "invalid attachment session"
        );
        assert!(root.path().join("keep").join("image-1.png").is_file());
    }

    // T-H5
    #[test]
    fn discard_refuses_a_hostile_name() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(SID)).unwrap();
        fs::write(root.path().join("victim.png"), b"x").unwrap();
        let names = vec!["../victim.png".to_string()];
        assert_eq!(
            msg(discard_in(root.path(), SID, Some(&names))),
            "invalid attachment name"
        );
        assert!(root.path().join("victim.png").is_file());
    }

    // T-H6
    #[test]
    fn post_checks_refuse_a_hostile_session() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("image-1.png"), b"x").unwrap();
        let r = post_checks(
            root.path(),
            "![x](image-1.png)",
            refs(".", &["image-1.png"]),
        );
        assert_eq!(msg(r), "invalid attachment session");
        assert_eq!(entries(root.path()), ["image-1.png"]);
    }

    // T-H7
    #[test]
    fn post_checks_refuse_a_hostile_name() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(SID)).unwrap();
        fs::write(root.path().join("victim.png"), b"x").unwrap();
        let r = post_checks(
            root.path(),
            "![x](../victim.png)",
            refs(SID, &["../victim.png"]),
        );
        assert_eq!(msg(r), "invalid attachment name");
        assert!(root.path().join("victim.png").is_file());
    }

    // T-N1
    #[test]
    fn name_for_follows_the_hint_and_paste_rules() {
        let none = |_: &str| false;
        assert_eq!(name_for(None, "png", none), "image-1.png");
        let taken = ["image-2.png", "image-3.png"];
        assert_eq!(
            name_for(None, "png", |n| taken.contains(&n)),
            "image-1.png",
            "a gap at 1 is refilled"
        );
        let taken = ["image-1.png", "image-2.png", "image-4.png"];
        assert_eq!(name_for(None, "png", |n| taken.contains(&n)), "image-3.png");
        assert_eq!(
            name_for(None, "jpg", |n| n == "image-1.png"),
            "image-1.jpg",
            "image-1.png and image-1.jpg coexist"
        );

        assert_eq!(
            name_for(Some("My Shot (1).PNG"), "png", none),
            "My-Shot-1-.png"
        );
        assert_eq!(name_for(Some("photo.png"), "jpg", none), "photo.jpg");
        assert_eq!(name_for(Some("a  b??c.gif"), "gif", none), "a-b-c.gif");
        assert_eq!(name_for(Some("..-_x.png"), "png", none), "x.png");
        assert_eq!(name_for(Some("-lead.png"), "png", none), "lead.png");
        assert_eq!(name_for(Some("\u{e9}t\u{e9}.png"), "png", none), "t-.png");
        assert_eq!(name_for(Some("\u{e9}.png"), "png", none), "image.png");
        assert_eq!(name_for(Some(".png"), "png", none), "image.png");
        assert_eq!(name_for(Some("noext"), "webp", none), "noext.webp");
        let long = "x".repeat(200);
        assert_eq!(
            name_for(Some(&format!("{long}.png")), "png", none),
            format!("{}.png", "x".repeat(60))
        );
        assert_eq!(name_for(Some("con.x.png"), "png", none), "image.png");
        assert_eq!(name_for(Some("CON.png"), "png", none), "image.png");
        assert_eq!(name_for(Some("nul.jpg"), "jpg", none), "image.jpg");
        assert_eq!(name_for(Some("NUL"), "png", none), "image.png");

        let taken = ["photo.png", "photo-2.png"];
        assert_eq!(
            name_for(Some("photo.png"), "png", |n| taken.contains(&n)),
            "photo-3.png"
        );
        for hint in ["My Shot (1).PNG", "CON.png", "\u{e9}.png", "x.y.z.gif"] {
            assert!(is_staged_name(&name_for(Some(hint), "png", none)));
        }
    }

    // T-S1
    #[test]
    fn stage_writes_sniffed_bytes_with_the_forced_extension() {
        let root = tempfile::tempdir().unwrap();
        let cases: [(Vec<u8>, Option<&str>, &str, &str); 4] = [
            (png_fixture(4, 5), None, "image/png", "image-1.png"),
            (
                gif_fixture(b"GIF89a", 6, 7),
                None,
                "image/gif",
                "image-1.gif",
            ),
            (
                jpeg_fixture(0xc0, &[], 8, 9),
                Some("photo.png"),
                "image/jpeg",
                "photo.jpg",
            ),
            (webp_fixture(), None, "image/webp", "image-1.webp"),
        ];
        let mut session: Option<String> = None;
        for (bytes, hint, mime, name) in cases {
            let staged = stage_in(root.path(), session.as_deref(), hint, &b64(&bytes)).unwrap();
            assert!(is_session_id(&staged.session));
            assert_eq!((staged.mime.as_str(), staged.name.as_str()), (mime, name));
            assert_eq!(staged.size as usize, bytes.len());
            let on_disk = fs::read(root.path().join(&staged.session).join(name)).unwrap();
            assert_eq!(on_disk, bytes);
            session = Some(staged.session);
        }
        let png = stage_in(
            root.path(),
            session.as_deref(),
            None,
            &b64(&png_fixture(4, 5)),
        )
        .unwrap();
        assert_eq!(
            (png.name.as_str(), png.width, png.height),
            ("image-2.png", 4, 5)
        );
    }

    // T-S2
    #[test]
    fn stage_refusals_follow_the_order() {
        let root = tempfile::tempdir().unwrap();
        fill(&root.path().join(SID), 10);
        // 3495254 base64 groups with one `=` decode to exactly 10 MiB + 1.
        let over = format!("{}=", "A".repeat(3_495_254 * 4 - 1));
        assert_eq!(decoded_len(&over), MAX_IMAGE_BYTES + 1);
        assert_eq!(
            msg(stage_in(root.path(), Some(SID), Some("big.png"), &over)),
            "big.png is 10.1 MB. Images can be at most 10 MB."
        );
        assert_eq!(
            msg(stage_in(root.path(), Some(SID), None, "!!!not base64!!!")),
            TOO_MANY_REFUSAL
        );
        let empty = "fedcba9876543210fedcba9876543210";
        assert_eq!(
            msg(stage_in(root.path(), Some(empty), None, "!!!not base64!!!")),
            "The pasted file isn't an image. Attach a PNG, JPEG, GIF or WebP."
        );
        assert_eq!(
            msg(stage_in(
                root.path(),
                Some(empty),
                Some("notes.png"),
                &b64(b"just some text")
            )),
            "notes.png isn't an image. Attach a PNG, JPEG, GIF or WebP."
        );
        // A data URL prefix and a truncated group are not base64 of an image.
        let data_url = format!("data:image/png;base64,{}", b64(&png_fixture(1, 1)));
        for input in [data_url.as_str(), "abc"] {
            assert_eq!(
                msg(stage_in(root.path(), Some(empty), None, input)),
                "The pasted file isn't an image. Attach a PNG, JPEG, GIF or WebP.",
                "{input}"
            );
        }
        assert!(!root.path().join(empty).exists());
    }

    // Names are taken case-insensitively on every filesystem, so a hint matching a
    // staged name only by case takes `-2`.
    #[test]
    fn stage_numbers_a_hint_colliding_by_case() {
        let root = tempfile::tempdir().unwrap();
        let png = b64(&png_fixture(1, 1));
        let first = stage_in(root.path(), Some(SID), Some("a.png"), &png).unwrap();
        assert_eq!(first.name, "a.png");
        let second = stage_in(root.path(), Some(SID), Some("A.png"), &png).unwrap();
        assert_eq!(second.name, "A-2.png");
        assert_eq!(entries(&root.path().join(SID)), ["A-2.png", "a.png"]);
    }

    // T-S3: exactly 10 MiB is accepted.
    #[test]
    fn stage_accepts_exactly_the_cap() {
        let root = tempfile::tempdir().unwrap();
        let mut bytes = png_fixture(1, 1);
        bytes.resize(MAX_IMAGE_BYTES, 0);
        let staged = stage_in(root.path(), None, None, &b64(&bytes)).unwrap();
        assert_eq!(staged.size as usize, MAX_IMAGE_BYTES);
    }

    // T-S4
    #[test]
    fn size_label_rounds_up_in_tenths() {
        assert_eq!(
            msg(Err::<(), _>(too_big("x.png", MAX_IMAGE_BYTES + 1))),
            "x.png is 10.1 MB. Images can be at most 10 MB."
        );
        assert_eq!(size_label(14_889_779), "14.2 MB");
        assert_eq!(size_label(14_889_780), "14.3 MB");
        assert_eq!(size_label(10_485_760), "10.0 MB");
    }

    // T-S5 (A1b)
    #[test]
    fn stage_recreates_a_missing_session_folder() {
        let root = tempfile::tempdir().unwrap();
        let staged = stage_in(root.path(), Some(SID), None, &b64(&png_fixture(1, 1))).unwrap();
        assert_eq!(staged.session, SID);
        assert_eq!(entries(&root.path().join(SID)), ["image-1.png"]);
    }

    // T-D1
    #[test]
    fn discard_is_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(SID);
        fill(&dir, 2);
        let one = vec!["image-1.png".to_string()];
        discard_in(root.path(), SID, Some(&one)).unwrap();
        discard_in(root.path(), SID, Some(&one)).unwrap();
        assert_eq!(entries(&dir), ["image-2.png"]);
        discard_in(root.path(), SID, None).unwrap();
        assert!(!dir.exists());
        discard_in(root.path(), SID, None).unwrap();
        discard_in(root.path(), SID, Some(&one)).unwrap();

        // Discarding the last named files removes the emptied folder too.
        fill(&dir, 2);
        let both = vec!["image-1.png".to_string(), "image-2.png".to_string()];
        discard_in(root.path(), SID, Some(&both)).unwrap();
        assert!(!dir.exists());
        assert!(root.path().is_dir());

        // No names deletes no file, and removes the folder only when it is empty.
        fill(&dir, 2);
        discard_in(root.path(), SID, Some(&[])).unwrap();
        assert_eq!(entries(&dir), ["image-1.png", "image-2.png"]);
        discard_in(root.path(), SID, Some(&both)).unwrap();
        fs::create_dir(&dir).unwrap();
        discard_in(root.path(), SID, Some(&[])).unwrap();
        assert!(!dir.exists());
    }

    // A name that can't be deleted doesn't stop the names after it.
    #[test]
    fn discard_tries_every_name_then_reports_the_failure() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(SID);
        fill(&dir, 3);
        fs::remove_file(dir.join("image-1.png")).unwrap();
        fs::create_dir(dir.join("image-1.png")).unwrap();
        let names: Vec<String> = (1..=3).map(|i| format!("image-{i}.png")).collect();
        assert!(discard_in(root.path(), SID, Some(&names)).is_err());
        assert_eq!(entries(&dir), ["image-1.png"]);
    }

    // T-V1
    #[test]
    fn post_checks_validate_every_rule() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(SID);
        fill(&dir, 11);
        let body = "![a](image-1.png) and ![b](image-2.png)";
        assert!(post_checks(root.path(), body, None).unwrap().is_none());
        assert!(post_checks(root.path(), body, refs(SID, &[]))
            .unwrap()
            .is_none());

        let ok = post_checks(
            root.path(),
            body,
            refs(SID, &["image-1.png", "image-2.png"]),
        )
        .unwrap()
        .unwrap();
        assert_eq!(ok.dir, dir);
        assert_eq!(ok.names, ["image-1.png", "image-2.png"]);

        assert_eq!(
            msg(post_checks(
                root.path(),
                body,
                refs(SID, &["image-1.png", "image-1.png"])
            )),
            "duplicate attachment image-1.png"
        );
        assert_eq!(
            msg(post_checks(
                root.path(),
                "![a](image-1.png) ![b](Image-1.png)",
                refs(SID, &["image-1.png", "Image-1.png"])
            )),
            "duplicate attachment Image-1.png"
        );
        let eleven: Vec<String> = (1..=11).map(|i| format!("image-{i}.png")).collect();
        let eleven_refs: Vec<&str> = eleven.iter().map(String::as_str).collect();
        let all_body: String = eleven.iter().map(|n| format!("![]({n})")).collect();
        assert_eq!(
            msg(post_checks(root.path(), &all_body, refs(SID, &eleven_refs))),
            TOO_MANY_REFUSAL
        );
        assert_eq!(
            msg(post_checks(
                root.path(),
                "![x](gone.png)",
                refs(SID, &["gone.png"])
            )),
            "gone.png is no longer attached. Attach it again."
        );
        // `](image-11.png)` doesn't reference image-1.png.
        assert_eq!(
            msg(post_checks(
                root.path(),
                "![x](image-11.png)",
                refs(SID, &["image-1.png"])
            )),
            "image-1.png isn't referenced in the text"
        );
        assert!(post_checks(
            root.path(),
            "![x](image-11.png)",
            refs(SID, &["image-11.png"])
        )
        .unwrap()
        .is_some());
        // Twice, and inside a fence, still counts.
        assert!(post_checks(
            root.path(),
            "```\n![x](image-1.png)\n```\n![y](image-1.png)",
            refs(SID, &["image-1.png"])
        )
        .unwrap()
        .is_some());
    }

    // T-R1
    #[test]
    fn release_keeps_failed_names_and_the_nonempty_folder() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(SID);
        fill(&dir, 3);
        let names: Vec<String> = (1..=3).map(|i| format!("image-{i}.png")).collect();
        release_in(&dir, &names, &["image-2.png".to_string()]);
        assert_eq!(entries(&dir), ["image-2.png"]);
        release_in(&dir, &names[1..2], &[]);
        assert!(!dir.exists());
    }

    // T-R2
    #[tokio::test]
    async fn finish_attached_releases_only_after_an_ok_followup() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(SID);
        fill(&dir, 3);
        let staged = StagedRefs {
            names: (1..=3).map(|i| format!("image-{i}.png")).collect(),
            dir: dir.clone(),
        };
        let failed = vec!["image-2.png".to_string()];
        let err = finish_attached(
            Err(AppError::Gh("labels failed".into())),
            Some(&staged),
            failed.clone(),
        )
        .await;
        assert!(matches!(err, Err(AppError::Gh(ref m)) if m == "labels failed"));
        assert_eq!(entries(&dir), ["image-1.png", "image-2.png", "image-3.png"]);

        let ok = finish_attached(Ok(()), Some(&staged), failed)
            .await
            .unwrap();
        assert_eq!(ok, ["image-2.png"]);
        assert_eq!(entries(&dir), ["image-2.png"]);
    }

    /// A directory link at `link`: a junction on Windows (mklink /J needs no privilege).
    fn dir_link(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            let made = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
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

    const OTHER_SID: &str = "fedcba9876543210fedcba9876543210";
    const LINK_SID: &str = "00112233445566778899aabbccddeeff";

    // T-SW1: a 32-hex file and a 32-hex link survive, and so does the link's target.
    #[test]
    fn sweep_removes_only_stale_sessions() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fill(&outside.path().join(SID), 1);
        fill(&root.path().join(SID), 1);
        fs::create_dir(root.path().join("not-a-session")).unwrap();
        fs::write(root.path().join("loose.txt"), b"x").unwrap();
        fs::write(root.path().join(OTHER_SID), b"x").unwrap();
        dir_link(outside.path(), &root.path().join(LINK_SID));

        sweep_stale_in(root.path(), SystemTime::now(), STALE_AFTER);
        assert_eq!(
            entries(root.path()),
            [LINK_SID, SID, OTHER_SID, "loose.txt", "not-a-session"]
        );

        let later = SystemTime::now() + Duration::from_secs(25 * 60 * 60);
        sweep_stale_in(root.path(), later, STALE_AFTER);
        assert_eq!(
            entries(root.path()),
            [LINK_SID, OTHER_SID, "loose.txt", "not-a-session"]
        );
        assert_eq!(entries(outside.path()), [SID]);
        assert_eq!(entries(&outside.path().join(SID)), ["image-1.png"]);
    }

    // T-SW1: `age > max_age`, so a session idle exactly the limit stays.
    #[test]
    fn sweep_keeps_a_session_idle_exactly_the_limit() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(SID);
        fill(&dir, 1);
        let newest = newest_mtime(&dir).unwrap();
        sweep_stale_in(root.path(), newest + STALE_AFTER, STALE_AFTER);
        assert!(dir.is_dir());
        let past = newest + STALE_AFTER + Duration::from_secs(1);
        sweep_stale_in(root.path(), past, STALE_AFTER);
        assert!(!dir.exists());
    }

    // Staging applies the sweep's root rule on every platform: a linked root is refused.
    #[test]
    fn stage_refuses_a_linked_root() {
        let base = tempfile::tempdir().unwrap();
        let target = base.path().join("target");
        fs::create_dir(&target).unwrap();
        let root = base.path().join("root");
        dir_link(&target, &root);
        let err = stage_in(&root, Some(SID), None, &b64(&png_fixture(1, 1))).unwrap_err();
        let want = format!("the image staging folder isn't private: {}", root.display());
        assert!(
            matches!(&err, AppError::Io(e) if e.to_string() == want),
            "{err:?}"
        );
        assert!(entries(&target).is_empty());
    }

    // A discard never deletes through a linked root, even one replaced after staging.
    #[test]
    fn discard_through_a_linked_root_touches_nothing() {
        let base = tempfile::tempdir().unwrap();
        let target = base.path().join("target");
        fill(&target.join(SID), 2);
        let root = base.path().join("root");
        dir_link(&target, &root);
        discard_in(&root, SID, None).unwrap();
        let one = vec!["image-1.png".to_string()];
        discard_in(&root, SID, Some(&one)).unwrap();
        assert_eq!(entries(&target), [SID]);
        assert_eq!(entries(&target.join(SID)), ["image-1.png", "image-2.png"]);
        // An absent root holds nothing to discard.
        discard_in(&base.path().join("absent"), SID, None).unwrap();
    }

    #[test]
    fn an_unset_root_refuses_and_writes_nothing() {
        let cell = OnceLock::new();
        let err = stage_at(&cell, None, None, &b64(&png_fixture(1, 1))).unwrap_err();
        assert!(
            matches!(&err, AppError::Command(m) if m == "Image attachments aren't available because GitDesktop couldn't open its cache folder."),
            "{err:?}"
        );
        assert!(cell.get().is_none());
    }

    #[test]
    fn stage_uses_the_root_set_at_startup() {
        let base = tempfile::tempdir().unwrap();
        let cache = base.path().join("cache");
        let cell = OnceLock::new();
        init_root_in(&cell, &cache);
        init_root_in(&cell, &base.path().join("other"));
        assert!(root_in(&cell).unwrap().is_absolute());
        let staged = stage_at(&cell, None, None, &b64(&png_fixture(1, 1))).unwrap();
        let dir = cache.join("attachments").join(&staged.session);
        assert_eq!(entries(&dir), ["image-1.png"]);
        assert_eq!(entries(base.path()), ["cache"]);
    }

    // A root that is a link is never read, so its target's sessions survive.
    #[test]
    fn sweep_never_reads_through_a_linked_root() {
        let base = tempfile::tempdir().unwrap();
        let target = base.path().join("target");
        fill(&target.join(SID), 1);
        let root = base.path().join("root");
        dir_link(&target, &root);

        let later = SystemTime::now() + Duration::from_secs(25 * 60 * 60);
        sweep_stale_in(&root, later, STALE_AFTER);
        assert_eq!(entries(&target.join(SID)), ["image-1.png"]);
        sweep_stale_in(&base.path().join("absent"), later, STALE_AFTER);
    }

    // T-G1
    #[test]
    fn host_gate_reads_the_pinned_host() {
        assert_eq!(host_label("X.GHE.COM:443"), "x.ghe.com");
        assert_eq!(host_label("GitHub.Acme.com:8443"), "github.acme.com");
        let v = Some("gh version 2.103.3 (2026-10-26)");
        for host in [
            Some("github.com"),
            Some("GitHub.COM"),
            Some("x.ghe.com"),
            Some("X.GHE.COM:443"),
            None,
        ] {
            assert!(
                attach_gate_verdict(AttachForge::GitHub, host, v, false).is_ok(),
                "{host:?} should pass"
            );
        }
        assert_eq!(
            msg(attach_gate_verdict(AttachForge::GitHub, Some("GitHub.Acme.com:8443"), v, false)),
            "Image attachments need GitHub.com or GitHub Enterprise Cloud. github.acme.com is GitHub Enterprise Server."
        );
        for host in ["ghe.com", "notghe.com", "acme.ghe.com.evil"] {
            assert_eq!(
                msg(attach_gate_verdict(
                    AttachForge::GitHub,
                    Some(host),
                    v,
                    false
                )),
                ghes_refusal(host)
            );
        }
    }

    // T-G2: every gh row of the contract 2b version table.
    #[test]
    fn gh_version_gate_pins_the_table() {
        let gate = |line: Option<&str>| {
            attach_gate_verdict(AttachForge::GitHub, Some("github.com"), line, false)
        };
        for line in [
            "gh version 2.103.3 (2026-10-26)",
            "gh version 2.99.0 (2026-01-01)",
            "gh version 2.100.0",
            "gh version 3.0.0",
            "gh version 2.99",
        ] {
            assert!(gate(Some(line)).is_ok(), "{line} should pass");
        }
        assert_eq!(
            msg(gate(Some("gh version 2.98.9 (2026-01-01)"))),
            "Attaching images needs GitHub CLI 2.99 or newer (you have 2.98.9)."
        );
        for line in [Some("gh version DEV"), Some(""), None] {
            assert_eq!(
                msg(gate(line)),
                "Attaching images needs GitHub CLI 2.99 or newer."
            );
        }
        assert_eq!(
            version_token("gh version 2.98.0-rc.1").as_deref(),
            Some("2.98.0")
        );
        assert_eq!(
            version_token("gh version 2.103.3 (2026-10-26)").as_deref(),
            Some("2.103.3")
        );
    }

    // T-G3: every glab row of the contract 2b version table.
    #[test]
    fn glab_version_gate_pins_the_table() {
        let gate = |line: Option<&str>| attach_gate_verdict(AttachForge::GitLab, None, line, false);
        for line in ["glab 1.105.0 (45c9976)", "glab version v1.91.0"] {
            assert!(gate(Some(line)).is_ok(), "{line} should pass");
        }
        for (line, shown) in [
            ("glab version 1.36.0 (2023-12-01)", "1.36.0"),
            ("glab 1.90.9", "1.90.9"),
            ("glab version 1.90", "1.90"),
        ] {
            assert_eq!(
                msg(gate(Some(line))),
                format!("Attaching images needs GitLab CLI 1.91 or newer (you have {shown}).")
            );
        }
        for line in [Some("gh version DEV"), Some(""), None] {
            assert_eq!(
                msg(gate(line)),
                "Attaching images needs GitLab CLI 1.91 or newer."
            );
        }
        assert_eq!(version_triple("1.90"), Some((1, 90, 0)));
        assert_eq!(
            version_token("glab version v1.91.0").as_deref(),
            Some("1.91.0")
        );
    }

    // T-G4
    #[test]
    fn gate_steps_run_in_order() {
        let ghes = Some("github.acme.com");
        let old_gh = Some("gh version 2.98.0");
        assert_eq!(
            msg(attach_gate_verdict(
                AttachForge::Bitbucket,
                ghes,
                old_gh,
                true
            )),
            BITBUCKET_REFUSAL
        );
        assert_eq!(
            msg(attach_gate_verdict(AttachForge::GitHub, ghes, old_gh, true)),
            ghes_refusal("github.acme.com")
        );
        assert_eq!(
            msg(attach_gate_verdict(
                AttachForge::GitHub,
                Some("github.com"),
                old_gh,
                true
            )),
            gh_version_refusal(Some("2.98.0"))
        );
        assert_eq!(
            msg(attach_gate_verdict(
                AttachForge::GitHub,
                Some("github.com"),
                Some("gh version 2.99.0"),
                true
            )),
            AS_BOT_REFUSAL
        );
        assert_eq!(
            msg(attach_gate_verdict(
                AttachForge::GitLab,
                None,
                Some("glab 1.90.9"),
                true
            )),
            glab_version_refusal(Some("1.90.9"))
        );
        assert!(attach_gate_verdict(AttachForge::GitLab, None, Some("glab 1.91.0"), false).is_ok());
    }

    #[test]
    fn attach_timeout_adds_thirty_seconds_per_file() {
        assert_eq!(
            attach_timeout(3),
            crate::github::runner::GH_NETWORK_TIMEOUT + Duration::from_secs(90)
        );
    }

    // The health probe's reading: stdout then stderr, first line, trimmed.
    #[test]
    fn version_line_reads_like_the_health_probe() {
        let gh = "gh version 2.94.0 (2025-01-01)\nhttps://github.com/cli/cli\n";
        assert_eq!(
            version_line(gh, "").as_deref(),
            Some("gh version 2.94.0 (2025-01-01)")
        );
        assert_eq!(
            version_line("", "glab 1.91.0 (abc)\n").as_deref(),
            Some("glab 1.91.0 (abc)")
        );
        assert_eq!(
            version_line("  v1.2.3  \r\n", "x").as_deref(),
            Some("v1.2.3")
        );
        assert_eq!(version_line("", ""), None);
        assert_eq!(version_line("\n", "glab 1.91.0"), None);
        assert_eq!(version_line("   ", ""), None);
    }
}
