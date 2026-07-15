//! GitHub Pages config — enable/disable, source (a branch+dir or GitHub
//! Actions), custom domain, and enforce-HTTPS. All via the `/pages` REST family.
//! A repo with Pages off returns 404 on GET, which we read as `None`.

use serde::Serialize;
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::github::runner::{run_gh, run_gh_input, run_gh_raw, GH_NETWORK_TIMEOUT};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PagesInfo {
    pub html_url: String,
    /// "built" | "building" | "errored" | "".
    pub status: String,
    /// "legacy" (deploy from a branch) | "workflow" (GitHub Actions).
    pub build_type: String,
    pub source_branch: String,
    pub source_path: String,
    pub cname: String,
    pub https_enforced: bool,
    /// TLS certificate provisioning state for a custom domain, e.g. "new",
    /// "authorization_created", "authorization_pending", "authorized",
    /// "uploaded", "approved", "errored", "bad_authz". `None` when the repo has
    /// no custom domain (the `https_certificate` object is absent entirely).
    pub https_certificate_state: Option<String>,
}

#[tauri::command]
pub async fn gh_pages_get(repo_path: String) -> AppResult<Option<PagesInfo>> {
    // Pin the origin slug: `gh api`'s `{owner}/{repo}` placeholders auto-resolve
    // to the PARENT on a fork with an `upstream` remote, so build the literal
    // `repos/<slug>` path to keep every Pages call on the user's own fork.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh_raw(
        Some(&repo_path),
        &["api", &format!("repos/{slug}/pages")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    if out.code != 0 {
        return Ok(None); // 404 = Pages not enabled
    }
    let v: Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| AppError::Gh(format!("could not parse pages: {e}")))?;
    let str_at = |ptr: &str| {
        v.pointer(ptr)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    Ok(Some(PagesInfo {
        html_url: str_at("/html_url"),
        status: str_at("/status"),
        build_type: str_at("/build_type"),
        source_branch: str_at("/source/branch"),
        source_path: str_at("/source/path"),
        cname: str_at("/cname"),
        https_enforced: v
            .get("https_enforced")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        https_certificate_state: v
            .pointer("/https_certificate/state")
            .and_then(Value::as_str)
            .map(str::to_string),
    }))
}

/// Enables Pages. `build_type` "workflow" publishes via GitHub Actions; anything
/// else publishes from the given branch + directory.
#[tauri::command]
pub async fn gh_pages_enable(
    repo_path: String,
    build_type: String,
    branch: Option<String>,
    path: Option<String>,
) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let body = if build_type == "workflow" {
        json!({ "build_type": "workflow" })
    } else {
        json!({
            "source": {
                "branch": branch.unwrap_or_default(),
                "path": path.unwrap_or_else(|| "/".into()),
            }
        })
    };
    run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "POST",
            &format!("repos/{slug}/pages"),
            "--input",
            "-",
        ],
        &body.to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// Updates an existing Pages site (partial). An empty `cname` removes the domain.
#[tauri::command]
pub async fn gh_pages_update(
    repo_path: String,
    build_type: Option<String>,
    branch: Option<String>,
    path: Option<String>,
    cname: Option<String>,
    https_enforced: Option<bool>,
) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let mut body = serde_json::Map::new();
    if let Some(bt) = build_type {
        body.insert("build_type".into(), json!(bt));
    }
    if let Some(b) = branch {
        body.insert(
            "source".into(),
            json!({ "branch": b, "path": path.unwrap_or_else(|| "/".into()) }),
        );
    }
    if let Some(c) = cname {
        let c = c.trim();
        body.insert(
            "cname".into(),
            if c.is_empty() { Value::Null } else { json!(c) },
        );
    }
    if let Some(h) = https_enforced {
        body.insert("https_enforced".into(), json!(h));
    }
    run_gh_input(
        Some(&repo_path),
        &[
            "api",
            "--method",
            "PUT",
            &format!("repos/{slug}/pages"),
            "--input",
            "-",
        ],
        &Value::Object(body).to_string(),
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_pages_disable(repo_path: String) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    run_gh(
        Some(&repo_path),
        &["api", "--method", "DELETE", &format!("repos/{slug}/pages")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    Ok(())
}
