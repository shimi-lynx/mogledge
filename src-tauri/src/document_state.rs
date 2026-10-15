//! Durable JSON state, separate from the rebuildable search index and originals.
use crate::{
    core::{Core, Session},
    knowledge,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

pub const MAX_DOCUMENT_BYTES: usize = crate::storage_limits::DEFAULT_DOCUMENT_BYTES;
#[cfg(test)]
#[path = "document_state/identity_transition.rs"]
mod identity_transition;
#[path = "document_state/raw_json.rs"]
pub(crate) mod raw_json;
const MAX_APPS: usize = 128;
const MAX_DOCUMENTS: i64 = 4096;
// Admission is finite. One processing permit covers collection through response
// consumption; queued admitted requests leave their bodies unpolled.
pub(crate) const MAX_ACTIVE_REQUESTS: usize = 4;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Read,
    Write,
    Delete,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct StateRequest {
    pub version: u8,
    pub op: Operation,
    pub key: String,
    pub value: Option<Value>,
}
#[derive(Debug, Serialize)]
pub struct StateResponse {
    pub version: u8,
    pub value: Value,
    pub revision: i64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawStateRequest<'a> {
    pub version: u8,
    pub op: Operation,
    #[serde(deserialize_with = "deserialize_raw_key")]
    pub key: String,
    #[serde(borrow)]
    pub value: Option<&'a serde_json::value::RawValue>,
}
fn deserialize_raw_key<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let raw: &serde_json::value::RawValue = Deserialize::deserialize(deserializer)?;
    // Every valid 80-byte app key fits even the longest JSON Unicode escaping.
    if raw.get().len() > 80 * 6 + 2 {
        return Err(serde::de::Error::custom("invalid app key"));
    }
    let key: String = serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?;
    if !raw_json::valid_key(&key) {
        return Err(serde::de::Error::custom("invalid app key"));
    }
    Ok(key)
}
#[derive(Serialize)]
pub struct RawStateResponse {
    pub version: u8,
    pub value: Box<serde_json::value::RawValue>,
    pub revision: i64,
    #[serde(skip)]
    serialized: Vec<u8>,
}
fn raw_error(error: raw_json::Error) -> StateError {
    match error {
        raw_json::Error::Invalid | raw_json::Error::InvalidKey => StateError::InvalidRequest,
        raw_json::Error::Capacity => StateError::CapacityExceeded,
        raw_json::Error::Resource => StateError::ResourceUnavailable,
    }
}
fn owned_raw(raw: &str, maximum: usize) -> Result<Box<serde_json::value::RawValue>, StateError> {
    let canonical = raw_json::canonical(raw, maximum).map_err(raw_error)?;
    serde_json::value::RawValue::from_string(canonical).map_err(|_| StateError::InvalidRequest)
}
fn prepared_response(
    value: Box<serde_json::value::RawValue>,
    revision: i64,
    maximum: usize,
) -> Result<RawStateResponse, StateError> {
    let mut response = RawStateResponse {
        version: 1,
        value,
        revision,
        serialized: Vec::new(),
    };
    response.serialized = raw_json::serialize(&response, maximum).map_err(raw_error)?;
    Ok(response)
}
#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryCandidate {
    pub current_identity: String,
    pub source_identity: String,
    pub source_revision: i64,
    pub app_count: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StateError {
    InvalidRequest,
    Unavailable,
    Revoked,
    IdentityChanged,
    IdentityConfirmationRequired,
    QuotaExceeded,
    Corrupt,
    Conflict,
    CapacityExceeded,
    ResourceUnavailable,
}
impl StateError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "InvalidRequest",
            Self::Unavailable => "StorageUnavailable",
            Self::Revoked => "Revoked",
            Self::IdentityChanged => "IdentityChanged",
            Self::IdentityConfirmationRequired => "StorageIdentityConfirmationRequired",
            Self::QuotaExceeded => "QuotaExceeded",
            Self::Corrupt => "StorageCorrupt",
            Self::Conflict => "StorageBusy",
            Self::CapacityExceeded => "CapacityExceeded",
            Self::ResourceUnavailable => "ResourceUnavailable",
        }
    }
}

pub struct DocumentState {
    directory: PathBuf,
    profile: PathBuf,
    connection: Mutex<Connection>,
    // Only source-metadata admission can authorize this independent namespace.
    uuid_admissions: Mutex<std::collections::HashSet<String>>,
    // SQLite must close before raw same-inode descriptors: a POSIX close could
    // otherwise release locks retained by the live connection.
    management_database: fs::File,
    management_directory: std::sync::Arc<cap_std::fs::Dir>,
    management_profile: std::sync::Arc<cap_std::fs::Dir>,
    management_database_id: String,
    pub(crate) request_slots: std::sync::Arc<tokio::sync::Semaphore>,
    pub(crate) processing_slot: std::sync::Arc<tokio::sync::Semaphore>,
}

fn verify_directory(path: &Path) -> Result<(), StateError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(StateError::Unavailable);
    }
    #[cfg(windows)]
    knowledge::validate_cache_path(path).map_err(|_| StateError::Unavailable)?;
    for ancestor in path.ancestors().filter(|ancestor| ancestor.has_root()) {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err(StateError::Unavailable);
                    }
                }
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(StateError::Unavailable);
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(StateError::Unavailable),
        }
    }
    Ok(())
}
fn database_error(error: rusqlite::Error) -> StateError {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            StateError::Conflict
        }
        Some(rusqlite::ErrorCode::TooBig | rusqlite::ErrorCode::DiskFull) => {
            StateError::CapacityExceeded
        }
        Some(rusqlite::ErrorCode::OutOfMemory) => StateError::ResourceUnavailable,
        _ => StateError::Unavailable,
    }
}

fn recovery_error(error: crate::identifier_migration::MigrationError) -> StateError {
    use crate::identifier_migration::MigrationError;
    match error {
        MigrationError::Busy => StateError::Conflict,
        MigrationError::CapacityExceeded => StateError::CapacityExceeded,
        MigrationError::ResourceUnavailable => StateError::ResourceUnavailable,
        MigrationError::Corrupt | MigrationError::UnsupportedDatabase => StateError::Corrupt,
        _ => StateError::Unavailable,
    }
}

impl DocumentState {
    pub(crate) fn authorize_uuid(&self, key: &str) {
        self.uuid_admissions.lock().unwrap().insert(key.into());
    }
    pub(crate) fn uuid_admitted(&self, key: &str) -> bool {
        self.uuid_admissions
            .lock()
            .is_ok_and(|ids| ids.contains(key))
    }
    pub(crate) fn initialize_identity(
        &self,
        key: &str,
        root: &str,
        path: &str,
    ) -> Result<(), String> {
        self.verify_management().map_err(|_| "StorageUnavailable")?;
        let mut connection = self.connection.lock().map_err(|_| "StorageUnavailable")?;
        crate::storage_limits::cap_database(&connection).map_err(|_| "StorageUnavailable")?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "StorageBusy")?;
        let (total, count, generation): (i64, i64, i64) = tx
            .query_row(
                "SELECT bytes,documents,generation FROM quota WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| "StorageCorrupt")?;
        if count >= MAX_DOCUMENTS
            || total.checked_add(2).ok_or("StorageCorrupt")?
                > crate::storage_limits::read(&tx)
                    .map_err(|_| "StorageCorrupt")?
                    .total_bytes
        {
            return Err("QuotaExceeded".into());
        }
        let generation = generation.checked_add(1).ok_or("StorageCorrupt")?;
        tx.execute(
            "INSERT INTO documents VALUES(?1,'{}',2,1,?2,?3,?4)",
            params![key, root, path, generation],
        )
        .map_err(|_| "保存先を初期化できません。既存記録を保持します")?;
        tx.execute(
            "UPDATE quota SET bytes=?1,documents=?2,generation=?3 WHERE singleton=1",
            params![total + 2, count + 1, generation],
        )
        .map_err(|_| "StorageUnavailable")?;
        tx.commit().map_err(|_| "StorageUnavailable".into())
    }
    pub(crate) fn has_identity(&self, key: &str) -> Result<bool, String> {
        self.verify_management().map_err(|_| "StorageUnavailable")?;
        self.connection
            .lock()
            .map_err(|_| "StorageUnavailable")?
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1)",
                [key],
                |row| row.get(0),
            )
            .map_err(|_| "StorageUnavailable".into())
    }
    pub(crate) fn identity_rows(&self) -> Result<Vec<crate::document_identity::LegacyRow>, String> {
        self.verify_management().map_err(|_| "StorageUnavailable")?;
        let connection = self.connection.lock().map_err(|_| "StorageUnavailable")?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|_| "StorageUnavailable")?;
        let sql = if version >= 2 {
            "SELECT id,root,path,revision,data FROM (SELECT id,root,path,revision,data,generation FROM documents WHERE data<>'{}' UNION ALL SELECT document_id,root,path,revision,data,generation FROM recovery_records WHERE status='quarantined' AND data<>'{}') ORDER BY generation DESC LIMIT 8193"
        } else {
            "SELECT id,root,path,revision,data FROM documents WHERE data<>'{}' ORDER BY generation DESC LIMIT 4097"
        };
        let mut query = connection.prepare(sql).map_err(|_| "StorageUnavailable")?;
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    raw_json::copy_sql(row, 4)?,
                ))
            })
            .map_err(|_| "StorageUnavailable")?;
        let mut result = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for row in rows {
            let (id, root, path, revision, data) = row.map_err(|_| "StorageCorrupt")?;
            if !seen.insert(id.clone()) {
                continue;
            }
            let values = raw_json::app_map(&data).map_err(|_| "StorageCorrupt")?;
            result.push(crate::document_identity::LegacyRow {
                id,
                root,
                path,
                revision,
                app_count: values.len(),
            });
        }
        if result.len() > 8192 {
            return Err("StorageCorrupt".into());
        }
        Ok(result)
    }
    /// Copy a confirmed source in one quota-accounted transaction. Even an empty
    /// target is an existing decision and is never overwritten by migration.
    pub(crate) fn copy_identity(
        &self,
        source: &str,
        revision: i64,
        target: &str,
        root: &str,
        path: &str,
    ) -> Result<(), String> {
        self.verify_management().map_err(|_| "StorageUnavailable")?;
        let mut connection = self.connection.lock().map_err(|_| "StorageUnavailable")?;
        crate::storage_limits::cap_database(&connection).map_err(|_| "StorageUnavailable")?;
        let tx = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|_| "StorageBusy")?;
        if crate::state_inspection::recovery_store::is_quarantined(&tx, source)
            .map_err(|_| "StorageCorrupt")?
            || crate::state_inspection::recovery_store::is_quarantined(&tx, target)
                .map_err(|_| "StorageCorrupt")?
        {
            return Err("Revoked".into());
        }
        if tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1)",
                [target],
                |r| r.get::<_, bool>(0),
            )
            .map_err(|_| "StorageUnavailable")?
        {
            return Err("保存先には既存の記録があります。上書きしません".into());
        }
        let (data, bytes, actual_revision): (String, i64, i64) = tx
            .query_row(
                "SELECT data,bytes,revision FROM documents WHERE id=?1",
                [source],
                |r| Ok((raw_json::copy_sql(r, 0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| "復旧元が見つかりません")?;
        if revision != actual_revision
            || bytes != data.len() as i64
            || data.len() > crate::storage_limits::maximum_document_bytes()
        {
            return Err("復旧元が変更されたか破損しています".into());
        }
        raw_json::app_map(&data).map_err(|_| "StorageCorrupt")?;
        let limits = crate::storage_limits::read(&tx).map_err(|_| "StorageCorrupt")?;
        let (total, count, generation): (i64, i64, i64) = tx
            .query_row(
                "SELECT bytes,documents,generation FROM quota WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| "StorageCorrupt")?;
        let total = total.checked_add(bytes).ok_or("StorageCorrupt")?;
        let generation = generation.checked_add(1).ok_or("StorageCorrupt")?;
        if total > limits.total_bytes
            || count >= MAX_DOCUMENTS
            || bytes > limits.document_bytes as i64
        {
            return Err("QuotaExceeded".into());
        }
        tx.execute(
            "INSERT INTO documents VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![target, data, bytes, revision, root, path, generation],
        )
        .map_err(|_| "StorageUnavailable")?;
        tx.execute(
            "UPDATE quota SET bytes=?1,documents=?2,generation=?3 WHERE singleton=1",
            params![total, count + 1, generation],
        )
        .map_err(|_| "StorageUnavailable")?;
        self.verify_management().map_err(|_| "StorageUnavailable")?;
        tx.commit().map_err(|_| "StorageUnavailable".into())
    }
    pub(crate) fn register_storage_root(&self, root: &str) -> Result<bool, String> {
        self.verify_management().map_err(|_| "StorageUnavailable")?;
        let mut connection = self.connection.lock().map_err(|_| "StorageUnavailable")?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| database_error(error).code())?;
        let confirmed = crate::storage_identity_transition::register_empty_root(&transaction, root)
            .map_err(|error| recovery_error(error).code())?;
        self.verify_management().map_err(|_| "StorageUnavailable")?;
        transaction
            .commit()
            .map_err(|error| database_error(error).code())?;
        Ok(confirmed)
    }

    pub(crate) fn admit_document_storage(
        &self,
        root: &str,
        document: &str,
        relative: &str,
    ) -> Result<bool, String> {
        self.verify_management().map_err(|_| "StorageUnavailable")?;
        let mut connection = self.connection.lock().map_err(|_| "StorageUnavailable")?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|error| database_error(error).code())?;
        let confirmed = crate::storage_identity_transition::admit_fresh_document(
            &transaction,
            root,
            document,
            relative,
        )
        .map_err(|error| recovery_error(error).code())?;
        self.verify_management().map_err(|_| "StorageUnavailable")?;
        transaction
            .commit()
            .map_err(|error| database_error(error).code())?;
        Ok(confirmed)
    }
    pub(crate) fn identity_schema_version(&self) -> Result<i64, String> {
        let connection = self.connection.lock().map_err(|_| "StorageUnavailable")?;
        crate::storage_identity_transition::version(&connection)
            .map_err(|_| "StorageUnavailable".into())
    }
    pub(crate) fn profile_directory(&self) -> &std::path::Path {
        &self.profile
    }

    pub(crate) fn verify_management(&self) -> Result<(), crate::state_inspection::InspectionError> {
        use crate::state_inspection::backend_error;
        knowledge::RootReferenceGuard::open(&self.directory, &self.management_directory).map_err(
            |_| backend_error(crate::identifier_migration::MigrationError::SourceChanged),
        )?;
        knowledge::RootReferenceGuard::open(&self.profile, &self.management_profile).map_err(
            |_| backend_error(crate::identifier_migration::MigrationError::SourceChanged),
        )?;
        crate::identifier_migration::verify_source_identity(
            &self.management_directory,
            &self.management_database,
        )
        .map_err(backend_error)
    }
    pub(crate) fn management_connection<T>(
        &self,
        operation: impl FnOnce(
            &mut Connection,
            &Path,
            &str,
            u64,
        ) -> Result<T, crate::state_inspection::InspectionError>,
    ) -> Result<T, crate::state_inspection::InspectionError> {
        use crate::state_inspection::backend_error;
        self.verify_management()?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| backend_error(crate::identifier_migration::MigrationError::Unavailable))?;
        crate::storage_limits::cap_database(&connection).map_err(backend_error)?;
        let bytes = self
            .management_database
            .metadata()
            .map_err(|_| backend_error(crate::identifier_migration::MigrationError::Unavailable))?
            .len();
        if bytes
            > crate::identifier_migration::database_size_limit(&connection)
                .map_err(backend_error)?
        {
            return Err(backend_error(
                crate::identifier_migration::MigrationError::Corrupt,
            ));
        }
        let result = operation(
            &mut connection,
            &self.profile,
            &self.management_database_id,
            bytes,
        );
        self.verify_management()?;
        result
    }
    pub(crate) fn transfer_connection<T>(
        &self,
        operation: impl FnOnce(&Connection, &Path) -> Result<T, crate::state_transfer::TransferError>,
    ) -> Result<T, crate::state_transfer::TransferError> {
        verify_directory(&self.directory)
            .map_err(|_| crate::state_transfer::failure("state_unavailable"))?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| crate::state_transfer::failure("state_unavailable"))?;
        crate::storage_limits::cap_database(&connection).map_err(|error| {
            crate::state_transfer::failure(crate::state_inspection::backend_error(error).code)
        })?;
        operation(&connection, &self.profile)
    }
    pub(crate) fn remap_locations(
        &self,
        dir: &cap_std::fs::Dir,
        from: &str,
        to: &str,
    ) -> Result<(), StateError> {
        verify_directory(&self.directory)?;
        let root = knowledge::storage_root_identity(dir).map_err(|_| StateError::Unavailable)?;
        let connection = self
            .connection
            .lock()
            .map_err(|_| StateError::Unavailable)?;
        // A rolled-back limits change does not roll back max_page_count.
        // Reapply the surviving format's guard before this writer grows pages.
        crate::storage_limits::cap_database(&connection).map_err(recovery_error)?;
        connection.execute("UPDATE documents SET path=CASE WHEN path=?2 THEN ?3 ELSE ?3||substr(path,length(?2)+1) END WHERE root=?1 AND (path=?2 OR substr(path,1,length(?2)+1)=?2||'/')", params![root, from, to])
            .map_err(database_error)?;
        Ok(())
    }

    pub fn new(directory: PathBuf) -> Result<Self, StateError> {
        let profile = directory
            .parent()
            .ok_or(StateError::Unavailable)?
            .to_owned();
        Self::new_in_profile(directory, profile)
    }

    // Startup supplies the actual local profile, including migrated bundle
    // layouts. The DB's immediate parent is not necessarily the profile root.
    pub(crate) fn new_in_profile(directory: PathBuf, profile: PathBuf) -> Result<Self, StateError> {
        let settings_path = profile.join("settings.json");
        Self::new_in_profile_with_settings(directory, profile, settings_path)
    }

    // Config and local data may live in different directories. Missing state
    // must be checked against the settings startup actually restores.
    pub fn new_in_profile_with_settings(
        directory: PathBuf,
        profile: PathBuf,
        settings_path: PathBuf,
    ) -> Result<Self, StateError> {
        verify_directory(&directory)?;
        verify_directory(&profile)?;
        if !directory.starts_with(&profile) || directory == profile {
            return Err(StateError::Unavailable);
        }
        fs::create_dir_all(&directory).map_err(|_| StateError::Unavailable)?;
        verify_directory(&directory)?;
        let directory = directory
            .canonicalize()
            .map_err(|_| StateError::Unavailable)?;
        let profile = profile
            .canonicalize()
            .map_err(|_| StateError::Unavailable)?;
        let database = directory.join("state.sqlite");
        let (_, management_directory) =
            knowledge::open_root(&directory).map_err(|_| StateError::Unavailable)?;
        let (_, management_profile) =
            knowledge::open_root(&profile).map_err(|_| StateError::Unavailable)?;
        let management_database = match crate::write_fs::open_at(
            &management_directory,
            "state.sqlite",
            false,
            false,
            false,
        ) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // A previously registered profile with a missing DB is loss or
                // uncertainty, not first launch. Never create an empty stand-in
                // that could later authorize default-value restoration.
                let mut settings_paths = vec![settings_path, profile.join("settings.json")];
                settings_paths.dedup();
                for settings_path in settings_paths {
                    let settings = crate::root_recovery::read_settings_value(&settings_path)
                        .map_err(|_| StateError::Unavailable)?;
                    if settings.is_some_and(|value| {
                        value.get("knowledgeRoot").is_some()
                            || value.get("knowledgeRootIdentity").is_some()
                            || value.get("knowledgeRootIdentityScheme").is_some()
                    }) {
                        return Err(StateError::Unavailable);
                    }
                }
                crate::write_fs::create_database_guard(&management_directory)
                    .map_err(|_| StateError::Unavailable)?
            }
            Err(_) => return Err(StateError::Unavailable),
        };
        crate::identifier_migration::verify_source_identity(
            &management_directory,
            &management_database,
        )
        .map_err(recovery_error)?;
        let management_database_id =
            crate::identifier_migration::state_database_id(&management_database)
                .map_err(recovery_error)?;
        #[cfg(windows)]
        knowledge::validate_cache_path(&database).map_err(|_| StateError::Unavailable)?;
        if let Ok(metadata) = fs::symlink_metadata(&database) {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(StateError::Unavailable);
            }
        }
        let mut connection = Connection::open_with_flags(
            database,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(database_error)?;
        connection
            .busy_timeout(Duration::from_millis(250))
            .map_err(database_error)?;
        // SQLite's intrinsic per-connection row limit remains active; user
        // quotas are evaluated separately in the write transaction.
        connection
            .execute_batch(
                "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;",
            )
            .map_err(database_error)?;
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(database_error)?;
        if version > 3 {
            return Err(StateError::Corrupt);
        }
        if version >= 2 {
            crate::identifier_migration::validate_db(&connection).map_err(recovery_error)?;
        }
        if version == 0 {
            let transaction = connection.transaction().map_err(database_error)?;
            transaction.execute_batch("CREATE TABLE documents (id TEXT PRIMARY KEY, data TEXT NOT NULL, bytes INTEGER NOT NULL, revision INTEGER NOT NULL, root TEXT NOT NULL, path TEXT NOT NULL, generation INTEGER NOT NULL);
                CREATE INDEX document_location ON documents(root,path,generation);
                CREATE TABLE quota (singleton INTEGER PRIMARY KEY CHECK(singleton=1), bytes INTEGER NOT NULL, documents INTEGER NOT NULL, generation INTEGER NOT NULL);
                INSERT INTO quota VALUES (1,0,0,0); PRAGMA user_version=1;")
                .map_err(database_error)?;
            transaction.commit().map_err(database_error)?;
        }
        crate::storage_limits::read(&connection).map_err(recovery_error)?;
        crate::storage_limits::cap_database(&connection).map_err(recovery_error)?;
        crate::identifier_migration::verify_source_identity(
            &management_directory,
            &management_database,
        )
        .map_err(recovery_error)?;
        knowledge::RootReferenceGuard::open(&directory, &management_directory)
            .map_err(|_| StateError::Unavailable)?;
        knowledge::RootReferenceGuard::open(&profile, &management_profile)
            .map_err(|_| StateError::Unavailable)?;
        Ok(Self {
            directory,
            profile,
            connection: Mutex::new(connection),
            uuid_admissions: Mutex::new(std::collections::HashSet::new()),
            management_database,
            management_directory,
            management_profile,
            management_database_id,
            request_slots: std::sync::Arc::new(tokio::sync::Semaphore::new(MAX_ACTIVE_REQUESTS)),
            processing_slot: std::sync::Arc::new(tokio::sync::Semaphore::new(1)),
        })
    }

    // Compatibility for small fixture/source callers. HTTP uses borrowed raw.
    fn apply(
        &self,
        root: &Path,
        root_identity: &str,
        relative: &str,
        identity: &str,
        request: StateRequest,
    ) -> Result<StateResponse, StateError> {
        let bytes = raw_json::serialize(&request, crate::storage_limits::maximum_request_bytes())
            .map_err(raw_error)?;
        let raw: RawStateRequest<'_> =
            serde_json::from_slice(&bytes).map_err(|_| StateError::InvalidRequest)?;
        let response = self.apply_raw(root, root_identity, relative, identity, raw)?;
        Ok(StateResponse {
            version: response.version,
            value: serde_json::from_str(response.value.get()).map_err(|_| StateError::Corrupt)?,
            revision: response.revision,
        })
    }
    fn apply_raw(
        &self,
        root: &Path,
        root_identity: &str,
        relative: &str,
        identity: &str,
        request: RawStateRequest<'_>,
    ) -> Result<RawStateResponse, StateError> {
        self.apply_raw_with_response_limit(
            root,
            root_identity,
            relative,
            identity,
            request,
            crate::storage_limits::maximum_request_bytes(),
        )
    }
    fn apply_raw_with_response_limit(
        &self,
        root: &Path,
        root_identity: &str,
        relative: &str,
        identity: &str,
        request: RawStateRequest<'_>,
        response_maximum: usize,
    ) -> Result<RawStateResponse, StateError> {
        if self.directory.starts_with(root) {
            return Err(StateError::Unavailable);
        }
        verify_directory(&self.directory)?;
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| StateError::Unavailable)?;
        crate::storage_limits::cap_database(&connection).map_err(recovery_error)?;
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(database_error)?;
        if !self
            .uuid_admissions
            .lock()
            .map_err(|_| StateError::Unavailable)?
            .contains(identity)
            && !crate::storage_identity_transition::document_confirmed(
                &transaction,
                root_identity,
                identity,
            )
            .map_err(recovery_error)?
        {
            return Err(StateError::IdentityConfirmationRequired);
        }
        let limits = crate::storage_limits::read(&transaction).map_err(recovery_error)?;
        let maximum = crate::storage_limits::capabilities(&transaction)
            .map_err(recovery_error)?
            .maximum_document_bytes;
        if crate::state_inspection::recovery_store::is_quarantined(&transaction, identity)
            .map_err(recovery_error)?
        {
            return Err(StateError::Revoked);
        }
        // SQLite still materializes its TEXT row. The Rust copy is fallible and
        // its nested JSON is never expanded into a payload Value tree.
        let previous = transaction
            .query_row(
                "SELECT data,bytes,revision FROM documents WHERE id=?1",
                [identity],
                |row| {
                    let data = row.get_ref(0)?.as_str()?;
                    Ok((
                        raw_json::copy(data),
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(database_error)?;
        let had_previous = previous.is_some();
        let (previous_data, previous_bytes, mut revision) = match previous {
            Some((data, bytes, revision)) => {
                let data = data.map_err(raw_error)?;
                if data.len() > maximum || i64::try_from(data.len()).ok() != Some(bytes) {
                    return Err(StateError::Corrupt);
                }
                (data, bytes, revision)
            }
            None => ("{}".to_owned(), 0, 0),
        };
        let mut values = raw_json::app_map(&previous_data).map_err(|e| {
            if e == raw_json::Error::Invalid {
                StateError::Corrupt
            } else {
                raw_error(e)
            }
        })?;
        let index = values.iter().position(|(key, _)| key == &request.key);
        if matches!(request.op, Operation::Read) {
            let value = owned_raw(index.map_or("null", |i| values[i].1.get()), maximum)?;
            let response = prepared_response(value, revision, response_maximum)?;
            if had_previous {
                transaction.execute("UPDATE documents SET root=?2,path=?3 WHERE id=?1 AND (root<>?2 OR path<>?3)",params![identity,root_identity,relative]).map_err(database_error)?;
                transaction.commit().map_err(database_error)?;
            }
            return Ok(response);
        }
        match request.op {
            Operation::Write => {
                let raw = request.value.ok_or(StateError::InvalidRequest)?;
                if let Some(i) = index {
                    values[i].1 = raw;
                } else {
                    if values.len() >= MAX_APPS {
                        return Err(StateError::QuotaExceeded);
                    }
                    values
                        .try_reserve(1)
                        .map_err(|_| StateError::ResourceUnavailable)?;
                    values.push((request.key.clone(), raw));
                    values.sort_unstable_by(|a, b| a.0.cmp(&b.0));
                }
            }
            Operation::Delete => {
                if let Some(i) = index {
                    values.remove(i);
                } else {
                    return prepared_response(
                        owned_raw("null", maximum)?,
                        revision,
                        response_maximum,
                    );
                }
            }
            Operation::Read => unreachable!(),
        }
        let output_max = maximum.min(limits.document_bytes);
        let data = raw_json::merge(&values, output_max).map_err(|e| {
            if e == raw_json::Error::Capacity && limits.document_bytes < maximum {
                StateError::QuotaExceeded
            } else {
                raw_error(e)
            }
        })?;
        let (total, documents, generation): (i64, i64, i64) = transaction
            .query_row(
                "SELECT bytes,documents,generation FROM quota WHERE singleton=1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(database_error)?;
        let bytes = i64::try_from(data.len()).map_err(|_| StateError::CapacityExceeded)?;
        let total = total
            .checked_sub(previous_bytes)
            .and_then(|v| v.checked_add(bytes))
            .ok_or(StateError::Corrupt)?;
        let documents = documents
            .checked_add(i64::from(!had_previous))
            .ok_or(StateError::Corrupt)?;
        if documents > MAX_DOCUMENTS || total > limits.total_bytes {
            return Err(StateError::QuotaExceeded);
        }
        revision = revision.checked_add(1).ok_or(StateError::Corrupt)?;
        let generation = generation.checked_add(1).ok_or(StateError::Corrupt)?;
        let value = owned_raw(
            values
                .iter()
                .find(|(key, _)| key == &request.key)
                .map_or("null", |v| v.1.get()),
            maximum,
        )?;
        let response = prepared_response(value, revision, response_maximum)?;
        transaction.execute("INSERT INTO documents(id,data,bytes,revision,root,path,generation) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET data=excluded.data,bytes=excluded.bytes,revision=excluded.revision,root=excluded.root,path=excluded.path,generation=excluded.generation",params![identity,data,bytes,revision,root_identity,relative,generation]).map_err(database_error)?;
        transaction
            .execute(
                "UPDATE quota SET bytes=?1,documents=?2,generation=?3 WHERE singleton=1",
                params![total, documents, generation],
            )
            .map_err(database_error)?;
        transaction.commit().map_err(database_error)?;
        Ok(response)
    }
}

fn validate_request(request: &StateRequest) -> Result<(), StateError> {
    if request.version != 1
        || request.key.is_empty()
        || request.key.len() > 80
        || !request
            .key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        || (!matches!(request.op, Operation::Write) && request.value.is_some())
    {
        return Err(StateError::InvalidRequest);
    }
    Ok(())
}

// Recovery is a bundled-UI command, deliberately absent from the document HTTP API.
// A path is only a lookup hint; both physical identities and the source revision
// are checked again after the user's confirmation.
pub fn recovery(
    core: &Core,
    workspace: &str,
    view: &str,
    relative: &str,
    confirmed: Option<&RecoveryCandidate>,
) -> Result<Option<RecoveryCandidate>, String> {
    let _gate = core.gate.lock().map_err(|_| "StorageUnavailable")?;
    let (root, dir) = {
        let state = core.workspace.lock().map_err(|_| "StorageUnavailable")?;
        if state.snapshot.workspace_id.as_deref() != Some(workspace) {
            return Err("WorkspaceChanged".into());
        }
        if state.snapshot.view_id != view {
            return Err("ViewChanged".into());
        }
        if let Some(hold) = &state.snapshot.storage_hold {
            return Err(hold.reason.clone());
        }
        if !knowledge::contains(&state.snapshot.nodes, relative) {
            return Err("HTMLが見つかりません".into());
        }
        (
            state.root.clone().ok_or("WorkspaceChanged")?,
            state.dir.clone().ok_or("WorkspaceChanged")?,
        )
    };
    let identity =
        knowledge::storage_identity(&root, &dir, relative).map_err(|_| "RecoveryChanged")?;
    let root_identity = knowledge::storage_root_identity(&dir).map_err(|_| "StorageUnavailable")?;
    let store = core.document_state.get().ok_or("StorageUnavailable")?;
    if store.directory.starts_with(&root) {
        return Err("StorageUnavailable".into());
    }
    verify_directory(&store.directory).map_err(|error| error.code())?;
    let mut connection = store.connection.lock().map_err(|_| "StorageUnavailable")?;
    crate::storage_limits::cap_database(&connection)
        .map_err(|error| recovery_error(error).code())?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| database_error(error).code())?;
    if crate::state_inspection::recovery_store::is_quarantined(&transaction, &identity)
        .map_err(|error| recovery_error(error).code())?
    {
        return Err("Revoked".into());
    }
    if !crate::storage_identity_transition::document_confirmed(
        &transaction,
        &root_identity,
        &identity,
    )
    .map_err(|error| recovery_error(error).code())?
    {
        return Err("StorageIdentityConfirmationRequired".into());
    }
    let source: Option<(String, String, i64, i64)> = transaction.query_row(
        "SELECT id,data,bytes,revision FROM documents WHERE root=?1 AND path=?2 AND id<>?3 AND data<>'{}' ORDER BY generation DESC LIMIT 1",
        params![root_identity, relative, identity], |row| Ok((row.get(0)?, raw_json::copy_sql(row,1)?, row.get(2)?, row.get(3)?)))
        .optional().map_err(|error| database_error(error).code())?;
    let Some((source_identity, data, bytes, source_revision)) = source else {
        return if confirmed.is_some() {
            Err("RecoveryChanged".into())
        } else {
            Ok(None)
        };
    };
    let values = raw_json::app_map(&data).map_err(|e| raw_error(e).code())?;
    if data.len() > crate::storage_limits::maximum_document_bytes()
        || data.len() as i64 != bytes
        || source_revision < 1
        || values.len() > MAX_APPS
    {
        return Err("StorageCorrupt".into());
    }
    let candidate = RecoveryCandidate {
        current_identity: identity.clone(),
        source_identity,
        source_revision,
        app_count: values.len(),
    };
    let Some(confirmed) = confirmed else {
        return Ok(Some(candidate));
    };
    if confirmed != &candidate {
        return Err("RecoveryChanged".into());
    }
    let existing: Option<(String, i64, i64)> = transaction
        .query_row(
            "SELECT data,bytes,revision FROM documents WHERE id=?1",
            [&identity],
            |row| Ok((raw_json::copy_sql(row, 0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| database_error(error).code())?;
    if existing.as_ref().is_some_and(|(data, _, _)| data != "{}") {
        return Err("StateConflict".into());
    }
    let (total, documents, generation): (i64, i64, i64) = transaction
        .query_row(
            "SELECT bytes,documents,generation FROM quota WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|error| database_error(error).code())?;
    let total = total - existing.as_ref().map_or(0, |row| row.1) + bytes;
    let documents = documents + i64::from(existing.is_none());
    let limits =
        crate::storage_limits::read(&transaction).map_err(|error| recovery_error(error).code())?;
    if bytes > limits.document_bytes as i64
        || total > limits.total_bytes
        || documents > MAX_DOCUMENTS
    {
        return Err("QuotaExceeded".into());
    }
    let revision = existing
        .as_ref()
        .map_or(0, |row| row.2)
        .checked_add(1)
        .ok_or("StorageCorrupt")?;
    let generation = generation.checked_add(1).ok_or("StorageCorrupt")?;
    transaction.execute("INSERT INTO documents(id,data,bytes,revision,root,path,generation) VALUES (?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET data=excluded.data,bytes=excluded.bytes,revision=excluded.revision,root=excluded.root,path=excluded.path,generation=excluded.generation",
        params![identity, data, bytes, revision, root_identity, relative, generation]).map_err(|error| database_error(error).code())?;
    transaction
        .execute(
            "UPDATE quota SET bytes=?1,documents=?2,generation=?3 WHERE singleton=1",
            params![total, documents, generation],
        )
        .map_err(|error| database_error(error).code())?;
    transaction
        .commit()
        .map_err(|error| database_error(error).code())?;
    Ok(Some(candidate))
}
pub fn authorized_session(core: &Core, token: &str) -> Result<Session, StateError> {
    let session = core.session_for_token(token).ok_or(StateError::Revoked)?;
    if let Some(hold) = &session.storage_hold {
        return Err(match hold.reason.as_str() {
            "StorageUnavailable" => StateError::Unavailable,
            "StorageCorrupt" => StateError::Corrupt,
            "StorageBusy" => StateError::Conflict,
            "CapacityExceeded" => StateError::CapacityExceeded,
            "ResourceUnavailable" => StateError::ResourceUnavailable,
            _ => StateError::IdentityConfirmationRequired,
        });
    }
    let identity = session
        .storage_identity
        .as_ref()
        .ok_or(StateError::Unavailable)?;
    let current = knowledge::storage_identity(&session.root, &session.dir, &session.entry)
        .map_err(|_| StateError::IdentityChanged)?;
    if identity != &current {
        return Err(StateError::IdentityChanged);
    }
    if let Some(key) = &session.logical_storage_identity {
        // In-place metadata edits do not necessarily change the filesystem ID.
        // Reparse bounded source so an old token cannot change namespaces.
        let read = knowledge::read_source_budgeted(
            &session.root,
            &session.dir,
            &session.entry,
            true,
            |_| Ok(()),
        )
        .map_err(|_| StateError::IdentityChanged)?;
        if read.storage_identity.as_ref() != Some(identity) {
            return Err(StateError::IdentityChanged);
        }
        match std::str::from_utf8(&read.data)
            .ok()
            .map(crate::document_identity::parse)
        {
            Some(crate::document_identity::Metadata::Uuid(uuid))
                if crate::document_identity::storage_key(&uuid) == *key => {}
            _ => return Err(StateError::IdentityChanged),
        }
    }
    Ok(session)
}
pub fn operate(
    core: &Core,
    token: &str,
    request: StateRequest,
) -> Result<StateResponse, StateError> {
    validate_request(&request)?;
    // Close/reload/root/view/move revocation and commit share this gate. Body
    // parsing happened outside it; bounded source metadata is revalidated here.
    let _gate = core.gate.lock().map_err(|_| StateError::Unavailable)?;
    let session = authorized_session(core, token)?;
    let store = core.document_state.get().ok_or(StateError::Unavailable)?;
    store.apply(
        &session.root,
        &knowledge::storage_root_identity(&session.dir).map_err(|_| StateError::Unavailable)?,
        &session.entry,
        session
            .logical_storage_identity
            .as_ref()
            .or(session.storage_identity.as_ref())
            .unwrap(),
        request,
    )
}

pub fn operate_raw(
    core: &Core,
    token: &str,
    request: RawStateRequest<'_>,
) -> Result<RawStateResponse, StateError> {
    if request.version != 1
        || !raw_json::valid_key(&request.key)
        || (!matches!(request.op, Operation::Write) && request.value.is_some())
    {
        return Err(StateError::InvalidRequest);
    }
    let _gate = core.gate.lock().map_err(|_| StateError::Unavailable)?;
    let session = authorized_session(core, token)?;
    let store = core.document_state.get().ok_or(StateError::Unavailable)?;
    store.apply_raw(
        &session.root,
        &knowledge::storage_root_identity(&session.dir).map_err(|_| StateError::Unavailable)?,
        &session.entry,
        session
            .logical_storage_identity
            .as_ref()
            .or(session.storage_identity.as_ref())
            .unwrap(),
        request,
    )
}
/// HTTP consumes bytes allocated before COMMIT, never a fallible post-commit serializer.
pub fn operate_raw_bytes(
    core: &Core,
    token: &str,
    request: RawStateRequest<'_>,
) -> Result<Vec<u8>, StateError> {
    operate_raw(core, token, request).map(|response| response.serialized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reboot_volatile_v1_lookup_is_empty_but_does_not_delete_saved_rows() {
        use crate::knowledge::persistent_identity::{legacy_document, MountedObject};
        let state = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
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
        let after_root = MountedObject {
            device: 42,
            ..before_root
        };
        let after_file = MountedObject {
            device: 42,
            ..before_file
        };
        let old_id = legacy_document(before_root, before_file);
        let new_id = legacy_document(after_root, after_file);
        let saved = json!({"schemaVersion":1,"data":{"input":"preserve me"}});
        let write =
            serde_json::from_value(json!({"version":1,"op":"write","key":"app","value":saved}))
                .unwrap();
        {
            let store = DocumentState::new(state.path().to_owned()).unwrap();
            store
                .apply(root.path(), "old-root", "app.html", &old_id, write)
                .unwrap();
        }
        let database = state.path().join("state.sqlite");
        let before_bytes = fs::read(&database).unwrap();
        {
            let store = DocumentState::new(state.path().to_owned()).unwrap();
            let read =
                serde_json::from_value(json!({"version":1,"op":"read","key":"app"})).unwrap();
            let missing = store
                .apply(root.path(), "new-root", "app.html", &new_id, read)
                .unwrap();
            assert_eq!(missing.value, Value::Null);
            assert_eq!(missing.revision, 0);
            let read =
                serde_json::from_value(json!({"version":1,"op":"read","key":"app"})).unwrap();
            let retained = store
                .apply(root.path(), "old-root", "app.html", &old_id, read)
                .unwrap();
            assert_eq!(retained.value, saved);
            assert_eq!(retained.revision, 1);
            let connection = store.connection.lock().unwrap();
            let (count, generation): (i64, i64) = connection
                .query_row(
                    "SELECT documents,generation FROM quota WHERE singleton=1",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert_eq!((count, generation), (1, 1));
        }
        assert_eq!(fs::read(database).unwrap(), before_bytes);
    }

    #[test]
    fn candidate_uuid_identity_preserves_saved_input_after_reopen_and_separates_replacements() {
        use crate::knowledge::persistent_identity::{document, root as root_id, MountedObject};
        let state = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
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
        let id = document(before_root, before_file).unwrap();
        let saved = json!({"schemaVersion":1,"data":{"input":"after reboot"}});
        {
            let store = DocumentState::new(state.path().to_owned()).unwrap();
            let write =
                serde_json::from_value(json!({"version":1,"op":"write","key":"app","value":saved}))
                    .unwrap();
            store
                .apply(
                    root.path(),
                    &root_id(before_root).unwrap(),
                    "before.html",
                    &id,
                    write,
                )
                .unwrap();
        }
        let store = DocumentState::new(state.path().to_owned()).unwrap();
        let after_root = MountedObject {
            device: 42,
            ..before_root
        };
        let after_file = MountedObject {
            device: 42,
            ..before_file
        };
        let read = || serde_json::from_value(json!({"version":1,"op":"read","key":"app"})).unwrap();
        let after = store
            .apply(
                root.path(),
                &root_id(after_root).unwrap(),
                "renamed/moved.html",
                &document(after_root, after_file).unwrap(),
                read(),
            )
            .unwrap();
        assert_eq!(after.value, saved);
        assert_eq!(after.revision, 1);
        for changed in [
            MountedObject {
                volume_uuid: [2; 16],
                ..after_file
            },
            MountedObject {
                created_ns: 1001,
                ..after_file
            },
        ] {
            let unrelated = store
                .apply(
                    root.path(),
                    &root_id(after_root).unwrap(),
                    "renamed/moved.html",
                    &document(after_root, changed).unwrap(),
                    read(),
                )
                .unwrap();
            assert_eq!(unrelated.value, Value::Null);
        }
        let connection = store.connection.lock().unwrap();
        let (path, revision): (String, i64) = connection
            .query_row(
                "SELECT path,revision FROM documents WHERE id=?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(path, "renamed/moved.html");
        assert_eq!(revision, 1);
        assert_eq!(
            connection
                .query_row(
                    "SELECT documents,generation FROM quota WHERE singleton=1",
                    [],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                )
                .unwrap(),
            (1, 1)
        );
    }

    #[test]
    fn quarantined_identity_revokes_normal_reads_writes_and_deletes_after_restart() {
        use crate::state_inspection::recovery_store;
        let state = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let id = format!("{:064x}", 2);
        let root_id = format!("{:064x}", 3);
        let operation = format!("{:064x}", 1);
        {
            let store = DocumentState::new(state.path().to_owned()).unwrap();
            let mut connection = store.connection.lock().unwrap();
            recovery_store::upgrade(&mut connection, || Ok(())).unwrap();
            connection
                .execute("UPDATE quota SET generation=2", [])
                .unwrap();
            connection.execute("INSERT INTO recovery_records VALUES (?1,?2,'{}',2,2,?3,'page.html',1,?4,0,'quarantined',NULL,NULL)", params![operation,id,root_id,recovery_store::payload_hash("{}")]).unwrap();
            connection
                .execute(
                    "INSERT INTO state_tombstones VALUES (?1,2,?2)",
                    params![id, operation],
                )
                .unwrap();
        }
        let store = DocumentState::new(state.path().to_owned()).unwrap();
        for (op, value) in [("read", None), ("write", Some(json!(7))), ("delete", None)] {
            let request =
                serde_json::from_value(json!({"version":1,"op":op,"key":"app","value":value}))
                    .unwrap();
            assert!(matches!(
                store.apply(root.path(), &root_id, "page.html", &id, request),
                Err(StateError::Revoked)
            ));
        }
        let connection = store.connection.lock().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM documents", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row("SELECT generation FROM quota", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn sqlite_full_preserves_value_revision_and_quota_after_failed_large_write() {
        let state = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let store = DocumentState::new(state.path().to_owned()).unwrap();
        let apply = |op: &str, value: Option<Value>| {
            store.apply(
                root.path(),
                "root",
                "app.html",
                "document",
                serde_json::from_value(json!({"version":1,"op":op,"key":"sample","value":value}))
                    .unwrap(),
            )
        };
        apply("write", Some(json!({"data":"saved"}))).unwrap();
        let before = apply("read", None).unwrap();
        let quota = || {
            store
                .connection
                .lock()
                .unwrap()
                .query_row("SELECT bytes,documents,generation FROM quota", [], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .unwrap()
        };
        let before_quota = quota();
        {
            let connection = store.connection.lock().unwrap();
            let pages: i64 = connection
                .query_row("PRAGMA page_count", [], |row| row.get(0))
                .unwrap();
            connection
                .pragma_update(None, "max_page_count", pages)
                .unwrap();
        }
        // Real SQLITE_FULL through a connection page budget, without filling
        // the host disk or mutating any user profile.
        assert_eq!(
            apply("write", Some(json!({"data":"あ".repeat(350000)}))).unwrap_err(),
            StateError::CapacityExceeded
        );
        let after = apply("read", None).unwrap();
        assert_eq!(after.value, before.value);
        assert_eq!(after.revision, before.revision);
        assert_eq!(quota(), before_quota);
        drop(store);
        let reopened = DocumentState::new(state.path().to_owned()).unwrap();
        let request =
            serde_json::from_value(json!({"version":1,"op":"read","key":"sample"})).unwrap();
        let after_restart = reopened
            .apply(root.path(), "root", "app.html", "document", request)
            .unwrap();
        assert_eq!(after_restart.value, before.value);
        assert_eq!(after_restart.revision, before.revision);
    }
}

#[cfg(test)]
#[test]
fn failed_precommit_response_preparation_preserves_value_revision_and_quota() {
    let state = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let store = DocumentState::new(state.path().to_owned()).unwrap();
    let saved = store
        .apply(
            root.path(),
            "root",
            "page.html",
            "id",
            StateRequest {
                version: 1,
                op: Operation::Write,
                key: "app".into(),
                value: Some(serde_json::json!({"data":"saved"})),
            },
        )
        .unwrap();
    let quota = || {
        store
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT bytes,documents,generation FROM quota", [], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
    };
    let before = quota();
    let request =
        serde_json::from_str(r#"{"version":1,"op":"write","key":"app","value":{"data":"new"}}"#)
            .unwrap();
    assert!(matches!(
        store.apply_raw_with_response_limit(root.path(), "root", "page.html", "id", request, 16),
        Err(StateError::CapacityExceeded)
    ));
    let after = store
        .apply(
            root.path(),
            "root",
            "page.html",
            "id",
            StateRequest {
                version: 1,
                op: Operation::Read,
                key: "app".into(),
                value: None,
            },
        )
        .unwrap();
    assert_eq!((after.value, after.revision), (saved.value, saved.revision));
    assert_eq!(quota(), before);
}

#[cfg(test)]
#[test]
fn intrinsic_sqlite_row_capacity_failure_is_typed_and_rolls_back() {
    let state = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let store = DocumentState::new(state.path().to_owned()).unwrap();
    let id = "a".repeat(64);
    let root_id = "b".repeat(64);
    let saved = store
        .apply(
            root.path(),
            &root_id,
            "page.html",
            &id,
            StateRequest {
                version: 1,
                op: Operation::Write,
                key: "app".into(),
                value: Some(serde_json::json!("saved")),
            },
        )
        .unwrap();
    let quota = || {
        store
            .connection
            .lock()
            .unwrap()
            .query_row("SELECT bytes,documents,generation FROM quota", [], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
    };
    let before = quota();
    let connection = store.connection.lock().unwrap();
    unsafe {
        rusqlite::ffi::sqlite3_limit(connection.handle(), rusqlite::ffi::SQLITE_LIMIT_LENGTH, 128);
    }
    drop(connection);
    let body = format!(
        r#"{{"version":1,"op":"write","key":"app","value":"{}"}}"#,
        "x".repeat(70)
    );
    let request = serde_json::from_str(&body).unwrap();
    assert!(matches!(
        store.apply_raw(root.path(), &root_id, "page.html", &id, request),
        Err(StateError::CapacityExceeded)
    ));
    let after = store
        .apply(
            root.path(),
            &root_id,
            "page.html",
            &id,
            StateRequest {
                version: 1,
                op: Operation::Read,
                key: "app".into(),
                value: None,
            },
        )
        .unwrap();
    assert_eq!((after.value, after.revision), (saved.value, saved.revision));
    assert_eq!(quota(), before);
}
