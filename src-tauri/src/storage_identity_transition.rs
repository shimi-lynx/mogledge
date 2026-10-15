//! Acknowledged persistent-identity format. Legacy values remain unbound until
//! the owner explicitly assigns a record to a currently opened HTML.
use crate::identifier_migration::MigrationError;
use rusqlite::{Connection, OptionalExtension};

#[path = "storage_identity_transition/budget.rs"]
pub(crate) mod budget;
#[path = "storage_identity_transition/offline.rs"]
pub mod offline;
#[path = "storage_identity_transition/preferences.rs"]
pub(crate) mod preferences;

pub(crate) const SCHEME: &str = "macos-volume-object-v2";
pub(crate) const ROOTS_DDL: &str = "CREATE TABLE identity_roots(root TEXT PRIMARY KEY,scheme TEXT NOT NULL CHECK(scheme='macos-volume-object-v2'),operation TEXT NOT NULL UNIQUE,backup_hash TEXT NOT NULL,legacy_identity TEXT NOT NULL)";
pub(crate) const CONFIRMATIONS_DDL: &str = "CREATE TABLE identity_confirmations(document TEXT PRIMARY KEY,root TEXT NOT NULL REFERENCES identity_roots(root),scheme TEXT NOT NULL CHECK(scheme='macos-volume-object-v2'),operation TEXT NOT NULL UNIQUE,source TEXT NOT NULL,source_revision INTEGER NOT NULL,source_hash TEXT NOT NULL,generation INTEGER NOT NULL)";

/// Ordinary Mac builds select persistent identities. Existing roots/documents
/// remain held until an independent backup and explicit owner confirmation.
pub(crate) const fn enabled() -> bool {
    cfg!(all(
        target_os = "macos",
        feature = "macos-persistent-storage"
    ))
}

fn sql(error: rusqlite::Error) -> MigrationError {
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

pub(crate) fn version(connection: &Connection) -> Result<i64, MigrationError> {
    connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(sql)
}

pub(crate) fn root_confirmed(connection: &Connection, root: &str) -> Result<bool, MigrationError> {
    if version(connection)? != 3 {
        return Ok(false);
    }
    validate_metadata(connection)?;
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM identity_roots WHERE root=?1 AND scheme=?2)",
            rusqlite::params![root, SCHEME],
            |r| r.get(0),
        )
        .map_err(sql)
}

// A fresh registration records proof that there were no saved or recovery
// records at the atomic decision. The historical backup_hash column stores
// this enrollment marker OR an offline independent-backup digest. A marker is
// never evidence that a backup exists. An explicit offline root confirmation
// replaces it with its backup digest and disables automatic new admission.
fn fresh_root_marker(root: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"mogledge-empty-profile-registration-v1\0");
    hash.update(root.as_bytes());
    format!("{:x}", hash.finalize())
}

pub(crate) fn root_freshly_registered(
    connection: &Connection,
    root: &str,
) -> Result<bool, MigrationError> {
    if !root_confirmed(connection, root)? {
        return Ok(false);
    }
    connection.query_row("SELECT EXISTS(SELECT 1 FROM identity_roots WHERE root=?1 AND backup_hash=?2 AND legacy_identity='')", rusqlite::params![root, fresh_root_marker(root)], |row| row.get(0)).map_err(sql)
}

pub(crate) fn register_empty_root(
    connection: &Connection,
    root: &str,
) -> Result<bool, MigrationError> {
    if root_confirmed(connection, root)? {
        return Ok(true);
    }
    let version = version(connection)?;
    let documents: i64 = connection
        .query_row("SELECT count(*) FROM documents", [], |row| row.get(0))
        .map_err(sql)?;
    let recovery: i64 = if version >= 2 {
        connection.query_row("SELECT (SELECT count(*) FROM recovery_records)+(SELECT count(*) FROM state_tombstones)", [], |row| row.get(0)).map_err(sql)?
    } else {
        0
    };
    if documents != 0 || recovery != 0 {
        return Ok(false);
    }
    // Full payload/integrity validation belongs only to the empty-profile
    // enrollment decision. Ordinary confirmed-root selection reads metadata.
    crate::identifier_migration::validate_db(connection)?;
    match version {
        1 => connection
            .execute_batch(&format!(
                "{};{};{ROOTS_DDL};{CONFIRMATIONS_DDL};PRAGMA user_version=3;",
                crate::state_inspection::recovery_store::RECORDS_DDL,
                crate::state_inspection::recovery_store::TOMBSTONES_DDL
            ))
            .map_err(sql)?,
        2 => connection
            .execute_batch(&format!(
                "{ROOTS_DDL};{CONFIRMATIONS_DDL};PRAGMA user_version=3;"
            ))
            .map_err(sql)?,
        3 => {}
        _ => return Err(MigrationError::UnsupportedDatabase),
    }
    connection
        .execute(
            "INSERT INTO identity_roots VALUES(?1,?2,?3,?4,'')",
            rusqlite::params![
                root,
                SCHEME,
                crate::core::random_token(),
                fresh_root_marker(root)
            ],
        )
        .map_err(sql)?;
    validate_metadata(connection)?;
    Ok(true)
}

pub(crate) fn admit_fresh_document(
    connection: &Connection,
    root: &str,
    document: &str,
    relative: &str,
) -> Result<bool, MigrationError> {
    if document_confirmed(connection, root, document)? {
        return Ok(true);
    }
    if !root_freshly_registered(connection, root)? {
        return Ok(false);
    }
    // An editor's replacement must not turn a failed restoration into empty
    // success. Existing identity/path records need the separate recovery flow.
    let collision: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1 OR (root=?2 AND path=?3)) OR EXISTS(SELECT 1 FROM recovery_records WHERE document_id=?1 OR (root=?2 AND path=?3)) OR EXISTS(SELECT 1 FROM state_tombstones WHERE document_id=?1)", rusqlite::params![document,root,relative], |row| row.get(0)).map_err(sql)?;
    if collision {
        return Ok(false);
    }
    let generation: i64 = connection
        .query_row(
            "SELECT generation FROM quota WHERE singleton=1",
            [],
            |row| row.get(0),
        )
        .map_err(sql)?;
    connection
        .execute(
            "INSERT INTO identity_confirmations VALUES(?1,?2,?3,?4,'',0,'',?5)",
            rusqlite::params![
                document,
                root,
                SCHEME,
                crate::core::random_token(),
                generation
            ],
        )
        .map_err(sql)?;
    validate_metadata(connection)?;
    Ok(true)
}

/// A missing binding is restoration failure, including read and delete. It
/// must never look like a successful empty value that an HTML can overwrite.
pub(crate) fn document_confirmed(
    connection: &Connection,
    root: &str,
    document: &str,
) -> Result<bool, MigrationError> {
    if version(connection)? != 3 {
        return Ok(!enabled());
    }
    validate_metadata(connection)?;
    connection.query_row("SELECT EXISTS(SELECT 1 FROM identity_confirmations c JOIN identity_roots r ON r.root=c.root WHERE c.document=?1 AND c.root=?2 AND c.scheme=?3 AND r.scheme=?3)", rusqlite::params![document, root, SCHEME], |r| r.get(0)).map_err(sql)
}

/// Metadata only: inspection must not deserialize or emit application values.
pub(crate) fn validate_metadata(connection: &Connection) -> Result<(), MigrationError> {
    if version(connection)? != 3 {
        return Ok(());
    }
    let generation: i64 = connection
        .query_row("SELECT generation FROM quota WHERE singleton=1", [], |r| {
            r.get(0)
        })
        .map_err(sql)?;
    let (roots, confirmations): (i64, i64) = connection.query_row("SELECT (SELECT count(*) FROM identity_roots),(SELECT count(*) FROM identity_confirmations)", [], |r| Ok((r.get(0)?,r.get(1)?))).map_err(sql)?;
    if !(1..=4096).contains(&roots) || !(0..=4096).contains(&confirmations) || generation < 0 {
        return Err(MigrationError::Corrupt);
    }
    let mut statement = connection.prepare("SELECT root,scheme,operation,backup_hash,legacy_identity FROM identity_roots LIMIT 4097").map_err(sql)?;
    let mut rows = statement.query([]).map_err(sql)?;
    while let Some(row) = rows.next().map_err(sql)? {
        let root: String = row.get(0).map_err(sql)?;
        let scheme: String = row.get(1).map_err(sql)?;
        let operation: String = row.get(2).map_err(sql)?;
        let backup: String = row.get(3).map_err(sql)?;
        let legacy: String = row.get(4).map_err(sql)?;
        if scheme != SCHEME
            || ![root.as_str(), operation.as_str(), backup.as_str()]
                .into_iter()
                .all(crate::state_inspection::digest_id)
            || (!legacy.is_empty() && !crate::state_inspection::digest_id(&legacy))
        {
            return Err(MigrationError::Corrupt);
        }
    }
    let mut statement = connection.prepare("SELECT c.document,c.root,c.scheme,c.operation,c.source,c.source_revision,c.source_hash,c.generation,r.scheme,d.root,EXISTS(SELECT 1 FROM recovery_records a WHERE a.document_id=c.document AND a.root<>c.root) FROM identity_confirmations c LEFT JOIN identity_roots r ON r.root=c.root LEFT JOIN documents d ON d.id=c.document LIMIT 4097").map_err(sql)?;
    let mut rows = statement.query([]).map_err(sql)?;
    while let Some(row) = rows.next().map_err(sql)? {
        let document: String = row.get(0).map_err(sql)?;
        let root: String = row.get(1).map_err(sql)?;
        let scheme: String = row.get(2).map_err(sql)?;
        let operation: String = row.get(3).map_err(sql)?;
        let source: String = row.get(4).map_err(sql)?;
        let revision: i64 = row.get(5).map_err(sql)?;
        let hash: String = row.get(6).map_err(sql)?;
        let confirmed_generation: i64 = row.get(7).map_err(sql)?;
        let root_scheme: Option<String> = row.get(8).map_err(sql)?;
        let active_root: Option<String> = row.get(9).map_err(sql)?;
        let archived_root_mismatch: bool = row.get(10).map_err(sql)?;
        if scheme != SCHEME
            || root_scheme.as_deref() != Some(SCHEME)
            || ![document.as_str(), root.as_str(), operation.as_str()]
                .into_iter()
                .all(crate::state_inspection::digest_id)
            || confirmed_generation < 0
            || confirmed_generation > generation
            || active_root.as_deref().is_some_and(|value| value != root)
            || archived_root_mismatch
            || if source.is_empty() {
                revision != 0 || !hash.is_empty()
            } else {
                source == document
                    || revision <= 0
                    || !crate::state_inspection::digest_id(&source)
                    || !crate::state_inspection::digest_id(&hash)
            }
        {
            return Err(MigrationError::Corrupt);
        }
    }
    Ok(())
}

pub(crate) fn operation_completed(
    connection: &Connection,
    operation: &str,
) -> Result<bool, MigrationError> {
    if version(connection)? != 3 {
        return Ok(false);
    }
    validate_metadata(connection)?;
    connection.query_row("SELECT operation FROM identity_roots WHERE operation=?1 UNION ALL SELECT operation FROM identity_confirmations WHERE operation=?1", [operation], |r| r.get::<_,String>(0)).optional().map(|v| v.is_some()).map_err(sql)
}

pub(crate) fn hash_metadata(
    connection: &Connection,
    hash: &mut sha2::Sha256,
) -> Result<(), MigrationError> {
    use sha2::Digest;
    if version(connection)? != 3 {
        return Ok(());
    }
    validate_metadata(connection)?;
    for query in ["SELECT root,scheme,operation,backup_hash,legacy_identity FROM identity_roots ORDER BY root", "SELECT document,root,scheme,operation,source,CAST(source_revision AS TEXT),source_hash,CAST(generation AS TEXT) FROM identity_confirmations ORDER BY document"] {
        let mut statement = connection.prepare(query).map_err(sql)?;
        let columns = statement.column_count();
        let mut rows = statement.query([]).map_err(sql)?;
        while let Some(row) = rows.next().map_err(sql)? {
            for column in 0..columns {
                let value: String = row.get(column).map_err(sql)?;
                hash.update((value.len() as u64).to_le_bytes());
                hash.update(value.as_bytes());
            }
        }
    }
    Ok(())
}
