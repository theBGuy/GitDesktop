//! The cross-process signal for a worktree PROMOTE's window: removing a linked
//! worktree to free its branch, then checking that branch out in the main workspace.
//! The GUI sequences that window over several IPC calls, so no in-process lock spans
//! it, and the MCP server is a separate process whose branch tools could land inside.
//!
//! The marker is a fixed gate file under the repository's identity-keyed worktree root
//! (the root `update_marker` mints in, so every worktree of the repository and every
//! process bound to it resolves the same file), plus a JSON manifest beside it. A
//! promote holds the gate EXCLUSIVELY for its window; an MCP branch tool takes it
//! SHARED across its own check AND its git work, so a promote cannot open between
//! the two, and a live exclusive hold refuses the tool. Two files for the same reason
//! as update markers: Windows blocks other processes' reads of a locked file.
//!
//! Liveness is the OS lock, which the OS releases when the GUI process dies. A GUI
//! that lives on after its webview reloaded mid-promote would hold it with nobody left
//! to call [`end`], so every reader also age-gates on the manifest: a hold older than
//! [`PROMOTE_MAX_AGE`] is stale and refuses nothing. Anything a probe cannot
//! establish fails OPEN — the MCP tool runs exactly as it did before markers existed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

const GATE_FILE: &str = "gd-promote.lock";
const MANIFEST_FILE: &str = "gd-promote.json";

/// How long a held gate counts as a live promote. A promote's window is seconds (its
/// worktree removal dominates); this bounds how long a promote stranded by a webview
/// reload can refuse MCP branch tools, at the cost of protecting a removal that runs
/// longer than it.
pub(crate) const PROMOTE_MAX_AGE: Duration = Duration::from_secs(300);

/// How long a promote waits for in-flight MCP tools to release the gate before
/// refusing. Their holds span one MCP tool call, a pull's fetch included, so a promote
/// that can't get in within the bound refuses rather than queuing.
const BEGIN_WAIT: Duration = crate::git::runner::LOCK_WAIT_TIMEOUT;
const BEGIN_POLL: Duration = Duration::from_millis(50);

/// The promotes this process holds, by the token [`begin`] handed out.
static HELD: Mutex<Option<HashMap<u64, HeldPromote>>> = Mutex::new(None);
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);

/// In-process test overrides for [`root_for`], keyed by the exact repo path a test
/// drives: under `cfg(test)` an override is the ONLY resolution, so a test that
/// installed none fails open instead of touching the developer's real app data, and a
/// concurrently running test on another repo never sees this one's live marker.
#[cfg(test)]
static TEST_ROOTS: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

#[cfg(test)]
fn test_roots() -> std::sync::MutexGuard<'static, Option<HashMap<String, PathBuf>>> {
    TEST_ROOTS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Points [`root_for`] at `dir` for `repo_path` alone while held, restoring that key's
/// prior override on drop. Test-only.
#[cfg(test)]
pub(crate) struct TestRootOverride {
    repo_path: String,
    prior: Option<PathBuf>,
}

#[cfg(test)]
impl TestRootOverride {
    pub(crate) fn set(repo_path: &str, dir: &Path) -> Self {
        let prior = test_roots()
            .get_or_insert_with(HashMap::new)
            .insert(repo_path.to_string(), dir.to_path_buf());
        Self {
            repo_path: repo_path.to_string(),
            prior,
        }
    }
}

#[cfg(test)]
impl Drop for TestRootOverride {
    fn drop(&mut self) {
        let mut roots = test_roots();
        let map = roots.get_or_insert_with(HashMap::new);
        match self.prior.take() {
            Some(prior) => map.insert(self.repo_path.clone(), prior),
            None => map.remove(&self.repo_path),
        };
    }
}

/// The directory the gate lives in: the identity-keyed root, through the same shared
/// resolver the MCP server uses, so the two processes can never key a repository
/// differently.
async fn root_for(repo_path: &str) -> AppResult<PathBuf> {
    #[cfg(test)]
    {
        test_roots()
            .as_ref()
            .and_then(|map| map.get(repo_path).cloned())
            .ok_or_else(|| {
                AppError::Command("no promote-marker root override is installed".to_string())
            })
    }
    #[cfg(not(test))]
    {
        let identity = crate::git::repo::repo_identity(repo_path).await?;
        crate::git::ops::identity_worktree_root_dir(&identity)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromoteManifest {
    /// The branch the promote is checking out, for the refusal's wording.
    branch: String,
    /// The owning process, for tracing a leftover by hand — never a liveness signal.
    pid: u32,
    /// Wall-clock start, which the age gate reads.
    started_at_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The gate file, created on first use and never deleted: unlinking a file another
/// process holds open would split the next opener onto a fresh inode.
fn open_gate(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

/// One promote's exclusive hold. Dropping it releases the gate.
struct HeldPromote {
    gate_path: PathBuf,
    branch: String,
    started_at_ms: u64,
    _gate: std::fs::File,
}

/// Publishes the manifest readers age-gate on, ATOMICALLY: a reader racing a plain
/// truncating write would parse a partial file, fail open, and let an MCP tool run
/// inside the live window. Written to a sibling temp file, then renamed over the
/// manifest, which `std::fs::rename` replaces in one step (`rename(2)` on Unix,
/// `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING` on Windows).
fn write_manifest(root: &Path, branch: &str, started_at_ms: u64) -> std::io::Result<()> {
    let manifest = serde_json::to_vec(&PromoteManifest {
        branch: branch.to_string(),
        pid: std::process::id(),
        started_at_ms,
    })
    .map_err(std::io::Error::other)?;
    sweep_stale_manifest_temps(root);
    // Unique per process and per write, so two writers never share a temp file.
    let tmp = root.join(format!(
        "{MANIFEST_FILE}.{}-{}{MANIFEST_TMP_SUFFIX}",
        std::process::id(),
        NEXT_TMP.fetch_add(1, Ordering::SeqCst)
    ));
    let published = std::fs::write(&tmp, manifest)
        .and_then(|()| std::fs::rename(&tmp, root.join(MANIFEST_FILE)));
    if published.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    published
}

const MANIFEST_TMP_SUFFIX: &str = ".tmp";
static NEXT_TMP: AtomicU64 = AtomicU64::new(1);

/// How old a manifest temp file must be before a writer deletes it. Only a write that
/// crashed between its write and its rename leaves one; the age keeps a sweep from
/// deleting another process's temp mid-publish.
const MANIFEST_TMP_MIN_AGE: Duration = Duration::from_secs(60);

/// Best-effort removal of temp files a crashed publish left behind.
fn sweep_stale_manifest_temps(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !(name.starts_with(MANIFEST_FILE) && name.ends_with(MANIFEST_TMP_SUFFIX)) {
            continue;
        }
        let aged = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= MANIFEST_TMP_MIN_AGE);
        if aged {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The refusal a promote raises when this process already holds the gate, or another
/// holder keeps it past [`BEGIN_WAIT`].
fn begin_busy() -> AppError {
    AppError::Command(
        "Another promote or branch change is still running in this repository — try again \
         when it finishes."
            .to_string(),
    )
}

/// The refusal an MCP branch tool returns while a promote holds the gate.
pub(crate) fn promote_in_progress_refusal(branch: &str) -> AppError {
    AppError::Command(format!(
        "A GitDesktop worktree promote is checking out {branch} in the main workspace — \
         retry in a few seconds."
    ))
}

/// Opens a promote's window for `repo_path`. `Ok(Some(token))` holds the gate until
/// [`end`]; `Ok(None)` means the marker could not be placed and the promote runs
/// unmarked, exactly as before markers existed; `Err` refuses the promote, which the
/// caller raises before its first mutation.
pub(crate) async fn begin(repo_path: &str, branch: &str) -> AppResult<Option<u64>> {
    let Ok(root) = root_for(repo_path).await else {
        return Ok(None);
    };
    begin_in(&root, branch, BEGIN_WAIT).await
}

/// [`begin`] over an explicit root and wait, so tests can drive it.
async fn begin_in(root: &Path, branch: &str, wait: Duration) -> AppResult<Option<u64>> {
    if std::fs::create_dir_all(root).is_err() {
        return Ok(None);
    }
    let gate_path = root.join(GATE_FILE);
    evict_stale_holds(&gate_path);
    // This process's own live hold (a promote stranded by a webview reload) refuses at
    // once rather than waiting out BEGIN_WAIT against a lock that can't come free.
    if held()
        .as_ref()
        .is_some_and(|map| map.values().any(|h| h.gate_path == gate_path))
    {
        return Err(begin_busy());
    }
    let Ok(gate) = open_gate(&gate_path) else {
        return Ok(None);
    };
    let deadline = std::time::Instant::now() + wait;
    loop {
        match gate.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) => {
                if std::time::Instant::now() >= deadline {
                    return Err(begin_busy());
                }
                tokio::time::sleep(BEGIN_POLL).await;
            }
            Err(std::fs::TryLockError::Error(_)) => return Ok(None),
        }
    }
    // The manifest is written ONLY under the exclusive hold, here and in `touch`: a
    // promote still waiting for the gate must never re-stamp another holder's manifest,
    // which would re-arm refusals for a hold that had aged out. Readers that meet the
    // hold before this write lands keep re-probing until it does, up to a deadline
    // (`hold_settled_in`). A failed write releases the gate, since a hold with no
    // manifest refuses nothing.
    let started_at_ms = now_ms();
    if write_manifest(root, branch, started_at_ms).is_err() {
        return Ok(None);
    }
    let token = NEXT_TOKEN.fetch_add(1, Ordering::SeqCst);
    held().get_or_insert_with(HashMap::new).insert(
        token,
        HeldPromote {
            gate_path,
            branch: branch.to_string(),
            started_at_ms,
            _gate: gate,
        },
    );
    Ok(Some(token))
}

/// Re-stamps a held promote's age, on disk and in memory, so a window whose removal
/// leg ran long still refuses for a full [`PROMOTE_MAX_AGE`] after it. Only a token in
/// [`HELD`] reaches the write, so it too publishes under the exclusive hold. Unknown
/// tokens and a failed write are no-ops: the hold keeps its earlier stamp.
pub(crate) fn touch(token: u64) {
    let mut guard = held();
    let Some(hold) = guard.as_mut().and_then(|map| map.get_mut(&token)) else {
        return;
    };
    let Some(root) = hold.gate_path.parent() else {
        return;
    };
    let now = now_ms();
    if write_manifest(root, &hold.branch, now).is_ok() {
        hold.started_at_ms = now;
    }
}

/// Closes the window [`begin`] opened. Unknown tokens are a no-op, so a repeated or
/// late call is harmless.
pub(crate) fn end(token: u64) {
    let released = held().as_mut().and_then(|map| map.remove(&token));
    drop(released);
}

fn held() -> std::sync::MutexGuard<'static, Option<HashMap<u64, HeldPromote>>> {
    HELD.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Releases this process's holds on `gate_path` that outlived [`PROMOTE_MAX_AGE`]:
/// readers already ignore them, and only a promote whose webview is gone leaves one,
/// so the next promote isn't refused by it.
fn evict_stale_holds(gate_path: &Path) {
    let now = now_ms();
    let max = PROMOTE_MAX_AGE.as_millis() as u64;
    let evicted: Vec<HeldPromote> = {
        let mut guard = held();
        let Some(map) = guard.as_mut() else {
            return;
        };
        let stale: Vec<u64> = map
            .iter()
            .filter(|(_, h)| h.gate_path == gate_path && now.saturating_sub(h.started_at_ms) > max)
            .map(|(token, _)| *token)
            .collect();
        stale.iter().filter_map(|t| map.remove(t)).collect()
    };
    drop(evicted);
}

/// A shared hold on the gate, kept across an MCP tool's git work so no promote can
/// open its window in between. Dropping it releases the hold.
pub(crate) struct PromoteGateShared {
    _gate: std::fs::File,
}

/// The MCP branch tools' composite check: refuses while a live promote holds the gate,
/// and otherwise returns the shared hold the caller keeps until its git work is done.
/// `Ok(None)` is the fail-open arm — nothing could be established, so the tool runs
/// unguarded rather than being blocked on a guess.
pub(crate) async fn hold_unless_promoting(repo_path: &str) -> AppResult<Option<PromoteGateShared>> {
    let Ok(root) = root_for(repo_path).await else {
        return Ok(None);
    };
    hold_settled_in(&root).await
}

/// The step between re-probes of a held gate whose manifest proves nothing yet.
const MANIFEST_SETTLE: Duration = Duration::from_millis(50);

/// How long a reader keeps re-probing an exclusively held gate with no fresh manifest
/// before failing open. A promote publishes right after taking the gate (one small
/// write and a rename, single-digit ms when healthy), so this outlasts descheduling by
/// orders of magnitude; still unproven past it means a wedged or dying writer, where
/// failing open is the module's polarity and a crashed writer's lock releases anyway.
///
/// Every held-but-unproven state waits it out: a manifest missing, unreadable, OR aged
/// out. Aged out has to wait too, because the publish gap shows the PREVIOUS promote's
/// manifest, usually long expired. The cost: while a hold is stranded past
/// [`PROMOTE_MAX_AGE`] (live process, webview gone), each gated tool waits this long
/// before running.
const UNPROVEN_DEADLINE: Duration = Duration::from_secs(2);

/// [`hold_unless_promoting`] over an explicit root.
async fn hold_settled_in(root: &Path) -> AppResult<Option<PromoteGateShared>> {
    hold_settled_with(root, UNPROVEN_DEADLINE, || {
        tokio::time::sleep(MANIFEST_SETTLE)
    })
    .await
}

/// Re-probes, shared acquisition included, while the gate is held but unproven, so a
/// reader never proceeds unguarded past a live hold whose manifest is still landing:
/// it ends on a fresh manifest (refuse), a freed gate (the shared hold), or `deadline`
/// (fail open). `settle` runs between probes, the seam tests drive deterministically.
async fn hold_settled_with<F, Fut>(
    root: &Path,
    deadline: Duration,
    mut settle: F,
) -> AppResult<Option<PromoteGateShared>>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    let until = std::time::Instant::now() + deadline;
    loop {
        match probe_gate(root) {
            GateProbe::HeldUnproven if std::time::Instant::now() < until => settle().await,
            probe => return resolve(probe),
        }
    }
}

/// What one look at the gate established.
enum GateProbe {
    /// The gate was free; the shared hold is the caller's to keep.
    Shared(PromoteGateShared),
    /// Held exclusively by a promote whose fresh manifest names this branch.
    Live(String),
    /// Held exclusively, but no readable, fresh manifest backs it.
    HeldUnproven,
    /// Nothing could be established.
    Unknown,
}

fn probe_gate(root: &Path) -> GateProbe {
    if std::fs::create_dir_all(root).is_err() {
        return GateProbe::Unknown;
    }
    let Ok(gate) = open_gate(&root.join(GATE_FILE)) else {
        return GateProbe::Unknown;
    };
    match gate.try_lock_shared() {
        Ok(()) => GateProbe::Shared(PromoteGateShared { _gate: gate }),
        Err(std::fs::TryLockError::WouldBlock) => match live_promote_branch(root) {
            Some(branch) => GateProbe::Live(branch),
            None => GateProbe::HeldUnproven,
        },
        Err(std::fs::TryLockError::Error(_)) => GateProbe::Unknown,
    }
}

/// Only a live promote refuses; an unproven hold and an unreadable gate fail open.
fn resolve(probe: GateProbe) -> AppResult<Option<PromoteGateShared>> {
    match probe {
        GateProbe::Shared(hold) => Ok(Some(hold)),
        GateProbe::Live(branch) => Err(promote_in_progress_refusal(&branch)),
        GateProbe::HeldUnproven | GateProbe::Unknown => Ok(None),
    }
}

/// One probe with no settle retry, for tests asserting a single look's verdict.
#[cfg(test)]
fn hold_unless_promoting_in(root: &Path) -> AppResult<Option<PromoteGateShared>> {
    resolve(probe_gate(root))
}

/// The branch a held gate's promote is checking out, or `None` when its manifest is
/// unreadable or older than [`PROMOTE_MAX_AGE`] — untrusted JSON never decides a
/// refusal, and an aged-out hold is a stranded one.
fn live_promote_branch(root: &Path) -> Option<String> {
    let bytes = std::fs::read(root.join(MANIFEST_FILE)).ok()?;
    let manifest: PromoteManifest = serde_json::from_slice(&bytes).ok()?;
    let age = now_ms().saturating_sub(manifest.started_at_ms);
    (age <= PROMOTE_MAX_AGE.as_millis() as u64).then_some(manifest.branch)
}

/// Opens a promote window from the GUI's promote sequence. The token is a string:
/// a `u64` loses precision as a JS number.
#[tauri::command]
pub async fn git_promote_begin(repo_path: String, branch: String) -> AppResult<Option<String>> {
    Ok(begin(&repo_path, &branch).await?.map(|t| t.to_string()))
}

/// Re-stamps the window's age once the promote's removal leg settles; a malformed
/// token is a no-op.
#[tauri::command]
pub async fn git_promote_touch(token: String) -> AppResult<()> {
    if let Ok(token) = token.parse::<u64>() {
        touch(token);
    }
    Ok(())
}

/// Closes the window `git_promote_begin` opened; a malformed token is a no-op.
#[tauri::command]
pub async fn git_promote_end(token: String) -> AppResult<()> {
    if let Ok(token) = token.parse::<u64>() {
        end(token);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-promote-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let root = dir.path().join("root");
        (dir, root)
    }

    /// Backdates a held promote, on disk and in memory, as if it began `by` ago.
    fn backdate(root: &Path, token: u64, by: Duration) {
        let started_at_ms = now_ms() - by.as_millis() as u64;
        if let Some(hold) = held().as_mut().and_then(|m| m.get_mut(&token)) {
            hold.started_at_ms = started_at_ms;
        }
        std::fs::write(
            root.join(MANIFEST_FILE),
            serde_json::to_vec(&PromoteManifest {
                branch: "feature".into(),
                pid: 4242,
                started_at_ms,
            })
            .unwrap(),
        )
        .unwrap();
    }

    /// A released lock can read held for a moment on Linux, where a flock rides
    /// `fork()` into concurrently spawned children until their exec; polling keeps
    /// the post-release asserts honest on every platform.
    fn eventually<T>(mut probe: impl FnMut() -> Option<T>) -> T {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(v) = probe() {
                return v;
            }
            assert!(std::time::Instant::now() < deadline, "never settled");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[tokio::test]
    async fn a_live_promote_refuses_and_its_end_releases() {
        let (_guard, root) = temp_root("live");
        let token = begin_in(&root, "feature", Duration::ZERO)
            .await
            .expect("a free gate opens")
            .expect("and is marked");

        let err = hold_unless_promoting_in(&root)
            .err()
            .expect("a live promote refuses the tool");
        assert_eq!(
            err.to_string(),
            "A GitDesktop worktree promote is checking out feature in the main workspace — \
             retry in a few seconds."
        );

        end(token);
        end(token);
        eventually(|| hold_unless_promoting_in(&root).ok().flatten());
    }

    /// The check and the act cannot interleave with a promote: while a tool holds the
    /// gate shared, a promote can't open, and it opens once the tool is done.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_tool_mid_act_holds_a_promote_off_until_it_finishes() {
        let (_guard, root) = temp_root("shared");
        let tool = hold_unless_promoting_in(&root)
            .expect("no promote runs")
            .expect("so the tool takes the gate");
        assert_eq!(
            begin_in(&root, "feature", Duration::ZERO)
                .await
                .expect_err("the promote can't open over a tool mid-act")
                .to_string(),
            begin_busy().to_string()
        );

        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            drop(tool);
        });
        let token = begin_in(&root, "feature", Duration::from_secs(5))
            .await
            .expect("the promote waits the tool out")
            .expect("and opens");
        release.await.unwrap();
        end(token);
    }

    /// A crashed promote leaves its manifest and an UNLOCKED gate: the OS released the
    /// lock with the process, so nothing is refused whatever the manifest says.
    #[test]
    fn a_crashed_promotes_leftovers_refuse_nothing() {
        let (_guard, root) = temp_root("crashed");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(GATE_FILE), b"").unwrap();
        std::fs::write(
            root.join(MANIFEST_FILE),
            serde_json::to_vec(&PromoteManifest {
                branch: "feature".into(),
                pid: 4242,
                started_at_ms: now_ms(),
            })
            .unwrap(),
        )
        .unwrap();
        assert!(hold_unless_promoting_in(&root)
            .expect("no refusal")
            .is_some());
    }

    /// A hold stranded past the age gate (a webview reloaded mid-promote, the process
    /// alive) stops refusing, and the next promote evicts it rather than being refused
    /// by it.
    #[tokio::test]
    async fn an_aged_out_hold_stops_refusing_and_is_evicted() {
        let (_guard, root) = temp_root("stale");
        let stranded = begin_in(&root, "feature", Duration::ZERO)
            .await
            .unwrap()
            .expect("marked");
        backdate(&root, stranded, PROMOTE_MAX_AGE + Duration::from_secs(1));
        assert!(
            hold_unless_promoting_in(&root)
                .expect("an aged-out hold refuses nothing")
                .is_none(),
            "fails open: the stranded exclusive hold still blocks a shared one"
        );

        let next = begin_in(&root, "other", Duration::from_secs(5))
            .await
            .expect("the stale hold is evicted")
            .expect("and the new promote marks");
        assert!(held()
            .as_ref()
            .is_some_and(|m| !m.contains_key(&stranded) && m.contains_key(&next)));
        assert!(hold_unless_promoting_in(&root)
            .err()
            .expect("the fresh promote refuses")
            .to_string()
            .contains("checking out other"));
        end(next);
    }

    /// A second promote against a gate this process still holds refuses at once and
    /// leaves the live holder's manifest alone, so a stranded hold's age and branch
    /// are never re-stamped by a retry.
    #[tokio::test]
    async fn a_same_process_conflict_refuses_without_touching_the_live_manifest() {
        let (_guard, root) = temp_root("same-process");
        let token = begin_in(&root, "feature", Duration::ZERO)
            .await
            .unwrap()
            .expect("marked");
        let before = std::fs::read(root.join(MANIFEST_FILE)).unwrap();

        let err = begin_in(&root, "other", Duration::ZERO)
            .await
            .expect_err("the gate is this process's own live hold");
        assert_eq!(err.to_string(), begin_busy().to_string());
        assert_eq!(std::fs::read(root.join(MANIFEST_FILE)).unwrap(), before);
        assert!(hold_unless_promoting_in(&root)
            .err()
            .expect("the live promote still refuses")
            .to_string()
            .contains("checking out feature"));
        end(token);
    }

    /// Writes `branch`'s manifest stamped `age` ago, as another process would have.
    fn write_foreign_manifest(root: &Path, branch: &str, age: Duration) {
        std::fs::write(
            root.join(MANIFEST_FILE),
            serde_json::to_vec(&PromoteManifest {
                branch: branch.into(),
                pid: 4242,
                started_at_ms: now_ms() - age.as_millis() as u64,
            })
            .unwrap(),
        )
        .unwrap();
    }

    /// Another process's stranded hold (its own handle, not in HELD) whose manifest
    /// aged out fails open; a promote here that can't get the gate refuses WITHOUT
    /// writing a manifest, so it never re-arms refusals for that dead hold.
    #[tokio::test]
    async fn a_busy_begin_writes_no_manifest() {
        let (_guard, root) = temp_root("busy-no-write");
        std::fs::create_dir_all(&root).unwrap();
        let foreign = open_gate(&root.join(GATE_FILE)).unwrap();
        foreign.try_lock().expect("the foreign hold takes the gate");
        write_foreign_manifest(&root, "stranded", PROMOTE_MAX_AGE + Duration::from_secs(1));
        let before = std::fs::read(root.join(MANIFEST_FILE)).unwrap();

        let err = begin_in(&root, "other", Duration::ZERO)
            .await
            .expect_err("the gate is held elsewhere");
        assert_eq!(err.to_string(), begin_busy().to_string());
        assert_eq!(std::fs::read(root.join(MANIFEST_FILE)).unwrap(), before);
        assert!(
            matches!(probe_gate(&root), GateProbe::HeldUnproven),
            "the aged-out manifest was not re-stamped, so nothing refuses on it"
        );
        drop(foreign);
    }

    /// A held gate with no manifest, as a promote leaves it between taking the gate and
    /// publishing.
    fn held_unproven_gate(tag: &str) -> (tempfile::TempDir, PathBuf, std::fs::File) {
        let (guard, root) = temp_root(tag);
        std::fs::create_dir_all(&root).unwrap();
        let foreign = open_gate(&root.join(GATE_FILE)).unwrap();
        foreign.try_lock().expect("the foreign hold takes the gate");
        assert!(matches!(probe_gate(&root), GateProbe::HeldUnproven));
        (guard, root, foreign)
    }

    /// A publish that lands several steps in (a descheduled promote, well past the old
    /// single settle step) is still caught: the reader keeps re-probing a held,
    /// unproven gate instead of failing open after a fixed number of looks. The publish
    /// happens INSIDE the injected step, so no timer race decides the outcome.
    #[tokio::test]
    async fn a_late_publish_is_still_caught() {
        let (_guard, root, foreign) = held_unproven_gate("late-publish");
        let mut steps = 0;
        let err = hold_settled_with(&root, UNPROVEN_DEADLINE, || {
            steps += 1;
            if steps == 4 {
                write_manifest(&root, "feature", now_ms()).unwrap();
            }
            std::future::ready(())
        })
        .await
        .err()
        .expect("the manifest landed before the deadline");
        assert!(err.to_string().contains("checking out feature"), "{err}");
        assert_eq!(steps, 4, "one more probe after the publish, then refuse");
        drop(foreign);
    }

    /// A gate freed while the reader waits ends the wait with a REAL shared hold, taken
    /// on the re-probe rather than assumed. Freed inside the injected step; later steps
    /// yield briefly, since on Linux a released flock can read held for a moment.
    #[tokio::test]
    async fn a_gate_freed_mid_wait_yields_the_shared_hold() {
        let (_guard, root, foreign) = held_unproven_gate("freed");
        let mut foreign = Some(foreign);
        let mut steps = 0;
        let hold = hold_settled_with(&root, UNPROVEN_DEADLINE, || {
            steps += 1;
            if steps == 3 {
                drop(foreign.take());
            }
            tokio::time::sleep(Duration::from_millis(1))
        })
        .await
        .expect("no promote proved")
        .expect("the freed gate is taken shared");
        assert!(steps >= 3, "the hold was released on step 3");
        // The shared hold is live: an exclusive try against it must block.
        let probe = open_gate(&root.join(GATE_FILE)).unwrap();
        assert!(matches!(
            probe.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(hold);
    }

    /// A hold that never proves itself (a wedged writer) fails open at the deadline,
    /// never hanging the tool.
    #[tokio::test]
    async fn a_never_proven_hold_fails_open_at_the_deadline() {
        let (_guard, root, foreign) = held_unproven_gate("deadline");
        let started = std::time::Instant::now();
        assert!(hold_settled_in(&root).await.expect("fails open").is_none());
        let waited = started.elapsed();
        assert!(waited >= UNPROVEN_DEADLINE, "returned early: {waited:?}");
        assert!(
            waited < UNPROVEN_DEADLINE + Duration::from_secs(3),
            "overran: {waited:?}"
        );
        drop(foreign);
    }

    /// A promote whose removal leg outlived the age gate re-stamps itself and refuses
    /// again, in memory too, so the next promote's eviction spares it.
    #[tokio::test]
    async fn a_touched_hold_refuses_again() {
        let (_guard, root) = temp_root("touch");
        let token = begin_in(&root, "feature", Duration::ZERO)
            .await
            .unwrap()
            .expect("marked");
        backdate(&root, token, PROMOTE_MAX_AGE + Duration::from_secs(1));
        assert!(hold_unless_promoting_in(&root).expect("aged out").is_none());

        touch(token);
        touch(u64::MAX);
        assert!(hold_unless_promoting_in(&root)
            .err()
            .expect("the touched hold refuses again")
            .to_string()
            .contains("checking out feature"));
        evict_stale_holds(&root.join(GATE_FILE));
        assert!(held().as_ref().is_some_and(|m| m.contains_key(&token)));
        end(token);
    }

    /// Every publish leaves exactly a parseable manifest and no temp sibling, and a
    /// crashed publish's aged temp is swept while a fresh one (another writer, mid
    /// publish) is left alone. A reader landing mid-write is not deterministically
    /// reachable from a test; the rename construction is what rules it out.
    #[tokio::test]
    async fn the_manifest_is_published_whole_and_leaves_no_temps() {
        let (_guard, root) = temp_root("publish");
        std::fs::create_dir_all(&root).unwrap();
        let stale = root.join(format!("{MANIFEST_FILE}.1-1{MANIFEST_TMP_SUFFIX}"));
        let fresh = root.join(format!("{MANIFEST_FILE}.2-2{MANIFEST_TMP_SUFFIX}"));
        for tmp in [&stale, &fresh] {
            std::fs::write(tmp, b"{\"bra").unwrap();
        }
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(SystemTime::now() - MANIFEST_TMP_MIN_AGE - Duration::from_secs(1))
            .unwrap();

        let token = begin_in(&root, "feature", Duration::ZERO)
            .await
            .unwrap()
            .expect("marked");
        for _ in 0..20 {
            touch(token);
            let bytes = std::fs::read(root.join(MANIFEST_FILE)).unwrap();
            let manifest: PromoteManifest =
                serde_json::from_slice(&bytes).expect("the manifest always parses");
            assert_eq!(manifest.branch, "feature");
        }
        let mut temps: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(str::to_string))
            .filter(|n| n.ends_with(MANIFEST_TMP_SUFFIX))
            .collect();
        temps.sort();
        assert_eq!(
            temps,
            vec![fresh.file_name().unwrap().to_str().unwrap().to_string()],
            "the aged temp is swept, the fresh one spared, and no publish leaves its own"
        );
        end(token);
    }

    /// Unreadable manifests never decide a refusal, and a fresh hold under the age gate
    /// still does.
    #[tokio::test]
    async fn the_age_gate_reads_only_a_well_formed_manifest() {
        let (_guard, root) = temp_root("manifest");
        let token = begin_in(&root, "feature", Duration::ZERO)
            .await
            .unwrap()
            .expect("marked");
        backdate(&root, token, PROMOTE_MAX_AGE - Duration::from_secs(5));
        assert!(
            hold_unless_promoting_in(&root).is_err(),
            "still in the window"
        );

        std::fs::write(root.join(MANIFEST_FILE), b"{\"branch\": 7}").unwrap();
        assert!(hold_unless_promoting_in(&root)
            .expect("fails open")
            .is_none());
        std::fs::remove_file(root.join(MANIFEST_FILE)).unwrap();
        assert!(hold_unless_promoting_in(&root)
            .expect("fails open")
            .is_none());
        end(token);
    }

    /// The IPC pair carries the token as a string and tolerates garbage on the way back.
    #[tokio::test]
    async fn the_ipc_pair_round_trips_a_string_token() {
        let (_guard, root) = temp_root("ipc");
        let _root = TestRootOverride::set("C:/repo", &root);
        let token = git_promote_begin("C:/repo".into(), "feature".into())
            .await
            .unwrap()
            .expect("marked");
        assert!(hold_unless_promoting("C:/repo").await.is_err());
        // Overrides are per repository, so a concurrent test on another repo never
        // meets this live marker.
        assert!(hold_unless_promoting("C:/other-repo")
            .await
            .expect("no override for this repo fails open")
            .is_none());
        git_promote_end("not-a-token".into()).await.unwrap();
        assert!(
            hold_unless_promoting("C:/repo").await.is_err(),
            "garbage ends nothing"
        );
        git_promote_end(token).await.unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while hold_unless_promoting("C:/repo")
            .await
            .ok()
            .flatten()
            .is_none()
        {
            assert!(std::time::Instant::now() < deadline, "never released");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
