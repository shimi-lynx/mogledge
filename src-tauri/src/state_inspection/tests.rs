use super::*;
use crate::document_state::DocumentState;
use rusqlite::params;
use serde_json::Value;
use std::{collections::BTreeMap, fs};

struct Fixture {
    _base: tempfile::TempDir,
    state: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let base = tempfile::tempdir().unwrap();
        let state = base.path().join("state");
        drop(DocumentState::new(state.clone()).unwrap());
        Self { _base: base, state }
    }

    fn connect(&self) -> Connection {
        Connection::open(self.state.join("state.sqlite")).unwrap()
    }

    fn records(&self, records: &[(u64, u64, &str, &str)]) {
        let mut connection = self.connect();
        let transaction = connection.transaction().unwrap();
        for (generation, (id, root, path, data)) in records.iter().enumerate() {
            transaction
                .execute(
                    "INSERT INTO documents VALUES (?1,?2,?3,1,?4,?5,?6)",
                    params![
                        digest(*id),
                        data,
                        data.len() as i64,
                        digest(*root),
                        path,
                        generation as i64 + 1
                    ],
                )
                .unwrap();
        }
        transaction.execute("UPDATE quota SET bytes=(SELECT coalesce(sum(bytes),0) FROM documents),documents=(SELECT count(*) FROM documents),generation=(SELECT coalesce(max(generation),0) FROM documents)", []).unwrap();
        transaction.commit().unwrap();
    }
}

fn digest(value: u64) -> String {
    format!("{value:064x}")
}

fn contents(directory: &Path) -> BTreeMap<OsString, Vec<u8>> {
    fs::read_dir(directory)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (entry.file_name(), fs::read(entry.path()).unwrap())
        })
        .collect()
}

fn cli(directory: &Path, extra: &[&str]) -> (i32, Vec<u8>, Vec<u8>) {
    let arguments = [
        OsString::from("inspect"),
        OsString::from("--state-dir"),
        directory.as_os_str().to_owned(),
    ]
    .into_iter()
    .chain(extra.iter().map(OsString::from));
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let status = run(arguments, &mut stdout, &mut stderr);
    (status, stdout, stderr)
}

fn failure(directory: &Path, expected: &str) {
    let (status, stdout, stderr) = cli(directory, &[]);
    assert_eq!(status, 2);
    assert!(stdout.is_empty());
    let value: Value = serde_json::from_slice(&stderr).unwrap();
    assert_eq!(value["code"], expected);
    assert!(!String::from_utf8(stderr)
        .unwrap()
        .contains(directory.to_str().unwrap()));
}

#[test]
fn report_holds_all_metadata_candidates_and_preserves_bytes_and_privacy() {
    let fixture = Fixture::new();
    let secret = r#"{"private_app":{"password":"SYNTHETIC_SECRET_DO_NOT_PRINT"}}"#;
    fixture.records(&[
        (1, 10, "private-path/page.html", "{}"),
        (2, 10, "private-path/page.html", secret),
        (3, 11, "missing-folder/unobserved.html", "{}"),
    ]);
    let before = contents(&fixture.state);
    let (status, stdout, stderr) = cli(&fixture.state, &[]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    let text = String::from_utf8(stdout.clone()).unwrap();
    for forbidden in [
        "SYNTHETIC_SECRET_DO_NOT_PRINT",
        "private_app",
        "private-path",
        "missing-folder",
        fixture.state.to_str().unwrap(),
    ] {
        assert!(!text.contains(forbidden), "{forbidden}");
    }
    let value: Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["databaseSchemaVersion"], 1);
    assert_eq!(value["dryRun"], true);
    assert_eq!(value["cleanupAuthorized"], false);
    assert_eq!(value["metadataComplete"], true);
    assert_eq!(value["sourceScan"], "not_performed");
    assert_eq!(value["stateJsonValidation"], "not_checked");
    assert_eq!(value["usage"]["records"], 3);
    assert_eq!(value["usage"]["logicalBytes"], secret.len() as i64 + 4);
    assert_eq!(value["usage"]["emptyRecords"], 2);
    assert_eq!(value["usage"]["recoveryHistoryCandidates"], 2);
    assert_eq!(value["roots"][digest(10)]["records"], 2);
    assert_eq!(value["roots"][digest(11)]["records"], 1);
    for candidate in value["candidates"].as_array().unwrap() {
        assert_eq!(candidate["decision"], "hold");
        assert_eq!(candidate["activity"], "unknown");
        assert_eq!(candidate["sourceAvailability"], "not_checked");
        assert!(candidate["lastViewedAt"].is_null());
        assert!(candidate["lastObservedAt"].is_null());
        let reasons = candidate["reasons"].as_array().unwrap();
        assert!(reasons.contains(&Value::from("source_not_checked")));
        assert!(reasons.contains(&Value::from("activity_unknown")));
    }
    let candidates = value["candidates"].as_array().unwrap();
    assert!(candidates[0]["reasons"]
        .as_array()
        .unwrap()
        .contains(&Value::from("empty_record")));
    assert!(candidates[1]["reasons"]
        .as_array()
        .unwrap()
        .contains(&Value::from("possible_recovery_history")));
    for field in [
        "backupBytes",
        "quarantineBytes",
        "reclaimableLogicalBytes",
        "reclaimableDiskBytes",
    ] {
        assert!(value[field].is_null());
    }
    for field in ["journalBytes", "walBytes", "shmBytes"] {
        assert_eq!(value[field], 0);
    }
    assert_eq!(contents(&fixture.state), before);
}

#[test]
fn empty_database_is_reported_without_initialization_or_candidates() {
    let fixture = Fixture::new();
    let before = contents(&fixture.state);
    let report = inspect(&fixture.state, 20, 0, None).unwrap();
    assert_eq!(report.usage.records, 0);
    assert_eq!(report.usage.logical_bytes, 0);
    assert!(report.roots.is_empty());
    assert!(report.candidates.is_empty());
    assert!(!report.has_more);
    assert_eq!(contents(&fixture.state), before);
}

#[test]
fn pages_share_snapshot_but_metadata_only_remap_invalidates_it() {
    let fixture = Fixture::new();
    fixture.records(&[
        (3, 10, "three.html", "{}"),
        (1, 10, "one.html", "{}"),
        (2, 10, "two.html", "{}"),
    ]);
    let first = inspect(&fixture.state, 1, 0, None).unwrap();
    let second = inspect(&fixture.state, 1, 1, Some(&first.snapshot_id)).unwrap();
    let last = inspect(&fixture.state, 1, 2, Some(&first.snapshot_id)).unwrap();
    assert_eq!(first.snapshot_id, second.snapshot_id);
    assert_eq!(first.database_id, second.database_id);
    assert_ne!(first.report_id, second.report_id);
    assert!(first.has_more && second.has_more);
    assert!(!last.has_more);
    assert_eq!(first.candidates[0].document_identity, digest(1));
    assert_eq!(second.candidates[0].document_identity, digest(2));
    assert_eq!(last.candidates[0].document_identity, digest(3));
    assert!(inspect(&fixture.state, 20, 4096, None)
        .unwrap()
        .candidates
        .is_empty());
    fixture
        .connect()
        .execute(
            "UPDATE documents SET path='remapped.html' WHERE id=?1",
            [digest(1)],
        )
        .unwrap();
    let changed = inspect(&fixture.state, 1, 0, None).unwrap();
    assert_eq!(changed.database_generation, first.database_generation);
    assert_ne!(changed.snapshot_id, first.snapshot_id);
    assert!(matches!(
        inspect(&fixture.state, 1, 1, Some(&first.snapshot_id)),
        Err(MigrationError::SourceChanged)
    ));
    let (status, stdout, stderr) = cli(&fixture.state, &["--snapshot-id", &first.snapshot_id]);
    assert_eq!(status, 2);
    assert!(stdout.is_empty());
    assert_eq!(
        serde_json::from_slice::<Value>(&stderr).unwrap()["code"],
        "state_changed"
    );
}

#[test]
fn state_json_is_deliberately_unvalidated_and_never_returned() {
    let fixture = Fixture::new();
    fixture.records(&[(1, 10, "not-parsed.html", "invalid JSON synthetic body")]);
    let report = inspect(&fixture.state, 20, 0, None).unwrap();
    assert_eq!(report.state_json_validation, "not_checked");
    assert_eq!(report.usage.records, 1);
    assert_eq!(report.usage.empty_records, 0);
    assert!(!String::from_utf8(serde_json::to_vec(&report).unwrap())
        .unwrap()
        .contains("invalid JSON"));
}

#[test]
fn cli_rejects_duplicates_bounds_unknown_options_and_all_write_commands() {
    let fixture = Fixture::new();
    let before = contents(&fixture.state);
    for options in [
        vec!["--limit", "0"],
        vec!["--limit", "101"],
        vec!["--offset", "4097"],
        vec!["--offset", "-1"],
        vec!["--limit", "1", "--limit", "2"],
        vec!["--state-dir", "ignored"],
        vec!["--snapshot-id", "ABC"],
        vec!["--format", "text"],
        vec!["--force", "yes"],
        vec!["--limit"],
    ] {
        let (status, stdout, stderr) = cli(&fixture.state, &options);
        assert_eq!(status, 2, "{options:?}");
        assert!(stdout.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&stderr).unwrap()["code"],
            "invalid_arguments"
        );
    }
    for command in [
        "delete",
        "restore",
        "quarantine",
        "vacuum",
        "cleanup",
        "inspect inspect",
    ] {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        assert_eq!(
            run(
                [
                    OsString::from(command),
                    OsString::from("--state-dir"),
                    fixture.state.as_os_str().to_owned()
                ],
                &mut stdout,
                &mut stderr
            ),
            2
        );
        assert!(stdout.is_empty());
    }
    let (status, _, stderr) = cli(Path::new("relative-state"), &[]);
    assert_eq!(status, 2);
    assert_eq!(
        serde_json::from_slice::<Value>(&stderr).unwrap()["code"],
        "invalid_arguments"
    );
    assert_eq!(contents(&fixture.state), before);
}

#[test]
fn missing_database_or_directory_is_not_created() {
    let base = tempfile::tempdir().unwrap();
    let missing = base.path().join("missing");
    failure(&missing, "state_unavailable");
    assert!(!missing.exists());
    fs::create_dir(&missing).unwrap();
    failure(&missing, "state_unavailable");
    assert!(fs::read_dir(missing).unwrap().next().is_none());
}

#[test]
fn unsupported_schema_and_wal_header_are_refused_without_changes() {
    for ddl in [
        "PRAGMA user_version=2",
        "CREATE TABLE extra(secret TEXT)",
        "CREATE TRIGGER unexpected AFTER INSERT ON documents BEGIN UPDATE quota SET bytes=0; END",
    ] {
        let fixture = Fixture::new();
        fixture.connect().execute_batch(ddl).unwrap();
        let before = contents(&fixture.state);
        failure(&fixture.state, "unsupported_state");
        assert_eq!(contents(&fixture.state), before);
    }
    let fixture = Fixture::new();
    let path = fixture.state.join("state.sqlite");
    let mut data = fs::read(&path).unwrap();
    data[18] = 2;
    data[19] = 2;
    fs::write(&path, data).unwrap();
    let before = contents(&fixture.state);
    failure(&fixture.state, "unsupported_state");
    assert_eq!(contents(&fixture.state), before);
}

#[test]
fn metadata_inconsistencies_and_corrupt_headers_are_not_repaired() {
    for sql in [
        "UPDATE quota SET bytes=9",
        "UPDATE quota SET documents=2",
        "UPDATE documents SET bytes=0",
        "UPDATE documents SET revision=0",
        "UPDATE documents SET generation=9",
        "UPDATE documents SET root='bad-id'",
        "UPDATE documents SET path='../outside.html'",
        "UPDATE documents SET path=zeroblob(8192)",
        "UPDATE documents SET bytes=1.5",
        "UPDATE documents SET data='{} '",
    ] {
        let fixture = Fixture::new();
        fixture.records(&[(1, 10, "page.html", "{}")]);
        fixture.connect().execute_batch(sql).unwrap();
        let before = contents(&fixture.state);
        failure(&fixture.state, "state_corrupt");
        assert_eq!(contents(&fixture.state), before);
    }
    let fixture = Fixture::new();
    fs::write(
        fixture.state.join("state.sqlite"),
        b"synthetic corrupt database",
    )
    .unwrap();
    let before = contents(&fixture.state);
    failure(&fixture.state, "state_corrupt");
    assert_eq!(contents(&fixture.state), before);
}

#[test]
fn sidecars_and_unknown_entries_are_not_opened_or_removed() {
    for name in [
        "state.sqlite-journal",
        "state.sqlite-wal",
        "state.sqlite-shm",
        "backup.sqlite",
    ] {
        let fixture = Fixture::new();
        fs::write(fixture.state.join(name), b"synthetic sidecar secret").unwrap();
        let before = contents(&fixture.state);
        failure(&fixture.state, "unsupported_state");
        assert_eq!(contents(&fixture.state), before);
    }
}

#[test]
fn exclusive_database_lock_fails_with_busy_and_preserves_data() {
    let fixture = Fixture::new();
    let connection = fixture.connect();
    connection.execute_batch("BEGIN EXCLUSIVE").unwrap();
    let before = contents(&fixture.state);
    failure(&fixture.state, "state_busy");
    assert_eq!(contents(&fixture.state), before);
    connection.execute_batch("ROLLBACK").unwrap();
    assert!(inspect(&fixture.state, 20, 0, None).is_ok());
}

#[test]
fn snapshot_connection_rejects_writes_and_detects_new_sidecars() {
    let fixture = Fixture::new();
    let before = contents(&fixture.state);
    identifier_migration::inspect_state_snapshot(&fixture.state, |connection, _, _| {
        let failure = connection
            .execute("UPDATE quota SET generation=1", [])
            .unwrap_err();
        assert_eq!(failure.sqlite_error_code(), Some(ErrorCode::ReadOnly));
        Ok(())
    })
    .unwrap();
    assert_eq!(contents(&fixture.state), before);
    let result = identifier_migration::inspect_state_snapshot(&fixture.state, |_, _, _| {
        fs::write(
            fixture.state.join("state.sqlite-journal"),
            b"synthetic concurrent sidecar",
        )
        .unwrap();
        Ok(())
    });
    assert!(matches!(result, Err(MigrationError::UnsupportedDatabase)));
    assert_eq!(
        fs::read(fixture.state.join("state.sqlite-journal")).unwrap(),
        b"synthetic concurrent sidecar"
    );
    assert_eq!(
        fs::read(fixture.state.join("state.sqlite")).unwrap(),
        before[&OsString::from("state.sqlite")]
    );
}

#[cfg(unix)]
#[test]
fn links_and_replaced_directory_are_rejected() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new();
    let alias = fixture._base.path().join("alias");
    symlink(&fixture.state, &alias).unwrap();
    failure(&alias, "unsafe_path");
    let database = fixture.state.join("state.sqlite");
    let original = fixture._base.path().join("original.sqlite");
    fs::rename(&database, &original).unwrap();
    symlink(&original, &database).unwrap();
    assert!(inspect(&fixture.state, 20, 0, None).is_err());
    fs::remove_file(&database).unwrap();
    fs::hard_link(&original, &database).unwrap();
    assert!(inspect(&fixture.state, 20, 0, None).is_err());
    fs::remove_file(&database).unwrap();
    fs::rename(&original, &database).unwrap();
    let moved = fixture._base.path().join("moved");
    let result = identifier_migration::inspect_state_snapshot(&fixture.state, |_, _, _| {
        fs::rename(&fixture.state, &moved).unwrap();
        fs::create_dir(&fixture.state).unwrap();
        Ok(())
    });
    assert!(matches!(result, Err(MigrationError::SourceChanged)));
    assert!(moved.join("state.sqlite").is_file());
    assert!(fs::read_dir(&fixture.state).unwrap().next().is_none());
}

#[test]
fn maximum_record_count_is_paged_and_one_over_is_rejected() {
    let fixture = Fixture::new();
    let mut connection = fixture.connect();
    let transaction = connection.transaction().unwrap();
    for id in 1..=4096 {
        transaction
            .execute(
                "INSERT INTO documents VALUES (?1,'{}',2,1,?2,?3,?4)",
                params![
                    digest(id),
                    digest(id),
                    format!("unobserved-{id}.html"),
                    id as i64
                ],
            )
            .unwrap();
    }
    transaction
        .execute(
            "UPDATE quota SET bytes=8192,documents=4096,generation=4096",
            [],
        )
        .unwrap();
    transaction.commit().unwrap();
    drop(connection);
    let (status, stdout, stderr) = cli(&fixture.state, &["--limit", "100", "--offset", "4000"]);
    assert_eq!(status, 0);
    assert!(stderr.is_empty());
    assert!(stdout.len() <= MAX_REPORT_BYTES);
    let value: Value = serde_json::from_slice(&stdout).unwrap();
    assert_eq!(value["usage"]["records"], 4096);
    assert_eq!(value["roots"].as_object().unwrap().len(), 4096);
    assert_eq!(value["candidates"].as_array().unwrap().len(), 96);
    assert_eq!(value["hasMore"], false);
    fixture
        .connect()
        .execute(
            "INSERT INTO documents VALUES (?1,'{}',2,1,?2,'over.html',4097)",
            params![digest(4097), digest(10)],
        )
        .unwrap();
    failure(&fixture.state, "state_corrupt");
}

#[test]
fn inspection_progress_deadline_interrupts_an_unbounded_metadata_query() {
    let fixture = Fixture::new();
    let before = contents(&fixture.state);
    let result = identifier_migration::inspect_state_snapshot(
        &fixture.state,
        |connection, _, _| {
            let result = connection.query_row("WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n", [], |row| row.get::<_, i64>(0));
            assert_eq!(
                result.unwrap_err().sqlite_error_code(),
                Some(ErrorCode::OperationInterrupted)
            );
            Err::<(), _>(MigrationError::Interrupted)
        },
    );
    assert!(matches!(result, Err(MigrationError::Interrupted)));
    assert_eq!(contents(&fixture.state), before);
}
