//! Repo lifecycle: change visibility, transfer, delete (irreversible — gated
//! behind a type-the-name confirmation; delete needs the `delete_repo` scope),
//! plus the reversible archive/unarchive and rename.

use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::github::runner::{run_gh, run_gh_input, GH_NETWORK_TIMEOUT};

/// A GitHub user/org login: alphanumerics + single hyphens, ≤39 chars.
fn validate_owner(login: &str) -> AppResult<()> {
    let ok = !login.is_empty()
        && login.len() <= 39
        && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !login.starts_with('-')
        && !login.ends_with('-');
    if !ok {
        return Err(AppError::InvalidArgument(format!(
            "invalid owner: {login}"
        )));
    }
    Ok(())
}

/// A repository name: letters, digits, `.`, `-`, `_`; non-empty, ≤100.
fn validate_repo_name(name: &str) -> AppResult<()> {
    let ok = !name.is_empty()
        && name.len() <= 100
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !ok {
        return Err(AppError::InvalidArgument(format!(
            "invalid repository name: {name}"
        )));
    }
    Ok(())
}

/// Archives or unarchives the repo. Archiving makes it read-only (reversible).
///
/// Pins the origin slug: `gh api`'s `{owner}/{repo}` placeholders auto-resolve
/// to the PARENT on a fork with an `upstream` remote — so an unpinned call would
/// archive the upstream repo. Build the literal `repos/<slug>` path instead.
pub async fn gh_repo_set_archived(repo_path: String, archived: bool) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let body = json!({ "archived": archived });
    run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "PATCH",
            &format!("repos/{slug}"),
            "--input",
            "-",
        ],
        &body.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Renames the repo. GitHub auto-redirects old links/clones to the new name.
///
/// Pins the origin slug so a fork's rename can't retarget the upstream parent
/// (see `gh_repo_set_archived`).
pub async fn gh_repo_rename(repo_path: String, new_name: String) -> AppResult<()> {
    let new_name = new_name.trim();
    validate_repo_name(new_name)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let body = json!({ "name": new_name });
    run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "PATCH",
            &format!("repos/{slug}"),
            "--input",
            "-",
        ],
        &body.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Changes repository visibility. `visibility` ∈ public | private | internal
/// (`internal` needs the org to belong to an enterprise — gh's error explains).
/// Pins the origin slug (see `gh_repo_set_archived`).
pub async fn gh_repo_set_visibility(repo_path: String, visibility: String) -> AppResult<()> {
    if !matches!(visibility.as_str(), "public" | "private" | "internal") {
        return Err(AppError::InvalidArgument(format!(
            "invalid visibility: {visibility}"
        )));
    }
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let body = json!({ "visibility": visibility });
    run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "PATCH",
            &format!("repos/{slug}"),
            "--input",
            "-",
        ],
        &body.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Transfers the repo to `new_owner` (user or org). Returns 202; a transfer to a
/// personal account is pending until the recipient accepts.
///
/// Pins the origin slug: without it a fork's transfer would target the upstream
/// PARENT (see `gh_repo_set_archived`).
pub async fn gh_repo_transfer(
    repo_path: String,
    new_owner: String,
    new_name: Option<String>,
) -> AppResult<()> {
    let new_owner = new_owner.trim();
    validate_owner(new_owner)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let mut body = json!({ "new_owner": new_owner });
    if let Some(name) = new_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        body["new_name"] = json!(name);
    }
    run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "POST",
            &format!("repos/{slug}/transfer"),
            "--input",
            "-",
        ],
        &body.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Permanently deletes the GitHub repository. Needs the `delete_repo` scope (a
/// missing scope surfaces as gh's error). The local clone is untouched.
///
/// Pins the origin slug: an unpinned DELETE on a fork with an `upstream` remote
/// would resolve to — and delete — the PARENT repo (see `gh_repo_set_archived`).
pub async fn gh_repo_delete(repo_path: String) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &["api", "--method", "DELETE", &format!("repos/{slug}")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}
