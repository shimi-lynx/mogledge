use axum::{
    body::{Body, Bytes},
    http::{header, Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use mogledge_backend_tests::{core::Core, document_server, knowledge};
use std::{
    io::{Seek, SeekFrom, Write},
    sync::Arc,
};
use tower::ServiceExt;

struct Fixture {
    root: tempfile::TempDir,
    core: Arc<Core>,
    path: String,
    workspace: String,
    view: String,
    tab: String,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(
        root.path().join("index.html"),
        "<!doctype html><p>media</p>",
    )
    .unwrap();
    let core = Core::new(19190);
    let snapshot = core.select(root.path(), false).unwrap();
    let workspace = snapshot.workspace_id.unwrap();
    let view = snapshot.view_id;
    let tab = core.create_tab(&workspace, &view, "index.html").unwrap();
    let url = core.open(&workspace, &view, &tab, 1).unwrap();
    Fixture {
        root,
        path: url
            .strip_prefix(&core.origin)
            .unwrap()
            .rsplit_once('/')
            .unwrap()
            .0
            .to_owned()
            + "/",
        core,
        workspace,
        view,
        tab,
    }
}
async fn request(
    f: &Fixture,
    filename: &str,
    method: Method,
    ranges: &[&str],
) -> axum::response::Response {
    let mut request = Request::builder()
        .uri(format!("{}{filename}", f.path))
        .method(method)
        .header(header::HOST, "127.0.0.1:19190");
    for range in ranges {
        request = request.header(header::RANGE, *range);
    }
    document_server::router(f.core.clone())
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap()
}
fn usage(f: &Fixture) -> serde_json::Value {
    serde_json::to_value(f.core.asset_admission.report()).unwrap()
}
async fn body(response: axum::response::Response) -> Bytes {
    axum::body::to_bytes(
        response.into_body(),
        knowledge::media::MAX_WINDOW_BYTES + 64,
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn small_media_mime_head_and_csp_use_only_the_token_asset_origin() {
    let f = fixture();
    for (name, mime) in [("音 空白.MP3", "audio/mpeg"), ("clip.mp4", "video/mp4")] {
        std::fs::write(f.root.path().join(name), b"fixture media").unwrap();
        let encoded =
            percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC)
                .to_string();
        let response = request(&f, &encoded, Method::GET, &[]).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], mime);
        assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "13");
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(body(response).await.as_ref(), b"fixture media");
        let response = request(&f, &encoded, Method::HEAD, &["bytes=3-4"]).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "13");
        assert_eq!(response.headers()[header::CONTENT_TYPE], mime);
        assert!(!response.headers().contains_key(header::CONTENT_RANGE));
        assert!(body(response).await.is_empty());
    }
    let response = request(&f, "index.html", Method::GET, &[]).await;
    let csp = response.headers()["content-security-policy"]
        .to_str()
        .unwrap();
    assert!(csp.contains(&format!("media-src {}{};", f.core.origin, f.path)));
    let media_policy = csp
        .split(';')
        .find(|part| part.trim_start().starts_with("media-src "))
        .unwrap();
    assert!(!media_policy.contains("blob:") && !media_policy.contains("data:"));
    drop(response);
    assert_eq!(usage(&f)["requests"], 0);
}

#[tokio::test]
async fn one_gib_sparse_media_reads_only_finite_ranges_and_preserves_start() {
    let f = fixture();
    let initial_document_reads = usage(&f)["peakReads"].clone();
    let mut file = std::fs::File::create(f.root.path().join("large.mp4")).unwrap();
    file.set_len(knowledge::media::MAX_MEDIA_BYTES).unwrap();
    file.seek(SeekFrom::Start(123)).unwrap();
    file.write_all(b"prefix").unwrap();
    file.seek(SeekFrom::End(-6)).unwrap();
    file.write_all(b"suffix").unwrap();
    for (range, expected_header, expected_length, prefix) in [
        (
            "bytes=123-128",
            "bytes 123-128/1073741824",
            6,
            Some(&b"prefix"[..]),
        ),
        (
            "bytes=-6",
            "bytes 1073741818-1073741823/1073741824",
            6,
            Some(&b"suffix"[..]),
        ),
        (
            "bytes=123-",
            "bytes 123-2097274/1073741824",
            2097152,
            Some(&b"prefix"[..]),
        ),
        (
            "bytes=123-9999999",
            "bytes 123-2097274/1073741824",
            2097152,
            Some(&b"prefix"[..]),
        ),
        (
            "bytes=-9999999",
            "bytes 1071644672-1073741823/1073741824",
            2097152,
            None,
        ),
        (
            "bytes=1073741818-9999999999",
            "bytes 1073741818-1073741823/1073741824",
            6,
            Some(&b"suffix"[..]),
        ),
    ] {
        let response = request(&f, "large.mp4", Method::GET, &[range]).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{range}");
        assert_eq!(response.headers()[header::CONTENT_RANGE], expected_header);
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            expected_length.to_string()
        );
        let bytes = body(response).await;
        assert_eq!(bytes.len(), expected_length);
        if let Some(prefix) = prefix {
            assert!(bytes.starts_with(prefix));
        }
        drop(bytes);
        assert_eq!(usage(&f)["reservedBytes"], 0);
    }
    assert!(usage(&f)["peakReservedBytes"].as_u64().unwrap() <= 2097152);
    assert_eq!(usage(&f)["peakReads"], initial_document_reads);
    assert_eq!(usage(&f)["peakMediaReads"], 1);
    assert_eq!(
        request(&f, "large.mp4", Method::GET, &[]).await.status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let response = request(&f, "large.mp4", Method::HEAD, &["bytes=0-1"]).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_LENGTH], "1073741824");
    assert!(body(response).await.is_empty());
    file.set_len(knowledge::media::MAX_MEDIA_BYTES + 1).unwrap();
    assert_eq!(
        request(&f, "large.mp4", Method::GET, &["bytes=0-1"])
            .await
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test]
async fn invalid_multipart_duplicate_and_overflow_ranges_are_416() {
    let f = fixture();
    std::fs::write(f.root.path().join("clip.mp4"), b"0123456789").unwrap();
    for ranges in [
        vec!["bytes=10-"],
        vec!["bytes=4-3"],
        vec!["bytes=-0"],
        vec!["bytes=-"],
        vec!["bytes=0-1,4-5"],
        vec!["bytes=18446744073709551616-"],
        vec!["bytes=0-1", "bytes=2-3"],
        vec!["bytes=+0-1"],
    ] {
        let response = request(&f, "clip.mp4", Method::GET, &ranges).await;
        assert_eq!(
            response.status(),
            StatusCode::RANGE_NOT_SATISFIABLE,
            "{ranges:?}"
        );
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */10");
    }
    let response = request(&f, "clip.mp4", Method::GET, &["items=0-1"]).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(body(response).await.as_ref(), b"0123456789");
    std::fs::write(f.root.path().join("empty.mp3"), []).unwrap();
    assert!(body(request(&f, "empty.mp3", Method::GET, &[]).await)
        .await
        .is_empty());
    assert_eq!(
        request(&f, "empty.mp3", Method::GET, &["bytes=0-"])
            .await
            .status(),
        StatusCode::RANGE_NOT_SATISFIABLE
    );
}

#[tokio::test]
async fn media_does_not_occupy_document_read_slots_and_retained_slices_hold_its_quota() {
    let f = fixture();
    std::fs::write(f.root.path().join("clip.mp4"), vec![7; 200000]).unwrap();
    let doc_permits: Vec<_> = (0..8)
        .map(|index| {
            f.core
                .asset_admission
                .try_read(&format!("doc-{index}"))
                .unwrap()
        })
        .collect();
    let mut first = request(&f, "clip.mp4", Method::GET, &["bytes=0-"])
        .await
        .into_body();
    let second = request(&f, "clip.mp4", Method::GET, &["bytes=0-"]).await;
    assert_eq!(second.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(usage(&f)["reads"], 8);
    assert_eq!(usage(&f)["mediaRequests"], 2);
    assert_eq!(
        request(&f, "clip.mp4", Method::GET, &["bytes=0-"])
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let chunk = first.frame().await.unwrap().unwrap().into_data().unwrap();
    assert_eq!(chunk.len(), 65536);
    drop(first);
    drop(second);
    assert_eq!(usage(&f)["mediaRequests"], 1);
    drop(chunk);
    assert_eq!(usage(&f)["mediaRequests"], 0);
    drop(doc_permits);
    assert_eq!(usage(&f)["reservedBytes"], 0);
}

#[tokio::test]
async fn close_and_root_switch_revoke_prepared_media_bodies_and_future_requests() {
    for close in [true, false] {
        let f = fixture();
        std::fs::write(f.root.path().join("clip.mp4"), vec![7; 200000]).unwrap();
        let mut response = request(&f, "clip.mp4", Method::GET, &["bytes=0-"])
            .await
            .into_body();
        let chunk = response
            .frame()
            .await
            .unwrap()
            .unwrap()
            .into_data()
            .unwrap();
        if close {
            f.core.close_tab(&f.workspace, &f.view, &f.tab).unwrap();
        } else {
            let root = tempfile::tempdir().unwrap();
            f.core.select(root.path(), false).unwrap();
        }
        assert!(response.frame().await.unwrap().is_err());
        assert_eq!(
            request(&f, "clip.mp4", Method::GET, &["bytes=0-"])
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        drop(response);
        drop(chunk);
        assert_eq!(usage(&f)["reservedBytes"], 0);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn traversal_symlinks_and_physical_root_replacement_are_denied() {
    let f = fixture();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.mp3"), b"secret").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.mp3"),
        f.root.path().join("linked.mp3"),
    )
    .unwrap();
    for path in [
        "linked.mp3",
        "%2e%2e/secret.mp3",
        "assets%2fsecret.mp3",
        "assets%5csecret.mp3",
        "other.html",
        "song.wav",
    ] {
        let status = request(&f, path, Method::GET, &["bytes=0-1"])
            .await
            .status();
        assert!(
            status == StatusCode::NOT_FOUND || status == StatusCode::FORBIDDEN,
            "{path}"
        );
    }
    let parent = f.root.path().parent().unwrap();
    let displaced = tempfile::tempdir_in(parent).unwrap();
    std::fs::remove_dir(displaced.path()).unwrap();
    std::fs::rename(f.root.path(), displaced.path()).unwrap();
    std::fs::create_dir(f.root.path()).unwrap();
    std::fs::write(f.root.path().join("clip.mp4"), b"replacement").unwrap();
    assert_eq!(
        request(&f, "clip.mp4", Method::GET, &["bytes=0-1"])
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "Requires Chromium; production HTTP + portable HTML, no Native WebView"]
async fn chromium_standard_audio_video_range_and_clicked_timer_are_portable() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let core = Core::new(listener.local_addr().unwrap().port());
    let root = tempfile::tempdir().unwrap();
    let fixture_path = std::path::Path::new(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/local-media"
    ));
    for name in ["index.html", "tone.mp3", "clip.mp4"] {
        std::fs::copy(fixture_path.join(name), root.path().join(name)).unwrap();
    }
    // A valid ISO BMFF free box makes the MP4 exceed one response window,
    // preserving the small playable sample and moov offsets unchanged.
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(root.path().join("clip.mp4"))
        .unwrap();
    let padding = 3 * 1024 * 1024u32;
    file.write_all(&padding.to_be_bytes()).unwrap();
    file.write_all(b"free").unwrap();
    let length = file.metadata().unwrap().len();
    file.set_len(length + u64::from(padding - 8)).unwrap();
    drop(file);
    let snapshot = core.select(root.path(), false).unwrap();
    let workspace = snapshot.workspace_id.unwrap();
    let tab = core
        .create_tab(&workspace, &snapshot.view_id, "index.html")
        .unwrap();
    let url = core.open(&workspace, &snapshot.view_id, &tab, 1).unwrap();
    let origin = core.origin.clone();
    let app = core.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, document_server::router(app))
            .await
            .unwrap();
    });
    let root_path = root.path().to_owned();
    let status = tokio::task::spawn_blocking(move || {
        std::process::Command::new("node")
            .arg("tests/media-production.mjs")
            .env("MEDIA_DOCUMENT_ORIGIN", origin)
            .env("MEDIA_DOCUMENT_URL", url)
            .env("MEDIA_FIXTURE_ROOT", root_path)
            .current_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
            .status()
            .unwrap()
    })
    .await
    .unwrap();
    server.abort();
    assert!(status.success());
    assert_eq!(
        serde_json::to_value(core.asset_admission.report()).unwrap()["reads"],
        0
    );
}

#[test]
fn guarded_media_read_rejects_replacement_and_cancels_between_small_chunks() {
    let f = fixture();
    let path = f.root.path().join("clip.mp4");
    std::fs::write(&path, vec![7; 200000]).unwrap();
    let (_, dir) = knowledge::open_root(f.root.path()).unwrap();
    let info = knowledge::media::inspect(f.root.path(), &dir, "clip.mp4").unwrap();
    let mut calls = 0;
    let result = knowledge::media::read_window(
        f.root.path(),
        &dir,
        "clip.mp4",
        &info,
        knowledge::media::Window {
            start: 0,
            length: 200000,
        },
        |_| Ok(()),
        || {
            calls += 1;
            calls < 3
        },
    );
    assert!(result.is_err());
    assert_eq!(calls, 3);
    std::fs::write(f.root.path().join("replacement.mp4"), vec![8; 200000]).unwrap();
    std::fs::rename(f.root.path().join("replacement.mp4"), &path).unwrap();
    let result = knowledge::media::read_window(
        f.root.path(),
        &dir,
        "clip.mp4",
        &info,
        knowledge::media::Window {
            start: 0,
            length: 2,
        },
        |_| Ok(()),
        || true,
    );
    assert!(result.is_err());
}

#[tokio::test]
async fn if_range_without_a_strong_validator_uses_the_bounded_full_response() {
    let f = fixture();
    std::fs::write(f.root.path().join("clip.mp4"), b"0123456789").unwrap();
    let response = document_server::router(f.core.clone())
        .oneshot(
            Request::builder()
                .uri(format!("{}clip.mp4", f.path))
                .header(header::HOST, "127.0.0.1:19190")
                .header(header::RANGE, "bytes=3-4")
                .header(header::IF_RANGE, "\"unknown\"")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!response.headers().contains_key(header::CONTENT_RANGE));
    assert_eq!(body(response).await.as_ref(), b"0123456789");
}

#[cfg(unix)]
#[tokio::test]
async fn fifo_head_get_and_replacement_are_rejected_without_waiting_for_a_writer() {
    let f = fixture();
    let fifo = f.root.path().join("pipe.mp3");
    mogledge_backend_tests::test_fixtures::create_fifo(&fifo, 0o600).unwrap();
    for method in [Method::HEAD, Method::GET] {
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            request(&f, "pipe.mp3", method, &["bytes=0-1"]),
        )
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        drop(response);
        assert_eq!(usage(&f)["mediaRequests"], 0);
        assert_eq!(usage(&f)["reservedBytes"], 0);
    }
    let path = f.root.path().join("clip.mp4");
    std::fs::write(&path, b"original bytes").unwrap();
    let (_, dir) = knowledge::open_root(f.root.path()).unwrap();
    let info = knowledge::media::inspect(f.root.path(), &dir, "clip.mp4").unwrap();
    let result = knowledge::media::read_window(
        f.root.path(),
        &dir,
        "clip.mp4",
        &info,
        knowledge::media::Window {
            start: 0,
            length: 2,
        },
        |_| {
            // Switch the relative leaf after the guarded regular handle is
            // opened. The final reopen must neither block nor accept the FIFO.
            std::fs::rename(&path, f.root.path().join("displaced.mp4")).unwrap();
            mogledge_backend_tests::test_fixtures::create_fifo(&path, 0o600).unwrap();
            Ok(())
        },
        || true,
    );
    assert!(result.is_err());
}
