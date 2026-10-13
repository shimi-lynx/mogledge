use super::*;
use crate::document_state::{self, DocumentState, Operation, StateRequest};
#[cfg(unix)]
use crate::identifier_migration::tests::FixtureCommand;
use std::{fs, path::PathBuf};

#[test]
fn shared_transfer_state_is_send_and_sync() {
    fn assert_shared<T: Send + Sync>() {}
    assert_shared::<Core>();
    assert_shared::<Service>();
    assert_shared::<SelectedFile>();
    assert_shared::<Plan>();
    assert_shared::<files::Location>();
    assert_shared::<crate::write_fs::RetainedDir>();
}

struct Fixture {
    core: Arc<Core>,
    _temp: tempfile::TempDir,
    root: PathBuf,
    files: PathBuf,
    context: Context,
    source: String,
    active: String,
    hidden: String,
    placeholder: String,
    other: String,
    browser: String,
}
impl Fixture {
    fn new() -> Self {
        Self::new_with_layout(false)
    }
    fn new_with_layout(migrated: bool) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let files = temp.path().join("files");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&files).unwrap();
        for name in ["source.html", "target.html", "other.html"] {
            fs::write(root.join(name), b"<p>synthetic</p>").unwrap();
        }
        let core = Core::new(19971);
        let profile = temp.path().join("profile");
        let state_directory = if migrated {
            profile.join("identifier-migration-v1/document-state")
        } else {
            profile.join("document-state")
        };
        core.document_state
            .set(DocumentState::new_in_profile(state_directory, profile).unwrap())
            .ok()
            .unwrap();
        let snapshot = core.select(&root, false).unwrap();
        let context = Context {
            workspace_id: snapshot.workspace_id.unwrap(),
            view_id: snapshot.view_id,
        };
        let create = |path| {
            core.create_tab(&context.workspace_id, &context.view_id, path)
                .unwrap()
        };
        let source = create("source.html");
        let active = create("target.html");
        let hidden = create("target.html");
        let placeholder = create("target.html");
        let other = create("other.html");
        for tab in [&source, &active, &hidden, &other] {
            core.open(&context.workspace_id, &context.view_id, tab, 1)
                .unwrap();
        }
        let (browser, request) = core
            .browser_tab(&context.workspace_id, &context.view_id, "target.html")
            .unwrap();
        core.open(&context.workspace_id, &context.view_id, &browser, request)
            .unwrap();
        let f = Self {
            core,
            _temp: temp,
            root,
            files,
            context,
            source,
            active,
            hidden,
            placeholder,
            other,
            browser,
        };
        f.write(
            &f.source,
            json!({"schemaVersion":2,"data":{"secret":"SYNTHETIC_INCOMING","unicode":"日本語"}}),
        );
        f.write(
            &f.active,
            json!({"schemaVersion":2,"data":{"secret":"SYNTHETIC_PREVIOUS"}}),
        );
        f
    }
    fn token(&self, tab: &str) -> String {
        self.core.workspace.lock().unwrap().tabs[tab]
            .session
            .as_ref()
            .unwrap()
            .token
            .clone()
    }
    fn write(&self, tab: &str, value: Value) {
        document_state::operate(
            &self.core,
            &self.token(tab),
            StateRequest {
                version: 1,
                op: Operation::Write,
                key: "app".into(),
                value: Some(value),
            },
        )
        .unwrap();
    }
    fn id(&self, path: &str) -> String {
        target(&self.core, &self.context, path).unwrap().identity
    }
    fn saved(&self) -> (String, i64, i64, i64, i64) {
        let id = self.id("target.html");
        self.core
            .document_state
            .get()
            .unwrap()
            .transfer_connection(|c, _| {
                let (data, revision): (String, i64) = c
                    .query_row(
                        "SELECT data,revision FROM documents WHERE id=?1",
                        [id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .map_err(sql_error)?;
                let (bytes, count, generation) = c
                    .query_row("SELECT bytes,documents,generation FROM quota", [], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                    })
                    .map_err(sql_error)?;
                Ok((data, revision, bytes, count, generation))
            })
            .unwrap()
    }
    fn select(&self, kind: FileKind, path: &Path) -> String {
        select_file(&self.core, self.context.clone(), kind, path).unwrap()["fileId"]
            .as_str()
            .unwrap()
            .into()
    }
    fn prepare(&self, path: &str, file_id: String, backup_file_id: Option<String>) -> Value {
        prepare(
            &self.core,
            PrepareRequest {
                context: self.context.clone(),
                relative_path: path.into(),
                file_id,
                backup_file_id,
                active_tab_ids: vec![self.active.clone()],
            },
        )
        .unwrap()
    }
    fn confirmation(&self, preview: &Value) -> Confirmation {
        let id = preview["planId"].as_str().unwrap().to_owned();
        Confirmation {
            context: self.context.clone(),
            plan_id: id.clone(),
            confirmation: id.clone(),
            replace_confirmation: Some(id.clone()),
            stop_reload_confirmation: Some(id),
        }
    }
    fn export(&self) -> PathBuf {
        let path = self.files.join("input.json");
        let preview = self.prepare("source.html", self.select(FileKind::Export, &path), None);
        confirm(&self.core, self.confirmation(&preview)).unwrap();
        path
    }
    fn import(&self) -> (Value, PathBuf, PathBuf) {
        let input = self.export();
        let backup = self.files.join("backup.json");
        let preview = self.prepare(
            "target.html",
            self.select(FileKind::Import, &input),
            Some(self.select(FileKind::Backup, &backup)),
        );
        (preview, input, backup)
    }
}

#[test]
fn live_preview_separates_confirmation_and_reloads_only_real_target_views() {
    let f = Fixture::new();
    let old = f.saved();
    let old_tokens: Vec<_> = [&f.active, &f.hidden, &f.browser]
        .iter()
        .map(|id| f.token(id))
        .collect();
    let other_token = f.token(&f.other);
    let (preview, input, backup) = f.import();
    assert_eq!(preview["unflushedInput"], "unknown");
    assert_eq!(preview["browserGrants"], 1);
    assert_eq!(preview["affectedViews"].as_array().unwrap().len(), 2);
    let views = preview["affectedViews"].as_array().unwrap();
    assert!(views
        .iter()
        .any(|v| v["tabId"] == f.active && v["visibility"] == "active"));
    assert!(views
        .iter()
        .any(|v| v["tabId"] == f.hidden && v["visibility"] == "hidden"));
    assert!(!backup.exists());
    assert_eq!(f.saved(), old);
    let mut missing = f.confirmation(&preview);
    missing.replace_confirmation = None;
    assert_eq!(
        confirm(&f.core, missing).unwrap_err().code,
        "explicit_replace_confirmation_required"
    );
    let mut missing = f.confirmation(&preview);
    missing.stop_reload_confirmation = None;
    assert_eq!(
        confirm(&f.core, missing).unwrap_err().code,
        "explicit_stop_reload_confirmation_required"
    );
    assert_eq!(f.token(&f.active), old_tokens[0]);
    assert!(!backup.exists());
    let receipt = confirm(&f.core, f.confirmation(&preview)).unwrap();
    let reload = receipt["reloadTabIds"].as_array().unwrap();
    assert_eq!(reload.len(), 2);
    assert!(reload.contains(&json!(f.active)));
    assert!(reload.contains(&json!(f.hidden)));
    assert!(!reload.contains(&json!(f.placeholder)));
    assert!(!reload.contains(&json!(f.browser)));
    for token in old_tokens {
        assert!(f.core.session_for_token(&token).is_none());
    }
    assert!(f.core.session_for_token(&other_token).is_some());
    let workspace = f.core.workspace.lock().unwrap();
    assert_eq!(workspace.tabs.len(), 6);
    assert!(workspace.tabs[&f.placeholder].session.is_none());
    drop(workspace);
    let preserved: Value = serde_json::from_slice(&fs::read(backup).unwrap()).unwrap();
    assert_eq!(
        preserved["apps"],
        serde_json::from_str::<Value>(&old.0).unwrap()
    );
    assert_eq!(f.saved().1, old.1 + 1);
    let file = f.select(FileKind::Import, &input);
    assert_eq!(
        verify_import(
            &f.core,
            &f.context,
            "target.html",
            &f.id("target.html"),
            &file
        )
        .unwrap()["matches"],
        true
    );
    // Same confirmed operation returns the receipt without a second revision.
    assert_eq!(confirm(&f.core, f.confirmation(&preview)).unwrap(), receipt);
    assert_eq!(
        verify_operation(&f.core, &f.context, preview["planId"].as_str().unwrap()).unwrap()
            ["receipt"],
        receipt
    );
    assert_eq!(f.saved().1, old.1 + 1);
    fs::write(f.root.join("target.html"), b"<p>synthetic</p>").unwrap();
    f.core
        .open(&f.context.workspace_id, &f.context.view_id, &f.active, 2)
        .unwrap();
    f.write(
        &f.active,
        json!({"schemaVersion":2,"data":"ordinary save after import"}),
    );
    assert_eq!(f.saved().1, old.1 + 2);
}

#[test]
fn cancellation_does_not_close_views_or_change_state_and_cannot_reconfirm() {
    let f = Fixture::new();
    let old = f.saved();
    let token = f.token(&f.active);
    let (preview, _, backup) = f.import();
    let id = preview["planId"].as_str().unwrap();
    assert_eq!(
        cancel(&f.core, &f.context, id).unwrap()["status"],
        "cancelled"
    );
    assert_eq!(f.token(&f.active), token);
    assert_eq!(f.saved(), old);
    assert!(!backup.exists());
    assert_eq!(
        confirm(&f.core, f.confirmation(&preview)).unwrap_err().code,
        "plan_not_pending"
    );
}

#[test]
fn confirmed_target_revision_file_and_view_changes_require_new_preview() {
    for change in ["write", "file", "view", "workspace", "target"] {
        let f = Fixture::new();
        let (preview, input, backup) = f.import();
        match change {
            "write" => f.write(
                &f.active,
                json!({"schemaVersion":2,"data":"new acknowledgement"}),
            ),
            "file" => {
                let mut file: Value = serde_json::from_slice(&fs::read(&input).unwrap()).unwrap();
                file["apps"]["app"]["data"] = json!("changed");
                fs::write(&input, file.to_string()).unwrap();
            }
            "view" => {
                f.core
                    .create_tab(&f.context.workspace_id, &f.context.view_id, "target.html")
                    .unwrap();
            }
            "workspace" => {
                f.core.begin_view();
            }
            "target" => {
                fs::rename(f.root.join("target.html"), f.root.join("previous.html")).unwrap();
                fs::write(f.root.join("target.html"), b"replacement").unwrap();
            }
            _ => unreachable!(),
        }
        let before = f
            .core
            .document_state
            .get()
            .unwrap()
            .transfer_connection(|c, _| {
                c.query_row("SELECT sum(revision),sum(bytes) FROM documents", [], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                })
                .map_err(sql_error)
            })
            .unwrap();
        assert!(
            confirm(&f.core, f.confirmation(&preview)).is_err(),
            "{change}"
        );
        let after = f
            .core
            .document_state
            .get()
            .unwrap()
            .transfer_connection(|c, _| {
                c.query_row("SELECT sum(revision),sum(bytes) FROM documents", [], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                })
                .map_err(sql_error)
            })
            .unwrap();
        assert_eq!(before, after);
        assert!(!backup.exists());
    }
}

#[test]
fn sessionless_inflight_open_cannot_publish_grant_after_import() {
    let f = Fixture::new();
    let input = f.export();
    let backup = f.files.join("backup.json");
    let file = f.select(FileKind::Import, &input);
    let backup_id = f.select(FileKind::Backup, &backup);
    let result = f.core.open_with(
        &f.context.workspace_id,
        &f.context.view_id,
        &f.placeholder,
        1,
        |root, dir, path| {
            let preview = f.prepare("target.html", file.clone(), Some(backup_id.clone()));
            assert_eq!(preview["openingRequests"], 1);
            let receipt = confirm(&f.core, f.confirmation(&preview)).unwrap();
            assert!(!receipt["reloadTabIds"]
                .as_array()
                .unwrap()
                .contains(&json!(f.placeholder)));
            knowledge::read(root, dir, path)
        },
    );
    assert_eq!(result.unwrap_err(), "Superseded");
    assert!(f.core.workspace.lock().unwrap().tabs[&f.placeholder]
        .session
        .is_none());
}

#[test]
fn cancel_while_confirm_waits_for_gate_is_observed_before_revocation() {
    let f = Fixture::new();
    let before = f.saved();
    let token = f.token(&f.active);
    let (preview, _, backup) = f.import();
    let id = preview["planId"].as_str().unwrap();
    let plan = find_plan(&f.core, &f.context, id).unwrap();
    let gate = f.core.gate.lock().unwrap();
    let core = f.core.clone();
    let confirmation = f.confirmation(&preview);
    // try_lock polling can briefly overlap confirm's nonblocking phase lock.
    // Retry only that test setup contention, until confirm holds the phase
    // while waiting on our gate. No production operation is retried here.
    let worker = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let attempt = Confirmation {
                context: confirmation.context.clone(),
                plan_id: confirmation.plan_id.clone(),
                confirmation: confirmation.confirmation.clone(),
                replace_confirmation: confirmation.replace_confirmation.clone(),
                stop_reload_confirmation: confirmation.stop_reload_confirmation.clone(),
            };
            match confirm(&core, attempt) {
                Err(error) if error.code == "transfer_busy" => {
                    assert!(Instant::now() < deadline);
                    std::thread::yield_now();
                }
                result => break result,
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    while plan.phase.try_lock().is_ok() {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert_eq!(
        cancel(&f.core, &f.context, id).unwrap()["status"],
        "cancel_requested"
    );
    assert_eq!(f.token(&f.active), token);
    drop(gate);
    assert_eq!(
        worker.join().unwrap().unwrap_err().code,
        "operation_cancelled"
    );
    assert_eq!(f.saved(), before);
    assert!(!backup.exists());
}

#[test]
fn malformed_schema_paths_existing_files_and_foreign_context_fail_closed() {
    let f = Fixture::new();
    let before = f.saved();
    let input = f.export();
    assert_eq!(
        select_file(&f.core, f.context.clone(), FileKind::Export, &input)
            .unwrap_err()
            .code,
        "transfer_file_exists"
    );
    for data in [
        b"{\"formatVersion\":999}".as_slice(),
        b"{\"format\":1,\"format\":2}".as_slice(),
    ] {
        let path = f.files.join(format!("bad{}.json", data.len()));
        fs::write(&path, data).unwrap();
        let file = f.select(FileKind::Import, &path);
        assert!(prepare(
            &f.core,
            PrepareRequest {
                context: f.context.clone(),
                relative_path: "target.html".into(),
                file_id: file,
                backup_file_id: None,
                active_tab_ids: vec![]
            }
        )
        .is_err());
    }
    let mut incoming: Value = serde_json::from_slice(&fs::read(&input).unwrap()).unwrap();
    incoming["apps"]["app"]["schemaVersion"] = json!(3);
    fs::write(&input, incoming.to_string()).unwrap();
    let file = f.select(FileKind::Import, &input);
    assert_eq!(
        prepare(
            &f.core,
            PrepareRequest {
                context: f.context.clone(),
                relative_path: "target.html".into(),
                file_id: file.clone(),
                backup_file_id: None,
                active_tab_ids: vec![]
            }
        )
        .unwrap_err()
        .code,
        "schema_conflict"
    );
    assert!(prepare(
        &f.core,
        PrepareRequest {
            context: f.context.clone(),
            relative_path: "../target.html".into(),
            file_id: file.clone(),
            backup_file_id: None,
            active_tab_ids: vec![]
        }
    )
    .is_err());
    let foreign = Context {
        workspace_id: "foreign".into(),
        view_id: f.context.view_id.clone(),
    };
    assert!(select_file(
        &f.core,
        foreign,
        FileKind::Export,
        &f.files.join("out.json")
    )
    .is_err());
    assert_eq!(f.saved(), before);
}

#[test]
fn live_atomic_drop_clears_interrupt_before_rollback_and_ordinary_write() {
    let f = Fixture::new();
    let before = f.saved();
    f.core
        .document_state
        .get()
        .unwrap()
        .transfer_connection(|connection, _| {
            let _budget = SqlBudget::new(connection, None)?;
            let transaction = LiveTransaction::begin(connection)?;
            transaction
                .execute("UPDATE documents SET revision=revision+1", [])
                .map_err(sql_error)?;
            transaction
                .progress_handler(1, Some(|| true))
                .map_err(sql_error)?;
            drop(transaction);
            assert!(connection.is_autocommit());
            assert_eq!(
                connection
                    .query_row("SELECT 1", [], |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(f.saved(), before);
    f.write(
        &f.active,
        json!({"schemaVersion":2,"data":"still writable"}),
    );
    assert_eq!(f.saved().1, before.1 + 1);
}

#[test]
fn disk_full_rolls_back_values_revision_quota_and_preserves_published_backup() {
    let f = Fixture::new();
    let input = f.export();
    let mut incoming: Value = serde_json::from_slice(&fs::read(&input).unwrap()).unwrap();
    incoming["apps"]["app"]["data"] = json!("x".repeat(100000));
    fs::write(&input, incoming.to_string()).unwrap();
    let backup = f.files.join("backup.json");
    let preview = f.prepare(
        "target.html",
        f.select(FileKind::Import, &input),
        Some(f.select(FileKind::Backup, &backup)),
    );
    let before = f.saved();
    f.core
        .document_state
        .get()
        .unwrap()
        .transfer_connection(|c, _| {
            let pages: i64 = c
                .query_row("PRAGMA page_count", [], |r| r.get(0))
                .map_err(sql_error)?;
            c.execute_batch(&format!("PRAGMA max_page_count={pages};"))
                .map_err(sql_error)?;
            Ok(())
        })
        .unwrap();
    assert!(confirm(&f.core, f.confirmation(&preview)).is_err());
    assert_eq!(f.saved(), before);
    assert!(backup.exists());
    assert!(f.core.workspace.lock().unwrap().tabs[&f.active]
        .session
        .is_none());
    let status =
        verify_operation(&f.core, &f.context, preview["planId"].as_str().unwrap()).unwrap();
    assert_eq!(status["grantsRevoked"], true);
    assert_eq!(status["backupPublished"], true);
    f.core
        .document_state
        .get()
        .unwrap()
        .transfer_connection(|c, _| {
            assert!(c.is_autocommit());
            c.execute_batch("PRAGMA max_page_count=1073741823;")
                .map_err(sql_error)
        })
        .unwrap();
    f.core
        .open(&f.context.workspace_id, &f.context.view_id, &f.active, 2)
        .unwrap();
    f.write(&f.active, json!({"schemaVersion":2,"data":"retry"}));
}

#[test]
fn external_sqlite_busy_fails_before_revocation_or_backup() {
    let f = Fixture::new();
    let (preview, _, backup) = f.import();
    let before = f.saved();
    let token = f.token(&f.active);
    let writer =
        Connection::open(f._temp.path().join("profile/document-state/state.sqlite")).unwrap();
    writer.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert_eq!(
        confirm(&f.core, f.confirmation(&preview)).unwrap_err().code,
        "state_busy"
    );
    assert_eq!(f.token(&f.active), token);
    assert!(!backup.exists());
    writer.execute_batch("ROLLBACK").unwrap();
    assert_eq!(f.saved(), before);
    f.write(
        &f.active,
        json!({"schemaVersion":2,"data":"not query_only"}),
    );
}

#[test]
fn verify_after_restart_is_current_value_match_not_operation_proof() {
    let mut f = Fixture::new();
    let (preview, input, _) = f.import();
    let identity = f.id("target.html");
    confirm(&f.core, f.confirmation(&preview)).unwrap();
    let core = Core::new(19972);
    core.document_state
        .set(DocumentState::new(f._temp.path().join("profile/document-state")).unwrap())
        .ok()
        .unwrap();
    let snapshot = core.select(&f.root, false).unwrap();
    f.core = core;
    f.context = Context {
        workspace_id: snapshot.workspace_id.unwrap(),
        view_id: snapshot.view_id,
    };
    let selected = f.select(FileKind::Import, &input);
    let verified = verify_import(&f.core, &f.context, "target.html", &identity, &selected).unwrap();
    assert_eq!(verified["matches"], true);
    assert_eq!(verified["provesPastOperation"], false);
    assert!(verify_operation(&f.core, &f.context, preview["planId"].as_str().unwrap()).is_err());
    assert!(verify_import(
        &f.core,
        &f.context,
        "target.html",
        &"0".repeat(64),
        &selected
    )
    .is_err());
}

#[test]
fn v2_quarantined_target_is_held_without_changing_archive_or_tombstone() {
    let f = Fixture::new();
    let input = f.export();
    let id = f.id("target.html");
    f.core.document_state.get().unwrap().transfer_connection(|c,_| {
        // Synthetic v2 setup uses the same internal schema, never a real profile.
        let transaction=LiveTransaction::begin(c)?;
        transaction.execute_batch(&format!("{};{};PRAGMA user_version=2;",recovery_store::RECORDS_DDL,recovery_store::TOMBSTONES_DDL)).map_err(sql_error)?;
        let old=record(&transaction,&id)?.unwrap();
        transaction.execute("INSERT INTO recovery_records SELECT ?2,id,data,bytes,revision,root,path,generation,?3,1,'quarantined',NULL,NULL FROM documents WHERE id=?1",params![id,"c".repeat(64),recovery_store::payload_hash(&old.data)]).map_err(sql_error)?;
        transaction.execute("INSERT INTO state_tombstones VALUES(?1,?2,?3)",params![id,old.revision,"c".repeat(64)]).map_err(sql_error)?;
        transaction.execute("DELETE FROM documents WHERE id=?1",[&id]).map_err(sql_error)?;
        transaction.execute("UPDATE quota SET bytes=bytes-?1,documents=documents-1",[old.bytes]).map_err(sql_error)?;
        recovery_store::validate(&transaction).map_err(|_|failure("state_corrupt"))?;
        transaction.commit()
    }).unwrap();
    let backup = f.files.join("backup.json");
    let file = f.select(FileKind::Import, &input);
    let backup_file = f.select(FileKind::Backup, &backup);
    assert_eq!(
        prepare(
            &f.core,
            PrepareRequest {
                context: f.context.clone(),
                relative_path: "target.html".into(),
                file_id: file,
                backup_file_id: Some(backup_file),
                active_tab_ids: vec![]
            }
        )
        .unwrap_err()
        .code,
        "target_quarantined_hold"
    );
    assert!(!backup.exists());
    f.core
        .document_state
        .get()
        .unwrap()
        .transfer_connection(|c, _| {
            recovery_store::validate(c).map_err(|_| failure("state_corrupt"))?;
            assert_eq!(
                c.query_row("SELECT count(*) FROM state_tombstones", [], |r| r
                    .get::<_, i64>(0))
                    .unwrap(),
                1
            );
            Ok(())
        })
        .unwrap();
}

#[cfg(unix)]
#[test]
fn rejected_input_alias_fds_outlive_live_transaction_and_keep_writer_fenced() {
    let f = Fixture::new();
    let input = f.files.join("input.json");
    fs::write(&input, b"{}").unwrap();
    let profile = crate::identifier_migration::directory(&f._temp.path().join("profile"), false)
        .unwrap()
        .unwrap();
    let location = files::Location::open(&input, &profile).unwrap();
    let database = f._temp.path().join("profile/document-state/state.sqlite");
    let writer = || {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "state_transfer::tests::fixture_child_probes_transfer_writer",
                "--ignored",
            ])
            .env("MY_KNOWLEDGE_TRANSFER_FIXTURE_DB", &database)
            .stdout(std::process::Stdio::null())
            .fixture_status()
            .unwrap()
            .code()
            .unwrap()
    };
    f.core
        .document_state
        .get()
        .unwrap()
        .transfer_connection(|c, _| {
            let transaction = LiveTransaction::begin(c)?;
            let result = location.read_after_preflight(
                &mut f.core.live_transfer.input_files.lock().unwrap(),
                || {
                    fs::rename(&input, f.files.join("original.json")).unwrap();
                    fs::hard_link(&database, &input).unwrap();
                },
            );
            assert_eq!(result.unwrap_err().code, "unsafe_transfer_file");
            assert_eq!(f.core.live_transfer.input_files.lock().unwrap().len(), 1);
            assert_eq!(writer(), 42);
            transaction.finish()
        })
        .unwrap();
    assert_eq!(writer(), 0);
}

#[tokio::test]
async fn body_pending_old_write_is_rejected_after_import_without_overwriting_new_values() {
    use axum::{
        body::{Body, Bytes},
        http::{Request, StatusCode},
    };
    use http_body::{Body as HttpBody, Frame};
    use std::{
        pin::Pin,
        task::{Context as PollContext, Poll},
    };
    use tower::ServiceExt;
    struct PausedBody {
        started: Arc<AtomicBool>,
        tail: tokio::sync::oneshot::Receiver<Bytes>,
        prefix: Option<Bytes>,
        done: bool,
    }
    impl HttpBody for PausedBody {
        type Data = Bytes;
        type Error = std::convert::Infallible;
        fn poll_frame(
            mut self: Pin<&mut Self>,
            cx: &mut PollContext<'_>,
        ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
            if self.done {
                return Poll::Ready(None);
            }
            if let Some(prefix) = self.prefix.take() {
                self.started.store(true, Ordering::Release);
                return Poll::Ready(Some(Ok(Frame::data(prefix))));
            }
            match std::future::Future::poll(Pin::new(&mut self.tail), cx) {
                Poll::Pending => Poll::Pending,
                Poll::Ready(Ok(tail)) => {
                    self.done = true;
                    Poll::Ready(Some(Ok(Frame::data(tail))))
                }
                Poll::Ready(Err(_)) => Poll::Ready(None),
            }
        }
    }
    let f = Fixture::new();
    let token = f.token(&f.active);
    let (preview, _, _) = f.import();
    let (send, tail) = tokio::sync::oneshot::channel();
    let started = Arc::new(AtomicBool::new(false));
    let body = PausedBody {
        started: started.clone(),
        tail,
        prefix: Some(Bytes::from_static(
            br#"{"version":1,"op":"write","key":"app","value":{"schemaVersion":2,"data":"#,
        )),
        done: false,
    };
    let request = Request::builder()
        .method("POST")
        .uri(format!("/s/{token}/{}", "__my_knowledge_storage_v1__"))
        .header("Host", f.core.origin.strip_prefix("http://").unwrap())
        .header("Content-Type", "application/json")
        .body(Body::new(body))
        .unwrap();
    let core = f.core.clone();
    let worker = tokio::spawn(async move {
        crate::document_server::router(core)
            .oneshot(request)
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(3), async {
        while !started.load(Ordering::Acquire) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(f.core.gate.try_lock().is_ok());
    confirm(&f.core, f.confirmation(&preview)).unwrap();
    let imported = f.saved();
    send.send(Bytes::from_static(br#""old-unacknowledged"}}"#))
        .unwrap();
    let response = tokio::time::timeout(Duration::from_secs(3), worker)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(f.saved(), imported);
}

#[test]
fn expired_and_bounded_plans_never_revoke_views() {
    let f = Fixture::new();
    let input = f.export();
    let backup = f.files.join("backup.json");
    let file = f.select(FileKind::Import, &input);
    let backup = f.select(FileKind::Backup, &backup);
    let prepare_again = || {
        prepare(
            &f.core,
            PrepareRequest {
                context: f.context.clone(),
                relative_path: "target.html".into(),
                file_id: file.clone(),
                backup_file_id: Some(backup.clone()),
                active_tab_ids: vec![],
            },
        )
    };
    let first = prepare_again().unwrap();
    for _ in 1..MAX_PENDING {
        prepare_again().unwrap();
    }
    assert_eq!(prepare_again().unwrap_err().code, "plan_limit");
    let token = f.token(&f.active);
    {
        let mut plans = f.core.live_transfer.plans.lock().unwrap();
        let p = Arc::get_mut(plans.get_mut(first["planId"].as_str().unwrap()).unwrap()).unwrap();
        p.expires = Instant::now() - Duration::from_secs(1);
    }
    assert_eq!(
        confirm(&f.core, f.confirmation(&first)).unwrap_err().code,
        "expired_plan"
    );
    assert_eq!(f.token(&f.active), token);
    prepare_again().unwrap();
}

#[test]
fn transfer_ipc_is_local_main_only_and_request_never_accepts_portable_paths() {
    let capability: Value =
        serde_json::from_str(include_str!("../../capabilities/main.json")).unwrap();
    assert_eq!(capability["local"], true);
    assert_eq!(capability["webviews"], json!(["main"]));
    assert!(capability.get("remote").is_none());
    let build = include_str!("../../build.rs");
    let handler = include_str!("../lib.rs");
    let storage = include_str!("../document_server/storage.rs");
    for command in [
        "choose_state_transfer_file",
        "prepare_state_transfer",
        "confirm_state_transfer",
        "cancel_state_transfer",
        "verify_state_transfer",
    ] {
        let permission = format!("allow-{}", command.replace('_', "-"));
        assert!(capability["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!(permission)));
        assert!(build.contains(&format!("\"{command}\"")));
        assert!(handler.contains(&format!("commands::transfer::{command}")));
        assert!(!storage.contains(command));
    }
    let mut request = json!({"context":{"workspaceId":"w","viewId":"v"},"relativePath":"target.html","fileId":"chosen","backupFileId":null,"activeTabIds":[]});
    assert!(serde_json::from_value::<PrepareRequest>(request.clone()).is_ok());
    request["filePath"] = json!("arbitrary.json");
    assert!(serde_json::from_value::<PrepareRequest>(request).is_err());
}

#[test]
fn same_path_replacement_revokes_old_view_without_auto_reloading_another_identity() {
    let f = Fixture::new();
    let input = f.export();
    let old_identity = f.id("target.html");
    // No watcher event ordering in this synthetic identity-only scenario.
    drop(f.core.watcher.lock().unwrap().take());
    fs::rename(f.root.join("target.html"), f.root.join("previous.html")).unwrap();
    fs::write(f.root.join("target.html"), b"new synthetic identity").unwrap();
    assert_ne!(f.id("target.html"), old_identity);
    let preview = f.prepare("target.html", f.select(FileKind::Import, &input), None);
    assert_eq!(preview["replacesExisting"], false);
    assert!(preview["affectedViews"]
        .as_array()
        .unwrap()
        .iter()
        .all(|v| v["matchesTargetIdentity"] == false));
    let receipt = confirm(&f.core, f.confirmation(&preview)).unwrap();
    assert_eq!(receipt["reloadTabIds"], json!([]));
    assert!(f.core.workspace.lock().unwrap().tabs[&f.active]
        .session
        .is_none());
    f.core
        .document_state
        .get()
        .unwrap()
        .transfer_connection(|c, _| {
            assert_eq!(record(c, &old_identity)?.unwrap().revision, 1);
            assert_eq!(
                record(c, receipt["documentIdentity"].as_str().unwrap())?
                    .unwrap()
                    .revision,
                1
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn migrated_profile_root_and_search_cache_are_not_portable_file_destinations() {
    let f = Fixture::new_with_layout(true);
    let before = f.saved();
    let profile = f._temp.path().join("profile");
    fs::create_dir(profile.join("search-index")).unwrap();
    for path in [
        profile.join("export.json"),
        profile.join("search-index/backup.json"),
        profile.join("identifier-migration-v1/export.json"),
    ] {
        for kind in [FileKind::Export, FileKind::Backup] {
            assert_eq!(
                select_file(&f.core, f.context.clone(), kind, &path)
                    .unwrap_err()
                    .code,
                "profile_file_forbidden"
            );
            assert!(!path.exists());
        }
    }
    let input = f.export();
    assert!(input.exists());
    assert_eq!(f.saved(), before);
    assert!(include_str!("../startup_profile.rs")
        .contains("DocumentState::new_in_profile(paths.document_state, local_profile)"));
}
