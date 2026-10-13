//! Explicit, stopped-profile management. Session plans never contain state data.
use super::{
    backend_error,
    collector::{Availability, ConnectedRoot, Observation},
    error, recovery_store, report, InspectionError, MAX_PAGE, MAX_RECORDS,
};
use crate::{
    identifier_migration::{self, ManagementStore, MigrationError},
    knowledge,
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{BufRead, Write},
    path::Path,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const MAX_COMMAND_BYTES: usize = 16 * 1024;
const MAX_PLANS: usize = 16;
const MAX_SESSION_COMMANDS: usize = 4096;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    plan_id: String,
    operation: String,
    candidate_id: String,
    database_id: String,
    snapshot_id: String,
    root_identity: String,
    revision: i64,
    generation: i64,
    logical_bytes: i64,
    app_count: usize,
    expires_elapsed_ms: u64,
    effect: &'static str,
}

pub(crate) struct Record {
    pub(crate) id: String,
    pub(crate) root: String,
    pub(crate) path: String,
    pub(crate) data: String,
    pub(crate) bytes: i64,
    pub(crate) revision: i64,
    pub(crate) generation: i64,
    pub(crate) hash: String,
}

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Inspect {
        #[serde(default)]
        offset: usize,
        #[serde(default = "default_limit")]
        limit: usize,
    },
    ListRecovery {
        #[serde(default)]
        offset: usize,
        #[serde(default = "default_limit")]
        limit: usize,
    },
    PrepareUpgrade,
    PrepareQuarantine {
        document_identity: String,
        snapshot_id: String,
    },
    PrepareRestore {
        recovery_id: String,
        snapshot_id: String,
    },
    OperationStatus {
        operation_id: String,
    },
    Confirm {
        plan_id: String,
        confirmation: String,
    },
    Quit,
}
fn default_limit() -> usize {
    20
}
fn management_error(code: &'static str) -> InspectionError {
    error(code, "Management stopped this operation; state values are never included in diagnostics. Inspect and explicitly select again.")
}
fn database_error(error: rusqlite::Error) -> InspectionError {
    backend_error(super::sql_error(error))
}

pub(crate) struct Session {
    pub(crate) store: ManagementStore,
    pub(crate) root: Option<ConnectedRoot>,
    pub(crate) started: Instant,
    plans: BTreeMap<String, Plan>,
    completed: BTreeMap<String, serde_json::Value>,
    session_id: String,
}

impl Session {
    /// profile must be the existing current identifier's local-data directory;
    /// the shared runtime lease and SQLite exclusive connection are retained.
    pub(crate) fn open(profile: &Path, root: Option<&Path>) -> Result<Self, InspectionError> {
        let store =
            identifier_migration::open_management_profile(profile).map_err(backend_error)?;
        let profile = profile
            .canonicalize()
            .map_err(|_| backend_error(MigrationError::UnsafePath))?;
        let root = root.and_then(|root| ConnectedRoot::open(root, &profile).ok());
        Ok(Self {
            store,
            root,
            started: Instant::now(),
            plans: BTreeMap::new(),
            completed: BTreeMap::new(),
            session_id: crate::core::random_token(),
        })
    }

    pub(crate) fn elapsed_ms(&self) -> u64 {
        self.started
            .elapsed()
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX)
    }
    fn limit_database_work(&self) -> Result<(), InspectionError> {
        let deadline = Instant::now() + std::time::Duration::from_secs(2);
        self.store
            .connection
            .progress_handler(1000, Some(move || Instant::now() >= deadline))
            .map_err(database_error)
    }
    fn version(&self) -> Result<i64, InspectionError> {
        self.store
            .connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(database_error)
    }
    pub(crate) fn snapshot(
        &self,
        limit: usize,
        offset: usize,
    ) -> Result<super::Report, InspectionError> {
        if !(1..=MAX_PAGE).contains(&limit) || offset > MAX_RECORDS as usize {
            return Err(management_error("invalid_arguments"));
        }
        self.store.verify().map_err(backend_error)?;
        let database_bytes = self.store.database_bytes().map_err(backend_error)?;
        let result = (|| {
            self.store
                .connection
                .execute_batch("BEGIN DEFERRED;")
                .map_err(database_error)?;
            if self.version()? >= 2 {
                recovery_store::validate_metadata(&self.store.connection).map_err(backend_error)?;
            }
            report(
                &self.store.connection,
                database_bytes,
                self.store.database_id(),
                limit,
                offset,
                None,
            )
            .map_err(backend_error)
        })();
        // The expired query budget must not interrupt its own cleanup. SQLite
        // may already have rolled back an interrupted statement automatically.
        self.store
            .connection
            .progress_handler(0, None::<fn() -> bool>)
            .map_err(database_error)?;
        if !self.store.connection.is_autocommit() {
            self.store
                .connection
                .execute_batch("ROLLBACK;")
                .map_err(database_error)?;
        }
        self.limit_database_work()?;
        self.store.verify().map_err(backend_error)?;
        let mut report = result?;
        report.journal_bytes = self.store.journal_bytes().map_err(backend_error)?;
        Ok(report)
    }

    fn observation(&self) -> Option<Observation> {
        self.root.as_ref().map(ConnectedRoot::scan)
    }

    fn locate(
        &self,
        observation: Option<&Observation>,
        record: &Record,
    ) -> (Availability, Option<String>) {
        match (&self.root, observation) {
            (Some(root), Some(observation)) if root.identity == record.root => {
                root.locate(observation, &record.id, &record.path)
            }
            _ => (Availability::Unavailable, None),
        }
    }

    fn record(&self, id: &str, recovery: bool) -> Result<Record, InspectionError> {
        read_record(&self.store.connection, id, recovery)
    }

    pub(crate) fn inspect(
        &self,
        offset: usize,
        limit: usize,
    ) -> Result<serde_json::Value, InspectionError> {
        let mut report = self.snapshot(limit, offset)?;
        let observation = self.observation();
        report.source_scan = match &observation {
            Some(o) if o.complete => "complete_explicit_root_metadata",
            Some(_) => "incomplete_explicit_root_metadata",
            None => "not_performed",
        };
        for candidate in &mut report.candidates {
            // Only location metadata is queried during inspection, not state data.
            let path: String = self
                .store
                .connection
                .query_row(
                    "SELECT path FROM documents WHERE id=?1",
                    [&candidate.document_identity],
                    |r| r.get(0),
                )
                .map_err(database_error)?;
            let availability = match (&self.root, &observation) {
                (Some(root), Some(observation)) if root.identity == candidate.root_identity => {
                    root.locate(observation, &candidate.document_identity, &path)
                        .0
                }
                _ => Availability::Unavailable,
            };
            candidate.activity = "fenced_inactive_stopped_profile";
            candidate.source_availability = match availability {
                Availability::SameIdentity => "same_identity_present",
                Availability::RelocatedIdentity => "same_identity_relocated",
                Availability::DifferentIdentityAtPath => "different_identity_recovery_history",
                Availability::NotFoundInCompleteScan => "not_found_single_scan",
                Availability::Unavailable => "unavailable",
            };
            candidate
                .reasons
                .retain(|reason| !["source_not_checked", "activity_unknown"].contains(reason));
            candidate.reasons.push(match availability {
                Availability::SameIdentity | Availability::RelocatedIdentity => {
                    "explicit_reversible_stop_requires_selection"
                }
                Availability::DifferentIdentityAtPath => "preserve_recovery_history",
                Availability::NotFoundInCompleteScan => "absence_requires_recheck",
                Availability::Unavailable => "source_unavailable_hold",
            });
        }
        let mut value =
            serde_json::to_value(report).map_err(|_| management_error("output_error"))?;
        value["managementSession"] = serde_json::json!({"sessionId":self.session_id,"mode":"stopped_profile","elapsedMs":self.elapsed_ms(),"writeAuthorized":false});
        Ok(value)
    }

    fn prepare(
        &mut self,
        operation: &str,
        candidate_id: &str,
        snapshot_id: Option<&str>,
    ) -> Result<serde_json::Value, InspectionError> {
        if self.plans.len() >= MAX_PLANS {
            return Err(management_error("plan_limit"));
        }
        let snapshot = self.snapshot(1, 0)?;
        if snapshot_id.is_some_and(|expected| expected != snapshot.snapshot_id) {
            return Err(management_error("state_changed"));
        }
        let version = self.version()?;
        let (root_identity, revision, bytes, app_count, effect) = if operation == "upgrade" {
            if version != 1 {
                return Err(management_error("upgrade_not_needed"));
            }
            (String::new(),0,0,0,"Explicitly add schema v2 recovery tables; state values and active quota stay unchanged. Older apps cannot use schema v2.")
        } else {
            if !matches!(version, 2 | 3) {
                return Err(management_error("explicit_upgrade_required"));
            }
            let record = self.record(candidate_id, operation == "restore")?;
            let observation = self.observation();
            if !matches!(
                self.locate(observation.as_ref(), &record).0,
                Availability::SameIdentity | Availability::RelocatedIdentity
            ) {
                return Err(management_error("source_unavailable_hold"));
            }
            if operation == "restore" {
                let exists: bool = self
                    .store
                    .connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1)",
                        [&record.id],
                        |r| r.get(0),
                    )
                    .map_err(database_error)?;
                super::assessment::check_restore_budget_with_limits(
                    snapshot.usage.logical_bytes,
                    snapshot.usage.records,
                    record.bytes,
                    recovery_store::validated_app_count(&record.data, record.bytes)
                        .map_err(backend_error)?,
                    exists,
                    crate::storage_limits::read(&self.store.connection).map_err(backend_error)?,
                )
                .map_err(|_| management_error("restore_conflict_or_quota"))?;
            }
            (
                record.root,
                record.revision,
                record.bytes,
                recovery_store::validated_app_count(&record.data, record.bytes)
                    .map_err(backend_error)?,
                if operation == "restore" {
                    "Restore into the same physical identity only; never overwrite an existing record. Keep the recovery copy."
                } else {
                    "Stop saved-state access for this selected identity, keep a durable recovery copy, and release active logical quota. HTML stays unchanged; disk does not shrink."
                },
            )
        };
        let plan = Plan {
            plan_id: crate::core::random_token(),
            operation: operation.to_owned(),
            candidate_id: candidate_id.to_owned(),
            database_id: snapshot.database_id,
            snapshot_id: snapshot.snapshot_id,
            root_identity,
            revision,
            generation: snapshot.database_generation,
            logical_bytes: bytes,
            app_count,
            expires_elapsed_ms: self
                .elapsed_ms()
                .checked_add(super::assessment::SELECTION_LIFETIME_MS)
                .ok_or_else(|| management_error("inspection_limit"))?,
            effect,
        };
        let value = serde_json::to_value(&plan).map_err(|_| management_error("output_error"))?;
        self.plans.insert(plan.plan_id.clone(), plan);
        Ok(value)
    }

    fn confirm(
        &mut self,
        plan_id: &str,
        confirmation: &str,
    ) -> Result<serde_json::Value, InspectionError> {
        if plan_id != confirmation {
            return Err(management_error("explicit_confirmation_required"));
        }
        if let Some(receipt) = self.completed.get(plan_id) {
            return Ok(receipt.clone());
        }
        let plan = self
            .plans
            .remove(plan_id)
            .ok_or_else(|| management_error("unknown_or_consumed_plan"))?;
        if self.elapsed_ms() >= plan.expires_elapsed_ms {
            return Err(management_error("expired_plan"));
        }
        let snapshot = self.snapshot(1, 0)?;
        if plan.database_id != snapshot.database_id
            || plan.snapshot_id != snapshot.snapshot_id
            || plan.generation != snapshot.database_generation
        {
            return Err(management_error("state_changed"));
        }
        if self.elapsed_ms() >= plan.expires_elapsed_ms {
            return Err(management_error("expired_plan"));
        }
        let expires = self
            .started
            .checked_add(std::time::Duration::from_millis(plan.expires_elapsed_ms))
            .ok_or_else(|| management_error("expired_plan"))?;
        let deadline = expires.min(Instant::now() + std::time::Duration::from_secs(2));
        self.store
            .connection
            .progress_handler(1000, Some(move || Instant::now() >= deadline))
            .map_err(database_error)?;
        self.store
            .connection
            .execute_batch("PRAGMA query_only=OFF;")
            .map_err(database_error)?;
        let result = (|| {
            crate::storage_limits::cap_database(&self.store.connection).map_err(backend_error)?;
            if plan.operation == "upgrade" {
                let started = self.started;
                recovery_store::upgrade(&mut self.store.connection,||{
                if started.elapsed().as_millis()>=u128::from(plan.expires_elapsed_ms){Err(MigrationError::Interrupted)}else{Ok(())}
            }).map_err(backend_error).map(|_| serde_json::json!({"operationId":plan.plan_id,"operation":"upgrade","schemaVersion":2}))
            } else {
                self.commit_record(&plan)
            }
        })();
        // Upgrade/record finalization disables cancellation for rollback or
        // commit. Restore a finite query budget before continuing the session.
        self.limit_database_work()?;
        let reset = self
            .store
            .connection
            .execute_batch("PRAGMA query_only=ON;")
            .map_err(database_error);
        reset?;
        let receipt = result?;
        self.store.verify().map_err(backend_error)?;
        self.completed.insert(plan_id.to_owned(), receipt.clone());
        Ok(receipt)
    }

    fn commit_record(&mut self, plan: &Plan) -> Result<serde_json::Value, InspectionError> {
        let restore = plan.operation == "restore";
        let record = self.record(&plan.candidate_id, restore)?;
        if record.root != plan.root_identity
            || record.revision != plan.revision
            || record.bytes != plan.logical_bytes
        {
            return Err(management_error("state_changed"));
        }
        let observation = self.observation();
        let (_, path) = self.locate(observation.as_ref(), &record);
        let path = path.ok_or_else(|| management_error("source_unavailable_hold"))?;
        let root = self
            .root
            .as_ref()
            .ok_or_else(|| management_error("source_unavailable_hold"))?;
        if root.identity_at(&path).ok().as_deref() != Some(&record.id) {
            return Err(management_error("source_changed"));
        }
        self.store.verify().map_err(backend_error)?;
        if self.elapsed_ms() >= plan.expires_elapsed_ms {
            return Err(management_error("expired_plan"));
        }
        let transaction = match recovery_store::begin_atomic(&self.store.connection) {
            Ok(transaction) => transaction,
            Err(error) => {
                self.limit_database_work()?;
                return Err(database_error(error));
            }
        };
        let result = (|| {
            let (revision, generation) = apply_record(
                &transaction,
                &record,
                &path,
                &plan.plan_id,
                &plan.candidate_id,
                plan.app_count,
                restore,
            )?;
            // The source must still be the same identity at the last check before
            // commit. Filesystem mutations are not atomic with SQLite; any later
            // replacement cannot expose the archived state to the new identity.
            if root.identity_at(&path).ok().as_deref() != Some(&record.id) {
                return Err(management_error("source_changed"));
            }
            recovery_store::validate_metadata(&transaction).map_err(backend_error)?;
            if self.started.elapsed().as_millis() >= u128::from(plan.expires_elapsed_ms) {
                return Err(management_error("expired_plan"));
            }
            Ok((revision, generation))
        })();
        // Cancellation must not cancel its own rollback. After the final
        // expiry check, COMMIT is the atomic decision and is not interrupted.
        transaction
            .progress_handler(0, None::<fn() -> bool>)
            .map_err(database_error)?;
        let result = match result {
            Ok(values) => transaction.commit().map(|_| values).map_err(database_error),
            Err(error) => {
                transaction.finish().map_err(database_error)?;
                Err(error)
            }
        };
        self.limit_database_work()?;
        let (revision, generation) = result?;
        Ok(
            serde_json::json!({"operationId":plan.plan_id,"operation":plan.operation,"documentIdentity":record.id,"revision":revision,"databaseGeneration":generation,"recoveryId":if restore {&plan.candidate_id} else {&plan.plan_id},"recoverable":true,"permanentDeletion":false}),
        )
    }

    fn list_recovery(
        &self,
        offset: usize,
        limit: usize,
    ) -> Result<serde_json::Value, InspectionError> {
        if !matches!(self.version()?, 2 | 3)
            || !(1..=MAX_PAGE).contains(&limit)
            || offset > MAX_RECORDS as usize
        {
            return Err(management_error("invalid_arguments"));
        }
        self.store.verify().map_err(backend_error)?;
        let mut statement=self.store.connection.prepare("SELECT operation_id,document_id,root,revision,bytes,status,restored_revision FROM recovery_records ORDER BY operation_id LIMIT ?1 OFFSET ?2").map_err(database_error)?;
        let rows=statement.query_map(params![limit as i64,offset as i64],|r|Ok(serde_json::json!({"recoveryId":r.get::<_,String>(0)?,"documentIdentity":r.get::<_,String>(1)?,"rootIdentity":r.get::<_,String>(2)?,"sourceRevision":r.get::<_,i64>(3)?,"logicalBytes":r.get::<_,i64>(4)?,"status":r.get::<_,String>(5)?,"restoredRevision":r.get::<_,Option<i64>>(6)?}))).map_err(database_error)?.collect::<Result<Vec<_>,_>>().map_err(database_error)?;
        let (count, bytes): (i64, i64) = self
            .store
            .connection
            .query_row(
                "SELECT count(*),coalesce(sum(bytes),0) FROM recovery_records",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(database_error)?;
        Ok(
            serde_json::json!({"entries":rows,"offset":offset,"limit":limit,"hasMore":offset.saturating_add(limit)<count as usize,"totalRecords":count,"logicalBytes":bytes,"autoPurge":false}),
        )
    }

    fn execute(&mut self, command: Command) -> Result<Option<serde_json::Value>, InspectionError> {
        self.limit_database_work()?;
        self.store.verify().map_err(backend_error)?;
        match command {
            Command::Inspect { offset, limit } => self.inspect(offset, limit).map(Some),
            Command::ListRecovery { offset, limit } => self.list_recovery(offset, limit).map(Some),
            Command::PrepareUpgrade => self.prepare("upgrade", "", None).map(Some),
            Command::PrepareQuarantine {
                document_identity,
                snapshot_id,
            } => self
                .prepare("quarantine", &document_identity, Some(&snapshot_id))
                .map(Some),
            Command::PrepareRestore {
                recovery_id,
                snapshot_id,
            } => self
                .prepare("restore", &recovery_id, Some(&snapshot_id))
                .map(Some),
            Command::Confirm {
                plan_id,
                confirmation,
            } => self.confirm(&plan_id, &confirmation).map(Some),
            Command::OperationStatus { operation_id } => {
                if !super::digest_id(&operation_id) || !matches!(self.version()?, 2 | 3) {
                    return Err(management_error("invalid_arguments"));
                }
                let row=self.store.connection.query_row("SELECT operation_id,document_id,revision,status,restore_operation_id,restored_revision FROM recovery_records WHERE operation_id=?1 OR restore_operation_id=?1",[&operation_id],|r|Ok(serde_json::json!({"recoveryId":r.get::<_,String>(0)?,"documentIdentity":r.get::<_,String>(1)?,"sourceRevision":r.get::<_,i64>(2)?,"status":r.get::<_,String>(3)?,"restoreOperationId":r.get::<_,Option<String>>(4)?,"restoredRevision":r.get::<_,Option<i64>>(5)?}))).optional().map_err(database_error)?.ok_or_else(||management_error("operation_not_found"))?;
                Ok(Some(row))
            }
            Command::Quit => Ok(None),
        }
    }
}

pub(crate) fn read_record(
    connection: &rusqlite::Connection,
    id: &str,
    recovery: bool,
) -> Result<Record, InspectionError> {
    if !super::digest_id(id) {
        return Err(management_error("invalid_arguments"));
    }
    let query = if recovery {
        "SELECT document_id,root,path,data,bytes,revision,generation,payload_hash FROM recovery_records WHERE operation_id=?1 AND status='quarantined'"
    } else {
        "SELECT id,root,path,data,bytes,revision,generation,'' FROM documents WHERE id=?1"
    };
    let record = connection
        .query_row(query, [id], |r| {
            Ok(Record {
                id: r.get(0)?,
                root: r.get(1)?,
                path: r.get(2)?,
                data: crate::document_state::raw_json::copy_sql(r, 3)?,
                bytes: r.get(4)?,
                revision: r.get(5)?,
                generation: r.get(6)?,
                hash: r.get(7)?,
            })
        })
        .optional()
        .map_err(database_error)?
        .ok_or_else(|| management_error("candidate_unavailable"))?;
    if !super::digest_id(&record.id)
        || !super::digest_id(&record.root)
        || record.revision <= 0
        || record.generation <= 0
        || knowledge::validate_relative(&record.path).is_err()
    {
        return Err(backend_error(MigrationError::Corrupt));
    }
    recovery_store::validated_app_count(&record.data, record.bytes).map_err(backend_error)?;
    if recovery && recovery_store::payload_hash(&record.data) != record.hash {
        return Err(backend_error(MigrationError::Corrupt));
    }
    Ok(record)
}

// Shared by stopped-profile and live callers; each caller owns its transaction
// and rechecks root, lifecycle, selection, cancellation and expiry before commit.
pub(crate) fn apply_record(
    connection: &rusqlite::Connection,
    record: &Record,
    path: &str,
    operation_id: &str,
    recovery_id: &str,
    app_count: usize,
    restore: bool,
) -> Result<(i64, i64), InspectionError> {
    let (bytes, count, generation): (i64, i64, i64) = connection
        .query_row(
            "SELECT bytes,documents,generation FROM quota WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(database_error)?;
    let generation = generation
        .checked_add(1)
        .ok_or_else(|| backend_error(MigrationError::Corrupt))?;
    let revision;
    if restore {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1)",
                [&record.id],
                |r| r.get(0),
            )
            .map_err(database_error)?;
        super::assessment::check_restore_budget_with_limits(
            bytes,
            count,
            record.bytes,
            app_count,
            exists,
            crate::storage_limits::read(connection).map_err(backend_error)?,
        )
        .map_err(|_| management_error("restore_conflict_or_quota"))?;
        revision = record
            .revision
            .checked_add(1)
            .ok_or_else(|| backend_error(MigrationError::Corrupt))?;
        connection
            .execute(
                "INSERT INTO documents VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![
                    record.id,
                    record.data,
                    record.bytes,
                    revision,
                    record.root,
                    path,
                    generation
                ],
            )
            .map_err(database_error)?;
        connection.execute("UPDATE recovery_records SET status='restored',restore_operation_id=?2,restored_revision=?3 WHERE operation_id=?1 AND status='quarantined'",params![recovery_id,operation_id,revision]).map_err(database_error)?;
        connection
            .execute(
                "UPDATE state_tombstones SET revision=?2 WHERE document_id=?1 AND operation_id=?3",
                params![record.id, revision, recovery_id],
            )
            .map_err(database_error)?;
        connection
            .execute(
                "UPDATE quota SET bytes=?1,documents=?2,generation=?3 WHERE singleton=1",
                params![bytes + record.bytes, count + 1, generation],
            )
            .map_err(database_error)?;
    } else {
        let (archive_bytes, archive_count): (i64, i64) = connection
            .query_row(
                "SELECT coalesce(sum(bytes),0),count(*) FROM recovery_records",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(database_error)?;
        if archive_bytes
            .checked_add(record.bytes)
            .is_none_or(|total| total > recovery_store::MAX_ARCHIVE_BYTES)
            || archive_count >= MAX_RECORDS
        {
            return Err(management_error("recovery_capacity_reached"));
        }
        revision = record.revision;
        let created: i64 = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| management_error("clock_unavailable"))?
            .as_millis()
            .try_into()
            .map_err(|_| management_error("clock_unavailable"))?;
        connection.execute("INSERT INTO recovery_records VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,'quarantined',NULL,NULL)",params![operation_id,record.id,record.data,record.bytes,revision,record.root,path,record.generation,recovery_store::payload_hash(&record.data),created]).map_err(database_error)?;
        if connection
            .execute(
                "DELETE FROM documents WHERE id=?1 AND revision=?2",
                params![record.id, revision],
            )
            .map_err(database_error)?
            != 1
        {
            return Err(management_error("state_changed"));
        }
        connection.execute("INSERT INTO state_tombstones VALUES(?1,?2,?3) ON CONFLICT(document_id) DO UPDATE SET revision=excluded.revision,operation_id=excluded.operation_id",params![record.id,revision,operation_id]).map_err(database_error)?;
        if bytes < record.bytes || count < 1 {
            return Err(backend_error(MigrationError::Corrupt));
        }
        connection
            .execute(
                "UPDATE quota SET bytes=?1,documents=?2,generation=?3 WHERE singleton=1",
                params![bytes - record.bytes, count - 1, generation],
            )
            .map_err(database_error)?;
    }
    Ok((revision, generation))
}

/// Finite newline JSON protocol, scoped to one explicit local host session.
/// The embedding caller owns trust/consent; document tokens cannot invoke it.
pub fn run<R: BufRead, W: Write, E: Write>(
    profile: &Path,
    root: Option<&Path>,
    input: &mut R,
    output: &mut W,
    errors: &mut E,
) -> i32 {
    let mut session = match Session::open(profile, root) {
        Ok(session) => session,
        Err(error) => {
            let _ = serde_json::to_writer(&mut *errors, &error);
            let _ = errors.write_all(b"\n");
            return 2;
        }
    };
    for _ in 0..MAX_SESSION_COMMANDS {
        // read_until is bounded with Take, including an unterminated giant line.
        let mut line = Vec::new();
        let read = std::io::Read::take(&mut *input, (MAX_COMMAND_BYTES + 1) as u64)
            .read_until(b'\n', &mut line);
        if read.is_err() || line.len() > MAX_COMMAND_BYTES {
            let _ = serde_json::to_writer(&mut *errors, &management_error("command_limit"));
            let _ = errors.write_all(b"\n");
            return 2;
        }
        if line.is_empty() {
            return 0;
        }
        let result = serde_json::from_slice::<Command>(&line)
            .map_err(|_| management_error("invalid_arguments"))
            .and_then(|command| session.execute(command));
        let value = match result {
            Ok(Some(value)) => serde_json::json!({"ok":true,"result":value}),
            Ok(None) => return 0,
            Err(error) => serde_json::json!({"ok":false,"error":error}),
        };
        let bytes = match serde_json::to_vec(&value) {
            Ok(bytes) if bytes.len() <= super::MAX_REPORT_BYTES => bytes,
            _ => return 2,
        };
        if output
            .write_all(&bytes)
            .and_then(|_| output.write_all(b"\n"))
            .and_then(|_| output.flush())
            .is_err()
        {
            return 2;
        }
    }
    let _ = serde_json::to_writer(&mut *errors, &management_error("session_limit"));
    let _ = errors.write_all(b"\n");
    2
}

#[cfg(test)]
#[path = "management/tests.rs"]
mod tests;
