//! Rebuildable, root-scoped local SQLite cache. Source HTML is never modified here.
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rusqlite::{params, params_from_iter, Connection, OpenFlags};
use sha2::{Digest, Sha256};

use super::extract::normalize_search;
use super::highlight::{self, MatchRange};

pub(super) const SCHEMA_VERSION: &str = "1";
pub(super) const EXTRACTOR_VERSION: &str = "1";
const MAX_DATABASE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LIMIT: u32 = 100;
const MAX_OFFSET: u32 = 10_000;
const MAX_QUERY_CHARS: usize = 256;
const MAX_TERMS: usize = 8;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchMode {
    #[default]
    And,
    Or,
}

impl SearchMode {
    fn operator(self) -> &'static str {
        match self {
            Self::And => " AND ",
            Self::Or => " OR ",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DocumentState {
    Ready,
    Pending,
    Unavailable,
    Failed,
}

impl DocumentState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Pending => "pending",
            Self::Unavailable => "unavailable",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRecord {
    pub relative_path: String,
    pub title: String,
    pub headings: String,
    pub body: String,
    pub source_hash: Option<String>,
    pub source_size: u64,
    pub modified_ns: Option<String>,
    pub state: DocumentState,
    pub truncated: bool,
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreCounts {
    pub indexed: u64,
    pub pending: u64,
    pub unavailable: u64,
    pub failed: u64,
    pub truncated: u64,
    pub database_bytes: u64,
    pub expected_documents: u64,
    pub complete: bool,
    pub limited: bool,
    pub building: bool,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub document_id: String,
    pub relative_path: String,
    pub title: String,
    pub snippet: String,
    pub title_matches: Vec<MatchRange>,
    pub snippet_matches: Vec<MatchRange>,
    pub truncated: bool,
    pub indexed_source_hash: Option<String>,
    pub indexed_source_size: u64,
    pub indexed_modified_ns: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub request_revision: u64,
    pub generation: u64,
    pub hits: Vec<SearchHit>,
    pub has_more: bool,
    pub normalized_query: String,
}

pub struct Store {
    connection: Connection,
    path: PathBuf,
    root_id: String,
    pub rebuilt: bool,
}

fn sql_error(error: rusqlite::Error) -> String {
    // SQLite diagnostics can contain file names. Do not expose them to the UI.
    match error {
        rusqlite::Error::SqliteFailure(code, _) => {
            format!("Index database error ({:?})", code.code)
        }
        _ => "Index database operation failed".to_string(),
    }
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn verify_cache_directory(directory: &Path) -> Result<(), String> {
    if !directory.is_absolute()
        || directory
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("Index cache directory must be an absolute directory".into());
    }
    #[cfg(windows)]
    crate::knowledge::validate_cache_path(directory)
        .map_err(|_| "Index cache must use ordinary local paths")?;
    for ancestor in directory.ancestors().filter(|ancestor| ancestor.has_root()) {
        let metadata =
            fs::symlink_metadata(ancestor).map_err(|_| "Cannot inspect index cache directory")?;
        if !metadata.is_dir() || is_reparse(&metadata) {
            return Err("Index cache directory must not contain links or reparse points".into());
        }
    }
    Ok(())
}

fn database_path(cache_directory: &Path, root_id: &str) -> Result<PathBuf, String> {
    if root_id.len() != 64
        || !root_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Invalid index root identifier".into());
    }
    verify_cache_directory(cache_directory)?;
    Ok(cache_directory.join(format!("index-{root_id}.sqlite3")))
}

fn cache_files(path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![path.to_path_buf()];
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_os_string();
        name.push(suffix);
        paths.push(PathBuf::from(name));
    }
    paths
}

fn verify_cache_files(path: &Path) -> Result<(), String> {
    for candidate in cache_files(path) {
        #[cfg(windows)]
        crate::knowledge::validate_cache_path(&candidate)
            .map_err(|_| "Index cache must use ordinary local files")?;
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if !metadata.file_type().is_file() || is_reparse(&metadata) => {
                return Err("Index cache must contain ordinary files".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot inspect index cache".into()),
        }
    }
    Ok(())
}

fn remove_cache(path: &Path) -> Result<(), String> {
    verify_cache_files(path)?;
    for candidate in cache_files(path) {
        match fs::remove_file(candidate) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot rebuild index cache".into()),
        }
    }
    Ok(())
}

fn cache_is_valid(connection: &Connection, root_id: &str) -> Result<bool, rusqlite::Error> {
    let check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    if check != "ok" {
        return Ok(false);
    }
    if !schema_matches(connection, root_id)? {
        return Ok(false);
    }
    // rank=1 compares the external-content table with FTS postings as well as
    // the index itself; quick_check alone cannot detect missing postings.
    connection.execute(
        "INSERT INTO documents_fts(documents_fts,rank) VALUES('integrity-check',1)",
        [],
    )?;
    Ok(true)
}

fn schema_matches(connection: &Connection, root_id: &str) -> Result<bool, rusqlite::Error> {
    let table_exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='metadata')",
        [],
        |row| row.get(0),
    )?;
    if !table_exists {
        return Ok(false);
    }
    for (key, expected) in [
        ("root_id", root_id),
        ("schema_version", SCHEMA_VERSION),
        ("extractor_version", EXTRACTOR_VERSION),
    ] {
        use rusqlite::OptionalExtension;
        let actual: Option<String> = connection
            .query_row("SELECT value FROM metadata WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()?;
        if actual.as_deref() != Some(expected) {
            return Ok(false);
        }
    }
    for key in [
        "generation",
        "expected_documents",
        "complete",
        "limited",
        "building",
    ] {
        use rusqlite::OptionalExtension;
        let value: Option<String> = connection
            .query_row("SELECT value FROM metadata WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()?;
        let Some(value) = value else {
            return Ok(false);
        };
        if matches!(key, "complete" | "limited" | "building") {
            if !matches!(value.as_str(), "0" | "1") {
                return Ok(false);
            }
        } else if value.parse::<u64>().is_err() {
            return Ok(false);
        }
    }
    let object_count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_schema WHERE
        (type='table' AND name IN ('documents','documents_fts')) OR
        (type='trigger' AND name IN ('documents_insert','documents_delete','documents_update'))",
        [],
        |row| row.get(0),
    )?;
    Ok(object_count == 5)
}

fn is_corruption(error: &rusqlite::Error) -> bool {
    matches!(error, rusqlite::Error::SqliteFailure(code, _) if matches!(code.code,
        rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase))
}

fn generation(connection: &Connection) -> Result<u64, String> {
    let value: String = connection
        .query_row(
            "SELECT value FROM metadata WHERE key='generation'",
            [],
            |row| row.get(0),
        )
        .map_err(sql_error)?;
    value.parse().map_err(|_| "Invalid index generation".into())
}

fn bump_generation(connection: &Connection) -> Result<u64, String> {
    let next = generation(connection)?
        .checked_add(1)
        .ok_or("Index generation limit exceeded")?;
    connection
        .execute(
            "UPDATE metadata SET value=?1 WHERE key='generation'",
            [next.to_string()],
        )
        .map_err(sql_error)?;
    Ok(next)
}

fn valid_relative_path(path: &str) -> bool {
    !path.is_empty()
        && path.chars().count() <= 32768
        && !path.starts_with('/')
        && !path.contains(['\\', '\0', ':'])
        && path
            .split('/')
            .all(|part| !part.is_empty() && !part.starts_with('.'))
}

fn valid_source_metadata(hash: Option<&str>, modified: Option<&str>) -> bool {
    hash.is_none_or(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) && modified.is_none_or(|value| {
        !value.is_empty() && value.len() <= 39 && value.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn document_id(root_id: &str, relative_path: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(root_id.as_bytes());
    hash.update([0]);
    hash.update(relative_path.as_bytes());
    format!("{:x}", hash.finalize())
}

fn open_readonly(cache_directory: &Path, root_id: &str) -> Result<(Connection, PathBuf), String> {
    let path = database_path(cache_directory, root_id)?;
    verify_cache_files(&path)?;
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > MAX_DATABASE_BYTES) {
        return Err("Index cache exceeds the 256 MiB limit".into());
    }
    let connection = Connection::open_with_flags(
        &path,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(sql_error)?;
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(sql_error)?;
    let deadline = Instant::now() + Duration::from_millis(200);
    connection
        .progress_handler(1000, Some(move || Instant::now() >= deadline))
        .map_err(sql_error)?;
    // Metadata and rows share one read snapshot. This never creates or repairs a DB.
    connection
        .execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN DEFERRED;")
        .map_err(sql_error)?;
    if !schema_matches(&connection, root_id).map_err(sql_error)? {
        return Err("Index cache needs rebuilding".into());
    }
    Ok((connection, path))
}

fn row_u64(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<u64> {
    let value: i64 = row.get(index)?;
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(index, value))
}

fn read_counts(connection: &Connection, path: &Path) -> Result<StoreCounts, String> {
    let mut counts = connection
        .query_row(
            "SELECT COALESCE(SUM(state='ready'),0),COALESCE(SUM(state='pending'),0),
        COALESCE(SUM(state='unavailable'),0),COALESCE(SUM(state='failed'),0),
        COALESCE(SUM(truncated),0) FROM documents",
            [],
            |row| {
                Ok(StoreCounts {
                    indexed: row_u64(row, 0)?,
                    pending: row_u64(row, 1)?,
                    unavailable: row_u64(row, 2)?,
                    failed: row_u64(row, 3)?,
                    truncated: row_u64(row, 4)?,
                    database_bytes: 0,
                    expected_documents: 0,
                    complete: false,
                    limited: false,
                    building: false,
                })
            },
        )
        .map_err(sql_error)?;
    let metadata_value = |key| -> Result<String, String> {
        connection
            .query_row("SELECT value FROM metadata WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .map_err(sql_error)
    };
    counts.expected_documents = metadata_value("expected_documents")?
        .parse()
        .map_err(|_| "Invalid index document count")?;
    counts.complete = metadata_value("complete")? == "1";
    counts.limited = metadata_value("limited")? == "1";
    counts.building = metadata_value("building")? == "1";
    counts.database_bytes = fs::metadata(path)
        .map_err(|_| "Cannot inspect index cache size")?
        .len();
    Ok(counts)
}

impl Store {
    pub fn open(cache_directory: &Path, root_id: &str) -> Result<Self, String> {
        let path = database_path(cache_directory, root_id)?;
        verify_cache_files(&path)?;
        let existed = path.exists();
        if fs::metadata(&path).is_ok_and(|metadata| metadata.len() > MAX_DATABASE_BYTES) {
            return Err("Index cache exceeds the 256 MiB limit".into());
        }
        let mut connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(sql_error)?;
        connection
            .busy_timeout(Duration::from_millis(250))
            .map_err(sql_error)?;
        let integrity_deadline = Instant::now() + Duration::from_secs(2);
        connection
            .progress_handler(1000, Some(move || Instant::now() >= integrity_deadline))
            .map_err(sql_error)?;
        let valid = match cache_is_valid(&connection, root_id) {
            Ok(valid) => valid,
            Err(error) if is_corruption(&error) => false,
            Err(error) => return Err(sql_error(error)),
        };
        connection
            .progress_handler(0, None::<fn() -> bool>)
            .map_err(sql_error)?;
        if !valid {
            drop(connection);
            remove_cache(&path)?;
            connection = Connection::open_with_flags(
                &path,
                OpenFlags::SQLITE_OPEN_READ_WRITE
                    | OpenFlags::SQLITE_OPEN_CREATE
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )
            .map_err(sql_error)?;
            connection
                .busy_timeout(Duration::from_millis(250))
                .map_err(sql_error)?;
            connection.execute_batch(
                "PRAGMA page_size=4096;
                 PRAGMA journal_mode=DELETE;
                 PRAGMA max_page_count=65536;
                 CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                 CREATE TABLE documents(
                    id INTEGER PRIMARY KEY,document_id TEXT NOT NULL UNIQUE,
                    relative_path TEXT NOT NULL UNIQUE,title TEXT NOT NULL,
                    headings TEXT NOT NULL,body TEXT NOT NULL,
                    normalized_title TEXT NOT NULL,normalized_path TEXT NOT NULL,
                    normalized_headings TEXT NOT NULL,normalized_body TEXT NOT NULL,
                    source_hash TEXT,source_size INTEGER NOT NULL,modified_ns TEXT,
                    state TEXT NOT NULL CHECK(state IN ('ready','pending','unavailable','failed')),
                    truncated INTEGER NOT NULL CHECK(truncated IN (0,1)));
                 CREATE VIRTUAL TABLE documents_fts USING fts5(
                    normalized_title,normalized_path,normalized_headings,normalized_body,
                    content='documents',content_rowid='id',tokenize='trigram');
                 CREATE TRIGGER documents_insert AFTER INSERT ON documents BEGIN
                    INSERT INTO documents_fts(rowid,normalized_title,normalized_path,normalized_headings,normalized_body)
                    VALUES(new.id,new.normalized_title,new.normalized_path,new.normalized_headings,new.normalized_body);
                 END;
                 CREATE TRIGGER documents_delete AFTER DELETE ON documents BEGIN
                    INSERT INTO documents_fts(documents_fts,rowid,normalized_title,normalized_path,normalized_headings,normalized_body)
                    VALUES('delete',old.id,old.normalized_title,old.normalized_path,old.normalized_headings,old.normalized_body);
                 END;
                 CREATE TRIGGER documents_update AFTER UPDATE ON documents BEGIN
                    INSERT INTO documents_fts(documents_fts,rowid,normalized_title,normalized_path,normalized_headings,normalized_body)
                    VALUES('delete',old.id,old.normalized_title,old.normalized_path,old.normalized_headings,old.normalized_body);
                    INSERT INTO documents_fts(rowid,normalized_title,normalized_path,normalized_headings,normalized_body)
                    VALUES(new.id,new.normalized_title,new.normalized_path,new.normalized_headings,new.normalized_body);
                 END;"
            ).map_err(sql_error)?;
            for (key, value) in [
                ("root_id", root_id),
                ("schema_version", SCHEMA_VERSION),
                ("extractor_version", EXTRACTOR_VERSION),
                ("generation", "0"),
                ("expected_documents", "0"),
                ("complete", "0"),
                ("limited", "0"),
                ("building", "0"),
            ] {
                connection
                    .execute(
                        "INSERT INTO metadata(key,value) VALUES(?1,?2)",
                        params![key, value],
                    )
                    .map_err(sql_error)?;
            }
        }
        connection
            .execute_batch("PRAGMA journal_mode=DELETE; PRAGMA max_page_count=65536;")
            .map_err(sql_error)?;
        Ok(Self {
            connection,
            path,
            root_id: root_id.into(),
            rebuilt: existed && !valid,
        })
    }

    pub fn hash_for(&self, relative_path: &str) -> Result<Option<String>, String> {
        use rusqlite::OptionalExtension;
        let hash = self.connection.query_row(
            "SELECT substr(source_hash,1,65) FROM documents WHERE relative_path=?1 AND state='ready'",
            [relative_path], |row| row.get::<_, Option<String>>(0),
        ).optional().map_err(sql_error)?.flatten();
        if !valid_source_metadata(hash.as_deref(), None) {
            return Err("Invalid indexed source metadata; rebuild the index".into());
        }
        Ok(hash)
    }

    pub fn clear_for_rebuild(&mut self) -> Result<(), String> {
        let transaction = self.connection.transaction().map_err(sql_error)?;
        transaction
            .execute("DELETE FROM documents", [])
            .map_err(sql_error)?;
        bump_generation(&transaction)?;
        transaction.commit().map_err(sql_error)
    }

    pub fn apply(&mut self, records: &[DocumentRecord]) -> Result<u64, String> {
        if records.is_empty() {
            return self.generation();
        }
        for record in records {
            if !valid_relative_path(&record.relative_path) || record.source_size > i64::MAX as u64 {
                return Err("Invalid index document metadata".into());
            }
        }
        let transaction = self.connection.transaction().map_err(sql_error)?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO documents(document_id,relative_path,title,headings,body,
                normalized_title,normalized_path,normalized_headings,normalized_body,
                source_hash,source_size,modified_ns,state,truncated)
                VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
                ON CONFLICT(relative_path) DO UPDATE SET title=excluded.title,
                headings=excluded.headings,body=excluded.body,normalized_title=excluded.normalized_title,
                normalized_path=excluded.normalized_path,normalized_headings=excluded.normalized_headings,
                normalized_body=excluded.normalized_body,source_hash=excluded.source_hash,
                source_size=excluded.source_size,modified_ns=excluded.modified_ns,
                state=excluded.state,truncated=excluded.truncated"
            ).map_err(sql_error)?;
            for record in records {
                let ready = record.state == DocumentState::Ready;
                let title = if ready { record.title.as_str() } else { "" };
                let headings = if ready { record.headings.as_str() } else { "" };
                let body = if ready { record.body.as_str() } else { "" };
                statement
                    .execute(params![
                        document_id(&self.root_id, &record.relative_path),
                        record.relative_path,
                        title,
                        headings,
                        body,
                        normalize_search(title),
                        normalize_search(&record.relative_path),
                        normalize_search(headings),
                        normalize_search(body),
                        if ready {
                            record.source_hash.as_deref()
                        } else {
                            None
                        },
                        record.source_size as i64,
                        record.modified_ns,
                        record.state.as_str(),
                        ready && record.truncated,
                    ])
                    .map_err(sql_error)?;
            }
        }
        let next = bump_generation(&transaction)?;
        transaction.commit().map_err(sql_error)?;
        Ok(next)
    }

    pub fn begin_index(&mut self, expected: u64, limited: bool) -> Result<(), String> {
        let transaction = self.connection.transaction().map_err(sql_error)?;
        for (key, value) in [
            ("expected_documents", expected.to_string()),
            ("complete", "0".to_string()),
            ("limited", if limited { "1" } else { "0" }.to_string()),
            ("building", "1".to_string()),
        ] {
            transaction
                .execute(
                    "UPDATE metadata SET value=?2 WHERE key=?1",
                    params![key, value],
                )
                .map_err(sql_error)?;
        }
        transaction.commit().map_err(sql_error)
    }

    pub fn finish_index(&mut self, complete: bool) -> Result<(), String> {
        let transaction = self.connection.transaction().map_err(sql_error)?;
        transaction
            .execute(
                "UPDATE metadata SET value=?1 WHERE key='complete'",
                [if complete { "1" } else { "0" }],
            )
            .map_err(sql_error)?;
        transaction
            .execute("UPDATE metadata SET value='0' WHERE key='building'", [])
            .map_err(sql_error)?;
        transaction.commit().map_err(sql_error)
    }

    pub fn mark_pending(&mut self, paths: &BTreeSet<String>) -> Result<u64, String> {
        if paths.is_empty() {
            return self.generation();
        }
        let transaction = self.connection.transaction().map_err(sql_error)?;
        let mut changes = 0;
        for path in paths {
            changes += transaction
                .execute(
                    "UPDATE documents SET state=?2,title='',headings='',body='',
                normalized_title='',normalized_headings='',normalized_body='',source_hash=NULL,
                truncated=0 WHERE relative_path=?1 AND state!='pending'",
                    params![path, DocumentState::Pending.as_str()],
                )
                .map_err(sql_error)?;
        }
        let next = if changes > 0 {
            bump_generation(&transaction)?
        } else {
            generation(&transaction)?
        };
        transaction.commit().map_err(sql_error)?;
        Ok(next)
    }

    pub fn retain_paths(&mut self, paths: &BTreeSet<String>) -> Result<u64, String> {
        let transaction = self.connection.transaction().map_err(sql_error)?;
        let old_paths: Vec<String> = {
            let mut statement = transaction
                .prepare("SELECT substr(relative_path,1,32769) FROM documents")
                .map_err(sql_error)?;
            let collected = statement
                .query_map([], |row| row.get(0))
                .map_err(sql_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql_error)?;
            collected
        };
        let mut changes = 0;
        for path in old_paths {
            if !valid_relative_path(&path) {
                return Err("Invalid indexed document path; rebuild the index".into());
            }
            if !paths.contains(&path) {
                changes += transaction
                    .execute("DELETE FROM documents WHERE relative_path=?1", [path])
                    .map_err(sql_error)?;
            }
        }
        let next = if changes > 0 {
            bump_generation(&transaction)?
        } else {
            generation(&transaction)?
        };
        transaction.commit().map_err(sql_error)?;
        Ok(next)
    }

    pub fn counts(&self) -> Result<StoreCounts, String> {
        read_counts(&self.connection, &self.path)
    }

    pub fn inspect(cache_directory: &Path, root_id: &str) -> Result<(StoreCounts, u64), String> {
        let (connection, path) = open_readonly(cache_directory, root_id)?;
        Ok((read_counts(&connection, &path)?, generation(&connection)?))
    }

    pub fn generation(&self) -> Result<u64, String> {
        generation(&self.connection)
    }

    pub fn lookup(
        cache_directory: &Path,
        root_id: &str,
        id: &str,
    ) -> Result<Option<DocumentRecord>, String> {
        use rusqlite::OptionalExtension;
        if id.len() != 64
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Invalid index document identifier".into());
        }
        let (connection, _) = open_readonly(cache_directory, root_id)?;
        let record = connection.query_row(
            "SELECT substr(relative_path,1,32769),substr(title,1,512),substr(headings,1,8192),substr(body,1,65536),substr(source_hash,1,65),source_size,substr(modified_ns,1,40),truncated FROM documents WHERE document_id=?1 AND state='ready'",
            [id], |row| Ok(DocumentRecord { relative_path:row.get(0)?,title:row.get(1)?,headings:row.get(2)?,body:row.get(3)?,
                source_hash:row.get(4)?,source_size:row_u64(row, 5)?,modified_ns:row.get(6)?,truncated:row.get(7)?,state:DocumentState::Ready }),
        ).optional().map_err(sql_error)?;
        if let Some(record) = &record {
            if !valid_relative_path(&record.relative_path)
                || !valid_source_metadata(
                    record.source_hash.as_deref(),
                    record.modified_ns.as_deref(),
                )
                || document_id(root_id, &record.relative_path) != id
            {
                return Err("Invalid index document metadata".into());
            }
        }
        Ok(record)
    }

    pub fn search(
        cache_directory: &Path,
        root_id: &str,
        query: &str,
        limit: u32,
        offset: u32,
    ) -> Result<SearchPage, String> {
        Self::search_with_mode(
            cache_directory,
            root_id,
            query,
            limit,
            offset,
            SearchMode::And,
        )
    }

    pub fn search_with_mode(
        cache_directory: &Path,
        root_id: &str,
        query: &str,
        limit: u32,
        offset: u32,
        mode: SearchMode,
    ) -> Result<SearchPage, String> {
        Self::search_with_scope(cache_directory, root_id, query, limit, offset, mode, None)
    }

    pub fn search_with_scope(
        cache_directory: &Path,
        root_id: &str,
        query: &str,
        limit: u32,
        offset: u32,
        mode: SearchMode,
        scope: Option<&str>,
    ) -> Result<SearchPage, String> {
        if let Some(scope) = scope {
            if !valid_relative_path(scope) || crate::knowledge::validate_relative(scope).is_err() {
                return Err("Invalid search folder scope".into());
            }
        }
        if limit == 0 || limit > MAX_LIMIT || offset > MAX_OFFSET {
            return Err("Search pagination limit exceeded".into());
        }
        if query.chars().count() > MAX_QUERY_CHARS {
            return Err("Search query exceeds 256 characters".into());
        }
        let normalized_query = normalize_search(query);
        if normalized_query.chars().count() > MAX_QUERY_CHARS {
            return Err("Normalized search query exceeds 256 characters".into());
        }
        let terms: Vec<_> = normalized_query.split_whitespace().collect();
        if terms.len() > MAX_TERMS {
            return Err("Search supports at most eight terms".into());
        }
        let deadline = Instant::now() + Duration::from_millis(200);
        let (connection, _) = open_readonly(cache_directory, root_id)?;
        let current_generation = generation(&connection)?;
        if terms.is_empty() {
            return Ok(SearchPage {
                request_revision: 0,
                generation: current_generation,
                hits: vec![],
                has_more: false,
                normalized_query,
            });
        }
        let long_terms: Vec<_> = terms
            .iter()
            .filter(|term| term.chars().count() >= 3)
            .collect();
        let mut bindings = Vec::<rusqlite::types::Value>::new();
        let mut sql = String::from("SELECT substr(d.document_id,1,65),substr(d.relative_path,1,32769),substr(d.title,1,512),substr(d.body,1,65536),d.truncated,substr(d.source_hash,1,65),d.source_size,substr(d.modified_ns,1,40) FROM documents d ");
        // A trigram filter cannot cover the short-only branch of mixed OR.
        // Literal scanning is already required by that branch; avoid losing it.
        if !long_terms.is_empty() && (mode == SearchMode::And || long_terms.len() == terms.len()) {
            sql.push_str(
                "JOIN documents_fts ON documents_fts.rowid=d.id WHERE documents_fts MATCH ? AND ",
            );
            let expression = long_terms
                .iter()
                .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
                .collect::<Vec<_>>()
                .join(mode.operator());
            bindings.push(expression.into());
        } else {
            sql.push_str("WHERE ");
        }
        if let Some(scope) = scope {
            // BINARY bounds select exactly the literal `folder/` prefix without
            // LIKE wildcards or case folding; the path index remains usable.
            sql.push_str(
                "d.relative_path >= ? COLLATE BINARY AND d.relative_path < ? COLLATE BINARY AND ",
            );
            bindings.push(format!("{scope}/").into());
            bindings.push(format!("{scope}0").into());
        }
        sql.push_str("d.state='ready' AND (");
        for (index, term) in terms.iter().enumerate() {
            if index > 0 {
                sql.push_str(mode.operator());
            }
            sql.push_str("(instr(d.normalized_title,?)>0 OR instr(d.normalized_path,?)>0 OR instr(d.normalized_headings,?)>0 OR instr(d.normalized_body,?)>0)");
            for _ in 0..4 {
                bindings.push((*term).to_string().into());
            }
        }
        sql.push_str(") ORDER BY d.relative_path COLLATE BINARY LIMIT ? OFFSET ?");
        bindings.push(i64::from(limit + 1).into());
        bindings.push(i64::from(offset).into());
        let mut statement = connection.prepare(&sql).map_err(sql_error)?;
        let mut hits = statement
            .query_map(params_from_iter(bindings), |row| {
                let body: String = row.get(3)?;
                let title: String = row.get(2)?;
                Ok(SearchHit {
                    document_id: row.get(0)?,
                    relative_path: row.get(1)?,
                    title,
                    snippet: body,
                    title_matches: vec![],
                    snippet_matches: vec![],
                    truncated: row.get(4)?,
                    indexed_source_hash: row.get(5)?,
                    indexed_source_size: row_u64(row, 6)?,
                    indexed_modified_ns: row.get(7)?,
                })
            })
            .map_err(sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_error)?;
        let has_more = hits.len() > limit as usize;
        hits.truncate(limit as usize);
        for hit in &mut hits {
            if !valid_relative_path(&hit.relative_path)
                || !valid_source_metadata(
                    hit.indexed_source_hash.as_deref(),
                    hit.indexed_modified_ns.as_deref(),
                )
                || crate::knowledge::validate_relative(&hit.relative_path).is_err()
                || !crate::knowledge::is_html(&hit.relative_path)
                || document_id(root_id, &hit.relative_path) != hit.document_id
            {
                return Err("Invalid indexed document metadata; rebuild the index".into());
            }
            hit.title_matches = highlight::matches(&hit.title, &terms);
            (hit.snippet, hit.snippet_matches) = highlight::snippet(&hit.snippet, &terms);
            // Include bounded display mapping in the existing query time budget.
            if Instant::now() >= deadline {
                return Err("Search execution time limit exceeded".into());
            }
        }
        Ok(SearchPage {
            request_revision: 0,
            generation: current_generation,
            hits,
            has_more,
            normalized_query,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const ROOT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OTHER_ROOT: &str = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

    fn record(path: &str, body: &str) -> DocumentRecord {
        DocumentRecord {
            relative_path: path.into(),
            title: "資料".into(),
            headings: "概要".into(),
            body: body.into(),
            source_hash: Some(format!("{:x}", Sha256::digest(body.as_bytes()))),
            source_size: body.len() as u64,
            modified_ns: Some("123456789".into()),
            state: DocumentState::Ready,
            truncated: false,
        }
    }

    fn search(directory: &Path, query: &str) -> SearchPage {
        Store::search(directory, ROOT, query, 100, 0).unwrap()
    }

    #[test]
    fn folder_scope_is_literal_recursive_and_applied_before_pagination() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        store
            .apply(&[
                record("root.html", "東京都 rust"),
                record("foo/a.html", "東京"),
                record("foo/deep/b.html", "東京都 rust"),
                record("foo/z.html", "rust"),
                record("foobar/a.html", "東京都 rust"),
                record("Foo/a.html", "東京都 rust"),
                record("100%_計画/a.html", "東京都 rust"),
                record("100XX計画/a.html", "東京都 rust"),
                record("資料/深い/a.html", "東京都 rust"),
                record("x' OR 1=1 --/a.html", "東京都 rust"),
            ])
            .unwrap();
        let scoped = |folder, query, mode, limit, offset| {
            Store::search_with_scope(
                directory.path(),
                ROOT,
                query,
                limit,
                offset,
                mode,
                Some(folder),
            )
            .unwrap()
        };
        let first = scoped("foo", "京 rust", SearchMode::Or, 2, 0);
        assert_eq!(
            first
                .hits
                .iter()
                .map(|hit| hit.relative_path.as_str())
                .collect::<Vec<_>>(),
            ["foo/a.html", "foo/deep/b.html"]
        );
        assert!(first.has_more);
        assert_eq!(first.hits[1].snippet_matches.len(), 2);
        let last = scoped("foo", "京 rust", SearchMode::Or, 2, 2);
        assert_eq!(last.hits.len(), 1);
        assert_eq!(last.hits[0].relative_path, "foo/z.html");
        assert!(!last.has_more);
        assert_eq!(first.generation, last.generation);
        assert_eq!(
            scoped("foo", "東京都 rust", SearchMode::And, 20, 0)
                .hits
                .len(),
            1
        );
        for folder in ["100%_計画", "資料/深い", "x' OR 1=1 --", "Foo"] {
            let page = scoped(folder, "東京都 rust", SearchMode::And, 20, 0);
            assert_eq!(page.hits.len(), 1, "{folder}");
            assert_eq!(page.hits[0].relative_path, format!("{folder}/a.html"));
        }
        assert!(scoped("empty", "東京", SearchMode::And, 20, 0)
            .hits
            .is_empty());
        assert_eq!(search(directory.path(), "rust").hits.len(), 9);
        for folder in [
            "",
            "../foo",
            "/foo",
            "foo/../deep",
            "foo/",
            "C:/foo",
            "foo\\deep",
        ] {
            assert!(
                Store::search_with_scope(
                    directory.path(),
                    ROOT,
                    "",
                    20,
                    0,
                    SearchMode::And,
                    Some(folder)
                )
                .is_err(),
                "{folder}"
            );
        }
    }

    #[test]
    fn japanese_trigram_short_terms_and_nfkc_are_literal_and() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        store
            .apply(&[
                record("b.html", "東京都の開発 ＲＵＳＴ"),
                record("a.html", "京都の計画 rust"),
            ])
            .unwrap();
        assert_eq!(search(directory.path(), "東京都").hits.len(), 1);
        assert_eq!(search(directory.path(), "京都").hits.len(), 2);
        assert_eq!(search(directory.path(), "rust 京都").hits.len(), 2);
        assert_eq!(search(directory.path(), "rust 開発").hits.len(), 1);
        assert_eq!(search(directory.path(), "計").hits.len(), 1);
        assert_eq!(
            search(directory.path(), "  ＲＵＳＴ  ").normalized_query,
            "rust"
        );
        assert!(search(directory.path(), "rust OR missing").hits.is_empty());
    }

    #[test]
    fn or_keeps_short_only_matches_cross_fields_and_stable_pages() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        let mut fields = record("c.html", "無関係");
        fields.title = "ＲＵＳＴ".into();
        fields.headings = "京都".into();
        store
            .apply(&[
                record("a.html", "京"),
                record("b.html", "rust 東京都"),
                fields,
                record("d.html", "無関係"),
                record("京都.html", "無関係"),
            ])
            .unwrap();
        for (query, expected) in [
            ("rust 京", vec!["a.html", "b.html", "c.html", "京都.html"]),
            ("ＲＵＳＴ 東京都", vec!["b.html", "c.html"]),
            (
                "京 無関係",
                vec!["a.html", "b.html", "c.html", "d.html", "京都.html"],
            ),
            ("不存在 rust", vec!["b.html", "c.html"]),
            ("rust rust", vec!["b.html", "c.html"]),
            ("missing missing2", vec![]),
        ] {
            let page =
                Store::search_with_mode(directory.path(), ROOT, query, 100, 0, SearchMode::Or)
                    .unwrap();
            let paths: Vec<_> = page
                .hits
                .iter()
                .map(|hit| hit.relative_path.as_str())
                .collect();
            assert_eq!(paths, expected, "{query}");
        }
        assert_eq!(search(directory.path(), "rust 京都").hits.len(), 2);
        let first =
            Store::search_with_mode(directory.path(), ROOT, "京 rust", 2, 0, SearchMode::Or)
                .unwrap();
        let second =
            Store::search_with_mode(directory.path(), ROOT, "京 rust", 2, 2, SearchMode::Or)
                .unwrap();
        assert!(first.has_more && !second.has_more);
        assert_eq!(first.hits[0].relative_path, "a.html");
        assert_eq!(second.hits[0].relative_path, "c.html");
        for query in ["' OR 1=1 --", "a b c d e f g h i"] {
            let result =
                Store::search_with_mode(directory.path(), ROOT, query, 20, 0, SearchMode::Or);
            if query.starts_with('a') {
                assert!(result.is_err());
            } else {
                assert!(result.unwrap().hits.is_empty());
            }
        }
        assert!(serde_json::from_str::<SearchMode>("\"xor\"").is_err());
    }

    #[test]
    fn result_ranges_and_context_use_the_same_literal_terms() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        let mut item = record(
            "path-only.html",
            &format!("{} Cafe\u{301} ｶﾞ", "前".repeat(600)),
        );
        item.title = "😀ＲＵＳＴ <script>".into();
        item.headings = "heading-only".into();
        store.apply(&[item]).unwrap();
        let page = search(directory.path(), "rust café ガ");
        let hit = &page.hits[0];
        assert_eq!(hit.title_matches, vec![MatchRange { start: 1, end: 5 }]);
        assert_eq!(hit.snippet_matches.len(), 2);
        assert!(hit.snippet.contains("Cafe\u{301}"));
        assert!(hit.snippet.chars().count() <= 240);
        for query in ["path-only", "heading-only"] {
            let hit = search(directory.path(), query).hits.remove(0);
            assert!(hit.title_matches.is_empty() && hit.snippet_matches.is_empty());
        }
        assert!(
            search(directory.path(), "<script>").hits[0]
                .title_matches
                .len()
                == 1
        );
    }

    #[test]
    fn quotes_sql_fts_operators_are_never_executed() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        store
            .apply(&[record("a.html", "a\"b ' OR 1=1 -- NEAR(foo) x:y ***")])
            .unwrap();
        for query in ["a\"b", "'", "NEAR(foo)", "x:y", "***"] {
            assert_eq!(search(directory.path(), query).hits.len(), 1, "{query}");
            assert_eq!(
                Store::search_with_mode(
                    directory.path(),
                    ROOT,
                    &format!("{query} missing"),
                    20,
                    0,
                    SearchMode::Or
                )
                .unwrap()
                .hits
                .len(),
                1,
                "{query}"
            );
        }
        assert!(search(directory.path(), "\" OR \"missing").hits.is_empty());
        assert_eq!(store.counts().unwrap().indexed, 1);
    }

    #[test]
    fn fixed_japanese_quality_table_and_path_order_are_stable() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        store
            .apply(&[
                record(
                    "b.html",
                    "東京都ひらがなカタカナ ABC Cafe\u{301} a\"b x:y 日本語検索",
                ),
                record("a.html", "京都 ｶﾀｶﾅ ＡＢＣ"),
                record("資料/日本語.html", "記号だけ *** NEAR(foo)"),
            ])
            .unwrap();
        let table: &[(&str, &[&str])] = &[
            ("京", &["a.html", "b.html"]),
            ("東京", &["b.html"]),
            ("日本語", &["b.html", "資料/日本語.html"]),
            ("ひらがな", &["b.html"]),
            ("カタカナ", &["a.html", "b.html"]),
            ("abc", &["a.html", "b.html"]),
            ("ＣＡＦÉ", &["b.html"]),
            ("京都 abc", &["a.html", "b.html"]),
            ("a\"b", &["b.html"]),
            ("x:y", &["b.html"]),
            ("***", &["資料/日本語.html"]),
            ("NEAR(foo)", &["資料/日本語.html"]),
            ("' OR 1=1 --", &[]),
            ("ひらがな カタカナ", &["b.html"]),
        ];
        for (query, expected) in table {
            let actual: Vec<_> = search(directory.path(), query)
                .hits
                .into_iter()
                .map(|hit| hit.relative_path)
                .collect();
            assert_eq!(actual, *expected, "{query}");
        }
    }

    #[test]
    fn cached_path_and_document_identifier_tampering_are_rejected() {
        for path in ["../outside.html", "safe.html"] {
            let directory = TempDir::new().unwrap();
            let mut store = Store::open(directory.path(), ROOT).unwrap();
            store.apply(&[record("a.html", "日本語")]).unwrap();
            store
                .connection
                .execute(
                    "UPDATE documents SET relative_path=?1, document_id=?2",
                    rusqlite::params![path, "0".repeat(64)],
                )
                .unwrap();
            assert!(Store::search(directory.path(), ROOT, "日本語", 20, 0).is_err());
        }
    }

    #[test]
    fn oversized_or_invalid_cached_source_metadata_fails_without_writes() {
        for (field, value) in [
            ("source_hash", "f".repeat(1_048_576)),
            ("source_hash", "z".repeat(64)),
            ("modified_ns", "9".repeat(1000)),
        ] {
            let directory = TempDir::new().unwrap();
            let mut store = Store::open(directory.path(), ROOT).unwrap();
            store.apply(&[record("a.html", "日本語")]).unwrap();
            let id = document_id(ROOT, "a.html");
            // Field names are fixed test constants; values remain bound.
            store
                .connection
                .execute(&format!("UPDATE documents SET {field}=?1"), [value])
                .unwrap();
            let path = store.path.clone();
            let before = fs::read(&path).unwrap();
            assert!(Store::search(directory.path(), ROOT, "日本語", 20, 0).is_err());
            assert!(Store::lookup(directory.path(), ROOT, &id).is_err());
            if field == "source_hash" {
                assert!(store.hash_for("a.html").is_err());
            }
            assert_eq!(fs::read(path).unwrap(), before);
        }
    }

    #[test]
    fn upsert_delete_move_and_failure_remove_stale_results() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        assert_eq!(store.apply(&[record("a.html", "before")]).unwrap(), 1);
        let first_id = search(directory.path(), "before").hits[0]
            .document_id
            .clone();
        assert_eq!(store.apply(&[record("a.html", "after")]).unwrap(), 2);
        assert!(search(directory.path(), "before").hits.is_empty());
        assert_eq!(
            search(directory.path(), "after").hits[0].document_id,
            first_id
        );
        store.apply(&[record("moved.html", "after")]).unwrap();
        store
            .retain_paths(&BTreeSet::from(["moved.html".into()]))
            .unwrap();
        let page = search(directory.path(), "after");
        assert_eq!(page.hits.len(), 1);
        assert_ne!(page.hits[0].document_id, first_id);
        let mut failure = record("moved.html", "after");
        failure.state = DocumentState::Unavailable;
        store.apply(&[failure]).unwrap();
        assert!(search(directory.path(), "after").hits.is_empty());
        assert!(store.hash_for("moved.html").unwrap().is_none());
        assert_eq!(store.counts().unwrap().unavailable, 1);
    }

    #[test]
    fn pending_clears_search_and_generation_changes_only_when_needed() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        store.apply(&[record("a.html", "content")]).unwrap();
        let paths = BTreeSet::from(["a.html".into()]);
        assert_eq!(store.mark_pending(&paths).unwrap(), 2);
        assert!(search(directory.path(), "content").hits.is_empty());
        assert_eq!(store.mark_pending(&paths).unwrap(), 2);
        assert_eq!(store.retain_paths(&paths).unwrap(), 2);
        assert_eq!(store.counts().unwrap().pending, 1);
    }

    #[test]
    fn root_ids_bind_database_document_ids_and_lookup() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        store.apply(&[record("a.html", "hello")]).unwrap();
        let id = search(directory.path(), "hello").hits[0]
            .document_id
            .clone();
        assert_eq!(
            Store::lookup(directory.path(), ROOT, &id)
                .unwrap()
                .unwrap()
                .relative_path,
            "a.html"
        );
        let mut other = Store::open(directory.path(), OTHER_ROOT).unwrap();
        other.apply(&[record("a.html", "hello")]).unwrap();
        assert!(Store::lookup(directory.path(), OTHER_ROOT, &id)
            .unwrap()
            .is_none());
        assert_ne!(
            document_id(ROOT, "a.html"),
            document_id(OTHER_ROOT, "a.html")
        );
        assert!(Store::open(directory.path(), "../other").is_err());
        assert!(Store::lookup(directory.path(), ROOT, "../other").is_err());
    }

    #[test]
    fn corrupt_and_obsolete_caches_are_rebuilt_without_source_writes() {
        let directory = TempDir::new().unwrap();
        let source = directory.path().join("source.html");
        fs::write(&source, "immutable source").unwrap();
        let path = database_path(directory.path(), ROOT).unwrap();
        fs::write(&path, b"not a database").unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        assert!(store.rebuilt);
        store.apply(&[record("a.html", "hello")]).unwrap();
        store
            .connection
            .execute(
                "UPDATE metadata SET value='obsolete' WHERE key='extractor_version'",
                [],
            )
            .unwrap();
        drop(store);
        let store = Store::open(directory.path(), ROOT).unwrap();
        assert!(store.rebuilt);
        assert_eq!(store.counts().unwrap().indexed, 0);
        assert_eq!(fs::read_to_string(source).unwrap(), "immutable source");
    }

    #[test]
    fn missing_fts_postings_rebuild_external_content_cache() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        store.apply(&[record("a.html", "searchable")]).unwrap();
        store.connection.execute("DELETE FROM documents_fts WHERE rowid=(SELECT id FROM documents WHERE relative_path='a.html')", []).unwrap();
        assert!(search(directory.path(), "searchable").hits.is_empty());
        drop(store);
        let store = Store::open(directory.path(), ROOT).unwrap();
        assert!(store.rebuilt);
        assert_eq!(store.counts().unwrap().indexed, 0);
    }

    #[test]
    fn missing_readonly_database_is_not_created_and_versions_are_checked() {
        let directory = TempDir::new().unwrap();
        assert!(Store::search(directory.path(), ROOT, "hello", 10, 0).is_err());
        assert!(!database_path(directory.path(), ROOT).unwrap().exists());
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        store.apply(&[record("a.html", "hello")]).unwrap();
        store
            .connection
            .execute("UPDATE metadata SET value='other' WHERE key='root_id'", [])
            .unwrap();
        assert!(Store::search(directory.path(), ROOT, "hello", 10, 0).is_err());
    }

    #[test]
    fn ordered_pagination_and_plain_unicode_snippets_are_bounded() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        store
            .apply(&[
                record("z.html", &"日本語".repeat(150)),
                record("a.html", "日本語 <plain> & text"),
            ])
            .unwrap();
        let page = Store::search(directory.path(), ROOT, "日本語", 1, 0).unwrap();
        assert!(page.has_more);
        assert_eq!(page.hits[0].relative_path, "a.html");
        let page = Store::search(directory.path(), ROOT, "日本語", 1, 1).unwrap();
        assert!(!page.has_more);
        assert_eq!(page.hits[0].snippet.chars().count(), 240);
        assert!(Store::search(directory.path(), ROOT, "x", 0, 0).is_err());
        assert!(Store::search(directory.path(), ROOT, "x", 101, 0).is_err());
        assert!(Store::search(directory.path(), ROOT, "x", 10, 10_001).is_err());
        assert!(Store::search(directory.path(), ROOT, &"x".repeat(257), 10, 0).is_err());
        assert!(Store::search(directory.path(), ROOT, "a b c d e f g h i", 10, 0).is_err());
    }

    #[test]
    fn invalid_paths_are_rejected_transactionally() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        for path in [
            "../a.html",
            "/a.html",
            "x/../a.html",
            "x\\a.html",
            "C:a.html",
            "x//a.html",
        ] {
            assert!(store
                .apply(&[record("valid.html", "valid"), record(path, "bad")])
                .is_err());
            assert_eq!(store.generation().unwrap(), 0);
            assert_eq!(store.counts().unwrap().indexed, 0);
        }
    }

    #[test]
    fn exclusive_writer_lock_does_not_rebuild_database() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        store.apply(&[record("a.html", "hello")]).unwrap();
        store.connection.execute_batch("BEGIN EXCLUSIVE").unwrap();
        assert!(Store::search(directory.path(), ROOT, "hello", 10, 0).is_err());
        assert!(Store::open(directory.path(), ROOT).is_err());
        store.connection.execute_batch("ROLLBACK").unwrap();
        assert_eq!(search(directory.path(), "hello").hits.len(), 1);
    }

    #[test]
    fn index_status_survives_interruption_without_changing_content_generation() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        let counts = store.counts().unwrap();
        assert_eq!(counts.expected_documents, 0);
        assert!(!counts.complete && !counts.building && !counts.limited);
        store.apply(&[record("a.html", "indexed")]).unwrap();
        store.begin_index(2, false).unwrap();
        drop(store);
        let (counts, version) = Store::inspect(directory.path(), ROOT).unwrap();
        assert_eq!(version, 1);
        assert_eq!(counts.expected_documents, 2);
        assert!(counts.building && !counts.complete && !counts.limited);
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        assert!(!store.rebuilt);
        store.finish_index(true).unwrap();
        let (counts, version) = Store::inspect(directory.path(), ROOT).unwrap();
        assert_eq!(version, 1);
        assert!(counts.complete && !counts.building);
        store.begin_index(3, true).unwrap();
        store.finish_index(false).unwrap();
        let counts = store.counts().unwrap();
        assert!(counts.limited && !counts.complete && !counts.building);
        assert_eq!(counts.expected_documents, 3);
        assert_eq!(store.generation().unwrap(), 1);
    }

    #[test]
    fn missing_or_invalid_status_metadata_requires_rebuild() {
        let directory = TempDir::new().unwrap();
        for mutation in [
            "DELETE FROM metadata WHERE key='building'",
            "UPDATE metadata SET value='invalid' WHERE key='expected_documents'",
            "UPDATE metadata SET value='2' WHERE key='complete'",
        ] {
            let mut store = Store::open(directory.path(), ROOT).unwrap();
            store.apply(&[record("a.html", "indexed")]).unwrap();
            store.connection.execute(mutation, []).unwrap();
            drop(store);
            assert!(Store::inspect(directory.path(), ROOT).is_err());
            let store = Store::open(directory.path(), ROOT).unwrap();
            assert!(store.rebuilt);
            assert_eq!(store.generation().unwrap(), 0);
            assert!(!store.counts().unwrap().complete);
        }
    }

    #[test]
    fn readonly_status_and_storage_full_preserve_previous_generation() {
        let directory = TempDir::new().unwrap();
        let mut store = Store::open(directory.path(), ROOT).unwrap();
        let mut pending = record("pending.html", "discarded");
        pending.state = DocumentState::Pending;
        let mut failed = record("failed.html", "discarded");
        failed.state = DocumentState::Failed;
        store
            .apply(&[record("a.html", "existing"), pending, failed])
            .unwrap();
        let (counts, version) = Store::inspect(directory.path(), ROOT).unwrap();
        assert_eq!(version, 1);
        assert_eq!((counts.indexed, counts.pending, counts.failed), (1, 1, 1));
        assert!(counts.database_bytes > 0);
        assert!(search(directory.path(), "discarded").hits.is_empty());
        let pages: i64 = store
            .connection
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap();
        store
            .connection
            .pragma_update(None, "max_page_count", pages)
            .unwrap();
        assert!(store
            .apply(&[record("new.html", &"大きな文書".repeat(12_000))])
            .is_err());
        assert_eq!(store.generation().unwrap(), 1);
        assert_eq!(store.counts().unwrap().indexed, 1);
        assert_eq!(search(directory.path(), "existing").hits.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn cache_leaf_sidecar_and_directory_links_are_rejected() {
        use std::os::unix::fs::symlink;
        let directory = TempDir::new().unwrap();
        let target = directory.path().join("target");
        fs::write(&target, "untouched").unwrap();
        let path = database_path(directory.path(), ROOT).unwrap();
        symlink(&target, &path).unwrap();
        assert!(Store::open(directory.path(), ROOT).is_err());
        assert!(Store::search(directory.path(), ROOT, "x", 1, 0).is_err());
        fs::remove_file(&path).unwrap();
        symlink(&target, cache_files(&path)[1].clone()).unwrap();
        assert!(Store::open(directory.path(), ROOT).is_err());
        let link = directory.path().join("linked-cache");
        symlink(directory.path(), &link).unwrap();
        assert!(Store::open(&link, ROOT).is_err());
        assert_eq!(fs::read_to_string(target).unwrap(), "untouched");
    }
}
