//! Read side of GitHub's security surface: the repo's open Dependabot alerts and
//! its published security advisories, for the Findings tab.
//!
//! Every list rides an availability envelope. A repo with the feature off, a token
//! without access, and an unrecognized failure are all distinct from "genuinely
//! clean" — collapsing them into an empty list would tell the user they have no
//! vulnerabilities when we simply couldn't look. Only a missing `gh` binary or a
//! timeout escapes as `Err`; every completed-but-failed call is classified into
//! the envelope instead.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::github::runner::{run_gh_raw, GH_NETWORK_TIMEOUT};

/// Why a findings list may be empty. Serialized camelCase; the frontend branches
/// on these exact strings to pick between "no findings" and an explanation.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum FindingAvailability {
    /// The list is real — an empty one means no findings.
    Available,
    /// The feature is switched off for this repo.
    NotEnabled,
    /// The token can't read this surface (no admin / not authorized).
    Forbidden,
    /// The call failed in a way we can't attribute; the list is unknown, not empty.
    Indeterminate,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependabotAlertsOut {
    pub availability: FindingAvailability,
    /// The server's own explanation, verbatim, when there is one.
    pub detail: Option<String>,
    pub alerts: Vec<DependabotAlertOut>,
    /// More findings existed past the fetched window.
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependabotAlertOut {
    pub number: i64,
    pub state: String,
    pub package_name: String,
    pub ecosystem: String,
    pub manifest_path: String,
    pub scope: Option<String>,
    /// Raw GitHub severity ("critical" | "high" | "medium" | "low"), kept as a
    /// string so an unrecognized future value renders instead of being dropped.
    pub severity: String,
    pub summary: String,
    pub description: String,
    pub ghsa_id: String,
    pub cve_id: Option<String>,
    pub cvss_score: Option<f64>,
    pub vulnerable_version_range: Option<String>,
    /// `None` when no fix has shipped yet.
    pub first_patched_version: Option<String>,
    pub html_url: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoAdvisoriesOut {
    pub availability: FindingAvailability,
    pub detail: Option<String>,
    pub advisories: Vec<RepoAdvisoryOut>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoAdvisoryOut {
    pub ghsa_id: String,
    pub cve_id: Option<String>,
    pub summary: String,
    pub description: Option<String>,
    /// Nullable: a draft advisory carries no severity yet.
    pub severity: Option<String>,
    /// published | draft | triage | closed | withdrawn.
    pub state: String,
    pub html_url: String,
    pub published_at: Option<String>,
    pub updated_at: Option<String>,
    pub withdrawn_at: Option<String>,
    pub created_at: Option<String>,
    pub cvss_score: Option<f64>,
    pub vulnerabilities: Vec<AdvisoryVulnerabilityOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvisoryVulnerabilityOut {
    pub package_name: String,
    pub ecosystem: String,
    pub vulnerable_version_range: Option<String>,
    /// A plain version string on this endpoint (not Dependabot's object).
    pub patched_versions: Option<String>,
}

// ── Untrusted GitHub JSON ────────────────────────────────────────────────────
// Every field is optional so a shape change or one malformed item degrades that
// field rather than failing the whole list.

#[derive(Deserialize, Default)]
struct RawPackage {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    ecosystem: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawCvss {
    #[serde(default)]
    score: Option<f64>,
    #[serde(default)]
    vector_string: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawDependency {
    #[serde(default)]
    package: Option<RawPackage>,
    #[serde(default)]
    manifest_path: Option<String>,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawAlertAdvisory {
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    ghsa_id: Option<String>,
    #[serde(default)]
    cve_id: Option<String>,
    #[serde(default)]
    cvss: Option<RawCvss>,
}

#[derive(Deserialize, Default)]
struct RawFirstPatched {
    #[serde(default)]
    identifier: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawVulnerability {
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    vulnerable_version_range: Option<String>,
    /// Null as a whole object when no patched release exists.
    #[serde(default)]
    first_patched_version: Option<RawFirstPatched>,
}

#[derive(Deserialize, Default)]
struct RawAlert {
    #[serde(default)]
    number: i64,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    dependency: Option<RawDependency>,
    #[serde(default)]
    security_advisory: Option<RawAlertAdvisory>,
    #[serde(default)]
    security_vulnerability: Option<RawVulnerability>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawAdvisoryVulnerability {
    #[serde(default)]
    package: Option<RawPackage>,
    #[serde(default)]
    vulnerable_version_range: Option<String>,
    #[serde(default)]
    patched_versions: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawRepoAdvisory {
    #[serde(default)]
    ghsa_id: Option<String>,
    #[serde(default)]
    cve_id: Option<String>,
    #[serde(default)]
    summary: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    withdrawn_at: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    cvss: Option<RawCvss>,
    #[serde(default)]
    vulnerabilities: Option<Vec<RawAdvisoryVulnerability>>,
}

/// GitHub reports an absent CVSS as a score with a null vector (often `0.0`), so a
/// null vector reads as "no score" rather than a real zero.
fn cvss_score(cvss: Option<RawCvss>) -> Option<f64> {
    let cvss = cvss?;
    match cvss.vector_string.as_deref() {
        Some(v) if !v.is_empty() => cvss.score,
        _ => None,
    }
}

fn alert_out(raw: RawAlert) -> DependabotAlertOut {
    let dependency = raw.dependency.unwrap_or_default();
    let package = dependency.package.unwrap_or_default();
    let advisory = raw.security_advisory.unwrap_or_default();
    let vulnerability = raw.security_vulnerability.unwrap_or_default();
    DependabotAlertOut {
        number: raw.number,
        state: raw.state.unwrap_or_default(),
        package_name: package.name.unwrap_or_default(),
        ecosystem: package.ecosystem.unwrap_or_default(),
        manifest_path: dependency.manifest_path.unwrap_or_default(),
        scope: dependency.scope,
        severity: vulnerability.severity.unwrap_or_default(),
        summary: advisory.summary.unwrap_or_default(),
        description: advisory.description.unwrap_or_default(),
        ghsa_id: advisory.ghsa_id.unwrap_or_default(),
        cve_id: advisory.cve_id,
        cvss_score: cvss_score(advisory.cvss),
        vulnerable_version_range: vulnerability.vulnerable_version_range,
        first_patched_version: vulnerability
            .first_patched_version
            .and_then(|f| f.identifier),
        html_url: raw.html_url.unwrap_or_default(),
        created_at: raw.created_at.unwrap_or_default(),
        updated_at: raw.updated_at.unwrap_or_default(),
    }
}

fn advisory_out(raw: RawRepoAdvisory) -> RepoAdvisoryOut {
    RepoAdvisoryOut {
        ghsa_id: raw.ghsa_id.unwrap_or_default(),
        cve_id: raw.cve_id,
        summary: raw.summary.unwrap_or_default(),
        description: raw.description,
        severity: raw.severity,
        state: raw.state.unwrap_or_default(),
        html_url: raw.html_url.unwrap_or_default(),
        published_at: raw.published_at,
        updated_at: raw.updated_at,
        withdrawn_at: raw.withdrawn_at,
        created_at: raw.created_at,
        cvss_score: cvss_score(raw.cvss),
        vulnerabilities: raw
            .vulnerabilities
            .unwrap_or_default()
            .into_iter()
            .map(|v| {
                let package = v.package.unwrap_or_default();
                AdvisoryVulnerabilityOut {
                    package_name: package.name.unwrap_or_default(),
                    ecosystem: package.ecosystem.unwrap_or_default(),
                    vulnerable_version_range: v.vulnerable_version_range,
                    patched_versions: v.patched_versions,
                }
            })
            .collect(),
    }
}

// ── Transport ────────────────────────────────────────────────────────────────

/// Splits `gh api -i` output into (header block, body). gh prints the status line
/// and response headers ahead of the body on success AND failure, ended by a blank
/// line; output with no status line is all body.
fn split_response(out: &str) -> (&str, &str) {
    if !out.starts_with("HTTP/") {
        return ("", out);
    }
    let mut offset = 0usize;
    for line in out.split_inclusive('\n') {
        offset += line.len();
        if line.trim().is_empty() {
            return (&out[..offset], &out[offset..]);
        }
    }
    (out, "")
}

/// What a response's `Link` header says about a further page.
#[derive(Debug, PartialEq, Eq)]
enum NextPage {
    /// No `rel="next"` — this is the last page.
    None,
    /// The next page's `after` cursor.
    Cursor(String),
    /// A `rel="next"` exists but carries no readable cursor. Distinct from `None`
    /// so the walk reports an unreachable page as truncation, never completeness.
    Unreadable,
}

/// Reads the `rel="next"` Link. The cursor comes back verbatim: GitHub's is
/// already percent-encoded and re-encoding it makes the next request 4xx.
fn parse_link_next(headers: &str) -> NextPage {
    for line in headers.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("link") {
            continue;
        }
        for part in value.split(',') {
            let part = part.trim();
            if !part.contains("rel=\"next\"") {
                continue;
            }
            let cursor = part
                .split_once('<')
                .and_then(|(_, rest)| rest.split_once('>'))
                .and_then(|(url, _)| url.split_once('?'))
                .and_then(|(_, query)| query.split('&').find_map(|p| p.strip_prefix("after=")))
                .filter(|c| !c.is_empty());
            return match cursor {
                Some(c) => NextPage::Cursor(c.to_string()),
                None => NextPage::Unreadable,
            };
        }
    }
    NextPage::None
}

/// Maps a completed-but-failed gh call onto the envelope. Classified into `Ok`
/// rather than `Err` so the UI can say *why* a list is empty; an unrecognized
/// failure stays `Indeterminate` and is never presented as a clean repo.
fn classify_failure(stdout_body: &str, stderr: &str) -> (FindingAvailability, Option<String>) {
    let message = serde_json::from_str::<Value>(stdout_body.trim())
        .ok()
        .and_then(|v| {
            v.get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(str::to_string)
        });
    // gh appends its own guessed scope hint to stderr (it suggests `admin:repo_hook`
    // for a disabled-alerts 403), so the server's message wins whenever it exists.
    let detail = message.clone().or_else(|| {
        let s = stderr.trim();
        (!s.is_empty()).then(|| s.to_string())
    });
    let Some(message) = message else {
        return (FindingAvailability::Indeterminate, detail);
    };
    let lower = message.to_lowercase();
    if lower.contains("disabled") {
        (FindingAvailability::NotEnabled, detail)
    } else if lower.contains("not authorized") || lower.contains("forbidden") {
        (FindingAvailability::Forbidden, detail)
    } else {
        (FindingAvailability::Indeterminate, detail)
    }
}

/// Outcome of a bounded page walk: raw items, or a classified unavailability.
enum Fetched {
    Items {
        items: Vec<Value>,
        truncated: bool,
    },
    Unavailable {
        availability: FindingAvailability,
        detail: Option<String>,
    },
}

/// The page-walk ceiling. gh's `--paginate` is unbounded, so the walk follows the
/// Link cursor itself and stops at `limit`.
fn clamp_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(100).clamp(1, 500) as usize
}

/// Walks a cursor-paginated list endpoint up to `limit` items. `base_path` must
/// already carry a query string — the cursor is appended as `&after=`.
async fn fetch_paged(repo_path: &str, base_path: &str, limit: usize) -> AppResult<Fetched> {
    let mut items: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let path = match &cursor {
            Some(c) => format!("{base_path}&after={c}"),
            None => base_path.to_string(),
        };
        let out = run_gh_raw(Some(repo_path), &["api", "-i", &path], GH_NETWORK_TIMEOUT).await?;
        let raw = out.stdout_lossy();
        let (headers, body) = split_response(&raw);
        if out.code != 0 {
            let (availability, detail) = classify_failure(body, &out.stderr);
            return Ok(Fetched::Unavailable {
                availability,
                detail,
            });
        }
        let page: Vec<Value> = serde_json::from_str(body.trim())
            .map_err(|e| AppError::Gh(format!("could not parse security findings: {e}")))?;
        let page_len = page.len();
        let next = parse_link_next(headers);
        items.extend(page);
        if items.len() >= limit {
            let truncated = items.len() > limit || next != NextPage::None;
            items.truncate(limit);
            return Ok(Fetched::Items { items, truncated });
        }
        let c = match next {
            NextPage::None => {
                return Ok(Fetched::Items {
                    items,
                    truncated: false,
                })
            }
            // A next page we can't address ends the walk as INCOMPLETE — reporting
            // it complete would present a parse failure as "no more findings".
            NextPage::Unreadable => {
                return Ok(Fetched::Items {
                    items,
                    truncated: true,
                })
            }
            NextPage::Cursor(c) => c,
        };
        // An empty page that still advertises a next link would spin the walk.
        if page_len == 0 {
            return Ok(Fetched::Items {
                items,
                truncated: true,
            });
        }
        cursor = Some(c);
    }
}

/// The repo's OPEN Dependabot alerts.
#[tauri::command]
pub async fn gh_dependabot_alerts(
    repo_path: String,
    limit: Option<u32>,
) -> AppResult<DependabotAlertsOut> {
    // Pin the origin slug: gh's `{owner}/{repo}` placeholders resolve to the PARENT
    // on a fork with an `upstream` remote, which would list the parent's findings.
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let base = format!("repos/{slug}/dependabot/alerts?state=open&per_page=100");
    Ok(
        match fetch_paged(&repo_path, &base, clamp_limit(limit)).await? {
            Fetched::Unavailable {
                availability,
                detail,
            } => DependabotAlertsOut {
                availability,
                detail,
                alerts: Vec::new(),
                truncated: false,
            },
            Fetched::Items { items, truncated } => DependabotAlertsOut {
                availability: FindingAvailability::Available,
                detail: None,
                alerts: items
                    .into_iter()
                    .filter_map(|v| serde_json::from_value::<RawAlert>(v).ok())
                    .map(alert_out)
                    .collect(),
                truncated,
            },
        },
    )
}

/// Security advisories published on the repo itself (its own GHSAs).
#[tauri::command]
pub async fn gh_repo_advisories(
    repo_path: String,
    limit: Option<u32>,
) -> AppResult<RepoAdvisoriesOut> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let base = format!("repos/{slug}/security-advisories?per_page=100");
    Ok(
        match fetch_paged(&repo_path, &base, clamp_limit(limit)).await? {
            Fetched::Unavailable {
                availability,
                detail,
            } => RepoAdvisoriesOut {
                availability,
                detail,
                advisories: Vec::new(),
                truncated: false,
            },
            Fetched::Items { items, truncated } => RepoAdvisoriesOut {
                availability: FindingAvailability::Available,
                detail: None,
                advisories: items
                    .into_iter()
                    .filter_map(|v| serde_json::from_value::<RawRepoAdvisory>(v).ok())
                    .map(advisory_out)
                    .collect(),
                truncated,
            },
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const NEXT_LINK: &str = "Link: <https://api.github.com/repositories/1274107935/dependabot/alerts?state=open&per_page=1&after=Y3Vyc29yOnYyOpPPAAABn8sLIn7LP_UzMzMzMzPPAAAAAbgjUQg%3D>; rel=\"next\"\r\n";

    #[test]
    fn parse_link_next_reads_the_after_cursor() {
        let headers = format!("HTTP/2.0 200 OK\r\nServer: github.com\r\n{NEXT_LINK}\r\n");
        assert_eq!(
            parse_link_next(&headers),
            // Percent-encoding is preserved verbatim — re-encoding breaks the cursor.
            NextPage::Cursor("Y3Vyc29yOnYyOpPPAAABn8sLIn7LP_UzMzMzMzPPAAAAAbgjUQg%3D".into())
        );
    }

    #[test]
    fn parse_link_next_is_none_without_a_next_rel() {
        // No Link header at all (last page).
        assert_eq!(
            parse_link_next("HTTP/2.0 200 OK\r\nServer: github.com\r\n"),
            NextPage::None
        );
        // A Link header carrying only prev/first.
        let only_prev = "Link: <https://api.github.com/x?after=AAA>; rel=\"prev\", \
                         <https://api.github.com/x?before=BBB>; rel=\"first\"\r\n";
        assert_eq!(parse_link_next(only_prev), NextPage::None);
    }

    #[test]
    fn parse_link_next_flags_an_unreadable_next_link() {
        // A further page exists but can't be addressed — page-numbered instead of
        // cursored, an empty cursor, no query at all, or mangled angle brackets.
        // None of these may read as "last page": that hides findings.
        for header in [
            "Link: <https://api.github.com/x?per_page=100&page=2>; rel=\"next\"\r\n",
            "Link: <https://api.github.com/x?after=>; rel=\"next\"\r\n",
            "Link: <https://api.github.com/x>; rel=\"next\"\r\n",
            "Link: https://api.github.com/x?after=AAA; rel=\"next\"\r\n",
        ] {
            assert_eq!(parse_link_next(header), NextPage::Unreadable, "{header}");
        }
    }

    #[test]
    fn parse_link_next_picks_next_out_of_multiple_rels() {
        let headers =
            "link: <https://api.github.com/x?per_page=100&before=PREVCUR>; rel=\"prev\", \
                       <https://api.github.com/x?per_page=100&after=NEXTCUR>; rel=\"next\", \
                       <https://api.github.com/x?per_page=100&after=LASTCUR>; rel=\"last\"\r\n";
        assert_eq!(parse_link_next(headers), NextPage::Cursor("NEXTCUR".into()));
    }

    #[test]
    fn split_response_separates_headers_from_body() {
        let raw = "HTTP/2.0 200 OK\r\nServer: github.com\r\n\r\n[{\"number\":1}]";
        let (headers, body) = split_response(raw);
        assert!(headers.contains("Server: github.com"));
        assert_eq!(body, "[{\"number\":1}]");
        // Output with no status line is all body.
        assert_eq!(split_response("[]"), ("", "[]"));
    }

    #[test]
    fn classify_failure_reads_disabled_as_not_enabled() {
        let body = r#"{"message":"Dependabot alerts are disabled for this repository.","documentation_url":"https://docs.github.com/rest","status":"403"}"#;
        // gh's stderr appends a WRONG scope guess; the body message must win.
        let stderr = "gh: Dependabot alerts are disabled for this repository. (HTTP 403)\ngh: This API operation needs the \"admin:repo_hook\" scope.";
        let (availability, detail) = classify_failure(body, stderr);
        assert_eq!(availability, FindingAvailability::NotEnabled);
        assert_eq!(
            detail.as_deref(),
            Some("Dependabot alerts are disabled for this repository.")
        );
    }

    #[test]
    fn classify_failure_reads_not_authorized_as_forbidden() {
        let body =
            r#"{"message":"You are not authorized to perform this operation.","status":"403"}"#;
        let (availability, detail) = classify_failure(
            body,
            "gh: You are not authorized to perform this operation. (HTTP 403)",
        );
        assert_eq!(availability, FindingAvailability::Forbidden);
        assert_eq!(
            detail.as_deref(),
            Some("You are not authorized to perform this operation.")
        );
        // The literal word "Forbidden" classifies the same way.
        let (availability, _) = classify_failure(r#"{"message":"Forbidden"}"#, "");
        assert_eq!(availability, FindingAvailability::Forbidden);
    }

    #[test]
    fn classify_failure_keeps_unknown_failures_indeterminate() {
        // 404: absence of the endpoint is NOT proof the repo is clean.
        let (availability, detail) = classify_failure(
            r#"{"message":"Not Found","status":"404"}"#,
            "gh: Not Found (HTTP 404)",
        );
        assert_eq!(availability, FindingAvailability::Indeterminate);
        assert_eq!(detail.as_deref(), Some("Not Found"));
        // Unparseable body → indeterminate, with gh's stderr as the only detail.
        let (availability, detail) =
            classify_failure("<html>502 Bad Gateway</html>", "  gh: HTTP 502  ");
        assert_eq!(availability, FindingAvailability::Indeterminate);
        assert_eq!(detail.as_deref(), Some("gh: HTTP 502"));
        // Nothing to go on at all.
        let (availability, detail) = classify_failure("", "");
        assert_eq!(availability, FindingAvailability::Indeterminate);
        assert_eq!(detail, None);
    }

    fn alert_fixture(first_patched: Value, cvss: Value) -> Value {
        json!({
            "number": 29,
            "state": "open",
            "dependency": {
                "package": { "ecosystem": "npm", "name": "hono" },
                "manifest_path": "pnpm-lock.yaml",
                "scope": "runtime",
                "relationship": "transitive"
            },
            "security_advisory": {
                "ghsa_id": "GHSA-8j4g-w8fx-2239",
                "cve_id": "CVE-2026-69207",
                "summary": "Hono: ReDoS in CORS middleware",
                "description": "### Summary\n\nThe built-in CORS middleware…",
                "cvss": cvss
            },
            "security_vulnerability": {
                "package": { "ecosystem": "npm", "name": "hono" },
                "severity": "medium",
                "vulnerable_version_range": "< 4.12.34",
                "first_patched_version": first_patched
            },
            "html_url": "https://github.com/theBGuy/GitDesktop/security/dependabot/29",
            "created_at": "2026-08-04T04:32:12Z",
            "updated_at": "2026-08-04T04:32:12Z"
        })
    }

    #[test]
    fn alert_maps_every_field() {
        let raw: RawAlert = serde_json::from_value(alert_fixture(
            json!({ "identifier": "4.12.34" }),
            json!({ "score": 5.3, "vector_string": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L" }),
        ))
        .expect("alert fixture deserializes");
        let out = alert_out(raw);
        assert_eq!(out.number, 29);
        assert_eq!(out.state, "open");
        assert_eq!(out.package_name, "hono");
        assert_eq!(out.ecosystem, "npm");
        assert_eq!(out.manifest_path, "pnpm-lock.yaml");
        assert_eq!(out.scope.as_deref(), Some("runtime"));
        assert_eq!(out.severity, "medium");
        assert_eq!(out.summary, "Hono: ReDoS in CORS middleware");
        assert_eq!(out.ghsa_id, "GHSA-8j4g-w8fx-2239");
        assert_eq!(out.cve_id.as_deref(), Some("CVE-2026-69207"));
        assert_eq!(out.cvss_score, Some(5.3));
        assert_eq!(out.vulnerable_version_range.as_deref(), Some("< 4.12.34"));
        assert_eq!(out.first_patched_version.as_deref(), Some("4.12.34"));
        assert_eq!(
            out.html_url,
            "https://github.com/theBGuy/GitDesktop/security/dependabot/29"
        );
        assert_eq!(out.created_at, "2026-08-04T04:32:12Z");
        assert_eq!(out.updated_at, "2026-08-04T04:32:12Z");
    }

    #[test]
    fn alert_with_no_fix_reports_no_patched_version() {
        // The whole first_patched_version OBJECT is null when nothing is patched —
        // never a placeholder version, which would read as "a fix exists".
        let raw: RawAlert = serde_json::from_value(alert_fixture(
            Value::Null,
            json!({ "score": 0.0, "vector_string": Value::Null }),
        ))
        .expect("alert fixture deserializes");
        let out = alert_out(raw);
        assert_eq!(out.first_patched_version, None);
        assert_eq!(out.cvss_score, None);
    }

    #[test]
    fn alert_tolerates_a_stripped_item() {
        let raw: RawAlert =
            serde_json::from_value(json!({ "number": 7 })).expect("sparse alert deserializes");
        let out = alert_out(raw);
        assert_eq!(out.number, 7);
        assert_eq!(out.package_name, "");
        assert_eq!(out.scope, None);
        assert_eq!(out.cvss_score, None);
    }

    #[test]
    fn advisory_maps_nullable_fields() {
        let raw: RawRepoAdvisory = serde_json::from_value(json!({
            "ghsa_id": "GHSA-pj86-cfqh-vqx6",
            "cve_id": "CVE-2024-51999",
            "summary": "express vulnerable to XSS",
            "description": Value::Null,
            "severity": Value::Null,
            "state": "published",
            "html_url": "https://github.com/expressjs/express/security/advisories/GHSA-pj86-cfqh-vqx6",
            "published_at": "2025-12-01T16:24:31Z",
            "updated_at": "2025-12-01T16:24:31Z",
            "withdrawn_at": Value::Null,
            "created_at": Value::Null,
            "cvss": { "score": Value::Null, "vector_string": Value::Null },
            "vulnerabilities": [
                {
                    "package": { "ecosystem": "npm", "name": "express" },
                    "patched_versions": "4.22.0",
                    "vulnerable_version_range": "<4.22.0",
                    "vulnerable_functions": []
                },
                {
                    "package": { "ecosystem": "npm", "name": "express" },
                    "patched_versions": Value::Null,
                    "vulnerable_version_range": Value::Null
                }
            ]
        }))
        .expect("advisory fixture deserializes");
        let out = advisory_out(raw);
        assert_eq!(out.ghsa_id, "GHSA-pj86-cfqh-vqx6");
        assert_eq!(out.severity, None);
        assert_eq!(out.description, None);
        assert_eq!(out.created_at, None);
        assert_eq!(out.withdrawn_at, None);
        assert_eq!(out.published_at.as_deref(), Some("2025-12-01T16:24:31Z"));
        assert_eq!(out.cvss_score, None);
        assert_eq!(out.state, "published");
        assert_eq!(out.vulnerabilities.len(), 2);
        assert_eq!(out.vulnerabilities[0].package_name, "express");
        assert_eq!(out.vulnerabilities[0].ecosystem, "npm");
        assert_eq!(
            out.vulnerabilities[0].patched_versions.as_deref(),
            Some("4.22.0")
        );
        assert_eq!(
            out.vulnerabilities[0].vulnerable_version_range.as_deref(),
            Some("<4.22.0")
        );
        assert_eq!(out.vulnerabilities[1].patched_versions, None);
        assert_eq!(out.vulnerabilities[1].vulnerable_version_range, None);
    }

    #[test]
    fn availability_serializes_camel_case() {
        for (variant, expected) in [
            (FindingAvailability::Available, "available"),
            (FindingAvailability::NotEnabled, "notEnabled"),
            (FindingAvailability::Forbidden, "forbidden"),
            (FindingAvailability::Indeterminate, "indeterminate"),
        ] {
            assert_eq!(serde_json::to_value(variant).unwrap(), json!(expected));
        }
    }

    #[test]
    fn alerts_envelope_wire_shape_is_pinned() {
        // The TS mirror reads these exact keys; a casing drift reaches the UI as
        // `undefined` rather than a compile error.
        let raw: RawAlert = serde_json::from_value(alert_fixture(
            json!({ "identifier": "4.12.34" }),
            json!({ "score": 5.3, "vector_string": "CVSS:3.1/AV:N" }),
        ))
        .unwrap();
        let envelope = DependabotAlertsOut {
            availability: FindingAvailability::Available,
            detail: None,
            alerts: vec![alert_out(raw)],
            truncated: true,
        };
        assert_eq!(
            serde_json::to_value(&envelope).unwrap(),
            json!({
                "availability": "available",
                "detail": Value::Null,
                "truncated": true,
                "alerts": [{
                    "number": 29,
                    "state": "open",
                    "packageName": "hono",
                    "ecosystem": "npm",
                    "manifestPath": "pnpm-lock.yaml",
                    "scope": "runtime",
                    "severity": "medium",
                    "summary": "Hono: ReDoS in CORS middleware",
                    "description": "### Summary\n\nThe built-in CORS middleware…",
                    "ghsaId": "GHSA-8j4g-w8fx-2239",
                    "cveId": "CVE-2026-69207",
                    "cvssScore": 5.3,
                    "vulnerableVersionRange": "< 4.12.34",
                    "firstPatchedVersion": "4.12.34",
                    "htmlUrl": "https://github.com/theBGuy/GitDesktop/security/dependabot/29",
                    "createdAt": "2026-08-04T04:32:12Z",
                    "updatedAt": "2026-08-04T04:32:12Z"
                }]
            })
        );
    }

    #[test]
    fn advisories_envelope_wire_shape_is_pinned() {
        let envelope = RepoAdvisoriesOut {
            availability: FindingAvailability::NotEnabled,
            detail: Some("Dependabot alerts are disabled for this repository.".into()),
            advisories: vec![RepoAdvisoryOut {
                ghsa_id: "GHSA-pj86-cfqh-vqx6".into(),
                cve_id: None,
                summary: "express vulnerable to XSS".into(),
                description: None,
                severity: Some("low".into()),
                state: "published".into(),
                html_url: "https://github.com/expressjs/express/security/advisories/x".into(),
                published_at: Some("2025-12-01T16:24:31Z".into()),
                updated_at: None,
                withdrawn_at: None,
                created_at: None,
                cvss_score: Some(3.1),
                vulnerabilities: vec![AdvisoryVulnerabilityOut {
                    package_name: "express".into(),
                    ecosystem: "npm".into(),
                    vulnerable_version_range: Some("<4.22.0".into()),
                    patched_versions: Some("4.22.0".into()),
                }],
            }],
            truncated: false,
        };
        assert_eq!(
            serde_json::to_value(&envelope).unwrap(),
            json!({
                "availability": "notEnabled",
                "detail": "Dependabot alerts are disabled for this repository.",
                "truncated": false,
                "advisories": [{
                    "ghsaId": "GHSA-pj86-cfqh-vqx6",
                    "cveId": Value::Null,
                    "summary": "express vulnerable to XSS",
                    "description": Value::Null,
                    "severity": "low",
                    "state": "published",
                    "htmlUrl": "https://github.com/expressjs/express/security/advisories/x",
                    "publishedAt": "2025-12-01T16:24:31Z",
                    "updatedAt": Value::Null,
                    "withdrawnAt": Value::Null,
                    "createdAt": Value::Null,
                    "cvssScore": 3.1,
                    "vulnerabilities": [{
                        "packageName": "express",
                        "ecosystem": "npm",
                        "vulnerableVersionRange": "<4.22.0",
                        "patchedVersions": "4.22.0"
                    }]
                }]
            })
        );
    }

    #[test]
    fn limit_is_clamped_to_a_bounded_window() {
        assert_eq!(clamp_limit(None), 100);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(42)), 42);
        assert_eq!(clamp_limit(Some(10_000)), 500);
    }
}
