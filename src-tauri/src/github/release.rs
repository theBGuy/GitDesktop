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

fn validate_tag(tag: &str) -> AppResult<()> {
    if tag.is_empty() || tag.starts_with('-') {
        return Err(AppError::InvalidArgument(format!("invalid tag: {tag}")));
    }
    Ok(())
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
    let out = run_gh(
        Some(&repo_path),
        &["release", "list", "--limit", "100", "--json", LIST_FIELDS],
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
    let out = run_gh(
        Some(&repo_path),
        &["release", "view", &tag, "--json", VIEW_FIELDS],
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
    let title = title.trim();
    let notes = notes.trim();
    let target = target.trim();
    let mut args: Vec<&str> = vec!["release", "create", &tag];
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
    latest: bool,
) -> AppResult<()> {
    validate_tag(&tag)?;
    // gh's bool flags take an explicit value so they can be turned off too.
    let prerelease_flag = format!("--prerelease={prerelease}");
    let draft_flag = format!("--draft={draft}");
    let latest_flag = format!("--latest={latest}");
    let title = title.trim();
    let notes = notes.trim();
    let mut args: Vec<&str> = vec![
        "release",
        "edit",
        &tag,
        &prerelease_flag,
        &draft_flag,
        &latest_flag,
    ];
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
    let tag_arg = format!("tag_name={tag}");
    let target_arg = format!("target_commitish={}", target.trim());
    let prev_arg = format!("previous_tag_name={}", previous_tag.trim());
    let mut args: Vec<&str> = vec![
        "api",
        "--method",
        "POST",
        "repos/{owner}/{repo}/releases/generate-notes",
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
    let mut args: Vec<&str> = vec!["release", "delete", &tag, "--yes"];
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
    run_gh(
        Some(&repo_path),
        &["release", "upload", &tag, &file_path, "--clobber"],
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
    run_gh(
        Some(&repo_path),
        &["release", "delete-asset", &tag, &asset_name, "--yes"],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
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
    run_gh(
        Some(&repo_path),
        &[
            "release",
            "download",
            &tag,
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
