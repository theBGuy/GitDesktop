//! Repo collaborators + pending invitations. All via `gh api` on the user's
//! token (repo admin required — non-admins get gh's permission error). Team
//! access is org-level (admin:org) and lives with the org surface, not here.
//!
//! Vocabulary note: the collaborators PUT takes a `permission`
//! (pull/triage/push/maintain/admin) while invitations use `permissions`
//! (read/write/triage/maintain/admin). We normalize the UI on the invitation
//! vocabulary (read/write/…) and translate for the collaborators endpoint.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::runner::{run_gh, run_gh_input, GH_NETWORK_TIMEOUT};

/// One collaborator. Serializes camelCase for the frontend; deserializes from
/// GitHub's user object (snake_case aliases).
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Collaborator {
    pub login: String,
    #[serde(default, alias = "avatar_url")]
    pub avatar_url: String,
    /// read | triage | write | maintain | admin.
    #[serde(default, alias = "role_name")]
    pub role_name: String,
}

#[derive(Deserialize)]
struct RawInvitation {
    id: u64,
    invitee: Option<RawUser>,
    #[serde(default)]
    permissions: String,
    #[serde(default)]
    created_at: String,
}
#[derive(Deserialize)]
struct RawUser {
    #[serde(default)]
    login: String,
    #[serde(default)]
    avatar_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Invitation {
    /// 19-digit snowflake — serialized as a string (JS-safe).
    pub id: String,
    pub login: String,
    pub avatar_url: String,
    /// read | write | triage | maintain | admin.
    pub permission: String,
    pub created_at: String,
}

/// A GitHub username: alphanumerics + single hyphens, ≤39 chars, no leading/
/// trailing hyphen.
fn validate_username(u: &str) -> AppResult<()> {
    let ok = !u.is_empty()
        && u.len() <= 39
        && u.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !u.starts_with('-')
        && !u.ends_with('-');
    if !ok {
        return Err(AppError::InvalidArgument(format!(
            "invalid GitHub username: {u}"
        )));
    }
    Ok(())
}

fn validate_invitation_id(id: &str) -> AppResult<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::InvalidArgument(format!(
            "invalid invitation id: {id}"
        )));
    }
    Ok(())
}

/// Our canonical role → the collaborators endpoint's `permission` value.
fn collaborator_permission(role: &str) -> AppResult<&'static str> {
    match role {
        "read" => Ok("pull"),
        "write" => Ok("push"),
        "triage" => Ok("triage"),
        "maintain" => Ok("maintain"),
        "admin" => Ok("admin"),
        _ => Err(AppError::InvalidArgument(format!("invalid role: {role}"))),
    }
}

const INVITE_ROLES: &[&str] = &["read", "write", "triage", "maintain", "admin"];

#[tauri::command]
pub async fn gh_collaborators_list(repo_path: String) -> AppResult<Vec<Collaborator>> {
    // Pin the origin slug: `gh api`'s `{owner}/{repo}` placeholders auto-resolve
    // to the PARENT on a fork with an `upstream` remote, so build the literal
    // `repos/<slug>` path to keep collaborator admin on the user's own fork.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "api",
            "--paginate",
            &format!("repos/{slug}/collaborators?per_page=100&affiliation=all"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
        gh_unreadable(
            "collaborators",
            format!("could not parse collaborators: {e}"),
        )
    })
}

/// Adds or re-roles a collaborator. Returns `true` when GitHub created a pending
/// invitation (201 — the user must accept), `false` when access was granted
/// immediately (204 — e.g. an existing org member).
#[tauri::command]
pub async fn gh_collaborator_add(
    repo_path: String,
    username: String,
    role: String,
) -> AppResult<bool> {
    let username = username.trim();
    validate_username(username)?;
    let permission = collaborator_permission(&role)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let body = json!({ "permission": permission });
    let out = run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "PUT",
            &format!("repos/{slug}/collaborators/{username}"),
            "--input",
            "-",
        ],
        &body.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    // 201 returns the invitation object; 204 (immediate grant) returns nothing.
    Ok(!out.stdout_lossy().trim().is_empty())
}

#[tauri::command]
pub async fn gh_collaborator_remove(repo_path: String, username: String) -> AppResult<()> {
    let username = username.trim();
    validate_username(username)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "DELETE",
            &format!("repos/{slug}/collaborators/{username}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_invitations_list(repo_path: String) -> AppResult<Vec<Invitation>> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "api",
            "--paginate",
            &format!("repos/{slug}/invitations?per_page=100"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let raws: Vec<RawInvitation> = serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
        gh_unreadable(
            "the invitations",
            format!("could not parse invitations: {e}"),
        )
    })?;
    Ok(raws
        .into_iter()
        .map(|r| {
            let user = r.invitee.unwrap_or(RawUser {
                login: String::new(),
                avatar_url: String::new(),
            });
            Invitation {
                id: r.id.to_string(),
                login: user.login,
                avatar_url: user.avatar_url,
                permission: r.permissions,
                created_at: r.created_at,
            }
        })
        .collect())
}

#[tauri::command]
pub async fn gh_invitation_update(
    repo_path: String,
    id: String,
    permission: String,
) -> AppResult<()> {
    validate_invitation_id(&id)?;
    if !INVITE_ROLES.contains(&permission.as_str()) {
        return Err(AppError::InvalidArgument(format!(
            "invalid permission: {permission}"
        )));
    }
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let body = json!({ "permissions": permission });
    run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "PATCH",
            &format!("repos/{slug}/invitations/{id}"),
            "--input",
            "-",
        ],
        &body.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_invitation_cancel(repo_path: String, id: String) -> AppResult<()> {
    validate_invitation_id(&id)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "DELETE",
            &format!("repos/{slug}/invitations/{id}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}
