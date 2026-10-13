//! Management is available only to the local bundled main host, never HTML.
use crate::{
    core::Core,
    state_inspection::{live, InspectionError},
};
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

fn main_host(webview: &tauri::Webview) -> Result<(), InspectionError> {
    if webview.label() != "main" {
        return Err(live::fail("main_host_required"));
    }
    Ok(())
}
#[tauri::command]
pub async fn inspect_saved_state(
    webview: tauri::Webview,
    core: State<'_, Arc<Core>>,
    request: live::PageRequest,
) -> Result<Value, InspectionError> {
    main_host(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || live::inspect(&core, request, false))
        .await
        .map_err(|_| live::fail("state_unavailable"))?
}
#[tauri::command]
pub async fn list_saved_state_recovery(
    webview: tauri::Webview,
    core: State<'_, Arc<Core>>,
    request: live::PageRequest,
) -> Result<Value, InspectionError> {
    main_host(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || live::inspect(&core, request, true))
        .await
        .map_err(|_| live::fail("state_unavailable"))?
}
#[tauri::command]
pub async fn prepare_saved_state_management(
    webview: tauri::Webview,
    core: State<'_, Arc<Core>>,
    request: live::PrepareRequest,
) -> Result<Value, InspectionError> {
    main_host(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || live::prepare(&core, request))
        .await
        .map_err(|_| live::fail("state_unavailable"))?
}
#[tauri::command]
pub async fn confirm_saved_state_management(
    webview: tauri::Webview,
    core: State<'_, Arc<Core>>,
    confirmation: live::Confirmation,
) -> Result<Value, InspectionError> {
    main_host(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || live::confirm(&core, confirmation))
        .await
        .map_err(|_| live::fail("state_unavailable"))?
}
#[tauri::command]
pub async fn cancel_saved_state_management(
    webview: tauri::Webview,
    core: State<'_, Arc<Core>>,
    context: live::Context,
    plan_id: String,
) -> Result<Value, InspectionError> {
    main_host(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || live::cancel(&core, &context, &plan_id))
        .await
        .map_err(|_| live::fail("state_unavailable"))?
}
#[tauri::command]
pub async fn verify_saved_state_management(
    webview: tauri::Webview,
    core: State<'_, Arc<Core>>,
    context: live::Context,
    plan_id: String,
) -> Result<Value, InspectionError> {
    main_host(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || live::verify(&core, &context, &plan_id))
        .await
        .map_err(|_| live::fail("state_unavailable"))?
}
