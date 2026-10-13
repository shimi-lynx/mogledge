use crate::{
    core::Core,
    index::{self, IndexStatus, SearchMode, SearchPage},
};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn get_index_status(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
) -> Result<IndexStatus, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || index::api::status(&core, &workspace_id))
        .await
        .map_err(|_| "索引状態を取得できません".to_string())?
}
#[tauri::command]
pub async fn search_documents(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    query: String,
    limit: u32,
    offset: u32,
    mode: Option<SearchMode>,
    scope: Option<index::api::SearchScope>,
) -> Result<SearchPage, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        index::api::search_with_scope(
            &core,
            &workspace_id,
            &query,
            limit,
            offset,
            mode.unwrap_or_default(),
            scope.as_ref(),
        )
    })
    .await
    .map_err(|_| "検索処理に失敗しました".to_string())?
}
#[tauri::command]
pub async fn rebuild_search_index(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
) -> Result<IndexStatus, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || index::api::rebuild(&core, &workspace_id))
        .await
        .map_err(|_| "索引を再構築できません".to_string())?
}
