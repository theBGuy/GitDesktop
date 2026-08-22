//! Read side of GitHub's security surface for the Findings tab: the repo's open
//! Dependabot, code scanning and secret scanning alerts, plus its published
//! security advisories.
//!
//! Every list rides an availability envelope. A repo with the feature off, a token
//! without access, and an unrecognized failure are all distinct from "genuinely
//! clean" — collapsing them into an empty list would tell the user they have no
//! vulnerabilities when we simply couldn't look. Only a missing `gh` binary or a
//! timeout escapes as `Err`; every completed-but-failed call is classified into
//! the envelope instead.

use serde::{de::DeserializeOwned, Deserialize, Serialize};
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
    /// No analysis has ever run: the first scan may still be in flight, or scanning
    /// was never configured. Distinct from `NotEnabled`, which the server asserts.
    NoResultsYet,
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
    /// GitHub's dependency relationship ("direct" | "transitive"), verbatim so an
    /// unrecognized value renders instead of being dropped.
    pub relationship: Option<String>,
    /// v3 before v4 when the advisory carries both; empty when it scores neither.
    pub cvss: Vec<CvssOut>,
    pub references: Vec<ReferenceOut>,
    pub cwes: Vec<CweOut>,
    pub vulnerable_version_range: Option<String>,
    /// `None` when no fix has shipped yet.
    pub first_patched_version: Option<String>,
    pub html_url: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CvssOut {
    /// Read off the vector's own prefix ("3.1", "4.0"); empty when the vector
    /// carries no recognizable one, since the slot alone can't name the revision.
    pub version: String,
    pub score: Option<f64>,
    pub vector_string: String,
    /// Decoded base metrics in canonical order; empty when the vector is foreign,
    /// which is the view's cue to fall back to the raw string.
    pub metrics: Vec<CvssMetricOut>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CvssMetricOut {
    pub label: String,
    pub value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceOut {
    pub url: String,
    /// Derived here: the wire carries a bare URL with no title.
    pub label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CweOut {
    pub cwe_id: String,
    pub name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeScanningAlertsOut {
    pub availability: FindingAvailability,
    pub detail: Option<String>,
    pub alerts: Vec<CodeScanningAlertOut>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeScanningAlertOut {
    pub number: i64,
    pub state: String,
    pub rule_id: String,
    pub rule_name: Option<String>,
    pub rule_description: Option<String>,
    /// The SARIF level ("note" | "warning" | "error"), raw — it is a different
    /// scale from `security_severity` and collapsing the two mislabels findings.
    pub severity: Option<String>,
    /// `rule.security_severity_level` ("low" … "critical"), raw.
    pub security_severity: Option<String>,
    pub tool_name: String,
    pub tool_version: Option<String>,
    pub path: String,
    pub start_line: Option<i64>,
    pub message: String,
    /// The ref the alert was last seen on. `ref` is a Rust keyword, so the wire
    /// key is pinned by hand.
    #[serde(rename = "ref")]
    pub git_ref: Option<String>,
    pub html_url: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretScanningAlertsOut {
    pub availability: FindingAvailability,
    pub detail: Option<String>,
    pub alerts: Vec<SecretScanningAlertOut>,
    pub truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretScanningAlertOut {
    pub number: i64,
    pub state: String,
    pub secret_type: String,
    pub secret_type_display_name: String,
    /// active | inactive | unknown, raw.
    pub validity: Option<String>,
    pub publicly_leaked: Option<bool>,
    // No `resolution`: the fetch pins `state=open`, so it is always null here.
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

#[derive(Deserialize, Default, Clone)]
struct RawCvss {
    #[serde(default)]
    score: Option<f64>,
    #[serde(default)]
    vector_string: Option<String>,
}

/// The per-revision scores. `cvss_v3` restates the legacy `cvss` field, which is
/// the fallback for repos whose payload predates this object.
#[derive(Deserialize, Default)]
struct RawCvssSeverities {
    #[serde(default)]
    cvss_v3: Option<RawCvss>,
    #[serde(default)]
    cvss_v4: Option<RawCvss>,
}

#[derive(Deserialize, Default)]
struct RawReference {
    #[serde(default)]
    url: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawCwe {
    #[serde(default)]
    cwe_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawDependency {
    #[serde(default)]
    package: Option<RawPackage>,
    #[serde(default)]
    manifest_path: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    relationship: Option<String>,
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
    #[serde(default)]
    cvss_severities: Option<RawCvssSeverities>,
    #[serde(default)]
    references: Option<Vec<RawReference>>,
    #[serde(default)]
    cwes: Option<Vec<RawCwe>>,
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
    number: Option<i64>,
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

#[derive(Deserialize, Default)]
struct RawCodeScanningRule {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    security_severity_level: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawCodeScanningTool {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    version: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawInstanceMessage {
    #[serde(default)]
    text: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawInstanceLocation {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    start_line: Option<i64>,
}

#[derive(Deserialize, Default)]
struct RawCodeScanningInstance {
    #[serde(default, rename = "ref")]
    git_ref: Option<String>,
    #[serde(default)]
    message: Option<RawInstanceMessage>,
    #[serde(default)]
    location: Option<RawInstanceLocation>,
}

#[derive(Deserialize, Default)]
struct RawCodeScanningAlert {
    #[serde(default)]
    number: Option<i64>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    rule: Option<RawCodeScanningRule>,
    #[serde(default)]
    tool: Option<RawCodeScanningTool>,
    #[serde(default)]
    most_recent_instance: Option<RawCodeScanningInstance>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawSecretScanningAlert {
    #[serde(default)]
    number: Option<i64>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    secret_type: Option<String>,
    #[serde(default)]
    secret_type_display_name: Option<String>,
    #[serde(default)]
    validity: Option<String>,
    #[serde(default)]
    publicly_leaked: Option<bool>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
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

/// One base metric: its key, its full label, and the letters it defines. Values
/// outside the list pass through raw — inventing a label would misstate the score.
type MetricSpec = (
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
);

const NONE_LOW_HIGH: &[(&str, &str)] = &[("N", "None"), ("L", "Low"), ("H", "High")];
const ATTACK_VECTOR: &[(&str, &str)] = &[
    ("N", "Network"),
    ("A", "Adjacent"),
    ("L", "Local"),
    ("P", "Physical"),
];
const LOW_HIGH: &[(&str, &str)] = &[("L", "Low"), ("H", "High")];

/// CVSS v3 base metrics in the order GitHub's own table shows them.
const CVSS_V3_BASE: &[MetricSpec] = &[
    ("AV", "Attack vector", ATTACK_VECTOR),
    ("AC", "Attack complexity", LOW_HIGH),
    ("PR", "Privileges required", NONE_LOW_HIGH),
    (
        "UI",
        "User interaction",
        &[("N", "None"), ("R", "Required")],
    ),
    ("S", "Scope", &[("U", "Unchanged"), ("C", "Changed")]),
    ("C", "Confidentiality", NONE_LOW_HIGH),
    ("I", "Integrity", NONE_LOW_HIGH),
    ("A", "Availability", NONE_LOW_HIGH),
];

/// CVSS v4 base metrics. v4 renames the impact metrics and adds attack
/// requirements, so a v3 table applied to a v4 vector would mislabel it.
const CVSS_V4_BASE: &[MetricSpec] = &[
    ("AV", "Attack vector", ATTACK_VECTOR),
    ("AC", "Attack complexity", LOW_HIGH),
    (
        "AT",
        "Attack requirements",
        &[("N", "None"), ("P", "Present")],
    ),
    ("PR", "Privileges required", NONE_LOW_HIGH),
    (
        "UI",
        "User interaction",
        &[("N", "None"), ("P", "Passive"), ("A", "Active")],
    ),
    ("VC", "Vulnerable system confidentiality", NONE_LOW_HIGH),
    ("VI", "Vulnerable system integrity", NONE_LOW_HIGH),
    ("VA", "Vulnerable system availability", NONE_LOW_HIGH),
    ("SC", "Subsequent system confidentiality", NONE_LOW_HIGH),
    ("SI", "Subsequent system integrity", NONE_LOW_HIGH),
    ("SA", "Subsequent system availability", NONE_LOW_HIGH),
];

/// The revision a vector declares, e.g. `CVSS:3.1/…` → `3.1`. Empty for anything
/// else, since only the vector distinguishes 3.0 from 3.1.
fn cvss_version(vector: &str) -> String {
    vector
        .split('/')
        .next()
        .and_then(|prefix| prefix.strip_prefix("CVSS:"))
        .unwrap_or_default()
        .to_string()
}

/// Decodes a vector's BASE metrics only — temporal, threat and environmental
/// tokens carry no key in the tables above and are skipped, as is a foreign
/// prefix, which yields no metrics at all rather than v3-labelled nonsense.
fn cvss_metrics(vector: &str) -> Vec<CvssMetricOut> {
    let mut parts = vector.split('/');
    let table = match parts.next() {
        Some("CVSS:3.0" | "CVSS:3.1") => CVSS_V3_BASE,
        Some("CVSS:4.0") => CVSS_V4_BASE,
        _ => return Vec::new(),
    };
    let tokens: Vec<(&str, &str)> = parts.filter_map(|p| p.split_once(':')).collect();
    let mut metrics = Vec::new();
    for &(key, label, values) in table {
        let Some(raw) = tokens
            .iter()
            .find(|(k, _)| *k == key)
            .map(|&(_, v)| v)
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        let value = values
            .iter()
            .find(|(letter, _)| *letter == raw)
            .map_or(raw, |&(_, name)| name);
        metrics.push(CvssMetricOut {
            label: label.to_string(),
            value: value.to_string(),
        });
    }
    metrics
}

/// One scored revision, or nothing: a null/empty vector means GitHub has no score
/// here, and its companion `score` (often `0.0`) is not a real zero.
fn cvss_out(cvss: RawCvss) -> Option<CvssOut> {
    let vector = cvss.vector_string.filter(|v| !v.is_empty())?;
    Some(CvssOut {
        version: cvss_version(&vector),
        score: cvss.score,
        metrics: cvss_metrics(&vector),
        vector_string: vector,
    })
}

/// The advisory's scores, v3 first. The legacy `cvss` field stands in for a v3
/// entry the newer `cvss_severities` object doesn't carry.
fn cvss_list(severities: Option<RawCvssSeverities>, legacy: Option<RawCvss>) -> Vec<CvssOut> {
    let severities = severities.unwrap_or_default();
    let v3_slot_is_legacy = severities.cvss_v3.is_none();
    let mut list: Vec<CvssOut> = [severities.cvss_v3.or(legacy), severities.cvss_v4]
        .into_iter()
        .flatten()
        .filter_map(cvss_out)
        .collect();
    // The legacy field names no revision, so on a v4-only advisory it can restate
    // the v4 vector and list the same score twice. `cvss_severities` is the
    // authoritative source when the two collide.
    if list.len() == 2 && list[0].version == list[1].version {
        list.remove(if v3_slot_is_legacy { 0 } else { 1 });
    }
    list
}

/// Splits a URL into its lowercased host (no `www.`, userinfo or port) and its
/// path. `None` when there is no scheme-delimited authority to read.
fn split_url(url: &str) -> Option<(String, &str)> {
    let after_scheme = url.split_once("://")?.1;
    let hierarchical = after_scheme
        .split_at(after_scheme.find(['?', '#']).unwrap_or(after_scheme.len()))
        .0;
    let (authority, path) =
        hierarchical.split_at(hierarchical.find('/').unwrap_or(hierarchical.len()));
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    // A bracketed IPv6 literal carries its own colons, so its span is taken before
    // the port strip; `www.` can never prefix one.
    let bare = match crate::forge::bracketed_split(host) {
        // Only a `:port` may follow the span; any other suffix is no authority.
        Some((_, suffix)) if !suffix.is_empty() && !suffix.starts_with(':') => return None,
        Some((span, _)) => span,
        None => host.split_once(':').map_or(host, |(h, _)| h),
    };
    // Case-fold before stripping `www.`: hosts are case-insensitive, so an
    // upper-case prefix has to fall away too.
    let lower = bare.to_ascii_lowercase();
    let host = lower.strip_prefix("www.").unwrap_or(&lower);
    (!host.is_empty()).then(|| (host.to_string(), path))
}

/// A short label for a bare reference URL — GitHub sends no title, and an
/// unlabelled link is unreadable in the detail pane.
fn reference_label(url: &str) -> String {
    let Some((host, path)) = split_url(url) else {
        return url.to_string();
    };
    if host == "nvd.nist.gov" {
        return "NVD".to_string();
    }
    if host != "github.com" {
        return host;
    }
    let is_ghsa = path.split('/').any(|seg| {
        seg.as_bytes()
            .get(..5)
            .is_some_and(|p| p.eq_ignore_ascii_case(b"GHSA-"))
    });
    if path.contains("/commit/") {
        "Commit".to_string()
    } else if path.contains("/releases/tag/") {
        "Release".to_string()
    } else if path.contains("/advisories/") || is_ghsa {
        "Advisory".to_string()
    } else if path.contains("/pull/") {
        "Pull request".to_string()
    } else if path.contains("/issues/") {
        "Issue".to_string()
    } else {
        host
    }
}

/// Drops anything that isn't an http(s) link. An advisory's references are
/// community-contributed, and this row renders as an openable link — no other
/// scheme has a meaning here worth handing to the opener.
fn references_out(raw: Option<Vec<RawReference>>) -> Vec<ReferenceOut> {
    raw.unwrap_or_default()
        .into_iter()
        .filter_map(|r| r.url)
        .filter(|u| {
            let lower = u.to_ascii_lowercase();
            lower.starts_with("http://") || lower.starts_with("https://")
        })
        .map(|url| ReferenceOut {
            label: reference_label(&url),
            url,
        })
        .collect()
}

/// Drops entries with no CWE id — the id is the row's identity and its link target.
fn cwes_out(raw: Option<Vec<RawCwe>>) -> Vec<CweOut> {
    raw.unwrap_or_default()
        .into_iter()
        .filter_map(|c| {
            let cwe_id = c.cwe_id.filter(|id| !id.is_empty())?;
            Some(CweOut {
                cwe_id,
                name: c.name.unwrap_or_default(),
            })
        })
        .collect()
}

fn alert_out(raw: RawAlert) -> DependabotAlertOut {
    let dependency = raw.dependency.unwrap_or_default();
    let package = dependency.package.unwrap_or_default();
    let advisory = raw.security_advisory.unwrap_or_default();
    let vulnerability = raw.security_vulnerability.unwrap_or_default();
    DependabotAlertOut {
        // A null/absent number degrades to 0 rather than dropping the alert; the
        // UI's identity falls back to the list index.
        number: raw.number.unwrap_or(0),
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
        cvss_score: cvss_score(advisory.cvss.clone()),
        relationship: dependency.relationship,
        cvss: cvss_list(advisory.cvss_severities, advisory.cvss),
        references: references_out(advisory.references),
        cwes: cwes_out(advisory.cwes),
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

fn code_scanning_alert_out(raw: RawCodeScanningAlert) -> CodeScanningAlertOut {
    let rule = raw.rule.unwrap_or_default();
    let tool = raw.tool.unwrap_or_default();
    let instance = raw.most_recent_instance.unwrap_or_default();
    let location = instance.location.unwrap_or_default();
    CodeScanningAlertOut {
        number: raw.number.unwrap_or(0),
        state: raw.state.unwrap_or_default(),
        rule_id: rule.id.unwrap_or_default(),
        rule_name: rule.name,
        rule_description: rule.description,
        severity: rule.severity,
        security_severity: rule.security_severity_level,
        tool_name: tool.name.unwrap_or_default(),
        tool_version: tool.version,
        path: location.path.unwrap_or_default(),
        start_line: location.start_line,
        message: instance.message.and_then(|m| m.text).unwrap_or_default(),
        git_ref: instance.git_ref,
        html_url: raw.html_url.unwrap_or_default(),
        created_at: raw.created_at.unwrap_or_default(),
        updated_at: raw.updated_at.unwrap_or_default(),
    }
}

fn secret_scanning_alert_out(raw: RawSecretScanningAlert) -> SecretScanningAlertOut {
    SecretScanningAlertOut {
        number: raw.number.unwrap_or(0),
        state: raw.state.unwrap_or_default(),
        secret_type: raw.secret_type.unwrap_or_default(),
        secret_type_display_name: raw.secret_type_display_name.unwrap_or_default(),
        validity: raw.validity,
        publicly_leaked: raw.publicly_leaked,
        html_url: raw.html_url.unwrap_or_default(),
        created_at: raw.created_at.unwrap_or_default(),
        updated_at: raw.updated_at.unwrap_or_default(),
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
    // "no analysis found" is weaker than the other two: a repo mid-first-scan and a
    // repo that never configured scanning both answer it, so it can't claim the
    // feature is off the way an explicit "disabled"/"not enabled" body does.
    if lower.contains("no analysis found") {
        (FindingAvailability::NoResultsYet, detail)
    } else if lower.contains("disabled") || lower.contains("not enabled") {
        (FindingAvailability::NotEnabled, detail)
    } else if lower.contains("not authorized")
        || lower.contains("forbidden")
        || lower.contains("not accessible")
        || lower.contains("must have admin")
    {
        // The scanning endpoints refuse an under-scoped token in their own words
        // ("Resource not accessible by…", "You must have admin permissions to…");
        // as Indeterminate they would offer a Retry that can never succeed.
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
        /// The response's status code when the status line was readable; arm-level
        /// rules need it to tell a bare 404 from a same-worded failure.
        status: Option<u16>,
    },
}

/// The status code off gh's echoed status line (`HTTP/2.0 404 Not Found`).
fn parse_status(headers: &str) -> Option<u16> {
    headers
        .lines()
        .next()?
        .strip_prefix("HTTP/")?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// The page-walk ceiling. gh's `--paginate` is unbounded, so the walk follows the
/// Link cursor itself and stops at `limit`.
fn clamp_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(100).clamp(1, 500) as usize
}

/// Whether the page walk keeps going, and if not whether findings were left behind.
/// `Continue` carries the cursor, so only an addressable next page can resume it.
#[derive(Debug, PartialEq, Eq)]
enum PageOutcome {
    Stop { truncated: bool },
    Continue(String),
}

/// The walk's per-page decision, given the items gathered so far and this page's
/// size and Link header. Truncation is the safe direction: every stop we can't
/// prove complete reports `truncated`, never a clean end of list.
fn page_outcome(total: usize, limit: usize, page_len: usize, next: NextPage) -> PageOutcome {
    if total >= limit {
        return PageOutcome::Stop {
            truncated: total > limit || next != NextPage::None,
        };
    }
    match next {
        NextPage::None => PageOutcome::Stop { truncated: false },
        // A next page we can't address ends the walk as INCOMPLETE — reporting
        // it complete would present a parse failure as "no more findings".
        NextPage::Unreadable => PageOutcome::Stop { truncated: true },
        // An empty page that still advertises a next link would spin the walk.
        NextPage::Cursor(_) if page_len == 0 => PageOutcome::Stop { truncated: true },
        NextPage::Cursor(c) => PageOutcome::Continue(c),
    }
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
                status: parse_status(headers),
            });
        }
        let page: Vec<Value> = serde_json::from_str(body.trim())
            .map_err(|e| AppError::Gh(format!("could not parse security findings: {e}")))?;
        let page_len = page.len();
        let next = parse_link_next(headers);
        items.extend(page);
        match page_outcome(items.len(), limit, page_len, next) {
            PageOutcome::Stop { truncated } => {
                items.truncate(limit);
                return Ok(Fetched::Items { items, truncated });
            }
            PageOutcome::Continue(c) => cursor = Some(c),
        }
    }
}

/// Survivors of deserializing the whole fetched window, or its size when nothing
/// survived — classification spans the walk's items, not one page.
enum ParsedItems<T> {
    Items(Vec<T>),
    AllUnreadable(usize),
}

/// Drops individually malformed items, but keeps a window that parsed away entirely
/// distinguishable: an empty `Available` list would tell the user the repo is clean
/// when we simply couldn't read what GitHub sent.
fn parse_items<T: DeserializeOwned>(items: Vec<Value>) -> ParsedItems<T> {
    let total = items.len();
    let parsed: Vec<T> = items
        .into_iter()
        .filter_map(|v| serde_json::from_value::<T>(v).ok())
        .collect();
    if total > 0 && parsed.is_empty() {
        ParsedItems::AllUnreadable(total)
    } else {
        ParsedItems::Items(parsed)
    }
}

fn alerts_envelope(fetched: Fetched) -> DependabotAlertsOut {
    match fetched {
        Fetched::Unavailable {
            availability,
            detail,
            ..
        } => DependabotAlertsOut {
            availability,
            detail,
            alerts: Vec::new(),
            truncated: false,
        },
        Fetched::Items { items, truncated } => match parse_items::<RawAlert>(items) {
            ParsedItems::Items(raw) => DependabotAlertsOut {
                availability: FindingAvailability::Available,
                detail: None,
                alerts: raw.into_iter().map(alert_out).collect(),
                truncated,
            },
            ParsedItems::AllUnreadable(total) => DependabotAlertsOut {
                availability: FindingAvailability::Indeterminate,
                detail: Some(format!(
                    "GitHub returned {total} {} this build couldn't read",
                    if total == 1 { "alert" } else { "alerts" }
                )),
                alerts: Vec::new(),
                truncated: false,
            },
        },
    }
}

/// Repository advisories exist only on public repos; a private one answers the
/// endpoint with a bare `404 Not Found`, which the generic classifier can only
/// read as an error. Scoped to this arm — elsewhere a 404 stays indeterminate.
fn advisories_availability(
    availability: FindingAvailability,
    detail: Option<&str>,
    status: Option<u16>,
) -> FindingAvailability {
    if availability == FindingAvailability::Indeterminate
        && status == Some(404)
        && detail == Some("Not Found")
    {
        return FindingAvailability::NotEnabled;
    }
    availability
}

fn advisories_envelope(fetched: Fetched) -> RepoAdvisoriesOut {
    match fetched {
        Fetched::Unavailable {
            availability,
            detail,
            status,
        } => RepoAdvisoriesOut {
            availability: advisories_availability(availability, detail.as_deref(), status),
            detail,
            advisories: Vec::new(),
            truncated: false,
        },
        Fetched::Items { items, truncated } => match parse_items::<RawRepoAdvisory>(items) {
            ParsedItems::Items(raw) => RepoAdvisoriesOut {
                availability: FindingAvailability::Available,
                detail: None,
                advisories: raw.into_iter().map(advisory_out).collect(),
                truncated,
            },
            ParsedItems::AllUnreadable(total) => RepoAdvisoriesOut {
                availability: FindingAvailability::Indeterminate,
                detail: Some(format!(
                    "GitHub returned {total} {} this build couldn't read",
                    if total == 1 { "advisory" } else { "advisories" }
                )),
                advisories: Vec::new(),
                truncated: false,
            },
        },
    }
}

fn code_scanning_envelope(fetched: Fetched) -> CodeScanningAlertsOut {
    match fetched {
        Fetched::Unavailable {
            availability,
            detail,
            ..
        } => CodeScanningAlertsOut {
            availability,
            detail,
            alerts: Vec::new(),
            truncated: false,
        },
        Fetched::Items { items, truncated } => match parse_items::<RawCodeScanningAlert>(items) {
            ParsedItems::Items(raw) => CodeScanningAlertsOut {
                availability: FindingAvailability::Available,
                detail: None,
                alerts: raw.into_iter().map(code_scanning_alert_out).collect(),
                truncated,
            },
            ParsedItems::AllUnreadable(total) => CodeScanningAlertsOut {
                availability: FindingAvailability::Indeterminate,
                detail: Some(format!(
                    "GitHub returned {total} {} this build couldn't read",
                    if total == 1 { "alert" } else { "alerts" }
                )),
                alerts: Vec::new(),
                truncated: false,
            },
        },
    }
}

fn secret_scanning_envelope(fetched: Fetched) -> SecretScanningAlertsOut {
    match fetched {
        Fetched::Unavailable {
            availability,
            detail,
            ..
        } => SecretScanningAlertsOut {
            availability,
            detail,
            alerts: Vec::new(),
            truncated: false,
        },
        Fetched::Items { items, truncated } => match parse_items::<RawSecretScanningAlert>(items) {
            ParsedItems::Items(raw) => SecretScanningAlertsOut {
                availability: FindingAvailability::Available,
                detail: None,
                alerts: raw.into_iter().map(secret_scanning_alert_out).collect(),
                truncated,
            },
            ParsedItems::AllUnreadable(total) => SecretScanningAlertsOut {
                availability: FindingAvailability::Indeterminate,
                detail: Some(format!(
                    "GitHub returned {total} {} this build couldn't read",
                    if total == 1 { "alert" } else { "alerts" }
                )),
                alerts: Vec::new(),
                truncated: false,
            },
        },
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
    let fetched = fetch_paged(&repo_path, &base, clamp_limit(limit)).await?;
    Ok(alerts_envelope(fetched))
}

/// Security advisories published on the repo itself (its own GHSAs).
#[tauri::command]
pub async fn gh_repo_advisories(
    repo_path: String,
    limit: Option<u32>,
) -> AppResult<RepoAdvisoriesOut> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let base = format!("repos/{slug}/security-advisories?per_page=100");
    let fetched = fetch_paged(&repo_path, &base, clamp_limit(limit)).await?;
    Ok(advisories_envelope(fetched))
}

/// The repo's OPEN code scanning alerts.
#[tauri::command]
pub async fn gh_code_scanning_alerts(
    repo_path: String,
    limit: Option<u32>,
) -> AppResult<CodeScanningAlertsOut> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    let base = format!("repos/{slug}/code-scanning/alerts?state=open&per_page=100");
    let fetched = fetch_paged(&repo_path, &base, clamp_limit(limit)).await?;
    Ok(code_scanning_envelope(fetched))
}

/// The repo's OPEN secret scanning alerts.
#[tauri::command]
pub async fn gh_secret_scanning_alerts(
    repo_path: String,
    limit: Option<u32>,
) -> AppResult<SecretScanningAlertsOut> {
    let slug = crate::github::gh_origin_slug(&repo_path).await?;
    // `hide_secret` keeps the literal leaked credential out of the response, so it
    // never reaches this process's memory or gh's logging — the app only ever needs
    // the alert's metadata.
    let base =
        format!("repos/{slug}/secret-scanning/alerts?state=open&per_page=100&hide_secret=true");
    let fetched = fetch_paged(&repo_path, &base, clamp_limit(limit)).await?;
    Ok(secret_scanning_envelope(fetched))
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
            (FindingAvailability::NoResultsYet, "noResultsYet"),
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
                    "relationship": "transitive",
                    "cvss": [{
                        "version": "3.1",
                        "score": 5.3,
                        "vectorString": "CVSS:3.1/AV:N",
                        "metrics": [{ "label": "Attack vector", "value": "Network" }]
                    }],
                    "references": [],
                    "cwes": [],
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

    fn readable_alert() -> Value {
        alert_fixture(
            json!({ "identifier": "4.12.34" }),
            json!({ "score": 5.3, "vector_string": "CVSS:3.1/AV:N" }),
        )
    }

    #[test]
    fn a_page_that_parses_away_entirely_is_indeterminate() {
        // Every item unreadable must NOT render as "no open alerts" — that is the
        // clean-repo lie the envelope exists to prevent.
        let out = alerts_envelope(Fetched::Items {
            items: vec![json!("not an object"), json!(42)],
            truncated: false,
        });
        assert_eq!(out.availability, FindingAvailability::Indeterminate);
        assert_eq!(
            out.detail.as_deref(),
            Some("GitHub returned 2 alerts this build couldn't read")
        );
        assert!(out.alerts.is_empty());

        let out = advisories_envelope(Fetched::Items {
            items: vec![json!("not an object")],
            truncated: false,
        });
        assert_eq!(out.availability, FindingAvailability::Indeterminate);
        assert_eq!(
            out.detail.as_deref(),
            Some("GitHub returned 1 advisory this build couldn't read")
        );
        assert!(out.advisories.is_empty());

        // A genuinely empty page is still the real, available answer.
        let out = alerts_envelope(Fetched::Items {
            items: Vec::new(),
            truncated: false,
        });
        assert_eq!(out.availability, FindingAvailability::Available);
        assert_eq!(out.detail, None);
    }

    #[test]
    fn a_partly_unreadable_page_keeps_the_survivors() {
        let out = alerts_envelope(Fetched::Items {
            items: vec![json!("not an object"), readable_alert()],
            truncated: true,
        });
        assert_eq!(out.availability, FindingAvailability::Available);
        assert_eq!(out.detail, None);
        assert_eq!(out.alerts.len(), 1);
        assert_eq!(out.alerts[0].number, 29);
        assert!(out.truncated);
    }

    #[test]
    fn an_alert_with_a_null_number_is_kept() {
        // `serde(default)` covers a MISSING key, not a null — a required i64 would
        // drop the whole alert over its identity field.
        let mut item = readable_alert();
        item["number"] = Value::Null;
        let out = alerts_envelope(Fetched::Items {
            items: vec![item],
            truncated: false,
        });
        assert_eq!(out.availability, FindingAvailability::Available);
        assert_eq!(out.alerts.len(), 1);
        assert_eq!(out.alerts[0].number, 0);
        assert_eq!(out.alerts[0].package_name, "hono");
    }

    #[test]
    fn page_outcome_stops_at_the_limit() {
        // A full window with a further page is truncated; without one it is complete.
        assert_eq!(
            page_outcome(5, 5, 5, NextPage::Cursor("C".into())),
            PageOutcome::Stop { truncated: true }
        );
        assert_eq!(
            page_outcome(5, 5, 5, NextPage::None),
            PageOutcome::Stop { truncated: false }
        );
        // Overshooting the window is truncation on its own.
        assert_eq!(
            page_outcome(7, 5, 7, NextPage::None),
            PageOutcome::Stop { truncated: true }
        );
    }

    #[test]
    fn page_outcome_stops_short_without_claiming_completeness() {
        // An unaddressable next page, and an empty page still advertising a cursor
        // (which would spin the walk), both end it as incomplete.
        assert_eq!(
            page_outcome(2, 5, 2, NextPage::Unreadable),
            PageOutcome::Stop { truncated: true }
        );
        assert_eq!(
            page_outcome(2, 5, 0, NextPage::Cursor("C".into())),
            PageOutcome::Stop { truncated: true }
        );
    }

    #[test]
    fn page_outcome_continues_under_the_limit_and_ends_clean() {
        assert_eq!(
            page_outcome(2, 5, 2, NextPage::Cursor("C".into())),
            // The cursor rides the outcome, so the walk can't resume on anything else.
            PageOutcome::Continue("C".into())
        );
        assert_eq!(
            page_outcome(2, 5, 2, NextPage::None),
            PageOutcome::Stop { truncated: false }
        );
    }

    #[test]
    fn classify_failure_reads_code_scanning_off_as_not_enabled() {
        // Measured against a private repo with code scanning off (403). "not enabled"
        // is code scanning's own wording — nothing in it says "disabled".
        let (availability, detail) = classify_failure(
            r#"{"message":"Code scanning is not enabled for this repository. Please enable code scanning in the repository settings."}"#,
            "gh: Code scanning is not enabled for this repository. (HTTP 403)",
        );
        assert_eq!(availability, FindingAvailability::NotEnabled);
        assert_eq!(
            detail.as_deref(),
            Some("Code scanning is not enabled for this repository. Please enable code scanning in the repository settings.")
        );
    }

    #[test]
    fn classify_failure_reads_no_analysis_as_no_results_yet() {
        // Measured on a public repo whose scanning has never produced an analysis
        // (404). A repo mid-first-scan answers the same, so this is NOT proof the
        // feature is off — the two states need different copy.
        let (availability, detail) =
            classify_failure(r#"{"message":"no analysis found"}"#, "gh: HTTP 404");
        assert_eq!(availability, FindingAvailability::NoResultsYet);
        assert_eq!(detail.as_deref(), Some("no analysis found"));
    }

    #[test]
    fn classify_failure_reads_secret_scanning_off_as_not_enabled() {
        let (availability, detail) = classify_failure(
            r#"{"message":"Secret scanning is disabled on this repository.","status":"404"}"#,
            "gh: Secret scanning is disabled on this repository. (HTTP 404)",
        );
        assert_eq!(availability, FindingAvailability::NotEnabled);
        assert_eq!(
            detail.as_deref(),
            Some("Secret scanning is disabled on this repository.")
        );
    }

    #[test]
    fn classify_failure_reads_a_scanning_refusal_as_forbidden() {
        // GitHub's documented refusal wordings for these endpoints (not live-measured
        // — no under-scoped token was available to probe with). As Indeterminate they
        // would offer the user a Retry that can never succeed.
        for message in [
            "Resource not accessible by personal access token",
            "You must have admin permissions to the repository to use this endpoint.",
        ] {
            let body = json!({ "message": message }).to_string();
            let (availability, detail) = classify_failure(&body, "gh: HTTP 403");
            assert_eq!(availability, FindingAvailability::Forbidden, "{message}");
            assert_eq!(detail.as_deref(), Some(message));
        }
    }

    #[test]
    fn parse_status_reads_the_status_line() {
        assert_eq!(
            parse_status("HTTP/2.0 404 Not Found\r\nServer: github.com\r\n"),
            Some(404)
        );
        assert_eq!(parse_status("HTTP/1.1 200 OK\r\n"), Some(200));
        // No status line (gh printed only a body) leaves the code unknown.
        assert_eq!(parse_status(""), None);
        assert_eq!(parse_status("Server: github.com\r\n"), None);
    }

    #[test]
    fn advisories_read_a_bare_not_found_as_not_enabled() {
        // Advisories exist only on public repos; a private one 404s with "Not Found",
        // which as Indeterminate would read to the user as a failure.
        let out = advisories_envelope(Fetched::Unavailable {
            availability: FindingAvailability::Indeterminate,
            detail: Some("Not Found".into()),
            status: Some(404),
        });
        assert_eq!(out.availability, FindingAvailability::NotEnabled);
        assert_eq!(out.detail.as_deref(), Some("Not Found"));
        // The override is scoped to this arm: elsewhere a bare 404 stays unknown.
        let out = alerts_envelope(Fetched::Unavailable {
            availability: FindingAvailability::Indeterminate,
            detail: Some("Not Found".into()),
            status: Some(404),
        });
        assert_eq!(out.availability, FindingAvailability::Indeterminate);
        // A different message, or an unreadable status, is not the private-repo case.
        for (detail, status) in [
            (Some("Bad credentials".to_string()), Some(404)),
            (Some("Not Found".to_string()), Some(502)),
            (Some("Not Found".to_string()), None),
        ] {
            let out = advisories_envelope(Fetched::Unavailable {
                availability: FindingAvailability::Indeterminate,
                detail,
                status,
            });
            assert_eq!(out.availability, FindingAvailability::Indeterminate);
        }
        // A classified failure is never re-read by the override.
        let out = advisories_envelope(Fetched::Unavailable {
            availability: FindingAvailability::Forbidden,
            detail: Some("Not Found".into()),
            status: Some(404),
        });
        assert_eq!(out.availability, FindingAvailability::Forbidden);
    }

    fn metric_pairs(metrics: &[CvssMetricOut]) -> Vec<(&str, &str)> {
        metrics
            .iter()
            .map(|m| (m.label.as_str(), m.value.as_str()))
            .collect()
    }

    #[test]
    fn cvss_v3_vector_decodes_to_the_base_table() {
        let metrics = cvss_metrics("CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H");
        assert_eq!(
            metric_pairs(&metrics),
            vec![
                ("Attack vector", "Network"),
                ("Attack complexity", "High"),
                ("Privileges required", "None"),
                ("User interaction", "None"),
                ("Scope", "Unchanged"),
                ("Confidentiality", "None"),
                ("Integrity", "None"),
                ("Availability", "High"),
            ]
        );
        // 3.0 shares the table.
        assert_eq!(cvss_metrics("CVSS:3.0/AV:L/AC:L").len(), 2);
    }

    #[test]
    fn cvss_v4_vector_decodes_to_its_own_base_table() {
        let metrics =
            cvss_metrics("CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N");
        assert_eq!(
            metric_pairs(&metrics),
            vec![
                ("Attack vector", "Network"),
                ("Attack complexity", "Low"),
                ("Attack requirements", "Present"),
                ("Privileges required", "None"),
                ("User interaction", "None"),
                ("Vulnerable system confidentiality", "None"),
                ("Vulnerable system integrity", "None"),
                ("Vulnerable system availability", "High"),
                ("Subsequent system confidentiality", "None"),
                ("Subsequent system integrity", "None"),
                ("Subsequent system availability", "None"),
            ]
        );
    }

    #[test]
    fn cvss_metric_table_is_chosen_by_the_prefix() {
        // v4-only keys inside a v3 vector are skipped rather than mislabelled, and
        // v3-only keys inside a v4 vector likewise — "UI:P" means Passive only in v4.
        let v3 = cvss_metrics("CVSS:3.1/AV:N/AT:P/VC:H/S:C/UI:R");
        assert_eq!(
            metric_pairs(&v3),
            vec![
                ("Attack vector", "Network"),
                ("User interaction", "Required"),
                ("Scope", "Changed"),
            ]
        );
        let v4 = cvss_metrics("CVSS:4.0/AV:N/S:C/C:H/UI:P");
        assert_eq!(
            metric_pairs(&v4),
            vec![
                ("Attack vector", "Network"),
                ("User interaction", "Passive")
            ]
        );
    }

    #[test]
    fn cvss_metrics_tolerate_unknown_tokens() {
        // Temporal/threat/environmental tokens carry no base key and drop out; an
        // unrecognized VALUE falls back to the raw letter rather than an invented label.
        let metrics = cvss_metrics("CVSS:3.1/AV:X/AC:L/E:P/RL:O/RC:C/MAV:N/CR:H/ZZ:Q/PR:");
        assert_eq!(
            metric_pairs(&metrics),
            vec![("Attack vector", "X"), ("Attack complexity", "Low")]
        );
    }

    #[test]
    fn a_foreign_vector_yields_no_metrics() {
        // The view falls back to the raw vector string; guessing a table would print
        // v3 labels over a v2 (or future) vector's letters.
        for vector in [
            "",
            "not a vector",
            "AV:N/AC:L/Au:N/C:P/I:P/A:P",
            "CVSS:2.0/AV:N/AC:L",
            "CVSS:5.0/AV:N",
        ] {
            assert!(cvss_metrics(vector).is_empty(), "{vector}");
        }
    }

    #[test]
    fn cvss_entries_come_from_the_vector_not_the_score() {
        // Both revisions, v3 first, each versioned off its own prefix.
        let list = cvss_list(
            Some(RawCvssSeverities {
                cvss_v3: Some(RawCvss {
                    score: Some(7.5),
                    vector_string: Some("CVSS:3.1/AV:N/AC:L".into()),
                }),
                cvss_v4: Some(RawCvss {
                    score: Some(8.7),
                    vector_string: Some("CVSS:4.0/AV:N/AC:L".into()),
                }),
            }),
            None,
        );
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].version, "3.1");
        assert_eq!(list[0].score, Some(7.5));
        assert_eq!(list[0].vector_string, "CVSS:3.1/AV:N/AC:L");
        assert_eq!(list[1].version, "4.0");
        assert_eq!(list[1].score, Some(8.7));
        // A null vector means "no score here" — the 0.0 alongside it is not a real zero.
        let list = cvss_list(
            Some(RawCvssSeverities {
                cvss_v3: Some(RawCvss {
                    score: Some(0.0),
                    vector_string: None,
                }),
                cvss_v4: None,
            }),
            None,
        );
        assert!(list.is_empty());
        // The legacy `cvss` field stands in for a missing v3 entry.
        let list = cvss_list(
            None,
            Some(RawCvss {
                score: Some(5.3),
                vector_string: Some("CVSS:3.0/AV:N".into()),
            }),
        );
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].version, "3.0");
        // A vector with no CVSS prefix keeps its raw string but claims no revision.
        let list = cvss_list(
            None,
            Some(RawCvss {
                score: Some(6.8),
                vector_string: Some("AV:N/AC:L/Au:N".into()),
            }),
        );
        assert_eq!(list[0].version, "");
        assert!(list[0].metrics.is_empty());
        assert_eq!(list[0].vector_string, "AV:N/AC:L/Au:N");
    }

    #[test]
    fn a_legacy_vector_never_duplicates_a_scored_revision() {
        // The legacy `cvss` field names no revision: on a v4-only advisory it can
        // restate the v4 vector, which must not render as two identical scores.
        let list = cvss_list(
            Some(RawCvssSeverities {
                cvss_v3: None,
                cvss_v4: Some(RawCvss {
                    score: Some(6.9),
                    vector_string: Some("CVSS:4.0/AV:N/AC:L".into()),
                }),
            }),
            Some(RawCvss {
                score: Some(9.9),
                vector_string: Some("CVSS:4.0/AV:N/AC:L".into()),
            }),
        );
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].version, "4.0");
        // The surviving entry is the cvss_severities one, not the legacy restatement.
        assert_eq!(list[0].score, Some(6.9));
        // Genuinely different revisions still both survive.
        let list = cvss_list(
            Some(RawCvssSeverities {
                cvss_v3: None,
                cvss_v4: Some(RawCvss {
                    score: Some(6.9),
                    vector_string: Some("CVSS:4.0/AV:N/AC:L".into()),
                }),
            }),
            Some(RawCvss {
                score: Some(5.3),
                vector_string: Some("CVSS:3.1/AV:N/AC:L".into()),
            }),
        );
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].version, "3.1");
        assert_eq!(list[1].version, "4.0");
    }

    #[test]
    fn reference_labels_name_the_link_target() {
        for (url, expected) in [
            ("https://nvd.nist.gov/vuln/detail/CVE-2026-69207", "NVD"),
            ("https://github.com/honojs/hono/commit/abc123", "Commit"),
            (
                "https://github.com/honojs/hono/releases/tag/v4.12.34",
                "Release",
            ),
            (
                "https://github.com/honojs/hono/security/advisories/GHSA-8j4g-w8fx-2239",
                "Advisory",
            ),
            // A GHSA id anywhere in the path is an advisory even off the advisories route.
            (
                "https://github.com/advisories/GHSA-8j4g-w8fx-2239",
                "Advisory",
            ),
            ("https://github.com/honojs/hono/pull/4212", "Pull request"),
            ("https://github.com/honojs/hono/issues/4211", "Issue"),
            // No recognized route: the bare host, never an empty label.
            ("https://github.com/honojs/hono", "github.com"),
            ("https://www.cve.org/CVERecord?id=CVE-2026-69207", "cve.org"),
            (
                "https://lists.debian.org:8443/msg00001.html",
                "lists.debian.org",
            ),
            ("http://EXAMPLE.COM/x", "example.com"),
            // A bracketed IPv6 literal labels whole — its colons aren't a port.
            ("https://[2001:DB8::1]:8443/x", "[2001:db8::1]"),
            // A non-port suffix after `]` is no authority: the URL labels itself.
            ("https://[2001:DB8::1]junk/x", "https://[2001:DB8::1]junk/x"),
            ("https://WWW.Example.com/x", "example.com"),
            // Nothing parseable to name it by: the URL labels itself.
            ("not a url", "not a url"),
            ("mailto:security@example.com", "mailto:security@example.com"),
            ("https:///no-host/path", "https:///no-host/path"),
        ] {
            assert_eq!(reference_label(url), expected, "{url}");
        }
    }

    #[test]
    fn advisory_detail_lists_drop_unusable_entries() {
        // Only http(s) survives: a reference is rendered as an openable link, and the
        // list is community-contributed, so a mail address or a local path is not one.
        let references = references_out(Some(vec![
            RawReference {
                url: Some("https://nvd.nist.gov/vuln/detail/CVE-1".into()),
            },
            RawReference { url: None },
            RawReference {
                url: Some(String::new()),
            },
            RawReference {
                url: Some("mailto:security@example.com".into()),
            },
            RawReference {
                url: Some("file:///C:/Windows/System32/drivers/etc/hosts".into()),
            },
            RawReference {
                url: Some("not a url".into()),
            },
        ]));
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].label, "NVD");
        let cwes = cwes_out(Some(vec![
            RawCwe {
                cwe_id: Some("CWE-1333".into()),
                name: Some("Inefficient Regular Expression Complexity".into()),
            },
            RawCwe {
                cwe_id: None,
                name: Some("orphan".into()),
            },
        ]));
        assert_eq!(cwes.len(), 1);
        assert_eq!(cwes[0].cwe_id, "CWE-1333");
        assert_eq!(cwes[0].name, "Inefficient Regular Expression Complexity");
        assert!(references_out(None).is_empty());
        assert!(cwes_out(None).is_empty());
    }

    fn detailed_alert_fixture() -> Value {
        let mut alert = alert_fixture(
            json!({ "identifier": "4.12.34" }),
            json!({ "score": 5.3, "vector_string": "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H" }),
        );
        alert["security_advisory"]["cvss_severities"] = json!({
            "cvss_v3": {
                "score": 5.3,
                "vector_string": "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H"
            },
            "cvss_v4": {
                "score": 6.9,
                "vector_string": "CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:N/VI:N/VA:H/SC:N/SI:N/SA:N"
            }
        });
        alert["security_advisory"]["references"] = json!([
            { "url": "https://github.com/honojs/hono/security/advisories/GHSA-8j4g-w8fx-2239" },
            { "url": "https://nvd.nist.gov/vuln/detail/CVE-2026-69207" }
        ]);
        alert["security_advisory"]["cwes"] = json!([
            { "cwe_id": "CWE-1333", "name": "Inefficient Regular Expression Complexity" }
        ]);
        alert
    }

    #[test]
    fn alert_maps_the_detail_fields() {
        let raw: RawAlert =
            serde_json::from_value(detailed_alert_fixture()).expect("alert fixture deserializes");
        let out = alert_out(raw);
        assert_eq!(out.relationship.as_deref(), Some("transitive"));
        // The legacy cvss field still feeds cvssScore; the new list is separate.
        assert_eq!(out.cvss_score, Some(5.3));
        assert_eq!(out.cvss.len(), 2);
        assert_eq!(out.cvss[0].version, "3.1");
        assert_eq!(out.cvss[0].metrics.len(), 8);
        assert_eq!(out.cvss[1].version, "4.0");
        assert_eq!(out.cvss[1].score, Some(6.9));
        assert_eq!(out.cvss[1].metrics.len(), 11);
        assert_eq!(out.references.len(), 2);
        assert_eq!(out.references[0].label, "Advisory");
        assert_eq!(out.references[1].label, "NVD");
        assert_eq!(out.cwes.len(), 1);
        assert_eq!(out.cwes[0].cwe_id, "CWE-1333");
    }

    #[test]
    fn alert_detail_fields_tolerate_a_stripped_item() {
        let raw: RawAlert =
            serde_json::from_value(json!({ "number": 7 })).expect("sparse alert deserializes");
        let out = alert_out(raw);
        assert_eq!(out.relationship, None);
        assert!(out.cvss.is_empty());
        assert!(out.references.is_empty());
        assert!(out.cwes.is_empty());
    }

    fn code_scanning_fixture() -> Value {
        json!({
            "number": 4,
            "state": "open",
            "rule": {
                "id": "js/zipslip",
                "name": "js/zipslip",
                "description": "Arbitrary file write during zip extraction",
                "severity": "error",
                "security_severity_level": "high",
                "tags": ["security"]
            },
            "tool": { "name": "CodeQL", "guid": Value::Null, "version": "2.4.0" },
            "most_recent_instance": {
                "ref": "refs/heads/main",
                "state": "open",
                "commit_sha": "39406e42cb832f683daa691dd652a8dc36ee8930",
                "message": { "text": "This path depends on a user-provided value." },
                "location": {
                    "path": "lib/ab12-gen.js",
                    "start_line": 917,
                    "end_line": 917,
                    "start_column": 7,
                    "end_column": 18
                },
                "classifications": ["library"]
            },
            "html_url": "https://github.com/theBGuy/GitDesktop/security/code-scanning/4",
            "created_at": "2026-08-04T12:29:18Z",
            "updated_at": "2026-08-05T12:29:18Z"
        })
    }

    #[test]
    fn code_scanning_alert_maps_every_field() {
        let raw: RawCodeScanningAlert =
            serde_json::from_value(code_scanning_fixture()).expect("fixture deserializes");
        let out = code_scanning_alert_out(raw);
        assert_eq!(out.number, 4);
        assert_eq!(out.state, "open");
        assert_eq!(out.rule_id, "js/zipslip");
        assert_eq!(out.rule_name.as_deref(), Some("js/zipslip"));
        assert_eq!(
            out.rule_description.as_deref(),
            Some("Arbitrary file write during zip extraction")
        );
        // The SARIF level and the security severity are separate scales.
        assert_eq!(out.severity.as_deref(), Some("error"));
        assert_eq!(out.security_severity.as_deref(), Some("high"));
        assert_eq!(out.tool_name, "CodeQL");
        assert_eq!(out.tool_version.as_deref(), Some("2.4.0"));
        assert_eq!(out.path, "lib/ab12-gen.js");
        assert_eq!(out.start_line, Some(917));
        assert_eq!(out.message, "This path depends on a user-provided value.");
        assert_eq!(out.git_ref.as_deref(), Some("refs/heads/main"));
        assert_eq!(
            out.html_url,
            "https://github.com/theBGuy/GitDesktop/security/code-scanning/4"
        );
        assert_eq!(out.created_at, "2026-08-04T12:29:18Z");
        assert_eq!(out.updated_at, "2026-08-05T12:29:18Z");
    }

    #[test]
    fn code_scanning_alert_tolerates_a_stripped_item() {
        let raw: RawCodeScanningAlert =
            serde_json::from_value(json!({ "number": 9 })).expect("sparse alert deserializes");
        let out = code_scanning_alert_out(raw);
        assert_eq!(out.number, 9);
        assert_eq!(out.rule_id, "");
        assert_eq!(out.message, "");
        assert_eq!(out.path, "");
        assert_eq!(out.start_line, None);
        assert_eq!(out.git_ref, None);
        assert_eq!(out.security_severity, None);
    }

    fn secret_scanning_fixture() -> Value {
        json!({
            "number": 2,
            "state": "open",
            "secret_type": "adafruit_io_key",
            "secret_type_display_name": "Adafruit IO Key",
            "secret": "aio_XXXXXXXXXXXXXXXXXXXXXXXXXXXX",
            "validity": "active",
            "publicly_leaked": true,
            "multi_repo": false,
            "html_url": "https://github.com/theBGuy/GitDesktop/security/secret-scanning/2",
            "created_at": "2026-08-04T18:18:30Z",
            "updated_at": "2026-08-05T18:18:30Z"
        })
    }

    #[test]
    fn secret_scanning_alert_maps_every_field() {
        let raw: RawSecretScanningAlert =
            serde_json::from_value(secret_scanning_fixture()).expect("fixture deserializes");
        let out = secret_scanning_alert_out(raw);
        assert_eq!(out.number, 2);
        assert_eq!(out.state, "open");
        assert_eq!(out.secret_type, "adafruit_io_key");
        assert_eq!(out.secret_type_display_name, "Adafruit IO Key");
        assert_eq!(out.validity.as_deref(), Some("active"));
        assert_eq!(out.publicly_leaked, Some(true));
        assert_eq!(
            out.html_url,
            "https://github.com/theBGuy/GitDesktop/security/secret-scanning/2"
        );
        assert_eq!(out.created_at, "2026-08-04T18:18:30Z");
        assert_eq!(out.updated_at, "2026-08-05T18:18:30Z");
    }

    #[test]
    fn secret_scanning_alert_tolerates_a_stripped_item() {
        let raw: RawSecretScanningAlert =
            serde_json::from_value(json!({ "number": 3 })).expect("sparse alert deserializes");
        let out = secret_scanning_alert_out(raw);
        assert_eq!(out.number, 3);
        assert_eq!(out.secret_type, "");
        assert_eq!(out.secret_type_display_name, "");
        assert_eq!(out.validity, None);
        assert_eq!(out.publicly_leaked, None);
    }

    #[test]
    fn code_scanning_envelope_wire_shape_is_pinned() {
        let raw: RawCodeScanningAlert = serde_json::from_value(code_scanning_fixture()).unwrap();
        let envelope = CodeScanningAlertsOut {
            availability: FindingAvailability::Available,
            detail: None,
            alerts: vec![code_scanning_alert_out(raw)],
            truncated: true,
        };
        assert_eq!(
            serde_json::to_value(&envelope).unwrap(),
            json!({
                "availability": "available",
                "detail": Value::Null,
                "truncated": true,
                "alerts": [{
                    "number": 4,
                    "state": "open",
                    "ruleId": "js/zipslip",
                    "ruleName": "js/zipslip",
                    "ruleDescription": "Arbitrary file write during zip extraction",
                    "severity": "error",
                    "securitySeverity": "high",
                    "toolName": "CodeQL",
                    "toolVersion": "2.4.0",
                    "path": "lib/ab12-gen.js",
                    "startLine": 917,
                    "message": "This path depends on a user-provided value.",
                    // A Rust keyword on the wire: the key must stay literally "ref".
                    "ref": "refs/heads/main",
                    "htmlUrl": "https://github.com/theBGuy/GitDesktop/security/code-scanning/4",
                    "createdAt": "2026-08-04T12:29:18Z",
                    "updatedAt": "2026-08-05T12:29:18Z"
                }]
            })
        );
    }

    #[test]
    fn secret_scanning_envelope_wire_shape_is_pinned() {
        let raw: RawSecretScanningAlert =
            serde_json::from_value(secret_scanning_fixture()).unwrap();
        let envelope = SecretScanningAlertsOut {
            availability: FindingAvailability::NotEnabled,
            detail: Some("Secret scanning is disabled on this repository.".into()),
            alerts: vec![secret_scanning_alert_out(raw)],
            truncated: false,
        };
        // The exact shape also pins what does NOT cross: the fixture's `secret` value
        // stays server-side — this app never carries a leaked credential to the UI.
        assert_eq!(
            serde_json::to_value(&envelope).unwrap(),
            json!({
                "availability": "notEnabled",
                "detail": "Secret scanning is disabled on this repository.",
                "truncated": false,
                "alerts": [{
                    "number": 2,
                    "state": "open",
                    "secretType": "adafruit_io_key",
                    "secretTypeDisplayName": "Adafruit IO Key",
                    "validity": "active",
                    "publiclyLeaked": true,
                    "htmlUrl": "https://github.com/theBGuy/GitDesktop/security/secret-scanning/2",
                    "createdAt": "2026-08-04T18:18:30Z",
                    "updatedAt": "2026-08-05T18:18:30Z"
                }]
            })
        );
    }

    #[test]
    fn new_arms_keep_the_availability_envelope() {
        // A readable-but-empty window is the real answer; an unavailable one carries
        // the reason instead of an empty list the user would read as "clean".
        let out = code_scanning_envelope(Fetched::Items {
            items: Vec::new(),
            truncated: false,
        });
        assert_eq!(out.availability, FindingAvailability::Available);
        assert!(out.alerts.is_empty());
        let out = secret_scanning_envelope(Fetched::Unavailable {
            availability: FindingAvailability::NotEnabled,
            detail: Some("Secret scanning is disabled on this repository.".into()),
            status: Some(404),
        });
        assert_eq!(out.availability, FindingAvailability::NotEnabled);
        assert!(!out.truncated);
        let out = secret_scanning_envelope(Fetched::Items {
            items: vec![json!("not an object")],
            truncated: false,
        });
        assert_eq!(out.availability, FindingAvailability::Indeterminate);
        assert_eq!(
            out.detail.as_deref(),
            Some("GitHub returned 1 alert this build couldn't read")
        );
    }
}
