//! GitHub Releases via the `gh` CLI (`gh release …`). Releases hang off git
//! tags; this is the GitHub metadata layer (notes, assets, draft/prerelease)
//! over the local tags listed by `git_list_tags`.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::pr::run_gh_text_write;
use crate::github::runner::{run_gh, run_gh_input, GH_NETWORK_TIMEOUT, GH_TIMEOUT};

/// gh emits `null` for absent strings (an empty body, a missing target); fold
/// those into "" so the frontend sees a plain string.
fn de_null_string<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

/// A gh timestamp: null and Go's zero time both mean "none" and fold to "".
/// `release list` decodes `publishedAt` into a non-pointer `time.Time`, so an
/// unpublished draft arrives as `0001-01-01T00:00:00Z`, which parses as a date.
fn de_gh_time<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let time = Option::<String>::deserialize(d)?.unwrap_or_default();
    Ok(if time.starts_with("0001-01-01") {
        String::new()
    } else {
        time
    })
}

/// Every tag-taking `gh_release_*` entry point runs this before assembling argv,
/// so a tag reaches gh only after the shared tag rules; remapped to this
/// surface's wording.
fn validate_tag(tag: &str) -> AppResult<()> {
    crate::git::ops::validate_tag_name(tag)
        .map_err(|_| AppError::InvalidArgument(format!("invalid tag: {tag}")))
}

/// One release in the list view (merged with tags on the frontend by tagName).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub tag_name: String,
    #[serde(default, deserialize_with = "de_null_string")]
    pub name: String,
    #[serde(default)]
    pub is_draft: bool,
    #[serde(default)]
    pub is_prerelease: bool,
    #[serde(default)]
    pub is_latest: bool,
    #[serde(default, deserialize_with = "de_gh_time")]
    pub published_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseAsset {
    pub name: String,
    pub size: u64,
    pub download_count: u64,
    pub url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseDetails {
    pub tag_name: String,
    pub name: String,
    pub body: String,
    pub author: String,
    pub published_at: String,
    pub is_draft: bool,
    pub is_prerelease: bool,
    pub target_commitish: String,
    pub url: String,
    pub assets: Vec<ReleaseAsset>,
}

const LIST_FIELDS: &str =
    "tagName,name,isDraft,isPrerelease,isLatest,publishedAt";

/// Repository releases, newest first (gh's default order).
pub async fn gh_release_list(repo_path: String) -> AppResult<Vec<ReleaseInfo>> {
    // Pin the origin slug: an unpinned `gh release` on a fork with an `upstream`
    // remote auto-resolves to the PARENT, listing the parent's releases. The
    // `release` command family accepts `-R OWNER/REPO` (verified with --help).
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "release",
            "list",
            "--repo",
            &slug,
            "--limit",
            "100",
            "--json",
            LIST_FIELDS,
        ],
        GH_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| gh_unreadable("releases", format!("could not parse gh release list: {e}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAuthor {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAsset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    download_count: u64,
    #[serde(default)]
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default, deserialize_with = "de_null_string")]
    name: String,
    #[serde(default, deserialize_with = "de_null_string")]
    body: String,
    author: Option<RawAuthor>,
    #[serde(default, deserialize_with = "de_gh_time")]
    published_at: String,
    #[serde(default)]
    is_draft: bool,
    #[serde(default)]
    is_prerelease: bool,
    #[serde(default, deserialize_with = "de_null_string")]
    target_commitish: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    assets: Vec<RawAsset>,
}

const VIEW_FIELDS: &str = "tagName,name,body,author,publishedAt,isDraft,isPrerelease,targetCommitish,url,assets";

/// Full details for one release, by its tag.
pub async fn gh_release_view(
    repo_path: String,
    tag: String,
) -> AppResult<ReleaseDetails> {
    validate_tag(&tag)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "release",
            "view",
            &tag,
            "--repo",
            &slug,
            "--json",
            VIEW_FIELDS,
        ],
        GH_TIMEOUT,
    )
    .await?;
    let raw: RawRelease = serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
        gh_unreadable(
            "the release",
            format!("could not parse gh release view: {e}"),
        )
    })?;
    Ok(ReleaseDetails {
        tag_name: raw.tag_name,
        name: raw.name,
        body: raw.body,
        author: raw.author.map(|a| a.login).unwrap_or_default(),
        published_at: raw.published_at,
        is_draft: raw.is_draft,
        is_prerelease: raw.is_prerelease,
        target_commitish: raw.target_commitish,
        url: raw.url,
        assets: raw
            .assets
            .into_iter()
            .map(|a| ReleaseAsset {
                name: a.name,
                size: a.size,
                download_count: a.download_count,
                url: a.url,
            })
            .collect(),
    })
}

/// The `gh release create` argv: `--title`/`--target` append only when
/// non-empty (empty and unset both mean "let gh decide", so there is nothing to
/// send). Owned `Vec<String>` for the same reason its sibling `release_edit_args`
/// needs one — `--prerelease=`/`--draft=` there are locally-computed `format!`
/// strings that can't outlive a borrowed return — even though every value here
/// happens to come from a caller-owned `&str` that could borrow. Pure, so the
/// shape is pinned without a spawn. The notes never ride argv: [`run_gh_text_write`]
/// sends them on stdin.
fn release_create_args(
    slug: &str,
    tag: &str,
    title: &str,
    target: &str,
    prerelease: bool,
    draft: bool,
    latest: bool,
) -> Vec<String> {
    let mut args = vec![
        "release".to_string(),
        "create".to_string(),
        tag.to_string(),
        "--repo".to_string(),
        slug.to_string(),
    ];
    if !title.is_empty() {
        args.push("--title".to_string());
        args.push(title.to_string());
    }
    if !target.is_empty() {
        args.push("--target".to_string());
        args.push(target.to_string());
    }
    if prerelease {
        args.push("--prerelease".to_string());
    }
    if draft {
        args.push("--draft".to_string());
    }
    if latest {
        args.push("--latest".to_string());
    }
    args
}

/// Creates a release for `tag` (gh creates the tag off `target` if it doesn't
/// exist). Returns the new release's URL.
#[allow(clippy::too_many_arguments)]
pub async fn gh_release_create(
    repo_path: String,
    tag: String,
    title: String,
    notes: String,
    target: String,
    prerelease: bool,
    draft: bool,
    latest: bool,
) -> AppResult<String> {
    validate_tag(&tag)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let args = release_create_args(
        &slug,
        &tag,
        title.trim(),
        target.trim(),
        prerelease,
        draft,
        latest,
    );
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_gh_text_write(&repo_path, &arg_refs, "--notes-file", notes.trim())
        .await
        .map_err(|e| {
            crate::forge::timed_out_write(
                e,
                "GitHub",
                crate::forge::LandedWrite::Created("release"),
            )
        })?;
    Ok(out.stdout_lossy().trim().to_string())
}

/// The `gh release edit` argv. `--prerelease`/`--draft` ALWAYS carry an explicit
/// `=true`/`=false` — both are draft-legal to flip either way, so the bare flag
/// (which would only ever mean "on") is never correct here. `--latest` is
/// tri-state: only sent on a real caller intent (`Some`), omitted entirely on
/// `None` so GitHub decides it natively. Forcing `--latest=false` on every
/// draft-publish (`None` folded to `false`) was the v0.4.0 bug: it overrode
/// GitHub's own default of marking a newly published stable release Latest, so
/// publishing a draft silently stripped Latest. Pure, so the shape — and that
/// history — is pinned without a spawn. The notes ride stdin, planned by
/// [`release_notes_write`].
fn release_edit_args(
    slug: &str,
    tag: &str,
    title: &str,
    prerelease: bool,
    draft: bool,
    latest: Option<bool>,
) -> Vec<String> {
    let mut args = vec![
        "release".to_string(),
        "edit".to_string(),
        tag.to_string(),
        "--repo".to_string(),
        slug.to_string(),
        format!("--prerelease={prerelease}"),
        format!("--draft={draft}"),
    ];
    if let Some(latest) = latest {
        args.push(format!("--latest={latest}"));
    }
    if !title.is_empty() {
        args.push("--title".to_string());
        args.push(title.to_string());
    }
    args
}

/// What a release edit does with the notes.
#[derive(Debug, PartialEq, Eq)]
enum NotesWrite<'a> {
    /// Empty notes and no clear: no notes flag, so the release keeps its notes.
    Keep,
    /// Non-empty notes replace the release's notes.
    Send(&'a str),
    /// Empty notes with the clear signal: an empty notes file empties them.
    Clear,
}

/// Plans the notes half of a release edit from the TRIMMED notes. `clear` acts only
/// on empty notes, since empty notes alone mean "leave them" to the MCP caller.
fn release_notes_write(notes: &str, clear: bool) -> NotesWrite<'_> {
    match (notes.is_empty(), clear) {
        (false, _) => NotesWrite::Send(notes),
        (true, false) => NotesWrite::Keep,
        (true, true) => NotesWrite::Clear,
    }
}

/// Edits a release's title/notes/flags. `draft=false` on a draft publishes it.
/// `clear_notes` with empty notes empties the release's notes (gh sends an empty
/// `body` for an empty `--notes-file`).
#[allow(clippy::too_many_arguments)]
pub async fn gh_release_edit(
    repo_path: String,
    tag: String,
    title: String,
    notes: String,
    prerelease: bool,
    draft: bool,
    latest: Option<bool>,
    clear_notes: bool,
) -> AppResult<()> {
    validate_tag(&tag)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let args = release_edit_args(
        &slug,
        &tag,
        title.trim(),
        prerelease,
        draft,
        latest,
    );
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let saved = |e: AppError| {
        crate::forge::timed_out_write(e, "GitHub", crate::forge::LandedWrite::Saved("release"))
    };
    match release_notes_write(notes.trim(), clear_notes) {
        NotesWrite::Clear => {
            let clear = [arg_refs.as_slice(), &["--notes-file", "-"]].concat();
            run_gh_input(Some(&repo_path), &clear, "", GH_NETWORK_TIMEOUT)
                .await
                .map_err(saved)?;
        }
        NotesWrite::Keep => {
            run_gh(Some(&repo_path), &arg_refs, GH_NETWORK_TIMEOUT)
                .await
                .map_err(saved)?;
        }
        NotesWrite::Send(text) => {
            run_gh_text_write(&repo_path, &arg_refs, "--notes-file", text)
                .await
                .map_err(saved)?;
        }
    }
    Ok(())
}

/// GitHub's auto-generated release notes (the "Generate release notes" button):
/// PR/commit-based notes for `tag` relative to the last release. Returns a
/// suggested title + body so the user can preview/edit before publishing.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedNotes {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub body: String,
}

#[tauri::command]
pub async fn gh_release_generate_notes(
    repo_path: String,
    tag: String,
    target: String,
    previous_tag: String,
) -> AppResult<GeneratedNotes> {
    validate_tag(&tag)?;
    let prev = previous_tag.trim();
    // Empty previous_tag = GitHub auto-detects; validate only when supplied,
    // with distinct wording — the dialog has BOTH tag fields.
    if !prev.is_empty() {
        crate::git::ops::validate_tag_name(prev).map_err(|_| {
            AppError::InvalidArgument(format!("invalid previous tag: {prev}"))
        })?;
    }
    // `gh api` has no `-R`; build the literal `repos/<slug>` path so a fork
    // generates notes for its OWN releases, not the parent's.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let notes_path = format!("repos/{slug}/releases/generate-notes");
    let tag_arg = format!("tag_name={tag}");
    let target_arg = format!("target_commitish={}", target.trim());
    let prev_arg = format!("previous_tag_name={prev}");
    let mut args: Vec<&str> = vec![
        "api",
        "--method",
        "POST",
        &notes_path,
        "-f",
        &tag_arg,
    ];
    // Only needed when the tag doesn't exist yet (a new release).
    if !target.trim().is_empty() {
        args.push("-f");
        args.push(&target_arg);
    }
    // Empty = GitHub auto-detects the previous release.
    if !prev.is_empty() {
        args.push("-f");
        args.push(&prev_arg);
    }
    let out = run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;
    serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
        gh_unreadable(
            "the release notes",
            format!("could not parse generated notes: {e}"),
        )
    })
}

/// The `gh release delete` argv: `--cleanup-tag` appends only when asked. Pure, so
/// the shape is pinned without a spawn.
fn release_delete_args<'a>(slug: &'a str, tag: &'a str, cleanup_tag: bool) -> Vec<&'a str> {
    let mut args = vec!["release", "delete", tag, "--repo", slug, "--yes"];
    if cleanup_tag {
        args.push("--cleanup-tag");
    }
    args
}

/// Deletes a release. `cleanup_tag` also deletes the underlying git tag.
pub async fn gh_release_delete(
    repo_path: String,
    tag: String,
    cleanup_tag: bool,
) -> AppResult<()> {
    validate_tag(&tag)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let args = release_delete_args(&slug, &tag, cleanup_tag);
    run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT)
        .await
        .map_err(|e| {
            crate::forge::timed_out_write(e, "GitHub", crate::forge::LandedWrite::Changed)
        })?;
    Ok(())
}

/// Uploads (clobbering) a local file as a release asset.
pub async fn gh_release_upload_asset(
    repo_path: String,
    tag: String,
    file_path: String,
) -> AppResult<()> {
    validate_tag(&tag)?;
    if file_path.trim().is_empty() {
        return Err(AppError::InvalidArgument("a file is required".into()));
    }
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &[
            "release",
            "upload",
            &tag,
            &file_path,
            "--repo",
            &slug,
            "--clobber",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await
    .map_err(|e| crate::forge::timed_out_write(e, "GitHub", crate::forge::LandedWrite::Changed))?;
    Ok(())
}

pub async fn gh_release_delete_asset(
    repo_path: String,
    tag: String,
    asset_name: String,
) -> AppResult<()> {
    validate_tag(&tag)?;
    if asset_name.trim().is_empty() {
        return Err(AppError::InvalidArgument("an asset name is required".into()));
    }
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &[
            "release",
            "delete-asset",
            &tag,
            &asset_name,
            "--repo",
            &slug,
            "--yes",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await
    .map_err(|e| crate::forge::timed_out_write(e, "GitHub", crate::forge::LandedWrite::Changed))?;
    Ok(())
}

/// Tauri's updater manifest, attached to a release as an asset of this exact name.
const UPDATER_MANIFEST: &str = "latest.json";

/// Replaces the manifest's `notes` and nothing else — `version`, `pub_date` and
/// every platform's URL + signature must survive verbatim or installed apps stop
/// trusting the update. Absent `notes` is added. Re-serializing alphabetizes the
/// keys (serde_json's Map is a BTreeMap without `preserve_order`), so the result
/// isn't byte-diffable against CI's original; values are preserved and the
/// manifest itself carries no signature over its own bytes. Rejects anything that
/// doesn't carry the updater shape (string `version` + object `platforms`), so an
/// unrelated asset that merely shares the name is never rewritten.
fn patch_updater_notes(manifest: &str, notes: &str) -> AppResult<String> {
    let mut value: serde_json::Value = serde_json::from_str(manifest).map_err(|e| {
        gh_unreadable(
            "the updater manifest",
            format!("could not parse {UPDATER_MANIFEST}: {e}"),
        )
    })?;
    let obj = value
        .as_object_mut()
        .ok_or_else(|| AppError::Gh(format!("{UPDATER_MANIFEST} is not a JSON object")))?;
    // Gate the shape here, before anything uploads: the re-upload clobbers, so
    // rewriting a same-named asset that isn't an updater manifest (a repo's own
    // version pointer, say) would destroy it. Failing on this path deletes nothing.
    if !obj.get("version").is_some_and(serde_json::Value::is_string)
        || !obj.get("platforms").is_some_and(serde_json::Value::is_object)
    {
        return Err(AppError::Gh(format!(
            "{UPDATER_MANIFEST} isn't a Tauri updater manifest (needs a string \
             `version` and an object `platforms`) — it was left unchanged."
        )));
    }
    obj.insert("notes".to_string(), serde_json::Value::String(notes.to_string()));
    serde_json::to_string_pretty(&value)
        .map_err(|e| AppError::Gh(format!("could not write {UPDATER_MANIFEST}: {e}")))
}

/// Parks the patched manifest outside the temp dir when the upload fails, under the
/// `latest.json` BASENAME a re-upload needs (the asset takes its name from the file).
/// The directory is created EXCLUSIVELY by `Builder::tempdir` before it's persisted —
/// a guessable name under the shared temp dir could be pre-created as a symlink by a
/// local attacker and redirect the copy. Best-effort: failing here only costs the
/// recovery hint, so it degrades to `None` rather than masking the upload error that
/// prompted it.
async fn save_updater_recovery_copy(src: std::path::PathBuf) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        let dir = tempfile::Builder::new()
            .prefix("gd-updater-recovery-")
            .tempdir()
            .ok()?;
        std::fs::copy(&src, dir.path().join(UPDATER_MANIFEST)).ok()?;
        // Outlives this call by design — the user needs it to re-attach the asset.
        let kept = dir.keep();
        Some(kept.join(UPDATER_MANIFEST).to_string_lossy().into_owned())
    })
    .await
    .ok()
    .flatten()
}

/// Re-points a release's updater manifest at `notes`, so apps updating from that
/// release show the same body the release page does. Download → patch → re-upload
/// with `--clobber`, which gh implements as delete-THEN-upload: the manifest is
/// briefly absent, and a failed upload leaves it deleted rather than stale. That
/// makes the failure unrecoverable from the UI alone (the release no longer has the
/// asset to re-download), so a failed upload parks the patched copy on disk when it
/// can, naming its path in the error for a manual re-attach.
pub async fn gh_release_sync_updater_notes(
    repo_path: &str,
    tag: &str,
    notes: &str,
) -> AppResult<()> {
    validate_tag(tag)?;
    let slug = crate::github::gh_origin_slug(repo_path).await?;
    let dir = tokio::task::spawn_blocking(tempfile::tempdir)
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    let dir_arg = dir.path().to_string_lossy().to_string();
    run_gh(
        Some(repo_path),
        &[
            "release",
            "download",
            tag,
            "--repo",
            &slug,
            "--pattern",
            UPDATER_MANIFEST,
            "--dir",
            &dir_arg,
            "--clobber",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let path = dir.path().join(UPDATER_MANIFEST);
    let file_arg = path.to_string_lossy().to_string();
    let (patch_path, notes_owned) = (path.clone(), notes.to_string());
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        // Local filesystem failures stay `Io` — surfacing them as `Gh` would blame
        // GitHub for a problem on this machine.
        let current = std::fs::read_to_string(&patch_path).map_err(AppError::Io)?;
        std::fs::write(&patch_path, patch_updater_notes(&current, &notes_owned)?)?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    let upload = run_gh(
        Some(repo_path),
        &[
            "release",
            "upload",
            tag,
            &file_arg,
            "--repo",
            &slug,
            "--clobber",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await
    .map_err(|e| crate::forge::timed_out_write(e, "GitHub", crate::forge::LandedWrite::Changed));
    if let Err(e) = upload {
        return Err(match save_updater_recovery_copy(path).await {
            Some(saved) => AppError::Gh(format!(
                "{e}\n\nThe patched {UPDATER_MANIFEST} was saved to {saved} — upload \
                 that file to the release to restore the manifest."
            )),
            None => AppError::Gh(format!(
                "{e}\n\nThe patched {UPDATER_MANIFEST} could not be saved locally, so \
                 the release may now have no updater manifest."
            )),
        });
    }
    Ok(())
}

/// Downloads one asset (by exact name, used as the glob pattern) into `dir`.
#[tauri::command]
pub async fn gh_release_download_asset(
    repo_path: String,
    tag: String,
    asset_name: String,
    dir: String,
) -> AppResult<()> {
    validate_tag(&tag)?;
    if dir.trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "a download folder is required".into(),
        ));
    }
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &[
            "release",
            "download",
            &tag,
            "--repo",
            &slug,
            "--pattern",
            &asset_name,
            "--dir",
            &dir,
            "--clobber",
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every optional flag appends only when its value is non-empty/true; a fully
    /// bare call carries none of them.
    #[test]
    fn release_create_args_appends_optional_flags_only_when_given() {
        let bare = release_create_args("o/r", "v1.0.0", "", "", false, false, false);
        assert_eq!(bare, ["release", "create", "v1.0.0", "--repo", "o/r"]);

        let full = release_create_args("o/r", "v1.0.0", "Title", "main", true, true, true);
        assert_eq!(
            full,
            [
                "release",
                "create",
                "v1.0.0",
                "--repo",
                "o/r",
                "--title",
                "Title",
                "--target",
                "main",
                "--prerelease",
                "--draft",
                "--latest",
            ]
        );
    }

    /// The create hands its trimmed notes to the one stdin choke point, and each release
    /// write maps its timeout to the hedge with its noun: the create once after its run,
    /// the edit through one closure each notes arm applies to its own run (its plan is
    /// pinned below).
    #[test]
    fn release_writes_send_their_notes_on_stdin() {
        let src = include_str!("release.rs");
        let src = src.split("\nmod tests {").next().unwrap();
        let on_stdin = |body: &str| {
            let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
            flat.contains("run_gh_text_write(")
                && flat.contains("\"--notes-file\", notes.trim())")
                && !flat.contains("run_gh(")
        };
        let body = crate::github::repo_meta::tests::wiring_body(src, "gh_release_create");
        assert!(on_stdin(&body), "{body}");
        let argv = format!("{body}\nrun_gh(Some(&repo_path), &arg_refs, GH_NETWORK_TIMEOUT)");
        assert!(!on_stdin(&argv), "an argv run must flip");

        let create_mapped = |body: &str| {
            body.matches("timed_out_write(").count() == 1
                && body.contains("LandedWrite::Created(\"release\")")
                && body
                    .find("run_gh_text_write(")
                    .zip(body.find("timed_out_write("))
                    .is_some_and(|(run, map)| run < map)
        };
        assert!(create_mapped(&body), "{body}");
        let deleted = body.replacen("timed_out_write(", "mapped(", 1);
        assert!(!create_mapped(&deleted), "create: a deleted map must flip");

        let edit = crate::github::repo_meta::tests::wiring_body(src, "gh_release_edit");
        // Each notes arm, read up to the next arm, maps its own run once.
        let arms = [
            ("NotesWrite::Clear =>", "run_gh_input("),
            ("NotesWrite::Keep =>", "run_gh("),
            ("NotesWrite::Send(text) =>", "run_gh_text_write("),
        ];
        let edit_mapped = |body: &str| {
            body.matches("timed_out_write(").count() == 1
                && body.contains("LandedWrite::Saved(\"release\")")
                && arms.iter().all(|(arm, run)| {
                    body.split_once(arm).is_some_and(|(_, rest)| {
                        let own = rest.split("NotesWrite::").next().unwrap();
                        own.matches(".map_err(saved)").count() == 1
                            && own
                                .find(run)
                                .zip(own.find(".map_err(saved)"))
                                .is_some_and(|(run, map)| run < map)
                    })
                })
        };
        assert!(edit_mapped(&edit), "{edit}");
        let deleted = edit.replacen("timed_out_write(", "mapped(", 1);
        assert!(!edit_mapped(&deleted), "edit: a deleted map must flip");
        let bare_arm = edit.replacen(".map_err(saved)?;", "?;", 1);
        assert!(!edit_mapped(&bare_arm), "edit: an unmapped arm must flip");
        let (head, keep) = edit.split_once("NotesWrite::Keep =>").unwrap();
        let swapped = format!(
            "{}NotesWrite::Keep =>{}",
            head.replacen(
                "release_edit_args(",
                ".map_err(saved)?; release_edit_args(",
                1
            ),
            keep.replacen(".map_err(saved)?;", "?;", 1)
        );
        assert_eq!(swapped.matches(".map_err(saved)?;").count(), 3);
        assert!(
            !edit_mapped(&swapped),
            "edit: a map moved off its arm must flip"
        );
    }

    /// The clear signal acts only on empty notes; everything else behaves as before.
    #[test]
    fn release_notes_write_clears_only_empty_notes_on_request() {
        assert_eq!(release_notes_write("", true), NotesWrite::Clear);
        assert_eq!(release_notes_write("", false), NotesWrite::Keep);
        assert_eq!(release_notes_write("x", true), NotesWrite::Send("x"));
        assert_eq!(release_notes_write("x", false), NotesWrite::Send("x"));
    }

    /// The edit plans its notes in one place: a clear runs gh on an empty stdin
    /// with `--notes-file -`, a keep runs gh with no notes flag, and a send writes
    /// the planner's own text through the shared text write.
    #[test]
    fn release_edit_clears_notes_through_an_empty_notes_file() {
        let src = include_str!("release.rs");
        let src = src.split("\nmod tests {").next().unwrap();
        let body = crate::github::repo_meta::tests::wiring_body(src, "gh_release_edit");
        let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
        let wired = |flat: &str| {
            flat.contains("match release_notes_write(notes.trim(), clear_notes) {")
                && flat.contains(
                    "NotesWrite::Keep => { run_gh(Some(&repo_path), &arg_refs, GH_NETWORK_TIMEOUT)",
                )
                && flat.contains("&[\"--notes-file\", \"-\"]")
                && flat.contains("run_gh_input(Some(&repo_path), &clear, \"\", GH_NETWORK_TIMEOUT)")
                && flat.contains(
                    "NotesWrite::Send(text) => { run_gh_text_write(&repo_path, &arg_refs, \"--notes-file\", text)",
                )
                && flat.matches("run_gh(").count() == 1
                && !flat.contains("\"--notes\"")
                && !flat.contains("\"-n\"")
                && !flat.contains("\"--notes=")
        };
        assert!(wired(&flat), "{flat}");
        let start = flat.find("NotesWrite::Clear =>").unwrap();
        let end = flat.find("NotesWrite::Keep =>").unwrap();
        let no_clear = format!("{}{}", &flat[..start], &flat[end..]);
        assert!(!wired(&no_clear), "dropping the clear arm must flip");
        let argv = format!("{flat} args.push(\"--notes\".into());");
        assert!(!wired(&argv), "a notes argv flag must flip");
        let second = format!("{flat} run_gh(Some(&repo_path), &x, GH_NETWORK_TIMEOUT)");
        assert!(!wired(&second), "a second argv run must flip");
        let short = format!("{flat} args.push(\"-n\".into());");
        assert!(!wired(&short), "a short notes flag must flip");
        let inline = format!("{flat} args.push(format!(\"--notes={{}}\", notes.trim()));");
        assert!(!wired(&inline), "an inline notes flag must flip");
        let resend = flat.replacen(
            "\"--notes-file\", text)",
            "\"--notes-file\", notes.trim())",
            1,
        );
        assert_ne!(resend, flat);
        assert!(!wired(&resend), "a send that re-reads the notes must flip");
        let keep_notes = flat.replacen(
            "run_gh(Some(&repo_path), &arg_refs, GH_NETWORK_TIMEOUT)",
            "run_gh_text_write(&repo_path, &arg_refs, \"--notes-file\", notes.trim())",
            1,
        );
        assert_ne!(keep_notes, flat);
        assert!(
            !wired(&keep_notes),
            "a keep that changes its call must flip"
        );
    }

    /// `gh release list` decodes `publishedAt` into a non-pointer Go time, so a
    /// draft's null arrives as the zero time; both reads fold it, and null, to "".
    #[test]
    fn release_reads_drop_the_go_zero_publish_time() {
        const ZERO: &str = "0001-01-01T00:00:00Z";
        const REAL: &str = "2026-06-30T07:06:16Z";
        let row = |published: &str| format!(r#"{{"tagName":"v1","publishedAt":{published}}}"#);
        let cases = [
            (format!("\"{ZERO}\""), ""),
            ("null".to_string(), ""),
            (format!("\"{REAL}\""), REAL),
        ];
        for (published, want) in &cases {
            let info: ReleaseInfo = serde_json::from_str(&row(published)).unwrap();
            assert_eq!(info.published_at, *want, "ReleaseInfo {published}");
            let raw: RawRelease = serde_json::from_str(&row(published)).unwrap();
            assert_eq!(raw.published_at, *want, "RawRelease {published}");
        }
        let absent: ReleaseInfo = serde_json::from_str(r#"{"tagName":"v1"}"#).unwrap();
        assert_eq!(absent.published_at, "");
        let absent: RawRelease = serde_json::from_str(r#"{"tagName":"v1"}"#).unwrap();
        assert_eq!(absent.published_at, "");

        let text = format!(r#"{{"tagName":"v1","name":"{ZERO}","body":"{ZERO}"}}"#);
        let info: ReleaseInfo = serde_json::from_str(&text).unwrap();
        assert_eq!(info.name, ZERO, "a name is not a timestamp");
        let raw: RawRelease = serde_json::from_str(&text).unwrap();
        assert_eq!((raw.name.as_str(), raw.body.as_str()), (ZERO, ZERO));
    }

    #[test]
    fn release_delete_args_appends_cleanup_tag_only_when_asked() {
        let plain = release_delete_args("o/r", "v1.0.0", false);
        assert_eq!(plain, ["release", "delete", "v1.0.0", "--repo", "o/r", "--yes"]);

        let cleanup = release_delete_args("o/r", "v1.0.0", true);
        assert_eq!(cleanup[..plain.len()], plain[..]);
        assert_eq!(cleanup[plain.len()..], ["--cleanup-tag"]);
    }

    /// The v0.4.0 regression, pinned: `--prerelease`/`--draft` always carry an
    /// explicit value (never a bare flag), and `--latest` is either absent
    /// (`None`) or an explicit `=true`/`=false` — never synthesized from `None`.
    #[test]
    fn release_edit_args_keeps_latest_tri_state_and_flags_explicit() {
        let no_intent = release_edit_args("o/r", "v1.0.0", "", false, true, None);
        assert_eq!(
            no_intent,
            ["release", "edit", "v1.0.0", "--repo", "o/r", "--prerelease=false", "--draft=true"]
        );
        assert!(
            !no_intent.iter().any(|a| a.starts_with("--latest")),
            "None must add no --latest flag at all: {no_intent:?}"
        );

        let publish_as_latest = release_edit_args("o/r", "v1.0.0", "", false, false, Some(true));
        assert!(publish_as_latest.contains(&"--latest=true".to_string()));

        let publish_not_latest = release_edit_args("o/r", "v1.0.0", "", false, false, Some(false));
        assert!(publish_not_latest.contains(&"--latest=false".to_string()));

        // Neither `--prerelease` nor `--draft` ever appears as a bare flag.
        for args in [&no_intent, &publish_as_latest, &publish_not_latest] {
            assert!(!args.iter().any(|a| a == "--prerelease" || a == "--draft"), "{args:?}");
        }

        let titled = release_edit_args("o/r", "v1.0.0", "New Title", false, false, None);
        assert_eq!(titled[titled.len() - 2..], ["--title", "New Title"]);
    }

    const MANIFEST: &str = r#"{
      "version": "0.6.0",
      "notes": "old notes",
      "pub_date": "2026-07-31T00:00:00Z",
      "platforms": {
        "windows-x86_64": { "signature": "sig-abc", "url": "https://example/app.exe" }
      }
    }"#;

    #[test]
    fn patch_updater_notes_replaces_only_the_notes() {
        let out = patch_updater_notes(MANIFEST, "new notes").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["notes"], "new notes");
        assert_eq!(v["version"], "0.6.0");
        assert_eq!(v["pub_date"], "2026-07-31T00:00:00Z");
        assert_eq!(v["platforms"]["windows-x86_64"]["signature"], "sig-abc");
        assert_eq!(
            v["platforms"]["windows-x86_64"]["url"],
            "https://example/app.exe"
        );
    }

    #[test]
    fn patch_updater_notes_adds_absent_notes() {
        let out = patch_updater_notes(
            r#"{"version":"1.0.0","platforms":{"linux-x86_64":{"signature":"s","url":"u"}}}"#,
            "fresh",
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["notes"], "fresh");
        assert_eq!(v["version"], "1.0.0");
        assert_eq!(v["platforms"]["linux-x86_64"]["signature"], "s");
    }

    #[test]
    fn patch_updater_notes_rejects_a_non_object() {
        assert!(patch_updater_notes("[1, 2]", "x").is_err());
        assert!(patch_updater_notes("not json", "x").is_err());
    }

    /// A same-named asset that isn't an updater manifest must survive untouched —
    /// the re-upload clobbers, so a false accept would destroy it.
    #[test]
    fn patch_updater_notes_rejects_a_foreign_same_named_asset() {
        assert!(patch_updater_notes(r#"{"foo":1}"#, "x").is_err());
        // Right keys, wrong types.
        assert!(patch_updater_notes(r#"{"version":1,"platforms":{}}"#, "x").is_err());
        assert!(
            patch_updater_notes(r#"{"version":"1.0.0","platforms":[]}"#, "x").is_err()
        );
    }
}
