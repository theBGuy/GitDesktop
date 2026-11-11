//! Images attached to GitHub bodies (`https://github.com/user-attachments/assets/<uuid>`,
//! or the same path on a `*.ghe.com` tenant), loaded with the user's GitHub CLI sign-in
//! and returned as bytes: in a private repository the webview, which has no GitHub
//! session, gets a 404 for them.
//!
//! The credential is the user's token, so the order is fixed: the URL grammar, the
//! provider and the pinned host are checked before the token is read, the token rides
//! exactly one request (hop 0, to the allowlisted URL), and it never reaches an error, a
//! log line, a `Debug` output or the returned value. Redirect hops (GitHub hands the
//! bytes off to S3) carry no credential and are re-validated like link previews' hops.
//! Bytes ship only after the byte cap, the magic-byte sniff and the dimension caps.

use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use tauri_plugin_http::reqwest::header::{HeaderValue, AUTHORIZATION, LOCATION};
use tauri_plugin_http::reqwest::{redirect, Client, ClientBuilder, RequestBuilder, Response, Url};
use tokio::sync::Semaphore;

use crate::attachments::{host_attaches, host_label, MAX_IMAGE_BYTES};
use crate::error::{AppError, AppResult};
use crate::git::diff::FileBytes;
use crate::github::runner::GhOutput;
use crate::image_sniff::{dimensions_within_caps, sniff_image};
use crate::link_preview::{guard_hop, next_hop, read_body_capped};

/// gh's default host: what an unpinned repo's calls serve, so the only host an
/// unpinned repo's token may reach.
const DEFAULT_HOST: &str = "github.com";
const ASSET_PATH: &str = "/user-attachments/assets/";
const GHE_SUFFIX: &str = ".ghe.com";

/// Bounds the hops of one fetch, whose per-request timeouts would otherwise stack.
const HOSTED_IMAGE_DEADLINE: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// One request may carry a 10 MiB body, so this is far looser than link previews'.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// `gh auth token` is local keyring work, so seconds already mean it is wedged; the
/// runner's stored-login probe uses the same bound for the same read.
const TOKEN_READ_TIMEOUT: Duration = Duration::from_secs(5);

/// Process-wide cap on fetches in flight. Taken after the pure checks and before the
/// token read, and held for the whole fetch: every body of a long thread asks at once,
/// and each fetch spawns gh and can hold a 10 MiB buffer.
const MAX_IN_FLIGHT: usize = 4;
static FETCH_SLOTS: Semaphore = Semaphore::const_new(MAX_IN_FLIGHT);

/// Process-wide cap on repo resolutions in flight (two git reads and, on a cold cache, a
/// stored-login probe each), which run before a fetch slot is taken. Separate from
/// [`FETCH_SLOTS`] so a resolution never holds a fetch's place.
const MAX_RESOLVING: usize = 4;
static RESOLVE_SLOTS: Semaphore = Semaphore::const_new(MAX_RESOLVING);

/// IPC result: exactly one field is `Some`. `bytes.base64` is `Some` only beside a
/// sniffed raster `mime` (never SVG, never unsniffed bytes).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedImage {
    pub bytes: Option<FileBytes>,
    pub unavailable: Option<HostedImageUnavailable>,
}

/// Why no bytes came back. A kind only: a message is a place a credential could leak,
/// and the frontend needs nothing more to pick its caption.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostedImageUnavailable {
    Refused,
    SignedOut,
    Missing,
    Failed,
}

impl HostedImage {
    fn bytes(bytes: FileBytes) -> Self {
        Self {
            bytes: Some(bytes),
            unavailable: None,
        }
    }

    fn unavailable(kind: HostedImageUnavailable) -> Self {
        Self {
            bytes: None,
            unavailable: Some(kind),
        }
    }
}

/// The user's token. No `Display`, a redacting `Debug`, and the field is private to this
/// module, whose only reader is [`hop_request`].
struct Credential(String);

impl std::fmt::Debug for Credential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Credential(<redacted>)")
    }
}

/// What one token read produced.
#[derive(Debug)]
enum TokenRead {
    Token(Credential),
    SignedOut,
    Failed,
}

/// Why the hop loop stopped without bytes. Its text never holds the credential: the
/// loop formats only fixed sentences and status codes into it.
#[derive(Debug)]
enum HopFailure {
    SignedOut,
    Missing,
    Failed(String),
}

impl std::fmt::Display for HopFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SignedOut => f.write_str("hosted image: not signed in"),
            Self::Missing => f.write_str("hosted image: not found"),
            Self::Failed(reason) => write!(f, "hosted image: {reason}"),
        }
    }
}

fn failed(reason: &str) -> HopFailure {
    HopFailure::Failed(reason.to_string())
}

// ---------------------------------------------------------------------------
// Pure checks
// ---------------------------------------------------------------------------

/// The URL's host when the WHOLE string is
/// `https://<github.com | label.ghe.com>/user-attachments/assets/<lowercase uuid>`, else
/// `None`. Hand-rolled to mirror the frontend's regex byte for byte (one shared fixture
/// table pins both): lowercase only, and no port, userinfo, query, fragment, escape,
/// whitespace, trailing slash or extra segment can match.
pub(crate) fn hosted_asset_host(url: &str) -> Option<&str> {
    let rest = url.strip_prefix("https://")?;
    let (host, path) = rest.split_at(rest.find('/')?);
    if host != DEFAULT_HOST && !is_ghe_tenant(host) {
        return None;
    }
    is_lowercase_uuid(path.strip_prefix(ASSET_PATH)?).then_some(host)
}

pub(crate) fn is_hosted_asset_url(url: &str) -> bool {
    hosted_asset_host(url).is_some()
}

/// One DNS label of 1-63 `[a-z0-9-]` that starts and ends alphanumeric, then `.ghe.com`.
fn is_ghe_tenant(host: &str) -> bool {
    let Some(label) = host.strip_suffix(GHE_SUFFIX) else {
        return false;
    };
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    let bytes = label.as_bytes();
    match (bytes.first(), bytes.last()) {
        (Some(&first), Some(&last)) => {
            bytes.len() <= 63
                && alnum(first)
                && alnum(last)
                && bytes.iter().all(|&b| alnum(b) || b == b'-')
        }
        _ => false,
    }
}

fn is_lowercase_uuid(s: &str) -> bool {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    let lower_hex = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
    let mut parts = s.split('-');
    GROUPS.iter().all(|&len| {
        parts
            .next()
            .is_some_and(|p| p.len() == len && p.bytes().all(lower_hex))
    }) && parts.next().is_none()
}

/// Whether a token may be aimed at `url_host`: the host gh holds a stored login for
/// (attach-capable, unported) when one is pinned, else gh's default host only.
fn pinned_host_verdict(pinned: Option<&str>, url_host: &str) -> bool {
    match pinned {
        None => url_host == DEFAULT_HOST,
        Some(pinned) => {
            !pinned.contains(':') && {
                let label = host_label(pinned);
                host_attaches(&label) && label == url_host
            }
        }
    }
}

/// A redirect target this loop may request: `https`, the default port (`:443` parses
/// away), and no userinfo. The private-network refusal is [`HopPermit::Public`]'s
/// second half.
fn redirect_target_ok(target: &Url) -> bool {
    target.scheme() == "https"
        && target.port().is_none()
        && target.username().is_empty()
        && target.password().is_none()
}

/// The check every redirect hop passes before it is requested.
#[derive(Debug, Clone, Copy)]
enum HopPermit {
    /// [`redirect_target_ok`], then [`guard_hop`]'s name and address blocklist.
    Public,
    /// Admits only `http://127.0.0.1`, for the loopback tests. A `cfg(test)` variant, so
    /// no runtime switch can select it.
    #[cfg(test)]
    Loopback,
}

impl HopPermit {
    async fn admit(self, target: &Url) -> Result<(), HopFailure> {
        match self {
            Self::Public => {
                if !redirect_target_ok(target) {
                    return Err(failed("redirect target refused"));
                }
                guard_hop(target)
                    .await
                    .map_err(|_| failed("redirect target refused"))
            }
            #[cfg(test)]
            Self::Loopback => {
                let ok = target.scheme() == "http"
                    && target.host_str() == Some("127.0.0.1")
                    && target.username().is_empty()
                    && target.password().is_none();
                ok.then_some(())
                    .ok_or_else(|| failed("redirect target refused"))
            }
        }
    }
}

/// Maps `gh auth token`'s result. A missing gh, a non-zero exit or an empty answer is
/// signed out; a timeout, an I/O error or bytes no header can carry is a failure.
fn token_read_from(result: AppResult<GhOutput>) -> TokenRead {
    let out = match result {
        Ok(out) => out,
        Err(AppError::GhNotFound) => return TokenRead::SignedOut,
        Err(_) => return TokenRead::Failed,
    };
    if out.code != 0 {
        return TokenRead::SignedOut;
    }
    let Ok(text) = String::from_utf8(out.stdout) else {
        return TokenRead::Failed;
    };
    let token = text.trim();
    if token.is_empty() {
        TokenRead::SignedOut
    } else if token.bytes().all(|b| b.is_ascii_graphic()) {
        TokenRead::Token(Credential(token.to_string()))
    } else {
        TokenRead::Failed
    }
}

/// The token gh would use for `host`, read per fetch (no memo), so a `gh auth switch`
/// applies to the next image and the secret lives for one request. SECURITY: stdout is
/// the token; it goes straight into a [`Credential`].
async fn read_gh_token(host: String) -> TokenRead {
    let args = ["auth", "token", "--hostname", host.as_str()];
    token_read_from(crate::github::runner::run_gh_raw(None, &args, TOKEN_READ_TIMEOUT).await)
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/// The fetch client's configuration: no credentials or cookie store of its own, and
/// redirect policy NONE so the loop clears every hop before it is requested and a hop
/// never inherits hop 0's header.
fn client_builder() -> ClientBuilder {
    Client::builder()
        .user_agent(concat!("GitDesktop/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .redirect(redirect::Policy::none())
}

/// `None` when the TLS backend is unavailable; never falls back to `Client::new()`,
/// whose default policy follows redirects.
static CLIENT: OnceLock<Option<Client>> = OnceLock::new();

fn client() -> Option<&'static Client> {
    CLIENT
        .get_or_init(|| client_builder().build().ok())
        .as_ref()
}

/// The ONE place the credential becomes a header: a sensitive `Authorization` value,
/// present only when `credential` is `Some`.
fn hop_request(
    client: &Client,
    url: Url,
    credential: Option<&Credential>,
) -> Result<RequestBuilder, HopFailure> {
    let request = client.get(url);
    let Some(credential) = credential else {
        return Ok(request);
    };
    let mut value = HeaderValue::from_str(&format!("token {}", credential.0))
        .map_err(|_| failed("the credential is not a header value"))?;
    value.set_sensitive(true);
    Ok(request.header(AUTHORIZATION, value))
}

/// GET `start` and follow at most three redirects by hand. The loop owns the credential
/// and takes it out for hop 0's request, so no later hop has one to attach; each later
/// hop passes `permit` first. Hop 0's 401 is signed out and its 404/410 missing; every
/// other non-2xx on any hop, 403 included (a rate limit must not read as a deleted
/// file), is a failure.
async fn fetch_hops(
    client: &Client,
    start: Url,
    credential: Credential,
    permit: HopPermit,
) -> Result<FileBytes, HopFailure> {
    let mut credential = Some(credential);
    let mut current = start;
    let mut hops = 0usize;
    loop {
        let resp = hop_request(client, current.clone(), credential.take().as_ref())?
            .send()
            .await
            .map_err(|_| failed("request failed"))?;
        let status = resp.status().as_u16();
        let location = resp
            .headers()
            .get(LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        if let Some(next) = next_hop(&current, status, location.as_deref(), hops)
            .map_err(|_| failed("redirect refused"))?
        {
            permit.admit(&next).await?;
            hops += 1;
            current = next;
            continue;
        }
        if (200..300).contains(&status) {
            return read_image(resp).await;
        }
        return Err(match (hops, status) {
            (0, 401) => HopFailure::SignedOut,
            (0, 404 | 410) => HopFailure::Missing,
            _ => HopFailure::Failed(format!("HTTP {status}")),
        });
    }
}

async fn fetch_within(
    client: &Client,
    start: Url,
    credential: Credential,
    permit: HopPermit,
    deadline: Duration,
) -> Result<FileBytes, HopFailure> {
    tokio::time::timeout(deadline, fetch_hops(client, start, credential, permit))
        .await
        .unwrap_or_else(|_| Err(failed("timed out")))
}

fn too_large() -> FileBytes {
    FileBytes {
        base64: None,
        mime: None,
        too_large: true,
        size: None,
    }
}

/// A declared length over the cap refuses without reading; otherwise the read itself is
/// capped, since a length can be absent or lie.
async fn read_image(resp: Response) -> Result<FileBytes, HopFailure> {
    if resp
        .content_length()
        .is_some_and(|len| len > MAX_IMAGE_BYTES as u64)
    {
        return Ok(too_large());
    }
    let (bytes, over_cap) = read_body_capped(resp, MAX_IMAGE_BYTES)
        .await
        .map_err(|_| failed("could not read the response"))?;
    if over_cap {
        return Ok(too_large());
    }
    Ok(classify(&bytes))
}

/// The sniffed type decides, never the response header: unsniffable bytes ship no
/// payload, and a raster past the dimension caps ships its type without the bytes.
fn classify(bytes: &[u8]) -> FileBytes {
    match sniff_image(bytes) {
        None => FileBytes {
            base64: None,
            mime: None,
            too_large: false,
            size: Some(bytes.len() as u64),
        },
        Some((mime, width, height)) if !dimensions_within_caps(width, height) => FileBytes {
            base64: None,
            mime: Some(mime.to_string()),
            too_large: true,
            size: None,
        },
        Some((mime, _, _)) => FileBytes {
            base64: Some(base64::engine::general_purpose::STANDARD.encode(bytes)),
            mime: Some(mime.to_string()),
            too_large: false,
            size: Some(bytes.len() as u64),
        },
    }
}

fn outcome(result: Result<FileBytes, HopFailure>) -> HostedImage {
    match result {
        Ok(bytes) => HostedImage::bytes(bytes),
        Err(HopFailure::SignedOut) => HostedImage::unavailable(HostedImageUnavailable::SignedOut),
        Err(HopFailure::Missing) => HostedImage::unavailable(HostedImageUnavailable::Missing),
        Err(HopFailure::Failed(_)) => HostedImage::unavailable(HostedImageUnavailable::Failed),
    }
}

/// The whole decision, with the repo facts, the client and the token reader injected so
/// tests can count reads. Order is the security contract: grammar, provider and pinned
/// host first (any miss is `refused`), then the client, then a fetch slot, then the
/// token, then the hops; `read_token` is never called before the slot.
async fn fetch_planned<F, Fut>(
    url: &str,
    is_github: bool,
    pinned: Option<&str>,
    client: Option<&Client>,
    read_token: F,
    permit: HopPermit,
    deadline: Duration,
) -> HostedImage
where
    F: FnOnce(&str) -> Fut,
    Fut: Future<Output = TokenRead>,
{
    let refused = HostedImage::unavailable(HostedImageUnavailable::Refused);
    let Some(url_host) = hosted_asset_host(url) else {
        return refused;
    };
    if !is_github || !pinned_host_verdict(pinned, url_host) {
        return refused;
    }
    let Ok(start) = Url::parse(url) else {
        return refused;
    };
    let Some(client) = client else {
        return HostedImage::unavailable(HostedImageUnavailable::Failed);
    };
    fetch_slotted(
        client,
        start,
        pinned.unwrap_or(DEFAULT_HOST),
        read_token,
        permit,
        deadline,
    )
    .await
}

/// Takes a fetch slot and holds it across the token read and every hop.
async fn fetch_slotted<F, Fut>(
    client: &Client,
    start: Url,
    host: &str,
    read_token: F,
    permit: HopPermit,
    deadline: Duration,
) -> HostedImage
where
    F: FnOnce(&str) -> Fut,
    Fut: Future<Output = TokenRead>,
{
    let Ok(_slot) = FETCH_SLOTS.acquire().await else {
        return HostedImage::unavailable(HostedImageUnavailable::Failed);
    };
    let credential = match read_token(host).await {
        TokenRead::Token(credential) => credential,
        TokenRead::SignedOut => return HostedImage::unavailable(HostedImageUnavailable::SignedOut),
        TokenRead::Failed => return HostedImage::unavailable(HostedImageUnavailable::Failed),
    };
    outcome(fetch_within(client, start, credential, permit, deadline).await)
}

/// Whether the repo is not KNOWN to be another forge, and the host gh holds a stored
/// login for. A non-repo path or a repo with no `origin` reads as (true, None), which
/// only ever aims the token at github.com.
async fn resolve_repo(repo_path: &str) -> (bool, Option<String>) {
    within_resolve_slot(resolve_repo_facts(repo_path)).await
}

/// Runs `facts` (not polled until then) under one of [`RESOLVE_SLOTS`]. A closed
/// semaphore reads as a non-GitHub repo, so the fetch is refused.
async fn within_resolve_slot<Fut>(facts: Fut) -> (bool, Option<String>)
where
    Fut: Future<Output = (bool, Option<String>)>,
{
    let Ok(_slot) = RESOLVE_SLOTS.acquire().await else {
        return (false, None);
    };
    facts.await
}

async fn resolve_repo_facts(repo_path: &str) -> (bool, Option<String>) {
    if crate::forge::detect_non_github(repo_path).await.is_some() {
        return (false, None);
    }
    (
        true,
        crate::github::runner::gh_host_for_repo(repo_path).await,
    )
}

/// Load one GitHub-hosted image for a body rendered from `repo_path`. Always `Ok`: every
/// refusal and failure is a typed [`HostedImageUnavailable`].
#[tauri::command]
pub async fn github_hosted_image(repo_path: String, url: String) -> AppResult<HostedImage> {
    // Grammar first, so a refused URL spawns no git or gh at all.
    if !is_hosted_asset_url(&url) {
        return Ok(HostedImage::unavailable(HostedImageUnavailable::Refused));
    }
    let (is_github, pinned) = resolve_repo(&repo_path).await;
    // Boxed: the invoke handler builds a command's future on the UI-thread stack.
    Ok(Box::pin(fetch_planned(
        &url,
        is_github,
        pinned.as_deref(),
        client(),
        |host: &str| read_gh_token(host.to_string()),
        HopPermit::Public,
        HOSTED_IMAGE_DEADLINE,
    ))
    .await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_sniff::{gif_fixture, png_fixture};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const T: &str = "c162f463-c831-4173-8a80-4197acc4a8ac";
    /// Deliberately not token-shaped: push protection flags token-shaped strings.
    const SENTINEL: &str = "gd-sentinel-credential-not-a-token";
    const SLOW: Duration = Duration::from_secs(20);

    fn asset(host: &str) -> String {
        format!("https://{host}/user-attachments/assets/{T}")
    }

    fn cred() -> Credential {
        Credential(SENTINEL.to_string())
    }

    fn wire(image: &HostedImage) -> serde_json::Value {
        serde_json::to_value(image).unwrap()
    }

    // -- shared fixture table (the frontend twin pins the same rows) ---------

    fn label(len: usize) -> String {
        "a".repeat(len)
    }

    /// Each uuid group one short and one long.
    fn uuid_group_variants() -> Vec<String> {
        let groups: Vec<&str> = T.split('-').collect();
        let mut out = Vec::new();
        for i in 0..groups.len() {
            for delta in [-1i32, 1] {
                let mut g: Vec<String> = groups.iter().map(|s| s.to_string()).collect();
                if delta < 0 {
                    g[i].pop();
                } else {
                    g[i].push('a');
                }
                out.push(format!(
                    "https://github.com/user-attachments/assets/{}",
                    g.join("-")
                ));
            }
        }
        out
    }

    fn yes_rows() -> Vec<String> {
        vec![
            asset("github.com"),
            asset("acme.ghe.com"),
            asset(&format!("{}.ghe.com", label(63))),
            asset("a-1.ghe.com"),
            asset("9.ghe.com"),
        ]
    }

    fn no_rows() -> Vec<String> {
        let cyrillic_i = char::from_u32(0x0456).unwrap();
        let mut rows = vec![
            format!("http://github.com/user-attachments/assets/{T}"),
            format!("{}?x=1", asset("github.com")),
            format!("{}#f", asset("github.com")),
            format!("{}/", asset("github.com")),
            asset("u@github.com"),
            asset("github.com:443"),
            asset("GitHub.com"),
            format!(
                "https://github.com/user-attachments/assets/{}",
                T.to_ascii_uppercase()
            ),
            format!("https://github.com/user-attachments/assets/../{T}"),
            format!("{}%20", asset("github.com")),
            asset("github.com.evil.com"),
            asset("ghe.com"),
            asset("a.b.ghe.com"),
            format!("https://github.com/o/r/assets/123/{T}"),
            asset("github.acme.com"),
            format!("//github.com/user-attachments/assets/{T}"),
            // Lookalikes and encodings.
            asset("github.com.evil.example"),
            asset("evilgithub.com"),
            asset("github.com@evil.example"),
            asset(&format!("g{cyrillic_i}thub.com")),
            asset("xn--gthub-n2e.com"),
            asset("github.com."),
            format!("https://Github.Com/User-Attachments/assets/{T}"),
            format!("https://github.com/user%2Dattachments/assets/{T}"),
            format!("https://github.com/user-attachments/assets/%2e%2e/{T}"),
            format!("https://github.com/user-attachments%2Fassets/{T}"),
            format!("https://github.com//user-attachments/assets/{T}"),
            format!("https://github.com/user-attachments//assets/{T}"),
            format!("https://github.com/user-attachments/assets/../../x/{T}"),
            format!("{}?raw=1", asset("github.com")),
            format!("{}#x", asset("github.com")),
            asset("github.com:8443"),
            asset("user:pw@github.com"),
            // Edge whitespace: the frontend trims before asking, Rust never does.
            format!(" {} ", asset("github.com")),
            // Label and uuid shape rows.
            asset("-acme.ghe.com"),
            asset("acme-.ghe.com"),
            asset(&format!("{}.ghe.com", label(64))),
            asset(".ghe.com"),
            format!("https://github.com/user-attachments/assets/g{}", &T[1..]),
        ];
        rows.extend(uuid_group_variants());
        rows
    }

    #[test]
    fn grammar_accepts_exactly_the_yes_rows() {
        for row in yes_rows() {
            assert!(is_hosted_asset_url(&row), "should accept {row}");
        }
        assert_eq!(hosted_asset_host(&asset("github.com")), Some("github.com"));
        assert_eq!(
            hosted_asset_host(&asset("acme.ghe.com")),
            Some("acme.ghe.com")
        );
    }

    #[test]
    fn allowlist_refuses_lookalikes_and_encodings() {
        let rows = no_rows();
        assert!(rows.len() >= 49, "fixture table shrank: {}", rows.len());
        for row in rows {
            assert!(!is_hosted_asset_url(&row), "should refuse {row:?}");
        }
    }

    #[test]
    fn pinned_host_verdict_admits_only_the_pinned_or_default_host() {
        assert!(pinned_host_verdict(None, "github.com"));
        assert!(pinned_host_verdict(Some("github.com"), "github.com"));
        assert!(pinned_host_verdict(Some("acme.ghe.com"), "acme.ghe.com"));
        assert!(!pinned_host_verdict(Some("acme.ghe.com"), "github.com"));
        assert!(!pinned_host_verdict(Some("github.com"), "acme.ghe.com"));
        assert!(!pinned_host_verdict(
            Some("github.acme.com"),
            "github.acme.com"
        ));
        assert!(!pinned_host_verdict(Some("x.ghe.com:8443"), "x.ghe.com"));
        assert!(!pinned_host_verdict(None, "acme.ghe.com"));
    }

    #[test]
    fn redirect_targets_are_refused_unless_https_default_port() {
        let ok = |s: &str| redirect_target_ok(&Url::parse(s).unwrap());
        assert!(!ok("http://bucket.example/x"));
        assert!(!ok("https://bucket.example:8443/x"));
        assert!(!ok("https://u@bucket.example/x"));
        assert!(!ok("https://u:pw@bucket.example/x"));
        assert!(ok("https://bucket.example:443/x"));
        assert!(ok("https://bucket.example/x"));

        let start = Url::parse(&asset("github.com")).unwrap();
        let rel = next_hop(&start, 302, Some("/s3"), 0).unwrap().unwrap();
        assert_eq!(rel.as_str(), "https://github.com/s3");
        let proto = next_hop(&start, 302, Some("//bucket.example/y"), 0)
            .unwrap()
            .unwrap();
        assert_eq!(proto.as_str(), "https://bucket.example/y");
        assert!(next_hop(&start, 302, Some("/s3"), 3).is_err());
    }

    #[tokio::test]
    async fn production_permit_refuses_loopback_literals() {
        for target in [
            "https://127.0.0.1/x",
            "https://[::1]/x",
            "https://10.0.0.1/x",
        ] {
            let url = Url::parse(target).unwrap();
            assert!(
                HopPermit::Public.admit(&url).await.is_err(),
                "admitted {target}"
            );
        }
    }

    /// Public IP literals (TEST-NET-3, outside `guard_hop`'s blocklist) clear `guard_hop`
    /// with no DNS, so these rows reach the scheme, port and userinfo rule alone.
    const PUBLIC_REFUSED: [&str; 4] = [
        "http://203.0.113.5/x",
        "https://203.0.113.5:8443/x",
        "https://u@203.0.113.5/x",
        "https://:pw@203.0.113.5/x",
    ];

    #[tokio::test]
    async fn production_permit_refuses_scheme_port_and_userinfo() {
        for target in PUBLIC_REFUSED {
            let url = Url::parse(target).unwrap();
            assert!(
                HopPermit::Public.admit(&url).await.is_err(),
                "admitted {target}"
            );
        }
        for target in ["https://203.0.113.5:443/x", "https://203.0.113.5/x"] {
            let url = Url::parse(target).unwrap();
            assert!(
                HopPermit::Public.admit(&url).await.is_ok(),
                "refused {target}"
            );
        }
    }

    #[test]
    fn hop_request_attaches_the_credential_only_when_given() {
        let client = test_client();
        let url = Url::parse(&asset("github.com")).unwrap();
        let credential = cred();
        let with = hop_request(&client, url.clone(), Some(&credential))
            .unwrap()
            .build()
            .unwrap();
        let header = with.headers().get(AUTHORIZATION).unwrap();
        assert_eq!(header.to_str().unwrap(), format!("token {SENTINEL}"));
        assert!(header.is_sensitive());
        let without = hop_request(&client, url, None).unwrap().build().unwrap();
        assert!(without.headers().get(AUTHORIZATION).is_none());
    }

    #[test]
    fn wire_shape_matches_the_contract() {
        let shown = HostedImage::bytes(FileBytes {
            base64: Some("AAAA".into()),
            mime: Some("image/png".into()),
            too_large: false,
            size: Some(3),
        });
        let text = serde_json::to_string(&shown).unwrap();
        assert_eq!(
            text,
            r#"{"bytes":{"base64":"AAAA","mime":"image/png","tooLarge":false,"size":3},"unavailable":null}"#
        );
        for (kind, spelled) in [
            (HostedImageUnavailable::Refused, "refused"),
            (HostedImageUnavailable::SignedOut, "signedOut"),
            (HostedImageUnavailable::Missing, "missing"),
            (HostedImageUnavailable::Failed, "failed"),
        ] {
            let text = serde_json::to_string(&HostedImage::unavailable(kind)).unwrap();
            assert_eq!(
                text,
                format!(r#"{{"bytes":null,"unavailable":"{spelled}"}}"#)
            );
            for banned in ["too_large", "unavailable_kind", "message"] {
                assert!(!text.contains(banned));
            }
        }
        assert!(!text.contains("too_large"));
    }

    #[test]
    fn credential_debug_is_redacted() {
        let shown = format!("{:?}", cred());
        assert_eq!(shown, "Credential(<redacted>)");
        assert!(!format!("{:?}", TokenRead::Token(cred())).contains(SENTINEL));
    }

    #[test]
    fn token_read_maps_every_gh_outcome() {
        let out = |code: i32, stdout: &[u8]| {
            Ok(GhOutput {
                stdout: stdout.to_vec(),
                stderr: String::new(),
                code,
            })
        };
        let token = format!("{SENTINEL}\n");
        assert!(matches!(
            token_read_from(out(0, token.as_bytes())),
            TokenRead::Token(Credential(t)) if t == SENTINEL
        ));
        assert!(matches!(
            token_read_from(out(1, token.as_bytes())),
            TokenRead::SignedOut
        ));
        assert!(matches!(
            token_read_from(out(0, b" \n")),
            TokenRead::SignedOut
        ));
        assert!(matches!(
            token_read_from(out(0, b"has space")),
            TokenRead::Failed
        ));
        assert!(matches!(
            token_read_from(out(0, &[0xff, 0xfe])),
            TokenRead::Failed
        ));
        assert!(matches!(
            token_read_from(Err(AppError::GhNotFound)),
            TokenRead::SignedOut
        ));
        assert!(matches!(
            token_read_from(Err(AppError::Timeout(5))),
            TokenRead::Failed
        ));
        assert!(matches!(
            token_read_from(Err(AppError::Io(std::io::Error::other("x")))),
            TokenRead::Failed
        ));
    }

    // -- planning (fetch_planned with a counting reader; never reaches the network) --

    /// A reader that counts calls, records the host it was asked for, and answers
    /// signed-out so no request is ever made.
    fn counting_reader(
        reads: Arc<AtomicUsize>,
        hosts: Arc<Mutex<Vec<String>>>,
    ) -> impl FnOnce(&str) -> std::future::Ready<TokenRead> {
        move |host: &str| {
            reads.fetch_add(1, Ordering::SeqCst);
            hosts.lock().unwrap().push(host.to_string());
            std::future::ready(TokenRead::SignedOut)
        }
    }

    async fn plan(
        url: &str,
        is_github: bool,
        pinned: Option<&str>,
    ) -> (HostedImage, usize, Vec<String>) {
        plan_with(url, is_github, pinned, Some(&test_client())).await
    }

    async fn plan_with(
        url: &str,
        is_github: bool,
        pinned: Option<&str>,
        client: Option<&Client>,
    ) -> (HostedImage, usize, Vec<String>) {
        let reads = Arc::new(AtomicUsize::new(0));
        let hosts = Arc::new(Mutex::new(Vec::new()));
        let image = fetch_planned(
            url,
            is_github,
            pinned,
            client,
            counting_reader(reads.clone(), hosts.clone()),
            HopPermit::Public,
            SLOW,
        )
        .await;
        let seen = hosts.lock().unwrap().clone();
        (image, reads.load(Ordering::SeqCst), seen)
    }

    fn refused() -> serde_json::Value {
        wire(&HostedImage::unavailable(HostedImageUnavailable::Refused))
    }

    #[tokio::test]
    async fn token_only_reaches_the_pinned_host() {
        // Every refusal arm: refused, Ok-shaped, and zero token reads.
        let refusals: [(String, bool, Option<&str>); 6] = [
            (
                format!("http://github.com/user-attachments/assets/{T}"),
                true,
                None,
            ),
            (asset("github.com"), false, None),
            (asset("github.com"), true, Some("acme.ghe.com")),
            (asset("acme.ghe.com"), true, None),
            (asset("acme.ghe.com"), true, Some("github.com")),
            (asset("x.ghe.com"), true, Some("x.ghe.com:8443")),
        ];
        for (url, is_github, pinned) in refusals {
            let (image, reads, _) = plan(&url, is_github, pinned).await;
            assert_eq!(wire(&image), refused(), "{url} {is_github} {pinned:?}");
            assert_eq!(reads, 0, "token read for {url} {pinned:?}");
        }
        // Admitted plans read the token for exactly the URL's host, once.
        let (image, reads, hosts) = plan(&asset("github.com"), true, None).await;
        assert_eq!(reads, 1);
        assert_eq!(hosts, ["github.com"]);
        assert_eq!(
            wire(&image),
            wire(&HostedImage::unavailable(HostedImageUnavailable::SignedOut))
        );
        let (_, reads, hosts) = plan(&asset("acme.ghe.com"), true, Some("acme.ghe.com")).await;
        assert_eq!(reads, 1);
        assert_eq!(hosts, ["acme.ghe.com"]);
    }

    #[tokio::test]
    async fn a_missing_client_fails_before_the_token_read() {
        let (image, reads, _) = plan_with(&asset("github.com"), true, None, None).await;
        assert_eq!(wire(&image), unavailable(HostedImageUnavailable::Failed));
        assert_eq!(reads, 0);
        // Refusals still outrank it.
        let (image, reads, _) = plan_with(&asset("acme.ghe.com"), true, None, None).await;
        assert_eq!((wire(&image), reads), (refused(), 0));
    }

    #[tokio::test]
    async fn a_failed_token_read_is_a_failure_not_a_sign_out() {
        let image = fetch_planned(
            &asset("github.com"),
            true,
            None,
            Some(&test_client()),
            |_: &str| std::future::ready(TokenRead::Failed),
            HopPermit::Public,
            SLOW,
        )
        .await;
        assert_eq!(
            wire(&image),
            wire(&HostedImage::unavailable(HostedImageUnavailable::Failed))
        );
    }

    #[tokio::test]
    async fn a_non_repo_path_or_a_repo_without_origin_pins_only_github_com() {
        // An enclosing repository would answer for these fixtures and run the real
        // stored-login probe, so a polluted temp root fails here, before any spawn.
        assert!(std::env::var_os("GIT_DIR").is_none());
        let temp_root = dunce::canonicalize(std::env::temp_dir()).unwrap();
        for ancestor in temp_root.ancestors() {
            assert!(
                !ancestor.join(".git").exists(),
                "temp root sits inside a repository at {}",
                ancestor.display()
            );
        }
        let missing = std::env::temp_dir().join("gd-hosted-image-test-does-not-exist-9f2c");
        assert!(!missing.exists());
        assert_eq!(resolve_repo(&missing.to_string_lossy()).await, (true, None));

        let plain = tempfile::Builder::new()
            .prefix("gd-hosted-image-test-plain-")
            .tempdir()
            .unwrap();
        assert_eq!(
            resolve_repo(&plain.path().to_string_lossy()).await,
            (true, None)
        );

        let repo = tempfile::Builder::new()
            .prefix("gd-hosted-image-test-noorigin-")
            .tempdir()
            .unwrap();
        let repo_s = repo.path().to_string_lossy().into_owned();
        crate::git::runner::run_git(
            Some(&repo_s),
            &["init", "-q"],
            crate::git::runner::DEFAULT_TIMEOUT,
        )
        .await
        .unwrap();
        let (is_github, pinned) = resolve_repo(&repo_s).await;
        assert_eq!((is_github, pinned.as_deref()), (true, None));
        // So the token may reach github.com and no other host.
        let (_, reads, hosts) = plan(&asset("github.com"), is_github, pinned.as_deref()).await;
        assert_eq!((reads, hosts), (1, vec!["github.com".to_string()]));
        let (image, reads, _) = plan(&asset("acme.ghe.com"), is_github, pinned.as_deref()).await;
        assert_eq!((wire(&image), reads), (refused(), 0));
    }

    #[tokio::test]
    async fn fetches_hold_one_of_four_process_wide_slots() {
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..9 {
            let (live, peak) = (live.clone(), peak.clone());
            tasks.push(tokio::spawn(async move {
                fetch_planned(
                    &asset("github.com"),
                    true,
                    None,
                    Some(&test_client()),
                    move |_: &str| async move {
                        let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(150)).await;
                        live.fetch_sub(1, Ordering::SeqCst);
                        TokenRead::SignedOut
                    },
                    HopPermit::Public,
                    SLOW,
                )
                .await
            }));
        }
        for task in tasks {
            assert_eq!(
                wire(&task.await.unwrap()),
                wire(&HostedImage::unavailable(HostedImageUnavailable::SignedOut))
            );
        }
        let peak = peak.load(Ordering::SeqCst);
        assert!(peak <= MAX_IN_FLIGHT, "peak {peak}");
        assert!(peak >= 2, "fetches were serialized: peak {peak}");
    }

    #[tokio::test]
    async fn repo_resolutions_hold_one_of_four_process_wide_slots() {
        let live = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..9 {
            let (live, peak) = (live.clone(), peak.clone());
            tasks.push(tokio::spawn(within_resolve_slot(async move {
                let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(150)).await;
                live.fetch_sub(1, Ordering::SeqCst);
                (true, None)
            })));
        }
        for task in tasks {
            assert_eq!(task.await.unwrap(), (true, None));
        }
        let peak = peak.load(Ordering::SeqCst);
        assert!(peak <= MAX_RESOLVING, "peak {peak}");
        assert!(peak >= 2, "resolutions were serialized: peak {peak}");
    }

    // -- loopback server -------------------------------------------------------

    enum Reply {
        /// Written whole, then the connection closes.
        Full(Vec<u8>),
        /// Written, then the connection is held open with nothing more sent.
        Stall(Vec<u8>),
    }

    struct Loopback {
        base: String,
        heads: Arc<Mutex<Vec<String>>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Loopback {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    impl Loopback {
        fn heads(&self) -> Vec<String> {
            self.heads.lock().unwrap().clone()
        }
    }

    /// Answers each accepted connection with the next scripted reply, recording the raw
    /// request head the server received; past the script it answers 500.
    async fn serve(script: impl FnOnce(&str) -> Vec<Reply>) -> Loopback {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let replies = script(&base);
        let heads = Arc::new(Mutex::new(Vec::new()));
        let seen = heads.clone();
        let task = tokio::spawn(async move {
            let mut replies = replies.into_iter();
            let mut held = Vec::new();
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut head = Vec::new();
                let mut byte = [0u8];
                while !head.ends_with(b"\r\n\r\n") {
                    if stream.read_exact(&mut byte).await.is_err() {
                        break;
                    }
                    head.push(byte[0]);
                }
                seen.lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&head).into_owned());
                match replies.next() {
                    Some(Reply::Full(bytes)) => {
                        let _ = stream.write_all(&bytes).await;
                        let _ = stream.shutdown().await;
                    }
                    Some(Reply::Stall(bytes)) => {
                        let _ = stream.write_all(&bytes).await;
                        held.push(stream);
                    }
                    None => {
                        let _ = stream
                            .write_all(
                                b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            )
                            .await;
                    }
                }
            }
        });
        Loopback { base, heads, task }
    }

    fn reply(status: &str, headers: &str, body: &[u8]) -> Reply {
        let mut bytes = format!(
            "HTTP/1.1 {status}\r\nConnection: close\r\n{headers}Content-Length: {}\r\n\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(body);
        Reply::Full(bytes)
    }

    fn ok(body: &[u8]) -> Reply {
        reply("200 OK", "", body)
    }

    fn status(line: &str) -> Reply {
        reply(line, "", b"")
    }

    fn redirect_to(location: &str) -> Reply {
        reply("302 Found", &format!("Location: {location}\r\n"), b"")
    }

    fn chunked(body: &[u8]) -> Reply {
        let mut bytes =
            b"HTTP/1.1 200 OK\r\nConnection: close\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        for chunk in body.chunks(64 * 1024) {
            bytes.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
            bytes.extend_from_slice(chunk);
            bytes.extend_from_slice(b"\r\n");
        }
        bytes.extend_from_slice(b"0\r\n\r\n");
        Reply::Full(bytes)
    }

    fn test_client() -> Client {
        client_builder().no_proxy().build().unwrap()
    }

    async fn fetch_from(server: &Loopback, deadline: Duration) -> Result<FileBytes, HopFailure> {
        let start = Url::parse(&format!("{}/asset", server.base)).unwrap();
        fetch_within(&test_client(), start, cred(), HopPermit::Loopback, deadline).await
    }

    async fn run(script: impl FnOnce(&str) -> Vec<Reply>) -> (HostedImage, Loopback) {
        let server = serve(script).await;
        let image = outcome(fetch_from(&server, SLOW).await);
        (image, server)
    }

    fn has_auth(head: &str) -> bool {
        head.to_ascii_lowercase().contains("\r\nauthorization:")
    }

    fn padded_png(len: usize) -> Vec<u8> {
        let mut bytes = png_fixture(10, 10);
        bytes.resize(len, 0);
        bytes
    }

    fn unavailable(kind: HostedImageUnavailable) -> serde_json::Value {
        wire(&HostedImage::unavailable(kind))
    }

    #[tokio::test]
    async fn production_client_does_not_follow_redirects() {
        let server = serve(|base| vec![redirect_to(&format!("{base}/next"))]).await;
        let resp = test_client()
            .get(format!("{}/asset", server.base))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status().as_u16(), 302);
        drop(resp);
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(server.heads().len(), 1);
    }

    #[tokio::test]
    async fn credential_rides_hop_zero_only() {
        let png = png_fixture(10, 10);
        let (image, server) = run(|_| vec![redirect_to("/s3"), ok(&png)]).await;
        let heads = server.heads();
        assert_eq!(heads.len(), 2);
        assert!(has_auth(&heads[0]));
        assert!(heads[0].contains(SENTINEL));
        assert!(!has_auth(&heads[1]));
        assert!(heads[1].starts_with("GET /s3 "));
        let bytes = image.bytes.unwrap();
        assert_eq!(bytes.mime.as_deref(), Some("image/png"));
        assert_eq!(
            bytes.base64.as_deref(),
            Some(
                base64::engine::general_purpose::STANDARD
                    .encode(&png)
                    .as_str()
            )
        );
    }

    #[tokio::test]
    async fn credential_is_absent_on_every_redirect_hop() {
        let png = png_fixture(10, 10);
        let (image, server) = run(|base| {
            vec![
                redirect_to("/one"),
                redirect_to(&format!("{base}/two")),
                redirect_to("/three"),
                ok(&png),
            ]
        })
        .await;
        let heads = server.heads();
        assert_eq!(heads.len(), 4);
        assert!(has_auth(&heads[0]));
        for head in &heads[1..] {
            assert!(!has_auth(head), "credential on a redirect hop: {head}");
            assert!(!head.contains(SENTINEL));
        }
        assert!(image.bytes.unwrap().base64.is_some());
    }

    #[tokio::test]
    async fn fourth_redirect_is_refused_after_exactly_four_requests() {
        let (image, server) = run(|_| {
            vec![
                redirect_to("/1"),
                redirect_to("/2"),
                redirect_to("/3"),
                redirect_to("/4"),
            ]
        })
        .await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(server.heads().len(), 4);
        assert_eq!(wire(&image), unavailable(HostedImageUnavailable::Failed));
    }

    #[tokio::test]
    async fn a_refused_redirect_target_is_never_requested() {
        // The same server under a spelling the permit refuses, so an admitted target
        // would land a second request here.
        let (image, server) = run(|base| {
            vec![redirect_to(&format!(
                "{}/x",
                base.replacen("http://", "http://u@", 1)
            ))]
        })
        .await;
        assert_eq!(server.heads().len(), 1);
        assert_eq!(wire(&image), unavailable(HostedImageUnavailable::Failed));
    }

    #[tokio::test]
    async fn the_fetch_slot_is_held_across_every_hop() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let start =
            Url::parse(&format!("http://{}/asset", listener.local_addr().unwrap())).unwrap();
        let open = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (open_s, peak_s) = (open.clone(), peak.clone());
        // Holds each request open, counting the ones open at once; the count drops before
        // the reply so a finished fetch's successor is never counted beside it.
        let server = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let (open, peak) = (open_s.clone(), peak_s.clone());
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8];
                    while !head.ends_with(b"\r\n\r\n") {
                        if stream.read_exact(&mut byte).await.is_err() {
                            return;
                        }
                        head.push(byte[0]);
                    }
                    let now = open.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(150)).await;
                    open.fetch_sub(1, Ordering::SeqCst);
                    let _ = stream
                        .write_all(
                            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        )
                        .await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        let mut tasks = Vec::new();
        for _ in 0..9 {
            let start = start.clone();
            tasks.push(tokio::spawn(async move {
                let client = test_client();
                fetch_slotted(
                    &client,
                    start,
                    DEFAULT_HOST,
                    |_: &str| std::future::ready(TokenRead::Token(cred())),
                    HopPermit::Loopback,
                    SLOW,
                )
                .await
            }));
        }
        for task in tasks {
            assert_eq!(
                wire(&task.await.unwrap()),
                unavailable(HostedImageUnavailable::Missing)
            );
        }
        server.abort();
        let peak = peak.load(Ordering::SeqCst);
        assert!(peak <= MAX_IN_FLIGHT, "peak {peak}");
        assert!(peak >= 2, "fetches were serialized: peak {peak}");
    }

    #[tokio::test]
    async fn hop_statuses_map_to_their_kinds() {
        use HostedImageUnavailable::*;
        for (line, kind) in [
            ("401 Unauthorized", SignedOut),
            ("404 Not Found", Missing),
            ("410 Gone", Missing),
            ("403 Forbidden", Failed),
            ("500 Internal Server Error", Failed),
        ] {
            let (image, _server) = run(|_| vec![status(line)]).await;
            assert_eq!(wire(&image), unavailable(kind), "{line}");
        }
        for line in ["403 Forbidden", "404 Not Found", "401 Unauthorized"] {
            let (image, _server) = run(|_| vec![redirect_to("/s3"), status(line)]).await;
            assert_eq!(wire(&image), unavailable(Failed), "redirect target {line}");
        }
    }

    #[tokio::test]
    async fn body_rows_ship_only_capped_sniffed_rasters() {
        // Exactly the cap, a valid PNG: shown.
        let (image, _s) = run(|_| vec![ok(&padded_png(MAX_IMAGE_BYTES))]).await;
        let bytes = image.bytes.unwrap();
        assert!(bytes.base64.is_some());
        assert_eq!(bytes.size, Some(MAX_IMAGE_BYTES as u64));

        // One past the cap: too large, no payload, no size.
        let (image, _s) = run(|_| vec![ok(&padded_png(MAX_IMAGE_BYTES + 1))]).await;
        assert_eq!(
            wire(&image)["bytes"],
            serde_json::json!({"base64": null, "mime": null, "tooLarge": true, "size": null})
        );

        // Text: not an image.
        let (image, _s) = run(|_| vec![ok(b"hello, not an image")]).await;
        assert_eq!(
            wire(&image)["bytes"],
            serde_json::json!({"base64": null, "mime": null, "tooLarge": false, "size": 19})
        );

        // A raster past the dimension caps: its type, no payload.
        let (image, _s) = run(|_| vec![ok(&png_fixture(9000, 10))]).await;
        assert_eq!(
            wire(&image)["bytes"],
            serde_json::json!({"base64": null, "mime": "image/png", "tooLarge": true, "size": null})
        );

        // A small raster: shipped.
        let (image, _s) = run(|_| vec![ok(&png_fixture(10, 10))]).await;
        let bytes = image.bytes.unwrap();
        assert!(bytes.base64.is_some());
        assert_eq!(bytes.mime.as_deref(), Some("image/png"));
    }

    #[tokio::test]
    async fn a_declared_length_over_the_cap_refuses_without_reading() {
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_IMAGE_BYTES + 1
        );
        let server = serve(|_| vec![Reply::Stall(head.into_bytes())]).await;
        // A body read would stall until the deadline and come back `failed`.
        let image = outcome(fetch_from(&server, Duration::from_secs(3)).await);
        assert_eq!(
            wire(&image)["bytes"],
            serde_json::json!({"base64": null, "mime": null, "tooLarge": true, "size": null})
        );
    }

    #[tokio::test]
    async fn declared_png_that_sniffs_as_text_is_refused() {
        let html = b"<!doctype html><html><body>not an image</body></html>";
        let (image, _s) = run(|_| vec![reply("200 OK", "Content-Type: image/png\r\n", html)]).await;
        let bytes = image.bytes.unwrap();
        assert!(bytes.base64.is_none());
        assert!(bytes.mime.is_none());
        assert!(!bytes.too_large);

        let gif = gif_fixture(b"GIF89a", 10, 10);
        let (image, _s) = run(|_| vec![reply("200 OK", "Content-Type: image/png\r\n", &gif)]).await;
        let bytes = image.bytes.unwrap();
        assert!(bytes.base64.is_some());
        assert_eq!(bytes.mime.as_deref(), Some("image/gif"));
    }

    #[tokio::test]
    async fn cap_holds_on_a_chunked_body() {
        let body = padded_png(MAX_IMAGE_BYTES + 1);
        let (image, _s) = run(|_| vec![chunked(&body)]).await;
        let bytes = image.bytes.unwrap();
        assert!(bytes.too_large);
        assert!(bytes.base64.is_none());

        // The same framing under the cap still ships.
        let small = png_fixture(10, 10);
        let (image, _s) = run(|_| vec![chunked(&small)]).await;
        assert!(image.bytes.unwrap().base64.is_some());
    }

    #[tokio::test]
    async fn cap_holds_when_content_length_lies() {
        // A declared length under the real body can't be tested here: the transport
        // frames the body at the declared length. `cap_holds_on_a_chunked_body` owns the
        // streaming cap. Declares cap+1 and sends 10 bytes: too large, from the header
        // alone (a body read would stall to the deadline and come back `failed`).
        let mut short = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_IMAGE_BYTES + 1
        )
        .into_bytes();
        short.extend_from_slice(&[0u8; 10]);
        let server = serve(|_| vec![Reply::Stall(short)]).await;
        let image = outcome(fetch_from(&server, Duration::from_secs(3)).await);
        let bytes = image.bytes.unwrap();
        assert!(bytes.too_large);
        assert!(bytes.base64.is_none());
    }

    // -- leak checks -----------------------------------------------------------

    const LOG_NEEDLES: [&str; 6] = [
        "log::",
        "tracing::",
        "print!",
        "println!",
        "eprintln!",
        "dbg!",
    ];

    /// This file's text with LF line endings: a Windows checkout embeds it with CRLF, and
    /// the scans below match on `\n`.
    fn own_source() -> String {
        include_str!("hosted_image.rs").replace("\r\n", "\n")
    }

    /// The text before the test module, so this module's own needles are never scanned.
    fn production_half(source: &str) -> &str {
        let end = source
            .find("\nmod tests {")
            .expect("the test module marker is present");
        &source[..end]
    }

    /// Blanks `//` and `/* */` comments, keeping string and char literals intact.
    fn mask_comments(source: &str) -> String {
        let bytes = source.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];
            let next = bytes.get(i + 1).copied();
            if b == b'/' && next == Some(b'/') {
                while i < bytes.len() && bytes[i] != b'\n' {
                    out.push(b' ');
                    i += 1;
                }
            } else if b == b'/' && next == Some(b'*') {
                while i < bytes.len() && !(bytes[i] == b'*' && bytes.get(i + 1) == Some(&b'/')) {
                    out.push(if bytes[i] == b'\n' { b'\n' } else { b' ' });
                    i += 1;
                }
                out.extend_from_slice(b"  ");
                i += 2;
            } else if b == b'"' {
                out.push(b);
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    if bytes[i] == b'\\' {
                        out.push(bytes[i]);
                        i += 1;
                    }
                    if i < bytes.len() {
                        out.push(bytes[i]);
                        i += 1;
                    }
                }
                if i < bytes.len() {
                    out.push(b'"');
                    i += 1;
                }
            } else if b == b'\'' && bytes.get(i + 2) == Some(&b'\'') {
                out.extend_from_slice(&bytes[i..i + 3]);
                i += 3;
            } else {
                out.push(b);
                i += 1;
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    }

    fn log_sites(production: &str) -> Vec<&'static str> {
        let masked = mask_comments(production);
        LOG_NEEDLES
            .into_iter()
            .filter(|needle| masked.contains(needle))
            .collect()
    }

    fn leaks(text: &str) -> bool {
        text.contains(SENTINEL)
    }

    #[tokio::test]
    async fn sentinel_credential_never_leaks() {
        let mut texts: Vec<String> = Vec::new();
        let collect = |result: Result<FileBytes, HopFailure>, texts: &mut Vec<String>| {
            if let Err(e) = &result {
                texts.push(format!("{e}"));
                texts.push(format!("{e:?}"));
            }
            texts.push(serde_json::to_string(&outcome(result)).unwrap());
        };

        let stalled_head = b"HTTP/1.1 200 OK\r\nContent-Length: 64\r\n\r\n".to_vec();
        type Script = Box<dyn FnOnce(&str) -> Vec<Reply> + Send>;
        let scripts: Vec<(Script, Duration)> = vec![
            (Box::new(|_: &str| vec![status("401 Unauthorized")]), SLOW),
            (Box::new(|_: &str| vec![status("404 Not Found")]), SLOW),
            (
                Box::new(|_: &str| vec![status("500 Internal Server Error")]),
                SLOW,
            ),
            (
                Box::new(|_: &str| vec![redirect_to("http://198.51.100.7/x")]),
                SLOW,
            ),
            (
                Box::new(|_: &str| vec![redirect_to("https://127.0.0.1:8443/x")]),
                SLOW,
            ),
            (
                Box::new(|_: &str| {
                    vec![
                        redirect_to("/1"),
                        redirect_to("/2"),
                        redirect_to("/3"),
                        redirect_to("/4"),
                    ]
                }),
                SLOW,
            ),
            (
                Box::new(|_: &str| vec![chunked(&padded_png(MAX_IMAGE_BYTES + 1))]),
                SLOW,
            ),
            (Box::new(|_: &str| vec![ok(b"plain text")]), SLOW),
            (
                Box::new(move |_: &str| vec![Reply::Stall(stalled_head)]),
                Duration::from_secs(2),
            ),
        ];
        for (script, deadline) in scripts {
            let server = serve(script).await;
            collect(fetch_from(&server, deadline).await, &mut texts);
        }

        // Transport refusal: a port held bound but never listening, so no parallel test's
        // server can take it before the dial.
        let reserved = tokio::net::TcpSocket::new_v4().unwrap();
        reserved.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let port = reserved.local_addr().unwrap().port();
        let start = Url::parse(&format!("http://127.0.0.1:{port}/asset")).unwrap();
        collect(
            fetch_within(&test_client(), start, cred(), HopPermit::Loopback, SLOW).await,
            &mut texts,
        );
        drop(reserved);

        // The production permit's refusals, on IP literals so no DNS name is resolved.
        for target in PUBLIC_REFUSED {
            let err = HopPermit::Public
                .admit(&Url::parse(target).unwrap())
                .await
                .unwrap_err();
            texts.push(format!("{err}"));
            texts.push(format!("{err:?}"));
        }

        // The hop-0 request itself: the sensitive header debugs as hidden.
        let request = hop_request(
            &test_client(),
            Url::parse(&asset("github.com")).unwrap(),
            Some(&cred()),
        )
        .unwrap()
        .build()
        .unwrap();
        texts.push(format!("{request:?}"));
        texts.push(format!("{:?}", cred()));

        assert!(texts.len() >= 20, "arms went missing: {}", texts.len());
        for text in &texts {
            assert!(!leaks(text), "credential leaked: {text}");
        }

        // No logging in the production half of this module.
        let source = own_source();
        let production = production_half(&source);
        assert!(production.contains("fn fetch_planned"));
        assert_eq!(log_sites(production), Vec::<&str>::new());
        // Negative control: an injected log line is found.
        let mutant = format!("{production}\nfn x() {{ log::debug!(\"t\"); }}\n");
        assert_eq!(log_sites(&mutant), vec!["log::"]);
        let commented = format!("{production}\n// log::debug!(\"t\");\n");
        assert_eq!(log_sites(&commented), Vec::<&str>::new());
    }

    // -- source-shape pins (production wiring every test bypasses) -------------

    /// From `signature` to the first line closing at column 0.
    fn fn_body<'a>(source: &'a str, signature: &str) -> Option<&'a str> {
        let rest = &source[source.find(signature)?..];
        Some(&rest[..rest.find("\n}\n")?])
    }

    /// Every test builds its own client, so only this pins that the production one
    /// carries `client_builder()`'s no-redirect policy and no other builder exists.
    fn client_wiring_holds(production: &str) -> bool {
        let masked = mask_comments(production);
        fn_body(&masked, "fn client() ").is_some_and(|b| b.contains("client_builder()"))
            && fn_body(&masked, "fn client_builder() ")
                .is_some_and(|b| b.contains("Client::builder()"))
            && masked.matches("Client::builder").count() == 1
            && !masked.contains("Client::new")
            && !masked.contains("ClientBuilder::new")
    }

    /// The command's repo resolution runs under [`RESOLVE_SLOTS`]; the slot test drives
    /// `within_resolve_slot` alone.
    fn resolve_wiring_holds(production: &str) -> bool {
        let masked = mask_comments(production);
        fn_body(&masked, "async fn resolve_repo(")
            .is_some_and(|b| b.contains("within_resolve_slot(resolve_repo_facts(repo_path))"))
            && fn_body(&masked, "pub async fn github_hosted_image(").is_some_and(|b| {
                b.contains("resolve_repo(&repo_path)") && !b.contains("resolve_repo_facts")
            })
    }

    #[test]
    fn production_client_and_resolution_are_wired_through_their_guards() {
        let source = own_source();
        let production = production_half(&source);
        assert!(client_wiring_holds(production));
        assert!(resolve_wiring_holds(production));

        // In-memory controls: each rewiring is caught.
        let swap = |find: &str, repl: &str| {
            assert_eq!(production.matches(find).count(), 1, "anchor {find}");
            production.replacen(find, repl, 1)
        };
        assert!(!client_wiring_holds(&swap(
            ".get_or_init(|| client_builder().build().ok())",
            ".get_or_init(|| Client::builder().build().ok())"
        )));
        assert!(!client_wiring_holds(&format!(
            "{production}\nfn other() {{ let _ = Client::builder(); }}\n"
        )));
        assert!(!client_wiring_holds(&format!(
            "{production}\nfn other() {{ let _ = Client::new(); }}\n"
        )));
        assert!(!resolve_wiring_holds(&swap(
            "within_resolve_slot(resolve_repo_facts(repo_path)).await",
            "resolve_repo_facts(repo_path).await"
        )));
        assert!(!resolve_wiring_holds(&swap(
            "resolve_repo(&repo_path).await",
            "resolve_repo_facts(&repo_path).await"
        )));
    }
}
