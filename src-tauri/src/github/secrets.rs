//! Actions / Dependabot / Codespaces **secrets** and Actions **variables** for a
//! repo, plus Actions **environment** scope. Writes go through `gh secret set` /
//! `gh variable set`, which encrypt secret values locally (libsodium sealed box)
//! before sending — so we never handle the public-key + sealed-box flow
//! ourselves. Reads use `gh api`. Org scope is deferred to the org surface.
//!
//! Secret VALUES are never readable back (GitHub returns metadata only), so the
//! UI only ever sets (overwrites) or deletes them. Variable values ARE readable.

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::github::gh_unreadable;
use crate::github::runner::{run_gh, run_gh_input, run_gh_raw, GH_NETWORK_TIMEOUT};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhSecret {
    pub name: String,
    #[serde(default, alias = "updated_at")]
    pub updated_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhVariable {
    pub name: String,
    #[serde(default)]
    pub value: String,
    #[serde(default, alias = "updated_at")]
    pub updated_at: String,
}

#[derive(Deserialize)]
struct SecretsResp {
    #[serde(default)]
    secrets: Vec<GhSecret>,
}
#[derive(Deserialize)]
struct VariablesResp {
    #[serde(default)]
    variables: Vec<GhVariable>,
}
#[derive(Deserialize)]
struct EnvsResp {
    #[serde(default)]
    environments: Vec<EnvEntry>,
}
#[derive(Deserialize)]
struct EnvEntry {
    name: String,
}

/// The REST path segment + `--app` value for a secret app id.
fn app_segment(app: &str) -> AppResult<&'static str> {
    match app {
        "actions" => Ok("actions"),
        "dependabot" => Ok("dependabot"),
        "codespaces" => Ok("codespaces"),
        _ => Err(AppError::InvalidArgument(format!(
            "unknown secret app: {app}"
        ))),
    }
}

/// Only Actions has environment-scoped secrets/variables.
fn check_env_app(app: &str, env: Option<&str>) -> AppResult<()> {
    if env.is_some() && app != "actions" {
        return Err(AppError::InvalidArgument(
            "environment secrets are available only for Actions".into(),
        ));
    }
    Ok(())
}

/// A loose guard against path-breaking environment names (the value comes from
/// our own environments list, so this is belt-and-suspenders).
fn validate_env(env: &str) -> AppResult<()> {
    if env.is_empty() || env.contains(['/', '?', '#', '\n']) {
        return Err(AppError::InvalidArgument(format!(
            "invalid environment: {env}"
        )));
    }
    Ok(())
}

/// Secret/variable names: letters, digits, underscore; not starting with a
/// digit; not starting with `GITHUB_` (case-insensitive). GitHub 422s otherwise.
fn validate_var_name(name: &str) -> AppResult<()> {
    let first_ok = name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
    let body_ok = name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_');
    let github_prefixed = name.len() >= 7 && name[..7].eq_ignore_ascii_case("GITHUB_");
    if !first_ok || !body_ok || github_prefixed {
        return Err(AppError::InvalidArgument(
            "names use letters, numbers and _, can't start with a number, and can't start with GITHUB_".into(),
        ));
    }
    Ok(())
}

fn secrets_path(slug: &str, seg: &str, env: Option<&str>) -> AppResult<String> {
    match env {
        Some(env) => {
            validate_env(env)?;
            Ok(format!(
                "repos/{slug}/environments/{env}/secrets?per_page=100"
            ))
        }
        None => Ok(format!("repos/{slug}/{seg}/secrets?per_page=100")),
    }
}

#[tauri::command]
pub async fn gh_secrets_list(
    repo_path: String,
    app: String,
    env: Option<String>,
) -> AppResult<Vec<GhSecret>> {
    let seg = app_segment(&app)?;
    check_env_app(&app, env.as_deref())?;
    // Pin the origin slug: `gh api`'s `{owner}/{repo}` placeholders auto-resolve
    // to the PARENT on a fork with an `upstream` remote, so build a literal
    // `repos/<slug>/…` path to list the fork's OWN secrets.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let path = secrets_path(&slug, seg, env.as_deref())?;
    let out = run_gh(Some(&repo_path), &["api", &path], GH_NETWORK_TIMEOUT).await?;
    let resp: SecretsResp = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| gh_unreadable("the secrets", format!("could not parse secrets: {e}")))?;
    Ok(resp.secrets)
}

#[tauri::command]
pub async fn gh_secret_set(
    repo_path: String,
    app: String,
    env: Option<String>,
    name: String,
    value: String,
) -> AppResult<()> {
    app_segment(&app)?;
    check_env_app(&app, env.as_deref())?;
    let name = name.trim();
    validate_var_name(name)?;
    if value.is_empty() {
        return Err(AppError::InvalidArgument("a secret value is required".into()));
    }
    // Pin the origin slug: an unpinned `gh secret set` on a fork with an
    // `upstream` remote would target the PARENT. The `secret` command family
    // accepts `-R/--repo OWNER/REPO` (verified with --help — use the long
    // `--repo`, since `-r/--repos` is a different org-scope flag).
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    // `gh secret set` reads the value from stdin and encrypts it locally.
    let mut args: Vec<&str> = vec![
        "secret",
        "set",
        name,
        "--repo",
        &slug,
        "--app",
        app.as_str(),
    ];
    if let Some(env) = env.as_deref() {
        validate_env(env)?;
        args.push("--env");
        args.push(env);
    }
    run_gh_input(Some(&repo_path), &args, &value, GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_secret_delete(
    repo_path: String,
    app: String,
    env: Option<String>,
    name: String,
) -> AppResult<()> {
    app_segment(&app)?;
    check_env_app(&app, env.as_deref())?;
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let mut args: Vec<&str> = vec![
        "secret",
        "delete",
        name.as_str(),
        "--repo",
        &slug,
        "--app",
        app.as_str(),
    ];
    if let Some(env) = env.as_deref() {
        validate_env(env)?;
        args.push("--env");
        args.push(env);
    }
    run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

fn variables_path(slug: &str, env: Option<&str>) -> AppResult<String> {
    match env {
        Some(env) => {
            validate_env(env)?;
            Ok(format!(
                "repos/{slug}/environments/{env}/variables?per_page=100"
            ))
        }
        None => Ok(format!("repos/{slug}/actions/variables?per_page=100")),
    }
}

#[tauri::command]
pub async fn gh_variables_list(
    repo_path: String,
    env: Option<String>,
) -> AppResult<Vec<GhVariable>> {
    // Pin the origin slug so a fork lists its OWN variables (see `gh_secrets_list`).
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let path = variables_path(&slug, env.as_deref())?;
    let out = run_gh(Some(&repo_path), &["api", &path], GH_NETWORK_TIMEOUT).await?;
    let resp: VariablesResp = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| gh_unreadable("the variables", format!("could not parse variables: {e}")))?;
    Ok(resp.variables)
}

#[tauri::command]
pub async fn gh_variable_set(
    repo_path: String,
    env: Option<String>,
    name: String,
    value: String,
) -> AppResult<()> {
    let name = name.trim();
    validate_var_name(name)?;
    // Pin the origin slug so a fork's variable write can't target the PARENT
    // (see `gh_secret_set`).
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    // `gh variable set` upserts (create or update); value from stdin.
    let mut args: Vec<&str> = vec!["variable", "set", name, "--repo", &slug];
    if let Some(env) = env.as_deref() {
        validate_env(env)?;
        args.push("--env");
        args.push(env);
    }
    run_gh_input(Some(&repo_path), &args, &value, GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

#[tauri::command]
pub async fn gh_variable_delete(
    repo_path: String,
    env: Option<String>,
    name: String,
) -> AppResult<()> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let mut args: Vec<&str> = vec!["variable", "delete", name.as_str(), "--repo", &slug];
    if let Some(env) = env.as_deref() {
        validate_env(env)?;
        args.push("--env");
        args.push(env);
    }
    run_gh(Some(&repo_path), &args, GH_NETWORK_TIMEOUT).await?;
    Ok(())
}

/// Deployment environment names, for the Actions secret/variable env picker.
#[tauri::command]
pub async fn gh_environments_list(repo_path: String) -> AppResult<Vec<String>> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh_raw(
        Some(&repo_path),
        &["api", &format!("repos/{slug}/environments?per_page=100")],
        GH_NETWORK_TIMEOUT,
    )
    .await?;
    // A repo with environments disabled / none returns 404 (or an empty list);
    // tolerate both as "no environments" rather than erroring the panel.
    if out.code != 0 {
        return Ok(Vec::new());
    }
    let resp: EnvsResp = serde_json::from_str(&out.stdout_lossy()).unwrap_or(EnvsResp {
        environments: Vec::new(),
    });
    Ok(resp.environments.into_iter().map(|e| e.name).collect())
}
