use std::collections::HashSet;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::forge::session::{classify_gh_failure, GhFailure};
use crate::github::gh_failure_reason;
use crate::github::repo_meta::repo_object;
use crate::github::runner::{run_gh_raw, GhOutput, GH_NETWORK_TIMEOUT, GH_TIMEOUT};

/// Community-health profile + social counts for the Insights tab. Read-only and
/// tolerant: a repo without a GitHub remote (or with the dependency/community
/// data unavailable) reads as a zeroed default rather than erroring — the same
/// posture as `gh_repo_admin` for access denials only. Still gate on a GitHub
/// repo so an all-zero default isn't shown for a non-GitHub project.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityInsights {
    /// 0–100 community-health score from GitHub's community/profile endpoint.
    pub health_percentage: u32,
    pub has_readme: bool,
    pub has_license: bool,
    pub has_code_of_conduct: bool,
    pub has_contributing: bool,
    pub has_issue_template: bool,
    pub has_pull_request_template: bool,
    /// SPDX-ish license name, when one is detected.
    pub license: Option<String>,
    pub forks_count: u32,
    pub stargazers_count: u32,
    /// Real "watchers" (subscribers) — NOT the legacy `watchers_count` that just
    /// mirrors stars.
    pub watchers_count: u32,
    pub open_issues_count: u32,
    /// Private repos can't show the public "dependents" / network surfaces.
    pub private: bool,
}

#[tauri::command]
pub async fn gh_community_insights(repo_path: String) -> AppResult<CommunityInsights> {
    // Pin the origin slug: `gh api`'s `{owner}/{repo}` placeholders auto-resolve
    // to the PARENT on a fork with an `upstream` remote, so build the literal
    // `repos/<slug>` path to read the fork's own insights.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;

    // Community profile: health score + which health files are present.
    let profile = run_gh_raw(
        Some(&repo_path),
        &["api", &format!("repos/{slug}/community/profile")],
        GH_TIMEOUT,
    )
    .await?;
    let repo = repo_object(&repo_path, &slug, GH_TIMEOUT).await;
    community_insights_outcome(Ok(profile), repo)
}

fn community_insights_outcome(
    profile: AppResult<GhOutput>,
    repo: AppResult<GhOutput>,
) -> AppResult<CommunityInsights> {
    let profile = profile?;
    let repo = repo?;
    for response in [&profile, &repo] {
        if response.code != 0
            && matches!(
                classify_gh_failure(&response.stderr),
                GhFailure::RateLimited | GhFailure::Transport
            )
        {
            return Err(AppError::Gh(gh_failure_reason(response)));
        }
    }
    let mut out = CommunityInsights::default();
    if profile.code == 0 {
        let v: serde_json::Value = serde_json::from_str(&profile.stdout_lossy())
            .map_err(|e| crate::github::gh_unreadable("the community profile", e.to_string()))?;
        out.health_percentage = v["health_percentage"].as_u64().unwrap_or(0) as u32;
        let files = &v["files"];
        let present = |k: &str| !files[k].is_null();
        out.has_readme = present("readme");
        out.has_license = present("license");
        out.has_code_of_conduct = present("code_of_conduct");
        out.has_contributing = present("contributing");
        out.has_issue_template = present("issue_template");
        out.has_pull_request_template = present("pull_request_template");
        out.license = files["license"]["name"].as_str().map(str::to_string);
    }

    if repo.code == 0 {
        let v: serde_json::Value = serde_json::from_str(&repo.stdout_lossy())
            .map_err(|e| crate::github::gh_unreadable("the repository", e.to_string()))?;
        out.forks_count = v["forks_count"].as_u64().unwrap_or(0) as u32;
        out.stargazers_count = v["stargazers_count"].as_u64().unwrap_or(0) as u32;
        out.watchers_count = v["subscribers_count"].as_u64().unwrap_or(0) as u32;
        out.open_issues_count = v["open_issues_count"].as_u64().unwrap_or(0) as u32;
        out.private = v["private"].as_bool().unwrap_or(true);
    }

    Ok(out)
}

// ── Repo social stats by explicit owner/name (MCP registry browser) ──────────
// Unlike `gh_community_insights` (which resolves the owner/repo slug from a
// local repo's origin remote), this takes explicit "owner/name" refs straight
// from the MCP registry's `repository.url`, and fetches a whole page of them in
// ONE GraphQL call. Tolerant: an unresolved/private repo returns null for its alias while
// the rest still resolve, so a single bad ref never sinks the batch.

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStat {
    /// Canonical "owner/name" from GitHub (the frontend matches case-insensitively).
    pub name_with_owner: String,
    pub stars: u32,
    pub forks: u32,
    /// Last push, ISO-8601 — a freshness/maintenance signal.
    pub pushed_at: Option<String>,
    pub archived: bool,
    /// SPDX id, when GitHub detected a license (NOASSERTION/none → null).
    pub license: Option<String>,
}

/// True for the GitHub owner/repo character set, so a ref is safe to inline in
/// the GraphQL query string (no injection, no quoting needed).
fn safe_repo_token(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Batched repo social stats for the given "owner/name" refs. Returns only the
/// repos that resolved (caller treats a missing one as "no stats"). Capped at
/// 100 refs so one query can't blow the GraphQL node budget.
#[tauri::command]
pub async fn gh_repo_stats(repos: Vec<String>) -> AppResult<Vec<RepoStat>> {
    let mut seen = HashSet::new();
    let mut pairs: Vec<(String, String)> = Vec::new();
    for r in &repos {
        let Some((owner, name)) = r.trim().split_once('/') else {
            continue;
        };
        let name = name.trim_end_matches(".git");
        if safe_repo_token(owner)
            && safe_repo_token(name)
            && seen.insert((owner.to_lowercase(), name.to_lowercase()))
        {
            pairs.push((owner.to_string(), name.to_string()));
            if pairs.len() >= 100 {
                break;
            }
        }
    }
    if pairs.is_empty() {
        return Ok(Vec::new());
    }

    let mut query = String::from("query{");
    for (i, (owner, name)) in pairs.iter().enumerate() {
        query.push_str(&format!(
            "r{i}: repository(owner:\"{owner}\",name:\"{name}\"){{ nameWithOwner \
             stargazerCount forkCount pushedAt isArchived licenseInfo{{spdxId}} }} "
        ));
    }
    query.push('}');

    // Keep partial `data` despite a nonzero exit: unresolved GraphQL refs can
    // coexist with usable results. Without a data object, classify the failure.
    let arg = format!("query={query}");
    let out = run_gh_raw(
        None,
        &["api", "graphql", "-f", &arg],
        GH_NETWORK_TIMEOUT,
    )
    .await?;

    repo_stats_outcome(Ok(out))
}

fn repo_stats_outcome(result: AppResult<GhOutput>) -> AppResult<Vec<RepoStat>> {
    let out = result?;
    let value = match serde_json::from_str::<serde_json::Value>(&out.stdout_lossy()) {
        Ok(value) => Some(value),
        Err(error) if out.code == 0 => {
            return Err(crate::github::gh_unreadable(
                "the repository statistics",
                error.to_string(),
            ));
        }
        Err(_) => None,
    };
    if !value
        .as_ref()
        .and_then(|v| v.get("data"))
        .is_some_and(serde_json::Value::is_object)
    {
        return match classify_gh_failure(&out.stderr) {
            GhFailure::RateLimited | GhFailure::Transport => {
                Err(AppError::Gh(gh_failure_reason(&out)))
            }
            GhFailure::NotFound | GhFailure::Answered => Ok(Vec::new()),
        };
    }
    let mut stats = Vec::new();
    if let Some(v) = value {
        if let Some(data) = v.get("data").and_then(|d| d.as_object()) {
            for repo in data.values() {
                let name_with_owner = repo["nameWithOwner"].as_str().unwrap_or("");
                if name_with_owner.is_empty() {
                    continue;
                }
                let license = repo["licenseInfo"]["spdxId"]
                    .as_str()
                    .filter(|s| !s.is_empty() && *s != "NOASSERTION")
                    .map(str::to_string);
                stats.push(RepoStat {
                    name_with_owner: name_with_owner.to_string(),
                    stars: repo["stargazerCount"].as_u64().unwrap_or(0) as u32,
                    forks: repo["forkCount"].as_u64().unwrap_or(0) as u32,
                    pushed_at: repo["pushedAt"].as_str().map(str::to_string),
                    archived: repo["isArchived"].as_bool().unwrap_or(false),
                    license,
                });
            }
        }
    }
    Ok(stats)
}

// ── Traffic (Insights Phase 2) ───────────────────────────────────────────────
// GitHub's traffic API requires PUSH access (403 otherwise) and only ever
// returns the last 14 days, so this is a "snapshot, can't backfill" card.

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficPoint {
    timestamp: String,
    count: u32,
    uniques: u32,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficItem {
    /// Referrer domain or page path.
    name: String,
    /// Page title (paths only; empty for referrers).
    title: String,
    count: u32,
    uniques: u32,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoTraffic {
    /// false when the viewer lacks push access (the traffic API 403s).
    available: bool,
    views_count: u32,
    views_uniques: u32,
    views: Vec<TrafficPoint>,
    clones_count: u32,
    clones_uniques: u32,
    clones: Vec<TrafficPoint>,
    referrers: Vec<TrafficItem>,
    paths: Vec<TrafficItem>,
}

fn parse_points(v: &serde_json::Value, key: &str) -> Vec<TrafficPoint> {
    v[key]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|p| TrafficPoint {
                    timestamp: p["timestamp"].as_str().unwrap_or("").to_string(),
                    count: p["count"].as_u64().unwrap_or(0) as u32,
                    uniques: p["uniques"].as_u64().unwrap_or(0) as u32,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_items(out: &GhOutput, key: &str) -> AppResult<Vec<TrafficItem>> {
    if out.code != 0 {
        return Ok(Vec::new());
    }
    let value: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| crate::github::gh_unreadable("the traffic", e.to_string()))?;
    let Some(arr) = value.as_array() else {
        return Ok(Vec::new());
    };
    Ok(arr
        .iter()
        .map(|x| TrafficItem {
            name: x[key].as_str().unwrap_or("").to_string(),
            title: x["title"].as_str().unwrap_or("").to_string(),
            count: x["count"].as_u64().unwrap_or(0) as u32,
            uniques: x["uniques"].as_u64().unwrap_or(0) as u32,
        })
        .collect())
}

#[tauri::command]
pub async fn gh_repo_traffic(repo_path: String) -> AppResult<RepoTraffic> {
    // Pin the origin slug so a fork reads its OWN traffic, not the parent's
    // (see `gh_community_insights`).
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    // Views gates the card: an access denial means traffic is unavailable.
    let views = run_gh_raw(
        Some(&repo_path),
        &["api", &format!("repos/{slug}/traffic/views")],
        GH_TIMEOUT,
    )
    .await?;
    let out = traffic_views_outcome(Ok(views))?;
    if !out.available {
        return Ok(out);
    }
    // The remaining three calls are independent — fan them out.
    let clones_path = format!("repos/{slug}/traffic/clones");
    let referrers_path = format!("repos/{slug}/traffic/popular/referrers");
    let paths_path = format!("repos/{slug}/traffic/popular/paths");
    let clones_args = ["api", clones_path.as_str()];
    let referrers_args = ["api", referrers_path.as_str()];
    let paths_args = ["api", paths_path.as_str()];
    let (clones, referrers, paths) = tokio::join!(
        run_gh_raw(Some(&repo_path), &clones_args, GH_TIMEOUT),
        run_gh_raw(Some(&repo_path), &referrers_args, GH_TIMEOUT),
        run_gh_raw(Some(&repo_path), &paths_args, GH_TIMEOUT),
    );
    traffic_details_outcome(out, clones, referrers, paths)
}

fn traffic_views_outcome(result: AppResult<GhOutput>) -> AppResult<RepoTraffic> {
    let views = result?;
    if views.code != 0 {
        return match classify_gh_failure(&views.stderr) {
            GhFailure::RateLimited | GhFailure::Transport => {
                Err(AppError::Gh(gh_failure_reason(&views)))
            }
            GhFailure::NotFound | GhFailure::Answered => Ok(RepoTraffic::default()),
        };
    }
    let mut out = RepoTraffic {
        available: true,
        ..Default::default()
    };
    let v: serde_json::Value = serde_json::from_str(&views.stdout_lossy())
        .map_err(|e| crate::github::gh_unreadable("the traffic views", e.to_string()))?;
    out.views_count = v["count"].as_u64().unwrap_or(0) as u32;
    out.views_uniques = v["uniques"].as_u64().unwrap_or(0) as u32;
    out.views = parse_points(&v, "views");
    Ok(out)
}

fn traffic_details_outcome(
    mut out: RepoTraffic,
    clones: AppResult<GhOutput>,
    referrers: AppResult<GhOutput>,
    paths: AppResult<GhOutput>,
) -> AppResult<RepoTraffic> {
    let clones = clones?;
    let referrers = referrers?;
    let paths = paths?;
    for response in [&clones, &referrers, &paths] {
        if response.code != 0
            && matches!(
                classify_gh_failure(&response.stderr),
                GhFailure::RateLimited | GhFailure::Transport
            )
        {
            return Err(AppError::Gh(gh_failure_reason(response)));
        }
    }
    if clones.code == 0 {
        let v: serde_json::Value = serde_json::from_str(&clones.stdout_lossy())
            .map_err(|e| crate::github::gh_unreadable("the traffic clones", e.to_string()))?;
        out.clones_count = v["count"].as_u64().unwrap_or(0) as u32;
        out.clones_uniques = v["uniques"].as_u64().unwrap_or(0) as u32;
        out.clones = parse_points(&v, "clones");
    }
    out.referrers = parse_items(&referrers, "referrer")?;
    out.paths = parse_items(&paths, "path")?;
    Ok(out)
}

// ── Dependencies (Insights Phase 2) ──────────────────────────────────────────
// The SBOM endpoint is public-read but the dependency graph defaults OFF for
// repos created after 2025-06-17, so an empty/disabled result is normal.

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyPackage {
    /// "npm", "pip", "githubactions", "cargo", … (from the package's purl).
    ecosystem: String,
    name: String,
    version: String,
    /// true if the repository declares this directly (the SBOM root depends on
    /// it); false means it's only pulled in transitively.
    direct: bool,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDependencies {
    available: bool,
    total: u32,
    /// Capped sample (the full count is `total`).
    packages: Vec<DependencyPackage>,
}

#[tauri::command]
pub async fn gh_repo_dependencies(repo_path: String) -> AppResult<RepoDependencies> {
    // Pin the origin slug so a fork reads its OWN dependency graph, not the
    // parent's (see `gh_community_insights`).
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let out = run_gh_raw(
        Some(&repo_path),
        &["api", &format!("repos/{slug}/dependency-graph/sbom")],
        GH_TIMEOUT,
    )
    .await?;
    repo_dependencies_outcome(Ok(out))
}

fn repo_dependencies_outcome(result: AppResult<GhOutput>) -> AppResult<RepoDependencies> {
    let out = result?;
    if out.code != 0 {
        return match classify_gh_failure(&out.stderr) {
            GhFailure::RateLimited | GhFailure::Transport => {
                Err(AppError::Gh(gh_failure_reason(&out)))
            }
            GhFailure::NotFound | GhFailure::Answered => Ok(RepoDependencies::default()),
        };
    }
    let mut deps = RepoDependencies {
        available: true,
        ..Default::default()
    };
    let v: serde_json::Value = serde_json::from_str(&out.stdout_lossy())
        .map_err(|e| crate::github::gh_unreadable("the dependencies", e.to_string()))?;
    let sbom = &v["sbom"];
    // SPDXID → package name, and the relationship graph, let us split direct
    // (the repo root depends on it) from transitive dependencies.
    let mut id_to_name: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    if let Some(pkgs) = sbom["packages"].as_array() {
        for p in pkgs {
            if let (Some(id), Some(name)) = (p["SPDXID"].as_str(), p["name"].as_str()) {
                id_to_name.insert(id, name);
            }
        }
    }
    let rels = sbom["relationships"].as_array();
    let root = rels.and_then(|r| {
        r.iter()
            .find(|x| x["relationshipType"].as_str() == Some("DESCRIBES"))
            .and_then(|x| x["relatedSpdxElement"].as_str())
    });
    let mut direct_names: std::collections::HashSet<&str> = std::collections::HashSet::new();
    if let (Some(rels), Some(root)) = (rels, root) {
        for r in rels {
            if r["relationshipType"].as_str() == Some("DEPENDS_ON")
                && r["spdxElementId"].as_str() == Some(root)
            {
                if let Some(name) = r["relatedSpdxElement"]
                    .as_str()
                    .and_then(|id| id_to_name.get(id))
                {
                    direct_names.insert(name);
                }
            }
        }
    }

    if let Some(pkgs) = sbom["packages"].as_array() {
        // The SBOM lists each package twice — the manifest constraint
        // ("^6.4.7") and the resolved lockfile version ("6.4.7") — so dedupe
        // by (ecosystem, name), preferring a concrete (digit-leading) version.
        let concrete = |v: &str| v.starts_with(|c: char| c.is_ascii_digit());
        let mut by_key: std::collections::HashMap<(String, String), DependencyPackage> =
            std::collections::HashMap::new();
        for p in pkgs {
            let name = p["name"].as_str().unwrap_or("");
            if name.is_empty() {
                continue;
            }
            // The ecosystem isn't in `name` (that's just "astro" / "@scope/x");
            // it's the purl in externalRefs, e.g. "pkg:npm/astro@5" → "npm".
            // Packages without a purl are the SBOM's root document — skip them.
            let Some(ecosystem) = p["externalRefs"].as_array().and_then(|refs| {
                refs.iter().find_map(|r| {
                    let loc = r["referenceLocator"].as_str()?;
                    let rest = loc.strip_prefix("pkg:")?;
                    Some(rest.split('/').next().unwrap_or("").to_string())
                })
            }) else {
                continue;
            };
            let version = p["versionInfo"].as_str().unwrap_or("").to_string();
            match by_key.entry((ecosystem.clone(), name.to_string())) {
                std::collections::hash_map::Entry::Occupied(mut e) => {
                    if !concrete(&e.get().version) && concrete(&version) {
                        e.get_mut().version = version;
                    }
                }
                std::collections::hash_map::Entry::Vacant(e) => {
                    e.insert(DependencyPackage {
                        ecosystem,
                        name: name.to_string(),
                        version,
                        direct: direct_names.contains(name),
                    });
                }
            }
        }
        let mut all: Vec<DependencyPackage> = by_key.into_values().collect();
        // Direct first, then by ecosystem + name.
        all.sort_by(|a, b| {
            b.direct
                .cmp(&a.direct)
                .then(a.ecosystem.cmp(&b.ecosystem))
                .then(a.name.cmp(&b.name))
        });
        deps.total = all.len() as u32;
        all.truncate(2000);
        deps.packages = all;
    }
    Ok(deps)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn community_profile_rejects_unreadable_bodies_and_keeps_missing_fields_empty() {
        let empty =
            community_insights_outcome(gh_output(0, "{}", ""), gh_output(0, "{}", "")).unwrap();
        assert_eq!(empty.health_percentage, 0);
        assert!(!empty.has_readme && !empty.has_license);
        assert_eq!(empty.forks_count, 0);
        assert_eq!(empty.stargazers_count, 0);
        for body in ["garbage", ""] {
            let error = community_insights_outcome(gh_output(0, body, ""), gh_output(0, "{}", ""))
                .expect_err("unreadable community insights must reject");
            assert!(
                matches!(error, AppError::Gh(message) if message.starts_with("Couldn't read "))
            );
        }
    }

    #[test]
    fn community_repo_rejects_unreadable_bodies_and_keeps_missing_fields_empty() {
        let empty =
            community_insights_outcome(gh_output(0, "{}", ""), gh_output(0, "{}", "")).unwrap();
        assert_eq!(empty.health_percentage, 0);
        assert!(!empty.has_readme && !empty.has_license);
        assert_eq!(empty.forks_count, 0);
        assert_eq!(empty.stargazers_count, 0);
        for body in ["garbage", ""] {
            let error = community_insights_outcome(gh_output(0, "{}", ""), gh_output(0, body, ""))
                .expect_err("unreadable community insights must reject");
            assert!(
                matches!(error, AppError::Gh(message) if message.starts_with("Couldn't read "))
            );
        }
    }

    #[test]
    fn traffic_views_reject_unreadable_bodies_and_keep_missing_fields_empty() {
        let empty = traffic_views_outcome(gh_output(0, "{}", "")).unwrap();
        assert!(empty.available && empty.views.is_empty());
        assert_eq!((empty.views_count, empty.views_uniques), (0, 0));
        for body in ["garbage", ""] {
            let error = traffic_views_outcome(gh_output(0, body, ""))
                .expect_err("unreadable traffic views must reject");
            assert!(
                matches!(error, AppError::Gh(message) if message.starts_with("Couldn't read "))
            );
        }
    }

    #[test]
    fn traffic_clones_reject_unreadable_bodies_and_keep_missing_fields_empty() {
        let body = "{}";
        let empty = traffic_details_outcome(
            RepoTraffic::default(),
            gh_output(0, body, ""),
            gh_output(0, "{}", ""),
            gh_output(0, "{}", ""),
        )
        .unwrap();
        assert!(empty.clones.is_empty() && empty.referrers.is_empty() && empty.paths.is_empty());
        assert_eq!((empty.clones_count, empty.clones_uniques), (0, 0));
        for body in ["garbage", ""] {
            let error = traffic_details_outcome(
                RepoTraffic::default(),
                gh_output(0, body, ""),
                gh_output(0, "{}", ""),
                gh_output(0, "{}", ""),
            )
            .expect_err("unreadable traffic details must reject");
            assert!(
                matches!(error, AppError::Gh(message) if message.starts_with("Couldn't read "))
            );
        }
    }

    #[test]
    fn traffic_referrers_reject_unreadable_bodies_and_keep_missing_fields_empty() {
        let body = "{}";
        let empty = traffic_details_outcome(
            RepoTraffic::default(),
            gh_output(0, "{}", ""),
            gh_output(0, body, ""),
            gh_output(0, "{}", ""),
        )
        .unwrap();
        assert!(empty.clones.is_empty() && empty.referrers.is_empty() && empty.paths.is_empty());
        assert_eq!((empty.clones_count, empty.clones_uniques), (0, 0));
        for body in ["garbage", ""] {
            let error = traffic_details_outcome(
                RepoTraffic::default(),
                gh_output(0, "{}", ""),
                gh_output(0, body, ""),
                gh_output(0, "{}", ""),
            )
            .expect_err("unreadable traffic details must reject");
            assert!(
                matches!(error, AppError::Gh(message) if message.starts_with("Couldn't read "))
            );
        }
    }

    #[test]
    fn traffic_paths_reject_unreadable_bodies_and_keep_missing_fields_empty() {
        let body = "{}";
        let empty = traffic_details_outcome(
            RepoTraffic::default(),
            gh_output(0, "{}", ""),
            gh_output(0, "{}", ""),
            gh_output(0, body, ""),
        )
        .unwrap();
        assert!(empty.clones.is_empty() && empty.referrers.is_empty() && empty.paths.is_empty());
        assert_eq!((empty.clones_count, empty.clones_uniques), (0, 0));
        for body in ["garbage", ""] {
            let error = traffic_details_outcome(
                RepoTraffic::default(),
                gh_output(0, "{}", ""),
                gh_output(0, "{}", ""),
                gh_output(0, body, ""),
            )
            .expect_err("unreadable traffic details must reject");
            assert!(
                matches!(error, AppError::Gh(message) if message.starts_with("Couldn't read "))
            );
        }
    }

    #[test]
    fn dependencies_reject_unreadable_bodies_and_keep_missing_fields_empty() {
        let empty = repo_dependencies_outcome(gh_output(0, "{}", "")).unwrap();
        assert!(empty.available && empty.packages.is_empty());
        assert_eq!(empty.total, 0);
        for body in ["garbage", ""] {
            let error = repo_dependencies_outcome(gh_output(0, body, ""))
                .expect_err("unreadable dependencies must reject");
            assert!(
                matches!(error, AppError::Gh(message) if message.starts_with("Couldn't read "))
            );
        }
    }

    #[test]
    fn repo_stats_reject_unreadable_bodies_and_keep_missing_data_empty() {
        for body in ["{}", r#"{"data":null}"#, r#"{"data":[]}"#] {
            assert!(repo_stats_outcome(gh_output(0, body, ""))
                .unwrap()
                .is_empty());
        }
        for body in ["garbage", ""] {
            let error = repo_stats_outcome(gh_output(0, body, ""))
                .expect_err("unreadable repository stats must reject");
            assert!(
                matches!(error, AppError::Gh(message) if message.starts_with("Couldn't read "))
            );
        }
    }

    #[test]
    fn repo_stats_preserve_partial_data_and_classify_missing_data() {
        let partial = r#"{"data":{"r0":{"nameWithOwner":"o/r","stargazerCount":9},"r1":null},"errors":[{"message":"unresolved"}]}"#;
        assert_eq!(
            repo_stats_outcome(gh_output(1, partial, HELD_REST_STDERR)).unwrap()[0].stars,
            9
        );
        for body in ["", "garbage", "{}", r#"{"data":null}"#, r#"{"data":[]}"#] {
            assert!(
                repo_stats_outcome(gh_output(1, body, HELD_REST_STDERR)).is_err(),
                "{body}"
            );
            assert!(repo_stats_outcome(gh_output(1, body, NOT_FOUND_STDERR))
                .unwrap()
                .is_empty());
        }
        assert!(
            repo_stats_outcome(gh_output(1, r#"{"data":{}}"#, HELD_REST_STDERR))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn traffic_clones_preserve_denials_and_reject_transient_failures() {
        let absent = traffic_details_outcome(
            RepoTraffic {
                available: true,
                ..Default::default()
            },
            gh_output(1, "", NOT_FOUND_STDERR),
            gh_output(0, "{}", ""),
            gh_output(0, "{}", ""),
        )
        .unwrap();
        assert!(
            absent.available
                && absent.clones.is_empty()
                && absent.referrers.is_empty()
                && absent.paths.is_empty()
        );
        let absent = traffic_details_outcome(
            RepoTraffic {
                available: true,
                ..Default::default()
            },
            gh_output(1, "", ANSWERED_STDERR),
            gh_output(0, "{}", ""),
            gh_output(0, "{}", ""),
        )
        .unwrap();
        assert!(
            absent.available
                && absent.clones.is_empty()
                && absent.referrers.is_empty()
                && absent.paths.is_empty()
        );
        let loaded = traffic_details_outcome(
            RepoTraffic {
                available: true,
                ..Default::default()
            },
            gh_output(0, r#"{}"#, ""),
            gh_output(0, "{}", ""),
            gh_output(0, "{}", ""),
        )
        .unwrap();
        assert!(loaded.available);
        for stderr in [
            HELD_REST_STDERR,
            "connection failed",
            "gh: API rate limit exceeded for user ID 12345 (HTTP 403)",
        ] {
            let error = traffic_details_outcome(
                RepoTraffic {
                    available: true,
                    ..Default::default()
                },
                gh_output(1, "", stderr),
                gh_output(0, "{}", ""),
                gh_output(0, "{}", ""),
            )
            .expect_err("failed read must reject");
            assert!(
                matches!(&error, crate::error::AppError::Gh(message) if message == &crate::github::gh_failure_reason(&gh_output(1, "", stderr).unwrap())),
                "{error}"
            );
            if stderr == HELD_REST_STDERR {
                assert!(error.to_string().contains("rate limit"));
            }
        }
        assert!(traffic_details_outcome(
            RepoTraffic {
                available: true,
                ..Default::default()
            },
            Err(crate::error::AppError::Timeout(30)),
            gh_output(0, "{}", ""),
            gh_output(0, "{}", "")
        )
        .is_err());
    }

    #[test]
    fn traffic_referrers_preserve_denials_and_reject_transient_failures() {
        let absent = traffic_details_outcome(
            RepoTraffic {
                available: true,
                ..Default::default()
            },
            gh_output(0, "{}", ""),
            gh_output(1, "", NOT_FOUND_STDERR),
            gh_output(0, "{}", ""),
        )
        .unwrap();
        assert!(
            absent.available
                && absent.clones.is_empty()
                && absent.referrers.is_empty()
                && absent.paths.is_empty()
        );
        let absent = traffic_details_outcome(
            RepoTraffic {
                available: true,
                ..Default::default()
            },
            gh_output(0, "{}", ""),
            gh_output(1, "", ANSWERED_STDERR),
            gh_output(0, "{}", ""),
        )
        .unwrap();
        assert!(
            absent.available
                && absent.clones.is_empty()
                && absent.referrers.is_empty()
                && absent.paths.is_empty()
        );
        let loaded = traffic_details_outcome(
            RepoTraffic {
                available: true,
                ..Default::default()
            },
            gh_output(0, "{}", ""),
            gh_output(0, r#"{}"#, ""),
            gh_output(0, "{}", ""),
        )
        .unwrap();
        assert!(loaded.available);
        for stderr in [
            HELD_REST_STDERR,
            "connection failed",
            "gh: API rate limit exceeded for user ID 12345 (HTTP 403)",
        ] {
            let error = traffic_details_outcome(
                RepoTraffic {
                    available: true,
                    ..Default::default()
                },
                gh_output(0, "{}", ""),
                gh_output(1, "", stderr),
                gh_output(0, "{}", ""),
            )
            .expect_err("failed read must reject");
            assert!(
                matches!(&error, crate::error::AppError::Gh(message) if message == &crate::github::gh_failure_reason(&gh_output(1, "", stderr).unwrap())),
                "{error}"
            );
            if stderr == HELD_REST_STDERR {
                assert!(error.to_string().contains("rate limit"));
            }
        }
        assert!(traffic_details_outcome(
            RepoTraffic {
                available: true,
                ..Default::default()
            },
            gh_output(0, "{}", ""),
            Err(crate::error::AppError::Timeout(30)),
            gh_output(0, "{}", "")
        )
        .is_err());
    }

    #[test]
    fn traffic_paths_preserve_denials_and_reject_transient_failures() {
        let absent = traffic_details_outcome(
            RepoTraffic {
                available: true,
                ..Default::default()
            },
            gh_output(0, "{}", ""),
            gh_output(0, "{}", ""),
            gh_output(1, "", NOT_FOUND_STDERR),
        )
        .unwrap();
        assert!(
            absent.available
                && absent.clones.is_empty()
                && absent.referrers.is_empty()
                && absent.paths.is_empty()
        );
        let absent = traffic_details_outcome(
            RepoTraffic {
                available: true,
                ..Default::default()
            },
            gh_output(0, "{}", ""),
            gh_output(0, "{}", ""),
            gh_output(1, "", ANSWERED_STDERR),
        )
        .unwrap();
        assert!(
            absent.available
                && absent.clones.is_empty()
                && absent.referrers.is_empty()
                && absent.paths.is_empty()
        );
        let loaded = traffic_details_outcome(
            RepoTraffic {
                available: true,
                ..Default::default()
            },
            gh_output(0, "{}", ""),
            gh_output(0, "{}", ""),
            gh_output(0, r#"{}"#, ""),
        )
        .unwrap();
        assert!(loaded.available);
        for stderr in [
            HELD_REST_STDERR,
            "connection failed",
            "gh: API rate limit exceeded for user ID 12345 (HTTP 403)",
        ] {
            let error = traffic_details_outcome(
                RepoTraffic {
                    available: true,
                    ..Default::default()
                },
                gh_output(0, "{}", ""),
                gh_output(0, "{}", ""),
                gh_output(1, "", stderr),
            )
            .expect_err("failed read must reject");
            assert!(
                matches!(&error, crate::error::AppError::Gh(message) if message == &crate::github::gh_failure_reason(&gh_output(1, "", stderr).unwrap())),
                "{error}"
            );
            if stderr == HELD_REST_STDERR {
                assert!(error.to_string().contains("rate limit"));
            }
        }
        assert!(traffic_details_outcome(
            RepoTraffic {
                available: true,
                ..Default::default()
            },
            gh_output(0, "{}", ""),
            gh_output(0, "{}", ""),
            Err(crate::error::AppError::Timeout(30))
        )
        .is_err());
    }

    fn gh_output(
        code: i32,
        body: &str,
        stderr: &str,
    ) -> crate::error::AppResult<crate::github::runner::GhOutput> {
        Ok(crate::github::runner::GhOutput {
            code,
            stdout: body.as_bytes().to_vec(),
            stderr: stderr.into(),
        })
    }

    const HELD_REST_STDERR: &str = "GitHub's REST API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.";
    const NOT_FOUND_STDERR: &str = "HTTP 404: Not Found (https://api.github.com/repos/o/r)";
    const ANSWERED_STDERR: &str =
        "HTTP 403: Resource not accessible by integration (https://api.github.com/repos/o/r)";

    #[test]
    fn community_profile_preserves_denials_and_rejects_transient_failures() {
        let absent =
            community_insights_outcome(gh_output(1, "", NOT_FOUND_STDERR), gh_output(0, "{}", ""))
                .unwrap();
        assert!(absent.health_percentage == 0);
        let absent =
            community_insights_outcome(gh_output(1, "", ANSWERED_STDERR), gh_output(0, "{}", ""))
                .unwrap();
        assert!(absent.health_percentage == 0);
        let loaded = community_insights_outcome(
            gh_output(0, r#"{"health_percentage":90}"#, ""),
            gh_output(0, "{}", ""),
        )
        .unwrap();
        assert!(loaded.health_percentage == 90);
        for stderr in [
            HELD_REST_STDERR,
            "connection failed",
            "gh: API rate limit exceeded for user ID 12345 (HTTP 403)",
        ] {
            let error =
                community_insights_outcome(gh_output(1, "", stderr), gh_output(0, "{}", ""))
                    .expect_err("failed read must reject");
            assert!(
                matches!(&error, crate::error::AppError::Gh(message) if message == &crate::github::gh_failure_reason(&gh_output(1, "", stderr).unwrap())),
                "{error}"
            );
            if stderr == HELD_REST_STDERR {
                assert!(error.to_string().contains("rate limit"));
            }
        }
        assert!(community_insights_outcome(
            Err(crate::error::AppError::Timeout(30)),
            gh_output(0, "{}", "")
        )
        .is_err());
    }

    #[test]
    fn community_repo_preserves_denials_and_rejects_transient_failures() {
        let absent =
            community_insights_outcome(gh_output(0, "{}", ""), gh_output(1, "", NOT_FOUND_STDERR))
                .unwrap();
        assert!(absent.stargazers_count == 0);
        let absent =
            community_insights_outcome(gh_output(0, "{}", ""), gh_output(1, "", ANSWERED_STDERR))
                .unwrap();
        assert!(absent.stargazers_count == 0);
        let loaded = community_insights_outcome(
            gh_output(0, "{}", ""),
            gh_output(0, r#"{"stargazers_count":5}"#, ""),
        )
        .unwrap();
        assert!(loaded.stargazers_count == 5);
        for stderr in [
            HELD_REST_STDERR,
            "connection failed",
            "gh: API rate limit exceeded for user ID 12345 (HTTP 403)",
        ] {
            let error =
                community_insights_outcome(gh_output(0, "{}", ""), gh_output(1, "", stderr))
                    .expect_err("failed read must reject");
            assert!(
                matches!(&error, crate::error::AppError::Gh(message) if message == &crate::github::gh_failure_reason(&gh_output(1, "", stderr).unwrap())),
                "{error}"
            );
            if stderr == HELD_REST_STDERR {
                assert!(error.to_string().contains("rate limit"));
            }
        }
        assert!(community_insights_outcome(
            gh_output(0, "{}", ""),
            Err(crate::error::AppError::Timeout(30))
        )
        .is_err());
    }

    #[test]
    fn traffic_views_preserve_denials_and_reject_transient_failures() {
        let absent = traffic_views_outcome(gh_output(1, "", NOT_FOUND_STDERR)).unwrap();
        assert!(!absent.available);
        let absent = traffic_views_outcome(gh_output(1, "", ANSWERED_STDERR)).unwrap();
        assert!(!absent.available);
        let loaded = traffic_views_outcome(gh_output(0, r#"{"count":7}"#, "")).unwrap();
        assert!(loaded.available && loaded.views_count == 7);
        for stderr in [
            HELD_REST_STDERR,
            "connection failed",
            "gh: API rate limit exceeded for user ID 12345 (HTTP 403)",
        ] {
            let error = traffic_views_outcome(gh_output(1, "", stderr))
                .expect_err("failed read must reject");
            assert!(
                matches!(&error, crate::error::AppError::Gh(message) if message == &crate::github::gh_failure_reason(&gh_output(1, "", stderr).unwrap())),
                "{error}"
            );
            if stderr == HELD_REST_STDERR {
                assert!(error.to_string().contains("rate limit"));
            }
        }
        assert!(traffic_views_outcome(Err(crate::error::AppError::Timeout(30))).is_err());
    }

    #[test]
    fn dependencies_preserve_denials_and_reject_transient_failures() {
        let absent = repo_dependencies_outcome(gh_output(1, "", NOT_FOUND_STDERR)).unwrap();
        assert!(!absent.available);
        let absent = repo_dependencies_outcome(gh_output(1, "", ANSWERED_STDERR)).unwrap();
        assert!(!absent.available);
        let loaded = repo_dependencies_outcome(gh_output(0, r#"{}"#, "")).unwrap();
        assert!(loaded.available);
        for stderr in [
            HELD_REST_STDERR,
            "connection failed",
            "gh: API rate limit exceeded for user ID 12345 (HTTP 403)",
        ] {
            let error = repo_dependencies_outcome(gh_output(1, "", stderr))
                .expect_err("failed read must reject");
            assert!(
                matches!(&error, crate::error::AppError::Gh(message) if message == &crate::github::gh_failure_reason(&gh_output(1, "", stderr).unwrap())),
                "{error}"
            );
            if stderr == HELD_REST_STDERR {
                assert!(error.to_string().contains("rate limit"));
            }
        }
        assert!(repo_dependencies_outcome(Err(crate::error::AppError::Timeout(30))).is_err());
    }

    #[test]
    fn repo_stats_preserve_denials_and_reject_transient_failures() {
        let absent = repo_stats_outcome(gh_output(1, "", NOT_FOUND_STDERR)).unwrap();
        assert!(absent.is_empty());
        let absent = repo_stats_outcome(gh_output(1, "", ANSWERED_STDERR)).unwrap();
        assert!(absent.is_empty());
        let loaded = repo_stats_outcome(gh_output(
            0,
            r#"{"data":{"r0":{"nameWithOwner":"o/r"}}}"#,
            "",
        ))
        .unwrap();
        assert!(loaded.len() == 1);
        for stderr in [
            HELD_REST_STDERR,
            "GitHub's GraphQL API rate limit has been reached, so GitDesktop didn't send this request. Try again once the limit lifts.",
            "connection failed",
            "gh: API rate limit exceeded for user ID 12345 (HTTP 403)",
        ] {
            let error = repo_stats_outcome(gh_output(1, "", stderr))
                .expect_err("failed read must reject");
            assert!(
                matches!(&error, crate::error::AppError::Gh(message) if message == &crate::github::gh_failure_reason(&gh_output(1, "", stderr).unwrap())),
                "{error}"
            );
            if stderr == HELD_REST_STDERR {
                assert!(error.to_string().contains("rate limit"));
            }
        }
        assert!(repo_stats_outcome(Err(crate::error::AppError::Timeout(30))).is_err());
    }
}
