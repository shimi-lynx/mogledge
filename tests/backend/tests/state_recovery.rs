use mogledge_backend_tests::{
    core::Core,
    document_server,
    document_state::{self, DocumentState, StateRequest},
};
use serde_json::{json, Value};
use std::{fs, sync::Arc};
use tempfile::TempDir;

struct Fixture {
    root: TempDir,
    _state: TempDir,
    core: Arc<Core>,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        fs::write(
            root.path().join("app.html"),
            "<!doctype html><p>original</p>",
        )
        .unwrap();
        let core = Core::new(19061);
        assert!(core
            .document_state
            .set(DocumentState::new(state.path().to_owned()).unwrap())
            .is_ok());
        core.select(root.path(), false).unwrap();
        core.watcher.lock().unwrap().take();
        Self {
            root,
            _state: state,
            core,
        }
    }
    fn token(&self) -> String {
        let snapshot = self.core.snapshot();
        let workspace = snapshot.workspace_id.unwrap();
        let tab = self
            .core
            .create_tab(&workspace, &snapshot.view_id, "app.html")
            .unwrap();
        let url = self
            .core
            .open(&workspace, &snapshot.view_id, &tab, 1)
            .unwrap();
        document_server::decode_path(url.strip_prefix(&self.core.origin).unwrap())
            .unwrap()
            .0
    }
    fn operation(&self, token: &str, op: &str, value: Option<Value>) -> Value {
        let request: StateRequest =
            serde_json::from_value(json!({"version":1,"op":op,"key":"sample","value":value}))
                .unwrap();
        document_state::operate(&self.core, token, request)
            .unwrap()
            .value
    }
    fn replace(&self) {
        fs::write(
            self.root.path().join("temporary.html"),
            "<!doctype html><p>updated</p>",
        )
        .unwrap();
        fs::remove_file(self.root.path().join("app.html")).unwrap();
        fs::rename(
            self.root.path().join("temporary.html"),
            self.root.path().join("app.html"),
        )
        .unwrap();
    }
    fn recovery(
        &self,
        candidate: Option<&document_state::RecoveryCandidate>,
    ) -> Result<Option<document_state::RecoveryCandidate>, String> {
        let snapshot = self.core.snapshot();
        document_state::recovery(
            &self.core,
            snapshot.workspace_id.as_deref().unwrap(),
            &snapshot.view_id,
            "app.html",
            candidate,
        )
    }
}

#[test]
fn atomic_save_requires_confirmation_and_preserves_source() {
    let fixture = Fixture::new();
    let old = fixture.token();
    let saved = json!({"schemaVersion":1,"data":{"text":"日本語".repeat(120000)}});
    fixture.operation(&old, "write", Some(saved.clone()));
    fixture.replace();
    let current = fixture.token();
    assert!(fixture.operation(&current, "read", None).is_null());
    let candidate = fixture.recovery(None).unwrap().unwrap();
    assert_eq!(candidate.app_count, 1);
    // Merely asking for a candidate does not read/copy the old values into HTML.
    assert!(fixture.operation(&current, "read", None).is_null());
    fixture.recovery(Some(&candidate)).unwrap();
    assert_eq!(fixture.operation(&current, "read", None), saved);
    let rows: i64 = rusqlite::Connection::open(fixture._state.path().join("state.sqlite"))
        .unwrap()
        .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
        .unwrap();
    assert_eq!(rows, 2);
    let database = rusqlite::Connection::open(fixture._state.path().join("state.sqlite")).unwrap();
    let records: Vec<String> = database
        .prepare("SELECT data FROM documents")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        records[0], records[1],
        "Recovery must preserve and duplicate the source record"
    );
    let total: i64 = database
        .query_row("SELECT bytes FROM quota", [], |row| row.get(0))
        .unwrap();
    assert_eq!(total, 2 * records[0].len() as i64);
}

#[test]
fn recovery_rejects_changed_identity_forgery_and_existing_state() {
    let fixture = Fixture::new();
    fixture.operation(&fixture.token(), "write", Some(json!(7)));
    fixture.replace();
    let candidate = fixture.recovery(None).unwrap().unwrap();
    let mut forged = candidate.clone();
    forged.source_revision += 1;
    assert_eq!(
        fixture.recovery(Some(&forged)).unwrap_err(),
        "RecoveryChanged"
    );
    fixture.replace();
    assert_eq!(
        fixture.recovery(Some(&candidate)).unwrap_err(),
        "RecoveryChanged"
    );
    let candidate = fixture.recovery(None).unwrap().unwrap();
    let token = fixture.token();
    fixture.operation(&token, "write", Some(json!(99)));
    assert_eq!(
        fixture.recovery(Some(&candidate)).unwrap_err(),
        "StateConflict"
    );
    assert_eq!(fixture.operation(&token, "read", None), json!(99));
}

#[test]
fn recovery_is_scoped_to_current_workspace_view_and_tree_path() {
    let fixture = Fixture::new();
    let snapshot = fixture.core.snapshot();
    let workspace = snapshot.workspace_id.as_deref().unwrap();
    assert!(fixture.recovery(None).unwrap().is_none());
    assert_eq!(
        document_state::recovery(&fixture.core, "wrong", &snapshot.view_id, "app.html", None)
            .unwrap_err(),
        "WorkspaceChanged"
    );
    assert_eq!(
        document_state::recovery(&fixture.core, workspace, "wrong", "app.html", None).unwrap_err(),
        "ViewChanged"
    );
    for path in ["../app.html", "/app.html", "missing.html"] {
        assert!(
            document_state::recovery(&fixture.core, workspace, &snapshot.view_id, path, None)
                .is_err()
        );
    }
}

#[test]
fn native_rename_tracks_recovery_location_before_next_read() {
    use mogledge_backend_tests::tree_mutations::{self, Mutation};
    let fixture = Fixture::new();
    fixture.operation(&fixture.token(), "write", Some(json!(12)));
    let snapshot = fixture.core.snapshot();
    tree_mutations::perform(
        &fixture.core,
        snapshot.workspace_id.as_deref().unwrap(),
        &snapshot.view_id,
        Mutation::RenameHtml {
            source: "app.html".into(),
            name: "renamed".into(),
        },
    )
    .unwrap();
    fs::write(
        fixture.root.path().join("temporary.html"),
        "<!doctype html><p>new</p>",
    )
    .unwrap();
    fs::remove_file(fixture.root.path().join("renamed.html")).unwrap();
    fs::rename(
        fixture.root.path().join("temporary.html"),
        fixture.root.path().join("renamed.html"),
    )
    .unwrap();
    let candidate = document_state::recovery(
        &fixture.core,
        snapshot.workspace_id.as_deref().unwrap(),
        &snapshot.view_id,
        "renamed.html",
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(candidate.app_count, 1);
    document_state::recovery(
        &fixture.core,
        snapshot.workspace_id.as_deref().unwrap(),
        &snapshot.view_id,
        "renamed.html",
        Some(&candidate),
    )
    .unwrap();
}

#[test]
fn global_quota_failure_preserves_last_acknowledged_state() {
    let fixture = Fixture::new();
    let token = fixture.token();
    fixture.operation(&token, "write", Some(json!(17)));
    let database = rusqlite::Connection::open(fixture._state.path().join("state.sqlite")).unwrap();
    database
        .execute("UPDATE quota SET bytes=536870912", [])
        .unwrap();
    let request: StateRequest =
        serde_json::from_value(json!({"version":1,"op":"write","key":"sample","value":"longer"}))
            .unwrap();
    assert_eq!(
        document_state::operate(&fixture.core, &token, request).unwrap_err(),
        document_state::StateError::QuotaExceeded
    );
    assert_eq!(fixture.operation(&token, "read", None), json!(17));
    fixture.replace();
    let current = fixture.token();
    database
        .execute("UPDATE quota SET bytes=0,documents=4096", [])
        .unwrap();
    let request: StateRequest =
        serde_json::from_value(json!({"version":1,"op":"write","key":"sample","value":1})).unwrap();
    assert_eq!(
        document_state::operate(&fixture.core, &current, request).unwrap_err(),
        document_state::StateError::QuotaExceeded
    );
    assert!(fixture.operation(&current, "read", None).is_null());
}

#[test]
fn recovery_at_total_limit_is_inclusive_and_failure_preserves_source_and_destination() {
    let fixture = Fixture::new();
    fixture.operation(&fixture.token(), "write", Some(json!({"data":"保存値"})));
    fixture.replace();
    let current = fixture.token();
    let candidate = fixture.recovery(None).unwrap().unwrap();
    let database = rusqlite::Connection::open(fixture._state.path().join("state.sqlite")).unwrap();
    let source_bytes: i64 = database
        .query_row("SELECT bytes FROM documents", [], |row| row.get(0))
        .unwrap();
    database
        .execute(
            "UPDATE quota SET bytes=?1",
            [512_i64 * 1024 * 1024 - source_bytes + 1],
        )
        .unwrap();
    assert_eq!(
        fixture.recovery(Some(&candidate)).unwrap_err(),
        "QuotaExceeded"
    );
    assert!(fixture.operation(&current, "read", None).is_null());
    assert_eq!(fixture.recovery(None).unwrap().unwrap(), candidate);
    database
        .execute(
            "UPDATE quota SET bytes=?1",
            [512_i64 * 1024 * 1024 - source_bytes],
        )
        .unwrap();
    fixture.recovery(Some(&candidate)).unwrap();
    assert_eq!(
        fixture.operation(&current, "read", None),
        json!({"data":"保存値"})
    );
    let total: i64 = database
        .query_row("SELECT bytes FROM quota", [], |row| row.get(0))
        .unwrap();
    assert_eq!(total, 512 * 1024 * 1024);
}
