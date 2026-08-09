//! Admin-gated management of a remote GitHub repo: detecting admin access and
//! managing webhooks. All calls go through the `gh` CLI (see `runner`), so they
//! ride the user's existing `gh` token — a missing scope surfaces as gh's own
//! error, which the UI turns into a "run `gh auth refresh`" hint.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{AppError, AppResult};
use crate::github::runner::{
    run_gh, run_gh_input, run_gh_raw, GhOutput, GH_NETWORK_TIMEOUT, GH_TIMEOUT,
};

/// Whether the signed-in user is an admin on this repo — gates the repo-settings /
/// webhooks UI. Reads the viewer's `permissions.admin`; no access reads as `false`
/// rather than erroring. A repo without a GitHub origin remote errors.
#[tauri::command]
pub async fn gh_repo_admin(repo_path: String) -> AppResult<bool> {
    // Pin the origin slug: `gh api`'s `{owner}/{repo}` placeholders auto-resolve
    // to the PARENT on a fork with an `upstream` remote, which would probe the
    // upstream's admin bit instead of the user's own fork.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh_raw(
        Some(&repo_path),
        &["api", &format!("repos/{slug}"), "-q", ".permissions.admin"],
        GH_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(false);
    }
    Ok(out.stdout_lossy().trim() == "true")
}

/// The viewer's permission bits on `GET repos/{slug}`. Every flag is optional:
/// GitHub omits the whole block for an unauthenticated read and has added tiers
/// (triage/maintain) over time, so an absent flag must read as "didn't say"
/// rather than "false".
#[derive(Deserialize)]
struct GhRepoPermissions {
    #[serde(default)]
    admin: Option<bool>,
    #[serde(default)]
    maintain: Option<bool>,
    #[serde(default)]
    push: Option<bool>,
    #[serde(default)]
    triage: Option<bool>,
    #[serde(default)]
    pull: Option<bool>,
}

#[derive(Deserialize)]
struct GhRepoPermissionsJson {
    #[serde(default)]
    permissions: Option<GhRepoPermissions>,
}

/// The highest role the permission bits name, `None` when none is set. Ordered
/// most- to least-privileged: GitHub sets every tier at or below the viewer's.
fn role_from_permissions(p: &GhRepoPermissions) -> Option<String> {
    [
        (p.admin, "admin"),
        (p.maintain, "maintain"),
        (p.push, "write"),
        (p.triage, "triage"),
        (p.pull, "read"),
    ]
    .into_iter()
    .find(|(flag, _)| *flag == Some(true))
    .map(|(_, role)| role.to_string())
}

/// `(can_push, can_triage, role)`, the shape both the probe and its tests read.
type WriteAccessBits = (Option<bool>, Option<bool>, Option<String>);

/// The permission bits from a `GET repos/{slug}` body. Pure. `Err` carries the
/// unknown-reason: unparseable JSON or a missing `permissions` block means the
/// probe couldn't answer, which must never collapse into "cannot push".
///
/// Triage falls back to the push bit — a response predating the triage tier still
/// says a pusher can manage metadata; both absent stays unknown.
fn write_access_from_repo_json(repo_json: &str) -> Result<WriteAccessBits, String> {
    let parsed: GhRepoPermissionsJson = serde_json::from_str(repo_json)
        .map_err(|e| format!("could not read the repository's permissions: {e}"))?;
    let perms = parsed
        .permissions
        .ok_or_else(|| "the repository response carried no permissions".to_string())?;
    Ok((
        perms.push,
        perms.triage.or(perms.push),
        role_from_permissions(&perms),
    ))
}

/// A one-line reason for a failed `gh` call — its first non-empty stderr line,
/// or the exit status when gh said nothing. It reaches the UI, so keep it short.
fn gh_failure_reason(out: &GhOutput) -> String {
    out.stderr
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("gh exited with status {}", out.code))
}

/// Whether the signed-in viewer can push to this repo — the viewer-permission
/// probe behind `forge_repo_write_access`'s GitHub arm.
///
/// Resolved through the LENS, not origin: a fork PR targets the parent repo, and
/// the parent's permission is what gates that PR's controls. Every failure mode
/// (gh error, unparseable body, no `permissions` block) answers `can_push: None`
/// with a reason — `Some(false)` is reserved for GitHub affirmatively saying the
/// viewer can't push, so a broken probe never hides a control the user can use.
pub async fn gh_repo_write_access(
    repo_path: String,
    lens: Option<String>,
) -> AppResult<crate::forge::ForgeRepoWriteAccess> {
    let slug = crate::github::gh_lens_slug(&repo_path, lens.as_deref()).await?;
    let out = run_gh_raw(
        Some(&repo_path),
        &["api", &format!("repos/{slug}")],
        GH_TIMEOUT,
    )
    .await?;
    let unknown = |reason: String| crate::forge::ForgeRepoWriteAccess {
        can_push: None,
        can_triage: None,
        role: None,
        repo: Some(slug.clone()),
        unknown_reason: Some(reason),
    };
    if out.code != 0 {
        return Ok(unknown(gh_failure_reason(&out)));
    }
    match write_access_from_repo_json(&out.stdout_lossy()) {
        Ok((can_push, can_triage, role)) => Ok(crate::forge::ForgeRepoWriteAccess {
            can_push,
            can_triage,
            role,
            repo: Some(slug),
            unknown_reason: None,
        }),
        Err(reason) => Ok(unknown(reason)),
    }
}

/// The `parent` block `gh repo view --json parent` returns for a fork — the
/// upstream repo's owner login + name. Absent/null for a non-fork. Only the
/// slug parts are deserialized (defensive: any missing piece → no slug).
#[derive(Deserialize)]
struct GhParentRepo {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    owner: Option<GhParentOwner>,
}

#[derive(Deserialize)]
struct GhParentOwner {
    #[serde(default)]
    login: Option<String>,
}

/// The subset of `gh repo view --json …` the visibility probe reads: the raw
/// visibility string plus fork provenance, all from ONE `gh` call (no second
/// round-trip for fork-ness).
#[derive(Deserialize)]
struct GhRepoVisibilityJson {
    #[serde(default)]
    visibility: String,
    #[serde(default, rename = "isFork")]
    is_fork: bool,
    #[serde(default)]
    parent: Option<GhParentRepo>,
}

/// The repo's remote visibility as `gh` reports it — "PUBLIC"/"PRIVATE"/"INTERNAL"
/// (uppercase) — plus whether it's a fork and, when it is, the upstream `owner/repo`
/// slug. No GitHub remote (or no access) surfaces gh's own error rather than a
/// guessed value. Used by `forge_repo_visibility`'s GitHub arm.
pub async fn gh_repo_visibility(repo_path: String) -> AppResult<crate::forge::RepoVisibilityRaw> {
    // Pin the origin slug: unpinned, a fork with an `upstream` remote resolves to the
    // PARENT, which reports `isFork: false`. NOTE: the `repo` command family takes the
    // repository POSITIONALLY (`gh repo view <slug>`) — it has no `-R` flag (that's
    // run/pr/issue).
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &["repo", "view", &slug, "--json", "visibility,isFork,parent"],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let json = out.stdout_lossy();
    let parsed: GhRepoVisibilityJson = serde_json::from_str(json.trim()).map_err(|e| {
        AppError::Gh(format!("could not read the repository's visibility: {e}"))
    })?;
    if parsed.visibility.trim().is_empty() {
        return Err(AppError::Gh(
            "could not read the repository's visibility".into(),
        ));
    }
    // Only trust a parent slug when both halves are present; a fork with an
    // unreadable parent still reports `is_fork` truthfully with `parent: None`.
    let parent = parsed.parent.and_then(|p| match (p.owner.and_then(|o| o.login), p.name) {
        (Some(login), Some(name)) if !login.is_empty() && !name.is_empty() => {
            Some(format!("{login}/{name}"))
        }
        _ => None,
    });
    Ok(crate::forge::RepoVisibilityRaw {
        visibility: parsed.visibility,
        is_fork: parsed.is_fork,
        parent,
    })
}

// ── Webhooks ─────────────────────────────────────────────────────────────────
//
// Structs double as the GitHub-response deserialize target (snake_case via
// field `alias`) and the camelCase frontend payload (via `rename_all`).

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebhookConfig {
    #[serde(default)]
    pub url: String,
    #[serde(default, alias = "content_type")]
    pub content_type: String,
    /// "0" (verify SSL) or "1" (skip verification).
    #[serde(default, alias = "insecure_ssl")]
    pub insecure_ssl: String,
    /// GitHub returns "********" when a secret is set and omits it otherwise —
    /// so this only tells the UI whether a secret exists, never its value.
    #[serde(default)]
    pub secret: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WebhookLastResponse {
    pub code: Option<u32>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Webhook {
    pub id: u64,
    #[serde(default)]
    pub active: bool,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub config: WebhookConfig,
    #[serde(default, alias = "updated_at")]
    pub updated_at: String,
    #[serde(default, alias = "last_response")]
    pub last_response: WebhookLastResponse,
}

/// New/edited webhook values from the UI (camelCase from the frontend).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookInput {
    pub url: String,
    /// "json" or "form".
    pub content_type: String,
    /// A new secret; `None`/empty means leave the existing one unchanged.
    pub secret: Option<String>,
    pub insecure_ssl: bool,
    pub events: Vec<String>,
    pub active: bool,
}

fn validate_hook_input(input: &WebhookInput) -> AppResult<()> {
    let url = input.url.trim();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(AppError::InvalidArgument(
            "a webhook payload URL (http/https) is required".into(),
        ));
    }
    if input.content_type != "json" && input.content_type != "form" {
        return Err(AppError::InvalidArgument(format!(
            "invalid content type: {}",
            input.content_type
        )));
    }
    if input.events.is_empty() {
        return Err(AppError::InvalidArgument(
            "select at least one event".into(),
        ));
    }
    Ok(())
}

/// The `gh api --input -` JSON body. `include_name` is set on create (GitHub
/// requires `"name":"web"` then, and rejects it on update). A blank secret is
/// omitted so an edit never clears an existing one.
fn build_hook_body(input: &WebhookInput, include_name: bool) -> serde_json::Value {
    let mut config = json!({
        "url": input.url.trim(),
        "content_type": input.content_type,
        "insecure_ssl": if input.insecure_ssl { "1" } else { "0" },
    });
    if let Some(secret) = input.secret.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        config["secret"] = json!(secret);
    }
    let mut body = json!({
        "active": input.active,
        "events": input.events,
        "config": config,
    });
    if include_name {
        body["name"] = json!("web");
    }
    body
}

/// All webhooks on the repo (admin only — non-admins get gh's permission error).
#[tauri::command]
pub async fn gh_hooks_list(repo_path: String) -> AppResult<Vec<Webhook>> {
    // Pin the origin slug: `gh api`'s `{owner}/{repo}` placeholders auto-resolve
    // to the PARENT on a fork with an `upstream` remote, so build the literal
    // `repos/<slug>` path to keep webhook admin on the user's own fork.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &["api", "--paginate", &format!("repos/{slug}/hooks")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse webhooks: {e}")))
}

#[tauri::command]
pub async fn gh_hook_create(repo_path: String, input: WebhookInput) -> AppResult<Webhook> {
    validate_hook_input(&input)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let body = build_hook_body(&input, true);
    let out = run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "POST",
            &format!("repos/{slug}/hooks"),
            "--input",
            "-",
        ],
        &body.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the webhook: {e}")))
}

#[tauri::command]
pub async fn gh_hook_update(
    repo_path: String,
    id: u64,
    input: WebhookInput,
) -> AppResult<Webhook> {
    validate_hook_input(&input)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let body = build_hook_body(&input, false);
    let out = run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "PATCH",
            &format!("repos/{slug}/hooks/{id}"),
            "--input",
            "-",
        ],
        &body.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the webhook: {e}")))
}

#[tauri::command]
pub async fn gh_hook_delete(repo_path: String, id: u64) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "DELETE",
            &format!("repos/{slug}/hooks/{id}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Sends a `ping` event to the webhook (GitHub's "redeliver a ping").
#[tauri::command]
pub async fn gh_hook_ping(repo_path: String, id: u64) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "POST",
            &format!("repos/{slug}/hooks/{id}/pings"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Triggers a test `push` event (push-event hooks only; GitHub errors otherwise).
#[tauri::command]
pub async fn gh_hook_test(repo_path: String, id: u64) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "POST",
            &format!("repos/{slug}/hooks/{id}/tests"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── Webhook deliveries ───────────────────────────────────────────────────────

// Delivery ids are 19-digit snowflakes that exceed JS's safe integer range, so
// the frontend handles them as strings — serialize the u64 as a string here.
fn id_to_string<S>(id: &u64, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    serializer.serialize_str(&id.to_string())
}

fn validate_delivery_id(id: &str) -> AppResult<()> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::InvalidArgument(format!(
            "invalid delivery id: {id}"
        )));
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookDelivery {
    #[serde(serialize_with = "id_to_string")]
    pub id: u64,
    #[serde(default, alias = "delivered_at")]
    pub delivered_at: String,
    #[serde(default)]
    pub redelivery: bool,
    #[serde(default)]
    pub duration: f64,
    /// "OK", "Fail", "Pending", or the failure reason.
    #[serde(default)]
    pub status: String,
    #[serde(default, alias = "status_code")]
    pub status_code: u32,
    #[serde(default)]
    pub event: String,
    #[serde(default)]
    pub action: Option<String>,
}

/// A webhook's recent deliveries (GitHub returns the latest ~30, newest first).
#[tauri::command]
pub async fn gh_hook_deliveries(
    repo_path: String,
    hook_id: u64,
) -> AppResult<Vec<HookDelivery>> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &["api", &format!("repos/{slug}/hooks/{hook_id}/deliveries")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse deliveries: {e}")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookDeliveryDetail {
    /// The event payload GitHub sent, pretty-printed.
    pub request_payload: String,
    /// The receiver's response body (verbatim).
    pub response_payload: String,
}

/// One delivery's request payload + response body, for debugging a failure.
#[tauri::command]
pub async fn gh_hook_delivery(
    repo_path: String,
    hook_id: u64,
    delivery_id: String,
) -> AppResult<HookDeliveryDetail> {
    validate_delivery_id(&delivery_id)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &[
            "api",
            &format!("repos/{slug}/hooks/{hook_id}/deliveries/{delivery_id}"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let v: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse the delivery: {e}")))?;
    // request.payload is a JSON object; response.payload is a body string.
    let render = |val: Option<&serde_json::Value>| match val {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => serde_json::to_string_pretty(other).unwrap_or_default(),
        None => String::new(),
    };
    Ok(HookDeliveryDetail {
        request_payload: render(v.pointer("/request/payload")),
        response_payload: render(v.pointer("/response/payload")),
    })
}

/// Re-sends a past delivery (GitHub queues a fresh attempt).
#[tauri::command]
pub async fn gh_hook_redeliver(
    repo_path: String,
    hook_id: u64,
    delivery_id: String,
) -> AppResult<()> {
    validate_delivery_id(&delivery_id)?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "POST",
            &format!("repos/{slug}/hooks/{hook_id}/deliveries/{delivery_id}/attempts"),
        ],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

// ── General settings ─────────────────────────────────────────────────────────
//
// A curated subset of `GET`/`PATCH /repos/{owner}/{repo}` — the safe, common
// settings. Deliberately excludes destructive ones (visibility, archive,
// rename, transfer, delete).

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoSettings {
    /// null in the API when empty.
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    /// Repo topics — present on the repo object, but written via a separate
    /// `PUT /topics` endpoint (see `gh_repo_settings_update`).
    #[serde(default)]
    pub topics: Vec<String>,
    #[serde(default, alias = "default_branch")]
    pub default_branch: String,
    #[serde(default, alias = "has_issues")]
    pub has_issues: bool,
    #[serde(default, alias = "has_projects")]
    pub has_projects: bool,
    #[serde(default, alias = "has_wiki")]
    pub has_wiki: bool,
    #[serde(default, alias = "has_discussions")]
    pub has_discussions: bool,
    #[serde(default, alias = "allow_squash_merge")]
    pub allow_squash_merge: bool,
    #[serde(default, alias = "allow_merge_commit")]
    pub allow_merge_commit: bool,
    #[serde(default, alias = "allow_rebase_merge")]
    pub allow_rebase_merge: bool,
    #[serde(default, alias = "allow_update_branch")]
    pub allow_update_branch: bool,
    #[serde(default, alias = "delete_branch_on_merge")]
    pub delete_branch_on_merge: bool,
    #[serde(default, alias = "allow_auto_merge")]
    pub allow_auto_merge: bool,
    #[serde(default, alias = "web_commit_signoff_required")]
    pub web_commit_signoff_required: bool,
    /// Read-only — the repo's GitHub URL, for "manage on GitHub" deep links to
    /// the web-only settings (LFS-in-archives, push limits, …).
    #[serde(default, alias = "html_url")]
    pub html_url: String,
    /// Read-only — "public" | "private" | "internal" (for the danger zone).
    #[serde(default)]
    pub visibility: String,
    /// Read-only — "owner/repo", for the type-to-confirm destructive actions.
    #[serde(default, alias = "full_name")]
    pub full_name: String,
    /// Read-only — whether the repo is archived (for the danger zone).
    #[serde(default)]
    pub archived: bool,
    #[serde(default, alias = "is_template")]
    pub is_template: bool,
    #[serde(default, alias = "allow_forking")]
    pub allow_forking: bool,
    /// Computed, not from the API: GitHub only lets `allow_forking` change on an
    /// org-owned PRIVATE repo — sending it for any other repo 422s the whole
    /// PATCH. The UI hides the toggle (and we omit the field) when this is false.
    #[serde(default, skip_deserializing)]
    pub can_change_forking: bool,
    /// Computed, not from the API: whether the repo is org-owned (`owner.type ==
    /// "Organization"`). GitHub silently clamps triage/maintain/admin collaborator
    /// roles to `write` on a USER-owned repo (returns 204 but never applies them),
    /// so the Access UI offers only Read/Write there — the granular roles are
    /// org-repo-only.
    #[serde(default, skip_deserializing)]
    pub is_org: bool,
    /// Default squash-merge commit title/message. The two are a constrained
    /// enum pair (see `validate_merge_message_pairs`).
    #[serde(default, alias = "squash_merge_commit_title")]
    pub squash_merge_commit_title: String,
    #[serde(default, alias = "squash_merge_commit_message")]
    pub squash_merge_commit_message: String,
    #[serde(default, alias = "merge_commit_title")]
    pub merge_commit_title: String,
    #[serde(default, alias = "merge_commit_message")]
    pub merge_commit_message: String,
}

/// Edited settings from the UI (camelCase from the frontend).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSettingsInput {
    pub description: String,
    pub homepage: String,
    pub topics: Vec<String>,
    pub default_branch: String,
    pub has_issues: bool,
    pub has_projects: bool,
    pub has_wiki: bool,
    pub has_discussions: bool,
    pub allow_squash_merge: bool,
    pub allow_merge_commit: bool,
    pub allow_rebase_merge: bool,
    pub allow_update_branch: bool,
    pub delete_branch_on_merge: bool,
    pub allow_auto_merge: bool,
    pub web_commit_signoff_required: bool,
    pub is_template: bool,
    /// `None` when the repo can't change forking (org-owned private only) — the
    /// field is then omitted from the PATCH so it doesn't 422 the whole save.
    pub allow_forking: Option<bool>,
    pub squash_merge_commit_title: String,
    pub squash_merge_commit_message: String,
    pub merge_commit_title: String,
    pub merge_commit_message: String,
}

/// GitHub 422s an invalid squash/merge title+message combination, which would
/// fail the whole settings PATCH. The UI only produces valid pairs; this guards
/// the boundary anyway.
fn validate_merge_message_pairs(input: &RepoSettingsInput) -> AppResult<()> {
    const SQUASH: &[(&str, &str)] = &[
        ("PR_TITLE", "PR_BODY"),
        ("PR_TITLE", "BLANK"),
        ("COMMIT_OR_PR_TITLE", "COMMIT_MESSAGES"),
    ];
    const MERGE: &[(&str, &str)] = &[
        ("PR_TITLE", "PR_BODY"),
        ("PR_TITLE", "BLANK"),
        ("MERGE_MESSAGE", "PR_TITLE"),
    ];
    let squash = (
        input.squash_merge_commit_title.as_str(),
        input.squash_merge_commit_message.as_str(),
    );
    if !SQUASH.contains(&squash) {
        return Err(AppError::InvalidArgument(format!(
            "invalid squash merge message: {}/{}",
            squash.0, squash.1
        )));
    }
    let merge = (
        input.merge_commit_title.as_str(),
        input.merge_commit_message.as_str(),
    );
    if !MERGE.contains(&merge) {
        return Err(AppError::InvalidArgument(format!(
            "invalid merge commit message: {}/{}",
            merge.0, merge.1
        )));
    }
    Ok(())
}

/// Whether the repo is org-owned (`owner.type == "Organization"`), from the raw
/// repo JSON — a User owner means the granular collaborator roles don't apply.
fn is_org(repo_json: &str) -> bool {
    let v: serde_json::Value = serde_json::from_str(repo_json).unwrap_or_default();
    v.pointer("/owner/type").and_then(|t| t.as_str()) == Some("Organization")
}

/// `allow_forking` is only mutable on an org-owned PRIVATE repo. Read that from
/// the raw repo JSON (`private` + `owner.type`).
fn can_change_forking(repo_json: &str) -> bool {
    let v: serde_json::Value = serde_json::from_str(repo_json).unwrap_or_default();
    let is_private = v.get("private").and_then(|p| p.as_bool()).unwrap_or(false);
    is_private && is_org(repo_json)
}

#[tauri::command]
pub async fn gh_repo_settings_get(repo_path: String) -> AppResult<RepoSettings> {
    // Pin the origin slug so a fork reads its OWN settings, not the parent's
    // (see `gh_hooks_list`).
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh(
        Some(&repo_path),
        &["api", &format!("repos/{slug}")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    let text = out.stdout_lossy();
    let mut settings: RepoSettings = serde_json::from_str(&text)
        .map_err(|e| AppError::Gh(format!("could not parse repo settings: {e}")))?;
    settings.can_change_forking = can_change_forking(&text);
    settings.is_org = is_org(&text);
    Ok(settings)
}

#[tauri::command]
pub async fn gh_repo_settings_update(
    repo_path: String,
    input: RepoSettingsInput,
) -> AppResult<RepoSettings> {
    // GitHub rejects a repo with no merge method enabled.
    if !(input.allow_squash_merge || input.allow_merge_commit || input.allow_rebase_merge) {
        return Err(AppError::InvalidArgument(
            "enable at least one merge method".into(),
        ));
    }
    validate_merge_message_pairs(&input)?;
    // Pin the origin slug once for both the settings PATCH and the topics PUT so
    // a fork edits its OWN config, not the parent's (see `gh_hooks_list`).
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let mut body = json!({
        "description": input.description.trim(),
        "homepage": input.homepage.trim(),
        "default_branch": input.default_branch,
        "has_issues": input.has_issues,
        "has_projects": input.has_projects,
        "has_wiki": input.has_wiki,
        "has_discussions": input.has_discussions,
        "allow_squash_merge": input.allow_squash_merge,
        "allow_merge_commit": input.allow_merge_commit,
        "allow_rebase_merge": input.allow_rebase_merge,
        "allow_update_branch": input.allow_update_branch,
        "delete_branch_on_merge": input.delete_branch_on_merge,
        "allow_auto_merge": input.allow_auto_merge,
        "web_commit_signoff_required": input.web_commit_signoff_required,
        "is_template": input.is_template,
        "squash_merge_commit_title": input.squash_merge_commit_title,
        "squash_merge_commit_message": input.squash_merge_commit_message,
        "merge_commit_title": input.merge_commit_title,
        "merge_commit_message": input.merge_commit_message,
    });
    // Only mutable on an org-owned private repo; sending it elsewhere 422s the PATCH.
    if let Some(allow_forking) = input.allow_forking {
        body["allow_forking"] = json!(allow_forking);
    }
    let out = run_gh_input(
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
    let text = out.stdout_lossy();
    let mut settings: RepoSettings = serde_json::from_str(&text)
        .map_err(|e| AppError::Gh(format!("could not parse repo settings: {e}")))?;
    settings.can_change_forking = can_change_forking(&text);
    // `is_org` is `skip_deserializing`, so recompute it from the PATCH response too —
    // otherwise the onSuccess cache seed reports false. Mirrors the GET path.
    settings.is_org = is_org(&text);

    // Topics aren't part of the repo PATCH — they have their own endpoint.
    // Lowercase + strip to GitHub's allowed alphabet so a stray character
    // doesn't 422 the whole save.
    let names: Vec<String> = input
        .topics
        .iter()
        .map(|t| {
            t.trim()
                .to_lowercase()
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
                .collect::<String>()
        })
        .filter(|t| !t.is_empty())
        .collect();
    let topics_out = run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "PUT",
            &format!("repos/{slug}/topics"),
            "--input",
            "-",
        ],
        &json!({ "names": names }).to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    #[derive(Deserialize)]
    struct TopicsResp {
        #[serde(default)]
        names: Vec<String>,
    }
    if let Ok(t) = serde_json::from_str::<TopicsResp>(&topics_out.stdout_lossy()) {
        settings.topics = t.names;
    }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::{gh_failure_reason, write_access_from_repo_json, GhOutput};

    #[test]
    fn gh_failure_reason_names_the_failure_even_when_gh_is_silent() {
        let noisy = GhOutput {
            stdout: Vec::new(),
            stderr: "\n  \ngh: Not Found (HTTP 404)\nsecond line\n".into(),
            code: 1,
        };
        assert_eq!(gh_failure_reason(&noisy), "gh: Not Found (HTTP 404)");
        // Empty stderr still names the failure rather than reading as silence.
        let silent = GhOutput {
            stdout: Vec::new(),
            stderr: String::new(),
            code: 4,
        };
        assert_eq!(gh_failure_reason(&silent), "gh exited with status 4");
    }

    #[test]
    fn write_access_reads_the_permissions_block() {
        // GitHub sets every tier at or below the viewer's, so the role is the
        // highest set flag.
        assert_eq!(
            write_access_from_repo_json(
                r#"{"permissions":{"admin":false,"maintain":true,"push":true,"triage":true,"pull":true}}"#
            ),
            Ok((Some(true), Some(true), Some("maintain".into()))),
        );
        assert_eq!(
            write_access_from_repo_json(
                r#"{"permissions":{"admin":true,"maintain":true,"push":true,"triage":true,"pull":true}}"#
            ),
            Ok((Some(true), Some(true), Some("admin".into()))),
        );
        // A read-only viewer: an AFFIRMATIVE denial, distinct from unknown.
        assert_eq!(
            write_access_from_repo_json(
                r#"{"permissions":{"admin":false,"maintain":false,"push":false,"triage":false,"pull":true}}"#
            ),
            Ok((Some(false), Some(false), Some("read".into()))),
        );
        // A triager can't push but DOES manage metadata — the axis that keeps
        // labels/assignees enabled for a real collaborator.
        assert_eq!(
            write_access_from_repo_json(
                r#"{"permissions":{"admin":false,"maintain":false,"push":false,"triage":true,"pull":true}}"#
            ),
            Ok((Some(false), Some(true), Some("triage".into()))),
        );
        // Tiers the response omits don't invent a role, and no flag set at all
        // leaves the role unlabeled while `push` still answers. A response with
        // no `triage` key borrows the push bit.
        assert_eq!(
            write_access_from_repo_json(r#"{"permissions":{"push":true,"pull":true}}"#),
            Ok((Some(true), Some(true), Some("write".into()))),
        );
        assert_eq!(
            write_access_from_repo_json(
                r#"{"permissions":{"admin":false,"push":false,"pull":false}}"#
            ),
            Ok((Some(false), Some(false), None)),
        );
    }

    #[test]
    fn write_access_reports_unknown_rather_than_denying() {
        // No `permissions` block (unauthenticated read) — the probe can't answer.
        let no_block = write_access_from_repo_json(r#"{"full_name":"o/r"}"#).unwrap_err();
        assert!(no_block.contains("permissions"), "{no_block}");
        // `permissions` present but without `push` or `triage`: the role can still
        // be read, yet both axes stay unknown rather than defaulting to false.
        assert_eq!(
            write_access_from_repo_json(r#"{"permissions":{"pull":true}}"#),
            Ok((None, None, Some("read".into()))),
        );
        // A null block and unparseable output are both unknown, never `false`.
        assert!(write_access_from_repo_json(r#"{"permissions":null}"#).is_err());
        assert!(write_access_from_repo_json("gh: not found (HTTP 404)").is_err());
    }
}
