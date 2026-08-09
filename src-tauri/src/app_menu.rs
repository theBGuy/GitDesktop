//! The macOS application menu. Windows and Linux ship none on purpose — the
//! in-window repo dropdown is the idiom there — so everything but the
//! `set_recent_repos_menu` IPC contract is macOS-only.
//! Our items carry no keyboard shortcuts: the app's hotkeys are rebindable in
//! settings, while a menu shortcut is static and intercepts the chord before
//! the webview, so it would both lie about and steal a rebound binding.

use serde::Deserialize;

#[cfg(target_os = "macos")]
use crate::error::AppError;
use crate::error::AppResult;
#[cfg(target_os = "macos")]
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::menu::{
    AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID,
    WINDOW_SUBMENU_ID,
};
#[cfg(target_os = "macos")]
use tauri::{AppHandle, Emitter, Manager, State, Wry};

/// One row of File → Open Recent. Plain shape, single-word fields: the frontend
/// sends `{ label, path }` verbatim.
// The fields are only read on macOS; off it the type exists solely to keep the
// command's wire shape identical across platforms.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Deserialize)]
pub struct RecentMenuEntry {
    pub label: String,
    pub path: String,
}

#[cfg(target_os = "macos")]
const ID_NEW_REPO: &str = "gd-menu-new-repo";
#[cfg(target_os = "macos")]
const ID_OPEN_REPO: &str = "gd-menu-open-repo";
#[cfg(target_os = "macos")]
const ID_CLONE_REPO: &str = "gd-menu-clone-repo";
#[cfg(target_os = "macos")]
const ID_SETTINGS: &str = "gd-menu-settings";
/// Recents items encode their repo path in the id, so a click needs no lookup
/// table and can't read a stale row after a concurrent submenu rebuild.
#[cfg(target_os = "macos")]
const ID_RECENT_PREFIX: &str = "gd-menu-recent:";
#[cfg(target_os = "macos")]
const ID_RECENT_EMPTY: &str = "gd-menu-recent-empty";

/// Handle to the live Open Recent submenu so the frontend can push a fresh
/// recents list into it. Tauri's menu types are `Send + Sync` and every menu
/// operation hops to the main thread internally, so a command may mutate this
/// handle directly.
#[cfg(target_os = "macos")]
pub struct AppMenuState(Mutex<Option<Submenu<Wry>>>);

/// Installs the application menu and routes its clicks into the frontend.
#[cfg(target_os = "macos")]
pub fn setup_app_menu(app: &AppHandle) -> tauri::Result<()> {
    let recent = Submenu::with_items(app, "Open Recent", true, &[&empty_recent_item(app)?])?;
    let menu = build_menu(app, &recent)?;
    app.set_menu(menu)?;
    app.manage(AppMenuState(Mutex::new(Some(recent))));
    app.on_menu_event(handle_menu_event);
    Ok(())
}

/// Mirrors `Menu::default`'s macOS composition, with Settings added to the app
/// submenu and the repo actions added to File. Constructing it outright (rather
/// than mutating the default) keeps the layout explicit; it must be re-checked
/// against `tauri::menu::Menu::default` on a Tauri major upgrade.
#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle, recent: &Submenu<Wry>) -> tauri::Result<Menu<Wry>> {
    let pkg_info = app.package_info();
    let config = app.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    let app_submenu = Submenu::with_items(
        app,
        pkg_info.name.clone(),
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(about_metadata))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, ID_SETTINGS, "Settings…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let file_submenu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, ID_NEW_REPO, "New Repository…", true, None::<&str>)?,
            &MenuItem::with_id(app, ID_OPEN_REPO, "Open Repository…", true, None::<&str>)?,
            &MenuItem::with_id(app, ID_CLONE_REPO, "Clone Repository…", true, None::<&str>)?,
            recent,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // Load-bearing: macOS routes undo/redo/cut/copy/paste/select-all in text
    // inputs through these predefined items — dropping any of them breaks
    // typing in every field in the app.
    let edit_submenu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_submenu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    let window_submenu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // Empty, as in the default menu: macOS puts its own Search item here.
    let help_submenu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?;

    Menu::with_items(
        app,
        &[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &window_submenu,
            &help_submenu,
        ],
    )
}

/// The macOS convention for an empty recents list: one disabled row, never an
/// empty submenu.
#[cfg(target_os = "macos")]
fn empty_recent_item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(
        app,
        ID_RECENT_EMPTY,
        "No Recent Repositories",
        false,
        None::<&str>,
    )
}

/// Turns a menubar click into the same frontend action the command palette and
/// hotkeys dispatch. muda has ONE global menu-event channel — every registered
/// listener sees EVERY menu event, tray items included — so match only our
/// `gd-menu-` ids and fall through everything else untouched.
#[cfg(target_os = "macos")]
fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id.as_ref();
    if let Some(path) = id.strip_prefix(ID_RECENT_PREFIX) {
        // Close-to-tray can leave the window hidden while the menu bar stays
        // clickable, and a dialog raised in a hidden window is invisible.
        crate::tray::show_main_window(app);
        let _ = app.emit("app-menu-open-recent", path);
        return;
    }
    let action = match id {
        ID_NEW_REPO => "new-repository",
        ID_OPEN_REPO => "add-local-repository",
        ID_CLONE_REPO => "clone-repository",
        ID_SETTINGS => "open-settings",
        _ => return,
    };
    crate::tray::show_main_window(app);
    let _ = app.emit("app-menu-action", action);
}

/// Rebuilds File → Open Recent from the frontend's recents list, newest first.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn set_recent_repos_menu(
    app: AppHandle,
    state: State<AppMenuState>,
    entries: Vec<RecentMenuEntry>,
) -> AppResult<()> {
    fn menu_err(e: tauri::Error) -> AppError {
        AppError::Command(e.to_string())
    }
    // A poisoned lock only means a previous rebuild panicked mid-way; the
    // submenu handle itself stays valid, so recover rather than propagate.
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let Some(recent) = guard.as_ref() else {
        return Ok(());
    };
    // In place: this handle is the one installed in the live menu, so the rows
    // are drained and re-appended rather than the submenu being replaced.
    while recent.remove_at(0).map_err(menu_err)?.is_some() {}
    if entries.is_empty() {
        let item = empty_recent_item(&app).map_err(menu_err)?;
        recent.append(&item).map_err(menu_err)?;
        return Ok(());
    }
    for entry in entries {
        let item = MenuItem::with_id(
            &app,
            format!("{ID_RECENT_PREFIX}{}", entry.path),
            &entry.label,
            true,
            None::<&str>,
        )
        .map_err(menu_err)?;
        recent.append(&item).map_err(menu_err)?;
    }
    Ok(())
}

/// No-op twin so the command is registered on every platform: only macOS has an
/// app menu, but a stray call from the frontend must not error.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn set_recent_repos_menu(_entries: Vec<RecentMenuEntry>) -> AppResult<()> {
    Ok(())
}
