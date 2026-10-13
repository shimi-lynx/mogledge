//! Actual CLI protocol against a synthetic profile; never uses user data.
use my_knowledge_backend_tests::{document_state::DocumentState, knowledge};
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
        let mut child = Command::new(env!("CARGO_BIN_EXE_state-inspection-cli"))
            .args(["manage", "--profile-dir"])
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
                let Ok(line) = line else {
                    break;
                };
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
    fn request(&mut self, value: Value) -> Value {
        serde_json::to_writer(&mut self.input, &value).unwrap();
        self.input.write_all(b"\n").unwrap();
        self.input.flush().unwrap();
        let response = self
            .replies
            .recv_timeout(Duration::from_secs(5))
            .expect("CLI must respond within the fixture budget");
        let text = response.to_string();
        assert!(!text.contains("SYNTHETIC_PRIVATE_VALUE"));
        assert!(!text.contains("private.html"));
        assert_eq!(response["ok"], true);
        response["result"].clone()
    }
    fn confirm(&mut self, plan: &Value) -> Value {
        self.request(
            json!({"command":"confirm","plan_id":plan["planId"],"confirmation":plan["planId"]}),
        )
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
fn actual_cli_inspect_explicit_select_quarantine_restart_status_restore() {
    let temp = tempfile::tempdir().unwrap();
    let profile = temp.path().join("com.shimilynx.myknowledge");
    let state = profile.join("document-state");
    drop(DocumentState::new(state.clone()).unwrap());
    fs::write(profile.join("identifier-migration.lock"), []).unwrap();
    let root = temp.path().join("root");
    fs::create_dir(&root).unwrap();
    fs::write(root.join("private.html"), b"synthetic source").unwrap();
    let (_, dir) = knowledge::open_root(&root).unwrap();
    let id = knowledge::storage_identity(&root, &dir, "private.html").unwrap();
    let root_id = knowledge::storage_root_identity(&dir).unwrap();
    let data =
        json!({"app":{"schemaVersion":1,"data":{"secret":"SYNTHETIC_PRIVATE_VALUE"}}}).to_string();
    let connection = Connection::open(state.join("state.sqlite")).unwrap();
    connection
        .execute(
            "INSERT INTO documents VALUES(?1,?2,?3,9,?4,'private.html',1)",
            params![id, data, data.len() as i64, root_id],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE quota SET bytes=?1,documents=1,generation=1",
            [data.len() as i64],
        )
        .unwrap();
    drop(connection);
    let mut process = Process::start(&profile, &root);
    let inspect = process.request(json!({"command":"inspect"}));
    assert_eq!(inspect["databaseSchemaVersion"], 1);
    let upgrade = process.request(json!({"command":"prepare_upgrade"}));
    process.confirm(&upgrade);
    let inspect = process.request(json!({"command":"inspect"}));
    assert_eq!(inspect["databaseSchemaVersion"], 2);
    let selected=process.request(json!({"command":"prepare_quarantine","document_identity":id,"snapshot_id":inspect["snapshotId"]}));
    let receipt = process.confirm(&selected);
    assert_eq!(receipt["operation"], "quarantine");
    let inspect = process.request(json!({"command":"inspect"}));
    assert_eq!(inspect["usage"]["records"], 0);
    assert_eq!(inspect["recoveryRecords"], 1);
    process.quit();
    drop(process);
    let mut process = Process::start(&profile, &root);
    let status =
        process.request(json!({"command":"operation_status","operation_id":selected["planId"]}));
    assert_eq!(status["status"], "quarantined");
    let inspect = process.request(json!({"command":"inspect"}));
    let restore=process.request(json!({"command":"prepare_restore","recovery_id":selected["planId"],"snapshot_id":inspect["snapshotId"]}));
    let receipt = process.confirm(&restore);
    assert_eq!(receipt["revision"], 10);
    let list = process.request(json!({"command":"list_recovery"}));
    assert_eq!(list["entries"][0]["status"], "restored");
    process.quit();
    drop(process);
    let connection = Connection::open(state.join("state.sqlite")).unwrap();
    let restored: String = connection
        .query_row("SELECT data FROM documents WHERE id=?1", [id], |r| r.get(0))
        .unwrap();
    assert!(restored == data);
    assert_eq!(
        fs::read(root.join("private.html")).unwrap(),
        b"synthetic source"
    );
    assert_eq!(fs::read_dir(state).unwrap().count(), 1);
}
