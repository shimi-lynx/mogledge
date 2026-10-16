//! Actual local CLI, synthetic temporary profiles only; no Tauri or user data.
use mogledge_backend_tests::{document_state::DocumentState, knowledge};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::mpsc,
    time::Duration,
};

struct Process {
    child: Child,
    input: ChildStdin,
    replies: mpsc::Receiver<Value>,
}
impl Process {
    fn start(profile: &std::path::Path, root: &std::path::Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_state-transfer-cli"))
            .args(["session", "--profile-dir"])
            .arg(profile)
            .arg("--root")
            .arg(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let (send, replies) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str(&line) else {
                    break;
                };
                if send.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            replies,
        }
    }
    fn raw(&mut self, value: Value) -> Value {
        serde_json::to_writer(&mut self.input, &value).unwrap();
        self.input.write_all(b"\n").unwrap();
        self.input.flush().unwrap();
        let response = self
            .replies
            .recv_timeout(Duration::from_secs(5))
            .expect("CLI must acknowledge within the fixture budget");
        let output = response.to_string();
        for private in [
            "SYNTHETIC_EXPORTED_SECRET",
            "SYNTHETIC_PREVIOUS_SECRET",
            "source.html",
            "target.html",
        ] {
            assert!(!output.contains(private));
        }
        response
    }
    fn request(&mut self, value: Value) -> Value {
        let response = self.raw(value);
        assert_eq!(response["ok"], true);
        response["result"].clone()
    }
    fn confirm(&mut self, preview: &Value, replace: bool) -> Value {
        let mut command = json!({"command":"confirm","plan_id":preview["planId"],"confirmation":preview["planId"]});
        if replace {
            command["replace_confirmation"] = preview["planId"].clone();
        }
        self.request(command)
    }
    fn quit(&mut self) {
        self.input.write_all(b"{\"command\":\"quit\"}\n").unwrap();
        self.input.flush().unwrap();
        assert!(self.child.wait().unwrap().success());
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn actual_cli_exports_restarts_imports_backs_up_and_verifies_without_payload_output() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("com.shimilynx.mogledge");
    let state = profile.join("document-state");
    drop(DocumentState::new(state.clone()).unwrap());
    fs::write(profile.join("identifier-migration.lock"), []).unwrap();
    let root = temp.path().join("root");
    let files = temp.path().join("files");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&files).unwrap();
    fs::write(root.join("source.html"), b"synthetic source").unwrap();
    fs::write(root.join("target.html"), b"synthetic target").unwrap();
    let (_, dir) = knowledge::open_root(&root).unwrap();
    let root_id = knowledge::storage_root_identity(&dir).unwrap();
    let source_id = knowledge::storage_identity(&root, &dir, "source.html").unwrap();
    let target_id = knowledge::storage_identity(&root, &dir, "target.html").unwrap();
    let source = json!({"app":{"schemaVersion":2,"data":{"secret":"SYNTHETIC_EXPORTED_SECRET","unicode":"日本語"}}});
    let previous = json!({"app":{"schemaVersion":2,"data":{"secret":"SYNTHETIC_PREVIOUS_SECRET"}}});
    let source_text = source.to_string();
    let previous_text = previous.to_string();
    let connection = Connection::open(state.join("state.sqlite")).unwrap();
    for (id, data, revision, path, generation) in [
        (&source_id, &source_text, 12, "source.html", 1),
        (&target_id, &previous_text, 3, "target.html", 2),
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
            [(source_text.len() + previous_text.len()) as i64],
        )
        .unwrap();
    drop(connection);
    let file = files.join("export.json");
    let backup = files.join("previous.json");
    let mut process = Process::start(&profile, &root);
    let inspection = process.request(json!({"command":"inspect"}));
    let preview=process.request(json!({"command":"prepare_export","document_identity":source_id,"snapshot_id":inspection["snapshotId"],"output_path":file}));
    assert!(!file.exists());
    process.confirm(&preview, false);
    process.quit();
    drop(process);
    let exported: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    assert_eq!(exported["formatVersion"], 1);
    assert_eq!(exported["source"]["documentIdentity"], source_id);
    assert_eq!(exported["apps"], source);
    let mut process = Process::start(&profile, &root);
    let target = process.request(json!({"command":"inspect_target","relative_path":"target.html"}));
    assert_eq!(target["documentIdentity"], target_id);
    let inspection = process.request(json!({"command":"inspect"}));
    let preview=process.request(json!({"command":"prepare_import","file_path":file,"relative_path":"target.html","target_identity":target["documentIdentity"],"snapshot_id":inspection["snapshotId"],"backup_path":backup}));
    assert!(!backup.exists());
    assert_eq!(preview["replacesExisting"], true);
    let rejected = process.raw(
        json!({"command":"confirm","plan_id":preview["planId"],"confirmation":preview["planId"]}),
    );
    assert_eq!(
        rejected["error"]["code"],
        "explicit_replace_confirmation_required"
    );
    assert!(!backup.exists());
    let receipt = process.confirm(&preview, true);
    assert_eq!(receipt["revision"], 4);
    assert_eq!(receipt["previousStateBackedUp"], true);
    process.quit();
    drop(process);
    let preserved: Value = serde_json::from_slice(&fs::read(&backup).unwrap()).unwrap();
    assert_eq!(preserved["apps"], previous);
    let mut process = Process::start(&profile, &root);
    let verified=process.request(json!({"command":"verify_import","file_path":file,"relative_path":"target.html","target_identity":target_id}));
    assert_eq!(verified["matches"], true);
    let invalid = files.join("invalid.json");
    fs::write(
        &invalid,
        b"{\"formatVersion\":999,\"data\":\"SYNTHETIC_EXPORTED_SECRET\"}",
    )
    .unwrap();
    let inspection = process.request(json!({"command":"inspect"}));
    let bad_backup = files.join("bad-before.json");
    let rejected=process.raw(json!({"command":"prepare_import","file_path":invalid,"relative_path":"target.html","target_identity":target_id,"snapshot_id":inspection["snapshotId"],"backup_path":bad_backup}));
    assert_eq!(rejected["ok"], false);
    assert!(!bad_backup.exists());
    process.quit();
    drop(process);
    let connection = Connection::open(state.join("state.sqlite")).unwrap();
    let (stored, revision): (String, i64) = connection
        .query_row(
            "SELECT data,revision FROM documents WHERE id=?1",
            [&target_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Value>(&stored).unwrap(), source);
    assert_eq!(revision, 4);
    assert_eq!(
        connection
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        fs::read(root.join("source.html")).unwrap(),
        b"synthetic source"
    );
    assert_eq!(
        fs::read(root.join("target.html")).unwrap(),
        b"synthetic target"
    );
}
