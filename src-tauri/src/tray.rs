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
                // Capture geometry before exiting (the window may still be visible
                // and moved since the last close).
                let _ = app.save_window_state(WINDOW_STATE_FLAGS);
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

/// Move/resize events schedule a debounced geometry save. On window close,
/// hide to the tray (keeping the app — and any in-flight review — running)
/// when the user's "close to tray" preference is on. When it's off, the close
/// proceeds and the app quits (it's the only window). The tray "Quit"
/// bypasses this entirely via `app.exit`.
pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            // Persist geometry NOW, while the window is still visible at its real
            // position: this captures the last moments of movement the debounce
            // below hasn't flushed yet, and a close-to-tray hide isn't a real close.
            let _ = window.app_handle().save_window_state(WINDOW_STATE_FLAGS);
            if window.state::<AppState>().close_to_tray() {
                let _ = window.hide();
                api.prevent_close();
            } else {
                // No tray-resident lifetime wanted — quit explicitly rather than
                // rely on last-window-closed auto-exit (a tray icon can keep the
                // event loop alive).
                window.app_handle().exit(0);
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
            // Debounce a save behind each event with its own timer task: an epoch
            // counter lets only the newest task through, which is race-free where a
            // single-flight debouncer has a lost-wakeup window, and tokio timers are
            // cheap even at drag-rate storms. Skip while minimized: Windows reports a
            // minimize as Moved(-32000, -32000), and although the plugin refuses
            // position/size writes then, `is_maximized()` reads false — it would
            // clobber a maximized layout if the app died while minimized.
            let epoch = GEOMETRY_SAVE_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
            let window = window.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(GEOMETRY_SAVE_DEBOUNCE).await;
                if GEOMETRY_SAVE_EPOCH.load(Ordering::Relaxed) != epoch
                    || window.is_minimized().unwrap_or(false)
                {
                    return;
                }
                let _ = window.app_handle().save_window_state(WINDOW_STATE_FLAGS);
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
