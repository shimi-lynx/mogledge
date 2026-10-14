//! Optional resident UI. OS registration is changed only by explicit main-UI commands.
#[cfg(any(windows, target_os = "macos"))]
#[path = "resident/custom.rs"]
mod custom;
#[cfg(target_os = "macos")]
#[path = "resident/macos.rs"]
mod platform;
#[cfg(windows)]
#[path = "resident/windows.rs"]
mod platform;
#[path = "resident/sequence.rs"]
pub mod sequence;
#[path = "resident/shortcut_transaction.rs"]
mod shortcut_transaction;
#[path = "resident/startup.rs"]
mod startup_transaction;
#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    pub struct Monitor;
    impl Monitor {
        pub fn is_running(&self) -> bool {
            false
        }
    }
    pub fn permitted() -> bool {
        false
    }
    pub fn start(_: std::sync::Arc<dyn Fn() + Send + Sync>) -> Result<Monitor, &'static str> {
        Err("ResidentUnsupportedPlatform")
    }
    pub fn open_permission_settings() -> Result<(), &'static str> {
        Err("ResidentUnsupportedPlatform")
    }
}

use crate::{
    core::Core,
    resident_model::{self as model, Preferences, Shortcut, Store, Target},
};
use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State, WebviewWindow,
};

struct Runtime {
    preferences: Preferences,
    store: Option<Store>,
    monitor: Option<Monitor>,
    pending_cleanup: Vec<Monitor>,
    tray: Option<TrayIcon<tauri::Wry>>,
    monitor_status: &'static str,
    error: Option<String>,
    show_item: Option<MenuItem<tauri::Wry>>,
    quit_item: Option<MenuItem<tauri::Wry>>,
    language: String,
    startup_registered: Option<bool>,
    shutting_down: bool,
}
impl Default for Runtime {
    fn default() -> Self {
        Self {
            preferences: Preferences::default(),
            store: None,
            monitor: None,
            pending_cleanup: Vec::new(),
            tray: None,
            monitor_status: "off",
            error: None,
            show_item: None,
            quit_item: None,
            language: "ja".into(),
            startup_registered: None,
            shutting_down: false,
        }
    }
}
#[derive(Default)]
pub struct ResidentState {
    runtime: Mutex<Runtime>,
    recall_allowed: AtomicBool,
    closing: AtomicBool,
}
// Restore runs on the main thread, where plugin registration also executes.
// Published gates avoid waiting for a command that holds Runtime while the
// plugin dispatches there synchronously. Only committed tray/preferences allow recall.
fn publish_recall_gate(state: &ResidentState, runtime: &Runtime) {
    state.recall_allowed.store(
        runtime.preferences.enabled && runtime.tray.is_some(),
        Ordering::Release,
    );
}
enum Monitor {
    Standard {
        monitor: platform::Monitor,
        active: Arc<AtomicBool>,
    },
    #[cfg(any(windows, target_os = "macos"))]
    Custom(custom::Registration),
}
impl Monitor {
    fn is_running(&self) -> bool {
        match self {
            Self::Standard { monitor, .. } => monitor.is_running(),
            #[cfg(any(windows, target_os = "macos"))]
            Self::Custom(registration) => registration.is_running(),
        }
    }
    fn stop(&mut self) -> Result<(), String> {
        match self {
            // The passive monitor is retained until replace drops the old handle.
            Self::Standard { active, .. } => {
                active.store(false, Ordering::Release);
                Ok(())
            }
            #[cfg(any(windows, target_os = "macos"))]
            Self::Custom(registration) => registration.stop(),
        }
    }
    fn activate(&self) {
        match self {
            Self::Standard { active, .. } => active.store(true, Ordering::Release),
            #[cfg(any(windows, target_os = "macos"))]
            Self::Custom(registration) => registration.activate(),
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    tray_available: bool,
    startup_enabled: bool,
    startup_registered: Option<bool>,
    target: Target,
    shortcut: Shortcut,
    monitor_status: &'static str,
    supported: bool,
    read_only: bool,
    error: Option<String>,
}
impl Runtime {
    fn status(&self) -> Status {
        Status {
            enabled: self.preferences.enabled,
            tray_available: self.tray.is_some(),
            startup_enabled: self.preferences.startup_enabled,
            startup_registered: self.startup_registered,
            target: self.preferences.target.clone(),
            shortcut: self.preferences.shortcut.clone(),
            monitor_status: self.monitor_status,
            supported: cfg!(any(windows, target_os = "macos")),
            read_only: self.store.is_none(),
            error: self.error.clone(),
        }
    }
}

pub fn restore(app: &AppHandle, select_target: bool) {
    recall_diagnostic(
        "restore-requested",
        || serde_json::json!({"selectTarget":select_target}),
    );
    let target = app.clone();
    let queued = app.run_on_main_thread(move || {
        recall_diagnostic("restore-main-thread", || serde_json::json!({}));
        {
            let state = target.state::<ResidentState>();
            if state.closing.load(Ordering::Acquire)
                || (select_target && !state.recall_allowed.load(Ordering::Acquire))
            {
                recall_diagnostic("restore-disabled", || serde_json::json!({}));
                return;
            }
        }
        if let Some(window) = target.get_webview_window("main") {
            let shown = window.show().is_ok();
            recall_diagnostic("restore-show", || serde_json::json!({"succeeded":shown}));
            if shown {
                let unminimized = window.unminimize().is_ok();
                let focused = window.set_focus().is_ok();
                let diagnostic_active = recall_diagnostic("restore-focus-request", || serde_json::json!({"unminimizeRequested":unminimized,"focusRequested":focused}));
                if select_target {
                    let emitted = target.emit_to("main", "resident-call", ()).is_ok();
                    recall_diagnostic("restore-emitted", || serde_json::json!({"succeeded":emitted}));
                }
                if diagnostic_active {
                    let _ = target.run_on_main_thread(|| {
                        recall_diagnostic("restore-foreground-check", || serde_json::json!({}));
                    });
                }
            }
        } else {
            recall_diagnostic("restore-window-missing", || serde_json::json!({}));
        }
    });
    recall_diagnostic(
        "restore-queued",
        || serde_json::json!({"succeeded":queued.is_ok()}),
    );
}

fn recall_diagnostic(event: &'static str, details: impl FnOnce() -> serde_json::Value) -> bool {
    #[cfg(windows)]
    return platform::gesture_diagnostic(event, details);
    #[cfg(not(windows))]
    {
        let _ = (event, details);
        false
    }
}
fn prepare_monitor(app: &AppHandle, shortcut: &Shortcut) -> Result<Option<Monitor>, String> {
    if !shortcut.valid() {
        return Err("ResidentShortcutInvalid".into());
    }
    if matches!(shortcut, Shortcut::Custom { .. }) {
        #[cfg(any(windows, target_os = "macos"))]
        return custom::Registration::start(app, shortcut)
            .map(Monitor::Custom)
            .map(Some);
        #[cfg(not(any(windows, target_os = "macos")))]
        return Err("ResidentUnsupportedPlatform".into());
    }
    if !platform::permitted() {
        return Ok(None);
    }
    let target = app.clone();
    let active = Arc::new(AtomicBool::new(false));
    let activated = active.clone();
    platform::start(Arc::new(move || {
        if activated.load(Ordering::Acquire) {
            restore(&target, true);
        }
    }))
    .map(|monitor| Monitor::Standard { monitor, active })
    .map(Some)
    .map_err(String::from)
}
fn refresh_monitor_status(runtime: &mut Runtime) {
    runtime.monitor_status = if !runtime.preferences.enabled {
        "off"
    } else if runtime.monitor.as_ref().is_some_and(Monitor::is_running) {
        "active"
    } else if matches!(runtime.preferences.shortcut, Shortcut::Standard)
        && cfg!(target_os = "macos")
        && !platform::permitted()
    {
        "permission-required"
    } else {
        "unavailable"
    };
}
fn start_monitor(app: &AppHandle, runtime: &mut Runtime) {
    // Called only when no existing active registration needs replacing.
    match prepare_monitor(app, &runtime.preferences.shortcut) {
        Ok(monitor) => {
            runtime.monitor = monitor;
            if let Some(monitor) = &runtime.monitor {
                monitor.activate();
            }
        }
        Err(error) => runtime.error = Some(error),
    }
    refresh_monitor_status(runtime);
}
fn enable(app: &AppHandle, runtime: &mut Runtime) -> Result<(), String> {
    if runtime.tray.is_some() {
        return Ok(());
    }
    if !cfg!(any(windows, target_os = "macos")) {
        return Err("ResidentUnsupportedPlatform".into());
    }
    let english = runtime.language == "en";
    let show = MenuItem::with_id(
        app,
        "resident-show",
        if english { "Show" } else { "表示" },
        true,
        None::<&str>,
    )
    .map_err(|_| "ResidentTrayUnavailable")?;
    let quit = MenuItem::with_id(
        app,
        "resident-quit",
        if english { "Quit" } else { "終了" },
        true,
        None::<&str>,
    )
    .map_err(|_| "ResidentTrayUnavailable")?;
    let menu = Menu::with_items(app, &[&show, &quit]).map_err(|_| "ResidentTrayUnavailable")?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("ResidentTrayUnavailable")?;
    let tray = TrayIconBuilder::with_id("resident")
        .icon(icon)
        .tooltip("Mogledge")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            // React once on release. Down/DoubleClick must not duplicate the
            // recall, and right click continues to open the existing menu.
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                restore(tray.app_handle(), true);
            }
        })
        .build(app)
        .map_err(|_| "ResidentTrayUnavailable")?;
    runtime.show_item = Some(show);
    runtime.quit_item = Some(quit);
    runtime.tray = Some(tray);
    Ok(())
}
fn remove_tray(app: &AppHandle, runtime: &mut Runtime) {
    runtime.tray.take();
    drop(app.remove_tray_by_id("resident"));
    runtime.show_item.take();
    runtime.quit_item.take();
}
fn apply_recall_preferences(
    window: &WebviewWindow,
    runtime: &mut Runtime,
    preferences: Preferences,
) {
    if !preferences.shortcut.valid() {
        runtime.error = Some("ResidentShortcutInvalid".into());
        return;
    }
    let app = window.app_handle();
    let previous = runtime.preferences.clone();
    // At most one failed staged cleanup is retained. Retry its release before
    // allowing another registration to accumulate or block the requested key.
    runtime
        .pending_cleanup
        .retain_mut(|monitor| monitor.stop().is_err());
    if !runtime.pending_cleanup.is_empty() {
        runtime.error = Some("ResidentShortcutRollbackUnavailable".into());
        return;
    }
    let created_tray = preferences.enabled && runtime.tray.is_none();
    if preferences.enabled {
        if let Err(error) = enable(app, runtime) {
            runtime.error = Some(error);
            return;
        }
    } else {
        // A failing show must not remove the user's only entrance.
        if window.show().is_err() {
            runtime.error = Some("ResidentRestoreUnavailable".into());
            return;
        }
        let _ = window.unminimize();
    }
    let replace_monitor = !preferences.enabled
        || preferences.shortcut != previous.shortcut
        || !runtime.monitor.as_ref().is_some_and(Monitor::is_running);
    let result = if replace_monitor {
        let candidate = if preferences.enabled {
            prepare_monitor(app, &preferences.shortcut)
        } else {
            Ok(None)
        };
        match candidate {
            Err(error) => Err(error),
            Ok(None)
                if preferences.enabled
                    && runtime.monitor.as_ref().is_some_and(Monitor::is_running) =>
            {
                // A switch back to the passive macOS sequence needs its existing
                // Input Monitoring grant; do not retire a working custom key.
                Err("ResidentShortcutPermissionRequired".into())
            }
            Ok(candidate) => {
                let store = runtime.store.as_mut().unwrap();
                match shortcut_transaction::replace(
                    &mut runtime.monitor,
                    candidate,
                    Monitor::stop,
                    |desired| store.save(if desired { &preferences } else { &previous }),
                ) {
                    Ok(()) => Ok(()),
                    Err(failure) => {
                        if let Some(pending) = failure.pending {
                            runtime.pending_cleanup.push(pending);
                        }
                        Err(if failure.rollback.is_some() || failure.cleanup.is_some() {
                            "ResidentShortcutRollbackUnavailable".into()
                        } else {
                            failure.error
                        })
                    }
                }
            }
        }
    } else {
        runtime.store.as_mut().unwrap().save(&preferences)
    };
    match result {
        Ok(()) => {
            runtime.preferences = preferences;
            if let Some(monitor) = &runtime.monitor {
                monitor.activate();
            }
            if !runtime.preferences.enabled {
                remove_tray(app, runtime);
            }
        }
        Err(error) => {
            if created_tray {
                remove_tray(app, runtime);
            }
            runtime.error = Some(error);
        }
    }
    refresh_monitor_status(runtime);
}
pub fn initialize(app: &AppHandle, core: &Core) {
    let state = app.state::<ResidentState>();
    let mut runtime = state.runtime.lock().unwrap();
    match Store::load(core) {
        Ok((store, preferences)) => {
            runtime.store = Some(store);
            runtime.preferences = preferences;
        }
        Err(error) => runtime.error = Some(error),
    }
    if runtime.preferences.enabled {
        if let Err(error) = enable(app, &mut runtime) {
            runtime.monitor_status = "unavailable";
            runtime.error = Some(error);
            // A stored preference never hides a window when the tray is absent.
        }
        if runtime.tray.is_some() {
            start_monitor(app, &mut runtime);
        }
    }
    publish_recall_gate(&state, &runtime);
    runtime.startup_registered = startup_registered(app).ok();
}
pub fn close_to_tray(window: &WebviewWindow) -> bool {
    let state = window.state::<ResidentState>();
    !state.closing.load(Ordering::Acquire)
        && state.recall_allowed.load(Ordering::Acquire)
        && window.hide().is_ok()
}
pub fn shutdown(app: &AppHandle) {
    let state = app.state::<ResidentState>();
    state.closing.store(true, Ordering::Release);
    state.recall_allowed.store(false, Ordering::Release);
    let mut runtime = state.runtime.lock().unwrap();
    runtime.shutting_down = true;
    runtime.monitor.take();
    runtime.pending_cleanup.clear();
    runtime.tray.take();
    drop(app.remove_tray_by_id("resident"));
    runtime.show_item.take();
    runtime.quit_item.take();
}
pub fn menu_event(app: &AppHandle, event: &tauri::menu::MenuEvent) {
    let available = {
        let state = app.state::<ResidentState>();
        !state.closing.load(Ordering::Acquire) && state.recall_allowed.load(Ordering::Acquire)
    };
    if available {
        match event.id().as_ref() {
            "resident-show" => restore(app, true),
            "resident-quit" => {
                crate::tab_session_exit::request_exit(app, 0);
            }
            _ => (),
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Action {
    Enabled {
        enabled: bool,
    },
    Shortcut {
        shortcut: Shortcut,
    },
    Startup {
        enabled: bool,
    },
    Current,
    Pin {
        workspace_id: String,
        view_id: String,
        revision: u64,
        relative_path: String,
    },
    CheckPermission,
    OpenPermissionSettings,
    Language {
        language: String,
    },
}
fn startup_registered(app: &AppHandle) -> Result<bool, String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        app.autolaunch()
            .is_enabled()
            .map_err(|_| "ResidentStartupUnavailable".to_owned())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = app;
        Err("ResidentUnsupportedPlatform".into())
    }
}
fn startup_app(app: &AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions)
        || cfg!(feature = "e2e")
        || app.config().identifier != crate::identifier_migration::CURRENT_IDENTIFIER
    {
        return Err("ResidentStartupRequiresInstalledApp".into());
    }
    Ok(())
}
fn startup(enabled: bool, app: &AppHandle) -> Result<(), String> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        use tauri_plugin_autostart::ManagerExt;
        startup_app(app)?;
        let manager = app.autolaunch();
        if enabled {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|_| "ResidentStartupUnavailable".to_owned())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (enabled, app);
        Err("ResidentUnsupportedPlatform".into())
    }
}
#[tauri::command]
pub fn get_resident_status(
    window: WebviewWindow,
    state: State<'_, ResidentState>,
) -> Result<Status, String> {
    if window.label() != "main" {
        return Err("ResidentMainWindowRequired".into());
    }
    let mut runtime = state.runtime.lock().map_err(|_| "ResidentUnavailable")?;
    runtime.startup_registered = startup_registered(window.app_handle()).ok();
    if runtime.monitor.is_some()
        && ((matches!(runtime.preferences.shortcut, Shortcut::Standard) && !platform::permitted())
            || runtime
                .monitor
                .as_ref()
                .is_some_and(|monitor| !monitor.is_running()))
    {
        runtime.monitor.take();
        runtime.monitor_status = if cfg!(target_os = "macos") && !platform::permitted() {
            "permission-required"
        } else {
            "unavailable"
        };
    }
    Ok(runtime.status())
}
#[tauri::command]
pub fn update_resident_preferences(
    window: WebviewWindow,
    core: State<'_, Arc<Core>>,
    state: State<'_, ResidentState>,
    action: Action,
) -> Result<Status, String> {
    if window.label() != "main" {
        return Err("ResidentMainWindowRequired".into());
    }
    let app = window.app_handle();
    let mut runtime = state.runtime.lock().map_err(|_| "ResidentUnavailable")?;
    if runtime.shutting_down || state.closing.load(Ordering::Acquire) {
        return Err("ResidentUnavailable".into());
    }
    if let Action::Language { language } = &action {
        if !matches!(language.as_str(), "ja" | "en") {
            return Err("ResidentInvalidSettings".into());
        }
        runtime.language = language.clone();
        if let Some(show) = &runtime.show_item {
            let _ = show.set_text(if runtime.language == "en" {
                "Show"
            } else {
                "表示"
            });
        }
        if let Some(quit) = &runtime.quit_item {
            let _ = quit.set_text(if runtime.language == "en" {
                "Quit"
            } else {
                "終了"
            });
        }
        return Ok(runtime.status());
    }
    if runtime.store.is_none() {
        return Err("ResidentSettingsReadOnly".into());
    }
    let previous = runtime.preferences.clone();
    runtime.error = None;
    if let Action::Enabled { enabled } = &action {
        let mut preferences = previous;
        preferences.enabled = *enabled;
        apply_recall_preferences(&window, &mut runtime, preferences);
        publish_recall_gate(&state, &runtime);
        return Ok(runtime.status());
    }
    if let Action::Shortcut { shortcut } = &action {
        let mut preferences = previous;
        preferences.shortcut = shortcut.clone();
        apply_recall_preferences(&window, &mut runtime, preferences);
        publish_recall_gate(&state, &runtime);
        return Ok(runtime.status());
    }
    if let Action::Startup { enabled } = &action {
        startup_app(app)?;
        let mut preferences = previous.clone();
        preferences.startup_enabled = *enabled;
        match startup_transaction::update(
            *enabled,
            || startup_registered(app),
            |value| startup(value, app),
            || runtime.store.as_mut().unwrap().save(&preferences),
        ) {
            Ok(actual) => {
                runtime.preferences = preferences;
                runtime.startup_registered = Some(actual);
            }
            Err(
                startup_transaction::Failure::Read(error)
                | startup_transaction::Failure::Write(error),
            ) => {
                runtime.startup_registered = None;
                runtime.error = Some(error);
            }
            Err(startup_transaction::Failure::Save {
                error,
                rollback,
                actual,
            }) => {
                runtime.startup_registered = actual;
                runtime.error = Some(if rollback.is_some() {
                    "ResidentStartupRollbackUnavailable".into()
                } else {
                    error
                });
            }
        }
        return Ok(runtime.status());
    }
    match action.clone() {
        Action::Enabled { .. } | Action::Shortcut { .. } => unreachable!(),
        Action::Startup { .. } => unreachable!(),
        Action::Current => runtime.preferences.target = Target::Current,
        Action::Pin {
            workspace_id,
            view_id,
            revision,
            relative_path,
        } => {
            runtime.preferences.target =
                model::capture(&core, &workspace_id, &view_id, revision, &relative_path)?
        }
        Action::CheckPermission => {
            if runtime.preferences.enabled && runtime.monitor.is_none() {
                start_monitor(app, &mut runtime);
            }
            return Ok(runtime.status());
        }
        Action::OpenPermissionSettings => {
            platform::open_permission_settings().map_err(String::from)?;
            return Ok(runtime.status());
        }
        Action::Language { .. } => unreachable!(),
    }
    let preferences = runtime.preferences.clone();
    if let Err(error) = runtime.store.as_mut().unwrap().save(&preferences) {
        runtime.preferences = previous;
        runtime.error = Some(error);
    }
    Ok(runtime.status())
}
#[tauri::command]
pub fn resolve_resident_target(
    window: WebviewWindow,
    core: State<'_, Arc<Core>>,
    state: State<'_, ResidentState>,
    tab_id: Option<String>,
) -> Result<model::Selection, String> {
    if window.label() != "main" {
        return Err("ResidentMainWindowRequired".into());
    }
    let runtime = state.runtime.lock().map_err(|_| "ResidentUnavailable")?;
    if !runtime.preferences.enabled {
        return Err("ResidentDisabled".into());
    }
    Ok(model::resolve(
        &core,
        &runtime.preferences.target,
        tab_id.as_deref(),
    ))
}
