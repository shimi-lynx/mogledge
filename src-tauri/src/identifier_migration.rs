//! Opt-in identifier migration. Call before creating any settings or state DB.
//! Originals remain the rollback copy; only an allowlisted, verified bundle is published.
use cap_std::fs::{Dir, OpenOptions};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    time::Duration,
};

pub const LEGACY_IDENTIFIER: &str = "com.shimilynx.aiwiki"; // Compatibility read only.
pub const CURRENT_IDENTIFIER: &str = "com.shimilynx.myknowledge";
const BUNDLE: &str = "identifier-migration-v1";
const STAGING_PREFIX: &str = "migration-staging-";
const MAX_JSON_BYTES: u64 = 1024 * 1024;
const MAX_ORDER_FILES: usize = 4096;
// Schema v1 supports raised logical budgets while physical slack remains bounded.
const MAX_DB_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Locations {
    old_config: PathBuf,
    old_local: PathBuf,
    new_config: PathBuf,
    new_local: PathBuf,
    legacy: String,
    current: String,
}
impl Locations {
    /// Bases and identifiers come from trusted Native configuration, never document IPC.
    /// Native QA must pass two dedicated identifiers and temporary OS base directories.
    pub fn new(
        config_base: &Path,
        local_base: &Path,
        legacy: &str,
        current: &str,
    ) -> Result<Self, MigrationError> {
        let valid = |id: &str| {
            id.len() <= 128
                && id.contains('.')
                && !id.starts_with('.')
                && !id.ends_with('.')
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        };
        if !valid(legacy) || !valid(current) || legacy.eq_ignore_ascii_case(current) {
            return Err(MigrationError::UnsafePath);
        }
        check_absolute(config_base)?;
        check_absolute(local_base)?;
        if config_base != local_base
            && (config_base.starts_with(local_base) || local_base.starts_with(config_base))
        {
            return Err(MigrationError::UnsafePath);
        }
        Ok(Self {
            old_config: config_base.join(legacy),
            old_local: local_base.join(legacy),
            new_config: config_base.join(current),
            new_local: local_base.join(current),
            legacy: legacy.into(),
            current: current.into(),
        })
    }
    fn ordinary_paths(&self) -> ActivePaths {
        ActivePaths {
            settings: self.new_config.join("settings.json"),
            document_state: self.new_local.join("document-state"),
            search_index: self.new_local.join("search-index"),
        }
    }
    fn migrated_paths(&self) -> ActivePaths {
        let bundle = self.new_local.join(BUNDLE);
        ActivePaths {
            settings: bundle.join("config/settings.json"),
            document_state: bundle.join("document-state"),
            search_index: self.new_local.join("search-index"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActivePaths {
    pub settings: PathBuf,
    pub document_state: PathBuf,
    pub search_index: PathBuf,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Inspect,
    /// The user explicitly requested migration and confirmed all legacy apps are closed.
    ImportAfterLegacyExit,
    /// Explicit choice for an existing new profile; does not import, merge or delete anything.
    KeepCurrent,
}
#[derive(Debug)]
pub struct PreparedProfile {
    pub paths: ActivePaths,
    // Keep alive for the entire Native runtime, including all DB connections.
    _lease: File,
}
#[derive(Debug)]
pub enum Startup {
    Ready(PreparedProfile),
    NeedsConsent,
    Conflict,
    /// Published and ordinary current profiles coexist. KeepCurrent cannot resolve this.
    ConflictingCurrentProfiles,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationError {
    UnsafePath,
    Unavailable,
    Busy,
    Corrupt,
    UnsupportedDatabase,
    Interrupted,
    SourceChanged,
    CapacityExceeded,
    ResourceUnavailable,
}
impl MigrationError {
    /// Fixed messages deliberately omit personal paths and document contents.
    pub fn message(self) -> &'static str {
        match self {
            Self::UnsafePath => "移行先または元データが通常のローカル保存先ではありません。リンクを使わない保存先を確認してください。",
            Self::Unavailable => "データを移行できません。アクセス権と空き容量を確認し、旧版を終了して再試行してください。元データは保持しています。",
            Self::Busy => "保存領域が使用中です。旧版と他の新版を終了して再試行してください。",
            Self::Corrupt => "保存データの整合性を確認できません。空の状態で起動せず、旧版またはバックアップで確認してください。",
            Self::UnsupportedDatabase => "未対応のSQLite形式またはjournalが見つかりました。旧版で正常終了させてから再試行してください。",
            Self::Interrupted => "未完了の移行データがあります。元データを確認して復旧手順に従ってください。",
            Self::CapacityExceeded => "保存容量がSQLiteまたは保存先の技術上限を超えました。元データは保持しています。",
            Self::ResourceUnavailable => "保存処理に必要な資源を確保できません。元データは保持しています。",
            Self::SourceChanged => "移行中に元データまたは保存先が変わりました。すべての旧版を終了して再試行してください。",
        }
    }
}
impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}
impl std::error::Error for MigrationError {}
impl From<io::Error> for MigrationError {
    fn from(error: io::Error) -> Self {
        if error.kind() == io::ErrorKind::WouldBlock {
            Self::Busy
        } else {
            Self::Unavailable
        }
    }
}
fn sql_error(error: rusqlite::Error) -> MigrationError {
    match error.sqlite_error_code() {
        Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) => {
            MigrationError::Busy
        }
        Some(rusqlite::ErrorCode::OperationInterrupted) => MigrationError::Interrupted,
        Some(rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase) => {
            MigrationError::Corrupt
        }
        Some(rusqlite::ErrorCode::TooBig | rusqlite::ErrorCode::DiskFull) => {
            MigrationError::CapacityExceeded
        }
        Some(rusqlite::ErrorCode::OutOfMemory) => MigrationError::ResourceUnavailable,
        _ => MigrationError::Unavailable,
    }
}

fn check_absolute(path: &Path) -> Result<(), MigrationError> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    {
        return Err(MigrationError::UnsafePath);
    }
    #[cfg(windows)]
    crate::knowledge::validate_cache_path(path).map_err(|_| MigrationError::UnsafePath)?;
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(meta) if crate::write_fs::rejected_link(&meta) || !meta.is_dir() => {
                return Err(MigrationError::UnsafePath);
            }
            Ok(_) => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
pub(crate) fn directory(path: &Path, create: bool) -> Result<Option<Dir>, MigrationError> {
    check_absolute(path)?;
    #[cfg(unix)]
    {
        // Resolve each component relative to an open parent with NOFOLLOW. An ancestor
        // substituted after preflight cannot redirect the copy to an external directory.
        let mut dir = Dir::open_ambient_dir("/", cap_std::ambient_authority())?;
        for component in path.components() {
            let Component::Normal(name) = component else {
                continue;
            };
            let name = name.to_str().ok_or(MigrationError::UnsafePath)?;
            let file = match crate::write_fs::open_at(&dir, name, true, false, false) {
                Ok(file) => file,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    if !create {
                        return Ok(None);
                    }
                    match crate::write_fs::mkdir(&dir, name) {
                        Ok(()) => (),
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                        Err(error) => return Err(error.into()),
                    }
                    crate::write_fs::open_at(&dir, name, true, false, false)?
                }
                Err(error) => return Err(error.into()),
            };
            dir = Dir::from_std_file(file);
        }
        Ok(Some(dir))
    }
    #[cfg(windows)]
    {
        if create {
            std::fs::create_dir_all(path)?;
        }
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
            Ok(_) => (),
        }
        check_absolute(path)?;
        let (_, dir) = crate::knowledge::open_root(path).map_err(|_| MigrationError::UnsafePath)?;
        Ok(Some(dir.try_clone()?))
    }
}
fn exists(parent: &Dir, name: &str) -> Result<bool, MigrationError> {
    match crate::write_fs::entry_is_directory(parent, name) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(MigrationError::UnsafePath),
    }
}
pub(crate) fn read_file(parent: &Dir, name: &str, write: bool) -> Result<File, MigrationError> {
    if crate::write_fs::entry_is_directory(parent, name)? {
        return Err(MigrationError::UnsafePath);
    }
    let mut options = OpenOptions::new();
    options.read(true).write(write);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(
            (rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32,
        );
    }
    #[cfg(windows)]
    {
        use cap_std::fs::OpenOptionsExt;
        options.custom_flags(0x00200000 | 0x00100000).share_mode(3);
    }
    let file = parent.open_with(name, &options)?.into_std();
    let meta = file.metadata()?;
    if crate::write_fs::rejected_link(&meta) || !meta.is_file() {
        return Err(MigrationError::UnsafePath);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err(MigrationError::UnsafePath);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                FileStandardInfo, GetFileInformationByHandleEx, FILE_STANDARD_INFO,
            },
        };
        let mut info = FILE_STANDARD_INFO::default();
        // SAFETY: the live file handle and correctly sized/aligned output remain valid.
        unsafe {
            GetFileInformationByHandleEx(
                HANDLE(file.as_raw_handle()),
                FileStandardInfo,
                (&mut info as *mut FILE_STANDARD_INFO).cast(),
                std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
            )
        }
        .map_err(|_| MigrationError::Unavailable)?;
        if info.NumberOfLinks != 1 {
            return Err(MigrationError::UnsafePath);
        }
    }
    Ok(file)
}
// QA marker uses the same bounded, no-follow, single-link reader as migration payloads.
#[cfg(feature = "e2e")]
pub(crate) fn read_qa_marker(parent: &Dir) -> Result<Vec<u8>, MigrationError> {
    json_file(parent, ".profile-fixture.json")
}
#[cfg(feature = "e2e")]
pub(crate) fn read_qa_settings(parent: &Dir) -> Result<Vec<u8>, MigrationError> {
    json_file(parent, "settings.json")
}
fn json_file(parent: &Dir, name: &str) -> Result<Vec<u8>, MigrationError> {
    let mut bytes = Vec::new();
    read_file(parent, name, false)?
        .take(MAX_JSON_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_JSON_BYTES {
        return Err(MigrationError::Corrupt);
    }
    Ok(bytes)
}
fn validate_json(bytes: &[u8], order: bool) -> Result<(), MigrationError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| MigrationError::Corrupt)?;
    if order {
        let parents = value
            .pointer("/order/parents")
            .and_then(|v| v.as_object())
            .ok_or(MigrationError::Corrupt)?;
        if value.get("version").and_then(|v| v.as_u64()) != Some(1)
            || value.get("root").and_then(|v| v.as_str()).is_none()
            || parents.iter().any(|(parent, names)| {
                (!parent.is_empty() && crate::knowledge::validate_relative(parent).is_err())
                    || names.as_array().is_none_or(|names| {
                        names.len() > 20000
                            || names.iter().any(|name| {
                                name.as_str()
                                    .is_none_or(|name| name.is_empty() || name.contains('/'))
                            })
                    })
            })
        {
            return Err(MigrationError::Corrupt);
        }
    } else if value
        .get("knowledgeRootIdentity")
        .is_some_and(|identity| !crate::root_recovery::valid_identity(identity))
        || value
            .get("knowledgeRoot")
            .and_then(|v| v.as_str())
            .is_none_or(|root| root.is_empty())
    {
        return Err(MigrationError::Corrupt);
    }
    Ok(())
}
fn write_file(parent: &Dir, name: &str, bytes: &[u8]) -> Result<(), MigrationError> {
    let mut file = crate::write_fs::open_at(parent, name, false, true, false)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
pub(crate) fn sync_directory(dir: &Dir) -> Result<(), MigrationError> {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::MetadataExt;
        let retained = dir.try_clone()?.into_std_file();
        let original = retained.metadata()?;
        if !original.is_dir() {
            return Err(MigrationError::UnsafePath);
        }
        let identity = (original.dev(), original.ino());
        let verify = |file: &File| -> Result<(), MigrationError> {
            let metadata = file.metadata()?;
            if !metadata.is_dir() || (metadata.dev(), metadata.ino()) != identity {
                return Err(MigrationError::UnsafePath);
            }
            Ok(())
        };
        // cap-std may retain an O_PATH directory on Linux. Duplicating it does
        // not make fsync valid. Reopen the same object through its held FD,
        // without resolving its old pathname or weakening the caller's guards.
        let readable = crate::write_fs::open_at(dir, ".", true, false, false)?;
        verify(&readable)?;
        readable.sync_all()?;
        verify(&retained)?;
        verify(&readable)?;
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    dir.try_clone()?.into_std_file().sync_all()?;
    #[cfg(windows)]
    let _ = dir;
    // Windows directory FlushFileBuffers is not portable. Native QA must verify
    // rename/abrupt shutdown; every payload file has already been flushed.
    Ok(())
}

fn has_data(config: Option<&Dir>, local: Option<&Dir>) -> Result<bool, MigrationError> {
    for (dir, names) in [
        (
            config,
            &["settings.json", "tree-order", "workspace-settings"][..],
        ),
        (local, &["document-state"][..]),
    ] {
        if let Some(dir) = dir {
            for name in names {
                if exists(dir, name)? {
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Completion {
    version: u8,
    legacy: String,
    current: String,
    settings: bool,
    orders: bool,
    database: bool,
}

/// Inspect first. Errors/consent/conflict MUST block all profile initialization.
/// KeepCurrent is meaningful only for existing current data. A cancelled import exits.
pub fn prepare(locations: &Locations, decision: Decision) -> Result<Startup, MigrationError> {
    prepare_inner(locations, decision, &mut |_| Ok(()))
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Checkpoint {
    StagingCreated,
    ConfigCopied,
    DatabaseChunkCopied,
    BeforePublish,
    AfterPublish,
}
fn prepare_inner(
    locations: &Locations,
    decision: Decision,
    checkpoint: &mut dyn FnMut(Checkpoint) -> Result<(), MigrationError>,
) -> Result<Startup, MigrationError> {
    let local = directory(&locations.new_local, true)?.ok_or(MigrationError::Unavailable)?;
    let lock_name = "identifier-migration.lock";
    if !exists(&local, lock_name)? {
        match crate::write_fs::open_at(&local, lock_name, false, true, false) {
            Ok(_) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
    }
    let lock = read_file(&local, lock_name, true)?;
    lock.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => MigrationError::Busy,
        std::fs::TryLockError::Error(_) => MigrationError::Unavailable,
    })?;
    // Every new runtime retains this lease, so initialization cannot race import.
    let ready = |paths| {
        Startup::Ready(PreparedProfile {
            paths,
            _lease: lock,
        })
    };
    let new_config = directory(&locations.new_config, false)?;
    let new_local = directory(&locations.new_local, false)?;
    let new_data = has_data(new_config.as_ref(), new_local.as_ref())?;
    if let Some(local) = &new_local {
        if exists(local, BUNDLE)? {
            if new_data {
                return Ok(Startup::ConflictingCurrentProfiles);
            }
            let bundle = directory(&locations.new_local.join(BUNDLE), false)?
                .ok_or(MigrationError::Corrupt)?;
            let marker: Completion = serde_json::from_slice(&json_file(&bundle, "complete.json")?)
                .map_err(|_| MigrationError::Corrupt)?;
            if marker.version != 1
                || marker.legacy != locations.legacy
                || marker.current != locations.current
            {
                return Err(MigrationError::Corrupt);
            }
            let bundle_config = directory(&locations.new_local.join(BUNDLE).join("config"), false)?
                .ok_or(MigrationError::Corrupt)?;
            if marker.settings && !exists(&bundle_config, "settings.json")? {
                return Err(MigrationError::Corrupt);
            }
            if marker.orders && !exists(&bundle_config, "tree-order")? {
                return Err(MigrationError::Corrupt);
            }
            let bundle_state = directory(
                &locations.new_local.join(BUNDLE).join("document-state"),
                false,
            )?
            .ok_or(MigrationError::Corrupt)?;
            if marker.database && !exists(&bundle_state, "state.sqlite")? {
                return Err(MigrationError::Corrupt);
            }
            validate_current_profile(&locations.migrated_paths())?;
            return Ok(ready(locations.migrated_paths()));
        }
    }
    let old_config = directory(&locations.old_config, false)?;
    let old_local = directory(&locations.old_local, false)?;
    let old_data = has_data(old_config.as_ref(), old_local.as_ref())?;
    if let Some(local) = &new_local {
        if !old_data {
            for entry in local.entries()? {
                if entry?
                    .file_name()
                    .to_string_lossy()
                    .starts_with(STAGING_PREFIX)
                {
                    return Err(MigrationError::Interrupted);
                }
            }
        }
    }
    if new_data {
        if old_data && decision != Decision::KeepCurrent {
            return Ok(Startup::Conflict);
        }
        validate_current_profile(&locations.ordinary_paths())?;
        return Ok(ready(locations.ordinary_paths()));
    }
    if !old_data {
        return Ok(ready(locations.ordinary_paths()));
    }
    if decision != Decision::ImportAfterLegacyExit {
        return Ok(Startup::NeedsConsent);
    }

    let staging_name = format!("{STAGING_PREFIX}{}", crate::core::random_token());
    crate::write_fs::mkdir(&local, &staging_name)?;
    let staging_path = locations.new_local.join(&staging_name);
    let staging = directory(&staging_path, false)?.ok_or(MigrationError::Unavailable)?;
    crate::write_fs::mkdir(&staging, "config")?;
    crate::write_fs::mkdir(&staging, "document-state")?;
    let config =
        directory(&staging_path.join("config"), false)?.ok_or(MigrationError::Unavailable)?;
    let state = directory(&staging_path.join("document-state"), false)?
        .ok_or(MigrationError::Unavailable)?;
    checkpoint(Checkpoint::StagingCreated)?;
    let inventory_before = source_inventory(locations)?;
    let mut copied = Vec::new();
    if let Some(source) = &old_config {
        if exists(source, "settings.json")? {
            let bytes = json_file(source, "settings.json")?;
            validate_json(&bytes, false)?;
            write_file(&config, "settings.json", &bytes)?;
            copied.push((
                locations.old_config.join("settings.json"),
                Sha256::digest(&bytes).to_vec(),
            ));
        }
        if exists(source, "tree-order")? {
            let source_orders = directory(&locations.old_config.join("tree-order"), false)?
                .ok_or(MigrationError::UnsafePath)?;
            crate::write_fs::mkdir(&config, "tree-order")?;
            let target_orders = directory(&staging_path.join("config/tree-order"), false)?
                .ok_or(MigrationError::Unavailable)?;
            for (count, entry) in source_orders.entries()?.enumerate() {
                if count >= MAX_ORDER_FILES {
                    return Err(MigrationError::Corrupt);
                }
                let name = entry?
                    .file_name()
                    .into_string()
                    .map_err(|_| MigrationError::UnsafePath)?;
                if name.len() != 21
                    || !name.ends_with(".json")
                    || !name.as_bytes()[..16].iter().all(|b| b.is_ascii_hexdigit())
                {
                    return Err(MigrationError::Corrupt);
                }
                let bytes = json_file(&source_orders, &name)?;
                validate_json(&bytes, true)?;
                write_file(&target_orders, &name, &bytes)?;
                copied.push((
                    locations.old_config.join("tree-order").join(name),
                    Sha256::digest(&bytes).to_vec(),
                ));
            }
            sync_directory(&target_orders)?;
        }
    }
    checkpoint(Checkpoint::ConfigCopied)?;
    // A read-only transaction holds a SHARED lock through publication. In DELETE
    // mode writers need EXCLUSIVE before changing DB pages; WAL/journals are refused.
    let source_db = locations.old_local.join("document-state/state.sqlite");
    let mut source_connection = if let Some(source) = &old_local {
        if exists(source, "document-state")? {
            let source_state = directory(&locations.old_local.join("document-state"), false)?
                .ok_or(MigrationError::UnsafePath)?;
            for entry in source_state.entries()? {
                if entry?.file_name() != "state.sqlite" {
                    return Err(MigrationError::UnsupportedDatabase);
                }
            }
            if exists(&source_state, "state.sqlite")? {
                let mut file = read_file(&source_state, "state.sqlite", false)?;
                let expected_bytes = file.metadata()?.len();
                if expected_bytes > crate::storage_limits::absolute_database_bytes()? {
                    return Err(MigrationError::Corrupt);
                }
                let connection = open_db(&source_db)?;
                connection
                    .execute_batch("BEGIN; SELECT count(*) FROM sqlite_schema;")
                    .map_err(sql_error)?;
                let source_version: i64 = connection
                    .query_row("PRAGMA user_version", [], |row| row.get(0))
                    .map_err(sql_error)?;
                // Legacy import remains an immutable v1 snapshot, never a
                // migration route for the new profile's internal recovery store.
                if source_version != 1 {
                    return Err(MigrationError::UnsupportedDatabase);
                }
                validate_db(&connection)?;
                // The absolute pre-open bound also admits configured v1 profiles.
                // An unconfigured v1 must retain its smaller physical ceiling
                // before any database bytes are copied or a bundle is published.
                if expected_bytes > database_size_limit(&connection)? {
                    return Err(MigrationError::Corrupt);
                }
                let mut target =
                    crate::write_fs::open_at(&state, "state.sqlite", false, true, false)?;
                let mut digest = Sha256::new();
                let mut buffer = [0u8; 64 * 1024];
                let mut copied_bytes = 0u64;
                loop {
                    let count = file.read(&mut buffer)?;
                    if count == 0 {
                        break;
                    }
                    copied_bytes += count as u64;
                    if copied_bytes > expected_bytes {
                        return Err(MigrationError::SourceChanged);
                    }
                    target.write_all(&buffer[..count])?;
                    digest.update(&buffer[..count]);
                    checkpoint(Checkpoint::DatabaseChunkCopied)?;
                }
                if copied_bytes != expected_bytes {
                    return Err(MigrationError::SourceChanged);
                }
                target.sync_all()?;
                drop(target);
                let copied_db = open_db(&staging_path.join("document-state/state.sqlite"))?;
                validate_db(&copied_db)?;
                drop(copied_db);
                let digest = digest.finalize().to_vec();
                if hash_file(&state, "state.sqlite")? != digest {
                    return Err(MigrationError::Corrupt);
                }
                verify_source_identity(&source_state, &file)?;
                if hash_open_file(&mut file)? != digest {
                    return Err(MigrationError::SourceChanged);
                }
                // Field order closes SQLite before the raw file. Never close another
                // descriptor for this inode while the read transaction holds POSIX locks.
                Some((connection, source_state, file, digest))
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };
    for (path, bytes) in &copied {
        if Sha256::digest(json_at(path)?).as_slice() != bytes {
            return Err(MigrationError::SourceChanged);
        }
    }
    let completion = serde_json::to_vec(&Completion {
        version: 1,
        legacy: locations.legacy.clone(),
        current: locations.current.clone(),
        settings: inventory_before.contains(&locations.old_config.join("settings.json")),
        orders: inventory_before.contains(&locations.old_config.join("tree-order")),
        database: inventory_before.contains(&source_db),
    })
    .map_err(|_| MigrationError::Corrupt)?;
    write_file(&staging, "complete.json", &completion)?;
    sync_directory(&config)?;
    sync_directory(&state)?;
    sync_directory(&staging)?;
    // Bind the exact verified tree, including its directory/file identities and bytes.
    // Windows handles must close before rename; the seal survives that necessary gap.
    let seal = seal_bundle(&staging)?;
    // A seal must describe the validated copy, not merely whatever bytes happen
    // to be present now. Bind its payload to the source digests and marker too.
    let mut expected_payload = Vec::new();
    for (path, digest) in &copied {
        let relative = path
            .strip_prefix(&locations.old_config)
            .map_err(|_| MigrationError::Corrupt)?;
        let relative = relative
            .to_str()
            .ok_or(MigrationError::UnsafePath)?
            .replace('\\', "/");
        expected_payload.push((format!("config/{relative}"), digest.clone()));
    }
    if let Some((_, _, _, digest)) = &source_connection {
        expected_payload.push(("document-state/state.sqlite".into(), digest.clone()));
    }
    expected_payload.push(("complete.json".into(), Sha256::digest(&completion).to_vec()));
    expected_payload.sort_by(|a, b| a.0.cmp(&b.0));
    let sealed_payload = seal
        .iter()
        .filter_map(|entry| {
            entry
                .digest
                .as_ref()
                .map(|digest| (entry.relative.clone(), digest.clone()))
        })
        .collect::<Vec<_>>();
    if sealed_payload != expected_payload {
        return Err(MigrationError::SourceChanged);
    }
    drop(config);
    drop(state);
    drop(staging);
    checkpoint(Checkpoint::BeforePublish)?;
    // A fresh destination check immediately precedes the no-replace publication.
    let latest_config = directory(&locations.new_config, false)?;
    let latest_local =
        directory(&locations.new_local, false)?.ok_or(MigrationError::SourceChanged)?;
    if !crate::knowledge::same_directory(&local, &latest_local)
        .map_err(|_| MigrationError::SourceChanged)?
        || has_data(latest_config.as_ref(), Some(&latest_local))?
    {
        return Err(MigrationError::SourceChanged);
    }
    for (path, bytes) in &copied {
        if Sha256::digest(json_at(path)?).as_slice() != bytes {
            return Err(MigrationError::SourceChanged);
        }
    }
    if let Some((_, source_state, file, digest)) = &mut source_connection {
        verify_source_identity(source_state, file)?;
        let current = directory(source_db.parent().ok_or(MigrationError::UnsafePath)?, false)?
            .ok_or(MigrationError::SourceChanged)?;
        verify_source_identity(&current, file)?;
        if hash_open_file(file)? != *digest {
            return Err(MigrationError::SourceChanged);
        }
    }
    if source_inventory(locations)? != inventory_before {
        return Err(MigrationError::SourceChanged);
    }
    let source = crate::write_fs::open_at(&local, &staging_name, true, false, true)?;
    let selected = Dir::from_std_file(source.try_clone()?);
    if seal_bundle(&selected)? != seal {
        return Err(MigrationError::SourceChanged);
    }
    drop(selected);
    crate::write_fs::rename_noreplace(&local, &staging_name, &local, BUNDLE, &source)?;
    // Windows ordinary directory opens do not share DELETE with this rename handle.
    drop(source);
    sync_directory(&local)?;
    checkpoint(Checkpoint::AfterPublish)?;
    let published = directory(&locations.new_local.join(BUNDLE), false)?
        .ok_or(MigrationError::SourceChanged)?;
    if seal_bundle(&published)? != seal {
        // Never delete/overwrite a competing publication or fall back to an empty DB.
        return Err(MigrationError::SourceChanged);
    }
    drop(source_connection);
    Ok(ready(locations.migrated_paths()))
}
fn source_inventory(locations: &Locations) -> Result<Vec<PathBuf>, MigrationError> {
    let mut paths = Vec::new();
    for (root, leaves) in [
        (&locations.old_config, &["settings.json", "tree-order"][..]),
        (&locations.old_local, &["document-state"][..]),
    ] {
        if let Some(dir) = directory(root, false)? {
            for leaf in leaves {
                if exists(&dir, leaf)? {
                    let path = root.join(leaf);
                    if crate::write_fs::entry_is_directory(&dir, leaf)? {
                        let child =
                            directory(&path, false)?.ok_or(MigrationError::SourceChanged)?;
                        for entry in child.entries()? {
                            if paths.len() > MAX_ORDER_FILES + 4 {
                                return Err(MigrationError::Corrupt);
                            }
                            paths.push(path.join(entry?.file_name()));
                        }
                    }
                    paths.push(path);
                }
            }
        }
    }
    paths.sort();
    Ok(paths)
}
fn json_at(path: &Path) -> Result<Vec<u8>, MigrationError> {
    let parent = directory(path.parent().ok_or(MigrationError::UnsafePath)?, false)?
        .ok_or(MigrationError::SourceChanged)?;
    json_file(
        &parent,
        path.file_name()
            .and_then(|n| n.to_str())
            .ok_or(MigrationError::UnsafePath)?,
    )
}
fn hash_file(parent: &Dir, name: &str) -> Result<Vec<u8>, MigrationError> {
    let mut file =
        read_file(parent, name, false)?.take(crate::storage_limits::absolute_database_bytes()? + 1);
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > crate::storage_limits::absolute_database_bytes()? {
            return Err(MigrationError::SourceChanged);
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finalize().to_vec())
}
pub(crate) fn verify_source_identity(parent: &Dir, file: &File) -> Result<(), MigrationError> {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        let metadata = parent.symlink_metadata("state.sqlite")?;
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.nlink() != 1 {
            return Err(MigrationError::UnsafePath);
        }
        if crate::write_fs::identity(file)? != (metadata.dev(), u128::from(metadata.ino())) {
            return Err(MigrationError::SourceChanged);
        }
    }
    #[cfg(windows)]
    if crate::write_fs::identity(file)?
        != crate::write_fs::identity(&read_file(parent, "state.sqlite", false)?)?
    {
        return Err(MigrationError::SourceChanged);
    }
    Ok(())
}
fn hash_open_file(file: &mut File) -> Result<Vec<u8>, MigrationError> {
    file.seek(SeekFrom::Start(0))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    let mut bytes = 0u64;
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > crate::storage_limits::absolute_database_bytes()? {
            return Err(MigrationError::SourceChanged);
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finalize().to_vec())
}

#[derive(Debug, PartialEq, Eq)]
struct SealedEntry {
    relative: String,
    identity: (u64, u128),
    digest: Option<Vec<u8>>,
}
fn seal_bundle(bundle: &Dir) -> Result<Vec<SealedEntry>, MigrationError> {
    fn visit(dir: &Dir, relative: &str, seal: &mut Vec<SealedEntry>) -> Result<(), MigrationError> {
        if relative.matches('/').count() > 2 || seal.len() > MAX_ORDER_FILES + 8 {
            return Err(MigrationError::Corrupt);
        }
        seal.push(SealedEntry {
            relative: relative.into(),
            identity: crate::write_fs::identity(&dir.try_clone()?.into_std_file())?,
            digest: None,
        });
        for entry in dir.entries()? {
            let name = entry?
                .file_name()
                .into_string()
                .map_err(|_| MigrationError::UnsafePath)?;
            let path = if relative.is_empty() {
                name.clone()
            } else {
                format!("{relative}/{name}")
            };
            if crate::write_fs::entry_is_directory(dir, &name)? {
                let child =
                    Dir::from_std_file(crate::write_fs::open_at(dir, &name, true, false, false)?);
                visit(&child, &path, seal)?;
            } else {
                let mut file = read_file(dir, &name, false)?;
                seal.push(SealedEntry {
                    relative: path,
                    identity: crate::write_fs::identity(&file)?,
                    digest: Some(hash_open_file(&mut file)?),
                });
                if seal.len() > MAX_ORDER_FILES + 8 {
                    return Err(MigrationError::Corrupt);
                }
            }
        }
        Ok(())
    }
    let mut seal = Vec::new();
    visit(bundle, "", &mut seal)?;
    seal.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(seal)
}

fn validate_current_profile(paths: &ActivePaths) -> Result<(), MigrationError> {
    if let Some(config) = directory(
        paths.settings.parent().ok_or(MigrationError::UnsafePath)?,
        false,
    )? {
        if exists(&config, "settings.json")? {
            validate_json(&json_file(&config, "settings.json")?, false)?;
        }
        if exists(&config, "tree-order")? {
            let orders = directory(&paths.settings.parent().unwrap().join("tree-order"), false)?
                .ok_or(MigrationError::Corrupt)?;
            let mut committed_count = 0;
            for (count, entry) in orders.entries()?.enumerate() {
                if count >= 2 * MAX_ORDER_FILES {
                    return Err(MigrationError::Corrupt);
                }
                let name = entry?
                    .file_name()
                    .into_string()
                    .map_err(|_| MigrationError::UnsafePath)?;
                let writer_temp = name
                    .strip_prefix(".order-")
                    .and_then(|token| token.strip_suffix(".tmp"))
                    .is_some_and(|token| {
                        token.len() == 64
                            && token
                                .bytes()
                                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                    });
                if writer_temp {
                    // Native save may crash before rename. Only a plain single-link
                    // writer temp is ignored; never parse, copy, delete or prefer it.
                    read_file(&orders, &name, false)?;
                    continue;
                }
                committed_count += 1;
                if committed_count > MAX_ORDER_FILES {
                    return Err(MigrationError::Corrupt);
                }
                if name.len() != 21
                    || !name.ends_with(".json")
                    || !name.as_bytes()[..16].iter().all(|b| b.is_ascii_hexdigit())
                {
                    return Err(MigrationError::Corrupt);
                }
                validate_json(&json_file(&orders, &name)?, true)?;
            }
        }
    }
    if let Some(state) = directory(&paths.document_state, false)? {
        if exists(&state, "state.sqlite")? {
            validate_current_state(&paths.document_state)?;
        } else {
            validate_empty_state(&state)?;
        }
    }
    Ok(())
}
fn validate_empty_state(state: &Dir) -> Result<(), MigrationError> {
    if state.entries()?.next().is_some() {
        return Err(MigrationError::Corrupt);
    }
    Ok(())
}
/// Current profiles are writable runtime state, unlike the immutable legacy snapshot.
/// Called only after acquiring the new runtime lease. Never CREATE, repair schema,
/// re-import legacy, remove journals ourselves, or switch journal modes.
fn validate_current_state(path: &Path) -> Result<(), MigrationError> {
    let parent = directory(path, false)?.ok_or(MigrationError::Corrupt)?;
    for entry in parent.entries()? {
        match entry?.file_name().to_str() {
            Some("state.sqlite") => (),
            Some("state.sqlite-journal") => {
                let mut journal = read_file(&parent, "state.sqlite-journal", true)?;
                let length = journal.metadata()?.len();
                if length > 2 * crate::storage_limits::absolute_database_bytes()? {
                    return Err(MigrationError::Corrupt);
                }
                // This app never ATTACHes another DB. Refuse a super-journal footer:
                // SQLite must not follow its stored pathname outside this profile.
                if length >= 16 {
                    journal.seek(SeekFrom::End(-16))?;
                    let mut footer = [0u8; 16];
                    journal.read_exact(&mut footer)?;
                    if footer[8..] == [0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7] {
                        return Err(MigrationError::UnsupportedDatabase);
                    }
                }
            }
            _ => return Err(MigrationError::UnsupportedDatabase),
        }
    }
    // Keep the raw descriptor longer than SQLite, including error returns; closing
    // another fd for this inode during validation would cancel POSIX SQLite locks.
    let file = read_file(&parent, "state.sqlite", true)?;
    if file.metadata()?.len() > crate::storage_limits::absolute_database_bytes()? {
        return Err(MigrationError::Corrupt);
    }
    let database = path.join("state.sqlite");
    let connection = open_database(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    connection
        .execute_batch("PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;")
        .map_err(sql_error)?;
    // BEGIN/read invokes SQLite's own hot-journal rollback before schema/record reads.
    validate_db(&connection)?;
    if file.metadata()?.len() > database_size_limit(&connection)? {
        return Err(MigrationError::Corrupt);
    }
    verify_source_identity(&parent, &file)?;
    connection.execute_batch("ROLLBACK;").map_err(sql_error)?;
    drop(connection);
    file.sync_all()?;
    sync_directory(&parent)?;
    Ok(())
}
fn open_db(path: &Path) -> Result<Connection, MigrationError> {
    open_database(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
}

/// An offline management session owns both the runtime lease and SQLite's
/// retained exclusive lock. Field order closes SQLite before raw descriptors.
pub(crate) struct ManagementStore {
    pub connection: Connection,
    database_file: File,
    // Closing any raw same-inode descriptor would cancel POSIX SQLite locks.
    _database_open_guards: [File; 2],
    state_dir: Dir,
    profile_dir: Dir,
    state_path: PathBuf,
    profile_path: PathBuf,
    database_id: String,
    _lease: File,
}

impl ManagementStore {
    pub(crate) fn verify_identity(&self) -> Result<(), MigrationError> {
        verify_source_identity(&self.state_dir, &self.database_file)?;
        let profile = directory(&self.profile_path, false)?.ok_or(MigrationError::SourceChanged)?;
        let state = directory(&self.state_path, false)?.ok_or(MigrationError::SourceChanged)?;
        if !crate::knowledge::same_directory(&self.profile_dir, &profile)
            .map_err(|_| MigrationError::Unavailable)?
            || !crate::knowledge::same_directory(&self.state_dir, &state)
                .map_err(|_| MigrationError::Unavailable)?
        {
            return Err(MigrationError::SourceChanged);
        }
        let lease = read_file(&profile, "identifier-migration.lock", false)
            .map_err(|_| MigrationError::SourceChanged)?;
        if crate::write_fs::identity(&self._lease)? != crate::write_fs::identity(&lease)? {
            return Err(MigrationError::SourceChanged);
        }
        Ok(())
    }
    pub(crate) fn verify(&self) -> Result<(), MigrationError> {
        self.verify_identity()?;
        clean_management_directory(&self.state_dir, &self.connection)
    }

    pub(crate) fn database_bytes(&self) -> Result<u64, MigrationError> {
        let bytes = self.database_file.metadata()?.len();
        if bytes > database_size_limit(&self.connection)? {
            return Err(MigrationError::Corrupt);
        }
        Ok(bytes)
    }

    pub(crate) fn database_file(&self) -> &File {
        &self.database_file
    }
    pub(crate) fn profile_directory(&self) -> &Dir {
        &self.profile_dir
    }
    pub(crate) fn uses_identifier_bundle(&self) -> bool {
        self.state_path == self.profile_path.join(BUNDLE).join("document-state")
    }
    pub(crate) fn database_id(&self) -> &str {
        &self.database_id
    }

    #[cfg(test)]
    pub(crate) fn database_snapshot(&self) -> Vec<u8> {
        // Tests must not open/close another raw same-inode fd while fenced.
        let mut file = &self.database_file;
        file.rewind().unwrap();
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes).unwrap();
        bytes
    }

    pub(crate) fn journal_bytes(&self) -> Result<u64, MigrationError> {
        self.verify()?;
        if !exists(&self.state_dir, "state.sqlite-journal")? {
            return Ok(0);
        }
        Ok(read_file(&self.state_dir, "state.sqlite-journal", false)?
            .metadata()?
            .len())
    }
}

pub(crate) fn database_size_limit(connection: &Connection) -> Result<u64, MigrationError> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(sql_error)?;
    if !matches!(version, 1..=3) {
        return Err(MigrationError::UnsupportedDatabase);
    }
    crate::storage_limits::read(connection)?;
    if crate::storage_limits::acknowledged_format(connection)? {
        crate::storage_limits::physical_database_bytes(connection)
    } else if version == 1 && !crate::storage_limits::table_exists(connection)? {
        Ok(MAX_DB_BYTES)
    } else {
        Ok(crate::state_inspection::recovery_store::MAX_DATABASE_BYTES)
    }
}

fn clean_state_directory(parent: &Dir) -> Result<(), MigrationError> {
    for entry in parent.entries()? {
        if entry?.file_name() != "state.sqlite" {
            return Err(MigrationError::UnsupportedDatabase);
        }
    }
    Ok(())
}

fn clean_management_directory(parent: &Dir, connection: &Connection) -> Result<(), MigrationError> {
    for entry in parent.entries()? {
        match entry?.file_name().to_str() {
            Some("state.sqlite") => (),
            // EXCLUSIVE locking retains its zeroed DELETE-mode journal until
            // connection close. Admit only that idle, non-hot session artifact.
            Some("state.sqlite-journal") if connection.is_autocommit() => {
                let mut file = read_file(parent, "state.sqlite-journal", false)?;
                let bytes = file.metadata()?.len();
                if bytes > 2 * crate::storage_limits::absolute_database_bytes()? {
                    return Err(MigrationError::Corrupt);
                }
                if bytes != 0 {
                    let mut header = [0u8; 28];
                    file.read_exact(&mut header)
                        .map_err(|_| MigrationError::Corrupt)?;
                    if header != [0; 28] {
                        return Err(MigrationError::UnsupportedDatabase);
                    }
                }
            }
            _ => return Err(MigrationError::UnsupportedDatabase),
        }
    }
    Ok(())
}

pub(crate) fn state_database_id(file: &File) -> Result<String, MigrationError> {
    let mut identity = Sha256::new();
    let (volume, file_id) = crate::write_fs::identity(file)?;
    identity.update(volume.to_le_bytes());
    identity.update(file_id.to_le_bytes());
    if let Ok(created) = file.metadata()?.created() {
        if let Ok(created) = created.duration_since(std::time::UNIX_EPOCH) {
            identity.update(created.as_nanos().to_le_bytes());
        }
    }
    Ok(format!("{:x}", identity.finalize()))
}

/// Existing profiles only. Opening never creates a lock/DB, upgrades schema,
/// recovers journals, imports legacy data or changes a persistent journal mode.
pub(crate) fn open_management_profile(profile: &Path) -> Result<ManagementStore, MigrationError> {
    let profile_dir = directory(profile, false)?.ok_or(MigrationError::Unavailable)?;
    for entry in profile_dir.entries()? {
        let name = entry?
            .file_name()
            .into_string()
            .map_err(|_| MigrationError::UnsafePath)?;
        // Unpublished writer artifacts carry no profile authority. Leave them
        // untouched so an interrupted settings publication can be reviewed again.
        if crate::write_fs::unpublished_staging_name(&name) {
            continue;
        }
        if ![
            "identifier-migration.lock",
            "document-state",
            "search-index",
            "settings.json",
            "resident.json",
            "tree-order",
            "workspace-settings",
            BUNDLE,
        ]
        .contains(&name.as_str())
        {
            return Err(MigrationError::UnsupportedDatabase);
        }
        // Inspect before opening: profile top-level aliases/cloud entries stay denied.
        crate::write_fs::entry_is_directory(&profile_dir, &name)
            .map_err(|_| MigrationError::UnsafePath)?;
    }
    let lease = read_file(&profile_dir, "identifier-migration.lock", true)?;
    lease.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => MigrationError::Busy,
        std::fs::TryLockError::Error(_) => MigrationError::Unavailable,
    })?;
    let state_path = if exists(&profile_dir, BUNDLE)? {
        if ["document-state", "settings.json", "tree-order"]
            .into_iter()
            .any(|name| exists(&profile_dir, name).unwrap_or(true))
        {
            return Err(MigrationError::UnsupportedDatabase);
        }
        let bundle_path = profile.join(BUNDLE);
        let bundle = directory(&bundle_path, false)?.ok_or(MigrationError::SourceChanged)?;
        let marker: Completion = serde_json::from_slice(&json_file(&bundle, "complete.json")?)
            .map_err(|_| MigrationError::Corrupt)?;
        if marker.version != 1
            || !marker.database
            || marker.legacy != LEGACY_IDENTIFIER
            || profile.file_name().and_then(|name| name.to_str()) != Some(marker.current.as_str())
        {
            return Err(MigrationError::UnsupportedDatabase);
        }
        bundle_path.join("document-state")
    } else {
        if profile.file_name().and_then(|name| name.to_str()) == Some(LEGACY_IDENTIFIER) {
            return Err(MigrationError::UnsafePath);
        }
        profile.join("document-state")
    };
    let state_dir = directory(&state_path, false)?.ok_or(MigrationError::Unavailable)?;
    clean_state_directory(&state_dir)?;
    let database_file = read_file(&state_dir, "state.sqlite", false)?;
    if database_file.metadata()?.len() > crate::storage_limits::absolute_database_bytes()? {
        return Err(MigrationError::Corrupt);
    }
    let database_id = state_database_id(&database_file)?;
    let (connection, write_guard) = open_database_guarded(
        &state_path.join("state.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_WRITE,
    )?;
    let (reader, read_guard) = open_database_guarded(
        &state_path.join("state.sqlite"),
        OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let deadline =
        crate::storage_identity_transition::budget::deadline(database_file.metadata()?.len());
    let cancellation = crate::storage_identity_transition::budget::cancellation();
    let reader_cancellation = cancellation.clone();
    connection
        .progress_handler(
            1000,
            Some(move || {
                std::time::Instant::now() >= deadline
                    || cancellation
                        .as_ref()
                        .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire))
            }),
        )
        .map_err(sql_error)?;
    reader
        .progress_handler(
            1000,
            Some(move || {
                std::time::Instant::now() >= deadline
                    || reader_cancellation
                        .as_ref()
                        .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire))
            }),
        )
        .map_err(sql_error)?;
    acquire_management_lock(&connection, reader, |_| Ok(()))?;
    validate_db(&connection)?;
    let store = ManagementStore {
        connection,
        database_file,
        _database_open_guards: [write_guard, read_guard],
        state_dir,
        profile_dir,
        state_path,
        profile_path: profile.to_owned(),
        database_id,
        _lease: lease,
    };
    store.verify()?;
    store.database_bytes()?;
    store
        .connection
        .execute_batch("ROLLBACK;")
        .map_err(sql_error)?;
    store
        .connection
        .progress_handler(0, None::<fn() -> bool>)
        .map_err(sql_error)?;
    Ok(store)
}

/// Metadata inspection never acquires migration/runtime write authority. Keep
/// the raw file descriptor alive until SQLite closes so POSIX read locks survive.
pub(crate) fn inspect_state_snapshot<T>(
    path: &Path,
    inspect: impl FnOnce(&Connection, u64, &str) -> Result<T, MigrationError>,
) -> Result<T, MigrationError> {
    use std::time::Instant;
    let parent = directory(path, false)?.ok_or(MigrationError::Unavailable)?;
    clean_state_directory(&parent)?;
    let file = read_file(&parent, "state.sqlite", false)?;
    let metadata = file.metadata()?;
    if metadata.len() > crate::storage_limits::absolute_database_bytes()? {
        return Err(MigrationError::Corrupt);
    }
    let database_id = state_database_id(&file)?;
    let connection = open_db(&path.join("state.sqlite"))?;
    let deadline = Instant::now() + Duration::from_secs(2);
    connection
        .progress_handler(1000, Some(move || Instant::now() >= deadline))
        .map_err(sql_error)?;
    connection
        .execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; BEGIN DEFERRED;")
        .map_err(sql_error)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql_error)?;
    if !matches!(version, 1..=3) {
        return Err(MigrationError::UnsupportedDatabase);
    }
    validate_schema(&connection)?;
    if version >= 2 {
        crate::state_inspection::recovery_store::validate_metadata(&connection)?;
        crate::storage_identity_transition::validate_metadata(&connection)?;
    }
    let database_bytes = file.metadata()?.len();
    if database_bytes > database_size_limit(&connection)? {
        return Err(MigrationError::Corrupt);
    }
    let result = inspect(&connection, database_bytes, &database_id)?;
    verify_source_identity(&parent, &file)?;
    let fresh = directory(path, false)?.ok_or(MigrationError::SourceChanged)?;
    if !crate::knowledge::same_directory(&parent, &fresh)
        .map_err(|_| MigrationError::Unavailable)?
    {
        return Err(MigrationError::SourceChanged);
    }
    clean_state_directory(&fresh)?;
    connection.execute_batch("ROLLBACK;").map_err(sql_error)?;
    drop(connection);
    Ok(result)
}

fn open_database(path: &Path, access: OpenFlags) -> Result<Connection, MigrationError> {
    let (connection, _guard) = open_database_guarded(path, access)?;
    connection
        .execute_batch("PRAGMA trusted_schema=OFF;")
        .map_err(sql_error)?;
    Ok(connection)
}

/// Header guards survive the entire management session. Opening/configuring
/// these connections does not execute a statement that reads database pages.
pub(crate) fn open_database_guarded(
    path: &Path,
    access: OpenFlags,
) -> Result<(Connection, File), MigrationError> {
    let parent = directory(path.parent().ok_or(MigrationError::UnsafePath)?, false)?
        .ok_or(MigrationError::SourceChanged)?;
    let mut guard = read_file(&parent, "state.sqlite", false)?;
    let mut header = [0u8; 100];
    guard
        .read_exact(&mut header)
        .map_err(|_| MigrationError::Corrupt)?;
    if &header[..16] != b"SQLite format 3\0" {
        return Err(MigrationError::Corrupt);
    }
    // Opening even a read-only WAL DB can create -wal/-shm. Reject the header
    // before SQLite sees the file, so refusal preserves the entire old directory.
    if header[18] != 1 || header[19] != 1 {
        return Err(MigrationError::UnsupportedDatabase);
    }
    let connection = Connection::open_with_flags(path, access | OpenFlags::SQLITE_OPEN_NOFOLLOW)
        .map_err(sql_error)?;
    // Preserve SQLite's intrinsic row bound; do not impose a policy LENGTH cap.
    connection
        .busy_timeout(Duration::from_millis(250))
        .map_err(sql_error)?;
    Ok((connection, guard))
}

#[derive(Clone, Copy)]
enum ManagementLockPhase {
    ReadShared,
    WriteReserved,
    ReaderClosed,
    ExclusiveCommit,
    ExclusiveHeld,
}

/// The first page read is strictly READ_ONLY: a raced hot journal is refused,
/// never recovered. RESERVED is acquired while that SHARED reader remains,
/// then EXCLUSIVE mode retains the lock across its no-write COMMIT.
fn acquire_management_lock(
    connection: &Connection,
    reader: Connection,
    mut checkpoint: impl FnMut(ManagementLockPhase) -> Result<(), MigrationError>,
) -> Result<(), MigrationError> {
    reader
        .execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN DEFERRED;")
        .map_err(sql_error)?;
    reader
        .query_row("SELECT count(*) FROM sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(sql_error)?;
    // Windows raw guards omit FILE_SHARE_DELETE, preventing DB name replacement;
    // its VFS does not implement HAS_MOVED. Unix needs the explicit VFS check.
    #[cfg(unix)]
    for database in [&reader, connection] {
        let mut moved = 0i32;
        // SAFETY: live connections and the correctly aligned integer output
        // remain valid for this synchronous SQLite file-control call.
        let result = unsafe {
            rusqlite::ffi::sqlite3_file_control(
                database.handle(),
                c"main".as_ptr(),
                rusqlite::ffi::SQLITE_FCNTL_HAS_MOVED,
                (&mut moved as *mut i32).cast(),
            )
        };
        if result != rusqlite::ffi::SQLITE_OK || moved != 0 {
            return Err(MigrationError::SourceChanged);
        }
    }
    checkpoint(ManagementLockPhase::ReadShared)?;
    connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;").map_err(sql_error)?;
    checkpoint(ManagementLockPhase::WriteReserved)?;
    // SQLite's shared-inode bookkeeping defers this reader's OS descriptor close
    // while the other SQLite connection owns RESERVED on the same inode.
    drop(reader);
    checkpoint(ManagementLockPhase::ReaderClosed)?;
    connection
        .execute_batch("PRAGMA locking_mode=EXCLUSIVE; COMMIT;")
        .map_err(sql_error)?;
    checkpoint(ManagementLockPhase::ExclusiveCommit)?;
    connection
        .execute_batch("BEGIN EXCLUSIVE; PRAGMA query_only=ON;")
        .map_err(sql_error)?;
    checkpoint(ManagementLockPhase::ExclusiveHeld)
}
pub(crate) fn validate_db(connection: &Connection) -> Result<(), MigrationError> {
    let journal: String = connection
        .query_row("PRAGMA journal_mode", [], |row| row.get(0))
        .map_err(sql_error)?;
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql_error)?;
    if journal != "delete" || !matches!(version, 1..=3) {
        return Err(MigrationError::UnsupportedDatabase);
    }
    let integrity: String = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .map_err(sql_error)?;
    if integrity != "ok" {
        return Err(MigrationError::Corrupt);
    }
    validate_schema(connection)?;
    let limits = crate::storage_limits::read(connection)?;
    let quota_rows: i64 = connection
        .query_row("SELECT count(*) FROM quota", [], |row| row.get(0))
        .map_err(|_| MigrationError::Corrupt)?;
    if quota_rows != 1 {
        return Err(MigrationError::Corrupt);
    }
    let (total, count, generation): (i64, i64, i64) = connection
        .query_row(
            "SELECT bytes,documents,generation FROM quota WHERE singleton=1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| MigrationError::Corrupt)?;
    let (actual_total, actual_count, max_generation): (i64, i64, i64) = connection
        .query_row(
            "SELECT coalesce(sum(bytes),0),count(*),coalesce(max(generation),0) FROM documents",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| MigrationError::Corrupt)?;
    if total != actual_total
        || count != actual_count
        || !(0..=limits.total_bytes).contains(&total)
        || !(0..=4096).contains(&count)
        || generation < max_generation
        || generation < 0
    {
        return Err(MigrationError::Corrupt);
    }
    let mut statement = connection
        .prepare("SELECT data,bytes,revision,id,root,path,generation FROM documents")
        .map_err(|_| MigrationError::Corrupt)?;
    let mut rows = statement.query([]).map_err(sql_error)?;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let bytes: i64 = row.get(1).map_err(|_| MigrationError::Corrupt)?;
        if !(2..=limits.document_bytes as i64).contains(&bytes) {
            return Err(MigrationError::Corrupt);
        }
        let data = row
            .get_ref(0)
            .map_err(|_| MigrationError::Corrupt)?
            .as_str()
            .map_err(|_| MigrationError::Corrupt)?;
        if data.len() as i64 != bytes {
            return Err(MigrationError::Corrupt);
        }
        crate::state_inspection::recovery_store::validated_app_count(data, bytes)?;
        let revision: i64 = row.get(2).map_err(|_| MigrationError::Corrupt)?;
        let id: String = row.get(3).map_err(|_| MigrationError::Corrupt)?;
        let root: String = row.get(4).map_err(|_| MigrationError::Corrupt)?;
        let path: String = row.get(5).map_err(|_| MigrationError::Corrupt)?;
        let row_generation: i64 = row.get(6).map_err(|_| MigrationError::Corrupt)?;
        if revision <= 0
            || id.is_empty()
            || root.is_empty()
            || crate::knowledge::validate_relative(&path).is_err()
            || row_generation <= 0
            || row_generation > generation
        {
            return Err(MigrationError::Corrupt);
        }
    }
    if version >= 2 {
        crate::state_inspection::recovery_store::validate(connection)?;
    }
    crate::storage_identity_transition::validate_metadata(connection)?;
    Ok(())
}

pub(crate) fn validate_schema(connection: &Connection) -> Result<(), MigrationError> {
    // Both the original and raised-budget variants use schema v1. Comparing only names
    // or readable rows misses constraints required by runtime ON CONFLICT(id).
    // Admit ASCII case/whitespace variation, but fail closed on other DDL changes.
    let normalized = |sql: &str| {
        sql.bytes()
            .filter(|b| !b.is_ascii_whitespace())
            .map(|b| b.to_ascii_lowercase())
            .collect::<Vec<_>>()
    };
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(sql_error)?;
    if !matches!(version, 1..=3) {
        return Err(MigrationError::UnsupportedDatabase);
    }
    let mut expected = vec![
        ("index", "document_location", "documents", "CREATE INDEX document_location ON documents(root,path,generation)"),
        ("table", "documents", "documents", "CREATE TABLE documents (id TEXT PRIMARY KEY, data TEXT NOT NULL, bytes INTEGER NOT NULL, revision INTEGER NOT NULL, root TEXT NOT NULL, path TEXT NOT NULL, generation INTEGER NOT NULL)"),
        ("table", "quota", "quota", "CREATE TABLE quota (singleton INTEGER PRIMARY KEY CHECK(singleton=1), bytes INTEGER NOT NULL, documents INTEGER NOT NULL, generation INTEGER NOT NULL)"),
    ];
    if version >= 2 {
        expected.push((
            "table",
            "recovery_records",
            "recovery_records",
            crate::state_inspection::recovery_store::RECORDS_DDL,
        ));
        expected.push((
            "table",
            "state_tombstones",
            "state_tombstones",
            crate::state_inspection::recovery_store::TOMBSTONES_DDL,
        ));
    }
    if version == 3 {
        expected.push((
            "table",
            "identity_confirmations",
            "identity_confirmations",
            crate::storage_identity_transition::CONFIRMATIONS_DDL,
        ));
        expected.push((
            "table",
            "identity_roots",
            "identity_roots",
            crate::storage_identity_transition::ROOTS_DDL,
        ));
    }
    if crate::storage_limits::table_exists(connection)? {
        expected.push((
            "table",
            "storage_limits",
            "storage_limits",
            crate::storage_limits::schema_ddl(connection)?,
        ));
        crate::storage_limits::read(connection)?;
    }
    expected.sort_unstable_by_key(|entry| (entry.0, entry.1));
    let mut statement = connection.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name LIMIT 9").map_err(sql_error)?;
    let objects = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(sql_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_error)?;
    if objects.len() != expected.len()
        || objects
            .iter()
            .zip(expected)
            .any(|(actual, (kind, name, table, sql))| {
                actual.0 != kind
                    || actual.1 != name
                    || actual.2 != table
                    || normalized(&actual.3) != normalized(sql)
            })
    {
        return Err(MigrationError::UnsupportedDatabase);
    }
    // Confirm SQLite sees the non-partial PK index required for upsert, including
    // its key/collation. Do not infer uniqueness from a single existing row.
    let mut statement = connection
        .prepare("PRAGMA index_list(documents)")
        .map_err(sql_error)?;
    let indexes = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(sql_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(sql_error)?;
    if indexes.len() != 2
        || !indexes
            .iter()
            .any(|index| index == &("sqlite_autoindex_documents_1".into(), 1, "pk".into(), 0))
        || !indexes
            .iter()
            .any(|index| index == &("document_location".into(), 0, "c".into(), 0))
    {
        return Err(MigrationError::UnsupportedDatabase);
    }
    let key: (String, i64, String) = connection.query_row("SELECT name,desc,coll FROM pragma_index_xinfo('sqlite_autoindex_documents_1') WHERE key=1", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?))).map_err(sql_error)?;
    if key != ("id".into(), 0, "BINARY".into()) {
        return Err(MigrationError::UnsupportedDatabase);
    }
    crate::storage_identity_transition::validate_metadata(connection)?;
    Ok(())
}

#[cfg(test)]
#[path = "identifier_migration/tests.rs"]
pub(crate) mod tests;
