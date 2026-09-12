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
/// our own environments list, so this is belt-and-suspenders). `env` reaches an
/// endpoint path (`secrets_path`/`variables_path`), never a `-f`/`-F` field, so
/// `{`/`}` are rejected alongside the rest: gh expands `{…}` in an endpoint as an
/// owner/repo placeholder, retargeting the request at another repo (the same class
/// `rulesets.rs`'s `refuse_braced` guards for branch names). `.`/`..` are refused
/// outright too — the surrounding template already supplies the slashes
/// (`environments/{env}/secrets`), so a bare `..` traverses up a path segment
/// without `env` itself needing to carry a `/` (the same risk
/// `valid_github_slug`'s doc names for owner/repo segments).
fn validate_env(env: &str) -> AppResult<()> {
    if env.is_empty()
        || env == "."
        || env == ".."
        || env.contains(['/', '?', '#', '\n', '{', '}'])
    {
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
    let github_prefixed = name.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("GITHUB_"));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_var_name_admits_only_the_documented_shape() {
        for ok in ["MY_SECRET", "_leading_underscore", "a1", "GITHUBX"] {
            assert!(validate_var_name(ok).is_ok(), "{ok} should be valid");
        }
        for bad in [
            "1STARTS_WITH_DIGIT",
            "has-hyphen",
            "has space",
            "",
            "GITHUB_TOKEN",
            "github_token",
            // Byte-boundary regression control: 10 bytes, char boundaries at
            // 0/2/4/6/8/10 — byte 7 lands mid-character, which a slicing
            // prefix check (rather than `str::get`) would panic on.
            "ééééé",
        ] {
            assert!(validate_var_name(bad).is_err(), "{bad} should be rejected");
        }
    }

    /// `env` reaches an endpoint path, never a `-f`/`-F` field — `{`/`}` must be
    /// refused alongside the pre-existing `/`, `?`, `#`, `\n`, or a crafted
    /// environment name (`{owner}`, say) could retarget the request via gh's own
    /// endpoint placeholder expansion. A bare `.`/`..` is refused too — the
    /// surrounding endpoint template already supplies the slashes, so `env`
    /// doesn't need one to traverse a path segment; the `..staging`/`prod..`
    /// positives prove the check stays an exact-match, not a substring ban.
    #[test]
    fn validate_env_refuses_path_and_brace_metacharacters() {
        for ok in ["production", "staging-2", "My Env", "..staging", "prod.."] {
            assert!(validate_env(ok).is_ok(), "{ok} should be valid");
        }
        for bad in [
            "", "a/b", "a?b", "a#b", "a\nb", "{owner}", "a{b", "a}b", ".", "..",
        ] {
            assert!(validate_env(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn secrets_and_variables_path_scope_to_the_app_or_environment() {
        assert_eq!(
            secrets_path("o/r", "actions", None).unwrap(),
            "repos/o/r/actions/secrets?per_page=100"
        );
        assert_eq!(
            secrets_path("o/r", "actions", Some("prod")).unwrap(),
            "repos/o/r/environments/prod/secrets?per_page=100"
        );
        assert_eq!(
            variables_path("o/r", None).unwrap(),
            "repos/o/r/actions/variables?per_page=100"
        );
        assert_eq!(
            variables_path("o/r", Some("prod")).unwrap(),
            "repos/o/r/environments/prod/variables?per_page=100"
        );
        // A braced environment name never reaches the endpoint string at all.
        assert!(secrets_path("o/r", "actions", Some("{owner}")).is_err());
        assert!(variables_path("o/r", Some("{owner}")).is_err());
    }

    #[test]
    fn app_segment_rejects_unknown_apps() {
        for ok in ["actions", "dependabot", "codespaces"] {
            assert_eq!(app_segment(ok).unwrap(), ok);
        }
        assert!(app_segment("unknown").is_err());
    }
}
