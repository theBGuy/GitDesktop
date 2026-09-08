//! The repo's "Code security and analysis" toggles. These live across three
//! mechanisms: the `security_and_analysis` object on `PATCH /repos` (GHAS,
//! secret scanning, push protection), dedicated PUT/DELETE endpoints (Dependabot
//! alerts + security updates, private vulnerability reporting), and the
//! code-scanning default-setup endpoint. Reads tolerate 403/404 (no GHAS /
//! feature off) as "false" rather than erroring the panel.
//!
//! GHAS/plan gating: secret + code scanning on PRIVATE repos need a GitHub
//! Advanced Security / security license (free on public). The UI surfaces a note
//! and lets gh's own 422/403 explain when a toggle can't be flipped.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::runner::{run_gh, run_gh_input, run_gh_raw, GH_NETWORK_TIMEOUT};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecurityStatus {
    pub is_private: bool,
    /// `None` when the field isn't present (e.g. public repos have no GHAS toggle).
    pub advanced_security: Option<bool>,
    pub secret_scanning: Option<bool>,
    pub secret_scanning_push_protection: Option<bool>,
    pub secret_scanning_ai_detection: Option<bool>,
    pub secret_scanning_non_provider_patterns: Option<bool>,
    pub dependabot_alerts: bool,
    pub dependabot_security_updates: bool,
    pub private_vulnerability_reporting: bool,
    pub code_scanning: bool,
}

// All helpers take the pre-resolved origin `slug` (owner/repo) and build a
// literal `repos/<slug>/…` path. `gh api`'s `{owner}/{repo}` placeholders would
// auto-resolve to the PARENT on a fork with an `upstream` remote, so the callers
// resolve the slug once via `gh_origin_slug` and thread it through here.

/// Status-code probe for the 204/404 endpoints (e.g. vulnerability-alerts).
async fn probe_ok(repo_path: &str, slug: &str, path: &str) -> bool {
    run_gh_raw(
        Some(repo_path),
        &["api", &format!("repos/{slug}/{path}")],
        GH_NETWORK_TIMEOUT,
    )
    .await
    .map(|o| o.code == 0)
    .unwrap_or(false)
}

/// Reads a JSON-bodied endpoint and pulls out a boolean field (false on any error).
async fn get_bool_field(repo_path: &str, slug: &str, path: &str, field: &str) -> bool {
    let Ok(out) = run_gh_raw(
        Some(repo_path),
        &["api", &format!("repos/{slug}/{path}")],
        GH_NETWORK_TIMEOUT,
    )
    .await
    else {
        return false;
    };
    if out.code != 0 {
        return false;
    }
    serde_json::from_str::<Value>(&out.stdout_lossy())
        .ok()
        .and_then(|v| v.get(field).and_then(Value::as_bool))
        .unwrap_or(false)
}

async fn get_code_scanning(repo_path: &str, slug: &str) -> bool {
    let Ok(out) = run_gh_raw(
        Some(repo_path),
        &["api", &format!("repos/{slug}/code-scanning/default-setup")],
        GH_NETWORK_TIMEOUT,
    )
    .await
    else {
        return false;
    };
    if out.code != 0 {
        return false;
    }
    serde_json::from_str::<Value>(&out.stdout_lossy())
        .ok()
        .and_then(|v| v.get("state").and_then(Value::as_str).map(|s| s == "configured"))
        .unwrap_or(false)
}

#[tauri::command]
pub async fn gh_security_get(repo_path: String) -> AppResult<SecurityStatus> {
    // Pin the origin slug once and thread it through every probe so a fork reads
    // its OWN security settings, not the parent's.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let repo_slug_path = format!("repos/{slug}");
    let repo_args = ["api", repo_slug_path.as_str()];
    // The repo object (security_and_analysis + private) plus the four dedicated
    // endpoints, fetched concurrently.
    let (repo, alerts, fixes, pvr, code_scanning) = tokio::join!(
        run_gh(Some(&repo_path), &repo_args, GH_NETWORK_TIMEOUT),
        probe_ok(&repo_path, &slug, "vulnerability-alerts"),
        get_bool_field(&repo_path, &slug, "automated-security-fixes", "enabled"),
        get_bool_field(
            &repo_path,
            &slug,
            "private-vulnerability-reporting",
            "enabled"
        ),
        get_code_scanning(&repo_path, &slug),
    );

    let v: Value = serde_json::from_str(&repo?.stdout_lossy())
        .map_err(|e| gh_unreadable("the repository", format!("could not parse repo: {e}")))?;
    let is_private = v.get("private").and_then(Value::as_bool).unwrap_or(false);
    let sa = v.get("security_and_analysis");
    let status_on = |key: &str| -> Option<bool> {
        sa.and_then(|s| s.get(key))
            .and_then(|f| f.get("status"))
            .and_then(Value::as_str)
            .map(|s| s == "enabled")
    };

    Ok(SecurityStatus {
        is_private,
        advanced_security: status_on("advanced_security"),
        secret_scanning: status_on("secret_scanning"),
        secret_scanning_push_protection: status_on("secret_scanning_push_protection"),
        secret_scanning_ai_detection: status_on("secret_scanning_ai_detection"),
        secret_scanning_non_provider_patterns: status_on(
            "secret_scanning_non_provider_patterns",
        ),
        dependabot_alerts: alerts,
        dependabot_security_updates: fixes,
        private_vulnerability_reporting: pvr,
        code_scanning,
    })
}

/// PUT (enable) / DELETE (disable) a dedicated security endpoint.
async fn toggle_endpoint(repo_path: &str, slug: &str, path: &str, enabled: bool) -> AppResult<()> {
    let method = if enabled { "PUT" } else { "DELETE" };
    run_gh(
        Some(repo_path),
        &["api", "--method", method, &format!("repos/{slug}/{path}")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// One toggle in a batched save.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityChange {
    pub feature: String,
    pub enabled: bool,
}

/// Applies a batch of toggles. The frontend sends them in a dependency-safe
/// order (parents before children) so e.g. secret scanning is enabled before
/// push protection. Stops at the first failure (earlier changes stay applied).
#[tauri::command]
pub async fn gh_security_apply(
    repo_path: String,
    changes: Vec<SecurityChange>,
) -> AppResult<()> {
    // Pin the origin slug once and thread it through every toggle so a fork
    // edits its OWN security settings, not the parent's.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    for change in &changes {
        apply_feature(&repo_path, &slug, &change.feature, change.enabled).await?;
    }
    Ok(())
}

async fn apply_feature(repo_path: &str, slug: &str, feature: &str, enabled: bool) -> AppResult<()> {
    match feature {
        "advanced_security"
        | "secret_scanning"
        | "secret_scanning_push_protection"
        | "secret_scanning_ai_detection"
        | "secret_scanning_non_provider_patterns" => {
            let status = if enabled { "enabled" } else { "disabled" };
            let mut obj = serde_json::Map::new();
            obj.insert(feature.to_string(), json!({ "status": status }));
            let body = json!({ "security_and_analysis": Value::Object(obj) });
            run_gh_input(
                Some(repo_path),
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
        }
        "dependabot_alerts" => {
            toggle_endpoint(repo_path, slug, "vulnerability-alerts", enabled).await?;
        }
        "dependabot_security_updates" => {
            toggle_endpoint(repo_path, slug, "automated-security-fixes", enabled).await?;
        }
        "private_vulnerability_reporting" => {
            toggle_endpoint(repo_path, slug, "private-vulnerability-reporting", enabled).await?;
        }
        "code_scanning" => {
            // Default setup; the PATCH is async (GitHub kicks off a CodeQL run).
            let state = if enabled { "configured" } else { "not-configured" };
            let body = json!({ "state": state });
            run_gh_input(
                Some(repo_path),
                &[
                    "api",
                    "--method",
                    "PATCH",
                    &format!("repos/{slug}/code-scanning/default-setup"),
                    "--input",
                    "-",
                ],
                &body.to_string(),
                GH_NETWORK_TIMEOUT,
            )
            .await?;
        }
        _ => {
            return Err(AppError::InvalidArgument(format!(
                "unknown security feature: {feature}"
            )));
        }
    }
    Ok(())
}
