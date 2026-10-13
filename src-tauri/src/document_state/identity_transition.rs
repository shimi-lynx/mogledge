//! Test-only transactional migration model. No IPC, production schema change,
//! Native identity activation or user-profile migration is wired to this code.
use super::{DocumentState, Operation, StateRequest, StateResponse};
use crate::state_inspection::recovery_store;
use rusqlite::{params, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek},
    time::{Duration, Instant},
};

#[derive(Clone, PartialEq, Eq)]
struct Binding {
    root: String,
    document: String,
    path: String,
}

// Payloads deliberately have no Debug implementation.
#[derive(Clone, PartialEq, Eq)]
struct Record {
    data: String,
    bytes: i64,
    revision: i64,
    root: String,
    path: String,
    generation: i64,
}

#[derive(Clone)]
struct Plan {
    operation: String,
    database: String,
    generation: i64,
    source_id: String,
    source: Record,
    target: Binding,
    expires: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Error {
    Held,
    ConfirmationRequired,
    BackupChanged,
    Changed,
    TargetNotEmpty,
    Revoked,
    Quota,
    Interrupted,
    Database,
}

// The fixture creates and flushes a byte-exact backup of its closed synthetic
// database. This models only DB backup verification, not a full profile backup.
struct DatabaseBackup {
    file: File,
    hash: [u8; 32],
    source_id: String,
    source: Record,
    generation: i64,
    database: String,
}
impl DatabaseBackup {
    fn verify(&mut self, plan: &Plan) -> Result<(), Error> {
        if self.source_id != plan.source_id
            || self.source != plan.source
            || self.generation != plan.generation
            || self.database != plan.database
        {
            return Err(Error::BackupChanged);
        }
        self.file.rewind().map_err(|_| Error::BackupChanged)?;
        let mut bytes = Vec::new();
        self.file
            .by_ref()
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::BackupChanged)?;
        if bytes.len() > 4 * 1024 * 1024 || <[u8; 32]>::from(Sha256::digest(&bytes)) != self.hash {
            return Err(Error::BackupChanged);
        }
        Ok(())
    }
}

fn record(connection: &rusqlite::Connection, id: &str) -> Result<Option<Record>, Error> {
    connection
        .query_row(
            "SELECT data,bytes,revision,root,path,generation FROM documents WHERE id=?1",
            [id],
            |row| {
                Ok(Record {
                    data: super::raw_json::copy_sql(row, 0)?,
                    bytes: row.get(1)?,
                    revision: row.get(2)?,
                    root: row.get(3)?,
                    path: row.get(4)?,
                    generation: row.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|_| Error::Database)
}

fn quota(connection: &rusqlite::Connection) -> Result<(i64, i64, i64), Error> {
    connection
        .query_row(
            "SELECT bytes,documents,generation FROM quota WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| Error::Database)
}

fn prepare(store: &DocumentState, source_id: &str, target: Binding) -> Result<Plan, Error> {
    store.verify_management().map_err(|_| Error::Changed)?;
    let connection = store.connection.lock().map_err(|_| Error::Database)?;
    for id in [source_id, target.document.as_str()] {
        if recovery_store::is_quarantined(&connection, id).map_err(|_| Error::Database)? {
            return Err(Error::Revoked);
        }
    }
    let source = record(&connection, source_id)?.ok_or(Error::Changed)?;
    if source.bytes != source.data.len() as i64 || source.revision <= 0 {
        return Err(Error::Database);
    }
    if record(&connection, &target.document)?.is_some() {
        return Err(Error::TargetNotEmpty);
    }
    Ok(Plan {
        operation: crate::core::random_token(),
        database: store.management_database_id.clone(),
        generation: quota(&connection)?.2,
        source_id: source_id.to_owned(),
        source,
        target,
        expires: Instant::now() + Duration::from_secs(300),
    })
}

fn confirm(
    store: &DocumentState,
    plan: &Plan,
    current: &Binding,
    acknowledgement: Option<&str>,
    backup: &mut DatabaseBackup,
    interrupt_before_commit: bool,
) -> Result<(), Error> {
    if acknowledgement != Some(plan.operation.as_str()) {
        return Err(Error::ConfirmationRequired);
    }
    if current != &plan.target
        || Instant::now() >= plan.expires
        || store.management_database_id != plan.database
    {
        return Err(Error::Changed);
    }
    backup.verify(plan)?;
    store.verify_management().map_err(|_| Error::Changed)?;
    let mut connection = store.connection.lock().map_err(|_| Error::Database)?;
    crate::storage_limits::cap_database(&connection).map_err(|_| Error::Database)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| Error::Database)?;
    let (bytes, count, generation) = quota(&transaction)?;
    if generation != plan.generation {
        return Err(Error::Changed);
    }
    for id in [&plan.source_id, &current.document] {
        if recovery_store::is_quarantined(&transaction, id).map_err(|_| Error::Database)? {
            return Err(Error::Revoked);
        }
    }
    if record(&transaction, &plan.source_id)?.as_ref() != Some(&plan.source) {
        return Err(Error::Changed);
    }
    if record(&transaction, &current.document)?.is_some() {
        return Err(Error::TargetNotEmpty);
    }
    recovery_store::validated_app_count(&plan.source.data, plan.source.bytes)
        .map_err(|_| Error::Database)?;
    let limits = crate::storage_limits::read(&transaction).map_err(|_| Error::Database)?;
    let next_bytes = bytes.checked_add(plan.source.bytes).ok_or(Error::Quota)?;
    let next_count = count.checked_add(1).ok_or(Error::Quota)?;
    let next_generation = generation.checked_add(1).ok_or(Error::Quota)?;
    if plan.source.bytes > limits.document_bytes as i64
        || next_bytes > limits.total_bytes
        || next_count > super::MAX_DOCUMENTS
    {
        return Err(Error::Quota);
    }
    // Do not remove the old record or subtract its quota. The source's revision
    // remains provenance; the new physical target starts its own revision at 1.
    transaction
        .execute(
            "INSERT INTO documents VALUES(?1,?2,?3,1,?4,?5,?6)",
            params![
                current.document,
                plan.source.data,
                plan.source.bytes,
                current.root,
                current.path,
                next_generation
            ],
        )
        .map_err(|_| Error::Database)?;
    transaction
        .execute(
            "UPDATE quota SET bytes=?1,documents=?2,generation=?3 WHERE singleton=1",
            params![next_bytes, next_count, next_generation],
        )
        .map_err(|_| Error::Database)?;
    transaction
        .execute(
            "INSERT INTO candidate_identity_confirmations VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                current.document,
                current.root,
                plan.operation,
                plan.source_id,
                plan.source.revision,
                next_generation
            ],
        )
        .map_err(|_| Error::Database)?;
    if interrupt_before_commit {
        return Err(Error::Interrupted);
    }
    if Instant::now() >= plan.expires {
        return Err(Error::Changed);
    }
    transaction.commit().map_err(|_| Error::Database)?;
    Ok(())
}

// In the model, an unconfirmed document cannot read successful null or write
// defaults. This wrapper is deliberately absent from the production endpoint.
fn apply_confirmed(
    store: &DocumentState,
    root: &std::path::Path,
    binding: &Binding,
    request: StateRequest,
) -> Result<StateResponse, Error> {
    {
        let connection = store.connection.lock().map_err(|_| Error::Database)?;
        let confirmed = connection
            .query_row(
                "SELECT root FROM candidate_identity_confirmations WHERE id=?1",
                [&binding.document],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| Error::Database)?;
        if confirmed.as_deref() != Some(binding.root.as_str()) {
            return Err(Error::Held);
        }
    }
    store
        .apply(
            root,
            &binding.root,
            &binding.path,
            &binding.document,
            request,
        )
        .map_err(|_| Error::Database)
}

struct Fixture {
    state: tempfile::TempDir,
    root: tempfile::TempDir,
    store: DocumentState,
    backup: DatabaseBackup,
    source_id: String,
    target: Binding,
}
impl Fixture {
    fn new(value: serde_json::Value) -> Self {
        use crate::knowledge::persistent_identity::{
            document, legacy_document, root, MountedObject,
        };
        use std::io::Write;
        let state = tempfile::tempdir().unwrap();
        let knowledge = tempfile::tempdir().unwrap();
        let before_root = MountedObject {
            volume_uuid: [1; 16],
            device: 17,
            file_id: 100,
            created_ns: 1000,
        };
        let before_file = MountedObject {
            file_id: 101,
            ..before_root
        };
        let source_id = legacy_document(before_root, before_file);
        let after_root = MountedObject {
            device: 42,
            ..before_root
        };
        let after_file = MountedObject {
            device: 42,
            ..before_file
        };
        let target = Binding {
            root: root(after_root).unwrap(),
            document: document(after_root, after_file).unwrap(),
            path: "renamed/app.html".into(),
        };
        let (source_snapshot, generation, database) = {
            let store = DocumentState::new(state.path().to_owned()).unwrap();
            store
                .apply(
                    knowledge.path(),
                    &"a".repeat(64),
                    "old/app.html",
                    &source_id,
                    StateRequest {
                        version: 1,
                        op: Operation::Write,
                        key: "app".into(),
                        value: Some(value),
                    },
                )
                .unwrap();
            // Model metadata lives only in this disposable fixture. Production
            // format v1/v2 and its normal readers remain unchanged.
            store.connection.lock().unwrap().execute_batch("CREATE TABLE candidate_identity_confirmations(id TEXT PRIMARY KEY,root TEXT NOT NULL,operation TEXT UNIQUE NOT NULL,source TEXT NOT NULL,source_revision INTEGER NOT NULL,generation INTEGER NOT NULL)").unwrap();
            let connection = store.connection.lock().unwrap();
            (
                record(&connection, &source_id).unwrap().unwrap(),
                quota(&connection).unwrap().2,
                store.management_database_id.clone(),
            )
        };
        let bytes = std::fs::read(state.path().join("state.sqlite")).unwrap();
        let mut backup_file = tempfile::tempfile().unwrap();
        backup_file.write_all(&bytes).unwrap();
        backup_file.sync_all().unwrap();
        let backup = DatabaseBackup {
            file: backup_file,
            hash: Sha256::digest(bytes).into(),
            source_id: source_id.clone(),
            source: source_snapshot,
            generation,
            database,
        };
        let store = DocumentState::new(state.path().to_owned()).unwrap();
        Self {
            state,
            root: knowledge,
            store,
            backup,
            source_id,
            target,
        }
    }
    fn request(op: Operation) -> StateRequest {
        StateRequest {
            version: 1,
            value: matches!(op, Operation::Write).then(|| serde_json::json!("default")),
            op,
            key: "app".into(),
        }
    }
    fn plan(&self) -> Plan {
        prepare(&self.store, &self.source_id, self.target.clone()).unwrap()
    }
    fn untouched(&self, before: &(Record, (i64, i64, i64))) {
        let connection = self.store.connection.lock().unwrap();
        assert!(record(&connection, &self.source_id).unwrap().as_ref() == Some(&before.0));
        assert_eq!(quota(&connection).unwrap(), before.1);
        assert!(record(&connection, &self.target.document)
            .unwrap()
            .is_none());
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM candidate_identity_confirmations",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
    }
    fn before(&self) -> (Record, (i64, i64, i64)) {
        let connection = self.store.connection.lock().unwrap();
        (
            record(&connection, &self.source_id).unwrap().unwrap(),
            quota(&connection).unwrap(),
        )
    }
}

#[test]
fn unconfirmed_restoration_and_defaults_remain_held_without_mutating_legacy_input() {
    let mut fixture =
        Fixture::new(serde_json::json!({"schemaVersion":1,"data":{"input":"retained"}}));
    let before = fixture.before();
    for op in [Operation::Read, Operation::Write, Operation::Delete] {
        assert!(matches!(
            apply_confirmed(
                &fixture.store,
                fixture.root.path(),
                &fixture.target,
                Fixture::request(op)
            ),
            Err(Error::Held)
        ));
    }
    let plan = fixture.plan();
    assert_eq!(
        confirm(
            &fixture.store,
            &plan,
            &fixture.target,
            None,
            &mut fixture.backup,
            false
        ),
        Err(Error::ConfirmationRequired)
    );
    fixture.untouched(&before);
}

#[test]
fn confirmed_copy_survives_reopen_preserves_source_and_counts_both_records() {
    let mut fixture =
        Fixture::new(serde_json::json!({"schemaVersion":1,"data":{"input":"retained"}}));
    let before = fixture.before();
    let plan = fixture.plan();
    confirm(
        &fixture.store,
        &plan,
        &fixture.target,
        Some(&plan.operation),
        &mut fixture.backup,
        false,
    )
    .unwrap();
    drop(fixture.store);
    fixture.store = DocumentState::new(fixture.state.path().to_owned()).unwrap();
    let read = apply_confirmed(
        &fixture.store,
        fixture.root.path(),
        &fixture.target,
        Fixture::request(Operation::Read),
    )
    .unwrap();
    assert_eq!(
        read.value,
        serde_json::json!({"schemaVersion":1,"data":{"input":"retained"}})
    );
    assert_eq!(read.revision, 1);
    let connection = fixture.store.connection.lock().unwrap();
    assert!(record(&connection, &fixture.source_id).unwrap().as_ref() == Some(&before.0));
    assert_eq!(
        quota(&connection).unwrap(),
        (before.1 .0 * 2, 2, before.1 .2 + 1)
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT operation FROM candidate_identity_confirmations WHERE id=?1",
                [&fixture.target.document],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        plan.operation
    );
    drop(connection);
    // A lost UI response does not permit applying the same plan a second time.
    assert_eq!(
        confirm(
            &fixture.store,
            &plan,
            &fixture.target,
            Some(&plan.operation),
            &mut fixture.backup,
            false
        ),
        Err(Error::Changed)
    );
}

#[test]
fn changed_target_source_generation_or_backup_and_expiry_cannot_confirm() {
    for case in 0..6 {
        let mut fixture = Fixture::new(serde_json::json!({"schemaVersion":1,"data":"retained"}));
        let mut plan = fixture.plan();
        let mut current = fixture.target.clone();
        match case {
            0 => current.root = "b".repeat(64),
            1 => current.document = "c".repeat(64),
            2 => {
                fixture
                    .store
                    .connection
                    .lock()
                    .unwrap()
                    .execute("UPDATE documents SET revision=revision+1", [])
                    .unwrap();
            }
            3 => {
                fixture
                    .store
                    .connection
                    .lock()
                    .unwrap()
                    .execute("UPDATE quota SET generation=generation+1", [])
                    .unwrap();
            }
            4 => {
                fixture.backup.file.set_len(0).unwrap();
            }
            _ => plan.expires = Instant::now(),
        }
        let before = fixture.before();
        let error = confirm(
            &fixture.store,
            &plan,
            &current,
            Some(&plan.operation),
            &mut fixture.backup,
            false,
        );
        assert_eq!(
            error,
            Err(if case == 4 {
                Error::BackupChanged
            } else {
                Error::Changed
            })
        );
        fixture.untouched(&before);
    }
}

#[test]
fn nonempty_target_is_never_replaced_and_retaining_source_can_exceed_quota() {
    let fixture = Fixture::new(serde_json::json!({"schemaVersion":1,"data":"retained"}));
    fixture
        .store
        .apply(
            fixture.root.path(),
            &fixture.target.root,
            &fixture.target.path,
            &fixture.target.document,
            Fixture::request(Operation::Write),
        )
        .unwrap();
    assert!(matches!(
        prepare(&fixture.store, &fixture.source_id, fixture.target.clone()),
        Err(Error::TargetNotEmpty)
    ));
    let mut fixture =
        Fixture::new(serde_json::json!({"schemaVersion":1,"data":"x".repeat(700*1024)}));
    fixture
        .store
        .connection
        .lock()
        .unwrap()
        .execute_batch(&format!(
            "{}; INSERT INTO storage_limits VALUES(1,1048576,1048576,1);",
            crate::storage_limits::LEGACY_DDL
        ))
        .unwrap();
    let before = fixture.before();
    let plan = fixture.plan();
    assert_eq!(
        confirm(
            &fixture.store,
            &plan,
            &fixture.target,
            Some(&plan.operation),
            &mut fixture.backup,
            false
        ),
        Err(Error::Quota)
    );
    fixture.untouched(&before);
}

#[test]
fn backup_of_an_earlier_source_revision_does_not_authorize_a_new_plan() {
    let mut fixture = Fixture::new(serde_json::json!({"schemaVersion":1,"data":"before"}));
    fixture
        .store
        .apply(
            fixture.root.path(),
            &"a".repeat(64),
            "old/app.html",
            &fixture.source_id,
            StateRequest {
                version: 1,
                op: Operation::Write,
                key: "app".into(),
                value: Some(serde_json::json!({"schemaVersion":1,"data":"after"})),
            },
        )
        .unwrap();
    let before = fixture.before();
    let plan = fixture.plan();
    assert_eq!(
        confirm(
            &fixture.store,
            &plan,
            &fixture.target,
            Some(&plan.operation),
            &mut fixture.backup,
            false
        ),
        Err(Error::BackupChanged)
    );
    fixture.untouched(&before);
}

#[test]
fn quarantined_source_or_target_blocks_both_preview_and_confirmation() {
    for quarantine_source in [false, true] {
        let mut fixture = Fixture::new(serde_json::json!({"schemaVersion":1,"data":"retained"}));
        let plan = fixture.plan();
        {
            let connection = fixture.store.connection.lock().unwrap();
            // Exercise the existing recovery format's refusal, without trying
            // to upgrade a real profile or claim this model is schema v3.
            connection
                .execute_batch(&format!(
                    "{}; {}; PRAGMA user_version=2;",
                    recovery_store::RECORDS_DDL,
                    recovery_store::TOMBSTONES_DDL
                ))
                .unwrap();
            let id = if quarantine_source {
                &fixture.source_id
            } else {
                &fixture.target.document
            };
            let operation = "d".repeat(64);
            connection.execute("INSERT INTO recovery_records VALUES(?1,?2,'{}',2,2,?3,'page.html',1,?4,0,'quarantined',NULL,NULL)",params![operation,id,fixture.target.root,recovery_store::payload_hash("{}")]).unwrap();
            connection
                .execute(
                    "INSERT INTO state_tombstones VALUES(?1,2,?2)",
                    params![id, operation],
                )
                .unwrap();
        }
        let before = fixture.before();
        assert!(matches!(
            prepare(&fixture.store, &fixture.source_id, fixture.target.clone()),
            Err(Error::Revoked)
        ));
        assert_eq!(
            confirm(
                &fixture.store,
                &plan,
                &fixture.target,
                Some(&plan.operation),
                &mut fixture.backup,
                false
            ),
            Err(Error::Revoked)
        );
        fixture.untouched(&before);
    }
}

#[test]
fn interrupted_or_sql_rejected_publication_rolls_back_copy_quota_and_confirmation() {
    for reject_sql in [false, true] {
        let mut fixture = Fixture::new(serde_json::json!({"schemaVersion":1,"data":"retained"}));
        if reject_sql {
            fixture.store.connection.lock().unwrap().execute_batch("CREATE TRIGGER reject_confirmation BEFORE INSERT ON candidate_identity_confirmations BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap();
        }
        let before = fixture.before();
        let before_bytes = std::fs::read(fixture.state.path().join("state.sqlite")).unwrap();
        let plan = fixture.plan();
        assert_eq!(
            confirm(
                &fixture.store,
                &plan,
                &fixture.target,
                Some(&plan.operation),
                &mut fixture.backup,
                !reject_sql
            ),
            Err(if reject_sql {
                Error::Database
            } else {
                Error::Interrupted
            })
        );
        fixture.untouched(&before);
        assert_eq!(
            std::fs::read(fixture.state.path().join("state.sqlite")).unwrap(),
            before_bytes
        );
    }
}
