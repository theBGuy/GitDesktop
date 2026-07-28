//! One-click "add `gitdesktop-mcp` to your PATH" launcher.
//!
//! The MCP client config points at the bare command `gitdesktop-mcp mcp …`,
//! which only resolves if the launcher is on the shell's `PATH` — otherwise the
//! user must hardcode an absolute path or set `GITDESKTOP_BIN`.
//!
//! * **Windows** — append the managed launcher's bin dir to the *user* `PATH`
//!   (`HKCU\Environment`, no admin) and broadcast `WM_SETTINGCHANGE` so new
//!   terminals pick it up without a logout.
//! * **macOS / Linux** — symlink `gitdesktop-mcp` → the app binary into
//!   `~/.local/bin`.
//!
//! Both migrate away the legacy pre-rename install — on Windows the install-dir
//! PATH entry (in the same write), on Unix a `gitdesktop` symlink we own. Every
//! install is reversible via [`path_launcher_remove`], and we only ever remove
//! what we created.

use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::PathBuf;

/// State of the `gitdesktop-mcp` command-line launcher, surfaced in Settings →
/// "Use GitDesktop as an MCP server".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathLauncherStatus {
    /// `gitdesktop-mcp` resolves in a newly-opened terminal (from the *persisted*
    /// PATH — the registry on Windows / `$PATH` on Unix — not this process's
    /// possibly-stale environment).
    pub on_path: bool,
    /// GitDesktop installed the launcher itself, so **Remove** can undo it.
    /// `false` when `gitdesktop` is on PATH by other means (a manual edit, or a
    /// dev build already on PATH) — there is nothing of ours to remove.
    pub managed: bool,
    /// Human-readable install location for the UI (the PATH directory on
    /// Windows, the symlink path on Unix). Empty when it can't be determined.
    pub target: String,
    /// A non-blocking caveat to surface persistently (e.g. on Unix the bin dir
    /// isn't on `$PATH`). `None` in the clean case.
    pub warning: Option<String>,
    /// A one-shot success note from install/remove, worded per-platform (e.g.
    /// the Windows "open a new terminal" caveat). `None` for a plain status
    /// query — the frontend shows it as a toast and does not persist it.
    pub note: Option<String>,
}

/// Absolute path to this app's executable.
fn exe_path() -> AppResult<PathBuf> {
    std::env::current_exe().map_err(AppError::Io)
}

#[tauri::command]
pub fn path_launcher_status() -> AppResult<PathLauncherStatus> {
    status_impl()
}

#[tauri::command]
pub fn path_launcher_install(app: tauri::AppHandle) -> AppResult<PathLauncherStatus> {
    let _version = app.package_info().version.to_string();
    #[cfg(windows)]
    {
        install_impl(&_version)
    }
    #[cfg(not(windows))]
    {
        install_impl()
    }
}

#[tauri::command]
pub fn path_launcher_remove() -> AppResult<PathLauncherStatus> {
    remove_impl()
}

// ── Windows ─────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod platform {
    use super::*;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_EXPAND_SZ};
    use winreg::types::FromRegValue;
    use winreg::{RegKey, RegValue};

    /// The directory we put on PATH: the managed MCP launcher's bin dir when
    /// active (it holds only `gitdesktop-mcp.exe` + its marker, so the resolvable
    /// command is `gitdesktop-mcp`), else the app's install dir (dev builds).
    fn launcher_dir() -> AppResult<String> {
        if let Some(dir) = crate::mcp_launcher::managed_bin_dir() {
            return Ok(dir.to_string_lossy().into_owned());
        }
        install_dir()
    }

    /// The app's own install directory (`current_exe()`'s parent). This is the
    /// OLD launcher dir a pre-migration install would have added to PATH; we
    /// treat it as removable-by-us and detect it for migration.
    fn install_dir() -> AppResult<String> {
        let exe = exe_path()?;
        exe.parent()
            .map(|p| p.to_string_lossy().into_owned())
            .ok_or_else(|| AppError::Command("could not determine the app's directory".into()))
    }

    /// The old install-dir PATH entry to migrate away from — `Some` only when
    /// management is active AND the install dir differs from the managed dir
    /// (i.e. there is a genuinely distinct legacy entry to reconcile).
    fn old_entry(new_dir: &str) -> Option<String> {
        let old = install_dir().ok()?;
        (norm(&old) != norm(new_dir)).then_some(old)
    }

    /// Normalize a PATH entry for case-insensitive comparison (Windows paths are
    /// case-insensitive; a trailing separator is not significant).
    pub(super) fn norm(p: &str) -> String {
        p.trim().trim_end_matches(['\\', '/']).to_ascii_lowercase()
    }

    /// Whether `dir` is already present among the `;`-separated `current` PATH.
    pub(super) fn path_contains(current: &str, dir: &str) -> bool {
        let target = norm(dir);
        current
            .split(';')
            .any(|e| !e.trim().is_empty() && norm(e) == target)
    }

    /// `current` PATH with `dir` appended, or `None` if it is already present.
    /// Avoids a leading separator on an empty value and a doubled separator when
    /// `current` already ends with one.
    pub(super) fn path_with_dir_added(current: &str, dir: &str) -> Option<String> {
        if path_contains(current, dir) {
            return None;
        }
        let trimmed = current.trim_end_matches(';');
        Some(if trimmed.trim().is_empty() {
            dir.to_string()
        } else {
            format!("{trimmed};{dir}")
        })
    }

    /// `current` PATH with every entry equal to `dir` removed. All other segments —
    /// including a pre-existing empty one — are kept verbatim, so install+remove
    /// round-trips the user's PATH byte-for-byte.
    pub(super) fn path_with_dir_removed(current: &str, dir: &str) -> String {
        let target = norm(dir);
        current
            .split(';')
            .filter(|e| norm(e) != target)
            .collect::<Vec<_>>()
            .join(";")
    }

    /// Open the current user's `Environment` registry key with the given access
    /// (`KEY_READ`, or `KEY_READ | KEY_WRITE` to also mutate).
    fn open_user_env(access: u32) -> AppResult<RegKey> {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Environment", access)
            .map_err(AppError::Io)
    }

    /// Read the PATH raw value from an opened Environment key, with its registry
    /// type so a write can preserve `REG_EXPAND_SZ` (keeping `%VAR%` entries
    /// expandable). A missing value reads as empty + `REG_EXPAND_SZ`. Takes the key
    /// as a param so tests can round-trip a scratch key.
    pub(super) fn read_path_value(env: &RegKey) -> AppResult<(String, winreg::enums::RegType)> {
        match env.get_raw_value("Path") {
            Ok(raw) => {
                let s = String::from_reg_value(&raw).map_err(|e| {
                    AppError::Command(format!("reading PATH from the registry: {e}"))
                })?;
                Ok((s, raw.vtype))
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok((String::new(), REG_EXPAND_SZ))
            }
            Err(e) => Err(AppError::Io(e)),
        }
    }

    /// Write the PATH value back to an opened Environment key, preserving the
    /// original value type. Encodes to NUL-terminated UTF-16LE (the on-disk form
    /// for `REG_SZ`/`REG_EXPAND_SZ`).
    pub(super) fn write_path_value(
        env: &RegKey,
        value: &str,
        vtype: winreg::enums::RegType,
    ) -> AppResult<()> {
        let bytes: Vec<u8> = value
            .encode_utf16()
            .chain(std::iter::once(0))
            .flat_map(|u| u.to_le_bytes())
            .collect();
        env.set_raw_value("Path", &RegValue { bytes, vtype })
            .map_err(AppError::Io)
    }

    /// Whether the launcher dir appears in the *persisted* (registry) user+system
    /// PATH — i.e. whether a new terminal would resolve our launcher command
    /// (`gitdesktop-mcp` from the managed bin dir; bare `gitdesktop` when
    /// management is inactive and this is the install dir).
    fn persisted_path_contains_exe_dir(dir: &str) -> bool {
        let target = norm(dir);
        crate::agent::registry_path_dirs()
            .iter()
            .any(|p| norm(&p.to_string_lossy()) == target)
    }

    /// Tell Explorer (and terminals launched afterward) that the environment
    /// changed, so the edited PATH applies without a logout.
    ///
    /// Runs on a **detached thread**, deliberately: these commands run on Tauri's
    /// main (UI) thread, and `SendMessageTimeoutW` to `HWND_BROADCAST` blocks
    /// until every top-level window acknowledges — including our own, whose UI
    /// thread is the caller. Inline, that froze the app for the full timeout.
    /// Best-effort.
    fn broadcast_env_change() {
        std::thread::spawn(|| {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
            };
            let param: Vec<u16> = "Environment"
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut result: usize = 0;
            // SAFETY: a standard, documented environment-change broadcast.
            // `param` is a valid NUL-terminated wide string owned by this
            // closure that outlives the (timed-out) call; `result` is a valid
            // out-pointer. HWND_BROADCAST + a 5s abort-if-hung timeout means a
            // wedged window can't block this thread forever.
            unsafe {
                SendMessageTimeoutW(
                    HWND_BROADCAST,
                    WM_SETTINGCHANGE,
                    0,
                    param.as_ptr() as isize,
                    SMTO_ABORTIFHUNG,
                    5000,
                    &mut result,
                );
            }
        });
    }

    pub(super) fn status_impl() -> AppResult<PathLauncherStatus> {
        let dir = launcher_dir()?;
        let (user_path, _) = read_path_value(&open_user_env(KEY_READ)?)?;
        // A leftover pre-migration entry points at the install folder (locks the
        // .msi, killed by name) — nudge the user to re-run Add to PATH, which
        // migrates it.
        let warning = old_entry(&dir)
            .filter(|old| path_contains(&user_path, old))
            .map(|_| {
                "An earlier Add to PATH entry still points at the app's install folder. \
                 Add to PATH again to migrate it. Shared configs using the bare \
                 `gitdesktop` command need updating to `gitdesktop-mcp`."
                    .to_string()
            });
        Ok(PathLauncherStatus {
            on_path: persisted_path_contains_exe_dir(&dir),
            managed: path_contains(&user_path, &dir),
            target: dir,
            warning,
            note: None,
        })
    }

    pub(super) fn install_impl(version: &str) -> AppResult<PathLauncherStatus> {
        let dir = launcher_dir()?;
        // Materialize the managed launcher copy FIRST — putting an empty dir on
        // PATH is useless. On dev builds (management inactive) this is a no-op
        // returning the install-dir exe. Ensure errors propagate.
        crate::mcp_launcher::ensure(version)?;
        let env = open_user_env(KEY_READ | KEY_WRITE)?;
        let (current, vtype) = read_path_value(&env)?;
        // Add the new dir and, in the SAME write, migrate away the old install-
        // dir entry if it's present.
        let mut next = current.clone();
        let mut changed = false;
        if let Some(added) = path_with_dir_added(&next, &dir) {
            next = added;
            changed = true;
        }
        if let Some(old) = old_entry(&dir) {
            if path_contains(&next, &old) {
                next = path_with_dir_removed(&next, &old);
                changed = true;
            }
        }
        if changed {
            write_path_value(&env, &next, vtype)?;
            broadcast_env_change();
        }
        Ok(PathLauncherStatus {
            on_path: true,
            managed: true,
            target: dir,
            warning: None,
            note: Some("Added to your PATH — open a new terminal to use gitdesktop-mcp.".into()),
        })
    }

    pub(super) fn remove_impl() -> AppResult<PathLauncherStatus> {
        let dir = launcher_dir()?;
        let env = open_user_env(KEY_READ | KEY_WRITE)?;
        let (current, vtype) = read_path_value(&env)?;
        // Remove BOTH the new dir and any leftover old install-dir entry — both
        // are entries GitDesktop added, so both are ours to reverse.
        let mut next = current.clone();
        let mut changed = false;
        if path_contains(&next, &dir) {
            next = path_with_dir_removed(&next, &dir);
            changed = true;
        }
        if let Some(old) = old_entry(&dir) {
            if path_contains(&next, &old) {
                next = path_with_dir_removed(&next, &old);
                changed = true;
            }
        }
        if changed {
            write_path_value(&env, &next, vtype)?;
            broadcast_env_change();
        }
        // Recompute from the registry — the dir might still be on the *system*
        // PATH, in which case `gitdesktop` stays resolvable (just not ours).
        let mut status = status_impl()?;
        status.note = Some("Removed gitdesktop from your PATH.".into());
        Ok(status)
    }
}

// ── macOS / Linux ───────────────────────────────────────────────────────────

#[cfg(unix)]
mod platform {
    use super::*;
    use std::path::Path;

    /// Preferred user bin directory — on `$PATH` in virtually all modern shells.
    fn user_bin_dir() -> AppResult<PathBuf> {
        let home =
            std::env::var_os("HOME").ok_or_else(|| AppError::Command("HOME is not set".into()))?;
        Ok(PathBuf::from(home).join(".local").join("bin"))
    }

    /// The canonical launcher symlink, named `gitdesktop-mcp` to match the
    /// shareable config's `${GITDESKTOP_BIN:-gitdesktop-mcp}`
    /// (`GitDesktopAsServer.tsx`), so a config committed to a team repo resolves
    /// for a teammate. It targets the app binary directly — MCP dispatch is
    /// argv[0]-independent.
    fn link_path() -> AppResult<PathBuf> {
        Ok(user_bin_dir()?.join("gitdesktop-mcp"))
    }

    /// The legacy pre-rename symlink (`gitdesktop`). Migrated away — but only when
    /// it's ours (targets *this* exe) — so it can't shadow the `gitdesktop-mcp`
    /// fallback a shared config relies on.
    fn legacy_link_path() -> AppResult<PathBuf> {
        Ok(user_bin_dir()?.join("gitdesktop"))
    }

    /// Whether `dir` is on this process's `$PATH`.
    fn dir_on_path(dir: &Path) -> bool {
        let Some(path) = std::env::var_os("PATH") else {
            return false;
        };
        std::env::split_paths(&path).any(|p| p == dir)
    }

    /// Whether some `gitdesktop-mcp` is resolvable on `$PATH` (a file or a
    /// symlink).
    fn gitdesktop_on_path() -> bool {
        let Some(path) = std::env::var_os("PATH") else {
            return false;
        };
        std::env::split_paths(&path).any(|dir| {
            let cand = dir.join("gitdesktop-mcp");
            std::fs::symlink_metadata(&cand)
                .map(|m| m.file_type().is_symlink() || m.file_type().is_file())
                .unwrap_or(false)
        })
    }

    /// Whether `link` is a symlink pointing at *this* binary (our ownership
    /// test, shared by status/install/remove for both the canonical and legacy
    /// links).
    fn owned_by_us(link: &Path, exe: &Path) -> bool {
        std::fs::symlink_metadata(link)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
            && std::fs::read_link(link).map(|t| t == exe).unwrap_or(false)
    }

    pub(super) fn status_impl() -> AppResult<PathLauncherStatus> {
        let exe = exe_path()?;
        let bin = user_bin_dir()?;
        let link = link_path()?;
        let is_managed = owned_by_us(&link, &exe);
        // A legacy link we own means an earlier install used the old name — nudge
        // the user to re-run Add to PATH, which migrates it.
        let legacy_present = owned_by_us(&legacy_link_path()?, &exe);
        let warning = if legacy_present {
            Some(
                "An earlier Add to PATH link still uses the old `gitdesktop` name. \
                 Add to PATH again to migrate it."
                    .to_string(),
            )
        } else if is_managed && !dir_on_path(&bin) {
            Some(format!(
                "{} may not be on your PATH — add it to your shell profile, or use the Shareable entry's GITDESKTOP_BIN.",
                bin.display()
            ))
        } else {
            None
        };
        Ok(PathLauncherStatus {
            on_path: gitdesktop_on_path(),
            managed: is_managed,
            target: link.to_string_lossy().into_owned(),
            warning,
            note: None,
        })
    }

    pub(super) fn install_impl() -> AppResult<PathLauncherStatus> {
        use std::os::unix::fs::symlink;
        let exe = exe_path()?;
        let bin = user_bin_dir()?;
        let link = link_path()?;
        std::fs::create_dir_all(&bin).map_err(AppError::Io)?;
        // Clear the path for our symlink, but only when it's safe — symmetric with
        // remove_impl's ownership guard: repoint our own link (same target) or a
        // dangling one (e.g. ours after the app moved), but never clobber a live
        // symlink to a DIFFERENT binary, and never a real file the user put here.
        match std::fs::symlink_metadata(&link) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let target = std::fs::read_link(&link).unwrap_or_default();
                if target != exe && target.exists() {
                    return Err(AppError::Command(format!(
                        "{} is symlinked to a different binary — remove it manually first.",
                        link.display()
                    )));
                }
                std::fs::remove_file(&link).map_err(AppError::Io)?;
            }
            Ok(_) => {
                return Err(AppError::Command(format!(
                    "{} already exists and isn't a symlink — remove it manually first.",
                    link.display()
                )));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::Io(e)),
        }
        symlink(&exe, &link).map_err(AppError::Io)?;
        // Migrate away the legacy `gitdesktop` link when it's ours (ownership-
        // checked) — mirrors the Windows old-entry migration in the same action.
        let legacy = legacy_link_path()?;
        if owned_by_us(&legacy, &exe) {
            let _ = std::fs::remove_file(&legacy);
        }
        let mut status = status_impl()?;
        status.note = Some(if dir_on_path(&bin) {
            format!("Linked gitdesktop-mcp into {}.", bin.display())
        } else {
            format!(
                "Linked gitdesktop-mcp into {} — add that folder to your PATH to use it.",
                bin.display()
            )
        });
        Ok(status)
    }

    pub(super) fn remove_impl() -> AppResult<PathLauncherStatus> {
        let exe = exe_path()?;
        let link = link_path()?;
        match std::fs::symlink_metadata(&link) {
            // Only remove OUR launcher — a symlink pointing at *this* binary
            // (the same ownership test `owned_by_us()`/status use). Never delete a
            // gitdesktop-mcp symlink the user aimed at a different install, and
            // never a real file they placed here.
            Ok(meta) if meta.file_type().is_symlink() => {
                if std::fs::read_link(&link).map(|t| t == exe).unwrap_or(false) {
                    std::fs::remove_file(&link).map_err(AppError::Io)?;
                } else {
                    return Err(AppError::Command(format!(
                        "{} points to a different binary — leaving it alone.",
                        link.display()
                    )));
                }
            }
            Ok(_) => {
                return Err(AppError::Command(format!(
                    "{} isn't a symlink GitDesktop created — leaving it alone.",
                    link.display()
                )));
            }
            _ => {} // already gone
        }
        // Also remove the legacy link when it's ours; one owned by a different
        // install is left untouched.
        let legacy = legacy_link_path()?;
        if owned_by_us(&legacy, &exe) {
            let _ = std::fs::remove_file(&legacy);
        }
        let mut status = status_impl()?;
        status.note = Some("Removed the gitdesktop-mcp launcher.".into());
        Ok(status)
    }
}

// Fallback for exotic targets (none of the desktop builds hit this).
#[cfg(not(any(windows, unix)))]
mod platform {
    use super::*;
    fn unsupported() -> AppError {
        AppError::Command("adding gitdesktop to PATH isn't supported on this platform".into())
    }
    pub(super) fn status_impl() -> AppResult<PathLauncherStatus> {
        Err(unsupported())
    }
    pub(super) fn install_impl() -> AppResult<PathLauncherStatus> {
        Err(unsupported())
    }
    pub(super) fn remove_impl() -> AppResult<PathLauncherStatus> {
        Err(unsupported())
    }
}

use platform::{install_impl, remove_impl, status_impl};

#[cfg(all(test, windows))]
mod windows_path_tests {
    use super::platform::{norm, path_contains, path_with_dir_added, path_with_dir_removed};

    const DIR: &str = r"C:\Users\me\AppData\Local\GitDesktop";

    #[test]
    fn norm_is_case_and_trailing_slash_insensitive() {
        assert_eq!(norm(r"C:\Foo\Bar\"), norm(r"c:\foo\bar"));
        assert_eq!(norm("  C:\\Foo/  "), r"c:\foo");
    }

    #[test]
    fn add_appends_without_leading_or_doubled_separator() {
        // Empty PATH -> just the dir, no leading ';'.
        assert_eq!(path_with_dir_added("", DIR).as_deref(), Some(DIR));
        // Trailing ';' isn't doubled.
        assert_eq!(
            path_with_dir_added(r"C:\Windows;", DIR).as_deref(),
            Some(&*format!(r"C:\Windows;{DIR}"))
        );
        assert_eq!(
            path_with_dir_added(r"C:\Windows", DIR).as_deref(),
            Some(&*format!(r"C:\Windows;{DIR}"))
        );
    }

    #[test]
    fn add_is_idempotent_case_insensitively() {
        let current = format!(r"C:\Windows;{}", DIR.to_lowercase());
        assert!(path_with_dir_added(&current, DIR).is_none());
        assert!(path_contains(&current, DIR));
    }

    #[test]
    fn remove_drops_only_the_dir_preserving_other_segments() {
        // Our dir goes; a pre-existing empty segment (the `;;`) stays put, so an
        // install+remove round-trips a real PATH byte-for-byte.
        let current = format!(r"C:\Windows;{DIR};;C:\Tools");
        assert_eq!(
            path_with_dir_removed(&current, DIR),
            r"C:\Windows;;C:\Tools"
        );
        // Removing an absent dir is a no-op.
        assert_eq!(path_with_dir_removed(r"C:\Windows", DIR), r"C:\Windows");
        // Removing our dir never introduces a `;;` of its own.
        assert_eq!(path_with_dir_removed(&format!(r"A;{DIR};B"), DIR), "A;B");
    }
}

#[cfg(all(test, windows))]
mod windows_registry_tests {
    use super::platform::{path_with_dir_added, read_path_value, write_path_value};
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_EXPAND_SZ, REG_SZ};
    use winreg::RegKey;

    /// Round-trips the *real* registry read/write helpers against a throwaway key
    /// under `HKCU\Software`, validating the UTF-16LE encoding and — critically —
    /// that a write preserves `REG_EXPAND_SZ` so a user's `%VAR%` PATH entries
    /// keep working. Never touches the live `HKCU\Environment`.
    #[test]
    fn registry_roundtrip_preserves_type_and_appends_literally() {
        const SCRATCH: &str = r"Software\GitDesktopTest\PathLauncherRoundtrip";
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(SCRATCH); // clear a stale key from a crashed run
        let (key, _) = hkcu
            .create_subkey_with_flags(SCRATCH, KEY_READ | KEY_WRITE)
            .expect("create scratch key");

        // Seed a REG_EXPAND_SZ Path carrying a %VAR%, like real user PATHs.
        let seeded = r"%SystemRoot%\System32;C:\Tools";
        write_path_value(&key, seeded, REG_EXPAND_SZ).expect("seed write");
        let (val, vtype) = read_path_value(&key).expect("read seeded");
        assert_eq!(val, seeded, "%VAR% must survive the round-trip unexpanded");
        assert!(
            matches!(vtype, REG_EXPAND_SZ),
            "type preserved: got {vtype:?}"
        );

        // Append our dir at the same type — the actual install mutation.
        let dir = r"C:\Users\me\AppData\Local\GitDesktop";
        let next = path_with_dir_added(&val, dir).expect("dir is new");
        write_path_value(&key, &next, vtype).expect("append write");
        let (val2, vtype2) = read_path_value(&key).expect("read appended");
        assert_eq!(val2, format!(r"{seeded};{dir}"));
        assert!(matches!(vtype2, REG_EXPAND_SZ));

        // A REG_SZ value is honored as REG_SZ, not forced to expand-sz.
        write_path_value(&key, r"C:\Only", REG_SZ).expect("sz write");
        let (_, sz_type) = read_path_value(&key).expect("read sz");
        assert!(matches!(sz_type, REG_SZ), "type honored: got {sz_type:?}");

        hkcu.delete_subkey_all(SCRATCH)
            .expect("cleanup scratch key");
    }
}
