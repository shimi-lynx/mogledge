use crate::{
    core::{Core, Snapshot},
    document_identity,
    managed_folders::{self, ManagedFolders},
};
use std::sync::Arc;
use tauri::{AppHandle, State, Webview};
use tauri_plugin_dialog::DialogExt;
fn main_only(webview: &Webview) -> Result<(), String> {
    if webview.label() == "main" {
        Ok(())
    } else {
        Err("この操作はアプリ画面だけで利用できます".into())
    }
}
#[tauri::command]
pub async fn get_managed_folders(
    webview: Webview,
    core: State<'_, Arc<Core>>,
) -> Result<ManagedFolders, String> {
    main_only(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || managed_folders::list(&core))
        .await
        .map_err(|_| "一覧を読み取れません".to_owned())?
}
async fn pick(
    app: AppHandle,
    core: Arc<Core>,
    name: Option<String>,
    expected_revision: String,
) -> Result<Option<ManagedFolders>, String> {
    if managed_folders::list(&core)?.revision != expected_revision {
        return Err("一覧が変更されました。開き直してください".into());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(if name.is_some() {
            "専用フォルダーを作成する場所"
        } else {
            "専用フォルダーとして登録"
        })
        .pick_folder(move |file| {
            let _ = tx.send(file);
        });
    let Some(file) = rx.await.map_err(|_| "フォルダー選択を完了できません")? else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| "ローカルフォルダーを選択してください")?;
    tauri::async_runtime::spawn_blocking(move || {
        managed_folders::register(&core, &path, name.as_deref(), &expected_revision).map(Some)
    })
    .await
    .map_err(|_| "登録を完了できません".to_owned())?
}
#[tauri::command]
pub async fn create_managed_folder(
    webview: Webview,
    app: AppHandle,
    core: State<'_, Arc<Core>>,
    name: String,
    expected_revision: String,
) -> Result<Option<ManagedFolders>, String> {
    main_only(&webview)?;
    pick(app, core.inner().clone(), Some(name), expected_revision).await
}
#[tauri::command]
pub async fn register_managed_folder(
    webview: Webview,
    app: AppHandle,
    core: State<'_, Arc<Core>>,
    expected_revision: String,
) -> Result<Option<ManagedFolders>, String> {
    main_only(&webview)?;
    pick(app, core.inner().clone(), None, expected_revision).await
}
#[tauri::command]
pub async fn select_managed_folder(
    webview: Webview,
    core: State<'_, Arc<Core>>,
    id: String,
    expected_revision: String,
) -> Result<Snapshot, String> {
    main_only(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        managed_folders::select(&core, &id, &expected_revision)
    })
    .await
    .map_err(|_| "専用フォルダーを選択できません".to_owned())?
}
#[tauri::command]
pub async fn unregister_managed_folder(
    webview: Webview,
    core: State<'_, Arc<Core>>,
    id: String,
    expected_revision: String,
) -> Result<ManagedFolders, String> {
    main_only(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        managed_folders::unregister(&core, &id, &expected_revision)
    })
    .await
    .map_err(|_| "登録解除を完了できません".to_owned())?
}
#[tauri::command]
pub async fn get_document_identity_status(
    webview: Webview,
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    relative_path: String,
) -> Result<document_identity::Status, String> {
    main_only(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        document_identity::status(&core, &workspace_id, &view_id, &relative_path)
    })
    .await
    .map_err(|_| "文書IDを確認できません".to_owned())?
}
#[tauri::command]
pub async fn configure_document_identity(
    webview: Webview,
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    relative_path: String,
    action: String,
    source_identity: Option<String>,
) -> Result<(), String> {
    main_only(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        document_identity::configure(
            &core,
            &workspace_id,
            &view_id,
            &relative_path,
            &action,
            source_identity.as_deref(),
        )
    })
    .await
    .map_err(|_| "文書IDの変更を完了できません".to_owned())?
}
