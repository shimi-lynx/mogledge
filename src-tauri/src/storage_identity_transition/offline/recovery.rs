//! Explicit stopped-profile preference copy and rollback. Restore SQLite into
//! its existing inode/lease; never swap the file beneath an open connection.
use super::*;

fn token(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn read_bytes(dir: &Dir, leaf: &str) -> Result<Vec<u8>, MigrationError> {
    let mut file = identifier_migration::read_file(dir, leaf, false)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(MigrationError::Corrupt);
    }
    Ok(bytes)
}

impl Backup {
    fn load(parent_path: &Path, parent: &Arc<Dir>, name: &str) -> Result<Self, MigrationError> {
        let nonce = name
            .strip_prefix("Mogledge-storage-backup-")
            .ok_or(MigrationError::UnsafePath)?;
        if !token(nonce) {
            return Err(MigrationError::UnsafePath);
        }
        let dir = Arc::new(subdirectory(parent, name)?);
        let bytes = read_bytes(&dir, "manifest.json")?;
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Manifest {
            version: u32,
            database_relative_path: String,
            scope: String,
            excluded: Vec<String>,
            files: Vec<SealedFile>,
        }
        let manifest: Manifest =
            serde_json::from_slice(&bytes).map_err(|_| MigrationError::Corrupt)?;
        if manifest.version != 1
            || manifest.scope != "saved-state-and-device-settings"
            || !matches!(
                manifest.database_relative_path.as_str(),
                "document-state/state.sqlite"
                    | "identifier-migration-v1/document-state/state.sqlite"
            )
            || manifest.excluded
                != [
                    "search-index",
                    "runtime-lease",
                    "HTML",
                    "unpublished-app-staging",
                ]
            || manifest.files.len() > MAX_CONFIG_FILES + 2
        {
            return Err(MigrationError::Corrupt);
        }
        let mut seen = BTreeSet::new();
        for file in &manifest.files {
            if !token(&file.hash) || !seen.insert(file.path.clone()) {
                return Err(MigrationError::Corrupt);
            }
            match file.path.as_str() {
                "database/state.sqlite" => {
                    if file.bytes > crate::storage_limits::absolute_database_bytes()? {
                        return Err(MigrationError::Corrupt);
                    }
                }
                "layout/complete.json" | "config/settings.json" | "config/resident.json" => {
                    if file.bytes > MAX_CONFIG_BYTES {
                        return Err(MigrationError::Corrupt);
                    }
                }
                path => {
                    let rest = path
                        .strip_prefix("config/")
                        .ok_or(MigrationError::Corrupt)?;
                    let (folder, leaf) = rest.split_once('/').ok_or(MigrationError::Corrupt)?;
                    let stem = leaf.strip_suffix(".json").ok_or(MigrationError::Corrupt)?;
                    if !matches!(folder, "tree-order" | "workspace-settings")
                        || !matches!(stem.len(), 16 | 64)
                        || !stem
                            .bytes()
                            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
                        || file.bytes > MAX_CONFIG_BYTES
                    {
                        return Err(MigrationError::Corrupt);
                    }
                }
            }
        }
        if !seen.contains("database/state.sqlite") || !seen.contains("config/settings.json") {
            return Err(MigrationError::Corrupt);
        }
        let backup = Self {
            path: parent_path.join(name),
            dir,
            files: manifest.files,
            hash: format!("{:x}", Sha256::digest(bytes)),
        };
        backup.verify()?;
        Ok(backup)
    }
}

impl Session {
    fn recovery_plan(&mut self, action: Action, preview: Value) -> Result<Value, MigrationError> {
        self.plan = None;
        self.store.verify()?;
        validate_database(&self.store.connection)?;
        let root = self.root_identity()?;
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
        let result = json!({"planId":operation,"preview":preview,"backupDirectory":backup.path.file_name().and_then(|n|n.to_str()),"backupManifestHash":backup.hash,"backupScope":"saved-state-and-device-settings","directoryFlushVerified":cfg!(unix),"expiresInMs":300000,"confirmation":format!("confirm:{operation}")});
        self.plan = Some(Plan {
            operation,
            action,
            root,
            generation: self.generation()?,
            database_hash,
            config: config_files(&self.config)?,
            backup,
            expires: Instant::now() + Duration::from_secs(300),
        });
        Ok(result)
    }
    pub(super) fn prepare_preferences(
        &mut self,
        source_root: &str,
    ) -> Result<Value, MigrationError> {
        self.plan = None;
        if !token(source_root) {
            return Err(MigrationError::UnsafePath);
        }
        let root = self.root_identity()?;
        if !self.root_ready(&root)? {
            return Err(MigrationError::SourceChanged);
        }
        let folder = subdirectory(&self.config, "workspace-settings")?;
        let target = format!("{root}.json");
        let exists = folder.entries()?.any(|entry| {
            entry.map_or(true, |entry| {
                entry.file_name() == std::ffi::OsStr::new(&target)
            })
        });
        let source = read_bytes(&folder, &format!("{source_root}.json"))?;
        let prepared = super::super::preferences::prepare(
            &self.store.connection,
            source_root,
            &root,
            &source,
            exists,
        )?;
        for document in &prepared.mapped_documents {
            if self.document_identity(&document.relative_path)? != document.identity {
                return Err(MigrationError::SourceChanged);
            }
        }
        let mut preview = prepared.preview;
        preview["operation"] = json!("restore_preferences");
        preview["sourceRootIdentity"] = json!(source_root);
        preview["targetRootIdentity"] = json!(root);
        preview["pathOwnership"] = json!("owner_confirmation_required");
        preview["files"] = json!([{"relativePath":format!("workspace-settings/{source_root}.json"),"bytes":source.len(),"sha256":format!("{:x}",Sha256::digest(&source))}]);
        self.recovery_plan(
            Action::Preferences {
                bytes: prepared.bytes,
                documents: prepared.mapped_documents,
            },
            preview,
        )
    }
    pub(super) fn prepare_rollback(&mut self, directory: &str) -> Result<Value, MigrationError> {
        self.plan = None;
        let source = Backup::load(&self.backup_path, &self.backup, directory)?;
        source.verify_layout_source(&self.store)?;
        let config = subdirectory(&source.dir, "config")?;
        let settings = read_bytes(&config, "settings.json")?;
        let parsed: Value =
            serde_json::from_slice(&settings).map_err(|_| MigrationError::Corrupt)?;
        let saved =
            crate::root_recovery::SavedRoot::parse(&parsed).map_err(|_| MigrationError::Corrupt)?;
        let current = self.settings_value()?;
        let current_saved = crate::root_recovery::SavedRoot::parse(&current)
            .map_err(|_| MigrationError::Corrupt)?;
        // Only this selected workspace can be rolled back. A foreign backup
        // cannot repoint the app, even after a user mistypes its basename.
        let (backup_root_path, backup_root) =
            knowledge::open_root(&saved.path).map_err(unsafe_path)?;
        let (current_root_path, current_root) =
            knowledge::open_root(&current_saved.path).map_err(unsafe_path)?;
        if backup_root_path != self.root_path
            || current_root_path != self.root_path
            || !knowledge::same_directory(&backup_root, &self.root).map_err(io_error)?
            || !knowledge::same_directory(&current_root, &self.root).map_err(io_error)?
            || saved.identity.is_none()
            || saved.scheme.is_some()
        {
            return Err(MigrationError::SourceChanged);
        }
        let current_files = config_files(&self.config)?;
        // Recovery leaves old prefs intact. Refuse edits to any original
        // non-settings leaf; new target preference copies remain inactive.
        for old in source
            .files
            .iter()
            .filter(|file| file.path.starts_with("config/") && file.path != "config/settings.json")
        {
            let path = old.path.strip_prefix("config/").unwrap();
            if !current_files
                .iter()
                .any(|now| now.path == path && now.bytes == old.bytes && now.hash == old.hash)
            {
                return Err(MigrationError::SourceChanged);
            }
        }
        for now in &current_files {
            if now.path != "settings.json"
                && !source
                    .files
                    .iter()
                    .any(|old| old.path == format!("config/{}", now.path))
                && now.path != format!("workspace-settings/{}.json", self.root_identity()?)
            {
                return Err(MigrationError::SourceChanged);
            }
        }
        let (database, guard) = identifier_migration::open_database_guarded(
            &source.path.join("database/state.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        database
            .execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
            .map_err(super::super::sql)?;
        validate_database(&database)?;
        let version = super::super::version(&database)?;
        if !matches!(version, 1 | 2) {
            return Err(MigrationError::UnsupportedDatabase);
        }
        drop(database);
        drop(guard);
        let preview = json!({"operation":"rollback","backupDirectory":directory,"backupManifestHash":source.hash,"currentFormatWillBeReplaced":true,"keepCurrentBackup":true,"olderAppsMayResume":true,"sourceRetained":true,"inactivePreferenceCopiesRetained":true,"changedOriginalPreferencesAllowed":false,"targetSchemaVersion":version});
        self.recovery_plan(Action::Rollback { source, settings }, preview)
    }

    pub(super) fn confirm_recovery(&self, plan: Plan) -> Result<Value, MigrationError> {
        let settings_published;
        let (status, version) = match &plan.action {
            Action::Preferences { bytes, documents } => {
                if !super::super::root_confirmed(&self.store.connection, &plan.root)? {
                    return Err(MigrationError::SourceChanged);
                }
                for document in documents {
                    if self.document_identity(&document.relative_path)? != document.identity {
                        return Err(MigrationError::SourceChanged);
                    }
                }
                let guard = knowledge::RootReferenceGuard::open_profile_write(
                    &self.config_path,
                    &self.config,
                )
                .map_err(unsafe_path)?;
                let folder = subdirectory(&self.config, "workspace-settings")?;
                let (name, mut file) = crate::write_fs::create_temporary(&folder)?;
                file.write_all(bytes)?;
                file.sync_all()?;
                self.check(&plan)?;
                guard
                    .revalidate(&self.config_path, &self.config)
                    .map_err(unsafe_path)?;
                for document in documents {
                    if self.document_identity(&document.relative_path)? != document.identity {
                        return Err(MigrationError::SourceChanged);
                    }
                }
                crate::write_fs::rename_noreplace(
                    &folder,
                    &name,
                    &folder,
                    &format!("{}.json", plan.root),
                    &file,
                )?;
                // Once rename commits, even directory-flush failure is a
                // known publication requiring status inspection, not retry.
                settings_published = identifier_migration::sync_directory(&folder).is_ok();
                ("committed", 3)
            }
            Action::Rollback { source, settings } => {
                source.verify()?;
                source.verify_layout_source(&self.store)?;
                let (database, guard) = identifier_migration::open_database_guarded(
                    &source.path.join("database/state.sqlite"),
                    rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                )?;
                database
                    .execute_batch(
                        "PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN DEFERRED;",
                    )
                    .map_err(super::super::sql)?;
                validate_database(&database)?;
                let version = super::super::version(&database)?;
                self.check(&plan)?;
                // Retained read transaction fences SQLite writers; do not
                // reopen/close same-inode raw fds while its POSIX locks live.
                self.store
                    .connection
                    .execute_batch("PRAGMA query_only=OFF;")
                    .map_err(super::super::sql)?;
                let copied = restore_database_with(
                    &self.store.connection,
                    &database,
                    plan.expires,
                    || {
                        self.store.verify_identity()?;
                        knowledge::RootReferenceGuard::open(&self.config_path, &self.config)
                            .map_err(unsafe_path)?;
                        knowledge::RootReferenceGuard::open(&source.path, &source.dir)
                            .map_err(unsafe_path)?;
                        plan.backup.verify()?;
                        if Instant::now() >= plan.expires
                            || self.root_identity()? != plan.root
                            || config_files(&self.config)? != plan.config
                        {
                            return Err(MigrationError::SourceChanged);
                        }
                        source.verify_layout_source(&self.store)
                    },
                    || {},
                );
                self.store
                    .connection
                    .execute_batch("PRAGMA query_only=ON;")
                    .map_err(super::super::sql)?;
                drop(database);
                drop(guard);
                copied?;
                // DB restore is atomic, settings are last. On publication
                // failure both backups survive and the new-format marker
                // keeps this app held until another explicit repair preview.
                settings_published = self.publish_rollback_settings(&plan, settings).is_ok();
                ("rolled_back", version)
            }
            _ => return Err(MigrationError::SourceChanged),
        };
        let result = json!({"operationId":plan.operation,"status":status,"schemaVersion":version,"settingsPublished":settings_published,"settingsMatchRoot":settings_published,"sourceRetained":true,"backupRetained":true,"permanentDeletion":false,"restartRequired":status=="rolled_back"});
        // Receipt outside the profile cannot alter legacy/schema validation.
        // A missing/crash-interrupted receipt stays unknown, never auto-retry.
        let _ = self.write_receipt(&plan, &result);
        Ok(result)
    }
    fn publish_rollback_settings(&self, plan: &Plan, bytes: &[u8]) -> Result<(), MigrationError> {
        if config_files(&self.config)? != plan.config {
            return Err(MigrationError::SourceChanged);
        }
        self.store.verify()?;
        let guard =
            knowledge::RootReferenceGuard::open_profile_write(&self.config_path, &self.config)
                .map_err(unsafe_path)?;
        let (name, mut file) = crate::write_fs::create_temporary(&self.config)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        if config_files(&self.config)? != plan.config {
            return Err(MigrationError::SourceChanged);
        }
        guard
            .revalidate(&self.config_path, &self.config)
            .map_err(unsafe_path)?;
        crate::write_fs::replace_profile_settings(&self.config, &name, &file)?;
        identifier_migration::sync_directory(&self.config)
    }
    fn write_receipt(&self, plan: &Plan, value: &Value) -> Result<(), MigrationError> {
        let guard =
            knowledge::RootReferenceGuard::open_profile_write(&self.backup_path, &self.backup)
                .map_err(unsafe_path)?;
        let bytes=serde_json::to_vec(&json!({"result":value,"databaseHash":digest_file(self.store.database_file(),crate::storage_limits::absolute_database_bytes()?)?.1,"config":config_files(&self.config)?,"root":plan.root,"currentBackup":plan.backup.path.file_name().and_then(|n|n.to_str()),"currentBackupHash":plan.backup.hash})).map_err(io_error)?;
        let (name, mut file) = crate::write_fs::create_temporary(&self.backup)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        guard
            .revalidate(&self.backup_path, &self.backup)
            .map_err(unsafe_path)?;
        crate::write_fs::rename_noreplace(
            &self.backup,
            &name,
            &self.backup,
            &format!("Mogledge-storage-operation-{}.json", plan.operation),
            &file,
        )?;
        identifier_migration::sync_directory(&self.backup)
    }
    pub(super) fn operation_status(&self, operation: &str) -> Result<Value, MigrationError> {
        if !token(operation) {
            return Err(MigrationError::UnsafePath);
        }
        if super::super::operation_completed(&self.store.connection, operation)? {
            return Ok(
                json!({"status":"committed","settingsMatchRoot":self.settings_value().ok().is_some_and(|value|value["knowledgeRootIdentityScheme"]==SCHEME&&value["knowledgeRootIdentity"].as_str()==self.root_identity().ok().as_deref())}),
            );
        }
        knowledge::RootReferenceGuard::open(&self.backup_path, &self.backup)
            .map_err(unsafe_path)?;
        let value = read_bytes(
            &self.backup,
            &format!("Mogledge-storage-operation-{operation}.json"),
        )
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
        if let Some(value) = value {
            let config: Vec<SealedFile> = serde_json::from_value(value["config"].clone())
                .map_err(|_| MigrationError::Corrupt)?;
            let backup = Backup::load(
                &self.backup_path,
                &self.backup,
                value["currentBackup"]
                    .as_str()
                    .ok_or(MigrationError::Corrupt)?,
            )?;
            if value["root"].as_str() == Some(&self.root_identity()?)
                && value["result"]["operationId"] == operation
                && value["currentBackupHash"] == backup.hash
                && value["databaseHash"]
                    == digest_file(
                        self.store.database_file(),
                        crate::storage_limits::absolute_database_bytes()?,
                    )?
                    .1
                && config == config_files(&self.config)?
            {
                return Ok(value["result"].clone());
            }
        }
        Ok(json!({"status":"unknown","settingsMatchRoot":false}))
    }
}

fn restore_database_with(
    destination: &rusqlite::Connection,
    source: &rusqlite::Connection,
    deadline: Instant,
    mut before_commit: impl FnMut() -> Result<(), MigrationError>,
    mut after_step: impl FnMut(),
) -> Result<(), MigrationError> {
    struct BackupHandle(*mut rusqlite::ffi::sqlite3_backup);
    impl Drop for BackupHandle {
        fn drop(&mut self) {
            unsafe {
                rusqlite::ffi::sqlite3_backup_finish(self.0);
            }
        }
    }
    // SQLite owns the pager transaction and rolls back unfinished copies;
    // raw pointers live only while both borrowed connections are retained.
    let pointer = unsafe {
        rusqlite::ffi::sqlite3_backup_init(
            destination.handle(),
            c"main".as_ptr(),
            source.handle(),
            c"main".as_ptr(),
        )
    };
    if pointer.is_null() {
        return Err(MigrationError::Unavailable);
    }
    let handle = BackupHandle(pointer);
    loop {
        if super::super::budget::cancelled() || Instant::now() >= deadline {
            return Err(MigrationError::Interrupted);
        }
        // DONE commits inside step(), so validate the fixed source/config/root
        // immediately before the final chunk, never after publication.
        if unsafe { rusqlite::ffi::sqlite3_backup_remaining(handle.0) } <= 64 {
            before_commit()?;
        }
        if super::super::budget::cancelled() || Instant::now() >= deadline {
            return Err(MigrationError::Interrupted);
        }
        let code = unsafe { rusqlite::ffi::sqlite3_backup_step(handle.0, 64) };
        match code {
            rusqlite::ffi::SQLITE_DONE => break,
            rusqlite::ffi::SQLITE_OK => after_step(),
            rusqlite::ffi::SQLITE_BUSY | rusqlite::ffi::SQLITE_LOCKED => {
                return Err(MigrationError::Busy)
            }
            rusqlite::ffi::SQLITE_FULL => return Err(MigrationError::CapacityExceeded),
            _ => return Err(MigrationError::Unavailable),
        }
    }
    let code = unsafe { rusqlite::ffi::sqlite3_backup_finish(handle.0) };
    std::mem::forget(handle);
    if code != rusqlite::ffi::SQLITE_OK {
        return Err(MigrationError::Unavailable);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_during_final_binding_check_prevents_pager_commit() {
        let source = rusqlite::Connection::open_in_memory().unwrap();
        source
            .execute_batch("CREATE TABLE copied(value TEXT); INSERT INTO copied VALUES('new');")
            .unwrap();
        let destination = rusqlite::Connection::open_in_memory().unwrap();
        destination
            .execute_batch(
                "CREATE TABLE original(value TEXT); INSERT INTO original VALUES('keep');",
            )
            .unwrap();
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let result = super::super::super::budget::with_cancellation(flag.clone(), || {
            restore_database_with(
                &destination,
                &source,
                super::super::super::budget::deadline(16384),
                || {
                    flag.store(true, std::sync::atomic::Ordering::Release);
                    Ok(())
                },
                || {},
            )
        });
        assert!(matches!(result, Err(MigrationError::Interrupted)));
        assert_eq!(
            destination
                .query_row("SELECT value FROM original", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "keep"
        );
    }
    #[test]
    fn changed_binding_before_final_pager_chunk_rolls_back_the_entire_restore() {
        let source = rusqlite::Connection::open_in_memory().unwrap();
        source.execute_batch("CREATE TABLE copied(value BLOB); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO copied SELECT zeroblob(4096) FROM n;").unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.sqlite");
        let destination = rusqlite::Connection::open(&path).unwrap();
        destination
            .execute_batch(
                "CREATE TABLE original(value TEXT); INSERT INTO original VALUES('keep');",
            )
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let mut checks = 0;
        let result = restore_database_with(
            &destination,
            &source,
            super::super::super::budget::deadline(512 * 1024),
            || {
                checks += 1;
                if checks > 1 {
                    Err(MigrationError::SourceChanged)
                } else {
                    Ok(())
                }
            },
            || {},
        );
        assert!(matches!(result, Err(MigrationError::SourceChanged)));
        assert_eq!(checks, 2);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
    #[test]
    fn cancelling_a_partial_pager_restore_keeps_the_original_database() {
        let source = rusqlite::Connection::open_in_memory().unwrap();
        source.execute_batch("CREATE TABLE copied(value BLOB); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO copied SELECT zeroblob(4096) FROM n;").unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("state.sqlite");
        let destination = rusqlite::Connection::open(&path).unwrap();
        destination
            .execute_batch(
                "CREATE TABLE original(value TEXT); INSERT INTO original VALUES('keep');",
            )
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let result = super::super::super::budget::with_cancellation(flag.clone(), || {
            restore_database_with(
                &destination,
                &source,
                super::super::super::budget::deadline(512 * 1024),
                || Ok(()),
                || flag.store(true, std::sync::atomic::Ordering::Release),
            )
        });
        assert!(matches!(result, Err(MigrationError::Interrupted)));
        assert_eq!(
            destination
                .query_row("SELECT value FROM original", [], |row| row
                    .get::<_, String>(0))
                .unwrap(),
            "keep"
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}
