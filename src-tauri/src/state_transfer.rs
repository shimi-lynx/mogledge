//! Local, explicitly confirmed transfer of one committed document state.
//! Document tokens/iframe IPC never route to this stopped-profile entry point.
#[path = "state_transfer/files.rs"]
pub(crate) mod files;
#[path = "state_transfer/format.rs"]
pub(crate) mod format;
#[path = "state_transfer/live.rs"]
pub mod live;

use crate::{
    identifier_migration,
    state_inspection::{self, collector::Availability, management, recovery_store},
};
use cap_std::fs::Dir;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    io::{BufRead, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const MAX_COMMAND_BYTES: usize = 16 * 1024;
const MAX_COMMANDS: usize = 4096;
const MAX_PLANS: usize = 8;
#[cfg(test)]
const MAX_TOTAL_BYTES: i64 = crate::storage_limits::DEFAULT_TOTAL_BYTES;
const MAX_DOCUMENTS: i64 = 4096;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct TransferError {
    code: &'static str,
    message: &'static str,
}
pub(crate) fn failure(code: &'static str) -> TransferError {
    TransferError{code,message:"Transfer stopped. No state values or private paths are included. Inspect and explicitly select again."}
}
fn sql_error(error: rusqlite::Error) -> TransferError {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            failure("state_busy")
        }
        Some(rusqlite::ErrorCode::OperationInterrupted) => failure("operation_interrupted"),
        Some(rusqlite::ErrorCode::TooBig | rusqlite::ErrorCode::DiskFull) => {
            failure("capacity_exceeded")
        }
        Some(rusqlite::ErrorCode::OutOfMemory) => failure("resource_unavailable"),
        _ => failure("state_operation_failed"),
    }
}
fn format_error(error: format::FormatError) -> TransferError {
    failure(error.code())
}
fn product_version() -> Result<String, TransferError> {
    let product: Value = serde_json::from_str(include_str!("../../package.json"))
        .map_err(|_| failure("invalid_app_version"))?;
    product["version"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| failure("invalid_app_version"))
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
    InspectTarget {
        relative_path: String,
    },
    PrepareExport {
        document_identity: String,
        snapshot_id: String,
        output_path: PathBuf,
    },
    PrepareImport {
        file_path: PathBuf,
        relative_path: String,
        target_identity: String,
        snapshot_id: String,
        backup_path: Option<PathBuf>,
    },
    VerifyImport {
        file_path: PathBuf,
        relative_path: String,
        target_identity: String,
    },
    Confirm {
        plan_id: String,
        confirmation: String,
        replace_confirmation: Option<String>,
    },
    Cancel {
        plan_id: String,
    },
    Quit,
}
fn default_limit() -> usize {
    20
}

struct StateRecord {
    data: String,
    bytes: i64,
    revision: i64,
    generation: i64,
    root: String,
    path: String,
}
struct Pending {
    preview: Value,
    database_id: String,
    snapshot_id: String,
    generation: i64,
    expires: Instant,
    action: Action,
}
enum Action {
    Export {
        document_identity: String,
        output: files::Location,
    },
    Import {
        input: files::Location,
        input_identity: (u64, u128),
        input_hash: String,
        relative_path: String,
        target_identity: String,
        target_revision: i64,
        backup: Option<files::Location>,
    },
}
struct Session {
    offline: management::Session,
    // Closing even a rejected input alias must not cancel SQLite's POSIX locks.
    // Field order closes the offline connection before these bounded raw fds.
    input_files: Vec<std::fs::File>,
    profile: Dir,
    plans: BTreeMap<String, Pending>,
    completed: BTreeMap<String, Value>,
}
impl Session {
    fn open(profile: &Path, root: &Path) -> Result<Self, TransferError> {
        let profile_dir = identifier_migration::directory(profile, false)
            .map_err(|_| failure("unsafe_profile"))?
            .ok_or_else(|| failure("state_unavailable"))?;
        let offline =
            management::Session::open(profile, Some(root)).map_err(|e| failure(e.code))?;
        if offline.root.is_none() {
            return Err(failure("source_unavailable_hold"));
        }
        Ok(Self {
            offline,
            input_files: Vec::new(),
            profile: profile_dir,
            plans: BTreeMap::new(),
            completed: BTreeMap::new(),
        })
    }
    fn snapshot(&self) -> Result<state_inspection::Report, TransferError> {
        self.offline.snapshot(1, 0).map_err(|e| failure(e.code))
    }
    fn verify_snapshot(&self, pending: &Pending) -> Result<(), TransferError> {
        if Instant::now() >= pending.expires {
            return Err(failure("expired_plan"));
        }
        let snapshot = self.snapshot()?;
        if snapshot.database_id != pending.database_id
            || snapshot.snapshot_id != pending.snapshot_id
            || snapshot.database_generation != pending.generation
        {
            return Err(failure("state_changed"));
        }
        if Instant::now() >= pending.expires {
            return Err(failure("expired_plan"));
        }
        Ok(())
    }
    fn record(&self, id: &str) -> Result<Option<StateRecord>, TransferError> {
        if !state_inspection::digest_id(id) {
            return Err(failure("invalid_document_identity"));
        }
        if recovery_store::is_quarantined(&self.offline.store.connection, id)
            .map_err(|_| failure("state_corrupt"))?
        {
            return Err(failure("target_quarantined_hold"));
        }
        self.offline
            .store
            .connection
            .query_row(
                "SELECT data,bytes,revision,generation,root,path FROM documents WHERE id=?1",
                [id],
                |row| {
                    Ok(StateRecord {
                        data: crate::document_state::raw_json::copy_sql(row, 0)?,
                        bytes: row.get(1)?,
                        revision: row.get(2)?,
                        generation: row.get(3)?,
                        root: row.get(4)?,
                        path: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(sql_error)
    }
    fn target(&self, relative: &str, expected: Option<&str>) -> Result<String, TransferError> {
        if !crate::knowledge::is_html(relative) {
            return Err(failure("invalid_html_target"));
        }
        let root = self
            .offline
            .root
            .as_ref()
            .ok_or_else(|| failure("source_unavailable_hold"))?;
        let id = root
            .storage_identity_at(relative)
            .map_err(|_| failure("source_unavailable_hold"))?;
        if root.logical_identity_at(relative).ok().flatten().as_deref() != Some(&id)
            && !crate::storage_identity_transition::document_confirmed(
                &self.offline.store.connection,
                &root.identity,
                &id,
            )
            .map_err(|_| failure("state_corrupt"))?
        {
            return Err(failure("target_identity_confirmation_required"));
        }
        if expected.is_some_and(|expected| expected != id) {
            return Err(failure("target_identity_changed"));
        }
        Ok(id)
    }
    fn source_path(&self, id: &str, record: &StateRecord) -> Result<String, TransferError> {
        let root = self
            .offline
            .root
            .as_ref()
            .ok_or_else(|| failure("source_unavailable_hold"))?;
        let observation = root.scan();
        let (availability, path) = root.locate(&observation, id, &record.path);
        if !matches!(
            availability,
            Availability::SameIdentity | Availability::RelocatedIdentity
        ) {
            return Err(failure("source_unavailable_hold"));
        }
        let path = path.ok_or_else(|| failure("source_unavailable_hold"))?;
        if root.identity != record.root
            && root.logical_identity_at(&path).ok().flatten().as_deref() != Some(id)
        {
            return Err(failure("source_unavailable_hold"));
        }
        Ok(path)
    }
    fn portable(
        &self,
        id: &str,
        record: &StateRecord,
        path: &str,
    ) -> Result<format::ValidatedTransfer, TransferError> {
        if record.bytes != record.data.len() as i64 {
            return Err(failure("state_corrupt"));
        }
        format::from_state(
            &product_version()?,
            format::Source {
                root_identity: record.root.clone(),
                document_identity: id.to_owned(),
                relative_path: path.to_owned(),
                revision: record.revision,
                generation: record.generation,
            },
            &record.data,
        )
        .map_err(format_error)
    }
    fn quota(&self) -> Result<(i64, i64, i64), TransferError> {
        self.offline
            .store
            .connection
            .query_row(
                "SELECT bytes,documents,generation FROM quota WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(sql_error)
    }
    fn budget(
        &self,
        old: Option<&StateRecord>,
        incoming: i64,
    ) -> Result<(i64, i64, i64), TransferError> {
        let (total, count, generation) = self.quota()?;
        let limits = crate::storage_limits::read(&self.offline.store.connection)
            .map_err(|error| failure(crate::state_inspection::backend_error(error).code))?;
        if incoming > limits.document_bytes as i64 {
            return Err(failure("quota_exceeded"));
        }
        let bytes = total
            .checked_sub(old.map_or(0, |r| r.bytes))
            .and_then(|v| v.checked_add(incoming))
            .filter(|v| (0..=limits.total_bytes).contains(v))
            .ok_or_else(|| failure("quota_exceeded"))?;
        let records = count
            .checked_add(i64::from(old.is_none()))
            .filter(|v| *v <= MAX_DOCUMENTS)
            .ok_or_else(|| failure("quota_exceeded"))?;
        let generation = generation
            .checked_add(1)
            .ok_or_else(|| failure("revision_limit"))?;
        Ok((bytes, records, generation))
    }
    fn prepare(&mut self, command: Command) -> Result<Value, TransferError> {
        if self.plans.len() >= MAX_PLANS {
            return Err(failure("plan_limit"));
        }
        let snapshot = self.snapshot()?;
        let id = crate::core::random_token();
        let expires = Instant::now() + Duration::from_secs(300);
        let (expected, action, mut preview) = match command {
            Command::PrepareExport {
                document_identity,
                snapshot_id,
                output_path,
            } => {
                let record = self
                    .record(&document_identity)?
                    .ok_or_else(|| failure("saved_state_unavailable"))?;
                let path = self.source_path(&document_identity, &record)?;
                let transfer = self.portable(&document_identity, &record, &path)?;
                let output = files::Location::open(&output_path, &self.profile)?;
                output.absent()?;
                (
                    snapshot_id,
                    Action::Export {
                        document_identity: document_identity.clone(),
                        output,
                    },
                    json!({"operation":"export","documentIdentity":document_identity,"rootIdentity":record.root,"revision":record.revision,"logicalBytes":transfer.bytes,"appCount":transfer.app_count,"apps":schemas(&transfer.file.apps),"replacesExisting":false,"plaintextFile":true,"committedStateOnly":true,"effect":"Write one new local portable file. Unflushed inputs are not included. Never overwrite an existing file."}),
                )
            }
            Command::PrepareImport {
                file_path,
                relative_path,
                target_identity,
                snapshot_id,
                backup_path,
            } => {
                self.target(&relative_path, Some(&target_identity))?;
                let input = files::Location::open(&file_path, &self.profile)?;
                let (bytes, input_identity) = input.read(&mut self.input_files)?;
                let transfer = format::parse(&bytes).map_err(format_error)?;
                let old = self.record(&target_identity)?;
                let (backup, previous_apps) = if let Some(old) = &old {
                    // A future overwrite must be reversibly representable before
                    // offering its preview. No schema conversion is attempted.
                    let previous = self.portable(&target_identity, old, &relative_path)?;
                    format::check_schema_compatibility(&transfer.file.apps, &old.data)
                        .map_err(format_error)?;
                    let location = files::Location::open(
                        &backup_path.ok_or_else(|| failure("explicit_backup_required"))?,
                        &self.profile,
                    )?;
                    location.absent()?;
                    (Some(location), schemas(&previous.file.apps))
                } else {
                    if backup_path.is_some() {
                        return Err(failure("backup_not_needed"));
                    }
                    (None, json!([]))
                };
                self.budget(old.as_ref(), transfer.bytes)?;
                let revision = old.as_ref().map_or(0, |r| r.revision);
                revision
                    .checked_add(1)
                    .ok_or_else(|| failure("revision_limit"))?;
                let preview = json!({"operation":"import","targetIdentity":target_identity,"rootIdentity":self.offline.root.as_ref().unwrap().identity,"targetRevision":revision,"sourceRootIdentity":transfer.file.source.root_identity,"sourceDocumentIdentity":transfer.file.source.document_identity,"sourceRevision":transfer.file.source.revision,"logicalBytes":transfer.bytes,"appCount":transfer.app_count,"previousLogicalBytes":old.as_ref().map_or(0,|r|r.bytes),"apps":schemas(&transfer.file.apps),"replacesExisting":old.is_some(),"backupRequired":old.is_some(),"plaintextBackup":old.is_some(),"effect":"Replace the selected target's entire app map only after explicit confirmation. Preserve any previous record in a new local portable backup first. Source identity is provenance only."});
                let mut preview = preview;
                preview["previousApps"] = previous_apps;
                (
                    snapshot_id,
                    Action::Import {
                        input,
                        input_identity,
                        input_hash: recovery_store::payload_hash(
                            std::str::from_utf8(&bytes).map_err(|_| failure("invalid_format"))?,
                        ),
                        relative_path,
                        target_identity,
                        target_revision: revision,
                        backup,
                    },
                    preview,
                )
            }
            _ => return Err(failure("invalid_command")),
        };
        if expected != snapshot.snapshot_id {
            return Err(failure("state_changed"));
        }
        preview["planId"] = json!(id);
        preview["expiresElapsedMs"] =
            json!(expires.duration_since(self.offline.started).as_millis() as u64);
        preview["databaseGeneration"] = json!(snapshot.database_generation);
        self.plans.insert(
            id,
            Pending {
                preview: preview.clone(),
                database_id: snapshot.database_id,
                snapshot_id: snapshot.snapshot_id,
                generation: snapshot.database_generation,
                expires,
                action,
            },
        );
        Ok(preview)
    }
    fn confirm(
        &mut self,
        id: &str,
        confirmation: &str,
        replace: Option<&str>,
    ) -> Result<Value, TransferError> {
        if id != confirmation {
            return Err(failure("explicit_confirmation_required"));
        }
        if let Some(receipt) = self.completed.get(id) {
            return Ok(receipt.clone());
        }
        let pending = self
            .plans
            .get(id)
            .ok_or_else(|| failure("unknown_or_consumed_plan"))?;
        if pending.preview["replacesExisting"] == true && replace != Some(id) {
            return Err(failure("explicit_replace_confirmation_required"));
        }
        let pending = self.plans.remove(id).unwrap();
        self.verify_snapshot(&pending)?;
        let deadline = pending.expires.min(Instant::now() + Duration::from_secs(2));
        self.offline
            .store
            .connection
            .progress_handler(1000, Some(move || Instant::now() >= deadline))
            .map_err(sql_error)?;
        let receipt = match &pending.action {
            Action::Export {
                document_identity,
                output,
            } => {
                let record = self
                    .record(document_identity)?
                    .ok_or_else(|| failure("state_changed"))?;
                let path = self.source_path(document_identity, &record)?;
                let portable = self.portable(document_identity, &record, &path)?;
                let bytes = format::encode(&portable.file).map_err(format_error)?;
                output.write_new(&bytes, || {
                    self.verify_snapshot(&pending)?;
                    self.target(&path, Some(document_identity))?;
                    Ok(())
                })?;
                json!({"operationId":id,"operation":"export","documentIdentity":document_identity,"revision":record.revision,"logicalBytes":portable.bytes,"fileFlushed":true,"directoryFlushVerified":cfg!(unix),"plaintextFile":true})
            }
            Action::Import {
                input,
                input_identity,
                input_hash,
                relative_path,
                target_identity,
                target_revision,
                backup,
            } => {
                let (bytes, identity) = input.read(&mut self.input_files)?;
                if identity != *input_identity
                    || recovery_store::payload_hash(
                        std::str::from_utf8(&bytes).map_err(|_| failure("invalid_format"))?,
                    ) != *input_hash
                {
                    return Err(failure("transfer_file_changed"));
                }
                let incoming = format::parse(&bytes).map_err(format_error)?;
                self.target(relative_path, Some(target_identity))?;
                let old = self.record(target_identity)?;
                if old.as_ref().map_or(0, |r| r.revision) != *target_revision {
                    return Err(failure("state_changed"));
                }
                self.budget(old.as_ref(), incoming.bytes)?;
                if let Some(old) = &old {
                    format::check_schema_compatibility(&incoming.file.apps, &old.data)
                        .map_err(format_error)?;
                    let preserved = self.portable(target_identity, old, relative_path)?;
                    let bytes = format::encode(&preserved.file).map_err(format_error)?;
                    backup
                        .as_ref()
                        .ok_or_else(|| failure("explicit_backup_required"))?
                        .write_new(&bytes, || {
                            self.verify_snapshot(&pending)?;
                            self.target(relative_path, Some(target_identity))?;
                            Ok(())
                        })?;
                }
                self.verify_snapshot(&pending)?;
                self.target(relative_path, Some(target_identity))?;
                self.offline
                    .store
                    .connection
                    .execute_batch("PRAGMA query_only=OFF;")
                    .map_err(sql_error)?;
                let result = self.apply_import(
                    &pending,
                    target_identity,
                    relative_path,
                    old.as_ref(),
                    &incoming,
                );
                let reset = self
                    .offline
                    .store
                    .connection
                    .execute_batch("PRAGMA query_only=ON;")
                    .map_err(sql_error);
                reset?;
                let (revision, generation) = result?;
                json!({"operationId":id,"operation":"import","documentIdentity":target_identity,"revision":revision,"databaseGeneration":generation,"logicalBytes":incoming.bytes,"previousStateBackedUp":old.is_some(),"backupFileFlushed":old.is_some(),"backupDirectoryFlushVerified":old.is_some()&&cfg!(unix),"permanentDeletion":false})
            }
        };
        self.offline
            .store
            .verify()
            .map_err(|_| failure("state_changed"))?;
        self.completed.insert(id.to_owned(), receipt.clone());
        Ok(receipt)
    }
    fn apply_import(
        &mut self,
        pending: &Pending,
        id: &str,
        path: &str,
        old: Option<&StateRecord>,
        incoming: &format::ValidatedTransfer,
    ) -> Result<(i64, i64), TransferError> {
        let (bytes, count, generation) = self.budget(old, incoming.bytes)?;
        let revision = old
            .map_or(0, |r| r.revision)
            .checked_add(1)
            .ok_or_else(|| failure("revision_limit"))?;
        if Instant::now() >= pending.expires {
            return Err(failure("expired_plan"));
        }
        let root = self
            .offline
            .root
            .as_ref()
            .ok_or_else(|| failure("source_unavailable_hold"))?;
        crate::storage_limits::cap_database(&self.offline.store.connection)
            .map_err(|error| failure(crate::state_inspection::backend_error(error).code))?;
        let transaction =
            recovery_store::begin_atomic(&self.offline.store.connection).map_err(sql_error)?;
        let result = (|| {
            if recovery_store::is_quarantined(&transaction, id)
                .map_err(|_| failure("state_corrupt"))?
            {
                return Err(failure("target_quarantined_hold"));
            }
            let current: Option<i64> = transaction
                .query_row("SELECT revision FROM documents WHERE id=?1", [id], |r| {
                    r.get(0)
                })
                .optional()
                .map_err(sql_error)?;
            if current != old.map(|r| r.revision) {
                return Err(failure("state_changed"));
            }
            if root.logical_identity_at(path).ok().flatten().as_deref() != Some(id)
                && !crate::storage_identity_transition::document_confirmed(
                    &transaction,
                    &root.identity,
                    id,
                )
                .map_err(|_| failure("state_corrupt"))?
            {
                return Err(failure("target_identity_confirmation_required"));
            }
            transaction.execute("INSERT INTO documents VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET data=excluded.data,bytes=excluded.bytes,revision=excluded.revision,root=excluded.root,path=excluded.path,generation=excluded.generation",params![id,incoming.canonical_state,incoming.bytes,revision,root.identity,path,generation]).map_err(sql_error)?;
            transaction
                .execute(
                    "UPDATE quota SET bytes=?1,documents=?2,generation=?3 WHERE singleton=1",
                    params![bytes, count, generation],
                )
                .map_err(sql_error)?;
            if root.identity_at(path).ok().as_deref() != Some(id) {
                return Err(failure("target_identity_changed"));
            }
            let version: i64 = transaction
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .map_err(sql_error)?;
            if version >= 2 {
                recovery_store::validate_metadata(&transaction)
                    .map_err(|_| failure("state_corrupt"))?;
            }
            if Instant::now() >= pending.expires {
                return Err(failure("expired_plan"));
            }
            Ok(())
        })();
        // Cancellation must never cancel its own rollback. Once the final
        // deadline check passes, COMMIT is the uncancellable atomic decision;
        // OS I/O has no strict elapsed-time guarantee.
        transaction
            .progress_handler(0, None::<fn() -> bool>)
            .map_err(sql_error)?;
        if let Err(error) = result {
            // SQLite may already have rolled back an interrupted statement.
            // finish() checks autocommit and preserves that original diagnosis.
            transaction.finish().map_err(sql_error)?;
            return Err(error);
        }
        transaction.commit().map_err(sql_error)?;
        Ok((revision, generation))
    }
    fn execute(&mut self, command: Command) -> Result<Option<Value>, TransferError> {
        let deadline = Instant::now() + Duration::from_secs(2);
        self.offline
            .store
            .connection
            .progress_handler(1000, Some(move || Instant::now() >= deadline))
            .map_err(sql_error)?;
        self.offline
            .store
            .verify()
            .map_err(|_| failure("state_changed"))?;
        match command {
            Command::Inspect { offset, limit } => self
                .offline
                .inspect(offset, limit)
                .map(Some)
                .map_err(|e| failure(e.code)),
            Command::InspectTarget { relative_path } => {
                let id = self.target(&relative_path, None)?;
                let record = self.record(&id)?;
                let apps = if let Some(record) = &record {
                    schemas(&self.portable(&id, record, &relative_path)?.file.apps)
                } else {
                    json!([])
                };
                Ok(Some(
                    json!({"documentIdentity":id,"rootIdentity":self.offline.root.as_ref().unwrap().identity,"revision":record.as_ref().map_or(0,|r|r.revision),"hasSavedRecord":record.is_some(),"logicalBytes":record.as_ref().map_or(0,|r|r.bytes),"apps":apps}),
                ))
            }
            command @ Command::PrepareExport { .. } | command @ Command::PrepareImport { .. } => {
                self.prepare(command).map(Some)
            }
            Command::Confirm {
                plan_id,
                confirmation,
                replace_confirmation,
            } => self
                .confirm(&plan_id, &confirmation, replace_confirmation.as_deref())
                .map(Some),
            Command::Cancel { plan_id } => {
                if self.plans.remove(&plan_id).is_none() {
                    return Err(failure("unknown_or_consumed_plan"));
                }
                Ok(Some(json!({"cancelled":true})))
            }
            Command::VerifyImport {
                file_path,
                relative_path,
                target_identity,
            } => {
                self.target(&relative_path, Some(&target_identity))?;
                let input = files::Location::open(&file_path, &self.profile)?;
                let (bytes, _) = input.read(&mut self.input_files)?;
                let incoming = format::parse(&bytes).map_err(format_error)?;
                let record = self
                    .record(&target_identity)?
                    .ok_or_else(|| failure("saved_state_unavailable"))?;
                let current = self.portable(&target_identity, &record, &relative_path)?;
                Ok(Some(
                    json!({"matches":incoming.canonical_state==current.canonical_state,"revision":record.revision,"documentIdentity":target_identity}),
                ))
            }
            Command::Quit => Ok(None),
        }
    }
}
fn schemas(apps: &BTreeMap<String, format::AppState>) -> Value {
    json!(apps
        .iter()
        .map(|(id, state)| json!({"appId":id,"schemaVersion":state.schema_version}))
        .collect::<Vec<_>>())
}

/// The trusted local host owns consent and selected paths. NDJSON contains
/// metadata only; sensitive saved values are written solely to selected files.
pub fn run_cli<I: IntoIterator<Item = OsString>, R: BufRead, W: Write, E: Write>(
    arguments: I,
    input: &mut R,
    output: &mut W,
    errors: &mut E,
) -> i32 {
    let parse = || {
        let mut args = arguments.into_iter();
        if args.next().as_deref() != Some(std::ffi::OsStr::new("session")) {
            return Err(failure("invalid_arguments"));
        }
        let mut options = BTreeMap::new();
        while let Some(key) = args.next() {
            let key = key
                .into_string()
                .map_err(|_| failure("invalid_arguments"))?;
            if !["--profile-dir", "--root"].contains(&key.as_str()) {
                return Err(failure("invalid_arguments"));
            }
            let value = args.next().ok_or_else(|| failure("invalid_arguments"))?;
            if options.insert(key, value).is_some() {
                return Err(failure("invalid_arguments"));
            }
        }
        let profile = PathBuf::from(
            options
                .remove("--profile-dir")
                .ok_or_else(|| failure("invalid_arguments"))?,
        );
        let root = PathBuf::from(
            options
                .remove("--root")
                .ok_or_else(|| failure("invalid_arguments"))?,
        );
        Session::open(&profile, &root)
    };
    let mut session = match parse() {
        Ok(session) => session,
        Err(error) => {
            let _ = serde_json::to_writer(&mut *errors, &error);
            let _ = errors.write_all(b"\n");
            return 2;
        }
    };
    for _ in 0..MAX_COMMANDS {
        let mut line = Vec::new();
        let read = std::io::Read::take(&mut *input, (MAX_COMMAND_BYTES + 1) as u64)
            .read_until(b'\n', &mut line);
        if read.is_err() || line.len() > MAX_COMMAND_BYTES {
            let _ = serde_json::to_writer(&mut *errors, &failure("command_limit"));
            let _ = errors.write_all(b"\n");
            return 2;
        }
        if line.is_empty() {
            return 0;
        }
        let response = match serde_json::from_slice::<Command>(&line) {
            Ok(command) => match session.execute(command) {
                Ok(Some(result)) => json!({"ok":true,"result":result}),
                Ok(None) => return 0,
                Err(error) => json!({"ok":false,"error":error}),
            },
            Err(_) => json!({"ok":false,"error":failure("invalid_command")}),
        };
        let mut bytes = match serde_json::to_vec(&response) {
            Ok(bytes) if bytes.len() <= 1024 * 1024 => bytes,
            _ => return 2,
        };
        bytes.push(b'\n');
        if output
            .write_all(&bytes)
            .and_then(|_| output.flush())
            .is_err()
        {
            return 2;
        }
    }
    2
}

#[cfg(test)]
#[path = "state_transfer/tests.rs"]
mod tests;
