//! Opt-in real TCP smoke; run alone so Linux RSS belongs to this fixture.
#![cfg(target_os = "linux")]

use mogledge_backend_tests::{core::Core, document_server, knowledge};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    sync::Arc,
    time::Duration,
};

fn usage(core: &Core) -> Value {
    serde_json::to_value(core.asset_admission.report()).unwrap()
}

fn memory() -> Value {
    let status = std::fs::read_to_string("/proc/self/smaps_rollup").unwrap();
    let bytes = |field: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(field))
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            * 1024
    };
    json!({"rssBytes": bytes("Rss:")})
}

async fn open(address: SocketAddr, path: String) -> (String, TcpStream) {
    tokio::task::spawn_blocking(move || {
        let mut client = TcpStream::connect_timeout(&address, Duration::from_secs(5)).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        client
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            client,
            "GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        // Read headers only: no client Vec can hide retained server bytes or
        // inflate the RSS observation with a second full response allocation.
        let mut headers = Vec::new();
        while !headers.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            client.read_exact(&mut byte).unwrap();
            headers.push(byte[0]);
            assert!(headers.len() <= 4096);
        }
        (String::from_utf8(headers).unwrap(), client)
    })
    .await
    .unwrap()
}

async fn wait_released(core: &Core) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let report = usage(core);
            if report["requests"] == 0 && report["reservedBytes"] == 0 {
                assert_eq!(report["reads"], 0);
                assert_eq!(report["waiting"], 0);
                assert_eq!(report["responseBytes"], 0);
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn small_resource(address: SocketAddr, path: String) {
    let (headers, mut client) = open(address, path).await;
    assert!(headers.starts_with("HTTP/1.1 200"));
    tokio::task::spawn_blocking(move || {
        let mut body = [0; 1024];
        client.read_exact(&mut body).unwrap();
        assert_eq!(body, [7; 1024]);
        assert_eq!(client.read(&mut [0]).unwrap(), 0);
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "isolated real TCP/RSS smoke; invoke this exact test explicitly"]
async fn slow_asset_tcp_holds_bytes_until_disconnect_and_recovers() {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join("index.html"), "<!doctype html><p>tcp</p>").unwrap();
    std::fs::write(root.path().join("small.css"), [7; 1024]).unwrap();
    // A sparse synthetic file needs no fixture-sized client allocation. Its
    // 32 MiB payload also exceeds ordinary loopback send queues when unread.
    std::fs::File::create(root.path().join("large.json"))
        .unwrap()
        .set_len(knowledge::MAX_SOURCE_BYTES as u64)
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let core = Core::new(address.port());
    let snapshot = core.select(root.path(), false).unwrap();
    let workspace = snapshot.workspace_id.unwrap();
    let tab = core
        .create_tab(&workspace, &snapshot.view_id, "index.html")
        .unwrap();
    let url = core.open(&workspace, &snapshot.view_id, &tab, 1).unwrap();
    let base = url
        .strip_prefix(&core.origin)
        .unwrap()
        .rsplit_once('/')
        .unwrap()
        .0
        .to_owned();
    let router = document_server::router(Arc::clone(&core));
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let before = memory();
    let (headers, mut slow) = open(address, format!("{base}/large.json")).await;
    assert!(headers.starts_with("HTTP/1.1 200"));
    assert!(headers.to_ascii_lowercase().contains(&format!(
        "\r\ncontent-length: {}\r\n",
        knowledge::MAX_SOURCE_BYTES
    )));
    let assert_held = || {
        let report = usage(&core);
        assert_eq!(report["requests"], 1);
        assert_eq!(report["reads"], 0);
        assert_eq!(report["reservedBytes"], knowledge::MAX_SOURCE_BYTES);
        assert_eq!(report["responseBytes"], knowledge::MAX_SOURCE_BYTES);
    };
    assert_held();
    let held = memory();
    // This is an explicit negative-invariant observation window, not a sleep
    // used to guess that an asynchronous read or disconnect has finished.
    let mut observations = tokio::time::interval(Duration::from_millis(10));
    for _ in 0..11 {
        observations.tick().await;
        assert_held();
    }
    slow = tokio::task::spawn_blocking(move || {
        let mut chunk = [1; 64 * 1024];
        slow.read_exact(&mut chunk).unwrap();
        assert_eq!(chunk, [0; 64 * 1024]);
        slow
    })
    .await
    .unwrap();
    assert_held();
    // A stalled large response occupies bytes but no read worker or lifecycle
    // gate, and a normal small asset must still finish over another real socket.
    small_resource(address, format!("{base}/small.css")).await;
    assert!(core.gate.try_lock().is_ok());
    assert_held();
    core.close_tab(&workspace, &snapshot.view_id, &tab).unwrap();
    let (headers, invalid) = open(address, format!("{base}/small.css")).await;
    assert!(headers.starts_with("HTTP/1.1 404"));
    drop(invalid);
    assert_held(); // Grant revocation cannot release an in-flight allocation.
    drop(slow);
    wait_released(&core).await;
    let released = memory();
    let tab = core
        .create_tab(&workspace, &snapshot.view_id, "index.html")
        .unwrap();
    let url = core.open(&workspace, &snapshot.view_id, &tab, 1).unwrap();
    let base = url
        .strip_prefix(&core.origin)
        .unwrap()
        .rsplit_once('/')
        .unwrap()
        .0;
    small_resource(address, format!("{base}/small.css")).await;
    wait_released(&core).await;
    eprintln!(
        "assets_tcp_rss={}",
        json!({"before": before, "held": held, "released": released, "usage": usage(&core)})
    );
    // RSS also includes allocator/runtime/client/other process-owned memory;
    // record it without asserting equality to admission counters or an OS cap.
    server.abort();
    assert!(server.await.unwrap_err().is_cancelled());
}
