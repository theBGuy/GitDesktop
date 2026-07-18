//! Read-only live-monitoring routes: enumerate the desktop's active agent
//! streams (reviews/sessions) and watch one over a Server-Sent-Events stream.
//!
//! These sit under the authed `/api/` subtree, so the same `require_auth` +
//! `host_guard` middleware that gates every other read route also gates the
//! enumeration AND the SSE stream (the stream is a normal GET request — the auth
//! layer runs first and 401s an unauthenticated request before this handler is
//! ever reached).
//!
//! Monitoring is strictly one-way: the phone WATCHES the same [`ReviewEvent`]
//! stream the desktop renders. There is no approve/deny, no stdin, and no write
//! path. SSE is a one-way transport BY CONSTRUCTION — an [`EventSource`] can only
//! receive — which is exactly the property this route wants; the previous
//! WebSocket impl drained and ignored all inbound client frames anyway, so nothing
//! is lost by the switch.
//!
//! ## Why SSE and not a WebSocket
//!
//! Serving over self-signed HTTPS (see [`crate::lan::tls`]) hits a load-bearing
//! iOS Safari gotcha:
//! Safari does NOT extend a manually-accepted self-signed-certificate exception to
//! `wss://` — a WebSocket over TLS goes through a SEPARATE trust path that ignores
//! the exception the user granted the `https://` origin (an unfixed WebKit
//! limitation). An `EventSource`, by contrast, is a plain HTTP request that rides
//! the already-excepted `https://` origin, so it just works once the page loads.
//! No companion client consumes this stream yet (slice 3 wires it), so swapping the
//! transport now — before any client depends on the WS wire — is free.
//!
//! ## EventSource reconnect semantics (handled by construction)
//!
//! After a lifecycle cut the stream simply ENDS; the browser's `EventSource`
//! auto-reconnects, and that reconnect hits a non-200 — 401 if the device was
//! revoked, 404 if the stream is gone or the shared repo switched away. A non-200
//! response permanently closes an `EventSource` (it does not retry a hard error),
//! so the cut is durable with nothing extra server-side. A clean terminal
//! (`Done`/`Error`) behaves the same way: the stream ends, the reconnect 404s the
//! now-absent stream, and the client stays closed. The slice-3 client
//! probe-classifies that reconnect status (401 vs 404) to tell "revoked" from
//! "stream ended"; the server needs no event ids or named event types for this.
//!
//! ## Scoped to the shared repo
//!
//! Both routes authorize against the request's resolved repo (from the
//! `Extension<ScopedRepo>` a resolver middleware inserts): the alias mount scopes
//! to the desktop's active repo (a `None` active repo 409s), and either mount only
//! ever surfaces streams whose run operates on that repo. A stream on a repo the
//! desktop has since closed or switched away from is invisible — the enumeration
//! omits it and the watch route 404s it (indistinguishable from an unknown id, so
//! there's no probe oracle). This upholds the clear-on-close containment: paired
//! devices never watch a run on a repo that isn't shared.
//!
//! ## In-flight streams are actively cut
//!
//! Scoping only gates NEW requests; an SSE stream accepted while a repo was shared
//! would keep forwarding after the desktop disables sharing, switches/clears the
//! shared repo, or revokes the device (auth runs only at request time). So
//! [`forward_stream`] also selects on a broadcast cut signal
//! ([`crate::lan::LanState::monitor_cut`]) that the desktop fires at each of those
//! lifecycle points; on a cut the stream ends and the phone must reconnect and
//! re-authorize (see the reconnect-semantics section above).
//!
//! ## No replay
//!
//! The underlying channel is a `tokio::sync::broadcast` with no history, so a
//! subscriber that connects mid-stream sees only events emitted *after* it
//! subscribed; earlier deltas are not resent. Acceptable for v1 (the phone opens
//! the stream to follow along, not to reconstruct the full transcript).

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::Extension;
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;
use tokio::sync::broadcast::error::RecvError;

use crate::agent::ReviewEvent;
use crate::lan::routes::{path_param, ScopedRepo};
use crate::state::{snapshot_streams_for, subscribe_in_for};

/// GET reviews — the active agent streams the phone can watch, as
/// `[{ id, kind, startedAt }]` (camelCase). `kind` is `"review"` | `"session"`.
/// Scoped to the request's repo (from `Extension<ScopedRepo>`): only streams
/// operating on that repo are listed — a device never sees streams from a repo the
/// desktop has closed or switched away from. Repo paths are never exposed on the
/// wire. (Alias: `/api/reviews`, scoped to the active repo — a `None` active repo
/// 409s in the resolver before this handler runs.)
pub async fn list(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    axum::extract::State(state): axum::extract::State<crate::lan::auth::RouterState>,
) -> Response {
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

/// GET reviews stream — an SSE stream forwarding the live run's [`ReviewEvent`]s as
/// they happen. Scoped to the request's repo: a stream on any other repo is treated
/// as unknown (404) — a device can't probe for or watch streams outside the shared
/// repo. An unknown/out-of-scope id 404s BEFORE the stream is opened (no stream is
/// started for a run that isn't running or isn't ours to share). (Alias:
/// `/api/reviews/{id}/stream`, scoped to the active repo.)
pub async fn stream(
    Extension(ScopedRepo(repo)): Extension<ScopedRepo>,
    axum::extract::State(state): axum::extract::State<crate::lan::auth::RouterState>,
    axum::extract::Path(params): axum::extract::Path<std::collections::HashMap<String, String>>,
) -> Response {
    let id = match path_param(&params, "id") {
        Ok(id) => id,
        Err(resp) => return *resp,
    };
    // Subscribe up front so we can reject an unknown (or out-of-scope) id with a
    // plain 404 instead of opening a stream and immediately ending it. Scoping to
    // `repo` here means a stream on a different repo is indistinguishable from an
    // unknown id. Subscribing now also means we don't miss events between this
    // check and the pump starting.
    let Some(rx) = subscribe_in_for(&state.streams, &id, &repo) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "kind": "noSuchStream",
                "message": "no active stream with that id"
            })),
        )
            .into_response();
    };
    // Subscribe to the lifecycle cut signal BEFORE returning the stream, so a cut
    // fired between here and the pump starting isn't missed. Auth ran at request
    // time only; this receiver is how a later disable / repo-switch / revoke reaches
    // an already-open stream and ends it.
    let cut_rx = state.monitor_cut.subscribe();
    // A 15s keep-alive comment defeats phone-side idle timeouts. The LAN has no
    // buffering proxies, so the keep-alive exists purely to keep the connection
    // warm through mobile-OS background timers.
    Sse::new(forward_stream(rx, cut_rx))
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("ka"),
        )
        .into_response()
}

/// The per-connection event stream: forward each broadcast [`ReviewEvent`] as one
/// SSE `data:` payload, translate lag/close, and end on the terminal `Done`/`Error`
/// event, on the stream ending (`Closed`), or on a lifecycle cut. There is NO
/// inbound arm — SSE is one-way, which is the point (see the module docs).
///
/// A hand-rolled [`futures_util::stream::unfold`] over `(rx, cut_rx,
/// terminal_seen)` with a biased inner `select!`, dependency-free (`futures-util`
/// is already a dep; `async-stream` is deliberately not in the tree). The
/// `terminal_seen` flag makes the terminal event's "yield then END on the next
/// poll" explicit: the poll that forwards `Done`/`Error` sets the flag, and the
/// next poll returns `None` to end the stream.
fn forward_stream(
    rx: tokio::sync::broadcast::Receiver<ReviewEvent>,
    cut_rx: tokio::sync::broadcast::Receiver<()>,
) -> impl futures_util::Stream<Item = Result<Event, Infallible>> {
    futures_util::stream::unfold(
        (rx, cut_rx, false),
        |(mut rx, mut cut_rx, terminal_seen)| async move {
            // A terminal event was forwarded on the previous poll — end the stream
            // now (yield then END, exactly as the WS impl did).
            if terminal_seen {
                return None;
            }
            tokio::select! {
                // `biased` + cut-first: when a cut and an event are both ready, the
                // cut wins — a just-revoked/disabled stream never forwards one more
                // buffered frame before it honors the cut.
                biased;
                // Lifecycle cut: sharing was disabled, the shared repo changed, or a
                // device was revoked — end this stream unconditionally so the phone
                // must reconnect and re-authorize against the new state. ANY result
                // ends it: Ok is a real cut; Lagged means we missed one but a cut
                // still happened; Closed can't occur while `LanState` holds the
                // Sender, but we match it defensively and treat it the same (end).
                _cut = cut_rx.recv() => None,
                // Broadcast side: forward events to the client.
                recv = rx.recv() => match recv {
                    Ok(ev) => {
                        // Terminal? Forward it, then end on the NEXT poll.
                        let terminal = matches!(
                            ev,
                            ReviewEvent::Done { .. } | ReviewEvent::Error { .. }
                        );
                        // The wire format is ReviewEvent's own tagged camelCase
                        // serde, verbatim — the same JSON the desktop channel carries
                        // — as one SSE `data:` payload.
                        match serde_json::to_string(&ev) {
                            Ok(text) => Some((
                                Ok(Event::default().data(text)),
                                (rx, cut_rx, terminal),
                            )),
                            // A ReviewEvent that won't serialize is a bug, not a
                            // client-recoverable state; end the stream.
                            Err(_) => None,
                        }
                    }
                    Err(RecvError::Lagged(n)) => {
                        // The subscriber fell behind the buffer. Tell it how many
                        // events it missed (a synthetic status event) and keep going
                        // — recv() resumes from the oldest still-buffered event.
                        let notice = json!({
                            "kind": "status",
                            "text": format!("…skipped {n} events")
                        })
                        .to_string();
                        Some((Ok(Event::default().data(notice)), (rx, cut_rx, false)))
                    }
                    // The stream ended and its registry entry (and sender) dropped.
                    Err(RecvError::Closed) => None,
                },
            }
        },
    )
}
