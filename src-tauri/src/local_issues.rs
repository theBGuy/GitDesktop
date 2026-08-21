//! Local-issue storage core for the MCP server's write/read tools.
//!
//! **Local issues are GitDesktop's own app-data issue tracker** — no forge or remote
//! writes are involved (they are NOT GitHub/GitLab issues). The GUI persists them via
//! the Tauri Store plugin (`src/lib/issues/local.ts`); this module is the headless
//! mirror the MCP server (which has NO `AppHandle`) uses to read/modify the SAME file.
//! It is a direct parallel of [`crate::local_prs`] — see that module for the full
//! storage-dir / Value-round-trip / statelessness contract, which applies identically
//! here (only the store filename and the record shape differ).
//!
//! ## Storage-dir mirroring contract
//!
//! The frontend loads the store as `load("local-issues.json", { autoSave: true })`;
//! `tauri-plugin-store` v2 resolves the relative path against `BaseDirectory::AppData`
//! (`dirs::data_dir()/<identifier>`), and our identifier is `com.thebguy.gitdesktop`.
//! So the file is:
//!
//! ```text
//!   Windows: %APPDATA%\com.thebguy.gitdesktop\local-issues.json
//!   macOS:   ~/Library/Application Support/com.thebguy.gitdesktop/local-issues.json
//!   Linux:   $XDG_DATA_HOME (or ~/.local/share)/com.thebguy.gitdesktop/local-issues.json
//! ```
//!
//! We resolve it here with the SAME `dirs::data_dir()` the Tauri path layer uses, joined
//! with the identifier (reusing [`crate::local_prs::APP_IDENTIFIER`]) — so the two
//! processes always agree on the file.
//!
//! ## Value-based round-trip (never drop unknown fields)
//!
//! The whole file is read as a `serde_json::Value`, and only the target repo key's array
//! is mutated — record-by-record as `Value`s. We NEVER deserialize existing records into
//! a struct and re-serialize them (that would silently drop any field a future GUI adds).
//! NEW records are built from a typed struct then converted to `Value`. Writes are atomic.
//!
//! ## Statelessness
//!
//! The GUI holds this store in memory (`autoSave`), so every call here does a FRESH
//! read → modify → atomic write. We never cache across calls.
//!
//! ## Concurrency
//!
//! Every read-modify-write holds the in-process [`ISSUES_LOCK`] and, inside it, the
//! cross-process [`crate::store_lock`] — see [`crate::local_prs`]'s concurrency section
//! for the contract and its known GUI-side limit, which applies identically here.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};
use crate::local_prs::APP_IDENTIFIER;

/// The store filename the GUI's local-issue store writes (`src/lib/issues/local.ts`).
const STORE_FILE: &str = "local-issues.json";

/// A newly-created local issue, serialized to `Value` for insertion. Mirrors the
/// frontend `LocalIssue` (`src/lib/issues/local.ts`) camelCase shape for a fresh issue.
/// Existing records are NEVER routed through this struct — only brand-new ones — so
/// unknown fields on older records are preserved untouched.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NewLocalIssue {
    id: String,
    title: String,
    body: String,
    status: String,
    labels: Vec<String>,
    comments: Vec<Value>,
    created_at: String,
}

/// Guards the whole read-modify-write of the shared store file within THIS process,
/// outside the cross-process file lock — the [`crate::local_prs`] pairing exactly.
fn issues_lock() -> &'static Mutex<()> {
    static ISSUES_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    ISSUES_LOCK.get_or_init(|| Mutex::new(()))
}

/// In-process test override, consulted by [`store_path`] before the real app-data
/// resolution — the ONLY seam a test may use to reach this store (mirrors
/// [`crate::local_prs`]'s; never process env, which races parallel tests' env reads).
#[cfg(test)]
static TEST_STORE_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

/// Installs (or clears) the in-process override, returning the previous value so a caller
/// can restore it. Test-only.
#[cfg(test)]
fn swap_test_store_dir(dir: Option<PathBuf>) -> Option<PathBuf> {
    let mut slot = TEST_STORE_DIR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::replace(&mut *slot, dir)
}

/// Resolve the absolute path of the `local-issues.json` the frontend store writes.
/// Mirrors `tauri-plugin-store` v2's `BaseDirectory::AppData` resolution
/// (`dirs::data_dir()/<identifier>`) — see the module contract and [`crate::local_prs`].
/// Under `cfg(test)` an installed [`TEST_STORE_DIR`] wins.
pub(crate) fn store_path() -> AppResult<PathBuf> {
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
                    "local-issues store at {} is not valid JSON: {e}",
                    path.display()
                ))
            })?;
            match value {
                Value::Object(map) => Ok(map),
                _ => Err(AppError::Command(format!(
                    "local-issues store at {} is not a JSON object",
                    path.display()
                ))),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(AppError::Io(e)),
    }
}

/// Serialize the store object (pretty) and write it back atomically — temp file in the
/// same dir + rename over the target (via [`crate::fsops::atomic_write`]).
fn write_store(path: &Path, store: &Map<String, Value>) -> AppResult<()> {
    let body = serde_json::to_string_pretty(&Value::Object(store.clone()))
        .map_err(|e| AppError::Command(format!("serialize local-issues store: {e}")))?;
    crate::fsops::atomic_write(path, body.as_bytes())
}

/// Compare two repo-path keys for "same repo" tolerantly: normalize separators to `/`,
/// and treat a leading Windows drive letter case-insensitively (`C:` == `c:`). Mirrors
/// [`crate::local_prs`]'s matcher (kept local so the two stores stay independent).
fn same_repo(a: &str, b: &str) -> bool {
    fn norm(s: &str) -> String {
        let slashed: String = s.chars().map(|c| if c == '\\' { '/' } else { c }).collect();
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

/// Return the array of local-issue records under `repo` as owned `Value`s (empty when
/// the repo has no entry). Read-only — the store file is not modified. The caller should
/// have resolved `repo` to the identity key (via `consolidate`) so it sees the folded set.
pub fn list(repo: &str) -> AppResult<Vec<Value>> {
    let path = store_path()?;
    let store = read_store(&path)?;
    let Some(key) = existing_key(&store, repo) else {
        return Ok(Vec::new());
    };
    match store.get(&key) {
        Some(Value::Array(arr)) => Ok(arr.clone()),
        Some(_) => Err(AppError::Command(format!(
            "local-issues entry for {repo} is not an array"
        ))),
        None => Ok(Vec::new()),
    }
}

/// Return the single local-issue record with `id` under `repo`, or an error naming the
/// id when none matches. Read-only.
pub fn get(repo: &str, id: &str) -> AppResult<Value> {
    list(repo)?
        .into_iter()
        .find(|iss| iss.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| AppError::Command(format!("no local issue with id {id}")))
}

/// Create a new local issue under `repo` and PREPEND it (matching the GUI). Returns the
/// created record as a `Value`. The locked write runs off the async runtime — see
/// [`crate::local_prs::create`] for why.
pub async fn create(repo: &str, title: &str, body: &str) -> AppResult<Value> {
    let (repo, title, body) = (repo.to_string(), title.to_string(), body.to_string());
    crate::store_lock::locked_store_task(move || create_sync(&repo, &title, &body)).await
}

/// The locked read-modify-write behind [`create`], on the caller's own thread.
fn create_sync(repo: &str, title: &str, body: &str) -> AppResult<Value> {
    let path = store_path()?;
    let _guard = issues_lock().lock().unwrap_or_else(|p| p.into_inner());
    let _store_lock = crate::store_lock::lock_store(&path);
    let mut store = read_store(&path)?;
    let record = NewLocalIssue {
        id: uuid::Uuid::new_v4().to_string(),
        title: title.to_string(),
        body: body.to_string(),
        status: "open".to_string(),
        labels: Vec::new(),
        comments: Vec::new(),
        created_at: now_iso(),
    };
    let record = serde_json::to_value(&record)
        .map_err(|e| AppError::Command(format!("serialize new local issue: {e}")))?;

    let key = existing_key(&store, repo).unwrap_or_else(|| repo.to_string());
    let arr = store.entry(key).or_insert_with(|| Value::Array(Vec::new()));
    let list = arr.as_array_mut().ok_or_else(|| {
        AppError::Command(format!("local-issues entry for {repo} is not an array"))
    })?;
    list.insert(0, record.clone());

    write_store(&path, &store)?;
    Ok(record)
}

/// Locate the issue with `id` inside `repo`'s array and apply `mutate` to it in place,
/// then persist, off the async runtime (see [`create`]). `mutate` receives the record as
/// a mutable `Map` so it edits only the fields it means to — unknown fields on the record
/// survive untouched. Errors if the repo has no entry or no issue with that id.
async fn mutate_issue<F>(repo: &str, id: &str, mutate: F) -> AppResult<Value>
where
    F: FnOnce(&mut Map<String, Value>) -> AppResult<()> + Send + 'static,
{
    let (repo, id) = (repo.to_string(), id.to_string());
    crate::store_lock::locked_store_task(move || mutate_issue_sync(&repo, &id, mutate)).await
}

/// The locked read-modify-write behind [`mutate_issue`], on the caller's own thread.
fn mutate_issue_sync<F>(repo: &str, id: &str, mutate: F) -> AppResult<Value>
where
    F: FnOnce(&mut Map<String, Value>) -> AppResult<()>,
{
    let path = store_path()?;
    let _guard = issues_lock().lock().unwrap_or_else(|p| p.into_inner());
    let _store_lock = crate::store_lock::lock_store(&path);
    let mut store = read_store(&path)?;
    let key = existing_key(&store, repo).ok_or_else(|| {
        AppError::Command(format!(
            "no local issues found for this repository (id {id})"
        ))
    })?;
    let list = store
        .get_mut(&key)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| AppError::Command(format!("no local issue with id {id}")))?;

    let target = list
        .iter_mut()
        .find(|iss| iss.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| AppError::Command(format!("no local issue with id {id}")))?;
    let obj = target
        .as_object_mut()
        .ok_or_else(|| AppError::Command(format!("local issue {id} is not an object")))?;
    mutate(obj)?;
    let updated = Value::Object(obj.clone());

    write_store(&path, &store)?;
    Ok(updated)
}

/// Append a comment (`{ id, body, createdAt }`) to the issue with `id` under `repo`.
/// Mirrors the frontend `LocalIssueComment` shape. Returns the updated record.
pub async fn add_comment(repo: &str, id: &str, body: &str) -> AppResult<Value> {
    let comment = serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "body": body,
        "createdAt": now_iso(),
    });
    mutate_issue(repo, id, move |iss| {
        let comments = iss
            .entry("comments")
            .or_insert_with(|| Value::Array(Vec::new()));
        comments
            .as_array_mut()
            .ok_or_else(|| AppError::Command("local issue `comments` is not an array".to_string()))?
            .push(comment);
        Ok(())
    })
    .await
}

/// The status values a local issue may hold — mirrors the frontend `LocalIssueStatus`
/// (`src/lib/issues/local.ts`): `"open" | "closed"`.
pub const STATUSES: [&str; 2] = ["open", "closed"];

/// Set the status of the issue with `id` under `repo` to `"open"` or `"closed"`. On
/// `"closed"` a `closedAt` timestamp is stamped (matching the GUI's optional field);
/// on `"open"` any prior `closedAt` is cleared. An unknown status is rejected with an
/// actionable error listing the valid values. Returns the updated record.
pub async fn set_status(repo: &str, id: &str, status: &str) -> AppResult<Value> {
    if !STATUSES.contains(&status) {
        return Err(AppError::Command(format!(
            "status must be one of {:?} (got \"{status}\")",
            STATUSES
        )));
    }
    let status = status.to_string();
    mutate_issue(repo, id, move |iss| {
        if status == "closed" {
            iss.insert("closedAt".to_string(), Value::String(now_iso()));
        } else {
            iss.remove("closedAt");
        }
        iss.insert("status".to_string(), Value::String(status));
        Ok(())
    })
    .await
}

/// Fold any local-issue records still stored under a legacy checkout-PATH key into the
/// repo's worktree-stable identity key, one time. Direct parallel of
/// [`crate::local_prs::consolidate`] — see that fn for the full rationale (worktree-stable
/// keying so the GUI's and MCP's records land on the same key). `identity` is
/// [`crate::git::repo::repo_identity`]'s output; `legacy` is the raw `--repo` path.
/// Idempotent: a no-op once no distinct legacy key remains.
pub async fn consolidate(identity: &str, legacy: &str) -> AppResult<()> {
    let (identity, legacy) = (identity.to_string(), legacy.to_string());
    crate::store_lock::locked_store_task(move || consolidate_sync(&identity, &legacy)).await
}

/// The locked read-modify-write behind [`consolidate`], on the caller's own thread.
fn consolidate_sync(identity: &str, legacy: &str) -> AppResult<()> {
    let path = store_path()?;
    let _guard = issues_lock().lock().unwrap_or_else(|p| p.into_inner());
    let _store_lock = crate::store_lock::lock_store(&path);
    let mut store = read_store(&path)?;
    if fold_legacy_key(&mut store, identity, legacy) {
        write_store(&path, &store)?;
    }
    Ok(())
}

/// The pure in-memory fold behind [`consolidate`] (so it's testable against a plain map).
/// Moves the legacy checkout-path key's array onto the identity key, de-duplicating by
/// `id` (identity's own records come first). Returns whether the store changed.
fn fold_legacy_key(store: &mut Map<String, Value>, identity: &str, legacy: &str) -> bool {
    let Some(legacy_key) = existing_key(store, legacy) else {
        return false; // nothing stored under the checkout path
    };
    let id_key = existing_key(store, identity).unwrap_or_else(|| identity.to_string());
    if legacy_key == id_key {
        return false; // already consolidated, or --repo already == identity
    }
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
            .prefix("gd-local-issues-test-")
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().join("store.json");
        (dir, path)
    }

    /// The store override is process-wide, so every test that installs one — or that
    /// asserts on the un-overridden resolution — takes this lock. Poisoning is ignored:
    /// the guarded state is one override slot, not invariant data.
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
    /// atomic write — which the pure-logic tests below deliberately bypass.
    // The serializing guard MUST span the awaits — it is what keeps the process-wide
    // override installed for the whole body. Sound because each `#[tokio::test]` owns a
    // current-thread runtime with this one task on it.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn create_then_mutate_round_trips_through_the_locked_path() {
        let _serialized = store_dir_lock();
        let (tmp, _unused) = tmp_store();
        let _override = StoreDirOverride::set(tmp.path());
        let repo = "C:/local-issues/locked-round-trip/.git";

        let created = create(repo, "Title", "Body").await.unwrap();
        let id = created["id"].as_str().unwrap().to_string();

        add_comment(repo, &id, "repro attached").await.unwrap();
        let updated = set_status(repo, &id, "closed").await.unwrap();
        assert_eq!(updated["status"], "closed");
        assert!(updated["closedAt"].is_string());

        let back = get(repo, &id).unwrap();
        assert_eq!(back["title"], "Title");
        assert_eq!(back["comments"][0]["body"], "repro attached");
        assert_eq!(list(repo).unwrap().len(), 1);
    }

    #[test]
    fn store_path_is_under_identifier_and_named() {
        let _serialized = store_dir_lock();
        let path = store_path().unwrap();
        // …/com.thebguy.gitdesktop/local-issues.json
        assert!(path.ends_with(STORE_FILE), "path: {}", path.display());
        assert!(
            path.to_string_lossy().contains(APP_IDENTIFIER),
            "path: {}",
            path.display()
        );
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
        // mutation (the acceptance criterion for never dropping unknown fields a future
        // GUI adds — e.g. `archived`, `hidden` on comments, or anything newer).
        let (_tmp, path) = tmp_store();
        let repo = r"C:\repo\one";
        let mut store = Map::new();
        store.insert(
            repo.to_string(),
            json!([{
                "id": "iss-1",
                "title": "T",
                "body": "B",
                "status": "open",
                "labels": [],
                "comments": [],
                "createdAt": "2026-01-01T00:00:00.000Z",
                "archived": true,
                "futureField": 1,
                "nested": { "keep": ["me", 2, true] }
            }]),
        );
        write_store(&path, &store).unwrap();

        // Drive the SAME mutation logic mutate_issue uses, but against our temp file.
        let mut s = read_store(&path).unwrap();
        {
            let list = s.get_mut(repo).unwrap().as_array_mut().unwrap();
            let iss = list[0].as_object_mut().unwrap();
            iss.entry("comments")
                .or_insert_with(|| Value::Array(vec![]))
                .as_array_mut()
                .unwrap()
                .push(json!({ "id": "c1", "body": "hi", "createdAt": "2026-01-02T00:00:00.000Z" }));
        }
        write_store(&path, &s).unwrap();

        let back = read_store(&path).unwrap();
        let iss = &back[repo][0];
        // Unknown fields untouched.
        assert_eq!(iss["archived"], true);
        assert_eq!(iss["futureField"], 1);
        assert_eq!(iss["nested"]["keep"], json!(["me", 2, true]));
        // The comment landed.
        assert_eq!(iss["comments"][0]["body"], "hi");
        // Known fields unchanged.
        assert_eq!(iss["status"], "open");
    }

    #[test]
    fn existing_key_reuses_tolerant_match() {
        let mut store = Map::new();
        store.insert(r"C:\repo\one".to_string(), json!([]));
        assert_eq!(
            existing_key(&store, "c:/repo/one").as_deref(),
            Some(r"C:\repo\one")
        );
        assert_eq!(existing_key(&store, r"C:\repo\two"), None);
    }

    #[test]
    fn fold_legacy_key_migrates_checkout_path_to_identity() {
        let legacy = r"C:\ProjectRepos\demo\harbor";
        let identity = "C:/ProjectRepos/demo/harbor/.git";
        let mut store = Map::new();
        store.insert(
            legacy.to_string(),
            json!([{ "id": "iss-1" }, { "id": "iss-2" }]),
        );

        assert!(fold_legacy_key(&mut store, identity, legacy));
        assert!(!store.contains_key(legacy));
        assert_eq!(store[identity].as_array().unwrap().len(), 2);
    }

    #[test]
    fn fold_legacy_key_merges_deduping_by_id() {
        let legacy = "C:/wt/harbor";
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
        assert_eq!(arr[0]["from"], "identity");
        assert_eq!(arr[1]["id"], "wt-only");
        assert!(!store.contains_key(legacy));
    }

    #[test]
    fn fold_legacy_key_is_a_noop_without_a_distinct_legacy_key() {
        let identity = "C:/ProjectRepos/demo/harbor/.git";
        let mut store = Map::new();
        store.insert(identity.to_string(), json!([{ "id": "iss-1" }]));
        assert!(!fold_legacy_key(
            &mut store,
            identity,
            r"C:\ProjectRepos\demo\harbor"
        ));
        assert_eq!(store[identity].as_array().unwrap().len(), 1);
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn set_status_stamps_and_clears_closed_at() {
        // Drive the status mutation over a temp file to check the closedAt behavior.
        let (_tmp, path) = tmp_store();
        let repo = r"C:\repo\stamp";
        let mut store = Map::new();
        store.insert(
            repo.to_string(),
            json!([{ "id": "iss-1", "status": "open", "comments": [] }]),
        );
        write_store(&path, &store).unwrap();

        // Close: stamps closedAt.
        let mut s = read_store(&path).unwrap();
        {
            let iss = s.get_mut(repo).unwrap().as_array_mut().unwrap()[0]
                .as_object_mut()
                .unwrap();
            iss.insert("closedAt".to_string(), Value::String(now_iso()));
            iss.insert("status".to_string(), Value::String("closed".to_string()));
        }
        write_store(&path, &s).unwrap();
        let back = read_store(&path).unwrap();
        assert_eq!(back[repo][0]["status"], "closed");
        assert!(back[repo][0]["closedAt"].is_string());

        // Reopen: clears closedAt.
        let mut s = read_store(&path).unwrap();
        {
            let iss = s.get_mut(repo).unwrap().as_array_mut().unwrap()[0]
                .as_object_mut()
                .unwrap();
            iss.remove("closedAt");
            iss.insert("status".to_string(), Value::String("open".to_string()));
        }
        write_store(&path, &s).unwrap();
        let back = read_store(&path).unwrap();
        assert_eq!(back[repo][0]["status"], "open");
        assert!(back[repo][0].get("closedAt").is_none());
    }

    #[tokio::test]
    async fn statuses_reject_unknown_value() {
        // The public set_status rejects an out-of-vocab status; the error lists the
        // valid ones. (Uses set_status directly — it fails before touching any file
        // because the vocab check is first.)
        let err = set_status(r"C:\nope", "iss-1", "wip").await.unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("open"), "msg: {msg}");
        assert!(msg.contains("closed"), "msg: {msg}");
    }

    #[test]
    fn now_iso_matches_js_toisostring_shape() {
        let ts = now_iso();
        assert!(ts.ends_with('Z'), "expected Z suffix: {ts}");
        let dot = ts.find('.').expect("expected millisecond fraction");
        assert_eq!(&ts[dot + 4..], "Z", "expected 3-digit millis: {ts}");
    }
}
