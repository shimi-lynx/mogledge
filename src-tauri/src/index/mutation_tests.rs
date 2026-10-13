//! Integration checks of the real Core, native mutations and shared index worker.
//! Fixtures are synthetic; the OS watcher is dropped to prove direct queueing.
use super::{IndexService, IndexStatus, SearchPage};
use crate::{
    core::{Core, Snapshot},
    tree_mutations::{self, Mutation, MutationResult},
};
use std::{
    fs,
    path::PathBuf,
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

struct Fixture {
    // Stop Core/IndexService before removing the temporary source and cache dirs.
    core: Arc<Core>,
    index: Arc<IndexService>,
    _temporary: tempfile::TempDir,
    root: PathBuf,
    cache: PathBuf,
    settings: PathBuf,
    snapshot: Snapshot,
}
impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("documents");
        let cache = temporary.path().join("cache");
        let config = temporary.path().join("config");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&config).unwrap();
        fs::create_dir(root.join("Folder")).unwrap();
        fs::create_dir(root.join("Target")).unwrap();
        for (relative, marker) in [
            ("a.html", "東京単独"),
            ("b.html", "大阪単独"),
            ("c.html", "京都単独"),
            ("Folder/nested.html", "名古屋単独"),
        ] {
            fs::write(root.join(relative),format!("<!doctype html><meta charset=\"utf-8\"><title>{marker}</title><body>共通本文 {marker}</body>")).unwrap();
        }
        let settings = config.join("settings.json");
        fs::write(&settings, b"{\"fixture\":true}").unwrap();
        let core = Core::new(19070);
        core.settings_path.set(settings.clone()).unwrap();
        let index = IndexService::new(cache.clone()).unwrap();
        assert!(core.index.set(index.clone()).is_ok());
        let snapshot = core.select(&root, false).unwrap();
        drop(core.watcher.lock().unwrap().take());
        let fixture = Self {
            core,
            index,
            _temporary: temporary,
            root,
            cache,
            settings,
            snapshot,
        };
        assert!(fixture.wait().complete);
        fixture
    }
    fn workspace(&self) -> &str {
        self.snapshot.workspace_id.as_deref().unwrap()
    }
    fn status(&self) -> IndexStatus {
        self.index.status(self.workspace()).unwrap()
    }
    fn wait(&self) -> IndexStatus {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let status = self.status();
            if status.phase == "ready" {
                assert!(status.error.is_none(), "index failed");
                return status;
            }
            assert_ne!(status.phase, "failed", "index failed");
            assert!(Instant::now() < deadline, "index did not become ready");
            thread::sleep(Duration::from_millis(5));
        }
    }
    fn perform(&self, mutation: Mutation) -> MutationResult {
        let result = tree_mutations::perform(
            &self.core,
            self.workspace(),
            &self.snapshot.view_id,
            mutation,
        )
        .unwrap();
        assert!(result.warning.is_none(), "native operation warned");
        result
    }
    fn search(&self, query: &str) -> SearchPage {
        super::api::search(&self.core, self.workspace(), query, 100, 0).unwrap()
    }
    fn database(&self) -> PathBuf {
        self.cache
            .join(format!("index-{}.sqlite3", self.status().root_id))
    }
    fn grant(&self, relative: &str, browser: bool) -> (String, String) {
        let tab = if browser {
            self.core
                .browser_tab(self.workspace(), &self.snapshot.view_id, relative)
                .unwrap()
                .0
        } else {
            self.core
                .create_tab(self.workspace(), &self.snapshot.view_id, relative)
                .unwrap()
        };
        self.core
            .open(self.workspace(), &self.snapshot.view_id, &tab, 1)
            .unwrap();
        let token = self.core.workspace.lock().unwrap().tabs[&tab]
            .session
            .as_ref()
            .unwrap()
            .token
            .clone();
        (tab, token)
    }
    fn assert_remapped_revoked(&self, tab: &str, old_token: &str, expected: &str) {
        assert!(self.core.session_for_token(old_token).is_none());
        let state = self.core.workspace.lock().unwrap();
        assert_eq!(state.tabs[tab].entry, expected);
        assert!(state.tabs[tab].session.is_none());
        assert!(state.tabs[tab].revocation > 0);
    }
}

#[test]
fn native_create_queues_title_index_before_a_suppressed_watcher_echo() {
    let fixture = Fixture::new();
    let before = fixture.status();
    let result = fixture.perform(Mutation::CreateHtml {
        parent: String::new(),
        name: "新規資料題名".into(),
    });
    let relative = result.created_path.unwrap();
    assert_eq!(relative, "新規資料題名.html");
    assert!(fixture.core.watcher.lock().unwrap().is_none());
    let queued = fixture.status().request_revision;
    assert!(
        queued > before.request_revision,
        "native operation must directly queue the index"
    );
    let revision = fixture.core.snapshot().revision;
    fixture
        .core
        .apply_change(fixture.workspace(), vec![relative.clone()], true, None);
    assert_eq!(
        fixture.core.snapshot().revision,
        revision,
        "unchanged native echo must be suppressed"
    );
    assert_eq!(fixture.status().request_revision, queued);
    assert!(fixture.wait().complete);
    let page = fixture.search("新規資料題名");
    assert_eq!(page.hits.len(), 1);
    assert_eq!(page.hits[0].relative_path, relative);
    assert_eq!(page.hits[0].title, "新規資料題名");
    assert_eq!(page.request_revision, queued);
}

#[test]
fn native_file_and_folder_moves_replace_index_ids_remap_tabs_and_revoke_old_grants() {
    let fixture = Fixture::new();
    for (source, parent, query, destination) in [
        ("a.html", "Target", "東京単独", "Target/a.html"),
        (
            "Folder",
            "Target",
            "名古屋単独",
            "Target/Folder/nested.html",
        ),
    ] {
        let before = fixture.search(query).hits.remove(0);
        let original = fs::read(fixture.root.join(&before.relative_path)).unwrap();
        let (tab, token) = fixture.grant(&before.relative_path, false);
        let (browser, browser_token) = fixture.grant(&before.relative_path, true);
        let previous = fixture.status().request_revision;
        let result = fixture.perform(Mutation::Move {
            source: source.into(),
            parent: parent.into(),
            anchor: None,
            after: false,
        });
        assert_eq!(result.moves.len(), 1);
        assert!(fixture.status().request_revision > previous);
        fixture.assert_remapped_revoked(&tab, &token, destination);
        fixture.assert_remapped_revoked(&browser, &browser_token, destination);
        assert!(fixture.wait().complete);
        let after = fixture.search(query).hits.remove(0);
        assert_eq!(after.relative_path, destination);
        assert_ne!(after.document_id, before.document_id);
        assert!(fixture
            .index
            .read_document(fixture.workspace(), &before.document_id, 100)
            .is_err());
        assert_eq!(fs::read(fixture.root.join(destination)).unwrap(), original);
        assert!(!fixture.root.join(&before.relative_path).exists());
        fixture
            .core
            .open(fixture.workspace(), &fixture.snapshot.view_id, &tab, 2)
            .unwrap();
        assert_eq!(
            fixture.core.workspace.lock().unwrap().tabs[&tab]
                .session
                .as_ref()
                .unwrap()
                .entry,
            destination
        );
    }
    assert_eq!(fixture.status().indexed, 4);
}

#[test]
fn native_reorder_changes_only_tree_order_and_preserves_index_and_html_bytes() {
    let fixture = Fixture::new();
    let status = fixture.status();
    let database = fs::read(fixture.database()).unwrap();
    let settings = fs::read(&fixture.settings).unwrap();
    let originals: Vec<_> = ["a.html", "b.html", "c.html", "Folder/nested.html"]
        .iter()
        .map(|path| (path, fs::read(fixture.root.join(path)).unwrap()))
        .collect();
    let before = fixture
        .search("共通本文")
        .hits
        .into_iter()
        .map(|hit| hit.relative_path)
        .collect::<Vec<_>>();
    let result = fixture.perform(Mutation::Reorder {
        source: "c.html".into(),
        anchor: "a.html".into(),
        after: false,
    });
    let positions = result
        .snapshot
        .nodes
        .iter()
        .map(|node| node.relative_path.as_str())
        .collect::<Vec<_>>();
    assert!(
        positions.iter().position(|path| *path == "c.html").unwrap()
            < positions.iter().position(|path| *path == "a.html").unwrap()
    );
    let after_status = fixture.status();
    assert_eq!(after_status.request_revision, status.request_revision);
    assert_eq!(after_status.generation, status.generation);
    assert_eq!(after_status.phase, "ready");
    let after = fixture
        .search("共通本文")
        .hits
        .into_iter()
        .map(|hit| hit.relative_path)
        .collect::<Vec<_>>();
    assert_eq!(after, before);
    assert_eq!(fs::read(fixture.database()).unwrap(), database);
    assert_eq!(fs::read(&fixture.settings).unwrap(), settings);
    for (path, bytes) in originals {
        assert_eq!(fs::read(fixture.root.join(path)).unwrap(), bytes);
    }
}

#[test]
fn external_save_and_delete_are_not_hidden_by_native_echo_suppression() {
    let fixture = Fixture::new();
    let created = fixture
        .perform(Mutation::CreateHtml {
            parent: String::new(),
            name: "EchoCoverage".into(),
        })
        .created_path
        .unwrap();
    fixture.wait();
    let initial = fixture.search("EchoCoverage").hits.remove(0);
    let (tab, token) = fixture.grant(&created, false);
    let previous = fixture.status();
    fs::write(
        fixture.root.join(&created),
        "<title>外部更新題名</title><p>外部保存済み 新しい内容</p>",
    )
    .unwrap();
    fixture
        .core
        .apply_change(fixture.workspace(), vec![created.clone()], false, None);
    assert!(fixture.status().request_revision > previous.request_revision);
    assert!(fixture.wait().complete);
    // The file name still matches this literal query; its cached title must change.
    assert_eq!(fixture.search("EchoCoverage").hits[0].title, "外部更新題名");
    let changed = fixture.search("外部保存済み").hits.remove(0);
    assert_eq!(changed.relative_path, created);
    assert_eq!(changed.document_id, initial.document_id);
    assert_ne!(changed.indexed_source_hash, initial.indexed_source_hash);
    assert!(fixture.status().generation > previous.generation);
    let previous = fixture.status();
    fs::remove_file(fixture.root.join(&created)).unwrap();
    fixture
        .core
        .apply_change(fixture.workspace(), vec![created], true, None);
    assert!(fixture.status().request_revision > previous.request_revision);
    assert!(fixture.core.session_for_token(&token).is_none());
    assert!(fixture.core.workspace.lock().unwrap().tabs[&tab]
        .session
        .is_none());
    assert!(fixture.wait().complete);
    assert!(fixture.status().generation > previous.generation);
    assert!(fixture.search("外部保存済み").hits.is_empty());
    assert!(fixture
        .index
        .read_document(fixture.workspace(), &initial.document_id, 100)
        .is_err());
    assert_eq!(fixture.status().indexed, 4);
}

#[test]
fn real_watcher_reindexes_same_size_same_mtime_edit_inside_native_echo_window() {
    use std::io::{Seek, SeekFrom, Write};

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("documents");
    let cache = temporary.path().join("cache");
    let settings = temporary.path().join("config/settings.json");
    fs::create_dir(&root).unwrap();
    let core = Core::new(19071);
    core.settings_path.set(settings).unwrap();
    let index = IndexService::new(cache).unwrap();
    assert!(core.index.set(index.clone()).is_ok());
    let snapshot = core.select(&root, false).unwrap();
    assert!(
        core.watcher.lock().unwrap().is_some(),
        "real OS watcher must remain active"
    );
    let workspace = snapshot.workspace_id.as_deref().unwrap();
    let started = Instant::now();
    let result = tree_mutations::perform(
        &core,
        workspace,
        &snapshot.view_id,
        Mutation::CreateHtml {
            parent: String::new(),
            name: "EchoOld".into(),
        },
    )
    .unwrap();
    let native_revision = result.snapshot.revision;
    let relative = result.created_path.unwrap();
    // Block watcher publication until the native cache is ready and the external
    // write is complete. The index worker has no dependency on Core's gate.
    let gate = core.gate.lock().unwrap();
    let ready_deadline = Instant::now() + Duration::from_secs(1);
    loop {
        let status = index.status(workspace).unwrap();
        if status.phase == "ready" && status.indexed == 1 {
            assert!(status.complete);
            break;
        }
        assert_ne!(status.phase, "failed");
        assert!(
            Instant::now() < ready_deadline,
            "native cache did not finish inside the echo window"
        );
        thread::sleep(Duration::from_millis(5));
    }
    let old = super::api::search(&core, workspace, "EchoOld", 10, 0).unwrap();
    assert_eq!(old.hits.len(), 1);
    assert_eq!(old.hits[0].title, "EchoOld");
    let path = root.join(&relative);
    let original = fs::read(&path).unwrap();
    let replacement = std::str::from_utf8(&original)
        .unwrap()
        .replace("<title>EchoOld</title>", "<title>EchoNew</title>")
        .into_bytes();
    assert_ne!(replacement, original);
    assert_eq!(replacement.len(), original.len());
    let metadata = fs::metadata(&path).unwrap();
    let modified = metadata.modified().unwrap();
    let mut file = fs::OpenOptions::new().write(true).open(&path).unwrap();
    let identity = crate::write_fs::identity(&file).unwrap();
    file.seek(SeekFrom::Start(0)).unwrap();
    file.write_all(&replacement).unwrap();
    file.sync_all().unwrap();
    file.set_times(fs::FileTimes::new().set_modified(modified))
        .unwrap();
    drop(file);
    let after = fs::metadata(&path).unwrap();
    assert_eq!(after.len(), metadata.len());
    assert_eq!(after.modified().unwrap(), modified);
    assert_eq!(
        crate::write_fs::identity(&fs::File::open(&path).unwrap()).unwrap(),
        identity
    );
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "external edit must happen before the native echo expires"
    );
    drop(gate);

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let revision = core.snapshot().revision;
        let status = index.status(workspace).unwrap();
        if revision > native_revision && status.phase == "ready" && status.complete {
            if let Ok(page) = super::api::search(&core, workspace, "EchoNew", 10, 0) {
                if page.hits.len() == 1 && page.hits[0].title == "EchoNew" {
                    let old_path_match =
                        super::api::search(&core, workspace, "EchoOld", 10, 0).unwrap();
                    // EchoOld still occurs in the file name; its indexed title is new.
                    assert_eq!(old_path_match.hits.len(), 1);
                    assert_eq!(old_path_match.hits[0].title, "EchoNew");
                    assert_ne!(
                        page.hits[0].indexed_source_hash,
                        old.hits[0].indexed_source_hash
                    );
                    assert_eq!(fs::read(&path).unwrap(), replacement);
                    break;
                }
            }
        }
        assert!(Instant::now() < deadline,
            "real watcher lost the same-size, same-mtime external edit inside the native echo window");
        thread::sleep(Duration::from_millis(10));
    }
}
