//! The axum router assembly, listener bind (with port scanning), and graceful
//! shutdown for the LAN companion server.
//!
//! The router mounts EXACTLY the pairing routes plus the read-only routes
//! (structural allowlist — see [`crate::lan::routes`]): the 13 git/forge routes
//! plus the two live-monitoring routes (`/api/reviews` and the
//! `/api/reviews/{id}/stream` WebSocket); anything else 404s. Two middleware
//! layers wrap everything: [`crate::lan::auth::host_guard`] (runs on every
//! request — DNS-rebind defense + hardening headers) and, on the protected
//! subtree only, [`crate::lan::auth::require_auth`] (per-device bearer). The
//! WebSocket upgrade lives inside that protected subtree, so it is bearer-gated
//! and host-guarded like every other read route.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::routing::{get, post};
use axum::Router;
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::error::{AppError, AppResult};
use crate::lan::auth::{self, RouterState};
use crate::lan::routes::{forge, git, reviews};

/// The default port the server tries first — a fixed value in the IANA dynamic /
/// private range (49152–65535 is the strict private range, but the 38400s are
/// conventionally free and memorable). If it's taken we scan the next few.
pub const DEFAULT_PORT: u16 = 38473;

/// How many consecutive ports to try (DEFAULT_PORT ..= DEFAULT_PORT + SCAN) when
/// the first is already in use.
const PORT_SCAN: u16 = 4;

/// A bound, running server: the port it landed on, a shutdown signal, and the
/// task handle. Dropping the handle does not stop the server — call
/// [`ServerHandle::shutdown`].
pub struct ServerHandle {
    pub port: u16,
    shutdown: Arc<Notify>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl ServerHandle {
    /// Signal graceful shutdown and await the serve task's exit.
    pub async fn shutdown(self) {
        // `notify_one` (NOT `notify_waiters`): the serve task registers its
        // `notified()` waiter only on its first poll, and a rapid enable→disable
        // can call shutdown before that. `notify_one` stores a permit so a
        // pre-registration signal is still consumed; `notify_waiters` would be
        // lost, leaving `task.await` pending forever with the lifecycle lock held.
        self.shutdown.notify_one();
        // The serve future observes the notify and returns; join to be sure the
        // listener is released before we (possibly) rebind on a mode change.
        let _ = self.task.await;
    }
}

/// Build the axum router for the given state. Separated from binding so tests can
/// drive it via `tower::ServiceExt::oneshot` without opening a socket.
pub fn build_router(state: RouterState) -> Router {
    // The protected read-only subtree: bearer-auth required.
    let api = Router::new()
        .route("/api/repo/status", get(git::status))
        .route("/api/repo/branches", get(git::branches))
        .route("/api/repo/log", get(git::log))
        .route("/api/repo/commits/{hash}", get(git::commit_details))
        .route("/api/repo/commits/{hash}/diff", get(git::commit_diff))
        .route("/api/repo/diff/working", get(git::diff_working))
        .route("/api/repo/diff/file", get(git::diff_file))
        .route("/api/forge/prs", get(forge::pr_list))
        .route("/api/forge/prs/{number}", get(forge::pr_view))
        .route("/api/forge/issues", get(forge::issue_list))
        .route("/api/forge/issues/{number}", get(forge::issue_view))
        .route("/api/forge/ci/runs", get(forge::ci_run_list))
        .route("/api/forge/ci/runs/{id}", get(forge::ci_run_view))
        // Live-monitoring: enumerate active agent streams + watch one over a
        // WebSocket. Mounted INSIDE this subtree so the upgrade is bearer-gated by
        // `require_auth` below (and host-guarded by the outer layer) exactly like
        // every other read route.
        .route("/api/reviews", get(reviews::list))
        .route("/api/reviews/{id}/stream", get(reviews::stream))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    // The unauthenticated (but rate-limited + host-guarded) pairing routes.
    let pairing = Router::new()
        .route("/api/pair/challenge", post(auth::pair_challenge))
        .route("/api/pair", post(auth::pair_submit));

    // Merge, then wrap EVERYTHING in the host guard (which also stamps the
    // hardening headers on every response, including 404s for unknown paths).
    Router::new()
        .merge(api)
        .merge(pairing)
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
    let mut ips: Vec<Ipv4Addr> = local_ip_address::list_afinet_netifas()
        .map(|ifaces| {
            ifaces
                .into_iter()
                .filter_map(|(_name, ip)| match ip {
                    IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() => Some(v4),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    ips.sort();
    ips.dedup();
    if ips.is_empty() {
        // No LAN interface found — still bind 0.0.0.0 but advertise loopback so
        // the UI has at least one working url.
        ips.push(Ipv4Addr::LOCALHOST);
    }
    (IpAddr::V4(Ipv4Addr::UNSPECIFIED), ips)
}

/// The `http://<ip>:<port>` urls for the advertised addresses.
pub fn urls_for(ips: &[Ipv4Addr], port: u16) -> Vec<String> {
    ips.iter().map(|ip| format!("http://{ip}:{port}")).collect()
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

/// Bind a `TcpListener`, scanning DEFAULT_PORT..=DEFAULT_PORT+PORT_SCAN when the
/// preferred port is already in use. Returns the listener and the port it landed
/// on. A non-`AddrInUse` error (e.g. permission) fails immediately.
async fn bind_listener(bind_ip: IpAddr) -> AppResult<(TcpListener, u16)> {
    let mut last_err: Option<std::io::Error> = None;
    for port in DEFAULT_PORT..=DEFAULT_PORT.saturating_add(PORT_SCAN) {
        let addr = SocketAddr::new(bind_ip, port);
        match TcpListener::bind(addr).await {
            Ok(listener) => return Ok((listener, port)),
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

/// Start the server: resolve addresses, bind, spawn the serve task with graceful
/// shutdown wired to a `Notify`, and return the handle plus the advertised urls
/// and the bound-host allowlist. The `RouterState` is built here so the host
/// guard sees the exact hosts we bound.
pub async fn start(
    bind_lan: bool,
    active_repo: Arc<std::sync::Mutex<Option<String>>>,
    pairing: Arc<std::sync::Mutex<Option<auth::PairingSession>>>,
    rate_limit: auth::RateLimitMap,
    streams: Arc<std::sync::Mutex<std::collections::HashMap<String, crate::state::StreamInfo>>>,
    monitor_cut: tokio::sync::broadcast::Sender<()>,
) -> AppResult<(ServerHandle, Vec<String>, Vec<String>)> {
    let (bind_ip, ips) = resolve_ips(bind_lan);
    let (listener, port) = bind_listener(bind_ip).await?;
    let urls = urls_for(&ips, port);
    let bound_hosts = bound_hosts_for(&ips, port);

    let state = RouterState {
        active_repo,
        pairing,
        rate_limit,
        bound_hosts: Arc::new(bound_hosts.clone()),
        streams,
        monitor_cut,
    };
    let router = build_router(state);

    let shutdown = Arc::new(Notify::new());
    let shutdown_signal = shutdown.clone();
    // Quit-time teardown is IMPLICIT: `app.exit(0)` from the tray kills the
    // process, which drops the listener — so there's no exit-site hook to add.
    // A user-driven `lan_disable` calls `ServerHandle::shutdown`, which notifies
    // this signal for a graceful drain. (Sleep auto-off is a known later-slice
    // gap — not handled here.)
    let task = tauri::async_runtime::spawn(async move {
        let serve = axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            shutdown_signal.notified().await;
        });
        if let Err(e) = serve.await {
            // The listener died unexpectedly (not a graceful shutdown). Nothing to
            // recover to here; log to stderr so a dev sees it.
            eprintln!("lan companion server exited with error: {e}");
        }
    });

    Ok((
        ServerHandle {
            port,
            shutdown,
            task,
        },
        urls,
        bound_hosts,
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
        assert_eq!(urls_for(&ips, 38473), vec!["http://127.0.0.1:38473"]);
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
}
