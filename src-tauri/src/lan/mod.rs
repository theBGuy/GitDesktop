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
pub mod static_serve;

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
    /// Fires a cut signal to every live WebSocket monitor (see
    /// [`routes::reviews::forward_stream`]). Sent on `lan_disable`, on a
    /// mode-switch rebind, when the active repo actually changes, and on a
    /// device revoke — each closes in-flight sockets so a phone must reconnect
    /// and re-authorize against the new state. The `Sender` is shared (cloned)
    /// into the router state; only the send half is ever needed there (each
    /// socket subscribes its own receiver).
    monitor_cut: tokio::sync::broadcast::Sender<()>,
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
            // Capacity 4: cut signals are rare lifecycle blips, and each monitor
            // only needs to observe that *a* cut happened (the value is `()`), so
            // a shallow buffer is plenty — a lagged receiver still terminates.
            monitor_cut: tokio::sync::broadcast::channel(4).0,
            lifecycle: tokio::sync::Mutex::new(()),
        }
    }
}

impl LanState {
    /// Point the read routes at `repo_path`, cutting live monitors iff the shared
    /// repo actually changed. Returns whether it changed (the cut fired). Split
    /// out from the [`lan_set_active_repo`] command so the change-detection +
    /// cut-fire behavior is unit-testable without a Tauri `State`.
    fn set_active_repo(&self, repo_path: Option<String>) -> bool {
        let changed = {
            let mut guard = self.active_repo.lock().unwrap_or_else(|p| p.into_inner());
            if *guard == repo_path {
                false
            } else {
                *guard = repo_path;
                true
            }
        };
        // Only cut live monitors when the shared repo ACTUALLY changed. The App
        // effect re-pushes on every repoPath render, so a same-value set is a
        // no-op and must not sever a healthy stream; a real switch/clear must,
        // since the phone's in-flight stream is now scoped to a repo we no longer
        // share.
        if changed {
            let _ = self.monitor_cut.send(());
        }
        changed
    }

    /// Revoke a paired device, then cut live monitors on success. Split out from
    /// the [`lan_device_revoke`] command so the on-success cut-fire is unit-
    /// testable without a Tauri `State`. The cut is deliberately coarse (all live
    /// monitors, not just the revoked device's — per-device cut tracking is
    /// deferred): every phone reconnects, and the revoked token is now rejected at
    /// the upgrade, closing the "auth runs only at upgrade time" hole.
    fn revoke_device(&self, device_id: &str) -> AppResult<()> {
        auth::revoke_device(device_id)?;
        let _ = self.monitor_cut.send(());
        Ok(())
    }

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
                // The device count is only meaningful/consumed while sharing is
                // on, so report 0 here and skip `auth::device_count()`'s disk
                // read of `lan-devices.json`. This keeps the app-wide 5s
                // `lan_status` poll off-disk for the (default) disabled case.
                device_count: 0,
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
            // Cut any sockets accepted on the old listener before it's torn down:
            // a mode switch rebinds on a new port/interface, so in-flight monitors
            // must reconnect against the new server.
            let _ = state.monitor_cut.send(());
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
        state.monitor_cut.clone(),
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
        // Cut every live monitor before we drop the listener: `shutdown()` stops
        // accepting, but sockets already hijacked out of the serve loop keep
        // forwarding until told to stop. Firing here closes them so "Stop sharing"
        // actually severs the phone.
        let _ = state.monitor_cut.send(());
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
/// `None` clears the active repo (the desktop closed its repo), after which the
/// read routes 409 via `repo_or_409!` — paired devices stop seeing the last repo.
#[tauri::command]
pub fn lan_set_active_repo(
    state: State<'_, LanState>,
    repo_path: Option<String>,
) -> AppResult<()> {
    state.set_active_repo(repo_path);
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
pub fn lan_device_revoke(state: State<'_, LanState>, device_id: String) -> AppResult<()> {
    state.revoke_device(&device_id)
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
            monitor_cut: tokio::sync::broadcast::channel(4).0,
        }
    }

    fn get(path: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .header("host", "testhost")
            .body(Body::empty())
            .unwrap()
    }

    #[test]
    fn set_active_repo_none_clears() {
        // Setting a repo then clearing with None must leave the status snapshot
        // with no active repo (Close repo stops sharing the last repo).
        let state = LanState::default();
        {
            let mut guard = state.active_repo.lock().unwrap();
            *guard = Some("C:/repo".to_string());
        }
        assert_eq!(state.status().active_repo.as_deref(), Some("C:/repo"));
        {
            let mut guard = state.active_repo.lock().unwrap();
            *guard = None;
        }
        assert_eq!(state.status().active_repo, None);
    }

    #[test]
    fn set_active_repo_cuts_monitors_only_on_change() {
        // The monitor-cut signal fires when the shared repo actually changes, and
        // NOT on a same-value set (the App effect re-pushes the same repoPath on
        // every render — cutting on those would sever healthy phone streams).
        let state = LanState::default();
        let mut cut_rx = state.monitor_cut.subscribe();

        // (1) None → Some(repo) is a change → fires.
        assert!(state.set_active_repo(Some("C:/repo".to_string())));
        assert!(cut_rx.try_recv().is_ok());

        // (2) Setting the SAME value again is a no-op → no fire.
        assert!(!state.set_active_repo(Some("C:/repo".to_string())));
        assert!(matches!(
            cut_rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));

        // (3) A real switch (and a clear) each fire.
        assert!(state.set_active_repo(Some("C:/other".to_string())));
        assert!(cut_rx.try_recv().is_ok());
        assert!(state.set_active_repo(None));
        assert!(cut_rx.try_recv().is_ok());
    }

    #[test]
    fn revoke_device_cuts_monitors_on_success() {
        // A successful revoke fires the monitor-cut signal (so a phone with the
        // revoked token — auth only ran at upgrade time — is severed and 401ed on
        // reconnect). A failed revoke (unknown id) does NOT fire.
        let _lock = auth::store_test_lock();
        let tmp = temp_store();
        let prev = auth::set_store_path_for_test(Some(tmp.clone()));

        let state = LanState::default();
        let mut cut_rx = state.monitor_cut.subscribe();

        let (device, _bearer, token_hash) = auth::mint_device("Revoke Phone");
        auth::persist_device(&device, &token_hash).unwrap();

        // Successful revoke → fires.
        state.revoke_device(&device.id).unwrap();
        assert!(cut_rx.try_recv().is_ok());

        // A second revoke of the same (now-unknown) id errors and must NOT fire.
        assert!(state.revoke_device(&device.id).is_err());
        assert!(matches!(
            cut_rx.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));

        auth::set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
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

        // 3b) The session was CONSUMED atomically on the successful pair, so a
        //     second submit with the SAME correct proof (the double-mint race, run
        //     sequentially here) now hits `pairingInactive`/403 — it can't mint a
        //     second token from one PIN entry.
        let replay_body = serde_json::json!({ "deviceName": "Replay Phone", "proof": proof });
        let replay_req = Request::builder()
            .uri("/api/pair")
            .method("POST")
            .header("host", "testhost")
            .header("content-type", "application/json")
            .body(Body::from(replay_body.to_string()))
            .unwrap();
        let replay_resp = router.clone().oneshot(replay_req).await.unwrap();
        assert_eq!(replay_resp.status(), StatusCode::FORBIDDEN);
        let replay_bytes = axum::body::to_bytes(replay_resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let replay: serde_json::Value = serde_json::from_slice(&replay_bytes).unwrap();
        assert_eq!(replay["kind"], "pairingInactive");
        // Still exactly one device — no second mint slipped through.
        assert_eq!(auth::list_devices().unwrap().len(), 1);

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

    /// Build a POST request to `path` with an optional JSON body (host = testhost).
    fn post(path: &str, json_body: Option<&str>) -> Request<Body> {
        let mut b = Request::builder()
            .uri(path)
            .method("POST")
            .header("host", "testhost");
        let body = match json_body {
            Some(j) => {
                b = b.header("content-type", "application/json");
                Body::from(j.to_string())
            }
            None => Body::empty(),
        };
        b.body(body).unwrap()
    }

    #[tokio::test]
    async fn challenge_polling_without_a_session_never_locks_out() {
        // The live self-lockout bug: a phone sitting on the pairing page polls
        // `/challenge` while NO session is active (e.g. between a revoke and the next
        // offer). Each poll gets `pairingInactive` — but must NOT count toward the
        // lockout budget, or the phone locks ITSELF out before the user types a PIN.
        // Poll well past the threshold; every response stays 403 pairingInactive,
        // never 429.
        let router = server::build_router(test_router(None));
        for _ in 0..(auth::RATE_LIMIT_MAX_FAILURES_FOR_TEST + 3) {
            let resp = router
                .clone()
                .oneshot(post("/api/pair/challenge", None))
                .await
                .unwrap();
            assert_eq!(
                resp.status(),
                StatusCode::FORBIDDEN,
                "polling with no session must stay pairingInactive, never lock out"
            );
        }
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn wrong_proofs_still_lock_out_after_the_threshold() {
        // The lockout budget IS the PIN-guess budget: repeated WRONG proofs must
        // still trip the lockout at the threshold (the calibration fix removed the
        // no-session/expired penalties but must NOT weaken the real guess defense).
        let _lock = auth::store_test_lock();
        let tmp = temp_store();
        let prev = auth::set_store_path_for_test(Some(tmp.clone()));

        // An active session with a fetched challenge, so a submitted proof is
        // actually evaluated (and a wrong one records a failure).
        let session = auth::new_pairing_session("http://testhost/#pair".to_string());
        let state = test_router(Some("C:/repo".to_string()));
        *state.pairing.lock().unwrap() = Some(session);
        let router = server::build_router(state);

        // Fetch a challenge so proofs reach the compare (not the no-challenge branch).
        let chal = router
            .clone()
            .oneshot(post("/api/pair/challenge", None))
            .await
            .unwrap();
        assert_eq!(chal.status(), StatusCode::OK);

        // Submit wrong proofs up to (but not hitting) the threshold → each 401s.
        let wrong = serde_json::json!({ "deviceName": "Guesser", "proof": "00" }).to_string();
        for _ in 0..auth::RATE_LIMIT_MAX_FAILURES_FOR_TEST {
            let resp = router
                .clone()
                .oneshot(post("/api/pair", Some(&wrong)))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "a wrong proof is a 401");
        }
        // The threshold is now reached → the next attempt is rate-limited (429).
        let locked = router
            .oneshot(post("/api/pair", Some(&wrong)))
            .await
            .unwrap();
        assert_eq!(
            locked.status(),
            StatusCode::TOO_MANY_REQUESTS,
            "wrong proofs must still lock out at the threshold"
        );

        auth::set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
    }

    /// Build an authed GET request by seeding a device in the store and using its
    /// raw bearer. Caller must hold `store_test_lock` + a store-path override.
    fn authed_get(path: &str, bearer: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .header("host", "testhost")
            .header("authorization", format!("Bearer {bearer}"))
            .body(Body::empty())
            .unwrap()
    }

    /// Build a GET request authed via the `gd_lan` cookie (the phone-browser path).
    fn cookie_get(path: &str, cookie_value: &str) -> Request<Body> {
        Request::builder()
            .uri(path)
            .header("host", "testhost")
            .header("cookie", format!("gd_lan={cookie_value}"))
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn cookie_auth_reaches_protected_routes() {
        // A phone browser can't set an Authorization header on a WS upgrade or
        // navigation, so it authenticates via the `gd_lan` cookie. A valid cookie
        // reaches a protected route (not 401), a bad cookie 401s, and an explicit
        // Authorization header still works.
        let _lock = auth::store_test_lock();
        let tmp = temp_store();
        let prev = auth::set_store_path_for_test(Some(tmp.clone()));

        let (device, bearer, token_hash) = auth::mint_device("Cookie Phone");
        auth::persist_device(&device, &token_hash).unwrap();
        let router = server::build_router(test_router(Some("C:/repo".to_string())));

        // (1) A valid cookie reaches the protected route (past auth — may fail at the
        //     git layer since C:/repo isn't real, but NOT 401).
        let ok = router
            .clone()
            .oneshot(cookie_get("/api/repo/status", &bearer))
            .await
            .unwrap();
        assert_ne!(ok.status(), StatusCode::UNAUTHORIZED);

        // (2) A bad cookie 401s.
        let bad = router
            .clone()
            .oneshot(cookie_get("/api/repo/status", "not-a-real-token"))
            .await
            .unwrap();
        assert_eq!(bad.status(), StatusCode::UNAUTHORIZED);

        // (3) The Authorization header path still works (checked FIRST).
        let hdr = router
            .oneshot(authed_get("/api/repo/status", &bearer))
            .await
            .unwrap();
        assert_ne!(hdr.status(), StatusCode::UNAUTHORIZED);

        auth::set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn no_credential_probes_never_lock_out_and_leave_pairing_working() {
        // The companion shell's status probe hits a protected route with NO
        // credential while the phone sits on #pair (no cookie yet). A request with no
        // credential at all carries zero guessing info, so it must NOT bank a failure
        // — otherwise these probes reintroduce the self-lockout. Fire well past the
        // threshold: every probe 401s, never 429, and a correct pairing flow AFTER
        // them still succeeds (the budget was never spent).
        let _lock = auth::store_test_lock();
        let tmp = temp_store();
        let prev = auth::set_store_path_for_test(Some(tmp.clone()));

        let session = auth::new_pairing_session("http://testhost/#pair".to_string());
        let pin = session.pin.clone();
        let state = test_router(Some("C:/repo".to_string()));
        *state.pairing.lock().unwrap() = Some(session);
        let router = server::build_router(state);

        // Many no-credential probes → always 401, never 429.
        for _ in 0..(auth::RATE_LIMIT_MAX_FAILURES_FOR_TEST + 5) {
            let resp = router
                .clone()
                .oneshot(get("/api/repo/status"))
                .await
                .unwrap();
            assert_eq!(
                resp.status(),
                StatusCode::UNAUTHORIZED,
                "a no-credential probe must 401, never lock out"
            );
        }

        // A correct pairing flow after the probes still works (budget untouched).
        let chal = router
            .clone()
            .oneshot(post("/api/pair/challenge", None))
            .await
            .unwrap();
        assert_eq!(chal.status(), StatusCode::OK);
        let chal_bytes = axum::body::to_bytes(chal.into_body(), 64 * 1024)
            .await
            .unwrap();
        let chal: serde_json::Value = serde_json::from_slice(&chal_bytes).unwrap();
        let challenge = chal["challenge"].as_str().unwrap().to_string();
        let salt = chal["salt"].as_str().unwrap().to_string();
        let proof = auth::compute_proof(&pin, &salt, &challenge);
        let pair = serde_json::json!({ "deviceName": "Late Pair", "proof": proof }).to_string();
        let pair_resp = router
            .oneshot(post("/api/pair", Some(&pair)))
            .await
            .unwrap();
        assert_eq!(
            pair_resp.status(),
            StatusCode::OK,
            "pairing must still succeed after no-credential probes"
        );

        auth::set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn invalid_bearer_probes_still_lock_out_after_the_threshold() {
        // A PRESENT-but-invalid bearer IS a guessing event (token brute force), so it
        // must still count toward the lockout budget: N invalid-bearer requests trip
        // the 429 at the threshold. The brute-force defense stays intact.
        let _lock = auth::store_test_lock();
        let tmp = temp_store();
        let prev = auth::set_store_path_for_test(Some(tmp.clone()));

        // An empty store (no devices) — every bearer here is invalid.
        let router = server::build_router(test_router(Some("C:/repo".to_string())));

        // Invalid bearers up to the threshold → each 401.
        for _ in 0..auth::RATE_LIMIT_MAX_FAILURES_FOR_TEST {
            let resp = router
                .clone()
                .oneshot(authed_get("/api/repo/status", "deadbeefdeadbeef"))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::UNAUTHORIZED, "an invalid bearer is a 401");
        }
        // Threshold reached → the next attempt is rate-limited.
        let locked = router
            .oneshot(authed_get("/api/repo/status", "deadbeefdeadbeef"))
            .await
            .unwrap();
        assert_eq!(
            locked.status(),
            StatusCode::TOO_MANY_REQUESTS,
            "invalid-bearer brute force must still lock out at the threshold"
        );

        auth::set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn pair_submit_sets_the_auth_cookie() {
        // A successful pair returns the auth cookie with the exact frozen attributes
        // (in ADDITION to the unchanged JSON body), so a phone browser is
        // authenticated for subsequent navigations/upgrades.
        let _lock = auth::store_test_lock();
        let tmp = temp_store();
        let prev = auth::set_store_path_for_test(Some(tmp.clone()));

        let session = auth::new_pairing_session("http://testhost/#pair".to_string());
        let pin = session.pin.clone();
        let state = test_router(Some("C:/repo".to_string()));
        *state.pairing.lock().unwrap() = Some(session);
        let router = server::build_router(state);

        // Challenge → proof → pair.
        let chal_req = Request::builder()
            .uri("/api/pair/challenge")
            .method("POST")
            .header("host", "testhost")
            .body(Body::empty())
            .unwrap();
        let chal_resp = router.clone().oneshot(chal_req).await.unwrap();
        let chal_bytes = axum::body::to_bytes(chal_resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let chal: serde_json::Value = serde_json::from_slice(&chal_bytes).unwrap();
        let challenge = chal["challenge"].as_str().unwrap().to_string();
        let salt = chal["salt"].as_str().unwrap().to_string();
        let proof = auth::compute_proof(&pin, &salt, &challenge);
        let pair_body = serde_json::json!({ "deviceName": "Cookie Pair Phone", "proof": proof });
        let pair_req = Request::builder()
            .uri("/api/pair")
            .method("POST")
            .header("host", "testhost")
            .header("content-type", "application/json")
            .body(Body::from(pair_body.to_string()))
            .unwrap();
        let pair_resp = router.oneshot(pair_req).await.unwrap();
        assert_eq!(pair_resp.status(), StatusCode::OK);

        // The Set-Cookie carries the exact frozen name + attributes.
        let set_cookie = pair_resp
            .headers()
            .get("set-cookie")
            .expect("pair success must set the auth cookie")
            .to_str()
            .unwrap()
            .to_string();
        assert!(set_cookie.starts_with("gd_lan="), "cookie name: {set_cookie}");
        assert!(set_cookie.contains("HttpOnly"), "HttpOnly: {set_cookie}");
        assert!(set_cookie.contains("SameSite=Strict"), "SameSite=Strict: {set_cookie}");
        assert!(set_cookie.contains("Path=/"), "Path=/: {set_cookie}");
        assert!(set_cookie.contains("Max-Age=31536000"), "Max-Age: {set_cookie}");
        // No Secure — plain HTTP on the LAN by design.
        assert!(!set_cookie.contains("Secure"), "must NOT be Secure: {set_cookie}");

        // The JSON body is unchanged — the token is still returned for API clients.
        let bytes = axum::body::to_bytes(pair_resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let minted: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let token = minted["token"].as_str().unwrap();
        // The cookie value equals the raw bearer.
        assert_eq!(set_cookie, format!("gd_lan={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000"));

        auth::set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
    }

    #[tokio::test]
    async fn static_index_serves_bundle_or_reports_not_built_with_page_csp() {
        // Through the full router (host guard + insert-if-absent hardening), `/`
        // carries the fuller PAGE CSP — NOT the bare API CSP — in BOTH embed states.
        // DEBUG rust-embed reads `companion-dist/` from disk, so this must be green
        // whether or not `pnpm build:companion` has run: bundle present → 200 + the
        // real index.html; absent (CI) → 503 + the marker.
        let router = server::build_router(test_router(Some("C:/repo".to_string())));
        let resp = router.oneshot(get("/")).await.unwrap();
        assert_eq!(
            resp.headers().get("Content-Security-Policy").unwrap(),
            static_serve::PAGE_CSP
        );
        if static_serve::bundle_present() {
            assert_eq!(resp.status(), StatusCode::OK);
            let ct = resp
                .headers()
                .get("content-type")
                .unwrap()
                .to_str()
                .unwrap();
            assert!(ct.starts_with("text/html"), "index Content-Type: {ct}");
            // The entry document must revalidate every load (no-cache).
            assert_eq!(
                resp.headers().get("cache-control").unwrap(),
                "no-cache"
            );
        } else {
            assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
            let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
                .await
                .unwrap();
            assert!(String::from_utf8_lossy(&bytes).contains("companion bundle not built"));
        }
    }

    #[tokio::test]
    async fn api_response_keeps_the_bare_csp() {
        // An API response (here the 404 for an unknown route) keeps EXACTLY the
        // current bare API CSP — the insert-if-absent change must not leak the page
        // CSP onto API responses.
        let router = server::build_router(test_router(Some("C:/repo".to_string())));
        let resp = router.oneshot(get("/api/nope")).await.unwrap();
        assert_eq!(
            resp.headers().get("Content-Security-Policy").unwrap(),
            auth::API_CSP
        );
    }

    #[tokio::test]
    async fn static_unknown_asset_is_404() {
        let router = server::build_router(test_router(Some("C:/repo".to_string())));
        let resp = router.oneshot(get("/assets/nope.js")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn static_index_is_host_guarded() {
        // The `/` route is wrapped by the outer host guard like every other route.
        let router = server::build_router(test_router(Some("C:/repo".to_string())));
        let req = Request::builder()
            .uri("/")
            .header("host", "evil.example.com")
            .body(Body::empty())
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn diff_file_rejects_paths_escaping_the_repo() {
        let _lock = auth::store_test_lock();
        let tmp = temp_store();
        let prev = auth::set_store_path_for_test(Some(tmp.clone()));

        // A real temp repo so a legitimate untracked path can be served (200) and
        // the guard — not a downstream git error — is what rejects bad paths.
        let repo_dir = std::env::temp_dir().join(format!(
            "gd-lan-diff-guard-repo-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&repo_dir).unwrap();
        assert!(std::process::Command::new("git")
            .arg("init")
            .current_dir(&repo_dir)
            .output()
            .unwrap()
            .status
            .success());
        std::fs::write(repo_dir.join("hello.txt"), "hello lan\n").unwrap();
        let repo = repo_dir.to_string_lossy().to_string();

        // Seed a paired device and grab its raw bearer.
        let (device, bearer, token_hash) = auth::mint_device("Guard Phone");
        auth::persist_device(&device, &token_hash).unwrap();

        let router = server::build_router(test_router(Some(repo.clone())));

        // ../x → 400 (ParentDir).
        let resp = router
            .clone()
            .oneshot(authed_get(
                "/api/repo/diff/file?path=../x&untracked=true",
                &bearer,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // /etc/passwd → 400 (RootDir; a leading `/` parses as RootDir on Windows too).
        let resp = router
            .clone()
            .oneshot(authed_get(
                "/api/repo/diff/file?path=/etc/passwd&untracked=true",
                &bearer,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // A Windows drive prefix → 400 (Prefix). On unix `C:/x` is a Normal
        // component, so only assert this where it's actually an escape.
        #[cfg(windows)]
        {
            let resp = router
                .clone()
                .oneshot(authed_get(
                    "/api/repo/diff/file?path=C:/x&untracked=true",
                    &bearer,
                ))
                .await
                .unwrap();
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        }

        // `.git/config` is a Normal component INSIDE the repo root (containment
        // passes), so without the `.git`-component guard this would 200 and leak
        // `.git/` internals (`git init` creates `.git/config`). Must 400.
        let resp = router
            .clone()
            .oneshot(authed_get(
                "/api/repo/diff/file?path=.git/config&untracked=true",
                &bearer,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // `.GIT/config` → 400 on every filesystem: case-insensitive ones
        // canonicalize it to `.git` and the new guard rejects; case-sensitive
        // ones have no such path, so canonicalize fails → 400 from containment.
        let resp = router
            .clone()
            .oneshot(authed_get(
                "/api/repo/diff/file?path=.GIT/config&untracked=true",
                &bearer,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        // A legitimate untracked file inside the repo is served, not rejected.
        let resp = router
            .oneshot(authed_get(
                "/api/repo/diff/file?path=hello.txt&untracked=true",
                &bearer,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 256 * 1024)
            .await
            .unwrap();
        let body = String::from_utf8_lossy(&bytes);
        assert!(body.contains("hello lan"), "diff body should include the file content: {body}");

        auth::set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
        std::fs::remove_dir_all(&repo_dir).ok();
    }

    /// Insert a live stream into a router state's registry, tagged with the repo it
    /// operates on. Mirrors what `AppState::register_stream` stores, but built
    /// directly so the test doesn't need a whole `AppState`. Returns the sender so
    /// the caller can keep it alive (dropping it would close the stream).
    fn insert_stream(
        state: &auth::RouterState,
        id: &str,
        kind: &str,
        repo_path: &str,
    ) -> tokio::sync::broadcast::Sender<crate::agent::ReviewEvent> {
        let (tx, _rx) = tokio::sync::broadcast::channel(16);
        state.streams.lock().unwrap().insert(
            id.to_string(),
            crate::state::StreamInfo {
                tx: tx.clone(),
                kind: kind.to_string(),
                started_at: "2026-07-17T00:00:00.000Z".to_string(),
                repo_path: repo_path.to_string(),
            },
        );
        tx
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn reviews_list_is_scoped_to_the_shared_repo() {
        // A stream registered on the shared repo is listed; one on a different repo
        // is omitted — a paired device only ever sees streams on the shared repo.
        let _lock = auth::store_test_lock();
        let tmp = temp_store();
        let prev = auth::set_store_path_for_test(Some(tmp.clone()));
        let (device, bearer, token_hash) = auth::mint_device("List Phone");
        auth::persist_device(&device, &token_hash).unwrap();

        // Sharing C:/repo, with one stream on it and one on C:/other.
        let state = test_router(Some("C:/repo".to_string()));
        let _tx_here = insert_stream(&state, "rev-here", "review", "C:/repo");
        let _tx_other = insert_stream(&state, "rev-other", "session", "C:/other");
        let router = server::build_router(state);

        let resp = router
            .oneshot(authed_get("/api/reviews", &bearer))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), 64 * 1024)
            .await
            .unwrap();
        let items: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        let arr = items.as_array().unwrap();
        // Exactly the shared repo's stream; the other repo's is filtered out. Repo
        // paths are never on the wire (only id/kind/startedAt).
        assert_eq!(arr.len(), 1, "only the shared repo's stream: {items}");
        assert_eq!(arr[0]["id"], "rev-here");
        assert_eq!(arr[0]["kind"], "review");
        assert!(arr[0].get("repoPath").is_none() && arr[0].get("repo_path").is_none());

        auth::set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn reviews_list_409s_when_no_repo_shared() {
        // With no active repo, the enumeration route 409s (like every other read
        // route) even when a stream is registered — nothing is shared to list.
        let _lock = auth::store_test_lock();
        let tmp = temp_store();
        let prev = auth::set_store_path_for_test(Some(tmp.clone()));
        let (device, bearer, token_hash) = auth::mint_device("NoRepo Phone");
        auth::persist_device(&device, &token_hash).unwrap();

        let state = test_router(None);
        let _tx = insert_stream(&state, "rev-1", "review", "C:/repo");
        let router = server::build_router(state);

        let list = router
            .oneshot(authed_get("/api/reviews", &bearer))
            .await
            .unwrap();
        assert_eq!(list.status(), StatusCode::CONFLICT);

        auth::set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn live_websocket_monitor_is_severed_by_the_cut_signal() {
        // End-to-end: bind a REAL listener, connect a REAL WebSocket to the
        // `/api/reviews/{id}/stream` route as a paired device, prove the pump is
        // live (one event → one Text frame), then fire the lifecycle cut and prove
        // the socket is closed (next frame is a Close). This exercises the exact
        // production path the in-memory `oneshot` tests can't reach — the upgraded
        // socket and `forward_stream`'s monitor-cut `select!` branch.
        use futures_util::StreamExt;
        use tokio::time::{timeout, Duration};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message;

        let _lock = auth::store_test_lock();
        let tmp = temp_store();
        let prev = auth::set_store_path_for_test(Some(tmp.clone()));

        // The shared arcs a real server needs — built directly (not via a whole
        // `LanState`) so we can inject an event and fire the cut ourselves. The
        // active repo and the stream's `repo_path` match, so the stream is in scope.
        let repo = "C:/repo".to_string();
        let active_repo = Arc::new(Mutex::new(Some(repo.clone())));
        let pairing = Arc::new(Mutex::new(None));
        let rate_limit = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let streams: Arc<Mutex<std::collections::HashMap<String, crate::state::StreamInfo>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        let monitor_cut = tokio::sync::broadcast::channel::<()>(4).0;

        // A live "review" stream on the shared repo; keep the sender to emit events.
        let (ev_tx, _ev_rx) = tokio::sync::broadcast::channel::<crate::agent::ReviewEvent>(16);
        streams.lock().unwrap().insert(
            "rev-e2e".to_string(),
            crate::state::StreamInfo {
                tx: ev_tx.clone(),
                kind: "review".to_string(),
                started_at: "2026-07-17T00:00:00.000Z".to_string(),
                repo_path: repo.clone(),
            },
        );

        // Seed a paired device and keep its raw bearer for the WS handshake.
        let (device, bearer, token_hash) = auth::mint_device("E2E Phone");
        auth::persist_device(&device, &token_hash).unwrap();

        // Bind a real listener in loopback mode (the port scan handles a busy
        // default port). `server::start` spawns its serve task on the tauri
        // async runtime, which self-initializes here.
        let (handle, _urls, _hosts) = server::start(
            false,
            active_repo.clone(),
            pairing,
            rate_limit,
            streams.clone(),
            monitor_cut.clone(),
        )
        .await
        .unwrap();
        let port = handle.port;

        // Connect a REAL WebSocket. Build the handshake request from the URI (which
        // fills in the mandatory `Upgrade`/`Sec-WebSocket-*` headers and a `Host` of
        // `127.0.0.1:{port}`, which is in the bound-hosts allowlist), then add the
        // per-device bearer the way a paired phone would.
        let url = format!("ws://127.0.0.1:{port}/api/reviews/rev-e2e/stream");
        let mut req = url.into_client_request().unwrap();
        req.headers_mut().insert(
            "authorization",
            format!("Bearer {bearer}").parse().unwrap(),
        );
        let (mut ws, _resp) = timeout(Duration::from_secs(5), tokio_tungstenite::connect_async(req))
            .await
            .expect("WebSocket connect timed out")
            .expect("WebSocket handshake failed (auth/host/upgrade)");

        // (1) The pump is live: one event through the registry tx arrives as one
        // Text frame carrying the ReviewEvent's own JSON.
        ev_tx
            .send(crate::agent::ReviewEvent::Delta {
                text: "hello phone".to_string(),
            })
            .unwrap();
        let frame = timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for the forwarded event")
            .expect("stream ended before the event")
            .expect("websocket error waiting for the event");
        match frame {
            Message::Text(t) => assert!(
                t.contains("hello phone"),
                "forwarded frame should carry the event JSON: {t}"
            ),
            other => panic!("expected a Text frame, got {other:?}"),
        }

        // (2) Fire the lifecycle cut (what `lan_disable` / repo-switch / revoke do).
        // The pump's `select!` cut branch must break and close the socket.
        monitor_cut.send(()).unwrap();

        // The next frame the client sees is a Close (the pump's best-effort
        // graceful close). Some stacks surface the close as the stream ending
        // (`None`) right after; accept either as "severed", but never another Text.
        let next = timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("timed out waiting for the socket to be severed");
        match next {
            Some(Ok(Message::Close(_))) | None => { /* severed, as required */ }
            Some(Ok(other)) => panic!("expected the socket to be cut, got {other:?}"),
            Some(Err(_)) => { /* an abrupt transport close is still a severed socket */ }
        }

        // Best-effort client-side close, then tear the server down and clean up.
        let _ = ws.close(None).await;
        handle.shutdown().await;
        auth::set_store_path_for_test(prev);
        std::fs::remove_file(&tmp).ok();
    }

    // NOTE on the `stream` route's 409/404 branches: `WebSocketUpgrade` is an
    // extractor, and axum runs it during extraction — a plain (non-upgrade) GET is
    // rejected with `400 Bad Request` by the extractor BEFORE the handler body runs,
    // so a `tower::oneshot` (which can't perform a real WS upgrade) can never reach
    // the body's `repo_or_409!` (409) or its scoped-`subscribe_in_for` 404. The
    // pre-existing `review_routes_are_bearer_gated` test likewise only reaches the
    // 401 because that's middleware, ahead of extraction. The scoping logic these
    // branches call is unit-tested directly in `state::tests`
    // (`scoped_snapshot_and_subscribe_filter_by_repo`): matching repo → `Some`,
    // out-of-scope id and unknown id → `None` (the 404 source), with no oracle
    // distinguishing them. Asserting the route-level 404/409 would need a live
    // socket, out of scope for these in-memory router tests.
    //
    // NOTE on `forward_stream`'s monitor-cut `select!` branch: a `tower::oneshot`
    // can't drive it (the `WebSocketUpgrade` extractor rejects a non-upgrade GET
    // during extraction, before the handler runs), so the cut branch only runs on a
    // real upgraded socket. It is now covered end-to-end by
    // `live_websocket_monitor_is_severed_by_the_cut_signal` above, which binds a
    // real listener, connects a real WebSocket, and asserts the socket is closed
    // when the cut fires. The fire points are separately covered by
    // `set_active_repo_cuts_monitors_only_on_change` and
    // `revoke_device_cuts_monitors_on_success`.
}
