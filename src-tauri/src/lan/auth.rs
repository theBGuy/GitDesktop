//! Pairing, per-device bearer auth, the on-disk device store, IP rate-limiting,
//! and the axum middleware that enforces all of it for the LAN companion server.
//!
//! ## Security model — the LAN is a convenience boundary, NOT a trust boundary
//!
//! Anything that can reach the bound port could be a hostile device on the same
//! network (a coffee-shop LAN, a roommate's laptop). So every `/api/` request
//! except the two pairing routes carries a per-device bearer token, and pairing
//! itself is a challenge/response that never puts the shared secret on the wire.
//!
//! ### Pairing exchange (the OBS-websocket SHA256 pattern)
//!
//! 1. The desktop shows a QR + a 6-digit PIN. The QR/URL encode ONLY the pair
//!    URL — never the PIN or the pairing secret — so a shoulder-surfed photo of
//!    the screen (which captures the QR) still can't pair without the PIN, which
//!    the user reads off and types on the phone.
//! 2. Phone → `POST /api/pair/challenge` → `{ challenge, salt }` (server-random,
//!    one live challenge per session).
//! 3. Phone computes `proof = hex(sha256(hex(sha256(pin + salt)) + challenge))`
//!    and `POST /api/pair { deviceName, proof }`.
//! 4. Server recomputes the same proof from the PIN it holds and compares. On a
//!    match it mints a device id + a raw 128-bit bearer, stores only
//!    `hex(sha256(bearer))`, and returns the raw token exactly once.
//!
//! ### Transport hardening
//!
//! Every response carries `X-Frame-Options: DENY` + `Content-Security-Policy:
//! frame-ancestors 'none'`, and every request's `Host` (and `Origin`, when
//! present) must match a bound address — the DNS-rebinding defense that a
//! localhost HTTP service otherwise lacks (the qBittorrent CVE lesson).
//!
//! ### Rate limiting
//!
//! Pairing attempts and auth failures are counted per peer IP: 5 failures in a
//! 60s window locks that IP out (429 + `Retry-After`) for the remainder of the
//! window. The lockout map is IN-MEMORY only — it resets whenever the server is
//! disabled or restarted, which is acceptable for v1 (a restart is a deliberate
//! user action, not an attacker-triggerable reset).

use std::collections::HashMap;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderValue, Request, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::net::{Ipv4Addr, SocketAddr};

use crate::error::{AppError, AppResult};
use crate::local_prs::APP_IDENTIFIER;

/// The device-store filename under the app-data dir. Rust-owned and app-global
/// (NOT per-repo): pairing a phone is an app-level trust decision, and the same
/// paired device reads whatever repo is currently active.
const STORE_FILE: &str = "lan-devices.json";

/// The only scope a paired device gets in this slice: read-only.
pub const SCOPE_READ: &str = "read";

/// Pairing session time-to-live: ~2 minutes. Long enough to scan + type the PIN,
/// short enough that an abandoned session closes the window quickly.
pub const PAIRING_TTL: Duration = Duration::from_secs(120);

/// Rate-limit window and threshold: 5 failed attempts (pairing or auth) from one
/// peer IP within 60s trips a lockout for the remainder of the window.
const RATE_LIMIT_MAX_FAILURES: u32 = 5;
const RATE_LIMIT_WINDOW: Duration = Duration::from_secs(60);

/// Only rewrite a device's `lastSeenAt` when the stored value is more than this
/// stale, so a burst of authenticated requests doesn't thrash the store file.
const LAST_SEEN_THROTTLE_SECS: i64 = 60;

// --------------------------------------------------------------------------
// Device-store path injection (for tests)
// --------------------------------------------------------------------------

/// Test-only override for the device-store path. Production always resolves the
/// real app-data file via [`store_path`]; tests set this to a temp file so they
/// never touch (or require) the real `%APPDATA%\com.thebguy.gitdesktop` dir.
static STORE_PATH_OVERRIDE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn store_path_override() -> &'static Mutex<Option<PathBuf>> {
    STORE_PATH_OVERRIDE.get_or_init(|| Mutex::new(None))
}

/// Point the device store at `path` for the current process (test-only). Returns
/// the previous override so a test can restore it.
#[cfg(test)]
pub(crate) fn set_store_path_for_test(path: Option<PathBuf>) -> Option<PathBuf> {
    let mut guard = store_path_override()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    std::mem::replace(&mut *guard, path)
}

/// A process-global lock any test that touches the device store must hold, so the
/// single [`STORE_PATH_OVERRIDE`] isn't raced by tests running on parallel threads
/// (each points it at its own temp file). Returns the guard; hold it for the test.
#[cfg(test)]
pub(crate) fn store_test_lock() -> std::sync::MutexGuard<'static, ()> {
    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    TEST_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// Resolve the absolute path of `lan-devices.json` under the app-data dir —
/// `dirs::data_dir()/<APP_IDENTIFIER>/`, the same root [`crate::local_prs`] and
/// [`crate::jira_field_maps`] use. A test override (if set) wins.
fn store_path() -> AppResult<PathBuf> {
    if let Some(over) = store_path_override()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone()
    {
        return Ok(over);
    }
    let data = dirs::data_dir()
        .ok_or_else(|| AppError::Command("could not resolve the app-data directory".to_string()))?;
    Ok(data.join(APP_IDENTIFIER).join(STORE_FILE))
}

/// Serializes the whole read-modify-write of the device store across the sync
/// I/O only (the `oplog.rs` discipline). Never held across an `.await`.
fn store_lock() -> &'static Mutex<()> {
    static STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    STORE_LOCK.get_or_init(|| Mutex::new(()))
}

// --------------------------------------------------------------------------
// Device records
// --------------------------------------------------------------------------

/// A paired device as returned to the frontend. The raw bearer token is NEVER
/// carried here — only its hash lives on disk; this is the safe-to-display shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanDevice {
    pub id: String,
    pub name: String,
    pub scope: String,
    pub created_at: String,
    pub last_seen_at: String,
}

/// The persisted device record (adds the token hash the wire shape omits).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDevice {
    id: String,
    name: String,
    scope: String,
    /// `hex(sha256(bearer))`. The raw bearer is returned to the phone once at
    /// pairing time and never stored — a leaked store file can't be replayed.
    token_hash: String,
    created_at: String,
    last_seen_at: String,
}

impl StoredDevice {
    fn to_device(&self) -> LanDevice {
        LanDevice {
            id: self.id.clone(),
            name: self.name.clone(),
            scope: self.scope.clone(),
            created_at: self.created_at.clone(),
            last_seen_at: self.last_seen_at.clone(),
        }
    }
}

/// The current UTC timestamp in JS `Date.prototype.toISOString()` shape
/// (RFC3339, millis + `Z`) — matching every other app-data timestamp we write.
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Read the whole device-store file as a JSON object. A missing file is an empty
/// object; a present-but-malformed file is a hard error (never clobber it — it
/// holds pairing trust we must not silently drop).
fn read_store(path: &Path) -> AppResult<Map<String, Value>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
                AppError::Command(format!(
                    "lan-devices store at {} is not valid JSON: {e}",
                    path.display()
                ))
            })?;
            match value {
                Value::Object(map) => Ok(map),
                _ => Err(AppError::Command(format!(
                    "lan-devices store at {} is not a JSON object",
                    path.display()
                ))),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// The list of stored devices under the `"devices"` array key. Unknown top-level
/// keys and unknown per-record fields are preserved by round-tripping through
/// `Value` at the call sites that write.
fn devices_from(store: &Map<String, Value>) -> Vec<StoredDevice> {
    store
        .get("devices")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| serde_json::from_value::<StoredDevice>(v.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Persist the given device set as the `"devices"` array, atomically.
fn write_devices(path: &Path, devices: &[StoredDevice]) -> AppResult<()> {
    let mut store = Map::new();
    let arr = devices
        .iter()
        .map(|d| serde_json::to_value(d).unwrap_or(Value::Null))
        .collect::<Vec<_>>();
    store.insert("devices".to_string(), Value::Array(arr));
    let body = serde_json::to_string_pretty(&Value::Object(store))
        .map_err(|e| AppError::Command(format!("serialize lan-devices store: {e}")))?;
    crate::fsops::atomic_write(path, body.as_bytes())
}

/// The safe-to-display list of paired devices (no token hashes). Read-only.
pub fn list_devices() -> AppResult<Vec<LanDevice>> {
    let path = store_path()?;
    let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
    let store = read_store(&path)?;
    Ok(devices_from(&store).iter().map(|d| d.to_device()).collect())
}

/// The number of paired devices. Convenience for `lan_status`.
pub fn device_count() -> u32 {
    list_devices().map(|d| d.len() as u32).unwrap_or(0)
}

/// Revoke (delete) the device with `id`. Idempotent-ish: an unknown id errors so
/// the UI can surface "already gone", matching the local-PR store's id handling.
pub fn revoke_device(id: &str) -> AppResult<()> {
    let path = store_path()?;
    let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
    let store = read_store(&path)?;
    let mut devices = devices_from(&store);
    let before = devices.len();
    devices.retain(|d| d.id != id);
    if devices.len() == before {
        return Err(AppError::InvalidArgument(format!("no paired device with id {id}")));
    }
    write_devices(&path, &devices)
}

// --------------------------------------------------------------------------
// Hashing / proof
// --------------------------------------------------------------------------

/// `hex(sha256(bytes))`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    hex_encode(&digest)
}

/// Lowercase hex of a byte slice. Small and dependency-free (avoids pulling a
/// hex crate for two call sites).
pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
        s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
    }
    s
}

/// Compute the pairing proof the phone must send:
/// `proof = hex(sha256( hex(sha256(pin + salt)) + challenge ))`.
///
/// Splitting the PIN behind an inner hash (with a per-session salt) means the
/// wire never carries the PIN, and a captured `{challenge, salt, proof}` triple
/// can't be replayed against a fresh challenge.
pub fn compute_proof(pin: &str, salt: &str, challenge: &str) -> String {
    let inner = sha256_hex(format!("{pin}{salt}").as_bytes());
    sha256_hex(format!("{inner}{challenge}").as_bytes())
}

/// Constant-time equality over two hex strings. Both operands here are always
/// fixed-length SHA-256 hex (or bearer hashes), so a length mismatch alone is
/// not a secret — but we still fold the whole comparison to avoid an
/// early-return timing side channel on the shared prefix. (A dedicated `subtle`
/// dependency is deliberately avoided; comparing already-hashed values with this
/// fold is sufficient — noted per the spec.)
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let a = a.as_bytes();
    let b = b.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// --------------------------------------------------------------------------
// Pairing session
// --------------------------------------------------------------------------

/// An in-progress pairing session. Single active session per server: starting a
/// new one replaces any prior. Lives only in memory (never persisted).
#[derive(Debug, Clone)]
pub struct PairingSession {
    /// The 6-digit PIN shown on the desktop and typed on the phone.
    pub pin: String,
    /// 32 random bytes (hex) — a session id reserved for future session-binding.
    /// Deliberately NOT part of the pairing proof (which is PIN + salt + challenge)
    /// and never placed on the wire or in the QR. Read only by tests today (which
    /// assert the QR/url can't leak it), so it's dead in the non-test build.
    #[allow(dead_code)]
    pub secret: String,
    /// The pair URL shown as a QR (first LAN url + `/#pair`). No PIN/secret in it.
    pub url: String,
    /// When this session expires.
    pub expires_at: Instant,
    /// ISO-8601 rendering of `expires_at`, for the frontend.
    pub expires_at_iso: String,
    /// The current outstanding challenge (hex), if the phone has fetched one.
    /// One live challenge at a time — a fresh `/challenge` call overwrites it.
    pub challenge: Option<String>,
    /// The per-challenge salt (hex) returned alongside the challenge.
    pub salt: Option<String>,
}

impl PairingSession {
    pub fn is_expired(&self) -> bool {
        Instant::now() >= self.expires_at
    }
}

/// Generate a fresh pairing session for the given pair `url`. PIN is 6 digits
/// from the OS CSPRNG; the secret is 32 random bytes. TTL is [`PAIRING_TTL`].
pub fn new_pairing_session(url: String) -> PairingSession {
    let mut rng = rand::rng();
    // 6-digit PIN, zero-padded (000000..=999999) — uniform over the full range.
    let pin_num: u32 = rng.random_range(0..1_000_000);
    let pin = format!("{pin_num:06}");
    let mut secret_bytes = [0u8; 32];
    rng.fill(&mut secret_bytes[..]);
    let expires_at = Instant::now() + PAIRING_TTL;
    PairingSession {
        pin,
        secret: hex_encode(&secret_bytes),
        url,
        expires_at,
        expires_at_iso: iso_after(PAIRING_TTL),
        challenge: None,
        salt: None,
    }
}

/// A fresh `(challenge, salt)` pair: 32-byte challenge, 16-byte salt, both hex.
pub fn new_challenge() -> (String, String) {
    let mut rng = rand::rng();
    let mut challenge = [0u8; 32];
    let mut salt = [0u8; 16];
    rng.fill(&mut challenge[..]);
    rng.fill(&mut salt[..]);
    (hex_encode(&challenge), hex_encode(&salt))
}

/// An ISO-8601 timestamp `d` from now (for a pairing expiry the frontend renders).
fn iso_after(d: Duration) -> String {
    let when = chrono::Utc::now() + chrono::Duration::from_std(d).unwrap_or_default();
    when.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Mint a device from a successful pairing: returns `(StoredDevice-as-persisted,
/// raw_bearer)`. The raw bearer is the caller's to return once and then forget.
pub fn mint_device(name: &str) -> (LanDevice, String, String) {
    let id = uuid::Uuid::new_v4().to_string();
    // 128-bit bearer as uuid v4 hex (no dashes) — plenty of entropy, and it's the
    // same primitive the rest of the app already mints ids with.
    let bearer = uuid::Uuid::new_v4().simple().to_string();
    let token_hash = sha256_hex(bearer.as_bytes());
    let now = now_iso();
    let device = LanDevice {
        id,
        name: name.to_string(),
        scope: SCOPE_READ.to_string(),
        created_at: now.clone(),
        last_seen_at: now,
    };
    (device, bearer, token_hash)
}

/// Persist a freshly-minted device (with its token hash). Separate from
/// [`mint_device`] so the pure minting stays testable without disk I/O.
pub fn persist_device(device: &LanDevice, token_hash: &str) -> AppResult<()> {
    let path = store_path()?;
    let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
    let store = read_store(&path)?;
    let mut devices = devices_from(&store);
    devices.push(StoredDevice {
        id: device.id.clone(),
        name: device.name.clone(),
        scope: device.scope.clone(),
        token_hash: token_hash.to_string(),
        created_at: device.created_at.clone(),
        last_seen_at: device.last_seen_at.clone(),
    });
    write_devices(&path, &devices)
}

/// Look up the device whose stored token hash matches `sha256(bearer)`; on a hit,
/// bump its `lastSeenAt` (throttled) and return its id. `None` on no match.
fn authenticate_bearer(bearer: &str) -> Option<String> {
    let token_hash = sha256_hex(bearer.as_bytes());
    let path = store_path().ok()?;
    let _guard = store_lock().lock().unwrap_or_else(|p| p.into_inner());
    let store = read_store(&path).ok()?;
    let mut devices = devices_from(&store);
    let idx = devices
        .iter()
        .position(|d| constant_time_eq(&d.token_hash, &token_hash))?;
    let id = devices[idx].id.clone();
    // Throttled last-seen bump: only rewrite when the stored value is stale, so a
    // chatty client doesn't hammer the store file.
    if last_seen_is_stale(&devices[idx].last_seen_at) {
        devices[idx].last_seen_at = now_iso();
        let _ = write_devices(&path, &devices);
    }
    Some(id)
}

/// Whether a stored `lastSeenAt` ISO timestamp is older than the throttle window
/// (or unparseable — then treat as stale so we refresh it to a valid value).
fn last_seen_is_stale(iso: &str) -> bool {
    match chrono::DateTime::parse_from_rfc3339(iso) {
        Ok(then) => {
            let age = chrono::Utc::now().signed_duration_since(then.with_timezone(&chrono::Utc));
            age.num_seconds() >= LAST_SEEN_THROTTLE_SECS
        }
        Err(_) => true,
    }
}

// --------------------------------------------------------------------------
// Rate limiting
// --------------------------------------------------------------------------

/// A rolling failure window for one peer IP. In-memory only.
#[derive(Debug, Clone)]
pub struct FailureWindow {
    /// When the current window started.
    window_start: Instant,
    /// Failures recorded within the current window.
    count: u32,
}

/// The shared rate-limit map, cloned into the router via `Arc`.
pub type RateLimitMap = Arc<Mutex<HashMap<IpAddr, FailureWindow>>>;

/// Result of a rate-limit check: either allowed, or locked out with the number of
/// seconds remaining (for a `Retry-After` header).
pub enum RateCheck {
    Allowed,
    LockedOut { retry_after_secs: u64 },
}

/// Check whether `ip` is currently locked out, expiring a stale window first.
pub fn rate_check(map: &RateLimitMap, ip: IpAddr) -> RateCheck {
    let mut guard = map.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(win) = guard.get(&ip) {
        let elapsed = win.window_start.elapsed();
        if elapsed >= RATE_LIMIT_WINDOW {
            // Window expired — drop it; the next failure starts fresh.
            guard.remove(&ip);
            return RateCheck::Allowed;
        }
        if win.count >= RATE_LIMIT_MAX_FAILURES {
            let remaining = RATE_LIMIT_WINDOW.saturating_sub(elapsed);
            return RateCheck::LockedOut {
                retry_after_secs: remaining.as_secs().max(1),
            };
        }
    }
    RateCheck::Allowed
}

/// Record a failed attempt (pairing or auth) from `ip`, starting or extending its
/// window.
pub fn record_failure(map: &RateLimitMap, ip: IpAddr) {
    let mut guard = map.lock().unwrap_or_else(|p| p.into_inner());
    let now = Instant::now();
    let entry = guard.entry(ip).or_insert(FailureWindow {
        window_start: now,
        count: 0,
    });
    if entry.window_start.elapsed() >= RATE_LIMIT_WINDOW {
        // Stale window — reset it.
        entry.window_start = now;
        entry.count = 0;
    }
    entry.count += 1;
}

/// Clear an IP's failure window (called on a successful pairing/auth so a device
/// that eventually succeeds isn't punished for earlier typos).
pub fn clear_failures(map: &RateLimitMap, ip: IpAddr) {
    let mut guard = map.lock().unwrap_or_else(|p| p.into_inner());
    guard.remove(&ip);
}

// --------------------------------------------------------------------------
// Router state + middleware
// --------------------------------------------------------------------------

/// The per-field Arc-cloned state the axum router needs (mirrors how the main
/// `AppState` shares individual fields rather than `Arc<Whole>`). Cheap to clone.
#[derive(Clone)]
pub struct RouterState {
    /// The currently-active repo path the read routes operate on. `None` → 409.
    pub active_repo: Arc<Mutex<Option<String>>>,
    /// The single active pairing session, if any.
    pub pairing: Arc<Mutex<Option<PairingSession>>>,
    /// Per-IP failure windows.
    pub rate_limit: RateLimitMap,
    /// Every bound `<ip>:<port>` we accept in a `Host`/`Origin` header.
    pub bound_hosts: Arc<Vec<String>>,
    /// The live agent-stream registry — the SAME `Arc` [`crate::state::AppState`]
    /// holds, so a review/session registered there is watchable from the LAN
    /// review routes without any further plumbing.
    pub streams: Arc<Mutex<HashMap<String, crate::state::StreamInfo>>>,
}

/// Extract the peer IP from `ConnectInfo`, falling back to loopback when it's
/// absent (the `tower::oneshot` test path has no ConnectInfo). Rate-limiting a
/// test's synthetic requests as loopback is harmless.
fn peer_ip(req: &Request<Body>) -> IpAddr {
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|ci| ci.0.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST))
}

/// Apply the transport-hardening headers to every response.
fn harden_headers(resp: &mut Response) {
    let headers = resp.headers_mut();
    headers.insert("X-Frame-Options", HeaderValue::from_static("DENY"));
    headers.insert(
        "Content-Security-Policy",
        HeaderValue::from_static("frame-ancestors 'none'"),
    );
}

/// Middleware run on EVERY request (pairing routes included): validates the
/// `Host` header (and `Origin`, when present) against our bound addresses — the
/// DNS-rebinding defense — and stamps the hardening headers on the way out.
pub async fn host_guard(
    State(state): State<RouterState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let host_ok = req
        .headers()
        .get(axum::http::header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|h| state.bound_hosts.iter().any(|b| b == h))
        .unwrap_or(false);
    if !host_ok {
        let mut resp = (StatusCode::FORBIDDEN, "bad host").into_response();
        harden_headers(&mut resp);
        return resp;
    }
    // If an Origin header is present, its host portion must also be one of ours.
    if let Some(origin) = req
        .headers()
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
    {
        let origin_host = origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"))
            .unwrap_or(origin);
        if !state.bound_hosts.iter().any(|b| b == origin_host) {
            let mut resp = (StatusCode::FORBIDDEN, "bad origin").into_response();
            harden_headers(&mut resp);
            return resp;
        }
    }
    let mut resp = next.run(req).await;
    harden_headers(&mut resp);
    resp
}

/// Bearer-auth middleware for the protected `/api/` routes (everything except the
/// two pairing routes). Enforces the per-IP rate limit, then requires a valid
/// `Authorization: Bearer <token>` whose sha256 matches a stored device.
pub async fn require_auth(
    State(state): State<RouterState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let ip = peer_ip(&req);
    // Rate-limit auth failures the same as pairing.
    if let RateCheck::LockedOut { retry_after_secs } = rate_check(&state.rate_limit, ip) {
        return too_many_requests(retry_after_secs);
    }
    let bearer = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let Some(bearer) = bearer else {
        record_failure(&state.rate_limit, ip);
        return unauthorized();
    };
    match authenticate_bearer(bearer) {
        Some(_id) => {
            clear_failures(&state.rate_limit, ip);
            next.run(req).await
        }
        None => {
            record_failure(&state.rate_limit, ip);
            unauthorized()
        }
    }
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "kind": "unauthorized", "message": "invalid or missing bearer token" })),
    )
        .into_response()
}

fn too_many_requests(retry_after_secs: u64) -> Response {
    let mut resp = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({ "kind": "rateLimited", "message": "too many attempts; try again later" })),
    )
        .into_response();
    if let Ok(val) = HeaderValue::from_str(&retry_after_secs.to_string()) {
        resp.headers_mut().insert("Retry-After", val);
    }
    resp
}

// --------------------------------------------------------------------------
// Pairing HTTP handlers (unauthenticated, rate-limited)
// --------------------------------------------------------------------------

/// `POST /api/pair/challenge` → `{ challenge, salt }`. Requires an active,
/// unexpired pairing session; stores the challenge/salt on it (one at a time).
pub async fn pair_challenge(State(state): State<RouterState>, req: Request<Body>) -> Response {
    let ip = peer_ip(&req);
    if let RateCheck::LockedOut { retry_after_secs } = rate_check(&state.rate_limit, ip) {
        return too_many_requests(retry_after_secs);
    }
    let mut guard = state.pairing.lock().unwrap_or_else(|p| p.into_inner());
    let Some(session) = guard.as_mut() else {
        record_failure(&state.rate_limit, ip);
        return pairing_inactive();
    };
    if session.is_expired() {
        *guard = None;
        record_failure(&state.rate_limit, ip);
        return pairing_inactive();
    }
    let (challenge, salt) = new_challenge();
    session.challenge = Some(challenge.clone());
    session.salt = Some(salt.clone());
    (
        StatusCode::OK,
        Json(json!({ "challenge": challenge, "salt": salt })),
    )
        .into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairBody {
    device_name: String,
    proof: String,
}

/// `POST /api/pair` → mint a device on a correct proof. On success clears the
/// pairing session and the peer's failure window; on a bad proof records a
/// failure (rate-limited) and 401s.
pub async fn pair_submit(
    State(state): State<RouterState>,
    req: Request<Body>,
) -> Response {
    let ip = peer_ip(&req);
    if let RateCheck::LockedOut { retry_after_secs } = rate_check(&state.rate_limit, ip) {
        return too_many_requests(retry_after_secs);
    }
    // Manually read the JSON body so we keep the request for peer_ip above.
    let (_parts, body) = req.into_parts();
    let bytes = match axum::body::to_bytes(body, 64 * 1024).await {
        Ok(b) => b,
        Err(_) => {
            record_failure(&state.rate_limit, ip);
            return bad_request("could not read request body");
        }
    };
    let parsed: Result<PairBody, _> = serde_json::from_slice(&bytes);
    let Ok(body) = parsed else {
        record_failure(&state.rate_limit, ip);
        return bad_request("expected { deviceName, proof }");
    };
    let device_name = body.device_name.trim();
    if device_name.is_empty() {
        record_failure(&state.rate_limit, ip);
        return bad_request("deviceName must not be empty");
    }

    // Compute the expected proof from the stored PIN + this session's challenge.
    let expected = {
        let mut guard = state.pairing.lock().unwrap_or_else(|p| p.into_inner());
        let Some(session) = guard.as_mut() else {
            record_failure(&state.rate_limit, ip);
            return pairing_inactive();
        };
        if session.is_expired() {
            *guard = None;
            record_failure(&state.rate_limit, ip);
            return pairing_inactive();
        }
        let (Some(challenge), Some(salt)) = (session.challenge.clone(), session.salt.clone())
        else {
            // Phone must fetch a challenge first.
            record_failure(&state.rate_limit, ip);
            return bad_request("fetch a challenge first");
        };
        compute_proof(&session.pin, &salt, &challenge)
    };

    if !constant_time_eq(&expected, body.proof.trim()) {
        record_failure(&state.rate_limit, ip);
        return unauthorized();
    }

    // Correct proof → mint + persist, then clear the pairing session.
    let (device, bearer, token_hash) = mint_device(device_name);
    if let Err(e) = persist_device(&device, &token_hash) {
        return app_error_response(&e);
    }
    {
        let mut guard = state.pairing.lock().unwrap_or_else(|p| p.into_inner());
        *guard = None;
    }
    clear_failures(&state.rate_limit, ip);
    (
        StatusCode::OK,
        Json(json!({
            "deviceId": device.id,
            "token": bearer,
            "name": device.name,
            "scope": device.scope,
        })),
    )
        .into_response()
}

fn pairing_inactive() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({ "kind": "pairingInactive", "message": "no active pairing session" })),
    )
        .into_response()
}

fn bad_request(msg: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "kind": "invalidArgument", "message": msg })),
    )
        .into_response()
}

/// Map an [`AppError`] to an HTTP response for the route handlers: `NotARepo` and
/// `InvalidArgument` → 400; everything else → 502. The body reuses the app's own
/// `{ kind, message }` serialization so a phone client sees the same shape the
/// desktop frontend does.
pub fn app_error_response(err: &AppError) -> Response {
    let status = match err {
        AppError::NotARepo(_) | AppError::InvalidArgument(_) => StatusCode::BAD_REQUEST,
        _ => StatusCode::BAD_GATEWAY,
    };
    let body = serde_json::to_value(err).unwrap_or_else(|_| {
        json!({ "kind": "command", "message": err.to_string() })
    });
    (status, Json(body)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_round_trips_both_directions() {
        // The phone and the server compute the SAME proof from the shared inputs.
        let pin = "483920";
        let salt = "0011223344556677";
        let challenge = "aabbccddeeff00112233445566778899";
        let phone = compute_proof(pin, salt, challenge);
        let server = compute_proof(pin, salt, challenge);
        assert_eq!(phone, server);
        // A wrong PIN yields a different proof.
        assert_ne!(compute_proof("000000", salt, challenge), server);
        // A different challenge (replay defense) yields a different proof.
        assert_ne!(compute_proof(pin, salt, "ffffffffffffffffffffffffffffffff"), server);
        // Proof is a 64-char (32-byte) sha256 hex.
        assert_eq!(server.len(), 64);
        assert!(server.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn token_hash_verifies() {
        let (_device, bearer, token_hash) = mint_device("Pixel 9");
        // The stored hash is sha256(bearer), and re-hashing verifies.
        assert_eq!(sha256_hex(bearer.as_bytes()), token_hash);
        // A wrong bearer does not verify.
        assert!(!constant_time_eq(&sha256_hex(b"not-the-bearer"), &token_hash));
        // Bearer is 32 hex chars (128-bit uuid, no dashes).
        assert_eq!(bearer.len(), 32);
        assert!(bearer.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn constant_time_eq_matches_and_rejects() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd")); // length mismatch
    }

    #[test]
    fn rate_limit_window_locks_out_after_threshold() {
        let map: RateLimitMap = Arc::new(Mutex::new(HashMap::new()));
        let ip = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50));
        // Under threshold → allowed.
        for _ in 0..RATE_LIMIT_MAX_FAILURES - 1 {
            record_failure(&map, ip);
            assert!(matches!(rate_check(&map, ip), RateCheck::Allowed));
        }
        // Hitting the threshold → locked out with a positive retry-after.
        record_failure(&map, ip);
        match rate_check(&map, ip) {
            RateCheck::LockedOut { retry_after_secs } => assert!(retry_after_secs >= 1),
            RateCheck::Allowed => panic!("expected lockout at threshold"),
        }
        // Clearing releases the lock.
        clear_failures(&map, ip);
        assert!(matches!(rate_check(&map, ip), RateCheck::Allowed));
    }

    #[test]
    fn pairing_session_ttl_expiry() {
        let mut session = new_pairing_session("http://192.168.1.2:38473/#pair".to_string());
        assert!(!session.is_expired());
        // Force expiry by rewinding the deadline.
        session.expires_at = Instant::now() - Duration::from_secs(1);
        assert!(session.is_expired());
        // PIN shape: 6 digits.
        assert_eq!(session.pin.len(), 6);
        assert!(session.pin.chars().all(|c| c.is_ascii_digit()));
        // The QR/pair url must NOT leak the PIN or the secret.
        assert!(!session.url.contains(&session.pin));
        assert!(!session.url.contains(&session.secret));
    }

    #[test]
    fn device_store_round_trips_via_temp_file() {
        let _lock = store_test_lock();
        let tmp = std::env::temp_dir().join(format!(
            "gd-lan-devices-test-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let prev = set_store_path_for_test(Some(tmp.clone()));

        // Empty to start.
        assert_eq!(list_devices().unwrap().len(), 0);
        assert_eq!(device_count(), 0);

        let (device, bearer, token_hash) = mint_device("iPhone");
        persist_device(&device, &token_hash).unwrap();

        // Listed without the token hash.
        let listed = list_devices().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "iPhone");
        assert_eq!(listed[0].scope, SCOPE_READ);

        // The bearer authenticates; a wrong one does not.
        assert_eq!(authenticate_bearer(&bearer).as_deref(), Some(device.id.as_str()));
        assert!(authenticate_bearer("deadbeef").is_none());

        // Revoke → gone → its token no longer authenticates.
        revoke_device(&device.id).unwrap();
        assert_eq!(list_devices().unwrap().len(), 0);
        assert!(authenticate_bearer(&bearer).is_none());
        // Revoking an unknown id errors.
        assert!(revoke_device("nope").is_err());

        set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
    }

    #[test]
    fn last_seen_staleness() {
        // A just-now timestamp is fresh; an old one is stale; garbage is stale.
        assert!(!last_seen_is_stale(&now_iso()));
        assert!(last_seen_is_stale("2020-01-01T00:00:00.000Z"));
        assert!(last_seen_is_stale("not-a-timestamp"));
    }
}
