use super::*;
use crate::document_state::{
    self, DocumentState, Operation as StateOperation, StateError, StateRequest,
};
use std::{fs, path::PathBuf};

struct Fixture {
    core: Arc<Core>,
    temp: tempfile::TempDir,
    root: PathBuf,
    profile: PathBuf,
    context: Context,
    identity: String,
    token: String,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("日本語 空白 root");
        let profile = temp.path().join("profile");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("入力.html"), "<input value='original'>").unwrap();
        let core = Core::new(19471);
        core.document_state
            .set(DocumentState::new(profile.join("document-state")).unwrap())
            .ok()
            .unwrap();
        let snapshot = core.select(&root, false).unwrap();
        core.watcher.lock().unwrap().take();
        let context = Context {
            view_id: snapshot.view_id,
            workspace_id: snapshot.workspace_id,
        };
        let tab = core
            .create_tab(
                context.workspace_id.as_ref().unwrap(),
                &context.view_id,
                "入力.html",
            )
            .unwrap();
        core.open(
            context.workspace_id.as_ref().unwrap(),
            &context.view_id,
            &tab,
            1,
        )
        .unwrap();
        let (identity, token) = {
            let state = core.workspace.lock().unwrap();
            let s = state.tabs[&tab].session.as_ref().unwrap();
            (s.storage_identity.clone().unwrap(), s.token.clone())
        };
        document_state::operate(
            &core,
            &token,
            StateRequest {
                version: 1,
                op: StateOperation::Write,
                key: "fixture".into(),
                value: Some(
                    json!({"schemaVersion":1,"data":{"secret":"SYNTHETIC_VALUE_NEVER_RETURN"}}),
                ),
            },
        )
        .unwrap();
        core.close_tab(
            context.workspace_id.as_ref().unwrap(),
            &context.view_id,
            &tab,
        )
        .unwrap();
        Self {
            core,
            temp,
            root,
            profile,
            context,
            identity,
            token,
        }
    }
    fn inspect(&self, recovery: bool) -> Value {
        inspect(
            &self.core,
            PageRequest {
                query: None,
                context: self.context.clone(),
                offset: 0,
                limit: 20,
                snapshot_id: None,
            },
            recovery,
        )
        .unwrap()
    }
    fn prepare(&self, operation: Operation, candidate: Option<&str>) -> String {
        let snapshot = self.inspect(false);
        prepare(
            &self.core,
            PrepareRequest {
                candidate_ids: None,
                context: self.context.clone(),
                operation,
                candidate_id: candidate.map(str::to_owned),
                snapshot_id: snapshot["snapshotId"].as_str().unwrap().into(),
            },
        )
        .unwrap()["planId"]
            .as_str()
            .unwrap()
            .into()
    }
    fn confirm(&self, id: &str) -> Value {
        confirm(
            &self.core,
            Confirmation {
                context: self.context.clone(),
                plan_id: id.into(),
                confirmation: id.into(),
            },
        )
        .unwrap()
    }
    fn upgrade(&self) {
        let id = self.prepare(Operation::Upgrade, None);
        self.confirm(&id);
    }
    fn open(&self, browser: bool) -> (String, String) {
        let workspace = self.context.workspace_id.as_ref().unwrap();
        let (id, request) = if browser {
            self.core
                .browser_tab(workspace, &self.context.view_id, "入力.html")
                .unwrap()
        } else {
            (
                self.core
                    .create_tab(workspace, &self.context.view_id, "入力.html")
                    .unwrap(),
                1,
            )
        };
        self.core
            .open(workspace, &self.context.view_id, &id, request)
            .unwrap();
        let token = self.core.workspace.lock().unwrap().tabs[&id]
            .session
            .as_ref()
            .unwrap()
            .token
            .clone();
        (id, token)
    }
    fn sql<T>(&self, f: impl FnOnce(&Connection) -> T) -> T {
        self.core
            .document_state
            .get()
            .unwrap()
            .management_connection(|c, _, _, _| Ok(f(c)))
            .unwrap()
    }
    fn add_document(&self, path: &str) -> String {
        if let Some(parent) = self.root.join(path).parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(self.root.join(path), "<input value='synthetic'>").unwrap();
        let (identity, root_identity) = {
            let state = self.core.workspace.lock().unwrap();
            let dir = state.dir.as_ref().unwrap();
            (
                // Windows verifies the final handle path against the selected
                // canonical root, including its extended-length prefix.
                crate::knowledge::storage_identity(state.root.as_ref().unwrap(), dir, path)
                    .unwrap(),
                crate::knowledge::storage_root_identity(dir).unwrap(),
            )
        };
        self.sql(|c| {
            c.execute(
                "INSERT INTO documents SELECT ?1,data,bytes,1,?2,?3,(SELECT generation+1 FROM quota) FROM documents WHERE id=?4",
                rusqlite::params![identity,root_identity,path,self.identity],
            ).unwrap();
            c.execute("UPDATE quota SET bytes=(SELECT sum(bytes) FROM documents),documents=documents+1,generation=generation+1", []).unwrap();
        });
        identity
    }
    fn prepare_bulk(&self, ids: Vec<String>) -> Result<Value, InspectionError> {
        prepare(
            &self.core,
            PrepareRequest {
                context: self.context.clone(),
                operation: Operation::Quarantine,
                candidate_id: None,
                candidate_ids: Some(ids),
                snapshot_id: self.inspect(false)["snapshotId"].as_str().unwrap().into(),
            },
        )
    }
}

#[test]
fn search_filters_the_whole_metadata_set_before_paging_and_treats_wildcards_literally() {
    let f = Fixture::new();
    for index in 0..26 {
        f.add_document(&format!("folder/item-{index:02}.html"));
    }
    let special = f.add_document("nested/Needle%_日本.html");
    let page = |offset, query: &str| {
        inspect(
            &f.core,
            PageRequest {
                context: f.context.clone(),
                offset,
                limit: 20,
                snapshot_id: None,
                query: Some(query.into()),
            },
            false,
        )
        .unwrap()
    };
    let all = page(0, "");
    assert_eq!(all["usage"]["records"], 28);
    assert_eq!(all["entries"].as_array().unwrap().len(), 20);
    assert_eq!(page(20, "")["entries"].as_array().unwrap().len(), 8);
    let beyond = f.sql(|c| {
        c.query_row(
            "SELECT id,path FROM documents ORDER BY id LIMIT 1 OFFSET 20",
            [],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .unwrap()
    });
    assert!(!all["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["documentIdentity"] == beyond.0));
    assert_eq!(
        page(0, &beyond.1)["entries"][0]["documentIdentity"],
        beyond.0
    );
    let needle = page(0, "needle%_");
    assert_eq!(needle["matchedRecords"], 1);
    assert_eq!(needle["entries"][0]["documentIdentity"], special);
    assert_eq!(needle["hasMore"], false);
    assert_eq!(needle["usage"], all["usage"]);
    assert_eq!(needle["snapshotId"], all["snapshotId"]);
    assert_eq!(page(0, "日本")["matchedRecords"], 1);
    assert_eq!(page(0, "nested/")["matchedRecords"], 1);
    assert!(!needle.to_string().contains("SYNTHETIC_VALUE_NEVER_RETURN"));
    assert_eq!(
        inspect(
            &f.core,
            PageRequest {
                context: f.context.clone(),
                offset: 0,
                limit: 20,
                snapshot_id: None,
                query: Some("x".repeat(1025))
            },
            false
        )
        .unwrap_err()
        .code,
        "invalid_arguments"
    );
}

#[test]
fn bulk_rejects_duplicate_mixed_oversized_and_non_quarantine_selection() {
    let f = Fixture::new();
    f.upgrade();
    assert_eq!(
        f.prepare_bulk(vec![f.identity.clone(), f.identity.clone()])
            .unwrap_err()
            .code,
        "invalid_arguments"
    );
    assert_eq!(
        f.prepare_bulk(vec![]).unwrap_err().code,
        "invalid_arguments"
    );
    assert_eq!(
        f.prepare_bulk((0..21).map(|_| crate::core::random_token()).collect())
            .unwrap_err()
            .code,
        "invalid_arguments"
    );
    for operation in [
        Operation::Quarantine,
        Operation::Restore,
        Operation::Upgrade,
    ] {
        assert_eq!(
            prepare(
                &f.core,
                PrepareRequest {
                    context: f.context.clone(),
                    operation,
                    candidate_id: Some(f.identity.clone()),
                    candidate_ids: Some(vec![f.identity.clone()]),
                    snapshot_id: f.inspect(false)["snapshotId"].as_str().unwrap().into()
                }
            )
            .unwrap_err()
            .code,
            "invalid_arguments"
        );
    }
    assert_eq!(
        prepare(
            &f.core,
            PrepareRequest {
                context: f.context.clone(),
                operation: Operation::Restore,
                candidate_id: None,
                candidate_ids: Some(vec![f.identity.clone()]),
                snapshot_id: f.inspect(false)["snapshotId"].as_str().unwrap().into()
            }
        )
        .unwrap_err()
        .code,
        "invalid_arguments"
    );
    assert_eq!(f.inspect(false)["usage"]["records"], 1);
}

#[test]
fn bulk_quarantine_is_atomic_idempotent_preserves_html_and_revokes_writes() {
    let f = Fixture::new();
    let second = f.add_document("folder/second.html");
    f.upgrade();
    let before_first = fs::read(f.root.join("入力.html")).unwrap();
    let before_second = fs::read(f.root.join("folder/second.html")).unwrap();
    let preview = f
        .prepare_bulk(vec![f.identity.clone(), second.clone()])
        .unwrap();
    assert_eq!(preview["documentCount"], 2);
    assert_eq!(preview["documentIdentity"], Value::Null);
    assert_eq!(preview["appCount"], 2);
    assert_eq!(
        preview["logicalBytes"],
        f.inspect(false)["usage"]["logicalBytes"]
    );
    assert!(!preview.to_string().contains("SYNTHETIC_VALUE_NEVER_RETURN"));
    let id = preview["planId"].as_str().unwrap();
    let receipt = f.confirm(id);
    assert_eq!(receipt["documentCount"], 2);
    assert_eq!(f.confirm(id), receipt);
    assert_ne!(
        receipt["entries"][0]["recoveryId"],
        receipt["entries"][1]["recoveryId"]
    );
    assert_eq!(f.inspect(false)["usage"]["records"], 0);
    assert_eq!(f.inspect(true)["entries"].as_array().unwrap().len(), 2);
    assert_eq!(fs::read(f.root.join("入力.html")).unwrap(), before_first);
    assert_eq!(
        fs::read(f.root.join("folder/second.html")).unwrap(),
        before_second
    );
    assert_eq!(
        document_state::operate(
            &f.core,
            &f.token,
            StateRequest {
                version: 1,
                op: StateOperation::Write,
                key: "fixture".into(),
                value: Some(json!({}))
            }
        )
        .err()
        .unwrap(),
        StateError::Revoked
    );
    *find(&f.core, &f.context, id).unwrap().phase.lock().unwrap() =
        Phase::Failed("state_unavailable");
    assert_eq!(
        verify(&f.core, &f.context, id).unwrap()["receipt"]["documentCount"],
        2
    );
    let one_recovery = receipt["entries"][0]["recoveryId"].as_str().unwrap();
    f.sql(|c| {
        c.execute(
            "DELETE FROM state_tombstones WHERE operation_id=?1",
            [one_recovery],
        )
        .unwrap();
        c.execute(
            "DELETE FROM recovery_records WHERE operation_id=?1",
            [one_recovery],
        )
        .unwrap();
    });
    assert_eq!(
        verify(&f.core, &f.context, id).unwrap()["status"],
        "unknown"
    );
    f.core.live_management.plans.lock().unwrap().remove(id);
    assert_eq!(
        verify(&f.core, &f.context, id).unwrap()["status"],
        "unknown"
    );
}

#[test]
fn bulk_stale_payload_or_open_document_preserves_every_record() {
    for opened in [false, true] {
        let f = Fixture::new();
        let second = f.add_document("second.html");
        f.upgrade();
        let preview = f
            .prepare_bulk(vec![second.clone(), f.identity.clone()])
            .unwrap();
        if opened {
            f.open(true);
        } else {
            // Keep byte length and snapshot metadata unchanged to exercise the
            // per-record payload hash, including a later selection in the plan.
            f.sql(|c| {c.execute("UPDATE documents SET data=replace(data,'SYNTHETIC_VALUE_NEVER_RETURN','SYNTHETIC_VALUE_ALTER_RETURN') WHERE id=?1",[&f.identity]).unwrap();});
        }
        let id = preview["planId"].as_str().unwrap();
        assert_eq!(
            confirm(
                &f.core,
                Confirmation {
                    context: f.context.clone(),
                    plan_id: id.into(),
                    confirmation: id.into()
                }
            )
            .unwrap_err()
            .code,
            if opened {
                "in_use_hold"
            } else {
                "state_changed"
            }
        );
        assert_eq!(f.inspect(false)["usage"]["records"], 2);
        assert_eq!(f.inspect(true)["entries"].as_array().unwrap().len(), 0);
    }
}

#[test]
fn bulk_late_recovery_capacity_failure_rolls_back_earlier_selection() {
    let f = Fixture::new();
    let second = f.add_document("second.html");
    f.upgrade();
    let preview = f.prepare_bulk(vec![f.identity.clone(), second]).unwrap();
    // Inject an archive-capacity change after the first INSERT inside the
    // transaction, without allocating a 512 MiB fixture payload. The next
    // apply_record must reject capacity and roll back both the trigger and row.
    f.sql(|c|c.execute_batch("CREATE TEMP TRIGGER fill_archive AFTER INSERT ON recovery_records WHEN (SELECT count(*) FROM recovery_records)=1 BEGIN INSERT INTO recovery_records SELECT printf('%064x',123),printf('%064x',456),'{}',536870912,1,root,'synthetic-capacity.html',generation,printf('%064x',789),created_unix_ms,'quarantined',NULL,NULL FROM recovery_records LIMIT 1; END;").unwrap());
    let before = f.inspect(false)["usage"].clone();
    let id = preview["planId"].as_str().unwrap();
    assert_eq!(
        confirm(
            &f.core,
            Confirmation {
                context: f.context.clone(),
                plan_id: id.into(),
                confirmation: id.into()
            }
        )
        .unwrap_err()
        .code,
        "recovery_capacity_reached"
    );
    f.sql(|c| c.execute_batch("DROP TRIGGER fill_archive;").unwrap());
    assert_eq!(f.inspect(false)["usage"], before);
    assert_eq!(f.inspect(true)["entries"].as_array().unwrap().len(), 0);
    assert_eq!(
        f.sql(|c| c
            .query_row("SELECT count(*) FROM state_tombstones", [], |r| r
                .get::<_, i64>(0))
            .unwrap()),
        0
    );
}

#[test]
fn metadata_is_bounded_private_unknown_last_view_and_requires_explicit_upgrade() {
    let f = Fixture::new();
    let report = f.inspect(false);
    assert_eq!(report["databaseSchemaVersion"], 1);
    assert_eq!(report["entries"][0]["lastViewedAt"], Value::Null);
    assert_eq!(
        report["entries"][0]["holdReason"],
        "explicit_upgrade_required"
    );
    assert!(!serde_json::to_string(&report)
        .unwrap()
        .contains("SYNTHETIC_VALUE_NEVER_RETURN"));
    assert_eq!(report["entries"][0]["relativePath"], "入力.html");
    for (offset, limit) in [(0, 0), (0, 21), (4097, 20)] {
        assert_eq!(
            inspect(
                &f.core,
                PageRequest {
                    query: None,
                    context: f.context.clone(),
                    offset,
                    limit,
                    snapshot_id: None
                },
                false
            )
            .unwrap_err()
            .code,
            "invalid_arguments"
        );
    }
    let id = f.prepare(Operation::Upgrade, None);
    assert_eq!(
        confirm(
            &f.core,
            Confirmation {
                context: f.context.clone(),
                plan_id: id.clone(),
                confirmation: "wrong".into()
            }
        )
        .unwrap_err()
        .code,
        "explicit_confirmation_required"
    );
    f.confirm(&id);
    assert_eq!(f.inspect(false)["databaseSchemaVersion"], 2);
    assert_eq!(f.inspect(false)["entries"][0]["eligible"], true);
}
#[test]
fn quarantine_restore_restart_retains_html_and_blocks_old_and_new_tokens() {
    let f = Fixture::new();
    f.upgrade();
    let html = fs::read(f.root.join("入力.html")).unwrap();
    let id = f.prepare(Operation::Quarantine, Some(&f.identity));
    let receipt = f.confirm(&id);
    assert_eq!(f.confirm(&id), receipt);
    assert_eq!(f.inspect(false)["usage"]["records"], 0);
    assert_eq!(f.inspect(true)["entries"][0]["restorable"], true);
    assert_eq!(fs::read(f.root.join("入力.html")).unwrap(), html);
    assert_eq!(
        document_state::operate(
            &f.core,
            &f.token,
            StateRequest {
                version: 1,
                op: StateOperation::Write,
                key: "fixture".into(),
                value: Some(json!({}))
            }
        )
        .err()
        .unwrap(),
        StateError::Revoked
    );
    let (tab, token) = f.open(false);
    assert_eq!(
        document_state::operate(
            &f.core,
            &token,
            StateRequest {
                version: 1,
                op: StateOperation::Read,
                key: "fixture".into(),
                value: None
            }
        )
        .err()
        .unwrap(),
        StateError::Revoked
    );
    assert_eq!(f.inspect(true)["entries"][0]["restorable"], false);
    f.core
        .close_tab(
            f.context.workspace_id.as_ref().unwrap(),
            &f.context.view_id,
            &tab,
        )
        .unwrap();
    let restore = f.prepare(Operation::Restore, Some(&id));
    f.confirm(&restore);
    assert_eq!(f.inspect(false)["usage"]["records"], 1);
    assert_eq!(f.inspect(true)["entries"][0]["status"], "restored");
    assert_eq!(
        verify(&f.core, &f.context, &id).unwrap()["status"],
        "completed"
    );
    let new = Core::new(19472);
    new.document_state
        .set(DocumentState::new(f.profile.join("document-state")).unwrap())
        .ok()
        .unwrap();
    let snapshot = new.select(&f.root, false).unwrap();
    new.watcher.lock().unwrap().take();
    let context = Context {
        workspace_id: snapshot.workspace_id,
        view_id: snapshot.view_id,
    };
    assert_eq!(
        verify(&new, &context, &restore).unwrap()["status"],
        "completed"
    );
    let tab = new
        .create_tab(
            context.workspace_id.as_ref().unwrap(),
            &context.view_id,
            "入力.html",
        )
        .unwrap();
    new.open(
        context.workspace_id.as_ref().unwrap(),
        &context.view_id,
        &tab,
        1,
    )
    .unwrap();
    let token = new.workspace.lock().unwrap().tabs[&tab]
        .session
        .as_ref()
        .unwrap()
        .token
        .clone();
    assert_eq!(
        document_state::operate(
            &new,
            &token,
            StateRequest {
                version: 1,
                op: StateOperation::Read,
                key: "fixture".into(),
                value: None
            }
        )
        .unwrap()
        .value["data"]["secret"],
        "SYNTHETIC_VALUE_NEVER_RETURN"
    );
}
#[test]
fn visible_hidden_browser_and_sessionless_pending_open_hold_at_inspect_and_confirm() {
    for kind in 0..4 {
        let f = Fixture::new();
        f.upgrade();
        let id = f.prepare(Operation::Quarantine, Some(&f.identity));
        let tab = if kind == 3 {
            f.core
                .create_tab(
                    f.context.workspace_id.as_ref().unwrap(),
                    &f.context.view_id,
                    "入力.html",
                )
                .unwrap()
        } else {
            f.open(kind == 2).0
        };
        if kind == 3 {
            f.core
                .workspace
                .lock()
                .unwrap()
                .tabs
                .get_mut(&tab)
                .unwrap()
                .latest_request = 1;
        }
        assert_eq!(f.inspect(false)["entries"][0]["holdReason"], "in_use_hold");
        assert_eq!(
            confirm(
                &f.core,
                Confirmation {
                    context: f.context.clone(),
                    plan_id: id.clone(),
                    confirmation: id
                }
            )
            .unwrap_err()
            .code,
            "in_use_hold"
        );
        assert_eq!(f.inspect(false)["usage"]["records"], 1);
    }
}
#[test]
fn root_unselected_renamed_replaced_and_incomplete_scan_are_held() {
    for kind in 0..4 {
        let f = Fixture::new();
        f.upgrade();
        #[cfg(windows)]
        if matches!(kind, 1 | 2) {
            // Windows pins the selected root. Model loss of its capability only
            // after proving the active handle prevents external replacement.
            assert!(fs::rename(&f.root, f.temp.path().join("pinned")).is_err());
            f.core.workspace.lock().unwrap().dir = None;
        }
        match kind {
            0 => {
                let mut state = f.core.workspace.lock().unwrap();
                state.root = None;
                state.dir = None;
            }
            1 => fs::rename(&f.root, f.temp.path().join("renamed")).unwrap(),
            2 => {
                fs::rename(&f.root, f.temp.path().join("original")).unwrap();
                fs::create_dir(&f.root).unwrap();
                fs::write(f.root.join("入力.html"), "<p>replacement</p>").unwrap();
            }
            _ => {
                f.core.workspace.lock().unwrap().snapshot.watch_error =
                    Some("incomplete scan".into());
            }
        }
        assert_eq!(f.inspect(false)["entries"][0]["eligible"], false);
        assert_eq!(
            f.inspect(false)["entries"][0]["holdReason"],
            "source_unavailable_hold"
        );
    }
}
#[test]
fn file_rename_and_single_scan_absence_preserve_recovery_history() {
    for moved in [true, false] {
        let f = Fixture::new();
        f.upgrade();
        if moved {
            fs::rename(f.root.join("入力.html"), f.root.join("moved.html")).unwrap();
        } else {
            fs::remove_file(f.root.join("入力.html")).unwrap();
        }
        assert_eq!(f.inspect(false)["entries"][0]["eligible"], false);
        assert_eq!(f.inspect(false)["usage"]["records"], 1);
    }
}
#[test]
fn snapshot_payload_revision_context_and_expiry_changes_reject_without_archive() {
    for kind in 0..4 {
        let f = Fixture::new();
        f.upgrade();
        let id = f.prepare(Operation::Quarantine, Some(&f.identity));
        match kind {
            0 => {
                f.sql(|c| {
                    c.execute("UPDATE documents SET revision=revision+1", [])
                        .unwrap();
                });
            }
            1 => {
                f.sql(|c|{c.execute("UPDATE documents SET data=replace(data,'SYNTHETIC_VALUE_NEVER_RETURN','SYNTHETIC_VALUE_ALTER_RETURN')",[]).unwrap();});
            }
            2 => {
                f.core.begin_view();
            }
            _ => {
                let mut plans = f.core.live_management.plans.lock().unwrap();
                let plan = Arc::get_mut(plans.get_mut(&id).unwrap()).unwrap();
                plan.issued = Instant::now() - LIFETIME;
            }
        }
        assert!(confirm(
            &f.core,
            Confirmation {
                context: f.context.clone(),
                plan_id: id.clone(),
                confirmation: id
            }
        )
        .is_err());
        assert_eq!(
            f.sql(|c| c
                .query_row("SELECT count(*) FROM documents", [], |r| r.get::<_, i64>(0))
                .unwrap()),
            1
        );
        assert_eq!(
            f.sql(|c| c
                .query_row("SELECT count(*) FROM recovery_records", [], |r| r
                    .get::<_, i64>(0))
                .unwrap()),
            0
        );
    }
}
#[test]
fn cancellation_and_write_failure_keep_values_and_restore_live_connection_budget() {
    let f = Fixture::new();
    f.upgrade();
    let id = f.prepare(Operation::Quarantine, Some(&f.identity));
    assert_eq!(
        cancel(&f.core, &f.context, &id).unwrap()["status"],
        "cancelled"
    );
    assert_eq!(
        verify(&f.core, &f.context, &id).unwrap()["status"],
        "cancelled"
    );
    let id = f.prepare(Operation::Quarantine, Some(&f.identity));
    f.sql(|c|c.execute_batch("CREATE TEMP TRIGGER fail_archive BEFORE INSERT ON recovery_records BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;").unwrap());
    assert!(confirm(
        &f.core,
        Confirmation {
            context: f.context.clone(),
            plan_id: id.clone(),
            confirmation: id
        }
    )
    .is_err());
    f.sql(|c| c.execute_batch("DROP TRIGGER fail_archive;").unwrap());
    assert_eq!(f.inspect(false)["usage"]["records"], 1);
    assert_eq!(f.inspect(true)["entries"].as_array().unwrap().len(), 0);
    let (tab, token) = f.open(false);
    assert!(document_state::operate(
        &f.core,
        &token,
        StateRequest {
            version: 1,
            op: StateOperation::Write,
            key: "fixture".into(),
            value: Some(json!({"schemaVersion":1,"data":"still writable"}))
        }
    )
    .is_ok());
    f.core
        .close_tab(
            f.context.workspace_id.as_ref().unwrap(),
            &f.context.view_id,
            &tab,
        )
        .unwrap();
}
#[test]
fn restore_never_overwrites_existing_values_and_unknown_operations_stay_unknown() {
    let f = Fixture::new();
    f.upgrade();
    let id = f.prepare(Operation::Quarantine, Some(&f.identity));
    f.confirm(&id);
    f.sql(|c|c.execute_batch("BEGIN IMMEDIATE; INSERT INTO documents SELECT document_id,data,bytes,revision+1,root,path,generation+1 FROM recovery_records; UPDATE quota SET bytes=(SELECT sum(bytes) FROM documents),documents=1,generation=generation+1; UPDATE recovery_records SET status='restored',restored_revision=revision+1,restore_operation_id=printf('%064x',99); UPDATE state_tombstones SET revision=revision+1; COMMIT;").unwrap());
    assert_eq!(f.inspect(true)["entries"][0]["restorable"], false);
    assert!(prepare(
        &f.core,
        PrepareRequest {
            candidate_ids: None,
            context: f.context.clone(),
            operation: Operation::Restore,
            candidate_id: Some(id),
            snapshot_id: f.inspect(false)["snapshotId"].as_str().unwrap().into()
        }
    )
    .is_err());
    assert_eq!(
        verify(&f.core, &f.context, &crate::core::random_token()).unwrap()["status"],
        "unknown"
    );
}
#[cfg(unix)]
#[test]
fn database_path_replacement_is_detected_without_following_replacement() {
    let f = Fixture::new();
    f.upgrade();
    let database = f.profile.join("document-state/state.sqlite");
    fs::rename(&database, f.profile.join("original.sqlite")).unwrap();
    fs::write(&database, b"synthetic replacement").unwrap();
    assert_eq!(
        inspect(
            &f.core,
            PageRequest {
                query: None,
                context: f.context.clone(),
                offset: 0,
                limit: 20,
                snapshot_id: None
            },
            false
        )
        .unwrap_err()
        .code,
        "state_changed"
    );
    assert_eq!(fs::read(database).unwrap(), b"synthetic replacement");
}

#[test]
fn pending_read_cannot_issue_a_grant_after_close_and_quarantine() {
    let f = Fixture::new();
    f.upgrade();
    let workspace = f.context.workspace_id.as_ref().unwrap();
    let tab = f
        .core
        .create_tab(workspace, &f.context.view_id, "入力.html")
        .unwrap();
    let result = f
        .core
        .open_with(workspace, &f.context.view_id, &tab, 1, |root, dir, path| {
            let bytes = knowledge::read(root, dir, path)?;
            assert_eq!(f.inspect(false)["entries"][0]["holdReason"], "in_use_hold");
            f.core
                .close_tab(workspace, &f.context.view_id, &tab)
                .unwrap();
            let id = f.prepare(Operation::Quarantine, Some(&f.identity));
            f.confirm(&id);
            Ok(bytes)
        });
    assert_eq!(result.err().unwrap(), "TabClosed");
    assert!(f.core.workspace.lock().unwrap().tabs.is_empty());
    assert_eq!(f.inspect(false)["usage"]["records"], 0);
}

#[test]
fn bounded_plans_paged_snapshots_cancel_requested_and_lost_response_are_explicit() {
    let f = Fixture::new();
    let upgrade = f.prepare(Operation::Upgrade, None);
    f.confirm(&upgrade);
    *find(&f.core, &f.context, &upgrade)
        .unwrap()
        .phase
        .lock()
        .unwrap() = Phase::Failed("state_changed");
    assert_eq!(
        verify(&f.core, &f.context, &upgrade).unwrap()["status"],
        "unknown"
    );
    assert_eq!(
        verify(&f.core, &f.context, &upgrade).unwrap()["currentSchemaVersion"],
        2
    );
    let f = Fixture::new();
    f.upgrade();
    let first = f.prepare(Operation::Quarantine, Some(&f.identity));
    for _ in 1..MAX_PENDING {
        f.prepare(Operation::Quarantine, Some(&f.identity));
    }
    assert_eq!(
        prepare(
            &f.core,
            PrepareRequest {
                candidate_ids: None,
                context: f.context.clone(),
                operation: Operation::Quarantine,
                candidate_id: Some(f.identity.clone()),
                snapshot_id: f.inspect(false)["snapshotId"].as_str().unwrap().into()
            }
        )
        .unwrap_err()
        .code,
        "plan_limit"
    );
    let plan = find(&f.core, &f.context, &first).unwrap();
    let phase = plan.phase.lock().unwrap();
    assert_eq!(
        prepare(
            &f.core,
            PrepareRequest {
                candidate_ids: None,
                context: f.context.clone(),
                operation: Operation::Quarantine,
                candidate_id: Some(f.identity.clone()),
                snapshot_id: f.inspect(false)["snapshotId"].as_str().unwrap().into()
            }
        )
        .unwrap_err()
        .code,
        "plan_limit"
    );
    assert_eq!(
        cancel(&f.core, &f.context, &first).unwrap()["status"],
        "cancel_requested"
    );
    drop(phase);
    assert_eq!(
        confirm(
            &f.core,
            Confirmation {
                context: f.context.clone(),
                plan_id: first.clone(),
                confirmation: first
            }
        )
        .unwrap_err()
        .code,
        "cancelled"
    );
    let f = Fixture::new();
    f.upgrade();
    let snapshot = f.inspect(false)["snapshotId"].as_str().unwrap().to_owned();
    let id = f.prepare(Operation::Quarantine, Some(&f.identity));
    f.confirm(&id);
    assert!(inspect(
        &f.core,
        PageRequest {
            query: None,
            context: f.context.clone(),
            offset: 0,
            limit: 20,
            snapshot_id: Some(snapshot)
        },
        false
    )
    .is_err());
    // Discard the IPC receipt / model a failed response after the atomic commit.
    *find(&f.core, &f.context, &id)
        .unwrap()
        .phase
        .lock()
        .unwrap() = Phase::Failed("state_changed");
    assert_eq!(
        verify(&f.core, &f.context, &id).unwrap()["status"],
        "completed"
    );
    f.core.live_management.plans.lock().unwrap().clear();
    assert_eq!(
        verify(&f.core, &f.context, &id).unwrap()["receipt"]["operationId"],
        id
    );
}

#[tokio::test]
async fn body_pending_save_cannot_revive_a_closed_and_quarantined_record() {
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
                Poll::Ready(Err(_)) => {
                    self.done = true;
                    Poll::Ready(None)
                }
            }
        }
    }
    let f = Fixture::new();
    f.upgrade();
    let (tab, token) = f.open(false);
    let (send, tail) = tokio::sync::oneshot::channel();
    let started = Arc::new(AtomicBool::new(false));
    let body = PausedBody {
        started: started.clone(),
        tail,
        prefix: Some(Bytes::from_static(
            br#"{"version":1,"op":"write","key":"fixture","value":{"schemaVersion":1,"data":"#,
        )),
        done: false,
    };
    let request = Request::builder()
        .method("POST")
        .uri(format!("/s/{token}/__my_knowledge_storage_v1__"))
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
    assert_eq!(f.inspect(false)["entries"][0]["holdReason"], "in_use_hold");
    f.core
        .close_tab(
            f.context.workspace_id.as_ref().unwrap(),
            &f.context.view_id,
            &tab,
        )
        .unwrap();
    let id = f.prepare(Operation::Quarantine, Some(&f.identity));
    f.confirm(&id);
    send.send(Bytes::from_static(br#""late write"}}"#)).unwrap();
    let response = tokio::time::timeout(Duration::from_secs(3), worker)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(f.inspect(false)["usage"]["records"], 0);
    assert_eq!(f.inspect(true)["usage"]["recoveryRecords"], 1);
}

#[test]
fn management_is_send_sync_main_only_and_rejects_unrecognized_arguments() {
    fn shared<T: Send + Sync>() {}
    shared::<Core>();
    shared::<Service>();
    shared::<Plan>();
    let capability: Value =
        serde_json::from_str(include_str!("../../capabilities/main.json")).unwrap();
    assert_eq!(capability["local"], true);
    assert_eq!(capability["webviews"], json!(["main"]));
    assert!(capability.get("remote").is_none());
    let commands = include_str!("../commands/state_management.rs");
    let build = include_str!("../../build.rs");
    let handlers = include_str!("../lib.rs");
    let storage = include_str!("../document_server/storage.rs");
    for command in [
        "inspect_saved_state",
        "list_saved_state_recovery",
        "prepare_saved_state_management",
        "confirm_saved_state_management",
        "cancel_saved_state_management",
        "verify_saved_state_management",
    ] {
        assert!(capability["permissions"]
            .as_array()
            .unwrap()
            .contains(&json!(format!("allow-{}", command.replace('_', "-")))));
        assert!(build.contains(&format!("\"{command}\"")));
        assert!(handlers.contains(&format!("commands::state_management::{command}")));
        assert!(!storage.contains(command));
        let method = commands
            .split(&format!("pub async fn {command}("))
            .nth(1)
            .unwrap()
            .split("#[tauri::command]")
            .next()
            .unwrap();
        assert!(method.contains("main_host(&webview)?"));
    }
    assert!(commands.contains("webview.label() != \"main\""));
    let request = json!({"context":{"workspaceId":null,"viewId":"v"},"operation":"quarantine","candidateId":"id","snapshotId":"snapshot","path":"arbitrary.html"});
    assert!(serde_json::from_value::<PrepareRequest>(request).is_err());
}

#[test]
#[ignore]
fn fixture_external_writer_holds_database() {
    let database = std::env::var_os("MY_KNOWLEDGE_LIVE_MANAGEMENT_FIXTURE_DB")
        .expect("synthetic fixture only");
    let marker =
        PathBuf::from(std::env::var_os("MY_KNOWLEDGE_LIVE_MANAGEMENT_FIXTURE_MARKER").unwrap());
    let connection = Connection::open(database).unwrap();
    connection.execute_batch("BEGIN EXCLUSIVE;").unwrap();
    fs::write(&marker, b"ready").unwrap();
    let started = Instant::now();
    while !marker.with_extension("release").exists() {
        assert!(started.elapsed() < Duration::from_secs(5));
        std::thread::sleep(Duration::from_millis(2));
    }
    connection.execute_batch("ROLLBACK;").unwrap();
}

#[test]
fn external_writer_is_busy_and_normal_inspection_recovers_after_release() {
    use crate::identifier_migration::tests::FIXTURE_PROCESS_GATE;
    let f = Fixture::new();
    f.upgrade();
    let marker = f.temp.path().join("writer-ready");
    let _process_gate = FIXTURE_PROCESS_GATE.write().unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "state_inspection::live::tests::fixture_external_writer_holds_database",
            "--ignored",
        ])
        .env(
            "MY_KNOWLEDGE_LIVE_MANAGEMENT_FIXTURE_DB",
            f.profile.join("document-state/state.sqlite"),
        )
        .env("MY_KNOWLEDGE_LIVE_MANAGEMENT_FIXTURE_MARKER", &marker)
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let started = Instant::now();
    while !marker.exists() {
        assert!(started.elapsed() < Duration::from_secs(3));
        std::thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(
        inspect(
            &f.core,
            PageRequest {
                query: None,
                context: f.context.clone(),
                offset: 0,
                limit: 20,
                snapshot_id: None
            },
            false
        )
        .unwrap_err()
        .code,
        "state_busy"
    );
    fs::write(marker.with_extension("release"), b"release").unwrap();
    assert!(child.wait().unwrap().success());
    assert_eq!(f.inspect(false)["usage"]["records"], 1);
}

#[test]
fn explicit_upgrade_rejects_corrupt_values_without_changing_schema_or_quota() {
    let f = Fixture::new();
    f.sql(|c| {
        let bytes: i64 = c
            .query_row("SELECT bytes FROM documents", [], |r| r.get(0))
            .unwrap();
        let bad = format!("[{}]", " ".repeat(bytes as usize - 2));
        c.execute("UPDATE documents SET data=?1", [bad]).unwrap();
    });
    let before = f.inspect(false);
    let id = f.prepare(Operation::Upgrade, None);
    assert_eq!(
        confirm(
            &f.core,
            Confirmation {
                context: f.context.clone(),
                plan_id: id.clone(),
                confirmation: id
            }
        )
        .unwrap_err()
        .code,
        "state_corrupt"
    );
    assert_eq!(f.inspect(false)["databaseSchemaVersion"], 1);
    assert_eq!(f.inspect(false)["usage"], before["usage"]);
}
