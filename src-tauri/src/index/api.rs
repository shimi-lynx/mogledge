//! Narrow native adapter shared by commands and backend integration tests.
use super::{IndexStatus, SearchMode, SearchPage};
use crate::{core::Core, knowledge};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchScope {
    pub relative_path: String,
    pub view_id: String,
}

pub(super) fn verify_root(root: &std::path::Path, dir: &cap_std::fs::Dir) -> Result<(), String> {
    let (current, handle) = knowledge::open_root(root)?;
    if current != root || !knowledge::same_directory(dir, &handle)? {
        return Err("検索元フォルダが置き換えられました。選択し直してください".into());
    }
    Ok(())
}

fn ensure_workspace(core: &Core, workspace_id: &str) -> Result<(), String> {
    if core
        .workspace
        .lock()
        .unwrap()
        .snapshot
        .workspace_id
        .as_deref()
        != Some(workspace_id)
    {
        return Err("WorkspaceChanged".into());
    }
    Ok(())
}
pub fn status(core: &Core, workspace_id: &str) -> Result<IndexStatus, String> {
    ensure_workspace(core, workspace_id)?;
    core.index
        .get()
        .ok_or("検索索引を初期化できませんでした")?
        .status(workspace_id)
}
pub fn search(
    core: &Core,
    workspace_id: &str,
    query: &str,
    limit: u32,
    offset: u32,
) -> Result<SearchPage, String> {
    search_with_mode(core, workspace_id, query, limit, offset, SearchMode::And)
}
pub fn search_with_mode(
    core: &Core,
    workspace_id: &str,
    query: &str,
    limit: u32,
    offset: u32,
    mode: SearchMode,
) -> Result<SearchPage, String> {
    search_with_scope(core, workspace_id, query, limit, offset, mode, None)
}

pub fn search_with_scope(
    core: &Core,
    workspace_id: &str,
    query: &str,
    limit: u32,
    offset: u32,
    mode: SearchMode,
    scope: Option<&SearchScope>,
) -> Result<SearchPage, String> {
    let (root, dir, revision) = {
        let state = core.workspace.lock().unwrap();
        if state.snapshot.workspace_id.as_deref() != Some(workspace_id) {
            return Err("WorkspaceChanged".into());
        }
        if let Some(scope) = scope {
            if scope.view_id != state.snapshot.view_id {
                return Err("ViewChanged".into());
            }
            knowledge::validate_relative(&scope.relative_path)?;
            crate::tree_order::children(&state.snapshot.nodes, &scope.relative_path)
                .ok_or("検索範囲のフォルダーが移動・削除されました")?;
        }
        (
            state.root.clone().ok_or("WorkspaceChanged")?,
            state.dir.clone().ok_or("WorkspaceChanged")?,
            state.snapshot.revision,
        )
    };
    verify_root(&root, &dir)?;
    let scope_guard = scope
        .map(|scope| knowledge::ReadOnlyDirectoryGuard::open(&root, &dir, &scope.relative_path))
        .transpose()?;
    if let Some(guard) = &scope_guard {
        guard.revalidate(&root, &dir)?;
    }
    let page = core
        .index
        .get()
        .ok_or("検索索引を初期化できませんでした")?
        .search_with_scope(
            workspace_id,
            query,
            limit,
            offset,
            mode,
            scope.map(|scope| scope.relative_path.as_str()),
        )?;
    for hit in &page.hits {
        knowledge::validate_cached_path(&root, &dir, &hit.relative_path)?;
    }
    verify_root(&root, &dir)?;
    if let Some(guard) = &scope_guard {
        guard.revalidate(&root, &dir)?;
    }
    let state = core.workspace.lock().unwrap();
    if state.snapshot.workspace_id.as_deref() != Some(workspace_id) {
        return Err("WorkspaceChanged".into());
    }
    if state.snapshot.revision != revision {
        return Err("SearchResultsChanged".into());
    }
    if scope.is_some_and(|scope| scope.view_id != state.snapshot.view_id) {
        return Err("ViewChanged".into());
    }
    if page
        .hits
        .iter()
        .any(|hit| !knowledge::contains(&state.snapshot.nodes, &hit.relative_path))
    {
        return Err("検索結果が移動・削除されました。再走査してください".into());
    }
    Ok(page)
}
pub fn rebuild(core: &Core, workspace_id: &str) -> Result<IndexStatus, String> {
    ensure_workspace(core, workspace_id)?;
    let (root, dir) = {
        let state = core.workspace.lock().unwrap();
        (
            state.root.clone().ok_or("WorkspaceChanged")?,
            state.dir.clone().ok_or("WorkspaceChanged")?,
        )
    };
    verify_root(&root, &dir)?;
    // Rescan through the existing tree/watch integration so missed creations and
    // moves join the rebuild. Existing valid tab grants remain in place.
    core.apply_rescan(workspace_id, vec![], None);
    ensure_workspace(core, workspace_id)?;
    let status = core
        .index
        .get()
        .ok_or("検索索引を初期化できませんでした")?
        .rebuild(workspace_id)?;
    ensure_workspace(core, workspace_id)?;
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::IndexService;
    use std::{
        fs,
        sync::Arc,
        thread,
        time::{Duration, Instant},
    };

    struct Fixture {
        docs: tempfile::TempDir,
        _cache: tempfile::TempDir,
        core: Arc<Core>,
        id: String,
    }
    fn fixture() -> Fixture {
        let docs = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        fs::write(docs.path().join("a.html"), "<title>日本語資料</title><p>東京 ＡＢＣ &lt;img onerror=alert(1)&gt;</p><script>secret-script</script>").unwrap();
        let core = Core::new(1);
        assert!(core
            .index
            .set(IndexService::new(cache.path().to_path_buf()).unwrap())
            .is_ok());
        let snapshot = core.select(docs.path(), false).unwrap();
        core.watcher.lock().unwrap().take();
        let f = Fixture {
            docs,
            _cache: cache,
            core,
            id: snapshot.workspace_id.unwrap(),
        };
        wait(&f);
        f
    }
    fn wait(f: &Fixture) -> IndexStatus {
        let start = Instant::now();
        loop {
            let value = status(&f.core, &f.id).unwrap();
            if value.phase == "ready" {
                return value;
            }
            assert_ne!(value.phase, "failed", "{value:?}");
            assert!(start.elapsed() < Duration::from_secs(10), "{value:?}");
            thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn japanese_search_uses_existing_tab_grant_and_rebuild_preserves_it() {
        let f = fixture();
        let original = fs::read(f.docs.path().join("a.html")).unwrap();
        let page = search(&f.core, &f.id, "東京 abc", 20, 0).unwrap();
        assert_eq!(page.hits.len(), 1);
        assert!(page.hits[0].snippet.contains("<img onerror=alert(1)>"));
        let or_page =
            search_with_mode(&f.core, &f.id, "東京 absent", 20, 0, SearchMode::Or).unwrap();
        assert_eq!(or_page.hits.len(), 1);
        assert_eq!(or_page.hits[0].snippet_matches.len(), 1);
        assert!(search(&f.core, &f.id, "secret-script", 20, 0)
            .unwrap()
            .hits
            .is_empty());
        let snapshot = f.core.snapshot();
        let tab = f
            .core
            .create_tab(&f.id, &snapshot.view_id, &page.hits[0].relative_path)
            .unwrap();
        let url = f.core.open(&f.id, &snapshot.view_id, &tab, 1).unwrap();
        let token = f.core.workspace.lock().unwrap().tabs[&tab]
            .session
            .as_ref()
            .unwrap()
            .token
            .clone();
        // Simulate a missed creation; manual rebuild includes a fresh tree scan.
        fs::write(f.docs.path().join("new.html"), "<p>東京</p>").unwrap();
        let before = status(&f.core, &f.id).unwrap();
        let requested = rebuild(&f.core, &f.id).unwrap();
        assert!(requested.request_revision > before.request_revision);
        let ready = wait(&f);
        assert!(ready.complete && ready.generation > before.generation);
        assert_eq!(search(&f.core, &f.id, "東京", 20, 0).unwrap().hits.len(), 2);
        assert_eq!(f.core.snapshot().view_id, snapshot.view_id);
        assert!(f.core.session_for_token(&token).is_some());
        assert!(url.contains(&token));
        assert_eq!(fs::read(f.docs.path().join("a.html")).unwrap(), original);
    }
    #[test]
    fn deleted_result_and_old_workspace_are_rejected() {
        let f = fixture();
        fs::remove_file(f.docs.path().join("a.html")).unwrap();
        assert!(search(&f.core, &f.id, "東京", 20, 0).is_err());
        assert!(search_with_mode(&f.core, &f.id, "東京 absent", 20, 0, SearchMode::Or).is_err());
        assert!(search(&f.core, "obsolete", "東京", 20, 0).is_err());
        assert!(
            search_with_mode(&f.core, "obsolete", "東京 absent", 20, 0, SearchMode::Or).is_err()
        );
        assert!(rebuild(&f.core, "obsolete").is_err());
    }
    #[test]
    fn empty_query_and_native_bounds_are_explicit() {
        let f = fixture();
        assert!(search(&f.core, &f.id, " ", 20, 0).unwrap().hits.is_empty());
        for (query, limit, offset) in [("東京", 0, 0), ("東京", 101, 0), ("東京", 20, 10001)]
        {
            assert!(search(&f.core, &f.id, query, limit, offset).is_err());
        }
        assert!(search(&f.core, &f.id, &"東".repeat(257), 20, 0).is_err());
    }

    #[test]
    fn folder_scope_checks_tree_current_view_and_directory_identity_even_without_hits() {
        let f = fixture();
        fs::create_dir_all(f.docs.path().join("foo/deep")).unwrap();
        fs::create_dir(f.docs.path().join("foobar")).unwrap();
        fs::create_dir(f.docs.path().join("empty")).unwrap();
        fs::write(f.docs.path().join("foo/deep/page.html"), "<p>東京</p>").unwrap();
        fs::write(f.docs.path().join("foobar/page.html"), "<p>東京</p>").unwrap();
        rebuild(&f.core, &f.id).unwrap();
        wait(&f);
        let mut scope = SearchScope {
            relative_path: "foo".into(),
            view_id: f.core.snapshot().view_id,
        };
        let scoped = |scope: &SearchScope, query| {
            search_with_scope(&f.core, &f.id, query, 20, 0, SearchMode::And, Some(scope))
        };
        let page = scoped(&scope, "東京").unwrap();
        assert_eq!(page.hits.len(), 1);
        assert_eq!(page.hits[0].relative_path, "foo/deep/page.html");
        assert_eq!(search(&f.core, &f.id, "東京", 20, 0).unwrap().hits.len(), 3);
        scope.view_id = "obsolete".into();
        assert!(scoped(&scope, "").is_err());
        scope.view_id = f.core.snapshot().view_id;
        for path in ["", "../foo", "/foo", "a.html", "missing", "foo/../foobar"] {
            scope.relative_path = path.into();
            assert!(scoped(&scope, "").is_err(), "{path}");
        }
        scope.relative_path = "empty".into();
        assert!(scoped(&scope, "東京").unwrap().hits.is_empty());
        fs::remove_dir(f.docs.path().join("empty")).unwrap();
        assert!(scoped(&scope, "").is_err());
        scope.relative_path = "foo".into();
        assert!(search_with_scope(
            &f.core,
            "obsolete",
            "",
            20,
            0,
            SearchMode::And,
            Some(&scope)
        )
        .is_err());
        assert!(serde_json::from_str::<SearchScope>(
            r#"{"relativePath":"foo","viewId":"view","unknown":true}"#
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn folder_scope_accepts_unix_read_names_without_write_name_restrictions() {
        let f = fixture();
        let folders = ["Q?", "trailing ", "trailing.", "CON", "aux.txt", "Q?/NUL."];
        for folder in folders {
            fs::create_dir_all(f.docs.path().join(folder)).unwrap();
            fs::write(f.docs.path().join(folder).join("page.html"), "<p>東京</p>").unwrap();
        }
        rebuild(&f.core, &f.id).unwrap();
        wait(&f);
        assert_eq!(
            search(&f.core, &f.id, "東京", 20, 0).unwrap().hits.len(),
            folders.len() + 1
        );
        for folder in folders {
            let scope = SearchScope {
                relative_path: folder.into(),
                view_id: f.core.snapshot().view_id,
            };
            let page =
                search_with_scope(&f.core, &f.id, "東京", 20, 0, SearchMode::And, Some(&scope))
                    .unwrap();
            assert!(page
                .hits
                .iter()
                .any(|hit| hit.relative_path == format!("{folder}/page.html")));
            assert!(page
                .hits
                .iter()
                .all(|hit| hit.relative_path.starts_with(&format!("{folder}/"))));
            assert!(search_with_scope(
                &f.core,
                &f.id,
                "no-match",
                20,
                0,
                SearchMode::And,
                Some(&scope),
            )
            .unwrap()
            .hits
            .is_empty());
        }
    }

    #[cfg(unix)]
    #[test]
    fn folder_scope_rejects_link_replacement_of_a_cached_empty_folder() {
        let f = fixture();
        let external = tempfile::tempdir().unwrap();
        fs::create_dir(f.docs.path().join("folder")).unwrap();
        f.core.apply_rescan(&f.id, vec![], None);
        let scope = SearchScope {
            relative_path: "folder".into(),
            view_id: f.core.snapshot().view_id,
        };
        fs::remove_dir(f.docs.path().join("folder")).unwrap();
        std::os::unix::fs::symlink(external.path(), f.docs.path().join("folder")).unwrap();
        assert!(search_with_scope(
            &f.core,
            &f.id,
            "no-match",
            20,
            0,
            SearchMode::And,
            Some(&scope)
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn linked_hit_and_replaced_root_are_rejected_even_for_empty_results() {
        let f = fixture();
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("outside.html"), "outside secret").unwrap();
        fs::remove_file(f.docs.path().join("a.html")).unwrap();
        std::os::unix::fs::symlink(
            external.path().join("outside.html"),
            f.docs.path().join("a.html"),
        )
        .unwrap();
        assert!(search(&f.core, &f.id, "東京", 20, 0).is_err());
        let moved = f.docs.path().with_extension("original");
        fs::rename(f.docs.path(), &moved).unwrap();
        fs::create_dir(f.docs.path()).unwrap();
        assert!(search(&f.core, &f.id, "no-match", 20, 0).is_err());
        assert!(rebuild(&f.core, &f.id).is_err());
        fs::remove_dir_all(moved).unwrap();
    }
}
