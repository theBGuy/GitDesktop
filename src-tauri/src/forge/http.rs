//! Bitbucket-only HTTP layer: GitHub stays on `gh` and GitLab on `glab`, so only
//! Bitbucket Cloud speaks direct HTTP. This is the credential + transport substrate
//! the [`bitbucket`](super::bitbucket) provider builds on — a shared
//! [`reqwest`](tauri_plugin_http::reqwest) client, keyring-backed credential loading,
//! and the JSON/raw GET helpers with Bitbucket's error-envelope parsing. Every call
//! authenticates with HTTP Basic (`{atlassian_account_email}:{api_token}`); app
//! passwords were removed 2026-07-28, so the API token is the only supported
//! credential.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

use serde::Deserialize;
use tauri_plugin_http::reqwest::{self, Client};

use crate::error::{AppError, AppResult};

/// Keep the summary on line one and the original detail available on line two.
pub(crate) fn bb_unreadable(what: &str, detail: String) -> AppError {
    // Diagnostic labels remain unchanged in detail; only the summary needs an article.
    let what = match what {
        "branch restriction" => "the branch restriction",
        "comment" => "the comment",
        "commit comment" => "the commit comment",
        "created pull request" => "the created pull request",
        "created task" => "the created task",
        "default reviewer" => "the default reviewer",
        "fork" => "the fork",
        "pipeline" => "the pipeline",
        "pipeline schedule" => "the pipeline schedule",
        "pipeline variable" => "the pipeline variable",
        "pull request" => "the pull request",
        "pull request activity" => "the pull request activity",
        "reply" => "the reply",
        "repository" => "the repository",
        "review comment" => "the review comment",
        "review summary" => "the review summary",
        "task" => "the task",
        "user" => "the user",
        "webhook" => "the webhook",
        "diffstat" => "the file changes",
        "pipelines config" => "the pipeline settings",
        _ => what,
    };
    AppError::Bitbucket(format!("Couldn't read {what} from Bitbucket.\n{detail}"))
}

/// The Bitbucket Cloud REST base. Every relative path the provider passes is
/// resolved against this; absolute URLs (e.g. a pagination `next`) are used as-is.
pub const BB_API_BASE: &str = "https://api.bitbucket.org/2.0/";

/// The host these credentials are namespaced under in the keyring (`forge/<host>/…`).
pub const BB_HOST: &str = "bitbucket.org";

/// Keyring credential keys under `forge/bitbucket.org/*`.
pub const KEY_EMAIL: &str = "email";
pub const KEY_TOKEN: &str = "token";
pub const KEY_USERNAME: &str = "username";
pub const KEY_DISPLAY_NAME: &str = "display_name";

/// Mirror `GLAB_NETWORK_TIMEOUT` — the ceiling for a single request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
/// A tighter connect timeout so an unreachable host fails fast, not after 120s.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The process-wide Bitbucket HTTP client (built once: connection pooling, one TLS
/// setup).
///
/// Redirect policy is reqwest's DEFAULT, and that default is LOAD-BEARING: PR `/diff`
/// 302s to a same-host raw-diff URL where reqwest KEEPS `Authorization`, while step
/// logs 307 to a pre-signed S3 URL on another host where reqwest STRIPS it (the URL
/// carries its own auth; sending our Basic creds to S3 would leak them). Don't
/// override the policy without preserving both behaviours.
static CLIENT: OnceLock<Client> = OnceLock::new();

fn client() -> &'static Client {
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(concat!("GitDesktop/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .build()
            // The builder only fails on a broken TLS backend, and `Client::new()` uses
            // the same backend — fall back rather than panic.
            .unwrap_or_else(|_| Client::new())
    })
}

/// The stored Bitbucket credentials (email + token), loaded from the OS keyring.
/// Never logged, never returned across IPC.
#[derive(Clone)]
pub struct BbCredentials {
    pub email: String,
    pub token: String,
}

/// Process cache of the loaded credentials: every keyring read pops a macOS
/// keychain-authorization prompt and this layer loads credentials on essentially every
/// REST request, so the keyring is read ONCE per session. Invalidated on
/// connect/disconnect via [`invalidate_credential_cache`].
static CREDENTIAL_CACHE: RwLock<Option<BbCredentials>> = RwLock::new(None);
/// Serializes the first (uncached) load so a burst of concurrent callers on repo
/// open triggers ONE keyring read (one prompt), not one per caller.
static CREDENTIAL_LOAD_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Bumped by every invalidation. A cold load captures it before the keyring read and
/// only commits the read to the cache if it's unchanged — so a connect/disconnect
/// that races an in-flight read can't be clobbered by a stale re-warm (the
/// write-after-invalidate race). See [`load_credentials`] / [`invalidate_credential_cache`].
static CREDENTIAL_GENERATION: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
static TEST_CREDENTIALS: std::sync::Mutex<Option<(String, String)>> = std::sync::Mutex::new(None);

/// Returns the previous override so the caller can restore it on every path.
/// The slot is process-global with ONE consuming test today (the Bitbucket
/// no-token arm — nothing else in the crate reaches `load_credentials` under
/// test); a second concurrent consumer must serialize through a shared lock.
#[cfg(test)]
pub(crate) fn swap_test_credentials(
    credentials: Option<(String, String)>,
) -> Option<(String, String)> {
    let mut slot = TEST_CREDENTIALS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::replace(&mut *slot, credentials)
}

/// Load the stored credentials — from the process cache when warm, else the OS
/// keyring (blocking reads run on a blocking thread), caching the result.
/// `BitbucketNotConfigured` when no token is stored — the signal the read commands
/// turn into the "connect an account" state.
pub async fn load_credentials() -> AppResult<BbCredentials> {
    fn credentials_from_parts(
        email: Option<String>,
        token: Option<String>,
    ) -> AppResult<BbCredentials> {
        match (email, token) {
            (Some(email), Some(token)) if !email.is_empty() && !token.is_empty() => {
                Ok(BbCredentials { email, token })
            }
            _ => Err(AppError::BitbucketNotConfigured),
        }
    }

    // The test override precedes the cache fast-path and returns before cache writes,
    // so test credentials can never warm the process-global cache or read the keyring.
    #[cfg(test)]
    if let Some((email, token)) = TEST_CREDENTIALS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
    {
        return credentials_from_parts(Some(email), Some(token));
    }

    // Fast path: cached credential → no keyring read → no macOS prompt. Poison recovery
    // (`into_inner`) is safe — nothing fallible runs under these guards.
    if let Some(creds) = CREDENTIAL_CACHE.read().unwrap_or_else(|p| p.into_inner()).clone() {
        return Ok(creds);
    }
    // Serialize the cold load so concurrent first-callers don't each read the keyring.
    let _guard = CREDENTIAL_LOAD_LOCK.lock().await;
    if let Some(creds) = CREDENTIAL_CACHE.read().unwrap_or_else(|p| p.into_inner()).clone() {
        return Ok(creds); // another caller warmed the cache while we waited
    }
    // Fail closed under test: reaching the keyring read means no override is
    // installed, and tests never read the real OS keyring.
    if cfg!(test) {
        panic!("load_credentials in a test without swap_test_credentials installed");
    }
    // Capture the generation before the (slow) keyring read; if a connect/disconnect
    // invalidates while we read, we must NOT cache the now-stale value.
    let generation = CREDENTIAL_GENERATION.load(Ordering::Acquire);
    let (email, token) = tauri::async_runtime::spawn_blocking(|| {
        let email = crate::secrets::read_forge_secret(BB_HOST, KEY_EMAIL)?;
        let token = crate::secrets::read_forge_secret(BB_HOST, KEY_TOKEN)?;
        Ok::<_, AppError>((email, token))
    })
    .await
    .map_err(|e| AppError::Bitbucket(format!("keyring task failed: {e}")))??;
    let creds = credentials_from_parts(email, token)?;
    // Commit only if no invalidation raced in: check + write are held under
    // the cache write lock, and `invalidate` bumps the generation BEFORE
    // clearing under that lock, so a stale value is never left cached.
    {
        let mut cache = CREDENTIAL_CACHE.write().unwrap_or_else(|p| p.into_inner());
        if CREDENTIAL_GENERATION.load(Ordering::Acquire) == generation {
            *cache = Some(creds.clone());
        }
    }
    Ok(creds)
}

/// Drop the cached credential so the next [`load_credentials`] re-reads the keyring —
/// called on connect/disconnect (the stored token changed).
pub(crate) fn invalidate_credential_cache() {
    // Bump BEFORE clearing so an in-flight cold load skips caching its stale read.
    CREDENTIAL_GENERATION.fetch_add(1, Ordering::AcqRel);
    *CREDENTIAL_CACHE.write().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Bitbucket's error envelope. The common shape is
/// `{"type":"error","error":{"message":…}}`, but some endpoints (e.g. an invalid
/// pipeline selector) drop the top-level `"type"` key and carry the useful text in
/// `error.detail` instead of `error.message`. The top-level `type` is never read, so
/// its absence is tolerated; parsing is best-effort and callers fall back to a
/// status-code message.
#[derive(Deserialize)]
struct BbErrorEnvelope {
    error: Option<BbErrorBody>,
}

#[derive(Deserialize)]
struct BbErrorBody {
    #[serde(default)]
    message: String,
    /// A more specific explanation on some envelopes (e.g. "Requested selector is not
    /// found in bitbucket-pipelines.yml."). Preferred over `message` when present.
    #[serde(default)]
    detail: String,
}

impl BbErrorBody {
    /// The best human message: `detail` when it's non-empty, else `message`.
    fn best_message(self) -> String {
        if self.detail.trim().is_empty() {
            self.message
        } else {
            self.detail
        }
    }
}

/// The write-family non-2xx error arm, including 401/429 guidance and API detail.
/// GET helpers take an explicit [`BbOpKind`]; callers inspecting a GET status use
/// [`bb_error_detail`] with `BbOpKind::Read`.
pub(crate) fn http_error(status: u16, body: &str) -> AppError {
    AppError::Bitbucket(bb_error_detail(status, body, BbOpKind::Write))
}

#[derive(Clone, Copy)]
pub(crate) enum BbOpKind {
    Read,
    Write,
}

/// Shared Bitbucket status guidance, API envelope detail, or a bounded text snippet.
/// `op` picks the 403 privilege-scope guidance: `Read` names repository, account,
/// or pipeline read access; `Write` names pull request, repository, or pipeline writes.
pub(crate) fn bb_error_detail(status: u16, body: &str, op: BbOpKind) -> String {
    // Prefer the API's own message when the body is the JSON error envelope.
    let api_msg = serde_json::from_str::<BbErrorEnvelope>(body)
        .ok()
        .and_then(|e| e.error)
        .map(BbErrorBody::best_message)
        .filter(|m| !m.trim().is_empty());
    match status {
        401 => {
            "Bitbucket rejected the request (401) — your API token may be expired or \
             revoked. Reconnect it in Settings → Accounts."
                .into()
        }
        429 => "Bitbucket rate limit reached (429). Wait a moment and try again.".into(),
        // A 403 whose body names Bitbucket's "privilege scopes" is a missing-scope
        // token (a bad token is a 401); other 403s fall through to the envelope message.
        403 if body.contains("privilege scopes") => {
            match op {
                BbOpKind::Read => {
                    "Bitbucket rejected the request (403) — your API token is missing a scope \
                     this read needs. Reconnect it in Settings → Accounts with repository, account, or pipeline read access."
                        .into()
                }
                BbOpKind::Write => {
                    "Bitbucket rejected the request (403) — your API token is missing a required \
                     write scope. Reconnect it in Settings → Accounts with pull request / \
                     repository / pipeline write scopes."
                        .into()
                }
            }
        }
        _ => api_msg.unwrap_or_else(|| {
            let trimmed = body.trim();
            if trimmed.is_empty() {
                format!("HTTP {status}")
            } else {
                // Plain-text (non-envelope) body — keep it short.
                let snippet: String = trimmed.chars().take(300).collect();
                format!("HTTP {status}: {snippet}")
            }
        }),
    }
}

/// Cause suffixes a failed send carries so the frontend's error classifier can tell
/// an unreachable host from a server answer. Cross-IPC contract: the literals are
/// matched in src/lib/error-summary.ts and pinned by scripts/error-summary.test.mjs.
pub(crate) const TRANSPORT_TIMED_OUT: &str = "request timed out";
pub(crate) const TRANSPORT_CONNECT_FAILED: &str = "connection failed";

/// Detect ConnectionReset, ConnectionAborted, or BrokenPipe in the error chain.
/// UnexpectedEof is excluded: a truncated body is not provably a transport failure.
fn has_connection_reset(error: &(dyn std::error::Error + 'static)) -> bool {
    let mut current = Some(error);
    while let Some(error) = current {
        if error.downcast_ref::<std::io::Error>().is_some_and(|e| {
            matches!(
                e.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::BrokenPipe
            )
        }) {
            return true;
        }
        current = error.source();
    }
    false
}

pub(crate) fn is_transport_failure(e: &reqwest::Error) -> bool {
    e.is_timeout() || e.is_connect() || has_connection_reset(e)
}

/// Format send and body-read failures with a transport cause, including resets
/// reqwest does not flag. Send failures deliberately receive the reset suffix too.
/// Timeout takes precedence when a connect timeout satisfies both predicates.
pub(crate) fn transport_failure_message(prefix: &str, e: &reqwest::Error) -> String {
    let cause = if e.is_timeout() {
        Some(TRANSPORT_TIMED_OUT)
    } else if is_transport_failure(e) {
        // Resets reuse the existing cross-IPC literal matched by error-summary.ts.
        Some(TRANSPORT_CONNECT_FAILED)
    } else {
        None
    };
    match cause {
        Some(cause) => format!("{prefix}: {e}: {cause}"),
        None => format!("{prefix}: {e}"),
    }
}

fn bb_body_read_error(e: reqwest::Error) -> AppError {
    if is_transport_failure(&e) {
        AppError::Bitbucket(transport_failure_message(
            "could not read Bitbucket response",
            &e,
        ))
    } else {
        bb_unreadable(
            "the response",
            format!("could not read Bitbucket response: {e}"),
        )
    }
}

/// Resolve a relative path against the API base, or pass an absolute URL through.
/// (Bitbucket's pagination `next` is a full URL; single-endpoint calls pass a
/// relative path like `workspaces` or `repositories/{ws}`.)
fn resolve_url(path_or_url: &str) -> String {
    if path_or_url.starts_with("http://") || path_or_url.starts_with("https://") {
        path_or_url.to_string()
    } else {
        format!("{BB_API_BASE}{}", path_or_url.trim_start_matches('/'))
    }
}

/// GET a Bitbucket endpoint and return the raw `(status, body)` — following
/// redirects (the default policy — see [`CLIENT`]) — WITHOUT turning a non-2xx into
/// an error. Only a transport/read failure is an `Err`; the HTTP status is handed to
/// the caller so it can special-case one (e.g. a 404 from an expired pipeline log).
/// Callers that don't need that use [`bb_get_text`].
pub async fn bb_get_text_status(
    creds: &BbCredentials,
    path_or_url: &str,
) -> AppResult<(u16, String)> {
    bb_get_status(creds, path_or_url, false).await
}

async fn bb_get_status(
    creds: &BbCredentials,
    path_or_url: &str,
    json: bool,
) -> AppResult<(u16, String)> {
    let url = resolve_url(path_or_url);
    let mut req = client()
        .get(&url)
        .basic_auth(&creds.email, Some(&creds.token));
    if json {
        req = req.header(reqwest::header::ACCEPT, "application/json");
    }
    let resp = req
        .send()
        .await
        .map_err(|e| {
            AppError::Bitbucket(transport_failure_message("Bitbucket request failed", &e))
        })?;
    let status = resp.status().as_u16();
    let body = resp.text().await.map_err(bb_body_read_error)?;
    Ok((status, body))
}

/// GET a Bitbucket endpoint and return the raw response body as text, following
/// redirects (the default policy — see [`CLIENT`]). Non-2xx → [`bb_error_detail`]. Used
/// for the PR `/diff` (raw unified diff) and step logs (raw octet-stream).
pub async fn bb_get_text(
    creds: &BbCredentials,
    path_or_url: &str,
    op: BbOpKind,
) -> AppResult<String> {
    let (status, body) = bb_get_text_status(creds, path_or_url).await?;
    if !(200..300).contains(&status) {
        return Err(AppError::Bitbucket(bb_error_detail(status, &body, op)));
    }
    Ok(body)
}

/// GET a Bitbucket endpoint expecting JSON, deserializing into `T` (HTTP Basic,
/// `Accept: application/json`, default redirect policy). Non-2xx → [`bb_error_detail`]; a
/// 2xx body that won't parse takes [`bb_unreadable`]'s summary on line one, with the
/// original serde error on line two. That summary reads `what` through the helper's
/// article map, so a listed label gains its article and any other passes through as
/// written.
pub async fn bb_get_json<T: serde::de::DeserializeOwned>(
    creds: &BbCredentials,
    path_or_url: &str,
    what: &str,
    op: BbOpKind,
) -> AppResult<T> {
    let (status, body) = bb_get_status(creds, path_or_url, true).await?;
    if !(200..300).contains(&status) {
        return Err(AppError::Bitbucket(bb_error_detail(status, &body, op)));
    }
    serde_json::from_str(&body)
        .map_err(|e| bb_unreadable(what, format!("could not parse Bitbucket {what}: {e}")))
}

/// GET that returns (status, body) for ANY status instead of mapping non-2xx
/// to AppError — the Code Insights classifier discriminates on both.
pub async fn bb_get_classified(
    creds: &BbCredentials,
    path_or_url: &str,
) -> AppResult<(u16, String)> {
    bb_get_status(creds, path_or_url, true).await
}

/// The low-level write primitive: send `method` to `path_or_url` with an optional JSON
/// `body` and HTTP Basic auth, returning the raw `(status, location_header, body_text)`
/// WITHOUT turning a non-2xx into an error — the caller decides. Used directly by the
/// merge path, which must branch on 200 (sync) vs 202 (async task, follow `Location`);
/// the typed helpers below build on it.
pub async fn bb_send(
    creds: &BbCredentials,
    method: reqwest::Method,
    path_or_url: &str,
    body: Option<&serde_json::Value>,
) -> AppResult<(u16, Option<String>, String)> {
    let url = resolve_url(path_or_url);
    let mut req = client()
        .request(method, &url)
        .basic_auth(&creds.email, Some(&creds.token))
        .header(reqwest::header::ACCEPT, "application/json");
    if let Some(b) = body {
        // Serialize ourselves rather than `.json()` (which needs reqwest's `json`
        // feature — a new dep). `to_string` on a `Value` can't fail, so the empty-body
        // fallback is unreachable.
        let text = serde_json::to_string(b).unwrap_or_default();
        req = req
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(text);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| {
            AppError::Bitbucket(transport_failure_message("Bitbucket request failed", &e))
        })?;
    let status = resp.status().as_u16();
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = resp.text().await.map_err(bb_body_read_error)?;
    Ok((status, location, body))
}

/// POST JSON to a Bitbucket endpoint and deserialize the 2xx body into `T`.
/// `Accept`/`Content-Type: application/json`, HTTP Basic auth. Non-2xx →
/// [`http_error`]; a parse failure takes [`bb_unreadable`]'s summary on line one
/// (`what` article-mapped, unlisted labels passed through), with the original serde
/// error on line two.
pub async fn bb_post_json<T: serde::de::DeserializeOwned>(
    creds: &BbCredentials,
    path_or_url: &str,
    body: &serde_json::Value,
    what: &str,
) -> AppResult<T> {
    let (status, _, body) = bb_send(creds, reqwest::Method::POST, path_or_url, Some(body)).await?;
    if !(200..300).contains(&status) {
        return Err(http_error(status, &body));
    }
    serde_json::from_str(&body)
        .map_err(|e| bb_unreadable(what, format!("could not parse Bitbucket {what}: {e}")))
}

/// PUT JSON to a Bitbucket endpoint and deserialize the 2xx body into `T`. Same shape
/// as [`bb_post_json`]: [`bb_unreadable`]'s article-mapped summary on line one, with
/// the original serde error on line two.
pub async fn bb_put_json<T: serde::de::DeserializeOwned>(
    creds: &BbCredentials,
    path_or_url: &str,
    body: &serde_json::Value,
    what: &str,
) -> AppResult<T> {
    let (status, _, body) = bb_send(creds, reqwest::Method::PUT, path_or_url, Some(body)).await?;
    if !(200..300).contains(&status) {
        return Err(http_error(status, &body));
    }
    serde_json::from_str(&body)
        .map_err(|e| bb_unreadable(what, format!("could not parse Bitbucket {what}: {e}")))
}

/// POST to a Bitbucket endpoint with NO request body (decline / approve /
/// stopPipeline). Any 2xx (including a 200 participant echo or a 204) → `Ok`; the
/// returned body is ignored. Non-2xx → [`http_error`].
pub async fn bb_post_empty(creds: &BbCredentials, path_or_url: &str) -> AppResult<()> {
    let (status, _, body) = bb_send(creds, reqwest::Method::POST, path_or_url, None).await?;
    if !(200..300).contains(&status) {
        return Err(http_error(status, &body));
    }
    Ok(())
}

/// DELETE a Bitbucket endpoint. Any 2xx (typically 204) → `Ok`. Non-2xx →
/// [`http_error`].
pub async fn bb_delete(creds: &BbCredentials, path_or_url: &str) -> AppResult<()> {
    let (status, _, body) = bb_send(creds, reqwest::Method::DELETE, path_or_url, None).await?;
    if !(200..300).contains(&status) {
        return Err(http_error(status, &body));
    }
    Ok(())
}

// SYNTHETIC: headers arrive successfully, then the body stalls or ends early.
#[cfg(test)]
pub(super) async fn incomplete_body_error(timeout: bool) -> reqwest::Error {
    incomplete_body_error_mode(timeout, false).await
}

#[cfg(test)]
async fn incomplete_body_error_mode(timeout: bool, reset: bool) -> reqwest::Error {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/fixture", listener.local_addr().unwrap());
    let (body_started, wait_for_body) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut byte = [0];
        while !request.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
            .await
            .unwrap();
        if reset {
            // Wait for the client to receive headers so the RST fails the body read.
            wait_for_body.await.unwrap();
            stream.set_zero_linger().unwrap();
        } else if timeout {
            std::future::pending::<()>().await;
        }
    });
    let response = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .unwrap()
        .get(url)
        .send()
        .await
        .unwrap();
    if reset {
        body_started.send(()).unwrap();
    }
    let error = response.text().await.unwrap_err();
    server.abort();
    assert_eq!(error.is_timeout(), timeout);
    assert!(!error.is_connect());
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct NestedError(Box<dyn std::error::Error>);

    impl std::fmt::Display for NestedError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("synthetic body error")
        }
    }

    impl std::error::Error for NestedError {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(self.0.as_ref())
        }
    }

    fn nested_io_error(kind: std::io::ErrorKind) -> NestedError {
        NestedError(Box::new(NestedError(Box::new(std::io::Error::from(kind)))))
    }

    #[test]
    fn nested_connection_reset_is_transport() {
        assert!(has_connection_reset(&nested_io_error(
            std::io::ErrorKind::ConnectionReset
        )));
    }

    #[test]
    fn nested_connection_aborted_is_transport() {
        assert!(has_connection_reset(&nested_io_error(
            std::io::ErrorKind::ConnectionAborted
        )));
    }

    #[test]
    fn nested_broken_pipe_is_transport() {
        assert!(has_connection_reset(&nested_io_error(
            std::io::ErrorKind::BrokenPipe
        )));
    }

    #[test]
    fn nested_unexpected_eof_is_not_transport() {
        assert!(!has_connection_reset(&nested_io_error(
            std::io::ErrorKind::UnexpectedEof
        )));
        assert!(!has_connection_reset(&nested_io_error(
            std::io::ErrorKind::Other
        )));
        assert!(!has_connection_reset(&std::io::Error::other(
            "connection reset"
        )));
    }

    async fn forbidden_response(body: &'static str, json: bool, write: bool) -> String {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/fixture", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            assert!(request.starts_with(if write { b"POST " } else { b"GET " }));
            write!(
                stream,
                "HTTP/1.1 403 Forbidden\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            )
            .unwrap();
        });
        let creds = BbCredentials {
            email: "fixture@example.test".into(),
            token: "fixture".into(),
        };
        let error = if write {
            bb_post_empty(&creds, &url).await.unwrap_err()
        } else if json {
            bb_get_json::<serde_json::Value>(&creds, &url, "repository", BbOpKind::Read)
                .await
                .unwrap_err()
        } else {
            bb_get_text(&creds, &url, BbOpKind::Read).await.unwrap_err()
        };
        server.join().unwrap();
        error.to_string()
    }

    #[tokio::test]
    async fn get_helpers_use_read_scope_guidance_and_writes_keep_write_guidance() {
        let body = r#"{"error":{"message":"Your credentials lack required privilege scopes."}}"#;
        for json in [false, true] {
            let message = forbidden_response(body, json, false).await;
            assert!(
                message.contains("repository, account, or pipeline read access"),
                "{message}",
            );
            assert!(!message.contains("write scope"), "{message}");
        }
        let message = forbidden_response(body, false, true).await;
        assert!(message.contains("required write scope"), "{message}");
        assert!(
            !message.contains("repository, account, or pipeline read access"),
            "{message}",
        );
    }

    #[tokio::test]
    async fn get_helpers_keep_generic_403_details_without_privilege_scopes_marker() {
        let body = r#"{"error":{"message":"You do not have access to this repository."}}"#;
        for json in [false, true] {
            assert_eq!(
                forbidden_response(body, json, false).await,
                "You do not have access to this repository.",
            );
        }
    }

    #[test]
    fn bitbucket_unreadable_keeps_the_detail_on_its_own_line() {
        let detail = "could not parse Bitbucket response: boom";
        assert_eq!(
            bb_unreadable("the response", detail.into()).to_string(),
            "Couldn't read the response from Bitbucket.\ncould not parse Bitbucket response: boom"
        );
    }

    #[tokio::test]
    async fn bitbucket_body_read_timeout_carries_the_transport_marker() {
        let error = incomplete_body_error(true).await;
        let message = bb_body_read_error(error).to_string();
        assert!(message.ends_with(": request timed out"), "{message}");
    }

    #[tokio::test]
    // The synchronized RST was verified on Windows; other platforms are unprobed.
    #[cfg(windows)]
    async fn bitbucket_body_read_reset_carries_the_connect_marker() {
        let error = incomplete_body_error_mode(false, true).await;
        assert!(has_connection_reset(&error));
        let message = bb_body_read_error(error).to_string();
        assert!(message.ends_with(": connection failed"), "{message}");
        assert!(!message.contains("Couldn't read the response"), "{message}");
    }

    #[tokio::test]
    async fn bitbucket_other_body_read_errors_keep_the_unreadable_detail() {
        let error = incomplete_body_error(false).await;
        let expected = format!(
            "Couldn't read the response from Bitbucket.\ncould not read Bitbucket response: {error}"
        );
        assert_eq!(bb_body_read_error(error).to_string(), expected);
    }

    #[test]
    fn resolve_url_joins_relative_and_passes_absolute() {
        assert_eq!(
            resolve_url("workspaces"),
            "https://api.bitbucket.org/2.0/workspaces"
        );
        // A leading slash on the relative path is tolerated (not doubled).
        assert_eq!(
            resolve_url("/repositories/ws"),
            "https://api.bitbucket.org/2.0/repositories/ws"
        );
        // An absolute URL (a pagination `next`) is passed through untouched.
        let next = "https://api.bitbucket.org/2.0/repositories/ws?page=2";
        assert_eq!(resolve_url(next), next);
    }

    #[test]
    fn http_error_prefers_the_api_envelope_message() {
        let body = r#"{"type":"error","error":{"message":"Repository not found"}}"#;
        match http_error(404, body) {
            AppError::Bitbucket(m) => assert!(m.contains("Repository not found")),
            other => panic!("expected Bitbucket error, got {other:?}"),
        }
    }

    #[test]
    fn http_error_uses_detail_over_message_when_present() {
        // The custom-pipeline-selector error drops the top-level "type" and carries the
        // useful text in error.detail (not error.message).
        let body = r#"{"error":{"message":"Bad request","detail":"Requested selector is not found in bitbucket-pipelines.yml.","data":{}}}"#;
        match http_error(400, body) {
            AppError::Bitbucket(m) => {
                assert!(m.contains("Requested selector is not found"));
                // The generic "Bad request" message is NOT what surfaces.
                assert!(!m.contains("Bad request"));
            }
            other => panic!("expected Bitbucket error, got {other:?}"),
        }
    }

    #[test]
    fn http_error_typed_envelope_message_parses_exactly_as_before() {
        // Regression guard for the `detail`-over-`message` preference above: the typed
        // envelope (top-level "type" + error.message, no detail) still surfaces
        // `message` verbatim.
        let body = r#"{"type":"error","error":{"message":"Repository not found"}}"#;
        match http_error(404, body) {
            AppError::Bitbucket(m) => {
                assert!(m.contains("Repository not found"));
            }
            other => panic!("expected Bitbucket error, got {other:?}"),
        }
    }

    #[test]
    fn http_error_falls_back_to_plain_text_body() {
        match http_error(500, "upstream boom") {
            AppError::Bitbucket(m) => {
                assert!(m.contains("500"));
                assert!(m.contains("upstream boom"));
            }
            other => panic!("expected Bitbucket error, got {other:?}"),
        }
    }

    #[test]
    fn http_error_403_privilege_scopes_names_the_missing_scope() {
        let body = r#"{"type":"error","error":{"message":"Your credentials lack one or more required privilege scopes."}}"#;
        match http_error(403, body) {
            AppError::Bitbucket(m) => {
                assert!(m.contains("403"));
                assert!(m.to_lowercase().contains("scope"));
            }
            other => panic!("expected Bitbucket error, got {other:?}"),
        }
    }

    #[test]
    fn http_error_other_403_falls_through_to_envelope_message() {
        // A 403 that is NOT a missing-scope error keeps the API's own message.
        let body =
            r#"{"type":"error","error":{"message":"You do not have access to this repository."}}"#;
        match http_error(403, body) {
            AppError::Bitbucket(m) => {
                assert!(m.contains("access to this repository"));
                assert!(!m.to_lowercase().contains("required write scope"));
            }
            other => panic!("expected Bitbucket error, got {other:?}"),
        }
    }

    /// Canary for the frontend's transport markers: `error-summary.ts` matches these
    /// literals in Bitbucket and Jira errors (pinned by scripts/error-summary.test.mjs),
    /// so a reworded suffix here must change both sides together.
    #[test]
    fn transport_cause_literals_still_match_the_frontend_markers() {
        assert_eq!(TRANSPORT_TIMED_OUT, "request timed out");
        assert_eq!(TRANSPORT_CONNECT_FAILED, "connection failed");
    }

    #[tokio::test]
    async fn a_refused_connection_carries_the_connect_marker() {
        // A just-released ephemeral port refuses the connection.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let error = Client::new()
            .get(format!("http://127.0.0.1:{port}/fixture"))
            .send()
            .await
            .unwrap_err();
        let message = transport_failure_message("Bitbucket request failed", &error);
        assert!(
            message.starts_with("Bitbucket request failed: "),
            "{message}"
        );
        assert!(message.ends_with(": connection failed"), "{message}");
        // SYNTHETIC: a refused send supplies is_connect at the body-error seam.
        let message = bb_body_read_error(error).to_string();
        assert!(message.ends_with(": connection failed"), "{message}");
    }

    #[tokio::test]
    async fn a_request_past_its_deadline_carries_the_timeout_marker() {
        // Accepts the connection and never answers, so only the deadline ends it.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/fixture", listener.local_addr().unwrap());
        let client = Client::builder()
            .timeout(Duration::from_millis(200))
            .build()
            .unwrap();
        let error = client.get(url).send().await.unwrap_err();
        drop(listener);
        let message = transport_failure_message("Jira request failed", &error);
        assert!(message.ends_with(": request timed out"), "{message}");
        assert!(!message.contains(TRANSPORT_CONNECT_FAILED), "{message}");
    }

    #[test]
    fn http_error_special_cases_401_and_429() {
        match http_error(401, "") {
            AppError::Bitbucket(m) => assert!(m.contains("token") && m.contains("401")),
            other => panic!("expected Bitbucket error, got {other:?}"),
        }
        match http_error(429, "") {
            AppError::Bitbucket(m) => assert!(m.to_lowercase().contains("rate limit")),
            other => panic!("expected Bitbucket error, got {other:?}"),
        }
    }
}
