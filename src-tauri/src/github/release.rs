//! GitHub Releases via the `gh` CLI (`gh release …`). Releases hang off git
//! tags; this is the GitHub metadata layer (notes, assets, draft/prerelease)
//! over the local tags listed by `git_list_tags`.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::github::runner::{run_gh, GH_NETWORK_TIMEOUT, GH_TIMEOUT};

/// gh emits `null` for absent strings (a draft's `publishedAt`, an empty body);
/// fold those into "" so the frontend sees a plain string.
fn de_null_string<'de, D>(d: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(d)?.unwrap_or_default())
}

/// Every `gh_release_*` entry point runs this before assembling argv, so a tag
/// reaches gh only after the shared tag rules; remapped to this surface's wording.
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
    #[serde(default, deserialize_with = "de_null_string")]
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
#[tauri::command]
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
        .map_err(|e| AppError::Gh(format!("could not parse gh release list: {e}")))
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
    #[serde(default, deserialize_with = "de_null_string")]
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
#[tauri::command]
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
    let raw: RawRelease = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse gh release view: {e}")))?;
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

/// Creates a release for `tag` (gh creates the tag off `target` if it doesn't
/// exist). `generate_notes` adds GitHub's auto commit-based notes; an explicit
/// `notes` body is included too. Returns the new release's URL.
#[tauri::command]
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
    let title = title.trim();
    let notes = notes.trim();
    let target = target.trim();
    let mut args: Vec<&str> = vec!["release", "create", &tag, "--repo", &slug];
    if !title.is_empty() {
        args.push("--title");
        args.push(title);
    }
    if !notes.is_empty() {
        args.push("--notes");
        args.push(notes);
    }
    if !target.is_empty() {
        args.push("--target");
        args.push(target);
    }
    if prerelease {
        args.push("--prerelease");
    }
    if draft {
        args.push("--draft");
    }
    if latest {
        args.push("--latest");
    }
    let out = run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;
    Ok(out.stdout_lossy().trim().to_string())
}

/// Edits a release's title/notes/flags. `draft=false` on a draft publishes it.
#[tauri::command]
pub async fn gh_release_edit(
    repo_path: String,
    tag: String,
    title: String,
    notes: String,
    prerelease: bool,
    draft: bool,
    latest: Option<bool>,
) -> AppResult<()> {
    validate_tag(&tag)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    // `--prerelease`/`--draft` take an explicit value so they can be turned off too;
    // both are draft-legal, so the explicit form is always correct for them.
    //
    // `--latest` is tri-state: only send it when we have a real intent (`Some`), and
    // omit it entirely on `None`. A draft's Latest is structurally false (GitHub only
    // computes Latest among published stable releases), so forcing `--latest=false`
    // when publishing would override GitHub's own default of marking a newly published
    // stable release Latest — the v0.4.0 bug where publishing a draft stripped Latest.
    // Omitting the flag = gh sends nothing, so GitHub keeps/decides Latest natively.
    let prerelease_flag = format!("--prerelease={prerelease}");
    let draft_flag = format!("--draft={draft}");
    let latest_flag = latest.map(|l| format!("--latest={l}"));
    let title = title.trim();
    let notes = notes.trim();
    let mut args: Vec<&str> = vec![
        "release",
        "edit",
        &tag,
        "--repo",
        &slug,
        &prerelease_flag,
        &draft_flag,
    ];
    if let Some(latest_flag) = latest_flag.as_ref() {
        args.push(latest_flag);
    }
    if !title.is_empty() {
        args.push("--title");
        args.push(title);
    }
    if !notes.is_empty() {
        args.push("--notes");
        args.push(notes);
    }
    run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;
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
    // `gh api` has no `-R`; build the literal `repos/<slug>` path so a fork
    // generates notes for its OWN releases, not the parent's.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let notes_path = format!("repos/{slug}/releases/generate-notes");
    let tag_arg = format!("tag_name={tag}");
    let target_arg = format!("target_commitish={}", target.trim());
    let prev_arg = format!("previous_tag_name={}", previous_tag.trim());
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
    if !previous_tag.trim().is_empty() {
        args.push("-f");
        args.push(&prev_arg);
    }
    let out = run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse generated notes: {e}")))
}

/// Deletes a release. `cleanup_tag` also deletes the underlying git tag.
#[tauri::command]
pub async fn gh_release_delete(
    repo_path: String,
    tag: String,
    cleanup_tag: bool,
) -> AppResult<()> {
    validate_tag(&tag)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let mut args: Vec<&str> = vec!["release", "delete", &tag, "--repo", &slug, "--yes"];
    if cleanup_tag {
        args.push("--cleanup-tag");
    }
    run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

/// Uploads (clobbering) a local file as a release asset.
#[tauri::command]
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
    .await?;
    Ok(())
}

#[tauri::command]
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
    .await?;
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
    let mut value: serde_json::Value = serde_json::from_str(manifest)
        .map_err(|e| AppError::Gh(format!("could not parse {UPDATER_MANIFEST}: {e}")))?;
    let obj = value.as_object_mut().ok_or_else(|| {
        AppError::Gh(format!("{UPDATER_MANIFEST} is not a JSON object"))
    })?;
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
    .await;
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
