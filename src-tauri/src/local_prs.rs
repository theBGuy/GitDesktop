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
//! locks give lost-update safety. Known limit: the GUI writes this store through its own
//! plugin-store cache and takes neither lock, so a GUI/MCP overlap can still lose an
//! update — closing that needs the GUI's writes routed through Rust, as `review_notes`
//! does.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

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

/// Resolve the absolute path of the `local-prs.json` the frontend store writes.
/// Mirrors `tauri-plugin-store` v2's `BaseDirectory::AppData` resolution
/// (`dirs::data_dir()/<identifier>`) — see the module contract. Under `cfg(test)` an
/// installed [`TEST_STORE_DIR`] wins.
pub fn store_path() -> AppResult<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = TEST_STORE_DIR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
    {
        return Ok(dir.join(STORE_FILE));
    }
    let data = dirs::data_dir()
        .ok_or_else(|| AppError::Command("could not resolve the app-data directory".to_string()))?;
    Ok(data.join(APP_IDENTIFIER).join(STORE_FILE))
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

#[cfg(test)]
mod tests {
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
    /// lock — as must any future test that drives the public read/write fns. Poisoning is
    /// ignored: the guarded state is one override slot, not invariant data.
    static STORE_DIR_LOCK: Mutex<()> = Mutex::new(());

    fn store_dir_lock() -> std::sync::MutexGuard<'static, ()> {
        STORE_DIR_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Points the store at `dir` for as long as it's held and restores the prior override
    /// on drop — panics included, so a failing test can't leave one standing for whichever
    /// test is next through the lock.
    struct StoreDirOverride(Option<PathBuf>);

    impl StoreDirOverride {
        fn set(dir: &Path) -> Self {
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
