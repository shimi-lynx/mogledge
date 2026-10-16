use crate::{
    index::IndexService,
    knowledge::{self, TreeNode},
    watcher::{self, WatchHandle},
};
use cap_std::fs::Dir;
use rand::RngCore;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup_recovery: Option<crate::root_recovery::StartupRecovery>,
    pub workspace_id: Option<String>,
    pub root_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_folder: Option<crate::workspace_settings::DocumentRef>,
    pub display_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_hold: Option<StorageHold>,
    pub revision: u64,
    pub nodes: Vec<TreeNode>,
    // Completeness belongs to these nodes; watcher/order warnings do not imply scan failure.
    pub tree_complete: bool,
    pub watch_error: Option<String>,
    pub scan_duration_ms: f64,
    pub view_id: String,
    pub document_origin: String,
    pub path_moves: Vec<crate::tree_mutations::PathMove>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageHold {
    pub reason: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub workspace_id: String,
    pub revision: u64,
    pub changed_paths: Vec<String>,
    pub structure_changed: bool,
    pub watch_error: Option<String>,
    pub moves: Vec<crate::tree_mutations::PathMove>,
    pub tree_only: bool,
}
#[derive(Clone)]
pub struct Session {
    pub token: String,
    pub root: PathBuf,
    pub dir: Arc<Dir>,
    pub entry: String,
    pub storage_identity: Option<String>,
    pub logical_storage_identity: Option<String>,
    // Permission is fixed at grant admission. Later confirmation cannot
    // silently turn a failed restoration token into write authority.
    pub storage_hold: Option<StorageHold>,
}
pub struct DocumentTab {
    // Navigation metadata survives grant revocation. It conveys no read/write
    // authority and is rebound only after a successful guarded document open.
    pub admitted_document: Option<crate::workspace_settings::DocumentRef>,
    pub expected_identity: Option<String>,
    pub browser: bool,
    pub entry: String,
    pub latest_request: u64,
    pub session: Option<Session>,
    pub revocation: u64,
}
pub struct Workspace {
    pub snapshot: Snapshot,
    pub root: Option<PathBuf>,
    pub dir: Option<Arc<Dir>>,
    pub tabs: HashMap<String, DocumentTab>,
    pub order: crate::tree_order::Order,
    pub mutation_echoes: Vec<crate::tree_mutations::Echo>,
    pub settings: crate::workspace_settings::Settings,
}
type Sink = Arc<dyn Fn(Change) + Send + Sync>;

pub struct Core {
    pub(crate) persistent_storage_identity: bool,
    saved_startup_root: Mutex<Option<crate::root_recovery::SavedRoot>>,
    pub(crate) artifact_export: Arc<crate::artifact_export::Service>,
    pub origin: String,
    pub workspace: Mutex<Workspace>,
    pub gate: Mutex<()>,
    pub watcher: Mutex<Option<WatchHandle>>,
    pub settings_path: OnceLock<PathBuf>,
    pub(crate) html_authoring_plan: Mutex<Option<crate::html_authoring::Plan>>,
    pub pending_workspace_settings: Mutex<HashMap<String, crate::workspace_settings::Settings>>,
    pub index: OnceLock<Arc<IndexService>>,
    pub document_state: OnceLock<crate::document_state::DocumentState>,
    // Drop after document_state: rejected portable-file aliases may refer to
    // SQLite's inode, so their raw fds must outlive the live DB connection.
    pub(crate) live_management: crate::state_inspection::live::Service,
    pub(crate) live_transfer: crate::state_transfer::live::Service,
    pub asset_admission: Arc<crate::document_server::admission::Admission>,
    pub sink: Mutex<Option<Sink>>,
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Core {
    pub fn new(port: u16) -> Arc<Self> {
        Self::new_with_storage_identity_policy(port, crate::storage_identity_transition::enabled())
    }
    /// Shared production policy seam for portable identity-boundary checks.
    /// Physical identifiers continue to use the target OS's normal algorithm.
    pub fn new_with_storage_identity_policy(port: u16, persistent: bool) -> Arc<Self> {
        Arc::new(Self {
            persistent_storage_identity: persistent,
            saved_startup_root: Mutex::new(None),
            artifact_export: Arc::new(crate::artifact_export::Service::default()),
            origin: format!("http://127.0.0.1:{port}"),
            workspace: Mutex::new(Workspace {
                snapshot: Snapshot::default(),
                root: None,
                dir: None,
                tabs: HashMap::new(),
                order: crate::tree_order::Order::default(),
                mutation_echoes: Vec::new(),
                settings: Default::default(),
            }),
            gate: Mutex::new(()),
            watcher: Mutex::new(None),
            settings_path: OnceLock::new(),
            html_authoring_plan: Mutex::new(None),
            pending_workspace_settings: Mutex::new(HashMap::new()),
            index: OnceLock::new(),
            document_state: OnceLock::new(),
            live_management: crate::state_inspection::live::Service::default(),
            live_transfer: crate::state_transfer::live::Service::default(),
            asset_admission: Arc::new(crate::document_server::admission::Admission::default()),
            sink: Mutex::new(None),
        })
    }
    pub fn snapshot(&self) -> Snapshot {
        let workspace = self.workspace.lock().unwrap();
        let mut snapshot = workspace.snapshot.clone();
        snapshot.document_origin = self.origin.clone();
        snapshot
    }
    pub fn emit(&self, change: Change) {
        let sink = self.sink.lock().unwrap().clone();
        if let Some(sink) = sink {
            sink(change);
        }
    }
    pub fn select(self: &Arc<Self>, path: &Path, persist: bool) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().unwrap();
        self.select_locked(path, persist)
    }
    pub fn select_if_current(
        self: &Arc<Self>,
        expected_workspace: Option<&str>,
        expected_view: &str,
        path: &Path,
        persist: bool,
    ) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().unwrap();
        {
            let state = self.workspace.lock().unwrap();
            if state.snapshot.workspace_id.as_deref() != expected_workspace {
                return Err("WorkspaceChanged".into());
            }
            if state.snapshot.view_id != expected_view {
                return Err("ViewChanged".into());
            }
        }
        self.select_locked(path, persist)
    }
    pub(crate) fn select_locked(
        self: &Arc<Self>,
        path: &Path,
        persist: bool,
    ) -> Result<Snapshot, String> {
        let (probe_path, probe_dir) = knowledge::open_root(path)?;
        let managed = crate::managed_folders::marker_for_dir(&probe_path, &probe_dir)?.is_some();
        if !managed && !self.persistent_storage_identity {
            // Preserve an acknowledged namespace even when DB initialization
            // failed. Reselecting a folder must not bypass startup's scheme hold.
            if let Some(settings) = self.settings_path.get() {
                if crate::root_recovery::read_settings_value(settings)?
                    .is_some_and(|value| value.get("knowledgeRootIdentityScheme").is_some())
                {
                    return Err("StorageIdentityConfirmationRequired".into());
                }
            }
        }
        let _ = crate::workspace_settings::flush_locked(self);
        let started = Instant::now();
        let (root, dir) = knowledge::open_root(path)?;
        self.select_opened_locked(root, dir, persist, started)
    }
    fn select_opened_locked(
        self: &Arc<Self>,
        root: PathBuf,
        dir: Arc<Dir>,
        persist: bool,
        started: Instant,
    ) -> Result<Snapshot, String> {
        let root_guard = knowledge::RootReferenceGuard::open(&root, &dir)?;
        let managed = crate::managed_folders::marker_for_dir(&root, &dir)?.is_some();
        if !managed && !self.persistent_storage_identity {
            if let Some(store) = self.document_state.get() {
                if store.identity_schema_version()? == 3 {
                    return Err("StorageIdentityConfirmationRequired".into());
                }
            }
        }
        let storage_hold = if managed {
            self.document_state.get().is_none().then(|| StorageHold {
                reason: "StorageUnavailable".into(),
            })
        } else if self.persistent_storage_identity {
            let identity =
                knowledge::storage_root_identity(&dir).map_err(|_| "StorageIdentityUnavailable")?;
            match self.document_state.get() {
                None => Some(StorageHold {
                    reason: "StorageUnavailable".into(),
                }),
                Some(store) => match store.register_storage_root(&identity) {
                    Ok(true) => None,
                    Ok(false) => Some(StorageHold {
                        reason: "StorageIdentityConfirmationRequired".into(),
                    }),
                    Err(reason) => Some(StorageHold { reason }),
                },
            }
        } else {
            self.document_state.get().is_none().then(|| StorageHold {
                reason: "StorageUnavailable".into(),
            })
        };
        let settings = crate::workspace_settings::load(self, &dir);
        let id = random_token();
        let watch = watcher::start(Arc::downgrade(self), root.clone(), id.clone());
        let (handle, error) = match watch {
            Ok(handle) => (Some(handle), None),
            Err(error) => (None, Some(error)),
        };
        // The watcher is already listening. Its worker waits for gate while scanning.
        let mut nodes = knowledge::scan(&root)?;
        root_guard.revalidate(&root, &dir)?;
        let (order, order_error) = match crate::tree_order::load(self, &root) {
            Ok(order) => (order, None),
            Err(error) => (crate::tree_order::Order::default(), Some(error)),
        };
        crate::tree_order::apply(&mut nodes, &order);
        crate::workspace_settings::check_switch(self, &settings)?;
        if persist {
            self.save_settings(&root, &dir)?;
        }
        let settings = crate::workspace_settings::switch(self, settings)?;
        let snapshot = Snapshot {
            startup_recovery: None,
            workspace_id: Some(id),
            root_path: Some(root.to_string_lossy().into()),
            display_folder: None,
            display_revision: 0,
            storage_hold,
            revision: 1,
            nodes,
            tree_complete: true,
            watch_error: error.or(order_error),
            scan_duration_ms: started.elapsed().as_secs_f64() * 1000.0,
            view_id: random_token(),
            document_origin: self.origin.clone(),
            path_moves: Vec::new(),
        };
        *self.workspace.lock().unwrap() = Workspace {
            snapshot: snapshot.clone(),
            root: Some(root.clone()),
            dir: Some(dir.clone()),
            tabs: HashMap::new(),
            order,
            mutation_echoes: Vec::new(),
            settings,
        };
        *self.watcher.lock().unwrap() = handle;
        *self.saved_startup_root.lock().unwrap() = None;
        if let Some(index) = self.index.get() {
            index.select(
                snapshot.workspace_id.as_deref().unwrap(),
                root,
                dir,
                &snapshot.nodes,
                snapshot.watch_error.is_some(),
            );
        }
        if !persist {
            if let Err(error) = self.restore_display_locked() {
                self.workspace.lock().unwrap().snapshot.watch_error = Some(error);
            }
        }
        Ok(self.snapshot())
    }
    fn display_reference(
        root: &Path,
        dir: &Arc<Dir>,
        relative: &str,
    ) -> Result<Option<crate::workspace_settings::DocumentRef>, String> {
        let root_guard = knowledge::RootReferenceGuard::open(root, dir)?;
        let folder = (!relative.is_empty())
            .then(|| knowledge::ReadOnlyDirectoryGuard::open(root, dir, relative))
            .transpose()?;
        let identity = match &folder {
            Some(folder) => folder.storage_identity(),
            None => knowledge::storage_root_identity(dir),
        }
        .map_err(|_| "StorageIdentityUnavailable")?;
        if let Some(folder) = &folder {
            folder.revalidate(root, dir)?;
        }
        root_guard.revalidate(root, dir)?;
        Ok(
            (!relative.is_empty()).then(|| crate::workspace_settings::DocumentRef {
                relative_path: relative.into(),
                identity,
            }),
        )
    }
    pub fn select_display_folder(
        self: &Arc<Self>,
        workspace: &str,
        view: &str,
        relative: &str,
        persist: bool,
    ) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().unwrap();
        self.select_display_locked(workspace, view, relative, persist, None, None)
    }
    pub fn select_display_folder_if_current(
        self: &Arc<Self>,
        workspace: &str,
        view: &str,
        expected_display_revision: u64,
        relative: &str,
        persist: bool,
    ) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().unwrap();
        self.check_display_revision(workspace, view, expected_display_revision)?;
        self.select_display_locked(workspace, view, relative, persist, None, None)
    }
    fn check_display_revision(
        &self,
        workspace: &str,
        view: &str,
        expected: u64,
    ) -> Result<(), String> {
        let state = self.workspace.lock().unwrap();
        Self::check_view(&state, workspace, view)?;
        if state.snapshot.display_revision != expected {
            return Err("DisplayFolderChanged".into());
        }
        Ok(())
    }
    fn select_display_locked(
        &self,
        workspace: &str,
        view: &str,
        relative: &str,
        persist: bool,
        expected_identity: Option<&str>,
        captured_guard: Option<&knowledge::ReadOnlyDirectoryGuard>,
    ) -> Result<Snapshot, String> {
        let mut state = self.workspace.lock().unwrap();
        Self::check_view(&state, workspace, view)?;
        let root = state.root.as_ref().ok_or("WorkspaceChanged")?;
        let dir = state.dir.as_ref().ok_or("WorkspaceChanged")?;
        let root_guard = knowledge::RootReferenceGuard::open(root, dir)?;
        let folder = (!relative.is_empty())
            .then(|| knowledge::ReadOnlyDirectoryGuard::open(root, dir, relative))
            .transpose()?;
        let folder_identity = match &folder {
            Some(folder) => folder.storage_identity(),
            None => knowledge::storage_root_identity(dir),
        }
        .map_err(|_| "StorageIdentityUnavailable")?;
        if expected_identity.is_some_and(|expected| expected != folder_identity) {
            return Err("DisplayFolderIdentityChanged".into());
        }
        let display = (!relative.is_empty()).then(|| crate::workspace_settings::DocumentRef {
            relative_path: relative.into(),
            identity: folder_identity,
        });
        if let Some(folder) = &folder {
            folder.revalidate(root, dir)?;
        }
        if let Some(captured) = captured_guard {
            captured.revalidate(root, dir)?;
        }
        if persist {
            let identity =
                knowledge::storage_root_identity(dir).map_err(|_| "StorageIdentityUnavailable")?;
            self.save_display_settings(&identity, display.as_ref())?;
            // Retained ancestor handles bind both the settings decision and
            // the resulting view to the same registered physical directory.
        }
        if let Some(folder) = &folder {
            folder.revalidate(root, dir)?;
        }
        if let Some(captured) = captured_guard {
            captured.revalidate(root, dir)?;
        }
        root_guard.revalidate(root, dir)?;
        state.snapshot.display_folder = display;
        state.snapshot.display_revision += 1;
        let mut snapshot = state.snapshot.clone();
        snapshot.document_origin = self.origin.clone();
        Ok(snapshot)
    }
    pub fn select_display_path(
        self: &Arc<Self>,
        workspace: &str,
        view: &str,
        path: &Path,
        persist: bool,
    ) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().unwrap();
        self.select_display_path_locked(workspace, view, path, persist)
    }
    pub fn select_display_path_if_current(
        self: &Arc<Self>,
        workspace: &str,
        view: &str,
        expected_display_revision: u64,
        path: &Path,
        persist: bool,
    ) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().unwrap();
        self.check_display_revision(workspace, view, expected_display_revision)?;
        self.select_display_path_locked(workspace, view, path, persist)
    }
    fn select_display_path_locked(
        &self,
        workspace: &str,
        view: &str,
        path: &Path,
        persist: bool,
    ) -> Result<Snapshot, String> {
        let (root, dir) = {
            let state = self.workspace.lock().unwrap();
            Self::check_view(&state, workspace, view)?;
            (
                state.root.clone().ok_or("WorkspaceChanged")?,
                state.dir.clone().ok_or("WorkspaceChanged")?,
            )
        };
        let (selected, selected_dir) = knowledge::open_root(path)?;
        let relative = selected
            .strip_prefix(&root)
            .map_err(|_| "DisplayFolderOutsideRegisteredRoot")?;
        let relative = relative
            .to_str()
            .ok_or("DisplayFolderOutsideRegisteredRoot")?
            .replace('\\', "/");
        let root_guard = knowledge::RootReferenceGuard::open(&root, &dir)?;
        let retained = (!relative.is_empty())
            .then(|| knowledge::ReadOnlyDirectoryGuard::open(&root, &dir, &relative))
            .transpose()?;
        let matches = match &retained {
            Some(folder) => {
                folder
                    .storage_identity()
                    .map_err(|_| "StorageIdentityUnavailable")?
                    == knowledge::storage_root_identity(&selected_dir)
                        .map_err(|_| "StorageIdentityUnavailable")?
            }
            None => knowledge::same_directory(&dir, &selected_dir)?,
        };
        if !matches {
            return Err("DisplayFolderIdentityChanged".into());
        }
        if let Some(retained) = &retained {
            retained.revalidate(&root, &dir)?;
        }
        root_guard.revalidate(&root, &dir)?;
        let expected_identity = knowledge::storage_root_identity(&selected_dir)
            .map_err(|_| "StorageIdentityUnavailable")?;
        self.select_display_locked(
            workspace,
            view,
            &relative,
            persist,
            Some(&expected_identity),
            retained.as_ref(),
        )
    }
    fn restore_display_locked(&self) -> Result<(), String> {
        let Some(path) = self.settings_path.get() else {
            return Ok(());
        };
        let Some(value) = crate::root_recovery::read_settings_value(path)? else {
            return Ok(());
        };
        let Some(display) = value.get("knowledgeDisplayFolder") else {
            return Ok(());
        };
        let saved: crate::workspace_settings::DocumentRef =
            serde_json::from_value(display.clone()).map_err(|_| "DisplayFolderIdentityChanged")?;
        if saved.relative_path.len() > 4096 || !crate::state_inspection::digest_id(&saved.identity)
        {
            return Err("DisplayFolderIdentityChanged".into());
        }
        let mut state = self.workspace.lock().unwrap();
        let root = state.root.as_ref().ok_or("WorkspaceChanged")?;
        let dir = state.dir.as_ref().ok_or("WorkspaceChanged")?;
        let identity =
            knowledge::storage_root_identity(dir).map_err(|_| "StorageIdentityUnavailable")?;
        if value["knowledgeDisplayRootIdentity"].as_str() != Some(&identity) {
            return Err("DisplayFolderIdentityChanged".into());
        }
        let current = Self::display_reference(root, dir, &saved.relative_path)
            .map_err(|_| "DisplayFolderIdentityChanged")?;
        if current.as_ref() != Some(&saved) {
            return Err("DisplayFolderIdentityChanged".into());
        }
        state.snapshot.display_folder = current;
        Ok(())
    }
    fn revalidate_display(state: &mut Workspace) {
        let Some(saved) = state.snapshot.display_folder.as_ref() else {
            return;
        };
        let matches = match (&state.root, &state.dir) {
            (Some(root), Some(dir)) => Self::display_reference(root, dir, &saved.relative_path)
                .is_ok_and(|current| current.as_ref() == Some(saved)),
            _ => false,
        };
        if !matches {
            // Retain the saved choice for inspection. Replacing a directory at
            // its former path cannot silently replace the display authority.
            state.snapshot.display_folder = None;
            state.snapshot.display_revision += 1;
            state.snapshot.watch_error = Some("DisplayFolderIdentityChanged".into());
        }
    }
    fn save_settings(&self, root: &Path, dir: &Dir) -> Result<(), String> {
        let path = self.settings_path.get().ok_or("StorageUnavailable")?;
        let mut value = crate::root_recovery::read_settings_value(path)?
            .unwrap_or_else(|| serde_json::json!({}));
        let map = value.as_object_mut().ok_or("StorageCorrupt")?;
        map.insert("knowledgeRoot".into(), serde_json::json!(root));
        map.insert(
            "knowledgeRootIdentity".into(),
            serde_json::json!(
                knowledge::storage_root_identity(dir).map_err(|_| "StorageIdentityUnavailable")?
            ),
        );
        if self.persistent_storage_identity {
            map.insert(
                "knowledgeRootIdentityScheme".into(),
                serde_json::json!(crate::storage_identity_transition::SCHEME),
            );
        }
        // A registration change never promotes a previous display path to the
        // new registered root or carries its navigation choice across identities.
        map.remove("knowledgeDisplayFolder");
        map.remove("knowledgeDisplayRootIdentity");
        self.publish_settings(&value)
    }
    fn save_display_settings(
        &self,
        root_identity: &str,
        display: Option<&crate::workspace_settings::DocumentRef>,
    ) -> Result<(), String> {
        let path = self.settings_path.get().ok_or("StorageUnavailable")?;
        let mut value =
            crate::root_recovery::read_settings_value(path)?.ok_or("StorageUnavailable")?;
        let map = value.as_object_mut().ok_or("StorageCorrupt")?;
        if map
            .get("knowledgeRootIdentity")
            .and_then(serde_json::Value::as_str)
            != Some(root_identity)
        {
            return Err("RegisteredFolderIdentityChanged".into());
        }
        match display {
            Some(display) => {
                map.insert("knowledgeDisplayFolder".into(), serde_json::json!(display));
                map.insert(
                    "knowledgeDisplayRootIdentity".into(),
                    serde_json::json!(root_identity),
                );
            }
            None => {
                map.remove("knowledgeDisplayFolder");
                map.remove("knowledgeDisplayRootIdentity");
            }
        }
        self.publish_settings(&value)
    }
    fn publish_settings(&self, value: &serde_json::Value) -> Result<(), String> {
        use std::io::Write;
        let path = self.settings_path.get().ok_or("StorageUnavailable")?;
        let parent = path.parent().ok_or("StorageUnavailable")?;
        std::fs::create_dir_all(parent).map_err(|_| "StorageUnavailable")?;
        let json = serde_json::to_vec_pretty(&value).map_err(|_| "設定を作成できません")?;
        if json.len() > 1024 * 1024 {
            return Err("StorageCapacityExceeded".into());
        }
        let (profile_root, profile_dir) = knowledge::open_root(parent)?;
        let guard = knowledge::RootReferenceGuard::open_profile_write(&profile_root, &profile_dir)?;
        let (temporary, mut file) =
            crate::write_fs::create_temporary(&profile_dir).map_err(|_| "設定を保存できません")?;
        let result = (|| {
            file.write_all(&json)
                .and_then(|_| file.sync_all())
                .map_err(|_| "設定を保存できません")?;
            guard.revalidate(&profile_root, &profile_dir)?;
            crate::write_fs::replace_profile_settings(&profile_dir, &temporary, &file)
                .map_err(|_| "設定を保存できません".to_owned())
        })();
        if result.is_err() {
            let _ = crate::write_fs::remove_temporary(&profile_dir, &temporary, &file);
        }
        result
    }
    pub fn restore(self: &Arc<Self>) -> Result<(), String> {
        // Dedicated-folder registration is the only production startup root
        // source. Legacy root settings remain intact for explicit registration.
        let Some(path) = self.settings_path.get() else {
            return Ok(());
        };
        // An absent/empty registration list is ordinary onboarding, even if
        // retained legacy settings mention a root. Never rewrite those settings.
        if let Some(value) =
            crate::root_recovery::read_settings_value(path).map_err(|_| "設定を読み取れません")?
        {
            if value.get("knowledgeRoot").is_some() {
                crate::root_recovery::SavedRoot::parse(&value)?;
            }
        }
        crate::managed_folders::restore(self)
    }
    pub(crate) fn restore_root_locked(self: &Arc<Self>, saved: crate::root_recovery::SavedRoot) {
        use crate::root_recovery::{RecoveryReason, StartupRecovery};
        let scheme_matches = saved.scheme.as_deref()
            == if self.persistent_storage_identity {
                Some(crate::storage_identity_transition::SCHEME)
            } else {
                None
            };
        let reason = if !scheme_matches {
            RecoveryReason::StorageIdentityConfirmationRequired
        } else {
            match knowledge::open_root_checked(&saved.path) {
                Err(error) => crate::root_recovery::open_reason(&error),
                Ok((root, dir)) => match &saved.identity {
                    None => RecoveryReason::ConfirmationRequired,
                    Some(expected) => match knowledge::storage_root_identity(&dir) {
                        Ok(actual) if &actual == expected => {
                            match self.select_opened_locked(root, dir, false, Instant::now()) {
                                Ok(_) => return,
                                Err(error) if error == "StorageIdentityConfirmationRequired" => {
                                    RecoveryReason::StorageIdentityConfirmationRequired
                                }
                                Err(_) => RecoveryReason::Unavailable,
                            }
                        }
                        Ok(_) => RecoveryReason::IdentityChanged,
                        Err(_) => RecoveryReason::Unavailable,
                    },
                },
            }
        };
        let can_retry = saved.identity.is_some()
            && reason != RecoveryReason::StorageIdentityConfirmationRequired;
        let recovery = StartupRecovery { reason, can_retry };
        let mut state = self.workspace.lock().unwrap();
        // Detach runtime handles/grants only. Persisted HTML/state/preferences
        // and the original saved root are retained for explicit recovery.
        state.snapshot = Snapshot {
            startup_recovery: Some(recovery),
            view_id: state.snapshot.view_id.clone(),
            ..Default::default()
        };
        state.root = None;
        state.dir = None;
        state.tabs.clear();
        *self.watcher.lock().unwrap() = None;
        *self.saved_startup_root.lock().unwrap() = Some(saved);
    }
    pub fn retry_saved_root(self: &Arc<Self>, view: &str) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().unwrap();
        {
            let state = self.workspace.lock().unwrap();
            if state.snapshot.view_id != view
                || state.snapshot.workspace_id.is_some()
                || state.snapshot.startup_recovery.is_none()
            {
                return Err("ViewChanged".into());
            }
        }
        let saved = self
            .saved_startup_root
            .lock()
            .unwrap()
            .clone()
            .ok_or("WorkspaceChanged")?;
        if !crate::managed_folders::has_selected(self)? {
            return Err("専用フォルダーを登録してください".into());
        }
        self.restore_root_locked(saved);
        Ok(self.snapshot())
    }
    // structure=true is reserved for known structural-only notification batches.
    // Mixed/ambiguous batches use apply_content_change with their scan flag.
    pub fn apply_change(
        &self,
        id: &str,
        paths: Vec<String>,
        structure: bool,
        error: Option<String>,
    ) {
        self.apply_change_inner(id, paths, structure, error, !structure);
    }
    pub(crate) fn apply_rescan(&self, id: &str, paths: Vec<String>, error: Option<String>) {
        self.apply_change_inner(id, paths, true, error, true);
    }
    pub(crate) fn apply_content_change(
        &self,
        id: &str,
        paths: Vec<String>,
        structure: bool,
        error: Option<String>,
    ) {
        self.apply_change_inner(id, paths, structure, error, true);
    }
    fn apply_change_inner(
        &self,
        id: &str,
        paths: Vec<String>,
        structure: bool,
        error: Option<String>,
        ignore_echoes: bool,
    ) {
        let _gate = self.gate.lock().unwrap();
        let (root, order, paths) = {
            let mut state = self.workspace.lock().unwrap();
            if state.snapshot.workspace_id.as_deref() != Some(id) {
                return;
            }
            let original = paths.len();
            let paths = if error.is_none() && !ignore_echoes {
                crate::tree_mutations::filter_structural_echoes(&mut state, paths)
            } else {
                // Content or ambiguous events invalidate older native echoes,
                // even when their identity/size/mtime happen to be unchanged.
                state.mutation_echoes.clear();
                paths
            };
            if original > 0 && paths.is_empty() && error.is_none() && !ignore_echoes {
                return;
            }
            (state.root.clone(), state.order.clone(), paths)
        };
        let (nodes, error) = if structure || error.is_some() {
            match root.as_deref().map(knowledge::scan) {
                Some(Ok(mut nodes)) => {
                    crate::tree_order::apply(&mut nodes, &order);
                    (Some((nodes, true)), error)
                }
                Some(Err(err)) => (Some((Vec::new(), false)), Some(err)),
                None => return,
            }
        } else {
            (None, error)
        };
        let change = {
            let mut state = self.workspace.lock().unwrap();
            if state.snapshot.workspace_id.as_deref() != Some(id) {
                return;
            }
            if let Some((nodes, complete)) = nodes {
                state.mutation_echoes.clear();
                for tab in state.tabs.values_mut() {
                    if !knowledge::contains(&nodes, &tab.entry) {
                        tab.session = None;
                        tab.revocation += 1;
                    }
                }
                state.snapshot.nodes = nodes;
                state.snapshot.tree_complete = complete;
            }
            let reconcile = structure || error.is_some();
            if error.is_some() {
                state.snapshot.watch_error = error;
            }
            if reconcile {
                Self::revalidate_display(&mut state);
            }
            state.snapshot.revision += 1;
            if let Some(index) = self.index.get() {
                index.changed(
                    id,
                    &paths,
                    &state.snapshot.nodes,
                    reconcile,
                    state.snapshot.watch_error.is_some(),
                );
            }
            Change {
                workspace_id: id.into(),
                revision: state.snapshot.revision,
                changed_paths: paths,
                structure_changed: structure,
                watch_error: state.snapshot.watch_error.clone(),
                moves: Vec::new(),
                tree_only: false,
            }
        };
        self.emit(change);
    }
    pub fn refresh(self: &Arc<Self>) -> Result<Snapshot, String> {
        let _gate = self.gate.lock().unwrap();
        let (root, id) = {
            let state = self.workspace.lock().unwrap();
            (
                state.root.clone().ok_or("knowledgeを選択してください")?,
                state
                    .snapshot
                    .workspace_id
                    .clone()
                    .ok_or("knowledgeを選択してください")?,
            )
        };
        let (canonical, dir) = knowledge::open_root(&root)?;
        let same = {
            let state = self.workspace.lock().unwrap();
            knowledge::same_directory(state.dir.as_ref().ok_or("WorkspaceChanged")?, &dir)?
        };
        if !same || canonical != root {
            return Err("RegisteredFolderIdentityChanged".into());
        }
        let (watch, error) = match watcher::start(Arc::downgrade(self), root.clone(), id.clone()) {
            Ok(handle) => (Some(handle), None),
            Err(error) => (None, Some(error)),
        };
        let mut nodes = knowledge::scan(&root)?;
        let (order, order_error) = match crate::tree_order::load(self, &root) {
            Ok(order) => (order, None),
            Err(error) => (crate::tree_order::Order::default(), Some(error)),
        };
        crate::tree_order::apply(&mut nodes, &order);
        {
            let mut state = self.workspace.lock().unwrap();
            for tab in state.tabs.values_mut() {
                if !knowledge::contains(&nodes, &tab.entry) {
                    tab.session = None;
                    tab.revocation += 1;
                }
            }
            state.snapshot.nodes = nodes;
            state.snapshot.tree_complete = true;
            state.mutation_echoes.clear();
            state.snapshot.revision += 1;
            state.snapshot.watch_error = error.or(order_error);
            Self::revalidate_display(&mut state);
            state.order = order;
            if let Some(index) = self.index.get() {
                index.changed(
                    &id,
                    &[],
                    &state.snapshot.nodes,
                    true,
                    state.snapshot.watch_error.is_some(),
                );
            }
        }
        *self.watcher.lock().unwrap() = watch;
        Ok(self.snapshot())
    }
    // A renderer restart owns a new view. Late calls from the old renderer cannot
    // create, open or close grants belonging to this view.
    pub fn begin_view(&self) -> Snapshot {
        let _gate = self.gate.lock().unwrap();
        let mut state = self.workspace.lock().unwrap();
        state.tabs.clear();
        state.snapshot.path_moves.clear();
        state.snapshot.view_id = random_token();
        let mut snapshot = state.snapshot.clone();
        snapshot.document_origin = self.origin.clone();
        snapshot
    }
    pub(crate) fn check_view(state: &Workspace, workspace: &str, view: &str) -> Result<(), String> {
        if state.snapshot.workspace_id.as_deref() != Some(workspace) {
            return Err("WorkspaceChanged".into());
        }
        if state.snapshot.view_id != view {
            return Err("ViewChanged".into());
        }
        Ok(())
    }
    pub fn document_storage_hold(
        &self,
        workspace: &str,
        view: &str,
        tab_id: &str,
        request_id: u64,
    ) -> Result<Option<StorageHold>, String> {
        let _gate = self.gate.lock().unwrap();
        let state = self.workspace.lock().unwrap();
        Self::check_view(&state, workspace, view)?;
        let tab = state.tabs.get(tab_id).ok_or("TabClosed")?;
        if tab.latest_request != request_id {
            return Err("Superseded".into());
        }
        let session = tab.session.as_ref().ok_or("StorageUnavailable")?;
        Ok(session.storage_hold.clone())
    }
    pub fn create_tab(
        &self,
        workspace: &str,
        view: &str,
        relative: &str,
    ) -> Result<String, String> {
        self.create_tab_checked(workspace, view, relative, None)
    }
    pub fn create_tab_checked(
        &self,
        workspace: &str,
        view: &str,
        relative: &str,
        expected_identity: Option<String>,
    ) -> Result<String, String> {
        let _gate = self.gate.lock().unwrap();
        let mut state = self.workspace.lock().unwrap();
        Self::check_view(&state, workspace, view)?;
        if !knowledge::contains(&state.snapshot.nodes, relative) {
            return Err("HTMLが見つかりません".into());
        }
        if let Some(expected) = &expected_identity {
            if knowledge::storage_identity(
                state.root.as_ref().unwrap(),
                state.dir.as_ref().unwrap(),
                relative,
            )? != *expected
            {
                return Err("文書が置き換えられました".into());
            }
        }
        let id = random_token();
        state.tabs.insert(
            id.clone(),
            DocumentTab {
                admitted_document: None,
                expected_identity,
                browser: false,
                entry: relative.into(),
                latest_request: 0,
                session: None,
                revocation: 0,
            },
        );
        Ok(id)
    }
    // External browser grants are independent of UI tabs, with one per HTML.
    // Reopening updates only that browser grant; normal view/root cleanup applies.
    pub fn browser_tab(
        &self,
        workspace: &str,
        view: &str,
        relative: &str,
    ) -> Result<(String, u64), String> {
        let mut state = self.workspace.lock().unwrap();
        Self::check_view(&state, workspace, view)?;
        if !knowledge::contains(&state.snapshot.nodes, relative) {
            return Err("HTMLが見つかりません".into());
        }
        if let Some((id, tab)) = state
            .tabs
            .iter()
            .find(|(_, tab)| tab.browser && tab.entry == relative)
        {
            return Ok((id.clone(), tab.latest_request + 1));
        }
        let id = random_token();
        state.tabs.insert(
            id.clone(),
            DocumentTab {
                admitted_document: None,
                expected_identity: None,
                browser: true,
                entry: relative.into(),
                latest_request: 0,
                session: None,
                revocation: 0,
            },
        );
        Ok((id, 1))
    }
    pub fn close_tab(&self, workspace: &str, view: &str, tab: &str) -> Result<(), String> {
        let _gate = self.gate.lock().unwrap();
        self.close_tab_locked(workspace, view, tab)
    }
    pub(crate) fn close_tab_locked(
        &self,
        workspace: &str,
        view: &str,
        tab: &str,
    ) -> Result<(), String> {
        let mut state = self.workspace.lock().unwrap();
        Self::check_view(&state, workspace, view)?;
        state.tabs.remove(tab);
        Ok(())
    }
    pub fn session_for_token(&self, token: &str) -> Option<Session> {
        let state = self.workspace.lock().unwrap();
        state
            .tabs
            .values()
            .filter_map(|tab| tab.session.as_ref())
            .find(|session| {
                session.token.len() == token.len()
                    && session
                        .token
                        .as_bytes()
                        .iter()
                        .zip(token.as_bytes())
                        .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                        == 0
            })
            .cloned()
    }
    pub fn open(
        &self,
        workspace: &str,
        view: &str,
        tab_id: &str,
        request: u64,
    ) -> Result<String, String> {
        self.open_inner(
            workspace,
            view,
            tab_id,
            request,
            false,
            |root, dir, relative, permit| self.read_for_session(root, dir, relative, permit),
        )
    }
    pub(crate) fn open_locked(
        &self,
        workspace: &str,
        view: &str,
        tab_id: &str,
        request: u64,
    ) -> Result<String, String> {
        self.open_inner(
            workspace,
            view,
            tab_id,
            request,
            true,
            |root, dir, relative, permit| self.read_for_session(root, dir, relative, permit),
        )
    }
    fn read_for_session(
        &self,
        root: &Path,
        dir: &Dir,
        relative: &str,
        permit: &mut crate::document_server::admission::ReadPermit,
    ) -> Result<(Vec<u8>, Option<String>), knowledge::ReadError> {
        knowledge::read_source_budgeted(
            root,
            dir,
            relative,
            // Workspace references and expected-identity admission also need
            // the identity when the optional saved-input DB is unavailable.
            // Reuse metadata from this guarded read; assets remain unchanged.
            true,
            |capacity| permit.reserve_capacity(capacity),
        )
        .map(|source| (source.data, source.storage_identity))
    }
    #[cfg(test)]
    pub(crate) fn open_with(
        &self,
        workspace: &str,
        view: &str,
        tab_id: &str,
        request: u64,
        read_document: impl Fn(&Path, &Dir, &str) -> Result<Vec<u8>, String>,
    ) -> Result<String, String> {
        self.open_inner(
            workspace,
            view,
            tab_id,
            request,
            false,
            |root, dir, relative, _permit| {
                read_document(root, dir, relative)
                    .map(|data| (data, None))
                    .map_err(knowledge::ReadError::from)
            },
        )
    }
    fn open_inner(
        &self,
        workspace: &str,
        view: &str,
        tab_id: &str,
        request: u64,
        gate_held: bool,
        read_document: impl Fn(
            &Path,
            &Dir,
            &str,
            &mut crate::document_server::admission::ReadPermit,
        ) -> Result<(Vec<u8>, Option<String>), knowledge::ReadError>,
    ) -> Result<String, String> {
        let (root, dir, relative, revocation) = {
            let _gate = (!gate_held).then(|| self.gate.lock().unwrap());
            let mut state = self.workspace.lock().unwrap();
            Self::check_view(&state, workspace, view)?;
            let root = state.root.clone().ok_or("WorkspaceChanged")?;
            let dir = state.dir.clone().ok_or("WorkspaceChanged")?;
            let tab = state.tabs.get_mut(tab_id).ok_or("TabClosed")?;
            if request <= tab.latest_request {
                return Err("Superseded".into());
            }
            tab.latest_request = request;
            tab.session = None;
            (root, dir, tab.entry.clone(), tab.revocation)
        };
        // Synchronous open never waits for admission while a lifecycle gate
        // could be held. Its validation Vec shares the HTTP memory/read budget.
        let mut admission = self
            .asset_admission
            .try_read("document-open")
            .ok_or_else(|| {
                self.asset_admission.reject();
                "ResourceBusy".to_owned()
            })?;
        let mut read = read_document(&root, &dir, &relative, &mut admission);
        for delay in [100, 250, 500] {
            if read.is_ok() || matches!(read, Err(knowledge::ReadError::ResourceBusy)) {
                break;
            }
            thread::sleep(Duration::from_millis(delay));
            read = read_document(&root, &dir, &relative, &mut admission);
        }
        let (data, storage_identity) = read.map_err(|error| error.to_string())?;
        std::str::from_utf8(&data).map_err(|_| "HTMLをUTF-8で保存してください")?;
        let _gate = (!gate_held).then(|| self.gate.lock().unwrap());
        let mut state = self.workspace.lock().unwrap();
        Self::check_view(&state, workspace, view)?;
        if !knowledge::contains(&state.snapshot.nodes, &relative) {
            return Err("HTMLが見つかりません".into());
        }
        let root_storage_hold = state.snapshot.storage_hold.clone();
        let tab = state.tabs.get_mut(tab_id).ok_or("TabClosed")?;
        if tab.latest_request != request || tab.revocation != revocation {
            return Err("Superseded".into());
        }
        if tab
            .expected_identity
            .as_ref()
            .is_some_and(|expected| storage_identity.as_ref() != Some(expected))
        {
            return Err("文書が置き換えられました".into());
        }
        let managed = crate::managed_folders::marker_for_dir(&root, &dir)?.is_some();
        let mut logical_storage_identity = None;
        let storage_hold = if managed {
            match storage_identity
                .as_ref()
                .ok_or_else(|| "StorageUnavailable".to_owned())
                .and_then(|physical| {
                    crate::document_identity::admit(
                        self,
                        &root,
                        &dir,
                        &relative,
                        std::str::from_utf8(&data).unwrap(),
                        physical,
                    )
                }) {
                Ok(key) => {
                    logical_storage_identity = Some(key);
                    None
                }
                Err(reason) => Some(StorageHold { reason }),
            }
        } else if root_storage_hold.is_some() {
            root_storage_hold
        } else if self.persistent_storage_identity {
            let admission = match (&storage_identity, self.document_state.get()) {
                (Some(identity), Some(store)) => knowledge::storage_root_identity(&dir)
                    .map_err(|_| "StorageUnavailable".to_owned())
                    .and_then(|root| store.admit_document_storage(&root, identity, &relative)),
                _ => Err("StorageUnavailable".into()),
            };
            match admission {
                Ok(true) => None,
                Ok(false) => Some(StorageHold {
                    reason: "StorageIdentityConfirmationRequired".into(),
                }),
                Err(reason) => Some(StorageHold { reason }),
            }
        } else {
            None
        };
        let token = random_token();
        let encoded = relative
            .split('/')
            .map(|s| {
                percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC)
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join("/");
        let url = format!("{}/s/{}/{}", self.origin, token, encoded);
        // A saved reference constrains this admission only. Later normal reloads
        // must still accept an editor's atomic replacement of the same document.
        tab.expected_identity = None;
        tab.admitted_document =
            storage_identity
                .as_ref()
                .map(|identity| crate::workspace_settings::DocumentRef {
                    relative_path: relative.clone(),
                    identity: identity.clone(),
                });
        tab.session = Some(Session {
            token,
            root,
            dir,
            entry: relative,
            storage_identity,
            logical_storage_identity,
            storage_hold,
        });
        Ok(url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tree_completeness_is_independent_of_order_warnings() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("knowledge");
        std::fs::create_dir(&root).unwrap();
        let core = Core::new(19013);
        core.settings_path
            .set(tmp.path().join("config/settings.json"))
            .unwrap();
        core.select(&root, false).unwrap();
        core.watcher.lock().unwrap().take();
        let registered_root = core.workspace.lock().unwrap().root.clone().unwrap();
        crate::tree_order::save(&core, &registered_root, &Default::default()).unwrap();
        let order = std::fs::read_dir(tmp.path().join("config/tree-order"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        std::fs::write(order, "{").unwrap();
        let selected = core.select(&root, false).unwrap();
        assert!(selected.nodes.is_empty());
        assert!(selected.watch_error.is_some());
        assert!(selected.tree_complete);
        assert_eq!(
            serde_json::to_value(&selected).unwrap()["treeComplete"],
            true
        );
        let refreshed = core.refresh().unwrap();
        assert!(refreshed.watch_error.is_some());
        assert!(refreshed.tree_complete);
    }
    #[test]
    fn tree_completeness_tracks_scan_failure_and_recovery() {
        let tmp = tempfile::tempdir().unwrap();
        let core = Core::new(19014);
        let selected = core.select(tmp.path(), false).unwrap();
        core.watcher.lock().unwrap().take();
        let ws = selected.workspace_id.as_ref().unwrap();
        // Substitute a disposable missing scan path without changing any real root or grants.
        core.workspace.lock().unwrap().root = Some(tmp.path().join("missing"));
        core.apply_change(ws, Vec::new(), true, None);
        assert!(!core.snapshot().tree_complete);
        assert!(core.snapshot().nodes.is_empty());
        core.apply_change(ws, Vec::new(), false, None);
        assert!(!core.snapshot().tree_complete);
        core.workspace.lock().unwrap().root = Some(tmp.path().to_path_buf());
        core.apply_change(ws, Vec::new(), true, None);
        assert!(core.snapshot().tree_complete);
        assert!(core.snapshot().watch_error.is_some());
        core.apply_change(ws, Vec::new(), false, None);
        assert!(core.snapshot().tree_complete);
    }
    #[test]
    fn close_view_restart_and_root_change_reject_inflight_open() {
        for action in ["close", "view", "root"] {
            let one = tempfile::tempdir().unwrap();
            let two = tempfile::tempdir().unwrap();
            std::fs::write(one.path().join("a.html"), "a").unwrap();
            let core = Core::new(19011);
            let snapshot = core.select(one.path(), false).unwrap();
            let workspace = snapshot.workspace_id.as_ref().unwrap();
            let tab = core
                .create_tab(workspace, &snapshot.view_id, "a.html")
                .unwrap();
            let result =
                core.open_with(workspace, &snapshot.view_id, &tab, 1, |root, dir, path| {
                    let data = knowledge::read(root, dir, path)?;
                    match action {
                        "close" => core.close_tab(workspace, &snapshot.view_id, &tab).unwrap(),
                        "view" => {
                            core.begin_view();
                        }
                        "root" => {
                            core.select(two.path(), false).unwrap();
                        }
                        _ => unreachable!(),
                    }
                    Ok(data)
                });
            let expected = match action {
                "close" => "TabClosed",
                "view" => "ViewChanged",
                _ => "WorkspaceChanged",
            };
            assert_eq!(result.unwrap_err(), expected);
            assert!(core.workspace.lock().unwrap().tabs.is_empty());
        }
    }
    #[test]
    fn deletion_and_recreation_cannot_resurrect_an_inflight_grant() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.html"), "old").unwrap();
        let core = Core::new(19010);
        let snapshot = core.select(tmp.path(), false).unwrap();
        let workspace = snapshot.workspace_id.as_ref().unwrap();
        let tab = core
            .create_tab(workspace, &snapshot.view_id, "a.html")
            .unwrap();
        let result = core.open_with(workspace, &snapshot.view_id, &tab, 1, |root, dir, path| {
            let data = knowledge::read(root, dir, path)?;
            std::fs::remove_file(root.join("a.html")).unwrap();
            core.apply_change(workspace, vec!["a.html".into()], true, None);
            std::fs::write(root.join("a.html"), "new").unwrap();
            core.apply_change(workspace, vec!["a.html".into()], true, None);
            Ok(data)
        });
        assert_eq!(result.unwrap_err(), "Superseded");
        assert!(core.workspace.lock().unwrap().tabs[&tab].session.is_none());
        assert!(core.open(workspace, &snapshot.view_id, &tab, 2).is_ok());
    }
    #[test]
    fn an_inflight_open_cannot_restore_a_grant_after_an_internal_move() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.html"), "old").unwrap();
        std::fs::create_dir(tmp.path().join("Target")).unwrap();
        let core = Core::new(19012);
        let snapshot = core.select(tmp.path(), false).unwrap();
        core.watcher.lock().unwrap().take();
        let ws = snapshot.workspace_id.as_ref().unwrap();
        let tab = core.create_tab(ws, &snapshot.view_id, "a.html").unwrap();
        let result = core.open_with(ws, &snapshot.view_id, &tab, 1, |root, dir, path| {
            let data = knowledge::read(root, dir, path)?;
            crate::tree_mutations::perform(
                &core,
                ws,
                &snapshot.view_id,
                crate::tree_mutations::Mutation::Move {
                    source: "a.html".into(),
                    parent: "Target".into(),
                    anchor: None,
                    after: false,
                },
            )
            .unwrap();
            std::fs::write(root.join("a.html"), "replacement").unwrap();
            core.apply_change(ws, vec!["a.html".into()], true, None);
            Ok(data)
        });
        assert!(result.is_err());
        assert_eq!(
            core.workspace.lock().unwrap().tabs[&tab].entry,
            "Target/a.html"
        );
        assert!(core.workspace.lock().unwrap().tabs[&tab].session.is_none());
        assert!(core.open(ws, &snapshot.view_id, &tab, 2).is_ok());
    }
}
