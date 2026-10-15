use my_knowledge_backend_tests::{
    core::Core,
    document_server,
    document_state::{self, DocumentState, StateError, StateRequest, StateResponse},
    state_inspection::live,
    workspace_settings::{self, CaptureItem, SessionCapture},
};
use serde_json::{json, Value};
use std::{fs, path::Path, sync::Arc};

fn configured_core(profile: &Path, port: u16, persistent: bool) -> Arc<Core> {
    let core = Core::new_with_storage_identity_policy(port, persistent);
    core.settings_path
        .set(profile.join("settings.json"))
        .unwrap();
    assert!(core
        .document_state
        .set(DocumentState::new(profile.join("document-state")).unwrap())
        .is_ok());
    core
}

struct Fixture {
    temporary: tempfile::TempDir,
    root: std::path::PathBuf,
    child: std::path::PathBuf,
    profile: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("knowledge");
        let child = root.join("child");
        let profile = temporary.path().join("profile");
        fs::create_dir_all(&child).unwrap();
        fs::create_dir(&profile).unwrap();
        fs::write(
            child.join("tool.html"),
            "<!doctype html><title>Tool</title>",
        )
        .unwrap();
        Self {
            temporary,
            root,
            child,
            profile,
        }
    }

    fn register(&self, persistent: bool) -> Arc<Core> {
        let core = configured_core(&self.profile, 19160, persistent);
        core.select(&self.root, true).unwrap();
        core.watcher.lock().unwrap().take();
        core
    }

    fn database(&self) -> std::path::PathBuf {
        self.profile.join("document-state/state.sqlite")
    }
}

fn open(core: &Core, entry: &str) -> (String, String) {
    let snapshot = core.snapshot();
    let workspace = snapshot.workspace_id.unwrap();
    let tab = core
        .create_tab(&workspace, &snapshot.view_id, entry)
        .unwrap();
    let url = core.open(&workspace, &snapshot.view_id, &tab, 1).unwrap();
    let (token, _) = document_server::decode_path(url.strip_prefix(&core.origin).unwrap()).unwrap();
    (tab, token)
}

fn request(operation: &str, value: Option<Value>) -> StateRequest {
    let mut request = json!({"version":1,"op":operation,"key":"inputs"});
    if let Some(value) = value {
        request["value"] = value;
    }
    serde_json::from_value(request).unwrap()
}

fn operate(core: &Core, token: &str, operation: &str, value: Option<Value>) -> StateResponse {
    document_state::operate(core, token, request(operation, value)).unwrap()
}

fn display(core: &Arc<Core>, path: &Path) {
    let snapshot = core.snapshot();
    core.select_display_path(
        snapshot.workspace_id.as_deref().unwrap(),
        &snapshot.view_id,
        path,
        true,
    )
    .unwrap();
}

#[test]
fn parent_child_display_switch_keeps_registered_root_and_live_save_destination() {
    for persistent in [false, true] {
        if !persistent && cfg!(target_os = "macos") {
            continue;
        }
        let fixture = Fixture::new();
        let core = fixture.register(persistent);
        let (tab, token) = open(&core, "child/tool.html");
        let identity = core
            .session_for_token(&token)
            .unwrap()
            .storage_identity
            .unwrap();
        let registered = core.snapshot();
        let saved = json!({"number":42,"text":"preserved"});
        operate(&core, &token, "write", Some(saved.clone()));
        display(&core, &fixture.child);
        assert_eq!(core.snapshot().root_path, registered.root_path);
        assert_eq!(core.snapshot().workspace_id, registered.workspace_id);
        assert_eq!(core.snapshot().view_id, registered.view_id);
        assert_eq!(
            core.snapshot().display_folder.unwrap().relative_path,
            "child"
        );
        assert_eq!(
            core.session_for_token(&token)
                .unwrap()
                .storage_identity
                .as_deref(),
            Some(identity.as_str())
        );
        assert_eq!(operate(&core, &token, "read", None).value, saved);

        // A delayed save belongs to the admitted document, even after its tree range changes.
        let latest = json!({"number":43,"text":"late save"});
        assert_eq!(
            operate(&core, &token, "write", Some(latest.clone())).revision,
            2
        );
        display(&core, &fixture.root);
        assert!(core.snapshot().display_folder.is_none());
        assert_eq!(operate(&core, &token, "read", None).value, latest);
        workspace_settings::capture_session(
            &core,
            registered.workspace_id.as_deref().unwrap(),
            &registered.view_id,
            SessionCapture {
                items: vec![CaptureItem {
                    tab_id: Some(tab),
                    document: None,
                    column: 0,
                    zoom: 100.0,
                }],
                active: [Some(0), None],
                active_column: 0,
                split: false,
                help: None,
            },
        )
        .unwrap();
        display(&core, &fixture.child);
        let settings: Value =
            serde_json::from_slice(&fs::read(fixture.profile.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(
            Path::new(settings["knowledgeRoot"].as_str().unwrap()),
            fixture.root.canonicalize().unwrap()
        );
        drop(core);

        let restarted = configured_core(&fixture.profile, 19161, persistent);
        restarted.restore().unwrap();
        restarted.watcher.lock().unwrap().take();
        let restored = restarted.snapshot();
        assert_eq!(restored.root_path, registered.root_path);
        assert_eq!(restored.display_folder.unwrap().relative_path, "child");
        let session = workspace_settings::get_session(
            &restarted,
            restored.workspace_id.as_deref().unwrap(),
            &restored.view_id,
        )
        .unwrap()
        .unwrap();
        assert_eq!(session.items[0].document.relative_path, "child/tool.html");
        assert_eq!(session.items[0].document.identity, identity);
        let (_, reopened) = open(&restarted, "child/tool.html");
        assert_eq!(
            restarted
                .session_for_token(&reopened)
                .unwrap()
                .storage_identity
                .as_deref(),
            Some(identity.as_str())
        );
        assert_eq!(operate(&restarted, &reopened, "read", None).value, latest);
        assert_eq!(
            document_state::operate(&restarted, &token, request("write", Some(json!("stale"))))
                .unwrap_err(),
            StateError::Revoked
        );
    }
}

#[test]
fn outside_and_parent_display_selection_never_replace_registered_root() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    let before = core.snapshot();
    let settings = fs::read(fixture.profile.join("settings.json")).unwrap();
    let outside = fixture.temporary.path().join("other");
    fs::create_dir(&outside).unwrap();
    let outside_paths: [&Path; 2] = [&outside, fixture.root.parent().unwrap()];
    for path in outside_paths {
        assert_eq!(
            core.select_display_path(
                before.workspace_id.as_deref().unwrap(),
                &before.view_id,
                path,
                true
            )
            .err()
            .unwrap(),
            "DisplayFolderOutsideRegisteredRoot"
        );
        assert_eq!(core.snapshot().root_path, before.root_path);
        assert_eq!(core.snapshot().workspace_id, before.workspace_id);
        assert_eq!(
            fs::read(fixture.profile.join("settings.json")).unwrap(),
            settings
        );
    }
    // Registering a child does not authorize its parent as a display range.
    core.select(&fixture.child, true).unwrap();
    core.watcher.lock().unwrap().take();
    let child_registered = core.snapshot();
    let child_settings = fs::read(fixture.profile.join("settings.json")).unwrap();
    assert_eq!(
        core.select_display_path(
            child_registered.workspace_id.as_deref().unwrap(),
            &child_registered.view_id,
            &fixture.root,
            true
        )
        .err()
        .unwrap(),
        "DisplayFolderOutsideRegisteredRoot"
    );
    assert_eq!(core.snapshot().root_path, child_registered.root_path);
    assert_eq!(
        fs::read(fixture.profile.join("settings.json")).unwrap(),
        child_settings
    );
    assert_eq!(
        core.select_display_folder("stale-workspace", &child_registered.view_id, "", true)
            .err()
            .unwrap(),
        "WorkspaceChanged"
    );
    assert_eq!(
        core.select_display_folder(
            child_registered.workspace_id.as_deref().unwrap(),
            "stale-view",
            "",
            true
        )
        .err()
        .unwrap(),
        "ViewChanged"
    );
}

#[test]
fn duplicate_document_tabs_keep_one_identity_and_serialized_revisions() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    let (_, first) = open(&core, "child/tool.html");
    let (_, second) = open(&core, "child/tool.html");
    assert_ne!(first, second);
    assert_eq!(
        core.session_for_token(&first).unwrap().storage_identity,
        core.session_for_token(&second).unwrap().storage_identity
    );
    assert_eq!(operate(&core, &first, "write", Some(json!(1))).revision, 1);
    display(&core, &fixture.child);
    assert_eq!(operate(&core, &second, "read", None).value, json!(1));
    assert_eq!(operate(&core, &second, "write", Some(json!(2))).revision, 2);
    display(&core, &fixture.root);
    let current = operate(&core, &first, "read", None);
    assert_eq!(current.value, json!(2));
    assert_eq!(current.revision, 2);
    let count: i64 = rusqlite::Connection::open(fixture.database())
        .unwrap()
        .query_row("SELECT count(*) FROM documents", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn fresh_persistent_policy_registers_and_saves_without_legacy_migration() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    assert!(core.snapshot().storage_hold.is_none());
    let (_, token) = open(&core, "child/tool.html");
    assert!(core
        .session_for_token(&token)
        .unwrap()
        .storage_hold
        .is_none());
    assert!(operate(&core, &token, "read", None).value.is_null());
    operate(&core, &token, "write", Some(json!({"input":"first save"})));
    let connection = rusqlite::Connection::open(fixture.database()).unwrap();
    let (version, roots, confirmations): (i64,i64,i64) = connection.query_row("SELECT (SELECT user_version FROM pragma_user_version),(SELECT count(*) FROM identity_roots),(SELECT count(*) FROM identity_confirmations)", [], |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?))).unwrap();
    assert_eq!((version, roots, confirmations), (3, 1, 1));
}

#[test]
fn existing_unconfirmed_values_allow_browsing_but_all_storage_mutations_are_held() {
    let fixture = Fixture::new();
    drop(DocumentState::new(fixture.profile.join("document-state")).unwrap());
    let connection = rusqlite::Connection::open(fixture.database()).unwrap();
    let data = json!({"inputs":{"important":"preserve"}}).to_string();
    connection
        .execute(
            "INSERT INTO documents VALUES(?1,?2,?3,1,?4,'child/tool.html',1)",
            rusqlite::params!["a".repeat(64), data, data.len() as i64, "b".repeat(64)],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE quota SET bytes=?1,documents=1,generation=1",
            [data.len() as i64],
        )
        .unwrap();
    drop(connection);
    let before = fs::read(fixture.database()).unwrap();
    let core = fixture.register(true);
    assert_eq!(
        core.snapshot().storage_hold.unwrap().reason,
        "StorageIdentityConfirmationRequired"
    );
    let (_, token) = open(&core, "child/tool.html");
    assert!(core
        .session_for_token(&token)
        .unwrap()
        .storage_hold
        .is_some());
    display(&core, &fixture.child);
    for operation in ["read", "write", "delete"] {
        let value = (operation == "write").then(|| json!("default must not overwrite"));
        assert_eq!(
            document_state::operate(&core, &token, request(operation, value)).unwrap_err(),
            StateError::IdentityConfirmationRequired
        );
    }
    let snapshot = core.snapshot();
    let context = live::Context {
        workspace_id: snapshot.workspace_id,
        view_id: snapshot.view_id,
    };
    let inspected = live::inspect(
        &core,
        live::PageRequest {
            context: context.clone(),
            offset: 0,
            limit: 20,
            snapshot_id: None,
            query: None,
        },
        false,
    )
    .unwrap();
    let clear = live::prepare(
        &core,
        live::PrepareRequest {
            context,
            operation: live::Operation::Quarantine,
            candidate_id: Some("a".repeat(64)),
            candidate_ids: None,
            snapshot_id: inspected["snapshotId"].as_str().unwrap().into(),
        },
    );
    assert_eq!(
        serde_json::to_value(clear.err().unwrap()).unwrap()["code"],
        "storage_identity_confirmation_required"
    );
    drop(core);
    assert_eq!(fs::read(fixture.database()).unwrap(), before);
}

#[test]
fn corrupt_or_unreadable_database_never_becomes_a_fresh_registration() {
    for corrupt in [true, false] {
        let fixture = Fixture::new();
        fs::create_dir(fixture.profile.join("document-state")).unwrap();
        if corrupt {
            fs::write(fixture.database(), b"not a SQLite database").unwrap();
        } else {
            fs::create_dir(fixture.database()).unwrap();
        }
        assert!(DocumentState::new(fixture.profile.join("document-state")).is_err());
        let core = Core::new_with_storage_identity_policy(19160, true);
        core.settings_path
            .set(fixture.profile.join("settings.json"))
            .unwrap();
        core.select(&fixture.root, true).unwrap();
        core.watcher.lock().unwrap().take();
        assert_eq!(
            core.snapshot().storage_hold.unwrap().reason,
            "StorageUnavailable"
        );
        let (_, token) = open(&core, "child/tool.html");
        assert!(
            document_state::operate(&core, &token, request("write", Some(json!("default"))))
                .is_err()
        );
        if corrupt {
            assert_eq!(
                fs::read(fixture.database()).unwrap(),
                b"not a SQLite database"
            );
        } else {
            assert!(fixture.database().is_dir());
        }
    }
}

#[test]
fn a_preconfirmation_grant_never_gains_write_authority_from_later_confirmation() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    let (_, confirmed) = open(&core, "child/tool.html");
    operate(&core, &confirmed, "write", Some(json!("original")));
    let connection = rusqlite::Connection::open(fixture.database()).unwrap();
    connection.execute_batch("CREATE TEMP TABLE saved_confirmation AS SELECT * FROM identity_confirmations; DELETE FROM identity_confirmations;").unwrap();
    let (held_tab, held) = open(&core, "child/tool.html");
    let snapshot = core.snapshot();
    let workspace = snapshot.workspace_id.as_deref().unwrap();
    assert!(core
        .session_for_token(&held)
        .unwrap()
        .storage_hold
        .is_some());
    assert_eq!(
        core.document_storage_hold(workspace, &snapshot.view_id, &held_tab, 1)
            .unwrap()
            .unwrap()
            .reason,
        "StorageIdentityConfirmationRequired"
    );
    assert_eq!(
        document_state::operate(&core, &held, request("read", None)).unwrap_err(),
        StateError::IdentityConfirmationRequired
    );
    connection
        .execute(
            "INSERT INTO identity_confirmations SELECT * FROM saved_confirmation",
            [],
        )
        .unwrap();
    let before = fs::read(fixture.database()).unwrap();
    assert_eq!(
        core.document_storage_hold(workspace, &snapshot.view_id, &held_tab, 1)
            .unwrap()
            .unwrap()
            .reason,
        "StorageIdentityConfirmationRequired"
    );
    for operation in ["read", "write", "delete"] {
        assert_eq!(
            document_state::operate(
                &core,
                &held,
                request(
                    operation,
                    (operation == "write").then(|| json!("stale default"))
                )
            )
            .unwrap_err(),
            StateError::IdentityConfirmationRequired
        );
    }
    assert_eq!(fs::read(fixture.database()).unwrap(), before);
    let (new_tab, new_grant) = open(&core, "child/tool.html");
    assert!(core
        .session_for_token(&new_grant)
        .unwrap()
        .storage_hold
        .is_none());
    assert!(core
        .document_storage_hold(workspace, &snapshot.view_id, &new_tab, 1)
        .unwrap()
        .is_none());
    assert_eq!(
        operate(&core, &new_grant, "read", None).value,
        json!("original")
    );
    core.open(workspace, &snapshot.view_id, &held_tab, 2)
        .unwrap();
    assert_eq!(
        core.document_storage_hold(workspace, &snapshot.view_id, &held_tab, 1)
            .err()
            .unwrap(),
        "Superseded"
    );
    assert!(core
        .document_storage_hold(workspace, &snapshot.view_id, &held_tab, 2)
        .unwrap()
        .is_none());
    assert_eq!(
        core.document_storage_hold("stale-workspace", &snapshot.view_id, &held_tab, 2)
            .err()
            .unwrap(),
        "WorkspaceChanged"
    );
    assert_eq!(
        core.document_storage_hold(workspace, "stale-view", &held_tab, 2)
            .err()
            .unwrap(),
        "ViewChanged"
    );
    core.close_tab(workspace, &snapshot.view_id, &held_tab)
        .unwrap();
    assert_eq!(
        core.document_storage_hold(workspace, &snapshot.view_id, &held_tab, 2)
            .err()
            .unwrap(),
        "TabClosed"
    );
}

#[test]
fn a_historical_root_confirmation_never_auto_binds_an_unconfirmed_document() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    let (_, existing) = open(&core, "child/tool.html");
    operate(&core, &existing, "write", Some(json!("retained")));
    fs::write(
        fixture.child.join("new.html"),
        "<!doctype html><title>New</title>",
    )
    .unwrap();
    let connection = rusqlite::Connection::open(fixture.database()).unwrap();
    connection
        .execute(
            "UPDATE identity_roots SET backup_hash=?1,operation=?2",
            rusqlite::params!["c".repeat(64), "d".repeat(64)],
        )
        .unwrap();
    drop(connection);
    core.refresh().unwrap();
    core.watcher.lock().unwrap().take();
    let (_, reopened) = open(&core, "child/tool.html");
    assert_eq!(
        operate(&core, &reopened, "read", None).value,
        json!("retained")
    );
    let before = fs::read(fixture.database()).unwrap();
    let (_, new_document) = open(&core, "child/new.html");
    assert!(core
        .session_for_token(&new_document)
        .unwrap()
        .storage_hold
        .is_some());
    assert_eq!(
        document_state::operate(
            &core,
            &new_document,
            request("write", Some(json!("unconfirmed")))
        )
        .unwrap_err(),
        StateError::IdentityConfirmationRequired
    );
    assert_eq!(fs::read(fixture.database()).unwrap(), before);
}

#[test]
fn changed_saved_display_identity_restores_registered_root_without_rebinding_or_rewriting() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    display(&core, &fixture.child);
    drop(core);
    let settings_path = fixture.profile.join("settings.json");
    let mut settings: Value = serde_json::from_slice(&fs::read(&settings_path).unwrap()).unwrap();
    settings["knowledgeDisplayFolder"]["identity"] = json!("f".repeat(64));
    let before = serde_json::to_vec(&settings).unwrap();
    fs::write(&settings_path, &before).unwrap();
    let restarted = configured_core(&fixture.profile, 19161, true);
    restarted.restore().unwrap();
    restarted.watcher.lock().unwrap().take();
    let restored = restarted.snapshot();
    assert_eq!(
        Path::new(restored.root_path.as_deref().unwrap()),
        fixture.root.canonicalize().unwrap()
    );
    assert!(restored.display_folder.is_none());
    assert_eq!(
        restored.watch_error.as_deref(),
        Some("DisplayFolderIdentityChanged")
    );
    assert_eq!(fs::read(settings_path).unwrap(), before);
}

#[test]
fn failed_display_persistence_preserves_live_range_and_document_destination() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    let (_, token) = open(&core, "child/tool.html");
    let identity = core.session_for_token(&token).unwrap().storage_identity;
    operate(&core, &token, "write", Some(json!("retained")));
    let before = core.snapshot();
    let settings = fixture.profile.join("settings.json");
    let backup = fixture.profile.join("settings-before.json");
    let settings_bytes = fs::read(&settings).unwrap();
    fs::rename(&settings, &backup).unwrap();
    fs::create_dir(&settings).unwrap();
    assert!(core
        .select_display_path(
            before.workspace_id.as_deref().unwrap(),
            &before.view_id,
            &fixture.child,
            true
        )
        .is_err());
    let after = core.snapshot();
    assert!(after.display_folder.is_none());
    assert_eq!(after.workspace_id, before.workspace_id);
    assert_eq!(after.root_path, before.root_path);
    assert_eq!(
        core.session_for_token(&token).unwrap().storage_identity,
        identity
    );
    assert_eq!(
        operate(&core, &token, "read", None).value,
        json!("retained")
    );
    assert_eq!(fs::read(backup).unwrap(), settings_bytes);
}

#[test]
fn changed_registered_root_identity_never_restores_by_path_alone() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    let (_, token) = open(&core, "child/tool.html");
    operate(&core, &token, "write", Some(json!("retained")));
    drop(core);
    let database_bytes = fs::read(fixture.database()).unwrap();
    let settings_path = fixture.profile.join("settings.json");
    let mut settings: Value = serde_json::from_slice(&fs::read(&settings_path).unwrap()).unwrap();
    settings["knowledgeRootIdentity"] = json!("f".repeat(64));
    let before = serde_json::to_vec(&settings).unwrap();
    fs::write(&settings_path, &before).unwrap();
    let restarted = configured_core(&fixture.profile, 19161, true);
    restarted.restore().unwrap();
    assert!(restarted.snapshot().root_path.is_none());
    assert!(restarted.snapshot().startup_recovery.is_some());
    assert_eq!(fs::read(settings_path).unwrap(), before);
    assert_eq!(fs::read(fixture.database()).unwrap(), database_bytes);
}

#[test]
fn replacing_the_display_folder_falls_back_without_rebinding_live_tabs_or_saved_values() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    let (tab, token) = open(&core, "child/tool.html");
    let identity = core
        .session_for_token(&token)
        .unwrap()
        .storage_identity
        .unwrap();
    operate(
        &core,
        &token,
        "write",
        Some(json!("original physical document")),
    );
    display(&core, &fixture.child);
    let before = core.snapshot();
    let settings_bytes = fs::read(fixture.profile.join("settings.json")).unwrap();
    let database_bytes = fs::read(fixture.database()).unwrap();
    fs::rename(&fixture.child, fixture.root.join("previous-child")).unwrap();
    fs::create_dir(&fixture.child).unwrap();
    fs::write(
        fixture.child.join("tool.html"),
        "<!doctype html><title>Replacement</title>",
    )
    .unwrap();
    core.refresh().unwrap();
    core.watcher.lock().unwrap().take();
    let after = core.snapshot();
    assert_eq!(after.root_path, before.root_path);
    assert_eq!(after.workspace_id, before.workspace_id);
    assert!(after.display_folder.is_none());
    assert_eq!(
        after.watch_error.as_deref(),
        Some("DisplayFolderIdentityChanged")
    );
    assert_eq!(
        core.workspace.lock().unwrap().tabs[&tab]
            .admitted_document
            .as_ref()
            .unwrap()
            .identity,
        identity
    );
    let stale = document_state::operate(
        &core,
        &token,
        request("write", Some(json!("replacement default"))),
    )
    .unwrap_err();
    assert!(matches!(
        stale,
        StateError::Revoked | StateError::IdentityChanged
    ));
    assert_eq!(
        fs::read(fixture.profile.join("settings.json")).unwrap(),
        settings_bytes
    );
    assert_eq!(fs::read(fixture.database()).unwrap(), database_bytes);
}

#[test]
fn a_stale_registration_picker_cannot_replace_a_newer_view_or_registered_root() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    let before = core.snapshot();
    let other = fixture.temporary.path().join("other-root");
    fs::create_dir(&other).unwrap();
    let settings = fs::read(fixture.profile.join("settings.json")).unwrap();
    let new_view = core.begin_view();
    assert_eq!(
        core.select_if_current(
            before.workspace_id.as_deref(),
            &before.view_id,
            &other,
            true
        )
        .err()
        .unwrap(),
        "ViewChanged"
    );
    assert_eq!(core.snapshot().root_path, before.root_path);
    assert_eq!(core.snapshot().view_id, new_view.view_id);
    assert_eq!(
        fs::read(fixture.profile.join("settings.json")).unwrap(),
        settings
    );

    core.select(&other, true).unwrap();
    core.watcher.lock().unwrap().take();
    let new_registration = core.snapshot();
    let new_settings = fs::read(fixture.profile.join("settings.json")).unwrap();
    assert_eq!(
        core.select_if_current(
            before.workspace_id.as_deref(),
            &new_view.view_id,
            &fixture.root,
            true
        )
        .err()
        .unwrap(),
        "WorkspaceChanged"
    );
    assert_eq!(core.snapshot().root_path, new_registration.root_path);
    assert_eq!(core.snapshot().workspace_id, new_registration.workspace_id);
    assert_eq!(
        fs::read(fixture.profile.join("settings.json")).unwrap(),
        new_settings
    );
}

#[test]
fn a_missing_database_after_registration_is_never_recreated_as_empty_state() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    let (_, token) = open(&core, "child/tool.html");
    operate(&core, &token, "write", Some(json!("independent original")));
    drop(core);
    let backup = fixture.profile.join("state-before.sqlite");
    let database_bytes = fs::read(fixture.database()).unwrap();
    let settings_bytes = fs::read(fixture.profile.join("settings.json")).unwrap();
    fs::rename(fixture.database(), &backup).unwrap();

    for _ in 0..2 {
        assert!(DocumentState::new(fixture.profile.join("document-state")).is_err());
        assert!(!fixture.database().exists());
        let restarted = Core::new_with_storage_identity_policy(19161, true);
        restarted
            .settings_path
            .set(fixture.profile.join("settings.json"))
            .unwrap();
        restarted.restore().unwrap();
        restarted.watcher.lock().unwrap().take();
        assert_eq!(
            restarted.snapshot().storage_hold.unwrap().reason,
            "StorageUnavailable"
        );
        let (_, held) = open(&restarted, "child/tool.html");
        for operation in ["read", "write", "delete"] {
            assert!(document_state::operate(
                &restarted,
                &held,
                request(operation, (operation == "write").then(|| json!("default")))
            )
            .is_err());
        }
        assert!(!fixture.database().exists());
        assert_eq!(
            fs::read(fixture.profile.join("settings.json")).unwrap(),
            settings_bytes
        );
        assert_eq!(fs::read(&backup).unwrap(), database_bytes);
    }
}

#[test]
fn a_fresh_profile_with_only_language_preferences_can_initialize_storage() {
    let fixture = Fixture::new();
    fs::write(
        fixture.profile.join("settings.json"),
        b"{\"language\":\"en\"}",
    )
    .unwrap();
    let core = fixture.register(true);
    assert!(core.snapshot().storage_hold.is_none());
    let (_, token) = open(&core, "child/tool.html");
    assert_eq!(
        operate(&core, &token, "write", Some(json!("first value"))).revision,
        1
    );
    let settings: Value =
        serde_json::from_slice(&fs::read(fixture.profile.join("settings.json")).unwrap()).unwrap();
    assert_eq!(settings["language"], "en");
}

#[test]
fn malformed_registration_settings_never_authorize_an_empty_replacement_database() {
    let mut settings_cases: Vec<Vec<u8>> = [
        json!({"knowledgeRoot": 17}),
        json!({"knowledgeRoot": {"unexpected": true}}),
        json!({"knowledgeRoot": null}),
        json!({"knowledgeRoot": ""}),
        json!({"knowledgeRootIdentity": null}),
        json!({"knowledgeRootIdentityScheme": false}),
    ]
    .into_iter()
    .map(|settings| serde_json::to_vec(&settings).unwrap())
    .collect();
    settings_cases.push(b"{invalid JSON".to_vec());
    for settings in settings_cases {
        let fixture = Fixture::new();
        let settings_path = fixture.profile.join("settings.json");
        fs::write(&settings_path, &settings).unwrap();
        assert!(DocumentState::new(fixture.profile.join("document-state")).is_err());
        assert!(!fixture.database().exists());
        assert_eq!(fs::read(settings_path).unwrap(), settings);
    }
}

#[test]
fn queued_display_requests_cannot_overwrite_a_more_recent_display_choice() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    let (tab, token) = open(&core, "child/tool.html");
    let identity = core.session_for_token(&token).unwrap().storage_identity;
    operate(&core, &token, "write", Some(json!("retained")));
    let original = core.snapshot();
    assert_eq!(original.display_revision, 0);
    let workspace = original.workspace_id.as_deref().unwrap();
    core.select_display_folder_if_current(
        workspace,
        &original.view_id,
        original.display_revision,
        "child",
        true,
    )
    .unwrap();
    let current = core.snapshot();
    assert_eq!(current.display_revision, 1);
    let settings_bytes = fs::read(fixture.profile.join("settings.json")).unwrap();
    let database_bytes = fs::read(fixture.database()).unwrap();

    assert_eq!(
        core.select_display_path_if_current(
            workspace,
            &original.view_id,
            original.display_revision,
            &fixture.root,
            true
        )
        .err()
        .unwrap(),
        "DisplayFolderChanged"
    );
    assert_eq!(
        core.select_display_folder_if_current(
            workspace,
            &original.view_id,
            original.display_revision,
            "",
            true
        )
        .err()
        .unwrap(),
        "DisplayFolderChanged"
    );
    let after = core.snapshot();
    assert_eq!(after.display_folder, current.display_folder);
    assert_eq!(after.display_revision, current.display_revision);
    assert_eq!(after.root_path, current.root_path);
    assert_eq!(after.workspace_id, current.workspace_id);
    assert!(core.workspace.lock().unwrap().tabs.contains_key(&tab));
    assert_eq!(
        core.session_for_token(&token).unwrap().storage_identity,
        identity
    );
    assert_eq!(
        operate(&core, &token, "read", None).value,
        json!("retained")
    );
    assert_eq!(
        fs::read(fixture.profile.join("settings.json")).unwrap(),
        settings_bytes
    );
    assert_eq!(fs::read(fixture.database()).unwrap(), database_bytes);
}

#[test]
fn registration_settings_in_a_separate_config_directory_protect_a_missing_database() {
    let fixture = Fixture::new();
    let config = fixture.temporary.path().join("app-config");
    fs::create_dir(&config).unwrap();
    let settings_path = config.join("settings.json");
    let settings_bytes = serde_json::to_vec(&json!({
        "knowledgeRoot": fixture.root,
        "knowledgeRootIdentity": "a".repeat(64)
    }))
    .unwrap();
    fs::write(&settings_path, &settings_bytes).unwrap();
    for _ in 0..2 {
        assert!(DocumentState::new_in_profile_with_settings(
            fixture.profile.join("document-state"),
            fixture.profile.clone(),
            settings_path.clone(),
        )
        .is_err());
        assert!(!fixture.database().exists());
        assert_eq!(fs::read(&settings_path).unwrap(), settings_bytes);
    }
}

#[test]
fn invalid_separate_config_settings_never_authorize_a_missing_database() {
    let mut settings_cases: Vec<Vec<u8>> = [
        json!({"knowledgeRoot": 17}),
        json!({"knowledgeRoot": {"unexpected": true}}),
        json!({"knowledgeRoot": null}),
        json!({"knowledgeRoot": ""}),
        json!({"knowledgeRootIdentity": null}),
        json!({"knowledgeRootIdentityScheme": false}),
        json!([]),
    ]
    .into_iter()
    .map(|settings| serde_json::to_vec(&settings).unwrap())
    .collect();
    settings_cases.push(b"{invalid JSON".to_vec());
    for settings_bytes in settings_cases {
        let fixture = Fixture::new();
        let config = fixture.temporary.path().join("app-config");
        fs::create_dir(&config).unwrap();
        let settings_path = config.join("settings.json");
        fs::write(&settings_path, &settings_bytes).unwrap();
        let local_settings = fixture.profile.join("settings.json");
        let local_bytes = br#"{"language":"en"}"#;
        fs::write(&local_settings, local_bytes).unwrap();
        for _ in 0..2 {
            assert!(DocumentState::new_in_profile_with_settings(
                fixture.profile.join("document-state"),
                fixture.profile.clone(),
                settings_path.clone(),
            )
            .is_err());
            assert!(!fixture.database().exists());
            assert_eq!(fs::read(&settings_path).unwrap(), settings_bytes);
            assert_eq!(fs::read(&local_settings).unwrap(), local_bytes);
        }
    }
}

#[test]
fn unreadable_separate_config_settings_never_authorize_a_missing_database() {
    let fixture = Fixture::new();
    let settings_path = fixture.temporary.path().join("app-config/settings.json");
    // A directory at the settings leaf models an unreadable settings file on
    // every platform without changing process privileges or OS permissions.
    fs::create_dir_all(&settings_path).unwrap();
    let retained = settings_path.join("retained");
    fs::write(&retained, b"unrecognized settings must survive").unwrap();
    for _ in 0..2 {
        assert!(DocumentState::new_in_profile_with_settings(
            fixture.profile.join("document-state"),
            fixture.profile.clone(),
            settings_path.clone(),
        )
        .is_err());
        assert!(!fixture.database().exists());
        assert!(settings_path.is_dir());
        assert_eq!(
            fs::read(&retained).unwrap(),
            b"unrecognized settings must survive"
        );
    }
}

#[cfg(windows)]
#[test]
fn a_failed_separate_config_read_does_not_authorize_a_missing_database() {
    use std::os::windows::fs::OpenOptionsExt;

    let fixture = Fixture::new();
    let config = fixture.temporary.path().join("app-config");
    fs::create_dir(&config).unwrap();
    let settings_path = config.join("settings.json");
    let settings_bytes = br#"{"language":"en"}"#;
    fs::write(&settings_path, settings_bytes).unwrap();
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&settings_path)
        .unwrap();
    for _ in 0..2 {
        assert!(DocumentState::new_in_profile_with_settings(
            fixture.profile.join("document-state"),
            fixture.profile.clone(),
            settings_path.clone(),
        )
        .is_err());
        assert!(!fixture.database().exists());
    }
    drop(locked);
    assert_eq!(fs::read(&settings_path).unwrap(), settings_bytes);
}

#[test]
fn separate_config_preferences_allow_first_storage_and_preserve_saved_values_on_restart() {
    let fixture = Fixture::new();
    let config = fixture.temporary.path().join("app-config");
    fs::create_dir(&config).unwrap();
    let settings_path = config.join("settings.json");
    fs::write(&settings_path, br#"{"language":"en"}"#).unwrap();
    let local_settings = fixture.profile.join("settings.json");
    let local_bytes = br#"{"language":"ja"}"#;
    fs::write(&local_settings, local_bytes).unwrap();
    let saved = json!({"number": 43, "text": "separate config retained"});
    for restart in [false, true] {
        let core = Core::new_with_storage_identity_policy(19162, true);
        core.settings_path.set(settings_path.clone()).unwrap();
        assert!(core
            .document_state
            .set(
                DocumentState::new_in_profile_with_settings(
                    fixture.profile.join("document-state"),
                    fixture.profile.clone(),
                    settings_path.clone(),
                )
                .unwrap(),
            )
            .is_ok());
        if restart {
            core.restore().unwrap();
        } else {
            core.select(&fixture.root, true).unwrap();
        }
        core.watcher.lock().unwrap().take();
        assert!(core.snapshot().storage_hold.is_none());
        let (_, token) = open(&core, "child/tool.html");
        if restart {
            assert_eq!(operate(&core, &token, "read", None).value, saved);
        } else {
            assert_eq!(
                operate(&core, &token, "write", Some(saved.clone())).revision,
                1
            );
        }
        let settings: Value = serde_json::from_slice(&fs::read(&settings_path).unwrap()).unwrap();
        assert_eq!(settings["language"], "en");
        assert_eq!(fs::read(&local_settings).unwrap(), local_bytes);
    }
}

#[test]
fn actual_config_preferences_do_not_bypass_legacy_local_registration() {
    let fixture = Fixture::new();
    let config = fixture.temporary.path().join("app-config");
    fs::create_dir(&config).unwrap();
    let settings_path = config.join("settings.json");
    let actual_bytes = br#"{"language":"en"}"#;
    fs::write(&settings_path, actual_bytes).unwrap();
    let local_settings = fixture.profile.join("settings.json");
    let local_bytes = serde_json::to_vec(&json!({"knowledgeRoot": fixture.root})).unwrap();
    fs::write(&local_settings, &local_bytes).unwrap();
    for _ in 0..2 {
        assert!(DocumentState::new_in_profile_with_settings(
            fixture.profile.join("document-state"),
            fixture.profile.clone(),
            settings_path.clone(),
        )
        .is_err());
        assert!(!fixture.database().exists());
        assert_eq!(fs::read(&settings_path).unwrap(), actual_bytes);
        assert_eq!(fs::read(&local_settings).unwrap(), local_bytes);
    }
}

#[test]
fn separate_config_registration_protects_a_missing_database_inside_a_migration_bundle() {
    let fixture = Fixture::new();
    let core = fixture.register(true);
    let (_, token) = open(&core, "child/tool.html");
    operate(
        &core,
        &token,
        "write",
        Some(json!("independent retained input")),
    );
    drop(core);
    let config = fixture.temporary.path().join("app-config");
    fs::create_dir(&config).unwrap();
    let settings_path = config.join("settings.json");
    fs::rename(fixture.profile.join("settings.json"), &settings_path).unwrap();
    let settings_bytes = fs::read(&settings_path).unwrap();
    let database_bytes = fs::read(fixture.database()).unwrap();
    let backup = fixture.temporary.path().join("independent-state.sqlite");
    fs::rename(fixture.database(), &backup).unwrap();
    let bundled_directory = fixture.profile.join("migration-bundle/document-state");
    let bundled_database = bundled_directory.join("state.sqlite");
    for _ in 0..2 {
        assert!(DocumentState::new_in_profile_with_settings(
            bundled_directory.clone(),
            fixture.profile.clone(),
            settings_path.clone(),
        )
        .is_err());
        assert!(!bundled_database.exists());
        assert!(!fixture.database().exists());
        assert_eq!(fs::read(&settings_path).unwrap(), settings_bytes);
        assert_eq!(fs::read(&backup).unwrap(), database_bytes);
    }
}
