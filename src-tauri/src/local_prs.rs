//! Local-PR storage core for the MCP server's write tools.
//!
//! **Local PRs are GitDesktop's own app-data review artifacts** — no git or remote
//! writes are involved. The GUI persists them via the Tauri Store plugin
//! (`src/lib/pulls/local.ts`); this module is the headless mirror the MCP server
//! (which has NO `AppHandle`) uses to read/modify the SAME file.
//!
//! ## Storage-dir mirroring contract (the make-or-break detail)
//!
//! The frontend loads the store as `load("local-prs.json", { autoSave: true })`.
//! `tauri-plugin-store` v2 resolves a relative store path against
//! `BaseDirectory::AppData` (`resolve_store_path` in the plugin's `store.rs`:
//! `app.path().resolve(path, BaseDirectory::AppData)`). Tauri's `AppData` resolver
//! (`tauri`'s `path/desktop.rs::app_data_dir`) is `dirs::data_dir()/<identifier>`,
//! and our identifier is `com.thebguy.gitdesktop` (tauri.conf.json). So the file is:
//!
//! ```text
//!   Windows: %APPDATA%\com.thebguy.gitdesktop\local-prs.json
//!            (dirs::data_dir() = the Roaming AppData dir)
//!   macOS:   ~/Library/Application Support/com.thebguy.gitdesktop/local-prs.json
//!   Linux:   $XDG_DATA_HOME (or ~/.local/share)/com.thebguy.gitdesktop/local-prs.json
//! ```
//!
//! We resolve it here with the SAME `dirs::data_dir()` the Tauri path layer uses,
//! joined with the identifier — so the two processes always agree on the file.
//! (Verified on this machine: `C:\Users\Evan\AppData\Roaming\com.thebguy.gitdesktop\
//! local-prs.json` exists with the expected `{ [repoPath]: LocalPr[] }` shape.)
//! Always the real `local-prs.json` name — the frontend's cold-start `coldstart-`
//! alias is a GUI-only concern the server never participates in.
//!
//! ## Value-based round-trip (never drop unknown fields)
//!
//! The whole file is read as a `serde_json::Value`, and only the target repo key's
//! array is mutated — record-by-record as `Value`s. We NEVER deserialize existing
//! records into a struct and re-serialize them, because that would silently drop any
//! field a future GUI version adds. NEW records are built from a typed struct (so the
//! shape is guaranteed correct) then converted to `Value`. Writes are atomic (temp
//! file in the same dir + rename over the target).
//!
//! ## Statelessness
//!
//! The GUI holds this store in memory (`autoSave`), so every call here does a FRESH
//! read → modify → atomic write. We never cache across calls: the contract is
//! "never write from stale memory".

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

/// The Tauri bundle identifier — the app-data subdir the store plugin writes under.
const APP_IDENTIFIER: &str = "com.thebguy.gitdesktop";
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

/// Resolve the absolute path of the `local-prs.json` the frontend store writes.
/// Mirrors `tauri-plugin-store` v2's `BaseDirectory::AppData` resolution
/// (`dirs::data_dir()/<identifier>`) — see the module contract.
pub fn store_path() -> AppResult<PathBuf> {
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

/// Create a new local PR under `repo` and PREPEND it (matching the GUI). Returns the
/// created record as a `Value`. The caller is responsible for having validated that
/// `base`/`head` resolve as branches — this core only touches app data.
pub fn create(repo: &str, title: &str, body: &str, base: &str, head: &str) -> AppResult<Value> {
    let path = store_path()?;
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
/// then persist. `mutate` receives the record as a mutable `Map` so it edits only the
/// fields it means to — unknown fields on the record survive untouched. Errors if the
/// repo has no entry or no PR with that id.
fn mutate_pr<F>(repo: &str, id: &str, mutate: F) -> AppResult<Value>
where
    F: FnOnce(&mut Map<String, Value>) -> AppResult<()>,
{
    let path = store_path()?;
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
pub fn add_comment(repo: &str, id: &str, body: &str) -> AppResult<Value> {
    let comment = serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "body": body,
        "createdAt": now_iso(),
    });
    mutate_pr(repo, id, |pr| {
        let comments = pr
            .entry("comments")
            .or_insert_with(|| Value::Array(Vec::new()));
        comments
            .as_array_mut()
            .ok_or_else(|| AppError::Command("local PR `comments` is not an array".to_string()))?
            .push(comment);
        Ok(())
    })
}

/// Set the status of the PR with `id` under `repo` to `"open"` or `"closed"`.
/// `"merged"` is rejected here — merging is a git operation the MCP server must never
/// perform (it happens in GitDesktop). Returns the updated record.
pub fn set_status(repo: &str, id: &str, status: &str) -> AppResult<Value> {
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
}

/// Set the `approved` flag on the PR with `id` under `repo`. Returns the updated record.
pub fn set_approved(repo: &str, id: &str, approved: bool) -> AppResult<Value> {
    mutate_pr(repo, id, move |pr| {
        pr.insert("approved".to_string(), Value::Bool(approved));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // These tests exercise the pure store logic (read/mutate/write over a Value map)
    // against a temp file, bypassing `store_path()` so they never touch the real
    // app-data store. The public fns wrap this same logic + the fixed path.

    fn tmp_store() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "gd-local-prs-test-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        p
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
        let path = tmp_store();
        let store = read_store(&path).unwrap();
        assert!(store.is_empty());
    }

    #[test]
    fn malformed_store_is_an_error_not_a_clobber() {
        let path = tmp_store();
        std::fs::write(&path, b"{ this is not json").unwrap();
        let err = read_store(&path).unwrap_err();
        assert!(err.to_string().contains("not valid JSON"));
        // The bad file is left intact.
        assert_eq!(std::fs::read(&path).unwrap(), b"{ this is not json");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn atomic_write_round_trips() {
        let path = tmp_store();
        let mut store = Map::new();
        store.insert("repo".into(), json!([{ "id": "a" }]));
        write_store(&path, &store).unwrap();
        let back = read_store(&path).unwrap();
        assert_eq!(back["repo"][0]["id"], "a");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn unknown_fields_survive_a_comment_round_trip() {
        // A record carrying a field this Rust code has never heard of must survive a
        // mutation byte-meaningfully (the acceptance criterion for never dropping
        // unknown fields a future GUI adds).
        let path = tmp_store();
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
        std::fs::remove_file(&path).ok();
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
    fn now_iso_matches_js_toisostring_shape() {
        let ts = now_iso();
        // 2026-06-20T20:45:33.666Z — millis + Z.
        assert!(ts.ends_with('Z'), "expected Z suffix: {ts}");
        let dot = ts.find('.').expect("expected millisecond fraction");
        // exactly 3 fractional digits then Z
        assert_eq!(&ts[dot + 4..], "Z", "expected 3-digit millis: {ts}");
    }
}
