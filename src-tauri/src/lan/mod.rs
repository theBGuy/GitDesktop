//! The LAN phone-companion server: an embedded, default-OFF axum HTTP server
//! inside the Tauri process that lets a paired phone read the desktop's active
//! repo over the LAN. API-only in this slice (the phone UI arrives in slice 2).
//!
//! Security is the gate — see [`auth`] for the full model. In short: the server
//! is off until [`lan_enable`]; every `/api/` request except pairing carries a
//! per-device bearer; pairing is a PIN-gated challenge/response; and the route
//! surface is a structural read-only allowlist.
//!
//! ## State ownership
//!
//! [`LanState`] is Tauri-managed. Like [`crate::state::AppState`] it hand-rolls
//! `Default` (its fields — a `Notify`-backed server handle, `Mutex`es — don't
//! derive). The axum router does NOT get `Arc<LanState>`; instead the individual
//! pieces it needs (active repo, pairing session, rate-limit map) are shared as
//! per-field `Arc`s, mirroring how `AppState` shares individual fields.

pub mod auth;
pub mod routes;
pub mod server;

use std::sync::{Arc, Mutex};

use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use auth::{LanDevice, PairingSession, RateLimitMap};
use server::ServerHandle;

/// The Tauri-managed state for the LAN companion.
pub struct LanState {
    /// The active repo path the read routes operate on. Shared (per-field `Arc`)
    /// with the router state so `lan_set_active_repo` updates it live.
    active_repo: Arc<Mutex<Option<String>>>,
    /// The running server handle (bound port + shutdown signal + task), or `None`
    /// when disabled. Guarded so enable/disable are serialized.
    running: Mutex<Option<RunningServer>>,
    /// The single active pairing session, shared with the router state.
    pairing: Arc<Mutex<Option<PairingSession>>>,
    /// Per-IP failure windows for rate-limiting, shared with the router state.
    rate_limit: RateLimitMap,
    /// Serializes the WHOLE enable/disable lifecycle transition (an async-aware
    /// `Mutex`, held across the bind/shutdown `.await`s). Without it, two
    /// concurrent `lan_enable`s could both observe "not running", both bind a
    /// listener, and race to store — leaking one bound socket. Holding this for
    /// the transition guarantees exactly one listener results. (The `running`
    /// `std::Mutex` above is only ever taken for short, non-async reads/writes;
    /// this is the coarse gate that makes the transition atomic.)
    lifecycle: tokio::sync::Mutex<()>,
}

/// The bits we track for a running server: its handle, the mode it was started
/// in, and the advertised urls (for `lan_status` without re-enumerating).
struct RunningServer {
    handle: ServerHandle,
    bind_lan: bool,
    urls: Vec<String>,
}

impl Default for LanState {
    fn default() -> Self {
        Self {
            active_repo: Arc::new(Mutex::new(None)),
            running: Mutex::new(None),
            pairing: Arc::new(Mutex::new(None)),
            rate_limit: Arc::new(Mutex::new(std::collections::HashMap::new())),
            lifecycle: tokio::sync::Mutex::new(()),
        }
    }
}

impl LanState {
    /// Build the current [`LanStatus`] snapshot.
    fn status(&self) -> LanStatus {
        let running = self.running.lock().unwrap_or_else(|p| p.into_inner());
        let pairing_active = {
            let mut guard = self.pairing.lock().unwrap_or_else(|p| p.into_inner());
            // Treat an expired session as inactive (and clear it lazily).
            match guard.as_ref() {
                Some(s) if s.is_expired() => {
                    *guard = None;
                    false
                }
                Some(_) => true,
                None => false,
            }
        };
        let active_repo = self
            .active_repo
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .clone();
        match running.as_ref() {
            Some(rs) => LanStatus {
                enabled: true,
                bind_lan: rs.bind_lan,
                port: Some(rs.handle.port),
                urls: rs.urls.clone(),
                active_repo,
                device_count: auth::device_count(),
                pairing_active,
            },
            None => LanStatus {
                enabled: false,
                bind_lan: false,
                port: None,
                urls: Vec::new(),
                active_repo,
                device_count: auth::device_count(),
                pairing_active,
            },
        }
    }
}

// --------------------------------------------------------------------------
// FROZEN command-contract response shapes
// --------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanStatus {
    pub enabled: bool,
    pub bind_lan: bool,
    pub port: Option<u16>,
    pub urls: Vec<String>,
    pub active_repo: Option<String>,
    pub device_count: u32,
    pub pairing_active: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanPairing {
    pub url: String,
    pub qr_svg: String,
    pub pin: String,
    pub expires_at: String,
}

// --------------------------------------------------------------------------
// Commands (thin wrappers over LanState methods)
// --------------------------------------------------------------------------

/// Current server + pairing + device status.
#[tauri::command]
pub fn lan_status(state: State<'_, LanState>) -> AppResult<LanStatus> {
    Ok(state.status())
}

/// Enable the server. `bind_lan` false → 127.0.0.1 (dev/preview); true →
/// 0.0.0.0 (LAN). Already-enabled with the SAME mode is a no-op returning current
/// status; a DIFFERENT mode restarts the listener. Reflects the new state on the
/// tray.
#[tauri::command]
pub async fn lan_enable(
    app: AppHandle,
    state: State<'_, LanState>,
    app_state: State<'_, crate::state::AppState>,
    bind_lan: bool,
) -> AppResult<LanStatus> {
    // Hold the lifecycle lock across the WHOLE transition so two concurrent
    // enables can't both bind (the TOCTOU that would leak a listener). Released
    // when `_lifecycle` drops at the end of the fn.
    let _lifecycle = state.lifecycle.lock().await;

    // Same-mode no-op / different-mode restart decision. Take what we need under
    // the (short, non-async) `running` lock, then drop it before awaiting the
    // (async) shutdown/start.
    let existing_mode = {
        let running = state.running.lock().unwrap_or_else(|p| p.into_inner());
        running.as_ref().map(|rs| rs.bind_lan)
    };
    if let Some(mode) = existing_mode {
        if mode == bind_lan {
            return Ok(state.status()); // already running in this mode
        }
        // Different mode → stop the old listener first.
        let old = {
            let mut running = state.running.lock().unwrap_or_else(|p| p.into_inner());
            running.take()
        };
        if let Some(rs) = old {
            rs.handle.shutdown().await;
        }
    }

    let (handle, urls, _hosts) = server::start(
        bind_lan,
        state.active_repo.clone(),
        state.pairing.clone(),
        state.rate_limit.clone(),
        // The SAME stream registry `AppState` owns — so a review/session running
        // there is enumerable + watchable over the LAN.
        app_state.streams_arc(),
    )
    .await?;
    {
        let mut running = state.running.lock().unwrap_or_else(|p| p.into_inner());
        *running = Some(RunningServer {
            handle,
            bind_lan,
            urls,
        });
    }
    // Keep the tray truthful about whether we're sharing.
    crate::tray::update_companion_indicator(&app, true);
    Ok(state.status())
}

/// Disable the server (graceful). Idempotent: disabling when already off is a
/// no-op. Reflects the new state on the tray.
#[tauri::command]
pub async fn lan_disable(app: AppHandle, state: State<'_, LanState>) -> AppResult<LanStatus> {
    // Serialize against enable/disable via the same lifecycle lock (so a disable
    // racing an enable can't tear down a listener the enable is mid-way through
    // storing). Released when `_lifecycle` drops.
    let _lifecycle = state.lifecycle.lock().await;
    let old = {
        let mut running = state.running.lock().unwrap_or_else(|p| p.into_inner());
        running.take()
    };
    if let Some(rs) = old {
        rs.handle.shutdown().await;
    }
    // Any in-flight pairing is meaningless once the server is down.
    {
        let mut pairing = state.pairing.lock().unwrap_or_else(|p| p.into_inner());
        *pairing = None;
    }
    crate::tray::update_companion_indicator(&app, false);
    Ok(state.status())
}

/// Point the read routes at `repo_path` (the desktop's currently-open repo).
#[tauri::command]
pub fn lan_set_active_repo(state: State<'_, LanState>, repo_path: String) -> AppResult<()> {
    let mut guard = state.active_repo.lock().unwrap_or_else(|p| p.into_inner());
    *guard = Some(repo_path);
    Ok(())
}

/// Start (or restart) a pairing session: a fresh 6-digit PIN + QR. The QR/url
/// encode ONLY the pair url — never the PIN or the secret. Errors if the server
/// isn't enabled (there's no url to pair against yet).
#[tauri::command]
pub fn lan_pairing_start(state: State<'_, LanState>) -> AppResult<LanPairing> {
    // The pair url is the FIRST advertised url + "/#pair".
    let first_url = {
        let running = state.running.lock().unwrap_or_else(|p| p.into_inner());
        running
            .as_ref()
            .and_then(|rs| rs.urls.first().cloned())
            .ok_or_else(|| {
                AppError::Command(
                    "enable the phone companion before starting pairing".to_string(),
                )
            })?
    };
    let pair_url = format!("{first_url}/#pair");
    let session = auth::new_pairing_session(pair_url.clone());
    // QR of the pair url (deliberately WITHOUT the PIN/secret — a shoulder-surfed
    // QR photo alone can't pair; the PIN is typed on the phone).
    let qr_svg = render_qr_svg(&pair_url)?;
    let pairing = LanPairing {
        url: session.url.clone(),
        qr_svg,
        pin: session.pin.clone(),
        expires_at: session.expires_at_iso.clone(),
    };
    {
        let mut guard = state.pairing.lock().unwrap_or_else(|p| p.into_inner());
        *guard = Some(session); // single active session — replaces any prior
    }
    Ok(pairing)
}

/// Cancel any active pairing session. Idempotent.
#[tauri::command]
pub fn lan_pairing_cancel(state: State<'_, LanState>) -> AppResult<()> {
    let mut guard = state.pairing.lock().unwrap_or_else(|p| p.into_inner());
    *guard = None;
    Ok(())
}

/// List paired devices (no token hashes).
#[tauri::command]
pub fn lan_devices_list(_state: State<'_, LanState>) -> AppResult<Vec<LanDevice>> {
    auth::list_devices()
}

/// Revoke a paired device by id. Its bearer token stops authenticating.
#[tauri::command]
pub fn lan_device_revoke(_state: State<'_, LanState>, device_id: String) -> AppResult<()> {
    auth::revoke_device(&device_id)
}

/// Render `data` as an SVG QR code (string). Uses medium error correction and a
/// quiet zone so a phone camera reads it reliably.
fn render_qr_svg(data: &str) -> AppResult<String> {
    use qrcode::render::svg;
    use qrcode::{EcLevel, QrCode};
    let code = QrCode::with_error_correction_level(data, EcLevel::M)
        .map_err(|e| AppError::Command(format!("could not build the pairing QR code: {e}")))?;
    let svg = code
        .render::<svg::Color>()
        .min_dimensions(200, 200)
        .quiet_zone(true)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build();
    Ok(svg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt; // for `oneshot`

    fn temp_store() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "gd-lan-router-test-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    /// A router wired to the given active repo + a fresh (empty) device store.
    /// Host allowlist is `testhost` so the `Host` header is deterministic.
    fn test_router(active: Option<String>) -> auth::RouterState {
        auth::RouterState {
            active_repo: Arc::new(Mutex::new(active)),
            pairing: Arc::new(Mutex::new(None)),
            rate_limit: Arc::new(Mutex::new(std::collections::HashMap::new())),
            bound_hosts: Arc::new(vec!["testhost".to_string()]),
            streams: Arc::new(Mutex::new(std::collections::HashMap::new())),
        }
    }

    fn get(path: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .header("host", "testhost")
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn unauthenticated_api_is_401() {
        let router = server::build_router(test_router(Some("C:/repo".to_string())));
        let resp = router.oneshot(get("/api/repo/status")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn review_routes_are_bearer_gated() {
        // The live-monitoring routes live under the same authed subtree as the git
        // routes, so an unauthenticated request 401s BEFORE reaching the handler —
        // for both the enumeration route and the WebSocket-upgrade route (an
        // upgrade is a plain GET until the handler accepts it, so `require_auth`
        // runs first). This is the middleware-layering guarantee the WS route
        // relies on for its no-approve/no-stdin read-only contract.
        let router = server::build_router(test_router(Some("C:/repo".to_string())));
        let list = router.clone().oneshot(get("/api/reviews")).await.unwrap();
        assert_eq!(list.status(), StatusCode::UNAUTHORIZED);
        let stream = router
            .oneshot(get("/api/reviews/whatever/stream"))
            .await
            .unwrap();
        assert_eq!(stream.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn review_routes_are_host_guarded() {
        // The outer host guard wraps the review routes too (DNS-rebind defense).
        let router = server::build_router(test_router(Some("C:/repo".to_string())));
        let req = Request::builder()
            .uri("/api/reviews")
            .header("host", "evil.example.com")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn bad_host_is_403() {
        let router = server::build_router(test_router(Some("C:/repo".to_string())));
        let req = Request::builder()
            .uri("/api/repo/status")
            .header("host", "evil.example.com")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn unknown_route_is_404() {
        let router = server::build_router(test_router(Some("C:/repo".to_string())));
        let resp = router.oneshot(get("/api/nope")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn hardening_headers_on_every_response() {
        let router = server::build_router(test_router(Some("C:/repo".to_string())));
        let resp = router.oneshot(get("/api/nope")).await.unwrap();
        assert_eq!(resp.headers().get("X-Frame-Options").unwrap(), "DENY");
        assert_eq!(
            resp.headers().get("Content-Security-Policy").unwrap(),
            "frame-ancestors 'none'"
        );
    }

    #[tokio::test]
    // The store-path override is a process global; this serialization guard keeps
    // parallel store-touching tests off each other's temp file. Held across the
    // in-memory `oneshot` awaits below — safe here (current-thread test runtime,
    // no contention that could deadlock), so the lint doesn't apply.
    #[allow(clippy::await_holding_lock)]
    async fn pairing_happy_path_mints_a_token_that_authenticates() {
        let _lock = auth::store_test_lock();
        let tmp = temp_store();
        let prev = auth::set_store_path_for_test(Some(tmp.clone()));

        // Seed an active pairing session so /challenge + /pair work.
        let session = auth::new_pairing_session("http://testhost/#pair".to_string());
        let pin = session.pin.clone();
        let state = test_router(Some("C:/repo".to_string()));
        *state.pairing.lock().unwrap() = Some(session);
        let router = server::build_router(state);

        // 1) Fetch a challenge.
        let chal_req = Request::builder()
            .uri("/api/pair/challenge")
            .method("POST")
            .header("host", "testhost")
            .body(Body::empty())
            .unwrap();
        let chal_resp = router.clone().oneshot(chal_req).await.unwrap();
        assert_eq!(chal_resp.status(), StatusCode::OK);
        let chal_bytes = axum::body::to_bytes(chal_resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let chal: serde_json::Value = serde_json::from_slice(&chal_bytes).unwrap();
        let challenge = chal["challenge"].as_str().unwrap().to_string();
        let salt = chal["salt"].as_str().unwrap().to_string();

        // 2) Submit the correct proof.
        let proof = auth::compute_proof(&pin, &salt, &challenge);
        let pair_body = serde_json::json!({ "deviceName": "Test Phone", "proof": proof });
        let pair_req = Request::builder()
            .uri("/api/pair")
            .method("POST")
            .header("host", "testhost")
            .header("content-type", "application/json")
            .body(Body::from(pair_body.to_string()))
            .unwrap();
        let pair_resp = router.clone().oneshot(pair_req).await.unwrap();
        assert_eq!(pair_resp.status(), StatusCode::OK);
        let pair_bytes = axum::body::to_bytes(pair_resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let minted: serde_json::Value = serde_json::from_slice(&pair_bytes).unwrap();
        let token = minted["token"].as_str().unwrap().to_string();
        let device_id = minted["deviceId"].as_str().unwrap().to_string();
        assert_eq!(minted["scope"], "read");

        // 3) The minted token authenticates a protected route (past auth — it may
        //    then fail at the git layer since C:/repo isn't real, but NOT 401).
        let auth_req = Request::builder()
            .uri("/api/repo/status")
            .header("host", "testhost")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let auth_resp = router.clone().oneshot(auth_req).await.unwrap();
        assert_ne!(auth_resp.status(), StatusCode::UNAUTHORIZED);

        // 4) Revoke the device → the same token now 401s.
        auth::revoke_device(&device_id).unwrap();
        let revoked_req = Request::builder()
            .uri("/api/repo/status")
            .header("host", "testhost")
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        let revoked_resp = router.oneshot(revoked_req).await.unwrap();
        assert_eq!(revoked_resp.status(), StatusCode::UNAUTHORIZED);

        auth::set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
    }
}
