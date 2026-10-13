//! Window chrome and a small, window-scoped set of native application commands.
//! Documents never receive a command bridge or an extra sandbox permission.

#[cfg(windows)]
mod windows;

use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU8, Ordering},
    Arc, Mutex,
};
use tauri::{Emitter, Manager, State, WebviewWindow};

pub const HEIGHT: f64 = 40.0;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowChrome {
    pub platform: &'static str,
    pub height: f64,
    pub left_inset: f64,
    pub right_inset: f64,
    pub maximized: bool,
    pub minimized: bool,
}

impl Default for WindowChrome {
    fn default() -> Self {
        Self {
            platform: if cfg!(windows) {
                "windows"
            } else if cfg!(target_os = "macos") {
                "macos"
            } else {
                "other"
            },
            height: HEIGHT,
            left_inset: if cfg!(target_os = "macos") { 80.0 } else { 0.0 },
            right_inset: if cfg!(windows) { 138.0 } else { 0.0 },
            maximized: false,
            minimized: false,
        }
    }
}

pub type ChromeState = Arc<Mutex<WindowChrome>>;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShortcutScope {
    App,
    SearchInput,
    Paused,
}

#[derive(Default)]
pub struct ShortcutScopeState {
    scope: AtomicU8,
    #[cfg(target_os = "macos")]
    menu_items: Mutex<
        Option<(
            tauri::menu::MenuItem<tauri::Wry>,
            tauri::menu::MenuItem<tauri::Wry>,
        )>,
    >,
}

pub type ShortcutState = Arc<ShortcutScopeState>;

impl ShortcutScopeState {
    pub fn allows(&self, command: &str) -> bool {
        match self.scope.load(Ordering::Acquire) {
            0 => matches!(command, "focus-search" | "reopen-closed-tab"),
            1 => command == "focus-search",
            _ => false,
        }
    }
}

#[tauri::command]
pub fn set_window_shortcut_scope(
    window: WebviewWindow,
    state: State<'_, ShortcutState>,
    scope: ShortcutScope,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("このウィンドウでは利用できません".to_owned());
    }
    state.scope.store(
        match scope {
            ShortcutScope::App => 0,
            ShortcutScope::SearchInput => 1,
            ShortcutScope::Paused => 2,
        },
        Ordering::Release,
    );
    #[cfg(target_os = "macos")]
    if let Some((search, reopen)) = state
        .menu_items
        .lock()
        .map_err(|_| "ショートカット状態を更新できません")?
        .as_ref()
    {
        search
            .set_enabled(state.allows("focus-search"))
            .map_err(|_| "ショートカット状態を更新できません")?;
        reopen
            .set_enabled(state.allows("reopen-closed-tab"))
            .map_err(|_| "ショートカット状態を更新できません")?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_window_chrome(
    window: WebviewWindow,
    state: State<'_, ChromeState>,
) -> Result<WindowChrome, String> {
    if window.label() != "main" {
        return Err("このウィンドウでは利用できません".to_owned());
    }
    state
        .lock()
        .map(|metrics| {
            let mut metrics = metrics.clone();
            metrics.maximized = window.is_maximized().unwrap_or(false);
            metrics.minimized = window.is_minimized().unwrap_or(false);
            metrics
        })
        .map_err(|_| "ウィンドウ情報を取得できません".to_owned())
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowAction {
    Minimize,
    ToggleMaximize,
    Close,
}

#[tauri::command]
pub fn perform_window_action(window: WebviewWindow, action: WindowAction) -> Result<(), String> {
    if window.label() != "main" {
        return Err("このウィンドウでは利用できません".to_owned());
    }
    match action {
        WindowAction::Minimize => window.minimize(),
        WindowAction::ToggleMaximize => {
            if window.is_maximized().map_err(|error| error.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        WindowAction::Close => window.close(),
    }
    .map_err(|error| error.to_string())
}

pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = window;
    #[cfg(windows)]
    windows::install(window)?;
    #[cfg(target_os = "macos")]
    install_mac_commands(window)?;
    let target = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            if crate::resident::close_to_tray(&target) {
                api.prevent_close();
            }
        }
        if matches!(event, tauri::WindowEvent::Resized(_)) {
            if let Ok(metrics) = get_window_chrome(target.clone(), target.state::<ChromeState>()) {
                let _ = target.emit_to("main", "window-chrome-changed", metrics);
            }
        }
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_mac_commands(window: &WebviewWindow) -> tauri::Result<()> {
    use tauri::menu::{MenuItem, Submenu};
    let app = window.app_handle();
    let menu = mac_menu(app)?;
    let commands = Submenu::new(app, "文書", true)?;
    let search = MenuItem::with_id(app, "focus-search", "全文検索", true, Some("Cmd+Shift+F"))?;
    let reopen = MenuItem::with_id(
        app,
        "reopen-closed-tab",
        "閉じたタブを開き直す",
        true,
        Some("Cmd+Shift+T"),
    )?;
    commands.append(&search)?;
    commands.append(&reopen)?;
    *window
        .state::<ShortcutState>()
        .menu_items
        .lock()
        .expect("Shortcut state is unavailable") = Some((search, reopen));
    menu.append(&commands)?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let Some(window) = app.get_webview_window("main") else {
            return;
        };
        if !window.is_focused().unwrap_or(false) {
            return;
        }
        if matches!(
            event.id().as_ref(),
            "close-file-window" | "close-window-window"
        ) {
            let _ = window.close();
            return;
        }
        if window.state::<ShortcutState>().allows(event.id().as_ref()) {
            let _ = window.emit_to(window.label(), "window-command", event.id().as_ref());
        }
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn mac_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{
        AboutMetadata, Menu, MenuItem, PredefinedMenuItem as Native, Submenu, HELP_SUBMENU_ID,
        WINDOW_SUBMENU_ID,
    };
    let info = app.package_info();
    let config = app.config();
    // Match Tauri 2.12.1's ordinary Mac menu, but own both Close command IDs at
    // construction. Muda's native item kind is private and rendered text loses
    // mnemonic markers, so neither labels nor newly created native IDs identify it.
    // No Cmd+W accelerator: WKWebView retains HTML-first tab-close ownership.
    let file_close =
        MenuItem::with_id(app, "close-file-window", "Close Window", true, None::<&str>)?;
    let window_close = MenuItem::with_id(
        app,
        "close-window-window",
        "Close Window",
        true,
        None::<&str>,
    )?;
    Menu::with_items(
        app,
        &[
            &Submenu::with_items(
                app,
                info.name.clone(),
                true,
                &[
                    &Native::about(
                        app,
                        None,
                        Some(AboutMetadata {
                            name: Some(info.name.clone()),
                            version: Some(info.version.to_string()),
                            copyright: config.bundle.copyright.clone(),
                            authors: config
                                .bundle
                                .publisher
                                .clone()
                                .map(|publisher| vec![publisher]),
                            ..Default::default()
                        }),
                    )?,
                    &Native::separator(app)?,
                    &Native::services(app, None)?,
                    &Native::separator(app)?,
                    &Native::hide(app, None)?,
                    &Native::hide_others(app, None)?,
                    &Native::separator(app)?,
                    &Native::quit(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "File", true, &[&file_close])?,
            &Submenu::with_items(
                app,
                "Edit",
                true,
                &[
                    &Native::undo(app, None)?,
                    &Native::redo(app, None)?,
                    &Native::separator(app)?,
                    &Native::cut(app, None)?,
                    &Native::copy(app, None)?,
                    &Native::paste(app, None)?,
                    &Native::select_all(app, None)?,
                ],
            )?,
            &Submenu::with_items(app, "View", true, &[&Native::fullscreen(app, None)?])?,
            &Submenu::with_id_and_items(
                app,
                WINDOW_SUBMENU_ID,
                "Window",
                true,
                &[
                    &Native::minimize(app, None)?,
                    &Native::maximize(app, None)?,
                    &Native::separator(app)?,
                    &window_close,
                ],
            )?,
            &Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[])?,
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::{ShortcutScope, ShortcutScopeState, WindowAction};
    use std::sync::atomic::Ordering;

    #[test]
    fn native_scope_only_allows_fixed_commands() {
        let state = ShortcutScopeState::default();
        assert!(state.allows("focus-search"));
        assert!(state.allows("reopen-closed-tab"));
        for command in [
            "",
            "move-tab-left",
            "move-tab-right",
            "open-document",
            "FOCUS-SEARCH",
        ] {
            assert!(!state.allows(command));
        }
        state.scope.store(1, Ordering::Release);
        assert!(state.allows("focus-search"));
        assert!(!state.allows("reopen-closed-tab"));
        for paused in [2, u8::MAX] {
            state.scope.store(paused, Ordering::Release);
            assert!(!state.allows("focus-search"));
            assert!(!state.allows("reopen-closed-tab"));
        }
        state.scope.store(0, Ordering::Release);
        assert!(state.allows("reopen-closed-tab"));
    }

    #[test]
    fn scope_input_rejects_unknown_values_and_non_strings() {
        for input in ["\"app\"", "\"search-input\"", "\"paused\""] {
            assert!(serde_json::from_str::<ShortcutScope>(input).is_ok());
        }
        for input in ["\"unknown\"", "\"search_input\"", "true", "null", "{}", "0"] {
            assert!(serde_json::from_str::<ShortcutScope>(input).is_err());
        }
    }
    #[test]
    fn window_actions_accept_only_fixed_operations() {
        for input in ["\"minimize\"", "\"toggle-maximize\"", "\"close\""] {
            assert!(serde_json::from_str::<WindowAction>(input).is_ok());
        }
        for input in ["\"openFolder\"", "\"maximize-all\"", "null", "{}", "true"] {
            assert!(serde_json::from_str::<WindowAction>(input).is_err());
        }
    }
}
