use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, Notify, OnceCell};

use crate::git::types::GitInfo;

/// The agent cancel registry: run id → the `Notify` the cancel command fires.
type AgentCancels = SyncMutex<HashMap<String, CancelEntry>>;

/// One registry entry. `tombstoned_at` is set ONLY while the entry is a tombstone — one
/// a cancel created ahead of any run — and is the seam both the adoption age-gate and
/// the sweep read; a live run's entry never carries it.
struct CancelEntry {
    notify: Arc<Notify>,
    tombstoned_at: Option<Instant>,
}

impl CancelEntry {
    /// A fresh handle for a live run, so it is never age-checked.
    fn live() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            tombstoned_at: None,
        }
    }

    /// A cancel that found no registered run: same handle, stamped so adoption and the
    /// sweep can tell an adoptable race from a leftover.
    fn tombstone() -> Self {
        Self {
            notify: Arc::new(Notify::new()),
            tombstoned_at: Some(Instant::now()),
        }
    }

    /// A tombstone past the adoption window — its permit belongs to a run that has
    /// already ended.
    fn is_stale_tombstone(&self) -> bool {
        self.tombstoned_at
            .is_some_and(|at| at.elapsed() > TOMBSTONE_ADOPTION_WINDOW)
    }
}

pub struct AppState {
    repo_locks: Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>,
    pub git_info: OnceCell<GitInfo>,
    /// In-flight agent-CLI reviews and sessions keyed by a frontend-supplied id, so a
    /// separate cancel command can signal the streaming run to stop. A blocking mutex:
    /// every critical section is a map lookup, which lets the tombstone sweep run
    /// without an async accessor. The `Arc` lets that sweep task outlive the borrow of
    /// `self` that scheduled it.
    agent_cancels: Arc<AgentCancels>,
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
            agent_cancels: Arc::new(SyncMutex::new(HashMap::new())),
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

    /// Register (or adopt) the cancellation handle for a run id and return it. The
    /// caller awaits `notified()` and must remove the entry when done (agent.rs does
    /// that with an RAII guard).
    ///
    /// A cancel that landed FIRST left a tombstone holding a `notify_one` permit: adopt
    /// it (clearing the stamp — it is a live entry from here) so the run this cancel was
    /// aimed at still stops. That race is sub-second, since registration is the
    /// command's first statement. A tombstone past `TOMBSTONE_ADOPTION_WINDOW` is
    /// REPLACED instead, permit discarded: it can only be a Stop aimed at a run that
    /// already ended, and session turns reuse one id, so adopting it would silently
    /// blank the next turn.
    pub fn register_agent_cancel(&self, id: &str) -> Arc<Notify> {
        let mut map = self
            .agent_cancels
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        match map.entry(id.to_string()) {
            Entry::Occupied(mut e) => {
                if e.get().is_stale_tombstone() {
                    let entry = CancelEntry::live();
                    let notify = Arc::clone(&entry.notify);
                    e.insert(entry);
                    notify
                } else {
                    e.get_mut().tombstoned_at = None;
                    Arc::clone(&e.get().notify)
                }
            }
            Entry::Vacant(e) => Arc::clone(&e.insert(CancelEntry::live()).notify),
        }
    }

    /// Remove `id` from the registry (idempotent — safe on every exit path).
    pub fn clear_agent_cancel(&self, id: &str) {
        self.agent_cancels
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(id);
    }

    /// Signal an in-flight run to cancel — firing the registered handle when present,
    /// else leaving a tombstone for a registration racing just behind it (only within
    /// `TOMBSTONE_ADOPTION_WINDOW`). `notify_one` stores a permit, so a cancel is never
    /// lost whether it arrives mid-run or a moment ahead of the command's registration.
    ///
    /// A tombstone this call CREATES may never be adopted (the run already finished, or
    /// never started), which would grow the map unbounded — so in that case only,
    /// schedule `sweep_unadopted_tombstone` to reclaim it.
    pub fn cancel_agent(&self, id: &str) {
        let mut map = self
            .agent_cancels
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let (notify, created) = match map.entry(id.to_string()) {
            // A live run already registered here → fire its handle (do NOT sweep: the
            // command's RAII guard removes the entry when it returns).
            Entry::Occupied(e) => (Arc::clone(&e.get().notify), false),
            // Absent → leave a tombstone for a registration racing just behind (or for
            // the sweep below to reclaim if none arrives).
            Entry::Vacant(e) => (Arc::clone(&e.insert(CancelEntry::tombstone()).notify), true),
        };
        drop(map);
        notify.notify_one();
        if created {
            let registry = Arc::clone(&self.agent_cancels);
            let id = id.to_string();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(TOMBSTONE_SWEEP_DELAY).await;
                sweep_unadopted_tombstone(&registry, &id);
            });
        }
    }

    pub fn close_to_tray(&self) -> bool {
        self.close_to_tray.load(Ordering::Relaxed)
    }

    pub fn set_close_to_tray(&self, enabled: bool) {
        self.close_to_tray.store(enabled, Ordering::Relaxed);
    }
}

/// How long a cancel-created tombstone stays adoptable. The race it exists for is
/// sub-second — registration is the run command's first statement — while a Stop
/// clicked between two turns of one session (same id, still-enabled button) lands with
/// no run registered too, and its permit must never reach the next turn.
const TOMBSTONE_ADOPTION_WINDOW: Duration = Duration::from_secs(5);

/// A tombstone that outlived adoptability has no reason to live, so sweep and window
/// are the same age by construction.
const TOMBSTONE_SWEEP_DELAY: Duration = TOMBSTONE_ADOPTION_WINDOW;

/// Remove `id` ONLY IF it's still an unadopted tombstone: the stamp is still set (a run
/// that adopted it cleared the stamp) and the map holds the sole `Arc` — a live run
/// holds a clone via its RAII guard and removes the entry itself.
fn sweep_unadopted_tombstone(registry: &AgentCancels, id: &str) {
    let mut map = registry.lock().unwrap_or_else(|p| p.into_inner());
    if map
        .get(id)
        .is_some_and(|e| e.tombstoned_at.is_some() && Arc::strong_count(&e.notify) == 1)
    {
        map.remove(id);
    }
}

#[cfg(test)]
mod agent_cancel_tests {
    use super::*;

    /// The cancel-before-register race: the frontend can fire a cancel before the
    /// command has reached its registration (fast Esc, or a teardown right after
    /// start). The permit must survive for the later registration to adopt.
    #[tokio::test]
    async fn cancel_before_register_delivers_permit() {
        let state = AppState::default();
        let id = "cancel-before-register-0001";
        state.cancel_agent(id);
        let notify = state.register_agent_cancel(id);
        // A zero-duration timeout still resolves ⇒ the permit was waiting.
        let got = tokio::time::timeout(Duration::ZERO, notify.notified()).await;
        assert!(
            got.is_ok(),
            "the cancel permit must be waiting for the later-registering run"
        );
        state.clear_agent_cancel(id);
    }

    /// The counter-case: a Stop clicked in the gap between two turns of one session
    /// (turn N's guard already dropped, turn N+1 not yet started — the same cancel id
    /// throughout) must NOT carry into the next turn, which would complete it blank.
    #[tokio::test]
    async fn stale_tombstone_is_not_adopted() {
        let state = AppState::default();
        let id = "stale-tombstone-0005";
        state.cancel_agent(id);
        {
            let mut map = state
                .agent_cancels
                .lock()
                .unwrap_or_else(|p| p.into_inner());
            let entry = map.get_mut(id).expect("the cancel left a tombstone");
            entry.tombstoned_at = Some(
                Instant::now()
                    .checked_sub(2 * TOMBSTONE_ADOPTION_WINDOW)
                    .expect("the monotonic clock must be older than two windows"),
            );
        }

        let notify = state.register_agent_cancel(id);
        let got = tokio::time::timeout(Duration::ZERO, notify.notified()).await;
        assert!(
            got.is_err(),
            "a stale tombstone's permit must not cancel the next run under that id"
        );
        state.clear_agent_cancel(id);
    }

    /// The ordinary order, but with the cancel landing before the run polls: a stored
    /// permit means it is still delivered on the first poll.
    #[tokio::test]
    async fn cancel_after_register_before_poll_delivers_permit() {
        let state = AppState::default();
        let id = "register-then-cancel-0002";
        let notify = state.register_agent_cancel(id);
        state.cancel_agent(id);
        let got = tokio::time::timeout(Duration::ZERO, notify.notified()).await;
        assert!(got.is_ok(), "a post-register cancel must still deliver");
        state.clear_agent_cancel(id);
    }

    #[tokio::test]
    async fn sweep_reclaims_only_unadopted_tombstones() {
        let state = AppState::default();
        let unadopted = "tombstone-unadopted-0003";
        let adopted = "tombstone-adopted-0004";
        state.cancel_agent(unadopted);
        state.cancel_agent(adopted);
        // A run that registers later adopts the tombstone, CLEARING its stamp — the
        // stamp short-circuit is what saves it from the sweep; the strong-count arm
        // guards the separate transient-clone race, not this path.
        let _held = state.register_agent_cancel(adopted);

        sweep_unadopted_tombstone(&state.agent_cancels, unadopted);
        sweep_unadopted_tombstone(&state.agent_cancels, adopted);

        let map = state
            .agent_cancels
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        assert!(
            !map.contains_key(unadopted),
            "an unadopted tombstone must be reclaimed"
        );
        assert!(
            map.contains_key(adopted),
            "an adopted entry belongs to its run's guard, not the sweep"
        );
    }
}
