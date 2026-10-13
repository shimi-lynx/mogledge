//! Bundled main-host commands only. Portable paths originate in Native dialogs;
//! document tokens never acquire these capabilities.
use crate::{
    core::Core,
    state_transfer::{live, TransferError},
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn choose_state_transfer_file(
    app: AppHandle,
    core: State<'_, Arc<Core>>,
    context: live::Context,
    kind: live::FileKind,
) -> Result<Option<Value>, TransferError> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let dialog = app
        .dialog()
        .file()
        .add_filter("Saved inputs JSON", &["json"]);
    if kind == live::FileKind::Import {
        dialog.pick_file(move |file| {
            let _ = send.send(file);
        });
    } else {
        dialog.save_file(move |file| {
            let _ = send.send(file);
        });
    }
    let Some(file) = receive
        .await
        .map_err(|_| crate::state_transfer::failure("selection_cancelled"))?
    else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| crate::state_transfer::failure("local_file_required"))?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || live::select_file(&core, context, kind, &path))
        .await
        .map_err(|_| crate::state_transfer::failure("state_unavailable"))?
        .map(Some)
}

#[tauri::command]
pub async fn prepare_state_transfer(
    core: State<'_, Arc<Core>>,
    request: live::PrepareRequest,
) -> Result<Value, TransferError> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || live::prepare(&core, request))
        .await
        .map_err(|_| crate::state_transfer::failure("state_unavailable"))?
}
#[tauri::command]
pub async fn confirm_state_transfer(
    core: State<'_, Arc<Core>>,
    confirmation: live::Confirmation,
) -> Result<Value, TransferError> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || live::confirm(&core, confirmation))
        .await
        .map_err(|_| crate::state_transfer::failure("state_unavailable"))?
}
#[tauri::command]
pub async fn cancel_state_transfer(
    core: State<'_, Arc<Core>>,
    context: live::Context,
    plan_id: String,
) -> Result<Value, TransferError> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || live::cancel(&core, &context, &plan_id))
        .await
        .map_err(|_| crate::state_transfer::failure("state_unavailable"))?
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Verification {
    Operation {
        context: live::Context,
        #[serde(rename = "planId")]
        plan_id: String,
    },
    Import {
        context: live::Context,
        #[serde(rename = "relativePath")]
        relative_path: String,
        #[serde(rename = "documentIdentity")]
        document_identity: String,
        #[serde(rename = "fileId")]
        file_id: String,
    },
}
#[tauri::command]
pub async fn verify_state_transfer(
    core: State<'_, Arc<Core>>,
    request: Verification,
) -> Result<Value, TransferError> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || match request {
        Verification::Operation { context, plan_id } => {
            live::verify_operation(&core, &context, &plan_id)
        }
        Verification::Import {
            context,
            relative_path,
            document_identity,
            file_id,
        } => live::verify_import(
            &core,
            &context,
            &relative_path,
            &document_identity,
            &file_id,
        ),
    })
    .await
    .map_err(|_| crate::state_transfer::failure("state_unavailable"))?
}
