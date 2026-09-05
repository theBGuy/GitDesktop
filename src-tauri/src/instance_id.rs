//! Runtime instance id for parallel cold-start instances.
//!
//! `scripts/cold-start-instance.ps1` exports `GD_INSTANCE_ID` before launching an
//! extra cold instance against an already-running cold-start Vite server. Cold
//! start itself is a build-time Vite flag, so every instance one server feeds sees
//! the same env — this is the only channel that can tell them apart. `lib.rs` hands
//! the id to the webview as a `window.__GD_INSTANCE_ID__` initialization script
//! rather than a command: the script runs before any page script, so the frontend
//! reads it synchronously at module scope and can name its store files
//! `coldstart-<id>-<name>` before anything opens one. N instances, disjoint state,
//! one dev server.

/// Accepts exactly `^[A-Za-z0-9-]{1,32}$`.
///
/// A security boundary, not cosmetics: the id is interpolated into store
/// FILENAMES (`coldstart-<id>-settings.json`), so path separators, `..`, dots and
/// spaces must never pass — they would let an id escape the app-data dir or
/// collide with an unrelated file. The TS side re-checks the same charset.
fn valid_instance_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The launcher-supplied instance id, or `None` when unset, blank or invalid.
/// Never fails: an unusable id must leave the instance on the shared `coldstart-`
/// namespace rather than break the boot path that reads it.
pub fn read() -> Option<String> {
    let raw = std::env::var("GD_INSTANCE_ID").ok()?;
    let id = raw.trim();
    valid_instance_id(id).then(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use super::valid_instance_id;

    // Only the pure validator is covered. Testing `read` itself would mean
    // mutating `GD_INSTANCE_ID` in-process, which races every other test's env
    // reads in the same binary and on POSIX is unsound, not merely flaky (the
    // same reason `app_store.rs` takes an in-process seam instead of an env var).

    #[test]
    fn accepts_alphanumeric_and_hyphenated_ids() {
        assert!(valid_instance_id("a"));
        assert!(valid_instance_id("b2"));
        assert!(valid_instance_id("cold-start-2"));
        assert!(valid_instance_id(&"x".repeat(32)));
    }

    #[test]
    fn rejects_empty_and_overlong() {
        assert!(!valid_instance_id(""));
        assert!(!valid_instance_id(&"x".repeat(33)));
    }

    #[test]
    fn rejects_path_and_whitespace_characters() {
        assert!(!valid_instance_id(r"..\evil"));
        assert!(!valid_instance_id("a/b"));
        assert!(!valid_instance_id("a b"));
        assert!(!valid_instance_id("a.b"));
    }
}
