use crate::{
    core::Core,
    document_links::{self, LinkTarget},
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn resolve_document_link(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    source_url: String,
    href: String,
) -> Result<LinkTarget, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        document_links::resolve(&core, &workspace_id, &view_id, &source_url, &href)
    })
    .await
    .map_err(|_| "リンクを確認できません".to_owned())?
}

#[tauri::command]
pub async fn open_external_document_link(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    source_url: String,
    href: String,
) -> Result<(), String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        document_links::open_external(
            &core,
            &workspace_id,
            &view_id,
            &source_url,
            &href,
            |target| {
                #[cfg(feature = "e2e")]
                if let Some(result) = crate::os_actions::capture(target) {
                    return result;
                }
                crate::os_actions::execute(target, 0)
            },
        )
    })
    .await
    .map_err(|_| "外部リンクを開けません".to_owned())?
}

#[tauri::command]
pub async fn validate_document_navigation(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    relative_path: String,
    fragment: String,
    tab_id: Option<String>,
) -> Result<crate::workspace_settings::DocumentRef, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        document_links::validate_navigation(
            &core,
            &workspace_id,
            &view_id,
            &relative_path,
            &fragment,
            tab_id.as_deref(),
        )
    })
    .await
    .map_err(|_| "履歴を確認できません".to_owned())?
}
