use crate::{
    artifact_export::{self, Receipt, Request},
    core::Core,
};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State, Webview};
use tauri_plugin_dialog::DialogExt;

/// Only bundled main confirms a proposal. The OS picker is the authoritative
/// destination consent; neither document messages nor IPC accept a path.
#[tauri::command]
pub async fn save_html_artifact(
    webview: Webview,
    app: AppHandle,
    core: State<'_, Arc<Core>>,
    request: Request,
) -> Result<Receipt, String> {
    if webview.label() != "main" {
        return Err("ArtifactForbidden".into());
    }
    let prepare_core = core.inner().clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        artifact_export::prepare(&prepare_core, request)
    })
    .await
    .map_err(|_| "ArtifactUnavailable")??;
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Save generated file")
        .add_filter("Generated file", &[prepared.extension()])
        .set_file_name(&prepared.name);
    // The OS known-folder resolver handles localized/redirected Downloads.
    // No guessed username, literal Downloads path, creation or HTML path disclosure.
    if let Ok(downloads) = app.path().download_dir() {
        if crate::identifier_migration::directory(&downloads, false)
            .ok()
            .flatten()
            .is_some()
        {
            dialog = dialog.set_directory(downloads);
        }
    }
    let (send, receive) = tokio::sync::oneshot::channel();
    dialog.save_file(move |file| {
        let _ = send.send(file);
    });
    let selected = receive
        .await
        .map_err(|_| "ArtifactResultUnknown")?
        .map(|file| file.into_path().map_err(|_| "ArtifactDestinationInvalid"))
        .transpose()?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        artifact_export::finish(&core, prepared, selected.as_deref())
    })
    .await
    .map_err(|_| "ArtifactResultUnknown")?
}
