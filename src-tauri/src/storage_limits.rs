//! Explicit profile-wide logical quotas, read inside the caller's SQLite snapshot.
use crate::{core::Core, identifier_migration::MigrationError, state_inspection::live::Context};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub const MIB: i64 = 1024 * 1024;
pub const DEFAULT_DOCUMENT_BYTES: usize = 5 * 1024 * 1024;
pub const DEFAULT_TOTAL_BYTES: i64 = 512 * MIB;
pub const MAX_SAFE_BYTES: i64 = 9_007_199_254_740_991;
pub const MAX_MIB: i64 = MAX_SAFE_BYTES / MIB;
pub(crate) const LEGACY_DDL: &str = "CREATE TABLE storage_limits(singleton INTEGER PRIMARY KEY CHECK(singleton=1),document_bytes INTEGER NOT NULL CHECK(document_bytes BETWEEN 1048576 AND 8388608 AND document_bytes%1048576=0),total_bytes INTEGER NOT NULL CHECK(total_bytes BETWEEN 1048576 AND 1073741824 AND total_bytes%1048576=0 AND total_bytes>=document_bytes),revision INTEGER NOT NULL CHECK(revision>0))";
pub(crate) const DDL: &str = "CREATE TABLE storage_limits(singleton INTEGER PRIMARY KEY CHECK(singleton=1),document_bytes INTEGER NOT NULL CHECK(document_bytes BETWEEN 1048576 AND 9007199253692416 AND document_bytes%1048576=0),total_bytes INTEGER NOT NULL CHECK(total_bytes BETWEEN 1048576 AND 9007199253692416 AND total_bytes%1048576=0 AND total_bytes>=document_bytes),revision INTEGER NOT NULL CHECK(revision>0))";

#[derive(Clone, Copy, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub maximum_document_bytes: usize,
    pub maximum_request_bytes: usize,
    pub maximum_database_bytes: u64,
    pub recovery_budget_bytes: i64,
}
fn sqlite_capacity(connection: &Connection) -> Result<(usize, u64), MigrationError> {
    // Query, never override SQLite's compiled/runtime row limit.
    let length = unsafe {
        rusqlite::ffi::sqlite3_limit(connection.handle(), rusqlite::ffi::SQLITE_LIMIT_LENGTH, -1)
    };
    let page_size: u64 = connection
        .query_row("PRAGMA page_size", [], |r| r.get::<_, i64>(0))
        .map_err(sql_error)?
        .try_into()
        .map_err(|_| MigrationError::Corrupt)?;
    let pages = intrinsic_pages()?;
    if length <= 0 || page_size == 0 {
        return Err(MigrationError::Corrupt);
    }
    Ok((
        length as usize,
        pages
            .checked_mul(page_size)
            .ok_or(MigrationError::Corrupt)?,
    ))
}
fn intrinsic_pages() -> Result<u64, MigrationError> {
    // A fresh connection has no policy page cap inherited from an older profile.
    static PAGES: std::sync::OnceLock<Result<u64, MigrationError>> = std::sync::OnceLock::new();
    *PAGES.get_or_init(|| {
        let c = Connection::open_in_memory().map_err(sql_error)?;
        c.query_row("PRAGMA max_page_count", [], |r| r.get::<_, i64>(0))
            .map_err(sql_error)?
            .try_into()
            .map_err(|_| MigrationError::Corrupt)
    })
}
pub fn maximum_document_bytes() -> usize {
    static LENGTH: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *LENGTH.get_or_init(|| {
        Connection::open_in_memory()
            .ok()
            .and_then(|c| sqlite_capacity(&c).ok())
            .map_or(0, |v| v.0)
    })
}
pub fn maximum_request_bytes() -> usize {
    let length = maximum_document_bytes();
    if length == 0 {
        0
    } else {
        length.checked_add(1024).unwrap_or(0)
    }
}
pub(crate) fn absolute_database_bytes() -> Result<u64, MigrationError> {
    intrinsic_pages()?
        .checked_mul(65536)
        .ok_or(MigrationError::Corrupt)
}
pub(crate) fn physical_database_bytes(connection: &Connection) -> Result<u64, MigrationError> {
    sqlite_capacity(connection).map(|v| v.1)
}
pub fn capabilities(connection: &Connection) -> Result<Capabilities, MigrationError> {
    let (length, _) = sqlite_capacity(connection)?;
    let maximum = crate::identifier_migration::database_size_limit(connection)?;
    let current_pages: i64 = connection
        .query_row("PRAGMA max_page_count", [], |r| r.get(0))
        .map_err(sql_error)?;
    let page_size: i64 = connection
        .query_row("PRAGMA page_size", [], |r| r.get(0))
        .map_err(sql_error)?;
    let actual = u64::try_from(current_pages)
        .ok()
        .and_then(|p| u64::try_from(page_size).ok().and_then(|s| p.checked_mul(s)))
        .filter(|v| *v > 0)
        .ok_or(MigrationError::Corrupt)?;
    let maximum = maximum.min(actual);
    Ok(Capabilities {
        maximum_document_bytes: length,
        maximum_request_bytes: length.checked_add(1024).ok_or(MigrationError::Corrupt)?,
        maximum_database_bytes: maximum,
        recovery_budget_bytes: crate::state_inspection::recovery_store::MAX_ARCHIVE_BYTES,
    })
}
fn normalized(value: &str) -> Vec<u8> {
    value
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .map(|b| b.to_ascii_lowercase())
        .collect()
}
pub(crate) fn acknowledged_format(connection: &Connection) -> Result<bool, MigrationError> {
    if !table_exists(connection)? {
        return Ok(false);
    }
    let sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name='storage_limits'",
            [],
            |r| r.get(0),
        )
        .map_err(sql_error)?;
    Ok(normalized(&sql) == normalized(DDL))
}
pub(crate) fn schema_ddl(connection: &Connection) -> Result<&'static str, MigrationError> {
    let sql: String = connection
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type='table' AND name='storage_limits'",
            [],
            |r| r.get(0),
        )
        .map_err(sql_error)?;
    if normalized(&sql) == normalized(DDL) {
        Ok(DDL)
    } else if normalized(&sql) == normalized(LEGACY_DDL) {
        Ok(LEGACY_DDL)
    } else {
        Err(MigrationError::UnsupportedDatabase)
    }
}
fn mib_bytes(value: i64) -> Option<i64> {
    if !(1..=MAX_MIB).contains(&value) {
        return None;
    }
    value.checked_mul(MIB)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Limits {
    pub document_bytes: usize,
    pub total_bytes: i64,
    pub revision: i64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            document_bytes: DEFAULT_DOCUMENT_BYTES,
            total_bytes: DEFAULT_TOTAL_BYTES,
            revision: 0,
        }
    }
}
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
pub(crate) fn table_exists(connection: &Connection) -> Result<bool, MigrationError> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='storage_limits')",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error)
}
pub(crate) fn read(connection: &Connection) -> Result<Limits, MigrationError> {
    if !table_exists(connection)? {
        return Ok(Limits::default());
    }
    let ddl = schema_ddl(connection)?;
    let rows: i64 = connection
        .query_row("SELECT count(*) FROM storage_limits", [], |row| row.get(0))
        .map_err(sql_error)?;
    if rows != 1 {
        return Err(MigrationError::Corrupt);
    }
    let (document, total, revision): (i64, i64, i64) = connection
        .query_row(
            "SELECT document_bytes,total_bytes,revision FROM storage_limits WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(sql_error)?;
    if !(MIB..=MAX_MIB * MIB).contains(&document)
        || !(MIB..=MAX_MIB * MIB).contains(&total)
        || (ddl == LEGACY_DDL && (document > 8 * MIB || total > 1024 * MIB))
        || total < document
        || document % MIB != 0
        || total % MIB != 0
        || revision <= 0
    {
        return Err(MigrationError::Corrupt);
    }
    Ok(Limits {
        document_bytes: usize::try_from(document).map_err(|_| MigrationError::Corrupt)?,
        total_bytes: total,
        revision,
    })
}

/// A logical limit never authorizes crossing the restart validator's file cap.
pub(crate) fn cap_database(connection: &Connection) -> Result<(), MigrationError> {
    let maximum = i64::try_from(crate::identifier_migration::database_size_limit(
        connection,
    )?)
    .map_err(|_| MigrationError::Corrupt)?;
    let page_size: i64 = connection
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .map_err(sql_error)?;
    let page_count: i64 = connection
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .map_err(sql_error)?;
    if page_size <= 0 || page_count < 0 || page_count > maximum / page_size {
        return Err(MigrationError::Corrupt);
    }
    let current: i64 = connection
        .query_row("PRAGMA max_page_count", [], |row| row.get(0))
        .map_err(sql_error)?;
    // Preserve a stricter VFS/fixture capacity. Only known legacy policy caps
    // may grow to the acknowledged format's intrinsic SQLite page capacity.
    let legacy_pages = (1024_i64 * MIB) / page_size;
    let pages = if current < maximum / page_size
        && current != legacy_pages
        && current != 2 * legacy_pages
    {
        current
    } else {
        maximum / page_size
    };
    if pages <= 0 || page_count > pages {
        return Err(MigrationError::Corrupt);
    }
    let applied: i64 = connection
        .query_row(&format!("PRAGMA max_page_count={pages}"), [], |row| {
            row.get(0)
        })
        .map_err(sql_error)?;
    if applied != pages {
        return Err(MigrationError::Corrupt);
    }
    Ok(())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub document_mi_b: i64,
    pub total_mi_b: i64,
    pub revision: i64,
    pub generation: i64,
    pub usage_bytes: i64,
    pub largest_document_bytes: i64,
    pub recovery_bytes: Option<i64>,
    pub largest_recovery_document_bytes: Option<i64>,
    pub requires_compatibility_acknowledgement: bool,
    pub capabilities: Capabilities,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetRequest {
    pub context: Context,
    pub expected_revision: i64,
    pub expected_generation: i64,
    pub document_mi_b: i64,
    pub total_mi_b: i64,
    pub acknowledge_compatibility: bool,
}
#[derive(Serialize, Debug)]
pub struct LimitsError {
    code: &'static str,
    message: &'static str,
}
pub(crate) fn failure(code: &'static str) -> LimitsError {
    let message = match code {
        "limits_invalid" => "Use positive whole MiB representable as exact bytes, total at least document.",
        "limits_changed" => "Saved data or limits changed. Inspect the current limits again.",
        "limits_below_usage" => "The limits are below active usage or an active/recovery document. Existing values and limits are preserved.",
        "limits_compatibility_required" => "Back up the profile and acknowledge that older apps may reject this saved format.",
        "main_host_required" => "Use the bundled app settings to change saved-state limits.",
        "context_changed" => "The root or view changed. Inspect again.",
        "state_busy" => "Saved data is busy. Retry after the current operation finishes.",
        "state_corrupt" => "Saved-state consistency could not be verified. Existing data is preserved.",
        "capacity_exceeded" => "SQLite or disk capacity was exceeded. Existing values are preserved.",
        "resource_unavailable" => "Resources could not be allocated. Existing values are preserved.",
        "inspection_limit" => "The finite inspection budget was exceeded. Existing data is preserved.",
        _ => "Saved-state limits are unavailable. Existing data is preserved.",
    };
    LimitsError { code, message }
}
pub fn check_main_host(label: &str) -> Result<(), LimitsError> {
    if label == "main" {
        Ok(())
    } else {
        Err(failure("main_host_required"))
    }
}
fn backend(error: MigrationError) -> LimitsError {
    failure(match error {
        MigrationError::Busy => "state_busy",
        MigrationError::Corrupt | MigrationError::UnsupportedDatabase => "state_corrupt",
        MigrationError::Interrupted => "inspection_limit",
        MigrationError::CapacityExceeded => "capacity_exceeded",
        MigrationError::ResourceUnavailable => "resource_unavailable",
        _ => "state_unavailable",
    })
}
fn context_matches(core: &Core, context: &Context) -> Result<(), LimitsError> {
    let workspace = core
        .workspace
        .lock()
        .map_err(|_| failure("state_unavailable"))?;
    if workspace.snapshot.view_id != context.view_id
        || workspace.snapshot.workspace_id != context.workspace_id
    {
        return Err(failure("context_changed"));
    }
    Ok(())
}
fn snapshot(connection: &Connection) -> Result<Snapshot, MigrationError> {
    crate::identifier_migration::validate_schema(connection)?;
    let limits = read(connection)?;
    let capabilities = capabilities(connection)?;
    let (bytes,count,generation,rows): (i64,i64,i64,i64)=connection.query_row("SELECT bytes,documents,generation,(SELECT count(*) FROM quota) FROM quota WHERE singleton=1",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(sql_error)?;
    let (actual,count_actual,largest,max_generation): (i64,i64,i64,i64)=connection.query_row("SELECT coalesce(sum(bytes),0),count(*),coalesce(max(bytes),0),coalesce(max(generation),0) FROM documents",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?))).map_err(sql_error)?;
    if rows != 1
        || bytes != actual
        || count != count_actual
        || !(0..=MAX_SAFE_BYTES).contains(&bytes)
        || !(0..=4096).contains(&count)
        || generation < max_generation
        || generation < 0
        || largest > capabilities.maximum_document_bytes as i64
    {
        return Err(MigrationError::Corrupt);
    }
    let invalid:i64=connection.query_row("SELECT count(*) FROM documents WHERE typeof(bytes)<>'integer' OR bytes NOT BETWEEN 2 AND ?1 OR typeof(data)<>'text' OR length(CAST(data AS BLOB))<>bytes",[capabilities.maximum_document_bytes as i64],|row|row.get(0)).map_err(sql_error)?;
    if invalid != 0 {
        return Err(MigrationError::Corrupt);
    }
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql_error)?;
    let (recovery_bytes, largest_recovery) = if version >= 2 {
        crate::state_inspection::recovery_store::validate_metadata(connection)?;
        let (sum,count,max):(i64,i64,i64)=connection.query_row("SELECT coalesce(sum(bytes),0),count(*),coalesce(max(bytes),0) FROM recovery_records",[],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))).map_err(sql_error)?;
        if !(0..=crate::state_inspection::recovery_store::MAX_ARCHIVE_BYTES).contains(&sum)
            || !(0..=4096).contains(&count)
            || max > capabilities.maximum_document_bytes as i64
        {
            return Err(MigrationError::Corrupt);
        }
        (Some(sum), Some(max))
    } else {
        (None, None)
    };
    Ok(Snapshot {
        document_mi_b: limits.document_bytes as i64 / MIB,
        total_mi_b: limits.total_bytes / MIB,
        revision: limits.revision,
        generation,
        usage_bytes: bytes,
        largest_document_bytes: largest,
        recovery_bytes,
        largest_recovery_document_bytes: largest_recovery,
        requires_compatibility_acknowledgement: !acknowledged_format(connection)?,
        capabilities,
    })
}
struct SqlBudget<'a>(&'a Connection);
impl Drop for SqlBudget<'_> {
    fn drop(&mut self) {
        let _ = self.0.progress_handler(0, None::<fn() -> bool>);
    }
}
fn run<T>(
    core: &Core,
    context: &Context,
    operation: impl FnOnce(&Connection) -> Result<T, LimitsError>,
) -> Result<T, LimitsError> {
    let _gate = core.gate.lock().map_err(|_| failure("state_unavailable"))?;
    context_matches(core, context)?;
    let store = core
        .document_state
        .get()
        .ok_or_else(|| failure("state_unavailable"))?;
    // The existing gate -> DB mutex order also serializes every HTML commit.
    let mut output = None;
    store
        .management_connection(|connection, _, _, _| {
            let transaction = crate::state_inspection::recovery_store::begin_atomic(connection)
                .map_err(|error| crate::state_inspection::backend_error(sql_error(error)))?;
            let started = std::time::Instant::now();
            let _budget = SqlBudget(connection);
            connection
                .progress_handler(
                    1000,
                    Some(move || started.elapsed() > std::time::Duration::from_secs(2)),
                )
                .map_err(|error| crate::state_inspection::backend_error(sql_error(error)))?;
            let result = operation(&transaction);
            connection
                .progress_handler(0, None::<fn() -> bool>)
                .map_err(|error| crate::state_inspection::backend_error(sql_error(error)))?;
            if result.is_ok() {
                store.verify_management()?;
                transaction
                    .commit()
                    .map_err(|error| crate::state_inspection::backend_error(sql_error(error)))?;
            }
            output = Some(result);
            Ok(())
        })
        .map_err(|error| failure(error.code))?;
    output.ok_or_else(|| failure("state_unavailable"))?
}
pub fn get(core: &Core, context: &Context) -> Result<Snapshot, LimitsError> {
    run(core, context, |connection| {
        snapshot(connection).map_err(backend)
    })
}
pub fn set(core: &Core, request: &SetRequest) -> Result<Snapshot, LimitsError> {
    if mib_bytes(request.document_mi_b).is_none()
        || mib_bytes(request.total_mi_b).is_none()
        || usize::try_from(request.document_mi_b.checked_mul(MIB).unwrap_or(-1)).is_err()
        || request.total_mi_b < request.document_mi_b
        || request.expected_revision < 0
        || request.expected_generation < 0
    {
        return Err(failure("limits_invalid"));
    }
    run(core, &request.context, |connection| {
        let current = snapshot(connection).map_err(backend)?;
        if current.revision != request.expected_revision
            || current.generation != request.expected_generation
        {
            return Err(failure("limits_changed"));
        }
        if current.document_mi_b == request.document_mi_b
            && current.total_mi_b == request.total_mi_b
        {
            return Ok(current);
        }
        let document = request.document_mi_b * MIB;
        if current.usage_bytes > request.total_mi_b * MIB
            || current.largest_document_bytes > document
            || current.largest_recovery_document_bytes.unwrap_or(0) > document
        {
            return Err(failure("limits_below_usage"));
        }
        if current.requires_compatibility_acknowledgement {
            if !request.acknowledge_compatibility {
                return Err(failure("limits_compatibility_required"));
            }
            if table_exists(connection).map_err(backend)? {
                connection
                    .execute_batch("DROP TABLE storage_limits")
                    .map_err(|e| backend(sql_error(e)))?;
            }
            connection
                .execute_batch(DDL)
                .map_err(|error| backend(sql_error(error)))?;
        }
        let revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| failure("state_corrupt"))?;
        let generation = current
            .generation
            .checked_add(1)
            .ok_or_else(|| failure("state_corrupt"))?;
        connection.execute("INSERT INTO storage_limits VALUES(1,?1,?2,?3) ON CONFLICT(singleton) DO UPDATE SET document_bytes=excluded.document_bytes,total_bytes=excluded.total_bytes,revision=excluded.revision",params![document,request.total_mi_b*MIB,revision]).map_err(|error|backend(sql_error(error)))?;
        connection
            .execute(
                "UPDATE quota SET generation=?1 WHERE singleton=1",
                [generation],
            )
            .map_err(|error| backend(sql_error(error)))?;
        cap_database(connection).map_err(backend)?;
        snapshot(connection).map_err(backend)
    })
}

#[cfg(test)]
#[path = "storage_limits/tests.rs"]
mod tests;
