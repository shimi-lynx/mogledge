use crate::{ai_handoff, core::Core};
use std::sync::Arc;
use tauri::{State, Webview};

fn require_main(webview: &Webview) -> Result<(), String> {
    if webview.label() != "main" {
        return Err("この操作はアプリの確認画面だけで利用できます".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn prepare_ai_handoff(
    webview: Webview,
    core: State<'_, Arc<Core>>,
    context: ai_handoff::Context,
) -> Result<ai_handoff::Preview, String> {
    require_main(&webview)?;
    let core = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || ai_handoff::prepare(&core, &context))
        .await
        .map_err(|_| "対象を確認できません".to_owned())?
}

#[tauri::command]
pub async fn perform_ai_handoff(
    webview: Webview,
    core: State<'_, Arc<Core>>,
    request: ai_handoff::Request,
) -> Result<(), String> {
    require_main(&webview)?;
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
        ai_handoff::perform(&core, &request, |target| {
            #[cfg(feature = "e2e")]
            if let Some(result) = crate::os_actions::capture(target) {
                return result;
            }
            crate::os_actions::execute(target, owner)
        })
    })
    .await
    .map_err(|_| "受け渡しに失敗しました".to_owned())?
}
