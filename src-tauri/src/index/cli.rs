//! Explicit, on-demand, read-only CLI adapter. It never opens application settings.
use std::{collections::BTreeMap, ffi::OsString, io::Write, path::PathBuf};

use serde::Serialize;

use super::{ReadOnlyIndex, StoreCounts};

#[derive(Debug)]
struct Arguments {
    root: PathBuf,
    cache: PathBuf,
    command: Command,
}
#[derive(Debug)]
enum Command {
    Status,
    Search {
        query: String,
        limit: u32,
        offset: u32,
    },
    Read {
        document_id: String,
        max_chars: usize,
    },
}
#[derive(Debug, Serialize)]
struct CliError {
    code: &'static str,
    message: &'static str,
}
fn argument_error() -> CliError {
    CliError { code: "invalid_arguments", message: "Use explicit --root and --cache-dir with status, search --query, or read --document-id. Options must be unique; only --format json is supported." }
}
fn backend_error(error: String) -> CliError {
    // Map known conditions to static messages; never echo a path or raw OS error.
    let (code, message) = if error.contains("needs rebuilding")
        || error.contains("DatabaseCorrupt")
        || error.contains("NotADatabase")
    {
        (
            "cache_rebuild_required",
            "Index cache is stale or invalid; rebuild it in the application.",
        )
    } else if error.contains("CannotOpen") || error.contains("cache is missing") {
        (
            "index_missing",
            "Index cache is missing or cannot be opened; build it in the application.",
        )
    } else if error.contains("DatabaseBusy") || error.contains("DatabaseLocked") {
        ("index_busy", "Index cache is busy; retry later.")
    } else if error.contains("OperationInterrupted") {
        (
            "query_timeout",
            "Index operation exceeded its query budget.",
        )
    } else if error.contains("Document is absent") {
        (
            "document_not_indexed",
            "Document is absent from this root index.",
        )
    } else if error.contains("changed during") {
        (
            "source_unstable",
            "Original source changed during reading; retry later.",
        )
    } else if error.contains("UTF-8") {
        ("invalid_source_encoding", "Original HTML must be UTF-8.")
    } else if error.contains("limit")
        || error.contains("characters")
        || error.contains("eight terms")
    {
        (
            "operation_limit",
            "Query or document exceeds the supported operation limits.",
        )
    } else if error.contains("リンク") || error.contains("reparse") || error.contains("links") {
        (
            "unsafe_path",
            "Links and unsupported reparse points are not allowed.",
        )
    } else if error.contains("クラウド") || error.contains("未取得") || error.contains("offline")
    {
        (
            "source_unavailable",
            "Original source is unavailable locally; this command does not download it.",
        )
    } else {
        ("index_unavailable", "Cannot read this root or its local index. Build or refresh the cache in the application.")
    };
    CliError { code, message }
}

fn parse<I: IntoIterator<Item = OsString>>(arguments: I) -> Result<Arguments, CliError> {
    let mut arguments = arguments.into_iter();
    let mut values = BTreeMap::<String, OsString>::new();
    let mut command = None;
    while let Some(argument) = arguments.next() {
        let text = argument.to_str().ok_or_else(argument_error)?;
        if matches!(text, "status" | "search" | "read") {
            if command.replace(text.to_string()).is_some() {
                return Err(argument_error());
            }
            continue;
        }
        if !matches!(
            text,
            "--root"
                | "--cache-dir"
                | "--format"
                | "--query"
                | "--limit"
                | "--offset"
                | "--document-id"
                | "--max-chars"
        ) {
            return Err(argument_error());
        }
        let value = arguments.next().ok_or_else(argument_error)?;
        if values.insert(text.to_string(), value).is_some() {
            return Err(argument_error());
        }
    }
    let root = PathBuf::from(values.remove("--root").ok_or_else(argument_error)?);
    let cache = PathBuf::from(values.remove("--cache-dir").ok_or_else(argument_error)?);
    if root.as_os_str().is_empty() || cache.as_os_str().is_empty() {
        return Err(argument_error());
    }
    if let Some(format) = values.remove("--format") {
        if format != "json" {
            return Err(argument_error());
        }
    }
    let command = match command.as_deref() {
        Some("status") => Command::Status,
        Some("search") => {
            let query = values
                .remove("--query")
                .ok_or_else(argument_error)?
                .into_string()
                .map_err(|_| argument_error())?;
            if query.trim().is_empty() {
                return Err(argument_error());
            }
            let limit = number(&mut values, "--limit", 20, 1, 100)? as u32;
            let offset = number(&mut values, "--offset", 0, 0, 10_000)? as u32;
            Command::Search {
                query,
                limit,
                offset,
            }
        }
        Some("read") => {
            let document_id = values
                .remove("--document-id")
                .ok_or_else(argument_error)?
                .into_string()
                .map_err(|_| argument_error())?;
            if document_id.len() != 64
                || !document_id
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(argument_error());
            }
            let max_chars = number(&mut values, "--max-chars", 4_096, 1, 65_536)?;
            Command::Read {
                document_id,
                max_chars,
            }
        }
        _ => return Err(argument_error()),
    };
    if !values.is_empty() {
        return Err(argument_error());
    }
    Ok(Arguments {
        root,
        cache,
        command,
    })
}
fn number(
    values: &mut BTreeMap<String, OsString>,
    key: &str,
    default: usize,
    min: usize,
    max: usize,
) -> Result<usize, CliError> {
    let Some(value) = values.remove(key) else {
        return Ok(default);
    };
    let text = value.to_str().ok_or_else(argument_error)?;
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(argument_error());
    }
    let value = text.parse::<usize>().map_err(|_| argument_error())?;
    if !(min..=max).contains(&value) {
        return Err(argument_error());
    }
    Ok(value)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheState {
    root_id: String,
    schema_version: String,
    extractor_version: String,
    generation: u64,
    #[serde(flatten)]
    counts: StoreCounts,
    cached_complete: bool,
    generation_consistent: bool,
    source_freshness: &'static str,
}
fn state(
    index: &ReadOnlyIndex,
    mut counts: StoreCounts,
    generation: u64,
    consistent: bool,
) -> CacheState {
    let (schema, extractor) = index.versions();
    let cached_complete = consistent && counts.complete && !counts.building && !counts.limited;
    // Cache completion describes its scan, never the freshness of source files.
    if !consistent {
        counts.complete = false;
    }
    CacheState {
        root_id: index.identifier().into(),
        schema_version: schema.into(),
        extractor_version: extractor.into(),
        generation,
        counts,
        cached_complete,
        generation_consistent: consistent,
        source_freshness: "unverified",
    }
}
fn same_status(a: &StoreCounts, b: &StoreCounts) -> bool {
    a.expected_documents == b.expected_documents
        && a.complete == b.complete
        && a.limited == b.limited
        && a.building == b.building
        && a.indexed == b.indexed
        && a.pending == b.pending
        && a.unavailable == b.unavailable
        && a.failed == b.failed
        && a.truncated == b.truncated
}
fn snapshot<T>(
    index: &ReadOnlyIndex,
    mut operation: impl FnMut() -> Result<(T, Option<u64>), String>,
) -> Result<(T, CacheState), CliError> {
    for attempt in 0..2 {
        let (before, before_generation) = index.status().map_err(backend_error)?;
        let (result, result_generation) = operation().map_err(backend_error)?;
        let (after, after_generation) = index.status().map_err(backend_error)?;
        let consistent = before_generation == after_generation
            && result_generation.is_none_or(|value| value == after_generation)
            && same_status(&before, &after);
        if consistent || attempt == 1 {
            return Ok((result, state(index, after, after_generation, consistent)));
        }
    }
    unreachable!()
}
fn execute(arguments: Arguments) -> Result<serde_json::Value, CliError> {
    let index = ReadOnlyIndex::open(&arguments.cache, &arguments.root).map_err(backend_error)?;
    match arguments.command {
        Command::Status => {
            let (counts, generation) = index.status().map_err(backend_error)?;
            Ok(serde_json::json!({"command":"status","cache":state(&index,counts,generation,true)}))
        }
        Command::Search {
            query,
            limit,
            offset,
        } => {
            let (page, cache) = snapshot(&index, || {
                index.search(&query, limit, offset).map(|page| {
                    let generation = page.generation;
                    (page, Some(generation))
                })
            })?;
            Ok(serde_json::json!({"command":"search","cache":cache,"result":page}))
        }
        Command::Read {
            document_id,
            max_chars,
        } => {
            let (document, cache) = snapshot(&index, || {
                index
                    .read_document(&document_id, max_chars)
                    .map(|document| (document, None))
            })?;
            Ok(serde_json::json!({"command":"read","cache":cache,"document":document}))
        }
    }
}

/// Arguments exclude the executable name. Success is one JSON object on stdout;
/// failures are sanitized JSON on stderr with exit status 2.
pub fn run<I, O, E>(arguments: I, stdout: &mut O, stderr: &mut E) -> i32
where
    I: IntoIterator<Item = OsString>,
    O: Write,
    E: Write,
{
    let outcome = parse(arguments).and_then(execute);
    match outcome {
        Ok(value) => {
            if serde_json::to_writer(&mut *stdout, &value).is_ok()
                && stdout.write_all(b"\n").is_ok()
            {
                return 0;
            }
            let _ = serde_json::to_writer(
                &mut *stderr,
                &CliError {
                    code: "output_error",
                    message: "Cannot write JSON output.",
                },
            );
        }
        Err(error) => {
            let _ = serde_json::to_writer(&mut *stderr, &error);
        }
    }
    let _ = stderr.write_all(b"\n");
    2
}

#[cfg(test)]
mod tests {
    use super::super::{
        extract, root_id,
        store::{DocumentRecord, DocumentState, Store},
    };
    use super::*;
    use sha2::{Digest, Sha256};
    use std::fs;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }
    fn invoke(arguments: Vec<OsString>) -> (i32, serde_json::Value, Vec<u8>) {
        let mut stdout = vec![];
        let mut stderr = vec![];
        let code = run(arguments, &mut stdout, &mut stderr);
        let json = serde_json::from_slice(if code == 0 { &stdout } else { &stderr }).unwrap();
        (code, json, if code == 0 { stderr } else { stdout })
    }
    struct Fixture {
        docs: tempfile::TempDir,
        cache: tempfile::TempDir,
        settings: PathBuf,
        database: PathBuf,
        id: String,
    }
    impl Fixture {
        fn new() -> Self {
            let docs = tempfile::tempdir().unwrap();
            let cache = tempfile::tempdir().unwrap();
            let html = "<title>ローカル資料</title><h1>日本語</h1><p>東京 開発と検索</p><script>private()</script>";
            fs::write(docs.path().join("sample.html"), html).unwrap();
            let settings = cache.path().join("settings.json");
            fs::write(&settings, "{\"fixture\":true}").unwrap();
            let root = docs.path().canonicalize().unwrap();
            let root_id = root_id(&root);
            let mut store = Store::open(cache.path(), &root_id).unwrap();
            let text = extract::extract(html);
            store.begin_index(1, false).unwrap();
            store
                .apply(&[DocumentRecord {
                    relative_path: "sample.html".into(),
                    title: text.title,
                    headings: text.headings,
                    body: text.body,
                    source_hash: Some(format!("{:x}", Sha256::digest(html.as_bytes()))),
                    source_size: html.len() as u64,
                    modified_ns: None,
                    state: DocumentState::Ready,
                    truncated: false,
                }])
                .unwrap();
            store.finish_index(true).unwrap();
            let id = Store::search(cache.path(), &root_id, "東京", 1, 0)
                .unwrap()
                .hits
                .remove(0)
                .document_id;
            drop(store);
            let database = cache.path().join(format!("index-{root_id}.sqlite3"));
            Self {
                docs,
                cache,
                settings,
                database,
                id,
            }
        }
        fn arguments(&self, command: &[&str]) -> Vec<OsString> {
            let mut values = vec![
                "--root".into(),
                self.docs.path().as_os_str().to_owned(),
                "--cache-dir".into(),
                self.cache.path().as_os_str().to_owned(),
            ];
            values.extend(args(command));
            values
        }
        fn bytes(&self) -> [Vec<u8>; 3] {
            [
                fs::read(&self.database).unwrap(),
                fs::read(self.docs.path().join("sample.html")).unwrap(),
                fs::read(&self.settings).unwrap(),
            ]
        }
    }

    #[test]
    fn arguments_are_explicit_unique_command_scoped_and_bounded() {
        let base = ["--root", "root", "--cache-dir", "cache"];
        for suffix in [
            vec![],
            vec!["unknown"],
            vec!["status", "search"],
            vec!["status", "--unknown", "x"],
            vec!["status", "--root", "other"],
            vec!["status", "--query", "x"],
            vec!["status", "--format", "text"],
            vec!["search"],
            vec!["search", "--query", "  "],
            vec!["search", "--query", "x", "--limit", "0"],
            vec!["search", "--query", "x", "--limit", "101"],
            vec!["search", "--query", "x", "--limit", "+1"],
            vec!["search", "--query", "x", "--offset", "10001"],
            vec!["search", "--query", "x", "--query", "y"],
            vec!["read", "--document-id", "../outside"],
            vec!["read", "--document-id", "abc"],
        ] {
            let mut values = args(&base);
            values.extend(args(&suffix));
            let (code, json, other) = invoke(values);
            assert_eq!(code, 2, "{suffix:?}");
            assert_eq!(json["code"], "invalid_arguments");
            assert!(other.is_empty());
        }
        assert!(parse(args(&["status", "--root", "r"])).is_err());
        assert!(parse(args(&["status", "--root", "", "--cache-dir", "c"])).is_err());
        let id = "a".repeat(64);
        for limit in ["0", "65537", "-1", "99999999999999999999999999999"] {
            assert!(parse(args(&[
                "--root",
                "r",
                "--cache-dir",
                "c",
                "read",
                "--document-id",
                &id,
                "--max-chars",
                limit
            ]))
            .is_err());
        }
    }

    #[test]
    fn cli_status_search_read_do_not_change_database_original_or_settings_bytes() {
        let fixture = Fixture::new();
        let before = fixture.bytes();
        let (code, status, other) = invoke(fixture.arguments(&["status"]));
        assert_eq!(code, 0);
        assert!(other.is_empty());
        assert_eq!(status["cache"]["cachedComplete"], true);
        assert_eq!(status["cache"]["sourceFreshness"], "unverified");
        assert_eq!(status["cache"]["schemaVersion"], "1");
        assert_eq!(status["cache"]["extractorVersion"], "1");
        let (code, search, other) = invoke(fixture.arguments(&[
            "search", "--query", "東京", "--limit", "1", "--offset", "0", "--format", "json",
        ]));
        assert_eq!(code, 0);
        assert!(other.is_empty());
        assert_eq!(search["result"]["hits"][0]["relativePath"], "sample.html");
        assert_eq!(
            search["cache"]["generation"],
            search["result"]["generation"]
        );
        assert_eq!(search["cache"]["generationConsistent"], true);
        assert_eq!(search["cache"]["sourceFreshness"], "unverified");
        let (code, read, other) =
            invoke(fixture.arguments(&["read", "--document-id", &fixture.id, "--max-chars", "2"]));
        assert_eq!(code, 0);
        assert!(other.is_empty());
        assert_eq!(
            read["document"]["text"].as_str().unwrap().chars().count(),
            2
        );
        assert_eq!(read["document"]["truncated"], true);
        assert_eq!(read["document"]["sourceChanged"], false);
        assert!(read["document"]["sourceHash"].as_str().unwrap().len() == 64);
        assert_eq!(fixture.bytes(), before);
    }

    #[test]
    #[ignore = "build knowledge-cli and set KNOWLEDGE_CLI_TEST_BINARY to run process verification"]
    fn process_status_search_read_preserve_fixture_bytes() {
        let fixture = Fixture::new();
        let before = fixture.bytes();
        let binary = std::env::var_os("KNOWLEDGE_CLI_TEST_BINARY")
            .expect("set KNOWLEDGE_CLI_TEST_BINARY to the built CLI");
        for command in [
            vec!["status"],
            vec![
                "search", "--query", "東京", "--limit", "1", "--format", "json",
            ],
            vec![
                "read",
                "--document-id",
                fixture.id.as_str(),
                "--max-chars",
                "2",
            ],
        ] {
            let output = std::process::Command::new(&binary)
                .args(fixture.arguments(&command))
                .output()
                .unwrap();
            assert!(output.status.success());
            assert!(output.stderr.is_empty());
            let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(value["command"], command[0]);
            assert_eq!(value["cache"]["sourceFreshness"], "unverified");
            assert_eq!(fixture.bytes(), before);
        }
    }

    #[test]
    fn search_explicitly_leaves_original_freshness_unverified_and_read_detects_change() {
        let fixture = Fixture::new();
        fs::write(
            fixture.docs.path().join("sample.html"),
            "<title>更新</title><p>大阪 新しい本文</p>",
        )
        .unwrap();
        let before = fixture.bytes();
        let (code, search, _) = invoke(fixture.arguments(&["search", "--query", "東京"]));
        assert_eq!(code, 0);
        assert_eq!(search["cache"]["sourceFreshness"], "unverified");
        assert_eq!(search["result"]["hits"].as_array().unwrap().len(), 1);
        let (code, read, _) = invoke(fixture.arguments(&["read", "--document-id", &fixture.id]));
        assert_eq!(code, 0);
        assert_eq!(read["document"]["sourceChanged"], true);
        assert!(read["document"]["text"].as_str().unwrap().contains("大阪"));
        assert_eq!(fixture.bytes(), before);
    }

    #[test]
    fn missing_cache_is_an_error_and_does_not_create_files() {
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let arguments = vec![
            "--root".into(),
            docs.path().as_os_str().to_owned(),
            "--cache-dir".into(),
            cache.path().as_os_str().to_owned(),
            "search".into(),
            "--query".into(),
            "東京".into(),
        ];
        let (code, error, other) = invoke(arguments);
        assert_eq!(code, 2);
        assert_eq!(error["code"], "index_missing");
        assert!(other.is_empty());
        assert_eq!(fs::read_dir(cache.path()).unwrap().count(), 0);
    }

    #[test]
    fn stale_schema_is_explicit_and_left_unchanged() {
        let fixture = Fixture::new();
        let connection = rusqlite::Connection::open(&fixture.database).unwrap();
        connection
            .execute(
                "UPDATE metadata SET value='obsolete' WHERE key='schema_version'",
                [],
            )
            .unwrap();
        drop(connection);
        let before = fixture.bytes();
        let (code, error, _) = invoke(fixture.arguments(&["search", "--query", "東京"]));
        assert_eq!(code, 2);
        assert_eq!(error["code"], "cache_rebuild_required");
        assert_eq!(fixture.bytes(), before);
    }

    #[test]
    fn document_identifiers_cannot_escape_or_open_another_root() {
        let fixture = Fixture::new();
        let (code, error, _) =
            invoke(fixture.arguments(&["read", "--document-id", &"f".repeat(64)]));
        assert_eq!(code, 2);
        assert_eq!(error["code"], "document_not_indexed");
        let other = tempfile::tempdir().unwrap();
        let mut arguments = fixture.arguments(&["read", "--document-id", &fixture.id]);
        arguments[1] = other.path().as_os_str().to_owned();
        assert_eq!(invoke(arguments).0, 2);
    }

    #[test]
    fn incomplete_and_changed_generation_caches_never_claim_completion() {
        let fixture = Fixture::new();
        let index = ReadOnlyIndex::open(fixture.cache.path(), fixture.docs.path()).unwrap();
        let root_id = index.identifier().to_string();
        let mut store = Store::open(fixture.cache.path(), &root_id).unwrap();
        store.begin_index(2, false).unwrap();
        let (code, status, _) = invoke(fixture.arguments(&["status"]));
        assert_eq!(code, 0);
        assert_eq!(status["cache"]["building"], true);
        assert_eq!(status["cache"]["cachedComplete"], false);
        let mut calls = 0;
        let (_, state) = snapshot(&index, || {
            calls += 1;
            Ok(((), Some(0)))
        })
        .unwrap();
        assert_eq!(calls, 2);
        assert!(!state.generation_consistent && !state.cached_complete && !state.counts.complete);
    }

    #[test]
    fn deleted_cached_hit_returns_error_instead_of_a_successful_stale_result() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.docs.path().join("sample.html")).unwrap();
        let database = fs::read(&fixture.database).unwrap();
        let (code, error, other) = invoke(fixture.arguments(&["search", "--query", "東京"]));
        assert_eq!(code, 2);
        assert!(error.get("code").is_some());
        assert!(other.is_empty());
        assert_eq!(fs::read(&fixture.database).unwrap(), database);
    }

    #[cfg(unix)]
    #[test]
    fn cached_hit_replaced_with_external_link_is_rejected() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("external.html"), "private fixture").unwrap();
        let source = fixture.docs.path().join("sample.html");
        fs::remove_file(&source).unwrap();
        symlink(outside.path().join("external.html"), source).unwrap();
        let database = fs::read(&fixture.database).unwrap();
        for command in [
            vec!["search", "--query", "東京"],
            vec!["read", "--document-id", fixture.id.as_str()],
        ] {
            let (code, error, other) = invoke(fixture.arguments(&command));
            assert_eq!(code, 2);
            assert!(other.is_empty());
            assert!(!error.to_string().contains("private fixture"));
        }
        assert_eq!(fs::read(&fixture.database).unwrap(), database);
    }

    #[cfg(unix)]
    #[test]
    fn opened_adapter_rejects_root_directory_replacement() {
        let fixture = Fixture::new();
        let index = ReadOnlyIndex::open(fixture.cache.path(), fixture.docs.path()).unwrap();
        let moved = fixture.docs.path().with_extension("moved-fixture");
        fs::rename(fixture.docs.path(), &moved).unwrap();
        fs::create_dir(fixture.docs.path()).unwrap();
        fs::write(fixture.docs.path().join("sample.html"), "replacement root").unwrap();
        assert!(snapshot(&index, || index.search("東京", 10, 0).map(|page| {
            let generation = page.generation;
            (page, Some(generation))
        }))
        .is_err());
        fs::remove_dir_all(&moved).unwrap();
    }

    #[test]
    fn backend_and_argument_errors_never_echo_private_paths() {
        let error = backend_error("unexpected /private/example/path secret".into());
        let json = serde_json::to_string(&error).unwrap();
        assert!(!json.contains("private/example") && !json.contains("secret"));
        let (_, error, _) = invoke(args(&["--unexpected-private-path", "/private/example"]));
        assert!(!error.to_string().contains("private/example"));
    }
}
