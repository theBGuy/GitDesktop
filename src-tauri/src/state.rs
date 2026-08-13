use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as SyncMutex};
use std::time::Duration;
use tokio::sync::{Mutex, Notify, OnceCell};

use crate::git::types::GitInfo;

/// The agent cancel registry: run id → the `Notify` the cancel command fires.
type AgentCancels = SyncMutex<HashMap<String, Arc<Notify>>>;

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
    /// Uses `entry().or_insert_with(...)`, NOT `insert`: a cancel that landed FIRST
    /// left a tombstone holding a `notify_one` permit, and replacing it would drop
    /// that permit — the run would then stream on to its full timeout. The adopted
    /// permit is consumed by the run's first `.notified()` poll.
    pub fn register_agent_cancel(&self, id: &str) -> Arc<Notify> {
        self.agent_cancels
            .lock()
            .expect("agent cancel registry poisoned")
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(Notify::new()))
            .clone()
    }

    /// Remove `id` from the registry (idempotent — safe on every exit path).
    pub fn clear_agent_cancel(&self, id: &str) {
        self.agent_cancels
            .lock()
            .expect("agent cancel registry poisoned")
            .remove(id);
    }

    /// Signal an in-flight run to cancel — adopting the registered handle when present,
    /// else leaving a tombstone the later registration adopts. `notify_one` stores a
    /// permit, so a cancel is never lost whether it arrives mid-run or ahead of the
    /// command's registration.
    ///
    /// A tombstone this call CREATES may never be adopted (the run already finished, or
    /// never started), which would grow the map unbounded — so in that case only,
    /// schedule `sweep_unadopted_tombstone` to reclaim it if it stays unadopted.
    pub fn cancel_agent(&self, id: &str) {
        let mut map = self
            .agent_cancels
            .lock()
            .expect("agent cancel registry poisoned");
        let (notify, created) = match map.entry(id.to_string()) {
            // A live run already registered here → adopt its handle (do NOT sweep: the
            // command's RAII guard removes the entry when it returns).
            Entry::Occupied(e) => (e.get().clone(), false),
            // Absent → leave a tombstone for the later-registering run to adopt (or for
            // the sweep below to reclaim if nothing ever does).
            Entry::Vacant(e) => (e.insert(Arc::new(Notify::new())).clone(), true),
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

/// How long a cancel-created tombstone is kept before the sweep reclaims it if
/// unadopted. Comfortably longer than the window between a run's command entry
/// (where it registers) and the cancel that raced ahead of it.
const TOMBSTONE_SWEEP_DELAY: Duration = Duration::from_secs(60);

/// Remove `id` ONLY IF it's still an unadopted tombstone — i.e. the map holds the sole
/// `Arc` (`strong_count == 1` under the lock). A run that adopted the entry holds a
/// clone and removes it itself via its RAII guard, so any higher count means the sweep
/// must not touch it.
fn sweep_unadopted_tombstone(registry: &AgentCancels, id: &str) {
    let mut map = registry.lock().expect("agent cancel registry poisoned");
    if let Some(n) = map.get(id) {
        if Arc::strong_count(n) == 1 {
            map.remove(id);
        }
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
        // A run that registers later adopts the tombstone and holds its own clone,
        // which is exactly what the sweep's strong-count check must see.
        let _held = state.register_agent_cancel(adopted);

        sweep_unadopted_tombstone(&state.agent_cancels, unadopted);
        sweep_unadopted_tombstone(&state.agent_cancels, adopted);

        let map = state
            .agent_cancels
            .lock()
            .expect("agent cancel registry poisoned");
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
