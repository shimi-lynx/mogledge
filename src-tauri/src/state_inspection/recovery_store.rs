//! Internal schema and bounded recovery invariants. No authority or executor.
use crate::identifier_migration::MigrationError;
use rusqlite::{Connection, OptionalExtension};
use sha2::{Digest, Sha256};

pub(crate) const RECORDS_DDL: &str = "CREATE TABLE recovery_records(operation_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, data TEXT NOT NULL, bytes INTEGER NOT NULL, revision INTEGER NOT NULL, root TEXT NOT NULL, path TEXT NOT NULL, generation INTEGER NOT NULL, payload_hash TEXT NOT NULL, created_unix_ms INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('quarantined','restored')), restore_operation_id TEXT UNIQUE, restored_revision INTEGER)";
pub(crate) const TOMBSTONES_DDL: &str = "CREATE TABLE state_tombstones(document_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,operation_id TEXT NOT NULL UNIQUE REFERENCES recovery_records(operation_id))";
pub(crate) const MAX_ARCHIVE_BYTES: i64 = 512 * 1024 * 1024;
pub(crate) const MAX_ARCHIVE_RECORDS: i64 = 4096;
pub(crate) const MAX_DATABASE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn sql_error(error: rusqlite::Error) -> MigrationError {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            MigrationError::Busy
        }
        Some(rusqlite::ErrorCode::OperationInterrupted) => MigrationError::Interrupted,
        Some(rusqlite::ErrorCode::TooBig | rusqlite::ErrorCode::DiskFull) => {
            MigrationError::CapacityExceeded
        }
        Some(rusqlite::ErrorCode::OutOfMemory) => MigrationError::ResourceUnavailable,
        _ => MigrationError::Corrupt,
    }
}

pub(crate) fn payload_hash(data: &str) -> String {
    format!("{:x}", Sha256::digest(data.as_bytes()))
}

pub(crate) fn validated_app_count(data: &str, bytes: i64) -> Result<usize, MigrationError> {
    if !(2..=crate::storage_limits::maximum_document_bytes() as i64).contains(&bytes)
        || data.len() as i64 != bytes
    {
        return Err(MigrationError::Corrupt);
    }
    let values = crate::document_state::raw_json::app_map(data).map_err(|e| match e {
        crate::document_state::raw_json::Error::Resource => MigrationError::ResourceUnavailable,
        _ => MigrationError::Corrupt,
    })?;
    // Validate values/duplicates without allocating nested Value trees.
    for (_, raw) in &values {
        crate::document_state::raw_json::canonical(raw.get(), bytes as usize).map_err(
            |e| match e {
                crate::document_state::raw_json::Error::Resource => {
                    MigrationError::ResourceUnavailable
                }
                _ => MigrationError::Corrupt,
            },
        )?;
    }
    Ok(values.len())
}

pub(crate) fn validate_schema(connection: &Connection) -> Result<(), MigrationError> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql_error)?;
    if !matches!(version, 2 | 3) {
        return Err(MigrationError::UnsupportedDatabase);
    }
    crate::identifier_migration::validate_schema(connection)
}

/// Begin an immediate transaction and clean up even a partially executed BEGIN.
/// rusqlite creates its RAII guard only after BEGIN succeeds; an interrupt can
/// otherwise leave a live transaction with no guard to roll it back.
pub(crate) fn begin_atomic(connection: &Connection) -> rusqlite::Result<rusqlite::Transaction<'_>> {
    if !connection.is_autocommit() {
        return Err(rusqlite::Error::InvalidQuery);
    }
    match rusqlite::Transaction::new_unchecked(connection, rusqlite::TransactionBehavior::Immediate)
    {
        Ok(transaction) => Ok(transaction),
        Err(error) => {
            connection.progress_handler(0, None::<fn() -> bool>)?;
            if !connection.is_autocommit() {
                connection.execute_batch("ROLLBACK;")?;
            }
            Err(error)
        }
    }
}

/// Explicit upgrade only: no startup/inspection caller invokes this helper.
pub(crate) fn upgrade(
    connection: &mut Connection,
    before_commit: impl FnOnce() -> Result<(), MigrationError>,
) -> Result<(), MigrationError> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql_error)?;
    if version >= 2 {
        return validate(connection);
    }
    if version != 1 {
        return Err(MigrationError::UnsupportedDatabase);
    }
    crate::identifier_migration::validate_db(connection)?;
    let transaction = begin_atomic(connection).map_err(sql_error)?;
    let result = (|| {
        transaction
            .execute_batch(&format!(
                "{RECORDS_DDL}; {TOMBSTONES_DDL}; PRAGMA user_version=2;"
            ))
            .map_err(sql_error)?;
        validate(&transaction)?;
        before_commit()
    })();
    // The cancellation budget governs validation, never its own rollback or
    // the atomic commit decision. Session callers install the next query budget.
    transaction
        .progress_handler(0, None::<fn() -> bool>)
        .map_err(sql_error)?;
    if let Err(error) = result {
        // finish skips ROLLBACK when SQLite already returned to autocommit.
        transaction.finish().map_err(sql_error)?;
        return Err(error);
    }
    transaction.commit().map_err(sql_error)
}

/// Current runtimes must not recreate a deliberately quarantined identity.
pub(crate) fn is_quarantined(connection: &Connection, id: &str) -> Result<bool, MigrationError> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql_error)?;
    if version == 1 {
        return Ok(false);
    }
    if !matches!(version, 2 | 3) {
        return Err(MigrationError::UnsupportedDatabase);
    }
    // A tombstone with a broken archive reference must never revive its identity.
    let tombstone = connection
        .query_row(
            "SELECT r.status,r.document_id,t.revision,r.revision,r.restored_revision,d.revision FROM state_tombstones t LEFT JOIN recovery_records r ON r.operation_id=t.operation_id LEFT JOIN documents d ON d.id=t.document_id WHERE t.document_id=?1",
            [id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(sql_error)?;
    let Some((status, document, revision, archived_revision, restored_revision, active_revision)) =
        tombstone
    else {
        return Ok(false);
    };
    if document.as_deref() != Some(id) || revision <= 0 {
        return Err(MigrationError::Corrupt);
    }
    match status.as_deref() {
        Some("quarantined") if archived_revision == Some(revision) => Ok(true),
        Some("restored")
            if restored_revision == Some(revision)
                && archived_revision
                    .is_some_and(|archived| archived > 0 && archived < revision)
                && active_revision.is_some_and(|active| active >= revision) =>
        {
            Ok(false)
        }
        _ => Err(MigrationError::Corrupt),
    }
}

/// Validate one bounded payload at a time; never collect recovery bodies.
pub(crate) fn validate(connection: &Connection) -> Result<(), MigrationError> {
    validate_metadata(connection)?;
    let mut statement = connection
        .prepare("SELECT data,bytes,payload_hash FROM recovery_records LIMIT 4097")
        .map_err(sql_error)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let data = row
            .get_ref(0)
            .map_err(sql_error)?
            .as_str()
            .map_err(|_| MigrationError::Corrupt)?;
        let bytes: i64 = row.get(1).map_err(sql_error)?;
        let hash: String = row.get(2).map_err(sql_error)?;
        validated_app_count(data, bytes)?;
        if payload_hash(data) != hash {
            return Err(MigrationError::Corrupt);
        }
    }
    Ok(())
}

/// Inspection checks internal consistency without parsing or returning values.
pub(crate) fn validate_metadata(connection: &Connection) -> Result<(), MigrationError> {
    validate_schema(connection)?;
    let (count, bytes): (i64, i64) = connection
        .query_row(
            "SELECT count(*),coalesce(sum(bytes),0) FROM recovery_records",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(sql_error)?;
    if !(0..=MAX_ARCHIVE_RECORDS).contains(&count) || !(0..=MAX_ARCHIVE_BYTES).contains(&bytes) {
        return Err(MigrationError::Corrupt);
    }
    let generation: i64 = connection
        .query_row(
            "SELECT generation FROM quota WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error)?;
    let invalid: i64 = connection.query_row("SELECT count(*) FROM recovery_records WHERE typeof(operation_id)<>'text' OR length(CAST(operation_id AS BLOB))<>64 OR typeof(document_id)<>'text' OR length(CAST(document_id AS BLOB))<>64 OR typeof(root)<>'text' OR length(CAST(root AS BLOB))<>64 OR typeof(path)<>'text' OR length(CAST(path AS BLOB)) NOT BETWEEN 1 AND 4096 OR typeof(payload_hash)<>'text' OR length(CAST(payload_hash AS BLOB))<>64 OR typeof(data)<>'text' OR typeof(bytes)<>'integer' OR bytes NOT BETWEEN 2 AND ?1 OR length(CAST(data AS BLOB))<>bytes OR typeof(revision)<>'integer' OR revision<=0 OR typeof(generation)<>'integer' OR generation NOT BETWEEN 1 AND ?2 OR typeof(created_unix_ms)<>'integer' OR created_unix_ms<0 OR (restore_operation_id IS NOT NULL AND (typeof(restore_operation_id)<>'text' OR length(CAST(restore_operation_id AS BLOB))<>64)) OR (restored_revision IS NOT NULL AND typeof(restored_revision)<>'integer')", rusqlite::params![crate::storage_limits::maximum_document_bytes() as i64,generation], |row| row.get(0)).map_err(sql_error)?;
    if invalid != 0 {
        return Err(MigrationError::Corrupt);
    }
    let mut statement = connection.prepare("SELECT operation_id,document_id,bytes,revision,root,path,generation,payload_hash,created_unix_ms,status,restore_operation_id,restored_revision FROM recovery_records LIMIT 4097").map_err(sql_error)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let operation: String = row.get(0).map_err(sql_error)?;
        let document: String = row.get(1).map_err(sql_error)?;
        let bytes: i64 = row.get(2).map_err(sql_error)?;
        let revision: i64 = row.get(3).map_err(sql_error)?;
        let root: String = row.get(4).map_err(sql_error)?;
        let path: String = row.get(5).map_err(sql_error)?;
        let record_generation: i64 = row.get(6).map_err(sql_error)?;
        let hash: String = row.get(7).map_err(sql_error)?;
        let created: i64 = row.get(8).map_err(sql_error)?;
        let status: String = row.get(9).map_err(sql_error)?;
        let restore_operation: Option<String> = row.get(10).map_err(sql_error)?;
        let restored_revision: Option<i64> = row.get(11).map_err(sql_error)?;
        if ![
            operation.as_str(),
            document.as_str(),
            root.as_str(),
            hash.as_str(),
        ]
        .into_iter()
        .all(super::digest_id)
            || revision <= 0
            || record_generation <= 0
            || record_generation > generation
            || created < 0
            || path.len() > 4096
            || crate::knowledge::validate_relative(&path).is_err()
        {
            return Err(MigrationError::Corrupt);
        }
        if !(2..=crate::storage_limits::maximum_document_bytes() as i64).contains(&bytes) {
            return Err(MigrationError::Corrupt);
        }
        match status.as_str() {
            "quarantined" if restore_operation.is_none() && restored_revision.is_none() => {
                let matches: i64 = connection.query_row("SELECT count(*) FROM state_tombstones WHERE document_id=?1 AND revision=?2 AND operation_id=?3", rusqlite::params![document,revision,operation], |row| row.get(0)).map_err(sql_error)?;
                let active: i64 = connection
                    .query_row(
                        "SELECT count(*) FROM documents WHERE id=?1",
                        [document],
                        |row| row.get(0),
                    )
                    .map_err(sql_error)?;
                if matches != 1 || active != 0 {
                    return Err(MigrationError::Corrupt);
                }
            }
            "restored"
                if restore_operation.as_deref().is_some_and(super::digest_id)
                    && restored_revision.is_some_and(|restored| restored > revision) => {}
            _ => return Err(MigrationError::Corrupt),
        }
    }
    let invalid: i64 = connection.query_row("SELECT count(*) FROM state_tombstones t LEFT JOIN recovery_records r ON r.operation_id=t.operation_id LEFT JOIN documents d ON d.id=t.document_id WHERE r.operation_id IS NULL OR t.document_id<>r.document_id OR typeof(t.revision)<>'integer' OR t.revision<=0 OR (r.status='quarantined' AND (t.revision<>r.revision OR d.id IS NOT NULL)) OR (r.status='restored' AND (t.revision<>r.restored_revision OR d.id IS NULL OR d.revision<t.revision))", [], |row| row.get(0)).map_err(sql_error)?;
    if invalid != 0 {
        return Err(MigrationError::Corrupt);
    }
    let ambiguous: i64 = connection.query_row("SELECT count(*) FROM recovery_records r JOIN recovery_records other ON r.restore_operation_id=other.operation_id", [], |row| row.get(0)).map_err(sql_error)?;
    if ambiguous != 0 {
        return Err(MigrationError::Corrupt);
    }
    Ok(())
}

#[cfg(test)]
#[path = "recovery_store/tests.rs"]
mod tests;
