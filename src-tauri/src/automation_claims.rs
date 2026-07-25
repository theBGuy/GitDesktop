//! Cross-process claim files for automation dispatch (duplicate-AI-review fix).
//!
//! ## The bug this closes
//!
//! Automations (AI PR reviews fired on pr-open / pr-sync / commit events) dispatch
//! entirely in the frontend. When two GitDesktop instances watch the SAME repository
//! — e.g. a main checkout and a linked worktree, which share a worktree-stable
//! identity — each instance independently decides to run and posts the SAME review
//! (observed live: two identical AI reviews 26s apart). The pre-existing dedup is
//! per-process only: an in-memory debounce map plus a review-history watermark read
//! from the tauri-store plugin, whose cache is per-process — so two processes never
//! see each other's claim. And the watermark is only written AFTER the slow AI call
//! completes, leaving a wide race window.
//!
//! This is a real-money bug (duplicate PAID AI reviews posted publicly on PRs), so
//! the claim must be atomic at the OS level. We use `OpenOptions::create_new` — an
//! atomic exclusive-create on NTFS (and every platform we target) — as a claim file
//! under app-data, claimed at DISPATCH time (before the AI call). It deliberately
//! does NOT go through the tauri-store plugin: that plugin's per-process cache is the
//! root cause we're routing around.
//!
//! ## Fail-open, always
//!
//! A broken claims directory must NEVER disable automations. Every unexpected error
//! (a permission problem, a full disk, anything that is not "the file already
//! exists") resolves to "you won the claim" so the automation still runs. The worst
//! case of a fail-open is the original duplicate-review bug; the worst case of a
//! fail-closed is silently disabling all AI reviews — the former is strictly less bad.
//!
//! ## Deterministic key hashing (why not `DefaultHasher`)
//!
//! Two instances that must dedup can be DIFFERENT builds (a dev build + a prod build,
//! or two parallel-worktree dev builds). They must hash the same composite key to the
//! same filename or the dedup silently breaks. `std::collections::hash_map::
//! DefaultHasher`'s algorithm is explicitly unspecified across releases, so we
//! implement FNV-1a-64 inline with its fixed constants — deterministic forever.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tauri::Manager;

use crate::error::{AppError, AppResult};

/// Claim files older than this are swept on each claim call, so a crashed instance's
/// stale claims can't accumulate unbounded. 30 days is far longer than any automation
/// run and longer than any head stays "current", so a sweep never races a live claim.
const SWEEP_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// A claim file this old with no accompanying release is treated as abandoned and
/// reclaimed by the next claimant (the sweep only fires at 30 days). This closes the
/// starvation bug where an instance that dies WITHOUT running its release arm (crash,
/// kill, a version-skewed old build) leaves a claim that suppresses this exact
/// `(repo, target, sha, action)` review across ALL instances until the 30-day sweep.
///
/// 30 minutes is safe because a DELIVERED review no longer relies on its claim for
/// dedup: at delivery the runner writes a pr-reviews history record, and that record —
/// not the claim — gates pr-open (per-mode) and pr-sync (same-sha skip). Reclaiming an
/// old delivered claim therefore cannot cause a re-review. A run whose delivery-record
/// write failed (best-effort in the runner) is bounded the same way: one duplicate
/// after 30 minutes, not a month of silence.
///
/// **This window measures heartbeat LIVENESS, not run length.** A running automation
/// refreshes its own claim's mtime from the runner every few minutes (see
/// [`touch_automation_claim`]) for as long as the AI call is in flight, so a long run
/// stays "fresh" indefinitely and is never double-claimed. That heartbeat closes what
/// used to be an accepted residual risk: reviews were once capped at 600s backend-side,
/// making a 30-minute overrun unreachable, but the user-facing "Review timeout" setting
/// now allows up to 60 minutes (and the backend clamp permits 7200s), so a legitimately
/// still-RUNNING review can outlive this window. The crash story is unchanged: an
/// instance that dies stops heartbeating, its claim ages out at 30 minutes, and the next
/// claimant reclaims it instead of being starved until the 30-day sweep.
const STALE_CLAIM_AGE: Duration = Duration::from_secs(30 * 60);

/// The app-data subdir holding claim files.
const CLAIMS_DIR: &str = "automation-claims";

/// FNV-1a-64 of the bytes. Inlined with the canonical constants (offset basis
/// `0xcbf29ce484222325`, prime `0x100000001b3`) so the hash is identical across
/// compiler versions and builds — a `DefaultHasher` would not be (see module docs).
fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The composite claim key for a run: `<repo_key>:<target>:<head_sha>:<action>`.
/// `repo_key` is the worktree-stable identity (an absolute path), so a main checkout
/// and a linked worktree of the same repo produce the same key and collide on the
/// claim — which is exactly the dedup we want.
fn composite_key(repo_key: &str, target: &str, head_sha: &str, action: &str) -> String {
    format!("{repo_key}:{target}:{head_sha}:{action}")
}

/// Turn a composite key into a legal, collision-free filename. The key holds an
/// absolute Windows path — `\` and `:` are illegal in filenames — so we build:
/// a sanitized, readable TAIL (last ~48 chars, every char outside `[A-Za-z0-9._-]`
/// replaced with `_`, for debuggability) + `-` + a 16-hex-digit FNV-1a-64 of the
/// FULL key. The hash guarantees two distinct keys never collide even when their
/// sanitized tails coincide.
fn claim_filename(key: &str) -> String {
    let sanitized: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    // Keep the LAST ~48 chars (the discriminating tail — head sha + action live at
    // the end of the key); char-boundary safe since sanitized is pure ASCII.
    let tail = if sanitized.len() > 48 {
        &sanitized[sanitized.len() - 48..]
    } else {
        &sanitized
    };
    format!("{tail}-{:016x}", fnv1a_64(key.as_bytes()))
}

/// Best-effort sweep: delete claim files whose mtime is older than `cutoff`. Every
/// step ignores errors — a sweep failure must never affect a claim outcome, and a
/// concurrent instance sweeping the same dir is harmless (a delete of a
/// already-gone file just fails silently).
fn sweep_older_than(dir: &Path, cutoff: SystemTime) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        if let Ok(modified) = meta.modified() {
            if modified < cutoff {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Atomically create the claim file for `key` at `path`. `Ok(true)` = created by us,
/// `Ok(false)` = it already existed. `create_new` is the atomic exclusive-create:
/// exactly one of two racing callers gets `Ok(File)`, the other gets `AlreadyExists`.
/// The plain composite key is written as the file's content for debuggability; the
/// mtime supplies the claim timestamp.
fn create_new_claim(path: &Path, key: &str) -> std::io::Result<bool> {
    use std::io::Write as _;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
    {
        Ok(mut file) => {
            // Best-effort content write; even if it fails the claim is already ours
            // (the file exists), so ignore the write result.
            let _ = file.write_all(key.as_bytes());
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// Claim `key` inside `dir`. Returns `Ok(true)` when THIS caller won the claim (the
/// file did not exist and we created it, OR we reclaimed a stale one), `Ok(false)` when
/// another instance already owns a FRESH claim. This helper takes a `&Path` so it's
/// unit-testable without an `AppHandle`.
///
/// Stale-claim reclaim: if the exclusive-create loses to an existing file, we stat that
/// file — if its mtime is older than [`STALE_CLAIM_AGE`], the owning instance is assumed
/// dead (it never ran its release arm), so we best-effort delete the file and retry the
/// exclusive-create EXACTLY ONCE. A second `AlreadyExists` means a concurrent instance
/// won the reclaim race, so we yield to it with `Ok(false)` rather than looping. A fresh
/// (< `STALE_CLAIM_AGE`) existing claim keeps returning `Ok(false)` unchanged.
fn claim_in_dir(dir: &Path, key: &str) -> std::io::Result<bool> {
    let path = dir.join(claim_filename(key));
    if create_new_claim(&path, key)? {
        return Ok(true);
    }
    // The file already exists. Reclaim it only when it is older than STALE_CLAIM_AGE —
    // a still-fresh claim is a live run and must keep excluding us.
    let stale = match path.metadata().and_then(|m| m.modified()) {
        Ok(modified) => SystemTime::now()
            .duration_since(modified)
            .map(|age| age >= STALE_CLAIM_AGE)
            // A future mtime (clock skew) yields Err — treat as not-stale, keep excluding.
            .unwrap_or(false),
        // Can't stat the mtime (raced away, permission) → don't reclaim; behave as before.
        Err(_) => false,
    };
    if !stale {
        return Ok(false);
    }
    // Best-effort delete of the abandoned claim, then retry the exclusive-create ONCE.
    // A failed delete or a lost retry race both resolve to Ok(false): another instance
    // owns the (possibly just-reclaimed) claim, so we skip this run rather than loop.
    let _ = std::fs::remove_file(&path);
    create_new_claim(&path, key)
}

/// Best-effort liveness heartbeat: refresh the mtime of `key`'s claim file so a
/// long-running automation keeps its claim "fresh" past [`STALE_CLAIM_AGE`]. All errors
/// are ignored (fail-open philosophy — a failed heartbeat degrades to the old behavior,
/// a reclaim after 30 quiet minutes). Opens WITHOUT `create`, so a RELEASED claim is
/// never resurrected by a late heartbeat — the open errs on the missing file and is
/// ignored. A RECLAIMED claim is different: the filename derives from the run key, not
/// the owning instance, so a late heartbeat from the old owner lands on (and refreshes)
/// the new owner's file — harmless, since it only keeps the live owner's claim fresh.
/// The write handle is required, not incidental: on Windows `set_modified` on a
/// read-only handle fails with PermissionDenied (the tests' `backdate` helper documents
/// the same constraint).
fn touch_in_dir(dir: &Path, key: &str) {
    let _ = std::fs::OpenOptions::new()
        .write(true)
        .open(dir.join(claim_filename(key)))
        .and_then(|f| f.set_modified(SystemTime::now()));
}

/// Best-effort release of `key`'s claim inside `dir` (delete the file). Errors are
/// ignored — a release that fails or races another instance is harmless; the 30-day
/// sweep is the backstop. Takes a `&Path` so it's unit-testable without an `AppHandle`.
fn release_in_dir(dir: &Path, key: &str) {
    let _ = std::fs::remove_file(dir.join(claim_filename(key)));
}

/// Resolve `<app_data>/automation-claims`, creating it if needed. Mirrors the
/// `app.path().app_data_dir()` precedent in `agent_sandbox.rs`.
fn claims_dir(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
        .join(CLAIMS_DIR);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// True = this process won the claim (proceed with the automation); false = another
/// instance already claimed this exact `(repo, target, head, action)` run, so this
/// process must skip it. On any infrastructure error (unresolvable app-data dir,
/// unexpected filesystem error) this FAILS OPEN — returns `true` so a broken claims
/// dir never disables automations (see module docs). Sweeps stale claims first.
#[tauri::command]
pub async fn claim_automation_run(
    app: tauri::AppHandle,
    repo_key: String,
    target: String,
    head_sha: String,
    action: String,
) -> AppResult<bool> {
    let Ok(dir) = claims_dir(&app) else {
        // Can't resolve/create the dir → fail open, run the automation.
        return Ok(true);
    };
    // Best-effort housekeeping so the dir stays bounded even if instances crash
    // between claim and release.
    if let Some(cutoff) = SystemTime::now().checked_sub(SWEEP_MAX_AGE) {
        sweep_older_than(&dir, cutoff);
    }
    let key = composite_key(&repo_key, &target, &head_sha, &action);
    // Any error other than AlreadyExists fails open — the automation runs.
    Ok(claim_in_dir(&dir, &key).unwrap_or(true))
}

/// Best-effort release so a FAILED run doesn't permanently suppress the automation for
/// that head (a claim without a release would block retries forever). Always `Ok(())`
/// — a release failure is swallowed, and an unresolvable dir is a no-op.
#[tauri::command]
pub async fn release_automation_claim(
    app: tauri::AppHandle,
    repo_key: String,
    target: String,
    head_sha: String,
    action: String,
) -> AppResult<()> {
    if let Ok(dir) = claims_dir(&app) {
        let key = composite_key(&repo_key, &target, &head_sha, &action);
        release_in_dir(&dir, &key);
    }
    Ok(())
}

/// Best-effort liveness heartbeat from a RUNNING automation: refreshes its claim's
/// mtime so [`STALE_CLAIM_AGE`] measures "has this instance gone quiet", not "how long
/// has this review taken". Called on an interval by the runner while the AI call is in
/// flight. Always `Ok(())` — a failed heartbeat (missing file, permission, unresolvable
/// dir) is silently tolerated, degrading to the pre-heartbeat reclaim behavior.
#[tauri::command]
pub async fn touch_automation_claim(
    app: tauri::AppHandle,
    repo_key: String,
    target: String,
    head_sha: String,
    action: String,
) -> AppResult<()> {
    if let Ok(dir) = claims_dir(&app) {
        let key = composite_key(&repo_key, &target, &head_sha, &action);
        touch_in_dir(&dir, &key);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("gd-automation-claims-test-")
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    #[test]
    fn claim_release_reclaim_cycle() {
        let (_tmp, dir) = tmp_dir();
        let key = composite_key(r"C:\repo\one", "42", "abc123", "review");

        // First claim wins; a second claim for the SAME key loses.
        assert!(claim_in_dir(&dir, &key).unwrap(), "first claim should win");
        assert!(
            !claim_in_dir(&dir, &key).unwrap(),
            "second claim on the same key should lose"
        );

        // Releasing frees the key so a later claim wins again.
        release_in_dir(&dir, &key);
        assert!(
            claim_in_dir(&dir, &key).unwrap(),
            "claim after release should win again"
        );
    }

    #[test]
    fn different_action_or_head_are_independent_claims() {
        let (_tmp, dir) = tmp_dir();
        let base = composite_key(r"C:\repo\one", "42", "abc123", "review");
        let other_action = composite_key(r"C:\repo\one", "42", "abc123", "security");
        let other_head = composite_key(r"C:\repo\one", "42", "def456", "review");

        assert!(claim_in_dir(&dir, &base).unwrap());
        // A different action does not collide with the base claim.
        assert!(
            claim_in_dir(&dir, &other_action).unwrap(),
            "a different action is an independent claim"
        );
        // A different head sha does not collide either.
        assert!(
            claim_in_dir(&dir, &other_head).unwrap(),
            "a different head sha is an independent claim"
        );
    }

    #[test]
    fn filename_from_windows_path_key_is_legal_and_collision_free() {
        // A real worktree-identity key: an absolute Windows path (has `\` and `:`,
        // both illegal in filenames) plus target/head/action.
        let key = composite_key(
            r"C:\Users\me\AppData\Roaming\project\.git\worktrees\wt",
            "1234",
            "0f1e2d3c4b5a69788796a5b4c3d2e1f001122334",
            "review",
        );
        let name = claim_filename(&key);

        // No filesystem-illegal characters survive (Windows-illegal set covers the
        // superset we care about: \ / : * ? " < > |).
        for bad in ['\\', '/', ':', '*', '?', '"', '<', '>', '|'] {
            assert!(
                !name.contains(bad),
                "sanitized filename {name:?} must not contain {bad:?}"
            );
        }
        // Every char is in the sanitized alphabet plus the `-` separator and hex.
        assert!(
            name.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-'),
            "filename {name:?} contains an unexpected character"
        );

        // Two DIFFERENT keys whose sanitized tails coincide must not collide on the
        // filename — the FNV hash suffix discriminates them. These two keys differ
        // only in a `\` vs `_` early in the path, which sanitizes to the same tail.
        let a = format!("{}_{}_x", "A".repeat(60), "y");
        let b = format!("{}\\{}_x", "A".repeat(60), "y");
        assert_ne!(a, b, "the two source keys must differ");
        assert_ne!(
            claim_filename(&a),
            claim_filename(&b),
            "distinct keys must produce distinct filenames"
        );
    }

    #[test]
    fn fnv1a_64_is_deterministic_and_distinguishing() {
        // Locks the constants: this vector must never change across builds (that's the
        // whole point — two builds must agree). "" and "a" are the canonical FNV-1a-64
        // test vectors.
        assert_eq!(fnv1a_64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a_64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_ne!(fnv1a_64(b"review"), fnv1a_64(b"security"));
    }

    /// Backdate a claim file's mtime so it looks abandoned. Mirrors the sweep test:
    /// `set_modified` needs a writable handle on Windows.
    fn backdate(path: &Path, age: Duration) {
        let when = SystemTime::now() - age;
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(when)
            .unwrap();
    }

    #[test]
    fn stale_claim_is_reclaimed_and_caller_wins() {
        let (_tmp, dir) = tmp_dir();
        let key = composite_key(r"C:\repo\one", "42", "abc123", "review");

        // An instance takes the claim, then "dies" without releasing (its mtime ages
        // past the stale cutoff).
        assert!(claim_in_dir(&dir, &key).unwrap(), "first claim should win");
        let path = dir.join(claim_filename(&key));
        backdate(&path, STALE_CLAIM_AGE + Duration::from_secs(60));

        // The next claimant reclaims the abandoned file instead of being starved.
        assert!(
            claim_in_dir(&dir, &key).unwrap(),
            "a stale claim must be reclaimed by the next claimant"
        );
    }

    #[test]
    fn heartbeat_keeps_a_long_running_claim_alive() {
        let (_tmp, dir) = tmp_dir();
        let key = composite_key(r"C:\repo\one", "42", "abc123", "review");

        // A run takes the claim, then outlives STALE_CLAIM_AGE (a 45/60-minute
        // Review-timeout override) — but keeps heartbeating.
        assert!(claim_in_dir(&dir, &key).unwrap(), "first claim should win");
        let path = dir.join(claim_filename(&key));
        backdate(&path, STALE_CLAIM_AGE + Duration::from_secs(60));
        touch_in_dir(&dir, &key);

        // The refreshed mtime makes it fresh again, so a second instance is denied
        // instead of reclaiming and posting a duplicate paid review.
        assert!(
            !claim_in_dir(&dir, &key).unwrap(),
            "a heartbeated claim must keep denying a second claimant"
        );
    }

    #[test]
    fn heartbeat_on_a_missing_claim_is_a_no_op() {
        let (_tmp, dir) = tmp_dir();
        let key = composite_key(r"C:\repo\one", "42", "abc123", "review");
        let path = dir.join(claim_filename(&key));

        // A released/reclaimed claim must never be resurrected by a late heartbeat.
        assert!(!path.exists(), "precondition: no claim file yet");
        touch_in_dir(&dir, &key);
        assert!(
            !path.exists(),
            "a heartbeat must not create a claim file that isn't there"
        );
    }

    #[test]
    fn fresh_existing_claim_still_denies() {
        let (_tmp, dir) = tmp_dir();
        let key = composite_key(r"C:\repo\one", "42", "abc123", "review");

        // A just-taken (fresh) claim keeps excluding a second claimant — reclaim must
        // NOT fire before STALE_CLAIM_AGE.
        assert!(claim_in_dir(&dir, &key).unwrap(), "first claim should win");
        assert!(
            !claim_in_dir(&dir, &key).unwrap(),
            "a fresh existing claim must still deny the second claimant"
        );
    }

    #[test]
    fn stale_reclaim_rewrites_file_with_new_key() {
        let (_tmp, dir) = tmp_dir();
        // Two DISTINCT composite keys whose sanitized tails + hash collide onto the SAME
        // filename cannot be relied on, so assert the reclaimed file holds the CURRENT
        // key's content. Both claims key the same run, so the filename is identical and
        // the reclaim overwrites the file body with a fresh (identical) key. To prove the
        // content is the NEW write and not the stale one, we re-key the file content and
        // confirm it matches after reclaim.
        let key = composite_key(r"C:\repo\one", "42", "abc123", "review");
        assert!(claim_in_dir(&dir, &key).unwrap());
        let path = dir.join(claim_filename(&key));
        // Corrupt the stale file's content so we can tell a reclaim (rewrite) from a
        // no-op, then backdate it past the cutoff.
        std::fs::write(&path, b"STALE-LEFTOVER-CONTENT").unwrap();
        backdate(&path, STALE_CLAIM_AGE + Duration::from_secs(60));

        assert!(
            claim_in_dir(&dir, &key).unwrap(),
            "stale claim should be reclaimed"
        );
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            content, key,
            "a reclaimed claim file must hold the NEW composite key, not the stale content"
        );
    }

    #[test]
    fn sweep_removes_old_claims_but_keeps_fresh_ones() {
        let (_tmp, dir) = tmp_dir();
        let old_key = composite_key(r"C:\repo\one", "1", "oldhead", "review");
        let fresh_key = composite_key(r"C:\repo\one", "2", "freshhead", "review");

        // Create both claims.
        assert!(claim_in_dir(&dir, &old_key).unwrap());
        assert!(claim_in_dir(&dir, &fresh_key).unwrap());

        // Backdate the "old" claim's mtime well past the cutoff. Open with write
        // access — on Windows `set_modified` needs a writable handle (a read-only
        // `File::open` handle returns PermissionDenied).
        let old_path = dir.join(claim_filename(&old_key));
        let long_ago = SystemTime::now() - Duration::from_secs(60 * 24 * 60 * 60); // 60 days
        std::fs::OpenOptions::new()
            .write(true)
            .open(&old_path)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();

        // Sweep with a 30-day cutoff.
        let cutoff = SystemTime::now() - SWEEP_MAX_AGE;
        sweep_older_than(&dir, cutoff);

        assert!(
            !old_path.exists(),
            "an old-mtime claim should be swept away"
        );
        assert!(
            dir.join(claim_filename(&fresh_key)).exists(),
            "a fresh claim must survive the sweep"
        );
    }
}
