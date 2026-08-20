//! Cross-process advisory lock for GitDesktop's shared app-data JSON stores.
//!
//! `opslog.json` and `review-notes.json` are whole-file read→modify→write stores with
//! TWO writing processes: the GUI and the `gitdesktop mcp` server — the SAME binary
//! under a different subcommand, so both link this module and share its protocol. An
//! in-process mutex cannot serialize across that boundary, so a concurrent write
//! silently drops the loser's records.
//!
//! Exclusion is taken at the OS level with `OpenOptions::create_new` on a
//! `<store>.lock` file beside the store — the atomic exclusive-create
//! [`crate::automation_claims`] already relies on, and no new dependency (the
//! lockfile carries zero file-locking crates; keep it that way). The lock path is
//! derived from the store's own RESOLVED path, so the `GD_OPLOG_DIR` /
//! `GD_REVIEW_NOTES_DIR` / `cfg!(test)` seams stay coherent on both sides by
//! construction. Nothing here involves the single-instance plugin: that lock is
//! release-only and keyed on the bundle identifier, and the MCP server is a
//! deliberately co-running second process.
//!
//! ## Fail-open, always
//!
//! Both stores are best-effort by contract — a journal write must never fail or alter
//! a git op ([`crate::oplog`]'s module docs) — so every failure to acquire (a poisoned
//! directory, a holder that outlasts the retry budget) runs the caller's mutation
//! ANYWAY. Worst case of fail-open is the pre-existing lost update; worst case of
//! fail-closed is a git operation reporting failure because a journal file was busy.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Retry budget for a held lock: 20 × 25ms ≈ 500ms of blocking. An RMW on these
/// stores is ms-scale, so a holder still present after half a second is either wedged
/// or dead, and the caller is better served by proceeding than by waiting.
const MAX_ATTEMPTS: u32 = 20;
const RETRY_DELAY: Duration = Duration::from_millis(25);

/// A lock file whose mtime is older than this is abandoned (a process killed between
/// create and release) and is evicted by the next caller. The mtime is never
/// refreshed — an RMW is ms-scale, so 10s is orders of magnitude of headroom, and a
/// heartbeat would need a write handle on Windows for no gain.
const STALE_LOCK_AGE: Duration = Duration::from_secs(10);

/// RAII holder of a store lock: dropping it releases (best-effort `remove_file`) on
/// every path, success or panic. A guard that FAILED to acquire owns nothing and
/// releases nothing — deleting a live holder's file would break the exclusion it is
/// currently providing to someone else.
pub(crate) struct StoreLock {
    owned: Option<PathBuf>,
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        if let Some(path) = &self.owned {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Take the cross-process lock for `store_file` and hold it until the returned guard
/// drops. ALWAYS returns a guard: an un-acquired one lets the caller proceed
/// unlocked, per the module's fail-open contract. Blocks the calling thread for at
/// most [`MAX_ATTEMPTS`] × [`RETRY_DELAY`]; callers are synchronous store helpers.
pub(crate) fn lock_store(store_file: &Path) -> StoreLock {
    lock_at(
        &lock_path(store_file),
        MAX_ATTEMPTS,
        RETRY_DELAY,
        STALE_LOCK_AGE,
    )
}

/// `<store_file>.lock`, beside the store — same directory, same resolution seam, so
/// two processes that agree on the store file agree on the lock file.
fn lock_path(store_file: &Path) -> PathBuf {
    let mut name = store_file.as_os_str().to_os_string();
    name.push(".lock");
    PathBuf::from(name)
}

/// [`lock_store`] with the budget and staleness window injected, so tests drive the
/// contention and eviction arms without sleeping for real.
fn lock_at(lock_file: &Path, max_attempts: u32, delay: Duration, stale_age: Duration) -> StoreLock {
    StoreLock {
        owned: acquire(lock_file, max_attempts, delay, stale_age),
    }
}

/// Atomically create `path`. `Ok(true)` = created by us, `Ok(false)` = someone else
/// holds it. `create_new` is the atomic exclusive-create: exactly one of two racing
/// callers gets `Ok(File)`, the other gets `AlreadyExists`. The file stays empty —
/// only its existence and its mtime carry meaning.
fn create_new_lock(path: &Path) -> std::io::Result<bool> {
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

fn mtime(path: &Path) -> Option<SystemTime> {
    path.metadata().and_then(|m| m.modified()).ok()
}

/// `path`'s mtime WHEN it is at least `stale_age` old, else `None`. Unreadable
/// metadata, or a future mtime (clock skew, which yields `Err`), both answer `None` —
/// a lock we cannot age is never evicted. The mtime comes back because the eviction
/// has to prove it removed the very file it aged.
fn stale_mtime(path: &Path, stale_age: Duration) -> Option<SystemTime> {
    let modified = mtime(path)?;
    let age = SystemTime::now().duration_since(modified).ok()?;
    (age >= stale_age).then_some(modified)
}

/// Evict the abandoned lock at `path`, whose mtime was observed as `observed`, and
/// take it. The eviction is claimed by RENAME rather than unlink, because the aside
/// copy proves WHICH file we removed: a plain `remove_file` + `create_new` lets a
/// second contender — still carrying its own older staleness verdict — unlink the
/// lock the first has already re-created and then claim it too, leaving two holders
/// inside the critical section.
///
/// So if what we renamed away is not the file we aged, someone re-created it in that
/// window: put it back and fail open rather than hold a lock we broke.
fn evict_stale(path: &Path, observed: SystemTime) -> Option<PathBuf> {
    let name = path.file_name()?.to_string_lossy().into_owned();
    let aside = path.with_file_name(format!(
        "{name}.evict.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    // A failed rename means the lock is gone or another contender is already evicting
    // it — either way it is not ours to take.
    if std::fs::rename(path, &aside).is_err() {
        return None;
    }
    if mtime(&aside) != Some(observed) {
        // A live lock, not the abandoned one. Restore it; if the restore loses to a
        // third contender that has already taken the empty slot, drop the aside copy
        // rather than leak it beside the store.
        if std::fs::rename(&aside, path).is_err() {
            let _ = std::fs::remove_file(&aside);
        }
        return None;
    }
    let _ = std::fs::remove_file(&aside);
    won(path)
}

/// Acquire the lock at `path`, answering the owned path or `None` to fail open.
fn acquire(
    path: &Path,
    max_attempts: u32,
    delay: Duration,
    stale_age: Duration,
) -> Option<PathBuf> {
    for attempt in 0..max_attempts {
        match create_new_lock(path) {
            Ok(true) => return Some(path.to_path_buf()),
            Ok(false) => {}
            // The store's directory doesn't exist yet — nothing has been written
            // there. `atomic_write` creates it at write time, so create it here too
            // rather than leaving the first-ever write of a fresh install unlocked.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let ready = path
                    .parent()
                    .is_some_and(|dir| std::fs::create_dir_all(dir).is_ok());
                return if ready { won(path) } else { None };
            }
            // Anything else (permissions, full disk) fails open — see the module docs.
            Err(_) => return None,
        }
        // Held by someone. Only an ABANDONED lock is evictable, and the eviction is
        // itself claimed atomically ([`evict_stale`]); anything short of winning it
        // outright yields rather than looping (mirrors `automation_claims`).
        if let Some(observed) = stale_mtime(path, stale_age) {
            return evict_stale(path, observed);
        }
        if attempt + 1 < max_attempts {
            std::thread::sleep(delay);
        }
    }
    None
}

/// One exclusive-create attempt as an ownership answer: `Some(path)` only when this
/// caller created the file.
fn won(path: &Path) -> Option<PathBuf> {
    match create_new_lock(path) {
        Ok(true) => Some(path.to_path_buf()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A temp dir plus a store path inside it. The dir is the RAII guard — hold it.
    fn tmp_store() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("gd-store-lock-test-")
            .tempdir()
            .expect("create temp dir");
        let store = dir.path().join("store.json");
        (dir, store)
    }

    /// Age `path`'s mtime by `age`. The write handle is required: on Windows
    /// `set_modified` fails with PermissionDenied on a read-only one.
    fn backdate(path: &Path, age: Duration) {
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(SystemTime::now() - age)
            .unwrap();
    }

    #[test]
    fn the_lock_file_sits_beside_the_store() {
        assert_eq!(
            lock_path(Path::new("C:/data/opslog.json")),
            PathBuf::from("C:/data/opslog.json.lock")
        );
        // Both processes derive it from the SAME resolved store path, so a seam
        // (GD_OPLOG_DIR, cfg(test)) moves the lock with the store it guards.
        assert_eq!(
            lock_path(Path::new("/tmp/gd-oplog-test/opslog.json")),
            PathBuf::from("/tmp/gd-oplog-test/opslog.json.lock")
        );
    }

    #[test]
    fn a_second_caller_loses_the_exclusive_create_and_fails_open() {
        let (_tmp, store) = tmp_store();
        let path = lock_path(&store);

        let held = lock_at(&path, 3, Duration::from_millis(1), STALE_LOCK_AGE);
        assert!(held.owned.is_some(), "the first caller must win");
        assert!(path.exists());

        // The holder is FRESH, so the loser burns its budget and proceeds unlocked
        // rather than failing the caller's write.
        let loser = lock_at(&path, 3, Duration::from_millis(1), STALE_LOCK_AGE);
        assert!(loser.owned.is_none(), "a fresh lock must keep excluding");

        // A fail-open guard owns nothing, so its drop must not release the winner's
        // lock out from under it.
        drop(loser);
        assert!(path.exists(), "the loser must not delete the holder's lock");
        drop(held);
        assert!(!path.exists(), "the holder's drop releases the lock");
    }

    #[test]
    fn a_stale_lock_is_evicted_by_the_next_caller() {
        let (_tmp, store) = tmp_store();
        let path = lock_path(&store);

        // A process took the lock and died without releasing it.
        assert!(create_new_lock(&path).unwrap());
        backdate(&path, STALE_LOCK_AGE + Duration::from_secs(5));

        let taken = lock_at(&path, 1, Duration::from_millis(1), STALE_LOCK_AGE);
        assert!(
            taken.owned.is_some(),
            "an abandoned lock must not starve the next writer"
        );
        assert!(path.exists(), "the evictor now holds its own lock file");
        drop(taken);
        assert!(!path.exists());
    }

    #[test]
    fn eviction_takes_the_lock_it_aged_and_leaves_no_scratch() {
        let (_tmp, store) = tmp_store();
        let path = lock_path(&store);
        assert!(create_new_lock(&path).unwrap());
        backdate(&path, STALE_LOCK_AGE + Duration::from_secs(5));
        let observed = mtime(&path).unwrap();

        let owned = evict_stale(&path, observed).expect("an abandoned lock is evictable");
        assert_eq!(owned, path);
        assert_ne!(
            mtime(&path),
            Some(observed),
            "the evictor holds its own fresh file, not the corpse"
        );
        let strays: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".evict."))
            .collect();
        assert!(strays.is_empty(), "the aside copy must not be left behind");
    }

    #[test]
    fn eviction_that_finds_a_re_created_lock_restores_it_and_stands_down() {
        let (_tmp, store) = tmp_store();
        let path = lock_path(&store);
        assert!(create_new_lock(&path).unwrap());
        backdate(&path, STALE_LOCK_AGE + Duration::from_secs(5));
        let observed = mtime(&path).unwrap();

        // Another contender got there first: it evicted the abandoned lock and took
        // its own, so the file on disk is no longer the one we aged. Under a plain
        // remove + create_new this caller would unlink that live lock and claim the
        // slot too — two holders inside the critical section.
        std::fs::remove_file(&path).unwrap();
        assert!(create_new_lock(&path).unwrap());
        let theirs = mtime(&path).unwrap();
        assert_ne!(theirs, observed);

        assert!(
            evict_stale(&path, observed).is_none(),
            "a lock we did not age is not ours to evict"
        );
        assert_eq!(
            mtime(&path),
            Some(theirs),
            "the live lock must be put back, not consumed"
        );
    }

    #[test]
    fn a_lock_younger_than_the_window_is_never_evicted() {
        let (_tmp, store) = tmp_store();
        let path = lock_path(&store);
        assert!(create_new_lock(&path).unwrap());
        // Just inside the window: a live holder mid-RMW must keep excluding, or the
        // eviction path reintroduces the lost update it exists to prevent.
        backdate(&path, STALE_LOCK_AGE - Duration::from_secs(2));

        let denied = lock_at(&path, 1, Duration::from_millis(1), STALE_LOCK_AGE);
        assert!(denied.owned.is_none());
    }

    #[test]
    fn a_poisoned_store_directory_fails_open() {
        let (tmp, _store) = tmp_store();
        // A regular file where the store's directory should be: every create attempt
        // errors, and the parent-create recovery can't help either.
        let blocker = tmp.path().join("not-a-directory");
        std::fs::write(&blocker, b"x").unwrap();
        let store = blocker.join("store.json");

        let guard = lock_store(&store);
        assert!(
            guard.owned.is_none(),
            "an unusable lock path must let the caller write anyway"
        );
    }

    #[test]
    fn a_missing_store_directory_is_created_and_locked() {
        let (tmp, _store) = tmp_store();
        // A fresh install: nothing has written the app-data dir yet.
        let store = tmp.path().join("fresh").join("opslog.json");
        let guard = lock_store(&store);
        assert!(
            guard.owned.is_some(),
            "the first write must still be locked"
        );
        assert!(lock_path(&store).exists());
    }

    #[test]
    fn the_lock_is_reusable_after_release() {
        let (_tmp, store) = tmp_store();
        let first = lock_store(&store);
        assert!(first.owned.is_some());
        drop(first);

        let second = lock_store(&store);
        assert!(
            second.owned.is_some(),
            "a released lock must be immediately re-acquirable"
        );
    }
}
