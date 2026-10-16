//! Same HTTP fixture can run on the pre-admission source for a bounded comparison.
use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
};
use mogledge_backend_tests::{core::Core, document_server};
use std::time::Instant;
use tower::ServiceExt;

#[tokio::test]
async fn assets_load_64_small_resources() {
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
    let core = Core::new(19192);
    let snapshot = core.select(root.path(), false).unwrap();
    let workspace = snapshot.workspace_id.unwrap();
    let tab = core
        .create_tab(&workspace, &snapshot.view_id, "index.html")
        .unwrap();
    let url = core.open(&workspace, &snapshot.view_id, &tab, 1).unwrap();
    let path = url.strip_prefix(&core.origin).unwrap();
    let base = path.rsplit_once('/').unwrap().0;
    for sample in 0..3 {
        let started = Instant::now();
        let mut workers = Vec::new();
        for index in 0..64 {
            let router = document_server::router(core.clone());
            let extension = ["css", "js", "mjs", "png", "json"][index % 5];
            let path = format!("{base}/asset-{index}.{extension}");
            workers.push(tokio::spawn(async move {
                let response = router
                    .oneshot(
                        Request::builder()
                            .uri(path)
                            .header(header::HOST, "127.0.0.1:19192")
                            .body(Body::empty())
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                let bytes = to_bytes(response.into_body(), 2048).await.unwrap();
                assert_eq!(bytes.len(), 1024);
            }));
        }
        for worker in workers {
            worker.await.unwrap();
        }
        eprintln!(
            "assets_load_64_sample_{sample}_ms={}",
            started.elapsed().as_millis()
        );
    }
}
