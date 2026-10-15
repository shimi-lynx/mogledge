use crate::{
    core::Core, document_state::DocumentState, root_recovery::RecoveryReason, workspace_settings,
};
use serde_json::json;
use std::{fs, path::PathBuf};

struct Fixture {
    temp: tempfile::TempDir,
    root: PathBuf,
    settings: PathBuf,
    database: PathBuf,
    original_settings: Vec<u8>,
    original_database: Vec<u8>,
    prefs: PathBuf,
    original_prefs: Vec<u8>,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("日本語 空白 root");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("保存.html"), "<input>").unwrap();
        let profile = temp.path().join("profile");
        fs::create_dir(&profile).unwrap();
        let settings = profile.join("settings.json");
        // Normal first launch initializes storage before any root registration.
        // Existing registration with a missing DB must remain a protected loss.
        let state = profile.join("document-state");
        drop(DocumentState::new(state.clone()).unwrap());
        fs::write(
            &settings,
            serde_json::to_vec(&json!({"knowledgeRoot":root,"keep":{"futurePreference":true}}))
                .unwrap(),
        )
        .unwrap();
        let database = state.join("state.sqlite");
        let core = Core::new(0);
        core.settings_path.set(settings.clone()).unwrap();
        core.document_state
            .set(DocumentState::new(state).unwrap())
            .ok()
            .unwrap();
        let registered = crate::managed_folders::register(&core, &root, None, "none").unwrap();
        let value = serde_json::to_value(&registered).unwrap();
        let snapshot = crate::managed_folders::select(
            &core,
            value["folders"][0]["id"].as_str().unwrap(),
            &registered.revision,
        )
        .unwrap();
        core.watcher.lock().unwrap().take();
        workspace_settings::favorite(
            &core,
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            "保存.html",
            true,
        )
        .unwrap();
        workspace_settings::flush(&core).unwrap();
        let dir = core.workspace.lock().unwrap().dir.clone().unwrap();
        let identity = crate::knowledge::storage_root_identity(&dir).unwrap();
        drop(dir);
        drop(core);
        let prefs = profile
            .join("workspace-preferences")
            .join(format!("{identity}.json"));
        let prefs = if prefs.exists() {
            prefs
        } else {
            let candidates = fs::read_dir(&profile)
                .unwrap()
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .filter(|path| path.is_dir())
                .flat_map(|path| {
                    fs::read_dir(path)
                        .unwrap()
                        .filter_map(Result::ok)
                        .map(|entry| entry.path())
                })
                .find(|path| {
                    path.file_name()
                        .is_some_and(|name| name == format!("{identity}.json").as_str())
                });
            candidates.expect("favorite prefs file exists")
        };
        Self {
            original_settings: fs::read(&settings).unwrap(),
            original_database: fs::read(&database).unwrap(),
            original_prefs: fs::read(&prefs).unwrap(),
            temp,
            root,
            settings,
            database,
            prefs,
        }
    }
    fn core(&self) -> std::sync::Arc<Core> {
        let core = Core::new(0);
        core.settings_path.set(self.settings.clone()).unwrap();
        core
    }
    fn preserved(&self) {
        assert_eq!(fs::read(&self.settings).unwrap(), self.original_settings);
        assert_eq!(fs::read(&self.database).unwrap(), self.original_database);
        assert_eq!(fs::read(&self.prefs).unwrap(), self.original_prefs);
    }
}

#[test]
fn renamed_saved_root_detaches_without_data_reset_then_returns_by_identity() {
    let fixture = Fixture::new();
    let moved = fixture.temp.path().join("移動した root");
    fs::rename(&fixture.root, &moved).unwrap();
    let core = fixture.core();
    assert!(core.restore().is_ok());
    let snapshot = core.begin_view();
    assert!(snapshot.workspace_id.is_none());
    assert!(snapshot.nodes.is_empty());
    assert_eq!(
        snapshot.startup_recovery.as_ref().unwrap().reason,
        RecoveryReason::PathUnavailable
    );
    assert!(snapshot.startup_recovery.as_ref().unwrap().can_retry);
    assert!(!fixture.root.exists());
    fixture.preserved();
    assert!(core.workspace.lock().unwrap().tabs.is_empty());
    fs::rename(&moved, &fixture.root).unwrap();
    let restored = core.retry_saved_root(&snapshot.view_id).unwrap();
    core.watcher.lock().unwrap().take();
    assert!(restored.startup_recovery.is_none());
    assert!(restored.workspace_id.is_some());
    assert_eq!(restored.nodes[0].relative_path, "保存.html");
    let lists = workspace_settings::get(
        &core,
        restored.workspace_id.as_ref().unwrap(),
        &restored.view_id,
        false,
    )
    .unwrap();
    assert_eq!(lists.favorites.len(), 1);
    fixture.preserved();
    drop(core);
    let restarted = fixture.core();
    restarted.restore().unwrap();
    restarted.watcher.lock().unwrap().take();
    assert!(restarted.snapshot().startup_recovery.is_none());
    fixture.preserved();
}
#[test]
fn deleted_saved_root_is_not_recreated_and_old_settings_and_sqlite_survive() {
    let fixture = Fixture::new();
    fs::remove_dir_all(&fixture.root).unwrap();
    let core = fixture.core();
    core.restore().unwrap();
    assert!(core.snapshot().workspace_id.is_none());
    assert!(!fixture.root.exists());
    fixture.preserved();
}
#[test]
fn replacement_at_same_path_requires_explicit_selection_and_keeps_old_favorites() {
    let fixture = Fixture::new();
    fs::rename(&fixture.root, fixture.temp.path().join("old")).unwrap();
    fs::create_dir(&fixture.root).unwrap();
    fs::write(fixture.root.join("保存.html"), "new document").unwrap();
    let core = fixture.core();
    core.restore().unwrap();
    assert_eq!(
        core.snapshot().startup_recovery.unwrap().reason,
        RecoveryReason::IdentityChanged
    );
    fixture.preserved();
    let current = core.select(&fixture.root, true).unwrap();
    core.watcher.lock().unwrap().take();
    assert!(current.startup_recovery.is_none());
    assert_eq!(
        workspace_settings::get(
            &core,
            current.workspace_id.as_ref().unwrap(),
            &current.view_id,
            false
        )
        .unwrap()
        .favorites
        .len(),
        0
    );
    assert_eq!(fs::read(&fixture.prefs).unwrap(), fixture.original_prefs);
    let settings: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.settings).unwrap()).unwrap();
    assert_eq!(settings["keep"], json!({"futurePreference":true}));
    assert_eq!(
        fs::read(&fixture.database).unwrap(),
        fixture.original_database
    );
}
#[test]
fn legacy_path_only_requires_confirmation_without_silent_rebinding_or_rewrite() {
    let fixture = Fixture::new();
    fs::remove_file(
        fixture
            .settings
            .parent()
            .unwrap()
            .join("managed-folders.json"),
    )
    .unwrap();
    let old = serde_json::to_vec(&json!({"knowledgeRoot":fixture.root,"keep":true})).unwrap();
    fs::write(&fixture.settings, &old).unwrap();
    let core = fixture.core();
    core.restore().unwrap();
    assert_eq!(
        core.snapshot().startup_recovery.as_ref().unwrap().reason,
        RecoveryReason::ConfirmationRequired
    );
    assert!(!core.snapshot().startup_recovery.unwrap().can_retry);
    assert_eq!(fs::read(&fixture.settings).unwrap(), old);
    let selected = core.select(&fixture.root, true).unwrap();
    core.watcher.lock().unwrap().take();
    assert_eq!(
        workspace_settings::get(
            &core,
            selected.workspace_id.as_ref().unwrap(),
            &selected.view_id,
            false
        )
        .unwrap()
        .favorites
        .len(),
        1
    );
    let config: serde_json::Value =
        serde_json::from_slice(&fs::read(&fixture.settings).unwrap()).unwrap();
    assert!(config["knowledgeRootIdentity"].is_string());
    assert_eq!(config["keep"], true);
}
#[test]
fn corrupt_truncated_or_invalid_settings_remain_errors_without_root_recovery() {
    let fixture = Fixture::new();
    for bytes in [
        b"{\"knowledgeRoot\":".to_vec(),
        b"[]".to_vec(),
        serde_json::to_vec(&json!({"knowledgeRoot":fixture.root,"knowledgeRootIdentity":null}))
            .unwrap(),
        serde_json::to_vec(&json!({"knowledgeRoot":fixture.root,"knowledgeRootIdentity":"bad"}))
            .unwrap(),
    ] {
        fs::write(&fixture.settings, &bytes).unwrap();
        let core = fixture.core();
        assert!(core.restore().is_err());
        assert!(core.snapshot().startup_recovery.is_none());
        assert_eq!(fs::read(&fixture.settings).unwrap(), bytes);
        assert_eq!(
            fs::read(&fixture.database).unwrap(),
            fixture.original_database
        );
    }
    let core = Core::new(0);
    core.settings_path
        .set(fixture.temp.path().to_path_buf())
        .unwrap();
    assert_eq!(core.restore().unwrap_err(), "設定を読み取れません");
}
#[test]
fn retry_is_invalid_after_view_restart_or_another_explicit_root_selection() {
    let fixture = Fixture::new();
    fs::rename(&fixture.root, fixture.temp.path().join("old")).unwrap();
    let core = fixture.core();
    core.restore().unwrap();
    let first = core.begin_view();
    let second = core.begin_view();
    assert_eq!(
        core.retry_saved_root(&first.view_id).err().unwrap(),
        "ViewChanged"
    );
    let other = fixture.temp.path().join("other");
    fs::create_dir(&other).unwrap();
    core.select(&other, true).unwrap();
    core.watcher.lock().unwrap().take();
    assert_eq!(
        core.retry_saved_root(&second.view_id).err().unwrap(),
        "ViewChanged"
    );
    assert!(core.snapshot().startup_recovery.is_none());
    assert_eq!(fs::read(&fixture.prefs).unwrap(), fixture.original_prefs);
}
#[cfg(unix)]
#[test]
fn symlink_saved_root_is_not_followed_when_original_was_moved() {
    let fixture = Fixture::new();
    let moved = fixture.temp.path().join("old");
    fs::rename(&fixture.root, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &fixture.root).unwrap();
    let core = fixture.core();
    core.restore().unwrap();
    assert_eq!(
        core.snapshot().startup_recovery.unwrap().reason,
        RecoveryReason::UnsupportedRoot
    );
    fixture.preserved();
}
