//! Commit-scoped Code Insights with explicit availability and bounded reads.

use std::future::Future;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri_plugin_http::reqwest::Url;

use super::bitbucket::{next_page_url, workspace_slug, BbPage, BB_MAX_PAGES};
use super::{encode_query_value, http};
use crate::error::AppResult;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum BbFindingsAvailability {
    Available,
    NoReports,
    RefNotFound,
    Forbidden,
    Indeterminate,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BbFindingsOut {
    pub availability: BbFindingsAvailability,
    /// Error/partial-loss disclosure; None when the read needs no disclosure.
    pub detail: Option<String>,
    pub requested_ref: String,
    pub used_fallback: bool,
    pub fallback_ref: Option<String>,
    pub default_ref: Option<String>,
    pub commit_sha: Option<String>,
    /// Only the API payload's target.links.html.href; never synthesized.
    pub commit_web_url: Option<String>,
    pub reports: Vec<BbReportOut>,
    pub truncated: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BbReportOut {
    pub uuid: String,
    pub external_id: Option<String>,
    pub title: Option<String>,
    pub details: Option<String>,
    pub report_type: Option<String>,
    pub reporter: Option<String>,
    pub result: Option<String>,
    pub link: Option<String>,
    pub created_on: Option<String>,
    pub data: Vec<BbReportDataOut>,
    pub annotations: Vec<BbAnnotationOut>,
    pub annotations_truncated: bool,
    /// This annotation read failed or lost rows; the loss is counted in detail.
    pub annotations_unreadable: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BbReportDataOut {
    pub title: Option<String>,
    #[serde(rename = "type")]
    pub data_type: Option<String>,
    pub value: Option<Value>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BbAnnotationOut {
    pub uuid: String,
    pub external_id: Option<String>,
    pub annotation_type: Option<String>,
    pub severity: Option<String>,
    pub summary: Option<String>,
    pub details: Option<String>,
    pub path: Option<String>,
    pub line: Option<u64>,
    pub link: Option<String>,
    pub result: Option<String>,
    pub created_on: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawReport {
    uuid: Option<String>,
    external_id: Option<String>,
    title: Option<String>,
    details: Option<String>,
    report_type: Option<String>,
    reporter: Option<String>,
    result: Option<String>,
    link: Option<String>,
    created_on: Option<String>,
    data: Option<Vec<RawReportData>>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawReportData {
    title: Option<String>,
    #[serde(rename = "type")]
    data_type: Option<String>,
    value: Option<Value>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawAnnotation {
    uuid: Option<String>,
    external_id: Option<String>,
    annotation_type: Option<String>,
    severity: Option<String>,
    summary: Option<String>,
    details: Option<String>,
    path: Option<String>,
    line: Option<u64>,
    link: Option<String>,
    result: Option<String>,
    created_on: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawRepo {
    mainbranch: Option<RawBranch>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawBranch {
    name: Option<String>,
    target: Option<RawCommit>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawCommit {
    hash: Option<String>,
    links: Option<RawLinks>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawLinks {
    html: Option<RawLink>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RawLink {
    href: Option<String>,
}

fn http_link(link: Option<String>) -> Option<String> {
    link.filter(|link| Url::parse(link).is_ok_and(|url| matches!(url.scheme(), "http" | "https")))
}

fn report_out(raw: RawReport) -> Option<BbReportOut> {
    Some(BbReportOut {
        uuid: raw.uuid.filter(|id| !id.trim().is_empty())?,
        external_id: raw.external_id,
        title: raw.title,
        details: raw.details,
        report_type: raw.report_type,
        reporter: raw.reporter,
        result: raw.result,
        link: http_link(raw.link),
        created_on: raw.created_on,
        data: raw
            .data
            .unwrap_or_default()
            .into_iter()
            .map(|data| BbReportDataOut {
                title: data.title,
                data_type: data.data_type,
                value: data.value,
            })
            .collect(),
        annotations: Vec::new(),
        annotations_truncated: false,
        annotations_unreadable: false,
    })
}

fn annotation_out(raw: RawAnnotation) -> Option<BbAnnotationOut> {
    Some(BbAnnotationOut {
        uuid: raw.uuid.filter(|id| !id.trim().is_empty())?,
        external_id: raw.external_id,
        annotation_type: raw.annotation_type,
        severity: raw.severity,
        summary: raw.summary,
        details: raw.details,
        path: raw.path,
        line: raw.line,
        link: http_link(raw.link),
        result: raw.result,
        created_on: raw.created_on,
    })
}

/// Keep in lockstep with FINDINGS_LIMIT_CAP in FindingsPanel.tsx.
fn clamp_limit(limit: Option<u32>) -> usize {
    limit.unwrap_or(100).clamp(1, 500) as usize
}

// One full page. The old ten-per-commit write cap is gone (probed 2026-09-20:
// twelve concurrent reports accepted), so the bound is fetch cost, not a
// platform limit; past it the walk reports truncated and the cap sentence shows.
const BB_MAX_REPORTS: usize = 100;
type Failure = (BbFindingsAvailability, String, Option<u16>);

fn indeterminate(detail: impl Into<String>) -> Failure {
    (BbFindingsAvailability::Indeterminate, detail.into(), None)
}

fn classify(status: u16, body: &str) -> Result<(), Failure> {
    // Findings routes 401/403 to sign-in and other failures to Retry;
    // shared Bitbucket detail keeps reconnect and rate-limit guidance consistent.
    match status {
        200..=299 => Ok(()),
        401 | 403 => Err((
            BbFindingsAvailability::Forbidden,
            http::bb_error_detail(status, body, http::BbOpKind::Read),
            Some(status),
        )),
        _ => Err((
            BbFindingsAvailability::Indeterminate,
            http::bb_error_detail(status, body, http::BbOpKind::Read),
            Some(status),
        )),
    }
}

async fn fetch<F, Fut>(get: &mut F, url: String) -> Result<(u16, String), Failure>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = AppResult<(u16, String)>>,
{
    get(url)
        .await
        .map_err(|error| indeterminate(error.to_string()))
}

fn parse_json<T: serde::de::DeserializeOwned>(body: &str) -> Result<T, Failure> {
    serde_json::from_str(body)
        .map_err(|error| indeterminate(format!("Could not read Bitbucket response: {error}")))
}

fn parse_page(body: &str) -> Result<BbPage<Value>, Failure> {
    let value: Value = parse_json(body)?;
    // BbPage defaults missing values to []; that cannot establish NoReports.
    if !value.get("values").is_some_and(Value::is_array) {
        return Err(indeterminate(
            "Bitbucket response has no readable values list",
        ));
    }
    serde_json::from_value(value)
        .map_err(|error| indeterminate(format!("Could not read Bitbucket page: {error}")))
}

async fn walk<F, Fut>(
    get: &mut F,
    first_url: String,
    cap: usize,
) -> Result<(Vec<Value>, bool), Failure>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = AppResult<(u16, String)>>,
{
    let mut url = first_url;
    let mut items = Vec::new();
    for page_number in 1..=BB_MAX_PAGES {
        let (status, body) = fetch(get, url).await?;
        classify(status, &body)?;
        let page = parse_page(&body)?;
        items.extend(page.values);
        let dropped = items.len() > cap;
        items.truncate(cap);
        let has_next = page.next.is_some();
        if dropped || items.len() == cap || page_number == BB_MAX_PAGES {
            return Ok((items, dropped || has_next));
        }
        match next_page_url(page.next) {
            Some(next) => url = next,
            None => return Ok((items, has_next)),
        }
    }
    unreachable!("the page budget is nonzero")
}

fn parse_items<T: serde::de::DeserializeOwned, O>(
    items: Vec<Value>,
    map: impl Fn(T) -> Option<O>,
) -> (Vec<O>, usize) {
    let total = items.len();
    let parsed: Vec<O> = items
        .into_iter()
        .filter_map(|item| serde_json::from_value(item).ok().and_then(&map))
        .collect();
    let unreadable = total - parsed.len();
    (parsed, unreadable)
}

/// Units stay separate: a lost report or annotation list hides an unknown number
/// of annotation rows, so folding them into a row count would understate the loss.
fn partial_detail(
    reports: usize,
    annotation_lists: usize,
    annotation_rows: usize,
) -> Option<String> {
    let parts: Vec<String> = [
        (reports, "report", "reports"),
        (annotation_lists, "annotation list", "annotation lists"),
        (annotation_rows, "annotation row", "annotation rows"),
    ]
    .into_iter()
    .filter(|(count, _, _)| *count > 0)
    .map(|(count, singular, plural)| {
        format!("{count} {}", if count == 1 { singular } else { plural })
    })
    .collect();
    let (last, rest) = parts.split_last()?;
    let units = if rest.is_empty() {
        last.clone()
    } else {
        format!("{} and {last}", rest.join(", "))
    };
    Some(format!("{units} couldn't be read"))
}

fn missing_refs_detail(branches: &[String]) -> String {
    if branches.is_empty() {
        return "This checkout is on no branch and Bitbucket reports no default branch.".into();
    }
    let noun = if branches.len() == 1 {
        "branch"
    } else {
        "branches"
    };
    let names = branches
        .iter()
        .map(|branch| format!("'{branch}'"))
        .collect::<Vec<_>>()
        .join(" or ");
    format!("Couldn't find {noun} {names} on Bitbucket.")
}

async fn resolve_ref<F, Fut>(
    get: &mut F,
    base: &str,
    branch: &str,
) -> Result<Option<RawCommit>, Failure>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = AppResult<(u16, String)>>,
{
    // Bitbucket accepts both %2F-encoded and literal-slash branch names (live probe
    // 2026-09-20: both returned 200 with the same target); the encoded form is test-pinned.
    let url = format!("{base}/refs/branches/{}", encode_query_value(branch));
    let (status, body) = fetch(get, url).await?;
    if status == 404
        && !body.contains("report-service.report.not-found")
        && !body.contains("There is no API hosted at this URL")
    {
        return Ok(None);
    }
    classify(status, &body)?;
    let branch: RawBranch = parse_json(&body)?;
    let commit = branch
        .target
        .filter(|target| {
            target
                .hash
                .as_ref()
                .is_some_and(|hash| !hash.trim().is_empty())
        })
        .ok_or_else(|| indeterminate("Bitbucket branch response has no commit hash"))?;
    Ok(Some(commit))
}

fn empty_out(requested_ref: String) -> BbFindingsOut {
    BbFindingsOut {
        availability: BbFindingsAvailability::Indeterminate,
        detail: None,
        requested_ref,
        used_fallback: false,
        fallback_ref: None,
        default_ref: None,
        commit_sha: None,
        commit_web_url: None,
        reports: Vec::new(),
        truncated: false,
    }
}

async fn read_findings<F, Fut>(
    get: &mut F,
    base: &str,
    cap: usize,
    out: &mut BbFindingsOut,
) -> Result<(), Failure>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = AppResult<(u16, String)>>,
{
    let (status, body) = fetch(get, base.to_string()).await?;
    classify(status, &body)?;
    let repo: RawRepo = parse_json(&body)?;
    out.default_ref = repo
        .mainbranch
        .and_then(|branch| branch.name)
        .filter(|name| !name.trim().is_empty());
    let mut branches = Vec::new();
    if out.requested_ref != "HEAD" {
        branches.push(out.requested_ref.clone());
    }
    if let Some(default) = &out.default_ref {
        if default != &out.requested_ref {
            branches.push(default.clone());
        }
    }
    for branch in &branches {
        let Some(commit) = resolve_ref(get, base, branch).await? else {
            continue;
        };
        if branch != &out.requested_ref {
            out.used_fallback = true;
            out.fallback_ref = Some(branch.clone());
        }
        out.commit_sha = commit.hash;
        out.commit_web_url = commit
            .links
            .and_then(|links| links.html)
            .and_then(|html| html.href);
        let reports_url = format!(
            "{base}/commit/{}/reports?pagelen=100",
            encode_query_value(
                out.commit_sha
                    .as_deref()
                    .expect("resolve_ref validates hash")
            )
        );
        let (items, truncated) = walk(get, reports_url, BB_MAX_REPORTS).await?;
        out.truncated = truncated;
        let (reports, unreadable_reports) = parse_items(items, report_out);
        if reports.is_empty() {
            if unreadable_reports > 0 {
                return Err(indeterminate(
                    partial_detail(unreadable_reports, 0, 0).unwrap(),
                ));
            }
            if truncated {
                return Err(indeterminate(
                    "The report walk ended before an empty result could be established",
                ));
            }
            continue;
        }
        out.reports = reports;
        let mut unreadable_lists = 0;
        let mut unreadable_rows = 0;
        let mut first_annotation_failure = None;
        let mut pending_reports = out.reports.iter_mut();
        while let Some(report) = pending_reports.next() {
            let url = format!(
                "{base}/commit/{}/reports/{}/annotations?pagelen=100",
                encode_query_value(out.commit_sha.as_deref().expect("resolved commit")),
                encode_query_value(&report.uuid)
            );
            match walk(get, url, cap).await {
                Ok((items, truncated)) => {
                    let (annotations, unreadable) = parse_items(items, annotation_out);
                    report.annotations_truncated = truncated;
                    report.annotations = annotations;
                    report.annotations_unreadable = unreadable > 0;
                    unreadable_rows += unreadable;
                }
                Err((availability, detail, status)) => {
                    report.annotations_unreadable = true;
                    unreadable_lists += 1;
                    first_annotation_failure.get_or_insert(detail);
                    if status == Some(429) || availability == BbFindingsAvailability::Forbidden {
                        for pending in pending_reports.by_ref() {
                            pending.annotations_unreadable = true;
                            unreadable_lists += 1;
                        }
                        break;
                    }
                }
            }
        }
        out.availability = BbFindingsAvailability::Available;
        out.detail = partial_detail(unreadable_reports, unreadable_lists, unreadable_rows);
        if let (Some(summary), Some(detail)) = (&mut out.detail, first_annotation_failure) {
            summary.push_str(&format!(" — first failure: {detail}"));
        }
        return Ok(());
    }
    if out.commit_sha.is_some() {
        out.availability = BbFindingsAvailability::NoReports;
    } else {
        out.availability = BbFindingsAvailability::RefNotFound;
        out.detail = Some(missing_refs_detail(&branches));
    }
    Ok(())
}

async fn findings_with<F, Fut>(
    get: &mut F,
    base: &str,
    requested_ref: String,
    limit: Option<u32>,
) -> BbFindingsOut
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = AppResult<(u16, String)>>,
{
    let mut out = empty_out(requested_ref);
    if let Err((availability, detail, _)) =
        read_findings(get, base, clamp_limit(limit), &mut out).await
    {
        out.availability = availability;
        out.detail = Some(detail);
    }
    out
}

async fn current_branch(repo_path: &str) -> String {
    crate::git::runner::run_git_raw(
        Some(repo_path),
        &["rev-parse", "--abbrev-ref", "HEAD"],
        crate::git::runner::DEFAULT_TIMEOUT,
    )
    .await
    .ok()
    .filter(|out| out.code == 0)
    .map(|out| out.stdout_lossy().trim().to_string())
    .filter(|branch| !branch.is_empty())
    .unwrap_or_else(|| "HEAD".to_string())
}

pub async fn commit_findings(repo_path: &str, limit: Option<u32>) -> AppResult<BbFindingsOut> {
    let (workspace, slug) = workspace_slug(repo_path).await?;
    let requested_ref = current_branch(repo_path).await;
    let creds = &http::load_credentials().await?;
    let base = format!(
        "repositories/{}/{}",
        encode_query_value(&workspace),
        encode_query_value(&slug)
    );
    let mut get = |url: String| async move { http::bb_get_classified(creds, &url).await };
    Ok(findings_with(&mut get, &base, requested_ref, limit).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;
    use std::future::ready;

    const REPORT_FIXTURE: &str = r#"{"page":1,"size":2,"pagelen":2,"values":[
 {"uuid":"{95188f28-bf45-5fe2-9d88-22d6ee77d554}","title":"CVE Lite CLI (fixture - safe to delete)",
  "details":"Dependency scan of the lockfile. Fixture data for GitDesktop Phase 4.",
  "external_id":"gd-fixture-sec-001","reporter":"cve-lite-cli",
  "link":"https://github.com/OWASP/cve-lite-cli","report_type":"SECURITY","result":"FAILED",
  "remote_link_enabled":false,
  "data":[{"title":"Critical","type":"NUMBER","value":1},{"title":"High","type":"NUMBER","value":2},
          {"title":"Duration","type":"DURATION","value":3200},{"title":"Safe to merge","type":"BOOLEAN","value":false}],
  "created_on":"2026-09-19T17:22:46.986111559Z","updated_on":"2026-09-19T17:22:46.986111559Z","type":"report"},
 {"uuid":"{f5153809-921b-5513-a783-6eb3fa8d0a60}","title":"Static analysis (fixture - safe to delete)",
  "external_id":"gd-fixture-bug-002","reporter":"gd-fixture","report_type":"BUG","result":"PASSED",
  "remote_link_enabled":false,"data":[],
  "created_on":"2026-09-19T17:22:47.489232027Z","updated_on":"2026-09-19T17:22:47.489232027Z","type":"report"}]}"#;

    const ANNOTATION_FIXTURE: &str = r#"{"page":1,"size":3,"pagelen":3,"values":[
 {"external_id":"a1","uuid":"{a2cf1f7b-17e3-52aa-9bff-e176b4b65d5c}",
  "report":{"uuid":"{95188f28-bf45-5fe2-9d88-22d6ee77d554}","title":"CVE Lite CLI (fixture - safe to delete)"},
  "annotation_type":"VULNERABILITY","path":"package.json","line":12,
  "summary":"lodash 4.17.15 is vulnerable to prototype pollution (CVE-2020-8203). Upgrade to 4.17.21.",
  "result":"FAILED","severity":"CRITICAL","link":"https://osv.dev/vulnerability/GHSA-p6mc-m468-83gg",
  "created_on":"2026-09-19T17:22:47.971638264Z","updated_on":"2026-09-19T17:22:47.971638264Z"},
 {"external_id":"a3","uuid":"{32ff1a21-c771-5d40-922d-5b67a63a36e3}",
  "annotation_type":"CODE_SMELL","summary":"No path at all - tests the repo-scoped annotation row.",
  "severity":"MEDIUM","created_on":"2026-09-19T17:22:48.867586026Z"},
 {"external_id":"a4","uuid":"{b641530a-b44a-5aa3-adeb-56aaf5b2b303}",
  "annotation_type":"BUG","path":"vite.config.ts","line":3,
  "summary":"Severity omitted entirely - must not render as a default severity.",
  "created_on":"2026-09-19T17:22:49.346179674Z"}]}"#;

    const REPO: &str = r#"{"mainbranch":{"name":"main"}}"#;
    const TIP: &str = r#"{"target":{"hash":"abc","links":{"html":{"href":"https://bitbucket.org/api-provided/commit/abc"}}}}"#;
    const EMPTY: &str = r#"{"values":[]}"#;
    const REPORT: &str = r#"{"values":[{"uuid":"r1"}]}"#;
    const BASE: &str = "repositories/ws/slug";

    async fn scripted_findings(
        requested: &str,
        limit: Option<u32>,
        responses: Vec<(&str, u16, &str)>,
    ) -> BbFindingsOut {
        let mut responses = VecDeque::from(responses);
        let out = {
            let mut get = |url: String| {
                let (suffix, status, body) = responses.pop_front().expect("unexpected request");
                assert_eq!(url, format!("{BASE}{suffix}"));
                ready(Ok((status, body.to_string())))
            };
            findings_with(&mut get, BASE, requested.into(), limit).await
        };
        assert!(responses.is_empty(), "unconsumed requests");
        out
    }

    #[test]
    fn availability_and_envelope_wire_strings_are_pinned() {
        for (availability, wire) in [
            (BbFindingsAvailability::Available, "available"),
            (BbFindingsAvailability::NoReports, "noReports"),
            (BbFindingsAvailability::RefNotFound, "refNotFound"),
            (BbFindingsAvailability::Forbidden, "forbidden"),
            (BbFindingsAvailability::Indeterminate, "indeterminate"),
        ] {
            assert_eq!(serde_json::to_value(availability).unwrap(), wire);
        }
        assert_eq!(
            serde_json::to_value(empty_out("topic".into())).unwrap(),
            json!({
                "availability": "indeterminate", "detail": null, "requestedRef": "topic",
                "usedFallback": false, "fallbackRef": null, "defaultRef": null,
                "commitSha": null, "commitWebUrl": null, "reports": [], "truncated": false
            })
        );
        assert!(
            super::super::model::Capabilities::for_provider(
                super::super::model::Provider::Bitbucket
            )
            .security_findings
        );
    }

    #[test]
    fn live_fixtures_map_through_raw_to_wire_without_inventing_fields() {
        let (reports, lost) = parse_items(parse_page(REPORT_FIXTURE).unwrap().values, report_out);
        assert_eq!(lost, 0);
        assert_eq!(reports.len(), 2);
        let wire = serde_json::to_value(&reports).unwrap();
        assert_eq!(
            wire[0],
            json!({
                "uuid": "{95188f28-bf45-5fe2-9d88-22d6ee77d554}",
                "externalId": "gd-fixture-sec-001", "title": "CVE Lite CLI (fixture - safe to delete)",
                "details": "Dependency scan of the lockfile. Fixture data for GitDesktop Phase 4.",
                "reportType": "SECURITY", "reporter": "cve-lite-cli", "result": "FAILED",
                "link": "https://github.com/OWASP/cve-lite-cli", "createdOn": "2026-09-19T17:22:46.986111559Z",
                "data": [{"title":"Critical","type":"NUMBER","value":1},{"title":"High","type":"NUMBER","value":2},
                         {"title":"Duration","type":"DURATION","value":3200},{"title":"Safe to merge","type":"BOOLEAN","value":false}],
                "annotations": [], "annotationsTruncated": false, "annotationsUnreadable": false
            })
        );
        assert_eq!(reports[1].report_type.as_deref(), Some("BUG"));
        assert_eq!(reports[1].result.as_deref(), Some("PASSED"));
        assert!(reports[1].link.is_none());
        let (annotations, lost) = parse_items(
            parse_page(ANNOTATION_FIXTURE).unwrap().values,
            annotation_out,
        );
        assert_eq!(lost, 0);
        assert_eq!(annotations.len(), 3);
        assert_eq!(
            serde_json::to_value(&annotations[0]).unwrap(),
            json!({
                "uuid":"{a2cf1f7b-17e3-52aa-9bff-e176b4b65d5c}", "externalId":"a1",
                "annotationType":"VULNERABILITY", "severity":"CRITICAL", "path":"package.json", "line":12,
                "summary":"lodash 4.17.15 is vulnerable to prototype pollution (CVE-2020-8203). Upgrade to 4.17.21.",
                "details":null, "result":"FAILED", "link":"https://osv.dev/vulnerability/GHSA-p6mc-m468-83gg",
                "createdOn":"2026-09-19T17:22:47.971638264Z"
            })
        );
        assert!(annotations[1].path.is_none());
        assert!(annotations[1].line.is_none());
        assert!(annotations[1].result.is_none());
        assert!(annotations[2].severity.is_none());
        assert_eq!(annotations[2].path.as_deref(), Some("vite.config.ts"));
        assert_eq!(annotations[2].line, Some(3));
        let raw: RawReport = serde_json::from_value(json!({
            "uuid":"r", "link":"javascript:alert(1)",
            "data":[{"type":"LINK","value":"javascript:alert(1)"}]
        }))
        .unwrap();
        let report = report_out(raw).unwrap();
        assert!(report.link.is_none());
        assert_eq!(report.data[0].value, Some(json!("javascript:alert(1)")));
        let raw: RawAnnotation = serde_json::from_value(json!({
            "uuid":"a", "link":"javascript:alert(1)", "report":{"anything":"ignored"}
        }))
        .unwrap();
        assert!(annotation_out(raw).unwrap().link.is_none());
    }

    #[tokio::test]
    async fn pagination_uses_next_verbatim_and_marks_every_stop() {
        let next =
            "https://api.bitbucket.org/2.0/repositories/ws/slug/commit/abc/reports/?page=2&x=%2F";
        for has_next_at_cap in [true, false] {
            let mut calls = 0;
            let mut get = |url: String| {
                assert_eq!(url, if calls == 0 { "first" } else { next });
                calls += 1;
                let mut page = json!({"values":[{"uuid":"r"}],"pagelen":1,"size":9000});
                if calls < BB_MAX_PAGES || has_next_at_cap {
                    page["next"] = json!(next);
                }
                ready(Ok((200, page.to_string())))
            };
            let (items, truncated) = walk(&mut get, "first".into(), usize::MAX).await.unwrap();
            assert_eq!(items.len(), BB_MAX_PAGES);
            assert_eq!(truncated, has_next_at_cap);
            assert_eq!(calls, BB_MAX_PAGES);
        }
        let mut calls = 0;
        let mut get = |_: String| {
            calls += 1;
            ready(Ok((
                200,
                json!({"values":[{}],"next":"https://evil.example/2.0/page"}).to_string(),
            )))
        };
        assert!(walk(&mut get, "first".into(), 100).await.unwrap().1);
        assert_eq!(calls, 1);
        for (cap, truncated) in [(2, true), (3, false)] {
            let mut get = |_: String| ready(Ok((200, ANNOTATION_FIXTURE.into())));
            let (items, actual) = walk(&mut get, "first".into(), cap).await.unwrap();
            assert_eq!(items.len(), cap);
            assert_eq!(actual, truncated);
        }
        let mut get = |_: String| ready(Ok((200, json!({"values":[{}],"next":next}).to_string())));
        assert!(walk(&mut get, "first".into(), 1).await.unwrap().1);
    }

    #[tokio::test]
    async fn annotation_failure_preserves_available_reports_and_separate_counts() {
        for (rows, expected) in [
            (REPORT, "1 annotation list couldn't be read — first failure: HTTP 403: unknown body"),
            (
                r#"{"values":[{"uuid":"r1"},{"title":"missing uuid"}]}"#,
                "1 report and 1 annotation list couldn't be read — first failure: HTTP 403: unknown body",
            ),
        ] {
            let out = scripted_findings(
                "topic",
                None,
                vec![
                    ("", 200, REPO),
                    ("/refs/branches/topic", 200, TIP),
                    ("/commit/abc/reports?pagelen=100", 200, rows),
                    (
                        "/commit/abc/reports/r1/annotations?pagelen=100",
                        403,
                        " unknown body ",
                    ),
                ],
            )
            .await;
            assert_eq!(out.availability, BbFindingsAvailability::Available);
            assert_eq!(out.detail.as_deref(), Some(expected));
            assert!(out.reports[0].annotations_unreadable);
            assert!(out.reports[0].annotations.is_empty());
            assert!(!out.reports[0].annotations_truncated);
        }
    }

    #[tokio::test]
    async fn annotation_failures_disclose_the_first_rate_limit_detail() {
        for (reports, count, expected) in [
            (REPORT, 1, "1 annotation list couldn't be read — first failure: Bitbucket rate limit reached (429). Wait a moment and try again."),
            (r#"{"values":[{"uuid":"r1"},{"uuid":"r2"}]}"#, 2, "2 annotation lists couldn't be read — first failure: Bitbucket rate limit reached (429). Wait a moment and try again."),
            (r#"{"values":[{"uuid":"r1"},{"uuid":"r2"},{"uuid":"r3"}]}"#, 3, "3 annotation lists couldn't be read — first failure: Bitbucket rate limit reached (429). Wait a moment and try again."),
        ] {
            let responses = vec![
                ("", 200, REPO),
                ("/refs/branches/topic", 200, TIP),
                ("/commit/abc/reports?pagelen=100", 200, reports),
                ("/commit/abc/reports/r1/annotations?pagelen=100", 429, "rate limited"),
            ];
            let out = scripted_findings("topic", None, responses).await;
            assert_eq!(out.availability, BbFindingsAvailability::Available);
            assert_eq!(out.detail.as_deref(), Some(expected));
            assert_eq!(out.reports.len(), count);
            assert!(out.reports.iter().all(|report| report.annotations_unreadable && report.annotations.is_empty()));
        }
    }

    #[tokio::test]
    async fn annotation_auth_failures_stop_remaining_reads_and_keep_completed_lists() {
        for status in [401, 403] {
            let out = scripted_findings(
                "topic",
                None,
                vec![
                    ("", 200, REPO),
                    ("/refs/branches/topic", 200, TIP),
                    (
                        "/commit/abc/reports?pagelen=100",
                        200,
                        r#"{"values":[{"uuid":"r1"},{"uuid":"r2"},{"uuid":"r3"}]}"#,
                    ),
                    (
                        "/commit/abc/reports/r1/annotations?pagelen=100",
                        200,
                        ANNOTATION_FIXTURE,
                    ),
                    (
                        "/commit/abc/reports/r2/annotations?pagelen=100",
                        status,
                        "privilege scopes",
                    ),
                ],
            )
            .await;
            assert_eq!(out.availability, BbFindingsAvailability::Available);
            assert_eq!(out.reports[0].annotations.len(), 3);
            assert!(!out.reports[0].annotations_unreadable);
            assert!(out.reports[1..]
                .iter()
                .all(|report| report.annotations_unreadable && report.annotations.is_empty()));
            let expected = format!(
                "2 annotation lists couldn't be read — first failure: {}",
                http::bb_error_detail(status, "privilege scopes", http::BbOpKind::Read)
            );
            assert_eq!(out.detail.as_deref(), Some(expected.as_str()));
        }
    }

    #[tokio::test]
    async fn other_annotation_failures_allow_later_lists_to_be_read() {
        for (status, body) in [(500, "upstream unavailable"), (200, "not json")] {
            let out = scripted_findings(
                "topic",
                None,
                vec![
                    ("", 200, REPO),
                    ("/refs/branches/topic", 200, TIP),
                    (
                        "/commit/abc/reports?pagelen=100",
                        200,
                        r#"{"values":[{"uuid":"r1"},{"uuid":"r2"}]}"#,
                    ),
                    (
                        "/commit/abc/reports/r1/annotations?pagelen=100",
                        status,
                        body,
                    ),
                    (
                        "/commit/abc/reports/r2/annotations?pagelen=100",
                        200,
                        ANNOTATION_FIXTURE,
                    ),
                ],
            )
            .await;
            assert_eq!(out.availability, BbFindingsAvailability::Available);
            assert!(out.reports[0].annotations_unreadable);
            assert!(!out.reports[1].annotations_unreadable);
            assert_eq!(out.reports[1].annotations.len(), 3);
            assert!(out
                .detail
                .unwrap()
                .starts_with("1 annotation list couldn't be read — first failure: "));
        }
    }

    #[tokio::test]
    async fn malformed_annotation_rows_preserve_siblings_and_disclose_separate_losses() {
        for (limit, with_next, kept, truncated) in [
            (None, false, 2, false),
            (Some(3), true, 2, true),
            (Some(1), false, 0, true),
            (Some(1), true, 0, true),
        ] {
            let mut fixture: Value = serde_json::from_str(ANNOTATION_FIXTURE).unwrap();
            fixture["values"][0]["line"] = json!("12");
            if with_next {
                fixture["next"] = json!("https://api.bitbucket.org/2.0/annotations?page=2");
            }
            let body = fixture.to_string();
            let out = scripted_findings(
                "topic",
                limit,
                vec![
                    ("", 200, REPO),
                    ("/refs/branches/topic", 200, TIP),
                    (
                        "/commit/abc/reports?pagelen=100",
                        200,
                        r#"{"values":[{"uuid":"r1"},{"uuid":"r2"},{"title":"missing uuid"}]}"#,
                    ),
                    ("/commit/abc/reports/r1/annotations?pagelen=100", 200, &body),
                    (
                        "/commit/abc/reports/r2/annotations?pagelen=100",
                        403,
                        "unreadable list",
                    ),
                ],
            )
            .await;
            assert_eq!(out.availability, BbFindingsAvailability::Available);
            assert_eq!(
                out.detail.as_deref(),
                Some("1 report, 1 annotation list and 1 annotation row couldn't be read — first failure: HTTP 403: unreadable list")
            );
            assert_eq!(out.reports.len(), 2);
            let report = &out.reports[0];
            assert!(report.annotations_unreadable);
            assert_eq!(report.annotations.len(), kept);
            assert_eq!(report.annotations_truncated, truncated);
            if kept == 2 {
                assert_eq!(report.annotations[0].external_id.as_deref(), Some("a3"));
                assert_eq!(report.annotations[1].external_id.as_deref(), Some("a4"));
            }
            assert!(out.reports[1].annotations_unreadable);
            assert!(out.reports[1].annotations.is_empty());
            assert!(!out.reports[1].annotations_truncated);
        }
    }

    #[tokio::test]
    async fn ref_fallback_and_both_missing_keep_ref_context() {
        let out = scripted_findings(
            "feature/a",
            None,
            vec![
                ("", 200, REPO),
                ("/refs/branches/feature%2Fa", 404, "branch missing"),
                ("/refs/branches/main", 200, TIP),
                ("/commit/abc/reports?pagelen=100", 200, REPORT),
                ("/commit/abc/reports/r1/annotations?pagelen=100", 200, EMPTY),
            ],
        )
        .await;
        assert_eq!(out.availability, BbFindingsAvailability::Available);
        assert!(out.used_fallback);
        assert_eq!(out.fallback_ref.as_deref(), Some("main"));
        assert_eq!(out.default_ref.as_deref(), Some("main"));
        assert_eq!(out.commit_sha.as_deref(), Some("abc"));
        assert_eq!(
            out.commit_web_url.as_deref(),
            Some("https://bitbucket.org/api-provided/commit/abc")
        );
        let out = scripted_findings(
            "topic",
            None,
            vec![
                ("", 200, REPO),
                ("/refs/branches/topic", 404, "missing"),
                ("/refs/branches/main", 404, "missing"),
            ],
        )
        .await;
        assert_eq!(out.availability, BbFindingsAvailability::RefNotFound);
        assert!(!out.used_fallback);
        assert!(out.fallback_ref.is_none());
        assert_eq!(
            out.detail.as_deref(),
            Some("Couldn't find branches 'topic' or 'main' on Bitbucket.")
        );
        assert!(out.commit_sha.is_none());
    }

    #[tokio::test]
    async fn missing_ref_detail_names_only_consulted_branches() {
        for (requested, repo, consulted, expected) in [
            (
                "HEAD",
                REPO,
                Some("main"),
                "Couldn't find branch 'main' on Bitbucket.",
            ),
            (
                "topic",
                "{}",
                Some("topic"),
                "Couldn't find branch 'topic' on Bitbucket.",
            ),
            (
                "main",
                REPO,
                Some("main"),
                "Couldn't find branch 'main' on Bitbucket.",
            ),
            (
                "HEAD",
                "{}",
                None,
                "This checkout is on no branch and Bitbucket reports no default branch.",
            ),
        ] {
            let branch_url = format!("/refs/branches/{}", consulted.unwrap_or_default());
            let mut responses = vec![("", 200, repo)];
            if consulted.is_some() {
                responses.push((&branch_url, 404, "missing"));
            }
            let out = scripted_findings(requested, None, responses).await;
            assert_eq!(out.availability, BbFindingsAvailability::RefNotFound);
            assert_eq!(out.detail.as_deref(), Some(expected));
            assert!(!out.used_fallback);
            assert!(out.fallback_ref.is_none());
            assert!(out.commit_sha.is_none());
        }
    }

    #[tokio::test]
    async fn missing_default_preserves_requested_commit_without_fallback_provenance() {
        let out = scripted_findings(
            "topic",
            None,
            vec![
                ("", 200, REPO),
                ("/refs/branches/topic", 200, TIP),
                ("/commit/abc/reports?pagelen=100", 200, EMPTY),
                ("/refs/branches/main", 404, "missing"),
            ],
        )
        .await;
        assert_eq!(out.availability, BbFindingsAvailability::NoReports);
        assert!(!out.used_fallback);
        assert!(out.fallback_ref.is_none());
        assert_eq!(out.default_ref.as_deref(), Some("main"));
        assert_eq!(out.commit_sha.as_deref(), Some("abc"));
        assert_eq!(
            out.commit_web_url.as_deref(),
            Some("https://bitbucket.org/api-provided/commit/abc")
        );
        assert!(out.detail.is_none());
    }

    #[tokio::test]
    async fn empty_reports_fall_back_and_detached_head_skips_requested_ref() {
        let out = scripted_findings(
            "topic",
            None,
            vec![
                ("", 200, REPO),
                ("/refs/branches/topic", 200, TIP),
                ("/commit/abc/reports?pagelen=100", 200, EMPTY),
                ("/refs/branches/main", 200, r#"{"target":{"hash":"def"}}"#),
                ("/commit/def/reports?pagelen=100", 200, EMPTY),
            ],
        )
        .await;
        assert_eq!(out.availability, BbFindingsAvailability::NoReports);
        assert!(out.used_fallback);
        assert_eq!(out.commit_sha.as_deref(), Some("def"));
        assert!(out.commit_web_url.is_none());
        assert!(out.detail.is_none());
        let out = scripted_findings(
            "HEAD",
            Some(2),
            vec![
                ("", 200, REPO),
                ("/refs/branches/main", 200, TIP),
                ("/commit/abc/reports?pagelen=100", 200, REPORT),
                (
                    "/commit/abc/reports/r1/annotations?pagelen=100",
                    200,
                    ANNOTATION_FIXTURE,
                ),
            ],
        )
        .await;
        assert!(out.used_fallback);
        assert_eq!(out.availability, BbFindingsAvailability::Available);
        assert_eq!(out.reports[0].annotations.len(), 2);
        assert!(out.reports[0].annotations_truncated);
        assert!(out.detail.is_none());
    }

    #[tokio::test]
    async fn unreadable_windows_and_response_failures_never_become_empty_success() {
        for (status, body) in [
            (204, ""),
            (200, "not json"),
            (200, "{}"),
            (200, r#"{"values":null}"#),
            (200, r#"{"values":[{"title":"missing uuid"}]}"#),
            (404, "report-service.report.not-found"),
            (404, "There is no API hosted at this URL"),
            (500, "upstream unavailable"),
            (403, "  unmeasured reason  "),
        ] {
            let out = scripted_findings(
                "topic",
                None,
                vec![
                    ("", 200, REPO),
                    ("/refs/branches/topic", 200, TIP),
                    ("/commit/abc/reports?pagelen=100", status, body),
                ],
            )
            .await;
            assert_eq!(
                out.availability,
                if status == 403 {
                    BbFindingsAvailability::Forbidden
                } else {
                    BbFindingsAvailability::Indeterminate
                }
            );
            if status == 403 {
                assert_eq!(out.detail.as_deref(), Some("HTTP 403: unmeasured reason"));
            }
            if body.contains("missing uuid") {
                assert_eq!(out.detail.as_deref(), Some("1 report couldn't be read"));
            }
            assert!(out.reports.is_empty());
            assert_eq!(out.default_ref.as_deref(), Some("main"));
        }
        let out = scripted_findings("topic", None, vec![("", 403, " raw body ")]).await;
        assert_eq!(out.availability, BbFindingsAvailability::Forbidden);
        assert_eq!(out.detail.as_deref(), Some("HTTP 403: raw body"));
        let mut get =
            |_: String| ready(Err(crate::error::AppError::Bitbucket("read failed".into())));
        let out = findings_with(&mut get, BASE, "topic".into(), None).await;
        assert_eq!(out.availability, BbFindingsAvailability::Indeterminate);
        assert!(out.detail.unwrap().contains("read failed"));
    }

    #[tokio::test]
    async fn classification_uses_shared_bitbucket_guidance_and_envelope_messages() {
        for (status, body, availability, expected) in [
            (
                401,
                "expired token",
                BbFindingsAvailability::Forbidden,
                "Bitbucket rejected the request (401) — your API token may be expired or revoked. Reconnect it in Settings → Accounts.",
            ),
            (
                429,
                "too many requests",
                BbFindingsAvailability::Indeterminate,
                "Bitbucket rate limit reached (429). Wait a moment and try again.",
            ),
            (
                403,
                r#"{"error":{"message":"You do not have access to this repository."}}"#,
                BbFindingsAvailability::Forbidden,
                "You do not have access to this repository.",
            ),
            (
                403,
                r#"{"error":{"message":"Your credentials lack one or more required privilege scopes."}}"#,
                BbFindingsAvailability::Forbidden,
                "Bitbucket rejected the request (403) — your API token is missing a scope this read needs. Reconnect it in Settings → Accounts with repository, account, or pipeline read access.",
            ),
            (
                404,
                r#"{"error":{"message":"There is no API hosted at this URL"}}"#,
                BbFindingsAvailability::Indeterminate,
                "There is no API hosted at this URL",
            ),
            (
                404,
                r#"{"error":{"message":"Not found","detail":"report-service.report.not-found"}}"#,
                BbFindingsAvailability::Indeterminate,
                "report-service.report.not-found",
            ),
        ] {
            assert_eq!(classify(status, body), Err((availability, expected.into(), Some(status))));
            let write_expected = if status == 403 && body.contains("privilege scopes") {
                "Bitbucket rejected the request (403) — your API token is missing a required write scope. Reconnect it in Settings → Accounts with pull request / repository / pipeline write scopes."
            } else {
                expected
            };
            match http::http_error(status, body) {
                crate::error::AppError::Bitbucket(detail) => assert_eq!(detail, write_expected),
                other => panic!("expected Bitbucket error, got {other:?}"),
            }
            let out = scripted_findings(
                "topic",
                None,
                vec![
                    ("", 200, REPO),
                    ("/refs/branches/topic", 200, TIP),
                    ("/commit/abc/reports?pagelen=100", status, body),
                ],
            ).await;
            assert_eq!(out.availability, availability);
            assert_eq!(out.detail.as_deref(), Some(expected));
        }
        assert_eq!(classify(204, ""), Ok(()));
        assert_eq!(classify(299, ""), Ok(()));
        assert_eq!(
            classify(500, ""),
            Err((
                BbFindingsAvailability::Indeterminate,
                "HTTP 500".into(),
                Some(500)
            ))
        );
        let long_body = format!("  {}  ", "é".repeat(301));
        assert_eq!(
            classify(500, &long_body),
            Err((
                BbFindingsAvailability::Indeterminate,
                format!("HTTP 500: {}", "é".repeat(300)),
                Some(500)
            ))
        );
        assert_eq!(indeterminate("unknown").2, None);
        assert_eq!(parse_json::<Value>("not json").unwrap_err().2, None);
        assert_eq!(parse_page("{}").err().unwrap().2, None);
        let mut get = |_: String| {
            ready(Err(crate::error::AppError::Bitbucket(
                "transport failure".into(),
            )))
        };
        assert_eq!(fetch(&mut get, "unused".into()).await.unwrap_err().2, None);
    }

    #[test]
    fn partial_detail_filters_zero_counts_and_pluralizes_each_unit() {
        for (counts, expected) in [
            ((0, 0, 0), None),
            ((1, 0, 0), Some("1 report couldn't be read")),
            ((0, 1, 0), Some("1 annotation list couldn't be read")),
            ((0, 0, 1), Some("1 annotation row couldn't be read")),
            (
                (2, 0, 3),
                Some("2 reports and 3 annotation rows couldn't be read"),
            ),
            (
                (0, 2, 1),
                Some("2 annotation lists and 1 annotation row couldn't be read"),
            ),
            (
                (2, 3, 4),
                Some("2 reports, 3 annotation lists and 4 annotation rows couldn't be read"),
            ),
        ] {
            assert_eq!(
                partial_detail(counts.0, counts.1, counts.2).as_deref(),
                expected
            );
        }
    }

    #[tokio::test]
    async fn report_cap_bounds_annotation_requests_and_discloses_remaining_reports() {
        // Fixture arithmetic derives from the const so a cap change can't
        // silently skew the boundary — the pin records the probed basis.
        assert_eq!(BB_MAX_REPORTS, 100);
        for (count, has_next, truncated) in [
            (BB_MAX_REPORTS, false, false),
            (BB_MAX_REPORTS, true, true),
            (BB_MAX_REPORTS + 1, false, true),
        ] {
            let mut page = json!({"values": (0..count).map(|i| json!({"uuid":format!("r{i}")})).collect::<Vec<_>>()});
            if has_next {
                page["next"] = json!("https://api.bitbucket.org/2.0/reports?page=2");
            }
            let body = page.to_string();
            let annotation_urls: Vec<String> = (0..BB_MAX_REPORTS)
                .map(|i| format!("/commit/abc/reports/r{i}/annotations?pagelen=100"))
                .collect();
            let mut responses = vec![
                ("", 200, REPO),
                ("/refs/branches/topic", 200, TIP),
                ("/commit/abc/reports?pagelen=100", 200, &body),
            ];
            responses.extend(annotation_urls.iter().map(|url| (url.as_str(), 200, EMPTY)));
            let out = scripted_findings("topic", None, responses).await;
            assert_eq!(out.availability, BbFindingsAvailability::Available);
            assert_eq!(out.reports.len(), BB_MAX_REPORTS);
            assert_eq!(out.truncated, truncated);
            assert!(out.detail.is_none());
        }
    }

    #[test]
    fn annotation_limit_is_bounded() {
        assert_eq!(clamp_limit(None), 100);
        assert_eq!(clamp_limit(Some(0)), 1);
        assert_eq!(clamp_limit(Some(500)), 500);
        assert_eq!(clamp_limit(Some(u32::MAX)), 500);
    }
}
