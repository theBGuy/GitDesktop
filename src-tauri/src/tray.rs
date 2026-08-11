use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, Window, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::state::AppState;

/// What the window-state plugin persists/restores: geometry only. Visibility is
/// deliberately excluded — the tray owns whether the window is shown, and a saved
/// "hidden" state would otherwise reopen the window invisible.
pub const WINDOW_STATE_FLAGS: StateFlags = StateFlags::SIZE
    .union(StateFlags::POSITION)
    .union(StateFlags::MAXIMIZED);

/// The app's display name. In a `tauri dev` session it gets a "(Dev)" suffix so
/// a running dev build is tellable apart from an installed release — both show a
/// tray icon, and otherwise the tooltip/window title are identical. No-op (plain
/// "GitDesktop") in a bundled release.
pub fn app_display_name() -> &'static str {
    if tauri::is_dev() {
        "GitDesktop (Dev)"
    } else {
        "GitDesktop"
    }
}

/// Builds the system-tray icon + menu. Left-click restores the window; the
/// menu (right-click on Windows) offers Open and a real Quit.
pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let name = app_display_name();
    let menu = MenuBuilder::new(app)
        .text("open", format!("Open {name}"))
        .separator()
        .text("quit", "Quit")
        .build()?;

    let mut builder = TrayIconBuilder::new()
        .tooltip(name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => {
                // Final flush before exiting — the window may have moved since the
                // last debounced save.
                save_geometry_before_exit(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub(crate) fn show_main_window(app: &AppHandle) {
    // `None` is unreachable today: close-to-tray HIDES "main" (never destroys
    // it), so the window always exists while the process runs. If the app ever
    // closes + recreates the window, this silently no-ops — recreate it here.
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// In a `tauri dev` session, suffix the main window's title with "(Dev)" so the
/// dev instance is tellable apart in the taskbar / Alt-Tab from an installed
/// release. The frontend re-applies the same suffix whenever a repo is open (see
/// `RepositoryView`); this covers the initial welcome state before any repo is
/// selected. No-op in a bundled release (the title already matches the config).
pub fn init_window_title(app: &AppHandle) {
    if !tauri::is_dev() {
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title(app_display_name());
    }
}

/// Quiet period a move/resize must survive before its geometry save fires.
const GEOMETRY_SAVE_DEBOUNCE: Duration = Duration::from_millis(1000);

/// Bumped per move/resize event; a pending save runs only if it still holds the
/// latest value. `Relaxed` is enough — the counter synchronizes nothing else.
static GEOMETRY_SAVE_EPOCH: AtomicU64 = AtomicU64::new(0);

/// Persists window geometry. Call ONLY from the event-loop thread:
/// `save_window_state` holds the plugin's state-cache lock across window getters
/// that block on that thread, whose own move/resize handlers take the same lock —
/// off-thread the two deadlock mid-drag. Skipped while minimized, where the plugin
/// omits position/size but still records `maximized: false`, clobbering a maximized
/// layout. Paths that end in `app.exit` use `save_geometry_before_exit` instead,
/// which restores the window first so the plugin's own unguarded save on
/// `RunEvent::Exit` reads the real state rather than an iconic one.
fn save_geometry(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    if main.is_minimized().unwrap_or(false) {
        return;
    }
    let _ = app.save_window_state(WINDOW_STATE_FLAGS);
}

/// Geometry flush for the paths that quit: the plugin saves again — unguarded —
/// on `RunEvent::Exit`, and a minimize clears the runtime's cached maximized
/// flag, so an iconic window has to be restored first or that save records
/// `maximized: false`. Restored only when actually iconic, since unminimizing
/// also shows the window; a tray-resident window is normally not iconic (one
/// hidden while minimized flashes briefly before the quit).
fn save_geometry_before_exit(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        if main.is_minimized().unwrap_or(false) {
            let _ = main.unminimize();
        }
    }
    save_geometry(app);
}

/// Move/resize events schedule a debounced geometry save. On window close,
/// hide to the tray (keeping the app — and any in-flight review — running)
/// when the user's "close to tray" preference is on. When it's off, the close
/// proceeds and the app quits (it's the only window). The tray "Quit"
/// bypasses this entirely via `app.exit`.
pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            // Final flush for movement the debounce below hasn't caught yet — a
            // close-to-tray hide isn't a real close, so nothing else captures it.
            if window.state::<AppState>().close_to_tray() {
                save_geometry(window.app_handle());
                let _ = window.hide();
                api.prevent_close();
            } else {
                // No tray-resident lifetime wanted — quit explicitly rather than
                // rely on last-window-closed auto-exit (a tray icon can keep the
                // event loop alive).
                save_geometry_before_exit(window.app_handle());
                window.app_handle().exit(0);
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            // Debounce behind a per-event timer task, gated on an epoch counter so
            // only the newest one saves — race-free where a single-flight debouncer
            // has a lost-wakeup window, and tokio timers are cheap enough to spend
            // one task per event.
            let epoch = GEOMETRY_SAVE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
            let app = window.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(GEOMETRY_SAVE_DEBOUNCE).await;
                if GEOMETRY_SAVE_EPOCH.load(Ordering::Relaxed) != epoch {
                    return;
                }
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    if GEOMETRY_SAVE_EPOCH.load(Ordering::Relaxed) == epoch {
                        save_geometry(&handle);
                    }
                });
            });
        }
        _ => {}
    }
}

/// Mirrors the frontend's "close to tray" setting into the backend, which owns
/// the window-close decision.
#[tauri::command]
pub fn set_close_to_tray(state: State<AppState>, enabled: bool) {
    state.set_close_to_tray(enabled);
}
