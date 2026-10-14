use crate::{
    core::Core,
    workspace_settings::{self, DocumentRef, ListSnapshot},
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn get_workspace_lists(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    resolve_moves: bool,
) -> Result<ListSnapshot, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace_settings::get(&core, &workspace_id, &view_id, resolve_moves)
    })
    .await
    .map_err(|_| "端末設定を読み取れません".to_owned())?
}
#[tauri::command]
pub async fn set_document_favorite(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    relative_path: String,
    add: bool,
) -> Result<ListSnapshot, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace_settings::favorite(&core, &workspace_id, &view_id, &relative_path, add)
    })
    .await
    .map_err(|_| "お気に入りを保存できません".to_owned())?
}
#[tauri::command]
pub async fn validate_workspace_document(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    document: DocumentRef,
    tab_id: Option<String>,
) -> Result<String, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace_settings::validate_tab(
            &core,
            &workspace_id,
            &view_id,
            &document,
            tab_id.as_deref(),
        )
    })
    .await
    .map_err(|_| "文書を確認できません".to_owned())?
}
#[tauri::command]
pub async fn validate_workspace_folder(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    folder: DocumentRef,
) -> Result<String, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace_settings::validate_folder(&core, &workspace_id, &view_id, &folder)
    })
    .await
    .map_err(|_| "フォルダーを確認できません".to_owned())?
}
#[tauri::command]
pub async fn record_document_display(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    tab_id: String,
    source_url: String,
) -> Result<(), String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace_settings::seen(&core, &workspace_id, &view_id, &tab_id, &source_url)
    })
    .await
    .map_err(|_| "最近の文書を保存できません".to_owned())?
}

#[tauri::command]
pub async fn get_workspace_sets(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
) -> Result<workspace_settings::SetSnapshot, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace_settings::get_sets(&core, &workspace_id, &view_id)
    })
    .await
    .map_err(|_| "作業セットを読み取れません".to_owned())?
}
#[tauri::command]
pub async fn capture_workspace_set(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    name: String,
    items: Vec<workspace_settings::CaptureItem>,
    active: [Option<usize>; 2],
    active_column: u8,
) -> Result<workspace_settings::SetSnapshot, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace_settings::capture_set(
            &core,
            &workspace_id,
            &view_id,
            name,
            items,
            active,
            active_column,
        )
    })
    .await
    .map_err(|_| "作業セットを保存できません".to_owned())?
}
#[tauri::command]
pub async fn edit_workspace_set(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    id: String,
    name: Option<String>,
) -> Result<workspace_settings::SetSnapshot, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace_settings::edit_set(&core, &workspace_id, &view_id, &id, name)
    })
    .await
    .map_err(|_| "作業セットを変更できません".to_owned())?
}
#[tauri::command]
pub async fn assign_workspace_set_shortcut(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    id: String,
    slot: Option<u8>,
) -> Result<workspace_settings::SetSnapshot, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace_settings::assign_set_shortcut(&core, &workspace_id, &view_id, &id, slot)
    })
    .await
    .map_err(|_| "作業セットを保存できません".to_owned())?
}
#[tauri::command]
pub async fn resolve_workspace_set(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    id: String,
    shortcut_slot: Option<u8>,
) -> Result<workspace_settings::ResolvedSet, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace_settings::resolve_set(&core, &workspace_id, &view_id, &id, shortcut_slot)
    })
    .await
    .map_err(|_| "作業セットを確認できません".to_owned())?
}

#[tauri::command]
pub async fn get_tab_session(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
) -> Result<Option<workspace_settings::TabSession>, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace_settings::get_session(&core, &workspace_id, &view_id)
    })
    .await
    .map_err(|_| "TabSessionReadFailed".to_owned())?
}
#[tauri::command]
pub async fn capture_tab_session(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    session: workspace_settings::SessionCapture,
) -> Result<(), String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        workspace_settings::capture_session(&core, &workspace_id, &view_id, session)
    })
    .await
    .map_err(|_| "TabSessionSaveFailed".to_owned())?
}
