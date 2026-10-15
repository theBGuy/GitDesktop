//! Local-PR storage core for the MCP server's write tools.
//!
//! **Local PRs are GitDesktop's own app-data review artifacts** — no git or remote
//! writes are involved. The GUI persists them via the Tauri Store plugin
//! (`src/lib/pulls/local.ts`); this module is the headless mirror the MCP server
//! (which has NO `AppHandle`) uses to read/modify the SAME file.
//!
//! ## Storage-dir mirroring contract (the make-or-break detail)
//!
//! The frontend loads `load("local-prs.json", { autoSave: true })`.
//! `tauri-plugin-store` v2 resolves a relative store path against
//! `BaseDirectory::AppData` (its `store.rs::resolve_store_path`), and Tauri's `AppData`
//! resolver is `dirs::data_dir()/<identifier>` with our identifier
//! `com.thebguy.gitdesktop` — i.e. `%APPDATA%\com.thebguy.gitdesktop\local-prs.json`
//! on Windows, `~/Library/Application Support/<id>/` on macOS, `$XDG_DATA_HOME/<id>/`
//! (or `~/.local/share/<id>/`) on Linux. We resolve it here with the SAME
//! `dirs::data_dir()`, so the two processes always agree on the file. Always the real
//! `local-prs.json` name — the frontend's cold-start `coldstart-` alias is GUI-only.
//!
//! ## Value-based round-trip (never drop unknown fields)
//!
//! The file is read as a `serde_json::Value` and only the target repo key's array is
//! mutated, record-by-record as `Value`s. Existing records are NEVER deserialized into
//! a struct and re-serialized — that would silently drop any field a future GUI version
//! adds. NEW records are built from a typed struct then converted. Writes are atomic
//! (temp file in the same dir + rename).
//!
//! ## Statelessness
//!
//! The GUI holds this store in memory (`autoSave`), so every call here does a FRESH
//! read → modify → atomic write. Never write from stale memory.
//!
//! ## Concurrency
//!
//! Two `gitdesktop mcp` servers can run at once (one per repo, or two on one repo), so
//! every read-modify-write here holds the in-process [`PRS_LOCK`] and, inside it, the
//! cross-process [`crate::store_lock`] — cheap exact serialization first, then the
//! OS-level file lock, which fails open. `atomic_write` gives torn-file safety; the
//! locks give lost-update safety. The GUI's plugin-store writes hold the same
//! cross-process lock through [`crate::store_lock_commands`]; cold-start instances are
//! the exception, writing a `coldstart-*` alias no second process touches. Branch
//! renames are ordered per repository by a separate [`RenameLock`], which refuses on
//! contention instead of failing open.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

/// The Tauri bundle identifier — the app-data subdir the store plugin writes under.
pub(crate) const APP_IDENTIFIER: &str = "com.thebguy.gitdesktop";
/// The store filename (always the real name; the cold-start alias is GUI-only).
const STORE_FILE: &str = "local-prs.json";

/// A newly-created local PR, serialized to `Value` for insertion. Mirrors the
/// frontend `LocalPr` (`src/lib/pulls/local.ts`) camelCase shape for a fresh PR.
/// Existing records are NEVER routed through this struct — only brand-new ones — so
/// unknown fields on older records are preserved untouched.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NewLocalPr {
    id: String,
    title: String,
    body: String,
    base: String,
    head: String,
    status: String,
    approved: bool,
    labels: Vec<String>,
    comments: Vec<Value>,
    created_at: String,
}

/// Guards the whole read-modify-write of the shared store file within THIS process
/// (mirroring [`crate::oplog`]'s lock). It sits OUTSIDE the cross-process file lock
/// deliberately: same-process serialization is exact and free, where the file lock fails
/// open after its retry budget.
fn prs_lock() -> &'static Mutex<()> {
    static PRS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    PRS_LOCK.get_or_init(|| Mutex::new(()))
}

/// How often a waiting rename re-tries the OS lock.
const RENAME_LOCK_POLL: Duration = Duration::from_millis(25);

/// What a rename refused for contention reports it queued behind.
const RENAME_BUSY_HOLDER: &str = "another branch rename";

/// Orders one repository's branch renames, in this process and across processes, from
/// before a rename's git step until both of its app-data moves have written. It holds no
/// store lock. Field order is release order: the OS file lock, then the in-process mutex.
/// The file is `None` when its location was unusable: ordering is then in-process only.
pub(crate) struct RenameLock {
    _file: Option<std::fs::File>,
    _in_process: tokio::sync::OwnedMutexGuard<()>,
}

/// One repository's in-process rename mutex, keyed by its identity. Same-process renames
/// queue here, fairly, before contending for the file, whose OS lock would order them
/// only by polling. Entries are never removed: one per repository renamed in this process.
fn rename_mutex(identity: &str) -> Arc<tokio::sync::Mutex<()>> {
    static RENAME_MUTEXES: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    RENAME_MUTEXES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .entry(identity.to_string())
        .or_default()
        .clone()
}

#[cfg(test)]
tokio::task_local! {
    /// Replaces [`lock_for_rename`]'s wait budget for the rename it is scoped to.
    pub(crate) static RENAME_LOCK_WAIT: Duration;
}

/// Take `identity`'s [`RenameLock`] within the repo lock's wait bound, or refuse with
/// [`AppError::Busy`]: contention refuses before git runs, since a rename run unordered
/// can land its moves on a dead name. A lock file opened read-only still orders. Only an
/// unusable one (an unusable app-data dir, a file that can't be opened at all, a lock
/// error other than contention) falls back to in-process ordering: a directory at fault
/// leaves the moves' store beside it unusable too.
pub(crate) async fn lock_for_rename(identity: &str) -> AppResult<RenameLock> {
    #[cfg(test)]
    let wait = RENAME_LOCK_WAIT
        .try_with(|wait| *wait)
        .unwrap_or(crate::git::runner::LOCK_WAIT_TIMEOUT);
    #[cfg(not(test))]
    let wait = crate::git::runner::LOCK_WAIT_TIMEOUT;
    let deadline = tokio::time::Instant::now() + wait;
    let busy = || AppError::Busy {
        holder: RENAME_BUSY_HOLDER.to_string(),
    };
    let in_process = tokio::time::timeout_at(deadline, rename_mutex(identity).lock_owned())
        .await
        .map_err(|_| busy())?;
    let path = match rename_lock_path(identity) {
        Ok(path) => path,
        Err(e) => return Ok(in_process_only(in_process, e)),
    };
    // A file another account left read-only still locks: neither flock nor LockFileEx
    // needs write access.
    let file = match open_rename_lock(&path) {
        Ok(file) => file,
        Err(rw) => match std::fs::OpenOptions::new().read(true).open(&path) {
            Ok(file) => file,
            Err(ro) => {
                let why = format!("{}: {rw}; read-only: {ro}", path.display());
                return Ok(in_process_only(in_process, why));
            }
        },
    };
    // Polled here, not on a blocking thread: `try_lock` never blocks, and a dropped
    // caller then leaves no poller behind to take the lock after it is gone.
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(RENAME_LOCK_POLL).await;
            }
            Err(std::fs::TryLockError::WouldBlock) => return Err(busy()),
            Err(std::fs::TryLockError::Error(e)) => {
                return Ok(in_process_only(in_process, lock_file_failure(&path, e)));
            }
        }
    }
    Ok(RenameLock {
        _file: Some(file),
        _in_process: in_process,
    })
}

/// The degraded [`RenameLock`]: logged once, never refused (see [`lock_for_rename`]).
fn in_process_only(
    in_process: tokio::sync::OwnedMutexGuard<()>,
    why: impl std::fmt::Display,
) -> RenameLock {
    eprintln!("gitdesktop: branch-rename lock file unusable, ordering in this process only: {why}");
    RenameLock {
        _file: None,
        _in_process: in_process,
    }
}

fn lock_file_failure(path: &Path, e: std::io::Error) -> String {
    format!("{}: {e}", path.display())
}

/// `identity`'s lock file, beside the store so both processes resolve it through the same
/// seam, and never the store's own `.lock`, which a waiter evicts by age. Hashed with the
/// build-stable [`crate::automation_claims::fnv1a_64`], so every build names it alike.
fn rename_lock_path(identity: &str) -> AppResult<PathBuf> {
    Ok(store_path()?.with_file_name(format!(
        "branch-rename-{:016x}.lock",
        crate::automation_claims::fnv1a_64(identity.as_bytes())
    )))
}

/// Opens (creating it and its directory when absent) the lock file. It is never deleted:
/// the OS lock on it is the whole signal, released when the holding handle closes,
/// including by the holder's exit, so no age can make a live hold look abandoned.
fn open_rename_lock(path: &Path) -> std::io::Result<std::fs::File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
}

/// In-process test override, consulted by [`store_path`] before the real app-data
/// resolution — the ONLY seam a test may use to reach this store, and the reason an
/// in-crate test can drive the public write fns without touching the developer's own
/// records. In-process rather than an env var: mutating process env races every other
/// test's env reads in the same binary (unsound, not merely flaky).
#[cfg(test)]
static TEST_STORE_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Installs (or clears) the in-process override, returning the previous value so a caller
/// can restore it. Test-only — [`TEST_STORE_DIR`] does not exist otherwise.
#[cfg(test)]
fn swap_test_store_dir(dir: Option<PathBuf>) -> Option<PathBuf> {
    let mut slot = TEST_STORE_DIR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::replace(&mut *slot, dir)
}

/// Pure resolution of the store's directory, in precedence order (mirroring
/// `review_notes::resolve_store_base`):
/// 1. an installed test override ([`TEST_STORE_DIR`]);
/// 2. under `cfg!(test)`, a temp subdir, so no in-crate test can reach the user's real
///    store (the branch-rename migration runs for real under `cargo test`);
/// 3. otherwise the real app-data dir (`dirs::data_dir()/<identifier>`), mirroring
///    `tauri-plugin-store` v2's `BaseDirectory::AppData` — see the module contract.
pub(crate) fn resolve_store_dir(
    test_override: Option<PathBuf>,
    is_test: bool,
) -> AppResult<PathBuf> {
    match test_override {
        Some(dir) => Ok(dir),
        None if is_test => Ok(std::env::temp_dir().join("gd-local-prs-test")),
        None => {
            let data = dirs::data_dir().ok_or_else(|| {
                AppError::Command("could not resolve the app-data directory".to_string())
            })?;
            Ok(data.join(APP_IDENTIFIER))
        }
    }
}

/// Resolve the absolute path of the `local-prs.json` the frontend store writes — see
/// [`resolve_store_dir`] for how the directory is chosen.
pub fn store_path() -> AppResult<PathBuf> {
    #[cfg(test)]
    let test_override = TEST_STORE_DIR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    #[cfg(not(test))]
    let test_override = None;
    Ok(resolve_store_dir(test_override, cfg!(test))?.join(STORE_FILE))
}

/// Read the whole store file as a JSON object. A missing file is an empty object;
/// a present-but-malformed file is a hard error (we must never clobber it).
fn read_store(path: &Path) -> AppResult<Map<String, Value>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
                AppError::Command(format!(
                    "local-prs store at {} is not valid JSON: {e}",
                    path.display()
                ))
            })?;
            match value {
                Value::Object(map) => Ok(map),
                _ => Err(AppError::Command(format!(
                    "local-prs store at {} is not a JSON object",
                    path.display()
                ))),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Serialize the store object (pretty) and write it back atomically — temp file in the
/// same dir + rename over the target (via [`crate::fsops::atomic_write`]) so a reader
/// never sees a partial file, and an existing store is reliably replaced on all platforms.
fn write_store(path: &Path, store: &Map<String, Value>) -> AppResult<()> {
    let body = serde_json::to_string_pretty(&Value::Object(store.clone()))
        .map_err(|e| AppError::Command(format!("serialize local-prs store: {e}")))?;
    crate::fsops::atomic_write(path, body.as_bytes())
}

/// Compare two repo-path keys for "same repo" tolerantly: normalize separators to
/// `/`, and treat a leading Windows drive letter case-insensitively (`C:` == `c:`).
/// The rest of the path stays case-sensitive (safe on all platforms; NTFS's own
/// case-insensitivity is out of scope — we only smooth over drive-letter + slash
/// variance, which is where real-world callers differ).
fn same_repo(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> String {
        let slashed: String = s.chars().map(|c| if c == '\\' { '/' } else { c }).collect();
        // Lowercase only a leading "X:" drive-letter prefix.
        let bytes = slashed.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let mut out = String::with_capacity(slashed.len());
            out.push(bytes[0].to_ascii_lowercase() as char);
            out.push_str(&slashed[1..]);
            out
        } else {
            slashed
        }
    }
    norm(a) == norm(b)
}

/// Find the EXISTING store key for `repo` (exact first, then tolerant match), so we
/// reuse the GUI's key variant instead of creating a second key for the same repo.
/// Returns `None` when the repo has no entry yet.
fn existing_key(store: &Map<String, Value>, repo: &str) -> Option<String> {
    if store.contains_key(repo) {
        return Some(repo.to_string());
    }
    store
        .keys()
        .find(|k| same_repo(k, repo))
        .map(String::to_string)
}

/// The current UTC timestamp in JS `Date.prototype.toISOString()` format —
/// RFC3339 with millisecond precision and a `Z` suffix (e.g. `2026-06-20T20:45:33.666Z`).
fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Return the array of local-PR records under `repo` as owned `Value`s (empty when the
/// repo has no entry). Read-only — the store file is not modified. The caller should have
/// resolved `repo` to the identity key (via [`consolidate`]) so it sees the folded set.
pub fn list(repo: &str) -> AppResult<Vec<Value>> {
    let path = store_path()?;
    let store = read_store(&path)?;
    let Some(key) = existing_key(&store, repo) else {
        return Ok(Vec::new());
    };
    match store.get(&key) {
        Some(Value::Array(arr)) => Ok(arr.clone()),
        Some(_) => Err(AppError::Command(format!(
            "local-prs entry for {repo} is not an array"
        ))),
        None => Ok(Vec::new()),
    }
}

/// Return the single local-PR record with `id` under `repo`, or an error naming the id
/// when none matches. Read-only.
pub fn get(repo: &str, id: &str) -> AppResult<Value> {
    list(repo)?
        .into_iter()
        .find(|pr| pr.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| AppError::Command(format!("no local PR with id {id}")))
}

/// Create a new local PR under `repo` and PREPEND it (matching the GUI). Returns the
/// created record as a `Value`. The caller is responsible for having validated that
/// `base`/`head` resolve as branches — this core only touches app data.
///
/// The locked write runs off the async runtime: the cross-process lock blocks its calling
/// thread for up to the retry budget, which must not park a tokio worker.
pub async fn create(
    repo: &str,
    title: &str,
    body: &str,
    base: &str,
    head: &str,
) -> AppResult<Value> {
    let (repo, title, body, base, head) = (
        repo.to_string(),
        title.to_string(),
        body.to_string(),
        base.to_string(),
        head.to_string(),
    );
    crate::store_lock::locked_store_task(move || create_sync(&repo, &title, &body, &base, &head))
        .await
}

/// The locked read-modify-write behind [`create`], on the caller's own thread.
fn create_sync(repo: &str, title: &str, body: &str, base: &str, head: &str) -> AppResult<Value> {
    let path = store_path()?;
    let _guard = prs_lock().lock().unwrap_or_else(|p| p.into_inner());
    let _store_lock = crate::store_lock::lock_store(&path);
    let mut store = read_store(&path)?;
    let record = NewLocalPr {
        id: uuid::Uuid::new_v4().to_string(),
        title: title.to_string(),
        body: body.to_string(),
        base: base.to_string(),
        head: head.to_string(),
        status: "open".to_string(),
        approved: false,
        labels: Vec::new(),
        comments: Vec::new(),
        created_at: now_iso(),
    };
    let record = serde_json::to_value(&record)
        .map_err(|e| AppError::Command(format!("serialize new local PR: {e}")))?;

    let key = existing_key(&store, repo).unwrap_or_else(|| repo.to_string());
    let arr = store.entry(key).or_insert_with(|| Value::Array(Vec::new()));
    let list = arr
        .as_array_mut()
        .ok_or_else(|| AppError::Command(format!("local-prs entry for {repo} is not an array")))?;
    list.insert(0, record.clone());

    write_store(&path, &store)?;
    Ok(record)
}

/// Locate the PR with `id` inside `repo`'s array and apply `mutate` to it in place,
/// then persist, off the async runtime (see [`create`]). `mutate` receives the record as
/// a mutable `Map` so it edits only the fields it means to — unknown fields on the record
/// survive untouched. Errors if the repo has no entry or no PR with that id.
async fn mutate_pr<F>(repo: &str, id: &str, mutate: F) -> AppResult<Value>
where
    F: FnOnce(&mut Map<String, Value>) -> AppResult<()> + Send + 'static,
{
    let (repo, id) = (repo.to_string(), id.to_string());
    crate::store_lock::locked_store_task(move || mutate_pr_sync(&repo, &id, mutate)).await
}

/// The locked read-modify-write behind [`mutate_pr`], on the caller's own thread.
fn mutate_pr_sync<F>(repo: &str, id: &str, mutate: F) -> AppResult<Value>
where
    F: FnOnce(&mut Map<String, Value>) -> AppResult<()>,
{
    let path = store_path()?;
    let _guard = prs_lock().lock().unwrap_or_else(|p| p.into_inner());
    let _store_lock = crate::store_lock::lock_store(&path);
    let mut store = read_store(&path)?;
    let key = existing_key(&store, repo).ok_or_else(|| {
        AppError::Command(format!("no local PRs found for this repository (id {id})"))
    })?;
    let list = store
        .get_mut(&key)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| AppError::Command(format!("no local PR with id {id}")))?;

    let target = list
        .iter_mut()
        .find(|pr| pr.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| AppError::Command(format!("no local PR with id {id}")))?;
    let obj = target
        .as_object_mut()
        .ok_or_else(|| AppError::Command(format!("local PR {id} is not an object")))?;
    mutate(obj)?;
    let updated = Value::Object(obj.clone());

    write_store(&path, &store)?;
    Ok(updated)
}

/// Append a comment (`{ id, body, createdAt }`) to the PR with `id` under `repo`.
/// Returns the updated record.
pub async fn add_comment(repo: &str, id: &str, body: &str) -> AppResult<Value> {
    let comment = serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "body": body,
        "createdAt": now_iso(),
    });
    mutate_pr(repo, id, move |pr| {
        let comments = pr
            .entry("comments")
            .or_insert_with(|| Value::Array(Vec::new()));
        comments
            .as_array_mut()
            .ok_or_else(|| AppError::Command("local PR `comments` is not an array".to_string()))?
            .push(comment);
        Ok(())
    })
    .await
}

/// Set the status of the PR with `id` under `repo` to `"open"` or `"closed"`.
/// `"merged"` is rejected here — merging is a git operation the MCP server must never
/// perform (it happens in GitDesktop). Returns the updated record.
pub async fn set_status(repo: &str, id: &str, status: &str) -> AppResult<Value> {
    if status != "open" && status != "closed" {
        return Err(AppError::Command(format!(
            "status must be \"open\" or \"closed\" (got \"{status}\"); merging a local PR happens in GitDesktop, not via this server"
        )));
    }
    let status = status.to_string();
    mutate_pr(repo, id, move |pr| {
        pr.insert("status".to_string(), Value::String(status));
        Ok(())
    })
    .await
}

/// Set the `approved` flag on the PR with `id` under `repo`. Returns the updated record.
pub async fn set_approved(repo: &str, id: &str, approved: bool) -> AppResult<Value> {
    mutate_pr(repo, id, move |pr| {
        pr.insert("approved".to_string(), Value::Bool(approved));
        Ok(())
    })
    .await
}

/// Fold any local-PR records still stored under a legacy checkout-PATH key into the
/// repo's worktree-stable identity key, one time. `identity` is
/// [`crate::git::repo::repo_identity`]'s output (the absolute common git dir); `legacy`
/// is the raw `--repo` path the server was launched with. A repo opened via a worktree
/// (or a differently spelled path) otherwise gets its own disjoint entry, making the
/// GUI's PRs invisible to the MCP. Merges by `id` when the identity key already holds
/// records (identity's own win) and removes the legacy key. Callers pass `identity` as
/// the `repo` arg to every other fn here. Idempotent: a no-op once no distinct legacy
/// key remains.
pub async fn consolidate(identity: &str, legacy: &str) -> AppResult<()> {
    let (identity, legacy) = (identity.to_string(), legacy.to_string());
    crate::store_lock::locked_store_task(move || consolidate_sync(&identity, &legacy)).await
}

/// The locked read-modify-write behind [`consolidate`], on the caller's own thread.
fn consolidate_sync(identity: &str, legacy: &str) -> AppResult<()> {
    let path = store_path()?;
    let _guard = prs_lock().lock().unwrap_or_else(|p| p.into_inner());
    let _store_lock = crate::store_lock::lock_store(&path);
    let mut store = read_store(&path)?;
    if fold_legacy_key(&mut store, identity, legacy) {
        write_store(&path, &store)?;
    }
    Ok(())
}

/// The pure in-memory fold behind [`consolidate`] (so it's testable against a
/// plain map). Moves the legacy checkout-path key's array onto the identity key,
/// de-duplicating by `id` (identity's own records come first). Returns whether the
/// store changed — `false` when there's nothing to fold, so the caller can skip
/// the write.
fn fold_legacy_key(store: &mut Map<String, Value>, identity: &str, legacy: &str) -> bool {
    // The key the raw checkout path maps to (exact, or slash/drive-tolerant).
    let Some(legacy_key) = existing_key(store, legacy) else {
        return false; // nothing stored under the checkout path
    };
    // The key the identity maps to (reuse an existing spelling if one's present).
    let id_key = existing_key(store, identity).unwrap_or_else(|| identity.to_string());
    if legacy_key == id_key {
        return false; // already consolidated, or --repo already == identity
    }
    // Take the legacy array out; anything non-array is left untouched (read paths
    // surface a clear error rather than us silently dropping it).
    let Some(Value::Array(legacy_list)) = store.remove(&legacy_key) else {
        return false;
    };
    let entry = store
        .entry(id_key)
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Some(arr) = entry.as_array_mut() {
        let seen: std::collections::HashSet<String> = arr
            .iter()
            .filter_map(|v| v.get("id").and_then(Value::as_str))
            .map(str::to_string)
            .collect();
        for rec in legacy_list {
            let dup = rec
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| seen.contains(id));
            if !dup {
                arr.push(rec);
            }
        }
    }
    true
}

/// Repoint OPEN local PRs' `head`/`base` from `from` to `to` under `identity`, after
/// folding any legacy checkout-path key ([`consolidate`]'s fold) so records minted under
/// an old path are not missed. Closed/merged records keep their history. Runs inside the
/// caller's `_ordered` rename lock, which it never takes, and holds this store's own lock
/// pair only for its read-modify-write, as every writer here does.
/// Returns how many records changed.
pub(crate) async fn rename_branch(
    _ordered: &RenameLock,
    identity: &str,
    legacy: &str,
    from: &str,
    to: &str,
) -> AppResult<u32> {
    let (identity, legacy, from, to) = (
        identity.to_string(),
        legacy.to_string(),
        from.to_string(),
        to.to_string(),
    );
    crate::store_lock::locked_store_task(move || rename_branch_sync(&identity, &legacy, &from, &to))
        .await
}

/// The locked read-modify-write behind [`rename_branch`], on the caller's own thread:
/// fold, then rename, in one pass. A repo with no entry is the common case, so a missing
/// key is `Ok(0)`.
fn rename_branch_sync(identity: &str, legacy: &str, from: &str, to: &str) -> AppResult<u32> {
    let path = store_path()?;
    let _guard = prs_lock().lock().unwrap_or_else(|p| p.into_inner());
    let _store_lock = crate::store_lock::lock_store(&path);
    let mut store = read_store(&path)?;
    let folded = fold_legacy_key(&mut store, identity, legacy);
    let changed =
        existing_key(&store, identity).map_or(0, |key| rename_refs_in(&mut store, &key, from, to));
    if folded || changed > 0 {
        write_store(&path, &store)?;
    }
    Ok(changed)
}

/// The pure edit behind [`rename_branch`]: in `key`'s array, every record whose
/// `status` is `"open"` gets an exact-match `head` and/or `base` of `from` set to `to`,
/// edited as `Value` maps so unknown fields survive. Returns how many records changed;
/// a non-array entry or non-object record is left alone.
fn rename_refs_in(store: &mut Map<String, Value>, key: &str, from: &str, to: &str) -> u32 {
    let Some(list) = store.get_mut(key).and_then(Value::as_array_mut) else {
        return 0;
    };
    let mut changed = 0;
    for pr in list.iter_mut().filter_map(Value::as_object_mut) {
        if pr.get("status").and_then(Value::as_str) != Some("open") {
            continue;
        }
        let mut touched = false;
        for field in ["head", "base"] {
            if pr.get(field).and_then(Value::as_str) == Some(from) {
                pr.insert(field.to_string(), Value::String(to.to_string()));
                touched = true;
            }
        }
        changed += u32::from(touched);
    }
    changed
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    // These tests exercise the pure store logic (read/mutate/write over a Value map)
    // against a temp file, bypassing `store_path()` so they never touch the real
    // app-data store. The public fns wrap this same logic + the fixed path.

    fn tmp_store() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("gd-local-prs-test-")
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().join("store.json");
        (dir, path)
    }

    /// The store override is process-wide, so every test that installs one takes this
    /// lock — as must any test, in any module, that reads `store_path` or drives the
    /// public fns. Poisoning is ignored: the guarded state is one override slot.
    static STORE_DIR_LOCK: Mutex<()> = Mutex::new(());

    pub(crate) fn store_dir_lock() -> std::sync::MutexGuard<'static, ()> {
        STORE_DIR_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Points the store at `dir` for as long as it's held and restores the prior override
    /// on drop — panics included, so a failing test can't leave one standing for whichever
    /// test is next through the lock.
    pub(crate) struct StoreDirOverride(Option<PathBuf>);

    impl StoreDirOverride {
        pub(crate) fn set(dir: &Path) -> Self {
            Self(swap_test_store_dir(Some(dir.to_path_buf())))
        }
    }

    impl Drop for StoreDirOverride {
        fn drop(&mut self) {
            swap_test_store_dir(self.0.take());
        }
    }

    /// The public write path end to end — through `store_path`, both locks, and the
    /// atomic write — which the pure-logic tests below deliberately bypass. A regression
    /// that deadlocks or fails open wrongly shows up here, not in them.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // override installed for the whole body. Sound because each `#[tokio::test]` owns a
    // current-thread runtime with this one task on it.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn create_then_mutate_round_trips_through_the_locked_path() {
        let _serialized = store_dir_lock();
        let (tmp, _unused) = tmp_store();
        let _override = StoreDirOverride::set(tmp.path());
        let repo = "C:/local-prs/locked-round-trip/.git";

        let created = create(repo, "Title", "Body", "main", "feature").await.unwrap();
        let id = created["id"].as_str().unwrap().to_string();

        add_comment(repo, &id, "looks good").await.unwrap();
        let updated = set_status(repo, &id, "closed").await.unwrap();
        assert_eq!(updated["status"], "closed");

        let back = get(repo, &id).unwrap();
        assert_eq!(back["title"], "Title");
        assert_eq!(back["comments"][0]["body"], "looks good");
        assert_eq!(list(repo).unwrap().len(), 1);
    }

    #[test]
    fn same_repo_tolerates_slashes_and_drive_case() {
        assert!(same_repo(
            r"C:\ProjectRepos\demo\harbor",
            "C:/ProjectRepos/demo/harbor"
        ));
        assert!(same_repo(
            r"C:\ProjectRepos\demo\harbor",
            r"c:\ProjectRepos\demo\harbor"
        ));
        assert!(!same_repo(r"C:\a\b", r"C:\a\c"));
    }

    #[test]
    fn read_missing_file_is_empty_object() {
        let (_tmp, path) = tmp_store();
        let store = read_store(&path).unwrap();
        assert!(store.is_empty());
    }

    #[test]
    fn malformed_store_is_an_error_not_a_clobber() {
        let (_tmp, path) = tmp_store();
        std::fs::write(&path, b"{ this is not json").unwrap();
        let err = read_store(&path).unwrap_err();
        assert!(err.to_string().contains("not valid JSON"));
        // The bad file is left intact.
        assert_eq!(std::fs::read(&path).unwrap(), b"{ this is not json");
    }

    #[test]
    fn atomic_write_round_trips() {
        let (_tmp, path) = tmp_store();
        let mut store = Map::new();
        store.insert("repo".into(), json!([{ "id": "a" }]));
        write_store(&path, &store).unwrap();
        let back = read_store(&path).unwrap();
        assert_eq!(back["repo"][0]["id"], "a");
    }

    #[test]
    fn unknown_fields_survive_a_comment_round_trip() {
        // A record carrying a field this Rust code has never heard of must survive a
        // mutation untouched.
        let (_tmp, path) = tmp_store();
        let repo = r"C:\repo\one";
        let mut store = Map::new();
        store.insert(
            repo.to_string(),
            json!([{
                "id": "pr-1",
                "title": "T",
                "body": "B",
                "base": "main",
                "head": "feature",
                "status": "open",
                "approved": false,
                "labels": [],
                "comments": [],
                "createdAt": "2026-01-01T00:00:00.000Z",
                "futureField": 1,
                "nested": { "keep": ["me", 2, true] }
            }]),
        );
        write_store(&path, &store).unwrap();

        // Drive the SAME mutation logic mutate_pr uses, but against our temp file.
        let mut s = read_store(&path).unwrap();
        {
            let list = s.get_mut(repo).unwrap().as_array_mut().unwrap();
            let pr = list[0].as_object_mut().unwrap();
            pr.entry("comments")
                .or_insert_with(|| Value::Array(vec![]))
                .as_array_mut()
                .unwrap()
                .push(json!({ "id": "c1", "body": "hi", "createdAt": "2026-01-02T00:00:00.000Z" }));
        }
        write_store(&path, &s).unwrap();

        let back = read_store(&path).unwrap();
        let pr = &back[repo][0];
        // Unknown fields untouched.
        assert_eq!(pr["futureField"], 1);
        assert_eq!(pr["nested"]["keep"], json!(["me", 2, true]));
        // The comment landed.
        assert_eq!(pr["comments"][0]["body"], "hi");
        // Known fields unchanged.
        assert_eq!(pr["status"], "open");
    }

    #[test]
    fn existing_key_reuses_tolerant_match() {
        let mut store = Map::new();
        store.insert(r"C:\repo\one".to_string(), json!([]));
        // A differently-spelled but same repo reuses the existing key.
        assert_eq!(
            existing_key(&store, "c:/repo/one").as_deref(),
            Some(r"C:\repo\one")
        );
        // A genuinely new repo has no key.
        assert_eq!(existing_key(&store, r"C:\repo\two"), None);
    }

    #[test]
    fn fold_legacy_key_migrates_checkout_path_to_identity() {
        // A repo whose PRs were stored under the checkout path folds onto the
        // worktree-stable identity key (the common git dir).
        let legacy = r"C:\ProjectRepos\demo\harbor";
        let identity = "C:/ProjectRepos/demo/harbor/.git";
        let mut store = Map::new();
        store.insert(legacy.to_string(), json!([{ "id": "pr-1" }, { "id": "pr-2" }]));

        assert!(fold_legacy_key(&mut store, identity, legacy));
        // Legacy key gone, identity key now holds both records.
        assert!(!store.contains_key(legacy));
        assert_eq!(store[identity].as_array().unwrap().len(), 2);
    }

    #[test]
    fn fold_legacy_key_merges_deduping_by_id() {
        // The identity key already has one PR; folding a legacy key that shares an
        // id keeps identity's copy and appends only the genuinely new record.
        let legacy = "C:/wt/harbor"; // a worktree checkout
        let identity = "C:/ProjectRepos/demo/harbor/.git";
        let mut store = Map::new();
        store.insert(
            identity.to_string(),
            json!([{ "id": "shared", "from": "identity" }]),
        );
        store.insert(
            legacy.to_string(),
            json!([{ "id": "shared", "from": "legacy" }, { "id": "wt-only" }]),
        );

        assert!(fold_legacy_key(&mut store, identity, legacy));
        let arr = store[identity].as_array().unwrap();
        assert_eq!(arr.len(), 2); // shared (kept once) + wt-only
        // Identity's own copy of the shared id won — not the legacy one.
        assert_eq!(arr[0]["from"], "identity");
        assert_eq!(arr[1]["id"], "wt-only");
        assert!(!store.contains_key(legacy));
    }

    #[test]
    fn fold_legacy_key_is_a_noop_without_a_distinct_legacy_key() {
        // Only the identity key present → nothing to fold.
        let identity = "C:/ProjectRepos/demo/harbor/.git";
        let mut store = Map::new();
        store.insert(identity.to_string(), json!([{ "id": "pr-1" }]));
        assert!(!fold_legacy_key(&mut store, identity, r"C:\ProjectRepos\demo\harbor"));
        // Unchanged.
        assert_eq!(store[identity].as_array().unwrap().len(), 1);
        assert_eq!(store.len(), 1);
    }

    /// Negative control for the `cfg(test)` default: with no override installed, the
    /// store resolves to the temp subdir, never under the real app-data dir — while the
    /// production arm still resolves exactly where the store plugin writes.
    #[test]
    fn store_path_under_test_never_resolves_to_the_real_app_data_dir() {
        let _serialized = store_dir_lock();
        let path = store_path().unwrap();
        assert_eq!(
            path,
            std::env::temp_dir()
                .join("gd-local-prs-test")
                .join(STORE_FILE)
        );
        let real_root = dirs::data_dir().expect("app-data dir");
        assert!(
            !path.starts_with(&real_root),
            "{} is under the real app-data dir",
            path.display()
        );
        assert_eq!(
            resolve_store_dir(None, false).unwrap(),
            real_root.join(APP_IDENTIFIER)
        );
        let over = PathBuf::from("C:/tmp/x");
        assert_eq!(resolve_store_dir(Some(over.clone()), true).unwrap(), over);
    }

    fn pr(id: &str, status: &str, base: &str, head: &str) -> Value {
        json!({ "id": id, "status": status, "base": base, "head": head })
    }

    #[test]
    fn rename_refs_in_moves_open_heads_and_bases_only() {
        let key = "C:/repo/.git";
        let mut store = Map::new();
        store.insert(
            key.to_string(),
            json!([
                pr("head-match", "open", "main", "feat/x"),
                pr("base-match", "open", "feat/x", "topic"),
                pr("both-match", "open", "feat/x", "feat/x"),
                pr("no-match", "open", "main", "feat/xy"),
                pr("closed", "closed", "main", "feat/x"),
                pr("merged", "merged", "feat/x", "feat/x"),
                { "id": "extra", "status": "open", "base": "main", "head": "feat/x",
                  "futureField": { "keep": [1, 2] } },
            ]),
        );
        store.insert(
            "C:/other/.git".to_string(),
            json!([pr("other", "open", "main", "feat/x")]),
        );

        assert_eq!(rename_refs_in(&mut store, key, "feat/x", "feat/y"), 4);
        let arr = store[key].as_array().unwrap();
        let get = |id: &str| arr.iter().find(|p| p["id"] == id).unwrap().clone();
        assert_eq!(get("head-match")["head"], "feat/y");
        assert_eq!(get("head-match")["base"], "main");
        assert_eq!(get("base-match")["base"], "feat/y");
        assert_eq!(get("base-match")["head"], "topic");
        assert_eq!(get("both-match")["base"], "feat/y");
        assert_eq!(get("both-match")["head"], "feat/y");
        assert_eq!(get("no-match")["head"], "feat/xy");
        assert_eq!(get("closed")["head"], "feat/x");
        assert_eq!(get("merged")["base"], "feat/x");
        assert_eq!(get("merged")["head"], "feat/x");
        assert_eq!(get("extra")["head"], "feat/y");
        assert_eq!(get("extra")["futureField"], json!({ "keep": [1, 2] }));
        // Another repo's records are untouched.
        assert_eq!(store["C:/other/.git"][0]["head"], "feat/x");
    }

    #[test]
    fn rename_refs_in_counts_zero_when_nothing_matches() {
        let key = "C:/repo/.git";
        let mut store = Map::new();
        store.insert(key.to_string(), json!([pr("a", "open", "main", "topic")]));
        let before = store.clone();
        assert_eq!(rename_refs_in(&mut store, key, "feat/x", "feat/y"), 0);
        assert_eq!(store, before);
        assert_eq!(
            rename_refs_in(&mut store, "C:/missing/.git", "main", "x"),
            0
        );
    }

    /// Seeds a store whose open PR lives under a LEGACY checkout-path key, the shape a
    /// worktree-opened repo left before identity keying.
    fn legacy_keyed_store(dir: &Path, legacy: &str, identity: &str) {
        let mut store = Map::new();
        store.insert(
            legacy.to_string(),
            json!([pr("legacy-pr", "open", "main", "feat/x")]),
        );
        store.insert(
            identity.to_string(),
            json!([pr("identity-pr", "open", "feat/x", "topic")]),
        );
        write_store(&dir.join(STORE_FILE), &store).unwrap();
    }

    /// End to end through the rename lock and the locked move: the legacy-keyed record is
    /// folded in first, so both PRs follow the rename. The negative control runs the same
    /// fixture through the rename step alone and misses the legacy record, which is what
    /// makes the fold load-bearing.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn rename_branch_consolidates_legacy_keys_first() {
        let _serialized = store_dir_lock();
        let (tmp, _unused) = tmp_store();
        let _override = StoreDirOverride::set(tmp.path());
        let (legacy, identity) = ("C:/wt/harbor", "C:/ProjectRepos/demo/harbor/.git");

        legacy_keyed_store(tmp.path(), legacy, identity);
        let ordered = lock_for_rename(identity).await.unwrap();
        assert_eq!(
            rename_branch(&ordered, identity, legacy, "feat/x", "feat/y")
                .await
                .unwrap(),
            2
        );
        let back = list(identity).unwrap();
        let get = |id: &str| back.iter().find(|p| p["id"] == id).unwrap().clone();
        assert_eq!(get("legacy-pr")["head"], "feat/y");
        assert_eq!(get("identity-pr")["base"], "feat/y");
        assert!(!read_store(&store_path().unwrap())
            .unwrap()
            .contains_key(legacy));

        legacy_keyed_store(tmp.path(), legacy, identity);
        let mut raw = read_store(&store_path().unwrap()).unwrap();
        assert_eq!(rename_refs_in(&mut raw, identity, "feat/x", "feat/y"), 1);
        assert_eq!(
            raw[legacy][0]["head"], "feat/x",
            "missed without consolidate"
        );
    }

    /// A held rename lock leaves the store's own locks free: a write from another task
    /// lands at once, and the move under the lock takes the store pair without waiting on
    /// the lock it runs inside. The timeouts turn a hang into a red test.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_held_rename_lock_leaves_store_writes_free_and_the_move_never_relocks() {
        let _serialized = store_dir_lock();
        let (tmp, _unused) = tmp_store();
        let _override = StoreDirOverride::set(tmp.path());
        let identity = "C:/ProjectRepos/demo/ordered/.git";
        create(identity, "Before", "", "main", "feat/x")
            .await
            .unwrap();

        let ordered = lock_for_rename(identity).await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            create(identity, "During", "", "main", "feat/x"),
        )
        .await
        .expect("a store write never waits on the rename lock")
        .unwrap();
        let changed = tokio::time::timeout(
            Duration::from_secs(10),
            rename_branch(&ordered, identity, identity, "feat/x", "feat/y"),
        )
        .await
        .expect("the move never waits on the lock it runs inside")
        .unwrap();
        assert_eq!(changed, 2, "both writes landed before the move");
        drop(ordered);
        assert!(rename_lock_takeable(identity, Duration::from_secs(5)));
    }

    /// An app-data dir that cannot hold the lock file still yields the lock, which keeps
    /// ordering this process's renames of that repository, and only that repository's.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn an_unwritable_lock_dir_falls_back_to_in_process_ordering() {
        let _serialized = store_dir_lock();
        let (tmp, _unused) = tmp_store();
        let blocker = tmp.path().join("not-a-dir");
        std::fs::write(&blocker, "a file where the app-data dir should be").unwrap();
        let _override = StoreDirOverride::set(&blocker.join("app-data"));
        let (identity, other) = ("C:/ProjectRepos/demo/fallback/.git", "C:/elsewhere/.git");

        let ordered = lock_for_rename(identity)
            .await
            .expect("an unusable lock file never refuses");
        let second = RENAME_LOCK_WAIT
            .scope(Duration::from_millis(100), lock_for_rename(identity))
            .await
            .err()
            .expect("the same repository's next rename still queues");
        assert!(
            matches!(&second, AppError::Busy { holder } if holder == RENAME_BUSY_HOLDER),
            "{second:?}"
        );
        let unrelated = RENAME_LOCK_WAIT
            .scope(Duration::from_millis(100), lock_for_rename(other))
            .await;
        assert!(unrelated.is_ok(), "another repository's rename is not held");
        drop(ordered);
        assert!(
            rename_mutex(identity).try_lock().is_ok(),
            "released on drop"
        );
    }

    /// A lock file that can't be opened for writing still orders across processes. On
    /// Unix, root bypasses the permission check, so there the read-write open succeeds and
    /// the assertions hold all the same.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_read_only_lock_file_still_orders_across_processes() {
        let _serialized = store_dir_lock();
        let (tmp, _unused) = tmp_store();
        let _override = StoreDirOverride::set(tmp.path());
        let identity = "C:/ProjectRepos/demo/read-only-lock/.git";
        let path = rename_lock_path(identity).unwrap();
        drop(open_rename_lock(&path).unwrap());
        let set_readonly = |readonly: bool| {
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_readonly(readonly);
            std::fs::set_permissions(&path, perms).unwrap();
        };
        set_readonly(true);

        let ordered = lock_for_rename(identity).await.unwrap();
        let held = !rename_lock_takeable(identity, Duration::ZERO);
        drop(ordered);
        let freed = rename_lock_takeable(identity, Duration::from_secs(5));
        // Before any assert: Windows can't delete a read-only file with its tempdir.
        set_readonly(false);
        assert!(held, "the read-only handle holds the cross-process lock");
        assert!(freed, "released on drop");
    }

    /// `identity`'s lock file, for a test that has to occupy its path.
    pub(crate) fn rename_lock_file(identity: &str) -> PathBuf {
        rename_lock_path(identity).unwrap()
    }

    /// Whether this process holds `identity`'s in-process rename mutex: a rename that has
    /// it is past its own pre-lock steps and is waiting on, or holding, the file.
    pub(crate) fn rename_mutex_held(identity: &str) -> bool {
        rename_mutex(identity).try_lock().is_err()
    }

    /// Takes `identity`'s rename lock through a handle of the test's own, the stand-in for
    /// another process's live hold; dropping the handle releases it. Waits out a
    /// concurrent rename that still holds it.
    pub(crate) fn hold_rename_lock_elsewhere(identity: &str) -> std::fs::File {
        let held = open_rename_lock(&rename_lock_path(identity).unwrap()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while held.try_lock().is_err() {
            assert!(
                std::time::Instant::now() < deadline,
                "the rename lock never came free"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        held
    }

    /// Whether a fresh handle can take `identity`'s rename lock within `wait` (`ZERO` probes
    /// once). Polled because on Linux a released flock can read held for a moment, while a
    /// concurrently spawned child has yet to exec.
    pub(crate) fn rename_lock_takeable(identity: &str, wait: Duration) -> bool {
        let path = rename_lock_path(identity).unwrap();
        let deadline = std::time::Instant::now() + wait;
        loop {
            let probe = open_rename_lock(&path)
                .or_else(|_| std::fs::File::open(&path))
                .unwrap();
            match probe.try_lock() {
                Ok(()) => return true,
                Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => return false,
            }
        }
    }

    #[test]
    fn now_iso_matches_js_toisostring_shape() {
        let ts = now_iso();
        // 2026-06-20T20:45:33.666Z — millis + Z.
        assert!(ts.ends_with('Z'), "expected Z suffix: {ts}");
        let dot = ts.find('.').expect("expected millisecond fraction");
        // exactly 3 fractional digits then Z
        assert_eq!(&ts[dot + 4..], "Z", "expected 3-digit millis: {ts}");
    }

    #[test]
    fn list_returns_empty_for_missing_repo() {
        // `list`/`get` resolve the store key with the same tolerant matcher as the
        // writers. A repo with no entry lists as empty (not an error).
        let mut store = Map::new();
        store.insert(r"C:\repo\one".to_string(), json!([{ "id": "pr-1" }]));
        assert!(existing_key(&store, r"C:\repo\two").is_none());
        // (The public read fns aren't called here; `list_and_get_read_records_tolerantly`
        // exercises the same read logic over a temp store file.)
    }

    #[test]
    fn list_and_get_read_records_tolerantly() {
        let (_tmp, path) = tmp_store();
        // Bypass store_path() by exercising the same read logic the public fns use.
        let repo = r"C:\repo\reads";
        let mut store = Map::new();
        store.insert(
            repo.to_string(),
            json!([{ "id": "pr-1", "title": "A" }, { "id": "pr-2", "title": "B" }]),
        );
        write_store(&path, &store).unwrap();

        // list: all records, in order.
        let back = read_store(&path).unwrap();
        let key = existing_key(&back, "c:/repo/reads").unwrap(); // tolerant match
        let arr = back.get(&key).unwrap().as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["id"], "pr-1");
        // get: find by id.
        let found = arr
            .iter()
            .find(|pr| pr.get("id").and_then(Value::as_str) == Some("pr-2"));
        assert_eq!(found.unwrap()["title"], "B");
    }
}
