//! Read-only live-monitoring routes: enumerate the desktop's active agent
//! streams (reviews/sessions) and watch one over a WebSocket.
//!
//! These sit under the authed `/api/` subtree, so the same `require_auth` +
//! `host_guard` middleware that gates every other read route also gates the
//! enumeration AND the WebSocket upgrade (the upgrade is a normal GET request
//! until the handler accepts it — the auth layer runs first and 401s an
//! unauthenticated upgrade before this handler is ever reached).
//!
//! Monitoring is strictly one-way: the phone WATCHES the same [`ReviewEvent`]
//! stream the desktop renders. There is no approve/deny, no stdin, and no write
//! path — inbound client frames are drained and ignored (except a Close).
//!
//! **Scoped to the shared repo.** Both routes authorize against the currently-
//! shared repo: with no active repo they 409 like every other read route, and
//! they only ever surface streams whose run operates on that repo. A stream on a
//! repo the desktop has since closed or switched away from is invisible — the
//! enumeration omits it and the watch route 404s it (indistinguishable from an
//! unknown id, so there's no probe oracle). This upholds the clear-on-close
//! containment: paired devices never watch a run on a repo that isn't shared.
//!
//! **In-flight sockets are actively cut.** Scoping only gates NEW requests; a
//! WebSocket accepted while a repo was shared is hijacked out of the serve loop
//! and would keep forwarding after the desktop disables sharing, switches/clears
//! the shared repo, or revokes the device (auth runs only at upgrade time). So
//! [`forward_stream`] also selects on a broadcast cut signal
//! ([`crate::lan::LanState::monitor_cut`]) that the desktop fires at each of
//! those lifecycle points; on a cut the socket is closed and the phone must
//! reconnect and re-authorize.
//!
//! **No replay.** The underlying channel is a `tokio::sync::broadcast` with no
//! history, so a subscriber that connects mid-stream sees only events emitted
//! *after* it subscribed; earlier deltas are not resent. Acceptable for v1 (the
//! phone opens the stream to follow along, not to reconstruct the full transcript).

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use crate::agent::ReviewEvent;
use crate::lan::auth::RouterState;
use crate::lan::routes::repo_or_409;
use crate::state::{snapshot_streams_for, subscribe_in_for};

/// GET /api/reviews — the active agent streams the phone can watch, as
/// `[{ id, kind, startedAt }]` (camelCase). `kind` is `"review"` | `"session"`.
/// Scoped to the currently-shared repo: a `None` active repo 409s (like every
/// other read route), and only streams operating on that repo are listed — a
/// device never sees streams from a repo the desktop has closed or switched away
/// from. Repo paths are never exposed on the wire.
pub async fn list(State(state): State<RouterState>) -> Response {
    let repo = repo_or_409!(state);
    let items: Vec<_> = snapshot_streams_for(&state.streams, &repo)
        .into_iter()
        .map(|(id, kind, started_at)| {
            json!({
                "id": id,
                "kind": kind,
                "startedAt": started_at,
            })
        })
        .collect();
    (StatusCode::OK, Json(items)).into_response()
}

/// GET /api/reviews/{id}/stream — upgrade to a WebSocket that forwards the live
/// stream's [`ReviewEvent`]s as they happen. Scoped to the currently-shared repo:
/// a `None` active repo 409s, and a stream on any other repo is treated as
/// unknown (404) — a device can't probe for or watch streams outside the shared
/// repo. An unknown/out-of-scope id 404s BEFORE the upgrade (no socket is opened
/// for a stream that isn't running or isn't ours to share).
pub async fn stream(
    State(state): State<RouterState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    let repo = repo_or_409!(state);
    // Subscribe up front so we can reject an unknown (or out-of-scope) id with a
    // plain 404 instead of upgrading and immediately closing. Scoping to `repo`
    // here means a stream on a different repo is indistinguishable from an unknown
    // id. Subscribing now also means we don't miss events between the upgrade
    // handshake and the receive loop starting.
    let rx = subscribe_in_for(&state.streams, &id, &repo);
    let Some(rx) = rx else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "kind": "noSuchStream",
                "message": "no active stream with that id"
            })),
        )
            .into_response();
    };
    // Subscribe to the lifecycle cut signal BEFORE upgrading, so a cut fired
    // between here and the pump starting isn't missed. Auth ran at upgrade time
    // only; this receiver is how a later disable / repo-switch / revoke reaches an
    // already-accepted socket and forces it closed.
    let cut_rx = state.monitor_cut.subscribe();
    ws.on_upgrade(move |socket| forward_stream(socket, rx, cut_rx))
}

/// The per-connection pump: forward each broadcast event as one JSON text frame,
/// translate lag/close, and drain inbound client frames (read-only monitor — no
/// stdin path exists). Terminates on the terminal `Done`/`Error` event, on the
/// stream ending (`Closed`), or when the client hangs up.
async fn forward_stream(
    mut socket: WebSocket,
    mut rx: tokio::sync::broadcast::Receiver<ReviewEvent>,
    mut cut_rx: tokio::sync::broadcast::Receiver<()>,
) {
    loop {
        tokio::select! {
            // `biased` + cut-first: when a cut and an event are both ready, the
            // cut wins — a just-revoked/disabled socket never forwards one more
            // buffered frame before it honors the sever.
            biased;
            // Lifecycle cut: sharing was disabled, the shared repo changed, or a
            // device was revoked — sever this socket unconditionally so the phone
            // must reconnect and re-authorize against the new state. ANY result
            // ends the loop: Ok is a real cut; Lagged means we missed one but a cut
            // still happened; Closed can't occur while `LanState` holds the Sender,
            // but we match it defensively and treat it the same (terminate).
            _cut = cut_rx.recv() => {
                break;
            }
            // Broadcast side: forward events to the client.
            recv = rx.recv() => match recv {
                Ok(ev) => {
                    // Terminal? Forward it, then close the socket cleanly.
                    let terminal = matches!(ev, ReviewEvent::Done { .. } | ReviewEvent::Error { .. });
                    // The wire format is ReviewEvent's own tagged camelCase serde,
                    // verbatim — the same JSON the desktop channel carries.
                    let Ok(text) = serde_json::to_string(&ev) else {
                        // A ReviewEvent that won't serialize is a bug, not a
                        // client-recoverable state; drop the connection.
                        break;
                    };
                    if socket.send(Message::Text(text.into())).await.is_err() {
                        break; // client went away
                    }
                    if terminal {
                        break;
                    }
                }
                Err(RecvError::Lagged(n)) => {
                    // The subscriber fell behind the 256-deep buffer. Tell it how
                    // many events it missed (a synthetic status frame) and keep
                    // going — recv() resumes from the oldest still-buffered event.
                    let notice = json!({
                        "kind": "status",
                        "text": format!("…skipped {n} events")
                    })
                    .to_string();
                    if socket.send(Message::Text(notice.into())).await.is_err() {
                        break;
                    }
                }
                // The stream ended and its registry entry (and sender) dropped.
                Err(RecvError::Closed) => break,
            },
            // Client side: a read-only monitor. Drain frames; act only on Close.
            inbound = socket.recv() => match inbound {
                Some(Ok(Message::Close(_))) | None => break,
                Some(Ok(_)) => { /* ignore data/ping/pong — no stdin path exists */ }
                Some(Err(_)) => break,
            },
        }
    }
    // Best-effort graceful close (ignored if the socket is already gone).
    let _ = socket.send(Message::Close(None)).await;
}
