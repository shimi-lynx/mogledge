use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use my_knowledge_backend_tests::{
    core::Core,
    document_server::{self, help},
};
use std::sync::Arc;
use tower::ServiceExt;

async fn request(
    core: Arc<Core>,
    path: &str,
    method: Method,
    host: &str,
) -> axum::response::Response {
    document_server::router(core)
        .oneshot(
            Request::builder()
                .uri(path)
                .method(method)
                .header(header::HOST, host)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn builtin_help_is_identical_before_selection_and_after_different_deep_roots() {
    let core = Core::new(19190);
    let roots = tempfile::tempdir().unwrap();
    let mut expected = Vec::new();
    for root in [
        None,
        Some("別フォルダー"),
        Some("日本語 空白/深い/フォルダー/root 空白"),
    ] {
        if let Some(root) = root {
            let root = roots.path().join(root);
            std::fs::create_dir_all(&root).unwrap();
            // Even same-named user files cannot replace the compiled-in help.
            std::fs::write(root.join("ja.html"), "<p>wrong user help</p>").unwrap();
            core.select(&root, false).unwrap();
        }
        assert_eq!(core.snapshot().document_origin, core.origin);
        for (index, path) in [help::JA_PATH, help::EN_PATH].iter().enumerate() {
            let response = request(core.clone(), path, Method::GET, "127.0.0.1:19190").await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[header::CONTENT_TYPE],
                "text/html; charset=utf-8"
            );
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
            assert_eq!(response.headers()["content-security-policy"], help::CSP);
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
            assert_eq!(response.headers()["referrer-policy"], "no-referrer");
            assert!(!response
                .headers()
                .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN));
            let body = axum::body::to_bytes(response.into_body(), 65536)
                .await
                .unwrap();
            assert_eq!(body.as_ref(), help::html(path).unwrap().as_bytes());
            let html = std::str::from_utf8(&body).unwrap();
            assert!(!html.contains("<script"));
            assert!(!html.contains("__MY_KNOWLEDGE"));
            assert!(!html.contains("storageDescriptor"));
            if expected.len() < 2 {
                expected.push(body);
            } else {
                assert_eq!(body, expected[index]);
            }
        }
    }
}

#[tokio::test]
async fn builtin_help_rejects_wrong_host_method_path_and_query_without_document_grants() {
    let core = Core::new(19190);
    for (path, method, host, status) in [
        (
            help::JA_PATH,
            Method::GET,
            "evil.example",
            StatusCode::FORBIDDEN,
        ),
        (
            help::JA_PATH,
            Method::POST,
            "127.0.0.1:19190",
            StatusCode::METHOD_NOT_ALLOWED,
        ),
        (
            "/__app/help/ja.html?x=1",
            Method::GET,
            "127.0.0.1:19190",
            StatusCode::NOT_FOUND,
        ),
        (
            "/__app/help/fr.html",
            Method::GET,
            "127.0.0.1:19190",
            StatusCode::NOT_FOUND,
        ),
        (
            "/__app/help/%6aa.html",
            Method::GET,
            "127.0.0.1:19190",
            StatusCode::NOT_FOUND,
        ),
        (
            "/s/0000000000000000000000000000000000000000000000000000000000000000/ja.html",
            Method::GET,
            "127.0.0.1:19190",
            StatusCode::NOT_FOUND,
        ),
    ] {
        assert_eq!(
            request(core.clone(), path, method, host).await.status(),
            status
        );
    }
    let response = request(core, help::EN_PATH, Method::HEAD, "127.0.0.1:19190").await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CONTENT_LENGTH],
        help::html(help::EN_PATH).unwrap().len().to_string()
    );
    assert!(axum::body::to_bytes(response.into_body(), 1)
        .await
        .unwrap()
        .is_empty());
}

#[test]
fn both_native_navigation_guards_use_the_builtin_help_allowlist() {
    let navigation = include_str!("../../../src-tauri/src/navigation.rs");
    let app = include_str!("../../../src-tauri/src/lib.rs");
    assert!(navigation.contains("document_server::help::allowed_url(&core.origin, url.as_str()) || document_allowed(core, url)"));
    assert!(navigation.contains("is_some_and(|url| frame_allowed(&core, &url))"));
    assert!(app.contains("navigation::frame_allowed(&navigation_core, url)"));
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "Requires production dist and Chromium; run explicitly after npm run build"]
async fn compiled_ui_displays_native_builtin_help_under_production_csp() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let core = Core::new(listener.local_addr().unwrap().port());
    let fixture = tempfile::tempdir().unwrap();
    std::fs::write(fixture.path().join("index.html"), "<!doctype html><html lang=\"ja\"><body><label>Retained input<input></label><canvas width=\"2\" height=\"2\"></canvas><script>window.retainedState={count:7};const ctx=document.querySelector('canvas').getContext('2d');ctx.fillStyle='#33aa55';ctx.fillRect(0,0,2,2)</script></body></html>").unwrap();
    let snapshot = core.select(fixture.path(), false).unwrap();
    let workspace = snapshot.workspace_id.unwrap();
    let tab = core
        .create_tab(&workspace, &snapshot.view_id, "index.html")
        .unwrap();
    let document_url = core.open(&workspace, &snapshot.view_id, &tab, 1).unwrap();
    let origin = core.origin.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, document_server::router(core))
            .await
            .unwrap()
    });
    let status = tokio::task::spawn_blocking(move || {
        std::process::Command::new("node")
            .arg("tests/help-production.mjs")
            .env("HELP_DOCUMENT_ORIGIN", origin)
            .env("HELP_USER_DOCUMENT_URL", document_url)
            .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
            .status()
            .unwrap()
    })
    .await
    .unwrap();
    server.abort();
    assert!(status.success());
}
