//! Profile-wide quota changes belong only to the bundled main host.
use crate::{
    core::Core,
    state_inspection::live::Context,
    storage_limits::{self, LimitsError, SetRequest, Snapshot},
};
use std::sync::Arc;
use tauri::State;

fn main_host(webview: &tauri::Webview) -> Result<(), LimitsError> {
    storage_limits::check_main_host(webview.label())
}
#[tauri::command]
pub async fn get_storage_limits(
    webview: tauri::Webview,
    core: State<'_, Arc<Core>>,
    context: Context,
) -> Result<Snapshot, LimitsError> {
    main_host(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || storage_limits::get(&core, &context))
        .await
        .map_err(|_| storage_limits::failure("state_unavailable"))?
}
#[tauri::command]
pub async fn set_storage_limits(
    webview: tauri::Webview,
    core: State<'_, Arc<Core>>,
    request: SetRequest,
) -> Result<Snapshot, LimitsError> {
    main_host(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || storage_limits::set(&core, &request))
        .await
        .map_err(|_| storage_limits::failure("state_unavailable"))?
}
