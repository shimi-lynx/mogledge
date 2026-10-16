use super::*;
#[cfg(unix)]
use crate::identifier_migration::tests::FixtureCommand;
use crate::{document_state::DocumentState, knowledge};
use std::{fs, io::Cursor};

struct Fixture {
    _temp: tempfile::TempDir,
    profile: PathBuf,
    root: PathBuf,
    files: PathBuf,
    source_id: String,
    target_id: String,
    source: String,
    target: String,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let profile = temp.path().join("com.shimilynx.myknowledge");
        drop(DocumentState::new(profile.join("document-state")).unwrap());
        fs::write(profile.join("identifier-migration.lock"), []).unwrap();
        let root = temp.path().join("root");
        let files = temp.path().join("files");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&files).unwrap();
        fs::write(root.join("source.html"), b"synthetic source").unwrap();
        fs::write(root.join("target.html"), b"synthetic target").unwrap();
        let (root, dir) = knowledge::open_root(&root).unwrap();
        let root_id = knowledge::storage_root_identity(&dir).unwrap();
        let source_id = knowledge::storage_identity(&root, &dir, "source.html").unwrap();
        let target_id = knowledge::storage_identity(&root, &dir, "target.html").unwrap();
        let source = json!({"app":{"schemaVersion":1,"data":{"secret":"SYNTHETIC_SOURCE_SECRET","unicode":"日本語"}}}).to_string();
        let target = json!({"app":{"schemaVersion":1,"data":"SYNTHETIC_PREVIOUS_SECRET"},"oldOnly":{"schemaVersion":2,"data":true}}).to_string();
        let connection =
            rusqlite::Connection::open(profile.join("document-state/state.sqlite")).unwrap();
        for (id, data, path, revision, generation) in [
            (&source_id, &source, "source.html", 4, 1),
            (&target_id, &target, "target.html", 7, 2),
        ] {
            connection
                .execute(
                    "INSERT INTO documents VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    params![
                        id,
                        data,
                        data.len() as i64,
                        revision,
                        root_id,
                        path,
                        generation
                    ],
                )
                .unwrap();
        }
        connection
            .execute(
                "UPDATE quota SET bytes=?1,documents=2,generation=2",
                [(source.len() + target.len()) as i64],
            )
            .unwrap();
        drop(connection);
        Self {
            _temp: temp,
            profile,
            root,
            files,
            source_id,
            target_id,
            source,
            target,
        }
    }
    fn session(&self) -> Session {
        Session::open(&self.profile, &self.root).unwrap()
    }
    fn export(&self, session: &mut Session) -> PathBuf {
        let path = self.files.join("export.json");
        let preview = session
            .prepare(Command::PrepareExport {
                document_identity: self.source_id.clone(),
                snapshot_id: session.snapshot().unwrap().snapshot_id,
                output_path: path.clone(),
            })
            .unwrap();
        assert!(!path.exists());
        let id = preview["planId"].as_str().unwrap();
        let receipt = session.confirm(id, id, None).unwrap();
        assert_eq!(session.confirm(id, id, None).unwrap(), receipt);
        path
    }
    fn import(
        &self,
        session: &mut Session,
        input: &Path,
        backup: Option<&Path>,
    ) -> Result<Value, TransferError> {
        session.prepare(Command::PrepareImport {
            file_path: input.to_owned(),
            relative_path: "target.html".into(),
            target_identity: self.target_id.clone(),
            snapshot_id: session.snapshot().unwrap().snapshot_id,
            backup_path: backup.map(Path::to_owned),
        })
    }
}
fn data(session: &Session, id: &str) -> (String, i64) {
    let record = session.record(id).unwrap().unwrap();
    (record.data, record.revision)
}
fn replace(session: &mut Session, preview: &Value) -> Result<Value, TransferError> {
    let id = preview["planId"].as_str().unwrap();
    session.confirm(id, id, Some(id))
}
fn private(value: &Value, fixture: &Fixture) {
    let output = value.to_string();
    for secret in [
        "SYNTHETIC_SOURCE_SECRET",
        "SYNTHETIC_PREVIOUS_SECRET",
        "source.html",
        "target.html",
        fixture.profile.to_str().unwrap(),
        fixture.files.to_str().unwrap(),
    ] {
        assert!(!output.contains(secret));
    }
}

fn prepared_uuid_import(relative: &str) -> (Fixture, Session, Value, String, PathBuf) {
    let mut f = Fixture::new();
    f.source = json!({"app":{"schemaVersion":1,"data":{"amount":13.5,"mode":"square","enabled":true,"selections":["alpha","beta"],"checks":[true,false],"nested":{"bonus":-2,"note":"人工入力"}}},"aux":{"schemaVersion":2,"data":{"values":[1,3,5],"optional":null}}}).to_string();
    let connection =
        rusqlite::Connection::open(f.profile.join("document-state/state.sqlite")).unwrap();
    connection
        .execute(
            "UPDATE documents SET data=?1,bytes=?2,revision=77,generation=77 WHERE id=?3",
            params![f.source, f.source.len() as i64, f.source_id],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE quota SET bytes=?1,generation=77",
            [(f.source.len() + f.target.len()) as i64],
        )
        .unwrap();
    drop(connection);
    let mut legacy = f.session();
    let input = f.export(&mut legacy);
    drop(legacy);
    let uuid = "33c45d90-a60e-40d1-bd71-3c6efaf11770";
    fs::create_dir_all(f.root.join(relative).parent().unwrap()).unwrap();
    fs::write(
        f.root.join(relative),
        format!("<!doctype html><meta name=\"mogledge-document-id\" content=\"{uuid}\"><input>"),
    )
    .unwrap();
    let (root, dir) = knowledge::open_root(&f.root).unwrap();
    crate::html_authoring::install_managed_marker(root, dir, &json!({"version":1,"kind":"mogledge-managed-folder","id":"1746e10a-3842-420c-af0b-f1cce908a26b"})).unwrap();
    let mut session = f.session();
    let target = session.target(relative, None).unwrap();
    assert_eq!(target, crate::document_identity::storage_key(uuid));
    assert_ne!(
        target,
        session
            .offline
            .root
            .as_ref()
            .unwrap()
            .identity_at(relative)
            .unwrap()
    );
    let preview = session
        .prepare(Command::PrepareImport {
            file_path: input.clone(),
            relative_path: relative.into(),
            target_identity: target.clone(),
            snapshot_id: session.snapshot().unwrap().snapshot_id,
            backup_path: None,
        })
        .unwrap();
    assert_eq!(preview["replacesExisting"], false);
    (f, session, preview, target, input)
}

#[test]
fn uuid_import_preserves_complete_input_and_original_rows_after_restart() {
    for relative in ["target.html", "資料/二階層/tool.html"] {
        let (f, mut session, preview, target, input) = prepared_uuid_import(relative);
        let original_html = fs::read(f.root.join(relative)).unwrap();
        let id = preview["planId"].as_str().unwrap();
        let receipt = session.confirm(id, id, None).unwrap();
        assert_eq!(receipt["revision"], 1);
        assert_eq!(data(&session, &target), (f.source.clone(), 1));
        assert_eq!(data(&session, &f.source_id), (f.source.clone(), 77));
        assert_eq!(data(&session, &f.target_id), (f.target.clone(), 7));
        let verified = session
            .execute(Command::VerifyImport {
                file_path: input,
                relative_path: relative.into(),
                target_identity: target.clone(),
            })
            .unwrap()
            .unwrap();
        assert_eq!(verified["matches"], true);
        drop(session);
        let restarted = f.session();
        assert_eq!(restarted.target(relative, None).unwrap(), target);
        assert_eq!(data(&restarted, &target), (f.source.clone(), 1));
        assert_eq!(fs::read(f.root.join(relative)).unwrap(), original_html);
    }
}

#[test]
fn uuid_import_rejects_changed_uuid_and_same_uuid_physical_replacement() {
    let relative = "資料/二階層/tool.html";
    for replace_file in [false, true] {
        let (f, mut session, preview, target, _) = prepared_uuid_import(relative);
        let before = session.offline.store.database_snapshot();
        let old_physical = session
            .offline
            .root
            .as_ref()
            .unwrap()
            .identity_at(relative)
            .unwrap();
        let source = fs::read_to_string(f.root.join(relative)).unwrap();
        if replace_file {
            fs::rename(f.root.join(relative), f.root.join("retained-target.html")).unwrap();
            fs::write(f.root.join(relative), source).unwrap();
            assert_eq!(session.target(relative, None).unwrap(), target);
            assert_ne!(
                session
                    .offline
                    .root
                    .as_ref()
                    .unwrap()
                    .identity_at(relative)
                    .unwrap(),
                old_physical
            );
        } else {
            fs::write(
                f.root.join(relative),
                source.replace(
                    "33c45d90-a60e-40d1-bd71-3c6efaf11770",
                    "72edf850-cf44-4e79-bbfe-10292145f05b",
                ),
            )
            .unwrap();
            assert_eq!(
                session
                    .offline
                    .root
                    .as_ref()
                    .unwrap()
                    .identity_at(relative)
                    .unwrap(),
                old_physical
            );
        }
        let id = preview["planId"].as_str().unwrap();
        assert_eq!(
            session.confirm(id, id, None).unwrap_err().code,
            "target_identity_changed"
        );
        assert_eq!(session.offline.store.database_snapshot(), before);
        assert!(session.record(&target).unwrap().is_none());
        assert_eq!(data(&session, &f.source_id), (f.source.clone(), 77));
        assert_eq!(data(&session, &f.target_id), (f.target.clone(), 7));
    }
}

#[test]
fn uuid_import_final_physical_recheck_rolls_back_unchanged_namespace() {
    let relative = "資料/二階層/tool.html";
    let (f, mut session, preview, target, input) = prepared_uuid_import(relative);
    let before = session.offline.store.database_snapshot();
    let id = preview["planId"].as_str().unwrap();
    let pending = session.plans.remove(id).unwrap();
    let physical = match &pending.action {
        Action::Import {
            target_physical_identity,
            ..
        } => target_physical_identity.clone(),
        _ => unreachable!(),
    };
    let source = fs::read(f.root.join(relative)).unwrap();
    fs::rename(f.root.join(relative), f.root.join("retained-target.html")).unwrap();
    fs::write(f.root.join(relative), source).unwrap();
    assert_eq!(session.target(relative, None).unwrap(), target);
    let incoming = format::parse(&fs::read(input).unwrap()).unwrap();
    session
        .offline
        .store
        .connection
        .execute_batch("PRAGMA query_only=OFF;")
        .unwrap();
    let result = session.apply_import(&pending, &target, &physical, relative, None, &incoming);
    session
        .offline
        .store
        .connection
        .execute_batch("PRAGMA query_only=ON;")
        .unwrap();
    assert_eq!(result.unwrap_err().code, "target_identity_changed");
    assert_eq!(session.offline.store.database_snapshot(), before);
    assert!(session.record(&target).unwrap().is_none());
    assert_eq!(data(&session, &f.source_id), (f.source.clone(), 77));
}

#[test]
fn configured_document_limit_is_used_by_cli_import_and_restart_validation() {
    let f = Fixture::new();
    let mut session = f.session();
    let source = session.record(&f.source_id).unwrap().unwrap();
    let large = json!({"app":{"schemaVersion":1,"data":"x".repeat(6 * 1024 * 1024)}}).to_string();
    let portable = format::from_state(
        &product_version().unwrap(),
        format::Source {
            root_identity: source.root,
            document_identity: f.source_id.clone(),
            relative_path: "source.html".into(),
            revision: source.revision,
            generation: source.generation,
        },
        &large,
    )
    .unwrap();
    let input = f.files.join("large.json");
    fs::write(&input, format::encode(&portable.file).unwrap()).unwrap();
    let backup = f.files.join("before.json");
    assert_eq!(
        f.import(&mut session, &input, Some(&backup))
            .unwrap_err()
            .code,
        "quota_exceeded"
    );
    assert_eq!(data(&session, &f.target_id).0, f.target);
    assert!(!backup.exists());
    drop(session);
    let core = crate::core::Core::new(19220);
    core.document_state
        .set(DocumentState::new(f.profile.join("document-state")).unwrap())
        .ok()
        .unwrap();
    let context = crate::state_inspection::live::Context {
        view_id: String::new(),
        workspace_id: None,
    };
    let current = crate::storage_limits::get(&core, &context).unwrap();
    crate::storage_limits::set(
        &core,
        &crate::storage_limits::SetRequest {
            context,
            expected_revision: current.revision,
            expected_generation: current.generation,
            document_mi_b: 8,
            total_mi_b: 16,
            acknowledge_compatibility: true,
        },
    )
    .unwrap();
    drop(core);
    let mut session = f.session();
    let preview = f.import(&mut session, &input, Some(&backup)).unwrap();
    replace(&mut session, &preview).unwrap();
    assert_eq!(data(&session, &f.target_id).0, large);
    drop(session);
    let restarted = f.session();
    assert_eq!(data(&restarted, &f.target_id).0, large);
}

#[test]
fn export_replace_backup_restart_verify_and_restore_preserve_values() {
    let f = Fixture::new();
    let mut s = f.session();
    let before = s.offline.store.database_snapshot();
    let input = f.export(&mut s);
    assert_eq!(s.offline.store.database_snapshot(), before);
    let exported = format::parse(&fs::read(&input).unwrap()).unwrap();
    assert_eq!(exported.canonical_state, f.source);
    assert_eq!(exported.file.source.document_identity, f.source_id);
    let backup = f.files.join("before.json");
    let preview = f.import(&mut s, &input, Some(&backup)).unwrap();
    private(&preview, &f);
    assert_eq!(preview["previousApps"].as_array().unwrap().len(), 2);
    assert_eq!(preview["appCount"], 1);
    assert!(!backup.exists());
    let id = preview["planId"].as_str().unwrap();
    assert_eq!(
        s.confirm(id, id, None).unwrap_err().code,
        "explicit_replace_confirmation_required"
    );
    assert!(!backup.exists());
    let receipt = replace(&mut s, &preview).unwrap();
    private(&receipt, &f);
    assert_eq!(data(&s, &f.target_id), (f.source.clone(), 8));
    assert_eq!(
        format::parse(&fs::read(&backup).unwrap())
            .unwrap()
            .canonical_state,
        f.target
    );
    drop(s);
    let mut s = f.session();
    assert_eq!(
        s.confirm(id, id, Some(id)).unwrap_err().code,
        "unknown_or_consumed_plan"
    );
    let verified = s
        .execute(Command::VerifyImport {
            file_path: input,
            relative_path: "target.html".into(),
            target_identity: f.target_id.clone(),
        })
        .unwrap()
        .unwrap();
    assert_eq!(verified["matches"], true);
    private(&verified, &f);
    let next = f.files.join("before-restore.json");
    let preview = f.import(&mut s, &backup, Some(&next)).unwrap();
    replace(&mut s, &preview).unwrap();
    assert_eq!(data(&s, &f.target_id), (f.target.clone(), 9));
    assert_eq!(
        format::parse(&fs::read(next).unwrap())
            .unwrap()
            .canonical_state,
        f.source
    );
    assert_eq!(
        fs::read(f.root.join("source.html")).unwrap(),
        b"synthetic source"
    );
    assert_eq!(
        fs::read(f.root.join("target.html")).unwrap(),
        b"synthetic target"
    );
}
#[test]
fn new_identity_import_uses_host_selection_not_source_identity_or_path() {
    let f = Fixture::new();
    let mut s = f.session();
    let input = f.export(&mut s);
    fs::write(f.root.join("new.html"), b"new target").unwrap();
    let id = s.target("new.html", None).unwrap();
    assert_ne!(id, f.source_id);
    let preview = s
        .prepare(Command::PrepareImport {
            file_path: input,
            relative_path: "new.html".into(),
            target_identity: id.clone(),
            snapshot_id: s.snapshot().unwrap().snapshot_id,
            backup_path: None,
        })
        .unwrap();
    let plan = preview["planId"].as_str().unwrap();
    assert_eq!(preview["replacesExisting"], false);
    s.confirm(plan, plan, None).unwrap();
    assert_eq!(data(&s, &id), (f.source.clone(), 1));
    assert_eq!(data(&s, &f.source_id), (f.source, 4));
    assert_eq!(s.quota().unwrap().1, 3);
}
#[test]
fn cancelled_forged_expired_stale_and_missing_backup_plans_do_not_apply() {
    let f = Fixture::new();
    let mut s = f.session();
    let input = f.export(&mut s);
    let before = s.offline.store.database_snapshot();
    assert_eq!(
        f.import(&mut s, &input, None).unwrap_err().code,
        "explicit_backup_required"
    );
    let backup = f.files.join("before.json");
    let preview = f.import(&mut s, &input, Some(&backup)).unwrap();
    let id = preview["planId"].as_str().unwrap();
    assert_eq!(
        s.confirm(id, "forged", Some(id)).unwrap_err().code,
        "explicit_confirmation_required"
    );
    s.execute(Command::Cancel { plan_id: id.into() }).unwrap();
    assert_eq!(
        s.confirm(id, id, Some(id)).unwrap_err().code,
        "unknown_or_consumed_plan"
    );
    assert!(!backup.exists());
    let preview = f.import(&mut s, &input, Some(&backup)).unwrap();
    let id = preview["planId"].as_str().unwrap();
    s.plans.get_mut(id).unwrap().expires = Instant::now();
    assert_eq!(
        s.confirm(id, id, Some(id)).unwrap_err().code,
        "expired_plan"
    );
    assert_eq!(s.offline.store.database_snapshot(), before);
    let preview = f.import(&mut s, &input, Some(&backup)).unwrap();
    let id = preview["planId"].as_str().unwrap();
    s.offline
        .store
        .connection
        .execute_batch(
            "PRAGMA query_only=OFF;UPDATE quota SET generation=generation+1;PRAGMA query_only=ON;",
        )
        .unwrap();
    let changed = s.offline.store.database_snapshot();
    assert_eq!(
        s.confirm(id, id, Some(id)).unwrap_err().code,
        "state_changed"
    );
    assert_eq!(s.offline.store.database_snapshot(), changed);
    assert!(!backup.exists());
}
#[test]
fn changed_input_target_root_and_existing_backup_stop_without_overwrite() {
    for mode in ["input", "identity", "root", "backup"] {
        let f = Fixture::new();
        let mut s = f.session();
        let input = f.export(&mut s);
        let backup = f.files.join("before.json");
        let preview = f.import(&mut s, &input, Some(&backup)).unwrap();
        let before = s.offline.store.database_snapshot();
        match mode {
            "input" => fs::write(input, b"{}").unwrap(),
            "identity" => {
                fs::rename(f.root.join("target.html"), f.root.join("old.html")).unwrap();
                fs::write(f.root.join("target.html"), b"replacement").unwrap();
            }
            "root" => {
                #[cfg(windows)]
                {
                    // A connected root cannot be renamed until its handle is released.
                    assert!(fs::rename(&f.root, f.root.with_extension("old")).is_err());
                    s.offline.root = None;
                }
                fs::rename(&f.root, f.root.with_extension("old")).unwrap();
                fs::create_dir(&f.root).unwrap();
                fs::write(f.root.join("target.html"), b"new root").unwrap();
            }
            "backup" => fs::write(&backup, b"existing unrelated file").unwrap(),
            _ => unreachable!(),
        }
        assert!(replace(&mut s, &preview).is_err());
        assert_eq!(s.offline.store.database_snapshot(), before);
        if mode == "backup" {
            assert_eq!(fs::read(backup).unwrap(), b"existing unrelated file");
        } else {
            assert!(!backup.exists());
        }
    }
}
#[test]
fn schema_conflict_and_empty_existing_record_require_explicit_preservation() {
    let f = Fixture::new();
    let mut s = f.session();
    let input = f.export(&mut s);
    let conflict = json!({"app":{"schemaVersion":2,"data":null}}).to_string();
    s.offline
        .store
        .connection
        .execute_batch("PRAGMA query_only=OFF;")
        .unwrap();
    s.offline
        .store
        .connection
        .execute(
            "UPDATE documents SET data=?1,bytes=?2 WHERE id=?3",
            params![conflict, conflict.len() as i64, f.target_id],
        )
        .unwrap();
    s.offline
        .store
        .connection
        .execute(
            "UPDATE quota SET bytes=?1",
            [(f.source.len() + conflict.len()) as i64],
        )
        .unwrap();
    s.offline
        .store
        .connection
        .execute_batch("PRAGMA query_only=ON;")
        .unwrap();
    let backup = f.files.join("before.json");
    assert_eq!(
        f.import(&mut s, &input, Some(&backup)).unwrap_err().code,
        "schema_conflict"
    );
    assert!(!backup.exists());
    s.offline
        .store
        .connection
        .execute_batch("PRAGMA query_only=OFF;")
        .unwrap();
    s.offline
        .store
        .connection
        .execute(
            "UPDATE documents SET data='{}',bytes=2 WHERE id=?1",
            [&f.target_id],
        )
        .unwrap();
    s.offline
        .store
        .connection
        .execute("UPDATE quota SET bytes=?1", [f.source.len() as i64 + 2])
        .unwrap();
    s.offline
        .store
        .connection
        .execute_batch("PRAGMA query_only=ON;")
        .unwrap();
    let preview = f.import(&mut s, &input, Some(&backup)).unwrap();
    assert_eq!(preview["replacesExisting"], true);
    let id = preview["planId"].as_str().unwrap();
    assert_eq!(
        s.confirm(id, id, None).unwrap_err().code,
        "explicit_replace_confirmation_required"
    );
    replace(&mut s, &preview).unwrap();
    assert_eq!(
        format::parse(&fs::read(backup).unwrap())
            .unwrap()
            .canonical_state,
        "{}"
    );
}
#[test]
fn disk_full_rolls_back_values_revision_quota_and_keeps_confirmed_backup() {
    let f = Fixture::new();
    let mut s = f.session();
    let incoming = json!({"app":{"schemaVersion":1,"data":"x".repeat(2*1024*1024)}}).to_string();
    let source = s.record(&f.source_id).unwrap().unwrap();
    let portable = format::from_state(
        &product_version().unwrap(),
        format::Source {
            root_identity: source.root,
            document_identity: f.source_id.clone(),
            relative_path: "source.html".into(),
            revision: 4,
            generation: 1,
        },
        &incoming,
    )
    .unwrap();
    let input = f.files.join("large.json");
    fs::write(&input, format::encode(&portable.file).unwrap()).unwrap();
    let pages: i64 = s
        .offline
        .store
        .connection
        .query_row("PRAGMA page_count", [], |r| r.get(0))
        .unwrap();
    s.offline
        .store
        .connection
        .pragma_update(None, "max_page_count", pages)
        .unwrap();
    let before = s.offline.store.database_snapshot();
    let quota = s.quota().unwrap();
    let backup = f.files.join("before.json");
    let preview = f.import(&mut s, &input, Some(&backup)).unwrap();
    assert!(replace(&mut s, &preview).is_err());
    assert_eq!(data(&s, &f.target_id), (f.target.clone(), 7));
    assert_eq!(s.quota().unwrap(), quota);
    assert_eq!(s.offline.store.database_snapshot(), before);
    assert_eq!(
        format::parse(&fs::read(backup).unwrap())
            .unwrap()
            .canonical_state,
        f.target
    );
}
#[test]
fn quota_generation_and_record_count_boundaries_are_inclusive() {
    let f = Fixture::new();
    let s = f.session();
    let old = s.record(&f.target_id).unwrap().unwrap();
    s.offline
        .store
        .connection
        .execute_batch("PRAGMA query_only=OFF;")
        .unwrap();
    s.offline
        .store
        .connection
        .execute(
            "UPDATE quota SET bytes=?1,documents=?2",
            params![MAX_TOTAL_BYTES, MAX_DOCUMENTS],
        )
        .unwrap();
    assert!(s.budget(Some(&old), old.bytes).is_ok());
    assert_eq!(
        s.budget(Some(&old), old.bytes + 1).unwrap_err().code,
        "quota_exceeded"
    );
    s.offline
        .store
        .connection
        .execute("UPDATE quota SET bytes=0,documents=?1", [MAX_DOCUMENTS])
        .unwrap();
    assert_eq!(s.budget(None, 2).unwrap_err().code, "quota_exceeded");
    s.offline
        .store
        .connection
        .execute(
            "UPDATE quota SET bytes=0,documents=0,generation=?1",
            [i64::MAX],
        )
        .unwrap();
    assert_eq!(s.budget(None, 2).unwrap_err().code, "revision_limit");
}
#[test]
fn untrusted_commands_paths_and_unknown_json_do_not_write_or_echo() {
    let f = Fixture::new();
    let before = fs::read(f.profile.join("document-state/state.sqlite")).unwrap();
    let args = vec![
        "session".into(),
        "--profile-dir".into(),
        f.profile.clone().into_os_string(),
        "--root".into(),
        f.root.clone().into_os_string(),
    ];
    let mut input=Cursor::new(b"{\"command\":\"import\",\"token\":\"SYNTHETIC_SOURCE_SECRET\"}\n{\"command\":\"inspect_target\",\"relative_path\":\"../outside.html\"}\n{\"command\":\"quit\"}\n");
    let mut output = Vec::new();
    let mut errors = Vec::new();
    assert_eq!(run_cli(args, &mut input, &mut output, &mut errors), 0);
    assert!(errors.is_empty());
    assert!(!String::from_utf8(output)
        .unwrap()
        .contains("SYNTHETIC_SOURCE_SECRET"));
    assert_eq!(
        fs::read(f.profile.join("document-state/state.sqlite")).unwrap(),
        before
    );
    assert_eq!(fs::read_dir(f.files).unwrap().count(), 0);
}
#[test]
fn interruption_and_expired_publish_leave_state_and_destination_unchanged() {
    let f = Fixture::new();
    let mut s = f.session();
    let input = f.export(&mut s);
    let backup = f.files.join("before.json");
    let preview = f.import(&mut s, &input, Some(&backup)).unwrap();
    let id = preview["planId"].as_str().unwrap();
    let pending = s.plans.remove(id).unwrap();
    let incoming = format::parse(&fs::read(input).unwrap()).unwrap();
    let old = s.record(&f.target_id).unwrap().unwrap();
    let before = s.offline.store.database_snapshot();
    s.offline
        .store
        .connection
        .execute_batch("PRAGMA query_only=OFF;")
        .unwrap();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = calls.clone();
    s.offline
        .store
        .connection
        .progress_handler(
            1,
            Some(move || observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 100),
        )
        .unwrap();
    assert!(s
        .apply_import(
            &pending,
            &f.target_id,
            &f.target_id,
            "target.html",
            Some(&old),
            &incoming
        )
        .is_err());
    assert!(s.offline.store.connection.is_autocommit());
    s.offline
        .store
        .connection
        .progress_handler(0, None::<fn() -> bool>)
        .unwrap();
    s.offline
        .store
        .connection
        .execute_batch("PRAGMA query_only=ON;")
        .unwrap();
    assert!(calls.load(std::sync::atomic::Ordering::SeqCst) > 100);
    assert_eq!(s.offline.store.database_snapshot(), before);
    assert_eq!(data(&s, &f.target_id), (f.target.clone(), 7));
    let location = files::Location::open(&backup, &s.profile).unwrap();
    assert_eq!(
        location
            .write_new(b"private", || Err(failure("expired_plan")))
            .unwrap_err()
            .code,
        "expired_plan"
    );
    assert!(!backup.exists());
    assert_eq!(fs::read_dir(f.files).unwrap().count(), 1);
}

#[test]
fn interrupted_import_begin_preserves_state_and_allows_next_command() {
    use rusqlite::hooks::{AuthAction, AuthContext, Authorization, TransactionOperation};
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    for interrupt_after in [1, 3, 5] {
        let f = Fixture::new();
        let mut s = f.session();
        let input = f.export(&mut s);
        let backup = f.files.join("before.json");
        let preview = f.import(&mut s, &input, Some(&backup)).unwrap();
        let pending = s.plans.remove(preview["planId"].as_str().unwrap()).unwrap();
        let incoming = format::parse(&fs::read(input).unwrap()).unwrap();
        let old = s.record(&f.target_id).unwrap().unwrap();
        let before = s.offline.store.database_snapshot();
        let quota = s.quota().unwrap();
        let connection = &s.offline.store.connection;
        connection.execute_batch("PRAGMA query_only=OFF").unwrap();
        let began = Arc::new(AtomicBool::new(false));
        let auth_began = Arc::clone(&began);
        connection
            .authorizer(Some(move |context: AuthContext<'_>| {
                if matches!(
                    context.action,
                    AuthAction::Transaction {
                        operation: TransactionOperation::Begin
                    }
                ) {
                    auth_began.store(true, Ordering::SeqCst);
                }
                Authorization::Allow
            }))
            .unwrap();
        let operations = Arc::new(AtomicUsize::new(0));
        let progress_operations = Arc::clone(&operations);
        connection
            .progress_handler(
                1,
                Some(move || {
                    began.load(Ordering::SeqCst)
                        && progress_operations.fetch_add(1, Ordering::SeqCst) + 1 >= interrupt_after
                }),
            )
            .unwrap();
        assert_eq!(
            s.apply_import(
                &pending,
                &f.target_id,
                &f.target_id,
                "target.html",
                Some(&old),
                &incoming
            )
            .unwrap_err()
            .code,
            "operation_interrupted"
        );
        let connection = &s.offline.store.connection;
        assert!(connection.is_autocommit());
        connection
            .authorizer(None::<fn(AuthContext<'_>) -> Authorization>)
            .unwrap();
        connection.execute_batch("PRAGMA query_only=ON").unwrap();
        assert_eq!(s.offline.store.database_snapshot(), before);
        assert_eq!(s.quota().unwrap(), quota);
        assert_eq!(data(&s, &f.target_id), (f.target.clone(), 7));
        assert!(!backup.exists());
        assert!(s
            .execute(Command::Inspect {
                offset: 0,
                limit: 20
            })
            .unwrap()
            .is_some());
    }
}
#[cfg(unix)]
#[test]
#[ignore]
fn fixture_child_probes_transfer_writer() {
    let path = std::env::var_os("MY_KNOWLEDGE_TRANSFER_FIXTURE_DB").unwrap();
    let connection = rusqlite::Connection::open(PathBuf::from(path)).unwrap();
    connection.busy_timeout(Duration::ZERO).unwrap();
    std::process::exit(match connection.execute_batch("BEGIN EXCLUSIVE;") {
        Ok(()) => 0,
        Err(error)
            if matches!(
                error.sqlite_error_code(),
                Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
            ) =>
        {
            42
        }
        Err(_) => 43,
    });
}
#[cfg(unix)]
fn external_writer(path: &Path) -> i32 {
    std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "state_transfer::tests::fixture_child_probes_transfer_writer",
            "--ignored",
        ])
        .env("MY_KNOWLEDGE_TRANSFER_FIXTURE_DB", path)
        .stdout(std::process::Stdio::null())
        .fixture_status()
        .unwrap()
        .code()
        .unwrap()
}
#[cfg(unix)]
#[test]
fn raced_hardlink_input_keeps_external_sqlite_writer_fenced() {
    let f = Fixture::new();
    let mut s = f.session();
    let input = f.files.join("input.json");
    fs::write(&input, b"{}").unwrap();
    let database = f.profile.join("document-state/state.sqlite");
    let location = files::Location::open(&input, &s.profile).unwrap();
    let result = location.read_after_preflight(&mut s.input_files, || {
        fs::remove_file(&input).unwrap();
        fs::hard_link(&database, &input).unwrap();
    });
    assert_eq!(result.err().unwrap().code, "unsafe_transfer_file");
    assert_eq!(s.input_files.len(), 1);
    fs::remove_file(input).unwrap();
    assert_eq!(external_writer(&database), 42);
    s.offline.store.verify().unwrap();
    drop(s);
    assert_eq!(external_writer(&database), 0);
}
#[cfg(unix)]
#[test]
fn aliases_profile_files_and_existing_output_fail_closed() {
    let f = Fixture::new();
    let mut s = f.session();
    let input = f.export(&mut s);
    let alias = f.files.join("alias.json");
    std::os::unix::fs::symlink(&input, &alias).unwrap();
    let location = files::Location::open(&alias, &s.profile).unwrap();
    assert!(location.read(&mut s.input_files).is_err());
    fs::remove_file(alias.clone()).unwrap();
    fs::hard_link(&input, &alias).unwrap();
    assert!(location.read(&mut s.input_files).is_err());
    assert!(
        files::Location::open(&f.profile.join("document-state/state.sqlite"), &s.profile).is_err()
    );
    assert_eq!(
        files::Location::open(&input, &s.profile)
            .unwrap()
            .absent()
            .unwrap_err()
            .code,
        "transfer_file_exists"
    );
}

#[test]
fn non_html_target_and_busy_profile_preserve_database() {
    let f = Fixture::new();
    fs::write(f.root.join("ordinary.json"), b"{}").unwrap();
    let s = f.session();
    let before = s.offline.store.database_snapshot();
    assert_eq!(
        s.target("ordinary.json", None).unwrap_err().code,
        "invalid_html_target"
    );
    assert!(Session::open(&f.profile, &f.root).is_err());
    assert_eq!(s.offline.store.database_snapshot(), before);
    assert_eq!(data(&s, &f.target_id), (f.target.clone(), 7));
    assert_eq!(fs::read(f.root.join("ordinary.json")).unwrap(), b"{}");
}

#[test]
fn quarantined_v2_target_requires_management_restore_and_preserves_archive() {
    let f = Fixture::new();
    let mut s = f.session();
    let input = f.export(&mut s);
    drop(s);
    let database = f.profile.join("document-state/state.sqlite");
    let mut connection = rusqlite::Connection::open(&database).unwrap();
    recovery_store::upgrade(&mut connection, || Ok(())).unwrap();
    connection.execute("INSERT INTO recovery_records SELECT 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',id,data,bytes,revision,root,path,generation,?2,1,'quarantined',NULL,NULL FROM documents WHERE id=?1",params![f.target_id, recovery_store::payload_hash(&f.target)]).unwrap();
    connection
        .execute(
            "INSERT INTO state_tombstones VALUES(?1,7,'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc')",
            [&f.target_id],
        )
        .unwrap();
    connection
        .execute("DELETE FROM documents WHERE id=?1", [&f.target_id])
        .unwrap();
    connection
        .execute(
            "UPDATE quota SET bytes=?1,documents=1,generation=3",
            [f.source.len() as i64],
        )
        .unwrap();
    recovery_store::validate(&connection).unwrap();
    drop(connection);
    let mut s = f.session();
    let before = s.offline.store.database_snapshot();
    let backup = f.files.join("backup.json");
    assert_eq!(
        f.import(&mut s, &input, Some(&backup)).unwrap_err().code,
        "target_quarantined_hold"
    );
    assert_eq!(s.offline.store.database_snapshot(), before);
    assert!(!backup.exists());
    let archived: String = s
        .offline
        .store
        .connection
        .query_row(
            "SELECT data FROM recovery_records WHERE operation_id='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(archived, f.target);
    assert_eq!(
        fs::read(f.root.join("target.html")).unwrap(),
        b"synthetic target"
    );
}
