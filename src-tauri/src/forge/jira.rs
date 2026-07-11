//! Jira Cloud (read path) — a per-repo LINKED issue provider, orthogonal to the git
//! host detection every `forge_issue_*` command dispatches on. Jira can never be
//! detected from a git remote (no repo has a Jira remote), so it is *configured*: the
//! frontend stores a per-repo `{site, projectKey}` link and passes `site`/`project_key`
//! into these commands, keeping Rust stateless about linkage. See
//! `docs/jira-issue-integration.md` for the architectural rationale.
//!
//! This module mirrors the Bitbucket provider's shape ([`super::bitbucket`] +
//! [`super::http`]) but Jira-local: a per-tenant base URL (`https://<site>/rest/api/3/`)
//! instead of a constant, HTTP Basic auth (`email:api_token`), and Jira's error
//! envelope (`{errorMessages, errors}`). Auth tokens are stored in the OS keyring under
//! `forge/<site>/{email,token}` — the raw token never crosses IPC.
//!
//! Bodies are ADF (a JSON tree), converted to markdown by [`adf`] on the read path and
//! built from markdown by [`md_to_adf`] on the write path. Phase 1 covered the reads
//! (account connect/validate, project search, issue list, issue detail); phase 2 adds the
//! writes: comment, transition (close/reopen), create, assign, plus the user search and
//! per-project permission probe those write surfaces drive.

mod adf;
mod md_to_adf;

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri_plugin_http::reqwest::{self, Client};

use crate::error::{AppError, AppResult};
use crate::forge::model::ForgeUserRef;

// ── HTTP transport (Jira-local) ────────────────────────────────────────────────

/// Keyring credential keys under `forge/<site>/*`.
const KEY_EMAIL: &str = "email";
const KEY_TOKEN: &str = "token";

/// Mirror the Bitbucket transport's ceilings (`http.rs`): a per-request timeout and a
/// tighter connect timeout so an unreachable host fails fast.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The single page size for list endpoints — the app's bounded-pagination policy
/// (one page, no cursor-following).
const MAX_RESULTS: u32 = 50;

/// The process-wide Jira HTTP client. Built once (connection pooling, one TLS setup)
/// and shared across all calls, exactly like the Bitbucket client.
static CLIENT: OnceLock<Client> = OnceLock::new();

fn client() -> &'static Client {
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(concat!("GitDesktop/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            // The builder only fails on a broken TLS backend — unrecoverable; a plain
            // `Client::new()` uses the same backend, so fall back rather than panic.
            .unwrap_or_else(|_| Client::new())
    })
}

/// Keyring key holding the resolved API base mode (`"direct"` | `"gateway:<cloudId>"`).
const KEY_API_BASE: &str = "api_base";

/// Which Atlassian API base a site's stored token authenticates against.
///
/// **Scoped vs classic tokens (support-doc + live-verified 2026-07-10):** Atlassian's
/// "Manage API tokens" doc (support.atlassian.com) states that API tokens created WITH
/// scopes must call the gateway `https://api.atlassian.com/ex/jira/{cloudId}` — a scoped
/// token CANNOT authenticate site-direct against `https://<site>.atlassian.net` (it 401s
/// there). Classic *unscoped* tokens use the site-direct base. Atlassian is steering all
/// users to scoped tokens, so the gateway base is the path most new tokens need. Both
/// bases use the same Basic auth header; only the URL differs. Do NOT collapse this back
/// to site-direct only — a fresh Jira-scoped token AND a scoped Bitbucket token both 401
/// site-direct (live-proven against thebguy.atlassian.net, 2026-07-10).
#[derive(Clone, Debug, PartialEq, Eq)]
enum JiraApiBase {
    /// Classic unscoped token — `https://<site>/rest/api/3/`.
    Direct { site: String },
    /// Scoped token — `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/`.
    Gateway { cloud_id: String },
}

impl JiraApiBase {
    /// Resolve a relative REST path against this base's `…/rest/api/3/` root.
    fn resolve(&self, path: &str) -> String {
        let path = path.trim_start_matches('/');
        match self {
            JiraApiBase::Direct { site } => format!("https://{site}/rest/api/3/{path}"),
            JiraApiBase::Gateway { cloud_id } => {
                format!("https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3/{path}")
            }
        }
    }

    /// Resolve a relative path against this base's Agile API root (`…/rest/agile/1.0/`).
    /// The Agile API accepts the same Basic auth and the same Direct/Gateway bases as the
    /// platform API — only the `rest/…` segment differs. Used for the best-effort
    /// board-configuration story-points override.
    fn resolve_agile(&self, path: &str) -> String {
        let path = path.trim_start_matches('/');
        match self {
            JiraApiBase::Direct { site } => format!("https://{site}/rest/agile/1.0/{path}"),
            JiraApiBase::Gateway { cloud_id } => {
                format!("https://api.atlassian.com/ex/jira/{cloud_id}/rest/agile/1.0/{path}")
            }
        }
    }

    /// The keyring value that persists this mode: `"direct"` or `"gateway:<cloudId>"`.
    fn to_keyring_value(&self) -> String {
        match self {
            JiraApiBase::Direct { .. } => "direct".to_string(),
            JiraApiBase::Gateway { cloud_id } => format!("gateway:{cloud_id}"),
        }
    }

    /// Parse a stored keyring value back into a mode, given the site (needed to rebuild
    /// the Direct base). `"gateway:<id>"` → Gateway (empty id → None); anything else
    /// (including `"direct"`, an empty/absent value, or an unknown string) → Direct, so
    /// pre-existing creds with no `api_base` entry default to site-direct and a later
    /// 401 surfaces normally (re-linking re-resolves). Pure (testable).
    fn from_keyring_value(value: Option<&str>, site: &str) -> Self {
        if let Some(rest) = value.and_then(|v| v.strip_prefix("gateway:")) {
            if !rest.is_empty() {
                return JiraApiBase::Gateway {
                    cloud_id: rest.to_string(),
                };
            }
        }
        JiraApiBase::Direct {
            site: site.to_string(),
        }
    }
}

/// The stored Jira credentials (email + token) plus the resolved API base for one site,
/// from the OS keyring. Never logged, never returned across IPC. `site` is the normalized
/// host (kept alongside the base so the error path can resolve the in-process field-name
/// map for that site — the Gateway base carries only a cloudId, not the host).
struct JiraCredentials {
    email: String,
    token: String,
    base: JiraApiBase,
    site: String,
}

/// Normalize and validate a Jira Cloud site host. Trims, strips a leading `https://`
/// (or `http://`) and any trailing slash, lowercases, and REQUIRES it match
/// `^[a-z0-9-]+\.atlassian\.net$` — v1 is Jira Cloud only, and this also prevents
/// sending the token to an arbitrary host. Returns the bare host (e.g.
/// `yourteam.atlassian.net`) or a clear error.
fn normalize_site(site: &str) -> AppResult<String> {
    let s = site.trim();
    let s = s
        .strip_prefix("https://")
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(s);
    let s = s.trim_end_matches('/').to_ascii_lowercase();
    if is_valid_site(&s) {
        Ok(s)
    } else {
        Err(AppError::Jira(
            "Enter your Jira Cloud site, e.g. yourteam.atlassian.net (custom domains \
             and Server/DC aren't supported yet)."
                .into(),
        ))
    }
}

/// Whether `s` is a bare `<subdomain>.atlassian.net` host: a non-empty label of
/// `[a-z0-9-]` followed by exactly the `.atlassian.net` suffix. Pure (testable).
fn is_valid_site(s: &str) -> bool {
    let Some(label) = s.strip_suffix(".atlassian.net") else {
        return false;
    };
    !label.is_empty()
        && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        // A subdomain label can't itself contain a dot (that would be a nested
        // subdomain — not a Cloud tenant host).
        && !label.contains('.')
}

/// Validate a Jira project key (`^[A-Z][A-Z0-9_]*$`) before splicing it into JQL —
/// grammar-validate untrusted config so a stored key can't inject JQL. Pure.
fn is_valid_project_key(key: &str) -> bool {
    let mut bytes = key.bytes();
    match bytes.next() {
        Some(b) if b.is_ascii_uppercase() => {}
        _ => return false,
    }
    bytes.all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
}

/// Validate a Jira issue key (`^[A-Z][A-Z0-9_]*-[0-9]+$`) before interpolating it into
/// an API path. Pure.
fn is_valid_issue_key(key: &str) -> bool {
    let Some((project, number)) = key.rsplit_once('-') else {
        return false;
    };
    is_valid_project_key(project)
        && !number.is_empty()
        && number.bytes().all(|b| b.is_ascii_digit())
}

/// Jira's error envelope: `{"errorMessages": [..], "errors": {field: msg}}`. Either
/// may be absent on a given response; parsing is best-effort and the caller falls back
/// to a status+snippet message.
#[derive(Deserialize, Default)]
struct JiraErrorEnvelope {
    #[serde(default)]
    error_messages: Vec<String>,
    #[serde(default)]
    errors: std::collections::HashMap<String, String>,
}

/// Whether `key` is a `customfield_NNNNN` id (the only keys eligible for name
/// translation). Pure.
fn is_customfield_key(key: &str) -> bool {
    match key.strip_prefix("customfield_") {
        Some(n) => !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// Render a field-error key for display, given a `resolve` that maps a field id to its
/// display name. A `customfield_NNNNN` key with a known name renders the NAME; an unknown
/// custom id, or any non-customfield key, renders unchanged. Pure (testable) — `resolve`
/// performs no I/O (it reads the in-process name map).
fn translate_field_key(key: &str, resolve: impl Fn(&str) -> Option<String>) -> String {
    if is_customfield_key(key) {
        if let Some(name) = resolve(key) {
            return name;
        }
    }
    key.to_string()
}

impl JiraErrorEnvelope {
    /// The best human message. Prefer the top-level `errorMessages` (Jira's general
    /// failures), then fall back to the field-level `errors` map — but surface ALL field
    /// entries joined as `field: msg`, not just the first, so a create that fails on
    /// several mandatory custom fields names every one of them (rather than dropping all
    /// but one). Field keys are sorted so the message is deterministic. `resolve` maps a
    /// `customfield_NNNNN` id to its display name (in-process, no I/O). Empty when neither
    /// half carries text.
    fn best_message(&self, resolve: impl Fn(&str) -> Option<String>) -> Option<String> {
        if let Some(msg) = self
            .error_messages
            .iter()
            .find(|m| !m.trim().is_empty())
            .cloned()
        {
            return Some(msg);
        }
        self.field_errors_joined(resolve)
    }

    /// Join every non-empty `errors` entry as `field: msg`, sorted by field key for a
    /// deterministic message. Each key is run through [`translate_field_key`] so a known
    /// `customfield_NNNNN` renders its display name (unknown ids stay raw). `None` when
    /// there are no field errors. Pure (testable): `resolve` is the only external input and
    /// performs no I/O. NOTE the sort is on the RAW keys (deterministic and independent of
    /// whether a name map is warm), then each is translated for display.
    fn field_errors_joined(&self, resolve: impl Fn(&str) -> Option<String>) -> Option<String> {
        let mut pairs: Vec<(&String, &String)> = self
            .errors
            .iter()
            .filter(|(_, msg)| !msg.trim().is_empty())
            .collect();
        if pairs.is_empty() {
            return None;
        }
        pairs.sort_by(|a, b| a.0.cmp(b.0));
        Some(
            pairs
                .into_iter()
                .map(|(field, msg)| format!("{}: {msg}", translate_field_key(field, &resolve)))
                .collect::<Vec<_>>()
                .join("; "),
        )
    }
}

/// Turn a non-2xx response body + status into an [`AppError::Jira`], with the
/// 401/403/429 special-casing the design requires. `body` is the raw response text
/// (never contains our credentials — those live only in the request header). Field-error
/// keys are rendered raw (no name translation) — this variant is used where no site is in
/// scope (base resolution / connect). [`http_error_for`] translates `customfield_NNNNN`
/// keys for a known site.
fn http_error(status: u16, body: &str) -> AppError {
    http_error_with_resolver(status, body, |_| None)
}

/// [`http_error`] but resolving field-error `customfield_NNNNN` keys to their display
/// names via the given site's in-process field-name map (populated at discovery time). NO
/// network or disk I/O — a cold name map simply renders raw ids (today's behavior). Used
/// by the request helpers, which know the creds' site.
fn http_error_for(status: u16, body: &str, site: &str) -> AppError {
    http_error_with_resolver(status, body, |key| {
        crate::jira_field_maps::field_name(site, key)
    })
}

/// The shared body of [`http_error`] / [`http_error_for`]: `resolve` maps a field id to a
/// display name for the field-error rendering (no-op for the site-less path).
fn http_error_with_resolver(
    status: u16,
    body: &str,
    resolve: impl Fn(&str) -> Option<String>,
) -> AppError {
    // Jira's envelope is `{errorMessages, errors}` — note this shape differs from
    // Bitbucket's `{error:{message}}`, so it is parsed with a Jira-local type.
    let api_msg = serde_json::from_str::<JiraErrorEnvelope>(body)
        .ok()
        .and_then(|e| e.best_message(&resolve));
    match status {
        401 => AppError::Jira(
            "Jira rejected the credentials (401) — the API token may be expired or \
             revoked. Reconnect in the Jira link dialog."
                .into(),
        ),
        403 => AppError::Jira(
            "Your Atlassian account authenticated but doesn't have access to this Jira \
             site or project (403)."
                .into(),
        ),
        429 => AppError::Jira("Jira rate limit reached (429). Wait a moment and try again.".into()),
        _ => {
            let detail = api_msg.unwrap_or_else(|| {
                let trimmed = body.trim();
                if trimmed.is_empty() {
                    format!("HTTP {status}")
                } else {
                    let snippet: String = trimmed.chars().take(300).collect();
                    format!("HTTP {status}: {snippet}")
                }
            });
            AppError::Jira(detail)
        }
    }
}

/// The low-level authenticated request: send `method` to the base-resolved `path` with
/// HTTP Basic auth (and an optional JSON body), returning the raw `(status, body)`
/// WITHOUT turning a non-2xx into an error — the caller decides (base resolution needs
/// to inspect a 401 specifically). Only a transport/read failure is an `Err`.
async fn raw_request(
    creds: &JiraCredentials,
    method: reqwest::Method,
    path: &str,
    json_body: Option<&Value>,
) -> AppResult<(u16, String)> {
    let url = creds.base.resolve(path);
    let mut req = client()
        .request(method, &url)
        .basic_auth(&creds.email, Some(&creds.token))
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(b) = json_body {
        let text = serde_json::to_string(b).unwrap_or_default();
        req = req
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(text);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| AppError::Jira(format!("Jira request failed: {e}")))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Jira(format!("could not read Jira response: {e}")))?;
    Ok((status, body))
}

/// GET a Jira endpoint expecting JSON, deserializing into `T` against the creds' resolved
/// base. `Accept: application/json`, HTTP Basic auth. Non-2xx → [`http_error`]; a parse
/// failure of a 2xx body → `Jira("could not parse …")` carrying the serde error verbatim
/// (never mapped into a specific-cause message).
async fn get_json<T: serde::de::DeserializeOwned>(
    creds: &JiraCredentials,
    path: &str,
    what: &str,
) -> AppResult<T> {
    let (status, body) = raw_request(creds, reqwest::Method::GET, path, None).await?;
    if !(200..300).contains(&status) {
        return Err(http_error_for(status, &body, &creds.site));
    }
    serde_json::from_str(&body)
        .map_err(|e| AppError::Jira(format!("could not parse Jira {what}: {e}")))
}

/// POST JSON to a Jira endpoint and deserialize the 2xx body into `T`. Same error
/// handling as [`get_json`].
async fn post_json<T: serde::de::DeserializeOwned>(
    creds: &JiraCredentials,
    path: &str,
    body: &Value,
    what: &str,
) -> AppResult<T> {
    let (status, resp_body) = raw_request(creds, reqwest::Method::POST, path, Some(body)).await?;
    if !(200..300).contains(&status) {
        return Err(http_error_for(status, &resp_body, &creds.site));
    }
    serde_json::from_str(&resp_body)
        .map_err(|e| AppError::Jira(format!("could not parse Jira {what}: {e}")))
}

/// Send a write with an optional JSON body, expecting a no-content (or don't-care) 2xx
/// response — used for the transition POST and assignee PUT, which return 204. The 2xx
/// body is discarded; a non-2xx maps through [`http_error`] (so field errors surface).
async fn send_no_content(
    creds: &JiraCredentials,
    method: reqwest::Method,
    path: &str,
    body: Option<&Value>,
) -> AppResult<()> {
    let (status, resp_body) = raw_request(creds, method, path, body).await?;
    if !(200..300).contains(&status) {
        return Err(http_error_for(status, &resp_body, &creds.site));
    }
    Ok(())
}

/// Load the stored credentials + resolved API base for a site from the keyring (blocking
/// reads off-thread). `Jira("No Jira account…")` when no token is stored for that site.
/// A missing `api_base` entry (pre-existing creds) defaults to site-direct — a later 401
/// then surfaces normally and re-linking re-resolves the mode.
async fn load_credentials(site: &str) -> AppResult<JiraCredentials> {
    let site_owned = site.to_string();
    let (email, token, api_base) = tauri::async_runtime::spawn_blocking(move || {
        let email = crate::secrets::read_forge_secret(&site_owned, KEY_EMAIL)?;
        let token = crate::secrets::read_forge_secret(&site_owned, KEY_TOKEN)?;
        let api_base = crate::secrets::read_forge_secret(&site_owned, KEY_API_BASE)?;
        Ok::<_, AppError>((email, token, api_base))
    })
    .await
    .map_err(|e| AppError::Jira(format!("keyring task failed: {e}")))??;
    match (email, token) {
        (Some(email), Some(token)) if !email.is_empty() && !token.is_empty() => {
            let base = JiraApiBase::from_keyring_value(api_base.as_deref(), site);
            Ok(JiraCredentials {
                email,
                token,
                base,
                site: site.to_string(),
            })
        }
        _ => Err(AppError::Jira(
            "No Jira account is connected for this site. Connect it in the Jira link \
             dialog."
                .into(),
        )),
    }
}

// ── JSON shapes (defensive; every nullable field is Option) ────────────────────

/// A Jira user (`/myself`, or an embedded `assignee`/`reporter`/`author`). Every field
/// is optional/tolerant — an embedded user can be a bare object or `null`.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct JiraUser {
    #[serde(default)]
    account_id: Option<String>,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    email_address: Option<String>,
    #[serde(default)]
    avatar_urls: Option<JiraAvatarUrls>,
}

/// The `avatarUrls` block — a map keyed by size. Only `48x48` is used.
#[derive(Deserialize, Default)]
struct JiraAvatarUrls {
    #[serde(rename = "48x48", default)]
    x48: Option<String>,
}

impl JiraUser {
    /// The `48x48` avatar URL, or empty when absent.
    fn avatar_url(&self) -> String {
        self.avatar_urls
            .as_ref()
            .and_then(|a| a.x48.clone())
            .unwrap_or_default()
    }

    /// Map onto the neutral [`ForgeUserRef`]: id = accountId, label = displayName,
    /// avatar_url = the `48x48` avatar (or empty). A user with no accountId still maps
    /// (id empty) — callers surface it as an unattributed ref rather than dropping it.
    fn to_ref(&self) -> ForgeUserRef {
        ForgeUserRef {
            id: self.account_id.clone().unwrap_or_default(),
            label: self.display_name.clone().unwrap_or_default(),
            avatar_url: self.avatar_url(),
        }
    }
}

// ── Account commands (set / validate / clear / read) ───────────────────────────

/// The account info returned after connecting (or on validate). The TOKEN is never
/// included — it stays in the keyring only.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraAccountInfo {
    pub display_name: String,
    pub account_id: String,
    pub avatar_url: String,
    pub email: String,
}

/// The stored account (email only), for a no-network keyring read.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraStoredAccount {
    pub email: String,
}

/// Map a `/myself` `JiraUser` onto `JiraAccountInfo`, filling `email` from the argument
/// (Jira's `/myself` may omit `emailAddress` when the account hides it, but we know the
/// email we authenticated as).
fn account_info_from_myself(me: JiraUser, email_fallback: &str) -> JiraAccountInfo {
    JiraAccountInfo {
        display_name: me.display_name.clone().unwrap_or_default(),
        account_id: me.account_id.clone().unwrap_or_default(),
        avatar_url: me.avatar_url(),
        email: me
            .email_address
            .filter(|e| !e.is_empty())
            .unwrap_or_else(|| email_fallback.to_string()),
    }
}

/// Probe `GET /rest/api/3/myself` with the given creds (against the creds' resolved base)
/// and map the result onto `JiraAccountInfo`. Used by `validate` on STORED creds, whose
/// base is already resolved — so no re-resolution here.
async fn probe_myself(creds: &JiraCredentials, email_fallback: &str) -> AppResult<JiraAccountInfo> {
    let me: JiraUser = get_json(creds, "myself", "account").await?;
    Ok(account_info_from_myself(me, email_fallback))
}

/// The `/_edge/tenant_info` response — an UNAUTHENTICATED endpoint on the site host that
/// returns the tenant's `cloudId` (verified live 2026-07-10: `GET
/// https://<site>/_edge/tenant_info` returned a real cloudId for thebguy.atlassian.net
/// with no auth). Only `cloudId` is read.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TenantInfo {
    #[serde(default)]
    cloud_id: Option<String>,
}

/// Fetch the site's `cloudId` from `GET https://<site>/_edge/tenant_info` (no auth) on the
/// shared client. Type-guards the shape: a non-empty `cloudId` string, else a clear
/// "couldn't resolve the site's cloud id" error (never `unwrap_or_default`). `site` is
/// assumed already normalized/validated by the caller.
async fn fetch_cloud_id(site: &str) -> AppResult<String> {
    let url = format!("https://{site}/_edge/tenant_info");
    let resp = client()
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| AppError::Jira(format!("Jira request failed: {e}")))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Jira(format!("could not read Jira response: {e}")))?;
    if !(200..300).contains(&status) {
        return Err(AppError::Jira(format!(
            "couldn't resolve the site's cloud id (HTTP {status})"
        )));
    }
    cloud_id_from_body(&body)
}

/// Type-guard a `tenant_info` body into a non-empty `cloudId` string. Pure (testable):
/// a parse failure, a missing/null `cloudId`, or an empty/whitespace value all map to
/// the same clear error — never `unwrap_or_default` (a blank cloudId would build a
/// broken gateway URL).
fn cloud_id_from_body(body: &str) -> AppResult<String> {
    let info: TenantInfo = serde_json::from_str(body)
        .map_err(|_| AppError::Jira("couldn't resolve the site's cloud id".into()))?;
    match info.cloud_id {
        Some(id) if !id.trim().is_empty() => Ok(id),
        _ => Err(AppError::Jira(
            "couldn't resolve the site's cloud id".into(),
        )),
    }
}

/// What to do after the site-direct `/myself` probe returns `status`. Pure (testable):
/// isolates the resolution branch from the network so the decision can be unit-tested.
#[derive(Debug, PartialEq, Eq)]
enum DirectProbeStep {
    /// 2xx — the token works site-direct; use the Direct base.
    UseDirect,
    /// 401 — likely a scoped token; resolve the cloudId and retry via the gateway.
    TryGateway,
    /// Any other status — a genuine direct-base failure; surface it unchanged.
    Fail,
}

/// Decide the next step from a site-direct probe status. Only a 401 means "wrong base for
/// this token type" (scoped tokens 401 site-direct — see [`JiraApiBase`]); a 2xx uses
/// Direct; everything else (403/network-mapped/5xx) is a real failure. Pure.
fn decide_after_direct(status: u16) -> DirectProbeStep {
    if (200..300).contains(&status) {
        DirectProbeStep::UseDirect
    } else if status == 401 {
        DirectProbeStep::TryGateway
    } else {
        DirectProbeStep::Fail
    }
}

/// Resolve the API base for a token at credential-save time: probe `/myself` site-direct;
/// on a 401 specifically, resolve the site's `cloudId` and retry via the gateway;
/// whichever succeeds is the site's mode. Returns the resolved `(base, JiraAccountInfo)`.
///
/// Scoped tokens 401 site-direct and must use the gateway (support-doc + live-verified,
/// see [`JiraApiBase`]); classic unscoped tokens work site-direct. A non-401 direct
/// failure (403/network/parse) is returned as-is — only a 401 triggers the gateway
/// retry, because only a 401 is the "wrong base for this token type" signal.
///
/// `email`/`token` are the candidate credentials (not yet stored). Errors from the
/// gateway retry are returned to the caller, which decides the final failure copy.
async fn resolve_base(
    site: &str,
    email: &str,
    token: &str,
) -> AppResult<(JiraApiBase, JiraAccountInfo)> {
    // Try site-direct first.
    let direct = JiraCredentials {
        email: email.to_string(),
        token: token.to_string(),
        base: JiraApiBase::Direct {
            site: site.to_string(),
        },
        site: site.to_string(),
    };
    let (status, body) = raw_request(&direct, reqwest::Method::GET, "myself", None).await?;
    match decide_after_direct(status) {
        DirectProbeStep::UseDirect => {
            let me: JiraUser = serde_json::from_str(&body)
                .map_err(|e| AppError::Jira(format!("could not parse Jira account: {e}")))?;
            Ok((direct.base, account_info_from_myself(me, email)))
        }
        DirectProbeStep::Fail => Err(http_error(status, &body)),
        DirectProbeStep::TryGateway => {
            // 401 site-direct → the token is likely scoped. Resolve the cloudId and retry.
            let cloud_id = fetch_cloud_id(site).await?;
            let gateway = JiraCredentials {
                email: email.to_string(),
                token: token.to_string(),
                base: JiraApiBase::Gateway { cloud_id },
                site: site.to_string(),
            };
            let (g_status, g_body) =
                raw_request(&gateway, reqwest::Method::GET, "myself", None).await?;
            if (200..300).contains(&g_status) {
                let me: JiraUser = serde_json::from_str(&g_body)
                    .map_err(|e| AppError::Jira(format!("could not parse Jira account: {e}")))?;
                Ok((gateway.base, account_info_from_myself(me, email)))
            } else {
                // Both bases failed — surface the gateway status (the token can't reach
                // Jira on either base). The caller layers command-specific copy on top.
                Err(http_error(g_status, &g_body))
            }
        }
    }
}

/// Persist the credentials + resolved base for a site (blocking keyring writes
/// off-thread). Writes email/token and the `api_base` mode value.
async fn persist_account(
    site: &str,
    email: &str,
    token: &str,
    base: &JiraApiBase,
) -> AppResult<()> {
    let (kr_site, kr_email, kr_token, kr_base) = (
        site.to_string(),
        email.to_string(),
        token.to_string(),
        base.to_keyring_value(),
    );
    tauri::async_runtime::spawn_blocking(move || {
        crate::secrets::set_forge_secret(&kr_site, KEY_EMAIL, &kr_email)?;
        crate::secrets::set_forge_secret(&kr_site, KEY_TOKEN, &kr_token)?;
        crate::secrets::set_forge_secret(&kr_site, KEY_API_BASE, &kr_base)?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|e| AppError::Jira(format!("keyring task failed: {e}")))?
}

/// Connect a Jira account for a site: normalize + validate the site, resolve the API base
/// (site-direct vs gateway — see [`resolve_base`]) by validating the (site, email, token)
/// triple via `GET /myself` BEFORE persisting anything (a pre-mutation guard — nothing is
/// written if validation fails), then store email/token + the resolved base and return
/// the account info (never the token).
pub async fn set_account(site: &str, email: &str, token: &str) -> AppResult<JiraAccountInfo> {
    let site = normalize_site(site)?;
    let email = email.trim().to_string();
    let token = token.trim().to_string();
    if email.is_empty() || token.is_empty() {
        return Err(AppError::InvalidArgument(
            "an email and API token are both required".into(),
        ));
    }
    // Resolve the base (probes direct, falls back to gateway on a 401) before writing.
    // On failure, the manual-entry path frames the auth error as a possibly-wrong-product
    // or expired token; a non-auth error passes through unchanged.
    let (base, info) = resolve_base(&site, &email, &token)
        .await
        .map_err(specialize_manual_error)?;

    // Validated — persist the creds + resolved base.
    persist_account(&site, &email, &token, &base).await?;
    Ok(info)
}

/// Specialize an AUTH error (401 or 403) from MANUAL credential entry (`set_account`,
/// after base resolution has already tried BOTH bases). A token that 401s on both
/// site-direct and the gateway is either for a different Atlassian product or
/// expired/revoked — say so, keeping the status marker. Non-auth errors pass through
/// unchanged.
fn specialize_manual_error(err: AppError) -> AppError {
    let code = match &err {
        AppError::Jira(msg) if msg.contains("(401)") => "401",
        AppError::Jira(msg) if msg.contains("(403)") => "403",
        _ => return err,
    };
    AppError::Jira(format!(
        "Jira couldn't authenticate this API token — it may be for a different Atlassian \
         product (e.g. Bitbucket-only) or expired/revoked. Create a Jira API token and \
         try again. ({code})"
    ))
}

/// Whether a `(email, token)` pair read from the keyring is a usable credential —
/// both present and non-empty. Pure (testable): the guard the Bitbucket-reuse path
/// runs BEFORE any network call.
fn bitbucket_creds_present(email: &Option<String>, token: &Option<String>) -> bool {
    matches!((email, token), (Some(e), Some(t)) if !e.is_empty() && !t.is_empty())
}

/// Connect a Jira account for a site by REUSING the stored Bitbucket credentials
/// (Bitbucket Cloud shares the Atlassian API-token mechanism). This must happen
/// Rust-side because tokens never cross IPC — the frontend can't read the Bitbucket
/// token to hand it to `jira_set_account`.
///
/// Flow: normalize + validate the site; read the stored Bitbucket creds
/// (`forge/bitbucket.org/{email,token}`) on a blocking thread and GUARD their presence
/// BEFORE any network call; resolve the API base (`/myself` site-direct, falling back to
/// the gateway on a 401 — see [`resolve_base`]) with those creds; on success ONLY,
/// persist the pair + resolved base under the SITE host (so `load_credentials(site)` finds
/// them — NOT under the bitbucket.org entry) and return the account info. The token is
/// never returned or logged. Because the stored Bitbucket token may not reach Jira on
/// either base, a final auth failure (401 or 403 — a product-scoped token returns 401,
/// live-verified 2026-07-10) gets reuse-specific copy pointing at the manual-entry
/// fallback.
pub async fn set_account_from_bitbucket(site: &str) -> AppResult<JiraAccountInfo> {
    use crate::forge::http::{BB_HOST, KEY_EMAIL as BB_KEY_EMAIL, KEY_TOKEN as BB_KEY_TOKEN};

    let site = normalize_site(site)?;

    // Read the stored Bitbucket credentials (blocking keyring reads off-thread).
    let (bb_email, bb_token) = tauri::async_runtime::spawn_blocking(|| {
        let email = crate::secrets::read_forge_secret(BB_HOST, BB_KEY_EMAIL)?;
        let token = crate::secrets::read_forge_secret(BB_HOST, BB_KEY_TOKEN)?;
        Ok::<_, AppError>((email, token))
    })
    .await
    .map_err(|e| AppError::Jira(format!("keyring task failed: {e}")))??;

    // Pre-mutation guard: no usable Bitbucket credential → clear error, no network.
    if !bitbucket_creds_present(&bb_email, &bb_token) {
        return Err(AppError::Jira(
            "No Bitbucket account is connected — add your Atlassian credentials \
             manually instead."
                .into(),
        ));
    }
    let email = bb_email.unwrap_or_default();
    let token = bb_token.unwrap_or_default();

    // Resolve the base (probes /myself site-direct, falls back to the gateway on a 401)
    // with the Bitbucket creds. If BOTH bases fail, an auth failure (401 OR 403) means the
    // token can't reach Jira — a real product-scoped Atlassian token returns 401
    // (live-verified 2026-07-10), so both codes are specialized into one "enter a Jira
    // token manually" message rather than the misleading generic "expired/revoked" copy.
    let (base, info) = resolve_base(&site, &email, &token)
        .await
        .map_err(specialize_reuse_error)?;

    // Validated — persist the pair + resolved base under the SITE host (not bitbucket.org).
    persist_account(&site, &email, &token, &base).await?;
    Ok(info)
}

/// Specialize an AUTH error (401 or 403) from the Bitbucket-reuse probe into one
/// actionable message pointing at the manual-entry fallback. Any non-auth error passes
/// through unchanged.
///
/// Live-verified (thebguy.atlassian.net, 2026-07-10): a real product-scoped Atlassian
/// token (Bitbucket-only) returns **401** on Jira's `/rest/api/3/myself`, not the 403 a
/// scope-mismatch would suggest — so both codes mean "this token can't reach Jira" here,
/// and the generic 401 "expired or revoked — reconnect" copy would be misleading (the
/// token is alive; it's product-scoped). Do NOT narrow this back to 403 only. The
/// original status marker (`(401)`/`(403)`) is preserved in the message so support keeps
/// the code. This specialization is scoped to the reuse command ALONE —
/// `jira_set_account` / `jira_validate` keep the generic 401 copy for genuinely
/// expired/revoked tokens.
fn specialize_reuse_error(err: AppError) -> AppError {
    let code = match &err {
        AppError::Jira(msg) if msg.contains("(401)") => "401",
        AppError::Jira(msg) if msg.contains("(403)") => "403",
        _ => return err,
    };
    AppError::Jira(format!(
        "Your stored Bitbucket token couldn't access this Jira site — Atlassian API \
         tokens are often product-scoped (Bitbucket-only). Create a Jira API token and \
         enter it manually instead. ({code})"
    ))
}

/// The stored account for a site (keyring existence read ONLY — no network). `None`
/// when no token is stored. The token is never returned.
pub async fn account(site: &str) -> AppResult<Option<JiraStoredAccount>> {
    let site = normalize_site(site)?;
    tauri::async_runtime::spawn_blocking(move || {
        let email = crate::secrets::read_forge_secret(&site, KEY_EMAIL)?;
        let token = crate::secrets::read_forge_secret(&site, KEY_TOKEN)?;
        Ok::<_, AppError>(match (email, token) {
            (Some(email), Some(token)) if !email.is_empty() && !token.is_empty() => {
                Some(JiraStoredAccount { email })
            }
            _ => None,
        })
    })
    .await
    .map_err(|e| AppError::Jira(format!("keyring task failed: {e}")))?
}

/// Disconnect a Jira account for a site — delete all three keyring entries (email, token,
/// and the resolved `api_base` mode; a missing entry is tolerated).
pub async fn clear_account(site: &str) -> AppResult<()> {
    let site = normalize_site(site)?;
    tauri::async_runtime::spawn_blocking(move || {
        crate::secrets::delete_forge_secret(&site, KEY_EMAIL)?;
        crate::secrets::delete_forge_secret(&site, KEY_TOKEN)?;
        crate::secrets::delete_forge_secret(&site, KEY_API_BASE)?;
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|e| AppError::Jira(format!("keyring task failed: {e}")))?
}

/// Validate the STORED creds for a site by probing `/myself` against the stored API base
/// (site-direct or gateway — resolved at connect time). Distinct errors for
/// no-creds-stored (via [`load_credentials`]) / 401 / 403 (via [`http_error`]).
pub async fn validate(site: &str) -> AppResult<JiraAccountInfo> {
    let site = normalize_site(site)?;
    let creds = load_credentials(&site).await?;
    let email = creds.email.clone();
    probe_myself(&creds, &email).await
}

// ── Project search (the picker) ────────────────────────────────────────────────

/// A Jira project for the picker.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraProject {
    pub id: String,
    pub key: String,
    pub name: String,
    pub avatar_url: String,
}

/// The `project/search` response — a classic paginated envelope with `values[]`.
#[derive(Deserialize, Default)]
struct JiraProjectPage {
    #[serde(default)]
    values: Vec<JiraProjectRaw>,
}

/// One project as `project/search` returns it. `id` is a numeric string; every field
/// is tolerant.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JiraProjectRaw {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar_urls: Option<JiraAvatarUrls>,
}

/// Search projects for the picker — `GET /rest/api/3/project/search?query=&maxResults=50`,
/// a single page. `query` is percent-encoded into the query string.
pub async fn project_search(site: &str, query: &str) -> AppResult<Vec<JiraProject>> {
    let site = normalize_site(site)?;
    let creds = load_credentials(&site).await?;
    let path = format!(
        "project/search?query={}&maxResults={MAX_RESULTS}",
        crate::forge::encode_query_value(query),
    );
    let page: JiraProjectPage = get_json(&creds, &path, "projects").await?;
    Ok(page
        .values
        .into_iter()
        .map(|p| JiraProject {
            id: p.id.unwrap_or_default(),
            key: p.key.unwrap_or_default(),
            name: p.name.unwrap_or_default(),
            avatar_url: p.avatar_urls.and_then(|a| a.x48).unwrap_or_default(),
        })
        .collect())
}

// ── Issue list ─────────────────────────────────────────────────────────────────

/// Parent (epic) reference — Epic Link was removed from the REST API in 2025;
/// `parent` is the unified field for team- AND company-managed projects.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraParentRef {
    pub key: String,
    pub summary: String,
}

/// A neutral issue-list row for a Jira issue.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssueInfo {
    pub key: String,
    pub summary: String,
    pub status_name: String,
    /// `status.statusCategory.key`: `"new"` | `"indeterminate"` | `"done"`.
    pub status_category: String,
    pub issue_type_name: String,
    pub issue_type_icon_url: String,
    /// Empty when the issue has no priority.
    pub priority_name: String,
    pub assignee: Option<ForgeUserRef>,
    pub labels: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Story points (per-site `customfield_NNNNN`), or `None` when the site has no such
    /// field or the issue doesn't set it. Serializes as `storyPoints`.
    pub story_points: Option<f64>,
    /// The name of the issue's first active sprint (`sprintName`), or `None`.
    pub sprint_name: Option<String>,
    /// That sprint's state (`sprintState`), or `None`.
    pub sprint_state: Option<String>,
    /// The parent (epic) reference, or `None`.
    pub parent: Option<JiraParentRef>,
    /// Component names (empty when none).
    pub components: Vec<String>,
    /// Fix-version names (`fixVersions`; empty when none).
    pub fix_versions: Vec<String>,
    /// `https://<site>/browse/<KEY>`.
    pub url: String,
}

/// The `search/jql` response — `{issues: [...]}` (cursor field `nextPageToken` ignored
/// under the single-page policy).
#[derive(Deserialize, Default)]
struct JiraSearchResponse {
    #[serde(default)]
    issues: Vec<Value>,
}

/// Build the JQL for the list, validating `project_key` first. `state` is
/// `"open"` | `"closed"` | `"all"`; the category filter maps through `statusCategory`.
/// Pure (unit-tested); returns the JQL string or an `InvalidArgument` for a bad key /
/// unknown state.
fn build_list_jql(project_key: &str, state: &str) -> AppResult<String> {
    if !is_valid_project_key(project_key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira project key: {project_key}"
        )));
    }
    let category = match state {
        "open" => " AND statusCategory != Done",
        "closed" => " AND statusCategory = Done",
        "all" => "",
        other => {
            return Err(AppError::InvalidArgument(format!(
                "unknown issue state filter: {other}"
            )))
        }
    };
    Ok(format!(
        "project = \"{project_key}\"{category} ORDER BY updated DESC"
    ))
}

/// Extract `status.statusCategory.key` from an issue's `fields` — `"new"` /
/// `"indeterminate"` / `"done"`, or empty when absent. Pure.
fn status_category_of(fields: &Value) -> String {
    fields
        .get("status")
        .and_then(|s| s.get("statusCategory"))
        .and_then(|c| c.get("key"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Map one issue JSON object onto [`JiraIssueInfo`], defensively. Returns `None` when
/// the object has no usable `key` (so one malformed issue doesn't sink the list); every
/// other field degrades to empty/None rather than erroring. `map` supplies the site's
/// discovered custom-field ids for the agile fields (points/sprint) — an empty map means
/// those simply resolve to `None`.
fn map_issue_info(
    site: &str,
    issue: &Value,
    map: &crate::jira_field_maps::SiteFieldMap,
) -> Option<JiraIssueInfo> {
    let key = issue.get("key").and_then(Value::as_str)?.to_string();
    if key.is_empty() {
        return None;
    }
    let fields = issue.get("fields").cloned().unwrap_or(Value::Null);
    let status_name = fields
        .get("status")
        .and_then(|s| s.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let issue_type = fields.get("issuetype");
    let issue_type_name = issue_type
        .and_then(|t| t.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let issue_type_icon_url = issue_type
        .and_then(|t| t.get("iconUrl"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let priority_name = fields
        .get("priority")
        .and_then(|p| p.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let assignee = parse_user(fields.get("assignee"));
    let labels = parse_labels(fields.get("labels"));
    let (sprint_name, sprint_state) = extract_sprint(&fields, map);
    Some(JiraIssueInfo {
        summary: fields
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        status_name,
        status_category: status_category_of(&fields),
        issue_type_name,
        issue_type_icon_url,
        priority_name,
        assignee,
        labels,
        created_at: fields
            .get("created")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        updated_at: fields
            .get("updated")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        story_points: extract_story_points(&fields, map),
        sprint_name,
        sprint_state,
        parent: extract_parent(&fields),
        components: extract_named_array(&fields, "components"),
        fix_versions: extract_named_array(&fields, "fixVersions"),
        url: format!("https://{site}/browse/{key}"),
        key,
    })
}

/// Parse an embedded user value (`assignee`/`reporter`/comment `author`) into an
/// `Option<ForgeUserRef>` — `None` for a null/absent/non-object value.
fn parse_user(value: Option<&Value>) -> Option<ForgeUserRef> {
    let value = value?;
    if !value.is_object() {
        return None;
    }
    let user: JiraUser = serde_json::from_value(value.clone()).ok()?;
    Some(user.to_ref())
}

/// Parse a `labels` value into `Vec<String>` — a non-array or absent value yields an
/// empty vec; non-string entries are skipped.
fn parse_labels(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

// ── Agile-field extraction (shared by the list + detail mappings) ───────────────

/// The story-points value for an issue, given the site's discovered map. Reads
/// `fields[<storyPointsFieldId>].as_f64()` only when the map carries an id; `None`
/// otherwise (a site without a points field, or an issue that doesn't set it). Pure.
fn extract_story_points(fields: &Value, map: &crate::jira_field_maps::SiteFieldMap) -> Option<f64> {
    let id = map.story_points_field_id.as_deref()?;
    fields.get(id).and_then(Value::as_f64)
}

/// The `(sprintName, sprintState)` of the issue's first ACTIVE sprint, given the site's
/// map. The `/field` metadata claims the sprint field is `items:"string"`, but the REAL
/// value is an ARRAY of sprint OBJECTS `{id, name, state, …}` (live-verified) — so we
/// parse the payload, not the metadata. Takes the first entry whose `state` is not
/// `"closed"` (case-insensitive). `(None, None)` when there's no id, no array, or no
/// non-closed sprint. Pure.
fn extract_sprint(
    fields: &Value,
    map: &crate::jira_field_maps::SiteFieldMap,
) -> (Option<String>, Option<String>) {
    let Some(id) = map.sprint_field_id.as_deref() else {
        return (None, None);
    };
    let Some(arr) = fields.get(id).and_then(Value::as_array) else {
        return (None, None);
    };
    for sprint in arr {
        let state = sprint.get("state").and_then(Value::as_str).unwrap_or("");
        if state.eq_ignore_ascii_case("closed") {
            continue;
        }
        let name = sprint
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string);
        let state = if state.is_empty() {
            None
        } else {
            Some(state.to_string())
        };
        return (name, state);
    }
    (None, None)
}

/// The parent (epic) reference from `fields.parent` → `{key, fields.summary}`. `None`
/// when the parent is absent (very old unmigrated issues lack it entirely) or has an
/// empty/missing key. Pure.
fn extract_parent(fields: &Value) -> Option<JiraParentRef> {
    let parent = fields.get("parent")?;
    let key = parent.get("key").and_then(Value::as_str)?;
    if key.is_empty() {
        return None;
    }
    let summary = parent
        .get("fields")
        .and_then(|f| f.get("summary"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Some(JiraParentRef {
        key: key.to_string(),
        summary,
    })
}

/// Collect the non-empty `name` strings from an array-of-objects field (`components` /
/// `fixVersions`). An absent or non-array value yields an empty vec. Pure.
fn extract_named_array(fields: &Value, field: &str) -> Vec<String> {
    fields
        .get(field)
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.get("name").and_then(Value::as_str))
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The base field list the search/detail endpoints must request (they return almost
/// nothing by default). The site's discovered custom ids + the agile object fields
/// (`parent`, `components`, `fixVersions`) are appended by [`list_fields_for`].
const BASE_LIST_FIELDS: &[&str] = &[
    "summary",
    "status",
    "issuetype",
    "priority",
    "assignee",
    "labels",
    "created",
    "updated",
];

/// Build the field list for `search/jql`: the base skeleton fields + the agile object
/// fields + the site's discovered custom ids (story points, sprint) when present. Pure.
fn list_fields_for(map: &crate::jira_field_maps::SiteFieldMap) -> Vec<String> {
    let mut fields: Vec<String> = BASE_LIST_FIELDS.iter().map(|s| s.to_string()).collect();
    fields.push("parent".to_string());
    fields.push("components".to_string());
    fields.push("fixVersions".to_string());
    if let Some(id) = map.story_points_field_id.as_deref() {
        fields.push(id.to_string());
    }
    if let Some(id) = map.sprint_field_id.as_deref() {
        fields.push(id.to_string());
    }
    fields
}

/// The detail (`GET /issue`) `fields=` custom-id suffix — the discovered story-points and
/// sprint ids joined with commas, each prefixed by `,`, or empty when the site has none.
/// The base `fields=summary,…,comment` list is a constant in [`issue_view`]; this appends
/// only the per-site ids (the agile OBJECT fields `parent,components,fixVersions` are in
/// that constant). Pure.
fn detail_custom_fields_suffix(map: &crate::jira_field_maps::SiteFieldMap) -> String {
    let mut suffix = String::new();
    if let Some(id) = map.story_points_field_id.as_deref() {
        suffix.push(',');
        suffix.push_str(id);
    }
    if let Some(id) = map.sprint_field_id.as_deref() {
        suffix.push(',');
        suffix.push_str(id);
    }
    suffix
}

// ── Custom-field discovery (agile fields — phase 4) ─────────────────────────────

/// Schema keys the story-points / sprint discovery matches against Jira's `/field`
/// metadata. Live-confirmed on a 2026 tenant.
const SCHEMA_STORY_POINTS: &str = "com.pyxis.greenhopper.jira:jsw-story-points";
const SCHEMA_SPRINT: &str = "com.pyxis.greenhopper.jira:gh-sprint";

/// The current UTC timestamp in RFC3339 (millis + `Z`), for the field-map's `resolvedAt`.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// One entry of `GET /rest/api/3/field` (`{id, name, custom, schema:{type, custom,
/// customId}}`). `schema` is absent on some system fields (tolerated). Every field is
/// optional/tolerant.
#[derive(Deserialize, Default)]
struct JiraFieldMeta {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    schema: Option<JiraFieldSchema>,
}

/// The `schema` block of a field — `type` (e.g. `"number"`, `"array"`) and `custom` (the
/// greenhopper marker used to identify agile fields). Tolerant.
#[derive(Deserialize, Default)]
struct JiraFieldSchema {
    #[serde(default, rename = "type")]
    ty: Option<String>,
    #[serde(default)]
    custom: Option<String>,
}

/// Resolve the sprint + story-points custom-field ids from the `/field` metadata array.
/// Returns `(storyPointsFieldId, sprintFieldId)`. Pure so the resolution rules are
/// unit-tested against captured fixtures.
///
/// - **Sprint**: the entry whose `schema.custom == "…:gh-sprint"`.
/// - **Story points**, in order:
///   1. `schema.custom == "…:jsw-story-points"` (live-confirmed);
///   2. else a name-match of "Story point estimate" / "Story Points" (case-insensitive)
///      among entries whose `schema.type == "number"`;
///   3. else `None`.
///
/// NEVER a bare number-type match — a decoy number field ("Budget") must not win.
fn resolve_field_ids(fields: &[JiraFieldMeta]) -> (Option<String>, Option<String>) {
    let sprint = fields
        .iter()
        .find(|f| f.schema.as_ref().and_then(|s| s.custom.as_deref()) == Some(SCHEMA_SPRINT))
        .and_then(|f| f.id.clone());

    // (1) schema-first: the greenhopper story-points marker.
    let points_by_schema = fields
        .iter()
        .find(|f| f.schema.as_ref().and_then(|s| s.custom.as_deref()) == Some(SCHEMA_STORY_POINTS))
        .and_then(|f| f.id.clone());

    let points = points_by_schema.or_else(|| {
        // (2) name-match, but ONLY among number-type fields (never a bare type match).
        fields
            .iter()
            .find(|f| {
                let is_number = f.schema.as_ref().and_then(|s| s.ty.as_deref()) == Some("number");
                let name = f.name.as_deref().unwrap_or("");
                is_number
                    && (name.eq_ignore_ascii_case("Story point estimate")
                        || name.eq_ignore_ascii_case("Story Points"))
            })
            .and_then(|f| f.id.clone())
    });

    (points, sprint)
}

/// The in-process `id → name` map from the `/field` metadata, for error translation.
/// Only entries with both an id and a name are included. Pure.
fn field_name_map(fields: &[JiraFieldMeta]) -> std::collections::HashMap<String, String> {
    fields
        .iter()
        .filter_map(|f| Some((f.id.clone()?, f.name.clone()?)))
        .collect()
}

/// The `estimation` block of an Agile board configuration
/// (`GET /rest/agile/1.0/board/<id>/configuration`). When `type == "field"`, the
/// `field.fieldId` OVERRIDES the `/field`-derived story-points id.
#[derive(Deserialize, Default)]
struct JiraBoardConfig {
    #[serde(default)]
    estimation: Option<JiraBoardEstimation>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct JiraBoardEstimation {
    #[serde(default, rename = "type")]
    ty: Option<String>,
    #[serde(default)]
    field: Option<JiraBoardEstimationField>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct JiraBoardEstimationField {
    #[serde(default)]
    field_id: Option<String>,
}

/// The story-points override a board config implies: `Some(fieldId)` ONLY when
/// `estimation.type == "field"` and a non-empty `field.fieldId` is present; `None`
/// otherwise (e.g. `type == "issueCount"`, or a missing field). Pure.
fn board_config_points_override(config: &JiraBoardConfig) -> Option<String> {
    let est = config.estimation.as_ref()?;
    if est.ty.as_deref() != Some("field") {
        return None;
    }
    est.field
        .as_ref()
        .and_then(|f| f.field_id.as_deref())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The `board?projectKeyOrId=…` response — `{values:[{id, …}]}`. Only the first board's
/// numeric `id` is read.
#[derive(Deserialize, Default)]
struct JiraBoardPage {
    #[serde(default)]
    values: Vec<JiraBoardRef>,
}

#[derive(Deserialize, Default)]
struct JiraBoardRef {
    #[serde(default)]
    id: Option<i64>,
}

/// GET a Jira AGILE endpoint (`…/rest/agile/1.0/…`) expecting JSON, deserializing into
/// `T`. Mirrors [`get_json`] but resolves the agile base. Non-2xx → [`http_error`]; a
/// parse failure of a 2xx body → `Jira("could not parse …")`. Used only by the
/// best-effort board-config override, whose caller swallows ANY error.
async fn get_json_agile<T: serde::de::DeserializeOwned>(
    creds: &JiraCredentials,
    path: &str,
    what: &str,
) -> AppResult<T> {
    let url = creds.base.resolve_agile(path);
    let resp = client()
        .get(&url)
        .basic_auth(&creds.email, Some(&creds.token))
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| AppError::Jira(format!("Jira request failed: {e}")))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Jira(format!("could not read Jira response: {e}")))?;
    if !(200..300).contains(&status) {
        return Err(http_error(status, &body));
    }
    serde_json::from_str(&body)
        .map_err(|e| AppError::Jira(format!("could not parse Jira {what}: {e}")))
}

/// Best-effort story-points override from the project's first Agile board configuration.
/// The Agile API needs jira-software scopes many tokens lack, so ANY failure at any step
/// (401/403/404/parse/missing) yields `None` and the `/field`-derived id stands. Never
/// errors to the caller.
async fn board_points_override(creds: &JiraCredentials, project_key: &str) -> Option<String> {
    let board_path = format!(
        "board?projectKeyOrId={}&maxResults=1",
        crate::forge::encode_query_value(project_key)
    );
    let page: JiraBoardPage = get_json_agile(creds, &board_path, "board").await.ok()?;
    let board_id = page.values.first().and_then(|b| b.id)?;
    let config: JiraBoardConfig = get_json_agile(
        creds,
        &format!("board/{board_id}/configuration"),
        "board config",
    )
    .await
    .ok()?;
    board_config_points_override(&config)
}

/// Discover the site's agile custom-field map: fetch `/rest/api/3/field`, resolve the
/// sprint + story-points ids ([`resolve_field_ids`]), capture the in-process field-NAME
/// map for error translation, then best-effort-override the story-points id from the
/// project's board configuration. Persists the resolved entry (even when both ids are
/// `None` — a site legitimately without agile fields shouldn't be re-probed). On a FAILED
/// `/field` fetch, persists NOTHING and returns `None` (the caller marks an in-process
/// empty marker so this process doesn't hammer per call). `project_key` may be empty (the
/// board override is then skipped).
async fn discover_field_map(
    creds: &JiraCredentials,
    site: &str,
    project_key: &str,
) -> Option<crate::jira_field_maps::SiteFieldMap> {
    let fields: Vec<JiraFieldMeta> = get_json(creds, "field", "fields").await.ok()?;

    // Capture the id→name map for error translation (in-process only).
    crate::jira_field_maps::set_name_map(site, field_name_map(&fields));

    let (mut points, sprint) = resolve_field_ids(&fields);

    // Best-effort board-config override for the points id (silently degraded).
    if !project_key.is_empty() {
        if let Some(overridden) = board_points_override(creds, project_key).await {
            points = Some(overridden);
        }
    }

    let entry = crate::jira_field_maps::SiteFieldMap {
        story_points_field_id: points,
        sprint_field_id: sprint,
        resolved_at: now_iso(),
    };
    // A successful /field fetch persists the entry even when both ids are None.
    crate::jira_field_maps::put(site, entry.clone());
    Some(entry)
}

/// The in-process marker set that records sites whose discovery FAILED this process, so
/// we don't re-probe `/field` on every call. Cleared only by a fresh process launch.
static DISCOVERY_FAILED: OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    OnceLock::new();

fn discovery_failed() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    DISCOVERY_FAILED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Resolve the site's field map for a request, lazily. Order: (1) the persisted/in-process
/// cache; (2) the in-process failed-marker (→ empty map, no re-probe); (3) discovery. A
/// discovery failure records the failed marker and returns the empty (default) map — so the
/// request proceeds with the skeleton fields and NEVER errors. `project_key` drives the
/// board-config override (empty skips it).
async fn resolve_site_map(
    creds: &JiraCredentials,
    site: &str,
    project_key: &str,
) -> crate::jira_field_maps::SiteFieldMap {
    if let Some(entry) = crate::jira_field_maps::get(site) {
        return entry;
    }
    // No cached entry — has discovery already failed this process?
    if discovery_failed()
        .lock()
        .map(|s| s.contains(site))
        .unwrap_or(false)
    {
        return crate::jira_field_maps::SiteFieldMap::default();
    }
    match discover_field_map(creds, site, project_key).await {
        Some(entry) => entry,
        None => {
            if let Ok(mut s) = discovery_failed().lock() {
                s.insert(site.to_string());
            }
            crate::jira_field_maps::SiteFieldMap::default()
        }
    }
}

/// The project key an issue key belongs to — the prefix before the last `-` (`MYT-5` →
/// `MYT`). Used for the board-config lookup in `issue_view`. Empty when there's no `-`.
/// Pure.
fn project_key_of_issue(key: &str) -> &str {
    key.rsplit_once('-').map(|(p, _)| p).unwrap_or("")
}

/// The repo's Jira issues for a linked project. `state` ∈ `"open"` | `"closed"` |
/// `"all"`. One page of `POST /rest/api/3/search/jql` (`maxResults: 50`); the
/// `nextPageToken` cursor is ignored (bounded-pagination policy). `fields` is explicit.
pub async fn issue_list(
    site: &str,
    project_key: &str,
    state: &str,
) -> AppResult<Vec<JiraIssueInfo>> {
    let site = normalize_site(site)?;
    // Grammar-validate the key and build the JQL BEFORE any network call.
    let jql = build_list_jql(project_key, state)?;
    let creds = load_credentials(&site).await?;
    // Resolve the site's agile custom-field map (lazy discovery; failure degrades to the
    // skeleton fields — never an error). The list uses the project key for the board
    // override; issue keys always belong to this project.
    let map = resolve_site_map(&creds, &site, project_key).await;
    let body = json!({
        "jql": jql,
        "maxResults": MAX_RESULTS,
        "fields": list_fields_for(&map),
    });
    let resp: JiraSearchResponse = post_json(&creds, "search/jql", &body, "issues").await?;
    Ok(resp
        .issues
        .iter()
        .filter_map(|issue| map_issue_info(&site, issue, &map))
        .collect())
}

// ── Issue detail ───────────────────────────────────────────────────────────────

/// One Jira comment, body converted from ADF to markdown.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraComment {
    pub id: String,
    pub author: Option<ForgeUserRef>,
    pub body_md: String,
    pub created_at: String,
}

/// Full read view of one Jira issue.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssueDetails {
    pub key: String,
    pub summary: String,
    pub status_name: String,
    pub status_category: String,
    pub issue_type_name: String,
    pub issue_type_icon_url: String,
    pub priority_name: String,
    pub assignee: Option<ForgeUserRef>,
    pub reporter: Option<ForgeUserRef>,
    pub labels: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub due_date: Option<String>,
    pub resolution_name: Option<String>,
    /// Story points (per-site `customfield_NNNNN`), or `None`. Serializes as `storyPoints`.
    pub story_points: Option<f64>,
    /// The name of the issue's first active sprint (`sprintName`), or `None`.
    pub sprint_name: Option<String>,
    /// That sprint's state (`sprintState`), or `None`.
    pub sprint_state: Option<String>,
    /// The parent (epic) reference, or `None`.
    pub parent: Option<JiraParentRef>,
    /// Component names (empty when none).
    pub components: Vec<String>,
    /// Fix-version names (`fixVersions`; empty when none).
    pub fix_versions: Vec<String>,
    /// The description ADF converted to markdown (empty when there's no description).
    pub description_md: String,
    pub comments: Vec<JiraComment>,
    pub url: String,
}

/// Map one Jira comment object (`{id, author, body, created}`) onto the neutral
/// [`JiraComment`], converting its ADF `body` to markdown. Used both for the embedded
/// comment list and for the single comment a `POST …/comment` returns. Defensive: every
/// field degrades to empty/None.
fn map_comment(c: &Value) -> JiraComment {
    JiraComment {
        id: c
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        author: parse_user(c.get("author")),
        body_md: c.get("body").map(adf::adf_to_markdown).unwrap_or_default(),
        created_at: c
            .get("created")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    }
}

/// Map the issue's `fields.comment.comments[]` onto neutral comments (first page as
/// returned; no pagination). Each comment's ADF body is converted to markdown; one
/// malformed comment is skipped rather than sinking the list.
fn map_comments(fields: &Value) -> Vec<JiraComment> {
    fields
        .get("comment")
        .and_then(|c| c.get("comments"))
        .and_then(Value::as_array)
        .map(|arr| arr.iter().map(map_comment).collect())
        .unwrap_or_default()
}

/// Full details for one Jira issue's read view. Validates `key`, then
/// `GET /rest/api/3/issue/<key>?fields=…`. The description + comment bodies (ADF) are
/// converted to markdown; every nullable field degrades to `None`/empty.
pub async fn issue_view(site: &str, key: &str) -> AppResult<JiraIssueDetails> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    let creds = load_credentials(&site).await?;
    // Resolve the site's agile custom-field map (lazy discovery; failure degrades to the
    // skeleton fields — never an error). Derive the project key from the issue key's prefix
    // for the board-config override.
    let map = resolve_site_map(&creds, &site, project_key_of_issue(key)).await;
    let custom = detail_custom_fields_suffix(&map);
    let path = format!(
        "issue/{key}?fields=summary,description,status,issuetype,priority,assignee,\
         reporter,labels,created,updated,duedate,resolution,parent,components,fixVersions,\
         comment{custom}"
    );
    let issue: Value = get_json(&creds, &path, "issue").await?;
    let fields = issue.get("fields").cloned().unwrap_or(Value::Null);

    let issue_type = fields.get("issuetype");
    let (sprint_name, sprint_state) = extract_sprint(&fields, &map);
    let description_md = fields
        .get("description")
        .filter(|d| !d.is_null())
        .map(adf::adf_to_markdown)
        .unwrap_or_default();

    Ok(JiraIssueDetails {
        summary: fields
            .get("summary")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        status_name: fields
            .get("status")
            .and_then(|s| s.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        status_category: status_category_of(&fields),
        issue_type_name: issue_type
            .and_then(|t| t.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        issue_type_icon_url: issue_type
            .and_then(|t| t.get("iconUrl"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        priority_name: fields
            .get("priority")
            .and_then(|p| p.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        assignee: parse_user(fields.get("assignee")),
        reporter: parse_user(fields.get("reporter")),
        labels: parse_labels(fields.get("labels")),
        created_at: fields
            .get("created")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        updated_at: fields
            .get("updated")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        due_date: fields
            .get("duedate")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        resolution_name: fields
            .get("resolution")
            .filter(|r| !r.is_null())
            .and_then(|r| r.get("name"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        story_points: extract_story_points(&fields, &map),
        sprint_name,
        sprint_state,
        parent: extract_parent(&fields),
        components: extract_named_array(&fields, "components"),
        fix_versions: extract_named_array(&fields, "fixVersions"),
        description_md,
        comments: map_comments(&fields),
        url: format!("https://{site}/browse/{key}"),
        key: key.to_string(),
    })
}

// ── Writes (phase 2): comment / transition / create / assign ───────────────────

/// Add a comment to a Jira issue. The markdown `body_md` is converted to ADF (via
/// [`md_to_adf`]) and posted to `POST /issue/<key>/comment`; the returned comment object
/// is mapped back to a neutral [`JiraComment`] (its ADF body round-tripped to markdown).
/// A whitespace-only body is rejected BEFORE any network call.
pub async fn issue_comment(site: &str, key: &str, body_md: &str) -> AppResult<JiraComment> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    if body_md.trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "a comment body is required".into(),
        ));
    }
    let creds = load_credentials(&site).await?;
    let adf = md_to_adf::markdown_to_adf(body_md);
    let body = json!({ "body": adf });
    let path = format!("issue/{key}/comment");
    let resp: Value = post_json(&creds, &path, &body, "comment").await?;
    Ok(map_comment(&resp))
}

/// The result of a close/reopen transition — the issue's fresh status after the workflow
/// step ran.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraTransitionResult {
    pub status_name: String,
    /// `status.statusCategory.key`: `"new"` | `"indeterminate"` | `"done"`.
    pub status_category: String,
}

/// A workflow transition as `GET /issue/<key>/transitions` returns it — the id we `POST`,
/// the transition's own display `name` (e.g. "Start Progress"), and the status it moves
/// the issue *to* (that status's display name + category).
#[derive(Deserialize, Default)]
struct JiraTransition {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    to: Option<JiraTransitionTo>,
}

/// The `to` block of a transition — the destination status's display `name` and its
/// category key. Jira sends the category as `statusCategory` (camelCase), so this struct
/// MUST rename or `to` never resolves a category and every transition looks
/// category-less.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct JiraTransitionTo {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    status_category: Option<JiraStatusCategory>,
}

/// A `statusCategory` block — only its `key` is read (`new`/`indeterminate`/`done`).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct JiraStatusCategory {
    #[serde(default)]
    key: Option<String>,
}

/// The `transitions` list envelope.
#[derive(Deserialize, Default)]
struct JiraTransitionsResponse {
    #[serde(default)]
    transitions: Vec<JiraTransition>,
}

/// Pick the transition id for a `direction` ("close" | "reopen") from the available
/// transitions. Pure (unit-tested) so the selection logic is isolated from the network.
///
/// - **close** → the first transition whose destination `statusCategory.key == "done"`.
/// - **reopen** → prefer a transition to `"new"`; fall back to `"indeterminate"`.
///
/// Returns `Ok(Some(id))` on a match, `Ok(None)` when no suitable transition exists (the
/// caller turns that into a workflow/permission error), or an `InvalidArgument` for an
/// unknown direction.
fn pick_transition_id(
    transitions: &[JiraTransition],
    direction: &str,
) -> AppResult<Option<String>> {
    // The id of the first transition whose destination status category matches `cat`.
    fn first_with_category(transitions: &[JiraTransition], cat: &str) -> Option<String> {
        transitions
            .iter()
            .find(|t| category_of(t) == Some(cat))
            .and_then(|t| t.id.clone())
    }
    match direction {
        "close" => Ok(first_with_category(transitions, "done")),
        "reopen" => {
            // Prefer a transition back to a "new" (To Do) status; fall back to any
            // "indeterminate" (In Progress) transition.
            Ok(first_with_category(transitions, "new")
                .or_else(|| first_with_category(transitions, "indeterminate")))
        }
        other => Err(AppError::InvalidArgument(format!(
            "unknown transition direction: {other}"
        ))),
    }
}

/// The destination status-category key of a transition (`to.statusCategory.key`), or
/// `None` when any link in the chain is absent.
fn category_of(t: &JiraTransition) -> Option<&str> {
    t.to.as_ref()?.status_category.as_ref()?.key.as_deref()
}

/// The destination status display name of a transition (`to.name`), or `None` when the
/// `to` block or its name is absent.
fn to_status_name_of(t: &JiraTransition) -> Option<&str> {
    t.to.as_ref()?.name.as_deref()
}

/// One workflow transition presented to the status picker: the id to POST, the
/// transition's own name, and the status it leads to.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraTransitionOption {
    pub id: String,
    pub name: String,
    pub to_status_name: String,
    pub to_status_category: String,
}

/// Map the parsed transitions onto the picker's [`JiraTransitionOption`] shape, in server
/// order. Entries missing an id are skipped (a transition we couldn't POST is useless to
/// offer); every other field degrades to empty. Pure (unit-tested).
fn transition_options(transitions: &[JiraTransition]) -> Vec<JiraTransitionOption> {
    transitions
        .iter()
        .filter_map(|t| {
            let id = t.id.clone().filter(|s| !s.is_empty())?;
            Some(JiraTransitionOption {
                id,
                name: t.name.clone().unwrap_or_default(),
                to_status_name: to_status_name_of(t).unwrap_or("").to_string(),
                to_status_category: category_of(t).unwrap_or("").to_string(),
            })
        })
        .collect()
}

/// Whether a transition id is a non-empty run of ASCII digits — Jira transition ids are
/// numeric strings, and this grammar-validates the id before it is spliced into the POST
/// body. Pure (testable).
fn is_valid_transition_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())
}

/// Extract `(statusName, statusCategoryKey)` from an `issue?fields=status` response. Pure.
fn status_of_issue(issue: &Value) -> (String, String) {
    let fields = issue.get("fields").cloned().unwrap_or(Value::Null);
    let status_name = fields
        .get("status")
        .and_then(|s| s.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    (status_name, status_category_of(&fields))
}

/// Close or reopen a Jira issue via its workflow. `direction` is `"close"` | `"reopen"`.
/// Fetches the available transitions, picks the one matching the direction (see
/// [`pick_transition_id`]), `POST`s it, then reads back the fresh status. Transition ids
/// are per-project workflow and are never hardcoded. When no suitable transition is
/// available (workflow or permissions), returns a clear, actionable error.
pub async fn issue_transition(
    site: &str,
    key: &str,
    direction: &str,
) -> AppResult<JiraTransitionResult> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    // Validate the direction up front (also validated inside pick_transition_id) so a bad
    // direction fails before any network call.
    if direction != "close" && direction != "reopen" {
        return Err(AppError::InvalidArgument(format!(
            "unknown transition direction: {direction}"
        )));
    }
    let creds = load_credentials(&site).await?;

    let list: JiraTransitionsResponse =
        get_json(&creds, &format!("issue/{key}/transitions"), "transitions").await?;
    let transition_id = pick_transition_id(&list.transitions, direction)?.ok_or_else(|| {
        let verb = if direction == "close" {
            "close"
        } else {
            "reopen"
        };
        AppError::Jira(format!(
            "No workflow transition to {verb} this issue is available — the project's \
             workflow or your permissions don't allow it."
        ))
    })?;

    post_transition_and_refetch(&creds, key, &transition_id).await
}

/// POST a chosen transition id for an issue and read back its fresh status. Shared by the
/// direction-based [`issue_transition`] and the explicit-id [`issue_transition_to`] so the
/// POST-then-refetch is written once. `key` is assumed already validated; `transition_id`
/// is assumed already grammar-validated by the caller.
async fn post_transition_and_refetch(
    creds: &JiraCredentials,
    key: &str,
    transition_id: &str,
) -> AppResult<JiraTransitionResult> {
    let body = json!({ "transition": { "id": transition_id } });
    send_no_content(
        creds,
        reqwest::Method::POST,
        &format!("issue/{key}/transitions"),
        Some(&body),
    )
    .await?;

    // Read back the fresh status (the transition response is 204 with no body).
    let issue: Value = get_json(creds, &format!("issue/{key}?fields=status"), "issue").await?;
    let (status_name, status_category) = status_of_issue(&issue);
    Ok(JiraTransitionResult {
        status_name,
        status_category,
    })
}

/// The full list of workflow transitions available for an issue right now, for the status
/// picker. `GET /issue/<key>/transitions`, mapped onto [`JiraTransitionOption`] in server
/// order (entries missing an id are skipped). The issue key is grammar-validated first.
pub async fn issue_transitions(site: &str, key: &str) -> AppResult<Vec<JiraTransitionOption>> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    let creds = load_credentials(&site).await?;
    let list: JiraTransitionsResponse =
        get_json(&creds, &format!("issue/{key}/transitions"), "transitions").await?;
    Ok(transition_options(&list.transitions))
}

/// Execute a specific workflow transition on an issue by its id (the id comes from
/// [`issue_transitions`]). The id is grammar-validated (non-empty ASCII digits) BEFORE it
/// is spliced into the POST body; then the shared POST-then-refetch runs, returning the
/// issue's fresh status. Unlike [`issue_transition`], the caller supplies the id directly
/// rather than deriving it from a close/reopen direction.
pub async fn issue_transition_to(
    site: &str,
    key: &str,
    transition_id: &str,
) -> AppResult<JiraTransitionResult> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    if !is_valid_transition_id(transition_id) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira transition id: {transition_id}"
        )));
    }
    let creds = load_credentials(&site).await?;
    post_transition_and_refetch(&creds, key, transition_id).await
}

/// The key + URL of a newly-created issue.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraCreatedIssue {
    pub key: String,
    pub url: String,
}

/// The `POST /issue` response — `{id, key, self}`; only `key` is read.
#[derive(Deserialize, Default)]
struct JiraCreatedIssueRaw {
    #[serde(default)]
    key: Option<String>,
}

/// Create a Jira issue. Requires a valid `project_key`, an `issue_type_id`, and a
/// non-empty trimmed `summary`; `description_md` becomes an ADF description only when it
/// is `Some` and non-empty. `POST /issue`; field-validation failures (e.g. a project with
/// mandatory custom fields) surface through the error envelope's field map — see
/// [`JiraErrorEnvelope::best_message`].
pub async fn issue_create(
    site: &str,
    project_key: &str,
    issue_type_id: &str,
    summary: &str,
    description_md: Option<&str>,
) -> AppResult<JiraCreatedIssue> {
    let site = normalize_site(site)?;
    if !is_valid_project_key(project_key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira project key: {project_key}"
        )));
    }
    let summary = summary.trim();
    if summary.is_empty() {
        return Err(AppError::InvalidArgument("a summary is required".into()));
    }
    if issue_type_id.trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "an issue type is required".into(),
        ));
    }
    let creds = load_credentials(&site).await?;

    let mut fields = serde_json::Map::new();
    fields.insert("project".to_string(), json!({ "key": project_key }));
    fields.insert("issuetype".to_string(), json!({ "id": issue_type_id }));
    fields.insert("summary".to_string(), json!(summary));
    if let Some(desc) = description_md.filter(|d| !d.trim().is_empty()) {
        fields.insert("description".to_string(), md_to_adf::markdown_to_adf(desc));
    }
    let body = json!({ "fields": Value::Object(fields) });

    let created: JiraCreatedIssueRaw = post_json(&creds, "issue", &body, "created issue").await?;
    let key = created
        .key
        .filter(|k| !k.is_empty())
        .ok_or_else(|| AppError::Jira("Jira created the issue but returned no key.".into()))?;
    let url = format!("https://{site}/browse/{key}");
    Ok(JiraCreatedIssue { key, url })
}

/// One issue type for the create picker.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssueType {
    pub id: String,
    pub name: String,
    pub icon_url: String,
    /// Whether this is a subtask type (the frontend filters these out of the top-level
    /// create picker).
    pub subtask: bool,
}

/// One issue type as the createmeta endpoint returns it. Every field is tolerant.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct JiraIssueTypeRaw {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    subtask: bool,
}

impl JiraIssueTypeRaw {
    fn into_type(self) -> JiraIssueType {
        JiraIssueType {
            id: self.id.unwrap_or_default(),
            name: self.name.unwrap_or_default(),
            icon_url: self.icon_url.unwrap_or_default(),
            subtask: self.subtask,
        }
    }
}

/// The modern per-project createmeta issue-types response —
/// `GET /issue/createmeta/<projectKey>/issuetypes` returns a paginated
/// `{startAt, maxResults, total, issueTypes:[…]}` envelope. The array is under
/// `issueTypes` (NOT `values`), so the field renames — otherwise it deserializes empty
/// and the create picker shows "no issue types".
#[derive(Deserialize, Default)]
struct JiraCreatemetaIssueTypes {
    #[serde(default, rename = "issueTypes")]
    issue_types: Vec<JiraIssueTypeRaw>,
}

/// The available issue types for a project's create form. Uses the modern per-project
/// sub-endpoint `GET /rest/api/3/issue/createmeta/<projectKey>/issuetypes`
/// ([Atlassian REST v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-createmeta-projectidorkey-issuetypes-get)).
/// Returns ALL types including subtask types (the frontend decides what to show). The
/// project key is grammar-validated before it is interpolated into the path.
pub async fn issue_types(site: &str, project_key: &str) -> AppResult<Vec<JiraIssueType>> {
    let site = normalize_site(site)?;
    if !is_valid_project_key(project_key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira project key: {project_key}"
        )));
    }
    let creds = load_credentials(&site).await?;
    let path = format!("issue/createmeta/{project_key}/issuetypes?maxResults={MAX_RESULTS}");
    let page: JiraCreatemetaIssueTypes = get_json(&creds, &path, "issue types").await?;
    Ok(page
        .issue_types
        .into_iter()
        .map(JiraIssueTypeRaw::into_type)
        .collect())
}

/// Assign (or unassign) a Jira issue. `account_id = Some(id)` assigns; `None` unassigns
/// (`PUT /issue/<key>/assignee` with `{"accountId": null}`). Returns unit on the 204.
pub async fn issue_assign(site: &str, key: &str, account_id: Option<&str>) -> AppResult<()> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    let creds = load_credentials(&site).await?;
    // `accountId: null` unassigns; a bare id assigns. Serialize either explicitly.
    let body = json!({ "accountId": account_id });
    send_no_content(
        &creds,
        reqwest::Method::PUT,
        &format!("issue/{key}/assignee"),
        Some(&body),
    )
    .await
}

/// Search users assignable to an issue, for the assignee picker.
/// `GET /user/assignable/search?issueKey=<key>&query=<q>&maxResults=30`. Maps each user
/// onto the neutral [`ForgeUserRef`] (accountId / displayName / 48x48 avatar).
pub async fn user_search(site: &str, key: &str, query: &str) -> AppResult<Vec<ForgeUserRef>> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    let creds = load_credentials(&site).await?;
    let path = format!(
        "user/assignable/search?issueKey={}&query={}&maxResults=30",
        crate::forge::encode_query_value(key),
        crate::forge::encode_query_value(query),
    );
    let users: Vec<JiraUser> = get_json(&creds, &path, "assignable users").await?;
    Ok(users.iter().map(JiraUser::to_ref).collect())
}

/// The per-project permissions the frontend uses to gate write actions.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraProjectPermissions {
    pub add_comments: bool,
    pub transition_issues: bool,
    pub create_issues: bool,
    pub assign_issues: bool,
}

/// Whether a single permission in a `mypermissions` response is granted. Defensive: an
/// absent or malformed entry reads as `false` (never errors the whole probe on one key).
/// Pure (testable).
fn have_permission(permissions: &Value, name: &str) -> bool {
    permissions
        .get("permissions")
        .and_then(|p| p.get(name))
        .and_then(|entry| entry.get("havePermission"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Parse a `mypermissions` response into [`JiraProjectPermissions`]. Pure (testable): each
/// flag defends independently, so one missing/malformed key never sinks the others.
fn parse_permissions(body: &Value) -> JiraProjectPermissions {
    JiraProjectPermissions {
        add_comments: have_permission(body, "ADD_COMMENTS"),
        transition_issues: have_permission(body, "TRANSITION_ISSUES"),
        create_issues: have_permission(body, "CREATE_ISSUES"),
        assign_issues: have_permission(body, "ASSIGN_ISSUES"),
    }
}

/// The caller's permissions on a project, gating the write actions.
/// `GET /rest/api/3/mypermissions?projectKey=<key>&permissions=…`. Each flag is
/// `permissions.<KEY>.havePermission == true`; a missing/malformed key defaults to
/// `false` rather than erroring the whole probe.
pub async fn permissions(site: &str, project_key: &str) -> AppResult<JiraProjectPermissions> {
    let site = normalize_site(site)?;
    if !is_valid_project_key(project_key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira project key: {project_key}"
        )));
    }
    let creds = load_credentials(&site).await?;
    let path = format!(
        "mypermissions?projectKey={}&permissions=ADD_COMMENTS,TRANSITION_ISSUES,\
         CREATE_ISSUES,ASSIGN_ISSUES",
        crate::forge::encode_query_value(project_key),
    );
    let body: Value = get_json(&creds, &path, "permissions").await?;
    Ok(parse_permissions(&body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalize_site_strips_scheme_slash_and_lowercases() {
        assert_eq!(
            normalize_site("https://YourTeam.atlassian.net/").unwrap(),
            "yourteam.atlassian.net"
        );
        assert_eq!(
            normalize_site("  team-1.atlassian.net  ").unwrap(),
            "team-1.atlassian.net"
        );
        assert_eq!(
            normalize_site("http://acme.atlassian.net").unwrap(),
            "acme.atlassian.net"
        );
    }

    #[test]
    fn normalize_site_rejects_non_cloud_hosts() {
        for bad in [
            "example.com",
            "jira.mycompany.com",
            "atlassian.net",     // no subdomain label
            ".atlassian.net",    // empty label
            "a.b.atlassian.net", // nested subdomain
            "team.atlassian.net.evil.com",
            "",
            "team_underscore.atlassian.net", // underscore not allowed in a host label
        ] {
            assert!(
                normalize_site(bad).is_err(),
                "expected {bad:?} to be rejected"
            );
        }
    }

    #[test]
    fn valid_project_key() {
        assert!(is_valid_project_key("PROJ"));
        assert!(is_valid_project_key("A"));
        assert!(is_valid_project_key("AB1"));
        assert!(is_valid_project_key("MY_PROJ2"));
        assert!(!is_valid_project_key(""));
        assert!(!is_valid_project_key("1AB")); // must start with a letter
        assert!(!is_valid_project_key("proj")); // lowercase
        assert!(!is_valid_project_key("PR OJ")); // space
        assert!(!is_valid_project_key("PR-OJ")); // hyphen
        assert!(!is_valid_project_key("PR\"OJ")); // JQL-injection char
    }

    #[test]
    fn valid_issue_key() {
        assert!(is_valid_issue_key("PROJ-1"));
        assert!(is_valid_issue_key("AB1-1234"));
        assert!(is_valid_issue_key("MY_PROJ-99"));
        assert!(!is_valid_issue_key("PROJ"));
        assert!(!is_valid_issue_key("PROJ-"));
        assert!(!is_valid_issue_key("proj-1"));
        assert!(!is_valid_issue_key("PROJ-1a"));
        assert!(!is_valid_issue_key("-1"));
        assert!(!is_valid_issue_key("PROJ-1-2")); // rsplit keeps "2" numeric but "PROJ-1" isn't a valid project key
    }

    #[test]
    fn build_list_jql_three_states() {
        assert_eq!(
            build_list_jql("PROJ", "open").unwrap(),
            "project = \"PROJ\" AND statusCategory != Done ORDER BY updated DESC"
        );
        assert_eq!(
            build_list_jql("PROJ", "closed").unwrap(),
            "project = \"PROJ\" AND statusCategory = Done ORDER BY updated DESC"
        );
        assert_eq!(
            build_list_jql("PROJ", "all").unwrap(),
            "project = \"PROJ\" ORDER BY updated DESC"
        );
    }

    #[test]
    fn build_list_jql_rejects_bad_key_and_state() {
        assert!(matches!(
            build_list_jql("bad key", "open"),
            Err(AppError::InvalidArgument(_))
        ));
        assert!(matches!(
            build_list_jql("PROJ", "sideways"),
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[test]
    fn status_category_extraction() {
        let fields = json!({
            "status": { "name": "In Review", "statusCategory": { "key": "indeterminate" } }
        });
        assert_eq!(status_category_of(&fields), "indeterminate");
        // Absent category → empty.
        assert_eq!(status_category_of(&json!({})), "");
        assert_eq!(status_category_of(&json!({ "status": {} })), "");
    }

    #[test]
    fn error_envelope_prefers_first_error_message() {
        let body = r#"{"errorMessages":["Issue does not exist"],"errors":{}}"#;
        match http_error(404, body) {
            AppError::Jira(m) => assert!(m.contains("Issue does not exist")),
            other => panic!("expected Jira error, got {other:?}"),
        }
    }

    #[test]
    fn error_envelope_falls_back_to_field_errors() {
        let body = r#"{"errorMessages":[],"errors":{"project":"The project is invalid"}}"#;
        match http_error(400, body) {
            AppError::Jira(m) => assert!(m.contains("project is invalid")),
            other => panic!("expected Jira error, got {other:?}"),
        }
    }

    #[test]
    fn error_special_cases_401_403_429() {
        match http_error(401, "") {
            AppError::Jira(m) => assert!(m.contains("401") && m.to_lowercase().contains("token")),
            other => panic!("got {other:?}"),
        }
        match http_error(403, "") {
            AppError::Jira(m) => assert!(m.contains("403") && m.to_lowercase().contains("access")),
            other => panic!("got {other:?}"),
        }
        match http_error(429, "") {
            AppError::Jira(m) => assert!(m.to_lowercase().contains("rate limit")),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn error_falls_back_to_status_and_snippet() {
        match http_error(500, "upstream boom") {
            AppError::Jira(m) => {
                assert!(m.contains("500"));
                assert!(m.contains("upstream boom"));
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn api_base_direct_builds_site_url() {
        let base = JiraApiBase::Direct {
            site: "team.atlassian.net".into(),
        };
        assert_eq!(
            base.resolve("myself"),
            "https://team.atlassian.net/rest/api/3/myself"
        );
        // A leading slash on the relative path is tolerated (not doubled).
        assert_eq!(
            base.resolve("/issue/PROJ-1"),
            "https://team.atlassian.net/rest/api/3/issue/PROJ-1"
        );
    }

    #[test]
    fn api_base_gateway_builds_ex_jira_url() {
        let base = JiraApiBase::Gateway {
            cloud_id: "abc-123".into(),
        };
        assert_eq!(
            base.resolve("myself"),
            "https://api.atlassian.com/ex/jira/abc-123/rest/api/3/myself"
        );
        assert_eq!(
            base.resolve("search/jql"),
            "https://api.atlassian.com/ex/jira/abc-123/rest/api/3/search/jql"
        );
    }

    #[test]
    fn api_base_keyring_value_round_trips() {
        let direct = JiraApiBase::Direct {
            site: "team.atlassian.net".into(),
        };
        let gateway = JiraApiBase::Gateway {
            cloud_id: "abc-123".into(),
        };
        assert_eq!(direct.to_keyring_value(), "direct");
        assert_eq!(gateway.to_keyring_value(), "gateway:abc-123");
        // Round-trip: parse the stored value back (site supplied for the Direct case).
        assert_eq!(
            JiraApiBase::from_keyring_value(Some("gateway:abc-123"), "team.atlassian.net"),
            gateway
        );
        assert_eq!(
            JiraApiBase::from_keyring_value(Some("direct"), "team.atlassian.net"),
            direct
        );
    }

    #[test]
    fn api_base_from_keyring_defaults_to_direct() {
        let site = "team.atlassian.net";
        let expect_direct = JiraApiBase::Direct { site: site.into() };
        // Missing entry (pre-existing creds), unknown value, and an empty gateway id all
        // default to Direct — a later 401 surfaces normally and re-linking re-resolves.
        assert_eq!(JiraApiBase::from_keyring_value(None, site), expect_direct);
        assert_eq!(
            JiraApiBase::from_keyring_value(Some(""), site),
            expect_direct
        );
        assert_eq!(
            JiraApiBase::from_keyring_value(Some("weird"), site),
            expect_direct
        );
        assert_eq!(
            JiraApiBase::from_keyring_value(Some("gateway:"), site),
            expect_direct
        );
    }

    #[test]
    fn decide_after_direct_branches() {
        assert_eq!(decide_after_direct(200), DirectProbeStep::UseDirect);
        assert_eq!(decide_after_direct(204), DirectProbeStep::UseDirect);
        // 401 site-direct is the scoped-token signal → try the gateway.
        assert_eq!(decide_after_direct(401), DirectProbeStep::TryGateway);
        // Everything else is a genuine direct-base failure, surfaced unchanged.
        assert_eq!(decide_after_direct(403), DirectProbeStep::Fail);
        assert_eq!(decide_after_direct(404), DirectProbeStep::Fail);
        assert_eq!(decide_after_direct(500), DirectProbeStep::Fail);
    }

    #[test]
    fn cloud_id_from_body_guards_shape() {
        // A well-formed tenant_info yields the id.
        assert_eq!(
            cloud_id_from_body(r#"{"cloudId":"abc-123"}"#).unwrap(),
            "abc-123"
        );
        // Missing, null, empty, whitespace, or a non-JSON body → the clear error, never
        // a blank id (which would build a broken gateway URL).
        for bad in [
            r#"{}"#,
            r#"{"cloudId":null}"#,
            r#"{"cloudId":""}"#,
            r#"{"cloudId":"   "}"#,
            "not json",
        ] {
            match cloud_id_from_body(bad) {
                Err(AppError::Jira(m)) => assert!(m.contains("cloud id"), "bad msg for {bad:?}"),
                other => panic!("expected a cloud-id error for {bad:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn specialize_manual_error_rewrites_auth_codes_only() {
        // Manual entry: after BOTH bases failed, an auth error frames the token as
        // possibly-wrong-product or expired, keeping the code marker.
        for code in ["401", "403"] {
            let base = http_error(code.parse().unwrap(), "");
            match specialize_manual_error(base) {
                AppError::Jira(m) => {
                    assert!(m.contains(&format!("({code})")), "missing marker: {m}");
                    let lower = m.to_lowercase();
                    assert!(lower.contains("jira api token"), "missing guidance: {m}");
                }
                other => panic!("got {other:?}"),
            }
        }
        // A non-auth error (429) passes through unchanged.
        let base_429 = http_error(429, "");
        let AppError::Jira(orig) = &base_429 else {
            panic!("expected Jira 429");
        };
        let orig = orig.clone();
        match specialize_manual_error(base_429) {
            AppError::Jira(m) => assert_eq!(m, orig),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn map_issue_info_defensive_and_url() {
        let issue = json!({
            "key": "PROJ-7",
            "fields": {
                "summary": "Fix the bug",
                "status": { "name": "To Do", "statusCategory": { "key": "new" } },
                "issuetype": { "name": "Bug", "iconUrl": "https://icon" },
                "priority": { "name": "High" },
                "assignee": {
                    "accountId": "acc-1",
                    "displayName": "Ada",
                    "avatarUrls": { "48x48": "https://av" }
                },
                "labels": ["backend", "urgent"],
                "created": "2026-01-01T00:00:00.000+0000",
                "updated": "2026-01-02T00:00:00.000+0000"
            }
        });
        let info = map_issue_info(
            "team.atlassian.net",
            &issue,
            &crate::jira_field_maps::SiteFieldMap::default(),
        )
        .unwrap();
        assert_eq!(info.key, "PROJ-7");
        assert_eq!(info.summary, "Fix the bug");
        assert_eq!(info.status_name, "To Do");
        assert_eq!(info.status_category, "new");
        assert_eq!(info.issue_type_name, "Bug");
        assert_eq!(info.issue_type_icon_url, "https://icon");
        assert_eq!(info.priority_name, "High");
        assert_eq!(info.url, "https://team.atlassian.net/browse/PROJ-7");
        let a = info.assignee.unwrap();
        assert_eq!(a.id, "acc-1");
        assert_eq!(a.label, "Ada");
        assert_eq!(a.avatar_url, "https://av");
        assert_eq!(info.labels, vec!["backend", "urgent"]);
        // With a default (empty) map, agile fields all degrade to None/empty.
        assert!(info.story_points.is_none());
        assert!(info.sprint_name.is_none());
        assert!(info.parent.is_none());
        assert!(info.components.is_empty());
        assert!(info.fix_versions.is_empty());
    }

    #[test]
    fn map_issue_info_handles_nulls() {
        // A minimal issue: no fields object, null assignee/priority.
        let issue = json!({
            "key": "PROJ-1",
            "fields": { "assignee": null, "priority": null, "labels": null }
        });
        let info = map_issue_info(
            "s.atlassian.net",
            &issue,
            &crate::jira_field_maps::SiteFieldMap::default(),
        )
        .unwrap();
        assert_eq!(info.key, "PROJ-1");
        assert_eq!(info.summary, "");
        assert_eq!(info.priority_name, "");
        assert!(info.assignee.is_none());
        assert!(info.labels.is_empty());
    }

    #[test]
    fn map_issue_info_skips_keyless_issue() {
        let empty = crate::jira_field_maps::SiteFieldMap::default();
        assert!(map_issue_info("s.atlassian.net", &json!({ "fields": {} }), &empty).is_none());
        assert!(map_issue_info("s.atlassian.net", &json!({ "key": "" }), &empty).is_none());
    }

    #[test]
    fn parse_user_none_for_null_or_missing() {
        assert!(parse_user(None).is_none());
        assert!(parse_user(Some(&Value::Null)).is_none());
        assert!(parse_user(Some(&json!("not an object"))).is_none());
    }

    #[test]
    fn map_comments_converts_adf_bodies() {
        let fields = json!({
            "comment": {
                "comments": [
                    {
                        "id": "10001",
                        "author": { "accountId": "a1", "displayName": "Bob" },
                        "body": {
                            "type": "doc",
                            "version": 1,
                            "content": [
                                { "type": "paragraph", "content": [
                                    { "type": "text", "text": "Looks good" }
                                ]}
                            ]
                        },
                        "created": "2026-02-01T00:00:00.000+0000"
                    }
                ]
            }
        });
        let comments = map_comments(&fields);
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].id, "10001");
        assert_eq!(comments[0].body_md, "Looks good");
        assert_eq!(comments[0].author.as_ref().unwrap().label, "Bob");
    }

    #[test]
    fn map_comments_empty_when_absent() {
        assert!(map_comments(&json!({})).is_empty());
        assert!(map_comments(&json!({ "comment": {} })).is_empty());
    }

    #[test]
    fn bitbucket_creds_present_requires_both_non_empty() {
        let s = |v: &str| Some(v.to_string());
        assert!(bitbucket_creds_present(&s("me@x.com"), &s("tok")));
        // Missing either → not present.
        assert!(!bitbucket_creds_present(&None, &s("tok")));
        assert!(!bitbucket_creds_present(&s("me@x.com"), &None));
        assert!(!bitbucket_creds_present(&None, &None));
        // Empty string → not present (the guard the reuse path runs before any network).
        assert!(!bitbucket_creds_present(&s(""), &s("tok")));
        assert!(!bitbucket_creds_present(&s("me@x.com"), &s("")));
    }

    #[test]
    fn specialize_reuse_error_rewrites_401_and_403_passes_others_through() {
        // Both auth codes are rewritten to the product-scoped, enter-manually framing,
        // preserving the status marker. A real product-scoped Bitbucket token returns
        // 401 on Jira (live-verified 2026-07-10), so 401 must be rewritten too — NOT
        // left as the generic "expired/revoked" copy.
        for code in ["401", "403"] {
            let base = http_error(code.parse().unwrap(), "");
            match specialize_reuse_error(base) {
                AppError::Jira(m) => {
                    assert!(
                        m.contains(&format!("({code})")),
                        "missing marker for {code}: {m}"
                    );
                    let lower = m.to_lowercase();
                    assert!(lower.contains("product-scoped"), "missing framing: {m}");
                    assert!(lower.contains("manually"), "missing fallback: {m}");
                    // The misleading generic 401 wording must be gone.
                    assert!(
                        !lower.contains("expired"),
                        "still has generic 401 copy: {m}"
                    );
                }
                other => panic!("got {other:?}"),
            }
        }
        // A non-auth error (e.g. 429 rate limit) passes through UNCHANGED — the
        // specialization is scoped to auth codes only.
        let base_429 = http_error(429, "");
        let AppError::Jira(orig_429) = &base_429 else {
            panic!("expected a Jira 429");
        };
        let orig_429 = orig_429.clone();
        match specialize_reuse_error(base_429) {
            AppError::Jira(m) => assert_eq!(m, orig_429),
            other => panic!("got {other:?}"),
        }
    }

    // ── Write-path pure logic ────────────────────────────────────────────────────

    /// Build a transitions list from `(id, categoryKey)` pairs.
    fn transitions(pairs: &[(&str, &str)]) -> Vec<JiraTransition> {
        pairs
            .iter()
            .map(|(id, cat)| JiraTransition {
                id: Some((*id).to_string()),
                to: Some(JiraTransitionTo {
                    status_category: Some(JiraStatusCategory {
                        key: Some((*cat).to_string()),
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            })
            .collect()
    }

    #[test]
    fn pick_transition_close_finds_done() {
        let ts = transitions(&[("11", "new"), ("21", "indeterminate"), ("31", "done")]);
        assert_eq!(
            pick_transition_id(&ts, "close").unwrap(),
            Some("31".to_string())
        );
    }

    #[test]
    fn pick_transition_reopen_prefers_new_over_indeterminate() {
        // Both a "new" and an "indeterminate" transition exist — reopen picks "new".
        let ts = transitions(&[("31", "done"), ("21", "indeterminate"), ("11", "new")]);
        assert_eq!(
            pick_transition_id(&ts, "reopen").unwrap(),
            Some("11".to_string())
        );
    }

    #[test]
    fn pick_transition_reopen_falls_back_to_indeterminate() {
        // No "new" transition — reopen falls back to "indeterminate".
        let ts = transitions(&[("31", "done"), ("21", "indeterminate")]);
        assert_eq!(
            pick_transition_id(&ts, "reopen").unwrap(),
            Some("21".to_string())
        );
    }

    #[test]
    fn pick_transition_none_when_no_match() {
        // Close with only non-done transitions → no id (caller raises the workflow error).
        let ts = transitions(&[("11", "new"), ("21", "indeterminate")]);
        assert_eq!(pick_transition_id(&ts, "close").unwrap(), None);
        // Reopen with only a done transition → no id.
        let ts2 = transitions(&[("31", "done")]);
        assert_eq!(pick_transition_id(&ts2, "reopen").unwrap(), None);
        // Empty list → no id for either direction.
        assert_eq!(pick_transition_id(&[], "close").unwrap(), None);
        assert_eq!(pick_transition_id(&[], "reopen").unwrap(), None);
    }

    #[test]
    fn pick_transition_rejects_unknown_direction() {
        let ts = transitions(&[("31", "done")]);
        assert!(matches!(
            pick_transition_id(&ts, "sideways"),
            Err(AppError::InvalidArgument(_))
        ));
    }

    #[test]
    fn pick_transition_tolerates_missing_to_or_category() {
        // A transition with no `to`, or a `to` with no category, is simply not matched.
        let ts = vec![
            JiraTransition {
                id: Some("1".into()),
                to: None,
                ..Default::default()
            },
            JiraTransition {
                id: Some("2".into()),
                to: Some(JiraTransitionTo {
                    status_category: None,
                    ..Default::default()
                }),
                ..Default::default()
            },
            JiraTransition {
                id: Some("3".into()),
                to: Some(JiraTransitionTo {
                    status_category: Some(JiraStatusCategory {
                        key: Some("done".into()),
                    }),
                    ..Default::default()
                }),
                ..Default::default()
            },
        ];
        assert_eq!(
            pick_transition_id(&ts, "close").unwrap(),
            Some("3".to_string())
        );
    }

    #[test]
    fn status_of_issue_reads_name_and_category() {
        let issue = json!({
            "fields": {
                "status": { "name": "In Review", "statusCategory": { "key": "indeterminate" } }
            }
        });
        assert_eq!(
            status_of_issue(&issue),
            ("In Review".to_string(), "indeterminate".to_string())
        );
        // Missing fields → empty strings, not a panic.
        assert_eq!(status_of_issue(&json!({})), (String::new(), String::new()));
    }

    #[test]
    fn parse_permissions_each_flag_independent() {
        let body = json!({
            "permissions": {
                "ADD_COMMENTS": { "havePermission": true },
                "TRANSITION_ISSUES": { "havePermission": false },
                "CREATE_ISSUES": { "havePermission": true },
                // ASSIGN_ISSUES absent entirely.
            }
        });
        let p = parse_permissions(&body);
        assert!(p.add_comments);
        assert!(!p.transition_issues);
        assert!(p.create_issues);
        // Absent key → false, never an error.
        assert!(!p.assign_issues);
    }

    #[test]
    fn parse_permissions_malformed_defaults_false() {
        // A completely malformed body (no `permissions` object) reads as all-false.
        let p = parse_permissions(&json!({ "permissions": "nope" }));
        assert!(!p.add_comments);
        assert!(!p.transition_issues);
        assert!(!p.create_issues);
        assert!(!p.assign_issues);
        // A present entry with a non-bool havePermission also defaults false.
        let p2 = parse_permissions(&json!({
            "permissions": { "ADD_COMMENTS": { "havePermission": "yes" } }
        }));
        assert!(!p2.add_comments);
    }

    #[test]
    fn field_errors_joined_names_all_fields_sorted() {
        // A create failing on several mandatory fields must name every one, deterministically.
        let env = JiraErrorEnvelope {
            error_messages: vec![],
            errors: std::collections::HashMap::from([
                (
                    "customfield_10020".to_string(),
                    "Sprint is required.".to_string(),
                ),
                ("summary".to_string(), "Summary is required.".to_string()),
                ("blank".to_string(), "   ".to_string()), // empty → dropped
            ]),
        };
        // With no name map (resolver returns None), keys render raw — today's behavior.
        let joined = env.field_errors_joined(|_| None).unwrap();
        // Sorted by field key; the whitespace-only entry is dropped.
        assert_eq!(
            joined,
            "customfield_10020: Sprint is required.; summary: Summary is required."
        );
        // best_message uses field errors when errorMessages is empty.
        assert_eq!(env.best_message(|_| None).unwrap(), joined);
    }

    #[test]
    fn field_errors_joined_none_when_empty() {
        let env = JiraErrorEnvelope::default();
        assert!(env.field_errors_joined(|_| None).is_none());
        assert!(env.best_message(|_| None).is_none());
    }

    #[test]
    fn best_message_prefers_error_messages_over_fields() {
        let env = JiraErrorEnvelope {
            error_messages: vec!["Top-level failure".to_string()],
            errors: std::collections::HashMap::from([(
                "summary".to_string(),
                "Summary is required.".to_string(),
            )]),
        };
        assert_eq!(env.best_message(|_| None).unwrap(), "Top-level failure");
    }

    #[test]
    fn is_customfield_key_matches_only_numeric_customfields() {
        assert!(is_customfield_key("customfield_10016"));
        assert!(is_customfield_key("customfield_1"));
        assert!(!is_customfield_key("customfield_")); // no digits
        assert!(!is_customfield_key("customfield_10a")); // non-digit
        assert!(!is_customfield_key("summary"));
        assert!(!is_customfield_key("customfield")); // no underscore/number
        assert!(!is_customfield_key("Customfield_10")); // case-sensitive prefix
    }

    #[test]
    fn translate_field_key_known_unknown_and_nonmatch() {
        // Known custom id → name.
        let resolve =
            |k: &str| (k == "customfield_10016").then(|| "Story point estimate".to_string());
        assert_eq!(
            translate_field_key("customfield_10016", resolve),
            "Story point estimate"
        );
        // Unknown custom id → raw.
        assert_eq!(
            translate_field_key("customfield_99999", resolve),
            "customfield_99999"
        );
        // Non-customfield key → raw (resolver never consulted).
        assert_eq!(translate_field_key("summary", resolve), "summary");
        // No-map resolver → raw (today's behavior).
        assert_eq!(
            translate_field_key("customfield_10016", |_| None),
            "customfield_10016"
        );
    }

    #[test]
    fn field_errors_joined_translates_known_customfield_names() {
        // A warm name map renders friendly field names; unknown ids stay raw. The sort is
        // on the RAW keys (deterministic regardless of the map).
        let env = JiraErrorEnvelope {
            error_messages: vec![],
            errors: std::collections::HashMap::from([
                (
                    "customfield_10016".to_string(),
                    "Story point estimate is required.".to_string(),
                ),
                (
                    "customfield_99999".to_string(),
                    "Mystery is required.".to_string(),
                ),
            ]),
        };
        let resolve =
            |k: &str| (k == "customfield_10016").then(|| "Story point estimate".to_string());
        let joined = env.field_errors_joined(resolve).unwrap();
        assert_eq!(
            joined,
            "Story point estimate: Story point estimate is required.; \
             customfield_99999: Mystery is required."
        );
    }

    #[test]
    fn create_field_errors_surface_through_http_error() {
        // The end-to-end path a create hits: a 400 with a field-only envelope surfaces the
        // joined field messages (not a bare "HTTP 400").
        let body = r#"{"errorMessages":[],"errors":{"customfield_1":"Epic Link is required.","summary":"You must specify a summary."}}"#;
        match http_error(400, body) {
            AppError::Jira(m) => {
                assert!(m.contains("Epic Link is required."), "got {m}");
                assert!(m.contains("You must specify a summary."), "got {m}");
            }
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn issue_type_raw_maps_all_fields() {
        let raw: JiraIssueTypeRaw = serde_json::from_value(json!({
            "id": "10001",
            "name": "Bug",
            "iconUrl": "https://icon",
            "subtask": false
        }))
        .unwrap();
        let t = raw.into_type();
        assert_eq!(t.id, "10001");
        assert_eq!(t.name, "Bug");
        assert_eq!(t.icon_url, "https://icon");
        assert!(!t.subtask);

        // A subtask type with missing icon degrades gracefully.
        let sub: JiraIssueTypeRaw = serde_json::from_value(json!({
            "id": "10002", "name": "Sub-task", "subtask": true
        }))
        .unwrap();
        let st = sub.into_type();
        assert!(st.subtask);
        assert_eq!(st.icon_url, "");
    }

    // ── From-live-JSON regression guards (camelCase shape mismatches) ────────────
    //
    // These parse the EXACT camelCase JSON a real Jira Cloud tenant returns
    // (thebguy.atlassian.net / project MYT, 2026-07-11) through the real structs —
    // catching the class of bug the hand-built / snake_case fixtures above missed: a
    // struct field whose name differs from the wire key.

    #[test]
    fn transitions_response_parses_live_camelcase_and_picks_done() {
        // Verbatim shape from GET /issue/MYT-5/transitions. Before the
        // `#[serde(rename_all = "camelCase")]` on JiraTransitionTo, `statusCategory` was
        // dropped, `category_of` returned None for every entry, and close found nothing.
        let body = r#"{
            "transitions": [
                { "id": "11", "name": "Start Progress",
                  "to": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } } },
                { "id": "21", "name": "Done",
                  "to": { "name": "Done", "statusCategory": { "key": "done" } } }
            ]
        }"#;
        let parsed: JiraTransitionsResponse = serde_json::from_str(body).unwrap();
        // The done category must actually deserialize (the crux of bug 1).
        assert_eq!(category_of(&parsed.transitions[1]), Some("done"));
        // The destination status name (`to.name`) must also deserialize (phase-3 addition).
        assert_eq!(
            to_status_name_of(&parsed.transitions[0]),
            Some("In Progress")
        );
        assert_eq!(to_status_name_of(&parsed.transitions[1]), Some("Done"));
        assert_eq!(
            pick_transition_id(&parsed.transitions, "close").unwrap(),
            Some("21".to_string())
        );
        // Reopen from here has no "new", falls back to the "indeterminate" transition.
        assert_eq!(
            pick_transition_id(&parsed.transitions, "reopen").unwrap(),
            Some("11".to_string())
        );
    }

    #[test]
    fn transition_options_maps_live_fixture_in_server_order() {
        // The status picker consumes ALL transitions (not just close/reopen), mapping each
        // to {id, name, toStatusName, toStatusCategory} in the order the server returned.
        let body = r#"{
            "transitions": [
                { "id": "11", "name": "Start Progress",
                  "to": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } } },
                { "id": "21", "name": "Done",
                  "to": { "name": "Done", "statusCategory": { "key": "done" } } }
            ]
        }"#;
        let parsed: JiraTransitionsResponse = serde_json::from_str(body).unwrap();
        let opts = transition_options(&parsed.transitions);
        assert_eq!(opts.len(), 2);
        assert_eq!(opts[0].id, "11");
        assert_eq!(opts[0].name, "Start Progress");
        assert_eq!(opts[0].to_status_name, "In Progress");
        assert_eq!(opts[0].to_status_category, "indeterminate");
        assert_eq!(opts[1].id, "21");
        assert_eq!(opts[1].name, "Done");
        assert_eq!(opts[1].to_status_name, "Done");
        assert_eq!(opts[1].to_status_category, "done");
    }

    #[test]
    fn transition_options_skips_idless_and_degrades_missing_fields() {
        // An entry with no id is dropped (can't POST it); missing name/to fields degrade
        // to empty strings rather than sinking the whole list.
        let body = r#"{
            "transitions": [
                { "name": "No Id Here", "to": { "name": "X", "statusCategory": { "key": "new" } } },
                { "id": "31" },
                { "id": "", "name": "Empty Id" }
            ]
        }"#;
        let parsed: JiraTransitionsResponse = serde_json::from_str(body).unwrap();
        let opts = transition_options(&parsed.transitions);
        // Only the id-"31" entry survives (idless + empty-id are skipped).
        assert_eq!(opts.len(), 1);
        assert_eq!(opts[0].id, "31");
        assert_eq!(opts[0].name, "");
        assert_eq!(opts[0].to_status_name, "");
        assert_eq!(opts[0].to_status_category, "");
    }

    #[test]
    fn transition_options_empty_when_no_transitions() {
        assert!(transition_options(&[]).is_empty());
    }

    #[test]
    fn valid_transition_id_requires_nonempty_digits() {
        assert!(is_valid_transition_id("21"));
        assert!(is_valid_transition_id("10001"));
        assert!(!is_valid_transition_id("")); // empty
        assert!(!is_valid_transition_id("2a")); // non-digit
        assert!(!is_valid_transition_id("a")); // non-digit
        assert!(!is_valid_transition_id("2 1")); // space
        assert!(!is_valid_transition_id("-1")); // sign
        assert!(!is_valid_transition_id("2\"1")); // injection char
    }

    #[test]
    fn createmeta_response_parses_live_issue_types_key() {
        // Verbatim shape from GET /issue/createmeta/MYT/issuetypes. Before the
        // `rename = "issueTypes"`, the array (under `issueTypes`, not `values`) parsed
        // empty and the create picker claimed the project had no issue types.
        let body = r#"{
            "maxResults": 50,
            "startAt": 0,
            "total": 2,
            "issueTypes": [
                { "id": "10001", "name": "Task", "iconUrl": "https://icon/task", "subtask": false },
                { "id": "10002", "name": "Sub-task", "iconUrl": "https://icon/sub", "subtask": true }
            ]
        }"#;
        let parsed: JiraCreatemetaIssueTypes = serde_json::from_str(body).unwrap();
        let types: Vec<JiraIssueType> = parsed
            .issue_types
            .into_iter()
            .map(JiraIssueTypeRaw::into_type)
            .collect();
        assert_eq!(types.len(), 2);
        assert_eq!(types[0].id, "10001");
        assert_eq!(types[0].name, "Task");
        assert!(!types[0].subtask);
        assert_eq!(types[1].id, "10002");
        assert_eq!(types[1].name, "Sub-task");
        assert!(types[1].subtask);
    }

    // ── Phase 4: agile custom-field discovery + extraction ───────────────────────

    /// A verbatim-shaped `GET /rest/api/3/field` slice: the jsw-story-points entry, the
    /// gh-sprint entry, a "Budget" number decoy, and a schema-less system field. Parsed
    /// through the real `JiraFieldMeta` structs (the from-live-JSON rule).
    fn field_metadata_body() -> &'static str {
        r#"[
            { "id": "summary", "name": "Summary", "custom": false },
            { "id": "customfield_10016", "name": "Story point estimate", "custom": true,
              "schema": { "type": "number", "custom": "com.pyxis.greenhopper.jira:jsw-story-points", "customId": 10016 } },
            { "id": "customfield_10020", "name": "Sprint", "custom": true,
              "schema": { "type": "array", "items": "string", "custom": "com.pyxis.greenhopper.jira:gh-sprint", "customId": 10020 } },
            { "id": "customfield_10099", "name": "Budget", "custom": true,
              "schema": { "type": "number", "custom": "com.example:budget", "customId": 10099 } }
        ]"#
    }

    #[test]
    fn resolve_field_ids_schema_first_and_decoy_never_matches() {
        let fields: Vec<JiraFieldMeta> = serde_json::from_str(field_metadata_body()).unwrap();
        let (points, sprint) = resolve_field_ids(&fields);
        // Schema-first wins → the jsw-story-points id, NOT the "Budget" number decoy.
        assert_eq!(points.as_deref(), Some("customfield_10016"));
        assert_eq!(sprint.as_deref(), Some("customfield_10020"));

        // The in-process name map covers every id+name entry.
        let names = field_name_map(&fields);
        assert_eq!(
            names.get("customfield_10016").map(String::as_str),
            Some("Story point estimate")
        );
        assert_eq!(
            names.get("customfield_10099").map(String::as_str),
            Some("Budget")
        );
    }

    #[test]
    fn resolve_field_ids_name_match_fallback_never_matches_decoy() {
        // Remove the jsw-story-points entry → the name-match fallback resolves "Story point
        // estimate" among number-type fields; the "Budget" number decoy still never wins.
        let body = r#"[
            { "id": "customfield_10016", "name": "Story point estimate", "custom": true,
              "schema": { "type": "number", "custom": "com.example:points-lookalike", "customId": 10016 } },
            { "id": "customfield_10020", "name": "Sprint", "custom": true,
              "schema": { "type": "array", "custom": "com.pyxis.greenhopper.jira:gh-sprint", "customId": 10020 } },
            { "id": "customfield_10099", "name": "Budget", "custom": true,
              "schema": { "type": "number", "custom": "com.example:budget", "customId": 10099 } }
        ]"#;
        let fields: Vec<JiraFieldMeta> = serde_json::from_str(body).unwrap();
        let (points, sprint) = resolve_field_ids(&fields);
        assert_eq!(points.as_deref(), Some("customfield_10016"));
        assert_eq!(sprint.as_deref(), Some("customfield_10020"));
    }

    #[test]
    fn resolve_field_ids_none_when_no_agile_fields() {
        // A site with only a number decoy and no sprint field → both None (never the decoy).
        let body = r#"[
            { "id": "summary", "name": "Summary", "custom": false },
            { "id": "customfield_10099", "name": "Budget", "custom": true,
              "schema": { "type": "number", "custom": "com.example:budget" } }
        ]"#;
        let fields: Vec<JiraFieldMeta> = serde_json::from_str(body).unwrap();
        let (points, sprint) = resolve_field_ids(&fields);
        assert!(points.is_none(), "decoy number field must not match");
        assert!(sprint.is_none());
    }

    #[test]
    fn full_issue_extraction_from_live_shape() {
        // Verbatim-shaped issue JSON: points 3, a sprint array with one closed + one active
        // sprint OBJECT (the metadata lies about items:"string" — the value is objects),
        // a parent object {key, fields:{summary}}, and components/fixVersions arrays.
        let map = crate::jira_field_maps::SiteFieldMap {
            story_points_field_id: Some("customfield_10016".to_string()),
            sprint_field_id: Some("customfield_10020".to_string()),
            resolved_at: "2026-07-11T00:00:00.000Z".to_string(),
        };
        let issue = json!({
            "key": "MYT-5",
            "fields": {
                "summary": "Agile issue",
                "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
                "issuetype": { "name": "Story", "iconUrl": "https://icon" },
                "customfield_10016": 3,
                "customfield_10020": [
                    { "id": 1, "name": "Sprint 1", "state": "closed" },
                    { "id": 2, "name": "Sprint 2", "state": "active" }
                ],
                "parent": { "key": "MYT-1", "fields": { "summary": "The epic" } },
                "components": [ { "name": "backend" }, { "name": "api" }, { "id": 9 } ],
                "fixVersions": [ { "name": "v1.2" } ]
            }
        });
        let info = map_issue_info("team.atlassian.net", &issue, &map).unwrap();
        assert_eq!(info.story_points, Some(3.0));
        // First non-closed sprint wins.
        assert_eq!(info.sprint_name.as_deref(), Some("Sprint 2"));
        assert_eq!(info.sprint_state.as_deref(), Some("active"));
        let parent = info.parent.unwrap();
        assert_eq!(parent.key, "MYT-1");
        assert_eq!(parent.summary, "The epic");
        assert_eq!(info.components, vec!["backend", "api"]); // name-less entry skipped
        assert_eq!(info.fix_versions, vec!["v1.2"]);

        // The same extraction helpers back issue_view — exercise them directly on the
        // fields object so both mapping sites are covered.
        let fields = issue.get("fields").unwrap();
        assert_eq!(extract_story_points(fields, &map), Some(3.0));
        let (sn, ss) = extract_sprint(fields, &map);
        assert_eq!(sn.as_deref(), Some("Sprint 2"));
        assert_eq!(ss.as_deref(), Some("active"));
        assert_eq!(
            extract_named_array(fields, "components"),
            vec!["backend", "api"]
        );
    }

    #[test]
    fn extraction_absence_degrades_to_none_and_empty() {
        // None of the agile fields present → all None/empty (a site/issue without them).
        let map = crate::jira_field_maps::SiteFieldMap {
            story_points_field_id: Some("customfield_10016".to_string()),
            sprint_field_id: Some("customfield_10020".to_string()),
            resolved_at: String::new(),
        };
        let issue = json!({
            "key": "MYT-9",
            "fields": { "summary": "Bare", "status": { "name": "To Do" } }
        });
        let info = map_issue_info("s.atlassian.net", &issue, &map).unwrap();
        assert!(info.story_points.is_none());
        assert!(info.sprint_name.is_none());
        assert!(info.sprint_state.is_none());
        assert!(info.parent.is_none());
        assert!(info.components.is_empty());
        assert!(info.fix_versions.is_empty());
    }

    #[test]
    fn extract_sprint_all_closed_yields_none() {
        let map = crate::jira_field_maps::SiteFieldMap {
            sprint_field_id: Some("customfield_10020".to_string()),
            ..Default::default()
        };
        let fields = json!({
            "customfield_10020": [
                { "name": "Sprint 1", "state": "CLOSED" },
                { "name": "Sprint 0", "state": "closed" }
            ]
        });
        assert_eq!(extract_sprint(&fields, &map), (None, None));
        // A non-array sprint value → None.
        let fields2 = json!({ "customfield_10020": "not an array" });
        assert_eq!(extract_sprint(&fields2, &map), (None, None));
    }

    #[test]
    fn extract_story_points_only_with_id() {
        // No id in the map → None even when the field is present.
        let empty = crate::jira_field_maps::SiteFieldMap::default();
        let fields = json!({ "customfield_10016": 5 });
        assert!(extract_story_points(&fields, &empty).is_none());
        let map = crate::jira_field_maps::SiteFieldMap {
            story_points_field_id: Some("customfield_10016".to_string()),
            ..Default::default()
        };
        assert_eq!(extract_story_points(&fields, &map), Some(5.0));
    }

    #[test]
    fn extract_parent_empty_key_is_none() {
        assert!(extract_parent(&json!({ "parent": { "key": "" } })).is_none());
        assert!(extract_parent(&json!({})).is_none());
        // Parent with a key but no nested summary → summary empty, still Some.
        let p = extract_parent(&json!({ "parent": { "key": "EPIC-1" } })).unwrap();
        assert_eq!(p.key, "EPIC-1");
        assert_eq!(p.summary, "");
    }

    #[test]
    fn list_fields_builder_appends_custom_ids_when_present() {
        let empty = crate::jira_field_maps::SiteFieldMap::default();
        let base = list_fields_for(&empty);
        assert!(base.contains(&"parent".to_string()));
        assert!(base.contains(&"components".to_string()));
        assert!(base.contains(&"fixVersions".to_string()));
        // No custom ids when the map is empty.
        assert!(!base.iter().any(|f| f.starts_with("customfield_")));

        let map = crate::jira_field_maps::SiteFieldMap {
            story_points_field_id: Some("customfield_10016".to_string()),
            sprint_field_id: Some("customfield_10020".to_string()),
            resolved_at: String::new(),
        };
        let full = list_fields_for(&map);
        assert!(full.contains(&"customfield_10016".to_string()));
        assert!(full.contains(&"customfield_10020".to_string()));

        // The detail suffix appends the same ids, comma-prefixed; empty for an empty map.
        assert_eq!(detail_custom_fields_suffix(&empty), "");
        assert_eq!(
            detail_custom_fields_suffix(&map),
            ",customfield_10016,customfield_10020"
        );
    }

    #[test]
    fn board_config_override_only_for_field_estimation() {
        // estimation.type == "field" overrides with its fieldId.
        let field_cfg: JiraBoardConfig = serde_json::from_str(
            r#"{ "estimation": { "type": "field",
                 "field": { "fieldId": "customfield_10030", "displayName": "Story Points" } } }"#,
        )
        .unwrap();
        assert_eq!(
            board_config_points_override(&field_cfg).as_deref(),
            Some("customfield_10030")
        );
        // estimation.type == "issueCount" → no override.
        let count_cfg: JiraBoardConfig =
            serde_json::from_str(r#"{ "estimation": { "type": "issueCount" } }"#).unwrap();
        assert!(board_config_points_override(&count_cfg).is_none());
        // Missing estimation entirely → no override.
        let none_cfg: JiraBoardConfig = serde_json::from_str(r#"{}"#).unwrap();
        assert!(board_config_points_override(&none_cfg).is_none());
    }

    #[test]
    fn project_key_of_issue_takes_prefix() {
        assert_eq!(project_key_of_issue("MYT-5"), "MYT");
        assert_eq!(project_key_of_issue("MY_PROJ-123"), "MY_PROJ");
        // No hyphen → empty (board override then skipped).
        assert_eq!(project_key_of_issue("nohyphen"), "");
    }

    #[test]
    fn agile_base_builds_agile_urls() {
        let direct = JiraApiBase::Direct {
            site: "team.atlassian.net".into(),
        };
        assert_eq!(
            direct.resolve_agile("board?projectKeyOrId=MYT"),
            "https://team.atlassian.net/rest/agile/1.0/board?projectKeyOrId=MYT"
        );
        let gateway = JiraApiBase::Gateway {
            cloud_id: "abc-123".into(),
        };
        assert_eq!(
            gateway.resolve_agile("board/5/configuration"),
            "https://api.atlassian.com/ex/jira/abc-123/rest/agile/1.0/board/5/configuration"
        );
    }
}
