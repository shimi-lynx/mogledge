//! Opt-in synthetic measurements; creates and removes only temporary fixtures.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Instant;

fn rss_kib() -> Option<u64> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    status
        .lines()
        .find(|line| line.starts_with("VmRSS:"))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}
#[derive(Default)]
struct Observations {
    stopped: AtomicBool,
    peak_rss_kib: AtomicU64,
    peak_storage_bytes: AtomicU64,
    peak_journal_bytes: AtomicU64,
}

fn wait(service: &IndexService) -> IndexStatus {
    let started = Instant::now();
    loop {
        let status = service.status("benchmark").unwrap();
        if matches!(status.phase.as_str(), "ready" | "failed") {
            assert_eq!(status.phase, "ready", "{status:?}");
            return status;
        }
        assert!(started.elapsed() < Duration::from_secs(180), "{status:?}");
        thread::sleep(Duration::from_millis(2));
    }
}
fn cpu_ticks() -> Option<u64> {
    let text = fs::read_to_string("/proc/self/stat").ok()?;
    let fields: Vec<_> = text.rsplit_once(')')?.1.split_whitespace().collect();
    Some(fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?)
}
fn percentiles(mut samples: Vec<f64>) -> serde_json::Value {
    samples.sort_by(f64::total_cmp);
    serde_json::json!({"p50Ms":samples[samples.len()/2],"p95Ms":samples[(samples.len()*95).div_ceil(100)-1]})
}

#[test]
#[ignore = "creates 10,001 temporary HTML files; run explicitly in release mode"]
fn measure_index() {
    let docs = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    for folder in 0..100 {
        let directory = docs.path().join(format!("Folder{folder:03}"));
        fs::create_dir(&directory).unwrap();
        for page in 0..100 {
            fs::write(directory.join(format!("Page{page:03}.html")),
                format!("<title>資料 {folder} {page}</title><h1>日本語検索</h1><p>東京の旅行案内。ひらがな カタカナ ＡＢＣ Cafe\u{301}。</p><script>private-token</script>")).unwrap();
        }
    }
    let mut html = "<title>大きな文書</title><p>日本語と東京とカタカナの案内。</p>".to_string();
    html.push_str("<!--");
    html.push_str(&"x".repeat(100 * 1024 - html.len() - 3));
    html.push_str("-->");
    fs::write(docs.path().join("Benchmark.html"), html).unwrap();
    let started = Instant::now();
    let (root, dir) = knowledge::open_root(docs.path()).unwrap();
    let nodes = knowledge::scan(&root).unwrap();
    let tree_scan_ms = started.elapsed().as_secs_f64() * 1000.0;
    let service = IndexService::new(cache.path().to_path_buf()).unwrap();
    let baseline_rss_kib = rss_kib();
    let observations = Arc::new(Observations::default());
    let observed = observations.clone();
    let cache_path = cache.path().to_path_buf();
    let monitor = thread::spawn(move || {
        while !observed.stopped.load(Ordering::Relaxed) {
            if let Some(rss) = rss_kib() {
                observed.peak_rss_kib.fetch_max(rss, Ordering::Relaxed);
            }
            let mut total = 0;
            let mut journals = 0;
            if let Ok(entries) = fs::read_dir(&cache_path) {
                for entry in entries.flatten() {
                    let bytes = entry
                        .metadata()
                        .map(|metadata| metadata.len())
                        .unwrap_or_default();
                    total += bytes;
                    if entry.file_name().to_string_lossy().ends_with("-journal") {
                        journals += bytes;
                    }
                }
            }
            observed
                .peak_storage_bytes
                .fetch_max(total, Ordering::Relaxed);
            observed
                .peak_journal_bytes
                .fetch_max(journals, Ordering::Relaxed);
            thread::sleep(Duration::from_millis(2));
        }
    });
    let started = Instant::now();
    service.select("benchmark", root.clone(), dir.clone(), &nodes, false);
    let select_enqueue_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut competing_reads = Vec::new();
    for _ in 0..30 {
        let read = Instant::now();
        assert_eq!(
            knowledge::read(&root, &dir, "Benchmark.html")
                .unwrap()
                .len(),
            100 * 1024
        );
        competing_reads.push(read.elapsed().as_secs_f64() * 1000.0);
    }
    let initial = wait(&service);
    assert_eq!(initial.indexed, 10_001);
    assert!(initial.complete);
    let initial_ms = started.elapsed().as_secs_f64() * 1000.0;
    let generation = initial.generation;
    let mut queries = serde_json::Map::new();
    for (query, expected) in [
        ("京", 10_001),
        ("龘", 0),
        ("東京", 10_001),
        ("龘龘", 0),
        ("日本語", 10_001),
        ("ひらがな", 10_000),
        ("カタカナ", 10_001),
        ("ｶﾀｶﾅ", 10_001),
        ("abc", 10_000),
        ("CAFÉ", 10_000),
        ("東京 カタカナ", 10_001),
        ("private-token", 0),
    ] {
        let mut samples = Vec::new();
        for _ in 0..30 {
            let started = Instant::now();
            let page = service.search("benchmark", query, 100, 0).unwrap();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(page.hits.len(), expected.min(100));
            assert_eq!(page.has_more, expected > 100);
        }
        queries.insert(query.into(), percentiles(samples));
    }
    let mut scoped_queries = serde_json::Map::new();
    for (query, mode) in [
        ("京", SearchMode::And),
        ("日本語", SearchMode::And),
        ("東京 abc", SearchMode::And),
        ("龘 rust", SearchMode::Or),
    ] {
        let mut samples = Vec::new();
        for _ in 0..30 {
            let started = Instant::now();
            let page = service
                .search_with_scope("benchmark", query, 20, 0, mode, Some("Folder000"))
                .unwrap();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(page.hits.len(), if mode == SearchMode::Or { 0 } else { 20 });
            assert_eq!(page.has_more, mode != SearchMode::Or);
            assert!(page
                .hits
                .iter()
                .all(|hit| hit.relative_path.starts_with("Folder000/")));
            assert_eq!(page.generation, generation);
        }
        scoped_queries.insert(query.into(), percentiles(samples));
    }
    assert_eq!(
        service.status("benchmark").unwrap().request_revision,
        initial.request_revision
    );
    let started = Instant::now();
    service.select("benchmark", root.clone(), dir.clone(), &nodes, false);
    let restart = wait(&service);
    let restart_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(generation, restart.generation);
    fs::write(
        root.join("Folder000/Page000.html"),
        "<title>単一更新</title>変更内容",
    )
    .unwrap();
    let started = Instant::now();
    service.changed(
        "benchmark",
        &["Folder000/Page000.html".into()],
        &nodes,
        false,
        false,
    );
    wait(&service);
    let single_update_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut changed = Vec::new();
    for page in 0..100 {
        let relative = format!("Folder001/Page{page:03}.html");
        fs::write(root.join(&relative), "<h1>大量更新</h1>変更済み資料").unwrap();
        changed.push(relative);
    }
    let started = Instant::now();
    service.changed("benchmark", &changed, &nodes, false, false);
    wait(&service);
    let bulk_update_ms = started.elapsed().as_secs_f64() * 1000.0;
    let database = cache
        .path()
        .join(format!("index-{}.sqlite3", initial.root_id));
    fs::write(&database, "broken database").unwrap();
    let started = Instant::now();
    service.select("benchmark", root, dir, &nodes, false);
    let rebuilt = wait(&service);
    let rebuild_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert!(rebuilt.rebuilt && rebuilt.complete);
    observations.stopped.store(true, Ordering::Relaxed);
    monitor.join().unwrap();
    let before = cpu_ticks();
    thread::sleep(Duration::from_millis(500));
    let idle_cpu_ticks = before
        .zip(cpu_ticks())
        .map(|(before, after)| after - before);
    let files: Vec<_> = fs::read_dir(cache.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        files.len(),
        1,
        "idle DELETE journal must leave only the database"
    );
    println!(
        "{}",
        serde_json::json!({
            "fixture":{"htmlFiles":10001,"folders":100,"benchmarkBytes":102400,"staticBody":"small Japanese/Latin text; large document has comment padding"},
            "treeScanMs":tree_scan_ms,"selectEnqueueMs":select_enqueue_ms,
            "initialIndexMs":initial_ms,"restartHashReconcileMs":restart_ms,
            "singleUpdateMs":single_update_ms,"bulk100UpdateMs":bulk_update_ms,"corruptRebuildMs":rebuild_ms,
            "queries":queries,"folderScopedQueries":scoped_queries,"competing100KiBRead":percentiles(competing_reads),
        "databaseBytes":rebuilt.database_bytes,"idleJournalWalBytes":0,"idleCpuTicks500Ms":idle_cpu_ticks,
        "linuxBaselineRssKiB":baseline_rss_kib,"linuxSampledPeakRssKiB":observations.peak_rss_kib.load(Ordering::Relaxed),
        "sampledPeakDbJournalBytes":observations.peak_storage_bytes.load(Ordering::Relaxed),
        "sampledPeakJournalBytes":observations.peak_journal_bytes.load(Ordering::Relaxed),"samplingIntervalMs":2,
            "complete":rebuilt.complete,"indexed":rebuilt.indexed
        })
    );
}
