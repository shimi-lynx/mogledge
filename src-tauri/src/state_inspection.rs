//! On-demand saved-state metadata reports. No document grant or write command.
#[path = "state_inspection/assessment.rs"]
pub mod assessment;
#[path = "state_inspection/collector.rs"]
pub(crate) mod collector;
#[path = "state_inspection/live.rs"]
pub mod live;
#[path = "state_inspection/management.rs"]
pub mod management;
#[path = "state_inspection/recovery_store.rs"]
pub(crate) mod recovery_store;

use crate::identifier_migration::{self, MigrationError};
use rusqlite::{Connection, ErrorCode};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_RECORDS: i64 = 4096;
const MAX_TOTAL_BYTES: i64 = 512 * 1024 * 1024;
const MAX_PAGE: usize = 100;
const MAX_REPORT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct InspectionError {
    pub(crate) code: &'static str,
    message: &'static str,
}
fn error(code: &'static str, message: &'static str) -> InspectionError {
    InspectionError { code, message }
}
pub(crate) fn backend_error(value: MigrationError) -> InspectionError {
    let (code, message) = match value {
        MigrationError::UnsafePath => ("unsafe_path", "Use an existing ordinary local state directory without links."),
        MigrationError::Busy => ("state_busy", "Saved state is busy. Retry after the application exits."),
        MigrationError::Corrupt => ("state_corrupt", "Saved-state metadata or SQLite structure is inconsistent. Nothing was repaired."),
        MigrationError::UnsupportedDatabase => ("unsupported_state", "Unsupported schema, journal mode or directory entries. No sidecars were opened or removed."),
        MigrationError::SourceChanged => ("state_changed", "The database, directory or requested snapshot changed. Inspect again."),
        MigrationError::Interrupted => ("inspection_limit", "Inspection exceeded its finite query or metadata budget."),
        MigrationError::CapacityExceeded => ("capacity_exceeded", "SQLite or disk capacity was exceeded. Existing values are preserved."),
        MigrationError::ResourceUnavailable => ("resource_unavailable", "Resources could not be allocated. Existing values are preserved."),
        MigrationError::Unavailable => ("state_unavailable", "Saved state is missing or unavailable. Nothing was created or initialized."),
    };
    error(code, message)
}
fn sql_error(value: rusqlite::Error) -> MigrationError {
    match value.sqlite_error_code() {
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => MigrationError::Busy,
        Some(ErrorCode::OperationInterrupted) => MigrationError::Interrupted,
        Some(rusqlite::ErrorCode::TooBig | rusqlite::ErrorCode::DiskFull) => {
            MigrationError::CapacityExceeded
        }
        Some(rusqlite::ErrorCode::OutOfMemory) => MigrationError::ResourceUnavailable,
        _ => MigrationError::Corrupt,
    }
}
pub(crate) fn digest_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    logical_bytes: i64,
    records: i64,
    empty_records: i64,
    recovery_history_candidates: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    document_identity: String,
    root_identity: String,
    revision: i64,
    generation: i64,
    logical_bytes: i64,
    reasons: Vec<&'static str>,
    decision: &'static str,
    last_viewed_at: Option<u64>,
    last_observed_at: Option<u64>,
    activity: &'static str,
    source_availability: &'static str,
    recommended_next_step: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Report {
    schema_version: u8,
    app_version: String,
    command: &'static str,
    dry_run: bool,
    generated_at_unix_ms: u128,
    report_id: String,
    pub(crate) database_id: String,
    pub(crate) snapshot_id: String,
    database_schema_version: u8,
    pub(crate) database_generation: i64,
    metadata_complete: bool,
    state_json_validation: &'static str,
    source_scan: &'static str,
    cleanup_authorized: bool,
    usage: Usage,
    recovery_logical_bytes: Option<i64>,
    recovery_records: Option<i64>,
    roots: BTreeMap<String, Usage>,
    database_bytes: u64,
    free_database_page_bytes: i64,
    journal_bytes: u64,
    wal_bytes: u64,
    shm_bytes: u64,
    backup_bytes: Option<u64>,
    quarantine_bytes: Option<u64>,
    reclaimable_logical_bytes: Option<u64>,
    reclaimable_disk_bytes: Option<u64>,
    offset: usize,
    limit: usize,
    has_more: bool,
    candidates: Vec<Candidate>,
}
struct Record {
    id: String,
    root: String,
    path: String,
    bytes: i64,
    revision: i64,
    generation: i64,
    empty: bool,
}

fn report(
    connection: &Connection,
    database_bytes: u64,
    database_id: &str,
    limit: usize,
    offset: usize,
    expected_snapshot: Option<&str>,
) -> Result<Report, MigrationError> {
    let integrity: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(sql_error)?;
    if integrity != "ok" {
        return Err(MigrationError::Corrupt);
    }
    let (bytes, count, generation, quota_rows): (i64, i64, i64, i64) = connection.query_row(
        "SELECT bytes,documents,generation,(SELECT count(*) FROM quota) FROM quota WHERE singleton=1", [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    ).map_err(sql_error)?;
    let limits = crate::storage_limits::read(connection)?;
    if !(0..=limits.total_bytes).contains(&bytes)
        || !(0..=MAX_RECORDS).contains(&count)
        || generation < 0
        || quota_rows != 1
    {
        return Err(MigrationError::Corrupt);
    }
    // Check lengths in SQLite before materializing untrusted metadata. State
    // bodies are neither selected nor JSON-parsed; only canonical {} is tested.
    let invalid: i64 = connection.query_row(
        "SELECT count(*) FROM documents WHERE typeof(id)<>'text' OR length(CAST(id AS BLOB))<>64 OR typeof(root)<>'text' OR length(CAST(root AS BLOB))<>64 OR typeof(path)<>'text' OR length(CAST(path AS BLOB)) NOT BETWEEN 1 AND 4096 OR typeof(data)<>'text' OR length(CAST(data AS BLOB))<>bytes OR typeof(bytes)<>'integer' OR bytes NOT BETWEEN 2 AND ?1 OR typeof(revision)<>'integer' OR revision<=0 OR typeof(generation)<>'integer' OR generation NOT BETWEEN 1 AND ?2",
        [crate::storage_limits::maximum_document_bytes() as i64, generation], |row| row.get(0),
    ).map_err(sql_error)?;
    if invalid != 0 {
        return Err(MigrationError::Corrupt);
    }
    let mut statement = connection.prepare(
        "SELECT id,root,path,bytes,revision,generation,CASE WHEN bytes=2 THEN data='{}' ELSE 0 END FROM documents ORDER BY id LIMIT 4097",
    ).map_err(sql_error)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    let mut records = Vec::new();
    let mut locations = BTreeMap::<(String, String), usize>::new();
    let mut ids = BTreeSet::new();
    let mut total = 0i64;
    let mut snapshot = Sha256::new();
    snapshot.update(database_id.as_bytes());
    snapshot.update(generation.to_le_bytes());
    while let Some(row) = rows.next().map_err(sql_error)? {
        if records.len() >= MAX_RECORDS as usize {
            return Err(MigrationError::Corrupt);
        }
        let record = Record {
            id: row.get(0).map_err(sql_error)?,
            root: row.get(1).map_err(sql_error)?,
            path: row.get(2).map_err(sql_error)?,
            bytes: row.get(3).map_err(sql_error)?,
            revision: row.get(4).map_err(sql_error)?,
            generation: row.get(5).map_err(sql_error)?,
            empty: row.get(6).map_err(sql_error)?,
        };
        if !digest_id(&record.id)
            || !digest_id(&record.root)
            || crate::knowledge::validate_relative(&record.path).is_err()
            || !ids.insert(record.id.clone())
        {
            return Err(MigrationError::Corrupt);
        }
        total = total
            .checked_add(record.bytes)
            .ok_or(MigrationError::Corrupt)?;
        *locations
            .entry((record.root.clone(), record.path.clone()))
            .or_default() += 1;
        for value in [&record.id, &record.root, &record.path] {
            snapshot.update((value.len() as u64).to_le_bytes());
            snapshot.update(value.as_bytes());
        }
        for value in [
            record.bytes,
            record.revision,
            record.generation,
            i64::from(record.empty),
        ] {
            snapshot.update(value.to_le_bytes());
        }
        records.push(record);
    }
    if total != bytes || records.len() as i64 != count {
        return Err(MigrationError::Corrupt);
    }
    let schema_version: i64 = connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(sql_error)?;
    let (recovery_logical_bytes, recovery_records) = if schema_version >= 2 {
        // Hash bounded archive/tombstone metadata too, without selecting values.
        let mut statement=connection.prepare("SELECT operation_id,document_id,root,path,revision,bytes,generation,status,coalesce(restore_operation_id,''),coalesce(restored_revision,0) FROM recovery_records ORDER BY operation_id LIMIT 4097").map_err(sql_error)?;
        let mut rows = statement.query([]).map_err(sql_error)?;
        let mut count = 0i64;
        let mut total = 0i64;
        while let Some(row) = rows.next().map_err(sql_error)? {
            count += 1;
            if count > MAX_RECORDS {
                return Err(MigrationError::Corrupt);
            }
            for index in [0, 1, 2, 3, 7, 8] {
                let value: String = row.get(index).map_err(sql_error)?;
                if value.len() > 4096 {
                    return Err(MigrationError::Corrupt);
                }
                snapshot.update((value.len() as u64).to_le_bytes());
                snapshot.update(value.as_bytes());
            }
            for index in [4, 5, 6, 9] {
                let value: i64 = row.get(index).map_err(sql_error)?;
                snapshot.update(value.to_le_bytes());
                if index == 5 {
                    total = total.checked_add(value).ok_or(MigrationError::Corrupt)?;
                }
            }
        }
        let mut statement=connection.prepare("SELECT document_id,revision,operation_id FROM state_tombstones ORDER BY document_id LIMIT 4097").map_err(sql_error)?;
        let mut rows = statement.query([]).map_err(sql_error)?;
        let mut tombstones = 0;
        while let Some(row) = rows.next().map_err(sql_error)? {
            tombstones += 1;
            if tombstones > MAX_RECORDS {
                return Err(MigrationError::Corrupt);
            }
            for index in [0, 2] {
                let value: String = row.get(index).map_err(sql_error)?;
                snapshot.update((value.len() as u64).to_le_bytes());
                snapshot.update(value.as_bytes());
            }
            snapshot.update(row.get::<_, i64>(1).map_err(sql_error)?.to_le_bytes());
        }
        (Some(total), Some(count))
    } else {
        (None, None)
    };
    crate::storage_identity_transition::hash_metadata(connection, &mut snapshot)?;
    snapshot.update(schema_version.to_le_bytes());
    let snapshot_id = format!("{:x}", snapshot.finalize());
    if expected_snapshot.is_some_and(|expected| expected != snapshot_id) {
        return Err(MigrationError::SourceChanged);
    }
    let page_size: i64 = connection
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .map_err(sql_error)?;
    let free_pages: i64 = connection
        .query_row("PRAGMA freelist_count", [], |row| row.get(0))
        .map_err(sql_error)?;
    let free_bytes = page_size
        .checked_mul(free_pages)
        .filter(|bytes| *bytes >= 0 && *bytes as u64 <= database_bytes)
        .ok_or(MigrationError::Corrupt)?;
    let mut usage = Usage::default();
    let mut roots = BTreeMap::<String, Usage>::new();
    let mut candidates = Vec::new();
    for (index, record) in records.into_iter().enumerate() {
        let history = locations[&(record.root.clone(), record.path)] > 1;
        for value in [&mut usage, roots.entry(record.root.clone()).or_default()] {
            value.logical_bytes += record.bytes;
            value.records += 1;
            value.empty_records += i64::from(record.empty);
            value.recovery_history_candidates += i64::from(history);
        }
        if index < offset || candidates.len() == limit {
            continue;
        }
        let mut reasons = vec!["source_not_checked", "activity_unknown"];
        if record.empty {
            reasons.push("empty_record");
        }
        if history {
            reasons.push("possible_recovery_history");
        }
        candidates.push(Candidate {
            document_identity: record.id,
            root_identity: record.root,
            revision: record.revision,
            generation: record.generation,
            logical_bytes: record.bytes,
            reasons,
            decision: "hold",
            last_viewed_at: None,
            last_observed_at: None,
            activity: "unknown",
            source_availability: "not_checked",
            recommended_next_step: "review_in_trusted_host_before_any_cleanup",
        });
    }
    let product: serde_json::Value = serde_json::from_str(include_str!("../../package.json"))
        .map_err(|_| MigrationError::Unavailable)?;
    let app_version = product["version"]
        .as_str()
        .ok_or(MigrationError::Unavailable)?
        .to_owned();
    Ok(Report {
        schema_version: 1,
        app_version,
        command: "inspect",
        dry_run: true,
        generated_at_unix_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| MigrationError::Unavailable)?
            .as_millis(),
        report_id: crate::core::random_token(),
        database_id: database_id.into(),
        snapshot_id,
        database_schema_version: connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(sql_error)?,
        database_generation: generation,
        metadata_complete: true,
        state_json_validation: "not_checked",
        source_scan: "not_performed",
        cleanup_authorized: false,
        usage,
        recovery_logical_bytes,
        recovery_records,
        roots,
        database_bytes,
        free_database_page_bytes: free_bytes,
        journal_bytes: 0,
        wal_bytes: 0,
        shm_bytes: 0,
        backup_bytes: None,
        quarantine_bytes: None,
        reclaimable_logical_bytes: None,
        reclaimable_disk_bytes: None,
        offset,
        limit,
        has_more: offset.saturating_add(limit) < count as usize,
        candidates,
    })
}

fn invalid_arguments() -> InspectionError {
    error("invalid_arguments", "Use inspect --state-dir <absolute directory> [--limit 1..100] [--offset 0..4096] [--snapshot-id <64 lowercase hex>] [--format json], or manage --profile-dir <absolute directory> [--root <absolute directory>] for explicit stopped-profile operations.")
}

/// Native CLI routing keeps ordinary inspection unchanged. Management is an
/// explicitly entered, stopped-profile stdin session; opening it never upgrades.
pub fn run_cli<I: IntoIterator<Item = OsString>, O: Write, E: Write>(
    arguments: I,
    stdout: &mut O,
    stderr: &mut E,
) -> i32 {
    let mut arguments = arguments.into_iter().peekable();
    if arguments.peek().is_none_or(|value| value != "manage") {
        return run(arguments, stdout, stderr);
    }
    arguments.next();
    let mut parse = || -> Result<(PathBuf, Option<PathBuf>), InspectionError> {
        let mut options = BTreeMap::new();
        while let Some(key) = arguments.next() {
            let key = key.into_string().map_err(|_| invalid_arguments())?;
            if !["--profile-dir", "--root"].contains(&key.as_str()) {
                return Err(invalid_arguments());
            }
            let value = arguments.next().ok_or_else(invalid_arguments)?;
            if options.insert(key, value).is_some() {
                return Err(invalid_arguments());
            }
        }
        let profile = PathBuf::from(
            options
                .remove("--profile-dir")
                .ok_or_else(invalid_arguments)?,
        );
        let root = options.remove("--root").map(PathBuf::from);
        if !profile.is_absolute() || root.as_ref().is_some_and(|root| !root.is_absolute()) {
            return Err(invalid_arguments());
        }
        Ok((profile, root))
    };
    match parse() {
        Ok((profile, root)) => management::run(
            &profile,
            root.as_deref(),
            &mut std::io::stdin().lock(),
            stdout,
            stderr,
        ),
        Err(error) => {
            let _ = serde_json::to_writer(&mut *stderr, &error);
            let _ = stderr.write_all(b"\n");
            2
        }
    }
}

/// Explicit paths come only from the invoking host. No default profile discovery,
/// settings access, HTML reads, migration, recovery, quarantine or deletion.
pub fn run<I: IntoIterator<Item = OsString>, O: Write, E: Write>(
    arguments: I,
    stdout: &mut O,
    stderr: &mut E,
) -> i32 {
    let execute = || -> Result<Vec<u8>, InspectionError> {
        let mut arguments = arguments.into_iter();
        if arguments.next().as_deref() != Some(std::ffi::OsStr::new("inspect")) {
            return Err(invalid_arguments());
        }
        let mut options = BTreeMap::new();
        while let Some(key) = arguments.next() {
            let key = key.into_string().map_err(|_| invalid_arguments())?;
            if ![
                "--state-dir",
                "--limit",
                "--offset",
                "--snapshot-id",
                "--format",
            ]
            .contains(&key.as_str())
            {
                return Err(invalid_arguments());
            }
            let value = arguments.next().ok_or_else(invalid_arguments)?;
            if options.insert(key, value).is_some() {
                return Err(invalid_arguments());
            }
        }
        let directory = PathBuf::from(
            options
                .remove("--state-dir")
                .ok_or_else(invalid_arguments)?,
        );
        if !directory.is_absolute() {
            return Err(invalid_arguments());
        }
        let number =
            |key: &str, default: usize, maximum: usize| -> Result<usize, InspectionError> {
                let Some(value) = options.get(key) else {
                    return Ok(default);
                };
                let text = value.to_str().ok_or_else(invalid_arguments)?;
                if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(invalid_arguments());
                }
                text.parse::<usize>()
                    .ok()
                    .filter(|value| *value <= maximum)
                    .ok_or_else(invalid_arguments)
            };
        let limit = number("--limit", 20, MAX_PAGE)?;
        let offset = number("--offset", 0, MAX_RECORDS as usize)?;
        if limit == 0 {
            return Err(invalid_arguments());
        }
        if options.get("--format").is_some_and(|value| value != "json") {
            return Err(invalid_arguments());
        }
        let expected = options
            .get("--snapshot-id")
            .map(|value| value.to_str().ok_or_else(invalid_arguments))
            .transpose()?;
        if expected.is_some_and(|value| !digest_id(value)) {
            return Err(invalid_arguments());
        }
        let report = inspect(&directory, limit, offset, expected).map_err(backend_error)?;
        let mut bytes = serde_json::to_vec(&report)
            .map_err(|_| error("output_error", "Cannot serialize the metadata report."))?;
        if bytes.len() > MAX_REPORT_BYTES {
            return Err(backend_error(MigrationError::Interrupted));
        }
        bytes.push(b'\n');
        Ok(bytes)
    };
    match execute() {
        Ok(bytes) if stdout.write_all(&bytes).is_ok() => 0,
        Ok(_) => {
            let _ = serde_json::to_writer(
                &mut *stderr,
                &error("output_error", "Cannot write JSON output."),
            );
            let _ = stderr.write_all(b"\n");
            2
        }
        Err(error) => {
            let _ = serde_json::to_writer(&mut *stderr, &error);
            let _ = stderr.write_all(b"\n");
            2
        }
    }
}

fn inspect(
    path: &Path,
    limit: usize,
    offset: usize,
    expected: Option<&str>,
) -> Result<Report, MigrationError> {
    identifier_migration::inspect_state_snapshot(path, |connection, bytes, id| {
        report(connection, bytes, id, limit, offset, expected)
    })
}

#[cfg(test)]
#[path = "state_inspection/tests.rs"]
mod tests;
