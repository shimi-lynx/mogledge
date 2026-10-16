use super::*;
#[cfg(not(target_os = "macos"))]
use crate::document_state::{self, Operation, StateRequest};
use crate::{core::Core, document_state::DocumentState};
use rusqlite::Connection;
use std::fs;

fn unused_fixture_with_resident_preferences() -> Fixture {
    let fixture = Fixture::new();
    fs::remove_file(fixture.config.join("settings.json")).unwrap();
    fs::remove_file(
        fixture
            .config
            .join(format!("workspace-settings/{}.json", "b".repeat(64))),
    )
    .unwrap();
    let preferences = serde_json::to_vec(&crate::resident_model::Preferences::default()).unwrap();
    fs::write(fixture.config.join("resident.json"), preferences).unwrap();
    let connection = Connection::open(fixture.profile.join("document-state/state.sqlite")).unwrap();
    connection.execute("DELETE FROM documents", []).unwrap();
    connection
        .execute("UPDATE quota SET bytes=0,documents=0,generation=0", [])
        .unwrap();
    fixture
}

#[test]
fn unused_profile_with_resident_settings_requires_backup_and_explicit_root_confirmation() {
    let fixture = unused_fixture_with_resident_preferences();
    let resident = fs::read(fixture.config.join("resident.json")).unwrap();
    let mut session = fixture.session();
    assert_eq!(session.inspect().unwrap()["rootConfirmed"], false);
    assert!(!fixture.config.join("settings.json").exists());
    let preview = session.prepare(None, None).unwrap();
    assert_eq!(
        fs::read(
            fixture
                .backups
                .join(preview["backupDirectory"].as_str().unwrap())
                .join("config/resident.json")
        )
        .unwrap(),
        resident
    );
    assert!(!fixture.config.join("settings.json").exists());
    assert!(session
        .confirm(preview["planId"].as_str().unwrap(), "no consent")
        .is_err());
    let result = session
        .confirm(
            preview["planId"].as_str().unwrap(),
            preview["confirmation"].as_str().unwrap(),
        )
        .unwrap();
    assert_eq!(result["settingsPublished"], true);
    assert_eq!(
        fs::read(fixture.config.join("resident.json")).unwrap(),
        resident
    );
    assert_eq!(session.inspect().unwrap()["rootConfirmed"], true);
}

#[test]
fn missing_settings_never_turns_used_corrupt_or_acknowledged_profiles_into_first_launch() {
    for scenario in [
        "used",
        "corrupt-resident",
        "invalid-settings",
        "recovery-schema",
    ] {
        let fixture = unused_fixture_with_resident_preferences();
        match scenario {
            "used" => {
                Connection::open(fixture.profile.join("document-state/state.sqlite"))
                    .unwrap()
                    .execute("UPDATE quota SET generation=1", [])
                    .unwrap();
            }
            "corrupt-resident" => fs::write(fixture.config.join("resident.json"), b"{}").unwrap(),
            "invalid-settings" => {
                fs::write(fixture.config.join("settings.json"), b"{invalid").unwrap()
            }
            "recovery-schema" => {
                let mut connection =
                    Connection::open(fixture.profile.join("document-state/state.sqlite")).unwrap();
                recovery_store::upgrade(&mut connection, || Ok(())).unwrap();
            }
            _ => unreachable!(),
        }
        let before = fs::read(fixture.profile.join("document-state/state.sqlite")).unwrap();
        let mut session = fixture.session();
        assert!(session.prepare(None, None).is_err(), "{scenario}");
        assert_eq!(
            fs::read(fixture.profile.join("document-state/state.sqlite")).unwrap(),
            before
        );
    }
}

#[test]
fn ui_service_uses_fixed_profile_and_requires_fresh_preview_after_cancel() {
    let fixture = Fixture::new();
    let before = fs::read(fixture.profile.join("document-state/state.sqlite")).unwrap();
    let service = ui::Service::new(fixture.profile.clone(), fixture.config.clone());
    assert!(service.request(json!({"command":"open_session","rootPath":fixture.root,"backupParent":fixture.backups,"profile":"untrusted"})).is_err());
    assert_eq!(
        service.request(json!({"command":"inspect"})).unwrap()["existingDataRetained"],
        true
    );
    assert_eq!(service.request(json!({"command":"open_session","rootPath":fixture.root,"backupParent":fixture.backups})).unwrap()["rootConfirmed"],false);
    let plan = service.request(json!({"command":"prepare_root"})).unwrap();
    service.request(json!({"command":"cancel"})).unwrap();
    assert_eq!(service.request(json!({"command":"confirm","plan_id":plan["planId"],"confirmation":plan["confirmation"]})).unwrap()["retryRequiresNewPreview"],true);
    service.request(json!({"command":"quit"})).unwrap();
    assert_eq!(
        fs::read(fixture.profile.join("document-state/state.sqlite")).unwrap(),
        before
    );
}

#[test]
fn large_synthetic_file_has_scaled_budget_and_can_cancel_without_a_quota() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("large-synthetic-file");
    let file = File::create(&path).unwrap();
    let bytes = 2 * 1024 * 1024 * 1024 + 65536;
    file.set_len(bytes).unwrap();
    drop(file);
    let file = File::open(&path).unwrap();
    assert!(
        super::super::budget::deadline(bytes).duration_since(Instant::now())
            > Duration::from_secs(500)
    );
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let result = super::super::budget::with_cancellation(flag, || {
        digest_file(
            &file,
            crate::storage_limits::absolute_database_bytes().unwrap(),
        )
    });
    assert!(matches!(result, Err(MigrationError::Interrupted)));
    assert_eq!(file.metadata().unwrap().len(), bytes);
}

#[test]
fn confirmed_preference_copy_maps_only_explicit_documents_and_keeps_old_file() {
    let fixture = Fixture::new();
    let path = fixture
        .config
        .join(format!("workspace-settings/{}.json", "b".repeat(64)));
    let old=serde_json::to_vec(&json!({"version":4,"rootIdentity":"b".repeat(64),"lists":{"favorites":[{"relativePath":"old-name.html","identity":fixture.source}],"recent":[{"relativePath":"unconfirmed.html","identity":"c".repeat(64)}]},"sets":[],"folderFavorites":[{"relativePath":"folder","identity":"d".repeat(64)}],"setShortcuts":[null,null,null,null,null,null,null,null,null,null]})).unwrap();
    fs::write(&path, &old).unwrap();
    let mut session = fixture.session();
    fixture.acknowledge_root(&mut session);
    fixture.copy(&mut session);
    let preview = session.prepare_preferences(&"b".repeat(64)).unwrap();
    assert!(!preview.to_string().contains("value"));
    let id = preview["planId"].as_str().unwrap();
    let result = session
        .confirm(id, preview["confirmation"].as_str().unwrap())
        .unwrap();
    assert_eq!(result["status"], "committed");
    let current: Value = serde_json::from_slice(
        &fs::read(fixture.config.join(format!(
            "workspace-settings/{}.json",
            session.root_identity().unwrap()
        )))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        current["lists"]["favorites"][0]["identity"],
        session.document_identity("current.html").unwrap()
    );
    assert_eq!(current["lists"]["recent"][0]["identity"], "c".repeat(64));
    assert_eq!(current["folderFavorites"][0]["identity"], "d".repeat(64));
    assert_eq!(fs::read(path).unwrap(), old);
    assert!(session.prepare_preferences(&"b".repeat(64)).is_err());
    assert_eq!(session.operation_status(id).unwrap()["status"], "committed");
}

#[test]
fn rollback_restores_old_format_and_settings_retains_both_backups_and_survives_restart() {
    let fixture = Fixture::new();
    let old_settings = fs::read(fixture.config.join("settings.json")).unwrap();
    let mut session = fixture.session();
    let root_preview = session.prepare(None, None).unwrap();
    let original = root_preview["backupDirectory"].as_str().unwrap().to_owned();
    session
        .confirm(
            root_preview["planId"].as_str().unwrap(),
            root_preview["confirmation"].as_str().unwrap(),
        )
        .unwrap();
    fixture.copy(&mut session);
    let preview = session.prepare_rollback(&original).unwrap();
    assert!(session
        .confirm(preview["planId"].as_str().unwrap(), "no consent")
        .is_err());
    let id = preview["planId"].as_str().unwrap().to_owned();
    let result = session
        .confirm(&id, preview["confirmation"].as_str().unwrap())
        .unwrap();
    assert_eq!(result["status"], "rolled_back");
    assert_eq!(result["settingsPublished"], true);
    assert_eq!(super::super::version(&session.store.connection).unwrap(), 1);
    assert_eq!(
        session
            .store
            .connection
            .query_row("SELECT count(*) FROM documents", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        management::read_record(&session.store.connection, &fixture.source, false)
            .unwrap()
            .revision,
        7
    );
    assert_eq!(
        fs::read(fixture.config.join("settings.json")).unwrap(),
        old_settings
    );
    assert!(fixture.backups.join(&original).exists());
    assert!(fixture
        .backups
        .join(preview["backupDirectory"].as_str().unwrap())
        .exists());
    drop(session);
    assert_eq!(
        fixture.session().operation_status(&id).unwrap()["status"],
        "rolled_back"
    );
}

#[cfg(windows)]
#[test]
fn rollback_settings_failure_is_reported_and_an_explicit_new_preview_can_repair_it() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let mut session = fixture.session();
    let preview = session.prepare(None, None).unwrap();
    let original = preview["backupDirectory"].as_str().unwrap().to_owned();
    session
        .confirm(
            preview["planId"].as_str().unwrap(),
            preview["confirmation"].as_str().unwrap(),
        )
        .unwrap();
    let before = fs::read(fixture.config.join("settings.json")).unwrap();
    let preview = session.prepare_rollback(&original).unwrap();
    let blocker = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(fixture.config.join("settings.json"))
        .unwrap();
    let result = session
        .confirm(
            preview["planId"].as_str().unwrap(),
            preview["confirmation"].as_str().unwrap(),
        )
        .unwrap();
    assert_eq!(result["status"], "rolled_back");
    assert_eq!(result["settingsPublished"], false);
    assert_eq!(super::super::version(&session.store.connection).unwrap(), 1);
    assert_eq!(
        fs::read(fixture.config.join("settings.json")).unwrap(),
        before
    );
    drop(blocker);
    drop(session);
    let mut session = fixture.session();
    let preview = session.prepare_rollback(&original).unwrap();
    assert_eq!(
        session
            .confirm(
                preview["planId"].as_str().unwrap(),
                preview["confirmation"].as_str().unwrap()
            )
            .unwrap()["settingsPublished"],
        true
    );
}

struct Fixture {
    _temp: tempfile::TempDir,
    profile: PathBuf,
    config: PathBuf,
    root: PathBuf,
    backups: PathBuf,
    source: String,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("profile");
        let config = temp.path().join("config");
        let root = temp.path().join("root");
        let backups = temp.path().join("backups");
        for path in [&profile, &config, &root, &backups] {
            fs::create_dir(path).unwrap();
        }
        fs::write(profile.join("identifier-migration.lock"), b"").unwrap();
        fs::write(root.join("current.html"), b"<input>").unwrap();
        fs::write(root.join("empty.html"), b"<input>").unwrap();
        fs::write(config.join("settings.json"),serde_json::to_vec(&json!({"knowledgeRoot":root,"knowledgeRootIdentity":"b".repeat(64),"keep":{"future":true}})).unwrap()).unwrap();
        fs::create_dir(config.join("workspace-settings")).unwrap();
        fs::write(
            config
                .join("workspace-settings")
                .join(format!("{}.json", "b".repeat(64))),
            b"{\"kept\":true}",
        )
        .unwrap();
        fs::write(config.join("resident.json"), b"{\"kept\":true}").unwrap();
        drop(DocumentState::new(profile.join("document-state")).unwrap());
        let connection =
            rusqlite::Connection::open(profile.join("document-state/state.sqlite")).unwrap();
        let source = "a".repeat(64);
        let data = r#"{"app":{"schemaVersion":1,"data":{"value":"retained"}}}"#;
        connection
            .execute(
                "INSERT INTO documents VALUES(?1,?2,?3,7,?4,'old-name.html',1)",
                params![source, data, data.len() as i64, "b".repeat(64)],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE quota SET bytes=?1,documents=1,generation=1",
                [data.len() as i64],
            )
            .unwrap();
        drop(connection);
        Self {
            _temp: temp,
            profile,
            config,
            root,
            backups,
            source,
        }
    }
    fn session(&self) -> Session {
        Session::open(&self.profile, &self.config, &self.root, &self.backups).unwrap()
    }
    fn acknowledge_root(&self, session: &mut Session) -> String {
        let preview = session.prepare(None, None).unwrap();
        let operation = preview["planId"].as_str().unwrap();
        assert!(session
            .confirm(operation, "missing acknowledgement")
            .is_err());
        let receipt = session
            .confirm(operation, preview["confirmation"].as_str().unwrap())
            .unwrap();
        assert_eq!(receipt["settingsPublished"], true);
        operation.to_owned()
    }
    fn copy(&self, session: &mut Session) -> String {
        let preview = session
            .prepare(Some("current.html"), Some(&self.source))
            .unwrap();
        let operation = preview["planId"].as_str().unwrap();
        let serialized = preview.to_string();
        assert!(!serialized.contains("retained"));
        session
            .confirm(operation, preview["confirmation"].as_str().unwrap())
            .unwrap();
        operation.to_owned()
    }
    // Windows-native identities stand in for the candidate ID provider. The
    // authenticated state API and actual database format/guards are unchanged.
    #[cfg(not(target_os = "macos"))]
    fn synthetic_runtime(&self) -> (Arc<Core>, String) {
        let core = Core::new(19979);
        let snapshot = core.select(&self.root, false).unwrap();
        core.watcher.lock().unwrap().take();
        core.document_state
            .set(DocumentState::new(self.profile.join("document-state")).unwrap())
            .ok()
            .unwrap();
        let workspace = snapshot.workspace_id.unwrap();
        let tab = core
            .create_tab(&workspace, &snapshot.view_id, "current.html")
            .unwrap();
        let url = core.open(&workspace, &snapshot.view_id, &tab, 1).unwrap();
        let token = url
            .split("/s/")
            .nth(1)
            .unwrap()
            .split('/')
            .next()
            .unwrap()
            .to_owned();
        (core, token)
    }
}

#[test]
fn cli_refuses_unusable_arguments_before_opening_any_profile() {
    let mut output = Vec::new();
    let result = run_cli(
        [OsString::from("must-not-open")],
        &mut std::io::Cursor::new(b""),
        &mut output,
    );
    assert_eq!(result, 2);
    let expected = if super::super::enabled() {
        "arguments_required"
    } else {
        "native_identity_disabled"
    };
    assert!(String::from_utf8(output).unwrap().contains(expected));
}

#[test]
fn root_transition_backs_up_database_settings_and_preferences_before_confirmation() {
    let fixture = Fixture::new();
    let old_settings = fs::read(fixture.config.join("settings.json")).unwrap();
    let mut session = fixture.session();
    let old_database = session.store.database_snapshot();
    let preview = session.prepare(None, None).unwrap();
    assert_eq!(session.store.database_snapshot(), old_database);
    assert_eq!(
        fs::read(fixture.config.join("settings.json")).unwrap(),
        old_settings
    );
    let backup = fixture
        .backups
        .join(preview["backupDirectory"].as_str().unwrap());
    assert_eq!(
        fs::read(backup.join("database/state.sqlite")).unwrap(),
        old_database
    );
    assert_eq!(
        fs::read(backup.join("config/settings.json")).unwrap(),
        old_settings
    );
    assert_eq!(
        fs::read(backup.join("config/resident.json")).unwrap(),
        b"{\"kept\":true}"
    );
    assert!(backup
        .join("config/workspace-settings")
        .join(format!("{}.json", "b".repeat(64)))
        .exists());
    let operation = preview["planId"].as_str().unwrap();
    assert!(session.confirm(operation, "wrong").is_err());
    assert_eq!(super::super::version(&session.store.connection).unwrap(), 1);
    let receipt = session
        .confirm(operation, preview["confirmation"].as_str().unwrap())
        .unwrap();
    assert_eq!(receipt["settingsPublished"], true);
    let settings = session.settings_value().unwrap();
    assert_eq!(settings["keep"]["future"], true);
    assert_eq!(settings["knowledgeRootIdentityScheme"], SCHEME);
    assert!(super::super::operation_completed(&session.store.connection, operation).unwrap());
    assert!(session
        .confirm(operation, preview["confirmation"].as_str().unwrap())
        .is_err());
    assert_eq!(
        management::read_record(&session.store.connection, &fixture.source, false)
            .unwrap()
            .revision,
        7
    );
}

#[cfg(not(target_os = "macos"))]
#[tokio::test]
async fn unconfirmed_http_read_write_delete_are_held_and_confirmed_copy_survives_restart() {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let fixture = Fixture::new();
    let mut session = fixture.session();
    fixture.acknowledge_root(&mut session);
    drop(session);
    let before = fs::read(fixture.profile.join("document-state/state.sqlite")).unwrap();
    let (core, token) = fixture.synthetic_runtime();
    for op in ["read", "write", "delete"] {
        let body = if op == "write" {
            json!({"version":1,"op":op,"key":"app","value":"default"})
        } else {
            json!({"version":1,"op":op,"key":"app"})
        };
        let request = Request::builder()
            .method("POST")
            .uri(format!("/s/{token}/__mogledge_storage_v1__"))
            .header("Host", "127.0.0.1:19979")
            .header("Origin", "null")
            .header("Content-Type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap();
        let response = crate::document_server::router(core.clone())
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes).unwrap()["error"],
            "StorageIdentityConfirmationRequired"
        );
    }
    drop(core);
    assert_eq!(
        fs::read(fixture.profile.join("document-state/state.sqlite")).unwrap(),
        before
    );
    let mut session = fixture.session();
    let operation = fixture.copy(&mut session);
    let target = session.document_identity("current.html").unwrap();
    let old = management::read_record(&session.store.connection, &fixture.source, false).unwrap();
    let copied = management::read_record(&session.store.connection, &target, false).unwrap();
    assert_eq!(copied.data, old.data);
    assert_eq!(copied.revision, 1);
    assert_eq!(
        session
            .store
            .connection
            .query_row("SELECT documents FROM quota", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        2
    );
    drop(session);
    let (core, token) = fixture.synthetic_runtime();
    let response = document_state::operate(
        &core,
        &token,
        StateRequest {
            version: 1,
            op: Operation::Read,
            key: "app".into(),
            value: None,
        },
    )
    .unwrap();
    assert_eq!(response.value["data"]["value"], "retained");
    document_state::operate(
        &core,
        &token,
        StateRequest {
            version: 1,
            op: Operation::Write,
            key: "app".into(),
            value: Some(json!({"schemaVersion":1,"data":{"value":"changed"}})),
        },
    )
    .unwrap();
    document_state::operate(
        &core,
        &token,
        StateRequest {
            version: 1,
            op: Operation::Delete,
            key: "app".into(),
            value: None,
        },
    )
    .unwrap();
    drop(core);
    let session = fixture.session();
    assert!(super::super::operation_completed(&session.store.connection, &operation).unwrap());
    let current =
        management::read_record(&session.store.connection, &fixture.source, false).unwrap();
    assert_eq!(
        (current.data, current.revision, current.generation),
        (old.data, 7, 1)
    );
}

#[test]
fn interrupted_upgrade_rolls_back_format_bytes_and_preserves_settings() {
    let fixture = Fixture::new();
    let mut session = fixture.session();
    let database = session.store.database_snapshot();
    let settings = fs::read(fixture.config.join("settings.json")).unwrap();
    let preview = session.prepare(None, None).unwrap();
    let result = session.confirm_with(
        preview["planId"].as_str().unwrap(),
        preview["confirmation"].as_str().unwrap(),
        || Err(MigrationError::Interrupted),
        || {},
    );
    assert_eq!(result.unwrap_err(), MigrationError::Interrupted);
    assert_eq!(session.store.database_snapshot(), database);
    assert_eq!(
        fs::read(fixture.config.join("settings.json")).unwrap(),
        settings
    );
    assert_eq!(super::super::version(&session.store.connection).unwrap(), 1);
    assert!(session.store.connection.is_autocommit());
}

#[test]
fn changed_backup_target_and_expired_preview_refuse_without_copy() {
    for change in ["backup", "target", "expiry"] {
        let fixture = Fixture::new();
        let mut session = fixture.session();
        fixture.acknowledge_root(&mut session);
        let before = session.store.database_snapshot();
        let preview = session
            .prepare(Some("current.html"), Some(&fixture.source))
            .unwrap();
        match change {
            "backup" => {
                let backup = fixture
                    .backups
                    .join(preview["backupDirectory"].as_str().unwrap());
                fs::write(backup.join("config/resident.json"), b"changed").unwrap();
            }
            "target" => {
                fs::rename(
                    fixture.root.join("current.html"),
                    fixture.root.join("old.html"),
                )
                .unwrap();
                fs::write(fixture.root.join("current.html"), b"<input>").unwrap();
            }
            "expiry" => session.plan.as_mut().unwrap().expires = Instant::now(),
            _ => unreachable!(),
        }
        assert!(session
            .confirm(
                preview["planId"].as_str().unwrap(),
                preview["confirmation"].as_str().unwrap()
            )
            .is_err());
        assert_eq!(session.store.database_snapshot(), before);
        assert_eq!(
            session
                .store
                .connection
                .query_row("SELECT count(*) FROM identity_confirmations", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}

#[test]
fn settings_failure_after_commit_is_durable_and_explicitly_repairable() {
    let fixture = Fixture::new();
    let mut session = fixture.session();
    let preview = session.prepare(None, None).unwrap();
    let operation = preview["planId"].as_str().unwrap();
    let settings = fixture.config.join("settings.json");
    let receipt = session
        .confirm_with(
            operation,
            preview["confirmation"].as_str().unwrap(),
            || Ok(()),
            || {
                let mut value: Value =
                    serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
                value["concurrent"] = json!(true);
                fs::write(&settings, serde_json::to_vec(&value).unwrap()).unwrap();
            },
        )
        .unwrap();
    assert_eq!(receipt["settingsPublished"], false);
    assert!(super::super::operation_completed(&session.store.connection, operation).unwrap());
    assert!(session
        .settings_value()
        .unwrap()
        .get("knowledgeRootIdentityScheme")
        .is_none());
    let retry = session.prepare(None, None).unwrap();
    let receipt = session
        .confirm(
            retry["planId"].as_str().unwrap(),
            retry["confirmation"].as_str().unwrap(),
        )
        .unwrap();
    assert_eq!(receipt["settingsPublished"], true);
    assert_eq!(session.settings_value().unwrap()["concurrent"], true);
}

#[cfg(not(target_os = "macos"))]
#[test]
fn default_startup_and_reselection_preserve_migrated_profile_and_preferences() {
    let fixture = Fixture::new();
    let mut session = fixture.session();
    fixture.acknowledge_root(&mut session);
    drop(session);
    let old_settings = fs::read(fixture.config.join("settings.json")).unwrap();
    let old_database = fs::read(fixture.profile.join("document-state/state.sqlite")).unwrap();
    let core = Core::new(0);
    core.settings_path
        .set(fixture.config.join("settings.json"))
        .unwrap();
    core.document_state
        .set(DocumentState::new(fixture.profile.join("document-state")).unwrap())
        .ok()
        .unwrap();
    core.restore().unwrap();
    assert_eq!(
        core.snapshot().startup_recovery.unwrap().reason,
        crate::root_recovery::RecoveryReason::StorageIdentityConfirmationRequired
    );
    assert!(core
        .select(&fixture.root, true)
        .err()
        .unwrap()
        .contains("StorageIdentityConfirmationRequired"));
    drop(core);
    assert_eq!(
        fs::read(fixture.config.join("settings.json")).unwrap(),
        old_settings
    );
    assert_eq!(
        fs::read(fixture.profile.join("document-state/state.sqlite")).unwrap(),
        old_database
    );
    assert_eq!(
        fs::read(fixture.config.join("resident.json")).unwrap(),
        b"{\"kept\":true}"
    );
}

#[test]
fn all_offline_readers_accept_v3_and_inspect_without_payloads() {
    let fixture = Fixture::new();
    let mut session = fixture.session();
    fixture.acknowledge_root(&mut session);
    fixture.copy(&mut session);
    drop(session);
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let args = vec![
        OsString::from("inspect"),
        OsString::from("--state-dir"),
        fixture.profile.join("document-state").into_os_string(),
    ];
    assert_eq!(
        crate::state_inspection::run(args, &mut output, &mut errors),
        0,
        "{}",
        String::from_utf8_lossy(&errors)
    );
    let value: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(value["databaseSchemaVersion"], 3);
    assert!(!String::from_utf8_lossy(&output).contains("retained"));
    let session = management::Session::open(&fixture.profile, Some(&fixture.root)).unwrap();
    session.snapshot(20, 0).unwrap();
    drop(session);
    let args = vec![
        OsString::from("session"),
        OsString::from("--profile-dir"),
        fixture.profile.into_os_string(),
        OsString::from("--root"),
        fixture.root.into_os_string(),
    ];
    output.clear();
    errors.clear();
    let mut input = std::io::Cursor::new(b"{\"command\":\"inspect\"}\n{\"command\":\"quit\"}\n");
    assert_eq!(
        crate::state_transfer::run_cli(args, &mut input, &mut output, &mut errors),
        0,
        "{}",
        String::from_utf8_lossy(&errors)
    );
    assert!(String::from_utf8_lossy(&output).contains("\"ok\":true"));
}

#[cfg(windows)]
#[test]
fn failed_settings_replace_keeps_staging_and_repairs_after_cli_restart() {
    use std::os::windows::fs::OpenOptionsExt;
    for same_directory in [false, true] {
        let mut fixture = Fixture::new();
        if same_directory {
            for name in ["settings.json", "resident.json", "workspace-settings"] {
                fs::rename(fixture.config.join(name), fixture.profile.join(name)).unwrap();
            }
            fixture.config = fixture.profile.clone();
        }
        let settings = fixture.config.join("settings.json");
        let before = fs::read(&settings).unwrap();
        let mut session = fixture.session();
        let preview = session.prepare(None, None).unwrap();
        let blocker = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&settings)
            .unwrap();
        let receipt = session
            .confirm(
                preview["planId"].as_str().unwrap(),
                preview["confirmation"].as_str().unwrap(),
            )
            .unwrap();
        assert_eq!(receipt["settingsPublished"], false);
        assert_eq!(fs::read(&settings).unwrap(), before);
        let staging: Vec<_> = fs::read_dir(&fixture.config)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                crate::write_fs::unpublished_staging_name(
                    path.file_name().unwrap().to_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(staging.len(), 1);
        let retained = fs::read(&staging[0]).unwrap();
        drop(blocker);
        drop(session);
        let mut restarted = fixture.session();
        let preview = restarted.prepare(None, None).unwrap();
        assert!(restarted
            .plan
            .as_ref()
            .unwrap()
            .backup
            .files
            .iter()
            .all(|file| !file.path.contains(".tmp")));
        let receipt = restarted
            .confirm(
                preview["planId"].as_str().unwrap(),
                preview["confirmation"].as_str().unwrap(),
            )
            .unwrap();
        assert_eq!(receipt["settingsPublished"], true);
        assert_eq!(fs::read(&staging[0]).unwrap(), retained);
    }
}

#[test]
fn invalid_or_unreadable_settings_cannot_bypass_hold_without_database() {
    for bad in [
        b"not json".to_vec(),
        vec![b' '; 1024 * 1024 + 1],
        br#"{"knowledgeRootIdentityScheme":"unknown"}"#.to_vec(),
    ] {
        let fixture = Fixture::new();
        let settings = fixture.config.join("settings.json");
        fs::write(&settings, &bad).unwrap();
        let core = Core::new(0);
        core.settings_path.set(settings.clone()).unwrap();
        assert!(core.select(&fixture.root, true).is_err());
        assert_eq!(fs::read(&settings).unwrap(), bad);
        assert!(core.workspace.lock().unwrap().root.is_none());
    }
    let fixture = Fixture::new();
    let settings = fixture.config.join("settings.json");
    fs::remove_file(&settings).unwrap();
    fs::create_dir(&settings).unwrap();
    let core = Core::new(0);
    core.settings_path.set(settings.clone()).unwrap();
    assert!(core.select(&fixture.root, true).is_err());
    assert!(settings.is_dir());
}

#[test]
fn explicit_empty_confirmation_preserves_legacy_and_rejects_backup_injection() {
    let fixture = Fixture::new();
    let mut session = fixture.session();
    fixture.acknowledge_root(&mut session);
    let before = session.store.database_snapshot();
    let preview = session.prepare(Some("empty.html"), None).unwrap();
    fs::write(
        session
            .plan
            .as_ref()
            .unwrap()
            .backup
            .path
            .join("unexpected"),
        b"untrusted",
    )
    .unwrap();
    assert!(session
        .confirm(
            preview["planId"].as_str().unwrap(),
            preview["confirmation"].as_str().unwrap()
        )
        .is_err());
    assert_eq!(session.store.database_snapshot(), before);
    let preview = session.prepare(Some("empty.html"), None).unwrap();
    session
        .confirm(
            preview["planId"].as_str().unwrap(),
            preview["confirmation"].as_str().unwrap(),
        )
        .unwrap();
    let identity = session.document_identity("empty.html").unwrap();
    assert!(super::super::document_confirmed(
        &session.store.connection,
        &session.root_identity().unwrap(),
        &identity
    )
    .unwrap());
    assert_eq!(
        session
            .store
            .connection
            .query_row(
                "SELECT count(*) FROM documents WHERE id=?1",
                [&identity],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        management::read_record(&session.store.connection, &fixture.source, false)
            .unwrap()
            .revision,
        7
    );
}

#[test]
fn expanded_settings_over_limit_refuse_before_database_format_changes() {
    let fixture = Fixture::new();
    let settings = fixture.config.join("settings.json");
    let mut value: Value = serde_json::from_slice(&fs::read(&settings).unwrap()).unwrap();
    value["retained"] = json!(vec![0_u8; 180_000]);
    let original = serde_json::to_vec(&value).unwrap();
    assert!(original.len() as u64 <= MAX_CONFIG_BYTES);
    fs::write(&settings, &original).unwrap();
    let mut session = fixture.session();
    let before = session.store.database_snapshot();
    let preview = session.prepare(None, None).unwrap();
    assert!(session
        .confirm(
            preview["planId"].as_str().unwrap(),
            preview["confirmation"].as_str().unwrap()
        )
        .is_err());
    assert_eq!(session.store.database_snapshot(), before);
    assert_eq!(super::super::version(&session.store.connection).unwrap(), 1);
    assert_eq!(fs::read(&settings).unwrap(), original);
    drop(session);
    let core = Core::new(0);
    core.settings_path.set(settings.clone()).unwrap();
    assert!(core.select(&fixture.root, true).is_err());
    assert_eq!(fs::read(&settings).unwrap(), original);
    assert!(core.workspace.lock().unwrap().root.is_none());
}

#[test]
fn identifier_bundle_marker_is_backed_up_and_checked_before_transition() {
    for change_marker in [false, true] {
        let mut fixture = Fixture::new();
        let bundle = fixture.profile.join("identifier-migration-v1");
        fs::create_dir(&bundle).unwrap();
        fs::rename(
            fixture.profile.join("document-state"),
            bundle.join("document-state"),
        )
        .unwrap();
        fs::rename(&fixture.config, bundle.join("config")).unwrap();
        fixture.config = bundle.join("config");
        let marker = serde_json::to_vec(&json!({"version":1,"legacy":identifier_migration::LEGACY_IDENTIFIER,"current":"profile","settings":true,"orders":false,"database":true})).unwrap();
        fs::write(bundle.join("complete.json"), &marker).unwrap();
        let mut session = fixture.session();
        let before = session.store.database_snapshot();
        let preview = session.prepare(None, None).unwrap();
        let backup = fixture
            .backups
            .join(preview["backupDirectory"].as_str().unwrap());
        assert_eq!(
            fs::read(backup.join("layout/complete.json")).unwrap(),
            marker
        );
        let manifest: Value =
            serde_json::from_slice(&fs::read(backup.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(
            manifest["databaseRelativePath"],
            "identifier-migration-v1/document-state/state.sqlite"
        );
        if change_marker {
            fs::write(bundle.join("complete.json"), b"{}").unwrap();
        }
        let result = session.confirm(
            preview["planId"].as_str().unwrap(),
            preview["confirmation"].as_str().unwrap(),
        );
        if change_marker {
            assert!(result.is_err());
            assert_eq!(session.store.database_snapshot(), before);
        } else {
            assert_eq!(result.unwrap()["settingsPublished"], true);
            assert_eq!(fs::read(bundle.join("complete.json")).unwrap(), marker);
        }
    }
}

#[test]
fn session_sidecar_is_sealed_and_backed_up_without_weakening_closed_filename_validation() {
    let fixture = Fixture::new();
    let (_, dir) = knowledge::open_root(&fixture.root).unwrap();
    let identity = knowledge::storage_root_identity(&dir).unwrap();
    let leaf = format!(
        "{:x}.json",
        Sha256::digest(format!("mogledge-tab-session-v1\0{identity}").as_bytes())
    );
    let bytes = serde_json::to_vec(&json!({"version":1,"kind":"tab-session","rootIdentity":identity,"session":{"items":[],"active":[null,null],"activeColumn":0,"split":false,"help":null}})).unwrap();
    let path = fixture.config.join("workspace-settings").join(&leaf);
    fs::write(&path, &bytes).unwrap();
    let mut session = fixture.session();
    let preview = session.prepare(None, None).unwrap();
    let name = preview["backupDirectory"].as_str().unwrap().to_owned();
    let backup_path = fixture.backups.join(&name);
    let manifest: Value =
        serde_json::from_slice(&fs::read(backup_path.join("manifest.json")).unwrap()).unwrap();
    assert!(manifest["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["path"].as_str()
            == Some(format!("config/workspace-settings/{leaf}").as_str())));
    assert_eq!(
        fs::read(backup_path.join("config/workspace-settings").join(&leaf)).unwrap(),
        bytes
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    session
        .confirm(
            preview["planId"].as_str().unwrap(),
            preview["confirmation"].as_str().unwrap(),
        )
        .unwrap();
    // Recovery exercises the existing manifest loader and rejects later unknown leaves.
    session.prepare_rollback(&name).unwrap();
    fs::write(
        fixture
            .config
            .join("workspace-settings")
            .join("unknown.tabs.json"),
        b"{}",
    )
    .unwrap();
    assert!(config_files(&session.config).is_err());
}
