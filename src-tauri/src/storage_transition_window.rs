//! Explicit offline tool mode: no normal Core, resident process, HTTP document
//! server, profile import or settings flush is initialized in this window.
use crate::storage_identity_transition::{self, offline::ui::Service};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Default)]
pub(crate) struct LaunchState(AtomicBool);

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Language {
    Ja,
    En,
}

/// The main UI may request a process handoff, never an in-process migration.
#[tauri::command]
pub(crate) async fn open_storage_identity_transition(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, LaunchState>,
    language: Language,
) -> Result<bool, String> {
    if !storage_identity_transition::enabled() || window.label() != "main" {
        return Err("StorageUnavailable".into());
    }
    if state.0.swap(true, Ordering::AcqRel) {
        return Err("StorageBusy".into());
    }
    let (message, accept, cancel) = match language {
        Language::Ja => (
            "保存データの確認ツールを開くため、Mogledgeを完全に終了します。HTMLで未保存の入力は先に保存してください。ツールでは独立したバックアップと確認を行います。",
            "終了して確認ツールを開く",
            "キャンセル",
        ),
        Language::En => (
            "Mogledge will quit completely to open the saved-data confirmation tool. Save any unsaved HTML input first. The tool requires an independent backup and your confirmation.",
            "Quit and open confirmation tool",
            "Cancel",
        ),
    };
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title("Mogledge")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            accept.into(),
            cancel.into(),
        ))
        .show(move |accepted| {
            let _ = sender.send(accepted);
        });
    let result = async {
        if !receiver
            .await
            .map_err(|_| "StorageUnavailable".to_owned())?
        {
            return Ok(false);
        }
        crate::tab_session_exit::flush(&app)
            .await
            .map_err(|_| "StorageUnavailable".to_owned())?;
        // No renderer-supplied paths, arguments or environment are forwarded. The child
        // initializes no normal Core and performs no profile I/O on mount.
        // Its first explicit inspection must acquire the exclusive profile
        // lease, so an exiting parent or another app can only cause a refusal.
        let executable = std::env::current_exe().map_err(|_| "StorageUnavailable".to_owned())?;
        std::process::Command::new(executable)
            .arg("--storage-transition-ui")
            .spawn()
            .map_err(|_| "StorageUnavailable".to_owned())?;
        crate::tab_session_exit::allow_restart(&app);
        app.exit(0);
        Ok(true)
    }
    .await;
    // Keep the handoff closed after a successful spawn while exit completes.
    if !matches!(result, Ok(true)) {
        state.0.store(false, Ordering::Release);
    }
    result
}

fn authorize(window: &WebviewWindow) -> Result<(), String> {
    if !storage_identity_transition::enabled() {
        return Err("native_identity_disabled".into());
    }
    if window.label() != "storage-transition" {
        return Err("invalid_host".into());
    }
    Ok(())
}
#[tauri::command]
async fn storage_transition_request(
    window: WebviewWindow,
    service: State<'_, Arc<Service>>,
    request: Value,
) -> Result<Value, String> {
    authorize(&window)?;
    let quit = request["command"] == "quit";
    let service = service.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || service.request(request))
        .await
        .map_err(|_| "state_unavailable".to_owned())??;
    if quit && result["status"] == "closed" {
        window
            .close()
            .map_err(|_| "window_unavailable".to_owned())?;
    }
    Ok(result)
}
#[tauri::command]
async fn storage_transition_pick_directory(
    window: WebviewWindow,
    app: tauri::AppHandle,
    kind: String,
) -> Result<Option<String>, String> {
    authorize(&window)?;
    if !matches!(kind.as_str(), "root" | "backup") {
        return Err("invalid_selection".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = sender.send(path);
    });
    let Some(path) = receiver
        .await
        .map_err(|_| "selection_cancelled".to_owned())?
    else {
        return Ok(None);
    };
    let path = path
        .into_path()
        .map_err(|_| "local_folder_required".to_owned())?;
    path.to_str()
        .map(|path| Some(path.to_owned()))
        .ok_or_else(|| "local_folder_required".to_owned())
}
pub(crate) fn run() {
    // This is before generate_context/path resolution/lease acquisition.
    // Windows/Linux and explicit no-default-feature builds cannot enter it.
    if !storage_identity_transition::enabled() {
        eprintln!("Persistent identity transition is unavailable in this build.");
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            storage_transition_request,
            storage_transition_pick_directory
        ])
        .setup(|app| {
            let profile = app.path().app_local_data_dir()?;
            let config = app.path().app_config_dir()?;
            app.manage(Arc::new(Service::new(profile, config)));
            WebviewWindowBuilder::new(
                app,
                "storage-transition",
                WebviewUrl::App("index.html?storage-transition=1".into()),
            )
            .title("Mogledge — storage identity confirmation")
            .inner_size(860.0, 760.0)
            .min_inner_size(420.0, 480.0)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny)
            .on_navigation(|url| {
                matches!(url.path(), "/" | "/index.html")
                    && url.query() == Some("storage-transition=1")
                    && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (matches!(url.scheme(), "http" | "https")
                            && url.host_str() == Some("tauri.localhost"))
                        || (cfg!(debug_assertions)
                            && url.scheme() == "http"
                            && url.host_str() == Some("127.0.0.1")
                            && url.port() == Some(1420)))
            })
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Unable to run storage transition confirmation");
}
