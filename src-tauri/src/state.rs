use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{broadcast, Mutex, Notify, OnceCell};

use crate::agent::ReviewEvent;
use crate::git::types::GitInfo;

/// Buffer depth for a live stream's broadcast channel. A LAN subscriber that
/// falls this far behind gets a `Lagged` notification (surfaced as a synthetic
/// "skipped N events" status frame) rather than blocking the producer — the
/// desktop `Channel` leg is never affected.
const STREAM_BROADCAST_CAPACITY: usize = 256;

/// A live agent stream (review or session) that LAN subscribers can watch. The
/// broadcast sender fans each [`ReviewEvent`] out to any number of receivers; a
/// stream with no receivers still sends fine (the producer's `send` just returns
/// `Err`, which is ignored). The entry lives exactly as long as the streaming
/// run — it is registered before the run and cleared on every exit path.
pub struct StreamInfo {
    pub tx: broadcast::Sender<ReviewEvent>,
    /// `"review"` or `"session"`.
    pub kind: String,
    /// ISO-8601 (millis + `Z`), matching every other timestamp the app writes.
    pub started_at: String,
    /// The repo the streaming run operates on; the LAN routes authorize against
    /// it so a paired device only ever watches streams belonging to the
    /// currently-shared repo (never one on a repo the desktop has since closed or
    /// switched away from). Not exposed on the wire — used only for scoping.
    pub repo_path: String,
}

/// The shared live-stream registry handle. `AppState` owns one and hands a clone
/// to the LAN router (via [`AppState::streams_arc`]), so both see the same map.
pub type StreamRegistry = Arc<StdMutex<HashMap<String, StreamInfo>>>;

/// A `(id, kind, started_at)` snapshot of a stream registry — the shape the LAN
/// enumeration route serializes. A free fn so both [`AppState::stream_snapshot`]
/// and the LAN router (which holds only the shared [`StreamRegistry`], not the
/// whole `AppState`) share one implementation.
pub fn snapshot_streams(registry: &StreamRegistry) -> Vec<(String, String, String)> {
    registry
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .map(|(id, info)| (id.clone(), info.kind.clone(), info.started_at.clone()))
        .collect()
}

/// Subscribe to a registry stream by id, or `None` when none is active. Shared by
/// [`AppState::subscribe_stream`] and the LAN watch route (see [`snapshot_streams`]).
pub fn subscribe_in(registry: &StreamRegistry, id: &str) -> Option<broadcast::Receiver<ReviewEvent>> {
    registry
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(id)
        .map(|info| info.tx.subscribe())
}

/// Whether two repo paths refer to the same repo for LAN stream authorization.
/// Equal if the raw strings match (the common case — both originate from the same
/// frontend `repoPath`), OR if both canonicalize successfully to the same path
/// (hardens against `/` vs `\` and drive-letter case on Windows). Canonicalization
/// touches the filesystem, so it's the fallback, not the primary check.
///
/// `pub(crate)` so the LAN scoped-cut path ([`crate::lan::routes::reviews`]) and the
/// `/api/repos` `active`-flag computation share this exact equality — a repo's
/// active-vs-shared identity, its stream-scoping, and its cut-scoping must all agree.
pub(crate) fn repo_paths_match(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// Like [`snapshot_streams`], but returns only streams whose `repo_path` matches
/// `repo` (per [`repo_paths_match`]) — the LAN enumeration route uses this so a
/// paired device sees only streams on the currently-shared repo. The tuple shape
/// is unchanged (`(id, kind, started_at)`); the repo path is never exposed.
pub fn snapshot_streams_for(registry: &StreamRegistry, repo: &str) -> Vec<(String, String, String)> {
    registry
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .iter()
        .filter(|(_, info)| repo_paths_match(&info.repo_path, repo))
        .map(|(id, info)| (id.clone(), info.kind.clone(), info.started_at.clone()))
        .collect()
}

/// Like [`subscribe_in`], but returns `None` unless the stream's `repo_path`
/// matches `repo` (per [`repo_paths_match`]). A stream belonging to a different
/// repo is indistinguishable from an unknown id — deliberately no oracle, so a
/// paired device can't probe for streams on repos the desktop isn't sharing.
pub fn subscribe_in_for(
    registry: &StreamRegistry,
    id: &str,
    repo: &str,
) -> Option<broadcast::Receiver<ReviewEvent>> {
    registry
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(id)
        .filter(|info| repo_paths_match(&info.repo_path, repo))
        .map(|info| info.tx.subscribe())
}

pub struct AppState {
    repo_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    pub git_info: OnceCell<GitInfo>,
    /// In-flight agent-CLI reviews keyed by a frontend-supplied id, so a
    /// separate cancel command can signal the streaming run to stop.
    agent_cancels: Mutex<HashMap<String, Arc<Notify>>>,
    /// Live agent streams (reviews/sessions) keyed by their frontend-supplied id,
    /// so the LAN companion can enumerate active streams and fan their events out
    /// to WebSocket subscribers alongside the desktop channel. A `std::Mutex` —
    /// every access is a short, synchronous critical section (never held across an
    /// `.await`). Shared with the LAN router via [`AppState::streams_arc`].
    active_streams: StreamRegistry,
    /// Whether closing the window hides the app to the tray (keeping it running)
    /// instead of quitting. Mirrors the user's setting, pushed from the frontend;
    /// defaults to true so the first close behaves correctly before that sync.
    close_to_tray: AtomicBool,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            repo_locks: Mutex::new(HashMap::new()),
            git_info: OnceCell::new(),
            agent_cancels: Mutex::new(HashMap::new()),
            active_streams: Arc::new(StdMutex::new(HashMap::new())),
            close_to_tray: AtomicBool::new(true),
        }
    }
}

impl AppState {
    /// Per-repo lock serializing mutating git operations so concurrent
    /// invocations don't fight over .git/index.lock.
    pub async fn repo_lock(&self, repo_path: &str) -> Arc<Mutex<()>> {
        let mut map = self.repo_locks.lock().await;
        map.entry(PathBuf::from(repo_path))
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Registers a cancellation handle for a review id and returns it. The
    /// caller awaits `notified()` and must call `clear_agent_cancel` when done.
    pub async fn register_agent_cancel(&self, id: &str) -> Arc<Notify> {
        let notify = Arc::new(Notify::new());
        self.agent_cancels
            .lock()
            .await
            .insert(id.to_string(), notify.clone());
        notify
    }

    pub async fn clear_agent_cancel(&self, id: &str) {
        self.agent_cancels.lock().await.remove(id);
    }

    /// Signals an in-flight review to cancel. No-op if the id is unknown.
    pub async fn cancel_agent(&self, id: &str) {
        if let Some(notify) = self.agent_cancels.lock().await.get(id) {
            notify.notify_waiters();
        }
    }

    /// Register a live stream `id` (`kind` = `"review"` | `"session"`) operating on
    /// `repo_path` (recorded so the LAN routes can scope watching to the shared
    /// repo), returning the broadcast sender the run fans its [`ReviewEvent`]s out
    /// through. The caller must [`clear_stream`](Self::clear_stream) on every exit
    /// path so the entry's lifetime matches the streaming run's (no leaked
    /// entries). A prior entry under the same id is replaced.
    pub fn register_stream(&self, id: &str, kind: &str, repo_path: &str) -> broadcast::Sender<ReviewEvent> {
        let (tx, _rx) = broadcast::channel(STREAM_BROADCAST_CAPACITY);
        let info = StreamInfo {
            tx: tx.clone(),
            kind: kind.to_string(),
            started_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            repo_path: repo_path.to_string(),
        };
        self.active_streams
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id.to_string(), info);
        tx
    }

    /// Remove a stream's registry entry. Dropping the stored sender makes any
    /// LAN subscriber's `recv()` observe `Closed`, ending its socket cleanly.
    pub fn clear_stream(&self, id: &str) {
        self.active_streams
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
    }

    /// A snapshot of the active streams as `(id, kind, started_at)` tuples, for
    /// the LAN enumeration route. Cheap clone; the lock is released immediately.
    ///
    /// Convenience over [`snapshot_streams`] for callers holding an `AppState`.
    /// Production's LAN route holds only the shared [`StreamRegistry`] and calls
    /// the free fn directly, so this wrapper is used only by the unit tests —
    /// hence the `dead_code` allow (it's a deliberate, tested part of the API).
    #[allow(dead_code)]
    pub fn stream_snapshot(&self) -> Vec<(String, String, String)> {
        snapshot_streams(&self.active_streams)
    }

    /// Subscribe to a live stream's events, or `None` if no stream with that id is
    /// currently active. The returned receiver observes `Closed` once the stream
    /// ends and [`clear_stream`](Self::clear_stream) drops the sender.
    ///
    /// Convenience over [`subscribe_in`] for `AppState` holders; production's LAN
    /// watch route uses the free fn against the shared [`StreamRegistry`], so this
    /// wrapper is exercised only by the unit tests (see `stream_snapshot`).
    #[allow(dead_code)]
    pub fn subscribe_stream(&self, id: &str) -> Option<broadcast::Receiver<ReviewEvent>> {
        subscribe_in(&self.active_streams, id)
    }

    /// A clone of the shared stream-registry handle, for the LAN router state. The
    /// router holds the SAME `Arc` this `AppState` does, so a stream registered
    /// here is visible to the LAN routes without any further plumbing.
    pub fn streams_arc(&self) -> StreamRegistry {
        self.active_streams.clone()
    }

    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }

    pub fn set_close_to_tray(&self, enabled: bool) {
        self.close_to_tray.store(enabled, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::broadcast::error::TryRecvError;

    #[test]
    fn register_subscribe_deliver_snapshot() {
        let state = AppState::default();
        // A fresh state has no active streams.
        assert!(state.stream_snapshot().is_empty());

        let tx = state.register_stream("rev-1", "review", "C:/repo");
        // The snapshot reflects the registration (id, kind, and a non-empty ISO ts).
        let snap = state.stream_snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].0, "rev-1");
        assert_eq!(snap[0].1, "review");
        assert!(snap[0].2.ends_with('Z'));

        // A subscriber taken from the registry receives what the sender broadcasts.
        let mut rx = state.subscribe_stream("rev-1").expect("stream is active");
        tx.send(ReviewEvent::Delta {
            text: "hello".to_string(),
        })
        .expect("a live subscriber exists");
        match rx.try_recv() {
            Ok(ReviewEvent::Delta { text }) => assert_eq!(text, "hello"),
            other => panic!("expected the delta, got {other:?}"),
        }
    }

    #[test]
    fn clear_removes_entry_and_closes_subscribers() {
        let state = AppState::default();
        let _tx = state.register_stream("sess-1", "session", "C:/repo");
        let mut rx = state.subscribe_stream("sess-1").expect("stream is active");

        // Clearing drops the stored sender...
        state.clear_stream("sess-1");
        // ...so the registry is empty again (no leak) and a fresh subscribe misses.
        assert!(state.stream_snapshot().is_empty());
        assert!(state.subscribe_stream("sess-1").is_none());

        // An already-open receiver observes Closed once the sender is gone. (The
        // local `_tx` we still hold is the ONLY remaining sender; drop it so the
        // channel actually closes — this mirrors production, where `clear_stream`
        // removing the registry entry drops the last sender.)
        drop(_tx);
        assert!(matches!(rx.try_recv(), Err(TryRecvError::Closed)));
    }

    #[test]
    fn subscribe_after_clear_is_none() {
        let state = AppState::default();
        state.register_stream("x", "review", "C:/repo");
        state.clear_stream("x");
        assert!(state.subscribe_stream("x").is_none());
    }

    #[test]
    fn streams_arc_shares_the_same_registry() {
        // The Arc handed to the LAN router is the SAME map the AppState mutates, so
        // a stream registered on the state is visible through the shared handle.
        let state = AppState::default();
        let shared = state.streams_arc();
        state.register_stream("rev-1", "review", "C:/repo");
        assert!(shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key("rev-1"));
        state.clear_stream("rev-1");
        assert!(shared.lock().unwrap_or_else(|p| p.into_inner()).is_empty());
    }

    #[test]
    fn scoped_snapshot_and_subscribe_filter_by_repo() {
        // Two streams on different repos; scoping to one repo sees only its stream,
        // and the other repo's id is indistinguishable from an unknown id (None).
        let state = AppState::default();
        let registry = state.streams_arc();
        state.register_stream("rev-a", "review", "C:/repo");
        state.register_stream("rev-b", "review", "C:/other");
        // A write SESSION spawned from the shared repo registers under its ORIGIN
        // repo (`C:/repo`), even though it runs in a `gd/session/*` worktree — so it
        // must stay visible when scoping to `C:/repo`. (This is the product behavior
        // the origin_repo_path plumbing exists for: sessions keep phone visibility.)
        state.register_stream("sess-c", "session", "C:/repo");

        // The unscoped snapshot sees all three (the desktop's own surface).
        assert_eq!(snapshot_streams(&registry).len(), 3);

        // Scoped to C:/repo: rev-a AND the origin-registered session, but not rev-b
        // (raw string equality — no filesystem touch).
        let mut scoped: Vec<String> = snapshot_streams_for(&registry, "C:/repo")
            .into_iter()
            .map(|(id, _, _)| id)
            .collect();
        scoped.sort();
        assert_eq!(scoped, vec!["rev-a".to_string(), "sess-c".to_string()]);

        // Subscribing under the matching repo works; under the wrong repo it's None
        // even though the id exists (no oracle for out-of-scope streams).
        assert!(subscribe_in_for(&registry, "rev-a", "C:/repo").is_some());
        assert!(subscribe_in_for(&registry, "rev-b", "C:/repo").is_none());
        assert!(subscribe_in_for(&registry, "does-not-exist", "C:/repo").is_none());
    }
}
