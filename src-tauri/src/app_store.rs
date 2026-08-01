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

/// Pure resolution of the store's directory, in precedence order. Under `cfg(test)`
/// an arm 0 precedes all of these: [`store_path`] consults [`TEST_STORE_DIR`] before
/// calling here, and that slot is the ONLY seam a test may use.
/// 1. under `cfg!(test)`, NO store, whatever the environment says — an in-crate test
///    can never read the developer's real settings, and a `GD_SETTINGS_DIR` exported
///    in a dev or CI shell must not silently decide one either;
/// 2. a non-empty `GD_SETTINGS_DIR` override — the operator/headless escape hatch for
///    pointing a run at a store outside the app-data dir (an oplog-sibling knob);
/// 3. otherwise the real app-data dir, `tauri-plugin-store` v2's
///    `BaseDirectory::AppData` resolution (see [`crate::local_prs::store_path`]).
///
/// Arm 3 mirrors [`crate::oplog::resolve_store_base`]; the test arm deliberately
/// diverges twice — it yields no store where the oplog needs a writable temp one
/// (this module only READS), and it outranks the env var where the oplog's does not.
fn resolve_store_dir(gd_settings_dir: Option<&str>, is_test: bool) -> Option<PathBuf> {
    match gd_settings_dir {
        _ if is_test => None,
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => Some(dirs::data_dir()?.join(APP_IDENTIFIER)),
    }
}

/// In-process test override — arm 0, consulted by [`store_path`] before
/// [`resolve_store_dir`] runs at all, and the only way a test can reach a store. It is
/// set in-process rather than through `GD_SETTINGS_DIR` because mutating process env
/// would race every other test's env reads in the same binary, which on POSIX is
/// unsound, not merely flaky (the oplog seam refuses env mutation for the same reason).
#[cfg(test)]
static TEST_STORE_DIR: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

/// Installs (or clears) the in-process override, returning the previous value so a
/// caller can restore it. Test-only — [`TEST_STORE_DIR`] does not exist otherwise.
#[cfg(test)]
pub(crate) fn swap_test_store_dir(dir: Option<PathBuf>) -> Option<PathBuf> {
    let mut slot = TEST_STORE_DIR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    std::mem::replace(&mut *slot, dir)
}

/// The in-process override currently installed, if any. Test-only.
#[cfg(test)]
pub(crate) fn test_store_dir() -> Option<PathBuf> {
    TEST_STORE_DIR
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

/// Absolute path of the `settings.json` the frontend store writes —
/// `<store dir>/settings.json`. The in-process test override wins when one is
/// installed; otherwise [`resolve_store_dir`] chooses the dir.
fn store_path() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = test_store_dir() {
        return Some(dir.join(STORE_FILE));
    }
    let dir = resolve_store_dir(std::env::var("GD_SETTINGS_DIR").ok().as_deref(), cfg!(test))?;
    Some(dir.join(STORE_FILE))
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

    /// The three resolution arms. Arm 3 pins the production output as stable —
    /// `dirs::data_dir()/<identifier>/settings.json` — so the seam can't quietly move
    /// it; agreement with the Tauri path layer's own resolution is a contract this
    /// can't check (no Tauri code runs here). Arm 1 is why no test in this crate can
    /// be decided by the developer's real store OR by their exported environment.
    #[test]
    fn store_dir_resolution_arms() {
        assert_eq!(
            resolve_store_dir(Some("C:/tmp/gd-store"), true),
            None,
            "an exported GD_SETTINGS_DIR must not reach a test build — the in-process \
             slot is the only seam a test may use"
        );
        assert_eq!(
            resolve_store_dir(Some("C:/tmp/gd-store"), false),
            Some(PathBuf::from("C:/tmp/gd-store")),
            "outside tests, an explicit override wins"
        );
        assert_eq!(
            resolve_store_dir(Some(""), false),
            Some(dirs::data_dir().unwrap().join(APP_IDENTIFIER)),
            "an EMPTY override is no override"
        );
        assert_eq!(resolve_store_dir(None, true), None, "no store under cfg(test)");
        assert_eq!(
            resolve_store_dir(None, false),
            Some(dirs::data_dir().unwrap().join(APP_IDENTIFIER)),
            "production: dirs::data_dir()/<identifier>, unchanged by the seam"
        );
        // …and the file the production arm points at is the frontend's own store.
        assert_eq!(
            resolve_store_dir(None, false).unwrap().join(STORE_FILE),
            dirs::data_dir()
                .unwrap()
                .join(APP_IDENTIFIER)
                .join("settings.json")
        );
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
