use axum::{
    body::Body,
    http::{header, Method, Request, Response, StatusCode},
};
use http_body_util::BodyExt;
use mogledge_backend_tests::{
    core::Core,
    document_server,
    document_state::{self, DocumentState, StateError, StateRequest, StateResponse},
    tree_mutations::{self, Mutation},
};
use serde_json::{json, Value};
use std::{fs, sync::Arc};
use tempfile::TempDir;
use tower::ServiceExt;

const ENDPOINT: &str = "__mogledge_storage_v1__";
// Exercise removal of the old transport cap without allocating SQLite's full capacity.
const LEGACY_REQUEST_FIXTURE_BYTES: usize = 8 * 1024 * 1024 + 1024;

struct Fixture {
    root: TempDir,
    state: TempDir,
    core: Arc<Core>,
}

struct Grant {
    workspace: String,
    view: String,
    tab: String,
    token: String,
    path: String,
}

fn core_with_state(root: &std::path::Path, state: &std::path::Path, port: u16) -> Arc<Core> {
    let core = Core::new(port);
    assert!(core
        .document_state
        .set(DocumentState::new(state.to_owned()).unwrap())
        .is_ok());
    core.select(root, false).unwrap();
    core.watcher.lock().unwrap().take();
    core
}

impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        for name in ["a.html", "b.html"] {
            fs::write(
                root.path().join(name),
                "<!doctype html><html><body><script>window.example=1;</script></body></html>",
            )
            .unwrap();
        }
        fs::create_dir(root.path().join("Folder")).unwrap();
        let core = core_with_state(root.path(), state.path(), 19060);
        Self { root, state, core }
    }

    fn grant(&self, entry: &str) -> Grant {
        grant(&self.core, entry)
    }

    fn rows(&self) -> i64 {
        rusqlite::Connection::open(self.state.path().join("state.sqlite"))
            .unwrap()
            .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
            .unwrap()
    }
}

fn grant(core: &Core, entry: &str) -> Grant {
    let snapshot = core.snapshot();
    let workspace = snapshot.workspace_id.unwrap();
    let view = snapshot.view_id;
    let tab = core.create_tab(&workspace, &view, entry).unwrap();
    let url = core.open(&workspace, &view, &tab, 1).unwrap();
    let path = url.strip_prefix(&core.origin).unwrap().to_owned();
    let (token, _) = document_server::decode_path(&path).unwrap();
    assert!(core
        .session_for_token(&token)
        .unwrap()
        .storage_identity
        .is_some());
    Grant {
        workspace,
        view,
        tab,
        token,
        path,
    }
}

fn operation(
    core: &Core,
    token: &str,
    op: &str,
    key: &str,
    value: Option<Value>,
) -> Result<StateResponse, StateError> {
    let mut request = json!({"version":1,"op":op,"key":key});
    if let Some(value) = value {
        request["value"] = value;
    }
    document_state::operate(core, token, serde_json::from_value(request).unwrap())
}

fn read(core: &Core, token: &str, key: &str) -> StateResponse {
    operation(core, token, "read", key, None).unwrap()
}

fn write(core: &Core, token: &str, key: &str, value: Value) -> StateResponse {
    operation(core, token, "write", key, Some(value)).unwrap()
}

async fn http(
    core: Arc<Core>,
    path: &str,
    method: Method,
    headers: &[(&str, &str)],
    body: Vec<u8>,
) -> Response<Body> {
    let mut request = Request::builder().uri(path).method(method);
    for (name, value) in headers {
        request = request.header(*name, *value);
    }
    if !headers
        .iter()
        .any(|(name, _)| name.eq_ignore_ascii_case("host"))
    {
        request = request.header(header::HOST, core.origin.strip_prefix("http://").unwrap());
    }
    document_server::router(core)
        .oneshot(request.body(Body::from(body)).unwrap())
        .await
        .unwrap()
}

async fn body_json(response: Response<Body>) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

fn endpoint(token: &str) -> String {
    format!("/s/{token}/{ENDPOINT}")
}

#[test]
fn document_keys_are_isolated_and_acknowledged_state_survives_restart() {
    let fixture = Fixture::new();
    let a = fixture.grant("a.html");
    let b = fixture.grant("b.html");
    let original = fs::read(fixture.root.path().join("a.html")).unwrap();
    assert!(read(&fixture.core, &a.token, "sample").value.is_null());
    assert_eq!(
        fixture.rows(),
        0,
        "An empty read must not allocate document state"
    );
    let saved = json!({"schemaVersion":1,"data":{"number":42,"selected":"one","checked":true}});
    assert_eq!(
        write(&fixture.core, &a.token, "sample", saved.clone()).revision,
        1
    );
    assert!(read(&fixture.core, &b.token, "sample").value.is_null());
    write(
        &fixture.core,
        &b.token,
        "sample",
        json!({"schemaVersion":1,"data":false}),
    );
    assert_eq!(read(&fixture.core, &a.token, "sample").value, saved);
    assert_eq!(
        fs::read(fixture.root.path().join("a.html")).unwrap(),
        original
    );

    let Fixture { root, state, core } = fixture;
    drop(core);
    let restarted = core_with_state(root.path(), state.path(), 19061);
    let reopened = grant(&restarted, "a.html");
    assert_ne!(a.token, reopened.token);
    assert_eq!(read(&restarted, &reopened.token, "sample").value, saved);
    assert_eq!(read(&restarted, &reopened.token, "sample").revision, 1);
    assert_eq!(
        operation(&restarted, &a.token, "read", "sample", None)
            .expect_err("request should fail")
            .code(),
        "Revoked"
    );
}

#[test]
fn native_rename_and_move_retain_state_but_recreated_old_path_is_separate() {
    let fixture = Fixture::new();
    let first = fixture.grant("a.html");
    write(&fixture.core, &first.token, "sample", json!({"data":17}));
    tree_mutations::perform(
        &fixture.core,
        &first.workspace,
        &first.view,
        Mutation::RenameHtml {
            source: "a.html".into(),
            name: "renamed".into(),
        },
    )
    .unwrap();
    assert_eq!(
        operation(&fixture.core, &first.token, "read", "sample", None)
            .expect_err("request should fail")
            .code(),
        "Revoked"
    );
    let renamed = fixture.grant("renamed.html");
    assert_eq!(
        read(&fixture.core, &renamed.token, "sample").value,
        json!({"data":17})
    );
    tree_mutations::perform(
        &fixture.core,
        &renamed.workspace,
        &renamed.view,
        Mutation::Move {
            source: "renamed.html".into(),
            parent: "Folder".into(),
            anchor: None,
            after: false,
        },
    )
    .unwrap();
    assert_eq!(
        operation(
            &fixture.core,
            &renamed.token,
            "write",
            "sample",
            Some(json!(99))
        )
        .expect_err("request should fail")
        .code(),
        "Revoked"
    );
    fs::write(
        fixture.root.path().join("a.html"),
        "<!doctype html><p>new document</p>",
    )
    .unwrap();
    fixture.core.refresh().unwrap();
    fixture.core.watcher.lock().unwrap().take();
    let moved = fixture.grant("Folder/renamed.html");
    let recreated = fixture.grant("a.html");
    assert_eq!(
        read(&fixture.core, &moved.token, "sample").value,
        json!({"data":17})
    );
    assert!(read(&fixture.core, &recreated.token, "sample")
        .value
        .is_null());
}

#[tokio::test]
async fn file_replacement_rejects_old_grant_and_copy_has_independent_state() {
    let fixture = Fixture::new();
    let old = fixture.grant("a.html");
    write(&fixture.core, &old.token, "sample", json!({"data":"old"}));
    fs::write(
        fixture.root.path().join("replacement.html"),
        "<!doctype html><p>replacement</p>",
    )
    .unwrap();
    // Remove then rename works on Windows too, while keeping the new file's identity.
    fs::remove_file(fixture.root.path().join("a.html")).unwrap();
    fs::rename(
        fixture.root.path().join("replacement.html"),
        fixture.root.path().join("a.html"),
    )
    .unwrap();
    assert_eq!(
        operation(&fixture.core, &old.token, "read", "sample", None)
            .expect_err("request should fail")
            .code(),
        "IdentityChanged"
    );
    assert_eq!(
        operation(&fixture.core, &old.token, "write", "sample", Some(json!(2)))
            .expect_err("request should fail")
            .code(),
        "IdentityChanged"
    );
    let html = http(fixture.core.clone(), &old.path, Method::GET, &[], vec![]).await;
    assert_eq!(html.status(), StatusCode::NOT_FOUND);
    let replaced = fixture.grant("a.html");
    assert!(read(&fixture.core, &replaced.token, "sample")
        .value
        .is_null());
    write(
        &fixture.core,
        &replaced.token,
        "sample",
        json!({"data":"new"}),
    );
    fs::copy(
        fixture.root.path().join("a.html"),
        fixture.root.path().join("copy.html"),
    )
    .unwrap();
    fixture.core.refresh().unwrap();
    fixture.core.watcher.lock().unwrap().take();
    let copied = fixture.grant("copy.html");
    assert!(read(&fixture.core, &copied.token, "sample").value.is_null());
    assert_eq!(
        read(&fixture.core, &replaced.token, "sample").value,
        json!({"data":"new"})
    );
}

#[test]
fn external_same_root_rename_restores_only_after_reopen() {
    let fixture = Fixture::new();
    let old = fixture.grant("a.html");
    write(&fixture.core, &old.token, "sample", json!(23));
    fs::rename(
        fixture.root.path().join("a.html"),
        fixture.root.path().join("external.html"),
    )
    .unwrap();
    assert_eq!(
        operation(&fixture.core, &old.token, "read", "sample", None)
            .expect_err("request should fail")
            .code(),
        "IdentityChanged"
    );
    fixture.core.apply_change(
        &old.workspace,
        vec!["a.html".into(), "external.html".into()],
        true,
        None,
    );
    assert_eq!(
        operation(&fixture.core, &old.token, "read", "sample", None)
            .expect_err("request should fail")
            .code(),
        "Revoked"
    );
    let reopened = fixture.grant("external.html");
    assert_eq!(
        read(&fixture.core, &reopened.token, "sample").value,
        json!(23)
    );
}

#[cfg(unix)]
#[test]
fn replacing_root_at_same_path_cannot_inherit_state() {
    let fixture = Fixture::new();
    let old = fixture.grant("a.html");
    write(&fixture.core, &old.token, "sample", json!(7));
    let parent = tempfile::tempdir().unwrap();
    fs::rename(fixture.root.path(), parent.path().join("previous-root")).unwrap();
    fs::create_dir(fixture.root.path()).unwrap();
    fs::write(
        fixture.root.path().join("a.html"),
        "<!doctype html><p>different root</p>",
    )
    .unwrap();
    assert_eq!(
        operation(&fixture.core, &old.token, "read", "sample", None)
            .expect_err("request should fail")
            .code(),
        "IdentityChanged"
    );
    fixture.core.select(fixture.root.path(), false).unwrap();
    fixture.core.watcher.lock().unwrap().take();
    let current = fixture.grant("a.html");
    assert!(read(&fixture.core, &current.token, "sample")
        .value
        .is_null());
}

#[test]
fn lifecycle_revokes_grants_without_losing_acknowledged_state() {
    let fixture = Fixture::new();
    let first = fixture.grant("a.html");
    write(&fixture.core, &first.token, "sample", json!(8));
    fixture
        .core
        .close_tab(&first.workspace, &first.view, &first.tab)
        .unwrap();
    assert_eq!(
        operation(
            &fixture.core,
            &first.token,
            "write",
            "sample",
            Some(json!(9))
        )
        .expect_err("request should fail")
        .code(),
        "Revoked"
    );
    let reopened = fixture.grant("a.html");
    assert_eq!(
        read(&fixture.core, &reopened.token, "sample").value,
        json!(8)
    );
    fixture
        .core
        .open(&reopened.workspace, &reopened.view, &reopened.tab, 2)
        .unwrap();
    assert_eq!(
        operation(&fixture.core, &reopened.token, "read", "sample", None)
            .expect_err("request should fail")
            .code(),
        "Revoked"
    );
    let before_view = fixture.grant("a.html");
    fixture.core.begin_view();
    assert_eq!(
        operation(&fixture.core, &before_view.token, "read", "sample", None)
            .expect_err("request should fail")
            .code(),
        "Revoked"
    );
    let before_root = fixture.grant("a.html");
    let other = tempfile::tempdir().unwrap();
    fs::write(
        other.path().join("a.html"),
        "<!doctype html><p>other root</p>",
    )
    .unwrap();
    fixture.core.select(other.path(), false).unwrap();
    fixture.core.watcher.lock().unwrap().take();
    assert_eq!(
        operation(&fixture.core, &before_root.token, "read", "sample", None)
            .expect_err("request should fail")
            .code(),
        "Revoked"
    );
    let other_grant = fixture.grant("a.html");
    assert!(read(&fixture.core, &other_grant.token, "sample")
        .value
        .is_null());
}

#[test]
fn index_rebuild_keeps_document_state_and_live_grant() {
    let fixture = Fixture::new();
    let cache = tempfile::tempdir().unwrap();
    assert!(fixture
        .core
        .index
        .set(mogledge_backend_tests::index::IndexService::new(cache.path().to_owned()).unwrap())
        .is_ok());
    fixture.core.select(fixture.root.path(), false).unwrap();
    fixture.core.watcher.lock().unwrap().take();
    let current = fixture.grant("a.html");
    write(&fixture.core, &current.token, "sample", json!({"data":31}));
    mogledge_backend_tests::index::api::rebuild(&fixture.core, &current.workspace).unwrap();
    assert_eq!(
        read(&fixture.core, &current.token, "sample").value,
        json!({"data":31})
    );
    assert_eq!(read(&fixture.core, &current.token, "sample").revision, 1);
}

#[test]
fn failed_browser_dispatch_revokes_its_grant_and_preserves_ui_state() {
    let fixture = Fixture::new();
    let ui = fixture.grant("a.html");
    write(&fixture.core, &ui.token, "sample", json!(19));
    let mut browser_token = None;
    let result = mogledge_backend_tests::file_actions::perform(
        &fixture.core,
        &ui.workspace,
        &ui.view,
        "a.html",
        mogledge_backend_tests::file_actions::FileAction::OpenBrowser,
        |target| {
            let path = target.target.strip_prefix(&fixture.core.origin).unwrap();
            browser_token = Some(document_server::decode_path(path).unwrap().0);
            Err("Simulated browser dispatch failure".into())
        },
    );
    assert!(result.is_err());
    let token = browser_token.expect("Browser dispatch must receive a narrow document URL");
    assert_eq!(
        operation(&fixture.core, &token, "write", "sample", Some(json!(20)))
            .expect_err("request should fail")
            .code(),
        "Revoked"
    );
    assert_eq!(read(&fixture.core, &ui.token, "sample").value, json!(19));
    assert_eq!(fixture.core.workspace.lock().unwrap().tabs.len(), 1);
}

#[test]
fn queued_write_checks_revocation_after_acquiring_lifecycle_gate() {
    let fixture = Fixture::new();
    let current = fixture.grant("a.html");
    let gate = fixture.core.gate.lock().unwrap();
    let writer_core = fixture.core.clone();
    let token = current.token.clone();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        done_tx
            .send(operation(&writer_core, &token, "write", "sample", Some(json!(1))).map(|_| ()))
            .unwrap();
    });
    started_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    // Model the tab removal performed by a lifecycle operation already holding
    // the shared gate. The pending request must authorize only after this point.
    fixture
        .core
        .workspace
        .lock()
        .unwrap()
        .tabs
        .remove(&current.tab);
    drop(gate);
    assert_eq!(
        done_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .expect_err("request should fail")
            .code(),
        "Revoked"
    );
    writer.join().unwrap();
    assert_eq!(
        fixture.rows(),
        0,
        "A revoked queued write must not allocate state"
    );
}

#[test]
fn quotas_reject_changes_atomically_and_delete_releases_app_capacity() {
    let fixture = Fixture::new();
    let current = fixture.grant("a.html");
    for index in 0..128 {
        write(
            &fixture.core,
            &current.token,
            &format!("app-{index}"),
            json!(index),
        );
    }
    assert_eq!(
        operation(
            &fixture.core,
            &current.token,
            "write",
            "overflow",
            Some(json!(1))
        )
        .expect_err("request should fail")
        .code(),
        "QuotaExceeded"
    );
    assert_eq!(read(&fixture.core, &current.token, "app-0").revision, 128);
    assert_eq!(read(&fixture.core, &current.token, "app-0").value, json!(0));
    let deleted = operation(&fixture.core, &current.token, "delete", "app-0", None).unwrap();
    assert!(deleted.value.is_null());
    assert_eq!(deleted.revision, 129);
    assert_eq!(
        operation(&fixture.core, &current.token, "delete", "absent", None)
            .unwrap()
            .revision,
        129
    );
    assert_eq!(
        write(&fixture.core, &current.token, "overflow", json!(3)).revision,
        130
    );
    let prior = read(&fixture.core, &current.token, "overflow");
    assert_eq!(
        operation(
            &fixture.core,
            &current.token,
            "write",
            "overflow",
            Some(json!("x".repeat(document_state::MAX_DOCUMENT_BYTES)))
        )
        .expect_err("request should fail")
        .code(),
        "QuotaExceeded"
    );
    let after = read(&fixture.core, &current.token, "overflow");
    assert_eq!(after.value, prior.value);
    assert_eq!(after.revision, prior.revision);
}

#[test]
fn document_size_limit_counts_serialized_map_and_is_inclusive() {
    let fixture = Fixture::new();
    let current = fixture.grant("a.html");
    let overhead = serde_json::to_vec(&json!({"sample":""})).unwrap().len();
    let fitting = json!("x".repeat(document_state::MAX_DOCUMENT_BYTES - overhead));
    assert_eq!(
        write(&fixture.core, &current.token, "sample", fitting.clone()).revision,
        1
    );
    assert_eq!(
        operation(
            &fixture.core,
            &current.token,
            "write",
            "sample",
            Some(json!(
                "x".repeat(document_state::MAX_DOCUMENT_BYTES - overhead + 1)
            ))
        )
        .expect_err("request should fail")
        .code(),
        "QuotaExceeded"
    );
    assert_eq!(read(&fixture.core, &current.token, "sample").value, fitting);
    assert_eq!(read(&fixture.core, &current.token, "sample").revision, 1);
}

fn sized_envelope(key: &str, bytes: usize) -> Value {
    let overhead = serde_json::to_vec(&json!({key: {"schemaVersion":1,"data":""}}))
        .unwrap()
        .len();
    let pattern = "日本語\"\\\n";
    let pattern_bytes = serde_json::to_string(pattern).unwrap().len() - 2;
    let remaining = bytes - overhead;
    let text = pattern.repeat(remaining / pattern_bytes) + &"x".repeat(remaining % pattern_bytes);
    let envelope = json!({"schemaVersion":1,"data":text});
    assert_eq!(
        serde_json::to_vec(&json!({key: &envelope})).unwrap().len(),
        bytes
    );
    envelope
}

#[tokio::test]
async fn utf8_escaped_envelope_at_five_mib_survives_http_views_and_restart() {
    let fixture = Fixture::new();
    let first = fixture.grant("a.html");
    let second = fixture.grant("a.html");
    let key = "k".repeat(80);
    let saved = sized_envelope(&key, 5 * 1024 * 1024);
    let body =
        serde_json::to_vec(&json!({"version":1,"op":"write","key":key,"value":saved})).unwrap();
    assert!(body.len() > document_state::MAX_DOCUMENT_BYTES);
    assert!(body.len() < LEGACY_REQUEST_FIXTURE_BYTES);
    let accepted = http(
        fixture.core.clone(),
        &endpoint(&first.token),
        Method::POST,
        &[("Content-Type", "application/json")],
        body,
    )
    .await;
    assert_eq!(accepted.status(), StatusCode::OK);
    assert_eq!(body_json(accepted).await["value"], saved);
    assert_eq!(read(&fixture.core, &second.token, &key).value, saved);
    let too_large = sized_envelope(&key, document_state::MAX_DOCUMENT_BYTES + 1);
    let body =
        serde_json::to_vec(&json!({"version":1,"op":"write","key":key,"value":too_large})).unwrap();
    assert_eq!(
        http(
            fixture.core.clone(),
            &endpoint(&first.token),
            Method::POST,
            &[("Content-Type", "application/json")],
            body
        )
        .await
        .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    // A second appId cannot exceed the physical-document aggregate either.
    assert_eq!(
        operation(
            &fixture.core,
            &second.token,
            "write",
            "other",
            Some(json!(1))
        )
        .unwrap_err(),
        StateError::QuotaExceeded
    );
    assert_eq!(read(&fixture.core, &first.token, &key).revision, 1);
    let Fixture { root, state, core } = fixture;
    drop(core);
    let restarted = core_with_state(root.path(), state.path(), 19062);
    let reopened = grant(&restarted, "a.html");
    assert_eq!(read(&restarted, &reopened.token, &key).value, saved);
    assert_eq!(read(&restarted, &reopened.token, &key).revision, 1);
}

#[tokio::test]
async fn http_accepts_bodies_above_the_legacy_budget_without_trusting_length_headers() {
    let fixture = Fixture::new();
    let current = fixture.grant("a.html");
    write(&fixture.core, &current.token, "sample", json!(42));
    let mut body = serde_json::to_vec(&json!({"version":1,"op":"read","key":"sample"})).unwrap();
    // This is the previous 8MiB envelope budget, not the current technical cap.
    body.resize(LEGACY_REQUEST_FIXTURE_BYTES, b' ');
    assert_eq!(
        http(
            fixture.core.clone(),
            &endpoint(&current.token),
            Method::POST,
            &[("Content-Type", "application/json")],
            body.clone()
        )
        .await
        .status(),
        StatusCode::OK
    );
    body.push(b' ');
    for headers in [
        vec![("Content-Type", "application/json")],
        vec![
            ("Content-Type", "application/json"),
            ("Content-Length", "1"),
        ],
        vec![
            ("Content-Type", "application/json"),
            ("Transfer-Encoding", "chunked"),
        ],
    ] {
        assert_eq!(
            http(
                fixture.core.clone(),
                &endpoint(&current.token),
                Method::POST,
                &headers,
                body.clone()
            )
            .await
            .status(),
            StatusCode::OK
        );
    }
    assert_eq!(
        read(&fixture.core, &current.token, "sample").value,
        json!(42)
    );
    assert_eq!(read(&fixture.core, &current.token, "sample").revision, 1);
}

#[tokio::test]
async fn actual_chunked_http_accepts_above_legacy_budget_and_preserves_saved_state() {
    let fixture = Fixture::new();
    let current = fixture.grant("a.html");
    write(&fixture.core, &current.token, "sample", json!(42));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let router = document_server::router(fixture.core.clone());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    for excess in [0, 1] {
        let path = endpoint(&current.token);
        let host = fixture
            .core
            .origin
            .strip_prefix("http://")
            .unwrap()
            .to_owned();
        let status = tokio::task::spawn_blocking(move || {
            use std::io::{Read, Write};
            let mut client = std::net::TcpStream::connect(address).unwrap();
            client.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
            write!(client, "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n").unwrap();
            let mut data = serde_json::to_vec(&json!({"version":1,"op":"read","key":"sample"})).unwrap();
            data.resize(LEGACY_REQUEST_FIXTURE_BYTES + excess, b' ');
            for chunk in data.chunks(16384) {
                write!(client, "{:x}\r\n", chunk.len()).unwrap();
                client.write_all(chunk).unwrap();
                client.write_all(b"\r\n").unwrap();
            }
            client.write_all(b"0\r\n\r\n").unwrap();
            let mut response = String::new();
            client.read_to_string(&mut response).unwrap();
            response.lines().next().unwrap().to_owned()
        }).await.unwrap();
        assert!(status.contains("200"), "{status}");
    }
    server.abort();
    assert_eq!(
        read(&fixture.core, &current.token, "sample").value,
        json!(42)
    );
    assert_eq!(read(&fixture.core, &current.token, "sample").revision, 1);
}

#[test]
fn global_quota_counts_update_and_delete_deltas_at_512_mib_without_large_fixture() {
    let fixture = Fixture::new();
    let current = fixture.grant("a.html");
    write(&fixture.core, &current.token, "sample", json!("x"));
    let database = rusqlite::Connection::open(fixture.state.path().join("state.sqlite")).unwrap();
    // Model the other documents in the quota ledger, without writing 512MiB.
    // Per-document bytes and production transaction/delta logic remain real.
    database
        .execute("UPDATE quota SET bytes=?1", [512_i64 * 1024 * 1024 - 1])
        .unwrap();
    write(&fixture.core, &current.token, "sample", json!("xx"));
    let quota = || {
        database
            .query_row("SELECT bytes FROM quota", [], |row| row.get::<_, i64>(0))
            .unwrap()
    };
    assert_eq!(quota(), 512 * 1024 * 1024);
    assert_eq!(
        operation(
            &fixture.core,
            &current.token,
            "write",
            "sample",
            Some(json!("xxx"))
        )
        .unwrap_err(),
        StateError::QuotaExceeded
    );
    assert_eq!(read(&fixture.core, &current.token, "sample").revision, 2);
    assert_eq!(
        read(&fixture.core, &current.token, "sample").value,
        json!("xx")
    );
    write(&fixture.core, &current.token, "sample", json!("x"));
    assert_eq!(quota(), 512 * 1024 * 1024 - 1);
    operation(&fixture.core, &current.token, "delete", "sample", None).unwrap();
    assert_eq!(quota(), 512 * 1024 * 1024 - 13);
    assert_eq!(
        fixture.rows(),
        1,
        "Deleting the last app keeps its identity/revision record"
    );
}

#[test]
fn request_schema_has_no_document_path_sql_or_native_command_controls() {
    for request in [
        json!({"version":1,"op":"read","key":"sample","documentId":"another"}),
        json!({"version":1,"op":"read","key":"sample","path":"../b.html"}),
        json!({"version":1,"op":"write","key":"sample","value":1,"sql":"DELETE FROM documents"}),
        json!({"version":1,"op":"read","key":"sample","command":"invoke"}),
        json!({"version":1,"op":"execute","key":"sample"}),
    ] {
        assert!(serde_json::from_value::<StateRequest>(request).is_err());
    }
    let fixture = Fixture::new();
    let current = fixture.grant("a.html");
    for key in [
        "",
        "../b.html",
        "folder/key",
        "key with space",
        "日本語",
        &"x".repeat(81),
    ] {
        assert_eq!(
            operation(&fixture.core, &current.token, "write", key, Some(json!(1)))
                .expect_err("request should fail")
                .code(),
            "InvalidRequest"
        );
    }
    for request in [
        json!({"version":2,"op":"write","key":"sample","value":1}),
        json!({"version":1,"op":"write","key":"sample"}),
        json!({"version":1,"op":"write","key":"sample","value":null}),
        json!({"version":1,"op":"read","key":"sample","value":1}),
        json!({"version":1,"op":"delete","key":"sample","value":1}),
    ] {
        assert_eq!(
            document_state::operate(
                &fixture.core,
                &current.token,
                serde_json::from_value(request).unwrap()
            )
            .expect_err("request should fail")
            .code(),
            "InvalidRequest"
        );
    }
    let allowed = "x".repeat(80);
    write(&fixture.core, &current.token, &allowed, json!(1));
    assert_eq!(
        read(&fixture.core, &current.token, &allowed).value,
        json!(1)
    );
}

#[tokio::test]
async fn http_validates_host_origin_method_media_type_and_json_body() {
    let fixture = Fixture::new();
    let current = fixture.grant("a.html");
    let path = endpoint(&current.token);
    let read_body = serde_json::to_vec(&json!({"version":1,"op":"read","key":"sample"})).unwrap();
    let headers = [("Content-Type", "application/json"), ("Origin", "null")];
    let accepted = http(
        fixture.core.clone(),
        &path,
        Method::POST,
        &headers,
        read_body.clone(),
    )
    .await;
    assert_eq!(accepted.status(), StatusCode::OK);
    assert_eq!(
        accepted.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        "null"
    );
    assert!(!accepted
        .headers()
        .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
    assert_eq!(accepted.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(
        body_json(accepted).await,
        json!({"version":1,"value":null,"revision":0})
    );
    for method in [Method::GET, Method::HEAD, Method::PUT, Method::DELETE] {
        assert_eq!(
            http(
                fixture.core.clone(),
                &path,
                method,
                &headers,
                read_body.clone()
            )
            .await
            .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }
    for bad_headers in [
        vec![
            ("Content-Type", "application/json"),
            ("Origin", "https://example.invalid"),
        ],
        vec![
            ("Content-Type", "application/json"),
            ("Host", "localhost:19060"),
        ],
        vec![
            ("Content-Type", "application/json"),
            ("Host", "127.0.0.1:19061"),
        ],
    ] {
        assert_eq!(
            http(
                fixture.core.clone(),
                &path,
                Method::POST,
                &bad_headers,
                read_body.clone()
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    for bad_headers in [vec![], vec![("Content-Type", "text/plain")]] {
        assert_eq!(
            http(
                fixture.core.clone(),
                &path,
                Method::POST,
                &bad_headers,
                read_body.clone()
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        http(
            fixture.core.clone(),
            &format!("{path}?path=b.html"),
            Method::POST,
            &headers,
            read_body.clone()
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        http(
            fixture.core.clone(),
            &path,
            Method::POST,
            &headers,
            vec![b' '; LEGACY_REQUEST_FIXTURE_BYTES + 1]
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    // Bytes above the old policy cap reach JSON validation. Empty whitespace
    // is invalid JSON; the smaller collector fixture tests the technical cap.
    assert_eq!(fixture.rows(), 0);
    fixture
        .core
        .close_tab(&current.workspace, &current.view, &current.tab)
        .unwrap();
    let revoked = http(
        fixture.core.clone(),
        &path,
        Method::POST,
        &headers,
        read_body,
    )
    .await;
    assert_eq!(revoked.status(), StatusCode::FORBIDDEN);
    assert_eq!(body_json(revoked).await["error"], "Revoked");
}

#[tokio::test]
async fn cors_preflight_requires_a_live_grant_and_only_json_post() {
    let fixture = Fixture::new();
    let current = fixture.grant("a.html");
    let path = endpoint(&current.token);
    let valid = [
        ("Origin", "null"),
        ("Access-Control-Request-Method", "POST"),
        ("Access-Control-Request-Headers", "content-type"),
    ];
    let response = http(fixture.core.clone(), &path, Method::OPTIONS, &valid, vec![]).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        "null"
    );
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
        "POST"
    );
    assert_eq!(
        response.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS],
        "Content-Type"
    );
    assert!(!response
        .headers()
        .contains_key(header::ACCESS_CONTROL_ALLOW_CREDENTIALS));
    assert!(!response
        .headers()
        .contains_key("Access-Control-Allow-Private-Network"));
    for invalid in [
        vec![("Origin", "null")],
        vec![("Origin", "null"), ("Access-Control-Request-Method", "GET")],
        vec![
            ("Origin", "null"),
            ("Access-Control-Request-Method", "POST"),
            (
                "Access-Control-Request-Headers",
                "Content-Type, X-Native-Command",
            ),
        ],
    ] {
        assert_eq!(
            http(
                fixture.core.clone(),
                &path,
                Method::OPTIONS,
                &invalid,
                vec![]
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        http(
            fixture.core.clone(),
            &endpoint(&"0".repeat(64)),
            Method::OPTIONS,
            &valid,
            vec![]
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    fixture.core.begin_view();
    assert_eq!(
        http(fixture.core.clone(), &path, Method::OPTIONS, &valid, vec![])
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn served_descriptor_preserves_sandbox_and_original_document() {
    let fixture = Fixture::new();
    let current = fixture.grant("a.html");
    let original = fs::read(fixture.root.path().join("a.html")).unwrap();
    let response = http(
        fixture.core.clone(),
        &current.path,
        Method::GET,
        &[],
        vec![],
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let csp = response.headers()["Content-Security-Policy"]
        .to_str()
        .unwrap();
    assert!(csp.contains("sandbox allow-scripts"));
    assert!(!csp.contains("allow-same-origin"));
    assert!(csp.contains("worker-src 'none'"));
    let served = String::from_utf8(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec(),
    )
    .unwrap();
    assert!(served.starts_with("<!doctype html><script>"));
    assert!(served.contains("__MOGLEDGE_STORAGE_V1__"));
    assert!(served.contains("Object.freeze("));
    assert!(served.contains("writable:false,configurable:false"));
    assert!(served.contains("\"available\":true"));
    assert!(served.contains(&endpoint(&current.token)));
    assert!(
        served.find("__MOGLEDGE_STORAGE_V1__").unwrap() < served.find("window.example=1").unwrap()
    );
    assert!(!served.contains(fixture.state.path().to_str().unwrap()));
    assert_eq!(
        fs::read(fixture.root.path().join("a.html")).unwrap(),
        original
    );
}
