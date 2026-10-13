//! Native startup coordinator: no normal window or app IPC before a profile is ready.
use crate::{
    core::Core,
    document_state::DocumentState,
    identifier_migration::{
        self as migration, ActivePaths, Decision, Locations, PreparedProfile, Startup,
    },
    index::IndexService,
};
#[cfg(feature = "e2e")]
use serde::Deserialize;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
        Arc, OnceLock,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

const WAITING: u8 = 0;
const PREPARING: u8 = 1;
const INITIALIZING: u8 = 2;
const READY: u8 = 3;
const FAILED: u8 = 4;

#[derive(Clone)]
pub(crate) struct Runtime(Arc<RuntimeState>);
struct RuntimeState {
    mode: Mode,
    phase: AtomicU8,
    // Tauri/server may retain Core connections after run returns. The run owner
    // keeps this lease until process exit; partial initialization is terminal.
    lease: OnceLock<PreparedProfile>,
}
enum Mode {
    Product,
    ExistingQa,
    #[cfg(feature = "e2e")]
    MigrationQa {
        root: PathBuf,
        old: String,
        new: String,
        fail: Option<String>,
    },
}
#[cfg(feature = "e2e")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureMarker {
    schema_version: u32,
    root: PathBuf,
    token: String,
    old_identifier: String,
    new_identifier: String,
}
impl Runtime {
    pub(crate) fn configured(identifier: &str) -> Result<Self, String> {
        if identifier.eq_ignore_ascii_case(migration::LEGACY_IDENTIFIER)
            || (identifier.eq_ignore_ascii_case(migration::CURRENT_IDENTIFIER)
                && identifier != migration::CURRENT_IDENTIFIER)
        {
            return Err("この版は指定された正式識別子を使用できません".into());
        }
        let mode = if identifier == migration::CURRENT_IDENTIFIER {
            Mode::Product
        } else {
            Mode::ExistingQa
        };
        #[cfg(feature = "e2e")]
        let mode = {
            let root = std::env::var_os("MY_KNOWLEDGE_MIGRATION_QA_ROOT");
            let old = std::env::var("MY_KNOWLEDGE_MIGRATION_QA_OLD_ID").ok();
            let new = std::env::var("MY_KNOWLEDGE_MIGRATION_QA_NEW_ID").ok();
            let token = std::env::var("MY_KNOWLEDGE_MIGRATION_QA_TOKEN").ok();
            if root.is_some() || old.is_some() || new.is_some() || token.is_some() {
                let old = old.ok_or("専用QAの旧識別子が必要です")?;
                let new = new.ok_or("専用QAの新識別子が必要です")?;
                // Reject both formal IDs in either argument before any filesystem access.
                let formal = |id: &str| {
                    id.eq_ignore_ascii_case(migration::LEGACY_IDENTIFIER)
                        || id.eq_ignore_ascii_case(migration::CURRENT_IDENTIFIER)
                };
                if formal(&old)
                    || formal(&new)
                    || formal(identifier)
                    || identifier != new
                    || old.eq_ignore_ascii_case(&new)
                {
                    return Err("専用QAでは正式識別子を使用できません".into());
                }
                if std::env::var_os("MY_KNOWLEDGE_E2E_ROOT").is_some() {
                    return Err("移行QAは既存設定から復元します。bootstrapは使用できません".into());
                }
                let root = PathBuf::from(root.ok_or("専用QAの保存先が必要です")?);
                let token = token.ok_or("専用QAのfixture tokenが必要です")?;
                if !root.is_absolute()
                    || root.components().any(|part| {
                        matches!(
                            part,
                            std::path::Component::ParentDir | std::path::Component::CurDir
                        )
                    })
                    || token.is_empty()
                    || token.len() > 128
                    || !token
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                {
                    return Err("専用QAのfixture指定が不正です".into());
                }
                let workspace = std::env::current_dir()
                    .map_err(|_| "専用QAの作業先を確認できません")?
                    .join(".tools/identifier-native-qa");
                if !root.starts_with(std::env::temp_dir()) && !root.starts_with(workspace) {
                    return Err("専用QAは一時fixtureだけを使用します".into());
                }
                let (_, fixture_dir) = crate::knowledge::open_root(&root)
                    .map_err(|_| "専用QAの保存先が通常のfolderではありません")?;
                let bytes = migration::read_qa_marker(&fixture_dir)
                    .map_err(|_| "専用QA fixtureを安全に読めません")?;
                let marker: FixtureMarker =
                    serde_json::from_slice(&bytes).map_err(|_| "専用QA fixtureが不正です")?;
                if marker.root != root
                    || marker.schema_version != 1
                    || marker.token != token
                    || marker.old_identifier != old
                    || marker.new_identifier != new
                {
                    return Err("専用QA fixtureの識別が一致しません".into());
                }
                let fail = std::env::var("MY_KNOWLEDGE_MIGRATION_QA_FAIL").ok();
                if fail.as_deref().is_some_and(|value| {
                    !matches!(value, "settings-once" | "state-once" | "restore")
                }) {
                    return Err("未対応の専用QA障害指定です".into());
                }
                Mode::MigrationQa {
                    root,
                    old,
                    new,
                    fail,
                }
            } else {
                mode
            }
        };
        Ok(Self(Arc::new(RuntimeState {
            mode,
            phase: AtomicU8::new(WAITING),
            lease: OnceLock::new(),
        })))
    }
    fn set_phase(&self, phase: u8) {
        self.0.phase.store(phase, Ordering::Release);
        #[cfg(feature = "e2e")]
        if matches!(self.0.mode, Mode::MigrationQa { .. }) {
            eprintln!("MIGRATION_QA_PHASE={phase};IPC={}", self.allows_ipc());
        }
    }
    pub(crate) fn allows_ipc(&self) -> bool {
        self.0.phase.load(Ordering::Acquire) == READY
    }
    pub(crate) fn holds_process_lease(&self) -> bool {
        !matches!(self.0.mode, Mode::ExistingQa)
    }
    pub(crate) fn start(&self, app: AppHandle, core: Arc<Core>) -> Result<(), String> {
        if matches!(self.0.mode, Mode::ExistingQa) {
            let paths = ActivePaths {
                settings: app
                    .path()
                    .app_config_dir()
                    .map_err(|_| "設定保存先を取得できません")?
                    .join("settings.json"),
                document_state: app
                    .path()
                    .app_local_data_dir()
                    .map_err(|_| "文書保存先を取得できません")?
                    .join("document-state"),
                search_index: app
                    .path()
                    .app_local_data_dir()
                    .map_err(|_| "検索保存先を取得できません")?
                    .join("search-index"),
            };
            initialize(&app, &core, paths, false, None)?;
            crate::open_main_window(&app, core)?;
            self.set_phase(READY);
            return Ok(());
        }
        let locations = match &self.0.mode {
            Mode::Product => Locations::new(
                &app.path()
                    .config_dir()
                    .map_err(|_| "設定保存先を取得できません")?,
                &app.path()
                    .local_data_dir()
                    .map_err(|_| "保存先を取得できません")?,
                migration::LEGACY_IDENTIFIER,
                migration::CURRENT_IDENTIFIER,
            ),
            #[cfg(feature = "e2e")]
            Mode::MigrationQa { root, old, new, .. } => {
                Locations::new(&root.join("config"), &root.join("local"), old, new)
            }
            Mode::ExistingQa => unreachable!(),
        }
        .map_err(|error| error.message().to_owned())?;
        self.prepare(app, core, locations, Decision::Inspect);
        Ok(())
    }
    fn prepare(&self, app: AppHandle, core: Arc<Core>, locations: Locations, decision: Decision) {
        if self
            .0
            .phase
            .compare_exchange(WAITING, PREPARING, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            self.fail(
                app,
                "保存領域の初期化を再利用できません。終了して再起動してください。",
            );
            return;
        }
        let runtime = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            match migration::prepare(&locations, decision) {
                Ok(Startup::Ready(profile)) => runtime.ready(app, core, profile),
                Ok(Startup::NeedsConsent) => runtime.confirm(app, core, locations, true),
                Ok(Startup::Conflict) => runtime.confirm(app, core, locations, false),
                Ok(Startup::ConflictingCurrentProfiles) => runtime.fail(app,
                    "新版の保存領域が2つあります。両方をバックアップして手動復旧してください。既存の新版を使う操作では解決しません。"),
                Err(error) => runtime.fail(app, error.message()),
            }
        });
    }
    fn confirm(&self, app: AppHandle, core: Arc<Core>, locations: Locations, legacy: bool) {
        self.set_phase(WAITING);
        let runtime = self.clone();
        let next_app = app.clone();
        let (message, accept) = if legacy {
            ("旧版の保存データを新版へ引き継ぎます。すべての旧版を終了し、移行中は起動しないことを確認してください。旧データは保持します。", "旧版終了を確認して引き継ぐ")
        } else {
            ("旧版と新版の保存データが両方あります。既存の新版を使いますか？旧データを上書き・結合せず、双方を保持します。", "既存の新版を使う")
        };
        app.dialog()
            .message(message)
            .title("Mogledge の保存データ")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                accept.into(),
                "終了".into(),
            ))
            .show(move |accepted| {
                if accepted {
                    runtime.prepare(
                        next_app,
                        core,
                        locations,
                        if legacy {
                            Decision::ImportAfterLegacyExit
                        } else {
                            Decision::KeepCurrent
                        },
                    );
                } else {
                    runtime.set_phase(FAILED);
                    next_app.exit(0);
                }
            });
    }
    fn ready(&self, app: AppHandle, core: Arc<Core>, profile: PreparedProfile) {
        self.set_phase(INITIALIZING);
        let paths = profile.paths.clone();
        #[cfg(feature = "e2e")]
        if let Mode::MigrationQa { root, .. } = &self.0.mode {
            if let Err(message) = validate_qa_restore(root, &paths) {
                self.fail(app, message);
                return;
            }
        }
        if self.0.lease.set(profile).is_err() {
            self.fail(
                app,
                "保存領域の初期化を再利用できません。終了して再起動してください。",
            );
            return;
        }
        let fail: Option<&str> = match &self.0.mode {
            #[cfg(feature = "e2e")]
            Mode::MigrationQa { fail, .. } => fail.as_deref(),
            _ => None,
        };
        if let Err(message) = initialize(&app, &core, paths, true, fail) {
            self.fail(app, &message);
            return;
        }
        let runtime = self.clone();
        let window_app = app.clone();
        if app
            .run_on_main_thread(move || {
                if let Err(message) = crate::open_main_window(&window_app, core) {
                    runtime.fail(window_app, &message);
                } else {
                    runtime.set_phase(READY);
                }
            })
            .is_err()
        {
            self.fail(
                app,
                "画面を準備できません。データを保持して終了してください。",
            );
        }
    }
    fn fail(&self, app: AppHandle, message: &str) {
        self.set_phase(FAILED);
        app.dialog()
            .message(message)
            .title("Mogledge を起動できません")
            .kind(MessageDialogKind::Error)
            .buttons(MessageDialogButtons::OkCustom("終了".into()))
            .show(move |_| app.exit(1));
    }
}
fn initialize(
    app: &AppHandle,
    core: &Arc<Core>,
    paths: ActivePaths,
    strict: bool,
    fail: Option<&str>,
) -> Result<(), String> {
    // Both ordinary and migrated paths keep search-index directly beneath the
    // actual local profile; document-state may live inside a migration bundle.
    let local_profile = paths
        .search_index
        .parent()
        .ok_or("保存profileが無効です")?
        .to_owned();
    #[cfg(feature = "e2e")]
    if fail == Some("settings-once") {
        let _ = core.settings_path.set(paths.settings.clone());
    }
    core.settings_path
        .set(paths.settings)
        .map_err(|_| "設定を重複して初期化できません")?;
    #[cfg(feature = "e2e")]
    if fail == Some("state-once") {
        let state =
            DocumentState::new_in_profile(paths.document_state.clone(), local_profile.clone())
                .map_err(|_| "文書保存状態を初期化できません")?;
        let _ = core.document_state.set(state);
    }
    match DocumentState::new_in_profile(paths.document_state, local_profile) {
        Ok(state) => core
            .document_state
            .set(state)
            .map_err(|_| "文書保存状態を重複して初期化できません")?,
        Err(_) if strict => {
            return Err(
                "文書保存状態を初期化できません。データを保持して再起動してください。".into(),
            )
        }
        Err(_) => eprintln!("Document state initialization failed; browsing remains available"),
    }
    match IndexService::new(paths.search_index) {
        Ok(index) => {
            core.index
                .set(index)
                .map_err(|_| "検索を重複して初期化できません")?;
        }
        Err(_) => eprintln!("Local search index initialization failed"),
    }
    let event_app = app.clone();
    *core.sink.lock().unwrap() = Some(Arc::new(move |change| {
        let _ = event_app.emit_to("main", "knowledge-changed", change);
    }));
    #[cfg(feature = "e2e")]
    let bootstrap = (!strict)
        .then(|| std::env::var_os("MY_KNOWLEDGE_E2E_ROOT"))
        .flatten()
        .map(PathBuf::from);
    #[cfg(not(feature = "e2e"))]
    let bootstrap: Option<PathBuf> = None;
    let restored = if let Some(path) = bootstrap {
        core.select(&path, false).map(|_| ())
    } else {
        core.restore()
    };
    if strict && (restored.is_err() || fail == Some("restore")) {
        return Err("保存状態を復元できません。データを保持して終了してください。再試行は再起動が必要です。".into());
    }
    if let Err(error) = restored {
        core.workspace.lock().unwrap().snapshot.watch_error = Some(error);
    }
    Ok(())
}

#[cfg(feature = "e2e")]
fn validate_qa_restore(root: &std::path::Path, paths: &ActivePaths) -> Result<(), &'static str> {
    let message = "Migration QA may restore only its marked fixture knowledge directory";
    if !paths.settings.exists() {
        return Ok(());
    }
    let parent = paths.settings.parent().ok_or(message)?;
    let (_, dir) = crate::knowledge::open_root(parent).map_err(|_| message)?;
    let bytes = migration::read_qa_settings(&dir).map_err(|_| message)?;
    let settings: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| message)?;
    let selected = settings
        .get("knowledgeRoot")
        .and_then(|value| value.as_str())
        .ok_or(message)?;
    let (expected, _) =
        crate::knowledge::open_root(&root.join("knowledge")).map_err(|_| message)?;
    if std::path::Path::new(selected) != expected {
        return Err(message);
    }
    Ok(())
}
