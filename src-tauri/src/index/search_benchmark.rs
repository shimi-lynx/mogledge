//! Opt-in, same-fixture native search versus safe full-scan measurements.
//! Generated documents and the derived database live only in temporary folders.

use super::*;
use crate::core::Core;
use std::time::Instant;

const PAGE_SIZE: u32 = 20;
const SAMPLES: usize = 20;
const LONG_DOCUMENT_BYTES: usize = 100 * 1024;
const RARE_PATH: &str = "Folder007/Page033.html";
const LONG_PATH: &str = "長文.html";

#[derive(Debug, PartialEq, Eq)]
struct ComparableHit {
    relative_path: String,
    title: String,
    snippet: String,
    truncated: bool,
}

#[derive(Debug)]
struct FullScanPage {
    hits: Vec<ComparableHit>,
    matches: usize,
    normalized_query: String,
}

fn comparable_hits(page: &SearchPage) -> Vec<ComparableHit> {
    page.hits
        .iter()
        .map(|hit| ComparableHit {
            relative_path: hit.relative_path.clone(),
            title: hit.title.clone(),
            snippet: hit.snippet.clone(),
            truncated: hit.truncated,
        })
        .collect()
}

/// The baseline deliberately reads and extracts every document for every
/// query. It retains only the first page and a match count, never all hits.
fn full_scan(root: &Path, dir: &Dir, paths: &[String], query: &str) -> FullScanPage {
    full_scan_with_mode(root, dir, paths, query, SearchMode::And)
}

fn full_scan_with_mode(
    root: &Path,
    dir: &Dir,
    paths: &[String],
    query: &str,
    mode: SearchMode,
) -> FullScanPage {
    let normalized_query = extract::normalize_search(query);
    let terms: Vec<_> = normalized_query.split_whitespace().collect();
    let mut hits = Vec::with_capacity(PAGE_SIZE as usize);
    let mut matches = 0;
    for relative_path in paths {
        let bytes = knowledge::read(root, dir, relative_path).unwrap();
        let html = std::str::from_utf8(&bytes).unwrap();
        let extracted = extract::extract(html);
        let fields = [
            extract::normalize_search(relative_path),
            extract::normalize_search(&extracted.title),
            extract::normalize_search(&extracted.headings),
            extract::normalize_search(&extracted.body),
        ];
        let term_matches = |term: &&str| fields.iter().any(|field| field.contains(*term));
        if !terms.is_empty()
            && match mode {
                SearchMode::And => terms.iter().all(term_matches),
                SearchMode::Or => terms.iter().any(term_matches),
            }
        {
            matches += 1;
            if hits.len() < PAGE_SIZE as usize {
                hits.push(ComparableHit {
                    relative_path: relative_path.clone(),
                    title: extracted.title,
                    snippet: highlight::snippet(&extracted.body, &terms).0,
                    truncated: extracted.truncated,
                });
            }
        }
    }
    FullScanPage {
        hits,
        matches,
        normalized_query,
    }
}

#[test]
#[ignore = "creates the existing 10,001-document fixture; run explicitly in release mode"]
#[allow(clippy::assertions_on_constants)]
fn measure_search_modes_and_highlights() {
    assert!(
        !cfg!(debug_assertions),
        "run this measurement with --release"
    );
    let documents = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    write_fixture(documents.path());
    let core = Core::new(0);
    let service = IndexService::new(cache.path().to_path_buf()).unwrap();
    assert!(core.index.set(service.clone()).is_ok());
    let snapshot = core.select(documents.path(), false).unwrap();
    assert!(snapshot.watch_error.is_none());
    let workspace = snapshot.workspace_id.as_deref().unwrap();
    let initial = wait_ready(&service, workspace);
    assert_eq!(initial.indexed, 10_001);
    let (root, dir) = {
        let state = core.workspace.lock().unwrap();
        (state.root.clone().unwrap(), state.dir.clone().unwrap())
    };
    let paths: Vec<_> = collect_paths(&snapshot.nodes).0.into_iter().collect();
    let before = source_manifest(&root, &dir, &paths);
    let mut measurements = Vec::new();
    for (query, mode, expected) in [
        ("稀少目印 京", SearchMode::And, 1),
        ("稀少目印 京", SearchMode::Or, 10_001),
        ("日本語 不存在", SearchMode::And, 0),
        ("日本語 不存在", SearchMode::Or, 10_001),
        ("京 龘", SearchMode::And, 0),
        ("京 龘", SearchMode::Or, 10_001),
        ("長文専用 東京", SearchMode::And, 1),
        ("長文専用 東京", SearchMode::Or, 10_001),
    ] {
        let baseline = full_scan_with_mode(&root, &dir, &paths, query, mode);
        assert_eq!(baseline.matches, expected);
        let warm = api::search_with_mode(&core, workspace, query, PAGE_SIZE, 0, mode).unwrap();
        verify_equivalence(query, &warm, &baseline);
        let mut samples = Vec::new();
        for _ in 0..SAMPLES {
            let started = Instant::now();
            let page = api::search_with_mode(&core, workspace, query, PAGE_SIZE, 0, mode).unwrap();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            verify_equivalence(query, &page, &baseline);
        }
        measurements.push(serde_json::json!({"query": query, "mode": mode, "matches": expected, "returned": warm.hits.len(), "latency": percentiles(samples)}));
    }
    assert_eq!(source_manifest(&root, &dir, &paths), before);
    assert_eq!(
        service.status(workspace).unwrap().generation,
        initial.generation
    );
    // Stress all 20 returned bodies at the extraction limit, with overlapping
    // matches, rather than claiming the existing corpus has 20 long documents.
    let dense_cache = tempfile::tempdir().unwrap();
    let mut store = Store::open(dense_cache.path(), &initial.root_id).unwrap();
    let body = "a".repeat(65_536);
    let records: Vec<_> = (0..20)
        .map(|index| DocumentRecord {
            relative_path: format!("{index:02}.html"),
            title: "ＡＡＡ".into(),
            headings: String::new(),
            body: body.clone(),
            source_hash: Some(format!("{:x}", Sha256::digest(body.as_bytes()))),
            source_size: body.len() as u64,
            modified_ns: Some("123".into()),
            state: DocumentState::Ready,
            truncated: true,
        })
        .collect();
    store.apply(&records).unwrap();
    for mode in [SearchMode::And, SearchMode::Or] {
        let mut samples = Vec::new();
        for _ in 0..SAMPLES {
            let started = Instant::now();
            let page = Store::search_with_mode(
                dense_cache.path(),
                &initial.root_id,
                "a aa aaa",
                PAGE_SIZE,
                0,
                mode,
            )
            .unwrap();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(page.hits.len(), 20);
            assert!(page
                .hits
                .iter()
                .all(|hit| hit.snippet_matches.len() == 1 && hit.snippet.chars().count() == 240));
        }
        measurements.push(serde_json::json!({"query": "a aa aaa", "mode": mode, "fixture": "20 indexed bodies of 65536 characters", "returned": 20, "latency": percentiles(samples)}));
    }
    println!(
        "SEARCH_MODES_MEASUREMENT_JSON={}",
        serde_json::json!({
            "platform": std::env::consts::OS, "profile": "release", "samplesPerQuery": SAMPLES,
            "fixture": "existing 10001-document Japanese corpus plus separate dense-result stress",
            "sourceAndGenerationUnchanged": true, "queries": measurements,
            "limitations": "warm synthetic backend measurements; no Native IPC, UI paint, Windows/macOS or multi-tab resource measurements"
        })
    );
}

fn verify_equivalence(query: &str, indexed: &SearchPage, baseline: &FullScanPage) {
    assert!(indexed.hits.len() <= PAGE_SIZE as usize);
    assert_eq!(
        indexed.normalized_query, baseline.normalized_query,
        "normalized query: {query}"
    );
    assert_eq!(
        comparable_hits(indexed),
        baseline.hits,
        "first BINARY-sorted page, title, snippet and truncation: {query}"
    );
    assert_eq!(
        indexed.has_more,
        baseline.matches > PAGE_SIZE as usize,
        "has_more: {query}"
    );
}

fn percentiles(mut samples: Vec<f64>) -> serde_json::Value {
    samples.sort_by(f64::total_cmp);
    let rank = |percent: usize| (samples.len() * percent).div_ceil(100) - 1;
    serde_json::json!({
        "samples": samples.len(),
        "p50Ms": samples[rank(50)],
        "p95Ms": samples[rank(95)],
        "minMs": samples[0],
        "maxMs": samples[samples.len() - 1],
    })
}

fn write_fixture(directory: &Path) -> (u64, usize) {
    let mut source_bytes = 0;
    for folder in 0..100 {
        let destination = directory.join(format!("Folder{folder:03}"));
        fs::create_dir(&destination).unwrap();
        for page in 0..100 {
            let rare = folder == 7 && page == 33;
            let title = if rare {
                "題名限定 資料 007 033".to_owned()
            } else {
                format!("資料 {folder:03} {page:03}")
            };
            let heading = if rare {
                "日本語検索 見出し限定"
            } else {
                "日本語検索"
            };
            let addition = if rare { "稀少目印の確認。" } else { "" };
            let html = format!(
                "<!doctype html><html><head><meta charset='utf-8'><title>{title}</title></head>\
                <body><h1>{heading}</h1><p>東京の旅行案内。ひらがな カタカナ ＡＢＣ Cafe\u{301}。\
                資料を読む際は出典と更新日を確認してください。{addition}</p>\
                <script>private-token</script><template>template-only-token</template></body></html>"
            );
            source_bytes += html.len() as u64;
            fs::write(destination.join(format!("Page{page:03}.html")), html).unwrap();
        }
    }
    let mut html = "<!doctype html><html><head><meta charset='utf-8'><title>長文専用の技術資料</title></head><body><h1>日本語検索</h1>".to_owned();
    let paragraph = "<p>東京の旅行案内を整理するため、日本語で交通手段や宿泊先を比較します。\
        ひらがなとカタカナを使い、ＡＢＣやCafe\u{301}の表記も確認します。\
        資料を読む際は出典と更新日を確かめ、現地の文化や暮らしを尊重して計画を立てます。</p>";
    let closing = "</body></html>";
    while html.len() + paragraph.len() + closing.len() <= LONG_DOCUMENT_BYTES {
        html.push_str(paragraph);
    }
    let remainder = LONG_DOCUMENT_BYTES - html.len() - closing.len();
    html.push_str(&"日".repeat(remainder / 3));
    html.push_str(&"a".repeat(remainder % 3));
    html.push_str(closing);
    assert_eq!(html.len(), LONG_DOCUMENT_BYTES);
    let extracted = extract::extract(&html);
    let long_body_chars = extracted.body.chars().count();
    assert!(
        long_body_chars > 30_000,
        "must be a genuine Japanese text body"
    );
    assert!(!extracted.truncated);
    source_bytes += html.len() as u64;
    fs::write(directory.join(LONG_PATH), html).unwrap();
    (source_bytes, long_body_chars)
}

fn source_manifest(root: &Path, dir: &Dir, paths: &[String]) -> String {
    let mut digest = Sha256::new();
    for relative in paths {
        let source = knowledge::read_source(root, dir, relative).unwrap();
        digest.update(relative.as_bytes());
        digest.update([0]);
        digest.update(Sha256::digest(&source.data));
        digest.update((source.data.len() as u64).to_le_bytes());
        if let Some(modified) = source.modified_ns {
            digest.update(modified.as_bytes());
        }
        digest.update([0]);
    }
    format!("{:x}", digest.finalize())
}

fn wait_ready(service: &IndexService, workspace: &str) -> IndexStatus {
    let started = Instant::now();
    loop {
        let status = service.status(workspace).unwrap();
        if matches!(status.phase.as_str(), "ready" | "failed") {
            assert_eq!(status.phase, "ready", "{status:?}");
            return status;
        }
        assert!(started.elapsed() < Duration::from_secs(180), "{status:?}");
        thread::sleep(Duration::from_millis(2));
    }
}

#[test]
#[ignore = "creates 10,001 temporary HTML documents; explicitly run in release mode"]
// This opt-in measurement must reject an accidentally unoptimized test build.
#[allow(clippy::assertions_on_constants)]
fn measure_search_against_full_scan() {
    assert!(
        !cfg!(debug_assertions),
        "run this measurement with --release"
    );
    let documents = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let (total_source_bytes, long_body_chars) = write_fixture(documents.path());
    let (fixture_root, fixture_dir) = knowledge::open_root(documents.path()).unwrap();
    let (fixture_paths, fixture_limited) = collect_paths(&knowledge::scan(&fixture_root).unwrap());
    assert!(!fixture_limited);
    let fixture_paths: Vec<_> = fixture_paths.into_iter().collect();
    let before = source_manifest(&fixture_root, &fixture_dir, &fixture_paths);
    let core = Core::new(0);
    let service = IndexService::new(cache.path().to_path_buf()).unwrap();
    assert!(core.index.set(service.clone()).is_ok());
    let started = Instant::now();
    let snapshot = core.select(documents.path(), false).unwrap();
    let selection_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert!(
        snapshot.watch_error.is_none(),
        "benchmark requires a healthy watcher"
    );
    let workspace = snapshot.workspace_id.as_deref().unwrap();
    let initial = wait_ready(&service, workspace);
    let select_and_initial_index_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(initial.indexed, 10_001);
    assert!(initial.complete && !initial.limited);
    assert_eq!(initial.truncated, 0);
    let (root, dir) = {
        let state = core.workspace.lock().unwrap();
        (state.root.clone().unwrap(), state.dir.clone().unwrap())
    };
    let (paths, limited) = collect_paths(&snapshot.nodes);
    assert!(!limited);
    let paths: Vec<_> = paths.into_iter().collect();
    assert_eq!(paths, fixture_paths);
    assert_eq!(paths.len(), 10_001);
    assert!(paths
        .windows(2)
        .all(|pair| pair[0].as_bytes() < pair[1].as_bytes()));
    let mut measurements = Vec::new();
    for (kind, query, expected_matches, unique_path) in [
        ("oneCharacterBroad", "京", 10_001, None),
        ("oneCharacterAbsent", "龘", 0, None),
        ("twoCharacterBroad", "東京", 10_001, None),
        ("twoCharacterAbsent", "龘龘", 0, None),
        ("threePlusCharacterBroad", "日本語", 10_001, None),
        ("threePlusCharacterAbsent", "龘龘龘", 0, None),
        ("mixedLongShortRare", "稀少目印 京", 1, Some(RARE_PATH)),
        ("widthNormalizedBroad", "ｶﾀｶﾅ", 10_001, None),
        (
            "caseNormalizedPath",
            "fOlDeR007/pAgE033",
            1,
            Some(RARE_PATH),
        ),
        ("titleOnly", "題名限定", 1, Some(RARE_PATH)),
        (
            "andAcrossFourFields",
            "ＦＯＬＤＥＲ００７／ＰＡＧＥ０３３ 題名限定 見出し限定 稀少目印",
            1,
            Some(RARE_PATH),
        ),
        ("longBodyTitleAndBody", "長文専用 東京", 1, Some(LONG_PATH)),
        ("caseAndCompositionNormalizedBroad", "CAFÉ", 10_001, None),
        ("scriptExcluded", "private-token", 0, None),
    ] {
        let warm_baseline = full_scan(&root, &dir, &paths, query);
        let warm_indexed = api::search(&core, workspace, query, PAGE_SIZE, 0).unwrap();
        verify_equivalence(query, &warm_indexed, &warm_baseline);
        assert_eq!(
            warm_baseline.matches, expected_matches,
            "fixture expectation: {query}"
        );
        if let Some(expected) = unique_path {
            assert_eq!(warm_baseline.hits[0].relative_path, expected);
        } else if expected_matches > PAGE_SIZE as usize {
            assert_eq!(
                warm_baseline
                    .hits
                    .iter()
                    .map(|hit| &hit.relative_path)
                    .collect::<Vec<_>>(),
                paths.iter().take(PAGE_SIZE as usize).collect::<Vec<_>>()
            );
        }
        let mut indexed_samples = Vec::with_capacity(SAMPLES);
        let mut baseline_samples = Vec::with_capacity(SAMPLES);
        for sample in 0..SAMPLES {
            let indexed = || {
                let started = Instant::now();
                let page = api::search(&core, workspace, query, PAGE_SIZE, 0).unwrap();
                (page, started.elapsed().as_secs_f64() * 1000.0)
            };
            let baseline = || {
                let started = Instant::now();
                let page = full_scan(&root, &dir, &paths, query);
                (page, started.elapsed().as_secs_f64() * 1000.0)
            };
            let ((indexed_page, indexed_ms), (baseline_page, baseline_ms)) = if sample % 2 == 0 {
                let baseline_result = baseline();
                (indexed(), baseline_result)
            } else {
                let indexed_result = indexed();
                (indexed_result, baseline())
            };
            verify_equivalence(query, &indexed_page, &baseline_page);
            assert_eq!(baseline_page.matches, expected_matches);
            indexed_samples.push(indexed_ms);
            baseline_samples.push(baseline_ms);
        }
        let indexed = percentiles(indexed_samples);
        let baseline = percentiles(baseline_samples);
        measurements.push(serde_json::json!({
            "case": kind, "query": query, "matchingDocuments": expected_matches,
            "returnedResults": warm_indexed.hits.len(), "hasMore": warm_indexed.has_more,
            "indexedNativeAdapter": indexed, "safeFullScan": baseline,
            "p50Speedup": baseline["p50Ms"].as_f64().unwrap() / indexed["p50Ms"].as_f64().unwrap(),
            "p95Speedup": baseline["p95Ms"].as_f64().unwrap() / indexed["p95Ms"].as_f64().unwrap(),
            "equivalentPathTitleSnippetTruncationAndHasMore": true,
        }));
    }
    let after_tree = knowledge::scan(&root).unwrap();
    assert_eq!(
        collect_paths(&after_tree).0.into_iter().collect::<Vec<_>>(),
        paths
    );
    assert_eq!(
        source_manifest(&root, &dir, &paths),
        before,
        "source bytes/mtime changed"
    );
    let final_status = service.status(workspace).unwrap();
    assert_eq!(final_status.generation, initial.generation);
    let result = serde_json::json!({
        "measurementDate": "2026-10-04",
        "platform": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
        "buildProfile": "release",
        "fixture": {
            "htmlFiles": paths.len(), "folders": 100,
            "smallJapaneseDocuments": 10_000,
            "totalSourceBytes": total_source_bytes,
            "longDocumentBytes": LONG_DOCUMENT_BYTES,
            "longExtractedBodyCharacters": long_body_chars,
            "longBody": "repeated genuine Japanese paragraphs; no comment padding",
            "documentsTruncated": initial.truncated,
        },
        "method": {
            "samplesPerQueryPerMethod": SAMPLES,
            "warmupRunsPerQueryPerMethod": 1,
            "percentiles": "nearest rank; p50 rank 10 and p95 rank 19 of 20",
            "measurementOrder": "alternating baseline-first and indexed-first",
            "resultLimit": PAGE_SIZE, "offset": 0,
            "indexed": "production native Rust adapter, database search and current-root path validation",
            "baseline": "safe content read, UTF-8 decode, HTML extraction and four-field normalization for every document on every query",
            "semantics": "literal normalized substring AND across path/title/headings/body; BINARY path order; same first 20 titles/snippets/truncation and has_more",
            "baselineResultStorage": "at most 20 hits plus total-match counter; no early exit",
            "pathEnumeration": "same precomputed sorted tree for both methods; tree scan excluded from query samples",
            "cacheState": "warm OS caches expected; no filesystem cache eviction; baseline does not cache extracted text",
        },
        "selectionMs": selection_ms,
        "selectAndInitialIndexMs": select_and_initial_index_ms,
        "databaseBytes": final_status.database_bytes,
        "queries": measurements,
        "sourceUnchanged": true,
        "indexGenerationUnchangedDuringQueries": true,
        "limitations": [
            "Synthetic temporary corpus: 10,000 small documents and one 100 KiB Japanese-body document, not 10,001 documents of 100 KiB each",
            "One measured Linux execution; latency depends on hardware, load, filesystem and cache state",
            "No Windows OneDrive, native WebView GUI, renderer paint, multi-tab memory or tab-switch performance measurement",
            "Native command scheduling, IPC serialization and UI debounce are excluded; the production Rust adapter function is timed directly",
            "No cold-cache latency or concurrent document edits during query samples",
            "Speedup ratios compare equal percentiles of separate sample distributions, not guaranteed per-request speedups",
        ],
    });
    // The runner captures only this marked JSON line into the reviewed report.
    // No temporary absolute paths, workspace IDs or document IDs are emitted.
    println!("SEARCH_PERFORMANCE_JSON={result}");
}
