//! Managed copy of the app executable used to run the MCP server.
//!
//! The "Use GitDesktop as an MCP server" config points external clients at
//! `gitdesktop mcp …`, which — until now — ran the *installed* binary
//! (`C:\Program Files\gitdesktop\gitdesktop.exe`). That has two Windows-only
//! failure modes:
//!
//! * A live MCP server process **locks the install-dir exe**, so an `.msi`
//!   upgrade fails with "Files in Use".
//! * The passive NSIS auto-updater does `KillProcess "gitdesktop.exe"`, which
//!   matches on the **bare filename** — so it silently kills running MCP
//!   servers.
//!
//! Fix: run MCP from a *managed copy* at
//! `%LOCALAPPDATA%\com.thebguy.gitdesktop\bin\gitdesktop-mcp.exe`. Both
//! properties are load-bearing — the path (outside the install dir) defeats the
//! file lock, and the distinct filename defeats kill-by-name.
//!
//! This is safe because MCP dispatch is `argv[0]`-independent: `main.rs` checks
//! only `argv[1] == "mcp"`, and `McpArgs::from_env()` does `.skip(1)`. The copy
//! therefore behaves exactly like the installed exe when invoked as
//! `gitdesktop-mcp mcp …`.
//!
//! **Management is active** only on Windows *release* builds (or under the
//! `GD_MCP_LAUNCHER_DIR` override, which exists so dev/live validation can
//! exercise the machinery). In debug builds, on macOS/Linux, or when there's no
//! local-data dir, management is INACTIVE and the launcher path is simply
//! `current_exe()` — dev and Unix behavior are unchanged.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Env override for the managed bin directory. Set → that dir is used as the
/// managed bin dir in ALL builds (this is how dev/live validation exercises the
/// copy/refresh machinery without shipping a release build).
const LAUNCHER_DIR_ENV: &str = "GD_MCP_LAUNCHER_DIR";

/// Launcher filename inside the bin dir — a distinct name so the NSIS
/// updater's `KillProcess "gitdesktop.exe"` (bare-filename match) can't reap it.
#[cfg(windows)]
const LAUNCHER_FILE: &str = "gitdesktop-mcp.exe";
#[cfg(not(windows))]
const LAUNCHER_FILE: &str = "gitdesktop-mcp";

/// Staleness marker written beside the launcher after a successful copy.
const MARKER_FILE: &str = "gitdesktop-mcp.version.json";

/// Records the identity of the source exe that produced the current managed
/// copy. Its presence at version N is the proof the copy completed — a crash
/// mid-copy leaves no (or a stale) marker, so the next launch re-copies.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    /// The BUNDLE version (`app.package_info().version`), threaded in from the
    /// command/setup hook. Follows tauri.conf.json → package.json, NOT
    /// Cargo.toml (which can drift from the shipped bundle version).
    version: String,
    /// Byte length of the SOURCE exe at copy time — catches same-version dev
    /// reinstalls the version string alone wouldn't distinguish.
    source_len: u64,
    /// Mtime of the SOURCE exe at copy time, in whole milliseconds since the
    /// Unix epoch. Complements `source_len` for the same reason.
    source_mtime_ms: u64,
}

/// Where the managed launcher lives, and whether we manage it at all.
enum Resolution {
    /// Management is active: the launcher is a managed copy in this bin dir.
    Managed(PathBuf),
    /// Management is inactive: the "launcher" is just `current_exe()`.
    Inactive(PathBuf),
}

/// The managed bin directory, if management is active for this build/env.
///
/// Precedence (mirrors `oplog.rs`'s override → real-path resolver):
/// 1. `GD_MCP_LAUNCHER_DIR` set (non-empty) → that dir (ALL builds).
/// 2. Windows AND release build → `dirs::data_local_dir()/<identifier>/bin`.
///    `data_local_dir()` (Local), NOT `data_dir()` (Roaming) — a ~50MB exe must
///    not roam.
/// 3. Otherwise (debug, non-Windows, or no local-data dir) → `None`: management
///    is inactive.
pub(crate) fn managed_bin_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(LAUNCHER_DIR_ENV) {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    #[cfg(windows)]
    if !cfg!(debug_assertions) {
        return dirs::data_local_dir()
            .map(|d| d.join(crate::local_prs::APP_IDENTIFIER).join("bin"));
    }
    None
}

/// Resolve the launcher location. Pure w.r.t. app state (no `AppHandle`): reads
/// the env override / build config and `current_exe()` only.
fn resolve() -> AppResult<Resolution> {
    match managed_bin_dir() {
        Some(dir) => Ok(Resolution::Managed(dir.join(LAUNCHER_FILE))),
        None => Ok(Resolution::Inactive(current_exe()?)),
    }
}

fn current_exe() -> AppResult<PathBuf> {
    std::env::current_exe().map_err(AppError::Io)
}

/// The resolved launcher path WITHOUT ensuring/creating the managed copy — a
/// read-only view over [`resolve`] for callers (e.g. the global-install status
/// probe) that only need the path to compare against, never to run. Performs
/// zero filesystem writes; when management is inactive this is `current_exe()`.
pub(crate) fn resolved_launcher_path() -> AppResult<PathBuf> {
    match resolve()? {
        Resolution::Managed(dest) => Ok(dest),
        Resolution::Inactive(exe) => Ok(exe),
    }
}

/// Millis since the Unix epoch for a file's mtime (0 for pre-epoch/unknown, so
/// the field is always comparable — a mismatch just forces a re-copy, which is
/// the safe direction).
fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Build the marker describing `source`'s current on-disk identity at `version`.
fn marker_for(source: &Path, version: &str) -> AppResult<Marker> {
    let meta = std::fs::metadata(source).map_err(AppError::Io)?;
    Ok(Marker {
        version: version.to_string(),
        source_len: meta.len(),
        source_mtime_ms: mtime_ms(&meta),
    })
}

/// Read the marker beside `dest`, if present and parseable. A missing or
/// malformed marker reads as `None` (⇒ stale ⇒ re-copy).
fn read_marker(dest: &Path) -> Option<Marker> {
    let path = marker_path(dest);
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn marker_path(dest: &Path) -> PathBuf {
    dest.with_file_name(MARKER_FILE)
}

/// Whether the managed copy at `dest` is stale relative to `want`. Stale ⇔ the
/// dest exe is absent, OR the marker is missing/unparseable, OR any of its three
/// fields differs from `want`.
fn is_stale(dest: &Path, want: &Marker) -> bool {
    if !dest.exists() {
        return true;
    }
    read_marker(dest).as_ref() != Some(want)
}

/// A unique sibling path of `base` with `suffix` (`tmp`/`old`), in the SAME
/// directory so a later rename stays same-volume. Mirrors the `fsops` temp-name
/// idiom (pid + a fresh uuid) so concurrent writers can't collide.
fn unique_sibling(base: &Path, suffix: &str) -> PathBuf {
    let stem = base
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "gitdesktop-mcp".to_string());
    base.with_file_name(format!(
        ".{stem}.{}.{}.{suffix}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

/// Best-effort sweep of `.*.tmp` / `.*.old` strays a prior crash left in `dir`.
/// Mirrors `fsops::sweep_stale_temps`: advisory, all errors ignored.
fn sweep_strays(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with('.') && (name.ends_with(".tmp") || name.ends_with(".old")) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Copy `source` → `dest` and write the freshness marker, using Windows-safe
/// file semantics. `dest`'s parent must be the managed bin dir.
///
/// Each step exists for a concrete Windows reason (see inline notes). The marker
/// is written LAST, after the exe rename succeeds, so its presence is proof the
/// copy completed.
fn copy_into_place(source: &Path, dest: &Path, want: &Marker) -> AppResult<()> {
    let dir = dest
        .parent()
        .ok_or_else(|| AppError::Command(format!("{} has no parent directory", dest.display())))?;
    // 1. Ensure the bin dir exists.
    std::fs::create_dir_all(dir).map_err(AppError::Io)?;
    // 2. Sweep prior-crash strays before adding our own.
    sweep_strays(dir);
    // 3. Stream-copy the source into a unique same-dir temp (fs::copy streams —
    //    never reads the ~50MB exe into memory). Same-dir keeps step 5's rename
    //    same-volume. fs::copy's documented contract also copies the source's
    //    PERMISSION BITS on every platform (Unix impl fchmods the destination),
    //    so under the `GD_MCP_LAUNCHER_DIR` override on Unix the copy inherits
    //    the source exe's +x — no explicit chmod needed.
    let tmp = unique_sibling(dest, "tmp");
    if let Err(e) = std::fs::copy(source, &tmp) {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Io(e));
    }
    // 4. If a dest exe already exists, move it ASIDE first. Two Windows facts
    //    make this mandatory: (a) `fs::rename` FAILS if the target exists (no
    //    POSIX overwrite), and (b) a RUNNING image can be renamed/moved but NOT
    //    deleted or replaced — rename-aside works even while an old MCP server
    //    is still running that copy.
    let mut moved_old: Option<PathBuf> = None;
    if dest.exists() {
        let old = unique_sibling(dest, "old");
        if let Err(e) = std::fs::rename(dest, &old) {
            let _ = std::fs::remove_file(&tmp);
            return Err(AppError::Io(e));
        }
        moved_old = Some(old);
    }
    // 5. Promote the temp into place.
    if let Err(e) = std::fs::rename(&tmp, dest) {
        // Roll back: restore the old exe so a running server keeps a valid path.
        if let Some(old) = &moved_old {
            let _ = std::fs::rename(old, dest);
        }
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Io(e));
    }
    // 6. Write the marker (atomically) — proof the copy completed.
    let body = serde_json::to_vec(want)
        .map_err(|e| AppError::Command(format!("serialize launcher marker: {e}")))?;
    crate::fsops::atomic_write(&marker_path(dest), &body)?;
    // 7. Best-effort remove of the moved-aside old exe. This succeeds once the
    //    old process exits; otherwise step 2 sweeps it on a later run.
    if let Some(old) = moved_old {
        let _ = std::fs::remove_file(old);
    }
    Ok(())
}

/// Ensure the managed launcher exists and is fresh for `version`, returning its
/// absolute path.
///
/// * Management inactive → returns `current_exe()` immediately (no writes).
/// * Active and already fresh → returns the dest path (no writes).
/// * Active and stale/absent → runs the copy recipe, then returns the dest.
///
/// On ANY failure while management is active, returns an actionable error —
/// **never** falls back to the installed exe's path, since a silent fallback
/// would quietly reintroduce the file-lock/kill-by-name bugs this exists to fix.
pub fn ensure(version: &str) -> AppResult<PathBuf> {
    match resolve()? {
        Resolution::Inactive(exe) => Ok(exe),
        Resolution::Managed(dest) => {
            let source = current_exe()?;
            let want = marker_for(&source, version)?;
            if !is_stale(&dest, &want) {
                return Ok(dest);
            }
            ensure_in_dir(&source, &dest, &want).map_err(|e| {
                AppError::Command(format!(
                    "Couldn't prepare the MCP launcher at {}: {e}. If an antivirus \
                     quarantined it, restore/allow it and retry.",
                    dest.display()
                ))
            })?;
            Ok(dest)
        }
    }
}

/// If a managed launcher is already present, re-copy it when stale — otherwise
/// no-op. Lazy (absent ⇒ no-op, so users who never used MCP never get the copy)
/// and best-effort (errors swallowed: a stale copy still serves already-running
/// sessions, and the next launch retries). Never panics, never blocks on I/O
/// beyond the copy itself.
///
/// Only wired up on Windows (the `#[cfg(windows)]` setup hook in `lib.rs` —
/// management is inactive elsewhere), so gate compilation to Windows + tests to
/// keep non-Windows lib builds dead-code-free.
#[cfg(any(windows, test))]
pub fn refresh_if_present(version: &str) {
    let Ok(Resolution::Managed(dest)) = resolve() else {
        return;
    };
    let Ok(source) = current_exe() else {
        return;
    };
    let Ok(want) = marker_for(&source, version) else {
        return;
    };
    refresh_dest_if_stale(&source, &dest, &want);
}

/// The env-free core of [`refresh_if_present`], parameterized on
/// `source`/`dest`/`want` so tests drive it against a temp dir without touching
/// process-global env. No-ops when `dest` is absent (lazy: never used ⇒ nothing
/// to refresh), re-copies when stale, and swallows copy errors best-effort (a
/// stale copy still serves already-running sessions; the next launch retries).
#[cfg(any(windows, test))]
fn refresh_dest_if_stale(source: &Path, dest: &Path, want: &Marker) {
    if !dest.exists() {
        return; // lazy: never used ⇒ nothing to refresh
    }
    if is_stale(dest, want) {
        let _ = ensure_in_dir(source, dest, want);
    }
}

/// The re-copy core, parameterized on `source`/`dest`/`want` so tests drive it
/// against a temp dir without touching process-global env or the real bin dir.
fn ensure_in_dir(source: &Path, dest: &Path, want: &Marker) -> AppResult<()> {
    copy_into_place(source, dest, want)
}

/// Absolute path of the MCP launcher executable, ensuring (create/refresh) the
/// managed copy first when management is active. Runs the (potentially ~50MB)
/// copy in `spawn_blocking` so the main thread never stalls.
#[tauri::command]
pub async fn mcp_launcher_path(app: tauri::AppHandle) -> AppResult<String> {
    let version = app.package_info().version.to_string();
    let path = tauri::async_runtime::spawn_blocking(move || ensure(&version))
        .await
        .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))??;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::Builder::new()
            .prefix(&format!("gd-mcp-launcher-test-{tag}-"))
            .tempdir()
            .expect("create temp dir");
        let path = dir.path().to_path_buf();
        (dir, path)
    }

    #[test]
    fn marker_json_roundtrips() {
        let m = Marker {
            version: "1.2.3".into(),
            source_len: 52_428_800,
            source_mtime_ms: 1_700_000_000_123,
        };
        let bytes = serde_json::to_vec(&m).unwrap();
        // camelCase on the wire.
        let s = String::from_utf8(bytes.clone()).unwrap();
        assert!(s.contains("\"sourceLen\""), "expected camelCase: {s}");
        assert!(s.contains("\"sourceMtimeMs\""), "expected camelCase: {s}");
        let back: Marker = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(back, m);
    }

    /// Set up a temp bin dir with a copied launcher + marker and return
    /// (dir, dest, source, base_marker).
    fn seeded() -> (tempfile::TempDir, PathBuf, PathBuf, Marker) {
        let (guard, dir) = scratch_dir("seed");
        let dest = dir.join(LAUNCHER_FILE);
        // Copy the test binary itself as the "source" exe — a real file.
        let source = current_exe().unwrap();
        let want = marker_for(&source, "9.9.9").unwrap();
        ensure_in_dir(&source, &dest, &want).unwrap();
        (guard, dest, source, want)
    }

    #[test]
    fn stale_when_marker_missing() {
        let (_dir, dir) = scratch_dir("nomarker");
        let dest = dir.join(LAUNCHER_FILE);
        // exe present but no marker file at all.
        std::fs::write(&dest, b"exe").unwrap();
        let want = marker_for(&current_exe().unwrap(), "1.0.0").unwrap();
        assert!(is_stale(&dest, &want));
    }

    #[test]
    fn fresh_when_all_fields_match() {
        let (_dir, dest, _source, want) = seeded();
        assert!(!is_stale(&dest, &want), "just-copied should be fresh");
    }

    #[test]
    fn stale_when_version_differs() {
        let (_dir, dest, _source, want) = seeded();
        let other = Marker {
            version: "0.0.1".into(),
            ..want
        };
        assert!(is_stale(&dest, &other));
    }

    #[test]
    fn stale_when_source_len_differs() {
        let (_dir, dest, _source, want) = seeded();
        let other = Marker {
            source_len: want.source_len + 1,
            ..want.clone()
        };
        assert!(is_stale(&dest, &other));
    }

    #[test]
    fn stale_when_source_mtime_differs() {
        let (_dir, dest, _source, want) = seeded();
        let other = Marker {
            source_mtime_ms: want.source_mtime_ms.wrapping_add(1),
            ..want.clone()
        };
        assert!(is_stale(&dest, &other));
    }

    #[test]
    fn ensure_in_dir_creates_exe_and_marker() {
        let (_dir, dir) = scratch_dir("create");
        let dest = dir.join(LAUNCHER_FILE);
        let source = current_exe().unwrap();
        let want = marker_for(&source, "3.1.4").unwrap();

        assert!(!dest.exists());
        ensure_in_dir(&source, &dest, &want).unwrap();
        assert!(dest.exists(), "launcher exe materialized");
        assert!(marker_path(&dest).exists(), "marker written");
        assert_eq!(read_marker(&dest).as_ref(), Some(&want));
        // The copy is byte-identical to the source.
        assert_eq!(
            std::fs::metadata(&dest).unwrap().len(),
            std::fs::metadata(&source).unwrap().len()
        );

        // Second call with the same marker is a no-op: nothing is stale, so the
        // recipe isn't re-run. (Guarded via is_stale, mirroring `ensure`.)
        assert!(!is_stale(&dest, &want));
        // Re-running the recipe anyway still succeeds and leaves a valid copy.
        ensure_in_dir(&source, &dest, &want).unwrap();
        assert!(dest.exists());
        assert_eq!(read_marker(&dest).as_ref(), Some(&want));
    }

    #[test]
    fn refresh_dest_if_stale_noops_when_dest_absent() {
        // Lazy: a never-copied launcher must not be materialized by a refresh.
        // Drive the real production core against a temp dir and assert NO
        // filesystem writes appear (neither the exe nor the marker).
        let (_dir, dir) = scratch_dir("refresh-absent");
        let dest = dir.join(LAUNCHER_FILE);
        let source = current_exe().unwrap();
        let want = marker_for(&source, "1.0.0").unwrap();

        assert!(!dest.exists());
        refresh_dest_if_stale(&source, &dest, &want);
        assert!(!dest.exists(), "absent dest ⇒ no exe written");
        assert!(
            !marker_path(&dest).exists(),
            "absent dest ⇒ no marker written"
        );
    }

    #[test]
    fn refresh_dest_if_stale_recopies_when_stale() {
        // Seed a copy, then hand a DIFFERENT want marker (a bumped version) so
        // the present-but-stale branch fires. The refresh must re-copy and the
        // on-disk marker must now match the new want.
        let (_dir, dest, source, base) = seeded();
        assert!(dest.exists());
        let bumped = Marker {
            version: "10.0.0".into(),
            ..base.clone()
        };
        assert!(is_stale(&dest, &bumped), "bumped version is stale");

        refresh_dest_if_stale(&source, &dest, &bumped);
        assert!(dest.exists(), "re-copied launcher still present");
        assert_eq!(
            read_marker(&dest).as_ref(),
            Some(&bumped),
            "marker updated to the new want"
        );
        assert!(!is_stale(&dest, &bumped), "no longer stale after refresh");
    }
}
