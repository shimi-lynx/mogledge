//! Only the trusted main UI can stage verified bytes and explicitly apply them.
use crate::updater_model::{self, Session, Snapshot};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State, WebviewWindow};

struct Runtime {
    session: Session,
    #[cfg(feature = "distribution-updater")]
    update: Option<tauri_plugin_updater::Update>,
    #[cfg(feature = "distribution-updater")]
    bytes: Option<Vec<u8>>,
    #[cfg(feature = "distribution-updater")]
    cancel: Option<Arc<tokio::sync::Notify>>,
}

pub struct UpdaterState(Arc<Mutex<Runtime>>);
impl Default for UpdaterState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Runtime {
            session: Session::new(String::new(), Some("selfBuild")),
            #[cfg(feature = "distribution-updater")]
            update: None,
            #[cfg(feature = "distribution-updater")]
            bytes: None,
            #[cfg(feature = "distribution-updater")]
            cancel: None,
        })))
    }
}

pub fn initialize(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let state = app.state::<UpdaterState>();
    let version = app.package_info().version.to_string();
    #[allow(unused_mut)]
    let mut reason = Some("selfBuild");
    #[cfg(feature = "distribution-updater")]
    {
        // Enrolment is a build decision, not a user preference or environment toggle.
        if !cfg!(debug_assertions) && !cfg!(feature = "e2e") {
            reason = Some("unconfigured");
            if !cfg!(any(windows, target_os = "macos")) {
                reason = Some("unsupported");
            } else if let Some(value) = app.config().plugins.0.get("updater") {
                if updater_model::secure_config(value)
                    && option_env!("MOGLEDGE_SIGNED_UPDATE_BUILD") == Some("true")
                    && serde_json::from_value::<tauri_plugin_updater::Config>(value.clone()).is_ok()
                {
                    reason = if installed_app() {
                        None
                    } else {
                        Some("appOnly")
                    };
                }
            }
        }
        if reason.is_none() {
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
        }
    }
    state.0.lock().map_err(|_| "UpdateUnavailable")?.session = Session::new(version, reason);
    Ok(())
}

#[cfg(feature = "distribution-updater")]
fn installed_app() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    #[cfg(windows)]
    // The current Windows channel is NSIS. App-only EXEs are not enrolled.
    return exe
        .parent()
        .is_some_and(|parent| parent.join("uninstall.exe").is_file());
    #[cfg(target_os = "macos")]
    return exe.parent().is_some_and(|parent| {
        parent.file_name().is_some_and(|name| name == "MacOS")
            && parent.parent().is_some_and(|contents| {
                contents.file_name().is_some_and(|name| name == "Contents")
                    && contents
                        .parent()
                        .is_some_and(|bundle| bundle.extension().is_some_and(|ext| ext == "app"))
            })
    });
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = exe;
        false
    }
}

fn snapshot(state: &UpdaterState) -> Result<Snapshot, String> {
    Ok(state
        .0
        .lock()
        .map_err(|_| "UpdateUnavailable")?
        .session
        .snapshot
        .clone())
}

#[tauri::command]
pub fn get_app_update_status(
    window: WebviewWindow,
    state: State<'_, UpdaterState>,
) -> Result<Snapshot, String> {
    updater_model::main_host(window.label())?;
    snapshot(&state)
}

#[tauri::command]
pub async fn check_app_update(
    window: WebviewWindow,
    state: State<'_, UpdaterState>,
) -> Result<Snapshot, String> {
    updater_model::main_host(window.label())?;
    #[cfg(feature = "distribution-updater")]
    return native::check(window.app_handle().clone(), state.0.clone()).await;
    #[cfg(not(feature = "distribution-updater"))]
    {
        let _ = state;
        Err("UpdateDisabled".into())
    }
}

#[tauri::command]
pub async fn download_app_update(
    window: WebviewWindow,
    state: State<'_, UpdaterState>,
) -> Result<Snapshot, String> {
    updater_model::main_host(window.label())?;
    #[cfg(feature = "distribution-updater")]
    return native::download(window.app_handle().clone(), state.0.clone()).await;
    #[cfg(not(feature = "distribution-updater"))]
    {
        let _ = state;
        Err("UpdateDisabled".into())
    }
}

#[tauri::command]
pub fn cancel_app_update(
    window: WebviewWindow,
    state: State<'_, UpdaterState>,
) -> Result<Snapshot, String> {
    updater_model::main_host(window.label())?;
    let mut runtime = state.0.lock().map_err(|_| "UpdateUnavailable")?;
    runtime.session.cancel()?;
    #[cfg(feature = "distribution-updater")]
    {
        if let Some(cancel) = runtime.cancel.take() {
            cancel.notify_one();
        }
        runtime.update = None;
        runtime.bytes = None;
        native::publish(window.app_handle(), &runtime);
    }
    Ok(runtime.session.snapshot.clone())
}

#[tauri::command]
pub async fn restart_app_update(
    window: WebviewWindow,
    state: State<'_, UpdaterState>,
    core: State<'_, Arc<crate::core::Core>>,
) -> Result<Snapshot, String> {
    updater_model::main_host(window.label())?;
    #[cfg(feature = "distribution-updater")]
    return native::install(
        window.app_handle().clone(),
        state.0.clone(),
        core.inner().clone(),
    )
    .await;
    #[cfg(not(feature = "distribution-updater"))]
    {
        let _ = (state, core);
        Err("UpdateDisabled".into())
    }
}

#[cfg(feature = "distribution-updater")]
mod native {
    use super::*;
    use crate::updater_model::{Phase, Release};
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter};
    use tauri_plugin_updater::{Error, UpdaterExt};

    const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

    pub(super) fn publish(app: &AppHandle, runtime: &Runtime) {
        let _ = app.emit_to("main", "app-update-status", &runtime.session.snapshot);
    }

    fn diagnostic(error: Error, downloading: bool) -> &'static str {
        match error {
            Error::Minisign(_)
            | Error::Base64(_)
            | Error::SignatureUtf8(_)
            | Error::SignedVersionMismatch { .. }
            | Error::MissingSignedVersion => "UpdateSignatureInvalid",
            _ if downloading => "UpdateDownloadFailed",
            _ => "UpdateCheckFailed",
        }
    }

    pub(super) async fn check(
        app: AppHandle,
        state: Arc<Mutex<Runtime>>,
    ) -> Result<Snapshot, String> {
        let (id, cancel) = {
            let mut r = state.lock().map_err(|_| "UpdateUnavailable")?;
            let id = r.session.check()?;
            r.update = None;
            r.bytes = None;
            let cancel = Arc::new(tokio::sync::Notify::new());
            r.cancel = Some(cancel.clone());
            publish(&app, &r);
            (id, cancel)
        };
        let result = async {
            app.updater_builder()
                .timeout(Duration::from_secs(30))
                // Includes redirects and artifact downloads; never accept a TLS downgrade.
                .configure_client(|client| client.https_only(true))
                .build()?
                .check()
                .await
        };
        let result = tokio::select! { biased; _ = cancel.notified() => None, result = result => Some(result) };
        let mut r = state.lock().map_err(|_| "UpdateUnavailable")?;
        if r.session.is_active(id, Phase::Checking) {
            r.cancel = None;
            if let Some(result) = result {
                match result {
                    Ok(mut update) => {
                        if let Some(update) = &mut update {
                            // The plugin's check timeout is not inherited by its download object.
                            update.timeout = Some(Duration::from_secs(300));
                        }
                        let release = update.as_ref().map(|u| Release {
                            version: u.version.clone(),
                            notes: u
                                .body
                                .as_deref()
                                .unwrap_or_default()
                                .chars()
                                .take(65536)
                                .collect(),
                        });
                        r.session.checked(id, release);
                        r.update = update;
                    }
                    Err(error) => {
                        r.session.failed(id, diagnostic(error, false));
                    }
                }
            }
            publish(&app, &r);
        }
        Ok(r.session.snapshot.clone())
    }

    pub(super) async fn download(
        app: AppHandle,
        state: Arc<Mutex<Runtime>>,
    ) -> Result<Snapshot, String> {
        let (id, cancel, update) = {
            let mut r = state.lock().map_err(|_| "UpdateUnavailable")?;
            let update = r.update.clone().ok_or("UpdateNotAvailable")?;
            let id = r.session.download()?;
            let cancel = Arc::new(tokio::sync::Notify::new());
            r.cancel = Some(cancel.clone());
            publish(&app, &r);
            (id, cancel, update)
        };
        let mut last_progress = Instant::now();
        let result = update.download(
            |chunk, total| {
                if let Ok(mut r) = state.lock() {
                    if r.session.progress(id, chunk as u64, total) {
                        if r.session.snapshot.downloaded_bytes > MAX_DOWNLOAD_BYTES
                            || total.is_some_and(|n| n > MAX_DOWNLOAD_BYTES)
                        {
                            r.session.failed(id, "UpdateTooLarge");
                            cancel.notify_one();
                            publish(&app, &r);
                        } else if last_progress.elapsed() >= Duration::from_millis(100) {
                            publish(&app, &r);
                            last_progress = Instant::now();
                        }
                    }
                }
            },
            || {},
        );
        let result = tokio::select! { biased; _ = cancel.notified() => None, result = result => Some(result) };
        let mut r = state.lock().map_err(|_| "UpdateUnavailable")?;
        if r.session.is_active(id, Phase::Downloading) {
            r.cancel = None;
            if let Some(result) = result {
                match result {
                    Ok(bytes) if bytes.len() as u64 <= MAX_DOWNLOAD_BYTES => {
                        // download() returns only after the plugin's signature/version verification.
                        r.bytes = Some(bytes);
                        r.session.downloaded(id);
                    }
                    Ok(_) => {
                        r.session.failed(id, "UpdateTooLarge");
                        r.update = None;
                    }
                    Err(error) => {
                        r.session.failed(id, diagnostic(error, true));
                        r.update = None;
                    }
                }
            }
            publish(&app, &r);
        }
        Ok(r.session.snapshot.clone())
    }

    pub(super) async fn install(
        app: AppHandle,
        state: Arc<Mutex<Runtime>>,
        core: Arc<crate::core::Core>,
    ) -> Result<Snapshot, String> {
        let (id, update, bytes) = {
            let mut r = state.lock().map_err(|_| "UpdateUnavailable")?;
            if r.bytes.is_none() || r.update.is_none() {
                return Err("UpdateNotReady".into());
            }
            let id = r.session.install()?;
            let update = r.update.take().ok_or("UpdateNotReady")?;
            let bytes = r.bytes.take().ok_or("UpdateNotReady")?;
            publish(&app, &r);
            (id, update, bytes)
        };
        let result = tauri::async_runtime::spawn_blocking(move || {
            // Windows install exits directly; flush the host's pending settings first.
            // The update action warns that arbitrary HTML inputs need their own save operation.
            crate::workspace_settings::flush(&core).map_err(|_| "UpdateSaveFailed")?;
            update
                .restart_after_install(true)
                .install(bytes)
                .map_err(|_| "UpdateInstallFailed")
        })
        .await
        .map_err(|_| "UpdateInstallFailed")
        .and_then(|result| result);
        if let Err(error) = result {
            let mut r = state.lock().map_err(|_| "UpdateUnavailable")?;
            r.session.failed(id, error);
            publish(&app, &r);
            return Ok(r.session.snapshot.clone());
        }
        // Windows hands relaunch to NSIS; on macOS applying the bundle needs relaunch.
        app.restart();
    }
}

#[cfg(test)]
mod build_enrollment_tests {
    #[test]
    fn enrollment_retains_the_selected_build_decision_after_codegen() {
        let base = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let selected = crate::updater_build_config::signed_artifacts_enabled(
            base,
            option_env!("TAURI_CONFIG"),
        )
        .unwrap();
        assert_eq!(
            option_env!("MOGLEDGE_SIGNED_UPDATE_BUILD"),
            Some(if selected { "true" } else { "false" })
        );
        // The pinned Tauri version intentionally drops bundle-only settings.
        let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
        assert_eq!(
            context.config().bundle.create_updater_artifacts,
            tauri::utils::config::Updater::Bool(false)
        );
    }
}
