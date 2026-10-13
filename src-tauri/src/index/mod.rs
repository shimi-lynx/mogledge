//! Derived local search cache. One background worker shares the existing root
//! watcher; renderer/CLI adapters use typed operations rather than SQL strings.
pub mod api;
#[cfg(test)]
mod benchmark;
pub mod cli;
mod extract;
mod highlight;
#[cfg(test)]
mod mutation_tests;
#[cfg(test)]
mod search_benchmark;
mod store;

use store::{DocumentRecord, DocumentState, Store};
pub use store::{SearchHit, SearchMode, SearchPage, StoreCounts};

use crate::knowledge::{self, TreeNode};
use cap_std::fs::Dir;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::Duration,
};

const MAX_DOCUMENTS: usize = 50_000;
const MAX_QUEUED_PATHS: usize = 4_096;
const BATCH_SIZE: usize = 32;
const MAX_READ_CHARS: usize = 65_536;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub request_revision: u64,
    pub workspace_id: String,
    pub root_id: String,
    pub phase: String,
    pub generation: u64,
    pub indexed: u64,
    pub pending: u64,
    pub unavailable: u64,
    pub failed: u64,
    pub truncated: u64,
    pub database_bytes: u64,
    pub complete: bool,
    pub limited: bool,
    pub rebuilt: bool,
    pub error: Option<String>,
}

struct Context {
    workspace_id: String,
    root_id: String,
    root: PathBuf,
    dir: Arc<Dir>,
    epoch: u64,
    paths: Arc<BTreeSet<String>>,
    limited: bool,
    watch_error: bool,
}
struct Request {
    context: Arc<Context>,
    paths: BTreeSet<String>,
    full: bool,
    rebuild: bool,
    serial: u64,
}
#[derive(Default)]
struct State {
    active: Option<Arc<Context>>,
    pending: Option<Request>,
    serial: u64,
    epoch: u64,
    stopped: bool,
    status: IndexStatus,
}
struct Shared {
    cache: PathBuf,
    state: Mutex<State>,
    wake: Condvar,
}

pub struct IndexService {
    shared: Arc<Shared>,
}
impl Drop for IndexService {
    fn drop(&mut self) {
        self.shared.state.lock().unwrap().stopped = true;
        self.shared.wake.notify_one();
    }
}

fn verify_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("Index cache must use an absolute local directory".into());
    }
    #[cfg(windows)]
    knowledge::validate_cache_path(path)
        .map_err(|_| "Index cache must use ordinary local paths")?;
    for ancestor in path.ancestors().filter(|ancestor| ancestor.has_root()) {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) if cache_is_link(&metadata) || !metadata.is_dir() => {
                return Err(
                    "Index cache directory must not contain links or reparse points".into(),
                );
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot inspect index cache directory".into()),
        }
    }
    Ok(())
}
fn cache_is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    false
}
fn root_id(root: &Path) -> String {
    format!("{:x}", Sha256::digest(root.as_os_str().as_encoded_bytes()))
}
fn collect_paths(nodes: &[TreeNode]) -> (BTreeSet<String>, bool) {
    fn visit(nodes: &[TreeNode], paths: &mut BTreeSet<String>, limited: &mut bool) {
        for node in nodes {
            if node.kind == "html" && knowledge::is_html(&node.relative_path) {
                if paths.len() < MAX_DOCUMENTS {
                    paths.insert(node.relative_path.clone());
                } else {
                    *limited = true;
                }
            }
            visit(&node.children, paths, limited);
        }
    }
    let mut paths = BTreeSet::new();
    let mut limited = false;
    visit(nodes, &mut paths, &mut limited);
    (paths, limited)
}

impl IndexService {
    /// Starts one sleeping worker. The application passes its app-local data
    /// directory, never the knowledge root or a document-selected directory.
    pub fn new(cache: PathBuf) -> Result<Arc<Self>, String> {
        if !cache.is_absolute() {
            return Err("Index cache directory must be absolute".into());
        }
        verify_directory(&cache)?;
        fs::create_dir_all(&cache).map_err(|_| "Cannot create index cache directory")?;
        verify_directory(&cache)?;
        let cache = cache
            .canonicalize()
            .map_err(|_| "Cannot resolve index cache directory")?;
        let shared = Arc::new(Shared {
            cache,
            state: Mutex::new(State::default()),
            wake: Condvar::new(),
        });
        let worker = shared.clone();
        thread::Builder::new()
            .name("knowledge-index".into())
            .spawn(move || run(worker))
            .map_err(|_| "Cannot start index worker")?;
        Ok(Arc::new(Self { shared }))
    }

    pub fn select(
        &self,
        workspace_id: &str,
        root: PathBuf,
        dir: Arc<Dir>,
        nodes: &[TreeNode],
        watch_error: bool,
    ) {
        let (paths, limited) = collect_paths(nodes);
        let mut state = self.shared.state.lock().unwrap();
        state.epoch += 1;
        state.serial += 1;
        let context = Arc::new(Context {
            workspace_id: workspace_id.into(),
            root_id: root_id(&root),
            root,
            dir,
            epoch: state.epoch,
            paths: Arc::new(paths),
            limited,
            watch_error,
        });
        state.status = IndexStatus {
            request_revision: state.serial,
            workspace_id: workspace_id.into(),
            root_id: context.root_id.clone(),
            phase: "pending".into(),
            limited,
            pending: context.paths.len() as u64,
            ..Default::default()
        };
        state.active = Some(context.clone());
        if self.shared.cache.starts_with(&context.root)
            || context.root.starts_with(&self.shared.cache)
        {
            state.pending = None;
            state.status.phase = "failed".into();
            state.status.error =
                Some("Index cache and knowledge root must be separate directories".into());
            return;
        }
        state.pending = Some(Request {
            context,
            paths: BTreeSet::new(),
            full: true,
            rebuild: false,
            serial: state.serial,
        });
        self.shared.wake.notify_one();
    }

    /// Existing watcher calls this after its tree update. A structure change or
    /// watcher error reconciles all hashes, including missed/reordered events.
    pub fn changed(
        &self,
        workspace_id: &str,
        paths: &[String],
        nodes: &[TreeNode],
        reconcile: bool,
        watch_error: bool,
    ) {
        let mut candidates = BTreeSet::new();
        let mut input_exceeded = false;
        for (seen, path) in paths
            .iter()
            .filter(|path| knowledge::is_html(path) && knowledge::validate_relative(path).is_ok())
            .enumerate()
        {
            if seen == MAX_QUEUED_PATHS {
                input_exceeded = true;
                break;
            }
            candidates.insert(path.clone());
        }
        if !reconcile && candidates.is_empty() {
            return;
        }
        let mut state = self.shared.state.lock().unwrap();
        let Some(previous) = state
            .active
            .clone()
            .filter(|c| c.workspace_id == workspace_id)
        else {
            return;
        };
        if self.shared.cache.starts_with(&previous.root)
            || previous.root.starts_with(&self.shared.cache)
        {
            return;
        }
        let (all_paths, limited) = if reconcile {
            let (paths, limited) = collect_paths(nodes);
            (Arc::new(paths), limited)
        } else {
            (previous.paths.clone(), previous.limited)
        };
        let context = Arc::new(Context {
            paths: all_paths,
            limited,
            watch_error,
            workspace_id: previous.workspace_id.clone(),
            root_id: previous.root_id.clone(),
            root: previous.root.clone(),
            dir: previous.dir.clone(),
            epoch: previous.epoch,
        });
        state.serial += 1;
        let serial = state.serial;
        let request = state.pending.get_or_insert_with(|| Request {
            context: context.clone(),
            paths: BTreeSet::new(),
            full: false,
            rebuild: false,
            serial,
        });
        request.context = context.clone();
        request.serial = serial;
        request.full |= reconcile || input_exceeded;
        for path in candidates {
            request.paths.insert(path);
            if request.paths.len() > MAX_QUEUED_PATHS {
                request.paths.clear();
                request.full = true;
                break;
            }
        }
        state.active = Some(context);
        state.status.request_revision = serial;
        state.status.complete = false;
        state.status.phase = "pending".into();
        self.shared.wake.notify_one();
    }

    pub fn status(&self, workspace_id: &str) -> Result<IndexStatus, String> {
        let state = self.shared.state.lock().unwrap();
        if state.active.as_ref().map(|c| c.workspace_id.as_str()) != Some(workspace_id) {
            return Err("WorkspaceChanged".into());
        }
        Ok(state.status.clone())
    }
    pub fn rebuild(&self, workspace_id: &str) -> Result<IndexStatus, String> {
        let context = self.context(workspace_id)?;
        let mut state = self.shared.state.lock().unwrap();
        if state.active.as_ref().map(|active| active.epoch) != Some(context.epoch) {
            return Err("WorkspaceChanged".into());
        }
        state.serial += 1;
        state.status.request_revision = state.serial;
        state.status.phase = "pending".into();
        state.status.complete = false;
        state.status.error = None;
        state.pending = Some(Request {
            context,
            paths: BTreeSet::new(),
            full: true,
            rebuild: true,
            serial: state.serial,
        });
        self.shared.wake.notify_one();
        Ok(state.status.clone())
    }
    fn context(&self, workspace_id: &str) -> Result<Arc<Context>, String> {
        let context = self
            .shared
            .state
            .lock()
            .unwrap()
            .active
            .clone()
            .filter(|c| c.workspace_id == workspace_id)
            .ok_or_else(|| "WorkspaceChanged".to_string())?;
        if self.shared.cache.starts_with(&context.root)
            || context.root.starts_with(&self.shared.cache)
        {
            return Err("Index cache and knowledge root must be separate directories".into());
        }
        Ok(context)
    }
    pub fn search(
        &self,
        workspace_id: &str,
        query: &str,
        limit: u32,
        offset: u32,
    ) -> Result<SearchPage, String> {
        self.search_with_mode(workspace_id, query, limit, offset, SearchMode::And)
    }
    pub fn search_with_mode(
        &self,
        workspace_id: &str,
        query: &str,
        limit: u32,
        offset: u32,
        mode: SearchMode,
    ) -> Result<SearchPage, String> {
        self.search_with_scope(workspace_id, query, limit, offset, mode, None)
    }

    pub fn search_with_scope(
        &self,
        workspace_id: &str,
        query: &str,
        limit: u32,
        offset: u32,
        mode: SearchMode,
        scope: Option<&str>,
    ) -> Result<SearchPage, String> {
        let context = self.context(workspace_id)?;
        let serial = self.shared.state.lock().unwrap().serial;
        let mut result = Store::search_with_scope(
            &self.shared.cache,
            &context.root_id,
            query,
            limit,
            offset,
            mode,
            scope,
        )?;
        if self.context(workspace_id)?.epoch != context.epoch {
            return Err("WorkspaceChanged".into());
        }
        if self.shared.state.lock().unwrap().serial != serial {
            return Err("IndexChanged".into());
        }
        result.request_revision = serial;
        Ok(result)
    }
    pub fn read_document(
        &self,
        workspace_id: &str,
        document_id: &str,
        max_chars: usize,
    ) -> Result<DocumentText, String> {
        let context = self.context(workspace_id)?;
        let result = read_document(
            &self.shared.cache,
            &context.root_id,
            &context.root,
            &context.dir,
            document_id,
            max_chars,
        )?;
        if self.context(workspace_id)?.epoch != context.epoch {
            return Err("WorkspaceChanged".into());
        }
        Ok(result)
    }
}

/// On-demand adapter foundation: no worker, watcher, settings write, DB creation,
/// schema migration or rebuild. Missing/stale cache returns an explicit error.
pub struct ReadOnlyIndex {
    cache: PathBuf,
    root: PathBuf,
    dir: Arc<Dir>,
    root_id: String,
}
impl ReadOnlyIndex {
    pub fn identifier(&self) -> &str {
        &self.root_id
    }
    pub fn versions(&self) -> (&'static str, &'static str) {
        (store::SCHEMA_VERSION, store::EXTRACTOR_VERSION)
    }
    pub fn open(cache: &Path, root: &Path) -> Result<Self, String> {
        verify_directory(cache)?;
        let cache = cache.canonicalize().map_err(|_| "Index cache is missing")?;
        let (root, dir) = knowledge::open_root(root)?;
        if cache.starts_with(&root) || root.starts_with(&cache) {
            return Err("Index cache and knowledge root must be separate directories".into());
        }
        let root_id = root_id(&root);
        Ok(Self {
            cache,
            root,
            dir,
            root_id,
        })
    }
    pub fn status(&self) -> Result<(StoreCounts, u64), String> {
        Store::inspect(&self.cache, &self.root_id)
    }
    pub fn search(&self, query: &str, limit: u32, offset: u32) -> Result<SearchPage, String> {
        api::verify_root(&self.root, &self.dir)?;
        let page = Store::search(&self.cache, &self.root_id, query, limit, offset)?;
        for hit in &page.hits {
            knowledge::validate_cached_path(&self.root, &self.dir, &hit.relative_path)?;
        }
        api::verify_root(&self.root, &self.dir)?;
        Ok(page)
    }
    pub fn read_document(
        &self,
        document_id: &str,
        max_chars: usize,
    ) -> Result<DocumentText, String> {
        read_document(
            &self.cache,
            &self.root_id,
            &self.root,
            &self.dir,
            document_id,
            max_chars,
        )
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentText {
    pub document_id: String,
    pub relative_path: String,
    pub title: String,
    pub text: String,
    pub truncated: bool,
    pub source_changed: bool,
    pub source_hash: String,
}
fn read_document(
    cache: &Path,
    root_id: &str,
    root: &Path,
    dir: &Dir,
    document_id: &str,
    max_chars: usize,
) -> Result<DocumentText, String> {
    if max_chars == 0 || max_chars > MAX_READ_CHARS {
        return Err("Document text limit must be 1..65536 characters".into());
    }
    let record = Store::lookup(cache, root_id, document_id)?
        .ok_or("Document is absent from this root index")?;
    let (bytes, _, _) = read_stable(root, dir, &record.relative_path)?;
    let hash = format!("{:x}", Sha256::digest(&bytes));
    let html = std::str::from_utf8(&bytes).map_err(|_| "HTML must be UTF-8")?;
    let extracted = extract::extract(html);
    let truncated = extracted.truncated || extracted.body.chars().count() > max_chars;
    Ok(DocumentText {
        document_id: document_id.into(),
        relative_path: record.relative_path,
        title: extracted.title,
        text: extracted.body.chars().take(max_chars).collect(),
        truncated,
        source_changed: record.source_hash.as_deref() != Some(&hash),
        source_hash: hash,
    })
}

fn read_stable(
    root: &Path,
    dir: &Dir,
    relative: &str,
) -> Result<(Vec<u8>, u64, Option<String>), String> {
    for attempt in 0..2 {
        // Both byte and metadata reads remain inside the shared safe file-open
        // boundary. Compare contents as well, catching same-size/same-time edits.
        let before = knowledge::read_source(root, dir, relative)?;
        let first_hash = Sha256::digest(&before.data);
        let first_size = before.data.len();
        let modified = before.modified_ns;
        drop(before.data);
        let after = knowledge::read_source(root, dir, relative)?;
        if first_size == after.data.len()
            && modified == after.modified_ns
            && first_hash == Sha256::digest(&after.data)
        {
            return Ok((after.data, first_size as u64, modified));
        }
        if attempt == 0 {
            thread::sleep(Duration::from_millis(50));
        }
    }
    Err("HTML source changed during indexing; refresh or the next watcher event retries it".into())
}
fn record(
    context: &Context,
    relative: &str,
    store: &Store,
) -> Result<Option<DocumentRecord>, String> {
    let result = read_stable(&context.root, &context.dir, relative);
    let (bytes, size, modified_ns) = match result {
        Ok(value) => value,
        Err(error) => {
            // #5 supplies conservative no-hydration errors through the same
            // knowledge helper after merge. Never bypass it to acquire content.
            let unavailable =
                error.contains("クラウド") || error.contains("未取得") || error.contains("offline");
            return Ok(Some(DocumentRecord {
                relative_path: relative.into(),
                title: String::new(),
                headings: String::new(),
                body: String::new(),
                source_hash: None,
                source_size: 0,
                modified_ns: None,
                state: if unavailable {
                    DocumentState::Unavailable
                } else {
                    DocumentState::Failed
                },
                truncated: false,
            }));
        }
    };
    let hash = format!("{:x}", Sha256::digest(&bytes));
    if store.hash_for(relative)?.as_deref() == Some(&hash) {
        return Ok(None);
    }
    let html = match std::str::from_utf8(&bytes) {
        Ok(html) => html,
        Err(_) => {
            return Ok(Some(DocumentRecord {
                relative_path: relative.into(),
                title: String::new(),
                headings: String::new(),
                body: String::new(),
                source_hash: None,
                source_size: size,
                modified_ns,
                state: DocumentState::Failed,
                truncated: false,
            }))
        }
    };
    let extracted = extract::extract(html);
    Ok(Some(DocumentRecord {
        relative_path: relative.into(),
        title: extracted.title,
        headings: extracted.headings,
        body: extracted.body,
        source_hash: Some(hash),
        source_size: size,
        modified_ns,
        state: DocumentState::Ready,
        truncated: extracted.truncated,
    }))
}

fn run(shared: Arc<Shared>) {
    loop {
        let request = {
            let mut state = shared.state.lock().unwrap();
            while state.pending.is_none() && !state.stopped {
                state = shared.wake.wait(state).unwrap();
            }
            if state.stopped {
                return;
            }
            let request = state.pending.take().unwrap();
            state.status.phase = "building".into();
            request
        };
        if let Err(error) = process(&shared, &request) {
            let mut state = shared.state.lock().unwrap();
            if state.serial == request.serial {
                state.status.phase = "failed".into();
                state.status.complete = false;
                state.status.error = Some(error);
            }
        }
    }
}
fn is_current(shared: &Shared, request: &Request) -> bool {
    let state = shared.state.lock().unwrap();
    !state.stopped && state.serial == request.serial
}
fn process(shared: &Shared, request: &Request) -> Result<(), String> {
    if !is_current(shared, request) {
        return Ok(());
    }
    verify_directory(&shared.cache)?;
    let mut store = Store::open(&shared.cache, &request.context.root_id)?;
    let full = request.full || store.rebuilt || store.generation()? == 0;
    store.begin_index(
        request.context.paths.len() as u64,
        request.context.limited || request.context.watch_error,
    )?;
    if request.rebuild {
        store.clear_for_rebuild()?;
    }
    let paths: &BTreeSet<String> = if full {
        &request.context.paths
    } else {
        &request.paths
    };
    if full {
        store.retain_paths(&request.context.paths)?;
    }
    // Pending removes stale searchable text before attempting changed content.
    if !full {
        store.mark_pending(&request.paths)?;
    }
    let paths: Vec<_> = paths.iter().collect();
    for (batch_number, batch) in paths.chunks(BATCH_SIZE).enumerate() {
        let mut records = Vec::new();
        for path in batch {
            if !is_current(shared, request) {
                requeue_remaining(shared, request, &paths[batch_number * BATCH_SIZE..]);
                return Ok(());
            }
            if request.context.paths.contains(*path) {
                if let Some(record) = record(&request.context, path, &store)? {
                    records.push(record);
                }
            }
        }
        // Selection/change and commit share this short gate. No HTML I/O is
        // performed under it; an obsolete root/batch cannot publish afterward.
        let mut state = shared.state.lock().unwrap();
        if state.stopped || state.serial != request.serial {
            drop(state);
            requeue_remaining(shared, request, &paths[batch_number * BATCH_SIZE..]);
            return Ok(());
        }
        if !records.is_empty() {
            store.apply(&records)?;
        }
        update_counts(&mut state.status, &store)?;
        state.status.pending = state
            .status
            .pending
            .max((paths.len() - ((batch_number + 1) * BATCH_SIZE).min(paths.len())) as u64);
        state.status.rebuilt |= store.rebuilt || request.rebuild;
    }
    let mut state = shared.state.lock().unwrap();
    if state.serial == request.serial && !state.stopped {
        update_counts(&mut state.status, &store)?;
        state.status.phase = "ready".into();
        state.status.limited = request.context.limited;
        state.status.complete = !request.context.limited
            && !request.context.watch_error
            && state.status.failed == 0
            && state.status.unavailable == 0
            && state.status.pending == 0
            && state.status.truncated == 0
            && state.status.indexed == request.context.paths.len() as u64;
        store.finish_index(state.status.complete)?;
        state.status.error = request
            .context
            .watch_error
            .then(|| "Watcher error: refresh required for complete reconciliation".into());
        state.status.rebuilt |= store.rebuilt;
        // Publish ready only after releasing SQLite's file handle as well.
        drop(store);
    }
    Ok(())
}
fn update_counts(status: &mut IndexStatus, store: &Store) -> Result<(), String> {
    let counts = store.counts()?;
    status.indexed = counts.indexed;
    status.pending = counts.pending;
    status.failed = counts.failed;
    status.unavailable = counts.unavailable;
    status.truncated = counts.truncated;
    status.database_bytes = counts.database_bytes;
    status.generation = store.generation()?;
    Ok(())
}
fn requeue_remaining(shared: &Shared, request: &Request, paths: &[&String]) {
    let mut state = shared.state.lock().unwrap();
    if state.stopped || state.active.as_ref().map(|c| c.epoch) != Some(request.context.epoch) {
        return;
    }
    let Some(pending) = &mut state.pending else {
        return;
    };
    for path in paths {
        pending.paths.insert((*path).clone());
        if pending.paths.len() > MAX_QUEUED_PATHS {
            pending.paths.clear();
            pending.full = true;
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn wait(service: &IndexService, id: &str) -> IndexStatus {
        let started = Instant::now();
        loop {
            let status = service.status(id).unwrap();
            if matches!(status.phase.as_str(), "ready" | "failed") {
                return status;
            }
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "index did not finish: {status:?}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn select(service: &IndexService, id: &str, root: &Path) {
        let (root, dir) = knowledge::open_root(root).unwrap();
        let nodes = knowledge::scan(&root).unwrap();
        service.select(id, root, dir, &nodes, false);
    }
    fn changed(service: &IndexService, id: &str, root: &Path, paths: &[&str], full: bool) {
        let nodes = knowledge::scan(root).unwrap();
        service.changed(
            id,
            &paths.iter().map(|p| p.to_string()).collect::<Vec<_>>(),
            &nodes,
            full,
            false,
        );
    }
    #[test]
    fn updates_moves_deletes_and_restart_reconcile_without_events() {
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(
            docs.path().join("old.html"),
            "<title>資料</title><h1>日本語</h1>東京",
        )
        .unwrap();
        let service = IndexService::new(cache.path().to_path_buf()).unwrap();
        select(&service, "one", docs.path());
        assert!(wait(&service, "one").complete);
        assert_eq!(service.search("one", "東京", 10, 0).unwrap().hits.len(), 1);
        fs::write(
            docs.path().join("old.html"),
            "<title>資料</title><h1>日本語</h1>京都",
        )
        .unwrap();
        changed(
            &service,
            "one",
            docs.path(),
            &["old.html", "old.html"],
            false,
        );
        wait(&service, "one");
        assert!(service
            .search("one", "東京", 10, 0)
            .unwrap()
            .hits
            .is_empty());
        fs::create_dir(docs.path().join("folder")).unwrap();
        fs::rename(
            docs.path().join("old.html"),
            docs.path().join("folder/new.html"),
        )
        .unwrap();
        changed(
            &service,
            "one",
            docs.path(),
            &["old.html", "folder/new.html"],
            true,
        );
        wait(&service, "one");
        let hit = service.search("one", "京都", 10, 0).unwrap().hits.remove(0);
        assert_eq!(hit.relative_path, "folder/new.html");
        fs::write(
            docs.path().join("folder/new.html"),
            "<title>資料</title><h1>日本語</h1>大阪",
        )
        .unwrap();
        // Restart reconciliation hashes actual content even if no watch event arrived.
        select(&service, "restart", docs.path());
        wait(&service, "restart");
        assert!(service
            .search("restart", "京都", 10, 0)
            .unwrap()
            .hits
            .is_empty());
        assert_eq!(
            service.search("restart", "大阪", 10, 0).unwrap().hits.len(),
            1
        );
        fs::remove_file(docs.path().join("folder/new.html")).unwrap();
        changed(&service, "restart", docs.path(), &["folder/new.html"], true);
        assert_eq!(wait(&service, "restart").indexed, 0);
    }
    #[test]
    fn roots_and_document_identifiers_are_isolated_and_reads_validate_original() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(a.path().join("same.html"), "<title>A</title>東京").unwrap();
        fs::write(b.path().join("same.html"), "<title>B</title>大阪").unwrap();
        let service = IndexService::new(cache.path().to_path_buf()).unwrap();
        select(&service, "a", a.path());
        wait(&service, "a");
        let hit = service.search("a", "東京", 1, 0).unwrap().hits.remove(0);
        fs::write(a.path().join("same.html"), "<title>A</title>京都").unwrap();
        let original = service.read_document("a", &hit.document_id, 1).unwrap();
        assert!(original.source_changed && original.truncated);
        let reader = ReadOnlyIndex::open(cache.path(), a.path()).unwrap();
        assert_eq!(reader.status().unwrap().0.indexed, 1);
        assert!(reader.read_document("../../escape", 10).is_err());
        select(&service, "b", b.path());
        wait(&service, "b");
        assert!(service.status("a").is_err());
        assert!(service.search("b", "東京", 10, 0).unwrap().hits.is_empty());
        assert!(service.read_document("b", &hit.document_id, 10).is_err());
    }
    #[test]
    fn corrupt_cache_rebuilds_without_modifying_sources_and_bad_utf8_is_partial() {
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let original = b"<title>Good</title>Japanese";
        fs::write(docs.path().join("good.html"), original).unwrap();
        fs::write(docs.path().join("bad.html"), [0xff, 0xfe]).unwrap();
        let service = IndexService::new(cache.path().to_path_buf()).unwrap();
        select(&service, "one", docs.path());
        let status = wait(&service, "one");
        assert_eq!((status.indexed, status.failed), (1, 1));
        assert!(!status.complete);
        let path = cache
            .path()
            .join(format!("index-{}.sqlite3", status.root_id));
        fs::write(path, "broken sqlite").unwrap();
        select(&service, "two", docs.path());
        assert!(wait(&service, "two").rebuilt);
        assert_eq!(fs::read(docs.path().join("good.html")).unwrap(), original);
    }
    #[test]
    fn incremental_update_rebuilds_entire_missing_or_corrupt_cache() {
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(docs.path().join("a.html"), "alpha source").unwrap();
        fs::write(docs.path().join("b.html"), "beta source").unwrap();
        let service = IndexService::new(cache.path().to_path_buf()).unwrap();
        select(&service, "one", docs.path());
        let status = wait(&service, "one");
        let path = cache
            .path()
            .join(format!("index-{}.sqlite3", status.root_id));
        for corrupt in [true, false] {
            if corrupt {
                fs::write(&path, "broken").unwrap();
            } else {
                fs::remove_file(&path).unwrap();
            }
            changed(&service, "one", docs.path(), &["a.html"], false);
            let status = wait(&service, "one");
            assert!(status.complete);
            assert_eq!(status.indexed, 2);
            assert_eq!(service.search("one", "beta", 10, 0).unwrap().hits.len(), 1);
        }
        let generation = service.status("one").unwrap().generation;
        changed(
            &service,
            "one",
            docs.path(),
            &["style.css", "image.png"],
            false,
        );
        assert_eq!(service.status("one").unwrap().generation, generation);
        assert_eq!(service.status("one").unwrap().phase, "ready");
    }
    #[test]
    fn initial_database_lock_failure_retries_on_next_html_event() {
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(docs.path().join("a.html"), "first content").unwrap();
        let (root, _) = knowledge::open_root(docs.path()).unwrap();
        drop(Store::open(cache.path(), &root_id(&root)).unwrap());
        let path = cache
            .path()
            .join(format!("index-{}.sqlite3", root_id(&root)));
        let connection = rusqlite::Connection::open(path).unwrap();
        connection.execute_batch("BEGIN EXCLUSIVE").unwrap();
        let service = IndexService::new(cache.path().to_path_buf()).unwrap();
        select(&service, "one", docs.path());
        assert_eq!(wait(&service, "one").phase, "failed");
        connection.execute_batch("ROLLBACK").unwrap();
        fs::write(docs.path().join("a.html"), "updated content").unwrap();
        changed(&service, "one", docs.path(), &["a.html"], false);
        assert!(wait(&service, "one").complete);
        assert_eq!(
            service.search("one", "updated", 10, 0).unwrap().hits.len(),
            1
        );
    }
    #[test]
    fn duplicated_event_overflow_reconciles_paths_beyond_the_cutoff() {
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(docs.path().join("a.html"), "alpha source").unwrap();
        fs::write(docs.path().join("b.html"), "before source").unwrap();
        let service = IndexService::new(cache.path().to_path_buf()).unwrap();
        select(&service, "one", docs.path());
        wait(&service, "one");
        fs::write(docs.path().join("b.html"), "after source").unwrap();
        let mut events = vec!["a.html".to_string(); MAX_QUEUED_PATHS + 1];
        events.push("b.html".into());
        service.changed(
            "one",
            &events,
            &knowledge::scan(docs.path()).unwrap(),
            false,
            false,
        );
        assert!(wait(&service, "one").complete);
        assert!(service
            .search("one", "before", 10, 0)
            .unwrap()
            .hits
            .is_empty());
        assert_eq!(service.search("one", "after", 10, 0).unwrap().hits.len(), 1);
    }
    #[test]
    fn utf8_size_boundary_failure_and_same_timestamp_edit_recover() {
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let path = docs.path().join("a.html");
        fs::write(&path, "東京").unwrap();
        let original_time = fs::metadata(&path).unwrap().modified().unwrap();
        let service = IndexService::new(cache.path().to_path_buf()).unwrap();
        select(&service, "one", docs.path());
        wait(&service, "one");
        fs::write(&path, "京都").unwrap();
        fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(original_time))
            .unwrap();
        select(&service, "two", docs.path());
        assert!(wait(&service, "two").complete);
        assert_eq!(service.search("two", "京都", 10, 0).unwrap().hits.len(), 1);
        fs::write(&path, vec![b'x'; 32 * 1024 * 1024 + 1]).unwrap();
        changed(&service, "two", docs.path(), &["a.html"], false);
        let status = wait(&service, "two");
        assert_eq!(status.failed, 1);
        assert!(!status.complete);
        assert!(service
            .search("two", "京都", 10, 0)
            .unwrap()
            .hits
            .is_empty());
        fs::write(&path, "<h1>正常な更新</h1>").unwrap();
        changed(&service, "two", docs.path(), &["a.html"], false);
        assert!(wait(&service, "two").complete);
    }
    #[test]
    fn existing_core_watcher_indexes_atomic_save_and_folder_rename() {
        use crate::core::Core;
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::create_dir(docs.path().join("old")).unwrap();
        fs::write(docs.path().join("old/a.html"), "最初の本文").unwrap();
        let service = IndexService::new(cache.path().to_path_buf()).unwrap();
        let core = Core::new(1234);
        assert!(core.index.set(service.clone()).is_ok());
        let snapshot = core.select(docs.path(), false).unwrap();
        let id = snapshot.workspace_id.unwrap();
        wait(&service, &id);
        fs::write(docs.path().join("old/a.tmp"), "保存後の本文").unwrap();
        fs::rename(
            docs.path().join("old/a.tmp"),
            docs.path().join("old/a.html"),
        )
        .unwrap();
        fs::rename(docs.path().join("old"), docs.path().join("new")).unwrap();
        let started = Instant::now();
        loop {
            let hits = service
                .search(&id, "保存後", 10, 0)
                .map(|page| page.hits)
                .unwrap_or_default();
            if hits.len() == 1 && hits[0].relative_path == "new/a.html" {
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "watcher did not update index"
            );
            thread::sleep(Duration::from_millis(20));
        }
        assert!(core.workspace.lock().unwrap().tabs.is_empty());
    }
    #[test]
    fn rapid_root_switch_and_coalesced_changes_finish_on_latest_root() {
        let docs = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        for number in 0..80 {
            fs::write(
                docs.path().join(format!("{number}.html")),
                "日本語資料".repeat(100),
            )
            .unwrap();
        }
        fs::write(other.path().join("latest.html"), "最終資料").unwrap();
        let service = IndexService::new(cache.path().to_path_buf()).unwrap();
        select(&service, "first", docs.path());
        select(&service, "second", other.path());
        for _ in 0..10 {
            changed(&service, "second", other.path(), &["latest.html"], false);
        }
        assert_eq!(wait(&service, "second").indexed, 1);
        assert!(service.search("first", "日本", 10, 0).is_err());
        assert_eq!(
            service.search("second", "最終", 10, 0).unwrap().hits.len(),
            1
        );
    }
    #[test]
    fn cache_inside_source_is_refused_and_readonly_never_creates_cache() {
        let docs = tempfile::tempdir().unwrap();
        let cache = docs.path().join("derived");
        let service = IndexService::new(cache.clone()).unwrap();
        select(&service, "one", docs.path());
        assert_eq!(wait(&service, "one").phase, "failed");
        let missing = docs.path().join("missing-cache");
        assert!(ReadOnlyIndex::open(&missing, docs.path()).is_err());
        assert!(!missing.exists());
    }
    #[cfg(unix)]
    #[test]
    fn source_links_are_not_indexed_and_later_link_replacements_clear_content() {
        use std::os::unix::fs::symlink;
        let docs = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.html"), "private outside source").unwrap();
        fs::write(docs.path().join("good.html"), "safe source").unwrap();
        symlink(
            outside.path().join("secret.html"),
            docs.path().join("link.html"),
        )
        .unwrap();
        let service = IndexService::new(cache.path().to_path_buf()).unwrap();
        select(&service, "one", docs.path());
        assert_eq!(wait(&service, "one").indexed, 1);
        fs::remove_file(docs.path().join("good.html")).unwrap();
        symlink(
            outside.path().join("secret.html"),
            docs.path().join("good.html"),
        )
        .unwrap();
        changed(&service, "one", docs.path(), &["good.html"], true);
        assert_eq!(wait(&service, "one").indexed, 0);
        assert!(service
            .search("one", "outside", 10, 0)
            .unwrap()
            .hits
            .is_empty());
    }
}
