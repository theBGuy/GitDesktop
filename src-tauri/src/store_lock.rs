//! Cross-process advisory lock for GitDesktop's shared app-data JSON stores.
//!
//! `opslog.json`, `review-notes.json`, `local-prs.json`, `local-issues.json` and
//! `jira-field-maps.json` are whole-file read→modify→write stores with TWO writing
//! processes: the GUI and the `gitdesktop mcp` server — the SAME binary under a
//! different subcommand, so both link this module and share its protocol. An in-process
//! mutex cannot serialize across that boundary, so a concurrent write silently drops the
//! loser's records. Carve-out: the GUI writes `local-prs.json` and `local-issues.json`
//! through the Tauri Store plugin, which takes neither lock, so those two are protected
//! MCP-side only until the GUI's writes route through Rust the way `review_notes` does.
//!
//! ## Ownership token
//!
//! The lock file carries `<pid>:<uuid>`, stamped and flushed before the exclusive create
//! returns. Existence answers "is it held"; mtime answers "is it abandoned"; only the
//! token answers "is this the SAME lock" — which is what a release and an eviction each
//! have to prove before they delete a file, or two writers end up inside one critical
//! section.
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
//! These stores are best-effort by contract — a journal write must never fail or alter
//! a git op ([`crate::oplog`]'s module docs) — so every failure to acquire (a poisoned
//! directory, a holder that outlasts the retry budget) runs the caller's mutation
//! ANYWAY. Worst case of fail-open is the pre-existing lost update; worst case of
//! fail-closed is a git operation reporting failure because a journal file was busy.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::error::{AppError, AppResult};

/// Retry budget for a held lock: 20 attempts, sleeping between them but not after the
/// last, so 19 × 25ms = 475ms of blocking. An RMW on these stores is ms-scale, so a
/// holder still present after half a second is either wedged or dead, and the caller is
/// better served by proceeding than by waiting.
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
/// currently providing to someone else. What it owns is a path AND the ownership token
/// stamped in that file, because the path alone can name a LATER generation's lock.
pub(crate) struct StoreLock {
    owned: Option<(PathBuf, String)>,
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        // Release through the same proof an eviction uses. A holder that outlives
        // [`STALE_LOCK_AGE`] can be evicted mid-RMW, and both an unconditional
        // `remove_file` and a read-then-remove (a whole eviction cycle fits between its
        // two calls) would then delete the EVICTOR's lock, granting the store twice.
        if let Some((path, token)) = &self.owned {
            claim_by_rename(path, token);
        }
    }
}

/// Run a locked store read-modify-write off the async runtime. [`lock_store`] blocks the
/// calling thread for up to the retry budget above, which must never park a tokio worker
/// — a journal write happens twice inside a held repo lock, stalling every other op on
/// that repo. A join failure is returned as an error the caller folds into its own
/// fail-open arm.
pub(crate) async fn locked_store_task<T, F>(job: F) -> AppResult<T>
where
    F: FnOnce() -> AppResult<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|e| AppError::Command(format!("store task did not run: {e}")))?
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

/// A holder's ownership stamp, `<pid>:<uuid>`. The pid alone cannot identify a holder —
/// two threads of one process contend for the same store, and the MCP server can be a
/// second run of this very binary — so the uuid is what makes it unique; the pid is
/// there to make an abandoned file legible to a human.
fn new_token() -> String {
    format!("{}:{}", std::process::id(), uuid::Uuid::new_v4())
}

/// The ownership token stamped in the lock at `path`, or `None` when it can't be read
/// (an I/O error, a handle held by something else, bytes that are not UTF-8). An EMPTY
/// string is a file that exists without a stamp — never an ownerless one.
fn read_token(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// [`read_token`] with one retry. The answer decides whether a file gets DELETED, so a
/// momentary read failure — a scanner holding the handle for an instant — must not be
/// mistaken for "nobody owns this".
fn read_token_twice(path: &Path) -> Option<String> {
    read_token(path).or_else(|| read_token(path))
}

/// Exclusively create `path` and stamp `token` into it, flushed before returning so no
/// contender can observe the file without its owner. `Ok(true)` = created by us,
/// `Ok(false)` = someone else holds it. A failed stamp removes the file rather than
/// leaving an unidentifiable one behind: we won the exclusive create, so nobody else can
/// be holding it, and an untokened file is spared by eviction until double the stale
/// window ([`acquire`]).
fn create_with_token(path: &Path, token: &str) -> std::io::Result<bool> {
    if token.is_empty() {
        // The one content this file must never be given deliberately: an empty stamp is
        // indistinguishable from a create in flight, so writing one manufactures a lock
        // that eviction spares until double the window.
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "refusing to stamp a store lock with an empty token",
        ));
    }
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => match file.write_all(token.as_bytes()).and_then(|()| file.flush()) {
            Ok(()) => Ok(true),
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(path);
                Err(e)
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// Atomically create `path` under a FRESH ownership token, answering that token when we
/// created it and `None` when someone else holds it. `create_new` is the atomic
/// exclusive-create: exactly one of two racing callers gets `Ok(File)`, the other gets
/// `AlreadyExists`.
fn create_new_lock(path: &Path) -> std::io::Result<Option<String>> {
    let token = new_token();
    Ok(create_with_token(path, &token)?.then_some(token))
}

fn mtime(path: &Path) -> Option<SystemTime> {
    path.metadata().and_then(|m| m.modified()).ok()
}

/// Whether `path` is at least `stale_age` old — the only question mtime decides.
/// Unreadable metadata, or a future mtime (clock skew, which yields `Err`), both answer
/// `false`: a lock we cannot age is never evicted. WHICH file an eviction then took is
/// proven by the ownership token, never by this timestamp (a re-created lock can land
/// the same coarse mtime).
fn is_stale(path: &Path, stale_age: Duration) -> bool {
    mtime(path)
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .is_some_and(|age| age >= stale_age)
}

/// Remove the file at `path` while PROVING it is the one stamped `expect`, answering
/// whether that proof held. The claim is made by RENAME rather than unlink, because the
/// aside copy is the proof: a `remove_file` — or a read-then-remove, whose two calls a
/// whole eviction cycle can land between — deletes whatever is at the path NOW, which may
/// be a later generation's live lock, leaving two holders inside the critical section.
///
/// Every other outcome ends with the slot as close to untouched as it can be. A lock we
/// renamed away and then found to be someone else's is restored by exclusive create. One
/// whose token we could not read AT ALL, or that carries no stamp, or whose slot has
/// already been retaken, is left as an inert `.evict.*` file rather than unlinked: a
/// stray beside the store costs nothing, and deleting a live holder's only lock is the
/// one mistake here with no recovery.
fn claim_by_rename(path: &Path, expect: &str) -> bool {
    let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return false;
    };
    let aside = path.with_file_name(format!(
        "{name}.evict.{}.{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    // A failed rename means the lock is gone or another contender is already claiming
    // it — either way it is not ours to take.
    if std::fs::rename(path, &aside).is_err() {
        return false;
    }
    let found = read_token_twice(&aside);
    if found.as_deref() == Some(expect) {
        let _ = std::fs::remove_file(&aside);
        return true;
    }
    // Not the file we identified. Restore it by EXCLUSIVE CREATE, never a rename: rename
    // replaces on both platforms, so restoring over a third contender that already took
    // the emptied slot would destroy the exclusion it is providing. An unreadable or
    // unstamped token has nothing safe to restore, so the aside stays put (see above).
    let restored = found
        .as_deref()
        .filter(|live| !live.is_empty())
        .is_some_and(|live| create_with_token(path, live).unwrap_or(false));
    if restored {
        let _ = std::fs::remove_file(&aside);
    }
    false
}

/// Evict the abandoned lock at `path`, whose ownership token was read as `observed`, and
/// take it. Anything short of proving we removed that very file leaves the slot alone and
/// fails open, rather than holding a lock we broke.
fn evict_stale(path: &Path, observed: &str) -> Option<(PathBuf, String)> {
    if claim_by_rename(path, observed) {
        won(path)
    } else {
        None
    }
}

/// Acquire the lock at `path`, answering the owned path or `None` to fail open.
fn acquire(
    path: &Path,
    max_attempts: u32,
    delay: Duration,
    stale_age: Duration,
) -> Option<(PathBuf, String)> {
    for attempt in 0..max_attempts {
        match create_new_lock(path) {
            Ok(Some(token)) => return Some((path.to_path_buf(), token)),
            Ok(None) => {}
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
        if is_stale(path, stale_age) {
            // No identity, no eviction: a lock whose token we cannot read is one we could
            // never prove we removed.
            let observed = read_token_twice(path)?;
            // An unstamped file is normally a create still in flight, so it is spared.
            // Past DOUBLE the window that reading no longer holds — stamping takes
            // microseconds — and what is left is a process that died between the create
            // and the stamp. Sparing that one forever would wedge every writer of this
            // store into running unlocked.
            if observed.is_empty() && !is_stale(path, stale_age.saturating_mul(2)) {
                return None;
            }
            return evict_stale(path, &observed);
        }
        if attempt + 1 < max_attempts {
            std::thread::sleep(delay);
        }
    }
    None
}

/// One exclusive-create attempt as an ownership answer: the path plus our token, only
/// when this caller created the file.
fn won(path: &Path) -> Option<(PathBuf, String)> {
    match create_new_lock(path) {
        Ok(Some(token)) => Some((path.to_path_buf(), token)),
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

    /// Stamp `path`'s mtime to exactly `when`. The write handle is required: on Windows
    /// `set_modified` fails with PermissionDenied on a read-only one.
    fn set_mtime(path: &Path, when: SystemTime) {
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    /// Age `path`'s mtime by `age`.
    fn backdate(path: &Path, age: Duration) {
        set_mtime(path, SystemTime::now() - age);
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
        assert!(create_new_lock(&path).unwrap().is_some());
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
        let observed = create_new_lock(&path).unwrap().expect("the first caller wins");
        backdate(&path, STALE_LOCK_AGE + Duration::from_secs(5));

        let (owned, token) = evict_stale(&path, &observed).expect("an abandoned lock is evictable");
        assert_eq!(owned, path);
        assert_ne!(
            token, observed,
            "the evictor holds its own fresh file, not the corpse"
        );
        assert_eq!(read_token(&path).as_deref(), Some(token.as_str()));
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
        let observed = create_new_lock(&path).unwrap().unwrap();
        backdate(&path, STALE_LOCK_AGE + Duration::from_secs(5));

        // Another contender got there first: it evicted the abandoned lock and took
        // its own, so the file on disk is no longer the one we identified. Under a plain
        // remove + create_new this caller would unlink that live lock and claim the
        // slot too — two holders inside the critical section.
        std::fs::remove_file(&path).unwrap();
        let theirs = create_new_lock(&path).unwrap().unwrap();
        assert_ne!(theirs, observed);

        assert!(
            evict_stale(&path, &observed).is_none(),
            "a lock we did not identify is not ours to evict"
        );
        assert_eq!(
            read_token(&path).as_deref(),
            Some(theirs.as_str()),
            "the live lock must be put back, not consumed"
        );
    }

    #[test]
    fn a_lock_younger_than_the_window_is_never_evicted() {
        let (_tmp, store) = tmp_store();
        let path = lock_path(&store);
        assert!(create_new_lock(&path).unwrap().is_some());
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

    // ── Ownership token ──────────────────────────────────────────────────────

    #[test]
    fn a_new_lock_carries_its_owners_token() {
        let (_tmp, store) = tmp_store();
        let path = lock_path(&store);

        let token = create_new_lock(&path).unwrap().expect("the create wins");
        assert_eq!(
            read_token(&path).as_deref(),
            Some(token.as_str()),
            "the stamp must be flushed before the create returns, or a contender reads \
             an ownerless file"
        );
        assert!(
            token.starts_with(&format!("{}:", std::process::id())),
            "the pid prefix makes an abandoned lock legible: {token}"
        );
        // Two locks on the same store never share a token: same-process test threads
        // contend here, so the pid alone could not tell them apart.
        std::fs::remove_file(&path).unwrap();
        assert_ne!(create_new_lock(&path).unwrap().unwrap(), token);
    }

    #[test]
    fn an_unstamped_lock_inside_double_the_window_is_never_evicted() {
        let (_tmp, store) = tmp_store();
        let path = lock_path(&store);
        // An empty file is a create whose stamp has not landed — the one state that must
        // NOT read as ownerless, or the evictor takes a lock someone is about to hold.
        std::fs::write(&path, b"").unwrap();
        backdate(&path, STALE_LOCK_AGE + Duration::from_secs(5));

        let denied = lock_at(&path, 1, Duration::from_millis(1), STALE_LOCK_AGE);
        assert!(denied.owned.is_none(), "an unidentifiable lock is not ours");
        assert!(path.exists(), "and it must not be consumed either");
    }

    #[test]
    fn an_unstamped_lock_past_double_the_window_is_evictable() {
        let (_tmp, store) = tmp_store();
        let path = lock_path(&store);
        // The escape hatch: a stamp takes microseconds, so an unstamped file this old is
        // a process that died between the create and the stamp — not one in flight.
        // Without the hatch it would spare itself forever and every writer of this store
        // would run unlocked from here on.
        std::fs::write(&path, b"").unwrap();
        backdate(&path, STALE_LOCK_AGE * 2 + Duration::from_secs(1));

        let taken = lock_at(&path, 1, Duration::from_millis(1), STALE_LOCK_AGE);
        let (_, token) = taken.owned.clone().expect("a dead create must not wedge the store");
        assert_eq!(read_token(&path).as_deref(), Some(token.as_str()));
    }

    #[test]
    fn an_empty_token_is_never_stamped() {
        let (_tmp, store) = tmp_store();
        let path = lock_path(&store);
        let err = create_with_token(&path, "").unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        assert!(
            !path.exists(),
            "the refusal must not leave the poisoned file it declined to stamp"
        );
    }

    #[test]
    fn a_claim_whose_aside_cannot_be_read_never_unlinks_it() {
        let (tmp, store) = tmp_store();
        let path = lock_path(&store);
        // Bytes `read_to_string` rejects: the file may be a live holder's only lock (the
        // same answer a transient read error gives), so the claim must fail WITHOUT
        // destroying it.
        std::fs::write(&path, [0xFFu8, 0xFE, 0xFD]).unwrap();

        assert!(
            !claim_by_rename(&path, "1:someone"),
            "a file we cannot identify is not ours to take"
        );
        let survivors: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .filter(|e| std::fs::read(e.path()).unwrap_or_default() == [0xFF, 0xFE, 0xFD])
            .collect();
        assert_eq!(
            survivors.len(),
            1,
            "the lock's content must survive — restored or left aside, never unlinked"
        );
    }

    #[test]
    fn a_claim_whose_aside_is_unstamped_never_unlinks_it() {
        let (tmp, store) = tmp_store();
        let path = lock_path(&store);
        // The interleaving that used to manufacture permanent poison: the claim finds an
        // in-flight create's empty file. Restoring it would write an empty token back;
        // unlinking it would destroy a lock that is about to be stamped. Neither.
        std::fs::write(&path, b"").unwrap();

        assert!(!claim_by_rename(&path, "1:someone"));
        let asides: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".evict."))
            .collect();
        assert_eq!(asides.len(), 1, "the in-flight file is kept, not deleted");
        assert!(
            read_token(&path).is_none_or(|t| !t.is_empty()),
            "and no empty token is ever written back into the slot"
        );
    }

    #[test]
    fn a_guard_whose_lock_was_replaced_releases_nothing() {
        let (tmp, store) = tmp_store();
        let path = lock_path(&store);
        let held = lock_store(&store);
        assert!(held.owned.is_some());

        // The holder outlived the stale window and was evicted; the evictor's own lock
        // now sits at that path. Releasing by PATH alone would delete it and put two
        // writers inside the critical section — and so would a read-then-remove that
        // this same replacement lands between.
        std::fs::remove_file(&path).unwrap();
        let theirs = create_new_lock(&path).unwrap().unwrap();

        drop(held);
        assert_eq!(
            read_token(&path).as_deref(),
            Some(theirs.as_str()),
            "a stale guard must not release a later generation's lock"
        );
        // The release yanks before it proves, so the put-back has to be complete: the
        // live lock is back in the slot AND its aside copy is gone.
        let strays: Vec<_> = std::fs::read_dir(tmp.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".evict."))
            .collect();
        assert!(strays.is_empty(), "a restored lock leaves no scratch behind");
    }

    #[test]
    fn a_re_created_lock_sharing_the_evicted_ones_mtime_is_not_taken() {
        let (_tmp, store) = tmp_store();
        let path = lock_path(&store);
        let observed = create_new_lock(&path).unwrap().unwrap();
        // One timestamp for both generations: filesystem mtime is coarse (tens of ms on
        // Windows), so "same mtime" is not "same file" — only the token can say.
        let aged = SystemTime::now() - (STALE_LOCK_AGE + Duration::from_secs(5));
        set_mtime(&path, aged);

        std::fs::remove_file(&path).unwrap();
        let theirs = create_new_lock(&path).unwrap().unwrap();
        set_mtime(&path, aged);

        assert!(
            evict_stale(&path, &observed).is_none(),
            "an mtime match is not an identity match"
        );
        assert_eq!(
            read_token(&path).as_deref(),
            Some(theirs.as_str()),
            "the live lock must be put back intact"
        );
    }

    #[test]
    fn a_restore_never_replaces_a_lock_that_took_the_slot() {
        let (_tmp, store) = tmp_store();
        let path = lock_path(&store);
        // The restore arm's mechanism: an exclusive create, so a third contender that
        // already claimed the emptied slot keeps its lock. A replacing `rename` here
        // would hand two callers the store at once.
        let theirs = create_new_lock(&path).unwrap().unwrap();
        assert!(
            !create_with_token(&path, "1:restored").unwrap(),
            "an occupied slot must refuse the restore"
        );
        assert_eq!(read_token(&path).as_deref(), Some(theirs.as_str()));
    }
}
