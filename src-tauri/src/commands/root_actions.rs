use crate::{ai_handoff::RootContext, core::Core, file_actions::RootAction};
use std::sync::Arc;
use tauri::{State, Webview};

#[tauri::command]
pub async fn perform_root_action(
    webview: Webview,
    core: State<'_, Arc<Core>>,
    context: RootContext,
    action: RootAction,
) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("この操作はアプリの確認画面だけで利用できます".into());
    }
    #[cfg(windows)]
    let owner = webview
        .window()
        .hwnd()
        .map_err(|_| "操作ウィンドウを確認できません")?
        .0 as usize;
    #[cfg(not(windows))]
    let owner = 0;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::file_actions::perform_root(&core, &context, action, |target| {
            #[cfg(feature = "e2e")]
            if let Some(result) = crate::os_actions::capture(target) {
                return result;
            }
            crate::os_actions::execute(target, owner)
        })
    })
    .await
    .map_err(|_| "ファイル操作に失敗しました".to_owned())?
}
