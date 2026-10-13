use super::*;
use crate::document_state::DocumentState;
use std::{fs, io::Cursor};

struct Fixture {
    _temporary: tempfile::TempDir,
    profile: std::path::PathBuf,
    root: std::path::PathBuf,
    identity: String,
    data: String,
}
impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let profile = temporary.path().join("com.shimilynx.myknowledge");
        let state = profile.join("document-state");
        drop(DocumentState::new(state.clone()).unwrap());
        fs::write(profile.join("identifier-migration.lock"), []).unwrap();
        let root = temporary.path().join("root");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("private.html"), b"<h1>synthetic source</h1>").unwrap();
        let (root, dir) = knowledge::open_root(&root).unwrap();
        let identity = knowledge::storage_identity(&root, &dir, "private.html").unwrap();
        let root_identity = knowledge::storage_root_identity(&dir).unwrap();
        let data =
            r#"{"fixture":{"schemaVersion":1,"data":{"secret":"SYNTHETIC_VALUE_NEVER_PRINT"}}}"#
                .to_owned();
        let connection = rusqlite::Connection::open(state.join("state.sqlite")).unwrap();
        connection
            .execute(
                "INSERT INTO documents VALUES(?1,?2,?3,4,?4,'private.html',1)",
                params![identity, data, data.len() as i64, root_identity],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE quota SET bytes=?1,documents=1,generation=1",
                [data.len() as i64],
            )
            .unwrap();
        drop(connection);
        Self {
            _temporary: temporary,
            profile,
            root,
            identity,
            data,
        }
    }
    fn session(&self) -> Session {
        Session::open(&self.profile, Some(&self.root)).unwrap()
    }
}
fn upgrade(session: &mut Session) {
    let plan = session.prepare("upgrade", "", None).unwrap();
    let id = plan["planId"].as_str().unwrap();
    session.confirm(id, id).unwrap();
}
fn snapshot_id(session: &Session) -> String {
    session.inspect(0, 20).unwrap()["snapshotId"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn prepare_selected(session: &mut Session, operation: &str, candidate: &str) -> String {
    let snapshot = snapshot_id(session);
    session
        .prepare(operation, candidate, Some(&snapshot))
        .unwrap()["planId"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn explicit_upgrade_selection_quarantine_restart_and_restore_preserve_private_value() {
    let fixture = Fixture::new();
    let mut session = fixture.session();
    assert_eq!(session.version().unwrap(), 1);
    let before = snapshot_id(&session);
    assert_eq!(
        session
            .prepare("quarantine", &fixture.identity, Some(&before))
            .unwrap_err()
            .code,
        "explicit_upgrade_required"
    );
    upgrade(&mut session);
    assert_eq!(session.version().unwrap(), 2);
    let inspection = session.inspect(0, 20).unwrap();
    let journal_bytes = fs::metadata(fixture.profile.join("document-state/state.sqlite-journal"))
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    assert_eq!(inspection["journalBytes"], journal_bytes);
    assert_eq!(
        inspection["candidates"][0]["sourceAvailability"],
        "same_identity_present"
    );
    let quarantine = prepare_selected(&mut session, "quarantine", &fixture.identity);
    assert_eq!(
        session.confirm(&quarantine, "wrong").unwrap_err().code,
        "explicit_confirmation_required"
    );
    let receipt = session.confirm(&quarantine, &quarantine).unwrap();
    assert_eq!(session.confirm(&quarantine, &quarantine).unwrap(), receipt);
    assert_eq!(session.inspect(0, 20).unwrap()["usage"]["records"], 0);
    let list = session.list_recovery(0, 20).unwrap();
    assert_eq!(list["entries"][0]["status"], "quarantined");
    for value in [inspection, receipt, list] {
        let output = value.to_string();
        assert!(!output.contains("SYNTHETIC_VALUE_NEVER_PRINT"));
        assert!(!output.contains("private.html"));
        assert!(!output.contains(fixture.profile.to_str().unwrap()));
    }
    drop(session);
    let mut session = fixture.session();
    assert_eq!(
        session.confirm(&quarantine, &quarantine).unwrap_err().code,
        "unknown_or_consumed_plan"
    );
    let restore = prepare_selected(&mut session, "restore", &quarantine);
    session.confirm(&restore, &restore).unwrap();
    assert_eq!(session.inspect(0, 20).unwrap()["usage"]["records"], 1);
    let (data, revision): (String, i64) = session
        .store
        .connection
        .query_row(
            "SELECT data,revision FROM documents WHERE id=?1",
            [&fixture.identity],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(data, fixture.data);
    assert_eq!(revision, 5);
    assert_eq!(
        session.list_recovery(0, 20).unwrap()["entries"][0]["status"],
        "restored"
    );
    assert_eq!(
        fs::read(fixture.root.join("private.html")).unwrap(),
        b"<h1>synthetic source</h1>"
    );
    drop(session);
    drop(DocumentState::new(fixture.profile.join("document-state")).unwrap());
}

#[test]
fn inspection_only_session_and_unknown_commands_do_not_upgrade_or_change_bytes() {
    let fixture = Fixture::new();
    let database = fixture.profile.join("document-state/state.sqlite");
    let before = fs::read(&database).unwrap();
    let mut input = Cursor::new(
        b"{\"command\":\"inspect\"}\n{\"command\":\"purge\"}\n{\"command\":\"quit\"}\n",
    );
    let mut output = Vec::new();
    let mut errors = Vec::new();
    assert_eq!(
        run(
            &fixture.profile,
            Some(&fixture.root),
            &mut input,
            &mut output,
            &mut errors
        ),
        0
    );
    assert!(errors.is_empty());
    assert_eq!(fs::read(&database).unwrap(), before);
    assert_eq!(fs::read_dir(database.parent().unwrap()).unwrap().count(), 1);
    let values: Vec<serde_json::Value> = String::from_utf8(output)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(values.len(), 2);
    assert_eq!(values[0]["ok"], true);
    assert_eq!(values[1]["ok"], false);
}

#[test]
fn disconnected_root_replacement_and_one_scan_absence_stay_on_hold() {
    let fixture = Fixture::new();
    let mut session = Session::open(&fixture.profile, None).unwrap();
    upgrade(&mut session);
    let snapshot = snapshot_id(&session);
    assert_eq!(
        session
            .prepare("quarantine", &fixture.identity, Some(&snapshot))
            .unwrap_err()
            .code,
        "source_unavailable_hold"
    );
    drop(session);
    fs::remove_file(fixture.root.join("private.html")).unwrap();
    let mut session = fixture.session();
    let inspection = session.inspect(0, 20).unwrap();
    assert_eq!(
        inspection["candidates"][0]["sourceAvailability"],
        "not_found_single_scan"
    );
    let snapshot = snapshot_id(&session);
    assert_eq!(
        session
            .prepare("quarantine", &fixture.identity, Some(&snapshot))
            .unwrap_err()
            .code,
        "source_unavailable_hold"
    );
    fs::write(fixture.root.join("private.html"), b"replacement").unwrap();
    let snapshot = snapshot_id(&session);
    assert_eq!(
        session
            .prepare("quarantine", &fixture.identity, Some(&snapshot))
            .unwrap_err()
            .code,
        "source_unavailable_hold"
    );
}

#[test]
fn same_identity_rename_after_selection_can_restore_but_replacement_is_rejected() {
    let fixture = Fixture::new();
    let mut session = fixture.session();
    upgrade(&mut session);
    let quarantine = prepare_selected(&mut session, "quarantine", &fixture.identity);
    fs::rename(
        fixture.root.join("private.html"),
        fixture.root.join("renamed.txt"),
    )
    .unwrap();
    session.confirm(&quarantine, &quarantine).unwrap();
    let restore = prepare_selected(&mut session, "restore", &quarantine);
    fs::rename(
        fixture.root.join("renamed.txt"),
        fixture.root.join("keep-original.txt"),
    )
    .unwrap();
    fs::write(fixture.root.join("renamed.txt"), b"new identity").unwrap();
    session.confirm(&restore, &restore).unwrap();
    let path: String = session
        .store
        .connection
        .query_row(
            "SELECT path FROM documents WHERE id=?1",
            [&fixture.identity],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(path, "keep-original.txt");
}

#[test]
fn root_switch_snapshot_change_expiry_and_empty_record_restore_conflict_preserve_archive() {
    let fixture = Fixture::new();
    let mut session = fixture.session();
    upgrade(&mut session);
    let plan = prepare_selected(&mut session, "quarantine", &fixture.identity);
    session.plans.get_mut(&plan).unwrap().expires_elapsed_ms = 0;
    assert_eq!(
        session.confirm(&plan, &plan).unwrap_err().code,
        "expired_plan"
    );
    let plan = prepare_selected(&mut session, "quarantine", &fixture.identity);
    session.store.connection.execute_batch("PRAGMA query_only=OFF; UPDATE quota SET generation=generation+1; PRAGMA query_only=ON;").unwrap();
    assert_eq!(
        session.confirm(&plan, &plan).unwrap_err().code,
        "state_changed"
    );
    let quarantine = prepare_selected(&mut session, "quarantine", &fixture.identity);
    session.confirm(&quarantine, &quarantine).unwrap();
    let restore = prepare_selected(&mut session, "restore", &quarantine);
    let selected = session.plans.get(&restore).unwrap().clone();
    session
        .store
        .connection
        .execute_batch("PRAGMA query_only=OFF;")
        .unwrap();
    let root_identity = session.root.as_ref().unwrap().identity.clone();
    session
        .store
        .connection
        .execute(
            "INSERT INTO documents VALUES(?1,'{}',2,7,?2,'private.html',7)",
            params![fixture.identity, root_identity],
        )
        .unwrap();
    session
        .store
        .connection
        .execute("UPDATE quota SET bytes=2,documents=1,generation=7", [])
        .unwrap();
    session
        .store
        .connection
        .execute_batch("PRAGMA query_only=ON;")
        .unwrap();
    session
        .store
        .connection
        .execute_batch("PRAGMA query_only=OFF;")
        .unwrap();
    assert_eq!(
        session.commit_record(&selected).unwrap_err().code,
        "restore_conflict_or_quota"
    );
    session
        .store
        .connection
        .execute_batch("PRAGMA query_only=ON;")
        .unwrap();
    assert_eq!(
        session.confirm(&restore, &restore).unwrap_err().code,
        "state_corrupt"
    );
}

#[test]
fn exclusive_session_blocks_other_runtime_and_sqlite_writers_until_closed() {
    let fixture = Fixture::new();
    let session = fixture.session();
    assert!(Session::open(&fixture.profile, Some(&fixture.root)).is_err());
    let connection =
        rusqlite::Connection::open(fixture.profile.join("document-state/state.sqlite")).unwrap();
    connection
        .busy_timeout(std::time::Duration::from_millis(1))
        .unwrap();
    assert!(connection
        .execute("UPDATE quota SET generation=2", [])
        .is_err());
    drop(session);
    assert_eq!(
        connection
            .execute("UPDATE quota SET generation=2", [])
            .unwrap(),
        1
    );
}

#[test]
fn unknown_fields_oversize_commands_and_invalid_confirmation_do_not_mutate() {
    let fixture = Fixture::new();
    let database = fixture.profile.join("document-state/state.sqlite");
    let before = fs::read(&database).unwrap();
    let mut input=Cursor::new(b"{\"command\":\"inspect\",\"confirmation\":true}\n{\"command\":\"confirm\",\"plan_id\":\"forged\",\"confirmation\":\"forged\"}\n");
    let mut output = Vec::new();
    let mut errors = Vec::new();
    assert_eq!(
        run(
            &fixture.profile,
            Some(&fixture.root),
            &mut input,
            &mut output,
            &mut errors
        ),
        0
    );
    assert_eq!(fs::read(&database).unwrap(), before);
    let mut input = Cursor::new(vec![b'x'; MAX_COMMAND_BYTES + 1]);
    assert_eq!(
        run(
            &fixture.profile,
            Some(&fixture.root),
            &mut input,
            &mut output,
            &mut errors
        ),
        2
    );
    assert_eq!(fs::read(&database).unwrap(), before);
}

#[test]
fn sqlite_full_during_quarantine_rolls_back_and_reselection_can_retry() {
    let fixture = Fixture::new();
    let mut session = fixture.session();
    let data = serde_json::json!({"fixture":{"schemaVersion":1,"data":"x".repeat(2*1024*1024)}})
        .to_string();
    session
        .store
        .connection
        .execute_batch("PRAGMA query_only=OFF;")
        .unwrap();
    session
        .store
        .connection
        .execute(
            "UPDATE documents SET data=?1,bytes=?2,generation=2",
            params![data, data.len() as i64],
        )
        .unwrap();
    session
        .store
        .connection
        .execute(
            "UPDATE quota SET bytes=?1,generation=2",
            [data.len() as i64],
        )
        .unwrap();
    session
        .store
        .connection
        .execute_batch("PRAGMA query_only=ON;")
        .unwrap();
    upgrade(&mut session);
    let pages: i64 = session
        .store
        .connection
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    session
        .store
        .connection
        .execute_batch(&format!("PRAGMA max_page_count={pages};"))
        .unwrap();
    let quarantine = prepare_selected(&mut session, "quarantine", &fixture.identity);
    assert!(session.confirm(&quarantine, &quarantine).is_err());
    let (active, archives): (i64, i64) = session
        .store
        .connection
        .query_row(
            "SELECT (SELECT count(*) FROM documents),(SELECT count(*) FROM recovery_records)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((active, archives), (1, 0));
    assert_eq!(
        session.inspect(0, 20).unwrap()["usage"]["logicalBytes"],
        data.len() as i64
    );
    session
        .store
        .connection
        .execute_batch("PRAGMA max_page_count=10000;")
        .unwrap();
    let quarantine = prepare_selected(&mut session, "quarantine", &fixture.identity);
    session.confirm(&quarantine, &quarantine).unwrap();
    assert_eq!(session.list_recovery(0, 20).unwrap()["totalRecords"], 1);
}

#[test]
fn root_replacement_after_confirmation_preview_preserves_the_active_record() {
    let fixture = Fixture::new();
    let mut session = fixture.session();
    upgrade(&mut session);
    let plan = prepare_selected(&mut session, "quarantine", &fixture.identity);
    #[cfg(windows)]
    {
        // Windows pins a selected root. Model disconnection before replacement.
        assert!(fs::rename(&fixture.root, fixture.root.with_extension("old")).is_err());
        session.root = None;
    }
    fs::rename(&fixture.root, fixture.root.with_extension("old")).unwrap();
    fs::create_dir(&fixture.root).unwrap();
    fs::write(fixture.root.join("private.html"), b"replacement root").unwrap();
    assert_eq!(
        session.confirm(&plan, &plan).unwrap_err().code,
        "source_unavailable_hold"
    );
    assert_eq!(session.inspect(0, 20).unwrap()["usage"]["records"], 1);
    assert_eq!(session.list_recovery(0, 20).unwrap()["totalRecords"], 0);
}

#[cfg(unix)]
#[test]
fn symlink_or_hidden_entries_make_absence_incomplete_without_hydrating_or_reading_bodies() {
    let fixture = Fixture::new();
    std::os::unix::fs::symlink("private.html", fixture.root.join("link.html")).unwrap();
    fs::write(fixture.root.join(".private"), b"synthetic").unwrap();
    let session = fixture.session();
    let observation = session.observation().unwrap();
    assert!(!observation.complete);
    assert_eq!(
        session.inspect(0, 20).unwrap()["candidates"][0]["sourceAvailability"],
        "same_identity_present"
    );
    fs::remove_file(fixture.root.join("private.html")).unwrap();
    assert_eq!(
        session.inspect(0, 20).unwrap()["candidates"][0]["sourceAvailability"],
        "unavailable"
    );
}

#[test]
fn interrupted_quarantine_and_restore_roll_back_and_allow_bounded_reselection() {
    use rusqlite::hooks::{Action, AuthAction, AuthContext, Authorization};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    // Cancel either an in-progress write (SQLite may automatically rollback),
    // or a SELECT after all writes (the caller must rollback its transaction).
    for restore in [false, true] {
        for interrupt_write in [false, true] {
            let fixture = Fixture::new();
            let mut session = fixture.session();
            upgrade(&mut session);
            let quarantine = prepare_selected(&mut session, "quarantine", &fixture.identity);
            let (operation, candidate) = if restore {
                session.confirm(&quarantine, &quarantine).unwrap();
                ("restore", quarantine)
            } else {
                ("quarantine", fixture.identity.clone())
            };
            let id = prepare_selected(&mut session, operation, &candidate);
            let plan = session.plans.remove(&id).unwrap();
            let before = session.store.database_snapshot();
            let quota_before = session
                .store
                .connection
                .query_row("SELECT bytes,documents,generation FROM quota", [], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, i64>(2)?,
                    ))
                })
                .unwrap();
            session
                .store
                .connection
                .execute_batch("PRAGMA query_only=OFF")
                .unwrap();
            let wrote = Arc::new(AtomicBool::new(false));
            let cancel = Arc::new(AtomicBool::new(false));
            let hook_wrote = Arc::clone(&wrote);
            let hook_cancel = Arc::clone(&cancel);
            session
                .store
                .connection
                .update_hook(Some(move |action, _: &str, table: &str, _: i64| {
                    if action == Action::SQLITE_UPDATE && table == "quota" {
                        hook_wrote.store(true, Ordering::SeqCst);
                        if interrupt_write {
                            hook_cancel.store(true, Ordering::SeqCst);
                        }
                    }
                }))
                .unwrap();
            let auth_wrote = Arc::clone(&wrote);
            let auth_cancel = Arc::clone(&cancel);
            session
                .store
                .connection
                .authorizer(Some(move |context: AuthContext<'_>| {
                    if matches!(context.action, AuthAction::Read { .. })
                        && auth_wrote.load(Ordering::SeqCst)
                    {
                        auth_cancel.store(true, Ordering::SeqCst);
                    }
                    Authorization::Allow
                }))
                .unwrap();
            let progress_cancel = Arc::clone(&cancel);
            session
                .store
                .connection
                .progress_handler(1, Some(move || progress_cancel.load(Ordering::SeqCst)))
                .unwrap();
            let error = session.commit_record(&plan).unwrap_err();
            assert!(wrote.load(Ordering::SeqCst));
            assert!(cancel.load(Ordering::SeqCst));
            assert_eq!(error.code, "inspection_limit");
            assert!(session.store.connection.is_autocommit());
            session
                .store
                .connection
                .update_hook(None::<fn(Action, &str, &str, i64)>)
                .unwrap();
            session
                .store
                .connection
                .authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
                .unwrap();
            session
                .store
                .connection
                .execute_batch("PRAGMA query_only=ON")
                .unwrap();
            assert_eq!(session.store.database_snapshot(), before);
            assert_eq!(
                session
                    .store
                    .connection
                    .query_row("SELECT bytes,documents,generation FROM quota", [], |r| Ok(
                        (
                            r.get::<_, i64>(0)?,
                            r.get::<_, i64>(1)?,
                            r.get::<_, i64>(2)?
                        )
                    ))
                    .unwrap(),
                quota_before
            );
            recovery_store::validate(&session.store.connection).unwrap();
            session
                .execute(Command::Inspect {
                    offset: 0,
                    limit: 20,
                })
                .unwrap();
            let retry = prepare_selected(&mut session, operation, &candidate);
            session.confirm(&retry, &retry).unwrap();
            assert!(session.store.connection.is_autocommit());
            assert_eq!(
                session.inspect(0, 20).unwrap()["usage"]["records"],
                i64::from(restore)
            );
        }
    }
}

#[test]
fn interrupted_snapshot_closes_read_transaction_and_next_command_succeeds() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    // Include interruption after BEGIN has changed autocommit but before its
    // VM returns success, as well as interruption while reading the report.
    for interrupt_begin in [Some(1), Some(3), None] {
        let fixture = Fixture::new();
        let mut session = fixture.session();
        let before = session.store.database_snapshot();
        let cancel = Arc::new(AtomicBool::new(interrupt_begin.is_some()));
        let auth_cancel = Arc::clone(&cancel);
        session
            .store
            .connection
            .authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(
                    context.action,
                    AuthAction::Read {
                        table_name: "quota",
                        ..
                    }
                ) {
                    auth_cancel.store(true, Ordering::SeqCst);
                }
                Authorization::Allow
            }))
            .unwrap();
        let progress_cancel = Arc::clone(&cancel);
        let operations = AtomicUsize::new(0);
        session
            .store
            .connection
            .progress_handler(
                1,
                Some(move || {
                    progress_cancel.load(Ordering::SeqCst)
                        && operations.fetch_add(1, Ordering::SeqCst) + 1
                            >= interrupt_begin.unwrap_or(1)
                }),
            )
            .unwrap();
        assert_eq!(
            session.snapshot(20, 0).err().unwrap().code,
            "inspection_limit"
        );
        assert!(cancel.load(Ordering::SeqCst));
        assert!(session.store.connection.is_autocommit());
        session
            .store
            .connection
            .authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
            .unwrap();
        assert_eq!(session.store.database_snapshot(), before);
        session.store.verify().unwrap();
        let response = session
            .execute(Command::Inspect {
                offset: 0,
                limit: 20,
            })
            .unwrap()
            .unwrap();
        assert_eq!(response["usage"]["records"], 1);
        assert!(session.store.connection.is_autocommit());
    }
}

#[test]
fn snapshot_restores_finite_query_budget_and_next_command_renews_it() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
    let fixture = Fixture::new();
    let mut session = fixture.session();
    session.snapshot(20, 0).unwrap();
    // A watchdog bounds a regression in which cleanup forgets to reinstall the
    // query budget. The production progress callback must interrupt first.
    let fallback = Arc::new(AtomicBool::new(false));
    let watchdog_fallback = Arc::clone(&fallback);
    let interrupt = session.store.connection.get_interrupt_handle();
    let (finished, receiver) = mpsc::channel();
    let watchdog = std::thread::spawn(move || {
        if receiver
            .recv_timeout(std::time::Duration::from_secs(8))
            .is_err()
        {
            watchdog_fallback.store(true, Ordering::SeqCst);
            interrupt.interrupt();
        }
    });
    let error = session
        .store
        .connection
        .query_row(
            "WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_err();
    finished.send(()).unwrap();
    watchdog.join().unwrap();
    assert!(!fallback.load(Ordering::SeqCst));
    assert_eq!(
        error.sqlite_error_code(),
        Some(rusqlite::ErrorCode::OperationInterrupted)
    );
    assert!(session.store.connection.is_autocommit());
    session
        .execute(Command::Inspect {
            offset: 0,
            limit: 20,
        })
        .unwrap();
    assert!(session.store.connection.is_autocommit());
}
