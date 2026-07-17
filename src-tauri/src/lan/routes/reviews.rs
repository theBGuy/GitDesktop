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
use crate::state::{snapshot_streams, subscribe_in};

/// GET /api/reviews — the active agent streams the phone can watch, as
/// `[{ id, kind, startedAt }]` (camelCase). `kind` is `"review"` | `"session"`.
pub async fn list(State(state): State<RouterState>) -> Response {
    let items: Vec<_> = snapshot_streams(&state.streams)
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
/// stream's [`ReviewEvent`]s as they happen. An unknown id 404s BEFORE the
/// upgrade (no socket is opened for a stream that isn't running).
pub async fn stream(
    State(state): State<RouterState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    // Subscribe up front so we can reject an unknown id with a plain 404 instead
    // of upgrading and immediately closing. Subscribing here also means we don't
    // miss events between the upgrade handshake and the receive loop starting.
    let rx = subscribe_in(&state.streams, &id);
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
    ws.on_upgrade(move |socket| forward_stream(socket, rx))
}

/// The per-connection pump: forward each broadcast event as one JSON text frame,
/// translate lag/close, and drain inbound client frames (read-only monitor — no
/// stdin path exists). Terminates on the terminal `Done`/`Error` event, on the
/// stream ending (`Closed`), or when the client hangs up.
async fn forward_stream(mut socket: WebSocket, mut rx: tokio::sync::broadcast::Receiver<ReviewEvent>) {
    loop {
        tokio::select! {
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
