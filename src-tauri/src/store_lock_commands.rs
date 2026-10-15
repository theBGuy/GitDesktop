//! The webview's seam onto [`crate::store_lock`]: a frontend plugin-store
//! read-modify-write brackets itself with [`app_store_lock_acquire`] /
//! [`app_store_lock_release`] so it holds the SAME cross-process lock the Rust-side
//! writers (and the `gitdesktop mcp` server) take on that file.
//!
//! The frontend names a store FILE, never a path: the name is validated as one segment
//! and resolved exactly as the store plugin resolves it, so both sides derive one lock
//! file by construction. Held guards live in [`StoreLockState`] keyed by an opaque id.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

use crate::error::{AppError, AppResult};
use crate::store_lock::{self, StoreLock};

/// A webview hold older than this is dead (a reload mid-hold strands its guard; a
/// frontend RMW is ms-scale) and is evicted by the next acquire of the same store.
const STALE_HOLD: Duration = Duration::from_secs(5);

struct HeldEntry {
    /// Held only for its Drop, which releases the lock file.
    _guard: StoreLock,
    path: PathBuf,
    acquired_at: Instant,
}

/// Guards the webview currently holds, by the id handed back from acquire.
#[derive(Default)]
pub struct StoreLockState {
    held: Mutex<HashMap<String, HeldEntry>>,
}

impl StoreLockState {
    fn held(&self) -> std::sync::MutexGuard<'_, HashMap<String, HeldEntry>> {
        self.held
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Take the cross-process lock on app-data store `store` (a bare file name such as
/// `local-prs.json`). `Some(id)` = held until [`app_store_lock_release`]; `None` =
/// fail-open, the caller proceeds unlocked (an unresolvable app-data dir included). An
/// invalid name is a caller bug and is the only error.
#[tauri::command]
pub async fn app_store_lock_acquire(
    app: tauri::AppHandle,
    store: String,
) -> AppResult<Option<String>> {
    validate_store_name(&store)?;
    let Ok(path) = tauri_plugin_store::resolve_store_path(&app, &store) else {
        return Ok(None);
    };
    // The acquire blocks up to the lock's retry budget and guard drops do file I/O, so
    // both ride a blocking thread, never the main thread.
    store_lock::locked_store_task(move || Ok(acquire_at(&app.state::<StoreLockState>(), path)))
        .await
}

/// Release a hold taken by [`app_store_lock_acquire`]. Idempotent: an unknown id (already
/// released, or evicted as stale) is Ok.
#[tauri::command]
pub async fn app_store_lock_release(app: tauri::AppHandle, id: String) -> AppResult<()> {
    store_lock::locked_store_task(move || {
        release_at(&app.state::<StoreLockState>(), &id);
        Ok(())
    })
    .await
}

/// A store name is one path segment, `^[A-Za-z0-9][A-Za-z0-9._-]*\.json$` with no `..`,
/// so a webview-supplied value can never steer the lock outside the app-data dir. A
/// Windows reserved device stem (the whole segment before the first dot) is refused:
/// its lock path opens the DEVICE, so the exclusive create would exclude nothing.
fn validate_store_name(store: &str) -> AppResult<()> {
    let stem = store
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "nul" | "con" | "prn" | "aux")
        || (stem.len() == 4
            && (stem.starts_with("com") || stem.starts_with("lpt"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    let valid = store.len() > ".json".len()
        && store.ends_with(".json")
        && store.starts_with(|c: char| c.is_ascii_alphanumeric())
        && store
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !store.contains("..")
        && !reserved;
    if valid {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(format!(
            "invalid app store name: {store:?}"
        )))
    }
}

/// The blocking body of acquire. The map mutex is never held across file I/O: stale
/// holds on the same store are unlinked from the map first, then dropped (releasing
/// their lock files) before this caller's own acquire.
fn acquire_at(state: &StoreLockState, path: PathBuf) -> Option<String> {
    let stale: Vec<HeldEntry> = {
        let mut held = state.held();
        let ids: Vec<String> = held
            .iter()
            .filter(|(_, e)| e.path == path && e.acquired_at.elapsed() > STALE_HOLD)
            .map(|(id, _)| id.clone())
            .collect();
        ids.iter().filter_map(|id| held.remove(id)).collect()
    };
    drop(stale);

    let lock = store_lock::lock_store(&path);
    if !lock.acquired() {
        return None;
    }
    let id = uuid::Uuid::new_v4().to_string();
    state.held().insert(
        id.clone(),
        HeldEntry {
            _guard: lock,
            path,
            acquired_at: Instant::now(),
        },
    );
    Some(id)
}

/// The blocking body of release: the entry leaves the map under the mutex, and its guard
/// drops after the mutex is released.
fn release_at(state: &StoreLockState, id: &str) {
    let entry = state.held().remove(id);
    drop(entry);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_store() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("gd-store-lock-cmd-test-")
            .tempdir()
            .expect("create temp dir");
        let store = dir.path().join("local-prs.json");
        (dir, store)
    }

    fn lock_file(store: &std::path::Path) -> PathBuf {
        let mut name = store.as_os_str().to_os_string();
        name.push(".lock");
        PathBuf::from(name)
    }

    fn lock_files_in(dir: &std::path::Path) -> usize {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".lock"))
            .count()
    }

    #[test]
    fn store_lock_names_are_single_json_segments() {
        for bad in [
            "../x.json",
            "a/b.json",
            "a\\b.json",
            "",
            "x.txt",
            ".json",
            "a..b.json",
            "-x.json",
            "C:x.json",
            "nul.json",
            "COM1.json",
            "con.sole.json",
            "lpt9.json",
        ] {
            assert!(
                validate_store_name(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
        for good in [
            "local-prs.json",
            "coldstart-abc-local-prs.json",
            "x.json",
            "console.json",
            "com10.json",
        ] {
            assert!(
                validate_store_name(good).is_ok(),
                "{good:?} must be accepted"
            );
        }
    }

    #[test]
    fn store_lock_acquire_release_cycle() {
        let (_tmp, store) = tmp_store();
        let state = StoreLockState::default();

        let id = acquire_at(&state, store.clone()).expect("an uncontended store is acquired");
        assert!(lock_file(&store).exists());

        release_at(&state, &id);
        assert!(!lock_file(&store).exists(), "release drops the lock file");
        // Idempotent: a second release of the same (now unknown) id is a no-op.
        release_at(&state, &id);
        assert!(state.held().is_empty());
    }

    #[test]
    fn store_lock_acquire_fails_open_against_a_fresh_holder() {
        let (_tmp, store) = tmp_store();
        let state = StoreLockState::default();
        let holder = store_lock::lock_store(&store);
        assert!(holder.acquired());

        assert_eq!(acquire_at(&state, store.clone()), None);
        assert!(state.held().is_empty(), "a fail-open acquire holds nothing");
        assert!(
            lock_file(&store).exists(),
            "the holder's lock must survive the loser"
        );
        drop(holder);
        assert!(!lock_file(&store).exists());
    }

    #[test]
    fn store_lock_acquire_evicts_a_stale_webview_hold() {
        let (tmp, store) = tmp_store();
        let state = StoreLockState::default();
        let stranded = store_lock::lock_store(&store);
        assert!(stranded.acquired());
        state.held().insert(
            "stranded".to_string(),
            HeldEntry {
                _guard: stranded,
                path: store.clone(),
                acquired_at: Instant::now()
                    .checked_sub(STALE_HOLD + Duration::from_secs(1))
                    .expect("monotonic clock has run past the backdate"),
            },
        );

        let id = acquire_at(&state, store.clone()).expect("a dead hold must not starve the store");
        let held = state.held();
        assert!(!held.contains_key("stranded"), "the stale entry is evicted");
        assert!(held.contains_key(&id));
        drop(held);
        assert_eq!(
            lock_files_in(tmp.path()),
            1,
            "exactly one lock file remains"
        );
    }

    /// The cross-side contract: the plugin resolves `<AppData>/<identifier>/<file>`, and
    /// the Rust writers hardcode that identifier — so it must match the bundle config.
    #[test]
    fn store_lock_rust_writers_share_the_plugins_app_data_dir() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        assert_eq!(
            conf["identifier"].as_str(),
            Some(crate::local_prs::APP_IDENTIFIER)
        );

        // The production arm directly: under cfg(test) `store_path` resolves a temp dir.
        let path = crate::local_prs::resolve_store_dir(None, false)
            .expect("app-data dir resolves")
            .join("local-prs.json");
        let expected = dirs::data_dir()
            .expect("app-data dir")
            .join(crate::local_prs::APP_IDENTIFIER)
            .join("local-prs.json");
        assert_eq!(path, expected);
    }
}
