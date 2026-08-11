//! GitLab's Findings arm: SAST, secret detection and code quality read out of a
//! pipeline's CI report artifacts.
//!
//! GitLab paywalls the rendered vulnerability report behind Ultimate, but the
//! analyzers write plain JSON artifacts that every tier can download, so this
//! reads those. Each category rides an availability envelope: scanning never
//! configured, an expired artifact, a report the API won't serve, and an
//! unrecognized failure are all distinct from "genuinely clean" — an empty list
//! only renders as clean when a parsed report says so. Only a missing `glab`
//! binary or a timeout escapes as `Err`; every completed-but-failed call is
//! classified into the envelope instead.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AppResult;
use crate::forge::encode_query_value;
use crate::forge::gitlab::{encode_project, glab_output_is_404, project_path};
use crate::forge::glab::{run_glab_raw, GlabOutput, GLAB_NETWORK_TIMEOUT};

/// A report bigger than this is refused rather than parsed. `run_glab_raw` has
/// already buffered the whole artifact by the time we look, so the cap bounds the
/// PARSE — serde over an attacker-influenceable body — not the bytes held.
const MAX_REPORT_BYTES: usize = 16 * 1024 * 1024;

/// GitLab's `file_type` for each report we read, as the jobs payload spells them.
const SAST_FILE_TYPE: &str = "sast";
const SECRET_DETECTION_FILE_TYPE: &str = "secret_detection";
const CODE_QUALITY_FILE_TYPE: &str = "codequality";

// ── Wire shape ───────────────────────────────────────────────────────────────

/// Why a category's list may be empty. Serialized camelCase; the frontend
/// branches on these exact strings to pick between "no findings" and a reason.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum GlFindingAvailability {
    /// The list is real — an empty one means no findings.
    Available,
    /// The pipeline runs no job publishing this report.
    NotConfigured,
    /// The job declares the report but GitLab won't serve the file.
    ReportNotReadable,
    /// The job's artifacts have passed their expiry.
    Expired,
    /// The pipeline hasn't finished, so no artifact exists yet.
    AnalysisPending,
    /// The token can't read this project's pipelines or artifacts.
    Forbidden,
    /// The call failed in a way we can't attribute; the list is unknown, not empty.
    Indeterminate,
}

/// Which pipeline (if any) the findings were read from.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum GlPipelineState {
    /// A completed pipeline was found; `pipeline` describes it.
    Found,
    /// Neither the checked-out ref nor the default branch has any pipeline.
    None,
    /// Pipelines exist but none has finished, so no artifacts exist yet.
    RunningOnly,
    /// The project or pipeline lookup itself failed.
    Unavailable,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GlFindingsOut {
    pub pipeline_state: GlPipelineState,
    /// `Some` only when `pipeline_state` is `Found`.
    pub pipeline: Option<GlPipelineRefOut>,
    /// The ref we looked for — the checkout branch, or `"HEAD"` when detached.
    pub requested_ref: String,
    /// The default branch's pipelines were read instead of the requested ref's.
    pub used_fallback: bool,
    pub fallback_ref: Option<String>,
    pub project_web_url: Option<String>,
    pub sast: GlSecureCategoryOut,
    pub secret_detection: GlSecureCategoryOut,
    pub code_quality: GlCodeQualityCategoryOut,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GlPipelineRefOut {
    pub id: u64,
    pub iid: u64,
    pub status: String,
    pub sha: String,
    /// `ref` is a Rust keyword, so the wire key is pinned by hand.
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub web_url: String,
    pub created_at: String,
    /// The pipelines LIST payload carries no finish time (measured, gitlab.com
    /// 2026-08-11), so this is `None` unless the host sends one.
    pub finished_at: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GlSecureCategoryOut {
    pub availability: GlFindingAvailability,
    /// Why the list is unavailable — or, alongside `Available`, how much of the
    /// pipeline's output was unreadable; the frontend renders that as a muted
    /// notice over a list that is short rather than wrong.
    pub detail: Option<String>,
    pub findings: Vec<GlSecureFindingOut>,
    /// More findings existed than the cap kept.
    pub truncated: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GlCodeQualityCategoryOut {
    pub availability: GlFindingAvailability,
    /// Same contract as [`GlSecureCategoryOut::detail`] — non-null is possible
    /// alongside `Available`.
    pub detail: Option<String>,
    pub findings: Vec<GlCodeQualityFindingOut>,
    pub truncated: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GlSecureFindingOut {
    pub id: String,
    pub name: String,
    /// GitLab's capitalized ladder ("Critical" … "Unknown"), raw so an
    /// unrecognized future value renders instead of being dropped.
    pub severity: String,
    pub description: String,
    pub file: String,
    pub start_line: Option<u64>,
    pub end_line: Option<u64>,
    pub scanner_name: String,
    pub identifiers: Vec<GlIdentifierOut>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GlIdentifierOut {
    /// `type` is a Rust keyword, so the wire key is pinned by hand.
    #[serde(rename = "type")]
    pub identifier_type: String,
    pub name: String,
    pub value: String,
    pub url: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GlCodeQualityFindingOut {
    pub fingerprint: String,
    pub check_name: String,
    /// CodeClimate's lowercase ladder ("blocker" … "info"), raw.
    pub severity: String,
    pub description: String,
    pub path: String,
    pub line: Option<u64>,
}

// ── Untrusted GitLab JSON ────────────────────────────────────────────────────
// Every field is optional so a shape change or one malformed item degrades that
// field rather than failing the whole list.

#[derive(Deserialize, Default)]
struct RawProject {
    /// The numeric project id, which is what a bridge's downstream pipeline
    /// identifies its own project by.
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    default_branch: Option<String>,
    #[serde(default)]
    web_url: Option<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
struct RawPipeline {
    #[serde(default)]
    id: Option<u64>,
    #[serde(default)]
    iid: Option<u64>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    sha: Option<String>,
    #[serde(default, rename = "ref")]
    git_ref: Option<String>,
    #[serde(default)]
    web_url: Option<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    finished_at: Option<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
struct RawJobArtifact {
    #[serde(default)]
    file_type: Option<String>,
    #[serde(default)]
    filename: Option<String>,
}

#[derive(Deserialize, Default, Clone, Debug)]
struct RawJob {
    #[serde(default)]
    id: Option<u64>,
    /// Null while artifacts are kept forever; a past instant is what separates an
    /// expired report from one the API simply won't serve.
    #[serde(default)]
    artifacts_expire_at: Option<String>,
    #[serde(default)]
    artifacts: Option<Vec<RawJobArtifact>>,
}

#[derive(Deserialize, Default, Clone, Debug)]
struct RawDownstreamPipeline {
    #[serde(default)]
    id: Option<u64>,
    /// Pipeline ids are instance-global, so this is what tells a parent-child
    /// pipeline apart from a multi-project (`trigger: project:`) one.
    #[serde(default)]
    project_id: Option<u64>,
}

/// A `trigger:` job. Its work runs in a downstream pipeline whose jobs the
/// parent's own jobs endpoint never lists.
#[derive(Deserialize, Default, Clone, Debug)]
struct RawBridge {
    /// Null until the bridge triggers, and when creating the child failed.
    #[serde(default)]
    downstream_pipeline: Option<RawDownstreamPipeline>,
}

#[derive(Deserialize, Default)]
struct RawScanner {
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize, Default)]
struct RawSecureLocation {
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    start_line: Option<u64>,
    #[serde(default)]
    end_line: Option<u64>,
}

#[derive(Deserialize, Default)]
struct RawIdentifier {
    #[serde(default, rename = "type")]
    identifier_type: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    url: Option<String>,
}

/// One vulnerability from a secure report (schema 15.2.x). Two fields are
/// deliberately NOT declared: `raw_source_code_extract` carries the literal
/// leaked secret, and leaving it undeclared keeps it out of this process's
/// serialization entirely; `cve` on a secret-detection finding is a
/// `path:hash:rule` fingerprint composite, not a CVE (both measured 2026-08-11).
#[derive(Deserialize, Default)]
struct RawVulnerability {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    scanner: Option<RawScanner>,
    #[serde(default)]
    location: Option<RawSecureLocation>,
    #[serde(default)]
    identifiers: Option<Vec<RawIdentifier>>,
}

#[derive(Deserialize, Default)]
struct RawSecureReport {
    #[serde(default)]
    vulnerabilities: Option<Vec<Value>>,
}

#[derive(Deserialize, Default)]
struct RawCqLines {
    #[serde(default)]
    begin: Option<u64>,
}

#[derive(Deserialize, Default)]
struct RawCqPosition {
    #[serde(default)]
    line: Option<u64>,
}

#[derive(Deserialize, Default)]
struct RawCqPositions {
    #[serde(default)]
    begin: Option<RawCqPosition>,
}

#[derive(Deserialize, Default)]
struct RawCqLocation {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    lines: Option<RawCqLines>,
    #[serde(default)]
    positions: Option<RawCqPositions>,
}

#[derive(Deserialize, Default)]
struct RawCqIssue {
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    check_name: Option<String>,
    #[serde(default)]
    fingerprint: Option<String>,
    #[serde(default)]
    severity: Option<String>,
    #[serde(default)]
    location: Option<RawCqLocation>,
}

// ── Mapping ──────────────────────────────────────────────────────────────────

fn secure_finding_out(raw: RawVulnerability) -> GlSecureFindingOut {
    let location = raw.location.unwrap_or_default();
    GlSecureFindingOut {
        id: raw.id.unwrap_or_default(),
        name: raw.name.unwrap_or_default(),
        severity: raw.severity.unwrap_or_default(),
        description: raw.description.unwrap_or_default(),
        file: location.file.unwrap_or_default(),
        start_line: location.start_line,
        end_line: location.end_line,
        scanner_name: raw.scanner.unwrap_or_default().name.unwrap_or_default(),
        identifiers: raw
            .identifiers
            .unwrap_or_default()
            .into_iter()
            .map(|i| GlIdentifierOut {
                identifier_type: i.identifier_type.unwrap_or_default(),
                name: i.name.unwrap_or_default(),
                value: i.value.unwrap_or_default(),
                url: i.url,
            })
            .collect(),
    }
}

fn code_quality_finding_out(raw: RawCqIssue) -> GlCodeQualityFindingOut {
    let location = raw.location.unwrap_or_default();
    // CodeClimate allows either shape for a line; whichever is present wins.
    let line = location.lines.and_then(|l| l.begin).or_else(|| {
        location
            .positions
            .and_then(|p| p.begin)
            .and_then(|b| b.line)
    });
    GlCodeQualityFindingOut {
        fingerprint: raw.fingerprint.unwrap_or_default(),
        check_name: raw.check_name.unwrap_or_default(),
        severity: raw.severity.unwrap_or_default(),
        description: raw.description.unwrap_or_default(),
        path: location.path.unwrap_or_default(),
        line,
    }
}

fn pipeline_ref_out(raw: RawPipeline) -> GlPipelineRefOut {
    GlPipelineRefOut {
        id: raw.id.unwrap_or(0),
        iid: raw.iid.unwrap_or(0),
        status: raw.status.unwrap_or_default(),
        sha: raw.sha.unwrap_or_default(),
        git_ref: raw.git_ref.unwrap_or_default(),
        web_url: raw.web_url.unwrap_or_default(),
        created_at: raw.created_at.unwrap_or_default(),
        finished_at: raw.finished_at,
    }
}

// ── Classification ───────────────────────────────────────────────────────────

/// GitLab's error bodies are a few hundred bytes; anything larger on a failed
/// call is an echoed report, not an error envelope. Bounding the read keeps
/// classification off a multi-megabyte body.
const MAX_ERROR_BODY_BYTES: usize = 64 * 1024;

/// The server's own `message`, when the body is one — it beats glab's stderr,
/// which restates the status without the explanation.
fn server_message(stdout: &str) -> Option<String> {
    if stdout.len() > MAX_ERROR_BODY_BYTES {
        return None;
    }
    serde_json::from_str::<Value>(stdout.trim())
        .ok()
        .and_then(|v| {
            v.get("message")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|m| !m.is_empty())
                .map(str::to_string)
        })
}

/// Maps a completed-but-failed glab call onto the envelope. Classified into `Ok`
/// so the UI can say *why* a list is empty; anything unrecognized stays
/// `Indeterminate` and is never presented as a clean project.
fn classify_call_failure(stdout: &str, stderr: &str) -> (GlFindingAvailability, Option<String>) {
    let message = server_message(stdout);
    let stderr = stderr.trim();
    let detail = message
        .clone()
        .or_else(|| (!stderr.is_empty()).then(|| stderr.to_string()));
    // Only the server's own message and glab's stderr may classify: a report body
    // can carry "forbidden" in a rule description, and GitLab Free answers a
    // paywalled read with a bare `403 Forbidden` and no explanation anyway, so the
    // client supplies the context the server withholds.
    let hay = format!("{}\n{stderr}", message.as_deref().unwrap_or_default()).to_ascii_lowercase();
    if hay.contains("403") || hay.contains("forbidden") {
        (GlFindingAvailability::Forbidden, detail)
    } else {
        (GlFindingAvailability::Indeterminate, detail)
    }
}

/// Whether a job's artifacts are past their expiry. An absent or unparseable
/// timestamp reads as "not expired" — guessing expiry would mislabel a report
/// GitLab is simply refusing to serve.
fn artifacts_expired(expire_at: Option<&str>, now: DateTime<Utc>) -> bool {
    expire_at
        .and_then(|s| DateTime::parse_from_rfc3339(s.trim()).ok())
        .is_some_and(|t| t.with_timezone(&Utc) <= now)
}

/// A downloaded report's bytes, or why they're unusable.
fn artifact_outcome(
    out: GlabOutput,
    expire_at: Option<&str>,
    now: DateTime<Utc>,
) -> Result<Vec<u8>, (GlFindingAvailability, Option<String>)> {
    if out.code == 0 {
        if out.stdout.len() > MAX_REPORT_BYTES {
            return Err((
                GlFindingAvailability::Indeterminate,
                Some("the report was too large to read".to_string()),
            ));
        }
        return Ok(out.stdout);
    }
    let stdout = out.stdout_lossy();
    if glab_output_is_404(&out.stderr, &stdout) {
        return Err(if artifacts_expired(expire_at, now) {
            (
                GlFindingAvailability::Expired,
                expire_at.map(|e| format!("the job's artifacts expired on {e}")),
            )
        } else {
            // MEASURED: a report declared only under `artifacts:reports` lists its
            // file_type in the job metadata yet 404s on download — the project has
            // to expose it via `artifacts:paths` for the API to serve the file.
            (
                GlFindingAvailability::ReportNotReadable,
                Some("the job lists this report but GitLab returned 404 for the file".to_string()),
            )
        });
    }
    Err(classify_call_failure(&stdout, &out.stderr))
}

// ── Selection ────────────────────────────────────────────────────────────────

/// Only a finished pipeline can have artifacts; `canceled`/`skipped` produce none
/// and `running` hasn't yet.
fn is_completed(status: &str) -> bool {
    status == "success" || status == "failed"
}

/// The newest completed pipeline. GitLab's pipelines list is newest-first, so the
/// first completed entry is the newest one.
fn pick_pipeline(list: Vec<RawPipeline>) -> Option<RawPipeline> {
    list.into_iter()
        .find(|p| is_completed(p.status.as_deref().unwrap_or_default()))
}

/// One downloadable report artifact of a job.
#[derive(Debug, PartialEq, Eq)]
struct ArtifactRef {
    job_id: u64,
    filename: String,
    expire_at: Option<String>,
}

/// Every job publishing `file_type`. A category with no candidate job isn't
/// configured — that is a different answer from "no findings".
fn candidates(jobs: &[RawJob], file_type: &str) -> Vec<ArtifactRef> {
    let mut out = Vec::new();
    for job in jobs {
        let Some(job_id) = job.id else { continue };
        for artifact in job.artifacts.iter().flatten() {
            if artifact.file_type.as_deref() != Some(file_type) {
                continue;
            }
            let Some(filename) = artifact.filename.clone().filter(|f| !f.is_empty()) else {
                continue;
            };
            out.push(ArtifactRef {
                job_id,
                filename,
                expire_at: job.artifacts_expire_at.clone(),
            });
        }
    }
    out
}

/// Severity ladder for the secure reports; an unrecognized value ranks lowest so
/// it can't displace a real Critical from a truncated list.
fn secure_severity_rank(severity: &str) -> u8 {
    match severity.to_ascii_lowercase().as_str() {
        "critical" => 5,
        "high" => 4,
        "medium" => 3,
        "low" => 2,
        "info" => 1,
        _ => 0,
    }
}

/// CodeClimate's own ladder, which puts `blocker` above `critical`.
fn code_quality_severity_rank(severity: &str) -> u8 {
    match severity.to_ascii_lowercase().as_str() {
        "blocker" => 5,
        "critical" => 4,
        "major" => 3,
        "minor" => 2,
        "info" => 1,
        _ => 0,
    }
}

/// The per-category cap.
fn clamp_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(100).clamp(1, 500) as usize
}

// ── Envelopes ────────────────────────────────────────────────────────────────

/// A category's raw material: the report bodies we could download, plus why the
/// first undownloadable one failed and how many reports never arrived.
#[derive(Default)]
struct CategoryFetch {
    had_candidates: bool,
    bodies: Vec<Vec<u8>>,
    failure: Option<(GlFindingAvailability, Option<String>)>,
    /// Reports that failed to download. Counted so a category that still has one
    /// good report reports the loss instead of looking complete.
    lost_reports: usize,
}

/// Survivors of parsing a category's report bodies, alongside what didn't parse —
/// a window that parsed away entirely must not read as a clean project.
struct Tally<T> {
    items: Vec<T>,
    total: usize,
    readable_bodies: usize,
    /// Bodies that arrived but weren't readable reports. Counted in REPORTS: how
    /// many findings each hid is exactly what couldn't be read.
    unreadable_bodies: usize,
    /// Individual findings that failed to deserialize out of a readable report.
    dropped: usize,
}

/// Deserializes each report body's item array, dropping individually malformed
/// items but counting them.
fn tally<T, F, R>(bodies: &[Vec<u8>], items_of: F, map: R) -> Tally<T>
where
    F: Fn(&[u8]) -> Option<Vec<Value>>,
    R: Fn(Value) -> Option<T>,
{
    let mut out = Tally {
        items: Vec::new(),
        total: 0,
        readable_bodies: 0,
        unreadable_bodies: 0,
        dropped: 0,
    };
    for body in bodies {
        let Some(values) = items_of(body) else {
            out.unreadable_bodies += 1;
            continue;
        };
        let count = values.len();
        out.readable_bodies += 1;
        out.total += count;
        let before = out.items.len();
        out.items.extend(values.into_iter().filter_map(&map));
        out.dropped += count - (out.items.len() - before);
    }
    out
}

/// The `vulnerabilities` KEY is what makes a body a report: an analyzer that
/// failed internally can emit `{}`, and reading that as zero findings would issue
/// a clean bill of health nothing proved.
fn secure_report_items(body: &[u8]) -> Option<Vec<Value>> {
    serde_json::from_slice::<RawSecureReport>(body)
        .ok()
        .and_then(|r| r.vulnerabilities)
}

fn code_quality_report_items(body: &[u8]) -> Option<Vec<Value>> {
    serde_json::from_slice::<Vec<Value>>(body).ok()
}

/// The detail for a window that parsed away entirely.
fn unreadable_detail(total: usize) -> Option<String> {
    Some(if total == 0 {
        "GitLab returned a report this build couldn't read".to_string()
    } else {
        format!(
            "GitLab returned {total} {} this build couldn't read",
            if total == 1 { "finding" } else { "findings" }
        )
    })
}

/// The muted notice that rides an otherwise-`Available` category: part of the
/// pipeline's output was unreadable, so the list is short rather than wrong.
/// Reports and findings stay separate units — a lost report hides an unknown
/// number of findings, so folding it into a finding count would understate it.
fn partial_loss_detail(lost_reports: usize, dropped_findings: usize) -> Option<String> {
    let parts: Vec<String> = [
        (lost_reports, "report", "reports"),
        (dropped_findings, "finding", "findings"),
    ]
    .into_iter()
    .filter(|(count, _, _)| *count > 0)
    .map(|(count, singular, plural)| {
        format!("{count} {}", if count == 1 { singular } else { plural })
    })
    .collect();
    (!parts.is_empty()).then(|| format!("{} couldn't be read", parts.join(" and ")))
}

/// A secure finding's identity. GitLab's `id` is a content hash, but a stripped
/// or hand-rolled report can omit it — keying on an empty string would collapse
/// every id-less finding into one, so those key on where the finding is instead.
#[derive(PartialEq, Eq, Hash)]
enum SecureKey {
    Id(String),
    Location(String, String, Option<u64>),
}

fn secure_key(finding: &GlSecureFindingOut) -> SecureKey {
    if finding.id.is_empty() {
        SecureKey::Location(
            finding.name.clone(),
            finding.file.clone(),
            finding.start_line,
        )
    } else {
        SecureKey::Id(finding.id.clone())
    }
}

/// The availability a category's downloads settle on before any parsing, or
/// `None` when there are bodies to read.
fn fetch_availability(fetch: &CategoryFetch) -> Option<(GlFindingAvailability, Option<String>)> {
    if !fetch.had_candidates {
        return Some((GlFindingAvailability::NotConfigured, None));
    }
    if fetch.bodies.is_empty() {
        // One candidate job is the norm, so the first failure is the whole story.
        return Some(
            fetch
                .failure
                .clone()
                .unwrap_or((GlFindingAvailability::Indeterminate, None)),
        );
    }
    None
}

fn secure_envelope(fetch: CategoryFetch, limit: usize) -> GlSecureCategoryOut {
    if let Some((availability, detail)) = fetch_availability(&fetch) {
        return GlSecureCategoryOut {
            availability,
            detail,
            findings: Vec::new(),
            truncated: false,
        };
    }
    let tallied = tally(&fetch.bodies, secure_report_items, |v| {
        serde_json::from_value::<RawVulnerability>(v)
            .ok()
            .map(secure_finding_out)
    });
    if tallied.readable_bodies == 0 || (tallied.total > 0 && tallied.items.is_empty()) {
        return GlSecureCategoryOut {
            availability: GlFindingAvailability::Indeterminate,
            detail: unreadable_detail(tallied.total),
            findings: Vec::new(),
            truncated: false,
        };
    }
    let mut findings = tallied.items;
    let mut seen = HashSet::new();
    findings.retain(|f| seen.insert(secure_key(f)));
    // Sort BEFORE the cap so truncation drops the least severe, not the last read.
    findings.sort_by_key(|f| std::cmp::Reverse(secure_severity_rank(&f.severity)));
    let truncated = findings.len() > limit;
    findings.truncate(limit);
    GlSecureCategoryOut {
        availability: GlFindingAvailability::Available,
        detail: partial_loss_detail(
            fetch.lost_reports + tallied.unreadable_bodies,
            tallied.dropped,
        ),
        findings,
        truncated,
    }
}

fn code_quality_envelope(fetch: CategoryFetch, limit: usize) -> GlCodeQualityCategoryOut {
    if let Some((availability, detail)) = fetch_availability(&fetch) {
        return GlCodeQualityCategoryOut {
            availability,
            detail,
            findings: Vec::new(),
            truncated: false,
        };
    }
    let tallied = tally(&fetch.bodies, code_quality_report_items, |v| {
        serde_json::from_value::<RawCqIssue>(v)
            .ok()
            .map(code_quality_finding_out)
    });
    if tallied.readable_bodies == 0 || (tallied.total > 0 && tallied.items.is_empty()) {
        return GlCodeQualityCategoryOut {
            availability: GlFindingAvailability::Indeterminate,
            detail: unreadable_detail(tallied.total),
            findings: Vec::new(),
            truncated: false,
        };
    }
    let mut findings = tallied.items;
    // A fingerprint alone repeats across checks and files, so identity is the
    // fingerprint plus the check that raised it and where it landed. The
    // frontend's composite row id mirrors this tuple.
    let mut seen = HashSet::new();
    findings.retain(|f| {
        seen.insert((
            f.fingerprint.clone(),
            f.check_name.clone(),
            f.path.clone(),
            f.line,
        ))
    });
    findings.sort_by_key(|f| std::cmp::Reverse(code_quality_severity_rank(&f.severity)));
    let truncated = findings.len() > limit;
    findings.truncate(limit);
    GlCodeQualityCategoryOut {
        availability: GlFindingAvailability::Available,
        detail: partial_loss_detail(
            fetch.lost_reports + tallied.unreadable_bodies,
            tallied.dropped,
        ),
        findings,
        truncated,
    }
}

/// What every early exit needs to report about which ref it looked at.
struct RefContext {
    requested_ref: String,
    used_fallback: bool,
    fallback_ref: Option<String>,
    project_web_url: Option<String>,
}

/// Every category carrying the same classified outcome — the shape of every exit
/// taken before per-category reports are read.
fn uniform_out(
    state: GlPipelineState,
    pipeline: Option<GlPipelineRefOut>,
    refs: RefContext,
    availability: GlFindingAvailability,
    detail: Option<String>,
) -> GlFindingsOut {
    let secure = || GlSecureCategoryOut {
        availability,
        detail: detail.clone(),
        findings: Vec::new(),
        truncated: false,
    };
    GlFindingsOut {
        pipeline_state: state,
        pipeline,
        requested_ref: refs.requested_ref,
        used_fallback: refs.used_fallback,
        fallback_ref: refs.fallback_ref,
        project_web_url: refs.project_web_url,
        sast: secure(),
        secret_detection: secure(),
        code_quality: GlCodeQualityCategoryOut {
            availability,
            detail,
            findings: Vec::new(),
            truncated: false,
        },
    }
}

// ── Transport ────────────────────────────────────────────────────────────────

/// A list endpoint's items, or a classified unavailability.
enum Listed<T> {
    Items(Vec<T>),
    Unavailable(GlFindingAvailability, Option<String>),
}

/// The checked-out branch, or `"HEAD"` when detached (or unreadable) — read with
/// the same `rev-parse --abbrev-ref HEAD` shape as the rest of the app.
async fn current_branch(repo_path: &str) -> String {
    crate::git::runner::run_git_raw(
        Some(repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        crate::git::runner::DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .filter(|o| o.code == 0)
    .map(|o| o.stdout_lossy().trim().to_string())
    .filter(|b| !b.is_empty())
    .unwrap_or_else(|| "HEAD".to_string())
}

async fn fetch_json<T: serde::de::DeserializeOwned>(
    repo_path: &str,
    endpoint: &str,
    what: &str,
) -> AppResult<Listed<T>> {
    let out = run_glab_raw(Some(repo_path), &["api", endpoint], GLAB_NETWORK_TIMEOUT).await?;
    let stdout = out.stdout_lossy();
    if out.code != 0 {
        let (availability, detail) = classify_call_failure(&stdout, &out.stderr);
        return Ok(Listed::Unavailable(availability, detail));
    }
    match serde_json::from_str::<Vec<T>>(stdout.trim()) {
        Ok(items) => Ok(Listed::Items(items)),
        Err(e) => Ok(Listed::Unavailable(
            GlFindingAvailability::Indeterminate,
            Some(format!("could not read GitLab's {what}: {e}")),
        )),
    }
}

/// Recent pipelines for one ref. The `pipelines/latest?ref=` endpoint is BANNED
/// here: it answers a ref with no pipelines with a bare `{"message":"403
/// Forbidden"}` (measured 2026-08-11, gitlab.com), which would read as a
/// permissions problem; the list endpoint answers `[]` honestly.
/// The pipeline window. Wide enough to survive an auto-cancel storm: interrupted
/// pushes fill the newest entries with `canceled` pipelines, and a window that
/// holds only those would report "nothing has finished" for a branch that has.
const PIPELINE_WINDOW: u32 = 50;

async fn fetch_pipelines(
    repo_path: &str,
    enc: &str,
    git_ref: &str,
) -> AppResult<Listed<RawPipeline>> {
    let endpoint = format!(
        "projects/{enc}/pipelines?ref={}&per_page={PIPELINE_WINDOW}",
        encode_query_value(git_ref)
    );
    fetch_json(repo_path, &endpoint, "pipelines").await
}

/// GitLab caps a list page at 100.
const JOBS_PER_PAGE: usize = 100;
/// The list walk's ceiling, for jobs and bridges alike. Either can run past one
/// page — a fan-out pipeline's jobs, a many-way `trigger:` matrix's bridges — but
/// both can also run to thousands, so three pages covers every realistic pipeline
/// without an unbounded walk on a pathological one.
const MAX_LIST_PAGES: u32 = 3;
/// How many downstream (child) pipelines a parent's bridges may contribute. The
/// walk is ONE level deep: a grandchild would need its own bridges walk, and each
/// child costs a serial page walk at up to 120 s per call.
const MAX_BRIDGES: usize = 3;

/// Whether the walk continues: a short page is the last one, and the ceiling
/// stops a full page from paging forever.
fn has_more_list_pages(page: u32, page_len: usize) -> bool {
    page < MAX_LIST_PAGES && page_len == JOBS_PER_PAGE
}

/// Walks a 100-per-page list endpoint to the ceiling. `base` must already carry a
/// query string — the page number is appended as `&page=`.
async fn fetch_paged<T: serde::de::DeserializeOwned>(
    repo_path: &str,
    base: &str,
    what: &str,
) -> AppResult<Listed<T>> {
    let mut all: Vec<T> = Vec::new();
    for page in 1..=MAX_LIST_PAGES {
        match fetch_json::<T>(repo_path, &format!("{base}&page={page}"), what).await? {
            Listed::Items(items) => {
                let page_len = items.len();
                all.extend(items);
                if !has_more_list_pages(page, page_len) {
                    break;
                }
            }
            // A later page failing must not erase what was already read; only a
            // failure with nothing in hand leaves the category unclassified.
            Listed::Unavailable(availability, detail) => {
                if all.is_empty() {
                    return Ok(Listed::Unavailable(availability, detail));
                }
                break;
            }
        }
    }
    Ok(Listed::Items(all))
}

/// Every job of a pipeline, up to the walk's ceiling.
async fn fetch_jobs(repo_path: &str, enc: &str, pipeline_id: u64) -> AppResult<Listed<RawJob>> {
    let base = format!("projects/{enc}/pipelines/{pipeline_id}/jobs?per_page={JOBS_PER_PAGE}");
    fetch_paged(repo_path, &base, "pipeline jobs").await
}

/// A pipeline's `trigger:` jobs. Measured 2026-08-11: the endpoint answers `[]`
/// on a pipeline with no bridges, so the child walk costs nothing on the common
/// single-pipeline layout.
async fn fetch_bridges(
    repo_path: &str,
    enc: &str,
    pipeline_id: u64,
) -> AppResult<Listed<RawBridge>> {
    let base = format!("projects/{enc}/pipelines/{pipeline_id}/bridges?per_page={JOBS_PER_PAGE}");
    fetch_paged(repo_path, &base, "pipeline bridges").await
}

/// The child pipelines a bridge set points at, in order, deduped and capped.
/// SAME-PROJECT children only: the endpoint lists multi-project (`trigger:
/// project:`) bridges too, and a foreign pipeline id is another project's data —
/// never walked, and never allowed to consume the bridge budget. A bridge with no
/// `downstream_pipeline` never triggered, and an unstated project can't be proven
/// local, so both contribute nothing.
fn downstream_pipeline_ids(bridges: &[RawBridge], project_id: Option<u64>) -> Vec<u64> {
    let Some(project_id) = project_id else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    bridges
        .iter()
        .filter_map(|b| {
            let downstream = b.downstream_pipeline.as_ref()?;
            (downstream.project_id? == project_id).then_some(downstream.id?)
        })
        .filter(|id| seen.insert(*id))
        .take(MAX_BRIDGES)
        .collect()
}

/// Whether a child-pipeline walk could still add anything: any category the
/// parent's own jobs don't already answer. On the common single-pipeline layout
/// every category is answered, so the bridges call never happens.
fn needs_child_jobs(jobs: &[RawJob]) -> bool {
    [
        SAST_FILE_TYPE,
        SECRET_DETECTION_FILE_TYPE,
        CODE_QUALITY_FILE_TYPE,
    ]
    .iter()
    .any(|file_type| candidates(jobs, file_type).is_empty())
}

/// The artifact download endpoint. The filename is third-party data off the job
/// metadata, so it is percent-encoded rather than interpolated.
fn artifact_endpoint(enc: &str, job_id: u64, filename: &str) -> String {
    format!(
        "projects/{enc}/jobs/{job_id}/artifacts/{}",
        encode_query_value(filename)
    )
}

/// Every candidate report of one category, downloaded. A transport failure is
/// contained here: escaping as `Err` would take the pipeline provenance and both
/// sibling categories down with one slow download.
async fn fetch_category(
    repo_path: &str,
    enc: &str,
    jobs: &[RawJob],
    file_type: &str,
    now: DateTime<Utc>,
) -> CategoryFetch {
    let refs = candidates(jobs, file_type);
    let mut fetch = CategoryFetch {
        had_candidates: !refs.is_empty(),
        ..CategoryFetch::default()
    };
    for artifact in refs {
        let endpoint = artifact_endpoint(enc, artifact.job_id, &artifact.filename);
        let outcome =
            match run_glab_raw(Some(repo_path), &["api", &endpoint], GLAB_NETWORK_TIMEOUT).await {
                Ok(out) => artifact_outcome(out, artifact.expire_at.as_deref(), now),
                Err(e) => Err((GlFindingAvailability::Indeterminate, Some(e.to_string()))),
            };
        match outcome {
            Ok(body) => fetch.bodies.push(body),
            Err(failure) => {
                fetch.lost_reports += 1;
                fetch.failure.get_or_insert(failure);
            }
        }
    }
    fetch
}

/// The security and quality findings of the newest completed pipeline on the
/// checked-out branch, falling back to the default branch when that ref has none.
pub async fn pipeline_findings(repo_path: &str, limit: Option<u32>) -> AppResult<GlFindingsOut> {
    let cap = clamp_limit(limit);
    let enc = encode_project(&project_path(repo_path).await?);
    let requested_ref = current_branch(repo_path).await;
    let mut refs = RefContext {
        requested_ref,
        used_fallback: false,
        fallback_ref: None,
        project_web_url: None,
    };

    let out = run_glab_raw(
        Some(repo_path),
        &["api", &format!("projects/{enc}")],
        GLAB_NETWORK_TIMEOUT,
    )
    .await?;
    let stdout = out.stdout_lossy();
    if out.code != 0 {
        let (availability, detail) = classify_call_failure(&stdout, &out.stderr);
        return Ok(uniform_out(
            GlPipelineState::Unavailable,
            None,
            refs,
            availability,
            detail,
        ));
    }
    let Ok(project) = serde_json::from_str::<RawProject>(stdout.trim()) else {
        return Ok(uniform_out(
            GlPipelineState::Unavailable,
            None,
            refs,
            GlFindingAvailability::Indeterminate,
            Some("could not read GitLab's project response".to_string()),
        ));
    };
    let default_branch = project.default_branch.unwrap_or_default();
    let project_id = project.id;
    refs.project_web_url = project
        .web_url
        .map(|u| u.trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty());

    // A detached HEAD names no ref GitLab can filter on, so it goes straight to
    // the default branch.
    let detached = refs.requested_ref == "HEAD";
    let mut pipelines: Vec<RawPipeline> = Vec::new();
    if !detached {
        match fetch_pipelines(repo_path, &enc, &refs.requested_ref).await? {
            Listed::Items(items) => pipelines = items,
            Listed::Unavailable(availability, detail) => {
                return Ok(uniform_out(
                    GlPipelineState::Unavailable,
                    None,
                    refs,
                    availability,
                    detail,
                ))
            }
        }
    }
    if pipelines.is_empty() && !default_branch.is_empty() && default_branch != refs.requested_ref {
        match fetch_pipelines(repo_path, &enc, &default_branch).await? {
            Listed::Items(items) => {
                if !items.is_empty() {
                    refs.used_fallback = true;
                    refs.fallback_ref = Some(default_branch);
                    pipelines = items;
                }
            }
            Listed::Unavailable(availability, detail) => {
                return Ok(uniform_out(
                    GlPipelineState::Unavailable,
                    None,
                    refs,
                    availability,
                    detail,
                ))
            }
        }
    }
    if pipelines.is_empty() {
        return Ok(uniform_out(
            GlPipelineState::None,
            None,
            refs,
            GlFindingAvailability::NotConfigured,
            None,
        ));
    }
    let Some(chosen) = pick_pipeline(pipelines) else {
        return Ok(uniform_out(
            GlPipelineState::RunningOnly,
            None,
            refs,
            GlFindingAvailability::AnalysisPending,
            None,
        ));
    };
    let pipeline_id = chosen.id.unwrap_or(0);
    let pipeline = pipeline_ref_out(chosen);

    let mut jobs = match fetch_jobs(repo_path, &enc, pipeline_id).await? {
        Listed::Items(items) => items,
        Listed::Unavailable(availability, detail) => {
            return Ok(uniform_out(
                GlPipelineState::Found,
                Some(pipeline),
                refs,
                availability,
                detail,
            ))
        }
    };
    // A monorepo that scans in a child pipeline publishes its reports on the
    // CHILD's jobs, which the parent's jobs endpoint never lists — but only a
    // category the parent leaves unanswered can gain anything, so the common
    // single-pipeline layout never pays for the extra calls. Failures here are
    // swallowed on purpose: a bridges hiccup must not turn a good read into an
    // error when the parent's own jobs already answered.
    if needs_child_jobs(&jobs) {
        if let Ok(Listed::Items(bridges)) = fetch_bridges(repo_path, &enc, pipeline_id).await {
            for child_id in downstream_pipeline_ids(&bridges, project_id) {
                if let Ok(Listed::Items(child_jobs)) = fetch_jobs(repo_path, &enc, child_id).await {
                    jobs.extend(child_jobs);
                }
            }
        }
    }

    let now = Utc::now();
    let sast = fetch_category(repo_path, &enc, &jobs, SAST_FILE_TYPE, now).await;
    let secrets = fetch_category(repo_path, &enc, &jobs, SECRET_DETECTION_FILE_TYPE, now).await;
    let quality = fetch_category(repo_path, &enc, &jobs, CODE_QUALITY_FILE_TYPE, now).await;

    Ok(GlFindingsOut {
        pipeline_state: GlPipelineState::Found,
        pipeline: Some(pipeline),
        requested_ref: refs.requested_ref,
        used_fallback: refs.used_fallback,
        fallback_ref: refs.fallback_ref,
        project_web_url: refs.project_web_url,
        sast: secure_envelope(sast, cap),
        secret_detection: secure_envelope(secrets, cap),
        code_quality: code_quality_envelope(quality, cap),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Trimmed from a real gitlab.com SAST artifact (schema 15.2.2).
    const SAST_REPORT: &str = r#"{
      "version": "15.2.2",
      "vulnerabilities": [
        {
          "id": "26f562dd73ffc7044509b75c97c82528bf01abd0023dc728c4ad417caad55339",
          "category": "sast",
          "name": "Improper neutralization of directives in dynamically evaluated code",
          "description": "The application was found calling the `eval` function.",
          "cve": "semgrep_id:bandit.B307:21:21",
          "severity": "High",
          "scanner": { "id": "semgrep", "name": "Semgrep" },
          "location": { "file": "src/app.py", "start_line": 21 },
          "identifiers": [
            { "type": "semgrep_id", "name": "bandit.B307", "value": "bandit.B307",
              "url": "https://semgrep.dev/r/gitlab.bandit.B307" },
            { "type": "cwe", "name": "CWE-95", "value": "95",
              "url": "https://cwe.mitre.org/data/definitions/95.html" }
          ]
        },
        {
          "id": "8b46a585c8bc6d909ca9ca99209f42fcd6c11e89c026ab2f7c872ce5e77f68c3",
          "category": "sast",
          "name": "Use of a broken or risky cryptographic algorithm",
          "description": "The application was found using an insecure digest algorithm.",
          "cve": "semgrep_id:bandit.B303-1:26:26",
          "severity": "Medium",
          "scanner": { "id": "semgrep", "name": "Semgrep" },
          "location": { "file": "src/app.py", "start_line": 26 },
          "identifiers": [
            { "type": "cwe", "name": "CWE-327", "value": "327",
              "url": "https://cwe.mitre.org/data/definitions/327.html" }
          ]
        }
      ],
      "scan": { "type": "sast", "status": "success" }
    }"#;

    /// Trimmed from a real gitlab.com secret-detection artifact (schema 15.2.4).
    /// The credentials in it are fixtures — they are what the strip test asserts on.
    const SECRET_REPORT: &str = r#"{
      "version": "15.2.4",
      "vulnerabilities": [
        {
          "id": "ab833bb20d198f25e85ffcd6c46cb1c489c21b6e67ab423fae27d4f587281ff3",
          "category": "secret_detection",
          "name": "RSA private key",
          "description": "An RSA private key was identified.",
          "cve": "config/deploy-config.py:8bcac7908eb95041:RSA private key",
          "severity": "Critical",
          "confidence": "Unknown",
          "raw_source_code_extract": "-----BEGIN RSA PRIVATE KEY-----",
          "scanner": { "id": "gitleaks", "name": "Gitleaks" },
          "location": { "file": "config/deploy-config.py", "start_line": 9 },
          "identifiers": [
            { "type": "gitleaks_rule_id", "name": "Gitleaks rule ID RSA private key",
              "value": "RSA private key" }
          ]
        },
        {
          "id": "b3519db96df50f6c2176378a4b422d453585e1dc6192f20a02ef9258b594f7d8",
          "category": "secret_detection",
          "name": "GitLab personal access token",
          "description": "A GitLab personal access token was identified.",
          "cve": "config/deploy-config.py:ac641ef297c9dba8:gitlab_personal_access_token",
          "severity": "Critical",
          "confidence": "Unknown",
          "raw_source_code_extract": "FAKE-EXTRACT-SENTINEL-000",
          "scanner": { "id": "gitleaks", "name": "Gitleaks" },
          "location": { "file": "config/deploy-config.py", "start_line": 7 },
          "identifiers": [
            { "type": "gitleaks_rule_id", "name": "Gitleaks rule ID gitlab_personal_access_token",
              "value": "gitlab_personal_access_token" }
          ]
        }
      ],
      "scan": { "type": "secret_detection", "status": "success" }
    }"#;

    /// A real gitlab.com codequality artifact, plus one `positions`-shaped item —
    /// CodeClimate allows either line shape.
    const CQ_REPORT: &str = r#"[
      { "description": "Function runQuery has a cognitive complexity of 12.",
        "check_name": "cognitive-complexity", "fingerprint": "cq-fixture-0001",
        "severity": "major", "location": { "path": "src/server.js", "lines": { "begin": 6 } } },
      { "description": "Similar blocks of code found in 2 locations.",
        "check_name": "duplicate-code", "fingerprint": "cq-fixture-0002",
        "severity": "minor", "location": { "path": "src/app.py", "lines": { "begin": 9 } } },
      { "description": "Avoid deeply nested control flow statements.",
        "check_name": "nested-control-flow", "fingerprint": "cq-fixture-0003",
        "severity": "critical", "location": { "path": "src/app.py", "lines": { "begin": 17 } } },
      { "description": "TODO found: remove debug logging before release.",
        "check_name": "fixme", "fingerprint": "cq-fixture-0004",
        "severity": "info",
        "location": { "path": "src/server.js", "positions": { "begin": { "line": 13 } } } }
    ]"#;

    fn bodies(reports: &[&str]) -> CategoryFetch {
        CategoryFetch {
            had_candidates: true,
            bodies: reports.iter().map(|r| r.as_bytes().to_vec()).collect(),
            failure: None,
            lost_reports: 0,
        }
    }

    fn ok_output(stdout: &[u8]) -> GlabOutput {
        GlabOutput {
            stdout: stdout.to_vec(),
            stderr: String::new(),
            code: 0,
        }
    }

    fn failed_output(stdout: &str, stderr: &str) -> GlabOutput {
        GlabOutput {
            stdout: stdout.as_bytes().to_vec(),
            stderr: stderr.to_string(),
            code: 1,
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-08-11T18:00:00Z")
            .expect("fixed clock parses")
            .with_timezone(&Utc)
    }

    #[test]
    fn wire_shape_is_pinned() {
        let out = GlFindingsOut {
            pipeline_state: GlPipelineState::Found,
            pipeline: Some(GlPipelineRefOut {
                id: 2751382498,
                iid: 57,
                status: "success".into(),
                sha: "eb1e0a68".into(),
                git_ref: "main".into(),
                web_url: "https://gitlab.com/g/r/-/pipelines/2751382498".into(),
                created_at: "2026-08-11T17:11:33.295Z".into(),
                finished_at: None,
            }),
            requested_ref: "feature".into(),
            used_fallback: true,
            fallback_ref: Some("main".into()),
            project_web_url: Some("https://gitlab.com/g/r".into()),
            sast: secure_envelope(bodies(&[SAST_REPORT]), 100),
            secret_detection: GlSecureCategoryOut {
                availability: GlFindingAvailability::Expired,
                detail: Some("the job's artifacts expired on 2026-08-01T00:00:00Z".into()),
                findings: Vec::new(),
                truncated: false,
            },
            code_quality: code_quality_envelope(bodies(&[CQ_REPORT]), 1),
        };
        let value = serde_json::to_value(&out).expect("envelope serializes");
        assert_eq!(value["pipelineState"], json!("found"));
        assert_eq!(value["requestedRef"], json!("feature"));
        assert_eq!(value["usedFallback"], json!(true));
        assert_eq!(value["fallbackRef"], json!("main"));
        assert_eq!(value["projectWebUrl"], json!("https://gitlab.com/g/r"));
        // `ref` and `type` are hand-pinned around the Rust keywords.
        assert_eq!(value["pipeline"]["ref"], json!("main"));
        assert_eq!(value["pipeline"]["iid"], json!(57));
        assert_eq!(
            value["pipeline"]["webUrl"],
            json!("https://gitlab.com/g/r/-/pipelines/2751382498")
        );
        assert_eq!(
            value["pipeline"]["createdAt"],
            json!("2026-08-11T17:11:33.295Z")
        );
        assert_eq!(value["pipeline"]["finishedAt"], json!(null));
        assert_eq!(value["sast"]["availability"], json!("available"));
        assert_eq!(value["sast"]["truncated"], json!(false));
        let finding = &value["sast"]["findings"][0];
        assert_eq!(finding["severity"], json!("High"));
        assert_eq!(finding["file"], json!("src/app.py"));
        assert_eq!(finding["startLine"], json!(21));
        assert_eq!(finding["endLine"], json!(null));
        assert_eq!(finding["scannerName"], json!("Semgrep"));
        assert_eq!(finding["identifiers"][0]["type"], json!("semgrep_id"));
        assert_eq!(finding["identifiers"][0]["value"], json!("bandit.B307"));
        assert_eq!(
            finding["identifiers"][0]["url"],
            json!("https://semgrep.dev/r/gitlab.bandit.B307")
        );
        assert_eq!(value["secretDetection"]["availability"], json!("expired"));
        let cq = &value["codeQuality"]["findings"][0];
        assert_eq!(cq["checkName"], json!("nested-control-flow"));
        assert_eq!(cq["fingerprint"], json!("cq-fixture-0003"));
        assert_eq!(cq["severity"], json!("critical"));
        assert_eq!(cq["path"], json!("src/app.py"));
        assert_eq!(cq["line"], json!(17));
        assert_eq!(value["codeQuality"]["truncated"], json!(true));
    }

    #[test]
    fn availability_and_state_wire_strings_are_pinned() {
        for (variant, wire) in [
            (GlFindingAvailability::Available, "available"),
            (GlFindingAvailability::NotConfigured, "notConfigured"),
            (
                GlFindingAvailability::ReportNotReadable,
                "reportNotReadable",
            ),
            (GlFindingAvailability::Expired, "expired"),
            (GlFindingAvailability::AnalysisPending, "analysisPending"),
            (GlFindingAvailability::Forbidden, "forbidden"),
            (GlFindingAvailability::Indeterminate, "indeterminate"),
        ] {
            assert_eq!(serde_json::to_value(variant).unwrap(), json!(wire));
        }
        for (variant, wire) in [
            (GlPipelineState::Found, "found"),
            (GlPipelineState::None, "none"),
            (GlPipelineState::RunningOnly, "runningOnly"),
            (GlPipelineState::Unavailable, "unavailable"),
        ] {
            assert_eq!(serde_json::to_value(variant).unwrap(), json!(wire));
        }
    }

    #[test]
    fn the_leaked_secret_never_reaches_the_wire() {
        // The input really does carry the extract — otherwise this passes vacuously.
        // (Sentinel value, not a token shape: GitHub push protection blocks anything
        // matching a real credential pattern, even a fake.)
        assert!(SECRET_REPORT.contains("FAKE-EXTRACT-SENTINEL-000"));
        assert!(SECRET_REPORT.contains("BEGIN RSA PRIVATE KEY"));
        let envelope = secure_envelope(bodies(&[SECRET_REPORT]), 100);
        assert_eq!(envelope.availability, GlFindingAvailability::Available);
        assert_eq!(envelope.findings.len(), 2);
        let json = serde_json::to_string(&envelope).expect("envelope serializes");
        // `raw_source_code_extract` is undeclared, so the extract can't survive the
        // round trip; `cve` on secret detection is a fingerprint composite, not a CVE.
        assert!(!json.contains("FAKE-EXTRACT-SENTINEL-000"), "{json}");
        assert!(!json.contains("BEGIN RSA PRIVATE KEY"), "{json}");
        assert!(!json.contains("rawSourceCodeExtract"), "{json}");
        assert!(
            !json.contains("deploy-config.py:ac641ef297c9dba8"),
            "{json}"
        );
    }

    #[test]
    fn sast_report_maps_every_field() {
        let envelope = secure_envelope(bodies(&[SAST_REPORT]), 100);
        let first = &envelope.findings[0];
        assert_eq!(
            first.id,
            "26f562dd73ffc7044509b75c97c82528bf01abd0023dc728c4ad417caad55339"
        );
        assert_eq!(
            first.name,
            "Improper neutralization of directives in dynamically evaluated code"
        );
        assert_eq!(first.severity, "High");
        assert_eq!(first.file, "src/app.py");
        assert_eq!(first.start_line, Some(21));
        assert_eq!(first.end_line, None);
        assert_eq!(first.scanner_name, "Semgrep");
        assert_eq!(first.identifiers.len(), 2);
        assert_eq!(first.identifiers[1].identifier_type, "cwe");
        assert_eq!(first.identifiers[1].value, "95");
        assert!(first.description.starts_with("The application was found"));
    }

    #[test]
    fn code_quality_reads_either_line_shape() {
        let envelope = code_quality_envelope(bodies(&[CQ_REPORT]), 100);
        assert_eq!(envelope.availability, GlFindingAvailability::Available);
        let by_check = |name: &str| {
            envelope
                .findings
                .iter()
                .find(|f| f.check_name == name)
                .expect("check present")
                .line
        };
        assert_eq!(by_check("cognitive-complexity"), Some(6)); // location.lines.begin
        assert_eq!(by_check("fixme"), Some(13)); // location.positions.begin.line
    }

    #[test]
    fn a_sparse_finding_degrades_field_by_field() {
        let report = r#"{"vulnerabilities":[{"id":"only-an-id"}]}"#;
        let envelope = secure_envelope(bodies(&[report]), 100);
        let first = &envelope.findings[0];
        assert_eq!(first.id, "only-an-id");
        assert_eq!(first.severity, "");
        assert_eq!(first.file, "");
        assert_eq!(first.start_line, None);
        assert!(first.identifiers.is_empty());
    }

    #[test]
    fn a_bare_403_reads_as_forbidden() {
        // GitLab Free sends no explanation at all with a paywalled/unauthorized read.
        let out = failed_output(r#"{"message":"403 Forbidden"}"#, "glab: HTTP 403");
        let Err((availability, detail)) = artifact_outcome(out, None, now()) else {
            panic!("a 403 is not a readable report");
        };
        assert_eq!(availability, GlFindingAvailability::Forbidden);
        assert_eq!(detail.as_deref(), Some("403 Forbidden"));
        // The same classifier runs on the project/pipelines calls.
        let (availability, _) = classify_call_failure("", "glab: HTTP 403 Forbidden");
        assert_eq!(availability, GlFindingAvailability::Forbidden);
    }

    #[test]
    fn an_expired_artifact_is_told_from_one_the_api_wont_serve() {
        // Measured 404 shape: glab prints `404 page not found` and `glab: HTTP 404`.
        let expired = artifact_outcome(
            failed_output("404 page not found", "glab: HTTP 404"),
            Some("2026-08-01T12:00:00Z"),
            now(),
        );
        assert_eq!(
            expired.unwrap_err().0,
            GlFindingAvailability::Expired,
            "a past artifacts_expire_at explains the 404"
        );
        // No expiry (artifacts kept) → the report is declared but unserved.
        let not_readable = artifact_outcome(
            failed_output("404 page not found", "glab: HTTP 404"),
            None,
            now(),
        );
        assert_eq!(
            not_readable.unwrap_err().0,
            GlFindingAvailability::ReportNotReadable
        );
        // An expiry still in the future can't explain it either.
        let future = artifact_outcome(
            failed_output("404 page not found", "glab: HTTP 404"),
            Some("2026-09-10T17:11:43.795Z"),
            now(),
        );
        assert_eq!(
            future.unwrap_err().0,
            GlFindingAvailability::ReportNotReadable
        );
    }

    #[test]
    fn an_oversized_report_is_refused_rather_than_parsed() {
        let outcome = artifact_outcome(ok_output(&vec![b'x'; MAX_REPORT_BYTES + 1]), None, now());
        let (availability, detail) = outcome.unwrap_err();
        assert_eq!(availability, GlFindingAvailability::Indeterminate);
        assert_eq!(detail.as_deref(), Some("the report was too large to read"));
    }

    #[test]
    fn a_category_with_no_candidate_job_is_not_configured() {
        let jobs: Vec<RawJob> = serde_json::from_value(json!([
            { "id": 1, "artifacts": [{ "file_type": "trace", "filename": "job.log" }] },
            { "id": 2, "artifacts": [
                { "file_type": "archive", "filename": "artifacts.zip" },
                { "file_type": "codequality", "filename": "gl-code-quality-report.json" }
            ], "artifacts_expire_at": "2026-09-10T17:11:43.795Z" }
        ]))
        .expect("jobs deserialize");
        assert!(candidates(&jobs, SAST_FILE_TYPE).is_empty());
        assert_eq!(
            candidates(&jobs, CODE_QUALITY_FILE_TYPE),
            vec![ArtifactRef {
                job_id: 2,
                filename: "gl-code-quality-report.json".into(),
                expire_at: Some("2026-09-10T17:11:43.795Z".into()),
            }]
        );
        let envelope = secure_envelope(CategoryFetch::default(), 100);
        assert_eq!(envelope.availability, GlFindingAvailability::NotConfigured);
        assert!(envelope.findings.is_empty());
        assert_eq!(envelope.detail, None);
    }

    #[test]
    fn a_parsed_empty_report_is_the_clean_state() {
        let envelope = secure_envelope(
            bodies(&[r#"{"version":"15.2.2","vulnerabilities":[]}"#]),
            100,
        );
        assert_eq!(envelope.availability, GlFindingAvailability::Available);
        assert!(envelope.findings.is_empty());
        assert!(!envelope.truncated);
        let cq = code_quality_envelope(bodies(&["[]"]), 100);
        assert_eq!(cq.availability, GlFindingAvailability::Available);
        assert!(cq.findings.is_empty());
    }

    #[test]
    fn a_window_that_parsed_away_is_indeterminate_with_its_count() {
        // Items of the wrong TYPE (severity as a number, identifiers as a string)
        // survive the report parse but not their own — an empty Available list here
        // would claim the project is clean.
        let report =
            r#"{"vulnerabilities":[{"id":"a","severity":7},{"id":"b","identifiers":"nope"}]}"#;
        let envelope = secure_envelope(bodies(&[report]), 100);
        assert_eq!(envelope.availability, GlFindingAvailability::Indeterminate);
        assert_eq!(
            envelope.detail.as_deref(),
            Some("GitLab returned 2 findings this build couldn't read")
        );
        // A body that isn't a report at all is unreadable, not clean — and with no
        // item count to report, it says so without a number.
        let garbage = code_quality_envelope(bodies(&["<html>502</html>"]), 100);
        assert_eq!(garbage.availability, GlFindingAvailability::Indeterminate);
        assert_eq!(
            garbage.detail.as_deref(),
            Some("GitLab returned a report this build couldn't read")
        );
    }

    #[test]
    fn a_report_without_a_vulnerabilities_key_is_never_clean() {
        // An analyzer that failed internally can emit a body with no findings KEY;
        // reading that as zero findings would render "No SAST findings".
        for body in [
            r#"{"version":"15.2.2"}"#,
            "{}",
            r#"{"scan":{"status":"failure"}}"#,
        ] {
            let envelope = secure_envelope(bodies(&[body]), 100);
            assert_eq!(
                envelope.availability,
                GlFindingAvailability::Indeterminate,
                "{body}"
            );
            assert_eq!(
                envelope.detail.as_deref(),
                Some("GitLab returned a report this build couldn't read")
            );
        }
        // The key present and empty IS the clean state.
        assert_eq!(
            secure_envelope(bodies(&[r#"{"vulnerabilities":[]}"#]), 100).availability,
            GlFindingAvailability::Available
        );
    }

    #[test]
    fn id_less_findings_are_not_deduped_into_one() {
        // A report with no `id` must not collapse on the empty string.
        let report = r#"{"vulnerabilities":[
          { "name": "Hardcoded password", "severity": "High",
            "location": { "file": "a.py", "start_line": 3 } },
          { "name": "Hardcoded password", "severity": "High",
            "location": { "file": "b.py", "start_line": 3 } },
          { "name": "Hardcoded password", "severity": "High",
            "location": { "file": "c.py", "start_line": 3 } }
        ]}"#;
        let envelope = secure_envelope(bodies(&[report]), 100);
        assert_eq!(envelope.availability, GlFindingAvailability::Available);
        assert_eq!(envelope.findings.len(), 3);
        // The same id-less finding at the same place still dedupes.
        assert_eq!(
            secure_envelope(bodies(&[report, report]), 100)
                .findings
                .len(),
            3
        );
    }

    #[test]
    fn a_partly_unreadable_category_says_how_much_it_lost() {
        // One good report + one body that isn't a report: the list is short, not
        // wrong, so it stays Available and carries the loss as a notice.
        let fetch = bodies(&[SAST_REPORT, "<html>502 Bad Gateway</html>"]);
        let envelope = secure_envelope(fetch, 100);
        assert_eq!(envelope.availability, GlFindingAvailability::Available);
        assert_eq!(envelope.findings.len(), 2);
        // A body that wasn't a readable report is a lost REPORT, not one finding.
        assert_eq!(
            envelope.detail.as_deref(),
            Some("1 report couldn't be read")
        );
        // Per-ITEM losses count in findings, and pluralize.
        let partial = r#"{"vulnerabilities":[
          { "id": "good", "severity": "Low" },
          { "id": "bad", "severity": 7 },
          { "id": "worse", "identifiers": "nope" }
        ]}"#;
        let envelope = secure_envelope(bodies(&[partial]), 100);
        assert_eq!(envelope.availability, GlFindingAvailability::Available);
        assert_eq!(envelope.findings.len(), 1);
        assert_eq!(
            envelope.detail.as_deref(),
            Some("2 findings couldn't be read")
        );
        // A report that failed to DOWNLOAD counts in reports, next to one that
        // parsed — never folded into the finding count, whose size it can't know.
        let mut mixed = bodies(&[CQ_REPORT]);
        mixed.lost_reports = 1;
        let cq = code_quality_envelope(mixed, 100);
        assert_eq!(cq.availability, GlFindingAvailability::Available);
        assert_eq!(cq.findings.len(), 4);
        assert_eq!(cq.detail.as_deref(), Some("1 report couldn't be read"));
        // Both kinds at once keep their own units.
        let mut both = bodies(&[partial, "<html>502</html>"]);
        both.lost_reports = 1;
        assert_eq!(
            secure_envelope(both, 100).detail.as_deref(),
            Some("2 reports and 2 findings couldn't be read")
        );
        // Nothing lost → no notice.
        assert_eq!(secure_envelope(bodies(&[SAST_REPORT]), 100).detail, None);
    }

    #[test]
    fn code_quality_identity_includes_the_check() {
        // One fingerprint, two checks, same line: two findings, not one.
        let report = r#"[
          { "fingerprint": "f", "check_name": "duplicate-code", "severity": "minor",
            "location": { "path": "a.js", "lines": { "begin": 1 } } },
          { "fingerprint": "f", "check_name": "cognitive-complexity", "severity": "minor",
            "location": { "path": "a.js", "lines": { "begin": 1 } } }
        ]"#;
        assert_eq!(
            code_quality_envelope(bodies(&[report]), 100).findings.len(),
            2
        );
    }

    #[test]
    fn a_large_body_cannot_classify_the_failure() {
        // A report echoed on a failed call can carry "forbidden" in rule prose; only
        // the server's message and glab's stderr may classify.
        let mut prose = String::from("Improper access control: the resource is forbidden. ");
        while prose.len() <= MAX_ERROR_BODY_BYTES {
            prose.push_str("padding padding padding padding padding padding ");
        }
        let (availability, detail) = classify_call_failure(&prose, "glab: HTTP 500");
        assert_eq!(availability, GlFindingAvailability::Indeterminate);
        assert_eq!(detail.as_deref(), Some("glab: HTTP 500"));
        // Small, but not an error envelope: still no message to classify on.
        let (availability, _) =
            classify_call_failure(r#"[{"description":"forbidden pattern"}]"#, "glab: HTTP 500");
        assert_eq!(availability, GlFindingAvailability::Indeterminate);
    }

    #[test]
    fn the_artifact_filename_is_encoded() {
        // The plain case is pinned byte for byte — encoding must not disturb it.
        assert_eq!(
            artifact_endpoint("g%2Fr", 15838385685, "gl-sast-report.json"),
            "projects/g%2Fr/jobs/15838385685/artifacts/gl-sast-report.json"
        );
        // The filename comes off job metadata, so it can't be interpolated raw.
        assert_eq!(
            artifact_endpoint("g%2Fr", 1, "../../secrets?x=1"),
            "projects/g%2Fr/jobs/1/artifacts/..%2F..%2Fsecrets%3Fx%3D1"
        );
    }

    #[test]
    fn child_pipeline_jobs_join_the_candidate_pool() {
        // The parent runs only a build; the scanning happens in a child pipeline,
        // so reading the parent alone would report "not configured".
        let parent: Vec<RawJob> = serde_json::from_value(json!([
            { "id": 1, "artifacts": [{ "file_type": "trace", "filename": "job.log" }] }
        ]))
        .expect("parent jobs deserialize");
        let child: Vec<RawJob> = serde_json::from_value(json!([
            { "id": 90, "artifacts": [
                { "file_type": "sast", "filename": "gl-sast-report.json" }
            ], "artifacts_expire_at": "2026-09-10T17:11:43.795Z" }
        ]))
        .expect("child jobs deserialize");
        assert!(candidates(&parent, SAST_FILE_TYPE).is_empty());
        let mut merged = parent;
        merged.extend(child);
        assert_eq!(
            candidates(&merged, SAST_FILE_TYPE),
            vec![ArtifactRef {
                job_id: 90,
                filename: "gl-sast-report.json".into(),
                expire_at: Some("2026-09-10T17:11:43.795Z".into()),
            }]
        );
    }

    #[test]
    fn the_child_walk_only_runs_when_a_category_is_unanswered() {
        let all_three: Vec<RawJob> = serde_json::from_value(json!([
            { "id": 1, "artifacts": [
                { "file_type": "sast", "filename": "gl-sast-report.json" },
                { "file_type": "secret_detection", "filename": "gl-secret-detection-report.json" },
                { "file_type": "codequality", "filename": "gl-code-quality-report.json" }
            ] }
        ]))
        .expect("jobs deserialize");
        // Every category answered by the parent — the bridges call is pure cost.
        assert!(!needs_child_jobs(&all_three));
        // One category short still qualifies: the child may publish the rest.
        let two_of_three: Vec<RawJob> = serde_json::from_value(json!([
            { "id": 1, "artifacts": [
                { "file_type": "sast", "filename": "gl-sast-report.json" },
                { "file_type": "codequality", "filename": "gl-code-quality-report.json" }
            ] }
        ]))
        .expect("jobs deserialize");
        assert!(needs_child_jobs(&two_of_three));
        // A parent that scans nothing is the monorepo case this exists for.
        assert!(needs_child_jobs(&[]));
    }

    #[test]
    fn only_same_project_child_pipelines_are_walked() {
        // Field shape measured 2026-08-11 against a real parent-child pipeline.
        const PARENT: u64 = 83906586;
        let bridges: Vec<RawBridge> = serde_json::from_value(json!([
            // Never triggered, or the child failed to create — both send null.
            { "name": "trigger-web", "downstream_pipeline": null },
            { "name": "child-scans", "downstream_pipeline": {
                "id": 2752106301_u64, "project_id": PARENT, "ref": "main",
                "status": "success", "source": "parent_pipeline" } },
            // A multi-project `trigger: project:` bridge — another project's data.
            { "name": "trigger-other-repo", "downstream_pipeline": {
                "id": 2752106999_u64, "project_id": 12345678, "source": "pipeline" } },
            // Neither of these can be proven local or addressed.
            { "name": "trigger-docs", "downstream_pipeline": {} },
            { "name": "trigger-idless", "downstream_pipeline": { "project_id": PARENT } },
            // The same child listed twice is walked once.
            { "name": "child-scans-again", "downstream_pipeline": {
                "id": 2752106301_u64, "project_id": PARENT } }
        ]))
        .expect("bridges deserialize");
        assert_eq!(
            downstream_pipeline_ids(&bridges, Some(PARENT)),
            vec![2752106301]
        );
        // No bridges at all is the common case and contributes nothing.
        assert!(downstream_pipeline_ids(&[], Some(PARENT)).is_empty());
        // An unknown parent project can't prove any child local.
        assert!(downstream_pipeline_ids(&bridges, None).is_empty());
        // The cap bounds the serial child walks, and foreign ids never eat it.
        let many: Vec<RawBridge> = serde_json::from_value(json!((1..=10)
            .map(|i| json!({ "downstream_pipeline": { "id": i, "project_id": PARENT } }))
            .collect::<Vec<_>>()))
        .expect("bridges deserialize");
        assert_eq!(
            downstream_pipeline_ids(&many, Some(PARENT)).len(),
            MAX_BRIDGES
        );
    }

    #[test]
    fn the_list_walk_stops_on_a_short_page_or_the_ceiling() {
        assert!(has_more_list_pages(1, JOBS_PER_PAGE));
        assert!(has_more_list_pages(2, JOBS_PER_PAGE));
        // The ceiling stops a full page from paging forever.
        assert!(!has_more_list_pages(MAX_LIST_PAGES, JOBS_PER_PAGE));
        // A short page is the last one.
        assert!(!has_more_list_pages(1, JOBS_PER_PAGE - 1));
        assert!(!has_more_list_pages(1, 0));
    }

    #[test]
    fn a_download_failure_carries_its_classification_into_the_envelope() {
        let fetch = CategoryFetch {
            had_candidates: true,
            bodies: Vec::new(),
            failure: Some((
                GlFindingAvailability::ReportNotReadable,
                Some("the job lists this report but GitLab returned 404 for the file".into()),
            )),
            lost_reports: 1,
        };
        let envelope = secure_envelope(fetch, 100);
        assert_eq!(
            envelope.availability,
            GlFindingAvailability::ReportNotReadable
        );
        assert!(envelope.detail.is_some());
        assert!(envelope.findings.is_empty());
    }

    #[test]
    fn the_newest_completed_pipeline_wins_over_a_running_one() {
        let list: Vec<RawPipeline> = serde_json::from_value(json!([
            { "id": 3, "iid": 59, "status": "running", "ref": "main" },
            { "id": 2, "iid": 58, "status": "failed", "ref": "main", "sha": "beef" },
            { "id": 1, "iid": 57, "status": "success", "ref": "main" }
        ]))
        .expect("pipelines deserialize");
        let chosen = pick_pipeline(list).expect("a completed pipeline exists");
        assert_eq!(chosen.id, Some(2));
        let out = pipeline_ref_out(chosen);
        assert_eq!(out.status, "failed");
        assert_eq!(out.git_ref, "main");
        assert_eq!(out.sha, "beef");
        // The list payload carries no finish time (measured) — never invented.
        assert_eq!(out.finished_at, None);
    }

    #[test]
    fn a_pipeline_list_with_nothing_finished_has_no_pick() {
        let list: Vec<RawPipeline> = serde_json::from_value(json!([
            { "id": 3, "status": "running" },
            { "id": 2, "status": "pending" },
            // Canceled and skipped pipelines publish no artifacts either.
            { "id": 1, "status": "canceled" }
        ]))
        .expect("pipelines deserialize");
        assert!(pick_pipeline(list).is_none());
        assert!(pick_pipeline(Vec::new()).is_none());
    }

    #[test]
    fn the_same_finding_across_two_jobs_is_listed_once() {
        // Two SAST jobs (e.g. two analyzers) both publishing the same vulnerability.
        let envelope = secure_envelope(bodies(&[SAST_REPORT, SAST_REPORT]), 100);
        assert_eq!(envelope.findings.len(), 2);
        let cq = code_quality_envelope(bodies(&[CQ_REPORT, CQ_REPORT]), 100);
        assert_eq!(cq.findings.len(), 4);
        // Same fingerprint at a different location is a different finding.
        let moved = r#"[
          { "fingerprint": "f", "check_name": "c", "severity": "minor",
            "location": { "path": "a.js", "lines": { "begin": 1 } } },
          { "fingerprint": "f", "check_name": "c", "severity": "minor",
            "location": { "path": "b.js", "lines": { "begin": 1 } } }
        ]"#;
        assert_eq!(
            code_quality_envelope(bodies(&[moved]), 100).findings.len(),
            2
        );
    }

    #[test]
    fn truncation_keeps_the_worst_findings() {
        let report = r#"{"vulnerabilities":[
          { "id": "1", "severity": "Low" },
          { "id": "2", "severity": "unknown" },
          { "id": "3", "severity": "CRITICAL" },
          { "id": "4", "severity": "Medium" }
        ]}"#;
        let envelope = secure_envelope(bodies(&[report]), 2);
        assert!(envelope.truncated);
        let kept: Vec<&str> = envelope.findings.iter().map(|f| f.id.as_str()).collect();
        // Case-insensitive ladder, sorted before the cap.
        assert_eq!(kept, vec!["3", "4"]);
        // Blocker outranks critical on the CodeClimate ladder.
        let cq = code_quality_envelope(
            bodies(&[r#"[
              { "fingerprint": "a", "severity": "critical" },
              { "fingerprint": "b", "severity": "BLOCKER" },
              { "fingerprint": "c", "severity": "info" }
            ]"#]),
            1,
        );
        assert!(cq.truncated);
        assert_eq!(cq.findings[0].fingerprint, "b");
        // Nothing dropped → not truncated.
        assert!(!secure_envelope(bodies(&[report]), 4).truncated);
    }

    #[test]
    fn the_cap_is_clamped() {
        assert_eq!(clamp_limit(None), 100);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(25)), 25);
        assert_eq!(clamp_limit(Some(10_000)), 500);
    }

    #[test]
    fn artifact_expiry_needs_a_parseable_past_instant() {
        assert!(artifacts_expired(Some("2026-08-01T12:00:00Z"), now()));
        assert!(!artifacts_expired(Some("2026-09-10T17:11:43.795Z"), now()));
        assert!(!artifacts_expired(None, now()));
        assert!(!artifacts_expired(Some(""), now()));
        assert!(!artifacts_expired(Some("last Tuesday"), now()));
    }
}
