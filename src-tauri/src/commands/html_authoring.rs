use crate::{
    core::Core,
    html_authoring::{self, Context, Installed, Preview, Status},
};
use std::sync::Arc;
use tauri::{State, Webview};
fn require_main(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("この操作はアプリの設定画面だけで利用できます".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn get_html_authoring_status(
    webview: Webview,
    core: State<'_, Arc<Core>>,
    context: Context,
) -> Result<Status, String> {
    require_main(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || html_authoring::get_status(&core, &context))
        .await
        .map_err(|_| "制作支援設定を確認できません".to_owned())?
}
#[tauri::command]
pub async fn preview_html_authoring_kit(
    webview: Webview,
    core: State<'_, Arc<Core>>,
    context: Context,
) -> Result<Preview, String> {
    require_main(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || html_authoring::preview(&core, &context))
        .await
        .map_err(|_| "制作キットの配置内容を確認できません".to_owned())?
}
#[tauri::command]
pub async fn cancel_html_authoring_kit(
    webview: Webview,
    core: State<'_, Arc<Core>>,
    context: Context,
    plan_id: String,
) -> Result<(), String> {
    require_main(&webview)?;
    html_authoring::cancel(&core, &context, &plan_id);
    Ok(())
}
#[tauri::command]
pub async fn install_html_authoring_kit(
    webview: Webview,
    core: State<'_, Arc<Core>>,
    context: Context,
    plan_id: String,
) -> Result<Installed, String> {
    require_main(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || html_authoring::install(&core, &context, &plan_id))
        .await
        .map_err(|_| "制作キットを配置できません".to_owned())?
}
#[tauri::command]
pub async fn set_html_authoring_enabled(
    webview: Webview,
    core: State<'_, Arc<Core>>,
    context: Context,
    preference_hash: Option<String>,
    enabled: bool,
) -> Result<Status, String> {
    require_main(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        html_authoring::set_enabled(&core, &context, preference_hash.as_deref(), enabled)
    })
    .await
    .map_err(|_| "制作ガイド設定を保存できません".to_owned())?
}
