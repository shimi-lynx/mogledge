pub mod ai_handoff;
pub mod artifact_export;
mod commands;
pub mod core;
pub mod document_identity;
pub mod document_links;
pub mod document_server;
pub mod document_state;
pub mod file_actions;
pub mod html_authoring;
pub mod identifier_migration;
pub mod index;
pub mod knowledge;
pub mod managed_folders;
mod native_chrome;
mod navigation;
pub mod os_actions;
pub(crate) mod profile_store;
mod resident;
#[path = "resident/model.rs"]
pub mod resident_model;
pub mod root_recovery;
mod startup_profile;
pub mod state_inspection;
pub mod state_transfer;
pub mod storage_identity_transition;
pub mod storage_limits;
mod storage_transition_window;
mod tab_session_exit;
#[cfg(all(test, unix))]
mod test_fixtures;
pub mod tree_mutations;
pub mod tree_order;
mod updater;
#[cfg(test)]
#[path = "../updater_build_config.rs"]
mod updater_build_config;
pub mod updater_model;
pub mod watcher;
pub mod workspace_settings;
pub mod write_fs;

use crate::core::Core;
use std::sync::Arc;
use tauri::{
    utils::config::Csp,
    webview::{NewWindowResponse, PermissionResponse, WebviewWindowBuilder},
    Manager, WebviewUrl,
};

pub fn shell_csp(origin: &str, dev: bool) -> String {
    let dev_connect = if dev {
        " http://127.0.0.1:1420 ws://127.0.0.1:1420"
    } else {
        ""
    };
    // Virtual rows use inline style attributes; the UI still disallows inline scripts.
    format!("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ipc: http://ipc.localhost{dev_connect}; frame-src {origin}; object-src 'none'; base-uri 'none'; form-action 'none'")
}

pub fn run() {
    if std::env::args_os().any(|argument| argument == "--storage-transition-ui") {
        storage_transition_window::run();
        return;
    }
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("Cannot bind the local document server");
    listener.set_nonblocking(true).unwrap();
    let core = Core::new(listener.local_addr().unwrap().port());
    let server_core = core.clone();
    tauri::async_runtime::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        if let Err(error) = axum::serve(listener, document_server::router(server_core)).await {
            eprintln!("Local document server stopped: {error}");
        }
    });
    let mut context = tauri::generate_context!();
    context.config_mut().app.security.csp = Some(Csp::Policy(shell_csp(&core.origin, false)));
    context.config_mut().app.security.dev_csp = Some(Csp::Policy(shell_csp(&core.origin, true)));
    let profile_runtime = startup_profile::Runtime::configured(&context.config().identifier)
        .unwrap_or_else(|message| {
            eprintln!("{message}");
            std::process::exit(1)
        });
    let setup_runtime = profile_runtime.clone();
    let ipc_runtime = profile_runtime.clone();
    let setup_core = core.clone();
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    // The app consumes WebView/window events, not Tao's raw DeviceEvent stream.
    // Disable Tao's registration before setup so the resident receiver can own
    // keyboard Raw Input without replacing another component's registration.
    let builder = builder.device_event_filter(tauri::DeviceEventFilter::Always);
    #[cfg(any(windows, target_os = "macos"))]
    let builder = builder
        // Same identifier/profile only. Never accept a second process's paths.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            resident::restore(app, false)
        }))
        // New registrations use the product name; installer compatibility handles owned old entries.
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Mogledge")
                .build(),
        )
        .plugin(tauri_plugin_global_shortcut::Builder::new().build());
    #[cfg(all(feature = "e2e-embedded", target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let result = builder
        .plugin(tauri_plugin_dialog::init())
        .manage(core.clone())
        .manage(profile_runtime.clone())
        .manage(native_chrome::ChromeState::default())
        .manage(native_chrome::ShortcutState::default())
        .manage(resident::ResidentState::default())
        .manage(updater::UpdaterState::default())
        .manage(tab_session_exit::ExitState::default())
        .manage(storage_transition_window::LaunchState::default())
        .on_menu_event(|app, event| resident::menu_event(app, &event))
        .invoke_handler(move |invoke| {
            if !ipc_runtime.allows_ipc() {
                invoke.resolver.reject("StartupUnavailable");
                return true;
            }
            let handler: fn(tauri::ipc::Invoke<tauri::Wry>) -> bool = tauri::generate_handler![
                storage_transition_window::open_storage_identity_transition,
                commands::choose_knowledge_root,
                commands::managed::get_managed_folders,
                commands::managed::create_managed_folder,
                commands::managed::register_managed_folder,
                commands::managed::select_managed_folder,
                commands::managed::unregister_managed_folder,
                commands::managed::get_document_identity_status,
                commands::managed::configure_document_identity,
                commands::choose_display_folder,
                commands::set_display_folder,
                commands::get_document_storage_hold,
                commands::get_knowledge_tree,
                commands::get_asset_usage,
                commands::artifact::save_html_artifact,
                commands::transfer::choose_state_transfer_file,
                commands::transfer::prepare_state_transfer,
                commands::transfer::confirm_state_transfer,
                commands::transfer::cancel_state_transfer,
                commands::transfer::verify_state_transfer,
                commands::storage_limits::get_storage_limits,
                commands::storage_limits::set_storage_limits,
                commands::state_management::inspect_saved_state,
                commands::state_management::list_saved_state_recovery,
                commands::state_management::prepare_saved_state_management,
                commands::state_management::confirm_saved_state_management,
                commands::state_management::cancel_saved_state_management,
                commands::state_management::verify_saved_state_management,
                commands::open_document,
                commands::begin_document_view,
                commands::create_document_tab,
                commands::close_document_tab,
                commands::get_document_state_recovery,
                commands::recover_document_state,
                commands::refresh_knowledge,
                commands::retry_saved_root,
                commands::search::get_index_status,
                commands::search::search_documents,
                commands::search::rebuild_search_index,
                commands::perform_file_action,
                commands::root_actions::perform_root_action,
                commands::html_authoring::get_html_authoring_status,
                commands::html_authoring::preview_html_authoring_kit,
                commands::html_authoring::cancel_html_authoring_kit,
                commands::html_authoring::install_html_authoring_kit,
                commands::html_authoring::set_html_authoring_enabled,
                commands::ai_handoff::prepare_ai_handoff,
                commands::ai_handoff::perform_ai_handoff,
                commands::links::resolve_document_link,
                commands::links::validate_document_navigation,
                commands::links::open_external_document_link,
                commands::mutate_tree,
                tab_session_exit::confirm_tab_session_flush,
                commands::workspace::get_tab_session,
                commands::workspace::capture_tab_session,
                commands::workspace::get_workspace_sets,
                commands::workspace::capture_workspace_set,
                commands::workspace::edit_workspace_set,
                commands::workspace::assign_workspace_set_shortcut,
                commands::workspace::resolve_workspace_set,
                commands::workspace::get_workspace_lists,
                commands::workspace::set_document_favorite,
                commands::workspace::validate_workspace_document,
                commands::workspace::validate_workspace_folder,
                commands::workspace::record_document_display,
                native_chrome::get_window_chrome,
                native_chrome::perform_window_action,
                native_chrome::set_window_shortcut_scope,
                resident::get_resident_status,
                resident::update_resident_preferences,
                resident::resolve_resident_target,
                updater::get_app_update_status,
                updater::open_app_update_help,
                updater::check_app_update,
                updater::download_app_update,
                updater::cancel_app_update,
                updater::restart_app_update
            ];
            handler(invoke)
        })
        .setup(move |app| {
            updater::initialize(app)?;
            #[cfg(feature = "e2e")]
            os_actions::prepare_capture()?;
            setup_runtime
                .start(app.handle().clone(), setup_core.clone())
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .build(context)
        .map(|app| {
            let exit_runtime = profile_runtime.clone();
            app.run(move |app, event| match event {
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen { .. } => resident::restore(app, false),
                tauri::RunEvent::ExitRequested { code, api, .. }
                    if exit_runtime.allows_ipc()
                        && app.get_webview_window("main").is_some()
                        && !tab_session_exit::allowed(app) =>
                {
                    api.prevent_exit();
                    tab_session_exit::request_exit(app, code.unwrap_or(0));
                }
                tauri::RunEvent::Exit => resident::shutdown(app),
                _ => (),
            })
        });
    if let Err(error) = workspace_settings::flush(&core) {
        eprintln!("Workspace preferences were not saved: {error}");
    }
    if profile_runtime.holds_process_lease() {
        // Retain the profile while server/Tauri may still hold Core DB connections.
        let _runtime_owner = profile_runtime;
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    result.expect("Unable to run Mogledge");
}

fn open_main_window(app: &tauri::AppHandle, setup_core: Arc<Core>) -> Result<(), String> {
    let navigation_core = setup_core.clone();
    let window_builder =
        WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
            // CSS scales only the focused document; Native page zoom must not also run.
            .zoom_hotkeys_enabled(false)
            .visible(false)
            // OS taskbar previews and accessibility need a title even though
            // the app's custom/hidden title bar does not display this text.
            .title(app.config().product_name.as_deref().unwrap_or("Mogledge"))
            .inner_size(1280.0, 820.0)
            .min_inner_size(760.0, 500.0)
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_permission_request(|_, _| PermissionResponse::Deny)
            .on_navigation(move |url| {
                let host = url.host_str().unwrap_or_default();
                let ui = matches!(url.path(), "" | "/" | "/index.html")
                    && ((url.scheme() == "tauri" && host == "localhost")
                        || (matches!(url.scheme(), "http" | "https") && host == "tauri.localhost")
                        || (cfg!(debug_assertions)
                            && url.scheme() == "http"
                            && host == "127.0.0.1"
                            && url.port() == Some(1420)));
                if ui {
                    return true;
                }
                navigation::frame_allowed(&navigation_core, url)
            });
    #[cfg(target_os = "macos")]
    let window_builder = window_builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    // Tree/tab moves use HTML5 DnD, not Tauri's native file-drop events.
    // Let WKWebView/WebView2 handle frontend drops; select roots via the dialog.
    #[cfg(any(windows, target_os = "macos"))]
    let window_builder = window_builder.disable_drag_drop_handler();
    #[cfg(windows)]
    let window_builder = window_builder.decorations(false);
    let window = window_builder.build().map_err(|_| "画面を準備できません")?;
    navigation::install_frame_guard(&window, setup_core.clone())
        .map_err(|_| "文書の隔離を準備できません")?;
    native_chrome::install(&window).map_err(|_| "ウィンドウを準備できません")?;
    resident::initialize(app, &setup_core);
    window.show().map_err(|_| "画面を表示できません")?;
    Ok(())
}
