//! Jira Cloud — a per-repo LINKED issue provider, orthogonal to the git-host detection
//! every `forge_issue_*` command dispatches on. No repo has a Jira remote, so linkage is
//! *configured*: the frontend stores a per-repo `{site, projectKey}` and passes
//! `site`/`project_key` in, keeping Rust stateless about it. See
//! `docs/jira-issue-integration.md`.
//!
//! Shaped like [`super::bitbucket`] but Jira-local: a per-tenant base URL
//! (`https://<site>/rest/api/3/`), HTTP Basic auth (`email:api_token`), and Jira's
//! `{errorMessages, errors}` envelope. Tokens live in the OS keyring under
//! `forge/<site>/{email,token}` and never cross IPC. Bodies are ADF: read via [`adf`],
//! written via [`md_to_adf`].

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
/// Scoped API tokens CANNOT authenticate site-direct (`https://<site>.atlassian.net`) —
/// they 401 there and must use the gateway `https://api.atlassian.com/ex/jira/{cloudId}`;
/// classic unscoped tokens use site-direct. Atlassian is steering everyone to scoped
/// tokens, so do NOT collapse this back to site-direct only. Both bases take the same
/// Basic auth header; only the URL differs.
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

/// Whether `s` is a `YYYY-MM-DD` date (`^\d{4}-\d{2}-\d{2}$`) — the grammar the due-date
/// write requires before sending it. This is a shape check, not a calendar check (Jira
/// validates the actual date); an impossible date like `2026-13-40` still passes the
/// grammar and surfaces through Jira's error envelope. Pure (testable).
fn is_valid_due_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..].iter().all(u8::is_ascii_digit)
}

/// Whether `label` is a valid Jira label: non-empty and containing no whitespace (Jira
/// labels cannot contain spaces — the server would 400, but a local check gives a clean
/// message). Pure (testable).
fn is_valid_label(label: &str) -> bool {
    !label.is_empty() && !label.chars().any(char::is_whitespace)
}

/// Whether a Jira comment id is a non-empty run of ASCII digits — comment ids are numeric
/// strings, grammar-validated before being interpolated into a request path. Pure.
fn is_valid_comment_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())
}

/// Whether `s` is a valid Jira time-tracking duration: one or more whitespace-separated
/// tokens, each matching `^\d+(\.\d+)?[wdhm]$` (weeks/days/hours/minutes), with at least one
/// token. This is a SHAPE check only — Jira enforces the semantics (e.g. it rejects a
/// zero-length worklog itself), matching the due-date "grammar only" precedent. Pure
/// (testable).
fn is_valid_duration(s: &str) -> bool {
    let mut tokens = 0;
    for token in s.split_whitespace() {
        // The unit is the final byte; it must be one of w/d/h/m (all ASCII). Splitting on the
        // last byte is safe because the unit set is ASCII — a multi-byte trailing char would
        // fail the `matches!` below rather than split mid-codepoint.
        let Some((&unit, num)) = token.as_bytes().split_last() else {
            return false;
        };
        if !matches!(unit, b'w' | b'd' | b'h' | b'm') {
            return false;
        }
        let num = &token[..num.len()];
        let mantissa = match num.split_once('.') {
            Some((int, frac)) => {
                if int.is_empty() || frac.is_empty() {
                    return false;
                }
                int.bytes().all(|b| b.is_ascii_digit()) && frac.bytes().all(|b| b.is_ascii_digit())
            }
            None => !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit()),
        };
        if !mantissa {
            return false;
        }
        tokens += 1;
    }
    tokens > 0
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

/// Render a field-error key for display, given a `resolve` that maps a field id to its
/// display name. A `customfield_NNNNN` key with a known name renders the NAME (the
/// eligibility predicate is [`crate::jira_field_maps::is_valid_field_id`]); an unknown
/// custom id, or any non-customfield key, renders unchanged. Pure (testable) — `resolve`
/// performs no I/O (it reads the in-process name map).
fn translate_field_key(key: &str, resolve: impl Fn(&str) -> Option<String>) -> String {
    if crate::jira_field_maps::is_valid_field_id(key) {
        if let Some(name) = resolve(key) {
            return name;
        }
    }
    key.to_string()
}

impl JiraErrorEnvelope {
    /// The best human message: `errorMessages` first, else ALL field-level `errors` joined
    /// as `field: msg` (not just the first — a create failing several mandatory fields must
    /// name every one), sorted by field key for determinism. `resolve` maps a
    /// `customfield_NNNNN` id to its display name (in-process, no I/O). `None` when neither
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

    /// Join every non-empty `errors` entry as `field: msg`, sorted by RAW field key (so the
    /// message is deterministic whether or not a name map is warm), then translate each key
    /// through [`translate_field_key`] for display. `None` when there are no field errors.
    /// Pure — `resolve` does no I/O.
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

/// Turn a non-2xx response body + status into an [`AppError::Jira`], special-casing
/// 401/403/429. `body` is the raw response text (never contains our credentials — those
/// live only in the request header). Field-error keys render RAW here (no site resolved);
/// [`http_error_for`] translates `customfield_NNNNN` keys for a known site.
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
/// base. `Accept: application/json`, HTTP Basic auth. Non-2xx → [`http_error_for`] (field
/// keys translated for the creds' site); a parse failure of a 2xx body →
/// `Jira("could not parse …")` carrying the serde error verbatim (never mapped into a
/// specific-cause message).
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

/// Send a write with an optional JSON body, expecting a no-content (or don't-care) 2xx.
/// The 2xx body is discarded; a non-2xx maps through [`http_error_for`] so field errors
/// surface.
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
            is_bot: false,
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

/// Per-site cache of the CALLER's Jira accountId, filled by one `GET /myself` per process
/// per site. Purely a UX-gating input for the issue view's `viewer_account_id` (whether to
/// OFFER edit/delete-own-comment) — Jira enforces ownership server-side regardless, so a
/// stale entry can never grant a write. Keyed per site; never cleared within a process.
static VIEWER_ACCOUNT_IDS: OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
    OnceLock::new();

fn viewer_account_ids() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    VIEWER_ACCOUNT_IDS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// The caller's accountId for a site, from the per-process cache or one `GET /myself` probe.
/// Any failure (network, parse, empty accountId) yields `None` — the issue view still
/// succeeds; the own-comment affordances are simply hidden. A resolved id is cached so
/// later issue views on the same site skip the probe. The std mutex is taken and released
/// around each map access, never held across the `.await`.
async fn resolve_viewer_account_id(creds: &JiraCredentials, site: &str) -> Option<String> {
    if let Ok(map) = viewer_account_ids().lock() {
        if let Some(id) = map.get(site) {
            return Some(id.clone());
        }
    }
    let me: JiraUser = get_json(creds, "myself", "account").await.ok()?;
    let id = me.account_id.filter(|s| !s.is_empty())?;
    if let Ok(mut map) = viewer_account_ids().lock() {
        map.insert(site.to_string(), id.clone());
    }
    Some(id)
}

/// The `/_edge/tenant_info` response — an UNAUTHENTICATED endpoint on the site host that
/// returns the tenant's `cloudId`. Only `cloudId` is read.
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
/// on a 401 ONLY, resolve the site's `cloudId` and retry via the gateway (a 401 is the
/// "wrong base for this token type" signal — scoped tokens 401 site-direct, see
/// [`JiraApiBase`]). Any other direct failure (403/network/parse) is returned as-is.
/// `email`/`token` are candidates, not yet stored; gateway-retry errors reach the caller,
/// which owns the final failure copy.
async fn resolve_base(
    site: &str,
    email: &str,
    token: &str,
) -> AppResult<(JiraApiBase, JiraAccountInfo)> {
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
    // Resolve the base (direct, gateway on a 401) BEFORE writing anything.
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

/// Connect a Jira account for a site by REUSING the stored Bitbucket credentials (Bitbucket
/// Cloud shares the Atlassian API-token mechanism). Rust-side because tokens never cross
/// IPC — the frontend can't read the Bitbucket token to hand it to `jira_set_account`.
///
/// Reads `forge/bitbucket.org/{email,token}` and guards their presence BEFORE any network
/// call, resolves the API base with them ([`resolve_base`]), and on success ONLY persists
/// the pair + base under the SITE host (not the bitbucket.org entry) so
/// `load_credentials(site)` finds them. A stored Bitbucket token often can't reach Jira at
/// all, so a final 401 or 403 gets reuse-specific copy ([`specialize_reuse_error`]). The
/// token is never returned or logged.
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

    // Resolve the base with the Bitbucket creds. If BOTH bases fail, 401 AND 403 both mean
    // "this token can't reach Jira" — specialize rather than show the generic 401 copy.
    let (base, info) = resolve_base(&site, &email, &token)
        .await
        .map_err(specialize_reuse_error)?;

    // Validated — persist the pair + resolved base under the SITE host (not bitbucket.org).
    persist_account(&site, &email, &token, &base).await?;
    Ok(info)
}

/// Specialize an AUTH error (401 or 403) from the Bitbucket-reuse probe into one actionable
/// message pointing at manual entry; non-auth errors pass through unchanged.
///
/// A product-scoped Atlassian token (Bitbucket-only) returns **401** on Jira's
/// `/rest/api/3/myself`, not the 403 a scope mismatch would suggest — so both codes mean
/// "this token can't reach Jira" and the generic "expired or revoked" copy would mislead.
/// Do NOT narrow this back to 403 only. The status marker is preserved, and the
/// specialization is scoped to this command (`set_account`/`validate` keep the generic copy).
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

// ── Custom-field discovery (agile fields) ──────────────────────────────────────

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
/// Returns `(storyPointsFieldId, sprintFieldId)`. Pure so the rules are unit-testable.
///
/// - **Sprint**: `schema.custom == "…:gh-sprint"`.
/// - **Story points**: `schema.custom == "…:jsw-story-points"`, else a case-insensitive
///   name match of "Story point estimate" / "Story Points" among `schema.type == "number"`
///   entries, else `None`. NEVER a bare number-type match — a decoy ("Budget") must not win.
///
/// Both ids are grammar-validated ([`crate::jira_field_maps::is_valid_field_id`]) because
/// they are spliced UNENCODED into request URLs; a hostile id degrades to `None`.
fn resolve_field_ids(fields: &[JiraFieldMeta]) -> (Option<String>, Option<String>) {
    let valid = |id: Option<String>| id.filter(|s| crate::jira_field_maps::is_valid_field_id(s));

    let sprint = valid(
        fields
            .iter()
            .find(|f| f.schema.as_ref().and_then(|s| s.custom.as_deref()) == Some(SCHEMA_SPRINT))
            .and_then(|f| f.id.clone()),
    );

    // (1) schema-first: the greenhopper story-points marker.
    let points_by_schema = fields
        .iter()
        .find(|f| f.schema.as_ref().and_then(|s| s.custom.as_deref()) == Some(SCHEMA_STORY_POINTS))
        .and_then(|f| f.id.clone());

    let points = valid(points_by_schema.or_else(|| {
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
    }));

    (points, sprint)
}

/// The `customfield_NNNNN → name` map from the `/field` metadata, for error translation.
/// Only entries whose id is a well-formed `customfield_*` (and that carry a name) are kept
/// — those are the only keys error translation ever looks up, and keeping the map small
/// keeps the persisted entry small. Pure.
fn field_name_map(fields: &[JiraFieldMeta]) -> std::collections::HashMap<String, String> {
    fields
        .iter()
        .filter_map(|f| {
            let id = f.id.clone()?;
            if !crate::jira_field_maps::is_valid_field_id(&id) {
                return None;
            }
            Some((id, f.name.clone()?))
        })
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
/// `estimation.type == "field"` and a `field.fieldId` that is a well-formed
/// `customfield_NNNNN` ([`crate::jira_field_maps::is_valid_field_id`]) is present; `None`
/// otherwise (e.g. `type == "issueCount"`, a missing field, or a hostile id that would
/// inject into the request URL). Pure.
fn board_config_points_override(config: &JiraBoardConfig) -> Option<String> {
    let est = config.estimation.as_ref()?;
    if est.ty.as_deref() != Some("field") {
        return None;
    }
    est.field
        .as_ref()
        .and_then(|f| f.field_id.as_deref())
        .filter(|s| crate::jira_field_maps::is_valid_field_id(s))
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

/// Discover the site's agile custom-field map: `/rest/api/3/field` → [`resolve_field_ids`]
/// plus the field-NAME map for error translation, then a best-effort story-points override
/// from the project's board configuration (`project_key` empty skips it). Persists the
/// entry even when both ids are `None` (a site without agile fields must not be re-probed).
/// A FAILED `/field` fetch persists nothing and returns `None` — the caller records the
/// in-process failed marker.
async fn discover_field_map(
    creds: &JiraCredentials,
    site: &str,
    project_key: &str,
) -> Option<crate::jira_field_maps::SiteFieldMap> {
    let fields: Vec<JiraFieldMeta> = get_json(creds, "field", "fields").await.ok()?;

    // The customfield_* id→name map for error translation: persisted on the entry (warm on
    // restarts / the headless MCP) and set in-process now.
    let names = field_name_map(&fields);
    crate::jira_field_maps::set_name_map(site, names.clone());

    let (mut points, sprint) = resolve_field_ids(&fields);

    // Best-effort board-config override for the points id (silently degraded). The override
    // is itself grammar-validated in `board_config_points_override`.
    if !project_key.is_empty() {
        if let Some(overridden) = board_points_override(creds, project_key).await {
            points = Some(overridden);
        }
    }

    let entry = crate::jira_field_maps::SiteFieldMap {
        story_points_field_id: points,
        sprint_field_id: sprint,
        field_names: Some(names),
        resolved_at: now_iso(),
    };
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

/// Per-site async locks that COALESCE concurrent discovery: racers for the same site await
/// the lock and then hit the cache the winner filled, so one `/field` probe serves all.
/// Keyed per site, so different sites never serialize. The outer std mutex guards only the
/// registry lookup and is released before any `.await`; the inner [`tokio::sync::Mutex`] is
/// the one held across discovery.
static DISCOVERY_LOCKS: OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>,
> = OnceLock::new();

/// The per-site async discovery lock, created on first use. The std registry mutex is held
/// only for the `HashMap` lookup/insert, never across an `.await`.
fn discovery_lock_for(site: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let registry =
        DISCOVERY_LOCKS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let mut map = registry
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    map.entry(site.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// Resolve the site's field map for a request, lazily. Order: (1) the persisted/in-process
/// cache; (2) the in-process failed-marker (→ empty map, no re-probe); (3) discovery,
/// coalesced per site so concurrent racers share one `/field` probe. A discovery failure
/// records the failed marker and returns the empty (default) map — so the request proceeds
/// with the skeleton fields and NEVER errors. `project_key` drives the board-config override
/// (empty skips it).
async fn resolve_site_map(
    creds: &JiraCredentials,
    site: &str,
    project_key: &str,
) -> crate::jira_field_maps::SiteFieldMap {
    if let Some(entry) = crate::jira_field_maps::get(site) {
        return entry;
    }
    if discovery_already_failed(site) {
        return crate::jira_field_maps::SiteFieldMap::default();
    }

    // Coalesce: racers for this site queue here, then re-check the cache.
    let lock = discovery_lock_for(site);
    let _guard = lock.lock().await;

    // Double-checked: a racer that lost the lock now finds the winner's result.
    if let Some(entry) = crate::jira_field_maps::get(site) {
        return entry;
    }
    if discovery_already_failed(site) {
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

/// Whether this process has already recorded a discovery failure for `site`. The std mutex
/// is taken and released here, never held across an `.await`.
fn discovery_already_failed(site: &str) -> bool {
    discovery_failed()
        .lock()
        .map(|s| s.contains(site))
        .unwrap_or(false)
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
    // Lazy field-map discovery; failure degrades to the skeleton fields, never an error.
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
    /// The comment's `updated` timestamp, or `None` when Jira omits it — the issue view
    /// shows an "(edited)" cue when it differs from `created_at`.
    pub updated_at: Option<String>,
}

/// An issue's time-tracking summary (the `timetracking` field). Every member is
/// individually tolerant: Jira omits members it hasn't derived (e.g. no remaining estimate
/// until an original is set), and the whole object can be present-but-empty (`{}`) when the
/// feature is enabled on the project but nothing is tracked yet. The display strings are
/// the server's own (e.g. `"2d"`), never recomputed client-side.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraTimeTracking {
    pub original_estimate: Option<String>,
    pub remaining_estimate: Option<String>,
    pub time_spent: Option<String>,
    // Durations in seconds — far below 2^53, so safe as JS numbers over IPC (the
    // string-serialization rule is for IDs, not durations).
    pub original_estimate_seconds: Option<u64>,
    pub remaining_estimate_seconds: Option<u64>,
    pub time_spent_seconds: Option<u64>,
}

/// One worklog entry, its ADF `comment` converted to markdown. Used for the embedded
/// first-page worklog list and for the single worklog a `POST`/`PUT …/worklog` returns.
/// Defensive: every field degrades to empty/0/None rather than sinking the map.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraWorklog {
    pub id: String,
    pub author: Option<ForgeUserRef>,
    pub time_spent: String,
    pub time_spent_seconds: u64,
    /// The worklog's `started` timestamp (RFC3339 as returned by Jira).
    pub started: String,
    /// The worklog note (ADF) converted to markdown; `""` when the comment is null/absent.
    pub comment_md: String,
    pub created_at: String,
    /// The worklog's `updated` timestamp, or `None` when Jira omits it (or it equals empty).
    pub updated_at: Option<String>,
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
    /// The CALLER's Jira accountId (per-site in-process cache, one `GET /myself` per
    /// process), or `None`. UX gating ONLY — Jira enforces comment ownership server-side
    /// (EDIT_OWN/DELETE_OWN), so a stale or missing value can never grant a write.
    pub viewer_account_id: Option<String>,
    /// `None` = time tracking disabled on the project (the `timetracking` field is absent
    /// or JSON-null); `Some` with all-None members = enabled but nothing tracked yet.
    pub time_tracking: Option<JiraTimeTracking>,
    /// The embedded first page of worklogs (Jira caps this at 20). Serializes as `worklogs`.
    pub worklogs: Vec<JiraWorklog>,
    /// The server's total worklog count (may exceed `worklogs.len()` when there are more
    /// than the embedded first page).
    pub worklogs_total: u64,
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
        updated_at: c
            .get("updated")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
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

/// Map one Jira worklog object onto the neutral [`JiraWorklog`], converting its ADF
/// `comment` to markdown. Used for the embedded worklog list and for the single worklog a
/// `POST`/`PUT …/worklog` returns. Defensive like [`map_comment`]: every field degrades
/// (id → `""`, seconds → 0) rather than panicking, and a null/absent comment yields `""`.
fn map_worklog(w: &Value) -> JiraWorklog {
    JiraWorklog {
        id: w
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        author: parse_user(w.get("author")),
        time_spent: w
            .get("timeSpent")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        time_spent_seconds: w
            .get("timeSpentSeconds")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        started: w
            .get("started")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        comment_md: w
            .get("comment")
            .filter(|c| !c.is_null())
            .map(adf::adf_to_markdown)
            .unwrap_or_default(),
        created_at: w
            .get("created")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        updated_at: w
            .get("updated")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    }
}

/// Map the issue's `fields.worklog.worklogs[]` (the embedded first page) onto neutral
/// worklogs. Defensive like [`map_worklog`]; no pagination beyond the embedded page.
fn map_worklogs(fields: &Value) -> Vec<JiraWorklog> {
    fields
        .get("worklog")
        .and_then(|w| w.get("worklogs"))
        .and_then(Value::as_array)
        .map(|arr| arr.iter().map(map_worklog).collect())
        .unwrap_or_default()
}

/// One string member of a `timetracking` object (e.g. `originalEstimate`), or `None` when
/// absent/empty. Kept trivial; the seconds members use [`Value::as_u64`] directly.
fn tt_string(tt: &Value, member: &str) -> Option<String> {
    tt.get(member)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Parse the issue's `fields.timetracking` into [`JiraTimeTracking`]. An absent field OR
/// JSON-null → `None` (time tracking disabled on the project); a present object (even the
/// empty `{}`) → `Some` with each member individually tolerant. Pure (testable).
fn parse_time_tracking(fields: &Value) -> Option<JiraTimeTracking> {
    let tt = fields.get("timetracking").filter(|v| v.is_object())?;
    Some(JiraTimeTracking {
        original_estimate: tt_string(tt, "originalEstimate"),
        remaining_estimate: tt_string(tt, "remainingEstimate"),
        time_spent: tt_string(tt, "timeSpent"),
        original_estimate_seconds: tt.get("originalEstimateSeconds").and_then(Value::as_u64),
        remaining_estimate_seconds: tt.get("remainingEstimateSeconds").and_then(Value::as_u64),
        time_spent_seconds: tt.get("timeSpentSeconds").and_then(Value::as_u64),
    })
}

/// The server's total worklog count from `fields.worklog.total` (0 when absent).
fn worklogs_total_of(fields: &Value) -> u64 {
    fields
        .get("worklog")
        .and_then(|w| w.get("total"))
        .and_then(Value::as_u64)
        .unwrap_or(0)
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
    // Lazy field-map discovery (never errors); the issue key's prefix is the project key
    // for the board override.
    let map = resolve_site_map(&creds, &site, project_key_of_issue(key)).await;
    let custom = detail_custom_fields_suffix(&map);
    let path = format!(
        "issue/{key}?fields=summary,description,status,issuetype,priority,assignee,\
         reporter,labels,created,updated,duedate,resolution,parent,components,fixVersions,\
         comment,timetracking,worklog{custom}"
    );
    let issue: Value = get_json(&creds, &path, "issue").await?;
    let fields = issue.get("fields").cloned().unwrap_or(Value::Null);

    // The caller's accountId (cached per site), for own-comment UX gating. Best-effort —
    // any failure yields None and the issue view still succeeds.
    let viewer_account_id = resolve_viewer_account_id(&creds, &site).await;

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
        viewer_account_id,
        time_tracking: parse_time_tracking(&fields),
        worklogs: map_worklogs(&fields),
        worklogs_total: worklogs_total_of(&fields),
    })
}

// ── Writes: comment / transition / create / assign ─────────────────────────────

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

/// Pick the transition id for a `direction` ("close" | "reopen"). Pure (unit-tested).
///
/// - **close** → first transition whose destination `statusCategory.key == "done"`.
/// - **reopen** → prefer `"new"`, else `"indeterminate"`.
///
/// `Ok(None)` when nothing suitable exists (the caller raises the workflow/permission
/// error); `InvalidArgument` for an unknown direction.
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
            // "new" = To Do, "indeterminate" = In Progress.
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
    /// `SCHEDULE_ISSUES` — the due-date permission (NOT `EDIT_ISSUES`; live-verified).
    pub schedule_issues: bool,
    /// `EDIT_ISSUES` — gates priority + labels writes.
    pub edit_issues: bool,
    /// `EDIT_OWN_COMMENTS` — gates editing your own comment.
    pub edit_own_comments: bool,
    /// `DELETE_OWN_COMMENTS` — gates deleting your own comment.
    pub delete_own_comments: bool,
    /// `WORK_ON_ISSUES` — gates logging work.
    pub work_on_issues: bool,
    /// `EDIT_OWN_WORKLOGS` — gates editing your own worklog entries.
    pub edit_own_worklogs: bool,
    /// `DELETE_OWN_WORKLOGS` — gates deleting your own worklog entries.
    pub delete_own_worklogs: bool,
    /// `EDIT_ALL_WORKLOGS` — gates editing anyone's worklog entries (project admins).
    pub edit_all_worklogs: bool,
    /// `DELETE_ALL_WORKLOGS` — gates deleting anyone's worklog entries (project admins).
    pub delete_all_worklogs: bool,
    /// `EDIT_ALL_COMMENTS` — gates editing anyone's comment (project admins).
    pub edit_all_comments: bool,
    /// `DELETE_ALL_COMMENTS` — gates deleting anyone's comment (project admins).
    pub delete_all_comments: bool,
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
        schedule_issues: have_permission(body, "SCHEDULE_ISSUES"),
        edit_issues: have_permission(body, "EDIT_ISSUES"),
        edit_own_comments: have_permission(body, "EDIT_OWN_COMMENTS"),
        delete_own_comments: have_permission(body, "DELETE_OWN_COMMENTS"),
        work_on_issues: have_permission(body, "WORK_ON_ISSUES"),
        edit_own_worklogs: have_permission(body, "EDIT_OWN_WORKLOGS"),
        delete_own_worklogs: have_permission(body, "DELETE_OWN_WORKLOGS"),
        edit_all_worklogs: have_permission(body, "EDIT_ALL_WORKLOGS"),
        delete_all_worklogs: have_permission(body, "DELETE_ALL_WORKLOGS"),
        edit_all_comments: have_permission(body, "EDIT_ALL_COMMENTS"),
        delete_all_comments: have_permission(body, "DELETE_ALL_COMMENTS"),
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
         CREATE_ISSUES,ASSIGN_ISSUES,SCHEDULE_ISSUES,EDIT_ISSUES,EDIT_OWN_COMMENTS,\
         DELETE_OWN_COMMENTS,WORK_ON_ISSUES,EDIT_OWN_WORKLOGS,DELETE_OWN_WORKLOGS,\
         EDIT_ALL_WORKLOGS,DELETE_ALL_WORKLOGS,EDIT_ALL_COMMENTS,DELETE_ALL_COMMENTS",
        crate::forge::encode_query_value(project_key),
    );
    let body: Value = get_json(&creds, &path, "permissions").await?;
    Ok(parse_permissions(&body))
}

// ── Writes: due date / priority / labels / comment edit-delete + pickers ───────

/// One Jira priority for the priority picker (`GET /rest/api/3/priority`).
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraPriority {
    pub id: String,
    pub name: String,
    pub icon_url: String,
}

/// The site's priorities for the priority picker — `GET /rest/api/3/priority`, which
/// returns a BARE ARRAY of `{id, name, iconUrl, …}` (no envelope). Parsed straight into
/// `Vec<JiraPriority>`.
pub async fn priorities(site: &str) -> AppResult<Vec<JiraPriority>> {
    let site = normalize_site(site)?;
    let creds = load_credentials(&site).await?;
    get_json(&creds, "priority", "priorities").await
}

/// The `GET /rest/api/3/label` response — a paginated `{values:[string], total}` envelope.
/// No query parameter exists, so the picker fetches the first page and filters client-side.
#[derive(Deserialize, Default)]
struct JiraLabelsPage {
    #[serde(default)]
    values: Vec<String>,
}

/// The site's labels for the labels picker — the first page of `GET /rest/api/3/label`
/// (`{values, total}`; no query param exists, so the UI filters `values` client-side).
pub async fn labels(site: &str) -> AppResult<Vec<String>> {
    let site = normalize_site(site)?;
    let creds = load_credentials(&site).await?;
    let page: JiraLabelsPage =
        get_json(&creds, &format!("label?maxResults={MAX_RESULTS}"), "labels").await?;
    Ok(page.values)
}

/// Set (or clear) an issue's due date. `Some("YYYY-MM-DD")` sets; `None` clears
/// (`{fields:{duedate: null}}`). The date GRAMMAR is validated before any network call
/// (shape only — Jira validates the calendar). A project whose screen lacks the field
/// surfaces through the normal error envelope.
pub async fn issue_set_due_date(site: &str, key: &str, due_date: Option<&str>) -> AppResult<()> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    if let Some(d) = due_date {
        if !is_valid_due_date(d) {
            return Err(AppError::InvalidArgument(format!(
                "invalid due date (expected YYYY-MM-DD): {d}"
            )));
        }
    }
    let creds = load_credentials(&site).await?;
    // `duedate: null` clears; a valid string sets. Serialize either explicitly.
    let body = json!({ "fields": { "duedate": due_date } });
    send_no_content(
        &creds,
        reqwest::Method::PUT,
        &format!("issue/{key}"),
        Some(&body),
    )
    .await
}

/// Set an issue's priority to `priority_id` (`PUT /issue/<key>` with
/// `{fields:{priority:{id}}}`). The id comes from [`priorities`]; the issue key is
/// grammar-validated first. A screen without a priority field surfaces through the error
/// envelope.
pub async fn issue_set_priority(site: &str, key: &str, priority_id: &str) -> AppResult<()> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    if priority_id.trim().is_empty() {
        return Err(AppError::InvalidArgument(
            "a priority id is required".into(),
        ));
    }
    let creds = load_credentials(&site).await?;
    let body = json!({ "fields": { "priority": { "id": priority_id } } });
    send_no_content(
        &creds,
        reqwest::Method::PUT,
        &format!("issue/{key}"),
        Some(&body),
    )
    .await
}

/// Replace an issue's labels wholesale (`PUT /issue/<key>` with `{fields:{labels}}`). Every
/// label is validated (non-empty, no whitespace — Jira labels can't contain spaces) BEFORE
/// any network call; a bad label is an `InvalidArgument` naming it. An empty `labels` vec
/// clears all labels. The issue key is grammar-validated first.
pub async fn issue_set_labels(site: &str, key: &str, labels: &[String]) -> AppResult<()> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    for label in labels {
        if !is_valid_label(label) {
            return Err(AppError::InvalidArgument(format!(
                "invalid Jira label (labels can't be empty or contain spaces): {label:?}"
            )));
        }
    }
    let creds = load_credentials(&site).await?;
    let body = json!({ "fields": { "labels": labels } });
    send_no_content(
        &creds,
        reqwest::Method::PUT,
        &format!("issue/{key}"),
        Some(&body),
    )
    .await
}

/// Edit one of your own comments (`PUT /issue/<key>/comment/<id>`); `body_md` → ADF via
/// [`md_to_adf`], the response mapped back to a neutral [`JiraComment`]. A whitespace-only
/// body and a non-digit comment id are both rejected before any network call.
///
/// Editing round-trips ADF→md→ADF, so nodes the writer can't emit (mentions, panels) are
/// DROPPED — acceptable for own comments. Ownership is enforced server-side by
/// EDIT_OWN_COMMENTS.
pub async fn comment_edit(
    site: &str,
    key: &str,
    comment_id: &str,
    body_md: &str,
) -> AppResult<JiraComment> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    if !is_valid_comment_id(comment_id) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira comment id: {comment_id}"
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
    let path = format!("issue/{key}/comment/{comment_id}");
    let resp: Value = put_json(&creds, &path, &body, "comment").await?;
    Ok(map_comment(&resp))
}

/// Delete one of your own comments on an issue (`DELETE /issue/<key>/comment/<id>`;
/// returns 204). The issue key and the digits-only comment id are grammar-validated BEFORE
/// any network call. Ownership is enforced server-side by DELETE_OWN_COMMENTS.
pub async fn comment_delete(site: &str, key: &str, comment_id: &str) -> AppResult<()> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    if !is_valid_comment_id(comment_id) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira comment id: {comment_id}"
        )));
    }
    let creds = load_credentials(&site).await?;
    send_no_content(
        &creds,
        reqwest::Method::DELETE,
        &format!("issue/{key}/comment/{comment_id}"),
        None,
    )
    .await
}

// ── Writes: time tracking (estimates + worklogs) ───────────────────────────────

/// Set (or clear) an issue's ORIGINAL estimate via a PARTIAL `timetracking` update
/// (`PUT /issue/<key>`). `Some(d)` sets it (duration grammar validated before any network
/// call); `None` CLEARS it by sending the EMPTY STRING — `null` is a silent no-op on
/// `timetracking` (probed). The server derives the remaining estimate (setting the original
/// with no worklogs initializes remaining; clearing with worklogs snaps original :=
/// remaining) — nothing is recomputed here.
pub async fn issue_set_original_estimate(
    site: &str,
    key: &str,
    estimate: Option<&str>,
) -> AppResult<()> {
    set_estimate_member(site, key, "originalEstimate", estimate).await
}

/// Set (or clear) an issue's REMAINING estimate via a PARTIAL `timetracking` update
/// (`PUT /issue/<key>` with `{fields:{timetracking:{remainingEstimate: <val>}}}`). Same
/// clear-via-empty-string / validate-before-network contract as
/// [`issue_set_original_estimate`].
pub async fn issue_set_remaining_estimate(
    site: &str,
    key: &str,
    estimate: Option<&str>,
) -> AppResult<()> {
    set_estimate_member(site, key, "remainingEstimate", estimate).await
}

/// Shared body of the two set-estimate fns: validate the key and (when setting) the
/// duration grammar BEFORE any network call, then PUT a partial `timetracking` update
/// touching only `member`. Clearing sends `""` (never `null` — a silent no-op, probed).
async fn set_estimate_member(
    site: &str,
    key: &str,
    member: &str,
    estimate: Option<&str>,
) -> AppResult<()> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    if let Some(d) = estimate {
        if !is_valid_duration(d) {
            return Err(AppError::InvalidArgument(format!(
                "invalid duration (expected e.g. \"2d 4h 30m\" — units w/d/h/m): {d}"
            )));
        }
    }
    let creds = load_credentials(&site).await?;
    // Clearing = the EMPTY STRING (never null — null is a silent no-op on timetracking).
    let value = estimate.unwrap_or("");
    let body = json!({ "fields": { "timetracking": { member: value } } });
    send_no_content(
        &creds,
        reqwest::Method::PUT,
        &format!("issue/{key}"),
        Some(&body),
    )
    .await
}

/// Log work on an issue (`POST /issue/<key>/worklog`). The `time_spent` grammar is
/// validated BEFORE any network call (shape only). An optional markdown `comment_md` is
/// converted to ADF and sent only when present and non-empty after trimming (like
/// `issue_create`'s description). No `started` member is sent — the server defaults it to
/// now (live-probed). The full worklog object the API returns is mapped to a neutral
/// [`JiraWorklog`].
pub async fn worklog_add(
    site: &str,
    key: &str,
    time_spent: &str,
    comment_md: Option<&str>,
) -> AppResult<JiraWorklog> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    if !is_valid_duration(time_spent) {
        return Err(AppError::InvalidArgument(format!(
            "invalid duration (expected e.g. \"2d 4h 30m\" — units w/d/h/m): {time_spent}"
        )));
    }
    let creds = load_credentials(&site).await?;
    let mut body = serde_json::Map::new();
    body.insert("timeSpent".to_string(), json!(time_spent));
    if let Some(md) = comment_md.filter(|c| !c.trim().is_empty()) {
        body.insert("comment".to_string(), md_to_adf::markdown_to_adf(md));
    }
    let path = format!("issue/{key}/worklog");
    let resp: Value = post_json(&creds, &path, &Value::Object(body), "worklog").await?;
    Ok(map_worklog(&resp))
}

/// Edit one of your own worklog entries (`PUT /issue/<key>/worklog/<id>`); the duration
/// grammar and the digits-only id are validated before any network call.
///
/// A note is REPLACE-ONLY (probed): a duration-only PUT PRESERVES the existing note and
/// `comment: null` is a silent no-op, so a note can never be REMOVED via the API. `None`
/// omits the member (preserve), `Some(non-empty)` replaces, `Some(blank)` is an
/// `InvalidArgument` rather than a silent no-op.
pub async fn worklog_update(
    site: &str,
    key: &str,
    worklog_id: &str,
    time_spent: &str,
    comment_md: Option<&str>,
) -> AppResult<JiraWorklog> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    if !is_valid_comment_id(worklog_id) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira worklog id: {worklog_id}"
        )));
    }
    if !is_valid_duration(time_spent) {
        return Err(AppError::InvalidArgument(format!(
            "invalid duration (expected e.g. \"2d 4h 30m\" — units w/d/h/m): {time_spent}"
        )));
    }
    // A present-but-empty note can't be cleared through the API — reject it up front rather
    // than sending a silent no-op the caller would read as success.
    if let Some(md) = comment_md {
        if md.trim().is_empty() {
            return Err(AppError::InvalidArgument(
                "a worklog note can't be removed via the Jira API — replace it, or delete the \
                 entry and log again"
                    .into(),
            ));
        }
    }
    let creds = load_credentials(&site).await?;
    let mut body = serde_json::Map::new();
    body.insert("timeSpent".to_string(), json!(time_spent));
    // Present ⇒ replace (validated non-empty above); None ⇒ omit (duration-only PUT
    // preserves the existing note).
    if let Some(md) = comment_md {
        body.insert("comment".to_string(), md_to_adf::markdown_to_adf(md));
    }
    let path = format!("issue/{key}/worklog/{worklog_id}");
    let resp: Value = put_json(&creds, &path, &Value::Object(body), "worklog").await?;
    Ok(map_worklog(&resp))
}

/// Delete one of your own worklog entries (`DELETE /issue/<key>/worklog/<id>`; returns
/// 204). The issue key and the digits-only worklog id are grammar-validated BEFORE any
/// network call. Deleting restores the issue's remaining estimate server-side (probed) —
/// nothing is recomputed here. Ownership is enforced server-side by DELETE_OWN_WORKLOGS.
pub async fn worklog_delete(site: &str, key: &str, worklog_id: &str) -> AppResult<()> {
    let site = normalize_site(site)?;
    if !is_valid_issue_key(key) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira issue key: {key}"
        )));
    }
    if !is_valid_comment_id(worklog_id) {
        return Err(AppError::InvalidArgument(format!(
            "invalid Jira worklog id: {worklog_id}"
        )));
    }
    let creds = load_credentials(&site).await?;
    send_no_content(
        &creds,
        reqwest::Method::DELETE,
        &format!("issue/{key}/worklog/{worklog_id}"),
        None,
    )
    .await
}

/// PUT JSON to a Jira endpoint and deserialize the 2xx body into `T` (comment edit and
/// worklog update return the updated object; the 204-returning PUTs use
/// [`send_no_content`]). Same error handling as [`post_json`].
async fn put_json<T: serde::de::DeserializeOwned>(
    creds: &JiraCredentials,
    path: &str,
    body: &Value,
    what: &str,
) -> AppResult<T> {
    let (status, resp_body) = raw_request(creds, reqwest::Method::PUT, path, Some(body)).await?;
    if !(200..300).contains(&status) {
        return Err(http_error_for(status, &resp_body, &creds.site));
    }
    serde_json::from_str(&resp_body)
        .map_err(|e| AppError::Jira(format!("could not parse Jira {what}: {e}")))
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
        // Both auth codes get the product-scoped, enter-manually framing with the status
        // marker preserved — a product-scoped Bitbucket token returns 401 on Jira, so 401
        // must NOT keep the generic "expired/revoked" copy.
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
                "SCHEDULE_ISSUES": { "havePermission": true },
                "EDIT_ISSUES": { "havePermission": false },
                "EDIT_OWN_COMMENTS": { "havePermission": true },
                // DELETE_OWN_COMMENTS absent entirely.
                "WORK_ON_ISSUES": { "havePermission": true },
                "EDIT_OWN_WORKLOGS": { "havePermission": false },
                // DELETE_OWN_WORKLOGS absent entirely.
                "EDIT_ALL_WORKLOGS": { "havePermission": true },
                "DELETE_ALL_WORKLOGS": { "havePermission": false },
                "EDIT_ALL_COMMENTS": { "havePermission": true },
                // DELETE_ALL_COMMENTS absent entirely.
            }
        });
        let p = parse_permissions(&body);
        assert!(p.add_comments);
        assert!(!p.transition_issues);
        assert!(p.create_issues);
        // Absent key → false, never an error.
        assert!(!p.assign_issues);
        // Each permission key defends independently.
        assert!(p.schedule_issues);
        assert!(!p.edit_issues);
        assert!(p.edit_own_comments);
        // Absent key → false.
        assert!(!p.delete_own_comments);
        // The worklog keys: present-true, present-false, absent-false.
        assert!(p.work_on_issues);
        assert!(!p.edit_own_worklogs);
        assert!(!p.delete_own_worklogs);
        // The ALL-scoped admin keys: present-true, present-false, absent-false.
        assert!(p.edit_all_worklogs);
        assert!(!p.delete_all_worklogs);
        assert!(p.edit_all_comments);
        // Absent key → false.
        assert!(!p.delete_all_comments);
    }

    #[test]
    fn parse_permissions_malformed_defaults_false() {
        // A completely malformed body (no `permissions` object) reads as all-false.
        let p = parse_permissions(&json!({ "permissions": "nope" }));
        assert!(!p.add_comments);
        assert!(!p.transition_issues);
        assert!(!p.create_issues);
        assert!(!p.assign_issues);
        assert!(!p.schedule_issues);
        assert!(!p.edit_issues);
        assert!(!p.edit_own_comments);
        assert!(!p.delete_own_comments);
        assert!(!p.work_on_issues);
        assert!(!p.edit_own_worklogs);
        assert!(!p.delete_own_worklogs);
        assert!(!p.edit_all_worklogs);
        assert!(!p.delete_all_worklogs);
        assert!(!p.edit_all_comments);
        assert!(!p.delete_all_comments);
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
    // These parse the EXACT camelCase JSON a real Jira Cloud tenant returns through the
    // real structs — catching a struct field whose name differs from the wire key.

    #[test]
    fn transitions_response_parses_live_camelcase_and_picks_done() {
        // Verbatim shape from GET /issue/<key>/transitions.
        let body = r#"{
            "transitions": [
                { "id": "11", "name": "Start Progress",
                  "to": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } } },
                { "id": "21", "name": "Done",
                  "to": { "name": "Done", "statusCategory": { "key": "done" } } }
            ]
        }"#;
        let parsed: JiraTransitionsResponse = serde_json::from_str(body).unwrap();
        // The done category must actually deserialize.
        assert_eq!(category_of(&parsed.transitions[1]), Some("done"));
        // The destination status name (`to.name`) must also deserialize.
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
        // Verbatim shape from GET /issue/createmeta/<key>/issuetypes — the array is under
        // `issueTypes`, NOT `values`.
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

    // ── Agile custom-field discovery + extraction ────────────────────────────────

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

        // The name map covers every customfield_* id+name entry — and ONLY those (the
        // system `summary` field is filtered out; error translation never looks it up).
        let names = field_name_map(&fields);
        assert_eq!(
            names.get("customfield_10016").map(String::as_str),
            Some("Story point estimate")
        );
        assert_eq!(
            names.get("customfield_10099").map(String::as_str),
            Some("Budget")
        );
        assert!(
            !names.contains_key("summary"),
            "system field must be excluded"
        );
    }

    #[test]
    fn resolve_field_ids_rejects_hostile_id_at_discovery() {
        // A hostile field id from /field (URL-injection payload): the entry MATCHES the
        // sprint schema marker, but its id fails the customfield_ grammar → resolves to
        // None, never spliced into a URL. (The persisted-load layer is tested in
        // jira_field_maps.)
        let body = r#"[
            { "id": "customfield_10016&evil=1", "name": "Sprint", "custom": true,
              "schema": { "type": "array", "custom": "com.pyxis.greenhopper.jira:gh-sprint" } },
            { "id": "customfield_10099&x=y", "name": "Story point estimate", "custom": true,
              "schema": { "type": "number", "custom": "com.pyxis.greenhopper.jira:jsw-story-points" } }
        ]"#;
        let fields: Vec<JiraFieldMeta> = serde_json::from_str(body).unwrap();
        let (points, sprint) = resolve_field_ids(&fields);
        assert!(points.is_none(), "hostile points id must be rejected");
        assert!(sprint.is_none(), "hostile sprint id must be rejected");
        // The board-config override id is likewise grammar-validated.
        let cfg: JiraBoardConfig = serde_json::from_str(
            r#"{ "estimation": { "type": "field", "field": { "fieldId": "customfield_1&x=1" } } }"#,
        )
        .unwrap();
        assert!(board_config_points_override(&cfg).is_none());
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
            ..Default::default()
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
            ..Default::default()
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
    fn parse_time_tracking_absent_and_null_are_none() {
        // Field absent entirely → None (time tracking disabled on the project).
        assert!(parse_time_tracking(&json!({})).is_none());
        // JSON null → None as well.
        assert!(parse_time_tracking(&json!({ "timetracking": null })).is_none());
    }

    #[test]
    fn parse_time_tracking_empty_object_is_some_all_none() {
        // `{}` → Some with every member None (enabled but nothing tracked yet).
        let tt = parse_time_tracking(&json!({ "timetracking": {} })).expect("empty {} → Some");
        assert!(tt.original_estimate.is_none());
        assert!(tt.remaining_estimate.is_none());
        assert!(tt.time_spent.is_none());
        assert!(tt.original_estimate_seconds.is_none());
        assert!(tt.remaining_estimate_seconds.is_none());
        assert!(tt.time_spent_seconds.is_none());
    }

    #[test]
    fn parse_time_tracking_full_and_partial_objects() {
        // Full object → all six members populated.
        let full = parse_time_tracking(&json!({
            "timetracking": {
                "originalEstimate": "2d",
                "remainingEstimate": "1d 5h",
                "timeSpent": "3h",
                "originalEstimateSeconds": 57600u64,
                "remainingEstimateSeconds": 46800u64,
                "timeSpentSeconds": 10800u64,
            }
        }))
        .expect("full object → Some");
        assert_eq!(full.original_estimate.as_deref(), Some("2d"));
        assert_eq!(full.remaining_estimate.as_deref(), Some("1d 5h"));
        assert_eq!(full.time_spent.as_deref(), Some("3h"));
        assert_eq!(full.original_estimate_seconds, Some(57600));
        assert_eq!(full.remaining_estimate_seconds, Some(46800));
        assert_eq!(full.time_spent_seconds, Some(10800));

        // After all worklogs are deleted, `timeSpent:"0m"`/`timeSpentSeconds:0` linger while
        // the estimate members are absent → Some with just those two set.
        let residual = parse_time_tracking(&json!({
            "timetracking": { "timeSpent": "0m", "timeSpentSeconds": 0u64 }
        }))
        .expect("residual object → Some");
        assert_eq!(residual.time_spent.as_deref(), Some("0m"));
        assert_eq!(residual.time_spent_seconds, Some(0));
        assert!(residual.original_estimate.is_none());
        assert!(residual.remaining_estimate_seconds.is_none());
    }

    #[test]
    fn map_worklog_full_object_maps_all_fields() {
        let w = map_worklog(&json!({
            "id": "100123",
            "author": { "accountId": "a1", "displayName": "Bob" },
            "timeSpent": "3h",
            "timeSpentSeconds": 10800u64,
            "started": "2026-02-01T09:00:00.000+0000",
            "comment": { "type": "doc", "version": 1, "content": [
                { "type": "paragraph", "content": [ { "type": "text", "text": "Worked on it" } ] }
            ]},
            "created": "2026-02-01T09:05:00.000+0000",
            "updated": "2026-02-01T09:06:00.000+0000"
        }));
        assert_eq!(w.id, "100123");
        assert_eq!(w.author.map(|a| a.label), Some("Bob".to_string()));
        assert_eq!(w.time_spent, "3h");
        assert_eq!(w.time_spent_seconds, 10800);
        assert_eq!(w.started, "2026-02-01T09:00:00.000+0000");
        assert!(w.comment_md.contains("Worked on it"));
        assert_eq!(w.created_at, "2026-02-01T09:05:00.000+0000");
        assert_eq!(w.updated_at.as_deref(), Some("2026-02-01T09:06:00.000+0000"));
    }

    #[test]
    fn map_worklog_null_comment_and_missing_fields_degrade() {
        // A null comment → empty markdown (the ADF conversion is skipped defensively).
        let null_comment = map_worklog(&json!({
            "id": "5",
            "timeSpent": "45m",
            "timeSpentSeconds": 2700u64,
            "started": "2026-02-02T10:00:00.000+0000",
            "comment": null,
            "created": "2026-02-02T10:00:00.000+0000"
        }));
        assert_eq!(null_comment.comment_md, "");
        assert!(null_comment.updated_at.is_none()); // absent `updated` → None.

        // Missing id/seconds degrade to ""/0 rather than panicking.
        let sparse = map_worklog(&json!({ "timeSpent": "1h" }));
        assert_eq!(sparse.id, "");
        assert_eq!(sparse.time_spent_seconds, 0);
        assert_eq!(sparse.comment_md, "");
        assert!(sparse.author.is_none());
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
            ..Default::default()
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

    // ── Property writes / pickers / comment edit-delete ──────────────────────────

    #[test]
    fn priorities_parse_live_bare_array_with_iconurl_casing() {
        // Verbatim shape from GET /rest/api/3/priority — a BARE ARRAY (no envelope) of
        // {id, name, iconUrl, …}. The `iconUrl` camelCase key is the crux: without
        // `rename_all = "camelCase"` on JiraPriority, `icon_url` would parse empty.
        let body = r##"[
            { "id": "1", "name": "Highest", "iconUrl": "https://icon/highest",
              "statusColor": "#d04437" },
            { "id": "3", "name": "Medium", "iconUrl": "https://icon/medium" }
        ]"##;
        let parsed: Vec<JiraPriority> = serde_json::from_str(body).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "1");
        assert_eq!(parsed[0].name, "Highest");
        assert_eq!(parsed[0].icon_url, "https://icon/highest");
        assert_eq!(parsed[1].name, "Medium");
    }

    #[test]
    fn labels_page_extracts_values() {
        // Verbatim shape from GET /rest/api/3/label — a paginated {values, total} envelope.
        let body = r#"{
            "maxResults": 50, "startAt": 0, "total": 3, "isLast": true,
            "values": ["backend", "frontend", "urgent"]
        }"#;
        let page: JiraLabelsPage = serde_json::from_str(body).unwrap();
        assert_eq!(page.values, vec!["backend", "frontend", "urgent"]);
        // A missing `values` degrades to empty (not an error).
        let empty: JiraLabelsPage = serde_json::from_str(r#"{"total":0}"#).unwrap();
        assert!(empty.values.is_empty());
    }

    #[test]
    fn valid_due_date_grammar() {
        assert!(is_valid_due_date("2026-07-11"));
        assert!(is_valid_due_date("0000-00-00")); // shape-only; Jira validates the calendar
        assert!(!is_valid_due_date("")); // empty
        assert!(!is_valid_due_date("2026-7-11")); // single-digit month
        assert!(!is_valid_due_date("2026/07/11")); // wrong separator
        assert!(!is_valid_due_date("2026-07-11T00:00:00")); // has time
        assert!(!is_valid_due_date("26-07-11")); // 2-digit year
        assert!(!is_valid_due_date("2026-07-1x")); // non-digit
    }

    #[test]
    fn due_date_body_uses_null_to_clear() {
        // None → {fields:{duedate:null}} (clears); Some → the string.
        let cleared = json!({ "fields": { "duedate": Option::<&str>::None } });
        assert!(cleared["fields"]["duedate"].is_null());
        let set = json!({ "fields": { "duedate": Some("2026-07-11") } });
        assert_eq!(set["fields"]["duedate"], "2026-07-11");
    }

    #[test]
    fn valid_duration_grammar() {
        // Accepts a single unit token and multi-token whitespace-separated durations,
        // including fractional mantissas.
        assert!(is_valid_duration("3h"));
        assert!(is_valid_duration("2d 4h 30m"));
        assert!(is_valid_duration("1.5h"));
        assert!(is_valid_duration("45m"));
        assert!(is_valid_duration("1w"));
        // Rejects: empty, unitless, unit-only, unknown unit, comma-joined, whitespace-only,
        // and a space between the number and its unit.
        assert!(!is_valid_duration(""));
        assert!(!is_valid_duration("3"));
        assert!(!is_valid_duration("h"));
        assert!(!is_valid_duration("3x"));
        assert!(!is_valid_duration("3h,4m"));
        assert!(!is_valid_duration(" "));
        assert!(!is_valid_duration("3 h"));
    }

    #[test]
    fn valid_label_rejects_whitespace_and_empty() {
        assert!(is_valid_label("backend"));
        assert!(is_valid_label("needs-review"));
        assert!(!is_valid_label("")); // empty
        assert!(!is_valid_label("two words")); // space
        assert!(!is_valid_label("tab\tlabel")); // tab
        assert!(!is_valid_label(" leading")); // leading space
    }

    #[test]
    fn valid_comment_id_requires_nonempty_digits() {
        assert!(is_valid_comment_id("10001"));
        assert!(is_valid_comment_id("7"));
        assert!(!is_valid_comment_id("")); // empty
        assert!(!is_valid_comment_id("10a")); // non-digit
        assert!(!is_valid_comment_id("10 01")); // space
        assert!(!is_valid_comment_id("../10001")); // path-traversal attempt
        assert!(!is_valid_comment_id("-1")); // sign
    }

    #[test]
    fn map_comment_populates_updated_at_when_present() {
        // A comment whose `updated` differs from `created` (an edited comment) populates
        // `updated_at`; the UI shows the "(edited)" cue from it.
        let edited = json!({
            "id": "10001",
            "author": { "accountId": "a1", "displayName": "Bob" },
            "body": { "type": "doc", "version": 1, "content": [
                { "type": "paragraph", "content": [ { "type": "text", "text": "Edited body" } ] }
            ]},
            "created": "2026-02-01T00:00:00.000+0000",
            "updated": "2026-02-02T09:30:00.000+0000"
        });
        let c = map_comment(&edited);
        assert_eq!(c.id, "10001");
        assert_eq!(c.body_md, "Edited body");
        assert_eq!(c.created_at, "2026-02-01T00:00:00.000+0000");
        assert_eq!(
            c.updated_at.as_deref(),
            Some("2026-02-02T09:30:00.000+0000")
        );

        // An absent `updated` → None (no cue).
        let unedited = json!({
            "id": "10002",
            "body": { "type": "doc", "version": 1, "content": [] },
            "created": "2026-02-01T00:00:00.000+0000"
        });
        assert!(map_comment(&unedited).updated_at.is_none());
    }
}
