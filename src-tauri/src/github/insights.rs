use std::collections::HashSet;

use serde::Serialize;

use crate::error::AppResult;
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
    let mut out = CommunityInsights::default();

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
    if profile.code == 0 {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&profile.stdout_lossy()) {
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
    }

    // Repo object: social counts.
    let repo = run_gh_raw(
        Some(&repo_path),
        &["api", &format!("repos/{slug}")],
        GH_TIMEOUT,
    )
    .await?;
    if repo.code == 0 {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&repo.stdout_lossy()) {
            out.forks_count = v["forks_count"].as_u64().unwrap_or(0) as u32;
            out.stargazers_count = v["stargazers_count"].as_u64().unwrap_or(0) as u32;
            out.watchers_count = v["subscribers_count"].as_u64().unwrap_or(0) as u32;
            out.open_issues_count = v["open_issues_count"].as_u64().unwrap_or(0) as u32;
            out.private = v["private"].as_bool().unwrap_or(true);
        }
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

    // run_gh_raw (not run_gh): GitHub returns 200 with partial `data` plus an
    // `errors` array for unresolved refs, but gh still exits non-zero — we want
    // the partial data, so ignore the exit code and parse `data`.
    let arg = format!("query={query}");
    let out = run_gh_raw(
        None,
        &["api", "graphql", "-f", &arg],
        GH_NETWORK_TIMEOUT,
    )
    .await?;

    let mut stats = Vec::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out.stdout_lossy()) {
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

fn parse_items(out: &GhOutput, key: &str) -> Vec<TrafficItem> {
    if out.code != 0 {
        return Vec::new();
    }
    let Ok(serde_json::Value::Array(arr)) =
        serde_json::from_str::<serde_json::Value>(&out.stdout_lossy())
    else {
        return Vec::new();
    };
    arr.iter()
        .map(|x| TrafficItem {
            name: x[key].as_str().unwrap_or("").to_string(),
            title: x["title"].as_str().unwrap_or("").to_string(),
            count: x["count"].as_u64().unwrap_or(0) as u32,
            uniques: x["uniques"].as_u64().unwrap_or(0) as u32,
        })
        .collect()
}

#[tauri::command]
pub async fn gh_repo_traffic(repo_path: String) -> AppResult<RepoTraffic> {
    // Pin the origin slug so a fork reads its OWN traffic, not the parent's
    // (see `gh_community_insights`).
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    // Views gates the whole card: a non-zero exit here is the 403 (no push).
    let views = run_gh_raw(
        Some(&repo_path),
        &["api", &format!("repos/{slug}/traffic/views")],
        GH_TIMEOUT,
    )
    .await?;
    if views.code != 0 {
        return Ok(RepoTraffic::default()); // available: false
    }
    let mut out = RepoTraffic {
        available: true,
        ..Default::default()
    };
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&views.stdout_lossy()) {
        out.views_count = v["count"].as_u64().unwrap_or(0) as u32;
        out.views_uniques = v["uniques"].as_u64().unwrap_or(0) as u32;
        out.views = parse_points(&v, "views");
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
    if let Ok(c) = clones {
        if c.code == 0 {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&c.stdout_lossy()) {
                out.clones_count = v["count"].as_u64().unwrap_or(0) as u32;
                out.clones_uniques = v["uniques"].as_u64().unwrap_or(0) as u32;
                out.clones = parse_points(&v, "clones");
            }
        }
    }
    if let Ok(r) = referrers {
        out.referrers = parse_items(&r, "referrer");
    }
    if let Ok(p) = paths {
        out.paths = parse_items(&p, "path");
    }
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
    if out.code != 0 {
        return Ok(RepoDependencies::default()); // disabled / 404
    }
    let mut deps = RepoDependencies {
        available: true,
        ..Default::default()
    };
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&out.stdout_lossy()) {
        let sbom = &v["sbom"];
        // SPDXID → package name, and the relationship graph, let us split direct
        // (the repo root depends on it) from transitive dependencies.
        let mut id_to_name: std::collections::HashMap<&str, &str> =
            std::collections::HashMap::new();
        if let Some(pkgs) = sbom["packages"].as_array() {
            for p in pkgs {
                if let (Some(id), Some(name)) =
                    (p["SPDXID"].as_str(), p["name"].as_str())
                {
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
        let mut direct_names: std::collections::HashSet<&str> =
            std::collections::HashSet::new();
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
    }
    Ok(deps)
}
