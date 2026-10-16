use super::*;
use crate::{
    core::Core,
    document_server,
    document_state::{self, DocumentState, StateRequest},
};
use serde_json::{json, Value};
use std::fs;
use tempfile::TempDir;

#[test]
fn current_profile_never_inspects_or_imports_legacy_siblings_and_holds_its_lease() {
    let temp = TempDir::new().unwrap();
    let base = temp.path().canonicalize().unwrap();
    // Non-directory old identifiers would fail legacy probing; the current-only path ignores them.
    for identifier in [LEGACY_IDENTIFIER, LEGACY_PRODUCT_IDENTIFIER] {
        fs::write(base.join(identifier), b"untouched old profile sentinel").unwrap();
    }
    let current = base.join(CURRENT_IDENTIFIER);
    let profile = prepare_current(&current, &current).unwrap();
    assert_eq!(profile.paths.settings, current.join("settings.json"));
    assert!(!profile.paths.settings.exists());
    assert!(!profile.paths.document_state.exists());
    assert!(matches!(
        prepare_current(&current, &current),
        Err(MigrationError::Busy)
    ));
    drop(profile);
    for identifier in [LEGACY_IDENTIFIER, LEGACY_PRODUCT_IDENTIFIER] {
        assert_eq!(
            fs::read(base.join(identifier)).unwrap(),
            b"untouched old profile sentinel"
        );
    }
    let profile = prepare_current(&current, &current).unwrap();
    drop(profile);
    assert!(!current.join(BUNDLE).exists());
}

#[test]
fn current_profile_reopens_its_own_settings_without_replacing_them() {
    let temp = TempDir::new().unwrap();
    let base = temp.path().canonicalize().unwrap();
    let config = base.join("config").join(CURRENT_IDENTIFIER);
    let local = base.join("local").join(CURRENT_IDENTIFIER);
    fs::create_dir_all(&config).unwrap();
    let settings = b"{\"knowledgeRoot\":null}";
    fs::write(config.join("settings.json"), settings).unwrap();
    for _ in 0..2 {
        let profile = prepare_current(&config, &local).unwrap();
        assert_eq!(profile.paths.settings, config.join("settings.json"));
        assert_eq!(fs::read(&profile.paths.settings).unwrap(), settings);
        assert!(!profile.paths.document_state.exists());
    }
}

#[test]
fn current_profile_rejects_unverified_settings_and_copied_migration_bundles() {
    let temp = TempDir::new().unwrap();
    let current = temp.path().canonicalize().unwrap().join(CURRENT_IDENTIFIER);
    fs::create_dir(&current).unwrap();
    fs::write(current.join("settings.json"), b"{").unwrap();
    assert!(matches!(
        prepare_current(&current, &current),
        Err(MigrationError::Corrupt)
    ));
    assert_eq!(fs::read(current.join("settings.json")).unwrap(), b"{");
    fs::remove_file(current.join("settings.json")).unwrap();
    fs::create_dir(current.join(BUNDLE)).unwrap();
    assert!(matches!(
        prepare_current(&current, &current),
        Err(MigrationError::UnsupportedDatabase)
    ));
    assert!(current.join(BUNDLE).is_dir());
    assert!(!current.join("document-state").exists());
}

#[cfg(target_os = "linux")]
#[test]
fn directory_sync_reopens_an_o_path_capability_without_changing_entries() {
    use rustix::fs::{open, Mode, OFlags};
    let fixture = TempDir::new().unwrap();
    fs::write(fixture.path().join("retained.json"), b"retained backup").unwrap();
    let file = File::from(
        open(
            fixture.path(),
            OFlags::PATH | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .unwrap(),
    );
    assert_eq!(
        file.try_clone()
            .unwrap()
            .sync_all()
            .unwrap_err()
            .raw_os_error(),
        Some(9)
    );
    let dir = Dir::from_std_file(file);
    sync_directory(&dir).unwrap();
    sync_directory(&dir).unwrap();
    assert_eq!(
        fs::read(fixture.path().join("retained.json")).unwrap(),
        b"retained backup"
    );
    assert_eq!(dir.entries().unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn directory_sync_uses_the_retained_object_after_path_replacement() {
    use std::os::unix::{fs::symlink, fs::MetadataExt};
    let fixture = TempDir::new().unwrap();
    let original = fixture.path().join("original");
    let moved = fixture.path().join("moved");
    let outside = fixture.path().join("outside.json");
    fs::create_dir(&original).unwrap();
    fs::write(original.join("retained.json"), b"retained backup").unwrap();
    fs::write(&outside, b"outside sentinel").unwrap();
    let dir = Dir::open_ambient_dir(&original, cap_std::ambient_authority()).unwrap();
    let retained = dir.try_clone().unwrap().into_std_file();
    let before = retained.metadata().unwrap();
    fs::rename(&original, &moved).unwrap();
    symlink(&outside, &original).unwrap();
    sync_directory(&dir).unwrap();
    let after = retained.metadata().unwrap();
    assert_eq!((before.dev(), before.ino()), (after.dev(), after.ino()));
    assert_eq!(
        fs::read(moved.join("retained.json")).unwrap(),
        b"retained backup"
    );
    assert_eq!(fs::read(&outside).unwrap(), b"outside sentinel");
    assert!(fs::symlink_metadata(&original)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[cfg(target_os = "linux")]
#[test]
fn directory_sync_rejects_a_file_capability() {
    let fixture = TempDir::new().unwrap();
    let path = fixture.path().join("retained.json");
    fs::write(&path, b"retained backup").unwrap();
    let dir = Dir::from_std_file(File::open(&path).unwrap());
    assert!(matches!(
        sync_directory(&dir),
        Err(MigrationError::UnsafePath)
    ));
    assert_eq!(fs::read(&path).unwrap(), b"retained backup");
}

// Parallel fixture children can transiently retain another fixture's flock even
// after its owner drops. Complete those children before simulated in-process
// restarts. Prepare calls remain concurrent; genuine competing leases stay Busy.
pub(crate) static FIXTURE_PROCESS_GATE: std::sync::RwLock<()> = std::sync::RwLock::new(());

fn prepare(locations: &Locations, decision: Decision) -> Result<Startup, MigrationError> {
    let _children_complete = FIXTURE_PROCESS_GATE.read().unwrap();
    super::prepare(locations, decision)
}

pub(crate) trait FixtureCommand {
    fn fixture_status(&mut self) -> std::io::Result<std::process::ExitStatus>;
}
impl FixtureCommand for std::process::Command {
    fn fixture_status(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let _child_complete = FIXTURE_PROCESS_GATE.write().unwrap();
        // Wait is the reliable child descriptor-release boundary. Parent DB
        // locks remain held, so the external writer/exit assertions still run.
        self.spawn()?.wait()
    }
}

#[test]
#[ignore]
fn fixture_child_probes_management_writer() {
    let database = std::env::var_os("MOGLEDGE_MANAGEMENT_DB").expect("synthetic fixture required");
    let connection = Connection::open(PathBuf::from(database)).unwrap();
    connection.busy_timeout(Duration::ZERO).unwrap();
    // A SHARED reader permits another RESERVED writer, but prevents its page
    // spill/COMMIT. EXCLUSIVE probes that actual database-write boundary.
    match connection.execute_batch("BEGIN EXCLUSIVE;") {
        Ok(()) => std::process::exit(0),
        Err(error)
            if matches!(
                error.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
            ) =>
        {
            std::process::exit(42)
        }
        Err(_) => std::process::exit(43),
    }
}

fn external_management_writer(database: &Path) -> i32 {
    std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "identifier_migration::tests::fixture_child_probes_management_writer",
            "--ignored",
        ])
        .env("MOGLEDGE_MANAGEMENT_DB", database)
        .stdout(std::process::Stdio::null())
        .fixture_status()
        .unwrap()
        .code()
        .unwrap()
}

#[test]
fn management_lock_transfer_fences_external_writer_at_every_phase_without_writes() {
    let temp = TempDir::new().unwrap();
    let state = temp.path().join("state");
    drop(DocumentState::new(state.clone()).unwrap());
    let database = state.join("state.sqlite");
    let before = fs::read(&database).unwrap();
    assert_eq!(external_management_writer(&database), 0);
    let (connection, write_guard) =
        open_database_guarded(&database, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
    let (reader, mut read_guard) =
        open_database_guarded(&database, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let mut phases = 0;
    acquire_management_lock(&connection, reader, |_| {
        phases += 1;
        assert_eq!(external_management_writer(&database), 42);
        read_guard.rewind().unwrap();
        let mut current = Vec::new();
        read_guard.read_to_end(&mut current).unwrap();
        assert_eq!(current, before);
        assert_eq!(fs::read_dir(&state).unwrap().count(), 1);
        Ok(())
    })
    .unwrap();
    assert_eq!(phases, 5);
    connection.execute_batch("ROLLBACK;").unwrap();
    assert_eq!(external_management_writer(&database), 42);
    drop(connection);
    drop((write_guard, read_guard));
    assert_eq!(external_management_writer(&database), 0);
    assert_eq!(fs::read(&database).unwrap(), before);
    assert_eq!(fs::read_dir(&state).unwrap().count(), 1);
}

#[test]
fn management_first_page_read_refuses_raced_hot_journal_without_recovery() {
    let temp = TempDir::new().unwrap();
    let state = temp.path().join("state");
    drop(DocumentState::new(state.clone()).unwrap());
    let database = state.join("state.sqlite");
    let seed = Connection::open(&database).unwrap();
    seed.execute(
        "INSERT INTO documents VALUES('fixture','{}',2,1,'root','page.html',1)",
        [],
    )
    .unwrap();
    seed.execute("UPDATE quota SET bytes=2,documents=1,generation=1", [])
        .unwrap();
    drop(seed);
    // Prepare both connections before an uncooperative writer crashes in the
    // former sidecar-precheck/page-read gap. Raw guards stay live throughout.
    let (connection, write_guard) =
        open_database_guarded(&database, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
    let (reader, read_guard) =
        open_database_guarded(&database, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "identifier_migration::tests::fixture_child_crashes_current_transaction",
            "--ignored",
        ])
        .env("MOGLEDGE_MIGRATION_FIXTURE", temp.path())
        .env("MOGLEDGE_MIGRATION_CURRENT_DB", "state/state.sqlite")
        .stdout(std::process::Stdio::null())
        .fixture_status()
        .unwrap();
    assert_eq!(status.code(), Some(31));
    let journal = state.join("state.sqlite-journal");
    let before_database = fs::read(&database).unwrap();
    let before_journal = fs::read(&journal).unwrap();
    assert!(before_journal.len() > 512);
    assert!(acquire_management_lock(&connection, reader, |_| Ok(())).is_err());
    drop(connection);
    drop((write_guard, read_guard));
    assert_eq!(fs::read(&database).unwrap(), before_database);
    assert_eq!(fs::read(&journal).unwrap(), before_journal);
    assert_eq!(fs::read_dir(&state).unwrap().count(), 2);
}

struct Fixture {
    _temp: TempDir,
    locations: Locations,
    knowledge: PathBuf,
}
impl Fixture {
    fn new(shared_base: bool) -> Self {
        // Native guards reject symlink ancestors, including macOS's /var alias.
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let config = temp.path().join("roaming");
        let local = if shared_base {
            config.clone()
        } else {
            temp.path().join("local")
        };
        let locations =
            Locations::new(&config, &local, "org.fixture.legacy", "org.fixture.current").unwrap();
        let knowledge = temp.path().join("knowledge");
        fs::create_dir(&knowledge).unwrap();
        fs::write(
            knowledge.join("日本語.html"),
            "<!doctype html><p>original</p>",
        )
        .unwrap();
        fs::write(knowledge.join("b.html"), "<!doctype html><p>second</p>").unwrap();
        // Core hashes the handle-resolved root for tree-order. On Windows this
        // includes the normalized namespace, unlike TempDir's lexical path.
        let (knowledge, _) = crate::knowledge::open_root(&knowledge).unwrap();
        Self {
            _temp: temp,
            locations,
            knowledge,
        }
    }
    fn seed(&self) {
        fs::create_dir_all(self.locations.old_config.join("tree-order")).unwrap();
        fs::write(
            self.locations.old_config.join("settings.json"),
            serde_json::to_vec(&json!({"knowledgeRoot":self.knowledge})).unwrap(),
        )
        .unwrap();
        let core = Core::new(19074);
        assert!(core
            .settings_path
            .set(self.locations.old_config.join("settings.json"))
            .is_ok());
        crate::tree_order::save(
            &core,
            &self.knowledge,
            &crate::tree_order::Order {
                parents: std::collections::BTreeMap::from([(
                    String::new(),
                    vec!["日本語.html".into(), "b.html".into()],
                )]),
            },
        )
        .unwrap();
        assert!(core
            .document_state
            .set(DocumentState::new(self.locations.old_local.join("document-state")).unwrap())
            .is_ok());
        core.select(&self.knowledge, false).unwrap();
        core.watcher.lock().unwrap().take();
        let token = token(&core);
        operate(
            &core,
            &token,
            "write",
            Some(json!({"schemaVersion":1,"data":{"amount":42,"text":"日本語"}})),
        );
        fs::create_dir_all(self.locations.old_local.join("search-index")).unwrap();
        fs::write(self.locations.old_local.join("search-index/cache"), "cache").unwrap();
        fs::create_dir_all(self.locations.old_local.join("WebView2")).unwrap();
        fs::write(
            self.locations.old_local.join("WebView2/cookies"),
            "sensitive fixture",
        )
        .unwrap();
    }
    fn database(&self) -> PathBuf {
        self.locations.old_local.join("document-state/state.sqlite")
    }
    fn order_name(&self) -> std::ffi::OsString {
        fs::read_dir(self.locations.old_config.join("tree-order"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .file_name()
    }
    fn snapshot(&self) -> Vec<(PathBuf, Vec<u8>)> {
        fn walk(path: &Path, root: &Path, data: &mut Vec<(PathBuf, Vec<u8>)>) {
            if !path.exists() {
                return;
            }
            if path.is_file() {
                data.push((
                    path.strip_prefix(root).unwrap().into(),
                    fs::read(path).unwrap(),
                ));
            } else {
                for entry in fs::read_dir(path).unwrap() {
                    walk(&entry.unwrap().path(), root, data);
                }
            }
        }
        let mut data = Vec::new();
        walk(&self.locations.old_config, self._temp.path(), &mut data);
        if self.locations.old_local != self.locations.old_config {
            walk(&self.locations.old_local, self._temp.path(), &mut data);
        }
        data.sort_by(|a, b| a.0.cmp(&b.0));
        data
    }
    fn import(&self) -> PreparedProfile {
        ready(prepare(&self.locations, Decision::ImportAfterLegacyExit).unwrap())
    }
}
fn ready(startup: Startup) -> PreparedProfile {
    match startup {
        Startup::Ready(profile) => profile,
        other => panic!("expected ready, got {other:?}"),
    }
}
fn token(core: &std::sync::Arc<Core>) -> String {
    let snapshot = core.snapshot();
    let workspace = snapshot.workspace_id.unwrap();
    let tab = core
        .create_tab(&workspace, &snapshot.view_id, "日本語.html")
        .unwrap();
    let url = core.open(&workspace, &snapshot.view_id, &tab, 1).unwrap();
    document_server::decode_path(url.strip_prefix(&core.origin).unwrap())
        .unwrap()
        .0
}
fn operate(core: &std::sync::Arc<Core>, token: &str, op: &str, value: Option<Value>) -> Value {
    let request: StateRequest =
        serde_json::from_value(json!({"version":1,"op":op,"key":"sample","value":value})).unwrap();
    document_state::operate(core, token, request).unwrap().value
}
fn restore_with_explicit_legacy_selection(core: &std::sync::Arc<Core>) {
    let settings_path = core.settings_path.get().unwrap();
    let settings = fs::read(settings_path).unwrap();
    let saved = crate::root_recovery::SavedRoot::parse(
        &serde_json::from_slice::<Value>(&settings).unwrap(),
    )
    .unwrap();
    core.restore().unwrap();
    if saved.identity.is_none() {
        let snapshot = core.snapshot();
        assert!(snapshot.workspace_id.is_none());
        assert!(snapshot.nodes.is_empty());
        let recovery = snapshot.startup_recovery.unwrap();
        assert_eq!(
            recovery.reason,
            crate::root_recovery::RecoveryReason::ConfirmationRequired
        );
        assert!(!recovery.can_retry);
        assert_eq!(fs::read(settings_path).unwrap(), settings);
        // Legacy paths cannot silently reattach after migration. Model explicit
        // user selection without rewriting the source bytes checked below.
        core.select(&saved.path, false).unwrap();
    }
}
fn restore(paths: &ActivePaths, expected: i64) {
    let core = Core::new(19075);
    assert!(core.settings_path.set(paths.settings.clone()).is_ok());
    assert!(core
        .document_state
        .set(DocumentState::new(paths.document_state.clone()).unwrap())
        .is_ok());
    restore_with_explicit_legacy_selection(&core);
    core.watcher.lock().unwrap().take();
    assert_eq!(
        core.snapshot()
            .nodes
            .iter()
            .map(|node| node.relative_path.as_str())
            .collect::<Vec<_>>(),
        ["日本語.html", "b.html"]
    );
    assert_eq!(
        operate(&core, &token(&core), "read", None)["data"]["amount"],
        expected
    );
}

#[test]
fn empty_install_does_not_create_database_and_lease_blocks_other_runtime() {
    let fixture = Fixture::new(false);
    let profile = ready(prepare(&fixture.locations, Decision::Inspect).unwrap());
    assert_eq!(profile.paths, fixture.locations.ordinary_paths());
    assert!(!profile.paths.document_state.exists());
    assert!(matches!(
        prepare(&fixture.locations, Decision::Inspect),
        Err(MigrationError::Busy)
    ));
    drop(profile);
    assert!(matches!(
        prepare(&fixture.locations, Decision::Inspect),
        Ok(Startup::Ready(_))
    ));
}
#[test]
fn import_restore_restart_and_legacy_rollback_preserve_original_bytes() {
    for shared_base in [false, true] {
        let fixture = Fixture::new(shared_base);
        fixture.seed();
        let before = fixture.snapshot();
        assert!(matches!(
            prepare(&fixture.locations, Decision::Inspect).unwrap(),
            Startup::NeedsConsent
        ));
        assert!(!fixture.locations.new_local.join(BUNDLE).exists());
        let profile = fixture.import();
        restore(&profile.paths, 42);
        assert_eq!(
            fs::read(
                profile
                    .paths
                    .settings
                    .parent()
                    .unwrap()
                    .join("tree-order")
                    .join(fixture.order_name())
            )
            .unwrap(),
            fs::read(
                fixture
                    .locations
                    .old_config
                    .join("tree-order")
                    .join(fixture.order_name())
            )
            .unwrap()
        );
        assert!(!profile.paths.search_index.exists());
        assert!(!fixture.locations.new_local.join("WebView2").exists());
        assert_eq!(before, fixture.snapshot());
        let paths = profile.paths.clone();
        drop(profile);
        let restarted = ready(prepare(&fixture.locations, Decision::Inspect).unwrap());
        assert_eq!(paths, restarted.paths);
        restore(&restarted.paths, 42);
        restore(
            &ActivePaths {
                settings: fixture.locations.old_config.join("settings.json"),
                document_state: fixture.locations.old_local.join("document-state"),
                search_index: fixture.locations.old_local.join("search-index"),
            },
            42,
        );
        assert_eq!(before, fixture.snapshot());
    }
}
#[test]
fn new_profile_wins_only_by_explicit_choice_and_is_never_overwritten() {
    let fixture = Fixture::new(false);
    fixture.seed();
    fs::create_dir_all(&fixture.locations.new_config).unwrap();
    let path = fixture.locations.new_config.join("settings.json");
    let retained = serde_json::to_vec(&json!({"knowledgeRoot":fixture.knowledge})).unwrap();
    fs::write(&path, &retained).unwrap();
    for decision in [Decision::Inspect, Decision::ImportAfterLegacyExit] {
        assert!(matches!(
            prepare(&fixture.locations, decision).unwrap(),
            Startup::Conflict
        ));
        assert_eq!(fs::read(&path).unwrap(), retained);
    }
    let current = ready(prepare(&fixture.locations, Decision::KeepCurrent).unwrap());
    assert_eq!(current.paths, fixture.locations.ordinary_paths());
    assert!(!fixture.locations.new_local.join(BUNDLE).exists());
}
#[test]
fn new_only_and_empty_existing_state_directory_are_conservative() {
    let fixture = Fixture::new(false);
    fs::create_dir_all(fixture.locations.new_local.join("document-state")).unwrap();
    assert!(matches!(
        prepare(&fixture.locations, Decision::Inspect).unwrap(),
        Startup::Ready(_)
    ));
    fixture.seed();
    assert!(matches!(
        prepare(&fixture.locations, Decision::ImportAfterLegacyExit).unwrap(),
        Startup::Conflict
    ));
}
#[test]
fn corrupt_sqlite_json_and_quota_do_not_publish_or_change_source() {
    for corruption in [
        "sqlite",
        "settings",
        "order",
        "quota",
        "record",
        "schema",
        "bytes",
        "trigger",
        "oversized",
    ] {
        let fixture = Fixture::new(false);
        fixture.seed();
        match corruption {
            "sqlite" => fs::write(fixture.database(), "broken database").unwrap(),
            "settings" => fs::write(
                fixture.locations.old_config.join("settings.json"),
                "{broken",
            )
            .unwrap(),
            "order" => fs::write(
                fixture
                    .locations
                    .old_config
                    .join("tree-order")
                    .join(fixture.order_name()),
                "{}",
            )
            .unwrap(),
            other => {
                let connection = Connection::open(fixture.database()).unwrap();
                if other == "oversized" {
                    connection
                        .execute(
                            "UPDATE documents SET data=?1,bytes=4",
                            ["x".repeat(7 * 1024 * 1024)],
                        )
                        .unwrap();
                    connection
                        .execute_batch("UPDATE quota SET bytes=4")
                        .unwrap();
                } else {
                    let sql=match other { "quota"=>"UPDATE quota SET bytes=bytes+1", "record"=>"UPDATE documents SET data='broken'", "schema"=>"PRAGMA user_version=2", "bytes"=>"UPDATE documents SET bytes=6000000", "trigger"=>"CREATE TRIGGER surprise AFTER UPDATE ON documents BEGIN DELETE FROM documents; END", _=>unreachable!() };
                    connection.execute_batch(sql).unwrap();
                }
            }
        }
        let before = fixture.snapshot();
        assert!(
            prepare(&fixture.locations, Decision::ImportAfterLegacyExit).is_err(),
            "{corruption}"
        );
        assert!(!fixture.locations.new_local.join(BUNDLE).exists());
        assert_eq!(before, fixture.snapshot());
    }
}
#[test]
fn busy_sqlite_and_sidecars_refuse_unsafe_snapshot_then_retry() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let before = fixture.snapshot();
    let connection = Connection::open(fixture.database()).unwrap();
    connection.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(matches!(
        prepare(&fixture.locations, Decision::ImportAfterLegacyExit),
        Err(MigrationError::Busy)
    ));
    connection.execute_batch("ROLLBACK").unwrap();
    drop(connection);
    for suffix in ["-journal", "-wal", "-shm"] {
        let sidecar = fixture
            .database()
            .with_file_name(format!("state.sqlite{suffix}"));
        fs::write(&sidecar, "preserve").unwrap();
        assert!(matches!(
            prepare(&fixture.locations, Decision::ImportAfterLegacyExit),
            Err(MigrationError::UnsupportedDatabase)
        ));
        assert_eq!(fs::read(&sidecar).unwrap(), b"preserve");
        fs::remove_file(sidecar).unwrap();
    }
    let profile = fixture.import();
    restore(&profile.paths, 42);
    assert_eq!(before, fixture.snapshot());
}
#[test]
fn wal_without_sidecars_is_still_rejected_without_conversion() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let connection = Connection::open(fixture.database()).unwrap();
    connection.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    drop(connection);
    let before = fixture.snapshot();
    assert!(matches!(
        prepare(&fixture.locations, Decision::ImportAfterLegacyExit),
        Err(MigrationError::UnsupportedDatabase)
    ));
    assert_eq!(before, fixture.snapshot());
}
#[test]
fn partial_failure_and_restart_retry_publish_only_complete_bundle() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let before = fixture.snapshot();
    assert!(matches!(
        prepare_inner(
            &fixture.locations,
            Decision::ImportAfterLegacyExit,
            &mut |phase| if phase == Checkpoint::BeforePublish {
                Err(MigrationError::Unavailable)
            } else {
                Ok(())
            }
        ),
        Err(MigrationError::Unavailable)
    ));
    assert!(!fixture.locations.new_local.join(BUNDLE).exists());
    assert_eq!(before, fixture.snapshot());
    let staging: Vec<_> = fs::read_dir(&fixture.locations.new_local)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(STAGING_PREFIX)
        })
        .collect();
    assert_eq!(staging.len(), 1);
    assert!(staging[0].join("complete.json").exists());
    let profile = fixture.import();
    restore(&profile.paths, 42);
    assert_eq!(before, fixture.snapshot());
    assert!(staging[0].exists());
}
#[test]
fn orphaned_staging_with_lost_source_blocks_empty_initialization() {
    let fixture = Fixture::new(false);
    fixture.seed();
    assert!(prepare_inner(
        &fixture.locations,
        Decision::ImportAfterLegacyExit,
        &mut |phase| if phase == Checkpoint::BeforePublish {
            Err(MigrationError::Unavailable)
        } else {
            Ok(())
        }
    )
    .is_err());
    fs::rename(
        &fixture.locations.old_config,
        fixture._temp.path().join("old-config-backup"),
    )
    .unwrap();
    fs::rename(
        &fixture.locations.old_local,
        fixture._temp.path().join("old-local-backup"),
    )
    .unwrap();
    assert!(matches!(
        prepare(&fixture.locations, Decision::Inspect),
        Err(MigrationError::Interrupted)
    ));
    assert!(!fixture.locations.ordinary_paths().document_state.exists());
}
#[test]
fn changed_settings_added_order_and_competing_destination_block_publish() {
    for mutation in ["settings", "added-order", "new-config", "bundle"] {
        let fixture = Fixture::new(false);
        fixture.seed();
        let result = prepare_inner(
            &fixture.locations,
            Decision::ImportAfterLegacyExit,
            &mut |phase| {
                if phase != Checkpoint::BeforePublish {
                    return Ok(());
                }
                match mutation {
                    "settings" => fs::write(
                        fixture.locations.old_config.join("settings.json"),
                        b"changed",
                    )
                    .unwrap(),
                    "added-order" => fs::write(
                        fixture
                            .locations
                            .old_config
                            .join("tree-order/1111111111111111.json"),
                        b"retained",
                    )
                    .unwrap(),
                    "new-config" => {
                        fs::create_dir_all(&fixture.locations.new_config).unwrap();
                        fs::write(
                            fixture.locations.new_config.join("settings.json"),
                            b"retained",
                        )
                        .unwrap();
                    }
                    "bundle" => {
                        fs::create_dir(fixture.locations.new_local.join(BUNDLE)).unwrap();
                        fs::write(
                            fixture.locations.new_local.join(BUNDLE).join("retained"),
                            b"retained",
                        )
                        .unwrap();
                    }
                    _ => unreachable!(),
                }
                Ok(())
            },
        );
        assert!(result.is_err(), "{mutation}");
        if mutation == "bundle" {
            assert_eq!(
                fs::read(fixture.locations.new_local.join(BUNDLE).join("retained")).unwrap(),
                b"retained"
            );
        } else {
            assert!(!fixture.locations.new_local.join(BUNDLE).exists());
        }
    }
}
#[test]
fn missing_db_settings_only_and_empty_legacy_directories_can_migrate() {
    let fixture = Fixture::new(false);
    fs::create_dir_all(&fixture.locations.old_config).unwrap();
    fs::write(
        fixture.locations.old_config.join("settings.json"),
        serde_json::to_vec(&json!({"knowledgeRoot":fixture.knowledge})).unwrap(),
    )
    .unwrap();
    let profile = fixture.import();
    assert!(!profile.paths.document_state.join("state.sqlite").exists());
    assert!(DocumentState::new(profile.paths.document_state.clone()).is_ok());
}
#[test]
fn pr60_five_mib_record_keeps_schema_and_bytes_without_low_quota_truncation() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let overhead = serde_json::to_string(&json!({"sample":{"schemaVersion":1,"data":""}}))
        .unwrap()
        .len();
    let data=serde_json::to_string(&json!({"sample":{"schemaVersion":1,"data":"x".repeat(crate::storage_limits::DEFAULT_DOCUMENT_BYTES-overhead)}})).unwrap();
    let connection = Connection::open(fixture.database()).unwrap();
    connection
        .execute(
            "UPDATE documents SET data=?1,bytes=?2",
            rusqlite::params![data, data.len() as i64],
        )
        .unwrap();
    connection
        .execute("UPDATE quota SET bytes=?1", [data.len() as i64])
        .unwrap();
    drop(connection);
    let before = fixture.snapshot();
    let profile = fixture.import();
    assert_eq!(
        fs::read(profile.paths.document_state.join("state.sqlite")).unwrap(),
        fs::read(fixture.database()).unwrap()
    );
    assert_eq!(before, fixture.snapshot());
    // This fixture models the original runtime quota before the budget increase.
    let paths = profile.paths.clone();
    drop(profile);
    let restarted = ready(prepare(&fixture.locations, Decision::Inspect).unwrap());
    assert_eq!(restarted.paths, paths);
    assert_eq!(
        fs::read(restarted.paths.document_state.join("state.sqlite")).unwrap(),
        fs::read(fixture.database()).unwrap()
    );
}
#[cfg(unix)]
#[test]
fn symlink_ancestor_leaf_fifo_and_hardlink_are_rejected() {
    use std::os::unix::fs::symlink;
    for kind in [
        "ancestor", "settings", "db", "orders", "new", "hardlink", "fifo",
    ] {
        let fixture = Fixture::new(false);
        fixture.seed();
        let external = fixture._temp.path().join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("secret"), b"external fixture").unwrap();
        match kind {
            "ancestor" => {
                fs::rename(
                    fixture.locations.old_config.parent().unwrap(),
                    fixture._temp.path().join("real-roaming"),
                )
                .unwrap();
                symlink(
                    fixture._temp.path().join("real-roaming"),
                    fixture.locations.old_config.parent().unwrap(),
                )
                .unwrap();
            }
            "settings" => {
                let path = fixture.locations.old_config.join("settings.json");
                fs::remove_file(&path).unwrap();
                symlink(external.join("secret"), path).unwrap();
            }
            "db" => {
                fs::remove_file(fixture.database()).unwrap();
                symlink(external.join("secret"), fixture.database()).unwrap();
            }
            "orders" => {
                let path = fixture.locations.old_config.join("tree-order");
                fs::remove_dir_all(&path).unwrap();
                symlink(&external, path).unwrap();
            }
            "new" => symlink(&external, &fixture.locations.new_local).unwrap(),
            "hardlink" => {
                let path = fixture.locations.old_config.join("settings.json");
                fs::remove_file(&path).unwrap();
                fs::hard_link(external.join("secret"), path).unwrap();
            }
            "fifo" => {
                let path = fixture.locations.old_config.join("settings.json");
                fs::remove_file(&path).unwrap();
                crate::test_fixtures::create_fifo(&path, 0o400).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            prepare(&fixture.locations, Decision::ImportAfterLegacyExit).is_err(),
            "{kind}"
        );
        assert_eq!(
            fs::read(external.join("secret")).unwrap(),
            b"external fixture"
        );
        assert!(!external.join(BUNDLE).exists());
    }
}
#[cfg(unix)]
#[test]
fn permission_denied_does_not_publish_or_mutate_source() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new(false);
    fixture.seed();
    let before = fixture.snapshot();
    let path = fixture.locations.old_config.join("settings.json");
    fs::set_permissions(&path, fs::Permissions::from_mode(0o0)).unwrap();
    let result = prepare(&fixture.locations, Decision::ImportAfterLegacyExit);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(result.is_err());
    assert!(!fixture.locations.new_local.join(BUNDLE).exists());
    assert_eq!(before, fixture.snapshot());
}
#[test]
fn identifiers_and_external_path_components_are_not_accepted() {
    let fixture = Fixture::new(false);
    for id in [
        "../external",
        "com.test/other",
        ".hidden",
        "com.test.",
        "org.fixture.legacy",
    ] {
        assert!(Locations::new(
            fixture._temp.path(),
            fixture._temp.path(),
            "org.fixture.legacy",
            id
        )
        .is_err());
    }
    assert!(Locations::new(
        Path::new("relative"),
        fixture._temp.path(),
        "org.old",
        "org.new"
    )
    .is_err());
    assert!(Locations::new(
        &fixture._temp.path().join("../other"),
        fixture._temp.path(),
        "org.old",
        "org.new"
    )
    .is_err());
}

#[test]
fn process_exit_during_database_copy_leaves_partial_stage_and_retryable_source() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let data = serde_json::to_string(&json!({"sample": "x".repeat(256 * 1024)})).unwrap();
    let connection = Connection::open(fixture.database()).unwrap();
    connection
        .execute(
            "UPDATE documents SET data=?1,bytes=?2",
            rusqlite::params![data, data.len() as i64],
        )
        .unwrap();
    connection
        .execute("UPDATE quota SET bytes=?1", [data.len() as i64])
        .unwrap();
    drop(connection);
    let before = fixture.snapshot();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "identifier_migration::tests::fixture_child_exits_during_copy",
            "--ignored",
        ])
        .env("MOGLEDGE_MIGRATION_FIXTURE", fixture._temp.path())
        .fixture_status()
        .unwrap();
    assert_eq!(status.code(), Some(29));
    assert_eq!(before, fixture.snapshot());
    assert!(!fixture.locations.new_local.join(BUNDLE).exists());
    let stage = fs::read_dir(&fixture.locations.new_local)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(STAGING_PREFIX)
        })
        .unwrap();
    assert!(!stage.join("complete.json").exists());
    assert!(
        fs::metadata(stage.join("document-state/state.sqlite"))
            .unwrap()
            .len()
            < fs::metadata(fixture.database()).unwrap().len()
    );
    let profile = fixture.import();
    assert_eq!(
        fs::read(profile.paths.document_state.join("state.sqlite")).unwrap(),
        fs::read(fixture.database()).unwrap()
    );
    assert_eq!(before, fixture.snapshot());
}

// Invoked only by the preceding test in a child process with a dedicated fixture.
#[test]
#[ignore]
fn fixture_child_exits_during_copy() {
    let root =
        PathBuf::from(std::env::var_os("MOGLEDGE_MIGRATION_FIXTURE").expect("fixture required"));
    let locations = Locations::new(
        &root.join("roaming"),
        &root.join("local"),
        "org.fixture.legacy",
        "org.fixture.current",
    )
    .unwrap();
    let _ = prepare_inner(&locations, Decision::ImportAfterLegacyExit, &mut |phase| {
        if phase == Checkpoint::DatabaseChunkCopied {
            std::process::exit(29);
        }
        Ok(())
    });
    panic!("fixture never reached copy checkpoint");
}

#[test]
fn completed_bundle_never_reimports_and_missing_payload_blocks_empty_state() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let profile = fixture.import();
    let paths = profile.paths.clone();
    drop(profile);
    fs::write(
        fixture.locations.old_config.join("settings.json"),
        "now corrupt legacy fixture",
    )
    .unwrap();
    let profile = ready(prepare(&fixture.locations, Decision::ImportAfterLegacyExit).unwrap());
    assert_eq!(paths, profile.paths);
    drop(profile);
    fs::remove_file(paths.document_state.join("state.sqlite")).unwrap();
    assert!(matches!(
        prepare(&fixture.locations, Decision::Inspect),
        Err(MigrationError::Corrupt)
    ));
    assert!(!paths.document_state.join("state.sqlite").exists());
}

#[test]
fn source_read_lock_blocks_other_process_commit_until_publication() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let before = fixture.snapshot();
    let mut checked = false;
    let result = prepare_inner(
        &fixture.locations,
        Decision::ImportAfterLegacyExit,
        &mut |phase| {
            if phase == Checkpoint::BeforePublish {
                let status = std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "identifier_migration::tests::fixture_child_checks_source_lock",
                        "--ignored",
                    ])
                    .env("MOGLEDGE_MIGRATION_FIXTURE", fixture._temp.path())
                    .fixture_status()
                    .unwrap();
                assert_eq!(status.code(), Some(0));
                checked = true;
            }
            Ok(())
        },
    );
    assert!(checked);
    drop(ready(result.unwrap()));
    assert_eq!(before, fixture.snapshot());
    // Publication releases the source lock; rollback can write its own old DB.
    let connection = Connection::open(fixture.database()).unwrap();
    connection
        .execute_batch("BEGIN IMMEDIATE; ROLLBACK;")
        .unwrap();
}

#[test]
#[ignore]
fn fixture_child_checks_source_lock() {
    let root =
        PathBuf::from(std::env::var_os("MOGLEDGE_MIGRATION_FIXTURE").expect("fixture required"));
    let connection =
        Connection::open(root.join("local/org.fixture.legacy/document-state/state.sqlite"))
            .unwrap();
    connection.busy_timeout(Duration::from_millis(0)).unwrap();
    let error = connection
        .execute_batch("BEGIN IMMEDIATE; UPDATE quota SET generation=generation+1; COMMIT;")
        .unwrap_err();
    assert_eq!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::DatabaseBusy)
    );
}

#[test]
fn published_profile_hot_journal_preserves_latest_acknowledged_state() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let old = fixture.snapshot();
    let profile = fixture.import();
    let paths = profile.paths.clone();
    let core = Core::new(19076);
    core.settings_path.set(paths.settings.clone()).unwrap();
    assert!(core
        .document_state
        .set(DocumentState::new(paths.document_state.clone()).unwrap())
        .is_ok());
    restore_with_explicit_legacy_selection(&core);
    core.watcher.lock().unwrap().take();
    operate(
        &core,
        &token(&core),
        "write",
        Some(json!({"schemaVersion":1,"data":{"amount":43}})),
    );
    drop(core);
    drop(profile);
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "identifier_migration::tests::fixture_child_crashes_current_transaction",
            "--ignored",
        ])
        .env("MOGLEDGE_MIGRATION_FIXTURE", fixture._temp.path())
        .fixture_status()
        .unwrap();
    assert_eq!(status.code(), Some(31));
    let db = paths.document_state.join("state.sqlite");
    let journal = paths.document_state.join("state.sqlite-journal");
    assert!(fs::metadata(&journal).unwrap().len() > 512);
    let connection = open_db(&db).unwrap();
    let error = connection
        .query_row("SELECT count(*) FROM documents", [], |r| r.get::<_, i64>(0))
        .unwrap_err();
    assert_eq!(
        error.sqlite_error().unwrap().extended_code,
        rusqlite::ffi::SQLITE_READONLY_ROLLBACK
    );
    drop(connection);
    let recovered = ready(prepare(&fixture.locations, Decision::Inspect).unwrap());
    assert_eq!(recovered.paths, paths);
    assert!(!journal.exists());
    restore(&recovered.paths, 43); // Retain current acknowledgment, not old snapshot 42.
    assert!(matches!(
        prepare(&fixture.locations, Decision::Inspect),
        Err(MigrationError::Busy)
    ));
    drop(recovered);
    let retry = ready(prepare(&fixture.locations, Decision::Inspect).unwrap());
    restore(&retry.paths, 43);
    assert_eq!(old, fixture.snapshot());
}

#[test]
#[ignore]
fn fixture_child_crashes_current_transaction() {
    let root =
        PathBuf::from(std::env::var_os("MOGLEDGE_MIGRATION_FIXTURE").expect("fixture required"));
    let relative = std::env::var_os("MOGLEDGE_MIGRATION_CURRENT_DB").unwrap_or_else(|| {
        "local/org.fixture.current/identifier-migration-v1/document-state/state.sqlite".into()
    });
    let connection = Connection::open(root.join(relative)).unwrap();
    connection.execute_batch("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA cache_size=1; BEGIN IMMEDIATE; UPDATE documents SET data=data || printf('%0262144d',0);").unwrap();
    // exit skips SQLite rollback/Drop, leaving actual spilled pages and a hot journal.
    std::process::exit(31);
}

#[test]
fn substituted_staging_directory_does_not_publish() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let old = fixture.snapshot();
    let result = prepare_inner(
        &fixture.locations,
        Decision::ImportAfterLegacyExit,
        &mut |phase| {
            if phase == Checkpoint::BeforePublish {
                let staging = fs::read_dir(&fixture.locations.new_local)
                    .unwrap()
                    .map(|entry| entry.unwrap().path())
                    .find(|path| {
                        path.file_name()
                            .unwrap()
                            .to_string_lossy()
                            .starts_with(STAGING_PREFIX)
                    })
                    .unwrap();
                fs::rename(
                    &staging,
                    fixture._temp.path().join("validated-stage-retained"),
                )
                .unwrap();
                fs::create_dir(&staging).unwrap();
            }
            Ok(())
        },
    );
    assert!(matches!(result, Err(MigrationError::SourceChanged)));
    assert!(!fixture.locations.new_local.join(BUNDLE).exists());
    assert_eq!(old, fixture.snapshot());
}

#[test]
fn staging_payload_and_post_publish_substitution_never_return_ready() {
    for mutation in ["early-payload", "payload", "child-directory", "published"] {
        let fixture = Fixture::new(false);
        fixture.seed();
        let old = fixture.snapshot();
        let result = prepare_inner(
            &fixture.locations,
            Decision::ImportAfterLegacyExit,
            &mut |phase| {
                let before = phase == Checkpoint::BeforePublish;
                if mutation == "early-payload" && phase == Checkpoint::ConfigCopied {
                    let staging = fs::read_dir(&fixture.locations.new_local)
                        .unwrap()
                        .map(|entry| entry.unwrap().path())
                        .find(|path| {
                            path.file_name()
                                .unwrap()
                                .to_string_lossy()
                                .starts_with(STAGING_PREFIX)
                        })
                        .unwrap();
                    fs::write(
                        staging.join("config/settings.json"),
                        b"changed before sealing",
                    )
                    .unwrap();
                }
                if (mutation == "published" && phase == Checkpoint::AfterPublish)
                    || (mutation != "published" && before)
                {
                    let path = if before {
                        fs::read_dir(&fixture.locations.new_local)
                            .unwrap()
                            .map(|entry| entry.unwrap().path())
                            .find(|path| {
                                path.file_name()
                                    .unwrap()
                                    .to_string_lossy()
                                    .starts_with(STAGING_PREFIX)
                            })
                            .unwrap()
                    } else {
                        fixture.locations.new_local.join(BUNDLE)
                    };
                    match mutation {
                        "early-payload" => (),
                        "payload" => {
                            fs::write(path.join("config/settings.json"), b"changed in-place")
                                .unwrap()
                        }
                        "child-directory" => {
                            fs::rename(
                                path.join("document-state"),
                                fixture._temp.path().join("state-retained"),
                            )
                            .unwrap();
                            fs::create_dir(path.join("document-state")).unwrap();
                        }
                        "published" => {
                            fs::rename(&path, fixture._temp.path().join("published-retained"))
                                .unwrap();
                            fs::create_dir(&path).unwrap();
                        }
                        _ => unreachable!(),
                    }
                }
                Ok(())
            },
        );
        assert!(
            matches!(result, Err(MigrationError::SourceChanged)),
            "{mutation}: {result:?}"
        );
        assert_eq!(old, fixture.snapshot());
        if mutation == "published" {
            assert!(matches!(
                prepare(&fixture.locations, Decision::Inspect),
                Err(MigrationError::Unavailable | MigrationError::Corrupt)
            ));
            assert!(!fixture
                .locations
                .new_local
                .join(BUNDLE)
                .join("document-state/state.sqlite")
                .exists());
        } else {
            assert!(!fixture.locations.new_local.join(BUNDLE).exists());
        }
    }
}

#[test]
fn ordinary_current_profile_is_validated_before_ready_or_database_creation() {
    for corruption in ["settings", "order", "database", "orphan-journal"] {
        let fixture = Fixture::new(false);
        fs::create_dir_all(fixture.locations.new_config.join("tree-order")).unwrap();
        let state = fixture.locations.ordinary_paths().document_state;
        fs::create_dir_all(&state).unwrap();
        match corruption {
            "settings" => fs::write(
                fixture.locations.new_config.join("settings.json"),
                b"broken",
            )
            .unwrap(),
            "order" => fs::write(
                fixture
                    .locations
                    .new_config
                    .join("tree-order/1111111111111111.json"),
                b"{}",
            )
            .unwrap(),
            "database" => fs::write(state.join("state.sqlite"), b"broken").unwrap(),
            "orphan-journal" => fs::write(state.join("state.sqlite-journal"), b"retained").unwrap(),
            _ => unreachable!(),
        }
        for decision in [Decision::Inspect, Decision::KeepCurrent] {
            assert!(
                prepare(&fixture.locations, decision).is_err(),
                "{corruption}"
            );
            assert_eq!(
                state.join("state.sqlite").exists(),
                corruption == "database"
            );
        }
    }
}

#[test]
fn published_and_ordinary_current_profiles_require_manual_resolution() {
    let fixture = Fixture::new(false);
    fixture.seed();
    drop(fixture.import());
    fs::create_dir_all(&fixture.locations.new_config).unwrap();
    let retained = b"retained competing profile";
    fs::write(fixture.locations.new_config.join("settings.json"), retained).unwrap();
    for decision in [
        Decision::Inspect,
        Decision::KeepCurrent,
        Decision::ImportAfterLegacyExit,
    ] {
        assert!(matches!(
            prepare(&fixture.locations, decision).unwrap(),
            Startup::ConflictingCurrentProfiles
        ));
    }
    assert_eq!(
        fs::read(fixture.locations.new_config.join("settings.json")).unwrap(),
        retained
    );
    let old = fixture.snapshot();
    fs::rename(
        &fixture.locations.new_config,
        fixture._temp.path().join("current-config-retained"),
    )
    .unwrap();
    let profile = ready(prepare(&fixture.locations, Decision::Inspect).unwrap());
    restore(&profile.paths, 42);
    assert_eq!(old, fixture.snapshot());
}

#[test]
fn legacy_v1_sparse_database_above_its_cap_is_rejected_before_copy() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let database = fixture.database();
    let original = fs::read(&database).unwrap();
    let sparse_length = MAX_DB_BYTES + 1;
    fs::OpenOptions::new()
        .write(true)
        .open(&database)
        .unwrap()
        .set_len(sparse_length)
        .unwrap();
    // Guard even a regressed implementation from copying/hashing a GiB fixture.
    let mut copy_started = false;
    let result = prepare_inner(
        &fixture.locations,
        Decision::ImportAfterLegacyExit,
        &mut |phase| {
            if phase == Checkpoint::DatabaseChunkCopied {
                copy_started = true;
                return Err(MigrationError::SourceChanged);
            }
            Ok(())
        },
    );
    assert!(matches!(result, Err(MigrationError::Corrupt)));
    assert!(!copy_started);
    assert!(!fixture.locations.new_local.join(BUNDLE).exists());
    assert_eq!(fs::metadata(&database).unwrap().len(), sparse_length);
    let mut retained = Vec::new();
    fs::File::open(&database)
        .unwrap()
        .take(original.len() as u64)
        .read_to_end(&mut retained)
        .unwrap();
    assert_eq!(retained, original);
}

#[test]
fn configured_legacy_v1_uses_the_larger_cap_and_imports_without_changing_source() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let database = fixture.database();
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch(crate::storage_limits::DDL)
        .unwrap();
    connection
        .execute(
            "INSERT INTO storage_limits VALUES(1,8388608,1073741824,1)",
            [],
        )
        .unwrap();
    validate_db(&connection).unwrap();
    assert_eq!(
        database_size_limit(&connection).unwrap(),
        crate::storage_limits::physical_database_bytes(&connection).unwrap()
    );
    drop(connection);
    let original = fs::read(&database).unwrap();
    let file = fs::OpenOptions::new().write(true).open(&database).unwrap();
    file.set_len(MAX_DB_BYTES + 1).unwrap();
    let mut copy_started = false;
    let result = prepare_inner(
        &fixture.locations,
        Decision::ImportAfterLegacyExit,
        &mut |phase| {
            if phase == Checkpoint::DatabaseChunkCopied {
                copy_started = true;
                return Err(MigrationError::SourceChanged);
            }
            Ok(())
        },
    );
    assert!(matches!(result, Err(MigrationError::SourceChanged)));
    assert!(copy_started);
    assert!(!fixture.locations.new_local.join(BUNDLE).exists());
    // Complete the actual import with the original, small fixture, not GiB I/O.
    file.set_len(original.len() as u64).unwrap();
    drop(file);
    let before = fixture.snapshot();
    let profile = fixture.import();
    let imported = Connection::open(profile.paths.document_state.join("state.sqlite")).unwrap();
    assert_eq!(crate::storage_limits::read(&imported).unwrap().revision, 1);
    assert_eq!(fixture.snapshot(), before);
}

#[test]
fn required_schema_constraints_are_checked_without_mutating_legacy() {
    let native_documents = "CREATE TABLE documents (id TEXT PRIMARY KEY, data TEXT NOT NULL, bytes INTEGER NOT NULL, revision INTEGER NOT NULL, root TEXT NOT NULL, path TEXT NOT NULL, generation INTEGER NOT NULL)";
    let native_quota = "CREATE TABLE quota (singleton INTEGER PRIMARY KEY CHECK(singleton=1), bytes INTEGER NOT NULL, documents INTEGER NOT NULL, generation INTEGER NOT NULL)";
    for mutation in [
        "no-pk",
        "unique-only",
        "collation",
        "nullable",
        "no-singleton-check",
        "composite-quota-pk",
        "wrong-index",
    ] {
        let fixture = Fixture::new(false);
        fixture.seed();
        let mut documents = native_documents.to_owned();
        let mut quota = native_quota.to_owned();
        let mut index = "CREATE INDEX document_location ON documents(root,path,generation)";
        match mutation {
            "no-pk" => documents = documents.replace("id TEXT PRIMARY KEY", "id TEXT"),
            "unique-only" => documents = documents.replace("id TEXT PRIMARY KEY", "id TEXT UNIQUE"),
            "collation" => {
                documents =
                    documents.replace("id TEXT PRIMARY KEY", "id TEXT COLLATE NOCASE PRIMARY KEY")
            }
            "nullable" => documents = documents.replace("data TEXT NOT NULL", "data TEXT"),
            "no-singleton-check" => quota = quota.replace(" CHECK(singleton=1)", ""),
            "composite-quota-pk" => {
                quota = quota
                    .replace("singleton INTEGER PRIMARY KEY", "singleton INTEGER")
                    .replace(
                        "generation INTEGER NOT NULL)",
                        "generation INTEGER NOT NULL, PRIMARY KEY(singleton,bytes))",
                    )
            }
            "wrong-index" => {
                index = "CREATE INDEX document_location ON documents(path,root,generation)"
            }
            _ => unreachable!(),
        }
        let connection = Connection::open(fixture.database()).unwrap();
        connection.execute_batch(&format!("DROP INDEX document_location; ALTER TABLE documents RENAME TO saved_documents; {documents}; INSERT INTO documents SELECT * FROM saved_documents; DROP TABLE saved_documents; {index}; ALTER TABLE quota RENAME TO saved_quota; {quota}; INSERT INTO quota SELECT * FROM saved_quota; DROP TABLE saved_quota;")).unwrap();
        if mutation == "no-pk" {
            // Readable rows alone pass the old validator, but runtime upsert fails.
            assert!(connection.execute_batch("INSERT INTO documents SELECT * FROM documents WHERE 0 ON CONFLICT(id) DO UPDATE SET revision=excluded.revision;").is_err());
        }
        drop(connection);
        let before = fixture.snapshot();
        assert!(
            matches!(
                prepare(&fixture.locations, Decision::ImportAfterLegacyExit),
                Err(MigrationError::UnsupportedDatabase)
            ),
            "{mutation}"
        );
        assert!(!fixture.locations.new_local.join(BUNDLE).exists());
        assert_eq!(before, fixture.snapshot());
    }
}

#[cfg(unix)]
#[test]
fn unreadable_current_settings_fail_closed_and_retry_after_permissions_restore() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new(false);
    fixture.seed();
    fs::create_dir_all(&fixture.locations.new_config).unwrap();
    let path = fixture.locations.new_config.join("settings.json");
    let retained = serde_json::to_vec(&json!({"knowledgeRoot":fixture.knowledge})).unwrap();
    fs::write(&path, &retained).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o0)).unwrap();
    assert!(matches!(
        prepare(&fixture.locations, Decision::KeepCurrent),
        Err(MigrationError::Unavailable)
    ));
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let profile = ready(prepare(&fixture.locations, Decision::KeepCurrent).unwrap());
    assert_eq!(profile.paths, fixture.locations.ordinary_paths());
    assert_eq!(fs::read(&path).unwrap(), retained);
}

#[test]
fn ordinary_current_hot_journal_recovers_under_the_same_lease() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let old = fixture.snapshot();
    let profile = fixture.import();
    let paths = profile.paths.clone();
    drop(profile);
    fs::rename(
        fixture.locations.new_local.join(BUNDLE),
        fixture._temp.path().join("bundle-retained"),
    )
    .unwrap();
    let retained = fixture._temp.path().join("bundle-retained");
    fs::rename(retained.join("config"), &fixture.locations.new_config).unwrap();
    fs::rename(
        retained.join("document-state"),
        fixture.locations.ordinary_paths().document_state,
    )
    .unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "identifier_migration::tests::fixture_child_crashes_current_transaction",
            "--ignored",
        ])
        .env("MOGLEDGE_MIGRATION_FIXTURE", fixture._temp.path())
        .env(
            "MOGLEDGE_MIGRATION_CURRENT_DB",
            "local/org.fixture.current/document-state/state.sqlite",
        )
        .fixture_status()
        .unwrap();
    assert_eq!(status.code(), Some(31));
    assert!(!paths.document_state.exists());
    assert!(matches!(
        prepare(&fixture.locations, Decision::Inspect).unwrap(),
        Startup::Conflict
    ));
    let current = ready(prepare(&fixture.locations, Decision::KeepCurrent).unwrap());
    assert_eq!(current.paths, fixture.locations.ordinary_paths());
    restore(&current.paths, 42);
    assert_eq!(old, fixture.snapshot());
}

#[cfg(unix)]
#[test]
fn current_recovery_rejects_unsafe_journals_and_permission_failure_is_retryable() {
    use std::os::unix::{fs::symlink, fs::PermissionsExt};
    for mutation in ["symlink", "hardlink", "super-journal", "read-only-db"] {
        let fixture = Fixture::new(false);
        fixture.seed();
        let old = fixture.snapshot();
        let profile = fixture.import();
        let paths = profile.paths.clone();
        drop(profile);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "identifier_migration::tests::fixture_child_crashes_current_transaction",
                "--ignored",
            ])
            .env("MOGLEDGE_MIGRATION_FIXTURE", fixture._temp.path())
            .fixture_status()
            .unwrap();
        assert_eq!(status.code(), Some(31));
        let db = paths.document_state.join("state.sqlite");
        let journal = paths.document_state.join("state.sqlite-journal");
        let retained = fixture._temp.path().join("journal-retained");
        if mutation == "read-only-db" {
            fs::set_permissions(&db, fs::Permissions::from_mode(0o400)).unwrap();
        } else {
            fs::rename(&journal, &retained).unwrap();
            match mutation {
                "symlink" => symlink(&retained, &journal).unwrap(),
                "hardlink" => fs::hard_link(&retained, &journal).unwrap(),
                "super-journal" => {
                    let mut bytes = fs::read(&retained).unwrap();
                    bytes.extend_from_slice(b"external-journal");
                    bytes.extend_from_slice(&[0; 8]);
                    bytes.extend_from_slice(&[0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);
                    fs::write(&journal, bytes).unwrap();
                }
                _ => unreachable!(),
            }
        }
        let current_db = fs::read(&db).unwrap();
        let current_journal = fs::read(&journal).unwrap();
        assert!(
            prepare(&fixture.locations, Decision::Inspect).is_err(),
            "{mutation}"
        );
        assert_eq!(fs::read(&db).unwrap(), current_db);
        assert_eq!(fs::read(&journal).unwrap(), current_journal);
        assert_eq!(old, fixture.snapshot());
        if mutation == "read-only-db" {
            fs::set_permissions(&db, fs::Permissions::from_mode(0o600)).unwrap();
        } else {
            fs::remove_file(&journal).unwrap();
            fs::rename(&retained, &journal).unwrap();
        }
        let recovered = ready(prepare(&fixture.locations, Decision::Inspect).unwrap());
        restore(&recovered.paths, 42);
        assert_eq!(old, fixture.snapshot());
    }
}

#[test]
fn current_order_writer_temp_survives_restart_without_changing_committed_payload() {
    let fixture = Fixture::new(false);
    fixture.seed();
    let old = fixture.snapshot();
    let profile = fixture.import();
    let paths = profile.paths.clone();
    drop(profile);
    let orders = paths.settings.parent().unwrap().join("tree-order");
    let committed = orders.join(fixture.order_name());
    let order_before = fs::read(&committed).unwrap();
    let database_before = fs::read(paths.document_state.join("state.sqlite")).unwrap();
    let temporary = orders.join(format!(".order-{}.tmp", crate::core::random_token()));
    fs::write(&temporary, b"incomplete, non-authoritative JSON").unwrap();
    let restarted = ready(prepare(&fixture.locations, Decision::Inspect).unwrap());
    assert_eq!(restarted.paths, paths);
    restore(&restarted.paths, 42);
    drop(restarted);
    let retried = ready(prepare(&fixture.locations, Decision::Inspect).unwrap());
    restore(&retried.paths, 42);
    assert_eq!(
        fs::read(&temporary).unwrap(),
        b"incomplete, non-authoritative JSON"
    );
    assert_eq!(fs::read(&committed).unwrap(), order_before);
    assert_eq!(
        fs::read(paths.document_state.join("state.sqlite")).unwrap(),
        database_before
    );
    assert_eq!(old, fixture.snapshot());
}

#[test]
fn current_order_unknown_temp_names_and_directories_remain_rejected() {
    for name in [
        "unexpected.tmp".to_owned(),
        ".order-abcd.tmp".to_owned(),
        format!(".order-{}.tmp", "g".repeat(64)),
        format!(".order-{}.tmp.extra", "a".repeat(64)),
        format!(".order-{}.tmp", "A".repeat(64)),
        format!(".order-{}.tmp", "b".repeat(64)),
    ] {
        let fixture = Fixture::new(false);
        fixture.seed();
        let old = fixture.snapshot();
        let profile = fixture.import();
        let paths = profile.paths.clone();
        drop(profile);
        let entry = paths
            .settings
            .parent()
            .unwrap()
            .join("tree-order")
            .join(&name);
        if name == format!(".order-{}.tmp", "b".repeat(64)) {
            fs::create_dir(&entry).unwrap();
        } else {
            fs::write(&entry, b"retained unknown fixture").unwrap();
        }
        assert!(
            prepare(&fixture.locations, Decision::Inspect).is_err(),
            "{name}"
        );
        assert!(entry.exists());
        assert_eq!(old, fixture.snapshot());
    }
}

#[cfg(unix)]
#[test]
fn current_order_writer_temp_symlink_and_hardlink_remain_rejected() {
    use std::os::unix::fs::symlink;
    for hardlink in [false, true] {
        let fixture = Fixture::new(false);
        fixture.seed();
        let old = fixture.snapshot();
        let profile = fixture.import();
        let paths = profile.paths.clone();
        drop(profile);
        let retained = fixture._temp.path().join("retained-target");
        fs::write(&retained, b"retained fixture").unwrap();
        let temporary = paths
            .settings
            .parent()
            .unwrap()
            .join("tree-order")
            .join(format!(".order-{}.tmp", crate::core::random_token()));
        if hardlink {
            fs::hard_link(&retained, &temporary).unwrap();
        } else {
            symlink(&retained, &temporary).unwrap();
        }
        assert!(prepare(&fixture.locations, Decision::Inspect).is_err());
        assert_eq!(fs::read(&retained).unwrap(), b"retained fixture");
        assert_eq!(fs::read(&temporary).unwrap(), b"retained fixture");
        assert_eq!(old, fixture.snapshot());
    }
}

#[test]
fn saved_root_identity_is_optional_for_legacy_and_validated_when_present() {
    for value in [
        json!({"knowledgeRoot":"root"}),
        json!({"knowledgeRoot":"root","knowledgeRootIdentity":"a".repeat(64),"future":true}),
    ] {
        assert!(super::validate_json(&serde_json::to_vec(&value).unwrap(), false).is_ok());
    }
    for identity in [
        json!(null),
        json!(true),
        json!("a".repeat(63)),
        json!("G".repeat(64)),
        json!("A".repeat(64)),
    ] {
        let bytes =
            serde_json::to_vec(&json!({"knowledgeRoot":"root","knowledgeRootIdentity":identity}))
                .unwrap();
        assert_eq!(
            super::validate_json(&bytes, false).unwrap_err(),
            MigrationError::Corrupt
        );
    }
}
