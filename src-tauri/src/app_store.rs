//! Headless reader for GitDesktop's global settings store.
//!
//! The GUI persists app settings via the Tauri Store plugin
//! (`src/lib/settings/api.ts`, `load("settings.json")` → a top-level `"settings"`
//! object). The MCP server has NO `AppHandle`, so — exactly like [`crate::local_prs`]
//! does for `local-prs.json` — this module reads the SAME file directly, resolving
//! its path with the same `dirs::data_dir()/<identifier>` rule the Tauri path layer
//! uses (see the storage-dir contract in `local_prs.rs`).
//!
//! Only the AI-generation fields the MCP recipe tools need are surfaced. Every
//! consumed field is type-checked (untrusted-JSON discipline); a missing file,
//! missing key, or wrong-typed value yields the empty default for that field —
//! never an error. Reading settings must never fail a recipe tool.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::local_prs::APP_IDENTIFIER;

/// The settings store filename (the GUI's cold-start `coldstart-` alias is a
/// GUI-only concern the server never participates in — always the real name).
const STORE_FILE: &str = "settings.json";

/// The AI-generation-relevant slice of the user's global settings, as the MCP
/// recipe tools need it. Mirrors the frontend `AppSettings` fields
/// (`src/lib/settings/api.ts`): `globalInstructions` and `aiIgnorePatterns`.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct AiGenSettings {
    /// The user's global AI instructions (empty when unset).
    pub(crate) global_instructions: String,
    /// gitignore-style globs excluded from AI context, one per element. The
    /// frontend stores these as a single newline-delimited string and splits it
    /// (trim, drop blanks and `#` comments) at each call site; we split the same
    /// way so the exclude set matches the in-app feature.
    pub(crate) ai_ignore_patterns: Vec<String>,
}

/// Resolve the absolute path of the `settings.json` the frontend store writes.
/// Mirrors `tauri-plugin-store` v2's `BaseDirectory::AppData` resolution
/// (`dirs::data_dir()/<identifier>`) — see [`crate::local_prs::store_path`].
fn store_path() -> Option<PathBuf> {
    let data = dirs::data_dir()?;
    Some(data.join(APP_IDENTIFIER).join(STORE_FILE))
}

/// Read the `"settings"` object from the store file, or `None` when the file is
/// absent, unreadable, not valid JSON, or has no object `"settings"` key. Never
/// errors — the recipe tools degrade to empty defaults rather than failing.
fn read_settings_object(path: &Path) -> Option<Value> {
    let bytes = std::fs::read(path).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    // Top-level shape is `{ "settings": { … } }` (the plugin's keyed store).
    value.get("settings").cloned().filter(Value::is_object)
}

/// Parse the newline-delimited `aiIgnorePatterns` string into a pattern list,
/// mirroring the frontend's `ignoreLines` at every generation call site: split on
/// newlines, trim via [`crate::fsops::trim_ignore_pattern`], drop blank lines and
/// `#` comments.
///
/// The trim must be that one, not `str::trim`: a plain trim eats the backslash
/// escape in `/notes\ `, and the pattern then matches nothing — handing a file the
/// user excluded straight to the provider.
fn parse_ignore_patterns(raw: &str) -> Vec<String> {
    raw.lines()
        .map(crate::fsops::trim_ignore_pattern)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect()
}

/// Extract the AI-generation fields from an already-read `"settings"` object.
/// Type-checks each consumed field independently: a wrong-typed field defaults on
/// its own without poisoning the others (untrusted-JSON discipline). This is the
/// single source of truth for the parse — production calls it after reading the
/// file, tests call it (via `read_from`) directly, so the two never drift.
fn parse_ai_generation_settings(settings: &Value) -> AiGenSettings {
    let global_instructions = settings
        .get("globalInstructions")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let ai_ignore_patterns = settings
        .get("aiIgnorePatterns")
        .and_then(Value::as_str)
        .map(parse_ignore_patterns)
        .unwrap_or_default();
    AiGenSettings {
        global_instructions,
        ai_ignore_patterns,
    }
}

/// Read the AI-generation settings the recipe tools need. A missing file, missing
/// keys, or wrong-typed values all fall back to empty per-field defaults — this
/// never returns an error (settings are optional context, not a hard dependency).
pub(crate) fn read_ai_generation_settings() -> AiGenSettings {
    let Some(settings) = store_path().and_then(|p| read_settings_object(&p)) else {
        return AiGenSettings::default();
    };
    parse_ai_generation_settings(&settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // These tests drive the pure parse/read logic against a temp file, bypassing
    // `store_path()` so they never touch the real app-data store.

    fn tmp_store() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix("gd-settings-test-")
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().join("store.json");
        (dir, path)
    }

    /// The shared read+extract the public fn wraps (minus the fixed path), so a
    /// test can point it at a temp file. Calls the SAME `parse_ai_generation_settings`
    /// production does, so a change to the parse is exercised by these tests.
    fn read_from(path: &Path) -> AiGenSettings {
        let Some(settings) = read_settings_object(path) else {
            return AiGenSettings::default();
        };
        parse_ai_generation_settings(&settings)
    }

    #[test]
    fn missing_file_yields_defaults() {
        let (_tmp, path) = tmp_store();
        assert_eq!(read_from(&path), AiGenSettings::default());
    }

    #[test]
    fn malformed_json_yields_defaults_not_an_error() {
        let (_tmp, path) = tmp_store();
        std::fs::write(&path, b"{ not json").unwrap();
        assert_eq!(read_from(&path), AiGenSettings::default());
    }

    #[test]
    fn missing_settings_key_yields_defaults() {
        let (_tmp, path) = tmp_store();
        std::fs::write(&path, json!({ "other": 1 }).to_string()).unwrap();
        assert_eq!(read_from(&path), AiGenSettings::default());
    }

    #[test]
    fn well_formed_settings_are_parsed() {
        let (_tmp, path) = tmp_store();
        std::fs::write(
            &path,
            json!({
                "settings": {
                    "globalInstructions": "Be terse.",
                    "aiIgnorePatterns": "*.lock\n# a comment\n\n  dist/  \n/notes\\ \n",
                    "unrelated": true,
                }
            })
            .to_string(),
        )
        .unwrap();
        let got = read_from(&path);
        assert_eq!(got.global_instructions, "Be terse.");
        // Trimmed; blanks and `#` comments dropped; the rest kept in order. The
        // last line pins the mirror of `fsops::trim_ignore_pattern`: a plain trim
        // would eat the escape and stop the pattern matching anything at all.
        assert_eq!(
            got.ai_ignore_patterns,
            vec!["*.lock", "dist/", "/notes\\ "]
        );
    }

    #[test]
    fn wrong_typed_fields_default_per_field() {
        let (_tmp, path) = tmp_store();
        std::fs::write(
            &path,
            json!({
                "settings": {
                    // Both wrong types: a number, and an array instead of a string.
                    "globalInstructions": 42,
                    "aiIgnorePatterns": ["*.lock"],
                }
            })
            .to_string(),
        )
        .unwrap();
        // Each wrong-typed field falls back to its own empty default.
        assert_eq!(read_from(&path), AiGenSettings::default());
    }

    #[test]
    fn one_wrong_field_does_not_poison_the_other() {
        let (_tmp, path) = tmp_store();
        std::fs::write(
            &path,
            json!({
                "settings": {
                    "globalInstructions": "Kept.",
                    "aiIgnorePatterns": 7, // wrong type → empty
                }
            })
            .to_string(),
        )
        .unwrap();
        let got = read_from(&path);
        assert_eq!(got.global_instructions, "Kept.");
        assert!(got.ai_ignore_patterns.is_empty());
    }
}
