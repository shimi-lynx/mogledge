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
    pub revision: u64,
    pub nodes: Vec<TreeNode>,
    pub watch_error: Option<String>,
    pub scan_duration_ms: f64,
    pub view_id: String,
    pub document_origin: String,
    pub path_moves: Vec<crate::tree_mutations::PathMove>,
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
        Arc::new(Self {
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
    fn select_locked(self: &Arc<Self>, path: &Path, persist: bool) -> Result<Snapshot, String> {
        if !crate::storage_identity_transition::enabled() {
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
        if !crate::storage_identity_transition::enabled() {
            if let Some(store) = self.document_state.get() {
                if store.identity_schema_version()? == 3 {
                    return Err("StorageIdentityConfirmationRequired".into());
                }
            }
        }
        if crate::storage_identity_transition::enabled() {
            let identity =
                knowledge::storage_root_identity(&dir).map_err(|_| "StorageIdentityUnavailable")?;
            let store = self
                .document_state
                .get()
                .ok_or("StorageIdentityConfirmationRequired")?;
            if !store.identity_root_confirmed(&identity)? {
                return Err("StorageIdentityConfirmationRequired".into());
            }
            // The DB is authoritative; settings are published last by the
            // stopped-profile transition. A crash between the two stays held.
            let settings = self
                .settings_path
                .get()
                .ok_or("StorageIdentityConfirmationRequired")?;
            let value = crate::root_recovery::read_settings_value(settings)?
                .ok_or("StorageIdentityConfirmationRequired")?;
            if value["knowledgeRootIdentityScheme"].as_str()
                != Some(crate::storage_identity_transition::SCHEME)
                || value["knowledgeRootIdentity"].as_str() != Some(&identity)
            {
                return Err("StorageIdentityConfirmationRequired".into());
            }
        }
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
            revision: 1,
            nodes,
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
        Ok(snapshot)
    }
    fn save_settings(&self, root: &Path, dir: &Dir) -> Result<(), String> {
        use std::io::Write;
        let path = self.settings_path.get().ok_or("設定保存先が未初期化です")?;
        let parent = path.parent().ok_or("設定保存先が無効です")?;
        std::fs::create_dir_all(parent).map_err(|_| "設定フォルダを作成できません")?;
        let mut value = crate::root_recovery::read_settings_value(path)?
            .unwrap_or_else(|| serde_json::json!({}));
        let map = value.as_object_mut().ok_or("設定の形式が無効です")?;
        map.insert("knowledgeRoot".into(), serde_json::json!(root));
        map.insert(
            "knowledgeRootIdentity".into(),
            serde_json::json!(knowledge::storage_root_identity(dir)
                .map_err(|_| "作業フォルダーの識別情報を取得できません")?),
        );
        if crate::storage_identity_transition::enabled() {
            map.insert(
                "knowledgeRootIdentityScheme".into(),
                serde_json::json!(crate::storage_identity_transition::SCHEME),
            );
        }
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
        let Some(path) = self.settings_path.get() else {
            return Ok(());
        };
        // Missing settings are first launch; unreadable/corrupt settings remain
        // fatal. Only reopening the saved root is a recoverable startup failure.
        let Some(value) = crate::root_recovery::read_settings_value(path).map_err(|error| {
            if error == "StorageCorrupt" {
                "設定JSONが壊れています"
            } else {
                "設定を読み取れません"
            }
        })?
        else {
            return Ok(());
        };
        let saved = crate::root_recovery::SavedRoot::parse(&value)?;
        let _gate = self.gate.lock().unwrap();
        self.restore_root_locked(saved);
        Ok(())
    }
    fn restore_root_locked(self: &Arc<Self>, saved: crate::root_recovery::SavedRoot) {
        use crate::root_recovery::{RecoveryReason, StartupRecovery};
        let scheme_matches = saved.scheme.as_deref()
            == if crate::storage_identity_transition::enabled() {
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
                    (Some(nodes), error)
                }
                Some(Err(err)) => (Some(Vec::new()), Some(err)),
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
            if let Some(nodes) = nodes {
                state.mutation_echoes.clear();
                for tab in state.tabs.values_mut() {
                    if !knowledge::contains(&nodes, &tab.entry) {
                        tab.session = None;
                        tab.revocation += 1;
                    }
                }
                state.snapshot.nodes = nodes;
            }
            let reconcile = structure || error.is_some();
            if error.is_some() {
                state.snapshot.watch_error = error;
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
            return self.select_locked(&canonical, false);
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
            state.mutation_echoes.clear();
            state.snapshot.revision += 1;
            state.snapshot.watch_error = error.or(order_error);
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
        });
        Ok(url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
