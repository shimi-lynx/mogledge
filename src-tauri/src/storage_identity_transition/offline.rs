//! Stopped-profile transition protocol. The runtime lease and exclusive SQLite
//! lock prevent HTML saves while the owner reviews an explicit source/target.
use super::{CONFIRMATIONS_DDL, ROOTS_DDL, SCHEME};
use crate::{
    identifier_migration::{self, ManagementStore, MigrationError},
    knowledge,
    state_inspection::{self, management, recovery_store},
};
use cap_std::fs::Dir;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    ffi::OsString,
    fs::File,
    io::{BufRead, Read, Seek, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_CONFIG_FILES: usize = 4096;
const MAX_COMMAND_BYTES: usize = 16 * 1024;

#[path = "offline/recovery.rs"]
mod recovery;
#[path = "offline/ui.rs"]
pub mod ui;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
struct SealedFile {
    path: String,
    bytes: u64,
    hash: String,
}

struct Backup {
    path: PathBuf,
    dir: Arc<Dir>,
    files: Vec<SealedFile>,
    hash: String,
}

fn validate_database(connection: &rusqlite::Connection) -> Result<(), MigrationError> {
    let bytes: i64 = connection
        .query_row(
            "SELECT page_count*page_size FROM pragma_page_count(),pragma_page_size()",
            [],
            |r| r.get(0),
        )
        .map_err(super::sql)?;
    let deadline =
        super::budget::deadline(u64::try_from(bytes).map_err(|_| MigrationError::Corrupt)?);
    let cancellation = super::budget::cancellation();
    connection
        .progress_handler(
            1000,
            Some(move || {
                Instant::now() >= deadline
                    || cancellation
                        .as_ref()
                        .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire))
            }),
        )
        .map_err(super::sql)?;
    let result = identifier_migration::validate_db(connection);
    connection
        .progress_handler(0, None::<fn() -> bool>)
        .map_err(super::sql)?;
    result
}

fn io_error(_: impl std::fmt::Display) -> MigrationError {
    MigrationError::Unavailable
}
fn unsafe_path(_: impl std::fmt::Display) -> MigrationError {
    MigrationError::UnsafePath
}

fn digest_file(file: &File, maximum: u64) -> Result<(u64, String), MigrationError> {
    let mut file = file;
    file.rewind()?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes = 0_u64;
    let deadline = super::budget::deadline(file.metadata()?.len());
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes = bytes
            .checked_add(count as u64)
            .ok_or(MigrationError::Corrupt)?;
        if bytes > maximum || Instant::now() >= deadline || super::budget::cancelled() {
            return Err(MigrationError::Interrupted);
        }
        hash.update(&buffer[..count]);
    }
    Ok((bytes, format!("{:x}", hash.finalize())))
}

fn copy_file(
    source: &File,
    parent: &Dir,
    name: &str,
    maximum: u64,
) -> Result<(u64, String), MigrationError> {
    let mut source = source;
    source.rewind()?;
    let mut output = crate::write_fs::open_at(parent, name, false, true, false)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut bytes = 0_u64;
    let deadline = super::budget::deadline(source.metadata()?.len());
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        bytes = bytes
            .checked_add(count as u64)
            .ok_or(MigrationError::Corrupt)?;
        if bytes > maximum || Instant::now() >= deadline || super::budget::cancelled() {
            return Err(MigrationError::Interrupted);
        }
        output.write_all(&buffer[..count])?;
        hash.update(&buffer[..count]);
    }
    output.sync_all()?;
    // Drop the writer before the conservative read handle is opened. Neither
    // directory entries nor an unflushed partial file authorize migration.
    drop(output);
    identifier_migration::sync_directory(parent)?;
    let hash = format!("{:x}", hash.finalize());
    let copied = identifier_migration::read_file(parent, name, false)?;
    if digest_file(&copied, maximum)? != (bytes, hash.clone()) {
        return Err(MigrationError::SourceChanged);
    }
    Ok((bytes, hash))
}

fn subdirectory(parent: &Dir, name: &str) -> Result<Dir, MigrationError> {
    Ok(Dir::from_std_file(crate::write_fs::open_at(
        parent, name, true, false, false,
    )?))
}

fn config_files(config: &Dir) -> Result<Vec<SealedFile>, MigrationError> {
    config_files_except(config, None)
}
fn config_files_except(
    config: &Dir,
    ignored_temporary: Option<&str>,
) -> Result<Vec<SealedFile>, MigrationError> {
    let mut files = Vec::new();
    // Only persistent settings are copied. Search caches and the runtime lease
    // are regenerable/process state, never rollback input. Unknown entries in
    // the settings directory require a separate reviewed backup procedure.
    for entry in config.entries()? {
        let name = entry?
            .file_name()
            .into_string()
            .map_err(|_| MigrationError::UnsafePath)?;
        if ignored_temporary == Some(name.as_str())
            || crate::write_fs::unpublished_staging_name(&name)
        {
            continue;
        }
        if [
            "identifier-migration.lock",
            "document-state",
            "search-index",
            "identifier-migration-v1",
        ]
        .contains(&name.as_str())
        {
            continue;
        }
        if ![
            "settings.json",
            "resident.json",
            "workspace-settings",
            "tree-order",
        ]
        .contains(&name.as_str())
        {
            return Err(MigrationError::UnsafePath);
        }
        if identifier_migration::read_file(config, &name, false).is_ok() {
            if !matches!(name.as_str(), "settings.json" | "resident.json") {
                return Err(MigrationError::UnsafePath);
            }
            let file = identifier_migration::read_file(config, &name, false)?;
            let (bytes, hash) = digest_file(&file, MAX_CONFIG_BYTES)?;
            files.push(SealedFile {
                path: name,
                bytes,
                hash,
            });
        } else {
            if matches!(name.as_str(), "settings.json" | "resident.json") {
                return Err(MigrationError::UnsafePath);
            }
            let directory = subdirectory(config, &name)?;
            for entry in directory.entries()? {
                let leaf = entry?
                    .file_name()
                    .into_string()
                    .map_err(|_| MigrationError::UnsafePath)?;
                if crate::write_fs::unpublished_staging_name(&leaf) {
                    continue;
                }
                let stem = leaf
                    .strip_suffix(".json")
                    .ok_or(MigrationError::UnsafePath)?;
                if !matches!(stem.len(), 16 | 64)
                    || !stem
                        .bytes()
                        .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                {
                    return Err(MigrationError::UnsafePath);
                }
                let file = identifier_migration::read_file(&directory, &leaf, false)?;
                let (bytes, hash) = digest_file(&file, MAX_CONFIG_BYTES)?;
                files.push(SealedFile {
                    path: format!("{name}/{leaf}"),
                    bytes,
                    hash,
                });
                if files.len() > MAX_CONFIG_FILES {
                    return Err(MigrationError::Corrupt);
                }
            }
        }
    }
    files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    if files.len() > MAX_CONFIG_FILES
        || files.iter().map(|f| f.bytes).sum::<u64>() > 256 * 1024 * 1024
    {
        return Err(MigrationError::Corrupt);
    }
    Ok(files)
}

impl Backup {
    fn create(
        store: &ManagementStore,
        config_path: &Path,
        config: &Dir,
        parent_path: &Path,
        parent: &Arc<Dir>,
        operation: &str,
    ) -> Result<Self, MigrationError> {
        let guard = knowledge::RootReferenceGuard::open_profile_write(parent_path, parent)
            .map_err(unsafe_path)?;
        let name = format!("Mogledge-storage-backup-{operation}");
        crate::write_fs::mkdir(parent, &name)?;
        let path = parent_path.join(&name);
        let dir = Arc::new(subdirectory(parent, &name)?);
        crate::write_fs::mkdir(&dir, "database")?;
        crate::write_fs::mkdir(&dir, "config")?;
        let database = subdirectory(&dir, "database")?;
        let target_config = subdirectory(&dir, "config")?;
        let source = config_files(config)?;
        let (bytes, hash) = copy_file(
            store.database_file(),
            &database,
            "state.sqlite",
            crate::storage_limits::absolute_database_bytes()?,
        )?;
        let mut files = vec![SealedFile {
            path: "database/state.sqlite".into(),
            bytes,
            hash,
        }];
        if store.uses_identifier_bundle() {
            let bundle = subdirectory(store.profile_directory(), "identifier-migration-v1")?;
            let marker = identifier_migration::read_file(&bundle, "complete.json", false)?;
            crate::write_fs::mkdir(&dir, "layout")?;
            let layout = subdirectory(&dir, "layout")?;
            let (bytes, hash) = copy_file(&marker, &layout, "complete.json", MAX_CONFIG_BYTES)?;
            files.push(SealedFile {
                path: "layout/complete.json".into(),
                bytes,
                hash,
            });
        }
        let mut folders = BTreeSet::new();
        for item in &source {
            let (input, output, name) = if let Some((folder, leaf)) = item.path.split_once('/') {
                if folders.insert(folder.to_owned()) {
                    crate::write_fs::mkdir(&target_config, folder)?;
                }
                (
                    subdirectory(config, folder)?,
                    subdirectory(&target_config, folder)?,
                    leaf,
                )
            } else {
                (
                    config.try_clone()?,
                    target_config.try_clone()?,
                    item.path.as_str(),
                )
            };
            let file = identifier_migration::read_file(&input, name, false)?;
            let (bytes, hash) = copy_file(&file, &output, name, MAX_CONFIG_BYTES)?;
            if (bytes, hash.as_str()) != (item.bytes, item.hash.as_str()) {
                return Err(MigrationError::SourceChanged);
            }
            files.push(SealedFile {
                path: format!("config/{}", item.path),
                bytes,
                hash,
            });
        }
        if config_files(config)? != source {
            return Err(MigrationError::SourceChanged);
        }
        knowledge::RootReferenceGuard::open(config_path, &Arc::new(config.try_clone()?))
            .map_err(unsafe_path)?;
        store.verify()?;
        guard.revalidate(parent_path, parent).map_err(unsafe_path)?;
        files.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        let database_path = if store.uses_identifier_bundle() {
            "identifier-migration-v1/document-state/state.sqlite"
        } else {
            "document-state/state.sqlite"
        };
        let manifest=serde_json::to_vec(&json!({"version":1,"databaseRelativePath":database_path,"scope":"saved-state-and-device-settings","excluded":["search-index","runtime-lease","HTML","unpublished-app-staging"],"files":files})).map_err(io_error)?;
        let hash = format!("{:x}", Sha256::digest(&manifest));
        let mut output = crate::write_fs::open_at(&dir, "manifest.json", false, true, false)?;
        output.write_all(&manifest)?;
        output.sync_all()?;
        drop(output);
        identifier_migration::sync_directory(&dir)?;
        identifier_migration::sync_directory(parent)?;
        let backup = Self {
            path,
            dir,
            files,
            hash,
        };
        backup.verify()?;
        Ok(backup)
    }

    fn verify(&self) -> Result<(), MigrationError> {
        knowledge::RootReferenceGuard::open(&self.path, &self.dir).map_err(unsafe_path)?;
        let mut expected: BTreeSet<String> =
            self.files.iter().map(|item| item.path.clone()).collect();
        expected.insert("manifest.json".into());
        expected.insert("config".into());
        for path in expected.clone() {
            let mut current = path.as_str();
            while let Some((parent, _)) = current.rsplit_once('/') {
                expected.insert(parent.to_owned());
                current = parent;
            }
        }
        fn inventory(
            dir: &Dir,
            prefix: &str,
            expected: &mut BTreeSet<String>,
        ) -> Result<(), MigrationError> {
            for entry in dir.entries()? {
                let name = entry?
                    .file_name()
                    .into_string()
                    .map_err(|_| MigrationError::UnsafePath)?;
                let path = format!("{prefix}{name}");
                if !expected.remove(&path) {
                    return Err(MigrationError::SourceChanged);
                }
                if crate::write_fs::entry_is_directory(dir, &name)? {
                    inventory(&subdirectory(dir, &name)?, &format!("{path}/"), expected)?;
                }
            }
            Ok(())
        }
        inventory(&self.dir, "", &mut expected)?;
        if !expected.is_empty() {
            return Err(MigrationError::SourceChanged);
        }
        let manifest = identifier_migration::read_file(&self.dir, "manifest.json", false)?;
        if digest_file(&manifest, MAX_CONFIG_BYTES)?.1 != self.hash {
            return Err(MigrationError::SourceChanged);
        }
        for item in &self.files {
            let (parent, leaf) = item.path.rsplit_once('/').ok_or(MigrationError::Corrupt)?;
            let mut dir = self.dir.try_clone()?;
            for component in parent.split('/') {
                dir = subdirectory(&dir, component)?;
            }
            let file = identifier_migration::read_file(&dir, leaf, false)?;
            if digest_file(&file, crate::storage_limits::absolute_database_bytes()?)?
                != (item.bytes, item.hash.clone())
            {
                return Err(MigrationError::SourceChanged);
            }
        }
        Ok(())
    }

    fn verify_layout_source(&self, store: &ManagementStore) -> Result<(), MigrationError> {
        if let Some(marker) = self
            .files
            .iter()
            .find(|item| item.path == "layout/complete.json")
        {
            let bundle = subdirectory(store.profile_directory(), "identifier-migration-v1")?;
            let file = identifier_migration::read_file(&bundle, "complete.json", false)?;
            if digest_file(&file, MAX_CONFIG_BYTES)? != (marker.bytes, marker.hash.clone()) {
                return Err(MigrationError::SourceChanged);
            }
        }
        Ok(())
    }
}

enum Action {
    Root,
    Preferences {
        bytes: Vec<u8>,
        documents: Vec<crate::workspace_settings::DocumentRef>,
    },
    Rollback {
        source: Backup,
        settings: Vec<u8>,
    },
    Document {
        path: String,
        identity: String,
        source: Option<management::Record>,
    },
}
struct Plan {
    operation: String,
    action: Action,
    root: String,
    generation: i64,
    database_hash: String,
    config: Vec<SealedFile>,
    backup: Backup,
    expires: Instant,
}

struct Session {
    store: ManagementStore,
    config_path: PathBuf,
    config: Arc<Dir>,
    root_path: PathBuf,
    root: Arc<Dir>,
    backup_path: PathBuf,
    backup: Arc<Dir>,
    plan: Option<Plan>,
}
impl Session {
    fn open(
        profile: &Path,
        config_path: &Path,
        root: &Path,
        backup: &Path,
    ) -> Result<Self, MigrationError> {
        let store = identifier_migration::open_management_profile(profile)?;
        let (config_path, config) = knowledge::open_root(config_path).map_err(unsafe_path)?;
        knowledge::RootReferenceGuard::open_profile_write(&config_path, &config)
            .map_err(unsafe_path)?;
        let (root_path, root) = knowledge::open_root(root).map_err(unsafe_path)?;
        let (backup_path, backup) = knowledge::open_root(backup).map_err(unsafe_path)?;
        let profile = profile.canonicalize()?;
        for source in [&profile, &config_path, &root_path] {
            if backup_path.starts_with(source) || source.starts_with(&backup_path) {
                return Err(MigrationError::UnsafePath);
            }
        }
        config_files(&config)?;
        Ok(Self {
            store,
            config_path,
            config,
            root_path,
            root,
            backup_path,
            backup,
            plan: None,
        })
    }

    fn root_identity(&self) -> Result<String, MigrationError> {
        knowledge::RootReferenceGuard::open(&self.root_path, &self.root).map_err(unsafe_path)?;
        knowledge::storage_root_identity(&self.root).map_err(io_error)
    }
    fn document_identity(&self, path: &str) -> Result<String, MigrationError> {
        if !knowledge::is_html(path) {
            return Err(MigrationError::UnsafePath);
        }
        knowledge::storage_identity(&self.root_path, &self.root, path).map_err(unsafe_path)
    }
    fn generation(&self) -> Result<i64, MigrationError> {
        self.store
            .connection
            .query_row("SELECT generation FROM quota WHERE singleton=1", [], |r| {
                r.get(0)
            })
            .map_err(super::sql)
    }

    fn root_ready(&self, root: &str) -> Result<bool, MigrationError> {
        if !super::root_confirmed(&self.store.connection, root)? {
            return Ok(false);
        }
        let settings = self.settings_value()?;
        Ok(settings["knowledgeRootIdentityScheme"] == SCHEME
            && settings["knowledgeRootIdentity"].as_str() == Some(root))
    }

    fn prepare(
        &mut self,
        path: Option<&str>,
        source_id: Option<&str>,
    ) -> Result<Value, MigrationError> {
        self.store.verify()?;
        validate_database(&self.store.connection)?;
        let root = self.root_identity()?;
        let action = if let Some(path) = path {
            if !self.root_ready(&root)? {
                return Err(MigrationError::UnsupportedDatabase);
            }
            let identity = self.document_identity(path)?;
            if super::document_confirmed(&self.store.connection, &root, &identity)? {
                return Err(MigrationError::SourceChanged);
            }
            if recovery_store::is_quarantined(&self.store.connection, &identity)? {
                return Err(MigrationError::SourceChanged);
            }
            let exists: bool = self
                .store
                .connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1)",
                    [&identity],
                    |r| r.get(0),
                )
                .map_err(super::sql)?;
            if exists {
                return Err(MigrationError::SourceChanged);
            }
            let source = source_id
                .map(|id| {
                    management::read_record(&self.store.connection, id, false)
                        .map_err(|_| MigrationError::Corrupt)
                })
                .transpose()?;
            if let Some(source) = &source {
                if super::document_confirmed(&self.store.connection, &source.root, &source.id)?
                    || recovery_store::is_quarantined(&self.store.connection, &source.id)?
                {
                    return Err(MigrationError::SourceChanged);
                }
            }
            Action::Document {
                path: path.into(),
                identity,
                source,
            }
        } else {
            if source_id.is_some() {
                return Err(MigrationError::UnsafePath);
            }
            // Refuse an unusable/missing used-profile configuration before
            // creating a root preview; confirmation revalidates it again.
            self.settings_value()?;
            Action::Root
        };
        let operation = crate::core::random_token();
        let backup = Backup::create(
            &self.store,
            &self.config_path,
            &self.config,
            &self.backup_path,
            &self.backup,
            &operation,
        )?;
        let database_hash = backup
            .files
            .iter()
            .find(|f| f.path == "database/state.sqlite")
            .ok_or(MigrationError::Corrupt)?
            .hash
            .clone();
        let generation = self.generation()?;
        let config = config_files(&self.config)?;
        let preview = match &action {
            Action::Preferences { .. } | Action::Rollback { .. } => {
                return Err(MigrationError::SourceChanged)
            }
            Action::Root => {
                json!({"operation":"acknowledge_root","rootIdentity":root,"databaseSchemaVersion":super::version(&self.store.connection)?,"olderAppsWillReject":true,"legacyPreferencesRetained":true,"automaticPathMatching":false})
            }
            Action::Document {
                path,
                identity,
                source,
            } => {
                json!({"operation":if source.is_some(){"copy_selected_legacy"}else{"confirm_empty"},"rootIdentity":root,"targetRelativePath":path,"documentIdentity":identity,"sourceIdentity":source.as_ref().map(|r|&r.id),"sourceRevision":source.as_ref().map(|r|r.revision),"sourcePayloadHash":source.as_ref().map(|r|recovery_store::payload_hash(&r.data)),"sourceOwnership":"owner_confirmation_required_path_is_only_a_hint","sourceRetained":true,"existingTargetReplacement":false})
            }
        };
        let result = json!({"planId":operation,"preview":preview,"backupDirectory":backup.path.file_name().and_then(|name|name.to_str()),"backupManifestHash":backup.hash,"backupScope":"saved-state-and-device-settings","directoryFlushVerified":cfg!(unix),"expiresInMs":300000,"confirmation":format!("confirm:{operation}")});
        self.plan = Some(Plan {
            operation,
            action,
            root,
            generation,
            database_hash,
            config,
            backup,
            expires: Instant::now() + Duration::from_secs(300),
        });
        Ok(result)
    }

    fn check(&self, plan: &Plan) -> Result<(), MigrationError> {
        if super::budget::cancelled() {
            return Err(MigrationError::Interrupted);
        }
        if Instant::now() >= plan.expires
            || self.root_identity()? != plan.root
            || self.generation()? != plan.generation
        {
            return Err(MigrationError::SourceChanged);
        }
        if let Action::Document { path, identity, .. } = &plan.action {
            if self.document_identity(path)? != *identity {
                return Err(MigrationError::SourceChanged);
            }
        }
        self.store.verify()?;
        if digest_file(
            self.store.database_file(),
            crate::storage_limits::absolute_database_bytes()?,
        )?
        .1 != plan.database_hash
            || config_files(&self.config)? != plan.config
        {
            return Err(MigrationError::SourceChanged);
        }
        plan.backup.verify()?;
        plan.backup.verify_layout_source(&self.store)
    }

    fn confirm(&mut self, operation: &str, confirmation: &str) -> Result<Value, MigrationError> {
        self.confirm_with(operation, confirmation, || Ok(()), || {})
    }
    fn confirm_with(
        &mut self,
        operation: &str,
        confirmation: &str,
        before_commit: impl FnOnce() -> Result<(), MigrationError>,
        after_commit: impl FnOnce(),
    ) -> Result<Value, MigrationError> {
        if confirmation != format!("confirm:{operation}") {
            return Err(MigrationError::SourceChanged);
        }
        let mut plan = self.plan.take().ok_or(MigrationError::SourceChanged)?;
        if operation != plan.operation {
            self.plan = Some(plan);
            return Err(MigrationError::SourceChanged);
        }
        if Instant::now() >= plan.expires {
            return Err(MigrationError::SourceChanged);
        }
        // Five minutes bound the owner's review, not an arbitrarily large
        // valid database's confirmation I/O. Once acknowledged, retained
        // leases and all digest/identity checks still bind the whole operation.
        let mut work_bytes = plan
            .backup
            .files
            .iter()
            .try_fold(0_u64, |total, file| {
                total.checked_add(file.bytes).ok_or(MigrationError::Corrupt)
            })?
            .checked_add(
                self.store
                    .database_file()
                    .metadata()?
                    .len()
                    .checked_mul(6)
                    .ok_or(MigrationError::Corrupt)?,
            )
            .ok_or(MigrationError::Corrupt)?;
        if let Action::Rollback { source, .. } = &plan.action {
            work_bytes = source.files.iter().try_fold(work_bytes, |total, file| {
                total
                    .checked_add(file.bytes.checked_mul(4).ok_or(MigrationError::Corrupt)?)
                    .ok_or(MigrationError::Corrupt)
            })?;
        }
        plan.expires = super::budget::deadline(work_bytes);
        self.check(&plan)?;
        if matches!(
            plan.action,
            Action::Preferences { .. } | Action::Rollback { .. }
        ) {
            return self.confirm_recovery(plan);
        }
        let settings = self.settings_value()?;
        let legacy = settings
            .get("knowledgeRootIdentity")
            .and_then(Value::as_str)
            .unwrap_or("");
        // Prepare bounded publication before the irreversible DB decision.
        // Pretty-print expansion must never create an unreadable settings file.
        let publication = if matches!(plan.action, Action::Root) {
            Some(self.settings_publication(&plan, settings.clone())?)
        } else {
            None
        };
        self.store
            .connection
            .execute_batch("PRAGMA query_only=OFF;")
            .map_err(super::sql)?;
        let result = (|| {
            crate::storage_limits::cap_database(&self.store.connection)?;
            let transaction =
                recovery_store::begin_atomic(&self.store.connection).map_err(super::sql)?;
            let write = (|| {
                match &plan.action {
                    Action::Preferences { .. } | Action::Rollback { .. } => {
                        return Err(MigrationError::SourceChanged)
                    }
                    Action::Root => {
                        match super::version(&transaction)? {
                            1 => transaction
                                .execute_batch(&format!(
                                    "{};{};{ROOTS_DDL};{CONFIRMATIONS_DDL};PRAGMA user_version=3;",
                                    recovery_store::RECORDS_DDL,
                                    recovery_store::TOMBSTONES_DDL
                                ))
                                .map_err(super::sql)?,
                            2 => transaction
                                .execute_batch(&format!(
                                    "{ROOTS_DDL};{CONFIRMATIONS_DDL};PRAGMA user_version=3;"
                                ))
                                .map_err(super::sql)?,
                            3 => {}
                            _ => return Err(MigrationError::UnsupportedDatabase),
                        }
                        transaction.execute("INSERT INTO identity_roots VALUES(?1,?2,?3,?4,?5) ON CONFLICT(root) DO UPDATE SET operation=excluded.operation,backup_hash=excluded.backup_hash",params![plan.root,SCHEME,plan.operation,plan.backup.hash,legacy]).map_err(super::sql)?;
                    }
                    Action::Document {
                        path,
                        identity,
                        source,
                    } => {
                        if !super::root_confirmed(&transaction, &plan.root)?
                            || super::document_confirmed(&transaction, &plan.root, identity)?
                            || recovery_store::is_quarantined(&transaction, identity)?
                        {
                            return Err(MigrationError::SourceChanged);
                        }
                        let exists: bool = transaction
                            .query_row(
                                "SELECT EXISTS(SELECT 1 FROM documents WHERE id=?1)",
                                [identity],
                                |r| r.get(0),
                            )
                            .map_err(super::sql)?;
                        if exists {
                            return Err(MigrationError::SourceChanged);
                        }
                        let (total, count, generation): (i64, i64, i64) = transaction
                            .query_row(
                                "SELECT bytes,documents,generation FROM quota WHERE singleton=1",
                                [],
                                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                            )
                            .map_err(super::sql)?;
                        let next_generation =
                            generation.checked_add(1).ok_or(MigrationError::Corrupt)?;
                        if let Some(source) = source {
                            let current = management::read_record(&transaction, &source.id, false)
                                .map_err(|_| MigrationError::SourceChanged)?;
                            if current.revision != source.revision
                                || current.generation != source.generation
                                || current.root != source.root
                                || current.path != source.path
                                || current.bytes != source.bytes
                                || current.data != source.data
                                || recovery_store::is_quarantined(&transaction, &source.id)?
                            {
                                return Err(MigrationError::SourceChanged);
                            }
                            let limits = crate::storage_limits::read(&transaction)?;
                            let bytes = total
                                .checked_add(source.bytes)
                                .ok_or(MigrationError::Corrupt)?;
                            let count = count.checked_add(1).ok_or(MigrationError::Corrupt)?;
                            if source.bytes > limits.document_bytes as i64
                                || bytes > limits.total_bytes
                                || count > 4096
                            {
                                return Err(MigrationError::CapacityExceeded);
                            }
                            transaction
                                .execute(
                                    "INSERT INTO documents VALUES(?1,?2,?3,1,?4,?5,?6)",
                                    params![
                                        identity,
                                        source.data,
                                        source.bytes,
                                        plan.root,
                                        path,
                                        next_generation
                                    ],
                                )
                                .map_err(super::sql)?;
                            transaction.execute("UPDATE quota SET bytes=?1,documents=?2,generation=?3 WHERE singleton=1",params![bytes,count,next_generation]).map_err(super::sql)?;
                        } else {
                            transaction
                                .execute(
                                    "UPDATE quota SET generation=?1 WHERE singleton=1",
                                    [next_generation],
                                )
                                .map_err(super::sql)?;
                        }
                        transaction.execute("INSERT INTO identity_confirmations VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",params![identity,plan.root,SCHEME,plan.operation,source.as_ref().map_or("",|r|r.id.as_str()),source.as_ref().map_or(0,|r|r.revision),source.as_ref().map_or(String::new(),|r|recovery_store::payload_hash(&r.data)),next_generation]).map_err(super::sql)?;
                    }
                }
                validate_database(&transaction)?;
                self.store.verify_identity()?;
                if self.root_identity()? != plan.root || Instant::now() >= plan.expires {
                    return Err(MigrationError::SourceChanged);
                }
                if let Action::Document { path, identity, .. } = &plan.action {
                    if self.document_identity(path)? != *identity {
                        return Err(MigrationError::SourceChanged);
                    }
                }
                if config_files(&self.config)? != plan.config {
                    return Err(MigrationError::SourceChanged);
                }
                plan.backup.verify()?;
                plan.backup.verify_layout_source(&self.store)?;
                before_commit()?;
                if super::budget::cancelled() {
                    return Err(MigrationError::Interrupted);
                }
                Ok(())
            })();
            // Never allow a cancelled validation to cancel its own rollback.
            transaction
                .progress_handler(0, None::<fn() -> bool>)
                .map_err(super::sql)?;
            if let Err(error) = write {
                transaction.finish().map_err(super::sql)?;
                return Err(error);
            }
            transaction.commit().map_err(super::sql)
        })();
        self.store
            .connection
            .execute_batch("PRAGMA query_only=ON;")
            .map_err(super::sql)?;
        result?;
        after_commit();
        let mut settings_published = false;
        if let Some(bytes) = publication {
            // SQLite's durable decision is authoritative. Publishing settings
            // last makes a crash an explicit hold, never an implicit new DB.
            settings_published = self.publish_settings(&plan, &bytes).is_ok();
        }
        Ok(
            json!({"operationId":operation,"status":"committed","schemaVersion":3,"settingsPublished":settings_published,"sourceRetained":true,"backupRetained":true,"permanentDeletion":false}),
        )
    }

    fn settings_value(&self) -> Result<Value, MigrationError> {
        let mut file = match identifier_migration::read_file(&self.config, "settings.json", false) {
            Ok(file) => file,
            Err(_)
                if self
                    .config
                    .symlink_metadata("settings.json")
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                    && self.unused_profile_without_root_settings()? =>
            {
                return Ok(json!({"knowledgeRoot":self.root_path}))
            }
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_CONFIG_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err(MigrationError::Corrupt);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| MigrationError::Corrupt)?;
        crate::root_recovery::SavedRoot::parse(&value).map_err(|_| MigrationError::Corrupt)?;
        Ok(value)
    }
    fn unused_profile_without_root_settings(&self) -> Result<bool, MigrationError> {
        // Absence is not a failed restoration. Only a never-used v1 database
        // can start a new root; v2/v3 recovery/confirmation metadata is retained.
        if super::version(&self.store.connection)? != 1 {
            return Ok(false);
        }
        let unused = self.store.connection.query_row(
            "SELECT bytes=0 AND documents=0 AND generation=0 AND NOT EXISTS(SELECT 1 FROM documents) FROM quota WHERE singleton=1",
            [], |row| row.get::<_, bool>(0),
        ).map_err(super::sql)?;
        let files = config_files(&self.config)?;
        if !unused || files.iter().any(|file| file.path != "resident.json") {
            return Ok(false);
        }
        if files.is_empty() {
            return Ok(true);
        }
        let mut bytes = Vec::new();
        identifier_migration::read_file(&self.config, "resident.json", false)?
            .take(16 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 16 * 1024 {
            return Err(MigrationError::Corrupt);
        }
        let preferences: crate::resident_model::Preferences =
            serde_json::from_slice(&bytes).map_err(|_| MigrationError::Corrupt)?;
        // A pinned document is evidence of a previously selected root. Keep
        // that state held; ordinary first-launch preferences are backed up.
        if !preferences.valid()
            || !matches!(preferences.target, crate::resident_model::Target::Current)
        {
            return Err(MigrationError::Corrupt);
        }
        Ok(true)
    }
    fn settings_publication(
        &self,
        plan: &Plan,
        mut settings: Value,
    ) -> Result<Vec<u8>, MigrationError> {
        let map = settings.as_object_mut().ok_or(MigrationError::Corrupt)?;
        map.insert("knowledgeRoot".into(), json!(self.root_path));
        map.insert("knowledgeRootIdentity".into(), json!(plan.root));
        map.insert("knowledgeRootIdentityScheme".into(), json!(SCHEME));
        let bytes = serde_json::to_vec_pretty(&settings).map_err(io_error)?;
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err(MigrationError::CapacityExceeded);
        }
        Ok(bytes)
    }
    fn publish_settings(&self, plan: &Plan, bytes: &[u8]) -> Result<(), MigrationError> {
        if config_files(&self.config)? != plan.config
            || !super::root_confirmed(&self.store.connection, &plan.root)?
        {
            return Err(MigrationError::SourceChanged);
        }
        let guard =
            knowledge::RootReferenceGuard::open_profile_write(&self.config_path, &self.config)
                .map_err(unsafe_path)?;
        let (temporary, mut file) = crate::write_fs::create_temporary(&self.config)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if config_files_except(&self.config, Some(&temporary))? != plan.config {
            return Err(MigrationError::SourceChanged);
        }
        guard
            .revalidate(&self.config_path, &self.config)
            .map_err(unsafe_path)?;
        crate::write_fs::replace_profile_settings(&self.config, &temporary, &file)?;
        identifier_migration::sync_directory(&self.config)?;
        Ok(())
    }

    fn inspect(&self) -> Result<Value, MigrationError> {
        self.store.verify()?;
        validate_database(&self.store.connection)?;
        let mut statement = self
            .store
            .connection
            .prepare("SELECT id,root,path,revision,bytes FROM documents ORDER BY id LIMIT 4097")
            .map_err(super::sql)?;
        let entries=statement.query_map([],|r|Ok(json!({"documentIdentity":r.get::<_,String>(0)?,"rootIdentity":r.get::<_,String>(1)?,"relativePathHint":r.get::<_,String>(2)?,"revision":r.get::<_,i64>(3)?,"bytes":r.get::<_,i64>(4)?}))).map_err(super::sql)?.collect::<Result<Vec<_>,_>>().map_err(super::sql)?;
        Ok(
            json!({"schemaVersion":super::version(&self.store.connection)?,"rootIdentity":self.root_identity()?,"rootConfirmed":self.root_ready(&self.root_identity()?)?,"entries":entries,"payloadsIncluded":false,"automaticAssignment":false}),
        )
    }
}

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case", deny_unknown_fields)]
enum Command {
    Inspect,
    PrepareRoot,
    PrepareDocument {
        relative_path: String,
        source_identity: Option<String>,
    },
    Confirm {
        plan_id: String,
        confirmation: String,
    },
    OperationStatus {
        operation_id: String,
    },
    Quit,
}

/// Explicit arguments name the local-data profile, settings directory, current
/// root and an existing ordinary backup directory. No path is auto-discovered.
pub fn run_cli(
    args: impl IntoIterator<Item = OsString>,
    input: &mut impl BufRead,
    output: &mut impl Write,
) -> i32 {
    if !super::enabled() {
        let _ = writeln!(
            output,
            "{}",
            json!({"error":"native_identity_disabled","message":"Default builds keep the legacy identity. Native Mac reboot and volume QA is required before enabling this experimental transition."})
        );
        return 2;
    }
    let args = args.into_iter().collect::<Vec<_>>();
    if args.len() != 4 {
        let _ = writeln!(
            output,
            "{}",
            json!({"error":"arguments_required","usage":"storage-identity-cli <local-data-profile> <settings-directory> <selected-root> <backup-parent>"})
        );
        return 2;
    }
    let mut session = match Session::open(
        Path::new(&args[0]),
        Path::new(&args[1]),
        Path::new(&args[2]),
        Path::new(&args[3]),
    ) {
        Ok(value) => value,
        Err(error) => {
            let _ = writeln!(
                output,
                "{}",
                json!({"error":state_inspection::backend_error(error).code})
            );
            return 1;
        }
    };
    for _ in 0..4096 {
        let mut line = Vec::new();
        match (&mut *input)
            .take((MAX_COMMAND_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
        {
            Ok(0) => return 0,
            Ok(_) if line.len() <= MAX_COMMAND_BYTES => {}
            _ => return 1,
        }
        let command = match serde_json::from_slice::<Command>(&line) {
            Ok(command) => command,
            Err(_) => {
                let _ = writeln!(output, "{}", json!({"error":"invalid_command"}));
                continue;
            }
        };
        let result = match command {
            Command::Inspect => session.inspect(),
            Command::PrepareRoot => session.prepare(None, None),
            Command::PrepareDocument {
                relative_path,
                source_identity,
            } => session.prepare(Some(&relative_path), source_identity.as_deref()),
            Command::Confirm {
                plan_id,
                confirmation,
            } => session.confirm(&plan_id, &confirmation),
            Command::OperationStatus { operation_id } => session.operation_status(&operation_id),
            Command::Quit => return 0,
        };
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                json!({"error":state_inspection::backend_error(error).code,"existingDataRetained":true,"retryRequiresNewPreview":true})
            }
        };
        if writeln!(output, "{value}")
            .and_then(|_| output.flush())
            .is_err()
        {
            return 1;
        }
    }
    1
}

#[cfg(test)]
#[path = "offline/tests.rs"]
mod tests;
