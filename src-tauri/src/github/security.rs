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
use crate::forge::session::{classify_gh_failure, GhFailure};
use crate::github::repo_meta::invalidate_repo_meta_after;
use crate::github::runner::{run_gh, run_gh_input, run_gh_raw, GH_NETWORK_TIMEOUT};
use crate::github::{gh_failure_reason, gh_unreadable};

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
async fn probe_ok(repo_path: &str, slug: &str, path: &str) -> AppResult<bool> {
    probe_ok_outcome(
        run_gh_raw(
            Some(repo_path),
            &["api", &format!("repos/{slug}/{path}")],
            GH_NETWORK_TIMEOUT,
        )
        .await,
    )
}

fn probe_ok_outcome(result: AppResult<crate::github::runner::GhOutput>) -> AppResult<bool> {
    let out = result?;
    if out.code != 0 {
        return match classify_gh_failure(&out.stderr) {
            GhFailure::RateLimited | GhFailure::Transport => {
                Err(AppError::Gh(gh_failure_reason(&out)))
            }
            GhFailure::NotFound | GhFailure::Answered => Ok(false),
        };
    }
    Ok(true)
}

/// Reads a JSON-bodied endpoint and pulls out a boolean field.
async fn get_bool_field(repo_path: &str, slug: &str, path: &str, field: &str) -> AppResult<bool> {
    get_bool_field_outcome(
        run_gh_raw(
            Some(repo_path),
            &["api", &format!("repos/{slug}/{path}")],
            GH_NETWORK_TIMEOUT,
        )
        .await,
        field,
    )
}

fn get_bool_field_outcome(
    result: AppResult<crate::github::runner::GhOutput>,
    field: &str,
) -> AppResult<bool> {
    let out = result?;
    if out.code != 0 {
        return match classify_gh_failure(&out.stderr) {
            GhFailure::RateLimited | GhFailure::Transport => {
                Err(AppError::Gh(gh_failure_reason(&out)))
            }
            GhFailure::NotFound | GhFailure::Answered => Ok(false),
        };
    }
    let value: Value = serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
        gh_unreadable(
            "the security settings",
            format!("could not parse {field}: {e}"),
        )
    })?;
    Ok(value.get(field).and_then(Value::as_bool).unwrap_or(false))
}

async fn get_code_scanning(repo_path: &str, slug: &str) -> AppResult<bool> {
    get_code_scanning_outcome(
        run_gh_raw(
            Some(repo_path),
            &["api", &format!("repos/{slug}/code-scanning/default-setup")],
            GH_NETWORK_TIMEOUT,
        )
        .await,
    )
}

fn get_code_scanning_outcome(
    result: AppResult<crate::github::runner::GhOutput>,
) -> AppResult<bool> {
    let out = result?;
    if out.code != 0 {
        return match classify_gh_failure(&out.stderr) {
            GhFailure::RateLimited | GhFailure::Transport => {
                Err(AppError::Gh(gh_failure_reason(&out)))
            }
            GhFailure::NotFound | GhFailure::Answered => Ok(false),
        };
    }
    let value: Value = serde_json::from_str(&out.stdout_lossy()).map_err(|e| {
        gh_unreadable(
            "the code scanning settings",
            format!("could not parse code scanning: {e}"),
        )
    })?;
    Ok(value.get("state").and_then(Value::as_str) == Some("configured"))
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
        secret_scanning_non_provider_patterns: status_on("secret_scanning_non_provider_patterns"),
        dependabot_alerts: alerts?,
        dependabot_security_updates: fixes?,
        private_vulnerability_reporting: pvr?,
        code_scanning: code_scanning?,
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
            let result = run_gh_input(
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
            .await;
            invalidate_repo_meta_after(slug, &result);
            result?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::github::test_support::{
        gh_output, ANSWERED_STDERR, HELD_REST_STDERR, NOT_FOUND_STDERR,
    };
    #[test]
    fn security_bool_rejects_unreadable_bodies_and_keeps_missing_fields_false() {
        for body in ["{}", r#"{"state":"not-configured"}"#] {
            assert!(!get_bool_field_outcome(gh_output(0, body, ""), "enabled").unwrap());
        }
        for body in ["garbage", ""] {
            let error = get_bool_field_outcome(gh_output(0, body, ""), "enabled")
                .expect_err("unreadable security settings must reject");
            assert!(
                matches!(error, AppError::Gh(message) if message.starts_with("Couldn't read the security settings from GitHub.\n"))
            );
        }
    }

    #[test]
    fn code_scanning_rejects_unreadable_bodies_and_keeps_missing_fields_false() {
        for body in ["{}", r#"{"state":"not-configured"}"#] {
            assert!(!get_code_scanning_outcome(gh_output(0, body, "")).unwrap());
        }
        for body in ["garbage", ""] {
            let error = get_code_scanning_outcome(gh_output(0, body, ""))
                .expect_err("unreadable security settings must reject");
            assert!(
                matches!(error, AppError::Gh(message) if message.starts_with("Couldn't read the code scanning settings from GitHub.\n"))
            );
        }
    }

    #[test]
    fn security_probe_preserves_denials_and_rejects_transient_failures() {
        let absent = probe_ok_outcome(gh_output(1, "", NOT_FOUND_STDERR)).unwrap();
        assert!(!absent);
        let absent = probe_ok_outcome(gh_output(1, "", ANSWERED_STDERR)).unwrap();
        assert!(!absent);
        let loaded = probe_ok_outcome(gh_output(0, "", "")).unwrap();
        assert!(loaded);
        for stderr in [
            HELD_REST_STDERR,
            "connection failed",
            "gh: API rate limit exceeded for user ID 12345 (HTTP 403)",
        ] {
            let error =
                probe_ok_outcome(gh_output(1, "", stderr)).expect_err("failed read must reject");
            assert!(
                matches!(&error, crate::error::AppError::Gh(message) if message == &crate::github::gh_failure_reason(&gh_output(1, "", stderr).unwrap())),
                "{error}"
            );
            if stderr == HELD_REST_STDERR {
                assert!(error.to_string().contains("rate limit"));
            }
        }
        assert!(probe_ok_outcome(Err(crate::error::AppError::Timeout(30))).is_err());
    }

    #[test]
    fn security_bool_preserves_denials_and_rejects_transient_failures() {
        let absent = get_bool_field_outcome(gh_output(1, "", NOT_FOUND_STDERR), "enabled").unwrap();
        assert!(!absent);
        let absent = get_bool_field_outcome(gh_output(1, "", ANSWERED_STDERR), "enabled").unwrap();
        assert!(!absent);
        let loaded =
            get_bool_field_outcome(gh_output(0, r#"{"enabled":true}"#, ""), "enabled").unwrap();
        assert!(loaded);
        for stderr in [
            HELD_REST_STDERR,
            "connection failed",
            "gh: API rate limit exceeded for user ID 12345 (HTTP 403)",
        ] {
            let error = get_bool_field_outcome(gh_output(1, "", stderr), "enabled")
                .expect_err("failed read must reject");
            assert!(
                matches!(&error, crate::error::AppError::Gh(message) if message == &crate::github::gh_failure_reason(&gh_output(1, "", stderr).unwrap())),
                "{error}"
            );
            if stderr == HELD_REST_STDERR {
                assert!(error.to_string().contains("rate limit"));
            }
        }
        assert!(
            get_bool_field_outcome(Err(crate::error::AppError::Timeout(30)), "enabled").is_err()
        );
    }

    #[test]
    fn code_scanning_preserves_denials_and_rejects_transient_failures() {
        let absent = get_code_scanning_outcome(gh_output(1, "", NOT_FOUND_STDERR)).unwrap();
        assert!(!absent);
        let absent = get_code_scanning_outcome(gh_output(1, "", ANSWERED_STDERR)).unwrap();
        assert!(!absent);
        let loaded =
            get_code_scanning_outcome(gh_output(0, r#"{"state":"configured"}"#, "")).unwrap();
        assert!(loaded);
        for stderr in [
            HELD_REST_STDERR,
            "connection failed",
            "gh: API rate limit exceeded for user ID 12345 (HTTP 403)",
        ] {
            let error = get_code_scanning_outcome(gh_output(1, "", stderr))
                .expect_err("failed read must reject");
            assert!(
                matches!(&error, crate::error::AppError::Gh(message) if message == &crate::github::gh_failure_reason(&gh_output(1, "", stderr).unwrap())),
                "{error}"
            );
            if stderr == HELD_REST_STDERR {
                assert!(error.to_string().contains("rate limit"));
            }
        }
        assert!(get_code_scanning_outcome(Err(crate::error::AppError::Timeout(30))).is_err());
    }
}
