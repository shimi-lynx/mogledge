//! Keep the main renderer alive for one bounded layout flush before controlled exit.
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::oneshot;

#[derive(Default)]
pub struct ExitState {
    pending: Mutex<Option<(String, oneshot::Sender<bool>)>>,
    busy: AtomicBool,
    allowed: AtomicBool,
}
pub fn allowed(app: &AppHandle) -> bool {
    app.state::<ExitState>().allowed.load(Ordering::Acquire)
}
pub fn allow_exit(app: &AppHandle) {
    crate::resident::prepare_exit(app);
    app.state::<ExitState>()
        .allowed
        .store(true, Ordering::Release);
}
pub async fn flush(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ExitState>();
    let request = crate::core::random_token();
    let (send, receive) = oneshot::channel();
    {
        let mut pending = state.pending.lock().map_err(|_| "TabSessionSaveFailed")?;
        if pending.is_some() {
            return Err("TabSessionSaveFailed".into());
        }
        *pending = Some((request.clone(), send));
    }
    let emitted = app.emit_to(
        "main",
        "tab-session-flush-request",
        serde_json::json!({ "request": request }),
    );
    let success = if emitted.is_ok() {
        matches!(
            tokio::time::timeout(std::time::Duration::from_secs(4), receive).await,
            Ok(Ok(true))
        )
    } else {
        false
    };
    let mut pending = state.pending.lock().map_err(|_| "TabSessionSaveFailed")?;
    if pending.as_ref().is_some_and(|(id, _)| id == &request) {
        pending.take();
    }
    if success {
        Ok(())
    } else {
        Err("TabSessionSaveFailed".into())
    }
}
#[tauri::command]
pub fn confirm_tab_session_flush(
    window: WebviewWindow,
    state: State<'_, ExitState>,
    request: String,
    success: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("TabSessionSaveFailed".into());
    }
    let mut pending = state.pending.lock().map_err(|_| "TabSessionSaveFailed")?;
    if pending.as_ref().is_none_or(|(id, _)| id != &request) {
        return Err("Superseded".into());
    }
    if let Some((_, send)) = pending.take() {
        let _ = send.send(success);
    }
    Ok(())
}
pub fn request_exit(app: &AppHandle, code: i32) {
    // Partial startup cannot service main IPC and has no admitted layout to flush.
    if !app.state::<crate::startup_profile::Runtime>().allows_ipc() {
        allow_exit(app);
        app.exit(code);
        return;
    }
    let state = app.state::<ExitState>();
    if state.busy.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if flush(&app).await.is_ok() {
            allow_exit(&app);
            app.exit(code);
        } else {
            // Never force termination or silently discard a layout on timeout/failure.
            app.state::<ExitState>()
                .busy
                .store(false, Ordering::Release);
            let _ = app.emit_to("main", "tab-session-flush-failed", ());
            crate::resident::restore(&app, false);
        }
    });
}
