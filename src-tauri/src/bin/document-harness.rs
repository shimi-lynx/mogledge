#[cfg(feature = "e2e")]
#[tokio::main]
async fn main() {
    use mogledge_lib::{core::Core, document_server};
    let root = std::env::args_os().nth(1).expect("Provide a fixture root");
    let entry = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "Examples/Interactive.html".into());
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let core = Core::new(listener.local_addr().unwrap().port());
    let snapshot = core.select(std::path::Path::new(&root), false).unwrap();
    let tab = core
        .create_tab(
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            &entry,
        )
        .unwrap();
    let url = core
        .open(
            snapshot.workspace_id.as_ref().unwrap(),
            &snapshot.view_id,
            &tab,
            1,
        )
        .unwrap();
    // Test harness has its own tiny shell; it never ships with the application.
    let shell_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let shell_port = shell_listener.local_addr().unwrap().port();
    println!(
        "{}",
        serde_json::json!({"documentUrl":url,"origin":core.origin,"shellUrl":format!("http://127.0.0.1:{shell_port}")})
    );
    let shell_core = core.clone();
    let shell_url = url.clone();
    let shell = axum::Router::new().route("/",axum::routing::get(move || {
        let csp = mogledge_lib::shell_csp(&shell_core.origin,false);
        let url = shell_url.clone();
        async move {
            ([(axum::http::header::CONTENT_TYPE,"text/html; charset=utf-8".to_owned()),
              (axum::http::HeaderName::from_static("content-security-policy"),csp)],
             format!("<!doctype html><iframe id=\"document\" sandbox=\"allow-scripts\" referrerpolicy=\"no-referrer\" src=\"{url}\" style=\"width:100%;height:95vh;border:0\"></iframe>"))
        }
    }));
    // In the harness the document CSP's frame-ancestors is rewritten to the exact test-shell origin.
    let app = document_server::router(core).layer(axum::middleware::map_response(
        move |mut response: axum::response::Response| async move {
            if let Some(csp) = response
                .headers()
                .get("content-security-policy")
                .and_then(|v| v.to_str().ok())
            {
                let csp = csp.replace(
                    "frame-ancestors tauri://localhost",
                    &format!("frame-ancestors http://127.0.0.1:{shell_port} tauri://localhost"),
                );
                response
                    .headers_mut()
                    .insert("content-security-policy", csp.parse().unwrap());
            }
            response
        },
    ));
    tokio::select! {
        result = axum::serve(listener,app) => { result.unwrap(); },
        result = axum::serve(shell_listener,shell) => { result.unwrap(); },
    }
}
#[cfg(not(feature = "e2e"))]
fn main() {
    eprintln!("This test harness requires --features e2e");
    std::process::exit(1);
}
