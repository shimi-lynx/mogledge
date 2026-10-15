use crate::core::{Core, Snapshot};
pub(crate) mod ai_handoff;
pub(crate) mod artifact;
pub(crate) mod html_authoring;
pub(crate) mod links;
pub(crate) mod root_actions;
pub(crate) mod search;
pub(crate) mod workspace;

pub(crate) mod state_management;
pub(crate) mod storage_limits;
pub(crate) mod transfer;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn get_document_state_recovery(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    relative_path: String,
) -> Result<Option<crate::document_state::RecoveryCandidate>, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::document_state::recovery(&core, &workspace_id, &view_id, &relative_path, None)
    })
    .await
    .map_err(|_| "StorageUnavailable".to_owned())?
}

#[tauri::command]
pub async fn recover_document_state(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    relative_path: String,
    candidate: crate::document_state::RecoveryCandidate,
) -> Result<(), String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::document_state::recovery(
            &core,
            &workspace_id,
            &view_id,
            &relative_path,
            Some(&candidate),
        )
        .map(|_| ())
    })
    .await
    .map_err(|_| "StorageUnavailable".to_owned())?
}

#[tauri::command]
pub async fn mutate_tree(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    mutation: crate::tree_mutations::Mutation,
) -> Result<crate::tree_mutations::MutationResult, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::tree_mutations::perform(&core, &workspace_id, &view_id, mutation)
    })
    .await
    .map_err(|_| "ファイル操作に失敗しました".to_owned())?
}

#[tauri::command]
pub async fn choose_knowledge_root(
    webview: tauri::Webview,
    app: AppHandle,
    core: State<'_, Arc<Core>>,
) -> Result<Option<Snapshot>, String> {
    if webview.label() != "main" {
        return Err("この操作はアプリの設定画面からのみ利用できます".into());
    }
    let captured = core.snapshot();
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("登録フォルダを選択（保存の基準）")
        .pick_folder(move |file| {
            let _ = tx.send(file);
        });
    let Some(file) = rx.await.map_err(|_| "フォルダ選択が終了しました")? else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| "ローカルフォルダを選択してください")?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.select_if_current(
            captured.workspace_id.as_deref(),
            &captured.view_id,
            &path,
            true,
        )
    })
    .await
    .map_err(|_| "フォルダ選択処理に失敗しました".to_owned())?
    .map(Some)
}

#[tauri::command]
pub async fn choose_display_folder(
    webview: tauri::Webview,
    app: AppHandle,
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
) -> Result<Option<Snapshot>, String> {
    if webview.label() != "main" {
        return Err("この操作はアプリ画面からのみ利用できます".into());
    }
    let snapshot = core.snapshot();
    if snapshot.workspace_id.as_deref() != Some(&workspace_id) {
        return Err("WorkspaceChanged".into());
    }
    if snapshot.view_id != view_id {
        return Err("ViewChanged".into());
    }
    let root = snapshot.root_path.ok_or("RegisteredRootRequired")?;
    let initial = std::path::PathBuf::from(root).join(
        snapshot
            .display_folder
            .as_ref()
            .map_or("", |folder| folder.relative_path.as_str()),
    );
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("表示フォルダを選択（登録フォルダ内）")
        .set_directory(initial)
        .pick_folder(move |file| {
            let _ = tx.send(file);
        });
    let Some(file) = rx.await.map_err(|_| "フォルダ選択が終了しました")? else {
        return Ok(None);
    };
    let path = file
        .into_path()
        .map_err(|_| "ローカルフォルダを選択してください")?;
    let core = core.inner().clone();
    // Recheck the captured workspace after the asynchronous picker returns.
    tauri::async_runtime::spawn_blocking(move || {
        core.select_display_path_if_current(
            &workspace_id,
            &view_id,
            snapshot.display_revision,
            &path,
            true,
        )
    })
    .await
    .map_err(|_| "表示フォルダを切り替えられません".to_owned())?
    .map(Some)
}

#[tauri::command]
pub async fn set_display_folder(
    webview: tauri::Webview,
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    relative_path: String,
    expected_display_revision: u64,
) -> Result<Snapshot, String> {
    if webview.label() != "main" {
        return Err("この操作はアプリ画面からのみ利用できます".into());
    }
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.select_display_folder_if_current(
            &workspace_id,
            &view_id,
            expected_display_revision,
            &relative_path,
            true,
        )
    })
    .await
    .map_err(|_| "表示フォルダを切り替えられません".to_owned())?
}
#[tauri::command]
pub async fn get_document_storage_hold(
    webview: tauri::Webview,
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    tab_id: String,
    request_id: u64,
) -> Result<Option<crate::core::StorageHold>, String> {
    if webview.label() != "main" {
        return Err("この操作はアプリ画面からのみ利用できます".into());
    }
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.document_storage_hold(&workspace_id, &view_id, &tab_id, request_id)
    })
    .await
    .map_err(|_| "StorageUnavailable".to_owned())?
}

#[tauri::command]
pub fn get_knowledge_tree(core: State<'_, Arc<Core>>) -> Snapshot {
    core.snapshot()
}
#[tauri::command]
pub fn get_asset_usage(core: State<'_, Arc<Core>>) -> crate::document_server::admission::Report {
    core.asset_admission.report()
}
#[tauri::command]
pub async fn open_document(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    tab_id: String,
    request_id: u64,
) -> Result<String, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.open(&workspace_id, &view_id, &tab_id, request_id)
    })
    .await
    .map_err(|_| "文書を開けません".to_owned())?
}
#[tauri::command]
pub async fn retry_saved_root(
    webview: tauri::Webview,
    core: State<'_, Arc<Core>>,
    view_id: String,
) -> Result<Snapshot, String> {
    if webview.label() != "main" {
        return Err("この操作はアプリの確認画面だけで利用できます".into());
    }
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.retry_saved_root(&view_id))
        .await
        .map_err(|_| "作業フォルダーを確認できません".to_owned())?
}

#[tauri::command]
pub async fn refresh_knowledge(core: State<'_, Arc<Core>>) -> Result<Snapshot, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.refresh())
        .await
        .map_err(|_| "再走査に失敗しました".to_owned())?
}

#[tauri::command]
pub async fn begin_document_view(core: State<'_, Arc<Core>>) -> Result<Snapshot, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.begin_view())
        .await
        .map_err(|_| "画面を開始できません".to_owned())
}
#[tauri::command]
pub async fn create_document_tab(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    relative_path: String,
    expected_identity: Option<String>,
) -> Result<String, String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        core.create_tab_checked(&workspace_id, &view_id, &relative_path, expected_identity)
    })
    .await
    .map_err(|_| "タブを登録できません".to_owned())?
}
#[tauri::command]
pub async fn close_document_tab(
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    tab_id: String,
) -> Result<(), String> {
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || core.close_tab(&workspace_id, &view_id, &tab_id))
        .await
        .map_err(|_| "タブを閉じられません".to_owned())?
}

#[tauri::command]
pub async fn perform_file_action(
    app: AppHandle,
    core: State<'_, Arc<Core>>,
    workspace_id: String,
    view_id: String,
    relative_path: String,
    action: crate::file_actions::FileAction,
) -> Result<(), String> {
    #[cfg(windows)]
    let owner = {
        use tauri::Manager;
        app.get_webview_window("main")
            .ok_or("操作ウィンドウがありません")?
            .hwnd()
            .map_err(|_| "操作ウィンドウを確認できません")?
            .0 as usize
    };
    #[cfg(not(windows))]
    let owner = {
        let _ = app;
        0
    };
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::file_actions::perform(
            &core,
            &workspace_id,
            &view_id,
            &relative_path,
            action,
            |target| {
                #[cfg(feature = "e2e")]
                if let Some(result) = crate::os_actions::capture(target) {
                    return result;
                }
                crate::os_actions::execute(target, owner)
            },
        )
    })
    .await
    .map_err(|_| "ファイル操作に失敗しました".to_owned())?
}
