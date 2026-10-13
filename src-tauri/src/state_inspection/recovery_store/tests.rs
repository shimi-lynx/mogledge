use super::*;
use crate::{document_state::DocumentState, identifier_migration};
use rusqlite::params;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

struct Fixture {
    _base: tempfile::TempDir,
    profile: PathBuf,
    state: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let base = tempfile::tempdir().unwrap();
        let profile = base.path().join("com.fixture.current");
        let state = profile.join("document-state");
        drop(DocumentState::new(state.clone()).unwrap());
        fs::write(profile.join("identifier-migration.lock"), []).unwrap();
        Self {
            _base: base,
            profile,
            state,
        }
    }

    fn connection(&self) -> Connection {
        Connection::open(self.state.join("state.sqlite")).unwrap()
    }
}

fn id(value: u64) -> String {
    format!("{value:064x}")
}

fn files(directory: &Path) -> BTreeMap<String, Vec<u8>> {
    fs::read_dir(directory)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().into_string().unwrap(),
                fs::read(entry.path()).unwrap(),
            )
        })
        .collect()
}

fn quarantined(connection: &mut Connection) {
    upgrade(connection, || Ok(())).unwrap();
    let transaction = connection.transaction().unwrap();
    transaction
        .execute("UPDATE quota SET generation=2", [])
        .unwrap();
    transaction.execute("INSERT INTO recovery_records VALUES (?1,?2,'{}',2,2,?3,'page.html',1,?4,0,'quarantined',NULL,NULL)", params![id(1),id(2),id(3),payload_hash("{}")]).unwrap();
    transaction
        .execute(
            "INSERT INTO state_tombstones VALUES (?1,2,?2)",
            params![id(2), id(1)],
        )
        .unwrap();
    transaction.commit().unwrap();
}

#[test]
fn management_open_is_nonmutating_retains_both_locks_and_requires_explicit_upgrade() {
    let fixture = Fixture::new();
    let before = files(&fixture.state);
    let mut store = identifier_migration::open_management_profile(&fixture.profile).unwrap();
    assert_eq!(store.database_id().len(), 64);
    assert!(store.database_bytes().unwrap() > 0);
    assert_eq!(
        store
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(store.database_snapshot(), before["state.sqlite"]);
    assert_eq!(fs::read_dir(&fixture.state).unwrap().count(), 1);
    assert!(matches!(
        identifier_migration::open_management_profile(&fixture.profile),
        Err(MigrationError::Busy)
    ));
    let another = fixture.connection();
    another.busy_timeout(std::time::Duration::ZERO).unwrap();
    assert!(another
        .query_row("SELECT count(*) FROM quota", [], |row| row.get::<_, i64>(0))
        .is_err());
    drop(another);
    // No raw descriptor to this inode is closed by management verification.
    store.verify().unwrap();
    store
        .connection
        .execute_batch("PRAGMA query_only=OFF")
        .unwrap();
    upgrade(&mut store.connection, || Ok(())).unwrap();
    store
        .connection
        .execute_batch("PRAGMA query_only=ON")
        .unwrap();
    assert_eq!(
        store
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        2
    );
    store.verify().unwrap();
    drop(store);
    assert_eq!(
        files(&fixture.state).keys().collect::<Vec<_>>(),
        vec!["state.sqlite"]
    );
    assert!(identifier_migration::open_management_profile(&fixture.profile).is_ok());
    assert!(DocumentState::new(fixture.state.clone()).is_ok());
}

#[test]
fn schema_upgrade_is_atomic_idempotent_and_refuses_readonly_connections() {
    let fixture = Fixture::new();
    let before = files(&fixture.state);
    let mut readonly = Connection::open_with_flags(
        fixture.state.join("state.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert!(upgrade(&mut readonly, || Ok(())).is_err());
    assert_eq!(files(&fixture.state), before);
    drop(readonly);
    let mut connection = fixture.connection();
    assert!(matches!(
        upgrade(&mut connection, || Err(MigrationError::Interrupted)),
        Err(MigrationError::Interrupted)
    ));
    assert_eq!(files(&fixture.state), before);
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    upgrade(&mut connection, || Ok(())).unwrap();
    upgrade(&mut connection, || Ok(())).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM recovery_records", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    connection
        .execute_batch("CREATE TABLE unexpected(value TEXT)")
        .unwrap();
    assert!(matches!(
        validate_schema(&connection),
        Err(MigrationError::UnsupportedDatabase)
    ));
}

#[test]
fn runtime_tombstone_guard_rejects_broken_archive_bindings() {
    let fixture = Fixture::new();
    let mut connection = fixture.connection();
    assert!(!is_quarantined(&connection, &id(2)).unwrap());
    quarantined(&mut connection);
    assert!(is_quarantined(&connection, &id(2)).unwrap());
    assert!(!is_quarantined(&connection, &id(4)).unwrap());
    connection
        .execute("UPDATE recovery_records SET document_id=?1", [id(4)])
        .unwrap();
    assert!(matches!(
        is_quarantined(&connection, &id(2)),
        Err(MigrationError::Corrupt)
    ));
    connection
        .execute(
            "UPDATE recovery_records SET document_id=?1, revision=3",
            [id(2)],
        )
        .unwrap();
    assert!(matches!(
        is_quarantined(&connection, &id(2)),
        Err(MigrationError::Corrupt)
    ));
    connection.execute_batch("PRAGMA ignore_check_constraints=ON; UPDATE recovery_records SET revision=2,status='unknown';").unwrap();
    assert!(matches!(
        is_quarantined(&connection, &id(2)),
        Err(MigrationError::Corrupt)
    ));
    // Emulate a corrupt database produced outside the normal FK-enforced writer.
    connection.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    connection
        .execute("DELETE FROM recovery_records", [])
        .unwrap();
    assert!(matches!(
        is_quarantined(&connection, &id(2)),
        Err(MigrationError::Corrupt)
    ));
}

#[cfg(unix)]
#[test]
fn management_verification_rejects_replaced_or_missing_profile_lease() {
    let fixture = Fixture::new();
    let store = identifier_migration::open_management_profile(&fixture.profile).unwrap();
    let lease = fixture.profile.join("identifier-migration.lock");
    fs::rename(&lease, fixture.profile.join("held-lease")).unwrap();
    assert!(matches!(store.verify(), Err(MigrationError::SourceChanged)));
    fs::write(&lease, []).unwrap();
    assert!(matches!(store.verify(), Err(MigrationError::SourceChanged)));
    // Lease verification must leave the separate SQLite fence intact.
    let another = fixture.connection();
    another.busy_timeout(std::time::Duration::ZERO).unwrap();
    assert!(another
        .query_row("SELECT count(*) FROM quota", [], |row| row.get::<_, i64>(0))
        .is_err());
}

#[test]
fn quarantine_requires_hash_tombstone_and_no_active_value() {
    for mutation in [
        "UPDATE recovery_records SET payload_hash=replace(payload_hash,'a','b')",
        "DELETE FROM state_tombstones",
        "UPDATE state_tombstones SET revision=3",
        "INSERT INTO documents VALUES ('active','{}',2,1,'root','page.html',1)",
    ] {
        let fixture = Fixture::new();
        let mut connection = fixture.connection();
        quarantined(&mut connection);
        validate(&connection).unwrap();
        assert!(is_quarantined(&connection, &id(2)).unwrap());
        let sql = if mutation.starts_with("INSERT") {
            format!(
                "INSERT INTO documents VALUES ('{}','{{}}',2,1,'{}','page.html',1)",
                id(2),
                id(3)
            )
        } else {
            mutation.into()
        };
        connection.execute_batch(&sql).unwrap();
        assert!(validate(&connection).is_err(), "{mutation}");
    }
}

#[test]
fn restored_history_survives_normal_updates_and_requarantine() {
    let fixture = Fixture::new();
    let mut connection = fixture.connection();
    quarantined(&mut connection);
    connection.execute("UPDATE recovery_records SET status='restored',restore_operation_id=?1,restored_revision=3", [id(4)]).unwrap();
    connection
        .execute("UPDATE state_tombstones SET revision=3", [])
        .unwrap();
    connection
        .execute(
            "INSERT INTO documents VALUES (?1,'{}',2,5,?2,'renamed.html',3)",
            params![id(2), id(3)],
        )
        .unwrap();
    connection
        .execute("UPDATE quota SET bytes=2,documents=1,generation=3", [])
        .unwrap();
    identifier_migration::validate_db(&connection).unwrap();
    assert!(!is_quarantined(&connection, &id(2)).unwrap());
    connection
        .execute_batch("BEGIN; UPDATE documents SET revision=1;")
        .unwrap();
    assert!(matches!(
        is_quarantined(&connection, &id(2)),
        Err(MigrationError::Corrupt)
    ));
    connection.execute("DELETE FROM documents", []).unwrap();
    assert!(matches!(
        is_quarantined(&connection, &id(2)),
        Err(MigrationError::Corrupt)
    ));
    connection.execute_batch("ROLLBACK").unwrap();
    connection.execute("INSERT INTO recovery_records VALUES (?1,?2,'{}',2,5,?3,'renamed.html',3,?4,1,'quarantined',NULL,NULL)", params![id(5),id(2),id(3),payload_hash("{}")]).unwrap();
    connection
        .execute(
            "UPDATE state_tombstones SET revision=5,operation_id=?1",
            [id(5)],
        )
        .unwrap();
    connection.execute("DELETE FROM documents", []).unwrap();
    connection
        .execute("UPDATE quota SET bytes=0,documents=0,generation=4", [])
        .unwrap();
    identifier_migration::validate_db(&connection).unwrap();
    assert!(is_quarantined(&connection, &id(2)).unwrap());
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM recovery_records", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn inspection_v2_validates_metadata_without_parsing_recovery_values() {
    let fixture = Fixture::new();
    let mut connection = fixture.connection();
    quarantined(&mut connection);
    connection
        .execute(
            "UPDATE recovery_records SET data='xx',payload_hash=?1",
            [payload_hash("xx")],
        )
        .unwrap();
    validate_metadata(&connection).unwrap();
    assert!(validate(&connection).is_err());
    drop(connection);
    let before = files(&fixture.state);
    identifier_migration::inspect_state_snapshot(&fixture.state, |_, _, _| Ok(())).unwrap();
    assert_eq!(files(&fixture.state), before);
}

#[test]
fn corrupt_or_unbounded_metadata_and_payloads_fail_closed() {
    for mutation in [
        "UPDATE recovery_records SET bytes=0",
        "UPDATE recovery_records SET data='{} '",
        "UPDATE recovery_records SET path='../secret'",
        "UPDATE recovery_records SET document_id='bad'",
        "UPDATE recovery_records SET generation=3",
        "UPDATE recovery_records SET created_unix_ms=-1",
        "UPDATE recovery_records SET restore_operation_id='invalid'",
        "UPDATE recovery_records SET status='restored'",
        "UPDATE recovery_records SET data=zeroblob(6000000)",
    ] {
        let fixture = Fixture::new();
        let mut connection = fixture.connection();
        quarantined(&mut connection);
        connection.execute_batch(mutation).unwrap();
        assert!(validate(&connection).is_err(), "{mutation}");
    }
    assert_eq!(validated_app_count("{}", 2).unwrap(), 0);
    assert!(validated_app_count("[]", 2).is_err());
    assert!(validated_app_count(r#"{"":0}"#, 6).is_err());
    let many: serde_json::Map<_, _> = (0..129)
        .map(|index| (format!("app{index}"), serde_json::json!(0)))
        .collect();
    let data = serde_json::to_string(&many).unwrap();
    assert!(validated_app_count(&data, data.len() as i64).is_err());
}

#[test]
fn management_refuses_missing_lock_sidecars_and_unknown_profile_entries() {
    let fixture = Fixture::new();
    let missing = fixture._base.path().join("missing");
    assert!(identifier_migration::open_management_profile(&missing).is_err());
    assert!(!missing.exists());
    fs::remove_file(fixture.profile.join("identifier-migration.lock")).unwrap();
    assert!(identifier_migration::open_management_profile(&fixture.profile).is_err());
    assert!(!fixture.profile.join("identifier-migration.lock").exists());
    fs::write(fixture.profile.join("identifier-migration.lock"), []).unwrap();
    for entry in [
        "state.sqlite-journal",
        "state.sqlite-wal",
        "state.sqlite-shm",
    ] {
        fs::write(fixture.state.join(entry), b"synthetic preserved sidecar").unwrap();
        let before = files(&fixture.state);
        assert!(identifier_migration::open_management_profile(&fixture.profile).is_err());
        assert_eq!(files(&fixture.state), before);
        fs::remove_file(fixture.state.join(entry)).unwrap();
    }
    fs::write(fixture.profile.join("unexpected"), []).unwrap();
    assert!(identifier_migration::open_management_profile(&fixture.profile).is_err());
}

#[test]
fn migrated_profile_routes_only_matching_existing_bundle() {
    let fixture = Fixture::new();
    let bundle = fixture.profile.join("identifier-migration-v1");
    fs::create_dir(&bundle).unwrap();
    fs::rename(&fixture.state, bundle.join("document-state")).unwrap();
    let marker = serde_json::json!({"version":1,"legacy":identifier_migration::LEGACY_IDENTIFIER,"current":"com.fixture.current","settings":false,"orders":false,"database":true});
    fs::write(
        bundle.join("complete.json"),
        serde_json::to_vec(&marker).unwrap(),
    )
    .unwrap();
    let store = identifier_migration::open_management_profile(&fixture.profile).unwrap();
    assert_eq!(
        store
            .connection
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(store);
    fs::create_dir(&fixture.state).unwrap();
    assert!(identifier_migration::open_management_profile(&fixture.profile).is_err());
    fs::remove_dir(&fixture.state).unwrap();
    let mut invalid = marker;
    invalid["current"] = serde_json::json!("another.profile");
    fs::write(
        bundle.join("complete.json"),
        serde_json::to_vec(&invalid).unwrap(),
    )
    .unwrap();
    assert!(identifier_migration::open_management_profile(&fixture.profile).is_err());
}

#[cfg(unix)]
#[test]
fn database_links_and_profile_replacement_do_not_redirect_management() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let database = fixture.state.join("state.sqlite");
    let original = fixture._base.path().join("original.sqlite");
    fs::rename(&database, &original).unwrap();
    symlink(&original, &database).unwrap();
    assert!(identifier_migration::open_management_profile(&fixture.profile).is_err());
    fs::remove_file(&database).unwrap();
    fs::hard_link(&original, &database).unwrap();
    assert!(identifier_migration::open_management_profile(&fixture.profile).is_err());
    fs::remove_file(&database).unwrap();
    fs::rename(&original, &database).unwrap();
    let store = identifier_migration::open_management_profile(&fixture.profile).unwrap();
    let moved = fixture._base.path().join("moved");
    fs::rename(&fixture.profile, &moved).unwrap();
    fs::create_dir(&fixture.profile).unwrap();
    assert!(store.verify().is_err());
    assert!(moved.join("document-state/state.sqlite").is_file());
}

#[test]
fn cancelled_upgrade_rolls_back_schema_before_return_and_can_retry() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let fixture = Fixture::new();
    let mut connection = fixture.connection();
    let before = files(&fixture.state);
    let cancel = Arc::new(AtomicBool::new(false));
    let progress_cancel = Arc::clone(&cancel);
    connection
        .progress_handler(1, Some(move || progress_cancel.load(Ordering::SeqCst)))
        .unwrap();
    let result = upgrade(&mut connection, || {
        // The schema and user_version have been changed, but commit has not
        // occurred. A still-expired handler must not cancel rollback.
        cancel.store(true, Ordering::SeqCst);
        Err(MigrationError::Interrupted)
    });
    assert!(matches!(result, Err(MigrationError::Interrupted)));
    assert!(connection.is_autocommit());
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(connection.query_row("SELECT count(*) FROM sqlite_schema WHERE name IN ('recovery_records','state_tombstones')",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    assert_eq!(files(&fixture.state), before);
    upgrade(&mut connection, || Ok(())).unwrap();
    assert!(connection.is_autocommit());
    validate(&connection).unwrap();
}

#[test]
fn interrupted_ddl_preserves_original_error_after_sqlite_auto_rollback() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    let fixture = Fixture::new();
    let mut connection = fixture.connection();
    let cancel = Arc::new(AtomicBool::new(false));
    let auth_cancel = Arc::clone(&cancel);
    connection
        .authorizer(Some(move |context: AuthContext<'_>| {
            if matches!(
                context.action,
                AuthAction::CreateTable {
                    table_name: "state_tombstones"
                }
            ) {
                auth_cancel.store(true, Ordering::SeqCst);
            }
            Authorization::Allow
        }))
        .unwrap();
    let progress_cancel = Arc::clone(&cancel);
    connection
        .progress_handler(1, Some(move || progress_cancel.load(Ordering::SeqCst)))
        .unwrap();
    assert!(matches!(
        upgrade(&mut connection, || Ok(())),
        Err(MigrationError::Interrupted)
    ));
    assert!(cancel.load(Ordering::SeqCst));
    assert!(connection.is_autocommit());
    connection
        .authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
        .unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    upgrade(&mut connection, || Ok(())).unwrap();
    validate(&connection).unwrap();
}

#[test]
fn interrupted_begin_never_leaves_an_unguarded_transaction_or_masks_the_error() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    for interrupt_after in 1..=5 {
        let fixture = Fixture::new();
        let mut connection = fixture.connection();
        let begin = Arc::new(AtomicBool::new(false));
        let auth_begin = Arc::clone(&begin);
        connection
            .authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(
                    context.action,
                    AuthAction::Transaction {
                        operation: TransactionOperation::Begin
                    }
                ) {
                    auth_begin.store(true, Ordering::SeqCst);
                }
                Authorization::Allow
            }))
            .unwrap();
        let operations = Arc::new(AtomicUsize::new(0));
        let progress_operations = Arc::clone(&operations);
        connection
            .progress_handler(
                1,
                Some(move || {
                    begin.load(Ordering::SeqCst)
                        && progress_operations.fetch_add(1, Ordering::SeqCst) + 1 >= interrupt_after
                }),
            )
            .unwrap();
        assert!(matches!(
            upgrade(&mut connection, || Ok(())),
            Err(MigrationError::Interrupted)
        ));
        assert!(operations.load(Ordering::SeqCst) >= interrupt_after);
        assert!(connection.is_autocommit());
        connection
            .authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
            .unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        upgrade(&mut connection, || Ok(())).unwrap();
        validate(&connection).unwrap();
    }
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "BEGIN; CREATE TABLE preserved(value INTEGER); INSERT INTO preserved VALUES(7)",
        )
        .unwrap();
    assert!(matches!(
        begin_atomic(&connection),
        Err(rusqlite::Error::InvalidQuery)
    ));
    assert!(!connection.is_autocommit());
    assert_eq!(
        connection
            .query_row("SELECT value FROM preserved", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        7
    );
    connection.execute_batch("ROLLBACK").unwrap();
}
