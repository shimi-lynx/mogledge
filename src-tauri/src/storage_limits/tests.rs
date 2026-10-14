use super::*;
use crate::document_state::{self, DocumentState, Operation, StateRequest};
use serde_json::json;
use std::sync::Arc;
use tempfile::TempDir;

struct Fixture {
    _temp: TempDir,
    core: Arc<Core>,
    context: Context,
    directory: std::path::PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("profile/document-state");
        let core = Core::new(19218);
        core.document_state
            .set(DocumentState::new(directory.clone()).unwrap())
            .ok()
            .unwrap();
        let context = Context {
            view_id: String::new(),
            workspace_id: None,
        };
        Self {
            _temp: temp,
            core,
            context,
            directory,
        }
    }
    fn request(&self, document: i64, total: i64) -> SetRequest {
        let current = get(&self.core, &self.context).unwrap();
        SetRequest {
            context: self.context.clone(),
            expected_revision: current.revision,
            expected_generation: current.generation,
            document_mi_b: document,
            total_mi_b: total,
            acknowledge_compatibility: true,
        }
    }
    fn token(&mut self) -> String {
        let root = self._temp.path().join("原本 root");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("日本語.html"), "<p>original</p>").unwrap();
        let snapshot = self.core.select(&root, false).unwrap();
        self.core.watcher.lock().unwrap().take();
        self.context = Context {
            view_id: snapshot.view_id.clone(),
            workspace_id: snapshot.workspace_id.clone(),
        };
        let tab = self
            .core
            .create_tab(
                snapshot.workspace_id.as_deref().unwrap(),
                &snapshot.view_id,
                "日本語.html",
            )
            .unwrap();
        let url = self
            .core
            .open(
                snapshot.workspace_id.as_deref().unwrap(),
                &snapshot.view_id,
                &tab,
                1,
            )
            .unwrap();
        crate::document_server::decode_path(url.strip_prefix(&self.core.origin).unwrap())
            .unwrap()
            .0
    }
    fn write(
        &self,
        token: &str,
        value: serde_json::Value,
    ) -> Result<document_state::StateResponse, document_state::StateError> {
        document_state::operate(
            &self.core,
            token,
            StateRequest {
                version: 1,
                op: Operation::Write,
                key: "sample".into(),
                value: Some(value),
            },
        )
    }
}

#[test]
fn defaults_and_default_noop_never_add_table_and_wire_shape_uses_mib() {
    let fixture = Fixture::new();
    let initial = get(&fixture.core, &fixture.context).unwrap();
    assert_eq!(
        (
            initial.document_mi_b,
            initial.total_mi_b,
            initial.revision,
            initial.generation
        ),
        (5, 512, 0, 0)
    );
    let mut request = fixture.request(5, 512);
    request.acknowledge_compatibility = false;
    let result = set(&fixture.core, &request).unwrap();
    assert_eq!(result.revision, 0);
    let json = serde_json::to_value(result).unwrap();
    assert_eq!(json["documentMiB"], 5);
    assert_eq!(json["totalMiB"], 512);
    fixture
        .core
        .document_state
        .get()
        .unwrap()
        .management_connection(|connection, _, _, _| {
            assert!(!table_exists(connection).unwrap());
            Ok(())
        })
        .unwrap();
}
#[test]
fn range_ack_and_stale_context_rejections_preserve_defaults() {
    let fixture = Fixture::new();
    for (document, total) in [
        (0, 512),
        (MAX_MIB + 1, MAX_MIB + 1),
        (1, 0),
        (1, MAX_MIB + 1),
        (8, 1),
    ] {
        assert_eq!(
            set(&fixture.core, &fixture.request(document, total))
                .unwrap_err()
                .code,
            "limits_invalid"
        );
    }
    let mut request = fixture.request(8, 1024);
    request.acknowledge_compatibility = false;
    assert_eq!(
        set(&fixture.core, &request).unwrap_err().code,
        "limits_compatibility_required"
    );
    request.acknowledge_compatibility = true;
    request.context.view_id = "stale".into();
    assert_eq!(
        set(&fixture.core, &request).unwrap_err().code,
        "context_changed"
    );
    assert_eq!(get(&fixture.core, &fixture.context).unwrap().revision, 0);
}
#[test]
fn acknowledged_set_is_atomic_cas_and_restored_after_restart() {
    let fixture = Fixture::new();
    let request = fixture.request(8, 1024);
    let result = set(&fixture.core, &request).unwrap();
    assert_eq!((result.revision, result.generation), (1, 1));
    assert!(!result.requires_compatibility_acknowledgement);
    assert_eq!(
        set(&fixture.core, &request).unwrap_err().code,
        "limits_changed"
    );
    assert_eq!(get(&fixture.core, &fixture.context).unwrap().revision, 1);
    let directory = fixture.directory.clone();
    drop(fixture.core);
    let core = Core::new(19219);
    core.document_state
        .set(DocumentState::new(directory).unwrap())
        .ok()
        .unwrap();
    let current = get(&core, &fixture.context).unwrap();
    assert_eq!(
        (current.document_mi_b, current.total_mi_b, current.revision),
        (8, 1024, 1)
    );
}
#[test]
fn larger_save_is_immediate_and_lowering_below_active_document_is_rejected() {
    let mut fixture = Fixture::new();
    let token = fixture.token();
    assert_eq!(
        fixture
            .write(&token, json!("x".repeat(6 * MIB as usize)))
            .unwrap_err(),
        document_state::StateError::QuotaExceeded
    );
    set(&fixture.core, &fixture.request(8, 16)).unwrap();
    fixture
        .write(&token, json!("x".repeat(6 * MIB as usize)))
        .unwrap();
    let before = get(&fixture.core, &fixture.context).unwrap();
    assert!(before.largest_document_bytes > 6 * MIB);
    assert_eq!(
        set(&fixture.core, &fixture.request(5, 16))
            .unwrap_err()
            .code,
        "limits_below_usage"
    );
    let after = get(&fixture.core, &fixture.context).unwrap();
    assert_eq!(
        (after.revision, after.generation),
        (before.revision, before.generation)
    );
    assert!(matches!(
        fixture.write(&token, json!("y".repeat(8 * MIB as usize))),
        Err(document_state::StateError::QuotaExceeded)
    ));
    fixture
        .core
        .document_state
        .get()
        .unwrap()
        .management_connection(|connection, _, _, _| {
            crate::identifier_migration::validate_db(connection).unwrap();
            Ok(())
        })
        .unwrap();
    let directory = fixture.directory.clone();
    drop(fixture.core);
    let reopened = DocumentState::new(directory).unwrap();
    reopened
        .management_connection(|connection, _, _, _| {
            crate::identifier_migration::validate_db(connection).unwrap();
            assert_eq!(read(connection).unwrap().document_bytes, 8 * MIB as usize);
            Ok(())
        })
        .unwrap();
}
#[test]
fn pending_snapshot_is_invalidated_by_an_actual_save_and_one_mib_total_is_enforced() {
    let mut fixture = Fixture::new();
    let token = fixture.token();
    let stale = fixture.request(1, 1);
    fixture.write(&token, json!("existing")).unwrap();
    assert_eq!(
        set(&fixture.core, &stale).unwrap_err().code,
        "limits_changed"
    );
    set(&fixture.core, &fixture.request(1, 1)).unwrap();
    let before = get(&fixture.core, &fixture.context).unwrap();
    assert_eq!(
        fixture
            .write(&token, json!("x".repeat(MIB as usize)))
            .unwrap_err(),
        document_state::StateError::QuotaExceeded
    );
    let after = get(&fixture.core, &fixture.context).unwrap();
    assert_eq!(
        (after.generation, after.usage_bytes),
        (before.generation, before.usage_bytes)
    );
}
#[test]
fn archive_largest_document_blocks_lowering_without_modifying_recovery() {
    let fixture = Fixture::new();
    set(&fixture.core, &fixture.request(8, 16)).unwrap();
    fixture.core.document_state.get().unwrap().management_connection(|connection,_,_,_| {
        connection.execute_batch(crate::state_inspection::recovery_store::RECORDS_DDL).unwrap();
        connection.execute_batch(crate::state_inspection::recovery_store::TOMBSTONES_DDL).unwrap();
        connection.execute_batch("PRAGMA user_version=2; UPDATE quota SET generation=2;").unwrap();
        let data=serde_json::to_string(&json!({"sample":"x".repeat(2*MIB as usize)})).unwrap();
        connection.execute("INSERT INTO recovery_records VALUES(?1,?2,?3,?4,1,?5,'page.html',1,?6,1,'quarantined',NULL,NULL)",params!["a".repeat(64),"b".repeat(64),data,data.len() as i64,"c".repeat(64),crate::state_inspection::recovery_store::payload_hash(&data)]).unwrap();
        connection.execute("INSERT INTO state_tombstones VALUES(?1,1,?2)",params!["b".repeat(64),"a".repeat(64)]).unwrap();Ok(())
    }).unwrap();
    let before = get(&fixture.core, &fixture.context).unwrap();
    assert!(before.largest_recovery_document_bytes.unwrap() > 2 * MIB);
    assert_eq!(
        set(&fixture.core, &fixture.request(1, 16))
            .unwrap_err()
            .code,
        "limits_below_usage"
    );
    let after = get(&fixture.core, &fixture.context).unwrap();
    assert_eq!(
        (after.revision, after.generation, after.recovery_bytes),
        (before.revision, before.generation, before.recovery_bytes)
    );
}
#[test]
fn physical_page_cap_tracks_optional_table_and_invalid_shape_fails_closed() {
    let fixture = Fixture::new();
    fixture
        .core
        .document_state
        .get()
        .unwrap()
        .management_connection(|connection, _, _, _| {
            let pages: i64 = connection
                .query_row("PRAGMA max_page_count", [], |row| row.get(0))
                .unwrap();
            let size: i64 = connection
                .query_row("PRAGMA page_size", [], |row| row.get(0))
                .unwrap();
            assert_eq!(pages * size, 1024 * 1024 * 1024);
            Ok(())
        })
        .unwrap();
    set(&fixture.core, &fixture.request(8, 1024)).unwrap();
    fixture
        .core
        .document_state
        .get()
        .unwrap()
        .management_connection(|connection, _, _, _| {
            let pages: i64 = connection
                .query_row("PRAGMA max_page_count", [], |row| row.get(0))
                .unwrap();
            let size: i64 = connection
                .query_row("PRAGMA page_size", [], |row| row.get(0))
                .unwrap();
            assert_eq!(
                pages as u64 * size as u64,
                physical_database_bytes(connection).unwrap()
            );
            Ok(())
        })
        .unwrap();
    let malformed = Connection::open_in_memory().unwrap();
    malformed.execute_batch("CREATE TABLE storage_limits(singleton INTEGER,document_bytes INTEGER,total_bytes INTEGER,revision INTEGER);INSERT INTO storage_limits VALUES(1,8388608,1073741824,1);").unwrap();
    assert!(matches!(
        read(&malformed),
        Err(MigrationError::UnsupportedDatabase)
    ));
}
#[test]
fn readonly_bounds_and_main_acl_never_give_html_mutation_authority() {
    assert!(check_main_host("main").is_ok());
    assert_eq!(
        check_main_host("document").unwrap_err().code,
        "main_host_required"
    );
    let request = json!({"context":{"workspaceId":null,"viewId":""},"expectedRevision":0,"expectedGeneration":0,"documentMiB":1.5,"totalMiB":2,"acknowledgeCompatibility":true});
    assert!(serde_json::from_value::<SetRequest>(request).is_err());
    let acl: serde_json::Value =
        serde_json::from_str(include_str!("../../capabilities/main.json")).unwrap();
    for command in ["get-storage-limits", "set-storage-limits"] {
        assert!(acl["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value == &json!(format!("allow-{command}"))));
    }
    assert!(!include_str!("../document_server/storage.rs").contains("get_storage_limits"));
}

#[test]
fn failure_after_first_table_and_row_insert_rolls_back_limits_and_generation() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    fn reject_quota_update(context: AuthContext<'_>) -> Authorization {
        if matches!(
            context.action,
            AuthAction::Update {
                table_name: "quota",
                ..
            }
        ) {
            Authorization::Deny
        } else {
            Authorization::Allow
        }
    }
    let fixture = Fixture::new();
    let request = fixture.request(8, 1024);
    fixture
        .core
        .document_state
        .get()
        .unwrap()
        .management_connection(|connection, _, _, _| {
            connection.authorizer(Some(reject_quota_update)).unwrap();
            Ok(())
        })
        .unwrap();
    assert_eq!(
        set(&fixture.core, &request).unwrap_err().code,
        "state_corrupt"
    );
    fixture
        .core
        .document_state
        .get()
        .unwrap()
        .management_connection(|connection, _, _, _| {
            connection
                .authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
                .unwrap();
            assert!(!table_exists(connection).unwrap());
            Ok(())
        })
        .unwrap();
    let current = get(&fixture.core, &fixture.context).unwrap();
    assert_eq!(
        (
            current.document_mi_b,
            current.total_mi_b,
            current.revision,
            current.generation
        ),
        (5, 512, 0, 0)
    );
}

#[test]
fn total_quota_is_shared_across_roots_and_late_save_uses_current_limits() {
    let mut fixture = Fixture::new();
    let token = fixture.token();
    set(&fixture.core, &fixture.request(1, 1)).unwrap();
    fixture
        .write(&token, json!("x".repeat(512 * 1024)))
        .unwrap();
    let second = fixture._temp.path().join("second root");
    std::fs::create_dir(&second).unwrap();
    std::fs::write(second.join("日本語.html"), "<p>second</p>").unwrap();
    let snapshot = fixture.core.select(&second, false).unwrap();
    fixture.core.watcher.lock().unwrap().take();
    fixture.context = Context {
        view_id: snapshot.view_id.clone(),
        workspace_id: snapshot.workspace_id.clone(),
    };
    let tab = fixture
        .core
        .create_tab(
            snapshot.workspace_id.as_deref().unwrap(),
            &snapshot.view_id,
            "日本語.html",
        )
        .unwrap();
    let url = fixture
        .core
        .open(
            snapshot.workspace_id.as_deref().unwrap(),
            &snapshot.view_id,
            &tab,
            1,
        )
        .unwrap();
    let token =
        crate::document_server::decode_path(url.strip_prefix(&fixture.core.origin).unwrap())
            .unwrap()
            .0;
    let before = get(&fixture.core, &fixture.context).unwrap();
    assert_eq!(
        fixture
            .write(&token, json!("y".repeat(600 * 1024)))
            .unwrap_err(),
        document_state::StateError::QuotaExceeded
    );
    assert_eq!(
        get(&fixture.core, &fixture.context).unwrap().usage_bytes,
        before.usage_bytes
    );
    // A request prepared under the larger limit does not bypass a later setting.
    set(&fixture.core, &fixture.request(8, 16)).unwrap();
    let prepared = json!("z".repeat(2 * MIB as usize));
    set(&fixture.core, &fixture.request(1, 1)).unwrap();
    assert_eq!(
        fixture.write(&token, prepared).unwrap_err(),
        document_state::StateError::QuotaExceeded
    );
}

#[test]
fn representable_quotas_above_engine_caps_are_saved_as_settings_not_preallocations() {
    let fixture = Fixture::new();
    let current = get(&fixture.core, &fixture.context).unwrap();
    assert!(current.capabilities.maximum_document_bytes > 8 * MIB as usize);
    assert_eq!(
        current.capabilities.maximum_request_bytes,
        current.capabilities.maximum_document_bytes + 1024
    );
    let result = set(&fixture.core, &fixture.request(MAX_MIB, MAX_MIB)).unwrap();
    assert_eq!(
        (result.document_mi_b, result.total_mi_b),
        (MAX_MIB, MAX_MIB)
    );
    assert!(result.document_mi_b * MIB > result.capabilities.maximum_document_bytes as i64);
    assert!(!result.requires_compatibility_acknowledgement);
    let current = get(&fixture.core, &fixture.context).unwrap();
    assert_eq!(
        current.capabilities.maximum_database_bytes,
        fixture
            .core
            .document_state
            .get()
            .unwrap()
            .management_connection(|c, _, _, _| Ok(physical_database_bytes(c).unwrap()))
            .unwrap()
    );
    let directory = fixture.directory.clone();
    drop(fixture.core);
    let reopened = DocumentState::new(directory).unwrap();
    reopened
        .management_connection(|c, _, _, _| {
            assert_eq!(
                read(c).unwrap().document_bytes,
                usize::try_from(MAX_MIB * MIB).unwrap()
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn old_limits_ddl_get_and_noop_are_preserved_until_explicit_acknowledged_change() {
    let fixture = Fixture::new();
    fixture
        .core
        .document_state
        .get()
        .unwrap()
        .management_connection(|c, _, _, _| {
            c.execute_batch(LEGACY_DDL).unwrap();
            c.execute(
                "INSERT INTO storage_limits VALUES(1,5242880,536870912,3)",
                [],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    let old = get(&fixture.core, &fixture.context).unwrap();
    assert_eq!(old.revision, 3);
    assert!(old.requires_compatibility_acknowledgement);
    let mut same = fixture.request(5, 512);
    same.acknowledge_compatibility = false;
    assert_eq!(set(&fixture.core, &same).unwrap().revision, 3);
    let mut change = fixture.request(9, 2048);
    change.acknowledge_compatibility = false;
    assert_eq!(
        set(&fixture.core, &change).unwrap_err().code,
        "limits_compatibility_required"
    );
    fixture
        .core
        .document_state
        .get()
        .unwrap()
        .management_connection(|c, _, _, _| {
            assert_eq!(schema_ddl(c).unwrap(), LEGACY_DDL);
            assert_eq!(database_size_limit_for_test(c), 2 * 1024 * 1024 * 1024);
            Ok(())
        })
        .unwrap();
    change.acknowledge_compatibility = true;
    let result = set(&fixture.core, &change).unwrap();
    assert_eq!(result.revision, 4);
    assert_eq!(result.generation, old.generation + 1);
    assert!(!result.requires_compatibility_acknowledgement);
    fixture
        .core
        .document_state
        .get()
        .unwrap()
        .management_connection(|c, _, _, _| {
            assert_eq!(schema_ddl(c).unwrap(), DDL);
            crate::identifier_migration::validate_db(c).unwrap();
            Ok(())
        })
        .unwrap();
}
fn database_size_limit_for_test(c: &Connection) -> u64 {
    crate::identifier_migration::database_size_limit(c).unwrap()
}

#[test]
fn raw_nine_mib_save_read_restart_and_invalid_duplicates_preserve_state() {
    let mut fixture = Fixture::new();
    let token = fixture.token();
    set(&fixture.core, &fixture.request(16, 2048)).unwrap();
    let body = format!(
        r#"{{"version":1,"op":"write","key":"sample","value":{{"schemaVersion":1,"data":"{}"}}}}"#,
        "x".repeat(9 * MIB as usize)
    );
    let parsed: document_state::RawStateRequest<'_> = serde_json::from_str(&body).unwrap();
    let response = document_state::operate_raw_bytes(&fixture.core, &token, parsed).unwrap();
    let response: serde_json::Value = serde_json::from_slice(&response).unwrap();
    assert_eq!(response["revision"], 1);
    let before = get(&fixture.core, &fixture.context).unwrap();
    assert!(before.largest_document_bytes > 8 * MIB);
    let invalid = r#"{"version":1,"op":"write","key":"sample","value":{"schemaVersion":1,"data":{"x":1,"x":2}}}"#;
    let parsed: document_state::RawStateRequest<'_> = serde_json::from_str(invalid).unwrap();
    assert!(matches!(
        document_state::operate_raw_bytes(&fixture.core, &token, parsed),
        Err(document_state::StateError::InvalidRequest)
    ));
    assert_eq!(
        get(&fixture.core, &fixture.context).unwrap().generation,
        before.generation
    );
    let read: document_state::RawStateRequest<'_> =
        serde_json::from_str(r#"{"version":1,"op":"read","key":"sample"}"#).unwrap();
    let bytes = document_state::operate_raw_bytes(&fixture.core, &token, read).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        response
    );
    let directory = fixture.directory.clone();
    drop(fixture.core);
    let reopened = DocumentState::new(directory).unwrap();
    reopened
        .management_connection(|c, _, _, _| {
            crate::identifier_migration::validate_db(c).unwrap();
            let n: i64 = c
                .query_row("SELECT bytes FROM documents", [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, before.largest_document_bytes);
            Ok(())
        })
        .unwrap();
}

#[test]
fn legacy_table_rebuild_failure_rolls_back_old_schema_limits_and_generation() {
    use rusqlite::hooks::{AuthAction, Authorization};
    let fixture = Fixture::new();
    fixture
        .core
        .document_state
        .get()
        .unwrap()
        .management_connection(|c, _, _, _| {
            c.execute_batch(LEGACY_DDL).unwrap();
            c.execute(
                "INSERT INTO storage_limits VALUES(1,5242880,536870912,2)",
                [],
            )
            .unwrap();
            Ok(())
        })
        .unwrap();
    let before = get(&fixture.core, &fixture.context).unwrap();
    let request = fixture.request(9, 2048);
    fixture
        .core
        .document_state
        .get()
        .unwrap()
        .management_connection(|c, _, _, _| {
            c.authorizer(Some(|ctx: rusqlite::hooks::AuthContext<'_>| {
                if matches!(
                    ctx.action,
                    AuthAction::Update {
                        table_name: "quota",
                        ..
                    }
                ) {
                    Authorization::Deny
                } else {
                    Authorization::Allow
                }
            }))
            .unwrap();
            Ok(())
        })
        .unwrap();
    assert!(set(&fixture.core, &request).is_err());
    fixture
        .core
        .document_state
        .get()
        .unwrap()
        .management_connection(|c, _, _, _| {
            c.authorizer(None::<fn(rusqlite::hooks::AuthContext<'_>) -> Authorization>)
                .unwrap();
            assert_eq!(schema_ddl(c).unwrap(), LEGACY_DDL);
            assert_eq!(read(c).unwrap().revision, 2);
            Ok(())
        })
        .unwrap();
    let after = get(&fixture.core, &fixture.context).unwrap();
    assert_eq!(
        (
            after.revision,
            after.generation,
            after.document_mi_b,
            after.total_mi_b
        ),
        (before.revision, before.generation, 5, 512)
    );
}

#[test]
fn late_limits_failure_retains_legacy_schema_and_remap_restores_its_page_cap() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::atomic::{AtomicBool, Ordering};

    let mut fixture = Fixture::new();
    let token = fixture.token();
    fixture.write(&token, json!("retained")).unwrap();
    let store = fixture.core.document_state.get().unwrap();
    let legacy_pages = store
        .management_connection(|c, _, _, _| {
            c.execute_batch(LEGACY_DDL).unwrap();
            c.execute(
                "INSERT INTO storage_limits VALUES(1,5242880,536870912,2)",
                [],
            )
            .unwrap();
            let page_size: i64 = c.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
            Ok(2 * 1024 * 1024 * 1024 / page_size)
        })
        .unwrap();
    let before = get(&fixture.core, &fixture.context).unwrap();
    let request = fixture.request(9, 2048);
    let expanded = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(false));
    let restored = Arc::new(AtomicBool::new(false));
    let updated = Arc::new(AtomicBool::new(false));
    store
        .management_connection(|c, _, _, _| {
            let expanded = expanded.clone();
            let failed = failed.clone();
            let restored = restored.clone();
            let updated = updated.clone();
            c.authorizer(Some(move |ctx: AuthContext<'_>| {
                match ctx.action {
                    AuthAction::Pragma {
                        pragma_name: "max_page_count",
                        pragma_value: Some(value),
                    } => {
                        let pages = value.parse::<i64>().unwrap();
                        if pages > legacy_pages {
                            expanded.store(true, Ordering::SeqCst);
                        } else if pages == legacy_pages && expanded.load(Ordering::SeqCst) {
                            restored.store(true, Ordering::SeqCst);
                        }
                    }
                    AuthAction::Read {
                        table_name: "storage_limits",
                        ..
                    } if expanded.load(Ordering::SeqCst)
                        && !failed.swap(true, Ordering::SeqCst) =>
                    {
                        return Authorization::Deny;
                    }
                    AuthAction::Update {
                        table_name: "documents",
                        ..
                    } => {
                        updated.store(true, Ordering::SeqCst);
                        if !restored.load(Ordering::SeqCst) {
                            return Authorization::Deny;
                        }
                    }
                    _ => {}
                }
                Authorization::Allow
            }))
            .unwrap();
            Ok(())
        })
        .unwrap();
    assert!(set(&fixture.core, &request).is_err());
    assert!(expanded.load(Ordering::SeqCst));
    assert!(failed.load(Ordering::SeqCst));
    assert!(!restored.load(Ordering::SeqCst));

    // No intervening management read can restore the connection's page cap.
    // Denying an unguarded UPDATE makes this regression fail without the guard,
    // without allocating a database near the legacy two-GiB limit.
    let (_, dir) = crate::knowledge::open_root(&fixture._temp.path().join("原本 root")).unwrap();
    store
        .remap_locations(&dir, "日本語.html", "移動先.html")
        .unwrap();
    assert!(restored.load(Ordering::SeqCst));
    assert!(updated.load(Ordering::SeqCst));
    store
        .management_connection(|c, _, _, _| {
            c.authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
                .unwrap();
            assert_eq!(schema_ddl(c).unwrap(), LEGACY_DDL);
            assert_eq!(read(c).unwrap().revision, 2);
            let pages: i64 = c
                .query_row("PRAGMA max_page_count", [], |r| r.get(0))
                .unwrap();
            assert_eq!(pages, legacy_pages);
            let path: String = c
                .query_row("SELECT path FROM documents", [], |r| r.get(0))
                .unwrap();
            assert_eq!(path, "移動先.html");
            Ok(())
        })
        .unwrap();
    let after = get(&fixture.core, &fixture.context).unwrap();
    assert_eq!(
        (
            after.revision,
            after.generation,
            after.usage_bytes,
            after.document_mi_b,
            after.total_mi_b
        ),
        (
            before.revision,
            before.generation,
            before.usage_bytes,
            5,
            512
        )
    );
}
