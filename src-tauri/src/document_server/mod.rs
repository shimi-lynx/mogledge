use crate::{core::Core, knowledge};
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header, Method, Request, Response, StatusCode},
    Router,
};
use percent_encoding::percent_decode_str;
use std::sync::Arc;
pub mod admission;
pub mod help;
mod media;
mod storage;

pub fn router(core: Arc<Core>) -> Router {
    Router::new().fallback(handle).with_state(core)
}
pub fn decode_path(raw: &str) -> Option<(String, String)> {
    let mut parts = raw.strip_prefix("/s/")?.split('/');
    let token = parts.next()?.to_owned();
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let path = parts
        .map(|part| {
            percent_decode_str(part)
                .decode_utf8()
                .ok()
                .map(|s| s.into_owned())
        })
        .collect::<Option<Vec<_>>>()?;
    if path.iter().any(|p| p.contains('/')) {
        return None;
    }
    let path = path.join("/");
    knowledge::validate_relative(&path).ok()?;
    Some((token, path))
}
pub fn document_csp(origin: &str, token: &str) -> String {
    let source = format!("{origin}/s/{token}/");
    format!("default-src 'none'; sandbox allow-scripts; script-src 'unsafe-inline' {source}; style-src 'unsafe-inline' {source}; img-src {source} data: blob:; font-src {source} data:; connect-src {source}; media-src {source}; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors tauri://localhost http://tauri.localhost https://tauri.localhost http://127.0.0.1:1420")
}
fn response(
    status: StatusCode,
    bytes: Bytes,
    mime: &str,
    csp: &str,
    cors: bool,
    head: bool,
) -> Response<Body> {
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CONTENT_LENGTH, bytes.len().to_string())
        .header(header::CACHE_CONTROL, "no-store")
        .header("Content-Security-Policy", csp)
        .header("X-Content-Type-Options", "nosniff")
        .header("Referrer-Policy", "no-referrer")
        .header(
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=()",
        );
    if cors {
        // A sandboxed origin is opaque; origin=null alone is not an authentication check.
        // This route requires the unguessable token first. No cookies or credentials.
        response = response.header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    }
    response
        .body(if head {
            Body::empty()
        } else {
            admission::body(bytes)
        })
        .unwrap()
}
fn deny(status: StatusCode, head: bool) -> Response<Body> {
    let mut response = response(
        status,
        Bytes::from_static("このリソースにはアクセスできません".as_bytes()),
        "text/plain; charset=utf-8",
        "default-src 'none'; sandbox",
        false,
        head,
    );
    if status == StatusCode::SERVICE_UNAVAILABLE {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, "1".parse().unwrap());
    }
    response
}
async fn handle(State(core): State<Arc<Core>>, request: Request<Body>) -> Response<Body> {
    if storage::token(request.uri().path()).is_some() {
        return storage::handle(core, request).await;
    }
    let head = request.method() == Method::HEAD;
    if request.method() != Method::GET && !head {
        return deny(StatusCode::METHOD_NOT_ALLOWED, head);
    }
    let expected_host = core.origin.strip_prefix("http://").unwrap();
    if request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        != Some(expected_host)
    {
        return deny(StatusCode::FORBIDDEN, head);
    }
    if let Some(html) = help::html(request.uri().path()) {
        if request.uri().query().is_some() {
            return deny(StatusCode::NOT_FOUND, head);
        }
        return response(
            StatusCode::OK,
            Bytes::from_static(html.as_bytes()),
            "text/html; charset=utf-8",
            help::CSP,
            false,
            head,
        );
    }
    let Some((token, path)) = decode_path(request.uri().path()) else {
        return deny(StatusCode::NOT_FOUND, head);
    };
    let Some(session) = core.session_for_token(&token) else {
        return deny(StatusCode::NOT_FOUND, head);
    };
    let Some(mime) = knowledge::mime(&path) else {
        return deny(StatusCode::FORBIDDEN, head);
    };
    // Only the selected HTML can be navigated to; assets can be shared across knowledge.
    if knowledge::is_html(&path) && path != session.entry {
        return deny(StatusCode::FORBIDDEN, head);
    }
    if matches!(mime, "audio/mpeg" | "video/mp4") {
        return media::handle(core, request, token, path, session, mime).await;
    }
    let Some(mut permit) = core.asset_admission.read(&token).await else {
        return deny(StatusCode::SERVICE_UNAVAILABLE, head);
    };
    let root = session.root.clone();
    let dir = session.dir.clone();
    let entry = knowledge::is_html(&path);
    // A granted HTML identity also protects workspace references without a
    // saved-input DB. Assets and identity-unavailable plain views stay separate.
    let identity = entry && session.storage_identity.is_some();
    let worker_core = core.clone();
    let worker_token = token.clone();
    let data = tokio::task::spawn_blocking(move || {
        // A queued request may have lost its grant. No file read before this
        // recheck; permit travels with the worker if the HTTP future cancels.
        if worker_core.session_for_token(&worker_token).is_none() {
            worker_core.asset_admission.revoked();
            return Err(StatusCode::NOT_FOUND);
        }
        let source = knowledge::read_source_budgeted(&root, &dir, &path, identity, |capacity| {
            permit.reserve_capacity(capacity)
        })
        .map_err(|error| match error {
            knowledge::ReadError::ResourceBusy => StatusCode::SERVICE_UNAVAILABLE,
            knowledge::ReadError::Failed(_) => {
                worker_core.asset_admission.failed_read();
                StatusCode::NOT_FOUND
            }
        })?;
        if worker_core.session_for_token(&worker_token).is_none()
            || (identity && source.storage_identity != session.storage_identity)
        {
            worker_core.asset_admission.revoked();
            return Err(StatusCode::NOT_FOUND);
        }
        let bytes = if entry {
            storage::inject(source.data, &worker_core, &session, &mut permit)
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
        } else {
            source.data
        };
        Ok(permit.response(bytes))
    })
    .await;
    let bytes = match data {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(status)) => return deny(status, head),
        Err(_) => {
            core.asset_admission.worker_failure();
            return deny(StatusCode::SERVICE_UNAVAILABLE, head);
        }
    };
    if core.session_for_token(&token).is_none() {
        return deny(StatusCode::NOT_FOUND, head);
    }
    response(
        StatusCode::OK,
        bytes,
        mime,
        &document_csp(&core.origin, &token),
        true,
        head,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;

    fn assets_fixture() -> (tempfile::TempDir, Arc<Core>, String, String, String) {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("index.html"),
            "<!doctype html><p>assets</p>",
        )
        .unwrap();
        for index in 0..64 {
            let extension = ["css", "js", "mjs", "png", "json"][index % 5];
            std::fs::write(
                root.path().join(format!("asset-{index}.{extension}")),
                [7; 1024],
            )
            .unwrap();
        }
        let core = Core::new(19190);
        let snapshot = core.select(root.path(), false).unwrap();
        let workspace = snapshot.workspace_id.unwrap();
        let tab = core
            .create_tab(&workspace, &snapshot.view_id, "index.html")
            .unwrap();
        let url = core.open(&workspace, &snapshot.view_id, &tab, 1).unwrap();
        let path = url.strip_prefix(&core.origin).unwrap().to_owned();
        (root, core, workspace, tab, path)
    }

    #[tokio::test]
    async fn granted_html_rejects_replacement_even_without_saved_input_db() {
        let (root, core, _workspace, _tab, path) = assets_fixture();
        assert!(core.document_state.get().is_none());
        let response = request(core.clone(), &path, Method::GET, "127.0.0.1:19190").await;
        assert_eq!(response.status(), StatusCode::OK);
        drop(response);
        std::fs::write(root.path().join("replacement.html"), "<p>replacement</p>").unwrap();
        std::fs::rename(
            root.path().join("replacement.html"),
            root.path().join("index.html"),
        )
        .unwrap();
        let response = request(core.clone(), &path, Method::GET, "127.0.0.1:19190").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            serde_json::to_value(core.asset_admission.report()).unwrap()["reservedBytes"],
            0
        );
    }

    #[tokio::test]
    async fn many_small_assets_complete_within_the_bounded_queue_and_release_memory() {
        let (_root, core, _workspace, _tab, path) = assets_fixture();
        let base = path.rsplit_once('/').unwrap().0.to_owned();
        let started = std::time::Instant::now();
        let mut workers = Vec::new();
        for index in 0..64 {
            let core = core.clone();
            let extension = ["css", "js", "mjs", "png", "json"][index % 5];
            let path = format!("{base}/asset-{index}.{extension}");
            workers.push(tokio::spawn(async move {
                let response = request(core, &path, Method::GET, "127.0.0.1:19190").await;
                assert_eq!(response.status(), StatusCode::OK);
                let bytes = axum::body::to_bytes(response.into_body(), 2048)
                    .await
                    .unwrap();
                assert_eq!(bytes.len(), 1024);
            }));
        }
        for worker in workers {
            worker.await.unwrap();
        }
        let report = serde_json::to_value(core.asset_admission.report()).unwrap();
        assert_eq!(report["requests"], 0);
        assert_eq!(report["waiting"], 0);
        assert_eq!(report["reservedBytes"], 0);
        assert!(
            report["peakReservedBytes"].as_u64().unwrap() <= admission::MAX_RETAINED_BYTES as u64
        );
        assert!(report["peakWaiting"].as_u64().unwrap() <= admission::MAX_WAITERS as u64);
        eprintln!(
            "assets_fixture_64_ms={} report={report}",
            started.elapsed().as_millis()
        );
    }

    #[tokio::test]
    async fn invalid_requests_do_not_wait_or_read_under_overload_and_valid_requests_recover() {
        let (_root, core, _workspace, _tab, path) = assets_fixture();
        let held: Vec<_> = (0..admission::MAX_READS)
            .map(|index| {
                core.asset_admission
                    .try_read(&format!("held-{index}"))
                    .unwrap()
            })
            .collect();
        assert_eq!(
            request(core.clone(), &path, Method::GET, "evil.example")
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        let invalid = path.replace(&decode_path(&path).unwrap().0, &"0".repeat(64));
        assert_eq!(
            request(core.clone(), &invalid, Method::GET, "127.0.0.1:19190")
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        let traversal = format!("{}/%2e%2e/a.js", path.rsplit_once('/').unwrap().0);
        assert_eq!(
            request(core.clone(), &traversal, Method::GET, "127.0.0.1:19190")
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        let response = request(core.clone(), &path, Method::GET, "127.0.0.1:19190").await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::RETRY_AFTER], "1");
        assert_eq!(
            serde_json::to_value(core.asset_admission.report()).unwrap()["failedReads"],
            0
        );
        drop(held);
        let response = request(core.clone(), &path, Method::GET, "127.0.0.1:19190").await;
        assert_eq!(response.status(), StatusCode::OK);
        drop(response);
        assert_eq!(
            serde_json::to_value(core.asset_admission.report()).unwrap()["requests"],
            0
        );
    }

    #[tokio::test]
    async fn byte_growth_pressure_returns_retryable_503_and_open_never_retries_busy() {
        let (root, core, workspace, tab, path) = assets_fixture();
        std::fs::write(root.path().join("large.json"), vec![7; 3 * 1024 * 1024]).unwrap();
        let held: Vec<_> = (0..2)
            .map(|index| {
                let mut permit = core
                    .asset_admission
                    .try_read(&format!("held-{index}"))
                    .unwrap();
                permit.reserve_capacity(126 * 1024 * 1024).unwrap();
                permit
            })
            .collect();
        let large = format!("{}/large.json", path.rsplit_once('/').unwrap().0);
        let response = request(core.clone(), &large, Method::GET, "127.0.0.1:19190").await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()[header::RETRY_AFTER], "1");
        std::fs::write(root.path().join("index.html"), vec![b' '; 3 * 1024 * 1024]).unwrap();
        assert_eq!(
            core.open(&workspace, &core.snapshot().view_id, &tab, 2)
                .unwrap_err(),
            "ResourceBusy"
        );
        let report = serde_json::to_value(core.asset_admission.report()).unwrap();
        assert_eq!(report["rejected"], 2); // One HTTP failure and one open attempt.
        assert_eq!(report["failedReads"], 0);
        assert_eq!(report["waiting"], 0);
        assert_eq!(report["requests"], 2);
        drop(held);
        // open revoked the old grant; establish a fresh one after budget release.
        let url = core
            .open(&workspace, &core.snapshot().view_id, &tab, 3)
            .unwrap();
        let large = format!(
            "{}/large.json",
            url.strip_prefix(&core.origin)
                .unwrap()
                .rsplit_once('/')
                .unwrap()
                .0
        );
        assert_eq!(
            request(core.clone(), &large, Method::GET, "127.0.0.1:19190")
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            serde_json::to_value(core.asset_admission.report()).unwrap()["reservedBytes"],
            0
        );
    }

    #[tokio::test]
    async fn queued_revoked_grants_never_start_file_reads() {
        let (_root, core, workspace, tab, path) = assets_fixture();
        let held: Vec<_> = (0..admission::MAX_READS)
            .map(|index| {
                core.asset_admission
                    .try_read(&format!("held-{index}"))
                    .unwrap()
            })
            .collect();
        let worker_core = core.clone();
        let worker = tokio::spawn(async move {
            request(worker_core, &path, Method::GET, "127.0.0.1:19190").await
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while serde_json::to_value(core.asset_admission.report()).unwrap()["waiting"] != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let view = core.snapshot().view_id;
        core.close_tab(&workspace, &view, &tab).unwrap();
        drop(held);
        assert_eq!(worker.await.unwrap().status(), StatusCode::NOT_FOUND);
        let report = serde_json::to_value(core.asset_admission.report()).unwrap();
        assert_eq!(report["requests"], 0);
        assert_eq!(report["failedReads"], 0);
        assert_eq!(report["revoked"], 1);
    }

    #[tokio::test]
    async fn head_matches_injected_get_length_and_releases_its_read_reservation() {
        let (_root, core, _workspace, _tab, path) = assets_fixture();
        let get = request(core.clone(), &path, Method::GET, "127.0.0.1:19190").await;
        let length = get.headers()[header::CONTENT_LENGTH].clone();
        let bytes = axum::body::to_bytes(get.into_body(), 65536).await.unwrap();
        assert_eq!(
            length.to_str().unwrap().parse::<usize>().unwrap(),
            bytes.len()
        );
        assert!(bytes.len() < 1024 * 1024);
        drop(bytes);
        let head = request(core.clone(), &path, Method::HEAD, "127.0.0.1:19190").await;
        assert_eq!(head.headers()[header::CONTENT_LENGTH], length);
        assert!(axum::body::to_bytes(head.into_body(), 1)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            serde_json::to_value(core.asset_admission.report()).unwrap()["reservedBytes"],
            0
        );
    }

    #[tokio::test]
    async fn full_size_asset_transport_slice_is_charged_until_disconnect() {
        use http_body_util::BodyExt;
        let (root, core, _workspace, _tab, path) = assets_fixture();
        let file = std::fs::File::create(root.path().join("large.json")).unwrap();
        file.set_len(knowledge::MAX_SOURCE_BYTES as u64).unwrap();
        drop(file);
        let path = format!("{}/large.json", path.rsplit_once('/').unwrap().0);
        let response = request(core.clone(), &path, Method::GET, "127.0.0.1:19190").await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            knowledge::MAX_SOURCE_BYTES.to_string()
        );
        let mut body = response.into_body();
        let frame = body.frame().await.unwrap().unwrap().into_data().unwrap();
        assert_eq!(frame.len(), 64 * 1024);
        drop(body);
        let report = serde_json::to_value(core.asset_admission.report()).unwrap();
        assert_eq!(report["requests"], 1);
        assert_eq!(report["responseBytes"], knowledge::MAX_SOURCE_BYTES);
        drop(frame);
        assert_eq!(
            serde_json::to_value(core.asset_admission.report()).unwrap()["reservedBytes"],
            0
        );
    }

    #[tokio::test]
    async fn usage_is_not_an_http_or_document_storage_operation() {
        let (_root, core, _workspace, _tab, path) = assets_fixture();
        let endpoint = format!("{}/get_asset_usage", path.rsplit_once('/').unwrap().0);
        assert_eq!(
            request(core.clone(), &endpoint, Method::GET, "127.0.0.1:19190")
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(core, &endpoint, Method::POST, "127.0.0.1:19190")
                .await
                .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    #[tokio::test]
    async fn assets_pressure_does_not_consume_storage_post_admission() {
        let (_root, core, workspace, tab, _path) = assets_fixture();
        let state = tempfile::tempdir().unwrap();
        assert!(core
            .document_state
            .set(crate::document_state::DocumentState::new(state.path().to_owned()).unwrap())
            .is_ok());
        let url = core
            .open(&workspace, &core.snapshot().view_id, &tab, 2)
            .unwrap();
        let path = url.strip_prefix(&core.origin).unwrap();
        let endpoint = format!("{}/{}", path.rsplit_once('/').unwrap().0, storage::ENDPOINT);
        let held: Vec<_> = (0..admission::MAX_READS)
            .map(|index| {
                core.asset_admission
                    .try_read(&format!("held-{index}"))
                    .unwrap()
            })
            .collect();
        let store = core.document_state.get().unwrap();
        assert_eq!(store.request_slots.available_permits(), 4);
        for (operation, expected) in [
            ("read", StatusCode::OK),
            ("get_asset_usage", StatusCode::BAD_REQUEST),
        ] {
            let response = router(core.clone())
                .oneshot(
                    Request::builder()
                        .uri(&endpoint)
                        .method(Method::POST)
                        .header(header::HOST, "127.0.0.1:19190")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(format!(
                            "{{\"version\":1,\"op\":\"{operation}\",\"key\":\"fixture\"}}"
                        )))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected);
            drop(response);
        }
        assert_eq!(store.request_slots.available_permits(), 4);
        drop(held);
    }

    #[test]
    fn synchronous_open_rejects_shared_budget_pressure_without_waiting_on_gate() {
        let (_root, core, workspace, tab, _path) = assets_fixture();
        let view = core.snapshot().view_id;
        let held: Vec<_> = (0..admission::MAX_READS)
            .map(|index| {
                core.asset_admission
                    .try_read(&format!("held-{index}"))
                    .unwrap()
            })
            .collect();
        let _gate = core.gate.lock().unwrap();
        assert_eq!(
            core.open_locked(&workspace, &view, &tab, 2).unwrap_err(),
            "ResourceBusy"
        );
        drop(held);
        core.open_locked(&workspace, &view, &tab, 3).unwrap();
    }
    async fn request(core: Arc<Core>, path: &str, method: Method, host: &str) -> Response<Body> {
        router(core)
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
    async fn server_enforces_boundaries_and_revocation() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("index.html"), "<h1>ok</h1>").unwrap();
        std::fs::write(tmp.path().join("other.html"), "other").unwrap();
        std::fs::write(tmp.path().join("data.json"), "{}").unwrap();
        std::fs::write(tmp.path().join("secret.txt"), "secret").unwrap();
        let core = Core::new(12345);
        let snapshot = core.select(tmp.path(), false).unwrap();
        let workspace = snapshot.workspace_id.as_ref().unwrap();
        let tab = core
            .create_tab(workspace, &snapshot.view_id, "index.html")
            .unwrap();
        let url = core.open(workspace, &snapshot.view_id, &tab, 1).unwrap();
        let path = url.strip_prefix(&core.origin).unwrap();
        let result = request(core.clone(), path, Method::GET, "127.0.0.1:12345").await;
        assert_eq!(result.status(), StatusCode::OK);
        assert!(result.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("sandbox allow-scripts"));
        assert!(!result.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("allow-same-origin"));
        assert_eq!(result.headers()["access-control-allow-origin"], "*");
        assert!(!result
            .headers()
            .contains_key("access-control-allow-credentials"));
        let body = axum::body::to_bytes(result.into_body(), 65536)
            .await
            .unwrap();
        let delivered = std::str::from_utf8(&body).unwrap();
        let (token, _) = decode_path(path).unwrap();
        assert!(delivered.contains("my-knowledge-move-tab-v1"));
        assert!(delivered.contains(&format!("const token = \"{token}\";")));
        assert!(!delivered.contains("__MY_KNOWLEDGE_KEYBOARD_TOKEN__"));
        assert!(delivered.ends_with("<h1>ok</h1>"));
        assert_eq!(
            std::fs::read_to_string(tmp.path().join("index.html")).unwrap(),
            "<h1>ok</h1>"
        );
        assert_eq!(
            request(core.clone(), path, Method::POST, "127.0.0.1:12345")
                .await
                .status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
        assert_eq!(
            request(core.clone(), path, Method::GET, "evil.example")
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        let base = path.rsplit_once('/').unwrap().0;
        assert_eq!(
            request(
                core.clone(),
                &format!("{base}/data.json"),
                Method::GET,
                "127.0.0.1:12345"
            )
            .await
            .status(),
            StatusCode::OK
        );
        assert_eq!(
            request(
                core.clone(),
                &format!("{base}/secret.txt"),
                Method::GET,
                "127.0.0.1:12345"
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(
                core.clone(),
                &format!("{base}/other.html"),
                Method::GET,
                "127.0.0.1:12345"
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(
                core.clone(),
                &format!("{base}/%2e%2e/index.html"),
                Method::GET,
                "127.0.0.1:12345"
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request(
                core.clone(),
                &format!("{base}/x%2findex.html"),
                Method::GET,
                "127.0.0.1:12345"
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        core.open(workspace, &snapshot.view_id, &tab, 2).unwrap();
        assert_eq!(
            request(core, path, Method::GET, "127.0.0.1:12345")
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    #[tokio::test]
    async fn tabs_have_independent_grants_and_close_revokes_only_its_owner() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["a.html", "b.html", "data.json"] {
            std::fs::write(tmp.path().join(name), "{}").unwrap();
        }
        let core = Core::new(12346);
        let snapshot = core.select(tmp.path(), false).unwrap();
        let workspace = snapshot.workspace_id.as_ref().unwrap();
        let a = core
            .create_tab(workspace, &snapshot.view_id, "a.html")
            .unwrap();
        let b = core
            .create_tab(workspace, &snapshot.view_id, "b.html")
            .unwrap();
        let a_url = core.open(workspace, &snapshot.view_id, &a, 1).unwrap();
        let b_url = core.open(workspace, &snapshot.view_id, &b, 1).unwrap();
        let a_path = a_url.strip_prefix(&core.origin).unwrap();
        let b_path = b_url.strip_prefix(&core.origin).unwrap();
        for path in [a_path, b_path] {
            assert_eq!(
                request(core.clone(), path, Method::GET, "127.0.0.1:12346")
                    .await
                    .status(),
                StatusCode::OK
            );
        }
        let a_base = a_path.rsplit_once('/').unwrap().0;
        assert_eq!(
            request(
                core.clone(),
                &format!("{a_base}/b.html"),
                Method::GET,
                "127.0.0.1:12346"
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        core.open(workspace, &snapshot.view_id, &b, 2).unwrap();
        assert_eq!(
            request(core.clone(), a_path, Method::GET, "127.0.0.1:12346")
                .await
                .status(),
            StatusCode::OK
        );
        core.close_tab(workspace, &snapshot.view_id, &a).unwrap();
        assert_eq!(
            request(core.clone(), a_path, Method::GET, "127.0.0.1:12346")
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request(
                core.clone(),
                &format!("{a_base}/data.json"),
                Method::GET,
                "127.0.0.1:12346"
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
        let reopened = core
            .create_tab(workspace, &snapshot.view_id, "a.html")
            .unwrap();
        core.open(workspace, &snapshot.view_id, &reopened, 1)
            .unwrap();
        assert_eq!(
            request(core.clone(), a_path, Method::GET, "127.0.0.1:12346")
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        core.begin_view();
        assert!(core.workspace.lock().unwrap().tabs.is_empty());
    }
}
