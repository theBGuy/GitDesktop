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

/// Load the stored credentials — from the process cache when warm, else the OS
/// keyring (blocking reads run on a blocking thread), caching the result.
/// `BitbucketNotConfigured` when no token is stored — the signal the read commands
/// turn into the "connect an account" state.
pub async fn load_credentials() -> AppResult<BbCredentials> {
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
    match (email, token) {
        (Some(email), Some(token)) if !email.is_empty() && !token.is_empty() => {
            let creds = BbCredentials { email, token };
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
        _ => Err(AppError::BitbucketNotConfigured),
    }
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

/// Turn a non-2xx response body + status into an [`AppError::Bitbucket`], with the
/// 401/429 special-casing the provider contract requires. `body` is raw response text
/// (it may echo request context but never our credentials, which live only in the
/// request header). Exposed to the provider so a caller that inspects the status
/// itself (e.g. [`bb_get_text_status`]) produces the identical error for statuses it
/// doesn't special-case.
pub(crate) fn http_error(status: u16, body: &str) -> AppError {
    // Prefer the API's own message when the body is the JSON error envelope.
    let api_msg = serde_json::from_str::<BbErrorEnvelope>(body)
        .ok()
        .and_then(|e| e.error)
        .map(BbErrorBody::best_message)
        .filter(|m| !m.trim().is_empty());
    match status {
        401 => AppError::Bitbucket(
            "Bitbucket rejected the request (401) — your API token may be expired or \
             revoked. Reconnect it in Settings → Accounts."
                .into(),
        ),
        429 => AppError::Bitbucket(
            "Bitbucket rate limit reached (429). Wait a moment and try again.".into(),
        ),
        // A 403 whose body names Bitbucket's "privilege scopes" is a missing-write-scope
        // token (a bad token is a 401); other 403s fall through to the envelope message.
        403 if body.contains("privilege scopes") => AppError::Bitbucket(
            "Bitbucket rejected the request (403) — your API token is missing a required \
             write scope. Reconnect it in Settings → Accounts with pull request / \
             repository / pipeline write scopes."
                .into(),
        ),
        _ => {
            let detail = api_msg.unwrap_or_else(|| {
                let trimmed = body.trim();
                if trimmed.is_empty() {
                    format!("HTTP {status}")
                } else {
                    // Plain-text (non-envelope) body — keep it short.
                    let snippet: String = trimmed.chars().take(300).collect();
                    format!("HTTP {status}: {snippet}")
                }
            });
            AppError::Bitbucket(detail)
        }
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
    let url = resolve_url(path_or_url);
    let resp = client()
        .get(&url)
        .basic_auth(&creds.email, Some(&creds.token))
        .send()
        .await
        .map_err(|e| AppError::Bitbucket(format!("Bitbucket request failed: {e}")))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Bitbucket(format!("could not read Bitbucket response: {e}")))?;
    Ok((status, body))
}

/// GET a Bitbucket endpoint and return the raw response body as text, following
/// redirects (the default policy — see [`CLIENT`]). Non-2xx → [`http_error`]. Used
/// for the PR `/diff` (raw unified diff) and step logs (raw octet-stream).
pub async fn bb_get_text(creds: &BbCredentials, path_or_url: &str) -> AppResult<String> {
    let (status, body) = bb_get_text_status(creds, path_or_url).await?;
    if !(200..300).contains(&status) {
        return Err(http_error(status, &body));
    }
    Ok(body)
}

/// GET a Bitbucket endpoint expecting JSON, deserializing into `T` (HTTP Basic,
/// `Accept: application/json`, default redirect policy). Non-2xx → [`http_error`]; a
/// 2xx body that won't parse → `Bitbucket("could not parse …")` carrying the serde
/// error.
pub async fn bb_get_json<T: serde::de::DeserializeOwned>(
    creds: &BbCredentials,
    path_or_url: &str,
    what: &str,
) -> AppResult<T> {
    let url = resolve_url(path_or_url);
    let resp = client()
        .get(&url)
        .basic_auth(&creds.email, Some(&creds.token))
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| AppError::Bitbucket(format!("Bitbucket request failed: {e}")))?;
    let status = resp.status().as_u16();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Bitbucket(format!("could not read Bitbucket response: {e}")))?;
    if !(200..300).contains(&status) {
        return Err(http_error(status, &body));
    }
    serde_json::from_str(&body)
        .map_err(|e| AppError::Bitbucket(format!("could not parse Bitbucket {what}: {e}")))
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
        .map_err(|e| AppError::Bitbucket(format!("Bitbucket request failed: {e}")))?;
    let status = resp.status().as_u16();
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Bitbucket(format!("could not read Bitbucket response: {e}")))?;
    Ok((status, location, body))
}

/// POST JSON to a Bitbucket endpoint and deserialize the 2xx body into `T`.
/// `Accept`/`Content-Type: application/json`, HTTP Basic auth. Non-2xx →
/// [`http_error`]; a parse failure of a 2xx body → `Bitbucket("could not parse …")`.
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
        .map_err(|e| AppError::Bitbucket(format!("could not parse Bitbucket {what}: {e}")))
}

/// PUT JSON to a Bitbucket endpoint and deserialize the 2xx body into `T`. Same shape
/// as [`bb_post_json`].
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
        .map_err(|e| AppError::Bitbucket(format!("could not parse Bitbucket {what}: {e}")))
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

#[cfg(test)]
mod tests {
    use super::*;

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
