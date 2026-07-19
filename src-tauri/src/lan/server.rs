//! The axum router assembly, listener bind (with port scanning), and graceful
//! shutdown for the LAN companion server.
//!
//! The router mounts EXACTLY the pairing routes plus the read-only routes
//! (structural allowlist — see [`crate::lan::routes`]): the 17 read handlers,
//! mounted TWICE — once as the frozen active-repo ALIAS surface (`/api/repo/…`,
//! `/api/forge/…`, `/api/reviews…`) and once under the SCOPED
//! `/api/repos/{repoId}/…` surface — plus `GET /api/repos`; anything else 404s.
//! Each mount carries a resolver middleware that resolves the request's repo and
//! inserts an `Extension<ScopedRepo>` (alias → the active repo; scoped → a
//! `{repoId}` registry lookup) so the shared handlers are identical under either.
//! Two outer middleware layers wrap everything: [`crate::lan::auth::host_guard`]
//! (runs on every request — DNS-rebind defense + hardening headers) and, on the
//! protected subtree only, [`crate::lan::auth::require_auth`] (per-device bearer).
//! The `/api/reviews/{id}/stream` SSE stream lives inside that protected subtree,
//! so it is bearer-gated and host-guarded like every other read route.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::routing::{get, post};
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use axum_server::Handle;

use crate::error::{AppError, AppResult};
use crate::lan::auth::{self, RouterState};
use crate::lan::routes::{self, forge, git, reviews};
use crate::lan::static_serve;
use crate::lan::tls;

/// The default port the server tries first — a fixed value in the IANA dynamic /
/// private range (49152–65535 is the strict private range, but the 38400s are
/// conventionally free and memorable). If it's taken we scan the next few.
pub const DEFAULT_PORT: u16 = 38473;

/// How many consecutive ports to try (DEFAULT_PORT ..= DEFAULT_PORT + SCAN) when
/// the first is already in use.
const PORT_SCAN: u16 = 4;

/// A bound, running server: the port it landed on, the axum-server shutdown
/// handle, and the task handle. Dropping the handle does not stop the server —
/// call [`ServerHandle::shutdown`].
pub struct ServerHandle {
    pub port: u16,
    handle: Handle<SocketAddr>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl ServerHandle {
    /// Signal graceful shutdown and await the serve task's exit.
    pub async fn shutdown(self) {
        // axum-server's `Handle` stores the shutdown signal internally, so the
        // pre-registration race the old `Notify` had (the serve task registered its
        // `notified()` waiter only on its first poll, so a rapid enable→disable could
        // signal before that and hang) is gone: a `graceful_shutdown` before the
        // serve loop's first accept is still honored. The 5s cap bounds the worst
        // case — SSE monitors are LIVE connections, but `monitor_cut` fires before
        // shutdown in every path (disable/rebind), so they close fast; the cap only
        // guards a stream that somehow didn't get the cut.
        self.handle.graceful_shutdown(Some(Duration::from_secs(5)));
        // Join to be sure the listener is released before we (possibly) rebind on a
        // mode change.
        let _ = self.task.await;
    }
}

/// Build the axum router for the given state. Separated from binding so tests can
/// drive it via `tower::ServiceExt::oneshot` without opening a socket.
pub fn build_router(state: RouterState) -> Router {
    // The frozen ALIAS surface — the shipped companion consumes these paths
    // verbatim. Its resolver scopes every request to the desktop's ACTIVE repo (a
    // `None` active repo → 409 `noActiveRepo`).
    let alias = Router::new()
        .route("/api/repo/status", get(git::status))
        .route("/api/repo/branches", get(git::branches))
        .route("/api/repo/log", get(git::log))
        .route("/api/repo/commits/{hash}", get(git::commit_details))
        .route("/api/repo/commits/{hash}/diff", get(git::commit_diff))
        .route("/api/repo/diff/working", get(git::diff_working))
        .route("/api/repo/diff/file", get(git::diff_file))
        .route("/api/forge/prs", get(forge::pr_list))
        .route("/api/forge/prs/{number}", get(forge::pr_view))
        .route("/api/forge/prs/{number}/timeline", get(forge::pr_timeline))
        .route("/api/forge/prs/{number}/threads", get(forge::pr_threads))
        .route("/api/forge/issues", get(forge::issue_list))
        .route("/api/forge/issues/{number}", get(forge::issue_view))
        .route("/api/forge/ci/runs", get(forge::ci_run_list))
        .route("/api/forge/ci/runs/{id}", get(forge::ci_run_view))
        // Live-monitoring: enumerate active agent streams + watch one over SSE.
        .route("/api/reviews", get(reviews::list))
        .route("/api/reviews/{id}/stream", get(reviews::stream))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            routes::resolve_active_repo,
        ));

    // The SCOPED surface under `/api/repos/{repoId}/…` with FLAT paths (the alias's
    // `repo`/`forge` grouping segments drop out) — the same handler set. Its
    // resolver looks `{repoId}` up in the registry (miss → 404 `noSuchRepo`).
    let scoped = Router::new()
        .route("/api/repos/{repoId}/status", get(git::status))
        .route("/api/repos/{repoId}/branches", get(git::branches))
        .route("/api/repos/{repoId}/log", get(git::log))
        .route("/api/repos/{repoId}/commits/{hash}", get(git::commit_details))
        .route(
            "/api/repos/{repoId}/commits/{hash}/diff",
            get(git::commit_diff),
        )
        .route("/api/repos/{repoId}/diff/working", get(git::diff_working))
        .route("/api/repos/{repoId}/diff/file", get(git::diff_file))
        .route("/api/repos/{repoId}/prs", get(forge::pr_list))
        .route("/api/repos/{repoId}/prs/{number}", get(forge::pr_view))
        .route(
            "/api/repos/{repoId}/prs/{number}/timeline",
            get(forge::pr_timeline),
        )
        .route(
            "/api/repos/{repoId}/prs/{number}/threads",
            get(forge::pr_threads),
        )
        .route("/api/repos/{repoId}/issues", get(forge::issue_list))
        .route("/api/repos/{repoId}/issues/{number}", get(forge::issue_view))
        .route("/api/repos/{repoId}/ci/runs", get(forge::ci_run_list))
        .route("/api/repos/{repoId}/ci/runs/{id}", get(forge::ci_run_view))
        .route("/api/repos/{repoId}/reviews", get(reviews::list))
        .route(
            "/api/repos/{repoId}/reviews/{id}/stream",
            get(reviews::stream),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            routes::resolve_scoped_repo,
        ));

    // The protected read-only subtree: bearer-auth required. `GET /api/repos`
    // (the registered-repo listing) is authed but goes through NEITHER repo
    // resolver — it reads the registry directly.
    let api = Router::new()
        .route("/api/repos", get(routes::list_repos))
        .merge(alias)
        .merge(scoped)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    // The unauthenticated (but rate-limited + host-guarded) pairing routes.
    let pairing = Router::new()
        .route("/api/pair/challenge", post(auth::pair_challenge))
        .route("/api/pair", post(auth::pair_submit));

    // The static companion frontend — served UNauthenticated (the pairing page must
    // load before a device is paired) but still inside the outer host guard. `/` is
    // the SPA entry (embedded index.html; 503 with a "not built" marker in CI) and
    // `/assets/{*path}` serves its hashed assets. The app is hash-routed, so there's
    // no history-API fallback: an unknown asset 404s.
    let static_assets = Router::new()
        .route("/", get(static_serve::index))
        .route("/assets/{*path}", get(static_serve::asset));

    // Merge, then wrap EVERYTHING in the host guard (which also stamps the
    // hardening headers on every response, including 404s for unknown paths).
    Router::new()
        .merge(api)
        .merge(pairing)
        .merge(static_assets)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::host_guard,
        ))
        .with_state(state)
}

/// Enumerate the addresses we bind and advertise. `bind_lan` false → loopback
/// only (dev/preview); true → all interfaces. Returns `(bind_ip, advertised_ips)`
/// where `advertised_ips` are the concrete IPv4s the URLs use (loopback for
/// loopback mode; every non-loopback IPv4 for LAN mode, falling back to loopback
/// if none can be enumerated).
fn resolve_ips(bind_lan: bool) -> (IpAddr, Vec<Ipv4Addr>) {
    if !bind_lan {
        return (
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            vec![Ipv4Addr::LOCALHOST],
        );
    }
    let ifaces: Vec<(String, Ipv4Addr)> = local_ip_address::list_afinet_netifas()
        .map(|ifaces| {
            ifaces
                .into_iter()
                .filter_map(|(name, ip)| match ip {
                    IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => Some((name, v4)),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let mut ips = rank_ips(ifaces);
    if ips.is_empty() {
        // No LAN interface found — still bind 0.0.0.0 but advertise loopback so
        // the UI has at least one working url.
        ips.push(Ipv4Addr::LOCALHOST);
    }
    (IpAddr::V4(Ipv4Addr::UNSPECIFIED), ips)
}

/// Interface-name substrings that mark a virtual / tunnel / VPN adapter whose IPv4
/// we'd rather NOT lead the advertised-url list with (a phone can't reach a WSL,
/// Docker, or Hyper-V virtual switch address). Case-insensitive substring match.
/// `tap` is NOT here — it's too short to substring-match safely (it would flag
/// "laptop"); it's handled token-aware by [`name_has_tap_token`].
const VIRTUAL_IFACE_MARKERS: &[&str] = &[
    "vethernet",
    "wsl",
    "docker",
    "tailscale",
    "zerotier",
    "npcap",
    "hyper-v",
    "virtual",
    "loopback",
];

/// Whether `lower` (an already-lowercased interface name) contains a "tap" adapter
/// TOKEN — the VPN/TAP virtual-adapter marker — without over-matching words that
/// merely embed the letters (e.g. "laptop"). Split on non-alphanumeric boundaries
/// and match a token that is exactly "tap" or "tap" followed by digits (e.g.
/// "tap0"). So "TAP-Windows Adapter V9" and "OpenVPN TAP" match; "Laptop Dock
/// Ethernet" does not.
fn name_has_tap_token(lower: &str) -> bool {
    lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|tok| {
            let Some(rest) = tok.strip_prefix("tap") else {
                return false;
            };
            rest.is_empty() || rest.chars().all(|c| c.is_ascii_digit())
        })
}

/// Rank enumerated `(interface_name, IPv4)` pairs so the most likely
/// phone-reachable address leads — the QR/URL list uses `first()`, and a VPN 10.x
/// or Docker 172.17.x must not beat the real 192.168.x Wi-Fi address.
///
/// Score (lower = better): a private-class base by prefix — 192.168.0.0/16 → 0,
/// 10.0.0.0/8 → 1, 172.16.0.0/12 → 2, anything else → 3, link-local 169.254.0.0/16
/// → 9 (last) — plus a +10 penalty when the interface NAME looks virtual: it
/// contains any [`VIRTUAL_IFACE_MARKERS`] substring (case-insensitive) or a "tap"
/// adapter token (see [`name_has_tap_token`]). That demotes a virtual adapter below
/// every physical one in its own class. A STABLE sort preserves enumeration order
/// within a score, and we dedup keeping the first occurrence.
fn rank_ips(ifaces: Vec<(String, Ipv4Addr)>) -> Vec<Ipv4Addr> {
    fn class_score(ip: &Ipv4Addr) -> u32 {
        let o = ip.octets();
        if o[0] == 169 && o[1] == 254 {
            9 // link-local (169.254.0.0/16) — always last
        } else if o[0] == 192 && o[1] == 168 {
            0 // 192.168.0.0/16
        } else if o[0] == 10 {
            1 // 10.0.0.0/8
        } else if o[0] == 172 && (16..=31).contains(&o[1]) {
            2 // 172.16.0.0/12
        } else {
            3 // anything else
        }
    }
    fn name_penalty(name: &str) -> u32 {
        let lower = name.to_ascii_lowercase();
        // Plain substrings for the long markers; token-aware for the short "tap" so
        // it doesn't flag "laptop".
        let is_virtual =
            VIRTUAL_IFACE_MARKERS.iter().any(|m| lower.contains(m)) || name_has_tap_token(&lower);
        if is_virtual {
            10
        } else {
            0
        }
    }
    let mut scored: Vec<(u32, Ipv4Addr)> = ifaces
        .into_iter()
        .map(|(name, ip)| (class_score(&ip) + name_penalty(&name), ip))
        .collect();
    // Stable sort by score keeps enumeration order within a score.
    scored.sort_by_key(|(score, _)| *score);
    let mut out: Vec<Ipv4Addr> = Vec::with_capacity(scored.len());
    for (_, ip) in scored {
        if !out.contains(&ip) {
            out.push(ip); // dedup, keeping the first (best-ranked) occurrence
        }
    }
    out
}

/// The `https://<ip>:<port>` urls for the advertised addresses. HTTPS: the
/// companion serves the phone browser a self-signed cert (see [`crate::lan::tls`])
/// so the origin is a secure context.
pub fn urls_for(ips: &[Ipv4Addr], port: u16) -> Vec<String> {
    ips.iter()
        .map(|ip| format!("https://{ip}:{port}"))
        .collect()
}

/// The `<ip>:<port>` host strings we accept in a `Host`/`Origin` header. Always
/// includes `localhost:<port>` and `127.0.0.1:<port>` (a phone browser may resolve
/// either) plus every advertised IP.
pub fn bound_hosts_for(ips: &[Ipv4Addr], port: u16) -> Vec<String> {
    let mut hosts = vec![
        format!("localhost:{port}"),
        format!("127.0.0.1:{port}"),
    ];
    for ip in ips {
        let h = format!("{ip}:{port}");
        if !hosts.contains(&h) {
            hosts.push(h);
        }
    }
    hosts
}

/// Bind a `std::net::TcpListener`, scanning DEFAULT_PORT..=DEFAULT_PORT+PORT_SCAN
/// when the preferred port is already in use. Returns the listener and the port it
/// landed on. A non-`AddrInUse` error (e.g. permission) fails immediately. A sync
/// bind is fine here — it's fast and runs under the lifecycle lock — and
/// `axum_server::from_tcp_rustls` takes a `std::net::TcpListener` directly.
///
/// The listener is set NON-BLOCKING: `axum_server` hands it to
/// `tokio::net::TcpListener::from_std`, which requires a non-blocking socket — a
/// blocking one leaves the async accept loop unable to see readiness, so
/// connections TCP-connect but their TLS handshake never runs (they hang).
fn bind_listener(bind_ip: IpAddr) -> AppResult<(std::net::TcpListener, u16)> {
    let mut last_err: Option<std::io::Error> = None;
    for port in DEFAULT_PORT..=DEFAULT_PORT.saturating_add(PORT_SCAN) {
        let addr = SocketAddr::new(bind_ip, port);
        match std::net::TcpListener::bind(addr) {
            Ok(listener) => {
                // The bind SUCCEEDED; a set_nonblocking failure is a distinct
                // condition, so it gets its own message (not `bind_error`'s "could
                // not bind", which would misattribute the failure).
                listener.set_nonblocking(true).map_err(|e| {
                    AppError::Command(format!(
                        "could not configure the phone-companion listener (set_nonblocking) on {bind_ip}: {e}"
                    ))
                })?;
                return Ok((listener, port));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                last_err = Some(e);
                continue;
            }
            Err(e) => return Err(bind_error(bind_ip, &e)),
        }
    }
    Err(AppError::Command(format!(
        "could not bind the phone-companion server: ports {}–{} on {} are all in use{}",
        DEFAULT_PORT,
        DEFAULT_PORT.saturating_add(PORT_SCAN),
        bind_ip,
        last_err
            .map(|e| format!(" ({e})"))
            .unwrap_or_default(),
    )))
}

fn bind_error(bind_ip: IpAddr, e: &std::io::Error) -> AppError {
    AppError::Command(format!(
        "could not bind the phone-companion server on {} (ports {}–{}): {e}",
        bind_ip,
        DEFAULT_PORT,
        DEFAULT_PORT.saturating_add(PORT_SCAN),
    ))
}

/// Start the server: resolve addresses, ensure the TLS material, bind, spawn the
/// TLS serve task with graceful shutdown wired to an `axum_server::Handle`, and
/// return the handle plus the advertised urls, the bound-host allowlist, and the
/// certificate fingerprint (for the TOFU pairing display). The `RouterState` is
/// built here so the host guard sees the exact hosts we bound.
// The params are the individual per-field `Arc`s the router state needs (mirroring
// how `AppState` shares individual fields rather than one `Arc<Whole>`); passing them
// explicitly keeps the caller (`lan_enable`) the single owner of the `LanState`
// fields. Bundling them into a struct just to satisfy the arg-count lint would add a
// parallel type with no behavioral gain, so the lint is allowed here by design.
#[allow(clippy::too_many_arguments)]
pub async fn start(
    bind_lan: bool,
    active_repo: Arc<std::sync::Mutex<Option<String>>>,
    active_repo_id: Arc<std::sync::Mutex<Option<String>>>,
    repos: crate::lan::RepoRegistry,
    pairing: Arc<std::sync::Mutex<Option<auth::PairingSession>>>,
    rate_limit: auth::RateLimitMap,
    streams: Arc<std::sync::Mutex<std::collections::HashMap<String, crate::state::StreamInfo>>>,
    monitor_cut: tokio::sync::broadcast::Sender<crate::lan::MonitorCut>,
) -> AppResult<(ServerHandle, Vec<String>, Vec<String>, String)> {
    let (bind_ip, ips) = resolve_ips(bind_lan);
    // Ensure a self-signed cert covering the addresses we're about to advertise
    // (reused across IP churn so the fingerprint — the TOFU anchor — stays stable).
    let material = tls::ensure_tls(&ips)?;
    let fingerprint = material.fingerprint.clone();
    let (listener, port) = bind_listener(bind_ip)?;
    let urls = urls_for(&ips, port);
    let bound_hosts = bound_hosts_for(&ips, port);

    let state = RouterState {
        active_repo,
        active_repo_id,
        repos,
        pairing,
        rate_limit,
        bound_hosts: Arc::new(bound_hosts.clone()),
        streams,
        monitor_cut,
    };
    let router = build_router(state);

    let handle = Handle::new();
    let serve_handle = handle.clone();
    let tls_config = RustlsConfig::from_config(material.config);
    // Build the TLS server BEFORE spawning: `from_tcp_rustls` is synchronous and
    // fallible (it wraps the std listener into a tokio one), so its failure must
    // propagate out of `start()` as an error — otherwise the caller would store a
    // RunningServer, flip the tray to "sharing on", and advertise urls + fingerprint
    // while nothing is actually serving. Only the async `.serve(...)` goes in the task.
    let server = axum_server::from_tcp_rustls(listener, tls_config).map_err(|e| {
        AppError::Command(format!(
            "could not construct the phone-companion TLS server on {bind_ip}: {e}"
        ))
    })?;
    // Quit-time teardown is IMPLICIT: `app.exit(0)` from the tray kills the
    // process, which drops the listener — so there's no exit-site hook to add.
    // A user-driven `lan_disable` calls `ServerHandle::shutdown`, which drives this
    // handle's graceful shutdown. (Sleep auto-off is a known later-slice gap — not
    // handled here.)
    let task = tauri::async_runtime::spawn(async move {
        if let Err(e) = server
            .handle(serve_handle)
            .serve(router.into_make_service_with_connect_info::<SocketAddr>())
            .await
        {
            // The listener died unexpectedly (not a graceful shutdown). Nothing to
            // recover to here; log to stderr so a dev sees it.
            eprintln!("lan companion server exited with error: {e}");
        }
    });

    Ok((
        ServerHandle { port, handle, task },
        urls,
        bound_hosts,
        fingerprint,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_mode_advertises_localhost_only() {
        let (bind_ip, ips) = resolve_ips(false);
        assert_eq!(bind_ip, IpAddr::V4(Ipv4Addr::LOCALHOST));
        assert_eq!(ips, vec![Ipv4Addr::LOCALHOST]);
        assert_eq!(urls_for(&ips, 38473), vec!["https://127.0.0.1:38473"]);
    }

    #[test]
    fn bound_hosts_always_include_localhost_and_loopback() {
        let hosts = bound_hosts_for(&[Ipv4Addr::new(192, 168, 1, 5)], 38473);
        assert!(hosts.contains(&"localhost:38473".to_string()));
        assert!(hosts.contains(&"127.0.0.1:38473".to_string()));
        assert!(hosts.contains(&"192.168.1.5:38473".to_string()));
    }

    #[test]
    fn lan_mode_binds_unspecified() {
        // We can't assert on the machine's real interfaces, but the bind IP must
        // be 0.0.0.0 and at least one advertised url must exist.
        let (bind_ip, ips) = resolve_ips(true);
        assert_eq!(bind_ip, IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        assert!(!ips.is_empty());
    }

    #[test]
    fn rank_ips_leads_with_the_reachable_lan_address() {
        // The user's real case: a VPN 10.x enumerates before the physical 192.168.x,
        // but the phone-reachable 192.168.x must lead (the QR uses `first()`).
        let ranked = rank_ips(vec![
            ("VPN".to_string(), Ipv4Addr::new(10, 8, 0, 3)),
            ("Wi-Fi".to_string(), Ipv4Addr::new(192, 168, 1, 20)),
        ]);
        assert_eq!(ranked.first(), Some(&Ipv4Addr::new(192, 168, 1, 20)));
        assert_eq!(ranked, vec![Ipv4Addr::new(192, 168, 1, 20), Ipv4Addr::new(10, 8, 0, 3)]);
    }

    #[test]
    fn rank_ips_demotes_docker_by_name_and_by_class() {
        // A Docker 172.17.x is demoted BOTH by its interface name (+10) and its
        // class (172.16/12 → 2), landing below a real 192.168.x. Even a Docker
        // address that happened to be a 192.168.x is demoted below the physical one
        // by the name penalty alone.
        let ranked = rank_ips(vec![
            ("vEthernet (Default Switch)".to_string(), Ipv4Addr::new(172, 17, 0, 1)),
            ("docker0".to_string(), Ipv4Addr::new(192, 168, 99, 1)),
            ("Ethernet".to_string(), Ipv4Addr::new(192, 168, 1, 10)),
        ]);
        assert_eq!(ranked.first(), Some(&Ipv4Addr::new(192, 168, 1, 10)));
        // The two virtual adapters both rank after the physical one.
        assert_eq!(ranked[0], Ipv4Addr::new(192, 168, 1, 10));
        assert!(ranked.contains(&Ipv4Addr::new(172, 17, 0, 1)));
        assert!(ranked.contains(&Ipv4Addr::new(192, 168, 99, 1)));
    }

    #[test]
    fn rank_ips_puts_link_local_last() {
        let ranked = rank_ips(vec![
            ("APIPA".to_string(), Ipv4Addr::new(169, 254, 1, 1)),
            ("Ethernet".to_string(), Ipv4Addr::new(10, 0, 0, 5)),
        ]);
        assert_eq!(ranked, vec![Ipv4Addr::new(10, 0, 0, 5), Ipv4Addr::new(169, 254, 1, 1)]);
    }

    #[test]
    fn rank_ips_dedups_keeping_first() {
        // The same address on two interfaces appears once, at its best rank.
        let ranked = rank_ips(vec![
            ("Wi-Fi".to_string(), Ipv4Addr::new(192, 168, 1, 5)),
            ("Ethernet".to_string(), Ipv4Addr::new(192, 168, 1, 5)),
        ]);
        assert_eq!(ranked, vec![Ipv4Addr::new(192, 168, 1, 5)]);
    }

    #[test]
    fn rank_ips_empty_input() {
        assert!(rank_ips(Vec::new()).is_empty());
    }

    #[test]
    fn tap_token_matches_adapters_not_laptop() {
        // The three named cases: TAP virtual adapters match; "laptop" (which merely
        // embeds the letters) does NOT.
        assert!(name_has_tap_token("tap-windows adapter v9"));
        assert!(name_has_tap_token("openvpn tap"));
        assert!(!name_has_tap_token("laptop dock ethernet"));
        // A numbered tap adapter (tap0) still matches; a bare physical name doesn't.
        assert!(name_has_tap_token("tap0"));
        assert!(!name_has_tap_token("wi-fi"));
    }

    #[test]
    fn rank_ips_does_not_demote_a_laptop_named_adapter() {
        // A physical adapter whose name contains "laptop" must NOT be demoted by the
        // tap marker — it should lead a genuinely virtual TAP adapter in the same class.
        let ranked = rank_ips(vec![
            ("TAP-Windows Adapter V9".to_string(), Ipv4Addr::new(192, 168, 1, 8)),
            ("Laptop Dock Ethernet".to_string(), Ipv4Addr::new(192, 168, 1, 4)),
        ]);
        assert_eq!(ranked.first(), Some(&Ipv4Addr::new(192, 168, 1, 4)));
    }
}
