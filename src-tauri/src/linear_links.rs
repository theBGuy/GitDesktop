use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::{AppError, AppResult};

const STORE_FILE: &str = "linear-links.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearLinkEntry {
    pub workspace_slug: String,
    pub team_key: String,
    pub team_name: String,
}

pub fn store_path() -> AppResult<PathBuf> {
    let data = dirs::data_dir()
        .ok_or_else(|| AppError::Command("could not resolve the app-data directory".to_string()))?;
    Ok(data.join(crate::local_prs::APP_IDENTIFIER).join(STORE_FILE))
}

fn read_store(path: &Path) -> AppResult<Map<String, Value>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let value: Value = serde_json::from_slice(&bytes).map_err(|e| {
                AppError::Command(format!(
                    "linear-links store at {} is not valid JSON: {e}",
                    path.display()
                ))
            })?;
            match value {
                Value::Object(map) => Ok(map),
                _ => Err(AppError::Command(format!(
                    "linear-links store at {} is not a JSON object",
                    path.display()
                ))),
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Map::new()),
        Err(e) => Err(AppError::Io(e)),
    }
}

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

fn link_from_value(value: &Value) -> Option<LinearLinkEntry> {
    let obj = value.as_object()?;
    let workspace_slug = obj
        .get("workspaceSlug")
        .and_then(Value::as_str)?
        .to_string();
    let team_key = obj.get("teamKey").and_then(Value::as_str)?.to_string();
    let team_name = obj.get("teamName").and_then(Value::as_str)?.to_string();
    Some(LinearLinkEntry {
        workspace_slug,
        team_key,
        team_name,
    })
}

fn lookup(store: &Map<String, Value>, identity: &str, legacy: &str) -> Option<LinearLinkEntry> {
    if let Some(link) = store.get(identity).and_then(link_from_value) {
        return Some(link);
    }
    if identity == legacy {
        return None;
    }
    if let Some(link) = store.get(legacy).and_then(link_from_value) {
        return Some(link);
    }
    store
        .iter()
        .find(|(k, _)| same_repo(k, legacy))
        .and_then(|(_, v)| link_from_value(v))
}

pub async fn get_link(repo_path: &str) -> AppResult<Option<LinearLinkEntry>> {
    let identity = crate::git::repo::repo_identity(repo_path).await;
    let path = store_path()?;
    let store = read_store(&path)?;
    Ok(lookup(&store, &identity, repo_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn link_json() -> Value {
        json!({
            "workspaceSlug": "acme",
            "teamKey": "ENG",
            "teamName": "Engineering",
        })
    }

    fn tmp_store() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("gd-linear-links-test-")
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().join("store.json");
        (dir, path)
    }

    #[test]
    fn read_missing_file_is_empty_object() {
        let (_tmp, path) = tmp_store();
        let store = read_store(&path).unwrap();
        assert!(store.is_empty());
    }

    #[test]
    fn malformed_store_is_an_error() {
        let (_tmp, path) = tmp_store();
        std::fs::write(&path, b"{ this is not json").unwrap();
        let err = read_store(&path).unwrap_err();
        assert!(err.to_string().contains("not valid JSON"));
    }

    #[test]
    fn parses_a_well_formed_entry() {
        let link = link_from_value(&link_json()).unwrap();
        assert_eq!(link.workspace_slug, "acme");
        assert_eq!(link.team_key, "ENG");
        assert_eq!(link.team_name, "Engineering");
    }

    #[test]
    fn malformed_entry_reads_as_none() {
        assert!(link_from_value(&json!("nope")).is_none());
        assert!(link_from_value(&json!(42)).is_none());
        assert!(link_from_value(&Value::Null).is_none());
        assert!(link_from_value(&json!({ "workspaceSlug": "a", "teamKey": "B" })).is_none());
    }

    #[test]
    fn lookup_prefers_identity_key() {
        let identity = "C:/repo/.git";
        let legacy = r"C:\repo";
        let mut store = Map::new();
        store.insert(identity.to_string(), link_json());
        store.insert(
            legacy.to_string(),
            json!({ "workspaceSlug": "old", "teamKey": "OLD", "teamName": "Old" }),
        );
        let link = lookup(&store, identity, legacy).unwrap();
        assert_eq!(link.workspace_slug, "acme");
    }

    #[test]
    fn lookup_falls_back_to_legacy_path() {
        let identity = "C:/repo/.git";
        let legacy = r"C:\repo";
        let mut store = Map::new();
        store.insert(legacy.to_string(), link_json());
        let link = lookup(&store, identity, legacy).unwrap();
        assert_eq!(link.team_key, "ENG");
    }

    #[test]
    fn lookup_legacy_is_slash_tolerant() {
        let identity = "C:/repo/.git";
        let stored = r"C:\repo";
        let launched = "c:/repo";
        let mut store = Map::new();
        store.insert(stored.to_string(), link_json());
        let link = lookup(&store, identity, launched).unwrap();
        assert_eq!(link.workspace_slug, "acme");
    }

    #[test]
    fn lookup_no_entry_is_none() {
        let mut store = Map::new();
        store.insert("C:/other/.git".to_string(), link_json());
        assert_eq!(lookup(&store, "C:/repo/.git", r"C:\repo"), None);
    }
}
